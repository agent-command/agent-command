// Agent Command's built-in bot library: packages/game/src/bots/depths-lava.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
import { CELL, isDiggable, isOpenCell } from '../rules/terrain.js';
import { frameDir, rotCell } from '../util/teams.js';


const BEDROCK = CELL.bedrock;
/** A search's entry step per cell code: 0 open, 1 one bridge (a lake cell, `lakes`) or one dig (diggable or unknown), -1 closed. */
function stepTable(lakes) {
  const out = new Int8Array(Object.keys(CELL).length);
  for (let code = 0; code < out.length; code++) out[code] = isOpenCell(code) ? 0 : (lakes && code === CELL.lake) || isDiggable(code) || code === CELL.unknown ? 1 : -1;
  return out;
}
const WET_STEP = stepTable(true);
const DRY_STEP = stepTable(false);

/**
 * Lava-lake crossings from observed terrain only. A 0-1 search from the cells our tunnels reach (`reached`): walkable
 * cells are free, a lava-lake cell or a diggable or unknown cell costs one (one bridge or one dig). The cheapest route
 * to `goal` is walked from its start: at its first lake cell, that cell is bridged if the cell before it is walkable
 * already, otherwise that cell (the shore) is dug to first. Expansion runs in the army's frame, so rotated armies
 * pick rotated crossings. Buffers are reused; nothing is allocated per decision but the result.
 */
export class LakePlanner {
 dist;
 prev;
 deque;
  /** Cells our tunnels reach, marked per search (seeds walked in frame order without a set lookup per cell). */
 seed;
  /** World cells in frame `orderFrame`'s row-major order. */
 order;
 orderFrame = -1;
 size;

  constructor(size) {
    this.size = size;
    const n = size * size;
    this.dist = new Int32Array(n);
    this.prev = new Int32Array(n);
    this.deque = new Int32Array(4 * n);
    this.seed = new Uint8Array(n);
    this.order = new Int32Array(n);
  }

  /**
   * The crossing on the cheapest route to `goal`, or null when that route crosses no lake. `plan`: the cell codes
   * planned with (bedrock: never entered, as known gates); `bridgeable`: may a bridge start on this lake cell now (the
   * sim's span rule on our knowledge). `withoutLakes`: the cheapest route's cost with every lake closed (Infinity: none).
   */
  cross(grid, reached, goal, frame, plan, bridgeable) {
    const withLakes = this.search(grid, reached, goal, frame, plan, WET_STEP);
    const end = withLakes;
    const cost = end >= 0 ? this.dist[end] : Infinity;
    // The first lake cell on the route, walking it from where it leaves our tunnels.
    let first = -1;
    for (let c = end; c >= 0 && this.prev[c] >= 0; c = this.prev[c]) if (grid[c] === CELL.lake) first = c;
    let crossing = null;
    if (first >= 0) {
      const shore = this.prev[first];
      crossing = shore >= 0 && isOpenCell(grid[shore]) && bridgeable(first) ? { bridge: first, shore } : { bridge: -1, shore };
    }
    const dry = crossing ? this.search(grid, reached, goal, frame, plan, DRY_STEP) : end;
    return { crossing, cost, withoutLakes: dry >= 0 ? this.dist[dry] : Infinity };
  }

 search(grid, reached, goal, frame, plan, steps) {
    const size = this.size, n = size * size, dist = this.dist, prev = this.prev, deque = this.deque, seed = this.seed, order = this.order;
    dist.fill(-1);
    prev.fill(-1);
    let lo = 2 * n, hi = 2 * n;
    if (this.orderFrame !== frame) {
      for (let k = 0; k < n; k++) order[k] = rotCell(frame, k, size);
      this.orderFrame = frame;
    }
    // Seeds in the frame's row-major order, so equal routes resolve alike for rotated armies.
    seed.fill(0);
    for (const c of reached) if (c >= 0 && c < n) seed[c] = 1;
    for (let k = 0; k < n; k++) {
      const c = order[k];
      if (!seed[c]) continue;
      dist[c] = 0;
      deque[hi++] = c;
    }
    const d0 = frameDir(frame, 0), d1 = frameDir(frame, 1), d2 = frameDir(frame, 2), d3 = frameDir(frame, 3);
    while (lo < hi) {
      const c = deque[lo++];
      if (goal(c)) return c;
      const x = c % size;
      for (let k = 0; k < 4; k++) {
        const d = k === 0 ? d0 : k === 1 ? d1 : k === 2 ? d2 : d3;
        const m = d === 0 ? (x < size - 1 ? c + 1 : -1) : d === 1 ? (x > 0 ? c - 1 : -1) : d === 2 ? c + size : c - size;
        if (m < 0 || m >= n || plan[m] === BEDROCK) continue;
        const step = steps[grid[m]] ?? -1;
        if (step < 0 && !goal(m)) continue;
        const nd = dist[c] + Math.max(0, step);
        if (dist[m] >= 0 && dist[m] <= nd) continue;
        dist[m] = nd;
        prev[m] = c;
        if (step <= 0) deque[--lo] = m;
        else deque[hi++] = m;
      }
    }
    return -1;
  }
}
