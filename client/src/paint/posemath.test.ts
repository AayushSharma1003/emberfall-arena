/**
 * Headless coverage for the rig math: interpolation correctness, frame-rate
 * independence of the smoothing, attack-phase timing, and cloth-chain
 * stability (never explodes, always settles, streams the right way).
 */
import { describe, expect, it } from "vitest";
import {
  attackPhase, breathe, chainSpread, clamp01, easeOutBack, easeOutCubic,
  legSwing, lerpAngle, lerpPose, makeChain, runPhase, smoothing, smoothPose,
  squashStretch, stepChain, type ClothParams, type Pose,
} from "./posemath.js";

const CLOTH: ClothParams = { stiffness: 50, damping: 6, windScale: 0.001, maxAngle: 1.2 };

describe("angle lerp", () => {
  it("takes the short way across the wrap", () => {
    // 170° -> -170°: short way is +20°, through 180
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5);
    expect(Math.abs(mid)).toBeCloseTo(Math.PI, 3); // passes through ±180
    expect(lerpAngle(a, b, 0)).toBeCloseTo(a, 6);
  });

  it("is exact at the endpoints and monotone between nearby angles", () => {
    expect(lerpAngle(0.2, 0.9, 1)).toBeCloseTo(0.9, 6);
    const q = lerpAngle(0.2, 0.9, 0.25);
    const h = lerpAngle(0.2, 0.9, 0.5);
    expect(q).toBeGreaterThan(0.2);
    expect(h).toBeGreaterThan(q);
  });
});

describe("pose lerp", () => {
  it("interpolates channels, short-arcs the *_a ones", () => {
    const a = { arm_a: 3.0, x: 0 };
    const b = { arm_a: -3.0, x: 10 };
    const m = lerpPose(a, b, 0.5);
    expect(m.x).toBe(5);
    expect(Math.abs(m.arm_a)).toBeCloseTo(Math.PI, 2); // via the wrap, not through 0
  });

  it("channels present only in the target appear without popping the source", () => {
    const m = lerpPose({ x: 1 }, { x: 3, extra: 7 }, 0.5);
    expect(m.x).toBe(2);
    expect(m.extra).toBe(7);
  });
});

describe("smoothing is frame-rate independent", () => {
  it("many small steps land where few big steps land", () => {
    // smooth 0 -> 1 over one second, at 60fps vs 12fps
    let a = 0;
    for (let i = 0; i < 60; i++) a += (1 - a) * smoothing(10, 1 / 60);
    let b = 0;
    for (let i = 0; i < 12; i++) b += (1 - b) * smoothing(10, 1 / 12);
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });

  it("smoothPose converges to the target", () => {
    let p: Pose = { arm_a: 0, x: 0 };
    for (let i = 0; i < 240; i++) p = smoothPose(p, { arm_a: 1.5, x: 40 }, 12, 1 / 60);
    expect(p.arm_a).toBeCloseTo(1.5, 2);
    expect(p.x).toBeCloseTo(40, 1);
  });
});

describe("cycles", () => {
  it("breathe stays in 0..1 and has the right period", () => {
    for (let t = 0; t < 8; t += 0.05) {
      const v = breathe(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(breathe(0)).toBeCloseTo(breathe(3.6), 5);
  });

  it("runPhase is distance-driven and wraps correctly (negative too)", () => {
    expect(runPhase(0, 120)).toBe(0);
    expect(runPhase(60, 120)).toBeCloseTo(0.5, 6);
    expect(runPhase(300, 120)).toBeCloseTo(0.5, 6);
    const neg = runPhase(-30, 120);
    expect(neg).toBeGreaterThanOrEqual(0);
    expect(neg).toBeCloseTo(0.75, 6);
  });

  it("legSwing alternates sign across the half-cycle", () => {
    expect(legSwing(0.25, 0.6)).toBeCloseTo(0.6, 5);
    expect(legSwing(0.75, 0.6)).toBeCloseTo(-0.6, 5);
  });
});

describe("attack phases", () => {
  it("maps ticks onto windup/strike/recover with local progress", () => {
    // startup 6, active 4, recovery 10 (ticks 0..19)
    expect(attackPhase(0, 6, 4, 10)).toEqual({ phase: "windup", t: 0 });
    expect(attackPhase(5, 6, 4, 10)).toEqual({ phase: "windup", t: 1 });
    expect(attackPhase(6, 6, 4, 10)).toEqual({ phase: "strike", t: 0 });
    expect(attackPhase(9, 6, 4, 10)).toEqual({ phase: "strike", t: 1 });
    expect(attackPhase(10, 6, 4, 10).phase).toBe("recover");
    expect(attackPhase(19, 6, 4, 10).t).toBe(1);
  });

  it("degenerate 1-tick windows never divide by zero", () => {
    expect(attackPhase(0, 1, 1, 0).t).toBe(1);
    expect(attackPhase(1, 1, 1, 0)).toEqual({ phase: "strike", t: 1 });
    expect(Number.isFinite(attackPhase(2, 1, 1, 1).t)).toBe(true);
  });
});

describe("cloth chain", () => {
  it("hangs at rest when the carrier is still", () => {
    const chain = makeChain(4);
    for (let i = 0; i < 300; i++) stepChain(chain, 0, 0, CLOTH, 1 / 60);
    for (const seg of chain) expect(Math.abs(seg.angle)).toBeLessThan(0.01);
  });

  it("streams behind a running carrier and settles when they stop", () => {
    const chain = makeChain(4);
    for (let i = 0; i < 180; i++) stepChain(chain, 600, 0, CLOTH, 1 / 60);
    // running right (+vx) -> cape streams to the LEFT (negative tilt)
    expect(chain[0].angle).toBeLessThan(-0.3);
    for (let i = 0; i < 400; i++) stepChain(chain, 0, 0, CLOTH, 1 / 60);
    expect(Math.abs(chain[0].angle)).toBeLessThan(0.02);
    expect(chainSpread(chain)).toBeLessThan(0.02);
  });

  it("never explodes under violent oscillation (stability guard)", () => {
    const chain = makeChain(5);
    for (let i = 0; i < 600; i++) {
      const vx = i % 2 === 0 ? 1500 : -1500; // worst case: alternating every frame
      stepChain(chain, vx, -1200, CLOTH, 1 / 60);
      for (const seg of chain) {
        expect(Number.isFinite(seg.angle)).toBe(true);
        expect(Math.abs(seg.angle)).toBeLessThanOrEqual(CLOTH.maxAngle + 1e-9);
      }
    }
  });

  it("deeper segments lag the leader (the S-curve)", () => {
    const chain = makeChain(4);
    // one strong gust, then look mid-swing
    for (let i = 0; i < 10; i++) stepChain(chain, 900, 0, CLOTH, 1 / 60);
    expect(Math.abs(chain[3].angle)).toBeLessThan(Math.abs(chain[0].angle));
  });
});

describe("squash & stretch", () => {
  it("stretches on the way down, squashes on landing, and is capped", () => {
    const falling = squashStretch(1400, false, 0);
    expect(falling.sy).toBeGreaterThan(1);
    expect(falling.sx).toBeLessThan(1);
    expect(falling.sy).toBeLessThanOrEqual(1.18);
    const landed = squashStretch(0, true, 1);
    expect(landed.sy).toBeLessThan(1);
    expect(landed.sx).toBeGreaterThan(1);
    const still = squashStretch(0, true, 0);
    expect(still.sx).toBe(1);
    expect(still.sy).toBe(1);
  });
});

describe("misc", () => {
  it("easings hit their endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutBack(1)).toBeCloseTo(1, 6);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(9)).toBe(1);
  });
});
