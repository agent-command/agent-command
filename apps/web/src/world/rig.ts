/**
 * Unit animation kit (docs/art/DIRECTIONS.md §1 "Unit animation kit"): pivot-painted rigid parts moved in the vertex
 * stage. Each vertex's `part` id (`models.ts` PART) selects which of the kind's `RIG` motions apply; one interleaved
 * per-instance record (`STRIDE` floats, offsets `REC`, read as the `REC_ATTRS` vec4 attributes) carries the transform
 * and the animation state, so a kind is one instanced draw with no per-instance matrix work on the CPU. The animated
 * world normal feeds both the cel ramp and the MRT normal, so the ink pass outlines the animated pose.
 */
import { InterleavedBufferAttribute, type InstancedInterleavedBuffer, type Node } from 'three/webgpu';
import { abs, attribute, clamp, cos, float, floor, fract, max, mix, mod, normalGeometry, positionGeometry, sign, sin, smoothstep, step, varying, vec2, vec3 } from 'three/tsl';
import { STATS, isStatKind, type Kind } from '@agent-command/game/contract';
import { BASTION_PART, BASTION_PD, PART, RIG, SOLAR_FILL, SOLAR_PART, STATE_VISUALS } from './models.ts';
import { clock, type F1, type V3 } from './materials.ts';
import { ROCK_STRETCH } from './asteroid.ts';

/** Floats per instance record (one vertex buffer per kind). */
export const STRIDE = 20;
/** Offsets in an instance record. */
export const REC = {
  /** world position and yaw (rad, three.js Y rotation = −heading) */
  x: 0, y: 1, z: 2, yaw: 3,
  /** uniform scale, construction height factor, bank (roll about +X), pitch (about +Z, nose up) */
  scale: 4, build: 5, bank: 6, pitch: 7,
  /** team rgb and plane fade */
  r: 8, g: 9, b: 10, fade: 11,
  /** plane index + focus (fraction), last shot / hit (`clock` seconds), gait odometer (model units) */
  look: 12, fire: 13, hit: 14, gait: 15,
  /** speed (tiles/s), work (0…1, or the solar panel roll in rad), constant per-unit phase (rad; idle cycles) */
  drive: 16, work: 17, phase: 18,
  /**
   * Turret mounts: local Y yaw (rad, hull heading − aim) with the barrel elevation packed above it (`packMount`).
   * Other kinds: normalized model state (cargo, linkage, progress).
   */
  fill: 19,
} as const;
/** The record's vec4 geometry attributes, in record order (all views of one buffer: one vertex buffer per kind). */
export const REC_ATTRS = ['unitPose', 'unitForm', 'unitTint', 'unitState', 'unitDrive'] as const;

/** Attach the record views of `buf` to an instanced geometry's attribute map. */
export function recordAttributes(buf: InstancedInterleavedBuffer): Record<(typeof REC_ATTRS)[number], InterleavedBufferAttribute> {
  return Object.fromEntries(REC_ATTRS.map((name, i) => [name, new InterleavedBufferAttribute(buf, 4, i * 4)])) as Record<(typeof REC_ATTRS)[number], InterleavedBufferAttribute>;
}

/**
 * Zoom readability enlargement (×UNIT_SCALE) of units, 1 up close to 2.2 far out, so silhouettes stay readable.
 * Footprint-fitted structures never take it: their head and base stay in proportion. An emplaced Gunship keeps
 * its flying airframe's enlargement as one rigid whole, with its landing contact still on the deck.
 */
export const unitZoomScale = (zoom: number): number => Math.min(2.2, Math.max(1, zoom / 26));

/**
 * A turret mount's barrel elevation shares the yaw's record slot: fill = yaw + MOUNT_YAW_SPAN · round(pitch ·
 * MOUNT_PITCH_STEPS). |yaw| ≤ π < MOUNT_YAW_SPAN / 2 decodes exactly; elevation steps are 1/256 rad (0.22°), and a
 * float32 still resolves the yaw to ~3e-4 rad at the largest packed pitch.
 */
export const MOUNT_YAW_SPAN = 8;
export const MOUNT_PITCH_STEPS = 256;
/** The elevation the record (and so the drawn barrel) actually carries; the CPU muzzle mirror uses the same value. */
export const mountPitchStep = (pitch: number): number => Math.round(pitch * MOUNT_PITCH_STEPS) / MOUNT_PITCH_STEPS;
export const packMount = (yaw: number, pitch: number): number => yaw + MOUNT_YAW_SPAN * Math.round(pitch * MOUNT_PITCH_STEPS);

