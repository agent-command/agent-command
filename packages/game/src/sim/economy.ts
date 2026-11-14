/** Economy: ore drop-off cells, digger mining trips, income, upkeep and the per-army accounting ledger. */
import {
  CELL,
  footprintDistance,
  isIslandStructure,
  isOpenCell,
  isOreCell,
  type Plane,
  STATS,
  TICK_RATE,
} from '../rules/contract.ts';
import { costField, descend, searchDepths } from '../nav/nav.ts';
import { diggerCarryMax } from '../rules/economy.ts';
import { cellCentreX, cellCentreY, cellOf, cellOfEnt } from '../util/grid.ts';
import { norm, sq } from '../util/math.ts';
import type { Army } from '../util/teams.ts';
import {
  ACCOUNT_BLOCK,
  ACCOUNT_INCOME,
  type AccountOffset,
  DEPLOY_UP,
  GOAL_HAUL,
  GOAL_ORE,
  INCOME_WINDOW_S,
  NAV_AT_STOP,
  NAV_BLOCKED,
  NAV_MOVING,
  PLANE_INDEX,
} from './constants.ts';
import { Ent } from './ent.ts';
import type { Sim } from './sim.ts';

export class SimEconomy {
  refreshDrops(this: Sim): void {
    for (const army of this.allArmies) {
      const t = this.armies[army]!;
      t.drop.fill(0);
      const p = this.spireAt[army]!;
      // The Spire root accepts ore only while the depths segment stands; Shafts always do.
      const rootAlive = t.spire.depths.hp > 0;
      const fw = STATS.spire.footprint!.w / 2;
      const fh = STATS.spire.footprint!.h / 2;
      for (let y = p.y - fh - 1; rootAlive && y <= p.y + fh; y++) {
        for (let x = p.x - fw - 1; x <= p.x + fw; x++) {
          const c = y * this.size + x;
          const d = footprintDistance('spire', p.x, p.y, x + 0.5, y + 0.5);
          if (isOpenCell(this.cells[c]!) && d > 0 && d <= Math.SQRT1_2) t.drop[c] = 1;
        }
      }
      for (const e of this.ents) if ((e.kind === 'shaft' || e.kind === 'headframe') && e.side === army && e.built && !e.dead) t.drop[cellOfEnt(e, this.size)] = 1;
    }
  }

