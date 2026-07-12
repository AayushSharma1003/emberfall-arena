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
  type CharacterDef, type CharacterStats, type CharId, type ConstructDef,
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
  burnIntervalTicks: 20, // burn DoT cadence…
  burnDamage: 1, // …dealing this much damage% per tick of the cadence (3%/s)
} as const;

/** Ultimate meter: builds from damage dealt and taken, spent whole. */
export const ULT_TUNING = {
  max: 100,
  gainDealt: 0.75, // meter per damage% dealt to enemies
  gainTaken: 0.4, // meter per damage% taken
} as const;

// ---------- World geometry ----------
/**
 * Platform kinematics are pure functions of the sim tick — deterministic,
 * nothing to serialize, and the renderer can query the same functions to
 * draw platforms and hazard telegraphs exactly where the sim says they are.
 */
export interface PlatformMotion {
  /** Peak offset from the base position; the platform oscillates ±(dx,dy). */
  dx: number;
  dy: number;
  periodTicks: number;
  /** Cycle offset, 0..1. */
  phase?: number;
}

export interface PlatformPhasing {
  periodTicks: number;
  /** Ticks the platform is solid at the start of each cycle (then it's gone). */
  solidTicks: number;
  /** Cycle offset, 0..1. */
  phase?: number;
}

export interface Platform {
  x: number;
  y: number; // top surface
  w: number;
  soft: boolean; // soft = drop-through, thin
  motion?: PlatformMotion;
  phasing?: PlatformPhasing;
}

/** Sinusoidal offset of a (possibly) moving platform at a given tick. */
export function platformOffset(p: Platform, tick: number): { x: number; y: number } {
  const m = p.motion;
  if (!m) return { x: 0, y: 0 };
  const t = (tick / m.periodTicks + (m.phase ?? 0)) * Math.PI * 2;
  const s = Math.sin(t);
  return { x: s * m.dx, y: s * m.dy };
}

/** Is a (possibly) phasing platform solid at this tick? */
export function platformSolid(p: Platform, tick: number): boolean {
  const ph = p.phasing;
  if (!ph) return true;
  const shifted = tick + Math.round((ph.phase ?? 0) * ph.periodTicks);
  const local = ((shifted % ph.periodTicks) + ph.periodTicks) % ph.periodTicks;
  return local < ph.solidTicks;
}

/**
 * Ticks until a phasing platform next changes solidity (for renderer
 * crumble/re-form telegraphs). Infinity for non-phasing platforms.
 */
export function platformPhaseIn(p: Platform, tick: number): number {
  const ph = p.phasing;
  if (!ph) return Infinity;
  const shifted = tick + Math.round((ph.phase ?? 0) * ph.periodTicks);
  const local = ((shifted % ph.periodTicks) + ph.periodTicks) % ph.periodTicks;
  return local < ph.solidTicks ? ph.solidTicks - local : ph.periodTicks - local;
}

export interface BlastZone { left: number; right: number; top: number; bottom: number; }

// ---------- Hazards ----------
/**
 * A timed danger zone: idle -> telegraph -> active, cycling on periodTicks.
 * The strike lands at the END of each cycle so "period" reads naturally as
 * "one strike every N ticks". Purely tick-driven: renderers derive telegraph
 * visuals from the same function the sim uses to apply hits.
 */
export interface HazardDef {
  id: string;
  /** Zone AABB in world space. */
  x: number;
  y: number;
  w: number;
  h: number;
  periodTicks: number;
  telegraphTicks: number;
  activeTicks: number;
  /** Cycle offset, 0..1. */
  phase?: number;
  damage: number;
  baseKnockback: number;
  kbGrowth: number;
  /** Absolute launch angle in degrees (90 = straight up). Hazards have no facing. */
  angleDeg: number;
  hitstop: number;
}

export type HazardState = "idle" | "telegraph" | "active";

export function hazardStateAt(h: HazardDef, tick: number): HazardState {
  const shifted = tick + Math.round((h.phase ?? 0) * h.periodTicks);
  const local = ((shifted % h.periodTicks) + h.periodTicks) % h.periodTicks;
  const activeStart = h.periodTicks - h.activeTicks;
  const telegraphStart = activeStart - h.telegraphTicks;
  if (local >= activeStart) return "active";
  if (local >= telegraphStart) return "telegraph";
  return "idle";
}

/** 0..1 progress through the telegraph window (for renderer buildup FX). */
export function hazardTelegraphT(h: HazardDef, tick: number): number {
  const shifted = tick + Math.round((h.phase ?? 0) * h.periodTicks);
  const local = ((shifted % h.periodTicks) + h.periodTicks) % h.periodTicks;
  const telegraphStart = h.periodTicks - h.activeTicks - h.telegraphTicks;
  if (local < telegraphStart) return 0;
  return Math.min(1, (local - telegraphStart) / h.telegraphTicks);
}

