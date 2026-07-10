/**
 * Fixed-tick side-view fighter simulation. v3 — lives in shared/ and is
 * imported by BOTH the client (prediction) and the server (authority), so
 * client/server determinism is structural: there is exactly one sim.
 *
 * Renderer-agnostic: no Pixi, no DOM, no wall-clock time. Only ticks
 * and InputFrames in, events out.
 *
 * Units: world pixels (1920x1080 reference), seconds via DT.
 */
import { Btn, has, type InputFrame } from "./protocol/input.js";
import {
  CHARACTERS,
  type CharacterDef, type CharacterStats, type CharId,
  type MoveDef, type Moveset, type ProjectileDef,
} from "./characters.js";

export const SIM_HZ = 60;
export const DT = 1 / SIM_HZ;
export const SOLID_DEPTH = 220; // visual + collision thickness of solid platforms

// ---------- Tuning (the "feels good" numbers - tweak these live) ----------
export const TUNING = {
  gravity: 3400, // px/s^2
  runSpeed: 620,
  groundAccel: 5200,
  groundFriction: 4600,
  airAccel: 2600,
  airFriction: 300,
  jumpVel: 1290, // peak ~245px ~ 2.2 character heights
  doubleJumpVel: 1180,
  jumpCutMultiplier: 0.45, // release jump early -> vy *= this
  fastFallVel: 1500,
  maxFallVel: 1250,
  coyoteTimeTicks: 6, // ~100ms
  jumpBufferTicks: 7, // ~115ms
  attackBufferTicks: 8, // press attack while busy -> fires on first free tick (~130ms)
  dropThroughTicks: 14,
  hitstunBase: 12,
  hitstunGrowth: 0.35, // extra hitstun ticks per % damage
  hitstopLight: 4,
  hitstopHeavy: 8,
  respawnInvulnTicks: 90,
  groundBounce: 0.6, // downward knockback into ground reflects up at this ratio
  bodyPushPerTick: 8, // max px/tick two overlapping fighters push apart
  dashSpeed: 1500,
  dashTicks: 9, // dash duration (~150ms)
  dashCooldownTicks: 42, // ~0.7s
  dashEndDamp: 0.45, // vx *= this when dash ends
} as const;

// ---------- World geometry ----------
export interface Platform {
  x: number;
  y: number; // top surface
  w: number;
  soft: boolean; // soft = drop-through, thin
}

export interface BlastZone { left: number; right: number; top: number; bottom: number; }

export interface Stage {
  platforms: Platform[];
  blast: BlastZone;
  spawns: { x: number; y: number }[];
  /** Where items may appear (empty array = no items on this stage). */
  itemSpawns: { x: number; y: number }[];
}

/** Map 1 placeholder: Battlefield-style - one main platform, two soft floats. */
export function emberfallKeep(): Stage {
  return {
    platforms: [
      { x: 460, y: 780, w: 1000, soft: false },
      { x: 610, y: 560, w: 260, soft: true },
      { x: 1050, y: 560, w: 260, soft: true },
    ],
    blast: { left: -350, right: 2270, top: -450, bottom: 1500 },
    spawns: [
      { x: 760, y: 700 },
      { x: 1160, y: 700 },
      { x: 560, y: 700 }, // P3/P4 (2v2)
      { x: 1360, y: 700 },
    ],
    itemSpawns: [
      { x: 740, y: 520 }, // on the soft floats
      { x: 1180, y: 520 },
      { x: 960, y: 730 }, // center stage
    ],
  };
}

// ---------- Items ----------
export type ItemKind = "heart" | "wings" | "bomb";
export const ITEM_KINDS: ItemKind[] = ["heart", "wings", "bomb"];
export const ITEM_RADIUS = 22;

export interface WorldItem {
  kind: ItemKind;
  x: number;
  y: number;
}

export const ITEM_TUNING = {
  spawnIntervalTicks: 600, // one item every 10s…
  maxActive: 2, // …unless 2 are already on the field
  heartHeal: 35, // damage% removed
  wingsBoostTicks: 300, // 5s of +25% run speed (jumps/air-dash also refreshed)
  wingsSpeedMult: 1.25,
} as const;

