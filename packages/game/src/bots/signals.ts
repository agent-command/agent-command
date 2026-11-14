/**
 * Team signals for the built-in bots (rules/signals.ts, DESIGN §9.2): each seat's desk tracks the requests it answers
 * and the ones it asked, and each plane answers and asks through the helpers below. Unit picks are nearest-first with
 * ties in our frame's order and tiles are cells of our frame, so rotated armies send and answer exactly rotated
 * signals. With the `signals.enabled` rule off the desk does nothing (a signal would be refused `disabled`).
 */
import { isIslandStructure, SUPPORT_COUNT_MAX } from '../rules/vocabulary.ts';
import type { Entity, Observation, Plane, SupportNeed } from '../rules/contract.ts';
import type { AgentCommandIntent } from '../agent/intents.ts';
import { dist } from '../util/math.ts';
import { gridDist2, ids, snap, type Ctx, type Pt } from './context.ts';
import {
  HOME_WORKS,
  MINER_GUARD_RADIUS,
  RAID_INTERCEPTORS,
  INTRUDER_MARGIN,
  SCAN_TREMOR_RADIUS,
  SIGNAL_AIR_HEAVY,
  SIGNAL_ARRIVE,
  SIGNAL_HOLD,
  SIGNAL_ISLAND_REACH,
  SIGNAL_RAID_RADIUS,
  SIGNAL_REASK,
  SIGNAL_SEEN_REACH,
  SIGNAL_TARGET_REACH,
  VISION_MARGIN,
  WARDEN_ALERT,
  type SignalBudget,
} from './tuning.ts';

/** One request as a seat sees it (inbox or sent). */
export type SupportRequest = Observation['signals']['inbox'][number];

/** A request this seat acked and works on. */
export interface SignalTask {
  entry: SupportRequest;
  /** committed units (none for a scan) */
  units: string[];
  /** where they go: the request's tile centre, or the Shaft troopers change planes at */
  at: Pt | null;
  /** bombers: the structure they attack */
  target?: string;
}

const OPEN: ReadonlySet<string> = new Set(['submitted', 'working']);

/** Centre of a request's tile, or null without one. */
export const tileCentre = (e: SupportRequest): Pt | null => (e.x === undefined || e.y === undefined ? null : { x: e.x + 0.5, y: e.y + 0.5 });

/**
 * `defend {plane}` read as the need the answering bots already serve for that plane: our Depths segment → troops from
 * the Depths (the Surface sends troopers down a Shaft); our Surface segment → troops from the Surface (the Depths send
 * troopers up); our Sky segment → flak under the Spire (the Surface); our Orbit segment → air cover from Orbit (the Sky
 * ascends interceptors). Every other request reads as itself.
 */
const DEFEND_AS: Readonly<Record<Plane, { need: SupportNeed; from: Plane }>> = {
  depths: { need: 'troops', from: 'depths' },
  surface: { need: 'troops', from: 'surface' },
  sky: { need: 'flak', from: 'sky' },
  orbit: { need: 'air_cover', from: 'orbit' },
};
export const asked = (e: SupportRequest): { need: SupportNeed; from: Plane } =>
  e.need === 'defend' && e.plane ? DEFEND_AS[e.plane] : { need: e.need, from: e.from as Plane };

/** Our frame's cell holding `p` (kept half a tile inside the map, which every turn preserves) as a request tile. */
function tileOf(c: Ctx, p: Pt): { x: number; y: number } {
  const cell = c.frame.pointCell(snap(p.x, c.size), snap(p.y, c.size));
  return { x: cell % c.size, y: Math.floor(cell / c.size) };
}

/** The `n` of `units` nearest `p` (ties in our frame's order). */
function nearest(c: Ctx, units: readonly Entity[], p: Pt, n: number): Entity[] {
  return [...units].sort((a, b) => gridDist2(a, p) - gridDist2(b, p) || c.frame.pointKey(a) - c.frame.pointKey(b)).slice(0, Math.max(0, n));
}

