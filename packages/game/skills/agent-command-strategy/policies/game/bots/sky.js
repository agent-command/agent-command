// Agent Command's built-in bot library: packages/game/src/bots/sky.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/** The Sky seat's built-in bot and its weather frame: interceptor screen, gunships (bomber escort, brawlers), island captures, bombers, seeded storms, hangar repair and jet lanes. */
import { DAMAGE_VS, footprint, isStatKind } from '../rules/stats.js';
import { VISION_BITS_PER_WORD } from '../rules/terrain.js';
import { isAircraft, isHardpointKind, isStructureKind, TICK_RATE } from '../rules/vocabulary.js';
import { sampleStorm, weatherStormAt, } from '../planes/weather.js';
import { dmath } from '../util/fdlibm.js';
import { dist, norm } from '../util/math.js';
import { canonVX, canonVY, canonX, canonY, rotX, rotY } from '../util/teams.js';
import { Ctx, centroid, ids, snap, } from './context.js';
import { PlaneBot } from './plane-bot.js';
import { answerSky, askSky } from './signals.js';
import {
  AT_POINT,
  BOMBER_SPARE_ENERGY,
  CAPTURE_COMMITTED,
  CONTROL_ISLANDS,
  COVER_DEPTH,
  COVER_DETOUR_RATIO,
  COVER_DETOUR_SLACK,
  COVER_REACH,
  DEAD_CENTRE_EPS,
  DETOUR_STEPS,
  EMPLACE_THREAT,
  ENERGY_WORTH,
  ESCAPE_TURNS,
  ESCORT_REACH,
  FLAK_COVER,
  GUNSHIP_TRIGGER,
  INTERCEPTORS_PER_GUNSHIP,
  IMPACT_SCREEN,
  ISLAND_DEFENCE_HOLD,
  ISLAND_DEFENDERS,
  ISLAND_GUARD_MARGIN,
  ISLAND_SWITCH,
  JET_GAIN,
  LATER_LEADS,
  ON_TARGET,
  RAID_INTERCEPTORS,
  REPAIR_BELOW,
  SCREEN_PAIRS_MAX,
  SEED_RAIDERS,
  SEED_SPARE_ENERGY,
  SPARE_BOMBERS,
  STORM_LEAD,
  STORM_MARGIN,
  STRIKE_WINDOW,
  STRIKES_PER_PAIR,
  WAYPOINT_MIN,
} from './tuning.js';


const within = (s, p, margin) => (p.x - s.x) * (p.x - s.x) + (p.y - s.y) * (p.y - s.y) <= (s.r + margin) * (s.r + margin);
/** Segment parameter (0..1) of the point on a→b closest to `p`. */
const closest = (a, b, p) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  return len > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
};
const along = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const clears = (a, b, s, margin) => !within(s, along(a, b, closest(a, b, s)), margin);
/** Canonical order for exact ties: rotated seats see identical own-frame points in different list orders. */
const before = (p, q) => p.x < q.x || (p.x === q.x && p.y < q.y);
/** A public seeded-storm telegraph covers world point `p` (centre-relative, like weatherStormAt): an imminent storm. */
const warnedAt = (warnings, p, size) => warnings.some((w) => {
  const dx = (p.x - size / 2) - (w.x - size / 2), dy = (p.y - size / 2) - (w.y - size / 2);
  return w.radius > 0 && dx * dx + dy * dy <= w.radius * w.radius;
});

/**
 * Gunship or interceptor: which kind fights the visible hostile Sky force better per cost. Lanchester's square law: a
 * force bought with budget B is worth B² × effective HP × effective DPS / cost². Effective HP = HP ÷ the `threats`'
 * DPS-weighted DAMAGE_VS on the kind's armour (whatever can hit the Sky: flak, turrets, aircraft, Gun Platforms);
 * effective DPS = its DPS × the `targets`' HP-weighted DAMAGE_VS on theirs (hostile aircraft, Gun Platforms). With no
 * target given only HP per cost under the threats counts (an escort's job: outlast the fire). Cost = alloy +
 * ENERGY_WORTH × energy. Threats or targets may repeat a kind (one entry per visible entity).
 */
export function airValue(stats, kind, threats, targets) {
  const s = stats[kind];
  const dps = (r) => (r.weapon && r.dmg > 0 ? r.dmg / Math.max(1, r.cooldown) : 0);
  let fire = 0, felt = 0;
  for (const t of threats) {
    const r = stats[t];
    fire += dps(r);
    if (r.weapon) felt += dps(r) * DAMAGE_VS[r.weapon][s.armor];
  }
  const hp = felt > 0 ? s.hp * fire / felt : s.hp;
  const cost = s.alloy + ENERGY_WORTH * s.energy;
  if (!targets.length || !s.weapon) return hp / cost;
  let body = 0, hit = 0;
  for (const t of targets) {
    body += stats[t].hp;
    hit += stats[t].hp * DAMAGE_VS[s.weapon][stats[t].armor];
  }
  return hp * dps(s) * hit / body / (cost * cost);
}
/**
 * Public Sky weather in the seat's own frame: every army works on the rotation of everything into its canonical frame,
 * so rotated seats compute identical numbers and issue exactly rotated orders. Fog-safe: public match data, weather
 * and entities only.
 */
class SkyFrame {
 obs;
  /** our frame: quarter turns from the NW corner */
 k;
 size;
 jetWith;
  /** jet lanes in our frame: along x (`horizontal`, at y = `at`) or along y (at x = `at`), flowing with sign of `v` */
 lanes;
 sampled = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' };

  constructor(c) {
    this.obs = c.obs;
    this.k = c.frame.k;
    this.jetWith = c.econ.jetWith;
    this.size = c.size;
    this.lanes = c.match.jets.map((l) => {
      const vx = canonVX(this.k, l.dx, l.dy);
      const horizontal = canonVY(this.k, l.dx, l.dy) === 0;
      return horizontal
        ? { horizontal, at: canonY(this.k, l.x1, l.y1, this.size), v: vx }
        : { horizontal, at: canonX(this.k, l.x1, l.y1, this.size), v: canonVY(this.k, l.dx, l.dy) };
    });
  }

  /** An observed point in this frame: observations are on a binary grid, so the turn is exact. */
  at(p) {
    return { x: canonX(this.k, p.x, p.y, this.size), y: canonY(this.k, p.x, p.y, this.size) };
  }

