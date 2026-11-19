/**
 * The chart-ready `summary.json` of one ACBench v1 campaign directory (`bench/acbench.ts` writes it after every
 * invocation, `bench/acbench-rescore.ts` for each re-score). The headline is the **score**, a run's ladder win rate;
 * beside it **improvement**, the score minus the start baseline's (the four policies every run starts from: the
 * economy-only skeletons, or the bot starters for campaigns that started there, untouched, scored on the same ladder,
 * maps and seeds). Then a score table (win rate and improvement, mean and spread
 * per model, per rung and per map), score vs cost per run, practice vs score, run-to-run variance, the baseline and
 * every run's record (served host, harness, tokens, costs, practice, deploy timeline, frozen policy hashes, scoring
 * matches with their replays and transcript paths). Reads only the PlayerThree campaign outputs and the scored
 * baseline; paths in it are relative to the campaign directory.
 *
 *   node bench/acbench-summary.ts --campaign .data/bench/acbench-v1/<campaign>
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CampaignRecord } from '@playerthree/bench/campaign';
import type { ResultsEnvelope } from '@playerthree/bench';
import { MODELS, PRICING } from './frontier-models.ts';
import { ACBENCH } from './acbench-settings.ts';
import { trialScores, type TrialScore } from './acbench-ladder.ts';

/** Where a campaign's start baseline is scored (`<campaign>/baseline`, or `<rescore>/baseline`). */
export const BASELINE_DIR = 'baseline';

interface Ledger {
  harness: { id: string; version: string }; model: string; request: { provider?: unknown } | null; reason: string; servedBy: Record<string, number>; servedByUnresolved: number;
  wallMs: number; turns: number; inputTokens: number; outputTokens: number; reportedUsd: number | null; billed: { deltaUsd: number | null } | null;
  practice: { at: string; role: string; opponent: string; seed: number; outcome: string }[];
  deploys: { kind: 'deploy' | 'rollback'; at: string; role: string; version: number; by?: string; from?: string | null; digest?: string }[];
  policyDigests: Record<string, string>; transcripts: string[];
}
const round = (x: number) => +x.toFixed(4);
const mean = (xs: number[]) => xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
/** Sample standard deviation (n − 1); null below two values. */
const sd = (xs: number[]) => {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return round(Math.sqrt(xs.reduce((n, x) => n + (x - m) ** 2, 0) / (xs.length - 1)));
};
const spread = (xs: number[]) => ({ n: xs.length, mean: mean(xs), sd: sd(xs), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null });
const values = (xs: (number | null)[]) => xs.flatMap(x => x === null ? [] : [x]);
const readJson = async <T>(path: string): Promise<T | null> => { try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; } };

/** Win rate (draws half) over scored trials, overall and grouped by rung and by map. */
function ladderScore(trials: readonly Pick<TrialScore, 'opponent' | 'map' | 'score'>[]) {
  const scored = trials.filter(t => t.score !== null);
  const group = (key: (t: typeof scored[number]) => string) => {
    const groups: Record<string, number[]> = {};
    for (const t of scored) (groups[key(t)] ??= []).push(t.score!);
    return Object.fromEntries(Object.entries(groups).map(([k, xs]) => [k, mean(xs)]));
  };
  return { complete: scored.length === trials.length && trials.length > 0, score: mean(scored.map(t => t.score!)), perOpponent: group(t => t.opponent), perMap: group(t => t.map) };
}

/** A scored baseline directory (`results.json` of the start policies), or null before it is scored. */
export async function readBaseline(campaignDir: string, dir: string) {
  const file = join(dir, 'results.json');
  const results = await readJson<ResultsEnvelope>(file);
  if (!results) return null;
  const matches = trialScores(results);
  const { complete, ...score } = ladderScore(matches);
  return { complete, ...score, results: relative(campaignDir, file), matches };
}
type Baseline = NonNullable<Awaited<ReturnType<typeof readBaseline>>>;

/**
 * One run's chart-ready record. Its trials are the campaign's own evaluation, or with `rescore` the run's frozen
 * policies re-scored under `<rescore>/<model>/<run>/results.json`.
 */
