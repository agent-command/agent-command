/**
 * Combat & world effects driven by `view.fx`, in the Field Journal ink language (docs/art/DIRECTIONS.md §1):
 * brush-stroke tracers (ink tail, pigment head), pigment-bloom explosions (a hot emissive core that blooms, a
 * watercolour wash with edge-darkening, an ink splat left on the ground), brushed ink rings for shockwaves, dashed
 * construction-pencil rings for scans, wash puffs of smoke and dust, debris. Everything is pooled and GPU-instanced;
 * the per-frame path allocates nothing.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  DodecahedronGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  type ComputeNode,
  type Renderer,
} from 'three/webgpu';
import { abs, atan, color, float, fract, fwidth, instancedDynamicBufferAttribute, max, mix, mx_noise_float, positionGeometry, sin, smoothstep, uv, vec2, vec3 } from 'three/tsl';
import { ECON, PLANES, PLANE_Y, STATS, TICK_RATE, isStatKind, type Plane, type StatKind, type View, type Weapon } from '@agent-command/game/contract';
import { fadeValue } from './fade.ts';
import { hash2, sideColor, unitY, wx, wz } from './common.ts';
import { cel, overlay, seen, type F1, type V3 } from './materials.ts';
import { INK, LINE, SHADOW } from './palette.ts';
import { TerrainField, groundAt } from './terrain.ts';
import type { FogField } from './fog.ts';
import { asteroidPosition, impactLook } from './asteroid.ts';
import { orbitPulse, projectilePoint, projectileSegment, type OrbitWeapon, type Trajectory } from './projectile.ts';
import { BREACHER, MORTAR_MUZZLE, TURRET, WARDEN, footprintModelScale, model } from './models.ts';
import { orbitMuzzle, type Track } from './entities.ts';
import { crossPlaneAim, shotAim, shotDistance } from './aim.ts';
import { prepareStartup } from './startup.ts';
import { PARTICLE_CAMERA_Y, createParticles, dispatchParticles, type ParticlePool } from './gpu-particles.ts';
import { ScorchFire } from './scorch.ts';
import { ruleTables } from '../unit-stats.ts';
import { SPIRE_HEIGHT, spireBaseY } from './spires.ts';
import { DeathPlayer } from './death-fx.ts';
import { deathProfile } from './death-profiles.ts';
import { DAMAGE, damageRates, type DamageRates } from './damage-fx.ts';

/** Scratch for `Combat.damaged`. */
const RATES: DamageRates = { smoke: 0, sparks: 0, fire: 0 };
/** Health fraction at and above which no damage effect runs (the highest threshold). */
const DAMAGE_START = Math.max(DAMAGE.smoke.below, DAMAGE.sparks.below, DAMAGE.fire.below);
/** Neutral scenery with no damaged look (rocks, islands, the core; the Spire cracks its own facets). */
const DAMAGE_EXEMPT: Partial<Record<string, true>> = { spire: true, island: true, asteroid: true, core: true, post: true };
/**
 * Emission height above the model's base (× model scale) for units and structures, the horizontal scatter, the soot
 * puff's start and end size, and the smallest model scale effects are sized from (small units still smoke visibly).
 */
const DAMAGE_LOOK = { unitTop: 0.35, structureTop: 0.8, spread: 0.3, soot: [0.18, 0.6], minScale: 0.8 } as const;

type FxEntry = View['fx'][number];
const IMPACT_GROUND = ['surface', 'sky'] as const;
const IMPACT_SKY = ['sky'] as const;

/** Effect anchor height above each plane's reference altitude. */
const LIFT: Record<Plane, number> = { depths: 0.55, surface: 0.45, sky: 1.7, orbit: 0.3 };
const PI = Math.PI;

const C = (hex: string) => new Color(hex);
// pigments, not light: they have to read on cream paper as well as on the dark Depths/Orbit cards
const COL = {
  rifle: C('#e8a33a'),
  shotgun: C('#f2c14e'),
  flare: C('#ff6f5c'),
  cannon: C('#e06a2a'),
  flak: C('#e8862e'),
  missile: C('#2f7fd0'),
  turret: C('#1f9ac8'),
  spark: C('#f2b552'),
  fire: C('#ec5a24'),
  ember: C('#d4401a'),
  smoke: C('#8c8499'),
  soot: C('#3a3430'),
  dust: C('#b8996e'),
  debris: C('#4a4038'),
  bomb: C('#2a2c30'),
  gold: C('#e0a81e'),
  scan: C('#3a7fc4'),
  portal: C('#9a68e8'),
  green: C('#5fae3c'),
  white: C('#fff8e8'),
  /** emissive core (> 1: the only part of an explosion that blooms) */
  flash: new Color(2.4, 1.9, 1.3),
};

/** Per-instance plane index (0 depths … 3 orbit) → that plane's colour from a palette table. */
export function byPlane(pi: F1, table: Record<Plane, string>): V3 {
  const c = (p: Plane) => color(table[p]);
  return pi.lessThan(0.5).select(c('depths'), pi.lessThan(1.5).select(c('surface'), pi.lessThan(2.5).select(c('sky'), c('orbit')))) as unknown as V3;
}

/** Visibility of an effect at world height y on `plane`: faded on other planes, hidden right under the camera. */
let camY = 100;
function vis(plane: number, y: number): number {
  const f = fadeValue[PLANES[plane]!];
  const near = (camY - y - 2) / 6;
  return Math.max(f, 0.3) * (near < 0 ? 0 : near > 1 ? 1 : near);
}

export const PIDX: Record<Plane, number> = { depths: 0, surface: 1, sky: 2, orbit: 3 };

// ---------------------------------------------------------------- projectiles
const HIT = { none: 0, spark: 1, puff: 2, flak: 3, bomb: 5, missile: 6, chip: 7 } as const;
type HitStyle = (typeof HIT)[keyof typeof HIT];

/**
 * Immutable presentation, never damage/velocity/collision rules. Add a Weapon to the contract and this
 * exhaustive table must grow with it. Reuse a shape + trajectory; add a new strategy only for a genuinely
 * different silhouette. All lengths are world tiles, hold is milliseconds, and muzzle coordinates are
 * nominal model-local offsets after the 1.35 unit readability scale (aircraft additionally ×1.35).
 * The server supplies arrival time independently of these knobs, including zero-time hitscan/contact.
 */
export interface ProjectileVisual {
  readonly shape: 'streak' | 'shell' | 'flak' | 'missile' | 'bomb' | 'beam' | 'contact' | 'pulse' | 'spread' | 'flame';
  readonly trajectory: Trajectory;
  readonly pigment: keyof typeof COL | 'side';
  readonly width: number;
  readonly length: number;
  readonly tail: number;
  readonly arc: number;
  readonly hold: number;
  readonly trail: 'none' | 'smoke' | 'fuse';
  readonly muzzle: 'none' | 'flash' | 'smoke';
  readonly impact: HitStyle;
  readonly forward: number;
  readonly height: number;
  readonly lateral: number;
  /** `spread`: half-width (tiles) the outer pellets fan out to by the target. */
  readonly spread?: number;
  /** Flame jet half-angle (rad); live matches use their own surface rules. */
  readonly cone?: number;
}
const visual = (p: ProjectileVisual): ProjectileVisual => Object.freeze(p);

/** Identity comes from silhouette and rhythm, not pigment alone; larger blasts retain the visual hierarchy. */
export const WEAPON_VISUALS: Readonly<Record<Weapon, ProjectileVisual>> = Object.freeze({
  rifle: visual({ shape: 'streak', trajectory: 'linear', pigment: 'rifle', width: 0.065, length: 0, tail: 1.8, arc: 0, hold: 110, trail: 'none', muzzle: 'flash', impact: HIT.spark, forward: 0.405, height: 0.446, lateral: 0.162 }),
  cannon: visual({ shape: 'shell', trajectory: 'arc', pigment: 'cannon', width: 0.22, length: 0.5, tail: 1.1, arc: 1.2, hold: 0, trail: 'none', muzzle: 'smoke', impact: HIT.puff, forward: 1.026, height: 0.567, lateral: 0 }),
  flak: visual({ shape: 'flak', trajectory: 'linear', pigment: 'flak', width: 0.12, length: 0.28, tail: 0.9, arc: 0, hold: 0, trail: 'none', muzzle: 'flash', impact: HIT.flak, forward: 0.62, height: 1.04, lateral: 0 }),
  missile: visual({ shape: 'missile', trajectory: 'arc', pigment: 'missile', width: 0.18, length: 0.65, tail: 1.6, arc: 0.65, hold: 0, trail: 'smoke', muzzle: 'none', impact: HIT.missile, forward: 0.255, height: -0.091, lateral: 0 }),
  bomb: visual({ shape: 'bomb', trajectory: 'fall', pigment: 'bomb', width: 0.34, length: 0.65, tail: 0, arc: 0, hold: 0, trail: 'fuse', muzzle: 'none', impact: HIT.bomb, forward: 0, height: -0.28, lateral: 0 }),
  beam: visual({ shape: 'beam', trajectory: 'linear', pigment: 'side', width: 0.19, length: 0, tail: 0, arc: 0, hold: 240, trail: 'none', muzzle: 'flash', impact: HIT.spark, forward: 0, height: 0, lateral: 0 }),
  point_defence: visual({ shape: 'pulse', trajectory: 'linear', pigment: 'rifle', width: 0.055, length: 0, tail: 1.2, arc: 0, hold: 75, trail: 'none', muzzle: 'flash', impact: HIT.spark, forward: 0.93, height: 0.51, lateral: 0.966 }),
  turret: visual({ shape: 'pulse', trajectory: 'linear', pigment: 'turret', width: 0.1, length: 0.22, tail: 1.2, arc: 0, hold: 0, trail: 'none', muzzle: 'flash', impact: HIT.spark, forward: TURRET.tip * 1.35, height: TURRET.y * 1.35, lateral: 0 }),
  pick: visual({ shape: 'contact', trajectory: 'linear', pigment: 'spark', width: 0, length: 0, tail: 0, arc: 0, hold: 0, trail: 'none', muzzle: 'none', impact: HIT.chip, forward: 0.85, height: 0.27, lateral: 0 }),
  // A short close-range burst: three pellets fanning from the Warden's right-hand shotgun (models.ts WARDEN.muzzle).
  shotgun: visual({ shape: 'spread', trajectory: 'linear', pigment: 'shotgun', width: 0.05, length: 0, tail: 0.7, arc: 0, hold: 90, trail: 'none', muzzle: 'flash', impact: HIT.spark, forward: WARDEN.muzzle.x * 1.35, height: WARDEN.muzzle.y * 1.35, lateral: WARDEN.muzzle.z * 1.35, spread: 0.35 }),
  // Overlapping pigment lobes and a short hot core, emitted from the animated nozzle throughout the burst.
  flamer: visual({ shape: 'flame', trajectory: 'linear', pigment: 'fire', width: 0.12, length: 0, tail: 0, arc: 0, hold: 160, trail: 'none', muzzle: 'none', impact: HIT.none, forward: BREACHER.nozzle.x * 1.35, height: BREACHER.nozzle.y * 1.35, lateral: BREACHER.nozzle.z * 1.35, cone: (ECON.breacherConeArc * PI) / 360 }),
});
/** The piercing ability reuses the travelling projectile pool, not the tracking weapon-lock pass. */
const SUN_LANCE_VISUAL = visual({ ...WEAPON_VISUALS.rifle, width: 0.26, length: 0.26, tail: 1.3, muzzle: 'none', impact: HIT.none });
/** Target-only fog events retain a local heat fleck without reconstructing a hidden jet. */
const FLAMER_HIT = visual({ ...WEAPON_VISUALS.pick, impact: HIT.spark });
const SUN_LANCE_COLOR = new Color('#ffe6a0');

/** Shared weapons retain the muzzle of the actual hull, rather than borrowing infantry or Spire anchors. */
const UNIT_WEAPON_VISUALS: Partial<Record<StatKind, ProjectileVisual>> = {
  skiff: visual({ ...WEAPON_VISUALS.rifle, forward: 0.656, height: 0, lateral: 0 }),
  lancer: visual({ ...WEAPON_VISUALS.beam, forward: 1.54, height: 0, lateral: 0 }),
  // the dorsal turret's twin-barrel tips (models.ts GUNSHIP turret tip 0.62 / 0.22 × 1.8225; the platform's mast-raised
  // turret 0.62 / GUN_PLATFORM_TURRET_Y × 1.35); a visible shooter tracks its yawing barrels instead (orbitMuzzle)
  gunship: visual({ ...WEAPON_VISUALS.rifle, forward: 1.13, height: 0.401, lateral: 0 }),
  gun_platform: visual({ ...WEAPON_VISUALS.rifle, forward: 0.837, height: 0.918, lateral: 0 }),
  island_mortar: visual({ ...WEAPON_VISUALS.bomb, shape: 'shell', trajectory: 'arc', arc: 8, forward: MORTAR_MUZZLE.x * 1.35, height: MORTAR_MUZZLE.y * 1.35, width: 0.28, length: 0.5, trail: 'smoke', muzzle: 'smoke' }),
};
/** The second flak barrel is cosmetic: same flight, no duplicate impact/splash or damage implication. */
const FLAK_SECONDARY = visual({ ...WEAPON_VISUALS.flak, impact: HIT.none });
/** Likewise the second Bastion blister and the Gunship's second chin barrel when they fire at a falling rock. */
const PD_SECONDARY = visual({ ...WEAPON_VISUALS.point_defence, impact: HIT.none });
const GUNSHIP_SECONDARY = visual({ ...UNIT_WEAPON_VISUALS.gunship!, impact: HIT.none });

