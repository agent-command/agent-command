/**
 * The Surface shore field: for every point of the water sheets, the signed distance (cells) to the nearest coast, plus
 * a flow direction and the ford/stone class, baked into one RGBA8 texture at `res` texels per cell (the render tier's
 * `Quality.shoreRes`). Water shading (`terrain.ts`) draws its colour bands, shoreline foam and drift from it with a
 * single sample.
 *
 * The coast is where the drawn heightfield rises through a sheet's water level, so foam hugs the visible bank, crags
 * and islands rather than cell edges; hole cells and the stepping stones of fords are coast too. Seeds sit on the coast
 * at sub-texel precision (the zero crossing between two texels), then two dead-reckoning passes in 8SSEDT order carry
 * each texel's nearest seed, so iso-distance lines stay smooth along diagonal and curved coasts.
 *
 * Baked once per map in the field worker with the full heightfield build; a coast change (a hole opening beside water)
 * re-bakes only a window around it on the main thread. Pure data (no three.js, no game code: the worker bundles it),
 * and no allocation per build after construction.
 *
 * Texel (i, j) covers tile coords [(i, j), (i + 1, j + 1)] / res. Channels:
 * - r: (distance + SHORE.inside) / SHORE_SPAN, distance > 0 on water, < 0 on land;
 * - g, b: flow direction along +x / +y (tile y is world z), 0.5 + 0.5·component;
 * - a: STONE_A inside a ford's stepping stone, else FORD_A × the ford share (bilinear over cell centres).
 */
import { hash2 } from './field.ts';

export const SHORE = {
  /** Texels per cell by default (the render tier picks its own: `Quality.shoreRes`). */
  res: 8,
  /** Farthest distance (cells) encoded on the water side: past every foam ring and colour band edge. */
  reach: 2,
  /** Farthest distance (cells) encoded on the land side: enough for the filtered zero crossing and stone interiors. */
  inside: 0.5,
  /** Bilinear wet-share where a sheet's water stops even over low ground (the old sheet mask threshold). */
  wetEdge: 0.27,
  /** Stepping-stone slots per ford cell, the chance each holds a stone (a wide ford basin stays mostly open water),
   * their radius range (cells) and the band of the cell their centres keep to. */
  stones: 2,
  stoneChance: 0.4,
  stoneMin: 0.1,
  stoneMax: 0.16,
  stoneInset: 0.22,
  /** Gain from shore-tangent alignment with the water body's long axis to full along-river flow. */
  alignGain: 2,
} as const;
/** Encoded distance range (cells): r = (distance + SHORE.inside) / SHORE_SPAN. */
export const SHORE_SPAN = SHORE.reach + SHORE.inside;
export const FORD_A = 0.5;
export const STONE_A = 1;
/** Shore source cell bits: a wet cell of the low or high sheet, a ford, or a solid obstacle (a hole) that is coast. */
export const SHORE_CELL = { low: 1, high: 2, ford: 4, solid: 8 } as const;
const NONE = 1e9;

export interface ShoreSource {
  readonly size: number;
  /** SHORE_CELL bits per cell, row-major. */
  readonly cells: Uint8Array;
  /** Water level (local height) of the low and the high sheet. */
  readonly levels: readonly [number, number];
  /** Drawn Surface height at tile coords. */
  heightAt(x: number, y: number): number;
}

/** A shore bake's inputs for the field worker, which supplies the heights from its own full build. */
export interface ShoreJob {
  res: number;
  cells: Uint8Array;
  levels: [number, number];
  drift: [number, number];
}

/** Inclusive cell box. */
export interface CellBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class ShoreField {
  readonly size: number;
  /** Texels per cell. */
  readonly res: number;
  /** Texels per side. */
  readonly n: number;
  /** RGBA8 texels, row-major (the texture's data). */
  readonly data: Uint8Array;
  /** Open-water drift (tile x, y) where no long axis is derivable; unit length. */
  readonly drift: readonly [number, number];
  /** Coast function: > 0 water, < 0 land, its zero the coast. */
  private readonly f: Float32Array;
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly d2: Float32Array;
  /** Water-body label per cell (dry cells take a wet neighbour's), and per body its long axis and elongation. */
  private readonly body: Int32Array;
  private readonly stack: Int32Array;
  private readonly axis: Float32Array;

