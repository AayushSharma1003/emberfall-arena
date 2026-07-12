/**
 * The Phase-2 mechanics: ultimate meter, burn DoT, fire zones, hold-to-charge
 * specials, teleports + mirror clones, constructs (turrets), kindle scaling,
 * parry/riposte/reflect, multi-projectile volleys, sticky proximity mines,
 * radial launches, self-damage — each exercised end-to-end through real
 * character data, plus a cross-system snapshot round-trip determinism guard.
 */
import { describe, expect, it } from "vitest";
import { CHARACTERS, type CharId } from "./characters.js";
import { Sim, TUNING, ULT_TUNING, emberfallKeep, type SimEvent } from "./sim.js";
import { applySimSnap, serializeSim } from "./snapshot.js";
import { Btn, N, frame, place, steps, stepUntil } from "./testutil.js";

/** Sim with chosen characters (teams alternate by index unless given). */
function duo(a: CharId, b: CharId, teams?: [number, number]): Sim {
  const sim = new Sim(emberfallKeep());
  sim.itemsEnabled = false;
  sim.addFighter(a, teams?.[0]);
  sim.addFighter(b, teams?.[1]);
  return sim;
}

function settle2(sim: Sim, ax = 800, bx = 1200): void {
  place(sim.fighters[0], ax, 700);
  place(sim.fighters[1], bx, 700);
  steps(sim, 30);
}

// ---------------------------------------------------------------------------
describe("ultimate meter", () => {
  it("builds from damage dealt and taken at the tuned rates", () => {
    const sim = duo("knight", "ogre");
    settle2(sim, 800, 890);
    const [a, b] = sim.fighters;
    steps(sim, 1, [frame(Btn.Light, 1, 0)]);
    stepUntil(sim, () => b.damage > 0, 20);
    const dmg = CHARACTERS.knight.moves.light.damage;
    expect(a.ult).toBeCloseTo(dmg * ULT_TUNING.gainDealt, 5);
    expect(b.ult).toBeCloseTo(dmg * ULT_TUNING.gainTaken, 5);
  });

  it("the ultimate button does nothing without a full meter", () => {
    const sim = duo("ogre", "knight");
    settle2(sim, 800, 900);
    const a = sim.fighters[0];
    a.ult = ULT_TUNING.max - 1;
    steps(sim, 1, [frame(Btn.Ultimate, 1, 0)]);
    steps(sim, 3);
    expect(a.attack).toBeNull();
    expect(a.ult).toBeCloseTo(ULT_TUNING.max - 1, 5);
  });

  it("a full meter fires the ultimate, consumes everything, and emits the event", () => {
    const sim = duo("ogre", "knight");
    settle2(sim, 800, 900);
    const a = sim.fighters[0];
    a.ult = ULT_TUNING.max;
    const events: SimEvent[] = [];
    events.push(...sim.step([frame(Btn.Ultimate, 1, 0), N]));
    expect(a.attack?.id).toBe("kilnbreakers_verdict");
    expect(a.ult).toBe(0);
    expect(events.some((e) => e.t === "ult" && e.id === 0)).toBe(true);
  });

  it("the meter survives losing a stock", () => {
    const sim = duo("knight", "ogre");
    settle2(sim);
    const a = sim.fighters[0];
    a.ult = 73;
    place(a, 100, 1600); // below the blast line
    steps(sim, 2);
    expect(a.state).toBe("dead");
    expect(a.ult).toBe(73);
  });
});

