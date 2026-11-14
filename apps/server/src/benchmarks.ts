import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { canonicalJson } from 'playerthree';
import type { PostgresStorage } from 'playerthree/postgres';
import type { ServerConfig } from './config.ts';
import { PAGE_CSP } from './http.ts';
import { createBenchmarkRegistry, type ReleasedBenchmark } from './benchmark-registry.ts';
import { createBenchmarkRenderer, benchmarkImage } from './benchmark-document.ts';
import { cohortOptions, releasePath, runPath, type BenchmarkPage, type PublicBenchmark, type ReleaseCard } from '../../web/src/benchmarks/model.ts';

export function publicRows(record: ReleasedBenchmark): PublicBenchmark[] {
  const r = record.release;
  return record.publications.map(publication => ({ publication, releaseId: r.id, releaseRevision: r.revision,
    publisher: r.publisher, evidence: r.evidence, releasedAt: r.notBefore, correction: r.correction,
    supersedes: r.supersedes ? releasePath({ publisher: r.publisher, releaseId: r.supersedes.id, releaseRevision: r.supersedes.revision }) : null }));
}
function releaseCard(record: ReleasedBenchmark): ReleaseCard {
  const r = record.release;
  return { id: r.id, revision: r.revision, title: r.title, path: releasePath({ publisher: r.publisher, releaseId: r.id, releaseRevision: r.revision }),
    publisher: r.publisher, evidence: r.evidence, publishedAt: r.publishedAt, notBefore: r.notBefore, digest: r.digest,
    systems: record.publications.length, correction: r.correction,
    previous: r.supersedes ? releasePath({ publisher: r.publisher, releaseId: r.supersedes.id, releaseRevision: r.supersedes.revision }) : null };
}

/** Bound on cached responses; arbitrary query strings can only churn this, never grow memory. */
const CACHED_RESPONSES = 128;