  constructor(size: number, drift: readonly [number, number], res: number = SHORE.res) {
    this.size = size;
    this.res = res;
    this.n = size * res;
    const nn = this.n * this.n;
    this.data = new Uint8Array(nn * 4);
    const l = Math.hypot(drift[0], drift[1]) || 1;
    this.drift = [drift[0] / l, drift[1] / l];
    this.f = new Float32Array(nn);
    this.sx = new Float32Array(nn);
    this.sy = new Float32Array(nn);
    this.d2 = new Float32Array(nn);
    this.body = new Int32Array(size * size);
    this.stack = new Int32Array(size * size);
    this.axis = new Float32Array(size * size * 3);
  }

  /** Signed distance (cells) decoded from texel (i, j), as the shader reads it at a texel centre. */
  distanceAt(i: number, j: number): number {
    return (this.data[(j * this.n + i) * 4]! / 255) * SHORE_SPAN - SHORE.inside;
  }

  /**
   * Bake the whole map, or only the texels within `SHORE.reach` + 1 cells of `box` (the cells whose coast changed):
   * no distance farther out can change, since every encoded distance is clamped to the reach.
   */
  build(src: ShoreSource, box?: CellBox): void {
    const { n } = this;
    const R = this.res;
    const pad = SHORE.reach + 1;
    // written window W, and the computed window C: W grown by the reach, so every seed a W texel can see is in C
    const wx0 = box ? Math.max(0, (box.x0 - pad) * R) : 0, wy0 = box ? Math.max(0, (box.y0 - pad) * R) : 0;
    const wx1 = box ? Math.min(n - 1, (box.x1 + 1 + pad) * R - 1) : n - 1, wy1 = box ? Math.min(n - 1, (box.y1 + 1 + pad) * R - 1) : n - 1;
    const grow = (SHORE.reach + 1) * R;
    const cx0 = Math.max(0, wx0 - grow), cy0 = Math.max(0, wy0 - grow), cx1 = Math.min(n - 1, wx1 + grow), cy1 = Math.min(n - 1, wy1 + grow);
    this.bodies(src);
    this.coast(src, cx0, cy0, cx1, cy1);
    this.seed(src.cells, cx0, cy0, cx1, cy1);
    this.sweep(cx0, cy0, cx1, cy1);
    this.write(src, wx0, wy0, wx1, wy1);
  }

