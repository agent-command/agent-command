/** The Orbit seat's built-in bot: solar arrays, tugs and asteroid strikes, the combat fleet, scans and fleet abilities. */
import { CHAMBER, derelictLayer, derelictPeriod, fold, folded, gatesOpen, nearestAxis, openWindow, OUTSIDE, unfoldX, unfoldY, type DerelictGeometry } from '../rules/derelict.ts';
import { OBS_GRID } from '../rules/observation-core.ts';
import { DAMAGE_VS, footprintDistance, isStatKind, SPIRE_CORNER } from '../rules/stats.ts';
import { sunOffset } from '../rules/sun.ts';
import { isStructureKind, isUnitKind, MAP_SIZES, TICK_RATE } from '../rules/vocabulary.ts';
import type { Entity, UnitKind, UpgradeId } from '../rules/contract.ts';
import type { AgentCommandIntent } from '../agent/intents.ts';
import { dmath } from '../util/fdlibm.js';
import { cellCentreX, cellCentreY } from '../util/grid.ts';
import { solarBerths } from '../util/solar-berths.ts';
import { dist, norm } from '../util/math.ts';
import { Ctx, gridDist2, ids, type Pt } from './context.ts';
import { PlaneBot } from './plane-bot.ts';
import { answerOrbit, askOrbit } from './signals.ts';
import {
  AEGIS_SCREEN_MIN,
  APPROACH_OFFSET,
  AT_POINT,
  BERTH_AT,
  BASTIONS_PER_SKIFF,
  CORE_LEAD,
  CORE_THREAT_MARGIN,
  CORE_THREAT_REACH,
  CORE_TUGS_MIN,
  CORE_HOME_HEAT,
  CORE_VENT_HEAT,
  ENERGY_ENOUGH,
  ESCORTED_PER_BASTION,
  FOCUS_ATTACKERS,
  LANCE_HITS_MIN,
  LENS_AIRCRAFT,
  LANCERS_PER_AEGIS,
  LANCERS_PER_BASTION,
  LANDING_CLEARANCE,
  LANDING_HAND_HP,
  LANDING_RADIUS,
  ORBIT_SIEGE_MARGIN,
  ORBIT_TRADE_MARGIN,
  RADIATION_MARGIN,
  RESEARCH_MINIMUM_DEFAULT,
  RUIN_CLEARANCE,
  SCAN_TREMOR_RADIUS,
  SKIFFS_PER_LANCER,
  SLOT_RADII,
  SOLAR_BANK_EXTRA,
  SOLAR_EXTRA,
  FOLD_HEALED,
  FOLD_HP,
  FOLD_SAFE,
  RAID_ALONG,
  RAID_SKIFFS,
  TOW_SPEED_FLOOR,
  TUG_LOOP_CENTRE,
  TUG_LOOP_PERIOD,
  TUG_LOOP_RADIUS,
  TUGS_FROM,
  VOLATILE_BONUS,
} from './tuning.ts';

/**
 * The enemy Orbit segment's beam reach to a tug from its centre on any bearing (the beam reaches from the footprint
 * edge, farthest on its diagonals; 0 when segments do not shoot) and the stand-off radius tugs release strikes from:
 * halfway between that reach and the deorbit range (the rules keep the range beyond the reach), so neither steering
 * error nor the towed asteroid's lag puts a release outside either. Public: rules and Spire positions.
 */
function tugBeam(c: Ctx): { reach: number; stand: number } {
  if (c.stats.spire.dmg <= 0) return { reach: 0, stand: 0 };
  const reach = c.stats.spire.range + SPIRE_CORNER + c.stats.tug.radius;
  return { reach, stand: (reach + c.econ.deorbitRange) / 2 };
}

/**
 * Release slot `i` for a strike on `target`: on the stand-off circle around the focus's Spire, toward our usual
 * `approach` point, slots alternating either side of it. A slot out of deorbit range of the target (a turret on the
 * far side of the Spire) falls back to the circle point nearest the target.
 */
function standOffSlot(c: Ctx, target: { x: number; y: number }, approach: { x: number; y: number }, stand: number, i: number): { x: number; y: number } {
  const s = c.foeAt;
  const home = c.home;
  let ux = approach.x - s.x;
  let uy = approach.y - s.y;
  let d = norm(ux, uy);
  if (d === 0) {
    ux = home.x - s.x;
    uy = home.y - s.y;
    d = norm(ux, uy);
  }
  const k = (i + 1) >> 1;
  const a = ((i % 2 === 1 ? k : -k) * SLOT_RADII * c.stats.tug.radius) / stand;
  const cos = dmath.cos(a);
  const sin = dmath.sin(a);
  const p = { x: s.x + ((ux * cos - uy * sin) / d) * stand, y: s.y + ((ux * sin + uy * cos) / d) * stand };
  if (dist(p, target) < c.econ.deorbitRange) return p;
  const t = norm(target.x - s.x, target.y - s.y);
  return { x: s.x + ((target.x - s.x) / t) * stand, y: s.y + ((target.y - s.y) / t) * stand };
}

/** Fuse travel is in seconds; tow rules multiply the tug's ordinary tiles/second speed. */
function volatileTravel(c: Ctx, tug: Entity, rock: Entity, target: Pt): number {
  const r = c.match.rules.orbit;
  const tow = rock.rockSize === 'pebble' ? r.pebbleTowSpeed : rock.rockSize === 'large' ? r.largeTowSpeed : r.towSpeed;
  return Math.max(0, dist(rock, target) - r.deorbitRange) / (c.statsOf(tug).speed * tow);
}

function volatileLandingSafe(c: Ctx, rock: Entity, p: Pt): boolean {
  const r = c.match.rules.orbit;
  const radius = (rock.rockSize === 'pebble' ? r.pebbleImpactRadius : rock.rockSize === 'large' ? r.largeImpactRadius : r.impactRadius) * r.volatileRadiusMultiplier;
  return !c.own.some((e) => {
    if (e.plane !== 'surface' && e.plane !== 'orbit') return false;
    const s = c.statsOf(e);
    const clearance = e.plane === 'surface' && !s.footprint ? s.radius : 0;
    return footprintDistance(e.kind, e.x, e.y, p.x, p.y) <= (e.plane === 'surface' ? radius : r.volatileOrbitRadius) + clearance;
  });
}

