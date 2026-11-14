/** Tick orchestration: the fixed order every system runs in one 20 Hz step, end-of-tick cleanup and the match outcome. */
import { CELL, isAirArmor, isCellStructure, type Outcome, type Plane, PLANES, TICK_RATE } from '../rules/contract.ts';
import { GEOM_EPS, norm, TAU } from '../util/math.ts';
import { type Army, armyBit, canonVX, canonVY, NEUTRAL } from '../util/teams.ts';
import { DEPLOY_NONE, FX_WINDOW, PLANE_INDEX, VISION_EVERY } from './constants.ts';
import { Ent } from './ent.ts';
import type { Sim } from './sim.ts';
import { dmath } from '../util/fdlibm.js';

/** finishKey fields, compared in order: finish tick, crowns lost, total Spire HP, contested-point score (the cap only). */
const FINISH_FIELDS = [0, 1, 2, 3] as const;

export class SimTick {
  step(this: Sim): void {
    if (this.result) return;
    this.tick++;
    for (const e of this.ents) {
      if (e.plane !== 'orbit') continue;
      e.tvx = e.vx;
      e.tvy = e.vy;
    }
    this.indexSkySources();
    let keepFx = 0;
    for (const record of this.fx) {
      const f = record.fx;
      if (f.tick > this.tick - FX_WINDOW || (f.kind === 'shot' && f.subject === 'island_mortar' && f.arrive !== undefined && f.arrive >= this.tick)) this.fx[keepFx++] = record;
    }
    this.fx.length = keepFx;
    // Sudden death starts: public, to every army (x/y: the map centre, the same point in every frame).
    if (this.tick === this.econ.suddenDeathTicks) this.emit(this.allArmies, 'sudden_death', 'surface', this.size / 2, this.size / 2);
    this.updateIslands();
    this.updatePosts();
    this.updateHangars();
    this.weather.update(this.tick);
    this.updateWeather();
    this.updatePayloads();
    this.updateRockGround();
    this.updateCharges();
    this.updateFloods();
    this.updateProduction();
    this.updateConstruction();
    this.updateConversions();
    this.updateBulkheads();
    if (this.footprintsDirty || this.footprintsVersion !== this.holesVersion) {
      this.surfaceBodies.fill(0);
      this.depthBodies.fill(0);
      for (const e of this.ents) {
        if (e.dead || !e.structure) continue;
        if (e.plane === 'surface') this.stampFootprint(this.surfaceBodies, e.kind, e.x, e.y);
        else if (e.plane === 'depths' && !isCellStructure(e.kind)) this.stampFootprint(this.depthBodies, e.kind, e.x, e.y);
      }
      for (const army of this.allArmies) this.refreshSurfaceFootprints(army);
      this.footprintsDirty = false;
      this.footprintsVersion = this.holesVersion;
      this.depthsVersion++;
    }
    this.updateTransits();
    this.updateOrbitAbilities(false);
    this.buildIndex();
    this.prepareDesignations();
    this.stampDeploys();
    const ents = this.ents;
    if (this.moved.length < ents.length) {
      const n = ents.length * 2;
      this.moved = new Uint8Array(n);
      this.moveX = new Float64Array(n);
      this.moveY = new Float64Array(n);
      this.pend = new Uint8Array(n);
      this.rest = new Uint8Array(n);
      this.nextX = new Float64Array(n);
      this.nextY = new Float64Array(n);
      this.nextCell = new Int32Array(n);
      this.nextVx = new Float64Array(n);
      this.nextVy = new Float64Array(n);
    }
    // Simultaneous decisions: every unit decides (targets, acquisition, steering) from the start-of-tick world. Its own
    // move (position and velocity) is computed, held back and undone, so no unit (and no team, whatever the entity
    // order) reacts to positions or velocities another unit reached this tick. Plane changes (shafts, breakouts,
    // falls) take effect at once. Open-plane units that did not drive this tick brake.
    const count = ents.length;
    this.movedCount = count;
    // Own units standing idle before anyone moves: a boxed-in friend may shove through them (they give way). Units in a
    // deploy stance never give way: they cannot move.
    for (let i = 0; i < count; i++) {
      const e = ents[i]!;
      this.rest[i] = !e.dead && e.unit && e.built && e.order.k === 'none' && !e.firing && e.stance !== 'hold' && e.deploy === DEPLOY_NONE && e.vx === 0 && e.vy === 0 ? 1 : 0;
    }
    // Fleet waypoints use only start-of-tick positions, including when members engage or leave the order.
    for (const e of ents) if (!e.dead && e.order.k === 'move' && e.order.fleet) this.advanceFleet(e.order.fleet);
    // Auto-intercept reads the rocks falling at the start of the tick (and whose structures they threaten).
    this.indexFalling();
    // Waypoints sighted this tick are stamped with the start-of-tick depths version, so a change made between two
    // twins' decisions stales both of them next tick, whatever the entity order.
    this.depthsStamp = this.depthsVersion;
    this.deciding = true;
    for (let i = 0; i < count; i++) {
      const e = ents[i]!;
      this.moved[i] = 0;
      this.pend[i] = 0;
      if (e.dead || !e.built || !e.unit || e.hangar || e.transitKind?.stationary || e.aegisUntil > this.tick) continue;
      const x0 = e.x;
      const y0 = e.y;
      const c0 = e.cell;
      const p0 = e.plane;
      const vx0 = e.vx;
      const vy0 = e.vy;
      this.steered = false;
      this.updateUnit(e);
      if (!this.steered && e.plane === p0 && p0 !== 'depths' && !e.dead && (e.vx !== 0 || e.vy !== 0)) this.drive(e, 0, 0);
      const d = norm(e.x - x0, e.y - y0);
      if (d > GEOM_EPS) {
        if (this.modifierRows) this.revealEffect(e, 'modifier', 'speed');
        this.moved[i] = 1;
        this.moveX[i] = (e.x - x0) / d;
        this.moveY[i] = (e.y - y0) / d;
        // Facing is computed in the owner's frame (exact for rotated twins) and presented rotated back.
        const mx = canonVX(e.frame, this.moveX[i]!, this.moveY[i]!) || 0;
        const my = canonVY(e.frame, this.moveX[i]!, this.moveY[i]!) || 0;
        const mount = e.mount?.kind;
        if (e.plane === 'depths' && p0 === 'depths') {
          // Turn-limited, so one-quantum direction flips never jitter the facing.
          const want = dmath.atan2(my, mx);
          const turn = this.econ.depthsTurnRate / TICK_RATE;
          const delta = ((want - e.heading + 3 * Math.PI) % TAU) - Math.PI;
          e.heading = Math.abs(delta) <= turn ? want : ((e.heading + Math.sign(delta) * turn + 3 * Math.PI) % TAU) - Math.PI;
        } else if (e.plane === 'orbit' ? !(e.faceTarget && mount && mount !== 'turret') : mount !== undefined && mount !== 'fixed') {
          e.heading = dmath.atan2(my, mx);
        }
      }
      if (e.plane !== p0 || e.dead) continue;
      this.pend[i] = PLANE_INDEX[p0] + 1;
      this.nextX[i] = e.x;
      this.nextY[i] = e.y;
      this.nextCell[i] = e.cell;
      this.nextVx[i] = e.vx;
      this.nextVy[i] = e.vy;
      e.x = x0;
      e.y = y0;
      e.cell = c0;
      e.vx = vx0;
      e.vy = vy0;
    }
    this.deciding = false;
    for (let i = 0; i < count; i++) {
      const e = ents[i]!;
      // A unit another unit's update moved to another plane (a fall) keeps that new place.
      if (this.pend[i] === 0 || e.dead || PLANE_INDEX[e.plane] + 1 !== this.pend[i]) continue;
      e.x = this.nextX[i]!;
      e.y = this.nextY[i]!;
      e.cell = this.nextCell[i]!;
      e.vx = this.nextVx[i]!;
      e.vy = this.nextVy[i]!;
    }
    // Portal steps, bridges and breakouts taken this tick change planes and the surface only now: changed mid-update,
    // they reached later units' decisions (targets, planning) before their rotated twins'.
    this.landArrivals();
    for (const c of this.bridged) this.closeHole(c);
    this.bridged.length = 0;
    this.openLavaBridges();
    this.openBreakouts();
    this.applyDigging();
    this.resolveMotherLode();
    for (let i = 0; i < this.minedOutCount; i++) {
      const encoded = this.minedOut[i]!;
      this.digCell(encoded % this.n, Math.floor(encoded / this.n));
    }
    this.minedOutCount = 0;
    for (let i = 0; i < this.laidRailCount; i++) {
      const c = this.laidRails[i]!;
      this.cells[c] = CELL.rail;
      for (const army of this.allArmies) this.railWork.delete(army * this.n + c);
    }
    this.laidRailCount = 0;
    this.updateAsteroidMining();
    this.updateTowed();
    this.updateDerelict();
    this.separate();
    this.buildIndex();
    for (const e of this.ents) {
      if (!e.dead && e.unit && e.built && e.hangar === 0 && e.plane === 'sky' && isAirArmor(this.armorOf(e))) {
        const strength = this.weather.harmAt(e.x, e.y, ~this.hostileMask[e.side]!, this.econ.seededOwnDamage);
        if (strength > 0) this.damage(e, this.econ.stormDps * strength / TICK_RATE, NEUTRAL, false, 'storm');
      }
    }
    this.updateOrbitShields();
    this.updateOrbitAbilities(true);
    this.advanceLances();
    this.landProjectiles();
    this.combat();
    this.cleanup();
    this.economy();
    this.updateWeather();
    // Vision refreshes every VISION_EVERY ticks (every tick would be invisible to players and costly).
    if (this.tick % VISION_EVERY === 0) this.computeVision();
    this.checkOutcome();
    if (this.result && this.tick % VISION_EVERY !== 0) this.computeVision(); // final views reflect the final state
    // Back receipts before controllers can spend again; no one can race the next tick to consume another lane's income.
    for (const army of this.allArmies) if (this.inPlay(army)) this.allocateQueue(army);
    // Units walk into lit cells between vision refreshes (computeVision names what it reveals itself): name them for
    // the observations taken before the next step.
    if (this.tick % VISION_EVERY !== 0 && !this.result) this.noteSightings();
  }

