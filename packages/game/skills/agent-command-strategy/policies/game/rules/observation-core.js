// Agent Command's built-in bot library: packages/game/src/rules/observation-core.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * The observation's list sizes, value bounds and plane-detail guard, without its schemas: game code, built-in bots
 * and policies read observations through these, and observation.ts builds the schemas on them.
 */
import { ORDER_QUEUE } from './stats.js';
import { PLANES } from './vocabulary.js';

// List sizes and value bounds of the observation/view/report schemas. The presenter (agent/present.ts) clamps and
// slices to the same names, so a payload always validates.
/** Hit points reported per entity or Spire segment (hp and maxHp are clamped to this). */
export const HP_CAP = 100_000;
/** Ore carried / queued count reported per entity. */
export const CARRY_CAP = 1000;
/** Destinations of an own unit's queued orders after the current one (patrol adds its return leg). */
export const WAYPOINT_CAP = ORDER_QUEUE + 1;
/**
 * Presented positions are multiples of 1/OBS_GRID tile in observations (agents, policies, bots read them: at most
 * three decimals) and of 1/VIEW_GRID tile in views (clients and observers interpolate slow units smoothly), never on
 * a cell edge. Both are binary grids, so mirrored armies see exact rotations of each other's world, and floor names
 * the cell a position is in for every frame alike (util/math gridPosition).
 */
export const OBS_GRID = 8;
export const VIEW_GRID = 64;
/** Entities in one observation / one view. */
export const OBS_ENTITY_CAP = 600;
export const VIEW_ENTITY_CAP = 2000;
/** Events in one observation / one view. */
export const OBS_EVENT_CAP = 120;
export const VIEW_EVENT_CAP = 60;
/** Render effects in one view. */
export const VIEW_FX_CAP = 800;
/** Remembered enemy structures (ghosts) in one view. */
export const GHOST_CAP = 300;
/** Falling asteroids listed. */
export const IMPACT_CAP = 16;
/** Planted sapper charges listed. */
export const CHARGE_CAP = 32;
/** Warden flares listed. */
export const FLARE_CAP = 32;
/** Tremor cells listed. */
export const TREMOR_CAP = 64;
/** Upcoming timed world events listed. */
export const SCHEDULE_CAP = 32;
/** Largest `count` an alert or event carries (it saturates here). */
export const ALERT_COUNT_CAP = 64;
/** Cracked depths cells listed. */
export const CRACK_CAP = 512;
/** Visible ore caches / scorch hazards listed. */
export const ORE_CACHE_CAP = 2000;
export const SCORCH_CAP = 2000;
/** Key moments kept in the end-of-match report timeline. */
export const REPORT_TIMELINE_CAP = 200;
/** Own Shafts listed in a summarised Surface plane. */
export const SUMMARY_SHAFT_CAP = 16;
/** Own units in transit listed per summarised plane. */
export const SUMMARY_TRANSIT_CAP = 32;
/** Entities counted per kind and side class in a plane summary (a count saturates here). */
export const SUMMARY_COUNT_CAP = 100_000;

/** Narrows an observation (with or without the host's `signals`) rendered with every plane in full; throws otherwise. */
export function fullObservation(obs) {
  if (obs.detail.length !== PLANES.length) throw new Error('game code reads observations with every plane in full');
  return obs;
}
