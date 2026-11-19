import { createElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { BenchmarkDocument } from './components.ts';
import { ChartRenderer, chartKey, type ChartSpec } from './charts.ts';
import type { BenchmarkDocumentProps } from './model.ts';
import './styles.css';

const data = document.getElementById('acbench-data');
if (!data?.textContent) throw new Error('Missing server-rendered benchmark state');
// This inert node is emitted by the same-origin SSR document after the publication privacy/release projection.
// Strings remain React text on both sides; none are interpreted as HTML.
const props: BenchmarkDocumentProps = JSON.parse(data.textContent);
// The server's ECharts SVG, by chart key: hydration keeps what is already on screen instead of loading ECharts to draw
// the same chart again. Only a chart for data the server did not render (a new filter) loads ECharts.
const charts = new Map([...document.querySelectorAll<HTMLElement>('[data-chart-key]')].map(element =>
  [element.dataset.chartKey!, [...element.querySelectorAll(':scope > .chart-v')].map(v => v.innerHTML)] as const));
const rendered = (spec: ChartSpec) => charts.get(chartKey(spec)) ?? null;
hydrateRoot(document, createElement(ChartRenderer.Provider, { value: rendered }, createElement(BenchmarkDocument, props)), { identifierPrefix: 'acbench-' });