/** Non-weapon strokes share the pool, but cannot accidentally acquire a weapon impact. */
export const EFFECT_VISUALS = Object.freeze({
  scan: visual({ ...WEAPON_VISUALS.beam, pigment: 'scan', width: 0.09, hold: 450, muzzle: 'none', impact: HIT.none }),
  portal: visual({ ...WEAPON_VISUALS.rifle, pigment: 'portal', width: 0.12, tail: 8, hold: 0, muzzle: 'none', impact: HIT.none }),
  fault: visual({ ...WEAPON_VISUALS.rifle, pigment: 'fire', width: 0.14, tail: 8, hold: 0, muzzle: 'none', impact: HIT.none }),
  // A lobbed Warden flare: a short glowing arc that sparks where it lands (the light itself is `awareness.ts`).
  flare: visual({ shape: 'shell', trajectory: 'arc', pigment: 'flare', width: 0.14, length: 0.16, tail: 0.6, arc: 1.1, hold: 0, trail: 'fuse', muzzle: 'none', impact: HIT.spark, forward: 0, height: 0, lateral: 0 }),
});

/**
 * Fixed-capacity SoA flight state; immutable profiles are shared references, never copied into each slot.
 * Admission drops new cosmetics when full (no replacement impact). Five stroke instances and one body per
 * flight bound GPU work even for the most detailed missile. Time is Float64: Float32 millisecond clocks
 * lose sub-frame precision after a long-running tab. Dense swap-removal copies every lifecycle field.
 */
class Projectiles {
  readonly bolts: InstancedMesh;
  readonly bodies: InstancedMesh;
  private readonly boltTint: InstancedBufferAttribute;
  private readonly bodyTint: InstancedBufferAttribute;
  private readonly cap = 512;
  n = 0;
  private readonly profiles: (ProjectileVisual | undefined)[] = new Array(this.cap);
  private readonly targets: (Track | undefined)[] = new Array(this.cap);
  private readonly sources: (Track | undefined)[] = new Array(this.cap);
  private readonly barrels = new Uint8Array(this.cap);
  private readonly s = new Float32Array(this.cap * 3);
  private readonly e = new Float32Array(this.cap * 3);
  private readonly col = new Float32Array(this.cap * 3);
  private readonly t0 = new Float64Array(this.cap);
  private readonly arrive = new Float64Array(this.cap);
  private readonly trailStep = new Int32Array(this.cap);
  private readonly flags = new Uint8Array(this.cap); // bit 0: launch handled; bit 1: impact handled
  private readonly sp = new Uint8Array(this.cap);
  private readonly tp = new Uint8Array(this.cap);
  private readonly splash = new Float32Array(this.cap);
  private readonly head = new Float64Array(3);
  private readonly tail = new Float64Array(3);
  private readonly point = new Float64Array(3);
  private strokes = 0;
  private solids = 0;

  constructor(fogField?: FogField) {
    this.boltTint = new InstancedBufferAttribute(new Float32Array(this.cap * 5 * 4), 4).setUsage(DynamicDrawUsage);
    this.bodyTint = new InstancedBufferAttribute(new Float32Array(this.cap * 4), 4).setUsage(DynamicDrawUsage);
    const t = instancedDynamicBufferAttribute<'vec4'>(this.boltTint, 'vec4');
    // positionLocal already includes the instance transform in Three r187. Use raw geometry space:
    // otherwise moving a shot along world Z turns its entire pigment head into ink (or vice versa).
    const along = positionGeometry.z.add(0.5);
    const bm = overlay(new MeshBasicNodeMaterial());
    // Plane ink/chalk is the contrasting keyline; pigment concentrates toward the advancing head.
    bm.colorNode = mix(byPlane(t.w.floor() as F1, LINE), t.xyz, smoothstep(0.05, 0.8, along));
    const visibility = t.w.floor().lessThan(2.5).select(float(1), seen('orbit', fogField));
    bm.opacityNode = fract(t.w).mul(smoothstep(0, 0.55, along).mul(0.65).add(0.35)).mul(visibility);
    this.bolts = new InstancedMesh(new BoxGeometry(1, 1, 1), bm, this.cap * 5);
    const bt = instancedDynamicBufferAttribute<'vec4'>(this.bodyTint, 'vec4');
    const sm = overlay(new MeshBasicNodeMaterial());
    // Both dark-card chalk and light-paper ink survive even on the dark bomb casing.
    sm.colorNode = mix(byPlane(bt.w.floor() as F1, LINE), bt.xyz, smoothstep(-0.3, 0.25, positionGeometry.z));
    sm.opacityNode = fract(bt.w).mul(bt.w.floor().lessThan(2.5).select(float(1), seen('orbit', fogField)));
    this.bodies = new InstancedMesh(new OctahedronGeometry(0.5, 0), sm, this.cap);
    for (const mesh of [this.bolts, this.bodies]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
    }
  }

  /** Arrival is absolute render-clock ms; equal launch/arrival means hitscan, not a fake 70 ms flight. */
  add(profile: ProjectileVisual, sp: number, sx: number, sy: number, sz: number, tp: number, ex: number, ey: number, ez: number, t0: number, arrive: number, c: Color, splash = 0, muzzle = true, target?: Track, source?: Track, barrel = 0): void {
    if (this.n >= this.cap) return;
    const i = this.n++, k = i * 3;
    this.profiles[i] = profile;
    this.targets[i] = target;
    this.sources[i] = source; this.barrels[i] = barrel;
    this.s[k] = sx; this.s[k + 1] = sy; this.s[k + 2] = sz;
    this.e[k] = ex; this.e[k + 1] = ey; this.e[k + 2] = ez;
    this.col[k] = c.r; this.col[k + 1] = c.g; this.col[k + 2] = c.b;
    this.t0[i] = t0; this.arrive[i] = Math.max(t0, arrive);
    this.sp[i] = sp; this.tp[i] = tp; this.splash[i] = splash;
    this.flags[i] = muzzle ? 0 : 1; this.trailStep[i] = -1;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i !== j) {
      for (let k = 0; k < 3; k++) {
        this.s[i * 3 + k] = this.s[j * 3 + k]!;
        this.e[i * 3 + k] = this.e[j * 3 + k]!;
        this.col[i * 3 + k] = this.col[j * 3 + k]!;
      }
      this.profiles[i] = this.profiles[j];
      this.targets[i] = this.targets[j];
      this.sources[i] = this.sources[j]; this.barrels[i] = this.barrels[j]!;
      this.t0[i] = this.t0[j]!; this.arrive[i] = this.arrive[j]!;
      this.sp[i] = this.sp[j]!; this.tp[i] = this.tp[j]!; this.splash[i] = this.splash[j]!;
      this.flags[i] = this.flags[j]!; this.trailStep[i] = this.trailStep[j]!;
    }
    this.profiles[j] = undefined;
    this.targets[j] = undefined;
    this.sources[j] = undefined;
  }

  private stroke(tx: number, ty: number, tz: number, hx: number, hy: number, hz: number, width: number, height: number, r: number, g: number, b: number, plane: number, opacity: number): void {
    const n = this.strokes++;
    projectileSegment(this.bolts.instanceMatrix.array as Float32Array, n, tx, ty, tz, hx, hy, hz, width, height);
    this.boltTint.setXYZW(n, r, g, b, plane + Math.min(0.999, opacity));
  }

  update(now: number, fx: Combat): void {
    this.strokes = this.solids = 0;
    for (let i = 0; i < this.n;) {
      const p = this.profiles[i]!, start = this.t0[i]!, arrival = this.arrive[i]!;
      const target = this.targets[i];
      if (target && (!target.visible || fx.tracks?.get(target.e.id) !== target)) { this.kill(i); continue; }
      if (now < start) { i++; continue; }
      const k = i * 3;
      const source = this.sources[i];
      if (source && (!(this.flags[i]! & 1) || p.shape === 'flame')) {
        if (!source.visible || source.e.cloaked || PIDX[source.e.plane] !== this.sp[i] || fx.tracks?.get(source.e.id) !== source) { this.kill(i); continue; }
        orbitMuzzle(this.point, source, this.barrels[i]!, now, fx.size);
        this.s[k] = this.point[0]!; this.s[k + 1] = this.point[1]!; this.s[k + 2] = this.point[2]!;
      }
      const sx = this.s[k]!, sy = this.s[k + 1]!, sz = this.s[k + 2]!;
      const ex = this.e[k]!, ey = this.e[k + 1]!, ez = this.e[k + 2]!;
      const r = this.col[k]!, g = this.col[k + 1]!, b = this.col[k + 2]!;
      // One-shot effects use the interpolation clock, never snapshot arrival. Delayed windows skip
      // stale bursts rather than replaying history; at most 120 ms of lateness is still legible feedback.
      if (!(this.flags[i]! & 1)) {
        this.flags[i] = this.flags[i]! | 1;
        if (now - start <= 80 && p.muzzle !== 'none') {
          TMP.setRGB(r, g, b);
          fx.sparks.spawn(this.sp[i]!, sx, sy, sz, 0, 0.2, 0, 0.09, p.muzzle === 'smoke' ? 0.36 : 0.18, 0.03, TMP, 1);
          if (p.muzzle === 'smoke') fx.smoke.spawn(this.sp[i]!, sx, sy, sz, 0, 0.6, 0, 0.65, 0.16, 0.4, COL.smoke, 0.45, 0, 1.5);
          if (source?.e.kind === 'tank' && source.e.state === 'sieged') {
            // a sieged artillery shot: a flash bloom, a fan of muzzle smoke and a dust ring blown off the ground round the hull
            fx.sparks.spawn(this.sp[i]!, sx, sy, sz, 0, 0.1, 0, 0.14, 0.7, 0.05, TMP, 1);
            for (let j = 0; j < 4; j++) fx.smoke.spawn(this.sp[i]!, sx, sy, sz, (hash2(j, i) - 0.5) * 1.6, 0.4 + hash2(i, j) * 0.4, (hash2(i + 7, j) - 0.5) * 1.6, 0.9, 0.24, 0.7, COL.smoke, 0.5, 0, 1.3);
            fx.rings.add(this.sp[i]!, wx(source.rx, fx.size), source.wy + 0.05, wz(source.ry, fx.size), 0.3, 1.6 * source.scale, now, 520, COL.dust, 0.55, RING.wash);
          }
        }
      }
      if (now >= arrival && !(this.flags[i]! & 2)) {
        this.flags[i] = this.flags[i]! | 2;
        if (now - arrival <= 120) {
          if (target && p.impact !== HIT.none) fx.orbitHit(target, ex, ey, ez, r, g, b, p.shape === 'beam' ? 'lancer' : p.shape === 'pulse' ? 'bastion' : 'skiff', now, this.tp[i]!, sx - ex, sy - ey, sz - ez);
          else if (p.impact !== HIT.none) fx.onHit(p.impact, this.tp[i]!, ex, ey, ez, r, g, b, this.splash[i]!, now);
        }
      }
      const instant = arrival === start;
      const end = instant ? start + p.hold : arrival;
      if (now >= end) { this.kill(i); continue; }
      if (p.shape === 'flame') {
        // Emission bookkeeping stays on the CPU; every free lobe, ember and puff is integrated by the shared pool.
        // Never catch up old slices after a stalled tab, nor emit twice for the same render-clock slice.
        const step = Math.floor((now - start) / (fx.reducedMotion ? 64 : 32));
        if (step > this.trailStep[i]!) {
          this.trailStep[i] = step;
          fx.flame(this.sp[i]!, sx, sy, sz, ex, ey, ez, step);
        }
        i++;
        continue;
      }
      const u = instant ? 1 : (now - start) / (arrival - start);
      projectilePoint(this.head, p.trajectory, u, sx, sy, sz, ex, ey, ez, p.arc);
      const hx = this.head[0]!, hy = this.head[1]!, hz = this.head[2]!;
      // Blend endpoint fade over the flight, rather than popping plane identity halfway across a gap.
      // Camera clipping uses the actual moving height; a visible launch must not resurrect a hidden bomb.
      const plane = u < 0.5 ? this.sp[i]! : this.tp[i]!;
      const fade = fadeValue[PLANES[this.sp[i]!]!] * (1 - u) + fadeValue[PLANES[this.tp[i]!]!] * u;
      const opacity = fade * Math.max(0, Math.min(1, (camY - hy - 2) / 6)) * (instant ? 1 - (now - start) / Math.max(1, p.hold) : 1);
      if (opacity <= 0.001) { i++; continue; }
      // Chord + twice the arc height estimates path length cheaply. This bounds the visible tail
      // in world tiles without an arc-length solver; only authoritative time controls head travel.
      const distance = Math.hypot(ex - sx, ey - sy, ez - sz) + p.arc * 2;
      const tailU = instant ? 0 : Math.max(0, u - p.tail / Math.max(0.001, distance));
      if (p.shape === 'spread') {
        // Shotgun pellets fan from the muzzle to ±spread at the target.
        const run = Math.hypot(ex - sx, ez - sz);
        const half = p.spread ?? 0;
        const nx = run > 1e-5 ? -(ez - sz) / run : 0, nz = run > 1e-5 ? (ex - sx) / run : 0;
        projectilePoint(this.tail, p.trajectory, tailU, sx, sy, sz, ex, ey, ez, p.arc);
        for (let n = -1; n <= 1; n++) {
          const fan = n * half;
          this.stroke(this.tail[0]! + nx * fan * tailU, this.tail[1]!, this.tail[2]! + nz * fan * tailU, hx + nx * fan * u, hy, hz + nz * fan * u, p.width, p.width, r, g, b, plane, opacity * (n ? 0.75 : 1));
        }
      } else if (p.shape === 'beam' || (instant && p.shape === 'streak')) {
        this.stroke(sx, sy, sz, ex, ey, ez, p.width, p.width, r, g, b, plane, opacity * 0.6);
        // A fine paper-coloured core makes a full-length beam distinct from the rifle's single stroke.
        if (p.shape === 'beam') this.stroke(sx, sy, sz, ex, ey, ez, p.width * 0.32, p.width * 0.32, COL.white.r, COL.white.g, COL.white.b, plane, opacity);
      } else if (p.shape !== 'contact' && p.tail > 0) {
        const segments = p.shape === 'pulse' ? 3 : p.trajectory === 'arc' ? 3 : 1;
        for (let n = 0; n < segments; n++) {
          const a = tailU + (u - tailU) * n / segments;
          const btime = tailU + (u - tailU) * (n + (p.shape === 'pulse' ? 0.62 : 1)) / segments;
          projectilePoint(this.tail, p.trajectory, a, sx, sy, sz, ex, ey, ez, p.arc);
          projectilePoint(this.point, p.trajectory, btime, sx, sy, sz, ex, ey, ez, p.arc);
          const width = p.width * (p.shape === 'shell' || p.shape === 'missile' ? 0.45 : 1);
          this.stroke(this.tail[0]!, this.tail[1]!, this.tail[2]!, this.point[0]!, this.point[1]!, this.point[2]!, width, width, r, g, b, plane, opacity * (0.35 + 0.65 * (n + 1) / segments));
        }
      }
      if (!instant && p.length > 0) {
        // Tangent-aligned bodies and fins do not tumble when the camera changes plane. The analytical
        // path is sampled just ahead, including at u=0 where a falling bomb has zero vertical velocity.
        projectilePoint(this.point, p.trajectory, Math.min(1, u + 0.001), sx, sy, sz, ex, ey, ez, p.arc);
        let dx = this.point[0]! - hx, dy = this.point[1]! - hy, dz = this.point[2]! - hz;
        const length = Math.hypot(dx, dy, dz);
        if (length > 1e-8) { dx /= length; dy /= length; dz /= length; }
        else { dx = 0; dy = p.shape === 'bomb' ? -1 : 0; dz = p.shape === 'bomb' ? 0 : 1; }
        const bx = hx - dx * p.length, by = hy - dy * p.length, bz = hz - dz * p.length;
        const body = this.solids++;
        projectileSegment(this.bodies.instanceMatrix.array as Float32Array, body, bx, by, bz, hx, hy, hz, p.width);
        this.bodyTint.setXYZW(body, r, g, b, plane + Math.min(0.999, opacity));
        if (p.shape === 'missile' || p.shape === 'bomb' || p.shape === 'flak') {
          // Crossed tail vanes / flak crossbars are geometric cues readable without weapon colour.
          const fin = p.width * (p.shape === 'flak' ? 2.5 : 2);
          this.stroke(bx, by, bz, bx + dx * 0.16, by + dy * 0.16, bz + dz * 0.16, fin, p.width * 0.25, r, g, b, plane, opacity);
          this.stroke(bx, by, bz, bx + dx * 0.16, by + dy * 0.16, bz + dz * 0.16, p.width * 0.25, fin, r, g, b, plane, opacity);
        }
      }
      // Absolute emission buckets are independent of frame dt. Skip missed buckets after a hitch;
      // never backfill an unbounded smoke burst. Identical timestamps cannot emit twice.
      const step = Math.floor((now - start) / 35);
      if (p.trail !== 'none' && step > this.trailStep[i]!) {
        this.trailStep[i] = step;
        if (p.trail === 'smoke') fx.smoke.spawn(plane, hx, hy, hz, 0, 0.25, 0, 0.55, 0.1, 0.29, COL.smoke, 0.35, 0, 1.5);
        else fx.sparks.spawn(plane, hx, hy + 0.2, hz, 0, 0.3, 0, 0.2, 0.1, 0.02, COL.ember, 0.8);
      }
      i++;
    }
    this.bolts.count = this.strokes; this.bodies.count = this.solids;
    this.bolts.instanceMatrix.needsUpdate = this.bodies.instanceMatrix.needsUpdate = true;
    this.boltTint.needsUpdate = this.bodyTint.needsUpdate = true;
  }

  clear(): void {
    this.profiles.fill(undefined);
    this.targets.fill(undefined);
    this.sources.fill(undefined);
    this.n = this.bolts.count = this.bodies.count = 0;
  }
}

