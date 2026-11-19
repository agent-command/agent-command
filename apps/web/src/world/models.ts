/**
 * Low-poly models per kind, built from one primitive kit (docs/art/DIRECTIONS.md §1 "Unit model kit"). Each vertex
 * carries:
 *   paint  (vec3) base colour, accent (float) how much the team tint replaces paint, glow (float) emissive strength,
 *   part   (float, unit models only) the rigid part it belongs to (`PART`), animated by `rig.ts` with the kind's `RIG`.
 * Models face +X; y = 0 is the ground contact (flyers and floaters are centred on y = 0).
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  ExtrudeGeometry,
  type Vector3Like,
  IcosahedronGeometry,
  LatheGeometry,
  OctahedronGeometry,
  Shape,
  SphereGeometry,
  PlaneGeometry,
  Quaternion,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEPLOY_SPECS, footprint, isHardpointKind, rotVX, rotVY, STATS, type Entity, type Kind, type NeutralKind, type UnitKind } from '@agent-command/game/contract';
import { clamp, fbm, hash2 } from './common.ts';
import { ORE_HEAP_PAINT, UNIT_PAINT } from './palette.ts';
import { prepareStartup } from './startup.ts';

/**
 * Rigid parts a vertex can belong to (the `part` attribute); `rig.ts` moves each with the kind's `RIG`. Deploy-stance
 * kit (shown on the work channel; ids above Bastion's): `stance` the first group (the tank's right-side legs, the
 * foxhole's sandbag ring, emplacement pads), `stance2` the second (the tank's left-side legs, the foxhole's parapet),
 * `dust` kicked-up dust and dirt, `pit` the dug ground. `flame`: an exhaust (`RIG.flame`) or a pilot light
 * (`RIG.pilot`).
 */
export const PART = { body: 0, top: 1, barrel: 2, rotor: 3, left: 4, right: 5, panel: 6, flame: 7, tool: 8, cargo: 9, stance: 13, cloth: 14, stance2: 17, dust: 18, pit: 19, vein: 20 } as const;

/** Shared geometry/FX anchors; the two cosmetic blisters share the simulation's one PD weapon. */
export const BASTION_PD = { x: 0.22, y: 0.30, z: 0.53, tip: 0.66, height: 0.34 } as const;
const PD_TOP = 10;
const PD_BARREL = 11;
export const BASTION_PART = { top: PD_TOP, barrel: PD_BARREL, emitter: 12 } as const;
/**
 * Solar array parts beside `PART.panel` (the photovoltaic glass): the wing frame whose edge is the ramp gauge, and the
 * collector light on the bus lid. The frame rolls and folds with the glass.
 */
export const SOLAR_PART = { trim: 15, node: 16 } as const;
/**
 * Solar wing anchors shared by the model, its fold (`RIG.solar.panel.fold`) and the trim gauge shader: each wing's glass
 * runs along ±Z from `root` to `tip`; folded, it stows at the root in `folded` of its span, `stack`× as thick.
 */
export const SOLAR = { root: 0.19, tip: 1.17, folded: 0.14, stack: 3 } as const;
/** Model-to-world readability scales, shared by flying units and their emplaced airframes. */
export const UNIT_SCALE = 1.35;
export const AIR_SCALE = 1.35;
export const MORTAR_MUZZLE = { x: 0.48, y: 1.33 } as const;
/** Forward harvesting lens, shared with the physical mining-beam emitter. */
export const TUG_MINER = { x: 0.56, y: -0.02, z: 0 } as const;
/**
 * Gunship anchors shared by the model, its rig and the muzzle mirror (`entities.ts` orbitMuzzle): ducted fan hubs at
 * (fan.x, ±fan.z), the dorsal turret ring at (turret.x, turret.y), twin barrel tips at (tip, turret.y, ±twin).
 */
export const GUNSHIP = { fan: { x: -0.06, z: 0.56, r: 0.25 }, turret: { x: 0.1, y: 0.22, tip: 0.62, twin: 0.055 } } as const;
/** Emplaced: the airframe stands `lift` up on its landing struts and the turret rides `mast` higher still. */
export const GUN_PLATFORM = { lift: 0.3, mast: 0.16, hinge: 0.2, folded: 1.05 } as const;
/**
 * The Gunship ↔ Gun Platform swap (two entities in the sim): over `seconds` after the new one appears where the other
 * stood, a platform settles from `hover` (model units) onto its skids then folds (the fold ends at `foldEnd` of the
 * channel), and a gunship lifts the same height off the pad.
 */
export const EMPLACE_SWAP = { seconds: 1.1, hover: 0.45, foldEnd: 0.4, reach: 2.5 } as const;
/** Gunship ducted-fan ring prism: tube half-thickness and sides (the kit's torus replacement). */
const FAN_DUCT = { tube: 0.05, sides: 8 } as const;
/** Bastion shield emitter ring prism: outer radius, width, height and sides. */
const BASTION_EMITTER = { r: 0.235, w: 0.07, h: 0.07, sides: 6 } as const;
export const GUN_PLATFORM_TURRET_Y = GUNSHIP.turret.y + GUN_PLATFORM.lift + GUN_PLATFORM.mast;
/**
 * Surface turret anchors shared by the model, its rig and the muzzle mirror (`entities.ts` orbitMuzzle, `combat.ts`):
 * the barrel axis height and its tip. The barrel may overhang the footprint the plinth fills (`footprintModelScale`).
 */
export const TURRET = { y: 0.53, tip: 0.75 } as const;
/**
 * Breacher anchors shared by the model, its rig and the flamer visual (`combat.ts` WEAPON_VISUALS.flamer): the
 * nozzle tip the flame cone fans from and the pilot light flickering under it.
 */
export const BREACHER = { nozzle: { x: 0.41, y: 0.295, z: 0.17 }, pilot: { x: 0.37, y: 0.235, z: 0.17 } } as const;
/**
 * Warden anchors shared by the model, its wall pose (STATE_VISUALS) and the shotgun visual (`combat.ts`
 * WEAPON_VISUALS.shotgun): the shotgun muzzle, the hip the legs swing from, and the riot shield's carry on the left
 * arm: its centre (x, z), its bottom height y (carried clear of the swinging boots) and its yaw (rad, outer edge back).
 */
export const WARDEN = { muzzle: { x: 0.31, y: 0.33, z: 0.2 }, hip: 0.22, shield: { x: 0.2, y: 0.18, z: -0.21, carry: 0.7 } } as const;
/**
 * Tank siege anchors shared by the model, its transformation (STATE_VISUALS.tank) and the muzzle mirror
 * (`entities.ts` orbitMuzzle). Legs hinge at (±x, hinge.y, ±hinge.z) outside the tracks, authored folded straight up
 * and swung down and out to plant their pads at `foot` from the hinge. Along the deploy progress: legs in `legs`, the
 * hull settles `lower` in `settle`, the turret swings `turn` rad out and back in `swing`, the barrel runs out to
 * `reach`× its length and rises `raise` in `extend`, and the lock-down thud (`thud`, a dip of `dip`) bursts dust from
 * the pads (`dust`). Sieged, the recoil is `recoil`× heavier.
 */
export const TANK_SIEGE = {
  hinge: { x: 0.34, y: 0.22, z: 0.4 },
  foot: { y: -0.22, z: 0.18 },
  legs: [0.05, 0.5], settle: [0.35, 0.65], swing: [0.3, 0.8], extend: [0.55, 0.85], thud: [0.84, 0.97], dust: [0.82, 1],
  lower: 0.05, reach: 1.35, raise: 0.03, dip: 0.03, turn: 1.1, recoil: 1.8,
} as const;
/** The leg's swing (rad about X): its folded, straight-up strut turned onto the planted strut direction. */
const TANK_LEG_ANGLE = Math.atan2(TANK_SIEGE.foot.z, TANK_SIEGE.foot.y);
/**
 * Trooper foxhole anchors (STATE_VISUALS.trooper, `trenches.ts`): the scrape's radius, how far the trooper sinks into
 * it, the sandbag lip (a ring course of `ring` bags, then a parapet of two bags in front, each `bag` high) and where
 * the dirt kicks up while digging.
 */
export const FOXHOLE = { radius: 0.3, sink: 0.11, ring: 5, bag: 0.075, dirt: [0.14, 0.03, -0.22] } as const;
/** The STATE_VISUALS `ease` window on the CPU: smoothstep of `v` across `w`. */
export function easeWindow(w: readonly [number, number], v: number): number {
  const t = clamp((v - w[0]) / (w[1] - w[0]), 0, 1);
  return t * t * (3 - 2 * t);
}
/** The STATE_VISUALS `bump` window on the CPU: 0 at both ends of `w`, 1 midway. */
export const bumpWindow = (w: readonly [number, number], v: number): number => Math.sin(clamp((v - w[0]) / (w[1] - w[0]), 0, 1) * Math.PI);
/**
 * Drill Yard anchors: the gantry beam at x, the hoist pivot under it (the swinging arm), the warning beacon on the
 * beam end and the chimney mouth the exhaust puffs leave.
 */
const DRILL_YARD = { gantry: -0.15, pivot: 1.08, beacon: 0.45, chimney: { x: -0.5, y: 0.93, z: -0.5 } } as const;
/** Sides of the ring prisms and coil discs that replace tori (windings, crowns): low enough for the structure budget. */
const COIL_SIDES = 6;
/** Sides of the island pads' rim rings and of the derelict core's containment hoops (ring prisms). */
const PAD_RIM_SIDES = 16;
const CORE_HOOP_SIDES = 12;
/** Flak emplacing (deploy progress windows): the hull settles `lower` on its pads, locks down with a `dip`, kicks up dust. */
const FLAK_EMPLACE = { settle: [0.3, 0.7], thud: [0.8, 0.95], dust: [0.78, 1], lower: 0.03, dip: 0.02 } as const;
/** A bulkhead sealing: the end of its close (work → 0) where the leaves bounce `dip` on the floor and dust puffs. */
const BULKHEAD_SEAL = { thud: [0, 0.14], dip: 0.04 } as const;
/** The digger hopper crystal grows from here: low in the hopper, so it crowns the rim from about a quarter load. */
const DIGGER_CARGO_ORIGIN = [-0.20, 0.30, 0] as const;
/** Where a built Geothermal tap's steam leaves its turbine cap. */
const GEOTHERMAL_STEAM = [0, 0.8, 0] as const;
/** How far a laying Sapper sets its fused charge down: back off the turret and onto the floor. */
const SAPPER_CHARGE_DROP = [-0.24, -0.36, 0] as const;

export interface Part {
  geo: BufferGeometry;
  /** Base colour; a `paint` vec3 attribute on `geo` (per-vertex colour) overrides it. */
  paint: string;
  accent?: number;
  glow?: number;
  /** Keep the part's own (smooth) normals instead of faceting it. */
  smooth?: boolean;
  /** Rigid part id (`PART`), default body. */
  part?: number;
}

/** Merge parts into one non-indexed geometry; `rigged` adds the `part` attribute (unit models). */
export function merge(parts: Part[], rigged = false): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const paint: number[] = [];
  const accent: number[] = [];
  const glow: number[] = [];
  const part: number[] = [];
  const c = new Color();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (!p.smooth) g.computeVertexNormals();
    const P = g.getAttribute('position');
    const Nn = g.getAttribute('normal');
    const Pc = g.getAttribute('paint');
    c.set(p.paint);
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(Nn.getX(i), Nn.getY(i), Nn.getZ(i));
      if (Pc) paint.push(Pc.getX(i), Pc.getY(i), Pc.getZ(i));
      else paint.push(c.r, c.g, c.b);
      accent.push(p.accent ?? 0);
      glow.push(p.glow ?? 0);
      part.push(p.part ?? PART.body);
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('paint', new BufferAttribute(new Float32Array(paint), 3));
  out.setAttribute('accent', new BufferAttribute(new Float32Array(accent), 1));
  out.setAttribute('glow', new BufferAttribute(new Float32Array(glow), 1));
  if (rigged) out.setAttribute('part', new BufferAttribute(new Float32Array(part), 1));
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------- the kit
const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new BoxGeometry(w, h, d).translate(x, y + h / 2, z);
const cyl = (rt: number, rb: number, h: number, seg = 8) => new CylinderGeometry(rt, rb, h, seg);
/**
 * Flat ring prism (the kit's torus: DIRECTIONS.md forbids tori) lying in XZ, centred at the origin: outer radius
 * `r`, inner `r - w`, height h, `seg` sides. 8 triangles a side, 6 without the `bottom` face (seen only from below).
 */
function ring(r: number, w: number, h: number, seg = 8, bottom = true): BufferGeometry {
  const pos: number[] = [];
  const at = (k: number, radius: number, y: number): number[] => {
    const a = (k / seg) * Math.PI * 2;
    return [Math.cos(a) * radius, y, Math.sin(a) * radius];
  };
  const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const y0 = -h / 2, y1 = h / 2, ri = r - w;
  for (let k = 0; k < seg; k++) {
    const o0 = at(k, r, y1), o1 = at(k + 1, r, y1), i0 = at(k, ri, y1), i1 = at(k + 1, ri, y1);
    const p0 = at(k, r, y0), p1 = at(k + 1, r, y0), j0 = at(k, ri, y0), j1 = at(k + 1, ri, y0);
    quad(i0, i1, o1, o0); // top
    if (bottom) quad(j0, p0, p1, j1);
    quad(p0, o0, o1, p1); // outer wall
    quad(j1, i1, i0, j0); // inner wall
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  return g;
}

/** Sheave wheels (rim radius, rim width, thickness, sides, spoke width): an open rim with three spokes reads as turning. */
const SHEAVE = {
  headframe: { r: 0.29, w: 0.06, t: 0.08, seg: 10, spoke: 0.05 },
  shaft: { r: 0.2, w: 0.045, t: 0.07, seg: 8, spoke: 0.04 },
} as const;
/** An open sheave wheel standing in the XY plane at height y (`rotor` part): rim, hub and three spokes. */
function sheave(s: (typeof SHEAVE)[keyof typeof SHEAVE], y: number, paint: string): Part[] {
  const spoke = s.r - s.w / 2;
  return [
    { geo: ring(s.r, s.w, s.t, s.seg).rotateX(Math.PI / 2).translate(0, y, 0), paint, part: PART.rotor },
    { geo: cyl(s.spoke * 1.4, s.spoke * 1.4, s.t * 1.2, 6).rotateX(Math.PI / 2).translate(0, y, 0), paint: IRON, part: PART.rotor },
    ...[0, 1, 2].map((k): Part => ({ geo: new BoxGeometry(spoke, s.spoke, s.t * 0.8).translate(spoke / 2, 0, 0).rotateZ((k * Math.PI * 2) / 3).translate(0, y, 0), paint: STEEL, part: PART.rotor })),
  ];
}

/**
 * Chamfered hull block: a w × h × d box standing at (x, y, z) whose top face is scaled by `tx`/`tz` and shifted by
 * `sx` (tapered hulls, wedges, sloped glacis). 12 triangles.
 */
function block(w: number, h: number, d: number, x = 0, y = 0, z = 0, tx = 1, tz = 1, sx = 0): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setXYZ(i, p.getX(i) * tx + sx, p.getY(i), p.getZ(i) * tz);
  return g.translate(x, y + h / 2, z);
}

/** BoxGeometry faces, in its group order. */
const FACE = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 } as const;
/** CylinderGeometry / ConeGeometry groups, in order: the wall, then the top (+y) and bottom caps. */
const CAP = { top: 1, bottom: 2 } as const;
/** A cone's groups: its point has no cap, so the base is the second group. */
const CONE_BASE = 1;
/** Drop box faces nobody sees (a sandbag's underside, a strut's ends buried in its hinge and pad): 2 triangles each. */
function withoutFaces(g: BufferGeometry, ...faces: number[]): BufferGeometry {
  const index = g.index!.array;
  const keep: number[] = [];
  g.groups.forEach(({ start, count }, face) => { if (!faces.includes(face)) for (let i = start; i < start + count; i++) keep.push(index[i]!); });
  g.setIndex(keep);
  g.clearGroups();
  return g;
}
/** A box or block without its underside (aircraft and hulls the RTS camera only looks down on). */
const under = (g: BufferGeometry): BufferGeometry => withoutFaces(g, FACE.ny);

/** Hexagonal prism lying along X with flat top and bottom (track, skid): length l, height h, width w, centred. */
const pod = (l: number, h: number, w: number, x: number, y: number, z: number) =>
  new CylinderGeometry(0.5, 0.5, 1, 6).rotateX(Math.PI / 2).rotateZ(Math.PI / 6).scale(l, h / 0.866, w).translate(x, y, z);

/** Round prism along +X (barrel, nacelle, boom) spanning x0 … x0 + len at (y, z). */
const rod = (r: number, len: number, x0: number, y: number, z: number, seg = 6) =>
  new CylinderGeometry(r, r, len, seg).rotateZ(-Math.PI / 2).translate(x0 + len / 2, y, z);

/** Cone pointing +X (dir 1) or −X (dir −1), its base centred at (x, y, z). */
const nose = (r: number, len: number, x: number, y: number, z: number, dir = 1, seg = 6) =>
  new ConeGeometry(r, len, seg).rotateZ(-dir * Math.PI / 2).translate(x + (dir * len) / 2, y, z);