export function createBenchmarks(config: ServerConfig, storage?: PostgresStorage) {
  const registry = createBenchmarkRegistry(config.dataDir, storage);
  const render = createBenchmarkRenderer(config.webDist);
  const origin = config.publicUrl?.origin ?? 'https://agentcommand.gg';
  // Response bytes keyed by the immutable release/publication digests they render. The live set is still read on every
  // request, so withdrawal and embargo apply at once; entries depending on a digest that stops being live are evicted.
  const responses = new Map<string, { deps: readonly string[]; body: string | Buffer }>();
  let liveDigests = '';
  function sweep(records: readonly ReleasedBenchmark[]): void {
    const digests = records.flatMap(r => [r.release.digest, ...r.publications.map(p => p.digest)]);
    if (digests.join() === liveDigests) return;
    liveDigests = digests.join();
    const live = new Set(digests);
    for (const [key, entry] of responses) if (entry.deps.some(digest => !live.has(digest))) responses.delete(key);
  }
  async function memo(key: string, deps: readonly string[], make: () => Promise<string | Buffer> | string): Promise<string | Buffer> {
    const id = JSON.stringify([key, deps]);
    const hit = responses.get(id);
    if (hit) { responses.delete(id); responses.set(id, hit); return hit.body; }
    const body = await make();
    responses.set(id, { deps, body });
    if (responses.size > CACHED_RESPONSES) responses.delete(responses.keys().next().value!);
    return body;
  }
  const png = (title: string, subtitle: string) => sharp(Buffer.from(benchmarkImage(title, subtitle))).png().toBuffer();
  async function paths(): Promise<string[]> {
    const records = await registry.list();
    return ['/benchmarks/', '/benchmarks/methodology/', '/benchmarks/contribute/', '/benchmarks/authored-policy/', '/benchmarks/live-command/', '/benchmarks/community/',
      ...records.flatMap(r => [releaseCard(r).path, ...publicRows(r).flatMap(row => [runPath(row.publication), `${releaseCard(r).path}systems/${encodeURIComponent(row.publication.experiment.system.id)}/`])])];
  }
  /** A released ACBench run whose frozen policy artifact digest is one of these (the card's "Verified in ACBench"). */
  async function acbench(hashes: readonly string[]): Promise<{ id: string; revision: number; path: string } | null> {
    const wanted = new Set(hashes);
    for (const record of await registry.list()) for (const row of publicRows(record)) {
      if (row.publication.runs.some(run => run.artifactDigest !== null && wanted.has(run.artifactDigest))) return { id: row.publication.id, revision: row.publication.revision, path: runPath(row.publication) };
    }
    return null;
  }
  return { paths, acbench, async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!(path === '/benchmarks' || path.startsWith('/benchmarks/') || path === '/api/benchmarks' || path.startsWith('/api/benchmarks/'))) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }).end(); return true; }
    if (path === '/benchmarks') { res.writeHead(308, { Location: '/benchmarks/', 'Cache-Control': 'no-store' }).end(); return true; }
    // One authorized snapshot supplies SSR, hydration data, exports, social images and catalogue. No share lookup.
    const records = await registry.list();
    sweep(records);
    let body: string | Buffer | undefined; let mime = 'text/html; charset=utf-8'; let status = 200;
    // Set by every 200 route: the response's producer and the immutable digests it depends on.
    let make: (() => Promise<string | Buffer> | string) | undefined; let deps: string[] = [];
    const page: BenchmarkPage = { kind: 'unavailable', title: 'Publication unavailable', canonical: `${origin}${path}`, image: `${origin}/benchmarks/og.png`,
      releases: [], rows: [], release: null, initialCohort: url.searchParams.get('cohort'), initialModel: (url.searchParams.get('model') ?? '').slice(0, 200), replacement: null };
    const allRows = records.flatMap(publicRows);
    const run = /^\/benchmarks\/runs\/([A-Za-z0-9_.-]+)\/(\d+)\/(data\.json|manifest\.json|og\.png)?$/.exec(path);
    const release = /^\/benchmarks\/(authored-policy|community)\/([A-Za-z0-9_.-]+)\/(\d+)\/(?:systems\/([A-Za-z0-9_.-]+)\/|(data\.json|manifest\.json|scores\.csv|og\.png))?$/.exec(path);
    let selectedRecord: ReleasedBenchmark | undefined; let selectedRow: PublicBenchmark | undefined; let download: string | undefined;
    if (run) { selectedRow = allRows.find(r => r.publication.id === run[1] && r.publication.revision === Number(run[2])); download = run[3]; }
    if (release) {
      selectedRecord = records.find(r => r.release.id === release[2] && r.release.revision === Number(release[3]) && (r.release.publisher === 'official' ? 'authored-policy' : 'community') === release[1]);
      if (release[4] && selectedRecord) selectedRow = publicRows(selectedRecord).find(r => r.publication.experiment.system.id === release[4]);
      download = release[5];
    }
    if (path === '/api/benchmarks') { body = canonicalJson({ releases: records.map(r => ({ ...r.release, path: releaseCard(r).path })) }); mime = 'application/json; charset=utf-8'; }
    else if (path === '/benchmarks/og.png') { deps = records.map(r => r.release.digest); make = () => png('AI policy benchmark', `${records.length} released snapshots`); mime = 'image/png'; }
    else if (run || release) {
      if ((!selectedRow && run) || (!selectedRecord && release) || (release?.[4] && !selectedRow)) status = 404;
      else {
        const ownRelease = selectedRecord?.release ?? records.find(r => r.release.id === selectedRow!.releaseId && r.release.revision === selectedRow!.releaseRevision)!.release;
        const replacement = records.find(r => r.release.supersedes?.id === ownRelease.id && r.release.supersedes.revision === ownRelease.revision);
        deps = [ownRelease.digest, ...(selectedRecord ? selectedRecord.publications.map(p => p.digest) : [selectedRow!.publication.digest]), ...(replacement ? [replacement.release.digest] : [])];
        const data = selectedRow ? selectedRow.publication : { release: selectedRecord!.release, publications: selectedRecord!.publications };
        page.title = selectedRow ? selectedRow.publication.experiment.system.label : selectedRecord!.release.title;
        page.canonical = origin + (selectedRow && run ? runPath(selectedRow.publication) : selectedRecord ? releaseCard(selectedRecord).path + (release?.[4] ? `systems/${release[4]}/` : '') : path);
        page.image = origin + (selectedRow ? `${runPath(selectedRow.publication)}og.png` : `${releaseCard(selectedRecord!).path}og.png`);
        if (download === 'data.json') { make = () => canonicalJson(data); mime = 'application/json; charset=utf-8'; }
        else if (download === 'manifest.json') {
          make = () => {
            const bytes = canonicalJson(data);
            return canonicalJson({ format: 'acbench.download-manifest', version: 1, release: ownRelease,
              files: [{ name: 'data.json', bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/json' }],
              privacy: 'Results and attribution only; no prompts, transcripts, source or private capabilities.' });
          }; mime = 'application/json; charset=utf-8';
        } else if (download === 'scores.csv') {
          const quote = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
          make = () => ['system,score,ci_low,ci_high,expected_runs,completed_runs,failed_runs,scored_trials,expected_trials,publication_digest',
            ...selectedRecord!.publications.map(p => [p.experiment.system.id, p.score.value, p.score.interval?.[0], p.score.interval?.[1], p.score.expectedRuns, p.score.completedRuns, p.score.failedRuns, p.score.scoredTrials, p.score.expectedTrials, p.digest].map(quote).join(','))].join('\n'); mime = 'text/csv; charset=utf-8';
        } else if (download === 'og.png') { const title = page.title; make = () => png(title, selectedRow ? 'Versioned run evidence' : `${selectedRecord!.publications.length} systems · Immutable revision ${selectedRecord!.release.revision}`); mime = 'image/png'; }
        else {
          page.kind = selectedRow ? 'run' : 'release'; page.rows = selectedRow ? [selectedRow] : publicRows(selectedRecord!);
          page.release = selectedRecord ? releaseCard(selectedRecord) : null;
          // The largest suite/profile cohort opens by default; cost coverage never selects or splits the view.
          page.initialCohort ??= cohortOptions(page.rows)[0]?.value ?? null;
          if (selectedRecord && replacement) page.replacement = { path: releaseCard(replacement).path, revision: replacement.release.revision, reason: replacement.release.correction };
        }
      }
    } else if (path === '/benchmarks/' || path === '/benchmarks/authored-policy/' || path === '/benchmarks/community/') {
      page.kind = 'hub'; page.title = path === '/benchmarks/' ? 'AI policy benchmark' : path.includes('/community/') ? 'Community artifact evaluation' : 'Official authored-policy';
      const listed = records.filter(r => path === '/benchmarks/' || r.release.publisher === (path.includes('/community/') ? 'community' : 'official'));
      page.releases = listed.map(releaseCard); deps = listed.map(r => r.release.digest);
    } else if (path === '/benchmarks/methodology/') { page.kind = 'methods'; page.title = 'Methods & limitations'; }
    else if (path === '/benchmarks/contribute/') { page.kind = 'contribute'; page.title = 'Contribute evidence'; }
    else if (path === '/benchmarks/live-command/') { page.kind = 'live'; page.title = 'Live-command evaluation'; }
    else status = 404;
    if (body === undefined) {
      if (status === 200) body = await memo(JSON.stringify([path, page.initialCohort, page.initialModel]), deps, make ?? (() => render(page)));
      else body = await render(page);
    }
    // Revalidate every delivery: immutable evidence identity does not override withdrawal policy.
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Type', mime);
    res.setHeader('Content-Security-Policy', mime.startsWith('text/html') ? PAGE_CSP : "default-src 'none'; frame-ancestors 'none'");
    if (status === 200 && mime.startsWith('text/html')) res.removeHeader('X-Robots-Tag'); else res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Length', Buffer.byteLength(body)); res.writeHead(status).end(req.method === 'HEAD' ? undefined : body); return true;
  } };
}
