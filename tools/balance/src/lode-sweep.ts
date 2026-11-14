#!/usr/bin/env node
/** Short, paired-revision lode diagnostic. This is not the full balance acceptance sweep. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_TIME_CAP_TICKS } from '@agent-command/game';
import { evaluate } from './guardrails.ts';
import { aggregate } from './metrics.ts';
import { runBalance } from './bench.ts';
import { archive, toJson, type SweepResult } from './report.ts';
import { setMatches, standardPlan } from './spec.ts';

const { values } = parseArgs({ options: { label: { type: 'string' }, workers: { type: 'string', default: '2' }, out: { type: 'string', default: 'docs/balance' } }, strict: true });
if (!values.label || !/^[a-z0-9][a-z0-9._-]*$/.test(values.label)) throw new Error('--label is required (lowercase letters, digits, . _ -)');
const workers = Number(values.workers);
if (!Number.isSafeInteger(workers) || workers < 0) throw new Error('--workers must be a nonnegative integer');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const gameRoot = fileURLToPath(new URL('../../../packages/game/src/', import.meta.url));
const resolvedGame = fileURLToPath(import.meta.resolve('@agent-command/game'));
if (resolvedGame !== `${gameRoot}index.ts`) throw new Error(`Wrong worktree game dependency: ${resolvedGame}; expected ${gameRoot}index.ts`);
const hash = createHash('sha256');
for (const path of readdirSync(gameRoot, { recursive: true }).map(String).filter((p) => p.endsWith('.ts')).sort()) {
  hash.update(path).update('\0').update(readFileSync(`${gameRoot}${path}`)).update('\0');
}
const gameSourceSha256 = hash.digest('hex');
const gameDiff = execFileSync('git', ['diff', 'HEAD', '--', 'packages/game/src'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const plan = { layout: 'duel' as const, seeds: 6, probeSeeds: 0, probeLevels: [], mirrorLevels: ['standard' as const, 'veteran' as const], probes: [], terrains: ['open', 'ridges', 'canyons'] as const };
const sets = standardPlan(plan).filter((s) => s.kind === 'mirror');
const count = sets.reduce((sum, set) => sum + setMatches(set), 0);
process.stderr.write(`lode sweep: ${values.label}, ${count} matches, ${workers} concurrent matches, game source ${gameSourceSha256.slice(0, 12)}${gameDiff ? ' (uncommitted changes)' : ''}\n`);
const start = performance.now();
const bench = await runBalance(sets, DEFAULT_TIME_CAP_TICKS + 1, workers, `${root}bench-results/balance-${values.label}`,
  (done, total) => process.stderr.write(`${done}/${total}\n`));
const matches = bench.matches;
const stats = sets.map((s) => aggregate(s, matches.filter((m) => m.set === s.key)));
const result: SweepResult & { gameSourceSha256: string; gameEntry: string; gameDiff: string } = {
  label: values.label,
  gameSourceSha256,
  // Repo-relative: committed reports must not carry the author's machine paths.
  gameEntry: relative(root, resolvedGame),
  gameDiff,
  node: process.versions.node,
  workers,
  wallMs: Math.round(performance.now() - start),
  plan: { ...plan, terrains: [...plan.terrains] },
  sets: stats,
  guardrails: evaluate(stats),
  matches: matches.map(archive),
};
mkdirSync(values.out, { recursive: true });
writeFileSync(`${values.out}/${values.label}.json`, toJson(result));
for (const g of result.guardrails) process.stdout.write(`${g.pass ? 'pass' : 'FAIL'} ${g.id} ${g.set}: ${g.value}; target ${g.target}\n`);
process.stdout.write(`Wrote ${values.out}/${values.label}.json (${Math.round(result.wallMs / 1000)} s); mirror diagnostics only, ladder/probe guardrails not exercised.\n`);
