/** Depths plane: digging, cracks, pockets, magma floods, charges, lodes and bulkheads. */
import {
  ALERT_COUNT_CAP,
  CELL,
  crackStage,
  footprintDistance,
  isDiggable,
  isOpenCell,
  isLava,
  isOreCell,
  lavaBridgeable,
  LODE_PRESSURE_MAX,
  MAX_ARMIES,
  type Plane,
  TICK_RATE,
} from '../rules/contract.ts';
import { LODE_POCKET, LODE_SEAL } from '../maps/world.ts';
import { canonicalDimensions } from '../maps/document.ts';
import { type Army, armyBit, canonCell, frameDir, isArmy, NEUTRAL, rotCell, rotVX, rotVY, sectorOf, type SideId } from '../util/teams.ts';
import { diggerCarryMax } from '../rules/economy.ts';
import { ACCOUNT_REFUND, BREAKOUT_SEARCH, HOLE, INTRUDER_REALERT, PLANE_INDEX, SNAP_EPS } from '../sim/constants.ts';
import { Ent } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import type { Charge, Flood, FxRec, LodeState, QueueEntry } from '../sim/state.ts';
import { cellCentreX, cellCentreY, cellOf, cellOfEnt } from '../util/grid.ts';
import { norm, sq } from '../util/math.ts';

/** applyDigging scratch: this tick's diggers on one cell, per army. */
const diggersOf = new Int32Array(MAX_ARMIES);
/** watchIntruders scratch: the nearest intruder's cell centre. */
const intruderAt = { x: 0, y: 0 };
/** Cells a flood spreads into: tunnels and rails, never a lava bridge (lake under it) or anything solid. */
const isFloodable = (code: number): boolean => code === CELL.tunnel || code === CELL.rail;

export class DepthsPlane {
  /** Cells within Chebyshev distance `r` of cell `c` (row by row; clipped to the map). */
  lodeCells(this: Sim, c: number, r: number): number[] {
    const x = c % this.size;
    const y = Math.floor(c / this.size);
    const out: number[] = [];
    for (let yy = Math.max(0, y - r); yy <= Math.min(this.size - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(this.size - 1, x + r); xx++) out.push(yy * this.size + xx);
    return out;
  }

  /** Ticks of digging solid cell `c` needs (fortified cells: + reinforceTicks per reinforce). */
  digNeed(this: Sim, c: number): number {
    const code = this.cells[c];
    const need = code === CELL.rock ? this.econ.digRock : code === CELL.ore ? this.econ.digOre : code === CELL.rich ? this.econ.digRich : this.econ.digFortified + this.tough[c]! * this.econ.reinforceTicks;
    return Math.max(1, need);
  }

  /** Crack stage (0..CRACK_STAGES) of cell `c` now: dig damage on a solid cell. */
  crackAt(this: Sim, c: number): number {
    return isDiggable(this.cells[c]!) ? crackStage(this.work[c]!, this.digNeed(c)) : 0;
  }

  /** Gate bit of the cells that block `side`'s units (bulkheads of armies hostile to it): its army bit, 0 for neutral. */
  gateBit(this: Sim, side: SideId): number {
    return isArmy(side) ? armyBit(side) : 0;
  }

  /**
   * Slot whose sector holds cell `c` (by its centre, never on a sector edge): ties with no deciding army resolve from
   * it, so they rotate with the map. On C2 maps sector 0 is the low-y half, i.e. `c < n / 2`.
   */
  cellSector(this: Sim, c: number): number {
    return sectorOf(cellCentreX(c, this.size), cellCentreY(c, this.size), this.size, this.sides);
  }

  /** The live bulkhead on cell `c`, if any. */
  bulkheadOn(this: Sim, c: number): Ent | undefined {
    return this.bulkheadAt[c] ? this.alive(this.bulkheadAt[c]!) : undefined;
  }

  /**
   * Cell `c` changes kind (dug, flooded, holed, fortified …): its dig damage and reinforces go, and ore it still held in
   * a lode pocket leaves the pocket's count.
   */
  resetCell(this: Sim, c: number): void {
    this.depthsVersion++;
    this.work[c] = 0;
    this.digBy[c] = 0;
    this.tough[c] = 0;
    const l = this.lodeAt[c]!;
    if (l >= 0 && this.ore[c]! > 0) this.lodes[l]!.left -= this.ore[c]!;
  }

  /**
   * Bulkheads `army`'s vision group knows of, as gate bits for validating orders (`Barrier.gate`): own and allied ones
   * pass, hostile ones it sees or remembers block the group's armies. Hidden bulkheads are left out, so intent results
   * never reveal them.
   */
  knownGate(this: Sim, army: Army, out: Uint8Array): Uint8Array {
    out.fill(0, 0, this.n);
    const g = this.armies[army]!.group;
    let members = 0;
    for (const a of g.armies) members |= armyBit(a);
    for (const e of this.ents) {
      if (e.kind !== 'bulkhead' || e.dead || !this.hostile(army, e.side)) continue;
      if (this.sees(army, e) || g.memory.has(e.id)) out[cellOfEnt(e, this.size)] = this.hostileMask[e.side]! & members;
    }
    for (const [id, ghost] of g.memory) if (ghost.kind === 'bulkhead' && !this.alive(id)) out[cellOf(ghost.x, ghost.y, this.size)] = this.hostileMask[ghost.side]! & members;
    return out;
  }

  /** A hidden magma pocket breaks at `c`: the whole pocket is spent and a flood starts there. */
  breakPocket(this: Sim, c: number, by: SideId): void {
    const id = this.magma[c]!;
    for (const e of this.ents) if (!e.dead && e.kind === 'geothermal' && e.pocket === id) e.coolAt = this.tick + this.econ.magmaCoolTicks;
    const dv = this.vis[PLANE_INDEX.depths]!;
    const byGroup = isArmy(by) ? this.armies[by]!.group : undefined;
    for (let i = 0; i < this.n; i++) {
      if (this.magma[i] !== id) continue;
      this.magma[i] = 0;
      for (const g of this.groups) if (g === byGroup || (dv[i]! & g.bit) !== 0) g.pocketKnown[i] = 0;
    }
    this.resetCell(c);
    this.cells[c] = CELL.magma;
    this.ore[c] = 0;
    this.owner[c] = 0;
    const x = cellCentreX(c, this.size);
    const y = cellCentreY(c, this.size);
    // The breaker's group, everyone through a public hole, and every group that sees the cell learn where it started.
    const told: Army[] = [];
    const knownAt = new Int32Array(MAX_ARMIES).fill(-1);
    for (const g of this.groups) {
      if (g !== byGroup && this.holes[c] === 0 && (dv[c]! & g.bit) === 0) continue;
      knownAt[g.id] = c;
      for (const a of g.armies) told.push(a);
    }
    this.floods.push({
      side: by,
      origin: c,
      cells: [c],
      limit: this.econ.magmaCells + 1,
      orbit: false,
      nextAt: this.tick + this.magmaStep,
      coolAt: this.tick + this.econ.magmaCoolTicks,
      knownAt,
    });
    this.fxAdd('magma', 'depths', x, y, by, false, { side: by });
    this.emit(told, 'magma_flood', 'depths', x, y, undefined, by);
    this.burnCaches(c);
  }

  /**
   * Magma just reached depths cell `c`: it burns the crater-ore share of every ore cache there (the Surface share is out
   * of its reach). Only the vision groups that see the cell now learn of it, so neither the fx nor the event is a fog
   * oracle; nobody is credited (caches are neutral loot).
   */
  burnCaches(this: Sim, c: number): void {
    if (!this.econ.magmaDestroysCaches) return;
    let burned = false;
    for (const cache of this.oreCaches) {
      if (cache.belowAlloy <= 0 || cellOf(cache.belowX, cache.belowY, this.size) !== c) continue;
      cache.belowAlloy = 0;
      cache.depthsHolder = NEUTRAL;
      cache.depthsTicks = 0;
      burned = true;
    }
    if (!burned) return;
    const x = cellCentreX(c, this.size);
    const y = cellCentreY(c, this.size);
    let viewers = 0;
    for (const army of this.allArmies) {
      if (!this.seesCell(army, 'depths', c)) continue;
      viewers |= this.armies[army]!.group.bit;
      this.emit([army], 'cache_burned', 'depths', x, y);
    }
    this.fxAdd('cache_burned', 'depths', x, y, NEUTRAL, false).viewers = viewers;
  }

  /**
   * Magma spreads one connected tunnel cell per step (a vent: one rotation orbit), burns depths units in it, then cools
   * to open tunnel (tunnels never close). Permanent lava lakes (CELL.lake) burn too and never cool; nobody is credited.
   */
  updateFloods(this: Sim): void {
    const keep: Flood[] = [];
    for (const f of this.floods) {
      if (this.tick >= f.coolAt) {
        // A vent's ring cools in public too: the groups that know the lode learn it (learnLodeRing).
        const knowers = f.orbit ? this.lodeKnowers() : 0;
        const ring = this.rules.map.motherLode.ringWidth;
        const dv = this.vis[PLANE_INDEX.depths]!;
        for (const c of f.cells) {
          if (this.cells[c] !== CELL.magma) continue;
          // Cooled magma is nobody's tunnel (owner 0) and plain tunnel: rails it buried are gone.
          this.cells[c] = CELL.tunnel;
          this.depthsVersion++;
          this.owner[c] = 0;
          const cool = this.fxAdd('cool', 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size), f.side, false, {});
          if (knowers === 0 || this.lodeDistance(c) > ring) continue;
          cool.viewers = knowers | dv[c]!;
          this.learnLodeRing(knowers, c);
        }
        continue;
      }
      keep.push(f);
      if (this.tick < f.nextAt) continue;
      const next = this.floodFront(f);
      if (next < 0 || f.cells.length >= f.limit) {
        f.nextAt = Infinity;
        continue;
      }
      // A vent floods the cell's whole rotation orbit (the cell itself first: rotation 0).
      for (let r = 0; r < (f.orbit ? this.sides : 1) && f.cells.length < f.limit; r++) {
        const c = rotCell(r * this.slotStep, next, this.size);
        if (!isFloodable(this.cells[c]!)) continue;
        this.floodCell(f, c);
      }
      f.nextAt = f.cells.length >= f.limit ? Infinity : f.nextAt + this.magmaStep;
    }
    this.floods = keep;
    const burn = this.econ.magmaDps / TICK_RATE;
    for (const e of this.ents) {
      if (e.dead || e.plane !== 'depths' || !e.unit) continue;
      const c = cellOfEnt(e, this.size);
      if (!isLava(this.cells[c]!)) continue;
      const f = this.cells[c] === CELL.lake ? undefined : keep.find((fl) => fl.cells.includes(c));
      this.damage(e, burn, f && this.hostile(f.side, e.side) ? f.side : NEUTRAL, false, 'flood');
    }
  }

