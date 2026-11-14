/**
 * ACBench pages (hub, release, run, methods, contribute, live) as one React tree: rendered to a full document on the
 * server (apps/server/src/benchmark-document.ts) and hydrated by benchmarks/client.ts, so both renders must match.
 */
import { createContext, createElement as h, Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Badge as MantineBadge, Button as MantineButton, Card as MantineCard, Checkbox, Container, Group, MantineProvider, NativeSelect, TextInput, createTheme } from '@mantine/core';
import { cohort, cohortOptions, cost, costComparable, releasePath, runPath, scoreText, type BenchmarkDocumentProps, type BenchmarkPage, type PublicBenchmark } from './model.ts';

// Fix the root element types so createElement does not infer every polymorphic variant.
const Badge = MantineBadge<'div'>;
const Button = MantineButton<'button'>;
const Card = MantineCard<'div'>;

const theme = createTheme({ primaryColor: 'gold', colors: { gold: ['#fffbe7','#fff2ad','#ffe775','#ffdc42','#ffd21f','#f5a800','#dc8c00','#c66a00','#9c4200','#621f02'] }, primaryShade: 4, fontFamily: 'Arial, Helvetica, sans-serif', defaultRadius: 'md', headings: { fontFamily: 'Bangers, Impact, sans-serif', fontWeight: '400' } });
const anchor = (href: string, text: ReactNode) => h('a', { href }, text);
const paragraph = (text: string) => h('p', null, text);
const BrandLogo = createContext('/src/brand/logo.webp');

function Metrics({ items }: { items: readonly { label: string; value: string | number; note: string }[] }) {
  return h('dl', { className: 'metric-strip' }, ...items.map(item => h('div', { key: item.label }, h('dt', null, item.label), h('dd', null, item.value), h('small', null, item.note))));
}

function EvidenceSummary({ rows }: { rows: readonly PublicBenchmark[] }) {
  const total = (key: 'completedRuns' | 'expectedRuns' | 'scoredTrials' | 'expectedTrials' | 'failedRuns') => rows.reduce((sum, row) => sum + row.publication.score[key], 0);
  return h(Metrics, { items: [
    { label: 'Systems selected', value: rows.length, note: 'One exact comparison cohort' },
    { label: 'Independent runs', value: `${total('completedRuns')} / ${total('expectedRuns')}`, note: `${total('failedRuns')} failed authoring runs retained` },
    { label: 'Scored games', value: `${total('scoredTrials')} / ${total('expectedTrials')}`, note: 'Scored / expected · not independent runs' },
    { label: 'Cost-comparable systems', value: costComparable(rows).length, note: 'Complete scores + complete authoring USD' },
  ] });
}

export function ScoreTable({ rows }: { rows: readonly PublicBenchmark[] }) {
  const [sort, setSort] = useState<'score' | 'cost' | 'name'>('score');
  const sorted = useMemo(() => [...rows].sort((a, b) => sort === 'name' ? a.publication.experiment.system.label.localeCompare(b.publication.experiment.system.label) : sort === 'cost' ? (cost(a.publication) ?? Infinity) - (cost(b.publication) ?? Infinity) : (b.publication.score.value ?? -1) - (a.publication.score.value ?? -1)), [rows, sort]);
  const sortable = (label: string, key: typeof sort) => h('th', { scope: 'col', 'aria-sort': sort === key ? key === 'score' ? 'descending' : 'ascending' : 'none' }, h('button', { type: 'button', className: 'table-sort', onClick: () => setSort(key) }, label));
  return h('div', { className: 'table-scroll' }, h('table', null,
    h('caption', null, 'Fixed-reference scores · 0–100 · descriptive ordering, not a significance test'),
    h('thead', null, h('tr', null, sortable('System', 'name'), sortable('Score · 95% CI', 'score'), h('th', { scope: 'col' }, 'Independent runs'), h('th', { scope: 'col' }, 'Scored / expected games'), sortable('Mean authoring cost (USD)', 'cost'), h('th', { scope: 'col' }, 'Evidence'))),
    h('tbody', null, ...sorted.map(row => { const p = row.publication; const amount = cost(p); return h('tr', { key: p.id },
      h('th', { scope: 'row' }, anchor(`${releasePath(row)}systems/${encodeURIComponent(p.experiment.system.id)}/`, p.experiment.system.label), h('small', null, p.experiment.system.model ?? 'Model not reported')),
      h('td', null, h('strong', { className: 'score-value' }, scoreText(p.score.value)), h('small', null, p.score.interval ? p.score.interval.map(scoreText).join('–') : 'CI unavailable'), h(Badge, { color: p.score.complete ? 'gold' : 'orange', variant: 'light' }, p.score.complete ? 'Complete' : 'Incomplete')),
      h('td', null, `${p.score.completedRuns}/${p.score.expectedRuns}`, h('small', null, `${p.score.failedRuns} failed · ${p.score.uncertainty.blocks} blocks`)),
      h('td', null, `${p.score.scoredTrials}/${p.score.expectedTrials}`),
      h('td', null, amount === null ? 'Unavailable / partial' : amount.toFixed(4), h('small', null, 'Evaluation compute excluded')),
      h('td', null, `${row.publisher} · ${row.evidence}`, h('small', null, anchor(runPath(p), 'Run evidence')))); }))));
}

