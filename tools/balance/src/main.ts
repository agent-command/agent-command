#!/usr/bin/env node
/**
 * Agent Command balance harness (DESIGN §11).
 *
 *   node tools/balance/src/main.ts sweep --label phase-a [--layout ffa] [--seeds 24] [--probe-seeds 10] [--terrain open,ridges,canyons] [--size 48,64] [--check]
 *   node tools/balance/src/main.ts check docs/balance/phase-a.json
 *   node tools/balance/src/main.ts hunt --label hunt-phase-a [--max-usd 0.50]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_TIME_CAP_TICKS, MAP_SIZES, OPPONENTS, PLANES, TERRAIN_PRESETS, type Opponent, type Plane } from '@agent-command/game';
import { evaluate, type GuardrailResult } from './guardrails.ts';
import { huntMarkdown, runHunt, type HuntResult } from './hunt.ts';
import { DEFAULT_WORKERS, runBalance } from './bench.ts';
import { aggregate } from './metrics.ts';
import { PROBES } from './probes.ts';
import { archive, toJson, toMarkdown, type SweepResult } from './report.ts';
import { LAYOUTS, LEVELS, setMatches, standardPlan } from './spec.ts';

const USAGE = `usage: node tools/balance/src/main.ts <command> [options]

  sweep  Run the standard sweep of one layout (mirrors, duel tier ladder, strategy probes); write docs/balance/<label>.md + .json
    --label <name>            report name (required)
    --layout <id>             map layout every run set plays: ${LAYOUTS.join(' | ')} (default duel; ffa = four-army free-for-all)
    --seeds <n>               seeds per mirror and per ladder orientation (default 24; 0 = probes only)
    --probe-seeds <n>         seeds per probe and orientation (default 10)
    --probes <ids|none>       comma-separated probe ids (default every probe of the layout: ${PROBES.map((p) => `${p.id}${p.layouts.length < LAYOUTS.length ? ` (${p.layouts.join('/')})` : ''}`).join(', ')})
    --probe-levels <levels>   bot levels probes play at (default standard,veteran)
    --mirror-levels <levels>  bot levels that play mirrors (default ${LEVELS.join(',')})
    --terrain <presets>       terrain presets to play every run set on, comma-separated (${TERRAIN_PRESETS.join(',')})
    --size <sizes>            map sizes to play every run set on, comma-separated (${MAP_SIZES.join(',')}; default the game's)
    --workers <n>             concurrent matches (default ${DEFAULT_WORKERS} = half the cores, at most the series runner's limit; 0 = serial)
    --out <dir>               output directory (default docs/balance)
    --bench-out <dir>         benchmark artifacts (default bench-results/balance-<label>)
    --ticks <n>               hard tick cap (default game's 30 min cap + 1; shorter runs are diagnostics)
    --check                   exit 1 if a guardrail fails

  check <file.json>           evaluate the guardrails on a sweep result; exit 1 if any fails
  render <file.json>          rewrite the markdown next to a sweep or hunt result (after report or guardrail changes)

  hunt   LLM exploit hunt: agents practice against the bots, looking for degenerate strategies
    --label <name>            report name (required)
    --max-usd <usd>           hard total spend limit across all roles (default 0.50)
    --model <id>              default gpt-5-mini (OPENAI_API_KEY) or claude-haiku-5-5 (ANTHROPIC_API_KEY)
    --roles <planes>          seats to hunt with, one agent each in turn (default ${PLANES.join(',')})
    --max-turns <n>           model turns per role (default 24)
    --eval-seeds <n>          seeds per orientation when re-playing the final policies (default 6)
    --out <dir>               output directory (default docs/balance)`;

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_OUT = fileURLToPath(new URL('../../../docs/balance/', import.meta.url));

const fail = (msg: string): never => {
  process.stderr.write(`balance: ${msg}\n`);
  process.exit(64);
};
const int = (v: string | undefined, name: string, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
};
const list = (v: string | undefined): string[] | undefined => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean));

function levels(v: string | undefined, fallback: readonly Opponent[]): Opponent[] {
  const out = list(v) ?? [...fallback];
  for (const l of out) if (!(OPPONENTS as readonly string[]).includes(l)) fail(`unknown level ${l} (${OPPONENTS.join(', ')})`);
  return out as Opponent[];
}

function printGuardrails(gs: readonly GuardrailResult[]): boolean {
  for (const g of gs) process.stdout.write(`${g.pass ? 'pass' : 'FAIL'}  ${g.id.padEnd(20)} ${g.set.padEnd(40)} ${g.value}  (target ${g.target})\n`);
  const failed = gs.filter((g) => !g.pass).length;
  process.stdout.write(failed ? `${failed} of ${gs.length} guardrails failing\n` : `all ${gs.length} guardrails pass\n`);
  return failed === 0;
}

async function sweep(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      label: { type: 'string' },
      seeds: { type: 'string' },
      'probe-seeds': { type: 'string' },
      probes: { type: 'string' },
      'probe-levels': { type: 'string' },
      'mirror-levels': { type: 'string' },
      layout: { type: 'string' },
      terrain: { type: 'string' },
      size: { type: 'string' },
      workers: { type: 'string' },
      out: { type: 'string' },
      'bench-out': { type: 'string' },
      ticks: { type: 'string' },
      check: { type: 'boolean' },
    },
    strict: true,
  });
  const label = values.label ?? fail('--label is required');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(label)) fail('--label: lowercase letters, digits, . _ - only');
  const probeIds = values.probes === 'none' ? [] : list(values.probes);
  const terrains = list(values.terrain)?.map((t) => TERRAIN_PRESETS.find((p) => p === t) ?? fail(`unknown terrain ${t} (${TERRAIN_PRESETS.join(', ')})`));
  const sizes = list(values.size)?.map((s) => MAP_SIZES.find((size) => String(size) === s) ?? fail(`unknown map size ${s} (${MAP_SIZES.join(', ')})`));
  const layout = values.layout === undefined ? 'duel' : LAYOUTS.find((l) => l === values.layout) ?? fail(`unknown layout ${values.layout} (${LAYOUTS.join(', ')})`);
  const plan = {
    layout,
    seeds: int(values.seeds, 'seeds', 24),
    probeSeeds: int(values['probe-seeds'], 'probe-seeds', 10),
    probeLevels: levels(values['probe-levels'], ['standard', 'veteran']),
    mirrorLevels: levels(values['mirror-levels'], LEVELS),
    ...(probeIds ? { probes: probeIds } : {}),
    ...(terrains ? { terrains } : {}),
    ...(sizes ? { sizes } : {}),
  };
  const workers = int(values.workers, 'workers', DEFAULT_WORKERS);
  const sets = standardPlan(plan).filter((set) => set.seeds.length > 0);
  // One tick past the game's own cap by default; shorter diagnostic runs do not establish full-match pacing.
  const ticks = int(values.ticks, 'ticks', DEFAULT_TIME_CAP_TICKS + 1);
  const total = sets.reduce((sum, set) => sum + setMatches(set), 0);
  const benchOut = values['bench-out'] ?? `${REPO}bench-results/balance-${label}`;
  process.stderr.write(`balance: ${label}: ${total} matches in ${sets.length} run sets on ${workers} workers\n`);
  const t0 = performance.now();
  const bench = await runBalance(sets, ticks, workers, benchOut, (done, count) => {
    if (done % 10 === 0 || done === count) process.stderr.write(`  ${done}/${count} (${Math.round((performance.now() - t0) / 1000)} s)\n`);
  });
  const matches = bench.matches;
  const stats = sets.map((s) => aggregate(s, matches.filter((m) => m.set === s.key)));
  const result: SweepResult = {
    label,
    node: process.versions.node,
    workers,
    wallMs: Math.round(performance.now() - t0),
    plan: {
      layout,
      seeds: plan.seeds,
      probeSeeds: plan.probeSeeds,
      probeLevels: plan.probeLevels,
      mirrorLevels: plan.mirrorLevels,
      probes: probeIds ?? PROBES.filter((p) => p.layouts.includes(layout)).map((p) => p.id),
      ...(terrains ? { terrains } : {}),
      ...(sizes ? { sizes } : {}),
    },
    sets: stats,
    guardrails: evaluate(stats),
    matches: matches.map(archive),
  };
  const out = values.out ?? DEFAULT_OUT;
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/${label}.json`, toJson(result));
  writeFileSync(`${out}/${label}.md`, toMarkdown(result));
  process.stderr.write(`balance: wrote ${out}/${label}.md and .json in ${Math.round(result.wallMs / 1000)} s\n`);
  printGuardrails(result.guardrails);
  process.stderr.write(`balance: canonical benchmark artifacts under ${benchOut}/<set>/\n`);
  if (values.check && result.guardrails.some((guardrail) => !guardrail.pass)) process.exitCode = 1;
}

/** Guardrails are re-evaluated from the run-set stats, so guardrail changes apply to old sweeps too. */
function check(args: string[]): void {
  const result = JSON.parse(readFileSync(args[0] ?? fail('check: pass a sweep result JSON'), 'utf8')) as SweepResult;
  if (!printGuardrails(evaluate(result.sets))) process.exitCode = 1;
}

