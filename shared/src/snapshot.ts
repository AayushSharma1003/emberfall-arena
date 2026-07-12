/**
 * Full sim-state serialization. The server broadcasts these; clients load
 * them verbatim and re-simulate their pending local inputs on top
 * (reconciliation). Everything mutable in the sim must round-trip through
 * here — a forgotten field is a desync.
 */
import { CHARACTERS, type CharId, type ConstructDef, type MoveDef, type ProjectileDef } from "./characters.js";
import type { Construct, Fighter, FireZone, Projectile, Sim, WorldItem } from "./sim.js";

export interface FighterSnap {
  id: number;
  team: number;
  charId: CharId;
  x: number; y: number; vx: number; vy: number;
  facing: 1 | -1;
  aimX: number; aimY: number;
  grounded: boolean;
  groundPlat: number;
  jumpsUsed: number;
  jumpHeld: boolean;
  state: Fighter["state"];
  damage: number;
  stocks: number;
  ult: number;
  burnTicks: number;
  burnFrom: number;
  charging: boolean;
  chargeTicks: number;
  chargeRelease: number;
  coyote: number;
  jumpBuffer: number;
  dropThrough: number;
  speedBoost: number;
  hazardCooldown: number;
  hitstun: number;
  invuln: number;
  respawnTimer: number;
  dashTicks: number;
  dashCooldown: number;
  airDashUsed: boolean;
  specialCooldown: number;
  attackId: string | null;
  attackTick: number;
  bufSlot: Fighter["bufSlot"];
  bufTicks: number;
  atkAimX: number; atkAimY: number;
  atkDirX: number; atkDirY: number;
  hitConfirmed: boolean;
  prevButtons: number;
}

export interface ProjSnap {
  owner: number;
  x: number; y: number; vx: number; vy: number;
  life: number;
  armed: boolean;
  hits?: number[];
  def: ProjectileDef;
}

export interface ConstructSnap {
  owner: number;
  team: number;
  x: number; y: number; vy: number;
  hp: number;
  life: number;
  fireCooldown: number;
  facing: 1 | -1;
  def: ConstructDef;
}

export interface SimSnap {
  tick: number;
  hitstop: number;
  fighters: FighterSnap[];
  projectiles: ProjSnap[];
  constructs: ConstructSnap[];
  zones: FireZone[];
  items: WorldItem[];
}

export function serializeFighter(f: Fighter): FighterSnap {
  return {
    id: f.id, team: f.team, charId: f.charId,
    x: f.x, y: f.y, vx: f.vx, vy: f.vy,
    facing: f.facing, aimX: f.aimX, aimY: f.aimY,
    grounded: f.grounded, groundPlat: f.groundPlat, jumpsUsed: f.jumpsUsed, jumpHeld: f.jumpHeld,
    state: f.state, damage: f.damage, stocks: f.stocks,
    ult: f.ult, burnTicks: f.burnTicks, burnFrom: f.burnFrom,
    charging: f.charging, chargeTicks: f.chargeTicks, chargeRelease: f.chargeRelease,
    coyote: f.coyote, jumpBuffer: f.jumpBuffer, dropThrough: f.dropThrough,
    speedBoost: f.speedBoost, hazardCooldown: f.hazardCooldown,
    hitstun: f.hitstun, invuln: f.invuln, respawnTimer: f.respawnTimer,
    dashTicks: f.dashTicks, dashCooldown: f.dashCooldown,
    airDashUsed: f.airDashUsed, specialCooldown: f.specialCooldown,
    attackId: f.attack?.id ?? null, attackTick: f.attackTick,
    bufSlot: f.bufSlot, bufTicks: f.bufTicks,
    atkAimX: f.atkAimX, atkAimY: f.atkAimY,
    atkDirX: f.atkDirX, atkDirY: f.atkDirY,
    hitConfirmed: f.hitConfirmed, prevButtons: f.prevButtons,
  };
}

function moveById(charId: CharId, id: string): MoveDef | null {
  const m = CHARACTERS[charId].moves;
  for (const mv of [m.light, m.heavy, m.aerial, m.special, m.ultimate]) {
    if (mv.id === id) return mv;
  }
  return null;
}

