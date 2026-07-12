/**
 * Map select: the four arenas as LIVE animated thumbnails — each a real
 * StageScene (same painter the match uses) rendered small with reduced
 * particle density, its platforms drawn as silhouettes on top. Hovering a
 * map fills a detail panel: blast-zone shape diagram, hazard line, mood.
 * A difficulty selector (Easy/Normal/Hard) gates the bot params, and
 * confirming completes the MatchConfig and starts the match.
 */
import { Container, Graphics, Text } from "pixi.js";
import {
  CHAR_IDS, SOLID_DEPTH, STAGE_INFO,
  type CharId, type Stage, type StageInfo, type StageTheme,
} from "@emberfall/shared";
import { makeScene, PLATFORM_PALETTES, type StageScene } from "../scenes/index.js";
import { ParticleField, SCENE_CX, SCENE_CY } from "../scenes/scene.js";

// MiniScene builds at this fixed internal resolution; cards rescale its root.
const MINI_W = 320;
const MINI_H = 190;
import type { MatchConfig } from "./flow.js";
import {
  BaseScreen, lerpColor, mono, panel, serif, UI, UiButton, type UiContext,
} from "./screens.js";

// per-map select-screen flavor (client-side; the sim stays flavor-free)
interface MapFlavor {
  blastLabel: string;
  hazard: string;
  mood: string;
}
const FLAVOR: Record<string, MapFlavor> = {
  emberfall_keep: { blastLabel: "Balanced", hazard: "None — pure neutral", mood: "Where it all began" },
  molten_span: { blastLabel: "Wide", hazard: "Magma geyser · forge hammer", mood: "Learn the schedule" },
  stormshard: { blastLabel: "Tall", hazard: "Twin lightning rods", mood: "Juggles end stocks" },
  ashwood: { blastLabel: "Widest", hazard: "Shifting living roots", mood: "Chase at your peril" },
};

// ---------------------------------------------------------------------------
// live mini-scene: a real StageScene + platform silhouettes, masked + scaled
// ---------------------------------------------------------------------------

class MiniScene {
  readonly root = new Container();
  private scene: StageScene;
  private inner = new Container();
  private t = Math.random() * 8;

  constructor(info: StageInfo) {
    const stage = info.make();
    const under = new Container();
    const over = new Container();
    const plat = this.buildPlatforms(stage, info.theme);
    this.inner.addChild(under, plat, over);

    // four scenes build at once — thin the weather so the menu stays light
    const prev = ParticleField.densityScale;
    ParticleField.densityScale = 0.32;
    this.scene = makeScene(info.theme, stage, { under, over });
    ParticleField.densityScale = prev;

    // fit the authored world (~2300x1500 around the scene reference center)
    // into the thumbnail, biased down so platforms sit in the lower third
    const worldW = 2300, worldH = 1500;
    const scale = Math.max(MINI_W / worldW, MINI_H / worldH);
    this.inner.scale.set(scale);
    this.inner.position.set(MINI_W / 2 - SCENE_CX * scale, MINI_H * 0.52 - SCENE_CY * scale);

    const mask = new Graphics();
    mask.roundRect(0, 0, MINI_W, MINI_H, 12).fill(0xffffff);
    this.root.addChild(this.inner, mask);
    this.root.mask = mask;
  }

  private buildPlatforms(stage: Stage, theme: StageTheme): Graphics {
    const g = new Graphics();
    const pal = PLATFORM_PALETTES[theme];
    for (const p of stage.platforms) {
      if (p.soft) {
        g.rect(p.x, p.y, p.w, 14).fill(pal.softBody);
        g.rect(p.x, p.y, p.w, 4).fill(pal.softTop);
      } else {
        g.rect(p.x, p.y, p.w, SOLID_DEPTH).fill(pal.solidBody);
        g.rect(p.x, p.y, p.w, 8).fill(pal.solidTop);
      }
    }
    return g;
  }

  update(dt: number): void {
    this.t += dt;
    // fixed camera at the scene reference center = neutral parallax
    this.scene.update(dt, Math.floor(this.t * 60), SCENE_CX, SCENE_CY);
  }