/** Only visible armed enemies can threaten this tow; test their reach along the remaining release path. */
function volatileIntercepted(c: Ctx, tug: Entity, rock: Entity, target: Pt, seconds: number): boolean {
  const distance = dist(rock, target);
  const travel = Math.max(0, distance - c.match.rules.orbit.deorbitRange);
  const end = distance > 0 ? { x: rock.x + (target.x - rock.x) * travel / distance, y: rock.y + (target.y - rock.y) * travel / distance } : rock;
  return c.foes.some((e) => {
    const s = c.statsOf(e);
    const stationPd = e.kind === 'spire' && c.econ.stationPdDamage > 0;
    if (e.plane !== 'orbit' || (s.dmg <= 0 && !stationPd) || (!s.targets.includes('orbit') && e.kind !== 'interceptor')) return false;
    const dx = end.x - rock.x, dy = end.y - rock.y;
    const k = travel > 0 ? Math.max(0, Math.min(1, ((e.x - rock.x) * dx + (e.y - rock.y) * dy) / (travel * travel))) : 0;
    const p = { x: rock.x + dx * k, y: rock.y + dy * k };
    // Weapons reach from the footprint edge (Spire beams; units have none), station PD from the segment's centre.
    const slack = c.statsOf(tug).radius + s.speed * seconds;
    return (s.dmg > 0 && footprintDistance(e.kind, e.x, e.y, p.x, p.y) <= s.range + slack)
      || (stationPd && dist(e, p) <= c.econ.stationPdRange + slack);
  });
}

/** Prefer a useful immediately reachable strike, otherwise dispose on clear ground in our frame's cell order (test/volatile-policy.test.ts checks it against an exhaustive search). */
export function volatileAbort(c: Ctx, rock: Entity, target: Pt): Pt | undefined {
  const reach = c.match.rules.orbit.deorbitRange;
  const usable = (p: Pt): boolean => dist(rock, p) <= reach && volatileLandingSafe(c, rock, p);
  if (usable(target)) return target;
  const foe = c.foes.find((e) => e.plane === 'surface' && usable(e));
  if (foe) return foe;
  // Only cells within `reach` of the rock are usable: walk their canonical box (a cell of margin), in canonical order.
  const at = c.frame.toCanon(rock.x, rock.y);
  const x0 = Math.max(0, Math.floor(at.x - reach) - 1), x1 = Math.min(c.size - 1, Math.ceil(at.x + reach));
  const y0 = Math.max(0, Math.floor(at.y - reach) - 1), y1 = Math.min(c.size - 1, Math.ceil(at.y + reach));
  let best: Pt | undefined;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = c.frame.toWorld(x + 0.5, y + 0.5);
    // Nearer the target first (cheap), then usable: once a landing is found few cells need the landing check.
    if ((!best || dist(p, target) < dist(best, target)) && usable(p)) best = p;
  }
  return best;
}

/** Core deorbit reach as judged from observed positions: one observation grid step inside the rule (the sim measures exact ones). */
const coreReach = (c: Ctx): number => c.econ.deorbitRange - 1 / OBS_GRID;

/**
 * The gate mouth nearest `p`: on that aperture's axis (gates line up with the breaches while open), mid-corridor, so
 * outside the ring's radiation and inside the hull. Folded into one quarter and back by exact quarter turns, so a
 * rotated `p` gives the rotated mouth bit for bit.
 */
function gateMouth(g: DerelictGeometry, p: Pt): Pt {
  fold(p.x - g.x, p.y - g.y);
  const turns = folded.turns;
  const a = nearestAxis(g.gates, folded.x, folded.y);
  const r = (g.ringOuter + g.hullInner) / 2;
  const fx = r * dmath.cos(a), fy = r * dmath.sin(a);
  return { x: g.x + unfoldX(turns, fx, fy), y: g.y + unfoldY(turns, fx, fy) };
}

/**
 * A drop site for our towed derelict core: the visible hostile Surface structure within deorbit range of it, Spire
 * segments first, else the nearest (ties in our frame's order), with none of our Surface assets inside the blast.
 */
function coreDrop(c: Ctx, core: Entity): Pt | undefined {
  const radius = c.econ.coreDropRadius;
  let best: Entity | undefined;
  for (const f of c.foes) {
    if (f.plane !== 'surface' || !isStructureKind(f.kind) || dist(f, core) > coreReach(c)) continue;
    if (c.own.some((e) => e.plane === 'surface' && isStatKind(e.kind)
      && footprintDistance(e.kind, e.x, e.y, f.x, f.y) <= radius + (c.stats[e.kind].footprint ? 0 : c.stats[e.kind].radius))) continue;
    const better = !best ? true : (f.kind === 'spire') !== (best.kind === 'spire') ? f.kind === 'spire'
      : gridDist2(f, core) < gridDist2(best, core) || (gridDist2(f, core) === gridDist2(best, core) && c.frame.pointKey(f) < c.frame.pointKey(best));
    if (better) best = f;
  }
  return best && { x: best.x, y: best.y };
}

export class OrbitBot extends PlaneBot {
  private strikeAt = 0;
  private claimed = new Map<string, string>();
  private centreScanAt = -1;
  private fleet = 0;
  /** the tug kept on the derelict core, the tick its last vent was ordered (−1: none pending), and whether our tow is a strike run */
  private coreTug = '';
  private ventAt = -1;
  private coreStrike = false;
  /** Core races tied in a row, the window start of the last tie, the tick core work resumes after too many, and the
   * gate mouth the fleet holds after a tie until contestUntil. */
  private coreTies = 0;
  private tieWindow = -1;
  private coreRestUntil = 0;
  private contestAt: Pt | null = null;
  private contestUntil = -1;
  /** Own Orbit ships in the derelict chamber at the last think: hull + shield then (their measured loss rate). */
  private readonly chamberHull = new Map<string, { hull: number; tick: number }>();
  /** Enough enemy aircraft were seen under the Lancers: buy the Lens next (a sighting, not a standing condition). */
  private lensWanted = false;
  /** Array berths (canonical offsets from home, nearest first), which berth each array holds, and arrays folded to heal. */
  private berthList: Pt[] = [];
  private readonly berthOf = new Map<string, number>();
  private readonly folded = new Set<string>();

