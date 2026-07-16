/**
 * Online screen: the create-or-join fork. HOST GAME mints a client-side
 * room code (the server confirms uniqueness); JOIN GAME is a six-slot
 * painterly code input. Every failure shows inline with its own copy —
 * this screen never falls back to the fullscreen ERROR page — and a slow
 * dial is called out honestly as the Render free tier waking up.
 *
 * Deep links land here too: /?room=CODE prefills JOIN and auto-attempts,
 * /?room=CODE&host=1 hosts with that exact code (flow.onlineIntent).
 */
import { Container, Graphics, Text } from "pixi.js";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LEN, normalizeRoomCode } from "@emberfall/shared";
import { skyRect } from "../scenes/scene.js";
import {
  BaseScreen, EmberEmitter, mono, panel, serif, UI, UiButton, type UiContext,
} from "./screens.js";

const DEFAULT_CHAR = "knight";

type Act = { kind: "host"; code?: string } | { kind: "join"; code: string };

export class OnlineScreen extends BaseScreen {
  private bg!: Graphics;
  private sky!: Graphics;
  private embers!: EmberEmitter;

  private header!: Text;
  private subheader!: Text;

  private hostBtn!: UiButton;
  private hostBlurb!: Text;
  private joinLabel!: Text;
  private slots!: Container;
  private slotBoxes: Graphics[] = [];
  private slotChars: Text[] = [];
  private joinBtn!: UiButton;
  private backBtn!: UiButton;

  private statusPanel!: Container;
  private statusMain!: Text;
  private statusSub!: Text;
  private wakeBar!: Graphics;
  private retryBtn!: UiButton;
  private cancelBtn!: UiButton;

  private errText!: Text;

  private code = "";
  private lastAct: Act | null = null;
  private t = 0;

  constructor(ctx: UiContext) {
    super(ctx, "online");
  }

  protected build(): void {
    this.t = 0;
    this.code = "";
    this.lastAct = null;

    this.bg = new Graphics();
    this.root.addChild(this.bg);
    this.sky = skyRect(0, 0, 4, 4, [
      [0, "#120c1c"], [0.55, "#1c1226"], [0.85, "#33182a"], [1, "#4a2230"],
    ]);
    this.root.addChild(this.sky);
    this.embers = new EmberEmitter({
      x0: 0, x1: 100, y0: 0, y1: 100, rate: 7,
      vx: [-8, 10], vy: [-18, -46], life: [2.5, 5], size: [1.5, 3.2],
      colors: [UI.ember, UI.gold, 0xb85a7a], cap: 46,
    });
    this.root.addChild(this.embers.node);

    this.header = new Text({ text: "PLAY ONLINE", style: serif(44, UI.gold) });
    this.subheader = new Text({ text: "one friend, one code, one arena", style: serif(17, UI.dim, "bold") });
    this.root.addChild(this.header, this.subheader);

    // ---- host path ----
    this.hostBtn = new UiButton("HOST GAME", 34, () => this.act({ kind: "host" }), () => this.ctx.audio.play("ui_move"));
    this.hostBlurb = new Text({ text: "start a room, send the invite link", style: serif(16, UI.dim, "bold") });
    this.hostBlurb.anchor.set(0.5, 0);
    this.root.addChild(this.hostBtn.root, this.hostBlurb);

    // ---- join path ----
    this.joinLabel = new Text({ text: "— or join with a code —", style: serif(18, UI.parchment, "bold") });
    this.joinLabel.anchor.set(0.5, 0);
    this.root.addChild(this.joinLabel);

    this.slots = new Container();
    this.root.addChild(this.slots);
    this.slotBoxes = [];
    this.slotChars = [];
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      const box = new Graphics();
      const ch = new Text({ text: "", style: mono(42, UI.goldHot, "900") });
      ch.anchor.set(0.5);
      this.slots.addChild(box, ch);
      this.slotBoxes.push(box);
      this.slotChars.push(ch);
    }
    this.slots.eventMode = "static";
    this.slots.cursor = "text";
    this.slots.on("pointertap", () => void this.pasteFromClipboard());

    this.joinBtn = new UiButton("JOIN GAME", 26, () => this.act({ kind: "join", code: this.code }), () => this.ctx.audio.play("ui_move"));
    this.root.addChild(this.joinBtn.root);