// ---------------------------------------------------------------- Orbit pulse weapons
const ORBIT_LIFE = { lancer: 620, skiff: 140, bastion: 170 } as const;
const ORBIT_COOL = new Color('#8bdaef');

/**
 * Bounded, render-only locks. Only fogged FX can admit a lock; live tracks may move its ends, never
 * discover a shooter. Reference slots are allocated once. A hidden/deleted endpoint retires immediately.
 * The separate sleeve pass is the inexpensive halo: no lights, sprites, or postprocessing dependency.
 */
class OrbitShots {
  readonly bolts: InstancedMesh;
  readonly halos: InstancedMesh;
  private readonly cap = 128;
  private readonly tint = new InstancedBufferAttribute(new Float32Array(128 * 8 * 4), 4).setUsage(DynamicDrawUsage);
  private readonly glow = new InstancedBufferAttribute(new Float32Array(128 * 8 * 4), 4).setUsage(DynamicDrawUsage);
  private readonly source: (string | undefined)[] = new Array(this.cap);
  private readonly target: (string | undefined)[] = new Array(this.cap);
  private readonly kind: (OrbitWeapon | undefined)[] = new Array(this.cap);
  private readonly data = new Float64Array(this.cap * 12); // start, arrival, sx sy sz, ex ey ez, r g b, target plane
  private readonly hit = new Uint8Array(this.cap);
  private readonly muzzle = new Float64Array(3);
  n = 0;
  private count = 0;

  constructor() {
    const material = (attribute: InstancedBufferAttribute, halo: boolean) => {
      const t = instancedDynamicBufferAttribute<'vec4'>(attribute, 'vec4');
      const m = overlay(new MeshBasicNodeMaterial());
      if (halo) {
        m.blending = AdditiveBlending;
        m.side = DoubleSide;
      }
      // Hot, but not blown out: a warm core still outshines the scene without a solid white bar.
      m.colorNode = halo ? t.xyz : mix(t.xyz, color('#fff8e8').mul(1.65), 0.58);
      const feather = float(1).sub(smoothstep(0.12, 0.5, abs(positionGeometry.x)))
        .mul(float(1).sub(smoothstep(0.28, 0.5, abs(positionGeometry.z))));
      m.opacityNode = halo ? t.w.mul(feather) : t.w;
      return m;
    };
    const geometry = new BoxGeometry(1, 1, 1);
    this.bolts = new InstancedMesh(geometry, material(this.tint, false), this.cap * 8);
    this.halos = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material(this.glow, true), this.cap * 8);
    for (const mesh of [this.bolts, this.halos]) {
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
    }
  }

  add(kind: OrbitWeapon, source: string | undefined, target: string | undefined, start: number, arrival: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, c: Color, plane: number): void {
    if (this.n === this.cap) return;
    const i = this.n++, o = i * 12, d = this.data;
    this.source[i] = source; this.target[i] = target; this.kind[i] = kind; this.hit[i] = 0;
    d[o] = start; d[o + 1] = arrival; d[o + 2] = sx; d[o + 3] = sy; d[o + 4] = sz;
    d[o + 5] = ex; d[o + 6] = ey; d[o + 7] = ez;
    d[o + 8] = c.r; d[o + 9] = c.g; d[o + 10] = c.b; d[o + 11] = plane;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i !== j) {
      this.source[i] = this.source[j]; this.target[i] = this.target[j]; this.kind[i] = this.kind[j]; this.hit[i] = this.hit[j]!;
      for (let k = 0; k < 12; k++) this.data[i * 12 + k] = this.data[j * 12 + k]!;
    }
    this.source[j] = this.target[j] = this.kind[j] = undefined;
  }

  private stroke(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, width: number, r: number, g: number, b: number, opacity: number): void {
    const n = this.count++;
    projectileSegment(this.bolts.instanceMatrix.array as Float32Array, n, sx, sy, sz, ex, ey, ez, width);
    projectileSegment(this.halos.instanceMatrix.array as Float32Array, n, sx, sy, sz, ex, ey, ez, width * 3);
    this.tint.setXYZW(n, r, g, b, opacity);
    this.glow.setXYZW(n, r, g, b, opacity * 0.1);
  }

  update(now: number, fx: Combat): void {
    this.count = 0;
    for (let i = 0; i < this.n;) {
      const o = i * 12, d = this.data, kind = this.kind[i]!, start = d[o]!, age = now - start;
      const sourceId = this.source[i], targetId = this.target[i];
      const source = sourceId === undefined ? undefined : fx.tracks?.get(sourceId);
      let target = targetId === undefined ? undefined : fx.tracks?.get(targetId);
      if (age >= Math.max(ORBIT_LIFE[kind], d[o + 1]! - start + 1)
        || (sourceId !== undefined && (!source?.visible || source.e.plane !== 'orbit' || source.e.state === 'idle'))) { this.kill(i); continue; }
      if (age < 0) { i++; continue; }
      // A new *visible* public attack link may redirect a continuing lock. No link lookup can admit FX.
      const linked = source?.mountTarget ?? source?.e.link;
      if (source?.e.state === 'attacking' && linked) {
        const current = fx.tracks?.get(linked);
        if (current?.visible && current.e.side !== source.e.side && current.e.plane === PLANES[d[o + 11]!]) {
          target = current;
          this.target[i] = current.e.id;
        }
        else { this.kill(i); continue; }
      }
      if (targetId !== undefined && (!target?.visible || target.e.plane !== PLANES[d[o + 11]!])) { this.kill(i); continue; }
      const ex = target ? wx(target.rx, fx.size) : d[o + 5]!;
      const ey = target ? target.wy + 0.12 * target.scale : d[o + 6]!;
      const ez = target ? wz(target.ry, fx.size) : d[o + 7]!;
      const sx = source ? wx(source.rx, fx.size) : d[o + 2]!;
      const sy = source ? source.wy : d[o + 3]!;
      const sz = source ? wz(source.ry, fx.size) : d[o + 4]!;
      if (!this.hit[i] && now >= d[o + 1]!) {
        this.hit[i] = 1;
        if (now - d[o + 1]! <= 120) fx.orbitHit(target, ex, ey, ez, d[o + 8]!, d[o + 9]!, d[o + 10]!, kind, now, d[o + 11]!, sx - ex, sy - ey, sz - ez);
      }
      const pulse = orbitPulse(age, kind);
      const opacity = pulse * fadeValue.orbit * Math.max(0, Math.min(1, (camY - sy - 2) / 6));
      if (opacity > 0.001) {
        const barrels = source ? orbitMuzzle(this.muzzle, source, 0, now, fx.size) : kind === 'bastion' ? 2 : 1;
        for (let barrel = 0; barrel < barrels; barrel++) {
          if (source) orbitMuzzle(this.muzzle, source, barrel, now, fx.size);
          const mx = source ? this.muzzle[0]! : sx;
          const my = source ? this.muzzle[1]! : sy;
          const mz = source ? this.muzzle[2]! : sz + (kind === 'bastion' ? (barrel ? -0.53 : 0.53) * 1.35 : 0);
          const r = d[o + 8]!, g = d[o + 9]!, b = d[o + 10]!;
          // A finite, tracking muzzle flare holds with each pulse, not just the snapshot's first frame.
          const distance = Math.hypot(ex - mx, ey - my, ez - mz);
          const tip = Math.min(0.2 / Math.max(0.001, distance), 0.25);
          this.stroke(mx, my, mz, mx + (ex - mx) * tip, my + (ey - my) * tip, mz + (ez - mz) * tip, kind === 'lancer' ? 0.19 : 0.11, r, g, b, opacity);
          if (kind === 'lancer') {
            this.stroke(mx, my, mz, ex, ey, ez, 0.06 + pulse * 0.04, r, g, b, opacity * 0.65);
            const u = (age % 105) / 105;
            const tail = Math.max(0, u - 0.16);
            this.stroke(mx + (ex - mx) * tail, my + (ey - my) * tail, mz + (ez - mz) * tail, mx + (ex - mx) * u, my + (ey - my) * u, mz + (ez - mz) * u, 0.17, r, g, b, opacity);
          } else {
            const step = kind === 'skiff' ? 82 : 48;
            const phase = (age % step) / (kind === 'skiff' ? 58 : 29);
            const head = Math.min(1, phase);
            const tail = Math.max(0, head - (kind === 'skiff' ? 0.36 : 0.16));
            this.stroke(mx + (ex - mx) * tail, my + (ey - my) * tail, mz + (ez - mz) * tail, mx + (ex - mx) * head, my + (ey - my) * head, mz + (ez - mz) * head, kind === 'skiff' ? 0.085 : 0.038, r, g, b, opacity);
          }
        }
      }
      i++;
    }
    this.bolts.count = this.halos.count = this.count;
    this.bolts.instanceMatrix.needsUpdate = this.halos.instanceMatrix.needsUpdate = true;
    this.tint.needsUpdate = this.glow.needsUpdate = true;
  }

  clear(): void {
    this.source.fill(undefined); this.target.fill(undefined); this.kind.fill(undefined);
    this.n = this.bolts.count = this.halos.count = 0;
  }
}

