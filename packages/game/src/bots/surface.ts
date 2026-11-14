/** The Surface seat's built-in bot: army mix, turrets, Shafts and Headframes, squads sent down, and the home/centre/attack plan. */
import { DEPLOY_SPECS } from '../rules/deploy.ts';
import { footprintDistance, isStatKind } from '../rules/stats.ts';
import { isSurfaceHigh } from '../rules/terrain.ts';
import { isAircraft, isHardpointKind, isProducedUnit, isUnitKind, TICK_RATE } from '../rules/vocabulary.ts';
import type { Entity, Observation, ProducedUnit, UnitKind } from '../rules/contract.ts';
import type { AgentCommandIntent } from '../agent/intents.ts';
import { dist } from '../util/math.ts';
import { Ctx, centroid, ids, type Pt } from './context.ts';
import { PlaneBot } from './plane-bot.ts';
import { answerSurface, askCapture, askSurface, shaftWanted } from './signals.ts';
import { pointOrders, postCommitted, postOrders, type PointMember } from './posts.ts';
import {
  ABANDON_SHARE,
  AHEAD_ARMY,
  AHEAD_FLOOR,
  AHEAD_RATIO,
  AIR_THREAT,
  ARMY_PER_COLLECTOR,
  ARMY_MIN,
  AT_POINT,
  ATTACK_STANCE_DIVISOR,
  BASE_RADIUS,
  BREACH_ALARM,
  BREACHER_HUNT,
  BREACH_RESPONSE,
  CACHE_CLOSE,
  CACHE_SPOT_INSET,
  CHARGE_ALARM,
  COLLECTOR_HP,
  COLLECTORS_MAX,
  CONTEST_RADIUS,
  COUNTER_BASE,
  COUNTER_BONUS,
  CONVERT_KEEP_TROOPERS,
  CONVERT_MEMORY,
  DEPLOY_CALM,
  DIG_ALERT,
  DIG_ALERT_SHARP,
  DIRECTION_EPS,
  DOWN_MEMORY,
  DRILL_YARD_SPOT,
  DRILL_YARD_SPOT_RADIUS,
  ENEMY_VALUE_DECAY,
  ESCALATE_EVERY,
  ESCALATE_FLOOR,
  ESCALATE_STEP,
  FLAK_ALERT_MARGIN,
  FLAK_BASE,
  FLAK_DROP_RADIUS,
  FLAK_VS_AIR,
  FLANK_INSET,
  FRONT_OFFSET,
  GREED,
  HOLD_CENTRE_OFFSET,
  HOLD_MIN,
  HOLD_RADIUS,
  HOLD_SLACK_CENTRE,
  HOLD_SLACK_FRONT,
  HOME_RADIUS,
  HOME_SHAFT_OFFSET,
  HOME_SHAFT_RADIUS,
  LODE_RETRY,
  LODE_SITE_REACH,
  MID_SHAFT_OFFSET,
  MID_SHAFT_TRIES,
  MINER_GUARD_RADIUS,
  ORDER_EVERY,
  OUTMATCHED,
  POST_HEAL_SHARE,
  RAID_ODDS,
  RAID_REPEAT,
  RETREAT_SHARE,
  SCOUT_MEMORY,
  SIEGE_MIX,
  SIEGE_REACH_SLACK,
  SIEGE_REAR,
  SIEGE_SPOT_RADIUS,
  SIEGE_TANKS,
  SIEGE_THREAT_MARGIN,
  SIEGE_WAIT_MARGIN,
  SPARE_ALLOY,
  SPIRE_GUARD_RADIUS,
  SPIRE_GUARDS_MAX,
  SQUAD_MAX,
  SQUAD_MIN,
  SURFACE_CACHE_MARGIN,
  SURFACE_CACHE_REACH,
  TIE_SITE,
  TREMOR_ALARM,
  TREMOR_REPEAT,
  TREMOR_SQUAD,
  TURRET_SPOT_RADIUS,
  TURRET_SPOTS,
  TURRET_TRIES,
  TURRETS_FROM,
  UNDER_ATTACK_WINDOW,
  VANTAGE_RADIUS,
  VANTAGE_WIDE,
  ZONE_SWEEP,
  tieWins,
} from './tuning.ts';

type SurfacePlan = 'home' | 'center' | 'attack';
/** Trooper states a Breacher burns out first (digging in, dug in, climbing out: all still in the foxhole). */
const ENTRENCHED: ReadonlySet<string> = new Set(['digging_in', 'dug_in', 'digging_out']);

export class SurfaceBot extends PlaneBot {
  private plan: SurfacePlan = 'home';
  private orderAt = 0;
  private built = 0;
  /** mid Shaft: attempts so far and the cells tried (a rejected site is never retried) */
  private shaftTries = 0;
  private shaftTried = new Set<number>();
  private rallied = false;
  private sentDown = 0;
  /** next tick a trooper squad goes down to breach near the focus's base */
  private breachAt = 0;
  /** next tick a raid or guard squad may go down */
  private raidAt = 0;
  /** troopers sent down (id → tick): left alone on their way to the portal so army orders do not call them back */
  private goingDown = new Map<string, number>();
  /** decaying estimate of the hostile surface army value we see (alloy + energy, every hostile army) */
  private enemyValue = 0;
  /** lode outcrop cell → tick before which no Headframe is tried there again; scouts walking to a lode (id → tick) */
  private lodeTried = new Map<number, number>();
  private scouts = new Map<string, number>();
  private lodeScoutStep = 0;
  /** The current friendly-flank patrol gets three free fighters before new non-home post dispatches. */
  private lodePatrol = new Set<string>();
  private supportReserved = new Set<string>();
  /** the drop marker our flak guard waits under ('' = none) and the flak in that guard */
  private flakStation = '';
  private flakGuards = new Set<string>();
  /** dug-in Troopers or hostile turrets seen (the Drill Yard's reason), and troopers sent to convert (id → tick) */
  private entrenched = false;
  private converting = new Map<string, number>();
  /** own deployable units (id → last tick a deploy reason held), for the DEPLOY_CALM pack-up */
  private deployWanted = new Map<string, number>();
  /** contested point squads (trooper id → its point and resting spot) */
  private pointSquads = new Map<string, PointMember>();

