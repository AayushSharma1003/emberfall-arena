/**
 * Regression suite for the verified core sim mechanics.
 * These lock the Phase-0 behavior (movement, jumps, dash, knockback formula,
 * hitstun/hitstop, ring-outs, body collision, projectiles) so later phases
 * can extend the sim without silently changing feel.
 *
 * Uses the Knight (all multipliers 1.0-ish, aimed moves) as the reference
 * fighter — per-character behavior is covered in characters.test.ts.
 */
import { describe, expect, it } from "vitest";
import { TUNING, type SimEvent } from "./sim.js";
import { Btn, N, frame, makeSim, place, settle, steps, stepUntil } from "./testutil.js";

describe("movement", () => {
  it("running caps at runSpeed*speedMult and stops via friction", () => {
    const { sim, a } = makeSim();
    settle(sim);
    steps(sim, 30, [frame(Btn.Right)]);
    expect(a.vx).toBeCloseTo(TUNING.runSpeed * a.stats.speedMult, 0);
    steps(sim, 60);
    expect(a.vx).toBe(0);
  });

  it("facing follows movement direction", () => {
    const { sim, a } = makeSim();
    settle(sim);
    steps(sim, 5, [frame(Btn.Left)]);
    expect(a.facing).toBe(-1);
    steps(sim, 5, [frame(Btn.Right)]);
    expect(a.facing).toBe(1);
  });
});

describe("jumping", () => {
  it("ground jump sets jump velocity and consumes first jump", () => {
    const { sim, a } = makeSim();
    settle(sim);
    steps(sim, 1, [frame(Btn.Jump)]);
    expect(a.vy).toBeLessThan(0);
    expect(a.jumpsUsed).toBe(1);
    expect(a.grounded).toBe(false);
  });

  it("double jump works once, further presses do nothing", () => {
    const { sim, a } = makeSim();
    settle(sim);
    steps(sim, 1, [frame(Btn.Jump)]);
    steps(sim, 10);
    steps(sim, 1, [frame(Btn.Jump)]);
    expect(a.jumpsUsed).toBe(2);
    expect(a.vy).toBeLessThan(0);
    steps(sim, 3);
    steps(sim, 1, [frame(Btn.Jump)]); // no jumps left (knight jumpCount = 2)
    expect(a.jumpsUsed).toBe(2);
  });

  it("releasing jump early cuts upward velocity (variable height)", () => {
    const runJump = (holdTicks: number): number => {
      const { sim, a } = makeSim();
      settle(sim);
      let minY = a.y;
      for (let t = 0; t < 60; t++) {
        steps(sim, 1, [frame(t < holdTicks ? Btn.Jump : 0)]);
        minY = Math.min(minY, a.y);
      }
      return minY;
    };
    const shortHop = runJump(2);
    const fullJump = runJump(40);
    expect(fullJump).toBeLessThan(shortHop - 60); // full jump goes much higher
  });

  it("coyote time allows a ground jump shortly after walking off a ledge", () => {
    const { sim, a } = makeSim();
    settle(sim, 1430, 1100); // near right edge of main platform (460..1460)
    steps(sim, 10, [frame(Btn.Right)]); // walk off
    expect(a.grounded).toBe(false);
    steps(sim, 2);
    steps(sim, 1, [frame(Btn.Jump)]);
    expect(a.jumpsUsed).toBe(1); // ground jump, not double jump
    expect(a.vy).toBeLessThan(-1000);
  });

  it("jump buffer fires a buffered jump on landing", () => {
    const { sim, a } = makeSim();
    settle(sim);
    steps(sim, 1, [frame(Btn.Jump)]);
    steps(sim, 8);
    steps(sim, 1, [frame(Btn.Jump)]);
    expect(a.jumpsUsed).toBe(2); // both jumps spent
    steps(sim, 3); // release the button so the next press registers as an edge
    place(a, 800, 770); // just above the main platform
    a.vy = 900;
    steps(sim, 1, [frame(Btn.Jump)]); // buffered while airborne with no jumps left
    // button is released by the time the jump fires — since the Phase B fix
    // this must still be a FULL jump, not an accidental jump-cut short hop
    const t = stepUntil(sim, () => a.vy < -1000, 10);
    expect(t).toBeGreaterThan(0); // buffered jump fired right after landing
    expect(a.jumpsUsed).toBe(1); // and it was a fresh ground jump
  });

  it("down+jump drops through a soft platform", () => {
    const { sim, a } = makeSim();
    place(a, 700, 400);
    place(sim.fighters[1], 1100, 700);
    steps(sim, 60); // land on soft platform at y=560
    expect(a.grounded).toBe(true);
    expect(a.y).toBe(560);
    steps(sim, 1, [frame(Btn.Down | Btn.Jump)]);
    const fell = stepUntil(sim, () => a.y > 600, 30, [frame(Btn.Down)]);
    expect(fell).toBeGreaterThan(0);
  });

  it("fall speed is capped, fast-fall raises the cap", () => {
    const { sim, a } = makeSim();
    place(a, 200, -400); // in the air, off-platform column
    place(sim.fighters[1], 1100, 700);
    steps(sim, 45);
    expect(a.vy).toBeCloseTo(TUNING.maxFallVel * a.stats.fallMult, 3);

    const { sim: sim2, a: a2 } = makeSim();
    place(a2, 200, -400);
    place(sim2.fighters[1], 1100, 700);
    steps(sim2, 45, [frame(Btn.Down)]);
    expect(a2.vy).toBeGreaterThan(TUNING.maxFallVel);
    expect(a2.vy).toBeCloseTo(TUNING.fastFallVel * a2.stats.fallMult, 3);
  });
});

