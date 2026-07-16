import { describe, expect, it } from "vitest";
import {
  FADE_IN_S, FADE_OUT_S, ScreenFlow, ScreenHost, rosterOf,
  type MatchConfig, type ScreenId, type ScreenView,
} from "./flow.js";

const CFG: MatchConfig = {
  mode: "duo",
  playerChar: "mage",
  allyChar: "knight",
  enemyChars: ["ogre", "ranger"],
  stageId: "molten_span",
  difficulty: 2,
  seed: 7,
};

describe("ScreenFlow", () => {
  it("enforces the legal transition table", () => {
    const f = new ScreenFlow();
    expect(() => f.go("results")).toThrow(/illegal/);
    expect(() => f.go("match")).toThrow(/illegal/);
    f.go("charselect");
    expect(() => f.go("results")).toThrow(/illegal/);
    f.go("mapselect");
    f.go("loading");
    expect(() => f.go("menu")).toThrow(/illegal/); // loading only exits into the match
    f.go("match");
    f.go("results");
    f.go("menu");
    expect(f.screen).toBe("menu");
  });

  it("startMatch carries the config into loading; rematch keeps teams+map but reseeds", () => {
    const f = new ScreenFlow();
    f.go("charselect");
    f.go("mapselect");
    f.startMatch(CFG);
    expect(f.screen).toBe("loading");
    expect(f.config).toEqual(CFG);
    f.go("match");
    f.finishMatch({ config: CFG, winnerTeam: 0, tallies: [], mvp: 0 });
    expect(f.screen).toBe("results");
    f.rematch();
    expect(f.screen).toBe("loading");
    expect(f.config).toMatchObject({ ...CFG, seed: CFG.seed + 1 });
  });

  it("rematch without a config throws", () => {
    expect(() => new ScreenFlow().rematch()).toThrow();
  });

  it("online path: menu → online → lobby → charselect-and-back → match → menu", () => {
    const f = new ScreenFlow();
    f.go("online");
    f.go("onlinelobby");
    f.go("charselect"); // change fighter from the lobby
    f.go("onlinelobby"); // lock in returns there
    f.go("onlinematch");
    f.go("menu");
    expect(f.screen).toBe("menu");
  });

  it("online dead-ends stay illegal: no match without a lobby, no offline shortcuts", () => {
    const f = new ScreenFlow();
    expect(() => f.go("onlinematch")).toThrow(/illegal/);
    expect(() => f.go("onlinelobby")).toThrow(/illegal/);
    f.go("online");
    expect(() => f.go("onlinematch")).toThrow(/illegal/); // must pass through the lobby
    expect(() => f.go("mapselect")).toThrow(/illegal/); // online never picks maps client-side
    f.go("onlinelobby");
    f.go("online"); // join error path bounces back to the online screen
    f.go("menu");
  });

  it("a deep link can boot the flow directly on the online screen", () => {
    const f = new ScreenFlow("online");
    f.onlineIntent = { code: "ABC234", host: false };
    expect(f.screen).toBe("online");
    f.go("menu"); // and it can still bail to the menu
    expect(f.screen).toBe("menu");
  });

  it("rosterOf: solo is 1v1, duo interleaves teams 0,1,0,1 with the human first", () => {
    expect(rosterOf({ ...CFG, mode: "solo" })).toEqual([
      { charId: "mage", team: 0, human: true },
      { charId: "ogre", team: 1, human: false },
    ]);
    expect(rosterOf(CFG).map((r) => r.team)).toEqual([0, 1, 0, 1]);
    expect(rosterOf(CFG).map((r) => r.human)).toEqual([true, false, false, false]);
    expect(rosterOf(CFG)[2].charId).toBe("knight");
  });
});

// ---------------------------------------------------------------------------
// host: mount/unmount ordering is the container-teardown contract — every
// screen destroys its root in unmount(), so "old unmounted exactly once,
// before new mounts, never two mounted" IS the no-leak guarantee.
// ---------------------------------------------------------------------------

