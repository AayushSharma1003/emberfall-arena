/**
 * Main menu: the Emberfall Keep vista living behind an animated title and
 * a serif nav column. The vista is the SAME KeepScene the match uses —
 * mounted under a slow-panning fake camera so the parallax breathes.
 * Settings is a stub overlay (volume + fullscreen) per the phase plan.
 */
import { Container, Graphics, Text } from "pixi.js";
import { emberfallKeep } from "@emberfall/shared";
import { KeepScene } from "../scenes/keep.js";
import { SCENE_CX, SCENE_CY } from "../scenes/scene.js";
import { glowGradient } from "../paint/parts.js";
import {
  BaseScreen, EmberEmitter, panel, serif, UI, UiButton, type UiContext,
} from "./screens.js";

const VOLUME_KEY = "ef_volume";

export class MenuScreen extends BaseScreen {
  private vista!: Container;
  private scene!: KeepScene;
  private vignette!: Graphics;

  private titleGroup!: Container;
  private titleGlow!: Graphics;
  private title!: Text;
  private fringeR!: Text;
  private fringeB!: Text;
  private subtitle!: Text;
  private embers!: EmberEmitter;

  private nav!: Container;
  private buttons: UiButton[] = [];
  private focusIdx = 0;

  private settings!: Container;
  private settingsOpen = false;
  private volume = 0.8;
  private volFill!: Graphics;
  private fsCheck!: Graphics;

  private toast!: Text;
  private toastLife = 0;

  private t = Math.random() * 20;

  constructor(ctx: UiContext) {
    super(ctx, "menu");
  }

  protected build(): void {
    // ---- vista ----
    this.vista = new Container();
    const under = new Container();
    const over = new Container();
    this.vista.addChild(under, over);
    this.scene = new KeepScene(emberfallKeep(), { under, over });
    this.root.addChild(this.vista);

    // vignette so the type always sits on quiet values
    this.vignette = new Graphics();
    this.root.addChild(this.vignette);

    // ---- title ----
    this.titleGroup = new Container();
    this.titleGlow = new Graphics();
    this.titleGlow.circle(0, 0, 420).fill(glowGradient(0xffb35a, 0xd6431f, 420, 0.28, 0));
    this.titleGlow.scale.y = 0.42;
    this.fringeR = new Text({ text: "EMBERFALL", style: serif(96, 0xff5a3a) });
    this.fringeB = new Text({ text: "EMBERFALL", style: serif(96, 0x5a9dd6) });
    this.title = new Text({ text: "EMBERFALL", style: serif(96, UI.gold) });
    for (const t of [this.fringeR, this.fringeB, this.title]) t.anchor.set(0.5);
    this.fringeR.alpha = 0.3;
    this.fringeB.alpha = 0.3;
    this.subtitle = new Text({ text: "II  ·  THE ARENA", style: serif(30, UI.parchment, "bold") });
    this.subtitle.anchor.set(0.5);
    this.embers = new EmberEmitter({
      x0: -300, x1: 300, y0: -30, y1: 30, rate: 9,
      vx: [-9, 9], vy: [-34, -70], life: [1.2, 2.6], size: [1.5, 3.4],
      colors: [UI.gold, UI.ember, 0xffb35a], cap: 42,
    });
    this.titleGroup.addChild(this.titleGlow, this.fringeR, this.fringeB, this.title, this.subtitle, this.embers.node);
    this.root.addChild(this.titleGroup);

    // ---- nav ----
    this.nav = new Container();
    const items: [string, () => void][] = [
      ["PLAY", () => this.play()],
      ["PLAY ONLINE", () => this.playOnline()],
      ["CHARACTERS", () => this.browse("charselect")],
      ["MAPS", () => this.browse("mapselect")],
      ["SETTINGS", () => this.toggleSettings(true)],
      ["QUIT", () => this.quit()],
    ];
    this.buttons = items.map(([label, act]) =>
      new UiButton(label, 34, () => {
        if (!this.active || this.settingsOpen) return;
        this.ctx.audio.play("ui_select");
        act();
      }, () => this.ctx.audio.play("ui_move")),
    );
    this.buttons.forEach((b, i) => {
      b.root.on("pointerover", () => (this.focusIdx = i));
      this.nav.addChild(b.root);
    });
    this.root.addChild(this.nav);

    // ---- settings stub ----
    this.volume = Number(localStorage.getItem(VOLUME_KEY) ?? 0.8);
    this.settings = this.buildSettings();
    this.settings.visible = false;
    this.root.addChild(this.settings);

    // ---- toast ----
    this.toast = new Text({ text: "", style: serif(20, UI.parchment, "bold") });
    this.toast.anchor.set(0.5);
    this.toast.alpha = 0;
    this.root.addChild(this.toast);

    this.on("keydown", (e) => this.onKey(e));
  }

