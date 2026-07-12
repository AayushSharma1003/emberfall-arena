/**
 * Screen flow: the typed state machine behind the whole UI, plus the host
 * that mounts/unmounts screen views around a fade. Pure logic — no Pixi
 * imports — so transition legality, payload handoff, teardown ordering and
 * fade timing are all testable headlessly. Each screen implements
 * ScreenView; the Pixi side reads `host.overlayAlpha` to draw the fade.
 */
import type { CharId } from "@emberfall/shared";
import type { FighterTally } from "@emberfall/shared";

export type ScreenId = "menu" | "charselect" | "mapselect" | "loading" | "match" | "results";

/** solo = 1v1 vs one bot; duo = 2v2, human + bot ally vs two bots. */
export type MatchMode = "solo" | "duo";

export interface MatchConfig {
  mode: MatchMode;
  playerChar: CharId;
  /** duo only; null in solo. */
  allyChar: CharId | null;
  /** 1 (solo) or 2 (duo) opponents. */
  enemyChars: CharId[];
  stageId: string;
  /** Maps straight onto botLevel(). */
  difficulty: 1 | 2 | 3;
  /** Seeds the bots so a rematch is a different fight only if this changes. */
  seed: number;
}

/** Fighter slot order for a config: player first, then ally, then enemies interleave teams 0,1,0,1. */
export function rosterOf(cfg: MatchConfig): { charId: CharId; team: number; human: boolean }[] {
  if (cfg.mode === "solo") {
    return [
      { charId: cfg.playerChar, team: 0, human: true },
      { charId: cfg.enemyChars[0], team: 1, human: false },
    ];
  }
  return [
    { charId: cfg.playerChar, team: 0, human: true },
    { charId: cfg.enemyChars[0], team: 1, human: false },
    { charId: cfg.allyChar ?? cfg.playerChar, team: 0, human: false },
    { charId: cfg.enemyChars[1] ?? cfg.enemyChars[0], team: 1, human: false },
  ];
}

export interface MatchResult {
  config: MatchConfig;
  /** 0 = player's team won, 1 = enemies, null = draw. */
  winnerTeam: number | null;
  tallies: FighterTally[];
  mvp: number;
}

const LEGAL: Record<ScreenId, readonly ScreenId[]> = {
  menu: ["charselect", "mapselect"],
  charselect: ["mapselect", "menu"],
  mapselect: ["loading", "charselect", "menu"],
  loading: ["match"],
  match: ["results", "menu"],
  results: ["loading", "menu"],
};

export class ScreenFlow {
  screen: ScreenId = "menu";
  /** Set by startMatch; kept through rematch. */
  config: MatchConfig | null = null;
  result: MatchResult | null = null;
  /** True when charselect/mapselect were opened from the menu just to browse. */
  browsing = false;
  private listeners: ((to: ScreenId) => void)[] = [];

  onChange(cb: (to: ScreenId) => void): void {
    this.listeners.push(cb);
  }

  go(to: ScreenId): void {
    if (!LEGAL[this.screen].includes(to)) {
      throw new Error(`illegal screen transition ${this.screen} -> ${to}`);
    }
    this.screen = to;
    for (const cb of this.listeners) cb(to);
  }

  startMatch(config: MatchConfig): void {
    this.config = config;
    this.result = null;
    this.go("loading");
  }

  finishMatch(result: MatchResult): void {
    this.result = result;
    this.go("results");
  }

  /** Same teams, same map, new seed — straight back into loading. */
  rematch(): void {
    if (!this.config) throw new Error("rematch without a previous match");
    this.config = { ...this.config, seed: this.config.seed + 1 };
    this.result = null;
    this.go("loading");
  }
}

// ---------------------------------------------------------------------------
// screen host: mount/unmount around a fade
// ---------------------------------------------------------------------------

export interface ScreenView {
  /** Build containers and attach to the stage. */
  mount(): void;
  /** Destroy every container this screen created. Must be idempotent-safe to call once. */
  unmount(): void;
  /** Per-frame while this screen is current (keeps animating through fades). */
  update(dt: number): void;
}

export const FADE_OUT_S = 0.26;
export const FADE_IN_S = 0.38;

type FadePhase = "idle" | "out" | "in";

/**
 * Drives exactly one mounted view at a time. On a flow change it fades to
 * black, swaps (unmount old -> mount new) at full black, and fades back in.
 * Changing target mid-fade retargets without double-mounting.
 */
export class ScreenHost {
  overlayAlpha = 0;
  private mounted: ScreenId | null = null;
  private target: ScreenId | null = null;
  private phase: FadePhase = "idle";

  constructor(
    private views: Record<ScreenId, ScreenView>,
    private flow: ScreenFlow,
  ) {
    flow.onChange((to) => this.request(to));
  }

  /** First mount, no fade (the app just booted; there's nothing to fade from). */
  boot(): void {
    this.mounted = this.flow.screen;
    this.views[this.mounted].mount();
  }

  get current(): ScreenId | null {
    return this.mounted;
  }

  private request(to: ScreenId): void {
    if (to === this.mounted && this.phase === "idle") return;
    this.target = to;
    if (this.phase !== "out") this.phase = "out"; // retarget mid-"in" restarts the out leg from current alpha
  }

  update(dt: number): void {
    if (this.phase === "out") {
      this.overlayAlpha = Math.min(1, this.overlayAlpha + dt / FADE_OUT_S);
      if (this.overlayAlpha >= 1 && this.target !== null) {
        if (this.mounted !== null) this.views[this.mounted].unmount();
        this.mounted = this.target;
        this.target = null;
        this.views[this.mounted].mount();
        this.phase = "in";
      }
    } else if (this.phase === "in") {
      this.overlayAlpha = Math.max(0, this.overlayAlpha - dt / FADE_IN_S);
      if (this.overlayAlpha <= 0) this.phase = "idle";
    }
    if (this.mounted !== null) this.views[this.mounted].update(dt);
  }
}
