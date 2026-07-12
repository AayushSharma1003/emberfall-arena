/**
 * The fighter rig: a bone hierarchy of painterly parts driven procedurally
 * from sim state. No sprite sheets, no keyframe files — poses are computed
 * from (state, velocity, run odometer, attack timeline, aim) every frame,
 * smoothed frame-rate-independently, and applied as container transforms.
 *
 * Two rig kinds:
 *  - "humanoid": parametric skeleton (proportions/weapons/heads from rigdefs)
 *  - "flame": Pyre — layered living fire, no bones at all
 *
 * The rig consumes a RigView (a plain visual-state snapshot), NOT the sim
 * Fighter — so character-select previews can puppet rigs without a sim.
 */
import { Container, Graphics } from "pixi.js";
import type { CharId, FighterState } from "@emberfall/shared";
import {
  attackPhase, breathe, clamp01, easeInCubic, easeOutBack, easeOutCubic,
  legSwing, lerp, makeChain, runPhase, smoothing, smoothPose, squashStretch, stepChain,
  type ClothParams, type ClothSegment, type Pose,
} from "./posemath.js";
import { glowDisc, litBlob, litCapsule, paintedPoly, paintedRect, shade, type LitPart } from "./parts.js";
import { RIGS, type HumanoidRigDef, type FlameRigDef } from "./rigdefs.js";

export type AttackStyle = "swing" | "heavyswing" | "throw" | "cast" | "stance" | "slam" | "vanish";

export interface RigViewAttack {
  tick: number;
  startup: number;
  active: number;
  recovery: number;
  aimX: number;
  aimY: number;
  style: AttackStyle;
}

export interface RigView {
  state: FighterState;
  facing: 1 | -1;
  vx: number;
  vy: number;
  grounded: boolean;
  aimX: number;
  aimY: number;
  attack: RigViewAttack | null;
  charging: boolean;
  chargeT: number; // 0..1
  burning: boolean;
  damage: number;
  ultReady: boolean;
}

const CLOTH: ClothParams = { stiffness: 55, damping: 6.5, windScale: 0.0011, maxAngle: 1.25 };

// ---------------------------------------------------------------------------
// pose computation (pure)
// ---------------------------------------------------------------------------

interface PoseCtx {
  t: number; // seconds
  runPh: number;
  landPulse: number;
  aimLocal: number; // aim angle in facing-local space
}

/** Pose-space convention: positive limb angles swing FORWARD (toward facing). */
function basePose(): Pose {
  return {
    pelvis_dy: 0, torso_a: 0, head_a: 0,
    armF_a: 0.15, armF_e: 0.25, armB_a: -0.12, armB_e: 0.2,
    legF_a: 0.06, legF_k: 0.08, legB_a: -0.06, legB_k: 0.08,
    weap_a: 0, glow: 0,
  };
}

/** Weapon carry adjustments layered onto idle/run stances. */
const CARRY: Record<string, Partial<Pose>> = {
  sword: { armF_a: 0.35, armF_e: 0.5, weap_a: -0.9 },
  staff: { armF_a: 0.55, armF_e: 0.75, weap_a: -1.55 },
  bow: { armF_a: 0.5, armF_e: 0.3, weap_a: -0.35 },
  knife: { armF_a: 0.28, armF_e: 0.55, weap_a: -0.4 },
  anvilclub: { armF_a: -0.25, armF_e: 0.15, weap_a: -0.25, torso_a: 0.06 },
  claws: { armF_a: 0.3, armF_e: 0.6 },
  forgehammer: { armF_a: -0.2, armF_e: 0.3, weap_a: -0.5 },
  none: {},
};

function armAngleFor(aimLocal: number): number {
  return Math.PI / 2 - aimLocal;
}

