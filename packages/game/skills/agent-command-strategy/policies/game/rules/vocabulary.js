// Agent Command's built-in bot library: packages/game/src/rules/vocabulary.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * Closed vocabularies of the game (planes, teams, kinds, queue items, terrain presets, entity states, abilities,
 * stances) with their types and guards, plus the fixed world constants (map sizes, tick rate).
 */
export const MAX_MAP_SIZE = 80;
export const MAP_SIZES = [48, 64, 80];
export const TICK_RATE = 20; // ticks per second
/** Game seconds → ticks. Every tick-denominated constant is written through this so the tick rate can change. */
export const toTicks = (seconds) => Math.round(seconds * TICK_RATE);

export const PLANES = ['depths', 'surface', 'sky', 'orbit'];
export const isPlane = (v) => (PLANES).includes(v);
/** Planes a trooper `transfer` moves between through a portal (an own built Shaft). */
export const PORTAL_PLANES = ['depths', 'surface'];
/**
 * Army ids: the map corner of the army's slot (DESIGN §15.1). The index of a corner is its frame, the quarter turns
 * that carry the NW corner onto it ((x, y) → (size − y, x) per turn). Two-slot maps use `nw` and `se`; four-slot
 * maps all four.
 */
export const ARMIES = ['nw', 'ne', 'se', 'sw'];
export const SIDES = [...ARMIES, 'neutral'];
/** Most armies a match can hold (one per map slot; four-slot maps are C4). */
export const MAX_ARMIES = 4;
/** Army colours: armies sharing a colour are allied (DESIGN §15.3). Colour never breaks a tie. */
export const COLOURS = ['blue', 'red', 'green', 'violet'];

export const ROCK_SIZES = ['pebble', 'medium', 'large'];
export const ROCK_RESOURCE_TYPES = ['metal', 'ice', 'slag'];

/** Render altitude per plane (world units; 1 tile = 1 unit). */
export const PLANE_Y = { depths: -24, surface: 0, sky: 22, orbit: 52 };

/** Units a Spire segment (or a forward producer) builds from the team queue. */
export const PRODUCED_UNITS = ['digger', 'sapper', 'trooper', 'tank', 'flak', 'interceptor', 'bomber', 'solar', 'tug', 'lancer', 'skiff', 'bastion', 'warden', 'gunship'];
export const isProducedUnit = (k) => (PRODUCED_UNITS).includes(k);
/** Units only a conversion makes (a Trooper walked into an own Drill Yard: `convert`); never queue items. */
export const CONVERTED_UNITS = ['breacher'];
export const UNIT_KINDS = [...PRODUCED_UNITS, ...CONVERTED_UNITS];
/** Air units an Aerie produces, houses and repairs. */
export const AIRCRAFT = ['interceptor', 'bomber', 'gunship'];
export const isAircraft = (k) => (AIRCRAFT).includes(k);
/** A unit kind; as a queue item, one made at a Spire segment (else a structure built at its site). */
export const isUnitKind = (k) => (UNIT_KINDS).includes(k);
export const ISLAND_STRUCTURES = ['relay', 'aerie', 'storm_seeder', 'stormcatcher'];
export const isIslandStructure = (kind) => (ISLAND_STRUCTURES).includes(kind);
/**
 * Island hardpoint registry: kinds that may attach to an island's hardpoint (rules.sky.islandHardpoints slots, beside
 * the build slot). An attachment is either converted from a unit or constructed through the build queue.
 */
