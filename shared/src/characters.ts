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

// ---------- shared effect defs ----------
/** Damage-over-time: TUNING.burnDamage every TUNING.burnIntervalTicks for `ticks`. Refreshes, never stacks. */
export interface BurnDef {
  ticks: number;
}

/** A lingering ground fire: enemies inside get their burn refreshed every tick. */
export interface FireZoneDef {
  radius: number;
  lifeTicks: number;
  burnTicks: number;
}

/** A deployable turret. Sits where placed (falls to the nearest platform), fires at the nearest enemy in range, can be destroyed. */
export interface ConstructDef {
  kindId: string;
  width: number;
  height: number;
  hp: number;
  lifeTicks: number;
  fireEveryTicks: number;
  range: number;
  /** Deploying beyond this cap removes the owner's oldest construct. */
  maxActive: number;
  projectile: ProjectileDef;
}

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
  /** Extra hitstun ticks on hit (snares/combo tools). */
  hitstunBonus?: number;
  /** Turn rate (radians/s) toward the nearest enemy. */
  homing?: number;
  /** Lands on a platform and arms as a mine instead of dying. */
  sticky?: boolean;
  /** Armed mines detonate when an enemy is within this radius. */
  triggerRadius?: number;
  /** On death (timeout/impact/trigger): AoE hit with this def's damage/knockback. */
  explodeRadius?: number;
  /** Applies burn on hit. */
  burn?: BurnDef;
  /** Leaves a fire zone where the projectile dies. */
  zoneOnDeath?: FireZoneDef;
}

// ---------- moves ----------
export type MoveSlot = "light" | "heavy" | "aerial" | "special" | "ultimate";

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
  /**
   * Hold-to-charge (specials): pressing starts a rooted charge; releasing
   * fires. Damage/knockback (and projectile speed) scale from minFactor at
   * zero charge to 1.0 at maxTicks.
   */
  chargeable?: { maxTicks: number; minFactor: number };
  /** Fired instead of `projectile` when released at >=95% charge. */
  chargedProjectile?: ProjectileDef;
  /** Blink along the locked aim at the first active tick. iframes granted at press. */
  teleport?: { distance: number; iframes: number };
  /** Spawn `projectile` at the pre-teleport position with zero velocity (mirror clones). Implies a single armed projectile. */
  projectileAtOrigin?: boolean;
  /** Deploy a construct at the first active tick. */
  construct?: ConstructDef;
  /** Spawn a fire zone centered on self at the first active tick. */
  zone?: FireZoneDef;
  /**
   * Parry stance: during the active window, incoming melee is negated and
   * countered with this hit; incoming projectiles are reflected. The stance
   * itself has no outgoing hitbox (boxW/boxH 0).
   */
  parry?: { damage: number; baseKnockback: number; kbGrowth: number };
  /** Knockback direction per victim = away from the attacker's center (radial bursts) instead of `angle`. */
  radial?: boolean;
  /** Fire this many projectiles fanned across spreadDeg (default 1). */
  projectileCount?: number;
  spreadDeg?: number;
  /** Damage% added to SELF at the first active tick (Pyre pays in flesh). */
  selfDamage?: number;
  /** Applies burn on melee hit. */
  burn?: BurnDef;
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
  /**
   * Pyre's mechanic: outgoing damage & base knockback scale by
   * 1 + kindle * min(ownDamage, 150) / 150 — burns brighter near death.
   */
  kindle?: number;
}

export type CharId =
  | "knight" | "mage" | "ranger" | "goblin" | "ogre" | "demon_queen"
  | "sable" | "hessa" | "pyre";

export interface Moveset {
  light: MoveDef;
  heavy: MoveDef;
  /** Replaces `light` while airborne. */
  aerial: MoveDef;
  /** Special button. Melee or projectile; usually has a cooldown. */
  special: MoveDef;
  /** Ultimate button; requires a full meter (ULT_TUNING.max), which it consumes. */
  ultimate: MoveDef;
}

export interface CharacterDef {
  id: CharId;
  name: string;
  /** "the Emberguard", "Queen of Cinders" — select-screen flourish. */
  epithet: string;
  /** Signature color (character select / accents). Match colors stay per-team. */
  color: number;
  tagline: string;
  /** Archetype label for the select screen ("Duelist", "Trickster", …). */
  role: string;
  /** A few sentences of Emberfall lore for the select screen. */
  lore: string;
  stats: CharacterStats;
  moves: Moveset;
}