/** Recoil and flinch envelopes (seconds). */
const FIRE_S = 0.3;
const HIT_S = 0.25;
/**
 * `REC.build` carries a death's height squash (≤ 1) or, on a structure under construction, CONSTRUCTION_BASE plus its
 * build progress: the site keeps its full height and the material draws the unbuilt part as a sketch.
 */
export const CONSTRUCTION_BASE = 2;
/** The `REC.build` value of a construction site at `progress` (0…1). */
export const constructionRecord = (progress: number): number => CONSTRUCTION_BASE + Math.min(1, Math.max(0, progress));

/**
 * Tread cleats on tracked kinds' pods (`KindMesh`): cleats per model unit, the line half-width and how dark a cleat
 * draws. Their phase is `treadPhase`: geometry x plus the gait odometer, so a cleat on the ground holds still in the
 * world as the hull rolls forward.
 */
export const TREAD = { cleats: 14, width: 0.12, shade: 0.55 } as const;
export const treadPhase = (x: number, odo: number): number => (x + odo) * TREAD.cleats + 0.5;
/**
 * Arrival (spawn or plane change): the model eases from `from` of its size to full over `seconds` (ease-out cubic),
 * so a new unit reads as arriving rather than popping in.
 */
export const ARRIVAL = { from: 0.6, seconds: 0.25 } as const;
/** The arrival grow-in scale `age` seconds after a model arrived (1 once grown, and for anything never arriving). */
export function arrivalScale(age: number): number {
  if (!(age < ARRIVAL.seconds)) return 1;
  const k = 1 - Math.max(0, age) / ARRIVAL.seconds;
  return ARRIVAL.from + (1 - ARRIVAL.from) * (1 - k * k * k);
}
/** A rotation's cosine and sine, shared by the position and the normal. */
type CS = { c: F1; s: F1 };
const cs = (a: F1): CS => ({ c: cos(a) as F1, s: sin(a) as F1 });
const rotX = (v: V3, { c, s }: CS): V3 => vec3(v.x, v.y.mul(c).sub(v.z.mul(s)), v.y.mul(s).add(v.z.mul(c))) as unknown as V3;
const rotY = (v: V3, { c, s }: CS): V3 => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s))) as unknown as V3;
const rotZ = (v: V3, { c, s }: CS): V3 => vec3(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)), v.z) as unknown as V3;
const ROT = { x: rotX, y: rotY, z: rotZ };

/** A solar array's packed fill (`packSolar`), decoded: each field 0…1, `anchored` 0/1 and `damaged` 0/1. */
export interface SolarStatus { fold: F1; anchored: F1; charge: F1; light: F1; damaged: F1 }
/**
 * Decode `packSolar`. Rounds first, so a fragment-stage read of the interpolated (all-equal) per-instance value
 * decodes as exactly as the vertex stage.
 */
export function solarStatus(fill: F1): SolarStatus {
  const { fold: F, charge: C, light: L } = SOLAR_FILL;
  const n = floor(fill.add(0.5));
  const c = floor(n.div(F));
  const l = floor(c.div(C));
  const code = mod(c, C);
  return {
    fold: mod(n, F).div(F - 1) as F1,
    anchored: step(0.5, code) as F1,
    charge: max(code.sub(1), 0).div(C - 2) as F1,
    light: mod(l, L).div(L - 1) as F1,
    damaged: step(0.5, floor(l.div(L))) as F1,
  };
}

export interface UnitNodes {
  /** animated world position (the material's `positionNode`; the mesh sits at the origin) */
  position: V3;
  /** animated world normal (vertex varying, unnormalised) */
  normal: V3;
  /** team rgb + fade */
  tint: Node<'vec4'>;
  /** x = plane focus 0…1, y = plane index */
  look: Node<'vec2'>;
  opacity: F1;
  /** x = 1 on a construction site, y = its build progress 0…1 (`CONSTRUCTION_BASE`) */
  build: Node<'vec2'>;
}

