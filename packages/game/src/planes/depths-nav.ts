/** Depths navigation: tunnel paths, waypoint sighting and dig-through planning in each army's canonical frame. */
import { CELL, footprintDistance, isCellStructure, isDiggable, isLava, isOpenCell } from '../rules/contract.ts';
import { searchDepths } from '../nav/nav.ts';
import { type DepthsStep, GOAL_BESIDE, NAV_ARRIVED, NAV_AT_STOP, NAV_BLOCKED, NAV_MOVING, SIGHT_EPS, SNAP_EPS } from '../sim/constants.ts';
import { Ent } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import { adjacent4, cellCentreX, cellCentreY, cellFor, cellOf, cellOfEnt, clampPos, quantize } from '../util/grid.ts';
import { canonCell, canonX, canonY, rotCell } from '../util/teams.ts';
import { norm } from '../util/math.ts';

export class DepthsNav {
  /**
   * Depths path following. dig: diggers dig rock/ore/fortified (and enemy bulkheads) on the way. Returns NAV_MOVING
   * (moving or working), NAV_ARRIVED, NAV_BLOCKED, or NAV_AT_STOP when the next cell is `stopAt`.
   */
  followDepths(this: Sim, e: Ent, dig: boolean, stopAt = -1): DepthsStep {
    const path = e.path;
    if (!path) return NAV_BLOCKED;
    if (e.pathI >= path.length) return NAV_ARRIVED;
    const next = path[e.pathI]!;
    if (next === stopAt) return NAV_AT_STOP;
    if (this.depthBodies[next]) { e.path = null; return NAV_BLOCKED; }
    // Hostiles wait at a shield like a door; friendly traffic never lowers the stance.
    // Keep the route so it resumes when the wall comes down, without a replan storm.
    if ((this.wallCells[next]! & this.gateBit(e.side)) !== 0 && next !== e.cell) return NAV_MOVING;
    const code = this.cells[next]!;
    const gated = (this.gate[next]! & this.gateBit(e.side)) !== 0;
    const here = cellOfEnt(e, this.size);
    const escaping = isLava(this.cells[here]!);
    if (escaping && isLava(code) && path !== e.escapePath) {
      // Engulfed on a route planned over dry ground: replan to the same end cell, leaving the flood first.
      const end = path[path.length - 1]!;
      const out = searchDepths(this.cells, here, (c) => c === end, dig ? this.costs.dig : this.costs.walk, dig, Infinity, e.frame, this.armies[e.side]!.group.known, this.bars[e.side]!, this.size, this.cells);
      e.path = out;
      e.pathI = 0;
      e.escapePath = out;
      return out ? this.followDepths(e, dig, stopAt) : NAV_BLOCKED;
    }
    if ((!isOpenCell(code) && !(escaping && isLava(code))) || gated) {
      if (!dig || !this.capable(e, 'dig') || (!gated && !isDiggable(code))) {
        e.path = null;
        return NAV_BLOCKED;
      }
      // The damage lands with every other digger's once all units have decided (applyDigging).
      e.state = 'digging';
      if (e.digAt < 0) this.digging.push(e);
      e.digAt = next;
      return NAV_MOVING;
    }
    e.progress = -1;
    if (e.cell < 0) e.cell = cellOf(e.x, e.y, this.size);
    // Steer in a straight line to the farthest upcoming path cell in sight through open cells (string pulling); a
    // step that reaches the waypoint carries on toward the next one, so tunnels and rails give their full speed.
    const base = this.speedOf(e);
    let left = 1; // fraction of this tick still to move
    for (;;) {
      const w = this.depthsWaypoint(e, stopAt);
      const n = path[w]!;
      const v = base * (this.cells[path[e.pathI]!] === CELL.rail ? this.econ.railSpeed : this.econ.tunnelSpeed);
      const tx = cellCentreX(n, this.size);
      const ty = cellCentreY(n, this.size);
      const d = norm(tx - e.x, ty - e.y);
      if (d > v * left + SNAP_EPS) {
        // Quantize the step, not the sum: grid + grid is exact, so rotated walkers stay exactly rotated (rounding a
        // sum near 5 and its mirror near 43 can land one quantum apart).
        e.x = clampPos(e.x + quantize(((tx - e.x) / d) * v * left), this.size);
        e.y = clampPos(e.y + quantize(((ty - e.y) / d) * v * left), this.size);
        // A path cell the line passes through before the waypoint counts as reached. `cell` is the cell the unit stands
        // in (vision floods from it, sight of the unit tests it): a smoothed line crosses several cells between
        // waypoints, so the last path cell reached can lie far behind. The line runs through walkable cells only; the
        // guard keeps a quantum-off corner touch from parking the unit in rock.
        const c = cellFor(e.frame, e.x, e.y, this.size);
        for (let k = e.pathI; k < w; k++) if (path[k] === c) { e.pathI = k + 1; break; }
        if (c !== e.cell && (this.depthsOpen(c, this.gateBit(e.side)) || (escaping && isLava(this.cells[c]!)))) e.cell = c;
        return NAV_MOVING;
      }
      e.x = tx;
      e.y = ty;
      e.pathI = w + 1;
      e.cell = n;
      left -= d / v;
      if (e.pathI >= path.length) return NAV_ARRIVED;
      const after = path[e.pathI]!;
      // Rail layers stop on every bare tunnel cell to lay it.
      if (left <= 0 || after === stopAt || !this.depthsOpen(after, this.gateBit(e.side)) || (e.order.k === 'rail' && this.cells[n] === CELL.tunnel && !this.bulkheadAt[n])) return NAV_MOVING;
    }
  }

