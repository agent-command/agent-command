/**
 * Observer data, derived from released frames only (never from a live match): the scoreboard sides, army
 * composition, the key-moment timeline and the vision choices an observer grant permits. Pure functions and small
 * stateful accumulators, no DOM, so panels render from the same values the tests check. The auto-director lives in
 * observer-director.ts.
 */
import { CELL, PLANES, SCHEDULE_CAP, STATS, STRUCTURE_KINDS, SURFACE, TICK_RATE, UNIT_KINDS, VISION_BITS_PER_WORD, isArmyId, surfaceFeature, unpackTerrain, type ArmyId, type Colour, type Entity, type GameEvent, type Kind, type ObserverView, type Outcome, type Plane, type UnitKind, type View } from '@agent-command/game/contract';
import type { ObserverGrant } from 'playerthree/protocol';
import { PUBLIC_FX } from './audio/director.ts';
import { idSpace, type MatchView } from './match-view.ts';
import { planeList } from './text.ts';

export type ObserverSideData = ObserverView['sides'][number];
type SpireHp = { hp: number; maxHp: number };

/** One scoreboard column. `disclosed` is false when this projection only shows the army through its hostiles' fog. */
export interface BoardSide {
  army: ArmyId;
  disclosed: boolean;
  res: View['res'] | undefined;
  /** Units only (structures excluded): current count and replacement value, alloy + energy. */
  forces: { units: number; value: number } | undefined;
  spire: Record<Plane, SpireHp | undefined>;
  queue: View['queue'];
  /** The id namespace of `queue`'s producer and site ids (match-view.ts idSpace). */
  names: string;
  research: View['research'] | undefined;
}

const IS_UNIT: ReadonlySet<string> = new Set(UNIT_KINDS);
const isUnit = (kind: Kind): kind is UnitKind => IS_UNIT.has(kind);

function spireOf(segments: readonly { plane: Plane; hp: number; maxHp: number }[]): Record<Plane, SpireHp | undefined> {
  const out: Record<Plane, SpireHp | undefined> = { depths: undefined, surface: undefined, sky: undefined, orbit: undefined };
  for (const segment of segments) out[segment.plane] = { hp: segment.hp, maxHp: segment.maxHp };
  return out;
}

/** An army as the omniscient projection discloses it (replacement costs come from the simulation). */
export function observerBoard(side: ObserverSideData): BoardSide {
  let units = 0;
  let value = 0;
  for (const row of side.forces) { units += row.units; value += row.alloy + row.energy; }
  return { army: side.army, disclosed: true, res: side.res, forces: { units, value }, spire: spireOf(side.spire), queue: side.queue, names: 'sim', research: side.research };
}

/** An army as one army's fogged view shows it: the viewing army in full (unit values at this match's rules), others by sight. */
export function viewBoard(view: MatchView, army: ArmyId): BoardSide {
  if (army !== view.army) {
    const spire = spireOf([]);
    for (const e of view.entities) if (e.kind === 'spire' && e.side === army) spire[e.plane] = { hp: e.hp, maxHp: e.maxHp };
    return { army, disclosed: false, res: undefined, forces: undefined, spire, queue: [], names: idSpace(view), research: undefined };
  }
  let units = 0;
  let value = 0;
  for (const e of view.entities) {
    if (e.side !== army || !isUnit(e.kind)) continue;
    const stats = view.match.rules.stats[e.kind];
    units++;
    value += stats.alloy + stats.energy;
  }
  return { army, disclosed: true, res: view.res, forces: { units, value }, spire: spireOf(view.spire), queue: view.queue, names: idSpace(view), research: view.research };
}

/** Units per plane and kind for one army, in the closed kind order (stable rows for the composition panel). */
export function composition(entities: readonly Entity[], army: ArmyId): { plane: Plane; kinds: { kind: Kind; count: number }[] }[] {
  const counts = new Map<string, number>();
  for (const e of entities) if (e.side === army && isUnit(e.kind)) counts.set(`${e.plane}:${e.kind}`, (counts.get(`${e.plane}:${e.kind}`) ?? 0) + 1);
  const rows: { plane: Plane; kinds: { kind: Kind; count: number }[] }[] = [];
  for (const plane of [...PLANES].reverse()) {
    const kinds = UNIT_KINDS.flatMap((kind) => { const count = counts.get(`${plane}:${kind}`); return count ? [{ kind, count }] : []; });
    if (kinds.length) rows.push({ plane, kinds });
  }
  return rows;
}

