/**
 * What a team sees: the observation, view, observer, match-data and end-of-match report schemas with their
 * vocabularies (fx, events, outcomes, errors, alerts, schedules) and seat mandate schemas.
 */
// Browser-safe subpath: the `playerthree` root also exports the Node host (node:crypto), which this client-shared module must not pull in.
import { CONTROLLERS } from 'playerthree/manifest';
import { type Infer, t } from 'playerthree/schema';
import { TAU } from '../util/math.ts';
import { rulesSchema } from './match-rules.ts';
import { SIGNAL_SCHEMAS } from './signals.ts';
import { army, cellXY, eid, kind, plane, side, xy } from './schema-fields.ts';
import { BUILD_RADIUS_KINDS, BUILD_RADIUS_RULE, type BuildRadiusRules, ORDER_QUEUE, radiusExempt, WEAPONS } from './stats.ts';
import { CRACK_STAGES, HOLE_KINDS, LODE_PRESSURE_MAX, LODE_STATES, TERRAIN_CELLS_PER_WORD, TERRAIN_CODE_BITS, VISION_BITS_PER_WORD } from './terrain.ts';
import { BUILDABLE, COLOURS, HARDPOINT_KIND_LIST, MAX_ARMIES, MAX_CONTESTED_POSTS, MAX_MAP_SIZE, MAX_POST_COUNT, PLANES, POST_KINDS, QUEUE_ITEMS, QUEUE_LIST, QUEUE_REASONS, QUEUE_STATUSES, ROCK_RESOURCE_TYPES, ROCK_SIZES, STATES, STRUCTURE_KINDS, TERRAIN_PRESETS, UNIT_KINDS, UNIT_STANCES, UPGRADE_IDS } from './vocabulary.ts';
import {
  ALERT_COUNT_CAP, CARRY_CAP, CHARGE_CAP, CRACK_CAP, FLARE_CAP, GHOST_CAP, HP_CAP, IMPACT_CAP, OBS_ENTITY_CAP, OBS_EVENT_CAP, ORE_CACHE_CAP, REPORT_TIMELINE_CAP,
  SCHEDULE_CAP, SCORCH_CAP, SUMMARY_COUNT_CAP, SUMMARY_SHAFT_CAP, SUMMARY_TRANSIT_CAP, TREMOR_CAP, VIEW_ENTITY_CAP, VIEW_EVENT_CAP, VIEW_FX_CAP, WAYPOINT_CAP,
} from './observation-core.ts';


/** Visual effects in views (render-only; the last ~10 ticks, fog-filtered per team). */
export const FX_KINDS = [
  'shot',
  'lance',
  'lance_hit',
  'death',
  'volatile_detonation',
  'collapse',
  'impact',
  'dig',
  'deliver',
  'scan',
  'breach',
  'intercept',
  'deorbit',
  'portal',
  'defuse',
  /** public, one per opened fault cell (same tick); tp: 'depths' */
  'chasm',
  /** public: troopers broke through to the surface (a `breach` hole) */
  'breakout',
  /** a depths cell floods with magma (fog-filtered) */
  'magma',
  /** a magma cell cooled to open tunnel (fog-filtered) */
  'cool',
  /** a tunnel cell got a rail (fog-filtered) */
  'rail',
  /** public: a hole cell was backfilled */
  'bridge',
  /** a Warden threw a flare (x, y: where it lands; fog-filtered: seen where the landing cell is seen) */
  'flare',
  /** magma burned the crater-ore share of an ore cache in this depths cell (shown only to groups that saw it happen) */
  'cache_burned',
  /** the Mother Lode erupts at this lode cell (to groups that know a lode cell or saw the blast) */
  'lode_vent',
  /** public: a derelict core cashed in at this Orbit segment */
  'core_cashed',
  /** fog-filtered nonterminal core heat purge; the core remains attached */
  'core_vent',
  /** fog-filtered Orbit mining latch: subject tug, side, tx/ty at the asteroid */
  'mining_start',
  /** fog-filtered resource exhaustion: subject asteroid, side of the miner */
  'mining_depleted',
  /** fog-filtered cargo delivery: subject tug, side of the miner */
  'mining_unload',
] as const;
export type FxKind = (typeof FX_KINDS)[number];

