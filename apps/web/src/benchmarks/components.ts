/**
 * ACBench pages (hub, release, run, methods, contribute, live) as one React tree: rendered to a full document on the
 * server (apps/server/src/benchmark-document.ts) and hydrated by benchmarks/client.ts, so both renders must match.
 */
import { createContext, createElement as h, Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Badge as MantineBadge, Button as MantineButton, Container, Group, MantineProvider, NativeSelect, TextInput, createTheme } from '@mantine/core';
import { cohort, cohortOptions, cost, dateText, headlineEntries, labOf, opponentLabel, opponentOrder, opponentTable, profileNotes, referencesFor, releasePath, runPath, runSpread, scoreText, setup, standing, systemName, tldr, usd, versionName, versions, type BenchmarkDocumentProps, type BenchmarkPage, type HeadlineEntry, type Lab, type PublicBenchmark, type ReleaseCard } from './model.ts';
import { HeadlineChart, OpponentChart, VarianceChart } from './charts.ts';
import { storyFor, type ModelStory } from './stories.ts';

// Fix the root element types so createElement does not infer every polymorphic variant.
const Badge = MantineBadge<'div'>;
const Button = MantineButton<'button'>;

const theme = createTheme({ primaryColor: 'gold', colors: { gold: ['#fffbe7','#fff2ad','#ffe775','#ffdc42','#ffd21f','#f5a800','#dc8c00','#c66a00','#9c4200','#621f02'] }, primaryShade: 4, fontFamily: 'Arial, Helvetica, sans-serif', defaultRadius: 'md', headings: { fontFamily: 'Bangers, Impact, sans-serif', fontWeight: '400' } });
const anchor = (href: string, text: ReactNode) => h('a', { href }, text);
/** A model's lab favicon before its name (decorative: the name and model id beside it say the same). */
const named = (lab: Lab | null, name: string) => lab ? h(Fragment, null, h('img', { className: 'lab-icon', src: lab.icon, alt: '', title: lab.name, width: 16, height: 16, decoding: 'async' }), name) : name;
const paragraph = (text: string) => h('p', null, text);
const BrandLogo = createContext('/src/brand/logo.webp');

function Metrics({ items }: { items: readonly { label: string; value: string | number; note: string }[] }) {
  return h('dl', { className: 'metric-strip' }, ...items.map(item => h('div', { key: item.label }, h('dt', null, item.label), h('dd', null, item.value), h('small', null, item.note))));
}

/** Every game each system played (all runs), its score and authoring cost; turns when the release's story records them. */
export function ScoreTable({ rows }: { rows: readonly PublicBenchmark[] }) {
  const [sort, setSort] = useState<'score' | 'cost' | 'name'>('score');
  const sorted = useMemo(() => [...rows].sort((a, b) => sort === 'name' ? systemName(a.publication.experiment.system).name.localeCompare(systemName(b.publication.experiment.system).name) : sort === 'cost' ? (cost(a.publication) ?? Infinity) - (cost(b.publication) ?? Infinity) : (b.publication.score.value ?? -1) - (a.publication.score.value ?? -1)), [rows, sort]);
  const sortable = (label: string, key: typeof sort) => h('th', { scope: 'col', 'aria-sort': sort === key ? key === 'score' ? 'descending' : 'ascending' : 'none' }, h('button', { type: 'button', className: 'table-sort', onClick: () => setSort(key) }, label));
  const turns = (row: PublicBenchmark) => storyFor(row.releaseId)?.turns ?? null;
  const notes = useMemo(() => profileNotes(rows), [rows]);
  const withTurns = rows.some(row => turns(row) !== null);
  const column = (label: string) => h('th', { scope: 'col' }, label);
  return h('div', { className: 'table-scroll' }, h('table', { className: 'standings' },
    h('caption', null, 'Score 0–100 over every game · win % of scored games · cost: mean authoring USD, evaluation excluded · ordering is descriptive, not a significance test'),
    h('thead', null, h('tr', null, sortable('System', 'name'), sortable('Score', 'score'), column('Wins'), column('Draws'), column('Losses'), column('Win %'), sortable('Cost', 'cost'), withTurns && column('Turns'), column('Evidence'))),
    h('tbody', null, ...sorted.map(row => {
      const p = row.publication; const amount = cost(p); const { name, route } = systemName(p.experiment.system); const games = standing(p);
      const turn = turns(row); const count = turn && Object.hasOwn(turn, p.experiment.system.id) ? turn[p.experiment.system.id]! : null;
      return h('tr', { key: p.id },
        h('th', { scope: 'row' }, anchor(`${releasePath(row)}systems/${encodeURIComponent(p.experiment.system.id)}/`, named(labOf(p.experiment.system.model), notes.has(p.id) ? `${name} †` : name)), h('small', null, `${p.experiment.system.model ?? 'Model not reported'}${route ? ` · ${route}` : ''}`), notes.has(p.id) && h('small', null, `† ${notes.get(p.id)}`)),
        h('td', null, h('strong', { className: 'score-value' }, scoreText(p.score.value)), h('small', null, p.score.interval ? `95% ${p.score.interval.map(scoreText).join('–')}` : 'CI unavailable'),
          h('small', null, `${p.score.scoredTrials}/${p.score.expectedTrials} games · ${p.score.completedRuns}/${p.score.expectedRuns} runs${p.score.failedRuns ? ` · ${p.score.failedRuns} failed` : ''}`),
          !p.score.complete && h(Badge, { color: 'orange', variant: 'light' }, 'Incomplete')),
        h('td', null, games.wins), h('td', null, games.draws), h('td', null, games.losses, games.unscored > 0 && h('small', null, `${games.unscored} unscored`)),
        h('td', null, games.winRate === null ? '—' : `${Math.round(games.winRate * 100)}%`),
        h('td', null, amount === null ? 'Unavailable / partial' : usd(amount), amount !== null && h('small', null, `Exact ${amount} USD`)),
        withTurns && h('td', null, count ?? '—'),
        h('td', null, `${row.publisher} · ${row.evidence}`, h('small', null, anchor(runPath(p), 'Run evidence'))));
    }))));
}

