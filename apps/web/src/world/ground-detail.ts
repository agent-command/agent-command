/**
 * Surface ground detail (Field Journal margin doodles): small grass tufts on open ground, thicker toward forest edges,
 * and pebbles on the bare ground of plateau tops and banks. Both follow a noise mask (`SCATTER`), so coverage runs from
 * bare stretches through sparse ground to dense clumps, and the pebbles gather where the grass thins.
 *
 * Procedural instancing: the per-cell counts are deterministic from the map (its terrain hash) and live in a small RG8
 * cell texture; each instance carries only its (cell, slot) index, and the vertex shader derives its spot, size, turn
 * and paint jitter from a hash of that index and reads its height from the drawn heightfield (a half-float texture).
 * Holes, craters and buildings clear their cells by rewriting the cell texture, and fogged cells read the fog texture,
 * so a claimed, unseen or faded instance collapses to a point and costs no fragment. The map is cut into
 * `SCATTER_CHUNK`² chunks, one draw each: three culls them against the frustum, and each draws only as many slots per
 * cell as its distance warrants (`scatterSlots`), none past the fade. Beyond it the terrain paints the same cells'
 * grass as short strokes (`grassStrokes`). Tufts are lit by the ground's up normal (bright from every side) and sway
 * with the forest's breeze (`WIND`).
 */
import { BufferAttribute, BufferGeometry, Color, DataTexture, DataUtils, DoubleSide, HalfFloatType, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter, Mesh, MeshBasicNodeMaterial, NearestFilter, OctahedronGeometry, RGFormat, RedFormat, Sphere, UnsignedByteType, type Group, type Vector3 } from 'three/webgpu';
import { Fn, If, abs, attribute, cameraPosition, color, cos, dot, float, floor, frontFacing, fwidth, hash, ivec2, max, mix, normalGeometry, normalize, positionGeometry, positionWorld, select, sin, smoothstep, texture, textureLoad, uniform, vec2, vec3, vertexStage } from 'three/tsl';
import { PLANE_Y, SURFACE, VIEW_GRID, footprint, isSurfaceHigh, surfaceFeature, type View } from '@agent-command/game/contract';
import { fbm, hash2 } from './common.ts';
import { FADE, fadeValue } from './fade.ts';
import { MAP_SIZE, type FogField } from './fog.ts';
import type { HeightField } from './field.ts';
import { SUN, WIND, clock, finish, overlay, type F1, type V3 } from './materials.ts';
import { SHADOW } from './palette.ts';
import { BED_REACH, type PostSite } from './post-beds.ts';
import { QUALITY, type Quality } from './quality.ts';

/**
 * Grass tufts: per open-ground cell `base` plus `edge` per forest neighbour (of 8), scaled by the grass mask density,
 * each `scale` tall (world units) at a random spot `spread` of the cell from its centre, `blades` blades `width` wide at
 * the root (share of the height); the paint and its per-tuft colour jitter (± share).
 */
export const GRASS = {
  base: 1, edge: 0.6, max: 5, spread: 0.9, scale: [0.2, 0.36], blades: 5, width: 0.16,
  paint: { root: '#5d7a3c', tip: '#a6bd6a' }, jitter: 0.14,
} as const;
/**
 * Pebbles: up to `max` per cell, `bare` expected on a bare cell (plateau tops, cells beside cliffs, fords, water or
 * faults) and `stray` on open ground, both scaled by the pebble mask density; each `scale` across, squashed to `flat`
 * of its height; paint and per-pebble jitter.
 */
export const PEBBLES = { max: 3, bare: 2.6, stray: 0.25, spread: 0.85, scale: [0.035, 0.075], flat: 0.45, paint: '#9a8f82', jitter: 0.18 } as const;
/**
 * The placement mask: seeded value noise over cell coordinates in two layers, `broad` patches about `scale` cells
 * across and `fine` breakup, blended by `weight` into a field around 0.5. Each kind reads the field at its own `salt`
 * (an offset of the noise domain, so grass and pebble patches don't line up) and turns it into a density multiplier
 * through its curve: 0 at or below `bare`, a smoothstep up to `peak` at `full` and above. A pebble cell keeps
 * `underGrass` of its density under full grass (density 1+) and all of it where there is none.
 */
