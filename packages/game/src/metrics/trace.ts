/**
 * The normalized record of one match that every metric is computed from. The recorder (record.ts) derives it from
 * the authoritative sim; tests build it by hand. Kinds are open strings: game event kinds keep their names (new
 * kinds flow through and are counted), plus the recorder's own kinds below.
 */
import { PLANES, type ArmyId, type Plane, type Side } from '../rules/contract.ts';
import type { LodeMetrics } from './lodes.ts';

export interface TraceEvent {
  /** tick */
  t: number;
  /** game event kind (`collapse`, `island_captured`, …), a recorder kind (`kill`, `scan`, …) or `fx:<kind>` */
  k: string;
  plane: Plane;
  /** the acting side (kill: the victim's side; charge_defused: the charge owner, as in the game event) */
  side: Side;
  /** unit/structure kind involved (kill: the victim) */
  subject?: string;
  /** kill: authoritative killer kind or named cause (impact, collapse, capture, storm, flood, fall, burial, scorch, eliminated); unknown only if unavailable */
  by?: string;
  /** kill: the causing army, including friendly/self effects when known; charge_defused: the defusing army; army_eliminated: the hostile army that dealt the killing blow */
  killer?: ArmyId;
  /** transfer: destination plane */
  to?: Plane;
  /** Production requesting seat, or attacker's actual plane at the damage event. */
  role?: Plane;
  attackerPlane?: Plane;
  attackerKind?: string;
  alloyValue?: number;
  energyValue?: number;
  x?: number;
  y?: number;
  ownerRole?: Plane;
  entry?: string;
  index?: number;
  from?: number;
}

/** Recorder kinds (not game event names). */
export const REC = {
  /** a unit or structure died (from the `death` fx, attributed to a shot or an area effect) */
  kill: 'kill',
  /** orbital scan (fx) */
  scan: 'scan',
  /** ore load delivered (fx) */
  deliver: 'deliver',
  /** voluntary plane transfer through a portal (fx, falls excluded) */
  transfer: 'transfer',
  /** a tug latched onto an asteroid (state change) */
  grapple: 'grapple',
  /** depths cell dug (fx) */
  dig: 'dig',
} as const;
export type RecKind = (typeof REC)[keyof typeof REC];

export interface UnitSample {
  minute: number;
  /** live units per plane, per army of the match */
  units: Partial<Record<ArmyId, Record<Plane, number>>>;
}

/** Planes damage is dealt from, plus `none` for sources without one (storms, floods, falls, scorch, burial). */
export const DAMAGE_ORIGINS = [...PLANES, 'none'] as const;
export type DamageOrigin = (typeof DAMAGE_ORIGINS)[number];

/** Spire HP actually lost by one segment (overkill excluded): by the plane the damage came from, and by cause. */
export interface SpireDamage {
  from: Record<DamageOrigin, number>;
  /** cause → HP: the killer kind for weapons, or a named cause (`impact`, `collapse`, `sun_lance`, …) */
  by: Record<string, number>;
}

/**
 * One army's undermine intents and the fate of its charges. A charge goes off as a collapse or, on an unopened fault
 * cell, a chasm; either is a `hit` when it took HP from a hostile structure (Surface, or a blown bulkhead).
 */
export interface SapperMetrics {
  /** undermine intents accepted */
  ordered: number;
  /** undermine intents rejected for want of a tunnel: the cell is not a known tunnel, or no known tunnel reaches it */
  noTunnel: number;
  /** undermine intents rejected for any other reason */
  rejected: number;
  planted: number;
  /** planted charges defused by a hostile army */
  defused: number;
  /** charges that went off without damaging a hostile structure */
  dud: number;
  /** charges that damaged at least one hostile structure */
  hit: number;
  /** HP the charges took from hostile structures */
  damage: number;
  /** undermine intents aimed at an unopened fault cell (a chasm attempt), accepted */
  chasmOrdered: number;
  /** chasm attempts rejected */
  chasmRejected: number;
}
export const SAPPER_FIELDS = ['ordered', 'noTunnel', 'rejected', 'planted', 'defused', 'dud', 'hit', 'damage', 'chasmOrdered', 'chasmRejected'] as const satisfies readonly (keyof SapperMetrics)[];

export interface MatchTrace {
  ticks: number;
  /** the match's armies, in army order */
  armies: ArmyId[];
  events: TraceEvent[];
  samples: UnitSample[];
  /** per victim army and segment */
  spireDamage: Partial<Record<ArmyId, Record<Plane, SpireDamage>>>;
  /** per army that ordered or planted the charges */
  sappers: Partial<Record<ArmyId, SapperMetrics>>;
  lodes?: LodeMetrics;
}
