/** Orbital payloads: towing, deorbit rounds, falling rocks and volatiles, impacts and the ore caches they leave. */
import {
  footprintDistance,
  type Fx,
  isOpenCell,
  MAX_ARMIES,
  type RockResourceType,
  type RockSize,
  TICK_RATE,
} from '../rules/contract.ts';
import { type Army, canonX, canonY, isArmy, NEUTRAL, rotCell, rotVX, rotVY, rotX, rotY, sectorOf, type SideId } from '../util/teams.ts';
import type { ResolvedPayloadDrop } from '../rules/payload.ts';
import { ARRIVE_EPS, HOLE, REGION_BOUNDS } from '../sim/constants.ts';
import { Ent, type Order } from '../sim/ent.ts';
import type { Sim } from '../sim/sim.ts';
import type { OreCache, SimFall } from '../sim/state.ts';
import { cellCentreX, cellCentreY, cellFor, cellOfEnt, clampPos } from '../util/grid.ts';
import { GEOM_EPS, norm, norm2, sq } from '../util/math.ts';
import { CHAMBER, OUTSIDE, derelictLayer, gatesOpen, WALL_CLEAR, wallHit } from '../rules/derelict.ts';
import { dmath } from '../util/fdlibm.js';

/** Every falling payload lands on the Surface: its impact event, effect and the one Spire segment it can hit. */
const IMPACT_PLANE = 'surface';

/**
 * The army of the single alliance present in `count` (per army, > 0: present) with the most `best` (ties: relative
 * order from slot `sector`), or NEUTRAL when no army or several alliances are present or the alliance has no `best`.
 */
export function soleAlliance(sim: Sim, count: Int32Array, best: Int32Array, sector: number): SideId {
  let first: SideId = NEUTRAL;
  for (let a = 0; a < sim.armies.length; a++) {
    if (count[a]! <= 0) continue;
    if (first === NEUTRAL) first = a;
    else if (sim.hostile(first, a)) return NEUTRAL;
  }
  if (first === NEUTRAL) return NEUTRAL;
  let holder: SideId = NEUTRAL;
  let most = 0;
  let order = 0;
  for (let a = 0; a < sim.armies.length; a++) {
    if (count[a]! <= 0 || best[a]! <= 0) continue;
    const o = (sim.armySlot[a]! - sector + sim.sides) % sim.sides;
    if (best[a]! > most || (best[a] === most && o < order)) {
      holder = a;
      most = best[a]!;
      order = o;
    }
  }
  return holder;
}

/** Per-army scratch of the cache holder count (no per-tick allocation; filled and read within one call). */
const present = new Int32Array(MAX_ARMIES);
const collectors = new Int32Array(MAX_ARMIES);

export class Payloads {
  /** Freeze the audience at extraction/delivery time: a later scan must not reveal a past mining site. */
  miningFx(this: Sim, kind: 'mining_start' | 'mining_depleted' | 'mining_unload', at: Ent, owner: Army): void {
    let viewers = this.armies[owner]!.group.bit;
    const cell = cellOfEnt(at, this.size);
    for (const army of this.allArmies) if (this.seesCell(army, 'orbit', cell)) viewers |= this.armies[army]!.group.bit;
    const fx = this.fxAdd(kind, 'orbit', at.x, at.y, owner, false, {
      subject: kind === 'mining_depleted' ? 'asteroid' : 'tug', side: owner,
      ...(kind === 'mining_start' ? { tx: at.x, ty: at.y } : {}),
    });
    fx.viewers = viewers;
  }

  /** Hull damage destroys recoverable material; changing tow armour preserves the hull fraction. */
  capRockResource(this: Sim, rock: Ent): void {
    if (rock.kind !== 'asteroid') return;
    const yieldValue = this.rocks[rock.rockSize].dockYield[rock.resourceType];
    rock.resourceRemaining = Math.max(0, Math.min(rock.resourceRemaining, (yieldValue.alloy + yieldValue.energy) * Math.max(0, rock.hp / rock.maxHp)));
  }

  detachMining(this: Sim, tug: Ent): void {
    const rock = this.byId.get(tug.miningTarget);
    if (rock?.miningTug === tug.id) rock.miningTug = 0;
    tug.miningTarget = 0;
    if (tug.state === 'mining') tug.state = 'idle';
  }

  /** Forecast only the last observed trajectory and public field bounds, never a hidden entity's live state. */
  miningDestination(this: Sim, order: Extract<Order, { k: 'mine_asteroid' }>, axis: 'x' | 'y'): number {
    const site = order.site!;
    const edge = this.econ.asteroidEdge, span = this.size - edge * 2;
    const travelled = site[axis] - edge + site[axis === 'x' ? 'vx' : 'vy'] * (this.tick - site.tick);
    const folded = ((travelled % (span * 2)) + span * 2) % (span * 2);
    return edge + (folded <= span ? folded : span * 2 - folded);
  }

