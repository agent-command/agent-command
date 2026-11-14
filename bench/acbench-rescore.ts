/**
 * ACBench scoring without model calls: the starters baseline and re-scores of frozen policies.
 *
 *   node bench/acbench-rescore.ts --campaign <dir> [--opponents novice,…,champion]
 *     Replays every run's frozen policies of the campaign (its maps and seeds, from driver.json) against the current
 *     ladder (default ACBENCH.opponents), scores the starters baseline on the same ladder, and writes the re-score's own
 *     summary.json. Output: <dir>/rescore-<key>/ (key: ladder, maps, seeds and both build digests), with rescore.json,
 *     baseline/ and <model>/<run>/ results; re-running resumes it.
 *   node bench/acbench-rescore.ts --campaign <dir> --baseline
 *     Scores the starters baseline of the campaign's own settings into <dir>/baseline/ and rewrites <dir>/summary.json
 *     (`bench/acbench.ts` runs this after the model campaigns).
 *
 * Matches run at the suite's concurrency on whatever cores the caller pins the process to.
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CampaignRecord } from '@playerthree/bench/campaign';
import { benchmarkSourceDigest } from '@playerthree/bench/source-digest';
import type { PolicyArtifact } from 'playerthree';
import { benchmarkDigest } from 'playerthree/benchmark';
import { ACBENCH, type Rung } from './acbench-settings.ts';
import { BUILD, isRung, ladderSeries, scoreFrozen, starterPolicies } from './acbench-ladder.ts';
import { BASELINE_DIR, writeSummary } from './acbench-summary.ts';

const exists = (path: string) => access(path).then(() => true, () => false);
const rungsOf = (list: string): Rung[] => {
  const rungs = list.split(',').map(s => s.trim()).filter(Boolean);
  if (!rungs.length || !rungs.every(isRung)) throw new Error(`ladder rungs: from ${Object.keys(ACBENCH.ladder).join(', ')}`);
  return rungs;
};

interface Ladder { maps: string[]; seeds: number[]; rungs: Rung[] }
/** The campaign's maps and seeds (driver.json), and its own roster unless `rungs` replaces it. */
async function campaignLadder(dir: string, rungs?: Rung[]): Promise<Ladder> {
  const driver = JSON.parse(await readFile(join(dir, 'driver.json'), 'utf8')) as { settings: { maps: string; seeds: string; opponents: string } };
  const seeds = Number(driver.settings.seeds);
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > ACBENCH.scoringSeeds.length) throw new Error(`${dir}/driver.json: seeds must be 1–${ACBENCH.scoringSeeds.length}`);
  return { maps: driver.settings.maps.split(','), seeds: ACBENCH.scoringSeeds.slice(0, seeds), rungs: rungs ?? rungsOf(driver.settings.opponents) };
}

/**
 * Scores `policies` on `ladder` into `out` (its `results.json` marks it done, so an interrupted score resumes) and
 * records what it was scored with in `scored.json`.
 */
async function scoreInto(out: string, ladder: Ladder, gameDigest: string, policies: Record<string, PolicyArtifact>, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  if (await exists(join(out, 'results.json'))) return;
  await mkdir(out, { recursive: true, mode: 0o700 });
  const started = Date.now();
  log(`scoring ${out}: ${ladder.rungs.join('/')} × both sides × ${ladder.maps.join(', ')} × ${ladder.seeds.length} seed(s)`);
  await scoreFrozen(ladderSeries({ ...ladder, gameDigest }), policies, out, signal);
  await writeFile(join(out, 'scored.json'), `${JSON.stringify({ at: new Date().toISOString(), wallSeconds: Math.round((Date.now() - started) / 1000), policies: benchmarkDigest(policies), ...ladder }, null, 2)}\n`, { mode: 0o600 });
}

/** The starters baseline of the campaign's own settings, into `<dir>/baseline/`, then the campaign summary. */
export async function scoreCampaignBaseline(dir: string, signal: AbortSignal, log: (line: string) => void) {
  const gameDigest = await benchmarkSourceDigest(BUILD.game);
  await scoreInto(join(dir, BASELINE_DIR), await campaignLadder(dir), gameDigest, await starterPolicies(), signal, log);
  return writeSummary(dir);
}

/** Every frozen run of the campaign and the starters, re-scored on `rungs`, into `<dir>/rescore-<key>/`, then its summary. */
export async function rescoreCampaign(dir: string, rungs: Rung[], signal: AbortSignal, log: (line: string) => void) {
  const ladder = await campaignLadder(dir, rungs);
  const [gameDigest, runnerDigest] = await Promise.all([benchmarkSourceDigest(BUILD.game), benchmarkSourceDigest(BUILD.runner)]);
  const name = `rescore-${benchmarkDigest({ ...ladder, ladder: ACBENCH.ladder, gameDigest, runnerDigest }).slice(0, ACBENCH.suiteKeyChars)}`;
  const root = join(dir, name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'rescore.json'), `${JSON.stringify({ ...ladder, ladder: Object.fromEntries(rungs.map(r => [r, ACBENCH.ladder[r]])), build: { gameDigest, runnerDigest } }, null, 2)}\n`, { mode: 0o600 });
  await scoreInto(join(root, BASELINE_DIR), ladder, gameDigest, await starterPolicies(), signal, log);
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
  return { name, summary: await writeSummary(dir, name) };
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
