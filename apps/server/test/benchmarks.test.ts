import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sealBenchmark } from 'playerthree/benchmark';
import { createBenchmarkRegistry } from '../src/benchmark-registry.ts';
import { createBenchmarks, publicRows } from '../src/benchmarks.ts';
import { cohort, cohortOptions, cost, costComparable, frontier, type BenchmarkDocumentProps } from '../../web/src/benchmarks/model.ts';
import { arenaSeedSource } from '../src/arena-seeds.ts';
import { loadConfig } from '../src/config.ts';
import { benchmarkFixture, fixtureRelease, reseal } from './benchmark-fixture.ts';

const dirs: string[] = []; const servers: Server[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'acbench-test-')); dirs.push(dir); return dir; }
afterEach(async () => {
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

it('normalizes comparable Pareto points with exact ties and explicit missing-cost exclusions', () => {
  const publications = [benchmarkFixture('best', '1', 3), benchmarkFixture('tie', '1', 3), benchmarkFixture('cheap', '0', 2), benchmarkFixture('worse-score', '1', 2), benchmarkFixture('worse-cost', '2', 3), benchmarkFixture('unknown', '0', 4)];
  publications[5]!.runs[0]!.cost.coverage = 'partial';
  const rows = publicRows({ release: fixtureRelease(publications), publications });
  expect(frontier(rows).map(r => r.publication.id)).toEqual(['cheap','best','tie']);
  expect(cost(publications[5]!)).toBeNull();
  expect(rows.filter(row => cost(row.publication) === null)).toHaveLength(1);
  const other = benchmarkFixture('other-profile', '0', 4); other.experiment.system.configurationDigest = 'b'.repeat(64);
  const otherRow = publicRows({ release: fixtureRelease([other]), publications: [other] })[0]!;
  expect(cohort(other)).not.toBe(cohort(publications[0]!));
  expect(frontier([...rows, otherRow]).some(r => r.publication.id === 'best')).toBe(true);
});

it('keeps an unknown-cost system in its suite/profile cohort and off the frontier, never as the default view', async () => {
  const unpriced = benchmarkFixture('unpriced', '1', 4);
  for (const run of unpriced.runs) run.cost = { ...unknownCost };
  const publications = [benchmarkFixture('priced-a', '1', 3), benchmarkFixture('priced-b', '2', 2), benchmarkFixture('priced-c', '3', 4), reseal(unpriced)];
  const rows = publicRows({ release: fixtureRelease(publications), publications });
  expect(cohortOptions(rows).map(o => o.systems)).toEqual([4]);
  expect(costComparable(rows).map(r => r.publication.id)).toEqual(['priced-a', 'priced-b', 'priced-c']);
  expect(frontier(rows).map(r => r.publication.id)).toEqual(['priced-a', 'priced-c']);
  const dir = await directory(); const release = fixtureRelease(publications);
  await createBenchmarkRegistry(dir).import(publications, release);
  const origin = await serve(createBenchmarks(loadConfig({ DATA_DIR: dir, PUBLIC_URL: 'https://example.test' })));
  const html = await (await fetch(`${origin}/benchmarks/community/${release.id}/1/`)).text();
  const { page } = hydration(html);
  expect(page.initialCohort).toBe(cohort(publications[0]!));
  expect(page.rows.filter(row => cohort(row.publication) === page.initialCohort)).toHaveLength(4);
  expect(html.match(/<option /g)).toHaveLength(1);
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
  expect(html).toContain('frontier-canvas'); expect(html).toContain('<table');
  expect(html).not.toContain('WebGL'); expect(html).toContain(`https://example.test${path}`);
  const manifest = await (await fetch(origin + path + 'manifest.json')).json(); expect(manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect((await (await fetch(origin + path + 'data.json')).json()).publications[0].digest).toBe(p.digest);
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
