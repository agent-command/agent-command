/**
 * Drives the frontier campaign under one billed spending cap: runs each planned live pairing
 * (`bench/frontier-live.config.ts`) or authored-policy campaign (`bench/frontier-authored.config.ts`) in turn, and
 * starts an item only while the OpenRouter key's usage over the recorded baseline plus that item's runner-enforced USD
 * cap stays within --limit. The runner prices are per-model ceilings, so an item never bills more than its cap and the
 * campaign never more than the limit. Finished items (results.json / publication.json present) are skipped on re-run.
 *
 *   node bench/frontier-run.ts --plan plan.json --data .data/bench/frontier --limit 40
 *
 * plan.json: [{ "kind": "live", "entrants": ["glm-5.3", "standard-bot"], "capUsd": 3 },
 *             { "kind": "authored", "model": "glm-5.3", "capUsd": 1 }]
 * The key is read from --key-file (default ~/.config/openrouter.key) into each child's environment only.
 * <data>/usage-baseline.txt holds `baseline_usage=<USD>`; every check is appended to <data>/usage-ledger.jsonl.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { access, appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { plan: { type: 'string' }, data: { type: 'string' }, limit: { type: 'string' }, 'key-file': { type: 'string' }, env: { type: 'string', multiple: true } } });
if (!values.plan || !values.data || !values.limit) throw new Error('--plan FILE --data DIRECTORY --limit USD [--env NAME=VALUE ...]');
type Item = { kind: 'live'; entrants: [string, string]; capUsd: number } | { kind: 'authored'; model: string; capUsd: number };
const plan: Item[] = JSON.parse(await readFile(resolve(values.plan), 'utf8'));
const data = resolve(values.data);
const limit = Number(values.limit);
const key = (await readFile(values['key-file'] ?? join(homedir(), '.config/openrouter.key'), 'utf8')).trim();
const baseline = Number(/baseline_usage=([\d.]+)/.exec(await readFile(join(data, 'usage-baseline.txt'), 'utf8'))?.[1]);
if (!key || !Number.isFinite(baseline) || !Number.isFinite(limit)) throw new Error('missing key, baseline or limit');
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../bin/playerthree-bench.ts', import.meta.resolve('@playerthree/bench')));
const extraEnv = Object.fromEntries((values.env ?? []).map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));

async function spent(label: string): Promise<number> {
  const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`key usage unavailable: HTTP ${response.status}`);
  const body: unknown = await response.json();
  const usage = body && typeof body === 'object' && 'data' in body && body.data && typeof body.data === 'object' && 'usage' in body.data ? Number(body.data.usage) : NaN;
  if (!Number.isFinite(usage)) throw new Error('key usage missing from response');
  const delta = +(usage - baseline).toFixed(6);
  await appendFile(join(data, 'usage-ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), label, usage, spent: delta })}\n`);
  return delta;
}
const exists = (path: string) => access(path).then(() => true, () => false);

for (const item of plan) {
  const name = item.kind === 'live' ? `${item.entrants[0]}-vs-${item.entrants[1]}` : item.model;
  const out = join(data, item.kind, name);
  if (await exists(join(out, item.kind === 'live' ? 'results.json' : 'publication.json'))) { console.log(`skip ${item.kind} ${name}: already exported`); continue; }
  const before = await spent(`before ${item.kind} ${name}`);
  if (before + item.capUsd > limit) { console.log(`STOP before ${item.kind} ${name}: ${before.toFixed(4)} billed + ${item.capUsd} cap > ${limit}`); process.exitCode = 2; break; }
  await mkdir(out, { recursive: true, mode: 0o700 });
  const args = item.kind === 'live'
    ? [cli, '--config', 'bench/frontier-live.config.ts', '--out', out]
    : [cli, 'campaign', '--config', 'bench/frontier-authored.config.ts', '--out', out, '--max-campaign-usd', String(item.capUsd)];
  const env = { ...process.env, ...extraEnv, OPENROUTER_API_KEY: key, ...(item.kind === 'live' ? { FRONTIER_ENTRANTS: item.entrants.join(','), FRONTIER_MAX_USD: String(item.capUsd) } : { FRONTIER_MODEL: item.model }) };
  const log = await open(join(out, 'run.log'), 'a', 0o600);
  const started = Date.now();
  console.log(`run ${item.kind} ${name} (cap ${item.capUsd} USD; ${before.toFixed(4)} billed so far)`);
  const exit = Promise.withResolvers<number | null>();
  const child = spawn('taskset', ['-c', '2,3', 'nice', '-n', '10', 'timeout', '3600', process.execPath, ...args], { cwd: root, env, stdio: ['ignore', log.fd, log.fd] });
  child.once('error', exit.reject);
  child.once('exit', exit.resolve);
  const code = await exit.promise;
  // The key's usage lags generation billing; let it settle so the next gate sees this item's spend.
  await sleep(45_000);
  await log.close();
  const after = await spent(`after ${item.kind} ${name}`);
  console.log(`done ${item.kind} ${name}: exit ${code}, ${Math.round((Date.now() - started) / 1000)} s, billed ${(after - before).toFixed(4)} USD (total ${after.toFixed(4)})`);
}