/** Short, target-bound shield bubbles: shell hexes and an expanding impact wave share one draw call. */
class OrbitShields {
  readonly mesh: InstancedMesh;
  private readonly cap = 128;
  private readonly tracks: (Track | undefined)[] = new Array(this.cap);
  private readonly d = new Float64Array(this.cap * 6); // start, strength, break, r g b
  private readonly tint = new InstancedBufferAttribute(new Float32Array(128 * 4), 4).setUsage(DynamicDrawUsage);
  private readonly look = new InstancedBufferAttribute(new Float32Array(128 * 4), 4).setUsage(DynamicDrawUsage);
  private readonly directions = new Float32Array(this.cap * 3);
  private readonly direction = new InstancedBufferAttribute(new Float32Array(128 * 3), 3).setUsage(DynamicDrawUsage);
  n = 0;

  constructor(fogField?: FogField) {
    const t = instancedDynamicBufferAttribute<'vec4'>(this.tint, 'vec4');
    const lk = instancedDynamicBufferAttribute<'vec4'>(this.look, 'vec4');
    const p = positionGeometry;
    // Staggered nearest-centre cells form hexes, not a triangular wireframe over the ship.
    const q = vec2(atan(p.z, p.x).mul(3), p.y.mul(5));
    const a = fract(q).sub(0.5).mul(vec2(1, 1.732));
    const b = fract(q.add(0.5)).sub(0.5).mul(vec2(1, 1.732));
    const cell = a.dot(a).lessThan(b.dot(b)).select(a, b);
    const edge = max(abs(cell.x).mul(0.866).add(abs(cell.y).mul(0.5)), abs(cell.y));
    const hex = smoothstep(0.43, 0.49, edge);
    const direction = instancedDynamicBufferAttribute<'vec3'>(this.direction, 'vec3');
    const wave = float(1).sub(smoothstep(0.035, 0.12, abs(float(1).sub(p.normalize().dot(direction)).mul(0.5).sub(lk.x))));
    const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    m.blending = AdditiveBlending;
    m.colorNode = mix(t.xyz, color('#fff8e8').mul(2), lk.z.mul(float(1).sub(lk.x)));
    m.opacityNode = hex.mul(0.1).add(wave.mul(0.45)).add(lk.z.mul(0.12)).mul(t.w).mul(seen('orbit', fogField));
    this.mesh = new InstancedMesh(new IcosahedronGeometry(1, 2), m, this.cap);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
  }

  add(tr: Track, now: number, dx: number, dy: number, dz: number): void {
    if (this.n === this.cap) return;
    const i = this.n++, o = i * 6, strength = (tr.e.shield ?? 0) / Math.max(1, tr.e.maxShield ?? 1);
    const c = tr.e.side === 'neutral' ? COL.white : sideColor(tr.e.side);
    this.tracks[i] = tr;
    this.d[o] = now; this.d[o + 1] = strength; this.d[o + 2] = strength <= 0 ? 1 : 0;
    this.d[o + 3] = c.r; this.d[o + 4] = c.g; this.d[o + 5] = c.b;
    const length = Math.hypot(dx, dy, dz);
    this.directions[i * 3] = length > 1e-5 ? dx / length : 0;
    this.directions[i * 3 + 1] = length > 1e-5 ? dy / length : 1;
    this.directions[i * 3 + 2] = length > 1e-5 ? dz / length : 0;
  }

  update(now: number, tracks: Combat['tracks'], aegisRadius: number, renderTick: number, size: number): void {
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    let count = 0;
    for (let i = 0; i < this.n;) {
      const o = i * 6, tr = this.tracks[i]!, age = (now - this.d[o]!) / 440;
      if (age >= 1 || !tr.visible || tracks?.get(tr.e.id) !== tr) {
        const j = --this.n;
        this.tracks[i] = this.tracks[j]; this.tracks[j] = undefined;
        for (let k = 0; k < 6; k++) this.d[o + k] = this.d[j * 6 + k]!;
        for (let k = 0; k < 3; k++) this.directions[i * 3 + k] = this.directions[j * 3 + k]!;
        continue;
      }
      const broken = this.d[o + 2]!, scale = tr.scale * (1 + age * (broken ? 0.45 : 0.12));
      const k = count * 16;
      arr.fill(0, k, k + 16);
      arr[k] = scale * (tr.e.kind === 'lancer' ? 1.05 : 0.85); arr[k + 5] = scale * 0.58; arr[k + 10] = scale * 0.85;
      arr[k + 12] = wx(tr.rx, size); arr[k + 13] = tr.wy + 0.08; arr[k + 14] = wz(tr.ry, size); arr[k + 15] = 1;
      const opacity = (1 - age) * (0.45 + this.d[o + 1]! * 0.55) * fadeValue.orbit * Math.max(0, Math.min(1, (camY - tr.wy - 2) / 6));
      this.tint.setXYZW(count, this.d[o + 3]!, this.d[o + 4]!, this.d[o + 5]!, opacity);
      this.look.setXYZW(count, age, this.d[o + 1]!, broken, 0);
      this.direction.setXYZ(count, this.directions[i * 3]!, this.directions[i * 3 + 1]!, this.directions[i * 3 + 2]!);
      count++; i++;
    }
    // Sustained Aegis fields share the same hex-shell material and instance buffers as shield hits.
    if (aegisRadius > 0 && tracks) for (const tr of tracks.values()) {
      if (count === this.cap) break;
      const aegis = tr.e.aegis;
      if (!tr.visible || tr.e.hp <= 0 || tr.e.plane !== 'orbit' || !aegis || aegis.pool <= 0 || aegis.until <= renderTick) continue;
      const k = count * 16, c = sideColor(tr.e.side);
      arr.fill(0, k, k + 16);
      arr[k] = arr[k + 10] = aegisRadius; arr[k + 5] = aegisRadius * 0.55;
      arr[k + 12] = wx(tr.rx, size); arr[k + 13] = tr.wy; arr[k + 14] = wz(tr.ry, size); arr[k + 15] = 1;
      const opacity = 0.42 * fadeValue.orbit * Math.max(0, Math.min(1, (camY - tr.wy - 2) / 6));
      this.tint.setXYZW(count, c.r, c.g, c.b, opacity);
      this.look.setXYZW(count, (now * 0.0003) % 1, 1, 0, 1);
      this.direction.setXYZ(count++, 0, 1, 0);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = this.tint.needsUpdate = this.look.needsUpdate = this.direction.needsUpdate = true;
  }

  clear(): void { this.tracks.fill(undefined); this.n = this.mesh.count = 0; }
}

// ---------------------------------------------------------------- rings (shockwaves, washes, splats, scan pulses)
/** Ring styles: brushed ink loop, watercolour wash bloom, ink splat (lingers on the ground), dashed pencil ring. */
export const RING = { ink: 0, wash: 1, splat: 2, dash: 3, warning: 4 } as const;
type RingStyle = (typeof RING)[keyof typeof RING];

class Rings {
  readonly mesh: InstancedMesh;
  private readonly tint: InstancedBufferAttribute;
  private readonly look: InstancedBufferAttribute;
  private readonly cap = 192;
  n = 0;
  private readonly d = new Float32Array(this.cap * 14); // x y z r0 r1 t0 dur r g b a0 plane style seed
  private readonly attached: (Track | undefined)[] = new Array(this.cap);
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.tint = new InstancedBufferAttribute(new Float32Array(this.cap * 4), 4);
    this.tint.setUsage(DynamicDrawUsage);
    this.look = new InstancedBufferAttribute(new Float32Array(this.cap * 4), 4);
    this.look.setUsage(DynamicDrawUsage);
    const t = instancedDynamicBufferAttribute<'vec4'>(this.tint, 'vec4');
    const lk = instancedDynamicBufferAttribute<'vec4'>(this.look, 'vec4'); // style, seed, plane, -
    const q = uv().sub(0.5).mul(2);
    const r = q.length();
    const a = atan(q.y, q.x);
    const seed = lk.y;
    const n = mx_noise_float(vec3(q.mul(2.2), seed.mul(7)));
    const aa = fwidth(r).mul(1.5);
    // ink: one brushed loop whose pressure varies along the stroke
    const press = sin(a.mul(3).add(seed.mul(6.28))).mul(0.5).add(0.5);
    const w = press.mul(0.05).add(0.03);
    const loop = float(1).sub(smoothstep(w.sub(aa), w.add(aa), abs(r.add(n.mul(0.035)).sub(0.9))));
    // wash: watercolour bloom, pigment pooling darker at the rim
    const wr = r.add(n.mul(0.12));
    const body = float(1).sub(smoothstep(0.8, 0.88, wr));
    const rim = smoothstep(0.55, 0.85, wr).mul(body);
    // splat: a jagged ink blot with flung droplets
    const spikes = abs(sin(a.mul(4.5).add(seed.mul(17)))).pow(6).mul(0.3);
    const blot = float(1).sub(smoothstep(0, aa.mul(2).add(0.03), r.sub(spikes.add(n.mul(0.1)).add(0.46))));
    const drops = smoothstep(0.42, 0.5, mx_noise_float(vec3(q.mul(5.5), seed.mul(7).add(9)))).mul(smoothstep(0.5, 0.62, r)).mul(float(1).sub(smoothstep(0.88, 0.98, r)));
    const splat = max(blot, drops);
    // dash: construction pencil
    const dashes = float(1).sub(smoothstep(0.55, 0.62, fract(a.mul(28 / (2 * PI)))));
    const pencil = float(1).sub(smoothstep(aa.add(0.012), aa.add(0.03), abs(r.sub(0.92)))).mul(dashes);
    const st = lk.x;
    const inkOf = byPlane(lk.z as F1, INK);
    const lineOf = byPlane(lk.z as F1, LINE);
    const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    m.colorNode = st.lessThan(0.5).select(
      mix(t.xyz, lineOf, 0.4),
      st.lessThan(1.5).select(t.xyz.mul(float(1).sub(rim.mul(0.35))), st.lessThan(2.5).select(mix(inkOf, t.xyz, smoothstep(0.3, 0, r).mul(0.65)), t.xyz)),
    );
    const k = st.lessThan(0.5).select(loop, st.lessThan(1.5).select(body.mul(0.32).add(rim.mul(0.45)), st.lessThan(2.5).select(splat.mul(0.85), pencil)));
    m.opacityNode = k.mul(t.w);
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
    this.mesh = new InstancedMesh(new PlaneGeometry(2, 2).rotateX(-PI / 2), m, this.cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  add(plane: number, x: number, y: number, z: number, r0: number, r1: number, t0: number, dur: number, c: Color, a0: number, style: RingStyle = RING.ink, target?: Track): void {
    if (this.n >= this.cap) return;
    const o = this.n++ * 14;
    const d = this.d;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = r0; d[o + 4] = r1; d[o + 5] = t0; d[o + 6] = dur;
    d[o + 7] = c.r; d[o + 8] = c.g; d[o + 9] = c.b; d[o + 10] = a0; d[o + 11] = plane; d[o + 12] = style;
    d[o + 13] = hash2(Math.round(x * 17), Math.round(z * 13 + t0));
    this.attached[o / 14] = target;
    if (target) {
      d[o] = x - wx(target.rx, this.size); d[o + 1] = y - target.wy; d[o + 2] = z - wz(target.ry, this.size);
    }
  }

  update(now: number, tracks?: ReadonlyMap<string, Track>): void {
    const d = this.d;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const tint = this.tint.array as Float32Array;
    const look = this.look.array as Float32Array;
    let i = 0;
    let out = 0;
    while (i < this.n) {
      const o = i * 14;
      const k = (now - d[o + 5]!) / d[o + 6]!;
      const target = this.attached[i];
      if (k >= 1 || (target && (!target.visible || tracks?.get(target.e.id) !== target))) {
        const last = --this.n * 14;
        for (let q = 0; q < 14; q++) d[o + q] = d[last + q]!;
        this.attached[i] = this.attached[this.n]; this.attached[this.n] = undefined;
        continue;
      }
      i++;
      if (k < 0) continue;
      const e = 1 - (1 - k) * (1 - k);
      const r = d[o + 3]! + (d[o + 4]! - d[o + 3]!) * e;
      const m = out * 16;
      arr[m] = r; arr[m + 1] = 0; arr[m + 2] = 0; arr[m + 3] = 0;
      arr[m + 4] = 0; arr[m + 5] = 1; arr[m + 6] = 0; arr[m + 7] = 0;
      arr[m + 8] = 0; arr[m + 9] = 0; arr[m + 10] = r; arr[m + 11] = 0;
      const y = d[o + 1]! + (target?.wy ?? 0);
      arr[m + 12] = d[o]! + (target ? wx(target.rx, this.size) : 0); arr[m + 13] = y; arr[m + 14] = d[o + 2]! + (target ? wz(target.ry, this.size) : 0); arr[m + 15] = 1;
      const t = out * 4;
      const style = d[o + 12]!;
      // splats hold, then dry out; the rest fade as they spread
      const fade = style === RING.warning ? 0.65 + 0.35 * k : style === RING.splat ? 1 - k * k * k : 1 - k;
      tint[t] = d[o + 7]!; tint[t + 1] = d[o + 8]!; tint[t + 2] = d[o + 9]!;
      tint[t + 3] = d[o + 10]! * fade * vis(d[o + 11]!, y);
      look[t] = style; look[t + 1] = d[o + 13]!; look[t + 2] = d[o + 11]!; look[t + 3] = 0;
      out++;
    }
    this.mesh.count = out;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.tint.needsUpdate = true;
    this.look.needsUpdate = true;
  }

  clear(): void {
    this.attached.fill(undefined);
    this.n = 0;
    this.mesh.count = 0;
  }
}

/** Combat heat on a coarse grid per plane (4×4-tile cells): where the fights are. */
export const HEAT_CELL = 4;

interface CombatPools {
  sparks: ParticlePool;
  smoke: ParticlePool;
  debris: ParticlePool;
  shots: Projectiles;
  rings: Rings;
  orbitShots: OrbitShots;
  orbitShields: OrbitShields;
}

/** Live particles per pool: sparks and flashes, smoke and dust puffs, debris chunks. */
export const PARTICLE_CAPS = { sparks: 1600, smoke: 700, debris: 500 } as const;

/**
 * Each pool is a bounded startup task; no effect mesh or material is deferred until the first hit. `gpu`: the particle
 * pools simulate in WebGPU compute (`gpu-particles.ts`); otherwise on the CPU.
 */
function* combatPools(size: number, fogField: FogField | undefined, gpu: boolean): Generator<void, CombatPools> {
  const sparks = createParticles({ cap: PARTICLE_CAPS.sparks, geo: new OctahedronGeometry(1, 0), additive: true, lit: false }, gpu, fogField);
  yield;
  const smoke = createParticles({ cap: PARTICLE_CAPS.smoke, geo: new IcosahedronGeometry(1, 0), additive: false, lit: true }, gpu, fogField);
  yield;
  const debris = createParticles({ cap: PARTICLE_CAPS.debris, geo: new DodecahedronGeometry(1, 0), additive: false, lit: true }, gpu, fogField);
  yield;
  const shots = new Projectiles(fogField);
  yield;
  const rings = new Rings(size);
  yield;
  const orbitShots = new OrbitShots();
  yield;
  const orbitShields = new OrbitShields(fogField);
  yield;
  return { sparks, smoke, debris, shots, rings, orbitShots, orbitShields };
}

export class Combat {
  readonly root = new Group();
  readonly sparks: ParticlePool;
  readonly smoke: ParticlePool;
  readonly debris: ParticlePool;
  /** The particle pools and their compute kernels, dispatched together once per frame (`dispatch`). */
  private readonly pools: readonly ParticlePool[];
  private readonly kernels: readonly ComputeNode[];
  /** Burning ground (`view.scorches`): flames, embers and smoke spawned into the pools above. */
  private readonly fire: ScorchFire;
  private scorches: NonNullable<View['scorches']> = [];
  readonly shots: Projectiles;
  readonly rings: Rings;
  /** The existing fogged entity map, never an unfogged sim lookup. Wired once by World. */
  tracks: ReadonlyMap<string, Track> | undefined;
  readonly orbitShots: OrbitShots;
  readonly orbitShields: OrbitShields;
  /** Deaths: every `death` record of the view, played by its kind's profile (`death-fx.ts`). */
  readonly deaths: DeathPlayer;
  private lastTick = -1;
  /** Camera shake request (0..1), consumed by the camera rig. */
  shake = 0;
  focus: Plane = 'surface';
  private readonly motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  get reducedMotion(): boolean { return this.motion?.matches ?? false; }
  private flameCone = WEAPON_VISUALS.flamer.cone!;
  private heatT = 0;
  /** Sequence feeding the damaged look's deterministic emission jitter. */
  private damageSeq = 0;
  private aegisRadius = 0;
  private at2: (tick: number) => number = (tick) => tick * (1000 / TICK_RATE);
  /** Timestamped payload terminations; only entries received in the fog-filtered FX list are queued. */
  private readonly pendingBursts: { event: FxEntry; radius: number; volatile: boolean }[] = [];
  /** Knowledge actually received while a public fall was alive, never a guess from HP or public blast markers. */
  private readonly knownFalls = new Map<string, { radius: number; volatile: boolean }>();
  /** Fogged, immutable mortar impact warnings survive reconnect and late entry into vision, without replaying shells. */
  private readonly mortarWarnings = new Map<string, number>();
  /** This view's public falls: shots at a falling rock end where the rock is drawn (`aim.ts`). */
  private impacts: View['impacts'] = [];
  readonly size: number;
  private readonly terrain: TerrainField;
  readonly heatN: number;
  readonly heat: Record<Plane, Float32Array>;

