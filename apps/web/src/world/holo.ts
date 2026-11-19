/**
 * The holo lens: another plane's content drawn superimposed in place on the viewing plane, as a projected-light
 * hologram (a Princess-Leia transmission in each plane's accent, not sci-fi noise). Every cross-plane view uses it: the
 * held Y peek, drops from Orbit, the O cross-plane attack (bombers down, flak, turrets and the Spire up, the Lancer Lens)
 * and Depths strikes aimed up. Tools fill a `Lens` (tools/lens.ts: source, stacked planes, focus, radius); this draws it.
 *
 * Each stacked plane is one flat layer compressed onto the viewing plane (true x/y, `holoY` height), so the main
 * perspective camera draws, projects and picks it aligned with the world: no second scene render, no render target.
 * A layer is a map quad tinted from a per-cell texture (terrain codes, the team's known Depths cells) and one instanced
 * draw of simplified silhouettes (units, structures, islands, last-seen structure ghosts) in army colours with an HP arc.
 * Opacity and detail fall off radially from the foci (cursor, aimed rock) with no rim; deeper layers are fainter and
 * more scanlined; slow scanlines, a faint flicker and a rare glitch line drift through it unless motion is reduced.
 *
 * Fog-safe: terrain shading and silhouettes come only from the team's view (fogged entities, `memory`, known cells) and
 * the fog field; unknown ground is hatched, storms in the Sky obscure it and what lies beneath.
 */
import {
  AdditiveBlending, DataTexture, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Mesh,
  MeshBasicNodeMaterial, NearestFilter, PlaneGeometry, RGBAFormat, UnsignedByteType, Vector3, type Node,
} from 'three/webgpu';
import {
  abs, atan, color, float, fract, instancedDynamicBufferAttribute, length, max, mix, positionGeometry, positionWorld,
  screenCoordinate, screenUV, sin, smoothstep, step, texture, uniform, uv, vec2, vec3,
} from 'three/tsl';
import { CELL, PLANES, STATS, SURFACE, TICK_RATE, footprint, surfaceFeature, type Entity, type Plane, type View } from '@agent-command/game/contract';
import { sampleStorm, type NaturalStorm } from '@agent-command/game/weather';
import { HOLO_ELEVATION_SCALE, type Lens } from '../tools/lens.ts';
import { PLANE_ACCENT } from '../dom.ts';
import { icon } from '../icons.ts';
import { reducedMotion } from '../motion.ts';
import { sideColor } from './common.ts';
import type { Track } from './entities.ts';
import { mapUV, type FogField } from './fog.ts';
import { clock, lines, overlay, type F1, type V3 } from './materials.ts';
import type { TerrainField } from './terrain.ts';

const LENS_OPEN_S = 0.16;
/** Silhouettes per layer (one instanced draw each). */
export const HOLO_MARKERS = 192;
/** Active storms that obscure the Sky layer (and what lies under it). */
export const HOLO_STORMS = 6;
/** Silhouette quad margin around the shape: room for the glow. */
const MARGIN = 1.45;
/** Smallest silhouette half-size (tiles): unit bodies stay readable at Orbit camera distances. */
const MIN_HALF = 0.55;
/** Glyph flags (packed into a float). */
export const HOLO_GHOST = 1;
export const HOLO_THREAT = 2;
export const HOLO_FRIENDLY = 4;
export const HOLO_HOVER = 8;
export const HOLO_ORE = 16;
/** Glyph shapes. */
export const SHAPE_UNIT = 0;
export const SHAPE_STRUCTURE = 1;
export const SHAPE_ISLAND = 2;

/**
 * Falloff of the hologram at distance `d` (tiles) from a focus, `radius` its reach: 1 at the focus, smoothly to 0 at
 * the edge with no rim. The shader computes the same curve; markers are culled with it.
 */
export function holoFalloff(d: number, radius: number): number {
  if (!(radius > 0)) return 0;
  const t = Math.min(1, Math.max(0, d / radius));
  const s = 1 - t * t * (3 - 2 * t);
  return s * Math.sqrt(s);
}