/** Flat plate (wing, panel) from an outline of (x, z) points, `t` thick, its underside at y. */
function plate(pts: [number, number][], t: number, y: number): BufferGeometry {
  const s = new Shape(pts.map(([x, z]) => new Vector2(x, -z)));
  return new ExtrudeGeometry(s, { depth: t, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y, 0);
}

/** Upright fin from an outline of (x, y) points, `t` thick, centred on z. */
function fin(pts: [number, number][], t: number, z = 0): BufferGeometry {
  const s = new Shape(pts.map(([x, y]) => new Vector2(x, y)));
  return new ExtrudeGeometry(s, { depth: t, bevelEnabled: false }).translate(0, 0, z - t / 2);
}

const UP = new Vector3(0, 1, 0);
/** Round pipe (hose, cable) of radius r from point a to point b; 4 sides by default. */
function pipe(a: readonly [number, number, number], b: readonly [number, number, number], r: number, seg = 4): BufferGeometry {
  const d = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  return new CylinderGeometry(r, r, len, seg)
    .applyQuaternion(new Quaternion().setFromUnitVectors(UP, d.normalize()))
    .translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}

const { body: BODY, steel: STEEL, iron: IRON } = UNIT_PAINT;
const ACCENT = { accent: 1 } as const;
const L = PART.left;
const R = PART.right;

// ---------------------------------------------------------------- rig (pivots and motion constants per kind)
/** Animation constants of a kind (`rig.ts`). Lengths in model units, angles in radians, rates in rad/s. */
export interface Rig {
  /** Running gear (`left`/`right` parts): tracks bob, legs swing about the hip, skids patter; stride per cycle. */
  gait?: { kind: 'tracks' | 'legs' | 'skids'; stride: number; hip?: number };
  /**
   * `cloth` part flutter (a flag): a travelling sine across Z whose amplitude grows from the staff at x0 outward;
   * rate rad/s, k rad per unit of x.
   */
  wave?: { x0: number; amp: number; rate: number; k: number; axis?: 'y' | 'z' };
  /** `top` part (turret, mount, torso load) pitch pivot (x, y) and its kick when firing. */
  top?: { x: number; y: number; kick: number };
  /**
   * `barrel` recoil distance along the unit vector (dx, dy); `deployed`: its multiplier with the work channel at 1 (a
   * deploy stance held: the sieged tank's heavy kick), eased in with the channel.
   */
  recoil?: { dist: number; dx: number; dy: number; deployed?: number };
  /**
   * Turret-mount `barrel` elevation trunnion (x, y), the barrel's rest elevation and its pitch limits (rad, relative
   * to rest). The mount raises or lowers its barrels about it toward a target on another plane or a falling rock.
   */
  elevate?: { x: number; y: number; rest: number; min: number; max: number };
  /** `cycle` locks the wheel to an integrated state channel instead of an absolute-time rate. `pair` mirrors the pivot
   * across z = 0 (twin rotors): each vertex spins about the pivot on its own side. */
  rotor?: { x: number; y: number; z: number; axis: 'x' | 'y' | 'z'; idle: number; work: number; cycle?: VisualChannel; pair?: boolean };
  /** `tool`: spin about +X through (y, z) and a jab of `reach` while working/firing. */
  tool?: { x: number; y: number; z: number; spin: number; reach: number };
  /** `tool` rocks about `axis` through (x, y, z) by ±amp (rad) at `rate` rad/s while working (a crane's swinging hoist). */
  swing?: { x: number; y: number; z: number; axis: 'x' | 'y' | 'z'; amp: number; rate: number };
  /**
   * `panel` (with the solar `trim`) roll about the Z axis at height y (the work channel carries the angle). `fold`: the
   * wings stow along Z toward ±root by the solar fill's fold (`solarStatus`), first to `folded` of their span and
   * `stack`× as thick.
   */
  panel?: { y: number; fold?: { root: number; folded: number; stack: number } };
  /** `flame` attachment x (the exhaust stretches toward −X with speed). */
  flame?: { x: number };
  /**
   * `flame` as a pilot light at (x, y, z): it flickers in size by ±amp at about `rate` rad/s, flares by `flare` when
   * firing, and rides the barrel's recoil.
   */
  pilot?: { x: number; y: number; z: number; rate: number; amp: number; flare: number };
  /** Whole-body idle bob (floaters), engine shudder, hull jolt when firing (rad), squat while working. */
  hover?: number;
  shudder?: number;
  jolt?: number;
  squat?: number;
}

export const RIG: Record<Kind, Rig> = {
  digger: { gait: { kind: 'tracks', stride: 0.3 }, tool: { x: 0.33, y: 0.2, z: 0, spin: 16, reach: 0.07 }, shudder: 0.006, jolt: 0.05 },
  sapper: { gait: { kind: 'skids', stride: 0.16 }, top: { x: -0.06, y: 0.19, kick: 0 }, squat: 0.35 },
  // a crouch into the foxhole on the work channel (dug in)
  trooper: { gait: { kind: 'legs', stride: 0.34, hip: 0.2 }, recoil: { dist: 0.05, dx: 1, dy: 0 }, jolt: 0.06, squat: 0.3 },
  // sieged (work = deploy stance), the long barrel kicks back harder
  tank: { gait: { kind: 'tracks', stride: 0.4 }, top: { x: -0.06, y: 0.33, kick: 0.07 }, recoil: { dist: 0.12, dx: 1, dy: 0, deployed: TANK_SIEGE.recoil }, shudder: 0.005, jolt: 0.04 },
  flak: {
    gait: { kind: 'tracks', stride: 0.36 },
    top: { x: 0.06, y: 0.35, kick: 0.05 },
    recoil: { dist: 0.08, dx: Math.cos(0.91), dy: Math.sin(0.91) },
    // twin barrels raised 52° at rest: they swing 23° lower to 34° higher (near vertical) on their shared trunnion
    elevate: { x: 0.2, y: 0.44, rest: 0.91, min: -0.4, max: 0.6 },
    rotor: { x: -0.27, y: 0, z: 0, axis: 'y', idle: 1.6, work: 1.6 },
    shudder: 0.005,
    jolt: 0.025,
  },
  // the barrel elevates from the gun house's sloped front face, up to 83° for Sky targets and falling rocks
  turret: { top: { x: -0.04, y: 0.33, kick: 0.05 }, recoil: { dist: 0.12, dx: 1, dy: 0 }, elevate: { x: 0.2, y: TURRET.y, rest: 0, min: -0.1, max: 1.45 }, rotor: { x: -0.22, y: 0, z: 0.14, axis: 'y', idle: 1.2, work: 1.2 } },
  shaft: { rotor: { x: 0, y: 0.84, z: 0, axis: 'z', idle: 0, work: 3, cycle: 'fill' } },
  spire: {},
  interceptor: { recoil: { dist: 0.05, dx: 1, dy: 0 }, flame: { x: -0.49 }, hover: 0.045 },
  bomber: { recoil: { dist: 0.04, dx: 0, dy: -1 }, flame: { x: -0.3 }, hover: 0.04 },
  // twin ducted fans spin about their own hubs (visibly: ~1 turn/s reads as rotation, faster aliases to a strobe), the
  // dorsal turret yaws about its ring and kicks its twin barrels, pitching up toward falling rocks; a heavy, slow bob
  gunship: { top: { x: GUNSHIP.turret.x, y: GUNSHIP.turret.y, kick: 0.03 }, recoil: { dist: 0.04, dx: 1, dy: 0 }, elevate: { x: GUNSHIP.turret.x, y: GUNSHIP.turret.y, rest: 0, min: -0.2, max: 1.1 }, rotor: { x: GUNSHIP.fan.x, y: 0, z: GUNSHIP.fan.z, axis: 'y', idle: 7, work: 7, pair: true }, flame: { x: -0.4 }, hover: 0.06 },
  // the same airframe set down: fans folded and still, turret raised on its mast
  gun_platform: { top: { x: GUNSHIP.turret.x, y: GUN_PLATFORM_TURRET_Y, kick: 0.03 }, recoil: { dist: 0.04, dx: 1, dy: 0 }, elevate: { x: GUNSHIP.turret.x, y: GUN_PLATFORM_TURRET_Y, rest: 0, min: -0.2, max: 1.1 } },
  relay: { rotor: { x: 0, y: 0, z: 0, axis: 'y', idle: 0.7, work: 0.7 } },
  // the pronged crown ring turns slowly
  mooring_tower: { rotor: { x: 0, y: 0, z: 0, axis: 'y', idle: 0.8, work: 0.8 } },
  island_mortar: { top: { x: 0, y: 0.3, kick: 0.035 }, recoil: { dist: 0.08, dx: 0.48, dy: 0.88 } },
  ore_extractor: { rotor: { x: 0, y: 0.5, z: 0, axis: 'y', idle: 0, work: 13 }, shudder: 0.008 },
  // the winged windsock over the ridge flaps up and down in the wind
  aerie: { wave: { x0: 0, amp: 0.2, rate: 4, k: 6, axis: 'y' } },
  // the crown idles slowly and spins up while its seeded storm telegraphs and blows (state 'active')
  storm_seeder: { rotor: { x: 0, y: 0, z: 0, axis: 'y', idle: 0.35, work: 2.4 } },
  // the collector bowl and its vanes turn slowly into the weather
  stormcatcher: { rotor: { x: 0, y: 0, z: 0, axis: 'y', idle: 0.4, work: 0.4 } },
  headframe: { rotor: { x: 0, y: 1.80, z: 0, axis: 'z', idle: 0, work: 3, cycle: 'fill' } },
  bulkhead: {},
  geothermal: {},
  lava_bridge: {},
  // the pebble satellites under the rock circle it slowly
  island: { rotor: { x: 0, y: 0, z: 0, axis: 'y', idle: 0.12, work: 0.12 } },
  // panels roll toward the sun and unfold from a stowed stack with the deploy progress (packing folds them back)
  solar: { panel: { y: 0, fold: { root: SOLAR.root, folded: SOLAR.folded, stack: SOLAR.stack } }, hover: 0.03 },
  tug: { flame: { x: -0.28 }, hover: 0.03 },
  lancer: { recoil: { dist: 0.08, dx: 1, dy: 0 }, flame: { x: -0.52 }, hover: 0.03 },
  skiff: { recoil: { dist: 0.035, dx: 1, dy: 0 }, flame: { x: -0.46 }, hover: 0.025 },
  // PD barrels depress over the shoulders toward Sky payloads below, no further than the hull plates allow
  bastion: { recoil: { dist: 0.035, dx: 1, dy: 0 }, elevate: { x: BASTION_PD.x, y: BASTION_PD.height, rest: 0, min: -1.0, max: 1.0 }, flame: { x: -0.76 }, hover: 0.018 },
  // a heavy stride on long boots that step out past the torso, a shotgun kick, and a hunker (squat on the work
  // channel) behind the planted shield
  warden: { gait: { kind: 'legs', stride: 0.42, hip: WARDEN.hip }, recoil: { dist: 0.05, dx: 1, dy: 0 }, jolt: 0.07, squat: 0.25 },
  // a heavier, shorter stride; the flamer kicks back and the hull jolts as it fires, and the pilot light under the
  // nozzle flickers all the time and flares with each burst (riding the recoil)
  breacher: {
    gait: { kind: 'legs', stride: 0.3, hip: 0.18 },
    recoil: { dist: 0.05, dx: 1, dy: 0 },
    pilot: { ...BREACHER.pilot, rate: 19, amp: 0.3, flare: 1.4 },
    jolt: 0.06,
  },
  // converting ('active'): the gantry hoist swings, the beacon on the beam spins (lit) and the chimney puffs
  drill_yard: {
    swing: { x: DRILL_YARD.gantry, y: DRILL_YARD.pivot, z: 0, axis: 'x', amp: 0.35, rate: 2.4 },
    rotor: { x: DRILL_YARD.gantry, y: 0, z: DRILL_YARD.beacon, axis: 'y', idle: 0, work: 7 },
  },
  asteroid: {},
  // the torn flag flutters in the wind, harder toward its frayed end
  post: { wave: { x0: 0.03, amp: 0.22, rate: 5, k: 9 } },
  // the derelict core floats in place (its slow spin is in `rig.ts`)
  core: { hover: 0.05 },
};

export type VisualChannel = 'work' | 'fill';
type VisualSource =
  | { source: 'carry' | 'progress' | 'linked' | 'delivery' | 'cycle' }
  /** 1 once the structure stands built (idle life), 0 while it is a construction site. */
  | { source: 'built' }
  /** A Mooring Tower whose tether holds (or lowers or raises) an island. */
  | { source: 'tethered' }
  /** The Gunship ↔ Gun Platform swap, a presentation channel `Entities` writes from the track (`EMPLACE_SWAP`); 0 here. */
  | { source: 'swap' }
  | { source: 'presentation'; channel?: VisualChannel }
  /** Deploy stance (rules/deploy.ts): rises 0→1 with progress while deploying, 1 deployed, falls 1→0 while packing. */
  | { source: 'deploy' }
  | { source: 'state'; states: readonly Entity['state'][] };
export interface StatePart {
  part: number;
  channel: VisualChannel;
  /** Uniform growth about a point: zero collapses the cargo inside its empty receptacle. */
  scale?: readonly [number, number, number];
  /** Height × the channel (from the ground up, y = 0): a sandbag course rising out of the ground as it is piled. */
  rise?: boolean;
  /** Symmetric Z squeeze; amplitude is a fraction, rate is radians/second. */
  pinch?: { centre: number; amplitude: number; rate: number };
  /** Upward cable travel; the channel is a CPU-integrated cycle (0..1), faded before wrapping to the landing. */
  hoist?: { distance: number; fadeFrom: number };
  /**
   * A looping puff while the channel is on (hidden while off): each cycle it swells out of `origin`, rises `rise`,
   * grows by `grow` and shrinks away, `rate` cycles a second (per-instance phase).
   */
  drift?: { origin: readonly [number, number, number]; rise: number; grow: number; rate: number };
  /** Discrete channel window (e.g. bend/junction) instead of its continuous value. */
  range?: readonly [number, number];
  /**
   * Eased channel window instead of its value: the op runs 0 → 1 (smoothstep) while the channel crosses it, so one
   * table can sequence a motion in steps along a progress channel.
   */
  ease?: readonly [number, number];
  /** A hump over a channel window instead of its value: 0 at both ends, 1 midway (a thud, a kick). */
  bump?: readonly [number, number];
  translate?: readonly [number, number, number];
  stretch?: readonly [number, number, number];
  /** Rotation by `angle` (rad) × the channel about `axis` through `pivot`. */
  turn?: { axis: 'x' | 'y' | 'z'; angle: number; pivot: readonly [number, number, number] };
  visible?: boolean;
}
interface StateVisual {
  /**
   * `passage`: a tunnel gate turned across the open neighbours it guards; `span`: a deck laid along its run (spanYaw),
   * still, whatever crosses it.
   */
  pose?: 'passage' | 'span';
  /** Mobile passages retain their combat heading rather than the tunnel-derived orientation. */
  heading?: 'unit';
  channels: Partial<Record<VisualChannel, VisualSource>>;
  parts?: readonly StatePart[];
}

/** Declarative view → channels → tagged-part motion. Extend this table and tag geometry, not the renderer loop. */
export const STATE_VISUALS: Partial<Record<Kind, StateVisual>> = {
  digger: {
    channels: {
      work: { source: 'state', states: ['digging', 'mining', 'laying', 'fortifying', 'bridging', 'breaching'] },
      fill: { source: 'carry' },
    },
    parts: [{ part: PART.cargo, channel: 'fill', scale: DIGGER_CARGO_ORIGIN }],
  },
  ore_extractor: {
    channels: { work: { source: 'state', states: ['mining'] } },
    parts: [
      { part: PART.flame, channel: 'work', visible: true },
      { part: PART.dust, channel: 'work', visible: true, drift: { origin: [0, 0.18, 0], rise: 0.65, grow: 1.5, rate: 1.7 } },
    ],
  },
  // Laying: the fused charge (cargo) leaves the turret and settles onto the floor with the laying progress.
  sapper: {
    channels: { work: { source: 'state', states: ['laying', 'undermining'] }, fill: { source: 'progress' } },
    parts: [{ part: PART.cargo, channel: 'fill', translate: SAPPER_CHARGE_DROP }],
  },
  storm_seeder: { channels: { work: { source: 'state', states: ['active'] } } },
  // A built tap breathes steam off its turbine cap.
  geothermal: {
    channels: { work: { source: 'built' } },
    parts: [{ part: PART.dust, channel: 'work', drift: { origin: GEOTHERMAL_STEAM, rise: 0.5, grow: 1.3, rate: 0.6 } }],
  },
  // A live tether (fill) makes the crown sensor crackle (`KindMesh`).
  mooring_tower: { channels: { fill: { source: 'tethered' } } },
  // Walling, with the deploy progress (packing runs it back): the riot shield (panel) swings round from its carry on
  // the left arm to face square ahead, slides across the front, drops to plant with a thud the body dips into, then
  // widens into the wall. Entries apply in order: the turn about the carried shield's centre comes first.
  warden: {
    pose: 'passage', heading: 'unit',
    channels: { work: { source: 'deploy' }, fill: { source: 'presentation', channel: 'work' } },
    parts: [
      { part: PART.panel, channel: 'work', ease: [0, 0.45], turn: { axis: 'y', angle: -WARDEN.shield.carry, pivot: [WARDEN.shield.x, 0, WARDEN.shield.z] } },
      { part: PART.panel, channel: 'work', ease: [0.15, 0.6], translate: [0.08, 0, -WARDEN.shield.z] },
      { part: PART.panel, channel: 'work', ease: [0.5, 0.68], translate: [0, -WARDEN.shield.y, 0] },
      ...[PART.body, PART.barrel].map((part): StatePart => ({ part, channel: 'work', bump: [0.64, 0.9], translate: [0, -0.035, 0] })),
      { part: PART.panel, channel: 'work', ease: [0.7, 1], stretch: [1, 1.2, 1.6] },
      { part: PART.panel, channel: 'fill', translate: [0, 0.86, 0] },
    ],
  },
  // Dug in, with the deploy progress (packing runs it back): a scrape opens round the trooper, who crouches and sinks
  // into it, then the sandbag lip is piled: the ring course rises out of the ground, then the parapet in front, so only
  // the helmet, shoulders and rifle show over it. Dirt kicks up beside the hole while digging in or out (fill).
  trooper: {
    channels: { work: { source: 'deploy' }, fill: { source: 'state', states: ['digging_in', 'digging_out'] } },
    parts: [
      { part: PART.pit, channel: 'work', ease: [0, 0.35], scale: [0, 0, 0] },
      ...[PART.body, PART.left, PART.right, PART.barrel].map((part): StatePart => ({ part, channel: 'work', ease: [0.1, 0.6], translate: [0, -FOXHOLE.sink, 0] })),
      { part: PART.stance, channel: 'work', ease: [0.2, 0.26], visible: true },
      { part: PART.stance, channel: 'work', ease: [0.2, 0.65], rise: true },
      { part: PART.stance2, channel: 'work', ease: [0.6, 0.66], visible: true },
      { part: PART.stance2, channel: 'work', ease: [0.6, 0.95], rise: true },
      { part: PART.dust, channel: 'fill', drift: { origin: FOXHOLE.dirt, rise: 0.2, grow: 0.9, rate: 1.6 } },
    ],
  },
  // Siege (StarCraft's siege tank as the reference), with the deploy progress, packing in reverse: outrigger legs show
  // folded up against the hull sides, swing down and out and plant on their pads; the hull settles onto them; the
  // turret swings round while the barrel runs out into the long, raised artillery barrel; then the hull locks down with
  // a thud it dips into and dust bursting from the pads (work: turret kinds keep fill for the mount yaw). The muzzle
  // mirror (`orbitMuzzle`) follows the extended barrel.
  tank: {
    channels: { work: { source: 'deploy' } },
    parts: [
      ...[PART.stance, PART.stance2].map((part): StatePart => ({ part, channel: 'work', ease: [0, TANK_SIEGE.legs[0] + 0.03], visible: true })),
      ...([[PART.stance, 1], [PART.stance2, -1]] as const).map(([part, s]): StatePart => ({
        part, channel: 'work', ease: TANK_SIEGE.legs, turn: { axis: 'x', angle: s * TANK_LEG_ANGLE, pivot: [0, TANK_SIEGE.hinge.y, s * TANK_SIEGE.hinge.z] },
      })),
      ...[PART.body, PART.top, PART.barrel].map((part): StatePart => ({ part, channel: 'work', ease: TANK_SIEGE.settle, translate: [0, -TANK_SIEGE.lower, 0] })),
      { part: PART.barrel, channel: 'work', ease: TANK_SIEGE.extend, stretch: [TANK_SIEGE.reach, 1, 1] },
      { part: PART.barrel, channel: 'work', ease: TANK_SIEGE.extend, translate: [0, TANK_SIEGE.raise, 0] },
      ...[PART.top, PART.barrel].map((part): StatePart => ({ part, channel: 'work', bump: TANK_SIEGE.swing, turn: { axis: 'y', angle: TANK_SIEGE.turn, pivot: [-0.06, 0, 0] } })),
      ...[PART.body, PART.top, PART.barrel].map((part): StatePart => ({ part, channel: 'work', bump: TANK_SIEGE.thud, translate: [0, -TANK_SIEGE.dip, 0] })),
      { part: PART.dust, channel: 'work', bump: TANK_SIEGE.dust, scale: [0, 0, 0] },
      { part: PART.dust, channel: 'work', bump: TANK_SIEGE.dust, translate: [0, 0.1, 0] },
    ],
  },
  // Emplaced: pads and a low sandbag berm settle round the tracks.
  flak: {
    channels: { work: { source: 'deploy' } },
    parts: [
      { part: PART.stance, channel: 'work', visible: true, scale: [0, 0, 0] },
      // the mount settles onto its pads and locks down with a thud that kicks up dust (the tank's siege, shortened)
      ...[PART.body, PART.top, PART.barrel, PART.rotor].map((part): StatePart => ({ part, channel: 'work', ease: FLAK_EMPLACE.settle, translate: [0, -FLAK_EMPLACE.lower, 0] })),
      ...[PART.body, PART.top, PART.barrel, PART.rotor].map((part): StatePart => ({ part, channel: 'work', bump: FLAK_EMPLACE.thud, translate: [0, -FLAK_EMPLACE.dip, 0] })),
      { part: PART.dust, channel: 'work', bump: FLAK_EMPLACE.dust, scale: [0, 0, 0] },
      { part: PART.dust, channel: 'work', bump: FLAK_EMPLACE.dust, translate: [0, 0.08, 0] },
    ],
  },
  // Converting: the beacon lamp lights (its paddle spins, RIG.rotor) and exhaust puffs leave the chimney; idle, the
  // yard is still and dark.
  drill_yard: {
    channels: { work: { source: 'state', states: ['active'] } },
    parts: [
      { part: PART.flame, channel: 'work', visible: true },
      { part: PART.cargo, channel: 'work', drift: { origin: [DRILL_YARD.chimney.x, DRILL_YARD.chimney.y, DRILL_YARD.chimney.z], rise: 0.55, grow: 1.1, rate: 0.7 } },
    ],
  },
  // Turned along its run; the deck itself is Depths terrain (DepthsLayer), so a known bridge reads even unseen.
  lava_bridge: { pose: 'span', channels: {} },
  bulkhead: {
    pose: 'passage',
    channels: { work: { source: 'presentation' }, fill: { source: 'presentation' } },
    parts: [
      ...[PART.tool, PART.left, PART.right, PART.panel].map(part => ({ part, channel: 'work' as const, translate: [0, 0.86, 0] as const })),
      ...[PART.body, PART.tool].flatMap(part => [
        { part, channel: 'fill' as const, range: [0.25, 0.75] as const, stretch: [1, 1, Math.SQRT2] as const },
        { part, channel: 'fill' as const, range: [0.9, 1.1] as const, translate: [-0.35, 0, 0] as const },
      ]),
      ...[PART.top, PART.left, PART.right, PART.panel].map(part => ({ part, channel: 'fill' as const, range: [0.9, 1.1] as const, visible: true })),
      // sealing: the leaves bounce as they hit the floor and dust puffs out from under them
      ...[PART.tool, PART.left, PART.right, PART.panel].map(part => ({ part, channel: 'work' as const, bump: BULKHEAD_SEAL.thud, translate: [0, -BULKHEAD_SEAL.dip, 0] as const })),
      { part: PART.dust, channel: 'work', bump: BULKHEAD_SEAL.thud, scale: [0, 0, 0] },
    ],
  },
  shaft: {
    channels: { work: { source: 'delivery' }, fill: { source: 'cycle' } },
    parts: [{ part: PART.cargo, channel: 'fill', hoist: { distance: 2.1, fadeFrom: 0.65 } }],
  },
  headframe: {
    channels: { work: { source: 'delivery' }, fill: { source: 'cycle' } },
    parts: [
      { part: PART.tool, channel: 'fill', hoist: { distance: 1.1, fadeFrom: 0.8 } },
      { part: PART.cargo, channel: 'fill', hoist: { distance: 2.1, fadeFrom: 0.65 } },
    ],
  },
  tug: {
    channels: { fill: { source: 'linked' } },
    parts: [{ part: PART.tool, channel: 'fill', pinch: { centre: 0, amplitude: 0.35, rate: 4 } }],
  },
  // Landing (the emplace swap, `EMPLACE_SWAP`; work runs 1 → 0 as the new platform settles): the airframe first sinks
  // from hover onto its skids, then folds its outboard wings and fans up.
  gun_platform: {
    channels: { work: { source: 'swap' } },
    parts: [
      ...[PART.body, PART.top, PART.barrel, L, R].map((part): StatePart => ({ part, channel: 'work', ease: [EMPLACE_SWAP.foldEnd, 1], translate: [0, EMPLACE_SWAP.hover, 0] })),
      ...([[L, -1], [R, 1]] as const).map(([part, s]): StatePart => ({
        part, channel: 'work', ease: [0, EMPLACE_SWAP.foldEnd], turn: { axis: 'x', angle: s * GUN_PLATFORM.folded, pivot: [0, GUN_PLATFORM.lift, s * GUN_PLATFORM.hinge] },
      })),
    ],
  },
  // Taking off (the pack swap; work 1 → 0): the gunship lifts off the pad it stood on.
  gunship: {
    channels: { work: { source: 'swap' } },
    parts: [PART.body, PART.top, PART.barrel, PART.rotor, PART.flame].map((part): StatePart => ({ part, channel: 'work', ease: [0, 1], translate: [0, -EMPLACE_SWAP.hover, 0] })),
  },
  // A capture lowers the old flag down the staff with its progress; the taker's colour then flies at the top.
  post: {
    channels: { fill: { source: 'progress' } },
    parts: [{ part: PART.cloth, channel: 'fill', translate: [0, -0.5, 0] }],
  },
};

/** Allocation-free, normalized presentation channels; carryMax is cached from this match's rules. */
export function stateVisualChannel(e: Entity, channel: VisualChannel, carryMax: number, delivery = 0, cycle = 0, presentation?: { work: number; fill: number }): number {
  const source = STATE_VISUALS[e.kind]?.channels[channel];
  if (!source) return 0;
  switch (source.source) {
    case 'carry': return carryMax > 0 ? clamp((e.carry ?? 0) / carryMax, 0, 1) : 0;
    case 'progress': return clamp(e.progress ?? 0, 0, 1);
    case 'deploy': return deployChannel(e);
    case 'linked': return e.link ? 1 : 0;
    case 'swap': return 0;
    case 'built': return e.state === 'constructing' ? 0 : 1;
    case 'tethered': return e.mooringState === 'held' || e.mooringState === 'lowering' || e.mooringState === 'raising' ? 1 : 0;
    case 'delivery': return clamp(delivery, 0, 1);
    case 'cycle': return clamp(cycle, 0, 1);
    case 'presentation': return (presentation?.[source.channel ?? channel] ?? 0) * (e.kind === 'warden' ? deployChannel(e) : 1);
    case 'state': return source.states.includes(e.state) ? 1 : 0;
  }
}

/** A deploy stance's transition (rules/deploy.ts): 0 → 1 with progress while deploying, 1 deployed, back while packing. */
function deployChannel(e: Entity): number {
  const stance = STATS[e.kind as UnitKind]?.deploy;
  const states = stance ? DEPLOY_SPECS[stance].states : undefined;
  if (!states) return 0;
  const p = clamp(e.progress ?? 0, 0, 1);
  return e.state === states[1] ? 1 : e.state === states[0] ? p : e.state === states[2] ? 1 - p : 0;
}

/** Below this HP fraction a solar array's lit trim stutters: where the HP bar leaves its healthy band. */
export const SOLAR_DAMAGED = 0.6;
/** Field sizes of the packed solar fill (`packSolar`); `solarStatus` (`rig.ts`) decodes the same layout. */
export const SOLAR_FILL = { fold: 256, charge: 64, light: 16 } as const;
/**
 * A solar array's `fill` (its `work` carries the panel roll), packed as an integer so the float is exact: fold (the
 * deploy progress, 0…255), charge (0 until anchored, then 1 + the ramp multiplier rampStart → 1 in 62 steps: the
 * share of the edge trim lit), light (night → day, 0…15) and damaged (0/1), low field first.
 */
export function packSolar(e: Entity, rampStart: number, light: number): number {
  const { fold: F, charge: C, light: L } = SOLAR_FILL;
  const fold = Math.round(deployChannel(e) * (F - 1));
  const charge = e.state === 'unfurled' ? 1 + Math.round((rampStart + (1 - rampStart) * clamp(e.ramp ?? 0, 0, 1)) * (C - 2)) : 0;
  const lit = Math.round(clamp(light, 0, 1) * (L - 1));
  const damaged = e.hp < e.maxHp * SOLAR_DAMAGED ? 1 : 0;
  return fold + F * (charge + C * (lit + L * damaged));
}

/** One transverse portcullis, with three additional leaves/frames revealed only at a junction (288 triangles). */
function bulkheadParts(): Part[] {
  const parts: Part[] = [
    { geo: block(0.14, 0.78, 0.13, 0, 0, -0.35), paint: BODY.depths },
    { geo: block(0.14, 0.78, 0.13, 0, 0, 0.35), paint: BODY.depths },
    { geo: block(0.16, 0.10, 0.83, 0, 0.78), paint: BODY.depths, ...ACCENT },
    { geo: block(0.14, 0.78, 0.13, 0.35, 0, -0.35), paint: BODY.depths, part: PART.top },
    { geo: block(0.14, 0.78, 0.13, 0.35, 0, 0.35), paint: BODY.depths, part: PART.top },
    { geo: block(0.16, 0.10, 0.83, 0.35, 0.78), paint: BODY.depths, ...ACCENT, part: PART.top },
    { geo: block(0.56, 0.10, 0.13, 0, 0.78, -0.35), paint: BODY.depths, ...ACCENT, part: PART.top },
    { geo: block(0.56, 0.10, 0.13, 0, 0.78, 0.35), paint: BODY.depths, ...ACCENT, part: PART.top },
  ];
  const leaf = (part: number, x: number, z: number, yaw: number): void => {
    parts.push(
      { geo: block(0.08, 0.68, 0.62, 0, 0.04).rotateY(yaw).translate(x, 0, z), paint: IRON, part },
      { geo: block(0.12, 0.07, 0.64, 0, 0.15).rotateY(yaw).translate(x, 0, z), paint: STEEL, part },
      { geo: block(0.12, 0.07, 0.64, 0, 0.52).rotateY(yaw).translate(x, 0, z), paint: STEEL, part },
      { geo: block(0.15, 0.18, 0.16, 0, 0.30).rotateY(yaw).translate(x, 0, z), paint: BODY.depths, ...ACCENT, part },
    );
  };
  leaf(PART.tool, 0, 0, 0);
  leaf(PART.left, 0.35, 0, 0);
  leaf(PART.right, 0, -0.35, Math.PI / 2);
  leaf(PART.panel, 0, 0.35, Math.PI / 2);
  for (const z of [-0.25, 0.25]) parts.push({ geo: new OctahedronGeometry(0.08).translate(0.08, 0.04, z), paint: PLANT_DUST, part: PART.dust });
  return parts;
}

/** `n` sandbags (w × h × d blocks) evenly round a ring of `radius` on the ground: the deploy-stance kit. */
function stanceRing(n: number, radius: number, w: number, h: number, d: number): Part[] {
  return Array.from({ length: n }, (_, i): Part => ({ geo: block(d, h, w, radius, 0).rotateY((i * Math.PI * 2) / n), paint: UNIT_PAINT.sandbag, part: PART.stance }));
}

// ---------------------------------------------------------------- units and structures
/** Depths: stubby ochre crawlers. Surface: grounded olive vehicles. Sky: chalk-blue wings. Orbit: cream panels. */
function unit(kind: Exclude<Kind, NeutralKind>): Part[] {
  switch (kind) {
    case 'digger':
      // crawler with a drill nose (the pick: WEAPON_VISUALS forward 0.63, height 0.2) and an ore hopper astern
      return [
        { geo: pod(0.6, 0.18, 0.12, -0.02, 0.09, 0.19), paint: IRON, part: L },
        { geo: pod(0.6, 0.18, 0.12, -0.02, 0.09, -0.19), paint: IRON, part: R },
        { geo: block(0.46, 0.22, 0.28, -0.04, 0.08, 0, 0.82, 0.86), paint: BODY.depths },
        { geo: block(0.36, 0.05, 0.3, -0.04, 0.16), paint: BODY.depths, ...ACCENT },
        { geo: block(0.26, 0.05, 0.22, 0, 0.29, 0, 0.9, 0.9), paint: BODY.depths, ...ACCENT },
        { geo: block(0.14, 0.1, 0.1, 0.25, 0.15), paint: IRON },
        { geo: nose(0.13, 0.3, 0.33, 0.2, 0), paint: STEEL, part: PART.tool },
        { geo: rod(0.14, 0.06, 0.3, 0.2, 0), paint: IRON, part: PART.tool },
        { geo: block(0.26, 0.1, 0.28, -0.2, 0.29, 0, 1.08, 1.08), paint: IRON },
        { geo: new OctahedronGeometry(0.14).scale(1, 0.9, 1).translate(-0.2, 0.43, 0), paint: UNIT_PAINT.ore, glow: 0.9, part: PART.cargo },
        { geo: new OctahedronGeometry(0.035).translate(0.17, 0.3, 0.09), paint: UNIT_PAINT.sensor, glow: 1.5 },
      ];
    case 'sapper':
      // flat beetle on skids with a cutter nose, carrying a fused charge
      return [
        { geo: pod(0.44, 0.1, 0.08, 0, 0.05, 0.15), paint: IRON, part: L },
        { geo: pod(0.44, 0.1, 0.08, 0, 0.05, -0.15), paint: IRON, part: R },
        { geo: block(0.46, 0.13, 0.3, 0, 0.07, 0, 0.8, 0.8, -0.03), paint: BODY.depths },
        { geo: block(0.3, 0.04, 0.31, -0.02, 0.1), paint: BODY.depths, ...ACCENT },
        { geo: block(0.12, 0.08, 0.16, 0.25, 0.06, 0, 0.6, 0.7), paint: IRON },
        { geo: cyl(0.11, 0.12, 0.13, 8).translate(-0.06, 0.255, 0), paint: IRON, part: PART.top },
        { geo: cyl(0.1, 0.125, 0.035, 8).translate(-0.06, 0.332, 0), paint: IRON, ...ACCENT, part: PART.top },
        { geo: new OctahedronGeometry(0.05).translate(-0.06, 0.39, 0), paint: UNIT_PAINT.fuse, glow: 2.5, part: PART.cargo },
      ];
    case 'trooper': {
      // upright pill with a helmet, backpack and a right-hand rifle (WEAPON_VISUALS rifle 0.30 / 0.33 / 0.12); dug in
      // (stance kit, FOXHOLE): a dark scrape, a ring course of sandbags, a two-bag parapet in front on top of it and a
      // dirt clod kicked up while digging. The bags have no underside and the band no caps (inside the torso).
      const { radius, ring, bag } = FOXHOLE;
      const sandbag = (a: number, y: number, len: number, part: number): Part =>
        ({ geo: withoutFaces(block(0.1, bag, len, radius - 0.04, y, 0, 0.8, 0.9), FACE.ny).rotateY(a), paint: UNIT_PAINT.sandbag, part });
      return [
        { geo: block(0.09, 0.2, 0.09, 0, 0, 0.06), paint: IRON, part: L },
        { geo: block(0.09, 0.2, 0.09, 0, 0, -0.06), paint: IRON, part: R },
        { geo: cyl(0.115, 0.13, 0.24, 6).translate(0, 0.31, 0), paint: BODY.surface },
        { geo: new CylinderGeometry(0.135, 0.135, 0.06, 6, 1, true).translate(0, 0.33, 0), paint: BODY.surface, ...ACCENT },
        { geo: cyl(0.08, 0.09, 0.09, 6).translate(0, 0.475, 0), paint: STEEL },
        { geo: cyl(0.07, 0.105, 0.06, 6).translate(0, 0.545, 0), paint: BODY.surface, ...ACCENT },
        { geo: block(0.1, 0.15, 0.16, -0.15, 0.24), paint: IRON },
        { geo: block(0.36, 0.07, 0.07, 0.12, 0.295, 0.12), paint: IRON, part: PART.barrel },
        { geo: new CircleGeometry(radius, 8).rotateX(-Math.PI / 2).translate(0, 0.012, 0), paint: SCRAPE, part: PART.pit },
        ...Array.from({ length: ring }, (_, i) => sandbag((i * Math.PI * 2) / ring, 0, 0.3, PART.stance)),
        ...[-1, 1].map((s) => sandbag(s * 0.42, bag, 0.2, PART.stance2)),
        { geo: new OctahedronGeometry(0.05).translate(...FOXHOLE.dirt), paint: DIRT, part: PART.dust },
      ];
    }
    case 'breacher': {
      // heavy flamer trooper: a squared plated torso (the trooper's is a round pill) under broad team pauldrons (the
      // band), a sealed helmet (the cap) with a glowing visor and a rebreather snout, twin orange fuel tanks on a
      // yoke at its back feeding a hose to a chunky hip flamer, its pilot light under the nozzle (BREACHER anchors,
      // WEAPON_VISUALS flamer). The tanks behind and the flamer ahead make the facing readable at any zoom.
      const { nozzle, pilot } = BREACHER;
      const z = nozzle.z;
      return [
        { geo: block(0.11, 0.18, 0.11, 0, 0, 0.075), paint: IRON, part: L },
        { geo: block(0.11, 0.18, 0.11, 0, 0, -0.075), paint: IRON, part: R },
        { geo: block(0.24, 0.26, 0.3, -0.01, 0.17, 0, 0.88, 0.9), paint: BODY.surface },
        ...[-1, 1].map((s): Part => ({ geo: block(0.15, 0.08, 0.13, -0.01, 0.37, s * 0.185, 0.75, 0.8), paint: BODY.surface, ...ACCENT })),
        { geo: block(0.17, 0.14, 0.17, 0, 0.42, 0, 0.8, 0.8), paint: BODY.surface, ...ACCENT },
        { geo: block(0.035, 0.035, 0.12, 0.08, 0.485), paint: UNIT_PAINT.sensor, glow: 1.5 },
        { geo: nose(0.035, 0.06, 0.07, 0.448, 0), paint: IRON },
        ...[-1, 1].map((s): Part => ({ geo: cyl(0.06, 0.06, 0.3, 6).translate(-0.2, 0.33, s * 0.065), paint: UNIT_PAINT.fuse })),
        { geo: block(0.08, 0.05, 0.24, -0.2, 0.445), paint: IRON },
        { geo: pipe([-0.2, 0.2, 0.11], [-0.1, 0.15, 0.2], 0.03), paint: IRON },
        { geo: pipe([-0.1, 0.15, 0.2], [0, 0.27, z], 0.03), paint: IRON },
        { geo: block(0.22, 0.08, 0.09, 0.1, nozzle.y - 0.04, z), paint: IRON, part: PART.barrel },
        { geo: rod(0.03, 0.16, 0.21, nozzle.y, z), paint: IRON, part: PART.barrel },
        { geo: block(0.05, 0.08, 0.08, nozzle.x - 0.025, nozzle.y - 0.04, z), paint: IRON, part: PART.barrel },
        { geo: block(0.1, 0.04, 0.05, 0.3, pilot.y - 0.02, z), paint: IRON, part: PART.barrel },
        { geo: new OctahedronGeometry(0.032).translate(pilot.x, pilot.y, pilot.z), paint: UNIT_PAINT.engine, glow: 2.5, part: PART.flame },
      ];
    }
    case 'warden': {
      // squat armoured sentinel on long boots: the legs swing from the true hip (WARDEN.hip) under a broad plated
      // torso set back so the toes step out past its front, a visored helmet, a riot shield carried high and angled
      // on the left arm, clear of the boots (panel: swung round and planted across the front when walled), and a
      // short shotgun in the right hand (WARDEN.muzzle, WEAPON_VISUALS shotgun)
      const { muzzle, shield: sh } = WARDEN;
      const carry = (g: BufferGeometry): BufferGeometry => g.translate(-sh.x, 0, -sh.z).rotateY(sh.carry).translate(sh.x, 0, sh.z);
      return [
        ...[-1, 1].map((s): Part => ({ geo: block(0.18, 0.25, 0.11, 0.02, 0, s * 0.12, 0.55, 1, -0.02), paint: IRON, part: s > 0 ? L : R })),
        { geo: block(0.34, 0.24, 0.4, -0.08, 0.2, 0, 0.86, 0.9), paint: BODY.depths },
        { geo: block(0.36, 0.05, 0.42, -0.08, 0.25), paint: BODY.depths, ...ACCENT },
        ...[-1, 1].map((s): Part => ({ geo: block(0.17, 0.08, 0.14, -0.09, 0.4, s * 0.19, 0.9, 0.9), paint: IRON })),
        { geo: cyl(0.1, 0.125, 0.11, 6).translate(-0.07, 0.49, 0), paint: STEEL },
        { geo: cyl(0.085, 0.13, 0.04, 6).translate(-0.07, 0.56, 0), paint: BODY.depths, ...ACCENT },
        { geo: block(0.03, 0.025, 0.13, 0.04, 0.48), paint: UNIT_PAINT.sensor, glow: 1.5 },
        { geo: block(0.12, 0.2, 0.26, -0.27, 0.22), paint: IRON },
        { geo: block(0.2, 0.07, 0.08, -0.02, muzzle.y - 0.035, muzzle.z), paint: IRON },
        { geo: rod(0.04, 0.23, muzzle.x - 0.23, muzzle.y, muzzle.z), paint: IRON, part: PART.barrel },
        { geo: rod(0.05, 0.05, muzzle.x - 0.05, muzzle.y, muzzle.z), paint: STEEL, part: PART.barrel },
        { geo: carry(block(0.05, 0.52, 0.3, sh.x, sh.y, sh.z, 0.9, 0.85)), paint: STEEL, part: PART.panel },
        { geo: carry(block(0.06, 0.06, 0.31, sh.x, sh.y + 0.35, sh.z)), paint: BODY.depths, ...ACCENT, part: PART.panel },
        { geo: carry(block(0.06, 0.03, 0.15, sh.x, sh.y + 0.43, sh.z)), paint: IRON, part: PART.panel },
        { geo: carry(block(0.06, 0.05, 0.31, sh.x, sh.y + 0.07, sh.z)), paint: IRON, part: PART.panel },
      ];
    }
    case 'tank':
      // low wedge on tracks, turret with a long barrel (WEAPON_VISUALS cannon tip 0.76 / 0.42) and an engine deck
      return [
        { geo: pod(1.0, 0.24, 0.2, -0.02, 0.12, 0.29), paint: IRON, part: L },
        { geo: pod(1.0, 0.24, 0.2, -0.02, 0.12, -0.29), paint: IRON, part: R },
        { geo: block(0.9, 0.18, 0.46, -0.04, 0.1, 0, 0.86, 0.9, -0.04), paint: BODY.surface },
        { geo: block(0.2, 0.05, 0.34, -0.36, 0.27), paint: IRON },
        { geo: cyl(0.25, 0.27, 0.06, 8).translate(-0.06, 0.31, 0), paint: BODY.surface, ...ACCENT, part: PART.top },
        { geo: block(0.44, 0.16, 0.38, -0.06, 0.33, 0, 0.8, 0.82, -0.02), paint: BODY.surface, part: PART.top },
        { geo: block(0.33, 0.04, 0.29, -0.08, 0.485), paint: BODY.surface, ...ACCENT, part: PART.top },
        { geo: block(0.1, 0.13, 0.16, 0.15, 0.355), paint: IRON, part: PART.top },
        { geo: rod(0.045, 0.56, 0.12, 0.42, 0), paint: IRON, part: PART.barrel },
        { geo: rod(0.068, 0.08, 0.68, 0.42, 0), paint: IRON, part: PART.barrel },
        { geo: cyl(0.06, 0.06, 0.06, 6).translate(-0.16, 0.53, 0.09), paint: STEEL, part: PART.top },
        // siege (stance kit, TANK_SIEGE): four outrigger legs hinged outside the tracks, authored folded straight up
        // (STATE_VISUALS swings them down and out onto their pads), and a dust puff at each foot for the lock-down
        ...[-1, 1].flatMap((sx) => [-1, 1].flatMap((sz): Part[] => {
          const { hinge, foot } = TANK_SIEGE;
          const len = Math.hypot(foot.y, foot.z);
          const part = sz > 0 ? PART.stance : PART.stance2;
          const pad = withoutFaces(block(0.14, 0.03, 0.12, 0, -0.015, 0), FACE.ny).rotateX(-sz * TANK_LEG_ANGLE).translate(sx * hinge.x, hinge.y + len, sz * hinge.z);
          return [
            { geo: withoutFaces(block(0.06, len, 0.06, sx * hinge.x, hinge.y, sz * hinge.z), FACE.py, FACE.ny), paint: IRON, part },
            { geo: pad, paint: STEEL, part },
            { geo: new OctahedronGeometry(0.09).translate(sx * hinge.x, 0.04, sz * (hinge.z + foot.z)), paint: PLANT_DUST, part: PART.dust },
          ];
        })),
      ];
    case 'flak':
      // tracked mount with twin barrels raised 52° (WEAPON_VISUALS flak tip 0.46 / 0.77) and a radar astern
      return [
        { geo: pod(0.84, 0.22, 0.17, -0.02, 0.11, 0.26), paint: IRON, part: L },
        { geo: pod(0.84, 0.22, 0.17, -0.02, 0.11, -0.26), paint: IRON, part: R },
        { geo: block(0.76, 0.18, 0.42, -0.03, 0.1, 0, 0.9, 0.9), paint: BODY.surface },
        { geo: cyl(0.21, 0.24, 0.08, 8).translate(0.06, 0.32, 0), paint: BODY.surface, ...ACCENT, part: PART.top },
        { geo: block(0.26, 0.14, 0.3, 0.08, 0.35, 0, 0.85, 0.9), paint: STEEL, part: PART.top },
        { geo: block(0.21, 0.03, 0.26, 0.08, 0.485), paint: BODY.surface, ...ACCENT, part: PART.top },
        ...[-1, 1].map((s): Part => ({ geo: rod(0.035, 0.42, 0, 0, 0).rotateZ(0.91).translate(0.2, 0.44, s * 0.08), paint: IRON, part: PART.barrel })),
        { geo: cyl(0.03, 0.03, 0.2, 6).translate(-0.27, 0.36, 0), paint: IRON, part: PART.rotor },
        { geo: block(0.06, 0.1, 0.3, -0.27, 0.44), paint: STEEL, part: PART.rotor },
        { geo: new OctahedronGeometry(0.035).translate(-0.27, 0.57, 0), paint: UNIT_PAINT.sensor, glow: 1.5, part: PART.rotor },
        // emplaced: a low sandbag berm round the tracks (stance kit)
        ...stanceRing(8, 0.5, 0.2, 0.09, 0.1),
        ...[-1, 1].map((s): Part => ({ geo: new OctahedronGeometry(0.08).translate(-0.1, 0.04, s * 0.42), paint: PLANT_DUST, part: PART.dust })),
      ];
    case 'bulkhead':
      return bulkheadParts();
    case 'lava_bridge':
      // Railings in the owner's trim along both edges of the deck the Depths layer lays (span along +x): low iron
      // posts and a team-painted handrail, kept to the edges and knee height so crossing units stay in clear view. The
      // rails run as long as the railings stand apart (0.95 both ways), so the footprint fit lands them on the cell edge.
      return [-1, 1].flatMap((s): Part[] => [
        ...[-0.42, 0, 0.42].map((x): Part => ({ geo: block(0.06, 0.24, 0.06, x, 0, s * 0.43), paint: IRON })),
        { geo: block(0.95, 0.05, 0.06, 0, 0.22, s * 0.43), paint: BODY.depths, ...ACCENT },
        { geo: block(0.95, 0.04, 0.05, 0, 0, s * 0.45), paint: STEEL },
      ]);
    case 'geothermal':
      // Rock-mounted heat exchanger: ochre collar, twin hot pipes and a capped turbine.
      return [
        { geo: cyl(0.36, 0.44, 0.16, 8).translate(0, 0.08, 0), paint: BODY.depths, ...ACCENT },
        { geo: block(0.48, 0.38, 0.4, 0, 0.16), paint: IRON },
        { geo: cyl(0.2, 0.24, 0.14, 8).translate(0, 0.61, 0), paint: BODY.depths, ...ACCENT },
        ...[-1, 1].map((s): Part => ({ geo: cyl(0.055, 0.055, 0.55, 6).translate(s * 0.3, 0.42, 0), paint: UNIT_PAINT.fuse, glow: 1.2 })),
        { geo: block(0.56, 0.08, 0.16, 0, 0.69), paint: STEEL },
        { geo: block(0.12, 0.18, 0.025, 0, 0.28, 0.21), paint: UNIT_PAINT.sensor, glow: 1.5 },
        // steam off the turbine cap, puffing whenever the tap stands built (STATE_VISUALS)
        { geo: new IcosahedronGeometry(0.1, 0).translate(GEOTHERMAL_STEAM[0], GEOTHERMAL_STEAM[1], GEOTHERMAL_STEAM[2]), paint: SMOKE, part: PART.dust },
      ];
    case 'turret':
      // octagonal plinth, clearly wider than the gun house it carries (TURRET anchors: the barrel tip is the one part
      // allowed past the plinth's footprint) and a sweeping sensor on the roof
      return [
        { geo: cyl(0.44, 0.52, 0.3, 8).translate(0, 0.15, 0), paint: BODY.surface },
        { geo: cyl(0.47, 0.47, 0.07, 8).translate(0, 0.295, 0), paint: BODY.surface, ...ACCENT },
        { geo: block(0.68, 0.32, 0.58, -0.04, 0.33, 0, 0.8, 0.85), paint: STEEL, part: PART.top },
        { geo: block(0.5, 0.04, 0.45, -0.05, 0.645), paint: BODY.surface, ...ACCENT, part: PART.top },
        { geo: rod(0.06, TURRET.tip - 0.24, 0.16, TURRET.y, 0), paint: IRON, part: PART.barrel },
        { geo: rod(0.085, 0.08, TURRET.tip - 0.08, TURRET.y, 0), paint: IRON, part: PART.barrel },
        { geo: cyl(0.03, 0.03, 0.16, 6).translate(-0.22, 0.73, 0.14), paint: IRON, part: PART.rotor },
        { geo: block(0.05, 0.08, 0.2, -0.22, 0.8, 0.14), paint: STEEL, part: PART.rotor },
        { geo: new OctahedronGeometry(0.035).translate(-0.22, 0.92, 0.14), paint: UNIT_PAINT.sensor, glow: 1.5, part: PART.rotor },
      ];
    case 'headframe':
      // Tall winding tower; a spoked wheel makes hauling visible even in silhouette.
      return [
        { geo: cyl(0.62, 0.70, 0.14, 8).translate(0, 0.07, 0), paint: STEEL },
        { geo: cyl(0.50, 0.50, 0.02, 8).translate(0, 0.15, 0), paint: IRON },
        { geo: block(0.12, 1.38, 0.12, -0.20, 0.14, -0.46, 1, 1, 0.20), paint: BODY.surface },
        { geo: block(0.12, 1.38, 0.12, -0.20, 0.14, 0.46, 1, 1, 0.20), paint: BODY.surface },
        { geo: block(0.12, 1.10, 0.12, 0.42, 0.14, -0.46, 1, 1, -0.42), paint: BODY.surface },
        { geo: block(0.12, 1.10, 0.12, 0.42, 0.14, 0.46, 1, 1, -0.42), paint: BODY.surface },
        { geo: block(0.40, 0.09, 1.08, 0, 1.55), paint: BODY.surface, ...ACCENT },
        { geo: block(0.16, 0.09, 1.08, 0, 0.46), paint: BODY.surface, ...ACCENT },
        ...sheave(SHEAVE.headframe, 1.80, IRON),
        { geo: block(0.06, 1.52, 0.06, 0.27, 0.28), paint: IRON },
        { geo: block(0.30, 0.19, 0.28, 0.27, 0.16, 0, 1.2, 1.2), paint: STEEL, part: PART.tool },
      ];
    case 'drill_yard': {
      // an industrial training yard on a concrete pad: a team-painted barrier fence on three sides with iron
      // gateposts at the open front (troopers walk in, Breachers walk out), a gantry across the middle whose hoist
      // swings while converting (tool), a warning beacon on the beam end (rotor paddle; the lamp lights while
      // converting), two orange fuel tanks, a stack of crates and an exhaust chimney that puffs while converting
      // (cargo). Idle, it stands still and dark. Cap: the gantry beam; band: the fence.
      const { gantry: gx, pivot, beacon, chimney: c } = DRILL_YARD;
      return [
        { geo: block(1.46, 0.08, 1.46, 0, 0), paint: STEEL },
        { geo: block(0.06, 0.16, 1.4, -0.7, 0.08), paint: BODY.surface, ...ACCENT },
        ...[-1, 1].flatMap((s): Part[] => [
          { geo: block(0.98, 0.16, 0.06, -0.21, 0.08, s * 0.7), paint: BODY.surface, ...ACCENT },
          { geo: block(0.08, 0.36, 0.08, 0.32, 0.08, s * 0.7), paint: IRON },
          { geo: block(0.08, 1.0, 0.08, gx, 0.08, s * 0.55), paint: BODY.surface },
        ]),
        { geo: block(0.14, 0.1, 1.26, gx, 1.08), paint: BODY.surface, ...ACCENT },
        { geo: block(0.05, 0.5, 0.05, gx, pivot - 0.5), paint: IRON, part: PART.tool },
        { geo: block(0.16, 0.14, 0.16, gx, pivot - 0.64, 0, 0.6, 0.6), paint: STEEL, part: PART.tool },
        { geo: block(0.06, 0.13, 0.15, gx + 0.075, 1.18, beacon), paint: STEEL, part: PART.rotor },
        { geo: new OctahedronGeometry(0.06).translate(gx, 1.25, beacon), paint: UNIT_PAINT.fuse, glow: 2.5, part: PART.flame },
        ...[0.36, 0.56].map((z): Part => ({ geo: cyl(0.09, 0.09, 0.4, 6).rotateZ(Math.PI / 2).translate(-0.44, 0.16, z), paint: UNIT_PAINT.fuse })),
        { geo: block(0.22, 0.18, 0.22, 0.48, 0.08, 0.42), paint: CRATE },
        { geo: block(0.2, 0.17, 0.2).rotateY(0.4).translate(0.44, 0.08, 0.17), paint: CRATE },
        { geo: block(0.2, 0.16, 0.2).rotateY(-0.3).translate(0.47, 0.26, 0.3), paint: CRATE },
        { geo: cyl(0.065, 0.09, c.y - 0.08, 6).translate(c.x, (c.y + 0.08) / 2, c.z), paint: IRON },
        { geo: new IcosahedronGeometry(0.09, 0).translate(c.x, c.y + 0.1, c.z), paint: SMOKE, part: PART.cargo },
        { geo: new IcosahedronGeometry(0.12, 0).translate(c.x + 0.03, c.y + 0.32, c.z + 0.02), paint: SMOKE, part: PART.cargo },
      ];
    }
    case 'shaft':
      // pit ring under an A-frame headframe with a sheave wheel
      return [
        { geo: cyl(0.66, 0.74, 0.16, 10).translate(0, 0.08, 0), paint: BODY.surface },
        { geo: cyl(0.76, 0.76, 0.06, 10).translate(0, 0.06, 0), paint: BODY.surface, ...ACCENT },
        { geo: new CylinderGeometry(0.5, 0.5, 0.01, 10, 1).translate(0, 0.165, 0), paint: IRON },
        { geo: block(0.09, 0.98, 0.09, 0, 0.1, 0.56, 1, 1), paint: IRON },
        { geo: block(0.09, 0.98, 0.09, 0, 0.1, -0.56, 1, 1), paint: IRON },
        { geo: block(0.14, 0.1, 1.3, 0, 1.06), paint: BODY.surface, ...ACCENT },
        ...sheave(SHEAVE.shaft, 0.84, STEEL),
        { geo: block(0.06, 0.67, 0.06, 0.2, 0.17), paint: IRON },
      ];
    case 'spire':
      // Monochrome sketch of the live spires.ts crystal; plane paint and glass sheen belong to its live material.
      return [
        { geo: cyl(1.08, 1.2, 0.22, 8).translate(0, 0.11, 0), paint: IRON, ...ACCENT },
        { geo: spireGem().translate(0, 2.5, 0), paint: STEEL },
      ];
    case 'interceptor':
      // dart on swept delta wings; missiles under the wings (WEAPON_VISUALS missile tip 0.137 / −0.05 × 1.8225)
      return [
        { geo: nose(0.1, 0.8, -0.37, 0, 0).scale(1, 0.8, 1), paint: BODY.sky },
        { geo: rod(0.085, 0.12, -0.49, 0, 0), paint: IRON },
        { geo: nose(0.06, 0.16, -0.49, 0, 0, -1), paint: UNIT_PAINT.engine, glow: 2.5, part: PART.flame },
        {
          geo: plate([[0.18, 0], [-0.22, 0.5], [-0.32, 0.5], [-0.3, 0], [-0.32, -0.5], [-0.22, -0.5]], 0.05, -0.02),
          paint: BODY.sky,
          ...ACCENT,
        },
        { geo: fin([[-0.24, 0.04], [-0.4, 0.22], [-0.47, 0.22], [-0.44, 0.04]], 0.05), paint: BODY.sky, ...ACCENT },
        { geo: block(0.16, 0.05, 0.08, 0.1, 0.02, 0, 0.5, 0.6), paint: UNIT_PAINT.sensor, glow: 0.6 },
        ...[-1, 1].map((s): Part => ({ geo: rod(0.03, 0.26, -0.12, -0.05, s * 0.2), paint: IRON, part: PART.barrel })),
      ];
    case 'bomber':
      // chevron flying wing with a dorsal hump, twin jets and a bomb bay (WEAPON_VISUALS bomb 0 / −0.154 × 1.8225)
      return [
        {
          geo: plate([[0.42, 0], [-0.16, 0.9], [-0.32, 0.9], [-0.22, 0.32], [-0.4, 0], [-0.22, -0.32], [-0.32, -0.9], [-0.16, -0.9]], 0.08, -0.04),
          paint: BODY.sky,
        },
        ...[-1, 1].map((s): Part => ({ geo: plate([[-0.02, s * 0.6], [-0.16, s * 0.9], [-0.32, s * 0.9], [-0.25, s * 0.6]], 0.03, 0.035), paint: BODY.sky, ...ACCENT })),
        // a team band along each trailing edge, so the chevron reads as the owner's from the RTS camera
        ...[-1, 1].map((s): Part => ({ geo: plate([[-0.19, s * 0.3], [-0.27, s * 0.6], [-0.33, s * 0.6], [-0.25, s * 0.3]], 0.03, 0.035), paint: BODY.sky, ...ACCENT })),
        { geo: block(0.72, 0.16, 0.34, 0, -0.08, 0, 0.7, 0.75, -0.04), paint: BODY.sky },
        // the dorsal accent is a cap over the hump
        { geo: block(0.3, 0.03, 0.24, -0.05, 0.07, 0, 0.8, 0.8), paint: BODY.sky, ...ACCENT },
        ...[-1, 1].map((s): Part => ({ geo: rod(0.08, 0.36, -0.3, 0.06, s * 0.3), paint: IRON })),
        ...[-1, 1].map((s): Part => ({ geo: nose(0.06, 0.2, -0.3, 0.06, s * 0.3, -1), paint: UNIT_PAINT.engine, glow: 2.5, part: PART.flame })),
        { geo: block(0.22, 0.105, 0.16, 0, -0.18), paint: IRON, part: PART.barrel },
        { geo: block(0.12, 0.05, 0.12, 0.2, 0.06, 0, 0.5, 0.6), paint: UNIT_PAINT.sensor, glow: 0.5 },
      ];
    case 'gunship':
      return gunship(false);
    case 'gun_platform':
      return gunship(true);
    case 'relay':
      // mast on a plinth with a sweeping dish and a sensor beacon (stands on the island pad)
      return [
        { geo: cyl(0.3, 0.38, 0.14, 8).translate(0, 0.07, 0), paint: BODY.sky },
        { geo: cyl(0.06, 0.1, 1.5, 6).translate(0, 0.89, 0), paint: STEEL },
        { geo: cyl(0.12, 0.12, 0.1, 6).translate(0, 0.75, 0), paint: BODY.sky, ...ACCENT },
        { geo: new ConeGeometry(0.46, 0.18, 8).rotateZ(Math.PI / 2).translate(0.16, 1.2, 0), paint: STEEL, part: PART.rotor },
        { geo: block(0.28, 0.08, 0.08, 0.3, 1.16), paint: IRON, part: PART.rotor },
        { geo: cyl(0.16, 0.12, 0.05, 6).translate(0, 1.665, 0), paint: BODY.sky, ...ACCENT },
        { geo: new OctahedronGeometry(0.13, 0).translate(0, 1.81, 0), paint: UNIT_PAINT.sensor, glow: 3 },
      ];
    case 'island_mortar':
      // A high-angle gun in a rotating cradle on the island's secondary pad, not an aircraft.
      return [
        { geo: cyl(0.6, 0.65, 0.18, 10).translate(0, 0.09, 0), paint: BODY.sky, ...ACCENT },
        { geo: cyl(0.36, 0.48, 0.24, 10).translate(0, 0.3, 0), paint: STEEL, part: PART.top },
        ...[-1, 1].map((s): Part => ({ geo: box(0.5, 0.4, 0.12, 0, 0.35, s * 0.24), paint: BODY.sky, ...ACCENT, part: PART.top })),
        { geo: new CylinderGeometry(0.17, 0.20, 1, 12, 1, true).rotateZ(-0.5).translate(0.24, 0.89, 0), paint: STEEL, part: PART.barrel },
        { geo: cyl(0.125, 0.125, 0.015, 12).rotateZ(-0.5).translate(MORTAR_MUZZLE.x, MORTAR_MUZZLE.y - 0.02, 0), paint: IRON, part: PART.barrel },
        { geo: box(0.35, 0.2, 0.4, -0.36, 0.16, 0), paint: '#b98a61' },
      ];
    case 'ore_extractor':
      // A compact auger gantry and discharge chute, fitted to the same secondary pad as the guns.
      return [
        { geo: cyl(0.56, 0.64, 0.14, 8).translate(0, 0.07, 0), paint: STEEL },
        { geo: cyl(0.24, 0.30, 0.035, 8).translate(0, 0.16, 0), paint: IRON },
        ...[-1, 1].map((s): Part => ({ geo: block(0.14, 1.08, 0.15, -0.1, 0.14, s * 0.38, 1, 1, 0.1), paint: STEEL })),
        { geo: block(0.58, 0.22, 0.94, -0.02, 1.12, 0), paint: BODY.sky, ...ACCENT },
        { geo: cyl(0.08, 0.08, 0.92, 8).translate(0, 0.61, 0), paint: STEEL, part: PART.rotor },
        ...[0.28, 0.48, 0.68].map((y, i): Part => ({ geo: box(0.44, 0.055, 0.13, 0, y, 0).rotateY(i * 0.7), paint: '#b99c6b', part: PART.rotor })),
        { geo: new ConeGeometry(0.2, 0.22, 8).rotateX(Math.PI).translate(0, 0.20, 0), paint: STEEL, part: PART.rotor },
        { geo: block(0.42, 0.30, 0.65, 0.37, 0.13, 0, 1.25, 1.1), paint: IRON },
        { geo: block(0.42, 0.045, 0.58, 0.37, 0.43, 0), paint: BODY.sky, ...ACCENT },
        { geo: box(0.10, 0.12, 0.12, -0.03, 1.37, 0), paint: UNIT_PAINT.sensor, glow: 2, part: PART.flame },
        ...[-1, 0, 1].map((s): Part => ({ geo: new OctahedronGeometry(0.10 + Math.abs(s) * 0.025).translate(s * 0.22, 0.17, s * 0.1), paint: '#c8b69a', part: PART.dust })),
      ];
    case 'mooring_tower':
      // Grounded Tesla coil: a plinth, copper windings and a discharge crown whose pronged top ring turns (rotor);
      // the crown sensor crackles while a tether holds an island (fill = linked). Ring prisms, not tori, on budget.
      return [
        { geo: box(1.3, 0.2, 1.3), paint: STEEL },
        { geo: cyl(0.24, 0.4, 1.65, 8).translate(0, 1, 0), paint: STEEL },
        ...[0.55, 0.85, 1.15, 1.45].map((y): Part => ({ geo: cyl(0.42, 0.42, 0.13, COIL_SIDES).translate(0, y, 0), paint: '#b98a61' })),
        { geo: ring(0.7, 0.18, 0.2, COIL_SIDES).translate(0, 1.9, 0), paint: STEEL },
        { geo: ring(0.44, 0.12, 0.12, COIL_SIDES).translate(0, 2.14, 0), paint: BODY.surface, ...ACCENT, part: PART.rotor },
        ...[0, 1, 2].map((k): Part => ({ geo: box(0.06, 0.24, 0.06, 0.38, 2.14).rotateY((k * Math.PI * 2) / 3), paint: IRON, part: PART.rotor })),
        { geo: new OctahedronGeometry(0.19).translate(0, 2.25, 0), paint: UNIT_PAINT.sensor, glow: 1.3 },
      ];
    case 'aerie':
      // Open-front canvas hangar, landing apron and team-painted roof ridge.
      return [
        { geo: box(1.3, 0.1, 1.1), paint: STEEL },
        { geo: box(0.12, 0.65, 1, -0.5, 0.1), paint: BODY.sky },
        { geo: box(0.12, 0.65, 1, 0.5, 0.1), paint: BODY.sky },
        { geo: box(1, 0.65, 0.1, 0, 0.1, -0.45), paint: BODY.sky },
        { geo: block(1.3, 0.3, 1.15, 0, 0.75, 0, 0.2, 1), paint: BODY.sky, ...ACCENT },
        { geo: box(0.12, 0.02, 0.75, 0, 0.11, 0.3), paint: UNIT_PAINT.sensor },
        // A winged windsock above the ridge identifies the hangar even from the closed side.
        { geo: box(0.07, 0.48, 0.07, 0, 0.95), paint: IRON },
        { geo: plate([[-0.48, 0], [0, 0.23], [0.48, 0], [0, -0.12]], 0.06, 1.42), paint: BODY.sky, ...ACCENT, part: PART.cloth },
      ];
    case 'storm_seeder':
      // A copper weather coil with a rotating split crown.
      return [
        { geo: cyl(0.45, 0.55, 0.2).translate(0, 0.1, 0), paint: BODY.sky, ...ACCENT },
        { geo: cyl(0.16, 0.25, 1.2).translate(0, 0.8, 0), paint: STEEL },
        ...[0.5, 0.8, 1.1].map((y): Part => ({ geo: cyl(0.38, 0.38, 0.14, COIL_SIDES).translate(0, y, 0), paint: '#b98a61' })),
        { geo: box(1.05, 0.12, 0.16, 0, 1.45), paint: BODY.sky, ...ACCENT, part: PART.rotor },
        ...[-1, 1].map((s): Part => ({ geo: box(0.16, 0.42, 0.16, s * 0.45, 1.48), paint: '#b98a61', part: PART.rotor })),
        { geo: new OctahedronGeometry(0.20).translate(0, 1.7, 0), paint: UNIT_PAINT.sensor, glow: 1 },
      ];
    case 'stormcatcher':
      // Wide upward-facing collector bowl: distinct from the relay's narrow dish. The bowl, its rim and three
      // collector vanes turn slowly (rotor) under the glowing mast tip.
      return [
        { geo: cyl(0.38, 0.48, 0.16).translate(0, 0.08, 0), paint: BODY.sky, ...ACCENT },
        { geo: cyl(0.1, 0.16, 0.8).translate(0, 0.55, 0), paint: STEEL },
        { geo: cyl(0.80, 0.18, 0.45, 8).translate(0, 1, 0), paint: '#b98a61', part: PART.rotor },
        { geo: cyl(0.69, 0.69, 0.025, 8).translate(0, 1.235, 0), paint: IRON, part: PART.rotor },
        ...[0, 1, 2].map((k): Part => ({ geo: box(0.16, 0.14, 0.05, 0.74, 1.16).rotateY((k * Math.PI * 2) / 3), paint: IRON, part: PART.rotor })),
        { geo: cyl(0.04, 0.08, 0.55).translate(0, 1.45, 0), paint: UNIT_PAINT.sensor, glow: 0.6 },
      ];
    case 'solar':
      // Hexagonal bus with a team lid and band, dish forward, and two wings: one sheet of photovoltaic glass each (its
      // cell grid and sheen are shaded, not modelled) seated in a slightly larger iron frame whose rim is the ramp
      // gauge, and the collector light on the lid. Glass and frame roll and fold together (`RIG.solar.panel`).
      return [
        { geo: cyl(0.16, 0.16, 0.26, 6), paint: BODY.orbit },
        { geo: block(0.26, 0.04, 0.26, 0, 0.125, 0, 0.8, 0.8), paint: BODY.orbit, ...ACCENT },
        { geo: cyl(0.17, 0.17, 0.06, 6).translate(0, -0.04, 0), paint: BODY.orbit, ...ACCENT },
        { geo: nose(0.08, 0.24, 0.16, 0, 0), paint: STEEL },
        { geo: new OctahedronGeometry(0.06).translate(0, 0.2, 0), paint: IRON, part: SOLAR_PART.node },
        ...[-1, 1].flatMap((s): Part[] => [
          { geo: box(0.5, 0.04, SOLAR.tip - SOLAR.root, 0, -0.01, (s * (SOLAR.tip + SOLAR.root)) / 2), paint: UNIT_PAINT.cell, part: PART.panel },
          { geo: box(0.6, 0.035, SOLAR.tip - SOLAR.root + 0.1, 0, -0.035, (s * (SOLAR.tip + SOLAR.root)) / 2), paint: IRON, part: SOLAR_PART.trim },
        ]),
      ];
    case 'skiff':
      // Star-atlas dart: a cropped wedge wing, cockpit cap and rear band; narrower than a Sky delta.
      return [
        { geo: plate([[-0.36, -0.14], [0.36, -0.015], [0.36, 0.015], [-0.36, 0.14]], 0.15, -0.075), paint: BODY.orbit },
        { geo: plate([[-0.29, -0.32], [0.05, -0.04], [0.05, 0.04], [-0.29, 0.32]], 0.07, -0.055), paint: STEEL },
        { geo: block(0.29, 0.07, 0.18, -0.02, 0.075, 0, 0.7, 0.4), paint: BODY.orbit, ...ACCENT },
        { geo: box(0.08, 0.21, 0.28, -0.28, -0.065), paint: BODY.orbit, ...ACCENT },
        { geo: box(0.12, 0.12, 0.18, -0.4, -0.06), paint: IRON },
        { geo: nose(0.055, 0.16, -0.46, 0, 0, -1), paint: UNIT_PAINT.engine, glow: 2.5, part: PART.flame },
        ...[-1, 1].map((s): Part => ({ geo: box(0.1, 0.035, 0.045, 0.3, -0.0175, s * 0.10), paint: IRON, part: PART.barrel })),
      ];
    case 'bastion': {
      // Hammerhead capital escort: separate PD blisters, recessed emitter and a four-nozzle engine bank. Within the
      // armored budget (≤ 260): undersides the camera never sees are dropped, as are the barrels' breech caps.
      return [
        { geo: plate([[-0.65, -0.34], [0.12, -0.39], [0.22, -0.69], [0.65, -0.69], [0.77, -0.48], [0.77, 0.48], [0.65, 0.69], [0.22, 0.69], [0.12, 0.39], [-0.65, 0.34]], 0.32, -0.18), paint: BODY.orbit },
        { geo: plate([[0.26, -0.63], [0.61, -0.63], [0.7, -0.44], [0.7, 0.44], [0.61, 0.63], [0.26, 0.63]], 0.10, 0.14), paint: STEEL },
        { geo: under(block(0.62, 0.16, 0.55, -0.20, 0.14, 0, 0.78, 0.8)), paint: BODY.orbit },
        { geo: under(block(0.38, 0.055, 0.27, -0.28, 0.30, 0, 0.8, 0.8)), paint: BODY.orbit, ...ACCENT },
        ...[-1, 1].flatMap((s): Part[] => [
          { geo: under(block(0.34, 0.07, 0.13, 0.43, 0.24, s * 0.39, 0.8, 0.75)), paint: BODY.orbit, ...ACCENT },
          // the blister: one tapered drum seated on the deck
          { geo: withoutFaces(cyl(0.135, 0.17, 0.19, 6), CAP.bottom).translate(BASTION_PD.x, 0.315, s * BASTION_PD.z), paint: STEEL, part: s < 0 ? PART.top : PD_TOP },
          { geo: under(box(0.13, 0.045, 0.12, BASTION_PD.x, 0.41, s * BASTION_PD.z)), paint: BODY.orbit, ...ACCENT, part: s < 0 ? PART.top : PD_TOP },
          { geo: withoutFaces(rod(0.042, BASTION_PD.tip - BASTION_PD.x, BASTION_PD.x, BASTION_PD.height, s * BASTION_PD.z, 4), CAP.bottom), paint: IRON, part: s < 0 ? PART.barrel : PD_BARREL },
          // the shield emitter vanes stand on the aft deck
          { geo: under(box(0.035, 0.28, 0.065, -0.46, 0.14, s * 0.32)), paint: UNIT_PAINT.sensor, glow: 1.3, part: BASTION_PART.emitter },
        ]),
        { geo: under(box(0.13, 0.20, 0.70, -0.57, -0.10)), paint: BODY.orbit, ...ACCENT },
        { geo: ring(BASTION_EMITTER.r, BASTION_EMITTER.w, BASTION_EMITTER.h, BASTION_EMITTER.sides, false).translate(-0.18, 0.37, 0), paint: UNIT_PAINT.sensor, glow: 1.5, part: BASTION_PART.emitter },
        // the engine bank: four nozzles out of the stern block
        ...[-0.24, -0.08, 0.08, 0.24].map((z): Part => ({ geo: withoutFaces(nose(0.055, 0.20, -0.635, -0.025, z, -1, 4), CONE_BASE), paint: UNIT_PAINT.engine, glow: 2.5, part: PART.flame })),
      ];
    }
    case 'lancer':
      // orbital gunship: cream armoured bus, long axial lance and paired radiator fins from the shared kit
      return [
        { geo: rod(0.19, 0.68, -0.4, 0, 0, 8), paint: BODY.orbit },
        { geo: rod(0.205, 0.09, -0.12, 0, 0, 8), paint: BODY.orbit, ...ACCENT },
        { geo: block(0.38, 0.06, 0.25, -0.12, 0.16, 0, 0.8, 0.8), paint: BODY.orbit, ...ACCENT },
        { geo: rod(0.075, 0.62, 0.2, 0, 0), paint: IRON, part: PART.barrel },
        { geo: rod(0.1, 0.1, 0.72, 0, 0), paint: STEEL, part: PART.barrel },
        { geo: rod(0.045, 0.025, 0.82, 0, 0), paint: UNIT_PAINT.sensor, glow: 2.5, part: PART.barrel },
        ...[-1, 1].map((s): Part => ({ geo: plate([[0.1, s * 0.13], [-0.12, s * 0.52], [-0.4, s * 0.52], [-0.3, s * 0.13]], 0.045, -0.02), paint: BODY.orbit, ...ACCENT })),
        { geo: rod(0.13, 0.12, -0.52, 0, 0), paint: IRON },
        { geo: nose(0.095, 0.24, -0.52, 0, 0, -1), paint: UNIT_PAINT.engine, glow: 2.5, part: PART.flame },
      ];
    case 'tug':
      // stubby octagonal hauler: cab ahead, two side engines, a stern grapple (the rope and the towed asteroid trail
      // behind, `orbit.ts` / `entities.ts` TOW_LEN)
      return [
        { geo: rod(0.22, 0.62, -0.3, 0, 0, 8), paint: BODY.orbit },
        // the band's end discs lie inside the hull (armored budget ≤ 260)
        { geo: withoutFaces(rod(0.235, 0.08, -0.02, 0, 0, 8), CAP.top, CAP.bottom), paint: BODY.orbit, ...ACCENT },
        { geo: block(0.3, 0.05, 0.22, -0.08, 0.19, 0, 0.85, 0.85), paint: BODY.orbit, ...ACCENT },
        { geo: block(0.2, 0.22, 0.3, 0.38, -0.11, 0, 0.6, 0.8, -0.03), paint: STEEL },
        { geo: block(0.05, 0.08, 0.2, 0.47, -0.02), paint: UNIT_PAINT.sensor, glow: 0.8 },
        { geo: rod(0.045, 0.08, TUG_MINER.x - 0.08, TUG_MINER.y, TUG_MINER.z), paint: IRON },
        { geo: rod(0.034, 0.007, TUG_MINER.x - 0.007, TUG_MINER.y, TUG_MINER.z), paint: UNIT_PAINT.sensor, glow: 1.4 },
        ...[-1, 1].map((s): Part => ({ geo: rod(0.09, 0.4, -0.28, -0.04, s * 0.32), paint: IRON })),
        ...[-1, 1].map((s): Part => ({ geo: block(0.14, 0.06, 0.16, -0.08, -0.07, s * 0.2), paint: IRON })),
        ...[-1, 1].map((s): Part => ({ geo: nose(0.07, 0.22, -0.28, -0.04, s * 0.32, -1), paint: UNIT_PAINT.engine, glow: 2.5, part: PART.flame })),
        { geo: block(0.18, 0.07, 0.07, -0.38, -0.07), paint: IRON },
        { geo: block(0.08, 0.06, 0.2, -0.5, -0.065, 0, 1, 1.3), paint: IRON, part: PART.tool },
      ];
  }
}

/**
 * The Gunship airframe, flying or emplaced (the Gun Platform): an armoured box hull on stub wings between two ducted
 * three-blade fans, a tail boom, and a dorsal twin-barrel turret on its own ring (seen from above, unlike a chin gun).
 * Emplaced, the same parts stand on landing skids: the outboard wings and fans fold up and stop (no rotor part), the
 * engines go dark and the turret rides a mast above the hull, the focus of the silhouette.
 */
function gunship(emplaced: boolean): Part[] {
  const { fan, turret } = GUNSHIP;
  /** wing-fold hinge (|z|) and fold angle (rad): the outboard wings and fans stand near upright */
  const { hinge, folded } = GUN_PLATFORM;
  const fold = (g: BufferGeometry, s: number): BufferGeometry => emplaced ? g.translate(0, 0, -s * hinge).rotateX(-s * folded).translate(0, 0, s * hinge) : g;
  /** Emplaced, each outboard wing and fan is its own part (left −z, right +z), so the landing unfolds… then folds it. */
  const wing = (s: number): number => emplaced ? (s < 0 ? L : R) : PART.body;
  // Within the armored budget (≤ 260; the platform ≤ 320 as a structure): faces the RTS camera never sees are dropped
  // (undersides, ends buried in the hull), the fan ducts are open-bottomed octagons and the blades flat slats.
  const parts: Part[] = [
    { geo: block(0.78, 0.26, 0.38, -0.02, -0.14, 0, 0.82, 0.8), paint: BODY.sky },
    { geo: withoutFaces(nose(0.13, 0.18, 0.37, -0.03, 0), CONE_BASE), paint: BODY.sky },
    { geo: under(block(0.14, 0.06, 0.24, 0.3, 0.06, 0, 0.5, 0.75)), paint: UNIT_PAINT.sensor, glow: 0.6 },
    { geo: under(block(0.36, 0.05, 0.26, -0.16, 0.12, 0, 0.85, 0.85)), paint: BODY.sky, ...ACCENT },
    { geo: withoutFaces(rod(0.045, 0.36, -0.68, 0.02, 0, 4), CAP.top, CAP.bottom), paint: BODY.sky },
    { geo: fin([[-0.52, 0.04], [-0.64, 0.28], [-0.7, 0.28], [-0.68, 0.04]], 0.04), paint: BODY.sky, ...ACCENT },
    { geo: under(box(0.1, 0.03, 0.34, -0.63, 0.01)), paint: BODY.sky },
    // the wing root between the hull sides and the fold hinges (its ends meet the outboard wings)
    { geo: withoutFaces(box(0.2, 0.05, hinge * 2, fan.x, -0.03), FACE.ny, FACE.pz, FACE.nz), paint: BODY.sky, ...ACCENT },
  ];
  const outboard = fan.z - fan.r + 0.06 - hinge;
  for (const s of [-1, 1]) {
    const z = s * fan.z;
    // the exhaust cone's base is inside the hull
    const exhaust = withoutFaces(nose(0.045, 0.12, -0.4, -0.04, s * 0.11, -1, 4), CONE_BASE);
    parts.push(
      emplaced ? { geo: exhaust, paint: IRON } : { geo: exhaust, paint: UNIT_PAINT.engine, glow: 2.5, part: PART.flame },
      { geo: fold(under(box(0.2, 0.05, outboard, fan.x, -0.03, s * (hinge + outboard / 2))), s), paint: BODY.sky, ...ACCENT, part: wing(s) },
      { geo: fold(ring(fan.r + FAN_DUCT.tube, FAN_DUCT.tube * 2, FAN_DUCT.tube * 2, FAN_DUCT.sides, false).translate(fan.x, 0.02, z), s), paint: BODY.sky, ...ACCENT, part: wing(s) },
      // three blades (top faces only: the camera looks down on them): unlike a cross, a three-blade rotor never looks
      // the same after a quarter turn, so it reads as spinning
      ...[0, 1, 2].map((k): Part => ({
        geo: fold(withoutFaces(box(fan.r - 0.02, 0.014, 0.07, (fan.r - 0.02) / 2, 0.01), FACE.px, FACE.nx, FACE.ny, FACE.pz, FACE.nz).rotateY((k * Math.PI * 2) / 3).translate(fan.x, 0, z), s),
        paint: IRON, part: emplaced ? wing(s) : PART.rotor,
      })),
    );
  }
  const ty = emplaced ? GUN_PLATFORM.mast : 0;
  const barrel = turret.tip - (turret.x + 0.08);
  parts.push(
    // the turret ring: a flat iron disc on the hull roof
    { geo: withoutFaces(cyl(0.15, 0.16, 0.05, 6), 0, CAP.bottom).translate(turret.x, 0.145 + ty, 0), paint: IRON },
    { geo: under(block(0.26, 0.11, 0.24, turret.x - 0.02, 0.165 + ty, 0, 0.8, 0.85)), paint: STEEL, part: PART.top },
    { geo: under(block(0.15, 0.03, 0.15, turret.x - 0.04, 0.275 + ty, 0)), paint: BODY.sky, ...ACCENT, part: PART.top },
    // the breech end of each barrel is inside the turret
    ...[-1, 1].map((s): Part => ({ geo: withoutFaces(rod(0.026, barrel, turret.x + 0.08, turret.y + ty, s * turret.twin, 4), CAP.bottom), paint: IRON, part: PART.barrel })),
  );
  if (!emplaced) return parts;
  const { lift, mast } = GUN_PLATFORM;
  parts.push({ geo: withoutFaces(cyl(0.07, 0.1, mast, 6), CAP.top, CAP.bottom).translate(turret.x, 0.12 + mast / 2, 0), paint: STEEL });
  // landing skids on struts down to the pad (y = −lift before the whole airframe is raised onto them)
  for (const s of [-1, 1]) {
    parts.push({ geo: under(box(0.62, 0.035, 0.05, -0.02, -lift, s * 0.22)), paint: IRON });
    for (const x of [-0.18, 0.16]) parts.push({ geo: withoutFaces(cyl(0.02, 0.02, lift - 0.175, 3), CAP.top, CAP.bottom).translate(x, -lift + 0.035 + (lift - 0.175) / 2, s * 0.2), paint: IRON });
  }
  for (const part of parts) part.geo.translate(0, lift, 0);
  return parts;
}

const MOUND = '#8a7458';
const SCORCH = '#5d5046';
const STAFF = '#5b4a3a';
const CRATE = '#8b6a43';
const SCRAP = '#7d8086';
const BRASS = '#c9a35a';
/** Exhaust smoke (the Drill Yard's chimney puffs): pale paper grey. */
const SMOKE = '#e2dccf';
/** Deploy-stance earth: the foxhole's dark scrape, a kicked-up dirt clod, the siege lock-down's pale dust. */
const SCRAPE = '#4b3a28';
const DIRT = '#7a5f3e';
const PLANT_DUST = '#b8996e';
/** Neutral, sun-faded cloth; the team tint replaces it once a post is held (accent 1). */
const CLOTH = '#d8cfb8';

/**
 * Forward post (war-torn): a torn flag on a staff planted in a small earth mound with battlefield litter (a split crate,
 * bent plates, spent shells, clods). Reads as a flag, not a unit or a building. The origin is the ground itself
 * (entities `hover`): the mound's base and the litter sit sunk below it, and the ground bed under the post
 * (`post-beds.ts`: dirt, soot, the shell-crater ring) feathers the mound into the surrounding terrain.
 */
function post(): Part[] {
  const mound = new DodecahedronGeometry(0.46, 0).rotateY(0.4).scale(1, 0.46, 1).translate(0, -0.04, 0);
  const staff = new CylinderGeometry(0.022, 0.03, 1.15, 5).translate(0, 0.62, 0);
  // The frayed fly end: a ragged outline with two torn notches.
  const flag = fin([[0.02, 0.8], [0.5, 0.82], [0.42, 0.9], [0.52, 0.97], [0.36, 1.03], [0.47, 1.12], [0.02, 1.15]], 0.02);
  // Litter settled into the dirt: tilted, each partly below the ground.
  const crate = block(0.18, 0.12, 0.16, 0, -0.06, 0, 0.85, 0.7, 0.03).rotateZ(0.22).rotateX(-0.12).translate(0.42, 0, 0.26).rotateY(0.5);
  const plate1 = block(0.22, 0.03, 0.1, 0, -0.02, 0, 1, 1, 0.06).rotateZ(0.2).translate(-0.4, 0, 0.3);
  const plate2 = block(0.14, 0.025, 0.08, 0, -0.015, 0, 1, 1, 0.04).rotateX(0.25).rotateY(1.2).translate(0.12, 0, -0.52);
  const shell = (x: number, z: number, a: number) => new CylinderGeometry(0.03, 0.03, 0.14, 5).rotateZ(Math.PI / 2).rotateY(a).translate(x, 0.012, z);
  const clod = (x: number, z: number, r: number) => new IcosahedronGeometry(r, 0).scale(1, 0.55, 1).translate(x, 0, z);
  return [
    { geo: mound, paint: MOUND },
    { geo: staff, paint: STAFF },
    { geo: flag, paint: CLOTH, accent: 1, part: PART.cloth },
    { geo: crate, paint: CRATE },
    { geo: plate1, paint: SCRAP },
    { geo: plate2, paint: SCRAP },
    { geo: shell(-0.28, -0.4, 0.4), paint: BRASS },
    { geo: shell(0.34, -0.36, -0.9), paint: BRASS },
    { geo: shell(-0.52, -0.06, 1.7), paint: BRASS },
    { geo: clod(0.5, -0.12, 0.07), paint: MOUND },
    { geo: clod(-0.2, 0.5, 0.06), paint: MOUND },
    { geo: clod(-0.5, 0.18, 0.05), paint: SCORCH },
  ];
}

// ---------------------------------------------------------------- sky island (lookdev `islandGeometry`)
const ISLE_R = 2.4;
/** Pebble satellites under an island: how many, their orbit radius and height ranges, and their size range. */
const ISLAND_PEBBLES = { count: 3, radius: [1.8, 2.3], y: [-2.2, -1.3], size: [0.14, 0.24], paint: ['#94857a', '#7d6e62'] } as const;
/** The relay pad at the island's centre (the relay stands on it, `entities.ts` hover 0.05). */
const PAD_R = 0.78;
/**
 * Structure foundations (`foundation`), in world units: the team trim's width round the concrete slab, the slab and
 * trim heights (the trim sits lower so only its edge shows), the round slab's sides and its share of the centre pad.
 */
const FOUNDATION = { trim: 0.08, height: 0.06, trimHeight: 0.045, sides: 12, padFill: 0.9 } as const;
/** Sky builds that hold an island's main slot and stand on its round centre pad. */
const SKY_PAD_KINDS: Partial<Record<Kind, true>> = { relay: true, aerie: true, storm_seeder: true, stormcatcher: true };
/**
 * The Spire's cut gem: a lathe profile (radius, height) from the pavilion point up through the girdle band and the
 * crown to the table, `sides` facets round, and `shards` small octahedra riding round the girdle with the crystal.
 */
export const SPIRE_GEM = {
  profile: [[0, -2.2], [0.6, -0.95], [1.05, 0.25], [1.05, 0.5], [0.82, 1.25], [0.38, 1.85], [0, 1.85]] as readonly (readonly [number, number])[],
  sides: 8,
  shards: { count: 3, radius: 1.5, y: 0.38, size: 0.17, stretch: 1.8 },
  /** Golden-ratio stride that spreads consecutive facet ids over 0…1. */
  facetStride: 0.618034,
} as const;

/** The Spire's cut-gem geometry, flat-faceted, with a per-facet `facet` id (0…1) for the crystal shader. */
export function spireGem(): BufferGeometry {
  const { profile, sides, shards, facetStride } = SPIRE_GEM;
  const pieces: BufferGeometry[] = [new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), sides).toNonIndexed()];
  for (let k = 0; k < shards.count; k++) {
    const a = (k * Math.PI * 2) / shards.count;
    // polyhedra are already non-indexed
    pieces.push(new OctahedronGeometry(shards.size).scale(1, shards.stretch, 1).translate(Math.cos(a) * shards.radius, shards.y, Math.sin(a) * shards.radius));
  }
  let total = 0;
  for (const g of pieces) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3), facet = new Float32Array(total);
  let v = 0, face = 0;
  pieces.forEach((g, i) => {
    const p = g.getAttribute('position');
    for (let j = 0; j < p.count; j++, v++) {
      pos[v * 3] = p.getX(j); pos[v * 3 + 1] = p.getY(j); pos[v * 3 + 2] = p.getZ(j);
      // the lathe's quads are two triangles of one facet; every shard triangle is its own facet
      facet[v] = ((face + (i === 0 ? Math.floor(j / 6) : Math.floor(j / 3))) * facetStride + 0.13) % 1;
    }
    face += i === 0 ? p.count / 6 : p.count / 3;
    g.dispose();
  });
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('facet', new BufferAttribute(facet, 1));
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}
/**
 * The island hardpoint pad (rules.sky.islandHardpoints): a round landing deck on the rim, `dist` tiles out at canonical
 * `bearing` (rad from +X toward +Z, turned with the island): the one arc every grove layout leaves clear (`islandPlants`
 * clusters span ≈ 0.15…5.1 rad), short of the pennant's corridor on +X. Radius `r`, its deck top at the relay pad's
 * height (0.05, `entities.ts` hover) so an attachment stands on it like a slot structure. Generic attachments fit a
 * circle of radius `fit`; an emplaced Gunship keeps its airframe scale and may overhang the deck.
 */
