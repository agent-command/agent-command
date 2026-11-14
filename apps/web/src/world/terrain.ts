/**
 * The Surface: one smoothed heightfield (`field.ts`) built once per match — rounded mesas with strata walls, river
 * beds under a water sheet, rock crags, and holes (sinkholes, craters, breaches, chasms) as cutaway pits — plus
 * forests, fault cracks, a shared torn/inked hole lip and bridge decks. Holes rebuild only a window of the field.
 *
 * Heights (local): ground 0, plateaus +0.8, ford beds −0.42 under the water at −0.16, crags 1.3 (1.7 where they wall
 * a plateau); pits: crater −1.3, sinkhole −2, breach −2.4, chasm −3.2. `groundAt` samples the field.
 * Forest canopies are drawn after the entities and thin over our own units (`presence`).
 */
import { BoxGeometry, ConeGeometry, CylinderGeometry, RingGeometry, OctahedronGeometry, BufferAttribute, BufferGeometry, DataTexture, DoubleSide, Group, InstancedMesh, LinearFilter, Mesh, MeshBasicNodeMaterial, Object3D, RGBAFormat, UnsignedByteType, Vector4, type Material } from 'three/webgpu';
import { abs, attribute, cameraPosition, color, dot, float, fwidth, max, mix, mx_noise_float, normalWorld, normalize, positionGeometry, positionLocal, positionWorld, reflect, sin, smoothstep, texture, time, uniform, uv, vec2, vec3 } from 'three/tsl';
import { CELL, ECON, PLANE_Y, STATS, SURFACE, VIEW_GRID, footprint, isSurfaceHigh, surfaceFeature, type Kind, type MatchData, type View } from '@agent-command/game/contract';
import { FADE } from './fade.ts';
import { hash2, wx, wz } from './common.ts';
import { HeightField, type FieldSpec } from './field.ts';
import { FieldBuilder, PATCH_PAD } from './fieldjobs.ts';
import { HoleLips } from './holes.ts';
import { GRASS_STROKES, GroundDetail } from './ground-detail.ts';
import { PostBeds, type PostSite } from './post-beds.ts';
import { FogField, mapUV } from './fog.ts';
import { SUN, SUN_DIR, TileMask, WIND, cel, clock, edgeSection, finish, gridInk, hatch, inkMaterial, lines, lum, mapEdge, noise, overlay, planeLines, emptyGeometry, seen, windBend, type F1, type V3 } from './materials.ts';
import { FORD_A, SHORE, SHORE_CELL, SHORE_SPAN, STONE_A, ShoreField, type ShoreSource } from './shore.ts';
import { merge } from './models.ts';
import { INK, LODE_PAINT, SHADOW } from './palette.ts';
import { QUALITY, type Quality } from './quality.ts';

/** Water is planar relative to its body's authoritative support elevation, never the noisy bed. */
const WATER_Y = -0.16;
/** Water sheet quads per cell side: the sheet is trimmed to the shore field's water at this grain. */
const WATER_SHEET_SUB = 2;
const LEVEL = { ground: 0, high: 0.8, crag: 1.3, cragHigh: 1.7, ford: -0.42, water: -1.1, crater: -1.3, sinkhole: -2, breach: -2.4, chasm: -3.2 } as const;
/** Lode rock rises above the level its site stands on: plain ground or a plateau top. */
const LODE_RISE = { bore: 0.08, skirt: 0.16, lode: 0.48, rich: 0.64 } as const;
const LODE_LEVELS = [LEVEL.ground, LEVEL.high].flatMap((base) => Object.values(LODE_RISE).map((rise) => base + rise));
const HOLE_LEVEL: Record<string, number> = { crater: LEVEL.crater, sinkhole: LEVEL.sinkhole, breach: LEVEL.breach, chasm: LEVEL.chasm };
/** Field class bits (see `field.ts`): masks blended by the material. */
const FOREST = 1;
const ROCK = 2;
const FORD = 4;
const HOLE = 8;
const CHASM = 16;
const BREACH = 32;

/** blur 0.3 tiles (one sample at res 4): corners round, yet one-cell crags and diagonal cliff lines keep their footprint. */
const SPEC: Omit<FieldSpec, 'size'> = { res: 4, blur: 0.3, sharp: 0.16, rough: 0.3, swell: 0.12, levels: [...Object.values(LEVEL), LEVEL.high + LEVEL.ford, LEVEL.high + LEVEL.water, ...LODE_LEVELS], sun: true };
/** Local y the diorama cuts the map edge down to. */
const SKIRT = -4;

export interface Fault {
  readonly cells: readonly { x: number; y: number }[];
}

export interface TerrainData {
  /** SURFACE code per cell, row-major (y * size + x). */
  codes: Uint8Array;
  faults: readonly Fault[];
  /** Public forward posts (`matchData.posts`): their ground beds belong to the static terrain. */
  posts: readonly PostSite[];
}

/** Surface presentation state owned by one map, independent even of other maps with the same dimensions. */
export class TerrainField {
  readonly size: number;
  readonly field: HeightField;
  readonly terrainCodes: Uint8Array;
  readonly opened: Uint8Array;
  readonly holeAt = new Map<number, string>();
  readonly lodeHeight: Float32Array;

  constructor(size: number) {
    this.size = size;
    this.field = new HeightField({ ...SPEC, size });
    this.terrainCodes = new Uint8Array(size * size);
    this.opened = new Uint8Array(size * size);
    this.lodeHeight = new Float32Array(size * size);
  }

  lodeInputs(lodes: View['lodes']): void {
    this.lodeHeight.fill(0);
    for (const l of lodes) {
      const f = STATS.headframe.footprint;
      for (let dy = (1 - f.h) / 2; dy < (1 + f.h) / 2; dy++) for (let dx = (1 - f.w) / 2; dx < (1 + f.w) / 2; dx++) {
        const x = l.x + dx, y = l.y + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const i = y * this.size + x, code = this.terrainCodes[i];
        if (surfaceFeature(code!) !== SURFACE.ground) continue;
        const base = isSurfaceHigh(code!) ? LEVEL.high : LEVEL.ground;
        this.lodeHeight[i] = Math.max(this.lodeHeight[i]!, base + (dx && dy ? LODE_RISE.bore : dx || dy ? LODE_RISE.skirt : l.open ? LODE_RISE.bore : l.rich ? LODE_RISE.rich : LODE_RISE.lode));
      }
    }
  }

