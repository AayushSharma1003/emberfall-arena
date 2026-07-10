/**
 * Balance envelopes (Phase G). Numbers-only balance can't replace human
 * playtesting, but it CAN pin the roster inside sane envelopes so a future
 * tuning edit that makes one character silently dominant fails a test.
 *
 * Current measured values (2026-07) for reference:
 *   light DPS (dmg/duration*60): knight 23.3, mage 20.0, ranger 23.1,
 *     goblin 21.8, ogre 22.2, demon_queen 21.2
 *   heavy KB at 100% victim damage: goblin 1580 < ranger 1960 < knight 2350
 *     < mage 2500 < demon_queen 2520 < ogre 3050
 */
import { describe, expect, it } from "vitest";
import { CHARACTERS, CHAR_IDS, type MoveDef } from "./characters.js";

const duration = (m: MoveDef): number => m.startupTicks + m.activeTicks + m.recoveryTicks;
const kbAt = (m: MoveDef, victimDamage: number): number =>
  m.baseKnockback + (victimDamage + m.damage) * m.kbGrowth;

describe("balance envelopes", () => {
  it("light-attack DPS sits in a tight band (no jab-spam dominance)", () => {
    const dps = CHAR_IDS.map((id) => {
      const m = CHARACTERS[id].moves.light;
      return { id, dps: (m.damage / duration(m)) * 60 };
    });
    for (const { id, dps: v } of dps) {
      expect(v, `${id} light DPS`).toBeGreaterThan(15);
      expect(v, `${id} light DPS`).toBeLessThan(30);
    }
    const vals = dps.map((d) => d.dps);
    expect(Math.max(...vals) / Math.min(...vals)).toBeLessThan(1.35);
  });

  it("heavy reward scales with risk: slower startups earn bigger knockback", () => {
    const rows = CHAR_IDS.map((id) => {
      const m = CHARACTERS[id].moves.heavy;
      return { id, startup: m.startupTicks, kb100: kbAt(m, 100) };
    }).sort((a, b) => a.startup - b.startup);
    // the fastest heavy must not out-knockback the slowest
    expect(rows[0].kb100).toBeLessThan(rows[rows.length - 1].kb100 * 0.7);
    // reward-per-startup-tick stays inside an envelope (no free lunches)
    for (const r of rows) {
      const ratio = r.kb100 / r.startup;
      expect(ratio, `${r.id} heavy reward/risk`).toBeGreaterThan(120);
      expect(ratio, `${r.id} heavy reward/risk`).toBeLessThan(290);
    }
  });

  it("weight and mobility trade off (no fast heavyweights)", () => {
    for (const id of CHAR_IDS) {
      const s = CHARACTERS[id].stats;
      // product of durability and speed stays in a band: heavy = slow, fast = light
      const product = s.weight * s.speedMult;
      expect(product, `${id} weight×speed`).toBeGreaterThan(0.7);
      expect(product, `${id} weight×speed`).toBeLessThan(1.2);
    }
  });

  it("projectile damage never exceeds melee-heavy damage for the same character", () => {
    for (const id of CHAR_IDS) {
      const c = CHARACTERS[id];
      const proj = c.moves.special.projectile;
      if (!proj) continue;
      expect(proj.damage, `${id} projectile vs heavy`).toBeLessThan(c.moves.heavy.damage);
    }
  });

  it("special cooldowns scale with projectile strength", () => {
    const rows = CHAR_IDS.flatMap((id) => {
      const m = CHARACTERS[id].moves.special;
      return m.projectile ? [{ id, power: m.projectile.damage * m.projectile.baseKnockback, cd: m.cooldownTicks }] : [];
    }).sort((a, b) => a.power - b.power);
    for (let i = 1; i < rows.length; i++) {
      // stronger projectiles never have a shorter cooldown than much weaker ones
      if (rows[i].power > rows[i - 1].power * 1.5) {
        expect(rows[i].cd, `${rows[i].id} cd vs ${rows[i - 1].id}`).toBeGreaterThanOrEqual(rows[i - 1].cd);
      }
    }
  });
});
