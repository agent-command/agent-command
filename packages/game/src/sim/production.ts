/** Production: segment build queues, build-site validation, construction and structure placement. */
import type { IntentSource } from 'playerthree';
import {
  type BuildableKind,
  type BuildSiteError,
  CELL,
  type EventKind,
  footprintDistance,
  footprintOverlap,
  type GameError,
  inBuildRadius,
  isAircraft,
  inEnemySpireZone,
  isBuildableHardpoint,
  isIslandBuild,
  type IslandBuild,
  isOpenCell,
  isRadiusBound,
  isStatKind,
  isUnitKind,
  isUpgrade,
  type Kind,
  type Plane,
  PLANES,
  QUEUE_LIST,
  type QueueItem,
  type QueueReason,
  radiusExempt,
  TRANSITS,
  type StatKind,
  STRUCTURE_SPACING,
} from '../rules/contract.ts';
import { adjacent4, cellOf, cellOfEnt } from '../util/grid.ts';
import { type Army, frameDir, isArmy } from '../util/teams.ts';
import { ACCOUNT_REFUND, ACCOUNT_SPEND, PLANE_INDEX } from './constants.ts';
import { Ent } from './ent.ts';
import type { Sim } from './sim.ts';
import type { QueueEntry, SimEvent } from './state.ts';

/** The build-queue events (army-only notices of queue changes). */
type QueueEventKind = Extract<EventKind, `queue_${string}`>;

export class SimProduction {
  /** Count live Depths workers and viable paid replacements up to the recovery target; callers need only its deficit. */
  viableWorkers(this: Sim, army: Army): number {
    const target = this.econ.queueRecoveryWorkers;
    if (target <= 0) return 0;
    let count = 0;
    for (const e of this.ents) {
      if (!e.dead && e.hp > 0 && e.built && !e.hangar && !e.transitKind && e.side === army && e.kind === 'digger' && e.plane === 'depths' && ++count >= target) return count;
    }
    for (const e of this.armies[army]!.queue) {
      if (e.started && e.item === 'digger' && (e.producer ? this.validProducer(army, e.producer, e.item) : this.segmentAlive(army, e.plane)) && ++count >= target) return count;
    }
    return count;
  }

  /**
   * The only shared-bank availability calculation, used by admissions, production, abilities and work orders.
   * `from` is the entry being started (its own backing counts), or the seat making a direct spend: that seat may also
   * use its own lane's normal earmark, never another lane's or the recovery worker's (DESIGN §5). `operations`
   * (upkeep) skips the upkeep buffer.
   */
  available(this: Sim, army: Army, resource: 'alloy' | 'energy', from?: QueueEntry | Plane, operations = false): number {
    const t = this.armies[army]!;
    let held = 0, backing = 0;
    for (const e of t.queue) {
      if (e.started) continue;
      const amount = resource === 'alloy' ? e.heldAlloy : e.heldEnergy;
      held += amount;
      if (e === from || typeof from === 'string' && e.plane === from && !e.recovery) backing += amount;
    }
    const free = Math.max(0, t[resource] - held);
    const discretionary = resource === 'energy' && !operations ? Math.max(0, free - t.upkeep * this.econ.queueUpkeepSeconds) : free;
    // Already-backed work never has to save a second upkeep buffer before spending its own allocation.
    return Math.min(Math.max(0, t[resource] - held + backing), backing + discretionary);
  }

  canSpend(this: Sim, army: Army, alloy: number, energy: number, from?: QueueEntry | Plane): boolean {
    return this.available(army, 'alloy', from) >= alloy && this.available(army, 'energy', from) >= energy;
  }

  /**
   * Pay `own`'s start, or a direct cost of seat `by`: free stock first, then only that seat's own lane earmark.
   * Accounting goes to `by`.
   */
  spend(this: Sim, army: Army, alloy: number, energy: number, by?: Plane, own?: QueueEntry): boolean {
    const from = own ?? by;
    if (!this.canSpend(army, alloy, energy, from)) return false;
    const t = this.armies[army]!;
    if (own) { own.heldAlloy = 0; own.heldEnergy = 0; own.funding = false; own.recovery = false; }
    else if (by) {
      let alloyShort = alloy - this.available(army, 'alloy'), energyShort = energy - this.available(army, 'energy');
      for (const e of t.queue) {
        if (alloyShort <= 0 && energyShort <= 0) break;
        if (e.started || e.recovery || e.plane !== by) continue;
        const a = Math.min(e.heldAlloy, Math.max(0, alloyShort)), en = Math.min(e.heldEnergy, Math.max(0, energyShort));
        e.heldAlloy -= a;
        e.heldEnergy -= en;
        alloyShort -= a;
        energyShort -= en;
      }
    }
    t.alloy -= alloy;
    t.energy -= energy;
    this.account(army, ACCOUNT_SPEND, alloy, energy, by);
    return true;
  }

