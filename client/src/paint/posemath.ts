/**
 * Pure pose math for the painterly rig system. NO Pixi, NO DOM — everything
 * here is unit-tested headlessly (posemath.test.ts), and rig.ts is a thin
 * Pixi skin over these numbers.
 *
 * Conventions: angles in radians, 0 = pointing down the +x axis, positive =
 * clockwise on screen (Pixi's convention, y-down). A "pose" is a flat record
 * of named joint angles/offsets; poses interpolate channel-wise.
 */

// ---------- easing ----------
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const easeInCubic = (t: number): number => t ** 3;
export const easeInOutSine = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * t);
/** Snappy attack easing: overshoots slightly then settles (reads as impact). */
export const easeOutBack = (t: number, s = 1.4): number => {
  const u = t - 1;
  return 1 + u * u * ((s + 1) * u + s);
};
export const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

/** Shortest-arc interpolation between two angles (never spins the long way). */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ---------- poses ----------
/** A pose: named channels. `*_a` channels are angles (shortest-arc lerped). */
export type Pose = Record<string, number>;

/** Channel-wise pose interpolation; angle channels (suffix `_a`) take the short way. */
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const out: Pose = {};
  for (const k of Object.keys(a)) {
    const av = a[k];
    const bv = b[k] ?? av;
    out[k] = k.endsWith("_a") ? lerpAngle(av, bv, t) : lerp(av, bv, t);
  }
  // channels only present in b appear at full strength (rare, but no popping)
  for (const k of Object.keys(b)) if (!(k in out)) out[k] = b[k];
  return out;
}

/**
 * Exponential smoothing factor that is FRAME-RATE INDEPENDENT: the classic
 * `1 - exp(-rate*dt)`. rate ~ 8 = soft, ~ 20 = tight.
 */
export function smoothing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Smooth a whole pose toward a target (exponential, frame-rate independent). */
export function smoothPose(cur: Pose, target: Pose, rate: number, dt: number): Pose {
  return lerpPose(cur, target, smoothing(rate, dt));
}

// ---------- cyclic drivers ----------
/**
 * Breathing oscillator: slow sine with a softer exhale (asymmetric), 0..1.
 * `t` in seconds; period ~3.6s reads as calm.
 */
export function breathe(t: number, period = 3.6): number {
  const p = (t % period) / period;
  const s = Math.sin(p * Math.PI * 2);
  return 0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** 0.8;
}

/**
 * Run-cycle phase driver: given distance travelled (px) and stride length,
 * returns cycle phase 0..1. Distance-driven so foot speed matches ground
 * speed at ANY velocity (no ice-skating).
 */
export function runPhase(distance: number, stride: number): number {
  const p = (distance / stride) % 1;
  return p < 0 ? p + 1 : p;
}

/** Leg swing angle for a run cycle: phase 0..1 -> radians, ±swing. */
export function legSwing(phase: number, swing: number): number {
  return Math.sin(phase * Math.PI * 2) * swing;
}

// ---------- attack animation timing ----------
export type AttackPhase = "windup" | "strike" | "recover";

/**
 * Split an attack's tick timeline into windup/strike/recover with local
 * 0..1 progress. Drives anticipation (ease-in back-swing), the hit (fast
 * overshoot swing), and the follow-through (ease back to stance).
 */
export function attackPhase(
  attackTick: number,
  startup: number,
  active: number,
  recovery: number,
): { phase: AttackPhase; t: number } {
  if (attackTick < startup) {
    return { phase: "windup", t: clamp01(startup <= 1 ? 1 : attackTick / (startup - 1)) };
  }
  if (attackTick < startup + active) {
    return { phase: "strike", t: clamp01(active <= 1 ? 1 : (attackTick - startup) / (active - 1)) };
  }
  return { phase: "recover", t: clamp01(recovery <= 1 ? 1 : (attackTick - startup - active) / (recovery - 1)) };
}

// ---------- cloth / cape ----------
/**
 * One segment of a damped hanging chain (capes, hoods, plumes). Each segment
 * eases toward "hanging below its parent, blown by velocity" with spring
 * damping — cheap secondary motion that never explodes.
 */
export interface ClothSegment {
  angle: number; // current world angle (radians, 0 = down... stored as offset from rest)
  vel: number; // angular velocity
}

export interface ClothParams {
  stiffness: number; // spring toward rest (per second^2) ~ 30..80
  damping: number; // velocity decay (per second) ~ 4..10
  windScale: number; // how much carrier vx tilts the cloth ~ 0.0005..0.002
  maxAngle: number; // clamp (radians)
}

export function makeChain(n: number): ClothSegment[] {
  return Array.from({ length: n }, () => ({ angle: 0, vel: 0 }));
}

/**
 * Advance the chain one frame. `carrierVx` tilts the rest pose (running
 * makes the cape stream behind), `carrierVy` adds lift when falling.
 * Returns the same array, mutated (hot path, zero allocation).
 */
export function stepChain(
  chain: ClothSegment[],
  carrierVx: number,
  carrierVy: number,
  p: ClothParams,
  dt: number,
): ClothSegment[] {
  // rest angle: streams opposite to horizontal motion, lifts when falling
  const rest = Math.max(
    -p.maxAngle,
    Math.min(p.maxAngle, -carrierVx * p.windScale + Math.min(0, -carrierVy * p.windScale * 0.6)),
  );
  let parentAngle = rest;
  for (let i = 0; i < chain.length; i++) {
    const seg = chain[i];
    // deeper segments lag more (softer spring), which gives the S-curve flow
    const k = p.stiffness / (1 + i * 0.7);
    const accel = (parentAngle - seg.angle) * k - seg.vel * p.damping;
    seg.vel += accel * dt;
    seg.angle += seg.vel * dt;
    if (seg.angle > p.maxAngle) { seg.angle = p.maxAngle; seg.vel = 0; }
    if (seg.angle < -p.maxAngle) { seg.angle = -p.maxAngle; seg.vel = 0; }
    parentAngle = seg.angle;
  }
  return chain;
}

/** Total settle check used by tests: max |angle - rest| across the chain. */
export function chainSpread(chain: ClothSegment[]): number {
  let max = 0;
  for (let i = 1; i < chain.length; i++) {
    max = Math.max(max, Math.abs(chain[i].angle - chain[i - 1].angle));
  }
  return max;
}

// ---------- squash & stretch ----------
/**
 * Velocity-based squash/stretch for jumps and landings, capped so nothing
 * ever looks like taffy. Returns {sx, sy} multipliers.
 */
export function squashStretch(vy: number, grounded: boolean, landPulse: number): { sx: number; sy: number } {
  if (grounded) {
    // landPulse decays 1 -> 0 after touchdown: brief squash
    const s = 0.22 * landPulse;
    return { sx: 1 + s, sy: 1 - s };
  }
  const stretch = Math.min(0.18, Math.abs(vy) / 5200);
  return { sx: 1 - stretch, sy: 1 + stretch };
}
