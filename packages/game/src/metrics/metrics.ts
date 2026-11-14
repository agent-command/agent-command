/** Native deterministic measurements. Numeric maps are the game-neutral benchmark boundary. */
import type { GameMetricRecorder, GameMetrics } from 'playerthree';
import type { CauseRow, IntentRow, MetricRow, ResultRows, TimelineEvent } from 'playerthree/arena';
import { ARMIES, EVENT_KINDS, FX_KINDS, KINDS, PLANES, TICK_RATE, isPlane, viewSchema, type ArmyId, type Plane } from '../rules/contract.ts';
import { ACCOUNT_BLOCK } from '../sim/constants.ts';
import { isArmyId } from '../util/teams.ts';
import { Recorder, UNIT_SAMPLE_MINUTES, type MeasuredGame } from './record.ts';
import { CROSS, perArmy, perPlane, summarize, type MatchMeasurements } from './summary.ts';
import type { LodeSideMetrics } from './lodes.ts';
import { forces } from '../agent/present.ts';
import { DAMAGE_ORIGINS, REC, SAPPER_FIELDS, type DamageOrigin, type SapperMetrics } from './trace.ts';

/** Longest intent `source` / rejection `code` accepted in accounting (also the event data schema bounds). */
const INTENT_SOURCE_MAX = 64;
const INTENT_CODE_MAX = 128;
/** Distinct team/role/source/code buckets one match may produce before accounting is considered unbounded input. */
const INTENT_BUCKET_CAP = 2048;

/** One intent attempt as the PlayerThree host reports it (seat strings are validated against the match's armies/PLANES here). */
export interface IntentAccounting {
  team: string; role: string; source: string; code: string; accepted: boolean;
}
export interface NativeRows {
  metrics: Omit<MetricRow, 'matchId'>[];
  causes: Omit<CauseRow, 'matchId'>[];
  events: Omit<TimelineEvent, 'matchId'>[];
  intents: Omit<IntentRow, 'matchId'>[];
}
export interface ArenaMetricRecorder extends GameMetricRecorder {
  drain(): NativeRows;
  rows(matchId: string): Partial<ResultRows>;
  intent(row: IntentAccounting): void;
}

export interface MetricDefinition {
  metric: string; scope: 'match' | 'side' | 'seat'; unit: string;
  interpretation: 'stock' | 'cumulative' | 'rate' | 'configuration';
}
/** One ledger block's slots in order (ACCOUNT_INCOME/SPEND/REFUND offsets, alloy then energy): index = slot in a block. */
const ECONOMY_KEYS = ['income.alloy', 'income.energy', 'spend.alloy', 'spend.energy', 'refund.alloy', 'refund.energy'] as const;
const RECORDED_EVENT_KINDS = [...new Set([...EVENT_KINDS, ...Object.values(REC), ...FX_KINDS.map((kind) => `fx:${kind}`)])];
/**
 * Every `lastHitCause` the sim sets: killer kinds plus named causes (`eliminated`: removed with its fallen army in a
 * match that goes on; `dismantle`: an own structure deliberately destroyed by its army).
 */
