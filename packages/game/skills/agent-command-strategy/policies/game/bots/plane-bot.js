// Agent Command's built-in bot library: packages/game/src/bots/plane-bot.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * The plane-bot base every seat's built-in bot extends: decision cadence, the army's focus, enemy memory, queue
 * housekeeping, production, research and Orbit fleet combat.
 */
import { fullObservation } from '../rules/observation-core.js';
import { DAMAGE_VS, footprint, footprintDistance, isStatKind } from '../rules/stats.js';
import { sunOffset } from '../rules/sun.js';
import { isSurfaceHigh, unpackTerrain } from '../rules/terrain.js';
import { isUpgrade } from '../rules/upgrades.js';
import { INTENTS_PER_CALL, isAircraft, isUnitKind } from '../rules/vocabulary.js';
import { dmath } from '../util/fdlibm.js';
import { cellCentreX, cellCentreY } from '../util/grid.js';
import { dist, norm } from '../util/math.js';
import { rotVX, rotVY } from '../util/teams.js';
import { Ctx, Frame, centroid, chooseFocus, gridDist2, groundWalk, ids, offMap, rememberSpires, ruleTables, snap, } from './context.js';
import { SignalDesk } from './signals.js';
import {
  ARMY_FIRST_OPENING,
  AT_POINT,
  BASE_RADIUS,
  CHARGE_CLEAR,
  CROWN_SIEGE_PUSH,
  DEFENCE_REORDER,
  DEPTHS_LOOK_REACH,
  DIGGER_CHECK_REACH,
  DIGGER_MEMORY,
  GIVE_UP,
  ORBIT_SIEGE_MARGIN,
  ORBIT_TRADE_MARGIN,
  OUTMATCHED,
  RESEARCH_MINIMUM_DEFAULT,
  RUIN_CLEARANCE,
  SIEGE_TURRETS,
  SQUAD_MIN,
  UNDER_ATTACK_WINDOW,
  VISION_MARGIN,
} from './tuning.js';

/** The Surface army's fighters: what tier.armyFirst counts. */
const SURFACE_FIGHTERS = new Set(['trooper', 'tank', 'flak', 'breacher']);

/** What army first lets through: the Surface army's fighters and turrets, and a Spire rebuild. */
function armyItem(item) {
  return SURFACE_FIGHTERS.has(item) || item === 'turret' || item === 'rebuild';
}

/** Unpacked static terrain per packed matchData.terrain array. */
const GROUNDS = new WeakMap();

/**
 * What every seat derives from matchData alone, computed once per match: the unpacked terrain (returned) and its
 * walkable cells, the compiled rules and every army frame's cell order. botPolicy runs it in the policy's init, whose
 * budget is the load's, so a fresh instance's first think does not carry it.
 */
export function prepareMatch(data) {
  const size = data.rules.map.size;
  let ground = GROUNDS.get(data.terrain);
  if (!ground || ground.length !== size * size) GROUNDS.set(data.terrain, (ground = unpackTerrain(data.terrain, size)));
  groundWalk(ground);
  ruleTables(data.rules);
  for (const a of data.armies) new Frame(a.frame, size).cells();
  return ground;
}

export class PlaneBot {
 size;
 tier;
 army;
 nextAt = 0;
  /** tick of the last think call (-1: none yet): the call cadence tier.prepareAhead plans by */
 lastCall = -1;
 match;
  /** static per match: unpacked during initialization */
 ground = null;
  /** hostile Spire segments seen so far, and the focus, kept until it is eliminated (DESIGN §15.10) */
 spiresSeen = new Map();
 focus;
  /** team signals this seat answers and asks (bots/signals.ts) */
 desk;

  constructor(army, tier) {
    this.army = army;
    this.tier = tier;
    this.desk = new SignalDesk(tier.signals, tier.period);
  }

  init(data) {
    this.match = data;
    this.size = data.rules.map.size;
    this.ground = prepareMatch(data);
  }

