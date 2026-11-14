import { describe, expect, it } from 'vitest';
import { minimapPoint } from '../src/minimap.ts';

describe('responsive field map pointer coordinates', () => {
  it('preserves logical coordinates through scaling and page translation', () => {
    const base = { left: 0, top: 0, width: 212, height: 297 };
    for (const scale of [0.5, 0.75, 1, 1.5]) {
      const rect = { left: 782, top: 350, width: base.width * scale, height: base.height * scale };
      for (const [x, y] of [[0, 0], [106, 36], [106, 98], [106, 160], [106, 222], [212, 297]]) {
        const expected = minimapPoint(x!, y!, base);
        const actual = minimapPoint(rect.left + x! * scale, rect.top + y! * scale, rect);
        expect(actual.sx).toBeCloseTo(expected.sx, 8);
        expect(actual.sy).toBeCloseTo(expected.sy, 8);
      }
    }
  });
  it('maps the visible top-left exactly to the drawing origin', () => {
    expect(minimapPoint(400, 320, { left: 400, top: 320, width: 100, height: 140 })).toEqual({ sx: 0, sy: 0 });
  });
  it('keeps outside coordinates outside for the existing diamond hit test to reject', () => {
    const point = minimapPoint(9, 19, { left: 10, top: 20, width: 100, height: 140 });
    expect(point.sx).toBeLessThan(0);
    expect(point.sy).toBeLessThan(0);
  });
});
