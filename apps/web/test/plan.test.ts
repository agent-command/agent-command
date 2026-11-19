import { describe, expect, it } from 'vitest';
import { ECON, TICK_RATE, sunAngleAt, sunHalfWidth, sunOffset, sunSpeedOf } from '@agent-command/game/contract';
import { sunEdgeIn } from '../src/world/plan.ts';

/** Two-team rules: two lit wedges. */
const WEDGES = 2;
const HALF = sunHalfWidth(WEDGES);
const SPEED = sunSpeedOf(ECON.sunPeriodTicks, WEDGES);

describe('sun dawn/dusk countdown', () => {
  /** Brute force: step the real wedge angle until the point changes state. */
  function brute(x: number, y: number, tick0: number): number {
    const lit0 = Math.abs(sunOffset(x, y, sunAngleAt(tick0, SPEED), 48, WEDGES)) < HALF;
    for (let t = 1; t < 400 * TICK_RATE; t++) if (Math.abs(sunOffset(x, y, sunAngleAt(tick0 + t, SPEED), 48, WEDGES)) < HALF !== lit0) return t / TICK_RATE;
    return Infinity;
  }

  it('matches the sim rule for lit and dark points, both directions', () => {
    for (const [x, y, tick] of [
      [8, 8, 0],
      [8, 8, 1300],
      [40, 12, 200],
      [30, 45, 2600],
      [3, 24, 777],
    ] as const) {
      const o = sunOffset(x, y, sunAngleAt(tick, SPEED), 48, WEDGES);
      const lit = Math.abs(o) < HALF;
      expect(sunEdgeIn(o, HALF, SPEED, !lit)).toBeCloseTo(brute(x, y, tick), 0);
      // reversed rotation mirrors the offset
      expect(sunEdgeIn(-o, HALF, -SPEED, !lit)).toBeCloseTo(sunEdgeIn(o, HALF, SPEED, !lit), 6);
    }
  });

  it('never ends for a still sun', () => {
    expect(sunEdgeIn(0.1, HALF, 0, true)).toBe(Infinity);
  });
});