/** Our open Shaft nearest `p` (ties in our frame's order): own unsealed Shafts are the only Surface↔Depths portals. */
function portal(c: Ctx, p: Pt): Entity | undefined {
  return nearest(c, c.shafts(), p, 1)[0];
}

/** Units for a request: what it asks (or the budget), within the budget and above the pool's reserve. */
const share = (budget: SignalBudget, e: SupportRequest, pool: number, available = pool): number =>
  Math.min(e.count ?? budget.units, budget.units, pool - budget.reserve, available);

export class SignalDesk {
  readonly budget: SignalBudget;
  /** decision period: a working request is failed one decision before it would expire */
  private readonly period: number;
  private on = false;
  private role: Plane = 'surface';
  private tick = 0;
  private readonly tasks = new Map<string, SignalTask>();
  /** units holding a delivered request's tile (id → tick they rejoin) */
  private readonly holds = new Map<string, number>();
  /** inbox requests this seat already acked or declined, until they leave its inbox */
  private readonly answered = new Set<string>();
  /** per need: tick our latest request went out (until it closes), and the tick from which it may be asked again */
  private readonly asking = new Map<SupportNeed, number>();
  private readonly quiet = new Map<SupportNeed, number>();
  private inbox: readonly SupportRequest[] = [];
  private sent: readonly SupportRequest[] = [];
  private maxOpen = 0;
  private out: AgentCommandIntent[] = [];

  constructor(budget: SignalBudget, period: number) {
    this.budget = budget;
    this.period = period;
  }

  /** Before a decision: read the board, drop tasks that ended elsewhere (taken by a teammate, canceled, expired). */
  begin(c: Ctx): void {
    this.out = [];
    this.on = c.match.rules.signals.enabled;
    if (!this.on) return;
    this.role = c.obs.role;
    this.tick = c.obs.tick;
    this.inbox = c.obs.signals.inbox;
    this.sent = c.obs.signals.sent;
    this.maxOpen = c.econ.signalMaxOpen;
    for (const id of this.answered) if (!this.inbox.some((e) => e.id === id)) this.answered.delete(id);
    for (const [id, task] of this.tasks) {
      const entry = this.inbox.find((e) => e.id === id);
      if (!entry || entry.state !== 'working' || entry.by !== this.role) this.tasks.delete(id);
      else task.entry = entry;
    }
    for (const [id, until] of this.holds) if (until <= this.tick || !c.own.some((e) => e.id === id)) this.holds.delete(id);
    for (const [need, at] of this.asking) {
      if (at < this.tick && !this.sent.some((e) => e.need === need && OPEN.has(e.state))) {
        this.asking.delete(need);
        this.quiet.set(need, this.tick + SIGNAL_REASK);
      }
    }
    if (!this.budget.answer) for (const e of this.fresh()) this.decline(e);
  }

  /** Intents the desk queued this decision (updates and new requests). */
  flush(): AgentCommandIntent[] {
    return this.out;
  }

  /** Requests nobody took yet that this seat has not answered. */
  fresh(): SupportRequest[] {
    if (!this.on) return [];
    return this.inbox.filter((e) => e.state === 'submitted' && !this.answered.has(e.id) && !this.tasks.has(e.id));
  }

  /** The requests this seat works on, oldest first. */
  work(): SignalTask[] {
    return [...this.tasks.values()];
  }

  /** Is this unit committed to a request (or holding its tile)? */
  busy(id: string): boolean {
    if (this.holds.has(id)) return true;
    for (const task of this.tasks.values()) if (task.units.includes(id)) return true;
    return false;
  }

  /** Room for one more answered request. */
  room(): boolean {
    return this.tasks.size < this.budget.tasks;
  }

  take(entry: SupportRequest, units: readonly Entity[], at: Pt | null, target?: string): SignalTask {
    const task: SignalTask = { entry, units: units.map((e) => e.id), at, ...(target ? { target } : {}) };
    this.tasks.set(entry.id, task);
    this.answered.add(entry.id);
    this.out.push({ kind: 'signal_update', id: entry.id, update: 'ack' });
    return task;
  }

