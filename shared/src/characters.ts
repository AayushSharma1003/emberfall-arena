/**
 * Character + frame-data schema. Plain JSON-compatible data, shared by the
 * client sim now and the server sim in the netcode phase — keep this file
 * free of any client- or server-only imports.
 *
 * All time units are sim ticks (60/s). All distances are world pixels.
 * Knockback: magnitude = (baseKnockback + victimDamage% * kbGrowth) / weight,
 * direction per `angle` (see MoveDef.angle) — the formula itself lives in the
 * sim and is locked by tests; move data only feeds it.
 */

// ---------- projectiles ----------
export interface ProjectileDef {
  speed: number;
  damage: number;
  baseKnockback: number;
  kbGrowth: number;
  radius: number;
  gravityScale: number; // 0 = straight bolt, 1 = full ballistic arc
  lifeTicks: number;
  hitstop: number;
}

// ---------- moves ----------
export type MoveSlot = "light" | "heavy" | "aerial" | "special";

export interface MoveDef {
  id: string;
  kind: "melee" | "projectile";
  damage: number;
  baseKnockback: number;
  kbGrowth: number;
  /**
   * Knockback direction. "aim" = the attacker's aim locked at button press
   * (full 360°). A number = fixed launch angle in degrees, mirrored by facing:
   * 0 = straight toward facing, 90 = straight up, negative = downward (spike).
   */
  angle: "aim" | number;
  startupTicks: number;
  activeTicks: number;
  recoveryTicks: number;
  hitstop: number;
  /** Extra hitstun ticks on top of the global formula (combo tools). */
  hitstunBonus: number;
  /** Heavy hits get bigger hitstop/shake/VFX treatment by the renderer. */
  heavy: boolean;
  /**
   * Melee hitbox placement:
   *  - angle === "aim": box centered `reach` px from body center along locked aim.
   *  - fixed angle: box centered at (offsetX * facing, offsetY) from body center
   *    (offsetY negative = up).
   */
  reach: number;
  offsetX: number;
  offsetY: number;
  boxW: number;
  boxH: number;
  /** Self-impulse at the first active tick: along locked aim for aimed moves, horizontal along facing for fixed-angle moves. 0 = none. */
  lungeSpeed: number;
  /** Cooldown ticks before this move can be used again (specials). 0 = none. */
  cooldownTicks: number;
  /** Required when kind === "projectile": spawned at the first active tick, fired along locked aim. */
  projectile?: ProjectileDef;
}

/** Fill schema defaults so character data stays readable. */
function move(m: Partial<MoveDef> & Pick<MoveDef, "id" | "damage" | "baseKnockback" | "kbGrowth" | "startupTicks" | "activeTicks" | "recoveryTicks" | "hitstop">): MoveDef {
  return {
    kind: "melee",
    angle: "aim",
    hitstunBonus: 0,
    heavy: false,
    reach: 0,
    offsetX: 0,
    offsetY: 0,
    boxW: 0,
    boxH: 0,
    lungeSpeed: 0,
    cooldownTicks: 0,
    ...m,
  };
}

// ---------- characters ----------
export interface CharacterStats {
  /** Knockback divisor. Heavier = harder to launch. */
  weight: number;
  /** Total jumps (ground + air). */
  jumpCount: number;
  width: number;
  height: number;
  /** Scales run speed and ground/air acceleration. */
  speedMult: number;
  /** Scales jump and double-jump velocity. */
  jumpMult: number;
  /** Scales gravity and fall-speed caps (low = floaty). */
  fallMult: number;
}

export type CharId = "knight" | "mage" | "ranger" | "goblin" | "ogre" | "demon_queen";

export interface Moveset {
  light: MoveDef;
  heavy: MoveDef;
  /** Replaces `light` while airborne. */
  aerial: MoveDef;
  /** Special button. Melee or projectile; usually has a cooldown. */
  special: MoveDef;
}

export interface CharacterDef {
  id: CharId;
  name: string;
  /** Signature color (character select / accents). Match colors stay per-team. */
  color: number;
  tagline: string;
  stats: CharacterStats;
  moves: Moveset;
}

/**
 * The roster. Distinctness levers: weight (0.7–1.5), speed (0.75–1.3),
 * jump count, frame speed (goblin startup 2 vs ogre 20), aimed vs fixed
 * launch angles, and projectile shape (none / bolt / arc / lob / boulder).
 */
