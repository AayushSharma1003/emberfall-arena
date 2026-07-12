/**
 * Per-character frame-data coverage: every move of every character is
 * exercised headlessly — schema validity, startup/active timing, exact
 * damage, and the exact knockback vector (formula + angle policy).
 * Plus roster-level distinctness assertions so "six characters" never
 * quietly collapses into palette swaps.
 */
import { describe, expect, it } from "vitest";
import { Btn } from "./protocol/input.js";
import {
  CHARACTERS, CHAR_IDS,
  type CharId, type MoveDef, type MoveSlot,
} from "./characters.js";
import { Sim, TUNING, emberfallKeep, type Fighter } from "./sim.js";
import { N, frame, place, steps } from "./testutil.js";

/** The four classic slots (exact-knockback execution tests run on these). */
const SLOTS: MoveSlot[] = ["light", "heavy", "aerial", "special"];
/** Every slot, ultimates included (schema + uniqueness run on these). */
const ALL_SLOTS: MoveSlot[] = [...SLOTS, "ultimate"];

// ---------- schema validation ----------
describe("moveset schema", () => {
  for (const id of CHAR_IDS) {
    const c = CHARACTERS[id];
    it(`${id}: all moves have valid frame data`, () => {
      for (const slot of ALL_SLOTS) {
        const m = c.moves[slot];
        expect(m.startupTicks, `${m.id} startup`).toBeGreaterThanOrEqual(1);
        expect(m.activeTicks, `${m.id} active`).toBeGreaterThanOrEqual(1);
        expect(m.recoveryTicks, `${m.id} recovery`).toBeGreaterThanOrEqual(0);
        expect(m.cooldownTicks, `${m.id} cooldown`).toBeGreaterThanOrEqual(0);
        if (m.kind === "projectile") {
          expect(m.projectile, `${m.id} projectile def`).toBeDefined();
          expect(m.projectile!.damage).toBeGreaterThan(0);
          // stationary clones (spawned at origin, pre-armed) legitimately have speed 0
          if (!m.projectileAtOrigin) expect(m.projectile!.speed, `${m.id} speed`).toBeGreaterThan(0);
          expect(m.projectile!.lifeTicks).toBeGreaterThan(0);
        } else if (m.construct) {
          // deploy moves have no hitbox of their own — the turret is the payload
          expect(m.construct.hp, `${m.id} construct hp`).toBeGreaterThan(0);
          expect(m.construct.lifeTicks).toBeGreaterThan(0);
          expect(m.construct.maxActive).toBeGreaterThanOrEqual(1);
          expect(m.construct.projectile.damage).toBeGreaterThan(0);
          expect(m.construct.fireEveryTicks).toBeGreaterThan(0);
        } else if (m.parry) {
          // parry stances have no outgoing hitbox — the riposte is the payload
          expect(m.parry.damage, `${m.id} riposte damage`).toBeGreaterThan(0);
          expect(m.parry.baseKnockback).toBeGreaterThan(0);
          expect(m.activeTicks, `${m.id} parry window`).toBeGreaterThanOrEqual(10);
        } else {
          expect(m.damage, `${m.id} damage`).toBeGreaterThan(0);
          expect(m.boxW, `${m.id} boxW`).toBeGreaterThan(0);
          expect(m.boxH, `${m.id} boxH`).toBeGreaterThan(0);
          if (m.angle === "aim" && !m.radial) expect(m.reach).toBeGreaterThan(0);
        }
        if (typeof m.angle === "number") {
          expect(Math.abs(m.angle)).toBeLessThanOrEqual(90);
        }
      }
      expect(c.stats.weight).toBeGreaterThan(0);
      expect(c.stats.jumpCount).toBeGreaterThanOrEqual(2);
      expect(c.lore.length, `${id} lore`).toBeGreaterThan(40);
      expect(c.role.length, `${id} role`).toBeGreaterThan(2);
      expect(c.epithet.length, `${id} epithet`).toBeGreaterThan(2);
    });
  }
});

// ---------- melee move execution ----------
/** Set up attacker (char) vs knight victim, standing apart on the main platform. */
function duel(charId: CharId, dist: number): { sim: Sim; atk: Fighter; vic: Fighter } {
  const sim = new Sim(emberfallKeep());
  const atk = sim.addFighter(charId);
  const vic = sim.addFighter("knight");
  place(atk, 800, 700);
  place(vic, 800 + dist, 700);
  steps(sim, 30); // settle onto the platform
  place(atk, 800, 780);
  place(vic, 800 + dist, 780);
  return { sim, atk, vic };
}

