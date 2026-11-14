/**
 * Grid navigation on each match's map, plus surface line of sight. Scratch buffers cover maps up to 80×80 and are
 * module-level and reused (the sim is single-threaded), so searches allocate only what they return.
 *
 * - Depths: uniform-cost search (4-connected, tunnel/rail/dig costs) and multi-source cost fields for miners.
 * - Surface: per-goal flow fields (reverse Dijkstra, 8-connected, no corner cutting, entry cost × step length, so
 *   forests and fords cost more), cached per goal cell, army frame and hull radius (`FlowFields`). A unit attaches its
 *   exact position to a hull-safe centre, descends the field and steers at the farthest visible centre using exact
 *   swept-disc clearance, so smoothing cannot reintroduce a gap or corner that the hull cannot pass.
 *
 * Symmetry by construction: `frame` (the searching army's, 0..3 quarter turns) runs the search in that army's canonical
 * frame (rotated neighbour order, seeding order and sampling), so rotated armies in rotated situations get exactly
 * rotated fields, tie-breaks and paths. The heap breaks key ties by push order only, never by cell index, so a rotated
 * push sequence pops rotated cells.
 */
import { CELL, designationFrontier, isLava, isOpenCell, isSurfaceHigh } from '../rules/terrain.ts';
import { MAX_MAP_SIZE, toTicks } from '../rules/vocabulary.ts';
import type { Econ } from '../rules/contract.ts';
import { norm } from '../util/math.ts';
import { canonX, canonY, frameDir, rotCell, rotVX, rotVY } from '../util/teams.ts';

/** Ticks to cross one depths cell at digger speed off the highways; tunnels and rails divide it by their speed. */
const MOVE_COST = toTicks(0.5);

/** Default number of surface flow fields an army caches (least recently used dropped first). */
export const FLOW_FIELD_CAP = 64;

/** Dig designation priorities per cell (0: untagged), as the `designate` intent sets them. */
export const DESIGNATE_NORMAL = 1;
export const DESIGNATE_URGENT = 2;

/** Depths cell codes run 0..CELL_CODES-1: entry cost tables index by code. */
const CELL_CODES = Object.keys(CELL).length;

/** Heap capacity per cell: a search pushes a cell at most once per 8-connected neighbour. */
const HEAP_PER_CELL = 8;

/** lineClear samples the segment this many times per tile. */
const LINE_SAMPLES_PER_TILE = 4;

const MAX_CELLS = MAX_MAP_SIZE * MAX_MAP_SIZE;
const dist = new Float64Array(MAX_CELLS);
const prev = new Int32Array(MAX_CELLS);
const seen = new Uint32Array(MAX_CELLS);
let gen = 0;

const heapKey = new Float64Array(MAX_CELLS * HEAP_PER_CELL);
const heapVal = new Int32Array(MAX_CELLS * HEAP_PER_CELL);
const designationBlocked = new Uint8Array(MAX_CELLS);
const alternativeOwner = new Int32Array(MAX_CELLS);
const alternativeVia = new Int32Array(MAX_CELLS);
const alternativeReserved = new Uint8Array(MAX_CELLS);
let heapN = 0;

function push(k: number, v: number): void {
  let i = heapN++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapKey[p]! <= k) break;
    heapKey[i] = heapKey[p]!;
    heapVal[i] = heapVal[p]!;
    i = p;
  }
  heapKey[i] = k;
  heapVal[i] = v;
}

function pop(): number {
  const top = heapVal[0]!;
  const k = heapKey[--heapN]!;
  const v = heapVal[heapN]!;
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= heapN) break;
    if (c + 1 < heapN && heapKey[c + 1]! < heapKey[c]!) c++;
    if (heapKey[c]! >= k) break;
    heapKey[i] = heapKey[c]!;
    heapVal[i] = heapVal[c]!;
    i = c;
  }
  heapKey[i] = k;
  heapVal[i] = v;
  return top;
}

/**
 * Cost (ticks) to enter a depths cell, by cell code (-1 = impassable): `walk` for walkers (tunnels and rails), `dig`
 * for diggers (they also dig through rock, ore and fortified rock). From a match's rules.
 */
export interface DepthsCosts {
  readonly walk: Float64Array;
  readonly dig: Float64Array;
}
export function depthsCosts(econ: Econ): DepthsCosts {
  const walk = new Float64Array(CELL_CODES).fill(-1);
  const dig = new Float64Array(CELL_CODES).fill(-1);
  const tunnel = MOVE_COST / econ.tunnelSpeed;
  walk[CELL.tunnel] = dig[CELL.tunnel] = tunnel;
  // A lava bridge is walked at tunnel pace.
  walk[CELL.bridge] = dig[CELL.bridge] = tunnel;
  walk[CELL.rail] = dig[CELL.rail] = MOVE_COST / econ.railSpeed;
  dig[CELL.rock] = tunnel + econ.digRock;
  dig[CELL.ore] = tunnel + econ.digOre;
  dig[CELL.rich] = tunnel + econ.digRich;
  dig[CELL.fortified] = tunnel + econ.digFortified;
  return { walk, dig };
}

const closed = new Uint32Array(MAX_CELLS);

function walkBack(start: number, goal: number): number[] {
  const path: number[] = [];
  for (let c = goal; c !== start; c = prev[c]!) path.push(c);
  path.reverse();
  return path;
}

