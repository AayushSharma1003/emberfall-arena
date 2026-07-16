/**
 * OnlineSession: the whole client side of the online flow as one headless
 * state machine — connect (with cold-start detection), host/join, lobby
 * state, match hand-off, reconnect with exponential backoff, clean leave.
 *
 * No Pixi, no DOM beyond WebSocket (injectable) and timers, so every path
 * is testable with a fake socket and fake clocks. Screens read the public
 * fields each frame and register the few push handlers they need.
 *
 * Trust nothing from the server either: a malformed frame is dropped, not
 * crashed on — see validateServerMsg.
 */
import {
  generateRoomCode, isValidRoomCode, normalizeRoomCode,
  type CharId, type ClientMsg, type ErrorCode, type PlayerInfo, type ServerMsg, type TickInput,
} from "@emberfall/shared";

// -- socket abstraction (tests inject a fake) --------------------------------

export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type WsFactory = (url: string) => WsLike;

const realWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

// -- session-level error copy (keyed off ErrorCode, never the message) -------

export type SessionErrorCode = ErrorCode | "unreachable" | "insecure_ws" | "reconnect_failed";

export interface SessionError {
  code: SessionErrorCode;
  message: string;
}

/** Every error gets its own copy — the spec bans a generic ERROR screen online. */
export function errorCopy(code: SessionErrorCode, serverMessage?: string): string {
  switch (code) {
    case "no_room": return "No room with that code — check it with your host.";
    case "room_full": return "That room is already full.";
    case "room_started": return "That match has already started without you.";
    case "bad_room_code": return "Room codes are 6 letters and digits.";
    case "room_exists": return "Code collision — try hosting again.";
    case "server_full": return "The server is at capacity. Try again in a minute.";
    case "unreachable": return "Couldn't reach the server. Check your connection and retry.";
    case "insecure_ws": return "Refusing an unencrypted connection from a secure page.";
    case "reconnect_failed": return "Match ended — server restarted, sorry about that.";
    case "bad_msg": return serverMessage ?? "The server rejected a message.";
    default: return serverMessage ?? "Something went wrong.";
  }
}

// -- timings ------------------------------------------------------------------

export const SLOW_CONNECT_MS = 3_000; // beyond this: "waking up the server…"
export const CONNECT_TIMEOUT_MS = 60_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 30_000;
export const RECONNECT_WINDOW_MS = 75_000; // ≥ server grace (60s) + slack
const HOST_CODE_RETRIES = 3;

export type SessionPhase =
  | "idle" // not connected, nothing pending
  | "connecting" // socket dialing + join in flight
  | "lobby" // welcomed, waiting/ready-up
  | "playing" // begin received
  | "reconnecting" // unexpected drop, auto-retrying
  | "failed"; // terminal: error field says why

export type BeginMsg = Extract<ServerMsg, { t: "begin" }>;
export type SnapshotMsg = Extract<ServerMsg, { t: "snapshot" }>;

const cryptoRand = (): number => {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 0x1_0000_0000;
};

export interface TokenStore {
  get(room: string): string | null;
  set(room: string, token: string): void;
  del(room: string): void;
}

/**
 * sessionStorage-backed (survives reload and same-tab restore), silent when
 * unavailable. Alongside each token it keeps an `ef_resume` marker — boot
 * reads it so a page reopened mid-match auto-rejoins its room (the URL was
 * scrubbed of ?room=, so the marker is the only way back in).
 */
export const RESUME_KEY = "ef_resume";
const defaultTokenStore: TokenStore = {
  get: (room) => { try { return sessionStorage.getItem(`ef_token_${room}`); } catch { return null; } },
  set: (room, token) => {
    try {
      sessionStorage.setItem(`ef_token_${room}`, token);
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ room, ts: Date.now() }));
    } catch { /* private mode */ }
  },
  del: (room) => {
    try {
      sessionStorage.removeItem(`ef_token_${room}`);
      const raw = sessionStorage.getItem(RESUME_KEY);
      if (raw && (JSON.parse(raw) as { room?: string }).room === room) sessionStorage.removeItem(RESUME_KEY);
    } catch { /* private mode */ }
  },
};

export interface SessionOpts {
  /** Game socket URL; defaults to same-origin /ws (wss on https). */
  url?: string;
  wsFactory?: WsFactory;
  /** Page protocol, for the wss-only production check. Defaults to location.protocol. */
  pageProtocol?: string;
  tokenStore?: TokenStore;
}

