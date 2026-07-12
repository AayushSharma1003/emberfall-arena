/**
 * Character select: the full roster as painterly cards around a live
 * preview. The preview puppets the SAME FighterRig the match renders —
 * looping each fighter's primary so ranged fighters visibly cast/draw/
 * lob (per the melee/ranged distinction) and melee fighters swing,
 * with a hand-animated projectile matching the character's actual
 * ProjectileDef (speed, arc, color).
 *
 * Play mode: pick yourself (and an ally in 2v2), confirm to map select.
 * Browse mode (from the menu): same screen, no picking, ESC back.
 */
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { CHARACTERS, CHAR_IDS, type CharacterDef, type CharId } from "@emberfall/shared";
import { FighterRig, attackStyleOf, type RigView } from "../paint/rig.js";
import { glowGradient } from "../paint/parts.js";
import { skyRect } from "../scenes/scene.js";
import type { MatchMode } from "./flow.js";
import {
  BaseScreen, EmberEmitter, lerpColor, mono, serif, UI, UiButton, type UiContext,
} from "./screens.js";

// ---------------------------------------------------------------------------
// rig puppet: idle -> primary attack -> idle, forever
// ---------------------------------------------------------------------------

const AIM_X = 1;
const AIM_Y = -0.18;
const PREVIEW_SPEED = 0.55; // slow-mo so 11-tick lights still read as motion

interface FlyingBolt {
  g: Graphics;
  vx: number;
  vy: number;
  gravity: number;
  life: number;
}

class RigPuppet {
  readonly node = new Container();
  readonly fx = new Container(); // projectiles/swooshes, sibling of the rig so they don't scale with it
  private rig: FighterRig;
  private def: CharacterDef;
  private phase: "idle" | "attack" = "idle";
  private timer = 1.0;
  private attackTick = 0;
  private fired = false;
  private bolts: FlyingBolt[] = [];
  private swoosh: Graphics | null = null;
  private swooshLife = 0;

  constructor(charId: CharId, private animate: boolean) {
    this.def = CHARACTERS[charId];
    this.rig = new FighterRig(charId, this.def.stats);
    this.node.addChild(this.rig.root);
  }

  get char(): CharacterDef {
    return this.def;
  }

  update(dt: number): void {
    const move = this.def.moves.light;
    const total = move.startupTicks + move.activeTicks + move.recoveryTicks;

    if (this.animate) {
      if (this.phase === "idle") {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.phase = "attack";
          this.attackTick = 0;
          this.fired = false;
        }
      } else {
        this.attackTick += dt * 60 * PREVIEW_SPEED;
        if (!this.fired && this.attackTick >= move.startupTicks) {
          this.fired = true;
          this.emitAttackFx();
        }
        if (this.attackTick >= total) {
          this.phase = "idle";
          this.timer = 1.35;
        }
      }
    }