  /** Units now go for a task acked while it waited (troopers once a Shaft is open). */
  commit(task: SignalTask, units: readonly Entity[], at: Pt): void {
    task.units = units.map((e) => e.id);
    task.at = at;
  }

  decline(entry: SupportRequest): void {
    this.answered.add(entry.id);
    this.out.push({ kind: 'signal_update', id: entry.id, update: 'decline' });
  }

  /** Delivered; `hold`: its units keep the tile for SIGNAL_HOLD before rejoining. */
  done(task: SignalTask, hold: boolean): void {
    this.tasks.delete(task.entry.id);
    this.out.push({ kind: 'signal_update', id: task.entry.id, update: 'done' });
    if (hold) for (const id of task.units) this.holds.set(id, this.tick + SIGNAL_HOLD);
  }

  fail(task: SignalTask): void {
    this.tasks.delete(task.entry.id);
    this.out.push({ kind: 'signal_update', id: task.entry.id, update: 'fail' });
  }

  /** The request expires before our next decision: say it failed instead. */
  late(task: SignalTask): boolean {
    return this.tick + this.period >= task.entry.expires;
  }

  /**
   * Ask `to` (a plane, or the whole team) for `need` at `at` (one open request per need; asked again only SIGNAL_REASK
   * after it closed); `plane`: defend's segment. Returns whether the request went out.
   */
  ask(c: Ctx, need: SupportNeed, to: Plane | 'team', at?: Pt, count?: number, plane?: Plane): boolean {
    if (!this.on || !this.budget.ask || this.asking.has(need) || (this.quiet.get(need) ?? 0) > this.tick) return false;
    // Our open requests on the board, plus the ones this decision already sent.
    let open = 0;
    for (const e of this.sent) if (OPEN.has(e.state)) open++;
    for (const at of this.asking.values()) if (at === this.tick) open++;
    if (open >= this.maxOpen) return false;
    const tile = at ? tileOf(c, at) : undefined;
    const n = count === undefined ? undefined : Math.min(SUPPORT_COUNT_MAX, Math.max(1, Math.round(count)));
    this.out.push({ kind: 'signal', signal: { kind: 'request_support', to, need, ...(n === undefined ? {} : { count: n }), ...(tile ?? {}), ...(plane ? { plane } : {}) } });
    this.asking.set(need, this.tick);
    return true;
  }

  /** Our request for `need` is no longer wanted: cancel it while nobody took it yet. */
  withdraw(need: SupportNeed): void {
    if (!this.on) return;
    for (const e of this.sent) if (e.need === need && e.state === 'submitted') this.out.push({ kind: 'signal_update', id: e.id, update: 'cancel' });
  }
}

/** Committed units still alive, by id. */
const alive = (c: Ctx, task: SignalTask): Entity[] => c.own.filter((e) => task.units.includes(e.id));

/** Every unit within `reach` (default SIGNAL_ARRIVE) tiles of the task's tile. */
const arrived = (units: readonly Entity[], at: Pt | null, reach = SIGNAL_ARRIVE): boolean => !!at && units.every((e) => dist(e, at) <= reach);

/** Take `units` out of `list` (in place). */
function remove(list: Entity[], units: readonly Entity[]): void {
  for (const e of units) {
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
  }
}

// ------------------------------------------------------------------ answers

/** Is a `troops` request from the Depths (or a `defend` of our Depths segment) waiting for a usable Shaft (the Surface puts one up for it)? */
export function shaftWanted(desk: SignalDesk): boolean {
  const down = (e: SupportRequest): boolean => asked(e).need === 'troops' && asked(e).from === 'depths';
  return desk.work().some((task) => down(task.entry) && task.units.length === 0) || desk.fresh().some(down);
}

/**
 * Surface: `troops` from the Depths transfer down the open Shaft nearest the tile (done once all are below); without
 * one the request is acked and waits while a Shaft goes up (`shafts`: this seat builds Shafts; the Depths dig to a
 * sealed one), failing only if it would expire first. From anyone else troopers fight-move to the tile; `flak` moves
 * under the tile and holds. `defend` reads as one of them (`asked`). Ordinary requests use only uncommitted units;
 * explicit defence may interrupt `reserved` local jobs. `army` loses the newly committed units.
 */