  /** Walkable cell for this army: open terrain, no hostile gate/shield, no structure body. */
  depthsOpen(this: Sim, c: number, bit: number): boolean {
    return isOpenCell(this.cells[c]!) && ((this.gate[c]! | this.wallCells[c]!) & bit) === 0 && !this.depthBodies[c];
  }

  /**
   * Index into `e.path` of the cell `e` steers to: the farthest of the next `depthsLookCells` walkable path cells in
   * a straight sight line. Cached until the path or the depths change; re-sighted once inside the carrot distance.
   */
  depthsWaypoint(this: Sim, e: Ent, stopAt: number): number {
    const path = e.path!;
    let lo = e.pathI;
    if (e.smoothPath === path && e.smoothVer === this.depthsStamp && e.smoothI >= e.pathI) {
      const n = path[e.smoothI]!;
      if (e.smoothNear || e.smoothI + 1 >= path.length || norm(cellCentreX(n, this.size) - e.x, cellCentreY(n, this.size) - e.y) > this.econ.depthsCarrot) return e.smoothI;
      lo = e.smoothI;
      e.smoothNear = true;
    } else e.smoothNear = false;
    const bit = this.gateBit(e.side);
    const end = Math.min(path.length, e.pathI + (e.order.k === 'rail' ? 1 : this.econ.depthsLookCells));
    let hi = lo;
    for (let k = e.pathI + 1; k < end; k++) {
      const c = path[k]!;
      if (c === stopAt || !this.depthsOpen(c, bit)) break;
      if (k > hi) hi = k;
    }
    let w = lo;
    for (let k = hi; k > lo; k--) if (this.depthsSight(e.x, e.y, path[k]!, e.frame, bit)) { w = k; break; }
    e.smoothPath = path;
    e.smoothVer = this.depthsStamp;
    e.smoothI = w;
    return w;
  }

  /**
   * Straight line from (x, y) to the centre of `goal` through walkable cells only: a supercover cell walk in the
   * army's canonical `frame` (rotated ties break alike) that crosses a corner diagonally only when both orthogonal
   * neighbours are open, so it never cuts through rock.
   */
  depthsSight(this: Sim, x: number, y: number, goal: number, frame: number, bit: number): boolean {
    const s = this.size;
    const x0 = canonX(frame, x, y, s);
    const y0 = canonY(frame, x, y, s);
    const g = canonCell(frame, goal, s);
    const gx = g % s;
    const gy = (g - gx) / s;
    let cx = Math.min(s - 1, Math.floor(x0));
    let cy = Math.min(s - 1, Math.floor(y0));
    const dx = gx + 0.5 - x0;
    const dy = gy + 0.5 - y0;
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const stepX = ax > 0 ? 1 / ax : Infinity;
    const stepY = ay > 0 ? 1 / ay : Infinity;
    let tX = ax > 0 ? (dx > 0 ? cx + 1 - x0 : x0 - cx) * stepX : Infinity;
    let tY = ay > 0 ? (dy > 0 ? cy + 1 - y0 : y0 - cy) * stepY : Infinity;
    for (let guard = Math.abs(gx - cx) + Math.abs(gy - cy); (cx !== gx || cy !== gy) && guard >= 0; guard--) {
      if (tX < tY - SIGHT_EPS) {
        cx += sx;
        tX += stepX;
      } else if (tY < tX - SIGHT_EPS) {
        cy += sy;
        tY += stepY;
      } else {
        // Through a corner: both cells beside it must be open.
        if (!this.depthsOpenAt(cx + sx, cy, frame, bit) || !this.depthsOpenAt(cx, cy + sy, frame, bit)) return false;
        cx += sx;
        cy += sy;
        tX += stepX;
        tY += stepY;
      }
      if (!this.depthsOpenAt(cx, cy, frame, bit)) return false;
    }
    return cx === gx && cy === gy;
  }