  protected decide(c: Ctx): AgentCommandIntent[] {
    const out: AgentCommandIntent[] = [];
    const t = this.tier;
    const tick = c.obs.tick;
    const stance = c.obs.mandate.directive.stance;
    for (const [id, at] of this.goingDown) if (tick - at > DOWN_MEMORY) this.goingDown.delete(id);
    for (const [id, at] of this.scouts) if (tick - at > SCOUT_MEMORY) this.scouts.delete(id);
    const army = c.own.filter((e) => e.plane === 'surface' && (e.kind === 'trooper' || e.kind === 'tank' || e.kind === 'flak' || e.kind === 'breacher')
      && !this.goingDown.has(e.id) && !this.scouts.has(e.id) && !this.converting.has(e.id) && !this.desk.busy(e.id));
    const home = c.home;
    const enemyHome = c.foeAt;
    // A personality leans the front toward one flank of our frame (rallySkew; 0 on the diagonal).
    const front = c.frame.offset(home, FRONT_OFFSET + t.rallySkew, FRONT_OFFSET - t.rallySkew);
    const center = c.frame.toWorld(this.size / 2 - HOLD_CENTRE_OFFSET, this.size / 2 - HOLD_CENTRE_OFFSET);

    // New units gather at a forward rally point instead of crowding the Spire.
    if (!this.rallied && Number.isFinite(t.holdCenterAt)) {
      out.push({ kind: 'rally', x: front.x, y: front.y });
      this.rallied = true;
    }

    const value = (es: readonly Entity[]): number => es.reduce((a, e) => a + c.statsOf(e).alloy + c.statsOf(e).energy, 0);
    const enemyArmy = c.foes.filter((e) => e.plane === 'surface' && (e.kind === 'trooper' || e.kind === 'tank' || e.kind === 'flak' || e.kind === 'breacher'));
    this.enemyValue = Math.max(value(enemyArmy), this.enemyValue * ENEMY_VALUE_DECAY);
    // Telegraphed hostile impacts (public markers) near our structures: rocks flak can shoot down on their way in.
    const structures = c.own.filter((e) => e.plane === 'surface' && isStatKind(e.kind) && c.stats[e.kind].speed === 0);
    const drops = c.obs.impacts.filter((i) => c.hostile(i.side) && structures.some((s) => dist(s, i) <= FLAK_DROP_RADIUS));
    // Counter-mix (adaptive): cannons for armor, rifles for light infantry, flak for anything in the air (gunships and
    // Gun Platforms on hostile islands included: flak hits their heavy_air armour at ×1.25).
    let mix = t.mix;
    if (t.adaptive) {
      const tanks = enemyArmy.filter((e) => e.kind === 'tank' || e.kind === 'flak').length;
      const light = enemyArmy.filter((e) => e.kind === 'trooper').length;
      const air = c.foes.filter((e) => e.plane === 'sky' && (isAircraft(e.kind) || isHardpointKind(e.kind))).length + drops.length;
      mix = {
        trooper: COUNTER_BASE + (tanks > light ? 0 : COUNTER_BONUS),
        tank: COUNTER_BASE + (tanks >= light ? COUNTER_BONUS : 0),
        flak: air > AIR_THREAT ? FLAK_VS_AIR : FLAK_BASE,
      };
    }
    // A turret ring at their Spire: tanks out-range turrets (siege range), so the mix turns tank-heavy.
    const siege = this.siegeTarget(c);
    if (siege) mix = SIEGE_MIX;
    // Commit the desired mix to shared funding: waiting for a tank's full cost lets cheaper replacements starve it.
    // Under attack at home (our surface Spire segment hit in the last few seconds) a fighter is always queued, past the
    // lane depth and the funding test an optional buy needs (queued work ahead of it holds the free funds then), and
    // it moves first: without one there is nothing to rush, and the army never rebuilds while the Spire falls.
    const besieged = c.obs.events.some((ev) => ev.kind === 'spire_damaged' && ev.plane === 'surface' && ev.tick > tick - UNDER_ATTACK_WINDOW);
    const fighters = c.queued('trooper') + c.queued('tank') + c.queued('flak');
    // A due breach raid draws its squad from production (troopers, below, wait for it) rather than from whatever the
    // mix and the other trooper jobs leave over: a tank-heavy counter-mix and the Depths' troop requests otherwise left no
    // three troopers together to send.
    const breachDue = tick >= Math.max(t.breachFrom, this.breachAt) && c.segmentAlive('depths') && c.shafts().length > 0;
    if (c.segmentAlive('surface') && (c.ownQueued() < t.queueDepth || (besieged && fighters === 0)) && army.length + c.ownQueued() < t.armyCap) {
      let best: ProducedUnit = 'trooper';
      let bestNeed = -Infinity;
      const total = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
      // Exact ties go to the first kind in mix order, or to the personality's (tieOrder).
      let index = 0;
      for (const [k, w] of Object.entries(mix)) {
        if (!isProducedUnit(k) || w === undefined) continue;
        const have = army.filter((e) => e.kind === k).length + c.queued(k);
        const need = (w / total) * (army.length + 1) - have;
        if (need > bestNeed || (need === bestNeed && tieWins(t.tieOrder, TIE_SITE.mix, index))) {
          bestNeed = need;
          best = k;
        }
        index++;
      }
      if (breachDue && !besieged) best = 'trooper';
      this.produce(c, out, best, 'surface', undefined, besieged && fighters === 0);
    }
    if (besieged) this.rushDefence(c, out, ['trooper', 'tank', 'flak', 'turret']);

    // Turrets toward the centre (they also shoot air and hostile relays drifting overhead).
    const turrets = c.own.filter((e) => e.kind === 'turret').length + c.queued('turret');
    if (turrets < t.turrets && this.built < t.turrets * TURRET_TRIES && tick > TURRETS_FROM && c.affordable('turret', t.reserve.surface + SPARE_ALLOY)) {
      const base = c.frame.toCanon(home.x, home.y);
      const [dx, dy] = TURRET_SPOTS[this.built % TURRET_SPOTS.length]!;
      const want = c.frame.toWorld(base.x + dx, base.y + dy);
      const spot = c.buildSite('turret', want.x, want.y, TURRET_SPOT_RADIUS, out);
      if (spot) out.push({ kind: 'queue_add', item: 'turret', ...spot });
      this.built++;
    }
    this.drill(c, out, army, tick);

    // Own Shafts are the only way troopers go down (raids, breach squads, tremor hunts, the Depths' troops requests): one
    // beside home from homeShaftAt (sooner when the Depths ask for troopers), then one by the centre ore field for
    // shorter hauls once the army holds the centre (at the build radius edge nearest it).
    const shafts = c.own.filter((e) => e.kind === 'shaft').length + c.queued('shaft');
    const homeShaft = tick >= t.homeShaftAt || (Number.isFinite(t.homeShaftAt) && shaftWanted(this.desk));
    if (shafts === 0 && homeShaft && c.affordable('shaft', t.reserve.surface)) {
      const want = c.frame.offset(home, HOME_SHAFT_OFFSET, HOME_SHAFT_OFFSET);
      const spot = c.buildSite('shaft', want.x, want.y, HOME_SHAFT_RADIUS, out);
      if (spot) out.push({ kind: 'queue_add', item: 'shaft', ...spot });
    } else if (t.midShaft && this.plan !== 'home' && this.shaftTries < MID_SHAFT_TRIES && shafts < (Number.isFinite(t.homeShaftAt) ? 2 : 1) && c.affordable('shaft', t.reserve.surface)) {
      // The nearest buildable site to the centre ore field not tried before; a site that was rejected is not retried.
      const want = c.frame.toWorld(this.size / 2 - MID_SHAFT_OFFSET, this.size / 2 - MID_SHAFT_OFFSET);
      const spot = c.buildSite('shaft', want.x, want.y, Infinity, out, (cell) => !this.shaftTried.has(cell));
      if (spot) {
        const cell = spot.y * this.size + spot.x;
        this.shaftTried.add(cell);
        out.push({ kind: 'queue_add', item: 'shaft', ...spot });
      }
      this.shaftTries++;
    }

    // Keep the existing home-outcrop scout priority; post squads must not consume its only trooper.
    const homeLode = this.expandLodes(c, out, army, 'home');
    this.supportReserved.clear();
    for (const e of army) if (this.pointSquads.has(e.id) || this.lodePatrol.has(e.id) || postCommitted(c, e)) this.supportReserved.add(e.id);

    // Tremors under the base: send a squad down to hunt sappers (the depths seat commands them there).
    if (t.tremorResponse && tick >= this.sentDown && c.shafts().length && (c.tremorsNearHome(TREMOR_ALARM).length || c.chargesNearHome(CHARGE_ALARM).length)) {
      const squad = army.filter((e) => e.kind === 'trooper' && dist(e, home) < BASE_RADIUS).slice(0, TREMOR_SQUAD);
      if (squad.length) {
        this.sendDown(out, army, squad, tick);
        this.sentDown = tick + TREMOR_REPEAT;
      }
    }

    // Punish greed / guard the miners: a squad goes down to hunt a hostile economy seen (nearly) unguarded in the depths,
    // or to meet hostile fighters next to our diggers (the depths seat commands it there).
    if (t.raid && tick >= this.raidAt && c.segmentAlive('depths') && c.shafts().length) {
      const fighters = c.depthsFighters();
      const diggers = c.units('digger', 'depths');
      const greedy = fighters.length < RAID_ODDS && this.greed(c) >= GREED;
      const guard = fighters.some((f) => diggers.some((d) => dist(d, f) < MINER_GUARD_RADIUS));
      const squad = army
        .filter((e) => e.kind === 'trooper' && (guard || !this.supportReserved.has(e.id)))
        .sort((a, b) => dist(a, home) - dist(b, home))
        .slice(0, SQUAD_MAX);
      if ((greedy || guard) && squad.length >= SQUAD_MIN) {
        this.sendDown(out, army, squad, tick);
        this.raidAt = tick + RAID_REPEAT;
      }
    }

    // Breach raids: a squad of the troopers nearest home goes down (at our nearest Shaft); the depths seat
    // walks it under the focus's base and digs up there, also while the main army attacks (a second front).
    if (breachDue) {
      const squad = army
        .filter((e) => e.kind === 'trooper' && !this.supportReserved.has(e.id))
        .sort((a, b) => dist(a, home) - dist(b, home))
        .slice(0, SQUAD_MAX);
      if (squad.length >= SQUAD_MIN) {
        this.sendDown(out, army, squad, tick);
        this.breachAt = tick + t.breachEvery;
      } else if (!besieged) {
        // Short of a squad: the free troopers wait where they are for the rest (no other job takes them meanwhile).
        army.splice(0, army.length, ...army.filter((e) => !squad.includes(e)));
      }
    }

    // A routine staffing request must not restart a local job's journey. Explicit defence can still interrupt it.
    answerSurface(this.desk, c, out, army, Number.isFinite(t.homeShaftAt), this.supportReserved);
    // Deploy stances first: units kept deployed leave `army` (any move order would pack them); `force` still counts them.
    const force = [...army];
    // Existing post jobs and home acquisition stay first; fresh centre replacements must not consume every third
    // fighter forever. A quiet friendly-flank mission gets only its holding minimum before further post dispatches.
    this.lodePatrol.clear();
    const homePostsHeld = c.match.posts.filter((p) => p.home === c.army).every((p) =>
      c.posts.some((e) => e.id === p.id && e.side !== 'neutral' && !c.hostile(e.side)));
    const free = army.filter((e) => e.kind !== 'flak' && !this.pointSquads.has(e.id) &&
      e.hp >= e.maxHp * POST_HEAL_SHARE && !postCommitted(c, e));
    let secure = !homeLode && homePostsHeld ? this.expandLodes(c, out, free, 'patrol') : undefined;
    if (secure) {
      const at = { x: secure.x + 0.5, y: secure.y + 0.5 };
      for (const e of c.frame.order(free).sort((a, b) => dist(a, at) - dist(b, at)).slice(0, HOLD_MIN)) this.lodePatrol.add(e.id);
      army.splice(0, army.length, ...army.filter((e) => this.pointSquads.has(e.id) || !postCommitted(c, e)));
    }
    // Outmatched on our own side (hostile fighters nearer our Spire than theirs outvalue our whole force): detached
    // squads come back and the army stands at the Spire, whose beam, turrets and fresh fighters fight with it, instead
    // of meeting the push piecemeal at the points and the front. Not while our own attack is under way: its retreat
    // rule decides that.
    const invaders = enemyArmy.filter((e) => dist(e, home) < c.hostileSpireDist(e));
    const outmatched = this.plan !== 'attack' && invaders.length > 0 && value(invaders) > OUTMATCHED * value(force);
    pointOrders(c, t, army, out, this.pointSquads, outmatched || (t.suddenDeathPush && c.spireDamageFactor() > 1), this.lodePatrol);
    postOrders(c, t, this.plan !== 'home', army, out, this.lodePatrol);
    secure ??= homeLode ? undefined : this.expandLodes(c, out, army, 'rich');
    const held = this.deployAct(c, out, army, drops);
    if (held.size) army.splice(0, army.length, ...army.filter((e) => !held.has(e.id)));
    this.stationFlak(c, out, army, drops);
    this.mooring(c, out);
    if (tick < this.orderAt || army.length === 0) return out;
    // Enemy troopers digging up near home: meet them at the breach with everything close by.
    const breach = t.breachGuard ? c.obs.tremors.find((tr) => tr.breach && dist({ x: tr.x + 0.5, y: tr.y + 0.5 }, home) < BREACH_ALARM) : undefined;
    if (breach && this.plan !== 'attack') {
      const near = army.filter((e) => dist(e, home) < BREACH_RESPONSE);
      if (near.length) {
        out.push({ kind: 'move', units: ids(near), x: breach.x + 0.5, y: breach.y + 0.5, mode: 'fight' });
        this.orderAt = tick + ORDER_EVERY;
        return out;
      }
    }
    if (outmatched) {
      out.push({ kind: 'move', units: ids(army), x: home.x, y: home.y, mode: 'fight' });
      this.orderAt = tick + ORDER_EVERY;
      return out;
    }
    const threats = c.foes.filter((e) => e.plane === 'surface' && e.kind !== 'spire' && dist(e, home) < HOME_RADIUS);
    if (threats.length && this.plan !== 'attack') {
      const at = centroid(threats);
      out.push({ kind: 'move', units: ids(army), x: at.x, y: at.y, mode: 'fight' });
      this.orderAt = tick + ORDER_EVERY;
      return out;
    }
    // Race safe visible caches with a small detachment, never divert the whole army from its front.
    let collectors = 0;
    const collectorCap = Math.min(COLLECTORS_MAX, Math.floor(army.length / ARMY_PER_COLLECTOR));
    for (const cache of c.frame.order(c.obs.oreCaches)) {
      if (collectors >= collectorCap || cache.alloy <= 0
        || c.foes.some((e) => e.plane === 'surface' && dist(e, cache) < c.statsOf(e).range + cache.radius + SURFACE_CACHE_MARGIN)
        || c.obs.scorches.some((s) => s.until > tick && dist(s, cache) < s.radius + cache.radius)
        || c.obs.impacts.some((i) => dist(i, cache) < c.match.rules.orbit.largeImpactRadius + cache.radius)) continue;
      const hand = army.filter((e) => e.hp >= e.maxHp * COLLECTOR_HP && (e.kind === 'trooper' || e.kind === 'flak'))
        .sort((a, b) => dist(a, cache) - dist(b, cache))[0];
      if (!hand || dist(hand, cache) > SURFACE_CACHE_REACH) continue;
      const region = c.surfaceRegion(hand);
      const spot = c.spot(cache.x, cache.y, Math.max(CACHE_SPOT_INSET, cache.radius - CACHE_SPOT_INSET), (n) => region[n] === 1);
      if (!spot) continue;
      if (dist(hand, cache) > cache.radius * CACHE_CLOSE || (hand.state !== 'idle' && hand.state !== 'moving')) {
        out.push({ kind: 'move', units: [hand.id], x: spot.x, y: spot.y });
      }
      army.splice(army.indexOf(hand), 1);
      collectors++;
    }
    // Sudden death (countdown or under way): a pushing tier stops holding ground and goes for the Spire.
    const doom = t.suddenDeathPush && c.spireDamageFactor() > 1;
    if (secure && !doom && stance !== 'defend' && army.filter((e) => e.kind !== 'flak').length >= HOLD_MIN) {
      out.push({ kind: 'move', units: ids(army), x: secure.x + 0.5, y: secure.y + 0.5, mode: 'fight' });
      this.orderAt = tick + ORDER_EVERY;
      return out;
    }
    // Escalate over time: every ESCALATE_EVERY the bot settles for a smaller attack force (stalemates end).
    const urgency = Math.max(Math.ceil(t.attackAt / ESCALATE_FLOOR), t.attackAt - ESCALATE_STEP * Math.floor(tick / ESCALATE_EVERY));
    const attackAt = stance === 'attack' ? Math.ceil(urgency / ATTACK_STANCE_DIVISOR) : urgency;
    const holdAt = stance === 'defend' ? Infinity : t.holdCenterAt;
    let next: SurfacePlan = this.plan;
    const ahead = t.adaptive && force.length >= AHEAD_ARMY && value(force) >= AHEAD_RATIO * Math.max(this.enemyValue, AHEAD_FLOOR);
    if ((force.length >= attackAt || ahead || (doom && force.length >= ARMY_MIN)) && stance !== 'defend') next = 'attack';
    else if (this.plan === 'attack' && !doom && force.length < attackAt * RETREAT_SHARE) next = force.length >= holdAt ? 'center' : 'home';
    else if (this.plan === 'home' && force.length >= holdAt) next = 'center';
    else if (this.plan === 'center' && force.length < holdAt * ABANDON_SHARE) next = 'home';
    if (next !== this.plan) this.plan = next;
    askSurface(this.desk, c, this.plan === 'attack', siege);
    askCapture(this.desk, c);

    // Raiding a remembered rich-lode Headframe remains worthwhile after the army is large enough to push.
    const armyAt = centroid(army);
    const raid = t.raidLodes && this.plan !== 'home' ? [...this.headframesSeen.values()]
      .filter((p) => c.obs.lodes.some((l) => l.rich && dist(p, { x: l.x + 0.5, y: l.y + 0.5 }) < LODE_SITE_REACH))
      .sort((a, b) => dist(a, armyAt) - dist(b, armyAt))[0] : undefined;
    if (raid) out.push({ kind: 'move', units: ids(army), x: raid.x, y: raid.y, mode: 'fight' });
    else if (this.plan === 'attack' && siege) this.besiege(c, out, army, siege, force.filter((e) => e.kind === 'tank' && held.has(e.id)).length);
    else if (this.plan === 'attack') {
      const spire = c.foes.find((e) => e.kind === 'spire' && e.plane === 'surface' && e.side === c.focus.id);
      const guards = c.foes.filter((e) => e.plane === 'surface' && e.kind !== 'spire' && dist(e, centroid(army)) < SPIRE_GUARD_RADIUS);
      const gunners = army.filter((e) => e.kind !== 'flak'); // flak cannot hit ground targets
      if (spire && guards.length < SPIRE_GUARDS_MAX && gunners.length) out.push({ kind: 'attack', units: ids(gunners), target: spire.id });
      else out.push({ kind: 'move', units: ids(army), x: enemyHome.x, y: enemyHome.y, mode: 'fight' });
    } else {
      this.hold(c, out, army, this.plan === 'center' ? center : front, this.plan === 'center' ? HOLD_SLACK_CENTRE : HOLD_SLACK_FRONT);
    }
    this.burn(c, out, army);
    this.orderAt = tick + ORDER_EVERY;
    return out;
  }

