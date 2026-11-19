/** Static asteroid placement, not orbital physics: weighted rectangles and approach vectors. */
import type { TerrainPreset } from '../rules/vocabulary.ts';
import type { MapRules } from '../rules/match-rules.ts';
import { REFERENCE_MAP_SIZE, type OrbitRegion } from './types.ts';

export function generateOrbitRegions(preset: TerrainPreset, map: MapRules, sides: 2 | 4): OrbitRegion[] {
  const size = map.size, scale = size / REFERENCE_MAP_SIZE, p = map.template;
  const sectorWidth = sides === 2 ? size : size / 2;
  const y = size / 4;
  const quarter = sectorWidth / 4;
  const canonical: OrbitRegion[] = [];
  const add = (x: number, width: number, height: number, weight: number, dx: number, dy: number): void => {
    canonical.push({ x, y, width: Math.min(width * scale, 2 * x, 2 * (size - x)), height: Math.min(height * scale, size / 2), dx, dy, weight, spread: p.orbitSpread });
  };
  if (preset === 'open') {
    add(quarter * 2, p.orbitLength, p.orbitWidth, p.orbitCentreWeight, 0, 1);
  } else if (preset === 'ridges') {
    add(quarter, p.orbitWidth, p.orbitLength, p.orbitHomeWeight, Math.SQRT1_2, Math.SQRT1_2);
    add(quarter * 3, p.orbitLength, p.passWidth, p.orbitFlankWeight, -Math.SQRT1_2, Math.SQRT1_2);
  } else if (preset === 'canyons') {
    add(quarter, p.passWidth, p.orbitLength, p.orbitHomeWeight, Math.SQRT1_2, Math.SQRT1_2);
    add(quarter * 3, p.passWidth, p.orbitLength, p.orbitFlankWeight, Math.SQRT1_2, Math.SQRT1_2);
  } else if (preset === 'chokepoint') {
    add(quarter, p.passWidth, p.orbitLength, p.orbitCentreWeight, Math.SQRT1_2, Math.SQRT1_2);
    add(quarter * 3, p.flankWidth, p.orbitLength, p.orbitFlankWeight, -Math.SQRT1_2, Math.SQRT1_2);
  } else if (preset === 'archipelago') {
    add(quarter, Math.min(p.orbitWidth, p.lakeRadius * 2), p.lakeSpacing, p.orbitHomeWeight, Math.SQRT1_2, Math.SQRT1_2);
    add(quarter * 2, Math.min(p.orbitWidth, p.lakeRadius * 2), p.lakeSpacing, p.orbitCentreWeight, 0, 1);
    add(quarter * 3, Math.min(p.orbitWidth, p.lakeRadius * 2), p.lakeSpacing, p.orbitFlankWeight, -Math.SQRT1_2, Math.SQRT1_2);
  } else if (preset === 'fortress') {
    add(quarter * 3, Math.min(p.orbitWidth, p.plateauRadius), p.orbitLength, p.orbitFlankWeight, -Math.SQRT1_2, Math.SQRT1_2);
    add(quarter * 2, p.orbitWidth, p.orbitLength, p.orbitCentreWeight, 0, 1);
  } else if (preset === 'rivers') {
    add(quarter * 3, p.passWidth, p.orbitLength, p.orbitFlankWeight, -Math.SQRT1_2, Math.SQRT1_2);
  } else {
    add(quarter, p.highlandWidth, p.orbitLength, p.orbitHomeWeight, Math.SQRT1_2, Math.SQRT1_2);
    add(quarter * 3, p.highlandWidth, p.orbitLength, p.orbitFlankWeight, -Math.SQRT1_2, Math.SQRT1_2);
  }
  const regions: OrbitRegion[] = [];
  for (const region of canonical) for (let r = 0; r < sides; r++) {
    let { x, y: cy, width, height, dx, dy } = region;
    for (let turn = 0; turn < r * 4 / sides; turn++) {
      [x, cy] = [size - cy, x];
      [dx, dy] = [-dy, dx];
      [width, height] = [height, width];
    }
    regions.push({ ...region, x, y: cy, width, height, dx, dy });
  }
  return regions;
}