  /** Use public wall/gate geometry; ordinary steering still routes around the hull and through apertures. */
  asteroidMineReachable(this: Sim, tug: Ent, rock: Ent): boolean {
    const g = this.derelict;
    if (!g) return true;
    const dock = this.armies[tug.side]!.spire.orbit;
    const open = gatesOpen(g, this.tick);
    if (wallHit(g, open, rock.x - g.x, rock.y - g.y, tug.radius + this.econ.tugMineReach)) return false;
    const from = derelictLayer(g, norm(tug.x - g.x, tug.y - g.y));
    const to = derelictLayer(g, norm(rock.x - g.x, rock.y - g.y));
    const home = derelictLayer(g, norm(dock.x - g.x, dock.y - g.y));
    const crossesRing = (from === CHAMBER || to === CHAMBER || home === CHAMBER) && !(from === to && to === home);
    const crossesHull = (from === OUTSIDE || to === OUTSIDE || home === OUTSIDE) && !(from === to && to === home);
    const width = 2 * (tug.radius + WALL_CLEAR);
    return !(crossesRing && (!open || g.gateWidth <= width)) && !(crossesHull && g.breachWidth <= width);
  }

  /** Selection sees only local rocks and friendly assignments, including reserved rocks on cargo trips. */
  acquireAsteroidMine(this: Sim, tug: Ent, order: Extract<Order, { k: 'mine_asteroid' }>): boolean {
    let best: Ent | undefined, distance = Infinity;
    for (const rock of this.ents) {
      if (rock.kind !== 'asteroid' || rock.plane !== 'orbit'
        || !this.seesCell(tug.side, 'orbit', cellOfEnt(rock, this.size))) continue;
      if (rock.dead || rock.hp <= 0 || rock.state !== 'drifting' || rock.link || rock.volatile
        || rock.resourceType === 'slag' || rock.resourceRemaining <= 0 || !this.asteroidMineReachable(tug, rock)) continue;
      let claimed = false;
      for (const other of this.ents) {
        if (other === tug || other.dead || other.hp <= 0 || other.kind !== 'tug' || this.hostile(tug.side, other.side)) continue;
        const o = other.order;
        if ((o.k === 'mine_asteroid' && !o.exhausted || o.k === 'grapple') && o.asteroid === rock.id) { claimed = true; break; }
      }
      if (claimed) continue;
      const d = norm(rock.x - tug.x, rock.y - tug.y);
      // Neutral IDs are not rotation invariant; ties are measured in the tug's canonical frame.
      if (d > distance + GEOM_EPS) continue;
      if (best && Math.abs(d - distance) <= GEOM_EPS) {
        const x = canonX(tug.frame, rock.x, rock.y, this.size), bx = canonX(tug.frame, best.x, best.y, this.size);
        if (x > bx || x === bx && canonY(tug.frame, rock.x, rock.y, this.size) >= canonY(tug.frame, best.x, best.y, this.size)) continue;
      }
      best = rock; distance = d;
    }
    if (!best) return false;
    order.asteroid = best.id;
    order.exhausted = false;
    order.site ??= { x: 0, y: 0, vx: 0, vy: 0, tick: 0 };
    order.site.x = best.x; order.site.y = best.y;
    order.site.vx = best.vx; order.site.vy = best.vy; order.site.tick = this.tick;
    return true;
  }

