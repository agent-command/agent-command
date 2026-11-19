/**
 * ACBench scoring without model calls: the start baseline and re-scores of frozen policies.
 *
 *   node bench/acbench-rescore.ts --campaign <dir> [--opponents novice,…,champion]
 *     Replays every run's frozen policies of the campaign (its maps and seeds, from driver.json) against the current
 *     ladder (default ACBENCH.opponents), scores the campaign's start baseline on the same ladder, and writes the re-score's own
 *     summary.json and one publication per model. Output: <dir>/rescore-<key>/ (key: ladder, maps, seeds and both build
 *     digests), with rescore.json, baseline/, <model>/<run>/ results and <model>/publication.json; re-running resumes it.
 *   node bench/acbench-rescore.ts --campaign <dir> --baseline
 *     Scores the start baseline of the campaign's own settings into <dir>/baseline/ and rewrites <dir>/summary.json
 *     (`bench/acbench.ts` runs this after the model campaigns).
 *
 * Matches run at the suite's concurrency on whatever cores the caller pins the process to.
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ResultsEnvelope } from '@playerthree/bench';
import { createBenchmarkSuite, exportCampaignPublication, type CampaignRecord } from '@playerthree/bench/campaign';
import { benchmarkSourceDigest } from '@playerthree/bench/source-digest';
import type { PolicyArtifact } from 'playerthree';
import { benchmarkDigest, sealBenchmark, type BenchmarkPublication, type BenchmarkRun, type BenchmarkSuite } from 'playerthree/benchmark';
import { writeBenchmarkJson } from 'playerthree/benchmark-store';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { ACBENCH, isStart, type Rung, type SeedPair, type Start } from './acbench-settings.ts';
import { BUILD, START_REFS, isRung, ladderSeries, resolveLadderMatch, scoreFrozen, startPolicies, trialScores } from './acbench-ladder.ts';
import { BASELINE_DIR, writeSummary } from './acbench-summary.ts';

const exists = (path: string) => access(path).then(() => true, () => false);
const rungsOf = (list: string): Rung[] => {
  const rungs = list.split(',').map(s => s.trim()).filter(Boolean);
  if (!rungs.length || !rungs.every(isRung)) throw new Error(`ladder rungs: from ${Object.keys(ACBENCH.ladder).join(', ')}`);
  return rungs;
};

interface Ladder { maps: string[]; seeds: SeedPair[]; rungs: Rung[] }
/** The campaign's maps and seed pairs (driver.json `seeds`: pairs per map), and its own roster unless `rungs` replaces it. */
async function campaignLadder(dir: string, rungs?: Rung[]): Promise<Ladder> {
  const driver = JSON.parse(await readFile(join(dir, 'driver.json'), 'utf8')) as { settings: { maps: string; seeds: string; opponents: string } };
  const seeds = Number(driver.settings.seeds);
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > ACBENCH.scoringSeeds.length) throw new Error(`${dir}/driver.json: seeds must be 1–${ACBENCH.scoringSeeds.length} (seed pairs per map)`);
  return { maps: driver.settings.maps.split(','), seeds: [...ACBENCH.scoringSeeds.slice(0, seeds)], rungs: rungs ?? rungsOf(driver.settings.opponents) };
}

/** What the campaign's runs started from (driver.json; campaigns before the setting started from the bot starters). */
async function campaignStart(dir: string): Promise<Start> {
  const driver = JSON.parse(await readFile(join(dir, 'driver.json'), 'utf8')) as { settings: { start?: string } };
  const start = driver.settings.start ?? 'bots';
  if (!isStart(start)) throw new Error(`${dir}/driver.json: unknown start ${start}`);
  return start;
}

/**
 * Scores `policies` on `ladder` into `out` and records what it was scored with in `scored.json`, which marks it done:
 * an interrupted series still exports its `results.json`, so the next invocation scores it again.
 */
async function scoreInto(out: string, ladder: Ladder, gameDigest: string, policies: Record<string, PolicyArtifact>, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  if (await exists(join(out, 'scored.json'))) return;
  await mkdir(out, { recursive: true, mode: 0o700 });
  const started = Date.now();
  log(`scoring ${out}: ${ladder.rungs.join('/')} × both sides × ${ladder.maps.join(', ')} × ${ladder.seeds.length} seed pair(s)`);
  const results = await scoreFrozen(ladderSeries({ ...ladder, gameDigest }), policies, out, signal);
  if (results.state !== 'completed') return log(`${out}: series ${results.state}; re-run to score it again`);
  await writeFile(join(out, 'scored.json'), `${JSON.stringify({ at: new Date().toISOString(), wallSeconds: Math.round((Date.now() - started) / 1000), policies: benchmarkDigest(policies), ...ladder }, null, 2)}\n`, { mode: 0o600 });
}