  think(obs) {
    if (!this.match || !this.ground) throw new Error('Bot requires match data initialization before think');
    if (this.match.rulesHash !== obs.rulesHash) throw new Error('Bot match data rules hash does not match its observation');
    if (obs.outcome !== 'running') return [];
    const gap = this.lastCall >= 0 ? obs.tick - this.lastCall : 0;
    // tier.prepareAhead: the very first call only prepares, so the first decision (every one-off plan) is not its own heaviest.
    if (this.tier.prepareAhead && this.lastCall < 0) this.nextAt = Math.max(this.nextAt, obs.tick + 1);
    this.lastCall = obs.tick;
    if (obs.tick < this.nextAt) {
      // tier.prepareAhead: the call before a decision does its groundwork, so no one call carries both.
      if (this.tier.prepareAhead && (gap === 0 || this.nextAt - obs.tick <= gap)) this.ahead(new Ctx(fullObservation(obs), this.match, this.ground));
      return [];
    }
    this.nextAt = obs.tick + this.tier.period;
    // Built-in bots are game code: the host serves them every plane in full.
    const c = new Ctx(fullObservation(obs), this.match, this.ground);
    rememberSpires(c, this.spiresSeen);
    // Every seat of the army runs this on the same decision ticks from the same observation, so they agree.
    let focus = c.hostiles.find((a) => a.id === this.focus);
    if (!focus) {
      focus = chooseFocus(c, this.spiresSeen, this.tier.leaderPenalty);
      this.focus = focus?.id;
    }
    if (!focus) return [];
    c.focusOn(focus, this.spiresSeen);
    this.remember(c, 'turret', this.turretsSeen);
    this.remember(c, 'headframe', this.headframesSeen);
    this.remember(c, 'shaft', this.shaftsSeen);
    this.remember(c, 'bulkhead', this.bulkheadsSeen);
    // Enemy diggers: remembered for DIGGER_MEMORY, forgotten early once one of ours stands where it was and sees nothing.
    for (const e of c.foes) if (e.plane === 'depths' && e.kind === 'digger') this.diggersSeen.set(e.id, { x: e.x, y: e.y, tick: obs.tick });
    const below = c.own.filter((e) => e.plane === 'depths');
    for (const [id, d] of this.diggersSeen) {
      if (obs.tick - d.tick > DIGGER_MEMORY || (d.tick < obs.tick && below.some((e) => dist(e, d) < DIGGER_CHECK_REACH))) this.diggersSeen.delete(id);
    }
    this.desk.begin(c);
    // Crowns: our own segment threatened (alert segment_threatened) asks the whole team to defend it.
    if (c.match.rules.spire.lossRule === 'crowns' && obs.alerts.some((a) => a.plane === obs.role && a.kind === 'segment_threatened')) {
      this.desk.ask(c, 'defend', 'team', c.home, undefined, obs.role);
    }
    this.surfaceHit = c.obs.events.some((ev) => ev.kind === 'spire_damaged' && ev.plane === 'surface' && ev.tick > obs.tick - UNDER_ATTACK_WINDOW);
    this.holdBack = this.armyFirst(c);
    this.frameDue = c.obs.queue.some((e) => e.item === 'headframe' && e.site === undefined && !e.paid && e.status !== 'blocked');
    const out = [...this.tidyQueue(c), ...this.rebuild(c), ...this.decide(c), ...this.desk.flush()];
    if (obs.role === 'surface') {
      this.stepClear(c, out);
      this.routeSurface(c, out);
    }
    // What the host keeps of a package's answer, so in-process and packaged bots apply the same intents.
    if (out.length > INTENTS_PER_CALL) out.length = INTENTS_PER_CALL;
    let frame = c.queued('headframe') > 0;
    for (const intent of out) {
      if (intent.kind !== 'queue_add' || isUnitKind(intent.item) || isUpgrade(intent.item) || intent.item === 'rebuild') continue;
      // A first Headframe is a durable commitment (it saves up), army first included: the economy it opens is what
      // outlasts the other army to the cap; bought only from a full bank, it came minutes late or never.
      if (intent.item === 'headframe') { if (frame) intent.ifAffordable = true; frame = true; }
      else intent.ifAffordable = true;
    }
    return out;
  }


  /** This decision: the Surface Spire segment was hit within UNDER_ATTACK_WINDOW. */
 surfaceHit = false;
  /** This decision: the army comes first (armyFirst). */
 holdBack = false;
  /**
   * This decision: a Headframe waits in the shared queue for funds. Every seat's buys outside the Surface army are
   * optional meanwhile, as under army first: each lane head takes an equal share of income (sim allocateQueue), so
   * with every lane committing its next unit the Headframe saved on a quarter of a 2 alloy/s Spire income and came
   * minutes late, while its trickle and the lode pocket it opens are what lift that income.
   */
 frameDue = false;
  /**
   * The opening's army stood once, or ARMY_FIRST_OPENING passed (armyFirst): from then on only an attack or a stronger
   * hostile army in sight holds back.
   */
 fielded = false;

  /**
   * Army first (tier.armyFirst): in the opening until tier.armyFirst Surface fighters stand at once, or until
   * ARMY_FIRST_OPENING at the latest; whenever the Surface Spire segment is under attack; and whenever the hostile
   * Surface fighters in sight outvalue our whole Surface force (OUTMATCHED). Every seat decides on the same ticks from
   * the same observation, so all agree. Meanwhile no seat buys research, and nothing but the Surface army (armyItem) and
   * a first Headframe is committed before the free bank covers it at once: an unpaid entry at the head of its lane takes
   * an equal share of all income (sim allocateQueue), which left the Surface lane a quarter of it while an early rush
   * walked in. Bombers, gunships and Orbit warships waiting for funds starved it the same way as research did. Only the
   * opening waits for a count, and only so long: an army that keeps trading with a rush, or one lost later with no
   * hostile army in sight, would otherwise starve every other plane for the rest of the match.
   */
 armyFirst(c) {
    const want = this.tier.armyFirst;
    if (want <= 0) return false;
    if (this.surfaceHit) return true;
    let count = 0, force = 0, seen = 0;
    for (const e of c.own) {
      if (e.plane !== 'surface' || e.hp <= 0 || !SURFACE_FIGHTERS.has(e.kind)) continue;
      count++;
      force += c.statsOf(e).alloy + c.statsOf(e).energy;
    }
    for (const e of c.foes) if (e.plane === 'surface' && SURFACE_FIGHTERS.has(e.kind)) seen += c.statsOf(e).alloy + c.statsOf(e).energy;
    if (seen > OUTMATCHED * force) return true;
    this.fielded ||= count >= want || c.obs.tick >= ARMY_FIRST_OPENING;
    return !this.fielded;
  }