  /** An own-frame point as world order coordinates. */
  order(p) {
    const x = snap(p.x, this.size), y = snap(p.y, this.size);
    return { x: rotX(this.k, x, y, this.size), y: rotY(this.k, x, y, this.size) };
  }

  /**
   * Announced storms `ahead` ticks from now; a function gives each its flight-arrival lead.
   * Forecasts become hazards only as they form; shrinking/expired cells are sampled exactly.
   * Seeded storms stay put until their public expiry; a telegraphed one (weather.seedWarnings) counts as formed, even
   * our own (own aircraft only take seededOwnDamage there, but still have no business in it).
   */
  storms(ahead) {
    const lead = (now) => (typeof ahead === 'number' ? ahead : ahead(now));
    const out = [];
    const weather = this.obs.weather;
    for (let i = 0; i < weather.storms.length + weather.forecast.length; i++) {
      const s = i < weather.storms.length ? weather.storms[i] : weather.forecast[i - weather.storms.length];
      sampleStorm(s, this.obs.tick, this.sampled, this.k, this.size);
      const p = { x: this.sampled.x, y: this.sampled.y, r: this.sampled.radius };
      const t = lead(p);
      sampleStorm(s, this.obs.tick + t, this.sampled, this.k, this.size);
      if (this.sampled.radius <= 0) continue;
      p.x = this.sampled.x; p.y = this.sampled.y; p.r = this.sampled.radius;
      out.push(p);
    }
    for (const s of this.obs.weather.seeded) {
      const p = { x: canonX(this.k, s.x, s.y, this.size), y: canonY(this.k, s.x, s.y, this.size), r: s.radius };
      const t = lead(p);
      if (t === 0 || s.until > this.obs.tick + t) out.push(p);
    }
    for (const s of this.obs.weather.seedWarnings) {
      out.push({ x: canonX(this.k, s.x, s.y, this.size), y: canonY(this.k, s.x, s.y, this.size), r: s.radius });
    }
    return out;
  }

  /**
   * The nearest point clear of the storms now, after STORM_LEAD and after LATER_LEADS leads, around each storm holding
   * `u`: undefined unless `u` is inside one now (or, `early`, by the lead).
   */
  escape(u, now, soon, later, early) {
    if (!now.some((s) => within(s, u, 0)) && !(early && soon.some((s) => within(s, u, 0)))) return undefined;
    const options = [];
    for (const s of [...now, ...soon, ...later]) {
      if (!within(s, u, 0)) continue;
      const base = dmath.atan2(u.y - s.y, u.x - s.x);
      for (const turn of ESCAPE_TURNS) {
        options.push({ x: snap(s.x + dmath.cos(base + turn) * (s.r + STORM_MARGIN), this.size), y: snap(s.y + dmath.sin(base + turn) * (s.r + STORM_MARGIN), this.size) });
      }
    }
    // Prefer a spot the storm will not reach soon; relax to its next few seconds, then to anything (boxed in).
    for (const checks of [[now, soon, later], [now, soon], []]) {
      let best;
      let gap = Infinity;
      for (const p of options) {
        if (checks.some((list) => list.some((s) => within(s, p, STORM_MARGIN / 2)))) continue;
        const d = dist(p, u);
        if (d < gap || (d === gap && best && before(p, best))) [best, gap] = [p, d];
      }
      if (best) return best;
    }
    return undefined;
  }

  /**
   * Waypoints from `a` to `b` at `speed` tiles/s: along a jet lane when clearly faster, else beside the first storm
   * (forecast for when the flight gets there) that the straight line would cross. Endpoints inside storms are
   * deliberate and keep the straight line.
   */
  route(a, b, speed) {
    const storms = this.storms((s) => Math.round(dist(a, along(a, b, closest(a, b, s))) / speed * TICK_RATE));
    const soon = this.storms(STORM_LEAD);
    let lane = [];
    let best = dist(a, b) / speed * JET_GAIN;
    for (const l of this.lanes) {
      if ((l.horizontal ? b.x - a.x : b.y - a.y) * l.v <= 0) continue;
      const e = l.horizontal ? { x: a.x, y: l.at } : { x: l.at, y: a.y };
      const x = l.horizontal ? { x: b.x, y: l.at } : { x: l.at, y: b.y };
      const time = (dist(a, e) + dist(x, b)) / speed + dist(e, x) / (speed * this.jetWith);
      if (time > best || (time === best && lane.length > 0 && !before(e, lane[0]))) continue;
      if (!soon.every((s) => clears(a, e, s, 0) && clears(e, x, s, 0) && clears(x, b, s, 0))) continue;
      [lane, best] = [[e, x], time];
    }
    if (lane.length) return lane.filter((p, i) => dist(p, i === 0 ? a : b) > WAYPOINT_MIN);
    let hit;
    let first = Infinity;
    for (const s of storms) {
      if (within(s, a, 0) || within(s, b, 0) || clears(a, b, s, STORM_MARGIN)) continue;
      const t = closest(a, b, s);
      if (t < first || (t === first && hit && before(s, hit))) [hit, first] = [s, t];
    }
    if (!hit) return [];
    const p = along(a, b, first);
    let nx = p.x - hit.x, ny = p.y - hit.y;
    // Dead centre: pass on the left of the flight.
    if (nx * nx + ny * ny < DEAD_CENTRE_EPS) [nx, ny] = [a.y - b.y, b.x - a.x];
    const len = norm(nx, ny);
    for (const side of [1, -1]) {
      for (let k = 0; k < DETOUR_STEPS; k++) {
        const d = (hit.r + STORM_MARGIN) * (1 + k / DETOUR_STEPS);
        const w = { x: snap(hit.x + side * nx / len * d, this.size), y: snap(hit.y + side * ny / len * d, this.size) };
        if (clears(a, w, hit, 0) && clears(w, b, hit, 0) && !soon.some((s) => within(s, w, STORM_MARGIN / 2))) return [w];
      }
    }
    return [];
  }

  /** A point just inside the storm nearest `target` (forecast for arrival), to hide a strike's approach from flak. */
  cover(a, target, speed) {
    const storms = this.storms(Math.round(dist(a, target) / speed * TICK_RATE));
    let hit;
    let gap = COVER_REACH;
    for (const s of storms) {
      const g = dist(target, s) - s.r;
      // A target inside a storm already hides the whole strike.
      if (g <= 0) return undefined;
      if (g < gap || (g === gap && hit && before(s, hit))) [hit, gap] = [s, g];
    }
    if (!hit) return undefined;
    const d = dist(target, hit);
    const stage = { x: snap(hit.x + (target.x - hit.x) / d * Math.max(0, hit.r - COVER_DEPTH), this.size), y: snap(hit.y + (target.y - hit.y) / d * Math.max(0, hit.r - COVER_DEPTH), this.size) };
    return dist(a, stage) + dist(stage, target) <= COVER_DETOUR_RATIO * dist(a, target) + COVER_DETOUR_SLACK ? stage : undefined;
  }
}

