/**
 * Input = button bitmask + aim direction, sampled once per tick.
 * This exact structure goes over the wire in Phase 4. The aim angle
 * will be quantized to 1 byte (256 directions) for bandwidth; floats
 * are fine locally.
 */
export const enum Btn {
  Left = 1 << 0,
  Right = 1 << 1,
  Up = 1 << 2,
  Down = 1 << 3,
  Jump = 1 << 4,
  Light = 1 << 5,
  Heavy = 1 << 6,
  Special = 1 << 7,
  Ultimate = 1 << 8,
  Dash = 1 << 9,
  Shoot = 1 << 10,
}

/** One player's input for one sim tick. aimX/aimY is a unit vector (0,0 = no aim -> sim falls back to facing). */
export interface InputFrame {
  buttons: number; // Btn bitmask
  aimX: number;
  aimY: number;
}

export const NEUTRAL_INPUT: InputFrame = { buttons: 0, aimX: 0, aimY: 0 };

/** Wire message payload (Phase 4): tick-tagged input. */
export interface TickInput extends InputFrame {
  tick: number;
}

export const has = (mask: number, b: Btn): boolean => (mask & b) !== 0;