/**
 * Per-army obstacles on top of the cell codes. `gate`: bulkhead army bits per cell (armyBit(a): blocks army a);
 * a cell gated for `mask` costs what fortified rock costs (diggers dig through it, walkers cannot pass). `keep`: cells
 * not to dig through while they hold ore (lode pockets: mined from beside, never tunnelled through), unless the goal.
 */
export interface Barrier {
  readonly gate: Uint8Array;
  readonly mask: number;
  readonly keep: Uint8Array | null;
  /** Known solid structures and observed hostile shields. Unlike gates, even diggers cannot tunnel through them. */
  readonly solid?: Uint8Array;
}

/** Entry cost of `n` for a search: -1 if impassable, or a cell the army knows hides magma (`avoid`). */
function enterCost(table: Float64Array, cells: Uint8Array, avoid: Uint8Array | null, n: number, bar: Barrier | null): number {
  if (avoid !== null && isLava(avoid[n]!)) return -1;
  if (bar !== null) {
    if (bar.solid?.[n]) return -1;
    if ((bar.gate[n]! & bar.mask) !== 0) return table[CELL.fortified]!;
    if (bar.keep !== null && bar.keep[n] === 1 && cells[n] === CELL.ore) return -1;
  }
  return table[cells[n]!]!;
}

/**
 * Uniform-cost search in the depths from `start` to the cheapest cell satisfying `isGoal` (4-connected), entering
 * cells at `table` cost (DepthsCosts `walk` or `dig`).
 * A goal cell may be entered even if it is not otherwise passable (e.g. the ore cell being mined).
 * `avoid`: the army's depths knowledge; known magma blocks entry except an otherwise permitted goal. With `flow` (the
 * flowing magma, never located solid pockets), an occupant standing in it may cross further flowing cells to leave,
 * never re-enter from dry ground. Each such step costs more than any dry route (a penalty of the cell count times the
 * dearest entry), so routes minimise magma cells first and leave the flood as soon as they can.
 * `bar`: the searching army's bulkheads and kept cells (see Barrier). `frame`: the searching army's frame.
 * Returns the cells to visit after `start`, ending at the goal; `[]` if start is a goal; null if unreachable.
 */
export function searchDepths(
  cells: Uint8Array,
  start: number,
  isGoal: (c: number) => boolean,
  table: Float64Array,
  goalAlwaysEnterable = false,
  maxCost = Infinity,
  frame = 0,
  avoid: Uint8Array | null = null,
  bar: Barrier | null = null,
  size: number,
  flow: Uint8Array | null = null,
): number[] | null {
  const cellCount = size * size;
  let magmaStep = 0;
  if (flow !== null) {
    let dearest = 0;
    for (let k = 0; k < table.length; k++) dearest = Math.max(dearest, table[k]!);
    magmaStep = cellCount * dearest;
  }
  if (isGoal(start)) return [];
  gen++;
  heapN = 0;
  seen[start] = gen;
  dist[start] = 0;
  push(0, start);
  // The frame's four step directions, and whether entry costs are the plain table (no knowledge mask, no barrier).
  const k0 = frameDir(frame, 0), k1 = frameDir(frame, 1), k2 = frameDir(frame, 2), k3 = frameDir(frame, 3);
  const plain = avoid === null && bar === null;
  while (heapN > 0) {
    const c = pop();
    if (closed[c] === gen) continue;
    closed[c] = gen;
    const d = dist[c]!;
    if (c !== start && isGoal(c)) return walkBack(start, c);
    if (d > maxCost) return null;
    const x = c % size;
    for (let k = 0; k < 4; k++) {
      const kk = k === 0 ? k0 : k === 1 ? k1 : k === 2 ? k2 : k3;
      const n = kk === 0 ? (x < size - 1 ? c + 1 : -1) : kk === 1 ? (x > 0 ? c - 1 : -1) : kk === 2 ? c + size : c - size;
      if (n < 0 || n >= cellCount || closed[n] === gen) continue;
      let cost = plain ? table[cells[n]!]! : enterCost(table, cells, avoid, n, bar);
      // Only an occupant already in flowing magma or a lava lake may cross more burning cells to get out.
      if (flow !== null && isLava(flow[c]!) && isLava(flow[n]!)
        && !bar?.solid?.[n] && (!bar || (bar.gate[n]! & bar.mask) === 0)) cost = magmaStep;
      if (cost < 0) {
        if (!goalAlwaysEnterable || cells[n] === CELL.bedrock || bar?.solid?.[n] || !isGoal(n)) continue;
        cost = table[CELL.tunnel]!;
      }
      const nd = d + cost;
      if (seen[n] === gen && dist[n]! <= nd) continue;
      seen[n] = gen;
      dist[n] = nd;
      prev[n] = c;
      push(nd, n);
    }
  }
  return null;
}

/**
 * Reverse multi-source search: `out[c]` = cheapest cost from standing on c to reaching a goal cell
 * (goals are entered for free: a digger mines a goal from beside it). Infinity where unreachable.
 * One field serves every unit of an army; follow it with `descend` (same `table` and `avoid`).
 */