  /**
   * Shared-grid upkeep comes before earmarks (DESIGN §5): while the bank covers `due`, the army stays powered, and
   * any part free energy cannot cover is taken from unstarted holds in proportion, so no lane keeps stock locked
   * while its structures go dark.
   */
  payUpkeep(this: Sim, army: Army, due: number): boolean {
    const t = this.armies[army]!;
    if (t.energy < due) return false;
    const short = due - this.available(army, 'energy', undefined, true);
    if (short > 0) {
      let held = 0;
      for (const e of t.queue) if (!e.started) held += e.heldEnergy;
      // Multiply before dividing so whole-number holds stay exact.
      const left = Math.max(0, held - short);
      for (const e of t.queue) if (!e.started && held > 0) e.heldEnergy = e.heldEnergy * left / held;
    }
    t.energy -= due;
    this.account(army, ACCOUNT_SPEND, 0, due);
    return true;
  }

  /**
   * Select one normal commitment per canonical plane, plus at most one verified, requested recovery worker. A lane's
   * head is its first eligible entry whose producer is free; an entry waiting on a busy producer saves only while
   * nothing else in its lane can start (producers build in parallel). Backing never leaves its lane on a head change:
   * released holds move to the lane's new head, and only surplus beyond a full backing returns to the free bank.
   * Unblocked later entries wait for their lane's turn (`lane`); updateProduction still starts any of them that idle
   * free stock pays in full.
   */
  allocateQueue(this: Sim, army: Army): void {
    const t = this.armies[army]!, q = t.queue;
    const heads = this.laneHead, poolAlloy = this.laneAlloy, poolEnergy = this.laneEnergy;
    heads.fill(undefined);
    poolAlloy.fill(0);
    poolEnergy.fill(0);
    const workers = this.viableWorkers(army);
    const recovering = workers < this.econ.queueRecoveryWorkers;
    let recovery: QueueEntry | undefined, recoveryBusy: QueueEntry | undefined;
    for (const e of q) {
      e.funding = false;
      e.recovery = false;
      if (e.started) { e.heldAlloy = 0; e.heldEnergy = 0; continue; }
      const block = this.queueBlock(army, e, workers);
      const busy = !block && this.queueProducerBusy(army, e);
      e.status = block ? 'blocked' : 'waiting';
      e.reason = block ?? (busy ? 'producer' : 'funds');
      if (!block) e.blockedAt = -1;
      else {
        if (e.blockedAt < 0) e.blockedAt = this.tick;
        const pausedProducer = block === 'producer' && !!e.producer && this.validProducer(army, e.producer, e.item);
        const invalid = block === 'segment_destroyed' || block === 'not_held' || block === 'blocked' || block === 'producer' && !pausedProducer;
        if (invalid || !pausedProducer && this.tick - e.blockedAt >= this.econ.queueBlockedGrace) this.releaseHold(e);
      }
      if (recovering && e.item === 'digger' && (!block || e.heldAlloy > 0 || e.heldEnergy > 0)) {
        if (!busy) recovery ??= e;
        else recoveryBusy ??= e;
      }
    }
    recovery ??= recoveryBusy;
    if (recovery) { recovery.funding = true; recovery.recovery = true; }
    for (let p = 0; p < PLANES.length; p++) {
      const plane = PLANES[p]!;
      let busyHead: QueueEntry | undefined;
      for (const e of q) {
        if (e.started || e === recovery || e.plane !== plane || recovering && e.item === 'digger') continue;
        if (e.status === 'blocked' && e.heldAlloy === 0 && e.heldEnergy === 0) continue;
        if (e.status === 'waiting' && e.reason === 'producer') { busyHead ??= e; continue; }
        heads[p] = e;
        break;
      }
      heads[p] ??= busyHead;
      if (heads[p]) heads[p]!.funding = true;
    }
    for (const e of q) {
      if (e.funding || e.started) continue;
      this.releaseHold(e);
      if (e.status === 'waiting' && e.reason === 'funds') e.reason = 'lane';
    }
    for (let p = 0; p < PLANES.length; p++) {
      const head = heads[p] ?? (recovery?.plane === PLANES[p] ? recovery : undefined);
      if (!head) continue;
      const cost = this.queueStats(head.item, head.producer);
      head.heldAlloy += Math.min(poolAlloy[p]!, Math.max(0, cost.alloy - head.heldAlloy));
      head.heldEnergy += Math.min(poolEnergy[p]!, Math.max(0, cost.energy - head.heldEnergy));
    }
    this.allocateResource(army, 'alloy', recovery);
    this.allocateResource(army, 'energy', recovery);
  }

  /** Move `e`'s hold into its lane's scratch pool for allocateQueue to hand to the lane's head. */
  releaseHold(this: Sim, e: QueueEntry): void {
    const p = PLANE_INDEX[e.plane];
    this.laneAlloy[p] = this.laneAlloy[p]! + e.heldAlloy;
    this.laneEnergy[p] = this.laneEnergy[p]! + e.heldEnergy;
    e.heldAlloy = 0;
    e.heldEnergy = 0;
  }

