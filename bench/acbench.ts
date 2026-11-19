/**
 * ACBench v1 in one command: authors and scores every model's runs (`bench/acbench.config.ts`, one PlayerThree campaign
 * per model, run in turn), holds the whole campaign under one billed spending cap, scores the start baseline once
 * (no model calls), writes the chart-ready `summary.json` (headline: the score, beside improvement over the baseline)
 * and imports the complete publications into the local dev benchmark store (never production).
 *
 *   node bench/acbench.ts --models deepseek-v4.1-flash,glm-5.3 --runs 3 --minutes 45 \
 *     --max-usd-per-run 10 --max-usd-total 60 [--start skeleton|bots] [--harness opencode|runner] [--maps crossfire,twin_fords,crown] \
 *     [--seeds 1] [--opponents novice,standard,veteran,elite,champion] [--campaign NAME] [--data DIR] [--cores 2,3] [--dev-data DIR | --no-import]
 *
 * Results go to <data>/<campaign>/ (default data `.data/bench/acbench-v1`, campaign name derived from the settings, so
 * re-running the same command resumes it). The OpenRouter key is read from --key-file (default
 * ~/.config/openrouter.key) into each child's environment only. Spending: each model's campaign gets
 * `--max-campaign-usd` = its own committed spend plus what the total cap leaves after the key's billed usage since this
 * campaign's baseline, so no authoring run starts that could cross --max-usd-total; inside a run, the per-run cap
 * stops authoring on the runner estimate or the key's billed delta, whichever reaches it first. Two drivers may share
 * one campaign directory (other models, other `--cores`); the key's usage then counts both, and so does the cap.
 */
import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { routerKeyUsage } from '@playerthree/bench';
import { ACBENCH, STARTS, isStart } from './acbench-settings.ts';
import { MODELS } from './frontier-models.ts';
import { writeSummary } from './acbench-summary.ts';

/** The key's usage lags generation billing: settle before reading it after a model's campaign. */
const BILLING_SETTLE_MS = 45_000;
/** A whole model campaign (all its runs plus scoring) is killed past this, hours per run plus scoring. */
const CHILD_HOURS_PER_RUN = 2;
const OPENROUTER = 'https://openrouter.ai/api';

const { values } = parseArgs({ options: {
  models: { type: 'string' }, runs: { type: 'string' }, minutes: { type: 'string' }, 'max-usd-per-run': { type: 'string' }, 'max-usd-total': { type: 'string' },
  harness: { type: 'string' }, maps: { type: 'string' }, seeds: { type: 'string' }, opponents: { type: 'string' },
  campaign: { type: 'string' }, data: { type: 'string' }, 'dev-data': { type: 'string' }, 'no-import': { type: 'boolean' }, 'key-file': { type: 'string' }, help: { type: 'boolean' },
  start: { type: 'string' }, cores: { type: 'string' },
} });
if (values.help || !values.models || !values['max-usd-total']) {
  console.log(`node bench/acbench.ts --models a,b --max-usd-total USD [--runs ${ACBENCH.runs}] [--minutes ${ACBENCH.minutes}] [--max-usd-per-run ${ACBENCH.maxUsdPerRun}] [--start skeleton|bots] [--harness opencode|runner] [--maps …] [--seeds ${ACBENCH.seedsPerMap} (seed pairs per map)] [--opponents …] [--campaign NAME] [--data DIR] [--cores 2,3] [--dev-data DIR | --no-import]`);
  process.exit(values.help ? 0 : 64);
}
const models = values.models.split(',').map(s => s.trim()).filter(Boolean);
for (const model of models) if (!(model in MODELS)) throw new Error(`unknown model ${model}; one of ${Object.keys(MODELS).join(', ')}`);
const settings = {
  runs: values.runs ?? String(ACBENCH.runs), minutes: values.minutes ?? String(ACBENCH.minutes), maxUsdPerRun: values['max-usd-per-run'] ?? String(ACBENCH.maxUsdPerRun),
  harness: values.harness ?? ACBENCH.harness, maps: values.maps ?? ACBENCH.maps.join(','), seeds: values.seeds ?? String(ACBENCH.seedsPerMap), opponents: values.opponents ?? ACBENCH.opponents.join(','),
  start: values.start ?? ACBENCH.start,
};
if (!isStart(settings.start)) throw new Error(`--start: one of ${STARTS.join(', ')}`);
/** The cores model runs and their scoring take (taskset), at lower priority than interactive work. */
const cores = values.cores ?? '2,3';
if (!/^\d+([,-]\d+)*$/.test(cores)) throw new Error('--cores: a taskset core list, e.g. 2,3');
const maxTotal = Number(values['max-usd-total']);
if (!Number.isFinite(maxTotal) || maxTotal < 0) throw new Error('--max-usd-total must be a nonnegative number');
const root = fileURLToPath(new URL('../', import.meta.url));
const name = values.campaign ?? `${settings.harness}-${settings.start === 'bots' ? '' : `${settings.start}-`}${settings.minutes}m-${settings.runs}r-${settings.maps.replaceAll(',', '+')}-${settings.seeds}s-${settings.opponents.replaceAll(',', '+')}`;
if (!/^[A-Za-z0-9_.+-]{1,200}$/.test(name)) throw new Error('--campaign: letters, digits and _ . + - only');
const dir = resolve(values.data ?? join(root, '.data/bench/acbench-v1'), name);
await mkdir(dir, { recursive: true, mode: 0o700 });
const key = (await readFile(values['key-file'] ?? join(homedir(), '.config/openrouter.key'), 'utf8')).trim();
if (!key) throw new Error('empty OpenRouter key file');
const cli = fileURLToPath(new URL('../bin/playerthree-bench.ts', import.meta.resolve('@playerthree/bench')));
const exists = (path: string) => access(path).then(() => true, () => false);

