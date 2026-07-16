/**
 * The game gateway: everything between a raw WebSocket and a Room.
 * Split out of main.ts so the whole untrusted surface is testable against
 * a real server on an ephemeral port.
 *
 * Defensive posture (public URL, hostile clients assumed):
 *  - every frame is schema-validated (validate.ts); malformed → socket closed
 *  - per-connection rate limit: soft cap drops messages, hard cap closes
 *  - connection cap: over it, a clear error then close
 *  - room codes re-validated server-side (client checks are advisory)
 *  - reconnect tokens are crypto-random and single-use (room.ts)
 *  - ping/pong keepalive terminates dead sockets
 *  - user-supplied strings are JSON-quoted in logs (no log injection)
 */
import { WebSocket, type WebSocketServer } from "ws";
import {
  SIM_HZ, STAGES, isValidRoomCode, normalizeRoomCode,
  type ClientMsg, type ErrorCode, type ServerMsg,
} from "@emberfall/shared";
import type { Room, RoomPlayer } from "./room.js";
import type { RoomRegistry } from "./registry.js";
import { cleanName, validateClientMsg } from "./validate.js";

export interface GatewayOpts {
  /** Live socket cap; above it new connections get server_full and close. */
  maxConns?: number;
  /** Messages/second above which frames are dropped. */
  rateSoft?: number;
  /** Messages/second above which the socket is closed. */
  rateHard?: number;
  /** Transport ping cadence (also feeds lag compensation). */
  pingIntervalMs?: number;
  /** Missed pongs before the socket is declared dead and terminated. */
  maxMissedPongs?: number;
  log?: (line: string) => void;
}

interface ConnState {
  room: Room | null;
  player: RoomPlayer | null; // object ref, not id — lobby leaves reindex ids
  lastPingSent: number;
  missedPongs: number;
  windowStart: number;
  windowCount: number;
}

export function attachGateway(wss: WebSocketServer, registry: RoomRegistry, opts: GatewayOpts = {}): void {
  const maxConns = opts.maxConns ?? 200;
  const rateSoft = opts.rateSoft ?? 90;
  const rateHard = opts.rateHard ?? 300;
  const pingIntervalMs = opts.pingIntervalMs ?? 2000;
  const maxMissedPongs = opts.maxMissedPongs ?? 5;
  const log = opts.log ?? ((line: string) => console.log(line));

  wss.on("connection", (ws: WebSocket) => {
    const send = (m: ServerMsg): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    const fail = (code: ErrorCode, message: string): void => send({ t: "error", code, message });

    if (wss.clients.size > maxConns) {
      fail("server_full", "Server is at capacity — try again in a bit");
      ws.close(1013, "server full");
      return;
    }

    const state: ConnState = {
      room: null, player: null,
      lastPingSent: 0, missedPongs: 0,
      windowStart: Date.now(), windowCount: 0,
    };

    ws.on("message", (raw) => {
      // rate limit first — cheaper than parsing hostile JSON at 1000 Hz
      const now = Date.now();
      if (now - state.windowStart >= 1000) {
        state.windowStart = now;
        state.windowCount = 0;
      }
      state.windowCount++;
      if (state.windowCount > rateHard) {
        ws.close(1008, "rate limit");
        return;
      }
      if (state.windowCount > rateSoft) return; // drop, stay open

      let msg: ClientMsg | null = null;
      try {
        msg = validateClientMsg(JSON.parse(raw.toString()));
      } catch {
        msg = null;
      }
      if (!msg) {
        fail("bad_msg", "Malformed message");
        ws.close(1008, "bad message");
        return;
      }

      switch (msg.t) {
        case "join":
          handleJoin(msg, state, send, fail, registry, log);
          break;
        case "input":
          if (state.player) state.room?.handleInputs(state.player.id, msg.inputs);
          break;
        case "setChar":
          if (state.player) state.room?.setChar(state.player.id, msg.charId);
          break;
        case "ready":
          if (state.player) state.room?.setReady(state.player.id, msg.ready);
          break;
        case "leave":
          if (state.room && state.player) {
            log(`[server] ${JSON.stringify(state.player.name)} left room ${state.room.code} cleanly`);
            state.room.leave(state.player.id);
          }
          state.room = null;
          state.player = null;
          break;
        case "ping":
          send({ t: "pong", ts: msg.ts });
          break;
        default:
          break;
      }
    });

    // latency probe + keepalive: app-level RTT feeds lag compensation, and a
    // socket that misses enough transport pongs is dead — terminate it.
    const pinger = setInterval(() => {
      if (state.missedPongs >= maxMissedPongs) {
        ws.terminate();
        return;
      }
      state.missedPongs++;
      state.lastPingSent = Date.now();
      send({ t: "pong", ts: -1 }); // app-level keepalive (proxies see traffic)
      ws.ping?.();
    }, pingIntervalMs);

    ws.on("pong", () => {
      state.missedPongs = 0;
      if (state.lastPingSent > 0 && state.player) {
        const rttMs = Date.now() - state.lastPingSent;
        state.player.latencyTicks = Math.round((rttMs / 2 / 1000) * SIM_HZ);
      }
    });

    ws.on("close", () => {
      clearInterval(pinger);
      if (state.room && state.player) {
        state.room.markDisconnected(state.player.id);
        log(`[server] P${state.player.id + 1} dropped from room ${state.room.code}`);
      }
    });

    ws.on("error", () => {
      /* close fires next; nothing to do */
    });
  });
}

