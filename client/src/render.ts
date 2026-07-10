/**
 * GameRenderer: everything Pixi. Consumes fighter/projectile draw states and
 * sim events; owns particles, popups, HUD cards, camera, hitbox overlay.
 * Shared by local (hotseat) and online modes — the modes decide WHERE things
 * are (interpolation, prediction, lerp), the renderer decides how they look.
 */
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import {
  CHARACTERS, SOLID_DEPTH, ITEM_RADIUS, attackBoxOf,
  type Fighter, type ItemKind, type SimEvent, type Stage,
} from "@emberfall/shared";
import { Camera } from "./engine/camera.js";
import { silentAudio, type AudioBus } from "./engine/audio.js";

export const COLORS = [0xe8503a, 0x3a9de8, 0xe8b83a, 0x9d3ae8]; // P1..P4

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
}

export interface DrawItem {
  kind: ItemKind;
  x: number;
  y: number;
}

interface FighterView { shadow: Graphics; box: Graphics; dmgText: Text; charId: string; }
interface Particle { g: Graphics; vx: number; vy: number; life: number; maxLife: number; gravity: number; }
interface Popup { t: Text; vy: number; life: number; }
interface HudCard {
  root: Container; name: Text; dmg: Text; pips: Graphics;
  lastDamage: number; pulse: number; lastStocks: number;
}

const CARD_W = 230;
const CARD_H = 76;
const CARD_GAP = 18;

export class GameRenderer {
  readonly camera = new Camera();
  audio: AudioBus = silentAudio;
  showHitboxes = false;

  private world = new Container();
  private hud = new Container();
  private fxLayer = new Container();
  private views: FighterView[] = [];
  private cards: HudCard[] = [];
  private projGfx = new Graphics();
  private itemGfx = new Graphics();
  private hitboxGfx = new Graphics();
  private aimGfx = new Graphics();
  private time = 0;
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private banner: Text;
  private subBanner: Text;