export function computeTargetPose(v: RigView, ctx: PoseCtx, weapon: string): Pose {
  const p: Pose = { ...basePose(), ...CARRY[weapon] } as Pose;
  const br = breathe(ctx.t);

  switch (v.state) {
    case "idle": {
      p.pelvis_dy = br * 2.6;
      p.torso_a = (p.torso_a ?? 0) + 0.02 + br * 0.025;
      p.head_a = -0.02 + br * 0.03;
      p.armF_a += br * 0.05;
      p.armB_a -= br * 0.04;
      break;
    }
    case "run": {
      const s = legSwing(ctx.runPh, 0.95);
      const s2 = legSwing(ctx.runPh + 0.5, 0.95);
      p.legF_a = s;
      p.legB_a = s2;
      p.legF_k = Math.max(0.06, -s2 * 0.9);
      p.legB_k = Math.max(0.06, -s * 0.9);
      p.torso_a = 0.16;
      p.head_a = -0.06;
      p.pelvis_dy = Math.abs(Math.sin(ctx.runPh * Math.PI * 2)) * -3.2;
      p.armB_a = s * 0.65;
      p.armF_a += s2 * 0.3; // weapon arm swings less — it's carrying something
      break;
    }
    case "jump": {
      p.legF_a = 0.55; p.legF_k = 0.85;
      p.legB_a = -0.35; p.legB_k = 1.15;
      p.armF_a = 1.15; p.armF_e = 0.35;
      p.armB_a = -0.7; p.armB_e = 0.3;
      p.torso_a = 0.1;
      break;
    }
    case "fall": {
      p.legF_a = 0.28; p.legF_k = 0.35;
      p.legB_a = -0.22; p.legB_k = 0.55;
      p.armF_a = 1.5; p.armF_e = 0.45;
      p.armB_a = -1.25; p.armB_e = 0.4;
      p.torso_a = -0.06;
      p.head_a = 0.06;
      break;
    }
    case "dash": {
      p.torso_a = 0.38;
      p.head_a = -0.15;
      p.legF_a = 0.95; p.legF_k = 0.35;
      p.legB_a = -0.75; p.legB_k = 0.9;
      p.armF_a = -0.5; p.armB_a = -0.9;
      break;
    }
    case "charge": {
      const a = armAngleFor(ctx.aimLocal);
      p.pelvis_dy = 5;
      p.torso_a = 0.14;
      p.armF_a = a * 0.75;
      p.armF_e = 0.25;
      p.armB_a = 0.35; p.armB_e = 0.8; // bracing hand
      p.weap_a = 0;
      p.glow = 0.3 + v.chargeT * 0.7;
      break;
    }
    case "hitstun": {
      p.torso_a = -0.35;
      p.head_a = -0.3;
      p.armF_a = 1.9; p.armF_e = 0.7;
      p.armB_a = -1.6; p.armB_e = 0.6;
      p.legF_a = 0.5; p.legF_k = 0.6;
      p.legB_a = -0.5; p.legB_k = 0.7;
      break;
    }
    case "attack": {
      const atk = v.attack;
      if (!atk) break;
      const ph = attackPhase(atk.tick, atk.startup, atk.active, atk.recovery);
      const A = armAngleFor(ctx.aimLocal);
      const carry: Pose = { ...basePose(), ...CARRY[weapon] } as Pose;

      const heavyish = atk.style === "heavyswing" || atk.style === "slam";
      const cock = heavyish ? 2.1 : 1.55; // how far past the shoulder the windup goes
      const twist = heavyish ? 0.5 : 0.3;

      if (atk.style === "stance") {
        // parry: braced crouch, weapon+shield raised, holding
        p.pelvis_dy = 7;
        p.torso_a = -0.08;
        p.armF_a = 1.25; p.armF_e = 0.55; p.weap_a = -1.2;
        p.armB_a = 1.0; p.armB_e = 0.7;
        p.legF_a = 0.35; p.legB_a = -0.3;
        p.glow = ph.phase === "strike" ? 1 : 0.5;
        break;
      }
      if (atk.style === "vanish") {
        // wrap the cloak and go
        p.torso_a = -0.15;
        p.armF_a = 0.9; p.armF_e = 1.2;
        p.armB_a = 0.8; p.armB_e = 1.1;
        p.head_a = -0.2;
        p.glow = 1;
        break;
      }

      if (ph.phase === "windup") {
        const t = easeInCubic(ph.t);
        p.armF_a = lerp(carry.armF_a ?? 0.3, A - cock, t);
        p.armF_e = lerp(carry.armF_e ?? 0.3, 0.9, t);
        p.torso_a = lerp(carry.torso_a ?? 0.03, -twist, t);
        p.head_a = -0.1 * t;
        p.armB_a = lerp(carry.armB_a ?? -0.1, 0.6, t);
        p.weap_a = lerp(carry.weap_a ?? 0, 0, t);
        p.pelvis_dy = t * 3;
        if (atk.style === "slam") { p.armB_a = A - cock; p.armB_e = 0.4; }
      } else if (ph.phase === "strike") {
        const t = easeOutBack(ph.t, 1.6);
        p.armF_a = lerp(A - cock, A + (heavyish ? 0.35 : 0.2), t);
        p.armF_e = 0.12;
        p.torso_a = lerp(-twist, twist * 1.15, t);
        p.head_a = 0.06;
        p.armB_a = lerp(0.6, -0.8, t);
        p.weap_a = 0;
        p.legF_a = 0.4; p.legB_a = -0.45;
        p.pelvis_dy = heavyish ? 5 : 2;
        if (atk.style === "throw" || atk.style === "cast") {
          p.armF_e = 0.05;
          p.glow = 1;
        }
        if (atk.style === "slam") { p.armB_a = p.armF_a; p.armB_e = 0.15; }
      } else {
        const t = easeOutCubic(ph.t);
        p.armF_a = lerp(A + 0.25, carry.armF_a ?? 0.3, t);
        p.armF_e = lerp(0.15, carry.armF_e ?? 0.3, t);
        p.torso_a = lerp(twist, carry.torso_a ?? 0.03, t);
        p.armB_a = lerp(-0.8, carry.armB_a ?? -0.1, t);
        p.weap_a = lerp(0, carry.weap_a ?? 0, t);
      }
      break;
    }
    default:
      break;
  }
  return p;
}