/** A lens: the army it shows, its alliance colour, its current sight and what conceals from it. */
interface Lens {
  army: ArmyId;
  colour: Colour | undefined;
  armies: MatchView['match']['armies'];
  vision: View['vision'];
  size: number;
  terrain: Uint8Array;
  /** Current natural (growing or mature) and seeded storms: Sky inside them is not provably seen. */
  storms: readonly { x: number; y: number; radius: number }[];
}

/** Surface terrain codes per match (forest concealment), unpacked once. */
const SURFACE_CODES = new WeakMap<MatchView['match'], Uint8Array>();
const STRUCTURE: ReadonlySet<Kind> = new Set(STRUCTURE_KINDS);
/** Depths unit states that face a work cell (present.ts DEPTHS_WORK_STATES): others see that heading only with sight of the cell. */
const DEPTHS_WORK: Readonly<Partial<Record<Entity['state'], true>>> = { digging: true, mining: true, contested: true, fortifying: true, constructing: true, bridging: true, undermining: true, breaching: true };
/** Entity fields the server gives only an entity's own army (agent/present.ts entityFor), whatever is seen. */
const OWNER_ONLY = ['output', 'miningAssigned', 'miningTarget', 'hangar', 'sealed', 'mooringPowered', 'extractorPowered', 'oreBuffer', 'mooringGrace', 'mooringTarget', 'mooringTower'] as const;
const ROCK_DETAIL = ['resourceType', 'volatile', 'resourceRemaining', 'fuseUntil'] as const;

function allied(lens: Lens, side: string): boolean {
  for (const army of lens.armies) if (army.id === side) return army.colour === lens.colour;
  return false;
}

/** Raw cell sight on `plane` (the server's vision bits). */
function visible(lens: Lens, plane: Plane, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= lens.size || cy >= lens.size) return false;
  const c = cy * lens.size + cx;
  return ((lens.vision[plane][Math.floor(c / VISION_BITS_PER_WORD)] ?? 0) >>> (c % VISION_BITS_PER_WORD) & 1) === 1;
}

function inStorm(lens: Lens, x: number, y: number): boolean {
  for (const s of lens.storms) if ((x - s.x) ** 2 + (y - s.y) ** 2 <= s.radius * s.radius) return true;
  return false;
}

/**
 * The server's seesCell, as far as it is provable here: sight of the cell, never a Surface forest (spotting is army
 * knowledge) and never Sky inside a storm (storm sight is army knowledge).
 */
function sees(lens: Lens, plane: Plane, x: number, y: number): boolean {
  const cx = Math.floor(x), cy = Math.floor(y);
  if (!visible(lens, plane, cx, cy)) return false;
  if (plane === 'surface' && surfaceFeature(lens.terrain[cy * lens.size + cx]!) === SURFACE.forest) return false;
  return plane !== 'sky' || !inStorm(lens, x, y);
}

/** A neutral body (rock, core): its cell in sight, every cell it touches when it sits on a cell edge. */
function bodySeen(lens: Lens, plane: Plane, x: number, y: number): boolean {
  const e = 1e-6;
  return visible(lens, plane, Math.floor(x - e), Math.floor(y - e)) && visible(lens, plane, Math.floor(x + e), Math.floor(y - e))
    && visible(lens, plane, Math.floor(x - e), Math.floor(y + e)) && visible(lens, plane, Math.floor(x + e), Math.floor(y + e));
}

/** Seeing any cell a structure occupies reveals it (the server's footprintSeen). */
function footprintSeen(lens: Lens, kind: Kind, plane: Plane, x: number, y: number): boolean {
  const f = (STATS as Partial<Record<Kind, { footprint?: { w: number; h: number } }>>)[kind]?.footprint;
  if (!f) return visible(lens, plane, Math.floor(x), Math.floor(y));
  for (let yy = Math.max(0, Math.floor(y - f.h / 2)); yy < Math.min(lens.size, Math.ceil(y + f.h / 2)); yy++)
    for (let xx = Math.max(0, Math.floor(x - f.w / 2)); xx < Math.min(lens.size, Math.ceil(x + f.w / 2)); xx++) if (visible(lens, plane, xx, yy)) return true;
  return false;
}

