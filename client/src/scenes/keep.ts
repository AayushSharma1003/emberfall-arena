/**
 * Emberfall Keep — the cathedral-fortress at dusk. Plum-to-ember sky, a
 * ridge of dead hills, the keep's silhouette with burning stained glass,
 * slanting light shafts, torches on the near wall, and embers rising the
 * whole while. This scene is also the main menu's living backdrop.
 */
import { Container, Graphics } from "pixi.js";
import type { Stage } from "@emberfall/shared";
import { glowGradient, shade } from "../paint/parts.js";
import { skyRect, StageScene, type SceneMounts } from "./scene.js";

const CX = 960;

export class KeepScene extends StageScene {
  private windows: Graphics[] = [];
  private shafts: Graphics[] = [];
  private torches: { flame: Graphics; glow: Graphics; seed: number }[] = [];

  constructor(stage: Stage, mounts: SceneMounts) {
    super(stage, mounts);

    // sky
    const sky = this.addLayer(0.03);
    sky.addChild(skyRect(CX, 300, 5200, 3400, [
      [0, "#160f22"],
      [0.45, "#2c1830"],
      [0.72, "#5a2a33"],
      [0.9, "#8a4530"],
      [1, "#a85a2e"],
    ]));
    // the dying sun, huge and low
    const sun = new Graphics();
    sun.circle(CX + 380, 980, 260).fill(glowGradient(0xffb35a, 0xa84a20, 260, 0.55, 0));
    sky.addChild(sun);

    // far ridge of dead hills
    const far = this.addLayer(0.12);
    const ridge = new Graphics();
    ridge.moveTo(-1600, 1050);
    const bumps = [980, 900, 1010, 870, 990, 920, 1040, 880, 1000];
    bumps.forEach((y, i) => ridge.lineTo(-1600 + (i + 1) * 640, y));
    ridge.lineTo(4400, 1120).lineTo(4400, 2400).lineTo(-1600, 2400).closePath().fill(0x231228);
    far.addChild(ridge);

    // the keep itself — scaled back and hazed so it stays scenery
    const mid = this.addLayer(0.32);
    const keep = this.buildKeep();
    keep.scale.set(0.8);
    keep.position.set(190, 150);
    keep.alpha = 0.88;
    mid.addChild(keep);

    // slanting dusk light shafts (breathing)
    const shaftLayer = this.addLayer(0.45);
    for (const [x, w] of [[350, 130], [820, 90], [1420, 150]] as const) {
      const s = new Graphics();
      s.poly([x, -500, x + w, -500, x + w + 420, 1100, x + 420, 1100]).fill({ color: 0xffb35a, alpha: 0.05 });
      shaftLayer.addChild(s);
      this.shafts.push(s);
    }

    // near broken colonnade with torches
    const near = this.addLayer(0.62);
    near.addChild(this.buildColonnade());

    // rising embers (two depths for parallax sparkle)
    this.addField({
      count: 70, w: 3400, h: 2200, vx: [-12, 14], vy: [-26, -60],
      size: [2, 5], colors: [0xffb35a, 0xff7a3a, 0xffd75a], alpha: [0.35, 0.85],
      sway: 26, flicker: 2.2,
    }, 0.55);
    this.addField({
      count: 60, w: 2800, h: 1800, vx: [-16, 18], vy: [-40, -95],
      size: [3, 7], colors: [0xffb35a, 0xff8a3a], alpha: [0.5, 1],
      sway: 34, flicker: 3.1,
    }, 0.92, mounts.over);

    // faint drifting ash
    this.addField({
      count: 40, w: 3200, h: 2000, vx: [-24, -8], vy: [10, 26],
      size: [2, 4], colors: [0x8a7a8a, 0x6a5a6e], alpha: [0.15, 0.4], sway: 18,
    }, 0.4);
  }