// ---------------------------------------------------------------------------
// humanoid rig
// ---------------------------------------------------------------------------

class Limb {
  root = new Container(); // hip/shoulder joint
  mid = new Container(); // knee/elbow joint
  upperPart: LitPart;
  lowerPart: LitPart;

  constructor(upperLen: number, lowerLen: number, w: number, color: number, lowerColor?: number) {
    this.upperPart = litCapsule(w, upperLen, color);
    this.lowerPart = litCapsule(w * 0.88, lowerLen, lowerColor ?? shade(color, 0.92));
    this.root.addChild(this.upperPart.node);
    this.mid.position.set(0, upperLen);
    this.mid.addChild(this.lowerPart.node);
    this.root.addChild(this.mid);
  }

  /** apply pose-space angles (positive = forward) with the -sign convention */
  set(rootA: number, midA: number): void {
    this.root.rotation = -rootA;
    this.mid.rotation = -midA;
  }

  syncLight(parentWorldRot: number): void {
    this.upperPart.setWorldRotation(parentWorldRot + this.root.rotation);
    this.lowerPart.setWorldRotation(parentWorldRot + this.root.rotation + this.mid.rotation);
  }
}

export class FighterRig {
  readonly root = new Container();
  private readonly def: HumanoidRigDef | FlameRigDef;
  private readonly W: number;
  private readonly H: number;

  // humanoid bones
  private pelvis!: Container;
  private torso!: Container;
  private torsoPart!: LitPart;
  private headBone!: Container;
  private headPart!: LitPart;
  private armF!: Limb;
  private armB!: Limb;
  private legF!: Limb;
  private legB!: Limb;
  private weaponNode!: Container;
  private glowNode!: Graphics;
  private capeSegs: Container[] = [];
  private chain: ClothSegment[] = [];
  private wispNode: Graphics | null = null;

  // flame bits
  private flameLayers: { g: Graphics; freq: number; amp: number; phase: number }[] = [];
  private flameAura!: Graphics;
  private flameEyes!: Graphics;

  // animation state
  private pose: Pose = basePose();
  private time = Math.random() * 10; // desync idle breathing between fighters
  private odometer = 0;
  private landPulse = 0;
  private wasGrounded = false;

  constructor(charId: CharId, stats: { width: number; height: number }) {
    this.def = RIGS[charId];
    this.W = stats.width;
    this.H = stats.height;
    if (this.def.kind === "flame") this.buildFlame(this.def);
    else this.buildHumanoid(this.def);
  }