export const SCATTER = {
  broad: { scale: 9, weight: 0.75 },
  fine: { scale: 2.5, weight: 0.25 },
  grass: { salt: 1, bare: 0.42, full: 0.62, peak: 1.7 },
  pebbles: { salt: 2, bare: 0.45, full: 0.65, peak: 1.6, underGrass: 0.15 },
} as const;
/** Camera distance (world units) over which the detail fades out; nothing draws past `far`. */
export const GROUND_FADE = { near: 36, far: 50 } as const;
/** Cells per side of one scatter chunk: one draw, frustum-culled whole, its slot count chosen by its distance. */
export const SCATTER_CHUNK = 12;
/** Slots per cell: slot k of a cell holds its k-th tuft and its k-th pebble (one instance draws both). */
export const SCATTER_SLOTS = Math.max(GRASS.max, PEBBLES.max);
/**
 * Tuft lighting: the ground's up normal, with `blade` of the blade's own two-sided normal blended in for a little
 * shape, so no blade turns its shadow side to the camera; tips seen against the sun glow by `backlight`.
 */
export const GRASS_LIGHT = { blade: 0.3, backlight: 0.12 } as const;
/**
 * Far-zoom grass in the terrain: `perCell`² candidate marks per cell, each kept with the cell's tuft count over their
 * number, an ink dash `length` × `width` (half extents, cells) at a random turn, painted at `alpha`.
 */
export const GRASS_STROKES = { perCell: 2, length: 0.15, width: 0.05, jitter: 0.5, paint: '#56713a', alpha: 0.7 } as const;
/**
 * Draw order among the Surface's line-free ground overlays: with the post beds, over the water sheet (2), under island
 * shadows (7) and scorches (8). Inked, a tuft a few pixels tall would be all outline.
 */
const GROUND_DETAIL_ORDER = 6;
/** Room above the highest ground sample of a chunk for its tallest tuft (world units). */
const TUFT_HEADROOM = GRASS.scale[1] + WIND.amp;
/** Map seeds fold into this many shader salts (exact in a float, with every instance index added). */
const SEED_SPAN = 65536;

/**
 * One instance's geometry: a grass tuft (`GRASS.blades` thin blades fanned round its root, dark at the root and pale at
 * the tip; `part` 0) and a pebble (the top half of a squashed octahedron: the rest is buried; `part` 1).
 */
function scatterGeometry(): BufferGeometry {
  const pos: number[] = [], paint: number[] = [], part: number[] = [];
  const root = new Color(GRASS.paint.root), tip = new Color(GRASS.paint.tip), stone = new Color(PEBBLES.paint);
  for (let b = 0; b < GRASS.blades; b++) {
    const a = (b / GRASS.blades) * Math.PI * 2 + 0.4;
    const lean = 0.35 + 0.25 * (b % 2);
    const w = GRASS.width, cx = Math.cos(a), cz = Math.sin(a);
    // base edge across the blade direction, tip leaning outward
    pos.push(-cz * w, 0, cx * w, cz * w, 0, -cx * w, cx * lean, 1 - 0.15 * b, cz * lean);
    paint.push(root.r, root.g, root.b, root.r, root.g, root.b, tip.r, tip.g, tip.b);
    part.push(0, 0, 0);
  }
  const top = new OctahedronGeometry(1, 0).scale(1, PEBBLES.flat, 1);
  const p = top.getAttribute('position');
  for (let i = 0; i < p.count; i += 3) {
    if (p.getY(i) + p.getY(i + 1) + p.getY(i + 2) <= 0) continue;
    for (let k = i; k < i + 3; k++) {
      pos.push(p.getX(k), p.getY(k), p.getZ(k));
      paint.push(stone.r, stone.g, stone.b);
      part.push(1);
    }
  }
  top.dispose();
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('paint', new BufferAttribute(new Float32Array(paint), 3));
  g.setAttribute('part', new BufferAttribute(new Float32Array(part), 1));
  g.computeVertexNormals();
  return g;
}

const BARE_NEIGHBOUR: Partial<Record<number, true>> = { [SURFACE.cliff]: true, [SURFACE.ford]: true, [SURFACE.water]: true, [SURFACE.fault]: true };