  /** Groundwork for the next decision on the call before it (tier.prepareAhead); `c` has no focus yet. */
 ahead(_c) {}

  /**
   * Known hostile charges about to hole the ground under our Surface units (alert charge_under): every unit within the
   * alert's reach (collapseRadius + collapseStructureReach of the charge) steps straight away from it to CHARGE_CLEAR
   * past that reach (homeward when it stands on the charge cell). These moves lead the decision and their units leave
   * every later intent, so nothing this decision walks them back in before the blast.
   */
 stepClear(c, out) {
    const reach = c.econ.collapseRadius + c.econ.collapseStructureReach;
    const moves = [];
    const cleared = new Set();
    for (const a of c.obs.alerts) {
      if (a.plane !== 'surface' || a.kind !== 'charge_under' || a.x === undefined || a.y === undefined) continue;
      const at = { x: a.x, y: a.y };
      for (const e of c.own) {
        if (e.plane !== 'surface' || e.transit || cleared.has(e.id) || !isUnitKind(e.kind) || c.statsOf(e).speed === 0) continue;
        const d = dist(e, at);
        if (d > reach) continue;
        const from = d > 0 ? e : c.home;
        const len = dist(from, at);
        if (len === 0) continue;
        const to = (reach + CHARGE_CLEAR) / len;
        moves.push({ kind: 'move', units: [e.id], x: snap(at.x + (from.x - at.x) * to, this.size), y: snap(at.y + (from.y - at.y) * to, this.size) });
        cleared.add(e.id);
      }
    }
    if (!moves.length) return;
    for (let n = out.length - 1; n >= 0; n--) {
      const intent = out[n];
      if (!('units' in intent) || !intent.units.some((id) => cleared.has(id))) continue;
      const units = intent.units.filter((id) => !cleared.has(id));
      if (units.length) out[n] = { ...intent, units };
      else out.splice(n, 1);
    }
    out.unshift(...moves);
  }

  /** Reused route workspace: no map-sized allocation during subsequent decisions. */
 surfaceLabels;
 surfaceQueue;

  /**
   * Resolve tactical goals against connected public ground, not an assumed diagonal lane. This handles island
   * crossings, fortress gates, ridge ramps and river fords with the same knowledge as an agent. The simulator
   * routes the actual walk; we only replace blocked/disconnected destinations, preserving existing legal orders.
   */
 routeSurface(c, out) {
    if (!out.some((i) => i.kind === 'move' || i.kind === 'rally')) return;
    const size = this.size, n = size * size;
    if (!this.surfaceLabels || this.surfaceLabels.length !== n) {
      this.surfaceLabels = new Int32Array(n);
      this.surfaceQueue = new Int32Array(n);
    }
    const labels = this.surfaceLabels;
    const queue = this.surfaceQueue;
    const walk = c.walkMask();
    for (let cell = 0; cell < n; cell++) labels[cell] = walk[cell] ? 0 : -1;
    // Only structures in the fogged observation block planning; never inspect a hidden document or world.
    for (const e of c.obs.entities) {
      const f = e.plane === 'surface' ? footprint(e.kind) : undefined;
      if (!f) continue;
      for (let y = Math.max(0, Math.floor(e.y - f.h / 2)); y < Math.min(size, e.y + f.h / 2); y++) {
        for (let x = Math.max(0, Math.floor(e.x - f.w / 2)); x < Math.min(size, e.x + f.w / 2); x++) labels[y * size + x] = -1;
      }
    }
    // Connected components (edge neighbours), numbered in cell order.
    let component = 0;
    for (let cell = 0; cell < n; cell++) {
      if (labels[cell] !== 0) continue;
      labels[cell] = ++component;
      let length = 1;
      queue[0] = cell;
      for (let cursor = 0; cursor < length; cursor++) {
        const at = queue[cursor];
        const x = at % size;
        if (x > 0 && labels[at - 1] === 0) { labels[at - 1] = component; queue[length++] = at - 1; }
        if (x < size - 1 && labels[at + 1] === 0) { labels[at + 1] = component; queue[length++] = at + 1; }
        if (at >= size && labels[at - size] === 0) { labels[at - size] = component; queue[length++] = at - size; }
        if (at + size < n && labels[at + size] === 0) { labels[at + size] = component; queue[length++] = at + size; }
      }
    }
    const order = c.frame.cells();
    for (let index = out.length - 1; index >= 0; index--) {
      const intent = out[index];
      if (intent.kind !== 'move' && intent.kind !== 'rally') continue;
      const from = intent.kind === 'move' ? c.own.find((e) => e.id === intent.units[0]) : c.home;
      if (!from) continue;
      // Our own cell of a point (cellFor): a point on a cell edge resolves like its rotated twin's.
      let source = c.frame.pointCell(from.x, from.y);
      if ((labels[source] ?? -1) <= 0) {
        let distance = Infinity;
        source = -1;
        for (let serial = 0; serial < n; serial++) {
          const cell = order[serial];
          if (labels[cell] <= 0) continue;
          const dx = (cell % size) + 0.5 - from.x;
          const dy = Math.floor(cell / size) + 0.5 - from.y;
          const d = dx * dx + dy * dy;
          if (d < distance) { source = cell; distance = d; }
        }
      }
      if (source < 0) { out.splice(index, 1); continue; }
      const target = c.frame.pointCell(intent.x, intent.y);
      if (intent.x >= 0 && intent.x < size && intent.y >= 0 && intent.y < size && labels[target] === labels[source]) continue;
      const label = labels[source];
      let best = -1;
      let distance = Infinity;
      for (let serial = 0; serial < n; serial++) {
        const cell = order[serial];
        if (labels[cell] !== label) continue;
        const dx = (cell % size) + 0.5 - intent.x;
        const dy = Math.floor(cell / size) + 0.5 - intent.y;
        const d = dx * dx + dy * dy;
        if (d < distance) { best = cell; distance = d; }
      }
      if (best < 0) { out.splice(index, 1); continue; }
      intent.x = cellCentreX(best, size);
      intent.y = cellCentreY(best, size);
    }
  }

