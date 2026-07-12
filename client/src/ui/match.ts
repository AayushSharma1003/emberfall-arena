/**
 * Quick match vs bots. Owns a Sim + GameRenderer + BotControllers + a
 * MatchStatsTracker, and runs the same fixed-step loop as hotseat: fighter 0
 * is the human (keyboard/mouse/gamepad), the rest are bots gated by the
 * chosen difficulty. A 3-2-1 countdown opens; the first team left standing
 * ends it, and the tallied MatchResult is handed to the flow for the results
 * screen. The sim itself is never touched — bots feed it InputFrames exactly
 * like a human hand, so this is pure wiring around the locked combat core.
 */
import {
  BotController, botLevel, DT, MatchStatsTracker, STAGE_INFO,
  Sim, stageById, mvpScore,
  type CharId, type InputFrame,
} from "@emberfall/shared";
import { makeScene, PLATFORM_PALETTES } from "../scenes/index.js";
import {
  GameRenderer, projDraw,
  type DrawConstruct, type DrawFighter, type DrawWorld, type DrawZone,
} from "../render.js";
import { buildP1Input, makeP1Sources, p1Reticle, type P1Sources } from "../engine/localinput.js";
import { rosterOf, type MatchResult } from "./flow.js";
import { BaseScreen, type UiContext } from "./screens.js";

const COUNTDOWN_TICKS = 180; // 3s at 60Hz
const END_HOLD_S = 2.4; // linger on the KO banner before results

export class MatchScreen extends BaseScreen {
  private sim!: Sim;
  private renderer!: GameRenderer;
  private bots: (BotController | null)[] = [];
  private stats!: MatchStatsTracker;
  private src!: P1Sources;
  private humanId = 0;

  private prevPos: { x: number; y: number }[] = [];
  private accumulator = 0;
  private countdown = COUNTDOWN_TICKS;
  private crosshairVisible = true;

  private ended = false;
  private endTimer = 0;
  private result: MatchResult | null = null;

  constructor(ctx: UiContext) {
    super(ctx, "match");
  }

  protected build(): void {
    const cfg = this.ctx.flow.config;
    if (!cfg) { this.ctx.flow.go("menu"); return; }

    const picked = stageById(cfg.stageId);
    const stage = picked.make();
    this.sim = new Sim(stage);

    const roster = rosterOf(cfg);
    roster.forEach((r) => this.sim.addFighter(r.charId, r.team));
    // face fighters toward stage center at the whistle
    const cx = stage.spawns.reduce((s, sp) => s + sp.x, 0) / stage.spawns.length;
    this.sim.fighters.forEach((f) => (f.facing = f.x <= cx ? 1 : -1));

    this.renderer = new GameRenderer(this.ctx.app, stage);
    this.renderer.audio = this.ctx.audio;
    const theme = STAGE_INFO[picked.id].theme;
    this.renderer.platformPalette = PLATFORM_PALETTES[theme];
    this.renderer.scene = makeScene(theme, stage, { under: this.renderer.sceneUnder, over: this.renderer.sceneOver });
    this.renderer.setHelp("WASD move · mouse aim · LMB light · RMB heavy · F special · Q ultimate · Shift dash");

    const params = botLevel(cfg.difficulty);
    this.bots = roster.map((r, i) => (r.human ? null : new BotController(this.sim, i, params, cfg.seed + i * 131)));
    this.humanId = roster.findIndex((r) => r.human);
    this.stats = new MatchStatsTracker(roster.length);

    this.src = makeP1Sources(this.ctx.app.canvas);
    this.prevPos = this.sim.fighters.map((f) => ({ x: f.x, y: f.y }));
    this.accumulator = 0;
    this.countdown = COUNTDOWN_TICKS;
    this.ended = false;
    this.endTimer = 0;
    this.result = null;

    this.on("keydown", (e) => {
      if (e.code === "KeyC") this.crosshairVisible = !this.crosshairVisible;
      if (e.code === "KeyH") this.renderer.showHitboxes = !this.renderer.showHitboxes;
      if (e.code === "Escape" && this.active) this.ctx.flow.go("menu"); // bail out
    });
  }

  unmount(): void {
    this.renderer?.destroy();
    super.unmount();
  }

  private buildInputs(): InputFrame[] {
    const human = this.sim.fighters[this.humanId];
    return this.sim.fighters.map((f, i) => {
      if (i === this.humanId) {
        return buildP1Input(this.src, this.renderer, { x: human.x, y: human.y, h: human.stats.height });
      }
      return this.bots[i]?.tick() ?? { buttons: 0, aimX: f.facing, aimY: 0 };
    });
  }

