/** Sky plane: storms and their vision masks, sky sources, floating islands, capture, hangars, storm evade and auto-intercept. */
import { footprintDistance, isAirArmor, MOORING_CAPTURE_HEIGHT, MOORING_DEPTH, MOORING_ISLAND_HEIGHT } from '../rules/contract.ts';
import { TICK_RATE } from '../rules/vocabulary.ts';
import { Ent } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import { cellOf, clampPos, quantize } from '../util/grid.ts';
import { type Army, armyBit, isArmy, NEUTRAL, rotVX, rotVY } from '../util/teams.ts';
import { norm, norm2, sq, TAU } from '../util/math.ts';
import { CAPTURE_DONE, CAPTURE_IDLE, holders } from './capture.ts';
import { dmath } from '../util/fdlibm.js';

/** stormEvade scratch: the escape point (written and read within one call). */
const evadeAt = { x: 0, y: 0 };

export class SkyPlane {
  /** Natural and powered seeded storms share the same allocation-free predicate. */
  stormAt(this: Sim, x: number, y: number): boolean {
    return this.weather.stormMask(x, y) !== 0;
  }

  stormMaskOf(this: Sim, e: Ent): number {
    if (e.stormVersion !== this.weather.version || e.stormX !== e.x || e.stormY !== e.y) {
      e.stormMask = this.weather.stormMask(e.x, e.y);
      e.stormX = e.x;
      e.stormY = e.y;
      e.stormVersion = this.weather.version;
    }
    return e.stormMask;
  }

  skyVisible(this: Sim, army: Army, x: number, y: number, mask = this.weather.stormMask(x, y)): boolean {
    if (!mask || this.scanned(army, x, y)) return true;
    const sources = this.skySources[army]!;
    for (let i = 0, n = this.skySourceCount[army]!; i < n; i++) {
      const source = sources[i]!;
      if (source.dead || source.hp <= 0 || source.side !== army || source.plane !== 'sky' || source.hangar > 0) continue;
      if (!source.built && source.kind !== 'spire') continue;
      if (!(mask & this.stormMaskOf(source))) continue;
      const r = this.stat(source).vision * (this.weather.fogAt(source.x, source.y) ? this.econ.fogVision : 1);
      if (norm2(source.x - x, source.y - y) <= sq(r)) return true;
    }
    return false;
  }

  /** Rebuild the Sky source lists from the live entities (once per tick, before anything queries them). */
  indexSkySources(this: Sim): void {
    this.skySourceCount.fill(0);
    for (const e of this.ents) if (!e.dead && e.plane === 'sky') this.enterSky(e);
  }

  /** Every place an entity starts existing on, or moves to, the Sky calls this (duplicates are harmless). */
  enterSky(this: Sim, e: Ent): void {
    if (!isArmy(e.side) || e.kind === 'island' || e.kind === 'asteroid') return;
    this.skySources[e.side]![this.skySourceCount[e.side]!++] = e;
  }

  /**
   * Seeded storms: a Seeder's `seed` sets its activeUntil (storm end); until the storm forms (activeUntil minus
   * seederDuration) it is a public telegraph. Both follow the Seeder's island; power loss ends them (economy).
   */
  updateWeather(this: Sim): void {
    let count = 0;
    let warnings = 0;
    for (const e of this.ents) {
      if (e.kind !== 'storm_seeder' || e.dead || !e.built || e.hp <= 0 || e.activeUntil <= this.tick || !isArmy(e.side)) continue;
      const from = e.activeUntil - this.econ.seederDuration;
      if (this.tick < from) this.weather.warn(warnings++, e.x, e.y, this.econ.seederRadius, from);
      else this.weather.seed(count++, e.x, e.y, this.econ.seederRadius, e.activeUntil, e.side);
    }
    this.weather.finishSeeds(count, warnings);
  }

