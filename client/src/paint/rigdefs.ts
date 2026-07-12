/**
 * Per-fighter rig definitions: pure data. Proportions are fractions of the
 * fighter's HURTBOX (width/height from CharacterStats) so the visual body
 * always agrees with the collision body. Silhouette distinctness lives here:
 * limb ratios, head styles, weapon geometry, capes, and flourishes.
 */
import type { CharId } from "@emberfall/shared";

export type HeadStyle =
  | "knight" | "circlet" | "hood" | "goblin" | "brute" | "crown" | "veil" | "matron";
export type WeaponStyle =
  | "sword" | "staff" | "bow" | "knife" | "anvilclub" | "claws" | "forgehammer" | "none";
export type ExtraStyle = "wings" | "quiver" | "bombbag" | "kilnpack" | "shield";

export interface RigPalette {
  skin: number;
  cloth: number;
  clothDark: number;
  metal: number;
  accent: number;
  glow: number;
}

export interface HumanoidRigDef {
  kind: "humanoid";
  palette: RigPalette;
  /** Fractions of hurtbox height unless noted. */
  headR: number;
  torsoW: number; // fraction of hurtbox WIDTH (can exceed 1 for the ogre)
  torsoH: number;
  hipY: number; // pelvis height
  armUpper: number;
  armFore: number;
  armW: number; // limb thickness, fraction of width
  legThigh: number;
  legShin: number;
  legW: number;
  stance: number; // half foot-spread, fraction of width
  head: HeadStyle;
  weapon: WeaponStyle;
  weaponLen: number; // fraction of height
  cape?: { segments: number; width: number; length: number; color: number };
  /** Ghost-skirt instead of legs (Sable). */
  wisp?: boolean;
  extras?: ExtraStyle[];
}

export interface FlameRigDef {
  kind: "flame";
  palette: { core: number; mid: number; outer: number; eye: number };
}

export type RigDef = HumanoidRigDef | FlameRigDef;

