/**
 * Input sources. main.ts merges these into InputFrames per player:
 *   - Keyboard: button masks for P1/P2 (hotseat)
 *   - Mouse: P1 aim + click attacks (online-primary scheme)
 *   - Gamepad: full scheme per pad - left stick move, right stick aim
 */
import { Btn } from "@emberfall/shared";

type KeyMap = Record<string, Btn>;

/** P1: WASD + Shift dash + F special (hold to charge) + Q ultimate. Mouse = aim, LMB light, RMB heavy. J/K keyboard fallback. */
const P1: KeyMap = {
  KeyA: Btn.Left,
  KeyD: Btn.Right,
  KeyW: Btn.Jump,
  KeyS: Btn.Down,
  KeyJ: Btn.Light,
  KeyK: Btn.Heavy,
  KeyF: Btn.Shoot,
  KeyQ: Btn.Ultimate,
  ShiftLeft: Btn.Dash,
};

/** P2 (hotseat fallback): arrows aim 8-way while held. Quote = ultimate. */
const P2: KeyMap = {
  ArrowLeft: Btn.Left,
  ArrowRight: Btn.Right,
  ArrowUp: Btn.Jump,
  ArrowDown: Btn.Down,
  Comma: Btn.Light,
  Period: Btn.Heavy,
  Slash: Btn.Dash,
  ShiftRight: Btn.Shoot,
  Quote: Btn.Ultimate,
};

export class Keyboard {
  private down = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      if (P1[e.code] !== undefined || P2[e.code] !== undefined) e.preventDefault();
      this.down.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.down.delete(e.code));
    window.addEventListener("blur", () => this.down.clear());
  }

  private mask(map: KeyMap): number {
    let m = 0;
    for (const [code, btn] of Object.entries(map)) if (this.down.has(code)) m |= btn;
    return m;
  }

  sample(): [number, number] {
    return [this.mask(P1), this.mask(P2)];
  }

  /** P2 hotseat aim: 8-way from held arrows (0,0 if none). */
  p2AimRaw(): [number, number] {
    let x = 0, y = 0;
    if (this.down.has("ArrowLeft")) x -= 1;
    if (this.down.has("ArrowRight")) x += 1;
    if (this.down.has("ArrowUp")) y -= 1;
    if (this.down.has("ArrowDown")) y += 1;
    return [x, y];
  }
}

export class Mouse {
  screenX = 0;
  screenY = 0;
  leftHeld = false;
  rightHeld = false;

  constructor(target: HTMLElement) {
    target.addEventListener("mousemove", (e) => {
      this.screenX = e.clientX;
      this.screenY = e.clientY;
    });
    target.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.leftHeld = true;
      if (e.button === 2) this.rightHeld = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.leftHeld = false;
      if (e.button === 2) this.rightHeld = false;
    });
    target.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("blur", () => {
      this.leftHeld = false;
      this.rightHeld = false;
    });
  }

  buttonsMask(): number {
    return (this.leftHeld ? Btn.Light : 0) | (this.rightHeld ? Btn.Heavy : 0);
  }
}

export interface PadSample {
  connected: boolean;
  buttons: number;
  aimX: number; // right stick, 0 if inside deadzone
  aimY: number;
}

const STICK_DEADZONE = 0.3;
const AIM_DEADZONE = 0.25;

/** Standard-mapping gamepads: A jump, X light, B heavy, Y shoot, LB/RB dash, RT ultimate. */
export class Gamepads {
  sample(padIndex: number): PadSample {
    const pad = navigator.getGamepads?.()[padIndex];
    if (!pad || !pad.connected) return { connected: false, buttons: 0, aimX: 0, aimY: 0 };

    let m = 0;
    const b = pad.buttons;
    if (b[0]?.pressed) m |= Btn.Jump;   // A / Cross
    if (b[2]?.pressed) m |= Btn.Light;  // X / Square
    if (b[1]?.pressed) m |= Btn.Heavy;  // B / Circle
    if (b[3]?.pressed) m |= Btn.Shoot;  // Y / Triangle
    if (b[4]?.pressed || b[5]?.pressed) m |= Btn.Dash; // LB / RB
    if (b[7]?.pressed) m |= Btn.Ultimate; // RT

    const lx = pad.axes[0] ?? 0;
    const ly = pad.axes[1] ?? 0;
    if (lx < -STICK_DEADZONE) m |= Btn.Left;
    if (lx > STICK_DEADZONE) m |= Btn.Right;
    if (ly > 0.5) m |= Btn.Down; // stick down = fast-fall / drop-through

    let aimX = pad.axes[2] ?? 0;
    let aimY = pad.axes[3] ?? 0;
    if (Math.hypot(aimX, aimY) < AIM_DEADZONE) { aimX = 0; aimY = 0; }

    return { connected: true, buttons: m, aimX, aimY };
  }
}
