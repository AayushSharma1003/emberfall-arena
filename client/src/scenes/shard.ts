/**
 * Stormshard — a splinter of the citadel adrift in a night storm. Aurora
 * ribbons above, banked storm clouds drifting through, sister-shards
 * floating in the distance, two layers of rain, and a sky that whitens
 * when the stage lightning is about to land (synced to the sim tick, so
 * the flash IS the telegraph).
 */
import { Container, Graphics } from "pixi.js";
import { hazardStateAt, hazardTelegraphT, type Stage } from "@emberfall/shared";
import { glowGradient, shade } from "../paint/parts.js";
import { skyRect, StageScene, type SceneMounts } from "./scene.js";

const CX = 960;

export class ShardScene extends StageScene {
  private aurora: Graphics[] = [];
  private clouds: { node: Container; speed: number }[] = [];
  private flash: Graphics;
  private bolt: Graphics;
  private shards: { g: Graphics; seed: number; baseY: number }[] = [];

  constructor(stage: Stage, mounts: SceneMounts) {
    super(stage, mounts);

    const sky = this.addLayer(0.03);
    sky.addChild(skyRect(CX, 400, 5200, 3800, [
      [0, "#05070f"],
      [0.4, "#0b1226"],
      [0.75, "#18233d"],
      [1, "#232f4a"],
    ]));
    // a cold high moon behind the storm
    const moon = new Graphics();
    moon.circle(CX - 520, -320, 130).fill(glowGradient(0xd8e8ff, 0x4a6a9a, 130, 0.8, 0));
    sky.addChild(moon);

    // aurora ribbons
    const auroraLayer = this.addLayer(0.1);
    for (const [y0, color, amp] of [[-480, 0x3ae8c9, 90], [-360, 0x5a8ae8, 60]] as const) {
      const a = new Graphics();
      a.moveTo(-1600, y0);
      for (let i = 0; i <= 16; i++) {
        a.lineTo(-1600 + i * 360, y0 + Math.sin(i * 1.2) * amp);
      }
      for (let i = 16; i >= 0; i--) {
        a.lineTo(-1600 + i * 360, y0 + Math.sin(i * 1.2) * amp + 130);
      }
      a.closePath().fill({ color, alpha: 0.1 });
      auroraLayer.addChild(a);
      this.aurora.push(a);
    }

    // distant sister shards, floating and slowly bobbing
    const farLayer = this.addLayer(0.22);
    for (const [x, y, s] of [[-380, 520, 0.7], [2350, 380, 0.9], [1450, -140, 0.5]] as const) {
      const g = this.floatingRock(s);
      g.position.set(x, y);
      farLayer.addChild(g);
      this.shards.push({ g, seed: x, baseY: y });
    }

    // two banks of storm clouds that drift on their own
    for (const [depth, y, alpha, speed, n] of [[0.16, -260, 0.5, 12, 6], [0.38, -60, 0.65, 26, 5]] as const) {
      const layer = this.addLayer(depth);
      const node = new Container();
      for (let i = 0; i < n; i++) {
        const c = new Graphics();
        const w = 420 + (i % 3) * 220;
        const x = -1500 + i * 4200 / n + (i % 2) * 260;
        for (let b = 0; b < 5; b++) {
          c.ellipse(x + b * w * 0.18, y + Math.sin(b * 2.1 + i) * 40, w * (0.3 - b * 0.03), 90 - b * 8)
            .fill({ color: shade(0x1a2438, 1 + (b % 2) * 0.18), alpha });
        }
        node.addChild(c);
      }
      // duplicate for seamless wrap
      const dup = new Container();
      // (drift handled in tickScene by moving node.x and wrapping)
      layer.addChild(node, dup);
      this.clouds.push({ node, speed });
    }

    // rain: heavy near sheet + soft far sheet
    this.addField({
      count: 120, w: 3000, h: 2200, vx: [-320, -260], vy: [900, 1150],
      size: [1.6, 2.6], colors: [0x9ab8e8, 0x7a9ad0], alpha: [0.25, 0.5], streak: true,
    }, 0.95, mounts.over);
    this.addField({
      count: 70, w: 3600, h: 2600, vx: [-220, -170], vy: [650, 800],
      size: [1.2, 2], colors: [0x6a86b8], alpha: [0.15, 0.3], streak: true,
    }, 0.5);

    // storm flash + bolt live above everything
    this.flash = new Graphics();
    this.flash.rect(-2400, -2000, 7000, 5200).fill(0xdce8ff);
    this.flash.alpha = 0;
    const flashLayer = this.addLayer(0.02, mounts.over);
    flashLayer.addChild(this.flash);
    this.bolt = new Graphics();
    const boltLayer = this.addLayer(1, mounts.over);
    boltLayer.addChild(this.bolt);
  }

  private floatingRock(s: number): Graphics {
    const g = new Graphics();
    g.poly([-160 * s, 0, -60 * s, -70 * s, 90 * s, -60 * s, 170 * s, 10 * s, 60 * s, 40 * s, 0, 150 * s, -90 * s, 50 * s])
      .fill(0x141c30);
    g.rect(-110 * s, -18 * s, 230 * s, 12 * s).fill({ color: 0x27324e, alpha: 0.8 });
    return g;
  }

  protected tickScene(dt: number, tick: number, _camX: number, _camY: number): void {
    for (const [i, a] of this.aurora.entries()) {
      a.alpha = 0.55 + 0.45 * Math.sin(this.t * 0.35 + i * 2);
      a.skew.x = Math.sin(this.t * 0.2 + i) * 0.05;
    }
    for (const c of this.clouds) {
      c.node.x = ((c.node.x + c.speed * dt) % 4200);
    }
    for (const s of this.shards) {
      s.g.y = s.baseY + Math.sin(this.t * 0.5 + s.seed) * 22;
    }

    // lightning: the sky itself telegraphs the strike
    this.bolt.clear();
    let flashA = 0;
    for (const h of this.stage.hazards ?? []) {
      const st = hazardStateAt(h, tick);
      if (st === "telegraph") {
        const tt = hazardTelegraphT(h, tick);
        flashA = Math.max(flashA, tt > 0.7 ? (tt - 0.7) * 0.5 : tt * 0.06);
      } else if (st === "active") {
        flashA = Math.max(flashA, 0.32);
        // a jagged bolt from the sky into the plate
        const x = h.x + h.w / 2;
        let py = -900;
        let px = x + Math.sin(tick * 3.7) * 120;
        this.bolt.moveTo(px, py);
        while (py < h.y + h.h - 30) {
          py += 90 + ((tick * 7 + py) % 60);
          px = x + Math.sin(py * 0.05 + tick) * 46;
          this.bolt.lineTo(px, py);
        }
        this.bolt.lineTo(x, h.y + h.h - 10);
        this.bolt.stroke({ color: 0xeef4ff, width: 7, alpha: 0.95 });
        this.bolt.stroke({ color: 0x9ab8ff, width: 16, alpha: 0.3 });
      }
    }
    this.flash.alpha += (flashA - this.flash.alpha) * Math.min(1, dt * 18);
  }
}