const HEADLINE_CAPTION = 'Win rate vs built-in bots, 0–100';
const publisherName = (release: ReleaseCard) => release.publisher === 'official' ? 'Official' : 'Community';
/**
 * The version's lead: short name and date, TL;DR (the curated story's, else derived bullets), the ranked headline
 * chart with the release's reference bars, then the story's verdict (left out while a model filter narrows the chart).
 */
function VersionLead({ release, entries, bullets, meta, subtitle, note, filtered = false, children }: { release: ReleaseCard; entries: readonly HeadlineEntry[]; bullets: readonly string[]; meta: string; subtitle?: string; note?: string; filtered?: boolean; children?: ReactNode }) {
  const story = storyFor(release.id);
  const tldrItems = story?.tldr ?? bullets;
  return h('section', { className: 'version-lead', 'aria-labelledby': 'version-title' },
    h('h1', { id: 'version-title', className: 'version-title' }, versionName(release)),
    h('p', { className: 'version-meta' }, meta),
    subtitle && h('p', { className: 'version-subtitle' }, subtitle),
    tldrItems.length > 0 && h('div', { className: 'tldr' }, h('h2', { id: 'tldr-heading' }, 'TL;DR'),
      h('ul', { 'aria-labelledby': 'tldr-heading' }, ...tldrItems.map(text => h('li', { key: text }, text)))),
    entries.length ? h(HeadlineChart, { entries, caption: entries.some(e => e.interval) ? `${HEADLINE_CAPTION} · error bars: 95% range` : HEADLINE_CAPTION, references: referencesFor(release.id) }) : h('aside', { role: 'status' }, 'No systems match these filters. Clear filters to inspect the released snapshot; missing is not zero.'),
    note && h('p', { className: 'muted cohort-note' }, note),
    story && !filtered && entries.length > 0 && h('p', { className: 'verdict' }, story.verdict),
    children);
}

/**
 * A muted looping clip beside a model card: its poster until the card scrolls into view, then the video loads and
 * plays (paused again off screen; under reduced motion it waits for the viewer's play). A clip that fails to load
 * calls `onFail`, and the card drops the slot.
 */
function ModelClip({ clip, label, onFail }: { clip: NonNullable<ModelStory['clip']>; label: string; onFail: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.muted = true;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) { element.pause(); return; }
      if (!element.getAttribute('src')) element.src = clip.src;
      if (still) element.controls = true;
      else void element.play().catch(() => { element.controls = true; });
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [clip.src]);
  return h('figure', { className: 'model-clip' },
    h('video', { ref: video, muted: true, loop: true, playsInline: true, preload: 'none', poster: clip.poster, width: 1280, height: 720, 'aria-label': label, onError: onFail }),
    h('figcaption', null, clip.caption));
}

function ModelCard({ entry, rank, story }: { entry: HeadlineEntry; rank: number | null; story: ModelStory }) {
  const [clipFailed, setClipFailed] = useState(false);
  const clip = story.clip && !clipFailed ? story.clip : null;
  const heading = `card-${entry.system}`;
  return h('article', { className: `model-card${clip ? ' has-clip' : ''}`, 'aria-labelledby': heading },
    h('div', { className: 'model-card-text' },
      h('p', { className: 'model-card-model' }, rank !== null && h('span', { className: 'model-card-rank' }, `#${rank}`), anchor(entry.href, named(entry.lab, entry.label)), h('strong', null, entry.value === null ? 'Not scored' : `Score ${scoreText(entry.value)}`)),
      h('h3', { id: heading }, story.nickname),
      h('ul', { className: 'model-card-bullets' }, ...story.bullets.map(text => h('li', { key: text }, text))),
      h('dl', { className: 'model-card-facts' },
        h('div', null, h('dt', null, 'Favorite strategy'), h('dd', null, h('strong', null, story.strategy.label), h('span', null, story.strategy.detail))),
        h('div', null, h('dt', null, 'Favorite unit'), h('dd', null, h('strong', null, story.unit.name), h('span', null, `${story.unit.ratio.toFixed(1)}× the rest of the field`), story.unit.detail && h('span', null, story.unit.detail))))),
    clip && h(ModelClip, { clip, label: `${entry.label}: ${clip.caption}`, onFail: () => setClipFailed(true) }));
}

/** One card per system the release's story covers, in headline order; systems without a story get none. */
function ModelBreakdown({ release, entries }: { release: ReleaseCard; entries: readonly HeadlineEntry[] }) {
  const story = storyFor(release.id);
  const cards = story ? entries.flatMap(entry => Object.hasOwn(story.models, entry.system) ? [{ entry, story: story.models[entry.system]! }] : []) : [];
  if (!cards.length) return null;
  return h('section', { 'aria-labelledby': 'breakdown-heading' },
    h('h2', { id: 'breakdown-heading' }, 'Model breakdown'),
    h('div', { className: 'model-cards' }, ...cards.map(({ entry, story: model }) =>
      h(ModelCard, { key: entry.id, entry, story: model, rank: entry.value === null ? null : entries.indexOf(entry) + 1 }))));
}

