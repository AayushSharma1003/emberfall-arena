/**
 * Full online round-trip against a real server on an ephemeral port:
 * host creates, friend joins, both ready, the match starts and ticks,
 * one side drops and the other is told, the dropper reconnects with the
 * token and the match resumes with state intact. The whole Step-4 smoke
 * flow, headless.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerMsg, SimSnap } from "@emberfall/shared";
import { connectClient, is, startGateway, type Cli, type TestGateway } from "./wstestutil.js";

type Welcome = Extract<ServerMsg, { t: "welcome" }>;
type Snapshot = Extract<ServerMsg, { t: "snapshot" }>;

let gw: TestGateway;
let ticker: ReturnType<typeof setInterval>;

beforeEach(async () => {
  gw = await startGateway();
  // fast-forward the world: one sim tick per 2ms wall clock (~8x real time)
  ticker = setInterval(() => gw.registry.tickAll(Date.now()), 2);
});

afterEach(async () => {
  clearInterval(ticker);
  await gw.close();
});

const snapTick = (m: Snapshot): number => (m.snap as SimSnap & { tick: number }).tick;

describe("two clients, one match", () => {
  it("host → join → ready → play → drop → reconnect → resume", async () => {
    // -- host + join --
    const a = await connectClient(gw.port);
    a.send({ t: "join", name: "Ash", room: "MATCH2", charId: "knight", token: null, create: true });
    const wa = await a.next<Welcome>(is("welcome"));
    expect(wa.roomCode).toBe("MATCH2");

    const b = await connectClient(gw.port);
    b.send({ t: "join", name: "Brand", room: "MATCH2", charId: "mage", token: null });
    const wb = await b.next<Welcome>(is("welcome"));
    expect(wb.playerId).toBe(1);

    // -- lobby: character change propagates, ready-up starts the match --
    b.send({ t: "setChar", charId: "ogre" });
    await a.next((m) => m.t === "lobby" && m.players[1]?.charId === "ogre");
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    const beginA = await a.next<Extract<ServerMsg, { t: "begin" }>>(is("begin"));
    const beginB = await b.next<Extract<ServerMsg, { t: "begin" }>>(is("begin"));
    expect(beginA.players.map((p) => p.charId)).toEqual(["knight", "ogre"]);
    expect(beginB.tick).toBe(beginA.tick);

    // -- the sim ticks: snapshots advance on both sides --
    const s1 = await a.next<Snapshot>(is("snapshot"));
    const s2 = await a.next<Snapshot>((m) => m.t === "snapshot" && snapTick(m as Snapshot) > snapTick(s1));
    expect(snapTick(s2)).toBeGreaterThan(snapTick(s1));
    await b.next<Snapshot>(is("snapshot"));

    // -- inputs are accepted (buffered for a future tick) --
    const now = snapTick(s2);
    a.send({ t: "input", inputs: [{ tick: now + 5, buttons: 2, aimX: 1, aimY: 0 }] });
    await a.next((m) => m.t === "snapshot" && (m as Snapshot).lastInput === now + 5, 3000);

    // -- force-drop the host: the peer hears about it, match keeps running --
    a.ws.terminate();
    await b.next(is("peerLeft"));
    // a queued pre-drop snapshot may still be in flight — wait for a LATER tick
    const bAfter = await b.next<Snapshot>((m) => m.t === "snapshot" && snapTick(m as Snapshot) > now);
    expect(snapTick(bAfter)).toBeGreaterThan(now);

    // -- reconnect with the token: same seat, fresh begin, state intact --
    const a2: Cli = await connectClient(gw.port);
    a2.send({ t: "join", name: "Ash", room: "MATCH2", charId: "knight", token: wa.token });
    const w2 = await a2.next<Welcome>(is("welcome"));
    expect(w2.playerId).toBe(0);
    expect(w2.token).not.toBe(wa.token);
    const beginAgain = await a2.next<Extract<ServerMsg, { t: "begin" }>>(is("begin"));
    expect(beginAgain.tick).toBeGreaterThan(beginA.tick); // mid-match, not a restart
    await b.next(is("peerBack"));

    // -- both keep receiving the world --
    const resumed = await a2.next<Snapshot>(is("snapshot"));
    expect(snapTick(resumed)).toBeGreaterThanOrEqual(snapTick(bAfter));
    expect((resumed.snap as SimSnap & { fighters: unknown[] }).fighters).toHaveLength(2);
  }, 15_000);
});
