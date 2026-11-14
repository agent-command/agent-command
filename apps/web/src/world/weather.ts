/**
 * The Sky's public weather forecast drawn as weather, not as chart ink (docs/art/RESEARCH.md "Sky weather VFX"):
 * - storms: this layer publishes each public storm's cloud field; `storm-clouds.ts` fuses it into one toon hurricane
 *   (spiral arms, wind trails, lightning) in its own pass, cut away around admitted islands (no new gameplay);
 * - jet lanes: Wind Waker-style wind streaks laid out and animated entirely in the vertex shader (no CPU per frame);
 * - fog banks: a low layered mist (stacked slices of baked scrolling noise with a billowing edge).
 * Weather comes from the public forecast; lanes and mist draw after the fog-of-war veil, storms in the fused pass.
 * Only currently visible, rendered island tracks may open a cutaway; public paths and remembered entities cannot.
 * Buffers are reused between frames.
 */
import {
  Box3, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial,
  Object3D, PlaneGeometry, Vector4, type Mesh, type Node, type UniformArrayNode, type Vector3,
} from 'three/webgpu';
import { Fn, Loop, abs, cameraPosition, color, cos, dot, float, instancedDynamicBufferAttribute, mix, positionWorld, sin, smoothstep, uniform, uniformArray, uv, vec2, vec3 } from 'three/tsl';
import { MAX_ARMIES, MOORING_DEPTH, PLANE_Y, TICK_RATE, footprint, rotX, rotY, type MatchData, type View } from '@agent-command/game/contract';
import { sampleStorm, type NaturalStorm } from '@agent-command/game/weather';
import { FADE } from './fade.ts';
import { hash2, wx, wz } from './common.ts';
import { LINE_DIST } from './ink.ts';
import { clock, noise, overlay, type F1, type V3 } from './materials.ts';
import { VIEW } from './palette.ts';
import type { Track } from './entities.ts';
import type { DeathPlayer } from './death-fx.ts';
import type { FogField } from './fog.ts';
import { model } from './models.ts';

type Weather = View['weather'];
type WeatherMap = Pick<MatchData, 'jets' | 'fogPaths'>;
/** Retained public storm render inputs for the fused-cloud pass (`storm-clouds.ts`); no gameplay or hidden entity data.
 * centres: world x, base y, world z, drawn radius; states: opacity, flash, spin, circulating (0 for forecasts and
 * warnings); strikes: lightning origin world x, z, bearing and envelope (0 while dark). */
export interface WeatherCloudField {
  centres: Vector4[];
  states: Vector4[];
  strikes: Vector4[];
  count: number;
  /** Cosmetic motion: 0 under reduced motion. */
  motion: number;
}
export type WeatherKind = 'storm' | 'seeded' | 'seeding' | 'forecast' | 'fog' | 'jet';

/** Fog's circular public path only; natural storms use sampleStorm. Reuses caller scratch. */
export function weatherAt(path: MatchData['fogPaths'][number], tick: number, out: { x: number; y: number }, size: number): void {
  const a = path.phase + tick / TICK_RATE * path.speed;
  const x = path.cx + Math.cos(a) * path.radius;
  const y = path.cy + Math.sin(a) * path.radius;
  // The canonical point, then `turns` quarter turns about the map centre (2 = the C2 point mirror).
  out.x = rotX(path.turns, x, y, size);
  out.y = rotY(path.turns, x, y, size);
}

const HIT = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' as NaturalStorm['stage'] };

function within(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = x - cx, dy = y - cy;
  return r > 0 && dx * dx + dy * dy <= r * r;
}

/** Faint clouds gather at the public origin before the storm starts moving. */
function gathering(c: NaturalStorm, tick: number): number {
  return 1 - Math.min(1, Math.max(0, (c.start - tick) / (c.grown - c.start)));
}
/** The weather drawn at tile (x, y) at `tick`, damaging first (hover tooltips). Same boundaries as the sim. */
export function weatherUnder(weather: Weather, match: WeatherMap, tick: number, x: number, y: number, size: number): WeatherKind | undefined {
  for (const c of weather.storms) {
    if (tick < c.start || tick >= c.end) continue;
    sampleStorm(c, tick, HIT, 0, size);
    if (within(x, y, HIT.x, HIT.y, HIT.radius)) return 'storm';
  }
  for (const c of weather.forecast) {
    if (tick < c.start || tick >= c.end) continue;
    sampleStorm(c, tick, HIT, 0, size);
    if (within(x, y, HIT.x, HIT.y, HIT.radius)) return 'storm';
  }
  for (const c of weather.seeded) if (tick < c.until && within(x, y, c.x, c.y, c.radius)) return 'seeded';
  for (const c of weather.seedWarnings) if (tick < c.from && within(x, y, c.x, c.y, c.radius)) return 'seeding';
  for (let i = 0; i < weather.fog.length; i++) {
    const c = weather.fog[i]!;
    weatherAt(match.fogPaths[i]!, tick, HIT, size);
    if (within(x, y, HIT.x, HIT.y, c.radius)) return 'fog';
  }
  for (const c of weather.forecast) {
    if (tick >= c.start) continue;
    sampleStorm(c, tick, HIT, 0, size);
    if (within(x, y, HIT.x, HIT.y, c.maxRadius * (0.22 + gathering(c, tick) * 0.18))) return 'forecast';
  }
  for (const lane of match.jets) if (Math.abs(y - lane.y1) <= lane.width) return 'jet';
  return undefined;
}

