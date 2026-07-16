/**
 * Online match as a flow screen: server-authoritative sim with client
 * prediction + reconciliation for the local fighter and snapshot
 * interpolation for remotes — the loop that used to live in main.ts's
 * onlineMode, now wired to the shared OnlineSession so the lobby, the
 * reconnect banner and the match all speak through one socket.
 *
 * Mid-match resilience: an unexpected drop or a serverRestart notice puts
 * the session into "reconnecting" (exponential backoff); a successful
 * reattach re-sends `begin`, which shows up here as a beginGen bump and a
 * predictor rebuild. A failed window ends the match with honest copy.
 */
import {
  CHARACTERS, DT, INPUT_BATCH, INTERP_DELAY_TICKS, STAGE_INFO,
  Interpolator, Predictor, applyFighterSnap, makeFighter, stageById,
  type CharId, type Fighter, type PlayerInfo, type SimEvent, type Stage, type TickInput,
} from "@emberfall/shared";
import { makeScene, PLATFORM_PALETTES } from "../scenes/index.js";
import { buildP1Input, makeP1Sources, p1Reticle, type P1Sources } from "../engine/localinput.js";
import {
  GameRenderer, projDraw,
  type DrawConstruct, type DrawFighter, type DrawItem, type DrawProj, type DrawWorld, type DrawZone,
} from "../render.js";
import type { SnapshotMsg } from "../online/session.js";
import { BaseScreen, type UiContext } from "./screens.js";

const FAIL_HOLD_S = 3.2; // linger on "match ended" before returning to the menu

/** Movement/action events for the local player — predicted, played instantly. */
function ownMovementEvent(e: SimEvent, myId: number): boolean {
  switch (e.t) {
    case "jump":
    case "dash":
    case "land":
    case "shoot":
      return e.id === myId;
    default:
      return false; // hits/KOs/respawns/items wait for the server's word
  }
}

export class OnlineMatchScreen extends BaseScreen {
  private renderer: GameRenderer | null = null;
  private stageObj: Stage | null = null;
  private predictor: Predictor | null = null;
  private interp = new Interpolator();
  private displayFighters: Fighter[] = [];
  private src!: P1Sources;

  private lastBeginGen = -1;
  private renderTick = -1;
  private outbox: TickInput[] = [];
  private sinceSend = 0;
  private smoothX = 0;
  private smoothY = 0;
  private accumulator = 0;
  private prevX = 0;
  private prevY = 0;
  private crosshairVisible = true;
  private failTimer = 0;

  constructor(ctx: UiContext) {
    super(ctx, "onlinematch");
  }

  protected build(): void {
    const s = this.ctx.online;
    if (!s.begin) {
      this.ctx.flow.go("menu");
      return;
    }
    this.src = makeP1Sources(this.ctx.app.canvas);
    this.failTimer = 0;
    this.lastBeginGen = -1; // forces setup on the first tick
    this.interp = new Interpolator();

    s.onSnapshot = (m) => this.applySnapshot(m);
    for (const m of s.drainSnapshots()) this.applySnapshot(m);

    this.on("keydown", (e) => {
      if (e.code === "KeyC") this.crosshairVisible = !this.crosshairVisible;
      if (e.code === "KeyH" && this.renderer) this.renderer.showHitboxes = !this.renderer.showHitboxes;
      if (e.code === "Escape" && this.active) this.leaveMatch();
    });
  }

  unmount(): void {
    this.ctx.online.onSnapshot = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.predictor = null;
    super.unmount();
  }

  private leaveMatch(): void {
    this.ctx.audio.play("ui_back");
    this.ctx.online.leave();
    this.ctx.flow.go("menu");
  }

  /** (Re)build stage, renderer and predictor from the session's current begin. */
  private setupFromBegin(): void {
    const s = this.ctx.online;
    const begin = s.begin!;
    const picked = stageById(s.stageId);
    this.stageObj = picked.make();

    if (!this.renderer) {
      this.renderer = new GameRenderer(this.ctx.app, this.stageObj);
      this.renderer.audio = this.ctx.audio;
      const theme = STAGE_INFO[picked.id].theme;
      this.renderer.platformPalette = PLATFORM_PALETTES[theme];
      this.renderer.scene = makeScene(theme, this.stageObj, { under: this.renderer.sceneUnder, over: this.renderer.sceneOver });
      this.renderer.setHelp("ONLINE · WASD move · mouse aim · LMB light · RMB heavy · F special · Q ultimate · Shift dash");
    }

    const roster = begin.players.map((p: PlayerInfo) => ({ charId: p.charId, team: p.team }));
    this.predictor = new Predictor(this.stageObj, roster, s.myId, begin.tick, 6);
    this.displayFighters = begin.players.map((p: PlayerInfo, i: number) =>
      makeFighter(i, this.stageObj!.spawns[i % this.stageObj!.spawns.length], CHARACTERS[p.charId], p.team));
    this.renderTick = begin.tick;
    this.outbox = [];
    this.sinceSend = 0;
    this.smoothX = 0;
    this.smoothY = 0;
    this.accumulator = 0;
    this.renderer.setBanner("");
    this.lastBeginGen = s.beginGen;
  }

  private applySnapshot(m: SnapshotMsg): void {
    const s = this.ctx.online;
    if (!this.predictor) return;
    const meBefore = this.predictor.sim.fighters[s.myId];
    if (!meBefore) return;
    const bx = meBefore.x, by = meBefore.y;
    this.predictor.applySnapshot(m.snap, m.lastInput);
    const meAfter = this.predictor.sim.fighters[s.myId];
    this.smoothX += bx - meAfter.x;
    this.smoothY += by - meAfter.y;
    if (Math.hypot(this.smoothX, this.smoothY) > 220) { this.smoothX = 0; this.smoothY = 0; } // too big to smooth: snap
    this.interp.push(m.snap);
    this.renderer?.handleEvents(m.events.filter((e: SimEvent) => !ownMovementEvent(e, s.myId)));
  }

