/**
 * Platform kinematics + stage hazards. Everything here is tick-driven and
 * deterministic: platform positions/solidity and hazard phases are pure
 * functions of the tick, so there is nothing new to synchronize — these
 * tests pin that property (carry, collision at offset positions, one hit
 * per hazard activation, snapshot round-trip of the new fighter fields).
 */
import { describe, expect, it } from "vitest";
import {
  Sim, hazardStateAt, hazardTelegraphT,
  platformOffset, platformPhaseIn, platformSolid,
  type HazardDef, type Platform, type Stage,
} from "./sim.js";
import { serializeSim, applySimSnap } from "./snapshot.js";
import { N, frame, place, steps, stepUntil, Btn } from "./testutil.js";

/** A drifting platform (horizontal ±60px over 240 ticks). */
const DRIFTER: Platform = {
  x: 760, y: 700, w: 400, soft: false,
  motion: { dx: 60, dy: 0, periodTicks: 240 },
};

/** A bobbing platform (vertical ±50px over 180 ticks). */
const BOBBER: Platform = {
  x: 300, y: 600, w: 300, soft: false,
  motion: { dx: 0, dy: 50, periodTicks: 180 },
};

/** Solid 60 ticks, gone 60 ticks. */
const PHASER: Platform = {
  x: 1400, y: 700, w: 300, soft: false,
  phasing: { periodTicks: 120, solidTicks: 60 },
};

/** Strikes straight up for 10 ticks at the end of every 120-tick cycle. */
const GEYSER: HazardDef = {
  id: "test_geyser",
  x: 800, y: 500, w: 200, h: 210,
  periodTicks: 120, telegraphTicks: 30, activeTicks: 10,
  damage: 12, baseKnockback: 700, kbGrowth: 10, angleDeg: 90, hitstop: 6,
};

function hazardStage(): Stage {
  return {
    platforms: [DRIFTER, BOBBER, PHASER, { x: 700, y: 980, w: 900, soft: false }],
    blast: { left: -400, right: 2400, top: -600, bottom: 1500 },
    spawns: [
      { x: 960, y: 650 },
      { x: 1100, y: 900 },
      { x: 860, y: 650 },
      { x: 1200, y: 900 },
    ],
    itemSpawns: [],
    hazards: [GEYSER],
  };
}

function makeHazardSim(): Sim {
  const sim = new Sim(hazardStage());
  sim.itemsEnabled = false;
  sim.addFighter();
  sim.addFighter();
  return sim;
}

describe("platform kinematics (pure functions)", () => {
  it("platformOffset oscillates ±(dx,dy) with the period", () => {
    expect(platformOffset(DRIFTER, 0)).toEqual({ x: 0, y: 0 });
    expect(platformOffset(DRIFTER, 60).x).toBeCloseTo(60, 5); // quarter period = peak
    expect(platformOffset(DRIFTER, 120).x).toBeCloseTo(0, 5);
    expect(platformOffset(DRIFTER, 180).x).toBeCloseTo(-60, 5);
    expect(platformOffset(BOBBER, 45).y).toBeCloseTo(50, 5);
    expect(platformOffset({ x: 0, y: 0, w: 100, soft: false }, 1234)).toEqual({ x: 0, y: 0 });
  });

  it("platformSolid follows the phasing schedule (phase offset respected)", () => {
    expect(platformSolid(PHASER, 0)).toBe(true);
    expect(platformSolid(PHASER, 59)).toBe(true);
    expect(platformSolid(PHASER, 60)).toBe(false);
    expect(platformSolid(PHASER, 119)).toBe(false);
    expect(platformSolid(PHASER, 120)).toBe(true);
    const shifted: Platform = { ...PHASER, phasing: { periodTicks: 120, solidTicks: 60, phase: 0.5 } };
    expect(platformSolid(shifted, 0)).toBe(false);
    expect(platformSolid(shifted, 60)).toBe(true);
    expect(platformSolid({ x: 0, y: 0, w: 100, soft: false }, 42)).toBe(true);
  });

  it("platformPhaseIn counts ticks to the next solidity flip", () => {
    expect(platformPhaseIn(PHASER, 0)).toBe(60); // solid now, vanishes at 60
    expect(platformPhaseIn(PHASER, 59)).toBe(1);
    expect(platformPhaseIn(PHASER, 60)).toBe(60); // gone now, back at 120
    expect(platformPhaseIn({ x: 0, y: 0, w: 100, soft: false }, 0)).toBe(Infinity);
  });
});