function handleJoin(
  msg: Extract<ClientMsg, { t: "join" }>,
  state: ConnState,
  send: (m: ServerMsg) => void,
  fail: (code: ErrorCode, message: string) => void,
  registry: RoomRegistry,
  log: (line: string) => void,
): void {
  if (state.room) return; // one room per connection

  const welcome = (room: Room, p: RoomPlayer): void => {
    state.room = room;
    state.player = p;
    send({
      t: "welcome", playerId: p.id, roomCode: room.code, token: p.token,
      tick: room.sim?.tick ?? 0, players: room.playerInfos(), stageId: room.stageId,
    });
  };

  // reconnect path: token + room code
  if (msg.token && msg.room) {
    const room = registry.get(normalizeRoomCode(msg.room));
    const p = room?.reattach(msg.token, send);
    if (room && p) {
      welcome(room, p);
      // rejoining a live match: re-send begin so the client rebuilds its predictor
      if (room.phase === "playing" && room.sim) {
        send({ t: "begin", tick: room.sim.tick, players: room.playerInfos(), stageId: room.stageId });
      }
      return;
    }
    // fall through: a stale token should not block a fresh join by code
  }

  let room: Room;
  if (msg.room !== null && msg.room !== undefined) {
    const code = normalizeRoomCode(msg.room);
    if (!isValidRoomCode(code)) {
      fail("bad_room_code", "Room codes are 6 letters/digits");
      return;
    }
    if (msg.create) {
      const res = registry.create(code);
      if ("err" in res) {
        if (res.err === "exists") fail("room_exists", "That code is taken — generating another");
        else fail("server_full", "Server is at its room limit — try again soon");
        return;
      }
      room = res.ok;
      if (typeof msg.stage === "string" && msg.stage in STAGES) room.stageId = msg.stage;
    } else {
      const found = registry.get(code);
      if (!found) {
        fail("no_room", `Room ${code} not found`);
        return;
      }
      room = found;
    }
  } else {
    // legacy ?server flow: the server mints the code
    const res = registry.create();
    if ("err" in res) {
      fail("server_full", "Server is at its room limit — try again soon");
      return;
    }
    room = res.ok;
    if (typeof msg.stage === "string" && msg.stage in STAGES) room.stageId = msg.stage;
  }

  if (room.phase !== "lobby") {
    fail("room_started", "That match has already started");
    return;
  }
  const p = room.addPlayer(cleanName(msg.name), msg.charId, send);
  if (!p) {
    fail("room_full", "Room is full");
    return;
  }
  welcome(room, p);
  log(`[server] ${JSON.stringify(p.name)} joined room ${room.code} as P${p.id + 1}`);
}