  /** Navigation only; latches and extraction resolve after every unit has moved, not in entity iteration order. */
  updateAsteroidMine(this: Sim, tug: Ent, order: Extract<Order, { k: 'mine_asteroid' }>): void {
    const dock = this.armies[tug.side]!.spire.orbit;
    if (dock.hp <= 0 || tug.link || tug.plane !== 'orbit') return this.clearOrder(tug);
    const cargo = tug.cargoAlloy + tug.cargoEnergy;
    // Queued explicit work takes over after this cargo trip, never after an endless mining loop.
    if (order.auto && tug.queue.length) {
      if (cargo <= 0) return this.clearOrder(tug);
      order.exhausted = true;
      order.returning = true;
    }
    const rock = this.alive(order.asteroid);
    // Losing sight on a cargo trip is not evidence that a previously observed rock disappeared.
    const seen = rock && this.seesCell(tug.side, rock.plane, cellOfEnt(rock, this.size));
    if (seen) {
      order.site ??= { x: 0, y: 0, vx: 0, vy: 0, tick: 0 };
      order.site.x = rock.x; order.site.y = rock.y;
      order.site.vx = rock.vx; order.site.vy = rock.vy; order.site.tick = this.tick;
      if (rock.hp <= 0 || rock.state !== 'drifting' || rock.resourceType === 'slag' || rock.resourceRemaining <= 0) order.exhausted = true;
      if (order.auto && (rock.volatile || !this.asteroidMineReachable(tug, rock))) order.exhausted = true;
    }
    if (cargo >= this.econ.tugHold || order.exhausted) order.returning = cargo > 0;
    if (order.returning) {
      this.detachMining(tug);
      tug.state = 'returning';
      this.navTo(tug, dock.x, dock.y, Math.max(0, this.econ.dockRadius - tug.radius));
      return;
    }
    if (order.exhausted || !order.site || !order.asteroid) {
      this.detachMining(tug);
      if (!order.auto) return this.clearOrder(tug);
      order.asteroid = 0;
      order.exhausted = false;
      tug.state = 'idle';
      tug.progress = -1;
      this.drive(tug, 0, 0);
      this.acquireAsteroidMine(tug, order);
      return;
    }
    if (!seen || !rock) {
      this.detachMining(tug);
      tug.state = 'grappling';
      const x = this.miningDestination(order, 'x'), y = this.miningDestination(order, 'y');
      this.navTo(tug, x, y);
      // A drifting waypoint need not ever report exact arrival. Inspect it from harvesting distance once visible.
      if (norm2(tug.x - x, tug.y - y) <= sq(this.econ.tugMineReach)
        && this.seesCell(tug.side, 'orbit', cellFor(tug.frame, x, y, this.size))) {
        order.exhausted = true;
        if (cargo > 0) order.returning = true;
        else if (!order.auto) this.clearOrder(tug);
      }
      return;
    }
    tug.miningTarget = rock.id;
    if (rock.miningTug === tug.id) {
      // Station-keeping follows natural drift, never pulling the asteroid toward the dock.
      tug.state = 'mining';
      this.drive(tug, rock.vx, rock.vy);
    } else {
      tug.state = 'grappling';
      let dx = tug.x - rock.x, dy = tug.y - rock.y, d = norm(dx, dy);
      if (d <= GEOM_EPS) {
        dx = dock.x - rock.x; dy = dock.y - rock.y; d = norm(dx, dy);
        if (d <= GEOM_EPS) { dx = rotVX(tug.frame, 1, 0); dy = rotVY(tug.frame, 1, 0); d = 1; }
      }
      let x = rock.x + dx / d * this.econ.tugMineReach, y = rock.y + dy / d * this.econ.tugMineReach;
      if (x < tug.radius || y < tug.radius || x > this.size - tug.radius || y > this.size - tug.radius) {
        dx = this.size / 2 - rock.x; dy = this.size / 2 - rock.y; d = norm(dx, dy);
        x = rock.x + dx / d * this.econ.tugMineReach; y = rock.y + dy / d * this.econ.tugMineReach;
      }
      this.steer(tug, x, y, this.speedOf(tug, x - tug.x, y - tug.y), 0, true, rock.vx, rock.vy);
    }
  }

