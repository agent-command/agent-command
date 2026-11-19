import type { BenchConfig } from '@playerthree/bench';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { STARTERS } from '../packages/game/src/agent/manifest.ts';
import { botVersion } from '../packages/game/src/bots/packages.ts';
import { seriesSpec } from './series.ts';
import { resolveArenaMatch } from '../packages/game/src/lobby/arena.ts';

// Author once, then evaluate every opponent orientation; practice seeds stay disjoint from held-out scenarios.
const model = {
      provider: 'scripted',
      model: 'surface-example-offline',
      // This is a deterministic integration baseline, not an LLM quality score.
      // No tokens are purchased or consumed; real providers report real usage.
      price: { inPerM: 0, outPerM: 0 },
      script: [
        {
          text: '',
          toolCalls: [{ id: 'briefing', name: 'game_briefing', args: {} }],
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        {
          text: '',
          // Deploy into the persistent commander's library BEFORE practice.
          // Merely passing a practice artifact would leave no active policy
          // for held-out evaluation and the benchmark would be invalid.
          toolCalls: [{
            id: 'deploy',
            name: 'policy_deploy',
            args: { from: STARTERS.surface },
          }],
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        {
          text: '',
          toolCalls: [
            { id: 'practice', name: 'practice_run', args: { opponent: 'novice', seed: 17, ticks: 200 } },
            { id: 'status', name: 'policy_status', args: {} },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        {
          // A tool-free turn explicitly ends lobby preparation; evaluation
          // retains the deployed library policy rather than falling back to a bot.
          text: 'Deployed the Surface starter.',
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      ],
} satisfies NonNullable<BenchConfig['models']>[string];

const opponents = ['novice', 'standard', 'veteran'] as const;
export default {
  definition,
  resolve: resolveArenaMatch,
  spec: seriesSpec({
    track: 'policy', seeds: [17011, 29009], ticks: 2400,
    entrants: [
      { id: 'surface-example', label: model.model, kind: 'agent', aiPlayer: true, provider: model.provider, model: model.model, botLevel: 'standard', stateResetSource: 'runner' },
      ...opponents.map((opponent) => {
        const version = botVersion(definition.manifest, opponent);
        return { id: opponent, label: opponent, kind: 'bot' as const, aiPlayer: true, botLevel: opponent, ...(version ? { botVersion: version } : {}), stateResetSource: 'runner' as const };
      }),
    ],
    permutations: opponents.flatMap((opponent) => [['surface-example', opponent], [opponent, 'surface-example']]),
    policyRoles: { 'surface-example': ['surface'] },
    budgets: { maxTurns: 6, maxTokens: 120000, maxCostUsd: '1' },
    authoring: { practiceSeeds: [17, 29], maxOutputTokens: 4096, maxWallMs: 60000 },
  }),
  models: { 'surface-example': model },
} satisfies BenchConfig;