  // ---------- actions ----------
  private play(): void {
    this.ctx.flow.browsing = false;
    this.ctx.flow.onlinePick = false;
    this.ctx.flow.go("charselect");
  }

  private playOnline(): void {
    this.ctx.flow.browsing = false;
    this.ctx.flow.onlinePick = false;
    this.ctx.flow.go("online");
  }

  private browse(to: "charselect" | "mapselect"): void {
    this.ctx.flow.browsing = true;
    this.ctx.flow.onlinePick = false;
    this.ctx.flow.go(to);
  }

  private quit(): void {
    window.close();
    // browsers won't close a tab a script didn't open — say so gracefully
    setTimeout(() => this.showToast("The embers keep burning — close the tab to leave."), 120);
  }

  private showToast(msg: string): void {
    this.toast.text = msg;
    this.toastLife = 3;
  }

  private toggleSettings(openIt: boolean): void {
    this.settingsOpen = openIt;
    this.settings.visible = openIt;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    if (this.settingsOpen) {
      if (e.code === "Escape") {
        this.ctx.audio.play("ui_back");
        this.toggleSettings(false);
      }
      return;
    }
    switch (e.code) {
      case "ArrowUp": case "KeyW":
        this.focusIdx = (this.focusIdx + this.buttons.length - 1) % this.buttons.length;
        this.ctx.audio.play("ui_move");
        break;
      case "ArrowDown": case "KeyS":
        this.focusIdx = (this.focusIdx + 1) % this.buttons.length;
        this.ctx.audio.play("ui_move");
        break;
      case "Enter": case "Space":
        this.buttons[this.focusIdx].pick();
        break;
      default:
        break;
    }
  }

  // ---------- settings panel ----------
  private buildSettings(): Container {
    const c = new Container();
    const dim = new Graphics();
    dim.rect(-4000, -3000, 8000, 6000).fill({ color: UI.night, alpha: 0.6 });
    dim.eventMode = "static";
    dim.on("pointertap", () => this.toggleSettings(false));
    c.addChild(dim);

    const PW = 460, PH = 300;
    const p = new Container();
    p.addChild(panel(PW, PH));
    const title = new Text({ text: "SETTINGS", style: serif(30, UI.gold) });
    title.anchor.set(0.5, 0);
    title.position.set(PW / 2, 26);
    p.addChild(title);

    // volume row
    const volLabel = new Text({ text: "Volume", style: serif(20, UI.parchment, "bold") });
    volLabel.position.set(48, 108);
    p.addChild(volLabel);
    const barX = 200, barW = 210, barY = 118;
    const volBg = new Graphics();
    volBg.roundRect(barX, barY - 5, barW, 10, 5).fill(0x241c38);
    p.addChild(volBg);
    this.volFill = new Graphics();
    p.addChild(this.volFill);
    const hit = new Graphics();
    hit.rect(barX - 8, barY - 16, barW + 16, 32).fill({ color: 0xffffff, alpha: 0.0001 });
    hit.eventMode = "static";
    hit.cursor = "pointer";
    const setVol = (globalX: number): void => {
      const local = hit.toLocal({ x: globalX, y: 0 }).x;
      this.volume = Math.max(0, Math.min(1, (local - barX) / barW));
      localStorage.setItem(VOLUME_KEY, this.volume.toFixed(2));
      this.drawVolume(barX, barY, barW);
    };
    let dragging = false;
    hit.on("pointerdown", (e) => { dragging = true; setVol(e.globalX); });
    hit.on("globalpointermove", (e) => { if (dragging) setVol(e.globalX); });
    hit.on("pointerup", () => (dragging = false));
    hit.on("pointerupoutside", () => (dragging = false));
    p.addChild(hit);
    this.drawVolume(barX, barY, barW);

    // fullscreen row
    const fsLabel = new Text({ text: "Fullscreen", style: serif(20, UI.parchment, "bold") });
    fsLabel.position.set(48, 168);
    p.addChild(fsLabel);
    this.fsCheck = new Graphics();
    this.fsCheck.position.set(barX, 168);
    this.fsCheck.eventMode = "static";
    this.fsCheck.cursor = "pointer";
    this.fsCheck.on("pointertap", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
      setTimeout(() => this.drawFsCheck(), 150);
    });
    this.drawFsCheck();
    p.addChild(this.fsCheck);