export function costField(cells: Uint8Array, goals: Uint8Array, goalCode: number, table: Float64Array, out: Float64Array, frame = 0, avoid: Uint8Array | null = null, bar: Barrier | null = null, size: number): void {
  const cellCount = size * size;
  out.fill(Infinity, 0, cellCount);
  gen++;
  heapN = 0;
  // Seed in the frame's row-major order: equal-cost goals then pop in rotated order.
  for (let i = 0; i < cellCount; i++) {
    const c = rotCell(frame, i, size);
    if (goals[c] === goalCode && cells[c] !== CELL.bedrock && !bar?.solid?.[c]) {
      out[c] = 0;
      push(0, c);
    }
  }
  while (heapN > 0) {
    const c = pop();
    if (closed[c] === gen) continue;
    closed[c] = gen;
    const enter = out[c] === 0 && goals[c] === goalCode ? 0 : enterCost(table, cells, avoid, c, bar);
    if (enter < 0) continue; // cannot be entered, so nothing routes through it
    const nd = out[c]! + enter;
    const x = c % size;
    for (let k = 0; k < 4; k++) {
      const kk = frameDir(frame, k);
      const n = kk === 0 ? (x < size - 1 ? c + 1 : -1) : kk === 1 ? (x > 0 ? c - 1 : -1) : kk === 2 ? c + size : c - size;
      if (n < 0 || n >= cellCount || closed[n] === gen || out[n]! <= nd) continue;
      out[n] = nd;
      push(nd, n);
    }
  }
}

/**
 * One shared priority-then-distance field for dig designations. Only known open ground carries the wave.
 * A diagonal-only tag seeds its one chosen connector, with one extra walking step; arbitrary untagged
 * walls never carry the wave. `via` records this permission independently of competing field owners.
 */
export function designationField(cells: Uint8Array, tags: Uint8Array, table: Float64Array, out: Float64Array, owner: Int32Array, next: Int32Array, via: Int32Array, frame: number, bar: Barrier, reserved: Uint8Array | undefined, cap = Infinity, minimumPriority = DESIGNATE_NORMAL, size: number): void {
  const cellCount = size * size;
  out.fill(Infinity, 0, cellCount);
  owner.fill(-1, 0, cellCount);
  next.fill(-1, 0, cellCount);
  via.fill(-1, 0, cellCount);
  gen++;
  heapN = 0;
  for (let c = 0; c < cellCount; c++) designationBlocked[c] = (bar.gate[c]! & bar.mask) !== 0 || (bar.keep?.[c] === 1 && cells[c] === CELL.ore) ? 1 : 0;
  const normal = cellCount * Math.max(table[CELL.tunnel]!, table[CELL.rail]!) + 1;
  for (let i = 0; i < cellCount; i++) {
    const c = rotCell(frame, i, size);
    if (tags[c]! < minimumPriority) continue;
    const source = designationFrontier(cells, tags, c, frame, designationBlocked, size);
    via[c] = source;
    if (source < 0 || (reserved && (reserved[c]! >= cap || reserved[source]! >= cap))) continue;
    const distance = (tags[c] === DESIGNATE_URGENT ? 0 : normal) + (source === c ? 0 : table[CELL.tunnel]!);
    if (out[source]! <= distance) continue;
    out[source] = distance;
    owner[source] = c;
    next[source] = source === c ? -1 : c;
    push(distance, source);
  }
  while (heapN > 0) {
    const c = pop();
    if (closed[c] === gen) continue;
    closed[c] = gen;
    const enter = isOpenCell(cells[c]!) ? enterCost(table, cells, null, c, bar) : 0;
    if (enter < 0) continue;
    const nd = out[c]! + enter;
    const x = c % size;
    for (let k = 0; k < 4; k++) {
      const kk = frameDir(frame, k);
      const n = kk === 0 ? (x < size - 1 ? c + 1 : -1) : kk === 1 ? (x > 0 ? c - 1 : -1) : kk === 2 ? c + size : c - size;
      if (n < 0 || n >= cellCount || closed[n] === gen || !isOpenCell(cells[n]!) || enterCost(table, cells, null, n, bar) < 0 || out[n]! <= nd) continue;
      out[n] = nd;
      owner[n] = owner[c]!;
      next[n] = c;
      push(nd, n);
    }
  }
}

/** Saturated-frontier work theft, only on assignment/topology changes; scratch fields are reused, not retained. */
export function designationAlternative(cells: Uint8Array, tags: Uint8Array, table: Float64Array, start: number, frame: number, bar: Barrier, reserved: Uint8Array, cap: number, minimumPriority: number, current: number, connector: number, size: number): number[] | null {
  let limits = reserved;
  if (current >= 0) {
    alternativeReserved.set(reserved);
    alternativeReserved[current]!--;
    if (connector >= 0) alternativeReserved[connector]!--;
    limits = alternativeReserved;
  }
  designationField(cells, tags, table, dist, alternativeOwner, prev, alternativeVia, frame, bar, limits, cap, minimumPriority, size);
  const goal = alternativeOwner[start]!;
  if (goal < 0) return null;
  const path: number[] = [];
  for (let c = start; c !== goal;) {
    c = prev[c]!;
    if (c < 0) return null;
    path.push(c);
  }
  return path;
}