/** Per-opponent headroom, and run-to-run variance unless every system has a single run. */
function ResultCharts({ rows }: { rows: readonly PublicBenchmark[] }) {
  const notes = useMemo(() => profileNotes(rows), [rows]);
  const opponents = useMemo(() => opponentTable(rows), [rows]);
  const spreads = useMemo(() => {
    if (rows.every(row => row.publication.score.expectedRuns <= 1)) return [];
    const order = new Map(headlineEntries(rows).map((e, i) => [e.id, i]));
    return [...rows].sort((a, b) => order.get(a.publication.id)! - order.get(b.publication.id)!).flatMap(row => runSpread(row) ?? []);
  }, [rows]);
  return h(Fragment, null,
    opponents && h('section', { 'aria-labelledby': 'opponent-heading' },
      h('h2', { id: 'opponent-heading' }, 'Win rate by opponent'),
      h('p', { className: 'muted' }, 'Win rate 0–100 against each opponent, weakest first. The gap to 100 at the hardest tier is the headroom. No bar means unscored, not zero.'),
      h(OpponentChart, { ...opponents, notes })),
    spreads.length > 0 && h('section', { 'aria-labelledby': 'variance-heading' },
      h('h2', { id: 'variance-heading' }, 'Run-to-run variance'),
      h('p', { className: 'muted' }, 'Each model writes its policy several times from scratch; the spread shows how repeatable its score is.'),
      h(VarianceChart, { spreads, notes })));
}

const OBJECTIVE = 'Write a policy for every plane of Agent Command that beats the built-in bots. Each model authors its policies within a fixed time and budget, freezes them, then they play the bot ladder with no model in the loop.';
/** Objective, setup in numbers, harness and how the score is made, from the suite's frozen protocol and the story. */
function Implementation({ release, rows }: { release: ReleaseCard; rows: readonly PublicBenchmark[] }) {
  const p = rows[0]?.publication;
  if (!p) return null;
  const story = storyFor(release.id);
  const s = setup(p);
  const single = rows.every(row => row.publication.score.expectedRuns <= 1);
  const tiers = opponentOrder(p.suite).map(opponentLabel);
  const maps = p.suite.strata.map(stratum => stratum.id.replaceAll('_', ' '));
  const equal = new Set(p.suite.strata.map(stratum => stratum.weight)).size === 1;
  const expected = rows.reduce((n, row) => n + row.publication.score.expectedTrials, 0);
  const scored = rows.reduce((n, row) => n + row.publication.score.scoredTrials, 0);
  const { harness } = p.suite;
  return h('section', { className: 'implementation', 'aria-labelledby': 'details-heading' },
    h('h2', { id: 'details-heading' }, 'Implementation details'),
    h('h3', null, 'Objective'), paragraph(story?.objective ?? OBJECTIVE),
    h('h3', null, 'Tournament setup'),
    h(Metrics, { items: [
      { label: 'Models', value: rows.length, note: `${s.runs} authoring run${s.runs === 1 ? '' : 's'} each` },
      { label: 'Bot tiers', value: s.opponents, note: tiers.length > 1 ? `${tiers[0]} to ${tiers.at(-1)}` : tiers.join('') },
      { label: 'Maps', value: s.maps, note: maps.join(', ') },
      { label: 'Games per run', value: s.games, note: `${p.suite.evaluation.permutations.length} pairings × ${s.maps} maps${p.suite.evaluation.repetitions > 1 ? ` × ${p.suite.evaluation.repetitions}` : ''}` },
      { label: 'Games in total', value: expected, note: scored === expected ? 'all scored' : `${scored} scored` },
      { label: 'Authoring time', value: `${s.minutes} min`, note: `per run · ${harness.id} ${harness.version}` },
    ] }),
    h('h3', null, 'Harness'),
    paragraph(`${harness.id} ${harness.version}: ${s.minutes} minutes of authoring per run, the same prompt, tools and budget for every model.`),
    story && paragraph(story.harness),
    h('h3', null, 'Scoring'),
    paragraph(`A game scores 1 for a win, ½ for a draw and 0 for a loss. A model's score is 100 × its mean over the ${s.games} games${equal ? ', each map weighted equally' : ' with the suite\'s frozen map weights'}; a failed authoring run scores 0.`),
    paragraph(!single ? `Each model authors ${s.runs} independent runs, weighted equally; error bars resample runs and world blocks together.`
      : rows.some(row => row.publication.score.interval) ? `Single run per model: each model authored once, so there is no run-to-run interval. Error bars resample the ${p.score.uncertainty.blocks} world blocks only.`
      : 'Single run per model: each model authored once, so there is no run-to-run interval and the chart draws no error bars.'));
}