const DAMAGE_CAUSES = [...KINDS, 'unknown', 'sun_lance', 'impact', 'volatile_detonation', 'collapse', 'capture', 'storm', 'flood', 'eruption', 'fall', 'burial', 'scorch', 'eliminated', 'dismantle', 'radiation', 'core_drop', 'core_meltdown', 'core_vent'] as const;
/** Closed descriptor vocabulary for raw samples, independent of labels or private controller IDs. */
export const metricDefinitions: readonly MetricDefinition[] = [
  { metric: 'sampling.everyTicks', scope: 'match', unit: 'ticks', interpretation: 'configuration' },
  { metric: 'clock.tickRate', scope: 'match', unit: 'ticks/second', interpretation: 'configuration' },
  ...(['alloy', 'energy'] as const).map((resource) => ({ metric: `economy.stock.${resource}`, scope: 'side' as const, unit: resource, interpretation: 'stock' as const })),
  ...ECONOMY_KEYS.flatMap((key) => ([
    { metric: `economy.${key}`, scope: 'side' as const, unit: key.endsWith('alloy') ? 'alloy' : 'energy', interpretation: 'cumulative' as const },
    { metric: `economy.attributed.${key}`, scope: 'seat' as const, unit: key.endsWith('alloy') ? 'alloy' : 'energy', interpretation: 'cumulative' as const },
  ])),
  ...PLANES.flatMap((plane) => ['units', 'alloy', 'energy', 'structures', 'structureAlloy', 'structureEnergy'].map((key) => ({
    metric: `army.${plane}.${key}`, scope: 'side' as const, unit: key === 'alloy' || key === 'structureAlloy' ? 'alloy' : key === 'energy' || key === 'structureEnergy' ? 'energy' : 'entities', interpretation: 'stock' as const,
  }))),
  ...['queued', 'building'].map((key) => ({ metric: `production.${key}`, scope: 'side' as const, unit: 'entries', interpretation: 'stock' as const })),
  { metric: 'production.units', scope: 'seat', unit: 'entities', interpretation: 'cumulative' },
  { metric: 'production.structures', scope: 'seat', unit: 'entities', interpretation: 'cumulative' },
  { metric: 'activeTicks', scope: 'seat', unit: 'ticks', interpretation: 'cumulative' },
  ...['submitted', 'accepted', 'rejected'].map((key) => ({ metric: `intents.${key}`, scope: 'seat' as const, unit: 'intents', interpretation: 'cumulative' as const })),
  { metric: 'commandApm', scope: 'seat', unit: 'commands/minute', interpretation: 'rate' },
  ...['ticks', 'minutes', 'unattributed'].map((metric) => ({ metric, scope: 'match' as const, unit: 'game', interpretation: 'cumulative' as const })),
  ...['capped', 'outcrops'].map((metric) => ({ metric, scope: 'match' as const, unit: 'game', interpretation: 'stock' as const })),
  ...CROSS.map(({ key }) => ({ metric: `cross.${key}`, scope: 'match' as const, unit: 'game', interpretation: 'cumulative' as const })),
  ...RECORDED_EVENT_KINDS.map((kind) => ({ metric: `kinds.${kind}`, scope: 'match' as const, unit: 'game', interpretation: 'cumulative' as const })),
  ...DAMAGE_CAUSES.map((cause) => ({ metric: `environmental.${cause}`, scope: 'match' as const, unit: 'game', interpretation: 'cumulative' as const })),
  ...Array.from({ length: viewSchema.fields.lodes.max }, (_, index) => index).flatMap((index) =>
    ['x', 'y', 'rich', 'flank', 'loads'].map((field) => ({ metric: `outcrop.${index}.${field}`, scope: 'match' as const, unit: 'game', interpretation: 'configuration' as const }))),
  { metric: 'spire', scope: 'side', unit: 'game', interpretation: 'stock' },
  ...PLANES.map((plane) => ({ metric: `firstMinute.${plane}`, scope: 'side' as const, unit: 'game', interpretation: 'cumulative' as const })),
  ...UNIT_SAMPLE_MINUTES.flatMap((minute) => PLANES.map((plane) => ({ metric: `units.${minute}.${plane}`, scope: 'side' as const, unit: 'game', interpretation: 'stock' as const }))),
  ...['produced', 'built'].flatMap((group) => KINDS.map((kind) => ({ metric: `${group}.${kind}`, scope: 'side' as const, unit: 'game', interpretation: 'cumulative' as const }))),
  ...DAMAGE_CAUSES.map((cause) => ({ metric: `kills.${cause}`, scope: 'side' as const, unit: 'game', interpretation: 'cumulative' as const })),
  // Spire HP lost by the side's segments: by plane of origin, and by cause.
  ...PLANES.flatMap((plane) => [
    ...DAMAGE_ORIGINS.map((origin) => ({ metric: `spireDamage.${plane}.from.${origin}`, scope: 'side' as const, unit: 'hp', interpretation: 'cumulative' as const })),
    ...DAMAGE_CAUSES.map((cause) => ({ metric: `spireDamage.${plane}.by.${cause}`, scope: 'side' as const, unit: 'hp', interpretation: 'cumulative' as const })),
  ]),
  ...SAPPER_FIELDS.map((field) => ({ metric: `sappers.${field}`, scope: 'side' as const, unit: 'game', interpretation: 'cumulative' as const })),
  ...(['earnedAlloy', 'lodeAlloy', 'headframesBuilt', 'headframesLost', 'flankBuilt', 'flankLost', 'flankSitesLost'] as const satisfies readonly (keyof LodeSideMetrics)[])
    .map((field) => ({ metric: `lodes.${field}`, scope: 'side' as const, unit: 'game', interpretation: 'cumulative' as const })),
];