/** Follow a cost field from `start` to a goal; returns the cells after start ending at the goal, or null. */
export function descend(
  cells: Uint8Array,
  field: Float64Array,
  goals: Uint8Array,
  goalCode: number,
  start: number,
  table: Float64Array,
  frame = 0,
  avoid: Uint8Array | null = null,
  bar: Barrier | null = null,
  size: number,
): number[] | null {
  const cellCount = size * size;
  if (field[start] === Infinity) return null;
  const path: number[] = [];
  let c = start;
  for (let steps = 0; steps < cellCount; steps++) {
    if (c !== start && goals[c] === goalCode) return path;
    const x = c % size;
    let best = -1;
    let bestCost = Infinity;
    for (let k = 0; k < 4; k++) {
      const kk = frameDir(frame, k);
      const n = kk === 0 ? (x < size - 1 ? c + 1 : -1) : kk === 1 ? (x > 0 ? c - 1 : -1) : kk === 2 ? c + size : c - size;
      if (n < 0 || n >= cellCount) continue;
      const enter = goals[n] === goalCode && cells[n] !== CELL.bedrock ? 0 : enterCost(table, cells, avoid, n, bar);
      if (enter < 0) continue;
      const total = enter + field[n]!;
      if (total < bestCost) {
        bestCost = total;
        best = n;
      }
    }
    if (best < 0 || bestCost === Infinity) return null;
    path.push(best);
    c = best;
  }
  return null;
}

const SQ2 = Math.SQRT2;
const singleGoal = [0];

/**
 * Surface flow field toward `goal`: `out[c]` = cheapest travel cost from c to the goal (8-connected, no corner
 * cutting, step length × entry cost of the cell stepped into), Infinity where blocked or unreachable.
 */
export function flowField(blocked: Uint8Array, cost: Float32Array, goal: number, out: Float64Array, frame = 0, size: number, edges?: Uint8Array, geometry?: SurfaceGeometry, next?: Int32Array): void {
  singleGoal[0] = goal;
  flowFieldTo(blocked, cost, singleGoal, out, frame, size, edges, geometry, next);
}

/**
 * Multi-goal surface flow field: cost to the cheapest of `goals` (each 0), same step rule as flowField. Rotated
 * fields need the goals listed in rotated order (the search then runs step for step alike).
 */
export function flowFieldTo(blocked: Uint8Array, cost: Float32Array, goals: readonly number[], out: Float64Array, frame = 0, size: number, edges?: Uint8Array, geometry?: SurfaceGeometry, next?: Int32Array): void {
  out.fill(Infinity, 0, size * size);
  next?.fill(-1);
  gen++;
  heapN = 0;
  for (const goal of goals) {
    if (edges && blocked[goal]) continue;
    out[goal] = 0;
    push(0, goal);
  }
  while (heapN > 0) {
    const n = pop();
    if (closed[n] === gen) continue;
    closed[n] = gen;
    // Stepping from a neighbour c into n costs step × cost[n] (n may be blocked only as the goal itself).
    const into = out[n]!;
    const x = n % size;
    const y = (n / size) | 0;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        if (i === 0 && j === 0) continue;
        const dx = rotVX(frame, j, i);
        const dy = rotVY(frame, j, i);
        const cx = x + dx;
        const cy = y + dy;
        if (cx < 0 || cy < 0 || cx >= size || cy >= size) continue;
        const c = cy * size + cx;
        if (blocked[c] || closed[c] === gen) continue;
        if (edges ? !(edges[n]! & edgeBit(dx, dy)) : dx !== 0 && dy !== 0 && (blocked[y * size + cx] || blocked[cy * size + x])) continue;
        // Shifted representatives are not grid centres: two cells may even name the same physical point.
        // Charging a fictitious grid step there gives that point conflicting potentials during re-anchoring.
        const step = geometry ? norm(geometry.x[n]! - geometry.x[c]!, geometry.y[n]! - geometry.y[c]!) : dx !== 0 && dy !== 0 ? SQ2 : 1;
        const nd = into + step * cost[n]!;
        if (nd >= out[c]!) continue;
        out[c] = nd;
        // n is already settled. Retaining this tree makes zero-length aliases cycle-free without an invented toll.
        if (next) next[c] = n;
        push(nd, c);
      }
    }
  }
}

/** The neighbour of `from` on its cheapest way down `field` (same step rule as flowField), or -1 at the goal / when cut off. */
export function descendSurface(blocked: Uint8Array, cost: Float32Array, field: Float64Array, from: number, frame = 0, size: number, edges?: Uint8Array): number {
  if (field[from] === 0) return -1;
  const x = from % size;
  const y = (from / size) | 0;
  let best = -1;
  let bd = Infinity;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      if (i === 0 && j === 0) continue;
      // Canonical offset (j, i) rotated into the world: the frame's neighbour order.
      const dx = rotVX(frame, j, i);
      const dy = rotVY(frame, j, i);
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const n = ny * size + nx;
      if (blocked[n] || (edges ? !(edges[from]! & edgeBit(dx, dy)) : dx !== 0 && dy !== 0 && (blocked[y * size + nx] || blocked[ny * size + x]))) continue;
      const d = field[n]! + (dx !== 0 && dy !== 0 ? SQ2 : 1) * cost[n]!;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
  }
  return best;
}

/** World-neighbour bit, independent of the frame's traversal order. */
function edgeBit(dx: number, dy: number): number {
  const i = (dy + 1) * 3 + dx + 1;
  return 1 << (i > 4 ? i - 1 : i);
}

interface FlowSlot {
  field: Float64Array;
  version: number;
  next?: Int32Array;
  used: number;
}

export interface SurfaceGeometry {
  readonly blocked: Uint8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
}

