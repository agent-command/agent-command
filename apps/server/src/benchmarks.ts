import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { canonicalJson } from 'playerthree';
import type { PostgresStorage } from 'playerthree/postgres';
import type { ServerConfig } from './config.ts';
import { PAGE_CSP } from './http.ts';
import { createBenchmarkRegistry, type ReleasedBenchmark } from './benchmark-registry.ts';
import { createBenchmarkRenderer, benchmarkImage } from './benchmark-document.ts';
import { cohort, cohortOptions, cost, dateText, headlineEntries, latestVersion, releasePath, runPath, systemName, tldr, versionName, type BenchmarkPage, type Headline, type PublicBenchmark, type ReleaseCard } from '../../web/src/benchmarks/model.ts';

/** The rows a release's charts open with: its largest suite/harness cohort (the default view). */
function leadingRows(record: ReleasedBenchmark): PublicBenchmark[] {
  const rows = publicRows(record); const lead = cohortOptions(rows)[0]?.value;
  return rows.filter(row => cohort(row.publication) === lead);
}
/** The newest version among `records` with its ranked scores and TL;DR, or null before anything is released. */
function latestHeadline(records: readonly ReleasedBenchmark[]): { headline: Headline; record: ReleasedBenchmark } | null {
  const latest = latestVersion(records.map(r => releaseCard(r, records)));
  const record = latest && records.find(r => r.release.id === latest.id && r.release.revision === latest.revision && r.release.publisher === latest.publisher);
  if (!latest || !record) return null;
  const rows = leadingRows(record);
  return { record, headline: { release: latest, entries: headlineEntries(rows), bullets: tldr(rows) } };
}
/**
 * The page of the revision `record` supersedes, under that revision's own publisher (a correction may move a version
 * from community to official); `records` are the live releases.
 */
