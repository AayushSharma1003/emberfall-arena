/**
 * Stage registry. Sim-side maps are pure data: platforms (with optional
 * tick-driven motion/phasing), hazards, blast zone, spawn and item points.
 * Everything visual lives client-side, keyed by `theme` — adding a map here
 * plus one scene painter on the client is the whole recipe.
 *
 * Blast-zone SHAPES are a balance lever: Keep is the neutral baseline,
 * Molten Span is wide (horizontal KOs), Stormshard is tall and narrow
 * (vertical play), the Ashwood is the widest (edge-guard country).
 */
import { emberfallKeep, type Stage } from "./sim.js";

export type StageTheme = "keep" | "span" | "shard" | "ashwood";

export interface StageInfo {
  id: string;
  name: string;
  tagline: string;
  theme: StageTheme;
  /** Reserved audio hooks — track ids the audio bus resolves (or ignores). */
  musicTrack: string;
  ambienceTrack: string;
  make: () => Stage;
}

/**
 * Map 2: The Molten Span — two islands over a lethal gap, deep in the forge
 * levels. A magma geyser erupts up through the gap every 10 seconds (long
 * telegraph — leaving the bridge is your job), and a forge-hammer platform
 * pounds slowly above the bridge. Wide blast zone: horizontal KOs rule here.
 */
export function moltenSpan(): Stage {
  return {
    platforms: [
      { x: 210, y: 800, w: 640, soft: false }, // left island
      { x: 1070, y: 800, w: 640, soft: false }, // right island (gap: 850..1070)
      { x: 780, y: 590, w: 360, soft: true }, // the bridge
      { x: 420, y: 570, w: 220, soft: true }, // side floats
      { x: 1280, y: 570, w: 220, soft: true },
      // the forge hammer: a slow vertical piston over the bridge
      { x: 895, y: 400, w: 130, soft: true, motion: { dx: 0, dy: 85, periodTicks: 420 } },
    ],
    blast: { left: -350, right: 2270, top: -450, bottom: 1420 },
    spawns: [
      { x: 480, y: 720 },
      { x: 1440, y: 720 },
      { x: 680, y: 720 },
      { x: 1240, y: 720 },
    ],
    itemSpawns: [
      { x: 960, y: 550 }, // on the bridge — contested
      { x: 530, y: 530 },
      { x: 1390, y: 530 },
    ],
    hazards: [
      {
        id: "magma_geyser",
        x: 850, y: 560, w: 220, h: 440, // fills the gap up to bridge height
        periodTicks: 600, telegraphTicks: 45, activeTicks: 12,
        damage: 14, baseKnockback: 780, kbGrowth: 12, angleDeg: 90, hitstop: 8,
      },
    ],
  };
}

/**
 * Map 3: Stormshard — a broken sliver of the old citadel adrift in a night
 * storm. Tall, narrow blast zone: juggles and spikes end stocks, the side
 * lines almost never do. Lightning hammers the two low spurs on an
 * alternating rhythm, and a wind-gondola drifts across the sky line.
 */
export function stormshard(): Stage {
  return {
    platforms: [
      { x: 660, y: 760, w: 600, soft: false }, // the shard's crown
      { x: 380, y: 900, w: 200, soft: false }, // low spurs — lightning rods
      { x: 1340, y: 900, w: 200, soft: false },
      { x: 810, y: 540, w: 300, soft: true }, // upper ledge
      // the gondola: drifts 330px each way across the top
      { x: 760, y: 330, w: 220, soft: true, motion: { dx: 330, dy: 0, periodTicks: 700 } },
    ],
    blast: { left: -150, right: 2070, top: -700, bottom: 1450 },
    spawns: [
      { x: 810, y: 680 },
      { x: 1110, y: 680 },
      { x: 480, y: 820 },
      { x: 1440, y: 820 },
    ],
    itemSpawns: [
      { x: 960, y: 500 },
      { x: 480, y: 860 },
      { x: 1440, y: 860 },
    ],
    hazards: [
      {
        id: "lightning_west",
        x: 380, y: 640, w: 200, h: 260,
        periodTicks: 480, telegraphTicks: 60, activeTicks: 8,
        damage: 16, baseKnockback: 850, kbGrowth: 14, angleDeg: 78, hitstop: 10,
      },
      {
        id: "lightning_east",
        x: 1340, y: 640, w: 200, h: 260,
        periodTicks: 480, telegraphTicks: 60, activeTicks: 8, phase: 0.5,
        damage: 16, baseKnockback: 850, kbGrowth: 14, angleDeg: 102, hitstop: 10,
      },
    ],
  };
}

