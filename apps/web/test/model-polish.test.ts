import { describe, expect, it } from 'vitest';
import { DAMAGE, damageRates, type DamageRates } from '../src/world/damage-fx.ts';
import { ARRIVAL, CONSTRUCTION_BASE, TREAD, arrivalScale, constructionRecord, treadPhase } from '../src/world/rig.ts';
import { ROCK_STRETCH, rockStretch } from '../src/world/asteroid.ts';
import { model, spireGem } from '../src/world/models.ts';
import { GRASS, PEBBLES, SCATTER, groundDetailCounts } from '../src/world/ground-detail.ts';
import { SURFACE, surfaceFeature } from '@agent-command/game/contract';

const rates = (): DamageRates => ({ smoke: 0, sparks: 0, fire: 0 });

describe('damaged look', () => {
  it('starts each effect at its threshold and grows as health falls', () => {
    const r = rates();
    damageRates(DAMAGE.smoke.below, true, 'surface', r);
    expect(r).toEqual({ smoke: 0, sparks: 0, fire: 0 });
    damageRates(0.4, false, 'surface', r);
    expect(r.smoke).toBeGreaterThan(0);
    expect(r.sparks).toBe(0);
    expect(r.fire).toBe(0);
    damageRates(0.2, false, 'surface', r);
    expect(r.sparks).toBeGreaterThan(0);
    const smokeAt20 = r.smoke;
    damageRates(0.05, false, 'surface', r);
    expect(r.smoke).toBeGreaterThan(smokeAt20);
    damageRates(0, false, 'surface', r);
    expect(r.smoke).toBe(DAMAGE.smoke.rate);
    expect(r.sparks).toBe(DAMAGE.sparks.rate);
  });

  it('burns only structures, and Orbit hulls only spark', () => {
    const r = rates();
    damageRates(0.3, false, 'depths', r);
    expect(r.fire).toBe(0);
    damageRates(0.3, true, 'depths', r);
    expect(r.fire).toBeGreaterThan(0);
    damageRates(0.1, true, 'orbit', r);
    expect(r.smoke).toBe(0);
    expect(r.fire).toBe(0);
    expect(r.sparks).toBeGreaterThan(0);
  });
});

describe('arrival grow-in', () => {
  it('eases from its start size to full over the window, monotonically', () => {
    expect(arrivalScale(0)).toBeCloseTo(ARRIVAL.from, 6);
    expect(arrivalScale(-0.1)).toBeCloseTo(ARRIVAL.from, 6);
    expect(arrivalScale(ARRIVAL.seconds)).toBe(1);
    expect(arrivalScale(Infinity)).toBe(1);
    expect(arrivalScale(NaN)).toBe(1);
    let last = 0;
    for (let t = 0; t <= ARRIVAL.seconds; t += ARRIVAL.seconds / 20) {
      const k = arrivalScale(t);
      expect(k).toBeGreaterThanOrEqual(last);
      last = k;
    }
    // ease-out: more than half grown by the midpoint
    expect(arrivalScale(ARRIVAL.seconds / 2)).toBeGreaterThan(ARRIVAL.from + (1 - ARRIVAL.from) / 2);
  });
});

describe('tread scroll', () => {
  it('holds a ground-contact cleat still in the world as the hull rolls on', () => {
    // a cleat at model x on the ground: after travelling d model units the same world point sits at x − d
    for (const d of [0.01, 0.13, 0.5, 3]) expect(treadPhase(0.2 - d, 1.7 + d)).toBeCloseTo(treadPhase(0.2, 1.7), 9);
    // and the pattern advances by `cleats` per model unit travelled at a fixed point on the pod
    expect(treadPhase(0, 1) - treadPhase(0, 0)).toBeCloseTo(TREAD.cleats, 9);
  });
});

describe('construction cut line', () => {
  it('encodes a site past the squash range and clamps its progress', () => {
    expect(constructionRecord(0)).toBe(CONSTRUCTION_BASE);
    expect(constructionRecord(0.35)).toBeCloseTo(CONSTRUCTION_BASE + 0.35, 9);
    expect(constructionRecord(2)).toBe(CONSTRUCTION_BASE + 1);
    expect(constructionRecord(-1)).toBe(CONSTRUCTION_BASE);
    // every record of a site is above any death squash (≤ 1), so the shader can tell them apart at 1.5
    expect(constructionRecord(0)).toBeGreaterThan(1.5);
  });
});

describe('asteroid variety', () => {
  it('stretches each rock by its own phase, within the stated amplitudes', () => {
    const a = rockStretch(0.3, { x: 0, y: 0, z: 0 });
    const b = rockStretch(2.1, { x: 0, y: 0, z: 0 });
    expect([a.x, a.y, a.z]).not.toEqual([b.x, b.y, b.z]);
    for (let phase = 0; phase < Math.PI * 2; phase += 0.1) {
      const s = rockStretch(phase, { x: 0, y: 0, z: 0 });
      expect(Math.abs(s.x - 1)).toBeLessThanOrEqual(ROCK_STRETCH.x.amp + 1e-9);
      expect(Math.abs(s.y - 1)).toBeLessThanOrEqual(ROCK_STRETCH.y.amp + 1e-9);
      expect(Math.abs(s.z - 1)).toBeLessThanOrEqual(ROCK_STRETCH.z.amp + 1e-9);
    }
  });
});