  /** Cell inputs for the smoothed field, including persistent bridge pits. */
  cellInput(i: number, codes: Uint8Array, level: Float32Array, cls: Uint8Array): void {
    const code = surfaceFeature(codes[i]!), kind = this.holeAt.get(i);
    const base = isSurfaceHigh(codes[i]!) ? LEVEL.high : LEVEL.ground;
    let lv: number = base, c = 0;
    if (kind) {
      lv = HOLE_LEVEL[kind] ?? LEVEL.sinkhole;
      c = HOLE | (kind === 'chasm' ? CHASM : kind === 'breach' ? BREACH : 0);
    } else if (this.opened[i]) { lv = LEVEL.chasm; c = HOLE | CHASM; }
    else if (code === SURFACE.ford || code === SURFACE.water) { lv = base + (code === SURFACE.water ? LEVEL.water : LEVEL.ford); c = FORD; }
    else if (code === SURFACE.forest) c = FOREST;
    else if (code === SURFACE.cliff) {
      const x = i % this.size, y = (i / this.size) | 0;
      let high = false;
      for (let dy = -1; dy <= 1 && !high; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < this.size && yy < this.size && isSurfaceHigh(codes[yy * this.size + xx]!)) high = true;
      }
      lv = high ? LEVEL.cragHigh : LEVEL.crag;
      c = ROCK;
    }
    if (!kind && !this.opened[i] && this.lodeHeight[i]! > 0) { lv = this.lodeHeight[i]!; c |= ROCK; }
    level[i] = lv;
    cls[i] = c;
  }

  /** Synchronous baking for offline consumers and tests; renderers use their worker builder. */
  setHeights(codes: Uint8Array, holes: ReadonlyMap<number, string>, lodes: View['lodes'] = []): void {
    this.terrainCodes.set(codes);
    this.lodeInputs(lodes);
    this.opened.fill(0);
    this.holeAt.clear();
    for (const [c, k] of holes) this.holeAt.set(c, k);
    for (let i = 0; i < this.terrainCodes.length; i++) this.cellInput(i, codes, this.field.level, this.field.cls);
    this.field.setSun(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z);
    this.field.build(this.field.full());
  }

  /** Surface support height, including ford water and bridge decks. Safe to pass as a callback.
   * Decals may supply the currently drawn height while a newer field bake uploads in bands. */
  readonly groundAt = (x: number, y: number, drawnHeight?: number): number => {
    const xi = Math.max(0, Math.min(this.size - 1, x | 0)), yi = Math.max(0, Math.min(this.size - 1, y | 0));
    const c = yi * this.size + xi;
    if (this.opened[c] === 1 && !this.holeAt.has(c)) return 0.06;
    const h = drawnHeight ?? this.field.heightAt(x, y);
    return surfaceFeature(this.terrainCodes[c]!) === SURFACE.ford && !this.holeAt.has(c) && !this.opened[c]
      ? Math.max(h, (isSurfaceHigh(this.terrainCodes[c]!) ? LEVEL.high : LEVEL.ground) + WATER_Y + 0.04) : h;
  };

  /**
   * Where a Surface structure stands at (x, y): the ground, or over a hole the level the ground stood at before it
   * opened. Only the blast damages structures, so one that survives stands on over its pit, on the footing
   * SurfaceLayer.setFootings draws below it, never sunk into the pit.
   */
  readonly footingAt = (x: number, y: number): number => {
    const xi = Math.max(0, Math.min(this.size - 1, x | 0)), yi = Math.max(0, Math.min(this.size - 1, y | 0));
    const c = yi * this.size + xi;
    if (!this.holeAt.has(c)) return this.groundAt(x, y);
    return isSurfaceHigh(this.terrainCodes[c]!) ? LEVEL.high : LEVEL.ground;
  };

  /** Local height of the water sheet (ford or lake) over the cell at (x, y); NaN where there is none. */
  waterAt(x: number, y: number): number {
    const xi = Math.max(0, Math.min(this.size - 1, x | 0)), yi = Math.max(0, Math.min(this.size - 1, y | 0));
    const c = yi * this.size + xi, code = this.terrainCodes[c]!, feature = surfaceFeature(code);
    if ((feature !== SURFACE.ford && feature !== SURFACE.water) || this.holeAt.has(c) || this.opened[c]) return NaN;
    return (isSurfaceHigh(code) ? LEVEL.high : LEVEL.ground) + WATER_Y;
  }
}

export function groundAt(x: number, y: number, field: TerrainField): number {
  return field.groundAt(x, y);
}

/** Decode the match's public fault list into plain polylines. */
export function faultsOf(match: Pick<MatchData, 'faults'>): Fault[] {
  return match.faults.map((f) => ({ cells: f.cells }));
}

const tmp = new Object3D();

/** Pine: two stacked cones and a trunk, painted (per-vertex `paint`). */
function treeGeometry(): BufferGeometry {
  return merge([
    { geo: new ConeGeometry(0.34, 0.62, 7).translate(0, 0.52, 0), paint: '#5c8a4a' },
    { geo: new ConeGeometry(0.26, 0.5, 7).translate(0, 0.86, 0), paint: '#6f9c52' },
    { geo: new ConeGeometry(0.06, 0.3, 5).translate(0, 0.15, 0), paint: '#6b4a32' },
  ]);
}

/**
 * The terrain material: painted patches, soil cutaways, river banks and shadowed openings, and the far-zoom grass
 * strokes (`strokes`: their coverage, see `GroundDetail.strokes`).
 */
