/**
 * Lobby flow: join broadcasts, character select, ready-up start condition,
 * disconnect handling, and reconnect token reattachment.
 */
import { describe, expect, it } from "vitest";
import type { ServerMsg } from "@emberfall/shared";
import { Room } from "./room.js";

function collect(): { msgs: ServerMsg[]; send: (m: ServerMsg) => void } {
  const msgs: ServerMsg[] = [];
  return { msgs, send: (m) => msgs.push(m) };
}

const lastLobby = (msgs: ServerMsg[]): Extract<ServerMsg, { t: "lobby" }> | undefined =>
  [...msgs].reverse().find((m): m is Extract<ServerMsg, { t: "lobby" }> => m.t === "lobby");

describe("lobby flow", () => {
  it("join -> char select -> ready-up starts the match with chosen characters", () => {
    const room = new Room("ABCD");
    const a = collect();
    const b = collect();
    const pa = room.addPlayer("alice", "knight", a.send)!;
    const pb = room.addPlayer("bob", "knight", b.send)!;
    expect(room.phase).toBe("lobby");
    expect(lastLobby(a.msgs)?.players.length).toBe(2);

    room.setChar(pb.id, "ogre");
    expect(lastLobby(a.msgs)?.players[1].charId).toBe("ogre");

    room.setReady(pa.id, true);
    expect(room.phase).toBe("lobby"); // one ready is not enough
    room.setReady(pb.id, true);
    expect(room.phase).toBe("playing");

    const begin = a.msgs.find((m): m is Extract<ServerMsg, { t: "begin" }> => m.t === "begin");
    expect(begin).toBeDefined();
    expect(begin!.players.map((p) => p.charId)).toEqual(["knight", "ogre"]);
    expect(room.sim!.fighters[1].charId).toBe("ogre");
  });

  it("changing character clears your ready flag", () => {
    const room = new Room("EFGH");
    const a = collect();
    const pa = room.addPlayer("alice", "knight", a.send)!;
    room.addPlayer("bob", "mage", collect().send);
    room.setReady(pa.id, true);
    expect(lastLobby(a.msgs)?.players[0].ready).toBe(true);
    room.setChar(pa.id, "goblin");
    expect(lastLobby(a.msgs)?.players[0].ready).toBe(false);
    expect(room.phase).toBe("lobby");
  });

  it("a solo player readying up does not start a match", () => {
    const room = new Room("SOLO");
    const pa = room.addPlayer("alice", "knight", collect().send)!;
    room.setReady(pa.id, true);
    expect(room.phase).toBe("lobby");
  });

  it("character changes are locked once playing", () => {
    const room = new Room("LOCK");
    room.autoStart = true;
    const pa = room.addPlayer("alice", "knight", collect().send)!;
    room.addPlayer("bob", "mage", collect().send);
    expect(room.phase).toBe("playing");
    room.setChar(pa.id, "ogre");
    expect(room.players[0].charId).toBe("knight");
    expect(room.sim!.fighters[0].charId).toBe("knight");
  });

  it("disconnect un-readies; reconnect token restores the same slot", () => {
    const room = new Room("RECON");
    const a = collect();
    const b = collect();
    const pa = room.addPlayer("alice", "knight", a.send)!;
    const pb = room.addPlayer("bob", "mage", b.send)!;
    room.setReady(pa.id, true);
    room.setReady(pb.id, true);
    expect(room.phase).toBe("playing");

    room.markDisconnected(pb.id);
    expect(room.players[pb.id].connected).toBe(false);
    expect(a.msgs.some((m) => m.t === "peerLeft")).toBe(true);

    // wrong token: rejected
    expect(room.reattach("bogus", collect().send)).toBeNull();

    const b2 = collect();
    const back = room.reattach(pb.token, b2.send);
    expect(back?.id).toBe(pb.id);
    expect(room.players[pb.id].connected).toBe(true);
    expect(a.msgs.some((m) => m.t === "peerBack")).toBe(true);

    // resumed player receives snapshots again
    for (let i = 0; i < 6; i++) room.tick();
    expect(b2.msgs.some((m) => m.t === "snapshot")).toBe(true);
  });

  it("a full or playing room rejects new joins", () => {
    const room = new Room("FULL");
    room.addPlayer("a", "knight", collect().send);
    room.addPlayer("b", "mage", collect().send);
    room.addPlayer("c", "ogre", collect().send);
    room.addPlayer("d", "goblin", collect().send);
    expect(room.addPlayer("e", "ranger", collect().send)).toBeNull();
  });

  it("malicious inputs (NaN aim, garbage buttons) never reach the sim", () => {
    const room = new Room("EVIL");
    room.autoStart = true;
    room.addPlayer("mallory", "knight", collect().send);
    room.addPlayer("victim", "knight", collect().send);
    const sim = room.sim!;
    const t = sim.tick;
    room.handleInputs(0, [
      { tick: t + 1, buttons: NaN, aimX: NaN, aimY: Infinity },
      { tick: t + 2, buttons: 0xffffffff, aimX: 1e300, aimY: -1e300 },
      { tick: NaN, buttons: 1, aimX: 0, aimY: 0 },
    ] as never);
    for (let i = 0; i < 30; i++) room.tick();
    for (const f of sim.fighters) {
      expect(Number.isFinite(f.x), "x stays finite").toBe(true);
      expect(Number.isFinite(f.y), "y stays finite").toBe(true);
      expect(Number.isFinite(f.vx) && Number.isFinite(f.vy)).toBe(true);
    }
  });

  it("a player disconnected >30s mid-match forfeits their stocks", () => {
    const room = new Room("AFK");
    room.autoStart = true;
    room.addPlayer("stayer", "knight", collect().send);
    room.addPlayer("rager", "knight", collect().send);
    const sim = room.sim!;
    room.markDisconnected(1);
    // not yet: 10 seconds in, still has stocks
    for (let i = 0; i < 600; i++) room.tick();
    expect(sim.fighters[1].stocks).toBeGreaterThan(0);
    expect(room.phase).toBe("playing");
    // 30+ seconds: forfeited, match over, stayer wins
    for (let i = 0; i < 1300; i++) room.tick();
    expect(sim.fighters[1].stocks).toBe(0);
    expect(room.phase).toBe("over");
  });

  it("reconnecting before the forfeit deadline keeps your stocks", () => {
    const room = new Room("BRB");
    room.autoStart = true;
    room.addPlayer("stayer", "knight", collect().send);
    const p2 = room.addPlayer("wifi", "knight", collect().send)!;
    room.markDisconnected(1);
    for (let i = 0; i < 900; i++) room.tick(); // 15s
    expect(room.reattach(p2.token, collect().send)).not.toBeNull();
    for (let i = 0; i < 1500; i++) room.tick(); // way past the old deadline
    expect(room.sim!.fighters[1].stocks).toBeGreaterThan(0);
    expect(room.phase).toBe("playing");
  });

  it("2v2: four players get alternating teams, match ends when a TEAM is out", () => {
    const room = new Room("TEAM");
    const sinks = ["a", "b", "c", "d"].map((n, i) => {
      const s = collect();
      const p = room.addPlayer(n, "knight", s.send)!;
      expect(p.team).toBe(i % 2);
      return s;
    });
    for (let i = 0; i < 4; i++) room.setReady(i, true);
    expect(room.phase).toBe("playing");
    const sim = room.sim!;
    expect(sim.fighters.map((f) => f.team)).toEqual([0, 1, 0, 1]);

    // knock out ONE member of team 1: match must continue
    sim.fighters[1].stocks = 1;
    sim.fighters[1].x = -1000; // past the blast zone
    for (let i = 0; i < 5; i++) room.tick();
    expect(room.phase).toBe("playing");

    // knock out the other member of team 1: team 0 wins
    sim.fighters[3].stocks = 1;
    sim.fighters[3].x = -1000;
    for (let i = 0; i < 5; i++) room.tick();
    expect(room.phase).toBe("over");
    const over = sinks[0].msgs.find((m): m is Extract<ServerMsg, { t: "gameOver" }> => m.t === "gameOver");
    expect(over).toBeDefined();
    expect(over!.winners.sort()).toEqual([0, 2]); // both team-0 players win
  });
});