  updateMine(this: Sim, e: Ent, o: { k: 'mine'; ore: number; exploring: boolean; near: number }): void {
    const army = e.side;
    const t = this.armies[army]!;
    const bar = this.bars[army]!;
    if (e.plane !== 'depths') return this.clearOrder(e);
    // Resuming/selecting work at a live own drop-off delivers preserved cargo first. An active
    // extraction path stays intact: mining beside the root still fills its normal load, not one trip per tick.
    if (e.carry > 0 && !e.path && t.drop[cellOfEnt(e, this.size)] === 1) e.navGoal = GOAL_HAUL;
    if (e.carry >= diggerCarryMax(this.rules) || (e.carry > 0 && e.navGoal === GOAL_HAUL)) {
      if (!e.path || e.navGoal !== GOAL_HAUL) {
        e.path = searchDepths(this.cells, cellOfEnt(e, this.size), (c) => t.drop[c] === 1, this.costs.dig, false, Infinity, e.frame, t.group.known, bar, this.size);
        e.pathI = 0;
        e.navGoal = GOAL_HAUL;
        if (!e.path) return this.clearOrder(e);
      }
      const r = this.followDepths(e, true);
      if (r === NAV_MOVING) {
        if (e.state !== 'digging') e.state = 'hauling';
        return;
      }
      if (r === NAV_BLOCKED || !t.drop[cellOfEnt(e, this.size)]) {
        e.path = null; // blocked, or the drop-off is gone (shaft or root destroyed): find another
        return;
      }
      this.fxAdd('deliver', 'depths', e.x, e.y, army, false, { side: army, subject: 'digger' });
      const k = this.earn(army, e.carry, 0, 'depths');
      t.tickIncome += e.carry * k;
      t.tickSurfaceIncome += e.lodeCarry * k;
      t.stats.alloyMined += e.carry * k;
      t.stats.lodeAlloy += e.lodeCarry * k;
      e.carry = 0;
      e.lodeCarry = 0;
      e.path = null;
      e.state = 'hauling';
      return;
    }
    const known = t.group.known;
    if (!e.path || e.navGoal !== GOAL_ORE) {
      let path: number[] | null = null;
      if (o.near >= 0) {
        // Ore near the asked-for point first (an opened lode pocket), else the nearest known ore.
        const nx = cellCentreX(o.near, this.size);
        const ny = cellCentreY(o.near, this.size);
        const reach = this.econ.mineNear;
        // Mother Lode cells only for an order pointed at one (the crew), unless generic mining may take them.
        const lode = this.econ.motherLodeAutoMine || known[o.near] === CELL.lode;
        const near = (c: number): boolean => (isOreCell(known[c]!) || (lode && known[c] === CELL.lode && this.motherOpenFor(this.motherCells.indexOf(c), army))) && norm(cellCentreX(c, this.size) - nx, cellCentreY(c, this.size) - ny) <= reach;
        path = searchDepths(this.cells, cellOfEnt(e, this.size), near, this.costs.dig, true, Infinity, e.frame, known, bar, this.size);
      }
      if (!path && t.oreFieldTick !== this.tick) {
        // Miners leave ore under every hostile Spire's guns alone (an eliminated army's Spire is gone).
        const keepOut = this.econ.mineKeepOut;
        for (let c = 0; c < this.n; c++) {
          // Generic mining leaves the Mother Lode to the crews ordered onto it (rules.depths.motherLodeAutoMine off):
          // otherwise every miner drifts to the endless centre once home ore thins. With it on, a lode cell counts while
          // a crew slot is open to the army and it does not see it out of loads (an enemy holder is met there).
          let goal = isOreCell(known[c]!) || (this.econ.motherLodeAutoMine && known[c] === CELL.lode && this.motherOpenFor(this.motherCells.indexOf(c), army)) ? 1 : 0;
          for (let a = 0; goal === 1 && a < this.armies.length; a++) {
            if (!this.hostile(army, a) || !this.inPlay(a)) continue;
            const foe = this.spireAt[a]!;
            const x = cellCentreX(c, this.size) - foe.x;
            const y = cellCentreY(c, this.size) - foe.y;
            if (!(x * x + y * y > keepOut * keepOut)) goal = 0;
          }
          t.oreGoal[c] = goal;
        }
        costField(this.cells, t.oreGoal, 1, this.costs.dig, t.oreField, e.frame, known, bar, this.size);
        t.oreFieldTick = this.tick;
      }
      path ??= descend(this.cells, t.oreField, t.oreGoal, 1, cellOfEnt(e, this.size), this.costs.dig, e.frame, known, bar, this.size);
      o.exploring = false;
      if (!path && e.carry > 0) {
        e.navGoal = GOAL_HAUL;
        e.path = null;
        return;
      }
      if (!path) {
        path = searchDepths(this.cells, cellOfEnt(e, this.size), (c) => known[c] === CELL.unknown, this.costs.dig, true, this.econ.mineExploreBudget, e.frame, known, bar, this.size);
        o.exploring = true;
      }
      if (!path) return this.clearOrder(e);
      e.path = path;
      e.pathI = 0;
      e.navGoal = GOAL_ORE;
      o.ore = path.length ? path[path.length - 1]! : cellOfEnt(e, this.size);
    }
    if (o.exploring) {
      const r = this.followDepths(e, true);
      if (r === NAV_MOVING) {
        if (e.state !== 'digging') e.state = 'moving';
        return;
      }
      e.path = null;
      return;
    }
    const r = this.followDepths(e, true, o.ore);
    if (r === NAV_MOVING) {
      if (e.state !== 'digging') e.state = 'moving';
      return;
    }
    if (r !== NAV_AT_STOP) {
      e.path = null;
      return;
    }
    if (this.cells[o.ore] === CELL.lode) return this.mineMotherLode(e, o.ore);
    const rich = this.cells[o.ore] === CELL.rich;
    if (!rich && this.cells[o.ore] !== CELL.ore) {
      e.path = null;
      return;
    }
    const ticks = rich ? this.econ.digRich : this.econ.digOre;
    e.state = 'mining';
    e.workT++;
    e.progress = e.workT / ticks;
    if (e.workT < ticks) return;
    e.workT = 0;
    e.progress = -1;
    if (this.ore[o.ore]! > 0) {
      e.carry += rich ? this.econ.richLoad : this.econ.oreLoad;
      const l = this.lodeAt[o.ore]!;
      if (l >= 0) {
        e.lodeCarry += this.econ.oreLoad;
        this.lodes[l]!.left--;
      }
      if (--this.ore[o.ore]! === 0) this.minedOut[this.minedOutCount++] = army * this.n + o.ore;
    }
    if (this.ore[o.ore] === 0 || e.carry >= diggerCarryMax(this.rules)) e.path = null;
  }