  cleanup(this: Sim): void {
    let dirty = false;
    if (this.volatileDestroyed) {
      this.volatileDestroyed = false;
      // Resolve before killing ships, including victims earlier in entity storage.
      for (const e of this.ents) {
        if (e.dead || e.hp > 0 || e.state !== 'towed') continue;
        if (e.kind === 'asteroid' && e.volatile) this.detonateVolatile(e);
        else if (e.kind === 'core') this.coreMeltdown(e);
      }
    }
    for (const e of this.ents) {
      if (e.hp > 0 || e.kind === 'island' || e.kind === 'post') continue;
      if (!e.dead) this.kill(e);
      dirty = true;
    }
    if (!dirty) return;
    const keep: Ent[] = [];
    for (const e of this.ents) {
      if (e.dead) this.byId.delete(e.id);
      else keep.push(e);
    }
    this.ents = keep;
    // A rock depleted or destroyed this tick may still be the target of a tug that was approaching it (often an enemy
    // tug, whose own update already ran): never carry a reference to a removed entity into the next tick's state.
    for (const e of keep) if (e.miningTarget && !this.byId.has(e.miningTarget)) this.detachMining(e);
  }

  spireTotal(this: Sim, army: Army): number {
    let s = 0;
    for (const p of PLANES) s += Math.max(0, this.armies[army]!.spire[p].hp);
    return s;
  }

