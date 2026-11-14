/** Combat: targeting, ranges and line of fire, aiming, weapons fire, projectiles, damage and death. */
import {
  ACQUIRE_RANGE,
  type Armor,
  canHitPlane,
  DAMAGE_VS,
  footprintDistance,
  isIslandBuild,
  isNeutralKind,
  type Kind,
  MAX_ARMIES,
  type Plane,
  PLANES,
  SPIRE_CORNER,
  isSurfaceHigh,
  TICK_RATE,
  type Weapon,
} from '../rules/contract.ts';
import { cellOfEnt, clampPos, quantize } from '../util/grid.ts';
import { norm, sq, TAU, wrapPi } from '../util/math.ts';
import { type Army, armyBit, canonVX, canonVY, isArmy, NEUTRAL, sectorOf, type SideId } from '../util/teams.ts';
import {
  ACQUIRE_SEARCH_MARGIN,
  BUCKET,
  DEPLOY_NONE,
  DEPLOY_UP,
  LOS_GRACE,
  MAX_BODY_RADIUS,
  NAV_BLOCKED,
  PLANE_INDEX,
  RANGE_MARGIN,
  SNAP_EPS,
  SPIRE_ALERT_EVERY,
  TARGET_RANK_STRUCTURE,
  TARGET_RANK_UNIT,
} from './constants.ts';
import { Ent } from './ent.ts';
import type { Projectile } from './state.ts';
import type { Sim } from './sim.ts';
import { recordDamage } from './recording.ts';
import { dmath } from '../util/fdlibm.js';

/**
 * Rock-borne damage causes: impacts (asteroid and core drops, already × rules.spire.impactMultiplier on segments) and
 * volatile asteroid detonations. Sudden death leaves them at their own rate, so armies end the match, not rocks.
 */
const ROCK_BORNE: Readonly<Record<string, true>> = { impact: true, core_drop: true, volatile_detonation: true };

/** Cosine of half of each cone width (degrees) a mount test has met: the widths are a handful of rule values. */
const HALF_CONE_COS = new Map<number, number>();
const halfConeCos = (arc: number): number => {
  let c = HALF_CONE_COS.get(arc);
  if (c === undefined) HALF_CONE_COS.set(arc, c = dmath.cos(arc * Math.PI / 360));
  return c;
};

export class SimCombat {
  /** Is `e` standing on high ground (surface)? */
  onHigh(this: Sim, e: Ent): boolean {
    return e.plane === 'surface' && isSurfaceHigh(this.terrain[cellOfEnt(e, this.size)]!);
  }

  /**
   * Direct fire between two surface entities needs line of sight: cliffs block it, unless either end stands on high
   * ground (it looks over the cliffs), or the shooter is in an indirect-fire stance (a sieged tank) and its team sees
   * the target, or a Spire segment answers such a stance (whatever shells the Spire over a cliff is shelled back).
   * Other planes always see.
   */
  lineOfFire(this: Sim, e: Ent, t: Ent): boolean {
    // A distant scout cannot extend the segment's own night-side sensor. A scan/ping can.
    if (e.kind === 'spire' && e.plane === 'orbit' && t.plane === 'orbit' && t.unit
      && !this.lit(t.x, t.y) && !this.scanned(e.side, t.x, t.y)
      && !(t.cloaked && this.detectsCloak(e.side, t))
      && !this.segmentSenses(e, t.x, t.y)) return false;
    // Storms hide Sky targets from fire below and above (flak, turrets, Orbit) unless scanned; Spire beams and
    // in-plane fire ignore them.
    if (t.plane === 'sky' && (e.plane === 'orbit' || e.kind === 'flak' || e.kind === 'turret') && this.stormAt(t.x, t.y) && !this.scanned(e.side, t.x, t.y)) return false;
    if (e.plane === 'orbit' && t.plane === 'orbit' && !this.derelictClear(e, t)) return false;
    return e.plane !== 'surface' || t.plane !== 'surface' || this.onHigh(e) || this.onHigh(t) || this.los.visible(cellOfEnt(e, this.size), cellOfEnt(t, this.size))
      || (this.deployedSpec(e)?.range?.indirect === true && this.sees(e.side, t))
      || (e.kind === 'spire' && this.deployedSpec(t)?.range?.indirect === true);
  }

  canHit(this: Sim, e: Ent, plane: Plane): boolean {
    if (e.hangar || e.transitKind?.stationary) return false;
    return canHitPlane(e.kind, e.plane, plane, e.transitKind?.reach ? e.transitKind : undefined, plane === 'sky' && e.plane === 'orbit' && this.capable(e, 'lens'));
  }

  /**
   * Is `e` beaming the `plane` below through a Lancer Lens? The only Orbit beam canHit lets reach the Sky (point
   * defence is not a beam; the segment beam stays in Orbit): it reaches rules.orbit.lensReach (in place of its range)
   * and deals lensDamageMultiplier. Callers have checked canHit.
   */
  lensShot(this: Sim, e: Ent, plane: Plane): boolean {
    return plane === 'sky' && e.plane === 'orbit' && this.statsOf(e)?.weapon === 'beam';
  }

  armed(this: Sim, e: Ent): boolean {
    return e.built && this.stat(e).dmg > 0;
  }

  /**
   * Weapon reach to `t`: range measured to the target's edge (+ high ground, + cover, + `rangeBonus`: a deployed
   * stance's absolute reach, the mobile tank's structure bonus, flak against falling payloads). Spire beams measure to
   * units from their own footprint edge (the mirror of a unit shooting the Spire), so a unit gains nothing on the
   * footprint's diagonal. Structures keep the centre measure: relays riding the outer island ring stay outside the Sky
   * beam at the default Spire inset (DESIGN §2.3 Spire inset).
   */
  reach(this: Sim, e: Ent, t: Ent): number {
    if (e.kind === 'island_mortar') return this.stat(e).range;
    const d = norm(t.x - e.x, t.y - e.y);
    const edge = t.structure ? d - footprintDistance(t.kind, t.x, t.y, e.x, e.y)
      : t.radius + (e.kind === 'spire' ? d - footprintDistance('spire', e.x, e.y, t.x, t.y) : 0);
    return (this.lensShot(e, t.plane) ? this.econ.lensReach : this.stat(e).range) + edge + (this.onHigh(e) ? this.econ.highRange : 0) + this.coverRange(e) + this.rangeBonus(e, t);
  }

