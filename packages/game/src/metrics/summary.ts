/** Pure per-match balance metrics, shared by the native metrics hook and its consumers. */
import { PLANES, toTicks, type ArmyId, type EventKind, type Kind, type Plane } from '../rules/contract.ts';
import { REC, type MatchTrace, type RecKind, type SapperMetrics, type SpireDamage, type TraceEvent } from './trace.ts';

/** A record with one value per plane, built in PLANES order (allocates: per match or sample, never per tick). */
export function perPlane<T>(make: (plane: Plane) => T): Record<Plane, T> {
  const out = {} as Record<Plane, T>;
  for (const plane of PLANES) out[plane] = make(plane);
  return out;
}
const bump = (rec: Record<string, number>, key: string, n = 1): void => {
  rec[key] = (rec[key] ?? 0) + n;
};

// ---------------------------------------------------------------- pillar 4: meaningful actions

/** Pillar 4 window: actions in the first 60 game seconds. */
const FIRST_WINDOW = toTicks(60);

/**
 * Meaningful actions and the plane they are an action of (`own`: the event's plane). Credited to the event's side;
 * defuses to the defusing army (the event's `killer`; its side is the charge owner); kills to the killer, on the
 * victim's plane (a fight there). Passive work (production, digging, idle drift) is not an action.
 */
const ACTION_PLANE: Readonly<Partial<Record<string, Plane | 'own'>>> = {
  [REC.deliver]: 'depths',
  charge_planted: 'depths',
  charge_defused: 'depths',
  tunnel_breach: 'depths',
  breach_opened: 'depths',
  chasm_opened: 'depths',
  hole_bridged: 'depths',
  constructed: 'own',
  [REC.transfer]: 'own',
  island_captured: 'sky',
  post_captured: 'surface',
  asteroid_intercepted: 'sky',
  [REC.grapple]: 'orbit',
  impact_incoming: 'orbit',
  [REC.scan]: 'orbit',
} satisfies Partial<Record<EventKind | RecKind, Plane | 'own'>>;

/** The plane and army an event counts as a meaningful action for, if it is one. */
export function actionOf(e: TraceEvent): { plane: Plane; side: ArmyId } | undefined {
  if (e.k === REC.kill) return e.killer && e.killer !== e.side ? { plane: e.plane, side: e.killer } : undefined;
  const action = ACTION_PLANE[e.k];
  if (!action) return undefined;
  const plane = action === 'own' ? e.plane : action;
  if (e.k === 'charge_defused') return e.killer ? { plane, side: e.killer } : undefined;
  return e.side === 'neutral' ? undefined : { plane, side: e.side };
}

// ---------------------------------------------------------------- cross-plane interactions

/** Killers whose sky kills count as ground-to-air defence (`by` is an open kind/cause string). */
const AIR_DEFENCE: Readonly<Partial<Record<string, true>>> = { flak: true, turret: true, spire: true } satisfies Partial<Record<Kind, true>>;
const isKill = (e: TraceEvent): boolean => e.k === REC.kill;

/** Cross-plane interactions counted per match (from game events, recorder kinds and attributed kills). */
export const CROSS: readonly { key: string; label: string; match: (e: TraceEvent) => boolean }[] = [
  { key: 'collapse', label: 'Collapses (Depths → Surface)', match: (e) => e.k === 'collapse' },
  { key: 'chasm', label: 'Chasms opened (Depths → Surface)', match: (e) => e.k === 'chasm_opened' },
  { key: 'breach', label: 'Troop breaches (Depths → Surface)', match: (e) => e.k === 'breach_opened' },
  { key: 'tunnel_breach', label: 'Enemy tunnels broken into (Depths)', match: (e) => e.k === 'tunnel_breach' },
  { key: 'fell', label: 'Units fallen into the Depths', match: (e) => e.k === 'fell_into_depths' },
  { key: 'transfer', label: 'Portal transfers (Surface ↔ Depths)', match: (e) => e.k === REC.transfer },
  { key: 'defuse', label: 'Charges defused', match: (e) => e.k === 'charge_defused' },
  { key: 'impact', label: 'Asteroid impacts (Orbit → Surface)', match: (e) => e.k === 'impact' },
  { key: 'intercept', label: 'Asteroids intercepted (Sky vs Orbit)', match: (e) => e.k === 'asteroid_intercepted' },
  { key: 'scan', label: 'Orbital scans (Orbit → all)', match: (e) => e.k === REC.scan },
  { key: 'flak_sky', label: 'Air kills by flak (Surface → Sky)', match: (e) => isKill(e) && e.plane === 'sky' && e.by === 'flak' },
  { key: 'ground_air', label: 'Air kills from the Surface (flak, turrets, Spire)', match: (e) => isKill(e) && e.plane === 'sky' && AIR_DEFENCE[e.by ?? ''] === true },
  { key: 'bomber', label: 'Bomber kills (Sky → Surface)', match: (e) => isKill(e) && e.by === 'bomber' },
  { key: 'bridge', label: 'Hole cells backfilled (Depths → Surface)', match: (e) => e.k === 'hole_bridged' },
  { key: 'magma', label: 'Magma floods (Depths)', match: (e) => e.k === 'magma_flood' },
  { key: 'troops_down', label: 'Depths kills by troopers (Surface → Depths)', match: (e) => isKill(e) && e.plane === 'depths' && e.by === 'trooper' },
  { key: 'collapse_kills', label: 'Kills by collapses', match: (e) => isKill(e) && e.by === 'collapse' },
  { key: 'impact_kills', label: 'Kills by impacts', match: (e) => isKill(e) && e.by === 'impact' },
];