export const HARDPOINT_PAD = { bearing: 5.5, dist: 1.75, r: 0.8, fit: 0.78 } as const;
/** The pad centre on the canonical (unturned) island. */
export const HARDPOINT_AT = { x: Math.cos(HARDPOINT_PAD.bearing) * HARDPOINT_PAD.dist, z: Math.sin(HARDPOINT_PAD.bearing) * HARDPOINT_PAD.dist } as const;
/** The pad centre of an island turned `turns` quarter turns, as a tile offset (x, y) from the island centre. */
export function hardpointOffset(turns: number, out: { x: number; y: number }): { x: number; y: number } {
  out.x = rotVX(turns, HARDPOINT_AT.x, HARDPOINT_AT.z);
  out.y = rotVY(turns, HARDPOINT_AT.x, HARDPOINT_AT.z);
  return out;
}
const GRASS = new Color('#a6c477');
const GRASS_DRY = new Color('#bccb83');
const EARTH = new Color('#b9a27a');
const SOIL = new Color('#7a6150');
const ROCK = new Color('#b39c84');
const ROCK_BAND = new Color('#957f6c');
const ROCK_DEEP = new Color('#7d6f8a');
// Ore crag (public oreCapacity > 0): slate/ochre stone plates with dark cracks and mineral strata, no turf.
const SLATE = new Color('#8f949a');
const SLATE_DARK = new Color('#6c7079');
const OCHRE = new Color('#b8975f');
const CRACK = new Color('#4a4650');