  /** Home scouting stays first; a friendly-flank patrol may reserve fresh fighters, never existing post jobs. */
  private expandLodes(c: Ctx, out: AgentCommandIntent[], army: Entity[], scope: 'home' | 'patrol' | 'rich'): Pt | undefined {
    const t = this.tier;
    const tick = c.obs.tick;
    const stance = c.obs.mandate.directive.stance;
    const home = c.home;
    const rich = scope !== 'home';
    // Home outcrops need a scout; contested outcrops need ground fighters actually holding the site, not the centre.
    // Keep the army at a contested construction site until the shared queue finishes its Headframe.
    let secure: Pt | undefined = rich ? c.obs.lodes.find((l) => l.rich && c.obs.queue.some((q) =>
      q.item === 'headframe' && q.x !== undefined && q.y !== undefined && dist({ x: q.x, y: q.y }, { x: l.x + 0.5, y: l.y + 0.5 }) < LODE_SITE_REACH)) : undefined;
    const headframes = c.own.filter((e) => e.kind === 'headframe').length + c.queued('headframe');
    // Commit one due Headframe before cheaper shared-queue buys consume its funding; extra expansions need surplus.
    // A known quiet flank needs its local holding squad, not the force required to contest the centre.
    const contest = scope === 'rich' && army.length >= t.holdCenterAt;
    let holders = 0;
    for (const e of army) if (e.kind !== 'flak') holders++;
    const patrol = Number.isFinite(t.holdCenterAt) && holders >= HOLD_MIN &&
      !c.foes.some((e) => e.plane === 'surface' && e.kind !== 'spire' && dist(e, home) < HOME_RADIUS);
    if (scope === 'patrol') {
      if (!patrol || stance === 'defend') return;
      if (secure) {
        const at = { x: secure.x + 0.5, y: secure.y + 0.5 };
        if (dist(at, home) >= c.hostileSpireDist(at) ||
          c.foes.some((e) => e.plane === 'surface' && e.kind !== 'spire' && dist(e, at) < CONTEST_RADIUS)) return;
      }
    }
    const spare = c.affordable('headframe', t.reserve.surface);
    if (t.headframes > 0 && tick >= t.headframeAt && headframes < t.headframes && (c.queued('headframe') === 0 || spare)) {
      const key = (cell: number): number => c.frame.cellKey(cell);
      const sites = c.obs.lodes
        .map((l) => ({ l, cell: l.y * this.size + l.x, at: { x: l.x + 0.5, y: l.y + 0.5 } }))
        .filter(({ l, cell, at }) => {
          if (l.rich !== rich) return false;
          if (c.lodeTaken(l) || (this.lodeTried.get(cell) ?? -1) > tick) return false;
          if (!c.buildable('headframe', l.x - 1, l.y - 1, false, out)) return false;
          const ours = dist(at, home) < c.hostileSpireDist(at);
          const threatened = c.foes.some((e) => e.plane === 'surface' && e.kind !== 'spire' && dist(e, at) < CONTEST_RADIUS);
          if (l.rich) return stance !== 'defend' && (contest || (patrol && ours && !threatened));
          return ours && !threatened;
        })
        // A plateau outcrop is worth more: its Headframe and defenders get the high-ground range/vision and stay
        // hidden from low ground, so take those first within each tier (home before contested).
        .sort((a, b) => Number(a.l.rich) - Number(b.l.rich) || Number(isSurfaceHigh(c.ground[b.cell]!)) - Number(isSurfaceHigh(c.ground[a.cell]!))
          || dist(a.at, home) - dist(b.at, home) || key(a.cell) - key(b.cell));
      const site = sites[0];
      if (site) {
        secure ??= site.l;
        const visible = c.buildable('headframe', site.l.x - 1, site.l.y - 1, true, out);
        const held = !site.l.rich || (army.filter((e) => e.kind !== 'flak' && dist(e, site.at) < HOLD_RADIUS).length >= HOLD_MIN &&
          !c.foes.some((e) => e.plane === 'surface' && e.kind !== 'spire' && dist(e, site.at) < CONTEST_RADIUS));
        if (held && visible) {
          // Funding a held contested site releases its committed defenders before optional queued purchases.
          const frame: AgentCommandIntent = { kind: 'queue_add', item: 'headframe', x: site.l.x, y: site.l.y };
          if (site.l.rich) frame.index = 0;
          out.push(frame);
          this.lodeTried.set(site.cell, tick + LODE_RETRY);
        } else if (!site.l.rich && this.scouts.size === 0) {
          const scout = army.filter((e) => e.kind === 'trooper').sort((a, b) => dist(a, site.at) - dist(b, site.at))[0];
          if (scout) {
            out.push({ kind: 'move', units: [scout.id], ...site.at, mode: 'move' });
            this.scouts.set(scout.id, tick);
            army.splice(army.indexOf(scout), 1);
          }
        }
      }
      // Outcrops are discovered, not public. Search the recipe's expected zones with the army; only an observed
      // lode can become a build site. Sweep the anchor and its rim rather than assuming a lode sits at the anchor.
      if (rich && !site && !secure && stance !== 'defend' && (contest || patrol) &&
        !c.obs.lodes.some((l) => l.rich && [...this.headframesSeen.values()].some((p) => dist(p, { x: l.x + 0.5, y: l.y + 0.5 }) < LODE_SITE_REACH))) {
        const zones = c.match.rules.map.contestedZones.filter((z) => z.sets > 0);
        // Every zone set holds one contested lode per map slot.
        const slots = c.match.symmetry === 'C4' ? 4 : 2;
        if (c.obs.lodes.filter((l) => l.rich).length < zones.reduce((n, z) => n + slots * z.sets, 0)) {
          // Small patrols search only quiet friendly-side flank cells, never the centre or hostile sector.
          const points = zones.filter((z) => contest || z.kind === 'flanks').flatMap((z) => {
            // Our sector's flank anchors: C2 the two Spire-free corners, C4 the two edge midpoints beside our corner.
            const anchors = z.kind === 'centre' ? [{ x: this.size / 2, y: this.size / 2 }] : slots === 2
              ? [{ x: this.size * (FLANK_INSET - 1) / FLANK_INSET, y: this.size / FLANK_INSET }, { x: this.size / FLANK_INSET, y: this.size * (FLANK_INSET - 1) / FLANK_INSET }]
              : [{ x: this.size / 2, y: this.size / FLANK_INSET }, { x: this.size / FLANK_INSET, y: this.size / 2 }];
            const r = z.maxRadius * ZONE_SWEEP;
            // These are cell anchors, not world points: build the entire search in the canonical frame,
            // then turn cells so both the rim order and the later +0.5 centres stay symmetric.
            return anchors.flatMap((p) => [[0, 0], [r, 0], [0, r], [-r, 0], [0, -r]].map(([dx, dy]) => {
              const cell = c.frame.cellAt(Math.max(1, Math.min(this.size - 2, Math.floor(p.x + dx!))), Math.max(1, Math.min(this.size - 2, Math.floor(p.y + dy!))));
              return { x: cell % this.size, y: Math.floor(cell / this.size) };
            }));
          }).filter((p) => {
            if (contest) return true;
            const at = { x: p.x + 0.5, y: p.y + 0.5 };
            return c.walkable(p.y * this.size + p.x) && dist(at, home) < c.hostileSpireDist(at) &&
              !c.foes.some((e) => e.plane === 'surface' && e.kind !== 'spire' && dist(e, at) < CONTEST_RADIUS);
          });
          secure = points[this.lodeScoutStep % points.length];
          // Measured to the cell centre the army is sent to: a cell corner is not rotation-symmetric (a rotated twin's
          // corner sits one tile off), so rotated armies would advance the sweep at different moments.
          if (secure && army.filter((e) => e.kind !== 'flak' && dist(e, { x: secure!.x + 0.5, y: secure!.y + 0.5 }) < HOLD_RADIUS).length >= HOLD_MIN) {
            secure = points[++this.lodeScoutStep % points.length];
          }
        }
      }
    }
    return secure;
  }