export const HARDPOINT_KINDS = { gun_platform: { from: 'gunship' }, island_mortar: { buildable: true }, ore_extractor: { buildable: true } };
export const HARDPOINT_KIND_LIST = ['gun_platform', 'island_mortar', 'ore_extractor'];
export const isHardpointKind = (k) => Object.hasOwn(HARDPOINT_KINDS, k);
export const BUILDABLE_HARDPOINTS = ['island_mortar', 'ore_extractor'];
export const isBuildableHardpoint = (kind) => (BUILDABLE_HARDPOINTS).includes(kind);
/** Queued island construction, split between the main slot and the independent hardpoint. */
export const ISLAND_BUILDS = [...ISLAND_STRUCTURES, ...BUILDABLE_HARDPOINTS];
export const isIslandBuild = (kind) => (ISLAND_BUILDS).includes(kind);
export const STRUCTURE_KINDS = ['spire', 'shaft', 'turret', 'mooring_tower', ...ISLAND_STRUCTURES, 'headframe', 'bulkhead', 'geothermal', 'drill_yard', ...HARDPOINT_KIND_LIST, 'lava_bridge'];
export const isStructureKind = (kind) => (STRUCTURE_KINDS).includes(kind);
/**
 * Depths structures that are their own walkable cell rather than a body on it: a bulkhead (a door its allies pass) and
 * a lava bridge (a deck every army walks). Neither stamps a solid footprint or separates units standing on it.
 */
export const isCellStructure = (kind) => kind === 'bulkhead' || kind === 'lava_bridge';
/** Neutral world objects without a stats row: Sky islands, drifting asteroids, the derelict core (Orbit) and Surface forward posts (DESIGN §4.2). */
export const NEUTRAL_KINDS = ['island', 'asteroid', 'core', 'post'];
export const isNeutralKind = (kind) => (NEUTRAL_KINDS).includes(kind);
/** Upper bound of rules.map.postCount (home posts per army); sizes matchData.posts. */
export const MAX_POST_COUNT = 4;
/** Forward post kinds: an army's home post (near its Spire) or a contested point (DESIGN §4.2 Outposts). */
export const POST_KINDS = ['home', 'contested'];
/** Most contested points a map may hold (expanded over its slots); sizes matchData.posts. */
export const MAX_CONTESTED_POSTS = 9;
/** Most unit ids one intent may name (`units` list cap). */
export const UNITS_PER_INTENT = 64;
/**
 * Most intents one policy call answers (PolicyLimits.maxIntentsPerCall): the host drops the rest of a policy's or bot
 * package's answer, so a built-in bot answers at most this many in-process too (its `createBot` fallback then plays
 * exactly as its package).
 */
export const INTENTS_PER_CALL = 32;
/** Most units a team signal's support request may name in `count`. */
export const SUPPORT_COUNT_MAX = 24;
export const KINDS = [...UNIT_KINDS, ...STRUCTURE_KINDS, ...NEUTRAL_KINDS];
/** Surface structures placed by integer min-cell anchor; a Headframe snaps to its known lode pocket. */
export const BUILDABLE = ['shaft', 'turret', 'mooring_tower', 'headframe', 'drill_yard'];

export const UPGRADE_IDS = ['ascent_thrusters', 'aegis_projectors', 'night_cloak', 'lancer_lens', 'drill_bits', 'shaped_charges'];

/**
 * Team build queue (DESIGN §5): units use their plane's Spire segment or an explicit forward Aerie, one at a time
 * per producer. Surface structures use their cell, island structures share one held-island slot, and a digger builds
 * each bulkhead. Research shares funding order, with one independent slot per segment. `rebuild` raises a fallen
 * Spire segment again (its plane given when queued; rules.spire.rebuild*).
 */