describe("moving platforms in the sim", () => {
  it("a fighter standing on a drifting platform is carried with it", () => {
    const sim = makeHazardSim();
    const f = sim.fighters[0];
    place(f, 960, 650);
    place(sim.fighters[1], 1100, 900);
    steps(sim, 20); // land on the drifter
    expect(f.grounded).toBe(true);
    expect(f.groundPlat).toBe(0);

    const startTick = sim.tick;
    const startX = f.x;
    steps(sim, 60);
    const expected = platformOffset(DRIFTER, sim.tick).x - platformOffset(DRIFTER, startTick).x;
    expect(f.x - startX).toBeCloseTo(expected, 3);
    expect(f.grounded).toBe(true); // never slid off
  });

  it("a fighter stays glued to a bobbing platform through a full cycle", () => {
    const sim = makeHazardSim();
    const f = sim.fighters[0];
    place(f, 450, 500); // above the bobber
    place(sim.fighters[1], 1100, 900);
    steps(sim, 25);
    expect(f.groundPlat).toBe(1);
    for (let i = 0; i < 180; i++) {
      steps(sim, 1);
      expect(f.grounded).toBe(true);
      const top = BOBBER.y + platformOffset(BOBBER, sim.tick).y;
      expect(Math.abs(f.y - top)).toBeLessThan(1e-6);
    }
  });

  it("landing uses the platform's CURRENT position, not its base", () => {
    const sim = makeHazardSim();
    const f = sim.fighters[0];
    place(sim.fighters[1], 1100, 900);
    // advance to the drifter's peak offset (+60), then drop a fighter at the
    // right edge that only overlaps the platform because it has moved
    while (platformOffset(DRIFTER, sim.tick).x < 59) steps(sim, 1);
    place(f, DRIFTER.x + DRIFTER.w + 40, 650); // past the base right edge (1160), inside moved edge (1220)
    const landed = stepUntil(sim, () => f.grounded, 30);
    expect(landed).toBeGreaterThan(0);
    expect(f.groundPlat).toBe(0);
  });

  it("a phased-out platform does not hold a fighter up", () => {
    const sim = makeHazardSim();
    const f = sim.fighters[0];
    place(f, 1550, 650);
    place(sim.fighters[1], 1100, 900);
    steps(sim, 20); // land while solid (ticks 0..59)
    expect(f.groundPlat).toBe(2);
    // step past the solid window: floor vanishes underfoot
    while (platformSolid(PHASER, sim.tick + 1)) steps(sim, 1);
    steps(sim, 3);
    expect(f.grounded).toBe(false);
    // it falls to the safety floor below
    const landed = stepUntil(sim, () => f.grounded, 120);
    expect(landed).toBeGreaterThan(0);
    expect(f.groundPlat).toBe(3);
  });

  it("projectiles are blocked by solid platforms only while they are solid", () => {
    const sim = makeHazardSim();
    const shooter = sim.fighters[0];
    place(shooter, 1550, 400); // above the phaser
    place(sim.fighters[1], 1100, 900);
    // fire straight down while the phaser is solid
    sim.projectiles.push({
      owner: 0, x: 1550, y: 660, vx: 0, vy: 800, life: 60, armed: false,
      def: { speed: 800, damage: 5, baseKnockback: 200, kbGrowth: 5, radius: 8, gravityScale: 0, lifeTicks: 60, hitstop: 2 },
    });
    steps(sim, 6);
    expect(sim.projectiles.length).toBe(0); // absorbed by the solid platform

    // now the same shot while the platform is phased out sails through
    while (platformSolid(PHASER, sim.tick + 1)) steps(sim, 1);
    sim.projectiles.push({
      owner: 0, x: 1550, y: 660, vx: 0, vy: 800, life: 20, armed: false,
      def: { speed: 800, damage: 5, baseKnockback: 200, kbGrowth: 5, radius: 8, gravityScale: 0, lifeTicks: 20, hitstop: 2 },
    });
    steps(sim, 10);
    expect(sim.projectiles.length).toBe(1); // still flying, nothing blocked it
  });
});