  /**
   * The match outcome (DESIGN §15.7). An army is eliminated on the tick it has lost rules.spire.crownsToLose crowns
   * (lossRule `surface`: its Surface segment fell; `crowns`: the Surface alone, or two side segments, by default) or
   * it forfeits. The match ends when at most one alliance still has an army in play: that alliance wins. If every
   * remaining alliance fell on the same tick, or at the time cap, the alliance with the fewest crowns lost, then the
   * most total Spire HP (fallen segments counted as 0) wins; at the time cap alone, alliances still tied split by
   * contested-point score (pointScore); tied leaders draw. Otherwise the fallen armies are eliminated and the match goes
   * on. With two armies under lossRule `surface` this is the old rule plus the score: one Surface falls → the other
   * wins; both → more total HP wins; the cap → more total HP, then more score wins; equal → draw.
   */
  checkOutcome(this: Sim): void {
    let falling = 0;
    let standing = 0;
    const toLose = this.crownsToLose;
    for (const a of this.allArmies) {
      if (!this.inPlay(a)) continue;
      if (this.crownsLost(a) >= toLose || this.forfeits & armyBit(a)) falling |= armyBit(a);
      else standing |= this.allianceBits(a);
    }
    this.forfeits = 0;
    const cap = this.tick >= this.timeCap;
    if (!falling && !cap) return;
    const alliances = this.allianceCount(standing);
    if (alliances >= 2 && !cap) {
      for (const a of this.allArmies) if (falling & armyBit(a)) this.eliminate(a);
      return;
    }
    // The fallen are out on this tick even though the match ends with it (no removal: there is no one left to play).
    for (const a of this.allArmies) if (falling & armyBit(a)) this.markEliminated(a);
    // Contenders: the one standing alliance; or, when none stands, the alliances that fell this tick; or, at the cap,
    // every standing alliance. Among several, fewer crowns lost, then more total Spire HP of their contending armies wins.
    let contenders = 0;
    for (const a of this.allArmies) {
      if (falling & armyBit(a) ? alliances === 0 : this.inPlay(a)) contenders |= armyBit(a);
    }
    let bestCrowns = Infinity;
    let best = -1;
    for (const a of this.allArmies) {
      if (!(contenders & armyBit(a))) continue;
      const crowns = this.allianceCrowns(a, contenders);
      const total = this.allianceTotal(a, contenders);
      if (crowns < bestCrowns || (crowns === bestCrowns && total > best)) {
        bestCrowns = crowns;
        best = total;
      }
    }
    const outcome: Exclude<Outcome, 'running'>[] = [];
    let leaders = 0;
    for (const a of this.allArmies) {
      if (contenders & armyBit(a) && this.allianceCrowns(a, contenders) === bestCrowns && this.allianceTotal(a, contenders) === best) leaders |= this.allianceBits(a);
    }
    // The last tiebreak, at the time cap only: the leaders' contested-point score.
    if (cap && this.allianceCount(leaders) > 1) {
      let top = -1;
      for (const a of this.allArmies) if (leaders & armyBit(a)) top = Math.max(top, this.pointScore(a, contenders));
      let kept = 0;
      for (const a of this.allArmies) if (leaders & armyBit(a) && this.pointScore(a, contenders) === top) kept |= this.allianceBits(a);
      leaders = kept;
    }
    const tied = this.allianceCount(leaders) > 1;
    for (const a of this.allArmies) outcome.push(leaders & armyBit(a) ? (tied ? 'draw' : 'win') : 'loss');
    // Rank: 1 + the other alliances (one representative each) whose finish key is strictly greater, field by field.
    const rank: number[] = [];
    for (const a of this.allArmies) {
      let above = 0;
      for (const b of this.allArmies) {
        if (this.allianceBits(b) & armyBit(a) || this.lowestArmy(b) !== armyBit(b)) continue;
        if (this.finishAbove(b, a, contenders, leaders)) above++;
      }
      rank.push(1 + above);
    }
    this.result = { outcome, rank };
  }

