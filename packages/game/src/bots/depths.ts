/** The Depths seat's built-in bot: diggers, caches, rail, backfill, faults, gates, wall repairs, lode crews, the Mother Lode, research and sapper waves. */
import { footprintDistance, ORDER_QUEUE, STATS } from '../rules/stats.ts';
import { CELL, HOLE_KINDS, isLava, isOpenCell, isOreCell, lavaBridgeable, VISION_BITS_PER_WORD } from '../rules/terrain.ts';
import { seatSpendable } from '../rules/economy.ts';
import { isUnitKind } from '../rules/vocabulary.ts';
import type { ArmyId, Entity, MatchData, Rules } from '../rules/contract.ts';
import type { AgentCommandIntent } from '../agent/intents.ts';
import { depthsCosts, searchDepths } from '../nav/nav.ts';
import { dmath } from '../util/fdlibm.js';
import { cellCentreX, cellCentreY, cellFor } from '../util/grid.ts';
import { dist } from '../util/math.ts';
import { frameDir } from '../util/teams.ts';
import { Ctx, cellDist, centroid, ids, type Pt } from './context.ts';
import { PlaneBot } from './plane-bot.ts';
import { answerDepths, askDepths, tileCentre } from './signals.ts';
import { WorkerRoutes } from './depths-workers.ts';
import { LakePlanner, type LakeRoute } from './depths-lava.ts';
import {
  BACKFILL_SPARE,
  BREACH_CLEARANCE,
  BREACH_MAX,
  BREACH_MIN,
  CAVERN_GATE_MAX,
  CAVERN_GATE_MIN,
  CHARGE_OFFSET,
  CREW_REJOIN,
  DEFUSE_CHARGES,
  DEFUSE_SQUAD,
  DEPTHS_CACHE_MARGIN,
  DEPTHS_CACHE_REACH,
  DEPTHS_FOE_MEMORY,
  DIGGERS_PER_CACHE_HAND,
  ECONOMY_HANDS,
  EXPAND_SETTLE,
  ENEMY_ORE_KEEP_OUT,
  LAKE_BRIDGE_SAVING,
  BRIDGE_FUNDS_WAIT,
  BRIDGE_JOB_MAX,
  BRIDGE_REBUILD_CALM,
  BRIDGE_GUARD_REACH,
  FAULT_END_ROOM,
  FAULT_MAX,
  FAULT_MIN,
  FRONT_OFFSET,
  GATE_RETRY,
  GREED,
  HOME_RADIUS,
  HOME_WORKS,
  IDLE_RETURN,
  LODE_CONTEST_CALM,
  LODE_SITE_REACH,
  MINER_GUARD_RADIUS,
  LODE_FLEE_MARGIN,
  MOTHER_LODE_HOME,
  MOUTH_GATE_REACH,
  ORE_HOLD_REACH,
  RAID_ODDS,
  RAIL_CHECK_EVERY,
  RAIL_GOAL_OFFSET,
  REPAIR_IDLE,
  REPAIR_RETRY,
  REPAIR_STAGE,
  REPAIR_TIMEOUT,
  REPAIRS_MAX,
  RICH_BRIDGE_DIGGERS,
  ROOT_APPROACH,
  ROOT_POCKET_DX,
  SAPPER_WAVE_GAP,
  SPARE_ALLOY,
  SQUAD_MIN,
  TAG_SETTLE,
  TUNNEL_DIGGERS,
  TROOPER_BEHIND,
  WALL_WORK_REACH,
  WARDEN_ALERT,
  WARDEN_AT,
  WARDEN_CALM,
  WARDEN_FLARE_MIN,
  WARDEN_POST_EVERY,
  WARDEN_POST_MAX,
  WARDEN_POST_MIN,
  WARDEN_RAID_PAIR,
} from './tuning.ts';

/** gatePrev entries besides a parent cell: the walk's start, and a cell the walk has not reached. */
const WALK_START = -1;
const WALK_UNVISITED = -2;
/** gateGoal entries: not a goal, a goal of the current walk, and a hole opening already cut (never walked again). */
const NOT_GOAL = 0;
const GOAL = 1;
const GOAL_DONE = 2;
/**
 * A managed worker's committed safe walk (DepthsBot.walk): the run ends `hops` from cell `from`, then `mine` near `near`
 * (-1: none). `drop`: a delivery walk (the mine delivers first), else a walk to the apron of ore `near`; with neither
 * (near -1), a shelter move with no order after it. `escape`: the first hop is a shelter the worker leaves danger for.
 * `sent` counts the orders issued so far, the moves then the mine.
 */
interface WorkerWalk { from: number; hops: number[]; drop: boolean; near: number; escape: boolean; sent: number }

export class DepthsBot extends PlaneBot {
  override init(data: MatchData): void {
    super.init(data);
    this.planGrid = new Uint8Array(this.size * this.size);
    this.planTags = new Uint8Array(this.size * this.size);
    this.gatePrev = new Int32Array(this.size * this.size);
    this.gateQueue = new Int32Array(this.size * this.size);
    this.gateWall = new Uint8Array(this.size * this.size);
    this.gateGoal = new Uint8Array(this.size * this.size);
    this.gateHole = new Uint8Array(this.size * this.size);
    this.reachSeen = new Uint32Array(this.size * this.size);
    this.reachShut = new Uint32Array(this.size * this.size);
    this.reachQueue = new Int32Array(this.size * this.size);
    this.anchorOpen = new Uint8Array(this.size * this.size);
    this.anchorKept = false;
    this.workerRoutes = new WorkerRoutes(this.size);
    this.lakes = new LakePlanner(this.size);
  }

  private planGrid!: Uint8Array;
  private planTags!: Uint8Array;
  /**
   * reach's workspace: each walk's stamp marks the cells it reached and the cells it may not enter; its BFS queue holds
   * each cell at most once (stamped before it is queued), so one cell-sized buffer serves every walk.
   */
  private reachSeen!: Uint32Array;
  private reachShut!: Uint32Array;
  private reachQueue!: Int32Array;
  private reachStamp = 0;
  /** Only normal tags we added to empty cells; teammates' existing/urgent tags are never ours to clear. */
  private readonly ownTags = new Set<number>();
  private readonly wantedTags = new Set<number>();
  /** Own tags → the last tick a plan wanted them (TAG_SETTLE). */
  private readonly tagWantedAt = new Map<number, number>();
  private planRules: Rules | null = null;
  private planCosts: Float64Array = new Float64Array(0);
  private planCount = 0;
  private sapperWaveAt = 0;
  /** sappers the collapse requests we work on want stacked (production reads it next decision) */
  private collapseSappers = 0;
  /** the digger laying rail along the cavern, and when to re-check it */
  private railer = '';
  private railCheckAt = 0;
  private railed = false;
  private backfiller = '';
  /** the fault cell to open on the focus's half (-1: none chosen yet), the army it was chosen against, and whether it is done */
  private fault = -1;
  private faultDone = false;
  private faultFoe: ArmyId | undefined;
  /** tick since troopers have been standing idle down here */
  private idleSince = 0;
  /** lode crew: digger id → outcrop cell of the opened pocket it mines */
  private lodeCrew = new Map<string, number>();
  /** Mother Lode crew: digger id → the lode cell it was sent to; and the known lode cells, gathered each decision */
  private motherCrew = new Map<string, number>();
  private motherCells: number[] = [];
  /** Own Depths units running from the Mother Lode's blast while its fuse burns (fleeLode), kept out of other jobs. */
  private readonly fleeing = new Set<string>();
  /** fault cells near home to fortify (chosen once), and the digger on it */
  private guards: number[] | null = null;
  private guarder = '';
  /** bulkhead sites asked for (cell → tick: not asked again before then) */
  private gateAsked = new Map<number, number>();
  /** gate planning scratch: walk parents (WALK_START, WALK_UNVISITED) and queue, cells the walk may not enter, its goals, holes */
  private gatePrev!: Int32Array;
  private gateQueue!: Int32Array;
  private gateWall!: Uint8Array;
  private gateGoal!: Uint8Array;
  private gateHole!: Uint8Array;
  /**
   * Gate walks left this decision (tier.gateWalks), whether a walk was refused, and the goal the next decision's cut
   * planning starts with (its index in gates' goal order).
   */
  private gateWalksLeft = 0;
  private gateStarved = false;
  private gateFirst = 0;
  /** gateAnchor's kept cavern anchor: whether there is one, the cell (-1: none), and the open cells and root state it was found on. */
  private anchorKept = false;
  private anchorAt = -1;
  private anchorAlive = false;
  private anchorOpen!: Uint8Array;
  /** walls being repaired (cell → digger id and tick asked) */
  private repairs = new Map<number, { id: string; at: number }>();
  /** Warden choke on the cavern route (-1: none), the route root → centre, when to re-plan it, and each Warden's last threat tick */
  private post = -1;
  private route: number[] = [];
  private postPlanAt = 0;
  private threatAt = new Map<string, number>();
  /** the Warden push is on (troopersDown troopers were below; it stops once none is left) */
  private pushing = false;
  private workerRoutes!: WorkerRoutes;
  private lakes!: LakePlanner;
  /** Green rich-ore crew: digger → the rich cell it mines. */
  private readonly richCrew = new Map<string, number>();
  /**
   * Diggers bridging a lake cell: digger → the cell, kept until the cell is no longer lake, the digger stops (one that
   * arrived unpaid waits, bridgeWaitAt) or it took other work (BRIDGE_JOB_MAX after bridgeSent).
   */
  private readonly bridgers = new Map<string, number>();
  /** Bridgers → the tick they were sent (BRIDGE_JOB_MAX). */
  private readonly bridgeSent = new Map<string, number>();
  /** Our standing lava bridges by id: one gone from our entities fell (BRIDGE_REBUILD_CALM). */
  private readonly ownBridges = new Set<string>();
  /** No bridge is planned before this tick: one of ours fell (BRIDGE_REBUILD_CALM). */
  private bridgeCalmUntil = 0;
  /** Walls whose fortify (wall repair or fault guard) was refused when the digger stood beside them → the tick (REPAIR_RETRY). */
  private readonly repairRefused = new Map<number, number>();
  /** Bridgers that arrived unpaid → the tick they began waiting at the shore for funds (BRIDGE_FUNDS_WAIT). */
  private readonly bridgeWaitAt = new Map<string, number>();
  /** Own lava bridges an armed hostile was last seen near (bridge → tick), guarded until WARDEN_CALM after that. */
  private readonly bridgeThreats = new Map<string, number>();
  /** Wardens on bridge guard, held (stance hold) so their own fire never drags them off the shore before they wall. */
  private readonly bridgeGuards = new Set<string>();
  private readonly workerRedirect = new Set<string>();
  private readonly workerSafeMines = new Map<string, number>();
  private readonly workerCaches = new Map<string, number>();
  private readonly workerReturning = new Set<string>();
  private readonly workerWalks = new Map<string, WorkerWalk>();
  /** Diggers kept on the economy (ECONOMY_HANDS): maintenance jobs never take them. */
  private readonly economyHands = new Set<string>();
  /** Diggers a crew let go because their way there turned unsafe → the tick they may join a crew again (CREW_REJOIN). */
  private readonly crewRejoinAt = new Map<string, number>();
  /** Mother Lode cells → the tick a hostile was last seen holding or near them (LODE_CONTEST_CALM). */
  private readonly lodeHeld = new Map<number, number>();
  /** expandOre: whether it publishes a route to new ore, and the tick connected servable ore was first seen again (-1: none). */
  private expanding = false;
  private oreServedAt = -1;
  /** expandOre's exploration route toward unknown rock, root first (empty: none). */
  private exploreRoute: number[] = [];
  /** The published corridor toward the focus's Spire (empty: none) and the root it was planned from. */
  private corridor: number[] = [];
  private corridorRoot = -1;
  /** Own diggers ever fielded (ids), for the re-buy cap (tier.diggerRebuys). */
  private readonly diggersFielded = new Set<string>();
  /** Hostile Depths fighters seen → the tick last seen (holdsOwn, DEPTHS_FOE_MEMORY). */
  private readonly depthsFoes = new Map<string, number>();
  /** Last observed hostile shields; retreating out of sight does not prove a blocked route reopened. */
  private readonly shieldsSeen = new Map<string, Entity>();
  /**
   * Each planner's last route (null: none found) and lake crossing, under a work bound (tier.routeReuse), and the
   * searches left (tier.routeSearches per decision accrue, up to one decision's worth or one search; a search spends one).
   */
  private readonly routes = new Map<string, { path: number[] | null; root: number; at: number }>();
  private readonly crossings = new Map<string, { found: LakeRoute; at: number }>();
  private searchCredit = 0;
  /** Tick of the call before this decision that prepared the worker routes (tier.prepareAhead; -1: none). */
  private preparedAt = -1;

  protected override ahead(c: Ctx): void {
    this.workerRoutes.prepare(c, this.bulkheadsSeen.values(), this.shieldsSeen.values());
    this.preparedAt = c.obs.tick;
  }

