/**
 * Wire-side schema validation for everything an untrusted client can send.
 * Returns a well-typed ClientMsg or null; the gateway closes the socket on
 * null (a real client never produces one, so a malformed frame is either a
 * bug or an attack — either way the connection is done).
 *
 * Deliberately strict: unknown `t`, wrong field types, oversize strings and
 * oversize arrays all fail. Numeric sanity (NaN aim, garbage button bits)
 * stays in Room.sanitizeInput — this layer is about shape.
 */
import { CHARACTERS, type CharId, type ClientMsg, type TickInput } from "@emberfall/shared";

const MAX_NAME = 32; // room clamps display to 16 after cleaning; this caps the wire
const MAX_ROOM = 16;
const MAX_TOKEN = 128;
const MAX_STAGE = 32;
const MAX_INPUTS = 8;

const isStr = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;
const isNum = (x: unknown): x is number => typeof x === "number";

function isTickInput(x: unknown): x is TickInput {
  if (typeof x !== "object" || x === null) return false;
  const t = x as Record<string, unknown>;
  return isNum(t.tick) && isNum(t.buttons) && isNum(t.aimX) && isNum(t.aimY);
}

export function isCharId(x: unknown): x is CharId {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(CHARACTERS, x);
}

export function validateClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case "join": {
      if (!isStr(m.name, MAX_NAME)) return null;
      if (m.room !== null && !isStr(m.room, MAX_ROOM)) return null;
      if (!isCharId(m.charId)) return null;
      if (m.token !== null && !isStr(m.token, MAX_TOKEN)) return null;
      if (m.stage !== undefined && m.stage !== null && !isStr(m.stage, MAX_STAGE)) return null;
      if (m.create !== undefined && typeof m.create !== "boolean") return null;
      return {
        t: "join",
        name: m.name,
        room: m.room as string | null,
        charId: m.charId,
        token: m.token as string | null,
        stage: m.stage as string | null | undefined,
        create: m.create as boolean | undefined,
      };
    }
    case "input": {
      if (!Array.isArray(m.inputs) || m.inputs.length > MAX_INPUTS) return null;
      if (!m.inputs.every(isTickInput)) return null;
      return { t: "input", inputs: m.inputs };
    }
    case "setChar":
      return isCharId(m.charId) ? { t: "setChar", charId: m.charId } : null;
    case "ready":
      return typeof m.ready === "boolean" ? { t: "ready", ready: m.ready } : null;
    case "start":
      return { t: "start" };
    case "leave":
      return { t: "leave" };
    case "ping":
      return isNum(m.ts) ? { t: "ping", ts: m.ts } : null;
    default:
      return null;
  }
}

/** Display names: printable ASCII only (kills control chars and homoglyphs), max 16. */
export function cleanName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16);
}