  /** The host ended the match early: outcomes and placements per army as given. */
  finish(this: Sim, outcome: readonly Exclude<Outcome, 'running'>[], rank: readonly number[]): void {
    if (this.result) return;
    this.result = { outcome: [...outcome], rank: [...rank] };
  }

  /** Bits of every army allied with `army` (its colour), itself included. */
  allianceBits(this: Sim, army: Army): number {
    let bits = 0;
    for (const b of this.allArmies) if (this.armyColour[b] === this.armyColour[army]) bits |= armyBit(b);
    return bits;
  }

  /** The lowest army bit of `army`'s alliance (one representative per alliance when counting). */
  lowestArmy(this: Sim, army: Army): number {
    const bits = this.allianceBits(army);
    return bits & -bits;
  }

  /** How many alliances have an army in `bits`. */
  allianceCount(this: Sim, bits: number): number {
    let count = 0;
    for (const a of this.allArmies) if (bits & armyBit(a) && (bits & this.allianceBits(a) & (armyBit(a) - 1)) === 0) count++;
    return count;
  }

  /** Total Spire HP of `army`'s alliance members in `among`. */
  allianceTotal(this: Sim, army: Army, among: number): number {
    let total = 0;
    for (const b of this.allArmies) if (among & armyBit(b) && this.armyColour[b] === this.armyColour[army]) total += this.spireTotal(b);
    return total;
  }

