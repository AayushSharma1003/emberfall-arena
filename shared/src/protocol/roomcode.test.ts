import { describe, expect, it } from "vitest";
import {
  ROOM_CODE_ALPHABET, ROOM_CODE_LEN, generateRoomCode, isValidRoomCode, normalizeRoomCode,
} from "./roomcode.js";

describe("room codes", () => {
  it("alphabet excludes every ambiguous glyph", () => {
    for (const bad of "0O1IL") expect(ROOM_CODE_ALPHABET).not.toContain(bad);
    expect(ROOM_CODE_ALPHABET.length).toBe(31);
  });

  it("normalize uppercases and strips spaces/dashes", () => {
    expect(normalizeRoomCode("ab-c 12d")).toBe("ABC12D");
    expect(normalizeRoomCode("  a b c 1 2 d ")).toBe("ABC12D");
    expect(normalizeRoomCode("AB—CD")).toBe("AB—CD".toUpperCase().replace(/[\s-]/g, "")); // em dash is NOT stripped — it fails validation instead
  });

  it("validates exactly 6 chars from the alphabet", () => {
    expect(isValidRoomCode("ABC234")).toBe(true);
    expect(isValidRoomCode("ABC23")).toBe(false); // short
    expect(isValidRoomCode("ABC2345")).toBe(false); // long
    expect(isValidRoomCode("ABC10D")).toBe(false); // 0 and 1 excluded
    expect(isValidRoomCode("ABCILO")).toBe(false); // I, L, O excluded
    expect(isValidRoomCode("abc234")).toBe(false); // must be normalized first
    expect(isValidRoomCode("")).toBe(false);
  });

  it("generated codes always validate, across many draws", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code.length).toBe(ROOM_CODE_LEN);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it("generation uses the injected random source", () => {
    expect(generateRoomCode(() => 0)).toBe("AAAAAA");
    expect(generateRoomCode(() => 0.999999)).toBe("999999");
  });
});
