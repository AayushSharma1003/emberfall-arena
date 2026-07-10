/**
 * Items (Phase F): deterministic tick-driven spawning, pickup effects
 * (heart heal, wings refresh+boost, bomb auto-throw), caps, snapshot
 * round-trip, and the second map's geometry.
 */
import { describe, expect, it } from "vitest";
import { Btn } from "./protocol/input.js";
import { Sim, ITEM_TUNING, ITEM_KINDS, emberfallKeep, TUNING } from "./sim.js";
import { moltenSpan, stageById, STAGES } from "./stages.js";
import { serializeSim, applySimSnap } from "./snapshot.js";
import { N, frame, place, steps, stepUntil } from "./testutil.js";

const INTERVAL = ITEM_TUNING.spawnIntervalTicks;

/** 2 fighters parked far from item spawn points. */
function quietSim(): Sim {
  const sim = new Sim(emberfallKeep());
  sim.addFighter("knight");
  sim.addFighter("knight");
  place(sim.fighters[0], 500, 700);
  place(sim.fighters[1], 1420, 700);
  steps(sim, 30);
  return sim;
}

describe("item spawning", () => {
  it("spawns deterministically on the tick rotation", () => {
    const sim = quietSim();
    const before = sim.tick;
    steps(sim, INTERVAL - (before % INTERVAL) - 1);
    expect(sim.items.length).toBe(0);
    steps(sim, 1); // the interval tick
    expect(sim.items.length).toBe(1);
    const n = sim.tick / INTERVAL;
    expect(sim.items[0].kind).toBe(ITEM_KINDS[n % ITEM_KINDS.length]);
    const at = sim.stage.itemSpawns[n % sim.stage.itemSpawns.length];
    expect(sim.items[0].x).toBe(at.x);
  });

  it("respects the active-item cap", () => {
    const sim = quietSim();
    steps(sim, INTERVAL * (ITEM_TUNING.maxActive + 3));
    expect(sim.items.length).toBeLessThanOrEqual(ITEM_TUNING.maxActive);
  });

  it("stages without item spawns never spawn items", () => {
    const stage = emberfallKeep();
    stage.itemSpawns = [];
    const sim = new Sim(stage);
    sim.addFighter("knight");
    sim.addFighter("knight");
    steps(sim, INTERVAL * 2 + 10);
    expect(sim.items.length).toBe(0);
  });

  it("itemsEnabled=false disables the system", () => {
    const sim = quietSim();
    sim.itemsEnabled = false;
    steps(sim, INTERVAL * 2 + 10);
    expect(sim.items.length).toBe(0);
  });
});

