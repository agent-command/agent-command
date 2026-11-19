/** Surface plane: holes and chasms opened into the depths, and the structures standing over a cell. */
import { CELL, footprintDistance, isLava, isOpenCell, isSurfaceBlocked, type Kind } from '../rules/contract.ts';
import { TRANSITS } from '../rules/stats.ts';
import { DEPLOY_UP, HOLE } from '../sim/constants.ts';
import { type Ent, NONE } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import { cellCentreX, cellCentreY, cellOf, cellOfEnt } from '../util/grid.ts';
import { type Army, canonCell, NEUTRAL, type SideId } from '../util/teams.ts';

/**
 * Frame of a crater's own map corner, whose row-major order its cells are walked in (so rotated craters agree).
 * C2: frame 0 when the mean cell index lies in the lower half, else 2 (the point mirror). C4: the quadrant of the
 * centroid. Doubled cell-centre offsets from the map centre are exact integers, and the half-open quadrants
 * {x < 0, y ≤ 0}, {x ≥ 0, y < 0}, {x > 0, y ≥ 0}, {x ≤ 0, y > 0} are quarter turns of each other, so a rotated crater
 * picks the rotated frame (a centred crater, a fixed point of every turn, takes frame 0).
 */
function craterFrame(cells: readonly number[], size: number, sides: number): number {
  if (sides === 2) {
    let sum = 0;
    for (const c of cells) sum += c;
    return sum * 2 < (size * size - 1) * cells.length ? 0 : 2;
  }
  let sx = 0;
  let sy = 0;
  for (const c of cells) {
    const x = c % size;
    sx += 2 * x + 1 - size;
    sy += 2 * ((c - x) / size) + 1 - size;
  }
  return sx < 0 && sy <= 0 ? 0 : sx >= 0 && sy < 0 ? 1 : sx > 0 && sy >= 0 ? 2 : sx <= 0 && sy > 0 ? 3 : 0;
}

export class SurfacePlane {
  /**
   * Does a surface structure stand over cell `c` (no breach there)? With `army`: only structures that army knows of
   * (its own, the Spires, other structures its vision group sees or remembers), so the answer leaks nothing through
   * the fog. Army 0 is a real army: omitted means `undefined`, never a falsy index.
   */
  structureOver(this: Sim, c: number, army?: Army): boolean {
    const x = cellCentreX(c, this.size);
    const y = cellCentreY(c, this.size);
    for (const s of this.ents) {
      if (s.dead || s.plane !== 'surface' || !s.structure || footprintDistance(s.kind, s.x, s.y, x, y) > 0) continue;
      if (army === undefined || s.side === army || s.kind === 'spire' || this.sees(army, s)) return true;
    }
    if (army !== undefined) for (const g of this.armies[army]!.group.memory.values()) if (g.plane === 'surface' && footprintDistance(g.kind, g.x, g.y, x, y) === 0) return true;
    return false;
  }