  destroy(): void {
    this.scene.destroy();
    this.root.destroy({ children: true });
  }
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

interface MapCard {
  root: Container;
  frame: Graphics;
  mini: MiniScene;
  label: Text;
  info: StageInfo;
  hoverT: number;
}

type Difficulty = 1 | 2 | 3;

export class MapSelectScreen extends BaseScreen {
  private bg!: Graphics;
  private header!: Text;
  private subheader!: Text;

  private grid!: Container;
  private cards: MapCard[] = [];
  private focusIdx = 0;

  private detail!: Container;
  private dName!: Text;
  private dTagline!: Text;
  private dBlast!: Graphics;
  private dBlastLabel!: Text;
  private dHazard!: Text;
  private dMood!: Text;

  private diffButtons: UiButton[] = [];
  private difficulty: Difficulty = 2;
  private confirmBtn!: UiButton;
  private backBtn!: UiButton;

  private infos = Object.values(STAGE_INFO);
  private cardW = 300;
  private cardH = 172;

  constructor(ctx: UiContext) {
    super(ctx, "mapselect");
  }

  private get browsing(): boolean {
    return this.ctx.flow.browsing;
  }

  protected build(): void {
    this.focusIdx = 0;

    this.bg = new Graphics();
    this.root.addChild(this.bg);

    this.header = new Text({ text: "", style: serif(44, UI.gold) });
    this.subheader = new Text({ text: "", style: serif(17, UI.dim, "bold") });
    this.root.addChild(this.header, this.subheader);

    this.grid = new Container();
    this.root.addChild(this.grid);
    this.cards = this.infos.map((info, i) => this.buildCard(info, i));

    this.detail = new Container();
    this.root.addChild(this.detail);
    this.buildDetail();

    this.buildFooter();
    this.setDetail(0);
    this.updateHeader();

    this.on("keydown", (e) => this.onKey(e));
  }

  private buildCard(info: StageInfo, i: number): MapCard {
    const root = new Container();
    const frame = new Graphics();
    const mini = new MiniScene(info);
    const label = new Text({ text: info.name.toUpperCase(), style: serif(20, UI.parchment) });
    label.anchor.set(0.5, 1);
    root.addChild(mini.root, frame, label);
    root.eventMode = "static";
    root.cursor = "pointer";
    root.on("pointerover", () => {
      if (this.focusIdx !== i) this.ctx.audio.play("ui_move");
      this.focusIdx = i;
      this.setDetail(i);
    });
    root.on("pointertap", () => {
      this.focusIdx = i;
      this.setDetail(i);
      this.confirm();
    });
    this.grid.addChild(root);
    return { root, frame, mini, label, info, hoverT: 0 };
  }

  private buildDetail(): void {
    this.detail.addChild(panel(1, 1)); // placeholder replaced in layout
    this.dName = new Text({ text: "", style: serif(34, UI.gold) });
    this.dTagline = new Text({ text: "", style: serif(15, UI.parchment, "bold") });
    this.dTagline.style.wordWrap = true;
    this.dBlast = new Graphics();
    this.dBlastLabel = new Text({ text: "", style: mono(13, UI.dim, "bold") });
    this.dHazard = new Text({ text: "", style: mono(14, UI.ember, "bold") });
    this.dMood = new Text({ text: "", style: serif(17, UI.goldHot, "bold") });
    this.detail.addChild(this.dName, this.dTagline, this.dBlast, this.dBlastLabel, this.dHazard, this.dMood);
  }

  private buildFooter(): void {
    const labels: [string, Difficulty][] = [["EASY", 1], ["NORMAL", 2], ["HARD", 3]];
    this.diffButtons = labels.map(([label, d]) =>
      new UiButton(label, 20, () => {
        if (!this.active) return;
        this.difficulty = d;
        this.ctx.audio.play("ui_select");
      }, () => this.ctx.audio.play("ui_move")),
    );
    for (const b of this.diffButtons) this.root.addChild(b.root);

    this.confirmBtn = new UiButton("FIGHT  →", 28, () => {
      if (!this.active || this.browsing) return;
      this.ctx.audio.play("ui_select");
      this.confirm();
    }, () => this.ctx.audio.play("ui_move"));
    this.root.addChild(this.confirmBtn.root);

    this.backBtn = new UiButton("← BACK", 18, () => {
      if (!this.active) return;
      this.ctx.audio.play("ui_back");
      this.ctx.flow.go(this.browsing ? "menu" : "charselect");
    }, () => this.ctx.audio.play("ui_move"));
    this.root.addChild(this.backBtn.root);
  }