/** Per-cell light level (0..1) of Surface terrain on the hologram: water dark, plateaus and cliffs bright. */
export const SURFACE_LEVEL: Readonly<Record<number, number>> = {
  [SURFACE.water]: 0.1, [SURFACE.ford]: 0.26, [SURFACE.ground]: 0.36, [SURFACE.forest]: 0.46,
  [SURFACE.high]: 0.64, [SURFACE.cliff]: 0.86, [SURFACE.fault]: 0.95,
  [SURFACE.highForest]: 0.68, [SURFACE.highFord]: 0.48, [SURFACE.highWater]: 0.32, [SURFACE.highFault]: 1,
};
/** Per-cell level of the team's known Depths cells (unknown cells are hatched instead). */
export const DEPTHS_LEVEL: Readonly<Record<number, number>> = {
  [CELL.unknown]: 0, [CELL.bedrock]: 0.05, [CELL.rock]: 0.2, [CELL.fortified]: 0.36, [CELL.ore]: 0.55,
  [CELL.tunnel]: 0.62, [CELL.rail]: 0.8, [CELL.lode]: 0.9, [CELL.magma]: 0.95,
  // green rich ore brighter than ore, a bridge deck between tunnel and rail, a lava lake as bright as a flood
  [CELL.rich]: 0.68, [CELL.bridge]: 0.74, [CELL.lake]: 0.95,
};

/**
 * Fill a plane's tint texels (RGBA per cell, row = map y): R light level, G the code (edges are code changes), B a
 * forest/canopy hatch flag, A 255 where the team does not know the cell (Depths unknown).
 */
export function fillTint(out: Uint8Array, codes: ArrayLike<number>, levels: Readonly<Record<number, number>>, plane: Plane): void {
  for (let c = 0; c < codes.length; c++) {
    const code = codes[c]!;
    const o = c * 4;
    out[o] = Math.round((levels[code] ?? 0.3) * 255);
    out[o + 1] = (code * 23) & 255;
    out[o + 2] = plane === 'surface' && surfaceFeature(code) === SURFACE.forest ? 255 : 0;
    out[o + 3] = plane === 'depths' && code === CELL.unknown ? 255 : 0;
  }
}

/** One layer's silhouettes, filled from the team's view on every frame into preallocated instance data. */
export interface GlyphBuffers {
  /** x, z (world), half width, half depth (tiles) */
  readonly a: Float32Array;
  /** army colour rgb, HP fraction (islands: disclosed ore fraction; -1: no bar) */
  readonly b: Float32Array;
  /** shape, flags, alpha, compressed authoritative elevation */
  readonly c: Float32Array;
  count: number;
}
export const glyphBuffers = (cap = HOLO_MARKERS): GlyphBuffers => ({ a: new Float32Array(cap * 4), b: new Float32Array(cap * 4), c: new Float32Array(cap * 4), count: 0 });

export interface HoloFocus { x: number; y: number; radius: number; x2: number; y2: number; two: boolean }

const inRegion = (f: HoloFocus, x: number, y: number, margin: number): boolean =>
  Math.hypot(x - f.x, y - f.y) <= f.radius + margin || (f.two && Math.hypot(x - f.x2, y - f.y2) <= f.radius + margin);

function push(out: GlyphBuffers, size: number, x: number, y: number, hw: number, hd: number, side: Entity['side'], hp: number, shape: number, flags: number, alpha: number, elevation = 0): void {
  if (out.count * 4 >= out.a.length) return;
  const end = out.count++ * 4;
  const height = Math.fround(elevation * HOLO_ELEVATION_SCALE);
  // Glyphs are translucent and depthTest:false: stable lower-to-upper ordering makes their visible
  // overlap agree with picking. Equal-height order is unchanged; ordinary layers take the O(1) path.
  let i = end;
  while (i > 0 && out.c[i - 1]! > height) i -= 4;
  if (i !== end) {
    out.a.copyWithin(i + 4, i, end);
    out.b.copyWithin(i + 4, i, end);
    out.c.copyWithin(i + 4, i, end);
  }
  const col = sideColor(side);
  out.a[i] = x - size / 2; out.a[i + 1] = y - size / 2; out.a[i + 2] = hw; out.a[i + 3] = hd;
  out.b[i] = col.r; out.b[i + 1] = col.g; out.b[i + 2] = col.b; out.b[i + 3] = hp;
  out.c[i] = shape; out.c[i + 1] = flags; out.c[i + 2] = alpha; out.c[i + 3] = height;
}