  private addHeat(plane: Plane, x: number, y: number, v: number): void {
    const cx = Math.min(this.heatN - 1, Math.max(0, Math.floor(x / HEAT_CELL)));
    const cy = Math.min(this.heatN - 1, Math.max(0, Math.floor(y / HEAT_CELL)));
    const h = this.heat[plane];
    const i = cy * this.heatN + cx;
    h[i] = Math.min(4, h[i]! + v);
  }

  static async create(size: number, terrain?: TerrainField, fogField?: FogField, gpu = false): Promise<Combat> {
    return new Combat(await prepareStartup(combatPools(size, fogField, gpu)), size, terrain, fogField);
  }

  /** Synchronous construction shares the exact pool recipes with offline renderers and tests (CPU particles). */
  constructor(prepared: CombatPools | undefined, size: number, terrain = new TerrainField(size), fogField?: FogField) {
    this.size = size;
    this.terrain = terrain;
    this.heatN = size / HEAT_CELL;
    const n = this.heatN * this.heatN;
    this.heat = { depths: new Float32Array(n), surface: new Float32Array(n), sky: new Float32Array(n), orbit: new Float32Array(n) };
    if (!prepared) {
      const tasks = combatPools(size, fogField, false);
      let next = tasks.next();
      while (!next.done) next = tasks.next();
      prepared = next.value;
    }
    this.sparks = prepared.sparks;
    this.smoke = prepared.smoke;
    this.debris = prepared.debris;
    this.pools = [this.sparks, this.smoke, this.debris];
    this.kernels = this.pools.flatMap((pool) => pool.kernels);
    this.fire = new ScorchFire(size, terrain);
    this.shots = prepared.shots;
    this.rings = prepared.rings;
    this.orbitShots = prepared.orbitShots;
    this.orbitShields = prepared.orbitShields;
    this.root.renderOrder = 75; // groupOrder: after layers, entities and markers
    this.root.add(this.debris.mesh, this.shots.bodies, this.smoke.mesh, this.orbitShots.halos, this.sparks.mesh, this.shots.bolts, this.orbitShots.bolts, this.orbitShields.mesh, this.rings.mesh);
    this.deaths = new DeathPlayer({ sparks: this.sparks, smoke: this.smoke, debris: this.debris, rings: this.rings }, size, terrain, fogField, () => this.reducedMotion);
  }

  /** Run this frame's particle compute (WebGPU pools only), after every spawn and before the frame renders. */
  dispatch(renderer: Renderer): void {
    dispatchParticles(renderer, this.pools, this.kernels);
  }

  reset(): void {
    this.lastTick = -1;
    this.pendingBursts.length = 0;
    this.deaths.reset();
    this.knownFalls.clear();
    this.mortarWarnings.clear();
    this.impacts = [];
    this.scorches = [];
    this.fire.reset();
    this.sparks.clear();
    this.smoke.clear();
    this.debris.clear();
    this.shots.clear();
    this.rings.clear();
    this.orbitShots.clear();
    this.orbitShields.clear();
    this.shake = this.heatT = 0;
    for (const p of PLANES) this.heat[p].fill(0);
  }

  /** `at(tick)` maps a server tick to the performance.now() time it is rendered (see Entities.tickTime). */
  ingest(view: View, at: (tick: number) => number): void {
    this.at2 = at;
    this.impacts = view.impacts;
    this.scorches = view.scorches ?? NO_SCORCHES;
    this.flameCone = view.match!.rules.surface.breacherConeArc * PI / 360;
    const orbit = view.match!.rules.orbit;
    this.aegisRadius = orbit.aegisRadius;
    for (const fall of view.impacts) {
      const rock = view.entities.find(e => e.id === fall.id);
      if (rock?.volatile === undefined) continue;
      const volatile = rock.volatile;
      const radius = (fall.radius ?? orbit.impactRadius) * (volatile ? orbit.volatileRadiusMultiplier : 1);
      const known = this.knownFalls.get(fall.id);
      if (!known || known.radius !== radius || known.volatile !== volatile) this.knownFalls.set(fall.id, { radius, volatile });
    }
    const first = this.lastTick < 0;
    let max = this.lastTick;
    let digs = 0;
    for (const [key, until] of this.mortarWarnings) if (until < view.tick) this.mortarWarnings.delete(key);
    for (const f of view.fx) {
      if (f.kind === 'shot' && f.subject === 'island_mortar' && f.arrive !== undefined && f.arrive >= view.tick) {
        const tx = f.tx ?? f.x, ty = f.ty ?? f.y;
        const key = `${f.tick}:${f.arrive}:${tx}:${ty}`;
        if (!this.mortarWarnings.has(key)) {
          this.mortarWarnings.set(key, f.arrive);
          const height = PLANE_Y.surface + groundAt(tx, ty, this.terrain) + 0.08;
          const blast = ruleTables(view.match!.rules).stats.island_mortar.splash;
          this.rings.add(PIDX.surface, wx(tx, this.size), height, wz(ty, this.size), blast, blast, at(view.tick), Math.max(1, at(f.arrive) - at(view.tick)), COL.fire, 0.9, RING.warning);
        }
      }
      if (f.tick <= this.lastTick) continue;
      if (f.tick > max) max = f.tick;
      // Keep a still-travelling lance on join; other stale bursts must not replay.
      if (first && f.tick < view.tick - 2 && !((f.kind === 'lance' || (f.kind === 'shot' && f.subject === 'island_mortar')) && (f.arrive ?? 0) >= view.tick)) continue;
      if (f.kind === 'dig' && ++digs > 12) continue;
      if (f.kind === 'death') {
        // played from the frame its tick is on screen, anchored on the corpse when Entities kept one
        const [x, y, z] = this.at(f.plane, f.x, f.y);
        this.deaths.add(f, x, y + (f.sourceElevation ?? 0), z, at(f.tick));
        this.addHeat(f.plane, f.x, f.y, deathProfile(f.subject ?? 'trooper').heat);
        continue;
      }
      // Particle pools spawn immediately (unlike timestamped rings). Wait for the same render tick
      // that retires the falling rock, rather than flashing at snapshot arrival.
      let look = f.kind === 'impact' ? impactLook(view, f) : undefined;
      if (f.kind === 'impact' && f.fall && !look?.volatile) look = this.knownFalls.get(f.fall.id) ?? look;
      if (f.kind === 'volatile_detonation' || f.kind === 'core_vent' || (f.fall && (f.kind === 'intercept' || f.kind === 'impact')))
        this.pendingBursts.push({ event: f, radius: f.radius ?? look?.radius ?? (f.kind === 'volatile_detonation' ? orbit.volatileOrbitRadius : ECON.impactRadius), volatile: look?.volatile ?? false });
      else this.spawn(f, at(f.tick), f.radius ?? look?.radius, look?.volatile);
    }
    for (const id of this.knownFalls.keys())
      if (!view.impacts.some(f => f.id === id)) this.knownFalls.delete(id);
    this.lastTick = Math.max(max, view.tick - 10);
  }