  /**
   * Open the cells within `radius` of (px, py), clipped to the map: cells past the edge are ignored, every in-bounds
   * cell (the rim too) opens as usual (cliffs never open).
   */
  openHoles(this: Sim, px: number, py: number, radius: number, kind: number, by: SideId): void {
    const r2 = radius * radius;
    const cells: number[] = [];
    const x0 = Math.max(0, Math.floor(px - radius));
    const x1 = Math.min(this.size - 1, Math.ceil(px + radius));
    for (let y = Math.max(0, Math.floor(py - radius)); y <= Math.min(this.size - 1, Math.ceil(py + radius)); y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        const c = y * this.size + x;
        if (dx * dx + dy * dy <= r2 && !isSurfaceBlocked(this.terrain[c]!)) cells.push(c);
      }
    }
    this.openCells(cells, kind, by);
  }

  /**
   * Turn surface cells into holes of `kind` (HOLE code) opened by `by`: impassable on the surface and no portal
   * (troopers `transfer` only at own Shafts), whose rock below becomes tunnel. Bedrock, the Mother Lode, lode pockets
   * and green rich ore stay solid, so a hole never empties a lode (a Headframe keeps paying until it is felled). A
   * hidden magma pocket below breaks and floods. Surface units standing on a new hole fall in or step off it
   * (settleOnHole); an ore cache on one moves to the nearest legal cell.
   */
  openCells(this: Sim, cells: readonly number[], kind: number, by: SideId): void {
    if (cells.length === 0) return;
    // The first magma cell met breaks its whole pocket and becomes the flood origin: walk the cells in the row-major
    // order of the crater's own map corner (see craterFrame), so rotated craters agree.
    const k = craterFrame(cells, this.size, this.sides);
    const ordered = [...cells].sort((a, b) => canonCell(k, a, this.size) - canonCell(k, b, this.size));
    for (const c of ordered) {
      if (!this.holes[c]) this.holeCount++;
      this.holes[c] = kind;
      this.holeBy[c] = by;
      this.block[c] = 1;
      for (const army of this.allArmies) this.surfaceNav[army]![c] = 1;
      const code = this.cells[c]!;
      if (this.magma[c]) this.breakPocket(c, by);
      else if (!isOpenCell(code) && !isLava(code) && code !== CELL.bedrock && code !== CELL.lode && code !== CELL.rich && this.lodeAt[c]! < 0) {
        this.resetCell(c);
        this.cells[c] = CELL.tunnel;
        this.ore[c] = 0;
      }
      for (const g of this.groups) if (g.known[c] !== this.cells[c]) { g.known[c] = this.cells[c]!; g.knownAt[c] = this.tick; }
    }
    for (const army of this.allArmies) this.refreshDesignations(this.armies[army]!);
    this.holesVersion++;
    for (const e of this.ents) {
      // A Trooper inside a Drill Yard is housed (hangar): the ground under the yard's doorstep does not take it.
      if (e.dead || e.plane !== 'surface' || !e.unit || e.hangar) continue;
      const c = cellOfEnt(e, this.size);
      if (this.holes[c]) this.settleOnHole(e, c);
    }
    // Placed caches sit off every hole, so one on a hole now stands on this event's ground: re-place it once here.
    for (const cache of this.oreCaches) {
      if (!cache.placed || !this.holes[cellOf(cache.x, cache.y, this.size)]) continue;
      cache.placed = false;
      this.placeOreCache(cache);
    }
  }

  /**
   * Surface unit `e` stands on hole cell `c` (one opened under it, or a drop or a Trooper leaving a Drill Yard that
   * came down on one). It falls only where the Depths cell below is open (tunnel, rail, bridge, lava or magma) with no
   * Depths structure on it. Over anything solid (bedrock, the Mother Lode, a lode pocket, rich ore) or built on it
   * steps off onto the nearest open Surface cell instead (searched in its own frame: rotated twins agree), never
   * standing trapped on impassable ground or inside a solid cell. A unit that can climb back out (TRANSITS.descend
   * kinds) loses fallDamage of its max HP, any other (vehicles) vehicleFallDamage; the hole's opener (holeBy) is
   * credited only when hostile, so a self-dug hole credits nobody. The fallen unit belongs to the Depths seat.
   */
  settleOnHole(this: Sim, e: Ent, c: number): void {
    e.vx = e.vy = e.avx = e.avy = 0;
    e.path = null;
    this.clearDeploy(e);
    const code = this.cells[c]!;
    if ((!isOpenCell(code) && !isLava(code)) || this.depthBodies[c] || this.bulkheadAt[c]) {
      const spot = this.openSurfaceNear(e.x, e.y, this.size, e.side);
      if (spot) {
        e.x = spot.x;
        e.y = spot.y;
      }
      return;
    }
    e.plane = 'depths';
    e.x = cellCentreX(c, this.size);
    e.y = cellCentreY(c, this.size);
    e.cell = c;
    e.order = NONE;
    e.aimTarget = 0;
    e.faceTarget = 0;
    e.queue = [];
    const climbs = (TRANSITS.descend.kinds as readonly Kind[]).includes(e.kind);
    const by = this.holeBy[c]!;
    this.damage(e, Math.ceil(e.maxHp * (climbs ? this.econ.fallDamage : this.econ.vehicleFallDamage)), this.hostile(by, e.side) ? by : NEUTRAL, false, 'fall');
    this.emit([e.side], 'fell_into_depths', 'depths', e.x, e.y, e.kind, e.side);
    this.fxAdd('portal', 'surface', e.x, e.y, e.side, false, { tp: 'depths', subject: e.kind, side: e.side });
  }

  /** Close a hole again (a bridged chasm): the surface there is walkable, the depths below stay as they are. */
  closeHole(this: Sim, c: number): void {
    if (!this.holes[c]) return;
    this.holes[c] = 0;
    this.holeBy[c] = NEUTRAL;
    this.holeCount--;
    this.block[c] = isSurfaceBlocked(this.terrain[c]!) ? 1 : 0;
    this.holesVersion++;
    for (const army of this.allArmies) this.refreshSurfaceFootprints(army);
    for (const army of this.allArmies) this.bridgeWork.delete(army * this.n + c);
  }

  /**
   * A charge on fault cell `c` splits the fault open: up to `reach` cells each way (the charge's chasmReach) become
   * chasm. The split stops short of a fault cell whose depths cell is fortified (fortify the fault near home before the
   * enemy cuts it).
   */
  openChasm(this: Sim, c: number, by: Army, reach = this.econ.chasmReach): void {
    const fault = this.faults[this.faultOf[c]!]!;
    const at = this.faultAt[c]!;
    let lo = at;
    let hi = at;
    while (lo > 0 && at - lo < reach && this.cells[fault[lo - 1]!] !== CELL.fortified) lo--;
    while (hi < fault.length - 1 && hi - at < reach && this.cells[fault[hi + 1]!] !== CELL.fortified) hi++;
    const cells = fault.slice(lo, hi + 1).filter((n) => !this.holes[n]);
    this.openCells(cells, HOLE.chasm, by);
    for (const n of cells) this.fxAdd('chasm', 'surface', cellCentreX(n, this.size), cellCentreY(n, this.size), by, true, { tp: 'depths', side: by });
    this.emit(this.allArmies, 'chasm_opened', 'surface', cellCentreX(c, this.size), cellCentreY(c, this.size), undefined, by);
  }

  /** Is `e` fully dug in (its kind's stance is `dug_in`, phase up)? Digging in and climbing out give no protection. */
  dugIn(this: Sim, e: Ent): boolean {
    return e.deploy === DEPLOY_UP && this.statsOf(e)?.deploy === 'dug_in';
  }
}