const battlefieldEventData = {
  type: 'object',
  properties: {
    plane: { type: 'string', enum: PLANES },
    subject: { type: 'string', enum: KINDS },
    cause: { type: 'string', enum: DAMAGE_CAUSES },
    to: { type: 'string', enum: PLANES },
    x: { type: 'number', minimum: 0, maximum: 1000000 },
    y: { type: 'number', minimum: 0, maximum: 1000000 },
    ownerRole: { type: 'string', enum: PLANES },
    entry: { type: 'string', pattern: '^q_[0-9]+$', maxLength: 32 },
    index: { type: 'integer', minimum: 0, maximum: 1000 },
    from: { type: 'integer', minimum: 0, maximum: 1000 },
  },
  required: ['plane'], additionalProperties: false,
} as const;
/** JSON Schema descriptors cover the recorder allowlist, not private host/debug events. */
export const eventDefinitions = [
  ...RECORDED_EVENT_KINDS.map((kind) => ({ kind, dataSchema: battlefieldEventData })),
  {
    kind: 'intent_ack',
    dataSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', maxLength: INTENT_SOURCE_MAX }, code: { type: 'string', maxLength: INTENT_CODE_MAX }, accepted: { type: 'boolean' },
      },
      required: ['source', 'code', 'accepted'], additionalProperties: false,
    } as const,
  },
];