function Release({ page }: { page: BenchmarkPage }) {
  const release = page.release!;
  const groups = useMemo(() => cohortOptions(page.rows), [page.rows]);
  const fallback = groups[0]?.value ?? '';
  const [selected, setSelected] = useState(page.initialCohort ?? fallback);
  const [model, setModel] = useState(page.initialModel);
  const [suggestions, setSuggestions] = useState<{ id: string; name: string }[]>([]);
  const [catalogStatus, setCatalogStatus] = useState('Optional catalogue suggestions are discovery metadata, not authorship evidence.');
  const listId = useId();
  useEffect(() => {
    const restore = () => { const params = new URLSearchParams(window.location.search); setSelected(params.get('cohort') ?? fallback); setModel(params.get('model') ?? ''); };
    window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore);
  }, [fallback]);
  useEffect(() => {
    setSuggestions([]); if (model.trim().length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(() => { void fetch(`/api/benchmarks/models?q=${encodeURIComponent(model)}&limit=20&tools=true`, { signal: abort.signal, credentials: 'omit' }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('models' in data) || !Array.isArray(data.models)) throw new Error('invalid catalogue');
      setSuggestions(data.models.flatMap(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string' ? [{ id: item.id, name: item.name }] : []));
      setCatalogStatus(`Catalogue ${'fetchedAt' in data && typeof data.fetchedAt === 'string' ? data.fetchedAt : 'date unavailable'}. Discovery only; prices are not historical bills.`);
    }).catch(() => { if (!abort.signal.aborted) setCatalogStatus('Catalogue unavailable; filtering published names still works.'); }); }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [model]);
  // Keystrokes refine the current history entry; only explicit selections and submissions add one.
  const change = (nextCohort: string, nextModel: string, entry: 'push' | 'replace') => {
    setSelected(nextCohort); setModel(nextModel);
    const url = new URL(window.location.href); url.searchParams.set('cohort', nextCohort);
    if (nextModel) url.searchParams.set('model', nextModel); else url.searchParams.delete('model');
    if (entry === 'push') window.history.pushState(null, '', url); else window.history.replaceState(null, '', url);
  };
  const matches = (r: PublicBenchmark) => !model || `${r.publication.experiment.system.model ?? ''} ${r.publication.experiment.system.label} ${systemName(r.publication.experiment.system).name}`.toLowerCase().includes(model.toLowerCase());
  // The table, charts and TL;DR share one suite/harness cohort.
  const rows = useMemo(() => page.rows.filter(r => cohort(r.publication) === selected && matches(r)), [page.rows, selected, model]);
  const entries = useMemo(() => headlineEntries(rows), [rows]);
  const bullets = useMemo(() => tldr(rows), [rows]);
  return h(Fragment, null,
    h(VersionLead, { release, entries, bullets, filtered: Boolean(model),
      meta: `${dateText(release.notBefore)} · ${publisherName(release)}`,
      subtitle: release.title !== versionName(release) ? release.title : undefined,
      note: !model && entries.length > 0 && entries.length < release.systems ? `Showing ${entries.length} of ${release.systems} systems: one suite and harness. Others are under Overall standings.` : undefined }),
    h(ModelBreakdown, { release, entries }),
    h(ResultCharts, { rows }),
    h(Implementation, { release, rows }),
    h('section', { 'aria-labelledby': 'standings-heading' },
      h('h2', { id: 'standings-heading' }, 'Overall standings'),
      h('form', { method: 'get', action: release.path, className: 'release-filters', onSubmit: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); change(selected, model, 'push'); } },
        h(NativeSelect, { label: 'Suite / track / profile', name: 'cohort', value: selected, onChange: (event: ChangeEvent<HTMLSelectElement>) => change(event.currentTarget.value, model, 'push'), data: groups.map(({ value, label }) => ({ value, label })) }),
        h(TextInput, { label: 'Model or system', name: 'model', value: model, list: listId, maxLength: 200, onChange: (event: ChangeEvent<HTMLInputElement>) => change(selected, event.currentTarget.value, 'replace') }),
        h('datalist', { id: listId }, ...suggestions.map(item => h('option', { key: item.id, value: item.id }, item.name))),
        h(Button, { type: 'submit', variant: 'outline' }, 'Apply filters'), h('a', { href: release.path, onClick: (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); change(fallback, '', 'push'); } }, 'Clear')),
      rows.length > 0 && h(ScoreTable, { rows })),
    h(Group, { className: 'download-links' }, anchor(`${release.path}data.json`, 'Download evidence'), anchor(`${release.path}manifest.json`, 'Manifest & checksums'), anchor(`${release.path}scores.csv`, 'Score CSV'), anchor('/benchmarks/methodology/', 'Methods')),
    h('details', { className: 'evidence-details' }, h('summary', null, 'Comparison rules & frozen release identity'),
      paragraph('Official comparisons hold harness/version, prompt/tool profile and budget fixed. Alternate harnesses use separate system-comparison suites. Filters retain the exact suite and configuration. Neither patches nor budgets are pooled.'),
      h('p', { className: 'muted', 'aria-live': 'polite' }, catalogStatus),
      h('p', null, `${release.publisher} · ${release.evidence} · revision ${release.revision}. Published ${release.publishedAt} · public release ${release.notBefore}.`),
      h('p', null, h('code', null, `SHA-256 ${release.digest}`)),
      h('p', null, `Cite: ACBench, ${release.title}, ${release.id}, revision ${release.revision}, ${release.publishedAt}.`)));
}

