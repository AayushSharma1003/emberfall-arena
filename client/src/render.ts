/**
 * GameRenderer: everything Pixi in the match view. Consumes draw states and
 * sim events; owns rigs, particles, popups, HUD cards, camera, hitbox
 * overlay, and the tick-synced world drawing (moving/phasing platforms,
 * hazard telegraphs, constructs, fire zones). The modes decide WHERE things
 * are (interpolation, prediction, lerp); the renderer decides how they look.
 *
 * The painterly stage scenes (parallax, weather, ambience) mount into
 * `sceneUnder`/`sceneOver` — see scenes/.
 */
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import {
  CHARACTERS, SOLID_DEPTH, ITEM_RADIUS, ULT_TUNING, attackBoxOf,
  hazardStateAt, hazardTelegraphT, platformOffset, platformPhaseIn, platformSolid,
  type Fighter, type ItemKind, type SimEvent, type Stage,
} from "@emberfall/shared";
import { Camera } from "./engine/camera.js";
import { silentAudio, type AudioBus } from "./engine/audio.js";
import { FighterRig, rigViewOf } from "./paint/rig.js";
import { glowGradient, shade } from "./paint/parts.js";
import type { PlatformPalette, StageScene } from "./scenes/index.js";

export const COLORS = [0xe8503a, 0x3a9de8, 0xe8b83a, 0x9d3ae8]; // P1..P4
export const TEAM_COLORS = [0xe8503a, 0x3a9de8]; // warm vs cool

export interface DrawFighter {
  f: Fighter;
  rx: number;
  ry: number;
}

export interface DrawProj {
  x: number;
  y: number;
  radius: number;
  owner: number;
  color: number;
  look: "shot" | "mine" | "clone";
}

export interface DrawConstruct {
  x: number;
  y: number;
  kindId: string;
  facing: 1 | -1;
  hpT: number; // 0..1 remaining
  owner: number;
}

export interface DrawZone {
  x: number;
  y: number;
  radius: number;
  owner: number;
}

export interface DrawItem {
  kind: ItemKind;
  x: number;
  y: number;
}

export interface DrawWorld {
  fighters: DrawFighter[];
  projs: DrawProj[];
  constructs: DrawConstruct[];
  zones: DrawZone[];
  items: DrawItem[];
  /** Sim tick used for platform kinematics + hazard telegraph timing. */
  tick: number;
}

interface FighterView {
  rig: FighterRig;
  ring: Graphics;
  shadow: Graphics;
  dmgText: Text;
  charId: string;
}
interface Particle { g: Graphics; vx: number; vy: number; life: number; maxLife: number; gravity: number; spin: number }
interface Popup { t: Text; vy: number; life: number }
interface HudCard {
  root: Container; name: Text; dmg: Text; pips: Graphics; meter: Graphics;
  lastDamage: number; pulse: number; lastStocks: number; lastUlt: number;
}

const CARD_W = 240;
const CARD_H = 84;
const CARD_GAP = 18;
const MAX_PARTICLES = 420;

export class GameRenderer {
  readonly camera = new Camera();
  audio: AudioBus = silentAudio;
  showHitboxes = false;
  /** Attached stage scene (parallax/weather); renderer drives its update. */
  scene: StageScene | null = null;
  platformPalette: PlatformPalette = {
    solidBody: 0x2a2140, solidTop: 0x8a765a, softBody: 0x5a4a7a, softTop: 0x9a8668,
  };

  /** Scene mount points: parallax behind the action, weather in front. */
  readonly world = new Container();
  readonly sceneUnder = new Container();
  readonly sceneOver = new Container();

  private hud = new Container();
  private fxLayer = new Container();
  private views: FighterView[] = [];
  private cards: HudCard[] = [];
  private platGfx = new Graphics();
  private hazardGfx = new Graphics();
  private zoneGfx = new Graphics();
  private constructGfx = new Graphics();
  private projGfx = new Graphics();
  private itemGfx = new Graphics();
  private hitboxGfx = new Graphics();
  private aimGfx = new Graphics();
  private time = 0;
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private banner: Text;
  private subBanner: Text;
  private fighterLayer = new Container();

