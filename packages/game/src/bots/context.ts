/**
 * One bot decision's knowledge (Ctx: the fogged observation, cached match data and compiled rules), the army frame
 * every plane bot plans in so rotated armies play exactly rotated games, and the focus rule (DESIGN §15.10).
 */
import { compileRules } from '../rules/rule-tables.ts';
import { buildSiteError, footprint, footprintDistance, footprintOverlap, isRadiusBound, isStatKind, STATS, STRUCTURE_SPACING, surfaceSiteLevel } from '../rules/stats.ts';
import { CELL, isSurfaceHigh, SURFACE, surfaceFeature } from '../rules/terrain.ts';
import { isStructureKind, PLANES, UNITS_PER_INTENT } from '../rules/vocabulary.ts';
import type { ArmyId, BuildableKind, BuildRadiusSource, BuildSiteError, Econ, Entity, FullObservation, MatchData, Plane, QueueItem, Rules, RuleTables, Side, StatKind, Stats, UnitKind } from '../rules/contract.ts';
import type { AgentCommandIntent } from '../agent/intents.ts';
import { dmath } from '../util/fdlibm.js';
import { cellCentreX, cellCentreY } from '../util/grid.ts';
import { dist, norm, onGrid } from '../util/math.ts';
import { canonCell, canonX, canonY, hostileSide, rotCell, rotVX, rotVY, rotX, rotY } from '../util/teams.ts';
import { CORE_POST_MARGIN, LODE_SITE_REACH, SCORCH_MARGIN, THREAT_MARGIN, VISION_MARGIN } from './tuning.ts';

/** A map point, in tiles. */
export interface Pt { x: number; y: number }

/** Unit ids for an intent's `units` list (at most the schema's cap). */
export const ids = (es: readonly Entity[]): string[] => es.slice(0, UNITS_PER_INTENT).map((e) => e.id);
/** One army of the match as matchData lists it (id, slot, frame, colour, Spire centre). */
export type ArmyRow = MatchData['armies'][number];

/** Frame cell orders by `size × 4 + k` (Frame.cells): one per turn and map size, built once per process. */
const FRAME_CELLS = new Map<number, Int32Array>();

/**
 * An army's frame: `k` quarter turns carry the NW corner onto its corner, one turn (x, y) → (size − y, x). Bots plan
 * in the canonical (NW) frame and turn plans into the world with toWorld/offset; tie-breaks order world cells and
 * points by their index in the frame (cellKey, pointKey), so rotated armies in rotated situations take exactly
 * rotated decisions. Frame 2 is the C2 point mirror.
 */
export class Frame {
  readonly k: number;
  readonly size: number;
  /** box walk state (box/boxCell): canonical min corner and width */
  private boxX = 0;
  private boxY = 0;
  private boxW = 1;

  constructor(k: number, size: number) {
    this.k = k;
    this.size = size;
  }

  /** World point of canonical point (x, y). */
  toWorld(x: number, y: number): Pt {
    return { x: rotX(this.k, x, y, this.size), y: rotY(this.k, x, y, this.size) };
  }

  /** Canonical point of world point (x, y). */
  toCanon(x: number, y: number): Pt {
    return { x: canonX(this.k, x, y, this.size), y: canonY(this.k, x, y, this.size) };
  }

  /** World point `p` moved by the canonical vector (dx, dy) (exact: a turn only swaps and negates). */
  offset(p: Pt, dx: number, dy: number): Pt {
    return { x: p.x + rotVX(this.k, dx, dy), y: p.y + rotVY(this.k, dx, dy) };
  }

  /** World cell of canonical cell `c`. */
  cell(c: number): number {
    return rotCell(this.k, c, this.size);
  }

  /**
   * Every world cell in this frame's row-major order (`cell(i)` for i = 0…size²−1), shared by every frame of the same
   * turn and map size: read it, never write it. Walking it seeds searches and scans without a call per cell.
   */
  cells(): Int32Array {
    const key = this.size * 4 + this.k;
    let order = FRAME_CELLS.get(key);
    if (!order) {
      order = new Int32Array(this.size * this.size);
      for (let i = 0; i < order.length; i++) order[i] = rotCell(this.k, i, this.size);
      FRAME_CELLS.set(key, order);
    }
    return order;
  }