function Run({ row }: { row: PublicBenchmark }) {
  const p = row.publication;
  const facts: [string, string | number | null][] = [['Suite', `${p.suite.id} ${p.suite.version}`], ['Game patch', p.suite.gameVersion], ['Controlled roles', p.suite.roles.join(', ')], ['Model (requested / declared)', p.experiment.system.model], ['Provider', p.experiment.system.provider], ['Fixed harness', p.experiment.system.harness], ['Provenance', p.experiment.provenance], ['Publication SHA-256', p.digest], ['Suite SHA-256', p.suite.digest], ['Configuration SHA-256', p.experiment.system.configurationDigest], ['Released', row.releasedAt], ['License', p.consent.license]];
  const trials = p.runs.flatMap(run => run.trials);
  const statuses = ['win', 'draw', 'loss', 'forfeit', 'timeout', 'incomplete'] as const;
  const outcomes = statuses.map(status => ({ status, count: trials.filter(trial => trial.status === status).length }));
  const amount = cost(p);
  const { name, route } = systemName(p.experiment.system);
  return h(Fragment, null, h('p', { className: 'eyebrow' }, `${row.publisher} · ${row.evidence}`), h('h1', { className: 'release-title' }, named(labOf(p.experiment.system.model), name)),
    route && h('p', { className: 'version-subtitle' }, route),
    h(Group, { className: 'download-links' }, anchor(releasePath(row), 'Release'), anchor(`${runPath(p)}data.json`, 'Versioned evidence JSON'), anchor(`${runPath(p)}manifest.json`, 'Manifest')),
    h(Metrics, { items: [
      { label: 'Fixed-reference score', value: scoreText(p.score.value), note: p.score.interval ? `95% CI ${p.score.interval.map(scoreText).join('–')} · ${p.score.complete ? 'complete' : 'incomplete'}` : `95% CI unavailable · ${p.score.complete ? 'complete' : 'incomplete'}` },
      { label: 'Independent runs', value: `${p.score.completedRuns} / ${p.score.expectedRuns}`, note: `${p.score.failedRuns} failed authoring runs retained` },
      { label: 'Scored games', value: `${p.score.scoredTrials} / ${p.score.expectedTrials}`, note: `${p.score.uncertainty.blocks} independent world blocks` },
      { label: 'Mean authoring cost', value: amount === null ? 'Unavailable' : usd(amount), note: amount === null ? 'Unknown / partial is not zero' : `Exact ${amount} USD · evaluation compute excluded` },
    ] }),
    h('div', { className: 'run-visuals' },
      h('section', { className: 'research-card', 'aria-labelledby': 'run-distribution' }, h('h2', { id: 'run-distribution' }, 'Independent run distribution'),
        h('p', { className: 'muted' }, 'Score 0–100 · one bar per declared run, not a confidence interval. Failed authoring remains in the score.'),
        h('ol', { className: 'run-bars' }, ...p.runs.map((run, index) => {
          const score = p.score.runScores[index] ?? null;
          return h('li', { key: run.id }, h('div', { className: 'run-bar-label' }, h('span', null, run.id), h('strong', null, scoreText(score))),
            h('div', { className: `run-bar-track${score === null ? ' unscored' : ''}`, 'aria-hidden': true }, score !== null && h('span', { style: { width: `${score * 100}%` } })),
            h('small', null, `${run.status}${run.reason ? ` · ${run.reason}` : ''}`));
        }))),
      h('section', { className: 'research-card', 'aria-labelledby': 'recorded-outcomes' }, h('h2', { id: 'recorded-outcomes' }, 'Recorded game outcomes'),
        h('p', { className: 'muted' }, `${trials.length} recorded trial rows · ${p.score.expectedTrials} expected games. Raw counts, not weighted scores.`),
        trials.length > 0 && h('div', { className: 'outcome-bar', 'aria-hidden': true }, ...outcomes.filter(item => item.count > 0).map(item => h('span', { key: item.status, className: `outcome-${item.status}`, style: { flexGrow: item.count } }))),
        h('dl', { className: 'outcome-legend' }, ...outcomes.map(item => h('div', { key: item.status }, h('dt', null, h('span', { className: `outcome-dot outcome-${item.status}`, 'aria-hidden': true }), item.status), h('dd', null, item.count)))),
        h('p', { className: 'muted' }, 'Timeouts follow frozen adjudication. Missing games are not draws; incomplete cells are not renormalized.'))),
    h('h2', null, 'Run evidence and methods'), h(ScoreTable, { rows: [row] }),
    paragraph('Artifact performance is not model-authorship verification. Requested provider/model metadata does not verify model weights.'),
    h('details', { className: 'evidence-details' }, h('summary', null, 'Authoring lineage, failures & cost coverage'),
      h('div', { className: 'table-scroll' }, h('table', null, h('caption', null, 'Every declared run, including failures; score values are not confidence intervals.'), h('thead', null, h('tr', null, ...['Run','Status / failure','Score','Policy SHA-256','Attempts','Cost / coverage / pricing'].map(label => h('th', { key: label, scope: 'col' }, label)))),
        h('tbody', null, ...p.runs.map((r, index) => h('tr', { key: r.id }, h('th', { scope: 'row' }, r.id), h('td', null, r.status, h('small', null, r.reason ?? 'No failure recorded')), h('td', null, scoreText(p.score.runScores[index] ?? null)), h('td', null, h('code', null, r.artifactDigest ?? 'No artifact'), h('small', null, `Series ${r.seriesId ?? 'Not started'} · revision ${r.seriesRevision ?? 'unknown'}`)), h('td', null, r.trials.reduce((n, t) => n + t.attempts, 0), h('small', null, `${r.authoringAttempts} authoring`)), h('td', null, r.cost.currency === 'USD' && r.cost.amount !== null && Number.isFinite(Number(r.cost.amount)) ? usd(Number(r.cost.amount)) : `${r.cost.amount ?? 'Unknown'} ${r.cost.currency ?? ''}`, r.cost.amount !== null && h('small', null, `Exact ${r.cost.amount} ${r.cost.currency ?? ''}`), h('small', null, `${r.cost.scope} · ${r.cost.coverage} · ${r.cost.source}`), h('small', null, `${r.cost.pricingVersion ?? 'No pricing version'} · ${r.cost.pricedAt ?? 'No pricing date'}`)))))))),
    h('details', { className: 'evidence-details' }, h('summary', null, 'Opponent / map strata'),
      h('div', { className: 'table-scroll' }, h('table', null, h('caption', null, 'Frozen weights; incomplete cells are not renormalized'), h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Stratum'), h('th', { scope: 'col' }, 'Weight'), h('th', { scope: 'col' }, 'Win / draw / loss / forfeit / timeout / incomplete'))), h('tbody', null, ...p.suite.strata.map(s => h('tr', { key: s.id }, h('th', { scope: 'row' }, s.id), h('td', null, s.weight), h('td', null, statuses.map(status => trials.filter(t => t.stratumId === s.id && t.status === status).length).join(' / ')))))))),
    h('details', { className: 'evidence-details' }, h('summary', null, 'Frozen methods, hashes & attribution'),
      h('dl', null, ...facts.map(([name, value]) => h('div', { key: name }, h('dt', null, name), h('dd', null, value ?? 'Not reported')))),
      h('p', null, `Aggregate method: ${p.score.uncertainty.method}, ${p.score.uncertainty.replicates} bootstrap replicates, seed ${p.score.uncertainty.seed}.`),
      h('pre', null, JSON.stringify(p.suite, null, 2))),
    h('details', { className: 'evidence-details' }, h('summary', null, 'Cite this revision'),
      h('p', null, h('code', null, `ACBench. ${p.experiment.system.label}. ${p.suite.id} ${p.suite.version}. Publication ${p.id}, revision ${p.revision}. SHA-256 ${p.digest}.`)),
      paragraph('Retention: until withdrawn. Downloaded copies cannot be recalled. Raw timeline, source and private transcripts are not included in this public projection.')));
}

function Hub({ page }: { page: BenchmarkPage }) {
  const headline = page.headline;
  const all = versions(page.releases);
  return h(Fragment, null,
    headline ? h(VersionLead, { release: headline.release, entries: headline.entries, bullets: headline.bullets,
      meta: `${page.title === 'AI policy benchmark' ? 'Latest' : `Latest · ${page.title}`} · ${dateText(headline.release.notBefore)} · ${publisherName(headline.release)}` },
      h('p', { className: 'version-actions' }, anchor(headline.release.path, 'Full results →'))) :
      h(Fragment, null, h('p', { className: 'eyebrow' }, 'Agent Command · Policy benchmark'), h('h1', null, page.title === 'AI policy benchmark' ? 'ACBench' : page.title),
        h('aside', { className: 'empty-release' }, h('div', { className: 'empty-count', 'aria-hidden': true }, '0'), h('div', null, h('h3', null, 'No public results yet'),
          paragraph('No ranking has been released. Private games do not automatically become public evidence.'),
          h(Group, null, anchor('/benchmarks/methodology/', 'Read the methods'), anchor('/benchmarks/contribute/', 'Evaluate a policy'))))),
    all.length > 0 && h('section', { 'aria-labelledby': 'versions-heading' },
      h('div', { className: 'section-heading' }, h('h2', { id: 'versions-heading' }, 'Versions'), h('span', { className: 'muted' }, 'Each version is a permanent page')),
      h('ol', { className: 'version-list' }, ...all.map(r => h('li', { key: r.path },
        h('div', null, h('a', { href: r.path, className: 'version-link' }, versionName(r)), r.path === headline?.release.path && h(Badge, { variant: 'filled', color: 'gold', size: 'sm' }, 'Latest')),
        h('p', { className: 'muted' }, `${dateText(r.notBefore)} · ${r.systems} systems · ${publisherName(r)}`))))),
    h('section', { 'aria-labelledby': 'about-heading' },
      h('h2', { id: 'about-heading' }, 'AI policies, scored in real matches'),
      h('p', { className: 'lede' }, 'Each model writes a policy for all four planes of Agent Command, freezes it, then plays versioned built-in bots on predeclared maps. A result shows the score, its uncertainty, every run (failed ones count) and what writing the policy cost.')),
    h('section', { 'aria-labelledby': 'measurement-heading' }, h('h2', { id: 'measurement-heading' }, 'How a result is made'),
      h('ol', { className: 'measurement-flow' }, ...[
        ['Author', 'Independent starts. Fixed harness and budget.'],
        ['Freeze', 'Hash the policy, protocol and configuration.'],
        ['Evaluate', 'Fixed opponents, maps and mirrored world blocks.'],
        ['Release', 'Scores + uncertainty + costs + failed attempts.'],
      ].map(([title, text], index) => h('li', { key: title }, h('span', { className: 'step-number', 'aria-hidden': true }, `0${index + 1}`), h('h3', null, title), h('p', null, text)))),
      h('p', { className: 'muted' }, 'Every published result goes through these steps. Publishing needs explicit consent and an operator review.')),
    h('details', { className: 'evidence-details' }, h('summary', null, 'Tracks & measurement boundaries'),
      h('div', { className: 'cards' }, ...[
        ['Official authored-policy', '/benchmarks/authored-policy/', 'Fixed harness and authoring budget. Alternate harnesses require separate system-comparison suites.'],
        ['Community', '/benchmarks/community/', 'Measures how a submitted artifact plays. It does not verify which model wrote it. Submitted and trusted-rerun evidence stay distinct.'],
        ['Live command', '/benchmarks/live-command/', 'Separate realtime task. No live-command protocol or results are published here.'],
      ].map(([name, href, text]) => h('div', { key: href }, h('h3', null, anchor(href!, name)), paragraph(text!)))),
      paragraph('Different patches, budgets and tracks are not interchangeable. A higher score is not proof of a significant difference. Unknown cost is never zero.')));
}

function Methods() {
  return h(Fragment, null, h('p', { className: 'eyebrow' }, 'Research protocol'), h('h1', null, 'Methods & limitations'),
    paragraph('ACBench measures a system under one frozen Agent Command protocol. It does not measure general intelligence. The primary official comparison holds one PlayerThree harness/version, prompts, tools, practice permissions and budget fixed across models. Harness identity is recorded but is not a primary leaderboard dimension. Native or alternate harnesses require distinct system-comparison suites.'),
    h('h2', null, 'System prompt'), h('p', null, 'Since v0.2 every model gets the same short system prompt: the task, what a policy is and how the frozen policies are scored, where writing one is documented, that the built-in starters are the baseline rather than the model\'s work, and how a turn ends (a message without a tool call stops work), with no game strategy or persona. The harness\'s own prompt never reaches the model (OpenCode picks one per model family, so models would otherwise get different instructions). Each suite publishes the text and its SHA-256. ', anchor('https://github.com/fraywing/agent-command/blob/master/bench/acbench-system-prompt.txt', 'Read the prompt'), '.'),
    h('h2', null, 'Model APIs'), paragraph('Since v0.2 each model speaks its family\'s own API through the same harness: Claude Anthropic Messages, GPT OpenAI Responses, the others OpenRouter chat with their reasoning details. On each, the reasoning a model returns goes back to it with its tool results, as its API requires; a common Chat Completions route would have dropped it. Every model asks for the same reasoning effort and reply cap, and the profile names its API.'),
    h('h2', null, 'Context and compaction'), paragraph('OpenCode summarizes a long session and continues from the summary. Since v0.2 every model is summarized at the same 250,000-token window (capped at a model\'s own; every v0.2 model\'s is about 1M), so how often a model is summarized depends on its own work, not its window. The harness replaces the message OpenCode adds after each summary ("Continue if you have next steps, or stop and ask for clarification…") with its own neutral continuation, so no model is told it may stop. Each suite publishes the window.'),
    h('h2', null, 'Opponents and scoring'), paragraph('Each authoring replicate starts independently. Frozen policies face versioned built-in opponents on predeclared maps and mirrored world blocks. Score is 100 times the fixed weighted mean of win + 0.5 draw. Runs receive equal weight; model-caused authoring failure scores zero. Infrastructure gaps (outages, setup failures, interruptions) keep results incomplete rather than scoring zero or shrinking the denominator. Timeouts follow the frozen adjudication.'),
    h('h2', null, 'Uncertainty'), paragraph('Crossed run/block bootstrap resamples independent authoring runs and shared world blocks while preserving strata and mirrors. Manifests freeze algorithm, seed and replicate count. A single authoring run cannot estimate authoring variance; absent intervals remain unavailable. Per-run scores, attempts and independent blocks are separate counts. Ordering does not establish significant differences.'),
    h('h2', null, 'Charts'), paragraph('Each version leads with its ranked scores and 95% intervals. Dashed reference bars, where a version has them, are built-in policies (such as the untouched starting skeleton) scored on the same ladder; they are not models. Systems that share a suite and harness are charted together; one whose authoring profile differs (for example, authored on a later game build) is marked † with the reason. Win rate by opponent scores each opponent like the headline (frozen map weights, runs equally weighted) and is drawn only when every evaluation permutation names its opponent; a missing point means unscored games. Run-to-run variance, drawn when models author more than once, shows every scored authoring run, its min–max, mean and ±1 sample standard deviation. Nothing missing is drawn as zero.'),
    h('h2', null, 'Starting point'), paragraph("Every authoring run starts from an economy-only skeleton on each plane: it keeps workers mining but builds no army and never attacks or researches, and the built-in bots' source is there to read and reuse. Untouched, the skeletons score about 0 on the ladder, so a model's score is its own work."),
    h('h2', null, 'Cost'), paragraph('Every run reports its authoring cost with scope, source, currency, pricing date and version; the results table shows the mean per system. Unknown, partial or unpriced cost reads as unavailable, never zero. Runner estimates are not invoices; evaluation compute is excluded. Failed runs remain in the denominator. Catalogue prices never rewrite historical bills.'),
    h('h2', null, 'Tracks'), paragraph('Official authored-policy is curated runner-observed authoring. Community evaluates immutable submitted artifacts: a trusted rerun establishes how the artifact plays, not which model wrote it. Live-command is a separate realtime task; no live-command protocol or decision-barrier execution is advertised here. Requested provider/model metadata is not verified model weights.'),
    h('h2', null, 'Versions'), paragraph('Each ACBench version (v0.1, v0.2, …) freezes one suite: opponents, maps, budgets and scoring. A new version gets a new permanent page; earlier versions stay published, so scores compare only within a version. A correction appends a revision of the same version with its reason.'),
    h('h2', null, 'Reproducibility & privacy'), paragraph('Versioned downloads contain suite, system, policy and publication digests, scoring rows, failure lineage and immutable corrections. Active grading seeds remain protected; block IDs preserve auditability. Publication is an explicit archival opt-in independent of expiring private Series results. No bearer shares, owner messages, secrets, private prompts or hidden chain-of-thought belong in public evidence. Raw timelines are not playable replays.'));
}
function Contribute() {
  return h(Fragment, null, h('p', { className: 'eyebrow' }, 'Community evidence'), h('h1', null, 'Contribute to ACBench'), h('ol', null,
    h('li', null, 'Choose the reference protocol and freeze a policy artifact. Record its hash, attribution, license, assistance and exact configuration.'),
    h('li', null, 'Prepare a suite with ', h('code', null, 'pnpm bench:reference --artifact policy.json --seeds /private/seeds.json --out /private/campaign --prepare'), '. Evaluate with ', h('code', null, 'pnpm bench:reference --artifact policy.json --seeds /private/seeds.json --out /private/campaign --suite /private/campaign/suite.json --consent-publication --license LICENSE'), ', which writes the consented publication JSON. This uses the generic PlayerThree scheduler and real AC baselines. Retain all failures; do not select only a best run. Trusted grading seeds remain operator-only.'),
    h('li', null, 'Send the publication JSON and immutable artifact to repository maintainers for review. Never include credentials, private prompts or owner chat. Public requests cannot execute arbitrary configuration modules.'),
    h('li', null, 'A trusted operator reruns the artifact in the policy sandbox, checks evidence and publication consent, then imports an immutable revision. Submitted claims stay labeled submitted; only operator-reviewed reruns receive trusted-rerun labels.')),
    paragraph('Artifact performance verification is not model-authorship verification. Assisted and mixed systems belong in community, not an official model-authoring claim. Corrections append a reasoned revision. Withdrawal blocks future delivery, but cannot recall downloads.'),
    h(Group, null, anchor('https://github.com/agent-command/agent-command', 'Source repository'), anchor('/api/benchmarks/models', 'Model catalogue (JSON)')),
    paragraph('Catalogue metadata helps select exact provider/model IDs. It proves neither what executed nor the historical cost of a run.'));
}

export function BenchmarkApp({ page }: { page: BenchmarkPage }) {
  const logo = useContext(BrandLogo);
  let content: ReactNode;
  if (page.kind === 'release') content = h(Release, { page });
  else if (page.kind === 'run') content = h(Run, { row: page.rows[0]! });
  else if (page.kind === 'methods') content = h(Methods);
  else if (page.kind === 'contribute') content = h(Contribute);
  else if (page.kind === 'hub') content = h(Hub, { page });
  else if (page.kind === 'live') content = h(Fragment, null, h('p', { className: 'eyebrow' }, 'Separate track'), h('h1', null, 'Live command'), paragraph('No live-command protocol or results are published here. Policy-authoring results do not measure realtime model decisions. A release must first freeze clock, latency, action limits, resets and assistance.'), anchor('/benchmarks/methodology/', 'Measurement boundaries'));
  else content = h(Fragment, null, h('h1', null, 'Publication unavailable'), paragraph('This revision is not released or has been withdrawn. Downloaded copies cannot be recalled.'));
  return h(MantineProvider, { theme, forceColorScheme: 'dark' },
    h('a', { className: 'skip', href: '#content' }, 'Skip to evidence'),
    h(Container, { size: 'xl' },
      h('header', { className: 'site-header' }, h('a', { className: 'brand', href: '/benchmarks/', 'aria-label': 'ACBench · Agent Command benchmarks' }, h('img', { className: 'brand-logo', src: logo, alt: 'Agent Command', width: 960, height: 402, fetchPriority: 'high' }), h('span', { className: 'brand-wordmark' }, 'ACBench', h('small', null, 'POLICY BENCHMARK'))), h('nav', { 'aria-label': 'Main' }, anchor('/', 'Play'), anchor('/benchmarks/', 'Benchmarks'), anchor('/benchmarks/methodology/', 'Methods'), anchor('/benchmarks/contribute/', 'Contribute'))),
      h('main', { id: 'content' }, page.replacement && h('aside', null, 'This immutable snapshot has a correction: ', anchor(page.replacement.path, `revision ${page.replacement.revision}`), '. ', page.replacement.reason), content),
      h('footer', null, 'ACBench is Agent Command\'s policy benchmark. Powered by ', anchor('https://playerthree.gg', 'PlayerThree'), '. A catalogue listing does not prove which model ran. ', anchor('/benchmarks/methodology/', 'Methods & limitations'))));
}

/** The same full-document tree is rendered on Node and hydrated in the browser. JSON stays inert escaped text. */
export function BenchmarkDocument(props: BenchmarkDocumentProps) {
  const { page, assets } = props;
  const description = 'ACBench publishes scores for AI policies played against fixed Agent Command bots, with uncertainty, failed runs and authoring cost.';
  return h('html', { lang: 'en', 'data-mantine-color-scheme': 'dark' }, h('head', null,
    h('meta', { charSet: 'utf-8' }), h('meta', { name: 'viewport', content: 'width=device-width,initial-scale=1' }), h('title', null, `${page.title} · ACBench`),
    h('meta', { name: 'theme-color', content: '#120600' }),
    h('link', { rel: 'icon', type: 'image/png', href: assets.brand.icon }),
    h('link', { rel: 'apple-touch-icon', href: assets.brand.touchIcon }),
    // React emits the logo preload itself for the high-priority <img>; a manual link would duplicate it.
    h('link', { rel: 'preload', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous', href: assets.brand.font }),
    h('meta', { name: 'description', content: description }), h('link', { rel: 'canonical', href: page.canonical }),
    h('meta', { property: 'og:type', content: 'website' }), h('meta', { property: 'og:title', content: `${page.title} · ACBench` }), h('meta', { property: 'og:description', content: description }),
    h('meta', { property: 'og:url', content: page.canonical }), h('meta', { property: 'og:image', content: page.image }), h('meta', { name: 'twitter:card', content: 'summary_large_image' }),
    ...assets.styles.map(href => h('link', { key: href, rel: 'stylesheet', href }))),
    h('body', null, h(BrandLogo.Provider, { value: assets.brand.logo }, h(BenchmarkApp, { page })), h('div', { hidden: true, id: 'acbench-data' }, JSON.stringify(props)), h('script', { type: 'module', src: assets.script })));
}