  /** Equal-share water filling; saturated/idle lanes donate now, never accumulate inactivity credit. */
  allocateResource(this: Sim, army: Army, resource: 'alloy' | 'energy', recovery?: QueueEntry): void {
    const q = this.armies[army]!.queue;
    const key = resource === 'alloy' ? 'heldAlloy' : 'heldEnergy';
    const free = this.available(army, resource);
    let demand = 0;
    for (const e of q) if (e.funding && !e.recovery && e.status !== 'blocked') demand += Math.max(0, this.queueStats(e.item, e.producer)[resource] - e[key]);
    const recoveryNeed = recovery && recovery.status !== 'blocked' ? Math.max(0, this.queueStats(recovery.item, recovery.producer)[resource] - recovery[key]) : 0;
    const recoveryPart = Math.min(recoveryNeed, demand > 0 ? free * this.econ.queueRecoveryFraction : free);
    let left = free - recoveryPart;
    for (let pass = 0; pass < PLANES.length && left > 0; pass++) {
      let lanes = 0;
      for (const e of q) if (e.funding && !e.recovery && e.status !== 'blocked' && e[key] < this.queueStats(e.item, e.producer)[resource]) lanes++;
      if (!lanes) break;
      const share = left / lanes;
      let used = 0;
      for (const e of q) {
        if (!e.funding || e.recovery || e.status === 'blocked') continue;
        const cost = this.queueStats(e.item, e.producer)[resource];
        const add = Math.min(share, Math.max(0, cost - e[key]));
        e[key] = Math.min(cost, e[key] + add);
        used += add;
      }
      left = Math.max(0, left - used);
    }
    // Once all normal demand is satisfied its unused share is genuinely idle, not a recovery entitlement.
    if (recovery) recovery[key] += Math.min(recoveryNeed, recoveryPart + left);
  }

  /** A paid job already occupies `e`'s producer: `e` may save, but later entries for free producers go first. */
  queueProducerBusy(this: Sim, army: Army, e: QueueEntry): boolean {
    if (!isUnitKind(e.item) && !isUpgrade(e.item)) return false;
    for (const other of this.armies[army]!.queue) {
      if (!other.started) continue;
      if (isUpgrade(e.item)) {
        if (isUpgrade(other.item) && other.plane === e.plane) return true;
      } else if (isUnitKind(other.item) && (e.producer ? other.producer === e.producer : !other.producer && other.plane === e.plane)) return true;
    }
    return false;
  }

