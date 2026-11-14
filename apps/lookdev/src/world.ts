/**
 * The lookdev scene, independent of any art direction: a 16×16 slice of each plane (codes as in the game's contract),
 * unit placements, fog-of-war masks, and the geometry builders every direction shares (smoothed heightfield, island,
 * asteroid, unit kit). Directions only decide materials, extra props and post-processing.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  IcosahedronGeometry,
  LinearFilter,
  OctahedronGeometry,
  RGBAFormat,
  SphereGeometry,
  TorusGeometry,
  UnsignedByteType,
  Vector3,
} from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export type Plane = 'depths' | 'surface' | 'sky' | 'orbit';
export const PLANES: readonly Plane[] = ['depths', 'surface', 'sky', 'orbit'];
/** The diorama's two armies, named by the colour they are drawn in (DESIGN §15.1: an army's colour is its alliance). */
export type ArmyColour = 'blue' | 'red';

/** Tiles per side of the slice. */
export const S = 16;
export const HALF = S / 2;
/** Plane altitudes (compressed from the game's −24/0/22/52 so the stack shot fits). */
export const PLANE_Y: Record<Plane, number> = { depths: -16, surface: 0, sky: 13, orbit: 27 };
/** Tile centre → world. */
export const wx = (x: number): number => x - HALF + 0.5;
export const wz = (y: number): number => y - HALF + 0.5;

/** Army colours and the threat colour are game constants (apps/web/src/world/common.ts SIDE_HEX); directions may grade them. */
export const ARMY_HEX: Record<ArmyColour, string> = { blue: '#3aa8ff', red: '#ff4f5e' };
export const THREAT_HEX = '#ffd23f';

/** Direction toward the key light (upper-left of screen for the default camera). */
export const SUN_DIR = new Vector3(-0.62, 0.72, -0.12).normalize();

// ------------------------------------------------------------------ maps
// Surface: G ground, H high plateau, C cliff, F forest, W ford, X chasm, f fault (marker on ground).
export const SURFACE_MAP = [
  'GGGCCHHHHCGGWWGG',
  'GGCHHHHHHHCGWWGG',
  'GGCHHHHHHCGWWFFG',
  'GGGCCHHHCGGWWFFF',
  'GGGGGCCCGGWWGFFF',
  'GGGGGGGGGWWfGGFG',
  'GGGGGGGGWWGGXGGG',
  'GGGGGGGWWGGGXGGG',
  'GGGGGGWWGGGGGXGG',
  'GGGGGWWGGGGGGXGG',
  'GGGGWWGGGGGGGGff',
  'GFFWWGGGGGGCCGGf',
  'FFWWFGGGGGCHHCGG',
  'FFWFFFGGGGCHHHCG',
  'FWWFFGGGGGGCHHCG',
  'GWWGGGGGGGGGCCGG',
];
/** Fault polyline (tile coords, in order); X cells along it are the opened chasm. */
export const FAULT: readonly [number, number][] = [
  [11.4, 5.5], [12.0, 6.0], [12.5, 6.8], [12.9, 7.6], [13.3, 8.4], [13.5, 9.3], [14.2, 10.1], [15.0, 10.6], [16, 11.6],
];
// Depths: B bedrock, R rock, O ore, K fortified, T tunnel, L rail, M magma.
export const DEPTHS_MAP = [
  'BBBBRRRRRRRRRBBB',
  'BRRRRROORRRRRRRB',
  'BRRTTTTTTRRRRRRR',
  'RRRTRRRRTRRRMMRR',
  'RRRTRROOTTTTMMRR',
  'RRRLRROORRRTTRRR',
  'RRRLRRRRRRRRTRRR',
  'RRRLLLLLLLLTTRRR',
  'RRRRRRRRRRRTRROR',
  'RRTTTRRRRRRTRROR',
  'RRTKTRRRRRRTTTTR',
  'RRTTTTTTRRRRRRTR',
  'RRRRRRRTRRRRRRTR',
  'ROORRRRTTTTTTTTR',
  'BOORRRRRRRRRRRRB',
  'BBBBRRRRRRRRBBBB',
];
export const code = (map: readonly string[], x: number, y: number): string => map[Math.max(0, Math.min(S - 1, y))]![Math.max(0, Math.min(S - 1, x))]!;