describe("dash", () => {
  it("dash bursts at dashSpeed and suspends gravity", () => {
    const { sim, a } = makeSim();
    settle(sim);
    steps(sim, 1, [frame(Btn.Jump)]);
    steps(sim, 5);
    steps(sim, 1, [frame(Btn.Dash | Btn.Right)]);
    expect(Math.abs(a.vx)).toBeCloseTo(TUNING.dashSpeed, 0);
    // gravity applies once on the press tick (dash starts mid-tick), then freezes
    const vyDuring = a.vy;
    steps(sim, 3);
    expect(a.vy).toBe(vyDuring); // gravity suspended while the dash lasts
  });

  it("dash has a cooldown", () => {
    const { sim, a } = makeSim();
    settle(sim);
    steps(sim, 1, [frame(Btn.Dash | Btn.Right)]);
    steps(sim, TUNING.dashTicks + 2);
    steps(sim, 1, [frame(Btn.Dash | Btn.Right)]); // still on cooldown
    expect(a.dashTicks).toBe(0);
    steps(sim, TUNING.dashCooldownTicks);
    steps(sim, 1, [frame(Btn.Dash | Btn.Right)]);
    expect(a.dashTicks).toBeGreaterThan(0);
  });

  it("only one air dash per airtime, reset on landing", () => {
    const { sim, a } = makeSim();
    settle(sim);
    steps(sim, 1, [frame(Btn.Jump)]);
    steps(sim, 3);
    steps(sim, 1, [frame(Btn.Dash | Btn.Right)]);
    expect(a.airDashUsed).toBe(true);
    steps(sim, TUNING.dashTicks + 1);
    a.dashCooldown = 0; // isolate the air-dash rule from the cooldown rule
    expect(a.grounded).toBe(false);
    steps(sim, 1, [frame(Btn.Dash | Btn.Right)]);
    expect(a.dashTicks).toBe(0); // second air dash refused
    const landed = stepUntil(sim, () => a.grounded, 120);
    expect(landed).toBeGreaterThan(0);
    expect(a.airDashUsed).toBe(false); // landing resets it
  });
});

