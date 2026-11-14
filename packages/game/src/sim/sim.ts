/**
 * Agent Command simulation: authoritative, deterministic (seeded), 20 Hz.
 * Pure state + rules; no I/O. Presentation (fogged observations/views) lives in agent/present.ts.
 */
import { createHash } from 'node:crypto';
import {
  type ArmyId,
  type Colour,
  type Side,
  COLOURS,
  compileRules,
  type Econ,
  type EventKind,
  type FxKind,
  hashRules,
  isIslandStructure,
  isHardpointKind,
  isNeutralKind,
  isStructureKind,
  isSurfaceBlocked,
  isCellStructure,
  CELL,
  isUnitKind,
  type Kind,
  MAX_ARMIES,
  type MatchOptions,
  type Outcome,
  packTerrain,
  type Plane,
  type PlaneTransit,
  PLANES,
  resolveRules,
  resolveUpgrade,
  type RockSize,
  type Rules,
  type StatKind,
  type Stats,
  sunAngleAt,
  sunLit,
  sunSpeedOf,
  SURFACE,
  surfaceFeature,
  type TerrainPreset,
  TICK_RATE,
  UPGRADE_IDS,
  type UpgradeCost,
  type UpgradeId,
  VISION_BITS_PER_WORD,
} from '../rules/contract.ts';
import { expandMapDocument, hashMapDocument, type MapDocument, publicMapDocument, resolveMapDocument } from '../maps/maps.ts';
import { type IslandOrbit, LODE_POCKET, type World } from '../maps/world.ts';
import { cellCentreX, cellCentreY, cellOf, clampPos } from '../util/grid.ts';
import { type Army, armyBit, armyIdOfSlot, canonX, canonY, isArmy, NEUTRAL, rotCell, rotX, rotY, type SideId } from '../util/teams.ts';
import { type Barrier, type DepthsCosts, depthsCosts, FLOW_FIELD_CAP, FlowFields, LineOfSight } from '../nav/nav.ts';
import { ORCA_MAX_NEIGHBOURS } from '../nav/orca.ts';
import { CaptureZones } from '../planes/capture.ts';
import { DepthsNav } from '../planes/depths-nav.ts';
import { DepthsPlane } from '../planes/depths.ts';
import { Designations } from '../planes/designations.ts';
import { DrillYards } from '../planes/drill-yard.ts';
import { DerelictPlane } from '../planes/derelict.ts';
import { type DerelictGeometry, derelictGeometry } from '../rules/derelict.ts';
import { OrbitPlane } from '../planes/orbit.ts';
import { Payloads } from '../planes/payloads.ts';
import { ForwardPosts } from '../planes/posts.ts';
import { SkyPlane } from '../planes/sky.ts';
import { SurfacePlane } from '../planes/surface.ts';
import { PlaneTransits } from '../planes/transit.ts';
import { SkyWeather } from '../planes/weather.ts';
import { type ResolvedPayloads, type ResolvedRock, resolvePayloads, resolveRocks } from '../rules/payload.ts';
import { mixin } from '../util/mixin.ts';
import { Rng } from '../util/rng.ts';
import { SimCombat } from './combat.ts';
import { SimDeploy } from './deploy.ts';
import {
  ACCOUNT_SLOTS,
  BUCKET,
  EVENT_RETAIN,
  HOLD_ZONE_HP,
  INCOME_WINDOW_S,
  LONG_AGO,
  REGION_BOUNDS,
  SCRATCH_ENTS,
  START_UNITS,
  TIMELINE_CAP,
} from './constants.ts';
import { SimDigest } from './digest.ts';
import { SimEconomy } from './economy.ts';
import { type EffectiveStats, Ent } from './ent.ts';
import { SimMovement } from './movement.ts';
import { SimOrders } from './orders.ts';
import { SimProduction } from './production.ts';
import { recordingListeners } from './recording.ts';
import { SimResearch } from './research.ts';
import { SimSpawn } from './spawn.ts';
import type { ArmyState, Charge, Flare, Flood, FxRec, Lance, LodeState, ModifierRows, OreCache, Projectile, QueueEntry, Scorch, SeatState, SimEvent, SimFx, VisionGroup } from './state.ts';
import { SimTick } from './tick.ts';
import { SimVision } from './vision.ts';
import { aliasTable, SimAliases } from './aliases.ts';
import { dmath } from '../util/fdlibm.js';

/** One army of a match: its map slot (document corner) and colour (alliance). */
export interface ArmySpec {
  slot: number;
  colour: Colour;
}

/** How a match ended: per army its outcome (never `running`) and rank (1 = the winning alliance). */
export interface SimResult {
  outcome: Exclude<Outcome, 'running'>[];
  rank: number[];
}

/** Events that also enter an army's match timeline (the long-lived summary of what happened). */
const TIMELINE_KINDS: Partial<Record<EventKind, true>> = {
  structure_lost: true,
  structure_destroyed: true,
  collapse: true,
  fell_into_depths: true,
  impact_incoming: true,
  impact: true,
  asteroid_intercepted: true,
  island_captured: true,
  island_lost: true,
  post_captured: true,
  post_lost: true,
  spire_damaged: true,
  enemy_sapper_seen: true,
  tunnel_breach: true,
  army_eliminated: true,
  sudden_death: true,
  crown_lost: true,
  segment_rebuilt: true,
};

/**
 * A uint32 seed for one event stream, one-way from the match seed (sha256): storms and seen rocks expose their stream's
 * output, and brute-forcing one 32-bit stream must reveal neither the match seed nor another stream.
 */
function streamSeed(seed: number, stream: 'asteroids' | 'rocks' | 'weather'): number {
  return createHash('sha256').update(`agent-command/${stream}:${seed}`).digest().readUInt32BE(0);
}

/** The systems below share this one object's state; their methods are mixed into the prototype at load. */
export interface Sim extends SimTick, SimSpawn, SimVision, SimAliases, SimMovement, SimOrders, SimCombat, SimDeploy, SimEconomy, SimProduction, SimResearch, SimDigest, OrbitPlane, DerelictPlane, Payloads, CaptureZones, SkyPlane, SurfacePlane, ForwardPosts, DrillYards, PlaneTransits, DepthsPlane, DepthsNav, Designations {}

