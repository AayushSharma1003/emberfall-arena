/**
 * Post-match results. Reads the MatchResult the match handed the flow and
 * lays out a per-fighter panel (KOs, damage dealt, damage taken) with an
 * idle rig portrait, an MVP crown on the top scorer, and the winning team
 * gilded. Rematch (same teams + map, reseeded) or back to the menu.
 */
import { Container, Graphics, Text } from "pixi.js";
import { CHARACTERS, type CharId, type FighterTally } from "@emberfall/shared";
import { FighterRig } from "../paint/rig.js";
import { TEAM_COLORS } from "../render.js";
import { rosterOf } from "./flow.js";
import {
  BaseScreen, EmberEmitter, mono, serif, UI, UiButton, type UiContext,
} from "./screens.js";

interface FighterPanel {
  root: Container;
  rig: FighterRig;
  charId: CharId;
  team: number;
  tally: FighterTally;
  isMvp: boolean;
  isWinner: boolean;
  t: number;
}

export class ResultsScreen extends BaseScreen {
  private bg!: Graphics;
  private embers!: EmberEmitter;
  private title!: Text;
  private subtitle!: Text;
  private panels: FighterPanel[] = [];
  private panelRow!: Container;
  private rematchBtn!: UiButton;
  private menuBtn!: UiButton;
  private focusIdx = 0;
  private t = 0;

  constructor(ctx: UiContext) {
    super(ctx, "results");
  }

  protected build(): void {
    const result = this.ctx.flow.result;
    if (!result) { this.ctx.flow.go("menu"); return; }
    this.t = 0;
    this.focusIdx = 0;

    this.bg = new Graphics();
    this.root.addChild(this.bg);
    this.embers = new EmberEmitter({
      x0: 0, x1: 100, y0: 0, y1: 100, rate: 8,
      vx: [-8, 10], vy: [-20, -52], life: [2.4, 5], size: [1.5, 3.4],
      colors: [UI.ember, UI.gold, 0xb85a7a], cap: 48,
    });
    this.root.addChild(this.embers.node);

    const won = result.winnerTeam === rosterOf(result.config)[0].team;
    const headline = result.winnerTeam === null ? "DRAW" : won ? "VICTORY" : "DEFEAT";
    this.title = new Text({ text: headline, style: serif(76, headline === "DEFEAT" ? UI.parchment : UI.gold) });
    this.title.anchor.set(0.5);
    this.subtitle = new Text({
      text: result.winnerTeam === null ? "both fires guttered out" : won ? "the Keep still stands" : "the embers claim you",
      style: serif(20, UI.dim, "bold"),
    });
    this.subtitle.anchor.set(0.5);
    this.root.addChild(this.title, this.subtitle);

    // fighter panels
    this.panelRow = new Container();
    this.root.addChild(this.panelRow);
    const roster = rosterOf(result.config);
    this.panels = roster.map((r, i) => this.buildPanel(r.charId, r.team, result.tallies[i], i === result.mvp, r.team === result.winnerTeam));

    // buttons
    this.rematchBtn = new UiButton("REMATCH", 30, () => {
      if (!this.active) return;
      this.ctx.audio.play("ui_select");
      this.ctx.flow.rematch();
    }, () => this.ctx.audio.play("ui_move"));
    this.menuBtn = new UiButton("BACK TO MENU", 24, () => {
      if (!this.active) return;
      this.ctx.audio.play("ui_back");
      this.ctx.flow.go("menu");
    }, () => this.ctx.audio.play("ui_move"));
    this.root.addChild(this.rematchBtn.root, this.menuBtn.root);

    this.on("keydown", (e) => this.onKey(e));
  }

  private buildPanel(charId: CharId, team: number, tally: FighterTally, isMvp: boolean, isWinner: boolean): FighterPanel {
    const root = new Container();
    const rig = new FighterRig(charId, CHARACTERS[charId].stats);
    root.addChild(rig.root);
    this.panelRow.addChild(root);
    return { root, rig, charId, team, tally, isMvp, isWinner, t: 0 };
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    switch (e.code) {
      case "ArrowLeft": case "ArrowRight": case "KeyA": case "KeyD":
        this.focusIdx ^= 1;
        this.ctx.audio.play("ui_move");
        break;
      case "Enter": case "Space":
        (this.focusIdx === 0 ? this.rematchBtn : this.menuBtn).pick();
        break;
      case "Escape":
        this.ctx.audio.play("ui_back");
        this.ctx.flow.go("menu");
        break;
      default: break;
    }
  }

  // ---------- layout ----------
  private PW = 210;
  private PH = 300;

