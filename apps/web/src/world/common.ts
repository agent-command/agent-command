import { Color } from 'three/webgpu';
import { ARMIES, CELL, COLOURS, PLANE_Y, isOpenCell, slotArmyIds, type ArmyId, type Colour, type MatchArmy, type Plane, type Side } from '@agent-command/game/contract';

/** Tile x → world X. */
export const wx = (x: number, size: number): number => x - size / 2;
/** Tile y → world Z. */
export const wz = (y: number, size: number): number => y - size / 2;

/** Height above the plane's reference altitude at which units stand. */
export const GROUND: Record<Plane, number> = { depths: 0.05, surface: 0.12, sky: 0.9, orbit: 0 };
/** Shared rock-cut height for Depths terrain and structures mounted on unexcavated rock. */
export const DEPTHS_ROCK_HEIGHT = 1.25;

/**
 * Bearing of a lava bridge's span at cell (x, y) in team knowledge: 0 along x, π/2 along y. A neighbouring bridge cell
 * names the span's axis first (a run is straight), else the dry ground it leaves from; with neither it lies along x.
 * The Depths deck and the `lava_bridge` model share it, so trim and planks always line up.
 */
export function spanYaw(cells: ArrayLike<number>, x: number, y: number, size: number): number {
  x = Math.floor(x); y = Math.floor(y);
  // Off the map is the bedrock rim: never a span to follow.
  const at = (nx: number, ny: number): number => nx < 0 || ny < 0 || nx >= size || ny >= size ? CELL.bedrock : cells[ny * size + nx] ?? CELL.unknown;
  const east = at(x + 1, y), west = at(x - 1, y), south = at(x, y + 1), north = at(x, y - 1);
  if (east === CELL.bridge || west === CELL.bridge) return 0;
  if (south === CELL.bridge || north === CELL.bridge) return Math.PI / 2;
  if (isOpenCell(east) || isOpenCell(west)) return 0;
  return isOpenCell(south) || isOpenCell(north) ? Math.PI / 2 : 0;
}

export const unitY = (plane: Plane): number => PLANE_Y[plane] + GROUND[plane];

/** Cursor aim intersects the target page at its normal unit altitude, not the focused page underneath it. */
export const AIM_Y: Record<Plane, number> = {
  depths: PLANE_Y.depths + GROUND.depths,
  surface: PLANE_Y.surface + GROUND.surface,
  sky: PLANE_Y.sky + GROUND.sky + 1.6,
  orbit: PLANE_Y.orbit + GROUND.orbit + 0.2,
};

/**
 * Drawn colour of each alliance colour (CSS `--army-<colour>`) and of neutral. Keyed by colour, never by army: an army
 * is drawn in `SIDE_HEX[colourOf(army)]`. The observer's accessible palette swaps these values in place.
 */
export const SIDE_HEX: Record<Colour | 'neutral', string> = { blue: '#3aa8ff', red: '#ff4f5e', green: '#96f075', violet: '#8b55f6', neutral: '#d8c89a' };

export const SIDE_COLOR: Record<Colour | 'neutral', Color> = {
  blue: new Color(SIDE_HEX.blue),
  red: new Color(SIDE_HEX.red),
  green: new Color(SIDE_HEX.green),
  violet: new Color(SIDE_HEX.violet),
  neutral: new Color(SIDE_HEX.neutral),
};

/**
 * Colour of every army of the match on screen (`matchData.armies`). One match is shown per page; whoever adopts a
 * match's data (world, observer, previews) calls `setArmyColours` first, so lookups never allocate. A corner that is
 * not an army of the match is drawn neutral. Until a match is adopted the table holds the default match of a
 * two-slot map (the k-th army in slot order takes COLOURS[k]: nw blue, se red).
 */
const ARMY_COLOUR: Record<ArmyId, Colour | 'neutral'> = { nw: 'neutral', ne: 'neutral', se: 'neutral', sw: 'neutral' };
export function setArmyColours(armies: readonly MatchArmy[]): void {
  for (const id of ARMIES) ARMY_COLOUR[id] = 'neutral';
  for (const a of armies) ARMY_COLOUR[a.id] = a.colour;
}
/** The match rule without chosen colours: the k-th of `ids` in slot (corner) order is coloured COLOURS[k]. */
export const defaultArmyColours = (ids: readonly ArmyId[]): MatchArmy[] =>
  ids.toSorted((a, b) => ARMIES.indexOf(a) - ARMIES.indexOf(b)).map((id, k) => ({ id, colour: COLOURS[k]! }));
setArmyColours(defaultArmyColours(slotArmyIds(2)));
/** The colour `side` is drawn in. */
export const colourOf = (side: Side): Colour | 'neutral' => (side === 'neutral' ? 'neutral' : ARMY_COLOUR[side]);
export const sideHex = (side: Side): string => SIDE_HEX[colourOf(side)];
export const sideColor = (side: Side): Color => SIDE_COLOR[colourOf(side)];

/** How `side` stands toward army `me`: same colour is allied (stage 3), another colour hostile (DESIGN §15.3). */
export type Relation = 'own' | 'allied' | 'hostile' | 'neutral';
export function relation(me: ArmyId, side: Side): Relation {
  if (side === me) return 'own';
  if (side === 'neutral') return 'neutral';
  return ARMY_COLOUR[side] === ARMY_COLOUR[me] ? 'allied' : 'hostile';
}

/**
 * Hostile threat telegraphs (charges, breaches) from any army's perspective: a bright amber-yellow that stays apart
 * from every army colour under the common colour-vision deficiencies (palette.test.ts checks the separation).
 */
export const THREAT_HEX = '#ffd23f';
export const THREAT_COLOR = new Color(THREAT_HEX);

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Deterministic 2D hash in [0,1). */
export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0,1). */
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise centred on 0 (within ±0.5), for build-time model shaping (same as the lookdev's). */
export function fbm(x: number, y: number, oct = 3): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    s += (vnoise(x * f, y * f) - 0.5) * amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s;
}