export class Sim {
  /**
   * The match seed. A live server keeps it secret (released with the replay after the match): it seeds the hidden map
   * layers of a generated map and, one-way (streamSeed), the event streams. Never part of any client-bound data.
   */
  readonly seed: number;
  /** Hash of the public map: a generated map's hidden layers are left out (publicMapDocument), an authored map is whole. */
  readonly mapHash: number;
  readonly size: number;
  readonly n: number;
  readonly mapDocument: MapDocument;
  /** slots of the map (2: C2 point mirror, 4: C4 quarter turns) */
  readonly sides: number;
  /** quarter turns from one slot to the next (4 / sides) */
  readonly slotStep: number;
  /** owner index → slot, frame and hostile-army bits (index NEUTRAL: frame 0, hostile to nobody) */
  readonly armySlot = new Uint8Array(MAX_ARMIES + 1);
  readonly armyFrame = new Uint8Array(MAX_ARMIES + 1);
  readonly hostileMask = new Uint8Array(MAX_ARMIES + 1);
  readonly armyColour: readonly Colour[];
  /** every army index, in order (event audiences) */
  readonly allArmies: readonly Army[];
  /** contract id (map corner) of each army */
  readonly armyIds: readonly ArmyId[];
  /** each army's income multiplier (rules.handicap.income of its corner): every income credit goes through `earn` */
  readonly incomeMultiplier: Float64Array;
  /** armies that forfeited this tick: eliminated at the next outcome check, ranked below that tick's fallen */
  forfeits = 0;
  /** Spire centre per army (the document's start of its slot) */
  readonly spireAt: readonly { readonly x: number; readonly y: number }[];
  /** tick each army was eliminated (-1: in play), and the hostile army that dealt the killing blow (NEUTRAL: none) */
  readonly eliminatedAt: Int32Array;
  readonly eliminatedBy: Uint8Array;
  /** total Spire HP of each army when it was eliminated, before its remains were removed (rank ties) */
  readonly eliminatedHp: Float64Array;
  /** crowns each army had lost when it was eliminated (lossRule crowns rank ties; a forfeit: Infinity) */
  readonly eliminatedCrowns: Float64Array;
  /** segments down when each army was eliminated, bit PLANE_INDEX[plane] (public crowns rows) */
  readonly eliminatedFallen: Uint8Array;
  readonly bucketWidth: number;
  readonly bucketCount: number;
  readonly orbitCellBearing: Float64Array;
  readonly visionWords: number;
  tick = 0;
  /** asteroid spawns: region, position, drift and size (seen whenever the rock is) */
  readonly rng: Rng;
  /** Rock type and independent volatility use a separate stream from spawn positions. */
  readonly rockRng: Rng;
  readonly cells: Uint8Array;
  readonly ore: Uint8Array;
  readonly owner: Uint8Array;
  /** surface holes: 0 none, else HOLE code */
  readonly holes: Uint8Array;
  /** who opened each surface hole (SideId, NEUTRAL for a neutral source): a fall into it, now or later, credits them when hostile */
  readonly holeBy: Uint8Array;
  holeCount = 0;
  /** Bumps when terrain holes or any army's remembered surface footprints change; invalidates hull topology and routes. */
  holesVersion = 0;
  /** bumps whenever a depths cell, gate or body changes (smoothed depths waypoints are re-sighted) */
  depthsVersion = 0;
  /** `depthsVersion` when this tick's units began deciding */
  depthsStamp = 0;
  /** surface terrain preset and static terrain (SURFACE codes), fault lines (ordered cells) */
  readonly preset: TerrainPreset;
  readonly terrain: Uint8Array;
  readonly faults: number[][];
  /** Public map-authored spawn rectangles and approach vectors; they do not add collision or forces. */
  readonly orbitRegions: World['orbitRegions'];
  readonly orbitRegionWeights: Float64Array;
  readonly orbitRegionWeight: number;
  /** Per region: min/max x, min/max y, clipped once to this match's asteroid boundary. */
  readonly orbitSpawnBounds: Float64Array;
  /** per cell: index of its fault (-1 none) and its position along that fault */
  readonly faultOf: Int8Array;
  readonly faultAt: Int16Array;
  /** per-plane scratch for updateProduction: Spire segment already producing a unit this tick */
  readonly segBusy = new Uint8Array(PLANES.length);
  /** per-plane scratch for allocateQueue: each lane's selected head and the backing its other entries released */
  readonly laneHead: (QueueEntry | undefined)[] = PLANES.map(() => undefined);
  readonly laneAlloy = new Float64Array(PLANES.length);
  readonly laneEnergy = new Float64Array(PLANES.length);
  /** packed terrain for observations and views (static) */
  readonly terrainWords: number[];
  /** surface cells nobody can walk: cliffs and holes */
  readonly block: Uint8Array;
  /** Team planners only see known bodies; physical collision uses the authoritative occupancy. */
  readonly surfaceBodies: Uint8Array;
  readonly depthBodies: Uint8Array;
  /**
   * Hostile-army masks for Depths blocking deploy stances; friendly units pass as through bulkheads.
   * Stamped from start-of-tick phases before anyone decides; the upper byte is stampDeploys' scratch mask.
   */
  readonly wallCells: Uint16Array;
  /** Fully deployed units with a cover aura this tick (rules/deploy.ts); reused, never reallocated per tick. */
  readonly covers: Ent[] = [];
  /** Blocking stances stamped last tick (stampDeploys sweeps the grid only while some blocker stands or stood) */
  wallCount = 0;
  readonly surfaceNav: Uint8Array[];
  readonly depthNav: Uint8Array[];
  readonly footprintScratch: Uint8Array;
  footprintsDirty = true;
  footprintsVersion = -1;
  /** surface entry cost multiplier per cell (slow terrain costs more) */
  readonly surfaceCost: Float32Array;
  /** surface line of sight (cliffs block it) */
  readonly los: LineOfSight;
  /** hidden magma pockets: pocket id per cell (0 none; cleared once the pocket breaks) */
  readonly magma: Uint8Array;
  floods: Flood[] = [];
  ents: Ent[] = [];
  /** forward posts (maps/posts.ts matchPosts order: home posts in army order, then contested points; never removed), also in `ents` */
  readonly posts: Ent[] = [];
  /** each post's home army (`posts` order), -1 for a contested point; static per match */
  readonly postHome: number[] = [];
  /** healAtPosts scratch: each post's per-unit heal this tick (HP), sized once at spawn */
  postHealShare = new Float64Array(0);
  readonly byId = new Map<number, Ent>();
  nextId = 1;
  /** Construction is over (openAliases): `add` names each new entity for its owner. */
  aliasesOpen = false;
  /** next creation serial per owner index (NEUTRAL last) */
  readonly seqs = new Int32Array(MAX_ARMIES + 1);
  readonly armies: ArmyState[];
  /** vision groups (alliances; singletons until alliances ship) and each army's group */
  readonly groups: VisionGroup[];
  /** Current visibility per plane (index PLANE_INDEX), surface tremor presence and forest spotting: one bit per group. */
  readonly vis: Uint8Array[];
  readonly feel: Uint8Array;
  readonly spot: Uint8Array;
  charges: Charge[] = [];
  flares: Flare[] = [];
  /** render effects of the last FX_WINDOW ticks, oldest first */
  fx: FxRec[] = [];
  projectiles: Projectile[] = [];
  lances: Lance[] = [];
  oreCaches: OreCache[] = [];
  scorches: Scorch[] = [];
  /** paid work in progress per army and cell (key: army × n + cell): ticks done; alloy is paid once per job */
  railWork = new Map<number, number>();
  /** Rails become walkable only after every unit has used the start-of-tick terrain. */
  laidRails: Int32Array;
  laidRailCount = 0;
  readonly bridgeWork = new Map<number, number>();
  /** dig damage per depths cell (ticks of digging done; the cell opens at digNeed) and reinforces per fortified cell */
  readonly work: Float64Array;
  readonly tough: Uint8Array;
  /** army bits of whoever put the current dig damage into each cell; presentation only (wall-dig alerts) */
  readonly digBy: Uint8Array;
  /** diggers that dug this tick (their cell in `digAt`): full-damage cells open once every unit has decided */
  digging: Ent[] = [];
  /** bulkheads: army bits a depths cell blocks (every army hostile to the owner) and the bulkhead's entity id */
  readonly gate: Uint8Array;
  readonly bulkheadAt: Int32Array;
  /** lava bridges: the bridge entity id on each bridged lake cell (0 none) */
  readonly bridgeAt: Int32Array;
  /** lodes, and per cell the lode whose outcrop/pocket (3×3) it belongs to (-1 none) */
  readonly lodes: LodeState[];
  readonly generation: World['generation'];
  readonly lodeAt: Int8Array;
  /**
   * Mother Lode cells (CELL.lode, in rotation-orbit order); per cell rules.depths.motherLodeCrewPerCell crew slots
   * (cell index × crew + slot: the digger mining there, entity id, 0 free) and its load reserve (loads left; only
   * read when motherLodeLoads > 0, refilled at motherLodeRegen per second); and this tick's claimants (a digger and
   * the index of the cell it mines from beside): slots and loads change only after every unit has decided
   * (resolveMotherLode), so who mines never depends on update order.
   */
  readonly motherCells: number[] = [];
  motherHolders = new Int32Array(0);
  motherReserve = new Float64Array(0);
  readonly motherClaims: Ent[] = [];
  readonly motherClaimCell: number[] = [];
  /**
   * Mother Lode pressure (rules.depths.lodePressure*): the shared value (0–LODE_PRESSURE_MAX), the tick it vents once
   * committed at lodeCritical (0: no fuse burning), the tick its post-vent cooling ends (unminable before it), and the
   * loads mined each of the last lodeVentWindowTicks ticks (a ring indexed tick % window) with their sum: the vent
   * size and the public rate read it.
   */
  lodePressure = 0;
  lodeVentAt = 0;
  lodeCoolUntil = 0;
  lodeWindow = new Uint16Array(0);
  lodeRecent = 0;
  /** Known pocket cells: planners never consult hidden lode positions. */
  readonly knownKeep: Uint8Array[];
  /** each army's depths obstacles for its planners (hostile bulkheads, lode pockets) */
  readonly bars: Barrier[];
  /** instant hits of the current combat phase, applied together */
  hits: { t: Ent; dmg: number; by: Army; source: string; sourcePlane: Plane }[] = [];
  /** this combat phase's shooters: their cloaks break once everyone has picked targets */
  readonly shooters: Ent[] = [];
  /**
   * This combat phase's shot rows, one per target shot (`Ent.pendingRow`; SimCombat.reserve): the target, its `pending`
   * before the first shot, the army bits that shot it, and per army (row × MAX_ARMIES + army) the in-flight damage
   * that army may count (`inFlight`) and its projectile reservations.
   */
  readonly shotTargets: Ent[] = [];
  shotBase = new Float64Array(SCRATCH_ENTS);
  shotBy = new Uint8Array(SCRATCH_ENTS);
  shotView = new Float64Array(SCRATCH_ENTS * MAX_ARMIES);
  shotFlight = new Float64Array(SCRATCH_ENTS * MAX_ARMIES);
  /** A lethal hit schedules tow detonations after simultaneous fire, before any victim cleanup. */
  volatileDestroyed = false;
  result: SimResult | null = null;
  // spatial index
  bucketHead: Int32Array;
  bucketNext = new Int32Array(SCRATCH_ENTS);
  /**
   * Per army: every entity that may be a Sky sight source (an army's Sky non-body at the start of the tick, plus later
   * Sky arrivals). A superset in no particular order; skyVisible re-checks each, so results match a full scan.
   */
  readonly skySources: Ent[][];
  readonly skySourceCount: Int32Array;
  /** per tick: (army, depths cell) → 1 + largest tunnel flood already started there */
  stamped: Uint8Array;
  readonly orbitDark: Uint8Array;
  /** Exhausted ore cells open after all units decide from the same terrain; encoded army × n + cell. */
  minedOut: Int32Array;
  minedOutCount = 0;
  /** Breakouts (army × n + cell) and backfilled hole cells finished this tick: the surface changes after all units decide. */
  readonly breakouts: number[] = [];
  readonly bridged: number[] = [];
  /** Lava bridges (army × n + cell) finished this tick: they open after all units decide (openLavaBridges). */
  readonly lavaBridged: number[] = [];
  /** True during the simultaneous unit update; portal steps taken then (`arrivals`) land after it. */
  deciding = false;
  readonly arrivals: { e: Ent; transit: PlaneTransit; x: number; y: number }[] = [];
  // separation scratch (per entity index, this tick)
  pushX = new Float64Array(SCRATCH_ENTS);
  pushY = new Float64Array(SCRATCH_ENTS);
  /** Sum of this body's correction shares across active contacts (dimensionless). */
  pushWeight = new Float64Array(SCRATCH_ENTS);
  /** 1 if a contact that never gives way (a structure or a pinned body) pushes this body this tick. */
  pushFixed = new Uint8Array(SCRATCH_ENTS);
  /** 1 if the unit moved during this tick's unit update, with its unit motion direction */
  moved = new Uint8Array(SCRATCH_ENTS);
  /** units that decided movement this tick (`moved` beyond it is stale) */
  movedCount = 0;
  moveX = new Float64Array(SCRATCH_ENTS);
  moveY = new Float64Array(SCRATCH_ENTS);
  /** 1 per entity index: own unit standing idle at the start of this tick (shoving boxed-in friends push through it) */
  rest = new Uint8Array(SCRATCH_ENTS);
  /** Held-back end-of-update position (and depths cell) per unit, applied once every unit has decided; pend = plane index + 1. */
  pend = new Uint8Array(SCRATCH_ENTS);
  nextX = new Float64Array(SCRATCH_ENTS);
  nextY = new Float64Array(SCRATCH_ENTS);
  nextCell = new Int32Array(SCRATCH_ENTS);
  nextVx = new Float64Array(SCRATCH_ENTS);
  nextVy = new Float64Array(SCRATCH_ENTS);
  /** did the unit being updated drive this tick (else it brakes)? */
  steered = false;
  /** Deorbits commanded during the current decision round (queueDeorbit), and whether one is open. */
  readonly deorbits: { tug: Ent; x: number; y: number }[] = [];
  inRound = false;
  /** A flare or scan of the open decision round asked for fresh vision (refreshVision): computed once it closes. */
  roundVision = false;
  /**
   * Auto-intercept scratch (indexFalling, once per tick before units decide): interceptable rocks falling now and,
   * index-aligned, the army bits whose Surface structures each one's public blast radius reaches.
   */
  readonly falling: Ent[] = [];
  readonly fallingHits: number[] = [];
  /** ORCA scratch: the nearest bodies of the unit being driven, and their distances */
  nearBy: Ent[] = [];
  nearD = new Float64Array(ORCA_MAX_NEIGHBOURS);
  /** surface flow fields per goal and army */
  readonly flows: FlowFields[];
  /** this match's rules (frozen, durations in seconds) and the tables the sim runs on (ticks) */
  readonly rules: Rules;
  readonly rulesHash: number;
  readonly weather: SkyWeather;
  readonly econ: Econ;
  readonly stats: Record<StatKind, Stats>;
  readonly upgrades: Record<UpgradeId, UpgradeCost>;
  readonly payloads: ResolvedPayloads;
  readonly rocks: Readonly<Record<RockSize, ResolvedRock>>;
  readonly researchBusy = new Uint8Array(PLANES.length);
  /** Derived only when passive research completes; the base-game hot path never walks the upgrade registry. */
  modifierRows: (ModifierRows | undefined)[] | null = null;
  readonly baseStatRows: ModifierRows;
  /** Only active timed transits need work; instantaneous portals never enter the timer set. */
  readonly transits = new Set<Ent>();
  readonly spireHp: Record<Plane, number>;
  /** match length cap (ticks): at the cap more total Spire HP wins, equal → draw */
  readonly timeCap: number;
  /** lit sun wedges (one per slot: every corner starts in daylight) and their speed (rad/s) */
  readonly sunWedges: number;
  readonly sunSpeed: number;
  /** depths entry costs for walkers and diggers */
  readonly costs: DepthsCosts;
  /** ticks between two cells of a magma flood (magmaCells over magmaSpreadTicks) */
  readonly magmaStep: number;
  readonly shaftDiggerStats: UpgradeCost;
  /** a segment rebuild's cost and build time (rules.spire.rebuild*); its plane is each entry's own */
  readonly rebuildStats: UpgradeCost;
  /** The derelict ruin (null: rules.orbit.derelictEnabled off) and its chamber cells (the Orbit vision mask while orbit.derelictBlocksVision is off). */
  readonly derelict: DerelictGeometry | null;
  readonly chamberCells: Uint8Array;
  /** The live core's id (0: none), the tick a new one grows (-1: none pending), and whether it is out past the hull. */
  coreId = 0;
  coreRegrowAt = -1;
  /** Public while the core is out past the hull: the tick, point and towing army of its lift (at −1: in the ruin). */
  readonly coreLift: { at: number; x: number; y: number; side: SideId } = { at: -1, x: 0, y: 0, side: NEUTRAL };