    const hint = new Text({ text: "ESC to close  ·  more to come", style: serif(15, UI.faint, "bold") });
    hint.anchor.set(0.5, 0);
    hint.position.set(PW / 2, PH - 44);
    p.addChild(hint);

    p.pivot.set(PW / 2, PH / 2);
    c.addChild(p);
    (c as Container & { panelNode?: Container }).panelNode = p;
    return c;
  }

  private drawVolume(x: number, y: number, w: number): void {
    this.volFill.clear();
    this.volFill.roundRect(x, y - 5, w * this.volume, 10, 5).fill(UI.ember);
    this.volFill.circle(x + w * this.volume, y, 9).fill(UI.gold);
  }

  private drawFsCheck(): void {
    const on = !!document.fullscreenElement;
    this.fsCheck.clear();
    this.fsCheck.roundRect(0, 0, 26, 26, 6).stroke({ color: UI.gold, width: 2, alpha: 0.8 });
    if (on) this.fsCheck.roundRect(5, 5, 16, 16, 4).fill(UI.ember);
    else this.fsCheck.roundRect(0, 0, 26, 26, 6).fill({ color: 0xffffff, alpha: 0.0001 });
  }

  // ---------- layout / tick ----------
  protected layout(w: number, h: number): void {
    this.vignette.clear();
    // top + bottom fades and corner darkening keep the eye centered
    this.vignette.rect(0, 0, w, h * 0.34).fill({ color: UI.night, alpha: 0.28 });
    this.vignette.rect(0, h * 0.62, w, h * 0.38).fill({ color: UI.night, alpha: 0.34 });
    this.vignette.rect(0, 0, w, h).fill({ color: 0x14101c, alpha: 0.12 });

    const titleSize = Math.max(56, Math.min(150, w * 0.088));
    for (const t of [this.title, this.fringeR, this.fringeB]) t.style.fontSize = titleSize;
    this.subtitle.style.fontSize = Math.max(18, titleSize * 0.3);
    this.titleGroup.position.set(w / 2, h * 0.26);
    this.subtitle.position.set(0, titleSize * 0.72);
    this.embers.spec.x0 = -this.title.width / 2;
    this.embers.spec.x1 = this.title.width / 2;
    this.embers.spec.y0 = -titleSize * 0.4;
    this.embers.spec.y1 = titleSize * 0.3;

    this.nav.position.set(w / 2, h * 0.56);
    const gap = Math.min(64, h * 0.074);
    this.buttons.forEach((b, i) => b.root.position.set(0, i * gap));

    const sp = (this.settings as Container & { panelNode?: Container }).panelNode;
    sp?.position.set(w / 2, h / 2);

    this.toast.position.set(w / 2, h - 60);
  }

  protected tick(dt: number, w: number, h: number): void {
    this.t += dt;

    // slow-panning fake camera over the vista — zoomed well out so the keep
    // reads as scenery under the dusk sky, not a wall of dark values
    const scale = Math.max(w / 3100, h / 1750) * 1.05;
    const camX = SCENE_CX + Math.sin(this.t * 0.07) * 240;
    const camY = SCENE_CY + 30 + Math.cos(this.t * 0.045) * 34;
    this.vista.scale.set(scale);
    this.vista.position.set(w / 2 - camX * scale, h / 2 - camY * scale);
    this.scene.update(dt, Math.floor(this.t * 60), camX, camY);

    // title life: glow pulse, ember rise, fringe drift
    const pulse = 0.85 + 0.15 * Math.sin(this.t * 1.6);
    this.titleGlow.alpha = pulse;
    this.title.scale.set(1 + 0.008 * Math.sin(this.t * 1.6));
    const fr = 2.6 + Math.sin(this.t * 0.9) * 1.4;
    this.fringeR.position.set(-fr, Math.sin(this.t * 1.3) * 1.2);
    this.fringeB.position.set(fr, -Math.sin(this.t * 1.3) * 1.2);
    this.embers.update(dt);

    // nav focus follows keyboard; buttons ease their own hover state
    this.buttons.forEach((b, i) => {
      b.focused = i === this.focusIdx;
      b.update(dt);
    });

    if (this.toastLife > 0) {
      this.toastLife -= dt;
      this.toast.alpha = Math.min(1, this.toastLife / 0.5);
    }
  }
}