export function FrontierChart({ rows }: { rows: readonly PublicBenchmark[] }) {
  const element = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState(true); const [intervals, setIntervals] = useState(true);
  const [state, setState] = useState('Interactive chart loads after hydration. All observations are in the accessible table below.');
  const eligible = useMemo(() => costComparable(rows), [rows]);
  const excluded = rows.length - eligible.length;
  useEffect(() => {
    if (!element.current || !eligible.length) return;
    let stopped = false; let dispose: (() => void) | undefined;
    void import('./chart.ts').then(module => {
      if (stopped || !element.current) return;
      dispose = module.mountFrontier(element.current, eligible, { labels, intervals });
      setState('Interactive chart ready. Select a point for run evidence, or use the accessible table links.');
    }).catch(() => { if (!stopped) setState('Interactive chart unavailable. The complete score and cost table remains available.'); });
    return () => { stopped = true; dispose?.(); };
  }, [eligible, labels, intervals]);
  return h('section', { className: 'frontier-section', 'aria-labelledby': 'frontier-heading' },
    h('div', { className: 'section-heading' }, h('div', null, h('p', { className: 'eyebrow' }, 'Score vs cost'), h('h2', { id: 'frontier-heading' }, 'Score–cost frontier')), h('p', { className: 'chart-direction' }, '↑ Higher score', h('br'), '← Lower authoring cost')),
    h('p', { className: 'chart-caveat' }, '95% score intervals where available. Point-estimate frontier ≠ significant superiority.'),
    h('p', { className: 'muted' }, `${excluded} selected systems excluded: incomplete score, unknown/partial cost or another pricing convention. Costs are not zero; evaluation compute excluded.`),
    eligible.length ? h(Fragment, null,
      h(Group, { gap: 'lg', className: 'chart-controls' }, h(Checkbox, { checked: labels, onChange: (event: ChangeEvent<HTMLInputElement>) => setLabels(event.currentTarget.checked), label: 'Point labels' }), h(Checkbox, { checked: intervals, onChange: (event: ChangeEvent<HTMLInputElement>) => setIntervals(event.currentTarget.checked), label: '95% intervals' })),
      h('div', { className: 'frontier-frame' }, h('div', { ref: element, className: 'frontier-canvas', role: 'img', 'aria-label': 'Score versus mean authoring cost; complete values and run links follow in the table' }),
        !state.startsWith('Interactive chart ready.') && h('div', { className: 'chart-placeholder' }, h('strong', null, 'Score–cost comparison'), h('small', null, 'Interactive view requires JavaScript. All values and evidence are available in the table below.'))),
      h('p', { className: 'muted', role: 'status', 'aria-live': 'polite' }, state)) : h('aside', null, 'No comparable complete cost observations are available for this selection.'),
    h('h2', { id: 'evidence-heading' }, 'Run evidence and methods'),
    h('p', { className: 'muted' }, 'All selected systems, including incomplete results. Scores on a 0–100 scale; intervals and failures travel with every result.'),
    h(ScoreTable, { rows }));
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
  const rows = useMemo(() => page.rows.filter(r => cohort(r.publication) === selected && (!model || `${r.publication.experiment.system.model ?? ''} ${r.publication.experiment.system.label}`.toLowerCase().includes(model.toLowerCase()))), [page.rows, selected, model]);
  return h(Fragment, null, h('p', { className: 'eyebrow' }, `${release.publisher} · ${release.evidence} · revision ${release.revision}`), h('h1', { className: 'release-title' }, release.title),
    h('p', { className: 'release-meta' }, `${release.systems} systems in this immutable snapshot · released ${release.notBefore}`),
    release.correction && h('aside', null, `Correction: ${release.correction} `, release.previous && anchor(release.previous, 'Previous revision')),
    h('form', { method: 'get', action: release.path, className: 'release-filters', onSubmit: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); change(selected, model, 'push'); } },
      h(NativeSelect, { label: 'Suite / track / profile', name: 'cohort', value: selected, onChange: (event: ChangeEvent<HTMLSelectElement>) => change(event.currentTarget.value, model, 'push'), data: groups.map(({ value, label }) => ({ value, label })) }),
      h(TextInput, { label: 'Model or system', name: 'model', value: model, list: listId, maxLength: 200, onChange: (event: ChangeEvent<HTMLInputElement>) => change(selected, event.currentTarget.value, 'replace') }),
      h('datalist', { id: listId }, ...suggestions.map(item => h('option', { key: item.id, value: item.id }, item.name))),
      h(Button, { type: 'submit', variant: 'outline' }, 'Apply filters'), h('a', { href: release.path, onClick: (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); change(fallback, '', 'push'); } }, 'Clear')),
    h(EvidenceSummary, { rows }),
    rows.length ? h(FrontierChart, { rows }) : h('aside', { role: 'status' }, 'No systems match these filters. Clear filters to inspect the released snapshot; missing is not zero.'),
    h(Group, { className: 'download-links' }, anchor(`${release.path}data.json`, 'Download evidence'), anchor(`${release.path}manifest.json`, 'Manifest & checksums'), anchor(`${release.path}scores.csv`, 'Score CSV'), anchor('/benchmarks/methodology/', 'Methods')),
    h('details', { className: 'evidence-details' }, h('summary', null, 'Comparison rules & frozen release identity'),
      paragraph('Official comparisons hold harness/version, prompt/tool profile and budget fixed. Alternate harnesses use separate system-comparison suites. Filters retain the exact suite and configuration; the frontier plots one frozen pricing convention. Neither patches nor budgets are pooled.'),
      h('p', { className: 'muted', 'aria-live': 'polite' }, catalogStatus),
      h('p', null, `Published ${release.publishedAt} · public release ${release.notBefore}.`),
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
  return h(Fragment, null, h('p', { className: 'eyebrow' }, `${row.publisher} · ${row.evidence} · revision ${p.revision}`), h('h1', { className: 'release-title' }, p.experiment.system.label),
    h(Group, { className: 'download-links' }, anchor(releasePath(row), 'Release'), anchor(`${runPath(p)}data.json`, 'Versioned evidence JSON'), anchor(`${runPath(p)}manifest.json`, 'Manifest')),
    row.correction && h('aside', null, row.correction, row.supersedes && anchor(row.supersedes, 'Previous revision')),
    h(Metrics, { items: [
      { label: 'Fixed-reference score', value: scoreText(p.score.value), note: p.score.interval ? `95% CI ${p.score.interval.map(scoreText).join('–')} · ${p.score.complete ? 'complete' : 'incomplete'}` : `95% CI unavailable · ${p.score.complete ? 'complete' : 'incomplete'}` },
      { label: 'Independent runs', value: `${p.score.completedRuns} / ${p.score.expectedRuns}`, note: `${p.score.failedRuns} failed authoring runs retained` },
      { label: 'Scored games', value: `${p.score.scoredTrials} / ${p.score.expectedTrials}`, note: `${p.score.uncertainty.blocks} independent world blocks` },
      { label: 'Mean authoring cost', value: amount === null ? 'Unavailable' : `$${amount.toFixed(4)}`, note: amount === null ? 'Unknown / partial is not zero' : 'USD · evaluation compute excluded' },
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
        h('tbody', null, ...p.runs.map((r, index) => h('tr', { key: r.id }, h('th', { scope: 'row' }, r.id), h('td', null, r.status, h('small', null, r.reason ?? 'No failure recorded')), h('td', null, scoreText(p.score.runScores[index] ?? null)), h('td', null, h('code', null, r.artifactDigest ?? 'No artifact'), h('small', null, `Series ${r.seriesId ?? 'Not started'} · revision ${r.seriesRevision ?? 'unknown'}`)), h('td', null, r.trials.reduce((n, t) => n + t.attempts, 0), h('small', null, `${r.authoringAttempts} authoring`)), h('td', null, `${r.cost.amount ?? 'Unknown'} ${r.cost.currency ?? ''}`, h('small', null, `${r.cost.scope} · ${r.cost.coverage} · ${r.cost.source}`), h('small', null, `${r.cost.pricingVersion ?? 'No pricing version'} · ${r.cost.pricedAt ?? 'No pricing date'}`)))))))),
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
  const logo = useContext(BrandLogo);
  const official = page.releases.filter(release => release.publisher === 'official').length;
  return h(Fragment, null,
    h('section', { className: 'bench-hero', 'aria-labelledby': 'bench-title' },
      h('div', null, h('p', { className: 'eyebrow' }, 'Agent Command · Policy benchmark'),
        h('h1', { id: 'bench-title' }, page.title === 'AI policy benchmark' ? 'ACBench' : page.title),
        h('p', { className: 'hero-line' }, 'AI policies, scored in real matches.', h('br'), h('span', null, 'Failed runs count.')),
        h('p', { className: 'lede' }, 'Each policy is frozen, then plays versioned built-in bots on predeclared maps. A result shows the score, its uncertainty and what writing the policy cost.'),
        h('div', { className: 'hero-actions' }, anchor('#published-snapshots', 'Published snapshots ↓'), anchor('/benchmarks/methodology/', 'How scoring works'))),
      h('div', { className: 'hero-seal' }, h('img', { className: 'hero-logo', src: logo, alt: 'Agent Command', width: 960, height: 402, fetchPriority: 'high' }), h('p', null, 'Score = 100 × (win + ½ draw)'), h('small', null, 'Weighted mean over fixed opponents and maps'))),
    h(Metrics, { items: [
      { label: 'Released snapshots', value: page.releases.length, note: 'Public immutable revisions' },
      { label: 'Official snapshots', value: official, note: 'Controlled policy authoring' },
      { label: 'Community snapshots', value: page.releases.length - official, note: 'Submitted artifacts / trusted reruns' },
    ] }),
    h('section', { 'aria-labelledby': 'published-snapshots' },
      h('div', { className: 'section-heading' }, h('h2', { id: 'published-snapshots' }, 'Published snapshots'), h('span', { className: 'muted' }, 'Released results only')),
      page.releases.length ? h('div', { className: 'cards snapshot-grid' }, ...page.releases.map(r => h(Card, { key: r.path, withBorder: true, className: 'research-card snapshot-card' },
        h(Badge, { variant: 'light', color: 'gold' }, `${r.publisher} · ${r.evidence}`), h('h3', null, anchor(r.path, r.title)),
        h('p', { className: 'snapshot-count' }, r.systems, h('small', null, 'systems in this snapshot')),
        h('p', { className: 'muted' }, `Revision ${r.revision} · released ${r.notBefore} · ${r.correction ? 'Correction' : 'Original snapshot'}`), anchor(r.path, 'Compare systems →')))) :
        h('aside', { className: 'empty-release' }, h('div', { className: 'empty-count', 'aria-hidden': true }, '0'), h('div', null, h('h3', null, 'No public results yet'),
          paragraph('No ranking or frontier has been released. Private games do not automatically become public evidence.'),
          h(Group, null, anchor('/benchmarks/methodology/', 'Read the methods'), anchor('/benchmarks/contribute/', 'Evaluate a policy'))))),
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
    h('h2', null, 'Opponents and scoring'), paragraph('Each authoring replicate starts independently. Frozen policies face versioned built-in opponents on predeclared maps and mirrored world blocks. Score is 100 times the fixed weighted mean of win + 0.5 draw. Runs receive equal weight; model-caused authoring failure scores zero. Infrastructure gaps (outages, setup failures, interruptions) keep results incomplete rather than scoring zero or shrinking the denominator. Timeouts follow the frozen adjudication.'),
    h('h2', null, 'Uncertainty'), paragraph('Crossed run/block bootstrap resamples independent authoring runs and shared world blocks while preserving strata and mirrors. Manifests freeze algorithm, seed and replicate count. A single authoring run cannot estimate authoring variance; absent intervals remain unavailable. Per-run scores, attempts and independent blocks are separate counts. Ordering and Pareto membership do not establish significant differences.'),
    h('h2', null, 'Cost frontiers'), paragraph('A frontier compares one suite/profile and frozen cost convention. It minimizes mean authoring-run USD cost and maximizes score. Unknown, partial, unpriced or incomplete observations are excluded, never plotted at zero. Records disclose scope, source, currency, pricing date and version. Runner estimates are not invoices; evaluation compute is excluded. Failed runs remain in the denominator. Catalogue prices never rewrite historical bills.'),
    h('h2', null, 'Tracks'), paragraph('Official authored-policy is curated runner-observed authoring. Community evaluates immutable submitted artifacts: a trusted rerun establishes how the artifact plays, not which model wrote it. Live-command is a separate realtime task; no live-command protocol or decision-barrier execution is advertised here. Requested provider/model metadata is not verified model weights.'),
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