  /**
   * `options`: the match rules (validated `MatchOptions`; omitted fields use the defaults). `armies`: who plays which
   * slot of the map (default: one army per slot, coloured COLOURS in slot order).
   */
  constructor(seed: number, options: MatchOptions = {}, document?: MapDocument, armies?: readonly ArmySpec[]) {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Match seed must be a non-negative safe integer');
    this.seed = seed;
    const rules = resolveRules(options);
    this.mapDocument = document ?? resolveMapDocument(seed, rules.terrain, rules.map, options.map);
    const generated = document === undefined && options.map?.name === undefined && options.map?.document === undefined;
    const { world, starts, cavern } = expandMapDocument(this.mapDocument);
    this.sides = this.mapDocument.sides;
    this.slotStep = 4 / this.sides;
    const specs = armies ?? starts.map((_, slot) => ({ slot, colour: COLOURS[slot]! }));
    if (specs.length < 2 || specs.length > Math.min(MAX_ARMIES, this.sides)) throw new Error(`A match on this map needs 2–${this.sides} armies`);
    if (specs.some((a) => !Number.isInteger(a.slot) || a.slot < 0 || a.slot >= this.sides) || new Set(specs.map((a) => a.slot)).size !== specs.length) {
      throw new Error('Every army needs its own slot of the map');
    }
    // Army index order is slot order, so army indices (hashes, tie-breaks, the contract's army lists) never depend on
    // the order a caller listed them in.
    if (specs.some((a, i) => i > 0 && a.slot < specs[i - 1]!.slot)) throw new Error('Armies must be listed in slot order');
    // Alliances (shared colours) are colour teams, on the roadmap (docs/ROADMAP.md): until then every army is its own
    // alliance.
    if (new Set(specs.map((a) => a.colour)).size !== specs.length) throw new Error('Every army needs its own colour');
    this.armyColour = specs.map((a) => a.colour);
    this.allArmies = specs.map((_, a) => a);
    this.armyIds = specs.map((a) => armyIdOfSlot(a.slot, this.sides));
    specs.forEach((a, i) => {
      this.armySlot[i] = a.slot;
      this.armyFrame[i] = a.slot * this.slotStep;
      for (let j = 0; j < specs.length; j++) if (specs[j]!.colour !== a.colour) this.hostileMask[i]! |= armyBit(j);
    });
    this.spireAt = specs.map((a) => ({ x: starts[a.slot]!.x, y: starts[a.slot]!.y }));
    this.eliminatedAt = new Int32Array(specs.length).fill(-1);
    this.eliminatedBy = new Uint8Array(specs.length).fill(NEUTRAL);
    this.eliminatedHp = new Float64Array(specs.length);
    this.eliminatedCrowns = new Float64Array(specs.length);
    this.eliminatedFallen = new Uint8Array(specs.length);
    this.mapHash = hashMapDocument(generated ? publicMapDocument(this.mapDocument) : this.mapDocument);
    this.rules = rules.map.size === this.mapDocument.size && rules.map.spireInset === this.mapDocument.spireInset && rules.terrain === this.mapDocument.preset
      ? rules
      : Object.freeze({ ...rules, terrain: this.mapDocument.preset, map: Object.freeze({ ...rules.map, size: this.mapDocument.size, spireInset: this.mapDocument.spireInset }) });
    this.size = this.rules.map.size;
    this.n = this.size * this.size;
    this.bucketWidth = this.size / BUCKET;
    this.bucketCount = this.bucketWidth * this.bucketWidth;
    this.visionWords = Math.ceil(this.n / VISION_BITS_PER_WORD);
    // Bearing from each cell of the canonical sector (C2: the top half, C4: the north-west quadrant) to the centre;
    // every other cell takes its rotated twin's darkness, so the dark mask is exactly symmetric (see computeVision).
    const sectorWidth = this.sides === 2 ? this.size : this.size / 2;
    this.orbitCellBearing = new Float64Array(this.n / this.sides);
    for (let i = 0; i < this.orbitCellBearing.length; i++) {
      const c = Math.floor(i / sectorWidth) * this.size + (i % sectorWidth);
      this.orbitCellBearing[i] = dmath.atan2(this.size / 2 - cellCentreY(c, this.size), this.size / 2 - cellCentreX(c, this.size));
    }
    this.holes = new Uint8Array(this.n);
    this.holeBy = new Uint8Array(this.n).fill(NEUTRAL);
    this.faultOf = new Int8Array(this.n).fill(-1);
    this.faultAt = new Int16Array(this.n);
    this.block = new Uint8Array(this.n);
    this.surfaceBodies = new Uint8Array(this.n);
    this.depthBodies = new Uint8Array(this.n);
    this.wallCells = new Uint16Array(this.n);
    this.surfaceNav = this.allArmies.map(() => new Uint8Array(this.n));
    this.depthNav = this.allArmies.map(() => new Uint8Array(this.n));
    this.footprintScratch = new Uint8Array(this.n);
    this.surfaceCost = new Float32Array(this.n);
    // Room for every cell from each army.
    this.laidRails = new Int32Array(this.allArmies.length * this.n);
    this.work = new Float64Array(this.n);
    this.tough = new Uint8Array(this.n);
    this.digBy = new Uint8Array(this.n);
    this.gate = new Uint8Array(this.n);
    this.bulkheadAt = new Int32Array(this.n);
    this.bridgeAt = new Int32Array(this.n);
    this.lodeAt = new Int8Array(this.n).fill(-1);
    this.knownKeep = this.allArmies.map(() => new Uint8Array(this.n));
    this.bucketHead = new Int32Array(PLANES.length * this.bucketCount);
    this.stamped = new Uint8Array(this.n * this.allArmies.length);
    this.orbitDark = new Uint8Array(this.n);
    this.minedOut = new Int32Array(this.n);
    this.rulesHash = hashRules(this.rules);
    this.incomeMultiplier = Float64Array.from(this.armyIds, (id) => this.rules.handicap.income[id]);
    const tables = compileRules(this.rules);
    this.econ = tables.econ;
    this.weather = new SkyWeather(this.econ, streamSeed(seed, 'weather'), this.spireAt, tables.stats.spire.range, this.size, this.sides);
    this.payloads = resolvePayloads(this.econ);
    this.rocks = resolveRocks(this.econ);
    this.stats = tables.stats;
    this.shaftDiggerStats = { ...this.stats.digger, alloy: Math.ceil(this.stats.digger.alloy * this.econ.shaftDiggerMultiplier), energy: Math.ceil(this.stats.digger.energy * this.econ.shaftDiggerMultiplier) };
    this.rebuildStats = { alloy: this.econ.rebuildAlloy, energy: this.econ.rebuildEnergy, build: this.econ.rebuildTicks, plane: 'surface' };
    this.upgrades = Object.fromEntries(UPGRADE_IDS.map((id) => [id, resolveUpgrade(this.rules, id)])) as Record<UpgradeId, UpgradeCost>;
    this.spireHp = tables.spireHp;
    const base = {} as Record<StatKind, EffectiveStats>;
    for (const kind of Object.keys(this.stats) as StatKind[]) {
      const row = this.stats[kind];
      base[kind] = { hp: row.hp, speed: row.speed, dmg: row.dmg, range: row.range, cooldown: row.cooldown, vision: row.vision, damage_taken: 1 };
    }
    this.baseStatRows = {} as ModifierRows;
    for (const plane of PLANES) this.baseStatRows[plane] = { ...base, spire: { ...base.spire, hp: this.spireHp[plane] } };
    this.timeCap = tables.timeCap;
    this.sunWedges = this.sides;
    this.sunSpeed = sunSpeedOf(this.econ.sunPeriodTicks, this.sunWedges);
    this.costs = depthsCosts(this.econ);
    this.derelict = this.econ.derelictEnabled ? derelictGeometry(this.econ, tables.stats, tables.spires, this.size) : null;
    this.chamberCells = new Uint8Array(this.n);
    if (this.derelict) {
      const g = this.derelict;
      for (let c = 0; c < this.n; c++) {
        const dx = cellCentreX(c, this.size) - g.x;
        const dy = cellCentreY(c, this.size) - g.y;
        if (dx * dx + dy * dy < g.ringInner * g.ringInner) this.chamberCells[c] = 1;
      }
    }
    this.magmaStep = Math.max(1, Math.round(this.econ.magmaSpreadTicks / this.econ.magmaCells));
    this.preset = this.rules.terrain;
    this.rng = new Rng(streamSeed(seed, 'asteroids'));
    this.rockRng = new Rng(streamSeed(seed, 'rocks'));
    this.cells = world.cells;
    this.ore = world.ore;
    // The document numbers tunnel owners by slot (slot + 1); the sim by army (army + 1). Unclaimed slots are neutral ground.
    this.owner = world.owner;
    const armyOfSlot = new Int8Array(this.sides).fill(-1);
    for (const a of this.allArmies) armyOfSlot[this.armySlot[a]!] = a;
    for (let c = 0; c < this.n; c++) if (this.owner[c]) this.owner[c] = armyOfSlot[this.owner[c]! - 1]! + 1;
    this.magma = world.magma;
    this.terrain = world.terrain;
    this.faults = world.faults;
    this.orbitRegions = world.orbitRegions;
    this.orbitRegionWeights = new Float64Array(this.orbitRegions.length);
    this.orbitSpawnBounds = new Float64Array(this.orbitRegions.length * REGION_BOUNDS);
    let regionWeight = 0;
    const edge = this.econ.asteroidEdge;
    const farEdge = this.size - edge;
    for (let i = 0; i < this.orbitRegions.length; i++) {
      const region = this.orbitRegions[i]!;
      this.orbitRegionWeights[i] = regionWeight += region.weight;
      const at = i * REGION_BOUNDS;
      this.orbitSpawnBounds[at] = Math.max(edge, Math.min(farEdge, region.x - region.width / 2));
      this.orbitSpawnBounds[at + 1] = Math.max(edge, Math.min(farEdge, region.x + region.width / 2));
      this.orbitSpawnBounds[at + 2] = Math.max(edge, Math.min(farEdge, region.y - region.height / 2));
      this.orbitSpawnBounds[at + 3] = Math.max(edge, Math.min(farEdge, region.y + region.height / 2));
    }
    this.orbitRegionWeight = regionWeight;
    this.faults.forEach((f, i) =>
      f.forEach((c, k) => {
        this.faultOf[c] = i;
        this.faultAt[c] = k;
      }),
    );
    this.generation = world.generation;
    this.lodes = world.lodes.map((l) => ({ c: l.c, rich: l.rich, loads: l.loads, left: l.loads, open: false, known: 0, seenOpen: 0 }));
    this.lodes.forEach((l, i) => {
      for (const n of this.lodeCells(l.c, LODE_POCKET)) {
        this.lodeAt[n] = i;
      }
    });
    this.terrainWords = packTerrain(this.terrain);
    const cliffs = new Uint8Array(this.n);
    for (let c = 0; c < this.n; c++) {
      const v = this.terrain[c]!;
      cliffs[c] = v === SURFACE.cliff ? 1 : 0;
      this.block[c] = isSurfaceBlocked(v) ? 1 : 0;
      this.surfaceCost[c] = surfaceFeature(v) === SURFACE.forest ? 1 / this.econ.forestSpeed : surfaceFeature(v) === SURFACE.ford ? 1 / this.econ.fordSpeed : 1;
    }
    this.los = new LineOfSight(cliffs, this.size);
    this.flows = this.allArmies.map((a) => new FlowFields(this.surfaceNav[a]!, this.surfaceCost, FLOW_FIELD_CAP, this.size));
    this.vis = PLANES.map(() => new Uint8Array(this.n));
    this.feel = new Uint8Array(this.n);
    this.spot = new Uint8Array(this.n);
    this.groups = this.allArmies.map((a) => this.makeGroup(a, [a]));
    this.armies = this.allArmies.map((a) => this.makeArmy(a, this.groups[a]!));
    this.skySources = this.allArmies.map(() => []);
    this.skySourceCount = new Int32Array(this.allArmies.length);
    // Planners route around the hostile bulkheads their group knows of; one met unseen blocks the unit, which re-plans.
    this.bars = this.armies.map((t) => ({ gate: t.group.gateKnown, mask: t.bit, keep: this.knownKeep[t.army]!, solid: this.depthNav[t.army]! }));
    for (let c = 0; c < this.n; c++) {
      if (!cavern[c]) continue;
      for (const t of this.armies) if (cavern[c]! & (1 << this.armySlot[t.army]!)) t.group.known[c] = this.cells[c]!;
    }
    this.readMotherLode();
    this.readRichOre();
    // Spawn order fixes entity ids. Every army names the islands and posts first (openAliases), so a home preview
    // names them without a sim.
    world.islands.forEach((o) => this.spawnIsland(o));
    if (this.derelict && this.econ.coreEnabled) this.spawnCore();
    for (const a of this.allArmies) this.setupArmy(a);
    this.spawnPosts(world.posts, starts[0]!);
    this.refreshDrops();
    this.openAliases();
    this.computeVision();
  }