/** Seconds per lightning slot; each slot strikes or stays dark by hash. */
const FLASH_SLOT = 2.6;
/**
 * Lightning envelope (0..1) of storm `id` at `s` seconds: about half the slots strike once, a bright flash that
 * flickers back once (Horizon Forbidden West's rhythm, shortened). Pure function of time and id.
 */
export function flashAt(s: number, id: number): number {
  const u = s / FLASH_SLOT + hash2(id, 101);
  const slot = Math.floor(u);
  if (hash2(id * 31 + 7, slot) > 0.55) return 0;
  const dt = (u - slot - (0.1 + hash2(id * 31 + 9, slot) * 0.7)) * FLASH_SLOT;
  if (dt < 0 || dt > 0.6) return 0;
  return Math.min(1, Math.exp(-dt * 12) + (dt > 0.1 ? 0.85 * Math.exp(-(dt - 0.1) * 16) : 0));
}

/** Geometry-sized island ellipsoids (centre, axes) projected toward the camera: 0 over an admitted island's view
 * ray with a smooth feather `feather` ellipsoid radii wide, 1 elsewhere. `edge` (ellipsoid radii) pushes the boundary
 * out or in per fragment for an irregular rim. Shared by the white deck and the fused storm pass. */
export function islandClearance(islands: UniformArrayNode<'vec4'>, axes: UniformArrayNode<'vec4'>, count: Node<'int'>, point: V3, eye: V3, edge: F1 | number = 0, feather = 0.18): F1 {
  return Fn(() => {
    const keep = float(1).toVar();
    Loop(count, ({ i }) => {
      const axis = axes.element(i).xyz;
      const ray = point.sub(eye).div(axis).normalize();
      const delta = islands.element(i).xyz.sub(point).div(axis);
      const along = dot(delta, ray);
      const closest = delta.sub(ray.mul(along));
      const feathered = smoothstep(1, 1 + feather, closest.length().add(edge));
      const front = smoothstep(-0.45, 0.1, along);
      keep.assign(keep.min(mix(float(1), feathered, front)));
    });
    return keep;
  })() as F1;
}

/** Jagged bolt: midpoint-displaced polyline with two forks, as a flat ribbon of unit length along +x (uv.y across). */
export function boltGeometry(seed: number): BufferGeometry {
  const pos: number[] = [], uvs: number[] = [];
  const strand = (pts: readonly [number, number, number][], w: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay, az] = pts[i]!, [bx, by, bz] = pts[i + 1]!;
      const l = Math.hypot(bx - ax, bz - az) || 1;
      const nx = -(bz - az) / l * w, nz = (bx - ax) / l * w;
      const t0 = 1 - i / (pts.length - 1) * 0.7, t1 = 1 - (i + 1) / (pts.length - 1) * 0.7;
      const quad = [[ax - nx * t0, ay, az - nz * t0, 0], [ax + nx * t0, ay, az + nz * t0, 1], [bx + nx * t1, by, bz + nz * t1, 1], [bx - nx * t1, by, bz - nz * t1, 0]] as const;
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const v = quad[k]!;
        pos.push(v[0], v[1], v[2]);
        uvs.push(0, v[3]);
      }
    }
  };
  const jag = (ax: number, az: number, bx: number, bz: number, depth: number, salt: number): [number, number, number][] => {
    let pts: [number, number][] = [[ax, az], [bx, bz]];
    for (let d = 0; d < depth; d++) {
      const next: [number, number][] = [pts[0]!];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, z0] = pts[i]!, [x1, z1] = pts[i + 1]!;
        const l = Math.hypot(x1 - x0, z1 - z0) || 1;
        const off = (hash2(seed * 97 + salt, d * 64 + i) - 0.5) * l * 0.55;
        next.push([(x0 + x1) / 2 - (z1 - z0) / l * off, (z0 + z1) / 2 + (x1 - x0) / l * off], pts[i + 1]!);
      }
      pts = next;
    }
    // drape over the cloud crowns
    return pts.map(([x, z]) => [x, Math.sin(Math.min(1, Math.hypot(x, z)) * Math.PI) * 0.25, z]);
  };
  const main = jag(0, 0, 1, (hash2(seed, 3) - 0.5) * 0.3, 5, 0);
  strand(main, 0.045);
  for (const [at, salt] of [[0.35, 11], [0.6, 12]] as const) {
    const p = main[Math.floor(at * (main.length - 1))]!;
    const a = (hash2(seed, salt) - 0.5) * 1.6;
    strand(jag(p[0], p[2], p[0] + Math.cos(a) * 0.4, p[2] + Math.sin(a) * 0.4, 4, salt), 0.03);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  return g;
}