  // ---------------- construction ----------------
  private buildHumanoid(d: HumanoidRigDef): void {
    const { W, H } = this;
    const hipY = -d.hipY * H;
    const shoulderY = hipY - d.torsoH * H * 0.82;

    this.pelvis = new Container();
    this.pelvis.position.set(0, hipY);
    this.root.addChild(this.pelvis);

    // cape (behind everything)
    if (d.cape) {
      this.chain = makeChain(d.cape.segments);
      let parent: Container = this.pelvis;
      const segLen = (d.cape.length * H) / d.cape.segments;
      for (let i = 0; i < d.cape.segments; i++) {
        const seg = new Container();
        const wTop = d.cape.width * W * (1 - i * 0.12);
        const g = new Graphics();
        g.poly([-wTop / 2, 0, wTop / 2, 0, (wTop * 0.82) / 2, segLen, (-wTop * 0.82) / 2, segLen])
          .fill(shade(d.cape.color, 1 - i * 0.09));
        g.poly([-wTop / 2, 0, wTop / 2, 0, (wTop * 0.82) / 2, segLen, (-wTop * 0.82) / 2, segLen])
          .stroke({ color: shade(d.cape.color, 0.5), width: 1.5, alpha: 0.4 });
        seg.addChild(g);
        seg.position.set(0, i === 0 ? shoulderY - hipY + 4 : segLen);
        parent.addChild(seg);
        this.capeSegs.push(seg);
        parent = seg;
      }
    }

    // back arm
    this.armB = new Limb(d.armUpper * H, d.armFore * H, d.armW * W, shade(d.palette.cloth, 0.8), shade(d.palette.skin, 0.8));
    this.armB.root.position.set(-W * 0.08, shoulderY - hipY);
    this.pelvis.addChild(this.armB.root);
    if (d.extras?.includes("shield")) {
      const sh = paintedRect(W * 0.72, H * 0.42, 10, d.palette.metal);
      const boss = glowDisc(W * 0.1, d.palette.glow, d.palette.metal, 0.8);
      sh.addChild(boss);
      sh.position.set(0, d.armFore * H * 0.7);
      this.armB.mid.addChild(sh);
    }

    // back leg
    this.legB = new Limb(d.legThigh * H, d.legShin * H, d.legW * W, shade(d.palette.clothDark, 0.9));
    this.legB.root.position.set(-d.stance * W, 0);
    this.pelvis.addChild(this.legB.root);

    // wisp tail instead of legs
    if (d.wisp) {
      this.legB.root.visible = false;
      const wisp = new Graphics();
      const wH = d.legThigh * H + d.legShin * H;
      wisp
        .poly([-W * 0.42, 0, W * 0.42, 0, W * 0.2, wH * 0.55, W * 0.32, wH * 0.8, 0, wH * 1.02, -W * 0.28, wH * 0.75, -W * 0.16, wH * 0.5])
        .fill(shade(d.palette.cloth, 0.8));
      wisp.alpha = 0.92;
      this.wispNode = wisp;
      this.pelvis.addChild(wisp);
    }

    // torso
    this.torso = new Container();
    this.torsoPart = litBlob(d.torsoW * W, d.torsoH * H * 1.25, d.palette.cloth);
    this.torsoPart.node.position.set(0, (shoulderY - hipY) / 2);
    this.torso.addChild(this.torsoPart.node);
    // chest accent plate
    const plate = paintedRect(d.torsoW * W * 0.5, d.torsoH * H * 0.5, 8, d.palette.accent, { lift: 1.35 });
    plate.alpha = 0.85;
    plate.position.set(W * 0.06, (shoulderY - hipY) / 2 - H * 0.02);
    this.torso.addChild(plate);
    this.pelvis.addChild(this.torso);

    // extras that ride the torso
    for (const ex of d.extras ?? []) this.buildExtra(ex, d, shoulderY - hipY);

    // head
    this.headBone = new Container();
    this.headBone.position.set(W * 0.02, shoulderY - hipY - H * 0.015);
    this.headPart = litBlob(d.headR * H * 2, d.headR * H * 2.1, d.palette.skin);
    this.headPart.node.position.set(0, -d.headR * H * 0.9);
    this.headBone.addChild(this.headPart.node);
    this.buildHead(d);
    this.torso.addChild(this.headBone);

    // front leg
    this.legF = new Limb(d.legThigh * H, d.legShin * H, d.legW * W, d.palette.clothDark);
    this.legF.root.position.set(d.stance * W, 0);
    this.pelvis.addChild(this.legF.root);
    if (d.wisp) this.legF.root.visible = false;

    // front arm + weapon
    this.armF = new Limb(d.armUpper * H, d.armFore * H, d.armW * W, d.palette.cloth, d.palette.skin);
    this.armF.root.position.set(W * 0.1, shoulderY - hipY);
    this.pelvis.addChild(this.armF.root);

    this.weaponNode = new Container();
    this.weaponNode.position.set(0, d.armFore * H * 0.95);
    this.armF.mid.addChild(this.weaponNode);
    this.buildWeapon(d);

    // charge/cast glow riding the weapon hand
    this.glowNode = glowDisc(W * 0.5, d.palette.glow, d.palette.accent, 0.85);
    this.glowNode.alpha = 0;
    this.weaponNode.addChild(this.glowNode);
  }