  /** depthsOpen for canonical-frame cell coordinates (off the map is closed). */
  depthsOpenAt(this: Sim, cx: number, cy: number, frame: number, bit: number): boolean {
    const s = this.size;
    return cx >= 0 && cy >= 0 && cx < s && cy < s && this.depthsOpen(rotCell(frame, cy * s + cx, s), bit);
  }

  /** Plan a depths path to `goal`; false if unreachable. Known magma blocks ordinary routes; an already-flooded
   * occupant may cross contiguous flowing magma to escape, but cannot re-enter it from dry ground. */
  planDepths(this: Sim, e: Ent, goal: number, dig: boolean): boolean {
    const army = e.side;
    // Between two cell centres, finish the step first: replanning from the cell it left can send the unit back, and two
    // chasers whose targets flip between cells would then swing back and forth forever. A newly known hostile gate
    // blocks that shortcut too; let the search route around it (or dig through it).
    // Off-centre, the unit is on a straight sight line to its smoothed waypoint: finish the step to it.
    const via = e.path && e.pathI < e.path.length && e.cell >= 0 && (e.x !== cellCentreX(e.cell, this.size) || e.y !== cellCentreY(e.cell, this.size)) ? e.path[e.smoothPath === e.path && e.smoothVer === this.depthsStamp && e.smoothI >= e.pathI ? e.smoothI : e.pathI]! : -1;
    const bar = this.bars[army]!;
    const transit = via >= 0 && !bar.solid?.[via] && isOpenCell(this.cells[via]!) && (bar.gate[via]! & bar.mask) === 0;
    // A move/portal aimed into a known body ends on its apron, not at an unreachable centre.
    const gx = cellCentreX(goal, this.size);
    const gy = cellCentreY(goal, this.size);
    let body: Ent | undefined;
    let shield = false;
    if (bar.solid?.[goal]) for (const s of this.ents) {
      if (s.dead || s.plane !== 'depths' || (s.side !== army && s.kind !== 'spire' && !this.sees(army, s))) continue;
      if (s.deploy !== 0 && this.deploySpec(s)?.blocksCell && cellOfEnt(s, this.size) === goal) { shield = true; break; }
      if (s.structure && !isCellStructure(s.kind) && footprintDistance(s.kind, s.x, s.y, gx, gy) === 0) { body = s; break; }
    }
    const start = cellOfEnt(e, this.size);
    const escape = isLava(this.cells[start]!);
    const path = searchDepths(this.cells, transit ? via : start, (c) => shield ? adjacent4(c, goal, this.size) && !bar.solid?.[c] : body ? footprintDistance(body.kind, body.x, body.y, cellCentreX(c, this.size), cellCentreY(c, this.size)) <= Math.SQRT1_2 && !bar.solid?.[c] : c === goal, dig ? this.costs.dig : this.costs.walk, dig, Infinity, e.frame, this.armies[army]!.group.known, bar, this.size, escape ? this.cells : null);
    if (escape) e.escapePath = path;
    if (path && transit) path.unshift(via);
    e.path = path;
    e.pathI = 0;
    e.navGoal = goal;
    return path !== null;
  }

  /** Plan a (digging) path for `e` to a tunnel cell beside `c`, to work on `c` from there; false if none. */
  planBeside(this: Sim, e: Ent, c: number): boolean {
    const army = e.side;
    const bit = this.gateBit(army);
    const isGoal = (n: number): boolean => n !== c && isOpenCell(this.cells[n]!) && (this.gate[n]! & bit) === 0 && adjacent4(n, c, this.size);
    e.path = searchDepths(this.cells, cellOfEnt(e, this.size), isGoal, this.costs.dig, false, Infinity, e.frame, this.armies[army]!.group.known, this.bars[army]!, this.size);
    e.pathI = 0;
    e.navGoal = GOAL_BESIDE;
    return e.path !== null;
  }
}