  constructor(private app: Application, private stage: Stage) {
    app.stage.addChild(this.world);
    this.camera.bounds = {
      minX: stage.blast.left, maxX: stage.blast.right,
      minY: stage.blast.top, maxY: stage.blast.bottom,
    };

    const bg = new Graphics();
    bg.rect(-600, -600, 3200, 2400).fill(0x14101c);
    bg.rect(-600, 950, 3200, 1000).fill(0x0d0a14);
    this.world.addChild(bg);

    const platGfx = new Graphics();
    for (const p of stage.platforms) {
      if (p.soft) {
        platGfx.rect(p.x, p.y, p.w, 14).fill(0x5a4a7a);
        platGfx.rect(p.x, p.y, p.w, 4).fill(0x8a76b8);
      } else {
        platGfx.rect(p.x, p.y, p.w, SOLID_DEPTH).fill(0x2a2140);
        platGfx.rect(p.x, p.y, p.w, 8).fill(0x6a5a9a);
      }
    }
    this.world.addChild(platGfx);
    this.world.addChild(this.itemGfx, this.projGfx, this.hitboxGfx, this.aimGfx, this.fxLayer);
    this.app.stage.addChild(this.hud);

    this.banner = new Text({
      text: "",
      style: new TextStyle({ fontFamily: "monospace", fontSize: 64, fontWeight: "900", fill: 0xffd75a, stroke: { color: 0x000000, width: 8 } }),
    });
    this.banner.anchor.set(0.5);
    this.subBanner = new Text({
      text: "",
      style: new TextStyle({ fontFamily: "monospace", fontSize: 22, fontWeight: "bold", fill: 0x9a8ec0, stroke: { color: 0x000000, width: 5 } }),
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

  // ---------- views ----------
  private drawFighterBox(g: Graphics, f: Fighter): void {
    const { width: w, height: h } = f.stats;
    g.clear();
    // drawn white, tinted with player color -> clearing the tint gives a white hit-flash
    g.roundRect(-w / 2, -h, w, h, 10).fill(0xffffff);
    g.rect(w * 0.17, -h + h * 0.2, 14, 14).fill(0x14101c); // "eye" - scale.x flip shows facing
  }

  private ensureViews(items: DrawFighter[]): void {
    while (this.views.length < items.length) {
      const i = this.views.length;
      const f = items[i].f;
      const shadow = new Graphics();
      shadow.ellipse(0, 0, 44, 12).fill({ color: 0x000000, alpha: 0.45 });
      const box = new Graphics();
      this.drawFighterBox(box, f);
      box.tint = COLORS[i % COLORS.length];
      const dmgText = new Text({
        text: "0%",
        style: new TextStyle({ fontFamily: "monospace", fontSize: 26, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x000000, width: 5 } }),
      });
      dmgText.anchor.set(0.5);
      this.world.addChild(shadow, box, dmgText);
      this.views.push({ shadow, box, dmgText, charId: f.charId });

      const root = new Container();
      const panel = new Graphics();
      panel.roundRect(0, 0, CARD_W, CARD_H, 12).fill({ color: 0x0d0a14, alpha: 0.82 });
      panel.roundRect(0, 0, 8, CARD_H, 4).fill(COLORS[i % COLORS.length]);
      root.addChild(panel);
      const name = new Text({
        text: "",
        style: new TextStyle({ fontFamily: "monospace", fontSize: 15, fontWeight: "bold", fill: COLORS[i % COLORS.length] }),
      });
      name.position.set(20, 10);
      root.addChild(name);
      const dmg = new Text({
        text: "0%",
        style: new TextStyle({ fontFamily: "monospace", fontSize: 32, fontWeight: "900", fill: 0xffffff, stroke: { color: 0x000000, width: 4 } }),
      });
      dmg.anchor.set(0, 0.5);
      dmg.position.set(20, 50);
      root.addChild(dmg);
      const pips = new Graphics();
      pips.position.set(CARD_W - 84, 42);
      root.addChild(pips);
      this.hud.addChild(root);
      this.cards.push({ root, name, dmg, pips, lastDamage: 0, pulse: 0, lastStocks: -1 });
    }
  }

  // ---------- juice ----------
  private spawnBurst(x: number, y: number, color: number, count: number, speed: number, gravity = 1800): void {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const size = 4 + Math.random() * 8;
      g.rect(-size / 2, -size / 2, size, size).fill(color);
      g.position.set(x, y);
      this.fxLayer.addChild(g);
      const ang = Math.random() * Math.PI * 2;
      const spd = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({ g, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - speed * 0.3, life: 0.5, maxLife: 0.5, gravity });
    }
  }

  private spawnStreak(x: number, y: number, dir: number, color: number): void {
    for (let i = 0; i < 7; i++) {
      const g = new Graphics();
      g.rect(0, -2, 26 + Math.random() * 26, 4).fill(color);
      g.position.set(x - dir * i * 14, y - 40 - Math.random() * 40);
      g.alpha = 0.8;
      this.fxLayer.addChild(g);
      this.particles.push({ g, vx: -dir * (140 + Math.random() * 120), vy: 0, life: 0.28, maxLife: 0.28, gravity: 0 });
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
          this.spawnPopup(e.x, e.y, `${e.damage}`, e.heavy ? 0xff5a3a : 0xffd75a);
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
      }
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

  // ---------- frame ----------
  draw(items: DrawFighter[], projs: DrawProj[], worldItems: DrawItem[], frameDt: number, reticle: { x: number; y: number } | null, worldFrozen: boolean): void {
    this.ensureViews(items);
    const app = this.app;
    this.time += frameDt;
    this.drawItems(worldItems);

    this.hitboxGfx.clear();
    items.forEach(({ f, rx: rx0, ry: ry0 }, i) => {
      const v = this.views[i];
      if (v.charId !== f.charId) {
        this.drawFighterBox(v.box, f);
        v.charId = f.charId;
      }
      let rx = rx0, ry = ry0;
      if (f.hitstun > 0 || worldFrozen) {
        rx += Math.random() * 4 - 2;
        ry += Math.random() * 4 - 2;
      }

      const dead = f.state === "dead";
      v.box.visible = !dead;
      v.shadow.visible = !dead;
      v.dmgText.visible = !dead;
      if (dead) return;

      v.box.position.set(rx, ry);
      const stretch = Math.min(0.25, Math.abs(f.vy) / 4000);
      if (!f.grounded) v.box.scale.set(f.facing * (1 - stretch), 1 + stretch);
      else v.box.scale.set(f.facing, 1);
      v.box.alpha = f.invuln > 0 ? (Math.floor(f.invuln / 4) % 2 === 0 ? 0.4 : 1) : 1;
      v.box.tint = f.hitstun > 0 ? 0xffffff : COLORS[i % COLORS.length];

      // shadow projected to the nearest platform below
      let shadowY = 1500;
      for (const p of this.stage.platforms) {
        if (rx > p.x && rx < p.x + p.w && p.y >= ry - 4 && p.y < shadowY) shadowY = p.y;
      }
      v.shadow.visible = shadowY < 1500;
      v.shadow.position.set(rx, shadowY);
      const h = Math.max(0, shadowY - ry);
      const s = Math.max(0.35, 1 - h / 900);
      v.shadow.scale.set(s);
      v.shadow.alpha = 0.45 * s;

      v.dmgText.text = `${Math.round(f.damage)}%`;
      v.dmgText.position.set(rx, ry - f.stats.height - 28);
      v.dmgText.style.fill = rgbLerp(0xffffff, 0xff3a2a, Math.min(1, f.damage / 150));

      if (this.showHitboxes) {
        this.hitboxGfx
          .rect(rx - f.stats.width / 2, ry - f.stats.height, f.stats.width, f.stats.height)
          .stroke({ color: 0x2ae86a, width: 2, alpha: 0.9 });
        if (f.attack && f.attack.kind === "melee" && f.attackTick >= f.attack.startupTicks && f.attackTick < f.attack.startupTicks + f.attack.activeTicks) {
          const b = attackBoxOf(f, f.attack);
          this.hitboxGfx.rect(b.x, b.y, b.w, b.h).fill({ color: 0xff2a2a, alpha: 0.35 });
        }
      }
    });

    // projectiles
    this.projGfx.clear();
    for (const p of projs) {
      this.projGfx.circle(p.x, p.y, p.radius + 5).fill({ color: COLORS[p.owner % COLORS.length] ?? 0xffd75a, alpha: 0.25 });
      this.projGfx.circle(p.x, p.y, p.radius).fill(0xffd75a);
      if (this.showHitboxes) {
        this.hitboxGfx.circle(p.x, p.y, p.radius).stroke({ color: 0xff2a2a, width: 2, alpha: 0.9 });
      }
    }

    // aim ticks + optional mouse reticle
    this.aimGfx.clear();
    items.forEach(({ f, rx, ry }, i) => {
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
      p.vy += p.gravity * frameDt;
      p.g.x += p.vx * frameDt;
      p.g.y += p.vy * frameDt;
      p.g.alpha = p.life / p.maxLife;
      p.g.rotation += 8 * frameDt;
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
      items.map(({ f, rx, ry }) => ({ x: rx, y: ry - f.stats.height / 2, vx: f.vx, vy: f.vy, alive: f.state !== "dead" })),
      app.screen.width, app.screen.height, frameDt,
    );
    this.camera.apply(this.world, app.screen.width, app.screen.height);

    // HUD cards
    const totalW = items.length * CARD_W + (items.length - 1) * CARD_GAP;
    items.forEach(({ f }, i) => {
      const c = this.cards[i];
      c.root.position.set(
        app.screen.width / 2 - totalW / 2 + i * (CARD_W + CARD_GAP),
        app.screen.height - CARD_H - 22,
      );
      c.name.text = `P${i + 1} · ${CHARACTERS[f.charId].name}`;
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
        for (let s = 0; s < 3; s++) {
          c.pips.roundRect(s * 24, -8, 16, 16, 4);
          if (s < Math.max(0, f.stocks)) c.pips.fill(COLORS[i % COLORS.length]);
          else c.pips.stroke({ color: 0x5a4a7a, width: 2 });
        }
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