    this.errText = new Text({ text: "", style: serif(17, UI.blood, "bold") });
    this.errText.anchor.set(0.5, 0);
    this.root.addChild(this.errText);

    this.backBtn = new UiButton("← BACK", 18, () => this.goBack(), () => this.ctx.audio.play("ui_move"));
    this.root.addChild(this.backBtn.root);

    // ---- connecting / waking status overlay ----
    this.statusPanel = new Container();
    const p = panel(560, 240);
    p.pivot.set(280, 120);
    this.statusPanel.addChild(p);
    this.statusMain = new Text({ text: "", style: serif(28, UI.gold) });
    this.statusMain.anchor.set(0.5);
    this.statusMain.position.set(0, -50);
    this.statusSub = new Text({ text: "", style: serif(16, UI.parchment, "bold") });
    this.statusSub.anchor.set(0.5);
    this.statusSub.position.set(0, -10);
    this.wakeBar = new Graphics();
    this.wakeBar.position.set(-200, 30);
    this.retryBtn = new UiButton("RETRY", 22, () => { if (this.lastAct) this.act(this.lastAct); }, () => this.ctx.audio.play("ui_move"));
    this.retryBtn.root.position.set(0, 70);
    this.cancelBtn = new UiButton("CANCEL", 16, () => this.cancelPending(), () => this.ctx.audio.play("ui_move"));
    this.cancelBtn.root.position.set(0, 82);
    this.statusPanel.addChild(this.statusMain, this.statusSub, this.wakeBar, this.retryBtn.root, this.cancelBtn.root);
    this.statusPanel.visible = false;
    this.root.addChild(this.statusPanel);

    this.on("keydown", (e) => this.onKey(e));
    this.on("paste", (e) => {
      const text = (e as ClipboardEvent).clipboardData?.getData("text") ?? "";
      if (text) this.enterCodeText(text);
    });