export class SkyBot extends PlaneBot {
 sweepAt = 0;
 intercepting = false;
  /** island the interceptors and gunships are taking */
 target = '';
  /** enemy asteroid strikes seen falling (id → tick first seen), over the last STRIKE_WINDOW ticks */
 strikes = new Map();
  /** gunship flying to emplace on `emplaceOn`'s hardpoint ('' = none) */
 emplacer = '';
 emplaceOn = '';
  /** Per-island escorts survive other fleet jobs and short-lived claim changes. */
 guards = new Map();

 decide(c) {
    const out = [];
    const t = this.tier;
    const tick = c.obs.tick;
    const interceptors = c.units('interceptor').filter((e) => !e.hangar && !(e.transit?.at ?? 0));
    const raiders = c.units('interceptor', 'orbit').filter((e) => (e.transit?.until ?? 0) > tick);
    const bombers = c.units('bomber').filter(e => !e.hangar);
    const gunships = c.units('gunship').filter((e) => !e.hangar);
    // Frame order: symmetric island sets sit at equal distances from rotated homes; first-found must mean rotated.
    const islands = c.frame.order(c.obs.entities.filter((e) => e.kind === 'island'));
    const held = islands.filter((i) => i.side === c.army);

    // The interceptor screen comes first (it is the answer to asteroid strikes): rebuilt without keeping the reserve,
    // and two more for every STRIKES_PER_PAIR hostile strikes in the last two minutes (up to SCREEN_PAIRS_MAX pairs).
    for (const i of c.obs.impacts) if (c.hostile(i.side) && !this.strikes.has(i.id)) this.strikes.set(i.id, tick);
    for (const [id, at] of this.strikes) if (tick - at > STRIKE_WINDOW) this.strikes.delete(id);
    const screen = t.interceptors + 2 * Math.min(SCREEN_PAIRS_MAX, Math.floor(this.strikes.size / STRIKES_PER_PAIR));
    // Earliest impact first; simultaneous impacts in this frame's order (impacts arrive in world order), as the example
    // Sky policy does, so rotated armies screen rotated rocks.
    const incoming = c.frame.order(c.obs.impacts.filter((i) => c.hostile(i.side))).sort((a, b) => a.tick - b.tick);
    // Matching their anti-air is enough: in an exact mirror the counts are equal and a strict lead never comes.
    const skyControl = held.length >= Math.max(1, Math.round(CONTROL_ISLANDS - CONTROL_ISLANDS * t.aggressionShift))
      && interceptors.length >= Math.max(1, Math.ceil(screen * (1 - t.aggressionShift)))
      && interceptors.length + gunships.length >= c.foes.filter((e) => e.plane === 'sky' && c.statsOf(e).targets.includes('sky')).length;
    // Tie-break: spare energy over held islands buys one bomber pair even without control.
    const spare = held.length >= CONTROL_ISLANDS && c.obs.res.freeEnergy > BOMBER_SPARE_ENERGY;
    const bomberCap = skyControl ? t.bombers : spare ? Math.min(t.bombers, SPARE_BOMBERS) : 0;
    // Gunships by a cost/threat comparison against interceptors on what we see (airValue): one escort per bomber while
    // gunships outlast interceptors per cost under the hostile anti-air (heavy_air takes flak and missiles at less than
    // air does, on far more HP), and brawlers against a hostile interceptor swarm while they also out-trade
    // interceptors per cost there. Interceptors stay the asteroid screen. The bomber pair (Sky control or spare energy
    // only) comes first: it is the opening an exact anti-air tie earns, and a bounded one.
    const threats = [];
    const targets = [];
    let foeInterceptors = 0;
    for (const e of c.foes) {
      if (!isStatKind(e.kind) || e.kind === 'spire' || e.plane === 'orbit') continue;
      const s = c.statsOf(e);
      if (!(s.dmg > 0 && s.targets.includes('sky'))) continue;
      threats.push(e.kind);
      // Targets: the Sky's own fighters (interceptors, gunships, Gun Platforms), what a brawler trades fire with.
      if (e.plane === 'sky') targets.push(e.kind);
      if (e.plane === 'sky' && e.kind === 'interceptor') foeInterceptors++;
    }
    const escorting = airValue(c.stats, 'gunship', threats, []) >= airValue(c.stats, 'interceptor', threats, []);
    const brawling = foeInterceptors >= GUNSHIP_TRIGGER && airValue(c.stats, 'gunship', threats, targets) > airValue(c.stats, 'interceptor', threats, targets);
    const gunshipCap = c.econ.gunshipEnabled
      ? Math.min(t.gunships, (escorting ? bomberCap : 0) + (brawling ? Math.ceil(foeInterceptors / INTERCEPTORS_PER_GUNSHIP) : 0)) : 0;
    const researched = c.obs.research.completed.includes('ascent_thrusters');
    const wanted = screen + (researched && t.bombers > 0 ? RAID_INTERCEPTORS : 0);
    let interceptorCount = 0, gunshipCount = 0, bomberCount = 0;
    for (const e of c.own) {
      if (e.kind === 'interceptor') interceptorCount++;
      else if (e.kind === 'gunship') gunshipCount++;
      else if (e.kind === 'bomber') bomberCount++;
    }
    if (interceptorCount + c.queued('interceptor') < wanted) this.produce(c, out, 'interceptor', 'sky', 0);
    else if (bomberCount + c.queued('bomber') < bomberCap) this.produce(c, out, 'bomber', 'sky');
    else if (gunshipCount + c.queued('gunship') < gunshipCap) this.produce(c, out, 'gunship', 'sky');
    if (!incoming.length && t.bombers > 0)
      this.research(c, out, 'ascent_thrusters', { interceptor: wanted, bomber: bomberCap > 0 ? bomberCap : bomberCount + c.queued('bomber') }, t.reserve.sky);
    // Powered Aeries in frame order: rotated seats pick rotated hangars.
    const aeries = c.frame.order(c.own.filter((e) => e.kind === 'aerie' && e.state === 'active'));
    const aerie = aeries[0];
    if (aerie) for (const intent of out) if (intent.kind === 'queue_add' && isAircraft(intent.item)) intent.producer = aerie.id;
    if (aerie && !c.segmentAlive('sky') && interceptorCount < wanted && c.queued('interceptor') === 0 &&
      c.ownQueued() < t.queueDepth && !out.some(i => i.kind === 'queue_add' && i.item === 'interceptor') && c.affordable('interceptor', 0)) {
      out.push({ kind: 'queue_add', item: 'interceptor', producer: aerie.id, ifAffordable: true });
    }
    this.orbitCombat(c, out, raiders);
    // Hostile asteroids falling while the screen is short: our next interceptor first.
    if (interceptors.length < screen && incoming.length) this.rushDefence(c, out, ['interceptor']);
    // Choose the scarce slot from observed demand, not a fixed two-Relay opening.
    const has = (kind) => c.own.some(e => e.kind === kind) || c.queued(kind) > 0;
    const relays = c.own.filter((e) => e.kind === 'relay').length + c.queued('relay');
    const repairNeed = c.econ.aerieRepairEnabled && [...interceptors, ...gunships, ...bombers].some(e => e.hp < e.maxHp);
    const productionNeed = c.obs.queue.some(q => isAircraft(q.item)) || interceptorCount < wanted || bomberCap > bomberCount;
    const clipped = c.obs.res.solarRate > c.obs.res.energyCap;
    const rooted = c.segmentAlive('sky');
    const item = t.relays <= 0 ? undefined : relays === 0 ? 'relay'
      : rooted && !has('aerie') && (repairNeed || productionNeed) ? 'aerie'
      : relays < t.relays && clipped ? 'relay'
      : rooted && !has('stormcatcher') ? 'stormcatcher'
      : rooted && !has('aerie') ? 'aerie'
      : rooted && c.econ.seederEnabled && c.econ.seederDuration > 0 && !has('storm_seeder') ? 'storm_seeder' : undefined;
    const queuedOn = new Set(c.obs.queue.filter(q => !isHardpointKind(q.item)).map(q => q.island));
    const free = item && c.affordable(item, t.reserve.sky)
      ? held.filter(i => i.link === undefined && !queuedOn.has(i.id) && i.state !== 'capturing' && i.state !== 'contested')
        .sort((a, b) => this.islandValue(c, a) - this.islandValue(c, b))[0] : undefined;
    this.emplace(c, out, held, gunships);
    // Reserve defenders before support requests, repair, escort, ascent or interception can take them.
    const protectedSite = this.guardIslands(c, out, held, interceptors, gunships, free);
    if (free && item && protectedSite) {
      out.push({ kind: 'queue_add', item, island: free.id });
      c.reserveCost(c.stats[item].alloy, c.stats[item].energy);
    }
    this.mortars(c, out, held, interceptorCount >= screen && !incoming.length);
    this.oreIslands(c, out, held, interceptorCount >= screen && !incoming.length);
    answerSky(this.desk, c, out, interceptors, bombers, skyControl);
    askSky(this.desk, c, held);
    this.seed(c, out);

    // Damaged aircraft fly home to the nearest powered Aerie with room and repair in its hangar (aerieRepairEnabled);
    // the asteroid screen stays up while rocks fall.
    const repair = c.econ.aerieRepairEnabled;
    const rooms = aeries.map((a) => c.econ.aerieCapacity - c.own.filter((e) => e.hangar === a.id).length);
    const docks = aeries.map(() => []);
    const homing = [];
    if (repair) {
      for (const e of [...interceptors, ...gunships, ...bombers]) {
        if (e.hp >= e.maxHp * REPAIR_BELOW || (incoming.length > 0 && e.kind === 'interceptor')) continue;
        let best = -1;
        for (let i = 0; i < aeries.length; i++) if (rooms[i] > 0 && (best < 0 || dist(aeries[i], e) < dist(aeries[best], e))) best = i;
        if (best < 0) break;
        const a = aeries[best];
        if (dist(e, a) <= c.econ.aerieDockRadius) docks[best].push(e);
        else if (e.tx === undefined || e.ty === undefined || dist({ x: e.tx, y: e.ty }, a) > c.econ.aerieDockRadius / 2) out.push({ kind: 'move', units: [e.id], x: a.x, y: a.y });
        rooms[best] = rooms[best] - 1;
        homing.push(e);
      }
    }
    const drop = (gone) => {
      for (const list of [interceptors, gunships, bombers]) for (const e of gone) if (list.includes(e)) list.splice(list.indexOf(e), 1);
    };
    drop(homing);
    for (let i = 0; i < aeries.length; i++) {
      const structure = aeries[i];
      // A seeded storm telegraphed over the Aerie counts as one already blowing.
      const storm = weatherStormAt(c.obs.weather, structure.x, structure.y, this.size) || warnedAt(c.obs.weather.seedWarnings, structure, this.size);
      const housed = c.own.filter(e => e.hangar === structure.id);
      // Housed aircraft wait out storms and, with hangar repair, stay until whole; falling rocks launch the screen.
      const launch = housed.filter(e => e.state === 'hangared'
        && ((incoming.length > 0 && e.kind === 'interceptor') || (!storm && !(repair && e.hp < e.maxHp))));
      if (launch.length) out.push({ kind: 'launch', units: ids(launch) });
      const shelter = [...interceptors, ...gunships, ...bombers].filter(e => storm && e.hp < e.maxHp && dist(e, structure) <= c.econ.aerieDockRadius).slice(0, Math.max(0, rooms[i]));
      const enter = [...docks[i], ...shelter];
      if (enter.length) {
        out.push({ kind: 'hangar', target: structure.id, units: ids(enter) });
        drop(shelter);
      }
      const cost = c.stats.trooper;
      if ((structure.ready ?? 0) <= tick && c.hostileSpireDist(structure) < dist(structure, c.home)
        && c.obs.res.freeAlloy >= cost.alloy * c.econ.aerieDropCount + t.reserve.sky
        && c.obs.res.freeEnergy >= cost.energy * c.econ.aerieDropCount) out.push({ kind: 'airdrop', aerie: structure.id });
    }

    // Keep the defensive screen in the Sky; only surplus, ready interceptors join an Orbit raid.
    if (researched && skyControl && !incoming.length) {
      const ready = interceptors.filter((e) => (e.transitReady ?? 0) <= tick && !(e.transit?.until ?? 0));
      const count = Math.max(0, Math.min(RAID_INTERCEPTORS, interceptors.length - screen, c.econ.ascentEnergy > 0 ? Math.floor(c.obs.res.freeEnergy / c.econ.ascentEnergy) : RAID_INTERCEPTORS));
      const raid = ready.slice(0, count);
      if (raid.length) {
        out.push({ kind: 'ascend', units: ids(raid) });
        for (const e of raid) interceptors.splice(interceptors.indexOf(e), 1);
      }
    }
    // Preserve the urgent asteroid screen, but still get unrelated gunships and bombers out of passing storms.
    const f = new SkyFrame(c);
    const now = f.storms(0);
    const soon = f.storms(STORM_LEAD);
    const escapes = this.leaveStorms(c, f, incoming.length ? [...gunships, ...bombers] : [...interceptors, ...gunships, ...bombers], islands, now, soon, out);
    if (incoming.length && interceptors.length) {
      // Explicit attacks leave island escorts alone; the global macro would overwrite every interceptor.
      for (const impact of incoming) {
        const rock = c.obs.entities.find(e => e.id === impact.id);
        const count = rock ? Math.max(1, Math.ceil(rock.hp / Math.max(1, c.stats.interceptor.dmg)
          / Math.max(1, (impact.tick - tick) / c.stats.interceptor.cooldown))) : IMPACT_SCREEN;
        const squad = c.frame.order(interceptors).sort((a, b) => dist(a, impact) - dist(b, impact)).slice(0, count);
        if (squad.length) out.push({ kind: 'attack', units: ids(squad), target: impact.id });
        for (const e of squad) interceptors.splice(interceptors.indexOf(e), 1);
      }
      this.intercepting = true;
    }
    if (!incoming.length && this.intercepting) {
      this.intercepting = false;
      this.sweepAt = 0;
    }

    const queue = (queued) => (queued ? { queue: true } : {});
    // Bomber escort: one gunship per bomber (frame order: rotated seats pick rotated gunships) leaves the island sweep
    // and flies with the bombers (below), fighting what comes at them on the way.
    const escorts = escorting && t.bombers > 0 ? c.frame.order(gunships).slice(0, bombers.length) : [];
    for (const e of escorts) gunships.splice(gunships.indexOf(e), 1);

    // Island escorts were reserved above; only the remaining fleet sweeps or attacks crowns.
    const fighters = [...interceptors, ...gunships];
    const capturers = fighters.filter((e) => c.statsOf(e).capabilities.capture);
    if (tick >= this.sweepAt && fighters.length && c.crown === 'sky' && skyControl) {
      // Crowns: the focus's Sky segment is its weakest crown and the sky is ours: the fighters go for it (attack it once
      // seen, else fight-move to its Spire).
      const segment = c.foes.find((e) => e.kind === 'spire' && e.plane === 'sky' && e.side === c.focus.id);
      const p = segment ?? c.foeAt;
      this.send(c, f, fighters, f.at(p), escapes, out, (units, queued) => (segment
        ? { kind: 'attack', units, target: segment.id, ...queue(queued) }
        : { kind: 'move', units, x: p.x, y: p.y, mode: 'fight', ...queue(queued) }));
      this.sweepAt = tick + t.recaptureEvery;
    } else if (tick >= this.sweepAt && fighters.length) {
      // Concentrate on the nearest island we do not hold (kept while it is not ours); with all held, hunt what is in reach.
      const home = c.home;
      const unheld = islands.filter((i) => i.side !== c.army);
      // A storm-swept island (now or by the lead) is only worth the damage when taking it destroys a hostile structure.
      const pool = unheld.filter((i) => {
        const p = f.at(i);
        return (c.hostile(i.side) && i.link !== undefined) || !(now.some((s) => within(s, p, 0)) || soon.some((s) => within(s, p, 0)));
      });
      const nearest = pool.reduce((b, i) => (!b || this.islandValue(c, i) < this.islandValue(c, b) ? i : b), undefined);
      // Sticky: keep the current island until it is ours, unless another is clearly (ISLAND_SWITCH) nearer home.
      const current = pool.find((i) => i.id === this.target);
      const pick = current && nearest && this.islandValue(c, nearest) > ISLAND_SWITCH * this.islandValue(c, current) ? current : nearest;
      this.target = pick?.id ?? '';
      if (pick && capturers.length) {
        // Only armed hostile hardpoints stall capture; an unarmed extractor need not be shot first.
        const mount = c.foes.find((e) => isHardpointKind(e.kind) && c.statsOf(e).dmg > 0 && dist(e, pick) < AT_POINT);
        if (mount) {
          this.send(c, f, capturers, f.at(pick), escapes, out, (units, queued) => ({ kind: 'attack', units, target: mount.id, ...queue(queued) }));
          out.push({ kind: 'capture', units: ids(capturers), island: pick.id, queue: true });
        } else this.send(c, f, capturers, f.at(pick), escapes, out, (units, queued) => ({ kind: 'capture', units, island: pick.id, ...queue(queued) }));
      } else if (!pick) {
        const at = centroid(fighters);
        const target = c.foes.filter((e) => e.plane === 'sky')
          .reduce((best, e) => !best || dist(e, at) < dist(best, at) ? e : best, undefined);
        if (target) this.send(c, f, fighters, f.at(target), escapes, out, (units, queued) => ({ kind: 'attack', units, target: target.id, ...queue(queued) }));
      }
      this.sweepAt = tick + t.recaptureEvery;
    }

    if (bombers.length && t.bombers > 0) {
      // A turret ring is bombed turret by turret, the outer one first (the one the tanks siege); else a hostile
      // Headframe (their lode income: flak around it is the answer), else the focus's Spire.
      const siege = this.siegeTarget(c);
      const frame = t.raidLodes ? c.foes.find((e) => e.kind === 'headframe') : undefined;
      const target = siege
        ? c.foes.find((e) => e.id === siege.id)
        : (frame ?? c.foes.find((e) => e.kind === 'spire' && e.plane === 'surface' && e.side === c.focus.id) ?? c.foes.find((e) => e.plane === 'surface' && (e.kind === 'turret' || e.kind === 'flak')));
      const idle = bombers.filter((b) => b.state === 'idle' || escapes.has(b.id));
      if (target && idle.length) {
        // Veteran: flak around the target makes a storm-hidden approach worth its damage.
        const cover = t.skyWeather === 'cover' && c.foes.some((e) => e.kind === 'flak' && dist(e, target) <= FLAK_COVER);
        this.send(c, f, idle, f.at(target), escapes, out, (units, queued) => ({ kind: 'attack', units, target: target.id, ...queue(queued) }), cover);
      } else if (idle.length) {
        const remembered = t.raidLodes ? [...this.headframesSeen.values()][0] : undefined;
        const p = siege ?? remembered ?? c.foeAt;
        this.send(c, f, idle, f.at(p), escapes, out, (units, queued) => ({ kind: 'move', units, x: p.x, y: p.y, mode: 'fight', ...queue(queued) }));
      }
      // Escorts fight-move onto the bombers' centre whenever they have fallen ESCORT_REACH behind it (not mid-escape).
      const w = f.order(centroid(bombers.map((b) => f.at(b))));
      const stray = escorts.filter((e) => !escapes.has(e.id) && dist(e, w) > ESCORT_REACH
        && (e.tx === undefined || e.ty === undefined || dist({ x: e.tx, y: e.ty }, w) > ESCORT_REACH));
      if (stray.length) out.push({ kind: 'move', units: ids(stray), x: w.x, y: w.y, mode: 'fight' });
    }
    return out;
  }

