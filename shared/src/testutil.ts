/**
 * Headless test helpers. No DOM, no Pixi — sim only.
 * Reused by the core-mechanics suite and the per-character move suites.
 */
import { Btn, type InputFrame } from "./protocol/input.js";
import { Sim, emberfallKeep, type Fighter } from "./sim.js";

export const N: InputFrame = { buttons: 0, aimX: 0, aimY: 0 };

export function frame(buttons: number, aimX = 0, aimY = 0): InputFrame {
  return { buttons, aimX, aimY };
}

/** Fresh 2-fighter sim on the default stage. */
export function makeSim(): { sim: Sim; a: Fighter; b: Fighter } {
  const sim = new Sim(emberfallKeep());
  const a = sim.addFighter();
  const b = sim.addFighter();
  return { sim, a, b };
}

/** Teleport a fighter and zero its motion (test setup only). */
export function place(f: Fighter, x: number, y: number): void {
  f.x = x;
  f.y = y;
  f.vx = 0;
  f.vy = 0;
}

/** Step the sim n ticks with the given per-player inputs (defaults neutral). */
export function steps(sim: Sim, n: number, inputs: InputFrame[] = []): void {
  for (let i = 0; i < n; i++) sim.step(sim.fighters.map((f) => inputs[f.id] ?? N));
}

/**
 * Settle both fighters onto the main platform, standing apart, all timers
 * (spawn fall, coyote, etc.) run out. Returns after fighters are grounded.
 */
export function settle(sim: Sim, ax = 800, bx = 1100): void {
  place(sim.fighters[0], ax, 700);
  place(sim.fighters[1], bx, 700);
  steps(sim, 30);
  if (!sim.fighters[0].grounded || !sim.fighters[1].grounded) {
    throw new Error("settle() failed: fighters not grounded");
  }
}

/** Step until pred is true or maxTicks elapse; returns ticks taken or -1. */
export function stepUntil(
  sim: Sim,
  pred: () => boolean,
  maxTicks: number,
  inputs: InputFrame[] = [],
): number {
  for (let i = 1; i <= maxTicks; i++) {
    steps(sim, 1, inputs);
    if (pred()) return i;
  }
  return -1;
}

export { Btn };