  placeIsland(this: Sim, e: Ent): void {
    // World generation inserts permanent islands in consecutive orbits of `sides` (the first entities, so their ids
    // and neutral serials are consecutive): island r of an orbit is the orbit's first island turned r slots. They
    // share its phase arithmetic (the offset is quantized once, then turned exactly), but each island retains its own
    // held-time offset. C2: r = 1 is the point mirror.
    const r = e.seq % this.sides;
    const primary = r === 0 ? e : this.byId.get(e.id - r)!;
    const k = r * this.slotStep;
    const a = primary.orbitA0 + primary.orbitW * (this.tick - e.orbitDelay);
    const ox = quantize(dmath.cos(a) * e.orbitR);
    const oy = quantize(dmath.sin(a) * e.orbitR);
    e.x = clampPos(this.size / 2 + rotVX(k, ox, oy), this.size);
    e.y = clampPos(this.size / 2 + rotVY(k, ox, oy), this.size);
  }

  updateIslands(this: Sim): void {
    this.updateMoorings();
    this.updateSkyElevations();
    const r2 = this.econ.captureRadius * this.econ.captureRadius;
    for (const isl of this.ents) {
      if (isl.kind !== 'island') continue;
      const slot = isl.link ? this.alive(isl.link) : undefined;
      // Mooring changes elevation, never the Sky plane, ownership, weather or circular route.
      if (slot) {
        slot.x = isl.x;
        slot.y = isl.y;
        slot.elevation = isl.elevation;
      } else isl.link = 0;
      // The hardpoint attachment rides at the island centre in the sim (the client draws it on the rim pad).
      const mount = isl.hardpoint ? this.alive(isl.hardpoint) : undefined;
      if (mount) {
        mount.x = isl.x;
        mount.y = isl.y;
        mount.elevation = isl.elevation;
      } else isl.hardpoint = 0;
      if (isArmy(isl.side)) this.armies[isl.side]!.stats.islandTicks++;
      holders.fill(0);
      let anyone = false;
      for (const army of this.allArmies) {
        const sources = this.skySources[army]!;
        for (let i = 0, n = this.skySourceCount[army]!; i < n; i++) {
          const u = sources[i]!;
          if (u.dead || u.hp <= 0 || u.hangar || u.plane !== 'sky' || u.transitKind || !this.capable(u, 'capture')) continue;
          if (Math.abs(u.elevation - isl.elevation) > MOORING_CAPTURE_HEIGHT) continue;
          // Preserve incidental planar capture; only a vertical approach must exclude an overlapping other deck.
          const selected = u.order.k === 'capture' ? u.order.island : u.skyIsland;
          if (selected && selected !== isl.id && (isl.mooringPhase || u.elevation !== 0 || this.alive(selected)?.mooringPhase)) continue;
          const dx = u.x - isl.x;
          const dy = u.y - isl.y;
          if (dx * dx + dy * dy > r2) continue;
          holders[army]!++;
          anyone = true;
        }
      }
      // The shared hold rule (planes/capture.ts).
      const holder = anyone ? this.zoneClaimant(isl) : NEUTRAL;
      // The capture in progress belongs to this tick's claimant, else to the army whose claim is frozen or fading. A
      // built structure hostile to it makes the capture slower and drains as it goes; one still under construction
      // does not (it falls with the island).
      const claim = holder !== NEUTRAL ? holder : isl.capSide;
      const guard = slot && slot.built && slot.hp > 0 && isArmy(claim) && this.hostile(claim, slot.side) ? slot : undefined;
      // Only an armed hostile hardpoint blocks capture; an unarmed extractor falls with the island.
      const blocked = mount !== undefined && mount.hp > 0 && this.armed(mount) && holder !== NEUTRAL && this.hostile(holder, mount.side);
      const needed = guard ? this.econ.captureStructureTicks : this.econ.captureTicks;
      const step = this.advanceCapture(isl, holder, anyone, needed, blocked);
      if (step !== CAPTURE_IDLE && guard) this.damage(guard, guard.maxHp / this.econ.captureStructureTicks, holder, true, 'capture', 'sky');
      if (step === CAPTURE_DONE) this.captureIsland(isl, holder as Army);
      this.settleCapture(isl, holder, anyone, needed, 'drifting', blocked);
    }
  }

