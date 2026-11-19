/**
 * The ACBench charts as ECharts options, rendered to static SVG strings (ECharts server-side rendering). The server
 * imports this for every page and social image; the browser loads it lazily only to redraw a chart for a new filter.
 */
import { init, use } from 'echarts/core';
import { BarChart, CustomChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkLineComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { CustomSeriesRenderItem } from 'echarts/types/dist/shared';
import { opponentLabel, type Lab } from './model.ts';
import { CHART_WIDTHS, type ChartSpec } from './charts.ts';

use([BarChart, CustomChart, ScatterChart, GridComponent, LegendComponent, MarkLineComponent, SVGRenderer]);

const INK = '#fcfbe7'; const MUTED = '#bfb789'; const GRID = '#9c42004d'; const LEAD = '#ffd21f'; const REST = '#a8834a';
/** Series colours for per-model charts, in headline rank order (the leader keeps the accent). */
const SERIES = [LEAD, '#ff8a6e', '#7fc8ff', '#9be38a', '#d9a8ff', '#f5a800', '#ff9fd0', INK];
const FONT = 'Arial, Helvetica, sans-serif';
const pct = (value: number) => Math.round(value * 1000) / 10;

/** Layout constants per rendered width: phones get smaller type and a narrower name column. */
interface Scale { narrow: boolean; font: number; small: number; names: number; row: number }
function scale(width: number): Scale {
  const narrow = width < 600;
  return { narrow, font: narrow ? 13 : 14, small: narrow ? 11 : 12, names: narrow ? 132 : width < 1000 ? 190 : 240, row: narrow ? 42 : 44 };
}

export function chartHeight(spec: ChartSpec, width: number): number {
  const s = scale(width);
  if (spec.kind === 'headline') return spec.entries.length * s.row + 36;
  if (spec.kind === 'variance') return spec.spreads.length * s.row + 36;
  return s.narrow ? 280 : 320;
}

const valueAxis = (s: Scale) => ({ type: 'value' as const, min: 0, max: 100, interval: 25,
  axisLabel: { color: MUTED, fontSize: s.small, fontFamily: FONT }, axisLine: { show: false }, axisTick: { show: false },
  splitLine: { lineStyle: { color: GRID, width: 1 } } });
/** The name column: as wide as the longest name needs (Arial averages ~0.56 em per character, a lab icon 1.4 em), up to the width's cap. */
const nameColumn = (names: readonly { label: string; lab: Lab | null }[], s: Scale) =>
  Math.min(s.names, Math.max(64, Math.ceil(Math.max(...names.map(n => n.label.length * 0.56 + (n.lab ? 1.4 : 0))) * s.font) + 28));
// `overflow` per category item works in ECharts but is missing from its item typings; `color` makes the type overlap.
type AxisName = string | { value: string; textStyle: { color: string; overflow: 'truncate' } };
/** A rich-text style per lab (`{lab_<id>|}`): its favicon as a square image box the size of the name's text. */
const labStyles = (labs: readonly (Lab | null)[], s: Scale) => Object.fromEntries(labs.flatMap(lab => lab ? [[`lab_${lab.id}`,
  { width: s.font, height: s.font, backgroundColor: { image: lab.icon }, borderRadius: 2 }]] : []));
const nameAxis = (names: AxisName[], s: Scale, column: number, labs: readonly (Lab | null)[]) => ({ type: 'category' as const, data: names, inverse: true,
  axisLine: { show: false }, axisTick: { show: false },
  // Phones wrap a long name onto a second line rather than cut it.
  axisLabel: { color: INK, fontSize: s.font, fontFamily: FONT, margin: 14, width: column - 14, overflow: s.narrow ? 'break' as const : 'truncate' as const, lineHeight: s.font + 3,
    rich: { route: { color: MUTED, fontSize: s.small, fontFamily: FONT }, ...labStyles(labs, s) } } });
/** The name with its lab's favicon before it. */
const iconName = (name: { label: string; lab: Lab | null }) => name.lab ? `{lab_${name.lab.id}|} ${name.label}` : name.label;
/** A name with a muted second line ("reference", a route): ECharts' 'break' drops the line break of rich text, so it truncates. */
const twoLines = (label: string, second: string): AxisName => ({ value: `${label}\n{route|${second}}`, textStyle: { color: INK, overflow: 'truncate' } });

function headline(spec: Extract<ChartSpec, { kind: 'headline' }>, width: number): EChartsOption {
  const s = scale(width);
  const names = spec.entries.map(e => e.reference ? twoLines(e.label, 'reference') : e.route ? twoLines(iconName(e), `· ${e.route}`) : iconName(e));
  const leader = spec.entries.findIndex(e => !e.reference && e.value !== null);
  const column = nameColumn(spec.entries, s);
  // Thin 95% error bar with end caps, drawn over the bar.
  const errorBar: CustomSeriesRenderItem = (_params, api) => {
    const lo = api.coord([api.value(1), api.value(0)]); const hi = api.coord([api.value(2), api.value(0)]);
    const cap = (api.size!([0, 1]) as number[])[1]! * 0.22; const style = { stroke: INK, lineWidth: 1.5 };
    return { type: 'group', children: [
      { type: 'line', shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style },
      { type: 'line', shape: { x1: lo[0], y1: lo[1]! - cap, x2: lo[0], y2: lo[1]! + cap }, style },
      { type: 'line', shape: { x1: hi[0], y1: hi[1]! - cap, x2: hi[0], y2: hi[1]! + cap }, style },
    ] };
  };
  return {
    animation: false, backgroundColor: 'transparent', textStyle: { fontFamily: FONT, color: INK },
    grid: { left: column, right: s.narrow ? 40 : 56, top: 6, bottom: 26 },
    xAxis: valueAxis(s), yAxis: nameAxis(names, s, column, spec.entries.map(e => e.lab)),
    series: [
      // A reference bar is an outline (dashed, faint fill) so it never reads as a model.
      { type: 'bar', silent: true, barWidth: '54%', itemStyle: { borderRadius: [0, 3, 3, 0] },
        data: spec.entries.map((e, i) => e.value === null ? null : { value: pct(e.value), itemStyle: e.reference
          ? { color: '#bfb78926', borderColor: MUTED, borderType: 'dashed' as const, borderWidth: 1.5 } : { color: i === leader ? LEAD : REST } }) },
      { type: 'custom', silent: true, renderItem: errorBar, encode: { x: [1, 2], y: 0 },
        data: spec.entries.flatMap((e, i) => e.value !== null && e.interval ? [[i, pct(e.interval[0]), pct(e.interval[1])]] : []) },
      // Value labels sit past the bar or its error bar, whichever ends later; unscored rows say so at the axis.
      { type: 'scatter', silent: true, symbolSize: 0, itemStyle: { opacity: 1 },
        // A dark halo keeps a gridline from striking through the value.
        label: { show: true, position: 'right', distance: 6, fontFamily: FONT, fontSize: s.font, fontWeight: 'bold', color: INK, textBorderColor: '#1a0500', textBorderWidth: 3,
          formatter: (p: { value: unknown }) => (p.value as [number, number, string])[2] },
        data: spec.entries.map((e, i) => e.value === null ? { value: [0, i, 'Not scored'], label: { color: MUTED, fontWeight: 'normal' as const } }
          : { value: [Math.max(pct(e.value), e.interval ? pct(e.interval[1]) : 0), i, pct(e.value).toFixed(1)], ...(e.reference ? { label: { color: MUTED } } : {}) }) },
    ],
  };
}

function opponent(spec: Extract<ChartSpec, { kind: 'opponent' }>, width: number): EChartsOption {
  const s = scale(width);
  return {
    animation: false, backgroundColor: 'transparent', textStyle: { fontFamily: FONT, color: INK },
    color: SERIES,
    legend: { top: 0, left: 0, itemWidth: 12, itemHeight: 12, itemGap: s.narrow ? 10 : 22, icon: 'roundRect',
      textStyle: { color: INK, fontSize: s.small + 1, fontFamily: FONT } },
    grid: { left: 34, right: 8, top: s.narrow ? 56 : 44, bottom: 28 },
    xAxis: { type: 'category', data: spec.opponents.map(opponentLabel), axisLine: { lineStyle: { color: GRID } }, axisTick: { show: false },
      axisLabel: { color: INK, fontSize: s.narrow ? s.small : s.font, fontFamily: FONT, interval: 0 } },
    yAxis: { ...valueAxis(s), axisLabel: { color: MUTED, fontSize: s.small, fontFamily: FONT } },
    series: [
      ...spec.series.map(series => ({ type: 'bar' as const, name: series.label, silent: true, barGap: '18%', barCategoryGap: s.narrow ? '22%' : '30%', barMaxWidth: 44,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
        // A missing value is no bar at all, never a zero.
        label: { show: !s.narrow, position: 'top' as const, color: INK, fontSize: s.small, fontFamily: FONT, formatter: (p: { value: unknown }) => String(Math.round(p.value as number)) },
        data: series.values.map(v => v === null ? null : pct(v)) })),
    ],
  };
}

function variance(spec: Extract<ChartSpec, { kind: 'variance' }>, width: number): EChartsOption {
  const s = scale(width);
  const column = nameColumn(spec.spreads, s);
  const spread: CustomSeriesRenderItem = (_params, api) => {
    const row = api.value(0) as number; const at = (x: number) => api.coord([x, row]);
    const [min, max, mean, low, high] = [1, 2, 3, 4, 5].map(i => api.value(i) as number) as [number, number, number, number, number];
    const height = (api.size!([0, 1]) as number[])[1]!;
    const band = low < 0 ? null : { type: 'rect' as const, shape: { x: at(low)[0]!, y: at(low)[1]! - height * 0.22, width: at(high)[0]! - at(low)[0]!, height: height * 0.44 }, style: { fill: '#ffd21f33' } };
    return { type: 'group', children: [
      ...(band ? [band] : []),
      { type: 'line', shape: { x1: at(min)[0], y1: at(min)[1], x2: at(max)[0], y2: at(max)[1] }, style: { stroke: MUTED, lineWidth: 2 } },
      { type: 'line', shape: { x1: at(mean)[0], y1: at(mean)[1]! - height * 0.26, x2: at(mean)[0], y2: at(mean)[1]! + height * 0.26 }, style: { stroke: LEAD, lineWidth: 3 } },
    ] };
  };
  return {
    animation: false, backgroundColor: 'transparent', textStyle: { fontFamily: FONT, color: INK },
    grid: { left: column, right: s.narrow ? 48 : 70, top: 6, bottom: 26 },
    xAxis: valueAxis(s), yAxis: nameAxis(spec.spreads.map(iconName), s, column, spec.spreads.map(r => r.lab)),
    series: [
      { type: 'custom', silent: true, renderItem: spread, encode: { x: [1, 2], y: 0 },
        data: spec.spreads.map((r, i) => [i, pct(r.min), pct(r.max), pct(r.mean), r.sd === null ? -1 : pct(Math.max(0, r.mean - r.sd)), r.sd === null ? -1 : pct(Math.min(1, r.mean + r.sd))]) },
      { type: 'scatter', silent: true, symbolSize: s.narrow ? 8 : 10, itemStyle: { color: INK, borderColor: '#060000', borderWidth: 1.5 },
        data: spec.spreads.flatMap((r, i) => r.runs.map(v => [pct(v), i])) },
      // σ at the row's right edge, clear of a band that reaches 100.
      { type: 'scatter', silent: true, symbolSize: 0, itemStyle: { opacity: 1 },
        label: { show: true, position: 'right', distance: 10, color: MUTED, fontSize: s.small, fontFamily: FONT, formatter: (p: { value: unknown }) => (p.value as [number, number, string])[2] },
        data: spec.spreads.map((r, i) => [100, i, r.sd === null ? `n=${r.runs.length}` : `σ ${pct(r.sd).toFixed(1)}`]) },
    ],
  };
}

/** One chart as an SVG string at a fixed size. */
export function renderChartAt(spec: ChartSpec, width: number, height = chartHeight(spec, width)): string {
  const chart = init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption(spec.kind === 'headline' ? headline(spec, width) : spec.kind === 'opponent' ? opponent(spec, width) : variance(spec, width));
    return chart.renderToSVGString();
  } finally { chart.dispose(); }
}
/** The chart at every responsive width ({@link CHART_WIDTHS}); CSS container queries show the one that fits. */
export const renderChart = (spec: ChartSpec): string[] => CHART_WIDTHS.map(width => renderChartAt(spec, width));
