/**
 * Forward post placement (DESIGN §4.2 Outposts): home posts near each Spire and contested points (the centre, the
 * flanks). Public, from Surface terrain, public prepared lode sites and the map recipe alone. Secret lode placement
 * keeps off their footprints; flags never move in response to a hidden lode. A generated document stores its posts;
 * an authored document places its own, and one that places none gets the unreserved terrain recipe.
 */
import type { MapRules } from '../rules/match-rules.ts';
import { FLANK_ANCHOR, isSurfaceBlocked, surfaceFeature, SURFACE } from '../rules/terrain.ts';
import { norm, wrapPi } from '../util/math.ts';
import { rotCell } from '../util/teams.ts';
import { REFERENCE_MAP_SIZE, type MapPost } from './types.ts';
import { dmath } from '../util/fdlibm.js';

export type PostRules = Readonly<Pick<MapRules, 'postCount' | 'postDistanceMin' | 'postDistanceMax' | 'postSpread' | 'postClearance' | 'contestedPosts' | 'contestedPostOffset'>>;

/**
 * The flank anchor of slot 0's sector (a point), shared by the flank lode zone and the flank contested points: on
 * two-slot maps the Spire-free corner FLANK_ANCHOR (scaled), on four-slot maps the midpoint of the top edge between
 * slots 0 and 1, FLANK_ANCHOR.y in from it. Its rotations are the other flanks.
 */
export function flankAnchor(size: number, sides: 2 | 4): { x: number; y: number } {
  const scale = size / REFERENCE_MAP_SIZE;
  return sides === 2 ? { x: FLANK_ANCHOR.x * scale, y: FLANK_ANCHOR.y * scale } : { x: size / 2, y: FLANK_ANCHOR.y * scale };
}

/** Cells walkable-reachable (4-neighbour) from the Spire centre `spire` on the Surface. */
function reachable(terrain: ArrayLike<number>, size: number, spire: { readonly x: number; readonly y: number }): Uint8Array {
  const n = size * size;
  const reach = new Uint8Array(n);
  const start = Math.floor(spire.y) * size + Math.floor(spire.x);
  const queue = [start];
  reach[start] = 1;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    const x = c % size;
    for (const d of [x > 0 ? c - 1 : -1, x < size - 1 ? c + 1 : -1, c - size, c + size]) {
      if (d < 0 || d >= n || reach[d] || isSurfaceBlocked(terrain[d]!)) continue;
      reach[d] = 1;
      queue.push(d);
    }
  }
  return reach;
}

/** A post stands on plain ground or high ground (never forest, ford, fault, water or cliff), one cell inside the border. */
const postGround = (terrain: ArrayLike<number>, size: number, reach: Uint8Array, x: number, y: number): boolean => {
  const c = y * size + x;
  return x >= 1 && y >= 1 && x < size - 1 && y < size - 1 && reach[c] === 1 && (terrain[c] === SURFACE.ground || terrain[c] === SURFACE.high);
};

/**
 * Slot 0's home post cells, in post order (from the bearing nearest −postSpread to +postSpread). Every other slot's
 * post k is post k turned slot · 4/sides quarter turns, so C2 and C4 maps place them exactly symmetrically.
 *
 * A post stands on post ground (postGround), walkable-reachable from the Spire and at least postClearance from the
 * Spire→centre line (the default rally and the army's lane), on its own side of that line. Post k aims at bearing
 * centreLine + spread · (2k/(count−1) − 1) (the centre line itself for one post), measured from the Spire centre to the
 * cell centre. Each post takes the open cell that best fits: inside the distance band first (else the least outside
 * it), then the smallest bearing error, then nearest the band's middle, then the lowest cell index. Cells already taken
 * by an earlier post or reserved for a public resource site are skipped.
 */
export function placePosts(terrain: ArrayLike<number>, size: number, spire: { readonly x: number; readonly y: number }, rules: PostRules): number[] {
  return placeHomePosts(terrain, size, spire, rules, reachable(terrain, size, spire));
}

function placeHomePosts(terrain: ArrayLike<number>, size: number, spire: { readonly x: number; readonly y: number }, rules: PostRules, reach: Uint8Array, reserved?: Uint8Array): number[] {
  const centreLine = dmath.atan2(size / 2 - spire.y, size / 2 - spire.x);
  const ux = dmath.cos(centreLine);
  const uy = dmath.sin(centreLine);
  const spread = (rules.postSpread * Math.PI) / 180;
  const mid = (rules.postDistanceMin + rules.postDistanceMax) / 2;
  const posts: number[] = [];
  for (let k = 0; k < rules.postCount; k++) {
    const offset = rules.postCount === 1 ? 0 : spread * ((2 * k) / (rules.postCount - 1) - 1);
    const bearing = centreLine + offset;
    let best = -1;
    let bestOut = Infinity;
    let bestAngle = Infinity;
    let bestMid = Infinity;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const c = y * size + x;
        if (!postGround(terrain, size, reach, x, y) || reserved?.[c] || posts.includes(c)) continue;
        const dx = x + 0.5 - spire.x;
        const dy = y + 0.5 - spire.y;
        // Signed distance off the centre line: a flank post stays on its own side, clear of the rally lane.
        const side = ux * dy - uy * dx;
        if (offset !== 0 && (side * offset <= 0 || Math.abs(side) < rules.postClearance)) continue;
        const d = norm(dx, dy);
        const out = Math.max(0, rules.postDistanceMin - d, d - rules.postDistanceMax);
        const angle = Math.abs(wrapPi(dmath.atan2(dy, dx) - bearing));
        const off = Math.abs(d - mid);
        // Row-major scan: an exact tie keeps the lower cell index.
        if (out < bestOut || (out === bestOut && (angle < bestAngle || (angle === bestAngle && off < bestMid)))) {
          best = c;
          bestOut = out;
          bestAngle = angle;
          bestMid = off;
        }
      }
    }
    if (best >= 0) posts.push(best);
  }
  return posts;
}

