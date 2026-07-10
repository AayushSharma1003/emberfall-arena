/**
 * A match room: authoritative 60 Hz sim, per-player input buffers with
 * hold-last extrapolation, snapshot broadcast every 3rd tick, and
 * lag-compensated melee hit rewind.
 *
 * Transport-agnostic: `send` callbacks are injected, `tick()` is driven
 * externally (setInterval in production, manually in tests).
 */
import {
  Sim, serializeSim, hurtboxOf, stageById,
  MAX_LAGCOMP_TICKS, SNAPSHOT_EVERY,
  type CharId, type InputFrame, type ServerMsg, type SimEvent, type Stage,
  type TickInput, type PlayerInfo,
} from "@emberfall/shared";

const HISTORY = 32; // position history ring for lag comp (~530ms)
const MAX_PLAYERS = 4; // 2v2; 2 players = 1v1, 3 = uneven 2v1 (allowed, noted)
const FORFEIT_TICKS = 30 * 60; // disconnected 30s mid-match -> stocks forfeited

/**
 * Never trust the wire: a malicious client can send NaN/Infinity aim (which
 * would poison the whole sim via Math.hypot) or garbage buttons.
 */
function sanitizeInput(ti: TickInput): TickInput | null {
  if (!Number.isFinite(ti.tick)) return null;
  const buttons = Number.isFinite(ti.buttons) ? ti.buttons & 0x7ff : 0; // known Btn bits only
  let aimX = Number.isFinite(ti.aimX) ? ti.aimX : 0;
  let aimY = Number.isFinite(ti.aimY) ? ti.aimY : 0;
  const m = Math.hypot(aimX, aimY);
  if (m > 10000) { aimX = (aimX / m) * 10000; aimY = (aimY / m) * 10000; }
  return { tick: Math.floor(ti.tick), buttons, aimX, aimY };
}

export interface RoomPlayer {
  id: number;
  name: string;
  charId: CharId;
  token: string;
  team: 0 | 1;
  connected: boolean;
  ready: boolean;
  /** Sim tick when the player dropped mid-match (for AFK forfeit). */
  disconnectedAt: number;
  send: (m: ServerMsg) => void;
  inputs: Map<number, InputFrame>;
  lastInputTick: number;
  latencyTicks: number; // one-way, from transport pings
  lastUsed: InputFrame;
}

const NEUTRAL: InputFrame = { buttons: 0, aimX: 0, aimY: 0 };