  private aliveTeams(): Set<number> {
    return new Set(this.sim.fighters.filter((f) => f.stocks > 0).map((f) => f.team));
  }

  private finish(): void {
    const teams = this.aliveTeams();
    const winnerTeam = teams.size === 1 ? [...teams][0] : null;
    const cfg = this.ctx.flow.config!;
    this.result = {
      config: cfg,
      winnerTeam,
      tallies: this.stats.tallies.map((t) => ({ ...t })),
      mvp: this.pickMvp(),
    };
    const won = winnerTeam === this.sim.fighters[this.humanId].team;
    this.renderer.setBanner(winnerTeam === null ? "DRAW" : won ? "VICTORY" : "DEFEAT", "");
    this.ctx.audio.play("match_win");
    this.ended = true;
    this.endTimer = END_HOLD_S;
  }

  /** MVP among the winning side if there is one, else overall top score. */
  private pickMvp(): number {
    const teams = this.aliveTeams();
    const pool = teams.size === 1
      ? this.sim.fighters.filter((f) => f.team === [...teams][0]).map((f) => f.id)
      : this.sim.fighters.map((f) => f.id);
    let best = pool[0];
    for (const id of pool) {
      if (mvpScore(this.stats.tallies[id]) > mvpScore(this.stats.tallies[best])) best = id;
    }
    return best;
  }

  protected layout(_w: number, _h: number): void {
    // GameRenderer positions its own HUD/banner against app.screen each draw.
  }

  protected tick(dt: number): void {
    if (!this.sim || !this.renderer) return;
    const frameDt = Math.min(dt, 0.1);
    this.accumulator += frameDt;

    while (this.accumulator >= DT) {
      for (let i = 0; i < this.sim.fighters.length; i++) {
        this.prevPos[i].x = this.sim.fighters[i].x;
        this.prevPos[i].y = this.sim.fighters[i].y;
      }
      if (this.countdown > 0) {
        // let fighters fall in and settle, but no one acts yet
        this.sim.step(this.sim.fighters.map(() => ({ buttons: 0, aimX: 0, aimY: 0 })));
        this.countdown--;
        if (this.countdown === 0) this.renderer.setBanner("");
      } else if (!this.ended) {
        const events = this.sim.step(this.buildInputs());
        this.stats.consume(events, this.sim.fighters.map((f) => f.damage));
        this.renderer.handleEvents(events);
        if (this.aliveTeams().size <= 1) this.finish();
      }
      this.accumulator -= DT;
    }

    if (this.ended && this.active) {
      this.endTimer -= frameDt;
      if (this.endTimer <= 0 && this.result) this.ctx.flow.finishMatch(this.result);
    }

    this.drawWorld(frameDt);
    this.updateCountdownBanner();
  }

  private updateCountdownBanner(): void {
    if (this.ended || this.countdown <= 0) return;
    const secs = Math.ceil(this.countdown / 60);
    this.renderer.setBanner(secs > 0 ? String(secs) : "FIGHT", "");
  }

  private drawWorld(frameDt: number): void {
    const alpha = this.accumulator / DT;
    const ownerChar = (id: number): CharId => this.sim.fighters[id]?.charId ?? "knight";

    const fighters: DrawFighter[] = this.sim.fighters.map((f, i) => ({
      f,
      rx: this.prevPos[i].x + (f.x - this.prevPos[i].x) * alpha,
      ry: this.prevPos[i].y + (f.y - this.prevPos[i].y) * alpha,
    }));

    const world: DrawWorld = {
      fighters,
      projs: this.sim.projectiles.map((p) => projDraw(p, ownerChar)),
      constructs: this.sim.constructs.map((c): DrawConstruct => ({
        x: c.x, y: c.y, kindId: c.def.kindId, facing: c.facing,
        hpT: Math.max(0, c.hp / c.def.hp), owner: c.owner,
      })),
      zones: this.sim.zones.map((z): DrawZone => ({ x: z.x, y: z.y, radius: z.radius, owner: z.owner })),
      items: this.sim.items,
      tick: this.sim.tick,
    };

    const reticle = p1Reticle(this.src, this.renderer, this.crosshairVisible && this.countdown <= 0 && !this.ended);
    this.renderer.draw(world, frameDt, reticle, this.sim.hitstop > 0);
  }
}
