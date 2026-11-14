/**
 * Frontier authored-policy pilot, a small suite separate from the AC Surface fixed-reference suite:
 * one model authors a Surface policy in the lobby (practice seeds 17/29), which is then evaluated without model calls
 * against the standard bot on two public seeds of the open terrain, both orientations. One replicate, so no authoring
 * uncertainty interval exists; the published interval covers world blocks only.
 *
 *   OPENROUTER_API_KEY=… FRONTIER_MODEL=glm-5.3 playerthree-bench campaign \
 *     --config bench/frontier-authored.config.ts --out .data/bench/frontier/authored/glm-5.3 --max-campaign-usd 1
 */
import { fileURLToPath } from 'node:url';
import type { BenchConfig } from '@playerthree/bench';
import { createBenchmarkSuite, RUNNER_HARNESS, type CampaignConfig } from '@playerthree/bench/campaign';
import { benchmarkSourceDigest } from '@playerthree/bench/source-digest';
import { benchmarkDigest } from 'playerthree/benchmark';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { resolveArenaMatch } from '../packages/game/src/lobby/arena.ts';
import { DEFAULT_TIME_CAP_TICKS } from '../packages/game/src/rules/contract.ts';
import { botVersion } from '../packages/game/src/bots/packages.ts';
import { seriesSpec } from './series.ts';
import { MODELS, PRICING, openRouter, type FrontierModel } from './frontier-models.ts';

const id = process.env.FRONTIER_MODEL ?? '';
if (!(id in MODELS)) throw new Error(`FRONTIER_MODEL: one of ${Object.keys(MODELS).join(', ')}`);
const { model } = MODELS[id as FrontierModel];
/** Public seeds (not the held-out reference seeds), disjoint from practice seeds 17/29. */
const SEEDS = [4101, 4202];
/**
 * Identical for every model, so the authoring budget is cost-normalized: a pricier model gets fewer tokens before the USD
 * ceiling. A turn crossing a ceiling is charged but its tool calls never run; the latest deployed policy is frozen.
 */
const RUN_CEILING_USD = '1.5';

const root = fileURLToPath(new URL('../', import.meta.url));
// The PlayerThree checkout that actually runs (resolved through the linked package, so worktrees pin the same source).
const runnerRoot = fileURLToPath(new URL('../../../', import.meta.resolve('@playerthree/bench')));
const build = { game: { root, paths: ['packages/game/src', 'packages/game/package.json', 'pnpm-lock.yaml', 'bench/series.ts', 'bench/frontier-authored.config.ts', 'bench/frontier-models.ts'] },
  runner: { root: runnerRoot, paths: ['packages/bench/src', 'packages/playerthree/src', 'packages/runner/src', 'packages/bench/package.json', 'packages/playerthree/package.json', 'packages/runner/package.json', 'pnpm-lock.yaml'] } };
const [gameDigest, runnerDigest] = await Promise.all([benchmarkSourceDigest(build.game), benchmarkSourceDigest(build.runner)]);

const candidateId = 'candidate';
const entrants: BenchConfig['spec']['entrants'] = [
  { id: candidateId, label: 'Candidate', kind: 'agent', aiPlayer: true, botLevel: 'standard', stateResetSource: 'runner' },
  { id: 'standard', label: 'standard', kind: 'bot', aiPlayer: true, botLevel: 'standard', botVersion: `${botVersion(definition.manifest, 'standard')}+sha256:${gameDigest}`, stateResetSource: 'runner' },
];
const spec = seriesSpec({ track: 'policy', entrants, seeds: SEEDS, ticks: DEFAULT_TIME_CAP_TICKS + 1, options: { terrain: 'open' },
  permutations: [[candidateId, 'standard'], ['standard', candidateId]],
  policyRoles: { [candidateId]: ['surface'] },
  budgets: { maxTokens: 1_500_000, maxTurns: 24, maxCostUsd: RUN_CEILING_USD },
  // Room for a reasoning model's thinking plus real policy code in one reply: a reply cut at the cap runs nothing.
  authoring: { practiceSeeds: [17, 29], maxOutputTokens: 16_384, maxWallMs: 20 * 60 * 1000 },
  maxInfraRetries: 1,
});
spec.scenarios = spec.scenarios.map((scenario, index) => ({ ...scenario, id: `open-world-${index + 1}` }));
const bench: BenchConfig = { definition, resolve: resolveArenaMatch, spec, models: { [candidateId]: openRouter(id as FrontierModel) } };
const suite = createBenchmarkSuite(bench, {
  id: 'ac-surface-frontier-pilot', version: 1,
  title: 'Frontier authored-policy pilot (small: standard bot, open terrain, 2 seeds, 1 replicate; not the reference suite)',
  track: 'authored-policy', candidateId, roles: ['surface'], replicates: 1,
  build: { gameDigest, runnerDigest },
  references: [{ id: 'standard', digest: benchmarkDigest({ entrant: entrants[1], policies: null, gameVersion: spec.gameVersion }) }],
  strata: [{ id: 'open', weight: 1 }],
  blocks: spec.scenarios.map(s => ({ scenarioId: s.id, blockId: s.id, stratumId: 'open' })),
  harness: { ...RUNNER_HARNESS }, bootstrapSeed: 1729, bootstrapReplicates: 2000,
});

export default {
  bench, suite, candidateId, build, pricing: PRICING,
  // provider/model must equal the runner request: the OpenAI-compatible Responses protocol, routed by OpenRouter (label).
  system: { id: id.replace(/[^A-Za-z0-9_.-]/g, '-'), label: `${id} (via OpenRouter)`, provider: 'openai', model,
    harness: `${suite.harness.id}/${suite.harness.version}`,
    configurationDigest: benchmarkDigest({ division: 'common-harness', version: 1, roles: ['surface'], tools: 'playerthree-policy-authoring', practiceSeeds: [17, 29], teamBots: 'standard', reasoning: 'provider-default', route: 'openrouter-responses-pinned-hosts', gameDigest }) },
  consent: { results: true, attribution: true, artifacts: false, research: true, training: false, license: 'CC-BY-4.0' },
} satisfies CampaignConfig;
