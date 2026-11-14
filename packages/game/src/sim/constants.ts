/**
 * Simulation constants fixed by design rather than match rules: cadences, tolerances, search bounds, steering
 * internals and record layouts of the sim and its planes, grouped by system. Gameplay numbers are match rules (ECON).
 */
import { dmath } from '../util/fdlibm.js';
import { norm } from '../util/math.ts';
import { REPORT_TIMELINE_CAP } from '../rules/observation-core.ts';
import { STATS } from '../rules/stats.ts';
import { HOLE_KINDS } from '../rules/terrain.ts';
import { PLANES, TICK_RATE, toTicks } from '../rules/vocabulary.ts';
import type { Econ, EconNumber, HoleKind, Plane, UnitKind } from '../rules/contract.ts';

// Shared tables

/** Index of each plane in PLANES order: per-plane arrays and the state digest use it (never reorder PLANES). */
export const PLANE_INDEX = Object.fromEntries(PLANES.map((plane, i) => [plane, i])) as Readonly<Record<Plane, number>>;
/** Hole codes in `Sim.holes` (0 = none): index into HOLE_KINDS + 1. */
export const HOLE = Object.fromEntries(HOLE_KINDS.map((kind, i) => [kind, i + 1])) as Readonly<Record<HoleKind, number>>;
/** Broad-phase bound derived from the largest registry footprint, including its corners. */
export const MAX_BODY_RADIUS = Math.max(...Object.values(STATS).map((s) => s.footprint ? norm(s.footprint.w, s.footprint.h) / 2 : s.radius));
/** Side (tiles) of a spatial-index bucket. */
export const BUCKET = 4;
/** Tolerance (tiles) for exact-symmetry comparisons: float drift must not make mirrored units arrive a tick apart. */
export const SNAP_EPS = 1e-6;

// Match start

/**
 * Start unit kinds in spawn order (spawn order fixes entity ids) and the rule giving each count; every kind spawns at
 * its Spire segment, so every plane has something to do from the first minute.
 */
export const START_UNITS: readonly (readonly [UnitKind, EconNumber])[] = [
  ['digger', 'startDiggers'],
  ['trooper', 'startTroopers'],
  ['tank', 'startTanks'],
  ['interceptor', 'startInterceptors'],
  ['solar', 'startSolars'],
  ['tug', 'startTugs'],
];

// Spawning and slots

/** Hexagonal circle-packing density: the disc a group's slots fill, from their total slot area. */
export const HEX_PACKING = Math.PI / (2 * Math.sqrt(3));
/** Ring lattice search bound for a free slot (rings of the unit's own slot size around the point). */
export const MAX_SLOT_RINGS = 12;
/** Points on ring k of the hexagonal slot lattice: HEX_RING * k. */
export const HEX_RING = 6;
/**
 * Unit bearings of the slot lattice's ring points, (cos, sin) of 2π·j / (HEX_RING·k) interleaved: ring k (1 to
 * MAX_SLOT_RINGS) starts at HEX_RING·k·(k − 1), point j two entries further each. Slot searches read it rather than
 * calling trig per candidate; the same `dmath` values, so slots land bit-identically.
 */
export const SLOT_RING_DIRS: Float64Array = (() => {
  const dirs = new Float64Array(HEX_RING * MAX_SLOT_RINGS * (MAX_SLOT_RINGS + 1));
  for (let k = 1; k <= MAX_SLOT_RINGS; k++) {
    for (let j = 0; j < HEX_RING * k; j++) {
      const a = (2 * Math.PI * j) / (HEX_RING * k);
      dirs[HEX_RING * k * (k - 1) + 2 * j] = dmath.cos(a);
      dirs[HEX_RING * k * (k - 1) + 2 * j + 1] = dmath.sin(a);
    }
  }
  return dirs;
})();
/**
 * Hold zones (Sky islands, Surface forward posts) are never damaged (no weapon or impact targets them; captures take
 * them), so their hit points are a fixed placeholder for the entity record, not a match rule.
 */
export const HOLD_ZONE_HP = 1;

// Vision

/** Ticks between vision/fog refreshes. */
export const VISION_EVERY = 2;
/** Ticks an enemy sapper must stay unseen before seeing it again raises another `enemy_sapper_seen` event. */
export const SAPPER_REALERT = toTicks(10);
/** Ticks without intruders near home before new ones raise another `intruder` event (the alert itself is live). */
export const INTRUDER_REALERT = toTicks(10);
/** Every this many ticks, sappers no longer alive are dropped from the sighting memory. */
export const SAPPER_PRUNE_EVERY = toTicks(60);