  /**
   * Keep separate, sticky escorts for investments and threatened claims. A new site is paid for only once its
   * assigned aircraft are actually in capture range and outmatch visible local anti-air. Public claim state
   * alone is never permission to spend into an enemy occupation.
   */
 guardIslands(c, out, held, air, guns, site) {
    if (!this.tier.defendIslands) return false;
    const tick = c.obs.tick;
    const reach = c.econ.captureRadius + EMPLACE_THREAT;
    const occupied = (i) => i.state === 'capturing' || i.state === 'contested';
    const invested = (i) => i.link !== undefined
      || c.obs.islands.some(p => p.id === i.id && p.hardpoint !== undefined) || c.obs.queue.some(q => q.island === i.id);
    const wanted = held.filter(i => occupied(i) || invested(i) || (i.oreRemaining ?? 0) > 0 || i.id === site?.id || (this.guards.get(i.id)?.until ?? 0) > tick);
    for (const id of this.guards.keys()) if (!wanted.some(i => i.id === id)) this.guards.delete(id);
    // Preserve established posts before filling new ones. This prevents an alternating claim from moving every plane.
    wanted.sort((a, b) => Number(this.guards.has(b.id)) - Number(this.guards.has(a.id))
      || Number(occupied(b)) - Number(occupied(a)) || Number(invested(b)) - Number(invested(a))
      || Number(b.id === site?.id) - Number(a.id === site?.id));
    let safe = false;
    for (const island of wanted) {
      const foes = c.foes.filter(e => isStatKind(e.kind) && dist(e, island) <= reach
        && c.statsOf(e).targets.includes('sky') && c.statsOf(e).dmg > 0);
      const old = this.guards.get(island.id);
      const repairable = !occupied(island) && !foes.length && island.id !== site?.id
        && c.own.some(e => e.id === island.link && e.state !== 'constructing') && c.econ.aerieRepairEnabled
        && c.own.some(e => e.kind === 'aerie' && e.state === 'active');
      const available = c.frame.order([...air, ...guns].filter(e => c.statsOf(e).capabilities.capture
        && (!repairable || e.hp >= e.maxHp * REPAIR_BELOW)));
      available.sort((a, b) => Number(old?.units.includes(b.id) ?? false) - Number(old?.units.includes(a.id) ?? false)
        || dist(a, island) - dist(b, island));
      const defenders = available.slice(0, Math.max(ISLAND_DEFENDERS, foes.length + (foes.length ? ISLAND_DEFENDERS : 0),
        old && old.until > tick ? old.units.length : 0));
      if (!defenders.length) { this.guards.delete(island.id); continue; }
      const units = ids(defenders);
      const changed = !old || old.units.length !== units.length || units.some(id => !old.units.includes(id));
      const displaced = defenders.some(e => e.state === 'idle' || (e.work !== undefined && dist(e.work, island) > AT_POINT)
        || (e.state === 'moving' && !e.queue && e.tx !== undefined && e.ty !== undefined && dist({ x: e.tx, y: e.ty }, island) > c.econ.captureRadius));
      if (changed || displaced || tick >= old.refresh) out.push({ kind: 'capture', units, island: island.id });
      this.guards.set(island.id, { units, until: occupied(island) || foes.length > 0 || island.id === site?.id ? tick + ISLAND_DEFENCE_HOLD : old?.until ?? tick,
        refresh: changed || displaced || tick >= old.refresh ? tick + ISLAND_DEFENCE_HOLD : old.refresh });
      for (const e of defenders) {
        const list = e.kind === 'interceptor' ? air : guns;
        list.splice(list.indexOf(e), 1);
      }
      if (island.id === site?.id) {
        const local = defenders.filter(e => dist(e, island) <= c.econ.captureRadius);
        safe = !occupied(island) && local.length >= ISLAND_DEFENDERS && local.length > foes.length
          && local.reduce((hp, e) => hp + e.hp, 0) > foes.reduce((hp, e) => hp + e.hp, 0)
          && !weatherStormAt(c.obs.weather, island.x, island.y, this.size) && !warnedAt(c.obs.weather.seedWarnings, island, this.size);
      }
    }
    return safe;
  }

