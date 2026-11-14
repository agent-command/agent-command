/**
 * Observer auto-director (DESIGN §2.4 "Auto-director"): an interest model over what the shown perspective can see,
 * a cut policy (dwell, hysteresis, revisit cooldowns, urgent moments, quiet-time establishing shots, fairness across
 * armies) and a camera operator that frames the chosen shot with eased, speed-limited moves, plane dives and a slow
 * drift while holding.
 *
 * Fog: the director reads only the shown projection (an army lens or a fogged stream is already filtered) plus, for
 * the omniscient `all` perspective, every army's own event window. A perspective change forgets everything. It never
 * reads `charges`, `schedule` or `memory`: a lens over the omniscient world passes those through unfiltered.
 * Preallocated: ingest, decide and the camera frame allocate nothing.
 */
import { KINDS, MAX_ARMIES, PLANES, STATS, STRUCTURE_KINDS, TICK_RATE, UNIT_KINDS, type EventKind, type FxKind, type GameEvent, type Kind, type Plane } from '@agent-command/game/contract';
import type { MatchView } from './match-view.ts';
import { wx, wz } from './world/common.ts';

/** How long and how eagerly the director holds a shot, and how its camera moves (ms of playback, tiles, seconds). */
export interface DirectorPreset {
  readonly name: 'live' | 'stream';
  /** Shortest hold of an action shot before an ordinary cut. */
  readonly minDwellMs: number;
  /** After this, any other shot worth showing wins (variety over one endless fight). */
  readonly maxDwellMs: number;
  /** An urgent moment elsewhere (elimination, crown lost, eruption) may cut in once the shot is this old. */
  readonly urgentDwellMs: number;
  /** Hold after cutting to an urgent moment, whatever else happens. */
  readonly urgentHoldMs: number;
  /** A rival shot must score this many times the shot on screen, plus `cutMargin`, to cut away from it. */
  readonly cutRatio: number;
  readonly cutMargin: number;
  /** The shot on screen must stay quiet this long before the director leaves it. */
  readonly quietMs: number;
  /** Hold of an establishing (overview or army spotlight) shot. */
  readonly overviewMs: number;
  /** A breather overview this often while nothing is hot (0: only when quiet). */
  readonly overviewEveryMs: number;
  /** Interest that interrupts an establishing shot. */
  readonly hot: number;
  /** Framing: the action's radius times this fits the HUD-safe clear area. */
  readonly padding: number;
  /** Smallest framed radius (tiles): never closer than a squad's surroundings. */
  readonly minRadius: number;
  /** Pan speed limit, in camera distances per second. */
  readonly panSpeed: number;
  /** Camera spring time constant (s): larger is lazier. */
  readonly settleS: number;
  /** Drift (orbit) while holding, radians of yaw per second. */
  readonly driftRadS: number;
}

/** The observer's default: quick to follow the action. */
export const DIRECTOR_LIVE: DirectorPreset = {
  name: 'live', minDwellMs: 4500, maxDwellMs: 20_000, urgentDwellMs: 1500, urgentHoldMs: 6000, cutRatio: 1.4, cutMargin: 2,
  quietMs: 2500, overviewMs: 6000, overviewEveryMs: 0, hot: 14, padding: 1.25, minRadius: 7, panSpeed: 1.4, settleS: 0.55, driftRadS: 0.025,
};
/** Watch live, stream mode and broadcast capture: longer holds, regular overviews, roomier HUD-safe framing, slower moves. */
export const DIRECTOR_STREAM: DirectorPreset = {
  name: 'stream', minDwellMs: 7000, maxDwellMs: 30_000, urgentDwellMs: 2500, urgentHoldMs: 9000, cutRatio: 1.6, cutMargin: 3,
  quietMs: 4000, overviewMs: 9000, overviewEveryMs: 75_000, hot: 18, padding: 1.45, minRadius: 9, panSpeed: 1, settleS: 0.8, driftRadS: 0.018,
};

/** Why the shot on screen was chosen (the director button's `data-shot`). */
export type ShotReason = 'overview' | 'spotlight' | 'fight' | 'spire' | 'objective' | 'hazard' | 'push' | 'elimination';
/** Tag codes per grid cell, in ShotReason order (0: none). */
const REASONS: readonly ShotReason[] = ['overview', 'spotlight', 'fight', 'spire', 'objective', 'hazard', 'push', 'elimination'];
const R = { fight: 2, spire: 3, objective: 4, hazard: 5, push: 6, elimination: 7 } as const;

/** The current shot; mutated in place. */
export interface Shot {
  active: boolean;
  /** Increments on every cut. */
  id: number;
  plane: Plane;
  /** Tile centre and framed radius (tiles). */
  x: number;
  y: number;
  radius: number;
  /** Playback time (ms) of the cut. */
  since: number;
  reason: ShotReason;
  /** Interest when chosen. */
  score: number;
  /** Armies in the shot, bit i = match.armies[i]. */
  armies: number;
}

// ---------------------------------------------------------------- interest model

