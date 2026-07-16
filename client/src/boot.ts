/**
 * Boot-time URL param parsing, pure so it's testable headlessly.
 *
 *  - ?server[=ws://…]      → legacy online mode (external testing; unchanged)
 *  - ?room=CODE            → menu flow, jumped to Online → JOIN, code prefilled
 *                            (a bad/unknown code shows inline on that screen,
 *                            never the fullscreen ERROR page)
 *  - ?room=CODE&host=1     → menu flow, jumped to Online → HOST with that code
 *  - ?hotseat              → local two-players-one-keyboard mode
 *  - otherwise             → menu
 */
import { normalizeRoomCode } from "@emberfall/shared";

export type BootIntent =
  | { mode: "menu" }
  | { mode: "hotseat" }
  | { mode: "legacyOnline" }
  | { mode: "online"; code: string; host: boolean };

export function parseBoot(search: string): BootIntent {
  const params = new URLSearchParams(search);
  if (params.has("server")) return { mode: "legacyOnline" };
  const room = params.get("room");
  if (room !== null) {
    const host = params.get("host");
    return {
      mode: "online",
      code: normalizeRoomCode(room).slice(0, 12), // keep garbage bounded; validity is checked on screen
      host: host !== null && host !== "0" && host !== "false",
    };
  }
  if (params.has("hotseat")) return { mode: "hotseat" };
  return { mode: "menu" };
}

/** How long a resume marker stays actionable — server holds empty rooms 60s. */
export const RESUME_FRESH_MS = 90_000;

/**
 * A page reopened mid-match has a scrubbed URL but an `ef_resume` marker in
 * sessionStorage (written next to the reconnect token). If it's fresh, boot
 * straight into the online flow so the stored token can reattach.
 */
export function resumeIntent(
  marker: { room?: unknown; ts?: unknown } | null,
  now: number = Date.now(),
): BootIntent | null {
  if (!marker || typeof marker.room !== "string" || typeof marker.ts !== "number") return null;
  if (now - marker.ts > RESUME_FRESH_MS) return null;
  return { mode: "online", code: normalizeRoomCode(marker.room).slice(0, 12), host: false };
}

/** DOM side of resumeIntent: read the marker sessionStorage keeps. */
export function readResumeMarker(): { room?: unknown; ts?: unknown } | null {
  try {
    const raw = sessionStorage.getItem("ef_resume");
    return raw ? (JSON.parse(raw) as { room?: unknown; ts?: unknown }) : null;
  } catch {
    return null;
  }
}
