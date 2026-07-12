/**
 * Shared UI scaffolding for flow screens: the per-screen base class
 * (fresh root per mount, auto-removed window listeners, per-frame layout)
 * and the Emberfall UI style kit — palette, text styles, buttons, panels.
 * Every screen builds from these so the whole flow reads as one world.
 */
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import type { AudioBus } from "../engine/audio.js";
import type { ScreenFlow, ScreenId, ScreenView } from "./flow.js";

export interface UiContext {
  app: Application;
  flow: ScreenFlow;
  audio: AudioBus;
}

// ---------- palette ----------
export const UI = {
  gold: 0xffd75a,
  goldHot: 0xffe89a,
  ember: 0xff8a3a,
  parchment: 0xc8bce0,
  dim: 0x9a8ec0,
  faint: 0x6a5a9a,
  ink: 0x0d0a14,
  night: 0x08060e,
  blood: 0xd6431f,
} as const;

// ---------- type ----------
export const serif = (size: number, fill: number, weight: "normal" | "bold" | "900" = "900"): TextStyle =>
  new TextStyle({
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: size, fontWeight: weight, fill, letterSpacing: size * 0.06,
  });

export const serifStroked = (size: number, fill: number, strokeW = Math.max(4, size / 10)): TextStyle =>
  new TextStyle({
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: size, fontWeight: "900", fill, letterSpacing: size * 0.06,
    stroke: { color: 0x000000, width: strokeW },
  });

export const mono = (size: number, fill: number, weight: "normal" | "bold" | "900" = "bold"): TextStyle =>
  new TextStyle({ fontFamily: "monospace", fontSize: size, fontWeight: weight, fill });

// ---------- base screen ----------
export abstract class BaseScreen implements ScreenView {
  protected root!: Container;
  private cleanups: (() => void)[] = [];
  private lastW = 0;
  private lastH = 0;

  constructor(protected ctx: UiContext, readonly id: ScreenId) {}

  /** True while this screen should react to input (not mid-fade to another). */
  protected get active(): boolean {
    return this.ctx.flow.screen === this.id;
  }

  mount(): void {
    this.root = new Container();
    this.ctx.app.stage.addChild(this.root);
    this.lastW = 0; // force a layout on the first update
    this.build();
  }

  unmount(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.ctx.app.stage.removeChild(this.root);
    this.root.destroy({ children: true });
  }

  update(dt: number): void {
    const { width, height } = this.ctx.app.screen;
    if (width !== this.lastW || height !== this.lastH) {
      this.lastW = width;
      this.lastH = height;
      this.layout(width, height);
    }
    this.tick(dt, width, height);
  }

  /** Window listener that dies with the screen. */
  protected on<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void {
    window.addEventListener(type, fn);
    this.cleanups.push(() => window.removeEventListener(type, fn));
  }

  protected abstract build(): void;
  protected abstract layout(w: number, h: number): void;
  protected abstract tick(dt: number, w: number, h: number): void;
}

// ---------- widgets ----------

/** A menu row: serif label, ember underline that sweeps in on hover. */
export class UiButton {
  readonly root = new Container();
  readonly label: Text;
  private underline: Graphics;
  private hoverT = 0;
  hovered = false;

  constructor(text: string, size: number, private onPick: () => void, onHover?: () => void) {
    this.label = new Text({ text, style: serif(size, UI.parchment) });
    this.label.anchor.set(0.5, 0.5);
    this.underline = new Graphics();
    this.underline.position.set(0, size * 0.72);
    this.root.addChild(this.underline, this.label);
    this.root.eventMode = "static";
    this.root.cursor = "pointer";
    this.root.on("pointerover", () => {
      if (!this.hovered) onHover?.();
      this.hovered = true;
    });
    this.root.on("pointerout", () => (this.hovered = false));
    this.root.on("pointertap", () => this.onPick());
  }

  /** Keyboard focus rides the same visual as mouse hover. */
  set focused(v: boolean) {
    this.hovered = v;
  }

  pick(): void {
    this.onPick();
  }

  update(dt: number): void {
    const target = this.hovered ? 1 : 0;
    this.hoverT += (target - this.hoverT) * Math.min(1, dt * 14);
    const t = this.hoverT;
    this.label.style.fill = lerpColor(UI.parchment, UI.gold, t);
    this.label.scale.set(1 + t * 0.06);
    this.underline.clear();
    if (t > 0.02) {
      const w = this.label.width * (0.55 + 0.45 * t) * t;
      this.underline
        .moveTo(-w / 2, 0).lineTo(w / 2, 0)
        .stroke({ color: UI.ember, width: 3, alpha: 0.85 * t });
      this.underline.circle(w / 2, 0, 3.4).fill({ color: UI.gold, alpha: t });
      this.underline.circle(-w / 2, 0, 3.4).fill({ color: UI.gold, alpha: t });
    }
  }
}

/** Dark parchment panel with an ember-gilt border. */
export function panel(w: number, h: number, alpha = 0.88): Graphics {
  const g = new Graphics();
  g.roundRect(0, 0, w, h, 16).fill({ color: UI.ink, alpha });
  g.roundRect(0, 0, w, h, 16).stroke({ color: UI.ember, width: 2, alpha: 0.5 });
  g.roundRect(3, 3, w - 6, h - 6, 13).stroke({ color: UI.gold, width: 1, alpha: 0.22 });
  return g;
}

export function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

// ---------- ember particle sprinkle (title dressings, button auras) ----------
export interface EmberSpec {
  /** Spawn box (local coords). */
  x0: number; x1: number; y0: number; y1: number;
  rate: number; // per second
  vy: [number, number];
  vx: [number, number];
  life: [number, number];
  size: [number, number];
  colors: number[];
  cap: number;
}

interface Ember { g: Graphics; vx: number; vy: number; life: number; maxLife: number }

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

export class EmberEmitter {
  readonly node = new Container();
  private embers: Ember[] = [];
  private acc = 0;

  constructor(public spec: EmberSpec) {}

  update(dt: number): void {
    const s = this.spec;
    this.acc += dt * s.rate;
    while (this.acc >= 1 && this.embers.length < s.cap) {
      this.acc -= 1;
      const g = new Graphics();
      const size = rnd(s.size[0], s.size[1]);
      const color = s.colors[Math.floor(Math.random() * s.colors.length)];
      g.circle(0, 0, size).fill(color);
      g.position.set(rnd(s.x0, s.x1), rnd(s.y0, s.y1));
      this.node.addChild(g);
      const life = rnd(s.life[0], s.life[1]);
      this.embers.push({ g, vx: rnd(s.vx[0], s.vx[1]), vy: rnd(s.vy[0], s.vy[1]), life, maxLife: life });
    }
    if (this.acc > 1) this.acc = 1; // cap reached: don't bank a burst
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.life -= dt;
      if (e.life <= 0) {
        e.g.destroy();
        this.embers.splice(i, 1);
        continue;
      }
      e.g.x += e.vx * dt;
      e.g.y += e.vy * dt;
      const t = e.life / e.maxLife;
      e.g.alpha = t < 0.7 ? t / 0.7 : (1 - t) / 0.3;
    }
  }
}