export const QUEUE_ITEMS = [...PRODUCED_UNITS, 'shaft', 'turret', 'mooring_tower', ...ISLAND_BUILDS, 'headframe', 'bulkhead', 'geothermal', 'drill_yard', ...UPGRADE_IDS, 'rebuild'];
/** Most entries a team queue can hold (observation list size); `rules.queue.teamMax` is at most this. */
export const QUEUE_LIST = 40;
/** waiting: not started yet (see reason); building: paid and in progress; blocked: cannot start now (see reason). */
export const QUEUE_STATUSES = ['waiting', 'building', 'blocked'];
/**
 * Why an entry is not building. Waiting: `funds` (this lane's next commitment, saving alloy/energy), `lane` (behind
 * its lane's next commitment; it still starts at once whenever free stock pays its whole cost), `producer` (the
 * producer is busy, lost or unpowered).
 * Blocked: `segment_destroyed`, `pop_cap`, `structure_cap` (rules.economy structure cap, or
 * rules.surface.drillYardMax Drill Yards already stand), `occupied` (site taken or
 * island slot filled), `blocked` (site became a hole, a bulkhead cell is no longer a plain tunnel,
 * or an Ore Extractor's deposit is exhausted / island hardpoints are disabled),
 * `not_held` (island lost), `no_builder` (bulkhead: no own digger free to build it, or its digger could not
 * reach the cell; retried shortly), `site_unseen` (a Surface site out of the team's sight: it starts once seen again,
 * so an unseen structure there is never revealed by the queue), `enemy_near` (a segment rebuild: an enemy unit your
 * army sees stands within rules.spire.rebuildClearance of the segment on its plane; a started rebuild pauses).
 * Invalid work releases backing; temporary blocks retain existing backing for rules.queue.blockedGrace seconds,
 * while a living unpowered producer retains its saved commitment. Blocked work receives no further allocation.
 */
export const QUEUE_REASONS = ['funds', 'producer', 'segment_destroyed', 'pop_cap', 'structure_cap', 'occupied', 'blocked', 'not_held', 'no_builder', 'site_unseen', 'enemy_near', 'lane'];

/**
 * How an army is eliminated (match rule `spire.lossRule`, DESIGN §2): `surface` = its Surface segment falls; `crowns`
 * = each fallen segment costs crowns (Surface rules.spire.crownsSurface, every other segment crownsSide) and the army
 * is out at crownsToLose crowns lost. A rebuilt segment returns its crown.
 */
export const LOSS_RULES = ['surface', 'crowns'];

/** Surface terrain presets (match rule `terrain`; seeded, point-symmetric). */
export const TERRAIN_PRESETS = ['open', 'ridges', 'canyons', 'chokepoint', 'archipelago', 'fortress', 'rivers', 'highlands'];
export const isTerrainPreset = (v) => (TERRAIN_PRESETS).includes(v);
export const DEFAULT_TERRAIN = 'ridges';

export const STATES = [
  'idle',
  'moving',
  'attacking',
  'digging',
  'mining',
  'hauling',
  'returning',
  'fortifying',
  'undermining',
  'capturing',
  'grappling',
  'towing',
  'towed',
  'falling',
  'drifting',
  'contested',
  'constructing',
  'active',
  'breaching',
  'bridging',
  'laying',
  'hangared',
  'launching',
  /** Warden shield wall: deploying (cannot fire), braced (half damage, fires), undeploying (cannot fire) */
  'walling',
  'walled',
  'unwalling',
  /** Surface deploy stances (rules/deploy.ts), each deploying / deployed / packing; transitions cannot fire, none moves */
  'digging_in',
  'dug_in',
  'digging_out',
  'sieging',
  'sieged',
  'unsieging',
  'emplacing',
  'emplaced',
  'unemplacing',
  /** Orbit solar arrays (rules/deploy.ts): anchoring where they stop, anchored (producing), packing to move */
  'unfurling',
  'unfurled',
  'furling',
  /** a Trooper inside its team's Drill Yard becoming a Breacher (hidden from enemies, cannot act) */
  'converting',
];

/** Verbs and passives a unit may have; `drill_bits` (faster digging) and `shaped_charges` (shorter fuse, longer chasm) are passive. */
export const ABILITIES = ['scan', 'ascend', 'sun_lance', 'aegis', 'night_cloak', 'flare', 'drill_bits', 'shaped_charges'];

/** Unit stances: aggressive chases within a leash, defensive chases briefly and returns, hold never moves. */
export const UNIT_STANCES = ['aggressive', 'defensive', 'hold'];
/** `move` modes: fight (attack-move: engage enemies on the way) or move (ignore enemies). */
export const MOVE_MODES = ['move', 'fight'];
export const ORBIT_FORMATIONS = ['wedge', 'line', 'escort'];
