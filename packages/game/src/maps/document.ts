/** Server-side map authoring format. Only public terrain/identity belong in client bootstraps. */
import { STATS, STRUCTURE_SPACING, surfaceSiteLevel } from '../rules/stats.ts';
import { CELL, MOTHER_LODE_MAX_CELLS, SPIRE_INSET_MIN, SPIRE_INSET_MAX, SURFACE, isOpenCell, isOreCell, isSurfaceCode, isSurfaceHigh, isSurfaceWet, surfaceFeature } from '../rules/terrain.ts';
import { MAP_SIZES, MAX_CONTESTED_POSTS, MAX_POST_COUNT, POST_KINDS, TERRAIN_PRESETS, type PostKind, type TerrainPreset } from '../rules/vocabulary.ts';
import { GEOM_EPS, norm, TAU, ZERO_EPS } from '../util/math.ts';
import type { MapPost, OrbitRegion, World } from './types.ts';
import { dmath } from '../util/fdlibm.js';

export const MAP_DOCUMENT_VERSION = 1 as const;
/** UTF-8 JSON limits: inline match options versus host-side named map files. */
export const INLINE_MAP_DOCUMENT_BYTES = 128 * 1024;
export const MAX_MAP_DOCUMENT_BYTES = 1024 * 1024;
/** Public map identity: ids are lowercase identifiers of at most MAP_ID_MAX characters; label and identity lengths. */
export const MAP_ID_PATTERN = /^[a-z][a-z0-9_]{0,95}$/;
export const MAP_ID_MAX = 96;
export const MAP_LABEL_MAX = 128;
export const MAP_IDENTITY_MAX = 512;
/** Lode loads: at least one per pocket cell (8), at most a full Uint8 ore cell (255) each. */
const LODE_LOADS_MIN = 8;
const LODE_LOADS_MAX = 8 * 255;
/** An authored island's distance from the centre must equal its orbit radius up to JSON float rounding (tiles). */
const ISLAND_ORBIT_TOLERANCE = 1e-7;
export const MAP_LAYER_NAMES = ['Surface', 'Depths', 'Ore', 'Owner', 'Magma', 'Cavern'] as const;
export type MapLayerName = (typeof MAP_LAYER_NAMES)[number];
export interface MapMetadata {
  id: string; label: string; identity: string; seed: number; size: number; sides: 2 | 4;
  spireInset: number; preset: TerrainPreset;
}
/**
 * A way to play the map: `teams` lists the alliances by slot. Every slot is assigned once, except a `duel` on a
 * four-slot map: two opposite slots (the others stay empty, neutral ground). `supported`: launchable now (four-slot
 * `rotational` FFA and `duel`; `adjacent`/`opposite` alliances arrive with colour teams, docs/ROADMAP.md).
 */
export interface MapLayout {
  id: string;
  teams: number[][];
  supported: boolean;
  fairness: 'rotational' | 'adjacent' | 'opposite' | 'duel';
}
export type MapField =
  | { __identifier: 'slot' | 'loads' | 'order' | 'rotation' | 'oreCapacity'; __type: 'Int'; __value: number }
  | { __identifier: 'r' | 'w' | 'width' | 'height' | 'dx' | 'dy' | 'weight' | 'spread'; __type: 'Float'; __value: number }
  | { __identifier: 'rich'; __type: 'Bool'; __value: boolean }
  | { __identifier: 'path' | 'kind'; __type: 'String'; __value: string }
  | { __identifier: 'cells'; __type: 'Array<Int>'; __value: number[] };
/**
 * Actual LDtk entity fields: no opaque string-encoded feature payloads. A MotherLode marks one Mother Lode cell (its
 * canonical cell; the Depths layer holds CELL.lode there and at every rotation): public, so a generated map's public
 * document and hash carry it while its hidden layers are zeroed. A Post is a forward post (DESIGN §4.2 Outposts): `kind`
 * home (of map slot `slot`, turned with the map like every feature: its rotation r belongs to slot (slot + r) mod
 * sides) or contested (no `slot`). It stands on its cell's centre, or exactly on the map centre (contested only: the
 * one point every turn fixes, stored once). A RichOre marks one green rich-ore cell (its canonical cell; the Depths layer
 * holds CELL.rich there and at every rotation), public like a MotherLode; its loads stay in the hidden Ore layer.
 */
