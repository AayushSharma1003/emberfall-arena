/**
 * Dynamic camera: frames all live fighters plus margin, smoothly.
 * World reference resolution is 1920x1080; camera maps world <-> screen.
 *
 * Phase B: velocity look-ahead (the camera leads fast movement), hard
 * clamping to world bounds (never stares into the void), and a directional
 * "kick" on hits (a decaying nudge along the knockback vector) layered on
 * top of the random shake.
 */
export const WORLD_W = 1920;
export const WORLD_H = 1080;

const MARGIN = 340;
const MIN_VIEW_W = 900;
const SMOOTH = 6;
const LOOKAHEAD = 0.14; // seconds of average fighter velocity to lead by
const LOOKAHEAD_MAX = 150; // px cap on the lead
const KICK_DECAY = 11;

export interface CamTarget { x: number; y: number; vx?: number; vy?: number; alive: boolean; }
export interface CamBounds { minX: number; maxX: number; minY: number; maxY: number; }

export class Camera {
  cx = WORLD_W / 2;
  cy = WORLD_H / 2 - 100;
  zoom = 1;
  shakeMag = 0;
  shakeX = 0;
  shakeY = 0;
  kickX = 0;
  kickY = 0;
  /** Optional hard framing limits (set to the stage's blast zone). */
  bounds: CamBounds | null = null;
  private screenW = 1;
  private screenH = 1;

  addShake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag);
  }

  /** Nudge the camera along a hit's knockback direction. */
  addKick(dx: number, dy: number, mag: number): void {
    const m = Math.hypot(dx, dy) || 1;
    this.kickX += (dx / m) * mag;
    this.kickY += (dy / m) * mag;
  }

  update(targets: CamTarget[], screenW: number, screenH: number, dt: number): void {
    this.screenW = screenW;
    this.screenH = screenH;
    const live = targets.filter((t) => t.alive);
    let tx = WORLD_W / 2, ty = WORLD_H / 2 - 100, viewW = WORLD_W;

    if (live.length > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let avgVx = 0, avgVy = 0;
      for (const t of live) {
        minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x);
        minY = Math.min(minY, t.y); maxY = Math.max(maxY, t.y);
        avgVx += t.vx ?? 0; avgVy += t.vy ?? 0;
      }
      avgVx /= live.length; avgVy /= live.length;
      const clampLead = (v: number): number => Math.max(-LOOKAHEAD_MAX, Math.min(LOOKAHEAD_MAX, v * LOOKAHEAD));
      tx = (minX + maxX) / 2 + clampLead(avgVx);
      ty = (minY + maxY) / 2 - 80 + clampLead(avgVy) * 0.5; // gentler vertically
      const spanW = maxX - minX + MARGIN * 2;
      const spanH = (maxY - minY + MARGIN * 2) * (screenW / screenH);
      viewW = Math.min(WORLD_W * 1.15, Math.max(MIN_VIEW_W, spanW, spanH));
    }

    // keep the view inside the stage bounds where possible
    if (this.bounds) {
      const viewH = viewW * (screenH / screenW);
      tx = clampCenter(tx, this.bounds.minX, this.bounds.maxX, viewW / 2);
      ty = clampCenter(ty, this.bounds.minY, this.bounds.maxY, viewH / 2);
    }

    const targetZoom = screenW / viewW;
    const k = 1 - Math.exp(-SMOOTH * dt);
    this.cx += (tx - this.cx) * k;
    this.cy += (ty - this.cy) * k;
    this.zoom += (targetZoom - this.zoom) * k;

    if (this.shakeMag > 0.5) {
      this.shakeX = (Math.random() * 2 - 1) * this.shakeMag;
      this.shakeY = (Math.random() * 2 - 1) * this.shakeMag;
      this.shakeMag *= Math.exp(-9 * dt);
    } else {
      this.shakeMag = 0; this.shakeX = 0; this.shakeY = 0;
    }
    const kd = Math.exp(-KICK_DECAY * dt);
    this.kickX *= kd;
    this.kickY *= kd;
    if (Math.abs(this.kickX) < 0.3) this.kickX = 0;
    if (Math.abs(this.kickY) < 0.3) this.kickY = 0;
  }

  private offX(): number { return this.shakeX + this.kickX; }
  private offY(): number { return this.shakeY + this.kickY; }

  /** Screen pixel -> world coordinates (for mouse aim). */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.screenW / 2) / this.zoom + this.cx + this.offX(),
      y: (sy - this.screenH / 2) / this.zoom + this.cy + this.offY(),
    };
  }

  apply(stage: { position: { set(x: number, y: number): void }; scale: { set(s: number): void } }, screenW: number, screenH: number): void {
    stage.scale.set(this.zoom);
    stage.position.set(
      screenW / 2 - (this.cx + this.offX()) * this.zoom,
      screenH / 2 - (this.cy + this.offY()) * this.zoom,
    );
  }
}

function clampCenter(c: number, min: number, max: number, half: number): number {
  if (max - min <= half * 2) return (min + max) / 2; // view wider than bounds: center it
  return Math.max(min + half, Math.min(max - half, c));
}
