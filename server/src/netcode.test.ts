/**
 * Netcode verification — the Phase C exit criteria.
 *
 * 1. Client/server determinism through snapshot round-trips (a forgotten
 *    snapshot field shows up here as a divergence).
 * 2. Prediction + reconciliation driven through a simulated lossy, laggy,
 *    jittery link (Node-level netem equivalent): 80ms and 150ms one-way,
 *    5-10% loss, ±jitter. Asserts convergence, bounded correction error,
 *    and exact final agreement between predicted and authoritative state.
 * 3. Lag-compensated hit rewind: a hit that whiffs against live positions
 *    lands when the attacker's latency rewind is applied — at sim level
 *    (hook contract) and at room level (history + latency wiring).
 */
import { describe, expect, it } from "vitest";
import {
  Btn, Sim, emberfallKeep, serializeSim, applySimSnap, Predictor,
  type InputFrame, type ServerMsg, type SimSnap, type TickInput,
} from "@emberfall/shared";
import { Room } from "./room.js";

const N: InputFrame = { buttons: 0, aimX: 0, aimY: 0 };
const frame = (buttons: number, aimX = 0, aimY = 0): InputFrame => ({ buttons, aimX, aimY });

/** Deterministic PRNG so "random" loss/jitter is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scripted input: deterministic function of tick — runs, jumps, attacks. */
function script(tick: number): InputFrame {
  const phase = tick % 120;
  if (phase < 30) return frame(Btn.Right);
  if (phase < 34) return frame(Btn.Right | Btn.Jump);
  if (phase < 50) return frame(Btn.Right);
  if (phase === 52) return frame(Btn.Light, 1, 0);
  if (phase < 80) return frame(Btn.Left);
  if (phase === 90) return frame(Btn.Dash | Btn.Left);
  if (phase === 100) return frame(Btn.Heavy, -0.7, -0.7);
  return N;
}

describe("client/server determinism", () => {
  it("snapshot round-trip preserves every bit of sim state", () => {
    const mk = (): Sim => {
      const s = new Sim(emberfallKeep());
      s.addFighter("mage");
      s.addFighter("ogre");
      return s;
    };
    const server = mk();
    const inputsAt = (t: number): InputFrame[] => [script(t), script(t + 37)];
    for (let i = 0; i < 100; i++) server.step(inputsAt(server.tick + 1));

    // wire-transfer the snapshot (JSON clone) into a fresh client sim
    const wire = JSON.parse(JSON.stringify(serializeSim(server))) as SimSnap;
    const client = mk();
    applySimSnap(client, wire);
    expect(JSON.stringify(serializeSim(client))).toBe(JSON.stringify(serializeSim(server)));

    // both proceed with identical inputs -> must stay byte-identical
    for (let i = 0; i < 300; i++) {
      server.step(inputsAt(server.tick + 1));
      client.step(inputsAt(client.tick + 1));
      if (i % 60 === 0) {
        expect(JSON.stringify(serializeSim(client))).toBe(JSON.stringify(serializeSim(server)));
      }
    }
    expect(JSON.stringify(serializeSim(client))).toBe(JSON.stringify(serializeSim(server)));
  });
});

// ---------------------------------------------------------------------------
// latency / loss harness
// ---------------------------------------------------------------------------

interface LinkOpts {
  delayTicks: number;
  jitterTicks: number;
  dropRate: number;
  seed: number;
}

interface HarnessResult {
  errors: number[]; // |predicted - authoritative| for own fighter at snapshot ticks
  finalDelta: number; // final position disagreement after drain
  predictor: Predictor;
  room: Room;
}

/**
 * One predicted client (player 0) talks to a Room through a lossy delayed
 * link; player 1 is a zero-latency puppet fed directly into the room.
 */