/**
 * The silhouettes of `plane` inside the focus region: every entity of the current fogged view on that plane (at its
 * interpolated track position when one is drawn), then remembered structures the view no longer shows as ghosts.
 * Nothing else: no hidden entity reaches the hologram. `flag(id)` marks threats, friendly fire and the hovered pick.
 */
export function fillGlyphs(out: GlyphBuffers, view: View, tracks: ReadonlyMap<string, Track>, plane: Plane, focus: HoloFocus, size: number, islandRadius: number, flag: (id: string) => number): void {
  out.count = 0;
  for (const e of view.entities) {
    if (e.plane !== plane || e.state === 'falling' || e.state === 'hangared' || e.state === 'launching') continue;
    const tr = tracks.get(e.id);
    const x = tr ? tr.rx : e.x, y = tr ? tr.ry : e.y;
    const island = e.kind === 'island';
    const f = island ? undefined : footprint(e.kind);
    const reach = island ? islandRadius : f ? Math.max(f.w, f.h) / 2 : 0.6;
    if (!inRegion(focus, x, y, reach)) continue;
    const ore = island && (e.oreCapacity ?? 0) > 0;
    const hp = ore ? e.oreRemaining === undefined ? -1 : Math.max(0, Math.min(1, e.oreRemaining / e.oreCapacity!))
      : e.maxHp > 0 && !island ? e.hp / e.maxHp : -1;
    const elevation = tr?.elevation ?? e.elevation ?? 0;
    if (island) push(out, size, x, y, islandRadius, islandRadius, e.side, hp, SHAPE_ISLAND, flag(e.id) | (ore ? HOLO_ORE : 0), 0.75, elevation);
    else if (f) push(out, size, x, y, f.w / 2, f.h / 2, e.side, hp, SHAPE_STRUCTURE, flag(e.id), 1, elevation);
    else {
      const r = Math.max(MIN_HALF, STATS[e.kind as keyof typeof STATS]?.radius ?? 0.4);
      push(out, size, x, y, r, r, e.side, hp, SHAPE_UNIT, flag(e.id), 1, elevation);
    }
  }
  for (const g of view.memory) {
    if (g.plane !== plane || tracks.get(g.id)?.visible) continue;
    const f = footprint(g.kind);
    if (!f || !inRegion(focus, g.x, g.y, Math.max(f.w, f.h) / 2)) continue;
    push(out, size, g.x, g.y, f.w / 2, f.h / 2, g.side, -1, SHAPE_STRUCTURE, HOLO_GHOST | flag(g.id), 0.55, g.elevation ?? 0);
  }
}

/** Shared shader inputs: foci, falloff radius, opening, motion and the Sky's storms. */
const U = {
  f0: uniform(new Vector3(0, 0, 1)),
  f1: uniform(new Vector3(0, 0, 0)),
  radius: uniform(6),
  open: uniform(0),
  motion: uniform(1),
  storms: Array.from({ length: HOLO_STORMS }, () => uniform(new Vector3(0, 0, 0))),
};
interface PlaneUniforms { depth: Node<'float'> & { value: number }; storm: Node<'float'> & { value: number } }

/** Radial falloff of this fragment from the nearer focus (world x/z), times the opening. */
function falloff(): F1 {
  const p = positionWorld.xz;
  const k = (f: typeof U.f0): F1 => {
    const t = length(p.sub(vec2(f.x, f.y))).div(U.radius).clamp(0, 1);
    const s = float(1).sub(t.mul(t).mul(float(3).sub(t.mul(2))));
    return s.mul(s.sqrt()).mul(f.z) as F1;
  };
  return max(k(U.f0), k(U.f1)).mul(U.open) as F1;
}
/** Storm cover (0..1) of this fragment: the public storms' discs, soft-edged. */
function stormCover(): F1 {
  const p = positionWorld.xz;
  let s: F1 = float(0) as F1;
  for (const c of U.storms) s = max(s, float(1).sub(smoothstep(c.z.mul(0.7), c.z, length(p.sub(vec2(c.x, c.y))))).mul(step(0.01, c.z))) as F1;
  return s;
}
/** Scanlines drifting down the screen, flicker and a rare glitch band; `depth` deepens the scanlines. */
function transmission(depth: F1): F1 {
  const scan = sin(screenCoordinate.y.mul(1.9).sub(clock.mul(U.motion).mul(3))).mul(0.5).add(0.5);
  const lines_ = float(1).sub(scan.mul(mix(float(0.18), float(0.42), depth)));
  const flicker = float(1).sub(U.motion.mul(sin(clock.mul(23)).mul(0.035).add(sin(clock.mul(7.3)).mul(0.025))));
  const glitch = float(1).sub(smoothstep(0.0, 0.006, abs(screenUV.y.sub(fract(clock.mul(0.21)))))).mul(step(fract(clock.mul(0.53)), 0.05)).mul(U.motion);
  return lines_.mul(flicker).add(glitch.mul(0.6)) as F1;
}