    const view: RigView = {
      state: this.phase === "attack" ? "attack" : "idle",
      facing: 1,
      vx: 0, vy: 0,
      grounded: true,
      aimX: AIM_X, aimY: AIM_Y,
      attack: this.phase === "attack"
        ? {
            tick: this.attackTick,
            startup: move.startupTicks, active: move.activeTicks, recovery: move.recoveryTicks,
            aimX: AIM_X, aimY: AIM_Y,
            style: attackStyleOf(move),
          }
        : null,
      charging: false, chargeT: 0,
      burning: false,
      damage: 0,
      ultReady: false,
    };
    this.rig.update(view, dt);
    this.updateFx(dt);
  }

  private emitAttackFx(): void {
    const move = this.def.moves.light;
    const color = this.def.color;
    if (move.kind === "projectile" && move.projectile) {
      const p = move.projectile;
      const hx = 0.55 * this.def.stats.width;
      const hy = -0.62 * this.def.stats.height;
      const m = Math.hypot(AIM_X, AIM_Y);
      const g = new Graphics();
      g.circle(0, 0, p.radius + 5).fill({ color, alpha: 0.22 });
      g.circle(0, 0, p.radius).fill(glowGradient(0xffffff, color, p.radius, 1, 0.9));
      g.position.set(hx, hy);
      this.fx.addChild(g);
      this.bolts.push({
        g,
        vx: (AIM_X / m) * p.speed * PREVIEW_SPEED,
        vy: (AIM_Y / m) * p.speed * PREVIEW_SPEED,
        gravity: 2200 * p.gravityScale * PREVIEW_SPEED,
        life: 1.1,
      });
    } else {
      // melee: a white arc swoosh along the swing plane
      const r = Math.max(60, move.reach);
      const s = new Graphics();
      const a0 = -1.15, a1 = 0.55; // matches the shoulder-to-followthrough sweep
      s.arc(0, -this.def.stats.height * 0.55, r, a0, a1).stroke({ color: 0xfff3c0, width: 7, alpha: 0.85 });
      s.arc(0, -this.def.stats.height * 0.55, r * 0.82, a0 + 0.2, a1 - 0.1).stroke({ color, width: 4, alpha: 0.5 });
      this.fx.addChild(s);
      this.swoosh = s;
      this.swooshLife = 0.3;
    }
  }

  private updateFx(dt: number): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      if (b.life <= 0) {
        b.g.destroy();
        this.bolts.splice(i, 1);
        continue;
      }
      b.vy += b.gravity * dt;
      b.g.x += b.vx * dt;
      b.g.y += b.vy * dt;
      b.g.alpha = Math.min(1, b.life / 0.3);
    }
    if (this.swoosh) {
      this.swooshLife -= dt;
      if (this.swooshLife <= 0) {
        this.swoosh.destroy();
        this.swoosh = null;
      } else {
        this.swoosh.alpha = this.swooshLife / 0.3;
        this.swoosh.rotation += dt * 2.4;
      }
    }
  }

  destroy(): void {
    this.rig.destroy();
    for (const b of this.bolts) b.g.destroy();
    this.swoosh?.destroy();
    this.node.destroy({ children: true });
    this.fx.destroy({ children: true });
  }
}

// ---------------------------------------------------------------------------
// the screen
// ---------------------------------------------------------------------------

const GRID_COLS = 3;

interface Card {
  root: Container;
  frame: Graphics;
  puppet: RigPuppet;
  char: CharacterDef;
  hoverT: number;
}

export class CharSelectScreen extends BaseScreen {
  private bg!: Graphics;
  private sky!: Graphics;
  private embers!: EmberEmitter;
  private header!: Text;
  private subheader!: Text;

  private cards: Card[] = [];
  private gridRoot!: Container;
  private focusIdx = 0;

  private previewRoot!: Container;
  private previewPuppet: RigPuppet | null = null;
  private previewGlow!: Graphics;
  private previewViewport!: Container;
  private pvName!: Text;
  private pvEpithet!: Text;
  private pvChips!: Graphics;
  private pvRole!: Text;
  private pvType!: Text;
  private pvTagline!: Text;
  private pvLore!: Text;
  private pvUlt!: Text;
  private pvBars!: Graphics;
  private pvBarLabels: Text[] = [];

  private footRoot!: Container;
  private modeButtons: UiButton[] = [];
  private mode: MatchMode = "duo";
  private pickPlayer: CharId | null = null;
  private pickAlly: CharId | null = null;
  private pickChips!: Text;
  private confirmBtn!: UiButton;
  private backBtn!: UiButton;

  private t = 0;

  constructor(ctx: UiContext) {
    super(ctx, "charselect");
  }

  private get browsing(): boolean {
    return this.ctx.flow.browsing;
  }

  protected build(): void {
    this.t = 0;
    this.focusIdx = 0;
    this.pickPlayer = null;
    this.pickAlly = null;

    this.bg = new Graphics();
    this.root.addChild(this.bg);
    this.sky = skyRect(0, 0, 4, 4, [
      [0, "#120c1c"], [0.55, "#1c1226"], [0.85, "#33182a"], [1, "#4a2230"],
    ]);
    // skyRect authors around (0,0) size 4x4 — scaled to the screen each layout
    this.root.addChild(this.sky);

    this.embers = new EmberEmitter({
      x0: 0, x1: 100, y0: 0, y1: 100, rate: 7,
      vx: [-8, 10], vy: [-18, -46], life: [2.5, 5], size: [1.5, 3.2],
      colors: [UI.ember, UI.gold, 0xb85a7a], cap: 46,
    });
    this.root.addChild(this.embers.node);

    this.header = new Text({ text: "", style: serif(44, UI.gold) });
    this.header.anchor.set(0, 0);
    this.subheader = new Text({ text: "", style: serif(17, UI.dim, "bold") });
    this.subheader.anchor.set(0, 0);
    this.root.addChild(this.header, this.subheader);

    // grid
    this.gridRoot = new Container();
    this.root.addChild(this.gridRoot);
    this.cards = CHAR_IDS.map((id, i) => this.buildCard(id, i));

    // preview
    this.previewRoot = new Container();
    this.root.addChild(this.previewRoot);
    this.buildPreview();

    // footer
    this.footRoot = new Container();
    this.root.addChild(this.footRoot);
    this.buildFooter();

    this.setPreview(CHAR_IDS[0]);
    this.updateHeader();

    this.on("keydown", (e) => this.onKey(e));
  }

