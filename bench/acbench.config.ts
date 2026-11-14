/**
 * ACBench v1 (policy-authoring track; modelled on StarSkirmish Bench v0.2): one model, as a persistent lobby commander,
 * authors a policy for each of the four planes against a fixed wall clock, then its frozen policies play a fixed ladder
 * of built-in bots (novice, standard, veteran, and veteran at +15 % and +30 % income: elite, champion;
 * bench/acbench-ladder.ts) from both duel sides on three classic duel maps. Score = win rate, draws half. Before the
 * clock starts every plane's starter is deployed by reference, so a policy always exists; authoring has no early exit
 * and no submit tool: the policies active at the deadline are frozen.
 *
 * Driven by `bench/acbench.ts` (one command for a whole campaign), which sets these variables per model:
 *   ACBENCH_MODEL            a key of bench/frontier-models.ts MODELS (pinned OpenRouter hosts)
 *   ACBENCH_RUNS             independent authoring runs (default 5)
 *   ACBENCH_MINUTES          authoring wall clock per run (default 45)
 *   ACBENCH_MAX_USD_PER_RUN  per-run hard USD cap, runner estimate and the key's billed usage (default 10)
 *   ACBENCH_MAPS             comma-separated duel maps (default crossfire,twin_fords,crown)
 *   ACBENCH_SEEDS            scoring seeds per map (default 1)
 *   ACBENCH_OPPONENTS        comma-separated ladder rungs (default novice,standard,veteran,elite,champion)
 *   ACBENCH_HARNESS          opencode (default) or runner (PlayerThree's own loop, the baseline)
 *   ACBENCH_OPENCODE         the opencode binary (default ~/.local/opencode-1.19.5/…/opencode-linux-x64/bin/opencode)
 * Every setting is part of the suite digest: runs are comparable only within one suite.
 */
import type { BenchConfig } from '@playerthree/bench';
import { createBenchmarkSuite, RUNNER_HARNESS, type CampaignConfig } from '@playerthree/bench/campaign';
import { openCodeHarness } from '@playerthree/bench/opencode';
import { benchmarkSourceDigest } from '@playerthree/bench/source-digest';
import { benchmarkDigest } from 'playerthree/benchmark';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { STARTERS } from '../packages/game/src/agent/manifest.ts';
import { PLANES } from '../packages/game/src/rules/vocabulary.ts';
import { MODELS, PRICING, openRouter, type FrontierModel } from './frontier-models.ts';
import { ACBENCH } from './acbench-settings.ts';
import { BUILD, isRung, ladderSeries, resolveLadderMatch } from './acbench-ladder.ts';


const env = process.env;
const id = env.ACBENCH_MODEL ?? '';
if (!(id in MODELS)) throw new Error(`ACBENCH_MODEL: one of ${Object.keys(MODELS).join(', ')}`);
const list = (value: string | undefined, fallback: readonly string[]) => value ? value.split(',').map(s => s.trim()).filter(Boolean) : [...fallback];
const count = (value: string | undefined, fallback: number, name: string) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};
const runs = count(env.ACBENCH_RUNS, ACBENCH.runs, 'ACBENCH_RUNS');
const minutes = count(env.ACBENCH_MINUTES, ACBENCH.minutes, 'ACBENCH_MINUTES');
const maxUsdPerRun = count(env.ACBENCH_MAX_USD_PER_RUN, ACBENCH.maxUsdPerRun, 'ACBENCH_MAX_USD_PER_RUN');
const seedsPerMap = count(env.ACBENCH_SEEDS, ACBENCH.seedsPerMap, 'ACBENCH_SEEDS');
const maps = list(env.ACBENCH_MAPS, ACBENCH.maps);
const opponents = list(env.ACBENCH_OPPONENTS, ACBENCH.opponents);
if (!opponents.every(isRung)) throw new Error(`ACBENCH_OPPONENTS: from ${Object.keys(ACBENCH.ladder).join(', ')}`);
const harnessKind = env.ACBENCH_HARNESS ?? ACBENCH.harness;
if (!Number.isInteger(runs) || !Number.isInteger(seedsPerMap) || seedsPerMap > ACBENCH.scoringSeeds.length) throw new Error(`ACBENCH_RUNS and ACBENCH_SEEDS must be integers; at most ${ACBENCH.scoringSeeds.length} seeds per map`);
if (harnessKind !== 'opencode' && harnessKind !== 'runner') throw new Error('ACBENCH_HARNESS: opencode or runner');
const seeds = ACBENCH.scoringSeeds.slice(0, seedsPerMap);