  /** A modest economic tie-break, never a reason to abandon weather, guards or a committed capture. */
 islandValue(c, island) {
    const useful = (island.oreRemaining ?? island.oreCapacity ?? 0) > c.stats.ore_extractor.alloy
      && !c.foes.some(e => isStatKind(e.kind) && c.statsOf(e).dmg > 0 && c.statsOf(e).targets.includes('sky')
        && dist(e, island) <= c.econ.captureRadius + EMPLACE_THREAT);
    return dist(island, c.home) * (useful ? 0.8 : 1);
  }

  /** Release only above known clear ground already serviced by a friendly cache collector. No ground orders here. */
 oreDropServiced(c, island) {
    const cell = Math.floor(island.y) * this.size + Math.floor(island.x);
    if (!c.walkable(cell) || !((c.obs.surfaceVision[Math.floor(cell / VISION_BITS_PER_WORD)] ?? 0) & (1 << (cell % VISION_BITS_PER_WORD)))) return false;
    const centre = { x: Math.floor(island.x) + 0.5, y: Math.floor(island.y) + 0.5 };
    const radius = c.econ.oreCacheRadius;
    if (c.obs.entities.some(e => {
      const f = e.plane === 'surface' ? footprint(e.kind) : undefined;
      return f && Math.abs(e.x - centre.x) < f.w / 2 + 0.5 && Math.abs(e.y - centre.y) < f.h / 2 + 0.5;
    }) || c.foes.some(e => e.plane === 'surface' && isStatKind(e.kind) && dist(e, centre) < c.statsOf(e).range + radius + 2)
      || c.obs.scorches.some(s => s.until > c.obs.tick && dist(s, centre) < s.radius + radius)
      || c.obs.impacts.some(i => dist(i, centre) < c.match.rules.orbit.largeImpactRadius + radius)) return false;
    // A tile of margin covers nearest-cell placement and observation rounding without guessing hidden blockers.
    return radius > 1 && c.own.some(e => e.plane === 'surface' && (e.kind === 'trooper' || e.kind === 'flak')
      && !e.hangar && !e.transit && e.hp >= e.maxHp * 0.6 && dist(e, island) <= radius - 1);
  }