  /** Observational counters only; no RNG, event objects, or authoritative-state hash changes. */
  account(this: Sim, army: Army, offset: AccountOffset, alloy: number, energy: number, role?: Plane): void {
    const totals = this.armies[army]!.accounting;
    totals[offset]! += alloy;
    totals[offset + 1]! += energy;
    if (role !== undefined) {
      const seat = ACCOUNT_BLOCK + PLANE_INDEX[role] * ACCOUNT_BLOCK + offset;
      totals[seat]! += alloy;
      totals[seat + 1]! += energy;
    }
  }

  /**
   * Credit income to `army`'s stock and ledger, scaled by its income multiplier (rules.handicap.income): every income
   * source pays through here, never refunds. Returns the multiplier for the caller's own income counters (rates,
   * stats), so they count what was credited.
   */
  earn(this: Sim, army: Army, alloy: number, energy: number, role?: Plane): number {
    const k = this.incomeMultiplier[army]!;
    const t = this.armies[army]!;
    t.alloy += alloy * k;
    t.energy += energy * k;
    this.account(army, ACCOUNT_INCOME, alloy * k, energy * k, role);
    return k;
  }

  /** This tick's possible work, before shared-grid payment; never mines attachment-owned reserves. */
  extractorWork(this: Sim, e: Ent): number {
    if (e.kind !== 'ore_extractor' || e.dead || e.hp <= 0 || !e.built || this.econ.extractorRate <= 0) return 0;
    const island = this.alive(e.link);
    if (!island || island.kind !== 'island' || island.side !== e.side || island.hardpoint !== e.id) return 0;
    return Math.max(0, Math.min(this.econ.extractorRate / TICK_RATE, island.oreRemaining, this.econ.extractorBuffer - island.oreBuffer));
  }

