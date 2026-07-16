/**
 * Room registry: code -> Room, with the abuse caps the public deploy needs.
 *
 *  - Hard cap on live rooms (a bot flood can't OOM the free instance).
 *  - Create-with-code answers "exists" on a collision — the HOST retries
 *    with a fresh client-generated code, so two hosts racing the same code
 *    resolve to one winner and one clean error.
 *  - Empty rooms (every player disconnected) are held for a grace window
 *    so a mid-match double-drop can still reconnect, then freed and the
 *    code becomes reusable.
 */
import { randomBytes } from "node:crypto";
import { generateRoomCode } from "@emberfall/shared";
import { Room } from "./room.js";

export const DEFAULT_MAX_ROOMS = 100;
export const DEFAULT_GRACE_MS = 60_000;

const cryptoRand = (): number => randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;

export type CreateResult = { ok: Room } | { err: "exists" } | { err: "full" };

export class RoomRegistry {
  readonly rooms = new Map<string, Room>();
  private readonly maxRooms: number;
  private readonly graceMs: number;

  constructor(opts: { maxRooms?: number; graceMs?: number } = {}) {
    this.maxRooms = opts.maxRooms ?? DEFAULT_MAX_ROOMS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Create a room, with a specific code (host flow) or a server-minted one (legacy). */
  create(code?: string): CreateResult {
    if (this.rooms.size >= this.maxRooms) return { err: "full" };
    if (code !== undefined && this.rooms.has(code)) return { err: "exists" };
    const room = new Room(code ?? this.mintCode());
    this.rooms.set(room.code, room);
    return { ok: room };
  }

  private mintCode(): string {
    let code: string;
    do {
      code = generateRoomCode(cryptoRand);
    } while (this.rooms.has(code));
    return code;
  }

  /** Advance every room one sim tick and sweep empties past the grace window. */
  tickAll(now: number = Date.now()): void {
    for (const [code, room] of this.rooms) {
      room.tick();
      if (room.empty) {
        room.emptySince ??= now;
        if (now - room.emptySince >= this.graceMs) this.rooms.delete(code);
      } else {
        room.emptySince = null;
      }
    }
  }
}
