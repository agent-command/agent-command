import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBench } from '@playerthree/bench';
import { createMetrics, measurementsFromMetrics, playBotMatch, Recorder, summarize } from '@agent-command/game';
import type { GameMetricRecorder } from 'playerthree';
import { balanceConfigs, matchSummary, trialCount } from '../src/bench.ts';
import { rotations, standardPlan, type RunSet } from '../src/spec.ts';
import reference from '../../../bench/bench.config.ts';
import { createBenchmarkSuite } from '@playerthree/bench/campaign';
import { benchmarkDigest } from 'playerthree/benchmark';
import { definition } from '../../../packages/game/src/agent/adapter.ts';
import { ACBENCH } from '../../../bench/acbench-settings.ts';
import { ladderSeries, resolveLadderMatch } from '../../../bench/acbench-ladder.ts';

const set: RunSet = {
  key: 'mirror-standard', kind: 'mirror', title: 'standard mirror',
  // The minimum 60 s time cap (1200 ticks) ends games before the 1201-tick runner limit: tick_limit is an abort, not a result.
  entrants: [{ level: 'standard' }, { level: 'standard' }], layout: 'duel', seeds: [1001], permutations: [[0, 1]],
  options: { terrain: 'open', spire: { timeCap: 60 } },
};
describe('native metrics and canonical series cutover', () => {

  it('authors once and evaluates all held-out opponent orientations with shared budgets', () => {
    expect(reference.spec.track).toBe('policy');
    expect(reference.spec.scenarios.map((scenario) => scenario.seed)).toEqual([17011, 29009]);
    expect(trialCount(reference.spec)).toBe(12);
    expect(reference.spec.permutations.map((permutation) => permutation.sideEntrants.map((entry) => entry.entrantId))).toEqual([
      ['surface-example', 'novice'], ['novice', 'surface-example'],
      ['surface-example', 'standard'], ['standard', 'surface-example'],
      ['surface-example', 'veteran'], ['veteran', 'surface-example'],
    ]);
    expect(reference.spec.budgets).toEqual({ maxTurns: 6, maxTokens: 120000, maxCostUsd: '1' });
    expect(Object.keys(reference.models)).toEqual(['surface-example']);
    expect(reference.spec.execution.maxTicks).toBe(2400);
    expect(reference.spec.entrantSeats).toHaveLength(4);
    expect(reference.spec.authoring).toEqual({ practiceSeeds: [17, 29], maxOutputTokens: 4096, maxWallMs: 60000 });
  });
  it('round-trips every native measurement through finite numeric maps', () => {
    let recorder: Recorder | undefined;
    let metrics: GameMetricRecorder | undefined;
    playBotMatch({ seed: 1001, levels: { nw: 'standard', se: 'standard' }, maxTicks: 1200,
      onTick(game) { (recorder ??= new Recorder(game)).collect(); (metrics ??= createMetrics(game)).collect(); } });
    const measured = metrics!.finish();
    expect(measurementsFromMetrics(measured)).toEqual(summarize(recorder!.trace(), {}));
    expect(Object.values(measured.match).every(Number.isFinite)).toBe(true);
    for (const values of Object.values(measured.sides)) expect(Object.values(values).every(Number.isFinite)).toBe(true);
    expect(measured.match['minutes']).toBe(1);
    expect(Object.keys(measured.sides)).toEqual(['nw', 'se']);
    expect(measured.sides['nw']!['units.1.depths']).toBeGreaterThan(0);
  });

  it('preserves deterministic summaries through the canonical host runner', async () => {
    let recorder: Recorder | undefined;
    const native = playBotMatch({ seed: 1001, levels: { nw: 'standard', se: 'standard' }, options: set.options, maxTicks: 1200,
      onTick: (game) => (recorder ??= new Recorder(game)).collect() });
    const outDir = await mkdtemp(join(tmpdir(), 'balance-series-'));
    try {
      const envelope = await runBench(balanceConfigs([set], 1201, 0)[0]!, { outDir });
      const result = envelope.tables.matches.find((match) => match.acceptedAttempt)!;
      const { wallMs: _wallMs, ...actual } = matchSummary(envelope, result, set);
      expect(actual).toEqual(summarize(recorder!.trace(), {
        set: set.key, seed: 1001, entrants: [0, 1], options: set.options,
        winner: native.outcome.nw === 'win' ? 'nw' : native.outcome.se === 'win' ? 'se' : 'draw',
        rank: native.rank,
        capped: native.game.sim.armies[0]!.spire.surface.hp > 0 && native.game.sim.armies[1]!.spire.surface.hp > 0,
        spire: { nw: Math.round(native.game.sim.spireTotal(0)), se: Math.round(native.game.sim.spireTotal(1)) },
      }));
      expect(envelope.tables.schedule[0]!.rulesHash).toMatch(/^sha256:/);
      expect(envelope.tables.schedule[0]!.mapIdentity).toMatch(/^sha256:/);
      const seat = envelope.tables.seats[0]!;
      const withPolicyCounters = { ...envelope, tables: { ...envelope.tables,
        seats: [{ ...seat, executionKind: 'policy' as const }],
        metrics: [...envelope.tables.metrics, ...Object.entries({ 'policy.calls': 20, 'policy.errors': 1, 'policy.timeouts': 1, 'policy.intentsEmitted': 7 })
          .map(([metric, value], index) => ({ matchId: result.matchId, tick: result.ticks, sequence: 10000 + index,
            scope: 'seat' as const, team: seat.team, role: seat.role, metric, value, unit: 'count' }))],
        intents: [
          { matchId: result.matchId, team: seat.team, role: seat.role, source: 'policy', code: 'game:invalid', submitted: 2, accepted: 0, rejected: 2 },
          { matchId: result.matchId, team: seat.team, role: seat.role, source: 'agent', code: 'game:invalid', submitted: 4, accepted: 0, rejected: 4 },
        ],
      } };
      expect(matchSummary(withPolicyCounters, result, set).probe).toEqual({
        calls: 20, errors: 1, timeouts: 1, intents: 7, rejected: 2, codes: { 'game:invalid': 2 },
      });
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });

  it('summarises a four-army FFA match per layout slot, with entrants resolved from the rotation', async () => {
    const ffa: RunSet = {
      key: 'ffa-mirror-standard', kind: 'mirror', title: 'FFA standard mirror', layout: 'ffa', seeds: [1001],
      entrants: [{ level: 'standard' }, { level: 'standard' }, { level: 'standard' }, { level: 'standard' }],
      permutations: [rotations(4)[1]!], options: { terrain: 'open', map: { params: { slots: 4 } }, spire: { timeCap: 60 } },
    };
    let recorder: Recorder | undefined;
    const native = playBotMatch({ seed: 1001, levels: { nw: 'standard', ne: 'standard', se: 'standard', sw: 'standard' }, options: ffa.options, maxTicks: 1200,
      onTick: (game) => (recorder ??= new Recorder(game)).collect() });
    const outDir = await mkdtemp(join(tmpdir(), 'balance-ffa-'));
    try {
      const envelope = await runBench(balanceConfigs([ffa], 1201, 0)[0]!, { outDir });
      const result = envelope.tables.matches.find((match) => match.acceptedAttempt)!;
      const { wallMs: _wallMs, ...actual } = matchSummary(envelope, result, ffa);
      const armies = ['nw', 'ne', 'se', 'sw'] as const;
      expect(actual).toEqual(summarize(recorder!.trace(), {
        set: ffa.key, seed: 1001, entrants: [3, 0, 1, 2], options: ffa.options,
        winner: armies.find((army) => native.outcome[army] === 'win') ?? 'draw',
        rank: native.rank,
        capped: armies.every((_, index) => native.game.sim.armies[index]!.spire.surface.hp > 0),
        spire: Object.fromEntries(armies.map((army, index) => [army, Math.round(native.game.sim.spireTotal(index))])),
      }));
      expect(Object.keys(actual.firstMinute)).toEqual([...armies]);
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });

  it('preserves all 78 guardrails and 1848 trials without invalid cross-pairings', () => {
    const sets = standardPlan({ seeds: 24, probeSeeds: 10, probeLevels: ['standard', 'veteran'], terrains: ['open', 'ridges', 'canyons'] });
    const configs = balanceConfigs(sets, 36001, 2);
    const rules = configs.flatMap((config) => config.guardrails!);
    // 66 before the volatile-tow strike probe, 72 before lancer-night-siege: each added one probe across 2 levels ×
    // 3 terrains (+6 sets, +120 trials).
    expect(configs).toHaveLength(78);
    expect(configs.reduce((sum, config) => sum + trialCount(config.spec), 0)).toBe(1848);
    for (const [index, config] of configs.entries()) {
      expect(config.spec.scenarios.map((scenario) => scenario.seed)).toEqual(sets[index]!.seeds);
      expect(config.spec.entrants.map((entrant) => entrant.botLevel)).toEqual(sets[index]!.entrants.map((entrant) => entrant.level));
      expect(config.spec.execution.maxTicks).toBe(36001);
      expect(config.spec.execution.concurrency).toBe(2);
    }
    expect(rules).toHaveLength(78);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(78);
    const bias = rules.filter((rule) => rule.aggregation === 'binomialTwoSided');
    expect(bias).toHaveLength(9);
    expect(bias.every((rule) => rule.scope === 'team:nw' && rule.threshold === 0.05 / 9 && rule.comparator === '>=')).toBe(true);
    const length = rules.filter((rule) => rule.aggregation === 'median');
    expect(length).toHaveLength(6);
    expect(length.every((rule) => rule.comparator === 'between' && JSON.stringify(rule.threshold) === '[10,15]')).toBe(true);
    expect(rules.filter((rule) => rule.threshold === 0.8)).toHaveLength(3);
    expect(rules.filter((rule) => rule.threshold === 0.65)).toHaveLength(60);
  });

  it('keeps hunt policies attached to entrants across physical side permutations', () => {
    const hunt: RunSet = { ...set, kind: 'probe', entrants: [{ level: 'veteran', probe: 'hunt-custom', policies: { depths: 'function think() { return []; }' } }, { level: 'standard' }],
      permutations: rotations(2) };
    const config = balanceConfigs([hunt], 20, 0)[0]!;
    expect(config.spec.permutations.map((permutation) => permutation.sideEntrants)).toEqual([
      [{ team: 'nw', entrantId: 'A' }, { team: 'se', entrantId: 'B' }],
      [{ team: 'nw', entrantId: 'B' }, { team: 'se', entrantId: 'A' }],
    ]);
    expect(config.policies!.A).toEqual({ depths: { runtime: 'js', code: hunt.entrants[0]!.policies!.depths } });
    expect(config.policies!.B).toEqual({});
    expect(config.spec.template.sides[0]!.seats.find((seat) => seat.role === 'depths')!.occupant)
      .toEqual({ kind: 'commander', ref: { id: 'A', kind: 'policy' } });
  });

  it('names every ACBench trial by its opponent, a suite reference, and the candidate side', () => {
    const spec = ladderSeries({ maps: ['crossfire', 'crown'], seeds: [ACBENCH.scoringSeeds[0]!], rungs: [...ACBENCH.opponents], gameDigest: '0'.repeat(64) });
    const suite = createBenchmarkSuite({ definition, resolve: resolveLadderMatch, spec }, {
      id: 'acbench-test', version: 1, title: 'ACBench test', track: 'submitted-policy', candidateId: ACBENCH.candidateId, roles: ['depths', 'surface', 'sky', 'orbit'], replicates: 1,
      build: { gameDigest: '0'.repeat(64), runnerDigest: '0'.repeat(64) },
      references: spec.entrants.filter((e) => e.id !== ACBENCH.candidateId).map((e) => ({ id: e.id, digest: benchmarkDigest(e) })),
      strata: [{ id: 'crossfire', weight: 1 }, { id: 'crown', weight: 1 }],
      blocks: spec.scenarios.map((s) => ({ scenarioId: s.id, blockId: s.id, stratumId: s.id.slice(0, s.id.indexOf('-seed-')) })), harness: { id: 'test', version: '1' },
    });
    expect(suite.references.map((reference) => reference.id)).toEqual(['novice', 'standard', 'veteran', 'elite', 'champion']);
    expect(suite.evaluation.permutations).toEqual(ACBENCH.opponents.flatMap((rung) => [`${rung}-nw`, `${rung}-se`]));
    const trials = suite.blocks.flatMap(() => spec.permutations);
    expect(trials).toHaveLength(20);
    for (const { id, sideEntrants } of trials) {
      const split = id.lastIndexOf('-');
      const opponent = id.slice(0, split);
      expect(suite.references.map((reference) => reference.id)).toContain(opponent);
      expect(sideEntrants.find((side) => side.team === id.slice(split + 1))!.entrantId).toBe(ACBENCH.candidateId);
      expect(sideEntrants.find((side) => side.entrantId !== ACBENCH.candidateId)!.entrantId).toBe(opponent);
    }
  });
});