  private at(plane: Plane, x: number, y: number): [number, number, number] {
    P[0] = wx(x, this.size);
    P[1] = PLANE_Y[plane] + LIFT[plane] + (plane === 'surface' ? groundAt(x, y, this.terrain) : 0);
    P[2] = wz(y, this.size);
    return P;
  }

  private spawn(f: FxEntry, t0: number, radius: number = ECON.impactRadius, volatile = false): void {
    const pi = PIDX[f.plane];
    let [x, y, z] = this.at(f.plane, f.x, f.y);
    y += f.sourceElevation ?? 0;
    // Interception is airborne: use the event's immutable trajectory, never arrival time or camera focus.
    // A real impact deliberately keeps the ground/terrain anchor above, including its ground shockwaves.
    if (f.kind === 'intercept' && f.fall) {
      asteroidPosition(f.fall, f.tick, FALL_POSITION, this.size);
      x = FALL_POSITION.x;
      y = FALL_POSITION.y;
      z = FALL_POSITION.z;
    }
    const h = hash2(f.tick * 31 + Math.round(f.x * 10), Math.round(f.y * 10));
    switch (f.kind) {
      case 'shot':
        return this.shot(f, t0, pi, x, y, z, h);
      case 'lance':
        if (f.tx !== undefined && f.ty !== undefined && f.arrive !== undefined)
          this.shots.add(SUN_LANCE_VISUAL, pi, x, y, z, pi, wx(f.tx, this.size), y, wz(f.ty, this.size), t0, this.at2(f.arrive), SUN_LANCE_COLOR, 0, false);
        return;
      case 'lance_hit':
        this.onHit(HIT.spark, pi, x, y, z, SUN_LANCE_COLOR.r, SUN_LANCE_COLOR.g, SUN_LANCE_COLOR.b, 0, t0);
        this.rings.add(pi, x, y, z, 0.12, 0.9, t0, 400, SUN_LANCE_COLOR, 0.85, RING.ink);
        return;
      case 'collapse': {
        const sy = PLANE_Y.surface + 0.2;
        const dy = PLANE_Y.depths + 0.6;
        const R = ECON.collapseRadius;
        this.rings.add(1, x, sy, z, 0.3, R * 1.8, t0, 900, COL.dust, 0.65, RING.wash);
        this.rings.add(1, x, sy, z, 0.3, R * 1.6, t0 + 80, 800, COL.debris, 0.85, RING.ink);
        this.rings.add(1, x, sy - 0.1, z, R * 0.8, R * 1.1, t0, 4200, COL.debris, 0.75, RING.splat);
        for (let i = 0; i < 26; i++) {
          const a = (i / 26) * PI * 2;
          const r = 0.4 + hash2(i, f.tick) * 1.4;
          this.smoke.spawn(1, x + Math.cos(a) * r * 0.6, sy, z + Math.sin(a) * r * 0.6, Math.cos(a) * 1.6, 1.2 + hash2(f.tick, i) * 1.5, Math.sin(a) * 1.6, 1.6, 0.3, 0.9, COL.dust, 0.75, 0.6, 1.2);
        }
        // debris falls through the new hole into the Depths
        for (let i = 0; i < 18; i++) {
          const ox = (hash2(i, 3) - 0.5) * 2;
          const oz = (hash2(i, 7) - 0.5) * 2;
          this.debris.spawn(1, x + ox, sy - 0.2, z + oz, ox * 0.3, -1 - hash2(i, 9) * 2, oz * 0.3, 1.9, 0.18 + hash2(i, 5) * 0.14, 0.18, COL.debris, 1, 14, 0, dy);
        }
        this.rings.add(0, x, dy, z, 0.3, R * 1.5, t0 + 600, 900, COL.dust, 0.6, RING.wash);
        // the charge itself goes off in its Depths cell, where its model vanishes (`charges.ts`)
        this.explode(0, x, PLANE_Y.depths + LIFT.depths, z, 0.8, t0);
        this.shake = Math.max(this.shake, this.focus === 'surface' || this.focus === 'depths' ? 0.6 : 0.2);
        this.addHeat(f.plane, f.x, f.y, 2);
        return;
      }
      case 'impact': {
        for (const pl of f.plane === 'sky' ? IMPACT_SKY : IMPACT_GROUND) {
          const [ix, iy, iz] = this.at(pl, f.x, f.y);
          const pp = PIDX[pl];
          this.rings.add(pp, ix, iy - 0.3, iz, 0.5, radius * 2.6, t0, 1100, COL.fire, 0.8, RING.wash);
          this.rings.add(pp, ix, iy - 0.3, iz, 0.2, radius * 1.4, t0 + 120, 800, COL.debris, 0.9, RING.ink);
        }
        this.explode(pi, x, y, z, 3.2 * radius / ECON.impactRadius, t0);
        if (volatile) this.rings.add(pi, x, y - 0.25, z, radius * 0.4, radius * 1.8, t0 + 180, 1400, COL.ember, 0.9, RING.dash);
        this.shake = Math.max(this.shake, this.focus === 'surface' || this.focus === 'sky' ? 1 : 0.3);
        this.addHeat(f.plane, f.x, f.y, 3);
        return;
      }
      case 'core_vent':
        // A surviving payload purges heat: steam and a pale pressure ring, never fire/debris or a death shake.
        this.rings.add(pi, x, y, z, 0.2, radius, t0, 1000, COL.dust, 0.6, RING.wash);
        for (let i = 0; i < 8; i++) {
          const a = i * PI / 4;
          this.smoke.spawn(pi, x, y, z, Math.cos(a) * 1.4, 0.6, Math.sin(a) * 1.4, 1.2, 0.2, 0.7, COL.dust, 0.6, 0, 1);
        }
        return;
      case 'volatile_detonation':
        // An Orbit-only, chalk-edged amber burst: no Surface scorch or cross-plane impact rings.
        this.explode(pi, x, y, z, radius / 2, t0);
        this.rings.add(pi, x, y, z, 0.15, radius, t0, 700, COL.ember, 1, RING.dash);
        this.shake = Math.max(this.shake, this.focus === 'orbit' ? 0.8 : 0.15);
        this.addHeat(f.plane, f.x, f.y, 3);
        return;
      case 'dig':
        this.smoke.spawn(pi, x, y, z, (h - 0.5) * 0.6, 0.5, (hash2(f.tick, 3) - 0.5) * 0.6, 0.8, 0.12, 0.35, COL.dust, 0.55, 0, 2);
        this.sparks.spawn(pi, x, y + 0.1, z, (h - 0.5) * 2, 1.5, (0.5 - h) * 2, 0.3, 0.06, 0.02, COL.spark, 1, 6);
        return;
      case 'deliver':
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * PI * 2 + h;
          this.sparks.spawn(pi, x + Math.cos(a) * 0.3, y, z + Math.sin(a) * 0.3, Math.cos(a) * 0.3, 1.4 + i * 0.1, Math.sin(a) * 0.3, 0.9, 0.09, 0.02, COL.gold, 1, -0.5);
        }
        return;
      case 'core_cashed':
        // The derelict core cashed in at an Orbit segment: a gold double ring and a fountain of gold sparks.
        this.rings.add(pi, x, y, z, 0.3, 3.2, t0, 1200, COL.gold, 1, RING.dash);
        this.rings.add(pi, x, y, z, 0.1, 2, t0 + 200, 1000, COL.gold, 0.7, RING.ink);
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * PI * 2 + h;
          this.sparks.spawn(pi, x + Math.cos(a) * 0.5, y, z + Math.sin(a) * 0.5, Math.cos(a) * 0.8, 1.8 + (i % 3) * 0.2, Math.sin(a) * 0.8, 1.2, 0.11, 0.02, COL.gold, 1, -0.5);
        }
        return;
      case 'scan':
        for (const pl of PLANES) {
          const [sx, sy, sz] = this.at(pl, f.x, f.y);
          const pp = PIDX[pl];
          this.rings.add(pp, sx, sy, sz, 0.3, ECON.scanRadius, t0 + pp * 90, 1300, COL.scan, 1, RING.dash);
          this.rings.add(pp, sx, sy, sz, 0.1, ECON.scanRadius * 0.7, t0 + pp * 90 + 250, 1100, COL.scan, 0.6, RING.ink);
        }
        this.shots.add(EFFECT_VISUALS.scan, 0, x, PLANE_Y.depths, z, 3, x, PLANE_Y.orbit + 2, z, t0, t0, COL.scan);
        return;
      case 'breach':
        this.rings.add(pi, x, y, z, 0.2, 2.2, t0, 700, COL.fire, 0.7, RING.wash);
        this.rings.add(pi, x, y - LIFT[f.plane] + 0.05, z, 1, 1.4, t0, 3500, COL.debris, 0.7, RING.splat);
        for (let i = 0; i < 10; i++) this.smoke.spawn(pi, x, y, z, (hash2(i, 1) - 0.5) * 2, 0.6, (hash2(i, 2) - 0.5) * 2, 1.1, 0.2, 0.6, COL.dust, 0.6, 0, 1.5);
        return;
      case 'intercept':
        this.rings.add(pi, x, y, z, 0.2, 3, t0, 600, COL.scan, 1);
        this.explode(pi, x, y, z, 1.6, t0);
        this.addHeat(f.plane, f.x, f.y, 1);
        return;
      case 'deorbit':
        this.rings.add(pi, x, y, z, 0.3, 2.4, t0, 700, COL.fire, 1);
        for (let i = 0; i < 12; i++) this.sparks.spawn(pi, x, y, z, (hash2(i, 4) - 0.5) * 3, -2 - hash2(i, 6) * 2, (hash2(i, 8) - 0.5) * 3, 0.6, 0.12, 0.03, COL.fire, 1);
        return;
      case 'portal': {
        const to = f.tp ?? f.plane;
        // both ends, as two calls (no per-event array)
        this.portalMark(f.plane, f.x, f.y, t0);
        this.portalMark(to, f.x, f.y, t0);
        const [ax, ay, az] = this.at(f.plane, f.x, f.y);
        const [bx, by, bz] = this.at(to, f.x, f.y);
        this.shots.add(EFFECT_VISUALS.portal, pi, ax, ay, az, PIDX[to], bx, by, bz, t0, t0 + 500, COL.portal);
        return;
      }
      case 'defuse': {
        this.rings.add(pi, x, y, z, 0.2, 1.8, t0, 700, COL.green, 1);
        for (let i = 0; i < 8; i++) this.sparks.spawn(pi, x, y, z, (hash2(i, 2) - 0.5) * 2, 1, (hash2(i, 5) - 0.5) * 2, 0.5, 0.08, 0.02, COL.green, 1, 3);
        // the fizzle: the cut fuse spits a few dying sparks onto the floor under a small grey puff
        const fy = y - LIFT[f.plane] + 0.2;
        for (let i = 0; i < 5; i++) {
          const u = hash2(i, f.tick), v = hash2(f.tick, i + 3);
          this.sparks.spawn(pi, x + (u - 0.5) * 0.2, fy, z + (v - 0.5) * 0.2, (u - 0.5) * 0.8, 0.5 + v * 0.6, (v - 0.5) * 0.8, 0.35 + u * 0.2, 0.05, 0.01, COL.flare, 1, 6, 0, fy - 0.2);
          this.smoke.spawn(pi, x + (v - 0.5) * 0.3, fy + 0.05, z + (u - 0.5) * 0.3, (u - 0.5) * 0.2, 0.35 + u * 0.3, (v - 0.5) * 0.2, 1 + v * 0.5, 0.1, 0.38, COL.smoke, 0.6, 0, 0.8);
        }
        return;
      }
      case 'flare': {
        // A seen thrower lobs it along a short arc (sparks where it lands); then it ignites: a flash wash and a dashed
        // ring at the landing cell. The lingering light is the view's `flares` list (awareness.ts), not this burst.
        const thrower = f.src ? this.tracks?.get(f.src) : undefined;
        let lit = t0;
        if (thrower?.visible && thrower.e.plane === f.plane) {
          lit = t0 + FLARE_THROW_MS;
          this.shots.add(EFFECT_VISUALS.flare, pi, wx(thrower.rx, this.size), y, wz(thrower.ry, this.size), pi, x, y - 0.35, z, t0, lit, COL.flare, 0, false);
        } else {
          for (let i = 0; i < 6; i++) this.sparks.spawn(pi, x, y - 0.3, z, (hash2(i, 3) - 0.5) * 2, 1.2, (hash2(i, 7) - 0.5) * 2, 0.45, 0.08, 0.02, COL.flare, 1, 4);
        }
        this.rings.add(pi, x, y - 0.4, z, 0.1, 1.2, lit, 600, COL.flare, 0.9, RING.wash);
        this.rings.add(pi, x, y - 0.4, z, 0.3, 2.4, lit + 80, 900, COL.flare, 0.6, RING.dash);
        return;
      }
    }
  }

