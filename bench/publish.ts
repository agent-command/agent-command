/** Explicit local operator workflow, not an unauthenticated administrative HTTP endpoint. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openPostgresStorage } from 'playerthree/postgres';
import { sealBenchmark, validateBenchmarkPublication } from 'playerthree/benchmark';
import { createBenchmarkRegistry, validateRelease, type BenchmarkRelease } from '../apps/server/src/benchmark-registry.ts';

const { values } = parseArgs({ options: {
  input: { type: 'string', multiple: true }, id: { type: 'string' }, revision: { type: 'string', default: '1' },
  title: { type: 'string' }, publisher: { type: 'string', default: 'community' }, evidence: { type: 'string', default: 'submitted' },
  'release-at': { type: 'string' }, correction: { type: 'string' }, preview: { type: 'string' }, import: { type: 'string' },
  'reviewed-privacy-consent': { type: 'boolean' }, 'trusted-execution-reviewed': { type: 'boolean' },
  withdraw: { type: 'boolean' }, 'withdraw-publication': { type: 'string' },
} });
const operations = [values.preview, values.import, values.withdraw, values['withdraw-publication']].filter(Boolean);
if (operations.length !== 1) throw new Error('Choose --preview FILE, --import REVIEWED_BUNDLE, --withdraw --id ID --revision N, or --withdraw-publication ID');
if (values.preview) {
  if (!values.input?.length || !values.id || !values.title) throw new Error('Preview requires --input publication.json (repeatable), --id and --title');
  const publications = await Promise.all(values.input.map(async file => validateBenchmarkPublication(JSON.parse(await readFile(resolve(file), 'utf8')))));
  const revision = Number(values.revision); const publishedAt = new Date().toISOString();
  const release = validateRelease(sealBenchmark({ format: 'acbench.release', version: 1, id: values.id, revision, title: values.title,
    publishedAt, notBefore: values['release-at'] ?? publishedAt, publisher: values.publisher, evidence: values.evidence,
    publicationIds: publications.map(p => p.id), supersedes: revision > 1 ? { id: values.id, revision: revision - 1 } : null,
    correction: values.correction ?? null, privacyReviewed: true }));
  await writeFile(resolve(values.preview), JSON.stringify({ release, publications }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Preview only: ${publications.length} publication(s), release SHA-256 ${release.digest}. Review the entire file, consent, licenses, assistance, privacy and release time before import.`);
} else {
  if (!process.env.DATA_DIR && !process.env.DATABASE_URL) throw new Error('Set explicit DATA_DIR or DATABASE_URL; publication never targets an implicit environment');
  const storage = process.env.DATABASE_URL ? await openPostgresStorage({ url: process.env.DATABASE_URL,
    migrations: { scope: 'agent-command', dir: fileURLToPath(new URL('../apps/server/migrations/', import.meta.url)) } }) : undefined;
  try {
    const registry = createBenchmarkRegistry(process.env.DATA_DIR, storage);
    if (values.import) {
      if (!values['reviewed-privacy-consent']) throw new Error('Import requires --reviewed-privacy-consent after preview review');
      const bundle = JSON.parse(await readFile(resolve(values.import), 'utf8'));
      if (!bundle || Object.keys(bundle).sort().join(',') !== 'publications,release') throw new Error('Expected a closed preview bundle');
      const release: BenchmarkRelease = validateRelease(bundle.release);
      if ((release.publisher === 'official' || release.evidence !== 'submitted') && !values['trusted-execution-reviewed']) throw new Error('Promoting trust requires --trusted-execution-reviewed and operator-held execution evidence; uploaded labels are not evidence');
      await registry.import(bundle.publications, release);
      console.log(`Imported immutable release ${release.id} revision ${release.revision}. Public delivery begins at its reviewed release watermark.`);
    } else if (values['withdraw-publication']) {
      await registry.withdrawPublication(values['withdraw-publication']); console.log('Publication withdrawn from every release. Downloaded copies cannot be recalled.');
    } else {
      if (!values.id) throw new Error('Withdrawal requires --id and --revision');
      await registry.withdraw(values.id, Number(values.revision)); console.log('Release withdrawn. Its public pages, data, social images and sitemap membership are unavailable.');
    }
  } finally { await storage?.close(); }
}
