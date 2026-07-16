/**
 * OnlineSession against a scripted fake socket + fake timers: cold-start
 * hint timing, the 60s unreachable timeout, per-error copy, host-code
 * collision retry, reconnect backoff through the token window, the
 * serverRestart notice, and hostile-server input hardening.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidRoomCode, type ClientMsg, type PlayerInfo, type ServerMsg } from "@emberfall/shared";
import {
  CONNECT_TIMEOUT_MS, OnlineSession, RECONNECT_WINDOW_MS, SLOW_CONNECT_MS,
  validateServerMsg, type TokenStore, type WsLike,
} from "./session.js";

class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void { this.sent.push(data); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  // test controls
  open(): void { this.onopen?.(); }
  receive(m: ServerMsg | Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(m) }); }
  receiveRaw(data: unknown): void { this.onmessage?.({ data }); }
  drop(): void { this.closed = true; this.onclose?.(); }
  lastMsg(): ClientMsg { return JSON.parse(this.sent[this.sent.length - 1]) as ClientMsg; }
}

const memStore = (): TokenStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    get: (r) => map.get(r) ?? null,
    set: (r, t) => void map.set(r, t),
    del: (r) => void map.delete(r),
  };
};

function harness(): { session: OnlineSession; sockets: FakeWs[]; store: ReturnType<typeof memStore> } {
  const sockets: FakeWs[] = [];
  const store = memStore();
  const session = new OnlineSession({
    url: "ws://game.test/ws",
    pageProtocol: "http:",
    wsFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    tokenStore: store,
  });
  return { session, sockets, store };
}

const PLAYERS: PlayerInfo[] = [
  { id: 0, name: "P1", charId: "knight", connected: true, ready: false, team: 0 },
  { id: 1, name: "P2", charId: "ogre", connected: true, ready: false, team: 1 },
];

const welcome = (token = "tok_a", roomCode = "ABC234"): ServerMsg =>
  ({ t: "welcome", playerId: 0, roomCode, token, tick: 0, players: PLAYERS, stageId: "emberfall_keep" });
const begin: ServerMsg = { t: "begin", tick: 10, players: PLAYERS, stageId: "emberfall_keep" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("host / join basics", () => {
  it("hostGame dials and sends a create-join with a valid generated code", () => {
    const { session, sockets } = harness();
    session.hostGame("knight");
    expect(session.phase).toBe("connecting");
    sockets[0].open();
    const join = sockets[0].lastMsg();
    if (join.t !== "join") throw new Error("expected join");
    expect(join.create).toBe(true);
    expect(isValidRoomCode(join.room ?? "")).toBe(true);
    sockets[0].receive(welcome("tok_a", join.room!));
    expect(session.phase).toBe("lobby");
    expect(session.roomCode).toBe(join.room);
  });

  it("joinGame normalizes the code and rejects a malformed one locally", () => {
    const { session, sockets } = harness();
    expect(session.joinGame("not real", "knight")).toBe(false);
    expect(session.phase).toBe("failed");
    expect(session.error?.code).toBe("bad_room_code");
    session.acknowledgeFailure();
    expect(session.phase).toBe("idle");

    expect(session.joinGame("ab-c 234", "knight")).toBe(true);
    sockets[0].open();
    const join = sockets[0].lastMsg();
    if (join.t !== "join") throw new Error("expected join");
    expect(join.room).toBe("ABC234");
    expect(join.create).toBe(false);
  });

  it("each server error lands with its own copy, inline (never a generic ERROR)", () => {
    for (const [code, needle] of [
      ["no_room", /no room/i],
      ["room_full", /full/i],
      ["room_started", /already started/i],
      ["server_full", /capacity/i],
    ] as const) {
      const { session, sockets } = harness();
      session.joinGame("ABC234", "knight");
      sockets[0].open();
      sockets[0].receive({ t: "error", code, message: "server words" });
      expect(session.phase).toBe("failed");
      expect(session.error?.code).toBe(code);
      expect(session.error?.message).toMatch(needle);
    }
  });

  it("host code collision: retries with a fresh code on the same socket", () => {
    const { session, sockets } = harness();
    session.hostGame("knight");
    sockets[0].open();
    const first = sockets[0].lastMsg();
    if (first.t !== "join") throw new Error("expected join");
    sockets[0].receive({ t: "error", code: "room_exists", message: "taken" });
    const second = sockets[0].lastMsg();
    if (second.t !== "join") throw new Error("expected second join");
    expect(second.create).toBe(true);
    expect(second.room).not.toBe(first.room);
    expect(isValidRoomCode(second.room ?? "")).toBe(true);
    sockets[0].receive(welcome("tok", second.room!));
    expect(session.phase).toBe("lobby");
  });
});

describe("cold start & timeout", () => {
  it("flags a slow dial after 3s, clears it on open", () => {
    const { session, sockets } = harness();
    session.joinGame("ABC234", "knight");
    expect(session.slowConnect).toBe(false);
    vi.advanceTimersByTime(SLOW_CONNECT_MS + 1);
    expect(session.slowConnect).toBe(true);
    sockets[0].open();
    expect(session.slowConnect).toBe(false);
  });

  it("gives up at 60s with 'unreachable'", () => {
    const { session, sockets } = harness();
    session.joinGame("ABC234", "knight");
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + 1);
    expect(session.phase).toBe("failed");
    expect(session.error?.code).toBe("unreachable");
    expect(sockets[0].closed).toBe(true);
  });

  it("refuses ws:// from an https page", () => {
    const sockets: FakeWs[] = [];
    const session = new OnlineSession({
      url: "ws://game.test/ws",
      pageProtocol: "https:",
      wsFactory: () => { const w = new FakeWs(); sockets.push(w); return w; },
      tokenStore: memStore(),
    });
    session.joinGame("ABC234", "knight");
    expect(session.phase).toBe("failed");
    expect(session.error?.code).toBe("insecure_ws");
    expect(sockets.length).toBe(0); // never even dialed
  });
});

describe("reconnect", () => {
  function playSession(): { session: OnlineSession; sockets: FakeWs[]; store: ReturnType<typeof memStore> } {
    const h = harness();
    h.session.joinGame("ABC234", "knight");
    h.sockets[0].open();
    h.sockets[0].receive(welcome());
    h.sockets[0].receive(begin);
    expect(h.session.phase).toBe("playing");
    return h;
  }

  it("an unexpected drop mid-match reconnects with the token and resumes on begin", () => {
    const { session, sockets } = playSession();
    const gen = session.beginGen;
    sockets[0].drop();
    expect(session.phase).toBe("reconnecting");

    vi.advanceTimersByTime(1001); // first backoff step
    expect(sockets.length).toBe(2);
    sockets[1].open();
    const join = sockets[1].lastMsg();
    if (join.t !== "join") throw new Error("expected join");
    expect(join.token).toBe("tok_a");
    expect(join.room).toBe("ABC234");
    expect(join.create).toBe(false);

    sockets[1].receive(welcome("tok_b")); // server rotates the token
    sockets[1].receive({ ...begin, tick: 400 });
    expect(session.phase).toBe("playing");
    expect(session.beginGen).toBe(gen + 1); // match screen rebuilds its predictor
  });

  it("backoff doubles per attempt and the window ends in reconnect_failed", () => {
    const { session, sockets } = playSession();
    sockets[0].drop();
    const dialTimes: number[] = [];
    const t0 = Date.now();

    // let every scheduled dial fail immediately; record when each fires
    // (enough 500ms steps to walk the whole 75s window + the 30s cap)
    for (let guard = 0; guard < 300 && (session.phase as string) !== "failed"; guard++) {
      const before = sockets.length;
      vi.advanceTimersByTime(500);
      if (sockets.length > before) {
        dialTimes.push(Date.now() - t0);
        sockets[sockets.length - 1].drop(); // dial refused
      }
    }
    expect(session.phase).toBe("failed");
    expect(session.error?.code).toBe("reconnect_failed");
    expect(session.error?.message).toMatch(/server restarted/i);
    // 1s, then 2s, then 4s… growth between consecutive dials
    expect(dialTimes.length).toBeGreaterThanOrEqual(3);
    expect(dialTimes[1] - dialTimes[0]).toBeGreaterThan(dialTimes[0] * 1.5);
    expect(dialTimes[dialTimes.length - 1]).toBeLessThanOrEqual(RECONNECT_WINDOW_MS + 30_000 + 1000);
  });

  it("serverRestart notice marks the drop as graceful before the socket closes", () => {
    const { session, sockets } = playSession();
    sockets[0].receive({ t: "serverRestart", reason: "deploy" });
    expect(session.serverRestarting).toBe(true);
    sockets[0].drop();
    expect(session.phase).toBe("reconnecting");
  });

  it("the room dying while away (server restarted) is terminal, not a retry loop", () => {
    const { session, sockets } = playSession();
    sockets[0].drop();
    vi.advanceTimersByTime(1001);
    sockets[1].open();
    sockets[1].receive({ t: "error", code: "no_room", message: "Room ABC234 not found" });
    expect(session.phase).toBe("failed");
    expect(session.error?.code).toBe("reconnect_failed");
  });

  it("a fresh join to the same room reuses the stored token (tab restore)", () => {
    const { store } = playSession();
    expect(store.map.get("ABC234")).toBe("tok_a");

    const sockets2: FakeWs[] = [];
    const session2 = new OnlineSession({
      url: "ws://game.test/ws", pageProtocol: "http:",
      wsFactory: () => { const w = new FakeWs(); sockets2.push(w); return w; },
      tokenStore: store,
    });
    session2.joinGame("ABC234", "knight");
    sockets2[0].open();
    const join = sockets2[0].lastMsg();
    if (join.t !== "join") throw new Error("expected join");
    expect(join.token).toBe("tok_a");
  });

  it("leave() tells the server, burns the stored token and returns to idle", () => {
    const { session, sockets, store } = playSession();
    session.leave();
    const msgs = sockets[0].sent.map((s) => JSON.parse(s) as ClientMsg);
    expect(msgs.some((m) => m.t === "leave")).toBe(true);
    expect(store.map.has("ABC234")).toBe(false);
    expect(session.phase).toBe("idle");
    expect(sockets[0].closed).toBe(true);
  });
});

describe("hostile server hardening", () => {
  it("malformed frames are dropped without crashing the session", () => {
    const { session, sockets } = harness();
    session.joinGame("ABC234", "knight");
    sockets[0].open();
    sockets[0].receiveRaw("not json {{{");
    sockets[0].receive({ t: "welcome" }); // missing every field
    sockets[0].receive({ t: "nonsense", x: 1 });
    sockets[0].receiveRaw(12345);
    expect(session.phase).toBe("connecting"); // unmoved
    sockets[0].receive(welcome());
    expect(session.phase).toBe("lobby"); // still fully functional
  });

  it("validateServerMsg rejects wrong shapes and accepts real ones", () => {
    expect(validateServerMsg(null)).toBeNull();
    expect(validateServerMsg({ t: "welcome", playerId: "0" })).toBeNull();
    expect(validateServerMsg({ t: "snapshot", snap: null, lastInput: 1, events: [] })).toBeNull();
    expect(validateServerMsg({ t: "gameOver", winners: [0, "1"] })).toBeNull();
    expect(validateServerMsg({ t: "serverRestart", reason: 7 })).toBeNull();
    expect(validateServerMsg(welcome())).not.toBeNull();
    expect(validateServerMsg({ t: "snapshot", snap: {}, lastInput: 1, events: [] })).not.toBeNull();
    expect(validateServerMsg({ t: "gameOver", winners: [0] })).not.toBeNull();
  });

  it("snapshots arriving before the match screen taps in are buffered, not lost", () => {
    const { session, sockets } = harness();
    session.joinGame("ABC234", "knight");
    sockets[0].open();
    sockets[0].receive(welcome());
    sockets[0].receive(begin);
    sockets[0].receive({ t: "snapshot", snap: { tick: 12 }, lastInput: 11, events: [] } as Record<string, unknown>);
    sockets[0].receive({ t: "snapshot", snap: { tick: 15 }, lastInput: 14, events: [] } as Record<string, unknown>);
    const drained = session.drainSnapshots();
    expect(drained.length).toBe(2);
    expect(session.drainSnapshots().length).toBe(0);
  });
});