/**
 * Map 4: The Ashwood — the forest that burned and kept growing. One wide
 * floor under a canopy branch; two great roots surface and withdraw on an
 * alternating rhythm (phasing platforms). The widest blast zone in the game:
 * kills happen at the edges, chase at your peril.
 */
export function ashwood(): Stage {
  return {
    platforms: [
      { x: 300, y: 820, w: 1320, soft: false }, // forest floor
      { x: 795, y: 420, w: 330, soft: true }, // canopy branch
      // living roots: 5s up, 3s withdrawn, alternating
      { x: 430, y: 600, w: 260, soft: true, phasing: { periodTicks: 480, solidTicks: 300 } },
      { x: 1230, y: 600, w: 260, soft: true, phasing: { periodTicks: 480, solidTicks: 300, phase: 0.5 } },
    ],
    blast: { left: -450, right: 2370, top: -500, bottom: 1400 },
    spawns: [
      { x: 660, y: 740 },
      { x: 1260, y: 740 },
      { x: 460, y: 740 },
      { x: 1460, y: 740 },
    ],
    itemSpawns: [
      { x: 960, y: 380 }, // canopy — high value, high exposure
      { x: 560, y: 560 },
      { x: 1360, y: 560 },
    ],
  };
}

export const STAGE_INFO: Record<string, StageInfo> = {
  emberfall_keep: {
    id: "emberfall_keep",
    name: "Emberfall Keep",
    tagline: "The cathedral-fortress that started the fire. Its balconies are older than they look.",
    theme: "keep",
    musicTrack: "music_keep_dusk",
    ambienceTrack: "amb_keep_embers",
    make: emberfallKeep,
  },
  molten_span: {
    id: "molten_span",
    name: "The Molten Span",
    tagline: "Two islands, one bridge, and a geyser with a schedule. Learn the schedule.",
    theme: "span",
    musicTrack: "music_span_forge",
    ambienceTrack: "amb_span_magma",
    make: moltenSpan,
  },
  stormshard: {
    id: "stormshard",
    name: "Stormshard",
    tagline: "A splinter of the citadel, adrift in the storm that took it. The lightning remembers.",
    theme: "shard",
    musicTrack: "music_shard_storm",
    ambienceTrack: "amb_shard_rain",
    make: stormshard,
  },
  ashwood: {
    id: "ashwood",
    name: "The Ashwood",
    tagline: "The forest that burned and kept growing. The roots move when you aren't looking.",
    theme: "ashwood",
    musicTrack: "music_ashwood_night",
    ambienceTrack: "amb_ashwood_wisps",
    make: ashwood,
  },
};

/** Legacy shape kept for the server/room code: id -> stage factory. */
export const STAGES: Record<string, () => Stage> = Object.fromEntries(
  Object.values(STAGE_INFO).map((s) => [s.id, s.make]),
);

export const STAGE_IDS = Object.keys(STAGES);

/** Resolve a possibly-unknown stage id to a valid one (default: keep). */
export function stageById(id: string | null | undefined): { id: string; make: () => Stage } {
  const key = id && id in STAGES ? id : "emberfall_keep";
  return { id: key, make: STAGES[key] };
}