  /**
   * Independent in-memory checkpoint, without regenerating terrain or replaying ticks.
   * Clone the graph once: entity indexes/Spire references and flow-field terrain buffers must keep
   * their aliases, while maps, typed arrays (including Infinity), caches and RNG state are isolated.
   * These are the only stateful class prototypes in the graph; keep this list in sync with new ones.
   * Navigation/ORCA module scratch is reset per synchronous operation, not match state.
   */
  clone(): Sim {
    const copy = structuredClone(this);
    Object.setPrototypeOf(copy, Sim.prototype);
    Object.setPrototypeOf(copy.rng, Rng.prototype);
    Object.setPrototypeOf(copy.rockRng, Rng.prototype);
    for (const flows of copy.flows) Object.setPrototypeOf(flows, FlowFields.prototype);
    Object.setPrototypeOf(copy.los, LineOfSight.prototype);
    Object.setPrototypeOf(copy.weather, SkyWeather.prototype);
    for (const rng of copy.weather.random) Object.setPrototypeOf(rng, Rng.prototype);
    for (const e of copy.ents) Object.setPrototypeOf(e, Ent.prototype);
    for (const e of copy.byId.values()) Object.setPrototypeOf(e, Ent.prototype);
    // Dead entities can survive only in Spire or scratch references after cleanup removes them.
    for (const t of copy.armies) for (const plane of PLANES) Object.setPrototypeOf(t.spire[plane], Ent.prototype);
    for (const hit of copy.hits) Object.setPrototypeOf(hit.t, Ent.prototype);
    for (const e of copy.shotTargets) Object.setPrototypeOf(e, Ent.prototype);
    for (const e of copy.nearBy) Object.setPrototypeOf(e, Ent.prototype);
    for (const e of copy.digging) Object.setPrototypeOf(e, Ent.prototype);
    for (const sources of copy.skySources) for (const e of sources) Object.setPrototypeOf(e, Ent.prototype);
    return copy;
  }