let tokenCounter = 0;
function makeToken(): string {
  return `t${Date.now().toString(36)}${(tokenCounter++).toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class Room {
  sim: Sim | null = null;
  phase: "lobby" | "playing" | "over" = "lobby";
  players: RoomPlayer[] = [];
  stageId = "emberfall_keep";
  /** Test hook: start the match the moment the room is full, skipping ready-up. */
  autoStart = false;

  private history: { tick: number; x: number; y: number }[][] = [];
  private eventBuf: SimEvent[] = [];

  constructor(public code: string) {}

  get full(): boolean {
    return this.players.filter((p) => p.connected).length >= MAX_PLAYERS;
  }

  addPlayer(name: string, charId: CharId, send: (m: ServerMsg) => void): RoomPlayer | null {
    if (this.players.length >= MAX_PLAYERS || this.phase !== "lobby") return null;
    const p: RoomPlayer = {
      id: this.players.length,
      name: name.slice(0, 16) || `P${this.players.length + 1}`,
      charId,
      token: makeToken(),
      team: (this.players.length % 2) as 0 | 1,
      connected: true,
      ready: false,
      disconnectedAt: -1,
      send,
      inputs: new Map(),
      lastInputTick: -1,
      latencyTicks: 0,
      lastUsed: NEUTRAL,
    };
    this.players.push(p);
    // autoStart is a test hook: skip ready-up as soon as a match is possible
    if (this.autoStart && this.players.filter((x) => x.connected).length >= 2) this.startMatch();
    else this.lobbyUpdate();
    return p;
  }

  /** Lobby: change character (locked once the match starts). */
  setChar(playerId: number, charId: CharId): void {
    const p = this.players[playerId];
    if (!p || this.phase !== "lobby") return;
    p.charId = charId;
    p.ready = false; // changing character un-readies you
    this.lobbyUpdate();
  }

  /** Lobby: ready-up. The match starts when 2+ players are all ready. */
  setReady(playerId: number, ready: boolean): void {
    const p = this.players[playerId];
    if (!p || this.phase !== "lobby") return;
    p.ready = ready;
    this.lobbyUpdate();
    const present = this.players.filter((x) => x.connected);
    if (present.length >= 2 && present.every((x) => x.ready)) this.startMatch();
  }

  private lobbyUpdate(): void {
    if (this.phase !== "lobby") return;
    const host = this.players.find((p) => p.connected);
    this.broadcast({ t: "lobby", players: this.playerInfos(), hostId: host?.id ?? 0 });
  }

  playerInfos(): PlayerInfo[] {
    return this.players.map((p) => ({
      id: p.id, name: p.name, charId: p.charId, connected: p.connected, ready: p.ready, team: p.team,
    }));
  }

  startMatch(stage: Stage = stageById(this.stageId).make()): void {
    const sim = new Sim(stage);
    for (const p of this.players) sim.addFighter(p.charId, p.team);
    this.history = this.players.map(() => new Array(HISTORY));
    // lag comp: rewind the victim's hurtbox by the attacker's one-way latency
    sim.hitRewind = (atk, vic) => {
      const lat = Math.min(MAX_LAGCOMP_TICKS, Math.round(this.players[atk.id]?.latencyTicks ?? 0));
      if (lat <= 0) return null;
      const h = this.history[vic.id]?.[(sim.tick - lat + HISTORY * 4) % HISTORY];
      if (!h || h.tick !== sim.tick - lat) return null;
      const box = hurtboxOf(vic);
      return { x: h.x - vic.stats.width / 2, y: h.y - vic.stats.height, w: box.w, h: box.h };
    };
    this.sim = sim;
    this.phase = "playing";
    const begin: ServerMsg = { t: "begin", tick: sim.tick, players: this.playerInfos(), stageId: this.stageId };
    this.broadcast(begin);
  }

  handleInputs(playerId: number, inputs: TickInput[]): void {
    const p = this.players[playerId];
    const sim = this.sim;
    if (!p || !sim || !Array.isArray(inputs)) return;
    for (const raw of inputs.slice(0, 8)) {
      const ti = sanitizeInput(raw);
      if (!ti) continue;
      if (ti.tick <= sim.tick) continue; // too late — that tick already simulated
      if (ti.tick > sim.tick + 120) continue; // absurdly far ahead — drop
      p.inputs.set(ti.tick, { buttons: ti.buttons, aimX: ti.aimX, aimY: ti.aimY });
      p.lastInputTick = Math.max(p.lastInputTick, ti.tick);
    }
  }

  /** Advance one sim tick; broadcast a snapshot every SNAPSHOT_EVERY ticks. */
  tick(): void {
    const sim = this.sim;
    if (!sim || this.phase !== "playing") return;

    // record pre-step positions (state at time sim.tick) for hit rewind
    for (const f of sim.fighters) {
      this.history[f.id][sim.tick % HISTORY] = { tick: sim.tick, x: f.x, y: f.y };
    }

    const nextTick = sim.tick + 1;
    const inputs = this.players.map((p) => {
      const inp = p.inputs.get(nextTick);
      if (inp) {
        p.lastUsed = inp;
        p.inputs.delete(nextTick);
        return inp;
      }
      return p.connected ? p.lastUsed : NEUTRAL; // hold-last extrapolation
    });

    this.eventBuf.push(...sim.step(inputs));

    // anti-troll: a player who stays disconnected mid-match forfeits their
    // stocks (their team can still win a 2v1; a 1v1 just ends)
    for (const p of this.players) {
      const f = sim.fighters[p.id];
      if (
        !p.connected && p.disconnectedAt >= 0 && f && f.stocks > 0 &&
        sim.tick - p.disconnectedAt > FORFEIT_TICKS
      ) {
        f.stocks = 0;
        f.state = "dead";
        f.respawnTimer = 0;
      }
    }

    // GC stale buffered inputs
    if (sim.tick % 60 === 0) {
      for (const p of this.players) {
        for (const k of p.inputs.keys()) if (k <= sim.tick) p.inputs.delete(k);
      }
    }

    if (sim.tick % SNAPSHOT_EVERY === 0) {
      const snap = serializeSim(sim);
      const events = this.eventBuf;
      this.eventBuf = [];
      for (const p of this.players) {
        if (!p.connected) continue;
        p.send({ t: "snapshot", snap, lastInput: p.lastInputTick, events });
      }
    }

    // match end: at most one TEAM still has stocks (individual stock pools —
    // a team is eliminated when all of its members are out)
    const aliveTeams = new Set(sim.fighters.filter((f) => f.stocks > 0).map((f) => f.team));
    if (aliveTeams.size <= 1 && this.phase === "playing") {
      this.phase = "over";
      const winners = sim.fighters.filter((f) => aliveTeams.has(f.team)).map((f) => f.id);
      this.broadcast({ t: "gameOver", winners });
    }
  }

  markDisconnected(playerId: number): void {
    const p = this.players[playerId];
    if (!p) return;
    p.connected = false;
    p.ready = false;
    p.disconnectedAt = this.sim?.tick ?? -1;
    this.broadcast({ t: "peerLeft", playerId });
    // NOTE: lobby slots are tombstoned, not freed — a mid-lobby leaver's
    // slot only opens up again via their reconnect token. Acceptable v1.
    this.lobbyUpdate();
  }

  /** Reconnect: swap in a new send fn, resume. */
  reattach(token: string, send: (m: ServerMsg) => void): RoomPlayer | null {
    const p = this.players.find((x) => x.token === token);
    if (!p) return null;
    p.send = send;
    p.connected = true;
    p.disconnectedAt = -1;
    this.broadcast({ t: "peerBack", playerId: p.id });
    return p;
  }

  broadcast(m: ServerMsg): void {
    for (const p of this.players) if (p.connected) p.send(m);
  }

  get empty(): boolean {
    return this.players.every((p) => !p.connected);
  }
}