/**
 * Every post of a map from the recipe (rules.map), rotation-closed in World.posts order: each slot's home posts (slot 0's
 * placePosts turned onto it), then the contested points of rules.map.contestedPosts.
 * - centre: the map centre itself (it falls on a cell corner, the one point every turn fixes), when one of its four
 *   cells is walkable and reachable from slot 0's Spire; else none.
 * - flanks: per slot, the reachable cell of plain ground, high ground or ford (a contested point may stand in a stream)
 *   nearest the point contestedPostOffset (S48 tiles, scaled) from slot 0's flank anchor toward the centre, never a
 *   home post's cell (ties: the lowest cell index), turned onto every slot.
 * `reserved` is the public preparation's footprint/apron mask, never the secret lode layout.
 */
export function recipePosts(terrain: ArrayLike<number>, size: number, sides: 2 | 4, spire: { readonly x: number; readonly y: number }, rules: PostRules, reserved?: Uint8Array): MapPost[] {
  const reach = reachable(terrain, size, spire);
  const home = placeHomePosts(terrain, size, spire, rules, reach, reserved);
  const out: MapPost[] = [];
  for (let slot = 0; slot < sides; slot++) {
    for (const c of home) {
      const at = rotCell((slot * 4) / sides, c, size);
      out.push({ x: (at % size) + 0.5, y: Math.floor(at / size) + 0.5, kind: 'home', slot });
    }
  }
  const half = size / 2;
  if (rules.contestedPosts.includes('centre') && [0, 1].every((dy) => [0, 1].every((dx) => !reserved?.[(half - 1 + dy) * size + half - 1 + dx])) &&
    [0, 1].some((dy) => [0, 1].some((dx) => reach[(half - 1 + dy) * size + half - 1 + dx] === 1))) {
    out.push({ x: half, y: half, kind: 'contested' });
  }
  if (rules.contestedPosts.includes('flanks')) {
    const anchor = flankAnchor(size, sides);
    const toCentre = norm(half - anchor.x, half - anchor.y);
    const step = toCentre > 0 ? Math.min(toCentre, (rules.contestedPostOffset * size) / REFERENCE_MAP_SIZE) / toCentre : 0;
    const tx = anchor.x + (half - anchor.x) * step;
    const ty = anchor.y + (half - anchor.y) * step;
    const taken = new Set(out.map((p) => Math.floor(p.y) * size + Math.floor(p.x)));
    let best = -1;
    let bestD = Infinity;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const c = y * size + x;
        const code = terrain[c]!;
        if (!reach[c] || reserved?.[c] || taken.has(c) || (code !== SURFACE.ground && code !== SURFACE.high && surfaceFeature(code) !== SURFACE.ford)) continue;
        const d = norm(x + 0.5 - tx, y + 0.5 - ty);
        // Row-major scan: an exact tie keeps the lower cell index.
        if (d < bestD) {
          best = y * size + x;
          bestD = d;
        }
      }
    }
    if (best >= 0) {
      for (let r = 0; r < sides; r++) {
        const at = rotCell((r * 4) / sides, best, size);
        out.push({ x: (at % size) + 0.5, y: Math.floor(at / size) + 0.5, kind: 'contested' });
      }
    }
  }
  return out;
}

/**
 * The posts a match spawns, in spawn order (the sim's `posts`, matchData.posts): the document's (World.posts), or the
 * recipe's when it places none, less the home posts of map slots no army plays (`slots`: the armies' slots, in army
 * order, which is slot order). So army a's home posts come a-th, then every contested point.
 */
export function matchPosts(world: { readonly posts: readonly MapPost[]; readonly terrain: ArrayLike<number>; readonly size: number }, sides: 2 | 4, spire: { readonly x: number; readonly y: number }, rules: PostRules, slots: readonly number[]): MapPost[] {
  const posts = world.posts.length ? world.posts : recipePosts(world.terrain, world.size, sides, spire, rules);
  return posts.filter((p) => p.kind === 'contested' || slots.includes(p.slot!));
}

/**
 * Does a lode site centred on cell `c` (its outcrop and apron: Chebyshev `reach` cells) come within `clearance` tiles of
 * any post's point? Lodes keep off posts, never the reverse, so no post position depends on a secret lode.
 */
export function crowdsPost(c: number, reach: number, posts: readonly MapPost[], size: number, clearance: number): boolean {
  const x = (c % size) + 0.5;
  const y = Math.floor(c / size) + 0.5;
  for (const p of posts) {
    const dx = Math.max(0, Math.abs(p.x - x) - reach);
    const dy = Math.max(0, Math.abs(p.y - y) - reach);
    if (dx === 0 && dy === 0) return true;
    if (norm(dx, dy) < clearance) return true;
  }
  return false;
}