export const SURFACE_H: Record<string, number> = { G: 0, f: 0, F: 0, H: 0.8, C: 1.3, W: -0.38, X: -3.2 };
export const DEPTHS_H: Record<string, number> = { B: 1.45, R: 1.25, O: 1.25, K: 1.25, T: 0, L: 0, M: -0.2 };

export interface Island {
  x: number;
  y: number;
  r: number;
  team: ArmyColour | 'neutral';
}
export const ISLANDS: readonly Island[] = [
  { x: 5, y: 10, r: 3.1, team: 'blue' },
  { x: 12, y: 4.5, r: 2.1, team: 'neutral' },
];
/** Sun wedge in Orbit: apex (tile coords, the map centre lies off this slice), centre angle and half-width (rad). */
export const SUN_WEDGE = { ax: -6, ay: -6, angle: Math.PI * 0.27, half: 0.2 };
export const ASTEROID = { x: 9.5, y: 6.5, r: 1.25 };
/** Telegraphs: asteroid impact on the Surface (0..1 elapsed), sapper charge in the Depths. */
export const IMPACT = { x: 9, y: 10, r: 1.9, t: 0.62 };
export const CHARGE = { x: 11, y: 8, r: 1.1, t: 0.35 };

export type Kind =
  | 'trooper' | 'tank' | 'turret' | 'digger' | 'sapper' | 'interceptor' | 'bomber' | 'relay' | 'tug' | 'lancer' | 'array' | 'spire';
export interface Unit {
  kind: Kind;
  team: ArmyColour;
  x: number;
  y: number;
  rot: number;
  /** Last-seen memory (structure ghost inside the fog). */
  ghost?: boolean;
}
export const UNITS: Record<Plane, Unit[]> = {
  surface: [
    { kind: 'spire', team: 'blue', x: 1.6, y: 6.8, rot: 0 },
    { kind: 'trooper', team: 'blue', x: 6.4, y: 11.2, rot: -0.5 },
    { kind: 'trooper', team: 'blue', x: 7.1, y: 11.7, rot: -0.5 },
    { kind: 'trooper', team: 'blue', x: 6.7, y: 12.4, rot: -0.5 },
    { kind: 'trooper', team: 'blue', x: 2.6, y: 12.6, rot: -0.2 },
    { kind: 'tank', team: 'blue', x: 7.6, y: 8.6, rot: -0.7 },
    { kind: 'tank', team: 'blue', x: 5.0, y: 7.4, rot: -0.6 },
    { kind: 'turret', team: 'blue', x: 3.5, y: 4.5, rot: -0.3 },
    { kind: 'trooper', team: 'red', x: 10.6, y: 9.3, rot: 2.6 },
    { kind: 'trooper', team: 'red', x: 11.3, y: 10.1, rot: 2.6 },
    { kind: 'tank', team: 'red', x: 10.0, y: 11.9, rot: 2.8 },
    { kind: 'turret', team: 'red', x: 13.5, y: 1.5, rot: 2.6, ghost: true },
  ],
  depths: [
    { kind: 'digger', team: 'blue', x: 4.5, y: 11, rot: 0 },
    { kind: 'digger', team: 'blue', x: 7, y: 12.6, rot: 1.57 },
    { kind: 'digger', team: 'blue', x: 6, y: 7, rot: 0 },
    { kind: 'sapper', team: 'red', x: 11.2, y: 9.4, rot: -1.57 },
    { kind: 'digger', team: 'red', x: 11.4, y: 5.1, rot: 3.1 },
  ],
  sky: [
    { kind: 'relay', team: 'blue', x: 5, y: 10, rot: 0 },
    { kind: 'interceptor', team: 'blue', x: 7.5, y: 8.2, rot: -0.8 },
    { kind: 'interceptor', team: 'blue', x: 8.3, y: 8.9, rot: -0.8 },
    { kind: 'interceptor', team: 'blue', x: 7.2, y: 9.5, rot: -0.8 },
    { kind: 'bomber', team: 'red', x: 10.5, y: 7.8, rot: 2.4 },
    { kind: 'bomber', team: 'red', x: 11.6, y: 9.4, rot: 2.4 },
  ],
  orbit: [
    { kind: 'array', team: 'blue', x: 3.5, y: 3.8, rot: 0.6 },
    { kind: 'array', team: 'blue', x: 5.6, y: 2.4, rot: 0.6 },
    { kind: 'array', team: 'blue', x: 2.4, y: 11.5, rot: 0.6 },
    { kind: 'tug', team: 'blue', x: 7.4, y: 8.6, rot: -0.75 },
    { kind: 'lancer', team: 'red', x: 12.2, y: 9.2, rot: 2.5 },
    { kind: 'lancer', team: 'red', x: 12.9, y: 10.4, rot: 2.5 },
  ],
};