function terrainMaterial(marks: TileMask, lodes: TileMask, below: TileMask, strokes: F1, fogField: FogField): MeshBasicNodeMaterial {
  const m = attribute<'vec4'>('m', 'vec4');
  const sun = attribute<'float'>('sun', 'float');
  const ao = attribute<'float'>('ao', 'float');
  const p = positionLocal;
  const n = mx_noise_float(p.mul(0.32));
  const n2 = mx_noise_float(p.mul(1.9)).mul(0.5).add(0.5);
  const wall = smoothstep(0.32, 0.55, float(1).sub(normalWorld.y));
  // painted patches: crisp steps in low-frequency noise rather than smooth blends
  const grass = mix(color('#9ab86a'), color('#b5c178'), smoothstep(0.1, 0.16, n));
  const meadow = mix(grass, color('#cdb77c'), smoothstep(0.42, 0.48, n).mul(0.85));
  const floor = mix(meadow, color('#6e8f4f'), smoothstep(0.3, 0.6, m.x));
  const plateau = mix(color('#dcc791'), color('#e7d6a4'), n2);
  const top = mix(floor, plateau, smoothstep(0.45, 0.6, p.y));
  const bank = mix(top, color('#dbc9a0'), smoothstep(0.05, 0.3, m.z));
  const bed = mix(bank, color('#7e9c95'), smoothstep(0.55, 0.8, m.z));
  const strata = smoothstep(0.45, 0.55, p.y.mul(3.2).add(n2.mul(0.6)).fract());
  const rock = mix(color('#a9978a'), color('#8b7a6e'), strata);
  const crag = mix(color('#beb29c'), color('#a59a86'), n2);
  const depth = p.y.negate().add(n2.mul(0.09));
  const inHole = smoothstep(0.08, 0.6, m.w);
  const deep = smoothstep(0.35, 1.2, depth).mul(inHole);
  const floorDepth = deep.mul(smoothstep(0.3, 0.85, normalWorld.y));
  // The same sand / brown / cool-purple geology as the cliffs, with only three inked bedding contacts.
  const earth = mix(color('#c7b18a'), color('#8c7580'), smoothstep(0.24, 0.29, depth));
  const subsoil = mix(earth, color('#aa927b'), smoothstep(0.58, 0.64, depth));
  const lower = mix(subsoil, color('#645263'), smoothstep(0.94, 1.01, depth));
  const contact = abs(depth.sub(0.28)).min(abs(depth.sub(0.62))).min(abs(depth.sub(0.98)));
  const beddingInk = float(1).sub(smoothstep(0.012, 0.032, contact));
  const pitWall = mix(mix(lower, color('#29252f'), smoothstep(1.15, 2.9, depth)), color('#403643'), beddingInk.mul(0.8));
  let base = mix(mix(bed, crag, smoothstep(0.4, 0.7, m.y)), mix(rock, pitWall, smoothstep(0.03, 0.35, m.w)), wall) as V3;
  base = mix(base, pitWall, deep) as V3;
  base = mix(base, color(GRASS_STROKES.paint), strokes.mul(float(1).sub(wall))) as V3;
  // No geometric offset outline: one inked shoulder follows the field's rounded, noisy cell-union contour.
  const rim = float(1).sub(smoothstep(0.016, 0.045, abs(m.w.sub(0.22).add(n.mul(0.045)))));
  base = mix(base, color(INK.surface), rim.mul(wall).mul(float(1).sub(smoothstep(0.2, 0.5, depth)))) as V3;
  // Only the team's provided Depths cells contribute tones. Unknown cells have zero mask.
  const knownBelow = below.sample().mul(smoothstep(0.8, 1, fogField.fogAt('depths', 0).y));
  const floorWash = mix(color('#191b25'), color('#514331'), knownBelow.mul(n2.mul(0.25).add(0.22)));
  base = mix(base, floorWash, floorDepth.mul(0.85)) as V3;
  // Ore follows the actual heightfield, including its slopes and ink normals; it is not a floating overlay.
  const ore = lodes.sample();
  const rich = smoothstep(0.65, 0.9, ore);
  const oreNoise = mx_noise_float(vec3(p.x.mul(1.7), p.y.mul(2.4), p.z.mul(1.7)));
  const seam = abs(oreNoise).min(abs(oreNoise.add(0.26)).add(float(1).sub(rich).mul(0.5)));
  const vein = float(1).sub(smoothstep(0.012, rich.mul(0.02).add(0.035), seam)).mul(smoothstep(0.10, 0.32, ore));
  const lip = float(1).sub(smoothstep(0.035, 0.06, seam)).mul(smoothstep(0.10, 0.32, ore));
  base = mix(base, color(INK.surface), lip.mul(0.8)) as V3;
  const orePaint = mix(color(LODE_PAINT.ordinary), color(LODE_PAINT.rich), rich) as V3;
  base = mix(base, orePaint, vein) as V3;
  // The open throat receives no flat-ground highlight: depth must read as a void, not a walkable grey basin.
  const lit = mix(cel(base, SHADOW.surface, sun, ao), base.mul(0.72), floorDepth.mul(0.92)) as V3;
  const shadowInk = hatch(lum(lit).div(0.6).clamp(0, 1) as F1, 9).mul(0.22).mul(float(1).sub(smoothstep(0.3, 0.55, sun)));
  const grid = gridInk(marks.sample());
  const crossed = max(
    lines(p.x.add(p.z.mul(0.37)).mul(2.8).add(n2.mul(0.12)) as F1, 0.045),
    lines(p.x.mul(0.25).sub(p.z).mul(2.8).add(n2.mul(0.09)) as F1, 0.03),
  );
  const inked = mix(mix(lit, color(INK.surface), max(shadowInk, grid.mul(0.55))), color('#090e19'), crossed.mul(floorDepth).mul(0.65)) as V3;
  const glow = orePaint.mul(vein).mul(rich.mul(0.25).add(0.08)) as V3;
  const mat = new MeshBasicNodeMaterial({ side: DoubleSide });
  mat.colorNode = mix(finish(inked, 'surface', { glow, tone: lit, fogField }), edgeSection('surface', SKIRT), mapEdge());
  mat.opacityNode = FADE.surface.alpha;
  mat.alphaHash = true;
  mat.mrtNode = planeLines('surface');
  return mat;
}

/**
 * Toon water tunables. Distances are cells from the coast (the shore field), speeds per second of `clock`.
 * Colours: flat bands from shallow to deep; fords are one lighter band over their stepping stones.
 */
const WATER = {
  ford: '#97d4cc', shallow: '#7cc9c6', mid: '#3d9cbc', deep: '#276d97',
  foam: '#f7f3e6', glint: '#fffbe9', stone: '#a89b80', stoneTop: '#cfc3a6',
  /** Band edges: shallow → mid → deep, wobbled by the drifting noise; the ford band's edge wobbles by `fordWobble` of
   * its share. */
  bands: [0.32, 1.05], bandWobble: 0.06, fordWobble: 0.12,
  /** Watercolour pooling: the deep side of a band edge darkens by `pool` over `poolWidth`. */
  pool: 0.12, poolWidth: 0.08,
  /** Opacity over the shallow band and over deep water (foam and stones are opaque). */
  alphaShallow: 0.8, alphaDeep: 0.94,
  /** Shoreline foam rim: width, breathing (fraction) and its rate (rad/s); fords' rim is `fordRim` times wider. */
  rim: 0.08, rimPulse: 0.35, rimRate: 1.6, fordRim: 1.3,
  /** Foam rings travelling out from the rim: rings per cell (fords denser), rings/s, reach, first ring's half width. */
  rings: 2.2, fordRings: 2.6, ringSpeed: 0.4, ringReach: 1.15, ringWidth: 0.17, ringDash: 0.37,
  /** Noise repeat (cells), flow speed (cells/s) and flow-map period (s): two phases cross-fade so drift never stretches. */
  noiseCells: 7, flow: 0.3, period: 4,
  /** Wave crests: brush strokes along one contour of the broad noise at `crest` (breathing ± `crestBreath` at
   * `crestRate`), `crestWidth` cells half-wide (fords' `fordCrest` times), starting `crestFrom` out from the coast. */
  crest: 0.66, crestWidth: 0.045, fordCrest: 1.5, crestBreath: 0.02, crestRate: 0.5, crestFrom: 0.4,
  /** Sun glints: fine-noise threshold, lowered toward `glintSun` where the sheet mirrors the sun (cosine `glintZone`). */
  glintAt: 0.87, glintSun: 0.8, glintZone: 0.9,
} as const;

/**
 * The water's clock-only terms, once per frame rather than per fragment: the flow map's two phases as drift distances
 * (cells: x, y), their cross-fade weight (z) and its variance-preserving normaliser (w), so crests keep their contrast
 * through the cross-fade.
 */
const waterClock = new Vector4();
const WATER_CLOCK = uniform(waterClock).onFrameUpdate(() => {
  const p0 = (clock.value / WATER.period) % 1, p1 = (p0 + 0.5) % 1, w = Math.abs(p0 * 2 - 1);
  waterClock.set(p0 * WATER.flow * WATER.period, p1 * WATER.flow * WATER.period, w, 1 / Math.sqrt(w * w + (1 - w) * (1 - w)));
});
/** The breathing contour the wave crests follow (once per frame). */
const WATER_CREST = uniform(0).onFrameUpdate(() => Math.sin(clock.value * WATER.crestRate) * WATER.crestBreath + WATER.crest);

/**
 * Toon water, Wind Waker by way of the Field Journal: flat colour bands stepping from shallow to deep with distance from
 * the coast, a foam rim hugging every bank, island, hole and ford stone, foam rings pulsing out from it, drifting
 * hard-edged wave crests and sun glints, all from one shore-field sample (distance, flow, ford) and two noise samples
 * (the flow map's two phases). Motion comes only from `clock`; the pencil drawing under fog keeps the static band tone.
 */
