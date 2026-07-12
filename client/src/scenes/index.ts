/**
 * Scene registry: stage theme -> scene painter + platform palette.
 * Adding a map = one Stage in shared/stages.ts + one entry here.
 */
import type { Stage, StageTheme } from "@emberfall/shared";
import { StageScene, type SceneMounts } from "./scene.js";
import { KeepScene } from "./keep.js";
import { SpanScene } from "./span.js";
import { ShardScene } from "./shard.js";
import { AshwoodScene } from "./ashwood.js";

export interface PlatformPalette {
  solidBody: number;
  solidTop: number;
  softBody: number;
  softTop: number;
}

export const PLATFORM_PALETTES: Record<StageTheme, PlatformPalette> = {
  keep: { solidBody: 0x2a2140, solidTop: 0x8a765a, softBody: 0x5a4a7a, softTop: 0x9a8668 },
  span: { solidBody: 0x241418, solidTop: 0xd66a2a, softBody: 0x3a2a26, softTop: 0xb8583a },
  shard: { solidBody: 0x182238, solidTop: 0x8ab8d8, softBody: 0x24304a, softTop: 0x6a90c8 },
  ashwood: { solidBody: 0x141f11, solidTop: 0x6aa87a, softBody: 0x223019, softTop: 0x87c890 },
};

const SCENES: Record<StageTheme, new (stage: Stage, mounts: SceneMounts) => StageScene> = {
  keep: KeepScene,
  span: SpanScene,
  shard: ShardScene,
  ashwood: AshwoodScene,
};

export function makeScene(theme: StageTheme, stage: Stage, mounts: SceneMounts): StageScene {
  return new SCENES[theme](stage, mounts);
}

export { StageScene, type SceneMounts } from "./scene.js";