  /** Deliberately invest in one useful home-side hold, only with sustained surplus and a 30-second reserve. */
  private mooring(c: Ctx, out: AgentCommandIntent[]): void {
    const rule = c.match.rules.surface;
    if (!rule.mooringEnabled || c.obs.res.energyRate - c.obs.res.upkeep <= rule.mooringUpkeep
      || c.obs.res.freeEnergy < rule.mooringUpkeep * 30) return;
    const towers = c.own.filter((e) => e.kind === 'mooring_tower');
    const tower = towers.find((e) => e.state !== 'constructing' && !e.mooringTarget && e.mooringGrace === undefined && e.mooringPowered !== false);
    if (!tower && (towers.length || c.queued('mooring_tower'))) return;
    let pick: Entity | undefined;
    for (const island of c.own) {
      if (island.kind !== 'island' || island.mooringState || (island.mooringReadyAt ?? 0) > c.obs.tick
        || towers.some((e) => e.mooringTarget === island.id)) continue;
      const structure = c.own.find((e) => e.id === island.link);
      if (!structure || structure.state === 'constructing'
        || (structure.kind !== 'relay' && structure.kind !== 'aerie' && structure.kind !== 'stormcatcher')
        || dist(island, c.home) >= c.hostileSpireDist(island)
        || (tower && dist(tower, island) > rule.mooringRange)) continue;
      if (!pick || dist(island, c.home) < dist(pick, c.home)) pick = island;
    }
    if (!pick) return;
    if (tower) {
      out.push({ kind: 'moor', tower: tower.id, island: pick.id });
      return;
    }
    const cost = c.stats.mooring_tower;
    if (!c.affordableCost(cost.alloy, cost.energy + rule.mooringUpkeep * 30, this.tier.reserve.surface + SPARE_ALLOY)) return;
    const site = c.buildSite('mooring_tower', pick.x, pick.y, rule.mooringRange, out);
    if (site) out.push({ kind: 'queue_add', item: 'mooring_tower', ...site, ifAffordable: true });
  }