  protected decide(c: Ctx): AgentCommandIntent[] {
    const out: AgentCommandIntent[] = [];
    const t = this.tier;
    const tick = c.obs.tick;
    const solars = c.units('solar');
    const tugs = c.own.filter((e) => e.plane === 'orbit' && isStatKind(e.kind) && c.stats[e.kind].capabilities.tow);
    const lancers = c.units('lancer');
    const skiffs = c.units('skiff');
    const bastions = c.units('bastion');
    // Surplus above the cap charges the solar bank, so arrays past the cap pay off while the bank has room.
    const banking = c.econ.solarBankRate > 0 && c.obs.res.energyBank < c.econ.solarBankMax;
    // An anchored home array averages solarRate × (1 + solarNight) / 2 over a day and a night.
    const mean = (c.econ.solarRate * (1 + c.econ.solarNight)) / 2;
    const worth = Math.min(t.solar, Math.ceil(c.obs.res.energyCap / Math.max(0.01, mean)) + SOLAR_EXTRA + (banking ? SOLAR_BANK_EXTRA : 0));
    if (this.fleet === 0 && t.lancers > 0) {
      const lancer = c.stats.lancer;
      const beam = c.stats.spire.dmg / Math.max(1, c.stats.spire.cooldown);
      const damage = lancer.dmg * DAMAGE_VS.beam.structure / Math.max(1, lancer.cooldown);
      this.fleet = Math.max(t.lancers, Math.ceil(Math.sqrt(ORBIT_SIEGE_MARGIN * c.match.rules.spire.hp.orbit * beam / ((lancer.hp + (lancer.shield ?? 0)) * damage))));
    }
    // Only currently scouted Orbit enemies affect the counter mix: no world state, hidden queue or inferred army.
    let enemySkiffs = 0, enemyBastions = 0, enemyLancers = 0;
    let underThreat = false;
    for (const e of c.foes) if (e.plane === 'orbit') {
      if (e.kind !== 'spire' && isStatKind(e.kind) && c.stats[e.kind].dmg > 0) underThreat = true;
      if (e.kind === 'skiff') enemySkiffs++;
      else if (e.kind === 'bastion') enemyBastions++;
      else if (e.kind === 'lancer') enemyLancers++;
    }
    const escort = t.lancers > 0 ? Math.max(1, Math.ceil((solars.length + tugs.length) / ESCORTED_PER_BASTION)) : 0;
    const skiffFleet = t.researchMinimum.skiff ?? RESEARCH_MINIMUM_DEFAULT;
    const wantSkiffs = t.lancers > 0 ? skiffFleet + SKIFFS_PER_LANCER * enemyLancers : 0;
    const lancerHeavy = enemyLancers > enemySkiffs + enemyBastions;
    const aegisScreen = t.lancers > 0 && lancerHeavy ? Math.max(AEGIS_SCREEN_MIN, Math.ceil(enemyLancers / LANCERS_PER_AEGIS)) : 0;
    const wantBastions = Math.max(escort + BASTIONS_PER_SKIFF * enemySkiffs, aegisScreen);
    const wantLancers = this.fleet + LANCERS_PER_BASTION * enemyBastions;
    let combat: Extract<UnitKind, 'skiff' | 'bastion' | 'lancer'> = 'lancer';
    let deficit = (wantLancers - lancers.length - c.queued('lancer')) / Math.max(1, this.fleet);
    const bastionDeficit = (wantBastions - bastions.length - c.queued('bastion')) / Math.max(1, escort);
    const skiffDeficit = (wantSkiffs - skiffs.length - c.queued('skiff')) / skiffFleet;
    if (bastionDeficit > deficit) { combat = 'bastion'; deficit = bastionDeficit; }
    if (skiffDeficit > deficit) { combat = 'skiff'; deficit = skiffDeficit; }
    if (bastions.length + c.queued('bastion') < aegisScreen) combat = 'bastion';
    // An armed enemy in sight queues the counter first, also with every array dead: rebuilt arrays only feed the raiders.
    if (underThreat && deficit > 0) this.produce(c, out, combat, 'orbit', 0);
    else if (solars.length + c.queued('solar') < worth && c.obs.res.energy < ENERGY_ENOUGH) this.produce(c, out, 'solar', 'orbit');
    else if (tick > TUGS_FROM && tugs.length + c.queued('tug') < t.tugs) this.produce(c, out, 'tug', 'orbit');
    else if (deficit > 0) this.produce(c, out, combat, 'orbit');
    if (t.lancers > 0) {
      if (t.lens && !this.lensWanted) {
        let under = 0;
        for (const e of c.foes) if (e.plane === 'sky' && isUnitKind(e.kind) && lancers.some((l) => dist(l, e) <= c.stats.lancer.range)) under++;
        this.lensWanted = under >= LENS_AIRCRAFT;
      }
      const wanted = {
        solar: c.obs.res.energy < ENERGY_ENOUGH ? worth : solars.length + c.queued('solar'),
        tug: tick > TUGS_FROM ? t.tugs : tugs.length + c.queued('tug'),
        lancer: wantLancers, skiff: wantSkiffs, bastion: wantBastions,
      };
      // A wanted Lens goes first; while it is unavailable (researching, done or off this match) the usual choice runs.
      if (this.lensWanted && c.obs.research.available.includes('lancer_lens')) this.research(c, out, 'lancer_lens', wanted, t.reserve.orbit);
      else {
        // Scouting chooses the first upgrade; only observed enemy fleets inform this decision.
        let upgrade: Extract<UpgradeId, 'aegis_projectors' | 'night_cloak'> = lancerHeavy
          ? 'aegis_projectors' : enemyBastions === 0 ? 'night_cloak' : 'aegis_projectors';
        if (c.obs.research.completed.includes(upgrade)) upgrade = upgrade === 'aegis_projectors' ? 'night_cloak' : 'aegis_projectors';
        this.research(c, out, upgrade, wanted, t.reserve.orbit);
      }
      this.abilities(c, out, lancers, bastions);
    }
    // Teammates' requests first: escorts leave the fleets below, and a requested scan uses this decision's scan.
    const scanned = answerOrbit(this.desk, c, out, [bastions, lancers]);
    askOrbit(this.desk, c);
    // Then the derelict core: the ships it commits (core tug, contest, radiation retreat) skip routine fleet orders.
    const { busy, ward } = this.derelict(c, out, tugs, [...bastions, ...skiffs, ...lancers]);
    this.orbitCombat(c, out, bastions.filter((e) => !busy.has(e.id)), ward);
    // Enough Skiffs raid the focus's forward fields (past its beam) instead of holding the ruin post.
    const raid = skiffs.length >= RAID_SKIFFS ? c.foeFrame.offset(c.foeAt, RAID_ALONG, 0) : undefined;
    this.orbitCombat(c, out, skiffs.filter((e) => !busy.has(e.id)), undefined, raid);
    this.orbitCombat(c, out, lancers.filter((e) => !busy.has(e.id)));
    this.arrays(c, out, solars, busy);

    // Mine or drop by locally observed resource type and independent volatility, never public markers.
    // A teammate's drop request names the target instead, and any existing tow goes for it.
    const asked = this.desk.work().find((w) => w.entry.need === 'drop' && w.at);
    const target = asked?.at ?? this.siegeTarget(c) ?? c.foeAt;
    const towing = tugs.filter((g) => g.link !== undefined && !g.miningAssigned && !busy.has(g.id));
    // Approach from the focus's front: toward the map centre from its Spire, in its frame.
    const approach = c.foeFrame.offset(target, APPROACH_OFFSET, APPROACH_OFFSET);
    const beam = tugBeam(c);
    const ready: Entity[] = [];
    const drops = c.obs.mandate.limits?.asteroidDrops !== false;
    const home = c.home;
    for (const g of towing) {
      const rock = c.obs.entities.find((e) => e.id === g.link);
      if (rock?.kind !== 'asteroid') continue;
      const rules = c.match.rules.orbit;
      if (rock.volatile === true && drops) {
        const seconds = volatileTravel(c, g, rock, target);
        const remaining = rock.fuseUntil === undefined ? undefined : (rock.fuseUntil - tick) / TICK_RATE;
        const unsafe = remaining === undefined || seconds + t.period / TICK_RATE >= remaining || !volatileLandingSafe(c, rock, target)
          || volatileIntercepted(c, g, rock, target, seconds);
        if (unsafe || seconds === 0) {
          const p = volatileAbort(c, rock, target);
          if (p) out.push({ kind: 'deorbit', units: [g.id], x: p.x, y: p.y });
          continue;
        }
        // Volatile cargo never waits for a salvo cooldown: its visible fuse is already running.
        const p = beam.reach > 0 ? standOffSlot(c, target, approach, beam.stand, towing.indexOf(g)) : approach;
        if (g.tx !== p.x || g.ty !== p.y) out.push({ kind: 'move', units: [g.id], x: p.x, y: p.y });
        continue;
      }
      const radius = rock.rockSize === 'pebble' ? rules.pebbleImpactRadius : rock.rockSize === 'large' ? rules.largeImpactRadius : rules.impactRadius;
      let landing: Pt | null = null;
      if (drops && !asked && rock.resourceType === 'metal' && rock.volatile === false && rules.oreCacheMultiplier > 1) {
        const collectors = c.own.filter((e) => e.plane === 'surface' && c.statsOf(e).speed > 0 && e.hp > e.maxHp * LANDING_HAND_HP);
        for (const hand of collectors) {
          const region = c.surfaceRegion(hand);
          landing = c.spot(hand.x, hand.y, LANDING_RADIUS, (n) => {
            const p = { x: cellCentreX(n, this.size), y: cellCentreY(n, this.size) };
            return region[n] === 1 && dist(p, home) < c.hostileSpireDist(p)
              && !c.own.some((e) => e.plane === 'surface' && dist(e, p) < radius + LANDING_CLEARANCE)
              && !c.obs.impacts.some((i) => dist(i, p) < radius + rules.oreCacheRadius + LANDING_CLEARANCE)
              && !out.some((i) => i.kind === 'deorbit' && dist(i, p) < radius + rules.oreCacheRadius + LANDING_CLEARANCE);
          });
          if (landing) break;
        }
      }
      const attack = drops && (rock.volatile === true || !!asked || rock.resourceType === 'slag');
      if (landing) {
        if (dist(rock, landing) <= rules.deorbitRange) out.push({ kind: 'deorbit', units: [g.id], x: landing.x, y: landing.y });
        else if (g.tx !== landing.x || g.ty !== landing.y) out.push({ kind: 'move', units: [g.id], x: landing.x, y: landing.y });
      } else if (!attack && c.segmentAlive('orbit')) {
        // Salvage is automatic at our live Orbit segment; stations are not docks yet.
        if (g.state !== 'moving' || g.tx !== home.x || g.ty !== home.y) out.push({ kind: 'move', units: [g.id], x: home.x, y: home.y });
      } else if (attack) {
        if (dist(g, c.foeAt) > beam.reach && dist(rock, target) <= rules.deorbitRange) ready.push(g);
        else {
          const p = beam.reach > 0 ? standOffSlot(c, target, approach, beam.stand, towing.indexOf(g)) : approach;
          if (g.tx !== p.x || g.ty !== p.y) out.push({ kind: 'move', units: [g.id], x: p.x, y: p.y });
        }
      }
    }
    const scanReady = !scanned && t.scans && c.segmentAlive('orbit') && c.obs.res.scanReadyAt <= tick && c.obs.res.freeEnergy >= c.econ.scanCost;
    // Orbital scans: enemies sensed under our base first, then a look at the target before a strike.
    const tremor = c.tremorsNearHome(SCAN_TREMOR_RADIUS)[0];
    if (scanReady && tremor) out.push({ kind: 'scan', x: tremor.x + 0.5, y: tremor.y + 0.5 });
    else if (scanReady && ready.length) out.push({ kind: 'scan', x: target.x, y: target.y });
    else if (scanReady && tick >= Math.max(t.scanCentreAt, this.centreScanAt)) {
      // Looks at the centre: magma pockets along the caverns before the miners get there, and who mines the rich veins.
      out.push({ kind: 'scan', x: this.size / 2, y: this.size / 2 });
      this.centreScanAt = tick + t.scanCentreEvery;
    }
    if (ready.length && (asked || tick >= this.strikeAt)) {
      out.push({ kind: 'deorbit', units: ids(ready), x: target.x, y: target.y });
      this.strikeAt = tick + t.strikeEvery;
      if (asked) this.desk.done(asked, false);
    }

    const asteroids = c.obs.entities.filter((e) => e.kind === 'asteroid' && e.state === 'drifting');
    const live = new Set(tugs.map((g) => g.id));
    for (const [tug] of this.claimed) if (!live.has(tug)) this.claimed.delete(tug);
    for (const g of tugs) {
      // Includes auto_mine's idle search: never borrow its tug for a scout loop or strike (a core run may: derelict()).
      if (g.miningAssigned) continue;
      if ((g.cargoAlloy ?? 0) + (g.cargoEnergy ?? 0) > 0) {
        if (c.segmentAlive('orbit') && (g.tx !== home.x || g.ty !== home.y)) out.push({ kind: 'move', units: [g.id], x: home.x, y: home.y });
        continue;
      }
      if (g.link !== undefined || busy.has(g.id)) {
        this.claimed.delete(g.id);
        continue;
      }
      if (g.state !== 'idle' && g.state !== 'moving' && g.state !== 'grappling') continue;
      const previous = this.claimed.get(g.id);
      const taken = new Set([...this.claimed.entries()].filter(([k]) => k !== g.id).map(([, a]) => a));
      // Keep a claim; otherwise race the best observed value per haul time, accounting for size-specific tow speed.
      const eligible = asteroids.filter((a) => a.resourceType !== undefined && a.volatile !== undefined
        && (a.volatile ? drops && volatileLandingSafe(c, a, target) && volatileTravel(c, g, a, target) < c.match.rules.orbit.volatileFuse
          : a.resourceType === 'slag' ? drops : c.segmentAlive('orbit') && (a.resourceRemaining ?? 0) > 0));
      const mine = eligible.find((a) => a.id === this.claimed.get(g.id) && !taken.has(a.id));
      const score = (a: Entity): number => {
        const r = c.match.rules.orbit;
        const value = a.resourceType === 'slag' ? (a.rockSize === 'pebble' ? r.pebbleDockValue : a.rockSize === 'large' ? r.largeDockValue : r.dockValue) : a.resourceRemaining ?? 0;
        const tow = a.rockSize === 'pebble' ? r.pebbleTowSpeed : a.rockSize === 'large' ? r.largeTowSpeed : r.towSpeed;
        const bonus = drops && a.volatile === true ? VOLATILE_BONUS : drops && a.resourceType === 'metal' ? r.oreCacheMultiplier : 1;
        return value * bonus / (1 + dist(a, g) + dist(a, home) / Math.max(TOW_SPEED_FLOOR, tow));
      };
      const pick = mine ?? eligible.filter((a) => !taken.has(a.id)).reduce<Entity | undefined>((b, a) => (!b || score(a) > score(b) ? a : b), undefined);
      if (!pick) this.claimed.delete(g.id);
      if (pick && this.claimed.get(g.id) !== pick.id) {
        this.claimed.set(g.id, pick.id);
        const mining = !asked && pick.volatile === false && (pick.resourceType === 'metal' || pick.resourceType === 'ice') && c.segmentAlive('orbit');
        out.push({ kind: mining ? 'mine_asteroid' : 'grapple', units: [g.id], asteroid: pick.id });
      } else if (!pick && previous !== undefined) {
        // Revoke the in-flight grapple too, not merely its bookkeeping claim.
        out.push({ kind: 'stop', units: [g.id] });
      } else if (!pick && g.state === 'idle') {
        // Idle tugs loop a slow circle on their side of the map, waiting for rocks, outside the derelict hull.
        const a = (tick / TUG_LOOP_PERIOD) * 2 * Math.PI;
        let lx = TUG_LOOP_CENTRE.x + TUG_LOOP_RADIUS * dmath.cos(a);
        let ly = TUG_LOOP_CENTRE.y + TUG_LOOP_RADIUS * dmath.sin(a);
        const clear = c.match.derelict ? c.match.derelict.hullOuter + RUIN_CLEARANCE : 0;
        const r = norm(lx, ly);
        if (r < clear) {
          lx = r > 0 ? (lx * clear) / r : -clear;
          ly = r > 0 ? (ly * clear) / r : 0;
        }
        const p = c.frame.toWorld(this.size / 2 + lx, this.size / 2 + ly);
        out.push({ kind: 'move', units: [g.id], x: p.x, y: p.y });
      }
    }
    return out;
  }