function runHarness(iterations: number, link: LinkOpts): HarnessResult {
  const rand = mulberry32(link.seed);
  const roll = (): number =>
    link.delayTicks + Math.floor(rand() * (2 * link.jitterTicks + 1)) - link.jitterTicks;

  const toServer = new Map<number, TickInput[][]>(); // deliver-at iteration -> input packets
  const toClient = new Map<number, ServerMsg[]>();

  const room = new Room("TEST");
  room.autoStart = true;
  const p0Inbox: ServerMsg[] = [];
  room.addPlayer("alice", "knight", (m) => p0Inbox.push(m));
  room.addPlayer("bob", "ranger", () => {});
  expect(room.phase).toBe("playing"); // autoStart on full
  for (const f of room.sim!.fighters) f.stocks = 99; // the match must outlive the harness

  const predictor = new Predictor(
    emberfallKeep(),
    [{ charId: "knight" }, { charId: "ranger" }],
    0, 0, link.delayTicks + 2,
  );
  for (const f of predictor.sim.fighters) f.stocks = 99;
  const predHist = new Map<number, { x: number; y: number }>();
  const errors: number[] = [];
  let prevSend: TickInput | null = null;

  const deliverAll = (i: number): void => {
    for (const packet of toServer.get(i) ?? []) room.handleInputs(0, packet);
    toServer.delete(i);
    for (const m of toClient.get(i) ?? []) {
      if (m.t === "snapshot") {
        const mine = predHist.get(m.snap.tick);
        if (mine && m.snap.tick > 150) {
          const auth = m.snap.fighters[0];
          errors.push(Math.hypot(auth.x - mine.x, auth.y - mine.y));
        }
        predictor.applySnapshot(m.snap, m.lastInput);
      }
    }
    toClient.delete(i);
  };

  for (let i = 0; i < iterations; i++) {
    deliverAll(i);

    // client predicts a tick and ships the input (packet = last 2 inputs, like the real client)
    const { toSend } = predictor.step(script(predictor.predictedTick));
    const packet = prevSend ? [prevSend, toSend] : [toSend];
    prevSend = toSend;
    if (rand() >= link.dropRate) {
      const at = i + Math.max(1, roll());
      const q = toServer.get(at) ?? [];
      q.push(packet);
      toServer.set(at, q);
    }
    predHist.set(predictor.predictedTick, {
      x: predictor.sim.fighters[0].x,
      y: predictor.sim.fighters[0].y,
    });

    // puppet player 1: zero-latency direct feed (stays mostly out of the way)
    const sim = room.sim!;
    room.handleInputs(1, [{ tick: sim.tick + 1, ...(sim.tick % 90 < 8 ? frame(Btn.Right) : N) }]);

    room.tick();

    // route captured snapshots through the lossy link
    while (p0Inbox.length) {
      const m = p0Inbox.shift()!;
      if (m.t !== "snapshot") continue;
      if (rand() < link.dropRate) continue;
      const at = i + Math.max(1, roll());
      const q = toClient.get(at) ?? [];
      q.push(m);
      toClient.set(at, q);
    }
  }

  // drain: deliver everything still in flight, then a last perfect snapshot
  for (let i = iterations; i < iterations + link.delayTicks + link.jitterTicks + 2; i++) deliverAll(i);
  const finalSnap = serializeSim(room.sim!);
  predictor.applySnapshot(JSON.parse(JSON.stringify(finalSnap)) as SimSnap, finalSnap.tick);
  // the predictor is still `lead` ticks ahead on inputs the server never saw:
  // hand the server exactly those inputs and let it catch up — the two sims
  // must then agree EXACTLY (same code, same inputs, same state)
  room.handleInputs(0, [...predictor.pendingInputs]);
  while (room.sim!.tick < predictor.predictedTick) room.tick();
  const finalDelta = Math.hypot(
    predictor.sim.fighters[0].x - room.sim!.fighters[0].x,
    predictor.sim.fighters[0].y - room.sim!.fighters[0].y,
  );

  return { errors, finalDelta, predictor, room };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

describe("prediction + reconciliation under simulated network conditions", () => {
  it("80ms one-way, 5% loss, ±2 ticks jitter: prediction converges", () => {
    const { errors, predictor, room } = runHarness(900, {
      delayTicks: 5, jitterTicks: 2, dropRate: 0.05, seed: 1234,
    });
    expect(errors.length).toBeGreaterThan(100);
    // most snapshots agree with what we predicted (same sim, same inputs)
    expect(median(errors)).toBeLessThan(2);
    // every correction is bounded — no runaway divergence
    expect(Math.max(...errors)).toBeLessThan(600);
    // state stays finite and sane
    for (const f of predictor.sim.fighters) {
      expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
    }
    expect(room.sim!.fighters.every((f) => Number.isFinite(f.x))).toBe(true);
  });

  it("150ms one-way, 10% loss, ±3 ticks jitter: still bounded, still converges", () => {
    const { errors, predictor } = runHarness(900, {
      delayTicks: 9, jitterTicks: 3, dropRate: 0.10, seed: 777,
    });
    expect(errors.length).toBeGreaterThan(80);
    expect(median(errors)).toBeLessThan(12);
    expect(Math.max(...errors)).toBeLessThan(900);
    expect(Number.isFinite(predictor.sim.fighters[0].x)).toBe(true);
  });

  it("after the link drains, predicted state equals authoritative state", () => {
    const { finalDelta, predictor, room } = runHarness(600, {
      delayTicks: 5, jitterTicks: 1, dropRate: 0.05, seed: 42,
    });
    // once the server has seen every input, prediction and authority agree exactly
    expect(finalDelta).toBeLessThanOrEqual(1e-6);
    expect(predictor.sim.fighters[0].damage).toBe(room.sim!.fighters[0].damage);
    expect(predictor.sim.fighters[0].stocks).toBe(room.sim!.fighters[0].stocks);
  });
});

// ---------------------------------------------------------------------------
// lag-compensated hit rewind
// ---------------------------------------------------------------------------

describe("lag compensation", () => {
  it("sim honors the hitRewind hook for melee resolution", () => {
    const run = (useRewind: boolean): number => {
      const sim = new Sim(emberfallKeep());
      const atk = sim.addFighter("knight");
      const vic = sim.addFighter("knight");
      // settle on the platform
      atk.x = 800; atk.y = 700; vic.x = 1010; vic.y = 700;
      for (let i = 0; i < 30; i++) sim.step([N, N]);
      atk.x = 800; vic.x = 1010; // out of live reach (max ~164.5 + box slack)
      if (useRewind) {
        sim.hitRewind = (_a, v) => ({
          x: 800 + 120 - v.stats.width / 2, // "8 ticks ago" the victim was in range
          y: v.y - v.stats.height,
          w: v.stats.width,
          h: v.stats.height,
        });
      }
      sim.step([frame(Btn.Light, 1, 0), N]);
      for (let i = 0; i < 15; i++) sim.step([N, N]);
      return sim.fighters[1].damage;
    };
    expect(run(false)).toBe(0); // whiffs against live position
    expect(run(true)).toBeGreaterThan(0); // lands against the rewound hurtbox
  });

  it("room history + latency wiring lands hits that would whiff live", () => {
    const runRoom = (latencyTicks: number, pressAt: number | null): { damage: number; pressTick: number } => {
      const room = new Room("LAGC");
      room.autoStart = true;
      room.addPlayer("atk", "knight", () => {});
      room.addPlayer("vic", "knight", () => {});
      const sim = room.sim!;
      room.players[0].latencyTicks = latencyTicks;
      // settle, then stand them close; victim runs away
      for (let i = 0; i < 30; i++) room.tick();
      sim.fighters[0].x = 700; sim.fighters[0].y = 780;
      sim.fighters[1].x = 790; sim.fighters[1].y = 780;

      let pressTick = -1;
      for (let i = 0; i < 120; i++) {
        const t = sim.tick + 1;
        room.handleInputs(1, [{ tick: t, ...frame(Btn.Right) }]); // victim flees
        const dist = sim.fighters[1].x - sim.fighters[0].x;
        const shouldPress = pressAt === null ? dist > 175 && dist < 205 && pressTick < 0 : t === pressAt;
        if (shouldPress) {
          pressTick = t;
          room.handleInputs(0, [{ tick: t, ...frame(Btn.Light, 1, 0) }]);
        }
        room.tick();
        if (pressTick > 0 && sim.tick > pressTick + 20) break;
      }
      return { damage: sim.fighters[1].damage, pressTick };
    };

    const withComp = runRoom(8, null);
    expect(withComp.pressTick).toBeGreaterThan(0);
    expect(withComp.damage).toBeGreaterThan(0); // rewound 8 ticks: victim was still in range

    const without = runRoom(0, withComp.pressTick); // identical schedule, no latency credit
    expect(without.damage).toBe(0); // live-position check whiffs
  });
});