const [gameDigest, runnerDigest] = await Promise.all([benchmarkSourceDigest(BUILD.game), benchmarkSourceDigest(BUILD.runner)]);

const candidateId = ACBENCH.candidateId;
const authoring = { practiceSeeds: [...ACBENCH.practiceSeeds], maxOutputTokens: ACBENCH.maxOutputTokens, maxWallMs: Math.round(minutes * 60_000), starters: { ...STARTERS } };
const budgets = { maxTokens: ACBENCH.maxTokens, maxTurns: ACBENCH.maxTurns, maxCostUsd: String(maxUsdPerRun) };
const spec = ladderSeries({ maps, seeds, rungs: opponents, gameDigest, budgets, authoring });
const entrants = spec.entrants;
const model = { ...openRouter(id as FrontierModel), billing: 'openrouter-key' as const };
const bench: BenchConfig = { definition, resolve: resolveLadderMatch, spec, models: { [candidateId]: model } };
const harness = harnessKind === 'opencode' ? await openCodeHarness({ bin: env.ACBENCH_OPENCODE ?? ACBENCH.opencode }) : undefined;
// A suite id names exact contents (the dev store refuses one id with two contents): the settings and both build pins.
const suiteKey = benchmarkDigest({ runs, minutes, maxUsdPerRun, maps, seeds, opponents, harness: harness?.identity ?? RUNNER_HARNESS, gameDigest, runnerDigest }).slice(0, ACBENCH.suiteKeyChars);
const suite = createBenchmarkSuite(bench, {
  id: `${ACBENCH.id}-${suiteKey}`, version: ACBENCH.version,
  title: `ACBench v1: four-plane authored policies, ${minutes} min wall clock, ${harness ? `OpenCode ${harness.identity.version}` : 'PlayerThree runner'}; ${opponents.join('/')} bots both sides on ${maps.join(', ')} × ${seedsPerMap} seed(s)`,
  track: 'authored-policy', candidateId, roles: [...PLANES], replicates: runs,
  build: { gameDigest, runnerDigest },
  references: entrants.filter(e => e.id !== candidateId).map(e => ({ id: e.id, digest: benchmarkDigest({ entrant: e, policies: null, gameVersion: spec.gameVersion }) })),
  strata: maps.map(name => ({ id: name, weight: 1 })),
  blocks: spec.scenarios.map(s => ({ scenarioId: s.id, blockId: s.id, stratumId: s.id.slice(0, s.id.indexOf('-seed-')) })),
  harness: harness ? { ...harness.identity } : { ...RUNNER_HARNESS }, bootstrapSeed: 1729, bootstrapReplicates: 2000,
});

export default {
  bench, suite, candidateId, build: BUILD, pricing: PRICING, ...(harness ? { harness } : {}),
  // provider/model equal the proxied request: the OpenAI-compatible protocol routed by OpenRouter (label).
  system: { id: id.replace(/[^A-Za-z0-9_.-]/g, '-'), label: `${id} (via OpenRouter)`, provider: 'openai', model: model.model,
    harness: `${suite.harness.id}/${suite.harness.version}`,
    configurationDigest: benchmarkDigest({ division: 'common-harness', version: 1, roles: [...PLANES], tools: harness ? 'opencode-mcp-bridge-no-bash-no-web' : 'playerthree-policy-authoring', starters: 'predeployed', practiceSeeds: ACBENCH.practiceSeeds, reasoning: 'provider-default', route: 'openrouter-pinned-hosts', gameDigest }) },
  consent: { results: true, attribution: true, artifacts: false, research: true, training: false, license: 'CC-BY-4.0' },
} satisfies CampaignConfig;