export function answerSurface(desk: SignalDesk, c: Ctx, out: AgentCommandIntent[], army: Entity[], shafts: boolean, reserved: ReadonlySet<string>): void {
  const budget = desk.budget;
  const recruit = (entry: SupportRequest, kind: 'trooper' | 'flak', at: Pt): Entity[] => {
    const pool = army.filter((u) => u.kind === kind && (entry.need === 'defend' || !reserved.has(u.id)));
    // Local jobs already stay on the Surface; do not count their protection as a second reserve.
    const n = share(budget, entry, army.length, pool.length);
    if (n < 1) { pool.length = 0; return pool; }
    return nearest(c, pool, at, n);
  };
  /** Send troopers down for a waiting `troops` task once a Shaft is open and troopers are spare. */
  const sendDown = (task: SignalTask): void => {
    const shaft = portal(c, tileCentre(task.entry) ?? c.home);
    if (!shaft) return;
    const squad = recruit(task.entry, 'trooper', shaft);
    if (!squad.length) return;
    out.push({ kind: 'transfer', units: ids(squad), to: 'depths', x: shaft.x, y: shaft.y });
    desk.commit(task, squad, shaft);
    remove(army, squad);
  };
  for (const task of desk.work()) {
    const units = alive(c, task);
    if (task.entry.need === 'capture') {
      const post = c.posts.find((p) => p.id === task.target);
      if (!post || !units.length) desk.fail(task);
      else if (post.side === c.army) desk.done(task, true);
      else if (desk.late(task)) desk.fail(task);
      continue;
    }
    const want = asked(task.entry);
    if (want.need === 'troops' && want.from === 'depths') {
      if (task.units.length === 0) {
        sendDown(task);
        if (task.units.length === 0 && desk.late(task)) desk.fail(task);
      } else if (!units.length) desk.fail(task);
      else if (units.every((e) => e.plane === 'depths')) desk.done(task, false);
      else if (desk.late(task) || !c.shafts().length) desk.fail(task);
    } else if (!units.length) desk.fail(task);
    else if (arrived(units, task.at, want.need === 'flak' ? c.stats.flak.range : SIGNAL_ARRIVE)) {
      // Flak covers the tile from anywhere in its range (the tile may be off its ground).
      desk.done(task, true);
    } else if (desk.late(task)) desk.fail(task);
  }
  for (const e of desk.fresh()) {
    const tile = tileCentre(e);
    const want = asked(e);
    if (!desk.room() || (want.need !== 'troops' && want.need !== 'flak' && want.need !== 'capture')) { desk.decline(e); continue; }
    if (e.need === 'capture') {
      // The forward post nearest the tile that is not ours yet (the Sky answers islands).
      const post = tile ? nearest(c, c.posts.filter((p) => dist(p, tile) <= SIGNAL_TARGET_REACH), tile, 1)[0] : undefined;
      if (!post || post.side === c.army) { desk.decline(e); continue; }
      const squad = recruit(e, 'trooper', post);
      if (!squad.length) { desk.decline(e); continue; }
      out.push({ kind: 'attack', units: ids(squad), target: post.id });
      desk.take(e, squad, { x: post.x, y: post.y }, post.id);
      remove(army, squad);
      continue;
    }
    if (want.need === 'troops' && want.from === 'depths') {
      // A Shaft of ours standing (the Depths dig to a sealed one), queued, or to be built by this seat.
      if (!shafts && !c.own.some((s) => s.kind === 'shaft') && !c.queued('shaft')) { desk.decline(e); continue; }
      sendDown(desk.take(e, [], null));
      continue;
    }
    if (!tile) { desk.decline(e); continue; }
    const squad = recruit(e, want.need === 'troops' ? 'trooper' : 'flak', tile);
    if (!squad.length) { desk.decline(e); continue; }
    out.push({ kind: 'move', units: ids(squad), x: tile.x, y: tile.y, mode: 'fight' });
    desk.take(e, squad, tile);
    remove(army, squad);
  }
}

