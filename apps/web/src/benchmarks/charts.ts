/**
 * ACBench charts: ECharts options (./echarts.ts) rendered server-side to static SVG at a few widths, so a chart reads
 * without JavaScript, to crawlers and in link previews; CSS container queries show the rendering that fits. Hydration
 * reuses the server's SVG from the DOM (client.ts); only a chart for a new filter loads ECharts in the browser.
 */
import { createContext, createElement as h, useContext, useEffect, useMemo, useState } from 'react';
import { opponentLabel, scoreText, type HeadlineEntry, type Lab, type OpponentSeries, type References, type RunSpread } from './model.ts';

/** Rendering widths (px): phone, tablet, desktop. styles.css's container queries pick one by the chart's own width. */
export const CHART_WIDTHS = [340, 760, 1240] as const;
/** `lab`: the model's lab favicon, drawn before its name on the name axis. */
export type ChartSpec =
  | { kind: 'headline'; entries: { label: string; lab: Lab | null; route: string | null; value: number | null; interval: [number, number] | null; reference: boolean }[] }
  | { kind: 'opponent'; opponents: string[]; series: { label: string; values: (number | null)[] }[] }
  | { kind: 'variance'; spreads: { label: string; lab: Lab | null; runs: number[]; mean: number; min: number; max: number; sd: number | null }[] };

/** The server renders with ECharts; the browser starts from the SVG the server already put in the DOM. */
export const ChartRenderer = createContext<(spec: ChartSpec) => string[] | null>(() => null);
/** Stable id of a chart's data (FNV-1a of its spec), shared by the server render and the hydrating client. */
export function chartKey(spec: ChartSpec): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(spec)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `${spec.kind}-${hash.toString(36)}`;
}
/** Wraps each width's SVG for the container queries; client.ts reads them back by the same wrapper. */
export const chartMarkup = (svgs: readonly string[]): string => svgs.map((svg, i) => `<div class="chart-v chart-v${i}" aria-hidden="true">${svg}</div>`).join('');

function EChart({ spec, label }: { spec: ChartSpec; label: string }) {
  const render = useContext(ChartRenderer);
  const key = chartKey(spec);
  // Keyed by the spec's content, not its object identity: a re-render with equal data reuses the SVG.
  const initial = useMemo(() => render(spec), [render, key]);
  const [lazy, setLazy] = useState<{ key: string; svgs: string[] } | null>(null);
  useEffect(() => {
    if (initial) return;
    let live = true;
    void import('./echarts.ts').then(module => { if (live) setLazy({ key, svgs: module.renderChart(spec) }); });
    return () => { live = false; };
  }, [initial, key]);
  const svgs = initial ?? (lazy?.key === key ? lazy.svgs : null);
  // ECharts escapes every label it writes into the SVG; the markup never contains caller HTML.
  return h('div', { className: 'echart', role: 'img', 'aria-label': label, 'data-chart-key': key, dangerouslySetInnerHTML: { __html: svgs ? chartMarkup(svgs) : '' } });
}

/** Marks a system whose authoring profile differs from its group's ("†"); the note itself goes in the caption. */
const marked = (label: string, note: string | null | undefined) => note ? `${label} †` : label;
const footnotes = (items: readonly { label: string; note: string | null | undefined }[]) =>
  items.filter(i => i.note).map(i => `† ${i.label}: ${i.note}.`).join(' ');

/**
 * The headline chart's data: the ranked models with any reference bars merged in by score (a model before a reference
 * it ties), unscored models last. A route every model shares ("via OpenRouter") is returned to say once, not per row.
 */
export function headlineSpec(entries: readonly HeadlineEntry[], references: References | null = null): { spec: ChartSpec; sharedRoute: string | null } {
  const routes = new Set(entries.map(e => e.route));
  const sharedRoute = routes.size === 1 ? [...routes][0] ?? null : null;
  const models = entries.map(e => ({ label: marked(e.label, e.note), lab: e.lab, route: sharedRoute ? null : e.route, value: e.value, interval: e.interval, reference: false }));
  const bars = (references?.bars ?? []).map(r => ({ label: r.label, lab: null, route: null, value: r.score, interval: null, reference: true }));
  const scored = [...models.filter(e => e.value !== null), ...bars].sort((a, b) => b.value! - a.value! || Number(a.reference) - Number(b.reference));
  return { sharedRoute, spec: { kind: 'headline', entries: [...scored, ...models.filter(e => e.value === null)] } };
}