  /** World cell of the canonical tile holding canonical point (x, y). */
  cellAt(x: number, y: number): number {
    return this.cell(Math.floor(y) * this.size + Math.floor(x));
  }

  /** Tie-break order of world cell `c`: its row-major index in this frame. */
  cellKey(c: number): number {
    return canonCell(this.k, c, this.size);
  }

  /**
   * The cell this frame means by world point (x, y): cellFor without its clamp (callers pass points inside the map).
   * The point is floored in the frame, so a point on a cell edge resolves like its rotated twin's.
   */
  pointCell(x: number, y: number): number {
    return this.cellAt(canonX(this.k, x, y, this.size), canonY(this.k, x, y, this.size));
  }

  /** Tie-break order of world point `p`: canonical y, then x. */
  pointKey(p: Pt): number {
    return canonY(this.k, p.x, p.y, this.size) * this.size + canonX(this.k, p.x, p.y, this.size);
  }

  /**
   * Observation lists arrive in the army's own naming order (its creation and first-sight order, sim/aliases.ts). Walk
   * them in this frame (nearest its corner first) so rotated bots hand out first-come work (cache collectors) to
   * rotated targets.
   */
  order<T extends Pt>(list: readonly T[]): T[] {
    return [...list].sort((a, b) => this.pointKey(a) - this.pointKey(b));
  }

  /** Start a walk over the world cell box [x0, x1] × [y0, y1] in this frame's row-major order: its cell count. */
  box(x0: number, y0: number, x1: number, y1: number): number {
    const a = canonCell(this.k, y0 * this.size + x0, this.size);
    const b = canonCell(this.k, y1 * this.size + x1, this.size);
    const ax = a % this.size, bx = b % this.size;
    this.boxX = Math.min(ax, bx);
    this.boxY = Math.min((a - ax) / this.size, (b - bx) / this.size);
    this.boxW = Math.abs(ax - bx) + 1;
    return (x1 - x0 + 1) * (y1 - y0 + 1);
  }

  /** World cell of step `i` of the current box walk. */
  boxCell(i: number): number {
    return this.cell((this.boxY + Math.floor(i / this.boxW)) * this.size + this.boxX + (i % this.boxW));
  }
}

/** Distance from the centre of cell `c` to `p`, in tiles. */
export const cellDist = (c: number, size: number, p: Pt): number => norm(cellCentreX(c, size) - p.x, cellCentreY(c, size) - p.y);
/** Grid steps per tile for `gridDist2`: fine enough to separate distinct observed points. */
const DIST_GRID = 1 << 16;
/**
 * Squared distance between `a` and `b` on a binary grid, for nearest-of comparisons. Float distances to a unit's
 * clockwise and counter-clockwise twins (always equal under a quarter turn) swap their components, and points the
 * bot computed (centroids, offsets) carry last-bit noise, so float results can differ in their last bits; on the
 * grid they tie exactly and the list order (hostile armies clockwise) breaks the tie for every army alike.
 */
export function gridDist2(a: Pt, b: Pt): number {
  const dx = Math.round(a.x * DIST_GRID) - Math.round(b.x * DIST_GRID);
  const dy = Math.round(a.y * DIST_GRID) - Math.round(b.y * DIST_GRID);
  return dx * dx + dy * dy;
}

/** Last-known HP of hostile Spire segments, per army and plane (a segment never seen counts at full HP). */
export type SpireMemory = Map<ArmyId, Partial<Record<Plane, number>>>;

/** Record the hostile Spire segments this decision sees. */
export function rememberSpires(c: Ctx, seen: SpireMemory): void {
  for (const e of c.foes) {
    if (e.kind !== 'spire' || e.side === 'neutral') continue;
    let row = seen.get(e.side);
    if (!row) seen.set(e.side, (row = {}));
    row[e.plane] = e.hp;
  }
}

/**
 * Under rules.spire.lossRule `crowns`, the focus's weakest crown: of its segments standing (public `crowns`), the one
 * with the least last-known HP (match-rule HP when never seen) per crown it is worth, first in plane order on ties.
 * Public data and shared observation memory only, so every seat of the army picks the same one; undefined under the
 * `surface` rule (only the Surface is a life there).
 */