describe("combat core", () => {
  it("light attack: no hit during startup, hit in active window, exact knockback formula", () => {
    const { sim, b } = makeSim();
    settle(sim, 800, 900);
    const light = sim.fighters[0].moves.light;
    steps(sim, 1, [frame(Btn.Light, 1, 0)]);
    steps(sim, light.startupTicks - 2);
    expect(b.damage).toBe(0); // still in startup
    const t = stepUntil(sim, () => b.damage > 0, light.activeTicks + 2);
    expect(t).toBeGreaterThan(0);
    expect(b.damage).toBe(light.damage);
    // THE formula: (base + damage% * growth) / weight, direction = locked aim
    const mag = (light.baseKnockback + b.damage * light.kbGrowth) / b.stats.weight;
    expect(b.vx).toBeCloseTo(mag, 3);
    expect(b.hitstun).toBe(
      Math.round(TUNING.hitstunBase + b.damage * TUNING.hitstunGrowth) + light.hitstunBonus,
    );
  });

  it("knockback scales with damage% and divides by weight", () => {
    const { sim, b } = makeSim();
    settle(sim, 800, 900);
    const light = sim.fighters[0].moves.light;
    b.damage = 100;
    b.stats.weight = 2;
    steps(sim, 1, [frame(Btn.Light, 1, 0)]);
    stepUntil(sim, () => b.damage > 100, 20);
    const mag = (light.baseKnockback + b.damage * light.kbGrowth) / 2;
    expect(b.vx).toBeCloseTo(mag, 3);
  });

  it("knockback direction follows aim locked at press", () => {
    const { sim, b } = makeSim();
    settle(sim, 800, 900);
    const s = Math.SQRT1_2;
    steps(sim, 1, [frame(Btn.Light, s, -s)]); // aim up-forward
    stepUntil(sim, () => b.damage > 0, 20);
    expect(b.vy).toBeLessThan(0);
    expect(b.vx).toBeGreaterThan(0);
    expect(Math.abs(b.vy)).toBeCloseTo(Math.abs(b.vx), 1);
  });

  it("downward knockback on a grounded victim bounces up", () => {
    const { sim, b } = makeSim();
    settle(sim, 800, 880);
    const s = Math.SQRT1_2;
    steps(sim, 1, [frame(Btn.Light, s, s)]); // aim down-forward
    stepUntil(sim, () => b.damage > 0, 20);
    expect(b.vy).toBeLessThan(0); // reflected upward
  });

  it("hitstop freezes the whole world, then it resumes", () => {
    const { sim, b } = makeSim();
    settle(sim, 800, 900);
    stepUntil(sim, () => b.damage > 0, 20, [frame(Btn.Light, 1, 0)]);
    const bx = b.x;
    const light = sim.fighters[0].moves.light;
    steps(sim, light.hitstop); // frozen
    expect(b.x).toBe(bx);
    steps(sim, 2);
    expect(b.x).toBeGreaterThan(bx); // knockback carries it away
  });

  it("one attack hits a victim at most once", () => {
    const { sim, b } = makeSim();
    settle(sim, 800, 900);
    steps(sim, 1, [frame(Btn.Light, 1, 0)]);
    steps(sim, 30, [frame(0, 1, 0)]);
    expect(b.damage).toBe(sim.fighters[0].moves.light.damage);
  });

  it("invulnerable fighters cannot be hit", () => {
    const { sim, b } = makeSim();
    settle(sim, 800, 900);
    b.invuln = 60;
    steps(sim, 1, [frame(Btn.Light, 1, 0)]);
    steps(sim, 20);
    expect(b.damage).toBe(0);
  });

  it("getting hit cancels the victim's attack and dash", () => {
    const { sim, b } = makeSim();
    settle(sim, 800, 900);
    steps(sim, 1, [N, frame(Btn.Heavy, -1, 0)]); // b starts a slow heavy
    expect(b.attack).not.toBeNull();
    steps(sim, 1, [frame(Btn.Light, 1, 0)]); // a's fast light interrupts it
    stepUntil(sim, () => b.damage > 0, 20);
    expect(b.attack).toBeNull();
    expect(b.dashTicks).toBe(0);
  });
});