  /** Crowns lost by `army`'s alliance members in `among`. */
  allianceCrowns(this: Sim, army: Army, among: number): number {
    let lost = 0;
    for (const b of this.allArmies) if (among & armyBit(b) && this.armyColour[b] === this.armyColour[army]) lost += this.crownsLost(b);
    return lost;
  }

  /** Contested-point score of `army`'s alliance members in `among`: ticks held × rules.surface.postScore per second. */
  pointScore(this: Sim, army: Army, among: number): number {
    let ticks = 0;
    for (const b of this.allArmies) if (among & armyBit(b) && this.armyColour[b] === this.armyColour[army]) ticks += this.armies[b]!.stats.pointTicks;
    return (ticks * this.econ.postScore) / TICK_RATE;
  }

  /**
   * Rank key of `army`'s alliance at the end (field 0, then 1, 2, 3; larger ranks higher): the leaders first; then
   * the other contenders by fewer crowns lost, then total Spire HP, then (at the time cap) contested-point score; then
   * alliances eliminated earlier, later eliminations first and, on the same tick, by fewer crowns lost (a forfeit
   * last), then total Spire HP just before removal.
   */
  finishKey(this: Sim, army: Army, contenders: number, leaders: number, field: 0 | 1 | 2 | 3): number {
    if (leaders & armyBit(army)) return field === 0 ? Infinity : 0;
    const bits = this.allianceBits(army);
    if (contenders & bits) {
      if (field === 3) return this.tick >= this.timeCap ? this.pointScore(army, contenders) : 0;
      return field === 0 ? this.tick + 1 : field === 1 ? -this.allianceCrowns(army, contenders) : this.allianceTotal(army, contenders);
    }
    let last = -1;
    for (const b of this.allArmies) if (bits & armyBit(b)) last = Math.max(last, this.eliminatedAt[b]!);
    if (field === 0) return last;
    if (field === 3) return 0;
    let key = 0;
    for (const b of this.allArmies) {
      if (bits & armyBit(b) && this.eliminatedAt[b] === last) key += field === 1 ? -this.eliminatedCrowns[b]! : this.eliminatedHp[b]!;
    }
    return key;
  }

  /** Does `b`'s alliance finish strictly above `a`'s (finish keys compared field by field)? */
  finishAbove(this: Sim, b: Army, a: Army, contenders: number, leaders: number): boolean {
    for (const field of FINISH_FIELDS) {
      const kb = this.finishKey(b, contenders, leaders, field);
      const ka = this.finishKey(a, contenders, leaders, field);
      if (kb !== ka) return kb > ka;
    }
    return false;
  }