  /**
   * Permanent conversion: `gun` leaves play as a unit (no loss stats) and a Gun Platform of the same side takes the
   * island's hardpoint, keeping the Gunship's HP fraction.
   */
  emplace(this: Sim, gun: Ent, isl: Ent): void {
    const t = this.armies[gun.side]!;
    const frac = gun.hp / gun.maxHp;
    this.clearOrder(gun);
    gun.dead = true;
    t.pop--;
    const p = this.add('gun_platform', gun.side, 'sky', isl.x, isl.y);
    p.built = true;
    p.elevation = isl.elevation;
    p.hp = p.maxHp * frac;
    p.link = isl.id;
    isl.hardpoint = p.id;
    t.structures++;
    t.stats.emplaced++;
    this.emit([gun.side], 'emplaced', 'sky', isl.x, isl.y, 'gun_platform', gun.side);
  }

  /** Owner release/destruction/power exhaustion ends the hold now; the island returns only through a safe gap. */
  releaseMooring(this: Sim, isl: Ent): void {
    const tower = this.byId.get(isl.mooringTower);
    if (tower?.mooringTarget === isl.id) tower.mooringTarget = 0;
    isl.mooringTower = 0;
    if (isl.mooringPhase && isl.mooringPhase !== 3) {
      isl.mooringPhase = 3;
      isl.mooringRiseAt = -1;
    }
  }

  /** All circular routes are eligible: the Surface tower must reach some point of this public ring. */
  mooringRouteAvailable(this: Sim, tower: Ent, isl: Ent): boolean {
    return Math.abs(norm(tower.x - this.size / 2, tower.y - this.size / 2) - isl.orbitR) <= this.econ.mooringRange;
  }

  /**
   * Reserve a vertical transition against ordinary circular traffic. The island body has a separate vertical
   * envelope; planar overlap is legal only below that envelope. Other moored columns cannot share a lower berth.
   * A drifting neighbour may itself stop, but can only do so at a column clear of this reserved transition.
   */
  mooringGap(this: Sim, isl: Ent, raising: boolean): boolean {
    const duration = this.econ.mooringTravelTicks;
    const clearance = this.rules.map.islandClearance + 1e-7;
    const first = raising ? Math.floor(duration * (MOORING_DEPTH - MOORING_ISLAND_HEIGHT) / MOORING_DEPTH) : 0;
    const last = raising ? duration + 1 : Math.ceil(duration * MOORING_ISLAND_HEIGHT / MOORING_DEPTH) + 1;
    for (const other of this.ents) {
      if (other.kind !== 'island' || other === isl) continue;
      if (other.mooringPhase) {
        if (norm(other.x - isl.x, other.y - isl.y) < clearance) return false;
        continue;
      }
      const r = other.seq % this.sides;
      const primary = this.byId.get(other.id - r)!;
      const k = r * this.slotStep;
      // Distance from a fixed point to the complete swept circular arc, not merely sampled tick endpoints.
      // Work in the neighbour's orbit frame so rotated worlds share exactly the same arithmetic.
      const x = rotVX((4 - k) % 4, isl.x - this.size / 2, isl.y - this.size / 2);
      const y = rotVY((4 - k) % 4, isl.x - this.size / 2, isl.y - this.size / 2);
      const from = primary.orbitA0 + primary.orbitW * (this.tick + first - other.orbitDelay);
      const sweep = primary.orbitW * (last - first);
      const to = from + sweep;
      let distance = Math.min(
        norm(dmath.cos(from) * other.orbitR - x, dmath.sin(from) * other.orbitR - y),
        norm(dmath.cos(to) * other.orbitR - x, dmath.sin(to) * other.orbitR - y),
      );
      const delta = ((Math.sign(sweep) * (dmath.atan2(y, x) - from)) % TAU + TAU) % TAU;
      if (Math.abs(sweep) >= TAU || (sweep !== 0 && delta <= Math.abs(sweep))) distance = Math.abs(norm(x, y) - other.orbitR);
      if (distance < clearance) return false;
    }
    return true;
  }