interface Probe extends ScreenView {
  mounts: number;
  unmounts: number;
  updates: number;
}

function probeViews(log: string[]): Record<ScreenId, Probe> {
  const make = (id: ScreenId): Probe => ({
    mounts: 0,
    unmounts: 0,
    updates: 0,
    mount() { this.mounts++; log.push(`+${id}`); },
    unmount() { this.unmounts++; log.push(`-${id}`); },
    update() { this.updates++; },
  });
  return {
    menu: make("menu"), charselect: make("charselect"), mapselect: make("mapselect"),
    loading: make("loading"), match: make("match"), results: make("results"),
    online: make("online"), onlinelobby: make("onlinelobby"), onlinematch: make("onlinematch"),
  };
}

function drain(host: ScreenHost, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) host.update(dt);
}

describe("ScreenHost", () => {
  it("boots without a fade and updates only the mounted view", () => {
    const log: string[] = [];
    const views = probeViews(log);
    const flow = new ScreenFlow();
    const host = new ScreenHost(views, flow);
    host.boot();
    expect(log).toEqual(["+menu"]);
    drain(host, 0.1);
    expect(views.menu.updates).toBeGreaterThan(0);
    expect(views.charselect.updates).toBe(0);
  });

  it("swaps at full black: old unmounted exactly once, then new mounted, never two live", () => {
    const log: string[] = [];
    const views = probeViews(log);
    const flow = new ScreenFlow();
    const host = new ScreenHost(views, flow);
    host.boot();
    flow.go("charselect");
    expect(log).toEqual(["+menu"]); // nothing swaps until the fade completes
    drain(host, FADE_OUT_S + 0.05);
    expect(log).toEqual(["+menu", "-menu", "+charselect"]);
    expect(host.overlayAlpha).toBeLessThan(1);
    drain(host, FADE_IN_S + 0.05);
    expect(host.overlayAlpha).toBe(0);
    expect(views.menu.mounts).toBe(1);
    expect(views.menu.unmounts).toBe(1);
    expect(views.charselect.unmounts).toBe(0);
  });

  it("retargets mid-fade without double-mounting the intermediate screen", () => {
    const log: string[] = [];
    const views = probeViews(log);
    const flow = new ScreenFlow();
    const host = new ScreenHost(views, flow);
    host.boot();
    flow.go("charselect");
    drain(host, FADE_OUT_S / 2); // halfway out...
    flow.go("mapselect"); // ...user already skipped ahead
    drain(host, FADE_OUT_S + FADE_IN_S);
    expect(views.charselect.mounts + views.charselect.unmounts).toBe(0);
    expect(log).toEqual(["+menu", "-menu", "+mapselect"]);
  });

  it("overlay peaks at 1 exactly when the swap happens", () => {
    const log: string[] = [];
    const views = probeViews(log);
    const flow = new ScreenFlow();
    const host = new ScreenHost(views, flow);
    host.boot();
    flow.go("charselect");
    let alphaAtSwap = -1;
    for (let t = 0; t < 2; t += 1 / 60) {
      const before = log.length;
      host.update(1 / 60);
      if (log.length > before) alphaAtSwap = host.overlayAlpha;
      if (log.length > 1) break;
    }
    expect(alphaAtSwap).toBe(1);
  });

  it("a transition issued while faded-in mid-'in' fades back out from current alpha", () => {
    const log: string[] = [];
    const views = probeViews(log);
    const flow = new ScreenFlow();
    const host = new ScreenHost(views, flow);
    host.boot();
    flow.go("charselect");
    drain(host, FADE_OUT_S + 0.02); // swapped, now fading in
    flow.go("mapselect");
    drain(host, FADE_OUT_S + FADE_IN_S + 0.1);
    expect(log).toEqual(["+menu", "-menu", "+charselect", "-charselect", "+mapselect"]);
    expect(host.overlayAlpha).toBe(0);
  });
});