export function weakestCrown(c: Ctx, seen: SpireMemory): Plane | undefined {
  if (c.match.rules.spire.lossRule !== 'crowns') return undefined;
  const fallen = c.obs.crowns?.find((r) => r.army === c.focus.id)?.fallen ?? [];
  const known = seen.get(c.focus.id);
  let best: Plane | undefined;
  let bestCost = Infinity;
  for (const plane of PLANES) {
    const crowns = plane === 'surface' ? c.econ.crownsSurface : c.econ.crownsSide;
    if (crowns <= 0 || fallen.includes(plane)) continue;
    const cost = (known?.[plane] ?? c.match.rules.spire.hp[plane]) / crowns;
    if (cost < bestCost) {
      best = plane;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * The army's focus (DESIGN §15.10): the live hostile army with the best score. Spire distance from matchData first
 * (shorter better; `leaderPenalty` × map size is added for the strongest visible army, the unique largest value of
 * visible hostile forces, so a veteran avoids feeding it), then lower last-known Spire HP, then relative order
 * clockwise ((frame(b) − frame(me)) mod 4): equidistant FFA neighbours resolve clockwise. Every input is shared
 * observation data, so the seats of one army agree.
 */
export function chooseFocus(c: Ctx, seen: SpireMemory, leaderPenalty: number): ArmyRow | undefined {
  let leader: ArmyId | undefined;
  if (leaderPenalty > 0) {
    let top = 0;
    for (const a of c.hostiles) {
      let value = 0;
      for (const e of c.foes) if (e.side === a.id && e.kind !== 'spire') value += c.statsOf(e).alloy + c.statsOf(e).energy;
      if (value > top) {
        top = value;
        leader = a.id;
      } else if (value === top && value > 0) leader = undefined;
    }
  }
  let best: ArmyRow | undefined;
  let bestDistance = 0, bestHp = 0, bestOrder = 0;
  for (const a of c.hostiles) {
    const distance = dist(c.home, a.spireAt) + (a.id === leader ? leaderPenalty * c.size : 0);
    const known = seen.get(a.id);
    let hp = 0;
    for (const plane of PLANES) hp += known?.[plane] ?? c.match.rules.spire.hp[plane];
    const order = (a.frame - c.me.frame + 4) & 3;
    if (!best || distance < bestDistance || (distance === bestDistance && (hp < bestHp || (hp === bestHp && order < bestOrder)))) {
      best = a;
      bestDistance = distance;
      bestHp = hp;
      bestOrder = order;
    }
  }
  return best;
}

export const centroid = (es: readonly Pt[]): Pt => ({
  x: es.reduce((a, e) => a + e.x, 0) / es.length,
  y: es.reduce((a, e) => a + e.y, 0) / es.length,
});
/** Order point steps per tile: on this quarter-tile grid the turns (size - v, swaps) are exact. */
const ORDER_GRID = 4;
/** Order points keep this many tiles inside the map edge. */
const ORDER_MARGIN = 0.5;
/**
 * Order points sit on a quarter-tile grid inside the map: every quarter turn of them is exact. Ties round to even:
 * observed positions sit on the 1/OBS_GRID grid, so eighth-tile ties are common, and half-up rounding would send
 * rotated twins (size − v) to different quarters.
 */
export const snap = (v: number, size: number): number => Math.min(size - ORDER_MARGIN, Math.max(ORDER_MARGIN, onGrid(v, ORDER_GRID)));
/** Binary grid (cells per tile) that `Ctx.spot` snaps its origin to before comparing distances. */
const SPOT_GRID = 1024;
/** Compile the immutable snapshot rules once, shared by bots in the same match. */
const compiled = new WeakMap<Rules, RuleTables>();

/** `rules` compiled, once per rules object: the tables every Ctx of the match reads. */
export function ruleTables(rules: Rules): RuleTables {
  let tables = compiled.get(rules);
  if (!tables) compiled.set(rules, (tables = compileRules(rules)));
  return tables;
}

/** Each static terrain's walkable cells, once per terrain array. */
const groundWalks = new WeakMap<Uint8Array, Uint8Array>();

/** The cells of static surface terrain `ground` units can stand on (1: no cliff, no water): read it, never write it. */
export function groundWalk(ground: Uint8Array): Uint8Array {
  let walk = groundWalks.get(ground);
  if (!walk) {
    walk = new Uint8Array(ground.length);
    for (let c = 0; c < ground.length; c++) if (ground[c] !== SURFACE.cliff && surfaceFeature(ground[c]!) !== SURFACE.water) walk[c] = 1;
    groundWalks.set(ground, walk);
  }
  return walk;
}

export class Ctx {
  readonly size: number;
  readonly obs: FullObservation;
  readonly match: MatchData;
  readonly army: ArmyId;
  /** our matchData row */
  readonly me: ArmyRow;
  readonly frame: Frame;
  /** our Spire centre */
  readonly home: Pt;
  /** hostile armies still in play (not eliminated), in army order */
  readonly hostiles: ArmyRow[] = [];
  /** the hostile army this decision attacks (PlaneBot's focus), its Spire centre and its frame; set before decide */
  focus!: ArmyRow;
  foeAt!: Pt;
  foeFrame!: Frame;
  /** the focus's segment this army pushes for under lossRule crowns (weakestCrown); undefined under `surface` */
  crown: Plane | undefined;
  readonly own: Entity[] = [];
  /** every hostile unit and structure we see (any hostile army) */
  readonly foes: Entity[] = [];
  /** every forward post (public: holder in `side`, matchData.posts order), in observation order */
  readonly posts: Entity[] = [];
  /** static surface terrain (SURFACE codes) */
  readonly ground: Uint8Array;
  /** this match's cached rules, in ticks: never assume the defaults */
  readonly econ: Econ;
  readonly stats: Record<StatKind, Stats>;
  /** walkMask: built on first use */
  private walkCells: Uint8Array | null = null;
  private reservedAlloy = 0;
  private reservedEnergy = 0;

  constructor(obs: FullObservation, match: MatchData, ground: Uint8Array) {
    this.obs = obs;
    this.match = match;
    this.size = match.rules.map.size;
    this.army = obs.army;
    const me = match.armies.find((a) => a.id === obs.army);
    if (!me) throw new Error(`army ${obs.army} is not in this match`);
    this.me = me;
    this.frame = new Frame(me.frame, this.size);
    this.home = me.spireAt;
    for (const a of match.armies) if (hostileSide(match, obs.army, a.id) && !obs.eliminated.includes(a.id)) this.hostiles.push(a);
    this.ground = ground;
    const tables = ruleTables(match.rules);
    this.econ = tables.econ;
    this.stats = tables.stats;
    for (const e of obs.entities) {
        // Islands, asteroids, the derelict core and forward posts are world objects, even while an army holds or tows one.
        if (e.kind === 'post') {
          this.posts.push(e);
          continue;
        }
        if (e.kind === 'island' || e.kind === 'core' || e.kind === 'asteroid') continue;
        if (e.side === this.army) this.own.push(e);
        else if (this.hostile(e.side)) this.foes.push(e);
    }
    // Lists name hostile armies in first-sight order, which no rotation need preserve across armies: walk them clockwise
    // from us (stable, so each army's own entities keep their order, the same for every army's twins). One army: unchanged.
    if (this.hostiles.length > 1) {
      const order = (side: Side): number => ((match.armies.find((a) => a.id === side)?.frame ?? 0) - me.frame + 4) & 3;
      this.foes.sort((a, b) => order(a.side) - order(b.side));
    }
  }

  /** Attack `focus` this decision; `crown`: its weakest crown under lossRule crowns (weakestCrown), else undefined. */
  focusOn(focus: ArmyRow, seen: SpireMemory): void {
    this.focus = focus;
    this.foeAt = focus.spireAt;
    this.foeFrame = new Frame(focus.frame, this.size);
    this.crown = weakestCrown(this, seen);
  }

  /** Is `side` hostile to us (another colour)? */
  hostile(side: Side): boolean {
    return hostileSide(this.match, this.army, side);
  }

  /** Distance from `p` to the nearest Spire of a hostile army in play (Infinity when none). */
  hostileSpireDist(p: Pt): number {
    let d = Infinity;
    for (const a of this.hostiles) d = Math.min(d, dist(p, a.spireAt));
    return d;
  }

  /**
   * Distance from `p` to the footprint edge of the nearest hostile Spire (Infinity when none): segment beams reach
   * spire.range + target radius beyond it.
   */
  hostileSpireEdgeDist(p: Pt): number {
    let d = Infinity;
    for (const a of this.hostiles) d = Math.min(d, footprintDistance('spire', a.spireAt.x, a.spireAt.y, p.x, p.y));
    return d;
  }

  /** Can surface units stand on cell `c` (no cliff, no water, no hole)? */
  walkable(c: number): boolean {
    return c >= 0 && c < this.size * this.size && this.walkMask()[c] === 1;
  }

  /** walkable for every cell (1: walkable): the terrain's walkable cells less the observed holes, once per decision. Read it, never write it. */
  walkMask(): Uint8Array {
    if (!this.walkCells) {
      const walk = (this.walkCells = groundWalk(this.ground).slice());
      for (const h of this.obs.holes) walk[h.y * this.size + h.x] = 0;
    }
    return this.walkCells;
  }

  /** Stats row of an observed unit or structure, from this match's rules. Islands and asteroids have none. */
  statsOf(e: Entity): Stats {
    if (!isStatKind(e.kind)) throw new Error(`no stats row for ${e.kind}`);
    return this.stats[e.kind];
  }

  /**
   * Centre of the walkable cell nearest to (x, y) within `r` tiles that `want` accepts (default: any), or null.
   * The area is scanned in our frame's order, so rotated requests pick rotated cells.
   */
  spot(x: number, y: number, r: number, want: (c: number) => boolean = () => true): Pt | null {
    let best = -1;
    let bd = r * r;
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(this.size - 1, Math.floor(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(this.size - 1, Math.floor(y + r));
    const f = this.frame;
    const n = f.box(x0, y0, x1, y1);
    // Distances in our own frame, from an origin snapped to a binary grid: a computed origin (an offset or a
    // centroid) carries last-bit noise that differs between rotated twins, which then break near-ties alike.
    const fx = Math.round(canonX(f.k, x, y, this.size) * SPOT_GRID) / SPOT_GRID;
    const fy = Math.round(canonY(f.k, x, y, this.size) * SPOT_GRID) / SPOT_GRID;
    for (let i = 0; i < n; i++) {
      const c = f.boxCell(i);
      const cx = cellCentreX(c, this.size), cy = cellCentreY(c, this.size);
      const d = dmath.pow(canonX(f.k, cx, cy, this.size) - fx, 2) + dmath.pow(canonY(f.k, cx, cy, this.size) - fy, 2);
      if (d > bd || (d === bd && best >= 0) || !this.walkable(c) || !want(c)) continue;
      bd = d;
      best = c;
    }
    return best < 0 ? null : { x: cellCentreX(best, this.size), y: cellCentreY(best, this.size) };
  }

  /** surfaceRegion's blocked cells (this decision's threats) and the regions found so far: one per component. */
  private regionBlocked: Uint8Array | null = null;
  private readonly regions: Uint8Array[] = [];

  /**
   * Safe connected Surface ground, using only public terrain and currently observed threats/blockers. Every unit of one
   * component gets the same region (read it, never write it).
   */
  surfaceRegion(from: Pt): Uint8Array {
    const size = this.size, cells = size * size;
    let blocked = this.regionBlocked;
    if (!blocked) {
      blocked = this.regionBlocked = new Uint8Array(cells);
      const walk = this.walkMask();
      for (let n = 0; n < cells; n++) if (!walk[n]) blocked[n] = 1;
      // Threat and scorch discs: only the cells in each one's box (one cell of margin) can lie within its reach.
      const disc = (at: Pt, reach: number): void => {
        for (let y = Math.max(0, Math.floor(at.y - reach) - 1); y <= Math.min(size - 1, Math.ceil(at.y + reach)); y++) {
          for (let x = Math.max(0, Math.floor(at.x - reach) - 1); x <= Math.min(size - 1, Math.ceil(at.x + reach)); x++) {
            if (dist(at, { x: x + 0.5, y: y + 0.5 }) <= reach) blocked![y * size + x] = 1;
          }
        }
      };
      for (const e of this.foes) if (e.plane === 'surface') disc(e, this.statsOf(e).range + THREAT_MARGIN);
      for (const s of this.obs.scorches) if (s.until > this.obs.tick) disc(s, s.radius + SCORCH_MARGIN);
      for (const e of this.obs.entities) {
        const f = e.plane === 'surface' ? footprint(e.kind) : undefined;
        if (!f) continue;
        for (let y = Math.floor(e.y - f.h / 2); y < e.y + f.h / 2; y++) {
          for (let x = Math.floor(e.x - f.w / 2); x < e.x + f.w / 2; x++) {
            if (x >= 0 && x < size && y >= 0 && y < size) blocked[y * size + x] = 1;
          }
        }
      }
    }
    // Our own cell (cellFor): a unit on a cell edge starts where its rotated twin does.
    const start = this.frame.pointCell(from.x, from.y);
    if (blocked[start]) return new Uint8Array(cells);
    for (const region of this.regions) if (region[start]) return region;
    const reached = new Uint8Array(cells);
    const queue = [start];
    reached[start] = 1;
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i]!;
      for (let k = 0; k < 4; k++) {
        const next = k === 0 ? (n % size > 0 ? n - 1 : -1) : k === 1 ? (n % size < size - 1 ? n + 1 : -1) : k === 2 ? n - size : n + size;
        if (next < 0 || next >= cells || blocked[next] || reached[next]) continue;
        reached[next] = 1;
        queue.push(next);
      }
    }
    this.regions.push(reached);
    return reached;
  }

  /** Own live, completed Surface structures and held posts: what projects our build radius (the shared rule skips non-sources). */
  private ownSites: BuildRadiusSource[] | null = null;

  /** The shared build rule for a Surface `kind` centred at (x, y), judged on our own structures and the hostile Spires in play. */
  siteError(kind: BuildableKind, x: number, y: number): BuildSiteError | null {
    if (!this.ownSites) {
      const contested = new Set(this.match.posts.filter((p) => p.kind === 'contested').map((p) => p.id));
      this.ownSites = [
        ...this.own.filter((e) => e.plane === 'surface' && isStructureKind(e.kind) && e.state !== 'constructing' && e.hp > 0),
        ...this.posts.filter((p) => p.side === this.army).map((p) => ({ kind: p.kind, x: p.x, y: p.y, contested: contested.has(p.id) })),
      ];
    }
    this.hostileSpires ??= this.hostiles.map((a) => a.spireAt);
    return buildSiteError(kind, this.ownSites, this.hostileSpires, x, y, this.econ);
  }

  private hostileSpires: Pt[] | null = null;

  /**
   * Check the complete site using observation knowledge; visibility is estimated from our surface eyes. The build rule
   * (radius and hostile no-build zones; a Headframe needs only the latter) goes first: it is the cheapest test and
   * rejects most of the map in a wide search.
   */
  buildable(kind: BuildableKind, minX: number, minY: number, sight = true, planned?: readonly AgentCommandIntent[]): boolean {
    const f = STATS[kind].footprint;
    const x = minX + f.w / 2;
    const y = minY + f.h / 2;
    if (this.siteError(kind, x, y)) return false;
    // One level, as the sim requires: footprint and apron all ground or all high.
    if (surfaceSiteLevel(this.ground, this.size, minX, minY, f.w, f.h) < 0) return false;
    for (let y = minY; y < minY + f.h; y++) for (let x = minX; x < minX + f.w; x++) {
      const cell = y * this.size + x;
      if (!this.walkable(cell)) return false;
      if (kind === 'shaft' && this.obs.depths?.[cell] === CELL.bedrock) return false;
      if (kind !== 'headframe' && this.obs.lodes.some((l) => Math.abs(l.x - x) <= 1 && Math.abs(l.y - y) <= 1)) return false;
      if (sight && !this.own.some((e) => e.plane === 'surface' && dist(e, { x: x + 0.5, y: y + 0.5 }) < this.statsOf(e).vision - VISION_MARGIN
        && (!isSurfaceHigh(this.ground[cell]!) || isSurfaceHigh(this.ground[Math.floor(e.y) * this.size + Math.floor(e.x)]!)))) return false;
    }
    if (this.obs.entities.some((e) => e.plane === 'surface' && footprint(e.kind) && footprintOverlap(kind, x, y, e.kind, e.x, e.y, STRUCTURE_SPACING))) return false;
    if (this.obs.queue.some((q) => q.plane === 'surface' && q.x !== undefined && q.y !== undefined && isRadiusBound(q.item)
      && footprintOverlap(kind, x, y, q.item, q.x, q.y, STRUCTURE_SPACING))) return false;
    // Earlier placements in this same decision have not reached the observation queue yet (Headframes snap to lodes).
    return !planned?.some((q) => q.kind === 'queue_add' && isRadiusBound(q.item) && q.item !== 'headframe' && q.x !== undefined && q.y !== undefined
      && footprintOverlap(kind, x, y, q.item, q.x + STATS[q.item].footprint.w / 2, q.y + STATS[q.item].footprint.h / 2, STRUCTURE_SPACING));
  }

  /**
   * Search integer min anchors in canonical order, turned into the world by our frame (footprints are square, so a
   * turned footprint is the footprint at the turned centre). `r` = Infinity: the buildable site inside the build radius
   * nearest (x, y), i.e. the radius edge facing a target beyond it.
   */
  buildSite(kind: Exclude<BuildableKind, 'headframe'>, x: number, y: number, r: number, planned: readonly AgentCommandIntent[], want: (c: number) => boolean = () => true): Pt | null {
    const f = STATS[kind].footprint;
    const k = this.frame.k;
    const canonicalX = canonX(k, x, y, this.size);
    const canonicalY = canonY(k, x, y, this.size);
    const x0 = Math.max(0, Math.ceil(canonicalX - r - f.w / 2));
    const x1 = Math.min(this.size - f.w, Math.floor(canonicalX + r - f.w / 2));
    const y0 = Math.max(0, Math.ceil(canonicalY - r - f.h / 2));
    const y1 = Math.min(this.size - f.h, Math.floor(canonicalY + r - f.h / 2));
    let bestX = -1;
    let bestY = -1;
    let bd = r * r;
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const minX = rotX(k, cx + f.w / 2, cy + f.h / 2, this.size) - f.w / 2;
      const minY = rotY(k, cx + f.w / 2, cy + f.h / 2, this.size) - f.h / 2;
      const d = dmath.pow(minX + f.w / 2 - x, 2) + dmath.pow(minY + f.h / 2 - y, 2);
      if (d > bd || (d === bd && bestX >= 0) || !want(minY * this.size + minX) || !this.buildable(kind, minX, minY, true, planned)) continue;
      bd = d;
      bestX = minX;
      bestY = minY;
    }
    return bestX < 0 ? null : { x: bestX, y: bestY };
  }

  /**
   * Up to `n` vantage cells within `r` tiles of (x, y): high ground first (sees and shoots over cliffs, +range), then
   * forest (hidden until spotted), nearest first. The area is scanned in our frame's order, so rotated requests pick
   * rotated cells. Empty when the area has neither.
   */
  vantage(x: number, y: number, r: number, n: number): Pt[] {
    const found: { c: number; score: number }[] = [];
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(this.size - 1, Math.floor(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(this.size - 1, Math.floor(y + r));
    const cells = this.frame.box(x0, y0, x1, y1);
    const at = { x, y };
    for (let i = 0; i < cells; i++) {
      const c = this.frame.boxCell(i);
      const g = this.ground[c]!;
      if ((!isSurfaceHigh(g) && surfaceFeature(g) !== SURFACE.forest) || !this.walkable(c)) continue;
      const d = cellDist(c, this.size, at);
      if (d <= r) found.push({ c, score: (isSurfaceHigh(g) ? 0 : r) + d });
    }
    found.sort((a, b) => a.score - b.score); // stable: ties keep the frame's scan order
    return found.slice(0, n).map((f) => ({ x: cellCentreX(f.c, this.size), y: cellCentreY(f.c, this.size) }));
  }

  /** Live units only: lethal damage may precede entity cleanup in the observed snapshot. */
  units(kind: UnitKind, plane: Plane = this.stats[kind].plane): Entity[] {
    return this.own.filter((e) => e.kind === kind && e.plane === plane && e.hp > 0);
  }

  /**
   * Team queue entries (any seat's) for `item`: teammates' entries count too, so nobody doubles them. Structures already
   * under construction are left out: their sites are own entities.
   */
  queued(item: QueueItem): number {
    let n = 0;
    for (const q of this.obs.queue) if (q.item === item && q.site === undefined) n++;
    return n;
  }

  /** Our built Shafts that are portals now (not sealed): the only way troopers change between Surface and Depths. */
  shafts(): Entity[] {
    return this.own.filter((e) => e.kind === 'shaft' && e.state !== 'constructing' && e.sealed !== true);
  }

  /** Entries this seat requested (its footprint in the shared queue). */
  ownQueued(): number {
    let n = 0;
    for (const q of this.obs.queue) if (q.by === this.obs.role) n++;
    return n;
  }

  /**
   * Can the team pay for `kind` from authoritative free funds, keeping `reserve` alloy?
   * Only this decision's new requests are deducted locally; observed commitments are already earmarked.
   */
  affordable(kind: StatKind, reserve: number): boolean {
    const s = this.stats[kind];
    return this.affordableCost(s.alloy, s.energy, reserve);
  }

  affordableCost(costAlloy: number, costEnergy: number, reserve: number): boolean {
    const alloy = this.obs.res.freeAlloy - this.reservedAlloy;
    const energy = this.obs.res.freeEnergy - this.reservedEnergy;
    return alloy >= costAlloy + reserve && (costEnergy === 0 || energy >= costEnergy);
  }

  reserveCost(alloy: number, energy: number): void {
    this.reservedAlloy += alloy;
    this.reservedEnergy += energy;
  }

  segmentAlive(plane: Plane): boolean {
    return (this.obs.spire.find((s) => s.plane === plane)?.hp ?? 0) > 0;
  }

  /**
   * Spire damage multiplier for planning a push on a hostile segment: rules.spire.suddenDeathDamage from sudden
   * death's public countdown on (an army moving out then arrives as it starts), else 1. Public rules and schedule only.
   */
  spireDamageFactor(): number {
    const at = this.econ.suddenDeathTicks;
    const on = at > 0 && (this.obs.tick >= at || this.obs.schedule.some((s) => s.kind === 'sudden_death'));
    return on ? this.econ.suddenDeathDamage : 1;
  }

  /** Hostile charges (any hostile army's) planted within `r` tiles of our Spire. */
  chargesNearHome(r: number): FullObservation['charges'] {
    return this.obs.charges.filter((ch) => this.hostile(ch.side) && dist({ x: ch.x + 0.5, y: ch.y + 0.5 }, this.home) <= r);
  }

  /** Hostile fighters (troopers, sappers) we see in the depths. */
  depthsFighters(): Entity[] {
    return this.foes.filter((e) => e.plane === 'depths' && (e.kind === 'trooper' || e.kind === 'sapper'));
  }

  /**
   * Where our Orbit ships wait by the derelict ruin: CORE_POST_MARGIN beyond the hull's outer edge on the diagonal
   * toward our corner, between two breaches (ships parked in a breach mouth would block our own tows), on the order
   * grid in our frame so rotated armies get rotated posts; the map centre without a ruin.
   */
  ruinPost(): Pt {
    const g = this.match.derelict;
    const mid = this.size / 2;
    if (!g) return { x: mid, y: mid };
    const v = snap(mid - (g.hullOuter + CORE_POST_MARGIN) * Math.SQRT1_2, this.size);
    return this.frame.toWorld(v, v);
  }

  tremorsNearHome(r: number): FullObservation['tremors'] {
    return this.obs.tremors.filter((t) => dist({ x: t.x + 0.5, y: t.y + 0.5 }, this.home) <= r);
  }

  /** Is there a structure (own, or an enemy one we see) on lode outcrop `l`? */
  lodeTaken(l: Pt): Entity | undefined {
    const at = { x: l.x + 0.5, y: l.y + 0.5 };
    return this.obs.entities.find((e) => e.plane === 'surface' && (e.kind === 'headframe' || e.kind === 'turret' || e.kind === 'shaft') && dist(e, at) < LODE_SITE_REACH);
  }
}