function fieldMaterial(plane: Plane, tint: DataTexture, size: number, fog: FogField | undefined, u: PlaneUniforms): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide, depthTest: false, blending: AdditiveBlending }));
  const accent = color(PLANE_ACCENT[plane]) as unknown as V3;
  const cell = float(1 / size);
  const at = mapUV();
  const t = texture(tint, at);
  const g = t.g;
  const edge = max(max(abs(texture(tint, at.add(vec2(cell, 0))).g.sub(g)), abs(texture(tint, at.add(vec2(0, cell))).g.sub(g))),
    max(abs(texture(tint, at.sub(vec2(cell, 0))).g.sub(g)), abs(texture(tint, at.sub(vec2(0, cell))).g.sub(g)))).greaterThan(0.01).select(float(1), float(0));
  const fv = fog ? fog.fogAt(plane, 0.15) : vec2(1, 1);
  const vis = smoothstep(0.3, 0.7, fv.x);
  const unknown = max(float(1).sub(smoothstep(0.3, 0.7, fv.y)), t.a);
  const p = positionWorld.xz;
  const hatchInk = lines(p.x.add(p.y).mul(1.4) as F1, 0.14);
  const canopy = lines(p.x.sub(p.y).mul(2.6) as F1, 0.1).mul(t.b);
  const light = mix(t.r.mul(mix(float(0.55), float(1), vis)).add(edge.mul(0.75)).add(canopy.mul(0.25)), hatchInk.mul(0.35), unknown);
  const storm = stormCover().mul(u.storm);
  const shown = mix(light, lines(p.x.sub(p.y).mul(0.9) as F1, 0.22).mul(0.3), storm);
  m.colorNode = mix(accent.mul(0.18), mix(accent, vec3(0.92, 1, 1), edge.mul(float(1).sub(unknown)).mul(float(1).sub(storm)).mul(0.5)), shown.clamp(0, 1));
  m.opacityNode = falloff().mul(mix(float(0.78), float(0.42), u.depth)).mul(transmission(u.depth)).mul(shown.mul(0.7).add(0.3));
  return m;
}