  /**
   * Range against `t` on top of stats range (tiles; may be negative). A fully deployed stance with a `range` replaces
   * stats range with its absolute reach against structures or units (a sieged tank: siegeRangeStructures and
   * siegeRangeUnits; emplaced flak: emplacedFlakRange). Against Spire segments a sieged tank's reach is capped at
   * siegeSpireRange, measured like the beam (footprint edge to the tank's body edge) and absolute: the high ground and
   * cover terms `reach` adds are taken back out, so a segment beam of at least that range answers every tank that
   * shells it (DESIGN §4.2 Siege). A mobile tank (cannon) shells structures from econ.siegeRange further out, except
   * Spire segments: the segment beam, measured from the footprint edge, then out-reaches a mobile tank at every
   * bearing, so a lone Spire fights back. Flak gains flakPayloadRange against falling payloads, on top of either.
   * Gun Platforms add their emplace bonus here so reach, acquisition and its spatial search agree.
   */
  rangeBonus(this: Sim, e: Ent, t: Ent): number {
    const range = this.deployedSpec(e)?.range;
    if (range?.spire && t.kind === 'spire') {
      return this.econ[range.spire] + e.radius - this.stat(e).range - (this.onHigh(e) ? this.econ.highRange : 0) - this.coverRange(e);
    }
    const weapon = this.statsOf(e)?.weapon;
    let bonus = range ? this.econ[t.structure ? range.structures : range.units] - this.stat(e).range
      : t.structure && t.kind !== 'spire' && weapon === 'cannon' ? this.econ.siegeRange : 0;
    if (weapon === 'flak' && t.state === 'falling' && this.payloads[t.kind]) bonus += this.econ.flakPayloadRange;
    if (e.kind === 'gun_platform') bonus += this.econ.emplaceRangeBonus;
    return bonus;
  }

  /** The largest `rangeBonus` `e` can have against anything (spatial search margin). */
  maxRangeBonus(this: Sim, e: Ent): number {
    const range = this.deployedSpec(e)?.range;
    const weapon = this.statsOf(e)?.weapon;
    const bonus = range ? Math.max(this.econ[range.structures], this.econ[range.units], range.spire ? this.econ[range.spire] + e.radius : 0) - this.stat(e).range
      : weapon === 'cannon' ? this.econ.siegeRange : 0;
    return Math.max(0, bonus) + (weapon === 'flak' ? this.econ.flakPayloadRange : 0) + (e.kind === 'gun_platform' ? this.econ.emplaceRangeBonus : 0);
  }

  /** Is `t` inside a deployed stance's minimum range (a sieged tank's siegeMinRange), measured to `t`'s edge? */
  tooClose(this: Sim, e: Ent, t: Ent): boolean {
    const min = this.deployedSpec(e)?.range?.min;
    if (!min) return false;
    const edge = t.structure ? footprintDistance(t.kind, t.x, t.y, e.x, e.y) : norm(t.x - e.x, t.y - e.y) - t.radius;
    return edge < this.econ[min];
  }

  inRange(this: Sim, e: Ent, t: Ent): boolean {
    const r = this.reach(e, t);
    const dx = e.x - t.x;
    const dy = e.y - t.y;
    return dx * dx + dy * dy <= r * r && !this.tooClose(e, t) && this.lineOfFire(e, t);
  }

  /** Distance to `t` at which `e` plants and starts firing (chasers slow down to stop there). */
  firingDistance(this: Sim, e: Ent, t: Ent): number {
    return Math.max(this.econ.minFiringRange, this.reach(e, t) - RANGE_MARGIN) - SNAP_EPS;
  }

  /**
   * Range hysteresis: a unit closes to RANGE_MARGIN inside max range before it plants and fires, then keeps
   * firing until the target leaves max range. True while the unit should stand still.
   */
  holdRange(this: Sim, e: Ent, t: Ent): boolean {
    const d = norm(e.x - t.x, e.y - t.y);
    const r = this.reach(e, t);
    if (e.firing ? d <= r : d <= Math.max(this.econ.minFiringRange, r - RANGE_MARGIN)) {
      // A planted unit that loses its line of fire (someone stepped behind a cliff corner) keeps its spot a moment.
      const clear = this.lineOfFire(e, t);
      if (clear || (e.firing && ++e.blind < LOS_GRACE)) {
        if (clear) e.blind = 0;
        e.firing = true;
        e.state = 'attacking';
        // A held firing position is not an active tunnel traversal. Leaving the chase path here
        // would exempt stacked fighters from separation forever (and prevent safe shield deployment).
        if (e.plane === 'depths') e.path = null;
        return true;
      }
    }
    e.firing = false;
    e.blind = 0;
    return false;
  }

  /**
   * A travelling fight-move only stops for enemies ahead, or same-plane bodies within one tile of contact.
   * Cross-plane overlap is not contact: a bomber must be able to leave the building beneath it.
   * Other orders (including idle after arrival) keep all-direction acquisition.
   */
  onMoveFront(this: Sim, e: Ent, t: Ent): boolean {
    const o = e.order;
    if (o.k !== 'move' || !o.fight) return true;
    const dx = t.x - e.x;
    const dy = t.y - e.y;
    const contact = e.radius + t.radius + this.econ.moveFrontContact;
    if (e.plane === t.plane && dx * dx + dy * dy <= contact * contact) return true;
    const forward = dx * (o.x - e.x) + dy * (o.y - e.y);
    // A target directly underneath has no heading; leave it rather than pinning air at zero horizontal distance.
    return forward >= 0 && (e.plane === t.plane || dx * dx + dy * dy > SNAP_EPS * SNAP_EPS);
  }