  protected decide(c: Ctx): AgentCommandIntent[] {
    const out: AgentCommandIntent[] = [];
    const t = this.tier;
    const tick = c.obs.tick;
    this.searchCredit = Math.min(Math.max(1, t.routeSearches), this.searchCredit + t.routeSearches);
    const grid = c.obs.depths ?? [];
    const diggers = c.units('digger', 'depths');
    const sappers = c.units('sapper', 'depths');
    const wardens = c.units('warden', 'depths');
    const target = this.chargeCell(c);
    this.rememberShields(c);
    const reached = this.reach(c);
    this.preparePlans(c, grid);
    // Fields prepared ahead serve only the decision right after them.
    if (this.preparedAt < 0 || c.obs.tick - this.preparedAt >= t.period) this.workerRoutes.prepare(c, this.bulkheadsSeen.values(), this.shieldsSeen.values());
    this.preparedAt = -1;
    // The tunnel and sapper waves wait while the Depths does not hold its own (tier.depthsLead): its crew short, or its
    // fighters outnumbered.
    const outfought = this.outfought(c);
    const lead = t.depthsLead <= 0 || (!outfought && diggers.length >= t.diggers);
    const tunnelling = Number.isFinite(t.tunnelAt) && tick >= t.tunnelAt && lead;
    const connected = tunnelling && reached.has(target.y * this.size + target.x);
    // House rule `collapses: false` bans every undermine (strikes, faults, requested collapses).
    const collapses = c.obs.mandate.limits?.collapses !== false;
    // Strikes from below: a turret ring, Headframes and Shafts we know of, collapsed from a tunnel we reach under them,
    // else the focus's Spire once tunnelled; a wave stacks what its target's HP needs.
    const strike = collapses && t.sappers > 0 && lead ? this.strike(c, reached, connected ? target.y * this.size + target.x : -1) : null;
    const waveAt = strike ? strike.cell : -1;
    const wave = strike ? Math.max(t.sappers, strike.stack) : 0;
    const faulting = collapses && tick >= t.faultAt && !this.faultDone;
    const wantSappers = Math.max(waveAt >= 0 ? wave : faulting ? 1 : 0, this.collapseSappers);

    // Lost diggers are replaced up to tier.diggerRebuys beyond the crew; a crew below the recovery size always is.
    for (const d of diggers) this.diggersFielded.add(d.id);
    const recovery = c.match.rules.queue.recoveryWorkers;
    const rebuy = diggers.length < recovery || this.diggersFielded.size + c.queued('digger') < t.diggers + t.diggerRebuys;
    const wardensShort = wardens.length + c.queued('warden') < t.wardens;
    // Outfought below, the Wardens come before the rest of the crew: hostile Wardens raiding an unguarded crew killed
    // every digger that replaced the last.
    if (outfought && wardensShort && diggers.length >= recovery) this.produce(c, out, 'warden', 'depths');
    else if (rebuy && diggers.length + c.queued('digger') < Math.max(t.diggers, recovery)) this.produce(c, out, 'digger', 'depths');
    else if (sappers.length + c.queued('sapper') < wantSappers) this.produce(c, out, 'sapper', 'depths');
    else if (wardensShort) this.produce(c, out, 'warden', 'depths');
    // The Warden push: from wardenPushAt the troopers are asked of the Surface (a team signal, below); the Wardens advance
    // once troopersDown are down here, until none is left. Meanwhile a raid pair goes out on its own.
    const ready = wardens.length > 0 && tick >= t.wardenPushAt;
    let below = 0;
    for (const e of c.own) if (e.plane === 'depths' && e.kind === 'trooper') below++;
    if (!ready || below === 0) this.pushing = false;
    else if (below >= t.troopersDown) this.pushing = true;
    const pushing = this.pushing;
    // Research: Drill Bits once the dig crew stands, Shaped Charges once sapper waves run (tier.researchMinimum gates
    // both); one project at a time, after this decision's production and the next wanted unit.
    const wanted = { digger: t.diggers, sapper: wantSappers };
    if (!this.research(c, out, 'drill_bits', wanted, t.reserve.depths) && t.sappers > 0) this.research(c, out, 'shaped_charges', wanted, t.reserve.depths);

    // Defuse hostile charges near home: the DEFUSE_SQUAD nearest depths units stand on each charge until it is defused.
    const busy = new Set<string>();
    // Diggers at work on queued Depths structures keep their construction jobs.
    for (const q of c.obs.queue) if (q.digger && q.status === 'building') busy.add(q.digger);
    // Troopers the Surface asked for go up a Shaft (committed ones stay out of the rest of this decision).
    answerDepths(this.desk, c, out, busy, (cell) => this.reach(c, cell));
    // The Mother Lode's fuse: whatever of ours is in its blast runs home before any other job takes it.
    this.fleeLode(c, out, busy);
    // A teammate's collapse request: sappers to the tunnel under its tile (diggers dig there first).
    this.answerCollapse(c, out, sappers, busy, reached, collapses);
    if (t.defuse) {
      const fighters = c.own.filter((e) => e.plane === 'depths' && (e.kind === 'digger' || e.kind === 'trooper'));
      for (const ch of c.chargesNearHome(HOME_RADIUS).slice(0, DEFUSE_CHARGES)) {
        const spot = { x: ch.x + 0.5, y: ch.y + 0.5 };
        const squad = fighters
          .filter((e) => !busy.has(e.id))
          .sort((a, b) => dist(a, spot) - dist(b, spot))
          .slice(0, DEFUSE_SQUAD);
        for (const e of squad) busy.add(e.id);
        const late = squad.filter((e) => e.tx !== spot.x || e.ty !== spot.y);
        if (late.length) out.push({ kind: 'move', units: ids(late), x: spot.x, y: spot.y, mode: 'move' });
      }
    }

    // One unladen digger per reachable, uncontested below-cache; standing there collects automatically.
    let cacheHands = 0;
    for (const cache of c.frame.order(c.obs.oreCaches)) {
      if (cacheHands >= Math.max(1, Math.floor(diggers.length / DIGGERS_PER_CACHE_HAND))) break;
      const below = cache.below;
      if (!below || below.alloy <= 0 || !reached.has(Math.floor(below.y) * this.size + Math.floor(below.x))
        || c.foes.some((e) => e.plane === 'depths' && dist(e, below) < c.statsOf(e).range + DEPTHS_CACHE_MARGIN)) continue;
      const component = this.walkReach(c, Math.floor(below.y) * this.size + Math.floor(below.x), undefined, null);
      const hand = diggers.filter((d) => !busy.has(d.id) && d.carry === undefined && d.state !== 'laying'
        && this.reachSeen[Math.floor(d.y) * this.size + Math.floor(d.x)] === component
        && this.workerRoutes.canServe(d, Math.floor(below.y) * this.size + Math.floor(below.x), false, false)
        && (d.state === 'idle' || d.state === 'mining' || d.state === 'moving'))
        .sort((a, b) => dist(a, below) - dist(b, below))[0];
      if (!hand || dist(hand, below) > DEPTHS_CACHE_REACH) continue;
      busy.add(hand.id);
      cacheHands++;
      this.workerCaches.set(hand.id, Math.floor(below.y) * this.size + Math.floor(below.x));
      if (hand.state !== 'moving' || hand.tx !== below.x || hand.ty !== below.y) {
        out.push({ kind: 'move', units: [hand.id], x: below.x, y: below.y });
      }
    }
    // Keep ECONOMY_HANDS available hands in the economy, not indefinitely laying rail or repairing walls during recovery.
    // Construction and emergency defuse commitments above retain precedence. Hands are sticky, and a free digger fills a
    // gap before any maintenance job is released: a job released from a hand chosen afresh each decision went straight
    // back to the same digger (now outside the hands) the next, so it walked back and forth between job and ore.
    const want = Math.max(0, ECONOMY_HANDS - cacheHands);
    const holdsJob = (d: Entity): boolean => {
      if (this.railer === d.id || this.backfiller === d.id || this.guarder === d.id) return true;
      for (const job of this.repairs.values()) if (job.id === d.id) return true;
      return false;
    };
    // Already productive first, then nearest home (ties in our frame's order).
    const rank = (a: Entity, b: Entity): number =>
      Number(b.state === 'mining' || b.state === 'hauling') - Number(a.state === 'mining' || a.state === 'hauling') || dist(a, c.home) - dist(b, c.home) ||
      c.frame.cellKey(Math.floor(a.y) * this.size + Math.floor(a.x)) - c.frame.cellKey(Math.floor(b.y) * this.size + Math.floor(b.x));
    const economic = diggers.filter((d) => this.economyHands.has(d.id) && !busy.has(d.id)).sort(rank).slice(0, want);
    const fill = diggers.filter((d) => !busy.has(d.id) && !economic.includes(d))
      .sort((a, b) => Number(holdsJob(a)) - Number(holdsJob(b)) || rank(a, b)).slice(0, want - economic.length);
    for (const d of fill) {
      economic.push(d);
      let released = false;
      if (this.railer === d.id) { this.railer = ''; released = true; }
      if (this.backfiller === d.id) { this.backfiller = ''; released = true; }
      if (this.guarder === d.id) { this.guarder = ''; released = true; }
      for (const [cell, job] of this.repairs) if (job.id === d.id) { this.repairs.delete(cell); released = true; }
      if (released) out.push({ kind: 'stop', units: [d.id] });
    }
    this.economyHands.clear();
    for (const d of economic) this.economyHands.add(d.id);
    const maintenance = diggers.filter((d) => !economic.includes(d));

    // Highways: one digger walks the cavern from the root to the centre chamber laying rail (miners haul ×2.5 there).
    if (tick >= t.railAt && !this.railed && tick >= this.railCheckAt) {
      let offset = RAIL_GOAL_OFFSET;
      let goal = c.frame.cellAt(this.size / 2 - offset, this.size / 2 - offset);
      // The Mother Lode fills the centre cells: rail to the open ring around it instead.
      while (grid[goal] === CELL.lode) {
        offset++;
        goal = c.frame.cellAt(this.size / 2 - offset, this.size / 2 - offset);
      }
      const root = this.rootCell(c);
      if (grid[goal] === CELL.rail) this.railed = true;
      else {
        // A railer that is neither walking to the root nor laying (rejected, or back to mining) is replaced by the free
        // digger nearest the root.
        const layer = maintenance.find((d) => d.id === this.railer && (d.state === 'moving' || d.state === 'laying'));
        if (!layer) {
          const pick = maintenance.filter((d) => !busy.has(d.id) && d.carry === undefined).sort((a, b) => cellDist(root, this.size, a) - cellDist(root, this.size, b))[0];
          if (pick && c.obs.res.freeAlloy >= SPARE_ALLOY) {
            this.railer = pick.id;
            out.push({ kind: 'move', units: [pick.id], x: cellCentreX(root, this.size), y: cellCentreY(root, this.size), mode: 'move' });
            out.push({ kind: 'rail', units: [pick.id], x: goal % this.size, y: Math.floor(goal / this.size), queue: true });
          }
        }
        this.railCheckAt = tick + RAIL_CHECK_EVERY;
      }
    }
    if (this.railer && !this.railed) busy.add(this.railer);

    // Backfill hostile holes that cut the lanes near home (every kind rules.depths.backfillKinds allows), one cell at a time.
    const kinds = c.econ.backfillKinds;
    if (t.backfill && kinds !== 0) {
      const home = c.home;
      const cut = c.obs.holes.filter((h) => ((kinds >> HOLE_KINDS.indexOf(h.kind)) & 1) === 1 && cellDist(h.y * this.size + h.x, this.size, home) < HOME_RADIUS);
      const builder = maintenance.find((d) => d.id === this.backfiller);
      if (cut.length && (!builder || builder.state === 'idle') && c.obs.res.freeAlloy >= c.econ.bridgeCost + BACKFILL_SPARE) {
        const pick = builder ?? maintenance.filter((d) => !busy.has(d.id) && d.carry === undefined).sort((a, b) => dist(a, home) - dist(b, home))[0];
        // Nearest first; ties by cell index in our frame's order.
        const key = (h: Pt): number => c.frame.cellKey(h.y * this.size + h.x);
        const cell = cut.sort((a, b) => cellDist(a.y * this.size + a.x, this.size, home) - cellDist(b.y * this.size + b.x, this.size, home) || key(a) - key(b))[0]!;
        if (pick) {
          this.backfiller = pick.id;
          out.push({ kind: 'bridge', units: [pick.id], x: cell.x, y: cell.y });
        }
      }
      if (cut.length && this.backfiller) busy.add(this.backfiller);
    }

    // Cut the focus's lanes: dig to a fault cell on their side and open it with a sapper charge (a chasm).
    if (faulting) this.openFault(c, out, sappers, busy, reached);

    // Depths defence: fortify the faults near home, gate the chokepoints, repair walls that crack (someone digs in).
    if (t.faultGuards > 0) this.guardFaults(c, out, maintenance, busy, reached, grid);
    if (t.bulkheads > 0) this.gates(c, out, c.obs.holes.some((h) => cellDist(h.y * this.size + h.x, this.size, c.home) <= HOME_RADIUS) ? diggers : maintenance, busy, reached, grid);
    if (t.repair) this.repairWalls(c, out, maintenance, busy, reached, grid);
    // Our sealed Shafts (a landing completed in rock): tunnel to each landing, since Shafts are the only portals.
    for (const s of c.own) {
      if (s.kind !== 'shaft' || !s.sealed) continue;
      const landing = cellFor(c.frame.k, s.x, s.y, this.size);
      if (grid[landing] !== CELL.bedrock) this.designateRoute(c, out, `shaft:${landing}`, (n) => n === landing, 1);
    }
    // The cavern route and Warden post, re-planned every WARDEN_POST_EVERY before the push and raid goals are read off it.
    if (tick >= this.postPlanAt) {
      this.planPost(c, grid);
      this.postPlanAt = tick + WARDEN_POST_EVERY;
    }
    const push = connected ? target.y * this.size + target.x : this.route.at(-1) ?? -1;
    // The intruder alert (hostile Depths units in our tunnels near home, from our own vision): the holding Wardens close
    // on the nearest and wall there, idle troopers below hunt it, and with none below the Surface is asked for some.
    const alarm = c.obs.alerts.find((a) => a.plane === 'depths' && a.kind === 'intruder' && a.x !== undefined && a.y !== undefined);
    const alarmAt = alarm ? { x: alarm.x!, y: alarm.y! } : null;
    const alarmCell = alarmAt ? c.frame.pointCell(alarmAt.x, alarmAt.y) : -1;
    // Our threatened lava bridges take a Warden first; the rest hold the post, raid and answer alarms.
    const posted = t.bridgeWars ? this.guardBridges(c, out, wardens, busy, grid) : wardens;
    const cover = this.wardensAct(c, out, posted, busy, grid, pushing, push, ready && !pushing ? this.raidCell(c, reached) : -1, alarmCell);
    // The Wardens' troopers come from the Surface: ask for the ones missing at the lead Warden.
    askDepths(this.desk, c, wardens, ready, cover >= 0 ? { x: cellCentreX(cover, this.size), y: cellCentreY(cover, this.size) } : null, t.troopersDown, alarm && alarmAt ? { ...alarmAt, count: alarm.count ?? 1 } : null);
    this.geothermal(c, out, maintenance, busy, reached, grid);
    // Opened lode pockets: a crew mines there first (short hauls to our Headframe; stolen ore counts too).
    if (t.lodeMiners > 0) this.mineLodes(c, out, diggers, busy, reached, grid);
    // The Mother Lode: a crew mines it once home has its diggers (troopers guard miners there like anywhere).
    if (t.motherCrew > 0) this.mineMotherLode(c, out, diggers, busy, reached);
    // Green rich ore and lava lakes: a crew on servable rich cells, bridges and digs toward the others (and toward the
    // focus when a bridge saves the long way round), and the bridge fights.
    this.lavaWork(c, out, diggers, busy, reached, grid, tunnelling && !connected ? target.y * this.size + target.x : -1);
    this.expandOre(c, out, reached, grid);

    // Publish the whole corridor, not orders tied to a few digger IDs. Default workers take the frontier;
    // explicit lode mining and tactical orders remain in charge of their own crews. The corridor stays as published
    // while it is still passable from the same root to the same goal: re-planned every decision, equal-cost
    // alternatives swapped as cells were dug and revealed, and its designation workers went from one to the other.
    if (tunnelling && !connected && diggers.length >= TUNNEL_DIGGERS) {
      const goal = target.y * this.size + target.x, root = this.routeRoot(c);
      // A corridor that no longer holds waits unpublished while the decision has no search left (tier.routeSearches).
      let holds = true;
      if (this.corridor.at(-1) !== goal || this.corridorRoot !== root || !this.corridor.every((n) => this.planCosts[this.planGrid[n]!]! >= 0)) {
        const route = this.planRoute(c, 'corridor', (n) => n === goal, false);
        if (route === undefined) holds = false;
        else {
          this.corridor = route ?? [];
          this.corridorRoot = root;
        }
      }
      if (holds && this.corridor.length) this.tagPath(c, out, this.corridor, 1);
    }
    if (diggers.some((d) => d.state === 'idle' && !busy.has(d.id))) out.push({ kind: 'macro', action: 'auto_mine' });
    this.recoverWorkers(c, out, diggers, busy);

    // Sapper waves: all at once so the hostile root cannot kill them one by one, stacked as the target needs.
    if (waveAt >= 0 && sappers.length >= wave && tick >= this.sapperWaveAt) {
      const ready = sappers.filter((s) => s.state === 'idle' && !busy.has(s.id));
      if (ready.length >= wave) {
        out.push({ kind: 'undermine', units: ids(ready), x: waveAt % this.size, y: Math.floor(waveAt / this.size) });
        this.sapperWaveAt = tick + SAPPER_WAVE_GAP * c.econ.undermineTicks;
      }
    }

    // Troopers down here hunt intruders near home or near our miners; a squad the surface sent down breaches near the
    // focus's base (it does not chase hostile units across the map); else back up.
    const troopers = c.own.filter((e) => e.plane === 'depths' && e.kind === 'trooper' && !busy.has(e.id) && e.state !== 'breaching');
    const home = c.home;
    const intruders = c.foes.filter((e) => e.plane === 'depths' && e.kind !== 'spire' && (dist(e, home) < HOME_RADIUS || diggers.some((d) => dist(d, e) < MINER_GUARD_RADIUS)));
    let idle = troopers.filter((e) => e.state === 'idle');
    if (idle.length === 0) this.idleSince = tick;
    // A hostile economy seen (almost) without fighters down here: hunt its diggers wherever they were last seen.
    const prey = t.raid && c.depthsFighters().length < Math.max(1, Math.ceil(RAID_ODDS * (1 + t.aggressionShift))) && this.greed(c) >= Math.max(1, Math.round(GREED * (1 - t.aggressionShift))) ? [...this.diggersSeen.values()] : [];
    // Hunt only through reachable known tunnels: hostile shields block; own and allied shields admit traffic.
    const walls = new Set<number>();
    for (const e of c.foes) {
      if (e.plane === 'depths' && e.kind === 'warden' && (e.state === 'walling' || e.state === 'walled' || e.state === 'unwalling')) walls.add(Math.floor(e.y) * this.size + Math.floor(e.x));
    }
    const hunt = (target: Pt): void => {
      const linked = this.walkReach(c, Math.floor(target.y) * this.size + Math.floor(target.x), walls, null);
      const hunters = idle.filter((e) => this.reachSeen[Math.floor(e.y) * this.size + Math.floor(e.x)] === linked);
      if (hunters.length) out.push({ kind: 'move', units: ids(hunters), x: target.x, y: target.y, mode: 'fight' });
      idle = idle.filter((e) => !hunters.includes(e));
    };
    if (alarmAt && idle.length) hunt(alarmAt);
    if (troopers.length && intruders.length) {
      if (idle.length) hunt(intruders.reduce((b, e) => (dist(e, home) < dist(b, home) ? e : b)));
    } else if (idle.length && prey.length) {
      const at = centroid(idle);
      hunt(prey.reduce((b, e) => (e.tick > b.tick || (e.tick === b.tick && dist(e, at) < dist(b, at)) ? e : b)));
    }
    // Crowns: the focus's Depths root is its weakest crown (Ctx.crown): a squad our tunnels link to a known cell beside it
    // takes it (attacks it once seen); with no such cell yet, tag a route there. The rest breach below as usual.
    if (c.crown === 'depths' && idle.length >= SQUAD_MIN) {
      const foe = c.foeAt;
      const beside = (n: number): boolean => {
        const d = footprintDistance('spire', foe.x, foe.y, cellCentreX(n, this.size), cellCentreY(n, this.size));
        return d > 0 && d <= ROOT_APPROACH;
      };
      let gate = -1;
      for (const n of walls.size ? this.reach(c, undefined, walls) : reached) if (beside(n) && (gate < 0 || c.frame.cellKey(n) < c.frame.cellKey(gate))) gate = n;
      if (gate < 0) this.designateRoute(c, out, 'crown', beside, 2);
      else {
        const linked = this.walkReach(c, gate, walls, null);
        const squad = idle.filter((e) => this.reachSeen[Math.floor(e.y) * this.size + Math.floor(e.x)] === linked);
        const root = c.foes.find((e) => e.kind === 'spire' && e.plane === 'depths' && e.side === c.focus.id);
        if (squad.length >= SQUAD_MIN) {
          out.push(root ? { kind: 'attack', units: ids(squad), target: root.id }
            : { kind: 'move', units: ids(squad), x: cellCentreX(gate, this.size), y: cellCentreY(gate, this.size), mode: 'fight' });
          idle = idle.filter((e) => !squad.includes(e));
        }
      }
    }
    // Breach raids (from breachFrom): the approach under the focus's base stays tagged until our tunnels reach a breach
    // site, so the diggers have it dug when a squad comes down; tagged only while a squad waited below (IDLE_RETURN at
    // most) it went stale long before a breach tier without its own tunnel to the focus reached one. A squad the Surface
    // sent down (SQUAD_MIN+ idle troopers at once whose tunnels reach the site) digs up before the Wardens' cover below
    // takes its troopers: the cover fills one trooper at a time from the requests the Surface answers, so a whole squad
    // idle here at once is a breach raid. A crown squad (above) goes first.
    const breaching = Number.isFinite(t.breachEvery) && tick >= t.breachFrom;
    const site = breaching ? this.breachCell(c, walls.size ? this.reach(c, undefined, walls) : reached) : -1;
    if (breaching && site < 0) {
      const foe = c.foeAt;
      this.designateRoute(c, out, 'breach', (n) => {
        const d = cellDist(n, this.size, foe);
        return d >= BREACH_MIN && d <= BREACH_MAX && c.walkable(n);
      }, 2);
    }
    if (site >= 0 && idle.length >= SQUAD_MIN && c.chargesNearHome(HOME_RADIUS).length === 0) {
      const linked = this.walkReach(c, site, walls, null);
      const squad = idle.filter((e) => this.reachSeen[Math.floor(e.y) * this.size + Math.floor(e.x)] === linked);
      if (squad.length >= SQUAD_MIN) {
        out.push({ kind: 'breach', units: ids(squad), x: site % this.size, y: Math.floor(site / this.size) });
        idle = idle.filter((e) => !squad.includes(e));
      }
    }
    // Ready to push: troopersDown troopers stand in the Wardens' cover (the nearest idle ones our tunnels link to it fill
    // free places; they wait there until enough are down).
    if (idle.length && ready && cover >= 0) {
      const spot = { x: cellCentreX(cover, this.size), y: cellCentreY(cover, this.size) };
      const holds = (e: Entity): boolean => dist(e, spot) <= WARDEN_AT || (e.tx === spot.x && e.ty === spot.y);
      const places = Math.max(0, t.troopersDown - troopers.filter(holds).length);
      const cellOf = (e: Pt): number => Math.floor(e.y) * this.size + Math.floor(e.x);
      const linked = this.walkReach(c, cover, walls, null);
      const late = idle.filter((e) => !holds(e) && this.reachSeen[cellOf(e)] === linked)
        .sort((a, b) => dist(a, spot) - dist(b, spot) || c.frame.cellKey(cellOf(a)) - c.frame.cellKey(cellOf(b)))
        .slice(0, places);
      if (late.length) out.push({ kind: 'move', units: ids(late), x: spot.x, y: spot.y, mode: 'fight' });
      idle = idle.filter((e) => !holds(e) && !late.includes(e));
    }
    // Idle troopers without a breach (no site yet, or stranded off its tunnels) go back up after IDLE_RETURN.
    if (idle.length && c.chargesNearHome(HOME_RADIUS).length === 0 && c.shafts().length && (!Number.isFinite(t.breachEvery) || tick - this.idleSince > IDLE_RETURN)) {
      out.push({ kind: 'transfer', units: ids(idle), to: 'surface' });
    }
    this.clearStaleTags(c, out);
    this.escapeMagma(c, out);
    return out;
  }