  /**
   * The derelict core (DESIGN §4.4), from the public ruin geometry, gate cycle, schedule and lift plus what we see (its
   * heat and vents only with sight of it). Ships in the chamber leave on an open window unless they can sit out the
   * next sealed span; with the core off (rules.orbit.coreEnabled) that is all: the empty chamber is not worth its
   * radiation. Our tow heads home to be cashed in while it gets there cool enough; hot, it vents while a vent still
   * buys time, else it drops on a hostile structure in reach (veteran: the focus) or goes back into the ruin to cool;
   * a threat sends it into the ruin. No tow: with CORE_TUGS_MIN tugs in all, a free tug (else an empty miner off the
   * rocks) grapples it while the chamber is uncontested and the gates open (tier coreEarly: in time to be at the gate
   * mouth before they do), escorted by the Bastions. Intruders are fought from the gate mouth nearest them, outside the
   * ring's radiation, when the fleet trades well, and an enemy tow is shot down by ships out-ranging its meltdown. A
   * tied race (a hostile tug in grapple reach with ours: nobody latches) backs our tug out of the radiation for that
   * window while the fleet holds the rival's gate mouth through the next; coreTies tied windows in a row rest the core
   * work coreTieRest ticks, so exact mirrors do not burn tugs and fleet time on it forever. Returns the own ships
   * ordered here (routine fleet and rock orders skip them) and the tug the escorts guard.
   */
  private derelict(c: Ctx, out: AgentCommandIntent[], tugs: Entity[], fleet: Entity[]): { busy: Set<string>; ward?: Entity } {
    const busy = new Set<string>();
    const g = c.match.derelict;
    if (!g || !this.tier.core) return { busy };
    const tick = c.obs.tick;
    const econ = c.econ;
    const centre = { x: g.x, y: g.y };
    const open = gatesOpen(g, tick);
    // Start of the next window we could leave the chamber in, if we stay through the current one.
    const nextOpen = openWindow(g, tick, open ? 1 : 0);
    const post = c.ruinPost();
    const drops = c.obs.mandate.limits?.asteroidDrops !== false;
    const move = (e: Entity, p: Pt, mode: 'move' | 'fight' = 'move'): void => {
      // Observed destinations sit off cell edges: an order within AT_POINT of the point is the same order.
      if (e.tx === undefined || e.ty === undefined || norm(e.tx - p.x, e.ty - p.y) > AT_POINT) {
        out.push({ kind: 'move', units: [e.id], x: p.x, y: p.y, ...(mode === 'fight' ? { mode } : {}) });
      }
      busy.add(e.id);
    };
    const chamber = (p: Pt): boolean => derelictLayer(g, dist(p, centre)) === CHAMBER;
    const armed = c.foes.filter((f) => f.plane === 'orbit' && f.kind !== 'spire' && isStatKind(f.kind) && c.stats[f.kind].dmg > 0);
    // Each think, every own ship in the chamber re-checks its hull + shield against everything hitting it: radiation,
    // armed enemies in reach, and the loss measured since the last think (whichever is worse).
    const lost = new Map<string, number>();
    for (const e of c.own) {
      if (e.plane !== 'orbit' || !chamber(e)) continue;
      const hull = e.hp + (e.shield ?? 0);
      const seen = this.chamberHull.get(e.id);
      if (seen && tick > seen.tick) lost.set(e.id, Math.max(0, seen.hull - hull) * TICK_RATE / (tick - seen.tick));
    }
    this.chamberHull.clear();
    for (const e of c.own) if (e.plane === 'orbit' && chamber(e)) this.chamberHull.set(e.id, { hull: e.hp + (e.shield ?? 0), tick });
    const incoming = (e: Entity): number => {
      const armour = c.statsOf(e).armor;
      let dps = econ.derelictRadiation;
      for (const f of armed) {
        const s = c.statsOf(f);
        if (s.weapon && dist(f, e) <= s.range + CORE_THREAT_MARGIN) dps += (s.dmg * DAMAGE_VS[s.weapon][armour] * TICK_RATE) / Math.max(1, s.cooldown);
      }
      return Math.max(dps, lost.get(e.id) ?? 0);
    };
    // Gate timing: the current window (the coming one while sealed) and the one after it.
    const windowStart = openWindow(g, tick);
    const windowEnd = windowStart + g.open;
    const following = openWindow(g, tick, 1);
    const towSpeed = c.stats.tug.speed * econ.coreTowSpeed;
    // Tick a ship at radius r is out of the radiation (past the ring's inner edge) at `speed`, after `work` ticks: on the
    // current or coming window if it reaches the gate before that window shuts, else on the one after.
    const outAt = (r: number, speed: number, work = 0): number => {
      const ready = tick + work + (Math.max(0, g.ringInner - r) / speed) * TICK_RATE;
      return ready <= windowEnd ? Math.max(ready, windowStart) : Math.max(ready, following);
    };
    const lasts = (e: Entity, until: number): boolean => e.hp + (e.shield ?? 0) > RADIATION_MARGIN * incoming(e) * Math.max(0, until - tick) / TICK_RATE;
    // Staying through the coming window means lasting until the one after it.
    const mustLeave = (e: Entity): boolean => chamber(e) && !lasts(e, following);
    // Exits are ordered only while the gates are open or open within the trip to them (plus a think): never into a
    // sealed ring it cannot pass, so nothing paces at the gate mouth.
    const exiting = (e: Entity, speed: number): boolean => open
      || windowStart - tick <= (Math.max(0, g.ringInner - dist(e, centre)) / speed) * TICK_RATE + this.tier.period;
    const core = c.obs.entities.find((e) => e.kind === 'core' && e.plane === 'orbit');
    const holder = core && tugs.find((e) => e.link === core.id);
    // The tug sent for a resting core in the chamber (else the free one in there nearest it) keeps its commitment: the
    // grapple below decides for it. Before it has the core in sight (the chamber is dark by night, its vision shorter
    // there) our committed tug carries on toward the centre while nothing public says the core is gone.
    let grabbing = '';
    if (core && core.state === 'idle' && chamber(core)) {
      let best: Entity | undefined;
      for (const e of tugs) if (e.link === undefined && chamber(e) && (e.id === this.coreTug || !best || (best.id !== this.coreTug && gridDist2(e, core) < gridDist2(best, core)))) best = e;
      grabbing = best?.id ?? '';
    } else if (!core && econ.coreEnabled && !c.obs.coreLifted && !c.obs.schedule.some((s) => s.kind === 'core_regrows')) {
      const kept = tugs.find((e) => e.id === this.coreTug);
      if (kept && kept.link === undefined && chamber(kept) && dist(kept, centre) > econ.grappleReach) grabbing = kept.id;
    }
    for (const e of [...fleet, ...tugs, ...c.units('solar')]) {
      if (e === holder || e.id === grabbing || !mustLeave(e)) continue;
      if (exiting(e, c.statsOf(e).speed)) move(e, post);
      else busy.add(e.id); // sealed: hold where it is until the window nears
    }
    // No core this match: the ruin stands empty, and nothing in it is worth the radiation.
    if (!econ.coreEnabled) return { busy };
    // Latched on: the race is won, so the tie count starts over.
    if (holder) this.coreTies = 0;

    if (core && holder && chamber(holder) && !exiting(holder, towSpeed)) {
      // Sealed in with the core: hold it (no exit orders) until the window nears.
      busy.add(holder.id);
      this.coreTug = holder.id;
      return { busy, ward: holder };
    }
    if (core && holder && chamber(holder) && mustLeave(holder)) {
      // It cannot stay past this window: tow out on it, or, if the tow cannot make it but the tug alone can, let go and run.
      const r = dist(holder, centre);
      if (outAt(r, towSpeed) > windowEnd && outAt(r, c.stats.tug.speed) <= windowEnd) {
        out.push({ kind: 'release', units: [holder.id] });
        move(holder, post);
        this.coreTug = '';
        return { busy };
      }
    }

    if (core && holder) {
      busy.add(holder.id);
      this.coreTug = holder.id;
      // A vent holds the tug still for coreVentTicks: any move order restarts it.
      if (this.ventAt >= 0 && tick < this.ventAt + econ.coreVentTicks + this.tier.period) return { busy, ward: holder };
      this.ventAt = -1;
      const heat = core.heat ?? 0;
      // A vent leaves (vents + 1) × coreVentFloor heat: worth it only while that is well short of the vent mark.
      const ventable = ((core.vents ?? 0) + 1) * econ.coreVentFloor < CORE_VENT_HEAT;
      const target = this.siegeTarget(c) ?? c.foeAt;
      // Veteran: a core with no vents left to buy is a bomb for the focus; the run, once started, carries on.
      const strike = drops && this.tier.coreBomb && (this.coreStrike || !ventable);
      this.coreStrike = strike;
      const beam = tugBeam(c);
      const approach = c.foeFrame.offset(target, APPROACH_OFFSET, APPROACH_OFFSET);
      const release = beam.reach > 0 ? standOffSlot(c, target, approach, beam.stand, 0) : approach;
      // Home to cash it in, if the tow gets there before the heat does (the clock runs out past the hull).
      const rate = econ.coreTransitHeat * dmath.pow(MAP_SIZES[0] / this.size, econ.coreTransitScale);
      const reaches = heat + (Math.max(0, dist(holder, c.home) - econ.dockRadius) / (c.stats.tug.speed * econ.coreTowSpeed)) * rate < CORE_HOME_HEAT;
      if (derelictLayer(g, dist(core, centre)) === OUTSIDE) {
        const threatened = armed.some((f) => dist(f, holder) <= c.statsOf(f).range + CORE_THREAT_MARGIN);
        const drop = drops ? coreDrop(c, core) : undefined;
        if (strike && dist(holder, c.foeAt) > beam.reach && dist(core, target) <= coreReach(c)) {
          out.push({ kind: 'deorbit', units: [holder.id], x: target.x, y: target.y });
        } else if (drop && threatened) {
          out.push({ kind: 'deorbit', units: [holder.id], x: drop.x, y: drop.y });
        } else if (reaches && !strike) move(holder, c.home);
        else if (ventable && !threatened) {
          out.push({ kind: 'vent', units: [holder.id] });
          this.ventAt = tick;
        } else if (drop) out.push({ kind: 'deorbit', units: [holder.id], x: drop.x, y: drop.y });
        else if (strike) move(holder, release);
        else move(holder, centre);
      } else if (heat > 0 && (armed.some((f) => dist(f, centre) <= g.hullOuter + CORE_THREAT_REACH) || !reaches) && !mustLeave(holder)) {
        // Armed enemies by the ruin, or too hot to make it home: cool it in the chamber first.
        move(holder, centre);
      } else if (strike) move(holder, release);
      else move(holder, c.home);
      return { busy, ward: holder };
    }
    this.coreStrike = false;

    const lifted = c.obs.coreLifted;
    if (core && core.state === 'towed' && lifted && c.hostile(lifted.side)) {
      // An enemy tow: shoot the core down from beyond its meltdown blast, clear of our own ships.
      const hunters = fleet.filter((e) => !busy.has(e.id) && c.statsOf(e).range > econ.coreMeltdownRadius && dist(e, core) <= c.statsOf(e).vision);
      if (hunters.length && !c.own.some((e) => e.plane === 'orbit' && e.kind !== 'spire' && dist(e, core) <= econ.coreMeltdownRadius)) {
        out.push({ kind: 'attack', units: ids(hunters), target: core.id });
        for (const e of hunters) busy.add(e.id);
      }
      return { busy };
    }

    // Hostile ships inside the hull hold or contest the chamber (it hides them from outside: they are what we see).
    const intruders = c.foes.filter((f) => f.plane === 'orbit' && f.kind !== 'spire' && dist(f, centre) < g.hullInner);
    const soon = open || (this.tier.coreEarly && nextOpen - tick <= CORE_LEAD);
    // After a tie the fleet holds the rival's gate mouth through the next window, rival in sight or not.
    const holding = this.contestAt !== null && tick < this.contestUntil;
    if (soon && (intruders.length || holding)) {
      // The intruder nearest the core (ties in our frame's order) sets the gate mouth and the armour we shoot at.
      let lead: Entity | undefined;
      for (const f of intruders) {
        if (!lead || gridDist2(f, centre) < gridDist2(lead, centre) || (gridDist2(f, centre) === gridDist2(lead, centre) && c.frame.pointKey(f) < c.frame.pointKey(lead))) lead = f;
      }
      // Fight them from outside the radiation when our fleet trades well (hull × damage, as the routine fleet engages).
      const fighters = fleet.filter((e) => !busy.has(e.id) && !e.lance && !e.aegis && c.statsOf(e).dmg > 0 && !mustLeave(e));
      let hull = 0, damage = 0, hostileHull = 0, hostileDamage = 0;
      for (const e of fighters) {
        const s = c.statsOf(e);
        hull += e.hp + (e.shield ?? 0);
        if (s.weapon && lead) damage += s.dmg * DAMAGE_VS[s.weapon][c.statsOf(lead).armor] / Math.max(1, s.cooldown);
      }
      for (const f of intruders) {
        const s = c.statsOf(f);
        hostileHull += f.hp + (f.shield ?? 0);
        if (s.weapon && s.dmg > 0 && fighters.length) hostileDamage += s.dmg * DAMAGE_VS[s.weapon][c.statsOf(fighters[0]!).armor] / Math.max(1, s.cooldown);
      }
      const mouth = lead ? gateMouth(g, lead) : this.contestAt;
      if (mouth && fighters.length && (!lead || (damage > 0 && hull * damage > ORBIT_TRADE_MARGIN * (1 - this.tier.aggressionShift) * hostileHull * hostileDamage))) {
        for (const e of fighters) move(e, mouth, 'fight');
      }
    }

    // Regrowing (public schedule), lifted by someone else, falling, or towed by an playerthree: nothing to grapple, and
    // the next core is a new race.
    if (c.obs.schedule.some((s) => s.kind === 'core_regrows') || (core && core.state !== 'idle') || (lifted && lifted.side !== c.army)) {
      this.coreTies = 0;
      return { busy };
    }

    // The core tug: kept while free, else the free tug nearest the ruin, else an empty miner borrowed off the rocks.
    // Only with CORE_TUGS_MIN tugs in all, miners included: the others keep working the rocks. A committed tug pulled
    // out of the radiation above stays the core tug: no second one is taken off the rocks meanwhile.
    if (busy.has(this.coreTug)) return { busy };
    const free = tugs.filter((e) => e.link === undefined && !busy.has(e.id) && !e.cargoAlloy && !e.cargoEnergy);
    let tug = free.find((e) => e.id === this.coreTug);
    if (!tug && tugs.length >= CORE_TUGS_MIN && tick >= this.coreRestUntil) {
      for (const e of free) if (!e.miningAssigned && (!tug || gridDist2(e, centre) < gridDist2(tug, centre))) tug = e;
      if (!tug) for (const e of free) if (!tug || gridDist2(e, centre) < gridDist2(tug, centre)) tug = e;
    }
    if (!tug) {
      this.coreTug = '';
      return { busy };
    }
    // A tie: our grappling tug and a hostile tug both in reach of the resting core, so neither latches (latchCore). The
    // first sight of it in a window counts once; the rival nearest ours (ties in our frame's order) names the gate
    // mouth the fleet holds through the next window.
    const reach = econ.grappleReach + 1 / OBS_GRID;
    if (core && core.state === 'idle' && tug.state === 'grappling' && dist(tug, core) <= reach && this.tieWindow !== windowStart) {
      let rival: Entity | undefined;
      for (const f of c.foes) {
        if (f.plane !== 'orbit' || !isStatKind(f.kind) || !c.stats[f.kind].capabilities.tow || dist(f, core) > reach) continue;
        if (!rival || gridDist2(f, tug) < gridDist2(rival, tug) || (gridDist2(f, tug) === gridDist2(rival, tug) && c.frame.pointKey(f) < c.frame.pointKey(rival))) rival = f;
      }
      if (rival) {
        this.tieWindow = windowStart;
        this.contestAt = gateMouth(g, rival);
        this.contestUntil = following + g.open;
        if (++this.coreTies >= this.tier.coreTies) {
          // Tied too often in a row: an exact mirror. Rest the core work (and the fleet's contest) for a while.
          this.coreTies = 0;
          this.coreRestUntil = tick + this.tier.coreTieRest;
          this.contestUntil = tick;
        }
      }
    }
    // Tied on this window: out of the radiation (held while sealed in) until the next one.
    if (this.tieWindow === windowStart) {
      if (!chamber(tug) || exiting(tug, c.stats.tug.speed)) move(tug, post);
      else busy.add(tug.id);
      this.coreTug = tug.id;
      return { busy, ward: tug };
    }
    if (tick < this.coreRestUntil) {
      this.coreTug = '';
      return { busy };
    }
    // Armed intruders keep the tug out; an unarmed one (their tug) is a race to latch on first.
    const blocked = intruders.some((f) => c.statsOf(f).dmg > 0);
    if (core && chamber(core) && (chamber(tug) || !blocked)) {
      // In sight (from inside the chamber, or a scan): latch on. Committed: it grabs unless it would die before the core
      // is out on the next exit while running now (on an open window) saves it.
      const grab = (dist(tug, core) / c.stats.tug.speed) * TICK_RATE;
      const run = outAt(dist(tug, centre), c.stats.tug.speed);
      if (chamber(tug) && open && !lasts(tug, outAt(dist(core, centre), towSpeed, grab)) && run <= windowEnd && lasts(tug, run)) {
        move(tug, post);
        this.coreTug = '';
        return { busy };
      }
      if (tug.state !== 'grappling') out.push({ kind: 'grapple', units: [tug.id], asteroid: core.id });
      busy.add(tug.id);
      this.coreTug = tug.id;
      return { busy, ward: tug };
    }
    // Ticks from here to the ring.
    const eta = (Math.max(0, dist(tug, centre) - g.ringOuter) / c.stats.tug.speed) * TICK_RATE;
    if (dist(tug, centre) >= g.hullOuter) {
      // Setting out, its hull must last from entering the chamber to the core at its centre and back out with it: on the
      // window it arrives in if the tow makes it, else the one after (it waits at the gate mouth meanwhile).
      const into = (Math.max(0, dist(tug, centre) - g.ringInner) / c.stats.tug.speed) * TICK_RATE;
      const arrive = open && windowEnd - tick >= into ? windowStart : open ? following : windowStart;
      const enter = Math.max(tick + into, arrive);
      const ready = enter + (g.ringInner / c.stats.tug.speed + g.ringInner / towSpeed) * TICK_RATE;
      const leave = ready <= arrive + g.open ? ready : Math.max(ready, arrive + derelictPeriod(g));
      if (tug.hp + (tug.shield ?? 0) <= RADIATION_MARGIN * econ.derelictRadiation * (leave - enter) / TICK_RATE) {
        this.coreTug = '';
        return { busy };
      }
    }
    this.coreTug = tug.id;
    // Set out to be at the gate mouth as it opens (or within the open window); once inside the hull it is committed.
    const go = !blocked && (dist(tug, centre) < g.hullOuter
      || (open ? openWindow(g, tick) + g.open - tick >= eta : this.tier.coreEarly && nextOpen - tick <= eta + CORE_LEAD));
    move(tug, go ? centre : post);
    return { busy, ward: tug };
  }