// The billed baseline is taken once per campaign directory, so a resumed campaign keeps counting from its start.
const driverPath = join(dir, 'driver.json');
interface Driver { campaign: string; settings: typeof settings; models: string[]; maxUsdTotal: number; baselineUsd: number; startedAt: string; durations: Record<string, number[]> }
let driver: Driver;
if (await exists(driverPath)) {
  driver = JSON.parse(await readFile(driverPath, 'utf8'));
  if (JSON.stringify(driver.settings) !== JSON.stringify(settings)) throw new Error(`${dir} was started with other settings; choose another --campaign`);
  driver.models = [...new Set([...driver.models, ...models])];
  driver.maxUsdTotal = maxTotal;
} else {
  const baselineUsd = await routerKeyUsage(OPENROUTER, key);
  if (baselineUsd === null) throw new Error('OpenRouter key usage unavailable; refusing to start without a billed baseline');
  driver = { campaign: name, settings, models, maxUsdTotal: maxTotal, baselineUsd, startedAt: new Date().toISOString(), durations: {} };
}
// Two drivers may share the directory: keep the other's models and durations from disk.
const ran = new Set<string>();
const saveDriver = async () => {
  const disk = await exists(driverPath) ? JSON.parse(await readFile(driverPath, 'utf8')) as Driver : null;
  if (disk) {
    driver.models = [...new Set([...disk.models, ...driver.models])];
    driver.durations = { ...disk.durations, ...Object.fromEntries(Object.entries(driver.durations).filter(([model]) => ran.has(model))) };
  }
  await writeFile(driverPath, `${JSON.stringify(driver, null, 2)}\n`, { mode: 0o600 });
};
await saveDriver();