interface HullTopology extends SurfaceGeometry {
  edges: Uint8Array | undefined;
  version: number;
  used: number;
  fields: Map<number, FlowSlot>;
}

/**
 * Per-army flow fields shared by exact hull radius, frame and goal. Each cell has one legal representative: its
 * centre where possible, otherwise a clear edge midpoint or corner. This preserves two-tile passages for hulls wider
 * than one tile. Swept-disc edges and representatives rebuild only on known-obstacle changes; both LRUs are bounded.
 */
export class FlowFields {
  private readonly hulls = new Map<number, Map<number, HullTopology>>();
  private readonly successors = new Map<Float64Array, Int32Array>();
  private hullCount = 0;
  private count = 0;
  private readonly blocked: Uint8Array;
  private readonly cost: Float32Array;
  private readonly cap: number;
  private readonly size: number;

  constructor(blocked: Uint8Array, cost: Float32Array, cap = FLOW_FIELD_CAP, size: number) {
    this.blocked = blocked;
    this.cost = cost;
    this.cap = cap;
    this.size = size;
  }

  /** The field toward a legal goal representative, searched in `frame`. */
  get(goal: number, frame: number, version: number, tick: number, radius = 0): Float64Array {
    const hull = this.topology(radius, frame, version, tick);
    const f = this.slot(hull, goal * 4 + frame, tick);
    if (f.version !== version) {
      flowField(hull.blocked, this.cost, goal, f.field, frame, this.size, hull.edges, hull.edges ? hull : undefined, f.next);
      f.version = version;
    }
    return f.field;
  }

  /** The caller's goal-set key is unique per set and frame; cells without legal representatives are never seeded. */
  getSet(key: number, frame: number, version: number, tick: number, goals: () => readonly number[], radius = 0): Float64Array {
    const hull = this.topology(radius, frame, version, tick);
    const f = this.slot(hull, 4 * this.size * this.size + key * 4 + frame, tick);
    if (f.version !== version) {
      flowFieldTo(hull.blocked, this.cost, goals(), f.field, frame, this.size, hull.edges, hull.edges ? hull : undefined, f.next);
      f.version = version;
    }
    return f.field;
  }

  descend(field: Float64Array, from: number, frame: number, version: number, tick: number, radius: number): number {
    const next = this.successors.get(field);
    if (next) return next[from]!;
    const hull = this.topology(radius, frame, version, tick);
    return descendSurface(hull.blocked, this.cost, field, from, frame, this.size, hull.edges);
  }

  geometry(radius: number, frame: number, version: number, tick: number): SurfaceGeometry {
    return this.topology(radius, frame, version, tick);
  }

  /**
   * Attach an exact position to a nearby legal representative by a clear hull sweep. With a field choose the
   * cheapest reachable connector; without one choose the nearest. A bounded local scan, never a per-unit grid search
   * or allocation. Representatives may lie on cell edges; every consumer uses these coordinates, not cell centres.
   */
  anchor(x: number, y: number, frame: number, version: number, tick: number, radius: number, field?: Float64Array, escape = false): number {
    const hull = this.topology(radius, frame, version, tick);
    const px = canonX(frame, x, y, this.size);
    const py = canonY(frame, x, y, this.size);
    const reach = Math.ceil(radius) + 1;
    let best = -1;
    let distance = Infinity;
    for (let cy = Math.max(0, Math.floor(py) - reach); cy <= Math.min(this.size - 1, Math.floor(py) + reach); cy++) {
      for (let cx = Math.max(0, Math.floor(px) - reach); cx <= Math.min(this.size - 1, Math.floor(px) + reach); cx++) {
        const c = rotCell(frame, cy * this.size + cx, this.size);
        if (hull.blocked[c]) continue;
        const d = (field ? field[c]! : 0) + norm(hull.x[c]! - x, hull.y[c]! - y) * this.cost[c]!;
        if (d >= distance || !hullLineClear(this.blocked, x, y, hull.x[c]!, hull.y[c]!, radius, frame, this.size, escape)) continue;
        distance = d;
        best = c;
      }
    }
    return best;
  }

