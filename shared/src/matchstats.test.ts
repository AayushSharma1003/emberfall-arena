import { describe, expect, it } from "vitest";
import { MatchStatsTracker, mvpScore } from "./matchstats.js";
import type { SimEvent } from "./sim.js";
import { Btn, frame, makeSim, N, settle, stepUntil } from "./testutil.js";

const hit = (attacker: number, victim: number, damage: number): SimEvent =>
  ({ t: "hit", attacker, victim, damage, heavy: false, x: 0, y: 0, kx: 0, ky: 0 });
const ringout = (id: number): SimEvent => ({ t: "ringout", id, x: 0, y: 0 });

describe("MatchStatsTracker", () => {
  it("credits direct hits to the attacker and KOs to the last hitter", () => {
    const t = new MatchStatsTracker(2);
    t.consume([hit(0, 1, 12)], [0, 12]);
    t.consume([ringout(1)], [0, 0]);
    expect(t.tallies[0].damageDealt).toBe(12);
    expect(t.tallies[0].kos).toBe(1);
    expect(t.tallies[1].falls).toBe(1);
  });

  it("KO credit clears on ring-out: a later solo fall credits nobody", () => {
    const t = new MatchStatsTracker(2);
    t.consume([hit(0, 1, 10), ringout(1)], [0, 0]);
    t.consume([ringout(1)], [0, 0]); // self-destruct on the next stock
    expect(t.tallies[0].kos).toBe(1);
    expect(t.tallies[1].falls).toBe(2);
  });

  it("hazard hits (attacker -1) neither crash nor credit, but a prior hitter keeps KO credit", () => {
    const t = new MatchStatsTracker(2);
    t.consume([hit(-1, 1, 14)], [0, 14]); // pure hazard fall: no credit
    t.consume([ringout(1)], [0, 0]);
    expect(t.tallies[0].kos).toBe(0);

    t.consume([hit(0, 1, 8)], [0, 8]);
    t.consume([hit(-1, 1, 14)], [0, 22]); // hazard finishes what player 0 started
    t.consume([ringout(1)], [0, 0]);
    expect(t.tallies[0].kos).toBe(1);
  });

  it("self-hits earn nothing", () => {
    const t = new MatchStatsTracker(2);
    t.consume([hit(0, 0, 18)], [18, 0]);
    expect(t.tallies[0].damageDealt).toBe(0);
    t.consume([ringout(0)], [0, 0]);
    expect(t.tallies[0].kos).toBe(0);
  });

  it("damage taken sums increases only — burn chip counts, respawn reset and heals don't", () => {
    const t = new MatchStatsTracker(1);
    t.consume([], [10]); // direct hit
    t.consume([], [11]); // burn tick, no event
    t.consume([], [0]); // respawn reset
    t.consume([], [5]); // fresh stock damage
    t.consume([], [2]); // heart heal
    t.consume([], [9]);
    expect(t.tallies[0].damageTaken).toBe(10 + 1 + 5 + 7);
  });

  it("MVP: KOs outweigh damage, falls cost, ties break low", () => {
    expect(mvpScore({ kos: 1, falls: 0, damageDealt: 0, damageTaken: 0 })).toBeGreaterThan(
      mvpScore({ kos: 0, falls: 0, damageDealt: 99, damageTaken: 0 }),
    );
    const t = new MatchStatsTracker(3);
    t.consume([hit(0, 2, 50), hit(1, 2, 50)], [0, 0, 100]);
    expect(t.mvp()).toBe(0); // identical scores -> lower id
    t.consume([hit(1, 2, 1), ringout(2)], [0, 0, 0]);
    expect(t.mvp()).toBe(1);
  });

  it("tallies a real sim exchange end-to-end", () => {
    const { sim, a, b } = makeSim();
    settle(sim, 800, 880); // inside knight light reach
    const t = new MatchStatsTracker(2);
    const atk = frame(Btn.Light, 1, 0);
    const took = stepUntilTracked(t, sim, () => b.hitstun > 0, 30, [atk, N]);
    expect(took).toBeGreaterThan(0);
    expect(t.tallies[0].damageDealt).toBe(a.moves.light.damage);
    expect(t.tallies[1].damageTaken).toBe(a.moves.light.damage);
    expect(t.tallies[1].damageDealt).toBe(0);
  });
});

/** stepUntil, but feeding every tick's events + damages through the tracker. */
function stepUntilTracked(
  t: MatchStatsTracker,
  sim: ReturnType<typeof makeSim>["sim"],
  pred: () => boolean,
  maxTicks: number,
  inputs: Parameters<typeof stepUntil>[3],
): number {
  for (let i = 1; i <= maxTicks; i++) {
    const events = sim.step(sim.fighters.map((f) => inputs?.[f.id] ?? N));
    t.consume(events, sim.fighters.map((f) => f.damage));
    if (pred()) return i;
  }
  return -1;
}