  makeGroup(id: number, armies: Army[]): VisionGroup {
    return {
      id,
      bit: 1 << id,
      armies,
      known: new Uint8Array(this.n),
      knownAt: new Int32Array(this.n),
      pocketKnown: new Uint8Array(this.n),
      cracks: new Uint8Array(this.n),
      wallDig: new Uint8Array(this.n),
      gateKnown: new Uint8Array(this.n),
      memory: new Map(),
      sapperSeen: new Map(),
      seenResearch: this.allArmies.map(() => new Set()),
    };
  }

  makeArmy(army: Army, group: VisionGroup): ArmyState {
    const seat = (): SeatState => ({ controller: 'none', mandate: { autonomy: 'autonomous', directive: { stance: 'economy' }, whenAbsent: 'policy' } });
    return {
      army,
      bit: armyBit(army),
      group,
      alloy: this.econ.startAlloy,
      energy: this.econ.startEnergy,
      accounting: new Float64Array(ACCOUNT_SLOTS),
      income: new Float64Array(INCOME_WINDOW_S * TICK_RATE),
      tickIncome: 0,
      surfaceIncome: new Float64Array(INCOME_WINDOW_S * TICK_RATE),
      tickSurfaceIncome: 0,
      geothermal: 0,
      solar: 0,
      cap: this.econ.baseEnergyCap,
      delivered: 0,
      energyBank: 0,
      bankDischarge: 0,
      upkeep: 0,
      stormcatcher: 0,
      skyUpkeep: 0,
      powered: true,
      pop: 0,
      structures: 0,
      designations: new Uint8Array(this.n),
      designationWords: { normal: new Array<number>(this.visionWords).fill(0), urgent: new Array<number>(this.visionWords).fill(0) },
      designationCount: 0,
      designationDirty: true,
      designationRevision: 0,
      designationKnown: new Uint8Array(this.n),
      designationGate: new Uint8Array(this.n),
      designationReserved: new Uint8Array(this.n),
      designationDistance: new Float64Array(this.n),
      designationOwner: new Int32Array(this.n).fill(-1),
      designationNext: new Int32Array(this.n).fill(-1),
      designationVia: new Int32Array(this.n).fill(-1),
      drop: new Uint8Array(this.n),
      oreField: new Float64Array(this.n),
      oreFieldTick: -1,
      oreGoal: new Uint8Array(this.n),
      queue: [],
      queueSeq: 0,
      aliases: aliasTable(),
      research: new Set(),
      spire: {} as Record<Plane, Ent>,
      stats: {
        alloyMined: 0,
        energyDelivered: 0,
        produced: 0,
        unitsLost: 0,
        kills: 0,
        structuresLost: 0,
        collapses: 0,
        impacts: 0,
        interceptions: 0,
        islandTicks: 0,
        spireDamageDealt: 0,
        lodeAlloy: 0,
        fortified: 0,
        bulkheads: 0,
        headframes: 0,
        deploys: 0,
        flares: 0,
        conversions: 0,
        postsCaptured: 0,
        coreCashed: 0,
        postTicks: 0,
        pointTicks: 0,
        moorings: 0,
        seeds: 0,
        emplaced: 0,
      },
      events: [],
      timeline: [],
      seats: { depths: seat(), surface: seat(), sky: seat(), orbit: seat() },
      spireEventAt: { depths: LONG_AGO, surface: LONG_AGO, sky: LONG_AGO, orbit: LONG_AGO },
      spireHitAt: { depths: LONG_AGO, surface: LONG_AGO, sky: LONG_AGO, orbit: LONG_AGO },
      spireFellAt: { depths: -1, surface: -1, sky: -1, orbit: -1 },
      rebuilds: 0,
      radiationEventAt: LONG_AGO,
      spawnI: 0,
      scanReadyAt: 0,
      scans: [],
      intruderAt: -1,
      rally: {} as Record<Plane, { x: number; y: number }>,
    };
  }