  constructor(private app: Application, private stage: Stage) {
    app.stage.addChild(this.world);
    this.camera.bounds = {
      minX: stage.blast.left, maxX: stage.blast.right,
      minY: stage.blast.top, maxY: stage.blast.bottom,
    };

    this.world.addChild(this.sceneUnder);
    this.world.addChild(this.hazardGfx, this.platGfx, this.zoneGfx, this.constructGfx, this.itemGfx);
    this.world.addChild(this.fighterLayer);
    this.world.addChild(this.projGfx, this.hitboxGfx, this.aimGfx, this.fxLayer);
    this.world.addChild(this.sceneOver);
    this.app.stage.addChild(this.hud);

    this.banner = new Text({
      text: "",
      style: new TextStyle({ fontFamily: "Georgia, serif", fontSize: 68, fontWeight: "900", fill: 0xffd75a, stroke: { color: 0x000000, width: 8 }, letterSpacing: 4 }),
    });
    this.banner.anchor.set(0.5);
    this.subBanner = new Text({
      text: "",
      style: new TextStyle({ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: "bold", fill: 0xc8bce0, stroke: { color: 0x000000, width: 5 } }),
    });
    this.subBanner.anchor.set(0.5);
    this.hud.addChild(this.banner, this.subBanner);
  }

  setHelp(text: string): void {
    const help = new Text({
      text,
      style: new TextStyle({ fontFamily: "monospace", fontSize: 13, fill: 0x9a8ec0, lineHeight: 18 }),
    });
    help.position.set(24, 20);
    this.hud.addChild(help);
  }

  setBanner(main: string, sub = ""): void {
    this.banner.text = main;
    this.subBanner.text = sub;
  }

  destroy(): void {
    this.app.stage.removeChild(this.world, this.hud);
    this.world.destroy({ children: true });
    this.hud.destroy({ children: true });
  }

