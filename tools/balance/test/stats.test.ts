import { describe, expect, it } from 'vitest';
import { binomialTwoSided, chiSquareSurvival, histogram, mean, quantile, uniformFit, wilson } from '../src/stats.ts';

describe('stats', () => {
  it('wilson interval matches reference values and handles the edges', () => {
    const w = wilson(8, 10);
    expect(w.p).toBe(0.8);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 1 });
  });

  it('exact two-sided binomial test', () => {
    expect(binomialTwoSided(10, 20)).toBeCloseTo(1, 10);
    // 15 of 20: P = 2 × P(X ≥ 15) = 0.04139
    expect(binomialTwoSided(15, 20)).toBeCloseTo(0.04139, 4);
    expect(binomialTwoSided(5, 20)).toBeCloseTo(binomialTwoSided(15, 20), 12);
    expect(binomialTwoSided(0, 0)).toBe(1);
    // large n stays finite (no factorial overflow)
    expect(binomialTwoSided(600, 1000)).toBeLessThan(1e-9);
    expect(binomialTwoSided(500, 1000)).toBeCloseTo(1, 6);
  });

  it('two slots reduce exactly to the two-sided binomial test at 0.5', () => {
    for (const [a, b] of [[0, 0], [3, 1], [1, 3], [15, 5], [17, 7], [19, 5], [12, 12], [600, 400]] as const) {
      expect(uniformFit([a, b])).toBe(binomialTwoSided(a, a + b, 0.5));
    }
  });

  it('exact multinomial goodness of fit against equal slot shares', () => {
    expect(uniformFit([0, 0, 0, 0])).toBe(1);
    expect(uniformFit([5])).toBe(1);
    // Equal counts are the most likely outcome: every outcome is no more likely, p = 1.
    expect(uniformFit([3, 3, 3, 3])).toBeCloseTo(1, 12);
    // n = 4 over 4 slots: P(all four in one slot) = 4 × 4^-4 = 1/64, the least likely outcome class.
    expect(uniformFit([4, 0, 0, 0])).toBeCloseTo(1 / 64, 12);
    // n = 3 over 3 slots: outcomes (3,0,0)×3 at 1/27 each, (2,1,0)×6 at 3/27, (1,1,1) at 6/27.
    expect(uniformFit([2, 1, 0])).toBeCloseTo((3 * 1 + 6 * 3) / 27, 12);
    expect(uniformFit([1, 1, 1])).toBeCloseTo(1, 12);
    // Slot labels do not matter.
    expect(uniformFit([9, 2, 4, 1])).toBeCloseTo(uniformFit([1, 4, 2, 9]), 12);
    // A strong first-slot edge over 40 decisive four-army matches is detected; a mild one is not.
    expect(uniformFit([22, 6, 6, 6])).toBeLessThan(0.002);
    expect(uniformFit([13, 9, 9, 9])).toBeGreaterThan(0.5);
  });

  it('large samples fall back to the χ² approximation, which agrees with the exact test', () => {
    // χ²(3) survival reference values: P(X ≥ 7.815) = 0.05, P(X ≥ 11.345) = 0.01; χ²(1) at 3.841 = 0.05.
    expect(chiSquareSurvival(7.814728, 3)).toBeCloseTo(0.05, 6);
    expect(chiSquareSurvival(11.34487, 3)).toBeCloseTo(0.01, 6);
    expect(chiSquareSurvival(3.841459, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquareSurvival(0, 3)).toBe(1);
    // 400 decisive matches over four slots exceed the exact enumeration bound.
    const big = uniformFit([115, 95, 95, 95]);
    expect(big).toBeCloseTo(chiSquareSurvival((15 ** 2 + 3 * 5 ** 2) / 100, 3), 12);
    // Moderate n where both apply: within a few percent of the exact multinomial p.
    expect(chiSquareSurvival([30, 20, 25, 25].reduce((s, c) => s + (c - 25) ** 2 / 25, 0), 3)).toBeCloseTo(uniformFit([30, 20, 25, 25]), 1);
  });

  it('quantiles interpolate; histogram buckets are half-open with an open last bucket', () => {
    expect(quantile([3, 1, 2, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
    expect(mean([1, 2, 3])).toBe(2);
    expect(histogram([0, 4.9, 5, 12, 30, 31], [0, 5, 10, 30])).toEqual([2, 1, 1, 2]);
  });
});
