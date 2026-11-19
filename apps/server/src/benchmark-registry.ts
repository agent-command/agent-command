/** Explicit curated release snapshots, independent of private series and bearer shares. */
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from 'playerthree';
import { benchmarkDigest, validateBenchmarkPublication, type BenchmarkPublication } from 'playerthree/benchmark';
import { importBenchmarkPublication, jsonBenchmarkStore, postgresBenchmarkStore, type BenchmarkPublicationStore } from 'playerthree/benchmark-store';
import type { PostgresStorage } from 'playerthree/postgres';
import { manifest } from '@agent-command/game';

export interface BenchmarkRelease {
  format: 'acbench.release'; version: 1; id: string; revision: number; title: string;
  publishedAt: string; notBefore: string; publisher: 'official' | 'community';
  evidence: 'runner-observed' | 'trusted-rerun' | 'submitted';
  publicationIds: string[]; supersedes: { id: string; revision: number } | null;
  correction: string | null; privacyReviewed: true; digest: string;
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const keyOf = (id: string, revision: number): string => {
  if (!idPattern.test(id) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid release identity');
  return `${id}.r${revision}`;
};
export function validateRelease(input: unknown): BenchmarkRelease {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid release');
  const r = input as BenchmarkRelease;
  const fields = ['format','version','id','revision','title','publishedAt','notBefore','publisher','evidence','publicationIds','supersedes','correction','privacyReviewed','digest'];
  if (Object.keys(r).some(k => !fields.includes(k)) || fields.some(k => !(k in r))) throw new Error('Release must use the closed publication projection');
  keyOf(r.id, r.revision);
  if (r.format !== 'acbench.release' || r.version !== 1 || r.privacyReviewed !== true || typeof r.title !== 'string' || !r.title.length || r.title.length > 180 || /[\x00-\x1f]/.test(r.title) || !['official','community'].includes(r.publisher) || !['runner-observed','trusted-rerun','submitted'].includes(r.evidence)) throw new Error('Invalid release metadata');
  if (![r.publishedAt, r.notBefore].every(v => typeof v === 'string' && Number.isFinite(Date.parse(v))) || Date.parse(r.notBefore) < Date.parse(r.publishedAt)) throw new Error('Invalid release watermark');
  if (!Array.isArray(r.publicationIds) || !r.publicationIds.length || r.publicationIds.length > 500 || new Set(r.publicationIds).size !== r.publicationIds.length || r.publicationIds.some(id => typeof id !== 'string' || !idPattern.test(id))) throw new Error('Invalid release publications');
  if (r.supersedes !== null) {
    if (!r.supersedes || Object.keys(r.supersedes).sort().join(',') !== 'id,revision') throw new Error('Invalid correction lineage');
    keyOf(r.supersedes.id, r.supersedes.revision);
    if (r.supersedes.id !== r.id || r.supersedes.revision !== r.revision - 1 || typeof r.correction !== 'string' || r.correction.length < 1 || r.correction.length > 1000) throw new Error('Corrections must append the next revision and explain why');
  } else if (r.revision !== 1 || r.correction !== null) throw new Error('First release must be revision 1');
  const { digest, ...body } = r;
  if (digest !== benchmarkDigest(body)) throw new Error('Release digest mismatch');
  return r;
}
export interface ReleasedBenchmark { release: BenchmarkRelease; publications: BenchmarkPublication[] }

export function createBenchmarkRegistry(dataDir?: string, storage?: PostgresStorage) {
  const directory = dataDir ? join(dataDir, 'benchmarks') : undefined;
  const publications: BenchmarkPublicationStore | undefined = storage ? postgresBenchmarkStore((sql, params) => storage.query(sql, params), manifest.id) : directory ? jsonBenchmarkStore(join(directory, 'publications')) : undefined;
  const releasesDir = directory ? join(directory, 'releases') : undefined;
  // Immutable documents are validated (hashed) once per exact stored bytes, not on every public request.
  const validated = new Map<string, BenchmarkRelease>();
  const reported = new Set<string>();
  /** One corrupt stored record withholds only itself: the site, data routes and sitemap keep serving the rest. */
  function skip(kind: string, key: string, error: unknown): null {
    if (!reported.has(`${kind}:${key}`)) { reported.add(`${kind}:${key}`); console.error(`acbench: withholding invalid stored ${kind} ${key}:`, error instanceof Error ? error.message : error); }
    return null;
  }
  function release(cacheKey: string, label: string, document: () => unknown, expectedDigest?: string): BenchmarkRelease | null {
    const known = validated.get(cacheKey);
    if (known) return known;
    try {
      const valid = validateRelease(document());
      if (expectedDigest !== undefined && valid.digest !== expectedDigest) throw new Error('Stored release digest mismatch');
      validated.set(cacheKey, valid);
      if (validated.size > 1024) validated.delete(validated.keys().next().value!);
      return valid;
    } catch (error) { return skip('release', label, error); }
  }
  async function records(): Promise<BenchmarkRelease[]> {
    if (storage) return (await storage.query('SELECT id, revision, digest, document FROM ac_benchmark_releases WHERE withdrawn_at IS NULL ORDER BY id, revision', []))
      .flatMap(r => release(`db:${String(r.id)}.r${String(r.revision)}:${String(r.digest)}`, `${String(r.id)}.r${String(r.revision)}`, () => r.document, String(r.digest)) ?? []);
    if (!releasesDir) return [];
    let files: string[];
    try { files = await readdir(releasesDir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const tombstones = new Set(files.filter(f => f.endsWith('.withdrawn')).map(f => f.slice(0, -10)));
    const out: BenchmarkRelease[] = [];
    for (const f of files.filter(f => f.endsWith('.json')).sort()) {
      if (tombstones.has(f.slice(0, -5))) continue;
      const text = await readFile(join(releasesDir, f), 'utf8');
      const valid = release(`file:${f}:${text}`, f, () => JSON.parse(text));
      if (valid) out.push(valid);
    }
    return out;
  }
  async function get(id: string, revision: number, now = Date.now()): Promise<ReleasedBenchmark | null> {
    const key = keyOf(id, revision);
    const found = (await records()).find(r => keyOf(r.id, r.revision) === key);
    return found ? materialize(found, now) : null;
  }
  async function materialize(snapshot: BenchmarkRelease, now: number): Promise<ReleasedBenchmark | null> {
    if (Date.parse(snapshot.notBefore) > now || !publications) return null;
    let result: (BenchmarkPublication | null)[];
    try { result = await Promise.all(snapshot.publicationIds.map(id => publications.get(id))); }
    catch (error) { return skip('release member of', keyOf(snapshot.id, snapshot.revision), error); }
    // A withdrawn member invalidates the snapshot; never silently rank a smaller cohort.
    if (result.some(p => p === null)) return null;
    return { release: snapshot, publications: result as BenchmarkPublication[] };
  }
  async function putExclusive(file: string, body: string): Promise<void> {
    await mkdir(releasesDir!, { recursive: true, mode: 0o700 });
    const tmp = join(releasesDir!, `${randomUUID()}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    try { await link(tmp, file); } finally { await unlink(tmp); }
    const dir = await open(releasesDir!, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  return {
    get,
    async list(now = Date.now()): Promise<ReleasedBenchmark[]> {
      const result: ReleasedBenchmark[] = [];
      for (const r of await records()) { const record = await materialize(r, now); if (record) result.push(record); }
      return result;
    },
    async import(input: unknown, releaseInput: unknown): Promise<BenchmarkRelease> {
      if (!publications) throw new Error('Publication requires DATABASE_URL or DATA_DIR');
      if (!Array.isArray(input)) throw new Error('Import requires a publication array');
      const entries = input.map(validateBenchmarkPublication); const release = validateRelease(releaseInput);
      if (entries.length !== release.publicationIds.length || release.publicationIds.some(id => !entries.some(p => p.id === id)) || entries.some(p => p.suite.game !== manifest.id)) throw new Error('Release membership/game mismatch');
      if (new Set(entries.map(p => p.experiment.system.id)).size !== entries.length || entries.some(p => !idPattern.test(p.experiment.system.id))) throw new Error('Release systems require unique URL-safe identifiers');
      const projection = canonicalJson({ release, entries });
      if (/(?:Bearer\s+[A-Za-z0-9._-]{12,}|\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}|\/arena\/share\/|\b(?:api[_-]?key|password|private[_-]?key)\s*[:=])/i.test(projection)) throw new Error('Public projection contains credential or private-capability patterns');
      if (entries.some(p => !p.consent.attribution)) throw new Error('Public attribution requires explicit consent');
      if (entries.some(p => Date.parse(p.publishedAt) > Date.parse(release.notBefore))) throw new Error('Release precedes publication');
      // An official release may carry a model whose later runs are still being scored (shown as incomplete) and models on
      // their own API wires (one configuration digest per wire); the suite and harness stay fixed.
      if (release.publisher === 'official' && (release.evidence !== 'runner-observed' || entries.some(p => p.experiment.provenance !== 'runner-observed' || p.suite.track !== 'authored-policy' || p.score.completedRuns < 1 || ['scripted', 'synthetic'].includes(p.experiment.system.provider ?? '')))) throw new Error('Official results require trusted authoring evidence with a scored run, not scripted fixtures');
      if (release.publisher === 'official' && new Set(entries.map(p => canonicalJson({ suite: p.suite.digest, harness: p.experiment.system.harness }))).size !== 1) throw new Error('Official model comparisons require one fixed suite and harness');
      if (release.evidence === 'runner-observed' && entries.some(p => p.experiment.provenance !== 'runner-observed')) throw new Error('Evidence provenance mismatch');
      const prior = await records();
      if (prior.some(r => r.id === release.id && r.revision === release.revision)) throw new Error('Immutable release already exists');
      if (release.supersedes && !prior.some(r => r.id === release.supersedes!.id && r.revision === release.supersedes!.revision)) throw new Error('Correction target not found');
      const knownSuites = new Map<string, { digest: string; version: number }[]>();
      for (const p of [...await publications.list(), ...entries]) knownSuites.set(p.suite.id, [...knownSuites.get(p.suite.id) ?? [], { digest: p.suite.digest, version: p.suite.version }]);
      for (const [suiteId, known] of knownSuites) for (const { digest, version } of known) {
        if (known.some(k => k.version === version && k.digest !== digest)) {
          const next = Math.max(...known.map(k => k.version)) + 1;
          throw new Error(`Suite ${suiteId} version ${version} already names different contents. Prepare the changed suite as a new version (pnpm bench:reference ... --prepare --suite-version ${next}) and re-run its campaign.`);
        }
      }
      // Persist evidence before making the release discoverable. A crash can leave private orphan evidence, never a partial release.
      for (const p of entries) await importBenchmarkPublication(publications, p);
      if (storage) await storage.query('INSERT INTO ac_benchmark_releases (id,revision,digest,document) VALUES ($1,$2,$3,$4::jsonb)', [release.id, release.revision, release.digest, canonicalJson(release)]);
      else await putExclusive(join(releasesDir!, `${keyOf(release.id, release.revision)}.json`), canonicalJson(release));
      return release;
    },
    async withdraw(id: string, revision: number): Promise<void> {
      const key = keyOf(id, revision);
      if (storage) await storage.query('UPDATE ac_benchmark_releases SET withdrawn_at=COALESCE(withdrawn_at,now()) WHERE id=$1 AND revision=$2', [id, revision]);
      else if (releasesDir) { try { await putExclusive(join(releasesDir, `${key}.withdrawn`), 'withdrawn'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
      else throw new Error('Publication storage is not configured');
    },
    async withdrawPublication(id: string): Promise<void> { if (!publications) throw new Error('Publication storage is not configured'); await publications.withdraw(id); },
  };
}