  protected layout(_w: number, _h: number): void {
    // GameRenderer positions its own HUD/banner against app.screen each draw.
  }

  protected tick(dt: number, _w: number, _h: number): void {
    const s = this.ctx.online;

    // terminal failure: honest copy, brief hold, back to the menu
    if (s.phase === "failed" || s.phase === "idle") {
      this.renderer?.setBanner("MATCH ENDED", s.error?.message ?? "connection lost");
      this.failTimer += dt;
      if (this.failTimer >= FAIL_HOLD_S && this.active) {
        s.acknowledgeFailure();
        this.ctx.flow.go("menu");
      }
      return;
    }

    if (s.beginGen !== this.lastBeginGen && s.begin) this.setupFromBegin();
    const predictor = this.predictor;
    const renderer = this.renderer;
    if (!predictor || !renderer) return;
    const me = predictor.sim.fighters[s.myId];
    if (!me) return;

    const frameDt = Math.min(dt, 0.1);
    const playing = s.phase === "playing" && s.winners === null;

    this.accumulator += frameDt;
    while (this.accumulator >= DT) {
      this.prevX = me.x;
      this.prevY = me.y;
      const input = playing
        ? buildP1Input(this.src, renderer, { x: me.x + this.smoothX, y: me.y + this.smoothY, h: me.stats.height })
        : { buttons: 0, aimX: 0, aimY: 0 };
      const { events, toSend } = predictor.step(input);
      this.outbox.push(toSend);
      if (this.outbox.length > 6) this.outbox = this.outbox.slice(-6);
      if (++this.sinceSend >= INPUT_BATCH) {
        if (playing) s.sendInputs(this.outbox.slice(-3)); // 1 new + 2 redundant vs loss
        this.sinceSend = 0;
      }
      renderer.handleEvents(events.filter((e) => ownMovementEvent(e, s.myId)));
      this.accumulator -= DT;
    }
    const alpha = this.accumulator / DT;

    const decay = Math.exp(-12 * frameDt);
    this.smoothX *= decay;
    this.smoothY *= decay;

    const targetTick = this.interp.latestTick() - INTERP_DELAY_TICKS;
    if (this.renderTick < 0) this.renderTick = targetTick;
    this.renderTick += frameDt * 60;
    this.renderTick += (targetTick - this.renderTick) * Math.min(1, frameDt * 2);

    const sample = this.interp.sample(this.renderTick);
    const items: DrawFighter[] = [];
    const projs: DrawProj[] = [];
    const ownerChar = (id: number): CharId => predictor.sim.fighters[id]?.charId ?? "knight";
    for (let i = 0; i < predictor.sim.fighters.length; i++) {
      if (i === s.myId) {
        items.push({
          f: me,
          rx: this.prevX + (me.x - this.prevX) * alpha + this.smoothX,
          ry: this.prevY + (me.y - this.prevY) * alpha + this.smoothY,
        });
      } else {
        const df = this.displayFighters[i];
        const snap = sample?.fighters.find((f) => f.id === i);
        if (snap) applyFighterSnap(df, snap); // full state: hitbox overlay works on remotes too
        items.push({ f: df, rx: df.x, ry: df.y });
      }
    }
    for (const p of predictor.sim.projectiles) {
      if (p.owner === s.myId) projs.push(projDraw(p, ownerChar));
    }
    for (const p of sample?.projectiles ?? []) {
      if (p.owner !== s.myId) projs.push(projDraw(p, ownerChar));
    }
    const constructsSrc = sample?.constructs ?? predictor.sim.constructs;
    const zonesSrc = sample?.zones ?? predictor.sim.zones;
    const worldItems: DrawItem[] = sample?.items ?? predictor.sim.items;
    const world: DrawWorld = {
      fighters: items,
      projs,
      constructs: constructsSrc.map((c): DrawConstruct => ({
        x: c.x, y: c.y, kindId: c.def.kindId, facing: c.facing,
        hpT: Math.max(0, c.hp / c.def.hp), owner: c.owner,
      })),
      zones: zonesSrc.map((z): DrawZone => ({ x: z.x, y: z.y, radius: z.radius, owner: z.owner })),
      items: worldItems,
      tick: Math.max(0, Math.round(this.renderTick)),
    };

    this.updateBanner();
    renderer.draw(world, frameDt, p1Reticle(this.src, renderer, this.crosshairVisible && playing), predictor.sim.hitstop > 0);
  }

  private updateBanner(): void {
    const s = this.ctx.online;
    const renderer = this.renderer;
    if (!renderer) return;

    if (s.winners !== null) {
      const text = s.winners.includes(s.myId) ? "VICTORY" : s.winners.length ? "DEFEAT" : "DRAW";
      renderer.setBanner(text, "ESC to return to the menu");
      return;
    }
    if (s.phase === "reconnecting") {
      renderer.setBanner(
        "RECONNECTING…",
        s.serverRestarting ? "the server restarted — trying to resume the match" : `attempt ${s.reconnectAttempt} — hang tight`,
      );
      return;
    }
    const gone = s.players.find((p) => !p.connected);
    if (gone) {
      renderer.setBanner("OPPONENT DISCONNECTED", "waiting for them to return…");
      return;
    }
    renderer.setBanner("");
  }
}