/** Collection stays native: no tool-package imports or dependencies on the benchmark runner. */
export function createMetrics(game: MeasuredGame, sampleEveryTicks = TICK_RATE): ArenaMetricRecorder {
  if (!Number.isInteger(sampleEveryTicks) || sampleEveryTicks < 1) throw new Error('invalid metric sample cadence');
  const recorder = new Recorder(game);
  let pending: NativeRows = { metrics: [], causes: [], events: [], intents: [] };
  let sequence = 0;
  let traceCursor = 0;
  let lastSample = -1;
  let sampleDirty = false;
  let lastCollected = game.tick;
  /** Per-seat counter slots: one per army × plane, army-major (slot = army × PLANES.length + plane index). */
  const SEATS = game.sim.allArmies.length * PLANES.length;
  const active = new Float64Array(SEATS);
  const accepted = new Float64Array(SEATS);
  const submitted = new Float64Array(SEATS);
  /** units produced in [0, SEATS), structures completed in [SEATS, 2 × SEATS) */
  const production = new Float64Array(2 * SEATS);
  const intentBuckets = new Map<string, Omit<IntentRow, 'matchId'>>();
  const metric = (team: ArmyId, role: Plane | null, name: string, value: number, unit: string) => {
    pending.metrics.push({ sequence: sequence++, tick: game.tick, scope: role === null ? 'side' : 'seat', team, role, metric: name, value, unit });
  };
  const sample = () => {
    if (lastSample === game.tick && !sampleDirty) return;
    sampleDirty = false;
    lastSample = game.tick;
    for (const side of game.sim.allArmies) {
      const team = game.sim.armyIds[side]!;
      const state = game.sim.armies[side]!;
      metric(team, null, 'economy.stock.alloy', state.alloy, 'alloy');
      metric(team, null, 'economy.stock.energy', state.energy, 'energy');
      for (const [index, name] of ECONOMY_KEYS.entries()) {
        metric(team, null, `economy.${name}`, state.accounting[index]!, index % 2 ? 'energy' : 'alloy');
        for (let p = 0; p < PLANES.length; p++) {
          metric(team, PLANES[p]!, `economy.attributed.${name}`, state.accounting[ACCOUNT_BLOCK + p * ACCOUNT_BLOCK + index]!, index % 2 ? 'energy' : 'alloy');
        }
      }
      metric(team, null, 'production.queued', state.queue.length, 'entries');
      metric(team, null, 'production.building', state.queue.reduce((n, entry) => n + Number(entry.started), 0), 'entries');
      for (const row of forces(game.sim, side)) {
        for (const key of ['units', 'alloy', 'energy', 'structures', 'structureAlloy', 'structureEnergy'] as const) {
          metric(team, null, `army.${row.plane}.${key}`, row[key], key === 'alloy' || key === 'structureAlloy' ? 'alloy' : key === 'energy' || key === 'structureEnergy' ? 'energy' : 'entities');
        }
      }
      for (let p = 0; p < PLANES.length; p++) {
        const slot = side * PLANES.length + p;
        const role = PLANES[p]!;
        metric(team, role, 'activeTicks', active[slot]!, 'ticks');
        metric(team, role, 'intents.submitted', submitted[slot]!, 'intents');
        metric(team, role, 'intents.accepted', accepted[slot]!, 'intents');
        metric(team, role, 'intents.rejected', submitted[slot]! - accepted[slot]!, 'intents');
        metric(team, role, 'production.units', production[slot]!, 'entities');
        metric(team, role, 'production.structures', production[SEATS + slot]!, 'entities');
        if (active[slot]! > 0) metric(team, role, 'commandApm', accepted[slot]! * TICK_RATE * 60 / active[slot]!, 'commands/minute');
      }
    }
  };
  const collect = () => {
    recorder.collect();
    const elapsed = game.tick - lastCollected;
    if (elapsed > 0) for (const side of game.sim.allArmies) {
      const state = game.sim.armies[side]!;
      for (let p = 0; p < PLANES.length; p++) if (state.seats[PLANES[p]!].controller !== 'none') active[side * PLANES.length + p]! += elapsed;
    }
    lastCollected = game.tick;
    const trace = recorder.trace();
    for (; traceCursor < trace.events.length; traceCursor++) {
      const event = trace.events[traceCursor]!;
      const team = event.side === 'neutral' ? null : event.side;
      pending.events.push({
        sequence: sequence++, tick: event.t, atMs: event.t * 1000 / TICK_RATE,
        kind: event.k, team, role: event.role ?? event.plane,
        data: {
          plane: event.plane, ...(event.subject ? { subject: event.subject } : {}),
          ...(event.by ? { cause: event.by } : {}), ...(event.to ? { to: event.to } : {}),
          ...(event.x === undefined ? {} : { x: event.x }), ...(event.y === undefined ? {} : { y: event.y }),
          ...(event.ownerRole ? { ownerRole: event.ownerRole } : {}), ...(event.entry ? { entry: event.entry } : {}),
          ...(event.index === undefined ? {} : { index: event.index }), ...(event.from === undefined ? {} : { from: event.from }),
        },
      });
      if (event.k === 'produced' && team) production[game.sim.armyIndex(team) * PLANES.length + PLANES.indexOf(event.role ?? event.plane)]!++;
      if (event.k === 'constructed' && team && event.role) production[SEATS + game.sim.armyIndex(team) * PLANES.length + PLANES.indexOf(event.role)]!++;
      if (event.k === 'kill' && team) pending.causes.push({
        sequence: sequence++, tick: event.t, victimTeam: team, victimRole: event.plane, victimKind: event.subject ?? 'unknown',
        attackerTeam: event.killer ?? null, attackerRole: event.attackerPlane ?? null,
        attackerKind: event.attackerKind ?? (event.by && Object.hasOwn(game.sim.stats, event.by) ? event.by : null),
        cause: event.by ?? 'unknown', count: 1, alloyValue: event.alloyValue ?? 0, energyValue: event.energyValue ?? 0,
      });
    }
    if (game.tick % sampleEveryTicks === 0) sample();
  };
  const drain = (): NativeRows => {
    const rows = pending;
    rows.intents = [...intentBuckets.values()];
    intentBuckets.clear();
    pending = { metrics: [], causes: [], events: [], intents: [] };
    return rows;
  };
  pending.metrics.push(
    { sequence: sequence++, tick: game.tick, scope: 'match', team: null, role: null, metric: 'sampling.everyTicks', value: sampleEveryTicks, unit: 'ticks' },
    { sequence: sequence++, tick: game.tick, scope: 'match', team: null, role: null, metric: 'clock.tickRate', value: TICK_RATE, unit: 'ticks/second' },
  );
  sample();
  return {
    collect,
    drain,
    rows(matchId) {
      const rows = drain();
      return {
        metrics: rows.metrics.map((row) => ({ ...row, matchId })),
        causes: rows.causes.map((row) => ({ ...row, matchId })),
        events: rows.events.map((row) => ({ ...row, matchId })),
        intents: rows.intents.map((row) => ({ ...row, matchId })),
      };
    },
    intent(row) {
      sampleDirty = true;
      const army = isArmyId(row.team) ? game.sim.armyIndex(row.team) : -1;
      if (army < 0 || !isPlane(row.role) || row.source.length > INTENT_SOURCE_MAX || row.code.length > INTENT_CODE_MAX) throw new Error('invalid intent accounting');
      const slot = army * PLANES.length + PLANES.indexOf(row.role);
      submitted[slot]!++;
      if (row.accepted) accepted[slot]!++;
      const code = row.accepted ? 'ok' : row.code;
      const key = `${row.team}/${row.role}/${row.source}/${code}`;
      let bucket = intentBuckets.get(key);
      if (!bucket) {
        if (intentBuckets.size >= INTENT_BUCKET_CAP) throw new Error('intent accounting cardinality exceeded');
        bucket = { team: row.team, role: row.role, source: row.source, code, submitted: 0, accepted: 0, rejected: 0 };
        intentBuckets.set(key, bucket);
      }
      bucket.submitted++;
      if (row.accepted) bucket.accepted++;
      else bucket.rejected++;
      pending.events.push({
        sequence: sequence++, tick: game.tick, atMs: game.tick * 1000 / TICK_RATE,
        kind: 'intent_ack', team: row.team, role: row.role, data: { source: row.source, code, accepted: row.accepted },
      });
    },
    finish() {
      collect();
      sample();
      recorder.close();
      const measured = summarize(recorder.trace(), {});
      const match: Record<string, number> = {
        ticks: measured.ticks,
        minutes: measured.ticks / TICK_RATE / 60,
        // Ended by the time cap: two or more Surface segments still standing.
        capped: Number(game.sim.allArmies.filter((a) => game.sim.armies[a]!.spire.surface.hp > 0).length >= 2),
        unattributed: measured.unattributed,
      };
      for (const group of ['cross', 'kinds', 'environmental'] as const) {
        for (const [key, value] of Object.entries(measured[group])) match[`${group}.${key}`] = value;
      }
      if (measured.lodes) {
        match['outcrops'] = measured.lodes.outcrops.length;
        measured.lodes.outcrops.forEach((lode, i) => {
          for (const [key, value] of Object.entries(lode)) match[`outcrop.${i}.${key}`] = Number(value);
        });
      }
      const sides: GameMetrics['sides'] = {};
      for (const a of game.sim.allArmies) {
        const team = game.sim.armyIds[a]!;
        const side: Record<string, number> = { spire: Math.round(game.sim.spireTotal(a)) };
        const state = game.sim.armies[a]!;
        side['economy.stock.alloy'] = state.alloy;
        side['economy.stock.energy'] = state.energy;
        for (const [index, name] of ECONOMY_KEYS.entries()) side[`economy.${name}`] = state.accounting[index]!;
        for (const plane of PLANES) side[`firstMinute.${plane}`] = measured.firstMinute[team]![plane];
        for (const [minute, units] of Object.entries(measured.units)) {
          for (const plane of PLANES) side[`units.${minute}.${plane}`] = units[team]![plane];
        }
        for (const group of ['produced', 'built', 'kills'] as const) {
          for (const [key, value] of Object.entries(measured[group][team]!)) side[`${group}.${key}`] = value;
        }
        for (const plane of PLANES) {
          const damage = measured.spireDamage[team]![plane];
          for (const origin of DAMAGE_ORIGINS) side[`spireDamage.${plane}.from.${origin}`] = damage.from[origin];
          for (const [cause, value] of Object.entries(damage.by)) side[`spireDamage.${plane}.by.${cause}`] = value;
        }
        for (const field of SAPPER_FIELDS) side[`sappers.${field}`] = measured.sappers[team]![field];
        if (measured.lodes) {
          for (const [key, value] of Object.entries(measured.lodes.sides[team]!)) side[`lodes.${key}`] = value;
        }
        sides[team] = side;
      }
      return { match, sides };
    },
  };
}