/** The bomb item throws this on pickup, owned by the picker, up-forward along facing. */
export const ITEM_BOMB_PROJ: ProjectileDef = {
  speed: 1100, damage: 14, baseKnockback: 640, kbGrowth: 15,
  radius: 16, gravityScale: 0.8, lifeTicks: 90, hitstop: 8,
};

// ---------- Attacks ----------
// Frame data / hitbox schema lives in shared/src/characters.ts (MoveDef,
// ProjectileDef, CharacterDef) so the server sim reuses it verbatim.

/** Degrees (0 = toward facing, 90 = up) -> unit vector, mirrored by facing. */
function angleToDir(deg: number, facing: 1 | -1): { x: number; y: number } {
  const r = (deg * Math.PI) / 180;
  return { x: Math.cos(r) * facing, y: -Math.sin(r) };
}

export type FighterState =
  | "idle" | "run" | "jump" | "fall" | "dash"
  | "attack" | "hitstun" | "dead";

export interface Fighter {
  id: number;
  /** 2v2: fighters on the same team can't hit each other (unless friendlyFire). */
  team: number;
  charId: CharId;
  stats: CharacterStats;
  moves: Moveset;
  x: number; y: number; // origin = bottom-center of hurtbox
  vx: number; vy: number;
  facing: 1 | -1;
  aimX: number; aimY: number; // current aim (unit vector)
  grounded: boolean;
  jumpsUsed: number;
  jumpHeld: boolean;
  state: FighterState;
  damage: number; // damage percent
  stocks: number;
  // timers (ticks)
  coyote: number;
  jumpBuffer: number;
  dropThrough: number;
  /** Wings item: remaining ticks of +25% run speed. */
  speedBoost: number;
  hitstun: number;
  invuln: number;
  respawnTimer: number;
  dashTicks: number;
  dashCooldown: number;
  airDashUsed: boolean;
  specialCooldown: number;
  // attack bookkeeping
  attack: MoveDef | null;
  attackTick: number;
  bufSlot: "light" | "heavy" | "special" | null; // buffered attack press (light resolves to aerial at fire time)
  bufTicks: number;
  atkAimX: number; atkAimY: number; // aim locked at press (hitbox placement, projectiles, aimed lunges)
  atkDirX: number; atkDirY: number; // knockback direction locked at press (aim or fixed angle)
  hitConfirmed: boolean;
  prevButtons: number;
}

export interface Projectile {
  owner: number;
  x: number; y: number;
  vx: number; vy: number;
  life: number;
  def: ProjectileDef;
}

export function makeFighter(id: number, spawn: { x: number; y: number }, char: CharacterDef = CHARACTERS.knight, team = id % 2): Fighter {
  return {
    id,
    team,
    charId: char.id,
    stats: { ...char.stats },
    moves: char.moves,
    x: spawn.x, y: spawn.y, vx: 0, vy: 0,
    facing: 1, aimX: 1, aimY: 0,
    grounded: false, jumpsUsed: 0, jumpHeld: false,
    state: "fall", damage: 0, stocks: 3,
    coyote: 0, jumpBuffer: 0, dropThrough: 0, speedBoost: 0,
    hitstun: 0, invuln: 0, respawnTimer: 0,
    dashTicks: 0, dashCooldown: 0, airDashUsed: false, specialCooldown: 0,
    attack: null, attackTick: 0, bufSlot: null, bufTicks: 0,
    atkAimX: 1, atkAimY: 0, atkDirX: 1, atkDirY: 0,
    hitConfirmed: false, prevButtons: 0,
  };
}