function meleeDistance(atk: Fighter, vic: Fighter, m: MoveDef): number {
  const minSep = (atk.stats.width + vic.stats.width) / 2 + 4; // body push keeps them at least this far
  return Math.max(m.angle === "aim" ? m.reach : m.offsetX, minSep);
}

/** Expected knockback vector for a fresh grounded knight victim. */
function expectedKB(m: MoveDef, facing: 1 | -1, vicWeight: number): { kx: number; ky: number; dmg: number } {
  const mag = (m.baseKnockback + m.damage * m.kbGrowth) / vicWeight;
  let dx: number, dy: number;
  if (m.angle === "aim") {
    dx = 1 * facing; dy = 0; // tests aim straight at the victim
  } else {
    const r = (m.angle * Math.PI) / 180;
    dx = Math.cos(r) * facing;
    dy = -Math.sin(r);
  }
  let kx = dx * mag;
  let ky = dy * mag;
  if (ky > 0) ky = -ky * TUNING.groundBounce; // grounded victim: spike bounces up
  return { kx, ky, dmg: m.damage };
}

for (const id of CHAR_IDS) {
  const c = CHARACTERS[id];
  describe(`${id} melee moves`, () => {
    for (const slot of SLOTS) {
      const m = c.moves[slot];
      if (m.kind !== "melee" || m.boxW <= 0) continue; // deploys/stances carry no hitbox
      it(`${m.id} (${slot}): respects startup, hits with exact damage & knockback`, () => {
        const { sim, atk, vic } = duel(id, 0); // placed properly below
        const dist = meleeDistance(atk, vic, m);
        place(atk, 800, 780);
        place(vic, 800 + dist, 780);

        let button = slot === "light" ? Btn.Light : slot === "heavy" ? Btn.Heavy : Btn.Shoot;
        if (slot === "aerial") {
          button = Btn.Light;
          place(atk, 800, 740); // lift off the ground
          steps(sim, 1); // let grounded flag clear
          expect(atk.grounded).toBe(false);
        }

        steps(sim, 1, [frame(button, 1, 0)]); // press, aiming at the victim
        expect(atk.attack?.id).toBe(m.id);
        if (m.startupTicks >= 2) {
          steps(sim, m.startupTicks - 2);
          expect(vic.damage).toBe(0); // still in startup
        }
        steps(sim, 1); // first active tick
        expect(vic.damage).toBe(m.damage);
        const kb = expectedKB(m, 1, vic.stats.weight);
        expect(vic.vx).toBeCloseTo(kb.kx, 4);
        expect(vic.vy).toBeCloseTo(kb.ky, 4);
      });
    }
  });
}

// ---------- projectile specials ----------
for (const id of CHAR_IDS) {
  const c = CHARACTERS[id];
  const m = c.moves.special;
  if (m.kind !== "projectile") continue;
  // chargeable specials fire on release and mirror-clones never travel —
  // both are covered by dedicated tests in mechanics.test.ts
  if (m.chargeable || m.projectileAtOrigin) continue;
  describe(`${id} projectile special`, () => {
    it(`${m.id}: spawns after startup, carries def, hits at range`, () => {
      const p = m.projectile!;
      const dist = p.gravityScale > 0 ? 170 : 600; // arcing shots drop — test closer
      const { sim, vic } = duel(id, dist);
      steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
      if (m.startupTicks >= 2) {
        steps(sim, m.startupTicks - 2);
        expect(sim.projectiles.length).toBe(0); // wind-up, nothing fired yet
      }
      steps(sim, 1);
      expect(sim.projectiles.length).toBe(1);
      expect(sim.projectiles[0].def).toBe(p);
      // fly until impact
      let hit = -1;
      for (let i = 0; i < p.lifeTicks + 5 && hit < 0; i++) {
        sim.step([N, N]);
        if (vic.damage > 0) hit = i;
      }
      expect(hit).toBeGreaterThanOrEqual(0);
      expect(vic.damage).toBe(p.damage);
      const mag = (p.baseKnockback + p.damage * p.kbGrowth) / vic.stats.weight;
      // direction = projectile travel direction at impact (horizontal-ish);
      // arcing shots land slightly downward and the grounded victim's ground
      // bounce shrinks the y component, so allow a small deficit
      expect(vic.vx).toBeGreaterThan(mag * 0.6);
      expect(Math.hypot(vic.vx, vic.vy)).toBeGreaterThan(mag * 0.9);
      expect(Math.hypot(vic.vx, vic.vy)).toBeLessThanOrEqual(mag + 0.5);
    });

    it(`${m.id}: cooldown blocks immediate refire`, () => {
      const { sim } = duel(id, 600);
      steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
      const total = m.startupTicks + m.activeTicks + m.recoveryTicks;
      steps(sim, total + 2);
      steps(sim, 1, [frame(Btn.Shoot, 1, 0)]); // within cooldown
      steps(sim, m.startupTicks + 2);
      expect(sim.projectiles.length).toBeLessThanOrEqual(1);
    });
  });
}