    // deep link: consume the intent exactly once
    const intent = this.ctx.flow.onlineIntent;
    if (intent) {
      this.ctx.flow.onlineIntent = null;
      this.enterCodeText(intent.code);
      if (intent.host) this.act({ kind: "host", code: intent.code });
      else if (this.code.length === ROOM_CODE_LEN) this.act({ kind: "join", code: this.code });
      else this.errText.text = "That invite link looks broken — codes are 6 letters and digits.";
    }
  }

  // ---------- actions ----------

  private get busy(): boolean {
    const ph = this.ctx.online.phase;
    return ph === "connecting" || ph === "reconnecting";
  }

  private act(a: Act): void {
    if (!this.active || this.busy) return;
    this.ctx.online.acknowledgeFailure();
    this.errText.text = "";
    if (a.kind === "join" && a.code.length < ROOM_CODE_LEN) {
      this.errText.text = "Enter the full 6-character code.";
      return;
    }
    this.ctx.audio.play("ui_select");
    this.lastAct = a;
    if (a.kind === "host") this.ctx.online.hostGame(DEFAULT_CHAR, a.code);
    else this.ctx.online.joinGame(a.code, DEFAULT_CHAR);
  }

  private cancelPending(): void {
    this.ctx.audio.play("ui_back");
    this.ctx.online.leave(); // closes the dialing socket, back to idle
  }

  private goBack(): void {
    if (!this.active) return;
    this.ctx.audio.play("ui_back");
    if (this.busy) this.ctx.online.leave();
    this.ctx.online.acknowledgeFailure();
    this.ctx.flow.go("menu");
  }

  private enterCodeText(text: string): void {
    const clean = [...normalizeRoomCode(text)].filter((c) => ROOM_CODE_ALPHABET.includes(c));
    this.code = (this.code + clean.join("")).slice(0, ROOM_CODE_LEN);
    this.errText.text = "";
    this.ctx.online.acknowledgeFailure(); // editing the code dismisses a stale failure
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        this.code = "";
        this.enterCodeText(text);
      }
    } catch { /* no permission — typing still works */ }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active || this.busy) {
      if (e.code === "Escape" && this.busy) this.cancelPending();
      return;
    }
    if (e.code === "Escape") { this.goBack(); return; }
    if (e.code === "Backspace") {
      this.code = this.code.slice(0, -1);
      this.errText.text = "";
      return;
    }
    if (e.code === "Enter") {
      if (this.code.length > 0) this.act({ kind: "join", code: this.code });
      else this.act({ kind: "host" });
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) this.enterCodeText(e.key);
  }

  // ---------- layout ----------

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
    this.backBtn.root.position.set(margin + 46, h * 0.045 + this.header.height / 2 + 90);

    const cx = w / 2;
    this.hostBtn.root.position.set(cx, h * 0.32);
    this.hostBlurb.position.set(cx, h * 0.32 + 40);

    this.joinLabel.position.set(cx, h * 0.47);

    const slotW = Math.min(72, w * 0.05);
    const gap = slotW * 0.24;
    const totalW = ROOM_CODE_LEN * slotW + (ROOM_CODE_LEN - 1) * gap;
    this.slots.position.set(cx - totalW / 2, h * 0.55);
    this.slotBoxes.forEach((box, i) => {
      const x = i * (slotW + gap);
      box.position.set(x, 0);
      this.slotChars[i].position.set(x + slotW / 2, slotW * 0.62);
      this.slotChars[i].style.fontSize = slotW * 0.62;
    });
    this.slotH = slotW * 1.24;
    this.slotW = slotW;

    this.joinBtn.root.position.set(cx, h * 0.55 + this.slotH + 56);
    this.errText.position.set(cx, h * 0.55 + this.slotH + 92);

    this.statusPanel.position.set(cx, h * 0.5);
  }

  private slotW = 64;
  private slotH = 80;

  // ---------- tick ----------

  protected tick(dt: number, _w: number, _h: number): void {
    this.t += dt;
    this.embers.update(dt);

    const s = this.ctx.online;

    // success → lobby (guard active so a mid-fade double-fire can't happen)
    if (this.active && (s.phase === "lobby" || s.phase === "playing")) {
      this.ctx.flow.go("onlinelobby");
      return;
    }

    // session-level failure shows inline, with copy per error code
    if (s.phase === "failed" && s.error && this.errText.text !== s.error.message) {
      this.errText.text = s.error.message;
    }

    // code slots
    this.slotBoxes.forEach((box, i) => {
      const filled = i < this.code.length;
      const isCaret = i === this.code.length;
      const pulse = isCaret ? 0.35 + 0.3 * Math.sin(this.t * 5) : 0;
      box.clear();
      box.roundRect(0, 0, this.slotW, this.slotH, 10).fill({ color: UI.ink, alpha: 0.82 });
      box.roundRect(0, 0, this.slotW, this.slotH, 10)
        .stroke({ color: filled ? UI.gold : UI.ember, width: 2, alpha: filled ? 0.85 : 0.35 + pulse });
      if (isCaret) {
        box.rect(this.slotW * 0.25, this.slotH * 0.78, this.slotW * 0.5, 3)
          .fill({ color: UI.gold, alpha: 0.4 + pulse });
      }
      this.slotChars[i].text = this.code[i] ?? "";
    });

    // status overlay: dialing / waking / unreachable-with-retry
    const showRetry = s.phase === "failed" && s.error !== null &&
      (s.error.code === "unreachable" || s.error.code === "server_full") && this.lastAct !== null;
    this.statusPanel.visible = this.busy || showRetry;
    if (this.busy) {
      if (s.slowConnect) {
        this.statusMain.text = "WAKING UP THE SERVER";
        this.statusSub.text = "free hosting sleeps when idle — first join takes 30–50 seconds";
        const t = (this.t % 2.4) / 2.4;
        this.wakeBar.clear();
        this.wakeBar.roundRect(0, 0, 400, 8, 4).fill({ color: 0x241c38 });
        this.wakeBar.roundRect(Math.max(0, t * 400 - 90), 0, Math.min(90, 400 - Math.max(0, t * 400 - 90)), 8, 4)
          .fill({ color: UI.ember, alpha: 0.9 });
      } else {
        this.statusMain.text = "CONNECTING…";
        this.statusSub.text = this.lastAct?.kind === "host" ? "raising your arena" : "finding the room";
        this.wakeBar.clear();
      }
      this.retryBtn.root.visible = false;
      this.cancelBtn.root.visible = true;
    } else if (showRetry) {
      this.statusMain.text = "SERVER UNREACHABLE";
      this.statusSub.text = s.error?.message ?? "";
      this.wakeBar.clear();
      this.retryBtn.root.visible = true;
      this.cancelBtn.root.visible = false;
    }

    for (const b of [this.hostBtn, this.joinBtn, this.backBtn, this.retryBtn, this.cancelBtn]) b.update(dt);
  }
}