 oreIslands(c, out, held, screenReady) {
    for (const island of held) {
      if ((island.oreBuffer ?? 0) > 0 && this.oreDropServiced(c, island)) out.push({ kind: 'drop_ore', island: island.id });
      if (island.oreRemaining !== 0) continue;
      const extractor = c.own.find(e => e.kind === 'ore_extractor' && e.link === island.id && e.state !== 'constructing');
      if (extractor) out.push({ kind: 'dismantle', structure: extractor.id });
    }
    const stats = c.stats.ore_extractor;
    const upkeep = c.obs.res.upkeep + c.econ.extractorUpkeep * (1 + c.queued('ore_extractor'));
    if (!screenReady || !this.tier.defendIslands || this.tier.relays <= 0 || !c.segmentAlive('sky')
      || c.econ.islandHardpoints < 1 || c.econ.extractorRate <= 0 || c.econ.extractorBuffer <= 0
      || c.obs.res.energyRate < upkeep || c.own.some(e => e.extractorPowered === false)
      || c.ownQueued() >= this.tier.queueDepth
      || c.own.filter(e => isStructureKind(e.kind) && e.kind !== 'spire').length >= c.econ.structureCap
      || !c.affordableCost(stats.alloy, stats.energy + Math.max(c.stats.interceptor.energy, upkeep * 10), this.tier.reserve.sky)) return;
    const island = held.find(i => (i.oreRemaining ?? 0) > 0 && i.state !== 'capturing' && i.state !== 'contested' && !(i.progress ?? 0)
      && i.id !== this.emplaceOn && !c.obs.islands.some(p => p.id === i.id && p.hardpoint !== undefined)
      && !c.own.some(e => isHardpointKind(e.kind) && e.link === i.id)
      && !c.obs.queue.some(q => q.island === i.id && isHardpointKind(q.item))
      && !out.some(q => q.kind === 'queue_add' && q.island === i.id && isHardpointKind(q.item))
      && this.guards.get(i.id)?.units.some(id => c.own.some(e => e.id === id && dist(e, i) <= c.econ.captureRadius))
      && !c.foes.some(e => isStatKind(e.kind) && c.statsOf(e).dmg > 0 && c.statsOf(e).targets.includes('sky')
        && dist(e, i) <= Math.max(c.econ.captureRadius + EMPLACE_THREAT, c.statsOf(e).range + c.econ.captureRadius + 2))
      && !weatherStormAt(c.obs.weather, i.x, i.y, this.size) && !warnedAt(c.obs.weather.seedWarnings, i, this.size));
    if (island) {
      out.push({ kind: 'queue_add', item: 'ore_extractor', island: island.id, ifAffordable: true });
      c.reserveCost(stats.alloy, stats.energy);
    }
  }