/** One FNV-style step folding `v` into the running claims key. */
const mixKey = (key: number, v: number): number => Math.imul(key ^ Math.round(v * VIEW_GRID), 16777619) >>> 0;

/** Peak amplitude of `fbm` at 2 and 1 octaves, which scales each layer of the mask to ±1. */
const FBM_PEAK = { broad: 0.375, fine: 0.25 } as const;
/** How far (cells) a salt can move the noise domain: far enough that the kinds' patches are unrelated. */
const SALT_SPAN = 4096;

/** The placement mask (see `SCATTER`) at cell (x, y), the noise domain shifted to (ox, oy): about 0.5, in [0, 1]. */
function scatterField(x: number, y: number, ox: number, oy: number): number {
  const { broad, fine } = SCATTER;
  const b = fbm(x / broad.scale + ox, y / broad.scale + oy, 2) / FBM_PEAK.broad;
  const f = fbm(x / fine.scale + oy, y / fine.scale + ox, 1) / FBM_PEAK.fine;
  return 0.5 + 0.5 * (broad.weight * b + fine.weight * f);
}

/** A mask value through a kind's density curve: 0 at `bare`, smoothstep to `peak` at `full`. */
function scatterDensity(m: number, curve: { readonly bare: number; readonly full: number; readonly peak: number }): number {
  const t = Math.min(1, Math.max(0, (m - curve.bare) / (curve.full - curve.bare)));
  return curve.peak * t * t * (3 - 2 * t);
}

/** `want` rounded up or down at random (`u` in [0, 1)) so its mean is kept, capped at `max`. */
const dither = (want: number, u: number, max: number): number => Math.min(max, Math.floor(want) + (u < want - Math.floor(want) ? 1 : 0));

/**
 * Deterministic per-cell counts for map `codes` (seed `seed`): grass tufts and pebbles on each cell, 0 where the cell
 * is not open ground or is `blocked` (holes, opened chasms, building footprints). Written into `grass` / `pebbles`.
 */
export function groundDetailCounts(codes: Uint8Array, size: number, seed: number, blocked: Uint8Array, grass: Uint8Array, pebbles: Uint8Array): void {
  const { grass: gc, pebbles: pc } = SCATTER;
  const gx = hash2(seed, gc.salt * 2) * SALT_SPAN, gy = hash2(gc.salt * 2 + 1, seed) * SALT_SPAN;
  const px = hash2(seed, pc.salt * 2) * SALT_SPAN, py = hash2(pc.salt * 2 + 1, seed) * SALT_SPAN;
  for (let i = 0; i < codes.length; i++) {
    grass[i] = pebbles[i] = 0;
    if (blocked[i] || surfaceFeature(codes[i]!) !== SURFACE.ground) continue;
    const x = i % size, y = (i / size) | 0;
    let forest = 0, bare = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const f = surfaceFeature(codes[ny * size + nx]!);
      if (f === SURFACE.forest) forest++;
      if (BARE_NEIGHBOUR[f]) bare = true;
    }
    bare ||= isSurfaceHigh(codes[i]!);
    const u = hash2(i * 2 + seed, 7), v = hash2(i * 2 + 1, seed + 13);
    const gd = bare ? 0 : scatterDensity(scatterField(x, y, gx, gy), gc);
    grass[i] = dither((GRASS.base + GRASS.edge * forest) * gd, v, GRASS.max);
    // pebbles gather where the grass thins: all of their density on bare ground, `underGrass` of it under full grass
    const thin = pc.underGrass + (1 - pc.underGrass) * (1 - Math.min(1, gd));
    pebbles[i] = dither((bare ? PEBBLES.bare : PEBBLES.stray) * scatterDensity(scatterField(x, y, px, py), pc) * thin, u, PEBBLES.max);
  }
}

/** Chunks per side of a map `size` cells across. */
export const scatterChunks = (size: number): number => Math.ceil(size / SCATTER_CHUNK);

/**
 * Slots per cell a chunk draws at `distance` (world units from the camera to its box) under the tier's `cap`: all of
 * them up to `GROUND_FADE.near`, then fewer as its tufts fade (the dense clumps thin first), none from `far` on.
 */
