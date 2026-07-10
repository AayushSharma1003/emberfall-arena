/**
 * Wire protocol (JSON for v1 — debuggable; binary is a bandwidth
 * optimization for later, snapshots at 20 Hz fit comfortably in Oracle's
 * free-tier egress).
 *
 * Rates: the sim runs at 60 Hz on BOTH sides (feel constants are tick-
 * based). Clients batch 2 input ticks per packet (30 packets/s); the
 * server broadcasts snapshots every 3rd tick (20 Hz).
 */
import type { TickInput } from "./input.js";
import type { CharId } from "../characters.js";
import type { SimEvent } from "../sim.js";
import type { SimSnap } from "../snapshot.js";

export const INPUT_BATCH = 2; // ticks per input packet (30 packets/s)
export const SNAPSHOT_EVERY = 3; // sim ticks per snapshot (20 Hz)
export const MAX_LAGCOMP_TICKS = 12; // rewind cap for hit lag compensation (~200ms)

export interface PlayerInfo {
  id: number;
  name: string;
  charId: CharId;
  connected: boolean;
  ready: boolean;
  team: 0 | 1;
}

/** Client -> Server */
export type ClientMsg =
  | {
      t: "join";
      name: string;
      room: string | null;
      charId: CharId;
      token: string | null;
      /** Stage request — honored only when this join creates the room. */
      stage?: string | null;
    }
  | { t: "input"; inputs: TickInput[] }
  | { t: "setChar"; charId: CharId }
  | { t: "ready"; ready: boolean }
  | { t: "start" } // host only
  | { t: "ping"; ts: number };

/** Server -> Client */
export type ServerMsg =
  | {
      t: "welcome";
      playerId: number;
      roomCode: string;
      token: string; // reconnect credential
      tick: number;
      players: PlayerInfo[];
      stageId: string;
    }
  | { t: "lobby"; players: PlayerInfo[]; hostId: number }
  | { t: "begin"; tick: number; players: PlayerInfo[]; stageId: string }
  | {
      t: "snapshot";
      snap: SimSnap;
      /** Newest input tick the server has from YOU (personalized). */
      lastInput: number;
      /** Sim events since the previous snapshot (drives remote juice). */
      events: SimEvent[];
    }
  | { t: "peerLeft"; playerId: number }
  | { t: "peerBack"; playerId: number }
  | { t: "gameOver"; winners: number[] }
  | { t: "pong"; ts: number }
  | { t: "error"; code: string; message: string };