  /** Resolve a shared mining/tow latch race from post-movement positions; equally close enemies contest it. */
  updateAsteroidMining(this: Sim): void {
    for (const rock of this.ents) {
      if (rock.kind !== 'asteroid' || rock.dead || rock.hp <= 0 || rock.state !== 'drifting') continue;
      let tug = this.alive(rock.miningTug);
      if (tug && (tug.hp <= 0 || tug.order.k !== 'mine_asteroid' || tug.order.asteroid !== rock.id
        || tug.order.returning || tug.link
        || Math.abs(norm(tug.x - rock.x, tug.y - rock.y) - this.econ.tugMineReach) > ARRIVE_EPS + norm(rock.vx, rock.vy)
        || !this.segmentAlive(tug.side, 'orbit') || !this.sees(tug.side, rock))) {
        this.detachMining(tug);
        tug = undefined;
      }
      if (!tug) {
        rock.miningTug = 0;
        let distance = Infinity;
        let contested = false;
        const sector = sectorOf(rock.x, rock.y, this.size, this.sides);
        for (const candidate of this.ents) {
          const order = candidate.order;
          if (candidate.dead || candidate.hp <= 0 || candidate.plane !== 'orbit' || candidate.link
            || (order.k !== 'mine_asteroid' && order.k !== 'grapple') || order.asteroid !== rock.id
            || !this.sees(candidate.side, rock)) continue;
          if (order.k === 'mine_asteroid' && (order.returning || rock.resourceRemaining <= 0 || !this.segmentAlive(candidate.side, 'orbit'))) continue;
          const d = norm(candidate.x - rock.x, candidate.y - rock.y);
          if (order.k === 'mine_asteroid'
            ? Math.abs(d - this.econ.tugMineReach) > ARRIVE_EPS + norm(rock.vx, rock.vy)
            : d > this.econ.grappleReach) continue;
          if (d < distance - GEOM_EPS) { tug = candidate; distance = d; contested = false; }
          else if (Math.abs(d - distance) <= GEOM_EPS && tug) {
            if (this.hostile(candidate.side, tug.side)) contested = true;
            else {
              const candidateRank = (this.armySlot[candidate.side]! - sector + this.sides) % this.sides;
              const tugRank = (this.armySlot[tug.side]! - sector + this.sides) % this.sides;
              if (candidateRank < tugRank || candidateRank === tugRank && candidate.seq < tug.seq) tug = candidate;
            }
          }
        }
        if (contested || !tug) continue;
        if (tug.order.k === 'grapple') {
          tug.link = rock.id;
          rock.link = tug.id;
          rock.state = 'towed';
          if (rock.volatile) {
            const tow = this.rocks[rock.rockSize].volatileTow;
            rock.hp *= tow.hp / rock.maxHp;
            rock.maxHp = tow.hp;
            rock.fuseUntil = this.tick + tow.fuse;
          }
          this.clearOrder(tug);
          tug.state = 'towing';
          continue;
        }
        rock.miningTug = tug.id;
        tug.miningTarget = rock.id;
        this.miningFx('mining_start', rock, tug.side);
      }
      this.capRockResource(rock);
      const amount = Math.min(this.econ.tugMineRate / TICK_RATE, rock.resourceRemaining,
        Math.max(0, this.econ.tugHold - tug.cargoAlloy - tug.cargoEnergy));
      if (amount <= 0) continue;
      if (rock.resourceType === 'ice') tug.cargoEnergy += amount;
      else tug.cargoAlloy += amount;
      rock.resourceRemaining = Math.max(0, rock.resourceRemaining - amount);
      rock.hp = Math.max(0, rock.hp - amount * this.rocks[rock.rockSize].mineHpPerUnit[rock.resourceType]);
      tug.vx = rock.vx;
      tug.vy = rock.vy;
      tug.state = 'mining';
      tug.heading = dmath.atan2(canonY(tug.frame, rock.x, rock.y, this.size) - canonY(tug.frame, tug.x, tug.y, this.size),
        canonX(tug.frame, rock.x, rock.y, this.size) - canonX(tug.frame, tug.x, tug.y, this.size));
      tug.progress = Math.min(1, (tug.cargoAlloy + tug.cargoEnergy) / this.econ.tugHold);
      const depleted = rock.resourceRemaining <= GEOM_EPS || rock.hp <= GEOM_EPS;
      if (depleted) {
        rock.resourceRemaining = 0;
        rock.hp = 0;
        rock.dead = true;
        if (tug.order.k === 'mine_asteroid') tug.order.exhausted = true;
        this.miningFx('mining_depleted', rock, tug.side);
      }
      if (depleted || tug.cargoAlloy + tug.cargoEnergy >= this.econ.tugHold - GEOM_EPS) {
        if (tug.order.k === 'mine_asteroid') tug.order.returning = true;
        this.detachMining(tug);
        tug.state = 'returning';
      }
    }
    // Cargo is delivered even after a manual move/cancel/tow; no autonomous order is introduced for idle tugs.
    for (const tug of this.ents) {
      if (tug.dead || tug.hp <= 0 || tug.kind !== 'tug' || tug.plane !== 'orbit' || tug.cargoAlloy + tug.cargoEnergy <= 0) continue;
      const team = this.armies[tug.side]!;
      const dock = team.spire.orbit;
      if (dock.hp <= 0 || norm2(tug.x - dock.x, tug.y - dock.y) > sq(this.econ.dockRadius)) continue;
      const k = this.earn(tug.side, tug.cargoAlloy, tug.cargoEnergy, 'orbit');
      team.stats.alloyMined += tug.cargoAlloy * k;
      tug.cargoAlloy = tug.cargoEnergy = 0;
      this.miningFx('mining_unload', tug, tug.side);
      if (tug.order.k === 'mine_asteroid' && tug.order.returning) {
        tug.order.returning = false;
        if (tug.order.exhausted && (!tug.order.auto || tug.queue.length)) this.clearOrder(tug);
      }
    }
  }

  payloadDrop(this: Sim, e: Ent): ResolvedPayloadDrop | undefined {
    if (e.kind !== 'asteroid') return this.payloads[e.kind];
    const rock = this.rocks[e.rockSize];
    return (e.volatile ? rock.volatileDrops : rock.drops)[e.resourceType];
  }

  /** Marker geometry reveals size, never the unseen rock's volatile blast multiplier. */
  payloadFall(this: Sim, e: Ent): SimFall {
    const out: SimFall = { id: e.id, x: e.ix, y: e.iy, tick: e.impactTick };
    if (e.kind === 'asteroid' && e.rockSize !== 'medium') {
      const base = this.rocks[e.rockSize].drops.slag;
      out.start = e.impactTick - base.warning;
      out.radius = base.impact.radius;
    }
    return out;
  }