async function runEntry(dir: string, model: string, record: CampaignRecord, run: CampaignRecord['runs'][number], baseline: Baseline | null, rescore: string | null) {
  const attempt = record.attempts.filter(a => a.runId === run.id).at(-1);
  const ledgerFile = attempt ? join('authoring', `${run.id}-${attempt.number}.json`) : null;
  const ledger = ledgerFile ? await readJson<Ledger>(join(dir, model, ledgerFile)) : null;
  const resultsFile = rescore ? join(rescore, model, run.id, 'results.json') : join(model, 'results', run.id, 'results.json');
  const results = await readJson<ResultsEnvelope>(join(dir, resultsFile));
  const scored = results ? trialScores(results) : [];
  let matches: (TrialScore & { replay: string | null })[];
  let ladder: ReturnType<typeof ladderScore>;
  if (rescore) {
    matches = scored.map(t => ({ ...t, replay: null }));
    ladder = ladderScore(scored);
  } else {
    // The campaign's adjudication stays authoritative; the results envelope adds sides, durations and replays.
    const byTrial = new Map(scored.map(t => [t.trialId, t]));
    matches = run.trials.map(t => {
      const trial = byTrial.get(t.trialId);
      const accepted = results?.tables.matches.find(m => m.trialId === t.trialId && m.acceptedAttempt);
      const replay = results?.tables.artifacts.find(a => a.matchId === accepted?.matchId && a.kind === 'replay');
      return { trialId: t.trialId, map: t.stratumId, seed: trial?.seed ?? 0, opponent: trial?.opponent ?? '?', side: trial?.side ?? '?', status: t.status, score: t.score,
        simulatedSeconds: trial?.simulatedSeconds ?? null, wallMs: trial?.wallMs ?? null,
        replay: replay ? join(model, 'results', run.id, 'replays', `${encodeURIComponent(replay.id)}.json`) : null };
    });
    ladder = ladderScore(matches);
    ladder.complete = run.status === 'evaluated';
  }
  // A run without artifacts (authoring failed) scores 0; an unfinished evaluation has no score yet.
  const score = run.status === 'failed' ? 0 : ladder.complete ? ladder.score : null;
  const first = ledger?.deploys.find(d => d.kind === 'deploy')?.at;
  const practiceOpponents: Record<string, number> = {};
  for (const p of ledger?.practice ?? []) practiceOpponents[p.opponent] = (practiceOpponents[p.opponent] ?? 0) + 1;
  const chargedUsd = run.cost.amount === null ? null : +Number(run.cost.amount).toFixed(6);
  const baselineScore = baseline?.complete ? baseline.score : null;
  return {
    model, modelId: ledger?.model ?? MODELS[model as keyof typeof MODELS]?.model ?? null, run: run.id, status: run.status, reason: run.reason,
    score, baselineScore, improvement: score === null || baselineScore === null ? null : round(score - baselineScore),
    perOpponent: ladder.perOpponent, perMap: ladder.perMap,
    harness: ledger ? `${ledger.harness.id}/${ledger.harness.version}` : null, reasoning: record.suite.authoring.reasoning ?? 'provider-default',
    providerPinned: (ledger?.request?.provider ?? null) as unknown, servedBy: ledger?.servedBy ?? {}, servedByUnresolved: ledger?.servedByUnresolved ?? 0,
    wallMs: ledger?.wallMs ?? null, turns: ledger?.turns ?? null, inputTokens: ledger?.inputTokens ?? null, outputTokens: ledger?.outputTokens ?? null,
    cost: { chargedUsd, chargedSource: run.cost.source, reportedUsd: ledger?.reportedUsd === null || ledger?.reportedUsd === undefined ? null : +ledger.reportedUsd.toFixed(6), billedUsd: ledger?.billed?.deltaUsd ?? null },
    practice: { count: ledger?.practice.length ?? 0, opponents: practiceOpponents, results: ledger?.practice ?? [] },
    deploys: (ledger?.deploys ?? []).map(d => ({ ...d, t: first ? Math.round((Date.parse(d.at) - Date.parse(first)) / 1000) : null })),
    policyDigests: ledger?.policyDigests ?? {}, artifactDigest: run.artifactDigest,
    transcripts: (ledger?.transcripts ?? []).map(file => join(model, file)), authoring: ledgerFile ? join(model, ledgerFile) : null,
    results: results ? resultsFile : null, matches,
  };
}
type RunEntry = Awaited<ReturnType<typeof runEntry>>;

/**
 * Writes `summary.json` for the campaign in `dir`: into `dir` itself, or with `rescore` (a directory under `dir`
 * holding a re-score's baseline and per-run results) into that directory, scored from its results.
 */
