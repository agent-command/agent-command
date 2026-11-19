/**
 * Level-set smoothed heightfield over a map-sized grid (ported from apps/lookdev `buildField`): each height level's cell
 * mask is blurred and re-thresholded, so outlines get rounded corners in plan view (like marching squares) and walls
 * stay steep and bevelled, while cell centres keep their height (a cell still reads as a footprint). Bakes per-sample
 * sun visibility (a soft shadow march), cavity AO, normals and blurred class masks the materials blend with.
 *
 * Pure data (no three.js). `build(window)` recomputes only the samples of a window, so holes, chasms and digs rebuild
 * just the cells that changed; `terrain.ts` / `depths.ts` stitch the result into their vertex buffers.
 */
import type { ShoreJob } from './shore.ts';

export interface FieldSpec {
  /** Cells per side (the map; kept as data so the worker bundle stays free of game code). */
  size: number;
  /** Samples per tile. */
  res: number;
  /** Blur radius in tiles: how round corners get in plan view. */
  blur: number;
  /** Half-width of the re-sharpening band (0.5 = plain blur, small = steep walls). */
  sharp: number;
  /** Rock roughness amplitude (cells with class bit `ROCK_BIT`). */
  rough: number;
  /** Gentle low-frequency swell everywhere. */
  swell: number;
  /** Every height a cell can take. */
  levels: readonly number[];
  /** Bake sun visibility (static Surface); false: sun = 1 everywhere (underground). */
  sun: boolean;
}

/** Everything `build` produces (transferable typed arrays). */
export interface FieldBake {
  h: Float32Array;
  sun: Float32Array;
  ao: Float32Array;
  mask: Float32Array;
  normal: Float32Array;
}

/** Worker request: a full build of `level` / `cls` under `spec`, lit from `sun`, and the shore bake riding along. */
export interface FieldJob {
  id: number;
  spec: FieldSpec;
  level: Float32Array;
  cls: Uint8Array;
  sun: [number, number, number];
  shore?: ShoreJob | undefined;
}

/** Blurred class masks kept per sample (one per class bit). */
export const CLASS_BITS = 6;
/** Class bit that roughens the height (rock). */
export const ROCK_BIT = 1;