// ---------------------------------------------------------------- wind streaks
const STREAK_SEGS = 40;
/** Streaks per tile of lane length (a 64-tile lane carries ~38). */
const STREAKS_PER_TILE = 0.6;

/** Strip along u (uv.x 0..1) with two edge vertices (uv.y 0/1); the vertex shader lays it out on its lane. */
export function streakGeometry(): BufferGeometry {
  const uvs = new Float32Array((STREAK_SEGS + 1) * 4);
  const idx: number[] = [];
  for (let i = 0; i <= STREAK_SEGS; i++) {
    uvs.set([i / STREAK_SEGS, 0, i / STREAK_SEGS, 1], i * 4);
    if (i < STREAK_SEGS) idx.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array((STREAK_SEGS + 1) * 6), 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** Jet streaks and mist on a ghosted Sky (Orbit view, dives): halfway from the viewed paper to its ghost pencil. */
const GHOST_STROKE = mix(VIEW.paper, VIEW.ghostPencil, 0.5);

/**
 * Wind Waker wind trail, all on the GPU (Nathan Gordon's rebuild: a fixed curve, a moving visible window). Each
 * instance (`a` = seed, lateral offset, curl flag, period) respawns at a hashed spot along its lane every period,
 * draws its head forward along a gently waving path that may end in a loop, then its tail chases the head out.
 * `lane` = world origin xz + unit heading; `dims` = lane length, streak length, speed (tiles/s), height.
 */
function streakMaterial(a: Node<'vec4'>, lane: Node<'vec4'>, dims: Node<'vec4'>, motion: F1): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
  const seed = a.x, offset = a.y, curl = a.z, period = a.w;
  const len = dims.y, speed = dims.z;
  const cyc = clock.mul(motion).div(period).add(seed.mul(13.7));
  const ph = cyc.fract();
  const room = dims.x.sub(len).sub(speed.mul(period)).max(0);
  const along = cyc.floor().mul(0.618).add(seed.mul(7.13)).fract().mul(room).add(ph.mul(speed).mul(period));
  const head = smoothstep(0, 0.55, ph);
  const tail = smoothstep(0.4, 1, ph);
  // path point at u: distance along the lane and lateral offset; past C it may curl into a loop
  const C = 0.6;
  const R = len.mul(0.07);
  const turn = seed.mul(17.3).fract().greaterThan(0.5).select(float(1), float(-1));
  const path = (u: F1): Node<'vec2'> => {
    const th = u.sub(C).max(0).div(1 - C).mul(5.6);
    const looped = curl.greaterThan(0.5).and(u.greaterThan(C));
    const loopAlong = u.min(C).mul(len).add(sin(th).mul(R));
    const loopSide = sin(seed.mul(40).add(C * 4.2)).mul(0.22).add(float(1).sub(cos(th)).mul(R).mul(turn));
    return vec2(looped.select(loopAlong, u.mul(len)), looped.select(loopSide, sin(u.mul(4.2).add(seed.mul(40))).mul(0.22)));
  };
  const u = uv().x as F1;
  const p0 = path(u);
  const t = path(u.add(0.01) as F1).sub(p0).normalize();
  const vis = smoothstep(tail, tail.add(0.06), u).mul(float(1).sub(smoothstep(head.sub(0.06), head, u)));
  const taper = sin(u.sub(tail).div(head.sub(tail).max(1e-3)).clamp(0, 1).mul(Math.PI)).max(0).pow(0.6);
  // a steady on-screen width: thicker in world units as the camera pulls back
  const w = float(0.16).mul(LINE_DIST.div(30).clamp(1, 2.4)).mul(taper).mul(vis);
  const side = uv().y.mul(2).sub(1);
  const dir = lane.zw, perp = vec2(lane.w.negate(), lane.z);
  const at = lane.xy.add(dir.mul(along.add(p0.x))).add(perp.mul(offset.add(p0.y)));
  const xz = at.add(dir.mul(t.y.negate()).add(perp.mul(t.x)).mul(w.mul(side)));
  m.positionNode = vec3(xz.x, dims.w.add(sin(u.mul(3).add(seed.mul(9))).mul(0.12)), xz.y);
  const s = abs(side);
  const f = FADE.sky;
  m.colorNode = mix(GHOST_STROKE, mix(color('#ffffff'), color('#8fa4c4'), smoothstep(0.2, 1, s)), f.focus);
  m.opacityNode = float(1).sub(smoothstep(0.65, 1, s)).mul(vis).mul(0.95).mul(f.alpha).mul(f.focus.mul(0.7).add(0.3));
  return m;
}

// ---------------------------------------------------------------- fog mist
const SLICES = 8;
/** Mist quad half-size in cell radii (the billowing edge reaches past the radius). */
const MIST_SPAN = 1.3;

/**
 * Low layered mist: stacked horizontal slices of the baked noise, stretched into stratified wisps and scrolling at
 * slice-dependent speeds (parallax). Painted like a watercolour wash on the pale sky paper: a white body whose
 * pigment pools grey-blue toward its noise-broken edge (a backrun, not a contour); upper slices shrink, so the
 * bank reads as a low mound. `cell` = world centre xz, radius, slice index.
 */
function mistMaterial(cell: Node<'vec4'>, motion: F1): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
  const slice = cell.w.mul(3 / (SLICES - 1));
  const p = positionWorld.xz as Node<'vec2'>;
  const d = p.sub(cell.xy).length().div(cell.z.mul(float(1).sub(slice.mul(0.12))));
  const drift = vec2(clock.mul(motion).mul(0.018), clock.mul(motion).mul(0.005));
  const n1 = noise(p.mul(vec2(0.03, 0.06)).add(drift.mul(slice.add(1))).add(slice.mul(0.37)) as Node<'vec2'>).x;
  const n2 = noise(p.mul(vec2(0.08, 0.16)).sub(drift.mul(2)).add(slice.mul(0.71)) as Node<'vec2'>).y;
  const billow = n1.mul(0.65).add(n2.mul(0.35));
  const r = d.add(billow.sub(0.5).mul(0.8));
  const inside = float(1).sub(smoothstep(0.78, 1, r)).mul(float(1).sub(smoothstep(0.95, MIST_SPAN - 0.05, d)));
  const pooled = smoothstep(0.4, 0.95, r);
  const crest = smoothstep(0.5, 0.78, billow);
  const low = float(1).sub(slice.min(1));
  const f = FADE.sky;
  const body = mix(color('#dfe6ee'), color('#ffffff'), crest);
  m.colorNode = mix(GHOST_STROKE, mix(body, color('#93a1b6'), pooled.mul(mix(float(0.5), float(0.85), low))), f.focus);
  m.opacityNode = inside.mul(mix(float(0.42), float(0.7), pooled)).mul(mix(float(0.75), float(1), low)).mul(f.alpha).mul(f.focus.mul(0.7).add(0.3));
  return m;
}