/** The server's sees(army, e), keeping only the branches that prove sight; the rest (spire senses, climbs, cloak detection) drop the entity. */
function entitySeen(lens: Lens, e: Entity): boolean {
  if (e.kind !== 'asteroid' && allied(lens, e.side)) return true;
  if (e.hangar) return false;
  if (e.kind === 'island' || e.kind === 'post') return true;
  if (e.kind === 'asteroid' && e.state === 'falling') return true;
  if (e.cloaked) return false;
  if (e.plane === 'sky' && inStorm(lens, e.x, e.y)) return false;
  // What stands in an island's slot is public (unless a storm hides it).
  if (e.plane === 'sky' && STRUCTURE.has(e.kind) && e.link) return true;
  if (STRUCTURE.has(e.kind)) return footprintSeen(lens, e.kind, e.plane, e.x, e.y);
  if (e.kind === 'asteroid' || e.kind === 'core') return bodySeen(lens, e.plane, e.x, e.y);
  return sees(lens, e.plane, e.x, e.y);
}

/** An entity as the lens army's projection presents it (entityFor): owner-only and unseen detail removed. */
function lensEntity(lens: Lens, e: Entity): Entity {
  if (e.side === lens.army) return e;
  const out: Record<string, unknown> = { ...e };
  for (const key of OWNER_ONLY) delete out[key];
  if (e.kind === 'asteroid' && !sees(lens, e.plane, e.x, e.y)) for (const key of ROCK_DETAIL) delete out[key];
  if (e.kind === 'island' && !sees(lens, 'sky', e.x, e.y)) delete out.oreRemaining;
  // A Drill Yard's conversion is its owner's (built or not is not provable here: drop it).
  if (e.kind === 'drill_yard') { delete out.carry; delete out.link; delete out.progress; }
  // An island's mooring phase is public; a tower's is its owner's (others see it only with the island in sight: dropped).
  if (e.kind === 'mooring_tower') delete out.mooringState;
  if (e.plane === 'depths' && DEPTHS_WORK[e.state]) delete out.heading;
  // Who is taking an island or post, and how far, only with sight of it.
  if ((e.kind === 'island' || e.kind === 'post') && !sees(lens, e.kind === 'island' ? 'sky' : 'surface', e.x, e.y)) {
    out.state = e.kind === 'post' ? 'idle' : 'drifting';
    delete out.link; delete out.progress;
  }
  return out as unknown as Entity;
}

/** An effect the lens army's projection would carry (fx): its own, public ones, and others where it provably sees. */
function lensFx(lens: Lens, f: View['fx'][number]): View['fx'][number] | undefined {
  if (f.side !== lens.army && !PUBLIC_FX[f.kind] && !sees(lens, f.plane, f.x, f.y)) return undefined;
  if (f.targetElevation === undefined || f.tp === undefined || f.tx === undefined || f.ty === undefined || sees(lens, f.tp, f.tx, f.ty)) return f;
  const { targetElevation: _hidden, ...out } = f;
  return out;
}

/**
 * One army's fog over the omniscient projection: shown until that army's own stream plays, or while a lobby observer
 * looks through it. Deliberately conservative: it keeps only what the server's per-army projection (agent/present.ts
 * `view`) provably shows from the data at hand (that army's current sight, its own and allied things, public state) and
 * drops whatever that projection derives from army knowledge the omniscient row does not carry (explored Depths,
 * discovered lodes, located pockets, remembered cracks and ghosts, felt charges and tremors, flood sightings, forest
 * spotting, storm sight, cloak detection). Showing too little is acceptable here; anything that army could not see is not.
 */