function waterMaterial(shore: DataTexture, fogField: FogField): MeshBasicNodeMaterial {
  const s = texture(shore, mapUV());
  const d = s.r.mul(SHORE_SPAN).sub(SHORE.inside);
  const fw = fwidth(d).max(1e-4);
  const flow = s.gb.mul(2).sub(1);
  const fordStill = smoothstep(FORD_A * 0.4, FORD_A * 0.6, s.a);
  const stone = smoothstep(FORD_A + (STONE_A - FORD_A) * 0.1, FORD_A + (STONE_A - FORD_A) * 0.3, s.a).mul(float(1).sub(smoothstep(fw.negate(), fw, d)));
  // flow map: two noise phases half a period apart, each reset while its weight is zero
  const uv0 = positionWorld.xz.sub(flow.mul(WATER_CLOCK.x)).div(WATER.noiseCells);
  const uv1 = positionWorld.xz.sub(flow.mul(WATER_CLOCK.y)).div(WATER.noiseCells).add(vec2(0.37, 0.61));
  const n0 = noise(uv0), n1 = noise(uv1);
  const w = WATER_CLOCK.z, norm = WATER_CLOCK.w;
  const nr = mix(n0.x, n1.x, w).sub(0.5).mul(norm).add(0.5);
  const ng = mix(n0.y, n1.y, w).sub(0.5).mul(norm).add(0.5);
  // the ford's lighter band laps at its edge with the drift instead of following cell edges
  const ford = smoothstep(FORD_A * 0.4, FORD_A * 0.6, s.a.add(ng.sub(0.5).mul(WATER.fordWobble)));
  // colour bands with watercolour pooling on their deep side
  const dw = d.add(ng.sub(0.5).mul(WATER.bandWobble * 2));
  const [b0, b1] = WATER.bands;
  const toMid = smoothstep(fw.negate().add(b0), fw.add(b0), dw), toDeep = smoothstep(fw.negate().add(b1), fw.add(b1), dw);
  const pool = toMid.mul(float(1).sub(smoothstep(b0, b0 + WATER.poolWidth, dw))).max(toDeep.mul(float(1).sub(smoothstep(b1, b1 + WATER.poolWidth, dw))));
  const band = mix(mix(mix(color(WATER.shallow), color(WATER.mid), toMid), color(WATER.deep), toDeep), color(WATER.ford), ford) as V3;
  const stillMid = smoothstep(b0 - 0.02, b0 + 0.02, d);
  const tone = mix(mix(mix(color(WATER.shallow), color(WATER.mid), stillMid), color(WATER.deep), smoothstep(b1 - 0.02, b1 + 0.02, d)), color(WATER.ford), fordStill) as V3;
  let c = band.mul(float(1).sub(pool.mul(WATER.pool).mul(float(1).sub(ford)))) as V3;
  // shoreline foam: a breathing rim on the coast, and dashed rings that leave it and thin out as they travel
  const rimW = mix(float(WATER.rim), float(WATER.rim * WATER.fordRim), ford).mul(sin(clock.mul(WATER.rimRate).add(nr.mul(6.28))).mul(WATER.rimPulse).add(1));
  const rim = float(1).sub(smoothstep(rimW.sub(fw), rimW.add(fw), d.add(ng.sub(0.5).mul(0.08))));
  const fade = float(1).sub(smoothstep(rimW, float(WATER.ringReach), d));
  const ringS = d.mul(mix(float(WATER.rings), float(WATER.fordRings), ford)).sub(clock.mul(WATER.ringSpeed)).add(ng.mul(0.35)) as F1;
  const ring = lines(ringS, fade.mul(WATER.ringWidth) as F1).mul(fade).mul(smoothstep(WATER.ringDash, WATER.ringDash + 0.03, nr));
  // wave crests: a brush stroke of near-constant width along one breathing contour of the distorted broad noise, in
  // pixels from the contour (noise offset over its screen derivative), so flat noise never pools into blobs
  const cn = nr.add(ng.sub(0.5).mul(0.07));
  const cfw = fwidth(cn).max(1e-5);
  const px = fwidth(positionWorld.xz).length().max(1e-5);
  const level = WATER_CREST;
  const stroke = mix(float(WATER.crestWidth), float(WATER.crestWidth * WATER.fordCrest), ford).mul(ng.mul(0.5).add(0.75)).div(px);
  const crest = float(1).sub(smoothstep(stroke.sub(0.75), stroke.add(0.75), abs(cn.sub(level)).div(cfw))).mul(smoothstep(WATER.crestFrom, WATER.crestFrom + 0.25, d));
  const foam = max(rim, max(ring, crest));
  c = mix(c, color(WATER.foam), foam) as V3;
  // sun glints: hard specks of the fine noise, denser where the flat sheet mirrors the sun
  const mirror = reflect(normalize(positionWorld.sub(cameraPosition)), vec3(0, 1, 0));
  const gT = mix(float(WATER.glintAt), float(WATER.glintSun), smoothstep(WATER.glintZone - 0.08, WATER.glintZone, dot(mirror, SUN)));
  const gfw = fwidth(ng).max(1e-4);
  const glint = smoothstep(gT.sub(gfw), gT.add(gfw), ng).mul(smoothstep(0.5, 0.8, d)).mul(float(1).sub(foam));
  c = mix(c, color(WATER.glint), glint) as V3;
  // ford stones: dry tops inside their coast, lighter crowns, inked at the waterline
  const crown = smoothstep(0.03, 0.1, d.negate());
  const stoneInk = float(1).sub(smoothstep(fw, fw.mul(2).add(0.015), d.negate()));
  const stoneCol = mix(mix(color(WATER.stone), color(WATER.stoneTop), crown), color(INK.surface), stoneInk.mul(0.85));
  c = mix(c, stoneCol, stone) as V3;
  const m = overlay(new MeshBasicNodeMaterial());
  m.colorNode = finish(c, 'surface', { fogField, tone: mix(tone, color(WATER.stone), stone) as V3 });
  // static opacity under fog: animated foam turns opaque only where the water is in sight
  const body = mix(float(WATER.alphaShallow), float(WATER.alphaDeep), stillMid);
  const water = smoothstep(fw.negate(), fw, d);
  m.opacityNode = max(water.mul(max(body, foam.mul(seen('surface', fogField)))), stone).mul(FADE.surface.alpha);
  return m;
}

export class SurfaceLayer {
  readonly size: number;
  readonly field: TerrainField;
  readonly group = new Group();
  /** Forest canopies: rendered after the entities so our own units show through them. */
  readonly canopyRoot = new Group();
  /** Cells under telegraphs (charges, impacts): the ink grid shows there. */
  readonly marks: TileMask;
  private readonly builder: FieldBuilder;
  /** Both water sheets (low and high) in one mesh, sharing the toon water material. */
  private readonly water: Mesh<BufferGeometry, MeshBasicNodeMaterial>;
  /** The water's coast (`shore.ts`): baked after each full field build, re-baked only around patched cells. */
  readonly shore: ShoreField;
  private readonly shoreSource: ShoreSource & { readonly cells: Uint8Array };
  private readonly shoreTex: DataTexture;
  private readonly presence: TileMask;
  private readonly lodeMask: TileMask;
  private readonly knownBelow: TileMask;
  private readonly holeLips: HoleLips;
  /** Ground beds the forward posts' mounds sink into. */
  readonly postBeds: PostBeds;
  private readonly lodeGlints: InstancedMesh;
  private readonly richGlints: InstancedMesh;
  private readonly lodeCollars: InstancedMesh;
  private lodes: View['lodes'] = [];
  private readonly trees: InstancedMesh;
  /** Grass tufts and pebbles on open ground (`ground-detail.ts`). */
  readonly ground: GroundDetail;
  private readonly lipCells = new Set<number>();
  private readonly decks: InstancedMesh;
  /** Piers under the footprints of known Surface structures standing over a hole, one per hole cell they cover. */
  private readonly footings: InstancedMesh;
  private readonly footingCells: number[] = [];
  private readonly faultMat: MeshBasicNodeMaterial;
  private faultMesh: Mesh | undefined;
  private faults: readonly Fault[] = [];
  private presenceKey = '';
  private marksKey = '';
  private holesKey = '';
  private footingsKey = '';
  private terrainKey = '';

