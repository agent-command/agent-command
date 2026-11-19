/**
 * ACBench cloud runner: one campaign's model drivers (`bench/acbench.ts`, one per model) at a fixed concurrency on one
 * OpenRouter key, under a campaign-wide hard stop. The container's start command; the job comes from argv[2] or
 * RUNNER_JOB (JSON), else the runner idles (results stay on the volume for retrieval).
 *
 *   RUNNER_JOB='{"data":"/data/acbench-v1","models":["glm-5.3","qwen4-max"],"concurrency":5,"maxUsdTotal":300,
 *     "maxUsdPerRun":40,"baseline":true,"expect":{"gameDigest":"…","runnerDigest":"…"}}'
 * `runs` (per model, run in turn by its driver), `minutes` and `maxUsdPerRun` default to ACBENCH's (3, 45, 40).
 *
 * Spending, with several runs on one key:
 * - Per run: each run's own metering proxy caps it at maxUsdPerRun from OpenRouter's reported per-turn cost; the
 *   key-wide per-run watch is withheld from the campaign processes (bench/runner/per-run-billing.mjs), because under
 *   concurrency it would count every other run's spend.
 * - Campaign: a model driver starts only while the key's billed usage since the campaign baseline (driver.json) plus
 *   one run's cap fits maxUsdTotal (acbench.ts refuses the same, and the campaign refuses each further run of a model
 *   whose cap no longer fits); while any driver runs the usage is polled every POLL_MS, and at maxUsdTotal -
 *   stopMarginUsd every driver is stopped (SIGTERM: authoring in progress becomes an interrupted attempt, nothing
 *   further is launched). A model's runs can spend up to runs × maxUsdPerRun: size maxUsdTotal for every model's runs.
 * Before anything runs, the build's game and runner digests must equal `expect` (the frozen build's).
 * Events: <data>/runner-events.log and stdout.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { access, appendFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { routerKeyUsage } from '@playerthree/bench';
import { benchmarkSourceDigest } from '@playerthree/bench/source-digest';
import { BUILD } from '../acbench-ladder.ts';
import { ACBENCH } from '../acbench-settings.ts';
import { MODELS } from '../frontier-models.ts';

const POLL_MS = 30_000;
const OPENROUTER = 'https://openrouter.ai/api';
const root = fileURLToPath(new URL('../../', import.meta.url));
const preload = fileURLToPath(new URL('./per-run-billing.mjs', import.meta.url));

interface Job {
  data: string; models: string[]; concurrency: number; maxUsdTotal: number; runs?: number; minutes?: number; maxUsdPerRun?: number;
  baseline: boolean; stopMarginUsd?: number; expect: { gameDigest: string; runnerDigest: string };
}
const raw = process.argv[2] ?? process.env.RUNNER_JOB;
if (!raw) { console.log('runner idle: no RUNNER_JOB'); setInterval(() => {}, 1 << 30); await Promise.withResolvers<never>().promise; }
const job = JSON.parse(raw!) as Job;
for (const model of job.models) if (!(model in MODELS)) throw new Error(`unknown model ${model}`);
const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) throw new Error('OPENROUTER_API_KEY unset');
const margin = job.stopMarginUsd ?? 2;

await mkdir(job.data, { recursive: true, mode: 0o700 });
const eventsPath = join(job.data, 'runner-events.log');
const log = async (message: string) => { const line = `${new Date().toISOString()} ${message}`; console.log(line); await appendFile(eventsPath, `${line}\n`); };

const digests = { gameDigest: await benchmarkSourceDigest(BUILD.game), runnerDigest: await benchmarkSourceDigest(BUILD.runner) };
if (digests.gameDigest !== job.expect.gameDigest || digests.runnerDigest !== job.expect.runnerDigest) {
  await log(`REFUSED: build digests ${JSON.stringify(digests)} differ from the frozen build's ${JSON.stringify(job.expect)}`);
  process.exit(3);
}
await log(`start ${JSON.stringify({ ...job, expect: undefined })}; digests match (game ${digests.gameDigest.slice(0, 12)}, runner ${digests.runnerDigest.slice(0, 12)})`);

// The campaign directory acbench.ts derives from these settings (its defaults for everything not set here).
const settings = { harness: ACBENCH.harness, start: ACBENCH.start, maps: ACBENCH.maps.join(','), seeds: String(ACBENCH.seedsPerMap), opponents: ACBENCH.opponents.join(',') };
const runs = job.runs ?? ACBENCH.runs, minutes = job.minutes ?? ACBENCH.minutes, maxUsdPerRun = job.maxUsdPerRun ?? ACBENCH.maxUsdPerRun;
const campaign = join(job.data, `${settings.harness}-${settings.start}-${minutes}m-${runs}r-${settings.maps.replaceAll(',', '+')}-${settings.seeds}s-${settings.opponents.replaceAll(',', '+')}`);
const keyFile = '/tmp/openrouter.key';
await writeFile(keyFile, key, { mode: 0o600 });
const exists = (path: string) => access(path).then(() => true, () => false);
const complete = async (model: string) => {
  try { return !!JSON.parse(await readFile(join(campaign, model, 'publication.json'), 'utf8')).score?.complete; } catch { return false; }
};
const baselineDone = () => exists(join(campaign, 'baseline', 'scored.json'));
// Nothing of ours runs at boot: a lock left by a previous container names a dead process (whose pid may be reused).
for (const entry of await readdir(campaign).catch(() => [])) await unlink(join(campaign, entry, 'campaign.lock')).catch(() => {});

// The container's CPU share is a quota over every host core it may use, not a cpuset: pinning runs to a few host cores
// would only crowd them, so every driver gets this process's whole affinity list.
const cores = /^Cpus_allowed_list:\s*(\S+)$/m.exec(await readFile('/proc/self/status', 'utf8'))?.[1] ?? '0';
const childEnv = { ...process.env, OPENROUTER_API_KEY: undefined, RUNNER_JOB: undefined,
  NODE_OPTIONS: `--max-old-space-size=2048 --import=${preload}` } as NodeJS.ProcessEnv;
const driverArgs = (model: string, maxTotal: number) => ['bench/acbench.ts', '--models', model, '--max-usd-total', String(maxTotal), '--cores', cores,
  '--runs', String(runs), '--minutes', String(minutes), '--max-usd-per-run', String(maxUsdPerRun), '--data', job.data, '--no-import', '--key-file', keyFile];

/** `code` is undefined while the driver runs. */
interface Running { proc: ChildProcess; code?: number | null; startedAt: number }
const running = new Map<string, Running>();
function launch(name: string, model: string, maxTotal: number) {
  const out = join(job.data, `driver-${name}.log`);
  const proc = spawn('sh', ['-c', `exec nice -n 10 "$0" "$@" >> '${out}' 2>&1`, process.execPath, ...driverArgs(model, maxTotal)], { cwd: root, env: childEnv, stdio: 'ignore' });
  const entry: Running = { proc, startedAt: Date.now() };
  proc.once('exit', code => { entry.code = code; });
  running.set(name, entry);
}
async function spent(): Promise<number | null> {
  const usage = await routerKeyUsage(OPENROUTER, key!);
  if (usage === null) return null;
  const { baselineUsd } = JSON.parse(await readFile(join(campaign, 'driver.json'), 'utf8')) as { baselineUsd: number };
  return +(usage - baselineUsd).toFixed(6);
}