  /** Plain movement never engages/steers for combat. Only its weapon mount may accept a target. */
  onMoveMount(this: Sim, e: Ent, t: Ent): boolean {
    if (e.order.k !== 'move' || e.order.fight) return true;
    const weapon = this.statsOf(e)?.weapon;
    const mount = e.mount;
    if (!mount || mount.kind === 'fixed') return false;
    if (mount.kind === 'turret') return true;
    // In the owner's frame (its heading's frame): rotated units test rotated cones alike.
    const dx = canonVX(e.frame, t.x - e.x, t.y - e.y);
    const dy = canonVY(e.frame, t.x - e.x, t.y - e.y);
    const distance = norm(dx, dy);
    // Bomb racks release only over the target on the run, not from stand-off range.
    if (weapon === 'bomb' && (t.structure ? footprintDistance(t.kind, t.x, t.y, e.x, e.y) : distance - t.radius) > this.econ.bombRelease) return false;
    return dx * dmath.cos(e.heading) + dy * dmath.sin(e.heading) >= distance * halfConeCos(mount.arc) - SNAP_EPS;
  }

  /** Slew in the owner's frame, with a consistent half-turn tie-break (signed zeros folded) for exact rotations. */
  aimAt(this: Sim, e: Ent, t: Ent): boolean {
    const mount = e.mount;
    if (mount?.kind !== 'turret') return true;
    const goal = dmath.atan2(canonVY(e.frame, t.x - e.x, t.y - e.y) || 0, canonVX(e.frame, t.x - e.x, t.y - e.y) || 0);
    // Existing fighting orders retain their firing timing. Traverse is the cost of passing fire, not
    // a balance change to attack-move, explicit attacks, patrols, stationary defence or the Spire.
    if (e.order.k !== 'move' || e.order.fight) {
      e.aim = goal;
      return true;
    }
    const delta = wrapPi((goal - e.aim) % TAU);
    const step = mount.traverse / TICK_RATE;
    e.aim = wrapPi(e.aim + Math.max(-step, Math.min(step, delta)));
    return Math.abs(delta) <= step + SNAP_EPS;
  }

  /**
   * Bring a fixed or forward mount's body to bear on `t` and say whether `t` is inside the mount's cone (forward: its
   * arc; fixed: fixedMountArc) around the body heading. Orbit hulls turn at their turn rate, whatever their velocity;
   * a flyer in motion faces its flight path; other bodies (infantry, diggers, the Spire, a hovering flyer) face at once.
   */
  faceAt(this: Sim, e: Ent, t: Ent, i: number): boolean {
    const mount = e.mount!;
    const dx = canonVX(e.frame, t.x - e.x, t.y - e.y);
    const dy = canonVY(e.frame, t.x - e.x, t.y - e.y);
    const distance = norm(dx, dy);
    if (distance > SNAP_EPS) {
      const goal = dmath.atan2(dy, dx);
      const turn = e.plane === 'orbit' ? this.statsOf(e)?.orbitTurnRate : undefined;
      if (turn !== undefined) {
        const delta = wrapPi((goal - e.heading) % TAU);
        const step = turn / TICK_RATE;
        e.heading = wrapPi(e.heading + Math.max(-step, Math.min(step, delta)));
      } else if (!(mount.kind === 'forward' && i < this.movedCount && this.moved[i])) {
        // Square on: the cone test below is distance·(1 − cos ≥ 0) + SNAP_EPS clear of failing, far above rounding.
        e.heading = goal;
        return true;
      }
    }
    const cone = mount.kind === 'forward' ? mount.arc : this.econ.fixedMountArc;
    return dx * dmath.cos(e.heading) + dy * dmath.sin(e.heading) >= distance * halfConeCos(cone) - SNAP_EPS;
  }

  /**
   * Fight logic for armed units (idle, fight-move, patrol): keep or pick a target near the unit, stand and shoot
   * when in range, chase it while it stays within `leash` of the anchor. True while engaged (the unit is busy).
   */
  engageNearby(this: Sim, e: Ent, leash: number): boolean {
    if (!this.armed(e) || this.capable(e, 'carry')) return false;
    const army = e.side;
    const range = this.stat(e).range + this.coverRange(e);
    let t = e.engage ? this.alive(e.engage) : undefined;
    if (t && (!this.isTarget(e, t) || !this.canHit(e, t.plane) || !this.sees(army, t) || !this.onMoveFront(e, t))) t = undefined;
    if (t && e.anchored && norm(t.x - e.ax, t.y - e.ay) > leash + this.reach(e, t)) t = undefined;
    // Something already in range beats chasing the current target.
    if (t && !this.inRange(e, t)) t = this.acquire(e, range, false) ?? t;
    if (!t) {
      t = this.acquire(e, leash > 0 ? range + ACQUIRE_RANGE : range, false);
      if (t && e.anchored && norm(t.x - e.ax, t.y - e.ay) > leash + this.reach(e, t)) t = undefined; // out of leash
      if (t && !e.anchored) this.setAnchor(e);
    }
    e.engage = t?.id ?? 0;
    if (!t) {
      e.firing = false;
      return false;
    }
    if (this.holdRange(e, t)) return true;
    if (leash <= 0) {
      e.engage = 0;
      return false;
    }
    const result = e.plane === 'orbit' ? this.approach(e, t) : this.navTo(e, t.x, t.y, this.firingDistance(e, t));
    if (result === NAV_BLOCKED) {
      // An unreachable automatic target must not consume the order forever: next tick acquisition may pick
      // the same target again (for example a surviving Spire over a crater), but the unit can still leave.
      e.engage = 0;
      return false;
    }
    e.state = 'attacking';
    return true;
  }

