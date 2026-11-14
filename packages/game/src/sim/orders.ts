/** Unit orders: the per-unit decision for its current order, the order queue and anchors. */
import {
  CELL,
  isOpenCell,
  isUnitKind,
  LEASH,
  ORDER_QUEUE,
  MOORING_CAPTURE_HEIGHT,
  TRANSITS,
} from '../rules/contract.ts';
import { cellCentreX, cellCentreY, cellOfEnt, clampPos } from '../util/grid.ts';
import { GEOM_EPS, norm, norm2, sq } from '../util/math.ts';
import { type Army, NEUTRAL, rotVX, rotVY } from '../util/teams.ts';
import {
  CENTRED_EPS,
  DEPLOY_NONE,
  GOAL_NONE,
  HOLE,
  NAV_ARRIVED,
  NAV_BLOCKED,
  NAV_MOVING,
  PLANE_INDEX,
} from './constants.ts';
import { Ent, NONE, type Order } from './ent.ts';
import type { Sim } from './sim.ts';
import { dmath } from '../util/fdlibm.js';

export class SimOrders {
  updateUnit(this: Sim, e: Ent): void {
    if (e.deploy !== DEPLOY_NONE) return this.updateDeploy(e);
    const o = e.order;
    const army = e.side;
    if (e.kind === 'digger' && e.plane === 'depths' && (o.k === 'none' || (o.k === 'mine' && o.auto)) && this.updateDesignation(e)) return;
    switch (o.k) {
      case 'none': {
        e.progress = -1;
        // An auto stance (solar arrays) deploys wherever the unit comes to rest, unless folded by `deploy` off.
        const auto = this.deploySpec(e);
        if (auto?.auto && !e.folded && auto.plane === e.plane && (!auto.enabled || this.econ[auto.enabled])) return this.startDeploy(e);
        if (!e.anchored) {
          this.setAnchor(e);
          // Its order just ended: an aircraft left inside a damaging storm by its own order was ordered in.
          this.settleInStorm(e);
        }
        if (this.engageNearby(e, LEASH[e.stance])) return;
        if (this.autoIntercept(e)) return;
        // Stepping out of a storm is a move order of its own: run its first step now.
        if (this.stormEvade(e)) return this.updateUnit(e);
        // Engagement over: defensive units walk back to their post, aggressive ones hold the new ground.
        if (e.stance === 'defensive' && norm2(e.x - e.ax, e.y - e.ay) > sq(this.econ.returnToPost)) {
          e.state = !this.stalled(e, e.ax, e.ay) && this.navTo(e, e.ax, e.ay) === NAV_MOVING ? 'moving' : 'idle';
          return;
        }
        if (e.stance === 'aggressive') this.setAnchor(e);
        e.state = this.capable(e, 'tow') && e.link ? 'towing' : 'idle';
        return;
      }
      case 'move': {
        if (o.fight && this.engageNearby(e, LEASH[e.stance])) return;
        e.anchored = false;
        const fleet = o.fleet;
        if (fleet && !fleet.started) {
          this.drive(e, 0, 0);
          e.state = 'moving';
          return;
        }
        // Stuck short of its own destination (a fleet member's slot while the waypoint stands still, home or waiting):
        // re-plan to a free slot nearer it, or settle where it is at the edge of the crowd (Sim.reslot).
        const sx = fleet ? clampPos(fleet.x + o.ox!, this.size) : o.x;
        const sy = fleet ? clampPos(fleet.y + o.oy!, this.size) : o.y;
        const stuck = !fleet || (fleet.vx === 0 && fleet.vy === 0) ? this.stall(e, sx, sy) : -1;
        // Not while it shoves through idle friends (they are making way); nothing better yet: look again after another
        // stall window rather than every tick.
        if (stuck >= 0 && e.shove === 0 && !this.reslot(e, stuck, sx, sy)) e.progAt = this.tick;
        const x = fleet ? clampPos(fleet.x + o.ox!, this.size) : o.x;
        const y = fleet ? clampPos(fleet.y + o.oy!, this.size) : o.y;
        // A fleet slot travels with the waypoint: lead it by the waypoint's step, so members keep station rather than
        // trailing it at arrival-braking speed.
        const r = fleet && e.plane === 'orbit'
          ? (this.steer(e, x, y, this.speedOf(e), 0, true, fleet.vx, fleet.vy) ? NAV_ARRIVED : NAV_MOVING)
          : this.navTo(e, x, y);
        e.state = r === NAV_MOVING || (fleet && !fleet.finished) ? 'moving' : this.capable(e, 'tow') && e.link ? 'towing' : 'idle';
        if (r !== NAV_MOVING && (!fleet || fleet.finished)) this.clearOrder(e);
        return;
      }
      case 'patrol': {
        if (this.engageNearby(e, LEASH[e.stance])) return;
        e.anchored = false;
        const px = o.toB ? o.bx : o.ax;
        const py = o.toB ? o.by : o.ay;
        const r = this.stalled(e, px, py) ? NAV_ARRIVED : this.navTo(e, px, py);
        e.state = 'moving';
        if (r === NAV_BLOCKED) return this.clearOrder(e);
        if (r === NAV_ARRIVED) {
          o.toB = !o.toB;
          e.path = null;
          e.navGoal = GOAL_NONE;
        }
        return;
      }
      case 'attack': {
        const t = this.alive(o.target);
        if (!t || !this.sees(army, t) || !this.canHit(e, t.plane) || !this.isTarget(e, t)) return this.clearOrder(e);
        e.state = 'attacking';
        e.engage = t.id;
        if (this.holdRange(e, t)) return;
        if (this.approach(e, t) !== NAV_BLOCKED) return;
        // No spot left it could fire from (holes cut it off): say so once per target and tick, then drop the order.
        const last = this.armies[army]!.events.at(-1);
        if (!last || last.tick !== this.tick || last.kind !== 'target_unreachable' || last.x !== clampPos(t.x, this.size) || last.y !== clampPos(t.y, this.size)) {
          this.emit([army], 'target_unreachable', e.plane, t.x, t.y, t.kind, army);
        }
        this.clearOrder(e);
        return;
      }
      case 'dig': {
        if (!e.path || e.navGoal !== o.c) if (!this.planDepths(e, o.c, true)) return this.clearOrder(e);
        const r = this.followDepths(e, true);
        if (r === NAV_MOVING) {
          if (e.state !== 'digging') e.state = 'moving';
          return;
        }
        if (r === NAV_BLOCKED && this.planDepths(e, o.c, true)) return;
        return this.clearOrder(e);
      }
      case 'mine':
        return this.updateMine(e, o);
      case 'fortify': {
        // Walls only: rock (or already fortified rock) bordering a tunnel of the fortifier's alliance, or an own
        // bulkhead (repair and reinforce). Tunnels never close; sealing one is a bulkhead's or a shield wall's job.
        const c = o.c;
        const code = this.cells[c]!;
        const gate = this.bulkheadOn(c);
        const repair = gate !== undefined && gate.side === army;
        if (!repair && ((code !== CELL.rock && code !== CELL.fortified) || this.holes[c] || gate)) return this.clearOrder(e);
        if (!o.working) {
          if (!e.path && !this.planBeside(e, c)) return this.clearOrder(e);
          const r = this.followDepths(e, true);
          if (r === NAV_MOVING) {
            if (e.state !== 'digging') e.state = 'moving';
            return;
          }
          if (r === NAV_BLOCKED) {
            e.path = null;
            return;
          }
          if (!repair && !this.bordersOwned(c, this.allianceBits(army))) return this.clearOrder(e);
          if (!this.spend(army, this.econ.fortifyCost, 0, e.plane)) return this.clearOrder(e);
          o.working = true;
          e.workT = 0;
        }
        e.state = 'fortifying';
        e.workT++;
        const need = this.fortifyNeed(e);
        e.progress = Math.min(1, e.workT / need);
        if (e.workT < need) return;
        const stats = this.armies[army]!.stats;
        if (repair) {
          // Reinforce an own bulkhead: repaired to full and stronger, up to the cap.
          gate.maxHp = Math.max(gate.maxHp, Math.min(this.econ.bulkheadMaxHp, gate.maxHp + this.econ.bulkheadReinforce));
          gate.hp = gate.maxHp;
        } else this.fortifyCell(c);
        stats.fortified++;
        e.workT = 0;
        this.clearOrder(e);
        return;
      }
      case 'bulkhead': {
        const c = o.c;
        const s = o.geothermal ? this.stats.geothermal : this.stats.bulkhead;
        // The queue paid for it; whenever this digger gives up, the entry gets the cost back and finds a builder again.
        // On the way it judges the site by what its army knows; the truth decides only once it is beside the cell
        // (seeing it), so an unseen gate or tap there is never revealed by the digger turning back early.
        if (!o.working) {
          if (o.geothermal ? !this.tapSite(army, c, o.entry) : this.bulkheadSiteKnown(army, c) !== null) return this.clearOrder(e);
          if (!e.path && !this.planBeside(e, c)) {
            this.bulkheadRetry(army, o.entry);
            return this.clearOrder(e);
          }
          const r = this.followDepths(e, true);
          if (r === NAV_MOVING) {
            if (e.state !== 'digging') e.state = 'moving';
            return;
          }
          if (r === NAV_BLOCKED) {
            e.path = null;
            return;
          }
          o.working = true;
          e.workT = 0;
        }
        if (o.geothermal ? !this.tapSite(army, c, o.entry, true) : this.cells[c] !== CELL.tunnel || this.bulkheadAt[c] || this.depthBodies[c]) {
          this.bulkheadFailed(army, o.entry, !o.geothermal && this.bulkheadAt[c] ? 'occupied' : 'blocked');
          return this.clearOrder(e);
        }
        e.state = 'constructing';
        e.workT++;
        e.progress = Math.min(1, e.workT / s.build);
        if (e.workT < s.build) return;
        // Other armies' units standing in the cell keep the gate from closing: the entry tries again later.
        let blocked = this.armies[army]!.structures >= this.econ.structureCap;
        for (const u of this.ents) if (!u.dead && u.plane === 'depths' && u.unit && u.side !== army && cellOfEnt(u, this.size) === c) blocked = true;
        if (blocked) this.bulkheadRetry(army, o.entry);
        else {
          const by = this.armies[army]!.queue[this.queueIndexOf(army, o.entry)]?.by;
          if (o.geothermal) {
            const tap = this.add('geothermal', army, 'depths', cellCentreX(c, this.size), cellCentreY(c, this.size));
            tap.productionRole = by;
            tap.pocket = this.tapPocket(army, c);
            tap.state = 'active';
            this.armies[army]!.structures++;
            this.emit([army], 'constructed', 'depths', tap.x, tap.y, 'geothermal', army, by ? { owner: by } : undefined);
          } else this.placeBulkhead(army, c, by);
          this.bulkheadDone(army, o.entry);
        }
        e.workT = 0;
        this.clearOrder(e);
        return;
      }
      case 'undermine': {
        if (o.at > 0) {
          e.state = 'undermining';
          const fuse = this.hasAbility(e, 'shaped_charges') ? this.econ.shapedUndermineTicks : this.econ.undermineTicks;
          e.progress = Math.min(1, Math.max(0, 1 - (o.at - this.tick) / fuse));
          if (this.tick >= o.at) this.clearOrder(e);
          return;
        }
        const r = this.navTo(e, cellCentreX(o.c, this.size), cellCentreY(o.c, this.size));
        if (r === NAV_BLOCKED) return this.clearOrder(e);
        if (r === NAV_MOVING) {
          e.state = 'moving';
          return;
        }
        const shaped = this.hasAbility(e, 'shaped_charges');
        o.at = this.plantCharge(army, o.c, shaped);
        // The shorter fuse is public with the charge: everyone who sees the sapper learns of Shaped Charges.
        if (shaped) this.revealAbility(e, 'shaped_charges');
        e.state = 'undermining';
        e.progress = 0;
        return;
      }
      case 'rail': {
        // Walk the tunnels toward the goal, laying rail on every tunnel cell first (current cell included). Laying and
        // arrival happen at a cell's centre: the unit's cell turns over as soon as it crosses into the next one.
        const here = cellOfEnt(e, this.size);
        const centred = e.path === null || norm2(e.x - cellCentreX(here, this.size), e.y - cellCentreY(here, this.size)) < sq(CENTRED_EPS);
        if (this.cells[here] === CELL.tunnel && !this.bulkheadAt[here] && centred) {
          // One paid job per cell and army: a digger reaching a cell its army is already railing joins in for free.
          const key = army * this.n + here;
          let done = this.railWork.get(key);
          if (done !== undefined && done >= this.econ.railTicks) {
            e.state = 'laying';
            e.progress = -1;
            return;
          }
          if (done === undefined) {
            if (!this.spend(army, this.econ.railCost, 0, e.plane)) return this.clearOrder(e);
            done = 0;
          }
          done++;
          e.state = 'laying';
          e.progress = Math.min(1, done / this.econ.railTicks);
          this.railWork.set(key, done);
          if (done < this.econ.railTicks) return;
          e.progress = -1;
          this.laidRails[this.laidRailCount++] = here;
          this.fxAdd('rail', 'depths', cellCentreX(here, this.size), cellCentreY(here, this.size), army, false, { side: army });
          return;
        }
        if (here === o.c && centred) return this.clearOrder(e);
        if (!e.path || e.navGoal !== o.c) if (!this.planDepths(e, o.c, false)) return this.clearOrder(e);
        const r = this.followDepths(e, false);
        e.state = 'moving';
        if (r === NAV_BLOCKED && !this.planDepths(e, o.c, false)) return this.clearOrder(e);
        return;
      }
      case 'breach': {
        const r = e.state === 'breaching' ? NAV_ARRIVED : this.navTo(e, cellCentreX(o.c, this.size), cellCentreY(o.c, this.size));
        if (r === NAV_BLOCKED || this.block[o.c] || !isOpenCell(this.cells[o.c]!)) return this.clearOrder(e);
        if (r === NAV_MOVING) {
          e.state = 'moving';
          return;
        }
        e.state = 'breaching';
        e.workT++;
        e.progress = Math.min(1, e.workT / this.econ.breachTicks);
        if (!o.felt) {
          // One warning per breach site, however many troopers dig there: to every hostile army whose vision group
          // feels or sees the site (the audience is built only on the tick it is first sensed).
          let audience: Army[] | undefined;
          for (const a of this.allArmies) {
            if (!this.hostile(army, a)) continue;
            const bit = this.armies[a]!.group.bit;
            if ((this.feel[o.c]! & bit) !== 0 || (this.vis[PLANE_INDEX.surface]![o.c]! & bit) !== 0) (audience ??= []).push(a);
          }
          if (audience) {
            for (const u of this.ents) if (u.side === army && u.order.k === 'breach' && u.order.c === o.c) u.order.felt = true;
            this.emit(audience, 'breach_tremor', 'depths', cellCentreX(o.c, this.size), cellCentreY(o.c, this.size), e.kind, army);
          }
        }
        if (e.workT < this.econ.breachTicks) return;
        // A structure the troopers could not know about stands over the spot: they cannot dig up there.
        if (this.structureOver(o.c)) {
          for (const u of this.ents) if (u.side === army && u.order.k === 'breach' && u.order.c === o.c) this.clearOrder(u);
          return;
        }
        // Opens after every unit has decided (Sim.openBreakouts); fellow diggers finishing the same site add nothing.
        if (!this.breakouts.includes(army * this.n + o.c)) this.breakouts.push(army * this.n + o.c);
        return;
      }
      case 'bridge': {
        const c = o.c;
        // A lava-lake cell gets a lava bridge; a hole is backfilled. Each has its own price and time.
        const lake = this.cells[c] === CELL.lake;
        if (!(lake ? this.lavaBridgeable(c, this.cells) : this.backfillable(c))) return this.clearOrder(e);
        // One paid job per cell and army: further diggers join it for free (and speed it up).
        const key = army * this.n + c;
        if (!o.working) {
          if (!e.path && !this.planBeside(e, c)) return this.clearOrder(e);
          const r = this.followDepths(e, true);
          if (r === NAV_MOVING) {
            if (e.state !== 'digging') e.state = 'moving';
            return;
          }
          if (r === NAV_BLOCKED) {
            e.path = null;
            return;
          }
          if (!this.bridgeWork.has(key)) {
            if (!this.spend(army, lake ? this.econ.lavaBridgeCost : this.econ.bridgeCost, 0, e.plane)) return this.clearOrder(e);
            this.bridgeWork.set(key, 0);
          }
          o.working = true;
        }
        const ticks = lake ? this.econ.lavaBridgeTicks : this.econ.bridgeTicks;
        const done = (this.bridgeWork.get(key) ?? 0) + 1;
        e.state = 'bridging';
        e.progress = Math.min(1, done / ticks);
        if (done < ticks) {
          this.bridgeWork.set(key, done);
          return;
        }
        const x = cellCentreX(c, this.size);
        const y = cellCentreY(c, this.size);
        if (lake) {
          // The deck opens after every unit has decided (Sim.openLavaBridges); only who sees it learns of it.
          if (!this.lavaBridged.includes(key)) this.lavaBridged.push(key);
        } else {
          // The surface closes after every unit has decided (Sim.closeBridges), as breakouts open.
          if (!this.bridged.includes(c)) this.bridged.push(c);
          this.fxAdd('bridge', 'surface', x, y, army, true, { side: army, tp: 'depths' });
          this.emit(this.allArmies, 'hole_bridged', 'surface', x, y, 'digger', army);
        }
        for (const u of this.ents) if (u.order.k === 'bridge' && u.order.c === c && u !== e) this.clearOrder(u);
        return this.clearOrder(e);
      }
      case 'transfer': {
        // The Shaft may fall, change hands or seal while the troopers walk: they stop rather than step through nothing.
        const s = this.alive(o.shaft);
        if (!s || !this.shaftPortal(army, s)) return this.clearOrder(e);
        // A Shaft body keeps surface units off its centre (separation): walk to open ground beside it; touching it is arriving.
        let gx = s.x;
        let gy = s.y;
        if (e.plane === 'surface') {
          const edge = this.openSurfaceNear(s.x, s.y, s.radius + this.econ.transferEdge, army, e.x, e.y);
          if (!edge) return this.clearOrder(e);
          gx = edge.x;
          gy = edge.y;
        }
        const r = this.navTo(e, gx, gy);
        if (r === NAV_BLOCKED) return this.clearOrder(e);
        e.state = 'moving';
        const reach = e.plane === 'surface' ? e.radius + s.radius + this.econ.transferPadReach : this.econ.transferReachOther;
        if (norm(e.x - s.x, e.y - s.y) > reach && r !== NAV_ARRIVED) return;
        this.startTransit(e, o.to === 'depths' ? TRANSITS.descend : TRANSITS.emerge, s.x, s.y);
        return this.clearOrder(e);
      }
      case 'convert': {
        // Walk to the doorstep of an own built Drill Yard and wait there: updateConversions takes the line in by serial.
        const yard = this.alive(o.yard);
        if (!yard || yard.kind !== 'drill_yard' || yard.side !== army || !yard.built || yard.hp <= 0 || e.kind !== 'trooper' || e.plane !== 'surface') return this.clearOrder(e);
        if (o.at) {
          e.state = 'idle';
          return;
        }
        const edge = this.openSurfaceNear(yard.x, yard.y, yard.radius + this.econ.transferEdge, army, e.x, e.y);
        if (!edge) return this.clearOrder(e);
        const r = this.navTo(e, edge.x, edge.y);
        if (r === NAV_BLOCKED) return this.clearOrder(e);
        e.state = 'moving';
        if (norm2(e.x - yard.x, e.y - yard.y) > sq(e.radius + yard.radius + this.econ.transferPadReach) && r !== NAV_ARRIVED) return;
        o.at = true;
        e.state = 'idle';
        return;
      }
      case 'hangar': {
        const aerie = this.alive(o.target);
        if (!aerie || aerie.side !== e.side || aerie.kind !== 'aerie' || !aerie.built) return this.clearOrder(e);
        e.state = 'moving';
        this.navTo(e, aerie.x, aerie.y, this.econ.aerieDockRadius / 2);
        if (norm2(e.x - aerie.x, e.y - aerie.y) <= sq(this.econ.aerieDockRadius)
          && Math.abs(e.elevation - aerie.elevation) <= MOORING_CAPTURE_HEIGHT && this.armies[e.side]!.powered) this.houseAircraft(e, aerie);
        return;
      }
      case 'capture': {
        const isl = this.alive(o.island);
        if (!isl) return this.clearOrder(e);
        const d = norm(e.x - isl.x, e.y - isl.y);
        // Station-keeping: match the island's exact orbital velocity, plus an approach that slows to nothing once the
        // unit is captureSlack inside the capture radius (one smooth law, no mode switch).
        // The island's orbital velocity: its orbit leader's, turned like its position (see placeIsland).
        const r = isl.seq % this.sides;
        const primary = r === 0 ? isl : this.byId.get(isl.id - r)!;
        const a = primary.orbitA0 + primary.orbitW * (this.tick - isl.orbitDelay);
        const drift = isl.mooringPhase ? 0 : isl.orbitW;
        const cvx = -dmath.sin(a) * isl.orbitR * drift;
        const cvy = dmath.cos(a) * isl.orbitR * drift;
        const ivx = rotVX(r * this.slotStep, cvx, cvy);
        const ivy = rotVY(r * this.slotStep, cvx, cvy);
        const left = d - (this.econ.captureRadius - this.econ.captureSlack);
        let vx = ivx;
        let vy = ivy;
        if (left > 0 && d > GEOM_EPS) {
          const s = Math.min(Math.max(0, this.speedOf(e, isl.x - e.x, isl.y - e.y) - norm(ivx, ivy)), Math.sqrt((2 * this.baseSpeed(e) * left) / this.econ.moveRamp), left);
          vx -= ((e.x - isl.x) / d) * s;
          vy -= ((e.y - isl.y) / d) * s;
        }
        this.drive(e, vx, vy);
        e.state = d <= this.econ.captureRadius && Math.abs(e.elevation - isl.elevation) <= MOORING_CAPTURE_HEIGHT ? 'capturing' : 'moving';
        return;
      }
      case 'mine_asteroid':
        return this.updateAsteroidMine(e, o);
      case 'grapple': {
        // A drifting asteroid, or the derelict core wherever it rests.
        const a = this.alive(o.asteroid);
        if (!a || (a.kind === 'core' ? a.state !== 'idle' : a.state !== 'drifting' || a.miningTug !== 0) || e.link) return this.clearOrder(e);
        e.state = 'grappling';
        this.navTo(e, a.x, a.y);
        // Core and rock latch races resolve after every tug has moved.
        return;
      }
      case 'intercept': {
        let best: Ent | undefined;
        let bd = Infinity;
        for (const a of this.ents) {
          if (!this.payloads[a.kind]?.interceptable || a.state !== 'falling' || a.dead || !(a.side === NEUTRAL || this.hostile(army, a.side))) continue;
          const d = norm(a.x - e.x, a.y - e.y);
          if (d < bd) {
            bd = d;
            best = a;
          }
        }
        if (best) {
          e.state = 'attacking';
          // Close in on the rock (heading along its fall toward the impact point) and hover interceptHover × range from it.
          this.navTo(e, best.x, best.y, this.stat(e).range * this.econ.interceptHover);
        } else {
          // Hover on the map-centre side of the own Spire: (+1, +1) in the army's frame.
          const p = this.spireAt[army]!;
          e.state = this.navTo(e, p.x + rotVX(e.frame, 1, 1), p.y + rotVY(e.frame, 1, 1)) === NAV_MOVING ? 'moving' : 'idle';
        }
        return;
      }
      case 'vent':
        return this.updateVent(e, o);
    }
  }