const CELL_TILES = 4;
/** Heat from effects and events decays with this time constant (game ticks): a fight stays warm a few seconds. */
const HEAT_TAU_TICKS = 3 * TICK_RATE;
/** A step back in ticks beyond this is a new timeline (rewound stream): forget everything. */
const REWIND_TICKS = 10 * TICK_RATE;
/** Interest needed to cut to an action shot; below QUIET the shot on screen counts as quiet. */
export const ACTION_MIN = 6;
const QUIET = 3;
/** Opposing force value (alloy + 1.5 energy) in contact per point of interest. */
const CONTACT_SCALE = 80;
/** Rising contact (forces closing in) counts this much extra: the camera gets there before the first shot. */
const APPROACH_GAIN = 2.5;
const CONTACT_TAU_MS = 3000;
/** A Spire segment's weight as a target in contact (it has no alloy cost). */
const SPIRE_VALUE = 400;
/** Seconds a location was recently on screen that halve its pull (revisit cooldown, no ping-pong). */
const REVISIT_S = 8;
const RECENT_TAU_MS = 45_000;
/** A shot on another plane costs a dive: it must be this much better. */
const PLANE_CHANGE = 0.85;
/** Pull toward armies the camera has shown least (0: none). */
const FAIRNESS = 0.6;
/** An urgent event stays urgent this long (game ticks). */
const URGENT_TICKS = 3 * TICK_RATE;
const CANDIDATES = 8;
/** Telegraphs: falling rocks and the Mother Lode fuse count from this long before they land (s). */
const AHEAD_S = 8;

/** Replacement value (alloy + 1.5 energy) per kind; structures count half as targets, the Spire SPIRE_VALUE. */
const VALUE: Readonly<Record<Kind, number>> = Object.fromEntries(KINDS.map((kind) => {
  const stats = (STATS as Partial<Record<Kind, { alloy: number; energy: number }>>)[kind];
  return [kind, stats ? stats.alloy + 1.5 * stats.energy : 0];
})) as Record<Kind, number>;
const ARMED: ReadonlySet<Kind> = new Set(UNIT_KINDS.filter((kind) => STATS[kind].dmg > 0));
const STRUCTURE: ReadonlySet<Kind> = new Set(STRUCTURE_KINDS);

interface Weight { w: number; r: number; urgent?: true; value?: true }
const FX: Partial<Record<FxKind, Weight>> = {
  shot: { w: 1, r: R.fight }, lance: { w: 1.5, r: R.fight }, lance_hit: { w: 3, r: R.fight }, death: { w: 2, r: R.fight, value: true },
  flare: { w: 1, r: R.fight }, intercept: { w: 3, r: R.hazard }, volatile_detonation: { w: 6, r: R.hazard }, collapse: { w: 8, r: R.hazard },
  impact: { w: 8, r: R.hazard }, chasm: { w: 2, r: R.hazard }, magma: { w: 1.5, r: R.hazard }, deorbit: { w: 2, r: R.hazard },
  lode_vent: { w: 10, r: R.hazard, urgent: true }, breach: { w: 5, r: R.push }, breakout: { w: 6, r: R.push }, bridge: { w: 3, r: R.objective },
  defuse: { w: 3, r: R.objective }, core_cashed: { w: 6, r: R.objective }, core_vent: { w: 2, r: R.objective },
};
const EVENTS: Partial<Record<EventKind, Weight>> = {
  enemy_killed: { w: 1, r: R.fight, value: true }, unit_lost: { w: 1, r: R.fight, value: true },
  structure_destroyed: { w: 4, r: R.fight, value: true }, structure_lost: { w: 4, r: R.fight, value: true },
  spire_damaged: { w: 6, r: R.spire }, segment_rebuilt: { w: 6, r: R.spire }, crown_lost: { w: 40, r: R.spire, urgent: true },
  army_eliminated: { w: 60, r: R.elimination, urgent: true },
  island_captured: { w: 10, r: R.objective }, island_lost: { w: 10, r: R.objective }, post_captured: { w: 10, r: R.objective }, post_lost: { w: 10, r: R.objective },
  emplaced: { w: 3, r: R.objective }, hole_bridged: { w: 5, r: R.objective }, lode_opened: { w: 5, r: R.objective }, charge_defused: { w: 4, r: R.objective },
  core_lifted: { w: 10, r: R.objective }, core_cashed: { w: 12, r: R.objective },
  tunnel_breach: { w: 8, r: R.push }, breach_opened: { w: 10, r: R.push }, breach_tremor: { w: 4, r: R.push }, intruder: { w: 3, r: R.push },
  chasm_opened: { w: 10, r: R.hazard }, collapse: { w: 10, r: R.hazard }, fell_into_depths: { w: 4, r: R.hazard }, magma_flood: { w: 8, r: R.hazard },
  cache_burned: { w: 3, r: R.hazard }, lode_erupted: { w: 20, r: R.hazard, urgent: true }, impact: { w: 6, r: R.hazard },
  asteroid_intercepted: { w: 5, r: R.hazard }, charge_spotted: { w: 4, r: R.hazard }, core_meltdown: { w: 12, r: R.hazard },
};
/** Lava bridges: one finished (`constructed`) is an objective; one destroyed is a cut bridge. */
const LAVA_BRIDGE_BUILT: Weight = { w: 5, r: R.objective };
const LAVA_BRIDGE_CUT = 4;
/** Events every army receives: counted once when several armies' windows are read. */
const PUBLIC_EVENTS: Partial<Record<EventKind, true>> = { army_eliminated: true, crown_lost: true, sudden_death: true, core_lifted: true, core_cashed: true, core_regrows: true, segment_rebuilt: true, breach_opened: true, chasm_opened: true, hole_bridged: true };
const EVENT_INDEX: Readonly<Record<string, number>> = Object.fromEntries(Object.keys(EVENTS).concat('sudden_death', 'constructed').map((kind, i) => [kind, i]));
const SEEN_RING = 64;

const P = PLANES.length;

