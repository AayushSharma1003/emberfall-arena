/**
 * The Molten Span — the forge levels. Cavern dark above, magma light below,
 * colossal machinery asleep in the background, chains swaying in the heat,
 * sparks rising out of the gap. The light source is the floor.
 */
import { Container, Graphics } from "pixi.js";
import type { Stage } from "@emberfall/shared";
import { glowGradient, shade } from "../paint/parts.js";
import { skyRect, StageScene, type SceneMounts } from "./scene.js";

const CX = 960;

export class SpanScene extends StageScene {
  private magma: Graphics;
  private heat: Graphics;
  private chains: { node: Container; seed: number }[] = [];
  private gearA: Graphics;
  private gearB: Graphics;

  constructor(stage: Stage, mounts: SceneMounts) {
    super(stage, mounts);

    // cavern gradient: black above, blood-warm below
    const bg = this.addLayer(0.03);
    bg.addChild(skyRect(CX, 500, 5200, 3600, [
      [0, "#07050a"],
      [0.5, "#170d12"],
      [0.78, "#3a1612"],
      [1, "#6e2a14"],
    ]));

    // far cavern wall with ore veins
    const far = this.addLayer(0.14);
    const wall = new Graphics();
    wall.moveTo(-1600, -400);
    for (let i = 0; i <= 12; i++) wall.lineTo(-1600 + i * 480, -430 + (i % 3) * 130 + (i % 2) * 60);
    wall.lineTo(4200, -400).lineTo(4200, 300).lineTo(-1600, 260).closePath().fill(0x140a10);
    for (const [x1, y1, x2, y2] of [[-800, 0, -300, 240], [500, -80, 900, 200], [1900, -40, 2400, 220]] as const) {
      wall.moveTo(x1, y1).quadraticCurveTo((x1 + x2) / 2 + 80, (y1 + y2) / 2, x2, y2)
        .stroke({ color: 0xff6a2a, width: 5, alpha: 0.25 });
    }
    far.addChild(wall);

    // colossal sleeping machinery: two great gears + chimney stacks
    const mid = this.addLayer(0.3);
    this.gearA = this.gear(320, 0x1f1216);
    this.gearA.position.set(-150, 260);
    this.gearB = this.gear(210, 0x241419);
    this.gearB.position.set(2130, 180);
    const stacks = new Graphics();
    for (const [x, w, h] of [[520, 130, 900], [1420, 110, 760]] as const) {
      stacks.rect(x, 320 - h, w, h + 800).fill(0x190e13);
      stacks.rect(x - 12, 320 - h, w + 24, 40).fill(0x241419);
      stacks.circle(x + w / 2, 330 - h, w * 0.32).fill(glowGradient(0xff8a3a, 0x3a1612, w * 0.32, 0.5, 0));
    }
    mid.addChild(this.gearA, this.gearB, stacks);

    // hanging chains that sway in the heat
    const chainLayer = this.addLayer(0.46);
    for (const x of [260, 980, 1660]) {
      const node = new Container();
      const g = new Graphics();
      for (let y = 0; y < 620; y += 34) {
        g.ellipse(0, y, 10, 20).stroke({ color: 0x2e1f22, width: 6 });
      }
      const hook = new Graphics();
      hook.moveTo(0, 620).quadraticCurveTo(26, 660, 4, 690).stroke({ color: 0x2e1f22, width: 8 });
      node.addChild(g, hook);
      node.position.set(x, -520);
      chainLayer.addChild(node);
      this.chains.push({ node, seed: x });
    }

    // the magma lake under the gap — THE light source
    const lake = this.addLayer(0.85);
    this.magma = new Graphics();
    this.magma.ellipse(960, 1330, 900, 200).fill(glowGradient(0xffd75a, 0xd6431f, 800, 0.95, 0.5));
    this.magma.ellipse(960, 1330, 1400, 320).fill({ color: 0xd6431f, alpha: 0.4 });
    lake.addChild(this.magma);
    this.heat = new Graphics();
    this.heat.rect(-600, 900, 3200, 700).fill(glowGradient(0xff8a3a, 0x000000, 900, 0.18, 0));
    lake.addChild(this.heat);

    // sparks out of the gap, embers everywhere
    this.addField({
      count: 60, w: 2600, h: 1900, vx: [-10, 10], vy: [-60, -140],
      size: [2, 4], colors: [0xffd75a, 0xff8a3a, 0xffb35a], alpha: [0.5, 1],
      sway: 16, flicker: 4,
    }, 0.9, mounts.over);
    this.addField({
      count: 50, w: 3200, h: 2200, vx: [-14, 14], vy: [-20, -55],
      size: [2, 5], colors: [0xff7a3a, 0xd6532a], alpha: [0.3, 0.7],
      sway: 24, flicker: 2.4,
    }, 0.5);
  }

  private gear(r: number, color: number): Graphics {
    const g = new Graphics();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const x1 = Math.cos(a) * r;
      const y1 = Math.sin(a) * r;
      g.rect(x1 - r * 0.09, y1 - r * 0.16, r * 0.18, r * 0.32).fill(color);
    }
    g.circle(0, 0, r).fill(color);
    g.circle(0, 0, r * 0.62).fill(shade(color, 0.7));
    g.circle(0, 0, r * 0.2).fill(color);
    return g;
  }

  protected tickScene(dt: number, _tick: number, _camX: number, _camY: number): void {
    // the lake breathes; gears turn imperceptibly (they are ancient)
    const pulse = 0.85 + 0.15 * Math.sin(this.t * 1.1);
    this.magma.alpha = pulse;
    this.heat.alpha = 0.7 + 0.3 * Math.sin(this.t * 0.7 + 1);
    this.gearA.rotation += dt * 0.05;
    this.gearB.rotation -= dt * 0.035;
    for (const ch of this.chains) {
      ch.node.rotation = Math.sin(this.t * 0.9 + ch.seed) * 0.035;
    }
  }
}
