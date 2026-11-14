// Agent Command's built-in bot library: packages/game/src/util/teams.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * Armies and frames (DESIGN §15.1). Inside the sim an army is a dense index `0..N-1` (slot order) and every entity's
 * `side` is an army index or NEUTRAL; the slot (map corner) and colour are properties of the army. The contract names
 * an army by its corner (`ARMIES`: nw, ne, se, sw), whose index is the army's frame.
 *
 * Frames: army `a` computes in its canonical frame, the world rotated by `-frame(a)` quarter turns about the map
 * centre, so rotated armies in rotated situations take exactly rotated decisions. One quarter turn maps
 * (x, y) → (size − y, x), as `rotatePoint` in maps/document.ts; frame 2 is the C2 point mirror. A quarter turn only
 * swaps and negates coordinates, so positions on the sign-symmetric grid stay exact.
 */
import { ARMIES, MAX_ARMIES, } from '../rules/vocabulary.js';

/** Owner index of neutral entities (islands, asteroids, hazards). */
export const NEUTRAL = MAX_ARMIES;

export const isArmy = (s) => s !== NEUTRAL;
/** One bit per army in per-cell army masks (dig damage, gates, barriers). */
export const armyBit = (a) => 1 << a;

// ------------------------------------------------------------------------------- contract boundary (army ids)

/** Guard for untyped input (seat strings, parsed records): is `v` an army id? */
export const isArmyId = (v) => (ARMIES).includes(v);
/** Is contract side `s` an army (not neutral)? */
export const isArmySide = (s) => s !== 'neutral';
/** Frame of army `id`: the quarter turns carrying the NW corner onto its corner (0..3). */
export const frameOf = (id) => ARMIES.indexOf(id);
/** The army id of slot `slot` on a `sides`-slot map (slots step 4/sides quarter turns). */
export const armyIdOfSlot = (slot, sides) => ARMIES[slot * (4 / sides)];
/** The slot army `id` plays on a `sides`-slot map, or −1 when its corner is no slot of that map. */
export function slotOfArmyId(id, sides) {
  const step = 4 / sides;
  const frame = frameOf(id);
  return frame % step === 0 ? frame / step : -1;
}
/** The army ids of every slot of a `sides`-slot map, in slot order (setup only: allocates). */
export const slotArmyIds = (sides) => Array.from({ length: sides }, (_, slot) => armyIdOfSlot(slot, sides));
/**
 * Is contract side `side` hostile to army `me` in a match whose armies (`matchData.armies`) carry these colours?
 * Armies of another colour are hostile; neutral is hostile to nobody. Observation-side code (bots, policies, client).
 */
export function hostileSide(match, me, side) {
  if (side === 'neutral' || side === me) return false;
  let mine;
  let theirs;
  for (const a of match.armies) {
    if (a.id === me) mine = a.colour;
    if (a.id === side) theirs = a.colour;
  }
  return theirs !== undefined && theirs !== mine;
}

// ---------------------------------------------------------------------------------------------------- frames

/** x of (x, y) rotated by `k` quarter turns (k in 0..3) about the centre of a `size` map. */
export const rotX = (k, x, y, size) => (k === 0 ? x : k === 1 ? size - y : k === 2 ? size - x : y);
/** y of (x, y) rotated by `k` quarter turns about the centre of a `size` map. */
export const rotY = (k, x, y, size) => (k === 0 ? y : k === 1 ? x : k === 2 ? size - y : size - x);
/** x of world point (x, y) in frame `k` (rotated back by `k` quarter turns). */
export const canonX = (k, x, y, size) => rotX((4 - k) & 3, x, y, size);
/** y of world point (x, y) in frame `k`. */
export const canonY = (k, x, y, size) => rotY((4 - k) & 3, x, y, size);
/** Vector (dx, dy) rotated by `k` quarter turns: x, then y. */
export const rotVX = (k, dx, dy) => (k === 0 ? dx : k === 1 ? -dy : k === 2 ? -dx : dy);
export const rotVY = (k, dx, dy) => (k === 0 ? dy : k === 1 ? dx : k === 2 ? -dy : -dx);
/** Cell `c` rotated by `k` quarter turns (cell (x, y) → (size − 1 − y, x) per turn). */
export function rotCell(k, c, size) {
  if (k === 0) return c;
  if (k === 2) return size * size - 1 - c;
  const x = c % size;
  const y = (c - x) / size;
  return k === 1 ? x * size + size - 1 - y : (size - 1 - x) * size + y;
}
/** Cell `c` in frame `k`: its row-major index there is the frame's tie-break order (`key_frame`, DESIGN §15.4). */
export const canonCell = (k, c, size) => rotCell((4 - k) & 3, c, size);
/** Heading presented for an angle computed in frame `k`. */
export const QUARTER_TURN = Math.PI / 2;

/**
 * Four-neighbour expansion in a frame: canonical direction k (0 +x, 1 −x, 2 +y, 3 −y) rotated by `frame` quarter
 * turns, as a world direction index in the same numbering. Frame 2 is `k ^ 1` (the old mirrored order).
 */
const FRAME_DIRS = [0, 1, 2, 3, 2, 3, 1, 0, 1, 0, 3, 2, 3, 2, 0, 1];
export const frameDir = (frame, k) => FRAME_DIRS[frame * 4 + k];
/** Vector (dx, dy) in frame `k` (rotated back by `k` quarter turns): x, then y. */
export const canonVX = (k, dx, dy) => rotVX((4 - k) & 3, dx, dy);
export const canonVY = (k, dx, dy) => rotVY((4 - k) & 3, dx, dy);

/**
 * Sector (slot) of world point (x, y) on a `sides`-slot map of `size`: the r whose r · 4/sides quarter turns carry it
 * from slot 0's canonical sector (C2: the low-y half; C4: the low-x/low-y quadrant). The half-open edges rotate onto
 * each other, so rotated points get rotated sectors exactly; the centre itself is sector 0. Ties between armies
 * "from" a contested spot break by relative slot order from its sector.
 */
export function sectorOf(x, y, size, sides) {
  const vx = x - size / 2;
  const vy = y - size / 2;
  const step = 4 / sides;
  for (let r = 0; r < sides; r++) {
    const cx = canonVX(r * step, vx, vy);
    const cy = canonVY(r * step, vx, vy);
    if (sides === 4 ? cx < 0 && cy <= 0 : cy < 0 || (cy === 0 && cx < 0)) return r;
  }
  return 0;
}
