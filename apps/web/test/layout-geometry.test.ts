import { describe, expect, it } from 'vitest';
import { contains, layoutErrors, overlaps, type Box } from '../scripts/layout-geometry.ts';

const box = (name: string, left = 10, top = 10, right = 100, bottom = 100): Box => ({ name, left, top, right, bottom });

describe('headless HUD layout assertions', () => {
  it('allows shared edges and subpixel rounding, not visible overlap', () => {
    expect(overlaps(box('a'), box('b', 100))).toBe(false);
    expect(overlaps(box('a'), box('b', 99.75))).toBe(false);
    expect(overlaps(box('a'), box('b', 99))).toBe(true);
    expect(overlaps(box('a'), box('b', 10, 101))).toBe(false);
  });
  it('detects containment as overlap, including the original rail/card regression', () => {
    expect(overlaps(box('rail', 10, 250, 236, 540), box('card', 10, 420, 774, 600))).toBe(true);
    expect(overlaps(box('outer'), box('inner', 20, 20, 30, 30))).toBe(true);
  });
  it('checks every viewport edge without requiring matching origins', () => {
    expect(contains(box('outer'), box('inner', 20, 20, 30, 30))).toBe(true);
    for (const outside of [box('left', 9), box('top', 10, 9), box('right', 10, 10, 101), box('bottom', 10, 10, 100, 101)]) {
      expect(contains(box('outer'), outside)).toBe(false);
    }
  });
  it('reports clipping, empty panels and every overlapping pair', () => {
    expect(layoutErrors([box('a'), box('b', 90), box('outside', -5, 120, 20, 140), box('empty', 150, 150, 150, 160)], 200, 200))
      .toEqual(['a overlaps b', 'outside: outside viewport', 'empty: empty panel']);
    expect(layoutErrors([box('a'), box('b', 110, 10, 190, 100)], 200, 200)).toEqual([]);
  });
});
