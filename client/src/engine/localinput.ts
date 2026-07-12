/**
 * Local player-1 input assembly: merge keyboard + mouse + gamepad into one
 * InputFrame, resolve aim (right-stick if tilted, else mouse→world), and the
 * on-screen reticle. Shared by hotseat, online, and the quick-match screen —
 * one implementation so the aim scheme never drifts between modes.
 */
import { Keyboard, Mouse, Gamepads } from "./input.js";
import type { InputFrame } from "@emberfall/shared";

export interface P1Sources { keyboard: Keyboard; mouse: Mouse; gamepads: Gamepads; }

/** Minimal camera view — avoids coupling this helper to the full GameRenderer. */
export interface AimCamera { camera: { screenToWorld(sx: number, sy: number): { x: number; y: number } }; }

export function makeP1Sources(canvas: HTMLCanvasElement): P1Sources {
  return { keyboard: new Keyboard(), mouse: new Mouse(canvas), gamepads: new Gamepads() };
}

export function buildP1Input(src: P1Sources, view: AimCamera, me: { x: number; y: number; h: number }): InputFrame {
  const [k1] = src.keyboard.sample();
  const pad1 = src.gamepads.sample(0);
  let aimX = 0, aimY = 0;
  if (pad1.aimX !== 0 || pad1.aimY !== 0) {
    aimX = pad1.aimX; aimY = pad1.aimY;
  } else {
    const mw = view.camera.screenToWorld(src.mouse.screenX, src.mouse.screenY);
    aimX = mw.x - me.x;
    aimY = mw.y - (me.y - me.h / 2);
  }
  return { buttons: k1 | src.mouse.buttonsMask() | pad1.buttons, aimX, aimY };
}

export function p1Reticle(src: P1Sources, view: AimCamera, visible: boolean): { x: number; y: number } | null {
  if (!visible) return null;
  const pad = src.gamepads.sample(0);
  if (pad.aimX !== 0 || pad.aimY !== 0) return null;
  return view.camera.screenToWorld(src.mouse.screenX, src.mouse.screenY);
}