  // ---------- cards ----------
  private buildCard(id: CharId, i: number): Card {
    const char = CHARACTERS[id];
    const root = new Container();
    const frame = new Graphics();
    root.addChild(frame);

    const puppet = new RigPuppet(id, false); // cards idle only; the preview animates
    root.addChild(puppet.fx, puppet.node);

    const name = new Text({ text: char.name.toUpperCase(), style: serif(19, UI.parchment) });
    name.anchor.set(0.5, 0);
    (root as Container & { nameText?: Text }).nameText = name;
    root.addChild(name);

    root.eventMode = "static";
    root.cursor = "pointer";
    root.on("pointerover", () => {
      if (this.focusIdx !== i) this.ctx.audio.play("ui_move");
      this.focusIdx = i;
      this.setPreview(id);
    });
    root.on("pointertap", () => {
      this.focusIdx = i;
      this.setPreview(id);
      this.pick(id);
    });
    this.gridRoot.addChild(root);
    return { root, frame, puppet, char, hoverT: 0 };
  }

  private drawCard(c: Card, w: number, h: number, focus: number, picked: boolean): void {
    const g = c.frame;
    g.clear();
    g.roundRect(-w / 2, -h / 2, w, h, 14).fill({ color: UI.ink, alpha: 0.78 + focus * 0.1 });
    const edge = picked ? UI.gold : lerpColor(0x3a2a4e, c.char.color, Math.max(focus, 0.25));
    g.roundRect(-w / 2, -h / 2, w, h, 14).stroke({ color: edge, width: picked ? 3 : 2, alpha: 0.5 + focus * 0.5 });
    // signature-color ground glow under the fighter
    g.ellipse(0, h * 0.30, w * 0.33, 10).fill({ color: c.char.color, alpha: 0.14 + focus * 0.22 });
    if (picked) {
      g.circle(w / 2 - 18, -h / 2 + 18, 9).fill(UI.gold);
      g.circle(w / 2 - 18, -h / 2 + 18, 9).stroke({ color: UI.ink, width: 2 });
    }
  }

  // ---------- preview ----------
  private buildPreview(): void {
    this.previewGlow = new Graphics();
    this.previewRoot.addChild(this.previewGlow);

    this.previewViewport = new Container();
    this.previewRoot.addChild(this.previewViewport);

    this.pvName = new Text({ text: "", style: serif(40, UI.gold) });
    this.pvEpithet = new Text({ text: "", style: serif(19, UI.parchment, "bold") });
    this.pvChips = new Graphics(); // painted plates behind the role/type tags
    this.previewRoot.addChild(this.pvChips);
    this.pvRole = new Text({ text: "", style: mono(13, UI.ink, "900") });
    this.pvType = new Text({ text: "", style: mono(13, UI.ink, "900") });
    this.pvTagline = new Text({ text: "", style: serif(16, UI.dim, "bold") });
    this.pvLore = new Text({ text: "", style: new TextStyle({
      fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 15, fill: UI.parchment,
      wordWrap: true, wordWrapWidth: 380, lineHeight: 22,
    }) });
    this.pvUlt = new Text({ text: "", style: serif(15, UI.ember, "bold") });
    this.pvBars = new Graphics();
    this.previewRoot.addChild(this.pvName, this.pvEpithet, this.pvRole, this.pvType, this.pvTagline, this.pvLore, this.pvUlt, this.pvBars);
    for (const label of ["WEIGHT", "SPEED", "JUMPS"]) {
      const t = new Text({ text: label, style: mono(12, UI.faint, "bold") });
      this.pvBarLabels.push(t);
      this.previewRoot.addChild(t);
    }
  }

