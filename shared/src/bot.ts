/**
 * Bot AI: a per-fighter controller that reads the sim and emits InputFrames,
 * exactly like a human hand on the keys — the sim cannot tell the difference
 * and the netcode never needs to know bots exist (quick match runs them
 * locally; a server could run them identically).
 *
 * Deterministic: decisions come from a seeded PRNG + the sim state, so two
 * runs with the same seed produce byte-identical matches (tested).
 *
 * Personality is data: archetype spacing comes from the character's own
 * kit (projectile range, melee reach), difficulty from BotParams.
 */
import { Btn, type InputFrame } from "./protocol/input.js";
import {
  hazardStateAt, platformSolid, ULT_TUNING,
  type Fighter, type Sim,
} from "./sim.js";
import { CHARACTERS } from "./characters.js";

export interface BotParams {
  /** 0..1: eagerness to close distance and swing. */
  aggression: number;
  /** Ticks between re-decisions (lower = sharper). */
  reaction: number;
  /** 0..1: recovery skill, hazard respect, spacing discipline. */
  wisdom: number;
}

export function botLevel(level: 1 | 2 | 3): BotParams {
  switch (level) {
    case 1: return { aggression: 0.35, reaction: 24, wisdom: 0.3 };
    case 2: return { aggression: 0.6, reaction: 14, wisdom: 0.6 };
    case 3: return { aggression: 0.85, reaction: 8, wisdom: 0.9 };
  }
}

/** mulberry32 — tiny deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Zoners keep their distance; everyone else wants reach-range. Archetype
 * comes from the character's ROLE — a rushdown with a pocket firecracker
 * (Snik) still fights in your face.
 */
const RANGED_ROLES = new Set(["Spellweaver", "Trapper", "Elementalist", "Forgewright"]);

function preferredRange(f: Fighter): number {
  if (!RANGED_ROLES.has(CHARACTERS[f.charId].role)) {
    return Math.max(60, f.moves.light.reach * 0.9);
  }
  const speed = f.moves.special.projectile?.speed ?? 0;
  return speed > 1200 ? 560 : 440;
}

export class BotController {
  private rand: () => number;
  private decideAt = 0;
  private move: InputFrame = { buttons: 0, aimX: 1, aimY: 0 };
  private holdSpecial = 0;
  private jumpHeldTicks = 0;

  constructor(
    private sim: Sim,
    private id: number,
    private params: BotParams,
    seed = 1,
  ) {
    this.rand = prng(seed * 7919 + id * 104729 + 1);
  }

  /** Stage bounds = the union of all solid ground (multi-island maps count both islands). */
  private stageBounds(): { left: number; right: number; top: number } {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    for (const p of this.sim.stage.platforms) {
      if (p.soft || p.motion || p.phasing) continue; // only trust permanent ground
      left = Math.min(left, p.x);
      right = Math.max(right, p.x + p.w);
      top = Math.min(top, p.y);
    }
    if (!Number.isFinite(left)) {
      const p0 = this.sim.stage.platforms[0];
      return { left: p0.x, right: p0.x + p0.w, top: p0.y };
    }
    return { left, right, top };
  }

