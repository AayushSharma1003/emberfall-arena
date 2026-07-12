/**
 * Client-side prediction, reconciliation, and remote-entity interpolation.
 * Pure and renderer-free so the whole thing runs headless under simulated
 * latency/packet-loss in tests (see server/src/netcode.test.ts).
 *
 * Model:
 *  - The client runs the SAME shared Sim, `lead` ticks ahead of the server,
 *    predicting only its own fighter (remote fighters get neutral inputs
 *    between snapshots; they are RENDERED from the Interpolator instead).
 *  - Every server snapshot is loaded verbatim, then all pending local
 *    inputs newer than the snapshot are re-simulated (reconciliation).
 *  - `lead` self-tunes: if the server reports starving for our inputs we
 *    predict further ahead; if we are needlessly early we pull back.
 */
import { Sim, type Stage, type SimEvent } from "./sim.js";
import type { InputFrame, TickInput } from "./protocol/input.js";
import { applySimSnap, type ConstructSnap, type SimSnap, type FighterSnap, type ProjSnap } from "./snapshot.js";
import type { CharId } from "./characters.js";
import { DT } from "./sim.js";

export const INTERP_DELAY_TICKS = 8; // remote entities render ~133ms in the past
const MIN_LEAD = 2;
const MAX_LEAD = 12;
const MAX_PENDING = 240;

export class Predictor {
  readonly sim: Sim;
  readonly myId: number;
  lead: number;
  /** Diagnostics: total reconciliation corrections applied (px). */
  lastCorrection = 0;
  private pending: TickInput[] = [];

  constructor(
    stage: Stage,
    roster: { charId: CharId; team?: number }[],
    myId: number,
    serverTick: number,
    lead = 4,
  ) {
    this.sim = new Sim(stage);
    for (const r of roster) this.sim.addFighter(r.charId, r.team);
    this.myId = myId;
    this.lead = Math.max(MIN_LEAD, Math.min(MAX_LEAD, lead));
    this.sim.tick = serverTick;
    for (let i = 0; i < this.lead; i++) this.sim.step(this.neutral());
  }

  private neutral(): InputFrame[] {
    return this.sim.fighters.map(() => ({ buttons: 0, aimX: 0, aimY: 0 }));
  }

  get predictedTick(): number {
    return this.sim.tick;
  }

  /** Inputs sent but not yet acknowledged by a snapshot (test/diagnostic). */
  get pendingInputs(): readonly TickInput[] {
    return this.pending;
  }

  /** Advance one predicted tick with the local player's input. */
  step(my: InputFrame): { events: SimEvent[]; toSend: TickInput } {
    const toSend: TickInput = { tick: this.sim.tick + 1, buttons: my.buttons, aimX: my.aimX, aimY: my.aimY };
    this.pending.push(toSend);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    const inputs = this.neutral();
    inputs[this.myId] = my;
    const events = this.sim.step(inputs);
    return { events, toSend };
  }

  /**
   * Authoritative snapshot: load it, drop acknowledged inputs, re-simulate
   * the pending ones. `lastInput` is the newest input tick the server had
   * from us — used to self-tune the prediction lead.
   */
  applySnapshot(snap: SimSnap, lastInput: number): void {
    let targetTick = this.sim.tick;
    // lead tuning: starved server -> predict further ahead; overly early -> pull back
    if (lastInput < snap.tick && this.lead < MAX_LEAD) {
      this.lead++;
      targetTick++;
    } else if (lastInput > snap.tick + 4 && this.lead > MIN_LEAD) {
      this.lead--;
      targetTick = Math.max(snap.tick, targetTick - 1);
    }

    const me = this.sim.fighters[this.myId];
    const beforeX = me.x, beforeY = me.y;

    applySimSnap(this.sim, snap);
    this.pending = this.pending.filter((i) => i.tick > snap.tick);

    for (const ti of this.pending) {
      if (ti.tick <= this.sim.tick) continue;
      while (this.sim.tick < ti.tick - 1 && this.sim.tick < targetTick) this.sim.step(this.neutral());
      if (this.sim.tick >= targetTick) break;
      const inputs = this.neutral();
      inputs[this.myId] = ti;
      this.sim.step(inputs);
    }
    while (this.sim.tick < targetTick) this.sim.step(this.neutral());

    this.lastCorrection = Math.hypot(me.x - beforeX, me.y - beforeY);
  }
}

// ---------- remote-entity interpolation ----------

export interface InterpSample {
  fighters: FighterSnap[];
  projectiles: ProjSnap[];
  constructs: ConstructSnap[];
  zones: SimSnap["zones"];
  items: SimSnap["items"];
}

export class Interpolator {
  private buf: SimSnap[] = [];

  push(snap: SimSnap): void {
    // insert sorted by tick, ignore duplicates/stale
    const last = this.buf[this.buf.length - 1];
    if (last && snap.tick <= last.tick) {
      if (snap.tick === last.tick) return;
      const i = this.buf.findIndex((s) => s.tick >= snap.tick);
      if (this.buf[i]?.tick === snap.tick) return;
      this.buf.splice(i < 0 ? this.buf.length : i, 0, snap);
    } else {
      this.buf.push(snap);
    }
    while (this.buf.length > 40) this.buf.shift();
  }

  latestTick(): number {
    return this.buf.length ? this.buf[this.buf.length - 1].tick : -1;
  }

  /** Interpolated view at a (possibly fractional) tick. Null until 1+ snapshots. */
  sample(tick: number): InterpSample | null {
    if (this.buf.length === 0) return null;
    // find bracketing snapshots
    let a = this.buf[0];
    let b = this.buf[this.buf.length - 1];
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i].tick <= tick) a = this.buf[i];
      if (this.buf[i].tick >= tick) { b = this.buf[i]; break; }
    }
    const span = b.tick - a.tick;
    const t = span > 0 ? Math.max(0, Math.min(1, (tick - a.tick) / span)) : 0;

    const fighters = a.fighters.map((fa): FighterSnap => {
      const fb = b.fighters.find((x) => x.id === fa.id) ?? fa;
      return {
        ...(t < 0.5 ? fa : fb), // discrete fields snap at the midpoint
        x: fa.x + (fb.x - fa.x) * t,
        y: fa.y + (fb.y - fa.y) * t,
        aimX: fa.aimX + (fb.aimX - fa.aimX) * t,
        aimY: fa.aimY + (fb.aimY - fa.aimY) * t,
      };
    });

    // projectiles: dead-reckon from the earlier snapshot (no stable ids to lerp by)
    const dt = Math.max(0, tick - a.tick) * DT;
    const projectiles = a.projectiles.map((p): ProjSnap => ({
      ...p,
      x: p.x + p.vx * dt,
      y: p.y + p.vy * dt + (p.armed ? 0 : 0.5 * 3400 * p.def.gravityScale * dt * dt),
    }));

    return { fighters, projectiles, constructs: a.constructs, zones: a.zones, items: a.items };
  }
}