/** Rewrite the markdown next to a sweep or hunt result. */
function render(args: string[]): void {
  const file = args[0] ?? fail('render: pass a sweep or hunt result JSON');
  const data = JSON.parse(readFileSync(file, 'utf8')) as SweepResult | HuntResult;
  const md = file.replace(/\.json$/, '.md');
  writeFileSync(md, 'roles' in data ? huntMarkdown(data) : toMarkdown({ ...data, guardrails: evaluate(data.sets) }));
  process.stderr.write(`balance: wrote ${md}\n`);
}

async function hunt(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      label: { type: 'string' },
      'max-usd': { type: 'string' },
      model: { type: 'string' },
      roles: { type: 'string' },
      'max-turns': { type: 'string' },
      'eval-seeds': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const label = values.label ?? fail('--label is required');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(label)) fail('--label: lowercase letters, digits, . _ - only');
  const maxUsd = Number(values['max-usd'] ?? '0.50');
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) fail('--max-usd must be a positive number');
  const roles = (list(values.roles) ?? [...PLANES]) as Plane[];
  for (const r of roles) if (!(PLANES as readonly string[]).includes(r)) fail(`unknown role ${r}`);
  await runHunt({
    label,
    maxUsd,
    roles,
    maxTurns: int(values['max-turns'], 'max-turns', 24),
    evalSeeds: int(values['eval-seeds'], 'eval-seeds', 6),
    out: values.out ?? DEFAULT_OUT,
    ...(values.model ? { model: values.model } : {}),
  });
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'sweep':
    await sweep(rest);
    break;
  case 'check':
    check(rest);
    break;
  case 'render':
    render(rest);
    break;
  case 'hunt':
    await hunt(rest);
    break;
  case undefined:
  case '-h':
  case '--help':
    process.stdout.write(`${USAGE}\n`);
    break;
  default:
    fail(`unknown command ${command}\n${USAGE}`);
}