/** The vertex rig of `kind`, reading its instance record from the `REC_ATTRS` attributes. */
export function unitRig(kind: Kind, frozen = false): UnitNodes {
  const a = attribute<'vec4'>('unitPose', 'vec4');
  const b = attribute<'vec4'>('unitForm', 'vec4');
  const tint = attribute<'vec4'>('unitTint', 'vec4');
  const d = attribute<'vec4'>('unitState', 'vec4');
  const e = attribute<'vec4'>('unitDrive', 'vec4');
  const rig = RIG[kind];
  const t = (frozen ? float(0) : clock) as unknown as F1;
  const part = attribute<'float'>('part', 'float');
  const is = (id: number): F1 => step(abs(part.sub(id)), float(0.5)) as F1;

  const fireK0 = clamp(float(1).sub(t.sub(d.y).div(FIRE_S)), 0, 1).mul(step(d.y, t));
  const fire = fireK0.mul(fireK0) as F1;
  const hitK = clamp(float(1).sub(t.sub(d.z).div(HIT_S)), 0, 1).mul(step(d.z, t)) as F1;
  const move = smoothstep(0.08, 0.7, e.x) as F1;
  const work = e.y as F1;
  // constant per unit: idle cycles never drift with movement (a travelling seed retimes bobs and spins)
  const seed = e.z as F1;
  // `REC.build` past CONSTRUCTION_BASE is a site's progress (drawn full height as a sketch), else a death's squash
  const constructing = step(CONSTRUCTION_BASE - 0.5, b.y) as F1;

  let p = positionGeometry as unknown as V3;
  let n = normalGeometry as unknown as V3;
  let opacity = float(1) as F1;
  /** Rotate the masked vertices by `angle` about `axis` through `c`. */
  const turn = (axis: 'x' | 'y' | 'z', angle: F1, c: [number, number, number]): void => {
    const r = cs(angle);
    const o = vec3(...c) as unknown as V3;
    p = ROT[axis](p.sub(o) as V3, r).add(o) as V3;
    n = ROT[axis](n, r);
  };
  const lift = (dy: F1): void => {
    p = p.add(vec3(0, dy, 0)) as V3;
  };

  const stateParts = STATE_VISUALS[kind]?.parts;
  if (stateParts) for (const visual of stateParts) {
    const source = (visual.channel === 'fill' ? e.w : e.y) as F1;
    const channel = (visual.range ? step(visual.range[0], source).mul(step(source, visual.range[1]))
      : visual.ease ? smoothstep(visual.ease[0], visual.ease[1], source)
      : visual.bump ? sin(clamp(source.sub(visual.bump[0]).div(visual.bump[1] - visual.bump[0]), 0, 1).mul(Math.PI))
      : source) as F1;
    const mask = is(visual.part);
    if (visual.turn) {
      const { axis, angle, pivot } = visual.turn;
      turn(axis, channel.mul(angle).mul(mask) as F1, [pivot[0], pivot[1], pivot[2]]);
    }
    if (visual.translate) p = p.add(vec3(...visual.translate).mul(channel).mul(mask)) as V3;
    if (visual.stretch) {
      const scale = vec3(...visual.stretch).sub(1).mul(channel).mul(mask).add(1);
      p = p.mul(scale) as V3;
      n = n.div(scale) as V3;
    }
    if (visual.visible) opacity = opacity.mul(float(1).sub(mask).add(mask.mul(channel))) as F1;
    if (visual.scale) {
      const origin = vec3(...visual.scale);
      const scale = channel.sub(1).mul(mask).add(1);
      p = p.sub(origin).mul(scale).add(origin) as V3;
    }
    if (visual.rise) {
      // kept above zero so the normal stays finite while the course lies flat (hidden by its `visible` entry)
      const k = max(channel, 0.001).sub(1).mul(mask).add(1);
      p = vec3(p.x, p.y.mul(k), p.z) as unknown as V3;
      n = vec3(n.x, n.y.div(k), n.z) as unknown as V3;
    }
    if (visual.pinch) {
      const { centre, amplitude, rate } = visual.pinch;
      const k = float(1).sub(channel.mul(amplitude).mul(sin(t.mul(rate)).mul(0.5).add(0.5)).mul(mask));
      p = vec3(p.x, p.y, p.z.sub(centre).mul(k).add(centre)) as unknown as V3;
      n = vec3(n.x, n.y, n.z.div(k)) as unknown as V3;
    }
    if (visual.hoist) {
      lift(channel.mul(visual.hoist.distance).mul(mask) as F1);
      opacity = opacity.mul(float(1).sub(smoothstep(visual.hoist.fadeFrom, 1, channel).mul(mask))) as F1;
    }
    if (visual.drift) {
      // A looping puff: it swells out of its origin, rises and grows, then shrinks away before the loop restarts (a
      // size envelope, not a dithered fade, so the ink outline stays clean); hidden while off.
      const { origin, rise, grow, rate } = visual.drift;
      const k = fract(t.mul(rate).add(seed.mul(1 / (Math.PI * 2))));
      const on = channel.mul(mask);
      const size = k.mul(grow).add(1).mul(smoothstep(0, 0.15, k)).mul(float(1).sub(smoothstep(0.7, 1, k)));
      const o = vec3(...origin);
      p = p.sub(o).mul(size.sub(1).mul(on).add(1)).add(o).add(vec3(0, k.mul(rise).mul(on), 0)) as V3;
      opacity = opacity.mul(float(1).sub(mask).add(on)) as F1;
    }
  }

  // part-local motions
  if (rig.tool) {
    const { x, y, z, spin, reach } = rig.tool;
    const m = is(PART.tool);
    // spin on/off (a rate scaled by the decaying envelope would sweep thousands of radians: t is absolute)
    if (spin) turn('x', t.mul(spin).mul(max(work, step(0.01, fire))).mul(m) as F1, [x, y, z]);
    if (reach) {
      const strike = max(work.mul(max(sin(t.mul(10)), 0).pow(4)), fire);
      p = p.add(vec3(strike.mul(reach).mul(m), 0, 0)) as V3;
    }
  }
  if (rig.rotor) {
    const { x, y, z, axis, idle, work: busy, pair } = rig.rotor;
    const rate = busy === idle ? float(idle) : work.mul(busy - idle).add(idle);
    // a construction site's machinery stands still until it is finished
    const angle = (rig.rotor.cycle ? (rig.rotor.cycle === 'fill' ? e.w : e.y).mul(Math.PI * 2) : t.mul(rate).add(seed)).mul(float(1).sub(constructing));
    if (pair) {
      // twin hubs mirrored across z = 0: each vertex spins about the hub on its own side, the pair counter-rotating
      const side = step(0, p.z).mul(2).sub(1);
      const r = cs(angle.mul(side).mul(is(PART.rotor)) as F1);
      const o = vec3(x, y, side.mul(z)) as unknown as V3;
      p = ROT[axis](p.sub(o) as V3, r).add(o) as V3;
      n = ROT[axis](n, r);
    } else turn(axis, angle.mul(is(PART.rotor)) as F1, [x, y, z]);
  }
  if (rig.swing) {
    const { x, y, z, axis, amp, rate } = rig.swing;
    turn(axis, sin(t.mul(rate).add(seed)).mul(amp).mul(work).mul(is(PART.tool)) as F1, [x, y, z]);
  }
  if (rig.wave) {
    // A flag's flutter: no CPU work, a sine travelling out along the cloth, still at the staff.
    const { x0, amp, rate, k } = rig.wave;
    const reach = max(p.x.sub(x0), 0);
    const flutter = sin(t.mul(rate).sub(p.x.mul(k)).add(seed)).mul(reach).mul(amp).mul(is(PART.cloth));
    // a hanging flag flutters across Z; a flat pennant (the aerie's windsock) flaps in Y
    p = (rig.wave.axis === 'y' ? vec3(p.x, p.y.add(flutter), p.z) : vec3(p.x, p.y, p.z.add(flutter))) as unknown as V3;
  }
  if (rig.panel) {
    const wing = is(PART.panel).add(is(SOLAR_PART.trim)) as F1;
    if (rig.panel.fold) {
      // Stowed, each wing is a thick stack at its root; it spreads along Z as the array anchors. Glass and frame scale
      // alike, so the shaded cell grid (geometry space) folds with them.
      const { root, folded, stack } = rig.panel.fold;
      const open = smoothstep(0, 1, solarStatus(e.w).fold);
      const span = mix(folded, 1, open).sub(1).mul(wing).add(1);
      const thick = mix(stack, 1, open).sub(1).mul(wing).add(1);
      p = vec3(p.x, p.y.mul(thick), sign(p.z).mul(abs(p.z).sub(root).mul(span).add(root)).sub(p.z).mul(wing).add(p.z)) as unknown as V3;
      n = vec3(n.x, n.y.div(thick), n.z.div(span)) as unknown as V3;
    }
    turn('z', work.mul(wing) as F1, [0, rig.panel.y, 0]);
  }
  if (rig.flame) {
    const fx = rig.flame.x;
    const k = move.mul(0.9).add(0.45).mul(sin(t.mul(41).add(seed)).mul(0.12).add(1));
    const m = is(PART.flame);
    p = vec3(p.x.sub(fx).mul(k.sub(1).mul(m).add(1)).add(fx), p.y, p.z) as unknown as V3;
  }
  if (rig.pilot) {
    // the pilot light flickers on two beating sines and flares with each shot, scaled about its own centre
    const { x, y, z, rate, amp, flare } = rig.pilot;
    const flicker = sin(t.mul(rate).add(seed)).mul(0.6).add(sin(t.mul(rate * 2.7).add(seed.mul(3))).mul(0.4));
    const k = flicker.mul(amp).add(fire.mul(flare)).mul(is(PART.flame)).add(1);
    const o = vec3(x, y, z);
    p = p.sub(o).mul(k).add(o) as V3;
  }
  if (rig.recoil) {
    const { dist, dx, dy, deployed } = rig.recoil;
    // a pilot light rides its barrel; a held deploy stance (work 1) kicks `deployed`× as far
    const heavy = deployed ? work.mul(deployed - 1).add(1) : float(1);
    const k = fire.mul(dist).mul(heavy).mul(rig.pilot ? is(PART.barrel).add(is(PART.flame)) : is(PART.barrel));
    p = p.sub(vec3(k.mul(dx), k.mul(dy), 0)) as V3;
  }
  // Turret mounts carry their barrel elevation packed above the yaw in `fill` (`packMount`). Other kinds' fill is a
  // normalized state channel and is never decoded as an angle.
  const mounted = isStatKind(kind) && STATS[kind].mount?.kind === 'turret';
  const packed = mounted ? floor(e.w.div(MOUNT_YAW_SPAN).add(0.5)) : float(0);
  const mountYaw = (mounted ? e.w.sub(packed.mul(MOUNT_YAW_SPAN)) : e.w) as F1;
  // The right Bastion blister's barrel recoils here; the generic recoil above moves only `PART.barrel` (the left).
  if (kind === 'bastion') p = p.sub(vec3(fire.mul(0.035).mul(is(BASTION_PART.barrel)), 0, 0)) as V3;
  // Barrels elevate about their trunnion in mount-local space: after recoil, before the kick and the yaw. The pivot
  // axis is parallel to Z, so it serves both Bastion shoulders at once.
  if (mounted && rig.elevate) {
    const barrels = kind === 'bastion' ? is(PART.barrel).add(is(BASTION_PART.barrel)) : is(PART.barrel);
    turn('z', packed.div(MOUNT_PITCH_STEPS).mul(barrels) as F1, [rig.elevate.x, rig.elevate.y, 0]);
  }
  if (kind === 'bastion') {
    // Each shoulder has its own pivot: rotating a shared centre would orbit the entire blisters around the hull.
    turn('y', mountYaw.mul(is(PART.top).add(is(PART.barrel))) as F1, [BASTION_PD.x, BASTION_PD.y, -BASTION_PD.z]);
    turn('y', mountYaw.mul(is(BASTION_PART.top).add(is(BASTION_PART.barrel))) as F1, [BASTION_PD.x, BASTION_PD.y, BASTION_PD.z]);
  }
  if (rig.top?.kick) turn('z', fire.mul(rig.top.kick).mul(is(PART.top).add(is(PART.barrel))) as F1, [rig.top.x, rig.top.y, 0]);
  // Turret top and barrel share a yaw pivot; recoil, elevation and kick above stay in barrel-local space.
  if (mounted && rig.top) turn('y', mountYaw.mul(is(PART.top).add(is(PART.barrel))) as F1, [rig.top.x, rig.top.y, 0]);

  // running gear and the body it carries
  const left = is(PART.left);
  const right = is(PART.right);
  const hull = float(1).sub(left).sub(right) as F1;
  if (rig.gait) {
    const g = d.w.mul((Math.PI * 2) / rig.gait.stride) as F1;
    switch (rig.gait.kind) {
      case 'tracks':
        lift(abs(sin(g)).mul(left).add(abs(cos(g)).mul(right)).mul(0.015).mul(move) as F1);
        lift(abs(sin(g.mul(2))).mul(0.012).mul(move).mul(hull) as F1);
        break;
      case 'legs': {
        const swing = sin(g).mul(0.55).mul(move);
        const hip: [number, number, number] = [0, rig.gait.hip ?? 0.2, 0];
        turn('z', swing.mul(left).sub(swing.mul(right)) as F1, hip);
        lift(abs(cos(g)).sub(0.5).mul(0.03).mul(move).mul(hull) as F1);
        turn('z', move.mul(-0.12).mul(hull) as F1, [0, 0, 0]);
        break;
      }
      case 'skids':
        lift(max(sin(g), 0).mul(left).add(max(sin(g).negate(), 0).mul(right)).mul(0.03).mul(move) as F1);
        turn('y', sin(g).mul(0.08).mul(move) as F1, [0, 0, 0]);
        break;
    }
  }
  if (rig.jolt) {
    turn('z', fire.mul(rig.jolt).mul(hull) as F1, [0, 0, 0]);
    p = p.sub(vec3(fire.mul(rig.jolt * 0.3).mul(hull), 0, 0)) as V3;
  }
  if (rig.shudder) lift(sin(t.mul(31).add(seed.mul(7))).mul(rig.shudder).mul(hull) as F1);
  if (rig.gait?.kind === 'legs' || rig.gait?.kind === 'skids') lift(p.y.mul(sin(t.mul(2.2).add(seed)).mul(0.015)).mul(hull) as F1);
  if (rig.squat) {
    lift(p.y.mul(work.mul(-rig.squat * 0.4)).mul(hull) as F1);
    lift(work.mul(sin(t.mul(5)).mul(0.5).add(0.5)).mul(-0.05).mul(is(PART.top)) as F1);
  }
  if (rig.hover) lift(sin(t.mul(0.9).add(seed)).mul(rig.hover) as F1);
  // hit flinch: a quick sideways shake and a squash
  p = vec3(p.x, p.y.mul(hitK.mul(-0.06).add(1)), p.z.add(sin(t.mul(60)).mul(0.03).mul(hitK))) as unknown as V3;
  // instance transform: scale (height × build), pitch, bank, yaw (asteroids tumble on their phase, the core spins), translate
  p = vec3(p.x.mul(b.x), p.y.mul(b.x).mul(mix(b.y, 1, constructing)), p.z.mul(b.x)) as unknown as V3;
  if (kind === 'asteroid') {
    // every rock its own shape: stretched along its axes by its phase before it tumbles (`rockStretch`)
    const { x: sx, y: sy, z: sz } = ROCK_STRETCH;
    const stretch = vec3(sin(seed.mul(sx.rate)).mul(sx.amp).add(1), sin(seed.mul(sy.rate)).mul(sy.amp).add(1), cos(seed.mul(sz.rate)).mul(sz.amp).add(1));
    p = p.mul(stretch) as V3;
    n = n.div(stretch) as V3;
    const z = cs(seed.mul(2) as F1);
    const y = cs(t.mul(0.2) as F1);
    const x = cs(t.mul(0.3).add(seed) as F1);
    p = rotX(rotY(rotZ(p, z), y), x);
    n = rotX(rotY(rotZ(n, z), y), x);
  } else if (kind === 'core') {
    // the derelict core's containment cage turns slowly about a fixed tilt; it has no heading
    const tilt = cs(float(0.35) as F1);
    const spin = cs(t.mul(0.4).add(seed) as F1);
    p = rotX(rotY(p, spin), tilt);
    n = rotX(rotY(n, spin), tilt);
  } else {
    const pitch = cs(b.w as F1);
    const bank = cs(b.z as F1);
    const yaw = cs(a.w as F1);
    p = rotY(rotX(rotZ(p, pitch), bank), yaw);
    n = rotY(rotX(rotZ(n, pitch), bank), yaw);
  }
  return {
    position: p.add(a.xyz) as V3,
    normal: varying(n, 'vUnitNormal') as unknown as V3,
    tint,
    opacity: varying(opacity, 'vUnitOpacity') as F1,
    build: varying(vec2(constructing, b.y.sub(CONSTRUCTION_BASE).clamp(0, 1)), 'vUnitBuild') as unknown as Node<'vec2'>,
    // unpacked per vertex: floor/fract of an interpolated integer flicker between neighbours per pixel (a moiré on
    // the ghosted plane, where focus = 0 makes the packed value an exact integer)
    look: varying(vec2(clamp(fract(d.x).mul(1.001), 0, 1), floor(d.x)), 'vUnitLook') as unknown as Node<'vec2'>,
  };
}