  /** Allocate at the production boundary, then progress paid producers concurrently. */
  updateProduction(this: Sim): void {
    const busy = this.segBusy;
    for (const army of this.allArmies) {
      const t = this.armies[army]!;
      const q = t.queue;
      for (const plane of PLANES) if (!this.segmentAlive(army, plane)) this.cancelSegmentResearch(army, plane);
      // An unstarted Surface site whose build-radius source was lost leaves the queue: nothing was paid yet, so the
      // whole cost stays with the army. Sites already under construction keep building.
      for (let i = q.length - 1; i >= 0; i--) {
        const e = q[i]!;
        if (e.started || !isRadiusBound(e.item)) continue;
        const code = this.buildSiteError(army, e.item, e.x, e.y);
        if (!code) continue;
        q.splice(i, 1);
        this.queueEvent(army, 'queue_cancelled', e, e.by, i, undefined, code);
      }
      this.allocateQueue(army);
      const researching = this.researchBusy;
      researching.fill(0);
      for (const e of q) if (e.started && isUpgrade(e.item)) researching[PLANE_INDEX[e.plane]] = 1;
      busy.fill(0);
      for (const e of q) if (e.started && isUnitKind(e.item) && !e.producer) busy[PLANE_INDEX[e.plane]] = 1;
      // Counted once per pass; a digger started below joins the viable replacements it would count as.
      let workers = this.viableWorkers(army);
      for (const e of q) {
        if (e.started) continue;
        const block = this.queueBlock(army, e, workers);
        if (block) {
          e.status = 'blocked';
          e.reason = block;
          continue;
        }
        const unit = isUnitKind(e.item);
        const research = isUpgrade(e.item);
        const rebuild = e.item === 'rebuild';
        let producerBusy = !e.producer && !!busy[PLANE_INDEX[e.plane]];
        if (e.producer) for (const other of q) if (other.started && other.producer === e.producer) { producerBusy = true; break; }
        if ((unit && producerBusy) || (research && researching[PLANE_INDEX[e.plane]])) {
          e.status = 'waiting';
          e.reason = 'producer';
          continue;
        }
        const s = this.queueStats(e.item, e.producer);
        // A short head keeps its backing and its turn; a later entry whose producer is free starts at once when idle
        // free stock (after every head's allocation and the upkeep buffer) pays its whole cost. Its own holds are zero
        // (allocateQueue released them), so canSpend checks free stock only.
        const backed = e.funding && e.heldAlloy >= s.alloy && e.heldEnergy >= s.energy;
        if (!backed && (e.funding || !this.canSpend(army, s.alloy, s.energy, e))) {
          e.status = 'waiting';
          e.reason = e.funding ? 'funds' : 'lane';
          continue;
        }
        if (!this.spend(army, s.alloy, s.energy, e.by, e)) continue;
        e.started = true;
        e.status = 'building';
        e.reason = null;
        if (e.item === 'digger') workers++;
        if (unit || research || rebuild) {
          e.left = s.build;
          if (!e.producer && !rebuild) (research ? researching : busy)[PLANE_INDEX[e.plane]] = 1;
        } else if (isIslandBuild(e.item)) {
          const isl = this.alive(e.island)!;
          const site = this.build(army, e.item, isl.x, isl.y, 'sky');
          site.productionRole = e.by;
          e.site = site.id;
          site.link = isl.id;
          site.elevation = isl.elevation;
          if (isBuildableHardpoint(e.item)) isl.hardpoint = site.id;
          else isl.link = site.id;
        } else if (e.item === 'bulkhead' || e.item === 'geothermal') {
          this.assignBulkhead(e, this.bulkheadBuilder(army, e)!);
        } else if (isRadiusBound(e.item)) {
          const site = this.build(army, e.item, e.x, e.y, 'surface');
          site.productionRole = e.by;
          e.site = site.id;
        }
      }
      for (let i = 0; i < q.length; ) {
        const e = q[i]!;
        if (!e.started) {
          i++;
          continue;
        }
        if (e.item === 'rebuild') {
          // Paused, not cancelled, while an enemy is near: the army already paid.
          const block = this.rebuildBlock(army, e.plane);
          if (block) {
            e.status = 'blocked';
            e.reason = block;
            i++;
            continue;
          }
          e.status = 'building';
          e.reason = null;
          if (--e.left <= 0) {
            q.splice(i, 1);
            this.rebuildSegment(army, e.plane, e.by);
          } else i++;
          continue;
        }
        if (isUpgrade(e.item)) {
          if (--e.left <= 0) {
            this.completeResearch(army, e.item);
            q.splice(i, 1);
          } else i++;
          continue;
        }
        if (e.item === 'bulkhead' || e.item === 'geothermal') {
          // Its digger reports back by removing the entry when the gate stands. A builder lost (dead, given other
          // orders, or unable to reach or finish the cell) hands the cost back: the entry is funded again in order.
          const d = this.alive(e.digger);
          if (d && d.order.k === 'bulkhead' && d.order.entry === e.id) {
            e.status = 'building';
            e.reason = null;
          } else {
            const s = this.stats[e.item];
            t.alloy += s.alloy;
            t.energy += s.energy;
            this.account(army, ACCOUNT_REFUND, s.alloy, s.energy, e.by);
            e.started = false;
            e.digger = 0;
            e.status = 'waiting';
            e.reason = 'no_builder';
          }
          i++;
          continue;
        }
        if (!isUnitKind(e.item)) {
          // A site reports back once built ('constructed') or lost ('structure_lost'): either way the entry is done.
          const site = this.alive(e.site);
          if (!site || site.built) q.splice(i, 1);
          else i++;
          continue;
        }
        const producer = e.producer ? this.alive(e.producer) : undefined;
        if (e.producer ? !this.validProducer(army, e.producer, e.item) || (producer?.kind === 'aerie' && !t.powered) : t.spire[e.plane].hp <= 0) {
          e.status = 'blocked';
          e.reason = e.producer ? 'producer' : 'segment_destroyed';
          i++;
          continue;
        }
        e.status = 'building';
        e.reason = null;
        e.left--;
        if (e.left > 0) {
          i++;
          continue;
        }
        q.splice(i, 1);
        const u = producer?.kind === 'shaft' ? this.add('digger', army, 'depths', producer.x, producer.y) : this.spawnUnit(army, e.item, e.plane, producer);
        u.productionRole = e.by;
        if (producer?.kind === 'aerie') {
          u.elevation = producer.elevation;
          u.skyIsland = producer.link;
        }
        if (producer?.kind === 'shaft') {
          u.replacementAlloy = this.shaftDiggerStats.alloy;
          u.replacementEnergy = this.shaftDiggerStats.energy;
        }
        if (producer?.kind === 'shaft') { u.cell = cellOf(producer.x, producer.y, this.size); t.pop++; }
        this.sendToRally(u, t.rally[u.plane].x, t.rally[u.plane].y, producer ?? t.spire[e.plane]);
        t.stats.produced++;
        this.emit([army], 'produced', e.plane, u.x, u.y, e.item, army, { owner: e.by });
      }
      // Segment display: queued units (carry) and the one in production.
      for (const plane of PLANES) {
        const seg = t.spire[plane];
        let queued = 0;
        let current: QueueEntry | null = null;
        for (const e of q) {
          if (e.plane !== plane || !isUnitKind(e.item) || e.producer) continue;
          queued++;
          if (e.started && !current) current = e;
        }
        seg.carry = queued;
        if (seg.hp <= 0) continue;
        seg.state = current ? 'constructing' : 'active';
        seg.progress = current ? 1 - current.left / this.queueStats(current.item).build : -1;
      }
    }
  }