export function scatterSlots(distance: number, cap: number): number {
  const { near, far } = GROUND_FADE;
  if (distance >= far) return 0;
  if (distance <= near) return cap;
  return Math.max(1, Math.ceil((cap * (far - distance)) / (far - near)));
}

/**
 * Each chunk's instance list from the per-cell counts `grass` / `pebbles` under `cap` slots per cell: chunk k's
 * (cell, slot) pairs, encoded cell + slot · size², start at k · SCATTER_CHUNK² · cap in `ids`, slot-major (every
 * cell's slot 0, then slot 1…), so a prefix of the list draws at most that many slots per cell everywhere in the chunk.
 * `prefix[k · (cap + 1) + s]` is chunk k's pair count below slot s.
 */
export function scatterInstances(size: number, grass: Uint8Array, pebbles: Uint8Array, cap: number, ids: Float32Array, prefix: Uint32Array): void {
  const per = scatterChunks(size), area = size * size, room = SCATTER_CHUNK * SCATTER_CHUNK * cap;
  for (let cy = 0; cy < per; cy++) for (let cx = 0; cx < per; cx++) {
    const k = cy * per + cx, x0 = cx * SCATTER_CHUNK, y0 = cy * SCATTER_CHUNK;
    const x1 = Math.min(size, x0 + SCATTER_CHUNK), y1 = Math.min(size, y0 + SCATTER_CHUNK);
    let n = 0;
    prefix[k * (cap + 1)] = 0;
    for (let s = 0; s < cap; s++) {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const c = y * size + x;
        if (s < grass[c]! || s < pebbles[c]!) ids[k * room + n++] = c + s * area;
      }
      prefix[k * (cap + 1) + s + 1] = n;
    }
  }
}

/** Distance from (px, py, pz) to the axis-aligned box at `o` in `box` (min x, y, z, then max x, y, z). */
export function boxDistance(px: number, py: number, pz: number, box: Float32Array, o: number): number {
  const dx = Math.max(box[o]! - px, 0, px - box[o + 3]!);
  const dy = Math.max(box[o + 1]! - py, 0, py - box[o + 4]!);
  const dz = Math.max(box[o + 2]! - pz, 0, pz - box[o + 5]!);
  return Math.hypot(dx, dy, dz);
}

/** Bilinear visibility (the fog texture's r) at tile point (x, y): the fog's own blend without its edge noise. */
function fogAtTile(fogField: FogField | undefined, x: F1, y: F1): F1 {
  if (!fogField) return float(1) as F1;
  const tex = fogField.planes.surface.tex;
  const qx = x.sub(0.5), qy = y.sub(0.5);
  const bx = floor(qx), by = floor(qy), fx = qx.sub(bx), fy = qy.sub(by);
  // rows and columns past the map repeat its last one, so only the low side needs a clamp
  const x0 = bx.max(0), y0 = by.max(0), x1 = bx.add(1), y1 = by.add(1);
  const tap = (i: F1, j: F1) => textureLoad(tex, ivec2(i.toInt(), j.toInt())).r;
  return mix(mix(tap(x0, y0), tap(x1, y0), fx), mix(tap(x0, y1), tap(x1, y1), fx), fy) as F1;
}

export class GroundDetail {
  /** One draw per chunk (`SCATTER_CHUNK`), row-major. */
  readonly chunks: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>[] = [];
  /** Per cell, the tufts (r) and pebbles (g) drawn there now, as bytes: 0 on claimed cells. */
  readonly cells: DataTexture;
  /** The drawn Surface heights (the field's samples as half floats), read where each instance stands. */
  readonly heights: DataTexture;
  private readonly size: number;
  private readonly field: HeightField;
  /** Slots per cell the tier draws (`Quality.scatter`). */
  private readonly cap: number;
  private readonly blocked: Uint8Array;
  /** Counts with only the post beds claimed: every instance a claim can free again is in the chunk lists. */
  private readonly baseGrass: Uint8Array;
  private readonly basePebbles: Uint8Array;
  private readonly ids: Float32Array;
  private readonly prefix: Uint32Array;
  /** Per chunk, its world box (min x, y, z, max x, y, z) for the distance LOD. */
  private readonly boxes: Float32Array;
  private readonly seed = uniform(0);
  private codes: Uint8Array | undefined;
  private posts: readonly PostSite[] = [];
  /** Hash of the hole cells and known Surface buildings last written (NaN forces a rewrite). */
  private claimsKey = Number.NaN;