// ------------------------------------------------------------------ fog of war
/** Blue vision sources per plane (tile coords, radius). Fog covers roughly the screen-right half. */
const VISION: Record<Plane, [number, number, number][]> = {
  surface: [[2, 7, 5.5], [6.5, 11.5, 5], [7, 8, 4.8], [3.5, 4.5, 5]],
  depths: [[4.5, 11, 4.5], [7, 12.6, 4], [6, 7, 4.5], [2, 3, 3.5]],
  sky: [[5, 10, 5.5], [7.8, 8.8, 4.8]],
  orbit: [[3.5, 3.8, 5], [5.6, 2.4, 4.5], [2.4, 11.5, 5], [7.4, 8.6, 4.6]],
};
/** 1 where the blue team sees the tile. */
export function visionMask(plane: Plane): Float32Array {
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      out[y * S + x] = VISION[plane].some(([vx, vy, r]) => (cx - vx) ** 2 + (cy - vy) ** 2 <= r * r) ? 1 : 0;
    }
  return out;
}
export const isVisible = (plane: Plane, x: number, y: number): boolean =>
  visionMask(plane)[Math.min(S - 1, Math.floor(y)) * S + Math.min(S - 1, Math.floor(x))] === 1;

/** Per-tile RGBA texture (linear filtered, like the game's fog texture): r = vision, g/b/a free per plane. */
export function tileTexture(r: Float32Array, g?: Float32Array, b?: Float32Array, a?: Float32Array): DataTexture {
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = (r[i]! * 255) | 0;
    data[i * 4 + 1] = ((g?.[i] ?? 0) * 255) | 0;
    data[i * 4 + 2] = ((b?.[i] ?? 0) * 255) | 0;
    data[i * 4 + 3] = ((a?.[i] ?? 1) * 255) | 0;
  }
  const t = new DataTexture(data, S, S, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}
export const cellMask = (map: readonly string[], codes: string): Float32Array => {
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = codes.includes(code(map, x, y)) ? 1 : 0;
  return out;
};

// ------------------------------------------------------------------ noise
export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, oct = 4): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += (vnoise(x * f, y * f) - 0.5) * amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s;
}

// ------------------------------------------------------------------ heightfield
export interface FieldOpts {
  /** Samples per tile. */
  res: number;
  /** Blur radius in tiles: how round corners get in plan view. */
  blur: number;
  /** Half-width of the re-sharpening band (0.5 = plain blur, small = steep walls). */
  sharp: number;
  /** Rock roughness amplitude. */
  rough: number;
  /** Flat (faceted) shading. */
  facet?: boolean;
  /** Terrace step for walls (0 = none). */
  terrace?: number;
  /** Add a skirt down to this local y around the slice (diorama cut). */
  skirt?: number;
}

export interface Field {
  geometry: BufferGeometry;
  /** Local height at world x/z (bilinear on the sample grid). */
  heightAt(x: number, z: number): number;
}