// ---------------------------------------------------------------- the layer
const tmp = new Object3D();
/** Seeded storms grow in and shrink out over this many seconds. */
const SEED_GROW_S = 1.5;
/** Drawn share of a natural storm's radius and its opacity: a forecast gathers from GATHER to SEED, and the forming
 * storm grows on from SEED to full, so the public lifecycle draws one continuous, monotonic growth. */
const GATHER_SCALE = 0.22, SEED_SCALE = 0.4, GATHER_OPACITY = 0.08, SEED_OPACITY = 0.16;
/** Public seed warnings (`weather.seedWarnings`, schema cap 16): faint rim clouds that thicken until the storm forms. */
const WARN_CAP = 16;
/** Island openings, nearest the camera first (the Sky rings draw the same population). */
export const CUTAWAY_CAP = 16;
/** Visible non-island Sky openings (aircraft, structures, sighted contacts), nearest the camera first; each is a small
 * soft gap cut into the storm pass. */
export const UNIT_CAP = 96;
/** Radius (world units, × the unit's drawn scale) of an aircraft's storm opening: a clear core round its body, then
 * wisps dissolving back into the cloud (`StormClouds` holes). */
const UNIT_OPENING = 0.95;
/** Eight current + eight forecast natural cells, sixteen seeds and sixteen warnings. */
export const CELL_CAP = 4 * MAX_ARMIES + 16 + WARN_CAP;

/** Fixed-capacity nearest-first admission: the slot for a candidate at squared distance `d` among `count` admitted
 * (append while room, else replace the farthest if this one is nearer), or −1. No allocation. */
function nearest(distance: Float64Array, count: number, cap: number, d: number): number {
  if (count < cap) return count;
  let worst = 0;
  for (let i = 1; i < cap; i++) if (distance[i]! > distance[worst]!) worst = i;
  return d < distance[worst]! ? worst : -1;
}

interface IslandBounds {
  root: Object3D;
  mesh: Mesh;
  geometry: BufferGeometry;
  local: Box3;
  ore?: InstancedMesh;
  rootChildren: number;
}