  constructor(size: number, parent: Group, field: HeightField, fogField?: FogField, quality: Pick<Quality, 'scatter'> = QUALITY.full) {
    this.size = size;
    this.field = field;
    this.cap = Math.min(SCATTER_SLOTS, quality.scatter.slots);
    const area = size * size;
    this.blocked = new Uint8Array(area);
    this.baseGrass = new Uint8Array(area);
    this.basePebbles = new Uint8Array(area);
    this.cells = new DataTexture(new Uint8Array(area * 2), size, size, RGFormat, UnsignedByteType);
    this.cells.magFilter = this.cells.minFilter = NearestFilter;
    this.cells.needsUpdate = true;
    this.heights = new DataTexture(new Uint16Array(field.n * field.n), field.n, field.n, RedFormat, HalfFloatType);
    this.heights.magFilter = this.heights.minFilter = LinearFilter;
    this.heights.needsUpdate = true;
    const per = scatterChunks(size), room = SCATTER_CHUNK * SCATTER_CHUNK * this.cap;
    this.ids = new Float32Array(per * per * room);
    this.prefix = new Uint32Array(per * per * (this.cap + 1));
    this.boxes = new Float32Array(per * per * 6);
    const geometry = scatterGeometry();
    const material = this.material(field.spec.res, fogField);
    for (let k = 0; k < per * per; k++) {
      const g = new InstancedBufferGeometry();
      for (const name of ['position', 'normal', 'paint', 'part']) g.setAttribute(name, geometry.getAttribute(name));
      g.setAttribute('cell', new InstancedBufferAttribute(this.ids.subarray(k * room, (k + 1) * room), 1));
      g.instanceCount = 0;
      g.boundingSphere = new Sphere();
      const mesh = new Mesh(g, material);
      mesh.name = 'surface-grass';
      mesh.renderOrder = GROUND_DETAIL_ORDER;
      mesh.visible = false;
      this.chunks.push(mesh);
      parent.add(mesh);
    }
  }

