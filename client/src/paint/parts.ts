/**
 * Painterly part builders. Every visible shape in the game is built from
 * these: gradient-filled primitives with a painterly two-tone body, plus a
 * FIXED-DIRECTION light system — each part carries a highlight/shade overlay
 * that is counter-rotated every frame so the light always comes from the
 * upper-left of the SCREEN, no matter how the limb rotates. That one trick
 * is most of what makes the rigs read as "painted" instead of "vector".
 *
 * Build once, transform forever: parts are constructed at rig creation and
 * only their container transforms change per frame (no re-tessellation).
 */
import { Container, FillGradient, Graphics } from "pixi.js";

// ---------- color helpers ----------
export function shade(color: number, f: number): number {
  // f < 1 darkens, f > 1 lightens toward white
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  const mix = (c: number): number =>
    f <= 1 ? Math.round(c * f) : Math.round(c + (255 - c) * Math.min(1, f - 1));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

export function withAlpha(color: number, alpha: number): { color: number; alpha: number } {
  return { color, alpha };
}

// ---------- gradients ----------
/** Vertical two-tone gradient (lit top, shaded bottom) — the painterly base coat. */
export function coatGradient(color: number, w: number, h: number, lift = 1.28, drop = 0.62): FillGradient {
  const g = new FillGradient({
    type: "linear",
    start: { x: 0, y: -h / 2 },
    end: { x: 0, y: h / 2 },
    textureSpace: "global",
  });
  g.addColorStop(0, shade(color, lift));
  g.addColorStop(0.45, color);
  g.addColorStop(1, shade(color, drop));
  return g;
}

/** Radial glow gradient (cores of flames, magic orbs, embers). Alpha fades to the rim. */
export function glowGradient(inner: number, outer: number, r: number, innerAlpha = 1, outerAlpha = 0): FillGradient {
  const g = new FillGradient({
    type: "radial",
    center: { x: 0, y: 0 },
    innerRadius: 0,
    outerCenter: { x: 0, y: 0 },
    outerRadius: r,
    textureSpace: "global",
  });
  const rgba = (c: number, a: number): string =>
    `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
  g.addColorStop(0, rgba(inner, innerAlpha));
  g.addColorStop(0.55, rgba(shade(outer, 1.05), (innerAlpha + outerAlpha) / 2));
  g.addColorStop(1, rgba(outer, outerAlpha));
  return g;
}

// ---------- the lit part ----------
/**
 * A painted shape + its fixed-direction light overlays. `setWorldRotation`
 * is called each frame by the rig with the part's accumulated world rotation;
 * the overlay counter-rotates so highlights stay screen-up-left.
 */
export interface LitPart {
  node: Container;
  /** counter-rotated light overlay */
  light: Container;
  setWorldRotation(worldRot: number): void;
}

/**
 * Build a lit capsule limb: length along +y (hangs down from the joint),
 * painterly base coat + rim highlight (upper-left) + core shadow (lower-right).
 */
export function litCapsule(w: number, len: number, color: number, opts: { lift?: number; drop?: number } = {}): LitPart {
  const node = new Container();
  const base = new Graphics();
  const r = w / 2;
  base
    .roundRect(-r, -r * 0.4, w, len + r * 0.4, r)
    .fill(coatGradient(color, w, len, opts.lift ?? 1.25, opts.drop ?? 0.6));
  // painterly edge: a darker outline that reads as brushwork, not vector stroke
  base.roundRect(-r, -r * 0.4, w, len + r * 0.4, r).stroke({ color: shade(color, 0.42), width: Math.max(1.5, w * 0.09), alpha: 0.55 });
  node.addChild(base);

  const light = new Container();
  const hi = new Graphics();
  // rim light: a thin bright lozenge offset up-left
  hi.roundRect(-r * 0.72, -r * 0.3, w * 0.34, len * 0.7, r * 0.3).fill(withAlpha(0xfff3e0, 0.32));
  const sh = new Graphics();
  sh.roundRect(r * 0.28, len * 0.25, w * 0.4, len * 0.62, r * 0.3).fill(withAlpha(0x140b20, 0.28));
  light.addChild(sh, hi);
  node.addChild(light);

  return {
    node,
    light,
    setWorldRotation(worldRot: number): void {
      light.rotation = -worldRot;
    },
  };
}

/** A lit ellipse blob (torsos, heads, bellies). */
export function litBlob(w: number, h: number, color: number, opts: { lift?: number; drop?: number } = {}): LitPart {
  const node = new Container();
  const base = new Graphics();
  base.ellipse(0, 0, w / 2, h / 2).fill(coatGradient(color, w, h, opts.lift ?? 1.3, opts.drop ?? 0.58));
  base.ellipse(0, 0, w / 2, h / 2).stroke({ color: shade(color, 0.42), width: Math.max(1.5, w * 0.05), alpha: 0.5 });
  node.addChild(base);

  const light = new Container();
  const hi = new Graphics();
  hi.ellipse(-w * 0.18, -h * 0.2, w * 0.26, h * 0.22).fill(withAlpha(0xfff3e0, 0.3));
  const sh = new Graphics();
  sh.ellipse(w * 0.16, h * 0.22, w * 0.3, h * 0.24).fill(withAlpha(0x140b20, 0.26));
  light.addChild(sh, hi);
  node.addChild(light);

  return {
    node,
    light,
    setWorldRotation(worldRot: number): void {
      light.rotation = -worldRot;
    },
  };
}

/** Simple glow disc (auras, charge orbs, wisp cores). Not light-managed. */
export function glowDisc(r: number, inner: number, outer: number, innerAlpha = 0.9): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r).fill(glowGradient(inner, outer, r, innerAlpha, 0));
  return g;
}

/** Flat painted polygon with the standard coat + outline (plates, blades, props). */
export function paintedPoly(points: number[], color: number, h: number, opts: { lift?: number; drop?: number } = {}): Graphics {
  const g = new Graphics();
  g.poly(points).fill(coatGradient(color, 10, h, opts.lift ?? 1.25, opts.drop ?? 0.6));
  g.poly(points).stroke({ color: shade(color, 0.42), width: 2, alpha: 0.55 });
  return g;
}

/** Painted rounded rect (shields, plates, hammer heads). */
export function paintedRect(w: number, h: number, r: number, color: number, opts: { lift?: number; drop?: number } = {}): Graphics {
  const g = new Graphics();
  g.roundRect(-w / 2, -h / 2, w, h, r).fill(coatGradient(color, w, h, opts.lift ?? 1.25, opts.drop ?? 0.6));
  g.roundRect(-w / 2, -h / 2, w, h, r).stroke({ color: shade(color, 0.42), width: 2, alpha: 0.55 });
  return g;
}