export interface Stage {
  platforms: Platform[];
  blast: BlastZone;
  spawns: { x: number; y: number }[];
  /** Where items may appear (empty array = no items on this stage). */
  itemSpawns: { x: number; y: number }[];
  /** Timed danger zones (geysers, lightning, slam hammers). Optional: default none. */
  hazards?: HazardDef[];
}

/**
 * Map 1: Emberfall Keep — Battlefield-style. One main platform, two soft
 * floats, plus two high CRUMBLING side ledges (phasing, offset half a cycle
 * from each other) — risky perches that fall away on a readable rhythm.
 * The core layout is unchanged from Phase 0 and the regression suite
 * (settle() etc.) depends on it.
 */
export function emberfallKeep(): Stage {
  return {
    platforms: [
      { x: 460, y: 780, w: 1000, soft: false },
      { x: 610, y: 560, w: 260, soft: true },
      { x: 1050, y: 560, w: 260, soft: true },
      // crumbling ledges: 9s solid, 3s gone, alternating sides
      { x: 430, y: 400, w: 180, soft: true, phasing: { periodTicks: 720, solidTicks: 540 } },
      { x: 1310, y: 400, w: 180, soft: true, phasing: { periodTicks: 720, solidTicks: 540, phase: 0.5 } },
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
  | "attack" | "charge" | "hitstun" | "dead";

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
  /** Index of the platform currently stood on (-1 airborne). Moving platforms carry their riders. */
  groundPlat: number;
  jumpsUsed: number;
  jumpHeld: boolean;
  state: FighterState;
  damage: number; // damage percent
  stocks: number;
  /** Ultimate meter, 0..ULT_TUNING.max. Kept across stocks. */
  ult: number;
  /** Burn DoT: remaining ticks (TUNING.burnDamage every burnIntervalTicks). */
  burnTicks: number;
  /** Who lit the fire (meter credit). -1 = nobody. */
  burnFrom: number;
  /** Rooted, holding a chargeable special. */
  charging: boolean;
  chargeTicks: number;
  /** Charge factor of the special currently firing (1 = uncharged/full). */
  chargeRelease: number;
  // timers (ticks)
  coyote: number;
  jumpBuffer: number;
  dropThrough: number;
  /** Wings item: remaining ticks of +25% run speed. */
  speedBoost: number;
  /** Ticks before a stage hazard can hit this fighter again (one hit per activation). */
  hazardCooldown: number;
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
  bufSlot: "light" | "heavy" | "special" | "ult" | null; // buffered attack press (light resolves to aerial at fire time)
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
  /** Sticky projectiles arm on landing; armed mines wait for triggerRadius. */
  armed: boolean;
  /** Fighter ids already hit (pierce dedup). Absent until a piercing shot connects. */
  hits?: number[];
  def: ProjectileDef;
}

/** A deployed turret (Hessa's kilns). Falls to the nearest platform, shoots the nearest enemy, can be destroyed. */
export interface Construct {
  owner: number;
  team: number;
  x: number;
  y: number; // bottom-center, like fighters
  vy: number;
  hp: number;
  life: number;
  fireCooldown: number;
  facing: 1 | -1;
  def: ConstructDef;
}

/** Lingering ground fire: refreshes burn on enemies standing inside. */
export interface FireZone {
  owner: number;
  team: number;
  x: number;
  y: number;
  radius: number;
  life: number;
  burnTicks: number;
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
    grounded: false, groundPlat: -1, jumpsUsed: 0, jumpHeld: false,
    state: "fall", damage: 0, stocks: 3,
    ult: 0, burnTicks: 0, burnFrom: -1,
    charging: false, chargeTicks: 0, chargeRelease: 1,
    coyote: 0, jumpBuffer: 0, dropThrough: 0, speedBoost: 0, hazardCooldown: 0,
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
  | { t: "item"; kind: ItemKind; id: number; x: number; y: number }
  | { t: "ult"; id: number; x: number; y: number }
  | { t: "charge"; id: number }
  | { t: "release"; id: number; factor: number }
  | { t: "burn"; id: number; x: number; y: number }
  | { t: "zone"; x: number; y: number; radius: number; owner: number }
  | { t: "explode"; x: number; y: number; radius: number }
  | { t: "teleport"; id: number; fx: number; fy: number; tx: number; ty: number }
  | { t: "parry"; id: number; x: number; y: number }
  | { t: "construct"; kindId: string; x: number; y: number; owner: number }
  | { t: "constructdie"; kindId: string; x: number; y: number }
  | { t: "consthit"; x: number; y: number };

// ---------- helpers ----------
function aabbOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** Circle vs AABB (zones/explosions/mine triggers vs hurtboxes). */
function circleHitsBox(cx: number, cy: number, r: number, b: { x: number; y: number; w: number; h: number }): boolean {
  const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
  const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

/** Fighter hurtbox as top-left AABB. */
function hurtbox(f: Fighter): { x: number; y: number; w: number; h: number } {
  return { x: f.x - f.stats.width / 2, y: f.y - f.stats.height, w: f.stats.width, h: f.stats.height };
}

/** Construct hurtbox as top-left AABB (origin = bottom-center, like fighters). */
function constructBox(c: Construct): { x: number; y: number; w: number; h: number } {
  return { x: c.x - c.def.width / 2, y: c.y - c.def.height, w: c.def.width, h: c.def.height };
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
  constructs: Construct[] = [];
  zones: FireZone[] = [];
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
    f.charging = false;
    f.chargeTicks = 0;
    f.chargeRelease = 1;
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
    this.stepHazards();
    this.stepConstructs();
    this.stepZones();
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
          armed: false,
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

    // --- ride moving platforms: this tick's platform delta carries the rider ---
    if (f.grounded && f.groundPlat >= 0) {
      const p = this.stage.platforms[f.groundPlat];
      if (p?.motion) {
        const prev = platformOffset(p, this.tick - 1);
        const cur = platformOffset(p, this.tick);
        f.x += cur.x - prev.x;
        // y is set absolutely, not accumulated: a grounded rider sits EXACTLY
        // on the top surface, and the landing check relies on that equality
        // (delta accumulation drifts by ULPs and breaks `prevY <= top`)
        f.y = p.y + cur.y;
      }
    }

    // --- timers ---
    if (f.invuln > 0) f.invuln--;
    if (f.coyote > 0) f.coyote--;
    if (f.jumpBuffer > 0) f.jumpBuffer--;
    if (f.dropThrough > 0) f.dropThrough--;
    if (f.dashCooldown > 0) f.dashCooldown--;
    if (f.specialCooldown > 0) f.specialCooldown--;
    if (f.speedBoost > 0) f.speedBoost--;
    if (f.hazardCooldown > 0) f.hazardCooldown--;
    // burn DoT: chip damage on a fixed cadence, no knockback, no hitstun
    if (f.burnTicks > 0) {
      f.burnTicks--;
      if (f.burnTicks % TUNING.burnIntervalTicks === 0) {
        f.damage += TUNING.burnDamage;
        const lighter = this.fighters[f.burnFrom];
        if (lighter && lighter.team !== f.team) {
          lighter.ult = Math.min(ULT_TUNING.max, lighter.ult + TUNING.burnDamage * ULT_TUNING.gainDealt);
        }
        f.ult = Math.min(ULT_TUNING.max, f.ult + TUNING.burnDamage * ULT_TUNING.gainTaken);
        this.events.push({ t: "burn", id: f.id, x: f.x, y: f.y - f.stats.height / 2 });
      }
    }
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
    if (!inHitstun && !attacking && !dashing && !f.charging) {
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
      (pressed & Btn.Dash) && !inHitstun && !attacking && !dashing && !f.charging &&
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

    if (f.jumpBuffer > 0 && !inHitstun && !attacking && !dashing && !f.charging) {
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
    else if (pressed & Btn.Ultimate) { f.bufSlot = "ult"; f.bufTicks = TUNING.attackBufferTicks; }
    else if (f.bufTicks > 0 && --f.bufTicks === 0) f.bufSlot = null;

    if (f.bufSlot && !inHitstun && !attacking && !dashing && !f.charging) {
      if (f.bufSlot === "light") {
        this.startAttack(f, f.grounded ? f.moves.light : f.moves.aerial);
        f.bufSlot = null;
      } else if (f.bufSlot === "heavy") {
        this.startAttack(f, f.moves.heavy);
        f.bufSlot = null;
      } else if (f.bufSlot === "ult") {
        // meter-gated; a press without meter is simply dropped
        if (f.ult >= ULT_TUNING.max) {
          f.ult = 0;
          this.startAttack(f, f.moves.ultimate);
          this.events.push({ t: "ult", id: f.id, x: f.x, y: f.y - f.stats.height / 2 });
        }
        f.bufSlot = null;
      } else if (f.specialCooldown === 0) {
        const sp = f.moves.special;
        if (sp.chargeable) {
          // rooted charge: fires on release (see below), cooldown paid then
          f.charging = true;
          f.chargeTicks = 0;
          this.events.push({ t: "charge", id: f.id });
        } else {
          this.startAttack(f, sp);
          f.specialCooldown = sp.cooldownTicks;
        }
        f.bufSlot = null;
      }
    }

    // --- charge hold/release ---
    if (f.charging && !inHitstun) {
      const sp = f.moves.special;
      const ch = sp.chargeable;
      const held = has(buttons, Btn.Shoot) || has(buttons, Btn.Special);
      if (!ch) {
        f.charging = false; // character swapped mid-charge (dev hotseat)
      } else if (held) {
        if (f.chargeTicks < ch.maxTicks) f.chargeTicks++;
      } else {
        f.chargeRelease = ch.minFactor + (1 - ch.minFactor) * (f.chargeTicks / ch.maxTicks);
        f.charging = false;
        f.chargeTicks = 0;
        this.startAttack(f, sp);
        f.specialCooldown = sp.cooldownTicks;
        this.events.push({ t: "release", id: f.id, factor: f.chargeRelease });
      }
    }
    if (f.attack) {
      f.attackTick++;
      const a = f.attack;
      if (f.attackTick === a.startupTicks) {
        // --- first active tick: everything a move can DO happens here ---
        if (a.lungeSpeed > 0) {
          if (a.angle === "aim") {
            f.vx = f.atkAimX * a.lungeSpeed;
            f.vy = f.atkAimY * a.lungeSpeed;
          } else {
            f.vx = f.facing * a.lungeSpeed; // fixed-angle moves lunge horizontally
          }
        }
        if (a.selfDamage) f.damage += a.selfDamage; // Pyre pays up front — feeding its own kindle

        // origin captured before any teleport (mirror clones spawn here)
        const preX = f.x;
        const preY = f.y - f.stats.height * 0.55;

        if (a.teleport) {
          const b = this.stage.blast;
          const tx = Math.max(b.left + 60, Math.min(b.right - 60, f.x + f.atkAimX * a.teleport.distance));
          const ty = Math.max(b.top + 60, Math.min(b.bottom - 120, f.y + f.atkAimY * a.teleport.distance));
          this.events.push({ t: "teleport", id: f.id, fx: f.x, fy: f.y - f.stats.height / 2, tx, ty: ty - f.stats.height / 2 });
          f.x = tx;
          f.y = ty;
          f.grounded = false;
          f.groundPlat = -1;
        }

        if (a.construct) this.deployConstruct(f, a.construct);

        if (a.zone) {
          this.zones.push({
            owner: f.id, team: f.team, x: f.x, y: f.y - f.stats.height * 0.3,
            radius: a.zone.radius, life: a.zone.lifeTicks, burnTicks: a.zone.burnTicks,
          });
          this.events.push({ t: "zone", x: f.x, y: f.y - f.stats.height * 0.3, radius: a.zone.radius, owner: f.id });
        }

        if (a.kind === "projectile" && a.projectile) {
          let def = a.projectile;
          if (a.chargeable) {
            // charged release: scale the shot, or swap to the full-charge form
            const cr = f.chargeRelease;
            if (cr >= 0.95 && a.chargedProjectile) def = a.chargedProjectile;
            else def = { ...def, damage: def.damage * cr, baseKnockback: def.baseKnockback * cr, speed: def.speed * (0.7 + 0.3 * cr) };
          }
          if (a.projectileAtOrigin) {
            // a single stationary, pre-armed charge (Sable's clone)
            this.spawnProjectile(f, def, { x: preX, y: preY, still: true });
          } else {
            const count = a.projectileCount ?? 1;
            const spread = ((a.spreadDeg ?? 0) * Math.PI) / 180;
            const base = Math.atan2(f.atkAimY, f.atkAimX);
            for (let i = 0; i < count; i++) {
              const off = count > 1 ? spread * (i / (count - 1) - 0.5) : 0;
              this.spawnProjectile(f, def, { dirX: Math.cos(base + off), dirY: Math.sin(base + off) });
            }
          }
        }
      }
      if (f.attackTick >= a.startupTicks + a.activeTicks + a.recoveryTicks) {
        f.attack = null;
        f.attackTick = 0;
        f.hitConfirmed = false;
        f.chargeRelease = 1;
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
    f.groundPlat = -1;

    if (f.vy >= 0 && f.dropThrough === 0) {
      for (let pi = 0; pi < this.stage.platforms.length; pi++) {
        const p = this.stage.platforms[pi];
        if (!platformSolid(p, this.tick)) continue;
        const off = platformOffset(p, this.tick);
        const px = p.x + off.x;
        const py = p.y + off.y;
        const withinX = f.x + f.stats.width / 2 > px && f.x - f.stats.width / 2 < px + p.w;
        if (withinX && prevY <= py && f.y >= py) {
          f.y = py;
          f.vy = 0;
          f.grounded = true;
          f.groundPlat = pi;
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
    else if (f.charging) f.state = "charge";
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
      if (!p.soft || !platformSolid(p, this.tick)) continue;
      const off = platformOffset(p, this.tick);
      const px = p.x + off.x;
      const py = p.y + off.y;
      const withinX = f.x + f.stats.width / 2 > px && f.x - f.stats.width / 2 < px + p.w;
      if (withinX && Math.abs(f.y - py) < 2) return true;
    }
    return false;
  }

  private startAttack(f: Fighter, def: MoveDef): void {
    f.attack = def;
    f.attackTick = 0;
    f.hitConfirmed = false;
    // teleports protect through the blink: i-frames from press until shortly after arrival
    if (def.teleport) f.invuln = Math.max(f.invuln, def.startupTicks + def.teleport.iframes);
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

  /**
   * Fired from the first active tick of a projectile-kind move. Defaults to
   * the locked aim from the fighter's muzzle; opts override direction or
   * position, and `still` spawns a stationary pre-armed charge (clones/mines).
   */
  private spawnProjectile(
    f: Fighter,
    def: ProjectileDef,
    opts: { x?: number; y?: number; dirX?: number; dirY?: number; still?: boolean } = {},
  ): void {
    const cx = opts.x ?? f.x;
    const cy = opts.y ?? f.y - f.stats.height * 0.55;
    const dx = opts.dirX ?? f.atkAimX;
    const dy = opts.dirY ?? f.atkAimY;
    const still = opts.still ?? false;
    this.projectiles.push({
      owner: f.id,
      x: cx + (still ? 0 : dx * 40), y: cy + (still ? 0 : dy * 40),
      vx: still ? 0 : dx * def.speed, vy: still ? 0 : dy * def.speed,
      life: def.lifeTicks, armed: still, def,
    });
    this.events.push({ t: "shoot", id: f.id, x: cx, y: cy });
  }

  /** Place a turret in front of the deployer (it falls to the nearest platform). */
  private deployConstruct(f: Fighter, def: ConstructDef): void {
    // over the cap: the owner's oldest construct is scrapped first
    const mine = this.constructs.filter((c) => c.owner === f.id);
    if (mine.length >= def.maxActive) {
      const oldest = this.constructs.indexOf(mine[0]);
      this.events.push({ t: "constructdie", kindId: mine[0].def.kindId, x: mine[0].x, y: mine[0].y });
      this.constructs.splice(oldest, 1);
    }
    const c: Construct = {
      owner: f.id, team: f.team, x: f.x + f.facing * 70, y: f.y, vy: 0,
      hp: def.hp, life: def.lifeTicks, fireCooldown: 30, facing: f.facing, def,
    };
    this.constructs.push(c);
    this.events.push({ t: "construct", kindId: def.kindId, x: c.x, y: c.y, owner: f.id });
  }

  /** Kindle: outgoing damage/knockback scale with the attacker's own damage%. */
  private outScaleOf(id: number): number {
    const f = this.fighters[id];
    if (!f?.stats.kindle) return 1;
    return 1 + f.stats.kindle * (Math.min(f.damage, 150) / 150);
  }

  // ---------------- projectiles ----------------
  private stepProjectiles(): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const ownerTeam = this.fighters[p.owner]?.team;

      if (!p.armed) {
        // homing: steer toward the nearest live enemy, capped turn rate
        if (p.def.homing) {
          let best: Fighter | null = null;
          let bestD = Infinity;
          for (const f of this.fighters) {
            if (f.id === p.owner || f.state === "dead" || f.invuln > 0) continue;
            if (!this.friendlyFire && f.team === ownerTeam) continue;
            const d = Math.hypot(f.x - p.x, f.y - f.stats.height / 2 - p.y);
            if (d < bestD) { bestD = d; best = f; }
          }
          if (best) {
            const cur = Math.atan2(p.vy, p.vx);
            const want = Math.atan2(best.y - best.stats.height / 2 - p.y, best.x - p.x);
            let dA = want - cur;
            while (dA > Math.PI) dA -= Math.PI * 2;
            while (dA < -Math.PI) dA += Math.PI * 2;
            const maxTurn = p.def.homing * DT;
            dA = Math.max(-maxTurn, Math.min(maxTurn, dA));
            const sp = Math.hypot(p.vx, p.vy);
            p.vx = Math.cos(cur + dA) * sp;
            p.vy = Math.sin(cur + dA) * sp;
          }
        }
        p.vy += TUNING.gravity * p.def.gravityScale * DT;
        p.x += p.vx * DT;
        p.y += p.vy * DT;
      }
      p.life--;

      let dead = p.life <= 0;
      let directVictim = -1;

      // solid platforms block projectiles (sticky ones land and arm instead)
      if (!dead && !p.armed) {
        for (const plat of this.stage.platforms) {
          if (plat.soft || !platformSolid(plat, this.tick)) continue;
          const off = platformOffset(plat, this.tick);
          if (aabbOverlap(p.x - p.def.radius, p.y - p.def.radius, p.def.radius * 2, p.def.radius * 2, plat.x + off.x, plat.y + off.y, plat.w, SOLID_DEPTH)) {
            if (p.def.sticky) {
              p.armed = true;
              p.vx = 0;
              p.vy = 0;
              p.y = plat.y + off.y - p.def.radius; // perch on the surface
            } else {
              dead = true;
            }
            break;
          }
        }
      }

      // armed mines detonate on enemy proximity
      if (!dead && p.armed && p.def.triggerRadius) {
        for (const f of this.fighters) {
          if (f.id === p.owner || f.state === "dead" || f.invuln > 0) continue;
          if (!this.friendlyFire && f.team === ownerTeam) continue;
          if (circleHitsBox(p.x, p.y, p.def.triggerRadius, hurtbox(f))) {
            dead = true;
            break;
          }
        }
      }

      // fighters (direct contact) — parrying fighters reflect instead
      if (!dead && !p.armed) {
        for (const f of this.fighters) {
          if (f.id === p.owner || f.state === "dead" || f.invuln > 0) continue;
          if (!this.friendlyFire && f.team === ownerTeam) continue;
          if (p.hits && p.hits.includes(f.id)) continue; // pierce: never hit the same target twice
          const hb = hurtbox(f);
          if (!aabbOverlap(p.x - p.def.radius, p.y - p.def.radius, p.def.radius * 2, p.def.radius * 2, hb.x, hb.y, hb.w, hb.h)) continue;
          if (this.isParrying(f)) {
            p.owner = f.id; // reflected: it's YOUR projectile now
            p.vx = -p.vx;
            p.vy = -p.vy;
            p.hits = undefined; // reflected shot is a fresh threat to everyone
            this.events.push({ t: "parry", id: f.id, x: f.x, y: f.y - f.stats.height / 2 });
            break;
          }
          const m = Math.hypot(p.vx, p.vy) || 1;
          this.applyHit(
            p.owner, f, p.def.damage, p.def.baseKnockback, p.def.kbGrowth,
            p.vx / m, p.vy / m, p.def.hitstop, false, p.def.hitstunBonus ?? 0,
            this.outScaleOf(p.owner), p.def.burn,
          );
          directVictim = f.id;
          // pierce: survive until it has passed through (pierce + 1) targets
          (p.hits ??= []).push(f.id);
          if (p.hits.length > (p.def.pierce ?? 0)) dead = true;
          break;
        }
      }

      // enemy constructs stop projectiles too
      if (!dead && !p.armed) {
        for (const c of this.constructs) {
          if (c.owner === p.owner) continue;
          if (!this.friendlyFire && c.team === ownerTeam) continue;
          const cb = constructBox(c);
          if (aabbOverlap(p.x - p.def.radius, p.y - p.def.radius, p.def.radius * 2, p.def.radius * 2, cb.x, cb.y, cb.w, cb.h)) {
            c.hp -= p.def.damage * this.outScaleOf(p.owner);
            this.events.push({ t: "consthit", x: p.x, y: p.y });
            dead = true;
            break;
          }
        }
      }

      if (dead) {
        if (p.def.explodeRadius) this.explode(p.x, p.y, p.def, p.owner, directVictim);
        if (p.def.zoneOnDeath) {
          const z = p.def.zoneOnDeath;
          this.zones.push({ owner: p.owner, team: ownerTeam ?? 0, x: p.x, y: p.y, radius: z.radius, life: z.lifeTicks, burnTicks: z.burnTicks });
          this.events.push({ t: "zone", x: p.x, y: p.y, radius: z.radius, owner: p.owner });
        }
        this.events.push({ t: "projdie", x: p.x, y: p.y });
        this.projectiles.splice(i, 1);
      }
    }
  }

  /** AoE hit around a point (mine/bomb detonations). The direct victim of the impact is excluded. */
  private explode(x: number, y: number, def: ProjectileDef, owner: number, excludeId: number): void {
    const radius = def.explodeRadius ?? 0;
    this.events.push({ t: "explode", x, y, radius });
    const ownerTeam = this.fighters[owner]?.team;
    const scale = this.outScaleOf(owner);
    for (const f of this.fighters) {
      if (f.id === owner || f.id === excludeId || f.state === "dead" || f.invuln > 0) continue;
      if (!this.friendlyFire && f.team === ownerTeam) continue;
      if (!circleHitsBox(x, y, radius, hurtbox(f))) continue;
      let dx = f.x - x;
      let dy = f.y - f.stats.height / 2 - y;
      const m = Math.hypot(dx, dy);
      if (m < 1e-6) { dx = 0; dy = -1; } else { dx /= m; dy /= m; }
      this.applyHit(owner, f, def.damage, def.baseKnockback, def.kbGrowth, dx, dy, def.hitstop, true, def.hitstunBonus ?? 0, scale, def.burn);
    }
    for (const c of this.constructs) {
      if (c.owner === owner) continue;
      if (!this.friendlyFire && c.team === ownerTeam) continue;
      if (!circleHitsBox(x, y, radius, constructBox(c))) continue;
      c.hp -= def.damage * scale;
      this.events.push({ t: "consthit", x: c.x, y: c.y - c.def.height / 2 });
    }
  }

  /** In the active window of a parry-stance move? */
  private isParrying(f: Fighter): boolean {
    const a = f.attack;
    if (!a?.parry) return false;
    return f.attackTick >= a.startupTicks && f.attackTick < a.startupTicks + a.activeTicks;
  }

  // ---------------- constructs ----------------
  private stepConstructs(): void {
    for (let i = this.constructs.length - 1; i >= 0; i--) {
      const c = this.constructs[i];
      c.life--;
      if (c.life <= 0 || c.hp <= 0 || c.y > this.stage.blast.bottom) {
        this.events.push({ t: "constructdie", kindId: c.def.kindId, x: c.x, y: c.y });
        this.constructs.splice(i, 1);
        continue;
      }

      // settle onto platforms (deployed mid-air or the floor phased out)
      c.vy += TUNING.gravity * DT;
      const prevY = c.y;
      c.y += c.vy * DT;
      for (const p of this.stage.platforms) {
        if (!platformSolid(p, this.tick)) continue;
        const off = platformOffset(p, this.tick);
        const py = p.y + off.y;
        const withinX = c.x + c.def.width / 2 > p.x + off.x && c.x - c.def.width / 2 < p.x + off.x + p.w;
        if (withinX && prevY <= py && c.y >= py) {
          c.y = py;
          c.vy = 0;
          break;
        }
      }

      // fire at the nearest live enemy in range
      if (--c.fireCooldown <= 0) {
        let best: Fighter | null = null;
        let bestD = Infinity;
        for (const f of this.fighters) {
          if (f.state === "dead" || f.invuln > 0) continue;
          if (f.team === c.team && !this.friendlyFire) continue;
          const d = Math.hypot(f.x - c.x, f.y - f.stats.height / 2 - (c.y - c.def.height / 2));
          if (d < bestD) { bestD = d; best = f; }
        }
        if (best && bestD <= c.def.range) {
          const sx = c.x;
          const sy = c.y - c.def.height * 0.65;
          let dx = best.x - sx;
          let dy = best.y - best.stats.height / 2 - sy;
          const m = Math.hypot(dx, dy) || 1;
          dx /= m; dy /= m;
          c.facing = dx >= 0 ? 1 : -1;
          this.projectiles.push({
            owner: c.owner, x: sx + dx * 30, y: sy + dy * 30,
            vx: dx * c.def.projectile.speed, vy: dy * c.def.projectile.speed,
            life: c.def.projectile.lifeTicks, armed: false, def: c.def.projectile,
          });
          this.events.push({ t: "shoot", id: c.owner, x: sx, y: sy });
          c.fireCooldown = c.def.fireEveryTicks;
        } else {
          c.fireCooldown = 12; // nothing in range: re-scan soon
        }
      }
    }
  }

  // ---------------- fire zones ----------------
  private stepZones(): void {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.life--;
      if (z.life <= 0) {
        this.zones.splice(i, 1);
        continue;
      }
      for (const f of this.fighters) {
        if (f.state === "dead" || f.invuln > 0) continue;
        if (!this.friendlyFire && f.team === z.team) continue;
        if (!circleHitsBox(z.x, z.y, z.radius, hurtbox(f))) continue;
        f.burnTicks = Math.max(f.burnTicks, z.burnTicks);
        f.burnFrom = z.owner;
      }
    }
  }

  // ---------------- melee ----------------
  private resolveMelee(): void {
    for (const atk of this.fighters) {
      const a = atk.attack;
      if (!a || a.kind !== "melee" || atk.hitConfirmed || atk.state === "dead") continue;
      if (a.boxW <= 0 || a.boxH <= 0) continue; // stances (parry) have no outgoing hitbox
      const t = atk.attackTick;
      if (t < a.startupTicks || t >= a.startupTicks + a.activeTicks) continue;

      const scale = this.outScaleOf(atk.id) * (a.chargeable ? atk.chargeRelease : 1);
      const box = this.attackBox(atk, a);
      let parried = false;
      for (const vic of this.fighters) {
        if (vic.id === atk.id || vic.state === "dead" || vic.invuln > 0) continue;
        if (!this.friendlyFire && vic.team === atk.team) continue;
        const hb = this.hitRewind?.(atk, vic) ?? hurtbox(vic);
        if (!aabbOverlap(box.x, box.y, box.w, box.h, hb.x, hb.y, hb.w, hb.h)) continue;

        // parry: the swing is negated and returned with interest
        if (this.isParrying(vic)) {
          const pd = vic.attack!.parry!;
          let dx = atk.x - vic.x;
          let dy = atk.y - atk.stats.height / 2 - (vic.y - vic.stats.height / 2);
          const m = Math.hypot(dx, dy);
          if (m < 1e-6) { dx = vic.facing; dy = 0; } else { dx /= m; dy /= m; }
          this.events.push({ t: "parry", id: vic.id, x: vic.x, y: vic.y - vic.stats.height / 2 });
          this.applyHit(vic.id, atk, pd.damage, pd.baseKnockback, pd.kbGrowth, dx, dy, 10, true, 0, this.outScaleOf(vic.id));
          vic.attack = null; // stance consumed by the riposte
          vic.attackTick = 0;
          parried = true;
          break; // the attacker's swing no longer exists
        }

        // radial moves launch each victim away from the attacker's center
        let dirX = atk.atkDirX;
        let dirY = atk.atkDirY;
        if (a.radial) {
          let dx = vic.x - atk.x;
          let dy = vic.y - vic.stats.height / 2 - (atk.y - atk.stats.height / 2);
          const m = Math.hypot(dx, dy);
          if (m < 1e-6) { dx = atk.facing; dy = 0; } else { dx /= m; dy /= m; }
          dirX = dx;
          dirY = dy;
        }

        this.applyHit(atk.id, vic, a.damage, a.baseKnockback, a.kbGrowth, dirX, dirY, a.hitstop, a.heavy, a.hitstunBonus, scale, a.burn);
        atk.hitConfirmed = true;
      }
      if (parried) continue;

      // enemy constructs are valid melee targets (only if no fighter was hit)
      if (!atk.hitConfirmed) {
        for (const c of this.constructs) {
          if (c.owner === atk.id) continue;
          if (!this.friendlyFire && c.team === atk.team) continue;
          const cb = constructBox(c);
          if (!aabbOverlap(box.x, box.y, box.w, box.h, cb.x, cb.y, cb.w, cb.h)) continue;
          c.hp -= a.damage * scale;
          this.hitstop = Math.max(this.hitstop, Math.min(4, a.hitstop));
          this.events.push({ t: "consthit", x: c.x, y: c.y - c.def.height / 2 });
          atk.hitConfirmed = true;
          break;
        }
      }
    }
  }

  /** Attack hitbox in world space (see attackBoxOf). */
  attackBox(f: Fighter, a: MoveDef): { x: number; y: number; w: number; h: number } {
    return attackBoxOf(f, a);
  }

  // ---------------- stage hazards ----------------
  /**
   * Timed danger zones. Purely tick-driven (idle -> telegraph -> active);
   * an active zone hits each overlapping fighter once per activation
   * (hazardCooldown covers the rest of the window). Hazard hits go through
   * the normal hit path with attacker id -1 — no ownership, no meter for
   * the "attacker", full knockback/hitstun for the victim.
   */
  private stepHazards(): void {
    const hazards = this.stage.hazards;
    if (!hazards || hazards.length === 0) return;
    for (const h of hazards) {
      if (hazardStateAt(h, this.tick) !== "active") continue;
      for (const f of this.fighters) {
        if (f.state === "dead" || f.invuln > 0 || f.hazardCooldown > 0) continue;
        const hb = hurtbox(f);
        if (!aabbOverlap(h.x, h.y, h.w, h.h, hb.x, hb.y, hb.w, hb.h)) continue;
        const r = (h.angleDeg * Math.PI) / 180;
        this.applyHit(-1, f, h.damage, h.baseKnockback, h.kbGrowth, Math.cos(r), -Math.sin(r), h.hitstop, true, 0);
        f.hazardCooldown = h.activeTicks + 30;
      }
    }
  }

  /**
   * Unified hit application — melee, projectiles, explosions, hazards (-1),
   * and ripostes all land here. `outScale` folds in kindle and charge;
   * the knockback formula itself is unchanged and test-locked.
   */
  private applyHit(
    attackerId: number, vic: Fighter,
    damage: number, baseKB: number, kbGrowth: number,
    dirX: number, dirY: number, hitstop: number, heavy: boolean, hitstunBonus: number,
    outScale = 1, burn?: { ticks: number },
  ): void {
    const dmg = damage * outScale;
    vic.damage += dmg;
    // THE formula: magnitude from damage% and weight; direction from aim only.
    const magnitude = (baseKB * outScale + vic.damage * kbGrowth) / vic.stats.weight;
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
    vic.charging = false; // and interrupts a charge (no cooldown paid, no shot)
    vic.chargeTicks = 0;
    if (burn) {
      vic.burnTicks = Math.max(vic.burnTicks, burn.ticks);
      vic.burnFrom = attackerId;
    }

    // ultimate meter: attacker builds on damage dealt, victim on damage taken
    const atkF = attackerId >= 0 ? this.fighters[attackerId] : undefined;
    if (atkF && atkF.team !== vic.team) {
      atkF.ult = Math.min(ULT_TUNING.max, atkF.ult + dmg * ULT_TUNING.gainDealt);
    }
    vic.ult = Math.min(ULT_TUNING.max, vic.ult + dmg * ULT_TUNING.gainTaken);

    this.hitstop = Math.max(this.hitstop, hitstop);
    this.events.push({
      t: "hit", attacker: attackerId, victim: vic.id, damage: dmg, heavy,
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
    f.grounded = false; f.groundPlat = -1;
    f.hazardCooldown = 0;
    f.burnTicks = 0; f.burnFrom = -1; // the fall puts the fire out
    f.charging = false; f.chargeTicks = 0; f.chargeRelease = 1;
    // ult meter survives death — losing a stock keeps your comeback tool
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
