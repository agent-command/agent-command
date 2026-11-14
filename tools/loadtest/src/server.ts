/** Private measurement server. Public creation/join protocols are unchanged; warmup is not an HTTP option.
 * NODE_ENV=production LOADTEST_WARMUP_TICKS=9600 LOADTEST_SEED=1 node tools/loadtest/src/server.ts
 * Use a fresh process for each concurrency so histograms and retained match history cannot contaminate it.
 */
import { createGameServer } from '../../../apps/server/src/app.ts';
import { loadConfig } from '../../../apps/server/src/config.ts';

function integer(key: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in [${min},${max}]`);
  return value;
}
const warmupTicks = integer('LOADTEST_WARMUP_TICKS', 9600, 0, 36_000);
const seed = integer('LOADTEST_SEED', 1, 0, 0x7fff_ffff);
const config = loadConfig();
const server = createGameServer(config, undefined, { warmupTicks, seed });
const port = await server.listen();
console.log(JSON.stringify({ event: 'loadtest_server_ready', port, pid: process.pid, warmupTicks, seed, simSpeed: config.simSpeed, workers: config.simWorkers }));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (closing) return;
  closing = true;
  void server.close().then(() => { process.exitCode = 0; }, (error: unknown) => { console.error(error); process.exitCode = 1; });
});