  private buildHead(d: HumanoidRigDef): void {
    const r = d.headR * this.H;
    const g = new Graphics();
    const head = this.headPart.node;
    switch (d.head) {
      case "knight": {
        g.arc(0, -r * 0.15, r * 1.08, Math.PI * 0.95, Math.PI * 2.05).fill(d.palette.metal);
        g.rect(-r * 1.05, -r * 0.35, r * 2.1, r * 0.42).fill(shade(d.palette.metal, 0.85));
        g.rect(-r * 0.15, -r * 0.35, r * 1.2, r * 0.34).fill(0x14101c); // visor slit
        g.moveTo(0, -r * 1.15).lineTo(0, -r * 1.7).stroke({ color: d.palette.accent, width: 3 });
        g.circle(0, -r * 1.75, r * 0.22).fill(d.palette.glow);
        break;
      }
      case "circlet": {
        // long smoke-hair behind, circlet + gem
        g.poly([-r * 1.1, -r * 0.6, r * 0.9, -r * 0.9, r * 1.15, r * 0.4, r * 0.7, r * 1.9, r * 0.1, r * 1.1, -r * 0.9, r * 1.6, -r * 1.2, r * 0.4])
          .fill(shade(d.palette.clothDark, 0.85));
        g.rect(-r * 1.02, -r * 0.5, r * 2.04, r * 0.26).fill(d.palette.metal);
        g.circle(0, -r * 0.38, r * 0.2).fill(d.palette.glow);
        break;
      }
      case "hood": {
        g.moveTo(-r * 1.15, r * 0.5)
          .quadraticCurveTo(-r * 1.3, -r * 1.3, 0, -r * 1.35)
          .quadraticCurveTo(r * 1.35, -r * 1.25, r * 1.1, r * 0.35)
          .quadraticCurveTo(r * 0.4, r * 0.05, 0, r * 0.15)
          .quadraticCurveTo(-r * 0.7, r * 0.3, -r * 1.15, r * 0.5)
          .fill(shade(d.palette.cloth, 0.85));
        g.poly([r * 0.5, -r * 1.3, r * 1.5, -r * 1.9, r * 0.9, -r * 0.9]).fill(d.palette.accent); // feather
        break;
      }
      case "goblin": {
        g.poly([-r * 0.8, -r * 0.2, -r * 2.2, -r * 1.3, -r * 0.7, r * 0.35]).fill(d.palette.skin);
        g.poly([r * 0.8, -r * 0.2, r * 2.2, -r * 1.5, r * 0.7, r * 0.35]).fill(d.palette.skin);
        g.poly([r * 0.15, r * 0.55, r * 0.4, r * 0.95, r * 0.55, r * 0.5]).fill(0xfffbe8); // snaggletooth
        break;
      }
      case "brute": {
        g.ellipse(0, r * 0.75, r * 1.5, r * 0.9).fill(shade(d.palette.skin, 0.92)); // jaw
        g.poly([-r * 1.1, r * 0.7, -r * 1.45, -r * 0.6, -r * 0.65, r * 0.25]).fill(0xfffbe8); // tusks
        g.poly([r * 1.1, r * 0.7, r * 1.45, -r * 0.6, r * 0.65, r * 0.25]).fill(0xfffbe8);
        g.rect(-r * 0.9, -r * 1.0, r * 1.8, r * 0.35).fill(shade(d.palette.cloth, 0.7)); // brow
        break;
      }
      case "crown": {
        g.moveTo(-r * 0.9, -r * 0.7).quadraticCurveTo(-r * 2.1, -r * 1.6, -r * 1.5, -r * 2.4)
          .quadraticCurveTo(-r * 1.1, -r * 1.5, -r * 0.5, -r * 1.05).fill(shade(d.palette.metal, 0.75)); // horns
        g.moveTo(r * 0.9, -r * 0.7).quadraticCurveTo(r * 2.1, -r * 1.6, r * 1.5, -r * 2.4)
          .quadraticCurveTo(r * 1.1, -r * 1.5, r * 0.5, -r * 1.05).fill(shade(d.palette.metal, 0.75));
        g.poly([-r * 0.75, -r * 0.75, -r * 0.45, -r * 1.35, -r * 0.15, -r * 0.8, 0.0, -r * 1.5, r * 0.15, -r * 0.8, r * 0.45, -r * 1.35, r * 0.75, -r * 0.75])
          .fill(d.palette.accent);
        g.poly([-r * 1.05, -r * 0.2, r * 0.4, -r * 0.5, r * 1.05, r * 1.7, 0, r * 2.2, -r * 1.0, r * 1.5]).fill(shade(d.palette.clothDark, 0.9)); // hair
        break;
      }
      case "veil": {
        g.moveTo(-r * 1.2, r * 0.7)
          .quadraticCurveTo(-r * 1.45, -r * 1.4, 0, -r * 1.45)
          .quadraticCurveTo(r * 1.45, -r * 1.35, r * 1.2, r * 0.6)
          .quadraticCurveTo(0, r * 1.25, -r * 1.2, r * 0.7)
          .fill(shade(d.palette.cloth, 0.9));
        g.ellipse(r * 0.15, -r * 0.1, r * 0.62, r * 0.75).fill(0x0c0a14); // the hollow
        g.ellipse(r * 0.02, -r * 0.15, r * 0.16, r * 0.07).fill(d.palette.glow); // glint L
        g.ellipse(r * 0.5, -r * 0.15, r * 0.16, r * 0.07).fill(d.palette.glow); // glint R
        break;
      }
      case "matron": {
        g.circle(-r * 0.55, -r * 1.05, r * 0.55).fill(shade(d.palette.clothDark, 1.15)); // bun
        g.rect(-r * 1.0, -r * 0.45, r * 2.0, r * 0.28).fill(shade(d.palette.metal, 0.9)); // goggle band
        g.circle(r * 0.35, -r * 0.3, r * 0.33).fill(shade(d.palette.metal, 1.1));
        g.circle(r * 0.35, -r * 0.3, r * 0.2).fill(d.palette.glow);
        break;
      }
    }
    head.addChild(g);
    // eye (all heads except veil/knight get a simple dark eye)
    if (d.head !== "veil" && d.head !== "knight") {
      const eye = new Graphics();
      eye.ellipse(r * 0.45, -r * 0.15, r * 0.14, r * 0.18).fill(0x18121f);
      head.addChild(eye);
    }
  }