  /**
   * Why entry `e` cannot start now, judged on what its army knows (null: it can). `workers`: the caller's
   * viableWorkers count when it checks many entries in one pass.
   */
  queueBlock(this: Sim, army: Army, e: QueueEntry, workers?: number): QueueReason | null {
    const t = this.armies[army]!;
    if (e.item === 'rebuild') return this.rebuildBlock(army, e.plane);
    if (isUpgrade(e.item)) return t.spire[e.plane].hp <= 0 ? 'segment_destroyed' : null;
    if (!this.canBuild(army, e.item)) return 'blocked';
    if (isUnitKind(e.item)) {
      if (e.producer) {
        const producer = this.alive(e.producer);
        if (!this.validProducer(army, e.producer, e.item) || (producer?.kind === 'aerie' && !t.powered)) return 'producer';
      } else if (t.spire[e.plane].hp <= 0) return 'segment_destroyed';
      let pending = 0;
      for (const other of t.queue) if (other.started && isUnitKind(other.item)) pending++;
      const recovery = e.item === 'digger';
      const headroom = recovery ? 0 : Math.min(this.econ.queueRecoverySupply, Math.max(0, this.econ.queueRecoveryWorkers - (workers ?? this.viableWorkers(army))));
      return t.pop + pending >= this.econ.popCap - headroom ? 'pop_cap' : null;
    }
    // Diggers build bulkheads, not the Spire: they need no segment.
    if (e.item !== 'bulkhead' && e.item !== 'geothermal' && e.item !== 'relay' && t.spire[e.plane].hp <= 0) return 'segment_destroyed';
    let pendingSites = 0;
    for (const other of t.queue) if (other.started && !other.site && (other.item === 'bulkhead' || other.item === 'geothermal')) pendingSites++;
    if (t.structures + pendingSites >= this.econ.structureCap) return 'structure_cap';
    if (e.item === 'mooring_tower' && !this.econ.mooringEnabled) return 'blocked';
    if (e.item === 'drill_yard' && this.drillYards(army) >= this.econ.drillYardMax) return 'structure_cap';
    if (isIslandBuild(e.item)) {
      if (isBuildableHardpoint(e.item) && this.econ.islandHardpoints < 1) return 'blocked';
      const isl = this.alive(e.island);
      if (!isl || isl.side !== army) return 'not_held';
      if (e.item === 'ore_extractor' && isl.oreRemaining <= 0) return 'blocked';
      const slot = isBuildableHardpoint(e.item) ? isl.hardpoint : isl.link;
      if (isBuildableHardpoint(e.item) && isl.state === 'capturing') return 'occupied';
      return slot && this.alive(slot) ? 'occupied' : null;
    }
    const c = cellOf(e.x, e.y, this.size);
    if (e.item === 'geothermal') {
      if (!this.tapSite(army, c, e.id)) return 'blocked';
      return this.tick < e.retry || !this.bulkheadBuilder(army, e) ? 'no_builder' : null;
    }
    if (e.item === 'bulkhead') {
      const known = this.bulkheadSiteKnown(army, c);
      if (known) return known;
      return this.tick < e.retry || !this.bulkheadBuilder(army, e) ? 'no_builder' : null;
    }
    const f = this.stats[e.item].footprint!;
    let unseen = false;
    const vis = this.vis[PLANE_INDEX.surface]!;
    for (let y = e.y - f.h / 2; y < e.y + f.h / 2; y++) {
      for (let x = e.x - f.w / 2; x < e.x + f.w / 2; x++) {
        const cell = y * this.size + x;
        // Known bedrock only (fog safety): a blocked reason must never reveal hidden Depths terrain.
        if (this.block[cell] || (e.item === 'shaft' && t.group.known[cell] === CELL.bedrock)) return 'blocked';
        if ((vis[cell]! & t.group.bit) === 0) unseen = true;
      }
    }
    if (this.siteTaken(e.x, e.y, army, e.item)) return 'occupied';
    // A site starts only while the army sees all of it: then any body on it is a seen one (siteTaken above), and an
    // unseen structure there can neither block the work nor be revealed by a reason.
    return unseen ? 'site_unseen' : null;
  }

  /** Bulkhead site checks on what `army` knows: its terrain knowledge, known bodies and seen or remembered gates. */
  bulkheadSiteKnown(this: Sim, army: Army, c: number): 'blocked' | 'occupied' | null {
    const t = this.armies[army]!;
    if (t.group.known[c] !== CELL.tunnel || this.holes[c] || this.depthNav[army]![c]) return 'blocked';
    const b = this.bulkheadOn(c);
    return b && (b.side === army || this.sees(army, b) || t.group.memory.has(b.id)) ? 'occupied' : null;
  }

  /**
   * The shared build rule (contract `buildSiteError`) for a new Surface `kind` of `army` centred at (x, y): outside
   * every hostile Spire's no-build zone (an eliminated army's Spire is gone) and inside an own build radius (own
   * completed structures, held home posts and held contested points). It reads only own entities and public Spire
   * positions, so the truth equals army knowledge here (fog-safe).
   */
  buildSiteError(this: Sim, army: Army, kind: Kind, x: number, y: number): BuildSiteError | null {
    for (const a of this.allArmies) {
      if (!this.hostile(army, a) || !this.inPlay(a)) continue;
      const foe = this.spireAt[a]!;
      if (inEnemySpireZone(foe.x, foe.y, x, y, this.econ)) return 'no_build_zone';
    }
    if (radiusExempt(kind)) return null;
    for (const s of this.ents) {
      if (s.dead || s.side !== army || s.plane !== 'surface' || !s.structure || !s.built || s.hp <= 0) continue;
      if (inBuildRadius(s.kind, s.x, s.y, x, y, this.econ)) return null;
    }
    for (let i = 0; i < this.posts.length; i++) {
      const p = this.posts[i]!;
      if (p.side === army && inBuildRadius('post', p.x, p.y, x, y, this.econ, this.postHome[i]! < 0)) return null;
    }
    return 'out_of_radius';
  }