  private topology(radius: number, frame: number, version: number, tick: number): HullTopology {
    let frames = this.hulls.get(radius);
    let hull = frames?.get(frame);
    if (!hull) {
      if (this.hullCount >= this.cap) {
        let oldestRadius = -1, oldestFrame = -1, used = Infinity;
        for (const [r, fs] of this.hulls) for (const [f, h] of fs) {
          if (h.used < used) { oldestRadius = r; oldestFrame = f; used = h.used; }
        }
        const oldest = this.hulls.get(oldestRadius)!;
        this.count -= oldest.get(oldestFrame)!.fields.size;
        for (const f of oldest.get(oldestFrame)!.fields.values()) this.successors.delete(f.field);
        oldest.delete(oldestFrame);
        if (oldest.size === 0) this.hulls.delete(oldestRadius);
        this.hullCount--;
        frames = this.hulls.get(radius);
      }
      if (!frames) { frames = new Map(); this.hulls.set(radius, frames); }
      const n = this.size * this.size;
      hull = { blocked: radius === 0 ? this.blocked : new Uint8Array(n), edges: radius === 0 ? undefined : new Uint8Array(n), x: new Float64Array(n), y: new Float64Array(n), version: -1, used: tick, fields: new Map() };
      frames.set(frame, hull);
      this.hullCount++;
    }
    hull.used = tick;
    if (hull.version === version) return hull;
    const size = this.size;
    for (let c = 0; c < size * size; c++) {
      const x = c % size + 0.5, y = Math.floor(c / size) + 0.5;
      hull.x[c] = x;
      hull.y[c] = y;
      if (!hull.edges) continue;
      hull.blocked[c] = 1;
      if (this.blocked[c]) continue;
      // Prefer the centre, then face midpoints, then corners; ties use the searching army's frame.
      for (let ring = 0; ring <= 2 && hull.blocked[c]; ring++) {
        for (let iy = -1; iy <= 1 && hull.blocked[c]; iy++) {
          for (let ix = -1; ix <= 1; ix++) {
            if (Math.abs(ix) + Math.abs(iy) !== ring) continue;
            const px = x + rotVX(frame, ix, iy) / 2, py = y + rotVY(frame, ix, iy) / 2;
            if (!hullLineClear(this.blocked, px, py, px, py, radius, frame, size)) continue;
            hull.x[c] = px;
            hull.y[c] = py;
            hull.blocked[c] = 0;
            break;
          }
        }
      }
    }
    if (hull.edges) {
      hull.edges.fill(0);
      // Each undirected edge is tested once, from its lower end in the frame's cell order and swept in the frame, so
      // rotated twins' topologies are exact rotations; store both world directions.
      for (let k = 0; k < size * size; k++) {
        const c = rotCell(frame, k, size);
        if (hull.blocked[c]) continue;
        const x = k % size, y = Math.floor(k / size);
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = dy === 0 ? 1 : -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= size || ny >= size) continue;
            const n = rotCell(frame, ny * size + nx, size);
            if (hull.blocked[n] || !hullLineClear(this.blocked, hull.x[c]!, hull.y[c]!, hull.x[n]!, hull.y[n]!, radius, frame, size)) continue;
            const wx = rotVX(frame, dx, dy), wy = rotVY(frame, dx, dy);
            hull.edges[c]! |= edgeBit(wx, wy);
            hull.edges[n]! |= edgeBit(-wx, -wy);
          }
        }
      }
    }
    hull.version = version;
    return hull;
  }

  private slot(hull: HullTopology, key: number, tick: number): FlowSlot {
    let f = hull.fields.get(key);
    if (!f) {
      if (this.count >= this.cap) {
        let oldest = -1;
        let at = Infinity;
        let owner = hull;
        for (const frames of this.hulls.values()) for (const h of frames.values()) for (const [k, v] of h.fields) {
          if (v.used < at) { at = v.used; oldest = k; owner = h; }
        }
        this.successors.delete(owner.fields.get(oldest)!.field);
        owner.fields.delete(oldest);
        this.count--;
      }
      f = { field: new Float64Array(this.size * this.size), next: hull.edges ? new Int32Array(this.size * this.size) : undefined, version: -1, used: tick };
      if (f.next) this.successors.set(f.field, f.next);
      hull.fields.set(key, f);
      this.count++;
    }
    f.used = tick;
    return f;
  }
}

/**
 * Exact swept-disc clearance against the same blocked cell rectangles as placement. Tangency is legal; no radius
 * shrink or sampled corners. Map boundaries constrain the whole hull. Only the caller's known blocker grid is read.
 * `escape` permits leaving an existing overlap only without ever deepening it; quantized boundary positions and
 * newly discovered footprints must not strand a unit whose centre is outside the blocker.
 * World endpoints are swept in `frame`: rotated twins round the same canonical arithmetic, so an exact tangency (a
 * 3-4-5 run past a cell corner) decides alike for them.
 */
export function hullLineClear(blocked: Uint8Array, wx0: number, wy0: number, wx1: number, wy1: number, radius: number, frame: number, size: number, escape = false): boolean {
  const x0 = canonX(frame, wx0, wy0, size), y0 = canonY(frame, wx0, wy0, size);
  const x1 = canonX(frame, wx1, wy1, size), y1 = canonY(frame, wx1, wy1, size);
  if (Math.min(x0, x1, y0, y1) < radius || Math.max(x0, x1, y0, y1) > size - radius) return false;
  const dx = x1 - x0, dy = y1 - y0;
  const length2 = dx * dx + dy * dy;
  const r2 = radius * radius;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - radius));
  const maxX = Math.min(size - 1, Math.floor(Math.max(x0, x1) + radius));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius));
  const maxY = Math.min(size - 1, Math.floor(Math.max(y0, y1) + radius));
  for (let y = minY; y <= maxY; y++) {
    // Restrict each row to the capsule's strip instead of scanning a long diagonal's bounding square.
    const t0 = dy === 0 ? 0 : Math.max(0, Math.min((y - radius - y0) / dy, (y + 1 + radius - y0) / dy));
    const t1 = dy === 0 ? 1 : Math.min(1, Math.max((y - radius - y0) / dy, (y + 1 + radius - y0) / dy));
    const rowMin = Math.max(minX, Math.floor(Math.min(x0 + dx * t0, x0 + dx * t1) - radius));
    const rowMax = Math.min(maxX, Math.floor(Math.max(x0 + dx * t0, x0 + dx * t1) + radius));
    for (let x = rowMin; x <= rowMax; x++) {
      if (!blocked[rotCell(frame, y * size + x, size)]) continue;
      const ax = Math.max(x - x0, 0, x0 - x - 1), ay = Math.max(y - y0, 0, y0 - y - 1);
      const bx = Math.max(x - x1, 0, x1 - x - 1), by = Math.max(y - y1, 0, y1 - y - 1);
      const start2 = ax * ax + ay * ay;
      const clearance2 = escape && start2 > 0 ? Math.min(r2, start2) : r2;
      if ((!escape && start2 < r2) || bx * bx + by * by < clearance2) return false;
      // A segment crossing the rectangle has zero distance even when all its corners are far away.
      let lo = 0, hi = 1;
      if (dx === 0) { if (x0 < x || x0 > x + 1) hi = -1; }
      else { lo = Math.max(lo, Math.min((x - x0) / dx, (x + 1 - x0) / dx)); hi = Math.min(hi, Math.max((x - x0) / dx, (x + 1 - x0) / dx)); }
      if (dy === 0) { if (y0 < y || y0 > y + 1) hi = -1; }
      else { lo = Math.max(lo, Math.min((y - y0) / dy, (y + 1 - y0) / dy)); hi = Math.min(hi, Math.max((y - y0) / dy, (y + 1 - y0) / dy)); }
      if (lo <= hi) return false;
      if (length2 === 0) continue;
      for (let cy = y; cy <= y + 1; cy++) {
        for (let cx = x; cx <= x + 1; cx++) {
          const t = Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / length2));
          const ex = x0 + t * dx - cx, ey = y0 + t * dy - cy;
          if (ex * ex + ey * ey < clearance2) return false;
        }
      }
    }
  }
  return true;
}