describe("stocks & ring-out", () => {
  it("crossing the blast zone costs a stock and respawns with invulnerability", () => {
    const { sim, a } = makeSim();
    settle(sim);
    a.damage = 120;
    place(a, -400, 500); // beyond the left blast zone
    steps(sim, 1);
    expect(a.state).toBe("dead");
    expect(a.stocks).toBe(2);
    const t = stepUntil(sim, () => a.state !== "dead", 90);
    expect(t).toBeGreaterThan(0);
    expect(a.damage).toBe(0);
    expect(a.invuln).toBe(TUNING.respawnInvulnTicks);
  });

  it("no respawn on last stock", () => {
    const { sim, a } = makeSim();
    settle(sim);
    a.stocks = 1;
    place(a, -400, 500);
    steps(sim, 1);
    expect(a.stocks).toBe(0);
    steps(sim, 200);
    expect(a.state).toBe("dead");
  });
});

describe("body collision", () => {
  it("overlapping fighters push apart at a capped rate until separated", () => {
    const { sim, a, b } = makeSim();
    settle(sim, 800, 900);
    place(a, 850, 780);
    place(b, 870, 780);
    steps(sim, 1);
    expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(20 + TUNING.bodyPushPerTick * 2 + 0.001);
    steps(sim, 8);
    const w = (a.stats.width + b.stats.width) / 2;
    expect(Math.abs(b.x - a.x)).toBeGreaterThanOrEqual(w - 0.5); // fully separated
  });

  it("a dashing fighter passes through bodies", () => {
    const { sim, a, b } = makeSim();
    settle(sim, 800, 900);
    steps(sim, 1, [frame(Btn.Dash | Btn.Right)]);
    const overlapTick = stepUntil(sim, () => Math.abs(a.x - b.x) < 40, TUNING.dashTicks);
    expect(overlapTick).toBeGreaterThan(0); // deep overlap happened mid-dash
    expect(a.dashTicks).toBeGreaterThan(0);
    steps(sim, 6);
    expect(a.x).toBeGreaterThan(b.x); // came out the other side
  });
});

describe("projectiles", () => {
  it("a projectile special travels along aim and applies the knockback formula", () => {
    const { sim, b } = makeSim();
    sim.setCharacter(0, "mage");
    settle(sim, 800, 1200);
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    const t = stepUntil(sim, () => b.damage > 0, 80);
    expect(t).toBeGreaterThan(0);
    const proj = sim.fighters[0].moves.special.projectile!;
    expect(b.damage).toBe(proj.damage);
    const mag = (proj.baseKnockback + b.damage * proj.kbGrowth) / b.stats.weight;
    expect(b.vx).toBeCloseTo(mag, 1); // direction = projectile travel direction
  });

  it("projectiles are blocked by solid platforms", () => {
    const { sim, b } = makeSim();
    sim.setCharacter(0, "mage");
    settle(sim);
    // fire straight down into the main platform; it dies within a tick of spawning
    const events: SimEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(...sim.step([i === 0 ? frame(Btn.Shoot, 0, 1) : N, N]));
    }
    expect(events.some((e) => e.t === "shoot")).toBe(true); // it did spawn
    expect(events.some((e) => e.t === "projdie")).toBe(true); // and hit the platform
    expect(sim.projectiles.length).toBe(0); // long before its lifeTicks expiry
    expect(b.damage).toBe(0);
  });

  it("projectiles never hit their owner and expire", () => {
    const { sim, a, b } = makeSim();
    sim.setCharacter(0, "mage");
    settle(sim, 800, 1200);
    place(b, 1200, 400); // out of the line of fire
    steps(sim, 1, [frame(Btn.Shoot, -1, 0)]); // fire away from everyone
    steps(sim, 200);
    expect(a.damage).toBe(0);
    expect(b.damage).toBe(0);
    expect(sim.projectiles.length).toBe(0); // expired
  });

  it("specials respect their cooldown", () => {
    const { sim } = makeSim();
    sim.setCharacter(0, "mage");
    settle(sim);
    const special = sim.fighters[0].moves.special;
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    stepUntil(sim, () => sim.projectiles.length === 1, 10);
    steps(sim, special.startupTicks + special.activeTicks + special.recoveryTicks + 2);
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]); // still on cooldown
    steps(sim, 10);
    expect(sim.projectiles.length).toBeLessThanOrEqual(1);
  });
});