/** Per-army measurement rows: one per army of the match. */
export type PerArmy<T> = Partial<Record<ArmyId, T>>;

export interface MatchMeasurements {
  lodes?: MatchTrace['lodes'];
  ticks: number;
  /** the match's armies, in army order */
  armies: ArmyId[];
  /** units alive per army and plane, by sample minute (only minutes the match reached) */
  units: Record<string, PerArmy<Record<Plane, number>>>;
  /** pillar 4: meaningful actions per army and plane in the first 60 s */
  firstMinute: PerArmy<Record<Plane, number>>;
  /** CROSS key → count */
  cross: Record<string, number>;
  /** units produced per army and kind */
  produced: PerArmy<Record<string, number>>;
  /** structures completed per army and kind */
  built: PerArmy<Record<string, number>>;
  /** kills per killing army and killer kind / cause */
  kills: PerArmy<Record<string, number>>;
  /** named deaths without an enemy killer (environment or friendly effects), by cause */
  environmental: Record<string, number>;
  /** deaths without a known damage source */
  unattributed: number;
  /** every trace kind → count (forward-compatible raw tally) */
  kinds: Record<string, number>;
  /** Spire HP lost per victim army and segment, by plane of origin and by cause */
  spireDamage: PerArmy<Record<Plane, SpireDamage>>;
  /** undermine intents and charge outcomes per army */
  sappers: PerArmy<SapperMetrics>;
}

/** A row per army of the match (allocates: per match, never per tick). */
export function perArmy<T>(armies: readonly ArmyId[], make: (army: ArmyId) => T): PerArmy<T> {
  const out: PerArmy<T> = {};
  for (const army of armies) out[army] = make(army);
  return out;
}

export function summarize<T extends object>(trace: MatchTrace, meta: T): T & MatchMeasurements {
  const armies = trace.armies;
  const firstMinute = perArmy(armies, () => perPlane(() => 0));
  const cross: Record<string, number> = Object.fromEntries(CROSS.map((c) => [c.key, 0]));
  const produced = perArmy(armies, (): Record<string, number> => ({}));
  const built = perArmy(armies, (): Record<string, number> => ({}));
  const kills = perArmy(armies, (): Record<string, number> => ({}));
  const environmental: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  let unattributed = 0;
  for (const e of trace.events) {
    bump(kinds, e.k);
    if (e.t <= FIRST_WINDOW) {
      const a = actionOf(e);
      if (a) firstMinute[a.side]![a.plane]++;
    }
    for (const c of CROSS) if (c.match(e)) cross[c.key]!++;
    if (e.side !== 'neutral' && e.subject) {
      if (e.k === 'produced') bump(produced[e.side]!, e.subject);
      else if (e.k === 'constructed') bump(built[e.side]!, e.subject);
    }
    if (e.k === REC.kill) {
      if (e.killer && e.killer !== e.side) bump(kills[e.killer]!, e.by ?? 'unknown');
      else if (!e.by || e.by === 'unknown') unattributed++;
      else bump(environmental, e.by);
    }
  }
  const units = Object.fromEntries(trace.samples.map((s) => [String(s.minute), s.units]));
  return { ...meta, ticks: trace.ticks, armies: [...armies], units, firstMinute, cross, produced, built, kills, environmental, unattributed, kinds, spireDamage: trace.spireDamage, sappers: trace.sappers, ...(trace.lodes ? { lodes: trace.lodes } : {}) };
}