/**
 * True if the straight segment avoids blocked cells (sampled every 1/LINE_SAMPLES_PER_TILE tiles; each sample floors in
 * `frame`, so a sample on a cell border resolves to rotated cells for rotated armies).
 */
export function lineClear(blocked: Uint8Array, x0: number, y0: number, x1: number, y1: number, frame = 0, size: number): boolean {
  const steps = Math.ceil(norm(x1 - x0, y1 - y0) * LINE_SAMPLES_PER_TILE);
  for (let i = 0; i <= steps; i++) {
    const f = steps === 0 ? 1 : i / steps;
    const px = x0 + (x1 - x0) * f;
    const py = y0 + (y1 - y0) * f;
    const cx = Math.min(size - 1, Math.max(0, Math.floor(canonX(frame, px, py, size))));
    const cy = Math.min(size - 1, Math.max(0, Math.floor(canonY(frame, px, py, size))));
    if (blocked[rotCell(frame, cy * size + cx, size)]) return false;
  }
  return true;
}

const bfsQueue = new Int32Array(MAX_CELLS);
const bfsDepth = new Uint8Array(MAX_CELLS);

/**
 * Depths vision: flood through tunnel/rail cells up to `radius` steps from `start`, OR-ing `bit` (the viewer's vision
 * group) into every visited cell and its 8 neighbours (the walls you can see) in `out`. Cells gated for `mask`
 * (hostile bulkheads) stop the flood like a wall: they are seen, not seen through. Rock blocks sight as it blocks
 * movement (4-connected): an open diagonal neighbour is seen only past an orthogonal cell the flood sees through,
 * never through a corner pinched shut by rock or a hostile gate. Breadth-first depths are shortest distances, so the
 * marked set does not depend on neighbour order (no frame needed).
 */
export function revealDepths(cells: Uint8Array, start: number, radius: number, out: Uint8Array, gate: Uint8Array | null, mask: number, size: number, bit: number): void {
  const cellCount = size * size;
  gen++;
  let head = 0;
  let tail = 0;
  bfsQueue[tail++] = start;
  seen[start] = gen;
  bfsDepth[start] = 0;
  while (head < tail) {
    const c = bfsQueue[head++]!;
    const x = c % size;
    const y = (c / size) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= size) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= size) continue;
        const n = ny * size + nx;
        if (dx !== 0 && dy !== 0 && isOpenCell(cells[n]!)
          && !seeThrough(cells, gate, mask, y * size + nx) && !seeThrough(cells, gate, mask, ny * size + x)) continue;
        out[n]! |= bit;
      }
    }
    if (!isOpenCell(cells[c]!) && c !== start) continue;
    const dep = bfsDepth[c]!;
    if (dep >= radius) continue;
    for (let k = 0; k < 4; k++) {
      const n = k === 0 ? (x < size - 1 ? c + 1 : -1) : k === 1 ? (x > 0 ? c - 1 : -1) : k === 2 ? c + size : c - size;
      if (n < 0 || n >= cellCount || seen[n] === gen || !seeThrough(cells, gate, mask, n)) continue;
      seen[n] = gen;
      bfsDepth[n] = dep + 1;
      bfsQueue[tail++] = n;
    }
  }
}

/** Does Depths sight pass through cell `c`: open, and not a gate shut to the viewer (`mask`)? */
function seeThrough(cells: Uint8Array, gate: Uint8Array | null, mask: number, c: number): boolean {
  return isOpenCell(cells[c]!) && (gate === null || (gate[c]! & mask) === 0);
}

/** Half-size of the precomputed line-of-sight window (covers the longest vision and weapon range). */
const LOS_RADIUS = 12;
const LOS_SIDE = 2 * LOS_RADIUS + 1;
const LOS_WORDS = Math.ceil((LOS_SIDE * LOS_SIDE) / 32);