  private shot(f: FxEntry, t0: number, pi: number, x: number, y: number, z: number, h: number): void {
    const st = f.subject !== undefined && isStatKind(f.subject) ? STATS[f.subject] : undefined;
    const weapon = f.w ?? st?.weapon;
    if (!weapon) return;
    const profile = f.subject !== undefined && isStatKind(f.subject)
      ? UNIT_WEAPON_VISUALS[f.subject] ?? WEAPON_VISUALS[weapon] : WEAPON_VISUALS[weapon];
    const modelScale = st?.footprint && f.subject !== 'spire' ? footprintModelScale(f.subject!, model(f.subject!)) / 1.35 : 1;
    this.addHeat(f.plane, f.x, f.y, 0.12);
    let sx = x, sy = y, sz = z, ex: number, ey: number, ez: number, tpi: number;
    const visibleSource = f.tp !== undefined && f.tx !== undefined && f.ty !== undefined;
    // A shot leaving its own plane, or at a falling rock, ends at the target's real 3D position (aim.ts); the mount
    // that fired it elevates toward the very same point (Entities.fire). Same-plane shots keep their nominal ends.
    const aimed = crossPlaneAim(AIM, f, this.impacts, this.tracks, this.size, this.terrain);
    const rock = aimed && AIM.fall !== undefined;
    if (f.tp !== undefined && f.tx !== undefined && f.ty !== undefined) {
      ex = wx(f.tx, this.size); ez = wz(f.ty, this.size); tpi = PIDX[f.tp];
      // FX has no target entity id/kind. Aim at the nominal body centre on its real plane, not at
      // the camera's focused plane or the sky island deck. Small per-entity hover/zoom bob is cosmetic.
      ey = unitY(f.tp) + (f.tp === 'sky' ? 1.6 : f.tp === 'orbit' ? 0.2 : 0.35)
        + (f.targetElevation ?? 0) + (f.tp === 'surface' ? groundAt(f.tx, f.ty, this.terrain) : 0);
      if (aimed && f.subject !== 'island_mortar') { ex = AIM.x; ey = AIM.y; ez = AIM.z; }
      // A falling rock is drawn whenever an upper plane shows, not by its logical Sky plane's fade: the tracer keeps
      // its shooter's plane (fade, ink) all the way up to it.
      if (rock) tpi = pi;
      sy = unitY(f.plane) + profile.height * modelScale + (f.plane === 'sky' ? st?.footprint ? 0.05 : 1.6 : f.plane === 'orbit' ? 0.2 : 0)
        + (f.sourceElevation ?? 0) + (f.plane === 'surface' ? groundAt(f.x, f.y, this.terrain) : 0);
      // Unscaled landmark cores share their visual anchor with damage/destruction and picking.
      if (f.subject === 'spire') sy = spireBaseY(f.plane, f.x, f.y, this.terrain) + SPIRE_HEIGHT[f.plane];
      const distance = Math.hypot(ex - sx, ez - sz);
      if (distance > 1e-5) {
        const dx = (ex - sx) / distance, dz = (ez - sz) / distance;
        // Do not push a barrel through a point-blank target. Lateral is the trooper's right-hand rifle.
        const forward = Math.min(profile.forward * modelScale, distance * 0.45);
        sx += dx * forward - dz * profile.lateral * modelScale;
        sz += dz * forward + dx * profile.lateral * modelScale;
      }
    } else {
      // The fog-filtered event exposes only the target. A short local incoming stroke conveys the
      // hit without recovering a hidden entity, its true plane, or a muzzle flash outside vision.
      ex = x; ez = z; tpi = pi;
      ey = unitY(f.plane) + (f.plane === 'sky' ? 1.6 : f.plane === 'orbit' ? 0.2 : 0.35)
        + (f.sourceElevation ?? 0) + (f.plane === 'surface' ? groundAt(f.x, f.y, this.terrain) : 0);
      // A public falling rock is the one target an unseen shooter's event can still place in 3D.
      if (rock) { ex = AIM.x; ey = AIM.y; ez = AIM.z; }
      const a = h * PI * 2;
      sx = ex + Math.cos(a) * 3; sz = ez + Math.sin(a) * 3;
      sy = ey + (weapon === 'bomb' ? 6 : weapon === 'flak' ? -6 : 0.3);
    }
    const pigment = profile.pigment === 'side' ? (f.side ? sideColor(f.side) : COL.white) : COL[profile.pigment];
    // The event owns the hit boundary. Missing arrival metadata is instant, never an invented flight.
    const arrival = f.arrive === undefined ? t0 : this.at2(f.arrive);
    // A hidden shooter's flame must not invent a nozzle or cone. Only a small local hit is safe to draw.
    if (weapon === 'flamer' && !visibleSource) {
      this.shots.add(FLAMER_HIT, pi, ex, ey, ez, tpi, ex, ey, ez, t0, arrival, pigment, 0, false);
      return;
    }
    if (f.plane === 'orbit' && visibleSource && !rock && (f.subject === 'lancer' || f.subject === 'skiff' || f.subject === 'bastion')) {
      let source: Track | undefined, target: Track | undefined;
      let sourceDistance = 1 / 256 ** 2, targetDistance = 1 / 256 ** 2;
      let sourceAmbiguous = false, targetAmbiguous = false;
      if (this.tracks) {
        for (const tr of this.tracks.values()) {
          if (!tr.visible) continue;
          const e = tr.e;
          if (e.plane === f.plane && e.kind === f.subject && (!f.side || e.side === f.side)) {
            const distance = shotDistance(tr, f.tick, f.x, f.y, f.sourceElevation);
            if (distance < sourceDistance - 1e-10) { sourceDistance = distance; source = tr; sourceAmbiguous = false; }
            else if (Math.abs(distance - sourceDistance) <= 1e-10) sourceAmbiguous = true;
          }
          if (e.plane === f.tp && (!f.side || e.side !== f.side)) {
            const distance = shotDistance(tr, f.tick, f.tx!, f.ty!, f.targetElevation);
            if (distance < targetDistance - 1e-10) { targetDistance = distance; target = tr; targetAmbiguous = false; }
            else if (Math.abs(distance - targetDistance) <= 1e-10) targetAmbiguous = true;
          }
        }
        // Full FX coordinates are not permission to reconstruct an actor absent from current vision.
        if (!source || !target || sourceAmbiguous || targetAmbiguous) return;
      }
      TMP.copy(f.side ? sideColor(f.side) : COL.white);
      if (f.subject === 'bastion') TMP.lerp(ORBIT_COOL, 0.65);
      this.orbitShots.add(f.subject, source?.e.id, target?.e.id, t0, arrival, sx, sy, sz, ex, ey, ez, TMP, tpi);
      return;
    }
    let orbitTarget: Track | undefined;
    if (tpi === PIDX.orbit && this.tracks) {
      let nearest = 1 / 256 ** 2, ambiguous = false;
      const tx = visibleSource ? f.tx! : f.x, ty = visibleSource ? f.ty! : f.y;
      for (const tr of this.tracks.values()) {
        if (!tr.visible || tr.e.plane !== 'orbit' || (f.side && tr.e.side === f.side)) continue;
        const distance = shotDistance(tr, f.tick, tx, ty);
        if (distance < nearest - 1e-10) { nearest = distance; orbitTarget = tr; ambiguous = false; }
        else if (Math.abs(distance - nearest) <= 1e-10) ambiguous = true;
      }
      if (ambiguous) orbitTarget = undefined;
    }
    // Mounted guns launch from their real (traversed, elevated) muzzles; the Gunship and its Gun Platform always do
    // (their dorsal turret tracks targets). A Bastion joins them only for a falling rock: its tracking weapon lock cannot
    // follow a rock (it is not a hull track). At a rock, twin mounts fire both barrels together.
    const mountAtRock = rock && (f.subject === 'bastion' || f.subject === 'gunship' || f.subject === 'gun_platform');
    if (visibleSource && (f.subject === 'breacher' || f.subject === 'flak' || f.subject === 'tank' || f.subject === 'turret' || f.subject === 'gunship' || f.subject === 'gun_platform' || f.subject === 'island_mortar' || mountAtRock)) {
      let source: Track | undefined, nearest = 1 / 256 ** 2, ambiguous = false;
      if (this.tracks) {
        for (const tr of this.tracks.values()) {
          if (!tr.visible || tr.e.kind !== f.subject || tr.e.plane !== f.plane || (f.side && tr.e.side !== f.side)) continue;
          const distance = shotDistance(tr, f.tick, f.x, f.y, f.sourceElevation);
          if (distance < nearest - 1e-10) { nearest = distance; source = tr; ambiguous = false; }
          else if (Math.abs(distance - nearest) <= 1e-10) ambiguous = true;
        }
        if ((!source || ambiguous) && f.subject !== 'island_mortar') return;
        if (ambiguous) source = undefined;
      }
      if (f.subject === 'flak' || mountAtRock) {
        const tint = f.subject === 'bastion' ? TMP.copy(f.side ? sideColor(f.side) : COL.white).lerp(ORBIT_COOL, 0.65) : pigment;
        const secondary = f.subject === 'bastion' ? PD_SECONDARY : f.subject === 'gunship' || f.subject === 'gun_platform' ? GUNSHIP_SECONDARY : FLAK_SECONDARY;
        const distance = Math.hypot(ex - sx, ez - sz);
        const dx = distance > 1e-5 ? (ex - sx) / distance : 1, dz = distance > 1e-5 ? (ez - sz) / distance : 0;
        for (let barrel = 0; barrel < 2; barrel++) {
          const side = (barrel ? 1 : -1) * 0.108 * modelScale;
          this.shots.add(barrel ? secondary : profile, pi, sx - dz * side, sy, sz + dx * side, tpi, ex, ey, ez, t0, arrival, tint, barrel ? 0 : st?.splash ?? 0, true, orbitTarget, source, barrel);
        }
      } else {
        // twin barrels alternate shot by shot (a deterministic tick parity, never local randomness)
        const barrel = f.subject === 'gunship' || f.subject === 'gun_platform' ? f.tick & 1 : 0;
        this.shots.add(profile, pi, sx, sy, sz, tpi, ex, ey, ez, t0, arrival, pigment, st?.splash ?? 0, true, orbitTarget, source, barrel);
      }
      return;
    }
    this.shots.add(profile, pi, sx, sy, sz, tpi, ex, ey, ez, t0, arrival, pigment, st?.splash ?? 0, visibleSource, orbitTarget);
  }

  /** Short-lived overlapping lobes keep the jet attached without dragging old flame around with a turning hull. */
  flame(plane: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, step: number): void {
    const run = Math.hypot(ex - sx, ez - sz);
    if (run < 0.01) return;
    const dx = (ex - sx) / run, dz = (ez - sz) / run;
    const cone = Math.tan(this.flameCone);
    const quiet = this.reducedMotion;
    // A fresh core must survive the renderer's 100 ms capped step, including on software WebGL2.
    const life = quiet ? 0.26 : 0.22;
    // Ten overlapping cross-sections describe the actual target distance, not an invented travelling projectile.
    for (let j = 0; j < 10; j++) {
      const u = j / 11;
      const distance = run * u;
      const half = cone * distance;
      const size = Math.min(run - distance, 0.065 + half * 0.55);
      const ripple = quiet ? 0 : Math.sin(j * 2.1 - step * 1.7) * size * 0.16 * u;
      const x = sx + dx * distance, y = sy + (ey - sy) * u + ripple, z = sz + dz * distance;
      const speed = Math.min(1.6, (run - distance - size) / life);
      for (let side = -1; side <= 1; side++) {
        // Outer lobes' edges, not their centres, meet the rule's cone boundary.
        const spread = side * Math.max(0, half - size);
        this.sparks.spawn(plane, x - dz * spread, y, z + dx * spread, dx * speed, 0.15, dz * speed,
          life, size, size * 0.7, side ? COL.fire : COL.spark, side ? 0.58 : 0.8);
      }
      if (j < 5) this.sparks.spawn(plane, x, y, z, dx * speed, 0, dz * speed,
        life * 0.85, size * 0.46, size * 0.18, COL.white, 0.9);
    }
    if (!quiet) {
      const u = 0.7 + hash2(step, sx) * 0.2;
      const spread = (hash2(step, sz) - 0.5) * cone * run * u;
      this.sparks.spawn(plane, sx + dx * run * u - dz * spread, sy + (ey - sy) * u, sz + dz * run * u + dx * spread,
        dx * 0.3, 0.7, dz * 0.3, 0.24, 0.035, 0.008, COL.ember, 0.8, 0.5);
      if (!(step & 1)) this.smoke.spawn(plane, sx + dx * run * 0.85, sy + (ey - sy) * 0.85, sz + dz * run * 0.85,
        0, 0.45, 0, 0.38, 0.09, 0.2, COL.smoke, 0.22, 0, 1);
    }
  }