  /** One local Surface defence investment, independent of the island's main build slot. */
 mortars(c, out, held, screenReady) {
    const stats = c.stats.island_mortar;
    const targets = c.frame.order(c.foes.filter(e => e.plane === 'surface' && isStatKind(e.kind)));
    for (const mortar of c.own) {
      if (mortar.kind !== 'island_mortar' || mortar.state === 'constructing') continue;
      const target = targets.find(e => dist(e, mortar) <= stats.range);
      if (target) out.push({ kind: 'attack', units: [mortar.id], target: target.id });
    }
    if (!screenReady || this.tier.relays <= 0 || !c.segmentAlive('sky') || c.econ.islandHardpoints < 1
      || c.own.some(e => e.kind === 'island_mortar') || c.queued('island_mortar') > 0
      || c.obs.res.energyRate < c.obs.res.upkeep || c.ownQueued() >= this.tier.queueDepth
      || c.own.filter(e => isStructureKind(e.kind) && e.kind !== 'spire').length >= c.econ.structureCap
      || !c.affordableCost(stats.alloy, stats.energy + Math.max(c.stats.interceptor.energy, c.obs.res.upkeep * 10), this.tier.reserve.sky)) return;
    const island = held.find(i => i.state !== 'capturing' && i.state !== 'contested' && !(i.progress ?? 0)
      && i.id !== this.emplaceOn && !c.obs.islands.some(p => p.id === i.id && p.hardpoint !== undefined)
      && !c.obs.queue.some(q => q.island === i.id && isHardpointKind(q.item))
      && c.own.some(e => e.id === i.link && e.state !== 'constructing')
      && c.own.some(e => e.plane === 'sky' && !e.hangar && c.statsOf(e).capabilities.capture && dist(e, i) <= c.econ.captureRadius)
      && !c.foes.some(e => e.plane === 'sky' && isAircraft(e.kind) && dist(e, i) <= c.econ.captureRadius + EMPLACE_THREAT)
      && targets.some(e => dist(e, i) <= stats.range));
    if (island) {
      out.push({ kind: 'queue_add', item: 'island_mortar', island: island.id, ifAffordable: true });
      c.reserveCost(stats.alloy, stats.energy);
    }
  }

