import { describe, expect, it } from 'vitest';
import { FORD_A, SHORE, SHORE_CELL, STONE_A, ShoreField, type ShoreSource } from '../src/world/shore.ts';

const SIZE = 24;
const LEVELS = [-0.16, 0.64] as const;
/** One encoded step of the r channel, in cells. */
const STEP = (SHORE.reach + SHORE.inside) / 255;

/**
 * A source whose drawn height crosses the low water level exactly on `coast(x, y) = 0` (> 0 on the water side). A cell
 * is wet when any corner or its centre is, so the heights (not the cell edges) place the coast.
 */
function source(coast: (x: number, y: number) => number, mark: (cx: number, cy: number) => number = () => 0): ShoreSource {
  const cells = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const wet = [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].some(([dx, dy]) => coast(x + dx!, y + dy!) > 0);
    cells[y * SIZE + x] = mark(x, y) || (wet ? SHORE_CELL.low : 0);
  }
  return { size: SIZE, cells, levels: LEVELS, heightAt: (x, y) => LEVELS[0] - coast(x, y) * 0.5 };
}
const texel = (x: number) => Math.floor(x * SHORE.res);
const centre = (i: number) => (i + 0.5) / SHORE.res;

describe('shore field', () => {
  it('measures distance from a straight coast at sub-texel precision, signed across it', () => {
    const shore = new ShoreField(SIZE, [1, 0]);
    shore.build(source((x) => 12.3 - x));
    const j = texel(10.5);
    for (const x of [12.2, 11.9, 11.4, 11, 10.5]) {
      const i = texel(x);
      expect(shore.distanceAt(i, j)).toBeCloseTo(12.3 - centre(i), 1);
      expect(Math.abs(shore.distanceAt(i, j) - (12.3 - centre(i)))).toBeLessThan(STEP + 1e-3);
    }
    // land reads negative down to the encoded inside limit; open water saturates at the reach
    expect(shore.distanceAt(texel(12.6), j)).toBeLessThan(0);
    expect(shore.distanceAt(texel(14), j)).toBeCloseTo(-SHORE.inside, 5);
    expect(shore.distanceAt(texel(2), j)).toBeCloseTo(SHORE.reach, 5);
  });

  it('follows a round island smoothly rather than its cell steps', () => {
    const shore = new ShoreField(SIZE, [1, 0]);
    const r0 = 3.2;
    shore.build(source((x, y) => Math.hypot(x - 12, y - 12) - r0));
    let worst = 0;
    for (let a = 0; a < Math.PI * 2; a += 0.21) for (const r of [r0 + 0.3, r0 + 0.9, r0 + 1.6]) {
      const i = texel(12 + Math.cos(a) * r), j = texel(12 + Math.sin(a) * r);
      const truth = Math.hypot(centre(i) - 12, centre(j) - 12) - r0;
      worst = Math.max(worst, Math.abs(shore.distanceAt(i, j) - truth));
    }
    // within the encoding step: a cell-edge (blocky) coast would be off by up to ~0.7 cells on the diagonals, and
    // plain two-sweep dead reckoning by ~0.1 cells two cells out (measured)
    expect(worst).toBeLessThan(2 * STEP);
    expect(shore.distanceAt(texel(12), texel(12))).toBeCloseTo(-SHORE.inside, 5);
  });

  it('treats a hole in the water as coast: foam rings it', () => {
    const shore = new ShoreField(SIZE, [1, 0]);
    shore.build(source(() => 5, (x, y) => (x === 12 && y === 12 ? SHORE_CELL.solid : 0)));
    expect(shore.distanceAt(texel(12.5), texel(12.5))).toBeLessThan(0);
    // the hole's coast is its cell edge, x = 13 and y = 12
    expect(Math.abs(shore.distanceAt(texel(14.5), texel(12.5)) - (centre(texel(14.5)) - 13))).toBeLessThan(STEP);
    expect(Math.abs(shore.distanceAt(texel(12.5), texel(10.5)) - (12 - centre(texel(10.5))))).toBeLessThan(STEP);
  });

  it('re-bakes only the window around a changed coast, matching a full bake there', () => {
    const before = source((x) => 12.3 - x);
    const shore = new ShoreField(SIZE, [1, 0]);
    shore.build(before);
    const untouched = shore.data.slice();
    // a hole opens in the water beside the bank
    const after = { ...before, cells: before.cells.slice() };
    after.cells[6 * SIZE + 10] = SHORE_CELL.solid;
    shore.build(after, { x0: 10, y0: 6, x1: 10, y1: 6 });
    const full = new ShoreField(SIZE, [1, 0]);
    full.build(after);
    let worst = 0, changed = 0;
    for (let q = 0; q < shore.data.length; q += 4) {
      worst = Math.max(worst, Math.abs(shore.data[q]! - full.data[q]!));
      if (shore.data[q] !== untouched[q]) changed++;
    }
    expect(worst).toBeLessThanOrEqual(1);
    expect(changed).toBeGreaterThan(0);
    // far from the hole nothing was rewritten
    const n = shore.n, far = (texel(20) * n + texel(20)) * 4;
    expect(shore.data[far]).toBe(untouched[far]);
    expect(shore.distanceAt(texel(10.5), texel(6.5))).toBeLessThan(0);
  });

  it('puts stepping stones in fords, ringed by water like any coast, and marks the ford share', () => {
    const shore = new ShoreField(SIZE, [1, 0]);
    shore.build(source(() => 5, (x, y) => (y === 12 && x >= 8 && x <= 15 ? SHORE_CELL.low | SHORE_CELL.ford : 0)));
    const n = shore.n;
    let stones = 0, dryStones = 0;
    for (let j = texel(12); j < texel(13); j++) for (let i = texel(8); i < texel(16); i++) {
      const a = shore.data[(j * n + i) * 4 + 3]! / 255;
      // dry, to the encoding's precision (a texel just inside the edge reads 0)
      if (a === STONE_A) { stones++; if (shore.distanceAt(i, j) < STEP / 2) dryStones++; }
    }
    expect(stones).toBeGreaterThan(0);
    expect(dryStones).toBe(stones);
    // between the stones the ford reads FORD_A across its cells' centre row; open water reads 0
    let between = 0;
    for (let i = texel(8.5); i < texel(15.5); i++) {
      const a = shore.data[(texel(12.5) * n + i) * 4 + 3]!;
      if (a !== Math.round(STONE_A * 255)) { expect(a).toBeGreaterThan(FORD_A * 255 * 0.9); between++; }
    }
    expect(between).toBeGreaterThan(0);
    expect(shore.data[(texel(5.5) * n + texel(10.5)) * 4 + 3]).toBe(0);
  });

  it('flows along a river, and drifts with the breeze on a round lake', () => {
    const river = new ShoreField(SIZE, [0.6, 0.8]);
    river.build(source((_x, y) => 2 - Math.abs(y - 12)));
    const n = river.n;
    const flow = (s: ShoreField, i: number, j: number) => [s.data[(j * n + i) * 4 + 1]! / 127.5 - 1, s.data[(j * n + i) * 4 + 2]! / 127.5 - 1] as const;
    for (const y of [10.4, 11.5, 12.6, 13.6]) {
      const [fx, fy] = flow(river, texel(9), texel(y));
      expect(Math.abs(fx)).toBeGreaterThan(0.9);
      expect(Math.abs(fy)).toBeLessThan(0.15);
      // one way along the whole river, both banks
      expect(Math.sign(fx)).toBe(Math.sign(flow(river, texel(9), texel(11))[0]));
    }
    const lake = new ShoreField(SIZE, [0.6, 0.8]);
    lake.build(source((x, y) => 4 - Math.hypot(x - 12, y - 12)));
    const [lx, ly] = flow(lake, texel(12), texel(10));
    expect(lx).toBeCloseTo(0.6, 1);
    expect(ly).toBeCloseTo(0.8, 1);
  });
});