export function lensView(world: MatchView, side: ObserverSideData): MatchView {
  const match = world.match, size = match.rules.map.size;
  let terrain = SURFACE_CODES.get(match);
  if (!terrain) { terrain = unpackTerrain(match.terrain, size); SURFACE_CODES.set(match, terrain); }
  const storms = [...world.weather.storms.filter((s) => s.strength > 0), ...world.weather.seeded];
  const lens: Lens = { army: side.army, colour: match.armies.find((a) => a.id === side.army)?.colour, armies: match.armies, vision: side.vision, size, terrain, storms };
  const entities: Entity[] = [];
  const islands = new Map<string, Entity>();
  for (const e of world.entities) {
    if (e.kind === 'island') islands.set(e.id, e);
    if (entitySeen(lens, e)) entities.push(lensEntity(lens, e));
  }
  const fx: View['fx'] = [];
  for (const f of world.fx) { const shown = lensFx(lens, f); if (shown) fx.push(shown); }
  // Charges (present.ts charges): own and allied, those in Depths sight now, and every one in its public window.
  const depthsRules = match.rules.depths;
  const publicFrom = depthsRules.chargesFogged ? depthsRules.chargePublicTime * TICK_RATE : Infinity;
  const charges = world.charges.flatMap((ch) => {
    const own = allied(lens, ch.side);
    if (!own && !visible(lens, 'depths', ch.x, ch.y) && ch.tick - world.tick > publicFrom) return [];
    if (own || ch.stack === undefined) return [ch];
    const { stack: _private, ...out } = ch;
    return [out];
  });
  // Schedule (present.ts schedule): the public entries, the vent without a lode cell, the lens's known charges.
  const schedule: View['schedule'] = [];
  for (const entry of world.schedule) {
    if (entry.kind === 'lode_vent') schedule.push({ kind: entry.kind, tick: entry.tick });
    else if (entry.kind === 'asteroid_spawn' || entry.kind === 'sudden_death' || entry.kind === 'derelict_open' || entry.kind === 'core_regrows') schedule.push(entry);
  }
  for (const ch of charges) schedule.push({ kind: 'collapse', tick: ch.tick, x: ch.x + 0.5, y: ch.y + 0.5 });
  schedule.sort((a, b) => a.tick - b.tick);
  const depths = world.depths.map((cell, c) => (visible(lens, 'depths', c % size, Math.floor(c / size)) ? cell : CELL.unknown));
  const { x: _x, y: _y, ...lode } = world.motherLode ?? {};
  return {
    ...world, army: side.army, res: side.res, spire: side.spire, queue: side.queue, research: side.research, events: side.events,
    vision: side.vision, rank: side.rank, entities, fx, charges, schedule: schedule.slice(0, SCHEDULE_CAP), depths,
    ...(world.motherLode ? { motherLode: lode as NonNullable<View['motherLode']> } : {}),
    // An occupied hardpoint is disclosed with sight of its mount: allied, or an island slot no storm hides.
    islands: world.islands.map((path) => {
      if (!path.hardpoint || allied(lens, path.hardpoint.side)) return path;
      const island = islands.get(path.id);
      if (island && !inStorm(lens, island.x, island.y)) return path;
      const { hardpoint: _hidden, ...out } = path;
      return out;
    }),
    flares: world.flares.filter((f) => allied(lens, f.side) || visible(lens, 'depths', f.x, f.y)),
    oreCaches: world.oreCaches.flatMap((cache) => {
      const surface = cache.alloy > 0 && sees(lens, 'surface', cache.x, cache.y);
      const below = cache.below && sees(lens, 'depths', cache.below.x, cache.below.y) ? cache.below : undefined;
      if (!surface && !below) return [];
      return [{ id: cache.id, x: surface ? cache.x : below!.x, y: surface ? cache.y : below!.y, alloy: surface ? cache.alloy : 0, radius: cache.radius, ...(below ? { below } : {}) }];
    }),
    scorches: world.scorches.filter((s) => sees(lens, 'surface', s.x, s.y)),
    lodes: world.lodes.filter((l) => visible(lens, 'surface', l.x, l.y)),
    cracks: world.cracks.filter((c) => visible(lens, 'depths', c.x, c.y)).map(({ x, y, stage }) => ({ x, y, stage })),
    pockets: [], tremors: [], memory: [], alerts: [], rally: [], designations: { normal: [], urgent: [] },
  };
}

/** One perspective: an army's fog (`value` = its id) or `all`; `stream` = served separately rather than a lens over `all`. */
export interface VisionOption { value: ArmyId | 'all'; stream: boolean }

/**
 * Perspectives the grant permits, never more: an omniscient grant gets All plus each army's lens; a team grant gets
 * only its army. The public featured relay serves every perspective as its own stream: All first while its match is
 * all bots (an omniscient grant), then each army's fog.
 */
export function visionOptions(grant: ObserverGrant, featuredArmies?: readonly ArmyId[]): VisionOption[] {
  if (featuredArmies) return [...(grant.kind === 'omniscient' ? ['all' as const] : []), ...featuredArmies].map((value) => ({ value, stream: true }));
  if (grant.kind === 'team') return isArmyId(grant.team) ? [{ value: grant.team, stream: true }] : [];
  return [{ value: 'all', stream: true }, ...grant.teams.filter(isArmyId).map((army) => ({ value: army, stream: false }))];
}