describe("item pickups", () => {
  function withItem(kind: "heart" | "wings" | "bomb"): Sim {
    const sim = quietSim();
    sim.items.push({ kind, x: 800, y: 730 });
    return sim;
  }

  it("heart heals damage on touch (use = pickup)", () => {
    const sim = withItem("heart");
    const f = sim.fighters[0];
    f.damage = 80;
    place(f, 700, 780);
    const got = stepUntil(sim, () => sim.items.length === 0, 120, [frame(Btn.Right)]);
    expect(got).toBeGreaterThan(0);
    expect(f.damage).toBe(80 - ITEM_TUNING.heartHeal);
  });

  it("heart never heals below 0%", () => {
    const sim = withItem("heart");
    const f = sim.fighters[0];
    f.damage = 10;
    place(f, 790, 780);
    stepUntil(sim, () => sim.items.length === 0, 30);
    expect(f.damage).toBe(0);
  });

  it("wings refresh jumps/air-dash and boost run speed", () => {
    const sim = withItem("wings");
    const f = sim.fighters[0];
    place(f, 790, 780);
    f.jumpsUsed = 2;
    f.airDashUsed = true;
    stepUntil(sim, () => sim.items.length === 0, 30);
    expect(f.jumpsUsed).toBe(0);
    expect(f.airDashUsed).toBe(false);
    expect(f.speedBoost).toBeGreaterThan(0);
    // boosted top speed exceeds the normal cap
    steps(sim, 40, [frame(Btn.Right)]);
    expect(Math.abs(f.vx)).toBeGreaterThan(TUNING.runSpeed * f.stats.speedMult * 1.1);
    // boost expires
    steps(sim, ITEM_TUNING.wingsBoostTicks + 10, [frame(Btn.Right)]);
    expect(Math.abs(f.vx)).toBeLessThanOrEqual(TUNING.runSpeed * f.stats.speedMult + 1);
  });

  it("bomb pickup auto-throws an arcing projectile owned by the picker", () => {
    const sim = withItem("bomb");
    const atk = sim.fighters[0];
    const vic = sim.fighters[1];
    place(atk, 790, 780);
    atk.facing = 1;
    place(vic, 1150, 780);
    const picked = stepUntil(sim, () => sim.items.length === 0, 30);
    expect(picked).toBeGreaterThan(0);
    expect(sim.projectiles.length).toBe(1);
    expect(sim.projectiles[0].owner).toBe(atk.id);
    expect(sim.projectiles[0].vy).toBeLessThan(0); // lobbed upward
    const hit = stepUntil(sim, () => vic.damage > 0, 120);
    expect(hit).toBeGreaterThan(0); // arcs onto the enemy standing down-range
  });

  it("dead fighters cannot pick up items", () => {
    const sim = withItem("heart");
    const f = sim.fighters[0];
    f.damage = 50;
    f.state = "dead";
    f.respawnTimer = 120;
    place(f, 800, 780);
    steps(sim, 20);
    expect(sim.items.length).toBe(1);
    expect(f.damage).toBe(50);
  });

  it("items and speedBoost survive snapshot round-trips (determinism)", () => {
    const sim = quietSim();
    sim.items.push({ kind: "wings", x: 800, y: 730 });
    place(sim.fighters[0], 790, 780);
    steps(sim, 10); // pick up mid-boost
    expect(sim.fighters[0].speedBoost).toBeGreaterThan(0);
    const wire = JSON.parse(JSON.stringify(serializeSim(sim)));
    const sim2 = quietSim();
    applySimSnap(sim2, wire);
    // both advance identically
    for (let i = 0; i < 120; i++) {
      sim.step([frame(Btn.Right), N]);
      sim2.step([frame(Btn.Right), N]);
    }
    expect(JSON.stringify(serializeSim(sim2))).toBe(JSON.stringify(serializeSim(sim)));
  });
});

describe("molten_span (map 2)", () => {
  it("is registered and resolvable", () => {
    expect(STAGES.molten_span).toBeDefined();
    expect(stageById("molten_span").id).toBe("molten_span");
    expect(stageById("nope").id).toBe("emberfall_keep"); // fallback
    expect(stageById(null).id).toBe("emberfall_keep");
  });

  it("has a lethal center gap between the islands", () => {
    const sim = new Sim(moltenSpan());
    const f = sim.addFighter("knight");
    sim.addFighter("knight");
    place(f, 960, 700); // over the gap, below the bridge
    place(sim.fighters[1], 480, 700);
    const fell = stepUntil(sim, () => f.state === "dead", 300, [N, N]);
    expect(fell).toBeGreaterThan(0); // fell straight through to the blast zone
  });

  it("the soft bridge catches fighters crossing the gap", () => {
    const sim = new Sim(moltenSpan());
    const f = sim.addFighter("knight");
    sim.addFighter("knight");
    place(f, 960, 400); // above the bridge (y=590)
    place(sim.fighters[1], 480, 700);
    const landed = stepUntil(sim, () => f.grounded, 120);
    expect(landed).toBeGreaterThan(0);
    expect(f.y).toBe(590);
  });

  it("4 spawn points, all above solid ground", () => {
    const stage = moltenSpan();
    expect(stage.spawns.length).toBe(4);
    for (const s of stage.spawns) {
      const overSolid = stage.platforms.some(
        (p) => !p.soft && s.x > p.x && s.x < p.x + p.w && p.y > s.y,
      );
      expect(overSolid, `spawn at ${s.x}`).toBe(true);
    }
  });
});