/**
 * Depths: `troops` from the Surface (or a team request from it, or a `defend` of our Surface segment) come up the open Shaft nearest the tile; only idle
 * troopers our tunnels link to its landing go (`linked`: the tunnel cells reached from a cell). Committed units join
 * `busy`, so the rest of the decision leaves them alone. `collapse` requests are the Depths bot's own (sappers and
 * routes: DepthsBot.answerCollapse).
 */
export function answerDepths(desk: SignalDesk, c: Ctx, out: AgentCommandIntent[], busy: Set<string>, linked: (cell: number) => ReadonlySet<number>): void {
  for (const task of desk.work()) {
    if (task.entry.need === 'collapse') continue;
    const units = alive(c, task);
    if (!units.length) desk.fail(task);
    else if (units.every((e) => e.plane === 'surface')) desk.done(task, false);
    else if (desk.late(task) || !c.shafts().length) desk.fail(task);
  }
  const budget = desk.budget;
  const idle = c.own.filter((e) => e.plane === 'depths' && e.kind === 'trooper' && e.state === 'idle' && !busy.has(e.id) && !desk.busy(e.id));
  for (const e of desk.fresh()) {
    if (e.need === 'collapse') continue;
    // A team request from Sky or Orbit is the Surface's to answer (its troopers are already up there).
    const want = asked(e);
    const ours = want.need === 'troops' && (e.to === 'depths' || want.from === 'surface');
    const shaft = ours && desk.room() ? portal(c, tileCentre(e) ?? c.home) : undefined;
    const reach = shaft ? linked(c.frame.pointCell(shaft.x, shaft.y)) : undefined;
    const pool = reach ? idle.filter((u) => reach.has(c.frame.pointCell(u.x, u.y))) : [];
    const n = share(budget, e, idle.length, pool.length);
    if (!shaft || n < 1) { desk.decline(e); continue; }
    const squad = nearest(c, pool, shaft, n);
    out.push({ kind: 'transfer', units: ids(squad), to: 'surface', x: shaft.x, y: shaft.y });
    desk.take(e, squad, shaft);
    remove(idle, squad);
  }
  for (const u of c.own) if (u.plane === 'depths' && desk.busy(u.id)) busy.add(u.id);
}

/**
 * Sky: `air_cover` sends interceptors to screen the tile; asked by Orbit (Ascent Thrusters researched) they ascend
 * there once arrived, to cover our arrays or tugs (done once all are up). `bombers`: with sky control, idle bombers
 * attack the visible surface structure at the tile (done once it is gone from sight with a bomber over it).
 * `capture`: capture-capable interceptors take the island nearest the tile that is not ours (done once we hold it; the
 * Surface answers posts). `defend` of our Orbit segment reads as air_cover from Orbit (`asked`). `interceptors` and `bombers` lose the committed units.
 */