  private setPreview(id: CharId): void {
    if (this.previewPuppet?.char.id === id) return;
    this.previewPuppet?.destroy();
    this.previewViewport.removeChildren();
    this.previewPuppet = new RigPuppet(id, true);
    this.previewViewport.addChild(this.previewPuppet.fx, this.previewPuppet.node);

    const c = CHARACTERS[id];
    this.pvName.text = c.name.toUpperCase();
    this.pvEpithet.text = c.epithet;
    this.pvRole.text = c.role.toUpperCase();
    this.pvType.text = c.attackType === "ranged" ? "RANGED PRIMARY" : "MELEE PRIMARY";
    this.pvTagline.text = `“${c.tagline}”`;
    this.pvLore.text = c.lore;
    this.pvUlt.text = `ULTIMATE — ${c.moves.ultimate.id.replace(/_/g, " ").toUpperCase()}`;
    this.layoutPreview();
  }

  // ---------- footer ----------
  private buildFooter(): void {
    const mk = (label: string, m: MatchMode): UiButton => {
      const b = new UiButton(label, 20, () => {
        if (!this.active) return;
        this.mode = m;
        this.pickPlayer = null;
        this.pickAlly = null;
        this.ctx.audio.play("ui_select");
        this.updateHeader();
      }, () => this.ctx.audio.play("ui_move"));
      this.footRoot.addChild(b.root);
      return b;
    };
    this.modeButtons = [mk("2 v 2", "duo"), mk("1 v 1", "solo")];

    this.pickChips = new Text({ text: "", style: serif(18, UI.parchment, "bold") });
    this.pickChips.anchor.set(0.5, 0.5);
    this.footRoot.addChild(this.pickChips);

    this.confirmBtn = new UiButton("TO THE GROUNDS  →", 26, () => {
      if (!this.active || !this.readyToConfirm()) return;
      this.ctx.audio.play("ui_select");
      this.ctx.flow.draft = { mode: this.mode, playerChar: this.pickPlayer!, allyChar: this.pickAlly };
      this.ctx.flow.go("mapselect");
    }, () => this.ctx.audio.play("ui_move"));
    this.footRoot.addChild(this.confirmBtn.root);

    this.backBtn = new UiButton("← BACK", 18, () => {
      if (!this.active) return;
      this.ctx.audio.play("ui_back");
      this.ctx.flow.go("menu");
    }, () => this.ctx.audio.play("ui_move"));
    this.footRoot.addChild(this.backBtn.root);
  }

  private readyToConfirm(): boolean {
    if (this.browsing) return false;
    if (this.mode === "solo") return this.pickPlayer !== null;
    return this.pickPlayer !== null && this.pickAlly !== null;
  }

  private pick(id: CharId): void {
    if (this.browsing) return;
    this.ctx.audio.play("ui_select");
    if (this.pickPlayer === null) {
      this.pickPlayer = id;
    } else if (this.mode === "duo" && this.pickAlly === null) {
      this.pickAlly = id;
    } else {
      // re-pick from scratch
      this.pickPlayer = id;
      this.pickAlly = null;
    }
    this.updateHeader();
  }

