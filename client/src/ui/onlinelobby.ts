/**
 * Online lobby: the room code in large painterly type, a one-click invite
 * link, both fighters' picks as live rig puppets, ready toggles, and an
 * ember "waiting for opponent…" state so an empty room never feels dead.
 * Character changes reuse the offline CharSelectScreen (flow.onlinePick).
 */
import { Container, Graphics, Text } from "pixi.js";
import { CHARACTERS, type PlayerInfo } from "@emberfall/shared";
import { skyRect } from "../scenes/scene.js";
import { RigPuppet } from "./charselect.js";
import {
  BaseScreen, EmberEmitter, lerpColor, mono, serif, UI, UiButton, type UiContext,
} from "./screens.js";

const SLOTS = 2; // 1v1 MVP; the server supports 4 — expand after this ships

interface SlotView {
  root: Container;
  frame: Graphics;
  name: Text;
  charName: Text;
  status: Text;
  puppet: RigPuppet | null;
  puppetChar: string | null;
  waitEmbers: EmberEmitter;
  waitText: Text;
}

export class OnlineLobbyScreen extends BaseScreen {
  private bg!: Graphics;
  private sky!: Graphics;
  private header!: Text;
  private codeText!: Text;
  private codeGlow!: Graphics;

  private copyBtn!: UiButton;
  private changeBtn!: UiButton;
  private readyBtn!: UiButton;
  private leaveBtn!: UiButton;
  private hintText!: Text;
  private toast!: Text;
  private toastLife = 0;

  private slots: SlotView[] = [];
  private banner!: Text;
  private bannerSub!: Text;

  private t = 0;

  constructor(ctx: UiContext) {
    super(ctx, "onlinelobby");
  }

  protected build(): void {
    this.t = 0;

    this.bg = new Graphics();
    this.root.addChild(this.bg);
    this.sky = skyRect(0, 0, 4, 4, [
      [0, "#120c1c"], [0.55, "#1c1226"], [0.85, "#33182a"], [1, "#4a2230"],
    ]);
    this.root.addChild(this.sky);

    this.header = new Text({ text: "THE GATHERING", style: serif(34, UI.gold) });
    this.header.anchor.set(0.5, 0);
    this.codeGlow = new Graphics();
    this.codeText = new Text({ text: "", style: serif(72, UI.goldHot) });
    this.codeText.anchor.set(0.5, 0);
    this.root.addChild(this.header, this.codeGlow, this.codeText);

    this.copyBtn = new UiButton("COPY INVITE LINK", 20, () => void this.copyInvite(), () => this.ctx.audio.play("ui_move"));
    this.changeBtn = new UiButton("CHANGE FIGHTER", 20, () => this.changeFighter(), () => this.ctx.audio.play("ui_move"));
    this.readyBtn = new UiButton("READY UP", 26, () => this.toggleReady(), () => this.ctx.audio.play("ui_move"));
    this.leaveBtn = new UiButton("← LEAVE", 18, () => this.leaveLobby(), () => this.ctx.audio.play("ui_move"));
    this.root.addChild(this.copyBtn.root, this.changeBtn.root, this.readyBtn.root, this.leaveBtn.root);

    this.hintText = new Text({ text: "SPACE ready · ENTER change fighter · ESC leave", style: serif(14, UI.faint, "bold") });
    this.hintText.anchor.set(0.5, 0);
    this.root.addChild(this.hintText);

    this.toast = new Text({ text: "", style: serif(18, UI.parchment, "bold") });
    this.toast.anchor.set(0.5);
    this.toast.alpha = 0;
    this.root.addChild(this.toast);

    this.slots = [];
    for (let i = 0; i < SLOTS; i++) this.slots.push(this.buildSlot());

    this.banner = new Text({ text: "", style: serif(30, UI.gold) });
    this.banner.anchor.set(0.5);
    this.bannerSub = new Text({ text: "", style: serif(16, UI.parchment, "bold") });
    this.bannerSub.anchor.set(0.5);
    this.root.addChild(this.banner, this.bannerSub);

    this.on("keydown", (e) => this.onKey(e));
  }