  /**
   * Drill Yard: once dug-in Troopers or a turret line have been seen (or the army holds the tier's drillYardAt troopers),
   * one yard goes up behind the turret spots; then the troopers nearest it are converted, one per decision, until the
   * tier's Breachers stand, never below CONVERT_KEEP_TROOPERS troopers. A converting trooper leaves `army` meanwhile.
   */
  private drill(c: Ctx, out: AgentCommandIntent[], army: Entity[], tick: number): void {
    const t = this.tier;
    for (const [id, at] of this.converting) if (tick - at > CONVERT_MEMORY || !c.own.some((e) => e.id === id)) this.converting.delete(id);
    if (t.breachers <= 0 || !c.econ.breachersEnabled || !c.segmentAlive('surface')) return;
    this.entrenched ||= this.turretsSeen.size > 0 || c.foes.some((e) => e.kind === 'trooper' && ENTRENCHED.has(e.state));
    const troopers = army.filter((e) => e.kind === 'trooper');
    const yard = c.own.find((e) => e.kind === 'drill_yard');
    if (!yard) {
      if (c.queued('drill_yard') || (!this.entrenched && troopers.length < t.drillYardAt) || !c.affordable('drill_yard', t.reserve.surface + SPARE_ALLOY)) return;
      const base = c.frame.toCanon(c.home.x, c.home.y);
      const want = c.frame.toWorld(base.x + DRILL_YARD_SPOT[0], base.y + DRILL_YARD_SPOT[1]);
      const spot = c.buildSite('drill_yard', want.x, want.y, DRILL_YARD_SPOT_RADIUS, out);
      if (spot) out.push({ kind: 'queue_add', item: 'drill_yard', ...spot });
      return;
    }
    if (yard.state === 'constructing' || troopers.length <= CONVERT_KEEP_TROOPERS) return;
    const s = c.stats.breacher;
    if (c.own.filter((e) => e.kind === 'breacher').length + this.converting.size >= t.breachers || !c.affordableCost(s.alloy, s.energy, t.reserve.surface)) return;
    // Nearest the yard; equal distances resolve in our frame's cell order, alike for every army.
    const key = (e: Entity): number => c.frame.cellKey(Math.floor(e.y) * this.size + Math.floor(e.x));
    let pick = troopers[0]!;
    for (const e of troopers) if (dist(e, yard) < dist(pick, yard) || (dist(e, yard) === dist(pick, yard) && key(e) < key(pick))) pick = e;
    out.push({ kind: 'convert', units: [pick.id], to: 'breacher', yard: yard.id });
    this.converting.set(pick.id, tick);
    army.splice(army.indexOf(pick), 1);
  }