export class OnlineSession {
  phase: SessionPhase = "idle";
  /** True once a connect attempt has been dialing longer than SLOW_CONNECT_MS. */
  slowConnect = false;
  error: SessionError | null = null;

  roomCode = "";
  myId = -1;
  players: PlayerInfo[] = [];
  stageId = "emberfall_keep";
  /** Bumped on every `begin` — the match screen rebuilds its predictor when it changes. */
  beginGen = 0;
  begin: BeginMsg | null = null;
  winners: number[] | null = null;
  /** True while the drop was announced as a graceful server restart. */
  serverRestarting = false;
  reconnectAttempt = 0;

  /** Match screen taps; buffered while unset so fade-time snapshots aren't lost. */
  onSnapshot: ((m: SnapshotMsg) => void) | null = null;
  private snapshotBuf: SnapshotMsg[] = [];

  private ws: WsLike | null = null;
  private token: string | null = null;
  private charId: CharId = "knight";
  private intent: { create: boolean; code: string } | null = null;
  private hostRetries = 0;
  private wantClose = false; // deliberate close in flight — don't treat as a drop
  private reconnectSince = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  private readonly url: string;
  private readonly wsFactory: WsFactory;
  private readonly pageProtocol: string;
  private readonly tokenStore: TokenStore;

  constructor(opts: SessionOpts = {}) {
    this.pageProtocol = opts.pageProtocol ?? location.protocol;
    this.url = opts.url ?? this.defaultUrl();
    this.wsFactory = opts.wsFactory ?? realWsFactory;
    this.tokenStore = opts.tokenStore ?? defaultTokenStore;
  }

  private defaultUrl(): string {
    if (this.pageProtocol === "https:") return `wss://${location.host}/ws`;
    // vite dev serves the page on :5173 while the game server sits on :8080;
    // any other http page is the game server itself (local prod test)
    const host = location.port === "5173" ? `${location.hostname}:8080` : location.host;
    return `ws://${host}/ws`;
  }

  // -- public API -------------------------------------------------------------

  /** Host: client-generated code, retried on the (astronomical) collision. */
  hostGame(charId: CharId, code?: string): void {
    const wanted = code !== undefined ? normalizeRoomCode(code) : generateRoomCode(cryptoRand);
    if (!isValidRoomCode(wanted)) {
      this.failNow("bad_room_code");
      return;
    }
    this.charId = charId;
    this.hostRetries = 0;
    this.intent = { create: true, code: wanted };
    this.connect();
  }

  joinGame(code: string, charId: CharId): boolean {
    const norm = normalizeRoomCode(code);
    if (!isValidRoomCode(norm)) {
      this.failNow("bad_room_code");
      return false;
    }
    this.charId = charId;
    this.intent = { create: false, code: norm };
    this.connect();
    return true;
  }

  setChar(charId: CharId): void {
    this.charId = charId;
    this.send({ t: "setChar", charId });
  }

  setReady(ready: boolean): void {
    this.send({ t: "ready", ready });
  }

  sendInputs(inputs: TickInput[]): void {
    this.send({ t: "input", inputs });
  }

  /** Clean exit: tell the server, drop the token, back to idle. */
  leave(): void {
    this.send({ t: "leave" });
    if (this.roomCode) this.tokenStore.del(this.roomCode);
    this.wantClose = true;
    this.ws?.close(1000, "leaving");
    this.clearTimers();
    this.reset();
  }

  /** After a terminal failure: back to a clean idle so the UI can retry. */
  acknowledgeFailure(): void {
    if (this.phase !== "failed") return;
    this.reset();
  }

  dispose(): void {
    this.wantClose = true;
    this.ws?.close();
    this.clearTimers();
  }

  get connectedPlayers(): PlayerInfo[] {
    return this.players.filter((p) => p.connected);
  }

  get me(): PlayerInfo | undefined {
    return this.players.find((p) => p.id === this.myId);
  }

  // -- connection lifecycle ----------------------------------------------------

