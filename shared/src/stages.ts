/**
 * Stage registry. Maps are pure data: flat platforms + blast zone + spawn
 * and item points. Box backgrounds only — no geometry, no art pipeline.
 */
import { emberfallKeep, type Stage } from "./sim.js";

/**
 * Map 2: two islands over a lethal center gap. Rewards edge-guarding and
 * horizontal KOs; the soft bridge above the gap is the only safe crossing.
 */
export function moltenSpan(): Stage {
  return {
    platforms: [
      { x: 210, y: 800, w: 640, soft: false }, // left island
      { x: 1070, y: 800, w: 640, soft: false }, // right island (gap: 850..1070)
      { x: 780, y: 590, w: 360, soft: true }, // the bridge
      { x: 420, y: 570, w: 220, soft: true }, // side floats
      { x: 1280, y: 570, w: 220, soft: true },
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
  };
}

export const STAGES: Record<string, () => Stage> = {
  emberfall_keep: emberfallKeep,
  molten_span: moltenSpan,
};

export const STAGE_IDS = Object.keys(STAGES);

/** Resolve a possibly-unknown stage id to a valid one (default: keep). */
export function stageById(id: string | null | undefined): { id: string; make: () => Stage } {
  const key = id && id in STAGES ? id : "emberfall_keep";
  return { id: key, make: STAGES[key] };
}