  /** The current order is done (or impossible): continue with the next queued order, else idle. */
  clearOrder(this: Sim, e: Ent): void {
    this.detachMining(e);
    this.releaseDesignation(e);
    e.order = e.queue.shift() ?? NONE;
    e.path = null;
    e.navGoal = GOAL_NONE;
    e.workT = 0;
    e.engage = 0;
    e.aimTarget = 0;
    e.faceTarget = 0;
    e.firing = false;
    e.anchored = false;
    if (e.state !== 'towing') e.progress = -1;
  }

  /** Replace (or with `queued`, append to) a unit's orders. */
  order(this: Sim, e: Ent, o: Order, queued = false): void {
    if (queued && (e.order.k !== 'none' || e.queue.length > 0)) {
      if (e.queue.length < ORDER_QUEUE) e.queue.push(o);
      return;
    }
    this.detachMining(e);
    this.releaseDesignation(e);
    // A real order lifts a `deploy` off fold: the unit deploys by itself again once it comes to rest.
    if (o.k !== 'none') e.folded = false;
    e.queue = [];
    e.order = o;
    e.path = null;
    e.pathI = 0;
    e.navGoal = GOAL_NONE;
    e.workT = 0;
    e.engage = 0;
    e.aimTarget = 0;
    e.faceTarget = 0;
    e.firing = false;
    e.anchored = false;
    e.evading = false;
    e.progress = -1;
  }

  setAnchor(this: Sim, e: Ent): void {
    e.ax = e.x;
    e.ay = e.y;
    e.anchored = true;
  }
}