export class Director {
  /** Cut policy and camera feel; the observer picks the stream preset for Watch live and stream mode. */
  preset: DirectorPreset = DIRECTOR_LIVE;
  readonly shot: Shot = { active: false, id: 0, plane: 'surface', x: 0, y: 0, radius: 0, since: 0, reason: 'overview', score: 0, armies: 0 };
  /** Map side (tiles) of the last view. */
  size = 0;
  private n = 0;
  private perspective = '';
  private view: MatchView | undefined;
  private lastTick = -1;
  private lastFx = -1;
  private readonly lastEvent = new Float64Array(MAX_ARMIES + 1).fill(-1);
  private readonly seenKeys = new Float64Array(SEEN_RING).fill(-1);
  private seenAt = 0;
  // per plane × cell
  private heat = new Float32Array(0);
  private tagW = new Float32Array(0);
  private tag = new Uint8Array(0);
  private ahead = new Float32Array(0);
  private interest = new Float32Array(0);
  private contact = new Float32Array(0);
  private contactSlow = new Float32Array(0);
  private recent = new Float32Array(0);
  // per army × plane × cell
  private force = new Float32Array(0);
  private target = new Float32Array(0);
  private scratch = new Float32Array(0);
  private sum = new Float32Array(0);
  /** Army index per match army, its colour index (hostility) and screen time (s). */
  private armies: MatchView['match']['armies'] = [];
  private readonly colour = new Int8Array(MAX_ARMIES);
  private readonly screen = new Float64Array(MAX_ARMIES);
  /** Each army's densest single cell (plane × cell) before the neighbourhood sums, and its value: spotlight aims. */
  private readonly peak = new Int32Array(MAX_ARMIES);
  private readonly peakValue = new Float32Array(MAX_ARMIES);
  private urgentPlane = -1;
  private urgentCell = -1;
  private urgentTick = -1;
  private overviewWanted = false;
  private lastDecide = 0;
  private quietSince = 0;
  private holdUntil = 0;
  private lastOverview = 0;
  private quietShots = 0;
  // candidates (best first)
  private readonly cPlane = new Int8Array(CANDIDATES);
  private readonly cCell = new Int32Array(CANDIDATES);
  private readonly cRaw = new Float32Array(CANDIDATES);
  private readonly cScore = new Float32Array(CANDIDATES);
  private count = 0;

  private resize(size: number): void {
    this.size = size;
    this.n = Math.ceil(size / CELL_TILES);
    const cells = P * this.n * this.n;
    this.heat = new Float32Array(cells); this.tagW = new Float32Array(cells); this.tag = new Uint8Array(cells);
    this.ahead = new Float32Array(cells); this.interest = new Float32Array(cells); this.contact = new Float32Array(cells);
    this.contactSlow = new Float32Array(cells); this.recent = new Float32Array(cells);
    this.force = new Float32Array(MAX_ARMIES * cells); this.target = new Float32Array(MAX_ARMIES * cells);
    this.scratch = new Float32Array(this.n * this.n); this.sum = new Float32Array(this.n * this.n);
    this.reset();
  }

  /** Forget everything: a new match, a rewound stream or another perspective (no knowledge crosses a fog change). */
  reset(): void {
    this.heat.fill(0); this.tagW.fill(0); this.tag.fill(0); this.contact.fill(0); this.contactSlow.fill(0); this.recent.fill(0);
    this.lastTick = -1; this.lastFx = -1; this.lastEvent.fill(-1); this.seenKeys.fill(-1); this.screen.fill(0);
    this.urgentTick = -1; this.overviewWanted = false; this.view = undefined;
    this.lastDecide = 0; this.quietSince = 0; this.holdUntil = 0; this.lastOverview = 0; this.quietShots = 0;
    this.shot.active = false;
  }

  /** Drop the shot on screen (director toggled, viewer took over): the next decision starts fresh. */
  release(): void { this.shot.active = false; this.quietSince = 0; this.holdUntil = 0; }

  /**
   * Feed one shown frame. `perspective` names the fog it was filtered by (`all` or an army id); `sides` are every
   * army's own event windows, read only for the omniscient perspective.
   */
  ingest(view: MatchView, perspective: string, sides?: readonly { readonly events: readonly GameEvent[] }[]): void {
    const size = view.match.rules.map.size;
    if (size !== this.size) this.resize(size);
    // A resynchronised stream may step back a few ticks; anything more is another timeline.
    if (perspective !== this.perspective || view.tick < this.lastTick - REWIND_TICKS) { this.reset(); this.perspective = perspective; }
    if (view.match.armies !== this.armies) this.adoptArmies(view.match.armies);
    if (this.lastTick >= 0 && view.tick > this.lastTick) {
      const decay = Math.exp(-(view.tick - this.lastTick) / HEAT_TAU_TICKS);
      for (let i = 0; i < this.heat.length; i++) { this.heat[i]! *= decay; this.tagW[i]! *= decay; }
    }
    if (view.tick > this.lastTick) this.lastTick = view.tick;
    let newest = this.lastFx;
    for (const f of view.fx) {
      if (f.tick <= this.lastFx) continue;
      if (f.tick > newest) newest = f.tick;
      const weight = FX[f.kind];
      if (weight) this.add(f.plane, f.x, f.y, weight, f.subject, f.tick, view.tick);
    }
    this.lastFx = newest;
    // Other armies' windows only ever count for the omniscient perspective: a fog never learns from them.
    if (sides && perspective === 'all') for (let i = 0; i < sides.length && i < MAX_ARMIES; i++) this.events(sides[i]!.events, i + 1, view.tick);
    else this.events(view.events, 0, view.tick);
    this.view = view;
  }