  private connect(): void {
    if (this.url.startsWith("ws://") && this.pageProtocol === "https:") {
      this.failNow("insecure_ws");
      return;
    }
    if (this.phase !== "reconnecting") {
      this.phase = "connecting";
      this.error = null;
      this.slowConnect = false;
    }
    this.wantClose = false;

    let ws: WsLike;
    try {
      ws = this.wsFactory(this.url);
    } catch {
      this.onDrop();
      return;
    }
    this.ws = ws;

    const dialedAt = this.timer(SLOW_CONNECT_MS, () => {
      if (this.phase === "connecting") this.slowConnect = true;
    });
    const deadline = this.timer(CONNECT_TIMEOUT_MS, () => {
      if (this.phase === "connecting") {
        this.wantClose = true;
        ws.close();
        this.failNow("unreachable");
      }
    });

    ws.onopen = () => {
      this.cancel(dialedAt);
      this.cancel(deadline);
      this.slowConnect = false;
      const room = this.intent?.code ?? this.roomCode;
      // in-memory token when auto-reconnecting; stored token when re-entering
      // the same room after a tab restore (the server ignores stale ones)
      const token = this.phase === "reconnecting" ? this.token : this.tokenStore.get(room);
      this.sendRaw({
        t: "join",
        name: "",
        room,
        charId: this.charId,
        token,
        create: this.phase !== "reconnecting" && this.intent?.create === true,
      });
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg | null = null;
      try {
        m = validateServerMsg(JSON.parse(String(ev.data)));
      } catch { /* malformed frame — drop it */ }
      if (m) {
        try {
          this.handle(m);
        } catch { /* a bad payload must never crash the client loop */ }
      }
    };
    ws.onclose = () => {
      this.cancel(dialedAt);
      this.cancel(deadline);
      if (this.ws !== ws) return; // superseded by a newer attempt
      this.ws = null;
      if (!this.wantClose) this.onDrop();
    };
    ws.onerror = () => { /* onclose always follows */ };
  }

  /** Unexpected drop (or refused dial). Reconnect if we had a seat, else fail. */
  private onDrop(): void {
    if (this.phase === "connecting") {
      this.failNow("unreachable");
      return;
    }
    if (this.phase === "lobby" || this.phase === "playing") {
      this.phase = "reconnecting";
      this.reconnectSince = Date.now();
      this.reconnectAttempt = 0;
      this.scheduleReconnect();
      return;
    }
    if (this.phase === "reconnecting") {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (Date.now() - this.reconnectSince >= RECONNECT_WINDOW_MS) {
      this.failNow("reconnect_failed");
      return;
    }
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.timer(delay, () => {
      if (this.phase === "reconnecting") this.connect();
    });
  }

  // -- server messages ---------------------------------------------------------

  private handle(m: ServerMsg): void {
    switch (m.t) {
      case "welcome":
        this.myId = m.playerId;
        this.roomCode = m.roomCode;
        this.token = m.token;
        this.tokenStore.set(m.roomCode, m.token);
        this.players = m.players;
        this.stageId = m.stageId;
        this.serverRestarting = false;
        if (this.phase === "connecting" || this.phase === "reconnecting") {
          // a reconnect mid-match resumes on the begin that follows; until then, lobby
          this.phase = this.begin && this.phase === "reconnecting" ? "playing" : "lobby";
        }
        this.intent = null;
        break;
      case "lobby":
        this.players = m.players;
        break;
      case "begin":
        this.begin = m;
        this.beginGen++;
        this.players = m.players;
        this.stageId = m.stageId;
        this.winners = null;
        this.snapshotBuf = [];
        this.phase = "playing";
        break;
      case "snapshot":
        if (this.onSnapshot) this.onSnapshot(m);
        else if (this.snapshotBuf.push(m) > 8) this.snapshotBuf.shift();
        break;
      case "peerLeft":
        this.players = this.players.map((p) => (p.id === m.playerId ? { ...p, connected: false } : p));
        break;
      case "peerBack":
        this.players = this.players.map((p) => (p.id === m.playerId ? { ...p, connected: true } : p));
        break;
      case "gameOver":
        this.winners = m.winners;
        // the room is spent — a reopened tab shouldn't try to resume into it
        if (this.roomCode) this.tokenStore.del(this.roomCode);
        break;
      case "serverRestart":
        this.serverRestarting = true; // the 1001 close right behind it starts the reconnect loop
        break;
      case "error":
        this.handleError(m);
        break;
      case "pong":
        break;
      default:
        break;
    }
  }

  private handleError(m: Extract<ServerMsg, { t: "error" }>): void {
    // host collision: mint a new code and retry on the same socket
    if (m.code === "room_exists" && this.intent?.create && this.hostRetries < HOST_CODE_RETRIES) {
      this.hostRetries++;
      this.intent = { create: true, code: generateRoomCode(cryptoRand) };
      this.sendRaw({
        t: "join", name: "", room: this.intent.code, charId: this.charId, token: null, create: true,
      });
      return;
    }
    if (this.phase === "reconnecting") {
      // the room died while we were away (server restart wipes it) — that's terminal
      this.failNow("reconnect_failed");
      return;
    }
    this.wantClose = true;
    this.ws?.close(1000);
    this.failNow(m.code, m.message);
  }

  private failNow(code: SessionErrorCode, serverMessage?: string): void {
    this.clearTimers();
    this.phase = "failed";
    this.error = { code, message: errorCopy(code, serverMessage) };
    if (code === "reconnect_failed" && this.roomCode) this.tokenStore.del(this.roomCode);
  }

  private reset(): void {
    this.phase = "idle";
    this.error = null;
    this.slowConnect = false;
    this.roomCode = "";
    this.myId = -1;
    this.players = [];
    this.begin = null;
    this.winners = null;
    this.token = null;
    this.intent = null;
    this.serverRestarting = false;
    this.reconnectAttempt = 0;
    this.snapshotBuf = [];
    this.onSnapshot = null;
  }

  /** The match screen sets onSnapshot then drains whatever arrived mid-fade. */
  drainSnapshots(): SnapshotMsg[] {
    const buf = this.snapshotBuf;
    this.snapshotBuf = [];
    return buf;
  }

  // -- plumbing -----------------------------------------------------------------

  private send(m: ClientMsg): void {
    this.sendRaw(m);
  }

  private sendRaw(m: ClientMsg): void {
    try {
      this.ws?.send(JSON.stringify(m));
    } catch { /* socket died between frames; onclose handles it */ }
  }

  private timer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const h = setTimeout(() => {
      this.timers.delete(h);
      fn();
    }, ms);
    this.timers.add(h);
    return h;
  }