// ---------------------------------------------------------------------------
describe("burn DoT", () => {
  it("hellfire smash ignites: exact chip damage on the burn cadence, then it expires", () => {
    const sim = duo("demon_queen", "knight");
    settle2(sim, 800, 880);
    const vic = sim.fighters[1];
    steps(sim, 1, [frame(Btn.Heavy, 1, 0)]);
    stepUntil(sim, () => vic.damage > 0, 40);
    const base = CHARACTERS.demon_queen.moves.heavy.damage;
    expect(vic.damage).toBe(base);
    expect(vic.burnTicks).toBe(90);
    expect(vic.burnFrom).toBe(0);
    // park the victim far away so nothing else touches them
    place(vic, 460, 700);
    steps(sim, 120);
    // 90 burn ticks at 1 damage per 20-tick interval -> exactly 5 procs (80/60/40/20/0)
    expect(vic.damage).toBe(base + 5 * TUNING.burnDamage);
    expect(vic.burnTicks).toBe(0);
    steps(sim, 60);
    expect(vic.damage).toBe(base + 5 * TUNING.burnDamage); // fire is out
  });

  it("burn credits ultimate meter to the lighter", () => {
    const sim = duo("demon_queen", "knight");
    settle2(sim, 800, 880);
    const [atk, vic] = sim.fighters;
    steps(sim, 1, [frame(Btn.Heavy, 1, 0)]);
    stepUntil(sim, () => vic.damage > 0, 40);
    const afterHit = atk.ult;
    place(vic, 460, 700);
    steps(sim, 120);
    expect(atk.ult).toBeGreaterThan(afterHit); // the fire kept paying
  });

  it("ring-out puts the fire out", () => {
    const sim = duo("demon_queen", "knight");
    settle2(sim);
    const vic = sim.fighters[1];
    vic.burnTicks = 200;
    vic.burnFrom = 0;
    place(vic, 100, 1600);
    steps(sim, 2);
    expect(vic.state).toBe("dead");
    expect(vic.burnTicks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("fire zones", () => {
  it("soulfire leaves a cinder pool where it dies; standing in it keeps you burning", () => {
    const sim = duo("demon_queen", "knight");
    settle2(sim, 800, 1200);
    const vic = sim.fighters[1];
    // fire soulfire into the victim: direct hit -> dies on them -> pool at their feet
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    stepUntil(sim, () => sim.zones.length > 0, 60);
    expect(sim.zones.length).toBe(1);
    const z = sim.zones[0];
    expect(z.owner).toBe(0);
    // victim stands in the pool: burn is continuously refreshed to the zone's value
    place(vic, z.x, 780);
    steps(sim, 30, [N, N]);
    expect(vic.burnTicks).toBeGreaterThanOrEqual(120 - 1);
    // pool expires on schedule
    steps(sim, 200);
    expect(sim.zones.length).toBe(0);
  });

  it("teammates never burn in your pool (friendly fire off)", () => {
    const sim = new Sim(emberfallKeep());
    sim.itemsEnabled = false;
    sim.addFighter("demon_queen", 0);
    sim.addFighter("knight", 0); // teammate
    sim.addFighter("ogre", 1); // so the zone team check is meaningful
    sim.zones.push({ owner: 0, team: 0, x: 800, y: 760, radius: 150, life: 300, burnTicks: 120 });
    place(sim.fighters[1], 800, 700);
    place(sim.fighters[2], 1400, 700);
    steps(sim, 30);
    expect(sim.fighters[1].burnTicks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("hold-to-charge specials (mage ember bolt)", () => {
  it("a tap fires a weakened bolt on release", () => {
    const sim = duo("mage", "knight");
    settle2(sim, 800, 1300);
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]); // press
    steps(sim, 1); // release
    const spawned = stepUntil(sim, () => sim.projectiles.length === 1, 12);
    expect(spawned).toBeGreaterThan(0);
    const base = CHARACTERS.mage.moves.special.projectile!;
    const p = sim.projectiles[0];
    expect(p.def.damage).toBeLessThan(base.damage * 0.65); // ~minFactor
    expect(p.def.homing).toBeUndefined();
  });

  it("a full charge fires the homing star instead", () => {
    const sim = duo("mage", "knight");
    settle2(sim, 800, 1300);
    const hold = [frame(Btn.Shoot, 1, 0), N];
    for (let i = 0; i < 55; i++) sim.step(hold); // held past maxTicks
    sim.step([N, N]); // release
    stepUntil(sim, () => sim.projectiles.length === 1, 12);
    const star = CHARACTERS.mage.moves.special.chargedProjectile!;
    expect(sim.projectiles[0].def).toBe(star);
    expect(sim.projectiles[0].def.homing).toBeGreaterThan(0);
  });

  it("charging roots the mage: held movement input goes nowhere", () => {
    const sim = duo("mage", "knight");
    settle2(sim, 800, 1300);
    const a = sim.fighters[0];
    const x0 = a.x;
    steps(sim, 30, [frame(Btn.Shoot | Btn.Right, 1, 0)]);
    expect(a.state).toBe("charge");
    // the press tick itself applies one frame of acceleration before the
    // charge roots her — anything beyond that ~1.5px is a real walk
    expect(Math.abs(a.x - x0)).toBeLessThan(5);
    const x1 = a.x;
    steps(sim, 30, [frame(Btn.Shoot | Btn.Right, 1, 0)]);
    expect(Math.abs(a.x - x1)).toBeLessThan(0.001); // fully rooted now
  });

  it("getting hit interrupts the charge without consuming the cooldown", () => {
    const sim = duo("mage", "goblin");
    settle2(sim, 800, 870);
    const [mage] = sim.fighters;
    steps(sim, 5, [frame(Btn.Shoot, 1, 0), N]); // mage charging
    expect(mage.charging).toBe(true);
    steps(sim, 1, [frame(Btn.Shoot, 1, 0), frame(Btn.Light, -1, 0)]); // goblin smacks her
    stepUntil(sim, () => mage.hitstun > 0, 10, [frame(Btn.Shoot, 1, 0), N]);
    expect(mage.charging).toBe(false);
    expect(mage.specialCooldown).toBe(0); // no shot, no cost
    expect(sim.projectiles.length).toBe(0);
  });

  it("the homing star actually steers toward its target", () => {
    const sim = duo("mage", "knight");
    settle2(sim, 800, 1400);
    const vic = sim.fighters[1];
    // full charge, then release aimed straight UP — the star must turn
    const hold = [frame(Btn.Shoot, 0, -1), N];
    for (let i = 0; i < 55; i++) sim.step(hold);
    sim.step([frame(0, 0, -1), N]);
    stepUntil(sim, () => sim.projectiles.length === 1, 12, [frame(0, 0, -1), N]);
    const angleTo = (): number => {
      const p = sim.projectiles[0];
      const want = Math.atan2(vic.y - vic.stats.height / 2 - p.y, vic.x - p.x);
      const cur = Math.atan2(p.vy, p.vx);
      let d = Math.abs(want - cur);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d;
    };
    const before = angleTo();
    steps(sim, 15);
    expect(sim.projectiles.length).toBe(1);
    expect(angleTo()).toBeLessThan(before - 0.3); // converging, not drifting
  });
});

// ---------------------------------------------------------------------------
describe("teleport + mirror clone (sable ash step)", () => {
  it("blinks 260px along aim, with i-frames through the startup", () => {
    const sim = duo("sable", "knight");
    settle2(sim, 800, 1400);
    const a = sim.fighters[0];
    const m = CHARACTERS.sable.moves.special;
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    expect(a.invuln).toBeGreaterThan(0); // protected from the press
    steps(sim, m.startupTicks - 1);
    expect(a.x).toBeCloseTo(800 + m.teleport!.distance, 0);
  });

  it("leaves an armed clone at the origin that detonates on proximity", () => {
    const sim = duo("sable", "knight");
    settle2(sim, 800, 1400);
    const vic = sim.fighters[1];
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    steps(sim, CHARACTERS.sable.moves.special.startupTicks);
    expect(sim.projectiles.length).toBe(1);
    const clone = sim.projectiles[0];
    expect(clone.armed).toBe(true);
    expect(clone.vx).toBe(0);
    expect(Math.abs(clone.x - 800)).toBeLessThan(10); // at the ORIGIN, not the exit
    // victim wanders into the trigger radius
    place(vic, clone.x + 50, 780);
    const events: SimEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(...sim.step([N, N]));
    expect(events.some((e) => e.t === "explode")).toBe(true);
    expect(vic.damage).toBe(CHARACTERS.sable.moves.special.projectile!.damage);
  });

  it("teleport is clamped inside the blast zone", () => {
    const sim = duo("sable", "knight");
    settle2(sim, 800, 460);
    const a = sim.fighters[0];
    place(a, sim.stage.blast.right - 100, 700);
    steps(sim, 10);
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    steps(sim, CHARACTERS.sable.moves.special.startupTicks);
    expect(a.x).toBeLessThanOrEqual(sim.stage.blast.right - 60);
    expect(a.state).not.toBe("dead");
  });
});

// ---------------------------------------------------------------------------
describe("constructs (hessa's kilns)", () => {
  // a held 5-tick press: robust against hitstop windows swallowing a
  // single-tick synthetic press (turret hits freeze the whole world)
  function deployKiln(sim: Sim): void {
    steps(sim, 5, [frame(Btn.Shoot, 1, 0)]);
    steps(sim, CHARACTERS.hessa.moves.special.startupTicks + 5);
  }

  it("deploys in front, settles on the platform, and shoots the nearest enemy", () => {
    const sim = duo("hessa", "knight");
    settle2(sim, 800, 1200);
    const vic = sim.fighters[1];
    deployKiln(sim);
    expect(sim.constructs.length).toBe(1);
    const c = sim.constructs[0];
    expect(c.x).toBeCloseTo(870, -1);
    steps(sim, 5);
    expect(c.y).toBeCloseTo(780, 0); // settled on the main platform top
    // it opens fire without any further input from hessa
    const hit = stepUntil(sim, () => vic.damage > 0, 200);
    expect(hit).toBeGreaterThan(0);
    expect(vic.damage).toBe(CHARACTERS.hessa.moves.special.construct!.projectile.damage);
  });

  it("holds fire when only teammates are around", () => {
    const sim = new Sim(emberfallKeep());
    sim.itemsEnabled = false;
    sim.addFighter("hessa", 0);
    sim.addFighter("knight", 0); // friendly
    place(sim.fighters[0], 800, 700);
    place(sim.fighters[1], 1000, 700);
    steps(sim, 30);
    deployKiln(sim);
    steps(sim, 200);
    expect(sim.projectiles.length).toBe(0);
    expect(sim.fighters[1].damage).toBe(0);
  });

  it("is destructible: enemy melee chews through its hp", () => {
    const sim = duo("hessa", "knight");
    settle2(sim, 800, 1000);
    deployKiln(sim);
    const kiln = sim.constructs[0];
    place(sim.fighters[1], kiln.x + 60, 780);
    const events: SimEvent[] = [];
    for (let i = 0; i < 400 && sim.constructs.length > 0; i++) {
      // hessa parked out of the swing's path so the kiln takes every hit;
      // presses held 3 ticks to survive hitstop windows
      place(sim.fighters[0], 500, 780);
      events.push(...sim.step([N, frame(i % 30 < 3 ? Btn.Light : 0, -1, 0)]));
    }
    expect(sim.constructs.length).toBe(0);
    expect(events.some((e) => e.t === "constructdie")).toBe(true);
  });

  it("redeploying past maxActive scraps the oldest kiln", () => {
    const sim = duo("hessa", "knight");
    settle2(sim, 800, 1300);
    deployKiln(sim);
    expect(sim.constructs.length).toBe(1);
    const firstX = sim.constructs[0].x;
    steps(sim, CHARACTERS.hessa.moves.special.cooldownTicks + 20);
    // walk right a good way, then deploy again
    steps(sim, 40, [frame(Btn.Right)]);
    steps(sim, 5); // stop
    deployKiln(sim);
    expect(sim.constructs.length).toBe(1); // capped at maxActive
    expect(Math.abs(sim.constructs[0].x - firstX)).toBeGreaterThan(100); // and it's the NEW one
  });

  it("expires at end of life", () => {
    const sim = duo("hessa", "knight");
    settle2(sim, 800, 1300);
    deployKiln(sim);
    expect(sim.constructs.length).toBe(1);
    // margin for hitstop: every turret hit freezes the world clock a few ticks
    steps(sim, CHARACTERS.hessa.moves.special.construct!.lifeTicks + 200);
    expect(sim.constructs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("kindle (pyre burns brighter when hurt)", () => {
  it("doubles outgoing damage and base knockback at 150%", () => {
    const hitAt = (preDamage: number): { dmg: number; vx: number } => {
      const sim = duo("pyre", "knight");
      settle2(sim, 800, 870);
      sim.fighters[0].damage = preDamage;
      const vic = sim.fighters[1];
      steps(sim, 1, [frame(Btn.Light, 1, 0)]);
      stepUntil(sim, () => vic.damage > 0, 20);
      return { dmg: vic.damage, vx: vic.vx };
    };
    const cold = hitAt(0);
    const blazing = hitAt(150);
    const m = CHARACTERS.pyre.moves.light;
    expect(cold.dmg).toBe(m.damage);
    expect(blazing.dmg).toBeCloseTo(m.damage * 2, 5);
    expect(blazing.vx).toBeGreaterThan(cold.vx * 1.5); // baseKB doubled, growth same
  });

  it("supernova pays its self-damage up front (feeding its own kindle)", () => {
    const sim = duo("pyre", "knight");
    settle2(sim, 800, 1400);
    const a = sim.fighters[0];
    a.ult = ULT_TUNING.max;
    steps(sim, 1, [frame(Btn.Ultimate, 1, 0)]);
    steps(sim, CHARACTERS.pyre.moves.ultimate.startupTicks);
    expect(a.damage).toBe(CHARACTERS.pyre.moves.ultimate.selfDamage!);
  });
});

// ---------------------------------------------------------------------------
describe("parry (knight's oath of embers)", () => {
  it("negates an incoming melee hit and ripostes the attacker", () => {
    const sim = duo("knight", "ogre");
    settle2(sim, 800, 890);
    const [kn, og] = sim.fighters;
    kn.ult = ULT_TUNING.max;
    steps(sim, 1, [frame(Btn.Ultimate, 1, 0)]); // stance up (active 3..33)
    steps(sim, 4);
    const events: SimEvent[] = [];
    // ogre swings his light into the stance
    events.push(...sim.step([N, frame(Btn.Light, -1, 0)]));
    for (let i = 0; i < 20; i++) events.push(...sim.step([N, N]));
    expect(kn.damage).toBe(0); // the blow never landed
    expect(og.damage).toBe(CHARACTERS.knight.moves.ultimate.parry!.damage);
    expect(events.some((e) => e.t === "parry" && e.id === 0)).toBe(true);
    expect(kn.attack).toBeNull(); // stance consumed by the riposte
  });

  it("reflects projectiles back at the shooter", () => {
    const sim = duo("knight", "demon_queen");
    settle2(sim, 800, 1250);
    const [kn, dq] = sim.fighters;
    kn.ult = ULT_TUNING.max;
    // queen fires soulfire; knight raises the stance to meet it
    steps(sim, 1, [frame(Btn.Ultimate, -1, 0), frame(Btn.Shoot, -1, 0)]);
    const reflected = stepUntil(sim, () => sim.projectiles.length === 1 && sim.projectiles[0].owner === 0, 40);
    expect(reflected).toBeGreaterThan(0);
    expect(kn.damage).toBe(0);
    // and the returned bolt burns its maker
    const payback = stepUntil(sim, () => dq.damage > 0, 60);
    expect(payback).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("volleys, mines, radial bursts", () => {
  it("wren's embersnare volley fires 3 snares that land and arm as mines", () => {
    const sim = duo("ranger", "knight");
    settle2(sim, 700, 460);
    const a = sim.fighters[0];
    a.ult = ULT_TUNING.max;
    steps(sim, 1, [frame(Btn.Ultimate, 1, -0.35)]);
    steps(sim, CHARACTERS.ranger.moves.ultimate.startupTicks + 1);
    expect(sim.projectiles.length).toBe(3);
    stepUntil(sim, () => sim.projectiles.some((p) => p.armed), 150);
    const mine = sim.projectiles.find((p) => p.armed)!;
    expect(mine.vx).toBe(0);
    expect(mine.vy).toBe(0);
    // an enemy stepping near an armed snare sets it off
    const vic = sim.fighters[1];
    place(vic, mine.x + 40, 780);
    const events: SimEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(...sim.step([N, N]));
    expect(events.some((e) => e.t === "explode")).toBe(true);
    expect(vic.damage).toBeGreaterThanOrEqual(CHARACTERS.ranger.moves.ultimate.projectile!.damage);
  });

  it("mines ignore their owner and teammates", () => {
    const sim = new Sim(emberfallKeep());
    sim.itemsEnabled = false;
    sim.addFighter("ranger", 0);
    sim.addFighter("knight", 0);
    place(sim.fighters[0], 800, 700);
    place(sim.fighters[1], 1400, 700);
    steps(sim, 30);
    sim.projectiles.push({
      owner: 0, x: 820, y: 760, vx: 0, vy: 0, life: 500, armed: true,
      def: CHARACTERS.ranger.moves.ultimate.projectile!,
    });
    place(sim.fighters[1], 850, 780); // teammate standing on it
    steps(sim, 30);
    expect(sim.projectiles.length).toBe(1); // still armed, nobody hurt
    expect(sim.fighters[1].damage).toBe(0);
  });

  it("a direct bomb hit never double-dips its own explosion", () => {
    const sim = duo("goblin", "ogre");
    settle2(sim, 800, 1100);
    const a = sim.fighters[0];
    const vic = sim.fighters[1];
    a.ult = ULT_TUNING.max;
    steps(sim, 1, [frame(Btn.Ultimate, 1, -0.2)]);
    stepUntil(sim, () => vic.damage > 0, 90);
    // exactly one application of one bomb's damage (the other two fly wide or
    // also explode — but the direct victim is excluded from their own blast)
    expect(vic.damage).toBe(CHARACTERS.goblin.moves.ultimate.projectile!.damage);
  });

  it("vexis' court of ash launches both enemies radially away from her", () => {
    const sim = new Sim(emberfallKeep());
    sim.itemsEnabled = false;
    sim.addFighter("demon_queen", 0);
    sim.addFighter("knight", 1);
    sim.addFighter("ogre", 1);
    place(sim.fighters[0], 900, 700);
    place(sim.fighters[1], 800, 700);
    place(sim.fighters[2], 1010, 700);
    steps(sim, 30);
    const q = sim.fighters[0];
    q.ult = ULT_TUNING.max;
    steps(sim, 1, [frame(Btn.Ultimate, 1, 0), N, N]);
    steps(sim, CHARACTERS.demon_queen.moves.ultimate.startupTicks + 1);
    expect(sim.fighters[1].vx).toBeLessThan(0); // left enemy flung left
    expect(sim.fighters[2].vx).toBeGreaterThan(0); // right enemy flung right
    expect(sim.zones.length).toBe(1); // and the burning court remains
  });
});

// ---------------------------------------------------------------------------
describe("cross-system snapshot round-trip", () => {
  it("a war-torn state (turrets, mines, zones, burns, charge) survives the wire byte-for-byte", () => {
    const build = (): Sim => {
      const sim = new Sim(emberfallKeep());
      sim.itemsEnabled = false;
      for (const [id, team] of [["hessa", 0], ["demon_queen", 1], ["sable", 0], ["pyre", 1]] as const) {
        sim.addFighter(id, team);
      }
      return sim;
    };
    const script = (t: number): ReturnType<typeof frame>[] => [
      // hessa: deploy at t=0, redeploy at t≈250 (held presses ride out hitstop), pacing between
      frame(t < 6 || (t >= 250 && t < 256) ? Btn.Shoot : t % 50 < 25 ? Btn.Right : Btn.Left, 1, 0),
      frame(t % 120 === 5 ? Btn.Shoot : 0, -1, 0), // vexis slings occasional soulfire
      frame(t % 90 === 10 ? Btn.Shoot : t % 7 === 0 ? Btn.Jump : 0, 1, -0.5), // sable blinks about
      frame(t % 45 === 3 ? Btn.Shoot : Btn.Right, -1, 0), // pyre sparks
    ];
    const simA = build();
    for (const f of simA.fighters) f.ult = 100;
    for (let t = 0; t < 280; t++) simA.step(script(t));

    // battle state must be rich enough to make this test meaningful
    expect(simA.constructs.length).toBeGreaterThan(0);
    expect(simA.fighters.some((f) => f.burnTicks > 0) || simA.zones.length > 0).toBe(true);

    const wire = JSON.parse(JSON.stringify(serializeSim(simA)));
    const simB = build();
    simB.step(script(0)); // desync first, then load over it
    applySimSnap(simB, wire);
    for (let t = 280; t < 400; t++) {
      simA.step(script(t));
      simB.step(script(t));
    }
    expect(JSON.stringify(serializeSim(simB))).toBe(JSON.stringify(serializeSim(simA)));
  });
});