function glyphMaterial(plane: Plane, attrs: { a: InstancedBufferAttribute; b: InstancedBufferAttribute; c: InstancedBufferAttribute }, u: PlaneUniforms): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide, depthTest: false }));
  const a = instancedDynamicBufferAttribute<'vec4'>(attrs.a, 'vec4');
  const b = instancedDynamicBufferAttribute<'vec4'>(attrs.b, 'vec4');
  const c = instancedDynamicBufferAttribute<'vec4'>(attrs.c, 'vec4');
  m.positionNode = vec3(a.x.add(positionGeometry.x.mul(a.z).mul(2 * MARGIN)), c.w, a.y.add(positionGeometry.z.mul(a.w).mul(2 * MARGIN)));
  const q = uv().mul(2).sub(1).mul(MARGIN);
  const shape = c.x, flags = c.y;
  const d = shape.lessThan(0.5).select(length(q), shape.lessThan(1.5).select(max(abs(q.x), abs(q.y)), length(q)));
  const inside = float(1).sub(smoothstep(0.93, 1.0, d));
  const rim = smoothstep(0.8, 0.88, d).mul(inside);
  const glow = float(1).sub(smoothstep(1.0, MARGIN, d)).mul(float(1).sub(inside));
  const ghost = fract(flags.mul(0.5)).greaterThan(0.25).select(float(1), float(0));
  const threat = fract(flags.div(4)).greaterThanEqual(0.5).select(float(1), float(0));
  const friendly = fract(flags.div(8)).greaterThanEqual(0.5).select(float(1), float(0));
  const hover = fract(flags.div(16)).greaterThanEqual(0.5).select(float(1), float(0));
  const ore = fract(flags.div(32)).greaterThanEqual(0.5).select(float(1), float(0));
  const mineral = float(1).sub(smoothstep(0.25, 0.32, abs(q.x).add(abs(q.y)))).mul(ore);
  const angle = atan(q.y, q.x).div(Math.PI * 2).add(0.5);
  const band = smoothstep(0.62, 0.66, d).mul(float(1).sub(smoothstep(0.74, 0.78, d))).mul(step(0, b.w));
  const lit = step(angle, b.w);
  const pulse = sin(clock.mul(U.motion).mul(6)).mul(0.25).add(0.75);
  const halo = smoothstep(1.02, 1.1, d).mul(float(1).sub(smoothstep(1.28, 1.4, d)));
  const accent = color(PLANE_ACCENT[plane]) as unknown as V3;
  const island = shape.greaterThan(1.5).select(float(1), float(0));
  const fill = mix(b.xyz, accent, mix(float(0.3), float(0.75), ghost.max(island)));
  const ink = vec3(0.05, 0.08, 0.1);
  let col = mix(fill, ink, rim) as V3;
  col = mix(col, color('#b8d7c5') as unknown as V3, mineral) as V3;
  col = mix(col, mix(vec3(0.35, 0.45, 0.4), vec3(0.85, 1, 0.9), lit), band) as V3;
  col = mix(col, accent.mul(1.4), glow) as V3;
  col = mix(col, color('#ffb02e') as unknown as V3, halo.mul(threat)) as V3;
  col = mix(col, color('#ff4a3a') as unknown as V3, halo.mul(friendly)) as V3;
  col = mix(col, vec3(1, 1, 1), halo.mul(hover)) as V3;
  m.colorNode = col;
  const body = inside.mul(mix(float(1), mix(float(0.22), float(0.32), rim), max(ghost, island.mul(float(1).sub(rim)))));
  const ring = halo.mul(max(threat, max(friendly, hover))).mul(pulse);
  m.opacityNode = max(body.add(glow.mul(0.4)).add(mineral.mul(0.65)), ring).mul(c.z).mul(falloff()).mul(mix(float(1), float(0.6), u.depth)).mul(transmission(u.depth)).mul(float(1).sub(stormCover().mul(u.storm))).clamp(0, 1);
  return m;
}

interface Slot {
  field: Mesh;
  glyphs: InstancedMesh;
  data: GlyphBuffers;
  attrs: { a: InstancedBufferAttribute; b: InstancedBufferAttribute; c: InstancedBufferAttribute };
  materials: Record<Plane, { field: MeshBasicNodeMaterial; glyphs: MeshBasicNodeMaterial }>;
}

const STORM = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' as NaturalStorm['stage'] };

export class HoloLens {
  readonly root = new Group();
  readonly size: number;
  private readonly slots: Slot[] = [];
  private readonly tint: Record<Plane, DataTexture>;
  private readonly planeU: Record<Plane, PlaneUniforms>;
  private readonly focus: HoloFocus = { x: 0, y: 0, radius: 6, x2: 0, y2: 0, two: false };
  private state?: Lens;
  private open = 0;
  private openAt = 0;
  private match?: View['match'];
  private depthsTick = -1;
  private readonly flagged = (id: string): number => this.flagOf(id);
  private tag?: HTMLElement;
  private readonly tags: SVGSVGElement[] = [];
  private tagPlane?: Plane;
  private tagX = NaN;
  private tagY = NaN;
  private tagScale = NaN;
  private readonly terrain?: TerrainField;