  private cancel(h: ReturnType<typeof setTimeout>): void {
    clearTimeout(h);
    this.timers.delete(h);
  }

  private clearTimers(): void {
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
  }
}

// -- inbound validation ---------------------------------------------------------

const isNum = (x: unknown): x is number => typeof x === "number";
const isStr = (x: unknown): x is string => typeof x === "string";

function isPlayerInfoArr(x: unknown): x is PlayerInfo[] {
  return Array.isArray(x) && x.length <= 8 && x.every((p) =>
    typeof p === "object" && p !== null &&
    isNum((p as PlayerInfo).id) && isStr((p as PlayerInfo).name) && isStr((p as PlayerInfo).charId));
}

/**
 * Shape-check inbound frames so a malicious/MITM'd server can't crash the
 * client. Deep sim-snapshot contents are still applied field-by-field by the
 * predictor, which tolerates junk numbers; this guards structure.
 */
export function validateServerMsg(raw: unknown): ServerMsg | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case "welcome":
      return isNum(m.playerId) && isStr(m.roomCode) && isStr(m.token) && isNum(m.tick) &&
        isPlayerInfoArr(m.players) && isStr(m.stageId) ? (raw as ServerMsg) : null;
    case "lobby":
      return isPlayerInfoArr(m.players) && isNum(m.hostId) ? (raw as ServerMsg) : null;
    case "begin":
      return isNum(m.tick) && isPlayerInfoArr(m.players) && isStr(m.stageId) ? (raw as ServerMsg) : null;
    case "snapshot":
      return typeof m.snap === "object" && m.snap !== null && isNum(m.lastInput) &&
        Array.isArray(m.events) ? (raw as ServerMsg) : null;
    case "peerLeft":
    case "peerBack":
      return isNum(m.playerId) ? (raw as ServerMsg) : null;
    case "gameOver":
      return Array.isArray(m.winners) && m.winners.every(isNum) ? (raw as ServerMsg) : null;
    case "pong":
      return isNum(m.ts) ? (raw as ServerMsg) : null;
    case "serverRestart":
      return isStr(m.reason) ? (raw as ServerMsg) : null;
    case "error":
      return isStr(m.code) && isStr(m.message) ? (raw as ServerMsg) : null;
    default:
      return null;
  }
}
