import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sealBenchmark } from 'playerthree/benchmark';
import { createBenchmarkRegistry } from '../src/benchmark-registry.ts';
import { createBenchmarks, publicRows } from '../src/benchmarks.ts';
import { cohort, cohortOptions, cost, headlineEntries, labOf, MODEL_NAMES, opponentScores, opponentTable, REFERENCES, referencesFor, runSpread, systemName, TIER_ORDER, tldr, usd, versionName, versions, latestVersion, type BenchmarkDocumentProps, type BenchmarkPage, type PublicBenchmark, type References, type ReleaseCard } from '../../web/src/benchmarks/model.ts';
import { STORIES, type ReleaseStory } from '../../web/src/benchmarks/stories.ts';
import { BenchmarkApp } from '../../web/src/benchmarks/components.ts';
import { ChartRenderer, chartKey, headlineSpec } from '../../web/src/benchmarks/charts.ts';
import { renderChart } from '../../web/src/benchmarks/echarts.ts';
import { ACBENCH } from '../../../bench/acbench-settings.ts';
import { MODELS } from '../../../bench/frontier-models.ts';
import { arenaSeedSource } from '../src/arena-seeds.ts';
import { loadConfig } from '../src/config.ts';
import { benchmarkFixture, fixtureRelease, reseal } from './benchmark-fixture.ts';