export const EVENT_KINDS = [
  'unit_lost',
  'volatile_detonation',
  'enemy_killed',
  'structure_lost',
  'structure_destroyed',
  'produced',
  'constructed',
  'collapse',
  'fell_into_depths',
  'impact_incoming',
  'impact',
  'asteroid_intercepted',
  'island_captured',
  /** your Gunship emplaced on an island hardpoint as a Gun Platform */
  'emplaced',
  'island_lost',
  'post_captured',
  'post_lost',
  'spire_damaged',
  'enemy_sapper_seen',
  'tunnel_breach',
  /** your team planted a charge (to the planter's team only; side = the planter) */
  'charge_planted',
  /** a hostile charge became known to your team: its cell in your Depths vision, a tremor you feel there, or its public last rules.depths.chargePublicTime (once per charge; side = the planter) */
  'charge_spotted',
  /** to the teams that knew of the charge (side = the planter, killer = the defuser) */
  'charge_defused',
  /** hostile Depths units in or beside your own tunnels near your Depths structures, Shafts, Headframes or Spire (rules.depths.intruderRadius): a new intrusion; x/y = the nearest, `count` = how many (the live state is the `intruder` alert) */
  'intruder',
  /** enemy troopers are digging up toward the surface here (x, y: cell centre) */
  'breach_tremor',
  'breach_opened',
  'chasm_opened',
  /** public: a digger backfilled a hole cell (`bridge`); the surface there is walkable again */
  'hole_bridged',
  'magma_flood',
  /** magma burned the crater-ore share of an ore cache here (only to armies whose group saw the cell then) */
  'cache_burned',
  /** the Mother Lode erupted (x, y: the lode cell nearest your Spire whose blast your Depths vision covered; only to armies that saw it) */
  'lode_erupted',
  /** your Headframe bored through a lode's seal: its ore pocket is open to diggers (yours and the enemy's) */
  'lode_opened',
  /** own units dropped an attack order: no spot left they could fire at the target from (x, y: target; subject: its kind) */
  'target_unreachable',
  /** team build queue changes (own team only): who acted (`by`, `byCtl`), whose entry (`owner`, `ownerCtl`), `entry`, `subject` = item, `index` */
  'queue_added',
  'queue_cancelled',
  'queue_moved',
  /** public, to every army: `side` was eliminated (lost its last crown under rules.spire.lossRule, or forfeited); plane = the segment whose fall decided it (a forfeit: surface); `killer` = the hostile army that last hit that segment, if any; x/y = its Spire centre */
  'army_eliminated',
  /** public: the derelict core left the ruin under tow (`side` = the towing army; x/y where it crossed the hull) */
  'core_lifted',
  /** public: a new derelict core grew in the chamber */
  'core_regrows',
  /** public: `side` towed the derelict core home to its Orbit segment and cashed it in (rules.orbit.coreRewardAlloy/Energy); x/y: the segment */
  'core_cashed',
  /** the core melted down in Orbit (heat 100, or destroyed under tow); only to armies that saw it */
  'core_meltdown',
  /** own: a tug vented the towed core (heat down to vents × rules.orbit.coreVentFloor, pulse) */
  'core_vented',
  /** own: our ships are taking radiation in the derelict chamber (at most every few seconds; x/y: one of them) */
  'irradiated',
  /** public, to every army: sudden death began (rules.spire.suddenDeathAt): Spire segments take ×suddenDeathDamage from all but rock-borne damage, no dock repair; x/y = the map centre */
  'sudden_death',
  /** public, to every army, under rules.spire.lossRule `crowns`: `side`'s segment on `plane` fell and cost its crowns (`killer` = the hostile army that last hit it, if any; x/y = its Spire centre) */
  'crown_lost',
  /** own army: a segment rebuild finished on `plane` (it stands again at rules.spire.rebuildHp of full HP); public to every army under lossRule `crowns` (its crown returns) */
  'segment_rebuilt',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const OUTCOMES = ['running', 'win', 'loss', 'draw'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const STANCES = ['economy', 'defend', 'attack', 'expand', 'support'] as const;
export type Stance = (typeof STANCES)[number];
export const CONTROLLER_ENUM = t.enum(CONTROLLERS);

export const entitySchema = t.obj({
  id: eid,
  kind,
  side,
  plane,
  ...xy,
  hp: t.int(0, HP_CAP),
  maxHp: t.int(1, HP_CAP),
  shield: t.opt(t.num(0, 100000, 'Current Orbit warship shield; absent outside Orbit.')),
  maxShield: t.opt(t.num(0, 100000, 'Orbit warship shield capacity.')),
  state: t.enum(STATES),
  rockSize: t.opt(t.enum(ROCK_SIZES, 'Asteroid size, including its public falling marker.')),
  resourceType: t.opt(t.enum(ROCK_RESOURCE_TYPES, 'Resource type requires local rock vision, never merely its public falling marker.')),
  volatile: t.opt(t.bool('Independent rock instability flag; only with local rock vision.')),
  resourceRemaining: t.opt(t.num(0, 100_000, 'Remaining recoverable alloy or energy; only with local rock vision.')),
  fuseUntil: t.opt(t.int(0, 1e9, 'Volatile tow instability deadline; only with actual vision of the rock.')),
  vents: t.opt(t.int(0, 1000, 'Derelict core: vents so far (each leaves vents × rules.orbit.coreVentFloor heat); only with actual vision of the core.')),
  heat: t.opt(t.num(0, 100, 'Derelict core: heat (meltdown at 100); only with actual vision of the core.')),
  heatRate: t.opt(t.num(-100, 100, 'Derelict core: heat per second now (negative: cooling in the chamber); only with vision of the core.')),
  ramp: t.opt(t.num(0, 1, 'Solar array: exposure ramp progress (0 freshly anchored → 1 full: output share rules.orbit.solarRampStart → 1); with vision of it.')),
  output: t.opt(t.num(0, 1000, 'Own solar array: energy per second it made last tick (light × ramp × distance × shade; 0 while packed).')),
  /** Hull travel bearing and independent turret bearing (radians, atan2(y, x)); no target identity. Absent for a Depths unit working in place. */
  heading: t.opt(t.num(-Math.PI, Math.PI * 3)),
  aim: t.opt(t.num(-Math.PI, Math.PI * 3)),
  /** digger: ore carried; spire/production: queued count */
  carry: t.opt(t.int(0, CARRY_CAP)),
  cargoAlloy: t.opt(t.num(0, 100_000, 'Tug alloy cargo, retained when mining is cancelled.')),
  cargoEnergy: t.opt(t.num(0, 100_000, 'Tug energy cargo; unloading bypasses the delivery cap.')),
  miningTarget: t.opt(t.id('e', 'Own tug mining target, only while the target is locally visible.')),
  miningAssigned: t.opt(t.bool('Own tug retains a mining assignment: explicit target or auto_mine, including fogged cargo trips and idle auto-mine search.')),
  /** tug: towed asteroid; island structure: its island; island: its structure; asteroid: towing tug */
  link: t.opt(eid),
  hangar: t.opt(eid),
  ready: t.opt(t.int(0, 1e9, 'Own structure cooldown or hangar launch deadline.')),
  activeUntil: t.opt(t.int(0, 1e9, 'Active Storm Seeder deadline.')),
  mooringTarget: t.opt(eid),
  mooringTower: t.opt(eid),
  mooringState: t.opt(t.enum(['waiting', 'lowering', 'held', 'raising'])),
  mooringGrace: t.opt(t.int(0, 1e9, 'Own tower: total unpaid grace ticks remaining; paid ticks do not replenish it.')),
  mooringPowered: t.opt(t.bool('Own tower: whether the shared energy grid paid upkeep this tick.')),
  mooringReadyAt: t.opt(t.int(0, 1e9, 'Island reacquisition lockout after rejoining its circular route.')),
  elevation: t.opt(t.num(-8, 0, 'Sky deck/aircraft vertical offset in tiles; plane, weather, fog and weapon ranges do not change.')),
  oreCapacity: t.opt(t.num(0, 100000, 'Island: immutable initial finite deposit; public ore-bearing identity, not current reserves.')),
  oreRemaining: t.opt(t.num(0, 100000, 'Island deposit remaining, only while owned or currently seen in Sky. Absent means unknown.')),
  oreBuffer: t.opt(t.num(0, 10000, 'Own island only: extracted cargo awaiting Drop Ore, preserved through attachment loss and island capture.')),
  extractorPowered: t.opt(t.bool('Own Ore Extractor only: whether its shared grid paid upkeep this tick.')),
  /** current move/attack destination */
  tx: t.opt(t.num(0, MAX_MAP_SIZE)),
  ty: t.opt(t.num(0, MAX_MAP_SIZE)),
  /** Own units only: the current work/engagement point, distinct from the final order destination. */
  work: t.opt(t.obj({ ...xy })),
  /** construction / undermine / capture progress 0..1 */
  progress: t.opt(t.num(0, 1)),
  /** Own units only; absent stance means aggressive. */
  stance: t.opt(t.enum(UNIT_STANCES, 'Own unit stance; defaults to aggressive when omitted.')),
  queue: t.opt(t.int(0, ORDER_QUEUE)),
  /** own units: destinations of the queued orders after the current one (patrol: both legs) */
  wp: t.opt(t.list(t.obj({ ...xy }), WAYPOINT_CAP)),
  transit: t.opt(t.obj({
    to: t.enum(PLANES),
    at: t.int(0, 1e9, 'Arrival tick; 0 after arrival.'),
    until: t.int(0, 1e9, 'Return tick; 0 for a permanent move.'),
    return: t.opt(t.enum(PLANES, 'Return plane; omitted while it equals the current plane. until=0 means permanent.')),
  })),
  transitReady: t.opt(t.int(0, 1e9, 'Own entity transit cooldown tick; omitted when ready.')),
  abilityReady: t.opt(t.int(0, 1e9, 'Own ability cooldown tick (Orbit abilities, Warden flare); omitted when ready.')),
  deployBlocked: t.opt(t.bool('Own mobile or packing Warden only: true while friendly shield bearers overlap it. Authoritative contact readiness; do not infer it from rounded positions.')),
  lance: t.opt(t.obj({ ...xy, at: t.int(0, 1e9, 'Charge completion tick; visible only with vision of the Lancer.') })),
  aegis: t.opt(t.obj({ until: t.int(0, 1e9), pool: t.num(0, 1e6, 'Remaining shared shield pool.') })),
  cloaked: t.opt(t.bool('Own or detected cloaked Skiff. Undetected enemies are absent, not redacted.')),
  cloakReady: t.opt(t.int(0, 1e9, 'Own Skiff re-cloak deadline after a break.')),
  sealed: t.opt(t.bool('Own built Shaft whose Depths landing is bedrock or has no open tunnel beside it: no transfer there (shaft_sealed) until you dig to it.')),
});
export type Entity = Infer<typeof entitySchema>;

const queueId = t.id('q', 'team build queue entry id');
const queueIndex = t.int(0, QUEUE_LIST - 1);

export const ERRORS = [
  'unknown_unit',
  'not_your_unit',
  'wrong_plane',
  'wrong_kind',
  'cannot_afford',
  'invalid_target',
  'not_adjacent',
  'blocked',
  'no_path',
  'segment_destroyed',
  'queue_full',
  'not_held',
  'occupied',
  'not_visible',
  'game_over',
  /** your army has been eliminated: it has no units left to command */
  'eliminated',
  'cooldown',
  'mandate_limit',
  /** a Headframe must stand on a lode outcrop */
  'no_lode',
  'designation_limit',
  /** a Surface structure's footprint centre must lie inside your build radius (matchData.buildRadius) */
  'out_of_radius',
  /** no Surface structure within matchData.buildRadius.enemySpireNoBuild tiles of a hostile Spire footprint edge */
  'no_build_zone',
  /** `transfer`: troopers change planes only through an own built Shaft (Spire roots, holes and enemy Shafts are no portals) */
  'no_shaft',
  /** `transfer`: the Shaft's Depths landing is bedrock or has no open tunnel beside it (dig to it first) */
  'shaft_sealed',
  /** headless bot runs only (no PlayerThree host): the game's own signal board refused a team signal; hosted matches answer signals with the `signal` ack code */
  'signal_refused',
  /** `queue_add` rebuild: the segment on that plane still stands */
  'segment_standing',
  /** `queue_add` rebuild: your army used its rules.spire.rebuilds this match, or a rebuild is already queued */
  'rebuild_used',
] as const;
export type GameError = (typeof ERRORS)[number];

export const eventSchema = t.obj({
  tick: t.int(0, 1e9),
  kind: t.enum(EVENT_KINDS),
  plane,
  ...xy,
  /** kind of the unit/structure involved, if any (queue events: the entry's item) */
  subject: t.opt(kind),
  side: t.opt(side),
  /** army_eliminated, crown_lost: the hostile army that dealt the killing blow; charge_defused: the army that defused it (`side` = the planter) */
  killer: t.opt(army),
  /** intruder: hostile Depths units seen near home */
  count: t.opt(t.int(1, ALERT_COUNT_CAP)),
  /** queue events: the acting seat and caller category (owner = human, agent/policy = agent, bot/fallback = bot), not the seat controller */
  by: t.opt(plane),
  byCtl: t.opt(CONTROLLER_ENUM),
  /** queue events: the requesting seat and original caller category */
  owner: t.opt(plane),
  ownerCtl: t.opt(CONTROLLER_ENUM),
  entry: t.opt(queueId),
  /** queue events: the entry's position (0 = top) after the change (moved: `from` = before; cancelled: where it was) */
  index: t.opt(queueIndex),
  from: t.opt(queueIndex),
  /** queue_cancelled by the sim rather than a seat: why (`out_of_radius`: the build-radius source covering an unstarted site was lost; `segment_destroyed`: the researching segment fell) */
  code: t.opt(t.enum(ERRORS)),
});
export type GameEvent = Infer<typeof eventSchema>;

const planeIncome = t.obj({
  alloy: t.num(0, 1e6, 'Gross alloy received per second over the last ten seconds.'),
  energy: t.num(0, 1e6, 'Current gross delivered energy per second; Orbit (capped solar plus solar-bank discharge) never exceeds the cap, local generation bypasses it.'),
  upkeep: t.num(0, 1e6, 'Current energy upkeep demand per second.'),
});
const pockets = t.list(t.obj({ ...cellXY, id: t.int(1, 255, 'Pocket identity shared by its located cells; one tap per pocket.') }), MAX_MAP_SIZE * MAX_MAP_SIZE, 'Located sealed magma cells, remembered until observed breached; placement knowledge, not hidden live truth.');

const resources = t.obj({
  alloy: t.num(0, 1e9, 'Actual shared bank, including fractional income and refunds. Earmarks are part of this total.'),
  energy: t.num(0, 1e9, 'Actual shared bank, including fractional income and refunds. Earmarks and upkeep are part of this total.'),
  freeAlloy: t.num(0, 1e9, 'Authoritative free bank after queue backing; a seat\'s direct spends and ifAffordable admissions may add its own lane\'s normal holds.'),
  freeEnergy: t.num(0, 1e9, 'Authoritative free bank after queue backing and finite upkeep protection; own-lane holds add as for alloy.'),
  heldAlloy: t.num(0, 1e9, 'Actual bank alloy earmarked for next commitments, not additional resources.'),
  heldEnergy: t.num(0, 1e9, 'Actual bank energy earmarked for next commitments, excluding upkeep.'),
  recoveryAlloy: t.num(0, 1e9, 'Subset of held alloy backing the verified requested recovery worker.'),
  recoveryEnergy: t.num(0, 1e9, 'Subset of held energy backing the verified requested recovery worker.'),
  upkeepHeld: t.num(0, 1e9, 'Finite energy buffer for shared-grid upkeep.'),
  /** alloy/s over the last 10 s */
  alloyRate: t.num(0, 1e6),
  /** Gross energy delivered per second: capped solar, solar-bank discharge and uncapped local generation. */
  energyRate: t.num(0, 1e6),
  /** solar production per second in orbit */
  solarRate: t.num(0, 1e6),
  /** delivery capacity per second (base + relays) */
  energyCap: t.num(0, 1e6),
  /** Stored solar surplus (0..rules.economy.solarBankMax): charges from solar above energyCap, discharges through it. */
  energyBank: t.int(0, 1e9),
  /** Total energy/s upkeep for turrets and consuming island structures; unpaid consumers go offline. */
  upkeep: t.num(0, 1e6),
  income: t.obj({ depths: planeIncome, surface: planeIncome, sky: planeIncome, orbit: planeIncome }, 'Income attributed to its source plane: lodes and Spire trickle Surface, ordinary mining Depths.'),
  /** tick when the orbital scan is available again (<= tick: ready) */
  scanReadyAt: t.int(0, 1e9),
  /** segment rebuilds your army has left this match (rules.spire.rebuilds; queue item `rebuild`) */
  rebuilds: t.int(0, 64),
});

const spireSeg = t.obj({ plane, hp: t.int(0, HP_CAP), maxHp: t.int(1, HP_CAP), threatened: t.opt(t.bool('Own segment under attack (hostile damage within rules.spire.threatWindow) or below rules.spire.threatHp of full HP; absent otherwise. Alert segment_threatened.')) });
/** Plane-owned lanes in shared-list order; only relative order within a plane controls its next commitment. */
const queueEntry = t.obj({
  id: queueId,
  item: t.enum(QUEUE_ITEMS),
  /** Unit plane (Spire or explicit Aerie/Shaft); structures use their own plane. */
  plane,
  /** Structures: footprint centre, never the input min-cell anchor; Headframe: outcrop centre; island builds: island centre when queued (see island). */
  x: t.opt(t.num(0, MAX_MAP_SIZE)),
  y: t.opt(t.num(0, MAX_MAP_SIZE)),
  /** Island structure: the shared held-island build slot. */
  island: t.opt(eid),
  /** Explicit forward producer: a Shaft for rootless diggers, or an Aerie for air. */
  producer: t.opt(eid),
  /** the requesting seat and original caller category, not its controller setting */
  by: plane,
  byCtl: CONTROLLER_ENUM,
  /** Present only for policy/bot/fallback requests; explicit owner/agent requests are never automatic. */
  automatic: t.opt(t.bool()),
  alloy: t.int(0, 100_000),
  energy: t.int(0, 100_000),
  heldAlloy: t.num(0, 100_000, 'Actual-bank backing toward this commitment; zero for paid work and non-head entries.'),
  heldEnergy: t.num(0, 100_000, 'Actual-bank backing toward this commitment; never additional currency.'),
  recovery: t.bool('Selected verified recovery request; bounded share while normal demand exists.'),
  paid: t.bool('Cost already paid; may be paused/blocked and retains ordinary cancellation refund rules.'),
  next: t.bool('Selected next normal commitment in this plane lane, including while saving from zero; recovery has its own marker.'),
  status: t.enum(QUEUE_STATUSES),
  reason: t.opt(t.enum(QUEUE_REASONS)),
  /** 0..1 while building */
  progress: t.num(0, 1),
  /** Remaining production ticks for paid, progressing work only; never a waiting funding forecast. */
  eta: t.opt(t.int(0, 1e7)),
  /** structures: the construction site once it started (a bulkhead has none: see digger) */
  site: t.opt(eid),
  /** bulkhead: the digger asked for, then (building) the digger at work on it */
  digger: t.opt(eid),
});
export type QueueEntryOut = Infer<typeof queueEntry>;
const QUEUE = t.list(queueEntry, QUEUE_LIST, 'Your army plane-owned intent lanes. Relative order within each plane matters; funding is fair across lanes, not global list order; see rules.queue.');
const hole = t.obj({ ...cellXY, kind: t.enum(HOLE_KINDS) });
const impact = t.obj({ ...xy, tick: t.int(0, 1e9), side, id: eid, start: t.opt(t.int(0, 1e9)), radius: t.opt(t.num(0.1, 24)) });
const sun = t.obj({
  /** bearing (rad, atan2(y - size / 2, x - size / 2) from the map centre) of one lit wedge's centre line; the others (matchData.sun.wedges in all) are at angle + k·2π/wedges */
  angle: t.num(0, TAU),
});
const turns = t.int(0, 3, 'Quarter turns about the map centre applied to the evaluated canonical point: each turn maps (x, y) → (size − y, x). 2 is the point mirror (size − x, size − y).');
/** Natural storms in public lists: rules.sky.stormSets (at most 2) orbits of one storm per map slot. */
const STORM_LIST = 2 * MAX_ARMIES;

const weatherPath = t.obj({
  cx: t.num(0, MAX_MAP_SIZE), cy: t.num(0, MAX_MAP_SIZE), radius: t.num(0, MAX_MAP_SIZE),
  phase: t.num(-TAU, TAU, 'Radians at tick zero.'),
  speed: t.num(-1, 1, 'Radians per second.'),
  turns,
});
const weatherCell = t.obj({ ...xy, radius: t.num(0, 12), path: weatherPath });
const naturalStorm = t.obj({
  id: t.int(0, 1e9), ...xy, radius: t.num(0, 12), maxRadius: t.num(0, 12),
  strength: t.num(0, 1, 'Current radius / maxRadius; scales speed penalty, damage and Stormcatcher income.'),
  stage: t.enum(['forecast', 'forming', 'mature', 'breaking'] as const),
  originX: t.num(0, MAX_MAP_SIZE), originY: t.num(0, MAX_MAP_SIZE),
  dx: t.num(-1, 1, 'Drift tiles per tick before turning.'), dy: t.num(-1, 1),
  turns,
  start: t.int(0, 1e9), grown: t.int(0, 1e9), breaking: t.int(0, 1e9), end: t.int(0, 1e9),
});
const seededStorm = t.obj({ ...xy, radius: t.num(0, MAX_MAP_SIZE), until: t.int(0, 1e9, 'Exclusive end tick of the active seeded storm; power loss ends it early.') });
const seedWarning = t.obj({ ...xy, radius: t.num(0, MAX_MAP_SIZE), from: t.int(0, 1e9, 'Tick the telegraphed seeded storm forms here (it follows its island until then).') });
const jetLane = t.obj({
  x1: t.num(0, MAX_MAP_SIZE), y1: t.num(0, MAX_MAP_SIZE), x2: t.num(0, MAX_MAP_SIZE), y2: t.num(0, MAX_MAP_SIZE),
  width: t.num(0, 8, 'Half-width in tiles.'),
  dx: t.num(-1, 1), dy: t.num(-1, 1),
});
const weather = t.obj({
  storms: t.list(naturalStorm, STORM_LIST, 'Current natural storms only; no future cycles.'),
  forecast: t.list(naturalStorm, STORM_LIST, 'Upcoming formation sites only after their public warning begins.'),
  fog: t.list(weatherCell, MAX_ARMIES), jets: t.list(jetLane, MAX_ARMIES),
  seeded: t.list(seededStorm, 16, 'Public active seeded storm geometry, without hidden structure identity or ownership.'),
  seedWarnings: t.list(seedWarning, 16, 'Public telegraphs of seeded storms about to form, without hidden structure identity or ownership.'),
}, 'Public seeded weather: current storms and the tactical forecast window only, never hidden entities or later cycles.');
/** Tick payloads omit fixed weather geometry, which travels in MatchData. */
const observedWeather = t.obj({
  storms: weather.fields.storms,
  forecast: weather.fields.forecast,
  fog: t.list(t.obj({ ...xy, radius: t.num(0, 12) }), MAX_ARMIES),
  seeded: weather.fields.seeded,
  seedWarnings: weather.fields.seedWarnings,
});
export type WeatherCell = Infer<typeof weatherCell>;
export type NaturalStorm = Infer<typeof naturalStorm>;
export type SeededStorm = Infer<typeof seededStorm>;
export type SeedWarning = Infer<typeof seedWarning>;
export type JetLane = Infer<typeof jetLane>;
export type Weather = Infer<typeof weather>;

export const directiveSchema = t.obj({
  stance: t.enum(STANCES, 'What the owner wants this seat to prioritise.'),
  focusX: t.opt(t.num(0, MAX_MAP_SIZE, 'Optional point of interest (tile x).')),
  focusY: t.opt(t.num(0, MAX_MAP_SIZE, 'Optional point of interest (tile y).')),
});
export type Directive = Infer<typeof directiveSchema>;

export const limitsSchema = t.obj({
  asteroidDrops: t.opt(t.bool('Allow asteroid drops; false forbids deorbit. Omitted means allowed.')),
  collapses: t.opt(t.bool('Allow sapper collapses and fault charges; false forbids undermine. Omitted means allowed.')),
});
export const mandateSchema = t.obj({
  autonomy: t.enum(['autonomous', 'supervised']),
  directive: directiveSchema,
  limits: t.opt(limitsSchema),
  whenAbsent: t.enum(['policy', 'bot', 'hold']),
});
export type SeatMandate = Infer<typeof mandateSchema>;

const DEPTHS_CELLS = t.list(t.int(0, 11), MAX_MAP_SIZE * MAX_MAP_SIZE, 'row-major depths cells (y*size+x): 0 unknown 1 bedrock 2 rock 3 ore 4 tunnel 5 fortified 6 rail 7 magma (a flood, cools to tunnel; or a pocket located by a scan) 8 Mother Lode (solid, mined from beside, never runs out) 9 lava bridge (walkable deck; lake again once destroyed) 10 green rich ore (mined like ore, richer loads) 11 lava lake (burns, never cools; `bridge` spans it)',);

/**
 * Planted sapper charges your team knows of: own and allied ones always; a hostile one once your Depths vision covers
 * its cell or you feel a tremor there (rules.depths.tremorRadius under your surface units and structures), and every
 * charge for the last rules.depths.chargePublicTime before it blows (rules.depths.chargesFogged; off: all are public).
 * `tick` = detonation tick.
 */
const charge = t.obj({ ...cellXY, tick: t.int(0, 1e9), side, stack: t.opt(t.int(1, 64, 'Own or allied charges only: sappers on it, the planter included (stacked damage counts up to rules.depths.chargeStackMax).')) });
const CHARGES = t.list(charge, CHARGE_CAP, 'planted sapper charges your team knows of (own and allied; hostile ones seen, felt, or in their public last seconds)');
/** Warden flares: your own and allied ones, and any whose landing cell your team sees. `until` = last lit tick. */
const flare = t.obj({ ...cellXY, until: t.int(0, 1e9), side });
const FLARES = t.list(flare, FLARE_CAP, 'Warden flares lighting the Depths (own and allied, plus any whose cell you see)');
/**
 * Enemy depths units sensed within rules.depths.tremorRadius beneath your surface units/structures (cell precision), and
 * enemy breaches in progress (`breach`: troopers digging up here) under your presence or surface vision.
 */
const TREMORS = t.list(t.obj({ ...cellXY, breach: t.opt(t.bool()) }), TREMOR_CAP, 'tremors: enemy movement in the depths under your surface presence');
/** Static surface terrain, packed (see TERRAIN_CELLS_PER_WORD, unpackTerrain). */
const TERRAIN = t.list(t.int(0, (1 << (TERRAIN_CODE_BITS * TERRAIN_CELLS_PER_WORD)) - 1), Math.ceil(MAX_MAP_SIZE * MAX_MAP_SIZE / TERRAIN_CELLS_PER_WORD), 'packed surface terrain: 7 cells per int, 4 bits each (SURFACE codes; elevated features retain bit 8)');
/** Fault lines (public): each an ordered list of cells along the fault. */
const FAULTS = t.list(t.obj({ cells: t.list(t.obj({ ...cellXY }), MAX_MAP_SIZE * MAX_MAP_SIZE) }), 8, 'fault lines, cells in order along each fault');
/**
 * Discovered Surface outcrops; x/y is the centre cell of the 3×3 Headframe pocket. Seeing any occupied cell
 * discovers it (including relays and scans); the team remembers it permanently. `open` is its last-seen seal state.
 */
const LODES = t.list(t.obj({ ...cellXY, rich: t.bool('contested (richer) lode'), loads: t.int(0, 100_000), open: t.bool() }), 32, 'discovered lodes with last-seen seal state');
/**
 * Crack stages (1..4) of damaged solid depths cells your team sees or knows: dig damage belongs to the cell (it stays
 * when the diggers leave) and the cell opens at full damage. Cracks on your own walls warn that someone is digging in:
 * `enemy` marks a crack last seen holding enemy dig damage next to a tunnel your team dug.
 */
const CRACKS = t.list(t.obj({ ...cellXY, stage: t.int(1, CRACK_STAGES), enemy: t.opt(t.bool('Enemy dig damage on a wall of your own tunnels: they are digging in here.')) }), CRACK_CAP, 'cracked depths cells you see or know');

export const fxSchema = t.obj({
  tick: t.int(0, 1e9),
  kind: t.enum(FX_KINDS),
  /** where it happens (shot: the shooter; for an unseen shooter, the target) */
  plane,
  ...xy,
  sourceElevation: t.opt(t.num(-MAX_MAP_SIZE, MAX_MAP_SIZE, 'World-tile vertical offset at plane/x/y; incoming-only shots use the visible target height. Omitted when that endpoint height is unknown.')),
  radius: t.opt(t.num(0.1, 24, 'Visible volatile Orbit detonation radius.')),
  /** shot: target plane/position (true planes, so cross-plane tracers can be drawn); portal: destination plane */
  tp: t.opt(plane),
  tx: t.opt(t.num(0, MAX_MAP_SIZE)),
  ty: t.opt(t.num(0, MAX_MAP_SIZE)),
  targetElevation: t.opt(t.num(-MAX_MAP_SIZE, MAX_MAP_SIZE, 'World-tile vertical offset at tp/tx/ty, only when the target endpoint height is known.')),
  w: t.opt(t.enum(WEAPONS)),
  side: t.opt(side),
  subject: t.opt(kind),
  /** shot: tick the projectile lands (= tick for instant weapons), so clients can animate the exact flight */
  arrive: t.opt(t.int(0, 1e9)),
  /** shot: the shooter's entity id (only when the team can see the shooter) */
  src: t.opt(eid),
  /**
   * Intercept/impact only: the terminated asteroid's already-public falling trajectory, retained after removal.
   * x/y are the intended landing tile coordinates; tick is the scheduled landing server tick (NOT this FX tick);
   * id is the asteroid entity id, so simultaneous falls at one target remain distinct. Rendering metadata only:
   * the outer plane/x/y retain their existing gameplay/fog meaning and fx.tick is the actual termination tick.
   */
  fall: t.opt(t.obj({ ...xy, tick: t.int(0, 1e9), id: eid, start: t.opt(t.int(0, 1e9)), radius: t.opt(t.num(0.1, 24)) })),
});
export type Fx = Infer<typeof fxSchema>;

/** One bitset per plane: bit i of word w = cell w * VISION_BITS_PER_WORD + i (row-major y * size + x) currently visible. */
const VISION_BITS = t.list(t.int(0, (1 << VISION_BITS_PER_WORD) - 1), Math.ceil(MAX_MAP_SIZE * MAX_MAP_SIZE / VISION_BITS_PER_WORD));
const DESIGNATIONS = t.obj({ normal: VISION_BITS, urgent: VISION_BITS }, 'Own team dig tags, packed in 30-bit words like vision; shared by all seats, including unexplored cells.');

/** Rally points of your Spire segments (units produced there fight-move to it). */
const RALLY = t.list(t.obj({ plane, ...xy }), 4);
/** The match's armies: public and static per match, in army order (slot order). */
const ARMIES_AT = t.list(t.obj({
  id: army,
  slot: t.int(0, MAX_ARMIES - 1, 'Map slot (corner) of this army.'),
  frame: t.int(0, 3, 'Quarter turns carrying the NW corner onto this army\'s corner: (x, y) → (size − y, x) per turn. Rotate canonical NW plans by it.'),
  colour: t.enum(COLOURS, 'Alliance colour: armies of different colours are hostile (every army has its own colour in free-for-all).'),
  spireAt: t.obj(xy, 'Spire centre (tile x/y; rules.map.spireInset from its corner); every segment stands here.'),
}), MAX_ARMIES, 'Every army of the match, in army order. Unclaimed map slots are neutral ground.');
/** Forward posts: public and static positions (owner and capture progress are the `post` entities in observations). */
const POSTS_AT = t.list(t.obj({
  id: eid,
  ...xy,
  kind: t.enum(POST_KINDS, 'home: an army\'s own post near its Spire (`home`; starts held by it when rules.surface.homePostsOwned); contested: a point every army races for (the map centre, the flanks), starting neutral, slower to take (contestedCaptureTime), no build radius by default (contestedPostBuildRadius) and scoring the last time-cap tiebreak (postScore).'),
  home: t.opt(army),
}), MAX_ARMIES * MAX_POST_COUNT + MAX_CONTESTED_POSTS, 'Surface forward posts (DESIGN §4.2 Outposts), from the map document (or the recipe from public data alone), exactly symmetric: the home posts in army order (rules.map.postCount per army), then the contested points (rules.map.contestedPosts). Empty when rules.surface.postsEnabled is false. Every observation lists each post as a public entity (kind post) with its holder (side), state (idle, capturing, contested) and progress.');
/** Public elimination state, and this army's final placement once its outcome is final. */
const ARMY_STATUS = {
  eliminated: t.list(army, MAX_ARMIES, 'Armies eliminated so far (public): they lost their last crown (rules.spire.lossRule) or forfeited; all their entities were removed.'),
  rank: t.opt(t.int(1, MAX_ARMIES, 'Your final placement (1 = winner; tied armies share a rank), present once your outcome is final: eliminated, or the match is over.')),
  crowns: t.opt(t.list(t.obj({
    army,
    lost: t.int(0, 64, 'Crowns lost (fallen segments; a rebuilt one returns its crown). Out at rules.spire.crownsToLose.'),
    fallen: t.list(plane, 4, 'Segments down, in plane order.'),
  }), MAX_ARMIES, 'lossRule crowns only (public): every army, in army order; live while it plays, frozen as it fell once eliminated (a forfeit: as it stood). One crown from out is match point.')),
};

/**
 * Plannable world: every island's exact circular path. Position at tick T:
 * (cx + r·cos(phase + speed·T/TICK_RATE), cy + r·sin(phase + speed·T/TICK_RATE)). At most one island per map slot on
 * each of at most rules.map.islandMaxRings (8) rings.
 */
const ISLANDS = t.list(
  t.obj({ id: eid, cx: t.num(0, MAX_MAP_SIZE), cy: t.num(0, MAX_MAP_SIZE), r: t.num(0, MAX_MAP_SIZE), phase: t.num(-1e9, 1e9, 'drift phase including accumulated mooring delays (rad)'), speed: t.num(-1, 1, 'rad/s, sign = direction'), pausedAt: t.opt(t.int(0, 1e9)), oreCapacity: t.opt(t.num(0, 100000, 'Immutable initial deposit; current remaining ore and onboard cargo are never part of public paths.')), hardpoint: t.opt(t.obj({ kind: t.enum(HARDPOINT_KIND_LIST), side }, 'Visible island hardpoint occupant; absent means empty or concealed, not confirmed empty.')) }),
  8 * MAX_ARMIES,
  'island paths (public schedule)',
);
/**
 * Timed world events (closed vocabulary): asteroid_spawn = the next orbit of drifting asteroids (one per map slot)
 * appears if at most rules.orbit.maxAsteroids minus the slot count are there (positions are seeded, not announced);
 * magma_cools = a magma flood your team can see turns to rock (x, y: where it broke out); derelict_open = the
 * derelict's gates stand open from `tick` until `until` (the next two windows, public); core_regrows = a new derelict
 * core grows at the ruin centre (public); lode_vent = the Mother Lode's fuse runs out and it vents at `tick` (public;
 * x, y: the lode cell you know nearest your Spire); sudden_death = sudden death begins at `tick` (public, listed for
 * the last rules.spire.suddenDeathWarning before it); collapse = a charge your team knows of (`charges`) blows at
 * `tick` (x, y: its cell centre).
 */
export const SCHEDULE_KINDS = ['asteroid_spawn', 'magma_cools', 'derelict_open', 'core_regrows', 'lode_vent', 'sudden_death', 'collapse'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
const SCHEDULE = t.list(t.obj({ kind: t.enum(SCHEDULE_KINDS), tick: t.int(0, 1e9), until: t.opt(t.int(0, 1e9)), x: t.opt(t.num(0, MAX_MAP_SIZE)), y: t.opt(t.num(0, MAX_MAP_SIZE)) }), SCHEDULE_CAP, 'upcoming timed events, soonest first');
/** Public while the derelict core is out past the hull: when and where it was lifted, and by whom. */
const CORE_LIFTED = t.opt(t.obj({ tick: t.int(0, 1e9), ...xy, side }, 'The derelict core is out of the ruin under tow (public): its lift; its live position needs vision.'));
/**
 * The Mother Lode's pressure (rules.depths.lodePressure*): one value shared by every army and public, so absent only
 * when the match has no lode or pressure is off. x/y: the lode cell your team knows nearest your Spire (absent while it
 * knows none; the lode_critical alert needs it).
 */
const MOTHER_LODE = t.opt(t.obj({
  pressure: t.num(0, LODE_PRESSURE_MAX, `0–${LODE_PRESSURE_MAX}: each load anyone mines adds rules.depths.lodePressurePerLoad, it bleeds lodePressureBleed/s; from lodeCritical it climbs on its own to ${LODE_PRESSURE_MAX} at \`ventAt\`.`),
  rate: t.num(-1000, 100_000, 'Pressure per second: while the fuse burns, its climb to the vent; before, the last lodeVentWindow\'s loads × lodePressurePerLoad at that pace minus lodePressureBleed.'),
  state: t.enum(LODE_STATES, 'calm; warn from lodeWarn (glows, rumbles); critical: committed at lodeCritical, the fuse burns and it vents at `ventAt` whatever anyone does (alert lode_critical); cooling after a vent: unminable until `until`.'),
  ventAt: t.opt(t.int(0, 1e9, 'critical: the tick it vents (lodeVentBlast to every Depths unit within the ring plus lodeVentBlastReach, then magma)')),
  until: t.opt(t.int(0, 1e9, 'cooling: the tick it can be mined again')),
  x: t.opt(t.num(0, MAX_MAP_SIZE)),
  y: t.opt(t.num(0, MAX_MAP_SIZE)),
}, 'Mother Lode pressure (public, shared by every army).'));

/**
 * Per-plane alerts (closed vocabulary): each plane's timed items, most relevant first, derived only from your army's
 * knowledge behind the observation fields (spire, schedule, weather, impacts, charges, cracks, tremors, entities, motherLode) — on every
 * plane, also those an observation only summarises — so they never reveal more than detail 'all' would show. Every plane first: segment_threatened = your own segment on that plane is under attack (hostile damage within rules.spire.threatWindow) or below rules.spire.threatHp of its full HP (its `spire` entry `threatened`; your team's cue to send `defend`); then sudden_death = sudden death begins at `tick` (public, during its countdown: every Spire segment then takes ×rules.spire.suddenDeathDamage, impacts excepted). orbit, threats first: radiation = your own Orbit ships are inside the irradiated derelict chamber (`count`, x/y = the ruin centre); core_lifted = the derelict core left the ruin (`tick`, x/y of the lift, `side` = the towing army), then rocks = next asteroid pair spawn. sky, threats first: island_contested = an island you hold that an
 * enemy is capturing or that hostile alliances are fighting over (its entity state `capturing` or `contested`,
 * furthest capture first); then the next storm from the public forecast (storm_forming at `tick`), then its life
 * stage, each until `tick`: storm_growing, storm_peak, storm_breaking. surface, threats first: charge_under = a hostile
 * charge you know of blowing at `tick` whose collapse reaches your Surface units or structures (within
 * rules.depths.collapseRadius + collapseStructureReach of x/y, the charge cell centre; `count` of them: step clear),
 * then post_contested = a forward post you hold that an enemy is capturing or fighting over (as island_contested), then drop = telegraphed
 * impact landing at `tick` (`side` = whose drop). depths, threats first: lode_critical = the Mother Lode's fuse burns: it
 * vents at `tick` (x/y: the lode cell you know nearest your Spire), intruder = hostile Depths units you see in or beside
 * your own tunnels within rules.depths.intruderRadius of your Depths structures, Shafts, Headframes or Spire (`count`,
 * x/y = the nearest), wall_dig = enemy digging into your tunnel walls (`stage` = crack stage), charge = a hostile charge
 * you know of blowing at `tick`; then breach = enemy troopers digging up under your surface
 * presence, tremor = enemy depths units beneath it (`count` cells); then magma = a known flood cooling at `tick`. x/y =
 * the spot (tile coordinates, cell centres), absent when the item has none.
 */
export const ALERT_KINDS = ['segment_threatened', 'sudden_death', 'rocks', 'core_lifted', 'radiation', 'storm_forming', 'storm_growing', 'storm_peak', 'storm_breaking', 'island_contested', 'post_contested', 'charge_under', 'drop', 'lode_critical', 'intruder', 'wall_dig', 'charge', 'breach', 'tremor', 'magma'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
/** Alerts kept per plane. */
export const ALERTS_PER_PLANE = 3;
const ALERTS = t.list(t.obj({
  plane,
  kind: t.enum(ALERT_KINDS),
  tick: t.opt(t.int(0, 1e9, 'When it happens or the current stage ends.')),
  x: t.opt(t.num(0, MAX_MAP_SIZE)),
  y: t.opt(t.num(0, MAX_MAP_SIZE)),
  side: t.opt(side),
  stage: t.opt(t.int(1, CRACK_STAGES)),
  count: t.opt(t.int(1, ALERT_COUNT_CAP)),
}), 4 * ALERTS_PER_PLANE, `per-plane alerts, planes in order ${PLANES.join(', ')}, most relevant first within a plane (at most ${ALERTS_PER_PLANE} each)`);

const ghost = t.obj({ id: eid, kind, side, plane, ...xy, seen: t.int(0, 1e9), elevation: t.opt(t.num(-8, 0, 'Last-seen Sky elevation; not updated through fog.')) });

const researchSchema = t.obj({
  available: t.list(t.enum(UPGRADE_IDS), 64, 'Research currently eligible to queue; funding may wait.'),
  inProgress: t.list(t.enum(UPGRADE_IDS), 64, 'Queued or currently researching upgrades.'),
  completed: t.list(t.enum(UPGRADE_IDS), 64),
  seen: t.list(t.obj({ army, upgrades: t.list(t.enum(UPGRADE_IDS), 64) }), MAX_ARMIES, 'Per hostile army, the upgrades whose effects your army has observed (armies with none observed are omitted).'),
});

const ORE_CACHES = t.list(t.obj({
  id: t.int(1, 1e9),
  ...xy,
  alloy: t.num(0, 1e9),
  radius: t.num(0.1, 8),
  below: t.opt(t.obj({ ...xy, alloy: t.num(0, 1e9) })),
}), ORE_CACHE_CAP, 'Currently visible ore caches; stand nearby uncontested to collect loads. Below is only shown with Depths vision.');
const SCORCHES = t.list(t.obj({ ...xy, radius: t.num(0.1, 24), until: t.int(0, 1e9) }), SCORCH_CAP, 'Currently visible volatile scorch hazards.');
const rulesHash = t.int(0, 0xffffffff, 'FNV-1a of the canonical resolved rules JSON; fixed per match. A mismatch requires a fresh match bootstrap.');
const BUILD_RADIUS = t.obj({
  sources: t.list(t.obj({
    kind: t.enum(BUILD_RADIUS_KINDS),
    radius: t.num(0, MAX_MAP_SIZE, 'Tiles from this structure\'s footprint centre.'),
  }), BUILD_RADIUS_KINDS.length, 'Kinds that project build radius while they are yours, alive and completed (not constructing); a home post (kind post) while you hold it. Turrets project none.'),
  contestedPost: t.num(0, MAX_MAP_SIZE, 'Radius a contested point (matchData.posts kind contested) projects while you hold it, instead of the post source radius (rules.surface.contestedPostBuildRadius; 0: none).'),
  enemySpireNoBuild: t.num(0, MAX_MAP_SIZE, 'Tiles from every hostile Spire footprint edge (matchData.armies[].spireAt) in which no Surface structure may stand.'),
  exempt: t.list(t.enum(BUILDABLE), BUILDABLE.length, 'Kinds placed without the radius (still outside the no-build zone): a Headframe needs only a known lode.'),
}, 'Surface placement rule for shaft, turret and Headframe (Sky island and Depths structures are exempt). A shaft or turret site\'s footprint centre must lie within `radius` of the footprint centre of one of your own live, completed source structures (or of a forward post you hold); a Headframe goes on any known lode. No site may be within enemySpireNoBuild of any hostile Spire footprint edge. Failures: out_of_radius, no_build_zone. Your radius is computed from your own entities only: hostile radii are never revealed. Completed Headframes and Shafts and held posts extend it, so a forward lode or post is how you build forward. An unstarted queued site whose covering source dies (or post is lost) is cancelled (queue_cancelled event, code out_of_radius; nothing was paid yet). Structures already standing keep working.');
/** Public, immutable match bootstrap. Never includes generated underground terrain or hidden entities. */
export const matchDataSchema = t.obj({
  rules: rulesSchema,
  rulesHash,
  upgrades: t.list(t.obj({
    id: t.enum(UPGRADE_IDS),
    at: plane,
    alloy: t.int(0, 100_000),
    energy: t.int(0, 100_000),
    units: t.list(t.enum([...UNIT_KINDS, ...STRUCTURE_KINDS]), 64, 'Beneficiary kinds from registry ability and kind-selected modifier effects; deduplicated.'),
  }), 64, 'Public research catalog, with resolved match costs and registry-derived beneficiaries.'),
  preset: t.enum(TERRAIN_PRESETS),
  mapId: t.str(96, '^[a-z][a-z0-9_]*$', 'Public authored map identity or generated terrain recipe.'),
  mapSeed: t.int(0, 0xffffffff, 'Public map seed: reproduces the public layers of a generated map, never the fogged Depths, ore, magma or lodes.'),
  mapHash: t.int(0, 0xffffffff, 'Hash of the public map document (a generated map without its hidden layers).'),
  terrain: TERRAIN,
  faults: FAULTS,
  armies: ARMIES_AT,
  posts: POSTS_AT,
  symmetry: t.enum(['C2', 'C4'] as const, 'Map symmetry: C2 = two slots, point mirror; C4 = four slots, quarter turns.'),
  buildRadius: BUILD_RADIUS,
  sun: t.obj({
    speed: t.num(-1, 1, 'Radians per second.'),
    half: t.num(0, Math.PI / 2, 'Wedge half-width in radians.'),
    wedges: t.int(1, MAX_ARMIES, 'Lit wedges, evenly spaced (one per map slot): every corner starts in daylight.'),
  }),
  orbitRegions: t.list(t.obj({
    ...xy,
    width: t.num(Number.MIN_VALUE, MAX_MAP_SIZE),
    height: t.num(Number.MIN_VALUE, MAX_MAP_SIZE),
    dx: t.num(-1, 1), dy: t.num(-1, 1),
    weight: t.num(0.01, 100), spread: t.num(0, 1),
  }), 64, 'Public, map-authored Orbit asteroid placement regions, expanded from the canonical sector. x/y are rectangle centres, not minimum corners.'),
  jets: t.list(jetLane, MAX_ARMIES),
  derelict: t.opt(t.obj({
    ...xy,
    hullInner: t.num(0, MAX_MAP_SIZE), hullOuter: t.num(0, MAX_MAP_SIZE),
    breaches: t.int(4, 8), breachWidth: t.num(0, MAX_MAP_SIZE),
    ringInner: t.num(0, MAX_MAP_SIZE), ringOuter: t.num(0, MAX_MAP_SIZE),
    gates: t.int(4, 8), gateWidth: t.num(0, MAX_MAP_SIZE),
    open: t.int(0, 1e6, 'Open window ticks.'), turn: t.int(0, 1e6, 'Ring turn ticks.'), closed: t.int(0, 1e6, 'Sealed span ticks.'),
  }, 'The derelict ruin at the map centre (absent when rules.orbit.derelictEnabled is off). Tiles scaled to this map; the cycle starts open at tick 0: open → turn → closed → turn. Walls block Orbit movement, fire and (rules.orbit.derelictBlocksVision) sight and cloak detection: the hull outside its breaches (axis bearings), the ring outside its gates and entirely while not open. Inside the ring is the chamber (radiation; seen from outside only along an open gate\'s line, never with derelictBlocksVision off).')),
  fogPaths: t.list(weatherPath, MAX_ARMIES, 'Fixed paths, indexed like weather.fog.'),
}, 'Cache for this match: game_briefing {topic:\'match-data\'} for agents, separate init(matchData) for policies, and initial view.match for clients. Never embedded in observations.');
export type MatchData = Infer<typeof matchDataSchema>;
/** matchData.buildRadius for a match's rules (compiled `econ` or `rules.surface`). */
export function buildRadiusData(rules: BuildRadiusRules): MatchData['buildRadius'] {
  return { sources: BUILD_RADIUS_KINDS.map((kind) => ({ kind, radius: rules[BUILD_RADIUS_RULE[kind]] })), contestedPost: rules.contestedPostBuildRadius, enemySpireNoBuild: rules.enemySpireNoBuild, exempt: BUILDABLE.filter(radiusExempt) };
}

/** Whole-plane field groups: shown only when one of these planes is in the observation's `detail` (OBS_FIELD_PLANES). */
export const OBS_FIELD_PLANES = {
  islands: ['sky'],
  weather: ['sky'],
  lodes: ['surface', 'depths'],
  pockets: ['depths'],
  holes: ['surface', 'depths'],
  oreCaches: ['surface', 'depths'],
  scorches: ['surface'],
  surfaceVision: ['surface'],
  charges: ['surface', 'depths'],
  flares: ['depths'],
  cracks: ['depths'],
  tremors: ['surface', 'depths'],
  designations: ['depths'],
  depths: ['depths'],
} as const satisfies Record<string, readonly (typeof PLANES)[number][]>;
const summaryCount = t.opt(t.int(1, SUMMARY_COUNT_CAP));
/**
 * A plane outside the observation's detail, compact: what your army sees there now and the cross-plane threats every
 * seat must react to. Derived only from the same fogged knowledge as the full fields.
 */
const PLANE_SUMMARY = t.obj({
  plane,
  counts: t.list(t.obj({ kind, own: summaryCount, hostile: summaryCount, neutral: summaryCount }), kind.values.length, 'Entities your army sees on this plane now, by kind: own, hostile and neutral (a zero is omitted).'),
  events: t.int(0, SUMMARY_COUNT_CAP, 'Events on this plane left out of `events` (which keeps only cross-plane kinds of summarised planes) over the same window.'),
  transit: t.list(t.obj({ id: eid, kind, to: plane, at: t.int(0, 1e9, 'Arrival tick; 0 after arrival.') }), SUMMARY_TRANSIT_CAP, 'Your units on this plane moving to another plane (troops riding a Shaft, ascending interceptors).'),
  shafts: t.opt(t.list(t.obj({ id: eid, ...xy, hp: t.int(0, HP_CAP), maxHp: t.int(1, HP_CAP), state: t.enum(STATES), sealed: t.opt(t.bool('No transfer there until the Depths reach its landing.')) }), SUMMARY_SHAFT_CAP, 'Surface only: your Shafts, the troop portals between Surface and Depths.')),
  islands: t.opt(t.list(t.obj({ id: eid, ...xy, side: t.opt(side) }), 8 * MAX_ARMIES, 'Sky only: where every island is now (public paths); `side` = its holder while your army sees it.')),
});
/** Event kinds every seat receives from summarised planes: eliminations, Spire hits, breaches, island and core swings. */
export const CROSS_PLANE_EVENTS: readonly EventKind[] = ['army_eliminated', 'spire_damaged', 'tunnel_breach', 'breach_opened', 'island_captured', 'island_lost', 'core_lifted', 'core_meltdown'];

export const observationSchema = t.obj({
  tick: t.int(0, 1e9),
  role: plane,
  army,
  ...ARMY_STATUS,
  outcome: t.enum(OUTCOMES),
  mandate: mandateSchema,
  rulesHash,
  detail: t.list(plane, PLANES.length, `Planes rendered in full: your role's plane plus any you asked for (game_observe detail, a policy's \`detail\`). Entities, events and the plane fields (${Object.entries(OBS_FIELD_PLANES).map(([f, p]) => `${f}: ${p.join('/')}`).join(', ')}) appear only for planes in detail; every other plane is summarised in \`planes\`.`),
  planes: t.list(PLANE_SUMMARY, PLANES.length, 'One compact summary per plane outside `detail`, in plane order.'),
  res: resources,
  sun,
  islands: t.opt(ISLANDS),
  weather: t.opt(observedWeather),
  schedule: SCHEDULE,
  coreLifted: CORE_LIFTED,
  motherLode: MOTHER_LODE,
  lodes: t.opt(LODES),
  pockets: t.opt(pockets),
  spire: t.list(spireSeg, 4),
  queue: QUEUE,
  research: researchSchema,
  entities: t.list(entitySchema, OBS_ENTITY_CAP, 'Every entity your army sees now on the planes in `detail` (own, enemy, neutral), your role\'s plane first.'),
  holes: t.opt(t.list(hole, MAX_MAP_SIZE * MAX_MAP_SIZE)),
  impacts: t.list(impact, IMPACT_CAP, 'asteroids falling; impact at tick'),
  oreCaches: t.opt(ORE_CACHES),
  scorches: t.opt(SCORCHES),
  /** Current own/allied raw Surface sight, packed in 30-bit words; includes post sight and terrain occlusion.
   * Structures are seen if any footprint cell is set; Surface units in forests need additional spotting. */
  surfaceVision: t.opt(VISION_BITS),
  events: t.list(eventSchema, OBS_EVENT_CAP, `Events after \`since\` within the window a full observation lists (its last ${OBS_EVENT_CAP}): all of the planes in \`detail\`, and of the other planes only the cross-plane kinds (${CROSS_PLANE_EVENTS.join(', ')}); \`planes[].events\` counts the rest.`),
  charges: t.opt(CHARGES),
  flares: t.opt(FLARES),
  cracks: t.opt(CRACKS),
  tremors: t.opt(TREMORS),
  alerts: ALERTS,
  rally: RALLY,
  designations: t.opt(DESIGNATIONS),
  /** The whole grid only on a first observation (`since` 0) or with every plane in detail; else `depthsChanges`. */
  depths: t.opt(DEPTHS_CELLS),
  depthsChanges: t.opt(t.ints(2 * MAX_MAP_SIZE * MAX_MAP_SIZE, 0, MAX_MAP_SIZE * MAX_MAP_SIZE - 1,
    'Depths seat, after its first observation: the cells whose knowledge changed since your `since` tick, as flat pairs [cell, code, cell, code, …] (codes as `depths`); apply them to the grid you keep. The full `depths` grid comes with since 0 (game_observe without since) or detail "all".')),
  /** team signals sent to you and by you (host-provided; rules/signals.ts) */
  signals: SIGNAL_SCHEMAS.observation,
});
export type Observation = Infer<typeof observationSchema>;
/** What the game's observe() builds: the PlayerThree host adds `signals` (or a headless runner's SignalBoard does). */
export type GameObservation = Omit<Observation, 'signals'>;
/** Every plane field present: an observation rendered with every plane in full. */
export type FullPlaneFields = { [K in keyof typeof OBS_FIELD_PLANES]-?: NonNullable<Observation[K]> };
/** An observation with every plane in full (`detail` = all planes): what built-in bots and other game code read. */
export type FullObservation = Observation & FullPlaneFields;

export const viewSchema = t.obj({
  tick: t.int(0, 1e9),
  army,
  ...ARMY_STATUS,
  outcome: t.enum(OUTCOMES),
  rulesHash,
  /** Initial snapshot and first broadcast only; retain for later dynamic-only views. */
  match: t.opt(matchDataSchema),
  res: resources,
  sun,
  islands: ISLANDS,
  weather: observedWeather,
  schedule: SCHEDULE,
  coreLifted: CORE_LIFTED,
  motherLode: MOTHER_LODE,
  seats: t.list(t.obj({ role: plane, controller: CONTROLLER_ENUM, mandate: mandateSchema }), 4),
  spire: t.list(spireSeg, 4),
  queue: QUEUE,
  research: researchSchema,
  entities: t.list(entitySchema, VIEW_ENTITY_CAP),
  holes: t.list(hole, MAX_MAP_SIZE * MAX_MAP_SIZE),
  impacts: t.list(impact, IMPACT_CAP),
  oreCaches: ORE_CACHES,
  scorches: SCORCHES,
  events: t.list(eventSchema, VIEW_EVENT_CAP, 'recent events (last ~10 s)'),
  depths: DEPTHS_CELLS,
  /** render effects of the last ~10 ticks this team could see (dedupe by tick) */
  fx: t.list(fxSchema, VIEW_FX_CAP),
  vision: t.obj({ depths: VISION_BITS, surface: VISION_BITS, sky: VISION_BITS, orbit: VISION_BITS }),
  /** enemy structures last seen and not currently visible (ghosts) */
  memory: t.list(ghost, GHOST_CAP),
  charges: CHARGES,
  flares: FLARES,
  lodes: LODES,
  pockets,
  cracks: CRACKS,
  tremors: TREMORS,
  alerts: ALERTS,
  designations: DESIGNATIONS,
  rally: RALLY,
  /** the team's signal board (host-provided): requests between your planes and their state */
  signals: SIGNAL_SCHEMAS.view,
});
export type View = Infer<typeof viewSchema>;
/** What the game's view() builds: the PlayerThree host adds `signals`. */
export type GameView = Omit<View, 'signals'>;

/** Observer-only public battlefield. No controller mandates, policies or source simulation objects. */
const observerForces = t.obj({
  plane, units: t.int(0, 100000), alloy: t.num(0, 1e12), energy: t.num(0, 1e12),
  structures: t.int(0, 100000), structureAlloy: t.num(0, 1e12), structureEnergy: t.num(0, 1e12),
});
export const observerSchema = t.obj({
  perspective: t.enum(['all']),
  terrain: t.obj({
    ore: t.list(t.int(0, 255), MAX_MAP_SIZE * MAX_MAP_SIZE),
    magma: t.list(t.int(0, 255), MAX_MAP_SIZE * MAX_MAP_SIZE),
    ownership: t.list(t.int(0, MAX_ARMIES), MAX_MAP_SIZE * MAX_MAP_SIZE, 'Tunnel owner per cell: 0 none, k = matchData.armies[k − 1].'),
    cracks: t.list(t.int(0, CRACK_STAGES), MAX_MAP_SIZE * MAX_MAP_SIZE),
  }, 'Omniscient current physical terrain only: ore loads, sealed magma pockets, tunnel ownership and crack stages.'),
  world: t.obj({
    ...viewSchema.fields,
    entities: t.list(entitySchema, 100000),
    impacts: t.list(impact, 100000),
    charges: t.list(charge, 100000),
    flares: t.list(flare, 100000),
    fx: t.list(fxSchema, 100000),
    oreCaches: t.list(ORE_CACHES.item, 100000),
    scorches: t.list(SCORCHES.item, 100000),
    cracks: t.list(CRACKS.item, MAX_MAP_SIZE * MAX_MAP_SIZE),
    seats: t.list(viewSchema.fields.seats.item, 0),
  }),
  sides: t.list(t.obj({
    army, res: resources, spire: t.list(spireSeg, 4), queue: QUEUE, research: researchSchema,
    forces: t.list(observerForces, 4),
    rank: t.opt(t.int(1, MAX_ARMIES, 'This army\'s final placement (1 = winner; tied armies share a rank), present once its outcome is final: eliminated, or the match is over.')),
    events: viewSchema.fields.events,
    vision: viewSchema.fields.vision,
  }), MAX_ARMIES, 'One row per army of the match, in army order (world carries the first army\'s own fields; use these rows per army).'),
}, 'Read-only omniscient public battlefield, available only to separately admitted observers.');
export type ObserverView = Infer<typeof observerSchema>;

const teamStats = t.obj({
  alloyMined: t.int(0, 1e9),
  energyDelivered: t.int(0, 1e9),
  produced: t.int(0, 1e6),
  unitsLost: t.int(0, 1e6),
  kills: t.int(0, 1e6),
  structuresLost: t.int(0, 1e6),
  collapses: t.int(0, 1e6),
  impacts: t.int(0, 1e6),
  interceptions: t.int(0, 1e6),
  islandTicks: t.int(0, 1e9),
  spireDamageDealt: t.int(0, 1e9),
  /** alloy from lode pockets (delivered by diggers, any army's lodes) plus Headframe trickles */
  lodeAlloy: t.int(0, 1e9),
  /** depths cells fortified or reinforced, bulkheads and Headframes completed */
  fortified: t.int(0, 1e6),
  bulkheads: t.int(0, 1e6),
  headframes: t.int(0, 1e6),
  /** deploy stances started (Warden shield walls, dug-in Troopers, sieged tanks, emplaced flak), and Warden flares thrown */
  deploys: t.int(0, 1e6),
  flares: t.int(0, 1e6),
  /** Troopers converted into Breachers at a Drill Yard */
  conversions: t.int(0, 1e6),
  /** forward posts captured (each neutral or hostile post taken counts once), and post-ticks held */
  postsCaptured: t.int(0, 1e6),
  postTicks: t.int(0, 1e9),
  /** ticks contested points held (summed over points): × rules.surface.postScore per second, the last time-cap tiebreak */
  pointTicks: t.int(0, 1e9),
  /** Island catches and Storm Seeder storms started. */
  moorings: t.int(0, 1e6),
  seeds: t.int(0, 1e6),
  /** Gunships emplaced as Gun Platforms */
  emplaced: t.int(0, 1e6),
  /** derelict cores towed home and cashed in */
  coreCashed: t.int(0, 1e6),
});
export const reportSchema = t.obj({
  outcome: t.enum(OUTCOMES),
  rank: ARMY_STATUS.rank,
  ticks: t.int(0, 1e9),
  armies: t.list(t.obj({
    army,
    colour: t.enum(COLOURS),
    rank: t.opt(t.int(1, MAX_ARMIES, 'Final placement once this army\'s outcome is final.')),
    stats: teamStats,
    spire: t.list(spireSeg, 4),
  }), MAX_ARMIES, 'Every army of the match, in army order.'),
  /** key moments, oldest first */
  timeline: t.list(eventSchema, REPORT_TIMELINE_CAP),
});
export type Report = Infer<typeof reportSchema>;