// ---------- melee special cooldown (knight shield charge) ----------
describe("melee special cooldown", () => {
  it("knight shield_charge cannot be spammed", () => {
    const { sim, atk } = duel("knight", 400);
    const m = CHARACTERS.knight.moves.special;
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    expect(atk.attack?.id).toBe(m.id);
    const total = m.startupTicks + m.activeTicks + m.recoveryTicks;
    steps(sim, total + 2);
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]); // still cooling down
    expect(atk.attack).toBeNull();
    steps(sim, m.cooldownTicks);
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    expect(atk.attack?.id).toBe(m.id);
  });

  it("knight shield_charge lunges the knight forward", () => {
    const { sim, atk } = duel("knight", 700);
    const m = CHARACTERS.knight.moves.special;
    const x0 = atk.x;
    steps(sim, 1, [frame(Btn.Shoot, 1, 0)]);
    steps(sim, m.startupTicks + m.activeTicks - 1);
    expect(atk.x).toBeGreaterThan(x0 + 80); // carried forward by the lunge
  });
});

// ---------- aerial slot wiring ----------
describe("aerial slot", () => {
  it("light button uses the aerial move while airborne, light on the ground", () => {
    const { sim, atk } = duel("knight", 400);
    steps(sim, 1, [frame(Btn.Light, 1, 0)]);
    expect(atk.attack?.id).toBe(CHARACTERS.knight.moves.light.id);
    steps(sim, 60); // finish + land
    steps(sim, 1, [frame(Btn.Jump)]);
    steps(sim, 3);
    steps(sim, 1, [frame(Btn.Light, 1, 0)]);
    expect(atk.attack?.id).toBe(CHARACTERS.knight.moves.aerial.id);
  });
});