/** Restore the typed report measurements without losing empty maps, zero counts, or sample boundaries. */
export function measurementsFromMetrics({ match, sides }: GameMetrics): MatchMeasurements {
  const group = (values: Record<string, number>, prefix: string): Record<string, number> =>
    Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith(`${prefix}.`)).map(([key, value]) => [key.slice(prefix.length + 1), value]));
  const units: MatchMeasurements['units'] = {};
  const armies = ARMIES.filter((id) => sides[id] !== undefined);
  // Every army reports the same sample minutes; the first army's keys list them.
  for (const key of Object.keys(sides[armies[0]!]!)) {
    if (!key.startsWith('units.')) continue;
    const minute = key.split('.')[1]!;
    units[minute] ??= perArmy(armies, (team) => perPlane((plane) => sides[team]![`units.${minute}.${plane}`]!));
  }
  return {
    ticks: match['ticks']!,
    armies,
    units,
    firstMinute: perArmy(armies, (team) => perPlane((plane) => sides[team]![`firstMinute.${plane}`]!)),
    cross: group(match, 'cross'),
    kinds: group(match, 'kinds'),
    produced: perArmy(armies, (team) => group(sides[team]!, 'produced')),
    built: perArmy(armies, (team) => group(sides[team]!, 'built')),
    kills: perArmy(armies, (team) => group(sides[team]!, 'kills')),
    environmental: group(match, 'environmental'),
    unattributed: match['unattributed']!,
    spireDamage: perArmy(armies, (team) => perPlane((plane) => ({
      from: Object.fromEntries(DAMAGE_ORIGINS.map((origin) => [origin, sides[team]![`spireDamage.${plane}.from.${origin}`]!])) as Record<DamageOrigin, number>,
      by: group(sides[team]!, `spireDamage.${plane}.by`),
    }))),
    sappers: perArmy(armies, (team) => {
      const row = {} as SapperMetrics;
      for (const field of SAPPER_FIELDS) row[field] = sides[team]![`sappers.${field}`]!;
      return row;
    }),
    ...(match['outcrops'] === undefined ? {} : {
      lodes: {
        outcrops: Array.from({ length: match['outcrops'] }, (_, i) => ({
          x: match[`outcrop.${i}.x`]!, y: match[`outcrop.${i}.y`]!,
          rich: Boolean(match[`outcrop.${i}.rich`]), flank: Boolean(match[`outcrop.${i}.flank`]), loads: match[`outcrop.${i}.loads`]!,
        })),
        sides: perArmy(armies, (team) => group(sides[team]!, 'lodes') as unknown as LodeSideMetrics),
      },
    }),
  };
}