// Kinematics and avoidance

/** Arrival: a unit this close to its point (and this slow) settles exactly on it. */
export const ARRIVE_EPS = 1e-3;
/**
 * Settle deadband (tiles): a unit this close to a still point, slow enough to stop within a tick, is placed on it and
 * stops, instead of creeping the last fraction of a tile (and circling it, if it turns slowly) for seconds.
 */
export const ARRIVE_SETTLE = 0.02;
/** A fleet waypoint brakes for its goal at this share of its slowest member's thrust (members keep the rest in hand). */
export const FLEET_BRAKE_SHARE = 0.5;
/** Arrival braking without a turn rate: close at most this fraction of the remaining distance per tick. */
export const ARRIVE_APPROACH = 0.5;
/** ORCA time horizon (ticks): bodies avoid collisions this far ahead. */
export const ORCA_TAU = 5;
/** Share of the avoidance a moving unit takes against another moving unit (it avoids back); bodies at rest take none. */
export const ORCA_SHARE = 0.5;
/** Fraction of the way the smoothed avoidance bend moves toward each tick's ORCA answer (damps reciprocal back-and-forth). */
export const AVOID_SMOOTH = 0.25;
/** Velocity change cap per tick on the open planes (non-Orbit): at least this fraction of the acceleration… */
export const TURN_MIN_ACCEL = 0.35;
/** …or this fraction of the current speed, whichever is larger (lets fast units turn). */
export const TURN_SPEED_SHARE = 0.55;
/** Boxed in: avoidance (or the guards after it) leaves less than this fraction of the wanted speed. */
export const STUCK_FRACTION = 0.1;
/** A unit boxed in this many ticks detours sideways for BYPASS_TICKS. */
export const STUCK_TICKS = toTicks(1);
/** Ticks of a sideways detour once boxed in. */
export const BYPASS_TICKS = toTicks(1);
/** A boxed-in unit touching (within CONTACT tiles of) own idle units first shoves through them for SHOVE_TICKS. */
export const SHOVE_TICKS = toTicks(1.5);
/** Contact distance (tiles) for SHOVE_TICKS. */
export const CONTACT = 0.1;
/** Steering: a unit within this many of its own radii of an occupied spot, slowed down, has arrived beside it. */
export const CROWD_RADII = 3;
/** Arrival watchdog: a unit within CROWD_ARRIVE tiles of its point that gained less than PROGRESS tiles on it in STALL_TICKS has arrived. */
export const CROWD_ARRIVE = 3;
/** Arrival watchdog headway (tiles), see CROWD_ARRIVE. */
export const PROGRESS = 0.25;
/** Arrival watchdog window (ticks), see CROWD_ARRIVE. */
export const STALL_TICKS = toTicks(1.5);

// Separation

/** Max separation push per tick (tiles). */
export const MAX_PUSH = 3 / TICK_RATE;
/** Overlaps shallower than this (tiles) are left alone, so settled groups stay perfectly still. */
export const SEP_DEADBAND = 0.05;
/** Two units stop short of the deadband by this fraction of it each (a structure contact by all of it). */
export const SEP_UNIT_DEADBAND = 0.5;
/** Fraction of an overlap corrected per tick (damping: clusters converge instead of oscillating). */
export const SEP_DAMP = 0.8;
/** A moving unit's share against a resting one (the resting one makes way). */
export const SEP_SHARE_MOVER = 0.25;
/** A resting unit's share against a moving one. */
export const SEP_SHARE_RESTING = 0.75;
/** Extra push (tiles) ejecting a body found inside a new structure's footprint past the nearest face. */
export const SITE_EJECT = 1;
/** Exactly coincident pair: push bearing (whole degrees) = (lower serial * SEP_TIE_PRIME_LO + higher * SEP_TIE_PRIME_HI) mod SEP_TIE_DEGREES. */
export const SEP_TIE_PRIME_LO = 7919;
/** See SEP_TIE_PRIME_LO. */
export const SEP_TIE_PRIME_HI = 104729;
/** See SEP_TIE_PRIME_LO (degrees per turn). */
export const SEP_TIE_DEGREES = 360;
/** A moving unit is pushed sideways instead of back unless the overlap (tiles) is at least this deep. */
export const NUDGE_DEEP = 0.25;
/** Depths separation keeps a unit within its own cell, at least this far (tiles) from its low edges… */
export const DEPTHS_CELL_MIN = 0.15;
/** …and no further than this from them (two literals: 1 - 0.15 is not exactly 0.85 in floating point). */
export const DEPTHS_CELL_MAX = 0.85;