  /**
   * Gun Platforms (tier gunPlatforms; gunshipEmplaceEnabled with islandHardpoints): when visible hostile capture-capable
   * aircraft close on a held island carrying our structure or reserved construction, or it is being taken, and its
   * own hardpoint is empty, the nearest gunship holds the island and `emplace`s once it is capturing there (within
   * captureRadius). The platform stalls hostile captures while it lives. That gunship leaves `gunships` (no other
   * orders) until it emplaces or the island no longer qualifies.
   */
 emplace(c, out, held, gunships) {
    const on = c.econ.gunshipEmplaceEnabled && c.econ.islandHardpoints >= 1;
    const empty = (i) => !c.obs.islands.some((p) => p.id === i.id && p.hardpoint !== undefined)
      && !c.obs.queue.some(q => q.island === i.id && isHardpointKind(q.item));
    let island = on ? held.find((i) => i.id === this.emplaceOn && empty(i)) : undefined;
    let gun = island && gunships.find((e) => e.id === this.emplacer);
    if (!island || !gun) {
      this.emplacer = this.emplaceOn = '';
      let structures = 0, platforms = 0;
      for (const e of c.own) {
        if (isHardpointKind(e.kind)) platforms++;
        if (isStructureKind(e.kind) && e.kind !== 'spire') structures++;
      }
      if (!on || !gunships.length || platforms >= this.tier.gunPlatforms || structures >= c.econ.structureCap) return;
      const reach = c.econ.captureRadius + EMPLACE_THREAT;
      island = held.find((i) => empty(i) && (c.own.some((e) => e.id === i.link) || c.obs.queue.some(q => q.island === i.id))
        && (i.state === 'capturing' || i.state === 'contested'
          || c.foes.some((e) => e.plane === 'sky' && isAircraft(e.kind) && c.statsOf(e).capabilities.capture && dist(e, i) <= reach)));
      if (!island) return;
      // Frame order breaks distance ties: rotated seats pick rotated gunships.
      for (const e of c.frame.order(gunships)) if (!gun || dist(e, island) < dist(gun, island)) gun = e;
      this.emplacer = gun.id;
      this.emplaceOn = island.id;
    }
    gunships.splice(gunships.indexOf(gun), 1);
    // Capturing there = within captureRadius of the island (the sim keeps capture holders inside it).
    const there = gun.state === 'capturing' && gun.work !== undefined && dist(gun.work, island) < AT_POINT;
    if (there && island.state !== 'capturing') out.push({ kind: 'emplace', unit: gun.id, island: island.id });
    else if (!there) out.push({ kind: 'capture', units: [gun.id], island: island.id });
  }

  /**
   * Storm Seeders (seederEnabled): switch a ready, idle one on when affordable and useful: hostile aircraft over it
   * (they take full storm damage, ours only seededOwnDamage), or our Stormcatchers around it, outside the weather,
   * earning more over the storm than its cost and upkeep.
   */
 seed(c, out) {
    if (!c.econ.seederEnabled || c.econ.seederDuration <= 0) return;
    const tick = c.obs.tick;
    const reach = c.econ.seederRadius;
    const seconds = c.econ.seederDuration / TICK_RATE;
    let energy = c.obs.res.freeEnergy;
    for (const seeder of c.own) {
      if (seeder.kind !== 'storm_seeder' || seeder.state === 'constructing' || (seeder.ready ?? 0) > tick || (seeder.activeUntil ?? 0) > tick) continue;
      if (energy < c.econ.seederCost + SEED_SPARE_ENERGY) return;
      const intruders = c.foes.filter((e) => e.plane === 'sky' && isAircraft(e.kind) && dist(e, seeder) <= reach).length;
      const catchers = c.own.filter((e) => e.kind === 'stormcatcher' && e.state !== 'constructing' && dist(e, seeder) <= reach
        && !weatherStormAt(c.obs.weather, e.x, e.y, this.size)).length;
      if (intruders < SEED_RAIDERS && catchers * c.econ.stormcatcherRate * seconds <= c.econ.seederCost + c.econ.seederUpkeep * seconds) continue;
      out.push({ kind: 'seed', seeder: seeder.id });
      energy -= c.econ.seederCost;
    }
  }

  /** Moves own air out of storms it idles, holds or patrols in; returns each escapee's own-frame destination. */
 leaveStorms(c, f, air, islands, now, soon, out) {
    const escapes = new Map();
    if (!now.length && !soon.length) return escapes;
    const later = f.storms(LATER_LEADS * STORM_LEAD);
    const early = this.tier.skyWeather !== 'escape';
    for (const e of air) {
      if (!this.adrift(c, e, islands)) continue;
      const p = f.escape(f.at(e), now, soon, later, early);
      if (!p) continue;
      const w = f.order(p);
      out.push({ kind: 'move', units: [e.id], x: w.x, y: w.y });
      escapes.set(e.id, p);
    }
    return escapes;
  }

  /**
   * Idle, holding, station-keeping or patrolling, and not in a storm on purpose: bombing or shooting a structure,
   * defending our island against intruders, or a capture that destroys an enemy structure or is half done.
   */
 adrift(c, e, islands) {
    const reach = c.econ.captureRadius + ISLAND_GUARD_MARGIN;
    const work = e.work;
    switch (e.state) {
      case 'idle':
        return true;
      case 'moving':
        return !e.queue && e.wp?.length === 2;
      case 'capturing': {
        const island = work && islands.find((i) => dist(i, work) < AT_POINT);
        if (!island) return true;
        if (island.side === c.army) return !c.foes.some((o) => o.plane === 'sky' && dist(o, island) <= reach);
        return !(c.hostile(island.side) && island.link !== undefined) && (island.progress ?? 0) < CAPTURE_COMMITTED;
      }
      case 'attacking':
        return !work || !(c.foes.some((o) => c.statsOf(o).speed === 0 && dist(o, work) <= ON_TARGET)
          || islands.some((i) => i.side === c.army && dist(i, work) <= reach));
      default:
        return false;
    }
  }

  /**
   * Orders `units` to `to` (own frame) with `final`, through route waypoints on route tiers (or, `cover`, a covering
   * storm); units escaping a storm this decision queue it all behind their escape move.
   */
 send(c, f, units, to, escapes, out,
    final, cover = false) {
    for (const escaping of [false, true]) {
      const group = units.filter((e) => escapes.has(e.id) === escaping);
      if (!group.length) continue;
      const from = centroid(group.map((e) => escapes.get(e.id) ?? f.at(e)));
      const speed = Math.min(...group.map((e) => c.statsOf(e).speed));
      const stage = cover ? f.cover(from, to, speed) : undefined;
      const legs = stage ? [stage] : this.tier.skyWeather === 'escape' ? [] : f.route(from, to, speed);
      const list = ids(group);
      legs.forEach((p, i) => {
        const w = f.order(p);
        out.push({ kind: 'move', units: list, x: w.x, y: w.y, ...(escaping || i > 0 ? { queue: true } : {}) });
      });
      out.push(final(list, escaping || legs.length > 0));
    }
  }
}