  constructor(size: number, terrain?: TerrainField, fog?: FogField) {
    this.size = size;
    this.terrain = terrain;
    this.root.name = 'holo-lens';
    this.root.renderOrder = 35;
    this.root.visible = false;
    const texel = (): DataTexture => {
      const t = new DataTexture(new Uint8Array(size * size * 4), size, size, RGBAFormat, UnsignedByteType);
      t.magFilter = t.minFilter = NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    this.tint = { depths: texel(), surface: texel(), sky: texel(), orbit: texel() };
    for (const p of ['sky', 'orbit'] as const) {
      const data = this.tint[p].image.data as Uint8Array;
      for (let i = 0; i < size * size; i++) data[i * 4] = 20;
    }
    this.planeU = Object.fromEntries(PLANES.map((p) => [p, { depth: uniform(0), storm: uniform(0) }])) as unknown as Record<Plane, PlaneUniforms>;
    const quad = new PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    const glyph = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const data = glyphBuffers();
      const attrs = {
        a: new InstancedBufferAttribute(data.a, 4).setUsage(DynamicDrawUsage),
        b: new InstancedBufferAttribute(data.b, 4).setUsage(DynamicDrawUsage),
        c: new InstancedBufferAttribute(data.c, 4).setUsage(DynamicDrawUsage),
      };
      const materials = Object.fromEntries(PLANES.map((p) => [p, {
        field: fieldMaterial(p, this.tint[p], size, fog, this.planeU[p]),
        glyphs: glyphMaterial(p, attrs, this.planeU[p]),
      }])) as Slot['materials'];
      const field = new Mesh(quad, materials.surface.field);
      const glyphs = new InstancedMesh(glyph, materials.surface.glyphs, HOLO_MARKERS);
      glyphs.count = 0;
      for (const o of [field, glyphs]) { o.frustumCulled = false; o.visible = false; }
      // Plane layers precede this group; current-plane units follow it, above the projected light.
      field.renderOrder = 200 + i * 2;
      glyphs.renderOrder = 201 + i * 2;
      this.root.add(field, glyphs);
      this.slots.push({ field, glyphs, data, attrs, materials });
    }
  }

  /** The lens the overlay draws its forecast over, while it is on screen. */
  get scope(): Lens | undefined { return this.root.visible && this.state?.active ? this.state : undefined; }
  /** Eased open/close progress (0 shut, 1 open). */
  get openness(): number { return this.open * this.open * (3 - 2 * this.open); }

  show(state?: Lens): void {
    if (state?.active && !this.state?.active) U.motion.value = reducedMotion() ? 0 : 1;
    this.state = state;
  }

  private flagOf(id: string): number {
    const s = this.state;
    if (!s) return 0;
    let f = s.hovered === id ? HOLO_HOVER : 0;
    if (s.drop.active) {
      if (s.drop.threats.includes(id)) f |= HOLO_THREAT;
      if (s.drop.friendly.includes(id)) f |= HOLO_FRIENDLY;
    }
    return f;
  }

  /** Terrain tints from the match's Surface codes and the team's known Depths cells (on change, never per frame). */
  private ingestTint(view: View): void {
    if (view.match !== this.match && this.terrain) {
      fillTint(this.tint.surface.image.data as Uint8Array, this.terrain.terrainCodes, SURFACE_LEVEL, 'surface');
      this.tint.surface.needsUpdate = true;
      this.match = view.match;
    }
    if (this.depthsTick !== view.tick && this.state?.stack.includes('depths') && view.depths.length === this.size * this.size) {
      fillTint(this.tint.depths.image.data as Uint8Array, view.depths, DEPTHS_LEVEL, 'depths');
      this.tint.depths.needsUpdate = true;
      this.depthsTick = view.tick;
    }
  }