  /** Footprints require an empty-cell spacing ring; army checks consult only visible bodies and remembered sites. */
  siteTaken(this: Sim, x: number, y: number, army?: Army, kind: StatKind = 'turret'): boolean {
    for (const s of this.ents) {
      if (s.dead || s.plane !== 'surface' || !s.structure || !footprintOverlap(kind, x, y, s.kind, s.x, s.y, STRUCTURE_SPACING)) continue;
      // Army 0 is falsy: test presence explicitly.
      if (army === undefined || s.side === army || s.kind === 'spire' || this.sees(army, s)) return true;
    }
    if (army !== undefined) for (const g of this.armies[army]!.group.memory.values()) {
      if (g.plane === 'surface' && footprintOverlap(kind, x, y, g.kind, g.x, g.y, STRUCTURE_SPACING)) return true;
    }
    return false;
  }

  validProducer(this: Sim, army: Army, id: number, item: QueueItem): boolean {
    const producer = this.alive(id);
    if (!producer || producer.hp <= 0 || producer.side !== army || !producer.built) return false;
    if (producer.kind === 'shaft') return item === 'digger' && producer.plane === 'surface' && this.armies[army]!.spire.depths.hp <= 0;
    return producer.kind === 'aerie' && isAircraft(item);
  }

  /** Choose a located pocket in army-relative cardinal order, never consulting unknown cells. */
  tapPocket(this: Sim, army: Army, c: number): number {
    const known = this.armies[army]!.group.pocketKnown;
    const frame = this.armyFrame[army]!;
    for (let k = 0; k < 4; k++) {
      const dir = frameDir(frame, k);
      const n = dir === 0 ? c + 1 : dir === 1 ? c - 1 : dir === 2 ? c + this.size : c - this.size;
      if (n < 0 || n >= this.n || !adjacent4(n, c, this.size)) continue;
      if (known[n]) return known[n]!;
    }
    return 0;
  }

  /** Validation uses remembered knowledge; hidden truth is checked only when work starts/reaches the site. */
  tapSite(this: Sim, army: Army, c: number, entry = 0, truth = false): boolean {
    const t = this.armies[army]!;
    if ((truth ? this.cells[c] : t.group.known[c]) !== CELL.rock || this.holes[c] || (truth ? this.depthBodies : this.depthNav[army]!)[c]) return false;
    const pocket = this.tapPocket(army, c);
    if (!pocket) return false;
    if (truth) {
      let sealed = false;
      for (let k = 0; k < 4; k++) {
        const n = k === 0 ? c + 1 : k === 1 ? c - 1 : k === 2 ? c + this.size : c - this.size;
        if (n >= 0 && n < this.n && adjacent4(n, c, this.size) && this.magma[n] === pocket) sealed = true;
      }
      if (!sealed) return false;
    }
    for (const e of this.ents) if (!e.dead && e.kind === 'geothermal' && (e.pocket === pocket || cellOfEnt(e, this.size) === c) && (truth || e.side === army || this.sees(army, e) || t.group.memory.has(e.id))) return false;
    for (const e of t.queue) if (e.id !== entry && e.item === 'geothermal' && (e.pocket === pocket || cellOf(e.x, e.y, this.size) === c)) return false;
    return true;
  }

  /**
   * Why a rebuild of `army`'s `plane` segment cannot start or progress now (null: it can): the segment stands or the
   * army's rebuilds are spent (`blocked`), or an enemy unit the army sees on that plane stands within
   * rules.spire.rebuildClearance of the segment footprint edge (`enemy_near`; fog-safe: unseen enemies never block).
   */
  rebuildBlock(this: Sim, army: Army, plane: Plane): QueueReason | null {
    const t = this.armies[army]!;
    if (this.segmentAlive(army, plane) || t.rebuilds >= this.econ.rebuildsPerMatch) return 'blocked';
    const at = this.spireAt[army]!;
    for (const e of this.ents) {
      if (e.dead || !e.unit || e.hangar || e.plane !== plane || !isArmy(e.side) || !this.hostile(army, e.side)) continue;
      if (footprintDistance('spire', at.x, at.y, e.x, e.y) - e.radius <= this.econ.rebuildClearance && this.sees(army, e)) return 'enemy_near';
    }
    return null;
  }