  private adoptArmies(armies: MatchView['match']['armies']): void {
    this.armies = armies;
    const colours: string[] = [];
    for (let i = 0; i < armies.length && i < MAX_ARMIES; i++) {
      let c = colours.indexOf(armies[i]!.colour);
      if (c < 0) { c = colours.length; colours.push(armies[i]!.colour); }
      this.colour[i] = c;
    }
    this.screen.fill(0);
  }

  private armyIndex(side: string): number {
    const armies = this.armies;
    for (let i = 0; i < armies.length; i++) if (armies[i]!.id === side) return i;
    return -1;
  }

  private events(events: readonly GameEvent[], source: number, now: number): void {
    const last = this.lastEvent[source]!;
    let newest = last;
    for (const ev of events) {
      if (ev.tick <= last) continue;
      if (ev.tick > newest) newest = ev.tick;
      if (ev.kind === 'sudden_death') { if (this.fresh(ev, source)) this.overviewWanted = true; continue; }
      let weight = EVENTS[ev.kind];
      if (ev.kind === 'constructed' && ev.subject === 'lava_bridge') weight = LAVA_BRIDGE_BUILT;
      if (!weight || !this.fresh(ev, source)) continue;
      const extra = ev.subject === 'lava_bridge' && ev.kind !== 'constructed' ? LAVA_BRIDGE_CUT : 0;
      this.add(ev.plane, ev.x, ev.y, weight, ev.subject, ev.tick, now, extra);
    }
    this.lastEvent[source] = newest;
  }

  /** Public events reach every army's window: when several are read, count each once. */
  private fresh(ev: GameEvent, source: number): boolean {
    if (source === 0 || !PUBLIC_EVENTS[ev.kind]) return true;
    const key = ((((ev.tick % 1048576) * 64 + (EVENT_INDEX[ev.kind] ?? 63)) * 1024 + Math.floor(ev.x * 4)) * 1024) + Math.floor(ev.y * 4);
    for (let i = 0; i < SEEN_RING; i++) if (this.seenKeys[i] === key) return false;
    this.seenKeys[this.seenAt] = key; this.seenAt = (this.seenAt + 1) % SEEN_RING;
    return true;
  }

  private cellOf(x: number, y: number): number {
    const n = this.n;
    const cx = Math.min(n - 1, Math.max(0, Math.floor(x / CELL_TILES)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor(y / CELL_TILES)));
    return cy * n + cx;
  }

  private add(plane: Plane, x: number, y: number, weight: Weight, subject: Kind | undefined, tick: number, now: number, extra = 0): void {
    const p = PLANES.indexOf(plane);
    const cell = this.cellOf(x, y);
    const i = p * this.n * this.n + cell;
    // Value at stake: a lost tank outweighs a lost trooper (a trooper is about one point).
    const w = weight.w + extra + (weight.value && subject ? VALUE[subject] / 40 : 0);
    this.heat[i]! += w;
    if (w >= this.tagW[i]! * 0.5) { this.tag[i] = weight.r; this.tagW[i] = Math.max(this.tagW[i]!, w); }
    if (weight.urgent && now - tick <= URGENT_TICKS) { this.urgentPlane = p; this.urgentCell = cell; this.urgentTick = tick; }
  }

  // ------------------------------------------------------------ measure