  setupArmy(army: Army): void {
    const t = this.armies[army]!;
    const p = this.spireAt[army]!;
    const frame = this.armyFrame[army]!;
    // Odd-sized footprints stand at cell centres; each segment covers the same rotated cells.
    const home = cellOf(canonX(frame, p.x, p.y, this.size), canonY(frame, p.x, p.y, this.size), this.size);
    for (const plane of PLANES) {
      const seg = this.add('spire', army, plane, p.x, p.y);
      seg.hp = seg.maxHp = this.stat(seg).hp;
      seg.state = 'active';
      seg.cell = rotCell(frame, home, this.size);
      t.spire[plane] = seg;
    }
    for (const plane of PLANES) t.rally[plane] = this.defaultRally(army, plane);
    // Every plane starts with something to do, so the match is lively from the first minute.
    for (const [kind, rule] of START_UNITS) for (let i = 0; i < this.econ[rule]; i++) this.spawnUnit(army, kind, this.stats[kind].plane);
  }

  spawnIsland(o: IslandOrbit): void {
    const e = this.add('island', NEUTRAL, 'sky', 0, 0);
    e.orbitR = o.r;
    e.orbitA0 = o.a0;
    e.orbitW = o.w;
    e.oreCapacity = e.oreRemaining = o.oreCapacity;
    e.hp = e.maxHp = HOLD_ZONE_HP;
    e.state = 'drifting';
    this.placeIsland(e);
  }