const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/**
 * Stable IDs are assigned to permanent islands first, in consecutive sets of one per map slot (`sides`): the k-th
 * member of a set is the canonical island turned k · 4/sides quarter turns (C2: point-mirrored pairs).
 */
export function islandIdentity(id: string, sides: number): { seed: number; turns: number } {
  const serial = Number(id.slice(2)) - 1;
  return { seed: Math.floor(serial / sides), turns: (serial % sides) * (4 / sides) };
}

/** Seeded lobes change the outline, not the island's gameplay radius. */
const isleRim = (a: number, seed: number): number => 1
  + fbm(Math.cos(a) * 2 + seed * 3.7 + 3, Math.sin(a) * 2 + 3) * 0.3
  + Math.sin(a * (3 + seed % 3) + seed * 1.7) * 0.065;
/** The entire pad, its approach and the hardpoint deck stay flat; small rolling shoulders never reach air-unit height. */
const capY = (x: number, z: number, rr: number, seed: number): number =>
  smooth(1.1, 1.65, Math.hypot(x, z)) * smooth(HARDPOINT_PAD.r + 0.05, HARDPOINT_PAD.r + 0.45, Math.hypot(x - HARDPOINT_AT.x, z - HARDPOINT_AT.z))
    * (fbm(x * 1.3 + seed * 3.7 + 7, z * 1.3) * 0.48 + 0.06)
  - smooth(0.82, 1, rr) * 0.14;