export function answerSky(desk: SignalDesk, c: Ctx, out: AgentCommandIntent[], interceptors: Entity[], bombers: Entity[], skyControl: boolean): void {
  const tick = c.obs.tick;
  const researched = c.obs.research.completed.includes('ascent_thrusters');
  const committed = (list: Entity[]): void => remove(list, list.filter((e) => desk.busy(e.id)));
  committed(interceptors);
  committed(bombers);
  let energy = c.obs.res.freeEnergy;
  for (const task of desk.work()) {
    const units = alive(c, task);
    if (!units.length) { desk.fail(task); continue; }
    if (task.entry.need === 'capture') {
      const island = c.obs.entities.find((i) => i.id === task.target);
      if (!island) desk.fail(task);
      else if (island.side === c.army) desk.done(task, true);
      else if (desk.late(task)) desk.fail(task);
      else {
        const idle = units.filter((u) => u.state === 'idle');
        if (idle.length) out.push({ kind: 'capture', units: ids(idle), island: island.id });
      }
      continue;
    }
    if (task.entry.need === 'bombers') {
      const target = c.foes.find((f) => f.id === task.target);
      if (target) {
        const idle = units.filter((b) => b.state === 'idle');
        if (idle.length) out.push({ kind: 'attack', units: ids(idle), target: target.id });
      } else if (task.at && units.some((b) => dist(b, task.at!) < c.statsOf(b).vision - VISION_MARGIN)) desk.done(task, false);
      else if (desk.late(task)) desk.fail(task);
      continue;
    }
    if (asked(task.entry).from !== 'orbit') {
      if (arrived(units, task.at)) desk.done(task, true);
      else if (desk.late(task)) desk.fail(task);
      continue;
    }
    if (units.every((e) => e.plane === 'orbit')) { desk.done(task, false); continue; }
    if (desk.late(task)) { desk.fail(task); continue; }
    const ready = units.filter((e) => e.plane === 'sky' && task.at && dist(e, task.at) <= SIGNAL_ARRIVE && (e.transitReady ?? 0) <= tick && !(e.transit?.until ?? 0));
    const afford = c.econ.ascentEnergy > 0 ? Math.floor(energy / c.econ.ascentEnergy) : ready.length;
    const up = ready.slice(0, afford);
    if (up.length) {
      out.push({ kind: 'ascend', units: ids(up) });
      energy -= up.length * c.econ.ascentEnergy;
    }
  }
  const budget = desk.budget;
  for (const e of desk.fresh()) {
    const tile = tileCentre(e);
    if (!tile || !desk.room()) { desk.decline(e); continue; }
    const want = asked(e);
    if (want.need === 'air_cover') {
      // Ascending: only interceptors off their ascent cooldown now.
      const up = want.from === 'orbit';
      const pool = up ? interceptors.filter((u) => (u.transitReady ?? 0) <= c.obs.tick && !(u.transit?.until ?? 0)) : interceptors;
      const n = share(budget, e, interceptors.length, pool.length);
      if (n < 1 || (up && !researched)) { desk.decline(e); continue; }
      const squad = nearest(c, pool, tile, n);
      out.push({ kind: 'move', units: ids(squad), x: tile.x, y: tile.y, mode: up ? 'move' : 'fight' });
      desk.take(e, squad, tile);
      remove(interceptors, squad);
    } else if (e.need === 'bombers') {
      const target = nearest(c, c.foes.filter((f) => f.plane === 'surface' && c.statsOf(f).speed === 0 && dist(f, tile) <= SIGNAL_TARGET_REACH), tile, 1)[0];
      const idle = bombers.filter((b) => b.state === 'idle');
      const n = Math.min(e.count ?? budget.units, budget.units, idle.length);
      if (!target || !skyControl || n < 1) { desk.decline(e); continue; }
      const squad = nearest(c, idle, tile, n);
      out.push({ kind: 'attack', units: ids(squad), target: target.id });
      desk.take(e, squad, tile, target.id);
      remove(bombers, squad);
    } else if (e.need === 'capture') {
      const island = nearest(c, c.obs.entities.filter((i) => i.kind === 'island' && dist(i, tile) <= SIGNAL_ISLAND_REACH), tile, 1)[0];
      const pool = interceptors.filter((u) => c.statsOf(u).capabilities.capture);
      const n = share(budget, e, interceptors.length, pool.length);
      if (!island || island.side === c.army || n < 1) { desk.decline(e); continue; }
      const squad = nearest(c, pool, island, n);
      out.push({ kind: 'capture', units: ids(squad), island: island.id });
      desk.take(e, squad, { x: island.x, y: island.y }, island.id);
      remove(interceptors, squad);
    } else desk.decline(e);
  }
}

/**
 * Orbit: `scan` scans the tile when the scan is ready (acked meanwhile; failed if it would expire first); `escort`
 * sends Bastions (else Lancers) to the tile and holds it; `drop` (asteroid drops allowed, a tug of ours up) is acked
 * and the Orbit bot's next towed rock in reach deorbits onto the tile (done there; failed if it would expire first).
 * `fleets` (Bastions, then Lancers) lose the committed ships. Returns whether this decision's scan went to a request.
 */