  /**
   * The shared material: every vertex finds its instance's cell and slot, collapses unless the cell holds that slot's
   * tuft (or pebble) and is seen, and is lit, fogged and faded once per vertex (a tuft is a few pixels: its fragments
   * only take the colour).
   */
  private material(res: number, fogField: FogField | undefined): MeshBasicNodeMaterial {
    const S = MAP_SIZE;
    const id = attribute<'float'>('cell', 'float');
    const part = attribute<'float'>('part', 'float');
    const pebble = part.greaterThan(0.5);
    // index → (cell, slot); + 0.5 keeps the float floors exact
    const area = S.mul(S);
    const slot = floor(id.add(0.5).div(area));
    const cell = id.sub(slot.mul(area));
    const cy = floor(cell.add(0.5).div(S));
    const cx = cell.sub(cy.mul(S));
    const counts = textureLoad(this.cells, ivec2(cx.toInt(), cy.toInt())).mul(255);
    const live = slot.add(0.5).lessThan(select(pebble, counts.g, counts.r));
    const salt = id.mul(16).add(part.mul(8)).add(this.seed);
    const h = (k: number): F1 => hash(salt.add(k)) as unknown as F1;
    // the instance: its root (tile coords), size, turn and pebble stretch
    const spread = mix(float(GRASS.spread), float(PEBBLES.spread), part);
    const rx = cx.add(0.5).add(h(1).sub(0.5).mul(spread)), ry = cy.add(0.5).add(h(2).sub(0.5).mul(spread));
    const scale = select(pebble, mix(float(PEBBLES.scale[0]), float(PEBBLES.scale[1]), h(3)), mix(float(GRASS.scale[0]), float(GRASS.scale[1]), h(3)));
    const turn = h(4).mul(Math.PI * 2), ct = cos(turn), st = sin(turn);
    const stretch = select(pebble, h(5).mul(0.4).add(0.8), float(1));
    const g = positionGeometry;
    const lx = g.x.mul(stretch).mul(scale), lz = g.z.mul(scale);
    // three's Y rotation: x' = x cos + z sin, z' = z cos − x sin
    const px = lx.mul(ct).add(lz.mul(st)), pz = lz.mul(ct).sub(lx.mul(st));
    const ground = texture(this.heights, vec2(rx, ry).mul(res).add(0.5).div(S.mul(res).add(1))).r;
    // tufts sink their roots a hair; the breeze leans their tips downwind, its wave travelling across the field
    const rootY = ground.add(PLANE_Y.surface).sub(select(pebble, float(0), float(0.01)));
    const wave = sin(clock.mul(WIND.rate).add(rx.mul(WIND.kx)).add(ry.mul(WIND.kz)));
    const bend = wave.mul(g.y.max(0).mul(g.y)).mul(WIND.amp).mul(scale).mul(float(1).sub(part));
    const half = S.mul(0.5);
    const root = vec3(rx.sub(half), rootY, ry.sub(half));
    const world = vec3(rx.sub(half).add(px).add(bend), rootY.add(g.y.mul(scale)), ry.sub(half).add(pz).add(bend.mul(WIND.skew)));
    // seen and near enough: the tuft's opacity, from its root
    const v = fogAtTile(fogField, rx, ry);
    const alpha = smoothstep(0.3, 0.7, v).mul(float(1).sub(smoothstep(GROUND_FADE.near, GROUND_FADE.far, cameraPosition.distance(root))));
    // paint and jitter
    const jg = h(5).sub(0.5).mul(2 * GRASS.jitter).add(1), jp = h(6).sub(0.5).mul(2 * PEBBLES.jitter).add(1);
    const tint = select(pebble, vec3(jp, jp, jp), vec3(jg, jg.mul(h(6).sub(0.5).mul(GRASS.jitter).add(1)), jg));
    const base = attribute<'vec3'>('paint', 'vec3').mul(tint) as V3;
    // light: pebbles by their faces; tufts by the ground's up normal with a share of the blade's, either side
    const n = normalGeometry;
    const normal = vec3(n.x.mul(ct).add(n.z.mul(st)), n.y, n.z.mul(ct).sub(n.x.mul(st)));
    const facing = dot(normal, SUN);
    const ndl = select(pebble, facing, mix(SUN.y, abs(facing), GRASS_LIGHT.blade));
    const lit = smoothstep(0, 0.08, ndl);
    const hi = smoothstep(0.7, 0.76, ndl).mul(lit).mul(0.1);
    const back = max(dot(normalize(root.sub(cameraPosition)), SUN), 0).mul(g.y).mul(GRASS_LIGHT.backlight).mul(float(1).sub(part));
    const shaded = mix(base.mul(color(SHADOW.surface)), base, lit).add(hi).mul(back.add(1)) as V3;
    // the watercolour rim where vision ends (`finish`), then the plane's ghost
    const rim = smoothstep(0.35, 0.55, v).mul(float(1).sub(smoothstep(0.55, 0.9, v)));
    const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    // one pass for both sides: three draws a blended two-sided material twice (back faces, then front) otherwise
    m.forceSinglePass = true;
    m.positionNode = select(live.and(alpha.greaterThan(0)), world, vec3(0, 0, 0));
    m.colorNode = vertexStage(finish(shaded.mul(float(1).sub(rim.mul(0.28))) as V3, 'surface', { fog: false }));
    m.opacityNode = vertexStage(alpha).mul(FADE.surface.alpha);
    // pebbles are solid: their far faces stay hidden even with no depth write
    m.maskNode = vertexStage(part).lessThan(0.5).or(frontFacing);
    return m;
  }

