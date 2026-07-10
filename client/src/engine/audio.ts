/**
 * Silent SFX hook points (Phase B). The renderer routes every juice-worthy
 * sim event through this bus; shipping audio later means implementing
 * AudioBus with WebAudio/howler and swapping one constant in main.ts —
 * no renderer changes.
 */
export type SfxId =
  | "hit_light"
  | "hit_heavy"
  | "ko"
  | "respawn"
  | "jump"
  | "double_jump"
  | "dash"
  | "land"
  | "shoot"
  | "proj_die"
  | "item_spawn"
  | "item_pickup"
  | "match_win";

export interface SfxOpts {
  /** World x, for stereo panning later. */
  x?: number;
  /** 0..1, e.g. scaled by damage dealt. */
  intensity?: number;
}

export interface AudioBus {
  play(id: SfxId, opts?: SfxOpts): void;
}

/** The $0-budget sound engine. */
export const silentAudio: AudioBus = { play: () => {} };