export class WeatherLayer {
  // Object3D retains the Sky page's groupOrder; a nested Group would reset it and bury weather under the veil.
  readonly group = new Object3D();
  private weather: Weather | undefined;
  private match: WeatherMap | undefined;
  private readonly streaks: InstancedMesh;
  private readonly streakA: InstancedBufferAttribute;
  private readonly streakLane: InstancedBufferAttribute;
  private readonly streakDims: InstancedBufferAttribute;
  private lanesKey = '';
  private readonly mist: InstancedMesh;
  private readonly mistCell: InstancedBufferAttribute;
  /** Admitted island clearance ellipsoids (centre; axes), the first `islandCount` live. */
  readonly islands = Array.from({ length: CUTAWAY_CAP }, () => new Vector4());
  private readonly islandData = uniformArray<'vec4'>(this.islands, 'vec4');
  readonly islandAxes = Array.from({ length: CUTAWAY_CAP }, () => new Vector4(1, 1, 1, 0));
  private readonly axesData = uniformArray<'vec4'>(this.islandAxes, 'vec4');
  private readonly bounds = new WeakMap<Track, IslandBounds>();
  private readonly boxes = Array.from({ length: CUTAWAY_CAP }, () => new Box3());
  private readonly admitted = new Array<Track | undefined>(CUTAWAY_CAP).fill(undefined);
  private readonly attachmentGeometry = new WeakMap<Track, BufferGeometry>();
  private readonly scratchBox = new Box3();
  private readonly islandDistance = new Float64Array(CUTAWAY_CAP);
  readonly islandCount = uniform(0, 'int');
  /** Visible Sky aircraft openings (world x, y, z, radius), the first `unitCount` live. */
  readonly units = Array.from({ length: UNIT_CAP }, () => new Vector4());
  unitCount = 0;
  private readonly unitDistance = new Float64Array(UNIT_CAP);
  /** Only admitted visible tracks enter the arrays. */
  readonly cloudClearance = islandClearance(this.islandData, this.axesData, this.islandCount, positionWorld as V3, cameraPosition as V3);
  private readonly motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  private readonly motionScale = uniform(1);
  readonly cloudField: WeatherCloudField = {
    centres: Array.from({ length: CELL_CAP }, () => new Vector4()),
    states: Array.from({ length: CELL_CAP }, () => new Vector4()),
    strikes: Array.from({ length: CELL_CAP }, () => new Vector4()),
    count: 0, motion: 1,
  };
  /** Seeded storm slots: centre last seen (x, y) and the tick each appeared (NaN until its first frame). */
  private readonly seedAt = new Float64Array(32).fill(NaN);
  private readonly seedStart = new Float64Array(16).fill(NaN);
  /** Seed warning slots: centre and formation tick last seen (x, y, from) and the tick each appeared. */
  private readonly warnAt = new Float64Array(WARN_CAP * 3).fill(NaN);
  private readonly warnStart = new Float64Array(WARN_CAP).fill(NaN);
  private readonly point = { x: 0, y: 0 };
  private readonly sampled = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' as NaturalStorm['stage'] };
  private readonly streakCap: number;

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.streakCap = 2 * Math.ceil(size * 1.42 * STREAKS_PER_TILE);
    this.streakA = new InstancedBufferAttribute(new Float32Array(this.streakCap * 4), 4);
    this.streakLane = new InstancedBufferAttribute(new Float32Array(this.streakCap * 4), 4);
    this.streakDims = new InstancedBufferAttribute(new Float32Array(this.streakCap * 4), 4);
    const sm = streakMaterial(instancedDynamicBufferAttribute<'vec4'>(this.streakA, 'vec4'), instancedDynamicBufferAttribute<'vec4'>(this.streakLane, 'vec4'),
      instancedDynamicBufferAttribute<'vec4'>(this.streakDims, 'vec4'), this.motionScale);
    this.streaks = this.add(new InstancedMesh(streakGeometry(), sm, this.streakCap), 8);