  /** Once per frame, after the entities interpolate. */
  frame(view: View | undefined, tracks: ReadonlyMap<string, Track>, focusPlane: Plane, renderTick: number, now: number): void {
    const s = this.state;
    const wanted = !!view && !!s?.active && s.source === focusPlane && s.stack.length > 0;
    const dt = this.openAt ? Math.min(0.1, (now - this.openAt) / 1000) : 0;
    this.openAt = now;
    this.open = Math.max(0, Math.min(1, this.open + (wanted ? dt : -dt) / LENS_OPEN_S));
    U.open.value = this.openness;
    this.root.visible = this.open > 0;
    if (this.tag) this.tag.style.display = wanted ? 'grid' : 'none';
    if (!wanted || !s || !view) return;
    this.ingestTint(view);
    const f = this.focus;
    f.x = s.x; f.y = s.y; f.radius = s.radius;
    f.two = s.drop.active && s.drop.count > 0;
    f.x2 = f.two ? s.drop.from[0]! : f.x;
    f.y2 = f.two ? s.drop.from[1]! : f.y;
    U.f0.value.set(f.x - this.size / 2, f.y - this.size / 2, 1);
    U.f1.value.set(f.x2 - this.size / 2, f.y2 - this.size / 2, f.two ? 1 : 0);
    U.radius.value = f.radius;
    this.storms(view, renderTick);
    const islandRadius = view.match?.rules.sky.islandRadius ?? 0;
    const sky = s.stack.indexOf('sky');
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      const plane = s.stack[i];
      slot.field.visible = slot.glyphs.visible = !!plane;
      if (!plane) continue;
      const u = this.planeU[plane];
      u.depth.value = s.stack.length > 1 ? i / (s.stack.length - 1) : 0;
      // Storms are weather of the Sky: they cover its layer and, seen from above, what lies beneath it.
      u.storm.value = sky >= 0 && i >= sky && s.down ? 1 : plane === 'sky' ? 1 : 0;
      const m = slot.materials[plane];
      slot.field.material = m.field;
      slot.glyphs.material = m.glyphs;
      const y = s.layerY(plane);
      slot.field.position.y = slot.glyphs.position.y = y;
      fillGlyphs(slot.data, view, tracks, plane, f, this.size, islandRadius, this.flagged);
      slot.glyphs.count = slot.data.count;
      slot.attrs.a.needsUpdate = slot.attrs.b.needsUpdate = slot.attrs.c.needsUpdate = true;
    }
    this.updateTag(s);
  }

  /** The public storms on screen now (natural and seeded), into the shader's fixed slots. */
  private storms(view: View, tick: number): void {
    let n = 0;
    const half = this.size / 2;
    for (const c of view.weather.storms) {
      if (n >= HOLO_STORMS) break;
      if (tick < c.start || tick >= c.end) continue;
      sampleStorm(c, tick, STORM, 0, this.size);
      U.storms[n++]!.value.set(STORM.x - half, STORM.y - half, STORM.radius);
    }
    for (const c of view.weather.seeded) if (n < HOLO_STORMS && tick < c.until) U.storms[n++]!.value.set(c.x - half, c.y - half, c.radius);
    for (; n < HOLO_STORMS; n++) U.storms[n]!.value.set(0, 0, 0);
  }

  /** DOM tag naming the nearest plane shown, at the top of the region; built once, moved only when it changes. */
  private updateTag(s: Lens): void {
    if (typeof document === 'undefined') return;
    if (!this.tag) {
      const tag = document.createElement('span');
      tag.className = 'scope-plane-tag';
      tag.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:4;width:26px;height:26px;display:grid;place-items:center;border:1px solid #a48a5d;border-radius:50%;background:#20262bcc;color:#e5d2a1;box-shadow:0 0 10px #7fd6ff66;transform-origin:center';
      for (const plane of PLANES) {
        const svg = icon(plane, 17);
        svg.style.gridArea = '1 / 1';
        this.tags.push(svg);
        tag.append(svg);
      }
      document.body.append(tag);
      this.tag = tag;
    }
    const plane = s.stack[s.stack.length - 1]!;
    if (this.tagPlane !== plane) {
      for (let i = 0; i < this.tags.length; i++) this.tags[i]!.style.visibility = PLANES[i] === plane ? 'visible' : 'hidden';
      this.tag.setAttribute('aria-label', plane);
      this.tagPlane = plane;
    }
    const x = Math.round(s.px - 13), y = Math.round(s.py - s.pixels - 13), k = Math.round(this.openness * 50) / 50;
    if (x !== this.tagX || y !== this.tagY || k !== this.tagScale) {
      this.tag.style.transform = `translate(${x}px,${y}px) scale(${k})`;
      this.tagX = x; this.tagY = y; this.tagScale = k;
    }
  }

  reset(): void {
    this.state = undefined;
    this.open = 0;
    this.root.visible = false;
    this.match = undefined;
    this.depthsTick = -1;
  }
}