  private buildWeapon(d: HumanoidRigDef): void {
    const L = d.weaponLen * this.H;
    const w = this.weaponNode;
    const g = new Graphics();
    switch (d.weapon) {
      case "sword": {
        g.poly([-4, 0, 4, 0, 4, -L * 0.78, 0, -L * 0.92, -4, -L * 0.78]).fill(shade(d.palette.metal, 1.15));
        g.moveTo(0, -4).lineTo(0, -L * 0.8).stroke({ color: shade(d.palette.metal, 0.7), width: 1.5 }); // fuller
        g.rect(-L * 0.09, -L * 0.02, L * 0.18, 5).fill(d.palette.accent === d.palette.metal ? 0x8a6a3a : d.palette.accent); // guard
        g.rect(-3, 0, 6, L * 0.14).fill(0x4a3520); // grip
        g.circle(0, L * 0.16, 5).fill(d.palette.glow); // pommel
        break;
      }
      case "staff": {
        g.rect(-3.5, -L * 0.72, 7, L).fill(shade(0x5a4630, 1.05));
        g.circle(0, -L * 0.78, 11).fill(d.palette.glow);
        g.circle(0, -L * 0.78, 6).fill(0xffffff);
        g.arc(0, -L * 0.78, 15, -2.4, 0.6).stroke({ color: d.palette.metal, width: 4 });
        break;
      }
      case "bow": {
        g.moveTo(0, -L * 0.5).quadraticCurveTo(L * 0.42, 0, 0, L * 0.5).stroke({ color: 0x6a4a2a, width: 6 });
        g.moveTo(0, -L * 0.5).lineTo(0, L * 0.5).stroke({ color: 0xd8d2c0, width: 1.5, alpha: 0.9 });
        break;
      }
      case "knife": {
        g.poly([-3, 0, 3, 0, 3, -L * 0.7, 0, -L, -3, -L * 0.7]).fill(shade(d.palette.metal, 1.2));
        g.rect(-3, 0, 6, L * 0.25).fill(0x3a2a1a);
        break;
      }
      case "anvilclub": {
        g.rect(-6, -L * 0.62, 12, L * 0.75).fill(0x5a4630);
        const head = paintedRect(L * 0.52, L * 0.34, 6, d.palette.metal, { lift: 1.2 });
        head.position.set(0, -L * 0.72);
        w.addChild(head);
        const horn = paintedPoly([0, 0, L * 0.3, -L * 0.06, 0, -L * 0.12], shade(d.palette.metal, 0.9), L * 0.12);
        horn.position.set(L * 0.24, -L * 0.7);
        w.addChild(horn);
        break;
      }
      case "claws": {
        for (const s of [-1, 0, 1]) {
          g.poly([s * 7 - 3, 0, s * 7 + 3, 0, s * 7 + s * 4, -L]).fill(shade(d.palette.metal, 1.25));
        }
        break;
      }
      case "forgehammer": {
        g.rect(-5, -L * 0.66, 10, L * 0.82).fill(0x4a3a28);
        const head = paintedRect(L * 0.58, L * 0.3, 8, d.palette.metal, { lift: 1.18 });
        head.position.set(0, -L * 0.74);
        w.addChild(head);
        const seam = new Graphics();
        seam.rect(-L * 0.24, -L * 0.76, L * 0.48, 3).fill(d.palette.glow);
        seam.alpha = 0.9;
        w.addChild(seam);
        break;
      }
      case "none":
        break;
    }
    w.addChild(g);
  }

  private buildExtra(ex: string, d: HumanoidRigDef, shoulderRelY: number): void {
    const { W, H } = this;
    const g = new Graphics();
    switch (ex) {
      case "wings": {
        g.moveTo(-W * 0.1, shoulderRelY + H * 0.04)
          .quadraticCurveTo(-W * 1.15, shoulderRelY - H * 0.16, -W * 0.95, shoulderRelY + H * 0.3)
          .quadraticCurveTo(-W * 0.55, shoulderRelY + H * 0.18, -W * 0.1, shoulderRelY + H * 0.16)
          .fill(shade(d.palette.clothDark, 0.75));
        g.moveTo(-W * 0.12, shoulderRelY + H * 0.05)
          .quadraticCurveTo(-W * 0.85, shoulderRelY - H * 0.1, -W * 0.8, shoulderRelY + H * 0.24)
          .stroke({ color: d.palette.accent, width: 2, alpha: 0.5 });
        this.torso.addChildAt(g, 0);
        return;
      }
      case "quiver": {
        g.rect(-W * 0.5, shoulderRelY + H * 0.1, W * 0.22, H * 0.26).fill(shade(0x6a4a2a, 0.95));
        for (const s of [0, 1, 2]) {
          g.moveTo(-W * 0.44 + s * W * 0.06, shoulderRelY + H * 0.1)
            .lineTo(-W * 0.48 + s * W * 0.06, shoulderRelY + H * 0.02)
            .stroke({ color: d.palette.accent, width: 2 });
        }
        this.torso.addChildAt(g, 0);
        return;
      }
      case "bombbag": {
        g.circle(-W * 0.42, shoulderRelY + H * 0.26, W * 0.24).fill(shade(0x3a3a4a, 1.0));
        g.rect(-W * 0.46, shoulderRelY + H * 0.12, W * 0.08, H * 0.06).fill(0x8a76b8);
        this.torso.addChildAt(g, 0);
        return;
      }
      case "kilnpack": {
        const pack = paintedRect(W * 0.5, H * 0.34, 6, shade(d.palette.metal, 0.8));
        pack.position.set(-W * 0.5, shoulderRelY + H * 0.18);
        const grate = new Graphics();
        for (const s of [0, 1, 2]) {
          grate.rect(-W * 0.12, -H * 0.1 + s * H * 0.07, W * 0.24, H * 0.035).fill(d.palette.glow);
        }
        grate.alpha = 0.95;
        pack.addChild(grate);
        this.torso.addChildAt(pack, 0);
        return;
      }
      case "shield":
        return; // built with the back arm
    }
  }