// ---------- Events (renderer subscribes for VFX/juice) ----------
export type SimEvent =
  | { t: "hit"; attacker: number; victim: number; damage: number; heavy: boolean; x: number; y: number; kx: number; ky: number }
  | { t: "ringout"; id: number; x: number; y: number }
  | { t: "respawn"; id: number }
  | { t: "land"; id: number; x: number; y: number }
  | { t: "jump"; id: number; double: boolean; x: number; y: number }
  | { t: "dash"; id: number; x: number; y: number; dir: number }
  | { t: "shoot"; id: number; x: number; y: number }
  | { t: "projdie"; x: number; y: number }
  | { t: "itemspawn"; kind: ItemKind; x: number; y: number }
  | { t: "item"; kind: ItemKind; id: number; x: number; y: number };

// ---------- helpers ----------
function aabbOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** Fighter hurtbox as top-left AABB. */
function hurtbox(f: Fighter): { x: number; y: number; w: number; h: number } {
  return { x: f.x - f.stats.width / 2, y: f.y - f.stats.height, w: f.stats.width, h: f.stats.height };
}

/** Public alias (server lag-compensation history needs it). */
export const hurtboxOf = hurtbox;

/**
 * Attack hitbox in world space. Aimed moves: box centered `reach` px along
 * the locked aim. Fixed-angle moves: box at (offsetX * facing, offsetY)
 * from body center. Standalone so the renderer's hitbox overlay can use it
 * without a Sim instance.
 */
export function attackBoxOf(f: Fighter, a: MoveDef): { x: number; y: number; w: number; h: number } {
  let cx: number, cy: number;
  if (a.angle === "aim") {
    cx = f.x + f.atkAimX * a.reach;
    cy = f.y - f.stats.height / 2 + f.atkAimY * a.reach;
  } else {
    cx = f.x + a.offsetX * f.facing;
    cy = f.y - f.stats.height / 2 + a.offsetY;
  }
  return { x: cx - a.boxW / 2, y: cy - a.boxH / 2, w: a.boxW, h: a.boxH };
}

export type HitRewindFn = (
  attacker: Fighter,
  victim: Fighter,
) => { x: number; y: number; w: number; h: number } | null;

// ---------- The world ----------
export class Sim {
  tick = 0;
  hitstop = 0; // global freeze ticks
  fighters: Fighter[] = [];
  projectiles: Projectile[] = [];
  events: SimEvent[] = [];
  /**
   * Server-only lag compensation: when set, melee hit tests use the returned
   * (historical) victim hurtbox instead of the live one. Never set on
   * clients — the pure sim stays deterministic; the server is authoritative
   * so its rewound outcomes flow back through snapshots.
   */
  hitRewind: HitRewindFn | null = null;
  /** 2v2 design default: teammates cannot damage each other. Flip for chaos mode. */
  friendlyFire = false;
  /** Items on the field. Spawn timing/kind derive from the tick — deterministic, nothing to sync. */
  items: WorldItem[] = [];
  itemsEnabled = true;

  constructor(public stage: Stage) {}

  addFighter(charId: CharId = "knight", team?: number): Fighter {
    const id = this.fighters.length;
    const f = makeFighter(
      id,
      this.stage.spawns[id % this.stage.spawns.length],
      CHARACTERS[charId],
      team ?? id % 2,
    );
    this.fighters.push(f);
    return f;
  }

  /** Swap a fighter's character in place (dev hotseat select; lobby uses it too). */
  setCharacter(id: number, charId: CharId): void {
    const f = this.fighters[id];
    if (!f) return;
    const c = CHARACTERS[charId];
    f.charId = c.id;
    f.stats = { ...c.stats };
    f.moves = c.moves;
    f.attack = null;
    f.attackTick = 0;
    f.hitConfirmed = false;
  }

  /** Advance one fixed tick. */
  step(inputs: InputFrame[]): SimEvent[] {
    this.events = [];
    this.tick++;

    if (this.hitstop > 0) {
      this.hitstop--;
      return this.events; // world frozen - this is the "punch" in punchy
    }

    for (const f of this.fighters) {
      this.stepFighter(f, inputs[f.id] ?? { buttons: 0, aimX: 0, aimY: 0 });
    }
    this.stepProjectiles();
    this.resolveMelee();
    this.resolveBodyPush();
    this.stepItems();
    return this.events;
  }

