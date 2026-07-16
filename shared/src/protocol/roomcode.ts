/**
 * Room codes, shared by client and server so both sides agree on the
 * alphabet and shape. 6 chars from a 31-letter set that drops every
 * ambiguous glyph (0/O, 1/I/L) — codes are read aloud and retyped.
 *
 * The CLIENT generates codes when hosting (the server confirms uniqueness
 * and answers `room_exists` on a collision so the client can retry); the
 * server also generates codes for the legacy `?server` join-with-no-code
 * path. Both use this module.
 */

export const ROOM_CODE_LEN = 6;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

const CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LEN}}$`);

/** Uppercase and strip the separators people paste in ("ab-c 12d" -> "ABC12D"). */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

/** Strict shape check — run AFTER normalizeRoomCode. */
export function isValidRoomCode(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * Generate a code from a uniform random source. `rand()` must return
 * a float in [0, 1); pass a crypto-backed source where it matters
 * (uniqueness, not secrecy — the code is shared in invite links).
 */
export function generateRoomCode(rand: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length) % ROOM_CODE_ALPHABET.length];
  }
  return code;
}