  /**
   * Solar arrays: each holds a berth (home berths first, then forward fields; the nearest free one in our frame's
   * order) and anchors there by itself. Hurt arrays fold to self-repair while no armed enemy is near, then unfurl.
   */
  private arrays(c: Ctx, out: AgentCommandIntent[], solars: Entity[], busy: Set<string>): void {
    if (!this.berthList.length) this.berthList = solarBerths(c.frame.toCanon(c.home.x, c.home.y), this.size, c.econ.solarShadeRadius, c.match.derelict ? c.match.derelict.hullOuter + 2 : 0);
    const alive = new Set(solars.map((e) => e.id));
    for (const id of [...this.berthOf.keys()]) if (!alive.has(id)) this.berthOf.delete(id);
    for (const id of [...this.folded]) if (!alive.has(id)) this.folded.delete(id);
    const taken = new Set(this.berthOf.values());
    for (const a of c.frame.order(solars)) {
      if (this.berthOf.has(a.id)) continue;
      let i = 0;
      while (taken.has(i)) i++;
      if (i >= this.berthList.length) continue;
      this.berthOf.set(a.id, i);
      taken.add(i);
    }
    for (const a of solars) {
      if (busy.has(a.id)) continue;
      if (this.tier.foldArrays) {
        if (this.folded.has(a.id)) {
          if (a.hp >= FOLD_HEALED * a.maxHp) {
            this.folded.delete(a.id);
            out.push({ kind: 'deploy', units: [a.id], on: true });
          }
          continue;
        }
        const near = c.foes.some((f) => f.plane === 'orbit' && f.kind !== 'spire' && isStatKind(f.kind) && c.stats[f.kind].dmg > 0 && dist(f, a) <= FOLD_SAFE);
        if (a.state === 'unfurled' && a.hp < FOLD_HP * a.maxHp && !near) {
          this.folded.add(a.id);
          out.push({ kind: 'deploy', units: [a.id], on: false });
          continue;
        }
      }
      const i = this.berthOf.get(a.id);
      if (i === undefined) continue;
      const off = this.berthList[i]!;
      const p = c.frame.offset(c.home, off.x, off.y);
      if (dist(a, p) > BERTH_AT && (a.tx === undefined || a.ty === undefined || norm(a.tx - p.x, a.ty - p.y) > AT_POINT)) {
        out.push({ kind: 'move', units: [a.id], x: p.x, y: p.y });
      }
    }
  }