  /**
   * Far-zoom grass for the terrain shader: short ink strokes over the cells' tufts (the same cell texture), coming in
   * where the tufts fade out. Coverage 0..1. Only fragments past `GROUND_FADE.near` evaluate the marks; the one screen
   * derivative they need is taken before the branch.
   */
  strokes(): F1 {
    const S = MAP_SIZE;
    const k = GRASS_STROKES.perCell;
    const t = positionWorld.xz.add(S.mul(0.5)).mul(k);
    // a mark's narrow axis, in pixels per its half width
    const aa = fwidth(t).length().div(k * GRASS_STROKES.width).max(1e-4);
    const far = smoothstep(GROUND_FADE.near, GROUND_FADE.far, cameraPosition.distance(positionWorld));
    // a mark thinner than a pixel settles to its mean coverage (an ellipse in a mark slot)
    const mean = Math.PI * GRASS_STROKES.length * GRASS_STROKES.width * k * k;
    return Fn(() => {
      const out = float(0).toVar();
      If(far.greaterThan(0), () => {
        const id = floor(t), f = t.sub(id);
        const cell = floor(id.add(0.5).div(k)).clamp(0, S.sub(1));
        const tufts = textureLoad(this.cells, ivec2(cell.x.toInt(), cell.y.toInt())).r.mul(255);
        const salt = id.x.add(id.y.mul(4099)).mul(4).add(this.seed);
        const h = (n: number): F1 => hash(salt.add(n)) as unknown as F1;
        const turn = h(1).mul(Math.PI), ct = cos(turn), st = sin(turn);
        const d = f.sub(vec2(h(2), h(3)).sub(0.5).mul(GRASS_STROKES.jitter).add(0.5)).div(k);
        const r = vec2(d.x.mul(ct).add(d.y.mul(st)).div(GRASS_STROKES.length), d.y.mul(ct).sub(d.x.mul(st)).div(GRASS_STROKES.width)).length();
        const mark = mix(float(1).sub(smoothstep(float(1).sub(aa), aa.add(1), r)), float(mean), smoothstep(0.5, 1.5, aa));
        out.assign(select(h(0).lessThan(tufts.div(k * k)), mark, float(0)).mul(far).mul(GRASS_STROKES.alpha));
      });
      return out;
    })() as unknown as F1;
  }