function boxBlur(src: Float32Array, n: number, r: number): Float32Array {
  if (r <= 0) return src;
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[j * n + Math.max(0, Math.min(n - 1, i + k))]!;
      tmp[j * n + i] = s / w;
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.max(0, Math.min(n - 1, j + k)) * n + i]!;
      out[j * n + i] = s / w;
    }
  return out;
}
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Level-set smoothed heightfield: each height level's cell mask is blurred and re-thresholded, so plateaus, cliffs,
 * river beds and chasms get rounded outlines in plan (marching-squares-like) and steep, beveled walls — the grid stays
 * exact at cell centres (readable footprint) but stops reading as boxes. Bakes per-vertex sun visibility (`sun`),
 * cavity AO (`ao`), and per-class masks `m` (vec4) the materials blend with.
 */
export function buildField(map: readonly string[], heights: Record<string, number>, masks: [string, string, string, string], o: FieldOpts): Field {
  const n = S * o.res + 1;
  const cellAt = (i: number, j: number): string => code(map, Math.floor(i / o.res - 1e-4 + 1e-3), Math.floor(j / o.res - 1e-4 + 1e-3));
  const levels = [...new Set(Object.values(heights))].sort((a, b) => a - b);
  const h = new Float32Array(n * n).fill(levels[0]!);
  const br = Math.round(o.blur * o.res);
  for (let k = 1; k < levels.length; k++) {
    const ind = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ind[j * n + i] = heights[cellAt(i, j)]! >= levels[k]! - 1e-6 ? 1 : 0;
    const b = boxBlur(boxBlur(ind, n, br), n, br);
    for (let q = 0; q < n * n; q++) h[q] = h[q]! + (levels[k]! - levels[k - 1]!) * smooth(0.5 - o.sharp, 0.5 + o.sharp, b[q]!);
  }
  // per-class masks, softly blurred
  const mr = Math.max(1, Math.round(0.3 * o.res));
  const mk = masks.map((codes) => {
    const ind = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ind[j * n + i] = codes.includes(cellAt(i, j)) ? 1 : 0;
    return boxBlur(ind, n, mr);
  });
  // roughness: rock walls and crags get lumpy, open ground gets a gentle swell
  const rockMask = boxBlur(
    (() => {
      const ind = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ind[j * n + i] = 'CRBOK'.includes(cellAt(i, j)) ? 1 : 0;
      return ind;
    })(),
    n,
    mr,
  );
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = i / o.res;
      const y = j / o.res;
      const q = j * n + i;
      h[q] = h[q]! + fbm(x * 0.45, y * 0.45, 3) * 0.12 + fbm(x * 2.2 + 7, y * 2.2, 3) * o.rough * rockMask[q]!;
      if (o.terrace) h[q] = Math.round(h[q]! / o.terrace) * o.terrace * 0.7 + h[q]! * 0.3;
    }
  const heightAt = (wxp: number, wzp: number): number => {
    const fi = Math.max(0, Math.min(n - 1.001, (wxp + HALF) * o.res));
    const fj = Math.max(0, Math.min(n - 1.001, (wzp + HALF) * o.res));
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const u = fi - i;
    const v = fj - j;
    const a = h[j * n + i]!;
    const b = h[j * n + i + 1]!;
    const c = h[(j + 1) * n + i]!;
    const d = h[(j + 1) * n + i + 1]!;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  // baked sun visibility: soft shadow march toward SUN_DIR over the field
  const sun = new Float32Array(n * n);
  const ao = new Float32Array(n * n);
  const horiz = Math.hypot(SUN_DIR.x, SUN_DIR.z);
  const rise = SUN_DIR.y / horiz;
  const dx = SUN_DIR.x / horiz;
  const dz = SUN_DIR.z / horiz;
  const ar = Math.round(0.8 * o.res);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x0 = -HALF + i / o.res;
      const z0 = -HALF + j / o.res;
      const y0 = h[j * n + i]! + 0.02;
      let vis = 1;
      for (let t = 0.15; t < 9; t += 0.15) {
        const hh = heightAt(x0 + dx * t, z0 + dz * t);
        const ry = y0 + rise * t;
        vis = Math.min(vis, (6 * (ry - hh)) / t + 0.5);
        if (vis <= 0) break;
      }
      sun[j * n + i] = Math.max(0, Math.min(1, vis));
      let s = 0;
      let c = 0;
      for (let b = -ar; b <= ar; b += 2)
        for (let a = -ar; a <= ar; a += 2) {
          s += h[Math.max(0, Math.min(n - 1, j + b)) * n + Math.max(0, Math.min(n - 1, i + a))]!;
          c++;
        }
      ao[j * n + i] = Math.max(0.3, Math.min(1, 1 - Math.max(0, s / c - h[j * n + i]!) * 0.9));
    }
  // mesh
  const pos: number[] = [];
  const sunA: number[] = [];
  const aoA: number[] = [];
  const mA: number[] = [];
  const push = (x: number, y: number, z: number, q: number, wall = 0): void => {
    pos.push(x, y, z);
    sunA.push(wall ? 0.4 : sun[q]!);
    aoA.push(wall ? 0.7 : ao[q]!);
    mA.push(mk[0]![q]!, mk[1]![q]!, mk[2]![q]!, mk[3]![q]!);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) push(-HALF + i / o.res, h[j * n + i]!, -HALF + j / o.res, j * n + i);
  const idx: number[] = [];
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // split along the shorter diagonal: fewer slivers on walls
      if (Math.abs(h[a]! - h[d]!) < Math.abs(h[b]! - h[c]!)) idx.push(a, c, d, a, d, b);
      else idx.push(a, c, b, b, c, d);
    }
  if (o.skirt !== undefined) {
    // diorama cut: the slice's four edges dropped to o.skirt
    const edge = (list: number[]): void => {
      for (let k = 0; k < list.length - 1; k++) {
        const q0 = list[k]!;
        const q1 = list[k + 1]!;
        const base = pos.length / 3;
        const p0 = [pos[q0 * 3]!, pos[q0 * 3 + 1]!, pos[q0 * 3 + 2]!];
        const p1 = [pos[q1 * 3]!, pos[q1 * 3 + 1]!, pos[q1 * 3 + 2]!];
        push(p0[0]!, p0[1]!, p0[2]!, q0, 1);
        push(p1[0]!, p1[1]!, p1[2]!, q1, 1);
        push(p0[0]!, o.skirt!, p0[2]!, q0, 1);
        push(p1[0]!, o.skirt!, p1[2]!, q1, 1);
        idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    };
    const north: number[] = [];
    const south: number[] = [];
    const west: number[] = [];
    const east: number[] = [];
    for (let i = 0; i < n; i++) {
      north.push(i);
      south.push((n - 1) * n + (n - 1 - i));
      east.push(i * n + (n - 1));
      west.push((n - 1 - i) * n);
    }
    edge(north.reverse());
    edge(south.reverse());
    edge(east);
    edge(west);
  }
  let g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('sun', new BufferAttribute(new Float32Array(sunA), 1));
  g.setAttribute('ao', new BufferAttribute(new Float32Array(aoA), 1));
  g.setAttribute('m', new BufferAttribute(new Float32Array(mA), 4));
  g.setIndex(idx);
  if (o.facet) g = g.toNonIndexed();
  g.computeVertexNormals();
  return { geometry: g, heightAt };
}