  /** Sum of `src` (one plane slice at `off`) over a (2r+1)² box, into `dst` at `dstOff`. */
  private box(src: Float32Array, off: number, dst: Float32Array, dstOff: number, r: number): void {
    const n = this.n, tmp = this.scratch;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(n - 1, x + r); k++) s += src[off + y * n + k]!;
      tmp[y * n + x] = s;
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(n - 1, y + r); k++) s += tmp[k * n + x]!;
      dst[dstOff + y * n + x] = s;
    }
  }

  private deposit(plane: number, x: number, y: number, w: number, reason: number): void {
    if (!(w > 0)) return;
    const i = plane * this.n * this.n + this.cellOf(x, y);
    this.ahead[i]! += w;
    if (w >= this.tagW[i]!) { this.tag[i] = reason; this.tagW[i] = w; }
  }

  /** Presence, contact and telegraphs of the latest view, combined into `interest`. */
  private measure(view: MatchView, elapsed: number): void {
    const n = this.n, nn = n * n, cells = P * nn;
    this.force.fill(0); this.target.fill(0); this.ahead.fill(0);
    const surface = PLANES.indexOf('surface'), sky = PLANES.indexOf('sky'), depths = PLANES.indexOf('depths');
    for (const e of view.entities) {
      const p = PLANES.indexOf(e.plane);
      if ((e.kind === 'island' || e.kind === 'post') && (e.state === 'capturing' || e.state === 'contested')) {
        // An objective being taken is worth a look; a storm over a contested island doubly so.
        this.deposit(p, e.x, e.y, e.state === 'contested' ? 4 : 3, R.objective);
        if (e.kind === 'island') for (const storm of view.weather.storms) {
          const dx = e.x - storm.x, dy = e.y - storm.y;
          if (storm.strength > 0 && dx * dx + dy * dy <= storm.radius * storm.radius) this.deposit(sky, e.x, e.y, 6 * storm.strength, R.hazard);
        }
      }
      const a = this.armyIndex(e.side);
      if (a < 0) continue;
      const i = a * cells + p * nn + this.cellOf(e.x, e.y);
      if (e.kind === 'spire') this.target[i]! += SPIRE_VALUE;
      else if (ARMED.has(e.kind) && !STRUCTURE.has(e.kind)) this.force[i]! += VALUE[e.kind];
      else this.target[i]! += VALUE[e.kind] * 0.5;
    }
    // Seeded-storm telegraphs.
    for (const warning of view.weather.seedWarnings) this.deposit(sky, warning.x, warning.y, 4, R.hazard);
    // Falling rocks (public markers): more interesting the closer they are to landing.
    for (const impact of view.impacts) {
      const left = (impact.tick - view.tick) / TICK_RATE;
      if (left >= 0 && left <= AHEAD_S) this.deposit(surface, impact.x, impact.y, 8 + 10 * (1 - left / AHEAD_S), R.hazard);
    }
    // The Mother Lode (public pressure): the committed fuse is a countdown to an eruption.
    const lode = view.motherLode;
    if (lode && lode.x !== undefined && lode.y !== undefined) {
      if (lode.state === 'critical') {
        const left = lode.ventAt === undefined ? AHEAD_S : Math.max(0, (lode.ventAt - view.tick) / TICK_RATE);
        this.deposit(depths, lode.x, lode.y, 6 + 10 * (1 - Math.min(1, left / AHEAD_S)), R.hazard);
      } else if (lode.state === 'warn') this.deposit(depths, lode.x, lode.y, 2, R.hazard);
    }
    const armies = Math.min(MAX_ARMIES, view.match.armies.length);
    this.peakValue.fill(0);
    for (let a = 0; a < armies; a++) for (let i = 0; i < cells; i++) {
      const v = this.force[a * cells + i]! + this.target[a * cells + i]! * 0.5;
      if (v > this.peakValue[a]!) { this.peakValue[a] = v; this.peak[a] = i; }
    }
    // Neighbourhoods: force and targets within two cells (about 10 tiles), so forces about to meet register.
    for (let a = 0; a < armies; a++) for (let p = 0; p < P; p++) {
      const off = a * cells + p * nn;
      this.box(this.force, off, this.force, off, 2);
      this.box(this.target, off, this.target, off, 2);
    }
    const k = elapsed > 0 ? 1 - Math.exp(-elapsed / CONTACT_TAU_MS) : 1;
    for (let p = 0; p < P; p++) {
      this.box(this.heat, p * nn, this.interest, p * nn, 1);
      this.box(this.ahead, p * nn, this.sum, 0, 1);
      for (let c = 0; c < nn; c++) {
        const i = p * nn + c;
        let contact = 0;
        for (let a = 0; a < armies; a++) for (let b = a + 1; b < armies; b++) {
          if (this.colour[a] === this.colour[b]) continue;
          const fa = this.force[a * cells + i]!, fb = this.force[b * cells + i]!;
          contact += (Math.min(fa, fb + this.target[b * cells + i]!) + Math.min(fb, fa + this.target[a * cells + i]!)) / 2;
        }
        this.contact[i] = contact;
        const slow = this.contactSlow[i]! + (contact - this.contactSlow[i]!) * k;
        this.contactSlow[i] = slow;
        const approach = Math.max(0, contact - slow);
        this.interest[i] = this.interest[i]! + this.sum[c]! + (contact + APPROACH_GAIN * approach) / CONTACT_SCALE;
        const push = (contact + approach) / CONTACT_SCALE;
        if (contact > 0 && push > this.tagW[i]!) { this.tag[i] = R.push; this.tagW[i] = push; }
      }
    }
  }

  /** Recently shown locations (revisit cooldown) and per-army screen time (fairness). */
  private account(elapsed: number): void {
    if (elapsed <= 0) return;
    const decay = Math.exp(-elapsed / RECENT_TAU_MS);
    for (let i = 0; i < this.recent.length; i++) this.recent[i]! *= decay;
    const shot = this.shot;
    if (!shot.active) return;
    const seconds = elapsed / 1000;
    if (shot.reason !== 'overview') this.recent[PLANES.indexOf(shot.plane) * this.n * this.n + this.cellOf(shot.x, shot.y)]! += seconds;
    for (let a = 0; a < MAX_ARMIES; a++) if (shot.armies & (1 << a)) this.screen[a]! += seconds;
  }

  private near(i: number, j: number, r: number): boolean {
    const n = this.n;
    return Math.abs((i % n) - (j % n)) <= r && Math.abs(Math.floor(i / n) - Math.floor(j / n)) <= r;
  }

  /** Armies with a real stake in the 5×5 neighbourhood of a cell. */
  private armiesAt(p: number, cell: number): number {
    const cells = P * this.n * this.n, i = p * this.n * this.n + cell;
    let most = 0;
    for (let a = 0; a < MAX_ARMIES; a++) most = Math.max(most, this.force[a * cells + i]! + this.target[a * cells + i]!);
    let mask = 0;
    for (let a = 0; a < MAX_ARMIES; a++) {
      const v = this.force[a * cells + i]! + this.target[a * cells + i]!;
      if (v >= 40 && v >= most * 0.15) mask |= 1 << a;
    }
    return mask;
  }

  /** >1 for shots of armies the camera has shown least, <1 for the most shown. */
  private fairness(mask: number): number {
    const armies = Math.min(MAX_ARMIES, this.view?.match.armies.length ?? 0);
    if (!mask || armies < 2) return 1;
    let total = 0;
    for (let a = 0; a < armies; a++) total += this.screen[a]!;
    if (total < 10) return 1;
    let deficit = 0, involved = 0;
    for (let a = 0; a < armies; a++) if (mask & (1 << a)) { deficit += 1 / armies - this.screen[a]! / total; involved++; }
    return Math.min(1.3, Math.max(0.85, 1 + FAIRNESS * (deficit / involved) * armies));
  }

  /** Interest of a location as a rival to the shot on screen: novelty, fairness and the cost of a dive applied. */
  private rival(p: number, cell: number, raw: number): number {
    const n = this.n, base = p * n * n;
    let recent = 0;
    const cx = cell % n, cy = Math.floor(cell / n);
    for (let y = Math.max(0, cy - 1); y <= Math.min(n - 1, cy + 1); y++)
      for (let x = Math.max(0, cx - 1); x <= Math.min(n - 1, cx + 1); x++) recent += this.recent[base + y * n + x]!;
    // Leaving action on another plane costs a dive; an establishing shot dives freely.
    const shot = this.shot;
    const plane = shot.active && shot.reason !== 'overview' && shot.reason !== 'spotlight' && PLANES[p] !== shot.plane ? PLANE_CHANGE : 1;
    return raw / (1 + recent / REVISIT_S) * this.fairness(this.armiesAt(p, cell)) * plane;
  }

  /**
   * Local interest maxima worth a shot (raw interest ≥ ACTION_MIN), best rival score first, excluding the shot on
   * screen. Eligibility is raw interest; the revisit cooldown, fairness and dive cost only rank and compete.
   */
  private collect(): void {
    const n = this.n, nn = n * n, shot = this.shot;
    // Rivals near the action on screen are that action; establishing shots exclude nothing.
    const action = shot.active && shot.reason !== 'overview' && shot.reason !== 'spotlight';
    const shotP = action ? PLANES.indexOf(shot.plane) : -1, shotCell = action ? this.cellOf(shot.x, shot.y) : -1;
    this.count = 0;
    for (let p = 0; p < P; p++) for (let c = 0; c < nn; c++) {
      const v = this.interest[p * nn + c]!;
      if (v < ACTION_MIN) continue;
      const cx = c % n, cy = Math.floor(c / n);
      let peak = true;
      for (let y = Math.max(0, cy - 1); y <= Math.min(n - 1, cy + 1) && peak; y++)
        for (let x = Math.max(0, cx - 1); x <= Math.min(n - 1, cx + 1); x++) {
          const o = this.interest[p * nn + y * n + x]!;
          if (o > v || (o === v && y * n + x < c)) { peak = false; break; }
        }
      if (!peak || (p === shotP && this.near(c, shotCell, 2))) continue;
      const score = this.rival(p, c, v);
      let at = this.count;
      while (at > 0 && this.cScore[at - 1]! < score) at--;
      if (at >= CANDIDATES) continue;
      for (let j = Math.min(this.count, CANDIDATES - 1); j > at; j--) { this.cPlane[j] = this.cPlane[j - 1]!; this.cCell[j] = this.cCell[j - 1]!; this.cRaw[j] = this.cRaw[j - 1]!; this.cScore[j] = this.cScore[j - 1]!; }
      this.cPlane[at] = p; this.cCell[at] = c; this.cRaw[at] = v; this.cScore[at] = score;
      if (this.count < CANDIDATES) this.count++;
    }
  }

  /** Follow the action the shot is on: re-centre on the hottest cell within two cells (tracking, not re-detecting). */
  private track(): number {
    const shot = this.shot, n = this.n, nn = n * n, p = PLANES.indexOf(shot.plane);
    const at = this.cellOf(shot.x, shot.y);
    let best = at, value = this.interest[p * nn + at]!;
    const cx = at % n, cy = Math.floor(at / n);
    for (let y = Math.max(0, cy - 2); y <= Math.min(n - 1, cy + 2); y++)
      for (let x = Math.max(0, cx - 2); x <= Math.min(n - 1, cx + 2); x++) {
        const v = this.interest[p * nn + y * n + x]!;
        if (v > value * 1.15) { value = v; best = y * n + x; }
      }
    if (value >= QUIET) this.aim(p, best);
    return value;
  }

  /** Centre and radius of the action round a cell: the interest-weighted centroid and spread over its 5×5. */
  private aim(p: number, cell: number): void {
    const n = this.n, nn = n * n, shot = this.shot;
    const cx = cell % n, cy = Math.floor(cell / n);
    let w = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
    for (let y = Math.max(0, cy - 2); y <= Math.min(n - 1, cy + 2); y++)
      for (let x = Math.max(0, cx - 2); x <= Math.min(n - 1, cx + 2); x++) {
        const v = this.interest[p * nn + y * n + x]!;
        if (v <= 0) continue;
        const tx = (x + 0.5) * CELL_TILES, ty = (y + 0.5) * CELL_TILES;
        w += v; sx += v * tx; sy += v * ty; sxx += v * tx * tx; syy += v * ty * ty;
      }
    const mx = w > 0 ? sx / w : (cx + 0.5) * CELL_TILES, my = w > 0 ? sy / w : (cy + 0.5) * CELL_TILES;
    const spread = w > 0 ? Math.sqrt(Math.max(0, sxx / w - mx * mx + syy / w - my * my)) : 0;
    shot.plane = PLANES[p]!;
    shot.x = Math.min(this.size, Math.max(0, mx));
    shot.y = Math.min(this.size, Math.max(0, my));
    shot.radius = Math.max(this.preset.minRadius, Math.min(this.size * 0.4, spread * 1.6 + CELL_TILES));
    shot.armies = this.armiesAt(p, cell);
  }

  private cut(now: number, index: number): void {
    const shot = this.shot, p = this.cPlane[index]!, cell = this.cCell[index]!;
    shot.active = true; shot.id++; shot.since = now; shot.score = this.cRaw[index]!;
    this.aim(p, cell);
    const urgent = this.urgent(p, cell);
    shot.reason = REASONS[(urgent ? this.tag[p * this.n * this.n + this.urgentCell]! : this.dominant(p, cell)) || R.fight]!;
    this.holdUntil = urgent ? now + this.preset.urgentHoldMs : 0;
    this.quietSince = 0;
  }

  /** The strongest tag in the 3×3 round a cell. */
  private dominant(p: number, cell: number): number {
    const n = this.n, base = p * n * n, cx = cell % n, cy = Math.floor(cell / n);
    let best = 0, tag: number = R.fight;
    for (let y = Math.max(0, cy - 1); y <= Math.min(n - 1, cy + 1); y++)
      for (let x = Math.max(0, cx - 1); x <= Math.min(n - 1, cx + 1); x++) {
        const i = base + y * n + x;
        if (this.tag[i]! && this.tagW[i]! > best) { best = this.tagW[i]!; tag = this.tag[i]!; }
      }
    return tag;
  }

  private urgent(p: number, cell: number): boolean {
    return this.urgentTick >= 0 && p === this.urgentPlane && this.near(cell, this.urgentCell, 1) && (this.view?.tick ?? 0) - this.urgentTick <= URGENT_TICKS;
  }

  /** Establishing shots for quiet stretches: the whole map, then a spotlight on the army shown least, alternating. */
  private establish(now: number, kind: 'overview' | 'spotlight'): void {
    const shot = this.shot, n = this.n, nn = n * n;
    if (kind === 'spotlight') {
      const armies = Math.min(MAX_ARMIES, this.armies.length);
      let army = -1;
      for (let a = 0; a < armies; a++) {
        if (!(this.peakValue[a]! > 0) || this.view?.eliminated.includes(this.armies[a]!.id)) continue;
        if (army < 0 || this.screen[a]! < this.screen[army]!) army = a;
      }
      if (army >= 0) {
        const at = this.peak[army]!, cell = at % nn;
        shot.active = true; shot.id++; shot.since = now; shot.reason = 'spotlight'; shot.score = 0;
        shot.plane = PLANES[Math.floor(at / nn)]!; shot.x = (cell % n + 0.5) * CELL_TILES; shot.y = (Math.floor(cell / n) + 0.5) * CELL_TILES;
        shot.radius = Math.max(this.preset.minRadius, 10); shot.armies = 1 << army;
        return;
      }
    }
    // The overview: the plane with the most going on (or the most forces), the whole map.
    let bestP = shot.active ? PLANES.indexOf(shot.plane) : PLANES.indexOf('surface'), best = 0;
    for (let p = 0; p < P; p++) {
      let s = 0;
      for (let c = 0; c < nn; c++) s += this.interest[p * nn + c]!;
      if (s > best * 1.25) { best = s; bestP = p; }
    }
    shot.active = true; shot.id++; shot.since = now; shot.reason = 'overview'; shot.score = 0;
    shot.plane = PLANES[bestP]!; shot.x = this.size / 2; shot.y = this.size / 2; shot.radius = this.size * 0.45; shot.armies = 0;
    this.lastOverview = now;
  }

  /** Re-evaluate the shot at playback time `now` (ms); returns whether it cut. */
  decide(now: number): boolean {
    const view = this.view;
    if (!view || !this.n) return false;
    const elapsed = this.lastDecide ? Math.min(1000, Math.max(0, now - this.lastDecide)) : 0;
    this.lastDecide = now;
    this.account(elapsed);
    this.measure(view, elapsed);
    this.collect();
    const shot = this.shot, preset = this.preset, id = shot.id;
    // `best` competes with the shot on screen; `bestRaw` is how much is happening there.
    const best = this.count ? this.cScore[0]! : 0, bestRaw = this.count ? this.cRaw[0]! : 0;
    const bestUrgent = this.count > 0 && this.urgent(this.cPlane[0]!, this.cCell[0]!);
    if (this.overviewWanted) { this.overviewWanted = false; this.establish(now, 'overview'); return true; }
    if (!shot.active) {
      // The breather cadence counts from the first shot, whatever it is.
      if (!this.lastOverview) this.lastOverview = now;
      if (this.count) this.cut(now, 0);
      else this.establish(now, 'overview');
      return true;
    }
    const dwell = now - shot.since;
    if (shot.reason === 'overview' || shot.reason === 'spotlight') {
      // An establishing shot gets a real look before anything but an urgent moment interrupts it.
      if ((bestRaw >= preset.hot && dwell >= Math.min(preset.minDwellMs, preset.overviewMs / 2)) || bestUrgent) this.cut(now, 0);
      else if (dwell >= preset.overviewMs) {
        if (this.count) this.cut(now, 0);
        else this.establish(now, this.quietShots++ % 2 === 0 ? 'spotlight' : 'overview');
      }
      return shot.id !== id;
    }
    const live = this.track();
    if (live < QUIET) { if (!this.quietSince) this.quietSince = now; } else this.quietSince = 0;
    if (bestUrgent && dwell >= preset.urgentDwellMs && now >= this.holdUntil) { this.cut(now, 0); return true; }
    if (now < this.holdUntil || dwell < preset.minDwellMs) return false;
    if (this.quietSince && now - this.quietSince >= preset.quietMs) {
      if (this.count) this.cut(now, 0);
      else this.establish(now, 'overview');
      return true;
    }
    if (this.count && (best >= live * preset.cutRatio + preset.cutMargin || dwell >= preset.maxDwellMs)) { this.cut(now, 0); return true; }
    // A breather overview only once the shot has run a while: never a quick cut away and straight back.
    if (preset.overviewEveryMs && now - this.lastOverview >= preset.overviewEveryMs && dwell >= preset.maxDwellMs / 2 && live < preset.hot) { this.establish(now, 'overview'); return true; }
    return false;
  }
}

