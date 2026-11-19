import type { BenchmarkPublication, BenchmarkSuite } from 'playerthree/benchmark';

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
  /** Hub only: the latest version's ranked scores, computed on the server so the hub ships no publications. */
  headline: Headline | null;
}
/** One ranked system; `system` is its `experiment.system.id`, the key of curated per-system data (stories, notes). */
export interface HeadlineEntry { id: string; system: string; label: string; route: string | null; model: string | null; lab: Lab | null; value: number | null; interval: [number, number] | null; href: string; note: string | null }
export interface Headline { release: ReleaseCard; entries: HeadlineEntry[]; bullets: string[] }
export interface BenchmarkDocumentProps {
  page: BenchmarkPage;
  assets: { script: string; styles: string[]; brand: { logo: string; icon: string; touchIcon: string; font: string } };
}
export const runPath = (p: BenchmarkPublication): string => `/benchmarks/runs/${encodeURIComponent(p.id)}/${p.revision}/`;
export const releasePath = (row: Pick<PublicBenchmark, 'releaseId' | 'releaseRevision' | 'publisher'>): string =>
  `/benchmarks/${row.publisher === 'official' ? 'authored-policy' : 'community'}/${encodeURIComponent(row.releaseId)}/${row.releaseRevision}/`;
/**
 * The comparison group, shared by the evidence table and the charts: one suite (its digest fixes opponents, maps,
 * budgets and track) on one harness. It spans authoring profiles (a model's own API wire differs per family); a
 * curated profile difference is footnoted ({@link profileNotes}). Exact and browser-safe; never a truncated hash.
 */
export const cohort = (p: BenchmarkPublication): string => JSON.stringify([p.suite.digest, p.experiment.system.harness, p.suite.track]);
/** Curated reasons a system's authoring profile differs from its version's, by release id then system id. */
export const PROFILE_NOTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'acbench-v0-1': { 'deepseek-v4.1-flash': 'authored on a later game build' },
};
/**
 * Footnotes for systems whose authoring profile differs from the group's most common one and whose release curates
 * the reason, by publication id. A chart group already fixes the suite and harness, so an uncurated profile difference
 * (a model's own API wire, which its route label shows) gets no footnote.
 */
export function profileNotes(rows: readonly PublicBenchmark[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const row of rows) { const d = row.publication.experiment.system.configurationDigest; counts.set(d, (counts.get(d) ?? 0) + 1); }
  const common = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const notes = new Map<string, string>();
  for (const row of rows) {
    if (row.publication.experiment.system.configurationDigest === common) continue;
    const curated = Object.hasOwn(PROFILE_NOTES, row.releaseId) ? PROFILE_NOTES[row.releaseId]! : {};
    const id = row.publication.experiment.system.id;
    if (Object.hasOwn(curated, id)) notes.set(row.publication.id, curated[id]!);
  }
  return notes;
}
/** A built-in reference a release cannot carry as a publication, scored 0–1 on the release's own ladder. */
export interface Reference { id: string; label: string; score: number }
/** A release's reference bars (strongest first) and how they were scored, for the headline chart's caption. */
export interface References { bars: readonly Reference[]; source: string }
/**
 * Curated reference bars by release id, drawn beside the models on the headline chart; a release without an entry
 * draws none. v0.1: its runs start from the economy-only skeletons, which lose every ladder game.
 */