export type MomentKind = 'kill' | 'spire' | 'capture' | 'breakthrough';
export interface Moment {
  id: number;
  tick: number;
  kind: MomentKind;
  event: GameEvent['kind'];
  /** The acting side (the killer, the Spire's attacker, the captor, the side breaking through), when known. */
  team: string | undefined;
  /** The side that suffered it (kills, Spire hits). */
  victim: string | undefined;
  plane: Plane;
  x: number;
  y: number;
  subject: Kind | undefined;
  count: number;
}

const MOMENT: Partial<Record<GameEvent['kind'], MomentKind>> = {
  enemy_killed: 'kill', structure_destroyed: 'kill', spire_damaged: 'spire', island_captured: 'capture',
  tunnel_breach: 'breakthrough', breach_opened: 'breakthrough', chasm_opened: 'breakthrough',
};
/** Same-kind moments by the same side on the same plane this close (ticks, tiles) merge into one counted line. */
const MERGE_TICKS = 3 * TICK_RATE;
const MERGE_TILES = 10;
const MAX_MOMENTS = 200;

/**
 * Key moments from every side's sliding event window. Each side's window repeats for ~10 s, so only events newer
 * than that side's last ingested tick count; events published to every side (breakthroughs) are counted once.
 */
export class Timeline {
  readonly moments: Moment[] = [];
  /** Bumped whenever `moments` changes, so panels re-render only then. */
  revision = 0;
  private readonly lastTick = new Map<string, number>();
  private readonly shared = new Map<string, number>();
  private nextId = 1;

  ingest(perceiver: string, events: readonly GameEvent[]): void {
    const after = this.lastTick.get(perceiver) ?? -1;
    let newest = after;
    for (const ev of events) {
      if (ev.tick <= after) continue;
      newest = Math.max(newest, ev.tick);
      const kind = MOMENT[ev.kind];
      if (!kind) continue;
      if (kind === 'breakthrough') {
        const key = `${ev.tick}:${ev.kind}:${ev.x}:${ev.y}`;
        if (this.shared.has(key)) continue;
        this.shared.set(key, ev.tick);
      }
      const team = kind === 'spire' ? ev.side : kind === 'kill' ? perceiver : ev.side ?? perceiver;
      const victim = kind === 'spire' ? perceiver : kind === 'kill' ? ev.side : undefined;
      this.add(kind, ev, team, victim);
    }
    this.lastTick.set(perceiver, newest);
    for (const [key, tick] of this.shared) if (tick < newest - 10 * TICK_RATE) this.shared.delete(key);
  }

  private add(kind: MomentKind, ev: GameEvent, team: string | undefined, victim: string | undefined): void {
    for (let i = this.moments.length - 1; i >= 0; i--) {
      const last = this.moments[i]!;
      if (ev.tick - last.tick > MERGE_TICKS) break;
      if (last.kind === kind && last.team === team && last.victim === victim && last.plane === ev.plane && Math.abs(last.x - ev.x) <= MERGE_TILES && Math.abs(last.y - ev.y) <= MERGE_TILES) {
        last.count++; last.tick = ev.tick; last.x = ev.x; last.y = ev.y; last.event = ev.kind; last.subject = ev.subject;
        this.revision++;
        return;
      }
    }
    this.moments.push({ id: this.nextId++, tick: ev.tick, kind, event: ev.kind, team, victim, plane: ev.plane, x: ev.x, y: ev.y, subject: ev.subject, count: 1 });
    if (this.moments.length > MAX_MOMENTS) this.moments.splice(0, this.moments.length - MAX_MOMENTS);
    this.revision++;
  }

  reset(): void { this.moments.length = 0; this.lastTick.clear(); this.shared.clear(); this.revision++; }
}