/**
 * The roster. Distinctness levers: weight (0.65–1.5), speed (0.75–1.3),
 * jump count, frame speed (goblin startup 2 vs ogre 20), aimed vs fixed
 * launch angles, projectile shape (none / bolt / arc / lob / boulder /
 * mine / clone), and one signature mechanic each (parry, charge, traps,
 * DoT, teleport, constructs, kindle).
 */
export const CHARACTERS: Record<CharId, CharacterDef> = {
  knight: {
    id: "knight",
    name: "Aldric",
    epithet: "the Emberguard",
    color: 0xc9cdd6,
    role: "Duelist",
    tagline: "The oath outlived the order.",
    lore:
      "The last sworn shield of the Emberguard. He held the Keep's gate alone " +
      "the night it fell, and his order died believing he had run. The oath is " +
      "all he kept — that, and a shield that remembers every blow it has ever taken.",
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
      // Parry stance: no outgoing hitbox — negates one melee hit and ripostes;
      // reflects projectiles for the whole window. High-stakes meter spend.
      ultimate: move({
        id: "oath_of_embers", damage: 0, baseKnockback: 0, kbGrowth: 0,
        startupTicks: 3, activeTicks: 30, recoveryTicks: 20, hitstop: 0, heavy: true,
        parry: { damage: 24, baseKnockback: 900, kbGrowth: 18 },
      }),
    },
  },

  mage: {
    id: "mage",
    name: "Maelis",
    epithet: "the Ashweaver",
    color: 0x8a5ae8,
    role: "Spellweaver",
    tagline: "Hold the spark. Let it sing.",
    lore:
      "She weaves veilfire — the light ash gives off when it remembers being " +
      "alive. The Circle burned her books, so she recited them into the flame; " +
      "now the flame recites them back, one bolt at a time.",
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
      // Chargeable: tap = the familiar quick bolt; a full 50-tick charge fires
      // a slow HOMING star instead. Rooted while charging.
      special: move({
        id: "ember_bolt", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 6, activeTicks: 1, recoveryTicks: 10, hitstop: 0, cooldownTicks: 36,
        chargeable: { maxTicks: 50, minFactor: 0.55 },
        projectile: { speed: 1250, damage: 7, baseKnockback: 340, kbGrowth: 10, radius: 12, gravityScale: 0, lifeTicks: 70, hitstop: 4 },
        chargedProjectile: { speed: 900, damage: 13, baseKnockback: 520, kbGrowth: 13, radius: 17, gravityScale: 0, lifeTicks: 130, hitstop: 6, homing: 3.2 },
      }),
      ultimate: move({
        id: "veilfire_cataclysm", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 18, activeTicks: 1, recoveryTicks: 22, hitstop: 0, heavy: true,
        projectile: { speed: 620, damage: 24, baseKnockback: 780, kbGrowth: 18, radius: 30, gravityScale: 0, lifeTicks: 150, hitstop: 10, homing: 1.4, explodeRadius: 170 },
      }),
    },
  },

  ranger: {
    id: "ranger",
    name: "Wren",
    epithet: "of the Char-Woods",
    color: 0x3aa85e,
    role: "Trapper",
    tagline: "Step anywhere. See what happens.",
    lore:
      "Warden of the Char-Woods, where nothing green survives and everything " +
      "hungry does. Her snares are a courtesy — a fair warning that you have " +
      "walked far enough. The arrow that follows is not.",
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
      // Three ember-snares fan out, stick where they land, and arm as
      // proximity mines. Area control the rest of the roster can't answer.
      ultimate: move({
        id: "embersnare_volley", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 10, activeTicks: 1, recoveryTicks: 14, hitstop: 0, heavy: true,
        projectileCount: 3, spreadDeg: 34,
        projectile: { speed: 950, damage: 9, baseKnockback: 560, kbGrowth: 13, radius: 12, gravityScale: 0.6, lifeTicks: 600, hitstop: 6, sticky: true, triggerRadius: 85, explodeRadius: 110, hitstunBonus: 6 },
      }),
    },
  },

  goblin: {
    id: "goblin",
    name: "Snik",
    epithet: "the Powder-Rat",
    color: 0x9de83a,
    role: "Rushdown",
    tagline: "Three jumps, zero manners.",
    lore:
      "Stole powder from the Kiln-priests, stole the match from the Watch, " +
      "stole his own name off a wanted poster. The Undermarket adores him — " +
      "from a safe distance, wallets held tight.",
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
      ultimate: move({
        id: "powder_keg_parade", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 8, activeTicks: 1, recoveryTicks: 12, hitstop: 0, heavy: true,
        projectileCount: 3, spreadDeg: 26,
        projectile: { speed: 1050, damage: 11, baseKnockback: 600, kbGrowth: 14, radius: 15, gravityScale: 0.85, lifeTicks: 80, hitstop: 7, explodeRadius: 100 },
      }),
    },
  },

  ogre: {
    id: "ogre",
    name: "Gorvash",
    epithet: "Kiln-Breaker",
    color: 0xb8763a,
    role: "Bruiser",
    tagline: "One swing ends the conversation.",
    lore:
      "He broke the Great Kiln with the hammer they forged inside it, then " +
      "walked out through the wall because doors are for people in a hurry. " +
      "Now he wanders Emberfall looking for something else worth swinging at.",
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
      // The slowest, hardest single hit in the game. Land it or eat the recovery.
      ultimate: move({
        id: "kilnbreakers_verdict", damage: 30, baseKnockback: 1050, kbGrowth: 24,
        angle: 62, startupTicks: 26, activeTicks: 8, recoveryTicks: 28, hitstop: 14, heavy: true,
        offsetX: 60, offsetY: 0, boxW: 200, boxH: 170, lungeSpeed: 900,
      }),
    },
  },

  demon_queen: {
    id: "demon_queen",
    name: "Vexis",
    epithet: "Queen of Cinders",
    color: 0xe83a9d,
    role: "Elementalist",
    tagline: "Everything burns politely, eventually.",
    lore:
      "The Ash Court kneels to the queen who out-burned the fire that came " +
      "for her throne. Cinders fall wherever she walks; she calls them her " +
      "subjects, and like all her subjects they cling and they consume.",
    stats: { weight: 1.15, jumpCount: 2, width: 72, height: 116, speedMult: 1.0, jumpMult: 1.05, fallMult: 0.9 },
    moves: {
      light: move({
        id: "claw_rake", damage: 6, baseKnockback: 310, kbGrowth: 9,
        startupTicks: 4, activeTicks: 5, recoveryTicks: 8, hitstop: 4,
        reach: 80, boxW: 90, boxH: 85,
      }),
      // Sets the victim alight: hellfire clings for 1.5s of chip damage.
      heavy: move({
        id: "hellfire_smash", damage: 16, baseKnockback: 720, kbGrowth: 18,
        angle: 48, startupTicks: 14, activeTicks: 6, recoveryTicks: 19, hitstop: 10, heavy: true,
        offsetX: 65, offsetY: -5, boxW: 115, boxH: 110,
        burn: { ticks: 90 },
      }),
      aerial: move({
        id: "wing_scythe", damage: 9, baseKnockback: 400, kbGrowth: 12,
        startupTicks: 6, activeTicks: 7, recoveryTicks: 10, hitstop: 6,
        reach: 90, boxW: 105, boxH: 100,
      }),
      // Soulfire ignites on hit AND leaves a cinder pool where it dies —
      // her zoning is area denial, not raw projectile damage.
      special: move({
        id: "soulfire", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 9, activeTicks: 1, recoveryTicks: 12, hitstop: 0, cooldownTicks: 80,
        projectile: {
          speed: 1350, damage: 10, baseKnockback: 460, kbGrowth: 12, radius: 14, gravityScale: 0, lifeTicks: 75, hitstop: 6,
          burn: { ticks: 150 }, zoneOnDeath: { radius: 90, lifeTicks: 180, burnTicks: 120 },
        },
      }),
      // A radial court of flame: launches everyone away from her and leaves
      // a huge burning ring to own the space she just cleared.
      ultimate: move({
        id: "court_of_ash", damage: 19, baseKnockback: 800, kbGrowth: 17,
        startupTicks: 16, activeTicks: 6, recoveryTicks: 24, hitstop: 11, heavy: true, radial: true,
        offsetX: 0, offsetY: -10, boxW: 320, boxH: 240,
        burn: { ticks: 150 }, zone: { radius: 200, lifeTicks: 360, burnTicks: 150 },
      }),
    },
  },

  sable: {
    id: "sable",
    name: "Sable",
    epithet: "the Hollow Veil",
    color: 0x9fb8d8,
    role: "Trickster",
    tagline: "You saw me. That was the mistake.",
    lore:
      "Something that stayed behind when its body walked away. The Veil " +
      "remembers the shape of everyone it touches — it wears those shapes " +
      "briefly, and leaves them behind the way a snake leaves skin. The skins " +
      "detonate.",
    stats: { weight: 0.8, jumpCount: 2, width: 62, height: 106, speedMult: 1.18, jumpMult: 1.05, fallMult: 0.92 },
    moves: {
      light: move({
        id: "veil_slash", damage: 5, baseKnockback: 290, kbGrowth: 8,
        startupTicks: 3, activeTicks: 4, recoveryTicks: 7, hitstop: 3,
        reach: 75, boxW: 85, boxH: 80,
      }),
      heavy: move({
        id: "hollow_rend", damage: 12, baseKnockback: 600, kbGrowth: 15,
        startupTicks: 10, activeTicks: 5, recoveryTicks: 16, hitstop: 8, heavy: true,
        reach: 90, boxW: 100, boxH: 95,
      }),
      aerial: move({
        id: "wisp_cut", damage: 6, baseKnockback: 320, kbGrowth: 9,
        startupTicks: 4, activeTicks: 6, recoveryTicks: 8, hitstop: 3,
        reach: 80, boxW: 90, boxH: 88,
      }),
      // Ash-step: blink 260px along aim with i-frames, leaving a mirror
      // clone at the origin that detonates on proximity or timeout.
      special: move({
        id: "ash_step", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 6, activeTicks: 1, recoveryTicks: 8, hitstop: 0, cooldownTicks: 85,
        teleport: { distance: 260, iframes: 10 }, projectileAtOrigin: true,
        projectile: { speed: 0, damage: 10, baseKnockback: 520, kbGrowth: 12, radius: 26, gravityScale: 0, lifeTicks: 50, hitstop: 6, triggerRadius: 95, explodeRadius: 120 },
      }),
      ultimate: move({
        id: "hollow_requiem", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 5, activeTicks: 1, recoveryTicks: 6, hitstop: 0, heavy: true,
        teleport: { distance: 420, iframes: 18 }, projectileAtOrigin: true,
        projectile: { speed: 0, damage: 22, baseKnockback: 850, kbGrowth: 19, radius: 34, gravityScale: 0, lifeTicks: 40, hitstop: 12, triggerRadius: 130, explodeRadius: 190 },
      }),
    },
  },

  hessa: {
    id: "hessa",
    name: "Hessa",
    epithet: "the Iron-Mother",
    color: 0xcf8a45,
    role: "Forgewright",
    tagline: "My children are always hungry.",
    lore:
      "Mother of the foundry-line, midwife to a hundred iron children. Her " +
      "little kilns toddle into battle still warm from the forge, and they do " +
      "not cry, and they do not miss.",
    stats: { weight: 1.2, jumpCount: 2, width: 78, height: 112, speedMult: 0.85, jumpMult: 0.92, fallMult: 1.05 },
    moves: {
      light: move({
        id: "hammer_tap", damage: 8, baseKnockback: 360, kbGrowth: 9,
        startupTicks: 6, activeTicks: 4, recoveryTicks: 11, hitstop: 5,
        reach: 85, boxW: 95, boxH: 85,
      }),
      heavy: move({
        id: "smelters_swing", damage: 14, baseKnockback: 640, kbGrowth: 16,
        angle: 40, startupTicks: 13, activeTicks: 6, recoveryTicks: 19, hitstop: 9, heavy: true,
        offsetX: 62, offsetY: -8, boxW: 110, boxH: 100,
      }),
      aerial: move({
        id: "slag_sweep", damage: 8, baseKnockback: 380, kbGrowth: 11,
        startupTicks: 6, activeTicks: 6, recoveryTicks: 11, hitstop: 5,
        reach: 82, boxW: 95, boxH: 90,
      }),
      // Deploys a Little Kiln: a destructible turret that holds ground and
      // pelts the nearest enemy. Only one at a time — placement IS the skill.
      special: move({
        id: "little_kiln", damage: 0, baseKnockback: 0, kbGrowth: 0,
        startupTicks: 12, activeTicks: 1, recoveryTicks: 16, hitstop: 0, cooldownTicks: 240,
        construct: {
          kindId: "kiln", width: 56, height: 64, hp: 24, lifeTicks: 720,
          fireEveryTicks: 55, range: 780, maxActive: 1,
          projectile: { speed: 1150, damage: 5, baseKnockback: 280, kbGrowth: 8, radius: 10, gravityScale: 0, lifeTicks: 55, hitstop: 3 },
        },
      }),
      ultimate: move({
        id: "foundry_overdrive", damage: 0, baseKnockback: 0, kbGrowth: 0,
        startupTicks: 14, activeTicks: 1, recoveryTicks: 18, hitstop: 0, heavy: true,
        construct: {
          kindId: "great_kiln", width: 74, height: 88, hp: 60, lifeTicks: 900,
          fireEveryTicks: 32, range: 950, maxActive: 1,
          projectile: { speed: 1250, damage: 8, baseKnockback: 380, kbGrowth: 10, radius: 13, gravityScale: 0, lifeTicks: 60, hitstop: 5 },
        },
      }),
    },
  },

  pyre: {
    id: "pyre",
    name: "Pyre",
    epithet: "the Last Ember",
    color: 0xff9d3a,
    role: "Wildcard",
    tagline: "Burns brightest at the end.",
    lore:
      "The last coal of Emberfall's first fire, small enough to cup in two " +
      "hands and old enough to remember why you shouldn't. Every wound fans " +
      "it hotter. Kill it slowly and you will not live to finish the job.",
    stats: { weight: 0.65, jumpCount: 2, width: 54, height: 84, speedMult: 1.1, jumpMult: 1.08, fallMult: 0.78, kindle: 1.0 },
    moves: {
      light: move({
        id: "cinder_flick", damage: 4, baseKnockback: 250, kbGrowth: 7,
        startupTicks: 3, activeTicks: 4, recoveryTicks: 6, hitstop: 3,
        reach: 65, boxW: 75, boxH: 75,
      }),
      heavy: move({
        id: "flare_burst", damage: 9, baseKnockback: 460, kbGrowth: 12,
        startupTicks: 9, activeTicks: 5, recoveryTicks: 13, hitstop: 7, heavy: true,
        reach: 80, boxW: 95, boxH: 95,
      }),
      aerial: move({
        id: "waft", damage: 5, baseKnockback: 300, kbGrowth: 9,
        startupTicks: 3, activeTicks: 6, recoveryTicks: 7, hitstop: 3,
        reach: 70, boxW: 85, boxH: 85,
      }),
      special: move({
        id: "spark_lash", damage: 0, baseKnockback: 0, kbGrowth: 0, kind: "projectile",
        startupTicks: 5, activeTicks: 1, recoveryTicks: 9, hitstop: 0, cooldownTicks: 48,
        projectile: { speed: 1150, damage: 6, baseKnockback: 330, kbGrowth: 9, radius: 11, gravityScale: 0.15, lifeTicks: 65, hitstop: 4, burn: { ticks: 90 } },
      }),
      // Pays 18% of its own damage UP FRONT — which feeds its kindle scaling —
      // then erupts radially and leaves a burning crater. All-in by design.
      ultimate: move({
        id: "supernova", damage: 16, baseKnockback: 820, kbGrowth: 20,
        startupTicks: 14, activeTicks: 6, recoveryTicks: 26, hitstop: 13, heavy: true, radial: true,
        offsetX: 0, offsetY: -6, boxW: 340, boxH: 260,
        selfDamage: 18, zone: { radius: 150, lifeTicks: 240, burnTicks: 120 },
      }),
    },
  },
};

export const CHAR_IDS = Object.keys(CHARACTERS) as CharId[];