/** Score 0–100 per system, ranked, with 95% error bars and the release's curated reference bars when it has them. */
export function HeadlineChart({ entries, caption, references }: { entries: readonly HeadlineEntry[]; caption: string; references: References | null }) {
  const { spec, sharedRoute } = headlineSpec(entries, references);
  const summary = entries.map((e, i) => `${e.value === null ? '' : `${i + 1}. `}${e.label}${e.route ? ` · ${e.route}` : ''}: ${e.value === null ? 'not scored' : `${scoreText(e.value)}${e.interval ? ` (95% range ${e.interval.map(scoreText).join('–')})` : ''}`}`).join('; ');
  const refs = references?.bars.length ? `; references: ${references.bars.map(r => `${r.label} ${scoreText(r.score)}`).join(', ')}` : '';
  const notes = footnotes(entries);
  return h('figure', { className: 'bench-chart headline-chart' },
    h(EChart, { spec, label: `${caption}. ${summary}${refs}` }),
    h('figcaption', null, sharedRoute ? `${caption} · all ${sharedRoute}` : caption,
      refs && h('span', { className: 'chart-footnote' }, `Dashed bars: built-in references. ${references!.source}`),
      notes && h('span', { className: 'chart-footnote' }, notes)));
}

/** Score against each opponent (weakest tier first): what is left below 100 at the hardest tier is the headroom. */
export function OpponentChart({ opponents, series, notes }: { opponents: readonly string[]; series: readonly OpponentSeries[]; notes: ReadonlyMap<string, string> }) {
  const spec: ChartSpec = { kind: 'opponent', opponents: [...opponents], series: series.map(s => ({ label: marked(s.label, notes.get(s.id)), values: s.values })) };
  const summary = series.map(s => `${s.label}: ${s.values.map((v, i) => `${opponentLabel(opponents[i]!)} ${v === null ? 'not scored' : scoreText(v)}`).join(', ')}`).join('; ');
  const footnote = footnotes(series.map(s => ({ label: s.label, note: notes.get(s.id) })));
  return h('figure', { className: 'bench-chart opponent-chart' }, h(EChart, { spec, label: `Score 0–100 against each opponent. ${summary}` }),
    footnote && h('figcaption', null, h('span', { className: 'chart-footnote' }, footnote)));
}

/** Each authoring run's score as a dot, min–max line, mean tick and ±1σ band, on the headline's 0–100 axis. */
export function VarianceChart({ spreads, notes }: { spreads: readonly RunSpread[]; notes: ReadonlyMap<string, string> }) {
  const spec: ChartSpec = { kind: 'variance', spreads: spreads.map(s => ({ label: marked(s.label, notes.get(s.id)), lab: s.lab, runs: s.runs.map(r => r.value), mean: s.mean, min: s.min, max: s.max, sd: s.sd })) };
  const summary = spreads.map(s => `${s.label}: runs ${s.runs.map(r => scoreText(r.value)).join(', ')}; mean ${scoreText(s.mean)}${s.sd === null ? '' : `, σ ${scoreText(s.sd)}`}; ${s.runs.length} of ${s.expected} runs scored`).join('; ');
  const footnote = footnotes(spreads.map(s => ({ label: s.label, note: notes.get(s.id) })));
  return h('figure', { className: 'bench-chart variance-chart' },
    h(EChart, { spec, label: `Run-to-run variance, score 0–100. ${summary}` }),
    h('figcaption', null, 'Dot: one authoring run · line: lowest to highest · tick: mean · band: ±1σ. Unscored runs are left out, not zero.', footnote && h('span', { className: 'chart-footnote' }, footnote)));
}
