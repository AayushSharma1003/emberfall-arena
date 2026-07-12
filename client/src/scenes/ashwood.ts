/**
 * The Ashwood — the forest that burned and kept growing. Charred trunks in
 * three depths, a pale green moon, will-o-wisps drifting between the trees,
 * spores falling like slow snow, fireflies at the root line, and ground fog
 * that never quite settles.
 */
import { Graphics } from "pixi.js";
import type { Stage } from "@emberfall/shared";
import { glowGradient, shade } from "../paint/parts.js";
import { skyRect, StageScene, type SceneMounts } from "./scene.js";

const CX = 960;

export class AshwoodScene extends StageScene {
  private wisps: { g: Graphics; seed: number; baseX: number; baseY: number }[] = [];
  private fogBanks: { g: Graphics; seed: number }[] = [];
  private fungi: Graphics[] = [];

  constructor(stage: Stage, mounts: SceneMounts) {
    super(stage, mounts);

    const sky = this.addLayer(0.03);
    sky.addChild(skyRect(CX, 400, 5200, 3600, [
      [0, "#040807"],
      [0.5, "#0a1410"],
      [0.8, "#14231a"],
      [1, "#1c3020"],
    ]));
    const moon = new Graphics();
    moon.circle(CX + 430, -240, 150).fill(glowGradient(0xd8ffe8, 0x3a6a4a, 150, 0.7, 0));
    sky.addChild(moon);

    // three depths of charred trees
    this.treeRow(this.addLayer(0.16), 0x0c1410, 0.62, [ -1200, -640, -80, 520, 1180, 1760, 2380 ], 40);
    this.treeRow(this.addLayer(0.32), 0x0f1a13, 0.85, [ -900, -250, 700, 1500, 2200 ], 90);
    this.treeRow(this.addLayer(0.55), 0x121f16, 1.2, [ -520, 380, 1620, 2480 ], 160, true);

    // will-o-wisps between the trees
    const wispLayer = this.addLayer(0.45);
    for (const [x, y] of [[220, 420], [700, 240], [1240, 480], [1700, 300], [420, 640], [1500, 620]] as const) {
      const g = new Graphics();
      g.circle(0, 0, 26).fill(glowGradient(0xaef2c8, 0x2a6a4a, 26, 0.9, 0));
      g.circle(0, 0, 6).fill(0xe8fff0);
      g.position.set(x, y);
      wispLayer.addChild(g);
      this.wisps.push({ g, seed: x * 0.37, baseX: x, baseY: y });
    }

    // spore-fall + fireflies
    this.addField({
      count: 90, w: 3200, h: 2200, vx: [-14, 6], vy: [14, 40],
      size: [2, 4], colors: [0xbfe0c8, 0x8fbf9a, 0xe8ffe0], alpha: [0.2, 0.55],
      sway: 30, flicker: 1.2,
    }, 0.6);
    this.addField({
      count: 26, w: 2600, h: 900, vx: [-20, 20], vy: [-8, 8],
      size: [1.6, 2.6], colors: [0xffe89a, 0xd6ff7a], alpha: [0.3, 0.9],
      sway: 40, flicker: 5, glow: true,
    }, 0.88);

    // ground fog banks in front of the action
    const fogLayer = this.addLayer(1.06, mounts.over);
    for (const [x, w] of [[200, 900], [1100, 1100], [-400, 800]] as const) {
      const g = new Graphics();
      for (let b = 0; b < 4; b++) {
        g.ellipse(x + b * w * 0.22, 980 + (b % 2) * 22, w * 0.3, 60 - b * 8)
          .fill({ color: 0x9ab8a0, alpha: 0.05 });
      }
      fogLayer.addChild(g);
      this.fogBanks.push({ g, seed: x });
    }
  }

  private treeRow(
    layer: ReturnType<StageScene["addLayer"]>,
    color: number,
    scale: number,
    xs: readonly number[],
    yBase: number,
    fungi = false,
  ): void {
    const g = new Graphics();
    for (const [i, x] of xs.entries()) {
      const trunkW = (46 + (i % 3) * 22) * scale;
      const h = (720 + (i % 4) * 160) * scale;
      const top = 1050 - h + yBase;
      // trunk with a slight lean and a broken crown
      const lean = (i % 2 === 0 ? 1 : -1) * trunkW * 0.35;
      g.poly([
        x - trunkW / 2, 1450,
        x - trunkW * 0.32 + lean * 0.4, top + h * 0.35,
        x - trunkW * 0.2 + lean, top,
        x + trunkW * 0.24 + lean, top + h * 0.06,
        x + trunkW * 0.34 + lean * 0.4, top + h * 0.4,
        x + trunkW / 2, 1450,
      ]).fill(color);
      // one surviving bough
      g.moveTo(x + lean * 0.6, top + h * 0.18)
        .quadraticCurveTo(x + trunkW * 1.6 + lean, top + h * 0.08, x + trunkW * 2.4 + lean, top + h * 0.16)
        .stroke({ color, width: 14 * scale });
      // canopy remnant: sparse dark blobs
      for (let b = 0; b < 3; b++) {
        g.ellipse(x + lean + (b - 1) * trunkW * 1.1, top - 20 + (b % 2) * 30, trunkW * (1.3 - b * 0.2), 40 * scale)
          .fill({ color: shade(color, 1.25), alpha: 0.8 });
      }
    }
    layer.addChild(g);
    if (fungi) {
      for (const x of xs) {
        const f = new Graphics();
        for (let b = 0; b < 3; b++) {
          f.circle(x + 30 + b * 26, 1000 - b * 44, 7 - b).fill(0x7ae8b8);
        }
        f.alpha = 0.7;
        layer.addChild(f);
        this.fungi.push(f);
      }
    }
  }

  protected tickScene(dt: number, _tick: number, _camX: number, _camY: number): void {
    for (const w of this.wisps) {
      w.g.position.set(
        w.baseX + Math.sin(this.t * 0.4 + w.seed) * 60 + Math.sin(this.t * 1.3 + w.seed * 2) * 14,
        w.baseY + Math.sin(this.t * 0.7 + w.seed * 1.4) * 34,
      );
      w.g.alpha = 0.55 + 0.45 * Math.sin(this.t * 1.9 + w.seed);
    }
    for (const f of this.fogBanks) {
      f.g.x = Math.sin(this.t * 0.13 + f.seed) * 90;
      f.g.alpha = 0.75 + 0.25 * Math.sin(this.t * 0.4 + f.seed * 0.7);
    }
    for (const [i, f] of this.fungi.entries()) {
      f.alpha = 0.5 + 0.3 * Math.sin(this.t * 2.2 + i * 1.7);
    }
  }
}