  /** The drawn Surface heights changed (a bake or a patch): re-read them and each chunk's bounds. */
  setHeights(): void {
    const { field, size } = this;
    const n = field.n, res = field.spec.res, h = field.h;
    const data = this.heights.image.data as Uint16Array;
    for (let i = 0; i < n * n; i++) data[i] = DataUtils.toHalfFloat(h[i]!);
    this.heights.needsUpdate = true;
    const per = scatterChunks(size), half = size / 2;
    for (let k = 0; k < per * per; k++) {
      const x0 = (k % per) * SCATTER_CHUNK, y0 = Math.floor(k / per) * SCATTER_CHUNK;
      const x1 = Math.min(size, x0 + SCATTER_CHUNK), y1 = Math.min(size, y0 + SCATTER_CHUNK);
      let lo = Infinity, hi = -Infinity;
      for (let j = y0 * res; j <= y1 * res; j++) for (let i = x0 * res; i <= x1 * res; i++) {
        const v = h[j * n + i]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const o = k * 6, b = this.boxes;
      b[o] = x0 - half; b[o + 1] = PLANE_Y.surface + lo; b[o + 2] = y0 - half;
      b[o + 3] = x1 - half; b[o + 4] = PLANE_Y.surface + hi + TUFT_HEADROOM; b[o + 5] = y1 - half;
      const sphere = this.chunks[k]!.geometry.boundingSphere!;
      sphere.center.set((b[o]! + b[o + 3]!) / 2, (b[o + 1]! + b[o + 4]!) / 2, (b[o + 2]! + b[o + 5]!) / 2);
      sphere.radius = Math.hypot(b[o + 3]! - b[o]!, b[o + 4]! - b[o + 1]!, b[o + 5]! - b[o + 2]!) / 2;
    }
  }

  /** A new map (codes, its terrain hash as the seed, and its post sites, whose beds stay bare): its chunk lists. */
  setMap(codes: Uint8Array, seed: number, posts: readonly PostSite[]): void {
    this.codes = codes;
    this.posts = posts;
    this.seed.value = (seed >>> 0) % SEED_SPAN;
    this.claimBeds();
    groundDetailCounts(codes, this.size, seed, this.blocked, this.baseGrass, this.basePebbles);
    scatterInstances(this.size, this.baseGrass, this.basePebbles, this.cap, this.ids, this.prefix);
    for (const c of this.chunks) c.geometry.getAttribute('cell').needsUpdate = true;
    this.claimsKey = Number.NaN;
  }

  /** The post beds: every cell whose centre the widest bed covers. Starts `blocked` afresh. */
  private claimBeds(): void {
    const b = this.blocked;
    b.fill(0);
    const r = Math.ceil(BED_REACH);
    for (const p of this.posts) {
      for (let yy = Math.max(0, Math.floor(p.y) - r); yy <= Math.min(this.size - 1, Math.floor(p.y) + r); yy++)
        for (let xx = Math.max(0, Math.floor(p.x) - r); xx <= Math.min(this.size - 1, Math.floor(p.x) + r); xx++)
          if (Math.hypot(xx + 0.5 - p.x, yy + 0.5 - p.y) < BED_REACH) b[yy * this.size + xx] = 1;
    }
  }

  /**
   * Holes (and opened chasms) and the buildings this view knows of claim their cells: the cell texture is rewritten
   * only when either set changes.
   */
  update(view: View, holeAt: ReadonlyMap<number, string>, opened: Uint8Array): void {
    if (!this.codes) return;
    // a numeric key over the claims (no per-snapshot strings): rewritten only when holes or buildings change
    let key = view.holes.length;
    for (const h of view.holes) key = mixKey(key, h.y * this.size + h.x);
    for (const e of view.entities) {
      const f = e.plane === 'surface' ? footprint(e.kind) : undefined;
      if (f) key = mixKey(mixKey(key, e.x * 4099 + e.y), f.w * 64 + f.h);
    }
    for (const g of view.memory) {
      const f = g.plane === 'surface' ? footprint(g.kind) : undefined;
      if (f) key = mixKey(mixKey(key, g.x * 4099 + g.y), f.w * 64 + f.h);
    }
    if (key === this.claimsKey) return;
    this.claimsKey = key;
    this.claimBeds();
    const b = this.blocked;
    for (let i = 0; i < b.length; i++) if (holeAt.has(i) || opened[i]) b[i] = 1;
    const claim = (kind: View['entities'][number]['kind'], x: number, y: number): void => {
      const f = footprint(kind);
      if (!f) return;
      for (let yy = Math.max(0, Math.floor(y - f.h / 2 + 1 / VIEW_GRID)); yy < Math.min(this.size, Math.ceil(y + f.h / 2 - 1 / VIEW_GRID)); yy++)
        for (let xx = Math.max(0, Math.floor(x - f.w / 2 + 1 / VIEW_GRID)); xx < Math.min(this.size, Math.ceil(x + f.w / 2 - 1 / VIEW_GRID)); xx++) b[yy * this.size + xx] = 1;
    };
    for (const e of view.entities) if (e.plane === 'surface') claim(e.kind, e.x, e.y);
    for (const g of view.memory) if (g.plane === 'surface') claim(g.kind, g.x, g.y);
    const data = this.cells.image.data as Uint8Array;
    for (let i = 0; i < b.length; i++) {
      data[i * 2] = b[i] ? 0 : this.baseGrass[i]!;
      data[i * 2 + 1] = b[i] ? 0 : this.basePebbles[i]!;
    }
    this.cells.needsUpdate = true;
  }

  /**
   * Per frame: each chunk draws the slots its distance from `camera` warrants (`scatterSlots`); none while the camera
   * rests `distance` (world units) or more from its focus, or the Surface is faded out.
   */
  frame(camera: Vector3, distance: number): void {
    const show = distance < GROUND_FADE.far && fadeValue.surface > 0;
    const cap = this.cap;
    for (let k = 0; k < this.chunks.length; k++) {
      const slots = show ? scatterSlots(boxDistance(camera.x, camera.y, camera.z, this.boxes, k * 6), cap) : 0;
      const n = this.prefix[k * (cap + 1) + slots]!;
      const mesh = this.chunks[k]!;
      mesh.geometry.instanceCount = n;
      mesh.visible = n > 0;
    }
  }

  reset(): void {
    (this.cells.image.data as Uint8Array).fill(0);
    this.cells.needsUpdate = true;
    this.claimsKey = Number.NaN;
  }
}
