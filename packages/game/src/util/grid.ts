/** Grid math: cell indices in each army's canonical frame, adjacency and position quantization. */
import { canonX, canonY, rotCell } from './teams.ts';

/**
 * An entity's cell. floor() of a position exactly on a cell border would break the map's rotational symmetry, so
 * depths units carry the walkable cell they stand in (resolved per frame like cellFor; their cell, not a path cell
 * behind them), Spire segments (on a cell corner) carry rotated cells for the armies, and everything else resolves its
 * point in its owner's frame (cellFor).
 */
export const cellOfEnt = (e: { cell: number; frame: number; x: number; y: number }, size: number): number => (e.cell >= 0 ? e.cell : cellFor(e.frame, e.x, e.y, size));

export const cellOf = (x: number, y: number, size: number): number =>
  Math.min(size - 1, Math.max(0, Math.floor(y))) * size + Math.min(size - 1, Math.max(0, Math.floor(x)));

/**
 * The cell frame `frame` means by point (x, y): floor() of the point in that frame, rotated back, so a point on a cell
 * border (a hostile Spire's corner, the map centre) resolves to rotated cells for rotated armies.
 */
export const cellFor = (frame: number, x: number, y: number, size: number): number =>
  (frame === 0 ? cellOf(x, y, size) : rotCell(frame, cellOf(canonX(frame, x, y, size), canonY(frame, x, y, size), size), size));

/**
 * Positions, velocities and the relative avoidance bend share a sign-symmetric 2^-30 grid.
 * Keeping positions on it makes x and size - x exactly representable too: ORCA's tangent constraints must not
 * amplify differing coordinate precision at opposite map edges into different velocities.
 */
const QUANTUM = 1 << 30;

export const quantize = (v: number): number => (v < 0 ? -Math.round(-v * QUANTUM) : Math.round(v * QUANTUM)) / QUANTUM;

const POS_MARGIN = Math.ceil(0.01 * QUANTUM) / QUANTUM;

export const clampPos = (v: number, size: number): number => Math.min(size - POS_MARGIN, Math.max(POS_MARGIN, size / 2 + quantize(v - size / 2)));

export function adjacent4(a: number, b: number, size: number): boolean {
  const ax = a % size;
  const bx = b % size;
  const ay = Math.floor(a / size);
  const by = Math.floor(b / size);
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

/** Cell `c` seen from the other side of the point mirror (180° about the map centre). */
export const mirrorCell = (c: number, size: number): number => size * size - 1 - c;

/** Centre x of cell `c`. */
export const cellCentreX = (c: number, size: number): number => (c % size) + 0.5;

/** Centre y of cell `c`. */
export const cellCentreY = (c: number, size: number): number => Math.floor(c / size) + 0.5;
