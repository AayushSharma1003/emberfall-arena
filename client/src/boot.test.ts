/**
 * Boot param routing: deep links must land on the Online screen with the
 * code prefilled — never the fullscreen error path — and the legacy
 * ?server flow must keep working.
 */
import { describe, expect, it } from "vitest";
import { RESUME_FRESH_MS, parseBoot, resumeIntent } from "./boot.js";

describe("parseBoot", () => {
  it("no params → menu", () => {
    expect(parseBoot("")).toEqual({ mode: "menu" });
    expect(parseBoot("?")).toEqual({ mode: "menu" });
  });

  it("?room=CODE → online JOIN with the normalized code prefilled", () => {
    expect(parseBoot("?room=abc234")).toEqual({ mode: "online", code: "ABC234", host: false });
    expect(parseBoot("?room=ab-c 23")).toEqual({ mode: "online", code: "ABC23", host: false });
  });

  it("?room=CODE&host=1 → online HOST with that code", () => {
    expect(parseBoot("?room=ABC234&host=1")).toEqual({ mode: "online", code: "ABC234", host: true });
    expect(parseBoot("?room=ABC234&host=true")).toEqual({ mode: "online", code: "ABC234", host: true });
    expect(parseBoot("?room=ABC234&host=0")).toEqual({ mode: "online", code: "ABC234", host: false });
  });

  it("a garbage room code still routes to the online screen (inline error there)", () => {
    const b = parseBoot("?room=NOTREAL");
    expect(b.mode).toBe("online");
    if (b.mode === "online") expect(b.code).toBe("NOTREAL");
    const long = parseBoot(`?room=${"X".repeat(200)}`);
    if (long.mode === "online") expect(long.code.length).toBeLessThanOrEqual(12); // bounded, not trusted
  });

  it("?server wins over ?room (legacy external-testing flow unchanged)", () => {
    expect(parseBoot("?server=ws://localhost:8080&room=ABC234")).toEqual({ mode: "legacyOnline" });
    expect(parseBoot("?server")).toEqual({ mode: "legacyOnline" });
  });

  it("?hotseat still boots local mode", () => {
    expect(parseBoot("?hotseat")).toEqual({ mode: "hotseat" });
    expect(parseBoot("?hotseat&stage=molten_span")).toEqual({ mode: "hotseat" });
  });
});

describe("resumeIntent", () => {
  it("a fresh marker boots straight back into the room", () => {
    expect(resumeIntent({ room: "ABC234", ts: 1000 }, 1000 + RESUME_FRESH_MS - 1))
      .toEqual({ mode: "online", code: "ABC234", host: false });
  });

  it("stale or malformed markers are ignored", () => {
    expect(resumeIntent({ room: "ABC234", ts: 1000 }, 1000 + RESUME_FRESH_MS + 1)).toBeNull();
    expect(resumeIntent(null)).toBeNull();
    expect(resumeIntent({ room: 42, ts: 1000 }, 1001)).toBeNull();
    expect(resumeIntent({ room: "ABC234" }, 1001)).toBeNull();
  });
});
