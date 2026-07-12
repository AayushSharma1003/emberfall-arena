/**
 * WebSocket transport + room registry. All game logic lives in Room /
 * the shared Sim; this file only parses messages, tracks latency, and
 * drives room ticks on a drift-corrected 60 Hz loop.
 *
 * Single-origin deploy: the same process serves the client bundle and the
 * game socket (see httpserver.ts) so `wss://<host>/ws` needs no client config.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket } from "ws";
import { SIM_HZ, CHARACTERS, STAGES, type CharId, type ClientMsg, type ServerMsg } from "@emberfall/shared";
import { Room } from "./room.js";
import { createAppServer, shutdown } from "./httpserver.js";

const PORT = Number(process.env.PORT ?? 8080);
const rooms = new Map<string, Room>();

// client/dist relative to THIS file — works whether we run the esbuild bundle
// (server/dist/main.js) or tsx in dev (server/src/main.ts); never process.cwd().
const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");
const app = createAppServer({ clientDir });
const wss = app.wss;

function makeRoomCode(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function isCharId(x: unknown): x is CharId {
  return typeof x === "string" && x in CHARACTERS;
}

interface ConnState {
  room: Room | null;
  playerId: number;
  lastPingSent: number;
  rttMs: number;
}

wss.on("connection", (ws: WebSocket) => {
  const state: ConnState = { room: null, playerId: -1, lastPingSent: 0, rttMs: 0 };
  const send = (m: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }

    switch (msg.t) {
      case "join": {
        if (state.room) return;
        const charId = isCharId(msg.charId) ? msg.charId : "knight";

        // reconnect path: token + room code
        if (msg.token && msg.room && rooms.has(msg.room.toUpperCase())) {
          const room = rooms.get(msg.room.toUpperCase())!;
          const p = room.reattach(msg.token, send);
          if (p) {
            state.room = room;
            state.playerId = p.id;
            send({
              t: "welcome", playerId: p.id, roomCode: room.code, token: p.token,
              tick: room.sim?.tick ?? 0, players: room.playerInfos(), stageId: room.stageId,
            });
            // rejoining a live match: re-send begin so the client rebuilds its predictor
            if (room.phase === "playing" && room.sim) {
              send({ t: "begin", tick: room.sim.tick, players: room.playerInfos(), stageId: room.stageId });
            }
            return;
          }
        }

        let room: Room;
        if (msg.room) {
          const found = rooms.get(msg.room.toUpperCase());
          if (!found) {
            send({ t: "error", code: "no_room", message: `Room ${msg.room} not found` });
            return;
          }
          room = found;
        } else {
          room = new Room(makeRoomCode());
          if (typeof msg.stage === "string" && msg.stage in STAGES) room.stageId = msg.stage;
          rooms.set(room.code, room);
        }

        const cleanName = String(msg.name ?? "")
          .replace(/[^\x20-\x7e]/g, "") // printable ASCII only (box-font HUD anyway)
          .trim();
        const p = room.addPlayer(cleanName, charId, send);
        if (!p) {
          send({ t: "error", code: "room_full", message: "Room is full or already playing" });
          return;
        }
        state.room = room;
        state.playerId = p.id;
        send({
          t: "welcome", playerId: p.id, roomCode: room.code, token: p.token,
          tick: room.sim?.tick ?? 0, players: room.playerInfos(), stageId: room.stageId,
        });
        console.log(`[server] ${p.name} joined room ${room.code} as P${p.id + 1}`);
        break;
      }
      case "input":
        state.room?.handleInputs(state.playerId, msg.inputs);
        break;
      case "setChar":
        if (isCharId(msg.charId)) state.room?.setChar(state.playerId, msg.charId);
        break;
      case "ready":
        state.room?.setReady(state.playerId, msg.ready === true);
        break;
      case "ping":
        send({ t: "pong", ts: msg.ts });
        break;
      default:
        break;
    }
  });

  // latency probe: half of app-level RTT, in ticks, feeds lag compensation
  const pinger = setInterval(() => {
    state.lastPingSent = Date.now();
    send({ t: "pong", ts: -1 }); // keepalive
    ws.ping?.();
  }, 2000);

  ws.on("pong", () => {
    if (state.lastPingSent > 0 && state.room) {
      state.rttMs = Date.now() - state.lastPingSent;
      const p = state.room.players[state.playerId];
      if (p) p.latencyTicks = Math.round((state.rttMs / 2 / 1000) * SIM_HZ);
    }
  });

  ws.on("close", () => {
    clearInterval(pinger);
    if (state.room) {
      state.room.markDisconnected(state.playerId);
      console.log(`[server] P${state.playerId + 1} left room ${state.room.code}`);
    }
  });
});

// drift-corrected 60 Hz loop for all rooms
const TICK_MS = 1000 / SIM_HZ;
let last = Date.now();
let acc = 0;
const tickTimer = setInterval(() => {
  const now = Date.now();
  acc += now - last;
  last = now;
  acc = Math.min(acc, 250); // don't spiral after a stall
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    for (const [code, room] of rooms) {
      room.tick();
      if (room.empty) rooms.delete(code);
    }
  }
}, 4);

app.server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] Emberfall Arena listening on :${PORT} (sim ${SIM_HZ}Hz) — /ws game, / client, /health`);
});

// SIGTERM (Render deploy/spin-down) + SIGINT (local Ctrl-C): stop ticking,
// close sockets cleanly (client onClose → "reconnect"), exit. Clean close, no
// custom "restarting" message — that lands with the online-menu follow-up.
function onSignal(sig: string): void {
  console.log(`[server] ${sig} received — shutting down`);
  clearInterval(tickTimer);
  shutdown(app, { hardExitMs: 2000 });
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
