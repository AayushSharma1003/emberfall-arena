/**
 * Match statistics tally — consumes the sim's per-tick event stream plus a
 * damage sweep and produces the results-screen numbers (KOs, falls, damage
 * dealt/taken, MVP). Pure logic, kept in shared/ so an online server could
 * tally identically; no rendering, no sim mutation.
 *
 * Attribution rules:
 *  - damageDealt: direct hit events only (attacker >= 0, never self). Burn
 *    chip and hazards have no attacker, so per-player "dealt" can sum to
 *    less than total "taken" across a match — that's honest, not a bug.
 *  - damageTaken: any increase of the fighter's displayed damage% between
 *    ticks (catches burn ticks, hazards, self-damage). Heals and the
 *    respawn reset only ever decrease it, so they're naturally excluded.
 *  - KO credit: last direct hitter of the victim, cleared on ring-out —
 *    hazard/self-destruct falls with no prior hitter credit nobody.
 */
import type { SimEvent } from "./sim.js";

export interface FighterTally {
  kos: number;
  falls: number;
  damageDealt: number;
  damageTaken: number;
}

/** MVP weighting: stocks won the match, damage built them, falls gave them back. */
export function mvpScore(t: FighterTally): number {
  return t.kos * 100 + t.damageDealt - t.falls * 35;
}

export class MatchStatsTracker {
  readonly tallies: FighterTally[];
  private lastHitter: number[]; // -1 = nobody
  private lastDamage: number[];

  constructor(fighterCount: number) {
    this.tallies = Array.from({ length: fighterCount }, () => ({
      kos: 0, falls: 0, damageDealt: 0, damageTaken: 0,
    }));
    this.lastHitter = Array<number>(fighterCount).fill(-1);
    this.lastDamage = Array<number>(fighterCount).fill(0);
  }

  /** Call once per sim tick with that tick's events + each fighter's damage%. */
  consume(events: SimEvent[], damages: number[]): void {
    for (const e of events) {
      switch (e.t) {
        case "hit":
          // attacker -1 = stage hazard; self-hits earn nothing
          if (e.attacker >= 0 && e.attacker !== e.victim) {
            this.tallies[e.attacker].damageDealt += e.damage;
            this.lastHitter[e.victim] = e.attacker;
          }
          break;
        case "ringout": {
          this.tallies[e.id].falls++;
          const k = this.lastHitter[e.id];
          if (k >= 0) this.tallies[k].kos++;
          this.lastHitter[e.id] = -1;
          break;
        }
        default:
          break;
      }
    }
    for (let i = 0; i < damages.length; i++) {
      const d = damages[i];
      if (d > this.lastDamage[i]) this.tallies[i].damageTaken += d - this.lastDamage[i];
      this.lastDamage[i] = d;
    }
  }

  /** Index of the top scorer (ties break to the lower fighter id). */
  mvp(): number {
    let best = 0;
    for (let i = 1; i < this.tallies.length; i++) {
      if (mvpScore(this.tallies[i]) > mvpScore(this.tallies[best])) best = i;
    }
    return best;
  }
}