    // One fog bank per army slot (`matchData.fogPaths` holds up to MAX_ARMIES), SLICES quads each.
    this.mistCell = new InstancedBufferAttribute(new Float32Array(MAX_ARMIES * SLICES * 4), 4).setUsage(DynamicDrawUsage);
    const mistGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.mist = this.add(new InstancedMesh(mistGeometry, mistMaterial(instancedDynamicBufferAttribute<'vec4'>(this.mistCell, 'vec4'), this.motionScale), MAX_ARMIES * SLICES), 7);
    this.mist.instanceMatrix.setUsage(DynamicDrawUsage);
  }

  private add(m: InstancedMesh, order: number): InstancedMesh {
    m.count = 0;
    m.frustumCulled = false;
    m.renderOrder = order;
    this.group.add(m);
    return m;
  }


  update(weather: Weather, match: WeatherMap): void {
    this.weather = weather;
    this.match = match;
    // seeded slots: a moved centre is a new storm
    for (let i = 0; i < 16; i++) {
      const c = weather.seeded[i];
      if (c && c.x === this.seedAt[i * 2] && c.y === this.seedAt[i * 2 + 1]) continue;
      this.seedAt[i * 2] = c ? c.x : NaN;
      this.seedAt[i * 2 + 1] = c ? c.y : NaN;
      this.seedStart[i] = NaN;
    }
    // warning slots: a moved centre or a new formation tick is a new telegraph
    for (let i = 0; i < WARN_CAP; i++) {
      const c = weather.seedWarnings[i];
      if (c && c.x === this.warnAt[i * 3] && c.y === this.warnAt[i * 3 + 1] && c.from === this.warnAt[i * 3 + 2]) continue;
      this.warnAt[i * 3] = c ? c.x : NaN;
      this.warnAt[i * 3 + 1] = c ? c.y : NaN;
      this.warnAt[i * 3 + 2] = c ? c.from : NaN;
      this.warnStart[i] = NaN;
    }
    this.lanes(match.jets);
  }

  /** Call after Entities.frame: use its exact interpolated drift/height, never the public island path.
   * The visibility gate is intentionally stricter than Track.visible (which only covers plane/state fading).
   * Removing a track or losing vision closes its hole immediately; no remembered owner/occupant data is read.
   * Islands open with their linked buildings; everything else the viewer currently sees on the Sky (aircraft,
   * standalone or unadmitted-island structures, contacts revealed by sight or scans) opens a small gap of its own.
   * A death this view's fog-filtered fx lists keeps its own opening while it plays (`deaths`: `DeathPlayer`), though
   * the dying body was the last eye on its cell: the record already proved the view may watch it.
   * With more candidates than slots, those nearest `eye` (the camera) win, so on-screen islands and aircraft keep
   * their openings however many distant ones the army sees. */
  cutaways(tracks: ReadonlyMap<string, Track> | undefined, models: Object3D, fogField?: FogField, eye?: Vector3, deaths?: Pick<DeathPlayer, 'collectOpenings' | 'openings' | 'openCount'>): void {
    let n = 0;
    this.unitCount = 0;
    if (tracks) for (const tr of tracks.values()) {
      // Linked buildings join their island's opening (second pass).
      if (tr.e.plane !== 'sky' || !tr.visible || (tr.e.link && footprint(tr.e.kind))) continue;
      if (fogField && !fogField.tileVisible('sky', tr.rx, tr.ry)) continue;
      const x = wx(tr.rx, this.size), z = wz(tr.ry, this.size);
      const d = eye ? (x - eye.x) ** 2 + (tr.wy - eye.y) ** 2 + (z - eye.z) ** 2 : 0;
      if (tr.e.kind !== 'island') {
        this.open(x, tr.wy, z, this.radius(tr), d);
        continue;
      }
      let bounds = this.bounds.get(tr);
      if (!bounds || bounds.root !== models || bounds.mesh.geometry !== bounds.geometry || !bounds.mesh.parent || bounds.rootChildren !== models.children.length) {
        // Look up only this admitted island's models, never all hidden scenery under the root.
        const mesh = models.getObjectByName(`island-terrain-${tr.e.id}`) as Mesh | undefined;
        if (!mesh?.geometry || !mesh.visible) continue;
        const geometry = mesh.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const local = geometry.boundingBox!.clone();
        const grove = models.getObjectByName(`island-grove-${tr.e.id}`);
        if (grove?.visible) for (const child of grove.children) {
          const trees = child as InstancedMesh;
          if (!trees.isInstancedMesh || !trees.visible) continue;
          if (!trees.boundingBox) trees.computeBoundingBox();
          local.union(trees.boundingBox!);
        }
        const ore = models.getObjectByName(`island-ore-${tr.e.id}`) as InstancedMesh | undefined;
        bounds = { root: models, mesh, geometry, local, ore, rootChildren: models.children.length };
        this.bounds.set(tr, bounds);
      }
      if (!bounds.mesh.visible) continue;
      const s = nearest(this.islandDistance, n, CUTAWAY_CAP, d);
      if (s < 0) continue;
      if (s === n) n++;
      tmp.position.set(x, tr.wy, z);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.setScalar(tr.scale);
      tmp.updateMatrix();
      const box = this.boxes[s]!.copy(bounds.local).applyMatrix4(tmp.matrix);
      const ore = bounds.ore;
      // Ore's live instanced bounds change only on disclosed depletion; its position follows the rendered island.
      if (ore?.parent && ore.visible && ore.count > 0 && ore.boundingBox) box.union(this.scratchBox.copy(ore.boundingBox).translate(ore.position));
      this.admitted[s] = tr;
      this.islandDistance[s] = d;
    }
    // A second pass covers only currently visible, explicitly linked buildings. No occupant/remembered lookup.
    if (tracks) for (const tr of tracks.values()) {
      if (!tr.e.link || !tr.visible || tr.e.plane !== 'sky' || !footprint(tr.e.kind)) continue;
      if (fogField && !fogField.tileVisible('sky', tr.rx, tr.ry)) continue;
      let joined = false;
      for (let i = 0; i < n; i++) {
        if (this.admitted[i]!.e.id !== tr.e.link) continue;
        let geometry = this.attachmentGeometry.get(tr);
        if (!geometry) {
          geometry = model(tr.e.kind);
          if (!geometry.boundingBox) geometry.computeBoundingBox();
          this.attachmentGeometry.set(tr, geometry);
        }
        tmp.position.set(wx(tr.rx, this.size), tr.wy, wz(tr.ry, this.size));
        tmp.rotation.set(0, tr.heading, 0);
        tmp.scale.setScalar(tr.scale);
        tmp.updateMatrix();
        this.boxes[i]!.union(this.scratchBox.copy(geometry.boundingBox!).applyMatrix4(tmp.matrix));
        joined = true;
        break;
      }
      // Its island holds no opening (out of slots or not drawn): the building still opens its own.
      if (!joined) {
        const x = wx(tr.rx, this.size), z = wz(tr.ry, this.size);
        this.open(x, tr.wy, z, this.radius(tr), eye ? (x - eye.x) ** 2 + (tr.wy - eye.y) ** 2 + (z - eye.z) ** 2 : 0);
      }
    }
    deaths?.collectOpenings();
    if (deaths) for (let i = 0; i < deaths.openCount; i++) {
      const o = deaths.openings[i]!;
      this.open(o.x, o.y, o.z, o.w, eye ? (o.x - eye.x) ** 2 + (o.y - eye.y) ** 2 + (o.z - eye.z) ** 2 : 0);
    }
    for (let i = 0; i < n; i++) {
      const box = this.boxes[i]!;
      this.islands[i]!.set((box.min.x + box.max.x) * 0.5, (box.min.y + box.max.y) * 0.5, (box.min.z + box.max.z) * 0.5, 0);
      this.islandAxes[i]!.set((box.max.x - box.min.x) * 0.65 + 0.25, (box.max.y - box.min.y) * 0.65 + 0.25,
        (box.max.z - box.min.z) * 0.65 + 0.25, 0);
    }
    for (let i = n; i < CUTAWAY_CAP; i++) this.admitted[i] = undefined;
    this.islandCount.value = n;
  }

  /** A non-island track's opening radius: aircraft by their drawn scale, structures by their footprint's half-diagonal. */
  private radius(tr: Track): number {
    const f = footprint(tr.e.kind);
    return f ? Math.hypot(f.w, f.h) * 0.55 : UNIT_OPENING * tr.scale;
  }

  /** A small opening (nearest the camera first) of radius `r` at world (x, y, z), squared camera distance `d`. */
  private open(x: number, y: number, z: number, r: number, d: number): void {
    const s = nearest(this.unitDistance, this.unitCount, UNIT_CAP, d);
    if (s < 0) return;
    if (s === this.unitCount) this.unitCount++;
    this.units[s]!.set(x, y, z, r);
    this.unitDistance[s] = d;
  }

  /** Streak instances along each lane (lanes are fixed for a match: rebuilt only when they change). */
  private lanes(jets: MatchData['jets']): void {
    let key = '';
    for (const l of jets) key += `${l.x1},${l.y1},${l.x2},${l.y2},${l.width};`;
    if (key === this.lanesKey) return;
    this.lanesKey = key;
    let n = 0;
    for (let j = 0; j < jets.length; j++) {
      const l = jets[j]!;
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
      const count = Math.min(this.streakCap - n, Math.round(len * STREAKS_PER_TILE));
      for (let i = 0; i < count; i++, n++) {
        const h = (salt: number) => hash2(j * 997 + i, salt);
        this.streakA.setXYZW(n, h(51), (h(52) * 2 - 1) * l.width * 0.85, h(53) < 0.45 ? 1 : 0, 2.4 + h(54) * 1.4);
        this.streakLane.setXYZW(n, wx(l.x1, this.size), wz(l.y1, this.size), l.dx, l.dy);
        this.streakDims.setXYZW(n, len, 6 + h(55) * 5, 3.2 + h(56) * 1.2, PLANE_Y.sky + 1.7 + h(57) * 1.3);
      }
    }
    this.streaks.count = n;
    this.streakA.needsUpdate = this.streakLane.needsUpdate = this.streakDims.needsUpdate = true;
  }

  /** One public storm's cloud field cell: its hurricane drawn at `scale` of radius `r` with lifecycle `opacity`. */
  private storm(id: number, x: number, y: number, r: number, scale: number, opacity: number, s: number, stage: NaturalStorm['stage'] | 'seeded' | 'warning'): void {
    if (this.cloudField.count >= CELL_CAP) return;
    const f = this.cloudField.motion && (stage === 'mature' || stage === 'seeded') ? flashAt(s, id) * opacity : 0;
    const slot = Math.floor(s / FLASH_SLOT + hash2(id, 101));
    const strike = hash2(id * 13 + 5, slot) * Math.PI * 2;
    const sx = x + Math.cos(strike) * r * scale * 0.6, sy = y + Math.sin(strike) * r * scale * 0.6;
    const n = this.cloudField.count++;
    this.cloudField.centres[n]!.set(wx(x, this.size), PLANE_Y.sky - MOORING_DEPTH - 1.4, wz(y, this.size), r * scale);
    this.cloudField.states[n]!.set(opacity, f, id * 1.618, stage === 'forecast' || stage === 'warning' ? 0 : 1);
    this.cloudField.strikes[n]!.set(wx(sx, this.size), wz(sy, this.size), strike, f < 0.02 || opacity < 0.5 ? 0 : f);
  }

  /** One continuous, monotonic public lifecycle, a pure function of the storm's own start/grown/breaking/end ticks:
   * a forecast gathers up to the formation seed size and opacity, a forming storm grows on from exactly there
   * (never again from nothing), a mature storm holds, a breaking one shrinks and fades out. */
  private natural(c: NaturalStorm, tick: number, s: number): void {
    if (tick >= c.end || c.maxRadius <= 0) return;
    sampleStorm(c, tick, this.sampled, 0, this.size);
    const p = this.sampled, k = p.strength;
    if (p.stage === 'forecast') {
      const g = gathering(c, tick);
      this.storm(c.id, p.x, p.y, c.maxRadius, GATHER_SCALE + (SEED_SCALE - GATHER_SCALE) * g, GATHER_OPACITY + (SEED_OPACITY - GATHER_OPACITY) * g, s, p.stage);
    } else if (p.stage === 'forming') {
      this.storm(c.id, p.x, p.y, c.maxRadius, SEED_SCALE + (1 - SEED_SCALE) * k, SEED_OPACITY + (1 - SEED_OPACITY) * k, s, p.stage);
    } else if (k > 0) this.storm(c.id, p.x, p.y, c.maxRadius, k, k * k, s, p.stage);
  }

  frame(tick: number): void {
    const w = this.weather;
    this.cloudField.count = 0;
    if (!w) return;
    const s = tick / TICK_RATE;
    this.motionScale.value = this.cloudField.motion = this.motion?.matches ? 0 : 1;
    for (const c of w.storms) this.natural(c, tick, s);
    for (const c of w.forecast) this.natural(c, tick, s);
    for (let i = 0; i < w.seeded.length; i++) {
      const c = w.seeded[i]!;
      if (tick >= c.until || c.radius <= 0) continue;
      if (Number.isNaN(this.seedStart[i]!)) this.seedStart[i] = tick;
      const g = SEED_GROW_S * TICK_RATE;
      // Seeds fade in and out at their full public extent.
      const grow = Math.min(1, (tick - this.seedStart[i]!) / g, (c.until - tick) / g);
      if (grow > 0.02) this.storm(4 + i, c.x, c.y, c.radius, 1, grow, s, 'seeded');
    }
    for (let i = 0; i < w.seedWarnings.length && i < WARN_CAP; i++) {
      const c = w.seedWarnings[i]!;
      if (tick >= c.from || c.radius <= 0) continue;
      if (Number.isNaN(this.warnStart[i]!)) this.warnStart[i] = tick;
      // share of the telegraph elapsed since this client first saw it; a slow pulse marks it as a warning
      const t = Math.min(1, Math.max(0, (tick - this.warnStart[i]!) / Math.max(1, c.from - this.warnStart[i]!)));
      const pulse = 0.8 + 0.2 * Math.sin(s * 5) * this.cloudField.motion;
      this.storm(20 + i, c.x, c.y, c.radius, 1, (0.12 + t * 0.2) * pulse, s, 'warning');
    }

    let n = 0;
    for (let i = 0; i < w.fog.length; i++) {
      const c = w.fog[i]!;
      weatherAt(this.match!.fogPaths[i]!, tick, this.point, this.size);
      for (let j = 0; j < SLICES; j++, n++) {
        tmp.position.set(wx(this.point.x, this.size), PLANE_Y.sky - MOORING_DEPTH + 0.3 + j * (MOORING_DEPTH + 1.8) / (SLICES - 1), wz(this.point.y, this.size));
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(c.radius * MIST_SPAN * 2, 1, c.radius * MIST_SPAN * 2);
        tmp.updateMatrix();
        this.mist.setMatrixAt(n, tmp.matrix);
        this.mistCell.setXYZW(n, wx(this.point.x, this.size), wz(this.point.y, this.size), c.radius, j);
      }
    }
    this.mist.count = n;
    this.mist.instanceMatrix.needsUpdate = true;
    this.mistCell.needsUpdate = true;
  }

  /** Layer-owned carriers/materials only; the shared baked noise remains owned by materials.ts. */
  dispose(): void {
    for (const child of this.group.children) {
      const mesh = child as InstancedMesh;
      mesh.geometry.dispose();
      (mesh.material as MeshBasicNodeMaterial).dispose();
      mesh.dispose();
    }
    this.group.clear();
    this.group.removeFromParent();
  }
}