  private nearestEnemy(me: Fighter): Fighter | null {
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (const f of this.sim.fighters) {
      if (f.id === me.id || f.team === me.team || f.state === "dead") continue;
      const d = Math.hypot(f.x - me.x, f.y - me.y);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  /** One InputFrame per sim tick. */
  tick(): InputFrame {
    const me = this.sim.fighters[this.id];
    if (!me || me.state === "dead") return { buttons: 0, aimX: 0, aimY: 0 };

    const stage = this.stageBounds();
    const margin = 40;
    const offStage = me.x < stage.left - margin || me.x > stage.right + margin;
    const belowStage = me.y > stage.top + 60;

    // --- survival overrides everything (checked every tick, not on cadence) ---
    if (offStage || (belowStage && !me.grounded)) {
      return this.recover(me, stage);
    }

    // sustain held buttons between decisions
    if (this.holdSpecial > 0) {
      this.holdSpecial--;
      const held = this.move.buttons | Btn.Special;
      return { buttons: this.holdSpecial > 0 ? held : held & ~Btn.Special, aimX: this.move.aimX, aimY: this.move.aimY };
    }

    if (this.sim.tick < this.decideAt) {
      // keep holding jump briefly for full hops
      if (this.jumpHeldTicks > 0) {
        this.jumpHeldTicks--;
        return this.move;
      }
      return { ...this.move, buttons: this.move.buttons & ~(Btn.Jump | Btn.Light | Btn.Heavy | Btn.Special | Btn.Ultimate | Btn.Dash) };
    }
    this.decideAt = this.sim.tick + this.params.reaction;

    // --- hazard respect: standing in a warning zone? leave, whatever else is happening ---
    if (this.params.wisdom > 0.4) {
      for (const h of this.sim.stage.hazards ?? []) {
        const state = hazardStateAt(h, this.sim.tick);
        if (state === "idle") continue;
        const inside = me.x > h.x - 40 && me.x < h.x + h.w + 40 && me.y > h.y && me.y < h.y + h.h + 60;
        if (inside) {
          const exitLeft = Math.abs(me.x - h.x) < Math.abs(h.x + h.w - me.x);
          let buttons = exitLeft ? Btn.Left : Btn.Right;
          buttons |= Btn.Dash;
          this.move = { buttons, aimX: exitLeft ? -1 : 1, aimY: 0 };
          return this.move;
        }
      }
    }

    const target = this.nearestEnemy(me);
    if (!target) {
      this.move = { buttons: 0, aimX: me.facing, aimY: 0 };
      return this.move;
    }

    const dx = target.x - me.x;
    const dy = target.y - target.stats.height / 2 - (me.y - me.stats.height / 2);
    const dist = Math.hypot(dx, dy);
    const aimX = dx / (dist || 1);
    const aimY = dy / (dist || 1);
    let buttons = 0;

    const range = preferredRange(me);
    const meleeReach = Math.max(me.moves.light.reach, me.moves.heavy.angle === "aim" ? me.moves.heavy.reach : me.moves.heavy.offsetX) + 25;
    const roll = this.rand();

    // --- spacing ---
    if (dist > range + 80) {
      buttons |= dx > 0 ? Btn.Right : Btn.Left;
      if (roll < this.params.aggression * 0.25 && dist > 420) buttons |= Btn.Dash;
    } else if (dist < range - 120 && range > 300) {
      // zoner: too close, back off
      buttons |= dx > 0 ? Btn.Left : Btn.Right;
      if (roll < 0.2) buttons |= Btn.Dash;
    } else if (roll < 0.25) {
      // strafe a little so it doesn't look robotic
      buttons |= roll < 0.125 ? Btn.Left : Btn.Right;
    }

    // --- vertical chase ---
    if (dy < -140 && me.grounded && roll < 0.8) {
      buttons |= Btn.Jump;
      this.jumpHeldTicks = 10;
    } else if (dy > 140 && me.grounded && this.onSoft(me) && roll < 0.6) {
      buttons |= Btn.Down | Btn.Jump; // drop through
    } else if (!me.grounded && me.vy > 0 && dy > 200 && roll < 0.5) {
      buttons |= Btn.Down; // fast-fall onto them
    }

    // --- offense ---
    // committing to attack frames while airborne near an edge is how bots
    // die under the stage: specials only from the ground, aerials only in range
    const canMelee = dist < meleeReach && Math.abs(dy) < 110;
    const attackRoll = this.rand();
    if (me.ult >= ULT_TUNING.max && me.grounded && (dist < 420 || (range > 300 && attackRoll < 0.5))) {
      buttons |= Btn.Ultimate;
    } else if (canMelee && attackRoll < 0.45 + this.params.aggression * 0.4) {
      // heavy for kill confirms on damaged targets, light otherwise
      buttons |= target.damage > 85 && attackRoll < 0.55 ? Btn.Heavy : Btn.Light;
    } else if (
      me.grounded && me.specialCooldown === 0 &&
      dist > 240 && Math.abs(aimY) < 0.75 &&
      attackRoll < 0.5 + this.params.aggression * 0.3
    ) {
      if (me.moves.special.chargeable) {
        // charge shots: commit to a hold, release comes automatically
        this.holdSpecial = 12 + Math.floor(this.rand() * (me.moves.special.chargeable.maxTicks - 6));
      }
      buttons |= Btn.Special;
    }

    // --- defense: shaken at high damage ---
    if (me.damage > 110 && dist < 200 && this.rand() < this.params.wisdom * 0.5) {
      buttons &= ~(Btn.Left | Btn.Right);
      buttons |= dx > 0 ? Btn.Left : Btn.Right; // disengage
      buttons |= Btn.Dash;
    }

    this.move = { buttons, aimX, aimY };
    return this.move;
  }

  private onSoft(me: Fighter): boolean {
    for (const p of this.sim.stage.platforms) {
      if (!p.soft || !platformSolid(p, this.sim.tick)) continue;
      if (me.x > p.x - 20 && me.x < p.x + p.w + 20 && Math.abs(me.y - p.y) < 4) return true;
    }
    return false;
  }

  /** Get back to the stage: face center, jump on the way up, dash the gap. */
  private recover(me: Fighter, stage: { left: number; right: number; top: number }): InputFrame {
    const cx = (stage.left + stage.right) / 2;
    const toCenter = cx > me.x ? 1 : -1;
    let buttons = toCenter > 0 ? Btn.Right : Btn.Left;
    const horizontalGap = Math.min(Math.abs(me.x - stage.left), Math.abs(me.x - stage.right));

    // burn double jumps while falling, spaced out so they actually help —
    // and HOLD the button, or the variable-height cut wastes half the jump
    if (this.jumpHeldTicks > 0) {
      this.jumpHeldTicks--;
      buttons |= Btn.Jump;
    } else if (me.vy > 200 && me.jumpsUsed < me.stats.jumpCount && this.sim.tick % 14 === 0) {
      buttons |= Btn.Jump;
      this.jumpHeldTicks = 9;
    }
    // air dash toward the stage when the gap is wide and we're high enough
    if (!me.airDashUsed && horizontalGap > 180 && me.y < stage.top + 260 && this.rand() < 0.6) {
      buttons |= Btn.Dash;
    }
    this.move = { buttons, aimX: toCenter, aimY: 0 };
    return this.move;
  }
}