/** A world quarter turn maps (x, z) → (−z, x): about +Y that is −π/2 per turn. */
export const turnAngle = (turns: number): number => -turns * Math.PI / 2;

/** The turf, pad, strata and hanging stone: built once, without changing the sim footprint. `hardpoint` adds the rim
 * deck (rules.sky.islandHardpoints > 0). */
function island(seed = 0, turns = 0, hardpoint = false, ore = false): Part[] {
  const g = new IcosahedronGeometry(1, 3);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const s = mergeVertices(g);
  const p = s.getAttribute('position');
  const paint = new Float32Array(p.count * 3);
  const c = new Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const rim = isleRim(Math.atan2(z, x), seed) * ISLE_R;
    if (y >= -0.08) {
      const rr = Math.min(1, Math.hypot(x, z));
      const X = x * rim;
      const Z = z * rim;
      p.setXYZ(i, X, capY(X, Z, rr, seed), Z);
      const patch = fbm(X * 0.9 + seed * 4.1 + 11, Z * 0.9);
      if (ore) {
        // broken stone plates: slate slabs, ochre weathering, dark crack seams where the plate noise changes sign
        const plate = fbm(X * 1.7 + seed * 2.9 + 5, Z * 1.7 - 3);
        c.copy(SLATE).lerp(OCHRE, clamp(patch * 2.2 + 0.35, 0, 1) * 0.6).lerp(SLATE_DARK, smooth(0.1, 0.3, plate) * 0.5);
        c.lerp(CRACK, smooth(0.07, 0.01, Math.abs(plate)) * 0.75);
        c.lerp(OCHRE, smooth(1.22, 0.85, Math.hypot(X, Z)) * 0.3);
      } else {
        c.copy(GRASS).lerp(GRASS_DRY, clamp(patch * 2 + 0.45 + hash2(seed, 8) * 0.2, 0, 1));
        c.lerp(patch > 0.12 ? ROCK : EARTH, smooth(0.05, 0.25, patch) * 0.65);
        c.lerp(EARTH, smooth(1.22, 0.85, Math.hypot(X, Z)) * 0.55);
      }
    } else {
      const d = -y;
      const taper = (1 - d) ** (0.6 + hash2(seed, 5) * 0.4) + 0.08;
      const jag = 1 + fbm(x * 4 + seed * 3.7 + 3, z * 4 + y * 3) * 0.55;
      const Y = -(d ** 0.9) * ISLE_R * (1.05 + hash2(seed, 6) * 0.5) + fbm(x * 5 + seed * 2.3, z * 5 + 3) * 0.3;
      p.setXYZ(i, x * rim * taper * jag, Y, z * rim * taper * jag);
      const band = (Y * 1.4 + fbm(x * 3, z * 3) * 1.6 + 10) % 1;
      if (ore) c.copy(band < 0.33 ? OCHRE : band < 0.66 ? SLATE : SLATE_DARK).lerp(ROCK_DEEP, smooth(-0.8, -3.2, Y));
      else {
        c.copy(band < 0.5 ? ROCK : ROCK_BAND).lerp(ROCK_DEEP, smooth(-0.5, -3.2, Y));
        if (Y > -0.42) c.copy(SOIL);
      }
    }
    paint[i * 3] = c.r;
    paint[i * 3 + 1] = c.g;
    paint[i * 3 + 2] = c.b;
  }
  s.setAttribute('paint', new BufferAttribute(paint, 3));
  s.computeVertexNormals();

  const parts: Part[] = [
    { geo: s, paint: '#ffffff', smooth: true },
    // the relay pad: an octagonal flagstone plinth with a team-painted rim
    { geo: cyl(PAD_R, PAD_R + 0.08, 0.1, 8), paint: '#ddd2ba' },
    { geo: ring(PAD_R + 0.07, 0.08, 0.08, PAD_RIM_SIDES).translate(0, 0.05, 0), paint: '#d8c89a', accent: 1, glow: 0.35 },
  ];
  // owner's pennant at the pad's edge
  const fx = PAD_R + 0.35;
  const fy = capY(fx, 0.1, fx / (isleRim(0, seed) * ISLE_R), seed);
  parts.push(
    { geo: cyl(0.025, 0.03, 1.1, 5).translate(fx, fy + 0.55, 0.1), paint: '#6b4a32' },
    { geo: box(0.42, 0.24, 0.03, fx + 0.23, fy + 0.8, 0.1), paint: '#d8c89a', accent: 1, glow: 0.2 },
  );
  if (hardpoint) {
    // the hardpoint deck: flagstones on a rock bracket that carries it past a low rim, a team-painted edge, a landing
    // ring and four iron tie-down clamps (the generic mount whatever attaches)
    const { x: hx, z: hz } = HARDPOINT_AT, r = HARDPOINT_PAD.r;
    parts.push(
      { geo: cyl(r, r + 0.05, 0.1, 12).translate(hx, 0, hz), paint: '#ddd2ba' },
      { geo: cyl(r - 0.04, 0.16, 0.6, 8).translate(hx, -0.345, hz), paint: '#957f6c' },
      { geo: ring(r + 0.045, 0.07, 0.07, PAD_RIM_SIDES).translate(hx, 0.05, hz), paint: '#d8c89a', accent: 1, glow: 0.35 },
      { geo: ring(r * 0.55 + 0.022, 0.044, 0.044, PAD_RIM_SIDES).translate(hx, 0.052, hz), paint: '#a08a6c' },
      ...[0, 1, 2, 3].map((k): Part => {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        return { geo: box(0.1, 0.07, 0.1, 0, 0.05).rotateY(-a).translate(hx + Math.cos(a) * r * 0.8, 0, hz + Math.sin(a) * r * 0.8), paint: '#5f5a66' };
      }),
    );
  }
  // Split taproots and little hanging shelves break the otherwise identical inverted-cone silhouette.
  for (let k = 0; k < 3 + Math.floor(hash2(seed, 31) * 3); k++) {
    const a = hash2(seed, k + 40) * Math.PI * 2;
    const r = 0.85 + hash2(seed, k + 50) * 0.65;
    const h = 0.7 + hash2(seed, k + 60) * 1.1;
    parts.push({ geo: new ConeGeometry(0.3 + hash2(seed, k + 70) * 0.25, h, 5).rotateZ(Math.PI).translate(Math.cos(a) * r, -0.65 - h * 0.5, Math.sin(a) * r), paint: k % 2 ? '#957f6c' : '#b39c84' });
  }
  for (let k = 0; k < 2 + seed % 3; k++) {
    const a = hash2(seed, k + 80) * Math.PI * 2;
    const r = isleRim(a, seed) * ISLE_R * 0.92;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const length = 0.55 + hash2(seed, k + 90) * 0.85;
    const root = new CylinderGeometry(0.045, 0.012, length, 4, 3);
    const rp = root.getAttribute('position');
    for (let v = 0; v < rp.count; v++) {
      const t = 0.5 - rp.getY(v) / length;
      rp.setX(v, rp.getX(v) + Math.sin(t * 3.5) * 0.12);
    }
    parts.push({ geo: root.translate(x, -length * 0.5 - 0.15, z), paint: '#7a6150' });
  }
  // Scree: a few broken slabs scattered on the crag's outer rim, clear of the slot pad, flag corridor and hardpoint deck.
  if (ore) for (let k = 0; k < 9; k++) {
    const a = hash2(seed, k + 320) * Math.PI * 2;
    const rr = 0.8 + hash2(seed, k + 330) * 0.12;
    const r = isleRim(a, seed) * ISLE_R * rr;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, size = 0.1 + hash2(seed, k + 340) * 0.12;
    if ((x > 0.7 && Math.abs(z) < 0.6) || Math.hypot(x - HARDPOINT_AT.x, z - HARDPOINT_AT.z) - size < HARDPOINT_PAD.r + 0.1) continue;
    parts.push({ geo: new DodecahedronGeometry(size, 0).rotateY(a * 3).scale(1, 0.55, 1).translate(x, capY(x, z, rr, seed) + size * 0.2, z),
      paint: k % 3 ? '#7f838b' : '#a88d5e' });
  }
  // Ore-bearing islands (public initial capacity) wear mineral ribs just under the turf lip, where the cap never hides
  // them from the play camera. Tagged PART.vein so the island draw paints their reserve state; no separate entity.
  if (ore) for (let k = 0; k < 5; k++) {
    const a = (k + hash2(seed, 260) * 0.7) * Math.PI * 2 / 5 + hash2(seed, k + 270) * 0.4;
    // Seat each rib on the outermost real rock vertex at that bearing, so the jagged strata never bury it.
    let best = -1, bx = 0, by = 0, bz = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = Math.hypot(x, z);
      if (y > -0.45 || y < -0.9 || r <= best) continue;
      const turn = Math.abs(((Math.atan2(z, x) - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      if (turn < 0.3) { best = r; bx = x; by = y; bz = z; }
    }
    if (best < 0) continue;
    const length = 0.75 + hash2(seed, k + 280) * 0.35;
    const rib = new ConeGeometry(0.15 + hash2(seed, k + 290) * 0.05, length, 4)
      .rotateZ(Math.PI + 0.7 + hash2(seed, k + 300) * 0.25).rotateY(-Math.atan2(bz, bx)).translate(bx, by, bz);
    parts.push({ geo: rib, paint: ORE_HEAP_PAINT.rubble, part: PART.vein });
  }
  // a few pebbles hang beside the rock and circle it slowly (rotor, RIG.island): the island is never a still prop
  for (let k = 0; k < ISLAND_PEBBLES.count; k++) {
    const a = (k / ISLAND_PEBBLES.count + hash2(seed, k + 340) * 0.2) * Math.PI * 2;
    const r = ISLAND_PEBBLES.radius[0] + hash2(seed, k + 350) * (ISLAND_PEBBLES.radius[1] - ISLAND_PEBBLES.radius[0]);
    const y = ISLAND_PEBBLES.y[0] + hash2(seed, k + 360) * (ISLAND_PEBBLES.y[1] - ISLAND_PEBBLES.y[0]);
    const size = ISLAND_PEBBLES.size[0] + hash2(seed, k + 370) * (ISLAND_PEBBLES.size[1] - ISLAND_PEBBLES.size[0]);
    parts.push({ geo: new DodecahedronGeometry(size, 0).rotateX(a).translate(Math.cos(a) * r, y, Math.sin(a) * r), paint: ISLAND_PEBBLES.paint[k % 2]!, part: PART.rotor });
  }
  if (turns === 2) for (const part of parts) part.geo.scale(-1, 1, -1);
  else if (turns) for (const part of parts) part.geo.rotateY(turnAngle(turns));
  return parts;
}

export interface IslandPlant {
  readonly species: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly tint: number;
}

/** Three tree silhouettes plus a low scrub/pebble mix; all share the journal's existing pigments. */
export function islandPlantModel(species: number): BufferGeometry {
  const trunk: Part = { geo: cyl(0.045, 0.07, 0.48, 5).translate(0, 0.24, 0), paint: '#6b4a32' };
  if (species === 0) return merge([
    trunk,
    { geo: new ConeGeometry(0.3, 0.62, 7).translate(0, 0.55, 0), paint: '#5c8a4a' },
    { geo: new ConeGeometry(0.22, 0.48, 7).translate(0, 0.86, 0), paint: '#6f9c52' },
  ]);
  if (species === 1) return merge([
    trunk,
    { geo: new IcosahedronGeometry(0.37, 1).scale(1.1, 0.85, 0.95).translate(-0.09, 0.65, 0), paint: '#6f9c52' },
    { geo: new IcosahedronGeometry(0.28, 1).scale(1, 0.9, 1.05).translate(0.19, 0.77, 0.04), paint: '#8baa60' },
  ]);
  if (species === 2) {
    // Fixed prevailing east wind in the primary recipe; its paired grove leans west.
    const stem = cyl(0.035, 0.065, 0.72, 5);
    const p = stem.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + (p.getY(i) + 0.36) * 0.48);
    return merge([
      { geo: stem.translate(0, 0.36, 0), paint: '#6b4a32' },
      { geo: new IcosahedronGeometry(0.32, 1).scale(1.65, 0.52, 0.83).translate(0.37, 0.77, 0), paint: '#5c8a4a' },
      { geo: new IcosahedronGeometry(0.22, 0).scale(1.5, 0.55, 0.9).translate(0.59, 0.81, 0.03), paint: '#8baa60' },
    ]);
  }
  return merge([
    { geo: new IcosahedronGeometry(0.22, 0).scale(1.1, 0.65, 0.9).translate(-0.08, 0.12, 0), paint: '#957f6c' },
    { geo: new IcosahedronGeometry(0.21, 1).scale(1.1, 0.65, 1).translate(0.14, 0.17, 0.05), paint: '#6f9c52' },
  ]);
}