  add(kind: Kind, side: SideId, plane: Plane, x: number, y: number): Ent {
    const e = new Ent();
    e.id = this.nextId++;
    e.seq = this.seqs[side]!++;
    e.kind = kind;
    this.setSide(e, side);
    e.plane = plane;
    e.x = clampPos(x, this.size);
    e.y = clampPos(y, this.size);
    e.unit = isUnitKind(kind);
    e.structure = isStructureKind(kind);
    if (!isNeutralKind(kind)) {
      e.statPlane = plane;
      e.statRow = (isArmy(side) ? this.modifierRows?.[side] : undefined)?.[plane][kind] ?? this.baseStatRows[plane][kind];
      e.capabilities = this.stats[kind].capabilities;
      e.mount = this.stats[kind].mount;
      e.replacementAlloy = this.stats[kind].alloy;
      e.replacementEnergy = this.stats[kind].energy;
      e.hp = e.maxHp = this.stat(e).hp;
      if (plane === 'orbit') e.shield = e.maxShield = this.stats[kind].shield ?? 0;
      e.radius = this.stats[kind].radius;
      const f = this.stats[kind].footprint;
      if (f && !isIslandStructure(kind) && !isHardpointKind(kind)) {
        // The API stores centres; the authoritative anchor is an integer minimum corner, floored in the owner's frame
        // (footprints are square, so a quarter turn keeps their shape).
        const k = e.frame;
        const cx = canonX(k, x, y, this.size);
        const cy = canonY(k, x, y, this.size);
        const ax = Math.max(0, Math.min(this.size - f.w, Math.floor(cx - f.w / 2))) + f.w / 2;
        const ay = Math.max(0, Math.min(this.size - f.h, Math.floor(cy - f.h / 2))) + f.h / 2;
        e.x = rotX(k, ax, ay, this.size);
        e.y = rotY(k, ax, ay, this.size);
      }
    } else e.radius = kind === 'island' ? this.econ.islandRadius : kind === 'asteroid' ? this.econ.asteroidRadius : 0;
    if (kind === 'asteroid') {
      e.hp = e.maxHp = this.rocks.medium.hp;
      e.resourceRemaining = this.rocks.medium.dock;
    }
    this.ents.push(e);
    if (plane === 'sky') this.enterSky(e);
    this.byId.set(e.id, e);
    // Its owner knows it at once (an intent's new site or airdrop shows in the same tick's observation).
    if (this.aliasesOpen && isArmy(side)) this.giveAlias(side, e.id);
    if (e.structure && plane === 'surface') this.stampFootprint(this.surfaceBodies, kind, e.x, e.y);
    if (e.structure && plane === 'depths' && !isCellStructure(kind)) this.stampFootprint(this.depthBodies, kind, e.x, e.y);
    if (e.structure) this.footprintsDirty = true;
    return e;
  }