export const MAP_ENTITY_FIELDS = {
  StartSlot: { slot: 'Int' },
  Fault: { path: 'String', order: 'Int', rotation: 'Int', cells: 'Array<Int>' },
  Lode: { rich: 'Bool', loads: 'Int' },
  Island: { r: 'Float', w: 'Float', oreCapacity: 'Int' },
  OrbitRegion: { width: 'Float', height: 'Float', dx: 'Float', dy: 'Float', weight: 'Float', spread: 'Float' },
  MotherLode: {},
  Post: { kind: 'String', slot: 'Int' },
  RichOre: {},
} as const;
/** Fields an entity may omit: a contested Post has no slot; an ordinary authored island defaults to zero ore. */
const OPTIONAL_ENTITY_FIELDS: Partial<Record<keyof typeof MAP_ENTITY_FIELDS, readonly string[]>> = { Post: ['slot'], Island: ['oreCapacity'] };
export interface MapEntity {
  __identifier: 'StartSlot' | 'Fault' | 'Lode' | 'Island' | 'OrbitRegion' | 'MotherLode' | 'Post' | 'RichOre';
  iid: string;
  /** Integer cell coordinate in the canonical sector; Island/OrbitRegion retain their exact point in px. */
  __grid: [number, number];
  /** Point coordinates in world tiles; the LDtk adapter converts them to pixels. */
  px: [number, number];
  fieldInstances: MapField[];
}
export interface MapIntGridLayer {
  __identifier: MapLayerName; __type: 'IntGrid'; __cWid: number; __cHei: number;
  /** Alternating positive run length and cell code, covering exactly the canonical sector. */
  __gridSize: 1; intGridRle: number[];
}
export interface MapEntityLayer {
  __identifier: 'Features'; __type: 'Entities'; __cWid: number; __cHei: number;
  __gridSize: 1; entityInstances: MapEntity[];
}
export interface MapDocument extends MapMetadata {
  version: typeof MAP_DOCUMENT_VERSION;
  symmetry: 'C2' | 'C4';
  layouts: MapLayout[];
  levels: [{ identifier: 'Canonical'; worldX: 0; worldY: 0; pxWid: number; pxHei: number;
    layerInstances: (MapIntGridLayer | MapEntityLayer)[] }];
  generation: World['generation'];
}
export interface SlotFairness {
  slot: number;
  /** Geometric tiles: cardinal 1, diagonal 1.414, with no corner cutting (not movement-time seconds). */
  surfaceDistances: (number | null)[];
  depthsDistances: (number | null)[];
  accessibleOre: number;
  sectorOre: number;
  accessibleLodes: number;
  accessibleLodeLoads: number;
  nearestOre: number | null;
  nearestLode: number | null;
  cumulativeOreDistance: number;
  cumulativeLodeDistance: number;
  chokeClearance: number;
  exposure: { openCells: number; highCells: number; entrances: number };
}
export interface MapFairness {
  slots: SlotFairness[];
  resources: { cell: number; loads: number; rich: boolean; clearance: number;
    distances: (number | null)[]; exposure: SlotFairness['exposure'] }[];
  layouts: { id: string; classification: MapLayout['fairness']; teams: number[][]; equalRotatedSlots: boolean;
    enemyDistances: (number | null)[][] }[];
}
export interface MapValidationResult {
  valid: boolean; errors: string[]; fairness: MapFairness | null;
}
type Point = { x: number; y: number };
interface FaultData { path: string; order: number; rotation: number; cells: [number, number][] }
interface LodeData { rich: boolean; loads: number }
interface IslandData { r: number; w: number; oreCapacity?: number }
interface PostData { kind: PostKind; slot?: number }
/** Is the point `px` exactly the map centre (the one point every turn of the map fixes)? */
const isCentrePoint = (px: readonly [number, number] | readonly number[], size: number): boolean => px[0] === size / 2 && px[1] === size / 2;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Angle normalised to [0, TAU). */
const angle = (a: number): number => ((a % TAU) + TAU) % TAU;
const turns = (sides: 2 | 4): number => 4 / sides;
export function rotateCell(c: number, size: number, quarterTurns = 1): number {
  let x = c % size, y = Math.floor(c / size);
  for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) [x, y] = [size - 1 - y, x];
  return y * size + x;
}
export function rotatePoint(p: Point, size: number, quarterTurns = 1): Point {
  let { x, y } = p;
  for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) [x, y] = [size - y, x];
  return { x, y };
}
export function rotateVector(vector: Point, quarterTurns = 1): Point {
  let { x, y } = vector;
  for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) [x, y] = [-y, x];
  return { x, y };
}
/** Placement rectangle and approach vector only: no collision or movement rules are introduced. */
export function rotateOrbitRegion(region: OrbitRegion, size: number, quarterTurns = 1): OrbitRegion {
  const point = rotatePoint(region, size, quarterTurns), vector = rotateVector({ x: region.dx, y: region.dy }, quarterTurns);
  const odd = Math.abs(quarterTurns % 2) === 1;
  return { ...region, ...point, width: odd ? region.height : region.width, height: odd ? region.width : region.height,
    dx: vector.x, dy: vector.y };
}
export function canonicalDimensions(size: number, sides: 2 | 4): { width: number; height: number } {
  return { width: sides === 2 ? size : size / 2, height: size / 2 };
}
export function isCanonicalCell(x: number, y: number, size: number, sides: 2 | 4): boolean {
  const { width, height } = canonicalDimensions(size, sides);
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
}
function canonicalize(c: number, size: number, sides: 2 | 4): { c: number; rotation: number } {
  for (let r = 0; r < sides; r++) {
    const k = rotateCell(c, size, -r * turns(sides));
    if (isCanonicalCell(k % size, Math.floor(k / size), size, sides)) return { c: k, rotation: r };
  }
  throw new Error('Cell outside map');
}
export function mapLayer(document: MapDocument, name: MapLayerName): MapIntGridLayer {
  return document.levels[0].layerInstances.find((l): l is MapIntGridLayer => l.__identifier === name)!;
}
export function encodeIntGrid(values: readonly number[]): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (result.length && result[result.length - 1] === value) result[result.length - 2]!++;
    else result.push(1, value);
  }
  return result;
}
export function mapLayerValues(document: MapDocument, name: MapLayerName): number[] {
  const layer = mapLayer(document, name), values: number[] = [];
  for (let i = 0; i < layer.intGridRle.length; i += 2) {
    const count = layer.intGridRle[i]!, value = layer.intGridRle[i + 1]!;
    if (!int(count, 1, layer.__cWid * layer.__cHei) || values.length + count > layer.__cWid * layer.__cHei) throw new Error(`Invalid ${name} run length`);
    for (let k = 0; k < count; k++) values.push(value);
  }
  if (values.length !== layer.__cWid * layer.__cHei) throw new Error(`Incomplete ${name} IntGrid`);
  return values;
}
export function setMapLayerValues(document: MapDocument, name: MapLayerName, values: readonly number[]): void {
  const layer = mapLayer(document, name);
  if (values.length !== layer.__cWid * layer.__cHei) throw new Error(`Wrong ${name} cell count`);
  layer.intGridRle = encodeIntGrid(values);
}
export function mapEntities(document: MapDocument): MapEntity[] {
  return (document.levels[0].layerInstances.find(l => l.__identifier === 'Features') as MapEntityLayer).entityInstances;
}
export function entityData<T = Record<string, unknown>>(entity: MapEntity): T {
  const result: Record<string, unknown> = {};
  for (const field of entity.fieldInstances) {
    if (field.__identifier === 'cells' && field.__type === 'Array<Int>') {
      const cells: [number, number][] = [];
      for (let i = 0; i < field.__value.length; i += 2) cells.push([field.__value[i]!, field.__value[i + 1]!]);
      result.cells = cells;
    } else result[field.__identifier] = field.__value;
  }
  return result as T;
}
export function mapEntity(identifier: MapEntity['__identifier'], iid: string, x: number, y: number, data: object): MapEntity {
  const fields = MAP_ENTITY_FIELDS[identifier];
  // An optional field left undefined is omitted (OPTIONAL_ENTITY_FIELDS), never stored as undefined.
  const fieldInstances = Object.entries(fields).filter(([name]) => (data as Record<string, unknown>)[name] !== undefined).map(([name, type]) => {
    const value = (data as Record<string, unknown>)[name];
    return { __identifier: name, __type: type, __value: name === 'cells' ? (value as number[][]).flat() : value } as MapField;
  });
  return { __identifier: identifier, iid, __grid: [Math.floor(x), Math.floor(y)], px: [x, y], fieldInstances };
}
/** A complete editable, empty-terrain map, including legal starting pockets and all declared slots/layouts. */
export function createMapDocument(metadata: MapMetadata): MapDocument {
  if (!(MAP_SIZES as readonly number[]).includes(metadata.size) || (metadata.sides !== 2 && metadata.sides !== 4) || !int(metadata.spireInset, SPIRE_INSET_MIN, SPIRE_INSET_MAX)) throw new Error('Invalid map authoring geometry');
  const { width, height } = canonicalDimensions(metadata.size, metadata.sides);
  const layers: (MapIntGridLayer | MapEntityLayer)[] = MAP_LAYER_NAMES.map(name => ({ __identifier: name,
    __type: 'IntGrid', __cWid: width, __cHei: height, __gridSize: 1,
    intGridRle: [width * height, name === 'Depths' ? CELL.rock : 0] }));
  layers.push({ __identifier: 'Features', __type: 'Entities', __cWid: width, __cHei: height, __gridSize: 1, entityInstances: [] });
  const document: MapDocument = { ...metadata, version: 1, symmetry: metadata.sides === 2 ? 'C2' : 'C4',
    layouts: metadata.sides === 2 ? [{ id: 'duel', teams: [[0], [1]], supported: true, fairness: 'rotational' }] : [
      { id: 'ffa', teams: [[0], [1], [2], [3]], supported: true, fairness: 'rotational' },
      { id: 'duel', teams: [[0], [2]], supported: true, fairness: 'duel' },
      { id: 'adjacent', teams: [[0, 1], [2, 3]], supported: false, fairness: 'adjacent' },
      { id: 'opposite', teams: [[0, 2], [1, 3]], supported: false, fairness: 'opposite' }],
    levels: [{ identifier: 'Canonical', worldX: 0, worldY: 0, pxWid: width, pxHei: height, layerInstances: layers }],
    generation: { lodes: [], terrainEdits: [], stages: [] } };
  const p = metadata.spireInset + 0.5;
  mapEntities(document).push(mapEntity('StartSlot', 'start', p, p, { slot: 0 }));
  mapEntities(document).push(mapEntity('OrbitRegion', 'orbit_region', metadata.size / 4, metadata.size / 4,
    { width: metadata.size / 4, height: metadata.size / 4, dx: Math.SQRT1_2, dy: Math.SQRT1_2, weight: 1, spread: 0.25 }));
  const radiusX = STATS.spire.footprint.w / 2 + STRUCTURE_SPACING;
  const radiusY = STATS.spire.footprint.h / 2 + STRUCTURE_SPACING;
  const depths = mapLayerValues(document, 'Depths'), owners = mapLayerValues(document, 'Owner');
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (Math.abs(x + 0.5 - p) < radiusX && Math.abs(y + 0.5 - p) < radiusY) {
      depths[y * width + x] = CELL.tunnel;
      owners[y * width + x] = 1;
    }
  }
  setMapLayerValues(document, 'Depths', depths);
  setMapLayerValues(document, 'Owner', owners);
  return document;
}
function rotateMask(mask: number, r: number, sides: number): number {
  let result = 0;
  for (let bit = 0; bit < sides; bit++) if (mask & (1 << bit)) result |= 1 << ((bit + r) % sides);
  return result;
}
function expanded(document: MapDocument): { world: World; starts: Point[]; cavern: Uint8Array } {
  const { size, sides } = document, n = size * size, step = turns(sides);
  const { width, height } = canonicalDimensions(size, sides);
  const buffers = MAP_LAYER_NAMES.map(() => new Uint8Array(n));
  for (let layer = 0; layer < MAP_LAYER_NAMES.length; layer++) {
    const values = mapLayerValues(document, MAP_LAYER_NAMES[layer]!);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = values[y * width + x]!;
      for (let r = 0; r < sides; r++) {
        let v = value;
        if (layer === 3 && v) v = (v - 1 + r) % sides + 1;
        if (layer === 4 && v) v = Math.floor((v - 1) / sides) * sides + (v - 1 + r) % sides + 1;
        if (layer === 5) v = rotateMask(v, r, sides);
        buffers[layer]![rotateCell(y * size + x, size, r * step)] = v;
      }
    }
  }
  const [terrain, cells, ore, owner, magma, cavern] = buffers as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  const starts: Point[] = [];
  const lodes: World['lodes'] = [], islands: World['islands'] = [];
  const orbitRegions: OrbitRegion[] = [];
  const paths = new Map<string, { order: number; cells: number[] }[]>();
  // Home posts by slot (each Post entity gives every slot one, in entity order), then the contested points.
  const homePosts: MapPost[][] = Array.from({ length: sides }, () => []), contested: MapPost[] = [];
  for (const entity of mapEntities(document)) {
    const [x, y] = entity.__grid;
    for (let r = 0; r < sides; r++) {
      const c = rotateCell(y * size + x, size, r * step);
      if (entity.__identifier === 'StartSlot') starts[r] = rotatePoint({ x: entity.px[0], y: entity.px[1] }, size, r * step);
      if (entity.__identifier === 'Lode') lodes.push({ c, ...entityData<LodeData>(entity) });
      if (entity.__identifier === 'Island') {
        const data = entityData<IslandData>(entity);
        const p = rotatePoint({ x: entity.px[0], y: entity.px[1] }, size, r * step);
        islands.push({ r: data.r, w: data.w, a0: angle(dmath.atan2(p.y - size / 2, p.x - size / 2)), oreCapacity: data.oreCapacity ?? 0 });
      }
      if (entity.__identifier === 'OrbitRegion') {
        const data = entityData<Omit<OrbitRegion, 'x' | 'y'>>(entity);
        orbitRegions.push(rotateOrbitRegion({ x: entity.px[0], y: entity.px[1], ...data }, size, r * step));
      }
      if (entity.__identifier === 'Fault') {
        const data = entityData<FaultData>(entity), key = `${data.path}:${(r + data.rotation) % sides}`;
        const parts = paths.get(key) ?? [];
        parts.push({ order: data.order, cells: data.cells.map(([cx, cy]) => rotateCell(cy * size + cx, size, r * step)) });
        paths.set(key, parts);
      }
      if (entity.__identifier === 'Post') {
        const data = entityData<PostData>(entity), p = rotatePoint({ x: entity.px[0], y: entity.px[1] }, size, r * step);
        if (data.kind === 'home') {
          const slot = (data.slot! + r) % sides;
          homePosts[slot]!.push({ x: p.x, y: p.y, kind: 'home', slot });
        } else if (r === 0 || !isCentrePoint(entity.px, size)) contested.push({ x: p.x, y: p.y, kind: 'contested' });
      }
    }
  }
  const faultOrbits = new Map<string, number[]>();
  for (const parts of paths.values()) {
    const path = parts.sort((a, b) => a.order - b.order).flatMap(p => p.cells);
    faultOrbits.set(pathKey(path), path);
  }
  const faults = [...faultOrbits.values()];
  const world: World = { size, preset: document.preset, terrain, cells, ore, owner, magma, cavern: Array.from(cavern.keys()).filter(c => cavern[c]! & 1),
    lodes, islands, orbitRegions, faults, posts: [...homePosts.flat(), ...contested], generation: clone(document.generation) };
  return { world, starts, cavern };
}
const int = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const pointTuple = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]);
function neighbors(c: number, size: number): number[] {
  const x = c % size, y = Math.floor(c / size), out: number[] = [];
  if (x) out.push(c - 1); if (x + 1 < size) out.push(c + 1);
  if (y) out.push(c - size); if (y + 1 < size) out.push(c + size);
  return out;
}
function distances(start: number, allowed: Uint8Array, size: number): Int32Array {
  const d = new Int32Array(allowed.length).fill(-1);
  if (!allowed[start]) return d;
  const queue = new Int32Array(allowed.length); let end = 1;
  queue[0] = start; d[start] = 0;
  for (let at = 0; at < end; at++) for (const next of neighbors(queue[at]!, size)) {
    if (!allowed[next] || d[next] !== -1) continue;
    d[next] = d[queue[at]!]! + 1; queue[end++] = next;
  }
  return d;
}
/** Indexed binary-heap Dijkstra: integer costs keep all rotated comparisons exact. */
function surfaceDistances(start: number, allowed: Uint8Array, size: number): Int32Array {
  const d = new Int32Array(allowed.length).fill(-1);
  if (!allowed[start]) return d;
  const heap = new Int32Array(allowed.length), positions = new Int32Array(allowed.length).fill(-1);
  let count = 1;
  heap[0] = start; positions[start] = 0; d[start] = 0;
  while (count) {
    const c: number = heap[0]!, last: number = heap[--count]!;
    positions[c] = -2;
    if (count) {
      heap[0] = last; positions[last] = 0;
      let at = 0;
      while (2 * at + 1 < count) {
        let child = 2 * at + 1;
        if (child + 1 < count && d[heap[child + 1]!]! < d[heap[child]!]!) child++;
        if (d[last]! <= d[heap[child]!]!) break;
        heap[at] = heap[child]!; positions[heap[at]!] = at; at = child;
      }
      heap[at] = last; positions[last] = at;
    }
    const x: number = c % size, y: number = Math.floor(c / size);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx >= size || y + dy < 0 || y + dy >= size) continue;
      const next = (y + dy) * size + x + dx;
      if (!allowed[next] || positions[next] === -2 || (dx && dy && (!allowed[c + dx] || !allowed[c + dy * size]))) continue;
      const candidate = d[c]! + (dx && dy ? 1414 : 1000);
      if (d[next]! >= 0 && d[next]! <= candidate) continue;
      d[next] = candidate;
      let at = positions[next]!;
      if (at < 0) at = count++;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (d[heap[parent]!]! <= candidate) break;
        heap[at] = heap[parent]!; positions[heap[at]!] = at; at = parent;
      }
      heap[at] = next; positions[next] = at;
    }
  }
  return d;
}
/** Radius-eight open/high-ground area and distinct open arcs on a radius-five perimeter. */
function measureExposure(root: number, surface: Uint8Array, terrain: Uint8Array, size: number): SlotFairness['exposure'] {
  const x = root % size, y = Math.floor(root / size);
  let openCells = 0, highCells = 0;
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    if (dx * dx + dy * dy > 64 || x + dx < 0 || x + dx >= size || y + dy < 0 || y + dy >= size) continue;
    const c = (y + dy) * size + x + dx;
    if (surface[c]) { openCells++; if (isSurfaceHigh(terrain[c]!)) highCells++; }
  }
  const ring: boolean[] = [];
  for (let side = 0; side < 4; side++) for (let k = -5; k < 5; k++) {
    const dx = side === 0 ? k : side === 1 ? 5 : side === 2 ? -k : -5;
    const dy = side === 0 ? -5 : side === 1 ? k : side === 2 ? 5 : -k;
    ring.push(x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size && Boolean(surface[(y + dy) * size + x + dx]));
  }
  let entrances = ring.every(Boolean) ? 1 : 0;
  for (let i = 0; i < ring.length; i++) if (ring[i] && !ring[(i + ring.length - 1) % ring.length]) entrances++;
  return { openCells, highCells, entrances };
}
function geometry(document: MapDocument, errors: string[]): MapFairness {
  const { world, starts, cavern } = expanded(document), { size, sides } = document, n = size * size;
  const LODE_SEAL = (STATS.headframe.footprint.w - 1) / 2 + 1;
  const surface = Uint8Array.from(world.terrain, v => Number(v !== SURFACE.cliff && surfaceFeature(v) !== SURFACE.water));
  // A connected water/ford body has one explicit base level; no stepped water sheets or inferred neighbours.
  for (let c = 0; c < n; c++) {
    if (!isSurfaceWet(world.terrain[c]!)) continue;
    const high = isSurfaceHigh(world.terrain[c]!);
    const right = c % size < size - 1 ? c + 1 : -1, below = c + size;
    if (right >= 0 && isSurfaceWet(world.terrain[right]!) && isSurfaceHigh(world.terrain[right]!) !== high ||
        below < n && isSurfaceWet(world.terrain[below]!) && isSurfaceHigh(world.terrain[below]!) !== high) errors.push(`Water body changes elevation at ${c}`);
  }
  // Mother Lode cells are solid and never dug: no route runs through them. A map's magma cells are lava lakes, which
  // diggers bridge: what lies beyond one (a moated rich cluster, a lake's ore island) still counts as reachable.
  const depths = Uint8Array.from(world.cells, v => Number(v !== CELL.bedrock && v !== CELL.lode));
  const startCells = starts.map(p => Math.floor(p.y) * size + Math.floor(p.x));
  const sd = startCells.map(c => surfaceDistances(c, surface, size));
  const dd = startCells.map(c => distances(c, depths, size));
  for (let c = 0; c < n; c++) {
    if (surface[c] && sd[0]![c] === -1) { errors.push(`Surface has disconnected walkable cell ${c}`); break; }
  }
  const lodeCells = new Set<number>();
  for (const lode of world.lodes) {
    const x = lode.c % size, y = Math.floor(lode.c / size);
    if (lodeCells.has(lode.c)) errors.push(`Overlapping lode at ${lode.c}`);
    for (const prior of lodeCells) if (prior !== lode.c && norm(prior % size - x, Math.floor(prior / size) - y) < 6) errors.push(`Lodes ${prior} and ${lode.c} violate outcrop spacing`);
    lodeCells.add(lode.c);
    if (x < LODE_SEAL || y < LODE_SEAL || x >= size - LODE_SEAL || y >= size - LODE_SEAL) {
      errors.push(`Lode at ${lode.c} has out-of-bounds footprint`); continue;
    }
    let loads = 0;
    for (let dy = -LODE_SEAL; dy <= LODE_SEAL; dy++) for (let dx = -LODE_SEAL; dx <= LODE_SEAL; dx++) {
      const c = (y + dy) * size + x + dx, ring = Math.max(Math.abs(dx), Math.abs(dy));
      const expected = ring === LODE_SEAL ? CELL.bedrock : ring === 0 ? CELL.rock : CELL.ore;
      if (world.cells[c] !== expected || world.magma[c]) errors.push(`Illegal lode footprint at ${c}`);
      if (ring < LODE_SEAL) loads += world.ore[c]!;
      if (ring <= LODE_SEAL && !surface[c]) errors.push(`Lode surface apron blocked at ${c}`);
    }
    if (loads !== lode.loads) errors.push(`Lode ${lode.c} declares ${lode.loads} loads but contains ${loads}`);
    if (sd.every(d => d[lode.c] === -1)) errors.push(`Lode ${lode.c} unreachable on surface`);
    // A Headframe must be placeable: outcrop footprint plus apron on one level (all ground or one plateau top).
    const pocket = STATS.headframe.footprint;
    if (surfaceSiteLevel(world.terrain, size, x - (pocket.w - 1) / 2, y - (pocket.h - 1) / 2, pocket.w, pocket.h) < 0) errors.push(`Lode ${lode.c} outcrop and apron are not on one level`);
  }
  // Forward posts: one per point, each on walkable ground every start reaches (the centre: one of its four cells).
  const postPoints = new Set<string>();
  for (const post of world.posts) {
    const key = `${post.x},${post.y}`;
    if (postPoints.has(key)) errors.push(`Overlapping posts at ${key}`);
    postPoints.add(key);
    const cells = isCentrePoint([post.x, post.y], size)
      ? [0, 1].flatMap(dy => [0, 1].map(dx => (size / 2 - 1 + dy) * size + size / 2 - 1 + dx))
      : [Math.floor(post.y) * size + Math.floor(post.x)];
    if (!sd.every(d => cells.some(c => d[c]! >= 0))) errors.push(`Post at ${key} not on ground every start reaches`);
  }
  // The Mother Lode: its entities (expanded by rotation) are exactly the Depths layer's lode cells, at most
  // MOTHER_LODE_MAX_CELLS, each inside a ring of open cells (or other lode cells) that every start can reach.
  const motherCells = new Set<number>();
  for (const entity of mapEntities(document)) if (entity.__identifier === 'MotherLode') {
    for (let r = 0; r < sides; r++) {
      const c = rotateCell(entity.__grid[1] * size + entity.__grid[0], size, r * turns(sides));
      if (motherCells.has(c)) errors.push(`Duplicate Mother Lode cell ${c}`);
      motherCells.add(c);
    }
  }
  if (motherCells.size > MOTHER_LODE_MAX_CELLS) errors.push(`More than ${MOTHER_LODE_MAX_CELLS} Mother Lode cells`);
  for (let c = 0; c < n; c++) {
    if (world.cells[c] === CELL.lode && !motherCells.has(c)) errors.push(`Lode cell ${c} lacks a MotherLode entity`);
    if (world.cells[c] !== CELL.lode && motherCells.has(c)) errors.push(`MotherLode entity at ${c} is not a lode cell`);
  }
  for (const c of motherCells) {
    const x = c % size, y = Math.floor(c / size), ring: number[] = [];
    if (x < 1 || y < 1 || x > size - 2 || y > size - 2) { errors.push(`Mother Lode cell ${c} has no ring inside the map`); continue; }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const next = (y + dy) * size + x + dx;
      if (world.cells[next] === CELL.lode) continue;
      if (isOpenCell(world.cells[next]!)) ring.push(next);
      else errors.push(`Mother Lode ring cell ${next} is not open`);
    }
    for (let slot = 0; slot < sides; slot++) if (!ring.some(r => dd[slot]![r]! >= 0)) errors.push(`Mother Lode cell ${c} unreachable from start ${slot}`);
  }
  // Green rich ore: its entities (expanded by rotation) are exactly the Depths layer's rich cells.
  const richCells = new Set<number>();
  for (const entity of mapEntities(document)) if (entity.__identifier === 'RichOre') {
    for (let r = 0; r < sides; r++) {
      const c = rotateCell(entity.__grid[1] * size + entity.__grid[0], size, r * turns(sides));
      if (richCells.has(c)) errors.push(`Duplicate rich ore cell ${c}`);
      richCells.add(c);
    }
  }
  for (let c = 0; c < n; c++) {
    if (world.cells[c] === CELL.rich && !richCells.has(c)) errors.push(`Rich ore cell ${c} lacks a RichOre entity`);
    if (world.cells[c] !== CELL.rich && richCells.has(c)) errors.push(`RichOre entity at ${c} is not a rich ore cell`);
  }
  for (let c = 0; c < n; c++) {
    if (world.ore[c] && !isOreCell(world.cells[c]!)) errors.push(`Ore on non-ore cell ${c}`);
    if (isOreCell(world.cells[c]!) && !world.ore[c]) errors.push(`Empty ore cell ${c}`);
    if (world.magma[c] && world.cells[c] !== CELL.rock) errors.push(`Magma pocket on non-rock cell ${c}`);
    if (world.cells[c] === CELL.bridge) errors.push(`Lava bridge cell ${c} on a map (bridges are built in play)`);
    if (world.owner[c] && world.cells[c] !== CELL.tunnel && world.cells[c] !== CELL.rail) errors.push(`Owner on unopened cell ${c}`);
    if (cavern[c] && world.cells[c] !== CELL.tunnel && world.cells[c] !== CELL.rail) errors.push(`Cavern knowledge on unopened cell ${c}`);
    // Sealed lode pockets deliberately require a surface headframe, not a dig through bedrock.
    if (depths[c] && dd[0]![c] === -1 && !world.lodes.some(l => Math.max(Math.abs(c % size - l.c % size), Math.abs(Math.floor(c / size) - Math.floor(l.c / size))) < LODE_SEAL)) {
      errors.push(`Depths cell ${c} unreachable through diggable rock`); break;
    }
  }
  const magmaCells = new Map<number, number[]>();
  for (let c = 0; c < n; c++) if (world.magma[c]) {
    const id = world.magma[c]!, pocket = magmaCells.get(id) ?? [];
    pocket.push(c); magmaCells.set(id, pocket);
  }
  for (const [id, pocket] of magmaCells) {
    const remaining = new Set(pocket), queue = [pocket[0]!];
    remaining.delete(pocket[0]!);
    for (let at = 0; at < queue.length; at++) for (const next of neighbors(queue[at]!, size)) if (remaining.delete(next)) queue.push(next);
    if (remaining.size) errors.push(`Disconnected magma pocket ${id}`);
  }
  const islandPositions = new Set<string>();
  for (const island of world.islands) {
    const key = `${island.r}:${Math.round(angle(island.a0) * 1e9)}`;
    if (islandPositions.has(key)) errors.push('Overlapping island orbit positions');
    islandPositions.add(key);
  }
  const regionFeatures = new Set<string>();
  for (const region of world.orbitRegions) {
    const key = JSON.stringify([region.x, region.y, region.width, region.height, region.dx, region.dy, region.weight, region.spread]);
    if (regionFeatures.has(key)) errors.push('Duplicate OrbitRegion feature');
    regionFeatures.add(key);
  }
  const seenFault = new Set<number>();
  for (const fault of world.faults) for (let i = 0; i < fault.length; i++) {
    const c = fault[i]!;
    seenFault.add(c);
    if (surfaceFeature(world.terrain[c]!) !== SURFACE.fault) errors.push(`Fault entity outside fault terrain at ${c}`);
    if (i && Math.max(Math.abs(c % size - fault[i - 1]! % size), Math.abs(Math.floor(c / size) - Math.floor(fault[i - 1]! / size))) !== 1) errors.push('Noncontiguous fault polyline');
  }
  for (let c = 0; c < n; c++) if (surfaceFeature(world.terrain[c]!) === SURFACE.fault && !seenFault.has(c)) errors.push(`Fault terrain lacks entity at ${c}`);
  for (let slot = 0; slot < sides; slot++) {
    const p = starts[slot]!, root = startCells[slot]!;
    const rx = STATS.spire.footprint.w / 2 + STRUCTURE_SPACING, ry = STATS.spire.footprint.h / 2 + STRUCTURE_SPACING;
    if (p.x - rx < 0 || p.y - ry < 0 || p.x + rx > size || p.y + ry > size) errors.push(`Start ${slot} footprint leaves map`);
    for (let y = Math.max(0, Math.floor(p.y - ry)); y < Math.min(size, Math.ceil(p.y + ry)); y++) for (let x = Math.max(0, Math.floor(p.x - rx)); x < Math.min(size, Math.ceil(p.x + rx)); x++) {
      if (Math.abs(x + 0.5 - p.x) >= rx || Math.abs(y + 0.5 - p.y) >= ry) continue;
      const c = y * size + x;
      if (world.terrain[c] !== SURFACE.ground || world.cells[c] !== CELL.tunnel || world.owner[c] !== slot + 1 || world.magma[c]) errors.push(`Illegal start ${slot} clearing at ${c}`);
    }
    if (sd[slot]![root]! < 0 || dd[slot]![root]! < 0) errors.push(`Start ${slot} blocked`);
    for (let other = 0; other < sides; other++) if (sd[slot]![startCells[other]!]! < 0 || dd[slot]![startCells[other]!]! < 0) errors.push(`Start ${slot} cannot reach start ${other}`);
  }
  // Distance-to-obstacle in cells; propagated from the border and all cliff cells.
  const clearance = new Int32Array(n).fill(size), queue: number[] = [];
  for (let c = 0; c < n; c++) if (!surface[c] || c % size === 0 || c % size === size - 1 || c < size || c >= n - size) { clearance[c] = surface[c] ? 1 : 0; queue.push(c); }
  for (let at = 0; at < queue.length; at++) for (const next of neighbors(queue[at]!, size)) if (clearance[next]! > clearance[queue[at]!]! + 1) { clearance[next] = clearance[queue[at]!]! + 1; queue.push(next); }
  const slots: SlotFairness[] = startCells.map((root, slot) => {
    let accessibleOre = 0, sectorOre = 0, accessibleLodes = 0, accessibleLodeLoads = 0;
    let nearestOre = Infinity, nearestLode = Infinity, cumulativeOreDistance = 0, cumulativeLodeDistance = 0;
    for (let c = 0; c < n; c++) {
      if (canonicalize(c, size, sides).rotation === slot) sectorOre += world.ore[c]!;
      if (world.ore[c] && dd[slot]![c]! >= 0) { accessibleOre += world.ore[c]!; nearestOre = Math.min(nearestOre, dd[slot]![c]!); cumulativeOreDistance += dd[slot]![c]! * world.ore[c]!; }
    }
    for (const lode of world.lodes) if (sd[slot]![lode.c]! >= 0) { accessibleLodes++; accessibleLodeLoads += lode.loads; nearestLode = Math.min(nearestLode, sd[slot]![lode.c]!); cumulativeLodeDistance += sd[slot]![lode.c]!; }
    // Widest-path bottleneck to each other start; minimum over those attack routes.
    const capacity = new Int32Array(n).fill(-1), pending: number[][] = Array.from({ length: size + 1 }, () => []);
    capacity[root] = clearance[root]!; pending[capacity[root]!]!.push(root);
    for (let width = size; width >= 0; width--) for (let at = 0; at < pending[width]!.length; at++) {
      const c = pending[width]![at]!; if (capacity[c] !== width) continue;
      for (const next of neighbors(c, size)) if (surface[next]) { const v = Math.min(width, clearance[next]!); if (v > capacity[next]!) { capacity[next] = v; pending[v]!.push(next); } }
    }
    return { slot, surfaceDistances: startCells.map(c => sd[slot]![c]! < 0 ? null : sd[slot]![c]! / 1000), depthsDistances: startCells.map(c => dd[slot]![c]! < 0 ? null : dd[slot]![c]!),
      accessibleOre, sectorOre, accessibleLodes, accessibleLodeLoads, nearestOre: Number.isFinite(nearestOre) ? nearestOre : null, nearestLode: Number.isFinite(nearestLode) ? nearestLode / 1000 : null,
      cumulativeOreDistance, cumulativeLodeDistance: cumulativeLodeDistance / 1000, chokeClearance: Math.min(...startCells.filter((_, i) => i !== slot).map(c => Math.max(0, 2 * capacity[c]! - 1))), exposure: measureExposure(root, surface, world.terrain, size) };
  });
  const normalized = slots.map((slot, i) => JSON.stringify({ ...slot, slot: 0, surfaceDistances: Array.from({ length: sides }, (_, j) => slot.surfaceDistances[(i + j) % sides]), depthsDistances: Array.from({ length: sides }, (_, j) => slot.depthsDistances[(i + j) % sides]) }));
  const equalRotatedSlots = normalized.every(s => s === normalized[0]);
  if (!equalRotatedSlots) errors.push('Rotated start geometry/resource fairness differs');
  return { slots, resources: world.lodes.map(lode => ({ cell: lode.c, loads: lode.loads, rich: lode.rich,
    clearance: Math.max(0, 2 * clearance[lode.c]! - 1), distances: sd.map(d => d[lode.c]! < 0 ? null : d[lode.c]! / 1000),
    exposure: measureExposure(lode.c, surface, world.terrain, size) })),
    layouts: document.layouts.map(layout => ({ id: layout.id, classification: layout.fairness, teams: clone(layout.teams), equalRotatedSlots,
    enemyDistances: layout.teams.map(team => team.flatMap(slot => startCells.map((_, other) => team.includes(other) ? undefined : slots[slot]!.surfaceDistances[other]).filter((v): v is number | null => v !== undefined))) })) };
}
/** Validate structure before allocating or following any authored coordinates. Never coerces input. */
export function validateMapDocument(raw: unknown): MapValidationResult {
  const errors: string[] = [], fail = (message: string) => errors.push(message);
  if (!record(raw)) return { valid: false, errors: ['Map document must be an object'], fairness: null };
  const rejectExtraFields = (value: Record<string, unknown>, allowed: readonly string[], context: string): void => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${context} field ${key}`);
  };
  const rootFields = ['id', 'label', 'identity', 'seed', 'size', 'sides', 'spireInset', 'preset', 'version', 'symmetry', 'layouts', 'levels', 'generation'];
  rejectExtraFields(raw, rootFields, 'map document');
  try {
    if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_MAP_DOCUMENT_BYTES) fail(`Map document exceeds ${MAX_MAP_DOCUMENT_BYTES} UTF-8 bytes`);
  } catch { fail('Map document must be JSON serializable'); }
  if (raw.version !== MAP_DOCUMENT_VERSION) fail('Unsupported map document version');
  for (const [name, limit] of [['id', MAP_ID_MAX], ['label', MAP_LABEL_MAX], ['identity', MAP_IDENTITY_MAX]] as const) {
    if (typeof raw[name] !== 'string' || !(raw[name] as string).trim() || (raw[name] as string).length > limit) fail(`Invalid ${name}: expected 1..${limit} characters`);
  }
  if (typeof raw.id === 'string' && !MAP_ID_PATTERN.test(raw.id)) fail('Invalid id: expected a lowercase map identifier');
  if (!int(raw.seed, 0, 0xffffffff)) fail('Seed must be an unsigned 32-bit integer');
  if (!(MAP_SIZES as readonly unknown[]).includes(raw.size)) fail('Size must be 48, 64, or 80');
  if (raw.sides !== 2 && raw.sides !== 4) fail('Sides must be 2 or 4');
  if (!int(raw.spireInset, SPIRE_INSET_MIN, SPIRE_INSET_MAX)) fail(`Spire inset must be an integer in ${SPIRE_INSET_MIN}..${SPIRE_INSET_MAX}`);
  if (!(TERRAIN_PRESETS as readonly unknown[]).includes(raw.preset)) fail('Unknown terrain preset');
  if (raw.symmetry !== (raw.sides === 2 ? 'C2' : 'C4')) fail('Symmetry must match sides');
  if (errors.length) return { valid: false, errors, fairness: null };
  const document = raw as unknown as MapDocument, { size, sides } = document, { width, height } = canonicalDimensions(size, sides);
  if (!Array.isArray(raw.layouts) || !raw.layouts.length || raw.layouts.length > 8) fail('One to eight layouts are required');
  else {
    const ids = new Set<string>();
    for (const layout of raw.layouts) {
      if (!record(layout) || typeof layout.id !== 'string' || !layout.id || layout.id.length > 64 || ids.has(layout.id)) { fail('Invalid/duplicate layout'); continue; }
      ids.add(layout.id);
      rejectExtraFields(layout, ['id', 'teams', 'supported', 'fairness'], 'layout');
      if (typeof layout.supported !== 'boolean' || (sides === 4 && layout.supported && layout.fairness !== 'rotational' && layout.fairness !== 'duel')) fail('Four-sided alliance layouts must remain unsupported');
      if (!['rotational', 'adjacent', 'opposite', 'duel'].includes(String(layout.fairness))) fail('Invalid fairness classification');
      if (!Array.isArray(layout.teams) || layout.teams.length < 2 || layout.teams.some(team => !Array.isArray(team) || !team.length || team.some(slot => !int(slot, 0, sides - 1)))) fail('Invalid layout teams');
      else {
        const slots = layout.teams.flat();
        // A four-slot duel claims two opposite slots; every other layout assigns each slot exactly once.
        const duel = sides === 4 && layout.fairness === 'duel';
        if (duel ? layout.teams.length !== 2 || slots.length !== 2 || (slots[1]! - slots[0]! + 4) % 4 !== 2 : slots.length !== sides || new Set(slots).size !== sides) fail(duel ? 'A four-slot duel claims two opposite slots' : 'Layout must assign each slot exactly once');
      }
    }
  }
  if (!Array.isArray(raw.levels) || raw.levels.length !== 1 || !record(raw.levels[0])) return { valid: false, errors: [...errors, 'Exactly one canonical level is required'], fairness: null };
  const level = raw.levels[0];
  rejectExtraFields(level, ['identifier', 'worldX', 'worldY', 'pxWid', 'pxHei', 'layerInstances'], 'canonical level');
  if (level.identifier !== 'Canonical' || level.worldX !== 0 || level.worldY !== 0 || level.pxWid !== width || level.pxHei !== height) fail('Invalid canonical level bounds');
  if (!Array.isArray(level.layerInstances)) return { valid: false, errors: [...errors, 'Missing layers'], fairness: null };
  const names = new Set<string>(); let starts = 0, orbitRegions = 0, homePosts = 0, contestedPosts = 0;
  const entityIds = new Set<string>();
  for (const layer of level.layerInstances) {
    if (!record(layer) || typeof layer.__identifier !== 'string' || names.has(layer.__identifier)) { fail('Invalid/duplicate layer'); continue; }
    const name = layer.__identifier; names.add(name);
    rejectExtraFields(layer, ['__identifier', '__type', '__cWid', '__cHei', '__gridSize', name === 'Features' ? 'entityInstances' : 'intGridRle'], 'canonical layer');
    if (layer.__cWid !== width || layer.__cHei !== height || layer.__gridSize !== 1) fail(`Invalid canonical dimensions for ${name}`);
    if ((MAP_LAYER_NAMES as readonly string[]).includes(name)) {
      if (layer.__type !== 'IntGrid' || !Array.isArray(layer.intGridRle) || !layer.intGridRle.length || layer.intGridRle.length % 2 || layer.intGridRle.length > 2 * width * height || 'intGridCsv' in layer) { fail(`Invalid compact IntGrid ${name}`); continue; }
      const max = name === 'Surface' ? Math.max(...Object.values(SURFACE)) : name === 'Depths' ? Math.max(...Object.values(CELL)) : name === 'Owner' ? sides : name === 'Cavern' ? (1 << sides) - 1 : name === 'Magma' ? Math.floor(255 / sides) * sides : 255;
      let total = 0;
      for (let i = 0; i < layer.intGridRle.length; i += 2) {
        if (!int(layer.intGridRle[i], 1, width * height) || !int(layer.intGridRle[i + 1], name === 'Depths' ? 1 : 0, max) ||
            name === 'Surface' && !isSurfaceCode(layer.intGridRle[i + 1])) fail(`Invalid run/code/range in ${name}`);
        else total += layer.intGridRle[i];
        if (i && layer.intGridRle[i + 1] === layer.intGridRle[i - 1]) fail(`Noncanonical adjacent equal runs in ${name}`);
      }
      if (total !== width * height) fail(`Invalid canonical cell count in ${name}`);
    } else if (name === 'Features') {
      if (layer.__type !== 'Entities' || !Array.isArray(layer.entityInstances) || layer.entityInstances.length > 512) { fail('Invalid Features layer (maximum 512 entities)'); continue; }
      for (const entity of layer.entityInstances) {
        if (!record(entity) || !Object.hasOwn(MAP_ENTITY_FIELDS, String(entity.__identifier))) { fail('Unknown feature entity'); continue; }
        if (typeof entity.iid !== 'string' || !entity.iid || entity.iid.length > 96 || entityIds.has(entity.iid)) fail('Invalid/duplicate entity iid');
        else entityIds.add(entity.iid);
        rejectExtraFields(entity, ['__identifier', 'iid', '__grid', 'px', 'fieldInstances'], 'canonical entity');
        if (!pointTuple(entity.__grid)) { fail('Entity outside canonical sector'); continue; }
        if (!pointTuple(entity.px)) { fail('Invalid entity point'); continue; }
        // The map centre is a cell corner on the canonical sector's edge: a contested Post there is stored once, as is.
        const centrePost = entity.__identifier === 'Post' && isCentrePoint(entity.px, size);
        if (centrePost) {
          if (entity.__grid[0] !== size / 2 || entity.__grid[1] !== size / 2) { fail('Invalid entity point'); continue; }
        } else {
          if (!isCanonicalCell(entity.__grid[0], entity.__grid[1], size, sides)) { fail('Entity outside canonical sector'); continue; }
          if (entity.px[0] < 0 || entity.px[1] < 0 || entity.px[0] >= width || entity.px[1] >= height || Math.floor(entity.px[0]) !== entity.__grid[0] || Math.floor(entity.px[1]) !== entity.__grid[1]) { fail('Invalid entity point'); continue; }
          if (entity.__identifier !== 'Island' && entity.__identifier !== 'OrbitRegion' && (entity.px[0] !== entity.__grid[0] + 0.5 || entity.px[1] !== entity.__grid[1] + 0.5)) { fail('Cell feature point must be its cell centre'); continue; }
        }
        const expectedFields: Record<string, MapField['__type']> = MAP_ENTITY_FIELDS[entity.__identifier as MapEntity['__identifier']];
        const fieldCount = Object.keys(expectedFields).length, optional = OPTIONAL_ENTITY_FIELDS[entity.__identifier as MapEntity['__identifier']]?.length ?? 0;
        if (!Array.isArray(entity.fieldInstances) || entity.fieldInstances.length > fieldCount || entity.fieldInstances.length < fieldCount - optional) { fail('Invalid typed feature fields'); continue; }
        const fieldNames = new Set<string>(); let invalidFields = false;
        for (const field of entity.fieldInstances) {
          if (!record(field) || typeof field.__identifier !== 'string' || fieldNames.has(field.__identifier) || !(field.__identifier in expectedFields) || field.__type !== expectedFields[field.__identifier]) { invalidFields = true; break; }
          fieldNames.add(field.__identifier);
          rejectExtraFields(field, ['__identifier', '__type', '__value'], 'entity field');
          if (field.__type === 'Int' ? !int(field.__value, 0, field.__identifier === 'oreCapacity' ? 100000 : size * size) :
            field.__type === 'Float' ? !finite(field.__value) :
            field.__type === 'Bool' ? typeof field.__value !== 'boolean' :
            field.__type === 'String' ? typeof field.__value !== 'string' || !field.__value.length || field.__value.length > 96 :
            !Array.isArray(field.__value) || !field.__value.length || field.__value.length % 2 || field.__value.length > width * height * 2 || field.__value.some(v => !int(v, 0, size - 1))) invalidFields = true;
        }
        if (invalidFields) { fail('Invalid feature field name/type/value'); continue; }
        const data = entityData(entity as unknown as MapEntity);
        if (entity.__identifier === 'StartSlot') { starts++; if (data.slot !== 0 || entity.px[0] !== document.spireInset + 0.5 || entity.px[1] !== document.spireInset + 0.5) fail('Start must be canonical slot zero at declared inset'); }
        if (entity.__identifier === 'Lode' && (typeof data.rich !== 'boolean' || !int(data.loads, LODE_LOADS_MIN, LODE_LOADS_MAX))) fail('Invalid lode resource bounds');
        if (entity.__identifier === 'Island' && (!finite(data.r) || data.r <= 0 || data.r > size / 2 - 1 || !finite(data.w) || Math.abs(data.w) > Math.PI || Math.abs(norm(entity.px[0] - size / 2, entity.px[1] - size / 2) - Number(data.r)) > ISLAND_ORBIT_TOLERANCE)) fail('Invalid island orbit');
        if (entity.__identifier === 'OrbitRegion') {
          orbitRegions++;
          if (!finite(data.width) || data.width <= 0 || data.width > size || !finite(data.height) || data.height <= 0 || data.height > size ||
            !finite(data.dx) || Math.abs(data.dx) > 1 || !finite(data.dy) || Math.abs(data.dy) > 1 ||
            !finite(data.weight) || data.weight < 0.01 || data.weight > 100 || !finite(data.spread) || data.spread < 0 || data.spread > 1) fail('Invalid OrbitRegion field bounds');
          else if (entity.px[0] - data.width / 2 < 0 || entity.px[0] + data.width / 2 > size ||
            entity.px[1] - data.height / 2 < 0 || entity.px[1] + data.height / 2 > size) fail('OrbitRegion rectangle leaves map bounds');
        }
        if (entity.__identifier === 'Fault') {
          if (typeof data.path !== 'string' || !data.path || data.path.length > 96 || !int(data.order, 0, size * size) || !int(data.rotation, 0, sides - 1) || !Array.isArray(data.cells) || !data.cells.length || data.cells.length > width * height || data.cells.some(p => !Array.isArray(p) || p.length !== 2 || !isCanonicalCell(p[0], p[1], size, sides))) fail('Invalid canonical fault fragment');
          else { const first = data.cells[0] as number[]; if (first[0] !== entity.__grid[0] || first[1] !== entity.__grid[1]) fail('Fault anchor differs from first cell'); }
        }
        if (entity.__identifier === 'Post') {
          if (!(POST_KINDS as readonly unknown[]).includes(data.kind)) { fail('Invalid post kind'); continue; }
          if (data.kind === 'home' ? !int(data.slot, 0, sides - 1) || centrePost : data.slot !== undefined) fail('A home post names its slot; a contested point names none');
          if (data.kind === 'home') homePosts++;
          else contestedPosts += centrePost ? 1 : sides;
        }
      }
    } else fail(`Unknown layer ${name}`);
  }
  for (const name of [...MAP_LAYER_NAMES, 'Features']) if (!names.has(name)) fail(`Missing layer ${name}`);
  if (starts !== 1) fail('Exactly one canonical StartSlot is required');
  if (!orbitRegions || orbitRegions * sides > 64) fail('One to 64 expanded OrbitRegions are required');
  if (homePosts > MAX_POST_COUNT) fail(`At most ${MAX_POST_COUNT} home posts per slot`);
  if (contestedPosts > MAX_CONTESTED_POSTS) fail(`At most ${MAX_CONTESTED_POSTS} expanded contested points`);
  if (!record(raw.generation) || !Array.isArray(raw.generation.lodes) || raw.generation.lodes.length > 8 || !Array.isArray(raw.generation.terrainEdits) || raw.generation.terrainEdits.length > 6400) fail('Invalid generation accounting bounds');
  else {
    rejectExtraFields(raw.generation, ['lodes', 'terrainEdits', 'stages'], 'generation');
    if (!Array.isArray(raw.generation.stages) || raw.generation.stages.length > 16 || raw.generation.stages.some(s => !record(s) || typeof s.name !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(s.name) || !int(s.seed, 0, 0xffffffff))) fail('Invalid generation stage seeds');
    for (const summary of raw.generation.lodes) if (!record(summary) || !['home', 'flanks', 'centre'].includes(String(summary.zone)) || ['requested', 'placed', 'widened', 'prepared', 'cliffPrepared', 'fallback', 'missing'].some(k => !int(summary[k], 0, size * size))) fail('Invalid lode generation accounting');
    for (const edit of raw.generation.terrainEdits) if (!record(edit) || !int(edit.c, 0, size * size - 1) || typeof edit.before !== 'number' || !isSurfaceCode(edit.before) || typeof edit.after !== 'number' || !isSurfaceCode(edit.after)) fail('Invalid terrain edit accounting');
  }
  if (errors.length) return { valid: false, errors, fairness: null };
  const fairness = geometry(document, errors);
  return { valid: errors.length === 0, errors, fairness };
}
export function buildWorldFromDocument(document: MapDocument): World {
  return expandMapDocument(document).world;
}
/**
 * The validated world plus what only the document's slots know: each slot's Spire start (its StartSlot rotated by the
 * slot's frame) and the per-cell Cavern knowledge mask (bit s: slot s starts knowing the cell).
 */
export function expandMapDocument(document: MapDocument): { world: World; starts: Point[]; cavern: Uint8Array } {
  const result = validateMapDocument(document);
  if (!result.valid) throw new Error(`Invalid map document: ${result.errors.join('; ')}`);
  return expanded(document);
}
function pathKey(path: number[]): string {
  const a = path.join(','), b = [...path].reverse().join(','); return a < b ? a : b;
}
/** Extract and check every rotated layer/feature; never silently discard an asymmetric source sector. */
export function documentFromWorld(world: World, metadata: MapMetadata): MapDocument {
  const document = createMapDocument(metadata), { size, sides } = metadata, { width, height } = canonicalDimensions(size, sides), step = turns(sides);
  if (world.size !== size) throw new Error('World size does not match document metadata');
  if (world.preset !== metadata.preset) throw new Error('World preset does not match document metadata');
  const source = [world.terrain, world.cells, world.ore, world.owner, world.magma];
  const canonicalLayers = MAP_LAYER_NAMES.map(() => Array<number>(width * height).fill(0));
  for (const values of source) if (values.length !== size * size) throw new Error('World dimensions do not match document metadata');
  const known = new Uint8Array(size * size);
  for (const c of world.cavern) { if (!int(c, 0, size * size - 1)) throw new Error('Invalid known cavern cell'); for (let r = 0; r < sides; r++) known[rotateCell(c, size, r * step)]! |= 1 << r; }
  const magmaRotation = Array.from({ length: sides }, () => new Map<number, number>());
  const magmaInverse = Array.from({ length: sides }, () => new Map<number, number>());
  for (let c = 0; c < size * size; c++) for (let r = 0; r < sides; r++) {
    const id = world.magma[c]!, other = world.magma[rotateCell(c, size, r * step)]!;
    if (Boolean(id) !== Boolean(other) || (magmaRotation[r]!.has(id) && magmaRotation[r]!.get(id) !== other) || (magmaInverse[r]!.has(other) && magmaInverse[r]!.get(other) !== id)) throw new Error('Asymmetric magma pocket topology');
    magmaRotation[r]!.set(id, other); magmaInverse[r]!.set(other, id);
  }
  const magmaIds = new Map<number, number>(); let nextMagma = 1;
  for (const id of world.magma) if (id && !magmaIds.has(id)) {
    const orbit = Array.from({ length: sides }, (_, r) => magmaRotation[r]!.get(id)!);
    if (new Set(orbit).size !== sides) throw new Error('Magma pocket must have distinct rotated counterparts');
    for (let r = 0; r < sides; r++) magmaIds.set(orbit[r]!, nextMagma + r);
    nextMagma += sides;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const c = y * size + x, index = y * width + x;
    for (let layer = 0; layer < source.length; layer++) {
      const value = source[layer]![c]!;
      for (let r = 0; r < sides; r++) {
        const other = source[layer]![rotateCell(c, size, r * step)]!;
        if (layer === 4 ? Boolean(other) !== Boolean(value) : other !== (layer === 3 && value ? (value - 1 + r) % sides + 1 : value)) throw new Error(`World lacks ${document.symmetry} symmetry in ${MAP_LAYER_NAMES[layer]} at ${c}`);
      }
      let canonical = value;
      if (layer === 4 && value) canonical = magmaIds.get(value)!;
      canonicalLayers[layer]![index] = canonical;
    }
    canonicalLayers[5]![index] = known[c]!;
  }
  for (let layer = 0; layer < MAP_LAYER_NAMES.length; layer++) setMapLayerValues(document, MAP_LAYER_NAMES[layer]!, canonicalLayers[layer]!);
  const entities = mapEntities(document), lodeKeys = new Set(world.lodes.map(l => `${l.c}:${l.rich}:${l.loads}`));
  for (const lode of world.lodes) if (canonicalize(lode.c, size, sides).rotation === 0) {
    for (let r = 0; r < sides; r++) if (!lodeKeys.has(`${rotateCell(lode.c, size, r * step)}:${lode.rich}:${lode.loads}`)) throw new Error('Asymmetric lode features');
    entities.push(mapEntity('Lode', `lode-${lode.c}`, lode.c % size + 0.5, Math.floor(lode.c / size) + 0.5, { rich: lode.rich, loads: lode.loads }));
  }
  if (entities.filter(e => e.__identifier === 'Lode').length * sides !== world.lodes.length) throw new Error('Missing/duplicate lode orbit');
  // Mother Lode cells: one public entity per orbit at its canonical cell (the Depths layer is already symmetric).
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (world.cells[y * size + x] === CELL.lode) entities.push(mapEntity('MotherLode', `mother-lode-${y * size + x}`, x + 0.5, y + 0.5, {}));
  // Green rich ore: one public entity per orbit at its canonical cell, like the Mother Lode.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (world.cells[y * size + x] === CELL.rich) entities.push(mapEntity('RichOre', `rich-ore-${y * size + x}`, x + 0.5, y + 0.5, {}));
  // Forward posts: one entity per orbit, the one in the canonical sector (the centre point once), its home slot as is.
  const postKey = (p: { x: number; y: number }, kind: PostKind, slot: number | undefined): string => `${p.x},${p.y},${kind},${slot ?? ''}`;
  const postKeys = new Set(world.posts.map(p => postKey(p, p.kind, p.slot)));
  let postEntities = 0;
  for (const post of world.posts) {
    const centre = isCentrePoint([post.x, post.y], size);
    if (centre ? post.kind !== 'contested' : canonicalize(Math.floor(post.y) * size + Math.floor(post.x), size, sides).rotation !== 0) continue;
    for (let r = centre ? sides : 1; r < sides; r++) {
      const slot = post.kind === 'home' ? (post.slot! + r) % sides : undefined;
      if (!postKeys.has(postKey(rotatePoint(post, size, r * step), post.kind, slot))) throw new Error('Asymmetric forward posts');
    }
    entities.push(mapEntity('Post', `post-${postEntities++}`, post.x, post.y, { kind: post.kind, slot: post.slot }));
  }
  if (world.posts.length !== entities.reduce((n, e) => n + (e.__identifier !== 'Post' ? 0 : isCentrePoint(e.px, size) ? 1 : sides), 0)) throw new Error('Missing/duplicate post orbit');
  const faultKeys = new Set(world.faults.map(pathKey)), visited = new Set<string>();
  if (faultKeys.size !== world.faults.length || world.faults.some(path => !path.length || path.some(c => !int(c, 0, size * size - 1)))) throw new Error('Invalid/duplicate source fault polylines');
  for (const path of world.faults) {
    const key = pathKey(path); if (visited.has(key)) continue;
    const orbit = Array.from({ length: sides }, (_, r) => path.map(c => rotateCell(c, size, r * step)));
    for (const rotated of orbit) { const k = pathKey(rotated); if (!faultKeys.has(k)) throw new Error('Asymmetric fault polylines'); visited.add(k); }
    const pathId = `fault-${visited.size}`;
    let order = 0;
    for (let at = 0; at < path.length;) {
      const sector = canonicalize(path[at]!, size, sides).rotation, cells: [number, number][] = [];
      while (at < path.length && canonicalize(path[at]!, size, sides).rotation === sector) {
        const c = canonicalize(path[at++]!, size, sides).c; cells.push([c % size, Math.floor(c / size)]);
      }
      entities.push(mapEntity('Fault', `${pathId}-${order}`, cells[0]![0] + 0.5, cells[0]![1] + 0.5,
        { path: pathId, order: order++, rotation: (sides - sector) % sides, cells } satisfies FaultData));
    }
  }
  const islandRemaining = [...world.islands]; let islandIndex = 0;
  while (islandRemaining.length) {
    const island = islandRemaining.shift()!;
    const p = { x: size / 2 + dmath.cos(island.a0) * island.r, y: size / 2 + dmath.sin(island.a0) * island.r };
    let canonical = p;
    for (let r = 0; r < sides; r++) { const candidate = rotatePoint(p, size, -r * step); if (candidate.x >= 0 && candidate.x < width && candidate.y >= 0 && candidate.y < height) { canonical = candidate; break; } }
    for (let r = 1; r < sides; r++) {
      const wanted = angle(island.a0 + r * step * Math.PI / 2);
      const i = islandRemaining.findIndex(v => v.oreCapacity === island.oreCapacity && Math.abs(v.r - island.r) < GEOM_EPS && Math.abs(v.w - island.w) < ZERO_EPS && Math.abs(dmath.atan2(dmath.sin(v.a0 - wanted), dmath.cos(v.a0 - wanted))) < GEOM_EPS);
      if (i < 0) throw new Error('Asymmetric island orbit'); islandRemaining.splice(i, 1);
    }
    entities.push(mapEntity('Island', `island-${islandIndex++}`, canonical.x, canonical.y, { r: island.r, w: island.w, oreCapacity: island.oreCapacity }));
  }
  for (let i = entities.length - 1; i >= 0; i--) if (entities[i]!.__identifier === 'OrbitRegion') entities.splice(i, 1);
  const regionKeys = new Set<string>(), remainingRegions = [...world.orbitRegions];
  // Pick canonical representatives first: no inverse floating-point translation is needed to compare an orbit.
  remainingRegions.sort((a, b) => Number(b.x >= 0 && b.x < width && b.y >= 0 && b.y < height) - Number(a.x >= 0 && a.x < width && a.y >= 0 && a.y < height));
  const regionFields = ['x', 'y', 'width', 'height', 'dx', 'dy', 'weight', 'spread'] as const;
  while (remainingRegions.length) {
    const region = remainingRegions.shift()!;
    const key = JSON.stringify(regionFields.map(field => region[field]));
    if (regionKeys.has(key)) throw new Error('Duplicate OrbitRegion feature');
    regionKeys.add(key);
    let canonical = region;
    for (let r = 0; r < sides; r++) {
      const candidate = rotateOrbitRegion(region, size, -r * step);
      if (candidate.x >= 0 && candidate.x < width && candidate.y >= 0 && candidate.y < height) { canonical = candidate; break; }
    }
    for (let r = 1; r < sides; r++) {
      const expected = rotateOrbitRegion(region, size, r * step);
      const index = remainingRegions.findIndex(other => regionFields.every(field => other[field] === expected[field]));
      if (index < 0) throw new Error('Asymmetric OrbitRegion features');
      const removed = remainingRegions.splice(index, 1)[0]!;
      const rotatedKey = JSON.stringify(regionFields.map(field => removed[field]));
      if (regionKeys.has(rotatedKey)) throw new Error('Duplicate OrbitRegion feature');
      regionKeys.add(rotatedKey);
    }
    const { x, y, ...data } = canonical;
    entities.push(mapEntity('OrbitRegion', `orbit_region_${regionKeys.size}`, x, y, data));
  }
  document.generation = clone(world.generation);
  const result = validateMapDocument(document);
  if (!result.valid) throw new Error(`Invalid generated map: ${result.errors.join('; ')}`);
  return document;
}

/** LDtk 1.5 project. Metadata uses defined native fields, not editor-discarded unknown root keys. */
export interface LdtkMapProject { jsonVersion: string; [key: string]: unknown }
const LDTK_GRID = 16;
type LdtkField = { __identifier: string; __type: MapField['__type']; __value: MapField['__value'] };
function ldtkFieldInstance(field: LdtkField, uid: number): Record<string, unknown> {
  const values = Array.isArray(field.__value) ? field.__value : [field.__value];
  const type = field.__type === 'Array<Int>' ? 'Int' : field.__type;
  return { ...field, defUid: uid, realEditorValues: values.map(value => ({ id: `V_${type}`, params: [value] })) };
}
function ldtkFieldValue(field: Record<string, unknown>): unknown {
  // LDtk's convenient __value export rounds Floats to three decimals, but the editor's native
  // V_Float retains the complete value. Use it when the two representations agree at that precision.
  if (field.__type === 'Float' && finite(field.__value) && Array.isArray(field.realEditorValues) && field.realEditorValues.length === 1) {
    const raw = field.realEditorValues[0];
    if (record(raw) && raw.id === 'V_Float' && Array.isArray(raw.params) && raw.params.length === 1 && finite(raw.params[0])) {
      const exact = raw.params[0];
      if (field.__value === exact || field.__value === Math.round(exact * 1000) / 1000) return exact;
    }
  }
  return field.__value;
}
function ldtkFieldDefinition(identifier: string, type: MapField['__type'], uid: number, nullable = false): Record<string, unknown> {
  return { identifier, uid, __type: type, type: `F_${type === 'Array<Int>' ? 'Int' : type}`,
    isArray: type === 'Array<Int>', canBeNull: nullable, defaultOverride: null, allowOutOfLevelRef: false,
    allowedRefTags: [], allowedRefs: 'Any', autoChainRef: false, editorAlwaysShow: true, editorCutLongValues: true,
    editorDisplayMode: 'NameAndValue', editorDisplayPos: 'Above', editorDisplayScale: 1, editorLinkStyle: 'StraightArrow',
    editorShowInWorld: true, exportToToc: false, searchable: false, symmetricalRef: false, useForSmartColor: false };
}
/**
 * A real LDtk 1.5 project: layers expand to ordinary editable IntGrids, zero codes are offset by one
 * (LDtk reserves zero for empty), and every entity/metadata field has an editor definition.
 * Subpixel world points retain exact floating coordinates in two Float fields; dragging adds the
 * pixel displacement to those coordinates, rather than rounding away island orbit precision.
 */
export function exportLdtk(document: MapDocument): LdtkMapProject {
  const result = validateMapDocument(document);
  if (!result.valid) throw new Error(result.errors.join('; '));
  const level = document.levels[0];
  const defs = { layers: [] as Record<string, unknown>[], entities: [] as Record<string, unknown>[], enums: [],
    externalEnums: [], tilesets: [], levelFields: [] as Record<string, unknown>[] };
  const fieldInstances: Record<string, unknown>[] = [];
  const addField = (name: string, type: MapField['__type'], value: MapField['__value']): void => {
    const uid = 2000 + fieldInstances.length;
    defs.levelFields.push(ldtkFieldDefinition(name, type, uid));
    fieldInstances.push(ldtkFieldInstance({ __identifier: name, __type: type, __value: clone(value) }, uid));
  };
  for (const name of ['id', 'label', 'identity', 'preset', 'symmetry'] as const) addField(name, 'String', document[name]);
  for (const name of ['version', 'size', 'sides'] as const) addField(name, 'Int', document[name]);
  addField('seed', 'Float', document.seed);
  addField('spireInset', 'Float', document.spireInset);
  addField('layoutCount', 'Int', document.layouts.length);
  document.layouts.forEach((layout, i) => {
    addField(`layout_${i}_id`, 'String', layout.id);
    addField(`layout_${i}_fairness`, 'String', layout.fairness);
    addField(`layout_${i}_supported`, 'Bool', layout.supported);
    // Slot → team index; `sides` (never a team index) marks a slot the layout leaves empty (a four-slot duel).
    const teams = Array<number>(document.sides).fill(document.sides);
    layout.teams.forEach((team, index) => team.forEach(slot => { teams[slot] = index; }));
    addField(`layout_${i}_teams`, 'Array<Int>', teams);
  });
  addField('lodeSummaryCount', 'Int', document.generation.lodes.length);
  const summaryKeys = ['requested', 'placed', 'widened', 'prepared', 'cliffPrepared', 'fallback', 'missing'] as const;
  document.generation.lodes.forEach((summary, i) => {
    addField(`lodeSummary_${i}_zone`, 'String', summary.zone);
    addField(`lodeSummary_${i}_values`, 'Array<Int>', summaryKeys.map(k => summary[k]));
  });
  addField('terrainEdits', 'Array<Int>', document.generation.terrainEdits.flatMap(e => [e.c, e.before, e.after]));
  addField('stageCount', 'Int', document.generation.stages.length);
  document.generation.stages.forEach((stage, i) => {
    addField(`stage_${i}_name`, 'String', stage.name);
    addField(`stage_${i}_seed`, 'Float', stage.seed);
  });
  const kinds = Object.keys(MAP_ENTITY_FIELDS) as MapEntity['__identifier'][];
  const layerInstances = level.layerInstances.map((layer, index) => {
    const uid = 10 + index;
    defs.layers.push({ identifier: layer.__identifier, uid, __type: layer.__type, type: layer.__type, gridSize: LDTK_GRID,
      displayOpacity: 1, parallaxFactorX: 0, parallaxFactorY: 0, parallaxScaling: true, pxOffsetX: 0, pxOffsetY: 0,
      intGridValuesGroups: [], autoRuleGroups: [], canSelectWhenInactive: true, excludedTags: [], guideGridHei: 0,
      guideGridWid: 0, hideFieldsWhenInactive: false, hideInList: false, inactiveOpacity: 0.5, renderInWorldView: true,
      requiredTags: [], tilePivotX: 0, tilePivotY: 0, uiFilterTags: [], useAsyncRender: false,
      intGridValues: layer.__type === 'IntGrid' ? (layer.__identifier === 'Surface' ? Object.values(SURFACE) : Array.from({ length: layer.__identifier === 'Ore' || layer.__identifier === 'Magma' ? 256 : layer.__identifier === 'Owner' ? document.sides + 1 : layer.__identifier === 'Cavern' ? 1 << document.sides : Math.max(...Object.values(CELL)) + 1 }, (_, value) => value))
        .map(value => ({ value: value + 1, identifier: `Code_${value}`, color: `#${((value * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}` })) : [] });
    const common = { __identifier: layer.__identifier, __type: layer.__type, __cWid: layer.__cWid, __cHei: layer.__cHei,
      __gridSize: LDTK_GRID, iid: `layer-${uid}`, levelId: 1, layerDefUid: uid, pxOffsetX: 0, pxOffsetY: 0, visible: true,
      __opacity: 1, __pxTotalOffsetX: 0, __pxTotalOffsetY: 0, __tilesetDefUid: null, __tilesetRelPath: null,
      autoLayerTiles: [], gridTiles: [], seed: 0, overrideTilesetUid: null, optionalRules: [] };
    if (layer.__type === 'IntGrid') return { ...common, intGridCsv: mapLayerValues(document, layer.__identifier).map(v => v + 1), entityInstances: [] };
    return { ...common, intGridCsv: [], entityInstances: layer.entityInstances.map(entity => {
      const kindIndex = kinds.indexOf(entity.__identifier);
      const fields: LdtkField[] = [...clone(entity.fieldInstances),
        { __identifier: 'MapPositionX', __type: 'Float', __value: entity.px[0] },
        { __identifier: 'MapPositionY', __type: 'Float', __value: entity.px[1] }];
      return { ...clone(entity), px: entity.px.map(v => Math.round(v * LDTK_GRID)), defUid: 100 + kindIndex,
        width: LDTK_GRID, height: LDTK_GRID, __pivot: [0, 0], __smartColor: '#88ccff',
        __worldX: Math.round(entity.px[0] * LDTK_GRID), __worldY: Math.round(entity.px[1] * LDTK_GRID), __tags: [], __tile: null,
        fieldInstances: fields.map(field => ldtkFieldInstance(field, 1000 + kindIndex * 20 + [...Object.keys(MAP_ENTITY_FIELDS[entity.__identifier]), 'MapPositionX', 'MapPositionY'].indexOf(field.__identifier))) };
    }) };
  });
  kinds.forEach((identifier, i) => {
    const fields: [string, MapField['__type']][] = [...Object.entries(MAP_ENTITY_FIELDS[identifier]) as [string, MapField['__type']][],
      ['MapPositionX', 'Float'], ['MapPositionY', 'Float']];
    defs.entities.push({ identifier, uid: 100 + i, width: LDTK_GRID, height: LDTK_GRID, pivotX: 0, pivotY: 0,
      color: '#88ccff', renderMode: 'Rectangle', fillOpacity: 0.5, lineOpacity: 1, tileRenderMode: 'FitInside',
      resizableX: false, resizableY: false, nineSliceBorders: [], allowOutOfBounds: false, exportToToc: false,
      hollow: false, keepAspectRatio: false, limitBehavior: 'PreventAdding', limitScope: 'PerLevel', maxCount: 0,
      showName: true, tags: [], tileOpacity: 1,
      fieldDefs: fields.map(([name, type], index) => ldtkFieldDefinition(name, type, 1000 + i * 20 + index, OPTIONAL_ENTITY_FIELDS[identifier]?.includes(name))) });
  });
  return { jsonVersion: '1.5.3', appBuildId: 0, identifierStyle: 'Free', iid: `map-${document.id}`, nextUid: 3000,
    backupLimit: 10, backupOnSave: true, customCommands: [], defaultEntityHeight: LDTK_GRID, defaultEntityWidth: LDTK_GRID,
    defaultPivotX: 0, defaultPivotY: 0, dummyWorldIid: 'canonical-world', exportLevelBg: false, exportTiled: false,
    flags: [], imageExportMode: 'None', levelNamePattern: 'Level_%idx', minifyJson: false, simplifiedExport: false, toc: [],
    defaultGridSize: LDTK_GRID, defaultLevelWidth: level.pxWid * LDTK_GRID, defaultLevelHeight: level.pxHei * LDTK_GRID,
    worldLayout: 'Free', worldGridWidth: level.pxWid * LDTK_GRID, worldGridHeight: level.pxHei * LDTK_GRID,
    bgColor: '#222222', defaultLevelBgColor: '#222222', externalLevels: false, defs, worlds: [],
    levels: [{ identifier: 'Canonical', iid: 'canonical', uid: 1, worldX: 0, worldY: 0, worldDepth: 0,
      pxWid: level.pxWid * LDTK_GRID, pxHei: level.pxHei * LDTK_GRID, __bgColor: '#222222', __smartColor: '#222222',
      __neighbours: [], bgColor: null, bgRelPath: null, bgPivotX: 0.5, bgPivotY: 0.5, useAutoIdentifier: false,
      externalRelPath: null, fieldInstances, layerInstances }] };
}
export function importLdtk(raw: unknown): MapDocument {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!record(parsed) || parsed.jsonVersion !== '1.5.3' || !Array.isArray(parsed.levels) || parsed.levels.length !== 1 || !record(parsed.levels[0])) throw new Error('LDtk import requires one embedded canonical level in a 1.5.3 project');
  const level = parsed.levels[0];
  if (!Array.isArray(level.fieldInstances) || !Array.isArray(level.layerInstances)) throw new Error('LDtk map metadata/layers missing');
  const fields = new Map<string, Record<string, unknown>>();
  for (const field of level.fieldInstances) {
    if (!record(field) || typeof field.__identifier !== 'string' || fields.has(field.__identifier)) throw new Error('Invalid/duplicate LDtk metadata field');
    fields.set(field.__identifier, field);
  }
  const take = (name: string, type: MapField['__type']): unknown => {
    const field = fields.get(name);
    if (!field || field.__type !== type) throw new Error(`Missing/invalid LDtk metadata field ${name}`);
    fields.delete(name);
    const v = ldtkFieldValue(field);
    if (type === 'Int' ? !int(v, 0, 0xffffffff) : type === 'Float' ? !finite(v) : type === 'Bool' ? typeof v !== 'boolean' : type === 'String' ? typeof v !== 'string' : !Array.isArray(v) || v.some(n => !int(n, 0, 6400))) throw new Error(`Invalid LDtk metadata value ${name}`);
    return v;
  };
  const metadata: Record<string, unknown> = {};
  for (const name of ['id', 'label', 'identity', 'preset', 'symmetry']) metadata[name] = take(name, 'String');
  for (const name of ['version', 'size', 'sides']) metadata[name] = take(name, 'Int');
  metadata.seed = take('seed', 'Float');
  metadata.spireInset = take('spireInset', 'Float');
  const count = take('layoutCount', 'Int') as number;
  if (!int(count, 1, 8)) throw new Error('Invalid LDtk layout count');
  const layouts = Array.from({ length: count }, (_, i) => {
    const id = take(`layout_${i}_id`, 'String'), fairness = take(`layout_${i}_fairness`, 'String'), supported = take(`layout_${i}_supported`, 'Bool');
    const assignment = take(`layout_${i}_teams`, 'Array<Int>') as number[], teams: number[][] = [];
    if (assignment.length !== metadata.sides || assignment.some(t => t > Number(metadata.sides))) throw new Error('Invalid LDtk layout assignment');
    assignment.forEach((team, slot) => { if (team < Number(metadata.sides)) (teams[team] ??= []).push(slot); });
    if (teams.some(team => !team)) throw new Error('Noncontiguous LDtk team assignment');
    return { id, fairness, supported, teams };
  });
  const summaryCount = take('lodeSummaryCount', 'Int') as number;
  if (!int(summaryCount, 0, 8)) throw new Error('Invalid LDtk lode summary count');
  const summaryKeys = ['requested', 'placed', 'widened', 'prepared', 'cliffPrepared', 'fallback', 'missing'] as const;
  const lodes = Array.from({ length: summaryCount }, (_, i) => {
    const zone = take(`lodeSummary_${i}_zone`, 'String'), values = take(`lodeSummary_${i}_values`, 'Array<Int>') as number[];
    if (values.length !== summaryKeys.length) throw new Error('Invalid LDtk lode summary');
    return { zone, ...Object.fromEntries(summaryKeys.map((key, j) => [key, values[j]])) };
  });
  const edits = take('terrainEdits', 'Array<Int>') as number[];
  if (edits.length % 3 || edits.length > 6400 * 3) throw new Error('Invalid LDtk terrain edit accounting');
  const terrainEdits = [];
  for (let i = 0; i < edits.length; i += 3) terrainEdits.push({ c: edits[i], before: edits[i + 1], after: edits[i + 2] });
  const stageCount = take('stageCount', 'Int') as number;
  if (!int(stageCount, 0, 16)) throw new Error('Invalid LDtk stage count');
  const stages = Array.from({ length: stageCount }, (_, i) => ({ name: take(`stage_${i}_name`, 'String'), seed: take(`stage_${i}_seed`, 'Float') }));
  if (fields.size) throw new Error('Unknown LDtk map metadata fields');
  if (!int(level.pxWid, 1, 1280) || !int(level.pxHei, 1, 640)) throw new Error('Invalid LDtk canonical bounds');
  const document = { ...metadata, layouts, generation: { lodes, terrainEdits, stages },
    levels: [{ identifier: level.identifier, worldX: level.worldX, worldY: level.worldY,
      pxWid: level.pxWid / LDTK_GRID, pxHei: level.pxHei / LDTK_GRID,
      layerInstances: level.layerInstances.map((rawLayer: unknown) => {
        if (!record(rawLayer) || rawLayer.__gridSize !== LDTK_GRID) throw new Error('Invalid LDtk map grid size');
        const base = { __identifier: rawLayer.__identifier, __type: rawLayer.__type, __cWid: rawLayer.__cWid, __cHei: rawLayer.__cHei, __gridSize: 1 };
        if (rawLayer.__type === 'IntGrid') {
          if (!Array.isArray(rawLayer.intGridCsv) || rawLayer.intGridCsv.length > 3200 || rawLayer.intGridCsv.some(v => !int(v, 1, 256))) throw new Error('LDtk IntGrid contains empty/invalid cells; paint every canonical cell');
          return { ...base, intGridRle: encodeIntGrid(rawLayer.intGridCsv.map(v => v - 1)) };
        }
        if (rawLayer.__type !== 'Entities' || !Array.isArray(rawLayer.entityInstances)) throw new Error('Invalid LDtk entity layer');
        return { ...base, entityInstances: rawLayer.entityInstances.map((entity: unknown) => {
          if (!record(entity) || !Array.isArray(entity.px) || entity.px.length !== 2 || entity.px.some(v => !int(v, 0, 1280)) || !Array.isArray(entity.fieldInstances)) throw new Error('Invalid LDtk entity');
          const entityFields = entity.fieldInstances, entityPixels = entity.px;
          const coordinates = ['MapPositionX', 'MapPositionY'].map((name, i) => {
            const field = entityFields.find((f: unknown) => record(f) && f.__identifier === name);
            if (!record(field) || field.__type !== 'Float') throw new Error(`Invalid LDtk ${name} coordinate`);
            const value = ldtkFieldValue(field);
            if (!finite(value)) throw new Error(`Invalid LDtk ${name} coordinate`);
            return value + (entityPixels[i] - Math.round(value * LDTK_GRID)) / LDTK_GRID;
          });
          // An optional field the editor left empty (null) is omitted, as the document stores it.
          const importedFields = entityFields.filter((f: unknown) => !record(f) || (f.__identifier !== 'MapPositionX' && f.__identifier !== 'MapPositionY' && f.__value !== null)).map((f: unknown) => {
            if (!record(f)) throw new Error('Invalid LDtk entity field');
            return { __identifier: f.__identifier, __type: f.__type, __value: clone(ldtkFieldValue(f)) };
          });
          if (entity.__identifier === 'Fault') {
            const cells = importedFields.find(f => f.__identifier === 'cells');
            if (cells && Array.isArray(cells.__value) && cells.__value.length >= 2 && cells.__value.every(finite)) {
              const dx = Math.floor(coordinates[0]!) - cells.__value[0]!, dy = Math.floor(coordinates[1]!) - cells.__value[1]!;
              cells.__value = cells.__value.map((v: number, i: number) => v + (i % 2 ? dy : dx));
            }
          }
          return { __identifier: entity.__identifier, iid: entity.iid, __grid: coordinates.map(Math.floor), px: coordinates, fieldInstances: importedFields };
        }) };
      }) }] };
  const result = validateMapDocument(document);
  if (!result.valid) throw new Error(`Invalid LDtk map: ${result.errors.join('; ')}`);
  return document as unknown as MapDocument;
}