  updatePayloads(this: Sim): void {
    let count = 0;
    for (const a of this.ents) {
      if (a.dead) continue;
      if (a.kind === 'asteroid') count++;
      if (a.kind === 'asteroid' && a.state === 'towed' && a.fuseUntil > 0 && (a.hp <= 0 || this.tick >= a.fuseUntil)) {
        this.detonateVolatile(a);
        continue;
      }
      const drop = this.payloadDrop(a);
      if (drop && a.state === 'falling') {
        const f = Math.max(0, 1 - (a.impactTick - this.tick) / drop.fall);
        a.x = clampPos(a.fx + (a.ix - a.fx) * f, this.size);
        a.y = clampPos(a.fy + (a.iy - a.fy) * f, this.size);
        a.progress = Math.min(1, Math.max(0, f));
        if (this.tick >= a.impactTick) this.impactPayload(a, drop);
      } else if (a.kind === 'asteroid' && a.state === 'drifting') {
        const g = this.derelict;
        if (g) {
          // Drifting rocks glance off the derelict hull: a step that would carry the body into the hull's outer circle
          // while closing on the centre reflects off the radial normal first (a rock released inside drifts out).
          const dx = a.x - g.x;
          const dy = a.y - g.y;
          const dot = a.vx * dx + a.vy * dy;
          const R = g.hullOuter + a.radius;
          if (dot < 0 && sq(dx + a.vx) + sq(dy + a.vy) < R * R) {
            const k = (2 * dot) / (dx * dx + dy * dy);
            a.vx -= k * dx;
            a.vy -= k * dy;
          }
        }
        a.x += a.vx;
        a.y += a.vy;
        if (a.x < this.econ.asteroidEdge || a.x > this.size - this.econ.asteroidEdge) a.vx = -a.vx;
        if (a.y < this.econ.asteroidEdge || a.y > this.size - this.econ.asteroidEdge) a.vy = -a.vy;
        a.x = clampPos(a.x, this.size);
        a.y = clampPos(a.y, this.size);
      }
    }
    // One orbit per spawn: the drawn rock and its rotations onto every slot (C2: the point-mirrored pair).
    if (this.tick % this.econ.asteroidSpawnTicks === this.econ.asteroidSpawnOffset % this.econ.asteroidSpawnTicks && count <= this.econ.maxAsteroids - this.sides) {
      const pick = this.rng.range(0, this.orbitRegionWeight);
      let regionIndex = 0;
      while (regionIndex < this.orbitRegions.length - 1 && pick >= this.orbitRegionWeights[regionIndex]!) regionIndex++;
      const region = this.orbitRegions[regionIndex]!;
      const at = regionIndex * REGION_BOUNDS;
      let x = this.rng.range(this.orbitSpawnBounds[at]!, this.orbitSpawnBounds[at + 1]!);
      let y = this.rng.range(this.orbitSpawnBounds[at + 2]!, this.orbitSpawnBounds[at + 3]!);
      const g = this.derelict;
      if (g) {
        // Never inside the derelict hull: a point drawn there moves radially out to its outer edge plus a rock body.
        const dx = x - g.x;
        const dy = y - g.y;
        const r = Math.sqrt(dx * dx + dy * dy);
        const out = g.hullOuter + this.econ.asteroidRadius;
        if (r < out) {
          x = r > 0 ? g.x + (dx * out) / r : g.x + out;
          y = r > 0 ? g.y + (dy * out) / r : g.y;
        }
      }
      const vx = (region.dx * (1 - region.spread) + this.rng.range(-1, 1) * region.spread) * this.econ.asteroidDrift / TICK_RATE;
      const vy = (region.dy * (1 - region.spread) + this.rng.range(-1, 1) * region.spread) * this.econ.asteroidDrift / TICK_RATE;
      const sizeRoll = this.rng.next();
      const size: RockSize = sizeRoll < this.econ.pebbleChance ? 'pebble' : sizeRoll < this.econ.pebbleChance + this.econ.largeChance ? 'large' : 'medium';
      const resourceRoll = this.rockRng.next();
      const resourceType: RockResourceType = resourceRoll < this.econ.metalChance ? 'metal' : resourceRoll < this.econ.metalChance + this.econ.iceChance ? 'ice' : 'slag';
      const volatile = this.rockRng.next() < this.econ.volatileChance;
      for (let r = 0; r < this.sides; r++) {
        const k = r * this.slotStep;
        const a = this.add('asteroid', NEUTRAL, 'orbit', rotX(k, x, y, this.size), rotY(k, x, y, this.size));
        a.rockSize = size;
        a.resourceType = resourceType;
        a.volatile = volatile;
        const yieldValue = this.rocks[size].dockYield[resourceType];
        a.resourceRemaining = yieldValue.alloy + yieldValue.energy;
        a.hp = a.maxHp = this.rocks[size].hp;
        a.vx = rotVX(k, vx, vy);
        a.vy = rotVY(k, vx, vy);
        a.state = 'drifting';
      }
    }
  }