  // ---------- views ----------
  private ensureViews(items: DrawFighter[]): void {
    while (this.views.length < items.length) {
      const i = this.views.length;
      const f = items[i].f;

      const ring = new Graphics();
      ring.ellipse(0, 0, f.stats.width * 0.62, 9).stroke({ color: COLORS[i % COLORS.length], width: 3, alpha: 0.75 });
      const shadow = new Graphics();
      shadow.ellipse(0, 0, 44, 12).fill({ color: 0x000000, alpha: 0.45 });
      const rig = new FighterRig(f.charId, f.stats);
      const dmgText = new Text({
        text: "0%",
        style: new TextStyle({ fontFamily: "monospace", fontSize: 26, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x000000, width: 5 } }),
      });
      dmgText.anchor.set(0.5);
      this.fighterLayer.addChild(shadow, ring, rig.root, dmgText);
      this.views.push({ rig, ring, shadow, dmgText, charId: f.charId });

      // HUD card
      const root = new Container();
      const panel = new Graphics();
      panel.roundRect(0, 0, CARD_W, CARD_H, 12).fill({ color: 0x0d0a14, alpha: 0.82 });
      panel.roundRect(0, 0, 8, CARD_H, 4).fill(COLORS[i % COLORS.length]);
      root.addChild(panel);
      const name = new Text({
        text: "",
        style: new TextStyle({ fontFamily: "Georgia, serif", fontSize: 15, fontWeight: "bold", fill: COLORS[i % COLORS.length] }),
      });
      name.position.set(20, 8);
      root.addChild(name);
      const dmg = new Text({
        text: "0%",
        style: new TextStyle({ fontFamily: "monospace", fontSize: 30, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x000000, width: 4 } }),
      });
      dmg.anchor.set(0, 0.5);
      dmg.position.set(20, 46);
      root.addChild(dmg);
      const pips = new Graphics();
      pips.position.set(CARD_W - 84, 38);
      root.addChild(pips);
      const meter = new Graphics();
      meter.position.set(20, CARD_H - 14);
      root.addChild(meter);
      this.hud.addChild(root);
      this.cards.push({ root, name, dmg, pips, meter, lastDamage: 0, pulse: 0, lastStocks: -1, lastUlt: -1 });
    }
  }

  // ---------- juice ----------
  private spawnBurst(x: number, y: number, color: number, count: number, speed: number, gravity = 1800): void {
    if (this.particles.length > MAX_PARTICLES) return;
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const size = 4 + Math.random() * 8;
      g.rect(-size / 2, -size / 2, size, size).fill(color);
      g.position.set(x, y);
      this.fxLayer.addChild(g);
      const ang = Math.random() * Math.PI * 2;
      const spd = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({ g, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - speed * 0.3, life: 0.5, maxLife: 0.5, gravity, spin: 8 });
    }
  }

  private spawnRing(x: number, y: number, radius: number, color: number): void {
    const g = new Graphics();
    g.circle(0, 0, radius).stroke({ color, width: 6, alpha: 0.9 });
    g.position.set(x, y);
    g.scale.set(0.2);
    this.fxLayer.addChild(g);
    // rings ride the particle system with zero gravity and scale-out
    this.particles.push({ g, vx: 0, vy: 0, life: 0.35, maxLife: 0.35, gravity: -1, spin: 0 });
  }

  private spawnStreak(x: number, y: number, dir: number, color: number): void {
    for (let i = 0; i < 7; i++) {
      const g = new Graphics();
      g.rect(0, -2, 26 + Math.random() * 26, 4).fill(color);
      g.position.set(x - dir * i * 14, y - 40 - Math.random() * 40);
      g.alpha = 0.8;
      this.fxLayer.addChild(g);
      this.particles.push({ g, vx: -dir * (140 + Math.random() * 120), vy: 0, life: 0.28, maxLife: 0.28, gravity: 0, spin: 0 });
    }
  }

  private spawnPopup(x: number, y: number, text: string, color: number): void {
    const t = new Text({
      text,
      style: new TextStyle({ fontFamily: "monospace", fontSize: 34, fontWeight: "900", fill: color, stroke: { color: 0x000000, width: 6 } }),
    });
    t.anchor.set(0.5);
    t.position.set(x + (Math.random() * 40 - 20), y - 40);
    this.fxLayer.addChild(t);
    this.popups.push({ t, vy: -220, life: 0.7 });
  }

  handleEvents(events: SimEvent[]): void {
    const blast = this.stage.blast;
    for (const e of events) {
      switch (e.t) {
        case "hit":
          this.spawnBurst(e.x, e.y, 0xffd75a, e.heavy ? 26 : 14, e.heavy ? 700 : 420);
          this.spawnPopup(e.x, e.y, `${Math.round(e.damage)}`, e.heavy ? 0xff5a3a : 0xffd75a);
          this.camera.addShake(e.heavy ? 22 : 9);
          this.camera.addKick(e.kx, e.ky, e.heavy ? 14 : 6);
          this.audio.play(e.heavy ? "hit_heavy" : "hit_light", { x: e.x, intensity: Math.min(1, e.damage / 20) });
          break;
        case "ringout":
          this.spawnBurst(
            Math.max(blast.left + 60, Math.min(blast.right - 60, e.x)),
            Math.max(blast.top + 60, Math.min(blast.bottom - 60, e.y)),
            0xffffff, 40, 900,
          );
          this.camera.addShake(30);
          this.audio.play("ko", { x: e.x });
          break;
        case "respawn":
          this.audio.play("respawn");
          break;
        case "land":
          this.spawnBurst(e.x, e.y, 0x6a5a9a, 6, 160);
          this.audio.play("land", { x: e.x });
          break;
        case "jump":
          if (e.double) this.spawnBurst(e.x, e.y, 0xffffff, 8, 200);
          this.audio.play(e.double ? "double_jump" : "jump", { x: e.x });
          break;
        case "dash":
          this.spawnStreak(e.x, e.y, e.dir, 0xffffff);
          this.audio.play("dash", { x: e.x });
          break;
        case "shoot":
          this.spawnBurst(e.x, e.y, 0xffd75a, 5, 220, 0);
          this.audio.play("shoot", { x: e.x });
          break;
        case "projdie":
          this.spawnBurst(e.x, e.y, 0xffb03a, 8, 320, 600);
          this.audio.play("proj_die", { x: e.x });
          break;
        case "explode":
          this.spawnRing(e.x, e.y, e.radius, 0xffb03a);
          this.spawnBurst(e.x, e.y, 0xff7a3a, 24, 620, 900);
          this.camera.addShake(16);
          this.audio.play("explode", { x: e.x });
          break;
        case "teleport":
          this.spawnBurst(e.fx, e.fy, 0x9fd8ff, 14, 300, 0);
          this.spawnBurst(e.tx, e.ty, 0x9fd8ff, 10, 240, 0);
          this.audio.play("teleport", { x: e.tx });
          break;
        case "parry":
          this.spawnRing(e.x, e.y, 90, 0xfff3c0);
          this.spawnBurst(e.x, e.y, 0xfff3c0, 18, 520, 300);
          this.camera.addShake(14);
          this.audio.play("parry", { x: e.x });
          break;
        case "ult":
          this.spawnRing(e.x, e.y, 160, 0xffffff);
          this.camera.addShake(12);
          this.audio.play("ult", { x: e.x });
          break;
        case "charge":
          this.audio.play("charge", { x: 0 });
          break;
        case "release":
          this.audio.play("release", { x: 0, intensity: e.factor });
          break;
        case "burn":
          this.spawnBurst(e.x, e.y, 0xff8a3a, 3, 120, -200);
          break;
        case "zone":
          this.spawnRing(e.x, e.y, e.radius, 0xff7a3a);
          this.audio.play("zone", { x: e.x });
          break;
        case "construct":
          this.spawnBurst(e.x, e.y - 30, 0xcf8a45, 14, 300);
          this.audio.play("construct", { x: e.x });
          break;
        case "constructdie":
          this.spawnBurst(e.x, e.y - 30, 0x8a8578, 20, 420);
          this.audio.play("construct_die", { x: e.x });
          break;
        case "consthit":
          this.spawnBurst(e.x, e.y, 0xffd75a, 6, 260, 400);
          this.audio.play("hit_light", { x: e.x, intensity: 0.4 });
          break;
        case "itemspawn":
          this.spawnBurst(e.x, e.y, 0xffffff, 10, 260, 300);
          this.audio.play("item_spawn", { x: e.x });
          break;
        case "item": {
          const label = e.kind === "heart" ? "+HP" : e.kind === "wings" ? "WINGS!" : "BOMB!";
          const color = e.kind === "heart" ? 0xff5a8a : e.kind === "wings" ? 0x5ae8e8 : 0xffb03a;
          this.spawnPopup(e.x, e.y, label, color);
          this.spawnBurst(e.x, e.y, color, 12, 340, 900);
          this.audio.play("item_pickup", { x: e.x });
          break;
        }
        default:
          break;
      }
    }
  }

  // ---------- world drawing (tick-synced) ----------
  private drawPlatforms(tick: number): void {
    const g = this.platGfx;
    g.clear();
    for (const p of this.stage.platforms) {
      const off = platformOffset(p, tick);
      const x = p.x + off.x;
      const y = p.y + off.y;
      const solid = platformSolid(p, tick);
      const phaseIn = platformPhaseIn(p, tick);
      // crumble telegraph: flicker in the last ~45 ticks of solidity
      let alpha = 1;
      if (p.phasing) {
        if (!solid) alpha = 0.14;
        else if (phaseIn < 45) alpha = 0.45 + 0.4 * Math.abs(Math.sin(this.time * 20));
      }
      const pal = this.platformPalette;
      if (p.soft) {
        g.rect(x, y, p.w, 14).fill({ color: pal.softBody, alpha });
        g.rect(x, y, p.w, 4).fill({ color: pal.softTop, alpha });
      } else {
        g.rect(x, y, p.w, SOLID_DEPTH).fill({ color: pal.solidBody, alpha });
        g.rect(x, y, p.w, 8).fill({ color: pal.solidTop, alpha });
        // painterly edge shading: darker base, lit lip
        g.rect(x, y + SOLID_DEPTH * 0.55, p.w, SOLID_DEPTH * 0.45).fill({ color: 0x000000, alpha: alpha * 0.25 });
      }
    }
  }

  private drawHazards(tick: number): void {
    const g = this.hazardGfx;
    g.clear();
    for (const h of this.stage.hazards ?? []) {
      const state = hazardStateAt(h, tick);
      if (state === "idle") continue;
      if (state === "telegraph") {
        const t = hazardTelegraphT(h, tick);
        const pulse = 0.12 + t * 0.22 + Math.sin(this.time * (6 + t * 18)) * 0.06;
        g.rect(h.x, h.y, h.w, h.h).fill({ color: 0xff5a2a, alpha: Math.max(0.05, pulse) });
        g.rect(h.x, h.y + h.h - 6, h.w, 6).fill({ color: 0xffd75a, alpha: 0.5 + t * 0.5 });
      } else {
        g.rect(h.x, h.y, h.w, h.h).fill({ color: 0xffd75a, alpha: 0.75 });
        g.rect(h.x + h.w * 0.2, h.y, h.w * 0.6, h.h).fill({ color: 0xfff3c0, alpha: 0.9 });
      }
    }
  }

  private drawZones(zones: DrawZone[]): void {
    const g = this.zoneGfx;
    g.clear();
    for (const z of zones) {
      const flick = 0.75 + Math.sin(this.time * 11 + z.x) * 0.12;
      g.ellipse(z.x, z.y + 6, z.radius, z.radius * 0.32).fill({ color: 0xd6431f, alpha: 0.35 * flick });
      g.ellipse(z.x, z.y + 4, z.radius * 0.7, z.radius * 0.22).fill({ color: 0xff9d3a, alpha: 0.4 * flick });
      // licks of flame
      for (let i = 0; i < 5; i++) {
        const fx = z.x + Math.sin(i * 2.4 + this.time * 3 + z.x) * z.radius * 0.7;
        const hgt = (14 + 10 * Math.sin(this.time * 9 + i * 1.7 + z.x)) * flick;
        g.poly([fx - 6, z.y + 6, fx + 6, z.y + 6, fx, z.y + 6 - hgt]).fill({ color: 0xffb35a, alpha: 0.75 });
      }
    }
  }

  private drawConstructs(constructs: DrawConstruct[]): void {
    const g = this.constructGfx;
    g.clear();
    for (const c of constructs) {
      const big = c.kindId === "great_kiln";
      const w = big ? 74 : 56;
      const h = big ? 88 : 64;
      const body = 0x8a8578;
      // legs
      g.poly([c.x - w * 0.4, c.y, c.x - w * 0.2, c.y - h * 0.25, c.x - w * 0.05, c.y]).fill(shade(body, 0.7));
      g.poly([c.x + w * 0.4, c.y, c.x + w * 0.2, c.y - h * 0.25, c.x + w * 0.05, c.y]).fill(shade(body, 0.7));
      // body
      g.roundRect(c.x - w / 2, c.y - h, w, h * 0.8, 8).fill(shade(body, 1.0));
      g.roundRect(c.x - w / 2, c.y - h, w, h * 0.25, 8).fill(shade(body, 1.2));
      // glowing grate (dims as hp is chewed away)
      const glow = 0.35 + 0.65 * c.hpT;
      for (let i = 0; i < 3; i++) {
        g.rect(c.x - w * 0.28, c.y - h * 0.72 + i * h * 0.16, w * 0.56, h * 0.07)
          .fill({ color: 0xffb35a, alpha: glow * (0.8 + Math.sin(this.time * 7 + i) * 0.2) });
      }
      // barrel
      g.rect(c.x + c.facing * w * 0.3, c.y - h * 0.62, c.facing * w * 0.45, h * 0.16).fill(shade(body, 0.85));
      // chimney puff
      g.circle(c.x - w * 0.2, c.y - h - 6 - Math.sin(this.time * 2) * 3, 5).fill({ color: 0xccc4b8, alpha: 0.35 });
    }
  }

  private drawItems(items: DrawItem[]): void {
    const g = this.itemGfx;
    g.clear();
    for (const it of items) {
      const bob = Math.sin(this.time * 3 + it.x * 0.01) * 5;
      const y = it.y + bob;
      switch (it.kind) {
        case "heart":
          g.circle(it.x, y, ITEM_RADIUS - 4).fill(0xff5a8a);
          g.rect(it.x - 10, y - 3, 20, 6).fill(0xffffff);
          g.rect(it.x - 3, y - 10, 6, 20).fill(0xffffff);
          break;
        case "wings":
          g.poly([it.x - 22, y, it.x - 4, y - 14, it.x - 4, y + 14]).fill(0x5ae8e8);
          g.poly([it.x + 22, y, it.x + 4, y - 14, it.x + 4, y + 14]).fill(0x5ae8e8);
          break;
        case "bomb":
          g.circle(it.x, y + 2, ITEM_RADIUS - 6).fill(0x3a3a4a);
          g.rect(it.x - 2, y - ITEM_RADIUS - 2, 4, 10).fill(0x8a76b8);
          g.circle(it.x, y - ITEM_RADIUS - 4, 4).fill(0xffb03a);
          break;
      }
    }
  }

  private drawProjs(projs: DrawProj[]): void {
    const g = this.projGfx;
    g.clear();
    for (const p of projs) {
      switch (p.look) {
        case "mine": {
          const pulse = 0.5 + 0.5 * Math.sin(this.time * 6 + p.x);
          g.circle(p.x, p.y, p.radius + 4).stroke({ color: p.color, width: 2, alpha: 0.35 + pulse * 0.3 });
          g.circle(p.x, p.y, p.radius).fill(shade(p.color, 0.6));
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 + this.time;
            g.circle(p.x + Math.cos(a) * p.radius, p.y + Math.sin(a) * p.radius, 2.5).fill(p.color);
          }
          g.circle(p.x, p.y, 4).fill({ color: 0xffffff, alpha: 0.5 + pulse * 0.5 });
          break;
        }
        case "clone": {
          const shimmer = 0.55 + 0.25 * Math.sin(this.time * 9 + p.y);
          g.circle(p.x, p.y, p.radius * 1.15).fill({ color: p.color, alpha: 0.16 });
          g.ellipse(p.x, p.y, p.radius * 0.66, p.radius).fill({ color: shade(p.color, 1.1), alpha: shimmer });
          g.ellipse(p.x + p.radius * 0.12, p.y - p.radius * 0.25, p.radius * 0.2, p.radius * 0.12).fill({ color: 0x0c0a14, alpha: 0.9 });
          break;
        }
        default:
          g.circle(p.x, p.y, p.radius + 6).fill({ color: p.color, alpha: 0.22 });
          g.circle(p.x, p.y, p.radius).fill(glowGradient(0xffffff, p.color, p.radius, 1, 0.9));
          break;
      }
      if (this.showHitboxes) {
        this.hitboxGfx.circle(p.x, p.y, p.radius).stroke({ color: 0xff2a2a, width: 2, alpha: 0.9 });
      }
    }
  }

  // ---------- frame ----------
  draw(w: DrawWorld, frameDt: number, reticle: { x: number; y: number } | null, worldFrozen: boolean): void {
    this.ensureViews(w.fighters);
    const app = this.app;
    this.time += frameDt;

    this.scene?.update(frameDt, w.tick, this.camera.cx, this.camera.cy);
    this.drawPlatforms(w.tick);
    this.drawHazards(w.tick);
    this.drawZones(w.zones);
    this.drawConstructs(w.constructs);
    this.drawItems(w.items);

    this.hitboxGfx.clear();
    this.drawProjs(w.projs);

    w.fighters.forEach(({ f, rx: rx0, ry: ry0 }, i) => {
      const v = this.views[i];
      if (v.charId !== f.charId) {
        // character changed (lobby/hotseat): rebuild the rig in place
        this.fighterLayer.removeChild(v.rig.root);
        v.rig.destroy();
        v.rig = new FighterRig(f.charId, f.stats);
        this.fighterLayer.addChildAt(v.rig.root, this.fighterLayer.getChildIndex(v.dmgText));
        v.charId = f.charId;
      }
      let rx = rx0, ry = ry0;
      if (f.hitstun > 0 || worldFrozen) {
        rx += Math.random() * 4 - 2;
        ry += Math.random() * 4 - 2;
      }

      const dead = f.state === "dead";
      v.rig.root.visible = !dead;
      v.ring.visible = !dead;
      v.shadow.visible = !dead;
      v.dmgText.visible = !dead;
      if (dead) return;

      v.rig.root.position.set(rx, ry);
      v.rig.update(rigViewOf(f), frameDt);
      v.rig.root.alpha = f.invuln > 0 ? (Math.floor(f.invuln / 4) % 2 === 0 ? 0.4 : 1) : 1;

      v.ring.position.set(rx, ry + 2);
      const ringPulse = f.ult >= ULT_TUNING.max ? 0.75 + 0.25 * Math.sin(this.time * 8) : 0.55;
      v.ring.alpha = ringPulse;

      // shadow projected to the nearest platform below (kinematics-aware)
      let shadowY = 1500;
      for (const p of this.stage.platforms) {
        if (!platformSolid(p, w.tick)) continue;
        const off = platformOffset(p, w.tick);
        if (rx > p.x + off.x && rx < p.x + off.x + p.w && p.y + off.y >= ry - 4 && p.y + off.y < shadowY) shadowY = p.y + off.y;
      }
      v.shadow.visible = shadowY < 1500;
      v.shadow.position.set(rx, shadowY);
      const hgt = Math.max(0, shadowY - ry);
      const s = Math.max(0.35, 1 - hgt / 900);
      v.shadow.scale.set(s);
      v.shadow.alpha = 0.45 * s;

      v.dmgText.text = `${Math.round(f.damage)}%`;
      v.dmgText.position.set(rx, ry - f.stats.height - 28);
      v.dmgText.style.fill = rgbLerp(0xffffff, 0xff3a2a, Math.min(1, f.damage / 150));

      if (this.showHitboxes) {
        this.hitboxGfx
          .rect(rx - f.stats.width / 2, ry - f.stats.height, f.stats.width, f.stats.height)
          .stroke({ color: 0x2ae86a, width: 2, alpha: 0.9 });
        if (f.attack && f.attack.kind === "melee" && f.attack.boxW > 0 && f.attackTick >= f.attack.startupTicks && f.attackTick < f.attack.startupTicks + f.attack.activeTicks) {
          const b = attackBoxOf(f, f.attack);
          this.hitboxGfx.rect(b.x, b.y, b.w, b.h).fill({ color: 0xff2a2a, alpha: 0.35 });
        }
      }
    });

    // aim ticks + optional mouse reticle
    this.aimGfx.clear();
    w.fighters.forEach(({ f, rx, ry }, i) => {
      if (f.state === "dead") return;
      const cy = ry - f.stats.height / 2;
      this.aimGfx
        .moveTo(rx + f.aimX * 46, cy + f.aimY * 46)
        .lineTo(rx + f.aimX * 66, cy + f.aimY * 66)
        .stroke({ color: COLORS[i % COLORS.length], width: 4, alpha: 0.45 });
    });
    if (reticle) {
      this.aimGfx.circle(reticle.x, reticle.y, 10).stroke({ color: COLORS[0], width: 3, alpha: 0.9 });
      this.aimGfx.circle(reticle.x, reticle.y, 2).fill(COLORS[0]);
    }

    // particles + popups
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= frameDt;
      if (p.life <= 0) { p.g.destroy(); this.particles.splice(i, 1); continue; }
      if (p.gravity === -1) {
        // ring: scale out + fade
        p.g.scale.set(p.g.scale.x + frameDt * 4.5);
        p.g.alpha = p.life / p.maxLife;
        continue;
      }
      p.vy += p.gravity * frameDt;
      p.g.x += p.vx * frameDt;
      p.g.y += p.vy * frameDt;
      p.g.alpha = p.life / p.maxLife;
      p.g.rotation += p.spin * frameDt;
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.life -= frameDt;
      if (p.life <= 0) { p.t.destroy(); this.popups.splice(i, 1); continue; }
      p.t.y += p.vy * frameDt;
      p.vy *= 0.9;
      p.t.alpha = Math.min(1, p.life / 0.3);
    }

    // camera
    this.camera.update(
      w.fighters.map(({ f, rx, ry }) => ({ x: rx, y: ry - f.stats.height / 2, vx: f.vx, vy: f.vy, alive: f.state !== "dead" })),
      app.screen.width, app.screen.height, frameDt,
    );
    this.camera.apply(this.world, app.screen.width, app.screen.height);

    // HUD cards
    const totalW = w.fighters.length * CARD_W + (w.fighters.length - 1) * CARD_GAP;
    w.fighters.forEach(({ f }, i) => {
      const c = this.cards[i];
      c.root.position.set(
        app.screen.width / 2 - totalW / 2 + i * (CARD_W + CARD_GAP),
        app.screen.height - CARD_H - 22,
      );
      c.name.text = `${CHARACTERS[f.charId].name}`;
      if (f.damage !== c.lastDamage) {
        c.pulse = 1;
        c.lastDamage = f.damage;
      }
      c.pulse = Math.max(0, c.pulse - frameDt * 5);
      c.dmg.scale.set(1 + c.pulse * 0.3);
      c.dmg.text = `${Math.round(f.damage)}%`;
      c.dmg.style.fill = rgbLerp(0xffffff, 0xff3a2a, Math.min(1, f.damage / 150));
      if (f.stocks !== c.lastStocks) {
        c.lastStocks = f.stocks;
        c.pips.clear();
        for (let s2 = 0; s2 < 3; s2++) {
          c.pips.roundRect(s2 * 24, -8, 16, 16, 4);
          if (s2 < Math.max(0, f.stocks)) c.pips.fill(COLORS[i % COLORS.length]);
          else c.pips.stroke({ color: 0x5a4a7a, width: 2 });
        }
      }
      // ultimate meter (redraw only when it moves)
      const ultRound = Math.round(f.ult);
      if (ultRound !== c.lastUlt) {
        c.lastUlt = ultRound;
        const mw = CARD_W - 40;
        c.meter.clear();
        c.meter.roundRect(0, 0, mw, 7, 3).fill({ color: 0x241c38, alpha: 0.9 });
        const t = Math.min(1, f.ult / ULT_TUNING.max);
        if (t > 0.01) {
          c.meter.roundRect(0, 0, mw * t, 7, 3).fill(t >= 1 ? 0xffe89a : CHARACTERS[f.charId].color);
        }
      }
      if (f.ult >= ULT_TUNING.max) {
        c.meter.alpha = 0.75 + 0.25 * Math.sin(this.time * 8);
      } else {
        c.meter.alpha = 1;
      }
      c.root.alpha = f.stocks > 0 ? 1 : 0.35;
    });

    this.banner.position.set(app.screen.width / 2, app.screen.height / 2);
    this.subBanner.position.set(app.screen.width / 2, app.screen.height / 2 + 56);
  }
}

export function rgbLerp(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}
