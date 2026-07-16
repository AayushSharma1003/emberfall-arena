/**
 * Room registry: creation, the create-with-code collision race, the room
 * cap, and empty-room expiry through the grace window.
 */
import { describe, expect, it } from "vitest";
import { isValidRoomCode, type ServerMsg } from "@emberfall/shared";
import { RoomRegistry } from "./registry.js";

const sink = (): ((m: ServerMsg) => void) => () => {};

describe("RoomRegistry", () => {
  it("create() with a code registers exactly that room", () => {
    const reg = new RoomRegistry();
    const res = reg.create("ABC234");
    expect("ok" in res && res.ok.code).toBe("ABC234");
    expect(reg.get("ABC234")).toBeDefined();
    expect(reg.size).toBe(1);
  });

  it("create() without a code mints a valid unique code", () => {
    const reg = new RoomRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = reg.create();
      if (!("ok" in res)) throw new Error("cap hit unexpectedly");
      expect(isValidRoomCode(res.ok.code)).toBe(true);
      seen.add(res.ok.code);
    }
    expect(seen.size).toBe(50);
  });

  it("two creates racing the same code: second gets a collision error, first room intact", () => {
    const reg = new RoomRegistry();
    const first = reg.create("SAMECD");
    expect("ok" in first).toBe(true);
    if ("ok" in first) first.ok.addPlayer("alice", "knight", sink());
    const second = reg.create("SAMECD");
    expect(second).toEqual({ err: "exists" });
    expect(reg.get("SAMECD")!.players[0]?.name).toBe("alice");
  });

  it("room cap: rejects new rooms with 'full', existing rooms unaffected", () => {
    const reg = new RoomRegistry({ maxRooms: 2 });
    expect("ok" in reg.create("AAAAAA")).toBe(true);
    expect("ok" in reg.create("BBBBBB")).toBe(true);
    expect(reg.create("CCCCCC")).toEqual({ err: "full" });
    expect(reg.create()).toEqual({ err: "full" });
    expect(reg.size).toBe(2);
  });

  it("an empty room survives the grace window, then is freed and its code reusable", () => {
    const reg = new RoomRegistry({ graceMs: 1000 });
    const res = reg.create("GRACED");
    if (!("ok" in res)) throw new Error("create failed");
    const p = res.ok.addPlayer("solo", "knight", sink())!;
    res.ok.markDisconnected(p.id);

    reg.tickAll(10_000); // empty first observed here
    expect(reg.get("GRACED")).toBeDefined();
    reg.tickAll(10_900); // inside the window
    expect(reg.get("GRACED")).toBeDefined();
    reg.tickAll(11_001); // past it
    expect(reg.get("GRACED")).toBeUndefined();

    expect("ok" in reg.create("GRACED")).toBe(true); // code reusable after free
  });

  it("a player coming back inside the window resets the grace clock", () => {
    const reg = new RoomRegistry({ graceMs: 1000 });
    const res = reg.create("COMEBK");
    if (!("ok" in res)) throw new Error("create failed");
    const p = res.ok.addPlayer("wifi", "knight", sink())!;
    const token = p.token;
    res.ok.markDisconnected(p.id);

    reg.tickAll(20_000);
    expect(res.ok.reattach(token, sink())).not.toBeNull();
    reg.tickAll(21_500); // would have expired, but the room is occupied again
    expect(reg.get("COMEBK")).toBeDefined();
  });
});
