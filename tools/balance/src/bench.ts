/** Game-specific series specifications and balance report projection. Execution belongs to PlayerThree. */
import { availableParallelism } from 'node:os';
import { DEFAULT_SERIES_LIMITS, runBench, type BenchConfig, type SeriesSpec } from '@playerthree/bench';
import type { MatchRow, ResultsEnvelope } from 'playerthree/arena';
import { botVersion, definition, measurementsFromMetrics, toTicks, type ArmyId } from '@agent-command/game';
import { benchGuardrails } from './guardrails.ts';
import type { MatchSummary, ProbeHealth } from './metrics.ts';
import { entrantPolicies, layoutArmies, type RunSet } from './spec.ts';
import { resolveArenaMatch } from '../../../packages/game/src/lobby/arena.ts';
import { seriesSpec } from '../../../bench/series.ts';

/** Half the cores, within the series runner's concurrent-match limit (a larger value is rejected by the runner). */
export const DEFAULT_WORKERS = Math.max(1, Math.min(DEFAULT_SERIES_LIMITS.maxConcurrency, Math.floor(availableParallelism() / 2)));
export const GAME_DEFINITION = { module: new URL('../../../packages/game/src/agent/adapter.ts', import.meta.url).href, export: 'definition' };

/**
 * Metric sample cadence of balance series: one game minute. The report reads final values only (`finish` emits them
 * whatever the cadence); the per-second default stores ~350 metric rows per sample in a four-army match, ~120 MB of
 * results per 30-minute match, which no sweep can load back.
 */
const SAMPLE_EVERY_TICKS = toTicks(60);
/** Series entrant id of a run set's k-th entrant: A, B, C, D. */
export const entrantId = (index: number): string => String.fromCharCode(65 + index);

/** A separate series per heterogeneous pairing: never cross-product unrelated entrants and scenarios. */
export function balanceConfigs(sets: readonly RunSet[], ticks: number, workers = DEFAULT_WORKERS): BenchConfig[] {
  const active = sets.filter((set) => set.seeds.length > 0);
  const guards = benchGuardrails(active);
  return active.map((set) => {
    const policies = Object.fromEntries(set.entrants.map((entrant, index) => [entrantId(index), entrantPolicies(entrant)]));
    const spec = seriesSpec({
      track: 'bots', seeds: set.seeds, ticks, concurrency: Math.max(1, workers), options: set.options, layout: set.layout, sampleEveryTicks: SAMPLE_EVERY_TICKS,
      entrants: set.entrants.map((entrant, index) => {
        const kind = entrant.probe || entrant.policies ? 'policy' as const : 'bot' as const;
        const version = kind === 'bot' ? botVersion(definition.manifest, entrant.level) : undefined;
        return { id: entrantId(index), label: entrant.probe ?? entrant.level, kind, aiPlayer: true, botLevel: entrant.level,
          ...(version ? { botVersion: version } : {}), stateResetSource: 'runner' as const };
      }),
      permutations: set.permutations.map((permutation) => permutation.map(entrantId)),
      policyRoles: Object.fromEntries(Object.entries(policies).map(([id, roles]) => [id, Object.keys(roles)])),
    });
    return { definition: GAME_DEFINITION, spec, policies, resolve: resolveArenaMatch,
      guardrails: guards.filter((guard) => guard.id.endsWith(`:${set.key}`)) };
  });
}

export const trialCount = (spec: SeriesSpec): number => spec.scenarios.length * spec.permutations.length * spec.repetitions;

export async function runBalance(sets: readonly RunSet[], ticks: number, workers: number, outDir: string,
  onProgress?: (done: number, total: number) => void): Promise<{ envelopes: ResultsEnvelope[]; matches: MatchSummary[] }> {
  const active = sets.filter((set) => set.seeds.length > 0);
  const configs = balanceConfigs(active, ticks, workers);
  const total = configs.reduce((sum, config) => sum + trialCount(config.spec), 0);
  const envelopes: ResultsEnvelope[] = [];
  const matches: MatchSummary[] = [];
  let completed = 0;
  for (const [index, config] of configs.entries()) {
    const envelope = await runBench(config, { outDir: `${outDir}/${active[index]!.key}`,
      onProgress: (done) => onProgress?.(completed + done, total) });
    envelopes.push(envelope);
    matches.push(...envelope.tables.matches.filter((match) => match.acceptedAttempt).map((match) => matchSummary(envelope, match, active[index]!)));
    completed += trialCount(config.spec);
  }
  return { envelopes, matches };
}

/** Canonical metrics already use army ids; logical entrants are resolved per layout slot from the accepted schedule. */
export function matchSummary(envelope: ResultsEnvelope, result: MatchRow, set: RunSet): MatchSummary {
  const trial = envelope.tables.schedule.find((row) => row.trialId === result.trialId);
  if (!trial) throw new Error(`missing schedule for ${result.trialId}`);
  const armies = layoutArmies(set.layout);
  const entrants = armies.map((army) => {
    const binding = trial.sideBindings.find((row) => row.team === army);
    if (!binding) throw new Error(`${result.trialId}: no entrant on ${army}`);
    return binding.entrantId.charCodeAt(0) - 65;
  });
  const match: Record<string, number> = {};
  const sides: Record<string, Record<string, number>> = {};
  for (const row of envelope.tables.metrics) {
    if (row.matchId !== result.matchId) continue;
    if (row.scope === 'match') match[row.metric] = row.value;
    else if (row.scope === 'side' && row.team !== null) (sides[row.team] ??= {})[row.metric] = row.value;
  }
  let probe: ProbeHealth | undefined;
  for (const seat of envelope.tables.seats.filter((row) => row.matchId === result.matchId && row.executionKind === 'policy')) {
    probe ??= { calls: 0, errors: 0, timeouts: 0, intents: 0, rejected: 0, codes: {} };
    for (const row of envelope.tables.metrics.filter((row) => row.matchId === result.matchId && row.team === seat.team && row.role === seat.role)) {
      if (row.metric === 'policy.calls') probe.calls += row.value;
      if (row.metric === 'policy.errors') probe.errors += row.value;
      if (row.metric === 'policy.intentsEmitted') probe.intents += row.value;
      if (row.metric === 'policy.timeouts') probe.timeouts += row.value;
    }
    for (const row of envelope.tables.intents) {
      if (row.matchId !== result.matchId || row.team !== seat.team || row.role !== seat.role || row.source !== 'policy' || row.rejected === 0) continue;
      probe.rejected += row.rejected;
      probe.codes[row.code] = (probe.codes[row.code] ?? 0) + row.rejected;
    }
  }
  const rank: Partial<Record<ArmyId, number>> = {};
  for (const outcome of result.outcomes) if (outcome.rank !== null) rank[outcome.team as ArmyId] = outcome.rank;
  return {
    ...measurementsFromMetrics({ match, sides }), set: set.key, seed: trial.seed, entrants,
    ...(set.options ? { options: set.options } : {}),
    winner: (result.outcomes.find((outcome) => outcome.outcome === 'win')?.team ?? 'draw') as ArmyId | 'draw',
    rank, capped: Boolean(match['capped']), spire: Object.fromEntries(armies.map((army) => [army, sides[army]!['spire']!])),
    wallMs: Math.round(result.wallMs), ...(probe ? { probe } : {}),
  };
}
