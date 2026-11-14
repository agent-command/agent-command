/** Plane transits: where units change planes, and the timed transfers between them. */
import { isOpenCell, type PlaneTransit, transitValue } from '../rules/contract.ts';
import { EMERGE_SEARCH } from '../sim/constants.ts';
import { Ent, NONE } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import { cellCentreX, cellCentreY, cellFor, cellOfEnt } from '../util/grid.ts';
import { sq } from '../util/math.ts';
import { type Army, rotCell, rotVX, rotVY } from '../util/teams.ts';

export class PlaneTransits {
  /**
   * Own built Shafts are the only Surface↔Depths portals (DESIGN: Portals): never the Spire root, a hole or an enemy
   * Shaft. One is usable unless sealed (`shaftSealed`).
   */
  shaftPortal(this: Sim, army: Army, s: Ent): boolean {
    return s.kind === 'shaft' && s.side === army && s.built && !s.dead && !this.shaftSealed(army, s);
  }

  /**
   * A Shaft's Depths landing (the cell below its centre) is sealed while `army` knows it as anything but open tunnel, or
   * knows no open tunnel orthogonally beside it. A Shaft completed in rock opens only its landing cell (diggers dig to
   * it); over bedrock it never opens. Team knowledge only (the Shaft's own Depths vision covers its landing), so a
   * `shaft_sealed` rejection or `sealed` flag never reveals hidden terrain; the orthogonal set is rotation-symmetric.
   */
  shaftSealed(this: Sim, army: Army, s: Ent): boolean {
    const known = this.armies[army]!.group.known;
    const size = this.size;
    const c = cellOfEnt(s, size);
    if (!isOpenCell(known[c]!)) return true;
    const x = c % size;
    const y = (c - x) / size;
    return !((x > 0 && isOpenCell(known[c - 1]!)) || (x < size - 1 && isOpenCell(known[c + 1]!))
      || (y > 0 && isOpenCell(known[c - size]!)) || (y < size - 1 && isOpenCell(known[c + size]!)));
  }

  /** Launchers validate the whole batch before paying, so a failed multi-unit order is atomic. */
  canTransit(this: Sim, e: Ent, transit: PlaneTransit): boolean {
    return e.plane === transit.from && !e.transitKind && e.transitReady <= this.tick
      && (!transit.kinds || transit.kinds.includes(e.kind))
      && (!transit.ability || this.hasAbility(e, transit.ability));
  }

  startTransit(this: Sim, e: Ent, transit: PlaneTransit, x = e.x, y = e.y): void {
    if (!this.spend(e.side, transitValue(transit.cost.alloy, this.econ), transitValue(transit.cost.energy, this.econ), e.plane)) return;
    const travel = transitValue(transit.prep, this.econ) + transitValue(transit.travel, this.econ);
    const stay = transitValue(transit.stay, this.econ);
    const cooldown = transitValue(transit.cooldown, this.econ);
    if (cooldown > 0) e.transitReady = this.tick + cooldown;
    if (travel === 0 && stay === 0) {
      // A portal step taken during the unit update lands once every unit has decided (Sim.landArrivals): units later
      // in the entity order must not lose sight of it before its rotated twins' observers do.
      if (this.deciding) this.arrivals.push({ e, transit, x, y });
      else this.arriveTransit(e, transit, x, y);
      return;
    }
    e.transitKind = transit;
    e.transitX = x;
    e.transitY = y;
    e.transitAt = this.tick + travel;
    e.transitUntil = stay > 0 ? e.transitAt + stay : 0;
    this.transits.add(e);
    this.order(e, NONE);
    if (transit.ability) this.revealAbility(e, transit.ability);
  }

  /** Portal steps taken during this tick's unit update, in the order they were taken. */
  landArrivals(this: Sim): void {
    for (const a of this.arrivals) if (!a.e.dead) this.arriveTransit(a.e, a.transit, a.x, a.y);
    this.arrivals.length = 0;
  }

  /** One arrival path serves immediate portals and timed column travel. */
  arriveTransit(this: Sim, e: Ent, transit: PlaneTransit, x: number, y: number): boolean {
    const army = e.side;
    const from = e.plane;
    if (transit.arrival === 'portal') {
      if (transit.to === 'depths') {
        let c = cellFor(e.frame, x, y, this.size);
        if (this.depthBodies[c]) {
          // Nearest free tunnel cell, scanned in the army's frame order (ties resolve alike for rotated units).
          let best = -1;
          let distance = Infinity;
          for (let i = 0; i < this.n; i++) {
            const n = rotCell(e.frame, i, this.size);
            if (this.depthBodies[n] || !isOpenCell(this.cells[n]!)) continue;
            const d = sq(cellCentreX(n, this.size) - x) + sq(cellCentreY(n, this.size) - y);
            if (d < distance) { best = n; distance = d; }
          }
          if (best < 0) return false;
          c = best;
        }
        if (!isOpenCell(this.cells[c]!)) return false;
        e.plane = transit.to;
        e.vx = e.vy = e.avx = e.avy = 0;
        e.x = cellCentreX(c, this.size);
        e.y = cellCentreY(c, this.size);
        e.cell = c;
      } else {
        // Emerge offset (+1, +1) × emergeOffset in the army's frame.
        const off = this.econ.emergeOffset;
        const spot = this.openSurfaceNear(x + rotVX(e.frame, off, off), y + rotVY(e.frame, off, off), EMERGE_SEARCH, army);
        if (!spot) return false;
        e.plane = transit.to;
        e.vx = e.vy = e.avx = e.avy = 0;
        e.cell = -1;
        e.x = spot.x;
        e.y = spot.y;
      }
    } else e.plane = transit.to;
    e.elevation = 0;
    e.skyIsland = 0;
    if (e.plane === 'sky') this.enterSky(e);
    // A column drop launched over open ground can come down in a hole opened beneath it meanwhile.
    if (transit.arrival === 'column' && e.plane === 'surface') {
      const c = cellOfEnt(e, this.size);
      if (this.holes[c]) this.settleOnHole(e, c);
    }
    if (transit.telegraph === 'portal') this.fxAdd('portal', from, x, y, army, false, { tp: e.plane, subject: e.kind, side: army });
    return true;
  }

  /** Timed transitions precede indexing; immediate portals retain their original unit-update slot. */
  updateTransits(this: Sim): void {
    for (const e of this.transits) {
      const transit = e.transitKind;
      if (e.dead || e.hp <= 0 || !transit) {
        this.transits.delete(e);
        continue;
      }
      if (transit.ability) this.revealAbility(e, transit.ability);
      if (e.transitUntil > 0 && this.tick >= e.transitUntil) {
        if (transit.return) e.plane = transit.return;
        e.elevation = 0;
        e.skyIsland = 0;
        if (e.plane === 'sky') this.enterSky(e);
        e.transitAt = 0;
        e.transitUntil = 0;
        e.transitKind = undefined;
        this.transits.delete(e);
        this.order(e, NONE);
      } else if (e.transitAt > 0 && this.tick >= e.transitAt) {
        this.arriveTransit(e, transit, e.transitX, e.transitY);
        e.transitAt = 0;
        if (!e.transitUntil) {
          e.transitKind = undefined;
          this.transits.delete(e);
        }
        this.order(e, NONE);
      }
    }
  }
}