// ---------- roster distinctness ----------
describe("roster distinctness", () => {
  it("weights span featherweight to superheavy, all different", () => {
    const weights = CHAR_IDS.map((id) => CHARACTERS[id].stats.weight);
    expect(new Set(weights).size).toBe(CHAR_IDS.length);
    expect(Math.min(...weights)).toBeLessThanOrEqual(0.75);
    expect(Math.max(...weights)).toBeGreaterThanOrEqual(1.4);
  });

  it("speed multipliers differentiate the cast", () => {
    const { goblin, ogre, ranger, mage } = CHARACTERS;
    expect(goblin.stats.speedMult).toBeGreaterThan(ranger.stats.speedMult);
    expect(ranger.stats.speedMult).toBeGreaterThan(1);
    expect(ogre.stats.speedMult).toBeLessThan(mage.stats.speedMult);
    expect(ogre.stats.speedMult).toBeLessThan(0.8);
  });

  it("goblin is the only triple-jumper", () => {
    for (const id of CHAR_IDS) {
      expect(CHARACTERS[id].stats.jumpCount).toBe(id === "goblin" ? 3 : 2);
    }
  });

  it("knight is the only character with no ranged threat at all", () => {
    // hessa fires nothing herself, but her turrets do — the roster's only
    // truly projectile-less fighter must remain the knight
    for (const id of CHAR_IDS) {
      const direct = ALL_SLOTS.some((s) => CHARACTERS[id].moves[s].kind === "projectile");
      const viaConstruct = ALL_SLOTS.some((s) => CHARACTERS[id].moves[s].construct !== undefined);
      expect(direct || viaConstruct, id).toBe(id !== "knight");
    }
  });

  it("projectile shapes differ: straight bolts, arcing arrow, lobbed bomb, heavy boulder", () => {
    expect(CHARACTERS.mage.moves.special.projectile!.gravityScale).toBe(0);
    expect(CHARACTERS.demon_queen.moves.special.projectile!.gravityScale).toBe(0);
    expect(CHARACTERS.ranger.moves.special.projectile!.gravityScale).toBeGreaterThan(0.3);
    expect(CHARACTERS.goblin.moves.special.projectile!.gravityScale).toBeGreaterThan(0.7);
    expect(CHARACTERS.ogre.moves.special.projectile!.radius).toBeGreaterThan(
      CHARACTERS.ranger.moves.special.projectile!.radius,
    );
  });

  it("frame speed spans rushdown to lumbering: goblin fastest, ogre slowest", () => {
    const lights = CHAR_IDS.map((id) => CHARACTERS[id].moves.light.startupTicks);
    expect(Math.min(...lights)).toBe(CHARACTERS.goblin.moves.light.startupTicks);
    expect(Math.max(...lights)).toBe(CHARACTERS.ogre.moves.light.startupTicks);
    expect(CHARACTERS.ogre.moves.heavy.startupTicks).toBeGreaterThanOrEqual(18);
    expect(CHARACTERS.goblin.moves.light.startupTicks).toBeLessThanOrEqual(3);
  });

  it("ogre aerial is the roster's only spike (downward fixed angle)", () => {
    const angle = CHARACTERS.ogre.moves.aerial.angle;
    expect(typeof angle).toBe("number");
    expect(angle as number).toBeLessThan(0);
    for (const id of CHAR_IDS) {
      if (id === "ogre") continue;
      const a = CHARACTERS[id].moves.aerial.angle;
      if (typeof a === "number") expect(a).toBeGreaterThanOrEqual(0);
    }
  });

  it("move ids are globally unique (ultimates included)", () => {
    const ids = CHAR_IDS.flatMap((id) => ALL_SLOTS.map((s) => CHARACTERS[id].moves[s].id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every character has a distinct signature mechanic on special or ultimate", () => {
    // the mechanic fingerprint: what special+ultimate DO beyond raw hits
    const fingerprint = (id: CharId): string => {
      const sp = CHARACTERS[id].moves.special;
      const ult = CHARACTERS[id].moves.ultimate;
      const tags: string[] = [];
      for (const m of [sp, ult]) {
        if (m.parry) tags.push("parry");
        if (m.chargeable) tags.push("charge");
        if (m.teleport) tags.push("teleport");
        if (m.construct) tags.push("construct");
        if (m.zone || m.projectile?.zoneOnDeath) tags.push("zone");
        if (m.burn || m.projectile?.burn) tags.push("burn");
        if (m.projectile?.sticky) tags.push("trap");
        if (m.selfDamage) tags.push("selfdamage");
        if (m.lungeSpeed > 0) tags.push("lunge");
        if ((m.projectileCount ?? 1) > 1) tags.push("volley");
        if (m.projectile?.homing) tags.push("homing");
      }
      return [...new Set(tags)].sort().join("+");
    };
    const prints = CHAR_IDS.map(fingerprint);
    expect(new Set(prints).size, prints.join(" | ")).toBe(CHAR_IDS.length);
    // and pyre's kindle is the only stat-level mechanic
    for (const id of CHAR_IDS) {
      expect(CHARACTERS[id].stats.kindle !== undefined, id).toBe(id === "pyre");
    }
  });
});

// ---------- full-roster smoke ----------
describe("roster smoke", () => {
  it("every matchup survives 300 ticks of chaotic inputs with finite state", () => {
    const script = [
      frame(Btn.Right | Btn.Light, 1, 0), frame(Btn.Jump), frame(Btn.Heavy, 0.7, -0.7),
      frame(Btn.Dash | Btn.Left), frame(Btn.Shoot, -1, 0), frame(Btn.Down | Btn.Jump),
      frame(Btn.Light, 0, 1), frame(0),
    ];
    for (const a of CHAR_IDS) {
      for (const b of CHAR_IDS) {
        const sim = new Sim(emberfallKeep());
        sim.addFighter(a);
        sim.addFighter(b);
        for (let i = 0; i < 300; i++) {
          sim.step([script[i % script.length], script[(i + 5) % script.length]]);
        }
        for (const f of sim.fighters) {
          expect(Number.isFinite(f.x), `${a} vs ${b}: x`).toBe(true);
          expect(Number.isFinite(f.y), `${a} vs ${b}: y`).toBe(true);
          expect(Number.isFinite(f.vx) && Number.isFinite(f.vy)).toBe(true);
        }
      }
    }
  });
});