  /** Breachers go for the nearest dug-in Trooper or turret within BREACHER_HUNT of them (their counter), over the army plan. */
  private burn(c: Ctx, out: AgentCommandIntent[], army: Entity[]): void {
    const breachers = army.filter((e) => e.kind === 'breacher');
    if (!breachers.length) return;
    const at = centroid(breachers);
    const key = (e: Entity): number => c.frame.cellKey(Math.floor(e.y) * this.size + Math.floor(e.x));
    let target: Entity | undefined;
    for (const e of c.foes) {
      if (e.plane !== 'surface' || !(e.kind === 'turret' || (e.kind === 'trooper' && ENTRENCHED.has(e.state))) || dist(e, at) > BREACHER_HUNT) continue;
      if (!target || dist(e, at) < dist(target, at) || (dist(e, at) === dist(target, at) && key(e) < key(target))) target = e;
    }
    if (target) out.push({ kind: 'attack', units: ids(breachers), target: target.id });
  }

  /** Transfer `squad` to the Depths and take it out of `army` (and out of army orders until it is down). */
  private sendDown(out: AgentCommandIntent[], army: Entity[], squad: Entity[], tick: number): void {
    out.push({ kind: 'transfer', units: ids(squad), to: 'depths' });
    for (const e of squad) this.goingDown.set(e.id, tick);
    army.splice(0, army.length, ...army.filter((e) => !squad.includes(e)));
  }