async function billed(label: string): Promise<number> {
  const usage = await routerKeyUsage(OPENROUTER, key);
  if (usage === null) throw new Error('OpenRouter key usage unavailable');
  const spent = +(usage - driver.baselineUsd).toFixed(6);
  await appendFile(join(dir, 'usage-ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), label, usage, spent })}\n`, { mode: 0o600 });
  return spent;
}
/** A model campaign's committed authoring spend, as the P3 campaign itself counts it (unknown spend at the full per-run cap). */
async function committed(out: string): Promise<number> {
  try {
    const record = JSON.parse(await readFile(join(out, 'campaign.json'), 'utf8')) as { attempts: { costUsd: string | null }[] };
    return record.attempts.reduce((sum, a) => sum + (a.costUsd === null ? Number(settings.maxUsdPerRun) : Number(a.costUsd)), 0);
  } catch { return 0; }
}

let exitCode = 0;
for (const model of models) {
  const out = join(dir, model);
  const publication = join(out, 'publication.json');
  if (await exists(publication) && JSON.parse(await readFile(publication, 'utf8')).score?.complete) { console.log(`skip ${model}: campaign complete`); continue; }
  const before = await billed(`before ${model}`);
  const remaining = maxTotal - before;
  if (remaining < Number(settings.maxUsdPerRun)) { console.log(`STOP before ${model}: ${before.toFixed(4)} USD billed leaves ${remaining.toFixed(4)} of ${maxTotal}, under one run's cap`); exitCode = 2; break; }
  await mkdir(out, { recursive: true, mode: 0o700 });
  const ceiling = +((await committed(out)) + remaining).toFixed(6);
  const env = { ...process.env, OPENROUTER_API_KEY: key, ACBENCH_MODEL: model, ACBENCH_RUNS: settings.runs, ACBENCH_MINUTES: settings.minutes, ACBENCH_MAX_USD_PER_RUN: settings.maxUsdPerRun,
    ACBENCH_HARNESS: settings.harness, ACBENCH_MAPS: settings.maps, ACBENCH_SEEDS: settings.seeds, ACBENCH_OPPONENTS: settings.opponents, ACBENCH_START: settings.start };
  const log = await open(join(out, 'run.log'), 'a', 0o600);
  const started = Date.now();
  console.log(`run ${model}: ${settings.runs} run(s) × ${settings.minutes} min, campaign ceiling ${ceiling} USD (${before.toFixed(4)} billed so far)`);
  // Model runs and their scoring take the bench cores (--cores), at lower priority than interactive work.
  const hours = Number(settings.runs) * CHILD_HOURS_PER_RUN;
  const child = spawn('taskset', ['-c', cores, 'nice', '-n', '10', 'timeout', String(Math.ceil(hours * 3600)), process.execPath, cli, 'campaign', '--config', 'bench/acbench.config.ts', '--out', out, '--max-campaign-usd', String(ceiling)],
    { cwd: root, env, stdio: ['ignore', log.fd, log.fd] });
  const exit = Promise.withResolvers<number | null>();
  child.once('error', exit.reject);
  child.once('exit', exit.resolve);
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const code = await exit.promise;
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  await log.close();
  ran.add(model);
  (driver.durations[model] ??= []).push(Math.round((Date.now() - started) / 1000));
  await saveDriver();
  await sleep(BILLING_SETTLE_MS);
  const after = await billed(`after ${model}`);
  console.log(`done ${model}: exit ${code}, ${Math.round((Date.now() - started) / 1000)} s, billed ${(after - before).toFixed(4)} USD (campaign ${after.toFixed(4)} of ${maxTotal})`);
  if (code !== 0) exitCode = 1;
}

// The start baseline on the campaign's own ladder, once per campaign directory (scored like a run, zero tokens).
{
  const log = await open(join(dir, 'baseline.log'), 'a', 0o600);
  const child = spawn('taskset', ['-c', cores, 'nice', '-n', '10', 'timeout', String(CHILD_HOURS_PER_RUN * 3600), process.execPath, 'bench/acbench-rescore.ts', '--campaign', dir, '--baseline'],
    { cwd: root, stdio: ['ignore', log.fd, log.fd] });
  const exit = Promise.withResolvers<number | null>();
  child.once('error', exit.reject);
  child.once('exit', exit.resolve);
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const code = await exit.promise;
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  await log.close();
  if (code !== 0) { console.log(`baseline: exit ${code} (see ${join(dir, 'baseline.log')}); improvement stays n/a until it is scored`); exitCode = 1; }
}

const summary = await writeSummary(dir);
console.log(`summary ${join(dir, 'summary.json')}: baseline ${summary.baseline?.score ?? 'n/a'}; ${summary.scoreTable.map(row => `${row.model} score ${row.mean ?? 'n/a'} (improvement ${row.improvement ?? 'n/a'})`).join(', ')}`);

// Dev store only: never DATABASE_URL, always an explicit local DATA_DIR.
if (!values['no-import'] && exitCode === 0) {
  const complete = summary.models.filter(m => m.complete).map(m => join(dir, m.model, 'publication.json'));
  const marker = join(dir, 'imported.json');
  if (complete.length && !await exists(marker)) {
    const devData = resolve(values['dev-data'] ?? join(root, '.data'));
    const releaseId = `acbench-v1-${name}`.slice(0, 120).replace(/[^A-Za-z0-9_-]/g, '-');
    const preview = join(dir, `release-preview-${Date.now()}.json`);
    const publish = (args: string[]) => {
      const { DATABASE_URL: _prod, ...rest } = process.env;
      const done = Promise.withResolvers<number | null>();
      const p = spawn(process.execPath, ['bench/publish.ts', ...args], { cwd: root, env: { ...rest, DATA_DIR: devData }, stdio: 'inherit' });
      p.once('error', done.reject); p.once('exit', done.resolve);
      return done.promise;
    };
    const previewed = await publish(['--preview', preview, '--id', releaseId, '--title', `ACBench v1 (${name})`, ...complete.flatMap(file => ['--input', file])]);
    const imported = previewed === 0 ? await publish(['--import', preview, '--reviewed-privacy-consent']) : previewed;
    if (imported === 0) await writeFile(marker, `${JSON.stringify({ at: new Date().toISOString(), devData, releaseId, publications: complete }, null, 2)}\n`, { mode: 0o600 });
    else exitCode = 1;
  }
}
process.exitCode = exitCode;
