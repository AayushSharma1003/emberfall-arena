/**
 * Bot AI behavior, proven on the real sim: recovery from offstage, closing
 * distance and landing hits, archetype spacing (zoners keep away), special
 * and ultimate usage, hazard respect, and full-match determinism.
 */
import { describe, expect, it } from "vitest";
import { BotController, botLevel } from "./bot.js";
import { Sim, ULT_TUNING, emberfallKeep } from "./sim.js";
import { moltenSpan } from "./stages.js";
import { serializeSim } from "./snapshot.js";
import { N, place } from "./testutil.js";
import type { CharId } from "./characters.js";

function botMatch(a: CharId, b: CharId, seed = 5): { sim: Sim; bots: BotController[] } {
  const sim = new Sim(emberfallKeep());
  sim.itemsEnabled = false;
  sim.addFighter(a, 0);
  sim.addFighter(b, 1);
  const bots = [
    new BotController(sim, 0, botLevel(3), seed),
    new BotController(sim, 1, botLevel(3), seed + 1),
  ];
  return { sim, bots };
}

function run(sim: Sim, bots: BotController[], ticks: number): void {
  for (let t = 0; t < ticks; t++) sim.step(bots.map((b) => b.tick()));
}

describe("recovery", () => {
  it("an offstage bot makes it back to the stage", () => {
    const { sim, bots } = botMatch("knight", "ogre");
    const me = sim.fighters[0];
    place(me, 60, 700); // far off the left edge (stage starts at 460), high up
    me.jumpsUsed = 1;
    place(sim.fighters[1], 1100, 700);
    let recovered = false;
    for (let t = 0; t < 600 && !recovered; t++) {
      sim.step([bots[0].tick(), N]);
      recovered = me.grounded && me.x > 460 && me.x < 1460;
    }
    expect(recovered).toBe(true);
    expect(me.stocks).toBe(3); // without dying
  });

  it("even a floaty character recovers (mage, low gravity)", () => {
    const { sim, bots } = botMatch("mage", "ogre");
    const me = sim.fighters[0];
    place(me, 1900, 650);
    place(sim.fighters[1], 800, 700);
    let recovered = false;
    for (let t = 0; t < 700 && !recovered; t++) {
      sim.step([bots[0].tick(), N]);
      recovered = me.grounded && me.x > 460 && me.x < 1460;
    }
    expect(recovered).toBe(true);
  });
});

describe("offense", () => {
  it("closes distance and lands hits on a passive dummy", () => {
    const { sim, bots } = botMatch("goblin", "ogre");
    place(sim.fighters[0], 600, 700);
    place(sim.fighters[1], 1300, 700);
    for (let t = 0; t < 900 && sim.fighters[1].damage === 0; t++) {
      sim.step([bots[0].tick(), N]);
    }
    expect(sim.fighters[1].damage).toBeGreaterThan(0);
  });

  it("fires projectiles at range", () => {
    const { sim, bots } = botMatch("ranger", "ogre");
    place(sim.fighters[0], 600, 700);
    place(sim.fighters[1], 1300, 700);
    let shot = false;
    for (let t = 0; t < 600 && !shot; t++) {
      const events = sim.step([bots[0].tick(), N]);
      shot = events.some((e) => e.t === "shoot");
    }
    expect(shot).toBe(true);
  });

  it("a chargeable special is held and released (mage actually shoots)", () => {
    const { sim, bots } = botMatch("mage", "ogre");
    place(sim.fighters[0], 600, 700);
    place(sim.fighters[1], 1300, 700);
    let shot = false;
    let charged = false;
    for (let t = 0; t < 900 && !shot; t++) {
      const events = sim.step([bots[0].tick(), N]);
      charged ||= events.some((e) => e.t === "charge");
      shot = events.some((e) => e.t === "release");
    }
    expect(charged).toBe(true);
    expect(shot).toBe(true);
  });

  it("spends a full meter on the ultimate", () => {
    const { sim, bots } = botMatch("ogre", "knight");
    place(sim.fighters[0], 800, 700);
    place(sim.fighters[1], 1000, 700);
    sim.fighters[0].ult = ULT_TUNING.max;
    let ulted = false;
    for (let t = 0; t < 600 && !ulted; t++) {
      const events = sim.step([bots[0].tick(), N]);
      ulted = events.some((e) => e.t === "ult" && e.id === 0);
    }
    expect(ulted).toBe(true);
  });
});

describe("spacing personality", () => {
  it("zoners stand off; rushdown gets in your face", () => {
    const avgDist = (id: CharId): number => {
      const { sim, bots } = botMatch(id, "knight");
      place(sim.fighters[0], 700, 700);
      place(sim.fighters[1], 1200, 700);
      let sum = 0;
      let n = 0;
      for (let t = 0; t < 500; t++) {
        sim.step([bots[0].tick(), N]);
        if (t > 120 && sim.fighters[0].grounded) {
          sum += Math.abs(sim.fighters[0].x - sim.fighters[1].x);
          n++;
        }
      }
      return sum / Math.max(1, n);
    };
    const zoner = avgDist("ranger");
    const rusher = avgDist("goblin");
    expect(zoner).toBeGreaterThan(rusher + 100);
  });
});

describe("hazard respect", () => {
  it("a wise bot never eats the geyser, even fighting at the gap's edge", () => {
    const sim = new Sim(moltenSpan());
    sim.itemsEnabled = false;
    sim.addFighter("knight", 0);
    sim.addFighter("ogre", 1);
    const bot = new BotController(sim, 0, botLevel(3), 11);
    // bot starts ON the bridge inside the geyser zone; its passive target
    // stands just past the gap, so the bot parks at the zone's edge and has
    // to respect the telegraph every cycle (2+ eruptions in this window)
    place(sim.fighters[0], 960, 580);
    place(sim.fighters[1], 1150, 720);
    let hitByGeyser = false;
    for (let t = 0; t < 1300; t++) {
      const events = sim.step([bot.tick(), N]);
      hitByGeyser ||= events.some((e) => e.t === "hit" && e.attacker === -1 && e.victim === 0);
    }
    expect(hitByGeyser).toBe(false);
  });
});

describe("full-match integrity", () => {
  it("a 4-bot 2v2 runs to completion, stays finite, and is deterministic", () => {
    const play = (): string => {
      const sim = new Sim(emberfallKeep());
      const chars: CharId[] = ["knight", "sable", "hessa", "pyre"];
      chars.forEach((c, i) => sim.addFighter(c, i % 2));
      const bots = chars.map((_, i) => new BotController(sim, i, botLevel(2), 42 + i));
      for (let t = 0; t < 3600; t++) {
        sim.step(bots.map((b) => b.tick()));
        const aliveTeams = new Set(sim.fighters.filter((f) => f.stocks > 0).map((f) => f.team));
        if (aliveTeams.size <= 1) break;
      }
      for (const f of sim.fighters) {
        expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
      }
      return JSON.stringify(serializeSim(sim));
    };
    expect(play()).toBe(play());
  });

  it("bots actually fight: a 1v1 produces meaningful damage inside 30s", () => {
    const { sim, bots } = botMatch("knight", "demon_queen", 9);
    run(sim, bots, 1800);
    const total = sim.fighters[0].damage + sim.fighters[1].damage +
      (3 - sim.fighters[0].stocks + (3 - sim.fighters[1].stocks)) * 100;
    expect(total).toBeGreaterThan(40);
  });
});