  private buildFlame(d: FlameRigDef): void {
    const { W, H } = this;
    this.flameAura = glowDisc(H * 0.62, d.palette.mid, d.palette.outer, 0.3);
    this.flameAura.position.set(0, -H * 0.45);
    this.root.addChild(this.flameAura);

    const teardrop = (r: number, color: number, alpha: number): Graphics => {
      const g = new Graphics();
      g.moveTo(0, -r * 1.9)
        .quadraticCurveTo(r * 0.95, -r * 1.0, r * 0.8, -r * 0.25)
        .quadraticCurveTo(r * 0.6, r * 0.4, 0, r * 0.45)
        .quadraticCurveTo(-r * 0.6, r * 0.4, -r * 0.8, -r * 0.25)
        .quadraticCurveTo(-r * 0.95, -r * 1.0, 0, -r * 1.9)
        .fill(color);
      g.alpha = alpha;
      return g;
    };
    const mk = (r: number, color: number, alpha: number, freq: number, amp: number, phase: number): void => {
      const g = teardrop(r, color, alpha);
      g.position.set(0, -H * 0.4);
      g.pivot.set(0, 0);
      this.root.addChild(g);
      this.flameLayers.push({ g, freq, amp, phase });
    };
    mk(W * 0.62, d.palette.outer, 0.85, 7.3, 0.1, 0);
    mk(W * 0.47, d.palette.mid, 0.95, 9.1, 0.13, 1.7);
    mk(W * 0.3, d.palette.core, 1.0, 11.7, 0.16, 3.1);

    this.flameEyes = new Graphics();
    this.flameEyes.ellipse(-W * 0.1, -H * 0.48, W * 0.055, H * 0.035).fill(d.palette.eye);
    this.flameEyes.ellipse(W * 0.14, -H * 0.48, W * 0.055, H * 0.035).fill(d.palette.eye);
    this.root.addChild(this.flameEyes);
  }

  // ---------------- per-frame update ----------------
  update(v: RigView, dt: number): void {
    this.time += dt;
    this.odometer += Math.abs(v.vx) * dt;
    if (v.grounded && !this.wasGrounded) this.landPulse = 1;
    this.wasGrounded = v.grounded;
    this.landPulse = Math.max(0, this.landPulse - dt * 5);

    if (this.def.kind === "flame") {
      this.updateFlame(v, this.def);
      return;
    }
    const d = this.def;

    // aim in facing-local space (attack aim wins while attacking)
    const ax = v.attack ? v.attack.aimX : v.aimX;
    const ay = v.attack ? v.attack.aimY : v.aimY;
    const aimLocal = Math.atan2(ay, ax * v.facing);

    const target = computeTargetPose(v, {
      t: this.time,
      runPh: runPhase(this.odometer, this.H * 1.35),
      landPulse: this.landPulse,
      aimLocal,
    }, d.weapon);

    // attacks track tightly; everything else eases
    const rate = v.state === "attack" || v.state === "hitstun" ? 30 : 13;
    this.pose = smoothPose(this.pose, target, rate, dt);
    const p = this.pose;

    // root: facing flip + squash/stretch
    const ss = squashStretch(v.vy, v.grounded, this.landPulse);
    this.root.scale.set(v.facing * ss.sx, ss.sy);

    this.pelvis.position.y = -d.hipY * this.H + p.pelvis_dy;
    this.torso.rotation = -p.torso_a;
    this.headBone.rotation = -p.head_a;
    this.armF.set(p.armF_a, p.armF_e);
    this.armB.set(p.armB_a, p.armB_e);
    this.legF.set(p.legF_a, p.legF_k);
    this.legB.set(p.legB_a, p.legB_k);
    this.weaponNode.rotation = -p.weap_a;

    // fixed-direction light: counter-rotate every lit overlay
    const torsoRot = this.torso.rotation;
    this.torsoPart.setWorldRotation(torsoRot);
    this.headPart.setWorldRotation(torsoRot + this.headBone.rotation);
    this.armF.syncLight(torsoRot * 0); // arms hang from pelvis node (world rot 0) in this build
    this.armB.syncLight(0);
    this.legF.syncLight(0);
    this.legB.syncLight(0);

    // cape cloth
    if (this.chain.length > 0) {
      stepChain(this.chain, v.vx * v.facing, v.vy, CLOTH, dt);
      for (let i = 0; i < this.capeSegs.length; i++) {
        this.capeSegs[i].rotation = (i === 0 ? this.chain[i].angle : this.chain[i].angle - this.chain[i - 1].angle);
      }
    }

    // wisp tail sway
    if (this.wispNode) {
      this.wispNode.skew.x = Math.sin(this.time * 3.1) * 0.12 - v.vx * v.facing * 0.00018;
      this.wispNode.scale.y = 1 + Math.sin(this.time * 2.3) * 0.05;
    }

    // glow (charge/cast/stance)
    const glowTarget = p.glow ?? 0;
    this.glowNode.alpha += (glowTarget - this.glowNode.alpha) * smoothing(14, dt);
    this.glowNode.scale.set(0.6 + glowTarget * 0.8 + Math.sin(this.time * 9) * 0.06 * glowTarget);
  }

