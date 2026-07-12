/**
 * Stage scene infrastructure: parallax layers, pooled particle fields, and
 * the base class every themed arena scene extends. Scenes are fully
 * procedural (gradients, shapes, glows — no images) and camera-aware:
 * layers with depth < 1 slide against the camera for depth.
 *
 * The SAME scenes back the match view, the main-menu vista, and the map
 * select thumbnails — one implementation, three uses.
 */
import { Container, FillGradient, Graphics } from "pixi.js";
import type { Stage } from "@emberfall/shared";
import { glowGradient, shade } from "../paint/parts.js";

/** Scenes are authored in world coordinates around this reference center. */
export const SCENE_CX = 960;
export const SCENE_CY = 480;

export interface SceneMounts {
  /** Behind the platforms/fighters. */
  under: Container;
  /** In front of everything (weather, foreground haze). */
  over: Container;
}

// ---------------------------------------------------------------------------
// parallax
// ---------------------------------------------------------------------------

export interface ParallaxLayer {
  node: Container;
  depth: number; // 1 = moves with the world, 0 = pinned to camera
}

export function applyParallax(layers: ParallaxLayer[], camX: number, camY: number): void {
  for (const l of layers) {
    l.node.position.set(camX * (1 - l.depth), camY * (1 - l.depth));
  }
}

/** A big vertical-gradient backdrop rect centered on the stage. */
export function skyRect(cx: number, cy: number, w: number, h: number, stops: [number, string][]): Graphics {
  const g = new Graphics();
  const grad = new FillGradient({
    type: "linear",
    start: { x: 0, y: cy - h / 2 },
    end: { x: 0, y: cy + h / 2 },
    textureSpace: "global",
  });
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  g.rect(cx - w / 2, cy - h / 2, w, h).fill(grad);
  return g;
}

// ---------------------------------------------------------------------------
// particle fields (pooled, wrapping — steady-state weather)
// ---------------------------------------------------------------------------

export interface FieldCfg {
  count: number;
  /** Wrap box centered on the camera. */
  w: number;
  h: number;
  vx: [number, number];
  vy: [number, number];
  size: [number, number];
  colors: number[];
  alpha: [number, number];
  /** Sinusoidal horizontal sway amplitude (px). */
  sway?: number;
  /** Per-particle alpha flicker speed (Hz-ish). 0 = steady. */
  flicker?: number;
  /** Rain-style streaks along the velocity vector. */
  streak?: boolean;
  /** Glow discs instead of squares (wisps, fireflies). */
  glow?: boolean;
}

interface FieldParticle {
  g: Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  seed: number;
  baseAlpha: number;
}

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

export class ParticleField {
  readonly node = new Container();
  private parts: FieldParticle[] = [];
  private t = Math.random() * 100;

  constructor(private cfg: FieldCfg) {
    for (let i = 0; i < cfg.count; i++) {
      const g = new Graphics();
      const size = rnd(cfg.size[0], cfg.size[1]);
      const color = cfg.colors[Math.floor(Math.random() * cfg.colors.length)];
      if (cfg.streak) {
        const vx = (cfg.vx[0] + cfg.vx[1]) / 2;
        const vy = (cfg.vy[0] + cfg.vy[1]) / 2;
        const m = Math.hypot(vx, vy) || 1;
        g.moveTo(0, 0).lineTo((-vx / m) * size * 6, (-vy / m) * size * 6).stroke({ color, width: size * 0.5, alpha: 1 });
      } else if (cfg.glow) {
        g.circle(0, 0, size * 2.4).fill(glowGradient(color, shade(color, 0.6), size * 2.4, 0.85, 0));
      } else {
        g.rect(-size / 2, -size / 2, size, size).fill(color);
        g.rotation = Math.random() * Math.PI;
      }
      const p: FieldParticle = {
        g,
        x: rnd(-cfg.w / 2, cfg.w / 2),
        y: rnd(-cfg.h / 2, cfg.h / 2),
        vx: rnd(cfg.vx[0], cfg.vx[1]),
        vy: rnd(cfg.vy[0], cfg.vy[1]),
        seed: Math.random() * Math.PI * 2,
        baseAlpha: rnd(cfg.alpha[0], cfg.alpha[1]),
      };
      g.alpha = p.baseAlpha;
      this.node.addChild(g);
      this.parts.push(p);
    }
  }

  update(dt: number, camX: number, camY: number): void {
    this.t += dt;
    const { w, h, sway = 0, flicker = 0 } = this.cfg;
    for (const p of this.parts) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // wrap inside the camera-centered box
      let lx = p.x - camX;
      let ly = p.y - camY;
      if (lx < -w / 2) { p.x += w; lx += w; }
      if (lx > w / 2) { p.x -= w; lx -= w; }
      if (ly < -h / 2) { p.y += h; ly += h; }
      if (ly > h / 2) { p.y -= h; ly -= h; }
      p.g.position.set(p.x + (sway ? Math.sin(this.t * 0.9 + p.seed) * sway : 0), p.y);
      if (flicker > 0) {
        p.g.alpha = p.baseAlpha * (0.6 + 0.4 * Math.sin(this.t * flicker + p.seed * 3));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// base scene
// ---------------------------------------------------------------------------

export abstract class StageScene {
  protected layers: ParallaxLayer[] = [];
  protected fields: { field: ParticleField; depth: number }[] = [];
  protected t = 0;

  constructor(protected stage: Stage, protected mounts: SceneMounts) {}

  protected addLayer(depth: number, into: Container = this.mounts.under): Container {
    const node = new Container();
    // content is authored in world coordinates; the pivot re-centers the
    // layer so it sits exactly at its authored position when the camera is
    // at the scene reference center, and parallaxes as the camera deviates
    node.pivot.set(SCENE_CX * (1 - depth), SCENE_CY * (1 - depth));
    into.addChild(node);
    this.layers.push({ node, depth });
    return node;
  }

  protected addField(cfg: FieldCfg, depth: number, into: Container = this.mounts.under): ParticleField {
    const field = new ParticleField(cfg);
    const node = this.addLayer(depth, into);
    node.addChild(field.node);
    this.fields.push({ field, depth });
    return field;
  }

  /** Per-frame: advance ambience and re-seat parallax against the camera. */
  update(dt: number, tick: number, camX: number, camY: number): void {
    this.t += dt;
    applyParallax(this.layers, camX, camY);
    for (const f of this.fields) {
      // particle wrap boxes live in layer-local coordinates: convert the
      // camera into that layer's space so the box follows the view
      f.field.update(dt, camX * f.depth, camY * f.depth);
    }
    this.tickScene(dt, tick, camX, camY);
  }

  /** Scene-specific animation (torch flicker, aurora, lightning...). */
  protected abstract tickScene(dt: number, tick: number, camX: number, camY: number): void;

  destroy(): void {
    for (const l of this.layers) l.node.destroy({ children: true });
    this.layers = [];
    this.fields = [];
  }
}