  /** Emergency movement wins over mining, combat, construction and deployed stances, using observed terrain only. */
  private escapeMagma(c: Ctx, out: AgentCommandIntent[]): void {
    const grid = c.obs.depths ?? [];
    for (const e of c.own) {
      if (e.plane !== 'depths' || c.statsOf(e).speed <= 0) continue;
      const here = c.frame.pointCell(e.x, e.y);
      if (!isLava(grid[here]!)) continue;
      let next = this.workerRoutes.escapeNext[here]!;
      if (next < 0) continue; // no known exit; never invent a route through hidden rock or a shield
      while (this.workerRoutes.escapeNext[next] !== next) next = this.workerRoutes.escapeNext[next]!;
      for (let j = out.length - 1; j >= 0; j--) {
        const intent = out[j]!;
        if ('units' in intent) {
          intent.units = intent.units.filter((id) => id !== e.id);
          if (!intent.units.length) out.splice(j, 1);
        } else if (('unit' in intent && intent.unit === e.id) || (intent.kind === 'queue_add' && intent.digger === e.id)) out.splice(j, 1);
      }
      if (e.state === 'walled' || e.state === 'walling') out.push({ kind: 'deploy', units: [e.id], on: false });
      else if (e.state !== 'unwalling') {
        const x = cellCentreX(next, this.size), y = cellCentreY(next, this.size);
        if (e.state !== 'moving' || e.tx !== x || e.ty !== y) out.push({ kind: 'move', units: [e.id], x, y, mode: 'move' });
      }
    }
  }

  /** Re-home unsafe crews onto productive ordinary ore without replacing construction or tactical orders. */
  private recoverWorkers(c: Ctx, out: AgentCommandIntent[], diggers: Entity[], busy: Set<string>): void {
    for (const id of this.workerRedirect) if (!diggers.some((d) => d.id === id)) this.workerRedirect.delete(id);
    for (const id of this.workerSafeMines.keys()) if (!diggers.some((d) => d.id === id)) this.workerSafeMines.delete(id);
    for (const id of this.workerCaches.keys()) if (!diggers.some((d) => d.id === id)) this.workerCaches.delete(id);
    for (const id of this.workerReturning) if (!diggers.some((d) => d.id === id)) this.workerReturning.delete(id);
    for (const id of this.workerWalks.keys()) if (!diggers.some((d) => d.id === id)) this.workerWalks.delete(id);
    for (const [id, at] of this.crewRejoinAt) if (at <= c.obs.tick || !diggers.some((d) => d.id === id)) this.crewRejoinAt.delete(id);
    const grid = c.obs.depths ?? [], routes = this.workerRoutes;
    for (const d of diggers) {
      if (busy.has(d.id)) {
        if (!d.carry) this.workerReturning.delete(d.id);
        this.workerWalks.delete(d.id);
        continue;
      }
      const managed = this.workerSafeMines.get(d.id);
      // Only observed weapons and remembered shields justify bot-steered work: without them the simulation's own
      // hauling and auto-mine are safe and faster. Hand the worker back, its ore kept as the mine preference.
      if (!routes.threats && (managed !== undefined || this.workerRedirect.has(d.id) || this.workerReturning.has(d.id))) {
        this.workerSafeMines.delete(d.id);
        this.workerRedirect.delete(d.id);
        this.workerReturning.delete(d.id);
        this.workerWalks.delete(d.id);
        if (d.state === 'mining' || d.state === 'hauling' || d.state === 'idle') continue; // idle: this decision's auto_mine
        if (managed !== undefined && isOreCell(grid[managed]!)) out.push({ kind: 'mine', units: [d.id], x: cellCentreX(managed, this.size), y: cellCentreY(managed, this.size) });
        else out.push({ kind: 'mine', units: [d.id] });
        continue;
      }
      if (d.state === 'hauling' && !this.workerReturning.has(d.id) && !this.workerRedirect.has(d.id) && managed === undefined) continue;
      const here = c.frame.pointCell(d.x, d.y), drop = routes.dropNext[here]!;
      // Delivered: the next job is chosen in this decision. Stopping here left the worker idle until the next one, and
      // the simulation hands an idle digger to designation work, often straight back toward the danger it went round.
      if (this.workerReturning.has(d.id) && !d.carry) {
        this.workerReturning.delete(d.id);
        this.workerRedirect.add(d.id);
      }
      const cache = this.workerCaches.get(d.id);
      if (cache !== undefined && !routes.canServe(d, cache, false, false)) {
        if ((d.tx !== undefined && Math.floor(d.ty!) * this.size + Math.floor(d.tx) === cache) ||
          Math.floor(d.y) * this.size + Math.floor(d.x) === cache) this.workerRedirect.add(d.id);
        this.workerCaches.delete(d.id);
      }
      if (d.work && d.state === 'mining' && !routes.canServe(d, Math.floor(d.work.y) * this.size + Math.floor(d.work.x))) this.workerRedirect.add(d.id);
      // A worker walking to its ore judges it from the walk's end, the apron: its own cell turning dangerous is no reason
      // to give the ore up while the walk ahead holds (walk below). Still more than ORE_HOLD_REACH from that end, danger
      // there (or cutting the way beyond that reach) is judged again as it nears, not at once.
      const walking = this.workerWalks.get(d.id);
      const toOre = !!walking && !walking.drop && walking.near === managed;
      const apron = toOre ? walking.hops.at(-1) ?? walking.from : here, next = toOre ? walking.sent - 1 - (d.queue ?? 0) : 0;
      const distant = toOre && d.state === 'moving' && routes.left(d, walking.from, walking.hops, next) > ORE_HOLD_REACH
        && routes.holds(d, walking.from, walking.hops, next, false, false);
      if (managed !== undefined && (!isOreCell(grid[managed]!) || (!distant && !routes.canServeFrom(apron, managed)))) {
        this.workerSafeMines.delete(d.id);
        this.workerRedirect.add(d.id);
      }
      // While threats last, a managed load goes home along known-safe runs, never the simulation's shortest haul.
      if (this.workerSafeMines.has(d.id) && d.state === 'hauling' && d.carry) this.workerRedirect.add(d.id);
      if (d.carry && (d.state === 'idle' || this.workerRedirect.has(d.id) || this.workerReturning.has(d.id))) {
        this.workerRedirect.add(d.id);
        // Deliver along known-safe runs (standing in danger: out to the nearest shelter first, on from there), then make
        // for the retained ore; the next decision walks it the rest of the way safely.
        const shelter = routes.shelter[here]!, escape = drop < 0 && shelter >= 0;
        if ((drop >= 0 || escape) && this.walk(out, d, here, true, this.workerSafeMines.get(d.id) ?? -1, escape, () => {
          if (!escape) return routes.dropRuns(here);
          const on = routes.dropRuns(shelter);
          return on && [shelter, ...on];
        })) {
          this.workerReturning.add(d.id);
          continue;
        }
      }
      // While threats last, retain the selected ore through the delivery trip and re-evaluate its actual terrain,
      // service and danger instead of toggling auto-mine.
      if (d.state === 'idle' && (this.workerSafeMines.has(d.id) || routes.threats)) this.workerRedirect.add(d.id);
      if (this.workerSafeMines.has(d.id) && !this.workerRedirect.has(d.id) && d.state === 'mining') {
        this.workerWalks.delete(d.id); // at work: the walk is over
        continue;
      }
      if (!this.workerRedirect.has(d.id) && !this.workerSafeMines.has(d.id)) continue;
      const retained = this.workerSafeMines.get(d.id) ?? -1;
      let best = retained >= 0 && this.walk(out, d, here, false, retained, false, () => routes.oreRuns(here, retained, c.econ.mineNear)) ? retained : -1;
      if (best < 0) {
        // Nearest servable ore first (ties in our frame's order); stop searching at the first with a safe apron route.
        const ores: number[] = [];
        for (let n = 0; n < grid.length; n++) if (isOreCell(grid[n]!) && this.planGrid[n] !== CELL.bedrock && routes.canServe(d, n)) ores.push(n);
        ores.sort((a, b) => cellDist(a, this.size, d) - cellDist(b, this.size, d) || c.frame.cellKey(a) - c.frame.cellKey(b));
        best = ores.find((n) => this.walk(out, d, here, false, n, false, () => routes.oreRuns(here, n, c.econ.mineNear))) ?? -1;
      }
      if (best >= 0) {
        this.workerRedirect.delete(d.id);
        this.workerSafeMines.set(d.id, best);
      } else if (this.workerRedirect.has(d.id)) {
        const shelter = routes.shelter[here]!;
        if (shelter >= 0 && shelter !== here) {
          // Sent once: near a crowded shelter the simulation moves the waypoint aside to a free slot, which is no reason
          // to send it again; something else having the worker is. From the shelter it goes on to dig the nearest
          // frontier it can serve there, or with none walks on home along known-safe runs: idle at the shelter, the
          // simulation's designation work took it straight back into the danger, and the next decision sent it out again.
          const walk = this.workerWalks.get(d.id);
          if (!walk || walk.drop || walk.near >= 0 || walk.hops[0] !== shelter || d.state !== 'moving' || d.tx === undefined) {
            out.push({ kind: 'move', units: [d.id], x: cellCentreX(shelter, this.size), y: cellCentreY(shelter, this.size) });
            const frontier = d.carry || routes.dropNext[shelter]! < 0 ? -1
              : this.frontierFrom(c, shelter, { x: cellCentreX(shelter, this.size), y: cellCentreY(shelter, this.size) }, grid);
            if (frontier >= 0) {
              // The dig is its job from here, like a frontier dig below.
              out.push({ kind: 'dig', units: [d.id], x: frontier % this.size, y: Math.floor(frontier / this.size), queue: true });
              this.workerWalks.delete(d.id);
              this.workerRedirect.delete(d.id);
              this.workerSafeMines.delete(d.id);
            } else {
              const home = (routes.dropRuns(shelter) ?? []).slice(0, ORDER_QUEUE);
              for (const n of home) out.push({ kind: 'move', units: [d.id], x: cellCentreX(n, this.size), y: cellCentreY(n, this.size), queue: true });
              this.workerWalks.set(d.id, { from: here, hops: [shelter, ...home], drop: false, near: -1, escape: true, sent: 1 + home.length });
            }
          }
        } else {
          const walk = this.workerWalks.get(d.id);
          const frontier = this.frontierFrom(c, here, d, grid);
          if (!d.carry && drop >= 0 && frontier >= 0) {
            this.workerWalks.delete(d.id);
            out.push({ kind: 'dig', units: [d.id], x: frontier % this.size, y: Math.floor(frontier / this.size) });
            this.workerRedirect.delete(d.id);
            this.workerSafeMines.delete(d.id);
          } else if (walk?.escape && !walk.drop && walk.near < 0 && d.state === 'moving' && d.tx !== undefined) {
            // Out of danger on its way home from a shelter: let it walk on (stopped here, designation work took it back).
          } else if (!d.carry && !routes.threats) {
            this.workerWalks.delete(d.id);
            this.workerRedirect.delete(d.id); // nothing to avoid: auto-mine digs or explores
          } else {
            this.workerWalks.delete(d.id);
            if (d.state !== 'idle' || out.some((i) => i.kind === 'macro' && i.action === 'auto_mine')) out.push({ kind: 'stop', units: [d.id] });
          }
        }
      }
    }
  }

  /** Whether unit `e` stands on a 4-neighbour of cell `cell` (where a digger works it from). */
  private beside(c: Ctx, e: Pt, cell: number): boolean {
    const at = c.frame.pointCell(e.x, e.y);
    return Math.abs(at % this.size - cell % this.size) + Math.abs(Math.floor(at / this.size) - Math.floor(cell / this.size)) === 1;
  }

  /**
   * The nearest of our wanted tags still to dig that a worker on cell `from` (at point `at`) can serve, ties in our
   * frame's order (-1: none); the first in tag order flipped between distant routes as their tags were dug and added.
   */
  private frontierFrom(c: Ctx, from: number, at: Pt, grid: readonly number[]): number {
    let frontier = -1;
    for (const cell of this.ownTags) {
      if (!this.wantedTags.has(cell) || !this.planTags[cell] || isOpenCell(grid[cell]!) || !this.workerRoutes.canServeFrom(from, cell)) continue;
      const nearer = frontier < 0 ? -1 : cellDist(cell, this.size, at) - cellDist(frontier, this.size, at);
      if (frontier < 0 || nearer < 0 || (nearer === 0 && c.frame.cellKey(cell) < c.frame.cellKey(frontier))) frontier = cell;
    }
    return frontier;
  }

  /**
   * Walk a managed worker safely to a dropoff (`drop`: then `mine` delivers, and heads for ore `near` when ≥ 0) or to
   * the apron of ore `near` (then mines it): the run ends of `plan` as one move and queued moves, so it never stands idle
   * between runs (the simulation hands an idle digger to designation work, away from the route). An `escape` walk first
   * leaves danger for a shelter. A walk is committed: while the worker still walks it, or works the mine it ends in, and
   * the walk still holds against the danger observed now (WorkerRoutes.holds, a little looser than the plan), it is never
   * re-sent, only topped up as the order queue frees, so a crowded apron, a moved waypoint, the simulation choosing
   * nearby ore or an envelope shifting a cell cannot turn the worker round. False: no safe walk.
   */
  private walk(out: AgentCommandIntent[], d: Entity, here: number, drop: boolean, near: number, escape: boolean, plan: () => number[] | null): boolean {
    let walk = this.workerWalks.get(d.id);
    const queued = d.queue ?? 0;
    // Idle with no order left: the walk ended, or its mine found nothing. `sent - 1 - queued` is the order in progress.
    // A delivery walk's ore preference is no reason to re-send it.
    if (!walk || walk.drop !== drop || (!drop && walk.near !== near) || (d.state === 'idle' && d.tx === undefined && !queued)
      || !this.workerRoutes.holds(d, walk.from, walk.hops, walk.sent - 1 - queued, walk.drop, walk.escape)) {
      const hops = plan();
      if (!hops) return false;
      walk = { from: here, hops, drop, near, escape, sent: 0 };
      this.workerWalks.set(d.id, walk);
    }
    const at = (cell: number): Pt => ({ x: cellCentreX(cell, this.size), y: cellCentreY(cell, this.size) });
    // The first order replaces the worker's orders; the rest queue behind it while the queue has room.
    for (let room = walk.sent ? ORDER_QUEUE - queued : ORDER_QUEUE + 1; room > 0 && walk.sent <= walk.hops.length; room--, walk.sent++) {
      const queue = walk.sent > 0 ? { queue: true } : {};
      if (walk.sent < walk.hops.length) out.push({ kind: 'move', units: [d.id], ...at(walk.hops[walk.sent]!), ...queue });
      else out.push({ kind: 'mine', units: [d.id], ...(walk.near >= 0 ? at(walk.near) : {}), ...queue });
    }
    return true;
  }