  /**
   * Idle flak that can get in range before the rock lands waits under the soonest hostile drop on our Spire or a
   * Headframe (the rock falls onto its public marker) and leaves `army` while the marker stands; a new marker
   * re-sends the guard.
   */
  private stationFlak(c: Ctx, out: AgentCommandIntent[], army: Entity[], drops: Observation['impacts']): void {
    const frames = c.own.filter((e) => e.kind === 'headframe');
    let marker: Observation['impacts'][number] | undefined;
    // Frame order: equally soon mirrored markers resolve alike for every army.
    for (const i of c.frame.order(drops)) {
      if (marker && i.tick >= marker.tick) continue;
      if (dist(i, c.home) <= FLAK_DROP_RADIUS || frames.some((f) => dist(f, i) <= FLAK_DROP_RADIUS)) marker = i;
    }
    if (!marker) {
      this.flakStation = '';
      this.flakGuards.clear();
      return;
    }
    const fresh = marker.id !== this.flakStation;
    this.flakStation = marker.id;
    const flak = c.stats.flak;
    const reach = flak.speed * (marker.tick - c.obs.tick) / TICK_RATE + flak.range;
    const guards = army.filter((e) => e.kind === 'flak' && (this.flakGuards.has(e.id) || (e.state === 'idle' && dist(e, marker) <= reach)));
    const send = fresh ? guards : guards.filter((e) => !this.flakGuards.has(e.id));
    if (send.length) out.push({ kind: 'move', units: ids(send), x: marker.x, y: marker.y, mode: 'fight' });
    this.flakGuards.clear();
    for (const e of guards) {
      this.flakGuards.add(e.id);
      army.splice(army.indexOf(e), 1);
    }
  }