  /**
   * A rebuild of `army`'s `plane` segment finished: a new segment stands on the Spire's cells at rules.spire.rebuildHp
   * of its full HP, returning its crown. Own event; public under lossRule crowns (the crown is public).
   */
  rebuildSegment(this: Sim, army: Army, plane: Plane, by: Plane): void {
    const t = this.armies[army]!;
    const old = t.spire[plane];
    const at = this.spireAt[army]!;
    const seg = this.add('spire', army, plane, at.x, at.y);
    seg.maxHp = this.stat(seg).hp;
    seg.hp = Math.ceil(seg.maxHp * this.econ.rebuildHp);
    seg.state = 'active';
    seg.cell = old.cell;
    seg.productionRole = by;
    t.spire[plane] = seg;
    t.rebuilds++;
    this.footprintsDirty = true;
    if (plane === 'depths') this.refreshDrops();
    this.emit(this.rules.spire.lossRule === 'crowns' ? this.allArmies : [army], 'segment_rebuilt', plane, at.x, at.y, 'spire', army, { owner: by });
  }

  /** Conditional admission for seat `by` uses the same bank as its direct spending, never a second queue forecast. */
  queueAffordable(this: Sim, army: Army, by: Plane, item: QueueItem, producer: number, count: number): boolean {
    const cost = this.queueStats(item, producer);
    return this.canSpend(army, cost.alloy * count, cost.energy * count, by);
  }

  /** Add an entry for seat `by` at `index` (default: the bottom). Callers validate (intents.ts). */
  queueAdd(this: Sim, army: Army, by: Plane, item: QueueItem, site: { x?: number; y?: number; island?: number; digger?: number; producer?: number; plane?: Plane }, index?: number, source: IntentSource = 'owner'): QueueEntry {
    const t = this.armies[army]!;
    const plane = item === 'rebuild' ? site.plane! : this.queueStats(item).plane;
    const home = this.spireAt[army]!;
    const e: QueueEntry = {
      id: ++t.queueSeq,
      item,
      plane,
      x: site.x ?? home.x,
      y: site.y ?? home.y,
      island: site.island ?? 0,
      digger: site.digger ?? 0,
      producer: site.producer ?? 0,
      pocket: item === 'geothermal' ? this.tapPocket(army, cellOf(site.x!, site.y!, this.size)) : 0,
      retry: 0,
      by,
      byCtl: source === 'owner' ? 'human' : source === 'agent' || source === 'policy' ? 'agent' : 'bot',
      source,
      started: false,
      heldAlloy: 0,
      heldEnergy: 0,
      funding: false,
      recovery: false,
      blockedAt: -1,
      left: 0,
      site: 0,
      status: 'waiting',
      reason: 'funds',
    };
    const at = index === undefined ? t.queue.length : Math.min(index, t.queue.length);
    t.queue.splice(at, 0, e);
    this.queueEvent(army, 'queue_added', e, by, at, undefined, undefined, source);
    return e;
  }

  /**
   * Seat `by` cancels the entry at `index`: a full refund before it started, else rules.queue.refundStarted of its cost
   * (a structure site under construction is removed; a bulkhead's digger stops).
   */
  queueCancel(this: Sim, army: Army, by: Plane, index: number, source: IntentSource = 'owner'): void {
    const t = this.armies[army]!;
    const e = t.queue[index]!;
    t.queue.splice(index, 1);
    if (e.started) {
      const s = this.queueStats(e.item, e.producer);
      t.alloy += s.alloy * this.econ.queueRefund;
      t.energy += s.energy * this.econ.queueRefund;
      this.account(army, ACCOUNT_REFUND, s.alloy * this.econ.queueRefund, s.energy * this.econ.queueRefund, by);
      const site = this.alive(e.site);
      if (site) this.removeSite(site);
      const d = this.alive(e.digger);
      if ((e.item === 'bulkhead' || e.item === 'geothermal') && d && d.order.k === 'bulkhead' && d.order.entry === e.id) this.clearOrder(d);
    }
    this.queueEvent(army, 'queue_cancelled', e, by, index, undefined, undefined, source);
  }

  /** Seat `by` moves the entry at `from` to `to` (past the end: the bottom). */
  queueMove(this: Sim, army: Army, by: Plane, from: number, to: number, source: IntentSource = 'owner'): void {
    const q = this.armies[army]!.queue;
    const at = Math.min(to, q.length - 1);
    const adopted = (source === 'owner' || source === 'agent') && q[from]!.source !== source;
    if (at === from && !adopted) return;
    if (source === 'owner' || source === 'agent') q[from]!.source = source;
    const [e] = q.splice(from, 1);
    q.splice(at, 0, e!);
    this.queueEvent(army, 'queue_moved', e!, by, at, from, undefined, source);
  }