  /** Tunnel cell inside the focus's pocket (toward the map centre from its Spire, in its frame), within collapse reach of its Spire. */
  private chargeCell(c: Ctx): Pt {
    const p = c.foeFrame.offset(c.foeAt, CHARGE_OFFSET, CHARGE_OFFSET);
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  /** Our depths root: the open pocket cell beside our Spire, where our depths walks start. */
  private rootCell(c: Ctx): number {
    const home = c.frame.toCanon(c.home.x, c.home.y);
    return c.frame.cellAt(Math.floor(home.x) + ROOT_POCKET_DX, Math.floor(home.y));
  }

  private rememberShields(c: Ctx): void {
    for (const e of c.obs.entities) if (e.kind === 'warden') {
      if (e.plane === 'depths' && c.hostile(e.side) && (e.state === 'walling' || e.state === 'walled' || e.state === 'unwalling')) this.shieldsSeen.set(e.id, e);
      else this.shieldsSeen.delete(e.id);
    }
    for (const [id, shield] of this.shieldsSeen) {
      if (c.obs.eliminated.some((side) => side === shield.side) || (!c.obs.entities.some((e) => e.id === id) && c.own.some((e) =>
        e.plane === 'depths' && Math.abs(Math.floor(e.x) - Math.floor(shield.x)) + Math.abs(Math.floor(e.y) - Math.floor(shield.y)) <= 1))) this.shieldsSeen.delete(id);
    }
  }

  /** Known tunnels from an optional single cell, otherwise the union of our root, diggers and built Shafts; `closed` cells block too. */
  private reach(c: Ctx, origin?: number, closed?: ReadonlySet<number>): Set<number> {
    const out = new Set<number>();
    this.walkReach(c, origin, closed, out);
    return out;
  }

  /**
   * reach's walk, adding the reached cells to `out` in reach's order when given. Returns the walk's stamp: a cell was
   * reached iff `reachSeen[cell]` equals it, until the next walk, so a membership-only caller builds no Set.
   */
  private walkReach(c: Ctx, origin: number | undefined, closed: ReadonlySet<number> | undefined, out: Set<number> | null): number {
    // This walk's stamp marks its reached cells (reachSeen) and the cells it may not enter (reachShut): no clearing.
    const stamp = ++this.reachStamp, seen = this.reachSeen, shut = this.reachShut;
    const grid = c.obs.depths;
    if (!grid) return stamp;
    for (const p of this.bulkheadsSeen.values()) shut[Math.floor(p.y) * this.size + Math.floor(p.x)] = stamp;
    for (const e of this.shieldsSeen.values()) shut[Math.floor(e.y) * this.size + Math.floor(e.x)] = stamp;
    if (closed) for (const n of closed) shut[n] = stamp;
    for (const a of c.match.armies) {
      if (a.id === c.army && c.obs.spire.find((s) => s.plane === 'depths')?.hp === 0) continue;
      const p = a.spireAt;
      const f = STATS.spire.footprint;
      for (let y = p.y - f.h / 2; y < p.y + f.h / 2; y++) for (let x = p.x - f.w / 2; x < p.x + f.w / 2; x++) shut[y * this.size + x] = stamp;
    }
    const start = origin ?? this.rootCell(c);
    if (origin !== undefined && (!isOpenCell(grid[start]!) || shut[start] === stamp)) return stamp;
    const queue = this.reachQueue;
    let tail = 0;
    queue[tail++] = start;
    out?.add(start);
    seen[start] = stamp;
    if (origin === undefined) for (const e of c.own) {
      if (!((e.kind === 'shaft' && e.plane === 'surface' && e.state !== 'constructing') || (e.kind === 'digger' && e.plane === 'depths'))) continue;
      const cell = Math.floor(e.y) * this.size + Math.floor(e.x);
      if (seen[cell] !== stamp && isOpenCell(grid[cell]!) && shut[cell] !== stamp) {
        out?.add(cell);
        seen[cell] = stamp;
        queue[tail++] = cell;
      }
    }
    const size = this.size, cells = size * size;
    for (let i = 0; i < tail; i++) {
      const at = queue[i]!;
      const x = at % size;
      for (let k = 0; k < 4; k++) {
        const n = k === 0 ? (x < size - 1 ? at + 1 : -1) : k === 1 ? (x > 0 ? at - 1 : -1) : k === 2 ? at + size : at - size;
        if (n < 0 || n >= cells || seen[n] === stamp || shut[n] === stamp) continue;
        // isOpenCell, inlined.
        const code = grid[n];
        if (code !== CELL.tunnel && code !== CELL.rail && code !== CELL.bridge) continue;
        out?.add(n);
        seen[n] = stamp;
        queue[tail++] = n;
      }
    }
    return stamp;
  }

  /** Plan from army knowledge only; never tunnel through pocket ore, the Mother Lode or a remembered hostile gate. */
  private preparePlans(c: Ctx, grid: readonly number[]): void {
    this.planGrid.set(grid);
    this.wantedTags.clear();
    this.planCount = 0;
    this.motherCells.length = 0;
    const lode = CELL.lode, urgent = c.obs.designations.urgent, normal = c.obs.designations.normal, tags = this.planTags;
    // Designation bitsets: bit `b` of word `w` is cell w × VISION_BITS_PER_WORD + b.
    for (let n = 0, w = 0, b = 0, cells = this.size * this.size; n < cells; n++) {
      // Mother Lode cells are solid for every plan (never dug); mined only from beside them.
      if (grid[n] === lode) {
        this.motherCells.push(n);
        this.planGrid[n] = CELL.bedrock;
      }
      const bit = 1 << b;
      const priority = (urgent[w]! & bit) !== 0 ? 2 : (normal[w]! & bit) !== 0 ? 1 : 0;
      tags[n] = priority;
      if (priority) this.planCount++;
      if (++b === VISION_BITS_PER_WORD) { b = 0; w++; }
    }
    // Our normal tags the observation no longer shows as normal work are no longer ours to clear.
    for (const n of this.ownTags) if (tags[n] !== 1) this.ownTags.delete(n);
    for (const n of this.tagWantedAt.keys()) if (tags[n] !== 1) this.tagWantedAt.delete(n);
    for (const l of c.obs.lodes) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = (l.y + dy) * this.size + l.x + dx;
        if (this.planGrid[n] === CELL.ore || this.planGrid[n] === CELL.unknown) this.planGrid[n] = CELL.bedrock;
      }
    }
    for (const p of this.bulkheadsSeen.values()) this.planGrid[Math.floor(p.y) * this.size + Math.floor(p.x)] = CELL.bedrock;
    for (const e of this.shieldsSeen.values()) this.planGrid[Math.floor(e.y) * this.size + Math.floor(e.x)] = CELL.bedrock;
    for (const a of c.match.armies) {
      if (a.id === c.army && c.obs.spire.find((s) => s.plane === 'depths')?.hp === 0) continue;
      const p = a.spireAt;
      const f = STATS.spire.footprint;
      for (let y = p.y - f.h / 2; y < p.y + f.h / 2; y++) for (let x = p.x - f.w / 2; x < p.x + f.w / 2; x++) this.planGrid[y * this.size + x] = CELL.bedrock;
    }
    for (const e of c.own) if (e.kind === 'geothermal') this.planGrid[Math.floor(e.y) * this.size + Math.floor(e.x)] = CELL.bedrock;
    for (const q of c.obs.queue) if (q.item === 'geothermal' && q.x !== undefined && q.y !== undefined) this.planGrid[Math.floor(q.y) * this.size + Math.floor(q.x)] = CELL.bedrock;
    if (this.planRules !== c.match.rules) {
      this.planRules = c.match.rules;
      this.planCosts = depthsCosts(c.econ).dig;
      this.planCosts[CELL.unknown] = this.planCosts[CELL.rock]!;
    }
  }

  /**
   * Tag a cheapest knowledge-only route, frontier first; preserve teammates' urgent tags and respect both caps. False:
   * no route; true also when the search waits for the next decision (tier.routeSearches spent).
   */
  private designateRoute(c: Ctx, out: AgentCommandIntent[], key: string, goal: (n: number) => boolean, priority: 1 | 2, economy = false): boolean {
    const path = this.planRoute(c, key, goal, economy);
    if (path) this.tagPath(c, out, path, priority);
    return path !== null;
  }

  /** Where our routes start: the root, or with the Depths segment lost a digger's cell (-1: none). */
  private routeRoot(c: Ctx): number {
    if (c.segmentAlive('depths')) return this.rootCell(c);
    const digger = c.own.find((e) => e.kind === 'digger' && e.plane === 'depths');
    return digger ? Math.floor(digger.y) * this.size + Math.floor(digger.x) : -1;
  }

  /**
   * The cheapest knowledge-only route from our root to a `goal` cell (null: none, or an `economy` route not safe), for
   * the planner `key`. Under a work bound (tier.routeReuse, routeSearches) the planner's last answer stands while it is
   * younger than routeReuse and still holds (same root, every cell still passable, still ending on a goal, still safe),
   * a route that holds also once the decision's searches are spent; undefined: no search left this decision.
   */
  private planRoute(c: Ctx, key: string, goal: (n: number) => boolean, economy: boolean): number[] | null | undefined {
    const root = this.routeRoot(c);
    if (root < 0) return null;
    const t = this.tier;
    const kept = t.routeReuse > 0 ? this.routes.get(key) : undefined;
    if (kept && kept.root === root && (kept.path === null || this.routeHolds(kept.path, root, goal, economy))) {
      if (c.obs.tick - kept.at < t.routeReuse || (kept.path !== null && this.searchCredit < 1)) return kept.path;
    }
    if (this.searchCredit < 1) return undefined;
    this.searchCredit--;
    const path = searchDepths(this.planGrid, root, goal, this.planCosts, false, Infinity, c.frame.k, null, null, this.size);
    const route = path && (!economy || this.workerRoutes.safePlan(path)) ? path : null;
    if (t.routeReuse > 0) this.routes.set(key, { path: route, root, at: c.obs.tick });
    return route;
  }

  /** Whether a kept route from `root` is still one planRoute could answer: passable now, on a goal, safe if `economy`. */
  private routeHolds(path: readonly number[], root: number, goal: (n: number) => boolean, economy: boolean): boolean {
    for (const n of path) if (this.planCosts[this.planGrid[n]!]! < 0) return false;
    return goal(path.at(-1) ?? root) && (!economy || this.workerRoutes.safePlan(path));
  }

  /** Tag `path`'s cells still to dig, frontier first; preserve teammates' urgent tags and respect both caps. */
  private tagPath(c: Ctx, out: AgentCommandIntent[], path: readonly number[], priority: 1 | 2): void {
    for (const n of path) if (this.ownTags.has(n)) this.wantedTags.add(n);
    let cells: Pt[] = [];
    for (const n of path) {
      if (isOpenCell(this.planGrid[n]!) || this.planTags[n]! >= priority) continue;
      if (!this.planTags[n] && this.planCount >= c.match.rules.depths.designateMax) break;
      if (!this.planTags[n]) {
        this.planCount++;
        if (priority === 1) {
          this.ownTags.add(n);
          this.wantedTags.add(n);
        }
      }
      this.planTags[n] = priority;
      cells.push({ x: n % this.size, y: Math.floor(n / this.size) });
      if (cells.length === c.match.rules.depths.designateCells) {
        out.push({ kind: 'designate', cells, priority });
        cells = [];
      }
    }
    if (cells.length) out.push({ kind: 'designate', cells, priority });
  }

  /**
   * Cancel only our obsolete normal work, once no plan has wanted it for TAG_SETTLE: a route re-planned every decision
   * flickers as observed danger, servable ore or reach change, and each tag withdrawn and published again sent the
   * designation workers on it away and back. Same-priority adoption by another seat is not observable.
   */
  private clearStaleTags(c: Ctx, out: AgentCommandIntent[]): void {
    let cells: Pt[] = [];
    for (const n of this.ownTags) {
      if (this.wantedTags.has(n)) {
        this.tagWantedAt.set(n, c.obs.tick);
        continue;
      }
      if (c.obs.tick - (this.tagWantedAt.get(n) ?? -TAG_SETTLE) < TAG_SETTLE) continue;
      this.ownTags.delete(n);
      this.tagWantedAt.delete(n);
      if (this.planTags[n] !== 1) continue;
      this.planTags[n] = 0;
      cells.push({ x: n % this.size, y: Math.floor(n / this.size) });
      if (cells.length === c.match.rules.depths.designateCells) {
        out.unshift({ kind: 'designate', cells, priority: 0 });
        cells = [];
      }
    }
    if (cells.length) out.unshift({ kind: 'designate', cells, priority: 0 });
  }

  /**
   * Expose the next vein after connected ore runs out; never tag away its remaining loads. The route stays published
   * until connected servable ore has stood for EXPAND_SETTLE: dropped the first decision any ore was servable and
   * published again the first it was not (an envelope shifting, a digger moving), its tags kept pulling default workers
   * toward the frontier and back.
   */
  private expandOre(c: Ctx, out: AgentCommandIntent[], reached: Set<number>, grid: readonly number[]): void {
    const diggers = c.units('digger', 'depths');
    const approaches = new Set<number>();
    let served = false;
    for (let n = 0; n < grid.length; n++) {
      if (!isOreCell(grid[n]!) || this.planGrid[n] === CELL.bedrock) continue;
      const at = { x: cellCentreX(n, this.size), y: cellCentreY(n, this.size) };
      if (c.hostileSpireDist(at) < ENEMY_ORE_KEEP_OUT) continue;
      if (!served && this.openNext(grid, n, c.frame.k).some((cell) => reached.has(cell)) && diggers.some((d) => this.workerRoutes.canServe(d, n))) served = true;
      const x = n % this.size;
      for (let k = 0; k < 4; k++) {
        const cell = k === 0 ? (x > 0 ? n - 1 : -1) : k === 1 ? (x < this.size - 1 ? n + 1 : -1) : k === 2 ? n - this.size : n + this.size;
        if (cell >= 0 && cell < grid.length && !isOreCell(grid[cell]!) && this.planGrid[cell] !== CELL.bedrock) approaches.add(cell);
      }
    }
    if (!served) this.oreServedAt = -1;
    else if (this.oreServedAt < 0) this.oreServedAt = c.obs.tick;
    // Expanding while no connected ore is servable, and on until some has been for EXPAND_SETTLE.
    this.expanding = !served || (this.expanding && c.obs.tick - this.oreServedAt < EXPAND_SETTLE);
    if (!this.expanding) {
      this.exploreRoute = [];
      return;
    }
    // Economy access must not destroy the remaining loads in intervening veins.
    const oreCost = this.planCosts[CELL.ore]!, richCost = this.planCosts[CELL.rich]!;
    this.planCosts[CELL.ore] = this.planCosts[CELL.rich] = -1;
    if (!approaches.size || !this.designateRoute(c, out, 'ore', (n) => approaches.has(n), 1, true)) this.explore(c, out, grid);
    this.planCosts[CELL.ore] = oreCost;
    this.planCosts[CELL.rich] = richCost;
  }

  /**
   * Tunnel toward unknown rock. The route stays as published while its goal is unknown and none of it lies in observed
   * danger; then the next one runs on from that goal, to the unknown cell nearest it (ties in our frame's order), or
   * failing that to the cheapest unknown cell from the root. Re-planned from the root every decision, the route hopped
   * to whichever side of home the last dug cell had revealed, and the diggers on its tags went back and forth with it.
   */
  private explore(c: Ctx, out: AgentCommandIntent[], grid: readonly number[]): void {
    const route = this.exploreRoute, last = route.at(-1) ?? -1;
    if (last >= 0 && grid[last] === CELL.unknown && this.workerRoutes.safePlan(route)) {
      this.tagPath(c, out, route, 1);
      return;
    }
    let next = -1;
    if (last >= 0) {
      const at = { x: cellCentreX(last, this.size), y: cellCentreY(last, this.size) };
      let best = Infinity;
      for (let n = 0; n < grid.length; n++) {
        if (grid[n] !== CELL.unknown || this.planGrid[n] === CELL.bedrock) continue;
        // A distance is at least its larger axis gap: a cell farther than `best` along one axis cannot win.
        if (Math.max(Math.abs(cellCentreX(n, this.size) - at.x), Math.abs(cellCentreY(n, this.size) - at.y)) > best) continue;
        const d = cellDist(n, this.size, at);
        if (d < best || (d === best && c.frame.cellKey(n) < c.frame.cellKey(next))) {
          best = d;
          next = n;
        }
      }
    }
    let path = next >= 0 ? this.planRoute(c, 'explore-next', (n) => n === next, true) : null;
    if (path === null) path = this.planRoute(c, 'explore', (n) => grid[n] === CELL.unknown, true);
    // No search left this decision (tier.routeSearches): explore again the next.
    if (path === undefined) return;
    this.exploreRoute = path ?? [];
    if (path) this.tagPath(c, out, path, 1);
  }

  /**
   * Where a trooper squad digs up for an ambush: a tunnel cell we can reach, BREACH_MIN–BREACH_MAX tiles from the focus's
   * Spire (just outside its beam), under open ground, as close as possible to hostile structures. -1 if there is none.
   */
  private breachCell(c: Ctx, reached: Set<number>): number {
    const foe = c.foeAt;
    const structures = c.foes.filter((e) => e.plane === 'surface' && (e.kind === 'turret' || e.kind === 'shaft' || e.kind === 'spire'));
    let best = -1;
    let score = Infinity;
    for (const n of reached) {
      const p = { x: cellCentreX(n, this.size), y: cellCentreY(n, this.size) };
      const d = dist(p, foe);
      if (d < BREACH_MIN || d > BREACH_MAX || !c.walkable(n) || structures.some((s) => dist(s, p) < BREACH_CLEARANCE)) continue;
      const s = structures.reduce((m, e) => Math.min(m, dist(e, p)), d);
      if (s < score || (s === score && c.frame.cellKey(n) < c.frame.cellKey(best))) {
        score = s;
        best = n;
      }
    }
    return best;
  }

  /**
   * Our Depths fighters number fewer than tier.depthsLead times the hostile ones seen in the last DEPTHS_FOE_MEMORY
   * ticks (0: never). Outfought, a tier digs no tunnel and sends no sapper wave (they only fed the tunnel its diggers
   * and sappers) and buys its Wardens before the rest of its crew.
   */
  private outfought(c: Ctx): boolean {
    const lead = this.tier.depthsLead;
    if (lead <= 0) return false;
    const tick = c.obs.tick;
    const armed = (e: Entity): boolean => e.plane === 'depths' && e.kind !== 'spire' && c.statsOf(e).dmg > 0 && !c.statsOf(e).capabilities.carry;
    for (const e of c.foes) if (armed(e)) this.depthsFoes.set(e.id, tick);
    for (const [id, at] of this.depthsFoes) if (tick - at > DEPTHS_FOE_MEMORY) this.depthsFoes.delete(id);
    let own = 0;
    for (const e of c.own) if (armed(e) && e.hp > 0) own++;
    return own < lead * this.depthsFoes.size;
  }

  /**
   * This decision's sapper strike: the reached tunnel cell under the hostile turret ring we siege, else under known
   * Headframes (raidLodes tiers), else Shafts (each: the cell hitting most of them, ties in our frame's cell order), else
   * `spire` (the focus's Spire charge cell once tunnelled; -1: none). `stack`: sappers to stack there so the collapse
   * brings down the toughest kind it aims at (stackFor; 1 under the Spire, which no charge fells). Felling is the whole
   * point: a hole never empties the lode under a Headframe or seals a Shaft, so a structure left standing keeps working.
   */
  private strike(c: Ctx, reached: Set<number>, spire: number): { cell: number; stack: number } | null {
    const kinds: ['turret' | 'headframe' | 'shaft', Map<string, Pt>, boolean][] = [
      ['turret', this.turretsSeen, !!this.siegeTarget(c)],
      ['headframe', this.headframesSeen, this.tier.raidLodes],
      ['shaft', this.shaftsSeen, true],
    ];
    for (const [kind, seen, on] of kinds) {
      const cell = on ? this.collapseCell(c, reached, [...seen.values()]) : -1;
      if (cell >= 0) return { cell, stack: this.stackFor(c, c.stats[kind].hp) };
    }
    return spire >= 0 ? { cell: spire, stack: 1 } : null;
  }

  /** Sappers stacked on one charge whose collapse deals at least `hp` (collapseDamage, chargeStackDamage), at most chargeStackMax. */
  private stackFor(c: Ctx, hp: number): number {
    const e = c.econ;
    for (let n = 1; n < e.chargeStackMax; n++) if (e.collapseDamage * (1 + e.chargeStackDamage * (n - 1)) >= hp) return n;
    return e.chargeStackMax;
  }

  /**
   * Team `collapse` requests (rules/signals.ts): acked while collapses are allowed and we can field sappers. Each
   * decision the reached tunnel cell under the tile gets idle sappers, as many stacked as the toughest hostile structure
   * we know of in its collapse reach needs (else the request's count), the diggers dig toward the tile while no reached
   * cell lies under it, and the request is done once our charge stands within collapse reach of the tile (failed if it
   * would expire first). Committed sappers join `busy`; `collapseSappers` is what production should keep.
   */
  private answerCollapse(c: Ctx, out: AgentCommandIntent[], sappers: Entity[], busy: Set<string>, reached: Set<number>, allowed: boolean): void {
    const desk = this.desk;
    const reach = c.econ.collapseRadius + c.econ.collapseStructureReach;
    this.collapseSappers = 0;
    for (const e of desk.fresh()) {
      if (e.need !== 'collapse') continue;
      if (!allowed || !tileCentre(e) || !desk.room() || (!sappers.length && !c.segmentAlive('depths'))) desk.decline(e);
      else desk.take(e, [], tileCentre(e));
    }
    const centre = (n: number): Pt => ({ x: cellCentreX(n, this.size), y: cellCentreY(n, this.size) });
    for (const task of desk.work()) {
      const tile = task.at;
      if (task.entry.need !== 'collapse' || !tile) continue;
      if (c.obs.charges.some((ch) => ch.side === c.army && dist(centre(ch.y * this.size + ch.x), tile) <= reach)) {
        desk.done(task, false);
        continue;
      }
      if (!allowed || desk.late(task)) {
        desk.fail(task);
        continue;
      }
      const cell = this.collapseCell(c, reached, [tile]);
      if (cell < 0) {
        this.designateRoute(c, out, `collapse:${tile.x},${tile.y}`, (n) => dist(centre(n), tile) <= reach, 1);
        this.collapseSappers = Math.max(this.collapseSappers, 1);
        continue;
      }
      const at = centre(cell);
      let hp = 0;
      for (const f of c.foes) if (f.plane === 'surface' && c.statsOf(f).speed === 0 && f.kind !== 'spire' && dist(f, at) <= reach) hp = Math.max(hp, f.hp);
      for (const [kind, seen] of [['turret', this.turretsSeen], ['headframe', this.headframesSeen], ['shaft', this.shaftsSeen]] as const) {
        for (const p of seen.values()) if (dist(p, at) <= reach) hp = Math.max(hp, c.stats[kind].hp);
      }
      const stack = hp > 0 ? this.stackFor(c, hp) : Math.min(task.entry.count ?? 1, c.econ.chargeStackMax);
      this.collapseSappers = Math.max(this.collapseSappers, stack);
      // Sappers already sent keep going (a fresh squad only once they are gone or stopped).
      const sent = sappers.filter((s) => task.units.includes(s.id));
      for (const s of sent) busy.add(s.id);
      if (sent.some((s) => s.state !== 'idle')) continue;
      const ready = sappers.filter((s) => s.state === 'idle' && !busy.has(s.id))
        .sort((a, b) => dist(a, at) - dist(b, at) || c.frame.pointKey(a) - c.frame.pointKey(b));
      if (ready.length < stack) continue;
      const squad = ready.slice(0, stack);
      out.push({ kind: 'undermine', units: ids(squad), x: cell % this.size, y: Math.floor(cell / this.size) });
      desk.commit(task, squad, tile);
      for (const s of squad) busy.add(s.id);
    }
  }

  /**
   * The tunnel cell we reach whose collapse would hit the most of `targets` (remembered hostile structures within
   * collapseRadius + collapseStructureReach take the damage); ties in our frame's cell order. -1 if none is under any of them.
   */
  private collapseCell(c: Ctx, reached: Set<number>, targets: Pt[]): number {
    if (targets.length === 0) return -1;
    let best = -1;
    let most = 0;
    const reach = c.econ.collapseRadius + c.econ.collapseStructureReach;
    for (const n of reached) {
      const px = cellCentreX(n, this.size), py = cellCentreY(n, this.size);
      // A target farther than `reach` along either axis is out of reach without measuring the distance.
      let hits = 0;
      for (const s of targets) if (Math.abs(s.x - px) <= reach && Math.abs(s.y - py) <= reach && dist(s, { x: px, y: py }) <= reach) hits++;
      if (hits > most || (hits === most && hits > 0 && c.frame.cellKey(n) < c.frame.cellKey(best))) {
        most = hits;
        best = n;
      }
    }
    return best;
  }

  /** Whether digger `d` may join a crew: not resting after a crew let it go because its way there turned unsafe. */
  private rejoins(c: Ctx, d: Entity): boolean {
    return (this.crewRejoinAt.get(d.id) ?? c.obs.tick) <= c.obs.tick;
  }

  /** The free digger nearest `at` (not busy or carrying ore). Explicit jobs override designation work. */
  private freeDigger(diggers: Entity[], busy: Set<string>, at: Pt): Entity | undefined {
    let best: Entity | undefined;
    for (const d of diggers) {
      if (busy.has(d.id) || d.carry !== undefined) continue;
      if (!best || dist(d, at) < dist(best, at)) best = d;
    }
    return best;
  }

  /**
   * bridgeWars: for each own lava bridge an armed hostile was seen within BRIDGE_GUARD_REACH of in the last WARDEN_CALM
   * (remembered: the spotter usually backs off and loses sight), the free Warden nearest it walls on the bridge's dry
   * shore cell nearest home (ties in frame order). Guards hold their ground (stance hold) until released; a slow
   * decision period would otherwise let them chase the foe onto the deck between arriving and deploying. Returns the
   * Wardens left for the post.
   */
  private guardBridges(c: Ctx, out: AgentCommandIntent[], wardens: Entity[], busy: Set<string>, grid: readonly number[]): Entity[] {
    if (!c.econ.wallEnabled) return wardens;
    const tick = c.obs.tick;
    const bridges = c.own.filter((e) => e.kind === 'lava_bridge');
    for (const b of bridges) if (c.foes.some((e) => e.plane === 'depths' && c.statsOf(e).dmg > 0 && dist(e, b) <= BRIDGE_GUARD_REACH)) this.bridgeThreats.set(b.id, tick);
    for (const [id, at] of this.bridgeThreats) if (tick - at >= WARDEN_CALM || !bridges.some((b) => b.id === id)) this.bridgeThreats.delete(id);
    let free = wardens;
    const guarding = new Set<string>();
    for (const b of bridges) {
      if (!this.bridgeThreats.has(b.id)) continue;
      let shore = -1;
      for (const n of this.openNext(grid, c.frame.pointCell(b.x, b.y), c.frame.k)) {
        if (grid[n] !== CELL.bridge && (shore < 0 || cellDist(n, this.size, c.home) < cellDist(shore, this.size, c.home))) shore = n;
      }
      if (shore < 0) continue;
      const at = { x: cellCentreX(shore, this.size), y: cellCentreY(shore, this.size) };
      const guard = free.filter((e) => !busy.has(e.id)).sort((a, z) => dist(a, at) - dist(z, at) || c.frame.pointKey(a) - c.frame.pointKey(z))[0];
      if (!guard) continue;
      busy.add(guard.id);
      guarding.add(guard.id);
      free = free.filter((e) => e !== guard);
      if (guard.stance !== 'hold') out.push({ kind: 'stance', units: [guard.id], stance: 'hold' });
      if (c.frame.pointCell(guard.x, guard.y) !== shore) {
        if (guard.state !== 'moving' || guard.tx !== at.x || guard.ty !== at.y) out.push({ kind: 'move', units: [guard.id], ...at, mode: 'move' });
      } else if (guard.state !== 'walled' && guard.state !== 'walling' && !guard.deployBlocked) out.push({ kind: 'deploy', units: [guard.id], on: true });
    }
    // Released guards (threat forgotten, or another Warden nearer) fight on the default stance again.
    for (const id of this.bridgeGuards) {
      if (guarding.has(id)) continue;
      this.bridgeGuards.delete(id);
      if (wardens.some((w) => w.id === id)) out.push({ kind: 'stance', units: [id], stance: 'aggressive' });
    }
    for (const id of guarding) this.bridgeGuards.add(id);
    return free;
  }

  /**
   * Green rich ore (public, known from the start) is usually behind lava. Keep tier.richCrew diggers mining rich cells
   * we can serve; toward the nearest other rich cell (and toward `push`, our tunnel target, when a bridge is shorter
   * than the dry way round by LAKE_BRIDGE_SAVING) bridge the first lake cell of the cheapest known route, or dig to its
   * shore first; bridges toward rich ore are paid for from RICH_BRIDGE_DIGGERS diggers on. A bridge of ours that fell
   * holds every new bridge back for BRIDGE_REBUILD_CALM, then the crossing is planned afresh. bridgeWars tiers also
   * send idle troopers (or a sapper) against hostile bridges they can reach.
   */
  private lavaWork(c: Ctx, out: AgentCommandIntent[], diggers: Entity[], busy: Set<string>, reached: Set<number>, grid: readonly number[], push: number): void {
    const t = this.tier, size = this.size, rules = c.match.rules.depths, tick = c.obs.tick;
    const byId = new Map(diggers.map((d) => [d.id, d]));
    const standing = new Set<string>();
    for (const e of c.own) if (e.kind === 'lava_bridge') standing.add(e.id);
    for (const id of this.ownBridges) if (!standing.has(id)) this.bridgeCalmUntil = tick + BRIDGE_REBUILD_CALM;
    this.ownBridges.clear();
    for (const id of standing) this.ownBridges.add(id);
    for (const [id, cell] of this.bridgers) {
      const d = byId.get(id);
      // Mining, hauling or still not bridging BRIDGE_JOB_MAX after it was sent: the order was lost on the way (an
      // unpaid arrival hands the digger to auto-mine or designation work).
      const strayed = !!d && d.state !== 'idle' && d.state !== 'bridging'
        && (d.state === 'mining' || d.carry !== undefined || tick - (this.bridgeSent.get(id) ?? tick) >= BRIDGE_JOB_MAX);
      if (!d || grid[cell] !== CELL.lake || strayed) {
        this.bridgers.delete(id);
        this.bridgeWaitAt.delete(id);
        this.bridgeSent.delete(id);
        continue;
      }
      if (d.state === 'idle' && !busy.has(id)) {
        // Idle beside its lake, it arrived unpaid: on the way another lane's hold took the funds and the simulation
        // dropped the bridge. It waits there for them (held, so auto-mine does not take it) up to BRIDGE_FUNDS_WAIT:
        // let go at once, it walked off to mine and the next bridger walked the whole way back.
        const here = c.frame.pointCell(d.x, d.y), since = this.bridgeWaitAt.get(id) ?? tick;
        if (!this.beside(c, d, cell) || tick - since >= BRIDGE_FUNDS_WAIT) {
          this.bridgers.delete(id);
          this.bridgeWaitAt.delete(id);
          this.bridgeSent.delete(id);
          continue;
        }
        this.bridgeWaitAt.set(id, since);
        if (seatSpendable(c.obs.res, c.obs.queue, 'depths').alloy >= rules.lavaBridgeCost) out.push({ kind: 'bridge', units: [id], x: cell % size, y: Math.floor(cell / size) });
        else out.push({ kind: 'move', units: [id], x: cellCentreX(here, size), y: cellCentreY(here, size) });
      } else this.bridgeWaitAt.delete(id);
      busy.add(id);
    }
    // Rich cells on our side only (nearer our Spire than every hostile one): the clusters nearer a hostile home lie
    // beyond our Wardens, and bridging them doubled the alloy a crossing cost before any of it paid back.
    const rich: number[] = [], home = c.home;
    for (let n = 0; n < grid.length; n++) {
      if (grid[n] !== CELL.rich) continue;
      const at = { x: cellCentreX(n, size), y: cellCentreY(n, size) };
      if (dist(at, home) < c.hostileSpireDist(at)) rich.push(n);
    }
    for (const [id, cell] of this.richCrew) {
      const d = byId.get(id);
      const unsafe = !!d && !busy.has(id) && grid[cell] === CELL.rich && !this.workerRoutes.canServe(d, cell);
      if (unsafe) this.crewRejoinAt.set(id, c.obs.tick + CREW_REJOIN);
      if (!d || busy.has(id) || grid[cell] !== CELL.rich || unsafe) this.richCrew.delete(id);
    }
    rich.sort((a, b) => cellDist(a, size, home) - cellDist(b, size, home) || c.frame.cellKey(a) - c.frame.cellKey(b));
    const served = rich.filter((n) => diggers.some((d) => this.workerRoutes.canServe(d, n)));
    for (const cell of served) {
      if (this.richCrew.size >= t.richCrew) break;
      const at = { x: cellCentreX(cell, size), y: cellCentreY(cell, size) };
      const d = this.freeDigger(diggers.filter((x) => !this.richCrew.has(x.id) && this.rejoins(c, x) && this.workerRoutes.canServe(x, cell)), busy, at);
      if (!d) break;
      this.richCrew.set(d.id, cell);
      this.workerRedirect.delete(d.id);
      this.workerSafeMines.delete(d.id);
      out.push({ kind: 'mine', units: [d.id], ...at });
    }
    for (const [id, cell] of this.richCrew) {
      busy.add(id);
      if (byId.get(id)?.state === 'idle') out.push({ kind: 'mine', units: [id], x: cellCentreX(cell, size), y: cellCentreY(cell, size) });
    }
    if (t.richCrew > 0 && this.bridgers.size === 0) {
      const goals = new Set<number>();
      const reachedRich = new Set(served);
      for (const n of rich) if (!reachedRich.has(n)) goals.add(n);
      // Crossings start from tunnels whose hauls reach a drop-off: `reached` also holds every digger's cell, and a crew
      // stranded beyond a fallen bridge made the ore look reachable from its side, so the bridge was never rebuilt.
      const linked = new Set<number>();
      for (const n of reached) if (this.workerRoutes.canServeFrom(n, n)) linked.add(n);
      if (goals.size && !this.crossToward(c, out, 'rich', diggers, busy, linked, grid, (n) => goals.has(n), -Infinity, diggers.length >= RICH_BRIDGE_DIGGERS)) {
        // No lake on the way: dig to a cell beside a rich cell, never through rich ore.
        const approaches = new Set<number>();
        for (const r of goals) for (const n of [r % this.size > 0 ? r - 1 : -1, r % this.size < this.size - 1 ? r + 1 : -1, r - this.size, r + this.size]) {
          if (n >= 0 && n < grid.length && !isOreCell(grid[n]!) && !isLava(grid[n]!) && this.planGrid[n] !== CELL.bedrock) approaches.add(n);
        }
        if (approaches.size) this.designateRoute(c, out, 'rich', (n) => approaches.has(n), 1, true);
      }
      if (push >= 0 && this.bridgers.size === 0) this.crossToward(c, out, 'push', diggers, busy, linked, grid, (n) => n === push, LAKE_BRIDGE_SAVING, true);
    }
    if (!t.bridgeWars) return;
    // Cut hostile bridges we reach: idle troopers attack one, else a sapper undermines the dry cell beside it.
    const hostile = c.foes.filter((e) => e.kind === 'lava_bridge' && this.openNext(grid, c.frame.pointCell(e.x, e.y), c.frame.k).some((n) => reached.has(n)))
      .sort((a, z) => dist(a, home) - dist(z, home) || c.frame.pointKey(a) - c.frame.pointKey(z));
    const target = hostile[0];
    if (!target) return;
    const troopers = c.own.filter((e) => e.kind === 'trooper' && e.plane === 'depths' && e.state === 'idle' && !busy.has(e.id) && !out.some((i) => 'units' in i && i.units.includes(e.id)));
    if (troopers.length) {
      for (const e of troopers) busy.add(e.id);
      out.push({ kind: 'attack', units: ids(troopers), target: target.id });
      return;
    }
    const sapper = c.own.find((e) => e.kind === 'sapper' && e.plane === 'depths' && e.state === 'idle' && !busy.has(e.id));
    if (!sapper || c.obs.mandate.limits?.collapses === false) return;
    const shore = this.openNext(grid, c.frame.pointCell(target.x, target.y), c.frame.k).find((n) => reached.has(n) && grid[n] !== CELL.bridge && Math.abs(n % size - Math.floor(target.x)) <= rules.chargeBridgeReach && Math.abs(Math.floor(n / size) - Math.floor(target.y)) <= rules.chargeBridgeReach);
    if (shore === undefined) return;
    busy.add(sapper.id);
    out.push({ kind: 'undermine', units: [sapper.id], x: shore % size, y: Math.floor(shore / size) });
  }

  /**
   * Bridge or dig along the cheapest known route to `goal` when it crosses a lake and saves at least `saving` cost
   * over the dry way round: the route's first lake cell is bridged by the free digger nearest it (when `pay`, funds
   * permitting and no bridge of ours fell lately), or, when the shore before it is still rock, a dig route to that shore
   * is published. False: no lake on the way; true also when the decision has no search left (tier.routeSearches) for
   * planner `key`.
   */
  private crossToward(c: Ctx, out: AgentCommandIntent[], key: string, diggers: Entity[], busy: Set<string>, reached: Set<number>, grid: readonly number[], goal: (n: number) => boolean, saving: number, pay: boolean): boolean {
    const size = this.size, span = c.match.rules.depths.lavaBridgeSpan;
    const bridgeable = (n: number): boolean => lavaBridgeable(grid, n, size, span);
    const found = this.crossing(c, key, reached, grid, goal, bridgeable);
    if (!found) return true;
    const { crossing, cost, withoutLakes } = found;
    if (!crossing) return false;
    if (withoutLakes - cost < saving) return true;
    if (crossing.bridge < 0) {
      if (crossing.shore >= 0) this.designateRoute(c, out, `shore:${key}`, (n) => n === crossing.shore, 1, true);
      return true;
    }
    // Funds as the simulation pays a bridge: the free bank plus our own lane's earmark (seatSpendable). The free bank
    // alone sits near zero while the other lanes' heads save, and a bridge waited minutes for a gap.
    if (!pay || c.obs.tick < this.bridgeCalmUntil || seatSpendable(c.obs.res, c.obs.queue, 'depths').alloy < c.match.rules.depths.lavaBridgeCost) return true;
    const shore = crossing.shore;
    const d = this.freeDigger(diggers.filter((x) => reached.has(c.frame.pointCell(x.x, x.y))), busy, { x: cellCentreX(shore, size), y: cellCentreY(shore, size) });
    if (!d) return true;
    busy.add(d.id);
    this.bridgers.set(d.id, crossing.bridge);
    this.bridgeSent.set(d.id, c.obs.tick);
    out.push({ kind: 'bridge', units: [d.id], x: crossing.bridge % size, y: Math.floor(crossing.bridge / size) });
    return true;
  }

  /**
   * The lake crossing on the cheapest known route to `goal` for planner `key` (LakePlanner.cross). Under a work bound
   * (tier.routeReuse, routeSearches) the planner's last crossing stands as planRoute's routes do while it still holds
   * (its lake cell still bridgeable from an open shore, or its shore still to dig); undefined: no search left.
   */
  private crossing(c: Ctx, key: string, reached: Set<number>, grid: readonly number[], goal: (n: number) => boolean, bridgeable: (n: number) => boolean): LakeRoute | undefined {
    const t = this.tier;
    const kept = t.routeReuse > 0 ? this.crossings.get(key) : undefined;
    if (kept && (c.obs.tick - kept.at < t.routeReuse || this.searchCredit < 1)) {
      const x = kept.found.crossing;
      const holds = !x || (x.bridge >= 0 ? grid[x.bridge] === CELL.lake && bridgeable(x.bridge) && isOpenCell(grid[x.shore]!) : x.shore < 0 || !isOpenCell(grid[x.shore]!));
      if (holds) return kept.found;
    }
    if (this.searchCredit < 1) return undefined;
    this.searchCredit--;
    const found = this.lakes.cross(grid, reached, goal, c.frame.k, this.planGrid, bridgeable);
    if (t.routeReuse > 0) this.crossings.set(key, { found, at: c.obs.tick });
    return found;
  }

  /** Open 4-neighbours of `cell` in our knowledge, in frame `k`'s step order (a `find` on them picks rotated cells for rotated armies). */
  private openNext(grid: ArrayLike<number>, cell: number, k: number): number[] {
    const x = cell % this.size, out: number[] = [];
    for (let i = 0; i < 4; i++) {
      const d = frameDir(k, i);
      const n = d === 0 ? (x < this.size - 1 ? cell + 1 : -1) : d === 1 ? (x > 0 ? cell - 1 : -1) : d === 2 ? cell + this.size : cell - this.size;
      if (n >= 0 && n < this.size * this.size && isOpenCell(grid[n]!)) out.push(n);
    }
    return out;
  }

  /** Sealed, located pockets are emergency energy only; never replace a healthy Orbit economy. */
  private geothermal(c: Ctx, out: AgentCommandIntent[], diggers: Entity[], busy: Set<string>, reached: Set<number>, grid: readonly number[]): void {
    let footprint = c.ownQueued();
    for (const intent of out) if (intent.kind === 'queue_add') footprint++;
    if (c.segmentAlive('orbit') || !diggers.length || c.econ.geothermalRate <= 0 || footprint >= this.tier.queueDepth ||
      !c.affordable('geothermal', this.tier.reserve.depths)) return;
    const home = c.home;
    const taps = c.obs.entities.filter((e) => e.kind === 'geothermal');
    const queued = c.obs.queue.filter((q) => q.item === 'geothermal');
    const tapped = new Set<number>();
    for (const pocket of c.obs.pockets) {
      if (taps.some((e) => Math.abs(Math.floor(e.x) - pocket.x) + Math.abs(Math.floor(e.y) - pocket.y) === 1) ||
        queued.some((q) => q.x !== undefined && q.y !== undefined && Math.abs(Math.floor(q.x) - pocket.x) + Math.abs(Math.floor(q.y) - pocket.y) === 1)) tapped.add(pocket.id);
    }
    let site = -1;
    for (const pocket of c.obs.pockets) {
      if (tapped.has(pocket.id)) continue;
      const cell = pocket.y * this.size + pocket.x;
      for (let k = 0; k < 4; k++) {
        const n = k === 0 ? (pocket.x > 0 ? cell - 1 : -1) : k === 1 ? (pocket.x < this.size - 1 ? cell + 1 : -1) : k === 2 ? cell - this.size : cell + this.size;
        if (n < 0 || n >= this.size * this.size || grid[n] !== CELL.rock || this.planGrid[n] === CELL.bedrock || this.planTags[n] ||
          taps.some((e) => Math.floor(e.y) * this.size + Math.floor(e.x) === n) ||
          queued.some((q) => q.x !== undefined && q.y !== undefined && Math.floor(q.x) === n % this.size && Math.floor(q.y) === Math.floor(n / this.size))) continue;
        if (site < 0 || cellDist(n, this.size, home) < cellDist(site, this.size, home) ||
          (cellDist(n, this.size, home) === cellDist(site, this.size, home) && c.frame.cellKey(n) < c.frame.cellKey(site))) site = n;
      }
    }
    if (site < 0) return;
    this.planGrid[site] = CELL.bedrock;
    if (!this.openNext(grid, site, c.frame.k).some((n) => reached.has(n))) {
      const x = site % this.size;
      this.designateRoute(c, out, 'geothermal', (n) => n === site - this.size || n === site + this.size || (x > 0 && n === site - 1) || (x < this.size - 1 && n === site + 1), 1);
      return;
    }
    let hand: Entity | undefined;
    const at = { x: cellCentreX(site, this.size), y: cellCentreY(site, this.size) };
    for (const d of diggers) {
      if (busy.has(d.id) || d.carry !== undefined || (d.state !== 'idle' && d.state !== 'mining')) continue;
      if (!hand || dist(d, at) < dist(hand, at)) hand = d;
    }
    if (!hand) return;
    busy.add(hand.id);
    out.push({ kind: 'queue_add', item: 'geothermal', x: site % this.size, y: Math.floor(site / this.size), digger: hand.id });
    c.reserveCost(c.stats.geothermal.alloy, c.stats.geothermal.energy);
  }

  /**
   * Fortify the fault cells nearest home (one per fault, nearest faults first; rock only, never our own tunnels): an
   * hostile charge on the fault then cannot open a chasm past them. One digger digs beside each in turn and fortifies it.
   */
  private guardFaults(c: Ctx, out: AgentCommandIntent[], diggers: Entity[], busy: Set<string>, reached: Set<number>, grid: readonly number[]): void {
    const home = c.home;
    if (!this.guards) {
      const picks: { cell: number; d: number }[] = [];
      for (const f of c.match.faults) {
        let best: { cell: number; d: number } | undefined;
        for (const p of f.cells) {
          const cell = p.y * this.size + p.x;
          const d = cellDist(cell, this.size, home);
          if (d > HOME_WORKS || d >= c.hostileSpireDist({ x: cellCentreX(cell, this.size), y: cellCentreY(cell, this.size) })) continue;
          if (!best || d < best.d || (d === best.d && c.frame.cellKey(cell) < c.frame.cellKey(best.cell))) best = { cell, d };
        }
        if (best) picks.push(best);
      }
      picks.sort((a, b) => a.d - b.d || c.frame.cellKey(a.cell) - c.frame.cellKey(b.cell));
      this.guards = picks.slice(0, this.tier.faultGuards).map((p) => p.cell);
    }
    // The guarder idle beside its wall, still rock: the fortify was refused there; the wall waits REPAIR_RETRY, like a
    // refused wall repair, instead of the guarder being sent back to it from wherever designation work took it.
    const guardable = (cell: number): boolean => this.planGrid[cell] !== CELL.bedrock && (grid[cell] === CELL.rock || grid[cell] === CELL.unknown) && !this.repairRefused.has(cell);
    const held = diggers.find((d) => d.id === this.guarder), last = this.guards.find(guardable);
    if (held && last !== undefined && held.state === 'idle' && this.beside(c, held, last)) this.repairRefused.set(last, c.obs.tick);
    const g = this.guards.find(guardable);
    if (g === undefined) return;
    // Keep the wall out of every subsequent route, and publish its approach before assigning a fortifier.
    this.planGrid[g] = CELL.bedrock;
    if (!this.openNext(grid, g, c.frame.k).some((n) => reached.has(n))) {
      const x = g % this.size;
      this.designateRoute(c, out, 'guard', (n) => n === g - this.size || n === g + this.size || (x > 0 && n === g - 1) || (x < this.size - 1 && n === g + 1), 1);
      return;
    }
    if (c.obs.res.freeAlloy < c.econ.fortifyCost) return;
    const at = { x: cellCentreX(g, this.size), y: cellCentreY(g, this.size) };
    const digger = diggers.find((d) => d.id === this.guarder && !busy.has(d.id)) ?? this.freeDigger(diggers, busy, at);
    if (!digger) return;
    busy.add(digger.id);
    if (digger.state === 'fortifying' || (digger.id === this.guarder && digger.state === 'moving')) return;
    this.guarder = digger.id;
    out.push({ kind: 'fortify', units: [digger.id], x: g % this.size, y: Math.floor(g / this.size) });
  }

  /**
   * Bulkheads only where they cut a hostile walk to our root: on the cavern route toward the centre,
   * CAVERN_GATE_MIN–CAVERN_GATE_MAX tiles out, then on the routes from holes near home (portal mouths hostile troopers drop
   * in through). A cut is one cell whose gate severs the route, else a whole straight cross-section of the passage within
   * the bulkhead budget; never a lone gate beside an open bypass. Each site is queued once per GATE_RETRY, with the
   * nearest free digger as its builder (the queue pays; teammates' bulkheads and entries count, and block hostiles
   * already).
   */
  private gates(c: Ctx, out: AgentCommandIntent[], diggers: Entity[], busy: Set<string>, reached: Set<number>, grid: readonly number[]): void {
    const tick = c.obs.tick;
    const own = c.own.filter((e) => e.kind === 'bulkhead');
    const budget = this.tier.bulkheads - own.length - c.queued('bulkhead');
    if (budget <= 0 || !c.affordable('bulkhead', SPARE_ALLOY)) return;
    const home = c.home;
    const root = this.rootCell(c);
    const wall = this.gateWall;
    this.stampSpires(c);
    this.gateHole.fill(0);
    for (const h of c.obs.holes) this.gateHole[h.y * this.size + h.x] = 1;
    // The known tunnel nearest the centre that the root's cavern leads to: where raiders come from.
    const mid = { x: this.size / 2, y: this.size / 2 };
    this.gateWalksLeft = this.tier.gateWalks;
    this.gateStarved = false;
    const anchor = this.gateAnchor(c, grid, root);
    this.gateGoal.fill(NOT_GOAL);
    // Our gates and queued sites already block hostiles.
    for (const e of own) wall[Math.floor(e.y) * this.size + Math.floor(e.x)] = 1;
    for (const q of c.obs.queue) if (q.item === 'bulkhead' && q.x !== undefined && q.y !== undefined) wall[Math.floor(q.y) * this.size + Math.floor(q.x)] = 1;
    const holes = c.obs.holes
      .map((h) => h.y * this.size + h.x)
      .filter((hc) => cellDist(hc, this.size, home) <= HOME_RADIUS && reached.has(hc))
      .sort((a, b) => cellDist(a, this.size, home) - cellDist(b, this.size, home) || c.frame.cellKey(a) - c.frame.cellKey(b));
    // What to cut off: the cavern anchor (-1), then each hole opening, nearest home first. A decision that runs out of
    // walks (tier.gateWalks) stops there; the next starts with that goal, or with the one after when it got a partial plan.
    const goals = anchor >= 0 ? [-1, ...holes] : holes;
    const first = this.gateFirst < goals.length ? this.gateFirst : 0;
    this.gateFirst = 0;
    const cuts: number[][] = [];
    for (let i = 0; i < goals.length; i++) {
      const at = (first + i) % goals.length, hc = goals[at]!;
      // A cut that got its route walk planned at least that far; one without it waits for the next decision.
      const started = this.gateWalksLeft >= 1;
      if (hc < 0) {
        this.gateGoal[anchor] = GOAL;
        const cavern = this.cut(c, grid, root, budget, (n) => n !== anchor && cellDist(n, this.size, home) >= CAVERN_GATE_MIN && cellDist(n, this.size, home) <= CAVERN_GATE_MAX, mid);
        if (cavern) cuts.push(cavern);
        this.gateGoal[anchor] = NOT_GOAL;
      } else if (!this.gateGoal[hc]) {
        // Troopers land anywhere in the opening: every hole cell joined to this one is a goal.
        const opening = [hc];
        this.gateGoal[hc] = GOAL;
        for (let j = 0; j < opening.length; j++) {
          const cell = opening[j]!;
          const x = cell % this.size;
          for (const n of [x < this.size - 1 ? cell + 1 : -1, x > 0 ? cell - 1 : -1, cell + this.size, cell - this.size]) {
            if (n < 0 || n >= this.size * this.size || !this.gateHole[n] || this.gateGoal[n]) continue;
            this.gateGoal[n] = GOAL;
            opening.push(n);
          }
        }
        const near = { x: cellCentreX(hc, this.size), y: cellCentreY(hc, this.size) };
        const mouth = this.cut(c, grid, root, budget, (n) => cellDist(n, this.size, near) <= MOUTH_GATE_REACH, near);
        if (mouth) cuts.push(mouth);
        // Done: no longer a goal, never walked again as the start of another opening.
        for (const n of opening) this.gateGoal[n] = GOAL_DONE;
      }
      if (this.gateStarved) {
        this.gateFirst = started ? (at + 1) % goals.length : at;
        break;
      }
    }
    const s = c.stats.bulkhead;
    const sites = cuts.find((cut) => cut.every((n) => (this.gateAsked.get(n) ?? -1) <= tick) && c.affordableCost(cut.length * s.alloy, cut.length * s.energy, SPARE_ALLOY));
    if (!sites) return;
    const away = sites.find((n) => !reached.has(n));
    if (away !== undefined) {
      this.designateRoute(c, out, 'gate', (n) => n === away, 2);
      return;
    }
    if (!this.freeDigger(diggers, busy, { x: cellCentreX(sites[0]!, this.size), y: cellCentreY(sites[0]!, this.size) })) return;
    for (const site of sites) {
      const digger = this.freeDigger(diggers, busy, { x: cellCentreX(site, this.size), y: cellCentreY(site, this.size) });
      this.gateAsked.set(site, tick + GATE_RETRY);
      out.push({ kind: 'queue_add', item: 'bulkhead', x: site % this.size, y: Math.floor(site / this.size), ...(digger ? { digger: digger.id } : {}) });
      if (digger) busy.add(digger.id);
      c.reserveCost(s.alloy, s.energy);
    }
  }

  /** Fresh walk walls: every Spire footprint (ours only while our root stands). */
  private stampSpires(c: Ctx): void {
    const wall = this.gateWall;
    wall.fill(0);
    for (const a of c.match.armies) {
      if (a.id === c.army && !c.segmentAlive('depths')) continue;
      const p = a.spireAt;
      const f = STATS.spire.footprint;
      for (let y = p.y - f.h / 2; y < p.y + f.h / 2; y++) for (let x = p.x - f.w / 2; x < p.x + f.w / 2; x++) wall[y * this.size + x] = 1;
    }
  }

  /** Walk from our root (gateWall as stamped, no goals): the reached known open cell nearest the centre, or -1. gatePrev keeps the walk. */
  private cavernAnchor(c: Ctx, grid: readonly number[], root: number): number {
    this.gateGoal.fill(NOT_GOAL);
    this.walkTo(c, grid, root);
    const size = this.size, prev = this.gatePrev, half = size / 2;
    const mid = { x: half, y: half };
    // Cell centres and the centre are on half tiles, so squared offsets are exact and distinct ones differ by at least
    // a quarter, far above cellDist's rounding: they order cells as cellDist does. Equal squares (mirror-image offsets)
    // compare by cellDist itself, then our frame's cell order, exactly as before.
    let anchor = -1, anchorD2 = Infinity;
    for (let n = 0; n < size * size; n++) {
      if (prev[n] === WALK_UNVISITED || n === root) continue;
      const dx = (n % size) + 0.5 - half, dy = Math.floor(n / size) + 0.5 - half, d2 = dx * dx + dy * dy;
      if (anchor >= 0 && d2 > anchorD2) continue;
      if (anchor >= 0 && d2 === anchorD2) {
        const d = cellDist(n, size, mid), was = cellDist(anchor, size, mid);
        if (d > was || (d === was && c.frame.cellKey(n) >= c.frame.cellKey(anchor))) continue;
      }
      anchor = n;
      anchorD2 = d2;
    }
    return anchor;
  }

  /**
   * cavernAnchor for gates (walls as stampSpires leaves them), kept across decisions while its walk's inputs hold:
   * every cell open or not as when it was found, and our root standing or not. Finding it afresh costs a gate walk.
   */
  private gateAnchor(c: Ctx, grid: readonly number[], root: number): number {
    const open = this.anchorOpen, alive = c.segmentAlive('depths');
    let same = this.anchorKept && this.anchorAlive === alive;
    for (let n = 0; same && n < open.length; n++) {
      // isOpenCell, inlined.
      const code = grid[n];
      if ((code === CELL.tunnel || code === CELL.rail || code === CELL.bridge ? 1 : 0) !== open[n]) same = false;
    }
    if (same) return this.anchorAt;
    this.anchorKept = false;
    if (!this.gateWalk()) return -1;
    this.anchorAt = this.cavernAnchor(c, grid, root);
    this.anchorAlive = alive;
    this.anchorKept = true;
    for (let n = 0; n < open.length; n++) open[n] = isOpenCell(grid[n]!) ? 1 : 0;
    return this.anchorAt;
  }

  /**
   * The cavern route from our root to the centre (cells after the root, walking order) and the Warden post on it: in
   * the WARDEN_POST band from home, the nearest-home 1-wide tunnel cell (two open neighbours at most), else the band's
   * first route cell; never on our own bulkhead.
   */
  private planPost(c: Ctx, grid: readonly number[]): void {
    const root = this.rootCell(c);
    this.stampSpires(c);
    const anchor = this.cavernAnchor(c, grid, root);
    this.route = [];
    this.post = -1;
    if (anchor < 0) return;
    for (let n = anchor; n >= 0 && n !== root; n = this.gatePrev[n]!) this.route.push(n);
    this.route.reverse();
    const home = c.home;
    const gates = new Set(c.own.filter((e) => e.kind === 'bulkhead').map((e) => Math.floor(e.y) * this.size + Math.floor(e.x)));
    let first = -1;
    for (const n of this.route) {
      const d = cellDist(n, this.size, home);
      if (d < WARDEN_POST_MIN || d > WARDEN_POST_MAX || !isOpenCell(grid[n]!) || gates.has(n)) continue;
      if (first < 0) first = n;
      if (this.openNext(grid, n, c.frame.k).length <= 2) {
        this.post = n;
        return;
      }
    }
    this.post = first;
  }

  /** Route cell `back` steps toward home from route cell `cell` (the cell itself off the route or at its start). */
  private behind(cell: number, back: number): number {
    const i = this.route.indexOf(cell);
    return i < 0 ? cell : this.route[Math.max(0, i - back)]!;
  }

  /**
   * Wardens hold the post (or, pushing, advance to `goal`; or, `raid` ≥ 0, WARDEN_RAID_PAIR of them advance to that cell
   * while the rest hold; or, `alarm` ≥ 0 and not pushing, the holders close on that intruder cell): any enemy within
   * WARDEN_ALERT raises the shield wall where they stand; WARDEN_CALM without one lowers it. Advancing, a ready Warden
   * first flares the farthest route cell ahead in flare range (an unknown corner). At its spot an idle Warden fortifies
   * a rock wall beside it. Returns where the troopers should stand (behind the Wardens at the post or the push, in
   * cover), or -1.
   */
  private wardensAct(c: Ctx, out: AgentCommandIntent[], posted: Entity[], busy: Set<string>, grid: readonly number[], pushing: boolean, goal: number, raid: number, alarm: number): number {
    // Wardens committed earlier in this decision (fleeing the Mother Lode fuse, say) take no post, raid, wall or fortify order.
    const wardens = posted.filter((w) => !busy.has(w.id));
    const tick = c.obs.tick;
    const target = pushing ? goal : this.post;
    const raiders = !pushing && raid >= 0 ? Math.min(WARDEN_RAID_PAIR, wardens.length) : 0;
    const respond = !pushing && alarm >= 0;
    if (!wardens.length || (target < 0 && raiders === 0 && !respond)) return -1;
    const lead = raiders > 0 ? raid : target >= 0 ? target : alarm;
    const at = { x: cellCentreX(lead, this.size), y: cellCentreY(lead, this.size) };
    const cellOf = (e: Pt): number => Math.floor(e.y) * this.size + Math.floor(e.x);
    // Nearest the lead cell first: the raiders are the Wardens nearest their raid.
    const order = [...wardens].sort((a, b) => dist(a, at) - dist(b, at) || c.frame.cellKey(cellOf(a)) - c.frame.cellKey(cellOf(b)));
    // Static enemy walls do not keep a defensive deployment up forever once mobile threats have gone.
    const foes = c.foes.filter((e) => e.plane === 'depths' && e.kind !== 'spire' && c.statsOf(e).speed > 0
      && !(e.kind === 'warden' && (e.state === 'walled' || e.state === 'walling')));
    const wall: string[] = [];
    const unwall: string[] = [];
    const range = c.econ.flareRange;
    for (const [i, w] of order.entries()) {
      busy.add(w.id);
      if (foes.some((f) => dist(f, w) <= WARDEN_ALERT)) {
        this.threatAt.set(w.id, tick);
        if (!w.deployBlocked && w.state !== 'walling' && w.state !== 'walled' && w.state !== 'unwalling') wall.push(w.id);
        continue;
      }
      if (w.state === 'walling' || w.state === 'walled') {
        if (tick - (this.threatAt.get(w.id) ?? 0) >= WARDEN_CALM) unwall.push(w.id);
        continue;
      }
      if (w.state === 'unwalling') continue;
      const raider = i < raiders;
      const goalCell = raider ? raid : respond ? alarm : target;
      if (goalCell < 0) continue;
      const spot = raider || !respond ? this.behind(goalCell, raider ? i : i - raiders) : alarm;
      const sx = cellCentreX(spot, this.size);
      const sy = cellCentreY(spot, this.size);
      // Before advancing: light the corner ahead.
      if ((pushing || raider) && (w.abilityReady === undefined || w.abilityReady <= tick)) {
        const here = this.route.indexOf(cellOf(w));
        let flare = -1;
        if (here >= 0) for (let k = here + 1; k < this.route.length; k++) {
          const n = this.route[k]!;
          const d = dist(w, { x: cellCentreX(n, this.size), y: cellCentreY(n, this.size) });
          if (d > range) break;
          if (d >= WARDEN_FLARE_MIN) flare = n;
        }
        if (flare >= 0) out.push({ kind: 'flare', unit: w.id, x: cellCentreX(flare, this.size), y: cellCentreY(flare, this.size) });
      }
      if (dist(w, { x: sx, y: sy }) > WARDEN_AT) {
        if (w.state !== 'moving' || w.tx !== sx || w.ty !== sy) out.push({ kind: 'move', units: [w.id], x: sx, y: sy, mode: 'fight' });
        continue;
      }
      // At its spot: harden the choke's rock walls (free; Wardens fortify twice a digger's rate).
      if (w.state === 'fortifying') continue;
      // Neighbours in our frame's order (+x, −x, +y, −y canonical), so rotated Wardens harden rotated walls.
      let rock = -1;
      for (let k = 0; k < 4 && rock < 0; k++) {
        const n = this.frameStep(c.frame.k, spot, k);
        if (n >= 0 && grid[n] === CELL.rock && this.planGrid[n] !== CELL.bedrock) rock = n;
      }
      if (rock >= 0 && c.obs.res.freeAlloy >= c.econ.fortifyCost) out.push({ kind: 'fortify', units: [w.id], x: rock % this.size, y: Math.floor(rock / this.size) });
    }
    // With the wall switched off (rules.depths.wallEnabled) Wardens just fight and fortify.
    if (wall.length && c.econ.wallEnabled) out.push({ kind: 'deploy', units: wall, on: true });
    if (unwall.length) out.push({ kind: 'deploy', units: unwall, on: false });
    return target < 0 ? -1 : this.behind(target, wardens.length - raiders - 1 + TROOPER_BEHIND);
  }

  /**
   * Where Wardens without troopers raid: the latest remembered hostile digger our tunnels reach (ties in our frame's
   * cell order), else the centre end of the cavern route (contesting the centre chamber); -1 before the route is known.
   */
  private raidCell(c: Ctx, reached: ReadonlySet<number>): number {
    let best = -1;
    let seen = -1;
    for (const d of this.diggersSeen.values()) {
      const cell = c.frame.pointCell(d.x, d.y);
      if (!reached.has(cell)) continue;
      if (d.tick > seen || (d.tick === seen && c.frame.cellKey(cell) < c.frame.cellKey(best))) {
        best = cell;
        seen = d.tick;
      }
    }
    return best >= 0 ? best : this.route.at(-1) ?? -1;
  }

  /** The 4-neighbour of `at` in canonical direction k (0 +x, 1 −x, 2 +y, 3 −y) of `frame`, or -1 off the map. */
  private frameStep(frame: number, at: number, k: number): number {
    const d = frameDir(frame, k);
    const step = (d % 2 === 0 ? 1 : -1) * (d < 2 ? 1 : this.size);
    const x = at % this.size;
    if ((step === 1 && x === this.size - 1) || (step === -1 && x === 0)) return -1;
    const n = at + step;
    return n < 0 || n >= this.size * this.size ? -1 : n;
  }

  /** walkTo's four steps in our frame's order (frameStep): cell offsets. */
  private readonly walkSteps = new Int32Array(4);

  /**
   * Walk known open cells from `from`, never into gateWall cells; the first GOAL cell reached, or -1. gatePrev
   * keeps each visited cell's parent. Neighbours are stepped to in our frame's order, so rotated layouts walk rotated paths.
   */
  private walkTo(c: Ctx, grid: readonly number[], from: number): number {
    const prev = this.gatePrev, queue = this.gateQueue, wall = this.gateWall, goal = this.gateGoal;
    const size = this.size, cells = size * size;
    prev.fill(WALK_UNVISITED);
    if (wall[from] || !isOpenCell(grid[from]!)) return -1;
    // frameStep's steps, inlined: ±1 never crosses the map's side edge, ±size never leaves the map.
    const steps = this.walkSteps;
    for (let k = 0; k < 4; k++) {
      const d = frameDir(c.frame.k, k);
      steps[k] = (d % 2 === 0 ? 1 : -1) * (d < 2 ? 1 : size);
    }
    prev[from] = WALK_START;
    queue[0] = from;
    for (let head = 0, tail = 1; head < tail; head++) {
      const at = queue[head]!;
      if (goal[at] === GOAL) return at;
      const x = at % size;
      for (let k = 0; k < 4; k++) {
        const step = steps[k]!;
        if ((step === 1 && x === size - 1) || (step === -1 && x === 0)) continue;
        const n = at + step;
        if (n < 0 || n >= cells || prev[n] !== WALK_UNVISITED || wall[n]) continue;
        // isOpenCell, inlined.
        const code = grid[n];
        if (code !== CELL.tunnel && code !== CELL.rail && code !== CELL.bridge) continue;
        prev[n] = at;
        queue[tail++] = n;
      }
    }
    return -1;
  }

  /** Spend one of this decision's gate walks (tier.gateWalks); false, and the plan marked starved, when none is left. */
  private gateWalk(): boolean {
    if (this.gateWalksLeft < 1) {
      this.gateStarved = true;
      return false;
    }
    this.gateWalksLeft--;
    return true;
  }

  /**
   * The cheapest gate set that cuts the walk from our root to the gateGoal cells: the single route cell (`inside`
   * picks where) nearest `prefer` whose bulkhead severs it, else the straight cross-section through a route cell
   * (every open cell of its row or column run) of at most `budget` cells that severs it, smallest then nearest
   * `prefer`. Gates go on plain tunnel cells without a hole, never on a goal. null: the route is already cut, or no cut fits.
   * Each whole-map walk is one of the decision's gate walks (gateWalk); with none left, the best cut proven so far stands.
   */
  private cut(c: Ctx, grid: readonly number[], root: number, budget: number, inside: (n: number) => boolean, prefer: Pt): number[] | null {
    if (!this.gateWalk()) return null;
    const reach = this.walkTo(c, grid, root);
    if (reach < 0) return null;
    const gateable = (n: number): boolean => grid[n] === CELL.tunnel && !this.gateHole[n] && !this.gateWall[n];
    const route: number[] = [];
    for (let n = this.gatePrev[reach]!; n >= 0 && n !== root; n = this.gatePrev[n]!) if (inside(n) && gateable(n)) route.push(n);
    const severs = (cells: readonly number[]): boolean => {
      // A lone gate whose open neighbours join around it never severs anything: no walk needed.
      if (cells.length === 1 && this.bypassed(grid, cells[0]!)) return false;
      if (!this.gateWalk()) return false;
      for (const n of cells) this.gateWall[n] = 1;
      const open = this.walkTo(c, grid, root) >= 0;
      for (const n of cells) this.gateWall[n] = 0;
      return !open;
    };
    let best: number[] | null = null;
    let bestScore = Infinity;
    let bestKey = Infinity;
    const consider = (cells: number[]): void => {
      const at = { x: 0, y: 0 };
      let key = Infinity;
      for (const n of cells) {
        at.x += cellCentreX(n, this.size) / cells.length;
        at.y += cellCentreY(n, this.size) / cells.length;
        key = Math.min(key, c.frame.cellKey(n));
      }
      const score = dist(at, prefer);
      if (best && (cells.length > best.length || (cells.length === best.length && (score > bestScore || (score === bestScore && key >= bestKey))))) return;
      if (!severs(cells)) return;
      best = cells;
      bestScore = score;
      bestKey = key;
    };
    for (const n of route) consider([n]);
    if (best || budget < 2) return best;
    const runs = new Set<number>();
    for (const n of route) {
      for (const step of [1, this.size]) {
        // The whole open run along this axis: a cross-section of the passage, or no seal.
        let first = n;
        while ((step === this.size || first % this.size > 0) && first - step >= 0 && isOpenCell(grid[first - step]!) && !this.gateWall[first - step]) first -= step;
        if (runs.has(first * 2 + (step === 1 ? 0 : 1))) continue;
        runs.add(first * 2 + (step === 1 ? 0 : 1));
        const cells: number[] = [];
        let ok = true;
        for (let m = first; ; m += step) {
          if (cells.length === budget || !gateable(m) || this.gateGoal[m] === GOAL) {
            ok = false;
            break;
          }
          cells.push(m);
          const next = m + step;
          if ((step === 1 && m % this.size === this.size - 1) || next >= this.size * this.size || !isOpenCell(grid[next]!) || this.gateWall[next]) break;
        }
        // Our frame's order, so rotated seals queue their cells in rotated order.
        if (ok) consider(cells.sort((a, b) => c.frame.cellKey(a) - c.frame.cellKey(b)));
      }
    }
    return best;
  }

  /** The 8 cells around a cell in ring order (each 4-adjacent to the next, cyclically): dx, dy pairs; even entries are its 4-neighbours. */
  private static readonly RING = [1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1, 0, -1, 1, -1] as const;

  /**
   * Whether walkTo's open 4-neighbours of `cell` all join through open, unwalled cells of the ring around it, so that
   * a gate on `cell` alone cuts no walk between other cells (any walk through it steps round it instead).
   */
  private bypassed(grid: readonly number[], cell: number): boolean {
    const size = this.size, x = cell % size, y = Math.floor(cell / size), ring = DepthsBot.RING;
    let closedAt = -1;
    let open = 0;
    for (let i = 0; i < 8; i++) {
      const nx = x + ring[2 * i]!, ny = y + ring[2 * i + 1]!, n = ny * size + nx;
      const code = nx >= 0 && nx < size && ny >= 0 && ny < size && !this.gateWall[n] ? grid[n] : -1;
      if (code === CELL.tunnel || code === CELL.rail || code === CELL.bridge) open |= 1 << i;
      else if (closedAt < 0) closedAt = i;
    }
    if (closedAt < 0) return true;
    // Arcs of open ring cells, counted from a closed one: every open 4-neighbour must lie on the same arc.
    let arc = 0, arcOf = -1;
    for (let j = 1; j <= 8; j++) {
      const i = (closedAt + j) % 8;
      if (!(open & (1 << i))) continue;
      if (!(open & (1 << ((i + 7) % 8)))) arc++;
      if (i % 2 === 0) {
        if (arcOf >= 0 && arcOf !== arc) return false;
        arcOf = arc;
      }
    }
    return true;
  }

  /**
   * Repair our walls that crack: a known rock or fortified cell next to our tunnels within HOME_WORKS tiles of home,
   * cracked to REPAIR_STAGE or more, with none of our diggers working next to it (then the digging is someone else's).
   * Fortifying clears the damage and hardens it. At most REPAIRS_MAX repairs at once.
   */
  private repairWalls(c: Ctx, out: AgentCommandIntent[], diggers: Entity[], busy: Set<string>, reached: Set<number>, grid: readonly number[]): void {
    const tick = c.obs.tick;
    for (const [cell, r] of this.repairs) {
      const d = diggers.find((x) => x.id === r.id);
      const idle = !!d && d.state === 'idle' && tick - r.at > REPAIR_IDLE;
      // Idle beside the wall with it still cracked, the fortify was refused there: the cell waits REPAIR_RETRY. Sent
      // again at once, the digger walked back from wherever designation work had taken it, and was refused again.
      if (d && d.state === 'idle' && this.beside(c, d, cell) && c.obs.cracks.some((k) => k.y * this.size + k.x === cell)) this.repairRefused.set(cell, tick);
      if (!d || tick - r.at > REPAIR_TIMEOUT || idle || this.repairRefused.has(cell)) this.repairs.delete(cell);
      else busy.add(r.id);
    }
    for (const [cell, at] of this.repairRefused) if (tick - at >= REPAIR_RETRY) this.repairRefused.delete(cell);
    if (this.repairs.size >= REPAIRS_MAX || c.obs.res.freeAlloy < c.econ.fortifyCost) return;
    const home = c.home;
    const working = diggers.filter((d) => d.state === 'digging' || d.state === 'mining' || d.state === 'fortifying');
    const walls = c.obs.cracks
      .filter((k) => k.stage >= REPAIR_STAGE)
      .map((k) => k.y * this.size + k.x)
      .filter((cell) => {
        if (this.planGrid[cell] === CELL.bedrock || this.repairs.has(cell) || this.repairRefused.has(cell) || (grid[cell] !== CELL.rock && grid[cell] !== CELL.fortified)) return false;
        if (cellDist(cell, this.size, home) > HOME_WORKS || !this.openNext(grid, cell, c.frame.k).some((n) => reached.has(n))) return false;
        return !working.some((d) => cellDist(cell, this.size, d) < WALL_WORK_REACH);
      })
      .sort((a, b) => cellDist(a, this.size, home) - cellDist(b, this.size, home) || c.frame.cellKey(a) - c.frame.cellKey(b));
    for (const cell of walls) {
      if (this.repairs.size >= REPAIRS_MAX) break;
      const digger = this.freeDigger(diggers, busy, { x: cellCentreX(cell, this.size), y: cellCentreY(cell, this.size) });
      if (!digger) return;
      busy.add(digger.id);
      this.repairs.set(cell, { id: digger.id, at: tick });
      out.push({ kind: 'fortify', units: [digger.id], x: cell % this.size, y: Math.floor(cell / this.size) });
    }
  }

  /**
   * Opened lode pockets with ore left (our Headframe there, or with `steal` a contested one a hostile opened): keep up
   * to tier.lodeMiners diggers mining there (`mine` at the lode), nearest pocket first.
   */
  private mineLodes(c: Ctx, out: AgentCommandIntent[], diggers: Entity[], busy: Set<string>, reached: Set<number>, grid: readonly number[]): void {
    const home = c.home;
    const left = (l: Pt): boolean => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && (grid[(l.y + dy) * this.size + l.x + dx] === CELL.ore || grid[(l.y + dy) * this.size + l.x + dx] === CELL.unknown)) return true;
      return false;
    };
    const ours = (l: Pt): boolean => c.own.some((e) => e.kind === 'headframe' && dist(e, { x: l.x + 0.5, y: l.y + 0.5 }) < LODE_SITE_REACH);
    const lodes = c.obs.lodes
      .filter((l) => l.open && left(l) && (ours(l) || (this.tier.steal && l.rich)))
      .sort((a, b) => cellDist(a.y * this.size + a.x, this.size, home) - cellDist(b.y * this.size + b.x, this.size, home)
        || c.frame.cellKey(a.y * this.size + a.x) - c.frame.cellKey(b.y * this.size + b.x));
    const open = new Set(lodes.map((l) => l.y * this.size + l.x));
    const alive = new Set(diggers.map((d) => d.id));
    for (const [id, cell] of this.lodeCrew) {
      if (!alive.has(id) || !open.has(cell) || busy.has(id)) this.lodeCrew.delete(id);
      else if (!this.workerRoutes.canServe(diggers.find((d) => d.id === id)!, cell, true)) {
        this.workerRedirect.add(id);
        this.lodeCrew.delete(id);
        this.crewRejoinAt.set(id, c.obs.tick + CREW_REJOIN);
      }
    }
    for (const l of lodes) {
      const cell = l.y * this.size + l.x;
      const at = { x: l.x + 0.5, y: l.y + 0.5 };
      const beside = (n: number): boolean => {
        const dx = Math.abs(n % this.size - l.x);
        const dy = Math.abs(Math.floor(n / this.size) - l.y);
        return Math.max(dx, dy) === 2 && Math.min(dx, dy) <= 1;
      };
      // The ring `beside` accepts: its in-map cells, looked up in `reached` (not the other way round).
      let accessible = false;
      for (let dy = -2; dy <= 2 && !accessible; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = l.x + dx, y = l.y + dy;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2 || Math.min(Math.abs(dx), Math.abs(dy)) > 1 || x < 0 || x >= this.size || y < 0 || y >= this.size) continue;
        if (reached.has(y * this.size + x)) {
          accessible = true;
          break;
        }
      }
      if (!accessible) {
        this.designateRoute(c, out, `lode:${cell}`, beside, 1, true);
        continue;
      }
      while (this.lodeCrew.size < this.tier.lodeMiners) {
        const d = this.freeDigger(diggers.filter((x) => !this.lodeCrew.has(x.id) && this.rejoins(c, x) && this.workerRoutes.canServe(x, cell, true)), busy, at);
        if (!d) break;
        this.lodeCrew.set(d.id, cell);
        this.workerRedirect.delete(d.id);
        this.workerSafeMines.delete(d.id);
        out.push({ kind: 'mine', units: [d.id], ...at });
      }
    }
    for (const [id, cell] of this.lodeCrew) {
      busy.add(id);
      const d = diggers.find((x) => x.id === id);
      if (d && d.state === 'idle') out.push({ kind: 'mine', units: [id], x: cellCentreX(cell, this.size), y: cellCentreY(cell, this.size) });
    }
  }

  /**
   * The Mother Lode (the CELL.lode cells we know; none known, no crew): keep up to tier.motherCrew diggers mining it, at
   * most rules.depths.motherLodeCrewPerCell per lode cell and only beyond MOTHER_LODE_HOME diggers at home. Only cells on
   * our side count (nearer our Spire than every hostile one): crews meeting at a shared cell brawl and bleed both
   * economies. A cell exactly as near a hostile Spire is contested: `steal` tiers take it once no hostile depths unit has
   * been seen near it for LODE_CONTEST_CALM, and no cell a member found a hostile holding counts for that long either.
   * A new member goes (`mine` at its cell) to the cell with the fewest members, nearest home first; idle members are
   * sent again and lost ones replaced. A member whose cell no longer counts, or that waits beside a cell a hostile holds
   * (state contested), leaves the crew to mine elsewhere; one whose way there turned unsafe rests for CREW_REJOIN. The
   * shared pressure (obs.motherLode) caps the crew (lodeCap).
   */
  private mineMotherLode(c: Ctx, out: AgentCommandIntent[], diggers: Entity[], busy: Set<string>, reached: Set<number>): void {
    const home = c.home, tick = c.obs.tick;
    for (const [id, cell] of this.motherCrew) if (diggers.find((d) => d.id === id)?.state === 'contested') this.lodeHeld.set(cell, tick);
    // Squared distances are exact here: Spire centres and cell centres sit on half tiles, so the mirror ties exactly.
    const cells = this.motherCells.filter((cell) => {
      const at = { x: cellCentreX(cell, this.size), y: cellCentreY(cell, this.size) };
      const ours = dmath.pow(at.x - home.x, 2) + dmath.pow(at.y - home.y, 2);
      let theirs = Infinity;
      for (const a of c.hostiles) theirs = Math.min(theirs, dmath.pow(at.x - a.spireAt.x, 2) + dmath.pow(at.y - a.spireAt.y, 2));
      if (ours > theirs || (ours === theirs && !this.tier.steal)) return false;
      if (ours === theirs && c.foes.some((e) => e.plane === 'depths' && e.kind !== 'spire' && dist(e, at) < MINER_GUARD_RADIUS)) this.lodeHeld.set(cell, tick);
      return tick - (this.lodeHeld.get(cell) ?? -LODE_CONTEST_CALM) >= LODE_CONTEST_CALM;
    });
    const cap = this.lodeCap(c);
    const want = Math.max(0, Math.min(this.tier.motherCrew, cap, cells.length * c.match.rules.depths.motherLodeCrewPerCell, diggers.length - MOTHER_LODE_HOME));
    const byId = new Map(diggers.map((d) => [d.id, d]));
    const sent = new Set<string>();
    // The first members (sent first: nearest home) stay when the crew shrinks.
    let kept = 0;
    for (const [id, cell] of this.motherCrew) {
      const d = byId.get(id);
      const gone = !d || busy.has(id);
      const unsafe = !!d && !this.workerRoutes.canCrew(d, cell);
      const leave = !cells.includes(cell) || d?.state === 'contested' || unsafe;
      const extra = !gone && !leave && kept >= want;
      // Ore near home first: plain auto-mining would walk straight back to a lode cell a hostile holds (or one about to vent).
      if (!gone && (leave || extra)) {
        if (unsafe) {
          this.workerRedirect.add(id);
          this.crewRejoinAt.set(id, tick + CREW_REJOIN);
        } else out.push({ kind: 'mine', units: [id], x: home.x, y: home.y });
        sent.add(id);
      }
      if (gone || leave || extra) this.motherCrew.delete(id);
      else kept++;
    }
    // At the cap nobody else mines there either: auto-miners beside a lode cell go back to ore near home.
    if (cap <= this.motherCrew.size) {
      for (const d of diggers) {
        if (busy.has(d.id) || sent.has(d.id) || this.motherCrew.has(d.id) || (d.state !== 'mining' && d.state !== 'contested')) continue;
        const x = Math.floor(d.x);
        const y = Math.floor(d.y);
        let beside = false;
        for (const l of this.motherCells) beside ||= Math.abs((l % this.size) - x) <= 1 && Math.abs(Math.floor(l / this.size) - y) <= 1;
        if (beside) out.push({ kind: 'mine', units: [d.id], x: home.x, y: home.y });
      }
    }
    if (want === 0) return;
    // The open ring around the lode: our known tunnels must reach it, else publish a route there first.
    const ring = new Set<number>();
    for (const l of cells) for (const n of this.openNext(this.planGrid, l, c.frame.k)) ring.add(n);
    let accessible = false;
    for (const n of ring) if (reached.has(n)) accessible = true;
    if (!accessible) {
      this.designateRoute(c, out, 'mother', (n) => ring.has(n), 1, true);
      return;
    }
    const count = new Map<number, number>();
    for (const [id, cell] of this.motherCrew) {
      busy.add(id);
      count.set(cell, (count.get(cell) ?? 0) + 1);
      if (byId.get(id)?.state === 'idle') out.push({ kind: 'mine', units: [id], x: cellCentreX(cell, this.size), y: cellCentreY(cell, this.size) });
    }
    const order = cells.filter((cell) => diggers.some((d) => !busy.has(d.id) && this.rejoins(c, d) && this.workerRoutes.canCrew(d, cell)))
      .sort((a, b) => cellDist(a, this.size, home) - cellDist(b, this.size, home) || c.frame.cellKey(a) - c.frame.cellKey(b));
    if (!order.length) return;
    while (this.motherCrew.size < want) {
      let cell = order[0]!;
      for (const l of order) if ((count.get(l) ?? 0) < (count.get(cell) ?? 0)) cell = l;
      const at = { x: cellCentreX(cell, this.size), y: cellCentreY(cell, this.size) };
      const d = this.freeDigger(diggers.filter((d) => this.rejoins(c, d) && this.workerRoutes.canCrew(d, cell)), busy, at);
      if (!d) break;
      busy.add(d.id);
      this.motherCrew.set(d.id, cell);
      this.workerRedirect.delete(d.id);
      this.workerSafeMines.delete(d.id);
      count.set(cell, (count.get(cell) ?? 0) + 1);
      out.push({ kind: 'mine', units: [d.id], ...at });
    }
  }

  /**
   * Crew cap from the Mother Lode's public pressure (no cap without it): none while it cools; while its fuse burns
   * (state critical: it vents at `ventAt` whatever anyone does) none, unless `overMine` and a hostile digger is in sight
   * beside a lode cell: then one greedy digger keeps mining, betting the enemy crew stays to be caught too; from
   * lodeWarn while the pressure still rises, one (about break-even).
   */
  private lodeCap(c: Ctx): number {
    const lode = c.obs.motherLode;
    if (!lode) return Infinity;
    if (lode.state === 'cooling') return 0;
    if (lode.state === 'critical') {
      const enemyCrew = this.tier.overMine && c.foes.some((e) => e.plane === 'depths' && e.kind === 'digger'
        && this.motherCells.some((l) => Math.abs(cellCentreX(l, this.size) - e.x) <= 1.5 && Math.abs(cellCentreY(l, this.size) - e.y) <= 1.5));
      return enemyCrew ? 1 : 0;
    }
    return lode.state === 'warn' && lode.rate > 0 ? 1 : Infinity;
  }

  /**
   * While the Mother Lode's fuse burns (public `motherLode.ventAt`): every own Depths unit in or bound for its blast
   * (within the map's ringWidth + rules.depths.lodeVentBlastReach + LODE_FLEE_MARGIN cells of a known lode cell) walks
   * to the root and stays out of every other job until the vent; the crew member an `overMine` tier keeps gambling
   * (lodeCap: the first ones sent, as mineMotherLode keeps) stays. Runs before every other job takes units.
   */
  private fleeLode(c: Ctx, out: AgentCommandIntent[], busy: Set<string>): void {
    if (c.obs.motherLode?.ventAt === undefined || this.motherCells.length === 0) {
      this.fleeing.clear();
      return;
    }
    const reach = c.match.rules.map.motherLode.ringWidth + c.match.rules.depths.lodeVentBlastReach + LODE_FLEE_MARGIN;
    const near = (x: number, y: number): boolean => this.motherCells.some((l) => Math.max(Math.abs((l % this.size) - Math.floor(x)), Math.abs(Math.floor(l / this.size) - Math.floor(y))) <= reach);
    const keep = new Set([...this.motherCrew.keys()].slice(0, this.lodeCap(c)));
    const root = this.rootCell(c);
    const x = cellCentreX(root, this.size);
    const y = cellCentreY(root, this.size);
    const run: Entity[] = [];
    for (const e of c.own) {
      if (e.plane !== 'depths' || !isUnitKind(e.kind) || busy.has(e.id) || keep.has(e.id)) continue;
      if (!this.fleeing.has(e.id) && !near(e.x, e.y) && !(e.tx !== undefined && e.ty !== undefined && near(e.tx, e.ty))) continue;
      this.fleeing.add(e.id);
      busy.add(e.id);
      if (e.state !== 'moving' || e.tx !== x || e.ty !== y) run.push(e);
    }
    if (run.length) out.push({ kind: 'move', units: ids(run), x, y, mode: 'move' });
  }

  /** Pick a fault cell on the focus's side across its lanes, dig to it, then undermine it. */
  private openFault(c: Ctx, out: AgentCommandIntent[], sappers: Entity[], busy: Set<string>, reached: Set<number>): void {
    const grid = c.obs.depths ?? [];
    // A new focus (the old one eliminated) gets its own fault.
    if (this.fault >= 0 && this.faultFoe !== c.focus.id) this.fault = -1;
    if (this.fault < 0) {
      this.faultFoe = c.focus.id;
      const foe = c.foeAt;
      // Its main lane: its forward point, toward the map centre in its frame.
      const lane = c.foeFrame.offset(foe, FRONT_OFFSET, FRONT_OFFSET);
      let score = Infinity;
      for (const f of c.match.faults) {
        f.cells.forEach((p, i) => {
          const n = p.y * this.size + p.x;
          const d = cellDist(n, this.size, foe);
          // A cell with room for a full chasm both ways, FAULT_MIN–FAULT_MAX tiles from their Spire, nearest their main lane.
          const room = Math.min(FAULT_END_ROOM, f.cells.length >> 1);
          if (i < room || i >= f.cells.length - room || d < FAULT_MIN || d > FAULT_MAX) return;
          const s = cellDist(n, this.size, lane);
          if (s < score || (s === score && c.frame.cellKey(n) < c.frame.cellKey(this.fault))) {
            score = s;
            this.fault = n;
          }
        });
      }
      if (this.fault < 0) {
        this.faultDone = true;
        return;
      }
    }
    const at = { x: this.fault % this.size, y: Math.floor(this.fault / this.size) };
    if (c.obs.holes.some((h) => h.y * this.size + h.x === this.fault) || c.obs.charges.some((ch) => ch.side === c.army && ch.x === at.x && ch.y === at.y)) {
      this.faultDone = true;
      return;
    }
    if (!isOpenCell(grid[this.fault]!) || !reached.has(this.fault)) {
      this.designateRoute(c, out, 'fault', (n) => n === this.fault, 1);
      return;
    }
    const sapper = sappers.find((s) => s.state === 'idle');
    if (!sapper) return;
    busy.add(sapper.id);
    out.push({ kind: 'undermine', units: [sapper.id], ...at });
  }
}