  /**
   * Crowns: this seat's own segment fell and the army has a rebuild left: queue it first in this plane's lane;
   * it waits out enemy_near by itself. Under the `surface` rule side segments are economy only and the
   * built-in bots do not rebuild them.
   */
 rebuild(c) {
    const role = c.obs.role;
    if (c.match.rules.spire.lossRule !== 'crowns' || c.segmentAlive(role) || c.obs.res.rebuilds <= 0 || c.obs.queue.some((e) => e.item === 'rebuild')) return [];
    return [{ kind: 'queue_add', item: 'rebuild', plane: role, index: 0 }];
  }

  /** next tick a defence reorder is allowed */
 rushAt = 0;

  /**
   * Only this seat's trusted automatic plans: cancel impossible sites/dead producers. A slow funding front is a
   * legitimate future commitment, not a stale plan; never repeatedly abandon it in favour of cheap entries below.
   * The exception is army first under attack: this seat's unpaid entries outside the Surface army (armyItem) that are
   * not fully backed go, so the defending fighter takes the income they would share.
   */
 tidyQueue(c) {
    const out = [];
    const q = c.obs.queue;
    const role = c.obs.role;
    for (const e of q) {
      if (this.holdBack && this.surfaceHit && e.automatic && e.by === role && !e.paid && !e.recovery && !armyItem(e.item)) {
        const cost = isStatKind(e.item) ? c.stats[e.item] : c.match.upgrades.find((row) => row.id === e.item);
        if (cost && (e.heldAlloy < cost.alloy || e.heldEnergy < cost.energy)) {
          out.push({ kind: 'queue_cancel', entry: e.id });
          continue;
        }
      }
      if (!e.automatic || e.by !== role || e.plane !== role || e.status !== 'blocked') continue;
      // A living producer can recover power; an immutable missing/dead producer ID cannot.
      const lostProducer = e.reason === 'producer' && e.producer !== undefined
        && !c.own.some((p) => p.id === e.producer && p.hp > 0);
      const impossible = e.item === 'ore_extractor' && e.reason === 'blocked'
        ? c.econ.islandHardpoints < 1 || c.obs.entities.some(i => i.id === e.island && i.kind === 'island' && i.side === c.army && i.oreRemaining === 0)
        : e.reason && GIVE_UP[e.reason];
      if (lostProducer || impossible) out.push({ kind: 'queue_cancel', entry: e.id });
      if (lostProducer && isStatKind(e.item) && isAircraft(e.item)) {
        const aerie = c.frame.order(c.own.filter(p => p.kind === 'aerie' && p.state === 'active'))[0];
        if (aerie || c.segmentAlive('sky')) {
          out.push({ kind: 'queue_add', item: e.item, ...(aerie ? { producer: aerie.id } : {}) });
          c.reserveCost(c.stats[e.item].alloy, c.stats[e.item].energy);
        }
      }
    }
    return out;
  }

  /**
   * Defence under attack: move an automatic entry ahead of discretionary work in this plane's lane only.
   * Never move an already-leading entry, or jump a paid, explicit, rebuild or recovery commitment.
   */
 rushDefence(c, out, items) {
    if (c.obs.tick < this.rushAt) return;
    const q = c.obs.queue;
    const role = c.obs.role;
    const i = q.findIndex((e) => e.automatic && e.by === role && e.plane === role && !e.paid && items.includes(e.item));
    if (i <= 0) return;
    let first = -1;
    for (let j = 0; j < i; j++) {
      const e = q[j];
      if (e.plane !== role) continue;
      if (e.paid || !e.automatic || e.by !== role || e.item === 'rebuild' || e.recovery || e.heldAlloy > 0 || e.heldEnergy > 0) first = -1;
      else if (first < 0) first = j;
    }
    if (first < 0) return;
    out.push({ kind: 'queue_move', entry: q[i].id, index: first });
    this.rushAt = c.obs.tick + DEFENCE_REORDER;
  }