export function answerOrbit(desk: SignalDesk, c: Ctx, out: AgentCommandIntent[], fleets: Entity[][]): boolean {
  const tick = c.obs.tick;
  for (const list of fleets) remove(list, list.filter((e) => desk.busy(e.id)));
  let scan = c.segmentAlive('orbit') && c.obs.res.scanReadyAt <= tick && c.obs.res.freeEnergy >= c.econ.scanCost;
  let scanned = false;
  const drops = c.obs.mandate.limits?.asteroidDrops !== false;
  const tugs = c.own.some((e) => e.plane === 'orbit' && c.statsOf(e).capabilities.tow);
  const look = (task: SignalTask): void => {
    out.push({ kind: 'scan', x: task.at!.x, y: task.at!.y });
    desk.done(task, false);
    scan = false;
    scanned = true;
  };
  for (const task of desk.work()) {
    if (task.entry.need === 'scan') {
      if (scan) look(task);
      else if (desk.late(task) || !c.segmentAlive('orbit')) desk.fail(task);
      continue;
    }
    if (task.entry.need === 'drop') {
      if (desk.late(task) || !drops || !tugs) desk.fail(task);
      continue;
    }
    const units = alive(c, task);
    if (!units.length) desk.fail(task);
    else if (arrived(units, task.at)) desk.done(task, true);
    else if (desk.late(task)) desk.fail(task);
  }
  const budget = desk.budget;
  for (const e of desk.fresh()) {
    const tile = tileCentre(e);
    if (!tile || !desk.room()) { desk.decline(e); continue; }
    if (e.need === 'scan') {
      if (!c.segmentAlive('orbit')) { desk.decline(e); continue; }
      const task = desk.take(e, [], tile);
      if (scan) look(task);
    } else if (e.need === 'drop') {
      if (!drops || !tugs || desk.work().some((w) => w.entry.need === 'drop')) desk.decline(e);
      else desk.take(e, [], tile);
    } else if (e.need === 'escort') {
      // Ships channelling a lance or an aegis keep at it.
      const free = fleets.map((list) => list.filter((s) => !s.lance && !s.aegis));
      const total = free.reduce((n, list) => n + list.length, 0);
      let n = share(budget, e, total);
      if (n < 1) { desk.decline(e); continue; }
      const squad: Entity[] = [];
      for (const list of free) {
        const pick = nearest(c, list, tile, n);
        squad.push(...pick);
        n -= pick.length;
      }
      out.push({ kind: 'move', units: ids(squad), x: tile.x, y: tile.y, mode: 'fight' });
      desk.take(e, squad, tile);
      for (const list of fleets) remove(list, squad);
    } else desk.decline(e);
  }
  return scanned;
}

// ------------------------------------------------------------------ requests

/**
 * Depths: from the push's ready tick (or with a Warden walled at its choke against enemies) ask the Surface for the
 * troopers still missing below, at the Warden nearest the troopers' cover (canceled while unanswered once enough are
 * down here); else an intruder alert (`alarm`: the nearest intruder and how many) with no trooper below asks the
 * Surface for INTRUDER_MARGIN more troopers than intruders, at it. A tremor near home beyond Orbit's own tremor scans,
 * or by our miners, with no hostile seen there asks Orbit for a scan.
 */
export function askDepths(desk: SignalDesk, c: Ctx, wardens: readonly Entity[], ready: boolean, cover: Pt | null, troopersDown: number, alarm: (Pt & { count: number }) | null): void {
  const foes = c.foes.filter((e) => e.plane === 'depths' && e.kind !== 'spire');
  const walled = wardens.filter((w) => (w.state === 'walled' || w.state === 'walling') && foes.some((f) => dist(f, w) <= WARDEN_ALERT));
  const lead = ready ? nearest(c, wardens, cover ?? c.home, 1)[0] : walled.length ? nearest(c, walled, c.foeAt, 1)[0] : undefined;
  const down = c.own.filter((e) => e.plane === 'depths' && e.kind === 'trooper').length;
  const missing = troopersDown - down;
  if (lead && missing > 0 && c.segmentAlive('surface')) desk.ask(c, 'troops', 'surface', lead, missing);
  else if (alarm && down === 0 && c.segmentAlive('surface')) desk.ask(c, 'troops', 'surface', alarm, alarm.count + INTRUDER_MARGIN);
  else if (missing <= 0) desk.withdraw('troops');
  if (!c.segmentAlive('orbit')) return;
  const diggers = c.units('digger', 'depths');
  const unknown = c.frame.order(c.obs.tremors.map((t) => ({ x: t.x + 0.5, y: t.y + 0.5 }))).find((p) => {
    const home = dist(p, c.home);
    return (home > SCAN_TREMOR_RADIUS && home <= HOME_WORKS || diggers.some((d) => dist(d, p) <= MINER_GUARD_RADIUS))
      && !foes.some((f) => dist(f, p) <= SIGNAL_SEEN_REACH);
  });
  if (unknown) desk.ask(c, 'scan', 'orbit', unknown);
}