export const REFERENCES: Readonly<Record<string, References>> = {
  'acbench-v0-1': { source: 'The untouched skeleton policies played as the candidate on the same 30-game ladder.',
    bars: [{ id: 'skeleton', label: 'Starting skeleton', score: 0 }] },
  'acbench-v0-2': { source: 'Each built-in tier\'s four bot packages and the four default starter policies (default knobs) played as the candidate on the same 30-game ladder, and the untouched skeleton policies every run starts from.',
    bars: [
      { id: 'champion', label: 'Champion bot (veteran, ×1.3 income)', score: 0.8333333333333334 },
      { id: 'elite', label: 'Elite bot (veteran, ×1.15 income)', score: 0.7833333333333333 },
      { id: 'veteran', label: 'Veteran bot', score: 0.5 },
      { id: 'standard', label: 'Standard bot', score: 0.31666666666666665 },
      { id: 'starters', label: 'Default starters', score: 0.2 },
      { id: 'novice', label: 'Novice bot', score: 0.1 },
      { id: 'skeleton', label: 'Starting skeleton', score: 0 },
    ] },
};
export const referencesFor = (releaseId: string): References | null => Object.hasOwn(REFERENCES, releaseId) ? REFERENCES[releaseId]! : null;
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
    const harness = p.experiment.system.harness;
    return { value, systems: members.length, short: `${p.suite.id} v${p.suite.version} · ${p.suite.track} · ${harness}`,
      long: `${p.suite.id} v${p.suite.version} · ${p.suite.track} · suite ${p.suite.digest.slice(0, 12)} · ${harness}` };
  }).sort((a, b) => b.systems - a.systems || a.value.localeCompare(b.value));
  return options.map(({ value, systems, short, long }) => ({ value, systems, label: options.some(o => o.value !== value && o.short === short) ? long : short }));
}
export const scoreText = (value: number | null): string => value === null ? 'Not scored' : (value * 100).toFixed(1);
/** USD to the cent ("$2.39"); a positive sub-cent amount reads "<$0.01" rather than "$0.00". Exact values stay in downloads. */
export const usd = (amount: number): string => amount > 0 && amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`;
/**
 * Display names of the pinned benchmark models (bench/frontier-models.ts; a server test checks every pinned model has
 * one), keyed by the publication's requested model id. Unknown ids keep the publication's own label: no guessed names.
 */
export const MODEL_NAMES: Readonly<Record<string, string>> = {
  'anthropic/claude-opus-5.5': 'Claude Opus 5.5',
  'anthropic/claude-fable-5.2': 'Claude Fable 5.2',
  'google/gemini-4-carbon': 'Gemini 4 Carbon',
  'openai/gpt-6.1-sol': 'GPT-6.1 Sol',
  'deepseek/deepseek-v4.1-flash-1017': 'DeepSeek V4.1 Flash',
  'moonshotai/kimi-k3.1-pro': 'Kimi K3.1 Pro',
  'z-ai/glm-5.3': 'GLM 5.3',
  'qwen/qwen4-max': 'Qwen4 Max',
  'openai/gpt-6.2-sol': 'GPT-6.2 Sol',
  'openai/gpt-6.2-astra': 'GPT-6.2 Astra',
  'openai/gpt-6-astra': 'GPT-6 Astra',
  'google/gemini-4-neon': 'Gemini 4 Neon',
  'anthropic/claude-opus-5-5': 'Claude Opus 5.5',
  'anthropic/claude-fable-5-2': 'Claude Fable 5.2',
  'openai-codex/gpt-6.2-sol': 'GPT-6.2 Sol',
  'openai-codex/gpt-6.2-astra': 'GPT-6.2 Astra',
  'openai-codex/gpt-6.1-sol': 'GPT-6.1 Sol',
  'openai-codex/gpt-6-astra': 'GPT-6 Astra',
};
/** A model's lab: display name and favicon (`apps/web/public/benchmarks/labs/<id>.png`, sources in CREDITS.txt). */
export interface Lab { id: string; name: string; icon: string }
const LABS: Readonly<Record<string, Omit<Lab, 'icon'>>> = {
  anthropic: { id: 'anthropic', name: 'Anthropic' }, openai: { id: 'openai', name: 'OpenAI' }, 'openai-codex': { id: 'openai', name: 'OpenAI' },
  google: { id: 'google', name: 'Google' }, deepseek: { id: 'deepseek', name: 'DeepSeek' }, moonshotai: { id: 'moonshotai', name: 'Moonshot AI' },
  'z-ai': { id: 'zai', name: 'Z.ai' }, qwen: { id: 'qwen', name: 'Qwen' },
};
/** The lab of a requested model id, by its provider prefix (`google/…`); null for an unknown or missing prefix. */
export function labOf(model: string | null | undefined): Lab | null {
  const prefix = model?.split('/', 1)[0];
  const lab = prefix && Object.hasOwn(LABS, prefix) ? LABS[prefix]! : null;
  return lab && { ...lab, icon: `/benchmarks/labs/${lab.id}.png` };
}
/**
 * A system's display name and its route as secondary text, from the label's trailing parenthesis up to its first
 * top-level comma: "(via OpenRouter, openrouter-chat wire)" → "via OpenRouter"; a parenthesised account names the
 * route, "(via Anthropic (Claude subscription), …)" → "via Claude subscription".
 */
export function systemName(system: Pick<BenchmarkPublication['experiment']['system'], 'label' | 'model'>): { name: string; route: string | null } {
  const name = system.model && Object.hasOwn(MODEL_NAMES, system.model) ? MODEL_NAMES[system.model] : undefined;
  if (!name) return { name: system.label, route: null };
  return { name, route: routeOf(system.label) };
}
function routeOf(label: string): string | null {
  const text = label.trimEnd();
  if (!text.endsWith(')')) return null;
  let depth = 0; let start = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(' && --depth === 0) { start = i; break; }
  }
  if (start < 0) return null;
  const inner = text.slice(start + 1, -1);
  depth = 0; let end = inner.length;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++; else if (inner[i] === ')') depth--;
    else if (inner[i] === ',' && depth === 0) { end = i; break; }
  }
  const route = inner.slice(0, end).trim();
  const account = /^via [^()]+\(([^()]+)\)$/.exec(route);
  return account ? `via ${account[1]}` : route || null;
}
const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** UTC calendar date ("<day> <Mon> <year>"): identical on the server and in any browser time zone, so hydration matches. */
export function dateText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
/** A release's short version name: `acbench-v0-1` reads "ACBench v0.1", a pilot "ACBench pilot"; never the full title. */
export function versionName(release: Pick<ReleaseCard, 'id' | 'title'>): string {
  const match = /^acbench-v(\d+)-(\d+)$/.exec(release.id);
  if (match) return `ACBench v${match[1]}.${match[2]}`;
  if (/^acbench-.*pilot$/.test(release.id)) return 'ACBench pilot';
  // Otherwise the title up to its first colon, or the id when that is still long.
  const head = release.title.split(':')[0]!.trim();
  return head.length > 0 && head.length <= 32 ? head : release.id;
}
/** One card per version (its newest revision), newest first: each version keeps its own permanent page. */
export function versions(releases: readonly ReleaseCard[]): ReleaseCard[] {
  const newest = new Map<string, ReleaseCard>();
  for (const r of releases) { const seen = newest.get(`${r.publisher}/${r.id}`); if (!seen || r.revision > seen.revision) newest.set(`${r.publisher}/${r.id}`, r); }
  return [...newest.values()].sort((a, b) => b.notBefore.localeCompare(a.notBefore) || b.revision - a.revision || a.id.localeCompare(b.id));
}
/** The version the hub leads with: the newest official version, or the newest community one before any official exists. */
export function latestVersion(releases: readonly ReleaseCard[]): ReleaseCard | undefined {
  const all = versions(releases);
  return all.find(r => r.publisher === 'official') ?? all[0];
}
export const systemPath = (row: PublicBenchmark): string => `${releasePath(row)}systems/${encodeURIComponent(row.publication.experiment.system.id)}/`;
/** Scored systems by score (highest first), then unscored ones by name: missing is listed, never drawn as zero. */
export function headlineEntries(rows: readonly PublicBenchmark[]): HeadlineEntry[] {
  const notes = profileNotes(rows);
  return rows.map(row => { const p = row.publication; const { name, route } = systemName(p.experiment.system); return { id: p.id, system: p.experiment.system.id, label: name, route, model: p.experiment.system.model, lab: labOf(p.experiment.system.model),
    value: p.score.value !== null && Number.isFinite(p.score.value) ? p.score.value : null, interval: p.score.interval, href: systemPath(row), note: notes.get(p.id) ?? null }; })
    .sort((a, b) => (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) || (b.value ?? 0) - (a.value ?? 0) || a.label.localeCompare(b.label));
}

/** The ACBench ladder, weakest first (`ACBENCH.opponents` in bench/acbench-settings.ts; a server test pins the copy). */
export const TIER_ORDER = ['novice', 'standard', 'veteran', 'elite', 'champion'] as const;
const tierIndex = (id: string): number => (TIER_ORDER as readonly string[]).indexOf(id);
/** A tier reads as its capitalised name; any other reference (e.g. another system's frozen policy) by its id. */
export const opponentLabel = (id: string): string => tierIndex(id) >= 0 ? id[0]!.toUpperCase() + id.slice(1) : id;
/**
 * The opponent of every evaluation permutation, from its explicit `<opponent>-<side>` id (split at the last '-'; the
 * opponent must be one of suite.references, the side the candidate's map slot). Null unless every permutation resolves
 * and every reference is played: opaque ids (the pilot's `orientation-N`) never get a guessed opponent.
 */
export function permutationOpponents(suite: Pick<BenchmarkSuite, 'references' | 'evaluation'>): Map<string, string> | null {
  const refs = new Set(suite.references.map(r => r.id));
  const opponents = new Map<string, string>();
  for (const permutation of suite.evaluation.permutations) {
    const cut = permutation.lastIndexOf('-'); const opponent = permutation.slice(0, cut);
    if (cut <= 0 || cut === permutation.length - 1 || !refs.has(opponent)) return null;
    opponents.set(permutation, opponent);
  }
  return refs.size && [...refs].every(id => [...opponents.values()].includes(id)) ? opponents : null;
}
/** Opponents in display order: ladder tiers weakest first, then any other references in suite order. */
export function opponentOrder(suite: Pick<BenchmarkSuite, 'references'>): string[] {
  const ids = suite.references.map(r => r.id);
  return [...ids.filter(id => tierIndex(id) >= 0).sort((a, b) => tierIndex(a) - tierIndex(b)), ...ids.filter(id => tierIndex(id) < 0)];
}
/**
 * Score (0–1) against each opponent, scored like the headline: per run the frozen stratum weights over that opponent's
 * trials, failed authoring runs 0, runs equally weighted. Null for an opponent with any missing or unscored game.
 */
export function opponentScores(p: BenchmarkPublication): { opponents: string[]; values: (number | null)[] } | null {
  const opponentOf = permutationOpponents(p.suite);
  if (!opponentOf) return null;
  const opponents = opponentOrder(p.suite);
  const weights = p.suite.strata.reduce((n, s) => n + s.weight, 0);
  const perStratum = new Map(p.suite.strata.map(s => [s.id, p.suite.blocks.filter(b => b.stratumId === s.id).length * p.suite.evaluation.repetitions]));
  const values = opponents.map(opponent => {
    const sides = [...opponentOf].filter(([, ref]) => ref === opponent).length;
    if (p.runs.length !== p.suite.authoring.replicates || !p.runs.length) return null;
    const runs: number[] = [];
    for (const run of p.runs) {
      if (run.status === 'failed') { runs.push(0); continue; }
      if (run.status !== 'evaluated') return null;
      let sum = 0;
      for (const stratum of p.suite.strata) {
        const cell = run.trials.filter(t => t.stratumId === stratum.id && opponentOf.get(t.permutationId) === opponent);
        if (!cell.length || cell.length !== perStratum.get(stratum.id)! * sides || cell.some(t => t.score === null || !Number.isFinite(t.score))) return null;
        sum += mean(cell.map(t => t.score!)) * stratum.weight / weights;
      }
      runs.push(sum);
    }
    return mean(runs);
  });
  return { opponents, values };
}
export interface OpponentSeries { id: string; label: string; href: string; values: (number | null)[] }
/** Per-opponent scores for one comparison cohort, in headline order; null when no system resolves its opponents. */
export function opponentTable(rows: readonly PublicBenchmark[]): { opponents: string[]; series: OpponentSeries[] } | null {
  const order = new Map(headlineEntries(rows).map((entry, index) => [entry.id, index]));
  let opponents: string[] | null = null; const series: OpponentSeries[] = [];
  for (const row of [...rows].sort((a, b) => order.get(a.publication.id)! - order.get(b.publication.id)!)) {
    const scores = opponentScores(row.publication);
    if (!scores) continue;
    opponents ??= scores.opponents;
    if (scores.opponents.join() !== opponents.join()) continue;
    series.push({ id: row.publication.id, label: systemName(row.publication.experiment.system).name, href: systemPath(row), values: scores.values });
  }
  return opponents && series.some(s => s.values.some(v => v !== null)) ? { opponents, series } : null;
}
export interface RunSpread { id: string; label: string; lab: Lab | null; href: string; runs: { id: string; value: number }[]; expected: number; mean: number; min: number; max: number; sd: number | null }
/** Each scored authoring run (failed authoring scores 0 by the frozen rule; unscored runs are left out and counted). */
export function runSpread(row: PublicBenchmark): RunSpread | null {
  const p = row.publication;
  const runs = p.runs.flatMap((run, index) => { const value = p.score.runScores[index]; return value === null || value === undefined || !Number.isFinite(value) ? [] : [{ id: run.id, value }]; });
  if (!runs.length) return null;
  const values = runs.map(r => r.value); const average = mean(values);
  return { id: p.id, label: systemName(p.experiment.system).name, lab: labOf(p.experiment.system.model), href: systemPath(row), runs, expected: p.score.expectedRuns, mean: average, min: Math.min(...values), max: Math.max(...values),
    sd: values.length > 1 ? Math.sqrt(values.reduce((n, v) => n + (v - average) ** 2, 0) / (values.length - 1)) : null };
}
/**
 * At most two short TL;DR bullets under a headline chart, derived from the selected publications (whole points): the
 * leader, then the best score against the hardest opponent. A curated story's TL;DR replaces them.
 */
export function tldr(rows: readonly PublicBenchmark[]): string[] {
  const bullets: string[] = [];
  const points = (value: number) => Math.round(value * 100);
  const scored = headlineEntries(rows).filter(e => e.value !== null);
  const [top, second] = scored;
  if (top) bullets.push(!second ? `${top.label} leads at ${points(top.value!)}.`
    : !top.interval || !second.interval ? `${top.label} leads at ${points(top.value!)}, ahead of ${second.label} (${points(second.value!)}).`
    : top.interval[0] > second.interval[1] ? `${top.label} leads at ${points(top.value!)}, clearly ahead of ${second.label} (${points(second.value!)}).`
    : `${top.label} leads at ${points(top.value!)}, not clearly ahead of ${second.label} (${points(second.value!)}).`);
  const table = opponentTable(rows);
  if (table) {
    const last = table.opponents.length - 1;
    const best = table.series.filter(s => s.values[last] !== null).sort((a, b) => b.values[last]! - a.values[last]!)[0];
    if (best) bullets.push(`Best vs ${opponentLabel(table.opponents[last]!)}: ${best.label}, ${points(best.values[last]!)}.`);
  }
  return bullets;
}
/** A system's recorded games by outcome over every run: win (score 1), draw (½), loss (0); unscored games apart. */
export function standing(p: BenchmarkPublication): { wins: number; draws: number; losses: number; unscored: number; winRate: number | null } {
  let wins = 0; let draws = 0; let losses = 0; let unscored = 0;
  for (const trial of p.runs.flatMap(run => run.trials)) {
    if (trial.score === null || !Number.isFinite(trial.score)) unscored++;
    else if (trial.score === 1) wins++; else if (trial.score === 0) losses++; else draws++;
  }
  const scored = wins + draws + losses;
  return { wins, draws, losses, unscored, winRate: scored ? wins / scored : null };
}
/** The suite's frozen setup in numbers: opponents, maps, games per run, authoring runs and wall clock. */
export function setup(p: BenchmarkPublication): { opponents: number; maps: number; games: number; runs: number; minutes: number } {
  const s = p.suite;
  return { opponents: s.references.length, maps: s.strata.length, games: s.blocks.length * s.evaluation.permutations.length * s.evaluation.repetitions,
    runs: s.authoring.replicates, minutes: Math.round(s.authoring.maxWallMs / 60_000) };
}