  /**
   * An empty lane commits its next unit even when expensive; the sim protects its eligible head's funds.
   * Extra buffered units require authoritative free funds after this decision's requests and alloy reserve.
   * With `screenFirst`, other energy units leave energy for an interceptor while the defensive screen is short.
   * `defend`: a defence unit the plane must have (its home under attack), committed like an empty lane's past the lane
   * depth (the sim's seat cap still binds).
   */
 produce(c, out, kind, plane, reserve = this.tier.reserve[plane], defend = false) {
    const alive = c.segmentAlive(plane);
    let shaft;
    if (!alive && kind === 'digger') {
      const home = c.home;
      for (const e of c.own) {
        if (e.kind !== 'shaft' || e.plane !== 'surface' || e.state === 'constructing') continue;
        if (!shaft || dist(e, home) < dist(shaft, home) || (dist(e, home) === dist(shaft, home) &&
          c.frame.cellKey(Math.floor(e.y) * this.size + Math.floor(e.x)) < c.frame.cellKey(Math.floor(shaft.y) * this.size + Math.floor(shaft.x)))) shaft = e;
      }
    }
    const multiplier = shaft ? c.match.rules.economy.shaftDiggerMultiplier : 1;
    const alloy = Math.ceil(c.stats[kind].alloy * multiplier);
    const energy = Math.ceil(c.stats[kind].energy * multiplier);
    const queued = c.ownQueued();
    const recovering = kind === 'digger' && c.units('digger', 'depths').length < c.match.rules.queue.recoveryWorkers;
    if (kind === 'digger' && c.queued('digger') > 0) return false;
    // Army first, or a Headframe saving: anything outside the Surface army is optional too, so it waits until the free
    // bank covers it at once; army first leaves a squad's troopers (SQUAD_MIN) in the bank besides: every seat decides
    // on the same tick from the same free bank, so the others' checks alone spent what the Surface lane was about to commit.
    const holding = (this.holdBack || this.frameDue) && !armyItem(kind);
    const optional = !recovering && !defend && (queued > 0 || holding);
    const spare = this.holdBack && holding ? SQUAD_MIN * c.stats.trooper.alloy : 0;
    if ((!alive && !shaft) || queued >= (recovering || defend ? c.econ.queueSeatMax : this.tier.queueDepth) || (optional && !c.affordableCost(alloy, energy, reserve + spare))) return false;
    // A destroyed Sky segment cannot replace its screen; do not reserve energy for impossible production.
    const screenShort = !recovering && this.tier.screenFirst && c.segmentAlive('sky') && kind !== 'interceptor' && energy > 0 && c.units('interceptor').length < this.tier.interceptors;
    if (optional && screenShort && c.obs.res.freeEnergy < energy + c.stats.interceptor.energy) return false;
    out.push({ kind: 'queue_add', item: kind, ...(shaft ? { producer: shaft.id } : {}), ...(optional ? { ifAffordable: true } : {}) });
    c.reserveCost(alloy, energy);
    return true;
  }

  /** Team-wide beneficiary stock includes pending production and this decision's new unit orders. */
 stock(c, out, kind) {
    let count = 0;
    for (const q of c.obs.queue) if (q.item === kind && q.site === undefined) count++;
    for (const e of c.own) if (e.kind === kind && e.hp > 0 && e.state !== 'constructing') count++;
    for (const intent of out) if (intent.kind === 'queue_add' && intent.item === kind) count += intent.count ?? 1;
    return count;
  }

  /** Composition first: cover committed production and one next desired unit before optional research. */
 research(c, out, id, wanted, reserve) {
    const upgrade = c.match.upgrades.find((entry) => entry.id === id);
    let queued = c.ownQueued(), entries = c.obs.queue.length;
    for (const intent of out) if (intent.kind === 'research' || intent.kind === 'queue_add') {
      const count = intent.kind === 'queue_add' ? intent.count ?? 1 : 1;
      queued += count; entries += count;
    }
    if (this.holdBack || this.frameDue || !upgrade || upgrade.at !== c.obs.role || !c.segmentAlive(upgrade.at)
      || queued >= c.econ.queueSeatMax || entries >= c.econ.queueTeamMax
      || c.obs.research.inProgress.some((pending) => c.match.upgrades.some((row) => row.id === pending && row.at === upgrade.at))
      || !c.obs.research.available.includes(id)
      || !upgrade.units.some((kind) => this.stock(c, out, kind) >= (this.tier.researchMinimum[kind] ?? RESEARCH_MINIMUM_DEFAULT))) return false;
    let alloy = upgrade.alloy, energy = upgrade.energy;
    for (const kind in wanted) {
      if (!isUnitKind(kind)) continue;
      if (this.stock(c, out, kind) >= wanted[kind]) continue;
      alloy += c.stats[kind].alloy;
      energy += c.stats[kind].energy;
      break;
    }
    if (!c.affordableCost(alloy, energy, reserve)) return false;
    out.push({ kind: 'research', upgrade: id, ifAffordable: true });
    c.reserveCost(upgrade.alloy, upgrade.energy);
    return true;
  }