// ---------------------------------------------------------------- camera operator

/** The parts of the camera rig (world/camera.ts) the operator drives. */
export interface DirectedRig {
  tx: number;
  tz: number;
  dist: number;
  yaw: number;
  readonly focus: Plane;
  readonly level: number;
  readonly diving: boolean;
  readonly minDist: number;
  readonly maxDist: number;
  goTo(plane: Plane, now: number, kind: 'jump'): void;
  fitDistance(radius: number, padding: number): number;
}

/** A long pan pulls the camera out by this share of the remaining travel (fly-over), up to MAX_SWOOP × the framing. */
const SWOOP = 0.35;
const MAX_SWOOP = 0.6;
/** However far, a move takes at most about this long (s). */
const MAX_TRAVEL_S = 1.8;
/** While holding, the camera eases in by this share over DOLLY_MS. */
const DOLLY = 0.06;
const DOLLY_MS = 12_000;
/** Phones (`isPhone`) frame the action this much tighter (a share of the preset's padding): on a small screen the
 *  desktop framing leaves units too small to read. Desktop framing stays at 1. */
export const PHONE_FRAMING = 0.85;

/**
 * Moves the rig to the director's shot: a critically damped spring on focus and distance with a pan speed limit
 * (eased start and stop, no snapping), a pull-out on long moves, zoom to fit the action in the HUD-safe area, a slow
 * orbit and dolly while holding, and the plane dive for a shot on another plane (the focus jumps at the dive's
 * midpoint, under its ink). Reduced motion: every change is a cut.
 */
