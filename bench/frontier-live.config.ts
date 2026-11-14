/**
 * Frontier live-command exhibition: OpenRouter models command the Surface seat in real time against
 * each other or the standard bot; every other plane is the standard bot for both sides. One pairing per invocation on
 * each public seed; the first entrant takes the nw slot, and FRONTIER_ORIENTATIONS=2 adds the mirrored match.
 * Not an ACBench publication track. `bench/frontier-run.ts` drives a campaign of pairings under one billed USD cap.
 *
 *   OPENROUTER_API_KEY=… FRONTIER_ENTRANTS=deepseek-v4.1-flash,glm-5.3 FRONTIER_MAX_USD=2 \
 *     playerthree-bench --config bench/frontier-live.config.ts --out .data/bench/frontier/live/<pairing>
 *
 * FRONTIER_SEEDS (default 4101), FRONTIER_TIME_CAP (game seconds, default 180: the ladder's minimum rated length) and
 * FRONTIER_ORIENTATIONS (default 1) must stay identical across a campaign.
 */
import type { BenchConfig } from '@playerthree/bench';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { botVersion } from '../packages/game/src/bots/packages.ts';
import { resolveArenaMatch } from '../packages/game/src/lobby/arena.ts';
import { seriesSpec } from './series.ts';
import { MODELS, openRouter, type FrontierModel } from './frontier-models.ts';

export const BOT = 'standard-bot';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`set ${name}`);
  return value;
};
const ids = env('FRONTIER_ENTRANTS').split(',');
if (ids.length !== 2 || ids[0] === ids[1] || ids.some(id => id !== BOT && !(id in MODELS))) throw new Error(`FRONTIER_ENTRANTS: two of ${[...Object.keys(MODELS), BOT].join(', ')}`);
const seeds = env('FRONTIER_SEEDS', '4101').split(',').map(Number);
const timeCap = Number(env('FRONTIER_TIME_CAP', '180'));
const orientations = Number(env('FRONTIER_ORIENTATIONS', '1'));
if (orientations !== 1 && orientations !== 2) throw new Error('FRONTIER_ORIENTATIONS: 1 or 2');
const maxUsd = env('FRONTIER_MAX_USD');
if (!/^\d+(\.\d+)?$/.test(maxUsd) || Number(maxUsd) <= 0) throw new Error('FRONTIER_MAX_USD: positive decimal hard cap for this pairing');

const models: Record<string, NonNullable<BenchConfig['models']>[string]> = {};
const entrants = ids.map(id => {
  if (id === BOT) return { id, label: 'Standard bot', kind: 'bot' as const, aiPlayer: true, botLevel: 'standard', botVersion: botVersion(definition.manifest, 'standard'), stateResetSource: 'runner' as const };
  models[id] = openRouter(id as FrontierModel);
  return { id, label: id, kind: 'agent' as const, aiPlayer: true, provider: 'openrouter', model: models[id].model, botLevel: 'standard', stateResetSource: 'runner' as const };
});

const spec = seriesSpec({
  track: 'live', entrants, seeds, ticks: timeCap * 20 + 200, concurrency: 2,
  options: { terrain: 'open', spire: { timeCap } },
  permutations: [[ids[0]!, ids[1]!], [ids[1]!, ids[0]!]].slice(0, orientations),
  policyRoles: Object.fromEntries(Object.keys(models).map(id => [id, ['surface']])),
  // Turn and token ceilings would forfeit a seat mid-match; only the pairing's USD cap is hard.
  budgets: { maxTokens: null, maxTurns: null, maxCostUsd: maxUsd },
});
// Live command plays in real time: model latency is part of the task.
spec.execution = { ...spec.execution, clock: 'realtime', speed: 1, maxWallMs: (timeCap + 600) * 1000 };

export default { definition, resolve: resolveArenaMatch, spec, models } satisfies BenchConfig;