  updateTowed(this: Sim): void {
    for (const a of this.ents) {
      if ((a.kind !== 'asteroid' && a.kind !== 'core') || a.state !== 'towed' || a.dead) continue;
      const tug = this.alive(a.link);
      if (tug?.link === a.id) {
        a.x = tug.x;
        a.y = tug.y;
      }
      // A lethal hit cannot be redeemed by reaching the dock before end-of-tick combat cleanup.
      if (a.kind === 'core' && a.hp <= 0) {
        this.coreMeltdown(a);
        continue;
      }
      if (!tug || tug.link !== a.id) {
        this.letGo(a);
        continue;
      }
      if (tug.hp <= 0) {
        tug.link = 0;
        this.letGo(a);
        continue;
      }
      if (!isArmy(tug.side)) continue;
      const t = this.armies[tug.side]!;
      const dock = t.spire.orbit;
      if (dock.hp > 0 && norm2(tug.x - dock.x, tug.y - dock.y) <= sq(this.econ.dockRadius)) {
        if (a.kind === 'core') {
          this.cashCore(a, tug);
          continue;
        }
        this.capRockResource(a);
        const alloy = a.resourceType === 'metal' ? a.resourceRemaining : 0;
        const energy = a.resourceType === 'ice' ? a.resourceRemaining : 0;
        const k = this.earn(tug.side, alloy, energy, 'orbit');
        t.stats.alloyMined += alloy * k;
        a.resourceRemaining = 0;
        a.fuseUntil = 0;
        a.dead = true;
        a.hp = 0;
        a.link = tug.link = 0;
      }
    }
  }

  /** `tug` lets go of whatever it tows, where it is (the `release` intent). */
  releaseTow(this: Sim, tug: Ent): void {
    const a = this.alive(tug.link);
    tug.link = 0;
    if (a && a.link === tug.id && a.state === 'towed') this.letGo(a);
    if (tug.state === 'towing') tug.state = tug.order.k === 'move' ? 'moving' : 'idle';
    if (tug.order.k === 'vent') this.clearOrder(tug);
  }

  /** A towed payload without its tug: a rock drifts on (disarmed), the derelict core rests where it is. */
  letGo(this: Sim, a: Ent): void {
    if (a.kind === 'core') a.state = 'idle';
    else {
      a.state = 'drifting';
      this.releaseRock(a);
    }
    a.link = 0;
  }

  /**
   * Drop `tug`'s tow toward (x, y) now, or, inside `round`, once every seat's intents of the decision round have
   * applied (same tick): one army's drop never invalidates another's simultaneous orders (rotation-exact).
   */
  queueDeorbit(this: Sim, tug: Ent, x: number, y: number): void {
    if (this.inRound) this.deorbits.push({ tug, x, y });
    else this.deorbit(tug, this.alive(tug.link)!, x, y);
  }

  /** Apply one simultaneous decision round of intents (`apply`), then resolve its deferred deorbits and vision. */
  round(this: Sim, apply: () => void): void {
    this.inRound = true;
    try {
      apply();
    } finally {
      this.inRound = false;
      for (const d of this.deorbits) {
        const a = d.tug.dead ? undefined : this.alive(d.tug.link);
        if (a) this.deorbit(d.tug, a, d.x, d.y);
      }
      this.deorbits.length = 0;
      if (this.roundVision) {
        this.roundVision = false;
        this.computeVision();
      }
    }
  }

  deorbit(this: Sim, tug: Ent, a: Ent, x: number, y: number): void {
    if (!this.dropPayload(a, tug.side, x, y)) return;
    this.releaseTow(tug);
    a.link = 0;
  }

  /** Launchers supply the owner and landing point; the registry supplies the shared fall. */
  dropPayload(this: Sim, a: Ent, by: Army, x: number, y: number): boolean {
    const drop = this.payloadDrop(a);
    if (!drop || a.plane !== drop.from) return false;
    if (a.dead || a.hp <= 0 || (a.fuseUntil > 0 && this.tick >= a.fuseUntil)) return false;
    this.releaseRock(a);
    a.state = 'falling';
    this.setSide(a, by);
    a.plane = 'sky';
    this.enterSky(a);
    a.fx = a.x;
    a.fy = a.y;
    a.ix = clampPos(x, this.size);
    a.iy = clampPos(y, this.size);
    a.impactTick = this.tick + drop.warning;
    a.progress = 0;
    this.emit(this.allArmies, 'impact_incoming', 'surface', a.ix, a.iy, a.kind, by);
    this.fxAdd('deorbit', drop.from, a.fx, a.fy, by, true, { tp: 'surface', tx: a.ix, ty: a.iy, side: by, subject: a.kind });
    return true;
  }

