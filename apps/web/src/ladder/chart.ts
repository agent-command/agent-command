import { init, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { CardRating } from './model.ts';

use([LineChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer]);

/** Loaded only by the card's React effect after hydration: ladder points over time with the μ ± 2σ band. */
export function mountRatingChart(element: HTMLElement, rating: CardRating): () => void {
  const chart = init(element, undefined, { renderer: 'svg' });
  const points = rating.history.map((p) => [p.at, p.points]);
  chart.setOption({
    animation: false, backgroundColor: 'transparent', textStyle: { fontFamily: 'Arial, Helvetica, sans-serif', color: '#fcfbe7' },
    aria: { enabled: true, description: 'Ladder points after each rated game, with the uncertainty band μ ± 2σ (ladder units). The card lists every value.' },
    grid: { left: 56, right: 24, top: 24, bottom: 40 },
    xAxis: { type: 'time', axisLabel: { color: '#bfb789', hideOverlap: true }, splitLine: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: '#bfb789' }, splitLine: { lineStyle: { color: '#9c420044' } } },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
    series: [
      // Stacked band: the low edge (transparent), then its height filled.
      { type: 'line', name: 'Band low', stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, data: rating.history.map((p) => [p.at, p.low]) },
      { type: 'line', name: 'μ ± 2σ', stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: '#ffd21f33' }, data: rating.history.map((p) => [p.at, p.high - p.low]) },
      { type: 'line', name: 'Ladder points', symbolSize: 6, lineStyle: { color: '#ffd21f', width: 2 }, itemStyle: { color: '#ffd21f' }, data: points },
    ],
  });
  const resize = new ResizeObserver(() => chart.resize()); resize.observe(element);
  return () => { resize.disconnect(); chart.dispose(); };
}