export function applyFighterSnap(f: Fighter, s: FighterSnap): void {
  if (f.charId !== s.charId) {
    const c = CHARACTERS[s.charId];
    f.charId = c.id;
    f.stats = { ...c.stats };
    f.moves = c.moves;
  }
  f.team = s.team;
  f.x = s.x; f.y = s.y; f.vx = s.vx; f.vy = s.vy;
  f.facing = s.facing; f.aimX = s.aimX; f.aimY = s.aimY;
  f.grounded = s.grounded; f.groundPlat = s.groundPlat; f.jumpsUsed = s.jumpsUsed; f.jumpHeld = s.jumpHeld;
  f.state = s.state; f.damage = s.damage; f.stocks = s.stocks;
  f.ult = s.ult; f.burnTicks = s.burnTicks; f.burnFrom = s.burnFrom;
  f.charging = s.charging; f.chargeTicks = s.chargeTicks; f.chargeRelease = s.chargeRelease;
  f.coyote = s.coyote; f.jumpBuffer = s.jumpBuffer; f.dropThrough = s.dropThrough;
  f.speedBoost = s.speedBoost; f.hazardCooldown = s.hazardCooldown;
  f.hitstun = s.hitstun; f.invuln = s.invuln; f.respawnTimer = s.respawnTimer;
  f.dashTicks = s.dashTicks; f.dashCooldown = s.dashCooldown;
  f.airDashUsed = s.airDashUsed; f.specialCooldown = s.specialCooldown;
  f.attack = s.attackId === null ? null : moveById(s.charId, s.attackId);
  f.attackTick = s.attackTick;
  f.bufSlot = s.bufSlot; f.bufTicks = s.bufTicks;
  f.atkAimX = s.atkAimX; f.atkAimY = s.atkAimY;
  f.atkDirX = s.atkDirX; f.atkDirY = s.atkDirY;
  f.hitConfirmed = s.hitConfirmed; f.prevButtons = s.prevButtons;
}

export function serializeSim(sim: Sim): SimSnap {
  return {
    tick: sim.tick,
    hitstop: sim.hitstop,
    fighters: sim.fighters.map(serializeFighter),
    projectiles: sim.projectiles.map((p: Projectile): ProjSnap => ({
      owner: p.owner, x: p.x, y: p.y, vx: p.vx, vy: p.vy, life: p.life, armed: p.armed,
      hits: p.hits ? [...p.hits] : undefined, def: { ...p.def },
    })),
    constructs: sim.constructs.map((c: Construct): ConstructSnap => ({
      owner: c.owner, team: c.team, x: c.x, y: c.y, vy: c.vy,
      hp: c.hp, life: c.life, fireCooldown: c.fireCooldown, facing: c.facing,
      def: { ...c.def, projectile: { ...c.def.projectile } },
    })),
    zones: sim.zones.map((z: FireZone) => ({ ...z })),
    items: sim.items.map((it) => ({ ...it })),
  };
}

/** Load a snapshot into an existing sim (fighter count must match). */
export function applySimSnap(sim: Sim, snap: SimSnap): void {
  if (sim.fighters.length !== snap.fighters.length) {
    throw new Error(`snapshot fighter count ${snap.fighters.length} != sim ${sim.fighters.length}`);
  }
  sim.tick = snap.tick;
  sim.hitstop = snap.hitstop;
  for (let i = 0; i < snap.fighters.length; i++) {
    applyFighterSnap(sim.fighters[i], snap.fighters[i]);
  }
  sim.projectiles = snap.projectiles.map((p) => ({
    owner: p.owner, x: p.x, y: p.y, vx: p.vx, vy: p.vy, life: p.life, armed: p.armed,
    hits: p.hits ? [...p.hits] : undefined, def: { ...p.def },
  }));
  sim.constructs = snap.constructs.map((c) => ({
    owner: c.owner, team: c.team, x: c.x, y: c.y, vy: c.vy,
    hp: c.hp, life: c.life, fireCooldown: c.fireCooldown, facing: c.facing,
    def: { ...c.def, projectile: { ...c.def.projectile } },
  }));
  sim.zones = snap.zones.map((z) => ({ ...z }));
  sim.items = snap.items.map((it) => ({ ...it }));
}