  buildIndex(this: Sim): void {
    const ents = this.ents;
    if (this.bucketNext.length < ents.length) this.bucketNext = new Int32Array(ents.length * 2);
    this.bucketHead.fill(-1);
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      e.slot = i;
      if (e.dead || e.hangar) continue;
      const b = PLANE_INDEX[e.plane] * this.bucketCount + Math.min(this.bucketWidth - 1, (e.y / BUCKET) | 0) * this.bucketWidth + Math.min(this.bucketWidth - 1, (e.x / BUCKET) | 0);
      this.bucketNext[i] = this.bucketHead[b]!;
      this.bucketHead[b] = i;
    }
  }

  /**
   * Shared by explicit fire, automatic acquisition and projectiles; neutrals cannot hide a hostile tug. A falling
   * payload is a target unless an army that is not hostile (own or allied) dropped it; neutral rocks stay targets.
   */
  payloadTarget(this: Sim, t: Ent, side: SideId, weapon: Weapon | undefined, plane: Plane): boolean {
    const drop = this.payloads[t.kind];
    if (!drop?.interceptable) return false;
    if (t.state === 'falling') return t.side === NEUTRAL ? side !== NEUTRAL : this.hostile(side, t.side);
    if (t.state !== 'towed' || t.plane !== 'orbit' || plane !== 'orbit' || !t.link) return false;
    if (t.kind === 'asteroid' && !t.volatile && weapon !== 'point_defence') return false;
    const tug = this.alive(t.link);
    return !!tug && this.hostile(side, tug.side);
  }

  /**
   * Does weapon `w` leave `t` alone as an island structure (Relay, Aerie, Storm Seeder, Stormcatcher)? Flak and
   * turrets never target or splash them unless rules.sky.groundHitsIslandStructures; Gun Platforms are `heavy_air`.
   */
  groundSpares(this: Sim, w: Weapon | undefined, t: Ent): boolean {
    return (w === 'flak' || w === 'turret') && !this.econ.groundHitsIslandStructures && isIslandBuild(t.kind);
  }

  isTarget(this: Sim, e: Ent, t: Ent): boolean {
    if (t.dead || t.hp <= 0 || t.hangar || t.kind === 'island' || t.kind === 'post') return false;
    // The Lens beams Sky units only: island structures and payloads falling through the Sky stay out of its reach.
    if (!t.unit && this.lensShot(e, t.plane)) return false;
    if (this.groundSpares(this.statsOf(e)?.weapon, t)) return false;
    const drop = this.payloads[t.kind];
    if (drop) return this.payloadTarget(t, e.side, this.statsOf(e)?.weapon, e.plane);
    if (t.plane !== e.plane && this.statsOf(e)?.weapon === 'point_defence') return false;
    return this.hostile(e.side, t.side);
  }

  /**
   * Best target within `radius` (to its edge) via the spatial index, skipping targets already doomed by damage in
   * flight. Priority: things that can shoot back at us, then other units, then structures; nearest first.
   * `fromFootprint`: measure `radius` to units from the shooter's footprint edge (Spire beams, as in `reach`).
   */
  acquire(this: Sim, e: Ent, radius: number, fromFootprint: boolean): Ent | undefined {
    const army = e.side;
    const passingForward = e.order.k === 'move' && !e.order.fight && e.mount?.kind === 'forward';
    let best: Ent | undefined;
    let bestScore = Infinity;
    const margin = ACQUIRE_SEARCH_MARGIN + this.maxRangeBonus(e) + (fromFootprint ? SPIRE_CORNER : 0);
    for (const plane of PLANES) {
      if (!this.canHit(e, plane)) continue;
      // `radius` is weapon range plus any chase margin: a Lens swaps the range for lensReach and keeps the margin.
      const reach = this.lensShot(e, plane) ? radius - this.stat(e).range + this.econ.lensReach : radius;
      const pb = PLANE_INDEX[plane] * this.bucketCount;
      const r = reach + margin;
      const bx0 = Math.max(0, ((e.x - r) / BUCKET) | 0);
      const bx1 = Math.min(this.bucketWidth - 1, ((e.x + r) / BUCKET) | 0);
      const by0 = Math.max(0, ((e.y - r) / BUCKET) | 0);
      const by1 = Math.min(this.bucketWidth - 1, ((e.y + r) / BUCKET) | 0);
      for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          for (let i = this.bucketHead[pb + by * this.bucketWidth + bx]!; i >= 0; i = this.bucketNext[i]!) {
            const t = this.ents[i]!;
            if (!this.isTarget(e, t) || this.inFlight(t, army) >= t.hp + t.shield || !this.onMoveFront(e, t)) continue;
            const d = norm(t.x - e.x, t.y - e.y);
            if (e.kind === 'island_mortar' && d > this.stat(e).range) continue;
            const edge = t.structure ? footprintDistance(t.kind, t.x, t.y, e.x, e.y)
              : (fromFootprint ? footprintDistance(e.kind, e.x, e.y, t.x, t.y) : d) - t.radius;
            if (edge > reach + this.rangeBonus(e, t) || this.tooClose(e, t) || !this.sees(army, t) || !this.lineOfFire(e, t)) continue;
            if (passingForward && !this.onMoveMount(e, t)) continue;
            const threat = this.payloads[t.kind] || (this.armed(t) && this.canHit(t, e.plane));
            // On the position grid, ties then the lower serial, then (rotated twins of two hostile armies) the
            // relative order from the shooter: the spatial index's storage order is not rotated.
            const score = quantize((threat ? 0 : this.isStructure(t) ? TARGET_RANK_STRUCTURE : TARGET_RANK_UNIT) + d);
            if (score < bestScore || (score === bestScore && best !== undefined && (t.seq < best.seq
              || (t.seq === best.seq && isArmy(t.side) && isArmy(best.side) && this.rel(army, t.side) < this.rel(army, best.side))))) {
              bestScore = score;
              best = t;
            }
          }
        }
      }
    }
    return best;
  }

  armorOf(this: Sim, t: Ent): Armor {
    if (isNeutralKind(t.kind)) return 'air';
    const armor = this.stats[t.kind].armor;
    return armor === 'island' && !this.econ.islandArmorEnabled ? 'structure' : armor;
  }

  /**
   * Damage multiplier of weapon `w` against `t` per hit (direct, splash and in-flight reservations alike): the DAMAGE_VS
   * row for its armor, except a Breacher flamer against a fully dug-in Trooper, which deals
   * rules.surface.breacherDugInMultiplier instead (replacing ×light, no dug-in reduction). A fully deployed stance with
   * a weapon filter (dug in: rifle, cannon, turret) multiplies those weapons' hits by its damageTaken; flak deals
   * ×flakPayloadMultiplier to falling payloads.
   */
  weaponVs(this: Sim, w: Weapon, t: Ent): number {
    if (w === 'flamer' && this.dugIn(t)) return this.econ.breacherDugInMultiplier;
    let m = DAMAGE_VS[w][this.armorOf(t)];
    const spec = this.deployedSpec(t);
    if (spec?.damageTaken && spec.damageFrom?.includes(w)) m *= this.econ[spec.damageTaken];
    if (w === 'flak' && t.state === 'falling' && this.payloads[t.kind]) m *= this.econ.flakPayloadMultiplier;
    return m;
  }

  combat(this: Sim): void {
    const ents = this.ents;
    // One shot row per target (at most every entity), as the spatial index sizes its scratch.
    if (this.shotBase.length < ents.length) {
      this.shotBase = new Float64Array(ents.length * 2);
      this.shotBy = new Uint8Array(ents.length * 2);
      this.shotView = new Float64Array(ents.length * 2 * MAX_ARMIES);
      this.shotFlight = new Float64Array(ents.length * 2 * MAX_ARMIES);
    }
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]!;
      if (e.dead || e.hangar || e.transitKind?.stationary || !e.built || e.hp <= 0 || !isArmy(e.side) || isNeutralKind(e.kind)) continue;
      const stats = this.stat(e);
      if (e.kind === 'spire' && e.plane === 'orbit') {
        if (e.stationPdCd > 0) e.stationPdCd--;
        else if (this.econ.stationPdDamage > 0) {
          const target = this.acquire(e, this.econ.stationPdRange, false);
          if (target) {
            this.fire(e, target, 'point_defence', this.econ.stationPdDamage);
            e.stationPdCd = this.econ.stationPdCooldown;
          }
        }
      }
      if (stats.dmg <= 0) continue;
      if (e.kind === 'turret') {
        // Offline while its army cannot pay the upkeep.
        const on = this.armies[e.side]!.powered;
        e.state = on ? 'active' : 'idle';
        if (!on) continue;
      }
      if (e.cd > 0) {
        e.cd--;
        // Traverse toward the last seen passing target during reload without another bucket acquisition.
        if (e.aimTarget) {
          const target = this.shootable(e, e.aimTarget);
          if (target) this.aimAt(e, target);
          else e.aimTarget = 0;
        }
        // Keep the body (or an Orbit hull) turning onto the target between shots.
        if (e.faceTarget) {
          const target = this.shootable(e, e.faceTarget);
          if (target) this.faceAt(e, target, i);
          else e.faceTarget = 0;
        }
        continue;
      }
      // A stance going up or coming down is the unit's vulnerable window: it holds fire (so does a non-firing stance).
      if (e.deploy !== DEPLOY_NONE && (e.deploy !== DEPLOY_UP || !this.deploySpec(e)!.fires)) continue;
      const plainMove = e.order.k === 'move' && !e.order.fight;
      const mount = e.mount;
      if (plainMove && (!mount || mount.kind === 'fixed')) {
        e.faceTarget = 0;
        continue;
      }
      // Explicit attack target first, then the engaged one, then the best target in range.
      let target = e.order.k === 'attack' ? this.shootable(e, e.order.target) : undefined;
      if (!target && e.engage) target = this.shootable(e, e.engage);
      target ??= this.acquire(e, stats.range + (this.onHigh(e) ? this.econ.highRange : 0) + this.coverRange(e), e.kind === 'spire');
      if (plainMove && mount?.kind === 'turret') e.aimTarget = target?.id ?? 0;
      if (mount && mount.kind !== 'turret') e.faceTarget = target?.id ?? 0;
      if (!target) continue;
      if (mount?.kind === 'turret' ? !this.aimAt(e, target) : mount && !this.faceAt(e, target, i)) continue;
      this.fire(e, target);
      e.cd = this.cooldownOf(e);
      if (e.state === 'idle' && e.kind !== 'spire') e.state = 'attacking';
    }
    // Shooters drop their cloaks only now: one army's earlier shot must not reveal it to another's same-tick targeting.
    for (const e of this.shooters) this.breakCloak(e);
    this.shooters.length = 0;
    // Instant hits land together after everyone has fired: no army gets a first-shot advantage from entity order.
    const passes = this.landingPasses();
    for (let r = 0; r < passes; r++) {
      for (const h of this.hits) {
        if (passes > 1 && this.landingPass(h.t, h.by) !== r) continue;
        h.t.pending = Math.max(0, h.t.pending - h.dmg);
        this.damage(h.t, h.dmg, h.by, false, h.source, h.sourcePlane);
      }
    }
    this.hits.length = 0;
    this.settleShots();
  }

  /**
   * Damage several armies deal one victim on the same tick lands army by army in relative order from the victim's
   * owner (from its map sector when neutral), each army's in fire order: HP rounding and the killing blow follow
   * that order, never the entity order, which differs between rotated twins (DESIGN §15.4). Pass of `by` on `t`.
   */
  landingPass(this: Sim, t: Ent, by: Army): number {
    return isArmy(t.side) ? this.rel(t.side, by) : (this.armySlot[by]! - sectorOf(t.x, t.y, this.size, this.sides) + this.sides) % this.sides;
  }

  /** Landing passes per tick: with two armies every victim takes one army's damage, so one pass in fire order. */
  landingPasses(this: Sim): number {
    return this.allArmies.length > 2 ? this.sides : 1;
  }

  /**
   * Damage in flight toward `t` as `army`'s shooters may count it (overkill prevention): everything fired before this
   * tick plus `army`'s own shots this tick. Another army's same-tick shot stays invisible: the entity order would
   * decide which of two armies shooting one target saw the other's shot, and rotated twins fire in different orders
   * (DESIGN §15.4). With one army shooting a target (every C2 target) this is exactly `pending`.
   */
  inFlight(this: Sim, t: Ent, army: Army): number {
    return t.pendingRow < 0 ? t.pending : this.shotView[t.pendingRow * MAX_ARMIES + army]!;
  }

  /** Book `dmg` of `by`'s shot in flight toward `t` this tick (`flight`: a projectile; instant hits land in `combat`). */
  reserve(this: Sim, t: Ent, by: Army, dmg: number, flight: boolean): void {
    let row = t.pendingRow;
    if (row < 0) {
      row = t.pendingRow = this.shotTargets.length;
      this.shotTargets.push(t);
      this.shotBase[row] = t.pending;
      this.shotBy[row] = 0;
      this.shotView.fill(t.pending, row * MAX_ARMIES, (row + 1) * MAX_ARMIES);
      this.shotFlight.fill(0, row * MAX_ARMIES, (row + 1) * MAX_ARMIES);
    }
    this.shotBy[row]! |= armyBit(by);
    this.shotView[row * MAX_ARMIES + by]! += dmg;
    if (flight) this.shotFlight[row * MAX_ARMIES + by]! += dmg;
    t.pending += dmg;
  }

  /**
   * Close this tick's shot rows once the instant hits have landed. A target several armies shot keeps what was in
   * flight before plus their projectiles, summed army by army in landing-pass order: the fire order, and so the
   * running total's rounding, differs between rotated twins.
   */
  settleShots(this: Sim): void {
    for (let row = 0; row < this.shotTargets.length; row++) {
      const t = this.shotTargets[row]!;
      t.pendingRow = -1;
      const by = this.shotBy[row]!;
      if ((by & (by - 1)) === 0) continue;
      let p = this.shotBase[row]!;
      for (let r = 0; r < this.sides; r++) {
        for (const a of this.allArmies) if (by & armyBit(a) && this.landingPass(t, a) === r) p += this.shotFlight[row * MAX_ARMIES + a]!;
      }
      t.pending = p;
    }
    this.shotTargets.length = 0;
  }

  shootable(this: Sim, e: Ent, id: number): Ent | undefined {
    const t = this.alive(id);
    return t && this.isTarget(e, t) && this.canHit(e, t.plane) && this.sees(e.side, t) && this.inRange(e, t) && this.inFlight(t, e.side) < t.hp + t.shield ? t : undefined;
  }

  /** Instant weapons hit now; the rest launch a projectile that lands after its flight time. */
  fire(this: Sim, e: Ent, t: Ent, weapon?: Weapon, overrideDamage?: number): void {
    const s = this.statsOf(e)!;
    const w = weapon ?? s.weapon ?? 'beam';
    const by = e.side;
    const lens = this.lensShot(e, t.plane);
    const damage = overrideDamage ?? this.stat(e).dmg * (lens ? this.econ.lensDamageMultiplier : 1);
    e.combatAt = this.tick;
    this.shooters.push(e);
    if (lens) this.revealEffect(e, 'capability', 'lens');
    if (this.modifierRows) {
      this.revealEffect(e, 'modifier', 'dmg');
      this.revealEffect(e, 'modifier', 'range');
      this.revealEffect(e, 'modifier', 'cooldown');
    }
    let arrive = this.tick;
    if (s.projectileSpeed <= 0) {
      const dmg = damage * this.weaponVs(w, t);
      this.reserve(t, by, dmg, false);
      this.hits.push({ t, dmg, by, source: e.kind, sourcePlane: e.plane });
      if (w === 'flamer' && s.splash > 0) this.flameCone(e, t, damage, s.splash);
    } else {
      const flight = norm(t.x - e.x, t.y - e.y) / (s.projectileSpeed / TICK_RATE);
      arrive = this.tick + Math.max(e.kind === 'island_mortar' ? this.econ.mortarFlightTicks : 1, Math.ceil(flight));
      const reserved = damage * this.weaponVs(w, t);
      this.reserve(t, by, reserved, true);
      this.projectiles.push({ by, source: e.kind, sourcePlane: e.plane, sourceElevation: e.elevation, targetElevation: t.elevation, w, dmg: damage, splash: s.splash, plane: t.plane, x: t.x, y: t.y, target: t.id, homing: w === 'missile', arrive, reserved });
    }
    const shot = this.fxAdd('shot', e.plane, e.x, e.y, by, false, {
      tp: t.plane,
      tx: clampPos(t.x, this.size),
      ty: clampPos(t.y, this.size),
      sourceElevation: e.elevation,
      targetElevation: t.elevation,
      w,
      side: by,
      subject: e.kind,
      arrive,
      src: e.id,
    });
    shot.tside = t.side;
    shot.tpub = !!this.payloads[t.kind] && t.state === 'falling';
    shot.sourceViewers = 0;
    shot.targetViewers = 0;
    for (const group of this.groups) {
      if (this.sees(group.armies[0]!, e)) shot.sourceViewers |= group.bit;
      if (this.sees(group.armies[0]!, t)) shot.targetViewers |= group.bit;
    }
  }

  /**
   * Land projectiles due this tick, together: each victim takes them in its landing passes (`landingPass`).
   * Missiles home onto their target; shells, bombs, flak and turret bolts burst at the aim point, so a target that
   * moved away (fast air) is missed by everything but the splash.
   */
  landProjectiles(this: Sim): void {
    if (this.projectiles.length === 0) return;
    const all = this.projectiles;
    const passes = this.landingPasses();
    for (let r = 0; r < passes; r++) for (const p of all) if (p.arrive <= this.tick) this.landProjectile(p, passes > 1 ? r : -1);
    let keep = 0;
    for (const p of all) if (p.arrive > this.tick) all[keep++] = p;
    all.length = keep;
  }

  /** Land `p` on its victims of landing pass `pass` (−1: on every victim). */
  landProjectile(this: Sim, p: Projectile, pass: number): void {
    const t = this.byId.get(p.target);
    if (t && (pass < 0 || this.landingPass(t, p.by) === pass)) {
      t.pending = Math.max(0, t.pending - p.reserved);
      if (p.homing && !t.dead && t.hp > 0) this.damage(t, p.dmg * this.weaponVs(p.w, t), p.by, false, p.source, p.sourcePlane);
    }
    if (p.homing) return;
    const pb = PLANE_INDEX[p.plane] * this.bucketCount;
    const r = Math.max(p.splash, this.econ.directHit) + MAX_BODY_RADIUS;
    const bx0 = Math.max(0, ((p.x - r) / BUCKET) | 0);
    const bx1 = Math.min(this.bucketWidth - 1, ((p.x + r) / BUCKET) | 0);
    const by0 = Math.max(0, ((p.y - r) / BUCKET) | 0);
    const by1 = Math.min(this.bucketWidth - 1, ((p.y + r) / BUCKET) | 0);
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let i = this.bucketHead[pb + by * this.bucketWidth + bx]!; i >= 0; i = this.bucketNext[i]!) {
          const v = this.ents[i]!;
          if (v.dead || v.hp <= 0 || v.kind === 'island' || v.kind === 'post' || v.plane !== p.plane) continue;
          const drop = this.payloads[v.kind];
          // No friendly fire: splash skips every army that is not hostile (own and allied), as it skips own units.
          if (drop ? !this.payloadTarget(v, p.by, p.w, p.plane) : !this.hostile(p.by, v.side)) continue;
          if (this.groundSpares(p.w, v)) continue;
          if (pass >= 0 && this.landingPass(v, p.by) !== pass) continue;
          const d = v.structure ? footprintDistance(v.kind, v.x, v.y, p.x, p.y) : Math.max(0, norm(v.x - p.x, v.y - p.y) - v.radius);
          const direct = v.id === p.target && d <= this.econ.directHit;
          if (direct) this.damage(v, p.dmg * this.weaponVs(p.w, v), p.by, false, p.source, p.sourcePlane);
          else if (p.splash > 0 && d <= p.splash) this.damage(v, p.dmg * this.econ.splashFactor * this.weaponVs(p.w, v), p.by, false, p.source, p.sourcePlane);
        }
      }
    }
  }

  /**
   * Breacher flame splash, landing with the instant hits: hostile bodies on the target's plane within `reach` tiles
   * (to their edge) of the target AND inside the rules.surface.breacherConeArc cone (full width) around the
   * shooter→target bearing take splashFactor × the shot at the flamer's multiplier. Only forward: nothing beside or
   * behind the Breacher burns. The cone test compares dot products of world differences, exact under quarter turns.
   */
  flameCone(this: Sim, e: Ent, t: Ent, damage: number, reach: number): void {
    const ax = t.x - e.x;
    const ay = t.y - e.y;
    const al = norm(ax, ay);
    if (al <= 0) return;
    const cos = halfConeCos(this.econ.breacherConeArc);
    const by = e.side as Army;
    const pb = PLANE_INDEX[t.plane] * this.bucketCount;
    const r = reach + MAX_BODY_RADIUS;
    const bx0 = Math.max(0, ((t.x - r) / BUCKET) | 0);
    const bx1 = Math.min(this.bucketWidth - 1, ((t.x + r) / BUCKET) | 0);
    const by0 = Math.max(0, ((t.y - r) / BUCKET) | 0);
    const by1 = Math.min(this.bucketWidth - 1, ((t.y + r) / BUCKET) | 0);
    for (let qy = by0; qy <= by1; qy++) {
      for (let qx = bx0; qx <= bx1; qx++) {
        for (let i = this.bucketHead[pb + qy * this.bucketWidth + qx]!; i >= 0; i = this.bucketNext[i]!) {
          const v = this.ents[i]!;
          if (v === t || v.dead || v.hp <= 0 || v.hangar || v.plane !== t.plane || v.kind === 'island' || this.payloads[v.kind] || !this.hostile(by, v.side)) continue;
          const d = v.structure ? footprintDistance(v.kind, v.x, v.y, t.x, t.y) : Math.max(0, norm(v.x - t.x, v.y - t.y) - v.radius);
          if (d > reach) continue;
          const vx = v.x - e.x;
          const vy = v.y - e.y;
          if (ax * vx + ay * vy < cos * al * norm(vx, vy)) continue;
          const dmg = damage * this.econ.splashFactor * this.weaponVs('flamer', v);
          this.reserve(v, by, dmg, false);
          this.hits.push({ t: v, dmg, by, source: e.kind, sourcePlane: e.plane });
        }
      }
    }
  }

  /** Is sudden death on (from rules.spire.suddenDeathAt; 0: never)? Public and the same for every army. */
  suddenDeath(this: Sim): boolean {
    const at = this.econ.suddenDeathTicks;
    return at > 0 && this.tick >= at;
  }

  damage(this: Sim, e: Ent, amount: number, by: SideId, bypassShield = false, cause = 'unknown', sourcePlane?: Plane, sourceKind?: Kind): void {
    // Forward posts are never damaged, whatever area effect (collapse, scorch, blast) sweeps over them.
    if (e.dead || e.hp <= 0 || e.hangar || e.kind === 'post') return;
    if (!bypassShield && this.modifierRows) {
      amount *= this.stat(e).damage_taken;
      this.revealEffect(e, 'modifier', 'damage_taken');
    }
    if (e.unit) amount *= this.deployFactor(e, by);
    else if (e.kind === 'spire' && !Object.hasOwn(ROCK_BORNE, cause) && this.suddenDeath()) amount *= this.econ.suddenDeathDamage;
    if (amount <= 0) return;
    e.combatAt = this.tick;
    this.breakCloak(e);
    if (!bypassShield && e.plane === 'orbit' && e.unit) {
      for (const projector of this.ents) {
        if (amount <= 0) break;
        if (projector.dead || projector.hp <= 0 || projector.side !== e.side || projector.plane !== 'orbit'
          || projector.aegisUntil <= this.tick || projector.aegisPool <= 0
          || sq(projector.x - e.x) + sq(projector.y - e.y) > sq(this.econ.aegisRadius)) continue;
        const absorbed = Math.min(projector.aegisPool, amount);
        projector.aegisPool -= absorbed;
        amount -= absorbed;
        if (projector.aegisPool <= 0) projector.aegisUntil = 0;
      }
    }
    // A solid hit knocks a solar array's exposure ramp back (a share of its progress, never to zero).
    if (e.kind === 'solar' && amount >= this.econ.solarRampHit) e.ramp *= 1 - this.econ.solarRampHitLoss;
    if (!bypassShield && e.plane === 'orbit' && e.shield > 0) {
      const absorbed = Math.min(e.shield, amount);
      e.shield -= absorbed;
      amount -= absorbed;
    }
    const dealt = Math.min(e.hp, amount);
    e.hp -= amount;
    // Damage destroys the same share of unextracted material as hull, never material already in a tug's hold.
    if (e.kind === 'asteroid') this.capRockResource(e);
    e.lastHitBy = by;
    e.lastHitCause = cause;
    e.lastHitPlane = sourcePlane;
    e.lastHitKind = sourceKind;
    if (dealt > 0) recordDamage(this, e, dealt, by, cause, sourcePlane);
    if (e.hp <= 0 && e.state === 'towed' && ((e.kind === 'asteroid' && e.volatile) || e.kind === 'core')) this.volatileDestroyed = true;
    if (e.kind === 'spire' && isArmy(e.side)) {
      const t = this.armies[e.side]!;
      if (this.hostile(by, e.side)) {
        this.armies[by]!.stats.spireDamageDealt += dealt;
        t.spireHitAt[e.plane] = this.tick;
      }
      if (this.tick - t.spireEventAt[e.plane] >= SPIRE_ALERT_EVERY) {
        t.spireEventAt[e.plane] = this.tick;
        this.emit([e.side], 'spire_damaged', e.plane, e.x, e.y, 'spire', isArmy(by) ? by : undefined);
      }
    }
  }

  kill(this: Sim, e: Ent): void {
    if (e.dead) return;
    if (e.kind === 'core' && e.state !== 'falling') {
      if (e.state === 'towed') this.coreMeltdown(e);
      else this.removeCore(e);
      return;
    }
    e.dead = true;
    if (e.kind === 'mooring_tower') {
      const island = this.alive(e.mooringTarget);
      if (island?.mooringTower === e.id) this.releaseMooring(island);
      e.mooringTarget = 0;
    }
    if (e.structure) this.footprintsDirty = true;
    this.releaseDesignation(e);
    e.hp = 0;
    const by = e.lastHitBy;
    if (this.payloads[e.kind]) {
      if (e.state === 'falling') {
        if (isArmy(by)) this.armies[by]!.stats.interceptions++;
        // Keep the shipped event tag and terminal render boundary for every payload.
        this.emit(this.allArmies, 'asteroid_intercepted', 'sky', e.x, e.y, e.kind, isArmy(by) ? by : undefined);
        this.fxAdd('intercept', 'sky', e.x, e.y, by, true, { side: e.side, subject: e.kind, sourceElevation: e.elevation, fall: this.payloadFall(e) });
        if (e.kind === 'core') this.removeCore(e);
      }
      return;
    }
    if (!isArmy(e.side)) return;
    const death = this.fxAdd('death', e.plane, e.x, e.y, e.side, false, { side: e.side, subject: e.kind, sourceElevation: e.elevation });
    death.cause = e.lastHitCause;
    death.attackerPlane = e.lastHitPlane;
    death.attackerKind = e.lastHitKind;
    death.alloyValue = e.replacementAlloy;
    death.energyValue = e.replacementEnergy;
    if (isArmy(by)) death.killer = by;
    const owner = this.armies[e.side]!;
    if (e.kind === 'spire') {
      this.cancelSegmentResearch(e.side, e.plane);
      owner.spireFellAt[e.plane] = this.tick;
      // Under crowns a fallen segment is public: every army sees the crown go (not an eliminated army's removal).
      if (this.rules.spire.lossRule === 'crowns' && this.inPlay(e.side)) {
        this.emit(this.allArmies, 'crown_lost', e.plane, e.x, e.y, 'spire', e.side, this.hostile(by, e.side) ? { killer: by } : undefined);
      }
    }
    // Credit only a hostile killer (army 0 is a real killer: test against undefined, never truthiness).
    const killer = this.hostile(by, e.side) ? by : undefined;
    if (e.link) {
      const l = this.alive(e.link);
      if (l?.hardpoint === e.id) l.hardpoint = 0;
      if (l && l.link === e.id) {
        l.link = 0;
        if (l.kind === 'asteroid' && l.state === 'towed') {
          l.state = 'drifting';
          this.releaseRock(l);
        } else if (l.kind === 'core' && l.state === 'towed') l.state = 'idle';
      }
    }
    if (this.isStructure(e)) {
      owner.stats.structuresLost++;
      // Lava bridges are terrain the diggers built, not counted against structureCap.
      if (e.kind !== 'spire' && e.kind !== 'lava_bridge') owner.structures--;
      this.emit([e.side], 'structure_lost', e.plane, e.x, e.y, e.kind, e.side);
      if (killer !== undefined) this.emit([killer], 'structure_destroyed', e.plane, e.x, e.y, e.kind, e.side);
      if (e.kind === 'shaft' || e.kind === 'headframe' || (e.kind === 'spire' && e.plane === 'depths')) this.refreshDrops();
      if (e.kind === 'bulkhead' && this.bulkheadAt[e.cell] === e.id) {
        this.gate[e.cell] = 0;
        this.depthsVersion++;
        this.bulkheadAt[e.cell] = 0;
      }
      if (e.kind === 'lava_bridge') this.collapseLavaBridge(e);
    } else {
      owner.pop--;
      owner.stats.unitsLost++;
      this.emit([e.side], 'unit_lost', e.plane, e.x, e.y, e.kind, e.side);
      if (killer !== undefined) {
        this.armies[killer]!.stats.kills++;
        this.emit([killer], 'enemy_killed', e.plane, e.x, e.y, e.kind, e.side);
      }
    }
  }
}