  /**
   * Explicit one-shot owner override. The lane's old head hands its backing over first, then free stock, then the
   * owner's other lanes; other owners' backing stays protected.
   */
  queuePriority(this: Sim, army: Army, by: Plane, index: number, ownerRoles: readonly string[]): void {
    const q = this.armies[army]!.queue;
    const target = q[index]!;
    this.queueMove(army, by, index, 0, 'owner');
    target.recovery = target.item === 'digger' && this.viableWorkers(army) < this.econ.queueRecoveryWorkers;
    const cost = this.queueStats(target.item, target.producer);
    // Reordering replaces this lane's old normal head, not its separate recovery commitment.
    for (const e of q) {
      if (e === target || e.started || e.plane !== by || e.recovery !== target.recovery) continue;
      this.shiftHold(e, target, cost);
      // Whatever the target could not use is surplus beyond a full backing: it returns to the free bank.
      e.heldAlloy = 0;
      e.heldEnergy = 0;
      e.funding = false;
    }
    target.heldAlloy += Math.min(Math.max(0, cost.alloy - target.heldAlloy), this.available(army, 'alloy'));
    target.heldEnergy += Math.min(Math.max(0, cost.energy - target.heldEnergy), this.available(army, 'energy'));
    // Consume only the remaining shortfall. Unneeded backing stays with the other authorized plans.
    for (const plane of PLANES) {
      if (plane === by || !ownerRoles.includes(plane)) continue;
      for (const e of q) if (e !== target && !e.started && e.plane === plane) this.shiftHold(e, target, cost);
    }
    target.funding = true;
  }

  /** Move `from`'s backing into `to` up to `to`'s full cost. */
  shiftHold(this: Sim, from: QueueEntry, to: QueueEntry, cost: { alloy: number; energy: number }): void {
    const alloy = Math.min(from.heldAlloy, Math.max(0, cost.alloy - to.heldAlloy));
    const energy = Math.min(from.heldEnergy, Math.max(0, cost.energy - to.heldEnergy));
    from.heldAlloy -= alloy;
    from.heldEnergy -= energy;
    to.heldAlloy += alloy;
    to.heldEnergy += energy;
  }

  /** Position of entry `id` in the army queue (-1: none). */
  queueIndexOf(this: Sim, army: Army, id: number): number {
    return this.armies[army]!.queue.findIndex((e) => e.id === id);
  }

  /** `code`: set when the sim, not a seat, cancelled the entry. */
  queueEvent(this: Sim, army: Army, kind: QueueEventKind, e: QueueEntry, by: Plane, index: number, from?: number, code?: GameError, source: IntentSource = e.source): void {
    const extra: Partial<SimEvent> = { by, byCtl: source === 'owner' ? 'human' : source === 'agent' || source === 'policy' ? 'agent' : 'bot', owner: e.by, ownerCtl: e.byCtl, entry: `q_${e.id}`, index: Math.min(index, QUEUE_LIST - 1) };
    if (from !== undefined) extra.from = Math.min(from, QUEUE_LIST - 1);
    if (code) extra.code = code;
    this.emit([army], kind, e.plane, e.x, e.y, isUpgrade(e.item) || e.item === 'rebuild' ? 'spire' : e.item, army, extra);
  }

  /** Retire a cancelled construction site: no loss event/wreck; caller alone handles the queue refund. */
  removeSite(this: Sim, e: Ent): void {
    if (e.dead) return;
    e.dead = true;
    this.footprintsDirty = true;
    e.hp = 0;
    this.armies[e.side]!.structures--;
    const isl = this.alive(e.link);
    if (isl && isl.link === e.id) isl.link = 0;
    if (isl && isl.hardpoint === e.id) isl.hardpoint = 0;
  }

  updateConstruction(this: Sim): void {
    for (const e of this.ents) {
      // A site destroyed this tick (a capture runs before construction) stays destroyed.
      if (e.built || e.dead || e.hp <= 0) continue;
      const s = this.statsOf(e)!;
      e.progress = Math.min(1, e.progress + 1 / s.build);
      e.hp = Math.min(e.maxHp, e.hp + (e.maxHp * this.econ.buildHpGain) / s.build);
      if (e.progress >= 1) {
        e.built = true;
        e.progress = -1;
        e.state = 'active';
        if (e.kind === 'shaft') {
          const c = cellOfEnt(e, this.size);
          if (this.magma[c]) this.breakPocket(c, e.side);
          else if (this.cells[c] !== CELL.bedrock && !isOpenCell(this.cells[c]!)) {
            this.resetCell(c);
            this.cells[c] = CELL.tunnel;
            this.ore[c] = 0;
            this.owner[c] = e.side + 1; // tunnel owners are army + 1 (0: nobody)
          }
          this.refreshDrops();
        } else if (e.kind === 'headframe') {
          const l = this.lodes[this.lodeAt[cellOf(e.x, e.y, this.size)]!];
          if (l && !l.open) this.openLode(l, e.side);
          this.armies[e.side]!.stats.headframes++;
          this.refreshDrops();
        }
        this.emit([e.side], 'constructed', e.plane, e.x, e.y, e.kind, e.side, e.productionRole ? { owner: e.productionRole } : undefined);
      }
    }
  }

  /** Place a structure under construction (costs are paid by the build queue). */
  build(this: Sim, army: Army, kind: BuildableKind | IslandBuild, x: number, y: number, plane: Plane): Ent {
    const t = this.armies[army]!;
    t.structures++;
    const e = this.add(kind, army, plane, x, y);
    e.built = false;
    e.hp = Math.max(1, Math.round(e.maxHp * this.econ.siteStartHp));
    e.progress = 0;
    e.state = 'constructing';
    return e;
  }
}
