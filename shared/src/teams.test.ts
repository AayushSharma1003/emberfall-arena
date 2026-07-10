/**
 * 2v2 rules: team assignment, friendly-fire default (off) for melee and
 * projectiles, body push between teammates, snapshot round-trip of teams,
 * and 4-fighter determinism.
 */
import { describe, expect, it } from "vitest";
import { Btn } from "./protocol/input.js";
import { Sim, emberfallKeep } from "./sim.js";
import { serializeSim, applySimSnap } from "./snapshot.js";
import { N, frame, place, steps } from "./testutil.js";
import type { InputFrame } from "./protocol/input.js";

function fourSim(): Sim {
  const sim = new Sim(emberfallKeep());
  sim.addFighter("knight"); // team 0
  sim.addFighter("mage"); // team 1
  sim.addFighter("ranger"); // team 0
  sim.addFighter("goblin"); // team 1
  return sim;
}

describe("2v2 teams", () => {
  it("teams alternate by default and can be set explicitly", () => {
    const sim = fourSim();
    expect(sim.fighters.map((f) => f.team)).toEqual([0, 1, 0, 1]);
    const sim2 = new Sim(emberfallKeep());
    sim2.addFighter("knight", 1);
    expect(sim2.fighters[0].team).toBe(1);
  });

  it("melee cannot hit a teammate (friendly fire off by default)", () => {
    const sim = fourSim();
    const [a, , c] = sim.fighters; // a and c are team 0
    place(a, 800, 700); place(c, 900, 700);
    place(sim.fighters[1], 1300, 700); place(sim.fighters[3], 1400, 700);
    steps(sim, 30);
    steps(sim, 1, [frame(Btn.Light, 1, 0), N, N, N]); // a swings right through c
    steps(sim, 20);
    expect(c.damage).toBe(0);
  });

  it("melee still hits enemies standing in the same spot", () => {
    const sim = fourSim();
    const [a, b] = sim.fighters; // enemy teams
    place(a, 800, 700); place(b, 900, 700);
    place(sim.fighters[2], 1300, 700); place(sim.fighters[3], 1400, 700);
    steps(sim, 30);
    steps(sim, 1, [frame(Btn.Light, 1, 0), N, N, N]);
    steps(sim, 20);
    expect(b.damage).toBeGreaterThan(0);
  });

  it("projectiles pass through teammates and hit enemies", () => {
    const sim = fourSim();
    const [a, b, c] = sim.fighters;
    // teammate c stands between shooter a and enemy b
    place(a, 700, 700); place(c, 900, 700); place(b, 1200, 700);
    place(sim.fighters[3], 1400, 700);
    steps(sim, 30);
    sim.setCharacter(0, "mage"); // straight bolt
    steps(sim, 1, [frame(Btn.Shoot, 1, 0), N, N, N]);
    steps(sim, 60);
    expect(c.damage).toBe(0); // flew through the teammate
    expect(b.damage).toBeGreaterThan(0); // hit the enemy behind them
  });

  it("friendlyFire flag turns teammate damage back on", () => {
    const sim = fourSim();
    sim.friendlyFire = true;
    const [a, , c] = sim.fighters;
    place(a, 800, 700); place(c, 900, 700);
    place(sim.fighters[1], 1300, 700); place(sim.fighters[3], 1400, 700);
    steps(sim, 30);
    steps(sim, 1, [frame(Btn.Light, 1, 0), N, N, N]);
    steps(sim, 20);
    expect(c.damage).toBeGreaterThan(0);
  });

  it("teammates still body-push each other (no stacking inside one hurtbox)", () => {
    const sim = fourSim();
    const [a, , c] = sim.fighters;
    place(a, 850, 780); place(c, 860, 780);
    place(sim.fighters[1], 1300, 700); place(sim.fighters[3], 1400, 700);
    steps(sim, 12);
    const minSep = (a.stats.width + c.stats.width) / 2;
    expect(Math.abs(c.x - a.x)).toBeGreaterThanOrEqual(minSep - 0.5);
  });

  it("team survives in snapshot round-trips", () => {
    const sim = fourSim();
    steps(sim, 10);
    const wire = JSON.parse(JSON.stringify(serializeSim(sim)));
    const sim2 = fourSim();
    applySimSnap(sim2, wire);
    expect(sim2.fighters.map((f) => f.team)).toEqual([0, 1, 0, 1]);
    expect(JSON.stringify(serializeSim(sim2))).toBe(JSON.stringify(serializeSim(sim)));
  });

  it("4-fighter chaos is deterministic and finite", () => {
    const script = (t: number, i: number): InputFrame => {
      const p = (t + i * 31) % 90;
      if (p < 25) return frame(i % 2 === 0 ? Btn.Right : Btn.Left);
      if (p === 30) return frame(Btn.Jump);
      if (p === 40) return frame(Btn.Light, i % 2 === 0 ? 1 : -1, 0);
      if (p === 55) return frame(Btn.Shoot, 0.7, -0.7);
      if (p === 70) return frame(Btn.Dash | Btn.Right);
      return N;
    };
    const run = (): string => {
      const sim = fourSim();
      for (let t = 0; t < 400; t++) {
        sim.step(sim.fighters.map((_, i) => script(t, i)));
      }
      return JSON.stringify(serializeSim(sim));
    };
    const a = run();
    expect(a).toBe(run());
    const parsed = JSON.parse(a);
    for (const f of parsed.fighters) {
      expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
    }
  });
});