export class DirectorCamera {
  private vx = 0;
  private vz = 0;
  private vd = 0;
  private shotId = -1;
  private diveFrom = -1;
  private drift = 1;
  private settledAt = 0;
  private readonly motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  /** Multiplies the preset's fit padding (`PHONE_FRAMING` on a phone, 1 elsewhere). */
  private readonly framing: number;

  constructor(framing = 1) {
    this.framing = framing;
  }

  /** The viewer took the camera: the next shot starts from rest wherever they left it. */
  release(): void { this.vx = 0; this.vz = 0; this.vd = 0; this.shotId = -1; this.diveFrom = -1; }

  frame(rig: DirectedRig, director: Director, now: number, dt: number, reduced = this.motion?.matches === true): void {
    const shot = director.shot, preset = director.preset, size = director.size;
    if (!shot.active || !size) return;
    const tx = wx(shot.x, size), tz = wz(shot.y, size);
    const fit = Math.min(rig.maxDist, Math.max(rig.minDist, rig.fitDistance(shot.radius, preset.padding * this.framing)));
    if (shot.id !== this.shotId) {
      this.shotId = shot.id; this.drift = -this.drift; this.settledAt = 0;
      if (rig.focus !== shot.plane) { this.diveFrom = rig.level; rig.goTo(shot.plane, now, 'jump'); }
      if (reduced) { this.snap(rig, tx, tz, fit); this.diveFrom = -1; return; }
    }
    if (this.diveFrom >= 0) {
      // Hold still through the first half of the dive, then jump under the ink.
      const to = PLANES.indexOf(shot.plane);
      if (rig.diving && Math.abs(rig.level - to) > Math.abs(this.diveFrom - to) / 2) return;
      this.snap(rig, tx, tz, fit); this.diveFrom = -1;
      return;
    }
    const dx = tx - rig.tx, dz = tz - rig.tz;
    const remaining = Math.hypot(dx, dz);
    if (reduced) {
      // Cuts only: re-frame a tracked shot once the action leaves the middle of the frame.
      if (remaining > fit * 0.3 || Math.abs(rig.dist - fit) > fit * 0.3) this.snap(rig, tx, tz, fit);
      return;
    }
    if (!dt) return;
    const w = 1 / preset.settleS;
    this.vx += (w * w * dx - 2 * w * this.vx) * dt;
    this.vz += (w * w * dz - 2 * w * this.vz) * dt;
    const limit = Math.max(preset.panSpeed * rig.dist, remaining / MAX_TRAVEL_S);
    const speed = Math.hypot(this.vx, this.vz);
    if (speed > limit) { this.vx *= limit / speed; this.vz *= limit / speed; }
    rig.tx += this.vx * dt;
    rig.tz += this.vz * dt;
    const settled = remaining < fit * 0.25;
    if (settled && !this.settledAt) this.settledAt = now;
    const hold = this.settledAt ? Math.min(1, (now - this.settledAt) / DOLLY_MS) : 0;
    const goal = Math.min(rig.maxDist, Math.max(rig.minDist, (fit + Math.min(remaining * SWOOP, fit * MAX_SWOOP)) * (1 - DOLLY * hold)));
    const wd = w * 0.8;
    this.vd += (wd * wd * (goal - rig.dist) - 2 * wd * this.vd) * dt;
    rig.dist += this.vd * dt;
    if (settled) rig.yaw += this.drift * preset.driftRadS * (shot.reason === 'overview' ? 1.5 : 1) * dt;
  }

  private snap(rig: DirectedRig, tx: number, tz: number, dist: number): void {
    rig.tx = tx; rig.tz = tz; rig.dist = dist;
    this.vx = 0; this.vz = 0; this.vd = 0;
  }
}
