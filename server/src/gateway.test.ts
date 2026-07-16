/**
 * The untrusted surface, end to end over real sockets: room lifecycle
 * errors, host-code collisions, clean leaves, single-use reconnect tokens,
 * schema validation closing bad clients, rate limiting, cross-room
 * isolation, and the keepalive reaper.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMsg } from "@emberfall/shared";
import { connectClient, is, isPong, startGateway, type TestGateway } from "./wstestutil.js";

type Welcome = Extract<ServerMsg, { t: "welcome" }>;
type ErrorMsg = Extract<ServerMsg, { t: "error" }>;

let gw: TestGateway;
afterEach(async () => {
  await gw?.close();
});

const join = (room: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  t: "join", name: "tester", room, charId: "knight", token: null, ...extra,
});

describe("room lifecycle", () => {
  it("host-create: welcome carries the requested code and the registry holds it", async () => {
    gw = await startGateway();
    const a = await connectClient(gw.port);
    a.send(join("QQWWEE", { create: true }));
    const w = await a.next<Welcome>(is("welcome"));
    expect(w.roomCode).toBe("QQWWEE");
    expect(w.token.length).toBeGreaterThanOrEqual(24); // crypto token, not the old timestamp scheme
    expect(gw.registry.get("QQWWEE")).toBeDefined();
  });

  it("join by code works and both sides see the 2-player lobby", async () => {
    gw = await startGateway();
    const a = await connectClient(gw.port);
    a.send(join("QQWWEE", { create: true }));
    await a.next(is("welcome"));
    const b = await connectClient(gw.port);
    b.send(join("qq-ww ee")); // normalization is server-side too
    const wb = await b.next<Welcome>(is("welcome"));
    expect(wb.playerId).toBe(1);
    const lobbyA = await a.next<Extract<ServerMsg, { t: "lobby" }>>((m) => m.t === "lobby" && m.players.length === 2);
    expect(lobbyA.players.map((p) => p.name)).toEqual(["tester", "tester"]);
  });

  it("joining a room that doesn't exist: no_room, no state change, socket stays usable", async () => {
    gw = await startGateway();
    const a = await connectClient(gw.port);
    a.send(join("ABСDEF".replace("С", "C"))); // plain ASCII ABCDEF
    const e = await a.next<ErrorMsg>(is("error"));
    expect(e.code).toBe("no_room");
    expect(gw.registry.size).toBe(0);
    a.send({ t: "ping", ts: 42 });
    expect((await a.next(isPong)).t).toBe("pong"); // not closed
  });

  it("malformed room codes are rejected server-side regardless of the client", async () => {
    gw = await startGateway();
    const a = await connectClient(gw.port);
    for (const bad of ["ABC", "ABCDEFG", "ABC10D", "......"]) {
      a.send(join(bad));
      expect((await a.next<ErrorMsg>(is("error"))).code).toBe("bad_room_code");
    }
    expect(gw.registry.size).toBe(0);
  });

  it("full room: fifth joiner gets room_full", async () => {
    gw = await startGateway();
    const a = await connectClient(gw.port);
    a.send(join("FURRM2", { create: true }));
    await a.next(is("welcome"));
    for (let i = 0; i < 3; i++) {
      const c = await connectClient(gw.port);
      c.send(join("FURRM2"));
      await c.next(is("welcome"));
    }
    const fifth = await connectClient(gw.port);
    fifth.send(join("FURRM2"));
    expect((await fifth.next<ErrorMsg>(is("error"))).code).toBe("room_full");
  });

  it("started room: late joiner gets room_started (not room_full, not a crash)", async () => {
    gw = await startGateway();
    const a = await connectClient(gw.port);
    a.send(join("G2G2G2", { create: true }));
    await a.next(is("welcome"));
    const b = await connectClient(gw.port);
    b.send(join("G2G2G2"));
    await b.next(is("welcome"));
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    await a.next(is("begin"));

    const late = await connectClient(gw.port);
    late.send(join("G2G2G2"));
    expect((await late.next<ErrorMsg>(is("error"))).code).toBe("room_started");
  });

  it("two hosts racing the same code: exactly one wins, the loser gets room_exists", async () => {
    gw = await startGateway();
    const [a, b] = await Promise.all([connectClient(gw.port), connectClient(gw.port)]);
    a.send(join("RACERM", { create: true }));
    b.send(join("RACERM", { create: true }));
    const results = await Promise.all([
      a.next((m) => m.t === "welcome" || m.t === "error"),
      b.next((m) => m.t === "welcome" || m.t === "error"),
    ]);
    const kinds = results.map((m) => m.t).sort();
    expect(kinds).toEqual(["error", "welcome"]);
    const err = results.find((m): m is ErrorMsg => m.t === "error")!;
    expect(err.code).toBe("room_exists");
    expect(gw.registry.get("RACERM")!.players.length).toBe(1);
  });

  it("clean lobby leave frees the slot; remaining player is re-welcomed with a true id", async () => {
    gw = await startGateway();
    const a = await connectClient(gw.port);
    a.send(join("REAVER", { create: true }));
    await a.next(is("welcome"));
    const b = await connectClient(gw.port);
    b.send(join("REAVER"));
    await b.next(is("welcome"));
    await a.next((m) => m.t === "lobby" && m.players.length === 2);

    a.send({ t: "leave" });
    const wb = await b.next<Welcome>(is("welcome")); // personalized re-welcome
    expect(wb.playerId).toBe(0); // b slid into the freed slot
    expect(gw.registry.get("REAVER")!.players.length).toBe(1);

    const c = await connectClient(gw.port); // the seat is genuinely open again
    c.send(join("REAVER"));
    expect((await c.next<Welcome>(is("welcome"))).playerId).toBe(1);
  });

  it("empty room expires after the grace window and the code is reusable", async () => {
    gw = await startGateway({}, { graceMs: 1000 });
    const a = await connectClient(gw.port);
    a.send(join("EXPRES", { create: true }));
    await a.next(is("welcome"));
    a.ws.terminate();
    await new Promise((r) => setTimeout(r, 30));

    gw.registry.tickAll(1_000_000);
    expect(gw.registry.get("EXPRES")).toBeDefined(); // held for reconnect
    gw.registry.tickAll(1_001_001);
    expect(gw.registry.get("EXPRES")).toBeUndefined();

    const b = await connectClient(gw.port);
    b.send(join("EXPRES", { create: true }));
    expect((await b.next<Welcome>(is("welcome"))).roomCode).toBe("EXPRES");
  });
});

describe("reconnect tokens", () => {
  async function playingPair(): Promise<{ a: ReturnType<typeof connectClient> extends Promise<infer T> ? T : never; b: typeof a; wa: Welcome }> {
    const a = await connectClient(gw.port);
    a.send(join("TQKENS", { create: true }));
    const wa = await a.next<Welcome>(is("welcome"));
    const b = await connectClient(gw.port);
    b.send(join("TQKENS"));
    await b.next(is("welcome"));
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    await a.next(is("begin"));
    await b.next(is("begin"));
    return { a, b, wa };
  }

  it("drop mid-match → peer notified; correct token resumes the same slot and rotates", async () => {
    gw = await startGateway();
    const { a, b, wa } = await playingPair();
    a.ws.terminate();
    const left = await b.next<Extract<ServerMsg, { t: "peerLeft" }>>(is("peerLeft"));
    expect(left.playerId).toBe(0);

    const a2 = await connectClient(gw.port);
    a2.send(join("TQKENS", { token: wa.token }));
    const w2 = await a2.next<Welcome>(is("welcome"));
    expect(w2.playerId).toBe(0); // same seat
    expect(w2.token).not.toBe(wa.token); // single-use: rotated
    await a2.next(is("begin")); // predictor rebuild payload
    await b.next(is("peerBack"));
  });

  it("a used (rotated) token is dead: no seat, no state leak", async () => {
    gw = await startGateway();
    const { a, wa } = await playingPair();
    a.ws.terminate();
    const a2 = await connectClient(gw.port);
    a2.send(join("TQKENS", { token: wa.token }));
    await a2.next(is("welcome"));
    a2.ws.terminate();
    await new Promise((r) => setTimeout(r, 30));

    const thief = await connectClient(gw.port);
    thief.send(join("TQKENS", { token: wa.token })); // the OLD token again
    const e = await thief.next<ErrorMsg>(is("error"));
    expect(e.code).toBe("room_started"); // fell through to a plain join on a live match
  });

  it("a wrong token can't hijack a CONNECTED player's seat", async () => {
    gw = await startGateway();
    const { wa } = await playingPair();
    const hijack = await connectClient(gw.port);
    hijack.send(join("TQKENS", { token: wa.token })); // valid token, but that seat is live
    const e = await hijack.next<ErrorMsg>(is("error"));
    expect(e.code).toBe("room_started");
  });

  it("reconnect after the room expired is rejected", async () => {
    gw = await startGateway({}, { graceMs: 10 });
    const { a, b, wa } = await playingPair();
    a.ws.terminate();
    b.ws.terminate();
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    gw.registry.tickAll(t0); // marks the room empty
    gw.registry.tickAll(t0 + 100_000); // way past the 10ms grace → freed
    expect(gw.registry.get("TQKENS")).toBeUndefined();

    const a2 = await connectClient(gw.port);
    a2.send(join("TQKENS", { token: wa.token }));
    expect((await a2.next<ErrorMsg>(is("error"))).code).toBe("no_room");
  });
});

describe("validation & abuse", () => {
  it("malformed frames close the socket without touching other clients", async () => {
    gw = await startGateway();
    const good = await connectClient(gw.port);
    good.send(join("SAFERM", { create: true }));
    await good.next(is("welcome"));

    for (const evil of [
      "not json {{{",
      JSON.stringify({ t: "join", name: 123, room: null, charId: "knight", token: null }),
      JSON.stringify({ t: "join", name: "x".repeat(100), room: null, charId: "knight", token: null }),
      JSON.stringify({ t: "input", inputs: "nope" }),
      JSON.stringify({ t: "input", inputs: new Array(9).fill({ tick: 1, buttons: 0, aimX: 0, aimY: 0 }) }),
      JSON.stringify({ t: "setChar", charId: "__proto__" }),
      JSON.stringify({ t: "totally_new_message" }),
    ]) {
      const c = await connectClient(gw.port);
      c.sendRaw(evil);
      expect(await c.closed).toBe(1008);
    }

    good.send({ t: "ping", ts: 7 }); // the good client never noticed
    expect((await good.next(isPong)).t).toBe("pong");
  });

  it("hard rate cap closes a spammer; soft cap drops without closing", async () => {
    gw = await startGateway({ rateSoft: 10, rateHard: 30 });
    const spammer = await connectClient(gw.port);
    for (let i = 0; i < 60; i++) spammer.send({ t: "ping", ts: i });
    expect(await spammer.closed).toBe(1008);

    const chatty = await connectClient(gw.port);
    for (let i = 0; i < 20; i++) chatty.send({ t: "ping", ts: i }); // over soft, under hard
    await new Promise((r) => setTimeout(r, 100));
    expect(chatty.isOpen()).toBe(true); // throttled, not executed... and not closed
  });

  it("a second join while seated is ignored — no cross-room hopping mid-game", async () => {
    gw = await startGateway();
    const a = await connectClient(gw.port);
    a.send(join("RMMAA2", { create: true }));
    const first = await a.next<Welcome>(is("welcome"));
    a.send(join("RMMBB2", { create: true })); // try to create/join a second room
    a.send({ t: "ping", ts: 1 });
    await a.next(isPong);
    expect(gw.registry.get("RMMBB2")).toBeUndefined(); // never created
    expect(gw.registry.get("RMMAA2")!.players.length).toBe(1);
    expect(first.roomCode).toBe("RMMAA2");
  });

  it("inputs from one room can never reach another room's sim", async () => {
    gw = await startGateway();
    // room 1 playing
    const a = await connectClient(gw.port);
    a.send(join("SEMANE", { create: true }));
    await a.next(is("welcome"));
    const b = await connectClient(gw.port);
    b.send(join("SEMANE"));
    await b.next(is("welcome"));
    a.send({ t: "ready", ready: true });
    b.send({ t: "ready", ready: true });
    await a.next(is("begin"));
    // outsider in their own lobby
    const evil = await connectClient(gw.port);
    evil.send(join("SEMTWQ", { create: true }));
    await evil.next(is("welcome"));
    evil.send({ t: "input", inputs: [{ tick: 5, buttons: 0xff, aimX: 1, aimY: 0 }] });
    await new Promise((r) => setTimeout(r, 50));
    const room1 = gw.registry.get("SEMANE")!;
    expect(room1.players.every((p) => p.lastInputTick === -1)).toBe(true); // untouched
  });

  it("connection cap: the client over the cap gets server_full and is closed", async () => {
    gw = await startGateway({ maxConns: 2 });
    const a = await connectClient(gw.port);
    const b = await connectClient(gw.port);
    const c = await connectClient(gw.port);
    const e = await c.next<ErrorMsg>(is("error"));
    expect(e.code).toBe("server_full");
    expect(await c.closed).toBe(1013);
    expect(a.isOpen() && b.isOpen()).toBe(true);
  });

  it("room cap: create beyond maxRooms answers server_full", async () => {
    gw = await startGateway({}, { maxRooms: 1 });
    const a = await connectClient(gw.port);
    a.send(join("QNYRM2", { create: true }));
    await a.next(is("welcome"));
    const b = await connectClient(gw.port);
    b.send(join("SECQND", { create: true }));
    expect((await b.next<ErrorMsg>(is("error"))).code).toBe("server_full");
  });

  it("keepalive reaper terminates a socket that never answers pings", async () => {
    gw = await startGateway({ pingIntervalMs: 25, maxMissedPongs: 2 });
    const mute = await connectClient(gw.port, { autoPong: false });
    const code = await Promise.race([
      mute.closed,
      new Promise<number>((r) => setTimeout(() => r(-1), 1500)),
    ]);
    expect(code).not.toBe(-1); // reaped (1006 abnormal close from terminate)
  });
});