  ready(): Promise<void> { return this.builder.ready(); }

  /** Borrow the actual draw buffers, not the potentially newer worker bake. */
  get drawnGeometry(): BufferGeometry { return this.builder.mesh.geometry; }

  /** `quality`: the render tier's scatter density and shore resolution. */
  constructor(size: number, fogField = new FogField(size), field = new TerrainField(size), quality: Pick<Quality, 'scatter' | 'shoreRes'> = QUALITY.full) {
    this.size = size;
    this.field = field;
    this.marks = new TileMask(size);
    // open water drifts the way the breeze travels (its wave runs against its wavenumbers), so it agrees with the pines
    this.shore = new ShoreField(size, [-WIND.kx, -WIND.kz], quality.shoreRes);
    this.shoreSource = { size, cells: new Uint8Array(size * size), levels: [LEVEL.ground + WATER_Y, LEVEL.high + WATER_Y], heightAt: (x, y) => this.field.field.heightAt(x, y) };
    this.shoreTex = new DataTexture(this.shore.data, this.shore.n, this.shore.n, RGBAFormat, UnsignedByteType);
    this.shoreTex.magFilter = LinearFilter;
    this.shoreTex.minFilter = LinearFilter;
    this.shoreTex.needsUpdate = true;
    this.presence = new TileMask(size);
    this.lodeMask = new TileMask(size);
    this.knownBelow = new TileMask(size);
    this.canopyRoot.renderOrder = 45; // groupOrder: after entities (40)
    this.builder = new FieldBuilder(field.field, SKIRT, (boxes) => {
      this.placeTrees();
      this.placeDecals();
      this.postBeds.seat(this.field.groundAt);
      this.buildFaults();
      this.placeLodes();
      this.ground.setHeights();
      this.buildShore(boxes);
    }, { field: this.shore, source: this.shoreSource });
    this.ground = new GroundDetail(size, this.group, field.field, fogField, quality);
    const terrain = new Mesh(this.builder.mesh.geometry, terrainMaterial(this.marks, this.lodeMask, this.knownBelow, this.ground.strokes(), fogField));
    terrain.frustumCulled = false;
    this.group.add(terrain);
    this.water = new Mesh(emptyGeometry(), waterMaterial(this.shoreTex, fogField));
    this.water.name = 'surface-water';
    this.water.renderOrder = 2;
    this.water.frustumCulled = false;
    this.group.add(this.water);

    const show = this.presence.sample();
    // over our own units the canopy thins to a dithered shell
    this.trees = this.instanced(treeGeometry(), inkMaterial('surface', attribute<'vec3'>('paint', 'vec3') as V3, { fogField, alpha: float(1).sub(smoothstep(0.1, 0.6, show).mul(0.72)) as F1 }), this.field.terrainCodes.length * 3, this.canopyRoot);
    // a constant breeze bends the pines, more toward their tips (the island groves' bend, without a storm)
    (this.trees.material as MeshBasicNodeMaterial).positionNode = positionLocal.add(windBend(positionGeometry.y as F1));

    this.holeLips = new HoleLips(this.group, size, fogField);
    this.postBeds = new PostBeds(size, fogField);
    this.group.add(this.postBeds.mesh);
    // bridge decks: planks across a bridged chasm cell
    const plank = smoothstep(0.08, 0.14, abs(positionWorld.x.add(positionWorld.z).mul(4).fract().sub(0.5)));
    this.decks = this.instanced(new BoxGeometry(1, 0.08, 1).translate(0, 0.02, 0), inkMaterial('surface', mix(color('#6b4a32'), color('#a07a52'), plank) as V3, { fogField }), this.field.terrainCodes.length);
    // footings: a timbered stone pier from the pit floor up to the ground the structure stood on (unit height, scaled)
    const course = smoothstep(0.1, 0.18, abs(positionWorld.y.mul(5).fract().sub(0.5)));
    this.footings = this.instanced(new BoxGeometry(0.92, 1, 0.92).translate(0, 0.5, 0), inkMaterial('surface', mix(color('#4a3d31'), color('#8c7a62'), course) as V3, { fogField }), this.field.terrainCodes.length);
    this.footings.name = 'surface-footings';
    this.lodeGlints = this.instanced(new OctahedronGeometry(0.085).scale(0.65, 1.6, 0.65), inkMaterial('surface', color(LODE_PAINT.ordinary) as unknown as V3, { fogField, glow: color(LODE_PAINT.ordinary).mul(0.22) as V3 }), this.field.terrainCodes.length * 3);
    this.richGlints = this.instanced(this.lodeGlints.geometry, inkMaterial('surface', color(LODE_PAINT.rich) as unknown as V3, { fogField, glow: color(LODE_PAINT.rich).mul(0.45) as V3 }), this.field.terrainCodes.length * 3);
    this.lodeCollars = this.instanced(merge([
      { geo: new RingGeometry(0.26, 0.43, 10).rotateX(-Math.PI / 2).translate(0, 0.065, 0), paint: '#a9978a' },
      { geo: new CylinderGeometry(0.43, 0.43, 0.08, 10, 1, true).translate(0, 0.025, 0), paint: '#a9978a' },
      { geo: new CylinderGeometry(0.26, 0.26, 0.055, 10, 1, true).translate(0, 0.035, 0), paint: '#65554c' },
      { geo: new CylinderGeometry(0.25, 0.25, 0.01, 10).translate(0, 0.01, 0), paint: '#2b2019' },
    ]), inkMaterial('surface', attribute<'vec3'>('paint', 'vec3') as V3, { fogField }), this.field.terrainCodes.length);
    this.faultMat = this.faultMaterial();
    this.update([]);
  }