  updateMoorings(this: Sim): void {
    // First give every route the same current-tick phase, before any traffic prediction (iteration-order independent).
    for (const isl of this.ents) if (isl.kind === 'island') {
      if (isl.mooringPhase) isl.orbitDelay++;
      else this.placeIsland(isl);
    }
    const duration = this.econ.mooringTravelTicks;
    for (const isl of this.ents) {
      if (isl.kind !== 'island' || !isl.mooringPhase) continue;
      const tower = this.alive(isl.mooringTower);
      if (isl.mooringPhase !== 3 && (!tower || tower.hp <= 0 || !tower.built || !this.econ.mooringEnabled)) this.releaseMooring(isl);
      if (isl.mooringPhase === 1 || (isl.mooringPhase === 3 && isl.mooringRiseAt < 0)) {
        // A release during lowering finishes the already-reserved descent, rather than reversing into a follower.
        isl.elevation = -MOORING_DEPTH * Math.min(1, (this.tick - isl.mooringAt) / duration);
        if (isl.elevation <= -MOORING_DEPTH) {
          if (isl.mooringPhase === 1) isl.mooringPhase = 2;
          else if (this.mooringGap(isl, true)) isl.mooringRiseAt = this.tick;
        }
      } else if (isl.mooringPhase === 3) {
        isl.elevation = -MOORING_DEPTH * Math.max(0, 1 - (this.tick - isl.mooringRiseAt) / duration);
        if (isl.elevation >= 0) {
          isl.elevation = 0;
          isl.mooringPhase = 0;
          isl.mooringReadyAt = this.tick + this.econ.mooringCooldown;
        }
      }
    }
    for (const tower of this.ents) {
      if (tower.kind !== 'mooring_tower' || tower.dead || tower.hp <= 0 || !tower.built || !tower.mooringTarget || !isArmy(tower.side)) continue;
      const isl = this.alive(tower.mooringTarget);
      if (!isl || isl.kind !== 'island') { tower.mooringTarget = 0; continue; }
      if (isl.mooringTower === tower.id) continue;
      // A competitor's catch cancels this pending request; no automatic handoff after its release.
      if (isl.mooringPhase || isl.mooringReadyAt > this.tick) { tower.mooringTarget = 0; continue; }
      const army = this.armies[tower.side]!;
      if (!this.econ.mooringEnabled || !army.powered || army.energy < this.econ.mooringUpkeep / TICK_RATE
        || !this.seesCell(tower.side, 'sky', cellOf(isl.x, isl.y, this.size))
        || norm(tower.x - isl.x, tower.y - isl.y) > this.econ.mooringRange || !this.mooringGap(isl, false)) continue;
      isl.mooringTower = tower.id;
      isl.mooringPhase = 1;
      isl.mooringAt = this.tick;
      isl.mooringRiseAt = -1;
      tower.mooringGrace = this.econ.mooringGraceTicks;
      army.stats.moorings++;
    }
  }

  /** Deliberate island operations descend; departing aircraft climb. All sight, weather and weapons stay in Sky. */
  updateSkyElevations(this: Sim): void {
    const step = MOORING_DEPTH / this.econ.mooringTravelTicks;
    for (const e of this.ents) {
      if (e.dead || !e.unit || e.plane !== 'sky' || !isAirArmor(this.armorOf(e)) || e.transitKind) continue;
      let island: Ent | undefined;
      const order = e.order;
      if (e.hangar) {
        const aerie = this.alive(e.hangar);
        island = aerie ? this.alive(aerie.link) : undefined;
      } else if (order.k === 'capture') island = this.alive(order.island);
      else if (order.k === 'attack' || order.k === 'hangar') {
        const target = this.alive(order.target);
        if (target?.plane === 'sky' && target.structure && isArmy(e.side) && this.sees(e.side, target)) island = this.alive(target.link);
      } else if (order.k === 'move') {
        let closest = this.econ.captureRadius;
        for (const candidate of this.ents) {
          if (candidate.kind !== 'island' || !isArmy(e.side) || !this.seesCell(e.side, 'sky', cellOf(candidate.x, candidate.y, this.size))) continue;
          const d = norm(order.x - candidate.x, order.y - candidate.y);
          if (d < closest) { closest = d; island = candidate; }
        }
      } else if (order.k === 'none') island = this.alive(e.skyIsland);
      if (island?.kind !== 'island' || norm2(e.x - island.x, e.y - island.y) > sq(this.econ.captureRadius + 2)) island = undefined;
      e.skyIsland = island?.id ?? 0;
      const target = island?.elevation ?? 0;
      e.elevation += Math.max(-step, Math.min(step, target - e.elevation));
      if (Math.abs(e.elevation) < 1e-9) e.elevation = 0;
    }
  }

