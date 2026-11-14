/** Route-first terrain templates. All geometric controls are resolved match rules, in S48 tiles. */
import { SURFACE, spirePositions } from '../rules/terrain.ts';
import type { TerrainPreset } from '../rules/vocabulary.ts';
import { rotCell, rotX, rotY } from '../util/teams.ts';
import { Rng } from '../util/rng.ts';
import type { MapRules } from '../rules/match-rules.ts';
import { REFERENCE_MAP_SIZE } from './types.ts';
import { norm } from '../util/math.ts';

/** Random stream salt of the template stage, xored into the terrain seed ("TEMP"). */
const TEMPLATE_SALT = 0x54454d50;

const TEMPLATE_PRESETS = ['chokepoint', 'archipelago', 'fortress', 'rivers', 'highlands'] as const;
type TemplatePreset = (typeof TEMPLATE_PRESETS)[number];
export const isTemplatePreset = (preset: TerrainPreset): preset is TemplatePreset => (TEMPLATE_PRESETS as readonly string[]).includes(preset);

/**
 * Spire centres of a map's slots in slot order: slot s stands at slot 0's centre turned s · 4/sides quarter turns
 * (on two-slot maps slot 1 is the point mirror). Quarter turns only swap and negate, so every centre is exact.
 */
export function slotSpires(map: MapRules, sides: 2 | 4): { x: number; y: number }[] {
  const home = spirePositions(map.spireInset, map.size).nw;
  return Array.from({ length: sides }, (_, s) => ({ x: rotX((s * 4) / sides, home.x, home.y, map.size), y: rotY((s * 4) / sides, home.x, home.y, map.size) }));
}

/**
 * A canonical sector (the top half on two-slot maps, the top-left quadrant on four-slot maps) is painted, then rotated
 * through the slots' rotation group: no floating-point evaluation of another sector.
 *
 * (u, v) are the template's lane coordinates: u along the line between a slot and its opponent, v across it (u = 0
 * is the boundary between them). Two slots share the anti-diagonal. On four slots the chokepoint wall and the rivers
 * lie against every neighbour boundary: each half of the quadrant takes the axis it borders as u = 0. The fortress
 * (ramps and terraces facing the bases) and the highland ridges (lanes from each base to the centre) keep the diagonal
 * coordinates, so a slot's quadrant matches the two-slot half around its base; the archipelago lattice uses map
 * coordinates.
 */
export function templateTerrain(seed: number, preset: TemplatePreset, map: MapRules, sides: 2 | 4): Uint8Array {
  const size = map.size;
  const scale = size / REFERENCE_MAP_SIZE;
  const p = map.template;
  const rng = new Rng(seed ^ TEMPLATE_SALT);
  const jitter = (rng.next() * 2 - 1) * p.jitter * scale;
  const terrain = new Uint8Array(size * size);
  const starts = slotSpires(map, sides);
  const centre = size / 2;
  const pass = p.passWidth * scale / 2;
  const ramp = p.rampWidth * scale / 2;
  const lakeSpacing = p.lakeSpacing * scale;
  const lakeRadius = p.lakeRadius * scale;
  const river = p.riverWidth * scale / 2;
  const plateau = p.plateauRadius * scale;
  const thickness = p.barrierThickness * scale;
  const step = 4 / sides;
  const axes = sides === 4 && (preset === 'chokepoint' || preset === 'rivers');
  for (let y = 0; y < size / 2; y++) for (let x = 0; x < (sides === 2 ? size : size / 2); x++) {
    const dx = x + 0.5 - centre;
    const dy = y + 0.5 - centre;
    const u = axes ? (Math.abs(dx) <= Math.abs(dy) ? dx : dy) : (dx + dy) / Math.SQRT2;
    const v = axes ? (Math.abs(dx) <= Math.abs(dy) ? dy : dx) : (dx - dy) / Math.SQRT2;
    let code: number = SURFACE.ground;
    if (preset === 'chokepoint') {
      // The short centre pass and long edge flanks connect the same two approach zones.
      if (Math.abs(u) < thickness / 2 && Math.abs(v) > pass && Math.abs(v) < centre - p.flankWidth * scale) code = SURFACE.cliff;
      else if (Math.abs(u) < thickness && Math.abs(v) <= pass) code = SURFACE.ford;
      else if (Math.abs(u) > thickness && Math.abs(u) < plateau && Math.abs(v) < plateau) code = SURFACE.high;
    } else if (preset === 'archipelago') {
      const lx = ((x + 0.5 + jitter) % lakeSpacing) - lakeSpacing / 2;
      const ly = ((y + 0.5 - jitter) % lakeSpacing) - lakeSpacing / 2;
      if (norm(lx, ly) < lakeRadius) code = Math.abs(lx) < pass || Math.abs(ly) < pass ? SURFACE.ford : SURFACE.water;
      else if (Math.abs(lx) > lakeRadius && Math.abs(ly) > lakeRadius) code = SURFACE.forest;
    } else if (preset === 'fortress') {
      const r = norm(u, v);
      if (r < plateau) code = SURFACE.high;
      else if (r < plateau + thickness) code = Math.abs(u) <= ramp || Math.abs(v) <= ramp ? SURFACE.high : SURFACE.cliff;
      // Smaller forward terraces make the route to the fortress consequential too.
      else if (Math.abs(u) > plateau + thickness && Math.abs(u) < plateau * 2 && Math.abs(v) < plateau / 2) code = SURFACE.high;
    } else if (preset === 'rivers') {
      if (Math.abs(u) < river) {
        const crossing = Math.abs(v - Math.round(v / (p.fordSpacing * scale)) * p.fordSpacing * scale) <= pass;
        code = crossing ? SURFACE.ford : SURFACE.water;
      } else if (Math.abs(u) < river + thickness && Math.abs(v) > plateau) code = SURFACE.forest;
    } else {
      const band = p.highlandWidth * scale;
      const ridge = Math.abs(v - Math.round(v / lakeSpacing) * lakeSpacing);
      if (ridge < band / 2) code = SURFACE.high;
      else if (ridge < band / 2 + thickness) {
        const crossing = Math.abs(u - Math.round(u / (p.fordSpacing * scale)) * p.fordSpacing * scale) <= ramp;
        code = crossing ? SURFACE.high : SURFACE.cliff;
      } else if (Math.abs(u) > plateau && ridge > (band / 2 + thickness + lakeSpacing / 2) / 2) code = SURFACE.forest; // valley floors
    }
    // Start clearings are footprint/apron constraints, independent of terrain recipe decoration.
    let home = Infinity;
    for (const start of starts) home = Math.min(home, norm(x + 0.5 - start.x, y + 0.5 - start.y));
    if (home <= map.homeLodeMinRadius) code = SURFACE.ground;
    const c = y * size + x;
    for (let r = 0; r < sides; r++) terrain[rotCell(r * step, c, size)] = code;
  }
  return terrain;
}