/** mm:ss of game time. */
export function gameClock(tick: number): string {
  const seconds = Math.max(0, Math.floor(tick / TICK_RATE));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** How a match ended, as its released final frame shows it. */
export type EndReason = 'spire' | 'time_cap' | 'forfeit' | 'ended';
export const END_REASON_LABEL: Readonly<Record<EndReason, string>> = { spire: 'Spire destroyed', time_cap: 'Time cap', forfeit: 'Forfeit', ended: 'Ended early' };

/**
 * Why the match ended at `tick`: the time cap once the tick reaches it (ticks); else the public `army_eliminated`
 * events of that final tick. Each names the segment whose fall decided it (its plane; a forfeit: surface): a fallen
 * army whose deciding segment still stands forfeited (a Spire kill leaves it at 0); a Spire hidden by fog is judged
 * by the killing blow, which a forfeit never carries. No elimination at all: the host ended the match.
 */
export function endReason(tick: number, timeCapTicks: number, events: Iterable<GameEvent>, segmentHp: (army: ArmyId, plane: Plane) => number | undefined): EndReason {
  if (tick >= timeCapTicks) return 'time_cap';
  let fell = false;
  for (const ev of events) {
    if (ev.kind !== 'army_eliminated' || ev.tick !== tick || !ev.side || !isArmyId(ev.side)) continue;
    fell = true;
    const hp = segmentHp(ev.side, ev.plane);
    if (hp === undefined ? ev.killer === undefined : hp > 0) return 'forfeit';
  }
  return fell ? 'spire' : 'ended';
}

/**
 * The end card's reason line. A Spire end names the fallen segments of each army eliminated on the final tick: its
 * crowns row's fallen segments (lossRule crowns), else the deciding segment its `army_eliminated` event names; with
 * several such armies each is prefixed with `name`. Every other reason: END_REASON_LABEL.
 */
export function endLabel(reason: EndReason, tick: number, events: Iterable<GameEvent>, crowns: View['crowns'], name: (army: ArmyId) => string): string {
  if (reason !== 'spire') return END_REASON_LABEL[reason];
  const fell = new Map<ArmyId, Plane[]>();
  for (const ev of events) {
    if (ev.kind !== 'army_eliminated' || ev.tick !== tick || !ev.side || !isArmyId(ev.side) || fell.has(ev.side)) continue;
    const row = crowns?.find((entry) => entry.army === ev.side);
    fell.set(ev.side, row?.fallen.length ? [...row.fallen] : [ev.plane]);
  }
  if (!fell.size) return END_REASON_LABEL.spire;
  const line = (planes: Plane[]) => `${planeList(planes)} ${planes.length === 1 ? 'segment' : 'segments'} fell`;
  return fell.size === 1 ? line([...fell.values()][0]!) : [...fell].map(([army, planes]) => `${name(army)}: ${line(planes)}`).join(' · ');
}

/** One army's line on the observer end card: its result, place and what it had left. */
export interface Standing {
  army: ArmyId;
  outcome: Exclude<Outcome, 'running'>;
  /** 1 = the winning alliance; tied armies share a place; undefined when this projection cannot know it. */
  rank: number | undefined;
  forces: BoardSide['forces'];
  /** Total Spire HP left over the known segments; undefined when none is in sight. */
  spire: SpireHp | undefined;
}

/**
 * Every army's final line, best place first (army order within a place, unknown places last). Places come from the
 * projection (`known`: an omniscient row per army, a fogged view its own army); otherwise the outcomes alone decide
 * them: the winning or drawing alliance places first and, when only two alliances played, the other one second.
 */
export function standings(armies: readonly { id: ArmyId; colour: Colour }[], outcomes: Readonly<Record<string, Outcome>>, known: ReadonlyMap<ArmyId, number>, boards: ReadonlyMap<ArmyId, BoardSide>): Standing[] {
  const alliances = new Set(armies.map((army) => army.colour)).size;
  const rows = armies.map(({ id }): Standing => {
    const result = outcomes[id];
    const outcome = result === 'win' || result === 'draw' ? result : 'loss';
    const board = boards.get(id);
    let spire: SpireHp | undefined;
    for (const plane of PLANES) {
      const segment = board?.spire[plane];
      if (!segment) continue;
      spire ??= { hp: 0, maxHp: 0 };
      spire.hp += Math.max(0, segment.hp); spire.maxHp += segment.maxHp;
    }
    const rank = known.get(id) ?? (outcome !== 'loss' ? 1 : alliances === 2 ? 2 : undefined);
    return { army: id, outcome, rank, forces: board?.forces, spire };
  });
  // Stable: army order within a place; unknown places (Infinity − Infinity = NaN compares equal) keep theirs last.
  return rows.toSorted((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}