  /** One impact per authoritative shot; cosmetic pulse duplicates never imply additional damage. */
  orbitHit(target: Track | undefined, x: number, y: number, z: number, r: number, g: number, b: number, kind: OrbitWeapon, now: number, plane: number, dx = 0, dy = 1, dz = 0): void {
    TMP.setRGB(r, g, b);
    const shielded = target && (target.e.maxShield ?? 0) > 0
      && ((target.e.shield ?? 0) > 0 || Math.abs(now - target.shieldAt) < 180);
    if (target && shielded) {
      this.orbitShields.add(target, now, dx, dy, dz);
      this.sparks.spawn(plane, x, y, z, 0, 0, 0, 0.1, 0.17, 0.025, COL.white, 0.85);
    } else {
      const n = kind === 'lancer' ? 7 : kind === 'skiff' ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const a = i * 2.399 + x;
        this.sparks.spawn(plane, x, y, z, Math.cos(a) * 2.8, (hash2(i, z) - 0.5) * 2.5, Math.sin(a) * 2.8, 0.22 + i * 0.02, 0.055, 0.005, i & 1 ? COL.spark : TMP, 1, 0, 2);
      }
      this.rings.add(plane, x, target ? target.wy + target.scale * 0.3 : y, z, 0.06, kind === 'lancer' ? 0.42 : 0.22, now, 750, COL.debris, 0.75, RING.splat, target);
      this.debris.spawn(plane, x, y, z, 0.6, 0.3, -0.5, 0.6, 0.07, 0.025, COL.debris, 0.85, 0, 0.4);
    }
    if (kind === 'bastion') {
      // Cool, compact airbursts: no hot artillery smoke or large explosion sleeve.
      this.rings.add(plane, x, y, z, 0.04, 0.28, now, 170, TMP, 0.5, RING.ink);
      for (let i = 0; i < 4; i++) {
        const a = i * PI / 2;
        this.sparks.spawn(plane, x, y, z, Math.cos(a) * 1.7, 0.15, Math.sin(a) * 1.7, 0.14, 0.035, 0.005, TMP, 0.75);
      }
    }
  }

  /** Cosmetic impact at the server's arrival boundary; `now` is the same clock as rings/projectiles. */
  onHit(kind: HitStyle, plane: number, x: number, y: number, z: number, r: number, g: number, b: number, splash: number, now: number): void {
    TMP.setRGB(r, g, b);
    if (splash > 0) this.rings.add(plane, x, y - 0.3, z, 0.2, splash, now, 450, COL.fire, 0.7, RING.wash);
    switch (kind) {
      case HIT.chip:
        // Contact strikes have no travelling object: a compact chip fan distinguishes them from
        // ballistic sparks without suggesting a damaging projectile in the server simulation.
        for (let i = 0; i < 3; i++) this.debris.spawn(plane, x, y, z, (i - 1) * 1.2, 1.4, (hash2(i, x) - 0.5) * 1.5, 0.35, 0.1, 0.025, COL.dust, 1, 6);
        this.sparks.spawn(plane, x, y, z, 0, 0.4, 0, 0.12, 0.15, 0.02, COL.spark, 1);
        return;
      case HIT.spark:
        for (let i = 0; i < 3; i++) this.sparks.spawn(plane, x, y, z, (hash2(i, x * 9) - 0.5) * 3, 1 + i * 0.4, (hash2(z * 9, i) - 0.5) * 3, 0.22, 0.07, 0.02, TMP, 1, 8);
        return;
      case HIT.puff:
        this.sparks.spawn(plane, x, y, z, 0, 0, 0, 0.15, 0.4, 0.1, COL.fire, 1);
        this.rings.add(plane, x, y - 0.25, z, 0.12, 0.65, now, 260, COL.debris, 0.7, RING.ink);
        for (let i = 0; i < 3; i++) this.smoke.spawn(plane, x, y, z, (hash2(i, x) - 0.5), 0.8, (hash2(z, i) - 0.5), 1, 0.2, 0.55, COL.smoke, 0.6, 0, 1.2);
        return;
      case HIT.flak:
        this.sparks.spawn(plane, x, y, z, 0, 0, 0, 0.18, 0.5, 0.2, COL.flak, 1);
        // Airburst spokes communicate fragmentation without a ground scorch or chunky debris
        // cloud obscuring aircraft at the hit altitude.
        for (let i = 0; i < 8; i++) {
          const a = i * PI / 4;
          this.sparks.spawn(plane, x, y, z, Math.cos(a) * 3, Math.sin(a) * 2, Math.sin(a) * 3, 0.28, 0.1, 0.02, COL.flak, 1, 1);
        }
        for (let i = 0; i < 4; i++) this.smoke.spawn(plane, x + (hash2(i, x) - 0.5) * 0.6, y, z + (hash2(z, i) - 0.5) * 0.6, 0, 0.2, 0, 1.2, 0.25, 0.6, COL.smoke, 0.75, 0, 2);
        return;
      case HIT.missile:
        this.explode(plane, x, y, z, 0.7, now);
        return;
      case HIT.bomb:
        this.explode(plane, x, y, z, 1.4, now);
        this.rings.add(plane, x, y - 0.3, z, 0.3, 2.4, now, 600, COL.debris, 0.9);
        return;
      default:
        return;
    }
  }

  /** Pigment bloom: a hot emissive core (the only bit that blooms), a spreading fire wash, an ink splat left behind. */
  private explode(plane: number, x: number, y: number, z: number, size: number, t0: number): void {
    const n = Math.round(10 * size);
    this.sparks.spawn(plane, x, y + 0.1, z, 0, 0, 0, 0.14, 0.3 * size, 0.7 * size, COL.flash, 1);
    this.sparks.spawn(plane, x, y, z, 0, 0, 0, 0.26, 0.45 * size, 1 * size, COL.fire, 0.9);
    this.rings.add(plane, x, y - 0.2, z, 0.3 * size, 1.5 * size, t0, 650, COL.fire, 0.75, RING.wash);
    // only grounded planes keep a scorch splat
    if (plane <= 1) this.rings.add(plane, x, y - LIFT[PLANES[plane]!] + 0.05, z, 0.5 * size, 0.8 * size, t0, 3200, COL.ember, 0.85, RING.splat);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * PI * 2;
      const u = hash2(i, Math.round(x * 13 + z * 7));
      this.sparks.spawn(plane, x, y, z, Math.cos(a) * (2 + u * 3) * size * 0.6, 1.5 + u * 3, Math.sin(a) * (2 + u * 3) * size * 0.6, 0.4 + u * 0.3, 0.09, 0.02, u > 0.5 ? COL.fire : COL.spark, 1, 7, 1);
    }
    const nd = Math.round(5 * size);
    for (let i = 0; i < nd; i++) {
      const a = (i / nd) * PI * 2 + 0.4;
      const u = hash2(Math.round(z * 11), i);
      this.debris.spawn(plane, x, y, z, Math.cos(a) * (1.5 + u * 2), 2.5 + u * 2.5, Math.sin(a) * (1.5 + u * 2), 1.2, 0.1 + u * 0.1 * size, 0.08, COL.debris, 1, 9, 0.5, y - 0.4);
    }
    const ns = Math.round(4 * size);
    for (let i = 0; i < ns; i++) {
      const u = hash2(i, Math.round(x * 5));
      this.smoke.spawn(plane, x + (u - 0.5) * size, y + 0.2, z + (hash2(Math.round(z * 5), i) - 0.5) * size, 0, 0.6 + u * 0.6, 0, 1.6 + u, 0.3 * size, 0.9 * size, COL.smoke, 0.7, 0, 0.8);
    }
    if (size >= 1.4) this.rings.add(plane, x, y - 0.3, z, 0.4, 2 * size, t0, 700, COL.debris, 0.85);
  }

  /** One end of a portal: an inward ring and a swirl of sparks. */
  private portalMark(pl: Plane, x: number, y: number, t0: number): void {
    const [px, py, pz] = this.at(pl, x, y);
    const pp = PIDX[pl];
    this.rings.add(pp, px, py - 0.3, pz, 1.4, 0.2, t0, 700, COL.portal, 1);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * PI * 2;
      this.sparks.spawn(pp, px + Math.cos(a), py, pz + Math.sin(a), -Math.sin(a) * 2 - Math.cos(a), 0.4, Math.cos(a) * 2 - Math.sin(a), 0.6, 0.08, 0.02, COL.portal, 1);
    }
  }

  /**
   * The damaged look: every visible, finished model below its health thresholds trails soot, sparks and (structures)
   * fire into the shared pools, at `damageRates`; a per-track debt carries fractional emission between frames.
   */
  private damaged(dt: number): void {
    if (!this.tracks || dt <= 0 || this.reducedMotion) return;
    for (const tr of this.tracks.values()) {
      const e = tr.e;
      if (!tr.visible || e.maxHp <= 0 || e.state === 'constructing' || DAMAGE_EXEMPT[e.kind] || fadeValue[e.plane] < 0.03) continue;
      const hp = e.hp / e.maxHp;
      if (hp >= DAMAGE_START) { tr.smokeDebt = tr.sparkDebt = tr.fireDebt = 0; continue; }
      const structure = isStatKind(e.kind) && STATS[e.kind].footprint !== undefined;
      damageRates(hp, structure, e.plane, RATES);
      const pi = PIDX[e.plane];
      const x = wx(tr.rx, this.size), z = wz(tr.ry, this.size);
      const top = tr.wy + (structure ? DAMAGE_LOOK.structureTop : DAMAGE_LOOK.unitTop) * tr.scale;
      const spread = DAMAGE_LOOK.spread * tr.scale;
      const size = Math.max(tr.scale, DAMAGE_LOOK.minScale);
      tr.smokeDebt = (tr.smokeDebt ?? 0) + RATES.smoke * dt;
      tr.sparkDebt = (tr.sparkDebt ?? 0) + RATES.sparks * dt;
      tr.fireDebt = (tr.fireDebt ?? 0) + RATES.fire * dt;
      for (; tr.smokeDebt >= 1; tr.smokeDebt--) {
        const u = hash2(tr.phase * 977, ++this.damageSeq), w = hash2(this.damageSeq, tr.phase * 613);
        this.smoke.spawn(pi, x + (u - 0.5) * spread, top, z + (w - 0.5) * spread, (u - 0.5) * 0.3, 0.7 + w * 0.4, (w - 0.5) * 0.3,
          1.6 + u * 0.6, DAMAGE_LOOK.soot[0] * size, DAMAGE_LOOK.soot[1] * size, COL.soot, 0.55, 0, 0.8);
      }
      for (; tr.sparkDebt >= 1; tr.sparkDebt--) {
        const u = hash2(tr.phase * 389, ++this.damageSeq), w = hash2(this.damageSeq, tr.phase * 211);
        this.sparks.spawn(pi, x + (u - 0.5) * spread, top, z + (w - 0.5) * spread, (u - 0.5) * 2.4, 1 + w * 1.2, (w - 0.5) * 2.4,
          0.3, 0.05, 0.01, COL.spark, 1, 7);
      }
      for (; tr.fireDebt >= 1; tr.fireDebt--) {
        const u = hash2(tr.phase * 131, ++this.damageSeq), w = hash2(this.damageSeq, tr.phase * 743);
        this.sparks.spawn(pi, x + (u - 0.5) * spread, top, z + (w - 0.5) * spread, 0, 0.9 + u * 0.5, 0,
          0.45 + w * 0.2, 0.14 * size, 0.03, u > 0.5 ? COL.fire : COL.ember, 0.85, -0.5);
      }
    }
  }

  frame(now: number, dt: number, cameraY: number, renderTick: number): void {
    camY = cameraY;
    PARTICLE_CAMERA_Y.value = cameraY;
    this.deaths.focus = this.focus;
    this.deaths.frame(now, dt, renderTick);
    this.shake = Math.max(this.shake, this.deaths.shake);
    this.deaths.shake = 0;
    for (let i = 0; i < this.pendingBursts.length;) {
      const pending = this.pendingBursts[i]!;
      const f = pending.event;
      if (renderTick < f.tick) {
        i++;
        continue;
      }
      // All particle pools start together on the first eligible frame. A late packet still explodes at
      // f.tick's trajectory position, not farther down the path; rings use now so they match those particles.
      this.spawn(f, now, pending.radius, pending.volatile);
      this.pendingBursts.splice(i, 1);
    }
    this.shots.update(now, this);
    this.orbitShots.update(now, this);
    this.orbitShields.update(now, this.tracks, this.aegisRadius, renderTick, this.size);
    this.fire.frame(this.scorches, renderTick, dt, this.sparks, this.smoke);
    this.damaged(dt);
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.debris.update(dt);
    this.rings.update(now, this.tracks);
    this.shake *= 0.9;
    this.heatT += dt;
    if (this.heatT > 0.25) {
      const k = Math.pow(0.6, this.heatT);
      for (const p of PLANES) {
        const hp = this.heat[p];
        for (let i = 0; i < hp.length; i++) hp[i] = hp[i]! * k;
      }
      this.heatT = 0;
    }
  }
}

const P: [number, number, number] = [0, 0, 0];
const TMP = new Color();
const FALL_POSITION = { x: 0, y: 0, z: 0 };
/** Scratch for a shot's resolved cross-plane end (`aim.ts`), filled at snapshot ingest. */
const AIM = shotAim();
/** Flight time (ms) of a lobbed Warden flare from a seen thrower to its cell. */
const FLARE_THROW_MS = 450;
/** A view without scorch hazards (the list is optional): shared, never mutated. */
const NO_SCORCHES: NonNullable<View['scorches']> = [];
