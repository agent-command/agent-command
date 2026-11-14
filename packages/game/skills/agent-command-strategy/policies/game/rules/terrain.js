// Agent Command's built-in bot library: packages/game/src/rules/terrain.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * Map geometry and cell grids: Spire placement, depths cell codes and the dig frontier, crack stages, surface
 * terrain codes and their packing, surface holes and the vision/designation bitset word size.
 */
import { frameDir, rotX, rotY } from '../util/teams.js';
import { ARMIES, } from './vocabulary.js';

/**
 * Spire centres for `rules.map.spireInset`: the cells from both edges of a corner to the 3×3 footprint's centre cell.
 * nw stands at (inset + 0.5, inset + 0.5) with integer min corner inset − 1; the corner of frame k is its k quarter
 * turns (se = size − inset − 0.5 on both axes). A two-slot map uses nw and se.
 */
export function spirePositions(inset, size) {
  const c = inset + 0.5;
  const out = {};
  ARMIES.forEach((id, k) => { out[id] = Object.freeze({ x: rotX(k, c, c, size), y: rotY(k, c, c, size) }); });
  return Object.freeze(out);
}
/**
 * `map.spireInset` bounds. The low end keeps the footprint, its one-cell apron and the home tunnel pocket inside the
 * bedrock border; the high end keeps the home lode band, base clearing and cavern on each team's own half.
 */
export const SPIRE_INSET_MIN = 3;
export const SPIRE_INSET_MAX = 12;
/**
 * Anchor of the `flanks` lode zone in S48 template tiles (nw's sector of a two-slot map; scaled by size / 48 and turned
 * onto every slot, so (8.5, 39.5) on S48): the Spire-free corners' inner points.
 */
export const FLANK_ANCHOR = { x: 39.5, y: 8.5 };

/**
 * Depths cell codes (team knowledge). Tunnels, rails and lava bridges are walkable (rails ×2.5, tunnels and bridges ×1.5
 * speed). `magma`: flowing magma from a flood (impassable, burns, cools back to tunnel), or a hidden magma pocket your
 * team has located with an orbital scan. `lode`: a Mother Lode cell (rules.map.motherLode places them): solid, never
 * dug, mined from beside it. `bridge`: a lava bridge diggers built over a lake cell (a destructible `lava_bridge`
 * structure; lake again once destroyed). `rich`: green rich ore (rules.map.richOre), mined like ore for richer loads.
 * `lake`: a permanent lava lake (rules.map.lavaLakes): burns like a flood but never cools, and diggers bridge it.
 */
export const CELL = { unknown: 0, bedrock: 1, rock: 2, ore: 3, tunnel: 4, fortified: 5, rail: 6, magma: 7, lode: 8, bridge: 9, rich: 10, lake: 11 };
/** Most Mother Lode cells on any map (rules.map.motherLode.cells, map documents). */
export const MOTHER_LODE_MAX_CELLS = 8;
/** Mother Lode pressure scale: it vents on reaching this (rules.depths.lodeWarn and lodeCritical sit on the same scale). */
export const LODE_PRESSURE_MAX = 100;
/** Public Mother Lode states (observation `motherLode.state`): pressure below lodeWarn, from it, from lodeCritical, and the post-vent cooling. */
export const LODE_STATES = ['calm', 'warn', 'critical', 'cooling'];
/** Walkable depths cell (tunnel, rail or lava bridge). */
export const isOpenCell = (code) => code === CELL.tunnel || code === CELL.rail || code === CELL.bridge;
/** Solid depths cell that digging damages (rock, ore, green rich ore, fortified rock). */
export const isDiggable = (code) => code === CELL.rock || code === CELL.ore || code === CELL.rich || code === CELL.fortified;
/** Minable ore cell: ordinary or green rich ore (the Mother Lode is separate). */
export const isOreCell = (code) => code === CELL.ore || code === CELL.rich;
/** Burning depths cell: flood magma or a lava lake (a located pocket shares the magma code; see `pocketKnown`). */
export const isLava = (code) => code === CELL.magma || code === CELL.lake;
/**
 * May a digger bridge (`bridge`) lava-lake cell `c` of a `size`-wide grid, as `cells` shows it (the sim's truth, or a
 * team's knowledge): still a lake, with an open cell beside it or a straight run of fewer than `span`
 * (rules.depths.lavaBridgeSpan) bridge cells back to one, so a span reaches at most `span` cells from dry ground.
 * Flood magma is never bridged.
 */
export function lavaBridgeable(cells, c, size, span) {
  if (cells[c] !== CELL.lake) return false;
  const x = c % size, y = (c - x) / size;
  for (let k = 0; k < 4; k++) {
    const dx = k === 0 ? 1 : k === 1 ? -1 : 0, dy = k === 2 ? 1 : k === 3 ? -1 : 0;
    for (let s = 1; s <= span; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) break;
      const code = cells[ny * size + nx];
      if (code === CELL.bridge) continue;
      if (isOpenCell(code)) return true;
      break;
    }
  }
  return false;
}

/**
 * Known-terrain dig frontier: the tag itself, one diagonal connector, or -1. A connector may only bridge a
 * corner to known open ground; this never authorizes tunnelling farther through an untagged wall. Both the
 * scheduler and plan ink use this helper so unknown/unreachable work remains a visible plan, not hidden truth.
 * Connector ties break in the neighbour order of `frame` (the designating army's quarter turns).
 */
