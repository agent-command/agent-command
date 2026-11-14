/** Synthetic contract fixture ONLY. Never an official result or evidence of model ability. */
import { sealBenchmark, scoreBenchmark, type BenchmarkPublication, type BenchmarkRun, type BenchmarkSuite } from 'playerthree/benchmark';
import { manifest } from '@agent-command/game';
import type { BenchmarkRelease } from '../src/benchmark-registry.ts';

const hash = 'a'.repeat(64);
export function benchmarkFixture(id = 'fixture-system', amount = '1', wins = 3): BenchmarkPublication {
  const suite = sealBenchmark<Omit<BenchmarkSuite, 'digest'>>({ id: 'synthetic-contract-fixture', version: 1, title: 'SYNTHETIC TEST FIXTURE — NOT BENCHMARK EVIDENCE',
    track: 'authored-policy', game: manifest.id, gameVersion: 'test-only', surfaceHash: hash, seriesDigest: hash,
    build: { gameDigest: hash, runnerDigest: hash }, roles: ['surface'], references: [{ id: 'fixture-baseline', digest: hash }], strata: [{ id: 'fixture-map', weight: 1 }],
    blocks: [{ scenarioId: 'world-1', blockId: 'world-1', stratumId: 'fixture-map' }, { scenarioId: 'world-2', blockId: 'world-2', stratumId: 'fixture-map' }],
    evaluation: { permutations: ['forward', 'reverse'], repetitions: 1 },
    authoring: { replicates: 2, budgets: { maxTokens: 100, maxCostUsd: '1', maxTurns: 2 }, maxWallMs: 1000, practiceSeeds: [17] },
    scoring: { method: 'weighted-score/1', timeout: 'draw', authoringFailure: 'zero' }, uncertainty: { method: 'crossed-run-block-bootstrap/1', seed: 17, replicates: 100 }, harness: { id: 'fixture', version: '1' } });
  const runs: BenchmarkRun[] = [0, 1].map(index => ({ id: `run-${index}`, index, status: 'evaluated', reason: null, authoringAttempts: 1, artifactDigest: hash,
    seriesId: `series-${index}`, seriesRevision: 2,
    trials: suite.blocks.flatMap((b, bi) => suite.evaluation.permutations.map((permutationId, pi) => ({ trialId: `trial-${bi * 2 + pi}`, blockId: b.blockId, stratumId: b.stratumId, permutationId,
      status: bi * 2 + pi < wins ? 'win' as const : 'loss' as const, score: bi * 2 + pi < wins ? 1 : 0, attempts: 1 }))),
    cost: { scope: 'authoring-run', amount, currency: 'USD', source: 'runner-estimate', coverage: 'complete', pricingVersion: 'synthetic-test/1', pricedAt: '2000-01-01T00:00:00.000Z' },
    startedAt: '2000-01-01T00:00:00.000Z', finishedAt: '2000-01-01T00:00:01.000Z' }));
  const experiment = sealBenchmark({ id, suiteDigest: suite.digest, executionDigest: hash,
    system: { id, label: `Synthetic fixture ${id}`, provider: 'synthetic', model: 'not-a-real-model', harness: 'fixture/1', configurationDigest: hash }, replicates: 2, provenance: 'runner-observed' as const });
  return sealBenchmark({ format: 'playerthree.benchmark-publication' as const, version: 1 as const, id, revision: 1 as const, publishedAt: '2000-01-01T00:00:02.000Z', suite, experiment, runs,
    score: scoreBenchmark(suite, runs), consent: { results: true as const, attribution: true, artifacts: false as const, research: true, training: false, license: 'CC0-1.0 (synthetic fixture only)' },
    retention: { policy: 'until-withdrawn' as const, withdrawalNotice: 'Downloaded copies cannot be recalled.' as const } });
}
/** Re-seals a fixture after a test edits its runs or system: score and digests follow the edited evidence. */
export function reseal(p: BenchmarkPublication): BenchmarkPublication {
  const { digest: _experimentDigest, ...experiment } = p.experiment;
  const { digest: _digest, ...body } = p;
  return sealBenchmark({ ...body, experiment: sealBenchmark(experiment), score: scoreBenchmark(p.suite, p.runs) });
}
export function fixtureRelease(publications: BenchmarkPublication[], revision = 1, notBefore = '2000-01-01T00:00:03.000Z'): BenchmarkRelease {
  return sealBenchmark({ format: 'acbench.release' as const, version: 1 as const, id: 'synthetic-fixture', revision,
    title: 'SYNTHETIC TEST FIXTURE — NOT A RANKING', publishedAt: '2000-01-01T00:00:03.000Z', notBefore,
    publisher: 'community' as const, evidence: 'submitted' as const, publicationIds: publications.map(p => p.id),
    supersedes: revision > 1 ? { id: 'synthetic-fixture', revision: revision - 1 } : null,
    correction: revision > 1 ? 'Synthetic correction test' : null, privacyReviewed: true as const });
}