/** Clustered perimeter groves, with a generous clear central pad, flag corridor and low canopy ceiling. A `barren`
 * (ore-bearing) crag keeps only its few dry scrub bushes, faded, and no trees. */
export function islandPlants(seed: number, turns: number, barren = false): IslandPlant[] {
  const plants: IslandPlant[] = [];
  const count = 4 + Math.floor(hash2(seed, 101) * 6);
  const clusters = 2 + seed % 2;
  for (let k = barren ? count : 0; k < count + 3; k++) {
    const cluster = k % clusters;
    const a = 0.65 + (cluster / clusters) * 5 + hash2(seed, 110) * 0.6 + (hash2(seed, 130 + k) - 0.5) * 1.0;
    const rr = 0.74 + hash2(seed, 150 + k) * 0.14;
    const r = isleRim(a, seed) * ISLE_R * rr;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const species = k >= count ? 3 : (seed + k + Math.floor(hash2(seed, 170 + k) * 3)) % 3;
    const scale = species === 3 ? 0.65 + hash2(seed, 190 + k) * 0.5 : 0.58 + hash2(seed, 190 + k) * 0.28;
    // Bound the windswept overhang as well as the stem, keeping the complete crown off the slot and the hardpoint deck.
    const crown = species === 2 ? 0.94 : species === 1 ? 0.52 : species === 0 ? 0.3 : 0.4;
    if (r - scale * crown < 1.25 || (x > 0.7 && Math.abs(z) < 0.6) || Math.hypot(x - HARDPOINT_AT.x, z - HARDPOINT_AT.z) - scale * crown < HARDPOINT_PAD.r + 0.05) continue;
    const px = rotVX(turns, x, z), pz = rotVY(turns, x, z);
    if (plants.some((p) => Math.hypot(p.x - px, p.z - pz) < (p.scale + scale) * 0.3)) continue;
    plants.push({ species, x: px, y: capY(x, z, rr, seed) - 0.025, z: pz, scale: barren ? scale * 0.7 : scale, tint: (barren ? 0.7 : 0.91) + hash2(seed, 210 + k) * 0.13 });
  }
  return plants;
}