  /**
   * Deploy stances (Tier.deploy; each only while its match rule is on). Tanks siege on a visible hostile structure in
   * siege reach ('sharp', while holding, also on a ground foe in reach), never with a ground foe inside their blind
   * spot. Idle holding troopers dig in against a ground foe within DIG_ALERT ('sharp': DIG_ALERT_SHARP) and climb
   * out when the army attacks. Flak at home emplaces under a hostile drop or aircraft. Tanks and flak pack after
   * DEPLOY_CALM without a reason (tanks at once with a foe in the blind spot). Returns the units to keep deployed.
   */
  private deployAct(c: Ctx, out: AgentCommandIntent[], army: readonly Entity[], drops: Observation['impacts']): Set<string> {
    const held = new Set<string>();
    const mode = this.tier.deploy;
    if (mode === 'none') return held;
    const tick = c.obs.tick;
    const econ = c.econ;
    const holding = this.plan !== 'attack';
    const ground = c.foes.filter((f) => f.plane === 'surface' && isStatKind(f.kind) && c.stats[f.kind].speed > 0);
    const buildings = c.foes.filter((f) => f.plane === 'surface' && isStatKind(f.kind) && c.stats[f.kind].footprint !== undefined);
    const air = c.foes.filter((f) => f.plane === 'sky' && isStatKind(f.kind) && c.stats[f.kind].dmg > 0);
    const homes = c.own.filter((e) => e.plane === 'surface' && (e.kind === 'spire' || e.kind === 'headframe'));
    const near = (u: Entity, fs: readonly Entity[], r: number): boolean => fs.some((f) => dist(f, u) - c.statsOf(f).radius <= r);
    const on: string[] = [];
    const off: string[] = [];
    for (const u of army) {
      const stance = c.statsOf(u).deploy;
      const flag = stance && DEPLOY_SPECS[stance].enabled;
      if (!stance || (flag && !econ[flag])) continue;
      const states = DEPLOY_SPECS[stance].states;
      const deployed = u.state === states[0] || u.state === states[1];
      let want = false;
      let blind = false;
      if (stance === 'siege') {
        // Spire segments only within siegeSpireRange (footprint edge to our body edge, as the beam measures).
        const radius = c.statsOf(u).radius;
        blind = near(u, ground, econ.siegeMinRange + SIEGE_THREAT_MARGIN);
        want = !blind && (buildings.some((b) => footprintDistance(b.kind, b.x, b.y, u.x, u.y) <= (b.kind === 'spire' ? econ.siegeSpireRange + radius : econ.siegeRangeStructures) - SIEGE_REACH_SLACK)
          || (mode === 'sharp' && holding && near(u, ground, econ.siegeRangeUnits - SIEGE_REACH_SLACK)));
      } else if (stance === 'dug_in') {
        // Troopers climb out at once when the army attacks; holding, after DEPLOY_CALM without a foe near.
        blind = !holding;
        want = holding && near(u, ground, mode === 'sharp' ? DIG_ALERT_SHARP : DIG_ALERT);
      } else if (stance === 'emplaced') {
        want = homes.some((h) => dist(h, u) <= FLAK_DROP_RADIUS) && (drops.some((d) => dist(d, u) <= econ.emplacedFlakRange + econ.flakPayloadRange)
          || near(u, air, econ.emplacedFlakRange + FLAK_ALERT_MARGIN));
      }
      if (want) this.deployWanted.set(u.id, tick);
      if (deployed) {
        if (blind || tick - (this.deployWanted.get(u.id) ?? 0) >= DEPLOY_CALM) off.push(u.id);
        else held.add(u.id);
      } else if (want && (u.state === 'idle' || (stance === 'siege' && (u.state === 'attacking' || u.state === 'moving')))) {
        on.push(u.id);
        held.add(u.id);
      }
    }
    for (const id of this.deployWanted.keys()) if (!army.some((e) => e.id === id)) this.deployWanted.delete(id);
    if (on.length) out.push({ kind: 'deploy', units: on, on: true });
    if (off.length) out.push({ kind: 'deploy', units: off, on: false });
    return held;
  }

  /**
   * Siege a turret ring instead of walking into it: with SIEGE_TANKS tanks (`sieged` of them already deployed and out
   * of `army`), they stand off at mobile siege range from the outer turret (tanks out-range turrets; they see 9 tiles)
   * and shell it, setting up siege once it is in siege reach (deployAct); the rest of the army SIEGE_REAR tiles behind
   * them on our side. With fewer tanks the army waits beyond turret range for more.
   */
  private besiege(c: Ctx, out: AgentCommandIntent[], army: Entity[], target: { id: string; x: number; y: number }, sieged: number): void {
    const home = c.home;
    const d = Math.max(DIRECTION_EPS, dist(target, home));
    const ux = (home.x - target.x) / d;
    const uy = (home.y - target.y) / d;
    const at = (r: number): Pt => c.spot(target.x + ux * r, target.y + uy * r, SIEGE_SPOT_RADIUS) ?? { x: target.x + ux * r, y: target.y + uy * r };
    const tanks = army.filter((e) => e.kind === 'tank');
    const rest = army.filter((e) => e.kind !== 'tank');
    if (tanks.length + sieged < SIEGE_TANKS) {
      out.push({ kind: 'move', units: ids(army), ...at(c.stats.turret.range + SIEGE_WAIT_MARGIN), mode: 'fight' });
      return;
    }
    const visible = c.foes.some((e) => e.id === target.id);
    if (tanks.length && visible) out.push({ kind: 'attack', units: ids(tanks), target: target.id });
    else if (tanks.length) out.push({ kind: 'move', units: ids(tanks), ...at(c.stats.tank.range + c.econ.siegeRange), mode: 'fight' });
    if (rest.length) out.push({ kind: 'move', units: ids(rest), ...at(c.stats.tank.range + c.econ.siegeRange + SIEGE_REAR), mode: 'fight' });
  }

  /**
   * Hold ground around `at`, one vantage cell per unit. Expand a sparse hold area before falling back to plain
   * ground: the nominal front can have no hills or woods within VANTAGE_RADIUS, with a ridge just beyond that radius.
   * Units left over gather within `slack` tiles of the point.
   */
  private hold(c: Ctx, out: AgentCommandIntent[], army: Entity[], at: Pt, slack: number): void {
    const free = [...army];
    let posts = c.vantage(at.x, at.y, VANTAGE_RADIUS, army.length);
    if (posts.length < army.length) posts = c.vantage(at.x, at.y, VANTAGE_WIDE, army.length);
    for (const p of posts) {
      let best = 0;
      for (let i = 1; i < free.length; i++) if (dist(free[i]!, p) < dist(free[best]!, p)) best = i;
      const [e] = free.splice(best, 1);
      if (dist(e!, p) > AT_POINT) out.push({ kind: 'move', units: [e!.id], x: p.x, y: p.y, mode: 'fight' });
    }
    const away = free.filter((e) => dist(e, at) > slack);
    if (away.length) out.push({ kind: 'move', units: ids(away), x: at.x, y: at.y, mode: 'fight' });
  }
}