// ------------------------------------------------------------------ props
/** Floating island: flat grassy top, rocky taproot below. Attribute `top` = 1 on the grass cap. */
export function islandGeometry(r: number, seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, 5);
  const p = g.getAttribute('position');
  const top = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const a = Math.atan2(z, x);
    const rim = 1 + fbm(Math.cos(a) * 2 + seed, Math.sin(a) * 2 + seed, 3) * 0.5;
    if (y >= -0.08) {
      p.setXYZ(i, x * r * rim, 0.18 * y + fbm(x * 3 + seed, z * 3, 2) * 0.25 + 0.05, z * r * rim);
      top[i] = 1;
    } else {
      const d = -y;
      const taper = (1 - d) ** 0.7 + 0.08;
      const jag = 1 + fbm(x * 4 + seed, z * 4 + y * 3, 3) * 0.6;
      p.setXYZ(i, x * r * rim * taper * jag, -(d ** 0.9) * r * 1.35 + fbm(x * 5, z * 5 + seed, 2) * 0.3, z * r * rim * taper * jag);
      top[i] = 0;
    }
  }
  g.setAttribute('top', new BufferAttribute(top, 1));
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const merged = mergeVertices(g);
  merged.computeVertexNormals();
  return merged;
}

export function asteroidGeometry(r: number, seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, 4);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const v = new Vector3(p.getX(i), p.getY(i), p.getZ(i));
    const d = 1 + fbm(v.x * 1.6 + seed, v.y * 1.6 + v.z, 4) * 0.7 + fbm(v.z * 5, v.x * 5 + v.y, 2) * 0.12;
    v.multiplyScalar(d * r);
    v.y *= 0.8;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Cloud puff cluster: overlapping spheres (merged), flat-ish bottom. */