/**
 * Surface line of sight between cell centres; `opaque` cells (cliffs) block it. Exact and symmetric under every
 * quarter turn: the segment walks every cell its interior crosses in integer arithmetic, and a segment through a cell
 * corner also checks the two cells beside that corner.
 * Per-origin visibility masks are built lazily and cached (terrain is static).
 */
export class LineOfSight {
  private readonly opaque: Uint8Array;
  private readonly masks: (Uint32Array | undefined)[];
  private readonly size: number;
  /** false: nothing on this map blocks sight (every query is true) */
  readonly any: boolean;

  constructor(opaque: Uint8Array, size: number) {
    this.opaque = opaque;
    this.size = size;
    this.masks = new Array(size * size);
    let any = false;
    for (let c = 0; c < size * size; c++) {
      if (opaque[c]) {
        any = true;
        break;
      }
    }
    this.any = any;
  }

  visible(from: number, to: number): boolean {
    const size = this.size;
    if (!this.any || from === to) return true;
    const dx = (to % size) - (from % size);
    const dy = Math.floor(to / size) - Math.floor(from / size);
    if (dx < -LOS_RADIUS || dx > LOS_RADIUS || dy < -LOS_RADIUS || dy > LOS_RADIUS) return this.trace(from, to);
    let mask = this.masks[from];
    if (!mask) {
      mask = this.build(from);
      this.masks[from] = mask;
    }
    const bit = (dy + LOS_RADIUS) * LOS_SIDE + dx + LOS_RADIUS;
    return ((mask[bit >> 5]! >>> (bit & 31)) & 1) === 1;
  }

  /**
   * ORs `bit` into the visible cells of one span (cells start, start + step, …, end; step 1: a row, step size: a column)
   * using a single cache lookup, rather than recomputing cell offsets for every query. Each cell's outcome is
   * `visible(from, cell)`, so the span direction never changes the result.
   */
  stamp(v: Uint8Array, terrain: Uint8Array, from: number, start: number, end: number, bit: number, step = 1): void {
    const size = this.size;
    if (!this.any) {
      for (let i = start; i <= end; i += step) if (!isSurfaceHigh(terrain[i]!)) v[i]! |= bit;
      return;
    }
    const dx = (start % size) - (from % size);
    const dy = Math.floor(start / size) - Math.floor(from / size);
    const row = step === 1;
    const ex = row ? dx + end - start : dx;
    const ey = row ? dy : dy + (end - start) / size;
    if (dx < -LOS_RADIUS || ex > LOS_RADIUS || dy < -LOS_RADIUS || ey > LOS_RADIUS) {
      for (let i = start; i <= end; i += step) if ((v[i]! & bit) === 0 && !isSurfaceHigh(terrain[i]!) && this.visible(from, i)) v[i]! |= bit;
      return;
    }
    let mask = this.masks[from];
    if (!mask) {
      let i = start;
      while (i <= end && ((v[i]! & bit) !== 0 || isSurfaceHigh(terrain[i]!))) i += step;
      if (i > end) return; // Keep lazy masks unallocated when this observer adds no visibility.
      mask = this.build(from);
      this.masks[from] = mask;
    }
    const maskStep = row ? 1 : LOS_SIDE;
    let at = (dy + LOS_RADIUS) * LOS_SIDE + dx + LOS_RADIUS;
    for (let i = start; i <= end; i += step, at += maskStep) {
      if ((v[i]! & bit) === 0 && !isSurfaceHigh(terrain[i]!) && ((mask[at >> 5]! >>> (at & 31)) & 1)) v[i]! |= bit;
    }
  }

  private build(from: number): Uint32Array {
    const size = this.size;
    const mask = new Uint32Array(LOS_WORDS);
    const ox = from % size;
    const oy = Math.floor(from / size);
    for (let dy = -LOS_RADIUS; dy <= LOS_RADIUS; dy++) {
      const y = oy + dy;
      if (y < 0 || y >= size) continue;
      for (let dx = -LOS_RADIUS; dx <= LOS_RADIUS; dx++) {
        const x = ox + dx;
        if (x < 0 || x >= size || !this.trace(from, y * size + x)) continue;
        const bit = (dy + LOS_RADIUS) * LOS_SIDE + dx + LOS_RADIUS;
        mask[bit >> 5]! |= 1 << (bit & 31);
      }
    }
    return mask;
  }

  /**
   * Does the segment between the two cell centres pass only through see-through cells (endpoints excluded)? Every cell
   * it enters counts, however short the clip: sampling along the segment would miss a cliff's corner and see through
   * the joint of a diagonal cliff line.
   */
  private trace(from: number, to: number): boolean {
    const size = this.size;
    if (from === to) return true;
    let x = from % size;
    let y = Math.floor(from / size);
    const dx = (to % size) - x;
    const dy = Math.floor(to / size) - y;
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;
    const nx = Math.abs(dx);
    const ny = Math.abs(dy);
    for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
      // Next border crossed: the column border at fraction (2ix + 1) / 2nx or the row border at (2iy + 1) / 2ny.
      const next = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (next === 0) {
        if (this.opaque[y * size + x + sx] || this.opaque[(y + sy) * size + x]) return false;
        x += sx;
        y += sy;
        ix++;
        iy++;
      } else if (next < 0) {
        x += sx;
        ix++;
      } else {
        y += sy;
        iy++;
      }
      const c = y * size + x;
      if (c !== to && this.opaque[c]) return false;
    }
    return true;
  }
}