  /** Wet share of the cells with `bit` at tile coords, bilinear between cell centres (a TileMask's filtering). */
  private share(cells: Uint8Array, bit: number, x: number, y: number): number {
    const S = this.size, last = S - 1;
    const fx = x - 0.5, fy = y - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy;
    const x0 = Math.max(0, Math.min(last, ix)), x1 = Math.max(0, Math.min(last, ix + 1));
    const r0 = Math.max(0, Math.min(last, iy)) * S, r1 = Math.max(0, Math.min(last, iy + 1)) * S;
    const a = cells[r0 + x0]! & bit ? 1 : 0, b = cells[r0 + x1]! & bit ? 1 : 0;
    const c = cells[r1 + x0]! & bit ? 1 : 0, d = cells[r1 + x1]! & bit ? 1 : 0;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /** The coast function over the computed window. */
  private coast(src: ShoreSource, i0: number, j0: number, i1: number, j1: number): void {
    const { size: S, n, f } = this;
    const R = this.res;
    const cells = src.cells;
    const [low, high] = src.levels;
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) / R, cy = Math.min(S - 1, Math.floor(y));
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) / R, cx = Math.min(S - 1, Math.floor(x));
        const code = cells[cy * S + cx]!;
        let v: number;
        if (code & SHORE_CELL.solid) v = -1;
        else {
          const h = src.heightAt(x, y);
          const wl = this.share(cells, SHORE_CELL.low, x, y), wh = this.share(cells, SHORE_CELL.high, x, y);
          v = Math.max(Math.min(low - h, wl - SHORE.wetEdge), Math.min(high - h, wh - SHORE.wetEdge));
          if (code & SHORE_CELL.ford) v = Math.min(v, this.stone(cx, cy, x, y));
        }
        f[j * n + i] = v;
      }
    }
  }

  /** Signed distance (cells) to the nearest stepping stone of ford cell (cx, cy): fixed per cell, never per frame. */
  private stone(cx: number, cy: number, x: number, y: number): number {
    let best = NONE;
    const band = 1 - 2 * SHORE.stoneInset;
    for (let k = 0; k < SHORE.stones; k++) {
      if (hash2(cx * 3 + k * 71, cy * 17 + 5) >= SHORE.stoneChance) continue;
      const px = cx + SHORE.stoneInset + band * hash2(cx * 7 + k * 131, cy * 13 + 17);
      const py = cy + SHORE.stoneInset + band * hash2(cy * 11 + k * 97, cx * 5 + 29);
      const r = SHORE.stoneMin + (SHORE.stoneMax - SHORE.stoneMin) * hash2(cx + k * 53, cy * 3 + k);
      best = Math.min(best, Math.hypot(x - px, y - py) - r);
    }
    return best;
  }

  /**
   * Seeds: the coast's crossing on each texel edge whose ends differ in sign, kept by the nearer of its two texels. A
   * hole's coast is its cell edge, which is the shared edge of the two texels (the midpoint between their centres).
   */
  private seed(cells: Uint8Array, i0: number, j0: number, i1: number, j1: number): void {
    const { size: S, n, f, sx, sy, d2 } = this;
    const R = this.res;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const q = j * n + i;
      sx[q] = NONE;
      sy[q] = NONE;
      d2[q] = NONE;
    }
    const offer = (q: number, x: number, y: number, dist: number): void => {
      const dd = dist * dist;
      if (dd < d2[q]!) { d2[q] = dd; sx[q] = x; sy[q] = y; }
    };
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const q = j * n + i, a = f[q]!;
      const x = (i + 0.5) / R, y = (j + 0.5) / R;
      const cx = Math.floor(i / R), cy = Math.floor(j / R), solid = cells[cy * S + cx]! & SHORE_CELL.solid;
      if (i < i1) {
        const b = f[q + 1]!;
        if ((a > 0) !== (b > 0)) {
          const t = solid !== (cells[cy * S + Math.floor((i + 1) / R)]! & SHORE_CELL.solid) ? 0.5 : a / (a - b);
          offer(q, x + t / R, y, t / R);
          offer(q + 1, x + t / R, y, (1 - t) / R);
        }
      }
      if (j < j1) {
        const b = f[q + n]!;
        if ((a > 0) !== (b > 0)) {
          const t = solid !== (cells[Math.floor((j + 1) / R) * S + cx]! & SHORE_CELL.solid) ? 0.5 : a / (a - b);
          offer(q, x, y + t / R, t / R);
          offer(q + n, x, y + t / R, (1 - t) / R);
        }
      }
    }
  }

  /**
   * Two raster passes passing each texel's nearest seed on to its 8 neighbours (8SSEDT order): down the rows, each row
   * swept forward from the row above and its left, then back from its right; then up the rows, mirrored.
   */
  private sweep(i0: number, j0: number, i1: number, j1: number): void {
    const { n, sx, sy, d2 } = this;
    const R = this.res;
    const take = (q: number, from: number, x: number, y: number): void => {
      const s = sx[from]!;
      if (s === NONE) return;
      const dx = x - s, dy = y - sy[from]!, dd = dx * dx + dy * dy;
      if (dd < d2[q]!) { d2[q] = dd; sx[q] = s; sy[q] = sy[from]!; }
    };
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) / R;
      for (let i = i0; i <= i1; i++) {
        const q = j * n + i, x = (i + 0.5) / R;
        if (j > j0) {
          if (i > i0) take(q, q - n - 1, x, y);
          take(q, q - n, x, y);
          if (i < i1) take(q, q - n + 1, x, y);
        }
        if (i > i0) take(q, q - 1, x, y);
      }
      for (let i = i1 - 1; i >= i0; i--) take(j * n + i, j * n + i + 1, (i + 0.5) / R, y);
    }
    for (let j = j1; j >= j0; j--) {
      const y = (j + 0.5) / R;
      for (let i = i1; i >= i0; i--) {
        const q = j * n + i, x = (i + 0.5) / R;
        if (j < j1) {
          if (i < i1) take(q, q + n + 1, x, y);
          take(q, q + n, x, y);
          if (i > i0) take(q, q + n - 1, x, y);
        }
        if (i < i1) take(q, q + 1, x, y);
      }
      for (let i = i0 + 1; i <= i1; i++) take(j * n + i, j * n + i - 1, (i + 0.5) / R, y);
    }
  }

  /**
   * Water bodies (4-connected wet cells): each one's long axis and elongation from its cells' covariance. A river's
   * long axis says which way along its banks it flows; a round lake has none and drifts with the breeze instead.
   */
  private bodies(src: ShoreSource): void {
    const { size: S, body, stack, axis } = this;
    const cells = src.cells;
    const wet = (c: number): boolean => (cells[c]! & (SHORE_CELL.low | SHORE_CELL.high)) !== 0 && (cells[c]! & SHORE_CELL.solid) === 0;
    body.fill(0);
    let id = 0;
    for (let c0 = 0; c0 < S * S; c0++) {
      if (body[c0] || !wet(c0)) continue;
      id++;
      let top = 0, cnt = 0, mx = 0, my = 0, xx = 0, xy = 0, yy = 0;
      stack[top++] = c0;
      body[c0] = id;
      while (top) {
        const c = stack[--top]!;
        const x = c % S, y = (c / S) | 0;
        cnt++; mx += x; my += y; xx += x * x; xy += x * y; yy += y * y;
        if (x > 0 && !body[c - 1] && wet(c - 1)) { body[c - 1] = id; stack[top++] = c - 1; }
        if (x < S - 1 && !body[c + 1] && wet(c + 1)) { body[c + 1] = id; stack[top++] = c + 1; }
        if (y > 0 && !body[c - S] && wet(c - S)) { body[c - S] = id; stack[top++] = c - S; }
        if (y < S - 1 && !body[c + S] && wet(c + S)) { body[c + S] = id; stack[top++] = c + S; }
      }
      mx /= cnt; my /= cnt;
      const a = xx / cnt - mx * mx, b = xy / cnt - mx * my, d = yy / cnt - my * my;
      const mid = (a + d) / 2, rad = Math.hypot((a - d) / 2, b);
      const theta = 0.5 * Math.atan2(2 * b, a - d);
      axis[id * 3] = Math.cos(theta);
      axis[id * 3 + 1] = Math.sin(theta);
      axis[id * 3 + 2] = mid + rad > 0 ? 1 - (mid - rad) / (mid + rad) : 0;
    }
    // dry cells (banks, islands) take a wet neighbour's body: the water reaching over their edge flows with it
    for (let c = 0; c < S * S; c++) {
      if (body[c]! > 0) continue;
      const x = c % S, y = (c / S) | 0;
      for (let dy = -1; dy <= 1 && !body[c]; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx2 = x + dx, yy2 = y + dy;
        if (xx2 < 0 || yy2 < 0 || xx2 >= S || yy2 >= S) continue;
        const o = body[yy2 * S + xx2]!;
        if (o > 0) { body[c] = -o; break; }
      }
    }
  }

  private write(src: ShoreSource, i0: number, j0: number, i1: number, j1: number): void {
    const { size: S, n, f, sx, sy, d2, data, body, axis } = this;
    const R = this.res;
    const [driftX, driftY] = this.drift;
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) / R, cy = Math.min(S - 1, Math.floor(y));
      for (let i = i0; i <= i1; i++) {
        const q = j * n + i, o = q * 4, x = (i + 0.5) / R, cx = Math.min(S - 1, Math.floor(x));
        const water = f[q]! > 0;
        const dist = d2[q]! < NONE ? Math.sqrt(d2[q]!) : SHORE_SPAN;
        const sd = Math.max(-SHORE.inside, Math.min(SHORE.reach, water ? dist : -dist));
        data[o] = Math.round(((sd + SHORE.inside) / SHORE_SPAN) * 255);
        // flow: along the bank (the tangent of the distance gradient), signed by the body's long axis, weighted by
        // how elongated the body is; round lakes and open water keep the breeze drift
        let fx = driftX, fy = driftY;
        const k = Math.abs(body[cy * S + cx]!);
        if (k && sx[q]! < NONE && dist > 1e-4) {
          const nx = (x - sx[q]!) / dist, ny = (y - sy[q]!) / dist;
          const tx = -ny, ty = nx;
          const ax = axis[k * 3]!, ay = axis[k * 3 + 1]!, el = axis[k * 3 + 2]!;
          const along = Math.max(-1, Math.min(1, (tx * ax + ty * ay) * SHORE.alignGain));
          fx += (tx * along - fx) * el;
          fy += (ty * along - fy) * el;
        }
        data[o + 1] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, fx)));
        data[o + 2] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, fy)));
        const code = src.cells[cy * S + cx]!;
        const stone = code & SHORE_CELL.ford && !(code & SHORE_CELL.solid) && this.stone(cx, cy, x, y) < 0;
        data[o + 3] = stone ? Math.round(STONE_A * 255) : Math.round(FORD_A * 255 * this.share(src.cells, SHORE_CELL.ford, x, y));
      }
    }
  }
}