/**
 * Surface sieging (a turret ring) or pushing on the focus's Spire: the target out of sight asks Orbit for a scan of
 * it; in sight, it asks Sky for bombers on it.
 */
export function askSurface(desk: SignalDesk, c: Ctx, attacking: boolean, siege: { id: string; x: number; y: number } | undefined): void {
  if (!attacking) return;
  const spire = c.foes.find((e) => e.kind === 'spire' && e.plane === 'surface' && e.side === c.focus.id);
  const target: Pt = siege ?? spire ?? c.foeAt;
  const seen = siege ? c.foes.some((e) => e.id === siege.id) : !!spire;
  if (!seen && c.segmentAlive('orbit')) desk.ask(c, 'scan', 'orbit', target);
  else if (seen && c.segmentAlive('sky')) desk.ask(c, 'bombers', 'sky', target);
}

/**
 * Surface: a hostile island structure (Relay, Aerie, Storm Seeder, Stormcatcher: flak and turrets leave them alone
 * unless rules.sky.groundHitsIslandStructures) within HOME_WORKS of our Spire asks the Sky to capture its island.
 */
export function askCapture(desk: SignalDesk, c: Ctx): void {
  if (!c.segmentAlive('sky')) return;
  const built = c.foes.filter((e) => isIslandStructure(e.kind) && dist(e, c.home) <= HOME_WORKS);
  const near = nearest(c, built, c.home, 1)[0];
  if (near) desk.ask(c, 'capture', 'sky', near);
}

/**
 * Sky: heavy hostile air (SIGNAL_AIR_HEAVY aircraft) or a hostile drop near a held island (first in our frame's
 * order) asks the Surface for flak under it.
 */
export function askSky(desk: SignalDesk, c: Ctx, held: readonly Entity[]): void {
  if (!c.segmentAlive('surface')) return;
  const air = c.foes.filter((e) => e.plane === 'sky' && c.statsOf(e).speed > 0);
  const drops = c.obs.impacts.filter((i) => c.hostile(i.side));
  const island = held.find((i) => air.filter((e) => dist(e, i) <= SIGNAL_ISLAND_REACH).length >= SIGNAL_AIR_HEAVY
    || drops.some((d) => dist(d, i) <= SIGNAL_ISLAND_REACH));
  if (island) desk.ask(c, 'flak', 'surface', island);
}

/**
 * Orbit raided: armed hostile ships (ascended interceptors too) near our arrays or tugs ask Sky for air cover at the
 * nearest raider, once Ascent Thrusters let interceptors come up.
 */
export function askOrbit(desk: SignalDesk, c: Ctx): void {
  if (!c.obs.research.completed.includes('ascent_thrusters') || !c.segmentAlive('sky')) return;
  const raiders = c.foes.filter((e) => e.plane === 'orbit' && e.kind !== 'spire' && c.statsOf(e).dmg > 0);
  if (!raiders.length) return;
  for (const asset of c.frame.order(c.own.filter((e) => e.plane === 'orbit' && (e.kind === 'solar' || c.statsOf(e).capabilities.tow)))) {
    const raider = nearest(c, raiders.filter((r) => dist(r, asset) <= SIGNAL_RAID_RADIUS), asset, 1)[0];
    if (raider) {
      desk.ask(c, 'air_cover', 'sky', raider, RAID_INTERCEPTORS);
      return;
    }
  }
}