function supersededPath(record: ReleasedBenchmark, records: readonly ReleasedBenchmark[]): string | null {
  const r = record.release;
  if (!r.supersedes) return null;
  const { id, revision } = r.supersedes;
  const prior = records.find(p => p.release.id === id && p.release.revision === revision);
  return releasePath({ publisher: prior?.release.publisher ?? r.publisher, releaseId: id, releaseRevision: revision });
}
export function publicRows(record: ReleasedBenchmark, records: readonly ReleasedBenchmark[] = [record]): PublicBenchmark[] {
  const r = record.release;
  const supersedes = supersededPath(record, records);
  return record.publications.map(publication => ({ publication, releaseId: r.id, releaseRevision: r.revision,
    publisher: r.publisher, evidence: r.evidence, releasedAt: r.notBefore, correction: r.correction, supersedes }));
}
function releaseCard(record: ReleasedBenchmark, records: readonly ReleasedBenchmark[]): ReleaseCard {
  const r = record.release;
  return { id: r.id, revision: r.revision, title: r.title, path: releasePath({ publisher: r.publisher, releaseId: r.id, releaseRevision: r.revision }),
    publisher: r.publisher, evidence: r.evidence, publishedAt: r.publishedAt, notBefore: r.notBefore, digest: r.digest,
    systems: record.publications.length, correction: r.correction, previous: supersededPath(record, records) };
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
  const png = (title: string, subtitle: string, rows?: readonly PublicBenchmark[]) =>
    sharp(Buffer.from(benchmarkImage(title, subtitle, rows && headlineEntries(rows)))).png().toBuffer();
  async function paths(): Promise<string[]> {
    const records = await registry.list();
    return ['/benchmarks/', '/benchmarks/methodology/', '/benchmarks/contribute/', '/benchmarks/authored-policy/', '/benchmarks/live-command/', '/benchmarks/community/',
      ...records.flatMap(r => [releaseCard(r, records).path, ...publicRows(r, records).flatMap(row => [runPath(row.publication), `${releaseCard(r, records).path}systems/${encodeURIComponent(row.publication.experiment.system.id)}/`])])];
  }
  /** A released ACBench run whose frozen policy artifact digest is one of these (the card's "Verified in ACBench"). */
  async function acbench(hashes: readonly string[]): Promise<{ id: string; revision: number; path: string } | null> {
    const wanted = new Set(hashes);
    const records = await registry.list();
    for (const record of records) for (const row of publicRows(record, records)) {
      if (row.publication.runs.some(run => run.artifactDigest !== null && wanted.has(run.artifactDigest))) return { id: row.publication.id, revision: row.publication.revision, path: runPath(row.publication) };
    }
    return null;
  }
  return { paths, acbench, async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    // Model Breakdown clips and lab icons (apps/web/public/benchmarks/{clips,labs}/) are static files, served after this handler.
    if (!(path === '/benchmarks' || path.startsWith('/benchmarks/') || path === '/api/benchmarks' || path.startsWith('/api/benchmarks/')) || path.startsWith('/benchmarks/clips/') || path.startsWith('/benchmarks/labs/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }).end(); return true; }
    if (path === '/benchmarks') { res.writeHead(308, { Location: '/benchmarks/', 'Cache-Control': 'no-store' }).end(); return true; }
    // One authorized snapshot supplies SSR, hydration data, exports, social images and catalogue. No share lookup.
    const records = await registry.list();
    sweep(records);
    let body: string | Buffer | undefined; let mime = 'text/html; charset=utf-8'; let status = 200;
    // Set by every 200 route: the response's producer and the immutable digests it depends on.
    let make: (() => Promise<string | Buffer> | string) | undefined; let deps: string[] = [];
    const page: BenchmarkPage = { kind: 'unavailable', title: 'Publication unavailable', canonical: `${origin}${path}`, image: `${origin}/benchmarks/og.png`,
      releases: [], rows: [], release: null, initialCohort: url.searchParams.get('cohort'), initialModel: (url.searchParams.get('model') ?? '').slice(0, 200), replacement: null, headline: null };
    const allRows = records.flatMap(r => publicRows(r, records));
    const run = /^\/benchmarks\/runs\/([A-Za-z0-9_.-]+)\/(\d+)\/(data\.json|manifest\.json|og\.png)?$/.exec(path);
    const release = /^\/benchmarks\/(authored-policy|community)\/([A-Za-z0-9_.-]+)\/(\d+)\/(?:systems\/([A-Za-z0-9_.-]+)\/|(data\.json|manifest\.json|scores\.csv|og\.png))?$/.exec(path);
    let selectedRecord: ReleasedBenchmark | undefined; let selectedRow: PublicBenchmark | undefined; let download: string | undefined;
    if (run) { selectedRow = allRows.find(r => r.publication.id === run[1] && r.publication.revision === Number(run[2])); download = run[3]; }
    if (release) {
      selectedRecord = records.find(r => r.release.id === release[2] && r.release.revision === Number(release[3]) && (r.release.publisher === 'official' ? 'authored-policy' : 'community') === release[1]);
      if (release[4] && selectedRecord) selectedRow = publicRows(selectedRecord, records).find(r => r.publication.experiment.system.id === release[4]);
      download = release[5];
    }
    if (path === '/api/benchmarks') { body = canonicalJson({ releases: records.map(r => ({ ...r.release, path: releaseCard(r, records).path })) }); mime = 'application/json; charset=utf-8'; }
    else if (path === '/benchmarks/og.png') {
      const latest = latestHeadline(records);
      deps = [...records.map(r => r.release.digest), ...latest?.record.publications.map(p => p.digest) ?? []]; mime = 'image/png';
      make = () => latest ? png(versionName(latest.headline.release), `${dateText(latest.headline.release.notBefore)} · score 0–100 against fixed bots`, leadingRows(latest.record))
        : png('AI policy benchmark', 'No released versions yet');
    }
    else if (run || release) {
      if ((!selectedRow && run) || (!selectedRecord && release) || (release?.[4] && !selectedRow)) status = 404;
      else {
        const ownRelease = selectedRecord?.release ?? records.find(r => r.release.id === selectedRow!.releaseId && r.release.revision === selectedRow!.releaseRevision)!.release;
        const replacement = records.find(r => r.release.supersedes?.id === ownRelease.id && r.release.supersedes.revision === ownRelease.revision);
        deps = [ownRelease.digest, ...(selectedRecord ? selectedRecord.publications.map(p => p.digest) : [selectedRow!.publication.digest]), ...(replacement ? [replacement.release.digest] : [])];
        const data = selectedRow ? selectedRow.publication : { release: selectedRecord!.release, publications: selectedRecord!.publications };
        page.title = selectedRow ? systemName(selectedRow.publication.experiment.system).name : selectedRecord!.release.title;
        page.canonical = origin + (selectedRow && run ? runPath(selectedRow.publication) : selectedRecord ? releaseCard(selectedRecord, records).path + (release?.[4] ? `systems/${release[4]}/` : '') : path);
        page.image = origin + (selectedRow ? `${runPath(selectedRow.publication)}og.png` : `${releaseCard(selectedRecord!, records).path}og.png`);
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
          // Exact unrounded mean authoring USD (empty when any run's cost is unknown or partial); the page shows cents.
          make = () => ['system,score,ci_low,ci_high,expected_runs,completed_runs,failed_runs,scored_trials,expected_trials,mean_authoring_cost_usd,publication_digest',
            ...selectedRecord!.publications.map(p => [p.experiment.system.id, p.score.value, p.score.interval?.[0], p.score.interval?.[1], p.score.expectedRuns, p.score.completedRuns, p.score.failedRuns, p.score.scoredTrials, p.score.expectedTrials, cost(p), p.digest].map(quote).join(','))].join('\n'); mime = 'text/csv; charset=utf-8';
        } else if (download === 'og.png') {
          const title = selectedRow ? page.title : versionName(selectedRecord!.release);
          make = () => selectedRow ? png(title, 'Versioned run evidence')
            : png(title, `${dateText(selectedRecord!.release.notBefore)} · ${selectedRecord!.publications.length} systems · score 0–100`, leadingRows(selectedRecord!));
          mime = 'image/png';
        }
        else {
          page.kind = selectedRow ? 'run' : 'release'; page.rows = selectedRow ? [selectedRow] : publicRows(selectedRecord!, records);
          page.release = selectedRecord ? releaseCard(selectedRecord, records) : null;
          // The largest suite/harness cohort opens by default; cost coverage never selects or splits the view.
          page.initialCohort ??= cohortOptions(page.rows)[0]?.value ?? null;
          if (selectedRecord && replacement) page.replacement = { path: releaseCard(replacement, records).path, revision: replacement.release.revision, reason: replacement.release.correction };
        }
      }
    } else if (path === '/benchmarks/' || path === '/benchmarks/authored-policy/' || path === '/benchmarks/community/') {
      page.kind = 'hub'; page.title = path === '/benchmarks/' ? 'AI policy benchmark' : path.includes('/community/') ? 'Community artifact evaluation' : 'Official authored-policy';
      // A version's current revision only: a correction may move it to another publisher's listing.
      const current = records.filter(r => !records.some(o => o.release.supersedes?.id === r.release.id && o.release.supersedes.revision === r.release.revision));
      const listed = current.filter(r => path === '/benchmarks/' || r.release.publisher === (path.includes('/community/') ? 'community' : 'official'));
      page.releases = listed.map(r => releaseCard(r, records));
      const latest = latestHeadline(listed);
      page.headline = latest?.headline ?? null;
      deps = [...listed.map(r => r.release.digest), ...latest?.record.publications.map(p => p.digest) ?? []];
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
