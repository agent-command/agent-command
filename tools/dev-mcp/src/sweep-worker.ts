/** One sweep thread: plays the matches it is sent with the game's own headless bot loop, one at a time. */
import { parentPort } from 'node:worker_threads';
import { playBotMatch } from '@agent-command/game';
import type { SweepJob, SweepJobResult } from './sweep.ts';

if (!parentPort) throw new Error('sweep-worker must run in a Worker');
const channel = parentPort;
channel.on('message', (job: SweepJob) => {
  const started = performance.now();
  const result = playBotMatch({ seed: job.seed, armies: job.armies, levels: job.levels, options: job.options, maxTicks: job.maxTicks });
  channel.postMessage({ outcome: result.outcome, rank: result.rank, ticks: result.ticks, ms: performance.now() - started } satisfies SweepJobResult);
});