  /** Complete a height-compatible docking approach using the existing hangar semantics. */
  houseAircraft(this: Sim, e: Ent, aerie: Ent): void {
    this.clearOrder(e);
    e.hangar = aerie.id;
    e.ready = 0;
    e.state = 'hangared';
    e.x = aerie.x;
    e.y = aerie.y;
    e.elevation = aerie.elevation;
    e.skyIsland = aerie.link;
    e.vx = e.vy = 0;
  }

  /**
   * Housing follows the island but supplies no combat, capture or vision; a powered hangar repairs at aerieRepair.
   * Destruction forces a damaged evacuation.
   */
  updateHangars(this: Sim): void {
    const repair = this.econ.aerieRepairEnabled ? this.econ.aerieRepair / TICK_RATE : 0;
    for (const e of this.ents) {
      // Surface hangars are Drill Yards (updateConversions).
      if (!e.hangar || e.dead || e.plane !== 'sky') continue;
      const aerie = this.alive(e.hangar);
      if (!aerie || aerie.hp <= 0 || aerie.side !== e.side) {
        e.hp *= this.econ.aerieLossHealth;
        e.hangar = 0;
        e.ready = 0;
        e.state = 'idle';
        continue;
      }
      e.x = aerie.x;
      e.y = aerie.y;
      e.elevation = aerie.elevation;
      if (isArmy(e.side) && this.armies[e.side]!.powered && e.hp > 0) e.hp = Math.min(e.maxHp, e.hp + repair);
      if (e.state === 'launching' && this.tick >= e.ready) {
        e.hangar = 0;
        e.ready = 0;
        e.state = 'idle';
      }
    }
  }

  /** An aircraft in the Sky: what storms slow and damage, and what storm evade moves. */
  airborne(this: Sim, e: Ent): boolean {
    return e.unit && e.plane === 'sky' && isAirArmor(this.armorOf(e));
  }

  /** Storm damage factor for aircraft `e` where it is (0: no storm harms it there). */
  stormHarm(this: Sim, e: Ent): number {
    return this.weather.harmAt(e.x, e.y, ~this.hostileMask[e.side]!, this.econ.seededOwnDamage);
  }

  /**
   * Storm evade bookkeeping when an aircraft's order has just ended (its first idle tick): it was ordered into the
   * damaging storm it stands in, unless that order was the sim's own step out of a storm.
   */
  settleInStorm(this: Sim, e: Ent): void {
    if (this.airborne(e)) e.stormOk = !e.evading && this.stormHarm(e) > 0;
    e.evading = false;
  }

  /**
   * Storm evade (rules.sky.stormEvadeEnabled; DESIGN §4.3): an idle aircraft not on `hold` that a storm reached (not
   * one ordered in) takes a move order to the nearest point stormEvadeMargin past a damaging storm's edge. True when
   * it did; it clears `stormOk` once no storm harms it.
   */
  stormEvade(this: Sim, e: Ent): boolean {
    if (!this.econ.stormEvadeEnabled || !this.airborne(e)) return false;
    if (this.stormHarm(e) <= 0) {
      e.stormOk = false;
      return false;
    }
    if (e.stormOk || e.stance === 'hold') return false;
    if (!this.weather.evadePoint(e.x, e.y, ~this.hostileMask[e.side]!, this.econ.seededOwnDamage, this.econ.stormEvadeMargin, e.frame, evadeAt)) return false;
    this.order(e, { k: 'move', x: evadeAt.x, y: evadeAt.y, fight: false, speed: 0 });
    e.evading = true;
    return true;
  }