/**
 * Geometry is owned by the island renderer; no position, owner, time or local randomness enters the recipe. `hardpoint`
 * (the match's rules.sky.islandHardpoints > 0) adds the rim deck an attachment stands on.
 */
export function islandModel(seed: number, turns: number, hardpoint: boolean, ore = false): BufferGeometry {
  return merge(island(seed, turns, hardpoint, ore), true);
}

// ---------------------------------------------------------------- asteroid (lookdev `asteroidGeometry`)
const DUST = new Color('#b3a395');
const CRATER = new Color('#6f6058');
const CRATER_RIM = new Color('#d2c4b2');

/** A faceted atlas rock (radius ≈ 0.8) with cratered bowls and per-vertex pigment. */
function asteroid(): BufferGeometry {
  const g = new IcosahedronGeometry(1, 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const s = mergeVertices(g);
  const p = s.getAttribute('position');
  const paint = new Float32Array(p.count * 3);
  const craters: (Vector3Like & { r: number })[] = [];
  for (let k = 0; k < 7; k++) {
    const u = hash2(k, 31) * 2 - 1;
    const th = hash2(k, 32) * Math.PI * 2;
    const q = Math.sqrt(1 - u * u);
    craters.push({ x: Math.cos(th) * q, y: u, z: Math.sin(th) * q, r: 0.22 + hash2(k, 33) * 0.3 });
  }
  const c = new Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    let d = 1 + fbm(x * 1.6 + 5, y * 1.6 + z, 4) * 0.7 + fbm(z * 5, x * 5 + y, 2) * 0.12;
    c.copy(DUST);
    for (const k of craters) {
      const t = Math.acos(clamp(x * k.x + y * k.y + z * k.z, -1, 1)) / k.r;
      if (t < 1) {
        d -= (1 - t * t) * 0.1;
        c.lerp(CRATER, (1 - t) * 0.8 + 0.2);
      } else if (t < 1.35) {
        d += (1 - Math.abs(t - 1.15) / 0.2) * 0.03;
        c.lerp(CRATER_RIM, 0.5);
      }
    }
    p.setXYZ(i, x * d * 0.8, y * d * 0.64, z * d * 0.8);
    paint[i * 3] = c.r;
    paint[i * 3 + 1] = c.g;
    paint[i * 3 + 2] = c.b;
  }
  s.setAttribute('paint', new BufferAttribute(paint, 3));
  s.computeVertexNormals();
  return s;
}