export function cloudGeometry(seed: number, size: number): BufferGeometry {
  const parts: Part[] = [];
  const k = 5 + Math.floor(hash2(seed, 9) * 4);
  for (let i = 0; i < k; i++) {
    const a = hash2(seed, i) * Math.PI * 2;
    const d = hash2(seed, i + 40) * size * 0.9;
    const s = size * (0.45 + hash2(seed, i + 80) * 0.45);
    const geo = new IcosahedronGeometry(s, 3);
    geo.scale(1, 0.72, 1).translate(Math.cos(a) * d, s * 0.25, Math.sin(a) * d * 0.7);
    parts.push({ geo, paint: '#ffffff' });
  }
  const g = merge(parts);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setY(i, p.getY(i) * 0.25);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ unit kit
interface Part {
  geo: BufferGeometry;
  paint: string;
  /** How much the team colour replaces the paint. */
  accent?: number;
  /** Emissive strength. */
  glow?: number;
}

/** Merge primitives into one geometry with per-vertex `paint` (vec3), `accent`, `glow`. */
export function merge(parts: Part[]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const paint: number[] = [];
  const accent: number[] = [];
  const glow: number[] = [];
  const c = new Color();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    g.computeVertexNormals();
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    c.set(p.paint);
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      paint.push(c.r, c.g, c.b);
      accent.push(p.accent ?? 0);
      glow.push(p.glow ?? 0);
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('paint', new BufferAttribute(new Float32Array(paint), 3));
  out.setAttribute('accent', new BufferAttribute(new Float32Array(accent), 1));
  out.setAttribute('glow', new BufferAttribute(new Float32Array(glow), 1));
  out.computeBoundingSphere();
  return out;
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0): BufferGeometry => new BoxGeometry(w, h, d).translate(x, y + h / 2, z);
const METAL = '#a7adb5';
const DARK = '#3a3f47';

/**
 * Unit silhouettes (≈ game scale: a trooper is ~0.45 tall). Shapes are exaggerated per class so they read at RTS
 * zoom: troopers = upright pill, tanks = wide low wedge, flyers = darts/flying wings, orbit = long needles and panels.
 * Faces +X; y = 0 is the ground contact.
 */
export function unitGeometry(kind: Kind): BufferGeometry {
  switch (kind) {
    case 'trooper':
      return merge([
        { geo: new CylinderGeometry(0.11, 0.13, 0.3, 8).translate(0, 0.17, 0), paint: '#d9d3c4', accent: 0.85 },
        { geo: new SphereGeometry(0.1, 10, 8).translate(0.01, 0.4, 0), paint: '#e8dccb' },
        { geo: box(0.08, 0.16, 0.16, -0.12, 0.14, 0), paint: DARK },
        { geo: box(0.26, 0.04, 0.04, 0.12, 0.24, 0.07), paint: DARK },
      ]);
    case 'tank':
      return merge([
        { geo: box(0.86, 0.14, 0.62, 0, 0, 0), paint: DARK },
        { geo: box(0.74, 0.16, 0.5, 0, 0.12, 0), paint: '#c9c2b0', accent: 0.8 },
        { geo: new CylinderGeometry(0.17, 0.2, 0.14, 8).translate(-0.05, 0.35, 0), paint: '#c9c2b0', accent: 0.6 },
        { geo: new CylinderGeometry(0.04, 0.04, 0.5, 6).rotateZ(Math.PI / 2).translate(0.3, 0.36, 0), paint: DARK },
      ]);
    case 'turret':
      return merge([
        { geo: new CylinderGeometry(0.36, 0.44, 0.3, 8).translate(0, 0.15, 0), paint: '#8d8f93' },
        { geo: new CylinderGeometry(0.24, 0.3, 0.22, 8).translate(0, 0.41, 0), paint: '#c9c2b0', accent: 0.85 },
        { geo: new CylinderGeometry(0.05, 0.05, 0.55, 6).rotateZ(Math.PI / 2).translate(0.34, 0.45, 0), paint: DARK },
        { geo: new SphereGeometry(0.06, 8, 6).translate(0, 0.56, 0), paint: '#ffffff', glow: 1.2, accent: 1 },
      ]);
    case 'spire':
      return merge([
        { geo: new CylinderGeometry(0.7, 0.95, 0.35, 6).translate(0, 0.17, 0), paint: '#6b6e75' },
        { geo: new OctahedronGeometry(0.55, 0).scale(0.8, 2.2, 0.8).translate(0, 1.55, 0), paint: '#ffffff', accent: 0.7, glow: 1.4 },
        { geo: new TorusGeometry(0.62, 0.06, 6, 24).rotateX(Math.PI / 2).translate(0, 0.42, 0), paint: '#ffffff', accent: 1, glow: 1 },
      ]);
    case 'digger':
      return merge([
        { geo: box(0.5, 0.2, 0.36, 0, 0.06, 0), paint: '#c9c2b0', accent: 0.85 },
        { geo: new ConeGeometry(0.15, 0.32, 8).rotateZ(-Math.PI / 2).translate(0.38, 0.16, 0), paint: METAL },
        { geo: new CylinderGeometry(0.08, 0.08, 0.42, 8).rotateX(Math.PI / 2).translate(-0.14, 0.08, 0), paint: DARK },
        { geo: new CylinderGeometry(0.08, 0.08, 0.42, 8).rotateX(Math.PI / 2).translate(0.14, 0.08, 0), paint: DARK },
        { geo: new SphereGeometry(0.05, 8, 6).translate(0.05, 0.31, 0.1), paint: '#ffe8b0', glow: 1.6 },
      ]);
    case 'sapper':
      return merge([
        { geo: new CylinderGeometry(0.11, 0.13, 0.28, 8).translate(0, 0.16, 0), paint: '#c9c2b0', accent: 0.85 },
        { geo: new SphereGeometry(0.09, 10, 8).translate(0, 0.37, 0), paint: '#e8dccb' },
        { geo: box(0.16, 0.16, 0.2, -0.13, 0.08, 0), paint: '#8a5a2a' },
        { geo: new SphereGeometry(0.035, 6, 5).translate(-0.13, 0.28, 0), paint: '#ffd23f', glow: 2 },
      ]);
    case 'interceptor':
      return merge([
        { geo: new ConeGeometry(0.1, 0.7, 8).rotateZ(-Math.PI / 2), paint: '#d9d3c4', accent: 0.6 },
        { geo: box(0.3, 0.03, 0.72, -0.08, -0.015, 0), paint: '#c9c2b0', accent: 0.9 },
        { geo: box(0.14, 0.16, 0.03, -0.25, 0, 0), paint: '#c9c2b0', accent: 0.9 },
        { geo: new SphereGeometry(0.05, 6, 5).translate(-0.36, 0, 0), paint: '#ffe0a0', glow: 2 },
      ]);
    case 'bomber':
      return merge([
        { geo: new SphereGeometry(0.22, 12, 8).scale(1.7, 0.6, 1), paint: '#d9d3c4', accent: 0.5 },
        { geo: new CylinderGeometry(0.55, 0.55, 0.05, 3).rotateY(Math.PI / 2).scale(0.85, 1, 1).translate(-0.1, 0, 0), paint: '#c9c2b0', accent: 0.9 },
        { geo: new SphereGeometry(0.05, 6, 5).translate(-0.4, 0, 0.18), paint: '#ffe0a0', glow: 2 },
        { geo: new SphereGeometry(0.05, 6, 5).translate(-0.4, 0, -0.18), paint: '#ffe0a0', glow: 2 },
      ]);
    case 'relay':
      return merge([
        { geo: new CylinderGeometry(0.28, 0.36, 0.22, 8).translate(0, 0.11, 0), paint: '#8d8f93' },
        { geo: new CylinderGeometry(0.05, 0.07, 0.9, 6).translate(0, 0.67, 0), paint: METAL },
        { geo: new SphereGeometry(0.34, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.6).rotateZ(-0.7).translate(0.08, 1.05, 0), paint: '#d9d3c4', accent: 0.8 },
        { geo: new SphereGeometry(0.06, 8, 6).translate(0, 1.16, 0), paint: '#ffffff', glow: 2, accent: 1 },
      ]);
    case 'tug':
      return merge([
        { geo: box(0.5, 0.24, 0.34, 0, -0.12, 0), paint: '#c9c2b0', accent: 0.85 },
        { geo: box(0.32, 0.05, 0.05, 0.36, -0.02, 0.12), paint: METAL },
        { geo: box(0.32, 0.05, 0.05, 0.36, -0.02, -0.12), paint: METAL },
        { geo: new CylinderGeometry(0.08, 0.12, 0.18, 8).rotateZ(Math.PI / 2).translate(-0.32, 0, 0), paint: DARK },
        { geo: new SphereGeometry(0.07, 6, 5).translate(-0.42, 0, 0), paint: '#a8e6ff', glow: 2.2 },
      ]);
    case 'lancer':
      return merge([
        { geo: new ConeGeometry(0.11, 1.3, 6).rotateZ(-Math.PI / 2), paint: '#d9d3c4', accent: 0.7 },
        { geo: new TorusGeometry(0.2, 0.035, 6, 16).rotateY(Math.PI / 2).translate(-0.3, 0, 0), paint: '#c9c2b0', accent: 1 },
        { geo: new SphereGeometry(0.05, 6, 5).translate(0.66, 0, 0), paint: '#ffffff', glow: 2.5, accent: 1 },
      ]);
    case 'array':
      return merge([
        { geo: box(0.2, 0.2, 0.2, 0, -0.1, 0), paint: '#c9c2b0', accent: 0.85 },
        { geo: box(0.5, 0.02, 0.9, 0, 0, 0.58), paint: '#2a3a6a', glow: 0.25 },
        { geo: box(0.5, 0.02, 0.9, 0, 0, -0.58), paint: '#2a3a6a', glow: 0.25 },
        { geo: box(0.56, 0.03, 0.04, 0, 0, 1.04), paint: '#c9c2b0', accent: 1 },
        { geo: box(0.56, 0.03, 0.04, 0, 0, -1.04), paint: '#c9c2b0', accent: 1 },
      ]);
  }
}

/** Rail sleepers + rails along rail cells (local to the Depths plane). */
export function railGeometry(): BufferGeometry {
  const parts: Part[] = [];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (code(DEPTHS_MAP, x, y) !== 'L') continue;
      const horiz = code(DEPTHS_MAP, x - 1, y) === 'L' || code(DEPTHS_MAP, x + 1, y) === 'L';
      const vert = code(DEPTHS_MAP, x, y - 1) === 'L' || code(DEPTHS_MAP, x, y + 1) === 'L';
      const dirs: [number, number][] = [];
      if (horiz) dirs.push([1, 0]);
      if (vert) dirs.push([0, 1]);
      for (const [dx] of dirs) {
        const rot = dx ? 0 : Math.PI / 2;
        for (let s = -0.375; s <= 0.375; s += 0.25)
          parts.push({ geo: box(0.08, 0.04, 0.5, s, 0.02, 0).rotateY(rot).translate(wx(x), 0, wz(y)), paint: '#5a3f2a' });
        for (const off of [-0.15, 0.15]) parts.push({ geo: box(1.02, 0.04, 0.05, 0, 0.06, off).rotateY(rot).translate(wx(x), 0, wz(y)), paint: '#b8c0c8', glow: 0.15 });
      }
    }
  return merge(parts);
}