  /**
   * Fog-only fleet orders: escorts stay with income (`ward`, when given, is the one ship they guard), raiders hunt
   * economy, and frigates gather before a siege (by the derelict ruin when there is one).
   */
  /** `raid`: where an idle raiding group gathers instead of the ruin post (Skiffs hunting forward array fields). */
 orbitCombat(c, out, fighters, ward, raid) {
    if (!fighters.length) return;
    // Do not cancel a charge/root with routine fleet orders, including one started in this decision.
    fighters = fighters.filter(e => !e.lance && !e.aegis && !out.some(i =>
      (i.kind === 'sun_lance' || i.kind === 'aegis') && i.units.includes(e.id)));
    if (!fighters.length) return;
    const at = centroid(fighters);
    const home = c.home;
    const enemy = c.foeAt;
    const escort = fighters[0].kind === 'bastion';
    const raider = fighters[0].kind === 'skiff' || fighters[0].kind === 'interceptor';
    let anchor;
    let target;
    let threat;
    let spire;
    const reach = c.statsOf(fighters[0]).vision;
    const fighterStats = c.statsOf(fighters[0]);
    // A locally identified armed tow is a better target than its tug: detonate it only clear of our assets.
    const volatile = c.obs.entities.find((rock) => rock.kind === 'asteroid' && rock.plane === 'orbit'
      && rock.state === 'towed' && rock.volatile === true && rock.fuseUntil !== undefined
      && rock.fuseUntil > c.obs.tick
      && c.foes.some((tug) => tug.plane === 'orbit' && c.statsOf(tug).capabilities.tow && tug.link === rock.id
        && dist(tug, rock) <= c.match.rules.orbit.volatileOrbitRadius)
      && !c.own.some((e) => e.plane === 'orbit'
        && footprintDistance(e.kind, e.x, e.y, rock.x, rock.y) <= c.match.rules.orbit.volatileOrbitRadius)
      && fighters.every((e) => c.statsOf(e).dmg > 0
        && (c.statsOf(e).targets.includes('orbit') || e.kind === 'interceptor')
        && dist(e, rock) <= c.statsOf(e).range + c.econ.asteroidRadius));
    if (volatile) {
      out.push({ kind: 'attack', units: ids(fighters), target: volatile.id });
      return;
    }
    if (ward) anchor = ward;
    else for (const e of c.own) {
      if (e.plane !== 'orbit' || (e.kind !== 'solar' && !(isStatKind(e.kind) && c.stats[e.kind].capabilities.tow))) continue;
      if (!anchor || gridDist2(e, at) < gridDist2(anchor, at)) anchor = e;
    }
    for (const e of c.foes) {
      if (e.plane !== 'orbit') continue;
      if (e.kind === 'spire') {
        spire = e;
        // In danger inside the beam (from the footprint edge) or the station PD (from the centre).
        const inBeam = c.stats.spire.dmg > 0 && footprintDistance('spire', e.x, e.y, at.x, at.y) <= c.stats.spire.range + fighterStats.radius;
        const inPd = c.econ.stationPdDamage > 0 && dist(e, at) <= c.econ.stationPdRange + fighterStats.radius;
        if ((inBeam || inPd) && (!threat || gridDist2(e, at) < gridDist2(threat, at))) threat = e;
        continue;
      }
      const armed = c.statsOf(e).dmg > 0;
      if (armed && (!threat || gridDist2(e, at) < gridDist2(threat, at))) threat = e;
      if (escort && dist(e, anchor ?? at) > reach) continue;
      if (!target || (raider && !armed && c.statsOf(target).dmg > 0)
        || (armed === (c.statsOf(target).dmg > 0) && gridDist2(e, at) < gridDist2(target, at))) target = e;
    }
    let hull = 0, damage = 0, efficiency = Infinity;
    let hostileHull = 0, hostileDamage = 0;
    const danger = threat && (threat.kind === 'spire' || dist(threat, at) <= reach + c.statsOf(threat).range);
    const contest = danger ? threat : target;
    for (const e of c.own) {
      const stats = isStatKind(e.kind) ? c.stats[e.kind] : undefined;
      if (e.plane !== 'orbit' || e.kind === 'spire' || !stats || stats.dmg <= 0 || !stats.weapon || dist(e, at) > reach) continue;
      const health = e.hp + (e.shield ?? 0);
      hull += health;
      damage += stats.dmg * DAMAGE_VS[stats.weapon][contest ? c.statsOf(contest).armor : 'structure'] / Math.max(1, stats.cooldown);
      efficiency = Math.min(efficiency, stats.dmg * DAMAGE_VS[stats.weapon].structure / Math.max(1, stats.cooldown) / (stats.hp + (stats.shield ?? 0)));
    }
    for (const e of c.foes) {
      const stats = isStatKind(e.kind) ? c.stats[e.kind] : undefined;
      if (e.plane !== 'orbit' || !stats || !contest || dist(e, contest) > reach) continue;
      if (e.kind === 'spire') {
        hostileHull += e.hp;
        // The beam reaches from the footprint edge (station PD from the centre).
        if (footprintDistance('spire', e.x, e.y, at.x, at.y) <= c.stats.spire.range + fighterStats.radius) hostileDamage += stats.dmg * DAMAGE_VS.beam[fighterStats.armor] / Math.max(1, stats.cooldown);
        if (dist(e, at) <= c.econ.stationPdRange + fighterStats.radius) hostileDamage += c.econ.stationPdDamage * DAMAGE_VS.point_defence[fighterStats.armor] / Math.max(1, c.econ.stationPdCooldown);
      } else if (stats.dmg > 0 && stats.weapon) {
        hostileHull += e.hp + (e.shield ?? 0);
        hostileDamage += stats.dmg * DAMAGE_VS[stats.weapon][fighterStats.armor] / Math.max(1, stats.cooldown);
      }
    }
    // Tier defaults reject even trades; custom aggression deliberately changes the required combat margin.
    const favourable = hostileDamage === 0 || hull * damage > ORBIT_TRADE_MARGIN * (1 - this.tier.aggressionShift) * hostileHull * hostileDamage;
    if (danger && !favourable) {
      // A threat faster than our slowest ship runs any retreat down, and a group backing off on a plain move never
      // fires (a lone Lancer fled a Skiff along the map edge for minutes): it turns and fights instead.
      let slowest = Infinity;
      for (const e of fighters) slowest = Math.min(slowest, c.statsOf(e).speed);
      if (threat.kind !== 'spire' && c.statsOf(threat).speed > slowest) {
        out.push({ kind: 'attack', units: ids(fighters), target: threat.id });
        return;
      }
      const dx = at.x - threat.x, dy = at.y - threat.y;
      const length = norm(dx, dy);
      const bx = at.x + dx / length * reach, by = at.y + dy / length * reach;
      // A step back off the map (cornered: clamped, it slides along the edge, even into the enemy's corner, and two
      // groups backing off each other end up side by side there) or into the derelict hull (a group split round the
      // ruin has its centroid in the chamber) never gets clear: the group would sit in the threat's reach on a move that
      // never fires. It falls back home instead. Either way it is a fight-move: whatever blocks the way (an enemy ship
      // parked in a breach or corridor mouth) is fought through rather than sat behind, while the threat it backs off
      // from, behind it, is left alone.
      const g = c.match.derelict;
      const stuck = length === 0 || offMap(bx, this.size) || offMap(by, this.size) || (g !== undefined && dist({ x: bx, y: by }, g) < g.hullOuter + RUIN_CLEARANCE);
      const fallback = stuck ? home : { x: snap(bx, this.size), y: snap(by, this.size) };
      out.push({ kind: 'move', units: ids(fighters), x: fallback.x, y: fallback.y, mode: 'fight', formation: 'line' });
      return;
    }
    // Standing orders are left alone while every fighter is busy, except that a group under way answers a target in
    // sight: a plain move never fires fixed mounts and fires forward ones only dead ahead, so Lancers still gathering
    // would take an enemy's fire beside them unanswered until they arrived. Turrets fire on the move by themselves.
    const idle = fighters.some(e => e.state === 'idle');
    const underWay = !idle && fighterStats.mount?.kind !== 'turret';
    if (!idle && (!underWay || !target)) return;
    const beam = c.stats.spire.dmg / Math.max(1, c.stats.spire.cooldown);
    const stationPd = fighterStats.range + c.stats.spire.radius <= c.econ.stationPdRange + fighterStats.radius
      ? c.econ.stationPdDamage * DAMAGE_VS.point_defence[fighterStats.armor] / Math.max(1, c.econ.stationPdCooldown) : 0;
    // Sudden death: a pushing tier weighs the segment at HP ÷ suddenDeathDamage (its fleet deals that much more).
    const segmentHp = (spire?.hp ?? c.match.rules.spire.hp.orbit) / (this.tier.suddenDeathPush ? c.spireDamageFactor() : 1);
    // Crowns: the focus's Orbit segment as its weakest crown is worth a thinner margin (CROWN_SIEGE_PUSH).
    const push = c.crown === 'orbit' ? CROWN_SIEGE_PUSH : 1;
    const siege = !escort && !raider && hull > 0 && hull * hull * efficiency > ORBIT_SIEGE_MARGIN * push * (1 - this.tier.aggressionShift) * (beam + stationPd) * segmentHp;
    // Do not chase an economic target through a hostile segment beam with an undersized group.
    if (target && (!favourable || (!siege && c.hostileSpireEdgeDist(target) <= c.stats.spire.range + c.statsOf(fighters[0]).radius))) target = undefined;
    if (!idle && (!target || fighters.every(e => e.state === 'attacking'))) return;
    // Researched Skiffs approach exposed income through darkness before committing their short-range guns.
    if (raider && fighters[0].kind === 'skiff' && c.obs.research.completed.includes('night_cloak')
      && target && !danger && Math.abs(sunOffset(at.x, at.y, c.obs.sun.angle, this.size, c.match.sun.wedges)) >= c.match.sun.half
      && dist(at, target) > fighterStats.range && !c.foes.some(e => e.plane === 'orbit'
        && (e.kind === 'bastion' || e.kind === 'spire') && footprintDistance(e.kind, e.x, e.y, target.x, target.y) <= c.stats[e.kind].range)) {
      // Darkness lies midway between lit wedge centre lines: approach along the dark line nearest the target. The
      // other dark lines are exact turns of the first, so rotated fleets pick rotated lines.
      const angle = c.obs.sun.angle + Math.PI / c.match.sun.wedges;
      const tx = target.x - this.size / 2, ty = target.y - this.size / 2;
      const radius = norm(tx, ty);
      const cos = dmath.cos(angle), sin = dmath.sin(angle);
      let ux = cos, uy = sin, best = cos * tx + sin * ty;
      for (let k = 4 / c.match.sun.wedges; k < 4; k += 4 / c.match.sun.wedges) {
        const vx = rotVX(k, cos, sin), vy = rotVY(k, cos, sin);
        if (vx * tx + vy * ty > best) {
          ux = vx;
          uy = vy;
          best = vx * tx + vy * ty;
        }
      }
      const x = snap(this.size / 2 + radius * ux, this.size);
      const y = snap(this.size / 2 + radius * uy, this.size);
      if (norm(at.x - x, at.y - y) > fighterStats.range) {
        if (idle) out.push({ kind: 'move', units: ids(fighters), x, y, formation: 'wedge' });
        return;
      }
    }
    target ??= siege ? spire : undefined;
    if (target) out.push({ kind: 'attack', units: ids(fighters), target: target.id });
    else {
      // Not the map centre itself: that is the derelict chamber, whose radiation wears down a parked fleet.
      const gather = escort ? anchor ?? home : siege ? enemy : raid ?? c.ruinPost();
      out.push({
        kind: 'move', units: ids(fighters), x: gather.x, y: gather.y, mode: siege || raid ? 'fight' : 'move',
        formation: escort ? 'escort' : raider ? 'wedge' : 'line', ...(escort ? { escort: fighters[0].id } : {}) });
    }
  }

