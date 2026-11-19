/**
 * Reference bars for an ACBench version (a release step, docs/benchmarks/acbench.md "Release a version"): each built-in
 * tier scored as the candidate on a campaign's own ladder (its maps, seed pairs and rungs from driver.json), exactly as a
 * model's frozen policies are scored: the tier's four built bot packages (`pnpm --filter @agent-command/game bots:build`)
 * as the candidate's frozen per-plane scripts. Elite and champion are the veteran packages with the rung's income
 * handicap on the candidate's army too. `starters` is the default starters bar: the four stock starter policies
 * (`STARTERS`, default knobs, exactly what `policy_deploy {from}` deploys) at normal income. Sim only, no model calls.
 *
 *   node bench/acbench-reference-bots.ts --campaign <dir> [--tiers novice,standard,veteran,elite,champion,starters] [--release acbench-v0-N]
 *
 * Output: <dir>/reference-bots/<tier>/ (results.json and the series) with scored.json (score, per-opponent and
 * per-map win rates, every trial); re-running skips scored tiers. Once every tier is scored, the release's curated
 * `REFERENCES` entry (apps/web/src/benchmarks/model.ts): every tier plus the campaign's start baseline (summary.json),
 * strongest first, in <dir>/reference-bots/references.json and on stdout. Never a model publication.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runBench, type BenchConfig, type MatchSpec } from '@playerthree/bench';
import { benchmarkSourceDigest } from '@playerthree/bench/source-digest';
import type { PolicyArtifact } from 'playerthree';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { botPackages } from '../packages/game/src/bots/packages.ts';
import { NO_HANDICAP } from '../packages/game/src/rules/match-rules.ts';
import { PLANES } from '../packages/game/src/rules/vocabulary.ts';
import type { Reference, References } from '../apps/web/src/benchmarks/model.ts';
import { ACBENCH, type Rung, type Start } from './acbench-settings.ts';
import { BUILD, isRung, ladderSeries, resolveLadderMatch, startPolicies, trialScores } from './acbench-ladder.ts';

/** The default starters bar's tier id: the stock starters as the candidate, beside the built-in tiers. */
export const STARTERS_TIER = 'starters';
export type ReferenceTier = Rung | typeof STARTERS_TIER;
const isReferenceTier = (id: string): id is ReferenceTier => id === STARTERS_TIER || isRung(id);

/** What `referencesEntry` reads per tier from `<tier>/scored.json`. */
export interface ScoredTier { tier: ReferenceTier; score: number | null; complete: boolean; trials: readonly unknown[] }

/**
 * A release's curated `REFERENCES` entry: every scored tier (its label naming the bot and any income handicap) and the
 * start baseline when scored, strongest first. Every tier must be complete: a version ships all its bars or none.
 */
