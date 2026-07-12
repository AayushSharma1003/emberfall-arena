/**
 * Stage data sanity for all four arenas: spawns land on real ground, every
 * map has a dynamic element, hazard schedules are coherent, alternating
 * phasing never strands players with no platform, and the blast-zone SHAPES
 * genuinely differ (that's a balance feature, not an accident).
 */
import { describe, expect, it } from "vitest";
import {
  Sim, hazardStateAt, platformSolid,
  type Stage,
} from "./sim.js";
import { STAGE_IDS, STAGE_INFO, stageById } from "./stages.js";
import { Btn, N, frame } from "./testutil.js";

const ALL = Object.values(STAGE_INFO);

describe("registry", () => {
  it("ships exactly four themed arenas", () => {
    expect(STAGE_IDS).toEqual(["emberfall_keep", "molten_span", "stormshard", "ashwood"]);
    const themes = ALL.map((s) => s.theme);
    expect(new Set(themes).size).toBe(4);
  });

  it("unknown ids fall back to the keep", () => {
    expect(stageById("volcano_lair").id).toBe("emberfall_keep");
    expect(stageById(null).id).toBe("emberfall_keep");
    expect(stageById("ashwood").id).toBe("ashwood");
  });

  it("every stage reserves music + ambience hooks and has flavor text", () => {
    for (const s of ALL) {
      expect(s.musicTrack.length).toBeGreaterThan(4);
      expect(s.ambienceTrack.length).toBeGreaterThan(4);
      expect(s.name.length).toBeGreaterThan(3);
      expect(s.tagline.length).toBeGreaterThan(20);
    }
  });
});

describe("geometry", () => {
  for (const info of ALL) {
    const stage = info.make();
    it(`${info.id}: 4 spawns, all landing on solid ground`, () => {
      expect(stage.spawns.length).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < 4; i++) {
        const sim = new Sim(info.make());
        sim.itemsEnabled = false;
        const f = sim.addFighter();
        sim.addFighter(); // 2-fighter minimum
        const s = stage.spawns[i];
        f.x = s.x; f.y = s.y; f.vx = 0; f.vy = 0;
        sim.fighters[1].x = stage.spawns[(i + 1) % 4].x;
        sim.fighters[1].y = stage.spawns[(i + 1) % 4].y;
        let landed = false;
        for (let t = 0; t < 150 && !landed; t++) {
          sim.step([N, N]);
          landed = f.grounded;
        }
        expect(landed, `spawn ${i} of ${info.id}`).toBe(true);
        expect(f.state).not.toBe("dead");
      }
    });

    it(`${info.id}: platforms and item spawns sit inside the blast zone`, () => {
      const b = stage.blast;
      expect(b.left).toBeLessThan(b.right);
      expect(b.top).toBeLessThan(b.bottom);
      for (const p of stage.platforms) {
        expect(p.x).toBeGreaterThan(b.left);
        expect(p.x + p.w).toBeLessThan(b.right);
        expect(p.y).toBeGreaterThan(b.top);
        expect(p.y).toBeLessThan(b.bottom);
      }
      for (const it2 of stage.itemSpawns) {
        expect(it2.x).toBeGreaterThan(b.left);
        expect(it2.x).toBeLessThan(b.right);
      }
    });

    it(`${info.id}: has at least one dynamic element (motion, phasing, or hazard)`, () => {
      const dynamic =
        stage.platforms.some((p) => p.motion || p.phasing) ||
        (stage.hazards?.length ?? 0) > 0;
      expect(dynamic).toBe(true);
    });
  }
});

describe("hazard schedules", () => {
  for (const info of ALL) {
    const stage = info.make();
    for (const h of stage.hazards ?? []) {
      it(`${info.id}/${h.id}: coherent timing and real consequences`, () => {
        expect(h.telegraphTicks + h.activeTicks).toBeLessThan(h.periodTicks);
        expect(h.telegraphTicks).toBeGreaterThanOrEqual(30); // readable warning (0.5s+)
        expect(h.damage).toBeGreaterThan(0);
        expect(h.baseKnockback).toBeGreaterThan(400); // hazards must THREATEN
        // it actually cycles: idle, telegraph and active all occur
        const seen = new Set<string>();
        for (let t = 0; t < h.periodTicks; t++) seen.add(hazardStateAt(h, t));
        expect(seen).toEqual(new Set(["idle", "telegraph", "active"]));
      });
    }
  }

  it("stormshard's two lightning strikes never fire simultaneously", () => {
    const stage = STAGE_INFO.stormshard.make();
    const [west, east] = stage.hazards!;
    for (let t = 0; t < 960; t++) {
      const both = hazardStateAt(west, t) === "active" && hazardStateAt(east, t) === "active";
      expect(both, `tick ${t}`).toBe(false);
    }
  });
});

describe("alternating phasing", () => {
  const neverBothGone = (stage: Stage, ai: number, bi: number, over: number): void => {
    for (let t = 0; t < over; t++) {
      const anySolid = platformSolid(stage.platforms[ai], t) || platformSolid(stage.platforms[bi], t);
      expect(anySolid, `tick ${t}`).toBe(true);
    }
  };

  it("the keep's crumbling ledges alternate — one perch always exists", () => {
    const stage = STAGE_INFO.emberfall_keep.make();
    neverBothGone(stage, 3, 4, 1440);
  });

  it("the ashwood roots alternate — one root always up", () => {
    const stage = STAGE_INFO.ashwood.make();
    neverBothGone(stage, 2, 3, 960);
  });
});

describe("blast-zone shapes are a real balance lever", () => {
  const dims = Object.fromEntries(
    ALL.map((s) => {
      const b = s.make().blast;
      return [s.id, { w: b.right - b.left, h: b.bottom - b.top }];
    }),
  );

  it("stormshard is the tallest and narrowest (vertical KOs)", () => {
    for (const id of STAGE_IDS) {
      if (id === "stormshard") continue;
      expect(dims.stormshard.w).toBeLessThan(dims[id].w);
      expect(dims.stormshard.h).toBeGreaterThan(dims[id].h);
    }
  });

  it("the ashwood is the widest (edge-guard country)", () => {
    for (const id of STAGE_IDS) {
      if (id === "ashwood") continue;
      expect(dims.ashwood.w).toBeGreaterThan(dims[id].w);
    }
  });
});

describe("every arena survives chaos", () => {
  for (const info of ALL) {
    it(`${info.id}: 400 ticks of 4-fighter mayhem stays finite and deterministic`, () => {
      const run = (): string => {
        const sim = new Sim(info.make());
        const chars = ["ogre", "sable", "hessa", "pyre"] as const;
        chars.forEach((c, i) => sim.addFighter(c, i % 2));
        for (const f of sim.fighters) f.ult = 100;
        const script = [
          frame(Btn.Right | Btn.Light, 1, 0), frame(Btn.Jump), frame(Btn.Ultimate, 0.7, -0.7),
          frame(Btn.Dash | Btn.Left), frame(Btn.Shoot, -1, 0), frame(Btn.Down | Btn.Jump),
          frame(Btn.Heavy, 0, 1), frame(0),
        ];
        for (let t = 0; t < 400; t++) {
          sim.step(sim.fighters.map((_, i) => script[(t + i * 3) % script.length]));
        }
        for (const f of sim.fighters) {
          expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
        }
        return JSON.stringify(sim.fighters.map((f) => [f.x, f.y, f.damage, f.stocks]));
      };
      expect(run()).toBe(run());
    });
  }
});