  /** hostile diggers seen in the last DIGGER_MEMORY ticks (id → where and when) */
 diggersSeen = new Map();

  /**
   * How much of the hostile depths economy we know of: distinct diggers seen lately (our miners, scans) plus tremors
   * (hostile units under our surface presence) away from home.
   */
 greed(c) {
    return this.diggersSeen.size + c.obs.tremors.filter((t) => !t.breach && dist({ x: t.x + 0.5, y: t.y + 0.5 }, c.home) > BASE_RADIUS).length;
  }

  /**
   * Enemy turrets, Headframes, Shafts and bulkheads seen so far (observations carry no memory): kept while out of
   * sight, forgotten once destroyed or once one of our units has the spot well inside its sight and sees nothing there
   * (high ground is only seen from high ground, or from a forward post we hold; in the depths, from next to it).
   */
 turretsSeen = new Map();
 headframesSeen = new Map();
 shaftsSeen = new Map();
 bulkheadsSeen = new Map();

 remember(c, kind, seenBefore) {
    const seen = new Set();
    for (const e of c.foes) {
      if (e.kind !== kind) continue;
      seenBefore.set(e.id, { x: e.x, y: e.y });
      seen.add(e.id);
    }
    const lost = c.obs.events.filter((ev) => ev.kind === 'structure_destroyed' && ev.subject === kind);
    const plane = kind === 'bulkhead' ? 'depths' : 'surface';
    const eyes = c.own.filter((e) => e.plane === plane && e.kind !== 'spire');
    // A post we hold sees like high ground (sim/vision.ts): over cliffs and onto plateaus, postVision tiles around it.
    const posts = plane === 'surface' ? c.posts.filter((e) => e.side === c.army) : [];
    const high = (p) => isSurfaceHigh(c.ground[Math.floor(p.y) * this.size + Math.floor(p.x)]);
    for (const [id, p] of seenBefore) {
      if (seen.has(id)) continue;
      const looked = eyes.some((e) => (plane === 'depths' ? dist(e, p) < DEPTHS_LOOK_REACH : dist(e, p) < c.statsOf(e).vision - VISION_MARGIN && (!high(p) || high(e))))
        || posts.some((e) => dist(e, p) < c.econ.postVision - VISION_MARGIN);
      if (looked || lost.some((ev) => dist(ev, p) < AT_POINT)) seenBefore.delete(id);
    }
  }

  /**
   * Static defence: with SIEGE_TURRETS or more hostile turrets known within BASE_RADIUS of the focus's Spire, the one
   * nearest our Spire (the outer edge of their ring; ties in our frame's cell order) is what every seat sieges. Else
   * undefined.
   */
 siegeTarget(c) {
    const foe = c.foeAt;
    const home = c.home;
    const ring = [...this.turretsSeen].filter(([, p]) => dist(p, foe) < BASE_RADIUS);
    if (ring.length < SIEGE_TURRETS) return undefined;
    const key = (p) => c.frame.cellKey(Math.floor(p.y) * this.size + Math.floor(p.x));
    let best;
    for (const r of ring) if (!best || dist(r[1], home) < dist(best[1], home) || (dist(r[1], home) === dist(best[1], home) && key(r[1]) < key(best[1]))) best = r;
    return best && { id: best[0], ...best[1] };
  }
}