describe("input buffering (Phase B)", () => {
  it("an attack pressed during recovery fires on the first free tick", () => {
    const { sim, a } = makeSim();
    settle(sim, 800, 1400); // victim far away — whiff
    const light = a.moves.light;
    const total = light.startupTicks + light.activeTicks + light.recoveryTicks;
    steps(sim, 1, [frame(Btn.Light, 1, 0)]); // attackTick 1
    steps(sim, total - 4); // deep in recovery, 3 ticks left
    expect(a.attack).not.toBeNull();
    steps(sim, 1, [frame(Btn.Light, 1, 0)]); // press again while busy -> buffered
    steps(sim, 2); // previous attack ends
    steps(sim, 1);
    expect(a.attack).not.toBeNull(); // chained immediately
    expect(a.attackTick).toBeLessThanOrEqual(2);
  });

  it("the attack buffer expires if pressed too early", () => {
    const { sim, a } = makeSim();
    settle(sim, 800, 1400);
    const light = a.moves.light;
    const total = light.startupTicks + light.activeTicks + light.recoveryTicks;
    steps(sim, 1, [frame(Btn.Light, 1, 0)]);
    steps(sim, 1, [frame(Btn.Light, 1, 0)]); // re-press 15+ ticks before free
    steps(sim, total + 6); // buffer (8 ticks) long dead by the time we're free
    expect(a.attack).toBeNull();
  });

  it("an attack pressed near the end of hitstun fires when hitstun ends", () => {
    const { sim, a } = makeSim();
    settle(sim, 800, 1400);
    a.hitstun = 5;
    steps(sim, 1, [frame(Btn.Light, 1, 0)]); // buffered during hitstun
    expect(a.attack).toBeNull();
    steps(sim, 6);
    expect(a.attack).not.toBeNull(); // fired as soon as hitstun released
  });

  it("a buffered special still respects its cooldown", () => {
    const { sim, a } = makeSim();
    sim.setCharacter(0, "mage");
    settle(sim, 800, 1400);
    const sp = sim.fighters[0].moves.special;
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    steps(sim, sp.startupTicks + sp.activeTicks + sp.recoveryTicks + 2);
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]); // on cooldown -> buffered, then expires
    steps(sim, 12);
    expect(a.attack).toBeNull();
    expect(sim.projectiles.length).toBeLessThanOrEqual(1);
  });
});

describe("determinism", () => {
  it("identical input sequences produce identical states", () => {
    const run = (): string => {
      const { sim } = makeSim();
      settle(sim, 800, 1000);
      const script = [
        frame(Btn.Right), frame(Btn.Right | Btn.Jump), frame(Btn.Jump),
        frame(Btn.Light, 1, 0), frame(0), frame(Btn.Dash | Btn.Left),
        frame(Btn.Shoot, 0.6, -0.8), frame(Btn.Heavy, -1, 0),
      ];
      for (let i = 0; i < 240; i++) {
        sim.step([script[i % script.length], script[(i + 3) % script.length]]);
      }
      return JSON.stringify([sim.fighters, sim.projectiles]);
    };
    expect(run()).toBe(run());
  });
});