  private buildSlot(): SlotView {
    const root = new Container();
    const frame = new Graphics();
    const name = new Text({ text: "", style: serif(24, UI.parchment) });
    name.anchor.set(0.5, 0);
    const charName = new Text({ text: "", style: serif(17, UI.dim, "bold") });
    charName.anchor.set(0.5, 0);
    const status = new Text({ text: "", style: mono(15, UI.gold, "900") });
    status.anchor.set(0.5, 0);
    const waitText = new Text({ text: "waiting for opponent…", style: serif(19, UI.dim, "bold") });
    waitText.anchor.set(0.5);
    const waitEmbers = new EmberEmitter({
      x0: -80, x1: 80, y0: 40, y1: 90, rate: 12,
      vx: [-10, 10], vy: [-26, -60], life: [1.4, 3], size: [1.4, 3.2],
      colors: [UI.ember, UI.gold, 0xffb35a], cap: 40,
    });
    root.addChild(frame, waitEmbers.node, waitText, name, charName, status);
    this.root.addChild(root);
    return { root, frame, name, charName, status, puppet: null, puppetChar: null, waitEmbers, waitText };
  }

  // ---------- actions ----------

  private async copyInvite(): Promise<void> {
    if (!this.active) return;
    this.ctx.audio.play("ui_select");
    const url = `${location.origin}/?room=${this.ctx.online.roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      this.showToast("Invite link copied — send it to a friend");
    } catch {
      this.showToast(`Copy failed — share this: ${url}`);
    }
  }

  private changeFighter(): void {
    if (!this.active) return;
    this.ctx.audio.play("ui_select");
    this.ctx.flow.browsing = false;
    this.ctx.flow.onlinePick = true;
    this.ctx.flow.go("charselect");
  }

  private toggleReady(): void {
    if (!this.active) return;
    this.ctx.audio.play("ui_select");
    const me = this.ctx.online.me;
    this.ctx.online.setReady(!(me?.ready ?? false));
  }

  private leaveLobby(): void {
    if (!this.active) return;
    this.ctx.audio.play("ui_back");
    this.ctx.online.leave();
    this.ctx.flow.go("menu");
  }

  private showToast(msg: string): void {
    this.toast.text = msg;
    this.toastLife = 3;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    if (e.code === "Escape") this.leaveLobby();
    if (e.code === "Space") { e.preventDefault(); this.toggleReady(); }
    if (e.code === "Enter") this.changeFighter();
  }

  // ---------- layout ----------

  private slotW = 360;
  private slotH = 380;

  protected layout(w: number, h: number): void {
    this.bg.clear().rect(0, 0, w, h).fill(0x120c1c);
    this.sky.position.set(w / 2, h / 2);
    this.sky.scale.set(w / 2, h / 2);

    const cx = w / 2;
    this.header.position.set(cx, h * 0.05);
    this.codeText.style.fontSize = Math.max(48, Math.min(88, w * 0.055));
    this.codeText.position.set(cx, h * 0.105);
    this.copyBtn.root.position.set(cx, h * 0.105 + this.codeText.height + 34);

    this.slotW = Math.min(400, w * 0.3);
    this.slotH = Math.min(400, h * 0.42);
    const gap = Math.max(60, w * 0.06);
    this.slots.forEach((s, i) => {
      s.root.position.set(cx + (i === 0 ? -1 : 1) * (this.slotW / 2 + gap / 2), h * 0.52);
      s.name.position.set(0, -this.slotH / 2 + 18);
      s.charName.position.set(0, -this.slotH / 2 + 52);
      s.status.position.set(0, this.slotH / 2 - 40);
      s.waitText.position.set(0, 0);
    });

    const footY = h - Math.max(54, h * 0.075);
    this.changeBtn.root.position.set(cx - 170, footY);
    this.readyBtn.root.position.set(cx + 170, footY);
    this.leaveBtn.root.position.set(Math.max(80, w * 0.06), h * 0.06);
    this.hintText.position.set(cx, footY + 28);
    this.toast.position.set(cx, footY - 52);

    this.banner.position.set(cx, h * 0.45);
    this.bannerSub.position.set(cx, h * 0.45 + 34);
  }

  // ---------- tick ----------

  protected tick(dt: number, _w: number, _h: number): void {
    this.t += dt;
    const s = this.ctx.online;

    if (this.active && s.phase === "playing") {
      this.ctx.flow.go("onlinematch");
      return;
    }
    if (this.active && (s.phase === "idle" || s.phase === "failed")) {
      // the session died under us (server restart with no match to resume, kick, …)
      if (s.phase === "failed") {
        this.ctx.flow.onlineIntent = null;
        this.ctx.flow.go("online"); // its inline error copy takes over
      } else {
        this.ctx.flow.go("menu");
      }
      return;
    }

    this.codeText.text = s.roomCode;
    this.codeGlow.clear();
    if (s.roomCode) {
      const pulse = 0.1 + 0.05 * Math.sin(this.t * 1.8);
      this.codeGlow.ellipse(this.codeText.x, this.codeText.y + this.codeText.height / 2, this.codeText.width * 0.75, 46)
        .fill({ color: UI.ember, alpha: pulse });
    }

    // reconnecting banner rides over everything
    const reconnecting = s.phase === "reconnecting";
    this.banner.text = reconnecting ? "RECONNECTING…" : "";
    this.bannerSub.text = reconnecting
      ? (s.serverRestarting ? "the server is restarting — hang tight" : `attempt ${s.reconnectAttempt} — hang tight`)
      : "";

    const players = s.players;
    for (let i = 0; i < SLOTS; i++) {
      this.drawSlot(this.slots[i], players[i], players[i]?.id === s.myId, dt);
    }

    const me = s.me;
    this.readyBtn.label.text = me?.ready ? "UNREADY" : "READY UP";
    const bothIn = players.filter((p) => p.connected).length >= 2;
    this.hintText.text = bothIn
      ? "match starts when both fighters are ready"
      : "SPACE ready · ENTER change fighter · ESC leave";

    if (this.toastLife > 0) {
      this.toastLife -= dt;
      this.toast.alpha = Math.min(1, this.toastLife / 0.5);
    }

    for (const b of [this.copyBtn, this.changeBtn, this.readyBtn, this.leaveBtn]) b.update(dt);
  }

  private drawSlot(slot: SlotView, p: PlayerInfo | undefined, isMe: boolean, dt: number): void {
    const g = slot.frame;
    const w = this.slotW, h = this.slotH;
    g.clear();
    g.roundRect(-w / 2, -h / 2, w, h, 16).fill({ color: UI.ink, alpha: 0.8 });

    if (!p) {
      // empty seat: dashed-feel ember frame + rising embers
      g.roundRect(-w / 2, -h / 2, w, h, 16).stroke({ color: UI.ember, width: 2, alpha: 0.22 + 0.1 * Math.sin(this.t * 2.2) });
      slot.name.text = "";
      slot.charName.text = "";
      slot.status.text = "";
      slot.waitText.visible = true;
      slot.waitEmbers.update(dt);
      if (slot.puppet) { slot.puppet.destroy(); slot.puppet = null; slot.puppetChar = null; }
      return;
    }

    const char = CHARACTERS[p.charId];
    const edge = p.ready ? UI.gold : lerpColor(0x3a2a4e, char.color, 0.6);
    g.roundRect(-w / 2, -h / 2, w, h, 16).stroke({ color: edge, width: p.ready ? 3 : 2, alpha: p.connected ? 0.85 : 0.3 });
    g.ellipse(0, h * 0.27, w * 0.3, 12).fill({ color: char.color, alpha: p.connected ? 0.2 : 0.06 });

    slot.waitText.visible = false;
    slot.name.text = `${isMe ? "▶ " : ""}${p.name}`;
    slot.name.style.fill = p.connected ? UI.parchment : UI.faint;
    slot.charName.text = `${char.name.toUpperCase()} — ${char.epithet}`;
    slot.status.text = !p.connected ? "· CONNECTION LOST ·" : p.ready ? "· READY ·" : "· CHOOSING ·";
    slot.status.style.fill = !p.connected ? UI.blood : p.ready ? UI.gold : UI.dim;

    // live puppet matches the current pick
    if (slot.puppetChar !== p.charId) {
      slot.puppet?.destroy();
      slot.puppet = new RigPuppet(p.charId, true);
      slot.puppetChar = p.charId;
      const scale = (h * 0.42) / char.stats.height;
      slot.puppet.node.scale.set(scale);
      slot.puppet.node.position.set(0, h * 0.27);
      slot.puppet.fx.scale.set(scale);
      slot.puppet.fx.position.set(0, h * 0.27);
      slot.root.addChild(slot.puppet.fx, slot.puppet.node);
    }
    slot.root.alpha = p.connected ? 1 : 0.55;
    slot.puppet?.update(dt);
  }
}