const dirs: string[] = []; const servers: Server[] = []; const curated: (() => void)[] = [];
/** Curates a story and reference bars for a test-only release id, removed again after the test. */
function curate(id: string, story: ReleaseStory | null, references: References | null): void {
  const stories = STORIES as Record<string, ReleaseStory>; const bars = REFERENCES as Record<string, References>;
  if (story) stories[id] = story;
  if (references) bars[id] = references;
  curated.push(() => { delete stories[id]; delete bars[id]; });
}
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'acbench-test-')); dirs.push(dir); return dir; }
afterEach(async () => {
  for (const undo of curated.splice(0)) undo();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  }
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function serve(route: { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> }): Promise<string> {
  const server = createServer((req, res) => { void route.handle(req, res, new URL(req.url!, 'http://localhost')).then(done => { if (!done) res.writeHead(404).end(); }).catch(() => res.writeHead(500).end()); }); servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject); server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected port');
  return `http://127.0.0.1:${address.port}`;
}
/** The hydration state exactly as the browser reads it back from the escaped SSR text node. */
function hydration(html: string): BenchmarkDocumentProps {
  const text = /<div[^>]*id="acbench-data"[^>]*>([^<]*)<\/div>/.exec(html)![1]!;
  return JSON.parse(text.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
}
const unknownCost = { scope: 'authoring-run' as const, amount: null, currency: null, source: 'unknown' as const, coverage: 'unknown' as const, pricingVersion: null, pricedAt: null };

/** A fixture whose permutations name their opponent (`<opponent>-<side>`): novice and veteran, both sides, on two blocks. */
function opponentFixture(id: string, outcomes: Record<string, (number | null)[]>) {
  const p = benchmarkFixture(id);
  const permutations = ['novice-nw', 'novice-se', 'veteran-nw', 'veteran-se'];
  const { digest: _digest, ...suite } = p.suite;
  p.suite = sealBenchmark({ ...suite, references: [{ id: 'veteran', digest: 'b'.repeat(64) }, { id: 'novice', digest: 'c'.repeat(64) }], evaluation: { permutations, repetitions: 1 } });
  p.runs = p.runs.map((run, r) => ({ ...run, trials: p.suite.blocks.flatMap((b, bi) => permutations.map((permutationId, pi) => {
    const score = outcomes[run.id]![bi * permutations.length + pi]!;
    return { trialId: `trial-${bi * permutations.length + pi}`, blockId: b.blockId, stratumId: b.stratumId, permutationId, attempts: 1, score,
      status: score === null ? 'incomplete' as const : score === 1 ? 'win' as const : score === 0.5 ? 'draw' as const : 'loss' as const };
  })), id: `run-${r}` }));
  return p;
}

it('ranks scored systems by score and lists unscored ones last, never as a zero bar', () => {
  const unscored = benchmarkFixture('unscored', '1', 2); unscored.runs[1]!.status = 'frozen'; unscored.runs[1]!.trials = [];
  const publications = [benchmarkFixture('low', '1', 1), reseal(unscored), benchmarkFixture('high', '2', 4), benchmarkFixture('mid', '0', 2)];
  const rows = publicRows({ release: fixtureRelease(publications), publications });
  const entries = headlineEntries(rows);
  expect(entries.map(e => [e.id, e.value])).toEqual([['high', 1], ['mid', 0.5], ['low', 0.25], ['unscored', null]]);
  expect(entries[0]!.interval).not.toBeNull(); expect(entries[3]!.interval).toBeNull();
  const page: BenchmarkPage = { kind: 'release', title: 't', canonical: 'https://example.test/', image: '', releases: [], rows, release: { id: 'synthetic-fixture', revision: 1, title: 'SYNTHETIC', path: '/benchmarks/community/synthetic-fixture/1/', publisher: 'community', evidence: 'submitted', publishedAt: '', notBefore: '2000-01-01T00:00:03.000Z', digest: '', systems: 4, correction: null, previous: null },
    initialCohort: cohort(publications[0]!), initialModel: '', replacement: null, headline: null };
  const html = renderToStaticMarkup(createElement(ChartRenderer.Provider, { value: renderChart }, createElement(BenchmarkApp, { page })));
  const headline = /<figure class="bench-chart headline-chart">[\s\S]*?<\/figure>/.exec(html)![0];
  // Server-rendered ECharts SVG at every width, keyed for hydration by the chart's data.
  expect(headline.match(/<div class="chart-v chart-v\d" aria-hidden="true"><svg /g)).toHaveLength(3);
  expect(headline).toContain(`data-chart-key="${chartKey(headlineSpec(entries).spec)}"`);
  for (const value of ['100.0', '50.0', '25.0', 'Not scored']) expect(headline).toContain(`>${value}</text>`);
  expect(headline).toContain('Synthetic fixture unscored: not scored');
  expect(headlineSpec(entries).spec).toMatchObject({ entries: [{ value: 1 }, { value: 0.5 }, { value: 0.25 }, { value: null, interval: null }] });
  // The pilot-shaped fixture's permutations name no opponent: no per-opponent chart; every scored run is a variance dot.
  expect(html).not.toContain('opponent-heading');
  expect(html).toContain('variance-chart');
  expect(rows.flatMap(row => runSpread(row)?.runs ?? [])).toHaveLength(7);
  expect(runSpread(rows[1]!)).toMatchObject({ expected: 2, sd: null });
  // Mid wins one world block and loses the other, so its block-bootstrap range reaches 100: the lead is not settled.
  expect(tldr(rows)).toEqual(['Synthetic fixture high leads at 100, not clearly ahead of Synthetic fixture mid (50).']);
  expect(cost(publications[0]!)).toBe(1);
});

it('scores each opponent only from explicit <opponent>-<side> permutations, ladder order, missing never zero', () => {
  const wins = { 'run-0': [1, 1, 0, 0.5, 1, 1, 0, 0], 'run-1': [1, 0, 0, 0, 1, 1, 1, 0] };
  const p = opponentFixture('tiers', wins);
  const scores = opponentScores(p)!;
  expect(scores.opponents).toEqual(['novice', 'veteran']);
  // Run 0: novice 4/4, veteran 0.5/4 · run 1: novice 3/4, veteran 1/4.
  expect(scores.values).toEqual([(1 + 0.75) / 2, (0.125 + 0.25) / 2]);
  // Equal games per opponent: the opponents' mean is the headline score.
  const scored = reseal(p);
  expect((scores.values[0]! + scores.values[1]!) / 2).toBeCloseTo(scored.score.value!);
  const legacy = opponentFixture('legacy', wins);
  legacy.suite = { ...legacy.suite, evaluation: { permutations: legacy.suite.evaluation.permutations.map((_, i) => `orientation-${i + 1}`), repetitions: 1 } };
  expect(opponentScores(legacy)).toBeNull();
  const unknown = opponentFixture('unknown', wins); unknown.suite = { ...unknown.suite, references: [{ id: 'novice', digest: 'c'.repeat(64) }, { id: 'champion', digest: 'd'.repeat(64) }] };
  expect(opponentScores(unknown)).toBeNull();
  const gap = opponentFixture('gap', { ...wins, 'run-1': [1, 0, 0, null, 1, 1, 1, 0] });
  expect(opponentScores(gap)!.values).toEqual([(1 + 0.75) / 2, null]);
  const sealed = [scored, reseal(gap)];
  expect(sealed[1]!.score.value).toBeNull();
  const rows = publicRows({ release: fixtureRelease(sealed), publications: sealed });
  expect(opponentTable(rows)!.series.map(s => s.values[1])).toEqual([(0.125 + 0.25) / 2, null]);
  expect(tldr(rows)).toEqual(['Synthetic fixture tiers leads at 53.', 'Best vs Veteran: Synthetic fixture tiers, 19.']);
  expect([...TIER_ORDER]).toEqual(ACBENCH.opponents);
});

/** A release page of `rows` under release id `id`, rendered with the server's chart renderer. */
function releaseHtml(rows: PublicBenchmark[], id: string): string {
  const page: BenchmarkPage = { kind: 'release', title: 't', canonical: 'https://example.test/', image: '', releases: [], rows, initialModel: '', replacement: null, headline: null,
    initialCohort: cohortOptions(rows)[0]!.value,
    release: { id, revision: 1, title: 'T', path: `/benchmarks/community/${id}/1/`, publisher: 'community', evidence: 'submitted', publishedAt: '', notBefore: '2000-01-01T00:00:03.000Z', digest: '', systems: rows.length, correction: null, previous: null } };
  return renderToStaticMarkup(createElement(ChartRenderer.Provider, { value: renderChart }, createElement(BenchmarkApp, { page })));
}

/** `opponentFixture` authored once: a one-run publication of a one-replicate suite. */
function singleRun(id: string, outcomes: (number | null)[]) {
  const p = opponentFixture(id, { 'run-0': outcomes, 'run-1': outcomes });
  const { digest: _digest, ...suite } = p.suite;
  p.suite = sealBenchmark({ ...suite, authoring: { ...suite.authoring, replicates: 1 } });
  p.runs = p.runs.slice(0, 1);
  p.experiment = { ...p.experiment, replicates: 1 };
  return reseal(p);
}
const releaseCard = (id: string, systems: number): ReleaseCard => ({ id, revision: 1, title: 'T', path: `/benchmarks/community/${id}/1/`, publisher: 'community', evidence: 'submitted', publishedAt: '', notBefore: '2000-01-01T00:00:03.000Z', digest: '', systems, correction: null, previous: null });
const STORY: ReleaseStory = {
  tldr: ['Models write policies for every plane.', 'The bots are fixed.', 'The score is a win rate.'], verdict: 'Alpha wins three games in four. Beta trails at a quarter.',
  objective: 'Beat the ladder.', harness: 'One fixed harness.', turns: { alpha: 120, beta: 40 },
  models: { alpha: { nickname: 'Fixture Champion', bullets: ['Attacks at 1.4x the enemy army.', 'Wins 6 of 8 games.'], strategy: { label: 'Rush', detail: '3 attacks per game' },
    unit: { name: 'Fighter', ratio: 9.66, detail: '41 per game' }, clip: { src: '/benchmarks/clips/story-fixture/alpha.mp4', poster: '/benchmarks/clips/story-fixture/alpha.jpg', caption: 'The rush lands.' } } },
};
const BARS: References = { source: 'Test fixture bots.', bars: [{ id: 'champion', label: 'Champion bot', score: 0.5 }, { id: 'skeleton', label: 'Starting skeleton', score: 0 }] };

it('tells a version as a story: TL;DR, chart with reference bars and verdict, model cards, opponents, details, standings', () => {
  curate('story-fixture', STORY, BARS);
  const publications = [singleRun('alpha', [1, 1, 1, 0, 1, 1, 1, 0]), singleRun('beta', [1, 0, 0, 0, 1, 0, 0, 0])];
  const rows = publicRows({ release: { ...fixtureRelease(publications), id: 'story-fixture' }, publications });
  const html = releaseHtml(rows, 'story-fixture');
  const order = ['id="version-title"', 'id="tldr-heading"', 'headline-chart', 'class="verdict"', 'id="breakdown-heading"', 'id="opponent-heading"', 'id="details-heading"', 'id="standings-heading"', 'download-links'];
  const at = order.map(marker => html.indexOf(marker));
  expect(at.every(i => i > 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(html).toContain('<li>Models write policies for every plane.</li>');
  expect(html).toContain('>Alpha wins three games in four. Beta trails at a quarter.</p>');
  // Reference bars merge into the ranking by score, drawn apart from the models and labelled.
  expect(headlineSpec(headlineEntries(rows), referencesFor('story-fixture')).spec).toMatchObject({ entries: [
    { label: 'Synthetic fixture alpha', reference: false }, { label: 'Champion bot', reference: true }, { label: 'Synthetic fixture beta', reference: false }, { label: 'Starting skeleton', reference: true, value: 0 }] });
  const headline = /<figure class="bench-chart headline-chart">[\s\S]*?<\/figure>/.exec(html)![0];
  expect(headline).toContain('stroke-dasharray');
  expect(headline).toContain('Dashed bars: built-in references. Test fixture bots.');
  expect(headline).toContain('references: Champion bot 50.0, Starting skeleton 0.0');
  // One card, only for the system with a story: nickname, score, bullets, favourites and a lazy clip.
  expect(html.match(/<article class="model-card/g)).toHaveLength(1);
  expect(html).toContain('<article class="model-card has-clip" aria-labelledby="card-alpha">');
  expect(html).toContain('>Fixture Champion</h3>');
  expect(html).toContain('Score 75.0');
  expect(html).toContain('9.7× the rest of the field');
  expect(html).not.toContain('card-beta');
  const video = /<video[^>]*>/.exec(html)![0];
  for (const attribute of ['muted=""', 'loop=""', 'playsInline=""', 'preload="none"', 'poster="/benchmarks/clips/story-fixture/alpha.jpg"']) expect(video).toContain(attribute);
  // The video loads its source only once scrolled into view (client effect), never in the server render.
  expect(video).not.toMatch(/\ssrc=/);
  expect(html).toContain('<figcaption>The rush lands.</figcaption>');
  // Single run per model: no variance chart; the scoring section says so.
  expect(html).not.toContain('variance-heading');
  expect(html).toContain('Single run per model');
  // One run gives no interval here, so nothing claims error bars.
  expect(publications.every(p => p.score.interval === null)).toBe(true);
  expect(html).toContain('the chart draws no error bars');
  expect(html).not.toContain('error bars: 95% range');
  // Standings: wins, draws, losses, win %, cost and the story's authoring turns.
  expect(html).toContain('<th scope="col">Turns</th>');
  expect(html).toContain('<td>120</td>');
  expect(html).toContain('<td>75%</td>');
  // Exact values are visible text, never native tooltips.
  expect(html).not.toMatch(/\stitle="/);

  // The hub leads with the same TL;DR, chart and verdict, then lists versions.
  const card = releaseCard('story-fixture', 2);
  const hub = renderToStaticMarkup(createElement(ChartRenderer.Provider, { value: renderChart }, createElement(BenchmarkApp, { page: { kind: 'hub', title: 'AI policy benchmark', canonical: 'https://example.test/', image: '', releases: [card], rows: [], release: null,
    initialCohort: null, initialModel: '', replacement: null, headline: { release: card, entries: headlineEntries(rows), bullets: tldr(rows) } } })));
  const hubAt = ['id="tldr-heading"', 'headline-chart', 'class="verdict"', 'id="versions-heading"'].map(marker => hub.indexOf(marker));
  expect(hubAt.every(i => i > 0)).toBe(true);
  expect(hubAt).toEqual([...hubAt].sort((a, b) => a - b));
  expect(hub).toContain('Dashed bars: built-in references.');
  expect(hub).not.toMatch(/\stitle="/);
});

it('draws no reference bars, cards, verdict or turns for a version without curated data', () => {
  const publications = [singleRun('alpha', [1, 1, 1, 0, 1, 1, 1, 0]), singleRun('beta', [1, 0, 0, 0, 1, 0, 0, 0])];
  const rows = publicRows({ release: { ...fixtureRelease(publications), id: 'plain-fixture' }, publications });
  expect(referencesFor('plain-fixture')).toBeNull();
  const html = releaseHtml(rows, 'plain-fixture');
  for (const absent of ['Dashed bars', 'stroke-dasharray', 'breakdown-heading', 'model-card', 'class="verdict"', '>Turns<', '<video']) expect(html).not.toContain(absent);
  expect(headlineSpec(headlineEntries(rows)).spec).toMatchObject({ entries: [{ reference: false }, { reference: false }] });
  // The TL;DR falls back to bullets derived from the results.
  expect(html).toContain(`<li>${tldr(rows)[0]}</li>`);
  expect(html).not.toMatch(/\stitle="/);
  // A story without a card for a system renders no card for it.
  curate('partial-fixture', { ...STORY, models: {} }, null);
  const partial = releaseHtml(publicRows({ release: { ...fixtureRelease(publications), id: 'partial-fixture' }, publications }), 'partial-fixture');
  expect(partial).not.toContain('breakdown-heading');
  expect(partial).toContain('class="verdict"');
});

it('charts and tables every system of one suite and harness, footnoting only a curated profile difference', () => {
  const later = benchmarkFixture('later', '1', 1); later.experiment.system.configurationDigest = 'b'.repeat(64);
  const publications = [benchmarkFixture('first', '1', 3), benchmarkFixture('second', '1', 2), reseal(later)];
  const rows = publicRows({ release: { ...fixtureRelease(publications), id: 'acbench-v0-2' }, publications });
  expect(new Set(rows.map(r => cohort(r.publication))).size).toBe(1);
  expect(headlineEntries(rows).map(e => [e.id, e.note])).toEqual([['first', null], ['second', null], ['later', null]]);
  const html = releaseHtml(rows, 'acbench-v0-2');
  expect(html).not.toContain('†');
  expect(html.match(/<tr><th scope="row">/g)).toHaveLength(3);
  // A curated reason (v0.1's DeepSeek, authored on a later game build) keeps its footnote in the chart and the table.
  const curated = benchmarkFixture('deepseek-v4.1-flash', '1', 1); curated.experiment.system.configurationDigest = 'b'.repeat(64);
  const v01 = [benchmarkFixture('first', '1', 3), benchmarkFixture('second', '1', 2), reseal(curated)];
  const v01Rows = publicRows({ release: { ...fixtureRelease(v01), id: 'acbench-v0-1' }, publications: v01 });
  expect(headlineEntries(v01Rows).find(e => e.id === 'deepseek-v4.1-flash')?.note).toBe('authored on a later game build');
  const v01Html = releaseHtml(v01Rows, 'acbench-v0-1');
  expect(v01Html).toContain(': authored on a later game build.');
  expect(v01Html).toContain('† authored on a later game build');
});

it('shows pinned models by display name with the route apart, and never names an unknown id', () => {
  expect(systemName({ model: 'openai/gpt-6.1-sol', label: 'gpt-6.1-sol (via OpenRouter)' })).toEqual({ name: 'GPT-6.1 Sol', route: 'via OpenRouter' });
  expect(systemName({ model: 'z-ai/glm-5.3', label: 'glm-5.3 (via OpenRouter, openrouter-chat wire)' })).toEqual({ name: 'GLM 5.3', route: 'via OpenRouter' });
  expect(systemName({ model: 'anthropic/claude-opus-5-5', label: 'claude-opus-5.5 (via Anthropic (Claude subscription), gateway, messages wire)' })).toEqual({ name: 'Claude Opus 5.5', route: 'via Claude subscription' });
  expect(systemName({ model: 'openai-codex/gpt-6.2-sol', label: 'gpt-6.2-sol (via OpenAI (ChatGPT subscription), gateway, responses wire)' })).toEqual({ name: 'GPT-6.2 Sol', route: 'via ChatGPT subscription' });
  expect(systemName({ model: 'deepseek/deepseek-v4.1-flash-1017', label: 'deepseek-v4.1-flash' })).toEqual({ name: 'DeepSeek V4.1 Flash', route: null });
  expect(systemName({ model: 'acme/unknown-9', label: 'unknown-9 (via OpenRouter)' })).toEqual({ name: 'unknown-9 (via OpenRouter)', route: null });
  expect(systemName({ model: 'constructor', label: 'raw' })).toEqual({ name: 'raw', route: null });
  expect(systemName({ model: null, label: 'raw' })).toEqual({ name: 'raw', route: null });
  // Every pinned benchmark model has a display name.
  for (const { model } of Object.values(MODELS)) expect(MODEL_NAMES[model], model).toBeTruthy();
  expect([2.3936, 0.0670420960, 0.004, 0].map(usd)).toEqual(['$2.39', '$0.07', '<$0.01', '$0.00']);
});

it('marks every named model with its lab favicon, a shipped static file, and no guessed lab for an unknown prefix', async () => {
  expect(labOf('google/gemini-4-neon')).toEqual({ id: 'google', name: 'Google', icon: '/benchmarks/labs/google.png' });
  expect(labOf('openai-codex/gpt-6.2-sol')).toMatchObject({ id: 'openai' });
  expect(labOf('z-ai/glm-5.3')).toMatchObject({ id: 'zai', name: 'Z.ai' });
  for (const model of [null, 'acme/unknown-9', 'constructor/x', 'raw']) expect(labOf(model), String(model)).toBeNull();
  for (const model of Object.keys(MODEL_NAMES)) {
    const lab = labOf(model); expect(lab, model).not.toBeNull();
    expect((await stat(new URL(`../../web/public${lab!.icon}`, import.meta.url))).size, model).toBeLessThan(4096);
  }
  const svg = renderChart(headlineSpec([{ id: 'p', system: 's', label: 'Gemini 4 Neon', route: null, model: 'google/gemini-4-neon', lab: labOf('google/gemini-4-neon'), value: 0.5, interval: null, href: '/', note: null }]).spec)[1]!;
  expect(svg).toContain('<image href="/benchmarks/labs/google.png"');
});

it('names versions, keeps one entry per version and leads with the newest official one', () => {
  const card = (id: string, publisher: 'official' | 'community', notBefore: string, revision = 1) => ({ id, revision, title: `${id} title`, path: `/${publisher}/${id}/${revision}/`, publisher, evidence: 'runner-observed', publishedAt: notBefore, notBefore, digest: '', systems: 3, correction: null, previous: null });
  expect(versionName(card('acbench-v0-1', 'official', ''))).toBe('ACBench v0.1');
  expect(versionName(card('acbench-v1-pilot', 'community', ''))).toBe('ACBench pilot');
  expect(versionName({ id: 'other', title: 'Agent ladder: three models against five tiers of bots' })).toBe('Agent ladder');
  expect(versionName({ id: 'other-id', title: 'A very long release title without any colon in it at all' })).toBe('other-id');
  const releases = [card('acbench-v0-1', 'official', '2000-01-14T00:00:00.000Z'), card('acbench-v0-1', 'official', '2000-01-20T00:00:00.000Z', 2), card('pilot', 'community', '2000-02-01T00:00:00.000Z')];
  expect(versions(releases).map(r => [r.id, r.revision])).toEqual([['pilot', 1], ['acbench-v0-1', 2]]);
  expect(latestVersion(releases)).toMatchObject({ id: 'acbench-v0-1', revision: 2 });
  expect(latestVersion(releases.slice(2))).toMatchObject({ id: 'pilot' });
});

it('keeps an unknown-cost system in its suite/profile cohort, never as the default view', async () => {
  const unpriced = benchmarkFixture('unpriced', '1', 4);
  for (const run of unpriced.runs) run.cost = { ...unknownCost };
  const publications = [benchmarkFixture('priced-a', '1', 3), benchmarkFixture('priced-b', '2', 2), benchmarkFixture('priced-c', '3', 4), reseal(unpriced)];
  const rows = publicRows({ release: fixtureRelease(publications), publications });
  expect(cohortOptions(rows).map(o => o.systems)).toEqual([4]);
  expect(rows.filter(row => cost(row.publication) === null).map(row => row.publication.id)).toEqual(['unpriced']);
  const dir = await directory(); const release = fixtureRelease(publications);
  await createBenchmarkRegistry(dir).import(publications, release);
  const origin = await serve(createBenchmarks(loadConfig({ DATA_DIR: dir, PUBLIC_URL: 'https://example.test' })));
  const html = await (await fetch(`${origin}/benchmarks/community/${release.id}/1/`)).text();
  const { page } = hydration(html);
  expect(page.initialCohort).toBe(cohort(publications[0]!));
  expect(page.rows.filter(row => cohort(row.publication) === page.initialCohort)).toHaveLength(4);
  expect(html.match(/<option /g)).toHaveLength(1);
  expect(html).toContain('Unavailable / partial');
  // The hub leads with this (only) version: its ranked chart comes before anything else in <main>, then the version list.
  const hub = await (await fetch(`${origin}/benchmarks/`)).text();
  const main = hub.slice(hub.indexOf('<main'));
  expect(main.indexOf('headline-chart')).toBeGreaterThan(0);
  expect(main.indexOf('headline-chart')).toBeLessThan(main.indexOf('versions-heading'));
  expect(main.match(/class="chart-v chart-v\d"/g)).toHaveLength(3);
  const { page: hubPage } = hydration(hub);
  expect(hubPage.rows).toEqual([]);
  expect(hubPage.headline!.entries.map(e => e.id)).toEqual(['priced-c', 'unpriced', 'priced-a', 'priced-b']);
  const og = await fetch(`${origin}/benchmarks/og.png`);
  expect(og.headers.get('content-type')).toBe('image/png'); expect((await og.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  // Model Breakdown clips are static files: the benchmark routes leave them to the static server (here: none).
  const clip = await fetch(`${origin}/benchmarks/clips/${release.id}/priced-a.mp4`);
  expect(clip.status).toBe(404); expect(clip.headers.get('content-type')).toBeNull();
});

it('retains immutable revision snapshots, corrections and permanent release withdrawal', async () => {
  const dir = await directory(); const registry = createBenchmarkRegistry(dir);
  const p = benchmarkFixture(); const release = fixtureRelease([p]);
  await registry.import([p], release);
  await expect(registry.import([p], release)).rejects.toThrow('Immutable release');
  await registry.import([p], fixtureRelease([p], 2));
  expect((await createBenchmarkRegistry(dir).list()).map(r => r.release.revision)).toEqual([1,2]);
  await registry.withdraw(release.id, 1);
  expect(await createBenchmarkRegistry(dir).get(release.id, 1)).toBeNull();
  expect(await registry.get(release.id, 2)).not.toBeNull();
  await registry.withdrawPublication(p.id);
  expect(await registry.list()).toEqual([]);
});

it('links a correction that moves a version to official back to its community revision, listing only the current one', async () => {
  const dir = await directory(); const registry = createBenchmarkRegistry(dir);
  const p = benchmarkFixture('moved'); p.experiment.system.provider = 'openai'; const moved = reseal(p);
  await registry.import([moved], fixtureRelease([moved]));
  const { digest: _digest, ...corrected } = fixtureRelease([moved], 2);
  await registry.import([moved], sealBenchmark({ ...corrected, publisher: 'official', evidence: 'runner-observed' }));
  const origin = await serve(createBenchmarks(loadConfig({ DATA_DIR: dir, PUBLIC_URL: 'https://example.test' })));
  const page = async (path: string) => hydration(await (await fetch(`${origin}${path}`)).text()).page;
  const official = await page('/benchmarks/authored-policy/synthetic-fixture/2/');
  expect(official.release!.previous).toBe('/benchmarks/community/synthetic-fixture/1/');
  expect(official.rows[0]!.supersedes).toBe('/benchmarks/community/synthetic-fixture/1/');
  expect((await page('/benchmarks/community/synthetic-fixture/1/')).replacement!.path).toBe('/benchmarks/authored-policy/synthetic-fixture/2/');
  expect((await page('/benchmarks/community/')).releases).toEqual([]);
  expect((await page('/benchmarks/')).releases.map(r => [r.publisher, r.revision])).toEqual([['official', 2]]);
});

it('rejects unknown private fields, missing consent, credential patterns and unsupported official promotion', async () => {
  const registry = createBenchmarkRegistry(await directory()); const p = benchmarkFixture();
  await expect(registry.import([{ ...p, ownerSecret: 'must-not-publish' }], fixtureRelease([p]))).rejects.toThrow();
  const { digest: _digest, ...body } = p;
  const noConsent = sealBenchmark({ ...body, consent: { ...p.consent, attribution: false } });
  await expect(registry.import([noConsent], fixtureRelease([noConsent]))).rejects.toThrow('consent');
  const { digest: _releaseDigest, ...release } = fixtureRelease([p]);
  await expect(registry.import([p], sealBenchmark({ ...release, publisher: 'official', evidence: 'runner-observed' }))).rejects.toThrow('scripted fixtures');
  // A word that merely contains "sk-" is not a key; a standalone key-shaped token is.
  const desk = benchmarkFixture('desk-research-agent-v1');
  await registry.import([desk], fixtureRelease([desk]));
  const leaky = benchmarkFixture('leaky'); leaky.experiment.system.label = 'Leaky sk-abcdefghijklmnopqrstuvwx';
  await expect(registry.import([reseal(leaky)], fixtureRelease([reseal(leaky)], 2))).rejects.toThrow('credential');
});

it('names the next free suite version when changed contents reuse an existing suite id/version', async () => {
  const registry = createBenchmarkRegistry(await directory()); const first = benchmarkFixture('first');
  await registry.import([first], fixtureRelease([first]));
  const { digest: _suiteDigest, ...suite } = first.suite;
  const changed = benchmarkFixture('second'); changed.suite = sealBenchmark({ ...suite, gameVersion: 'changed-build' }); changed.experiment.suiteDigest = changed.suite.digest;
  await expect(registry.import([reseal(changed)], fixtureRelease([reseal(changed)], 2))).rejects.toThrow('--suite-version 2');
});

it('withholds one corrupt stored record without failing the site, data routes or sitemap', async () => {
  const dir = await directory(); const p = benchmarkFixture(); const release = fixtureRelease([p]);
  await createBenchmarkRegistry(dir).import([p], release);
  await writeFile(join(dir, 'benchmarks', 'releases', 'corrupt.r1.json'), '{"format":"acbench.release"');
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const route = createBenchmarks(loadConfig({ DATA_DIR: dir }));
    const origin = await serve(route);
    expect((await fetch(`${origin}/benchmarks/`)).status).toBe(200);
    expect((await fetch(`${origin}/benchmarks/community/${release.id}/1/data.json`)).status).toBe(200);
    expect((await route.paths()).some(path => path.includes(release.id))).toBe(true);
    // Tampered member evidence withholds only the releases that contain it.
    await writeFile(join(dir, 'benchmarks', 'publications', `${p.id}.json`), JSON.stringify({ publication: { ...p, score: { ...p.score, value: 0.5 } }, digest: p.digest }));
    expect((await fetch(`${origin}/benchmarks/community/${release.id}/1/`)).status).toBe(404);
    expect((await fetch(`${origin}/benchmarks/`)).status).toBe(200);
    expect(logged).toHaveBeenCalledTimes(2);
  } finally { logged.mockRestore(); }
});

it('uses the same watermark and withdrawal boundary for HTML, JSON, social images and sitemap paths', async () => {
  const dir = await directory(); const registry = createBenchmarkRegistry(dir); const p = benchmarkFixture();
  const future = fixtureRelease([p], 1, '2099-01-01T00:00:00.000Z'); await registry.import([p], future);
  const route = createBenchmarks(loadConfig({ DATA_DIR: dir, PUBLIC_URL: 'https://example.test' }));
  const origin = await serve(route);
  const paths = [`/benchmarks/community/${future.id}/1/`, `/benchmarks/runs/${p.id}/1/`, `/benchmarks/runs/${p.id}/1/data.json`, `/benchmarks/runs/${p.id}/1/og.png`];
  for (const path of paths) expect((await fetch(origin + path)).status).toBe(404);
  expect((await route.paths()).some(path => path.includes(future.id))).toBe(false);
  const home = await fetch(`${origin}/benchmarks/`); const html = await home.text();
  expect(hydration(html).page).toMatchObject({ kind: 'hub', releases: [] }); expect(html).toContain('type="module"');
  expect(html.match(/<link rel="preload" as="image"/g)).toHaveLength(1);
  expect(home.headers.get('cache-control')).toBe('no-store');
  expect((await fetch(`${origin}/benchmarks/`, { method: 'POST' })).status).toBe(405);
});

it('serves a released, escaped, checksummed dataset without WebGL or credentials', async () => {
  const dir = await directory(); const registry = createBenchmarkRegistry(dir);
  const hostile = '</script><script>alert(1)</script><img src=x onerror=alert(2)>&amp;';
  const base = benchmarkFixture(); base.experiment.system.label = hostile; base.experiment.system.model = `"><svg onload=alert(3)>`;
  const p = reseal(base); const release = fixtureRelease([p]);
  await registry.import([p], release);
  const origin = await serve(createBenchmarks(loadConfig({ DATA_DIR: dir, PUBLIC_URL: 'https://example.test' })));
  const path = `/benchmarks/community/${release.id}/1/`;
  for (const page of [path, `${path}systems/${p.experiment.system.id}/`, `/benchmarks/runs/${p.id}/1/`]) {
    const html = await (await fetch(origin + page)).text();
    // Hostile strings stay inert text: the only script is the hydration entry, and the state round-trips exactly.
    expect(html.match(/<script/gi)).toHaveLength(1);
    expect(html).not.toMatch(/<img src=x|<svg onload/i);
    expect(hydration(html).page.rows[0]!.publication.experiment.system).toMatchObject({ label: hostile, model: base.experiment.system.model });
  }
  const html = await (await fetch(origin + path)).text();
  expect(html).toContain('headline-chart'); expect(html).toContain('<table');
  expect(html).not.toContain('WebGL'); expect(html).toContain(`https://example.test${path}`);
  const manifest = await (await fetch(origin + path + 'manifest.json')).json(); expect(manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect((await (await fetch(origin + path + 'data.json')).json()).publications[0].digest).toBe(p.digest);
  // The CSV keeps the exact mean authoring cost; only the page rounds to cents.
  const csv = (await (await fetch(origin + path + 'scores.csv')).text()).split('\n');
  expect(csv[0]).toContain(',mean_authoring_cost_usd,'); expect(csv[1]).toMatch(new RegExp(`,"${cost(p)}","${p.digest}"$`));
  // Route suffixes are literal file names, not patterns.
  expect((await fetch(origin + path + 'dataxjson')).status).toBe(404);
  await registry.withdraw(release.id, 1);
  for (const suffix of ['', 'data.json', 'manifest.json', 'og.png']) expect((await fetch(origin + path + suffix)).status).toBe(404);
});

it('keeps hidden world realization stable across concurrent starts and restarts, but separates series', async () => {
  const dir = await directory();
  const [a, b] = await Promise.all([arenaSeedSource(dir)('durable-series', 'world-block'), arenaSeedSource(dir)('durable-series', 'world-block')]);
  expect(a).toBe(b); expect(a).toBe(await arenaSeedSource(dir)('durable-series', 'world-block'));
  expect(a).not.toBe(await arenaSeedSource(dir)('another-series', 'world-block'));
  await expect(arenaSeedSource(undefined, '')('series', 'block')).rejects.toThrow('ARENA_SEED_KEY');
  // Deployments without a key file fail at startup, not at their first arena match; local DATA_DIR needs no key.
  expect(() => loadConfig({ DATABASE_URL: 'postgres://db/ac' })).toThrow('ARENA_SEED_KEY');
  expect(() => loadConfig({ DATABASE_URL: 'postgres://db/ac', ARENA_SEED_KEY: 'not-hex' })).toThrow('ARENA_SEED_KEY');
  expect(loadConfig({ DATABASE_URL: 'postgres://db/ac', ARENA_SEED_KEY: 'a'.repeat(64) }).arenaSeedKey).toBe('a'.repeat(64));
  expect(loadConfig({ DATA_DIR: dir }).arenaSeedKey).toBeUndefined();
});