  /** Magma reaches open cell `c` (flood `f`): render it (its `magma` fx, returned) and burn the caches there. */
  floodCell(this: Sim, f: Flood, c: number): FxRec {
    this.cells[c] = CELL.magma;
    this.depthsVersion++;
    f.cells.push(c);
    const fx = this.fxAdd('magma', 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size), f.side, false, {});
    this.burnCaches(c);
    return fx;
  }

  /**
   * The next walkable cell the flood reaches: breadth-first from its cells, in order, expanding neighbours in the frame
   * of the slot whose sector holds the origin (rotated floods spread rotated; a vent spreads in frame 0 and floods
   * whole orbits, so it stays symmetric by itself).
   */
  floodFront(this: Sim, f: Flood): number {
    const frame = f.orbit ? 0 : this.cellSector(f.origin) * this.slotStep;
    for (const c of f.cells) {
      const x = c % this.size;
      for (let k = 0; k < 4; k++) {
        const kk = frameDir(frame, k);
        const n = kk === 0 ? (x < this.size - 1 ? c + 1 : -1) : kk === 1 ? (x > 0 ? c - 1 : -1) : kk === 2 ? c + this.size : c - this.size;
        if (n >= 0 && n < this.n && isFloodable(this.cells[n]!)) return n;
      }
    }
    return -1;
  }

  /**
   * A sapper of `army` plants (or joins) a charge at `c`; `shaped`: its army has Shaped Charges (shorter fuse, longer
   * chasm). Returns the detonation tick.
   */
  plantCharge(this: Sim, army: Army, c: number, shaped = false): number {
    // A sapper arriving at a pending charge of its army (within chargeStackReach cells) joins it: one fuse, one
    // defuse, more damage (chargeDamage).
    const ox = c % this.size;
    const oy = Math.floor(c / this.size);
    const pending = this.charges.find((ch) => ch.side === army && Math.max(Math.abs((ch.c % this.size) - ox), Math.abs(Math.floor(ch.c / this.size) - oy)) <= this.econ.chargeStackReach);
    if (pending) {
      pending.stack++;
      return pending.at;
    }
    const at = this.tick + (shaped ? this.econ.shapedUndermineTicks : this.econ.undermineTicks);
    const g = this.armies[army]!.group;
    const ch: Charge = { side: army, c, at, defuse: 0, stack: 1, reach: shaped ? this.econ.shapedChasmReach : this.econ.chasmReach, known: g.bit };
    this.charges.push(ch);
    // Only the planter's team hears of it; others learn through noticeCharge (vision, tremors, the public window).
    this.emit(g.armies, 'charge_planted', 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size), 'sapper', army);
    this.noticeCharge(ch);
    return at;
  }

  /**
   * Vision groups that learn of charge `ch` now, each once (`charge_spotted`): with rules.depths.chargesFogged, those
   * whose Depths vision covers its cell or that feel a tremor there, and every group from at − chargePublicTicks;
   * without it, every group at once. Reads the last vision stamp, so it never knows more than the team's views.
   */
  noticeCharge(this: Sim, ch: Charge): void {
    const hidden = this.econ.chargesFogged && this.tick < ch.at - this.econ.chargePublicTicks;
    const senses = hidden ? this.vis[PLANE_INDEX.depths]![ch.c]! | this.feel[ch.c]! : -1;
    for (const g of this.groups) {
      if ((ch.known & g.bit) !== 0 || (senses & g.bit) === 0) continue;
      ch.known |= g.bit;
      this.emit(g.armies, 'charge_spotted', 'depths', cellCentreX(ch.c, this.size), cellCentreY(ch.c, this.size), 'sapper', ch.side);
    }
  }

  /** Every pending charge's new knowers (after each vision stamp and each tick, for the public window). */
  noticeCharges(this: Sim): void {
    for (const ch of this.charges) this.noticeCharge(ch);
  }

  /**
   * Hostile Depths units `army`'s team sees standing in or beside `army`'s own tunnels within intruderRadius tiles
   * (footprint edge) of one of its Depths structures, Shafts, Headframes or Spire segments. Returns how many; `at` gets
   * the cell centre of the one nearest such a structure (ties in `army`'s frame order). Own vision and own tunnels
   * only, so fog-safe; allocation-free.
   */
  intruders(this: Sim, army: Army, at: { x: number; y: number }): number {
    const r = this.econ.intruderRadius;
    const mine = armyBit(army);
    const frame = this.armyFrame[army]!;
    let count = 0;
    let best = Infinity;
    let bestKey = 0;
    for (const e of this.ents) {
      if (e.dead || !e.unit || e.plane !== 'depths' || !this.hostile(army, e.side) || !this.sees(army, e)) continue;
      const c = cellOfEnt(e, this.size);
      if (!this.ownedOpen(c, mine) && !this.bordersOwned(c, mine)) continue;
      let near = Infinity;
      for (const s of this.ents) {
        if (s.dead || s.side !== army || !s.structure || (s.plane !== 'depths' && s.kind !== 'spire' && s.kind !== 'shaft' && s.kind !== 'headframe')) continue;
        const d = footprintDistance(s.kind, s.x, s.y, e.x, e.y);
        if (d < near) near = d;
      }
      if (near > r + SNAP_EPS) continue;
      count++;
      const key = canonCell(frame, c, this.size);
      if (near < best - SNAP_EPS || (Math.abs(near - best) <= SNAP_EPS && key < bestKey)) {
        best = near;
        bestKey = key;
        at.x = cellCentreX(c, this.size);
        at.y = cellCentreY(c, this.size);
      }
    }
    return count;
  }

  /** After a vision stamp: a new intrusion near an army's home (none for INTRUDER_REALERT before) raises `intruder` to it. */
  watchIntruders(this: Sim): void {
    for (const a of this.allArmies) {
      const t = this.armies[a]!;
      const count = this.intruders(a, intruderAt);
      if (count === 0) continue;
      if (t.intruderAt < 0 || this.tick - t.intruderAt > INTRUDER_REALERT) this.emit([a], 'intruder', 'depths', intruderAt.x, intruderAt.y, undefined, undefined, { count: Math.min(ALERT_COUNT_CAP, count) });
      t.intruderAt = this.tick;
    }
  }

  /** Collapse damage of charge `ch`: each stacked sapper beyond the first adds chargeStackDamage of it, up to chargeStackMax sappers. */
  chargeDamage(this: Sim, ch: Charge): number {
    return this.econ.collapseDamage * (1 + this.econ.chargeStackDamage * (Math.min(ch.stack, this.econ.chargeStackMax) - 1));
  }

  updateCharges(this: Sim): void {
    if (this.charges.length === 0) return;
    const keep: Charge[] = [];
    for (const ch of this.charges) {
      const cx = cellCentreX(ch.c, this.size);
      const cy = cellCentreY(ch.c, this.size);
      this.noticeCharge(ch);
      // Defuse: any depths unit hostile to the planter within defuseReach cells, for defuseTicks in a row. The event
      // credits the defusing army; several present → the first in relative order from the planter (rotation-exact).
      let near = 0;
      for (const e of this.ents) {
        if (e.dead || e.plane !== 'depths' || !this.hostile(ch.side, e.side) || !e.unit) continue;
        if (Math.abs(Math.floor(e.x) + 0.5 - cx) <= this.econ.defuseReach && Math.abs(Math.floor(e.y) + 0.5 - cy) <= this.econ.defuseReach) near |= armyBit(e.side);
      }
      ch.defuse = near ? ch.defuse + 1 : 0;
      if (ch.defuse >= this.econ.defuseTicks) {
        let by = NEUTRAL;
        for (const b of this.allArmies) if (near & armyBit(b) && (by === NEUTRAL || this.rel(ch.side, b) < this.rel(ch.side, by))) by = b;
        // Told only to the teams that knew of it (the defuser stood on it): a hidden charge stays hidden from the rest.
        ch.known |= this.armies[by]!.group.bit;
        const told: Army[] = [];
        for (const a of this.allArmies) if ((ch.known & this.armies[a]!.group.bit) !== 0) told.push(a);
        this.emit(told, 'charge_defused', 'depths', cx, cy, 'sapper', ch.side, { killer: by });
        this.fxAdd('defuse', 'depths', cx, cy, ch.side, true, { side: ch.side }).viewers = ch.known;
        for (const e of this.ents) if (e.order.k === 'undermine' && e.side === ch.side && e.order.at === ch.at) this.clearOrder(e);
        continue;
      }
      if (this.tick < ch.at) {
        keep.push(ch);
        continue;
      }
      const reach = this.econ.collapseRadius + this.econ.collapseStructureReach;
      const dmg = this.chargeDamage(ch);
      for (const e of this.ents) {
        if (e.dead || !this.isStructure(e)) continue;
        if (e.plane === 'surface' && footprintDistance(e.kind, e.x, e.y, cx, cy) <= reach) this.damage(e, dmg, ch.side, true, 'collapse', 'depths', 'sapper');
        // A charge blows any bulkhead within chargeBulkheadReach cells of it.
        else if (e.kind === 'bulkhead' && Math.abs(e.x - cx) <= this.econ.chargeBulkheadReach + SNAP_EPS && Math.abs(e.y - cy) <= this.econ.chargeBulkheadReach + SNAP_EPS) this.damage(e, e.hp, ch.side, true, 'collapse', 'depths', 'sapper');
        // And any lava bridge within chargeBridgeReach: the span drops into its lake.
        else if (e.kind === 'lava_bridge' && Math.abs(e.x - cx) <= this.econ.chargeBridgeReach + SNAP_EPS && Math.abs(e.y - cy) <= this.econ.chargeBridgeReach + SNAP_EPS) this.damage(e, e.hp, ch.side, true, 'collapse', 'depths', 'sapper');
      }
      // The blast below: hostile Depths units near it are hurt and nearby fortified rock is stripped to plain rock
      // (a committed attack breaks walls). Cell centres and squared distances keep it rotation-exact.
      const strip = this.econ.chargeStripReach;
      const strip2 = strip * strip + SNAP_EPS;
      for (const e of this.ents) {
        if (e.dead || !e.unit || e.plane !== 'depths' || !this.hostile(ch.side, e.side)) continue;
        if (sq(e.x - cx) + sq(e.y - cy) <= strip2) this.damage(e, this.econ.chargeUnitDamage, ch.side, false, 'collapse', 'depths', 'sapper');
      }
      const x0 = Math.max(0, Math.floor(cx - strip));
      const x1 = Math.min(this.size - 1, Math.floor(cx + strip));
      for (let y = Math.max(0, Math.floor(cy - strip)); y <= Math.min(this.size - 1, Math.floor(cy + strip)); y++) {
        for (let x = x0; x <= x1; x++) {
          const n = y * this.size + x;
          if (this.cells[n] !== CELL.fortified || sq(x + 0.5 - cx) + sq(y + 0.5 - cy) > strip2) continue;
          this.resetCell(n);
          this.cells[n] = CELL.rock;
        }
      }
      this.armies[ch.side]!.stats.collapses++;
      if (this.faultOf[ch.c]! >= 0 && !this.holes[ch.c]) {
        // A charge under a fault splits it open along its length instead of caving in a round sinkhole.
        this.openChasm(ch.c, ch.side, ch.reach);
        continue;
      }
      this.emit(this.allArmies, 'collapse', 'surface', cx, cy, undefined, ch.side);
      this.fxAdd('collapse', 'surface', cx, cy, ch.side, true, { tp: 'depths', side: ch.side });
      this.openHoles(cx, cy, this.econ.collapseRadius, HOLE.sinkhole, ch.side);
    }
    this.charges = keep;
  }

  /**
   * Who builds bulkhead entry `e`: the hinted digger if free; else the nearest own digger that is idle or mining
   * (ties: lower creation serial, mirror-stable).
   */
  bulkheadBuilder(this: Sim, army: Army, e: QueueEntry): Ent | undefined {
    const hint = this.alive(e.digger);
    if (hint && hint.side === army && this.capable(hint, 'build') && hint.plane === 'depths' && hint.built && (hint.order.k === 'none' || hint.order.k === 'mine')) return hint;
    let best: Ent | undefined;
    let bd = Infinity;
    for (const d of this.ents) {
      if (d.dead || d.side !== army || !this.capable(d, 'build') || d.plane !== 'depths' || !d.built || (d.order.k !== 'none' && d.order.k !== 'mine')) continue;
      const dd = norm(d.x - e.x, d.y - e.y);
      if (dd < bd || (dd === bd && best && d.seq < best.seq)) {
        bd = dd;
        best = d;
      }
    }
    return best;
  }

  /** The funded bulkhead entry `e` goes to digger `d` (a miner picks its mining up again afterwards). */
  assignBulkhead(this: Sim, e: QueueEntry, d: Ent): void {
    const prev = d.order;
    e.digger = d.id;
    this.order(d, { k: 'bulkhead', c: cellOf(e.x, e.y, this.size), working: false, entry: e.id, geothermal: e.item === 'geothermal' });
    if (prev.k === 'mine') d.queue.push({ k: 'mine', ore: -1, exploring: false, near: prev.near, auto: prev.auto });
  }

  /** Bulkhead entry `entry` of `army` is done (its gate stands, or the work was refunded): it leaves the queue. */
  bulkheadDone(this: Sim, army: Army, entry: number): void {
    const i = this.queueIndexOf(army, entry);
    if (i >= 0) this.armies[army]!.queue.splice(i, 1);
  }

  /** The builder of bulkhead entry `entry` gave up (no path, or the cell stayed blocked): retry it later with any digger. */
  bulkheadRetry(this: Sim, army: Army, entry: number): void {
    const e = this.armies[army]!.queue[this.queueIndexOf(army, entry)];
    if (e) e.retry = this.tick + this.econ.bulkheadRetry;
  }

  /**
   * Beside its cell the builder of entry `entry` found the site unfit (an obstruction its army had not known): the
   * entry is refunded in full and cancelled with `code`. Working at the cell reveals that much, and no more; waiting
   * on knowledge instead could fund and fail the same unseen site forever.
   */
  bulkheadFailed(this: Sim, army: Army, entry: number, code: 'blocked' | 'occupied'): void {
    const t = this.armies[army]!;
    const i = this.queueIndexOf(army, entry);
    const e = t.queue[i];
    if (!e) return;
    if (e.started) {
      const s = this.stats[e.item as 'bulkhead' | 'geothermal'];
      t.alloy += s.alloy;
      t.energy += s.energy;
      this.account(army, ACCOUNT_REFUND, s.alloy, s.energy, e.by);
    }
    t.queue.splice(i, 1);
    this.queueEvent(army, 'queue_cancelled', e, e.by, i, undefined, code);
  }

  /**
   * A Headframe bores through a lode's seal: the outcrop cell below becomes a tunnel (its drop-off), the bedrock ring
   * becomes rock, so any army's diggers can now dig in and mine the pocket.
   */
  openLode(this: Sim, l: LodeState, army: Army): void {
    l.open = true;
    for (const n of this.lodeCells(l.c, LODE_SEAL)) {
      const ring = Math.max(Math.abs((n % this.size) - (l.c % this.size)), Math.abs(Math.floor(n / this.size) - Math.floor(l.c / this.size)));
      if (ring === LODE_SEAL && this.cells[n] === CELL.bedrock) {
        this.resetCell(n);
        this.cells[n] = CELL.rock;
      }
    }
    if (!isOpenCell(this.cells[l.c]!)) {
      this.resetCell(l.c);
      this.cells[l.c] = CELL.tunnel;
      this.ore[l.c] = 0;
    }
    this.owner[l.c] = army + 1;
    this.learnLode(l, army);
    this.emit([army], 'lode_opened', 'surface', cellCentreX(l.c, this.size), cellCentreY(l.c, this.size), 'headframe', army);
  }

  /**
   * `army`'s vision group sees lode `l`. Remember only what Surface vision revealed; opening a seal implies rock, not
   * its unseen current terrain.
   */
  learnLode(this: Sim, l: LodeState, army: Army): void {
    const g = this.armies[army]!.group;
    const bit = g.bit;
    if ((l.known & bit) === 0) {
      l.known |= bit;
      for (const n of this.lodeCells(l.c, LODE_POCKET)) if (n !== l.c) for (const a of g.armies) this.knownKeep[a]![n] = 1;
    }
    if (l.open && (l.seenOpen & bit) === 0) {
      const known = g.known;
      for (const n of this.lodeCells(l.c, LODE_SEAL)) if (known[n] === CELL.bedrock) { known[n] = CELL.rock; g.knownAt[n] = this.tick; }
    }
    l.seenOpen = l.open ? l.seenOpen | bit : l.seenOpen & ~bit;
  }

  /** Bulkheads stand in open tunnel only: one whose cell was flooded, filled or caved in is destroyed. */
  updateBulkheads(this: Sim): void {
    for (const e of this.ents) if (e.kind === 'bulkhead' && !e.dead && e.hp > 0 && !isOpenCell(this.cells[e.cell]!)) this.damage(e, e.hp, NEUTRAL, false, 'burial');
  }

  /** Build a finished bulkhead of `army` on tunnel cell `c` (its digger's work is done; dev tools spawn one directly). */
  placeBulkhead(this: Sim, army: Army, c: number, by?: Plane): Ent {
    const b = this.add('bulkhead', army, 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size));
    b.productionRole = by;
    b.cell = c;
    b.state = 'active';
    const t = this.armies[army]!;
    t.structures++;
    t.stats.bulkheads++;
    // It blocks every army hostile to its owner; allies pass.
    this.gate[c] = this.hostileMask[army]!;
    this.depthsVersion++;
    this.bulkheadAt[c] = b.id;
    // The gate hardens the rock beside it (its flanks in a corridor), so digging round it is slower.
    const x = c % this.size;
    for (const n of [x < this.size - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + this.size, c - this.size]) {
      if (n < 0 || n >= this.n) continue;
      for (let k = 0; k < this.econ.bulkheadFlankFortify && (this.cells[n] === CELL.rock || this.cells[n] === CELL.fortified); k++) this.fortifyCell(n);
    }
    this.emit([army], 'constructed', 'depths', b.x, b.y, 'bulkhead', army, by ? { owner: by } : undefined);
    return b;
  }

  /**
   * Rock cell `c` gains one fortify level: plain rock becomes fortified rock, fortified rock is reinforced
   * (+reinforceTicks dig time, up to fortifyLevels). Either way its cracks are repaired.
   */
  fortifyCell(this: Sim, c: number): void {
    if (this.cells[c] === CELL.fortified) {
      this.work[c] = 0;
      this.digBy[c] = 0;
      this.tough[c] = Math.min(this.econ.fortifyLevels, this.tough[c]! + 1);
      return;
    }
    this.resetCell(c);
    this.cells[c] = CELL.fortified;
    this.ore[c] = 0;
  }

  /** May a digger backfill (`bridge`) cell `c`: a hole whose kind rules.depths.backfillKinds allows (bit = HOLE code − 1)? */
  backfillable(this: Sim, c: number): boolean {
    const h = this.holes[c]!;
    return h !== 0 && ((this.econ.backfillKinds >> (h - 1)) & 1) === 1;
  }

  /** lavaBridgeable (rules/terrain.ts) on `cells` (the sim's truth, or a team's knowledge for admission) with this match's span. */
  lavaBridgeable(this: Sim, c: number, cells: Uint8Array): boolean {
    return lavaBridgeable(cells, c, this.size, this.econ.lavaBridgeSpan);
  }

  /**
   * Finished lava bridges (Sim.lavaBridged, army × n + cell) open now that every unit has decided. Two armies finishing
   * one cell on the same tick: it is built for the one whose slot comes first from the cell's sector, so the result
   * rotates with the map.
   */
  openLavaBridges(this: Sim): void {
    for (const key of this.lavaBridged) {
      const c = key % this.n, army = (key - c) / this.n;
      if (this.cells[c] !== CELL.lake) continue;
      const sector = this.cellSector(c);
      let best = army;
      for (const other of this.lavaBridged) {
        if (other % this.n !== c) continue;
        const a = (other - c) / this.n;
        if ((this.armySlot[a]! - sector + this.sides) % this.sides < (this.armySlot[best]! - sector + this.sides) % this.sides) best = a;
      }
      this.placeLavaBridge(c, best);
    }
    this.lavaBridged.length = 0;
  }

  /** Build a finished lava bridge of `army` over lake cell `c` (its diggers' work is done; dev tools place one directly). */
  placeLavaBridge(this: Sim, c: number, army: Army): Ent {
    const x = cellCentreX(c, this.size), y = cellCentreY(c, this.size);
    const b = this.add('lava_bridge', army, 'depths', x, y);
    b.cell = c;
    b.state = 'active';
    this.cells[c] = CELL.bridge;
    this.bridgeAt[c] = b.id;
    this.depthsVersion++;
    for (const a of this.allArmies) this.bridgeWork.delete(a * this.n + c);
    this.fxAdd('bridge', 'depths', x, y, army, false, { side: army, tp: 'depths' });
    this.emit([army], 'constructed', 'depths', x, y, 'lava_bridge', army);
    return b;
  }

  /** A lava bridge fell (combat, a charge, dev tools): its lake cell is lava again, under whatever stood on it. */
  collapseLavaBridge(this: Sim, e: Ent): void {
    if (this.bridgeAt[e.cell] !== e.id) return;
    this.bridgeAt[e.cell] = 0;
    this.cells[e.cell] = CELL.lake;
    this.owner[e.cell] = 0;
    this.depthsVersion++;
    this.fxAdd('magma', 'depths', e.x, e.y, NEUTRAL, false, {});
  }

  /**
   * Green rich ore as the map placed it (map.richOre on a generated map, RichOre entities on any document). With
   * map.richOre.knownAtStart every army knows those cells from the start: a public map feature (the lakes around them
   * stay hidden).
   */
  readRichOre(this: Sim): void {
    if (!this.rules.map.richOre.knownAtStart) return;
    for (let c = 0; c < this.n; c++) if (this.cells[c] === CELL.rich) for (const g of this.groups) g.known[c] = CELL.rich;
  }

  /**
   * The Mother Lode as the map placed it (map.motherLode on a generated map, MotherLode entities on any document):
   * every CELL.lode cell in orbit order, the canonical sector's in row-major order, each followed by its rotations.
   * With map.motherLode.knownAtStart every army knows those cells and everything within ringWidth of them (their
   * tunnel ring) from the start: public map features, never a hidden layer.
   */
  readMotherLode(this: Sim): void {
    const size = this.size;
    const { width, height } = canonicalDimensions(size, this.mapDocument.sides);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (this.cells[y * size + x] !== CELL.lode) continue;
      for (let r = 0; r < this.sides; r++) this.motherCells.push(rotCell(r * this.slotStep, y * size + x, size));
    }
    this.initMotherLode();
    const { knownAtStart, ringWidth } = this.rules.map.motherLode;
    if (!knownAtStart) return;
    for (const c of this.motherCells) {
      const x = c % size;
      const y = Math.floor(c / size);
      for (let dy = -ringWidth; dy <= ringWidth; dy++) for (let dx = -ringWidth; dx <= ringWidth; dx++) {
        const n = (y + dy) * size + x + dx;
        for (const g of this.groups) g.known[n] = this.cells[n]!;
      }
    }
  }

  /** Empty crew slots, full reserves and calm pressure for the Mother Lode cells in motherCells; called once they are placed. */
  initMotherLode(this: Sim): void {
    this.motherHolders = new Int32Array(this.motherCells.length * this.econ.motherLodeCrewPerCell);
    this.motherReserve = new Float64Array(this.motherCells.length).fill(this.econ.motherLodeLoads);
    this.lodeWindow = new Uint16Array(this.lodePressureOn() ? this.econ.lodeVentWindowTicks : 0);
  }

  /** Does this match's Mother Lode build pressure (rules.depths.lodePressureEnabled, and a lode on the map)? */
  lodePressureOn(this: Sim): boolean {
    return this.econ.lodePressureEnabled && this.motherCells.length > 0;
  }

  /** Is the Mother Lode cooling after a vent (public: nobody mines it until lodeCoolUntil)? */
  lodeCooling(this: Sim): boolean {
    return this.tick < this.lodeCoolUntil;
  }

  /** Is Mother Lode cell index `k` out of loads (finite motherLodeLoads only)? */
  motherEmpty(this: Sim, k: number): boolean {
    return this.econ.motherLodeLoads > 0 && this.motherReserve[k]! < 1;
  }

  /** Does every crew slot of Mother Lode cell index `k` hold a digger of `army`'s alliance (own knowledge: never a hidden enemy)? */
  motherFullForAlly(this: Sim, k: number, army: Army): boolean {
    const crew = this.econ.motherLodeCrewPerCell;
    for (let j = k * crew; j < (k + 1) * crew; j++) {
      const holder = this.motherHolders[j] ? this.alive(this.motherHolders[j]!) : undefined;
      if (holder === undefined || this.hostile(army, holder.side)) return false;
    }
    return true;
  }

  /**
   * Is Mother Lode cell index `k` an ore goal for `army`'s diggers: the lode not cooling after a vent (public), a crew
   * slot not taken by its alliance, and not seen out of loads right now (a reserve is only read while the army's
   * Depths vision covers the cell, so no hidden reserve steers a digger)?
   */
  motherOpenFor(this: Sim, k: number, army: Army): boolean {
    return !this.lodeCooling() && !this.motherFullForAlly(k, army) && !(this.motherEmpty(k) && this.seesCell(army, 'depths', this.motherCells[k]!));
  }

  /**
   * Digger `e` stands beside Mother Lode cell `c` to mine it. A cooling lode or a cell out of loads (it sees that from
   * beside it) sends it looking for other ore. Otherwise it claims the cell this tick; only crew-slot holders mine (a
   * load is ready every digOre × motherLodeDig and lands in resolveMotherLode). Without a slot it waits its turn (state
   * contested) unless every slot holds an playerthree: then it looks for other ore.
   */
  mineMotherLode(this: Sim, e: Ent, c: number): void {
    const k = this.motherCells.indexOf(c);
    const crew = this.econ.motherLodeCrewPerCell;
    let holds = false;
    for (let j = k * crew; j < (k + 1) * crew; j++) if (this.motherHolders[j] === e.id) holds = true;
    if (this.lodeCooling() || this.motherEmpty(k) || (!holds && this.motherFullForAlly(k, e.side as Army))) {
      e.workT = 0;
      e.progress = -1;
      e.path = null;
      return;
    }
    this.motherClaims.push(e);
    this.motherClaimCell.push(k);
    if (!holds) {
      e.workT = 0;
      e.progress = -1;
      e.state = 'contested';
      return;
    }
    e.state = 'mining';
    const need = Math.max(1, Math.round(this.econ.digOre * this.econ.motherLodeDig));
    if (e.workT < need) e.workT++;
    e.progress = e.workT / need;
  }

  /**
   * After every unit has decided, per Mother Lode cell: a holder that claimed its cell again keeps its slot; ready
   * holders get their loads (motherLodeAlloyPerLoad alloy each; while a finite reserve lasts, best-ranked first);
   * free slots go to claimants of the army ranked first from the slot whose sector holds the cell (as dig ties), then
   * the lowest serial; then the reserve regenerates. Then the tick's loads build pressure (lodePressureStep).
   */
  resolveMotherLode(this: Sim): void {
    const claims = this.motherClaims;
    const at = this.motherClaimCell;
    const crew = this.econ.motherLodeCrewPerCell;
    const need = Math.max(1, Math.round(this.econ.digOre * this.econ.motherLodeDig));
    const loads = this.econ.motherLodeLoads;
    const regen = this.econ.motherLodeRegen / TICK_RATE;
    const carryMax = diggerCarryMax(this.rules);
    let mined = 0;
    for (let k = 0; k < this.motherCells.length; k++) {
      const sector = this.cellSector(this.motherCells[k]!);
      const base = k * crew;
      for (let j = base; j < base + crew; j++) {
        const held = this.motherHolders[j]!;
        let kept = false;
        for (let i = 0; i < claims.length && !kept && held !== 0; i++) kept = at[i] === k && claims[i]!.id === held;
        if (!kept) this.motherHolders[j] = 0;
      }
      // Kept holders are alive (they claimed this tick); a newcomer has no load under way.
      while (loads === 0 || this.motherReserve[k]! >= 1) {
        let best: Ent | undefined;
        let bestRank = 0;
        for (let j = base; j < base + crew; j++) {
          const e = this.motherHolders[j] ? this.alive(this.motherHolders[j]!) : undefined;
          if (e === undefined || e.workT < need) continue;
          const rank = (this.armySlot[e.side as Army]! - sector + this.sides) % this.sides;
          if (!best || rank < bestRank || (rank === bestRank && e.seq < best.seq)) {
            best = e;
            bestRank = rank;
          }
        }
        if (!best) break;
        best.workT = 0;
        best.progress = -1;
        best.carry += this.econ.motherLodeAlloyPerLoad;
        mined++;
        if (loads > 0) this.motherReserve[k]!--;
        // The last load may carry it past diggerCarryMax; it hauls once it holds at least that.
        if (best.carry >= carryMax) best.path = null;
      }
      for (let j = base; j < base + crew; j++) {
        if (this.motherHolders[j] !== 0) continue;
        let best: Ent | undefined;
        let bestRank = 0;
        for (let i = 0; i < claims.length; i++) {
          if (at[i] !== k) continue;
          const e = claims[i]!;
          let holds = false;
          for (let h = base; h < base + crew; h++) if (this.motherHolders[h] === e.id) holds = true;
          if (holds) continue;
          const rank = (this.armySlot[e.side as Army]! - sector + this.sides) % this.sides;
          if (!best || rank < bestRank || (rank === bestRank && e.seq < best.seq)) {
            best = e;
            bestRank = rank;
          }
        }
        if (!best) break;
        this.motherHolders[j] = best.id;
      }
      if (loads > 0) this.motherReserve[k] = Math.min(loads, this.motherReserve[k]! + regen);
    }
    claims.length = 0;
    at.length = 0;
    if (this.lodePressureOn()) this.lodePressureStep(mined);
  }

  /**
   * This tick's `mined` Mother Lode loads (every army's: the pressure is shared) enter the vent window. Until it is
   * committed each adds lodePressurePerLoad and the pressure bleeds lodePressureBleed/s, never below 0; reaching
   * lodeCritical commits it (never while it cools): the vent is set for lodeFuseTicks later. Once committed nothing
   * changes that tick: the bleed stops and the pressure climbs in equal steps to LODE_PRESSURE_MAX at `lodeVentAt`,
   * when it vents (loads mined meanwhile still count toward the vent's size).
   */
  lodePressureStep(this: Sim, mined: number): void {
    const w = this.lodeWindow;
    const slot = this.tick % w.length;
    this.lodeRecent += mined - w[slot]!;
    w[slot] = mined;
    if (this.lodeVentAt > 0) {
      this.lodePressure += (LODE_PRESSURE_MAX - this.lodePressure) / (this.lodeVentAt - this.tick + 1);
      if (this.tick >= this.lodeVentAt) this.ventMotherLode();
      return;
    }
    this.lodePressure += mined * this.econ.lodePressurePerLoad;
    if (this.lodePressure >= this.econ.lodeCritical && !this.lodeCooling()) {
      this.lodePressure = Math.min(LODE_PRESSURE_MAX, this.lodePressure);
      this.lodeVentAt = this.tick + this.econ.lodeFuseTicks;
      if (this.econ.lodeFuseTicks === 0) this.ventMotherLode();
      return;
    }
    this.lodePressure = Math.max(0, this.lodePressure - this.econ.lodePressureBleed / TICK_RATE);
  }

  /**
   * The public `motherLode.rate` (pressure per second): while the fuse burns, its climb to the vent; before, the loads
   * mined over the last lodeVentWindowTicks at that pace, net of the bleed (what the crews do to the shared pressure).
   */
  lodePressureRate(this: Sim): number {
    if (this.lodeVentAt > 0) return ((LODE_PRESSURE_MAX - this.lodePressure) * TICK_RATE) / Math.max(1, this.lodeVentAt - this.tick);
    return (this.lodeRecent * this.econ.lodePressurePerLoad * TICK_RATE) / this.lodeWindow.length - this.econ.lodePressureBleed;
  }

  /** Vision-group bits of the groups that know a Mother Lode cell: its fuse, vent and ring are public to them. */
  lodeKnowers(this: Sim): number {
    let bits = 0;
    for (const g of this.groups) for (const c of this.motherCells) if (g.known[c] === CELL.lode) bits |= g.bit;
    return bits;
  }

  /** Chebyshev distance in cells from cell `c` to the nearest Mother Lode cell (Infinity without one). */
  lodeDistance(this: Sim, c: number): number {
    const x = c % this.size;
    const y = Math.floor(c / this.size);
    let d = Infinity;
    for (const l of this.motherCells) d = Math.min(d, Math.max(Math.abs((l % this.size) - x), Math.abs(Math.floor(l / this.size) - y)));
    return d;
  }

  /**
   * The Mother Lode vents (its fuse ran out). First the blast: lodeVentBlast damage to every Depths unit within the
   * ring plus lodeVentBlastReach (Chebyshev from each lode cell), nobody's (NEUTRAL: kills credit no army). Then every
   * open cell within the map's ringWidth of a lode cell turns to magma at once (whole rotation orbits, canonical cells
   * in row-major order) and the flood spreads on along connected tunnels, lodeVentBase + lodeVentPerLoad × the
   * window's loads cells (at most lodeVentMax), rounded down to whole orbits; it burns and cools like a pocket flood.
   * Pressure and the window reset and the lode cools (unminable) for lodeVentCooldownTicks.
   *
   * Knowledge: the vent and its ring are public to every group that knows a lode cell. Those groups see the ring's
   * magma in their Depths knowledge at once (the ring is public map structure; the spread beyond it is learnt by
   * sight), its `magma` fx and the eruption (`lode_vent` fx at each lode cell), and get event magma_flood at the vent's
   * first cell in their own frame; the rest locate the flood by sight (vision). Groups whose Depths vision covers a
   * blast cell get event lode_erupted at the lode cell nearest their Spire whose blast they saw.
   */
  ventMotherLode(this: Sim): void {
    const size = this.size;
    const sides = this.sides;
    const w = this.rules.map.motherLode.ringWidth;
    const spread = Math.floor(Math.min(this.econ.lodeVentMax, this.econ.lodeVentBase + this.econ.lodeVentPerLoad * this.lodeRecent) / sides) * sides;
    this.lodePressure = 0;
    this.lodeVentAt = 0;
    this.lodeRecent = 0;
    this.lodeWindow.fill(0);
    this.lodeCoolUntil = this.tick + this.econ.lodeVentCooldownTicks;
    const knowers = this.lodeKnowers();
    const dv = this.vis[PLANE_INDEX.depths]!;
    const reach = w + this.econ.lodeVentBlastReach;
    if (this.econ.lodeVentBlast > 0) {
      for (const e of this.ents) {
        if (e.dead || e.hp <= 0 || e.plane !== 'depths' || !e.unit || e.hangar) continue;
        if (this.lodeDistance(cellOfEnt(e, size)) <= reach) this.damage(e, this.econ.lodeVentBlast, NEUTRAL, false, 'eruption');
      }
    }
    // The eruption at each lode cell, for the groups that know the lode or see its blast.
    for (const l of this.motherCells) {
      let saw = 0;
      for (const c of this.lodeCells(l, reach)) saw |= dv[c]!;
      this.fxAdd('lode_vent', 'depths', cellCentreX(l, size), cellCentreY(l, size), NEUTRAL, false).viewers = knowers | saw;
    }
    for (const g of this.groups) {
      const home = this.spireAt[g.armies[0]!]!;
      const frame = this.armyFrame[g.armies[0]!]!;
      let at = -1;
      let atD = 0;
      for (const l of this.motherCells) {
        let seen = false;
        for (const c of this.lodeCells(l, reach)) seen ||= (dv[c]! & g.bit) !== 0;
        if (!seen) continue;
        const d = sq(cellCentreX(l, size) - home.x) + sq(cellCentreY(l, size) - home.y);
        if (at < 0 || d < atD || (d === atD && canonCell(frame, l, size) < canonCell(frame, at, size))) {
          at = l;
          atD = d;
        }
      }
      if (at >= 0) this.emit(g.armies, 'lode_erupted', 'depths', cellCentreX(at, size), cellCentreY(at, size));
    }
    const f: Flood = { side: NEUTRAL, origin: this.motherCells[0]!, cells: [], limit: 0, orbit: true, nextAt: this.tick + this.magmaStep, coolAt: this.tick + this.econ.magmaCoolTicks, knownAt: new Int32Array(MAX_ARMIES).fill(-1) };
    for (let k = 0; k < this.motherCells.length; k += sides) {
      const x = this.motherCells[k]! % size;
      const y = Math.floor(this.motherCells[k]! / size);
      for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        for (let r = 0; r < sides; r++) {
          const c = rotCell(r * this.slotStep, yy * size + xx, size);
          if (!isOpenCell(this.cells[c]!)) continue;
          this.floodCell(f, c).viewers = knowers | dv[c]!;
          this.learnLodeRing(knowers, c);
        }
      }
    }
    f.limit = f.cells.length + spread;
    if (spread === 0) f.nextAt = Infinity;
    this.floods.push(f);
    for (const g of this.groups) {
      if ((knowers & g.bit) === 0) continue;
      const frame = this.armyFrame[g.armies[0]!]!;
      let at = -1;
      let atKey = 0;
      for (const c of f.cells) {
        const key = canonCell(frame, c, size);
        if (at < 0 || key < atKey) {
          at = c;
          atKey = key;
        }
      }
      f.knownAt[g.id] = at;
      if (at >= 0) this.emit(g.armies, 'magma_flood', 'depths', cellCentreX(at, size), cellCentreY(at, size));
    }
  }

  /** Ring cell `c` of a vent changed (flooded or cooled): every group in `knowers` learns its code (public ring). */
  learnLodeRing(this: Sim, knowers: number, c: number): void {
    for (const g of this.groups) {
      if ((knowers & g.bit) === 0 || g.known[c] === this.cells[c]) continue;
      g.known[c] = this.cells[c]!;
      g.knownAt[c] = this.tick;
    }
  }

  /**
   * This tick's digging lands together, after every unit has decided: each digger adds one tick of damage to its cell
   * (1 / drillBitsDig with Drill Bits; several stack; the damage stays when they leave) or hits the hostile bulkhead
   * there. A cell at full damage opens:
   * the army that put in most of this tick's work owns the tunnel (ties: the slot whose sector holds the cell, then the
   * slots after it in order), and its lowest-serial empty-handed digger there takes an ore load from a dug ore cell.
   */
  applyDigging(this: Sim): void {
    const list = this.digging;
    if (list.length === 0) return;
    const bulk = this.stats.bulkhead.hp / this.econ.bulkheadDigTicks;
    // Drill Bits: a researched digger puts 1 / drillBitsDig ticks of work into the cell per tick.
    const drill = 1 / this.econ.drillBitsDig;
    for (const e of list) {
      const c = e.digAt;
      const b = (this.gate[c]! & this.gateBit(e.side)) !== 0 ? this.bulkheadOn(c) : undefined;
      if (b) this.damage(b, bulk, e.side, false, e.kind, e.plane);
      else if (isDiggable(this.cells[c]!)) {
        this.work[c]! += this.hasAbility(e, 'drill_bits') ? drill : 1;
        this.digBy[c]! |= armyBit(e.side);
      }
    }
    for (const e of list) {
      const c = e.digAt;
      if ((this.gate[c]! & this.gateBit(e.side)) !== 0) {
        const b = this.bulkheadOn(c);
        e.progress = b ? Math.min(1, Math.max(0, 1 - b.hp / b.maxHp)) : -1;
        continue;
      }
      if (!isDiggable(this.cells[c]!)) {
        e.progress = -1; // opened by an earlier digger in this list
        continue;
      }
      const need = this.digNeed(c);
      // Fractional Drill Bits work: SNAP_EPS absorbs float sums (30 × 4/3 must open a 40-tick cell).
      if (this.work[c]! + SNAP_EPS < need) {
        e.progress = this.work[c]! / need;
        continue;
      }
      diggersOf.fill(0);
      for (const d of list) if (d.digAt === c) diggersOf[d.side]!++;
      const sector = this.cellSector(c);
      let army = -1;
      let most = 0;
      let order = 0;
      for (const a of this.allArmies) {
        const count = diggersOf[a]!;
        if (count === 0) continue;
        const rank = (this.armySlot[a]! - sector + this.sides) % this.sides;
        if (count > most || (count === most && rank < order)) {
          army = a;
          most = count;
          order = rank;
        }
      }
      if (isOreCell(this.cells[c]!)) {
        let taker: Ent | undefined;
        for (const d of list) if (d.digAt === c && d.side === army && d.carry === 0 && (!taker || d.seq < taker.seq)) taker = d;
        if (taker) {
          taker.carry = this.cells[c] === CELL.rich ? this.econ.richLoad : this.econ.oreLoad;
          if (this.lodeAt[c]! >= 0) taker.lodeCarry = this.econ.oreLoad;
        }
      }
      for (const d of list) if (d.digAt === c) this.revealAbility(d, 'drill_bits');
      this.digCell(c, army);
    }
    for (const e of list) {
      if (e.digAt >= 0 && !isDiggable(this.cells[e.digAt]!) && (this.gate[e.digAt]! & this.gateBit(e.side)) === 0) e.progress = -1;
      e.digAt = -1;
    }
    list.length = 0;
  }

  /** `army` opens cell `c` into its tunnel (owner army + 1); meeting a hostile army's tunnel is a breach. */
  digCell(this: Sim, c: number, army: Army): void {
    if (this.magma[c]) {
      // Dug straight into a hidden magma pocket.
      this.breakPocket(c, army);
      return;
    }
    this.resetCell(c);
    this.cells[c] = CELL.tunnel;
    this.ore[c] = 0;
    for (const a of this.allArmies) this.railWork.delete(a * this.n + c);
    this.owner[c] = army + 1;
    const x = c % this.size;
    this.fxAdd('dig', 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size), army, false, { side: army, subject: 'digger' });
    for (const n of [x < this.size - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + this.size, c - this.size]) {
      if (n < 0 || n >= this.n) continue;
      const o = this.owner[n]!;
      if (isOpenCell(this.cells[n]!) && o !== 0 && this.hostile(army, o - 1)) {
        this.emit(this.allArmies, 'tunnel_breach', 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size), 'digger', army);
        this.fxAdd('breach', 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size), army, true, { side: army, subject: 'digger' });
        break;
      }
    }
  }

  /**
   * Breakouts finished this tick (Sim.breakouts, army × n + cell): their breach holes open and the troopers digging
   * there climb out beside them. This runs once every unit has decided from the start-of-tick surface: a hole one
   * army opened mid-update reached later units' planning (and their flow fields) before their rotated twins' did.
   * Every hole opens before anyone climbs out, so climb spots never depend on the order of the breakouts.
   */
  openBreakouts(this: Sim): void {
    if (this.breakouts.length === 0) return;
    for (const k of this.breakouts) {
      const army = Math.floor(k / this.n);
      const c = k - army * this.n;
      const x = cellCentreX(c, this.size);
      const y = cellCentreY(c, this.size);
      this.openCells([c], HOLE.breach, army);
      this.fxAdd('breakout', 'surface', x, y, army, true, { side: army, tp: 'depths', subject: 'trooper' });
      this.emit(this.allArmies, 'breach_opened', 'surface', x, y, 'trooper', army);
    }
    for (const k of this.breakouts) {
      const army = Math.floor(k / this.n);
      const c = k - army * this.n;
      // The canonical diagonal offset (+o, +o), turned into the army's frame.
      const o = this.econ.breakoutOffset;
      const frame = this.armyFrame[army]!;
      const sx = cellCentreX(c, this.size) + rotVX(frame, o, o);
      const sy = cellCentreY(c, this.size) + rotVY(frame, o, o);
      for (const u of this.ents) {
        if (u.dead || u.side !== army || u.plane !== 'depths' || u.order.k !== 'breach' || u.order.c !== c || cellOfEnt(u, this.size) !== c) continue;
        const spot = this.openSurfaceNear(sx, sy, BREAKOUT_SEARCH, army);
        this.clearOrder(u);
        if (!spot) continue;
        u.plane = 'surface';
        u.vx = u.vy = u.avx = u.avy = 0;
        u.cell = -1;
        u.x = spot.x;
        u.y = spot.y;
        u.state = 'idle';
        u.anchored = false;
      }
    }
    this.breakouts.length = 0;
  }

  /**
   * Current vision refreshes the cracks of `army`'s vision group; every unseen cell retains exactly its last-seen
   * stage. A seen crack holding hostile dig damage next to one of the group's own tunnel cells is remembered as a wall
   * dig (someone is digging in).
   */
  refreshCracks(this: Sim, army: Army): void {
    const g = this.armies[army]!.group;
    const bit = g.bit;
    const dv = this.vis[PLANE_INDEX.depths]!;
    let own = 0;
    for (const a of g.armies) own |= armyBit(a);
    const foe = this.hostileMask[army]!;
    for (let c = 0; c < this.n; c++) {
      if ((dv[c]! & bit) === 0) continue;
      const stage = this.crackAt(c);
      g.cracks[c] = stage;
      g.wallDig[c] = stage > 0 && (this.digBy[c]! & foe) !== 0 && this.bordersOwned(c, own) ? 1 : 0;
    }
  }

  /** Whether a cardinal neighbour of cell `c` is an open cell dug by an army in `armies` (army bits). */
  bordersOwned(this: Sim, c: number, armies: number): boolean {
    const size = this.size;
    const x = c % size;
    return (x < size - 1 && this.ownedOpen(c + 1, armies)) || (x > 0 && this.ownedOpen(c - 1, armies))
      || (c + size < this.n && this.ownedOpen(c + size, armies)) || (c >= size && this.ownedOpen(c - size, armies));
  }

  /** Is cell `c` open and dug by an army in `armies` (army bits; owner codes are army + 1)? */
  ownedOpen(this: Sim, c: number, armies: number): boolean {
    const o = this.owner[c]!;
    return o !== 0 && ((armies >> (o - 1)) & 1) === 1 && isOpenCell(this.cells[c]!);
  }

  /** Ticks of fortify work `e` needs on one cell: a digger's fortifyTicks, a Warden's wardenFortifySpeed times faster. */
  fortifyNeed(this: Sim, e: Ent): number {
    return Math.max(1, Math.ceil(e.kind === 'warden' ? this.econ.fortifyTicks / this.econ.wardenFortifySpeed : this.econ.fortifyTicks));
  }

  /**
   * Can Warden `e` of `army` throw a flare onto cell `c` by what its team knows: ready, a known open cell within
   * flareRange tiles (cell centre). Known open cells stay open (tunnels never close), so nothing hidden decides it.
   */
  flareError(this: Sim, e: Ent, c: number): 'blocked' | 'invalid_target' | null {
    if (e.kind !== 'warden' || !this.hasAbility(e, 'flare') || e.abilityReady > this.tick) return 'blocked';
    if (!isOpenCell(this.armies[e.side]!.group.known[c]!)) return 'invalid_target';
    const r = this.econ.flareRange;
    return sq(cellCentreX(c, this.size) - e.x) + sq(cellCentreY(c, this.size) - e.y) <= r * r + SNAP_EPS ? null : 'invalid_target';
  }

  /** Warden `e` throws a flare onto cell `c` (flareError passed): its team sees the lit tunnels at once (refreshVision). */
  throwFlare(this: Sim, e: Ent, c: number): void {
    const army = e.side as Army;
    e.abilityReady = this.tick + this.econ.flareCooldown;
    this.flares.push({ side: army, c, until: this.tick + this.econ.flareRevealTicks });
    this.revealAbility(e, 'flare');
    this.armies[army]!.stats.flares++;
    this.fxAdd('flare', 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size), army, false, { side: army, subject: 'warden', src: e.id });
    this.refreshVision();
  }

  /** Live flares light their tunnel floods for their army (stampVision); spent ones leave in place, allocation-free. */
  stampFlares(this: Sim): void {
    const flares = this.flares;
    let keep = 0;
    for (const f of flares) {
      if (f.until < this.tick) continue;
      flares[keep++] = f;
      this.floodVision(f.side, f.c, this.econ.flareRange);
    }
    flares.length = keep;
  }
}