describe('model kit', () => {
  it('cuts the Spire with many facets, each with one id', () => {
    const g = spireGem();
    const facet = g.getAttribute('facet');
    const ids = new Set<number>();
    for (let i = 0; i < facet.count; i += 3) {
      expect(facet.getX(i + 1)).toBe(facet.getX(i));
      expect(facet.getX(i + 2)).toBe(facet.getX(i));
      ids.add(facet.getX(i));
    }
    expect(ids.size).toBeGreaterThanOrEqual(48);
  });

  const tris = (kind: Parameters<typeof model>[0]): number => model(kind).getAttribute('position').count / 3;
  it('keeps the audit\'s over-budget models within the art guide\'s triangle tiers', () => {
    // DIRECTIONS.md: armored ≤ 260, structure ≤ 320 (its foundation included)
    for (const kind of ['gunship', 'bastion', 'tug'] as const) expect(tris(kind), kind).toBeLessThanOrEqual(260);
    for (const kind of ['mooring_tower', 'storm_seeder', 'gun_platform', 'shaft', 'headframe', 'stormcatcher'] as const) expect(tris(kind), kind).toBeLessThanOrEqual(320);
  });
});

describe('ground detail placement', () => {
  const size = 16;
  const map = (): Uint8Array => {
    const codes = new Uint8Array(size * size).fill(SURFACE.ground);
    for (let y = 0; y < size; y++) for (let x = 8; x < size; x++) codes[y * size + x] = SURFACE.forest;
    codes[3 * size + 3] = SURFACE.cliff;
    codes[4 * size + 2] = SURFACE.ford;
    return codes;
  };
  const counts = (codes: Uint8Array, seed: number, blocked = new Uint8Array(size * size)) => {
    const grass = new Uint8Array(size * size), pebbles = new Uint8Array(size * size);
    groundDetailCounts(codes, size, seed, blocked, grass, pebbles);
    return { grass, pebbles };
  };

  it('is deterministic per map seed and cell, and differs between seeds', () => {
    const codes = map();
    expect(counts(codes, 5)).toEqual(counts(codes, 5));
    expect(counts(codes, 5).grass).not.toEqual(counts(codes, 6).grass);
  });

  it('keeps off forest, cliffs, fords and blocked cells, and thickens at forest edges', () => {
    const codes = map();
    const blocked = new Uint8Array(size * size);
    blocked[10 * size + 1] = 1;
    let edge = 0, inner = 0;
    for (let seed = 0; seed < 40; seed++) {
      const { grass, pebbles } = counts(codes, seed, blocked);
      for (let i = 0; i < codes.length; i++) if (surfaceFeature(codes[i]!) !== SURFACE.ground || blocked[i]) {
        expect(grass[i]).toBe(0);
        expect(pebbles[i]).toBe(0);
      }
      for (let y = 0; y < size; y++) { edge += grass[y * size + 7]!; inner += grass[y * size + 1]!; }
      expect(Math.max(...grass)).toBeLessThanOrEqual(GRASS.max);
      expect(Math.max(...pebbles)).toBeLessThanOrEqual(PEBBLES.max);
    }
    expect(edge).toBeGreaterThan(inner);
  });

  it('masks coverage into bare stretches and dense clumps rather than a flat density', () => {
    const open = 64;
    const codes = new Uint8Array(open * open).fill(SURFACE.ground);
    const grass = new Uint8Array(open * open), pebbles = new Uint8Array(open * open);
    groundDetailCounts(codes, open, 12345, new Uint8Array(open * open), grass, pebbles);
    // 8×8-cell blocks: some all but bare, some thick (a flat density puts every block near the same mean)
    const means: number[] = [];
    for (let by = 0; by < open; by += 8) for (let bx = 0; bx < open; bx += 8) {
      let sum = 0;
      for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) sum += grass[y * open + x]!;
      means.push(sum / 64);
    }
    expect(Math.min(...means)).toBeLessThan(0.15);
    expect(Math.max(...means)).toBeGreaterThan(1.2);
    expect(Math.max(...grass)).toBeGreaterThanOrEqual(2);
  });

  it('lays pebbles from their own mask, gathered where the grass is thin', () => {
    const open = 64;
    const codes = new Uint8Array(open * open).fill(SURFACE.ground);
    let onBare = 0, bareCells = 0, onGrass = 0, grassCells = 0;
    for (let seed = 0; seed < 10; seed++) {
      const grass = new Uint8Array(open * open), pebbles = new Uint8Array(open * open);
      groundDetailCounts(codes, open, seed * 7919, new Uint8Array(open * open), grass, pebbles);
      for (let i = 0; i < grass.length; i++) {
        if (grass[i]) { onGrass += pebbles[i]!; grassCells++; } else { onBare += pebbles[i]!; bareCells++; }
      }
    }
    expect(onBare / bareCells).toBeGreaterThan((2 * onGrass) / grassCells);
    expect(SCATTER.grass.salt).not.toBe(SCATTER.pebbles.salt);
  });
});