  private abilities(c: Ctx, out: AgentCommandIntent[], lancers: Entity[], bastions: Entity[]): void {
    const r = c.match.rules.orbit;
    let energy = c.obs.res.freeEnergy;
    // Protect a focused ally, not merely a nearby fleet. One active bubble is enough for the same group.
    if (c.obs.research.completed.includes('aegis_projectors')) for (const b of bastions) {
      if (energy < r.aegisEnergy || (b.abilityReady ?? 0) > c.obs.tick || b.aegis || (b.shield ?? 0) <= 0) continue;
      let focused = false;
      for (const ally of c.own) {
        if (ally.plane !== 'orbit' || ally.id === b.id || dist(ally, b) > r.aegisRadius
          || c.own.some(e => e.aegis && dist(e, ally) <= r.aegisRadius)
          || out.some(i => i.kind === 'aegis' && i.units.some(id => {
            const caster = bastions.find(e => e.id === id);
            return caster && dist(caster, ally) <= r.aegisRadius;
          }))) continue;
        let attackers = 0;
        for (const foe of c.foes) if (foe.plane === 'orbit' && c.statsOf(foe).dmg > 0
          && (foe.lance && dist(ally, foe.lance) <= r.aegisRadius
            || dist(foe, ally) <= c.statsOf(foe).range + c.statsOf(ally).radius)) attackers++;
        if (attackers >= FOCUS_ATTACKERS) { focused = true; break; }
      }
      if (focused) { out.push({ kind: 'aegis', units: [b.id] }); energy -= r.aegisEnergy; }
    }
    for (const lancer of lancers) {
      if (energy < r.lanceEnergy || lancer.lance || (lancer.abilityReady ?? 0) > c.obs.tick
        || Math.abs(sunOffset(lancer.x, lancer.y, c.obs.sun.angle, this.size, c.match.sun.wedges)) >= c.match.sun.half) continue;
      let target: Entity | undefined, best = 0;
      for (const foe of c.foes) {
        if (foe.plane !== 'orbit') continue;
        const dx = foe.x - lancer.x, dy = foe.y - lancer.y, d = norm(dx, dy);
        if (d <= 0 || d > r.lanceRange) continue;
        let hits = 0;
        for (const other of c.foes) {
          if (other.plane !== 'orbit') continue;
          const ox = other.x - lancer.x, oy = other.y - lancer.y;
          const along = (ox * dx + oy * dy) / d;
          if (along > 0 && along <= r.lanceRange
            && Math.abs(ox * dy - oy * dx) / d <= r.lanceWidth + c.statsOf(other).radius) hits++;
        }
        const score = r.lanceDamage + Math.max(0, hits - 1) * r.lancePierceDamage;
        if (hits >= LANCE_HITS_MIN && score > best) { target = foe; best = score; }
      }
      if (target) { out.push({ kind: 'sun_lance', units: [lancer.id], x: target.x, y: target.y }); energy -= r.lanceEnergy; }
    }
  }
}