const defs: Record<CharId, RigDef> = {
  // Aldric — tall, square, armored. Longsword + kite shield, tattered
  // half-cape in his order's ash-grey. Reads: the wall that holds.
  knight: {
    kind: "humanoid",
    palette: { skin: 0xd9b48f, cloth: 0x5a5f6e, clothDark: 0x3a3e4a, metal: 0xc9cdd6, accent: 0xc9cdd6, glow: 0xffd75a },
    headR: 0.115, torsoW: 0.92, torsoH: 0.4, hipY: 0.47,
    armUpper: 0.2, armFore: 0.19, armW: 0.24,
    legThigh: 0.24, legShin: 0.23, legW: 0.26, stance: 0.3,
    head: "knight", weapon: "sword", weaponLen: 0.72,
    cape: { segments: 4, width: 0.75, length: 0.52, color: 0x4a4550 },
    extras: ["shield"],
  },

  // Maelis — slight, long robes, staff taller than she is, hair like smoke.
  // Reads: the silhouette that stands very still and should worry you.
  mage: {
    kind: "humanoid",
    palette: { skin: 0xe8cfae, cloth: 0x5d4a8a, clothDark: 0x3d2f60, metal: 0x8a5ae8, accent: 0x8a5ae8, glow: 0xc9a2ff },
    headR: 0.105, torsoW: 0.8, torsoH: 0.38, hipY: 0.44,
    armUpper: 0.18, armFore: 0.18, armW: 0.17,
    legThigh: 0.23, legShin: 0.22, legW: 0.18, stance: 0.18,
    head: "circlet", weapon: "staff", weaponLen: 1.1,
    cape: { segments: 4, width: 0.9, length: 0.62, color: 0x4a3a70 },
  },

  // Wren — lean, hooded, quiver on the hip, recurve bow. Always slightly
  // crouched, like she's about to not be there anymore.
  ranger: {
    kind: "humanoid",
    palette: { skin: 0xc9a276, cloth: 0x3e5a42, clothDark: 0x27392b, metal: 0x8a7a5a, accent: 0x3aa85e, glow: 0x7de89a },
    headR: 0.105, torsoW: 0.78, torsoH: 0.36, hipY: 0.46,
    armUpper: 0.19, armFore: 0.19, armW: 0.16,
    legThigh: 0.25, legShin: 0.24, legW: 0.17, stance: 0.34,
    head: "hood", weapon: "bow", weaponLen: 0.6,
    extras: ["quiver"],
  },

  // Snik — tiny, all ears and knees, bomb satchel bigger than his torso.
  // Reads: kinetic chaos at ankle height.
  goblin: {
    kind: "humanoid",
    palette: { skin: 0x8fc44a, cloth: 0x6e4a2a, clothDark: 0x4a3018, metal: 0x9a8a6a, accent: 0x9de83a, glow: 0xd6ff7a },
    headR: 0.16, torsoW: 0.85, torsoH: 0.3, hipY: 0.4,
    armUpper: 0.17, armFore: 0.17, armW: 0.18,
    legThigh: 0.2, legShin: 0.2, legW: 0.19, stance: 0.38,
    head: "goblin", weapon: "knife", weaponLen: 0.32,
    extras: ["bombbag"],
  },

  // Gorvash — a mountain with a grievance. Head tiny, shoulders enormous,
  // anvil-club dragging. Reads instantly at any zoom.
  ogre: {
    kind: "humanoid",
    palette: { skin: 0xa8795a, cloth: 0x6a4a33, clothDark: 0x46311f, metal: 0x7a736a, accent: 0xb8763a, glow: 0xffa53a },
    headR: 0.08, torsoW: 1.15, torsoH: 0.46, hipY: 0.42,
    armUpper: 0.24, armFore: 0.22, armW: 0.34,
    legThigh: 0.2, legShin: 0.19, legW: 0.34, stance: 0.34,
    head: "brute", weapon: "anvilclub", weaponLen: 0.62,
  },

  // Vexis — regal and wrong: horned crown, clawed gauntlets, a court train
  // that burns at the hem. Wings folded like a decision not yet made.
  demon_queen: {
    kind: "humanoid",
    palette: { skin: 0xd8a8b8, cloth: 0x5a2340, clothDark: 0x3a1428, metal: 0xe83a9d, accent: 0xe83a9d, glow: 0xff7ac2 },
    headR: 0.105, torsoW: 0.85, torsoH: 0.4, hipY: 0.46,
    armUpper: 0.2, armFore: 0.19, armW: 0.18,
    legThigh: 0.25, legShin: 0.24, legW: 0.19, stance: 0.22,
    head: "crown", weapon: "claws", weaponLen: 0.22,
    cape: { segments: 5, width: 1.1, length: 0.68, color: 0x8a1f4a },
    extras: ["wings"],
  },

  // Sable — no legs, no face. A hooded veil over a wisp-tail, twin glints
  // where hands should be. The silhouette with the hole in it.
  sable: {
    kind: "humanoid",
    palette: { skin: 0x1a1626, cloth: 0x2e3a52, clothDark: 0x1c2333, metal: 0x9fb8d8, accent: 0x9fb8d8, glow: 0x9fd8ff },
    headR: 0.11, torsoW: 0.8, torsoH: 0.36, hipY: 0.48,
    armUpper: 0.19, armFore: 0.18, armW: 0.15,
    legThigh: 0.22, legShin: 0.2, legW: 0.16, stance: 0.2,
    head: "veil", weapon: "knife", weaponLen: 0.3,
    cape: { segments: 5, width: 0.95, length: 0.58, color: 0x232c40 },
    wisp: true,
  },

  // Hessa — broad, aproned, forge-hammer over the shoulder, kiln-pack
  // glowing on her back. Reads: someone's very dangerous mother.
  hessa: {
    kind: "humanoid",
    palette: { skin: 0xc98f6a, cloth: 0x7a4a2e, clothDark: 0x52301c, metal: 0x8a8578, accent: 0xcf8a45, glow: 0xffb35a },
    headR: 0.1, torsoW: 1.0, torsoH: 0.42, hipY: 0.44,
    armUpper: 0.21, armFore: 0.2, armW: 0.26,
    legThigh: 0.22, legShin: 0.2, legW: 0.24, stance: 0.28,
    head: "matron", weapon: "forgehammer", weaponLen: 0.58,
    extras: ["kilnpack"],
  },

  // Pyre — not a body at all. A flame with intent.
  pyre: {
    kind: "flame",
    palette: { core: 0xfff3c0, mid: 0xff9d3a, outer: 0xd6431f, eye: 0x2a1408 },
  },
};

export const RIGS: Record<CharId, RigDef> = defs;