  private buildKeep(): Container {
    const c = new Container();
    const g = new Graphics();
    // dusk silhouette values: the keep must stay DARKER than the sky so it
    // recedes — atmospheric perspective, not architectural detail
    const body = 0x1f1128;
    const towerXs = [180, 640, 1180, 1680];
    // curtain wall
    g.rect(-200, 760, 2600, 900).fill(body);
    for (const [i, x] of towerXs.entries()) {
      const wTower = i % 2 === 0 ? 220 : 170;
      const hTower = i === 1 ? 780 : 560 + (i % 3) * 90;
      g.rect(x, 860 - hTower, wTower, hTower + 700).fill(shade(body, 0.94 + (i % 2) * 0.08));
      // pointed roof
      g.poly([x - 18, 860 - hTower, x + wTower + 18, 860 - hTower, x + wTower / 2, 860 - hTower - wTower * 0.9])
        .fill(shade(body, 0.72));
      // crenellations on the wall between towers
      for (let cx2 = x + wTower + 10; cx2 < x + 400; cx2 += 46) {
        g.rect(cx2, 736, 26, 26).fill(body);
      }
    }
    c.addChild(g);

    // stained glass: one rose window + lancets, glowing from inside
    const rose = new Graphics();
    rose.circle(750, 300, 46).fill(glowGradient(0xffcf7a, 0xd6431f, 46, 0.95, 0.35));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      rose.moveTo(750, 300).lineTo(750 + Math.cos(a) * 46, 300 + Math.sin(a) * 46)
        .stroke({ color: 0x1a0d20, width: 4 });
    }
    rose.circle(750, 300, 46).stroke({ color: 0x150a1a, width: 6 });
    c.addChild(rose);
    this.windows.push(rose);

    const lancetColors = [0xff9d5a, 0xd65a7a, 0x8a5ae8, 0xff9d5a, 0x5a9dd6];
    [260, 330, 1230, 1300, 1740].forEach((x, i) => {
      const w = new Graphics();
      const color = lancetColors[i % lancetColors.length];
      w.roundRect(x, 520, 34, 96, 17).fill(glowGradient(shade(color, 1.3), color, 60, 0.9, 0.4));
      w.roundRect(x, 520, 34, 96, 17).stroke({ color: 0x1c0f22, width: 5 });
      w.rect(x + 14, 520, 5, 96).fill({ color: 0x1c0f22, alpha: 0.8 });
      c.addChild(w);
      this.windows.push(w);
    });
    return c;
  }

  private buildColonnade(): Container {
    const c = new Container();
    const g = new Graphics();
    const col = 0x1c1122;
    // broken columns flanking the arena, below the action line
    for (const [x, h] of [[-260, 420], [130, 260], [1760, 380], [2140, 300]] as const) {
      g.rect(x, 1160 - h, 90, h + 500).fill(col);
      g.rect(x - 14, 1160 - h, 118, 34).fill(shade(col, 1.3));
      // broken top edge
      g.poly([x, 1160 - h, x + 30, 1160 - h - 26, x + 55, 1160 - h - 8, x + 90, 1160 - h]).fill(col);
    }
    c.addChild(g);

    // torches on the two inner columns
    for (const x of [175, 1805]) {
      const glow = new Graphics();
      glow.circle(x, 1010, 90).fill(glowGradient(0xffb35a, 0xd6431f, 90, 0.35, 0));
      const flame = new Graphics();
      flame.moveTo(x, 1030).quadraticCurveTo(x - 12, 995, x, 962)
        .quadraticCurveTo(x + 12, 995, x, 1030).fill(0xffcf7a);
      flame.moveTo(x, 1026).quadraticCurveTo(x - 7, 1000, x, 978)
        .quadraticCurveTo(x + 7, 1000, x, 1026).fill(0xfff3c0);
      const sconce = new Graphics();
      sconce.rect(x - 10, 1028, 20, 12).fill(0x3a2a1a);
      c.addChild(glow, flame, sconce);
      this.torches.push({ flame, glow, seed: x });
    }
    return c;
  }

  protected tickScene(dt: number, _tick: number, _camX: number, _camY: number): void {
    // window glow breathes; shafts drift in alpha; torches gutter
    for (const [i, w] of this.windows.entries()) {
      w.alpha = 0.82 + 0.18 * Math.sin(this.t * 1.4 + i * 1.9);
    }
    for (const [i, s] of this.shafts.entries()) {
      s.alpha = 0.55 + 0.45 * Math.sin(this.t * 0.5 + i * 2.4);
    }
    for (const tor of this.torches) {
      const f = Math.sin(this.t * 11 + tor.seed) * 0.5 + Math.sin(this.t * 23 + tor.seed * 2) * 0.5;
      tor.flame.scale.set(1 + f * 0.08, 1 + f * 0.14);
      tor.flame.pivot.set(0, 0);
      tor.glow.alpha = 0.75 + f * 0.25;
    }
  }
}