describe("stage hazards", () => {
  it("hazardStateAt cycles idle -> telegraph -> active at the end of the period", () => {
    expect(hazardStateAt(GEYSER, 0)).toBe("idle");
    expect(hazardStateAt(GEYSER, 79)).toBe("idle");
    expect(hazardStateAt(GEYSER, 80)).toBe("telegraph");
    expect(hazardStateAt(GEYSER, 109)).toBe("telegraph");
    expect(hazardStateAt(GEYSER, 110)).toBe("active");
    expect(hazardStateAt(GEYSER, 119)).toBe("active");
    expect(hazardStateAt(GEYSER, 120)).toBe("idle");
  });

  it("hazardTelegraphT ramps 0..1 across the telegraph window", () => {
    expect(hazardTelegraphT(GEYSER, 0)).toBe(0);
    expect(hazardTelegraphT(GEYSER, 80)).toBe(0);
    expect(hazardTelegraphT(GEYSER, 95)).toBeCloseTo(0.5, 5);
    expect(hazardTelegraphT(GEYSER, 110)).toBe(1);
  });

  it("an active hazard hits for exact damage at the fixed absolute angle", () => {
    const sim = makeHazardSim();
    const f = sim.fighters[0];
    place(f, 900, 700); // hurtbox inside the geyser zone (500..710)
    place(sim.fighters[1], 1200, 900);
    let hit: { damage: number } | null = null;
    // hold position: re-place each tick so the drifting platform doesn't matter
    for (let i = 0; i < 130 && !hit; i++) {
      place(f, 900, 700);
      const events = sim.step([N, N]);
      const h = events.find((e) => e.t === "hit");
      if (h && h.t === "hit") hit = h;
      if (!hit) expect(f.damage).toBe(0); // idle/telegraph never damages
    }
    expect(hit).not.toBeNull();
    expect(f.damage).toBe(GEYSER.damage);
    expect(f.vy).toBeLessThan(0); // 90° = launched straight up
    expect(Math.abs(f.vx)).toBeLessThan(1); // no horizontal component
  });

  it("one hit per activation, then the next cycle hits again", () => {
    const sim = makeHazardSim();
    const f = sim.fighters[0];
    place(sim.fighters[1], 1200, 900);
    for (let i = 0; i < 125; i++) {
      place(f, 900, 700); // pin inside the zone through the whole window
      sim.step([N, N]);
    }
    expect(f.damage).toBe(GEYSER.damage); // exactly one application
    for (let i = 0; i < 120; i++) {
      place(f, 900, 700);
      sim.step([N, N]);
    }
    expect(f.damage).toBe(GEYSER.damage * 2); // second activation landed
  });

  it("respawn invulnerability blocks hazard hits", () => {
    const sim = makeHazardSim();
    const f = sim.fighters[0];
    place(sim.fighters[1], 1200, 900);
    f.invuln = 400;
    for (let i = 0; i < 125; i++) {
      place(f, 900, 700);
      sim.step([N, N]);
    }
    expect(f.damage).toBe(0);
  });

  it("hazard knockback scales with accumulated damage like any other hit", () => {
    const runAt = (preDamage: number): number => {
      const sim = makeHazardSim();
      const f = sim.fighters[0];
      place(sim.fighters[1], 1200, 900);
      f.damage = preDamage;
      let vy = 0;
      for (let i = 0; i < 125 && vy === 0; i++) {
        place(f, 900, 700);
        const events = sim.step([N, N]);
        if (events.some((e) => e.t === "hit")) vy = f.vy;
      }
      return vy;
    };
    expect(Math.abs(runAt(100))).toBeGreaterThan(Math.abs(runAt(0)));
  });
});

describe("determinism & serialization with kinematics + hazards", () => {
  it("identical inputs => identical state on a moving/hazardous stage", () => {
    const simA = makeHazardSim();
    const simB = makeHazardSim();
    for (let t = 0; t < 300; t++) {
      const inputs = [
        frame(t % 90 < 45 ? Btn.Right : Btn.Left | (t % 60 === 0 ? Btn.Jump : 0), 1, -0.3),
        frame(t % 70 < 35 ? Btn.Left : Btn.Right, -1, 0),
      ];
      simA.step(inputs);
      simB.step(inputs);
    }
    expect(JSON.stringify(serializeSim(simA))).toBe(JSON.stringify(serializeSim(simB)));
  });

  it("groundPlat/hazardCooldown survive a snapshot round-trip (desync guard)", () => {
    const sim = makeHazardSim();
    const f = sim.fighters[0];
    place(f, 960, 650);
    place(sim.fighters[1], 900, 950);
    steps(sim, 20);
    expect(f.groundPlat).toBe(0);
    sim.fighters[1].hazardCooldown = 17;

    const wire = JSON.parse(JSON.stringify(serializeSim(sim)));
    const sim2 = makeHazardSim();
    sim2.step([N, N]); // desync the copy first, then load the snapshot over it
    applySimSnap(sim2, wire);

    // both sims must now evolve identically — if groundPlat had been dropped,
    // the carried fighter would drift apart from its copy within a few ticks
    for (let t = 0; t < 120; t++) {
      sim.step([N, N]);
      sim2.step([N, N]);
    }
    expect(JSON.stringify(serializeSim(sim2))).toBe(JSON.stringify(serializeSim(sim)));
  });
});