  economy(this: Sim): void {
    for (const army of this.allArmies) {
      const t = this.armies[army]!;
      if (t.spire.surface.hp > 0) {
        // Losing the depths root halves the trickle (and ore can then only be delivered at Shafts).
        const trickle = (this.econ.spireAlloyRate / TICK_RATE) * (t.spire.depths.hp > 0 ? 1 : this.econ.rootlessTrickle);
        const k = this.earn(army, trickle, 0);
        t.tickIncome += trickle * k;
        t.tickSurfaceIncome += trickle * k;
      }
      // Headframes trickle alloy while their lode pocket has ore left.
      let frames = 0;
      for (const e of this.ents) if (e.kind === 'headframe' && e.side === army && e.built && !e.dead && (this.lodes[this.lodeAt[cellOf(e.x, e.y, this.size)]!]?.left ?? 0) > 0) frames++;
      if (frames > 0) {
        const lode = (frames * this.econ.headframeRate) / TICK_RATE;
        const k = this.earn(army, lode, 0);
        t.tickIncome += lode * k;
        t.tickSurfaceIncome += lode * k;
        t.stats.lodeAlloy += lode * k;
      }
      t.income[this.tick % t.income.length] = t.tickIncome;
      t.surfaceIncome[this.tick % t.surfaceIncome.length] = t.tickSurfaceIncome;
      t.tickSurfaceIncome = 0;
      t.tickIncome = 0;
      let solar = 0;
      // Taps are a fallback: they run at the healthy top-up rate while the own Orbit segment lives.
      const tapRate = t.spire.orbit.hp > 0 ? this.econ.geothermalHealthyRate : this.econ.geothermalRate;
      let relays = 0;
      let turrets = 0;
      let mooringUpkeep = 0;
      let mooringDebt = 0;
      let skyUpkeep = 0;
      let stormcatcher = 0;
      let geothermal = 0;
      for (const e of this.ents) {
        if (e.side !== army || e.dead) continue;
        if (e.kind === 'solar' && e.plane === 'orbit') solar += this.solarOutput(e, t.spire.orbit);
        else if (e.kind === 'relay' && e.built) relays++;
        else if (e.kind === 'turret' && e.built) turrets++;
        else if (e.kind === 'mooring_tower' && e.built && e.mooringTarget) {
          const island = this.alive(e.mooringTarget);
          if (island?.mooringTower === e.id && island.mooringPhase < 3) {
            mooringUpkeep += this.econ.mooringUpkeep;
            mooringDebt += e.mooringDebt;
          }
        }
        else if (e.built && e.kind === 'aerie') skyUpkeep += this.econ.aerieUpkeep;
        else if (e.kind === 'ore_extractor' && e.built && this.econ.extractorRate > 0) {
          // A final partial load pays only for its actual work; full/depleted buffers draw no upkeep.
          skyUpkeep += this.extractorWork(e) * TICK_RATE * this.econ.extractorUpkeep / this.econ.extractorRate;
        }
        // A Seeder draws upkeep only while its storm blows (not idle, not during the telegraph).
        else if (e.built && e.kind === 'storm_seeder' && e.activeUntil > this.tick && this.tick >= e.activeUntil - this.econ.seederDuration) skyUpkeep += this.econ.seederUpkeep;
        else if (e.built && e.kind === 'stormcatcher') stormcatcher += this.econ.stormcatcherRate * this.weather.strengthAt(e.x, e.y);
        else if (e.kind === 'geothermal' && e.built) {
          const rate = e.coolAt < 0 ? tapRate : this.tick < e.coolAt ? tapRate * this.econ.geothermalSurgeMultiplier : 0;
          geothermal += rate;
          e.state = rate > 0 ? 'active' : 'idle';
        }
      }
      t.solar = solar;
      // Relays augment the surviving delivery floor; local catchers and taps bypass it.
      t.cap = (t.spire.sky.hp > 0 ? this.econ.baseEnergyCap : this.econ.minimumEnergyCap) + this.econ.relayEnergyCap * relays;
      t.geothermal = geothermal;
      t.stormcatcher = stormcatcher;
      t.skyUpkeep = skyUpkeep;
      // Surplus above the cap charges the bank at solarBankRate; a gap below the cap draws it back out through the
      // cap, so Orbit delivery never exceeds the cap and the bank only shifts solar into dark or array-short ticks.
      if (solar > t.cap) {
        t.bankDischarge = 0;
        t.energyBank = Math.min(this.econ.solarBankMax, t.energyBank + ((solar - t.cap) * this.econ.solarBankRate) / TICK_RATE);
      } else if (t.energyBank * TICK_RATE <= t.cap - solar) {
        t.bankDischarge = t.energyBank * TICK_RATE;
        t.energyBank = 0;
      } else {
        t.bankDischarge = t.cap - solar;
        t.energyBank -= t.bankDischarge / TICK_RATE;
      }
      const raw = Math.min(solar, t.cap) + t.bankDischarge + geothermal + stormcatcher;
      const k = this.earn(army, 0, raw / TICK_RATE);
      t.delivered = raw * k;
      t.stats.energyDelivered += (raw / TICK_RATE) * k;
      // Structures share the army's energy grid: unpaid upkeep suspends all consuming effects.
      t.upkeep = turrets * this.econ.turretUpkeep + skyUpkeep + mooringUpkeep;
      const due = t.upkeep / TICK_RATE + mooringDebt;
      t.powered = this.payUpkeep(army, due);
      for (const e of this.ents) {
        if (e.side === army && !e.dead && e.built && e.kind === 'ore_extractor') {
          const amount = t.powered ? this.extractorWork(e) : 0;
          e.state = amount > 0 ? 'mining' : 'idle';
          if (amount > 0) {
            const island = this.alive(e.link)!;
            island.oreRemaining -= amount;
            island.oreBuffer += amount;
            // Repeated fractional ticks must not leave an undroppable tail at either finite boundary.
            if (island.oreRemaining < island.oreCapacity * 1e-10) island.oreRemaining = 0;
            if (this.econ.extractorBuffer - island.oreBuffer < this.econ.extractorBuffer * 1e-10) island.oreBuffer = this.econ.extractorBuffer;
          }
        }
        if (e.side === army && !e.dead && e.built && e.kind === 'mooring_tower') {
          const island = this.alive(e.mooringTarget);
          const holding = island?.mooringTower === e.id && island.mooringPhase < 3;
          e.state = holding && t.powered ? 'active' : 'idle';
          if (holding) {
            if (t.powered) e.mooringDebt = 0;
            else {
              e.mooringDebt += this.econ.mooringUpkeep / TICK_RATE;
              if (e.mooringGrace > 0) e.mooringGrace--;
              if (e.mooringGrace <= 0) this.releaseMooring(island);
            }
          }
        }
        if (e.side !== army || e.dead || !e.built || !isIslandStructure(e.kind)) continue;
        if (e.kind === 'aerie') e.state = t.powered ? 'active' : 'idle';
        else if (e.kind === 'storm_seeder') {
          if (!t.powered) e.activeUntil = 0;
          e.state = e.activeUntil > this.tick ? 'active' : 'idle';
        } else if (e.kind === 'stormcatcher') e.state = this.stormAt(e.x, e.y) ? 'active' : 'idle';
      }
    }
  }