  private updateHeader(): void {
    if (this.browsing) {
      this.header.text = "THE ROSTER";
      this.subheader.text = "hover to preview  ·  ESC to return";
      return;
    }
    if (this.pickPlayer === null) {
      this.header.text = "CHOOSE YOUR FIGHTER";
      this.subheader.text = this.mode === "duo" ? "you pick first — your ally follows" : "one on one";
    } else if (this.mode === "duo" && this.pickAlly === null) {
      this.header.text = "CHOOSE YOUR ALLY";
      this.subheader.text = `${CHARACTERS[this.pickPlayer].name} fights beside…`;
    } else {
      this.header.text = "READY";
      this.subheader.text = "confirm to choose the ground";
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    const cols = GRID_COLS;
    const n = this.cards.length;
    let idx = this.focusIdx;
    switch (e.code) {
      case "ArrowLeft": case "KeyA": idx = (idx + n - 1) % n; break;
      case "ArrowRight": case "KeyD": idx = (idx + 1) % n; break;
      case "ArrowUp": case "KeyW": idx = (idx + n - cols) % n; break;
      case "ArrowDown": case "KeyS": idx = (idx + cols) % n; break;
      case "Enter": case "Space":
        if (this.readyToConfirm()) this.confirmBtn.pick();
        else this.pick(this.cards[this.focusIdx].char.id);
        return;
      case "Escape":
        this.ctx.audio.play("ui_back");
        if (!this.browsing && this.mode === "duo" && this.pickAlly === null && this.pickPlayer !== null) {
          this.pickPlayer = null; // step back one pick
          this.updateHeader();
        } else {
          this.ctx.flow.go("menu");
        }
        return;
      case "Tab":
        e.preventDefault();
        if (!this.browsing) this.modeButtons[this.mode === "duo" ? 1 : 0].pick();
        return;
      default: {
        const digit = e.code.match(/^Digit([1-9])$/);
        if (digit) {
          idx = Number(digit[1]) - 1;
          this.focusIdx = idx;
          this.setPreview(this.cards[idx].char.id);
          this.pick(this.cards[idx].char.id);
          return;
        }
        return;
      }
    }
    if (idx !== this.focusIdx) {
      this.focusIdx = idx;
      this.ctx.audio.play("ui_move");
      this.setPreview(this.cards[idx].char.id);
    }
  }

  // ---------- layout ----------
  private cardW = 150;
  private cardH = 170;
  private pvX = 0;
  private pvY = 0;
  private pvW = 420;

  protected layout(w: number, h: number): void {
    this.bg.clear().rect(0, 0, w, h).fill(0x120c1c);
    this.sky.position.set(w / 2, h / 2);
    this.sky.scale.set(w / 2, h / 2);

    this.embers.spec.x0 = 0;
    this.embers.spec.x1 = w;
    this.embers.spec.y0 = h * 0.4;
    this.embers.spec.y1 = h + 20;

    const margin = Math.max(32, w * 0.04);
    this.header.position.set(margin, h * 0.045);
    this.header.style.fontSize = Math.max(30, Math.min(52, w * 0.032));
    this.subheader.position.set(margin + 4, h * 0.045 + this.header.height + 4);

    // grid occupies the left ~52%
    const gridW = w * 0.5;
    const gridTop = h * 0.2;
    const gridH = h * 0.62;
    this.cardW = Math.min(190, (gridW - margin) / GRID_COLS - 16);
    this.cardH = Math.min(200, gridH / 3 - 14);
    this.gridRoot.position.set(margin + this.cardW / 2, gridTop + this.cardH / 2);
    this.cards.forEach((c, i) => {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      c.root.position.set(col * (this.cardW + 16), row * (this.cardH + 14));
      const scale = (this.cardH * 0.52) / c.char.stats.height;
      c.puppet.node.scale.set(scale);
      c.puppet.node.position.set(0, this.cardH * 0.33);
      c.puppet.fx.scale.set(scale);
      c.puppet.fx.position.set(0, this.cardH * 0.33);
      const name = (c.root as Container & { nameText?: Text }).nameText;
      name?.position.set(0, -this.cardH / 2 + 10);
      if (name) name.style.fontSize = Math.max(13, this.cardH * 0.1);
    });

    // preview panel on the right
    this.pvW = Math.min(520, w * 0.4);
    this.pvX = w - margin - this.pvW;
    this.pvY = h * 0.17;
    this.layoutPreview();

    // footer strip
    this.footRoot.position.set(0, h - Math.max(54, h * 0.075));
    this.modeButtons[0].root.position.set(margin + 50, 0);
    this.modeButtons[1].root.position.set(margin + 160, 0);
    this.pickChips.position.set(w * 0.47, 0);
    this.confirmBtn.root.position.set(this.pvX + this.pvW * 0.55, 0);
    this.backBtn.root.position.set(margin + 46, -h + this.header.y + 16 + this.header.height / 2);
  }

  private layoutPreview(): void {
    const w = this.pvW;
    const x = this.pvX;
    const y = this.pvY;
    const char = this.previewPuppet?.char;
    if (!char) return;

    this.previewGlow.clear();
    this.previewGlow.circle(x + w * 0.28, y + 200, 240).fill(glowGradient(char.color, 0x14101c, 240, 0.3, 0));

    const scale = 175 / char.stats.height;
    this.previewViewport.position.set(x + w * 0.26, y + 300);
    this.previewViewport.scale.set(scale);

    this.pvName.position.set(x + w * 0.5, y);
    this.pvEpithet.position.set(x + w * 0.5, y + this.pvName.height + 2);
    // role + attackType as gilt/ember pill chips (dark text on a painted plate)
    const chipY = y + 92;
    const pad = 9;
    this.pvRole.position.set(x + w * 0.5 + pad, chipY + 5);
    const roleW = this.pvRole.width + pad * 2;
    this.pvType.position.set(x + w * 0.5 + roleW + 10 + pad, chipY + 5);
    const typeW = this.pvType.width + pad * 2;
    const typeColor = char.attackType === "ranged" ? 0x7ab8ff : UI.ember;
    this.pvChips.clear();
    this.pvChips.roundRect(x + w * 0.5, chipY, roleW, 24, 6).fill(UI.gold);
    this.pvChips.roundRect(x + w * 0.5 + roleW + 10, chipY, typeW, 24, 6).fill(typeColor);
    this.pvTagline.position.set(x + w * 0.5, y + 126);

    this.pvBars.clear();
    const bx = x + w * 0.5, bw = w * 0.42;
    const stats = char.stats;
    const rows: [number, number][] = [
      [(stats.weight - 0.6) / 0.95, 0],
      [(stats.speedMult - 0.7) / 0.65, 1],
    ];
    for (const [t, row] of rows) {
      const by = y + 165 + row * 30;
      this.pvBars.roundRect(bx + 70, by, bw - 70, 9, 4).fill(0x241c38);
      this.pvBars.roundRect(bx + 70, by, Math.max(8, (bw - 70) * Math.min(1, t)), 9, 4).fill(char.color);
      this.pvBarLabels[row].position.set(bx, by - 3);
    }
    // jumps as pips
    const jy = y + 165 + 60;
    this.pvBarLabels[2].position.set(bx, jy - 3);
    for (let j = 0; j < 3; j++) {
      this.pvBars.circle(bx + 82 + j * 26, jy + 2, 8)
        .fill(j < stats.jumpCount ? char.color : 0x241c38);
    }

    this.pvUlt.position.set(x + w * 0.5, jy + 32);
    this.pvLore.position.set(x + w * 0.5, jy + 62);
    this.pvLore.style.wordWrapWidth = w * 0.48;
  }

  // ---------- tick ----------
  protected tick(dt: number): void {
    this.t += dt;
    this.embers.update(dt);

    this.cards.forEach((c, i) => {
      const focused = i === this.focusIdx;
      c.hoverT += ((focused ? 1 : 0) - c.hoverT) * Math.min(1, dt * 12);
      const picked =
        c.char.id === this.pickPlayer || (this.mode === "duo" && c.char.id === this.pickAlly && this.pickAlly !== null);
      this.drawCard(c, this.cardW, this.cardH, c.hoverT, !this.browsing && !!picked);
      c.root.scale.set(1 + c.hoverT * 0.05);
      c.puppet.update(dt);
    });

    this.previewPuppet?.update(dt);

    // footer state
    this.modeButtons[0].focused = this.mode === "duo";
    this.modeButtons[1].focused = this.mode === "solo";
    for (const b of this.modeButtons) {
      b.update(dt);
      b.root.visible = !this.browsing;
    }
    if (this.browsing) {
      this.pickChips.text = "";
    } else if (this.mode === "duo") {
      const p = this.pickPlayer ? CHARACTERS[this.pickPlayer].name : "—";
      const a = this.pickAlly ? CHARACTERS[this.pickAlly].name : "—";
      this.pickChips.text = `YOU  ${p}    ·    ALLY  ${a}`;
    } else {
      this.pickChips.text = `YOU  ${this.pickPlayer ? CHARACTERS[this.pickPlayer].name : "—"}`;
    }
    this.confirmBtn.root.visible = this.readyToConfirm();
    this.confirmBtn.update(dt);
    this.backBtn.update(dt);
  }
}