export function referencesEntry(tiers: readonly ScoredTier[], baseline: { start: Start; score: number } | null): References {
  const incomplete = tiers.filter((t) => !t.complete || t.score === null).map((t) => t.tier);
  if (!tiers.length || incomplete.length) throw new Error(`reference tiers not completely scored: ${incomplete.join(', ') || 'none scored'}`);
  const games = tiers[0]!.trials.length;
  const bars: Reference[] = tiers.map(({ tier, score }) => {
    if (tier === STARTERS_TIER) return { id: tier, label: 'Default starters', score: score! };
    const { level, income } = ACBENCH.ladder[tier];
    const name = income === NO_HANDICAP ? level : tier;
    return { id: tier, label: `${name[0]!.toUpperCase()}${name.slice(1)} bot${income === NO_HANDICAP ? '' : ` (${level}, ×${income} income)`}`, score: score! };
  });
  if (baseline) bars.push({ id: baseline.start, label: baseline.start === 'skeleton' ? 'Starting skeleton' : 'Bot starters', score: baseline.score });
  const starters = tiers.some((t) => t.tier === STARTERS_TIER);
  return {
    source: `Each built-in tier's four bot packages${starters ? ' and the four default starter policies (default knobs)' : ''} played as the candidate on the same ${games}-game ladder${baseline ? `, and the untouched ${baseline.start === 'skeleton' ? 'skeleton' : 'starter'} policies every run starts from` : ''}.`,
    bars: bars.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { campaign: { type: 'string' }, tiers: { type: 'string' }, release: { type: 'string' } } });
  if (!values.campaign) throw new Error('node bench/acbench-reference-bots.ts --campaign DIR [--tiers novice,…,champion,starters] [--release acbench-v0-N]');
  const dir = resolve(values.campaign);
  const tiers = (values.tiers ?? [...ACBENCH.opponents, STARTERS_TIER].join(',')).split(',').filter(Boolean);
  if (!tiers.every(isReferenceTier)) throw new Error(`--tiers: from ${[...Object.keys(ACBENCH.ladder), STARTERS_TIER].join(', ')}`);
  // A release id names its suite design version: suite version N ships as ACBench v0.N.
  const release = values.release ?? `acbench-v0-${ACBENCH.version}`;
  const driver = JSON.parse(await readFile(join(dir, 'driver.json'), 'utf8')) as { settings: { maps: string; seeds: string; opponents: string } };
  const ladder = { maps: driver.settings.maps.split(','), seeds: ACBENCH.scoringSeeds.slice(0, Number(driver.settings.seeds)), rungs: driver.settings.opponents.split(',') as Rung[] };
  const gameDigest = await benchmarkSourceDigest(BUILD.game);
  const spec = ladderSeries({ ...ladder, gameDigest });
  const packages = botPackages(definition.manifest);
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const scoredPath = (tier: string) => join(dir, 'reference-bots', tier, 'scored.json');
  const exists = (path: string) => access(path).then(() => true, () => false);

  for (const tier of tiers as ReferenceTier[]) {
    const out = join(dir, 'reference-bots', tier);
    if (await exists(scoredPath(tier))) { console.log(`skip ${tier}: scored`); continue; }
    await mkdir(out, { recursive: true, mode: 0o700 });
    const { level, income } = tier === STARTERS_TIER ? { level: null, income: NO_HANDICAP } : ACBENCH.ladder[tier];
    const policies: Record<string, PolicyArtifact> = level === null ? await startPolicies('bots') : {};
    if (level !== null) for (const plane of PLANES) {
      const pkg = packages.get(`${level}/${plane}`);
      if (!pkg) throw new Error(`no ${level} bot package for ${plane}: run bots:build`);
      policies[plane] = { runtime: 'js', code: pkg.script };
    }
    // The ladder's handicaps and side seeds, plus the tier's own handicap on the candidate's army.
    const resolveMatch = (match: MatchSpec): MatchSpec => {
      const resolved = resolveLadderMatch(match);
      const side = resolved.bindings.find(binding => binding.entrantId === ACBENCH.candidateId)?.seat.team;
      const options = resolved.options as { handicap?: { income?: Record<string, number> } };
      return side === undefined ? resolved : { ...resolved, options: { ...options, handicap: { ...options.handicap, income: { ...options.handicap?.income, [side]: income } } } };
    };
    const { authoring: _authoring, ...evaluation } = spec;
    const config: BenchConfig = { definition, resolve: resolveMatch, spec: { ...evaluation, budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null } }, policies: { [ACBENCH.candidateId]: policies } };
    const started = Date.now();
    console.log(`scoring ${tier} (${level === null ? 'default starters' : `${level} packages`}, income ×${income}) on ${ladder.rungs.join('/')} × both sides × ${ladder.maps.join(', ')}`);
    const results = await runBench(config, { outDir: out });
    if (results.state !== 'completed') { console.log(`${tier}: series ${results.state}; re-run to score it again`); continue; }
    const trials = trialScores(results);
    const scored = trials.filter(t => t.score !== null);
    const by = (key: (t: typeof trials[number]) => string) => Object.fromEntries([...new Set(trials.map(key))].map(k => [k, mean(scored.filter(t => key(t) === k).map(t => t.score!))]));
    const summary = { tier, level, income, gameDigest, ...ladder, complete: scored.length === trials.length, score: mean(scored.map(t => t.score!)),
      perOpponent: by(t => t.opponent), perMap: by(t => t.map), wins: trials.filter(t => t.status === 'win').length,
      winsPerOpponent: Object.fromEntries(ladder.rungs.map(rung => [rung, trials.filter(t => t.opponent === rung && t.status === 'win').length])), trials, wallSeconds: Math.round((Date.now() - started) / 1000) };
    await writeFile(scoredPath(tier), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    console.log(`${tier}: score ${summary.score} (${summary.wins}/${trials.length} wins) ${JSON.stringify(summary.perOpponent)}`);
  }

  const scored = await Promise.all((tiers as ReferenceTier[]).map(async tier => await exists(scoredPath(tier)) ? JSON.parse(await readFile(scoredPath(tier), 'utf8')) as ScoredTier : null));
  if (scored.every(tier => tier !== null)) {
    const summary = await readFile(join(dir, 'summary.json'), 'utf8').then(text => JSON.parse(text) as { settings: { start?: Start } | null; baseline: { complete: boolean; score: number | null } | null }, () => null);
    const baseline = summary?.baseline?.complete && summary.baseline.score !== null ? { start: summary.settings?.start ?? 'bots', score: summary.baseline.score } : null;
    const entry = referencesEntry(scored, baseline);
    await writeFile(join(dir, 'reference-bots', 'references.json'), `${JSON.stringify({ release, gameDigest, entry }, null, 2)}\n`, { mode: 0o600 });
    if (!baseline) console.log('no scored start baseline in summary.json: the entry has no start bar (bench/acbench-rescore.ts --campaign DIR --baseline)');
    console.log(`REFERENCES entry for apps/web/src/benchmarks/model.ts:\n  '${release}': ${JSON.stringify(entry)},`);
  }
}