export async function writeSummary(dir: string, rescore: string | null = null) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();
  const driver = await readJson<{ settings: Record<string, string>; baselineUsd: number; durations: Record<string, number[]> }>(join(dir, 'driver.json'));
  const ledgerLines = (await readFile(join(dir, 'usage-ledger.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { spent: number });
  const baseline = await readBaseline(dir, join(dir, rescore ?? '', BASELINE_DIR));
  const rescoreMeta = rescore ? await readJson<Record<string, unknown>>(join(dir, rescore, 'rescore.json')) : null;
  const runs: RunEntry[] = [];
  const models = [];
  for (const model of entries) {
    const record = await readJson<CampaignRecord>(join(dir, model, 'campaign.json'));
    if (!record) continue;
    const publication = await readJson<{ score: { complete: boolean; value: number | null } }>(join(dir, model, 'publication.json'));
    const modelRuns = await Promise.all(record.runs.map(run => runEntry(dir, model, record, run, baseline, rescore)));
    runs.push(...modelRuns);
    const opponents = [...new Set(modelRuns.flatMap(r => Object.keys(r.perOpponent)))];
    const maps = [...new Set(modelRuns.flatMap(r => Object.keys(r.perMap)))].sort();
    const costOf = (r: typeof modelRuns[number]) => r.cost.chargedUsd ?? r.cost.billedUsd;
    models.push({ model, modelId: record.experiment.system.model, harness: record.experiment.system.harness, suiteDigest: record.suite.digest,
      complete: rescore ? modelRuns.every(r => r.score !== null) : publication?.score.complete ?? false,
      publicationScore: rescore ? null : publication?.score.value ?? null,
      improvement: spread(values(modelRuns.map(r => r.improvement))), score: spread(values(modelRuns.map(r => r.score))),
      perOpponent: Object.fromEntries(opponents.map(o => [o, spread(values(modelRuns.map(r => r.perOpponent[o] ?? null)))])),
      perMap: Object.fromEntries(maps.map(m => [m, spread(values(modelRuns.map(r => r.perMap[m] ?? null)))])),
      cost: spread(values(modelRuns.map(costOf))),
      wallMinutes: spread(modelRuns.flatMap(r => r.wallMs === null ? [] : [+(r.wallMs / 60000).toFixed(2)])), campaignSeconds: driver?.durations[model] ?? [] });
  }
  const summary = {
    format: 'acbench.summary', version: 2, generatedAt: new Date().toISOString(), campaign: relative(resolve(dir, '..'), dir), settings: driver?.settings ?? null,
    rescore: rescore ? { dir: rescore, ...rescoreMeta } : null,
    suite: models[0] ? { digest: models[0].suiteDigest, harness: models[0].harness } : null,
    scoring: { headline: 'score', improvement: 'score − baselineScore', score: 'win rate over the ladder (every rung × both sides × maps × seeds), each trial as the game decides it (at the time cap: fewer crowns lost, then more total Spire HP, then more contested-point score), draws and timeouts half',
      baseline: `the four ${(driver?.settings.start ?? 'bots') === 'bots' ? 'default bot starters' : 'economy-only skeletons'} every run starts from (policy_deploy {from}, default knobs), untouched, on the same ladder, maps and seeds`, ladder: ACBENCH.ladder },
    pricing: { ...PRICING, note: 'chargedUsd: what the run was charged against its cap (chargedSource router-reported, else runner-estimate: cache-aware list prices for turns without a reported cost); reportedUsd: the router-reported part; billedUsd: the key\'s usage delta around the run (account-wide, includes the preflight).' },
    billing: { baselineUsd: driver?.baselineUsd ?? null, billedUsd: ledgerLines.at(-1)?.spent ?? null },
    baseline,
    scoreTable: models.map(m => ({ model: m.model, n: m.score.n, improvement: m.improvement.mean, improvementSd: m.improvement.sd, mean: m.score.mean, sd: m.score.sd, min: m.score.min, max: m.score.max,
      baselineScore: baseline?.complete ? baseline.score : null, publicationScore: m.publicationScore,
      perOpponent: Object.fromEntries(Object.entries(m.perOpponent).map(([o, s]) => [o, s.mean])), meanCostUsd: m.cost.mean, complete: m.complete })),
    scoreVsCost: runs.map(r => ({ model: r.model, run: r.run, score: r.score, improvement: r.improvement, costUsd: r.cost.chargedUsd ?? r.cost.billedUsd, ...r.cost })),
    practiceVsScore: runs.map(r => ({ model: r.model, run: r.run, practiceRuns: r.practice.count, practiceOpponents: r.practice.opponents, deploys: r.deploys.filter(d => d.kind === 'deploy' && d.by === 'model').length, score: r.score, improvement: r.improvement })),
    variance: models.map(m => ({ model: m.model, scores: runs.filter(r => r.model === m.model).map(r => r.score), improvements: runs.filter(r => r.model === m.model).map(r => r.improvement), ...m.score,
      range: m.score.min === null || m.score.max === null ? null : round(m.score.max - m.score.min) })),
    models, runs,
  };
  await writeFile(join(dir, rescore ?? '', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

if (import.meta.main) {
  const { values: args } = parseArgs({ options: { campaign: { type: 'string' } } });
  if (!args.campaign) throw new Error('--campaign DIRECTORY');
  const summary = await writeSummary(resolve(args.campaign));
  console.log(`${summary.runs.length} run(s) → ${join(resolve(args.campaign), 'summary.json')}`);
}
