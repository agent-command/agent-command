/** Operator-only executable. Never imports user-supplied TypeScript or purchases inference by default. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exportCampaignPublication, runCampaign } from '@playerthree/bench/campaign';
import { benchmarkSourceDigest } from '@playerthree/bench/source-digest';
import { benchmarkDigest, scoreBenchmark, validateBenchmarkSuite } from 'playerthree/benchmark';
import type { PolicyArtifact } from 'playerthree';
import type { BenchConfig } from '@playerthree/bench';
import { referenceCampaign } from './reference.ts';

const { values } = parseArgs({ options: {
  smoke: { type: 'boolean' }, artifact: { type: 'string' }, 'model-config': { type: 'string' }, seeds: { type: 'string' },
  out: { type: 'string' }, suite: { type: 'string' }, prepare: { type: 'boolean' }, 'max-campaign-usd': { type: 'string' },
  'suite-version': { type: 'string', default: '1' },
  'system-id': { type: 'string', default: 'local-system' }, label: { type: 'string', default: 'Local system' },
  license: { type: 'string' }, 'consent-publication': { type: 'boolean' }, 'pricing-version': { type: 'string' }, 'pricing-as-of': { type: 'string' },
} });
if (!values.out || [values.smoke, values.artifact, values['model-config']].filter(Boolean).length !== 1) throw new Error('Use --out DIRECTORY and exactly one of --smoke, --artifact FILE, or --model-config FILE. Add --prepare to freeze suite without execution.');
if (values['consent-publication'] && !values.license) throw new Error('Explicit public attribution/research consent requires --license');
const root = fileURLToPath(new URL('../', import.meta.url));
const runnerRoot = fileURLToPath(new URL('../../player-three/', import.meta.url));
const build = { game: { root, paths: ['packages/game/src', 'packages/game/package.json', 'pnpm-lock.yaml', 'bench/series.ts', 'bench/reference.ts'] },
  runner: { root: runnerRoot, paths: ['packages/bench/src', 'packages/playerthree/src', 'packages/runner/src', 'packages/bench/package.json', 'packages/playerthree/package.json', 'packages/runner/package.json', 'pnpm-lock.yaml'] } };
const [gameDigest, runnerDigest] = await Promise.all([benchmarkSourceDigest(build.game), benchmarkSourceDigest(build.runner)]);
const seeds: number[] = values.smoke ? [17011, 29009] : values.seeds ? JSON.parse(await readFile(resolve(values.seeds), 'utf8')) : [];
let artifact: PolicyArtifact | undefined;
if (values.artifact) {
  const input = JSON.parse(await readFile(resolve(values.artifact), 'utf8'));
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['runtime','code','include'].includes(k)) || !['js','wasm'].includes(input.runtime) || typeof input.code !== 'string' || !input.code || Buffer.byteLength(input.code) > 524288 || (input.include !== undefined && (!Array.isArray(input.include) || input.include.some((s: unknown) => typeof s !== 'string')))) throw new Error('Expected a bounded policy artifact JSON {runtime,code,include?}, not a configuration module');
  artifact = input;
}
let model: NonNullable<BenchConfig['models']>[string] | undefined;
if (values['model-config']) {
  const input = JSON.parse(await readFile(resolve(values['model-config']), 'utf8'));
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['provider','model','apiKeyEnv','baseUrl','price'].includes(k)) || !['openai','anthropic'].includes(input.provider) || typeof input.model !== 'string' || !input.price || ![input.price.inPerM,input.price.outPerM].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new Error('Private model JSON requires provider/model/explicit price; credentials must be referenced by apiKeyEnv, never embedded');
  if (!values['pricing-version'] || !values['pricing-as-of'] || !Number.isFinite(Date.parse(values['pricing-as-of']))) throw new Error('Freeze --pricing-version and --pricing-as-of for comparable estimates');
  model = input;
  // Five independent runs each have a strict $10 authoring ceiling; require a deliberate campaign authorization.
  if (!values.prepare && (!values['max-campaign-usd'] || Number(values['max-campaign-usd']) < 50 || !Number.isFinite(Number(values['max-campaign-usd'])))) throw new Error('Paid execution requires explicit --max-campaign-usd at least 50; the evaluator never starts a paid campaign by default');
}
const config = referenceCampaign({ seeds, gameDigest, runnerDigest, build, artifact, model, smoke: values.smoke, suiteVersion: Number(values['suite-version']),
  pricing: { version: values['pricing-version'] ?? 'scripted-no-inference/1', asOf: values['pricing-as-of'] ?? '2000-01-01T00:00:00.000Z' },
  systemId: values['system-id']!, label: values.smoke ? 'Deterministic smoke fixture — not model evidence' : values.label!,
  license: values.license ?? 'Private evaluation; no publication permission', publicationConsent: !!values['consent-publication'] });
if (values.suite) {
  const frozen = validateBenchmarkSuite(JSON.parse(await readFile(resolve(values.suite), 'utf8')));
  if (frozen.digest !== config.suite.digest) throw new Error(`Frozen suite does not match current seeds, rules, baseline builds, execution profile or --suite-version ${config.suite.version}. After a deliberate change, prepare and review a new suite with the next --suite-version.`);
  config.suite = frozen;
}
const out = resolve(values.out); await mkdir(out, { recursive: true, mode: 0o700 });
if (values.prepare) {
  await writeFile(resolve(out, 'suite.json'), JSON.stringify(config.suite, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Prepared ${config.suite.id}; suite SHA-256 ${config.suite.digest}. No execution started.`);
} else {
  if (!values.smoke && !values.suite) throw new Error('Non-smoke execution requires --suite FILE prepared and reviewed before execution');
  // SIGINT/SIGTERM stop cleanly: interrupted authoring stays retryable and evaluation resumes when re-run.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const record = await runCampaign(config, { outDir: out, signal: controller.signal, log: message => console.error(message),
    ...(values['max-campaign-usd'] ? { maxCampaignUsd: Number(values['max-campaign-usd']) } : {}) })
    .finally(() => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
  const score = scoreBenchmark(record.suite, record.runs);
  if (!score.complete) {
    console.error(`Campaign incomplete: ${score.completedRuns + score.failedRuns}/${score.expectedRuns} runs finished. Re-run the same command to resume; no publication created.`);
    process.exitCode = 1;
  } else if (values.smoke && (score.failedRuns !== 0 || score.completedRuns !== score.expectedRuns)) {
    throw new Error('Integration smoke failed: every authoring replicate must produce an artifact and finish evaluation. Failed runs remain recorded.');
  } else if (values['consent-publication']) {
    const publication = exportCampaignPublication(record, config.consent);
    const path = resolve(out, 'publication.json');
    try {
      await writeFile(path, JSON.stringify(publication, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(`Created consented publication ${publication.id}; SHA-256 ${publication.digest}. Not imported or published.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // The id names the evidence: the same id means this exact evidence was already exported; never overwrite another.
      if (JSON.parse(await readFile(path, 'utf8')).id !== publication.id) throw new Error(`${path} holds a different publication; move it aside before exporting new evidence`);
      console.log(`Consented publication ${publication.id} already exported. Not imported or published.`);
    }
  } else console.log(`Private campaign retained; digest ${benchmarkDigest(record)}. No public publication created.`);
}