// ---------------------------------------------------------------- derelict core
/**
 * A glowing orb (the only glow part; `entities.ts` tints it by heat) inside a three-hoop iron containment cage with
 * four stub clamps. Radius ≈ 0.75.
 */
function core(): Part[] {
  const orb = new IcosahedronGeometry(0.42, 1);
  const parts: Part[] = [{ geo: orb, paint: '#d8fbff', glow: 1 }];
  for (let k = 0; k < 3; k++) {
    // ring prisms (the kit has no tori): XY, XZ and YZ hoops
    const hoop = ring(0.665, 0.09, 0.09, CORE_HOOP_SIDES);
    if (k === 0) hoop.rotateX(Math.PI / 2);
    else if (k === 2) hoop.rotateZ(Math.PI / 2);
    parts.push({ geo: hoop, paint: STEEL });
  }
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    parts.push({ geo: box(0.12, 0.2, 0.12, Math.cos(a) * 0.62, -0.1, Math.sin(a) * 0.62), paint: IRON });
  }
  return parts;
}

/**
 * A structure's foundation (model units; `unit` = one world unit): a concrete slab inset inside a thin team-painted
 * trim (DIRECTIONS.md §1: the accent belongs to the model's cap and band, so the slab only edges it). Sky main-slot
 * builds stand on the island's round centre pad, so theirs is a round slab inside the pad's own rim.
 */
function foundation(kind: Kind, w: number, d: number, unit: number): Part[] {
  const { trim, height, trimHeight, sides, padFill } = FOUNDATION;
  if (SKY_PAD_KINDS[kind]) {
    const r = PAD_R * padFill * unit, t = trim * unit;
    return [
      { geo: cyl(r - t, r - t, height * unit, sides).translate(0, (height * unit) / 2, 0), paint: UNIT_PAINT.concrete },
      { geo: cyl(r, r, trimHeight * unit, sides).translate(0, (trimHeight * unit) / 2, 0), paint: IRON, ...ACCENT },
    ];
  }
  return [
    { geo: withoutFaces(box(w - 2 * trim * unit, height * unit, d - 2 * trim * unit), FACE.ny), paint: UNIT_PAINT.concrete },
    { geo: withoutFaces(box(w, trimHeight * unit, d), FACE.ny), paint: IRON, ...ACCENT },
  ];
}

function parts(kind: Kind): Part[] {
  if (kind === 'island') return island();
  if (kind === 'asteroid') return [{ geo: asteroid(), paint: '#b3a395' }];
  if (kind === 'post') return post();
  if (kind === 'core') return core();
  const pieces = unit(kind);
  const f = footprint(kind);
  if (f && kind !== 'bulkhead' && kind !== 'lava_bridge' && !isHardpointKind(kind)) {
    // Keep the authored rig coordinates intact; the instance scale fits the model's hull and its square foundation
    // (a barrel may overhang it, `hullExtent`). (A hardpoint attachment stands on its island's pad, the generic
    // mount, instead; a lava bridge's foundation is the timber deck the Depths layer lays over the lake.)
    let extentX = 0, extentZ = 0;
    for (const part of pieces) {
      if (part.part === PART.barrel) continue;
      part.geo.computeBoundingBox();
      const b = part.geo.boundingBox!;
      extentX = Math.max(extentX, Math.abs(b.min.x), Math.abs(b.max.x));
      extentZ = Math.max(extentZ, Math.abs(b.min.z), Math.abs(b.max.z));
    }
    const scale = Math.min(f.w / (2 * extentX), f.h / (2 * extentZ)) * 0.92;
    pieces.push(...foundation(kind, f.w / scale, f.h / scale, 1 / scale));
  }
  return pieces;
}

const cache = new Map<Kind, BufferGeometry>();
/** The kind's model (cached, rigged). */
export function model(kind: Kind): BufferGeometry {
  let g = cache.get(kind);
  if (!g) cache.set(kind, (g = merge(parts(kind), true)));
  return g;
}

/** The ordinary Sky deck's flattened, outlined cloud kit; storms use density carriers in weather.ts. */
function cloudGeometry(seed: number): BufferGeometry {
  const parts: Part[] = [];
  const k = 5 + Math.floor(hash2(seed, 9) * 4);
  for (let i = 0; i < k; i++) {
    const a = hash2(seed, i) * Math.PI * 2;
    const d = hash2(seed, i + 40) * 0.9;
    const s = 0.45 + hash2(seed, i + 80) * 0.45;
    const geo = new SphereGeometry(s, 16, 8).scale(1, 0.72, 1).translate(Math.cos(a) * d, s * 0.25, Math.sin(a) * d * 0.7);
    parts.push({ geo, paint: '#ffffff', smooth: true });
  }
  const g = merge(parts);
  const p = g.getAttribute('position'), normal = g.getAttribute('normal');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y >= 0) continue;
    // A continuous bend, not a cut-off shelf. Carry its inverse-transpose into the smooth lobe normals.
    const slope = Math.exp(y / 0.16);
    p.setY(i, 0.16 * (slope - 1));
    const nx = normal.getX(i), ny = normal.getY(i) / slope, nz = normal.getZ(i);
    const length = Math.hypot(nx, ny, nz);
    normal.setXYZ(i, nx / length, ny / length, nz / length);
  }
  g.computeBoundingSphere();
  return g;
}

const cloudCache: BufferGeometry[] = [];
let clouds: readonly BufferGeometry[] | undefined;

function cloudShape(index: number): BufferGeometry {
  return (cloudCache[index] ??= cloudGeometry(index * 7 + 3));
}

/** The four puff shapes of the ordinary Sky cloud deck (built once). */
export function cloudShapes(): readonly BufferGeometry[] {
  return (clouds ??= [0, 1, 2, 3].map(cloudShape));
}


/** Warm the ordinary deck kit in small tasks before constructing the Sky; retain its cache identities. */
export function prepareCloudShapes(): Promise<readonly BufferGeometry[]> {
  return prepareStartup((function* () {
    for (let i = 0; i < 4; i++) {
      cloudShape(i);
      yield;
    }
    return cloudShapes();
  })());
}

/** Largest distance of a vertex from the model's vertical axis (cached per geometry). */
const radii = new WeakMap<BufferGeometry, number>();
function radialExtent(geometry: BufferGeometry): number {
  let radius = radii.get(geometry);
  if (radius !== undefined) return radius;
  const positions = geometry.getAttribute('position');
  radius = 0;
  for (let i = 0; i < positions.count; i++) radius = Math.max(radius, Math.hypot(positions.getX(i), positions.getZ(i)));
  radii.set(geometry, radius);
  return radius;
}

/**
 * Half extents (|x|, |z|) of a structure's hull, cached per geometry: every vertex but its barrels, which may overhang
 * the footprint the hull fills (a turret's gun reaches past its plinth).
 */
const hulls = new WeakMap<BufferGeometry, { x: number; z: number }>();
export function hullExtent(geometry: BufferGeometry): { x: number; z: number } {
  let hull = hulls.get(geometry);
  if (hull) return hull;
  const positions = geometry.getAttribute('position');
  const part = geometry.getAttribute('part');
  hull = { x: 0, z: 0 };
  for (let i = 0; i < positions.count; i++) {
    if (part && part.getX(i) === PART.barrel) continue;
    hull.x = Math.max(hull.x, Math.abs(positions.getX(i)));
    hull.z = Math.max(hull.z, Math.abs(positions.getZ(i)));
  }
  hulls.set(geometry, hull);
  return hull;
}

/**
 * A structure occupies its registry rectangle at every zoom (its hull fills it; only a barrel may overhang).
 * A Gun Platform retains the flying Gunship's airframe scale; its landing skids stand on the hardpoint deck.
 * Other hardpoint attachments fit the round pad rather than a square tile.
 */
export function footprintModelScale(kind: Kind, geometry: BufferGeometry): number {
  const f = footprint(kind);
  if (!f) return UNIT_SCALE;
  if (kind === 'gun_platform') return UNIT_SCALE * AIR_SCALE;
  if (isHardpointKind(kind)) return HARDPOINT_PAD.fit / radialExtent(geometry);
  // A gate bisects bends diagonally. Keep that authored pose inside the cell at every bearing.
  if (kind === 'bulkhead') return Math.min(f.w, f.h) / (2 * radialExtent(geometry));
  const hull = hullExtent(geometry);
  return Math.min(f.w / (2 * hull.x), f.h / (2 * hull.z));
}

/** Ore lumps of a heap: (x, y, z, radius) on a unit-radius heap, piled highest at the centre. */
const HEAP_LUMPS: readonly (readonly [number, number, number, number])[] = [
  [0.4, 0.16, 0.26, 0.34], [-0.4, 0.14, 0.2, 0.32], [0.04, 0.3, -0.3, 0.38],
];
/** Crystal tips jutting from a heap: (x, y, z, half-height, tilt about x, tilt about z). */
const HEAP_CRYSTALS: readonly (readonly [number, number, number, number, number, number])[] = [
  [0.0, 0.52, 0.08, 0.5, 0.15, 0.1], [0.42, 0.36, -0.2, 0.34, -0.35, -0.6], [-0.3, 0.34, -0.12, 0.32, -0.3, 0.5],
];

/**
 * A heap of stored or dropped ore of radius `r` standing at (x, y, z): a low, wide rubble mound under faceted ore lumps
 * and a few crystal tips. Deliberately unlike a digger (a narrow tracked iron box carrying one crystal): no iron, no
 * team accent, no box or wheels, and wider than it is tall, so it reads as a resource pile at every zoom.
 */
export function oreHeap(r: number, x = 0, y = 0, z = 0): Part[] {
  // tilted before squashing so the mound's outline is an irregular rubble edge, not a regular machined hexagon
  const mound = new DodecahedronGeometry(1, 0).rotateX(0.55).rotateZ(0.3).scale(r, r * 0.36, r * 0.92).translate(x, y, z);
  const parts: Part[] = [{ geo: mound, paint: ORE_HEAP_PAINT.rubble }];
  for (const [lx, ly, lz, lr] of HEAP_LUMPS) {
    parts.push({ geo: new IcosahedronGeometry(lr * r, 0).rotateY(lx * 5 + lz * 3).translate(x + lx * r, y + ly * r, z + lz * r), paint: ORE_HEAP_PAINT.lump, glow: 0.3 });
  }
  for (const [cx, cy, cz, h, ax, az] of HEAP_CRYSTALS) {
    parts.push({ geo: new OctahedronGeometry(1, 0).scale(h * r * 0.24, h * r, h * r * 0.24).rotateX(ax).rotateZ(az).translate(x + cx * r, y + cy * r, z + cz * r), paint: ORE_HEAP_PAINT.crystal, glow: 0.8 });
  }
  return parts;
}

let heapGeometry: BufferGeometry | undefined;
/** The asteroid-drop ore cache: one unit-radius heap standing on y = 0 (cached). */
export function oreHeapModel(): BufferGeometry {
  return (heapGeometry ??= merge(oreHeap(1)));
}

let trenchGeometry: BufferGeometry | undefined;
/**
 * One trench segment joining two foxholes (`trenches.ts`): a unit length along X (stretched to the gap), trooper-scaled
 * across, a dark earth floor as wide as the scrape between two low sandbag walls (no undersides). 22 triangles.
 */
export function trenchModel(): BufferGeometry {
  const { radius, bag } = FOXHOLE;
  return (trenchGeometry ??= merge([
    { geo: new PlaneGeometry(1, radius * 1.2).rotateX(-Math.PI / 2).translate(0, 0.012, 0), paint: SCRAPE },
    ...[-1, 1].map((s): Part => ({ geo: withoutFaces(block(1, bag, 0.1, 0, 0, s * radius * 0.7, 1, 0.8), FACE.ny), paint: UNIT_PAINT.sandbag })),
  ]));
}

export type DropoffKind = 'headframe' | 'shaft' | 'spire';
const landingCache = new Map<DropoffKind, BufferGeometry>();

/** Lower landings share timber, iron bands and team markings. Cargo tags use the same state channels as upstairs. */
export function depthsDropoffModel(kind: DropoffKind): BufferGeometry {
  const cached = landingCache.get(kind);
  if (cached) return cached;
  const root = kind === 'spire';
  const parts: Part[] = [
    { geo: block(root ? 2.1 : 0.86, 0.10, root ? 1.8 : 0.86, 0, 0), paint: BODY.depths },
    { geo: block(root ? 2.2 : 0.94, 0.07, 0.10, 0, 0.10, root ? 0.85 : 0.39), paint: IRON, ...ACCENT },
    // Stored ore stays loose on the landing floor, clear of the posts and skip; the root's heap sits
    // outside the separate Spire casing, inside its iron side rails.
    ...(root ? oreHeap(0.3, 0.62, 0.10, -0.65) : oreHeap(0.18, 0.27, 0.10, 0)),
  ];
  if (root) {
    parts.push(
      { geo: block(0.12, 0.35, 1.9, -1.0, 0.17), paint: BODY.depths },
      { geo: block(0.12, 0.35, 1.9, 1.0, 0.17), paint: BODY.depths },
    );
  } else {
    parts.push(
      { geo: block(0.12, 1.05, 0.12, -0.36, 0.17, -0.32), paint: BODY.depths },
      { geo: block(0.12, 1.05, 0.12, -0.36, 0.17, 0.32), paint: BODY.depths },
      { geo: block(0.12, 1.05, 0.12, 0.36, 0.17, -0.32), paint: BODY.depths },
      { geo: block(0.12, 1.05, 0.12, 0.36, 0.17, 0.32), paint: BODY.depths },
      { geo: block(0.13, 0.12, 0.86, -0.36, 1.22), paint: BODY.depths, ...ACCENT },
      { geo: block(0.13, 0.12, 0.86, 0.36, 1.22), paint: BODY.depths, ...ACCENT },
      { geo: block(0.58, 0.12, 0.13, 0, 1.22, -0.36), paint: BODY.depths, ...ACCENT },
      { geo: block(0.58, 0.12, 0.13, 0, 1.22, 0.36), paint: BODY.depths, ...ACCENT },
      { geo: block(0.06, 2.5, 0.06, -0.08, 0.17), paint: IRON },
      { geo: block(0.34, 0.24, 0.32, -0.08, 0.20, 0, 1.15, 1.15), paint: STEEL, part: PART.cargo },
      { geo: block(0.06, 0.27, 0.06, -0.08, 0.44), paint: IRON, part: PART.cargo },
      { geo: new OctahedronGeometry(0.14).scale(1, 0.65, 1).translate(-0.08, 0.46, 0), paint: UNIT_PAINT.ore, glow: 0.9, part: PART.cargo },
    );
    if (kind === 'shaft') parts.push({ geo: block(0.55, 0.07, 0.72, 0.48, 0.02), paint: STEEL });
  }
  const geometry = merge(parts, true);
  landingCache.set(kind, geometry);
  return geometry;
}