// Navigation

/** `Ent.navGoal` with no plan (cells are ≥ 0). */
export const GOAL_NONE = -1;
/** `Ent.navGoal` while a depths path leads beside a cell rather than into it (planBeside). */
export const GOAL_BESIDE = -2;
/** `Ent.navGoal` while a digger hauls its load to a drop-off. */
export const GOAL_HAUL = -3;
/** `Ent.navGoal` while a unit heads down its attack target's firing field. Same value as GOAL_HAUL: a hauling digger never attacks. */
export const GOAL_FIRING = -3;
/** `Ent.navGoal` while a digger walks to ore (or explores for it). */
export const GOAL_ORE = -4;
/** Navigation step result (navTo, approach, followDepths): still under way this tick. */
export const NAV_MOVING = 0;
/** Navigation step result: at the destination (path finished, point reached, in firing position). */
export const NAV_ARRIVED = 1;
/** Navigation step result: no way there (no path, unreachable or blocked); the caller re-plans or gives up. */
export const NAV_BLOCKED = 2;
/** followDepths only: the next path cell is the caller's stop cell (e.g. the ore being mined). */
export const NAV_AT_STOP = 3;
/** A surface/open-plane navigation step result. */
export type NavStep = typeof NAV_MOVING | typeof NAV_ARRIVED | typeof NAV_BLOCKED;
/** A depths path-following step result. */
export type DepthsStep = NavStep | typeof NAV_AT_STOP;
/**
 * `Ent.deploy`: deploy stance phases (rules/deploy.ts: shield wall, dug in, siege, emplaced). Deploying and packing
 * cannot fire; no phase moves; up is the deployed stance.
 */
export const DEPLOY_NONE = 0;
export const DEPLOY_DEPLOYING = 1;
export const DEPLOY_UP = 2;
export const DEPLOY_PACKING = 3;
/** Depths sight lines: a line-parameter difference below this passes exactly through a cell corner. */
export const SIGHT_EPS = 1e-9;
/** Surface paths: flow-field cells looked ahead for the farthest visible waypoint. */
export const NAV_LOOKAHEAD = 10;
/** Surface paths: ticks between waypoint replans. */
export const NAV_REPLAN = 8;
/** A surface waypoint this close (tiles) counts as reached: plan the next one. */
export const WAYPOINT_REACH = 0.5;
/** Firing fields key reach (range + target radius + siege) in 1/FIRING_REACH_STEPS tiles. */
export const FIRING_REACH_STEPS = 16;
/** Firing field cache key: anchor * FIRING_KEY_STRIDE + quantized reach (reach stays below it). */
export const FIRING_KEY_STRIDE = 4096;

// Combat

/** Tiles inside max range a unit closes to before it starts firing (so a drifting target stays in range). */
export const RANGE_MARGIN = 0.3;
/** Ticks a planted unit keeps its firing spot after losing the line of fire before it moves to get it back. */
export const LOS_GRACE = toTicks(0.5);
/** Target search reaches this many tiles past the acquisition radius (bodies are measured to their edge). */
export const ACQUIRE_SEARCH_MARGIN = 1.5;
/** Target priority added to distance for a non-threatening unit (threats rank 0: they are shot first). */
export const TARGET_RANK_UNIT = 100;
/** Target priority added to distance for a non-threatening structure (after every unit). */
export const TARGET_RANK_STRUCTURE = 200;
/** A damaged Spire segment raises `spire_damaged` at most once per this many ticks. */
export const SPIRE_ALERT_EVERY = toTicks(5);

// Orders

/** Rail layers count as on a cell centre within this distance (tiles). */
export const CENTRED_EPS = 0.05;
/**
 * Storm evade: bearings tried around a damaging storm, as (cos, sin) pairs: straight out from its centre first, then
 * turned ±30°, ±60°, ±90° (the first clear one nearest the aircraft wins).
 */