  /**
   * Auto-intercept candidates, once per tick before units decide (rules.sky.autoInterceptEnabled): every falling
   * interceptable rock with the army bits of the Surface structures (Spire segments included) its public blast radius
   * reaches. Public radius: the size's normal blast, so no hidden resource type or volatility steers an interceptor.
   */
  indexFalling(this: Sim): void {
    this.falling.length = 0;
    this.fallingHits.length = 0;
    if (!this.econ.autoInterceptEnabled) return;
    for (const a of this.ents) {
      if (a.dead || a.state !== 'falling' || !this.payloads[a.kind]?.interceptable) continue;
      const radius = a.kind === 'asteroid' ? this.rocks[a.rockSize].drops.slag.impact.radius : this.payloadDrop(a)!.impact.radius;
      let hits = 0;
      for (const s of this.ents) {
        if (s.dead || !s.structure || s.plane !== 'surface' || !isArmy(s.side) || s.kind === 'post') continue;
        if (footprintDistance(s.kind, s.x, s.y, a.ix, a.iy) <= radius) hits |= armyBit(s.side);
      }
      if (hits === 0) continue;
      this.falling.push(a);
      this.fallingHits.push(hits);
    }
  }

  /**
   * Auto-intercept, the standing form of the `intercept` macro: an idle interceptor not on `hold` closes on the
   * nearest falling hostile rock that would hit its army's Surface structures and lands within autoInterceptRadius of
   * the interceptor's post, hovering interceptHover × range from it like the macro. True while it does.
   */
  autoIntercept(this: Sim, e: Ent): boolean {
    if (this.falling.length === 0 || e.kind !== 'interceptor' || e.plane !== 'sky' || e.stance === 'hold') return false;
    const bit = armyBit(e.side as Army);
    const reach = this.econ.autoInterceptRadius;
    let best: Ent | undefined;
    let bd = Infinity;
    for (let i = 0; i < this.falling.length; i++) {
      const a = this.falling[i]!;
      if (!(this.fallingHits[i]! & bit) || a.dead || !this.isTarget(e, a)) continue;
      const d = norm(a.ix - e.ax, a.iy - e.ay);
      if (d > reach) continue;
      // Ties: the lower serial, then (rotated twins of two hostile armies) the relative order from the interceptor.
      if (d < bd || (d === bd && best && (a.seq < best.seq || (a.seq === best.seq && isArmy(a.side) && isArmy(best.side) && this.rel(e.side as Army, a.side) < this.rel(e.side as Army, best.side))))) {
        bd = d;
        best = a;
      }
    }
    if (!best) return false;
    e.state = 'attacking';
    this.navTo(e, best.x, best.y, this.stat(e).range * this.econ.interceptHover);
    return true;
  }

  /** `army` takes `isl`: a hostile previous holder loses it and its island structure. */
  captureIsland(this: Sim, isl: Ent, army: Army): void {
    const prevSide = isl.side;
    if (isArmy(prevSide)) {
      for (const s of [isl.link ? this.alive(isl.link) : undefined, isl.hardpoint ? this.alive(isl.hardpoint) : undefined]) {
        if (!s) continue;
        s.hp = 0;
        s.lastHitBy = army;
        s.lastHitCause = 'capture';
        s.lastHitPlane = 'sky';
        s.lastHitKind = undefined;
      }
      this.emit([prevSide], 'island_lost', 'sky', isl.x, isl.y, 'island', army);
    }
    this.takeZone(isl, army);
    this.emit([army], 'island_captured', 'sky', isl.x, isl.y, 'island', army);
  }
}