  protected layout(w: number, h: number): void {
    this.bg.clear();
    this.bg.rect(0, 0, w, h).fill(0x0c0916);
    this.bg.rect(0, 0, w, h).fill({ color: UI.blood, alpha: 0.04 });
    this.embers.spec.x0 = 0; this.embers.spec.x1 = w;
    this.embers.spec.y0 = h * 0.5; this.embers.spec.y1 = h + 20;

    this.title.style.fontSize = Math.max(48, Math.min(84, w * 0.06));
    this.title.position.set(w / 2, h * 0.15);
    this.subtitle.position.set(w / 2, h * 0.15 + this.title.height * 0.62);

    const n = this.panels.length;
    this.PW = Math.min(230, (w * 0.82) / n - 20);
    this.PH = Math.min(320, h * 0.46);
    const gap = 22;
    const totalW = n * this.PW + (n - 1) * gap;
    this.panelRow.position.set(w / 2 - totalW / 2, h * 0.3);
    this.panels.forEach((p, i) => {
      p.root.position.set(i * (this.PW + gap), 0);
      const scale = (this.PH * 0.34) / CHARACTERS[p.charId].stats.height;
      p.rig.root.scale.set(scale);
      p.rig.root.position.set(this.PW / 2, this.PH * 0.5);
    });

    const btnY = h * 0.9;
    this.rematchBtn.root.position.set(w / 2 - 150, btnY);
    this.menuBtn.root.position.set(w / 2 + 150, btnY);
  }

  protected tick(dt: number): void {
    this.t += dt;
    this.embers.update(dt);

    this.panels.forEach((p) => {
      p.t += dt;
      // idle rig puppet
      p.rig.update({
        state: "idle", facing: 1, vx: 0, vy: 0, grounded: true,
        aimX: 1, aimY: 0, attack: null, charging: false, chargeT: 0,
        burning: false, damage: 0, ultReady: false,
      }, dt);
      this.paintPanel(p);
    });

    this.rematchBtn.focused = this.focusIdx === 0;
    this.menuBtn.focused = this.focusIdx === 1;
    this.rematchBtn.update(dt);
    this.menuBtn.update(dt);
  }

  /** One reusable chrome Graphics per panel, drawn behind the rig. */
  private paintPanel(p: FighterPanel): void {
    let chrome = (p.root as Container & { chrome?: Graphics; labels?: Container }).chrome;
    if (!chrome) {
      chrome = new Graphics();
      p.root.addChildAt(chrome, 0);
      (p.root as Container & { chrome?: Graphics }).chrome = chrome;
      this.buildPanelLabels(p);
    }
    const teamCol = TEAM_COLORS[p.team % TEAM_COLORS.length];
    chrome.clear();
    chrome.roundRect(0, 0, this.PW, this.PH, 14).fill({ color: UI.ink, alpha: 0.82 });
    if (p.isWinner) {
      const glow = 0.5 + 0.5 * Math.sin(this.t * 3);
      chrome.roundRect(0, 0, this.PW, this.PH, 14).stroke({ color: UI.gold, width: 3, alpha: 0.5 + glow * 0.4 });
    } else {
      chrome.roundRect(0, 0, this.PW, this.PH, 14).stroke({ color: 0x3a2a4e, width: 2, alpha: 0.7 });
    }
    // team stripe + character-color floor glow under the rig
    chrome.roundRect(0, 0, this.PW, 8, 4).fill(teamCol);
    chrome.ellipse(this.PW / 2, this.PH * 0.62, this.PW * 0.3, 12).fill({ color: CHARACTERS[p.charId].color, alpha: 0.2 });
    // MVP crown
    if (p.isMvp) {
      const cx = this.PW / 2, cy = 22 + Math.sin(this.t * 2.5) * 2;
      chrome.poly([cx - 20, cy + 10, cx - 20, cy - 8, cx - 10, cy + 2, cx, cy - 12, cx + 10, cy + 2, cx + 20, cy - 8, cx + 20, cy + 10])
        .fill(UI.gold);
    }
  }

  private buildPanelLabels(p: FighterPanel): void {
    const labels = new Container();
    const name = new Text({ text: CHARACTERS[p.charId].name.toUpperCase(), style: serif(20, UI.parchment) });
    name.anchor.set(0.5, 0);
    name.position.set(this.PW / 2, this.PH * 0.68);
    labels.addChild(name);
    if (p.isMvp) {
      const mvp = new Text({ text: "MVP", style: mono(13, UI.gold, "900") });
      mvp.anchor.set(0.5, 0);
      mvp.position.set(this.PW / 2, this.PH * 0.68 + 24);
      labels.addChild(mvp);
    }
    const rows: [string, string, number][] = [
      ["KOs", String(p.tally.kos), UI.gold],
      ["DEALT", `${Math.round(p.tally.damageDealt)}%`, UI.ember],
      ["TAKEN", `${Math.round(p.tally.damageTaken)}%`, UI.dim],
    ];
    rows.forEach(([label, value, color], i) => {
      const y = this.PH * 0.78 + i * 22;
      const l = new Text({ text: label, style: mono(13, UI.faint, "bold") });
      l.position.set(this.PW * 0.16, y);
      const v = new Text({ text: value, style: mono(15, color, "900") });
      v.anchor.set(1, 0);
      v.position.set(this.PW * 0.84, y);
      labels.addChild(l, v);
    });
    p.root.addChild(labels);
  }
}