  /**
   * The segment whose fall eliminated `army` this tick: of the segments that fell on this tick (or are at 0 HP and not
   * yet removed), the one worth the most crowns, first in plane order on ties (null: none fell now).
   */
  decisiveSegment(this: Sim, army: Army): Plane | null {
    const t = this.armies[army]!;
    let best: Plane | null = null;
    for (const plane of PLANES) {
      const seg = t.spire[plane];
      if (seg.hp > 0 || (seg.dead && t.spireFellAt[plane] !== this.tick)) continue;
      if (best === null || this.crownValue(plane) > this.crownValue(best)) best = plane;
    }
    return best;
  }

  /**
   * Record `army` as out on this tick and tell everyone (public). The killing blow belongs to the hostile army that
   * last hit the decisive segment (the one whose fall took the last crown; a forfeit on that tick still counts as the
   * kill), and the event names its plane; a forfeit has none (event plane `surface`) and ranks below every army that
   * fell on the same tick.
   */
  markEliminated(this: Sim, army: Army): void {
    const killed = this.crownsLost(army) >= this.crownsToLose;
    const decisive = killed ? this.decisiveSegment(army) : null;
    const fell = decisive ? this.armies[army]!.spire[decisive] : null;
    this.eliminatedAt[army] = this.tick;
    this.eliminatedBy[army] = fell && this.hostile(fell.lastHitBy, army) ? fell.lastHitBy : NEUTRAL;
    this.eliminatedHp[army] = killed ? this.spireTotal(army) : -1;
    this.eliminatedCrowns[army] = killed ? this.crownsLost(army) : Infinity;
    let fallen = 0;
    for (const plane of PLANES) if (!this.segmentAlive(army, plane)) fallen |= 1 << PLANE_INDEX[plane];
    this.eliminatedFallen[army] = fallen;
    const by = this.eliminatedBy[army]!;
    const at = this.spireAt[army]!;
    this.emit(this.allArmies, 'army_eliminated', decisive ?? 'surface', at.x, at.y, 'spire', army, by === NEUTRAL ? undefined : { killer: by });
  }

  /**
   * Eliminate `army` (it lost its last crown or forfeited; the match goes on for the others): every remaining entity
   * of it is removed through the normal death path without kill credit (units, hangared air units, structures,
   * bulkheads, other Spire segments), held islands and forward posts turn neutral, planted charges are gone, its
   * queue, dig plan and resources are cleared and every vision group forgets its ghosts. Projectiles and payloads
   * already on their way still land.
   */
  eliminate(this: Sim, army: Army): void {
    const t = this.armies[army]!;
    this.markEliminated(army);
    for (const e of this.ents) {
      if ((e.kind === 'island' || e.kind === 'post') && e.side === army) {
        this.setSide(e, NEUTRAL);
        e.capT = 0;
        e.capSide = NEUTRAL;
      }
      if (e.dead || e.side !== army || this.payloads[e.kind]) continue;
      e.lastHitBy = NEUTRAL;
      e.lastHitCause = 'eliminated';
      e.lastHitPlane = undefined;
      e.lastHitKind = undefined;
      this.kill(e);
    }
    this.charges = this.charges.filter((ch) => ch.side !== army);
    this.flares = this.flares.filter((f) => f.side !== army);
    t.queue.length = 0;
    t.alloy = 0;
    t.energy = 0;
    t.scans.length = 0;
    t.designations.fill(0);
    t.designationWords.normal.fill(0);
    t.designationWords.urgent.fill(0);
    t.designationCount = 0;
    t.designationDirty = true;
    for (const g of this.groups) for (const [id, ghost] of g.memory) if (ghost.side === army) g.memory.delete(id);
    this.cleanup();
  }
}