  /**
   * One array's energy/s this tick (stored on it as `output`), advancing its exposure ramp: only anchored arrays
   * produce, at solarRate × light × ramp × distance × shade (rules/econ.ts). Packed, the ramp is lost.
   */
  solarOutput(this: Sim, e: Ent, segment: Ent): number {
    const ec = this.econ;
    if (e.deploy !== DEPLOY_UP || !e.built) {
      e.ramp = 0;
      e.output = 0;
      return 0;
    }
    e.ramp = ec.solarRampTime > 0 ? Math.min(1, e.ramp + 1 / ec.solarRampTime) : 1;
    e.output = ec.solarRate * (this.lit(e.x, e.y) ? 1 : ec.solarNight) * (ec.solarRampStart + (1 - ec.solarRampStart) * e.ramp)
      * this.solarDistance(e.x, e.y, segment) * this.solarShade(e.side, e.x, e.y, e.id);
    return e.output;
  }

  /** Distance share at (x, y) for an array of the army whose Orbit segment is `segment`. */
  solarDistance(this: Sim, x: number, y: number, segment: Ent): number {
    const ec = this.econ;
    const d = footprintDistance('spire', segment.x, segment.y, x, y);
    if (d <= ec.solarFullRange) return 1;
    if (d >= ec.solarFarRange) return ec.solarFarFactor;
    return 1 - ((1 - ec.solarFarFactor) * (d - ec.solarFullRange)) / (ec.solarFarRange - ec.solarFullRange);
  }

  /** Shade share at (x, y) from `army`'s other arrays (any state) within solarShadeRadius; `self`: the array there. */
  solarShade(this: Sim, army: Army, x: number, y: number, self = 0): number {
    const ec = this.econ;
    const r2 = ec.solarShadeRadius * ec.solarShadeRadius;
    let n = 0;
    for (const o of this.ents) {
      if (o.kind !== 'solar' || o.side !== army || o.dead || o.id === self || o.plane !== 'orbit') continue;
      if (sq(o.x - x) + sq(o.y - y) < r2) n++;
    }
    return Math.max(ec.solarShadeFloor, 1 - ec.solarShadePer * n);
  }

  alloyRate(this: Sim, army: Army): number {
    let s = 0;
    for (const v of this.armies[army]!.income) s += v;
    return s / INCOME_WINDOW_S;
  }

  surfaceAlloyRate(this: Sim, army: Army): number {
    let sum = 0;
    for (const v of this.armies[army]!.surfaceIncome) sum += v;
    return sum / INCOME_WINDOW_S;
  }
}