/** Sample window, inclusive, in sample indices. */
export interface Window {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

/** Integer hash to [0, 1) (the same as `common.ts`'s, kept here so worker code stays free of game and three.js). */
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
function fbm(x: number, y: number): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 3; i++) {
    s += (vnoise(x * f, y * f) - 0.5) * amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s;
}
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class HeightField {
  readonly spec: FieldSpec;
  /** Samples per side. */
  readonly n: number;
  /** Height per sample (local plane units). */
  h: Float32Array;
  sun: Float32Array;
  ao: Float32Array;
  /** Blurred class masks, CLASS_BITS per sample. */
  mask: Float32Array;
  /** Unit normals per sample (x, y, z). */
  normal: Float32Array;
  /** Inputs per cell, row-major: height level and class bits. Set them, then `build`. */
  readonly level: Float32Array;
  readonly cls: Uint8Array;
  private readonly levels: number[];
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly sunDir = { x: 0.62, y: 0.72, z: -0.24 };

  constructor(spec: FieldSpec) {
    this.spec = spec;
    const S = spec.size;
    this.n = S * spec.res + 1;
    const nn = this.n * this.n;
    this.h = new Float32Array(nn);
    this.sun = new Float32Array(nn).fill(1);
    this.ao = new Float32Array(nn).fill(1);
    this.mask = new Float32Array(nn * CLASS_BITS);
    this.normal = new Float32Array(nn * 3);
    this.level = new Float32Array(S * S);
    this.cls = new Uint8Array(S * S);
    this.levels = [...new Set(spec.levels)].sort((x, y) => x - y);
    this.a = new Float32Array(nn);
    this.b = new Float32Array(nn);
  }

  /** Take over a full build computed elsewhere (the worker) from the current `level` / `cls`. */
  /** Take a worker bake's arrays as they are (transferred, so zero-copy); the worker never touches them again. */
  adopt(b: FieldBake): void {
    this.h = b.h;
    this.sun = b.sun;
    this.ao = b.ao;
    this.mask = b.mask;
    this.normal = b.normal;
  }

  /** The baked arrays (for posting a worker result). */
  bakeData(): FieldBake {
    return { h: this.h, sun: this.sun, ao: this.ao, mask: this.mask, normal: this.normal };
  }

  /** Direction toward the key light (world space; the field's x/z are the map's). */
  setSun(x: number, y: number, z: number): void {
    const l = Math.hypot(x, y, z) || 1;
    this.sunDir.x = x / l;
    this.sunDir.y = y / l;
    this.sunDir.z = z / l;
  }

  /** Cell of sample (i, j): sample k·res is the corner shared by cells k-1 and k and belongs to cell k. */
  private cellOf(i: number, j: number): number {
    const r = this.spec.res;
    const S = this.spec.size;
    return Math.min(S - 1, Math.floor(j / r)) * S + Math.min(S - 1, Math.floor(i / r));
  }

  /** Samples covering cells [x0, x1] × [y0, y1] (inclusive) grown by `pad` cells, clamped to the map. */
  windowOf(x0: number, y0: number, x1: number, y1: number, pad: number): Window {
    const r = this.spec.res;
    const last = this.n - 1;
    return {
      i0: Math.max(0, (x0 - pad) * r),
      j0: Math.max(0, (y0 - pad) * r),
      i1: Math.min(last, (x1 + 1 + pad) * r),
      j1: Math.min(last, (y1 + 1 + pad) * r),
    };
  }

  full(): Window {
    return { i0: 0, j0: 0, i1: this.n - 1, j1: this.n - 1 };
  }

  private grow(w: Window, di: number, dj: number): Window {
    const last = this.n - 1;
    return { i0: Math.max(0, w.i0 - di), j0: Math.max(0, w.j0 - dj), i1: Math.min(last, w.i1 + di), j1: Math.min(last, w.j1 + dj) };
  }

  /** One box-blur pass (radius r, along x or y) of `src` into `dst` over `w`; reads clamp at the map border. */
  private pass(src: Float32Array, dst: Float32Array, alongX: boolean, r: number, w: Window): void {
    const n = this.n;
    const last = n - 1;
    const k = 1 / (2 * r + 1);
    for (let j = w.j0; j <= w.j1; j++)
      for (let i = w.i0; i <= w.i1; i++) {
        let s = 0;
        if (alongX) for (let d = -r; d <= r; d++) s += src[j * n + Math.max(0, Math.min(last, i + d))]!;
        else for (let d = -r; d <= r; d++) s += src[Math.max(0, Math.min(last, j + d)) * n + i]!;
        dst[j * n + i] = s * k;
      }
  }

  /** Fill `a` with an indicator over `w` grown by `reach` samples. Returns false if it is all zero. */
  private indicator(w: Window, reach: number, on: (cell: number) => boolean): boolean {
    const n = this.n;
    const e = this.grow(w, reach, reach);
    let any = false;
    for (let j = e.j0; j <= e.j1; j++)
      for (let i = e.i0; i <= e.i1; i++) {
        const v = on(this.cellOf(i, j)) ? 1 : 0;
        this.a[j * n + i] = v;
        any ||= v === 1;
      }
    return any;
  }

  /** Recompute heights, masks, normals, sun and AO of the samples in `w` from `level` / `cls`. */
  build(w: Window): void {
    const { res, blur, sharp, rough, swell } = this.spec;
    const n = this.n;
    const h = this.h;
    const a = this.a;
    const b = this.b;
    // heights are exact one sample around `w` (normals read them)
    const hw = this.grow(w, 1, 1);
    const levels = this.levels;
    for (let j = hw.j0; j <= hw.j1; j++) for (let i = hw.i0; i <= hw.i1; i++) h[j * n + i] = levels[0]!;
    // level sets: indicator → box blur twice (x, y, x, y passes of radius br) → re-sharpened step
    const br = Math.max(1, Math.round(blur * res));
    for (let k = 1; k < levels.length; k++) {
      const lv = levels[k]! - 1e-6;
      if (!this.indicator(hw, 2 * br, (c) => this.level[c]! >= lv)) continue;
      this.pass(a, b, true, br, this.grow(hw, br, 2 * br));
      this.pass(b, a, false, br, this.grow(hw, br, br));
      this.pass(a, b, true, br, this.grow(hw, 0, br));
      this.pass(b, a, false, br, hw);
      const step = levels[k]! - levels[k - 1]!;
      for (let j = hw.j0; j <= hw.j1; j++)
        for (let i = hw.i0; i <= hw.i1; i++) h[j * n + i] = h[j * n + i]! + step * smooth(0.5 - sharp, 0.5 + sharp, a[j * n + i]!);
    }
    // class masks, softly blurred once
    const mr = Math.max(1, Math.round(0.3 * res));
    const m = this.mask;
    for (let bit = 0; bit < CLASS_BITS; bit++) {
      const any = this.indicator(hw, mr, (c) => ((this.cls[c]! >> bit) & 1) === 1);
      if (any) {
        this.pass(a, b, true, mr, this.grow(hw, 0, mr));
        this.pass(b, a, false, mr, hw);
      }
      for (let j = hw.j0; j <= hw.j1; j++) for (let i = hw.i0; i <= hw.i1; i++) m[(j * n + i) * CLASS_BITS + bit] = any ? a[j * n + i]! : 0;
    }
    // roughness: rock gets lumpy, everything gets a gentle swell
    for (let j = hw.j0; j <= hw.j1; j++)
      for (let i = hw.i0; i <= hw.i1; i++) {
        const x = i / res;
        const y = j / res;
        const q = j * n + i;
        h[q] = h[q]! + fbm(x * 0.45, y * 0.45) * swell + fbm(x * 2.2 + 7, y * 2.2) * rough * m[q * CLASS_BITS + ROCK_BIT]!;
      }
    this.normals(w);
    this.bake(w);
  }

  /** Central-difference normals over `w`. */
  private normals(w: Window): void {
    const n = this.n;
    const last = n - 1;
    const h = this.h;
    const d = 2 / this.spec.res;
    for (let j = w.j0; j <= w.j1; j++)
      for (let i = w.i0; i <= w.i1; i++) {
        const dx = h[j * n + Math.min(last, i + 1)]! - h[j * n + Math.max(0, i - 1)]!;
        const dz = h[Math.min(last, j + 1) * n + i]! - h[Math.max(0, j - 1) * n + i]!;
        const l = Math.hypot(dx, d, dz);
        const o = (j * n + i) * 3;
        this.normal[o] = -dx / l;
        this.normal[o + 1] = d / l;
        this.normal[o + 2] = -dz / l;
      }
  }

  /** Baked sun visibility (soft shadow march toward the sun) and cavity AO over `w`. */
  private bake(w: Window): void {
    const n = this.n;
    const last = n - 1;
    const res = this.spec.res;
    const h = this.h;
    const s = this.sunDir;
    const horiz = Math.hypot(s.x, s.z) || 1;
    const rise = s.y / horiz;
    const dx = s.x / horiz;
    const dz = s.z / horiz;
    const ar = Math.round(0.8 * res);
    for (let j = w.j0; j <= w.j1; j++)
      for (let i = w.i0; i <= w.i1; i++) {
        const q = j * n + i;
        if (this.spec.sun) {
          const x0 = i / res;
          const z0 = j / res;
          const y0 = h[q]! + 0.02;
          let vis = 1;
          for (let t = 0.15; t < 9; t += 0.15) {
            const x = x0 + dx * t;
            const z = z0 + dz * t;
            if (x < 0 || z < 0 || x > this.spec.size || z > this.spec.size) break;
            vis = Math.min(vis, (6 * (y0 + rise * t - this.heightAt(x, z))) / t + 0.5);
            if (vis <= 0) break;
          }
          this.sun[q] = Math.max(0, Math.min(1, vis));
        }
        let sum = 0;
        let c = 0;
        for (let bj = -ar; bj <= ar; bj += 2)
          for (let bi = -ar; bi <= ar; bi += 2) {
            sum += h[Math.max(0, Math.min(last, j + bj)) * n + Math.max(0, Math.min(last, i + bi))]!;
            c++;
          }
        this.ao[q] = Math.max(0.3, Math.min(1, 1 - Math.max(0, sum / c - h[q]!) * 0.9));
      }
  }

  /** Height at tile coords (x, y) ∈ [0, size]², bilinear between samples. */
  heightAt(x: number, y: number): number {
    const n = this.n;
    const r = this.spec.res;
    const fi = Math.max(0, Math.min(n - 1.001, x * r));
    const fj = Math.max(0, Math.min(n - 1.001, y * r));
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const u = fi - i;
    const v = fj - j;
    const h = this.h;
    const a = h[j * n + i]!;
    const b = h[j * n + i + 1]!;
    const c = h[(j + 1) * n + i]!;
    const d = h[(j + 1) * n + i + 1]!;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** Blurred class mask `bit` at tile coords (nearest sample). */
  maskAt(x: number, y: number, bit: number): number {
    const n = this.n;
    const r = this.spec.res;
    const i = Math.max(0, Math.min(n - 1, Math.round(x * r)));
    const j = Math.max(0, Math.min(n - 1, Math.round(y * r)));
    return this.mask[(j * n + i) * CLASS_BITS + bit]!;
  }
}