  private confirm(): void {
    if (this.browsing) return;
    const draft = this.ctx.flow.draft;
    if (!draft) { // reached mapselect without picking (shouldn't happen) — bounce back
      this.ctx.flow.go("charselect");
      return;
    }
    const stageId = this.infos[this.focusIdx].id;
    const config: MatchConfig = {
      mode: draft.mode,
      playerChar: draft.playerChar,
      allyChar: draft.allyChar,
      enemyChars: this.pickEnemies(draft.mode === "duo" ? 2 : 1, draft),
      stageId,
      difficulty: this.difficulty,
      seed: (Math.random() * 1e9) | 0,
    };
    this.ctx.flow.startMatch(config);
  }

  /** Random distinct opponents; a mirror is allowed but avoided when possible. */
  private pickEnemies(n: number, draft: { playerChar: CharId; allyChar: CharId | null }): CharId[] {
    const taken = new Set<CharId>([draft.playerChar]);
    if (draft.allyChar) taken.add(draft.allyChar);
    const pool = CHAR_IDS.filter((c) => !taken.has(c));
    const out: CharId[] = [];
    for (let i = 0; i < n; i++) {
      const src = pool.length ? pool : CHAR_IDS;
      const idx = (Math.random() * src.length) | 0;
      out.push(src[idx]);
      const at = pool.indexOf(src[idx]);
      if (at >= 0) pool.splice(at, 1);
    }
    return out;
  }

  private setDetail(i: number): void {
    const info = this.infos[i];
    const fl = FLAVOR[info.id];
    this.dName.text = info.name.toUpperCase();
    this.dTagline.text = info.tagline;
    this.dBlastLabel.text = `BLAST ZONE · ${fl.blastLabel.toUpperCase()}`;
    this.dHazard.text = `HAZARD · ${fl.hazard}`;
    this.dMood.text = `“${fl.mood}”`;
    this.drawBlastShape(info);
    this.layoutDetail();
  }

  private drawBlastShape(info: StageInfo): void {
    const stage = info.make();
    const b = stage.blast;
    const bw = b.right - b.left, bh = b.bottom - b.top;
    const boxW = 150, boxH = 90;
    const s = Math.min(boxW / bw, boxH / bh);
    const g = this.dBlast;
    g.clear();
    // outer = blast zone (KO boundary), inner = stage footprint
    const ow = bw * s, oh = bh * s;
    g.roundRect(-ow / 2, -oh / 2, ow, oh, 4).stroke({ color: UI.blood, width: 2, alpha: 0.8 });
    // stage footprint from solid platforms
    let l = Infinity, r = -Infinity, t = Infinity, bot = -Infinity;
    for (const p of stage.platforms) {
      if (p.soft) continue;
      l = Math.min(l, p.x); r = Math.max(r, p.x + p.w);
      t = Math.min(t, p.y); bot = Math.max(bot, p.y + 40);
    }
    const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
    g.roundRect((l - cx) * s, (t - cy) * s, (r - l) * s, Math.max(6, (bot - t) * s), 2)
      .fill({ color: UI.gold, alpha: 0.55 });
  }