/** The start baseline of the campaign's own settings, into `<dir>/baseline/`, then the campaign summary. */
export async function scoreCampaignBaseline(dir: string, signal: AbortSignal, log: (line: string) => void) {
  const gameDigest = await benchmarkSourceDigest(BUILD.game);
  await scoreInto(join(dir, BASELINE_DIR), await campaignLadder(dir), gameDigest, await startPolicies(await campaignStart(dir)), signal, log);
  return writeSummary(dir);
}

/**
 * Each model's re-score as a publication, `<rescore>/<model>/publication.json`: the campaign's suite with the re-score's
 * ladder and builds (a new suite id, `acbench-v1-<key>`), and the campaign's authored runs (artifacts, costs, times)
 * with their re-scored trials. Each trial's permutation names its opponent and the candidate's side
 * (`<opponent>-<side>`, see `ladderSeries`).
 */
export async function writeRescorePublications(dir: string, name: string): Promise<string[]> {
  const root = join(dir, name);
  const rescore = JSON.parse(await readFile(join(root, 'rescore.json'), 'utf8')) as Ladder & { build: BenchmarkSuite['build'] };
  const written: string[] = [];
  const starters = START_REFS[await campaignStart(dir)];
  for (const model of (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const campaign = join(dir, model, 'campaign.json');
    if (!await exists(campaign)) continue;
    const record = JSON.parse(await readFile(campaign, 'utf8')) as CampaignRecord;
    const { consent } = JSON.parse(await readFile(join(dir, model, 'publication.json'), 'utf8')) as BenchmarkPublication;
    const from = record.suite;
    const spec = ladderSeries({ ...rescore, gameDigest: rescore.build.gameDigest, budgets: from.authoring.budgets,
      authoring: { practiceSeeds: from.authoring.practiceSeeds, maxOutputTokens: ACBENCH.maxOutputTokens, maxWallMs: from.authoring.maxWallMs, starters: { ...starters } } });
    const suite = createBenchmarkSuite({ definition, resolve: resolveLadderMatch, spec }, {
      // The re-score's ladder and builds plus the authoring settings: models authored under different builds of one
      // campaign share it (each experiment's profile keeps its own authoring build).
      id: `${ACBENCH.id}-${benchmarkDigest({ rescore: name, authoring: from.authoring, harness: from.harness, track: from.track, roles: from.roles }).slice(0, ACBENCH.suiteKeyChars)}`, version: from.version,
      title: `ACBench re-score: four-plane authored policies, ${from.authoring.maxWallMs / 60_000} min wall clock, ${from.harness.id} ${from.harness.version}; ${rescore.rungs.join('/')} bots both sides on ${rescore.maps.join(', ')} × ${rescore.seeds.length} seed pair(s)`,
      track: from.track, candidateId: ACBENCH.candidateId, roles: from.roles, replicates: from.authoring.replicates, build: rescore.build,
      references: spec.entrants.filter(e => e.id !== ACBENCH.candidateId).map(e => ({ id: e.id, digest: benchmarkDigest({ entrant: e, policies: null, gameVersion: spec.gameVersion }) })),
      strata: rescore.maps.map(map => ({ id: map, weight: 1 })),
      blocks: spec.scenarios.map(s => ({ scenarioId: s.id, blockId: s.id, stratumId: s.id.slice(0, s.id.indexOf('-seed-')) })),
      harness: from.harness, bootstrapSeed: from.uncertainty.seed, bootstrapReplicates: from.uncertainty.replicates,
    });
    const { digest: _digest, ...experiment } = record.experiment;
    const runs = await Promise.all(record.runs.map(async (run): Promise<BenchmarkRun> => {
      if (run.status === 'failed') return run;
      const out = join(root, model, run.id);
      const results = JSON.parse(await readFile(join(out, 'results.json'), 'utf8')) as ResultsEnvelope;
      const { at } = JSON.parse(await readFile(join(out, 'scored.json'), 'utf8')) as { at: string };
      const scores = new Map(trialScores(results).map(t => [t.trialId, t]));
      const trials = results.tables.schedule.map(trial => {
        const { status, score } = scores.get(trial.trialId)!;
        return { trialId: trial.trialId, blockId: trial.scenarioId, stratumId: suite.blocks.find(b => b.scenarioId === trial.scenarioId)!.stratumId, permutationId: trial.permutationId,
          status, score, attempts: results.tables.matches.filter(m => m.trialId === trial.trialId).length };
      });
      return { ...run, status: trials.every(t => t.score !== null) ? 'evaluated' : 'frozen', seriesId: results.seriesId, seriesRevision: results.revision, trials, finishedAt: at };
    }));
    const publication = exportCampaignPublication({ ...record, suite, experiment: sealBenchmark({ ...experiment, suiteDigest: suite.digest }), runs }, consent);
    const file = join(root, model, 'publication.json');
    await writeBenchmarkJson(file, publication);
    written.push(file);
  }
  return written;
}

/**
 * Every frozen run of the campaign and its start baseline, re-scored on `rungs`, into `<dir>/rescore-<key>/`, then its
 * summary and publications.
 */
export async function rescoreCampaign(dir: string, rungs: Rung[], signal: AbortSignal, log: (line: string) => void) {
  const ladder = await campaignLadder(dir, rungs);
  const [gameDigest, runnerDigest] = await Promise.all([benchmarkSourceDigest(BUILD.game), benchmarkSourceDigest(BUILD.runner)]);
  const name = `rescore-${benchmarkDigest({ ...ladder, ladder: ACBENCH.ladder, gameDigest, runnerDigest }).slice(0, ACBENCH.suiteKeyChars)}`;
  const root = join(dir, name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'rescore.json'), `${JSON.stringify({ ...ladder, ladder: Object.fromEntries(rungs.map(r => [r, ACBENCH.ladder[r]])), build: { gameDigest, runnerDigest } }, null, 2)}\n`, { mode: 0o600 });
  await scoreInto(join(root, BASELINE_DIR), ladder, gameDigest, await startPolicies(await campaignStart(dir)), signal, log);
  for (const model of (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const campaign = join(dir, model, 'campaign.json');
    if (!await exists(campaign)) continue;
    const record = JSON.parse(await readFile(campaign, 'utf8')) as CampaignRecord;
    for (const run of record.runs) {
      if (signal.aborted) break;
      if (!run.artifactDigest) continue;
      const policies = JSON.parse(await readFile(join(dir, model, 'artifacts', `${run.artifactDigest}.json`), 'utf8')) as Record<string, PolicyArtifact>;
      if (benchmarkDigest(policies) !== run.artifactDigest) throw new Error(`${model} ${run.id}: frozen artifact integrity failure`);
      await scoreInto(join(root, model, run.id), ladder, gameDigest, policies, signal, log);
    }
  }
  const summary = await writeSummary(dir, name);
  return { name, summary, publications: signal.aborted ? [] : await writeRescorePublications(dir, name) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { campaign: { type: 'string' }, opponents: { type: 'string' }, baseline: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help || !values.campaign || (values.baseline && values.opponents)) {
    console.log('node bench/acbench-rescore.ts --campaign DIR [--opponents novice,standard,veteran,elite,champion] | --campaign DIR --baseline');
    process.exit(values.help ? 0 : 64);
  }
  const dir = resolve(values.campaign);
  // SIGINT/SIGTERM abort the running series; re-running resumes from the scored directories.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const log = (line: string) => console.log(line);
  if (values.baseline) {
    const summary = await scoreCampaignBaseline(dir, controller.signal, log);
    console.log(`baseline ${summary.baseline?.score ?? 'n/a'} → ${join(dir, 'summary.json')}`);
  } else {
    const { name, summary } = await rescoreCampaign(dir, rungsOf(values.opponents ?? ACBENCH.opponents.join(',')), controller.signal, log);
    console.log(`baseline ${summary.baseline?.score ?? 'n/a'}; ${summary.scoreTable.map(row => `${row.model} improvement ${row.improvement ?? 'n/a'} (score ${row.mean ?? 'n/a'})`).join(', ')} → ${join(dir, name, 'summary.json')}`);
  }
}
