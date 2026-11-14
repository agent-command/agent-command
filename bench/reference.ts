/** AC-specific frozen reference protocol; all scheduling/authoring/statistics stay in PlayerThree. */
import type { BenchConfig } from '@playerthree/bench';
import { createBenchmarkSuite, type CampaignConfig } from '@playerthree/bench/campaign';
import { benchmarkDigest } from 'playerthree/benchmark';
import type { PolicyArtifact } from 'playerthree';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { resolveArenaMatch } from '../packages/game/src/lobby/arena.ts';
import { botVersion } from '../packages/game/src/bots/packages.ts';
import { DEFAULT_TIME_CAP_TICKS } from '../packages/game/src/rules/contract.ts';
import { seriesSpec } from './series.ts';
import smokeConfig from './bench.config.ts';

export interface ReferenceInput {
  seeds: number[]; gameDigest: string; runnerDigest: string; build: CampaignConfig['build']; pricing: { version: string; asOf: string }; artifact?: PolicyArtifact;
  model?: NonNullable<BenchConfig['models']>[string]; smoke?: boolean;
  /** Suite version: a changed suite digest (code, rules, opponents) is released under a new version of the same id. */
  suiteVersion: number;
  systemId: string; label: string; license: string; publicationConsent: boolean;
}
export function referenceCampaign(input: ReferenceInput): CampaignConfig {
  if (input.seeds.length < 2 || new Set(input.seeds).size !== input.seeds.length || input.seeds.some(s => !Number.isInteger(s) || s < 0 || s > 2 ** 31 - 1 || s === 17 || s === 29)) throw new Error('Use at least two unique held-out uint31 seeds disjoint from practice seeds 17/29');
  if (!Number.isSafeInteger(input.suiteVersion) || input.suiteVersion < 1) throw new Error('Suite version must be a positive integer');
  if (!/^[a-f0-9]{64}$/.test(input.gameDigest)) throw new Error('Pinned game source digest required');
  if (!input.artifact && !input.model && !input.smoke) throw new Error('Supply an immutable policy or private model configuration');
  const candidateId = 'candidate';
  const model = input.artifact ? undefined : input.model ?? smokeConfig.models['surface-example'];
  const opponents = ['novice', 'standard', 'veteran'] as const;
  const terrains = input.smoke ? ['open'] as const : ['open', 'ridges', 'canyons'] as const;
  // A reference names the exact bot it was measured against: every plane's package for the current surface.
  const versionOf = (level: (typeof opponents)[number]): string => {
    const version = botVersion(definition.manifest, level);
    if (!version) throw new Error(`no current ${level} bot packages: run pnpm --filter @agent-command/game bots:build`);
    return version;
  };
  const entrants: BenchConfig['spec']['entrants'] = [
    { id: candidateId, label: 'Candidate', kind: 'agent', aiPlayer: true, botLevel: 'standard', stateResetSource: 'runner' },
    ...opponents.map(level => ({ id: level, label: level, kind: 'bot' as const, aiPlayer: true, botLevel: level,
      botVersion: versionOf(level), stateResetSource: 'runner' as const })),
  ];
  const templates = terrains.map(terrain => seriesSpec({ track: 'policy', entrants, seeds: input.seeds,
    ticks: input.smoke ? 60 : DEFAULT_TIME_CAP_TICKS + 1, options: { terrain },
    permutations: opponents.flatMap(opponent => [[candidateId, opponent], [opponent, candidateId]]),
    policyRoles: { [candidateId]: ['surface'] },
    budgets: { maxTokens: input.smoke ? 12000 : 120000, maxTurns: input.smoke ? 6 : 200, maxCostUsd: input.smoke ? '0' : '10' },
    authoring: { practiceSeeds: [17, 29], maxOutputTokens: 4096, maxWallMs: input.smoke ? 60000 : 3600000 },
    // One retry lets an interrupted or crashed evaluation match resume on the same trial, seed and artifact.
    maxInfraRetries: 1,
  }));
  const spec = templates[0]!;
  spec.scenarios = templates.flatMap((s, terrainIndex) => s.scenarios.map((scenario, index) => ({ ...scenario, id: `${terrains[terrainIndex]}-world-${index + 1}` })));
  const bench: BenchConfig = { definition, resolve: resolveArenaMatch, spec,
    ...(input.artifact ? { policies: { [candidateId]: { surface: input.artifact } } } : { models: { [candidateId]: model! } }),
  };
  const track = input.artifact ? 'submitted-policy' : 'authored-policy';
  const suite = createBenchmarkSuite(bench, {
    id: `ac-surface-${input.smoke ? 'smoke' : 'reference'}-${track}-${benchmarkDigest(input.seeds).slice(0, 12)}`, version: input.suiteVersion,
    title: input.smoke ? 'Deterministic integration smoke — not a model ranking' : 'AC Surface fixed-reference evaluation',
    track, candidateId, roles: ['surface'], replicates: input.artifact ? 1 : input.smoke ? 2 : 5,
    build: { gameDigest: input.gameDigest, runnerDigest: input.runnerDigest },
    references: entrants.filter(e => e.id !== candidateId).map(e => ({ id: e.id, digest: benchmarkDigest({ entrant: e, policies: null, gameVersion: spec.gameVersion }) })),
    strata: terrains.map(id => ({ id, weight: 1 / terrains.length })),
    blocks: spec.scenarios.map(s => ({ scenarioId: s.id, blockId: s.id, stratumId: s.id.split('-world-')[0]! })),
    harness: { id: 'playerthree-common-harness', version: '1' }, bootstrapSeed: 1729, bootstrapReplicates: 2000,
  });
  return { bench, suite, candidateId, build: input.build, pricing: input.pricing,
    system: { id: input.systemId, label: input.label, provider: model?.provider ?? null, model: model?.model ?? null,
      harness: `${suite.harness.id}/${suite.harness.version}`,
      configurationDigest: benchmarkDigest({ division: 'common-harness', version: 1, roles: ['surface'], tools: 'playerthree-policy-authoring', practiceSeeds: [17, 29], teamBots: 'standard', gameDigest: input.gameDigest }) },
    consent: { results: true, attribution: input.publicationConsent, artifacts: false, research: input.publicationConsent, training: false, license: input.license },
  };
}
