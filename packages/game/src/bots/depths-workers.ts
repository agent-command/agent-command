import { footprintDistance } from '../rules/stats.ts';
import { CELL, isLava, isOpenCell, isOreCell } from '../rules/terrain.ts';
import type { Entity } from '../rules/contract.ts';
import { norm } from '../util/math.ts';
import { frameDir } from '../util/teams.ts';
import type { Ctx, Frame } from './context.ts';
import { ORE_HOLD_REACH, WALK_HOLD_SLACK } from './tuning.ts';

/** Worker danger bits: a hostile digger's envelope, and any other observed weapon's. */
const RIVAL_DIGGER = 1;
const ARMED = 2;
/** Open cell codes (isOpenCell), read inline by the per-cell passes: a call per cell is most of their cost in QuickJS. */
const TUNNEL = CELL.tunnel, RAIL = CELL.rail, BRIDGE = CELL.bridge;

/** Observation-only worker routes. Reachability from a stranded miner is not a delivery route. */
export class WorkerRoutes {
  private readonly blocked: Uint8Array;
  /** Observed weapon envelopes: RIVAL_DIGGER bits from hostile diggers, ARMED bits from every other weapon. */
  private readonly danger: Uint8Array;
  private readonly drops: Uint8Array;
  private readonly queue: Int32Array;
  private readonly safe: Int32Array;
  private readonly served: Uint8Array;
  /** Components and their delivery service ignoring rival diggers: Mother Lode crews meet those by design (contested). */
  private readonly crewSafe: Int32Array;
  private readonly crewServed: Uint8Array;
  /** Manhattan cells from each cell to the nearest observed weapon envelope (the cell count where there is none). */
  private readonly clearance: Int32Array;
  private grid: readonly number[] = [];
  private frame: Frame | null = null;
  /** Entry cost of a tunnel and of a rail cell, in units of the cheapest entry (both ≥ 1). */
  private tunnelWeight = 1;
  private railWeight = 1;
  readonly shelter: Int32Array;
  readonly dropNext: Int32Array;
  threats = false;
  readonly escapeNext: Int32Array;
  private readonly workNext: Int32Array;
  private workCell = -1;
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
    const n = size * size;
    this.blocked = new Uint8Array(n);
    this.danger = new Uint8Array(n);
    this.drops = new Uint8Array(n);
    this.queue = new Int32Array(n);
    this.safe = new Int32Array(n);
    this.served = new Uint8Array(n + 1);
    this.crewSafe = new Int32Array(n);
    this.crewServed = new Uint8Array(n + 1);
    this.clearance = new Int32Array(n);
    this.shelter = new Int32Array(n);
    this.dropNext = new Int32Array(n);
    this.escapeNext = new Int32Array(n);
    this.workNext = new Int32Array(n);
  }

  prepare(c: Ctx, knownGates: Iterable<{ x: number; y: number }>, knownShields: Iterable<Entity>): void {
    this.grid = c.obs.depths ?? [];
    this.frame = c.frame;
    const fast = Math.max(c.econ.tunnelSpeed, c.econ.railSpeed);
    this.tunnelWeight = fast / c.econ.tunnelSpeed;
    this.railWeight = fast / c.econ.railSpeed;
    this.blocked.fill(0);
    this.danger.fill(0);
    this.drops.fill(0);
    this.threats = false;
    this.workCell = -1;
    for (const gate of knownGates) this.blocked[this.cell(gate)] = 1;
    // Located pockets share the magma code but are solid: never an escape route out of a flood.
    for (const pocket of c.obs.pockets) this.blocked[pocket.y * this.size + pocket.x] = 1;
    for (const shield of knownShields) {
      this.blocked[this.cell(shield)] = 1;
      this.threats = true; // keep deliberate safe work instead of reverting to unrestricted auto-mine
    }
    for (const a of c.match.armies) {
      if (c.obs.eliminated.includes(a.id) || (a.id === c.army && !c.segmentAlive('depths'))) continue;
      const { x, y } = a.spireAt;
      for (let yy = Math.floor(y - 1.5); yy < y + 1.5; yy++) for (let xx = Math.floor(x - 1.5); xx < x + 1.5; xx++) this.blocked[yy * this.size + xx] = 1;
      if (a.id === c.army) for (let yy = Math.floor(y - 2.5); yy <= y + 1.5; yy++) for (let xx = Math.floor(x - 2.5); xx <= x + 1.5; xx++) {
        const d = footprintDistance('spire', x, y, xx + 0.5, yy + 0.5);
        if (d > 0 && d <= Math.SQRT1_2) this.drops[yy * this.size + xx] = 1;
      }
    }
    for (const e of c.obs.entities) {
      const cell = this.cell(e);
      if ((e.kind === 'geothermal' || (e.kind === 'bulkhead' && c.hostile(e.side))) && e.plane === 'depths') this.blocked[cell] = 1;
      if (e.side === c.army && (e.kind === 'shaft' || e.kind === 'headframe') && e.state !== 'constructing') this.drops[cell] = 1;
      if (e.plane !== 'depths' || !c.hostile(e.side)) continue;
      const stats = c.statsOf(e);
      if (stats.dmg <= 0) continue;
      this.threats = true;
      // The same clearance used by cache crews; only observed weapons, never unseen enemies or unknown terrain.
      const radius = stats.range + 3, bit = e.kind === 'digger' ? RIVAL_DIGGER : ARMED;
      for (let y = Math.max(0, Math.floor(e.y - radius)); y <= Math.min(this.size - 1, Math.floor(e.y + radius)); y++) for (let x = Math.max(0, Math.floor(e.x - radius)); x <= Math.min(this.size - 1, Math.floor(e.x + radius)); x++) {
        // Within the diamond |dx| + |dy| ≤ radius the distance is too (no root needed); beyond it, measure.
        const dx = x + 0.5 - e.x, dy = y + 0.5 - e.y;
        if (Math.abs(dx) + Math.abs(dy) <= radius || norm(dx, dy) <= radius) this.danger[y * this.size + x]! |= bit;
      }
    }
    this.flood(RIVAL_DIGGER | ARMED, this.safe, this.served);
    this.flood(ARMED, this.crewSafe, this.crewServed);
    // The four frame-ordered expansions below inline `step` (canonical direction j → world direction d) per neighbour.
    const grid = this.grid, len = grid.length, size = this.size, queue = this.queue, order = c.frame.cells();
    const k = c.frame.k, d0 = frameDir(k, 0), d1 = frameDir(k, 1), d2 = frameDir(k, 2), d3 = frameDir(k, 3);
    const danger = this.danger, blocked = this.blocked, safe = this.safe;
    // Distances are unique whatever the expansion order; every cell counts, known or not (a route may cross fog).
    const clearance = this.clearance;
    clearance.fill(-1);
    let tail = 0;
    for (let i = 0; i < len; i++) if (danger[i]) { clearance[i] = 0; queue[tail++] = i; }
    if (!tail) clearance.fill(len);
    for (let head = 0; head < tail; head++) {
      const cell = queue[head]!, x = cell % size;
      for (let j = 0; j < 4; j++) {
        const d = j === 0 ? d0 : j === 1 ? d1 : j === 2 ? d2 : d3;
        const n = d === 0 ? (x < size - 1 ? cell + 1 : -1) : d === 1 ? (x > 0 ? cell - 1 : -1) : d === 2 ? cell + size : cell - size;
        if (n < 0 || n >= len || clearance[n]! >= 0) continue;
        clearance[n] = clearance[cell]! + 1;
        queue[tail++] = n;
      }
    }
    // Safe return-to-dropoff next hops, shared by all workers. Moves follow them in runs (`dropRuns`) that a
    // cheapest route cannot bend through a weapon envelope elsewhere in the same open cavern.
    const dropNext = this.dropNext;
    dropNext.fill(-1);
    tail = 0;
    for (let i = 0; i < len; i++) {
      const cell = order[i]!;
      if (this.drops[cell] && safe[cell]) { dropNext[cell] = cell; queue[tail++] = cell; }
    }
    for (let head = 0; head < tail; head++) {
      const cell = queue[head]!, x = cell % size;
      for (let j = 0; j < 4; j++) {
        const d = j === 0 ? d0 : j === 1 ? d1 : j === 2 ? d2 : d3;
        const n = d === 0 ? (x < size - 1 ? cell + 1 : -1) : d === 1 ? (x > 0 ? cell - 1 : -1) : d === 2 ? cell + size : cell - size;
        if (n < 0 || n >= len || dropNext[n]! >= 0 || !safe[n]) continue;
        dropNext[n] = cell;
        queue[tail++] = n;
      }
    }
    // Multi-source escape goals are shared by every displaced worker, without crossing unknown terrain.
    const shelter = this.shelter, served = this.served;
    shelter.fill(-1);
    tail = 0;
    for (let i = 0; i < len; i++) {
      const cell = order[i]!;
      if (served[safe[cell]!]) { shelter[cell] = cell; queue[tail++] = cell; }
    }
    for (let head = 0; head < tail; head++) {
      const cell = queue[head]!, x = cell % size;
      for (let j = 0; j < 4; j++) {
        const d = j === 0 ? d0 : j === 1 ? d1 : j === 2 ? d2 : d3;
        const n = d === 0 ? (x < size - 1 ? cell + 1 : -1) : d === 1 ? (x > 0 ? cell - 1 : -1) : d === 2 ? cell + size : cell - size;
        if (n < 0 || n >= len || shelter[n]! >= 0 || !danger[n] || blocked[n]) continue;
        const g = grid[n]!;
        if (g !== TUNNEL && g !== RAIL && g !== BRIDGE) continue;
        shelter[n] = shelter[cell]!;
        queue[tail++] = n;
      }
    }
    // Flooded cells are impassable to ordinary routes, but occupants must be able to leave them.
    const escapeNext = this.escapeNext;
    escapeNext.fill(-1);
    tail = 0;
    for (let i = 0; i < len; i++) {
      const cell = order[i]!, g = grid[cell]!;
      if ((g === TUNNEL || g === RAIL || g === BRIDGE) && !blocked[cell]) { escapeNext[cell] = cell; queue[tail++] = cell; }
    }
    for (let head = 0; head < tail; head++) {
      const cell = queue[head]!, x = cell % size;
      for (let j = 0; j < 4; j++) {
        const d = j === 0 ? d0 : j === 1 ? d1 : j === 2 ? d2 : d3;
        const n = d === 0 ? (x < size - 1 ? cell + 1 : -1) : d === 1 ? (x > 0 ? cell - 1 : -1) : d === 2 ? cell + size : cell - size;
        if (n < 0 || n >= len || escapeNext[n]! >= 0 || blocked[n] || !isLava(grid[n]!)) continue;
        escapeNext[n] = cell;
        queue[tail++] = n;
      }
    }
  }

  /** The cell this army's frame means by point `p` (a cell edge resolves like its rotated twin's). */
  private cell(p: { x: number; y: number }): number { return this.frame!.pointCell(p.x, p.y); }

  /** The 4-neighbour of `at` in canonical direction k of the army's frame, or -1 off the map: rotated armies break ties alike. */
  private step(at: number, k: number): number {
    const d = frameDir(this.frame!.k, k), x = at % this.size;
    const n = d === 0 ? (x < this.size - 1 ? at + 1 : -1) : d === 1 ? (x > 0 ? at - 1 : -1) : d === 2 ? at + this.size : at - this.size;
    return n < this.grid.length ? n : -1;
  }

  /** Label the known open components clear of the `mask` danger bits, and which of them reach a drop-off. */
  private flood(mask: number, labels: Int32Array, served: Uint8Array): void {
    labels.fill(0);
    served.fill(0);
    const grid = this.grid, len = grid.length, size = this.size, queue = this.queue, blocked = this.blocked, danger = this.danger, drops = this.drops;
    let component = 0;
    for (let start = 0; start < len; start++) {
      if (labels[start] || blocked[start] || danger[start]! & mask) continue;
      const s = grid[start]!;
      if (s !== TUNNEL && s !== RAIL && s !== BRIDGE) continue;
      labels[start] = ++component;
      queue[0] = start;
      for (let head = 0, tail = 1; head < tail; head++) {
        const cell = queue[head]!;
        if (drops[cell]) served[component] = 1;
        const x = cell % size;
        for (let k = 0; k < 4; k++) {
          const n = k === 0 ? (x > 0 ? cell - 1 : -1) : k === 1 ? (x < size - 1 ? cell + 1 : -1) : k === 2 ? cell - size : cell + size;
          if (n < 0 || n >= len || labels[n] || blocked[n] || danger[n]! & mask) continue;
          const g = grid[n]!;
          if (g !== TUNNEL && g !== RAIL && g !== BRIDGE) continue;
          labels[n] = component;
          queue[tail++] = n;
        }
      }
    }
  }

  private touches(labels: Int32Array, component: number, cell: number, pocket = false): boolean {
    if (!component) return false;
    if (!pocket && isOpenCell(this.grid[cell]!)) return labels[cell] === component;
    const x = cell % this.size, y = Math.floor(cell / this.size), radius = pocket ? 2 : 1;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (pocket ? Math.max(Math.abs(dx), Math.abs(dy)) !== 2 || Math.min(Math.abs(dx), Math.abs(dy)) > 1 : Math.abs(dx) + Math.abs(dy) !== 1) continue;
      if (x + dx >= 0 && x + dx < this.size && y + dy >= 0 && y + dy < this.size && labels[(y + dy) * this.size + x + dx] === component) return true;
    }
    return false;
  }

  canServe(worker: Entity, cell: number, pocket = false, delivery = true): boolean {
    return this.canServeFrom(this.cell(worker), cell, pocket, delivery);
  }

  /** canServe for a worker standing on cell `from`. */
  canServeFrom(from: number, cell: number, pocket = false, delivery = true): boolean {
    const component = this.safe[from]!;
    return (!delivery || !!this.served[component]) && !this.danger[cell] && this.touches(this.safe, component, cell, pocket);
  }

  /** canServe for a Mother Lode crew member: rival diggers there are the lode's contest, not a reason to leave. */
  canCrew(worker: Entity, cell: number): boolean {
    const component = this.crewSafe[this.cell(worker)]!;
    return !!this.crewServed[component] && !(this.danger[cell]! & ARMED) && this.touches(this.crewSafe, component, cell);
  }

  /**
   * The farthest cell of the straight run of `field` next hops from `here` that one move may take (-1: no hop; `here`:
   * arrived). The simulation's cheapest route between the run's ends costs at most the run, and each cell entry costs
   * at least the cheapest entry, so that route keeps within (run cost − run cells) / 2 steps of the run: the run ends
   * before that band reaches observed danger. Travel is not throttled to one cell per decision.
   */
  private run(field: Int32Array, here: number): number {
    let end = field[here]!;
    if (end < 0 || end === here) return end;
    const direction = end - here;
    let cells = 1;
    let cost = this.grid[end] === CELL.rail ? this.railWeight : this.tunnelWeight;
    let clear = Math.min(this.clearance[here]!, this.clearance[end]!);
    for (let n = field[end]!; n !== end && n - end === direction; n = field[end]!) {
      const longer = cost + (this.grid[n] === CELL.rail ? this.railWeight : this.tunnelWeight);
      const nearest = Math.min(clear, this.clearance[n]!);
      if (longer - (cells + 1) >= 2 * nearest) break;
      end = n;
      cells++;
      cost = longer;
      clear = nearest;
    }
    return end;
  }

  /**
   * The run ends (`run`) from `here` along `field` to its goal, in order (empty: it stands on the goal; null: no route).
   * A worker walks them as one move and queued moves, so it never stands idle between two runs: the simulation hands an
   * idle digger straight to designation work, away from the route.
   */
  private runs(field: Int32Array, here: number): number[] | null {
    if (field[here]! < 0) return null;
    const hops: number[] = [];
    for (let at = here, end = this.run(field, at); end !== at; at = end, end = this.run(field, at)) hops.push(end);
    return hops;
  }

  /** The runs from cell `from` toward a dropoff along known-safe hops (null: none; empty: `from` is one). */
  dropRuns(from: number): number[] | null {
    return this.runs(this.dropNext, from);
  }

  /** The runs from cell `from` to the ore's safe working apron before issuing `mine` (null: none; empty: `from` is on
   * it): that intent is a proximity preference, not an exact target or a promise to use the safe component we found.
   * Reuses the last target's field. */
  oreRuns(from: number, cell: number, mineNear: number): number[] | null {
    if (cell !== this.workCell) {
      this.workCell = cell;
      this.workNext.fill(-1);
      let tail = 0;
      const x = cell % this.size;
      for (let k = 0; k < 4; k++) {
        const n = this.step(cell, k);
        if (n < 0 || !this.served[this.safe[n]!]) continue;
        // An equally close unsafe ore goal can win `mine near`'s tie; use another approach instead.
        let ambiguous = false;
        for (let j = 0; j < 4; j++) {
          const ore = this.step(n, j);
          if (ore >= 0 && isOreCell(this.grid[ore]!) && this.danger[ore]
            && norm(ore % this.size - x, Math.floor(ore / this.size) - Math.floor(cell / this.size)) <= mineNear) ambiguous = true;
        }
        if (!ambiguous) { this.workNext[n] = n; this.queue[tail++] = n; }
      }
      for (let head = 0; head < tail; head++) {
        const at = this.queue[head]!;
        for (let k = 0; k < 4; k++) {
          const n = this.step(at, k);
          if (n < 0 || this.workNext[n]! >= 0 || !this.safe[n]) continue;
          this.workNext[n] = at;
          this.queue[tail++] = n;
        }
      }
    }
    return this.runs(this.workNext, from);
  }

  /**
   * Whether a committed walk still holds against the danger observed now: every run still ahead that starts within
   * reach of the worker (the rest of the one in progress, `hops[next]`, from the worker's cell when it stands on that
   * run) stays clear of it, with WALK_HOLD_SLACK more clearance than `run` plans with, and, once the walk's end is within
   * reach, the last still ends in a component that reaches a dropoff (`drop`: on one). A delivery walk's reach is all of
   * it; a walk to ore looks ORE_HOLD_REACH cells ahead, so danger farther along is judged again as the worker nears it.
   * The worker's own cell may have turned dangerous: walking on is its way out. An `escape` walk's first leg, out of
   * danger to a shelter, is the simulation's to find and is not checked.
   */
  holds(worker: Entity, from: number, hops: readonly number[], next: number, drop: boolean, escape: boolean): boolean {
    const here = this.cell(worker), end = hops.at(-1) ?? from, reach = drop ? Infinity : ORE_HOLD_REACH;
    let walked = 0;
    for (let i = Math.max(escape ? 1 : 0, next); i < hops.length && walked <= reach; i++) {
      const start = i ? hops[i - 1]! : from, b = hops[i]!, a = i === next && this.onRun(start, b, here) ? here : start;
      if (!this.runHolds(a, b)) return false;
      walked += this.span(a, b);
    }
    return walked > reach || (!!this.served[this.safe[end]!] && (!drop || this.dropNext[end] === end));
  }

  /** The cells a walk has left for the worker on its run `hops[next]`, measured as `holds` measures them. */
  left(worker: Entity, from: number, hops: readonly number[], next: number): number {
    const here = this.cell(worker);
    let cells = 0;
    for (let i = Math.max(0, next); i < hops.length; i++) {
      const start = i ? hops[i - 1]! : from, b = hops[i]!;
      cells += this.span(i === next && this.onRun(start, b, here) ? here : start, b);
    }
    return cells;
  }

  /** Cells along the straight run from `a` to `b`. */
  private span(a: number, b: number): number {
    return Math.abs(b % this.size - a % this.size) + Math.abs(Math.floor(b / this.size) - Math.floor(a / this.size));
  }

  /** Whether cell `p` lies on the straight run from `a` to `b` (ends included). */
  private onRun(a: number, b: number, p: number): boolean {
    const ax = a % this.size, bx = b % this.size, px = p % this.size;
    const ay = Math.floor(a / this.size), by = Math.floor(b / this.size), py = Math.floor(p / this.size);
    return (ay === by && py === ay && (px - ax) * (px - bx) <= 0) || (ax === bx && px === ax && (py - ay) * (py - by) <= 0);
  }

  /** `run`'s test, WALK_HOLD_SLACK looser, for the straight run from `a` to `b`, over the cells past `a` (the worker
   * leaves `a`, or it ended the run before): each safe, and past one cell cost − cells < 2 × (clearance + slack). */
  private runHolds(a: number, b: number): boolean {
    const dx = b % this.size - a % this.size, dy = Math.floor(b / this.size) - Math.floor(a / this.size);
    if (dx && dy) return false;
    const step = Math.sign(dx) + Math.sign(dy) * this.size;
    let cells = 0, cost = 0, clear = Infinity;
    for (let n = a; n !== b;) {
      n += step;
      if (!this.safe[n]) return false;
      cells++;
      cost += this.grid[n] === CELL.rail ? this.railWeight : this.tunnelWeight;
      clear = Math.min(clear, this.clearance[n]!);
    }
    return cells <= 1 || cost - cells < 2 * (clear + WALK_HOLD_SLACK);
  }

  safePlan(path: readonly number[]): boolean {
    return path.every((cell) => !this.danger[cell]);
  }
}