  private updateHeader(): void {
    if (this.browsing) {
      this.header.text = "THE ARENAS";
      this.subheader.text = "hover to inspect  ·  ESC to return";
    } else {
      this.header.text = "CHOOSE THE GROUND";
      this.subheader.text = "each arena kills a different way";
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    const n = this.cards.length;
    let idx = this.focusIdx;
    switch (e.code) {
      case "ArrowLeft": case "KeyA": idx = (idx + n - 1) % n; break;
      case "ArrowRight": case "KeyD": idx = (idx + 1) % n; break;
      case "ArrowUp": case "KeyW": idx = (idx + n - 2) % n; break;
      case "ArrowDown": case "KeyS": idx = (idx + 2) % n; break;
      case "Digit1": case "Digit2": case "Digit3": {
        this.difficulty = Number(e.code.slice(5)) as Difficulty;
        this.ctx.audio.play("ui_select");
        return;
      }
      case "Enter": case "Space": this.confirm(); return;
      case "Escape":
        this.ctx.audio.play("ui_back");
        this.ctx.flow.go(this.browsing ? "menu" : "charselect");
        return;
      default: return;
    }
    if (idx !== this.focusIdx) {
      this.focusIdx = idx;
      this.ctx.audio.play("ui_move");
      this.setDetail(idx);
    }
  }

  // ---------- layout ----------
  private detailX = 0;
  private detailY = 0;
  private detailW = 380;

  protected layout(w: number, h: number): void {
    this.bg.clear().rect(0, 0, w, h).fill(0x0e0a16);

    const margin = Math.max(32, w * 0.04);
    this.header.position.set(margin, h * 0.05);
    this.header.style.fontSize = Math.max(30, Math.min(52, w * 0.032));
    this.subheader.position.set(margin + 4, h * 0.05 + this.header.height + 4);

    // 2x2 grid on the left ~58%
    const gridW = w * 0.56 - margin;
    const gap = 22;
    this.cardW = (gridW - gap) / 2;
    this.cardH = this.cardW * 0.58;
    const gridTop = h * 0.2;
    this.grid.position.set(margin, gridTop);
    this.cards.forEach((c, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      c.root.position.set(col * (this.cardW + gap), row * (this.cardH + gap + 16));
      // MiniScene has a fixed internal size; rescale its root to the live card size
      c.mini.root.scale.set(this.cardW / MINI_W, this.cardH / MINI_H);
      c.label.position.set(this.cardW / 2, this.cardH - 8);
    });

    // detail panel on the right
    this.detailW = w - (margin + w * 0.56) - margin + margin * 0.5;
    this.detailX = w * 0.6;
    this.detailY = h * 0.2;
    this.layoutDetail();

    // footer: difficulty left, fight right
    const footY = h - Math.max(50, h * 0.07);
    const diffLabel = margin + 4;
    this.diffButtons.forEach((b, i) => b.root.position.set(diffLabel + 80 + i * 118, footY));
    this.confirmBtn.root.position.set(this.detailX + this.detailW * 0.5, footY);
    // top-right, clear of the left-aligned header
    this.backBtn.root.position.set(w - margin - 40, h * 0.06);
  }

  private layoutDetail(): void {
    const x = this.detailX, y = this.detailY, w = this.detailW;
    const p = this.detail.getChildAt(0) as Graphics;
    p.clear();
    p.roundRect(0, 0, w, 300, 16).fill({ color: UI.ink, alpha: 0.85 });
    p.roundRect(0, 0, w, 300, 16).stroke({ color: UI.ember, width: 2, alpha: 0.45 });
    this.detail.position.set(x, y);

    this.dName.position.set(24, 22);
    this.dTagline.position.set(24, 74);
    this.dTagline.style.wordWrapWidth = w - 48;
    this.dBlast.position.set(w - 96, 150);
    this.dBlastLabel.anchor.set(0.5, 0);
    this.dBlastLabel.position.set(w - 96, 200);
    this.dHazard.position.set(24, 176);
    this.dMood.position.set(24, 232);
  }

  protected tick(dt: number): void {
    this.cards.forEach((c, i) => {
      c.mini.update(dt);
      const focused = i === this.focusIdx;
      c.hoverT += ((focused ? 1 : 0) - c.hoverT) * Math.min(1, dt * 12);
      const g = c.frame;
      g.clear();
      const edge = lerpColor(0x3a2a4e, UI.gold, c.hoverT);
      g.roundRect(0, 0, this.cardW, this.cardH, 12).stroke({ color: edge, width: 2 + c.hoverT * 2, alpha: 0.5 + c.hoverT * 0.5 });
      // darken unfocused thumbnails so the eye lands on the focused arena
      if (c.hoverT < 0.99) {
        g.roundRect(0, 0, this.cardW, this.cardH, 12).fill({ color: 0x0e0a16, alpha: 0.34 * (1 - c.hoverT) });
      }
      c.label.style.fill = lerpColor(UI.parchment, UI.gold, c.hoverT);
      c.root.scale.set(1 + c.hoverT * 0.03);
    });

    this.diffButtons.forEach((b, i) => {
      b.focused = this.difficulty === i + 1;
      b.update(dt);
    });
    this.confirmBtn.root.visible = !this.browsing;
    this.confirmBtn.update(dt);
    this.backBtn.update(dt);
  }
}