  private instanced(geo: BufferGeometry, mat: Material, cap: number, parent: Group = this.group): InstancedMesh {
    const m = new InstancedMesh(geo, mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    parent.add(m);
    return m;
  }

  /** Fault lines: a charred ink crack with a pulsing hot core (public, never fogged). */
  private faultMaterial(): MeshBasicNodeMaterial {
    const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    const along = attribute<'float'>('along', 'float');
    const jag = mx_noise_float(vec3(along.mul(6), 0, 0)).mul(0.35);
    const across = abs(uv().y.sub(0.5)).mul(2).add(jag); // 0 at the core, 1 at the edge
    const core = float(1).sub(smoothstep(0.1, 0.3, across));
    const pulse = smoothstep(0.6, 1, sin(along.mul(0.8).sub(time.mul(1.5))).mul(0.5).add(0.5));
    m.colorNode = mix(color(INK.surface), color('#ff8a3a').mul(1.6), core.mul(pulse.mul(0.7).add(0.2)).mul(FADE.surface.focus));
    m.opacityNode = max(core, float(1).sub(smoothstep(0.4, 0.9, across)).mul(0.5)).mul(FADE.surface.alpha).mul(FADE.surface.focus.mul(0.6).add(0.4));
    return m;
  }

  /** Static terrain for this match (or the lobby backdrop). Rebuilt only when the terrain or the light differs. */
  setTerrain(t: TerrainData): void {
    let hsh = 2166136261;
    for (let i = 0; i < this.field.terrainCodes.length; i++) hsh = Math.imul(hsh ^ t.codes[i]!, 16777619);
    for (const f of t.faults) for (const c of f.cells) hsh = Math.imul(hsh ^ (c.y * this.size + c.x), 16777619);
    for (const p of t.posts) hsh = Math.imul(hsh ^ (Math.floor(p.y) * this.size + Math.floor(p.x)), 16777619);
    const key = `${hsh}|${t.faults.length}|${SUN_DIR.x.toFixed(2)}`;
    if (key === this.terrainKey) return;
    this.terrainKey = key;
    this.field.terrainCodes.set(t.codes);
    this.ground.setMap(this.field.terrainCodes, hsh >>> 0, t.posts);
    this.faults = t.faults;
    this.postBeds.set(t.posts);
    this.field.opened.fill(0);
    for (const [c] of this.field.holeAt) if (this.field.holeAt.get(c) === 'chasm') this.field.opened[c] = 1;
    for (let i = 0; i < this.field.terrainCodes.length; i++) {
      this.field.cellInput(i, this.field.terrainCodes, this.builder.level, this.builder.cls);
    }
    // the shore source cells first: without a worker the full build reports back (and bakes the shore) at once
    this.waterCells();
    this.builder.full(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z);
  }

  /** The shore source cells: wet per sheet, fords, and holes as solid coast. */
  private waterCells(): void {
    const { terrainCodes, holeAt, opened } = this.field;
    const cells = this.shoreSource.cells;
    for (let i = 0; i < terrainCodes.length; i++) {
      const code = terrainCodes[i]!, feature = surfaceFeature(code);
      if (holeAt.has(i) || opened[i]) cells[i] = SHORE_CELL.solid;
      else if (feature === SURFACE.ford || feature === SURFACE.water) cells[i] = (isSurfaceHigh(code) ? SHORE_CELL.high : SHORE_CELL.low) | (feature === SURFACE.ford ? SHORE_CELL.ford : 0);
      else cells[i] = 0;
    }
  }

  /**
   * Both public elevations' flat sheets in one mesh (one draw), from the baked shore field: over each sheet's wet cells
   * and their dry neighbours (so the coast rounds off over the banks), less the half-cell squares the shore field
   * leaves dry within a texel, which could only shade fully transparent fragments. Each half-cell row's kept squares
   * merge into one quad per run: small triangles would cost more in edge overshading than the trim saves.
   */
  private waterSheet(): void {
    const S = this.size, cells = this.shoreSource.cells;
    const { res: R, n, data } = this.shore;
    const sub = WATER_SHEET_SUB, cols = S * sub;
    // any texel the linear filter can read inside the square holds water (r > 0: nearer the coast than the land limit)
    const wet = (x0: number, y0: number, x1: number, y1: number): boolean => {
      for (let j = Math.max(0, Math.floor(y0 * R) - 1); j <= Math.min(n - 1, Math.ceil(y1 * R)); j++)
        for (let i = Math.max(0, Math.floor(x0 * R) - 1); i <= Math.min(n - 1, Math.ceil(x1 * R)); i++) if (data[(j * n + i) * 4]! > 0) return true;
      return false;
    };
    const keep = (sheet: number, c: number, r: number): boolean => {
      const x = Math.floor(c / sub), y = Math.floor(r / sub);
      if (cells[y * S + x]! & SHORE_CELL.solid) return false;
      let near = false;
      for (let dy = Math.max(0, y - 1); dy <= Math.min(S - 1, y + 1) && !near; dy++)
        for (let dx = Math.max(0, x - 1); dx <= Math.min(S - 1, x + 1); dx++) if (cells[dy * S + dx]! & sheet) near = true;
      return near && wet(c / sub, r / sub, (c + 1) / sub, (r + 1) / sub);
    };
    const positions: number[] = [];
    for (const sheet of [SHORE_CELL.low, SHORE_CELL.high]) {
      const height = PLANE_Y.surface + (sheet === SHORE_CELL.high ? LEVEL.high : LEVEL.ground) + WATER_Y;
      for (let r = 0; r < cols; r++) {
        const z0 = wz(r / sub, S), z1 = wz((r + 1) / sub, S);
        for (let c = 0; c < cols; c++) {
          if (!keep(sheet, c, r)) continue;
          const start = c;
          while (c + 1 < cols && keep(sheet, c + 1, r)) c++;
          const x0 = wx(start / sub, S), x1 = wx((c + 1) / sub, S);
          positions.push(x0, height, z0, x0, height, z1, x1, height, z1, x0, height, z0, x1, height, z1, x1, height, z0);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    this.water.geometry.dispose();
    this.water.geometry = geometry;
  }

  /**
   * The shore texture follows the drawn heights: a full field build brought its shore bake along (`FieldBuilder`); a
   * patch re-bakes here only around the patched cell boxes (grown by the field window's padding) that have water or a
   * hole within the shore's reach. The water sheet follows the new coast.
   */
  private buildShore(boxes?: readonly number[]): void {
    if (boxes) {
      const S = this.size, cells = this.shoreSource.cells, r = SHORE.reach + 1;
      let built = false;
      for (let k = 0; k < boxes.length; k += 4) {
        const box = { x0: boxes[k]! - PATCH_PAD, y0: boxes[k + 1]! - PATCH_PAD, x1: boxes[k + 2]! + PATCH_PAD, y1: boxes[k + 3]! + PATCH_PAD };
        let near = false;
        for (let y = Math.max(0, box.y0 - r); y <= Math.min(S - 1, box.y1 + r) && !near; y++)
          for (let x = Math.max(0, box.x0 - r); x <= Math.min(S - 1, box.x1 + r); x++) if (cells[y * S + x]) { near = true; break; }
        if (!near) continue;
        this.shore.build(this.shoreSource, box);
        built = true;
      }
      if (!built) return;
    }
    this.shoreTex.needsUpdate = true;
    this.waterSheet();
  }

  /** Holes or known lodes changed: rebuild only changed field windows, then seat details on the finished bake. */
  update(holes: View['holes'], lodes: View['lodes'] = []): void {
    let key = '';
    for (const h of holes) key += `${h.x},${h.y},${h.kind};`;
    for (const l of lodes) key += `l${l.x},${l.y},${+l.open},${+l.rich};`;
    if (key === this.holesKey) return;
    this.holesKey = key;
    this.lodes = lodes;
    this.field.lodeInputs(lodes);
    const mask = this.lodeMask.data;
    mask.fill(0);
    for (const l of lodes) {
      const f = STATS.headframe.footprint;
      for (let dy = (1 - f.h) / 2; dy < (1 + f.h) / 2; dy++) for (let dx = (1 - f.w) / 2; dx < (1 + f.w) / 2; dx++) {
        const x = l.x + dx;
        const y = l.y + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size || !this.field.lodeHeight[y * this.size + x]) continue;
        mask[y * this.size + x] = l.rich ? 255 : 128;
      }
    }
    this.lodeMask.tex.needsUpdate = true;
    this.field.holeAt.clear();
    for (const h of holes) {
      const c = h.y * this.size + h.x;
      this.field.holeAt.set(c, h.kind);
      if (h.kind === 'chasm') this.field.opened[c] = 1;
    }
    this.waterCells();
    for (let i = 0; i < this.field.terrainCodes.length; i++) this.field.cellInput(i, this.field.terrainCodes, this.builder.level, this.builder.cls);
    if (!this.builder.patch()) {
      this.placeDecals();
      this.postBeds.seat(this.field.groundAt);
      this.placeLodes();
    }
  }

  /** A faint floor hint from known team data only, independent of changes to the Surface hole set. */
  setDepths(cells: View['depths']): void {
    let changed = false;
    const data = this.knownBelow.data;
    for (let i = 0; i < this.field.terrainCodes.length; i++) {
      const c = cells[i] ?? 0;
      const value = c === CELL.tunnel || c === CELL.rail ? 255 : c > CELL.unknown ? 80 : 0;
      if (data[i] !== value) { data[i] = value; changed = true; }
    }
    if (changed) this.knownBelow.tex.needsUpdate = true;
  }

  /** Only small mineral glints and a bored collar remain as geometry; the rock itself belongs to the terrain. */
  private placeLodes(): void {
    let glints = 0;
    let richGlints = 0;
    let collars = 0;
    tmp.rotation.set(0, 0, 0);
    tmp.scale.set(1, 1, 1);
    for (const l of this.lodes) {
      if (this.field.holeAt.has(l.y * this.size + l.x)) continue;
      if (l.open) {
        // Seat the lip above its whole footprint, not just the low bore centre: rough rock must not pierce the rim.
        let rim = this.field.groundAt(l.x + 0.5, l.y + 0.5);
        for (let j = 0; j < 10; j++) {
          const a = j * Math.PI / 5;
          rim = Math.max(rim, this.field.groundAt(l.x + 0.5 + Math.cos(a) * 0.43, l.y + 0.5 + Math.sin(a) * 0.43));
        }
        tmp.position.set(wx(l.x + 0.5, this.size), PLANE_Y.surface + rim + 0.015, wz(l.y + 0.5, this.size));
        tmp.updateMatrix();
        this.lodeCollars.setMatrixAt(collars++, tmp.matrix);
      }
      for (let j = 0; j < (l.rich ? 3 : 2); j++) {
        const a = j * 2.4 + l.x * 0.7;
        const x = l.x + 0.5 + Math.cos(a) * STATS.headframe.footprint.w * (l.open ? 0.36 : 0.3);
        const y = l.y + 0.5 + Math.sin(a) * STATS.headframe.footprint.h * (l.open ? 0.36 : 0.3);
        tmp.position.set(wx(x, this.size), PLANE_Y.surface + this.field.groundAt(x, y) + 0.025, wz(y, this.size));
        tmp.updateMatrix();
        if (l.rich) this.richGlints.setMatrixAt(richGlints++, tmp.matrix);
        else this.lodeGlints.setMatrixAt(glints++, tmp.matrix);
      }
    }
    this.lodeGlints.count = glints;
    this.richGlints.count = richGlints;
    this.lodeCollars.count = collars;
    this.lodeGlints.instanceMatrix.needsUpdate = true;
    this.richGlints.instanceMatrix.needsUpdate = true;
    this.lodeCollars.instanceMatrix.needsUpdate = true;
  }

  /** Three pines per forest cell, standing on the field. */
  private placeTrees(): void {
    let nt = 0;
    for (let i = 0; i < this.field.terrainCodes.length; i++) {
      if (surfaceFeature(this.field.terrainCodes[i]!) !== SURFACE.forest || this.field.holeAt.has(i) || this.field.opened[i]) continue;
      const x = i % this.size;
      const z = (i / this.size) | 0;
      for (let j = 0; j < 3; j++) {
        const tx = x + 0.5 + (hash2(x * 3 + j, z * 5) - 0.5) * 0.62;
        const tz = z + 0.5 + (hash2(z * 7 + j, x * 11) - 0.5) * 0.62;
        const s = 0.95 * (0.85 + hash2(x + j * 17, z + 3) * 0.5);
        tmp.position.set(wx(tx, this.size), PLANE_Y.surface + this.field.field.heightAt(tx, tz) - 0.02, wz(tz, this.size));
        tmp.rotation.set(0, hash2(j, x + z) * 6.28, 0);
        tmp.scale.set(s, s * (0.85 + hash2(z, j) * 0.4), s);
        tmp.updateMatrix();
        this.trees.setMatrixAt(nt++, tmp.matrix);
      }
    }
    this.trees.count = nt;
    this.trees.instanceMatrix.needsUpdate = true;
  }

  /** One shared exposed-boundary lip, plus decks on bridged cells. No detail on internal cell joins. */
  private placeDecals(): void {
    this.lipCells.clear();
    let nd = 0;
    tmp.rotation.set(0, 0, 0);
    tmp.scale.set(1, 1, 1);
    for (let i = 0; i < this.field.terrainCodes.length; i++) {
      const cx = wx((i % this.size) + 0.5, this.size);
      const cz = wz(((i / this.size) | 0) + 0.5, this.size);
      const k = this.field.holeAt.get(i);
      if (k || this.field.opened[i]) this.lipCells.add(i);
      if (!k && this.field.opened[i]) {
        tmp.position.set(cx, PLANE_Y.surface, cz);
        tmp.updateMatrix();
        this.decks.setMatrixAt(nd++, tmp.matrix);
      }
    }
    this.decks.count = nd;
    this.decks.instanceMatrix.needsUpdate = true;
    this.holeLips.rebuild(this.lipCells, (x, y) => this.field.field.heightAt(x, y));
  }

  /** Jagged ribbons through the fault cells (skipping opened chasms), with the running length for the pulse. */
  private buildFaults(): void {
    if (this.faultMesh) {
      this.group.remove(this.faultMesh);
      this.faultMesh.geometry.dispose();
      this.faultMesh = undefined;
    }
    const pos: number[] = [];
    const uvs: number[] = [];
    const along: number[] = [];
    const W = 0.26;
    const sunk = (x: number, y: number) => this.field.opened[Math.floor(y) * this.size + Math.floor(x)] === 1 || this.field.holeAt.has(Math.floor(y) * this.size + Math.floor(x));
    for (const [fi, f] of this.faults.entries()) {
      const pts: [number, number][] = [];
      const c = f.cells;
      for (let i = 0; i < c.length; i++) {
        const a = c[i]!;
        pts.push([a.x + 0.5, a.y + 0.5]);
        const b = c[i + 1];
        if (!b) continue;
        // two jittered midpoints per step so the crack zig-zags
        for (const t of [0.33, 0.66]) {
          const mx = a.x + 0.5 + (b.x - a.x) * t;
          const my = a.y + 0.5 + (b.y - a.y) * t;
          const j = (hash2(a.x * 13 + fi, a.y * 7 + Math.round(t * 9)) - 0.5) * 0.5;
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          pts.push([mx - ((b.y - a.y) / len) * j, my + ((b.x - a.x) / len) * j]);
        }
      }
      let run = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay] = pts[i]!;
        const [bx, by] = pts[i + 1]!;
        const len = Math.hypot(bx - ax, by - ay) || 1e-4;
        run += len;
        const nx = (-(by - ay) / len) * W;
        const ny = ((bx - ax) / len) * W;
        // Tessellate both along and across the ribbon: its lateral edges must follow slopes too.
        const steps = Math.max(1, Math.ceil(len * 8));
        const point = (t: number, v: number): [number, number, number, number] =>
          [ax + (bx - ax) * t + nx * (1 - 2 * v), ay + (by - ay) * t + ny * (1 - 2 * v), v, run - len + len * t];
        for (let j = 0; j < steps; j++) for (let k = 0; k < 4; k++) {
          const a = point(j / steps, k / 4), b = point((j + 1) / steps, k / 4);
          const c = point((j + 1) / steps, (k + 1) / 4), d = point(j / steps, (k + 1) / 4);
          // A small quad touching any removed cell is omitted, not draped down its pit or across its lip.
          let cut = false;
          const minX = Math.floor(Math.min(a[0], b[0], c[0], d[0])), maxX = Math.floor(Math.max(a[0], b[0], c[0], d[0]));
          const minY = Math.floor(Math.min(a[1], b[1], c[1], d[1])), maxY = Math.floor(Math.max(a[1], b[1], c[1], d[1]));
          for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (sunk(x, y)) cut = true;
          if (cut) continue;
          for (const [px, pz, v, s] of [a, b, c, a, c, d]) {
            pos.push(wx(px, this.size), PLANE_Y.surface + this.field.field.heightAt(px, pz) + 0.035, wz(pz, this.size));
            uvs.push(s, v);
            along.push(s);
          }
        }
      }
    }
    if (!pos.length) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    g.setAttribute('along', new BufferAttribute(new Float32Array(along), 1));
    this.faultMesh = new Mesh(g, this.faultMat);
    this.faultMesh.name = 'surface-faults';
    this.faultMesh.frustumCulled = false;
    this.faultMesh.renderOrder = 1;
    this.group.add(this.faultMesh);
  }

  /** Cells under telegraphs (charges' collapse zones, asteroid impact zones) show the ink grid. */
  setMarks(view: View): void {
    let key = '';
    for (const c of view.charges) key += `c${c.x},${c.y};`;
    for (const i of view.impacts) key += `i${Math.round(i.x * 4)},${Math.round(i.y * 4)},${i.radius ?? ECON.impactRadius};`;
    if (key === this.marksKey) return;
    this.marksKey = key;
    const d = this.marks.data;
    d.fill(0);
    const stamp = (cx: number, cy: number, r: number) => {
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(this.size - 1, Math.floor(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(this.size - 1, Math.floor(cx + r)); x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) d[y * this.size + x] = 255;
    };
    for (const c of view.charges) stamp(c.x + 0.5, c.y + 0.5, ECON.collapseRadius);
    for (const i of view.impacts) stamp(i.x, i.y, i.radius ?? ECON.impactRadius);
    this.marks.tex.needsUpdate = true;
  }

  /** Our own surface units thin the canopy over their tile and its neighbours. */
  setPresence(view: View): void {
    const d = this.presence.data;
    let key = '';
    for (const e of view.entities) if (e.side === view.army && e.plane === 'surface' && surfaceFeature(this.field.terrainCodes[Math.floor(e.y) * this.size + Math.floor(e.x)]!) === SURFACE.forest) key += `${Math.floor(e.x)},${Math.floor(e.y)};`;
    if (key === this.presenceKey) return;
    this.presenceKey = key;
    d.fill(0);
    for (const e of view.entities) {
      if (e.side !== view.army || e.plane !== 'surface') continue;
      const cx = Math.floor(e.x);
      const cy = Math.floor(e.y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
          const v = dx === 0 && dy === 0 ? 255 : 150;
          const o = y * this.size + x;
          if (d[o]! < v) d[o] = v;
        }
    }
    this.presence.tex.needsUpdate = true;
  }

  /**
   * Footings under Surface structures the team knows of (seen or remembered) that stand over a hole: a pier per hole
   * cell of the footprint, from the pit floor up to the ground it stood on (TerrainField.footingAt). Fogged data only;
   * re-placed only when the covered hole cells change.
   */
  setFootings(view: View): void {
    const cells = this.footingCells;
    cells.length = 0;
    const holes = this.field.holeAt;
    if (holes.size) {
      const add = (kind: Kind, x: number, y: number): void => {
        const f = footprint(kind);
        if (!f) return;
        // Presented positions never sit on a cell edge (one 1/VIEW_GRID step off it), so a footprint edge that lies on
        // one is read back onto it: the sim's own cells (stampFootprint), not an extra row and column of the pit.
        for (let yy = Math.max(0, Math.floor(y - f.h / 2 + 1 / VIEW_GRID)); yy < Math.min(this.size, Math.ceil(y + f.h / 2 - 1 / VIEW_GRID)); yy++) {
          for (let xx = Math.max(0, Math.floor(x - f.w / 2 + 1 / VIEW_GRID)); xx < Math.min(this.size, Math.ceil(x + f.w / 2 - 1 / VIEW_GRID)); xx++) {
            const c = yy * this.size + xx;
            if (holes.has(c) && !cells.includes(c)) cells.push(c);
          }
        }
      };
      for (const e of view.entities) if (e.plane === 'surface') add(e.kind, e.x, e.y);
      for (const g of view.memory) if (g.plane === 'surface') add(g.kind, g.x, g.y);
    }
    let key = '';
    for (const c of cells) key += `${c}${holes.get(c)};`;
    if (key === this.footingsKey) return;
    this.footingsKey = key;
    tmp.rotation.set(0, 0, 0);
    let n = 0;
    for (const c of cells) {
      const x = (c % this.size) + 0.5, y = Math.floor(c / this.size) + 0.5;
      const floor = HOLE_LEVEL[holes.get(c)!] ?? LEVEL.sinkhole;
      tmp.position.set(wx(x, this.size), PLANE_Y.surface + floor, wz(y, this.size));
      tmp.scale.set(1, this.field.footingAt(x, y) - floor, 1);
      tmp.updateMatrix();
      this.footings.setMatrixAt(n++, tmp.matrix);
    }
    tmp.scale.set(1, 1, 1);
    this.footings.count = n;
    this.footings.instanceMatrix.needsUpdate = true;
  }

  /** Ground detail claims and frees cells with the holes and the buildings this view knows of. */
  setGroundDetail(view: View): void {
    this.ground.update(view, this.field.holeAt, this.field.opened);
  }

  /** Back to the lobby: no presence, no bridged chasms. */
  reset(): void {
    this.presence.data.fill(0);
    this.presence.tex.needsUpdate = true;
    this.presenceKey = '';
    this.field.opened.fill(0);
    this.field.holeAt.clear();
    this.lodes = [];
    this.field.lodeHeight.fill(0);
    this.lodeMask.data.fill(0);
    this.lodeMask.tex.needsUpdate = true;
    this.lodeGlints.count = 0;
    this.richGlints.count = 0;
    this.lodeCollars.count = 0;
    this.holesKey = '\u0000';
    this.lipCells.clear();
    this.holeLips.rebuild(this.lipCells, () => 0);
    this.knownBelow.data.fill(0);
    this.knownBelow.tex.needsUpdate = true;
    this.footings.count = 0;
    this.footingsKey = '';
    this.ground.reset();
  }
}