  impactPayload(this: Sim, a: Ent, drop: ResolvedPayloadDrop): void {
    const hullFraction = a.kind === 'asteroid' ? Math.max(0, a.hp / a.maxHp) : 1;
    this.capRockResource(a);
    a.dead = true;
    a.hp = 0;
    const by: Army = a.side;
    // Mining and interception reduce a rock's strike; the core retains its heat-based bonus.
    const damage = drop.impact.damage * hullFraction + (drop.cool ?? 0) * Math.max(0, 1 - a.heat / 100);
    for (const e of this.ents) {
      if (e.dead || (e.plane !== 'surface' && e.plane !== 'sky') || e.kind === 'island' || e.kind === 'post' || this.payloads[e.kind]) continue;
      // One impact, one segment: the Surface and Sky segments share x/y, and the blast lands on the impact's plane
      // (IMPACT_PLANE), so only that segment takes it (× rules.spire.impactMultiplier). Sky units in the column still do.
      if (e.kind === 'spire' && e.plane !== IMPACT_PLANE) continue;
      const d = e.structure ? footprintDistance(e.kind, e.x, e.y, a.ix, a.iy) : norm(e.x - a.ix, e.y - a.iy);
      if (d <= drop.impact.radius) this.damage(e, e.kind === 'spire' ? damage * this.econ.spireImpactMultiplier : damage, by, true, drop.cause, drop.from, a.kind);
    }
    this.armies[by]!.stats.impacts++;
    this.emit(this.allArmies, 'impact', IMPACT_PLANE, a.ix, a.iy, a.kind, by);
    this.fxAdd('impact', IMPACT_PLANE, a.ix, a.iy, by, true, { side: by, subject: a.kind, fall: this.payloadFall(a) });
    if (drop.impact.crater > 0) this.openHoles(a.ix, a.iy, drop.impact.crater, HOLE.crater, by);
    if (drop.oreValue && a.resourceRemaining > 0) {
      this.formOreCache(a, drop.oreValue * a.resourceRemaining / this.rocks[a.rockSize].dock);
      a.resourceRemaining = 0;
    }
    if (drop.scorch) this.scorches.push({ x: a.ix, y: a.iy, radius: drop.impact.radius, until: this.tick + drop.scorch, by, dps: drop.scorchDps!, cause: drop.cause === 'core_drop' ? 'radiation' : 'scorch' });
    if (a.kind === 'core') this.removeCore(a);
  }

  /** Disarming preserves the hull fraction: changing tow armour never heals damage. */
  releaseRock(this: Sim, a: Ent): void {
    if (a.fuseUntil > 0) {
      const hp = this.rocks[a.rockSize].hp;
      a.hp *= hp / a.maxHp;
      a.maxHp = hp;
      a.fuseUntil = 0;
    }
  }

  /** Single Orbit detonation hook: debris delivery can extend this event without another damage path. */
  detonateVolatile(this: Sim, a: Ent): void {
    if (a.dead || a.kind !== 'asteroid' || !a.volatile || a.state !== 'towed') return;
    const tug = this.byId.get(a.link);
    const by = a.hp <= 0 ? a.lastHitBy : tug?.side ?? NEUTRAL;
    const blast = this.rocks[a.rockSize].volatileTow;
    // The blast hits everyone in range; the effect shows only to the vision groups that saw it happen.
    let viewers = 0;
    const c = cellOfEnt(a, this.size);
    for (const army of this.allArmies) {
      if (!this.seesCell(army, 'orbit', c)) continue;
      viewers |= this.armies[army]!.group.bit;
      this.emit([army], 'volatile_detonation', 'orbit', a.x, a.y, a.kind);
    }
    const fx = this.fxAdd('volatile_detonation', 'orbit', a.x, a.y, NEUTRAL, false, { subject: a.kind, radius: blast.radius });
    fx.viewers = viewers;
    a.dead = true;
    a.hp = 0;
    a.fuseUntil = 0;
    if (tug?.link === a.id) tug.link = 0;
    a.link = 0;
    for (const e of this.ents) {
      if (e.dead || e.hp <= 0 || e.plane !== 'orbit' || (!e.unit && !e.structure)) continue;
      const distance = e.structure ? footprintDistance(e.kind, e.x, e.y, a.x, a.y) : norm(e.x - a.x, e.y - a.y);
      if (distance <= blast.radius) this.damage(e, blast.damage, by, false, 'volatile_detonation', 'orbit', a.kind);
    }
  }

  /** Resolve the nearest legal cell once, in the dropper's canonical frame (row-major order there breaks ties). */
  placeOreCache(this: Sim, cache: OreCache): void {
    const k = this.armyFrame[cache.side]!;
    const x = canonX(k, cache.x, cache.y, this.size);
    const y = canonY(k, cache.x, cache.y, this.size);
    let best = -1;
    let distance = Infinity;
    for (let c = 0; c < this.n; c++) {
      const at = rotCell(k, c, this.size);
      if (this.block[at] || this.structureOver(at)) continue;
      const dx = cellCentreX(c, this.size) - x;
      const dy = cellCentreY(c, this.size) - y;
      const d = dx * dx + dy * dy;
      if (d < distance) { best = at; distance = d; }
    }
    if (best < 0) return; // Retain every load and retry if the entire Surface is obstructed.
    cache.x = cellCentreX(best, this.size);
    cache.y = cellCentreY(best, this.size);
    cache.placed = true;
  }