  private updateFlame(v: RigView, d: FlameRigDef): void {
    const kindle = Math.min(1, v.damage / 150);
    const lean = Math.max(-0.5, Math.min(0.5, v.vx * 0.00045));
    const flick = 1 + kindle * 0.9;

    this.flameAura.alpha = 0.5 + kindle * 0.5;
    this.flameAura.scale.set(1 + kindle * 0.55 + Math.sin(this.time * 5.1) * 0.05);

    let attackKick = 0;
    if (v.attack) {
      const ph = attackPhase(v.attack.tick, v.attack.startup, v.attack.active, v.attack.recovery);
      attackKick = ph.phase === "strike" ? 0.5 : ph.phase === "windup" ? -0.25 : 0;
    }
    const aimLocal = v.attack ? Math.atan2(v.attack.aimY, v.attack.aimX * v.facing) : 0;

    for (const layer of this.flameLayers) {
      const s = Math.sin(this.time * layer.freq * flick + layer.phase);
      layer.g.scale.set(1 - s * layer.amp * 0.5, 1 + s * layer.amp + attackKick * 0.4);
      layer.g.skew.x = -lean + Math.sin(this.time * layer.freq * 0.7 + layer.phase) * 0.06 + attackKick * Math.cos(aimLocal) * 0.6;
      layer.g.rotation = attackKick * -Math.sin(aimLocal) * 0.5;
    }
    this.flameEyes.position.x = lean * 18 + (v.attack ? Math.cos(aimLocal) * 5 : 0);
    this.root.scale.set(v.facing * (1 + (v.charging ? v.chargeT * 0.2 : 0)), 1 + (v.charging ? v.chargeT * 0.15 : 0));

    // hitstun scatter
    this.root.alpha = v.state === "hitstun" ? 0.75 : 1;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

// ---------------------------------------------------------------------------
// view construction from a sim fighter
// ---------------------------------------------------------------------------

/** Derive the animation style of a move from what it does. */
export function attackStyleOf(m: {
  kind: string;
  heavy: boolean;
  parry?: unknown;
  construct?: unknown;
  teleport?: unknown;
  chargeable?: unknown;
}): AttackStyle {
  if (m.parry) return "stance";
  if (m.teleport) return "vanish";
  if (m.construct) return "slam";
  if (m.kind === "projectile") return m.chargeable ? "cast" : "throw";
  return m.heavy ? "heavyswing" : "swing";
}

/** Build a RigView from the live sim fighter (render-side glue). */
export function rigViewOf(f: {
  state: FighterState;
  facing: 1 | -1;
  vx: number;
  vy: number;
  grounded: boolean;
  aimX: number;
  aimY: number;
  attack: {
    startupTicks: number;
    activeTicks: number;
    recoveryTicks: number;
    kind: string;
    heavy: boolean;
    parry?: unknown;
    construct?: unknown;
    teleport?: unknown;
    chargeable?: unknown;
  } | null;
  attackTick: number;
  atkAimX: number;
  atkAimY: number;
  charging: boolean;
  chargeTicks: number;
  burnTicks: number;
  damage: number;
  ult: number;
  moves: { special: { chargeable?: { maxTicks: number } } };
}): RigView {
  return {
    state: f.state,
    facing: f.facing,
    vx: f.vx,
    vy: f.vy,
    grounded: f.grounded,
    aimX: f.aimX,
    aimY: f.aimY,
    attack: f.attack
      ? {
          tick: f.attackTick,
          startup: f.attack.startupTicks,
          active: f.attack.activeTicks,
          recovery: f.attack.recoveryTicks,
          aimX: f.atkAimX,
          aimY: f.atkAimY,
          style: attackStyleOf(f.attack),
        }
      : null,
    charging: f.charging,
    chargeT: f.charging ? clamp01(f.chargeTicks / (f.moves.special.chargeable?.maxTicks ?? 1)) : 0,
    burning: f.burnTicks > 0,
    damage: f.damage,
    ultReady: f.ult >= 100,
  };
}
