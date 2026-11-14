import type { BenchmarkPublication } from 'playerthree/benchmark';

export interface PublicBenchmark {
  publication: BenchmarkPublication; releaseId: string; releaseRevision: number;
  publisher: 'official' | 'community'; evidence: 'runner-observed' | 'trusted-rerun' | 'submitted';
  releasedAt: string; correction: string | null; supersedes: string | null;
}
export interface ReleaseCard {
  id: string; revision: number; title: string; path: string; publisher: 'official' | 'community';
  evidence: string; publishedAt: string; notBefore: string; digest: string; systems: number;
  correction: string | null; previous: string | null;
}
export interface BenchmarkPage {
  kind: 'hub' | 'release' | 'run' | 'methods' | 'contribute' | 'live' | 'unavailable';
  title: string; canonical: string; image: string;
  releases: ReleaseCard[]; rows: PublicBenchmark[];
  release: ReleaseCard | null; initialCohort: string | null; initialModel: string;
  replacement: { path: string; revision: number; reason: string | null } | null;
}
export interface BenchmarkDocumentProps {
  page: BenchmarkPage;
  assets: { script: string; styles: string[]; brand: { logo: string; icon: string; touchIcon: string; font: string } };
}
export const runPath = (p: BenchmarkPublication): string => `/benchmarks/runs/${encodeURIComponent(p.id)}/${p.revision}/`;
export const releasePath = (row: Pick<PublicBenchmark, 'releaseId' | 'releaseRevision' | 'publisher'>): string =>
  `/benchmarks/${row.publisher === 'official' ? 'authored-policy' : 'community'}/${encodeURIComponent(row.releaseId)}/${row.releaseRevision}/`;
/** Exact, browser-safe comparison identity (suite digest + model-excluding profile); never a truncated hash. */
export const cohort = (p: BenchmarkPublication): string => JSON.stringify([p.suite.digest, p.experiment.system.configurationDigest]);
/** Frozen cost convention of a fully priced publication; null when any run's cost is unknown or partial. */
export const costBasis = (p: BenchmarkPublication): string | null => cost(p) === null ? null
  : JSON.stringify([...new Set(p.runs.map(r => JSON.stringify([r.cost.scope, r.cost.currency, r.cost.source, r.cost.pricingVersion, r.cost.pricedAt])))].sort());
export function cost(p: BenchmarkPublication): number | null {
  if (p.runs.length !== p.score.expectedRuns || p.runs.some(r => r.cost.coverage !== 'complete' || r.cost.scope !== 'authoring-run' || r.cost.source === 'unknown' || r.cost.currency !== 'USD' || r.cost.amount === null || !r.cost.pricingVersion || !r.cost.pricedAt)) return null;
  let average = 0;
  for (const run of p.runs) {
    const amount = Number(run.cost.amount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    average += amount / p.runs.length;
  }
  return p.runs.length > 0 && Number.isFinite(average) ? average : null;
}
export interface CohortOption { value: string; label: string; systems: number }
/** Distinct-labelled cohorts, largest first: the default view compares the most systems side by side. */
export function cohortOptions(rows: readonly PublicBenchmark[]): CohortOption[] {
  const groups = new Map<string, PublicBenchmark[]>();
  for (const row of rows) { const key = cohort(row.publication); groups.set(key, [...groups.get(key) ?? [], row]); }
  const options = [...groups].map(([value, members]) => {
    const p = members[0]!.publication;
    const profile = p.experiment.system.configurationDigest;
    return { value, systems: members.length, short: `${p.suite.id} v${p.suite.version} · ${p.suite.track} · profile ${profile.slice(0, 8)}`,
      long: `${p.suite.id} v${p.suite.version} · ${p.suite.track} · suite ${p.suite.digest.slice(0, 12)} · profile ${profile.slice(0, 16)}` };
  }).sort((a, b) => b.systems - a.systems || a.value.localeCompare(b.value));
  return options.map(({ value, systems, short, long }) => ({ value, systems, label: options.some(o => o.value !== value && o.short === short) ? long : short }));
}
/** Score–cost points share one plot only under one frozen cost convention: the selection's most common basis. */
export function costComparable(rows: readonly PublicBenchmark[]): PublicBenchmark[] {
  const priced = rows.flatMap(row => {
    const basis = costBasis(row.publication);
    return row.publication.score.complete && row.publication.score.value !== null && Number.isFinite(row.publication.score.value) && basis !== null ? [{ row, basis }] : [];
  });
  const counts = new Map<string, number>();
  for (const { basis } of priced) counts.set(basis, (counts.get(basis) ?? 0) + 1);
  const shared = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return priced.filter(p => p.basis === shared).map(p => p.row);
}
export function frontier(rows: readonly PublicBenchmark[]): PublicBenchmark[] {
  const points = rows.flatMap(row => {
    const value = row.publication.score.value; const amount = cost(row.publication); const basis = costBasis(row.publication);
    return row.publication.score.complete && value !== null && Number.isFinite(value) && amount !== null && basis !== null
      ? [{ row, value, amount, key: JSON.stringify([cohort(row.publication), basis]) }] : [];
  });
  // Dominance only within one comparison cohort and one cost convention.
  return points.filter(a => !points.some(b => b !== a && b.key === a.key &&
    b.amount <= a.amount && b.value >= a.value && (b.amount < a.amount || b.value > a.value)))
    .sort((a, b) => a.amount - b.amount || a.row.publication.id.localeCompare(b.row.publication.id)).map(p => p.row);
}
export const scoreText = (value: number | null): string => value === null ? 'Not scored' : (value * 100).toFixed(1);