export const CHARACTERS: Record<CharId, CharacterDef> = {
  knight: {
    id: "knight",
    name: "Knight",
    color: 0xc9cdd6,
    tagline: "Balanced sword-and-board. No projectile — the shield IS the answer.",
    stats: { weight: 1.05, jumpCount: 2, width: 70, height: 110, speedMult: 1.0, jumpMult: 1.0, fallMult: 1.0 },
    moves: {
      light: move({
        id: "sword_slash", damage: 7, baseKnockback: 330, kbGrowth: 9,
        startupTicks: 4, activeTicks: 5, recoveryTicks: 9, hitstop: 4,
        reach: 82, boxW: 95, boxH: 85,
      }),
      heavy: move({
        id: "crusader_cleave", damage: 15, baseKnockback: 650, kbGrowth: 17,
        startupTicks: 11, activeTicks: 6, recoveryTicks: 18, hitstop: 8, heavy: true,
        reach: 95, boxW: 115, boxH: 105,
      }),
      aerial: move({
        id: "skyward_arc", damage: 8, baseKnockback: 360, kbGrowth: 10,
        startupTicks: 5, activeTicks: 6, recoveryTicks: 10, hitstop: 4,
        reach: 85, boxW: 100, boxH: 95,
      }),
      special: move({
        id: "shield_charge", damage: 10, baseKnockback: 520, kbGrowth: 11,
        angle: 15, startupTicks: 7, activeTicks: 8, recoveryTicks: 14, hitstop: 6, heavy: true,
        offsetX: 55, offsetY: -10, boxW: 90, boxH: 100,
        lungeSpeed: 1250, cooldownTicks: 90,
      }),
    },
  },

  mage: {
    id: "mage",
    name: "Mage",
    color: 0x8a5ae8,
    tagline: "Floaty zoner. Weak up close, oppressive at range.",
    stats: { weight: 0.85, jumpCount: 2, width: 66, height: 108, speedMult: 0.88, jumpMult: 1.0, fallMult: 0.8 },
    moves: {
      light: move({
        id: "arc_spark", damage: 5, baseKnockback: 300, kbGrowth: 8,
        startupTicks: 3, activeTicks: 4, recoveryTicks: 8, hitstop: 3,
        reach: 70, boxW: 80, boxH: 80,
      }),
      heavy: move({
        id: "nova_burst", damage: 13, baseKnockback: 700, kbGrowth: 18,
        angle: 60, startupTicks: 16, activeTicks: 5, recoveryTicks: 20, hitstop: 9, heavy: true,
        offsetX: 0, offsetY: -10, boxW: 220, boxH: 160, // radial blast centered on self
      }),
      aerial: move({
        id: "star_sweep", damage: 7, baseKnockback: 340, kbGrowth: 11,
        startupTicks: 5, activeTicks: 6, recoveryTicks: 9, hitstop: 4,
        reach: 80, boxW: 95, boxH: 95,
      }),
      special: move({
        id: "ember_bolt", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 6, activeTicks: 1, recoveryTicks: 10, hitstop: 0, cooldownTicks: 36,
        projectile: { speed: 1250, damage: 7, baseKnockback: 340, kbGrowth: 10, radius: 12, gravityScale: 0, lifeTicks: 70, hitstop: 4 },
      }),
    },
  },

  ranger: {
    id: "ranger",
    name: "Ranger",
    color: 0x3aa85e,
    tagline: "Fast skirmisher. Arrows arc — lead your shots.",
    stats: { weight: 0.9, jumpCount: 2, width: 64, height: 104, speedMult: 1.15, jumpMult: 1.05, fallMult: 1.0 },
    moves: {
      light: move({
        id: "knife_flick", damage: 5, baseKnockback: 290, kbGrowth: 8,
        startupTicks: 3, activeTicks: 4, recoveryTicks: 6, hitstop: 3,
        reach: 70, boxW: 80, boxH: 75,
      }),
      heavy: move({
        id: "boot_kick", damage: 11, baseKnockback: 560, kbGrowth: 14,
        angle: 35, startupTicks: 8, activeTicks: 5, recoveryTicks: 13, hitstop: 6, heavy: true,
        offsetX: 60, offsetY: -10, boxW: 95, boxH: 90,
      }),
      aerial: move({
        id: "aero_slash", damage: 6, baseKnockback: 320, kbGrowth: 9,
        startupTicks: 4, activeTicks: 5, recoveryTicks: 7, hitstop: 3,
        reach: 78, boxW: 88, boxH: 85,
      }),
      special: move({
        id: "longshot_arrow", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 5, activeTicks: 1, recoveryTicks: 8, hitstop: 0, cooldownTicks: 30,
        projectile: { speed: 1500, damage: 6, baseKnockback: 300, kbGrowth: 9, radius: 9, gravityScale: 0.5, lifeTicks: 90, hitstop: 3 },
      }),
    },
  },

  goblin: {
    id: "goblin",
    name: "Goblin",
    color: 0x9de83a,
    tagline: "Tiny, filthy, everywhere. Three jumps, no manners.",
    stats: { weight: 0.7, jumpCount: 3, width: 56, height: 88, speedMult: 1.3, jumpMult: 1.0, fallMult: 1.05 },
    moves: {
      light: move({
        id: "scratch_flurry", damage: 4, baseKnockback: 260, kbGrowth: 7,
        startupTicks: 2, activeTicks: 4, recoveryTicks: 5, hitstop: 3, hitstunBonus: 2,
        reach: 60, boxW: 70, boxH: 70,
      }),
      heavy: move({
        id: "shank", damage: 9, baseKnockback: 480, kbGrowth: 11,
        startupTicks: 6, activeTicks: 4, recoveryTicks: 10, hitstop: 6, heavy: true,
        reach: 65, boxW: 75, boxH: 75,
      }),
      aerial: move({
        id: "twirl", damage: 5, baseKnockback: 300, kbGrowth: 8,
        startupTicks: 3, activeTicks: 6, recoveryTicks: 6, hitstop: 3,
        reach: 62, boxW: 80, boxH: 80,
      }),
      special: move({
        id: "firecracker", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 4, activeTicks: 1, recoveryTicks: 8, hitstop: 0, cooldownTicks: 55,
        projectile: { speed: 900, damage: 8, baseKnockback: 420, kbGrowth: 12, radius: 13, gravityScale: 0.9, lifeTicks: 55, hitstop: 5 },
      }),
    },
  },

  ogre: {
    id: "ogre",
    name: "Ogre",
    color: 0xb8763a,
    tagline: "Slow. Enormous. One good slam ends the conversation.",
    stats: { weight: 1.5, jumpCount: 2, width: 92, height: 132, speedMult: 0.75, jumpMult: 0.95, fallMult: 1.1 },
    moves: {
      light: move({
        id: "club_swat", damage: 10, baseKnockback: 420, kbGrowth: 11,
        startupTicks: 8, activeTicks: 5, recoveryTicks: 14, hitstop: 6,
        reach: 95, boxW: 110, boxH: 100,
      }),
      heavy: move({
        id: "seismic_slam", damage: 19, baseKnockback: 850, kbGrowth: 22,
        angle: 85, startupTicks: 20, activeTicks: 6, recoveryTicks: 24, hitstop: 12, heavy: true,
        offsetX: 70, offsetY: 10, boxW: 130, boxH: 120,
      }),
      aerial: move({
        id: "belly_crush", damage: 12, baseKnockback: 520, kbGrowth: 14,
        angle: -70, // spike: down-forward
        startupTicks: 9, activeTicks: 7, recoveryTicks: 15, hitstop: 7, heavy: true,
        offsetX: 10, offsetY: 30, boxW: 110, boxH: 90,
      }),
      special: move({
        id: "boulder_toss", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 12, activeTicks: 1, recoveryTicks: 16, hitstop: 0, cooldownTicks: 110,
        projectile: { speed: 1000, damage: 13, baseKnockback: 560, kbGrowth: 15, radius: 20, gravityScale: 0.7, lifeTicks: 80, hitstop: 8 },
      }),
    },
  },

  demon_queen: {
    id: "demon_queen",
    name: "Demon Queen",
    color: 0xe83a9d,
    tagline: "Power in every direction. Pays for it in recovery frames.",
    stats: { weight: 1.15, jumpCount: 2, width: 72, height: 116, speedMult: 1.0, jumpMult: 1.05, fallMult: 0.9 },
    moves: {
      light: move({
        id: "claw_rake", damage: 6, baseKnockback: 310, kbGrowth: 9,
        startupTicks: 4, activeTicks: 5, recoveryTicks: 8, hitstop: 4,
        reach: 80, boxW: 90, boxH: 85,
      }),
      heavy: move({
        id: "hellfire_smash", damage: 16, baseKnockback: 720, kbGrowth: 18,
        angle: 48, startupTicks: 14, activeTicks: 6, recoveryTicks: 19, hitstop: 10, heavy: true,
        offsetX: 65, offsetY: -5, boxW: 115, boxH: 110,
      }),
      aerial: move({
        id: "wing_scythe", damage: 9, baseKnockback: 400, kbGrowth: 12,
        startupTicks: 6, activeTicks: 7, recoveryTicks: 10, hitstop: 6,
        reach: 90, boxW: 105, boxH: 100,
      }),
      special: move({
        id: "soulfire", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 9, activeTicks: 1, recoveryTicks: 12, hitstop: 0, cooldownTicks: 80,
        projectile: { speed: 1350, damage: 10, baseKnockback: 460, kbGrowth: 12, radius: 14, gravityScale: 0, lifeTicks: 75, hitstop: 6 },
      }),
    },
  },
};

export const CHAR_IDS = Object.keys(CHARACTERS) as CharId[];