// The start baseline first: it creates driver.json (the campaign's billed baseline) and scores the skeleton.
if (job.baseline && !await baselineDone()) {
  launch('baseline', job.models[0]!, 0);
  await log(`launch baseline (driver.json + skeleton scoring) on cores ${cores}`);
}
const pending: string[] = [];
for (const model of job.models) if (await complete(model)) await log(`skip ${model}: complete`); else pending.push(model);
const retried = new Set<string>();
let halted = false;
let lastSpent: number | null = null;
while (running.size || (pending.length && !halted)) {
  const hasDriver = await exists(join(campaign, 'driver.json'));
  if (hasDriver) {
    const now = await spent();
    if (now === null) await log('key usage unavailable: launches paused');
    else {
      lastSpent = now;
      if (!halted && now >= job.maxUsdTotal - margin) {
        halted = true;
        await log(`HARD STOP: ${now.toFixed(4)} USD billed since the campaign baseline reaches ${job.maxUsdTotal} - ${margin}; stopping ${[...running.keys()].join(', ') || 'nothing'}`);
        for (const [name, r] of running) if (name !== 'baseline') r.proc.kill('SIGTERM');
      }
    }
  }
  for (const [name, r] of running) {
    if (r.code === undefined) continue;
    const code = r.code;
    running.delete(name);
    const minutes = Math.round((Date.now() - r.startedAt) / 60_000);
    if (name === 'baseline') { await log(`done baseline: exit ${code}, ${minutes} min, ${await baselineDone() ? 'scored' : 'NOT SCORED'}`); continue; }
    const ok = await complete(name);
    await log(`done ${name}: exit ${code}, ${minutes} min, ${ok ? 'complete' : 'INCOMPLETE'}`);
    if (!ok && !halted && !retried.has(name)) { retried.add(name); pending.push(name); await log(`requeue ${name} once (its campaign resumes; an evaluated run is never re-authored)`); }
  }
  // A launch needs driver.json (the billed baseline), a free slot (the baseline's scoring holds one while it runs: a
  // service's memory fits `concurrency` scoring processes) and one more run's cap under the total.
  while (pending.length && !halted && hasDriver && lastSpent !== null && running.size < job.concurrency) {
    if (lastSpent + maxUsdPerRun > job.maxUsdTotal) { await log(`gate: ${lastSpent.toFixed(4)} + ${maxUsdPerRun} exceeds ${job.maxUsdTotal}; ${pending.join(', ')} wait`); break; }
    const model = pending.shift()!;
    launch(model, model, job.maxUsdTotal);
    await log(`launch ${model} (${lastSpent.toFixed(4)} USD billed so far)`);
    // acbench.ts reads the key's usage at start; stagger so each sees a settled ledger.
    await sleep(5_000);
  }
  // Before driver.json exists (no baseline job), the first model driver creates it alone.
  if (!hasDriver && !running.size && pending.length) {
    const model = pending.shift()!;
    launch(model, model, job.maxUsdTotal);
    await log(`launch ${model} (creates driver.json)`);
  }
  await sleep(hasDriver ? POLL_MS : 5_000);
}
await log(`queue ${halted ? 'HALTED' : 'empty'}; ${lastSpent?.toFixed(4) ?? 'n/a'} USD billed since the campaign baseline; incomplete: ${(await Promise.all(job.models.map(async m => await complete(m) ? null : m))).filter(Boolean).join(', ') || 'none'}`);
setInterval(() => {}, 1 << 30);