export function designationFrontier(cells, tags, cell, frame, blocked, size) {
  const code = cells[cell];
  if (code !== CELL.unknown && !isDiggable(code)) return -1;
  const x = cell % size;
  for (let k = 0; k < 4; k++) {
    const n = k === 0 ? (x < size - 1 ? cell + 1 : -1) : k === 1 ? (x > 0 ? cell - 1 : -1) : k === 2 ? cell + size : cell - size;
    if (n >= 0 && n < size * size && isOpenCell(cells[n]) && !blocked?.[n]) return cell;
  }
  let best = -1, score = Infinity;
  for (let k = 0; k < 4; k++) {
    const kk = frameDir(frame, k);
    const n = kk === 0 ? (x < size - 1 ? cell + 1 : -1) : kk === 1 ? (x > 0 ? cell - 1 : -1) : kk === 2 ? cell + size : cell - size;
    if (n < 0 || n >= size * size || blocked?.[n]) continue;
    const kind = cells[n];
    if (kind !== CELL.unknown && !isDiggable(kind)) continue;
    // Only the perpendicular neighbours are diagonal to the tag (not a two-cell straight extension).
    const a = kk < 2 ? n - size : x > 0 ? n - 1 : -1;
    const b = kk < 2 ? n + size : x < size - 1 ? n + 1 : -1;
    if (!(a >= 0 && a < size * size && isOpenCell(cells[a]) && !blocked?.[a]) &&
        !(b >= 0 && b < size * size && isOpenCell(cells[b]) && !blocked?.[b])) continue;
    const rank = (tags[n] ? 0 : 4) + (isOreCell(kind) ? 1 : kind === CELL.fortified ? 2 : 0);
    if (rank < score) { score = rank; best = n; }
  }
  return best;
}

/**
 * Dig damage shows as crack stages 1..CRACK_STAGES (fixed, like observation list sizes): stage = ceil(stages × damage
 * / toughness) while the cell is damaged and still solid. Damage belongs to the cell, so it stays when diggers leave.
 */
export const CRACK_STAGES = 4;
/** Crack stage of a solid cell with `work` dig ticks done out of `need`. */
export const crackStage = (work, need) => (work <= 0 ? 0 : Math.min(CRACK_STAGES, Math.max(1, Math.ceil((CRACK_STAGES * work) / need))));

/**
 * Canonical static surface codes (row-major y*size+x). Features retain an explicit low/high base:
 * 3 is bare high ground; bit 8 raises forest, ford, fault or water. Cliffs remain blocking wall geometry.
 */
export const SURFACE = { ground: 0, cliff: 1, forest: 2, high: 3, ford: 4, fault: 5, water: 6,
  highForest: 10, highFord: 12, highFault: 13, highWater: 14 };
/** Feature independent of elevation; bare high ground has the ground feature. */
export const surfaceFeature = (code) => code === SURFACE.high ? SURFACE.ground : code & 7;
export const isSurfaceHigh = (code) => code === SURFACE.high || (code & 8) !== 0;
/** Change elevation without losing the feature. Cliffs have no placeable low/high variant. */
export function withSurfaceElevation(code, high) {
  const feature = surfaceFeature(code);
  return feature === SURFACE.cliff ? SURFACE.cliff : feature === SURFACE.ground ? (high ? SURFACE.high : SURFACE.ground) : feature | (high ? 8 : 0);
}
/** Replace a feature while preserving the cell's authoritative base elevation. */
export const withSurfaceFeature = (code, feature) => withSurfaceElevation(feature, isSurfaceHigh(code));
/** Closed authored-code set; reserved bit combinations are not terrain. */
export const isSurfaceCode = (code) => Number.isInteger(code) && (code >= 0 && code <= 6 || code === 10 || code === 12 || code === 13 || code === 14);
/** Cliffs and deep water block surface movement and construction; water does not block sight. */
export const isSurfaceBlocked = (code) => code === SURFACE.cliff || surfaceFeature(code) === SURFACE.water;
export const isSurfaceWet = (code) => surfaceFeature(code) === SURFACE.ford || surfaceFeature(code) === SURFACE.water;
/** Packed terrain: 7 cells per int, 4 bits each (28 used bits, always a positive word). */
export const TERRAIN_CELLS_PER_WORD = 7;
export const TERRAIN_CODE_BITS = 4;
const TERRAIN_CODE_MASK = (1 << TERRAIN_CODE_BITS) - 1;
export function packTerrain(terrain) {
  const words = new Array(Math.ceil(terrain.length / TERRAIN_CELLS_PER_WORD)).fill(0);
  for (let c = 0; c < terrain.length; c++) words[(c / TERRAIN_CELLS_PER_WORD) | 0] |= terrain[c] << (TERRAIN_CODE_BITS * (c % TERRAIN_CELLS_PER_WORD));
  return words;
}
export function unpackTerrain(words, size) {
  const out = new Uint8Array(size * size);
  for (let c = 0; c < out.length; c++) out[c] = (words[(c / TERRAIN_CELLS_PER_WORD) | 0] >>> (TERRAIN_CODE_BITS * (c % TERRAIN_CELLS_PER_WORD))) & TERRAIN_CODE_MASK;
  return out;
}

/** Surface holes: all impassable on the surface and never portals (transfers use own Shafts only); diggers backfill them. */
export const HOLE_KINDS = ['sinkhole', 'crater', 'chasm', 'breach'];
/** Cells per vision/designation bitset word: bit i of word w is cell w * VISION_BITS_PER_WORD + i (row-major y * size + x). */
export const VISION_BITS_PER_WORD = 30;