  formOreCache(this: Sim, a: Ent, alloy: number): void {
    // Only an actual open crater grants an underground share; bedrock is not a portal.
    let below = -1;
    let best = Infinity;
    const k = this.armyFrame[a.side]!;
    for (let c = 0; c < this.n; c++) {
      const at = rotCell(k, c, this.size);
      if (!this.holes[at] || !isOpenCell(this.cells[at]!)) continue;
      const dx = cellCentreX(at, this.size) - a.ix;
      const dy = cellCentreY(at, this.size) - a.iy;
      const distance = dx * dx + dy * dy;
      if (distance <= sq(this.rocks[a.rockSize].drops.slag.impact.crater) && distance < best) {
        below = at;
        best = distance;
      }
    }
    this.createOreCache(a.id, a.side, a.ix, a.iy, alloy, below);
  }

  /** Shared cache construction for impact ore and deliberately released island cargo. */
  createOreCache(this: Sim, id: number, side: SideId, x: number, y: number, alloy: number, below = -1): OreCache {
    const belowAlloy = below >= 0 ? alloy * this.econ.oreCacheDepthShare : 0;
    const cache: OreCache = {
      id, x, y, alloy: alloy - belowAlloy,
      belowX: below >= 0 ? cellCentreX(below, this.size) : x,
      belowY: below >= 0 ? cellCentreY(below, this.size) : y,
      belowAlloy, side, surfaceHolder: NEUTRAL, surfaceTicks: 0,
      depthsHolder: NEUTRAL, depthsTicks: 0, placed: false,
    };
    this.placeOreCache(cache);
    this.oreCaches.push(cache);
    return cache;
  }

  /** Cargo is island-owned, so capture or losing its extractor never strands it. */
  dropIslandOre(this: Sim, island: Ent): void {
    if (island.oreBuffer <= 0 || !isArmy(island.side)) return;
    const cache = this.createOreCache(this.nextId++, island.side, island.x, island.y, island.oreBuffer);
    island.oreBuffer = 0;
    this.fxAdd('deliver', 'surface', cache.x, cache.y, island.side, false, { subject: 'ore_extractor' });
  }

  /**
   * One load per pool, not per unit: defenders contest without multiplying passive income. A pool is collected while
   * exactly one alliance has units there; the load goes to its army with the most collectors (ties: relative order
   * from the cache's sector).
   */
  collectCache(this: Sim, cache: OreCache, depths: boolean): void {
    if (depths ? cache.belowAlloy <= 0 : cache.alloy <= 0 || !cache.placed) return;
    const x = depths ? cache.belowX : cache.x;
    const y = depths ? cache.belowY : cache.y;
    present.fill(0);
    collectors.fill(0);
    const radius2 = sq(this.econ.oreCacheRadius);
    for (const e of this.ents) {
      if (e.dead || e.hp <= 0 || !e.unit || e.hangar || e.transitKind || e.plane !== (depths ? 'depths' : 'surface') || !isArmy(e.side)) continue;
      if (sq(e.x - x) + sq(e.y - y) > radius2) continue;
      present[e.side]!++;
      if (!depths || this.capable(e, 'dig')) collectors[e.side]!++;
    }
    const holder = soleAlliance(this, present, collectors, sectorOf(x, y, this.size, this.sides));
    const previous = depths ? cache.depthsHolder : cache.surfaceHolder;
    let ticks = holder === NEUTRAL ? 0 : (holder === previous ? (depths ? cache.depthsTicks : cache.surfaceTicks) : 0) + 1;
    if (holder !== NEUTRAL && ticks >= this.econ.oreCacheTicks) {
      const load = Math.min(this.econ.oreCacheLoad, depths ? cache.belowAlloy : cache.alloy);
      if (depths) cache.belowAlloy -= load;
      else cache.alloy -= load;
      const k = this.earn(holder, load, 0, depths ? 'depths' : 'surface');
      this.armies[holder]!.stats.alloyMined += load * k;
      ticks = 0;
    }
    if (depths) { cache.depthsHolder = holder; cache.depthsTicks = ticks; }
    else { cache.surfaceHolder = holder; cache.surfaceTicks = ticks; }
  }

  updateRockGround(this: Sim): void {
    let kept = 0;
    for (const cache of this.oreCaches) {
      if (!cache.placed) this.placeOreCache(cache);
      this.collectCache(cache, false);
      this.collectCache(cache, true);
      if (cache.alloy > 0 || cache.belowAlloy > 0) this.oreCaches[kept++] = cache;
    }
    this.oreCaches.length = kept;
    kept = 0;
    for (const scorch of this.scorches) {
      if (scorch.until <= this.tick) continue;
      this.scorches[kept++] = scorch;
      for (const e of this.ents) {
        if (e.dead || e.hp <= 0 || !e.unit || e.plane !== 'surface' || e.hangar || e.transitKind) continue;
        if (sq(e.x - scorch.x) + sq(e.y - scorch.y) <= sq(scorch.radius)) this.damage(e, scorch.dps / TICK_RATE, scorch.by, true, scorch.cause);
      }
    }
    this.scorches.length = kept;
  }
}