  /** Owner of `e`, and the frame its cells and tie-breaks resolve in. */
  setSide(e: Ent, side: SideId): void {
    e.side = side;
    e.frame = this.armyFrame[side]!;
  }

  /** Are owners `a` and `b` armies of different alliances? Neutral is hostile to nobody. */
  hostile(a: SideId, b: SideId): boolean {
    return ((this.hostileMask[a]! >> b) & 1) === 1;
  }

  /** Relative order of army `b` seen from army `a` (0 = `a` itself): ties between armies break by it (DESIGN §15.1). */
  rel(a: Army, b: Army): number {
    return (this.armySlot[b]! - this.armySlot[a]! + this.sides) % this.sides;
  }

  /** Is `army` still in play (not eliminated)? */
  inPlay(army: Army): boolean {
    return this.eliminatedAt[army] === -1;
  }

  /** The army a contract id names (−1: not in this match). */
  armyIndex(id: ArmyId): Army {
    return this.armyIds.indexOf(id);
  }

  /** The contract side of an owner index. */
  sideId(s: SideId): Side {
    return s === NEUTRAL ? 'neutral' : this.armyIds[s]!;
  }

  /** `army` concedes: it is eliminated at the end of the next tick (no-op once it is out or the match is over). */
  forfeit(army: Army): void {
    if (!this.result && this.inPlay(army)) this.forfeits |= armyBit(army);
  }

  /**
   * Final placement of `army` once its outcome is final (match over, or eliminated with no ally in play), else null.
   * An army eliminated mid-match ranks below every alliance still in play and, among alliances out on the same tick,
   * below those that lost fewer crowns, then kept more total Spire HP (equal keys share a rank): exactly the rank
   * checkOutcome gives at the end.
   */
  placeOf(army: Army): number | null {
    if (this.result) return this.result.rank[army]!;
    const bits = this.allianceBits(army);
    for (const b of this.allArmies) if (bits & armyBit(b) && this.inPlay(b)) return null;
    let above = 0;
    for (const b of this.allArmies) {
      if (bits & armyBit(b) || this.lowestArmy(b) !== armyBit(b)) continue;
      if (this.finishKey(b, 0, 0, 0) === -1 || this.finishAbove(b, army, 0, 0)) above++;
    }
    return 1 + above;
  }

  /** Bearing of one lit wedge (the others follow at 2π / sunWedges), see contract `SUN`. */
  get sunAngle(): number {
    return sunAngleAt(this.tick, this.sunSpeed);
  }

  /** Is (x, y) in daylight now? */
  lit(x: number, y: number): boolean {
    return sunLit(x, y, this.sunAngle, this.size, this.sunWedges);
  }

  get over(): boolean {
    return this.result !== null;
  }

  alive(id: number): Ent | undefined {
    const e = this.byId.get(id);
    return e && !e.dead ? e : undefined;
  }

  isStructure(e: Ent): boolean {
    return e.structure;
  }

  segmentAlive(army: Army, plane: Plane): boolean {
    return this.armies[army]!.spire[plane].hp > 0;
  }

  /**
   * Crowns a fallen `plane` segment costs (rules.spire.lossRule, DESIGN §2). Under `surface` only the Surface counts,
   * as one crown of one: the same predicate then reproduces "out when the Surface falls".
   */
  crownValue(plane: Plane): number {
    if (this.rules.spire.lossRule === 'crowns') return plane === 'surface' ? this.econ.crownsSurface : this.econ.crownsSide;
    return plane === 'surface' ? 1 : 0;
  }

  /** Crowns lost that eliminate an army. */
  get crownsToLose(): number {
    return this.rules.spire.lossRule === 'crowns' ? this.econ.crownsToLose : 1;
  }

  /** Crowns `army` has lost: its fallen segments (a rebuilt segment returns its crown). */
  crownsLost(army: Army): number {
    let lost = 0;
    for (const plane of PLANES) if (!this.segmentAlive(army, plane)) lost += this.crownValue(plane);
    return lost;
  }

  /** Record an event for each army in `armies`; `side` (owner index; army 0 is a real owner) when the event names one. */
  emit(armies: readonly Army[], kind: EventKind, plane: Plane, x: number, y: number, subject?: Kind, side?: SideId, extra?: Partial<SimEvent>): void {
    const ev: SimEvent = { tick: this.tick, kind, plane, x: clampPos(x, this.size), y: clampPos(y, this.size) };
    if (subject) ev.subject = subject;
    if (side !== undefined) ev.side = side;
    if (extra) Object.assign(ev, extra);
    for (const army of armies) {
      const t = this.armies[army]!;
      t.events.push(ev);
      if (t.events.length > EVENT_RETAIN * 2) t.events.splice(0, t.events.length - EVENT_RETAIN);
      if (TIMELINE_KINDS[kind]) {
        t.timeline.push(ev);
        if (t.timeline.length > TIMELINE_CAP) t.timeline.shift();
      }
    }
    const listeners = recordingListeners.get(this);
    if (listeners) for (const listener of listeners) listener.event(ev);
  }

  fxAdd(kind: FxKind, plane: Plane, x: number, y: number, owner: SideId, pub: boolean, extra?: Partial<SimFx>): FxRec {
    const fx: SimFx = { tick: this.tick, kind, plane, x: clampPos(x, this.size), y: clampPos(y, this.size), ...extra };
    const rec: FxRec = { fx, pub, owner };
    this.fx.push(rec);
    const listeners = recordingListeners.get(this);
    if (listeners) for (const listener of listeners) listener.effect(rec);
    return rec;
  }
}

mixin(Sim, [SimTick, SimSpawn, SimVision, SimAliases, SimMovement, SimOrders, SimCombat, SimDeploy, SimEconomy, SimProduction, SimResearch, SimDigest, OrbitPlane, DerelictPlane, Payloads, CaptureZones, SkyPlane, SurfacePlane, ForwardPosts, DrillYards, PlaneTransits, DepthsPlane, DepthsNav, Designations]);
