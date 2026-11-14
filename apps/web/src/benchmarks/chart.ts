import { init, use } from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { LabelLayout } from 'echarts/features';
import type { EChartsOption } from 'echarts';
import { cost, costComparable, frontier, runPath, scoreText, type PublicBenchmark } from './model.ts';

use([ScatterChart, LineChart, GridComponent, TooltipComponent, AriaComponent, LabelLayout, SVGRenderer]);
const axisCost = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4, useGrouping: false });

/** Loaded only by the benchmark React effect, never during SSR or the game's initial load. */
export function mountFrontier(element: HTMLElement, rows: readonly PublicBenchmark[], settings: { labels: boolean; intervals: boolean }): () => void {
  const eligible = costComparable(rows);
  const efficient = new Set(frontier(eligible).map(r => r.publication.id));
  const byId = new Map(eligible.map(r => [r.publication.id, r]));
  const chart = init(element, undefined, { renderer: 'svg' });
  const series: NonNullable<EChartsOption['series']> = [
    { type: 'line', name: 'Point-estimate frontier', silent: true, showSymbol: false, lineStyle: { color: '#ffd21f', width: 2 },
      data: frontier(eligible).map(r => [cost(r.publication)!, r.publication.score.value! * 100]), z: 1 },
    { type: 'scatter', name: 'Published systems', symbolSize: 13, z: 3,
      label: { show: settings.labels, position: 'top', color: '#fcfbe7', fontSize: 12, formatter: '{b}', overflow: 'truncate', ellipsis: '…' },
      labelLayout: params => {
        const width = Math.min(180, element.clientWidth * 0.38);
        const half = Math.min(params.labelRect.width, width) / 2;
        return { x: Math.max(half + 12, Math.min(element.clientWidth - half - 12, params.rect.x + params.rect.width / 2)),
          y: Math.max(24, params.labelRect.y), width, align: 'center', verticalAlign: 'top', hideOverlap: true };
      },
      data: eligible.map(r => ({ name: r.publication.experiment.system.label, publicId: r.publication.id,
        value: [cost(r.publication)!, r.publication.score.value! * 100], itemStyle: { color: efficient.has(r.publication.id) ? '#ffd21f' : '#ff7a6e', borderColor: '#060000', borderWidth: 2 } })) },
    ...(settings.intervals ? eligible.flatMap(r => r.publication.score.interval ? [{ type: 'line' as const, name: '95% score CI', silent: true, showSymbol: false, z: 2,
      lineStyle: { color: '#bfb789', width: 2 }, data: [[cost(r.publication)!, r.publication.score.interval[0] * 100], [cost(r.publication)!, r.publication.score.interval[1] * 100]] }] : []) : []),
  ];
  chart.setOption({ baseOption: { animation: false, backgroundColor: 'transparent', textStyle: { fontFamily: 'Arial, Helvetica, sans-serif', color: '#fcfbe7' },
    aria: { enabled: true, description: 'Score versus mean authoring-run cost. Higher score and lower cost are preferred. Labels may shorten or hide when crowded; the adjacent accessible table contains full names, values, intervals and evidence links.' },
    grid: { left: 66, right: 44, top: 54, bottom: 68 },
    xAxis: { type: 'value', min: 0, max: (extent: { max: number }) => extent.max > 0 ? extent.max * 1.16 : 1, splitNumber: 4, name: 'Mean authoring-run cost · USD', nameLocation: 'middle', nameGap: 40,
      axisLabel: { color: '#bfb789', hideOverlap: true, formatter: (value: number) => axisCost.format(value) }, splitLine: { lineStyle: { color: '#9c420044' } } },
    yAxis: { type: 'value', min: 0, max: 100, name: 'Score (0–100)', nameGap: 24,
      axisLabel: { color: '#bfb789' }, splitLine: { lineStyle: { color: '#9c420044' } } },
    tooltip: { trigger: 'item', renderMode: 'richText', confine: true,
      formatter: (params: unknown) => {
        const data = params && typeof params === 'object' && 'data' in params ? params.data : null;
        const id = data && typeof data === 'object' && 'publicId' in data && typeof data.publicId === 'string' ? data.publicId : null;
        const row = id ? byId.get(id) : undefined;
        if (!row) return '';
        const p = row.publication;
        return `${p.experiment.system.label}\nScore: ${scoreText(p.score.value)}\n95% CI: ${p.score.interval ? p.score.interval.map(scoreText).join('–') : 'unavailable'}\nMean authoring cost: ${cost(p)!.toFixed(4)} USD\n${p.score.completedRuns}/${p.score.expectedRuns} independent runs\nClick for immutable run evidence`;
      } }, series },
    media: [{ query: { maxWidth: 500 }, option: { grid: { left: 44, right: 24, top: 50, bottom: 64 },
      xAxis: { name: 'Mean authoring cost · USD', nameGap: 38, axisLabel: { fontSize: 10 } }, yAxis: { axisLabel: { fontSize: 10 } } } }],
  });
  chart.on('click', params => {
    const data = params.data;
    const id = data && typeof data === 'object' && 'publicId' in data && typeof data.publicId === 'string' ? data.publicId : null;
    const row = id ? byId.get(id) : undefined;
    if (row) window.location.assign(runPath(row.publication));
  });
  const resize = new ResizeObserver(() => chart.resize()); resize.observe(element);
  return () => { resize.disconnect(); chart.dispose(); };
}