export const STORM_EVADE_TURNS: readonly (readonly [number, number])[] = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2]
  .map((a) => [dmath.cos(a), dmath.sin(a)] as const);

// Depths

/** Breakout: troopers climb out onto the nearest open surface cell within this radius (tiles) of the rules' breakoutOffset point; none → they stay below. */
export const BREAKOUT_SEARCH = 3;

// Plane transits

/** Emerging from the depths: a unit lands on the nearest open surface cell within this radius (tiles) of the rules' emergeOffset point; none → the transit fails. */
export const EMERGE_SEARCH = 4;

// Orbit

/** `Sim.orbitSpawnBounds` entries per spawn region: min x, max x, min y, max y. */
export const REGION_BOUNDS = 4;

// Weather (planes/weather.ts)

/** Below this speed (tiles/tick, ~0.2 tiles/s) a unit is holding station: wind is neutral. */
export const WIND_MIN_SPEED = 0.01;
/** Steps per tile of the binary grid jet-lane rows sit on. */
export const LANE_GRID = 1024;
/** Natural storm orbits (rules.sky.stormSets is at most this): each orbit holds one storm per map slot. */
export const STORM_SETS = 2;
/** Seed salts of the per-orbit random streams, one per orbit (ASCII "STOR", "MCLD"). */
export const PAIR_SALTS: readonly number[] = [0x53544f52, 0x4d434c44];
/** Seeded storm slots: one per island structure slot; storm mask bits above the natural storms'. */
export const SEEDED_STORMS = 16;
/** Fog banks: bank 0's starting phase (rad) on its circular path… */
export const FOG_PHASE = Math.PI / 2;
/** …and direction of travel (-1: decreasing bearing). */
export const FOG_DIRECTION = -1;

// Events, effects and bookkeeping

/** Effects are kept for this many ticks (views carry the recent window; clients dedupe by tick). */
export const FX_WINDOW = toTicks(0.5);
/** Timeline entries a team keeps (oldest dropped first): what a report can carry. */
export const TIMELINE_CAP = REPORT_TIMELINE_CAP;
/** A team keeps at least this many recent events; the list is trimmed back to it once it holds twice as many. */
export const EVENT_RETAIN = 1000;
/** Initial length of the per-entity scratch arrays (spatial index, separation, held-back moves); they grow on demand. */
export const SCRATCH_ENTS = 1024;
/** Length of the rolling income window (seconds) behind income rates. */
export const INCOME_WINDOW_S = 10;
/** A tick long before the match started: "never happened" for throttles that compare against the last time. */
export const LONG_AGO = -1e9;

// Accounting ledger (`TeamState.accounting`): blocks of ACCOUNT_BLOCK slots, alloy at an entry's offset and energy
// right after it. Block 0 holds the team totals; block 1 + PLANE_INDEX[p] what plane p's seat caused.

/** Offset of income (alloy; energy at +1) in a ledger block. */
export const ACCOUNT_INCOME = 0;
/** Offset of spending (alloy; energy at +1) in a ledger block. */
export const ACCOUNT_SPEND = 2;
/** Offset of refunds (alloy; energy at +1) in a ledger block. */
export const ACCOUNT_REFUND = 4;
/** Slots per ledger block: income, spend and refund, each alloy + energy. */
export const ACCOUNT_BLOCK = 6;
/** Ledger length: the totals block plus one block per plane seat. */
export const ACCOUNT_SLOTS = ACCOUNT_BLOCK * (1 + PLANES.length);
/** A ledger entry kind (its offset in a block). */
export type AccountOffset = typeof ACCOUNT_INCOME | typeof ACCOUNT_SPEND | typeof ACCOUNT_REFUND;

// State digest packing (sim/digest.ts): small per-cell fields share one mixed number; the weights keep them apart.

/** Cell code (CELL) weight in the packed per-cell digest value: holes and owner fit below it. */
export const DIGEST_CELL_KIND = 16;
/** Hole code weight in the packed per-cell digest value (owner codes 0-2 fit below it). */
export const DIGEST_CELL_HOLE = 4;
/** Gate bits weight in the packed per-cell digest value. */
export const DIGEST_CELL_GATE = 1024;
/** Fortification count weight in the packed per-cell digest value. */
export const DIGEST_CELL_TOUGH = 4096;
/** Separates a key from a small value mixed into the same number (cell index above dig work, lode open flag above loads). */
export const DIGEST_HIGH = 65536;
