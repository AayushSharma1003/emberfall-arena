/**
 * Interim screens while the real ones land one commit at a time. Each keeps
 * the flow navigable: selects go back to the menu on ESC/click, loading
 * auto-advances into the match, match fakes a result so results/rematch
 * wiring can be exercised. Every one of these dies in a later commit.
 */
import { Graphics, Text } from "pixi.js";
import type { ScreenId } from "./flow.js";
import { BaseScreen, serif, UI, type UiContext } from "./screens.js";

export class PlaceholderScreen extends BaseScreen {
  private title!: Text;
  private hint!: Text;
  private bg!: Graphics;
  private age = 0;

  constructor(
    ctx: UiContext,
    id: ScreenId,
    private titleText: string,
    /** Where ESC / click goes; null = no manual exit. */
    private backTo: ScreenId | null,
    /** Auto-advance target + delay (loading -> match). */
    private auto?: { to: ScreenId; afterS: number },
  ) {
    super(ctx, id);
  }

  protected build(): void {
    this.age = 0;
    this.bg = new Graphics();
    this.root.addChild(this.bg);
    this.title = new Text({ text: this.titleText, style: serif(52, UI.gold) });
    this.title.anchor.set(0.5);
    this.hint = new Text({
      text: this.backTo ? "under construction  ·  ESC to go back" : "…",
      style: serif(18, UI.dim, "bold"),
    });
    this.hint.anchor.set(0.5);
    this.root.addChild(this.title, this.hint);
    if (this.backTo) {
      this.on("keydown", (e) => {
        if (e.code === "Escape" && this.active) this.ctx.flow.go(this.backTo!);
      });
    }
  }

  protected layout(w: number, h: number): void {
    this.bg.clear().rect(0, 0, w, h).fill(0x14101c);
    this.title.position.set(w / 2, h * 0.42);
    this.hint.position.set(w / 2, h * 0.42 + 64);
  }

  protected tick(dt: number): void {
    this.age += dt;
    this.title.alpha = 0.8 + 0.2 * Math.sin(this.age * 3);
    if (this.auto && this.age >= this.auto.afterS && this.active) {
      this.ctx.flow.go(this.auto.to);
    }
  }
}