  // ---------------- items ----------------
  private stepItems(): void {
    if (!this.itemsEnabled || this.stage.itemSpawns.length === 0) return;

    // deterministic spawn rotation: kind and location cycle with the tick
    if (
      this.tick % ITEM_TUNING.spawnIntervalTicks === 0 &&
      this.items.length < ITEM_TUNING.maxActive
    ) {
      const n = this.tick / ITEM_TUNING.spawnIntervalTicks;
      const kind = ITEM_KINDS[n % ITEM_KINDS.length];
      const at = this.stage.itemSpawns[n % this.stage.itemSpawns.length];
      // don't stack two items on the same point
      if (!this.items.some((it) => it.x === at.x && it.y === at.y)) {
        this.items.push({ kind, x: at.x, y: at.y });
        this.events.push({ t: "itemspawn", kind, x: at.x, y: at.y });
      }
    }

    // pickup: first overlapping live fighter (by id — deterministic)
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      for (const f of this.fighters) {
        if (f.state === "dead") continue;
        const hb = hurtbox(f);
        if (!aabbOverlap(it.x - ITEM_RADIUS, it.y - ITEM_RADIUS, ITEM_RADIUS * 2, ITEM_RADIUS * 2, hb.x, hb.y, hb.w, hb.h)) continue;
        this.applyItem(f, it);
        this.items.splice(i, 1);
        break;
      }
    }
  }

  /** All items are instant-effect on pickup (use = pickup; keeps inputs untouched). */
  private applyItem(f: Fighter, it: WorldItem): void {
    switch (it.kind) {
      case "heart":
        f.damage = Math.max(0, f.damage - ITEM_TUNING.heartHeal);
        break;
      case "wings":
        f.jumpsUsed = 0;
        f.airDashUsed = false;
        f.speedBoost = ITEM_TUNING.wingsBoostTicks;
        break;
      case "bomb": {
        // auto-thrown up-forward along facing, owned by the picker
        const def = ITEM_BOMB_PROJ;
        this.projectiles.push({
          owner: f.id,
          x: f.x + f.facing * 30,
          y: f.y - f.stats.height * 0.7,
          vx: f.facing * def.speed * 0.75,
          vy: -def.speed * 0.6,
          life: def.lifeTicks,
          def,
        });
        break;
      }
    }
    this.events.push({ t: "item", kind: it.kind, id: f.id, x: it.x, y: it.y });
  }

  // ---------------- fighters ----------------
  private stepFighter(f: Fighter, input: InputFrame): void {
    const buttons = input.buttons;
    const pressed = buttons & ~f.prevButtons;
    f.prevButtons = buttons;

    if (f.state === "dead") {
      if (f.respawnTimer > 0 && --f.respawnTimer === 0 && f.stocks > 0) this.respawn(f);
      return;
    }

    // --- timers ---
    if (f.invuln > 0) f.invuln--;
    if (f.coyote > 0) f.coyote--;
    if (f.jumpBuffer > 0) f.jumpBuffer--;
    if (f.dropThrough > 0) f.dropThrough--;
    if (f.dashCooldown > 0) f.dashCooldown--;
    if (f.specialCooldown > 0) f.specialCooldown--;
    if (f.speedBoost > 0) f.speedBoost--;
    const inHitstun = f.hitstun > 0;
    if (inHitstun) f.hitstun--;
    const attacking = f.attack !== null;
    const dashing = f.dashTicks > 0;

    // --- aim: input aim if present, else facing ---
    if (input.aimX !== 0 || input.aimY !== 0) {
      const m = Math.hypot(input.aimX, input.aimY);
      f.aimX = input.aimX / m;
      f.aimY = input.aimY / m;
    } else {
      f.aimX = f.facing;
      f.aimY = 0;
    }

    // --- horizontal input ---
    let move = 0;
    if (!inHitstun && !attacking && !dashing) {
      if (has(buttons, Btn.Left)) move -= 1;
      if (has(buttons, Btn.Right)) move += 1;
      if (move !== 0) f.facing = move as 1 | -1;
      else if (Math.abs(f.aimX) > 0.25) f.facing = f.aimX > 0 ? 1 : -1; // face your cursor when idle
    }

    if (!dashing) {
      // same accel/friction/cap mechanic as Phase 0; speedMult scales the numbers per character
      const boost = f.speedBoost > 0 ? ITEM_TUNING.wingsSpeedMult : 1;
      const accel = (f.grounded ? TUNING.groundAccel : TUNING.airAccel) * f.stats.speedMult * boost;
      const friction = f.grounded ? TUNING.groundFriction : TUNING.airFriction;
      const topSpeed = TUNING.runSpeed * f.stats.speedMult * boost;
      if (move !== 0) {
        f.vx += move * accel * DT;
        // cap self-driven speed only; knockback may exceed and decays via friction
        if (!inHitstun && Math.abs(f.vx) > topSpeed && Math.sign(f.vx) === move) {
          f.vx = move * topSpeed;
        }
      } else {
        const drop = friction * DT;
        f.vx = Math.abs(f.vx) <= drop ? 0 : f.vx - Math.sign(f.vx) * drop;
      }
    }

    // --- dash ---
    if (
      (pressed & Btn.Dash) && !inHitstun && !attacking && !dashing &&
      f.dashCooldown === 0 && (f.grounded || !f.airDashUsed)
    ) {
      const dir = move !== 0 ? move : Math.abs(f.aimX) > 0.2 ? Math.sign(f.aimX) : f.facing;
      f.dashTicks = TUNING.dashTicks;
      f.dashCooldown = TUNING.dashCooldownTicks;
      f.vx = dir * TUNING.dashSpeed;
      f.vy = 0;
      f.facing = dir as 1 | -1;
      if (!f.grounded) f.airDashUsed = true;
      this.events.push({ t: "dash", id: f.id, x: f.x, y: f.y, dir });
    }
    if (f.dashTicks > 0) {
      f.dashTicks--;
      if (f.dashTicks === 0) f.vx *= TUNING.dashEndDamp;
    }

    // --- jumping (buffer + coyote are the feel secrets) ---
    if (pressed & Btn.Jump) f.jumpBuffer = TUNING.jumpBufferTicks;
    const canGroundJump = f.grounded || f.coyote > 0;

    if (f.jumpBuffer > 0 && !inHitstun && !attacking && !dashing) {
      if (canGroundJump) {
        if (f.grounded && has(buttons, Btn.Down) && this.onSoftPlatform(f)) {
          f.dropThrough = TUNING.dropThroughTicks;
          f.grounded = false;
        } else {
          f.vy = -TUNING.jumpVel * f.stats.jumpMult;
          f.grounded = false;
          f.coyote = 0;
          f.jumpsUsed = 1;
          // only arm the jump-cut if the button is still down when the
          // buffered jump fires — otherwise buffered jumps short-hop by accident
          f.jumpHeld = has(buttons, Btn.Jump);
          this.events.push({ t: "jump", id: f.id, double: false, x: f.x, y: f.y });
        }
        f.jumpBuffer = 0;
      } else if (f.jumpsUsed < f.stats.jumpCount) {
        f.vy = -TUNING.doubleJumpVel * f.stats.jumpMult;
        f.jumpsUsed++;
        f.jumpHeld = has(buttons, Btn.Jump);
        f.jumpBuffer = 0;
        this.events.push({ t: "jump", id: f.id, double: true, x: f.x, y: f.y });
      }
    }
    // variable jump height: releasing jump while rising cuts velocity
    if (f.jumpHeld && !has(buttons, Btn.Jump)) {
      f.jumpHeld = false;
      if (f.vy < 0) f.vy *= TUNING.jumpCutMultiplier;
    }

    // --- attacks: aim is locked at the moment the move fires ---
    // Slots: Light -> light (ground) / aerial (airborne), Heavy -> heavy,
    // Special button -> special (melee or projectile, may have a cooldown).
    // Presses made while busy (recovery/hitstun/dash) are buffered for
    // attackBufferTicks and fire on the first free tick — no eaten inputs.
    if (pressed & Btn.Light) { f.bufSlot = "light"; f.bufTicks = TUNING.attackBufferTicks; }
    else if (pressed & Btn.Heavy) { f.bufSlot = "heavy"; f.bufTicks = TUNING.attackBufferTicks; }
    else if (pressed & (Btn.Shoot | Btn.Special)) { f.bufSlot = "special"; f.bufTicks = TUNING.attackBufferTicks; }
    else if (f.bufTicks > 0 && --f.bufTicks === 0) f.bufSlot = null;

    if (f.bufSlot && !inHitstun && !attacking && !dashing) {
      if (f.bufSlot === "light") {
        this.startAttack(f, f.grounded ? f.moves.light : f.moves.aerial);
        f.bufSlot = null;
      } else if (f.bufSlot === "heavy") {
        this.startAttack(f, f.moves.heavy);
        f.bufSlot = null;
      } else if (f.specialCooldown === 0) {
        this.startAttack(f, f.moves.special);
        f.specialCooldown = f.moves.special.cooldownTicks;
        f.bufSlot = null;
      }
    }
    if (f.attack) {
      f.attackTick++;
      const a = f.attack;
      if (f.attackTick === a.startupTicks) {
        // first active tick: lunges fire and projectiles leave the barrel
        if (a.lungeSpeed > 0) {
          if (a.angle === "aim") {
            f.vx = f.atkAimX * a.lungeSpeed;
            f.vy = f.atkAimY * a.lungeSpeed;
          } else {
            f.vx = f.facing * a.lungeSpeed; // fixed-angle moves lunge horizontally
          }
        }
        if (a.kind === "projectile" && a.projectile) this.spawnProjectile(f, a.projectile);
      }
      if (f.attackTick >= a.startupTicks + a.activeTicks + a.recoveryTicks) {
        f.attack = null;
        f.attackTick = 0;
        f.hitConfirmed = false;
      }
    }

    // --- gravity + fast fall (suspended while dashing) ---
    if (!dashing) {
      f.vy += TUNING.gravity * f.stats.fallMult * DT;
      if (f.vy > 0 && has(buttons, Btn.Down) && !f.grounded) {
        f.vy = Math.max(f.vy, TUNING.fastFallVel * f.stats.fallMult);
      }
      f.vy = Math.min(f.vy, (has(buttons, Btn.Down) ? TUNING.fastFallVel : TUNING.maxFallVel) * f.stats.fallMult);
    }

    // --- integrate + platform collision ---
    const wasGrounded = f.grounded;
    const prevY = f.y;
    f.x += f.vx * DT;
    f.y += f.vy * DT;
    f.grounded = false;

    if (f.vy >= 0 && f.dropThrough === 0) {
      for (const p of this.stage.platforms) {
        const withinX = f.x + f.stats.width / 2 > p.x && f.x - f.stats.width / 2 < p.x + p.w;
        if (withinX && prevY <= p.y && f.y >= p.y) {
          f.y = p.y;
          f.vy = 0;
          f.grounded = true;
          f.jumpsUsed = 0;
          f.airDashUsed = false;
          if (!wasGrounded) this.events.push({ t: "land", id: f.id, x: f.x, y: f.y });
          break;
        }
      }
    }
    if (f.grounded || (wasGrounded && f.vy >= 0)) f.coyote = TUNING.coyoteTimeTicks;

    // --- state machine (drives animation later) ---
    if (f.attack) f.state = "attack";
    else if (inHitstun) f.state = "hitstun";
    else if (f.dashTicks > 0) f.state = "dash";
    else if (!f.grounded) f.state = f.vy < 0 ? "jump" : "fall";
    else f.state = Math.abs(f.vx) > 40 ? "run" : "idle";

    // --- blast zone ring-out ---
    const b = this.stage.blast;
    if (f.x < b.left || f.x > b.right || f.y < b.top || f.y > b.bottom) this.ringOut(f);
  }

  private onSoftPlatform(f: Fighter): boolean {
    for (const p of this.stage.platforms) {
      if (!p.soft) continue;
      const withinX = f.x + f.stats.width / 2 > p.x && f.x - f.stats.width / 2 < p.x + p.w;
      if (withinX && Math.abs(f.y - p.y) < 2) return true;
    }
    return false;
  }

  private startAttack(f: Fighter, def: MoveDef): void {
    f.attack = def;
    f.attackTick = 0;
    f.hitConfirmed = false;
    // aim locked at press: hitbox placement + projectile direction
    f.atkAimX = f.aimX;
    f.atkAimY = f.aimY;
    if (Math.abs(f.aimX) > 0.2) f.facing = f.aimX > 0 ? 1 : -1;
    // knockback direction locked at press: aim, or fixed angle mirrored by facing
    if (def.angle === "aim") {
      f.atkDirX = f.aimX;
      f.atkDirY = f.aimY;
    } else {
      const d = angleToDir(def.angle, f.facing);
      f.atkDirX = d.x;
      f.atkDirY = d.y;
    }
  }

  /** Fired from the first active tick of a projectile-kind move, along the locked aim. */
  private spawnProjectile(f: Fighter, def: ProjectileDef): void {
    const cx = f.x;
    const cy = f.y - f.stats.height * 0.55;
    this.projectiles.push({
      owner: f.id,
      x: cx + f.atkAimX * 40, y: cy + f.atkAimY * 40,
      vx: f.atkAimX * def.speed, vy: f.atkAimY * def.speed,
      life: def.lifeTicks, def,
    });
    this.events.push({ t: "shoot", id: f.id, x: cx, y: cy });
  }

  // ---------------- projectiles ----------------
  private stepProjectiles(): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.vy += TUNING.gravity * p.def.gravityScale * DT;
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      p.life--;

      let dead = p.life <= 0;

      // solid platforms block projectiles
      if (!dead) {
        for (const plat of this.stage.platforms) {
          if (plat.soft) continue;
          if (aabbOverlap(p.x - p.def.radius, p.y - p.def.radius, p.def.radius * 2, p.def.radius * 2, plat.x, plat.y, plat.w, SOLID_DEPTH)) {
            dead = true;
            break;
          }
        }
      }

      // fighters
      if (!dead) {
        const ownerTeam = this.fighters[p.owner]?.team;
        for (const f of this.fighters) {
          if (f.id === p.owner || f.state === "dead" || f.invuln > 0) continue;
          if (!this.friendlyFire && f.team === ownerTeam) continue;
          const hb = hurtbox(f);
          if (aabbOverlap(p.x - p.def.radius, p.y - p.def.radius, p.def.radius * 2, p.def.radius * 2, hb.x, hb.y, hb.w, hb.h)) {
            const m = Math.hypot(p.vx, p.vy) || 1;
            this.applyHit(p.owner, f, p.def.damage, p.def.baseKnockback, p.def.kbGrowth, p.vx / m, p.vy / m, p.def.hitstop, false, 0);
            dead = true;
            break;
          }
        }
      }

      if (dead) {
        this.events.push({ t: "projdie", x: p.x, y: p.y });
        this.projectiles.splice(i, 1);
      }
    }
  }

  // ---------------- melee ----------------
  private resolveMelee(): void {
    for (const atk of this.fighters) {
      const a = atk.attack;
      if (!a || a.kind !== "melee" || atk.hitConfirmed || atk.state === "dead") continue;
      const t = atk.attackTick;
      if (t < a.startupTicks || t >= a.startupTicks + a.activeTicks) continue;

      const box = this.attackBox(atk, a);
      for (const vic of this.fighters) {
        if (vic.id === atk.id || vic.state === "dead" || vic.invuln > 0) continue;
        if (!this.friendlyFire && vic.team === atk.team) continue;
        const hb = this.hitRewind?.(atk, vic) ?? hurtbox(vic);
        if (!aabbOverlap(box.x, box.y, box.w, box.h, hb.x, hb.y, hb.w, hb.h)) continue;
        this.applyHit(atk.id, vic, a.damage, a.baseKnockback, a.kbGrowth, atk.atkDirX, atk.atkDirY, a.hitstop, a.heavy, a.hitstunBonus);
        atk.hitConfirmed = true;
      }
    }
  }

  /** Attack hitbox in world space (see attackBoxOf). */
  attackBox(f: Fighter, a: MoveDef): { x: number; y: number; w: number; h: number } {
    return attackBoxOf(f, a);
  }

  /** Unified hit application - melee and projectiles share this path. */
  private applyHit(
    attackerId: number, vic: Fighter,
    damage: number, baseKB: number, kbGrowth: number,
    dirX: number, dirY: number, hitstop: number, heavy: boolean, hitstunBonus: number,
  ): void {
    vic.damage += damage;
    // THE formula: magnitude from damage% and weight; direction from aim only.
    const magnitude = (baseKB + vic.damage * kbGrowth) / vic.stats.weight;
    let kx = dirX * magnitude;
    let ky = dirY * magnitude;
    // downward knockback into the ground bounces up instead of vanishing
    if (vic.grounded && ky > 0) ky = -ky * TUNING.groundBounce;

    vic.vx = kx;
    vic.vy = ky;
    vic.grounded = false;
    vic.hitstun = Math.round(TUNING.hitstunBase + vic.damage * TUNING.hitstunGrowth) + hitstunBonus;
    vic.attack = null;
    vic.attackTick = 0;
    vic.hitConfirmed = false;
    vic.dashTicks = 0; // getting hit cancels a dash

    this.hitstop = Math.max(this.hitstop, hitstop);
    this.events.push({
      t: "hit", attacker: attackerId, victim: vic.id, damage, heavy,
      x: vic.x, y: vic.y - vic.stats.height / 2, kx, ky,
    });
  }

  // ---------------- body collision ----------------
  /** Overlapping fighters push each other apart horizontally (dashing passes through). */
  private resolveBodyPush(): void {
    for (let i = 0; i < this.fighters.length; i++) {
      for (let j = i + 1; j < this.fighters.length; j++) {
        const a = this.fighters[i];
        const b = this.fighters[j];
        if (a.state === "dead" || b.state === "dead") continue;
        if (a.dashTicks > 0 || b.dashTicks > 0) continue; // dash-through
        const ha = hurtbox(a);
        const hb = hurtbox(b);
        if (!aabbOverlap(ha.x, ha.y, ha.w, ha.h, hb.x, hb.y, hb.w, hb.h)) continue;

        const dx = b.x - a.x;
        const overlapX = (ha.w + hb.w) / 2 - Math.abs(dx);
        if (overlapX <= 0) continue;
        const push = Math.min(overlapX / 2, TUNING.bodyPushPerTick);
        const dir = dx !== 0 ? Math.sign(dx) : (a.id < b.id ? -1 : 1);
        a.x -= push * dir;
        b.x += push * dir;
      }
    }
  }

  // ---------------- stocks ----------------
  private ringOut(f: Fighter): void {
    this.events.push({ t: "ringout", id: f.id, x: f.x, y: f.y });
    f.stocks--;
    f.state = "dead";
    f.vx = 0; f.vy = 0;
    f.attack = null; f.hitstun = 0; f.dashTicks = 0;
    f.bufSlot = null; f.bufTicks = 0; // don't carry buffered presses into the respawn
    f.speedBoost = 0; // wings don't survive death
    f.respawnTimer = f.stocks > 0 ? 60 : 0;
  }

  private respawn(f: Fighter): void {
    const s = this.stage.spawns[f.id % this.stage.spawns.length];
    f.x = s.x; f.y = s.y - 200;
    f.vx = 0; f.vy = 0;
    f.damage = 0;
    f.jumpsUsed = 0;
    f.airDashUsed = false;
    f.state = "fall";
    f.invuln = TUNING.respawnInvulnTicks;
    this.events.push({ t: "respawn", id: f.id });
  }
}
