import { createElement as h } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BenchmarkDocument } from '../../web/src/benchmarks/components.ts';
import { ChartRenderer, headlineSpec } from '../../web/src/benchmarks/charts.ts';
import { renderChart, renderChartAt } from '../../web/src/benchmarks/echarts.ts';
import type { BenchmarkDocumentProps, BenchmarkPage, HeadlineEntry } from '../../web/src/benchmarks/model.ts';

interface ViteEntry { file: string; css?: string[]; imports?: string[] }
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
export function createBenchmarkRenderer(webDist: string) {
  let assets: Promise<BenchmarkDocumentProps['assets']> | undefined;
  async function loadAssets(): Promise<BenchmarkDocumentProps['assets']> {
    let loadedManifest: Record<string, ViteEntry> | undefined;
    // Vite serves source URLs, not a previous build's /assets files. Never let a local build pin dev hydration.
    if (process.env.NODE_ENV !== 'development') {
      try { loadedManifest = JSON.parse(await readFile(join(webDist, '.vite', 'manifest.json'), 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || process.env.NODE_ENV === 'production') throw error;
      }
    }
    if (!loadedManifest) return {
      script: '/src/benchmarks/client.ts', styles: ['/src/benchmarks/styles.css?direct'],
      brand: { logo: '/src/brand/logo.webp', icon: '/src/brand/icon.png', touchIcon: '/src/brand/apple-touch-icon.png',
        font: `/@fs${webRequire.resolve('@fontsource/bangers/files/bangers-latin-400-normal.woff2')}` },
    };
    const manifest = loadedManifest;
    const entry = manifest['src/benchmarks/client.ts'];
    if (!entry) throw new Error('Web build is missing the ACBench hydration entry');
    const styles = new Set<string>(); const visited = new Set<string>();
    function visit(key: string): void {
      if (visited.has(key)) return; visited.add(key);
      const chunk = manifest[key]; if (!chunk) throw new Error('Invalid benchmark asset manifest');
      for (const css of chunk.css ?? []) styles.add(`/${css}`);
      for (const dependency of chunk.imports ?? []) visit(dependency);
    }
    visit('src/benchmarks/client.ts');
    const logo = manifest['src/brand/logo.webp'];
    const icon = manifest['src/brand/icon.png'];
    const touchIcon = manifest['src/brand/apple-touch-icon.png'];
    const font = Object.entries(manifest).find(([key]) => key.endsWith('/bangers-latin-400-normal.woff2'))?.[1];
    if (!logo || !icon || !touchIcon || !font) throw new Error('Web build is missing Agent Command benchmark brand assets');
    return { script: `/${entry.file}`, styles: [...styles], brand: { logo: `/${logo.file}`, icon: `/${icon.file}`, touchIcon: `/${touchIcon.file}`, font: `/${font.file}` } };
  }
  return async (page: BenchmarkPage): Promise<string> => {
    const props: BenchmarkDocumentProps = { page, assets: await (assets ??= loadAssets()) };
    // Charts are ECharts SVG rendered here, so the page shows them with no JavaScript.
    return `<!doctype html>${renderToString(h(ChartRenderer.Provider, { value: renderChart }, h(BenchmarkDocument, props)), { identifierPrefix: 'acbench-' })}`;
  };
}

/** The social card: with `entries`, the version's headline chart (top six models) in ECharts SVG. */
export function benchmarkImage(title: string, subtitle: string, entries?: readonly HeadlineEntry[]): string {
  const frame = [h('rect', { key: 'bg', width: 1200, height: 630, fill: '#120600' }), h('rect', { key: 'rule', x: 65, y: 70, width: 8, height: 490, fill: '#e30000' })];
  if (!entries?.length) return renderToStaticMarkup(h('svg', { xmlns: 'http://www.w3.org/2000/svg', width: 1200, height: 630 }, ...frame,
    h('g', { fontFamily: 'Arial, sans-serif' }, h('text', { x: 115, y: 155, fill: '#ffd21f', fontSize: 28 }, 'AGENT COMMAND'),
      h('text', { x: 110, y: 285, fill: '#ffd21f', fontSize: 110, fontWeight: 'bold' }, 'ACBench'),
      h('text', { x: 115, y: 375, fill: '#fcfbe7', fontSize: 36 }, title.slice(0, 48)),
      h('text', { x: 115, y: 450, fill: '#bfb789', fontSize: 25 }, subtitle.slice(0, 76)),
      h('text', { x: 115, y: 550, fill: '#bfb789', fontSize: 22 }, 'agentcommand.gg/benchmarks'))));
  const shown = entries.slice(0, 6);
  const { spec, sharedRoute } = headlineSpec(shown);
  // Drawn at 720 px and scaled 1.5× into the card, so its type stays readable in a small preview.
  const chart = renderChartAt(spec, 720, 230).replace(/^<svg([^>]*?) width="\d+" height="\d+"/, '<svg$1 x="70" y="225" width="1080" height="345"');
  const card = renderToStaticMarkup(h('svg', { xmlns: 'http://www.w3.org/2000/svg', width: 1200, height: 630 }, ...frame,
    h('g', { fontFamily: 'Arial, sans-serif' },
      h('text', { x: 115, y: 100, fill: '#f5a800', fontSize: 22, letterSpacing: 2 }, 'AGENT COMMAND · ACBENCH'),
      h('text', { x: 112, y: 160, fill: '#ffd21f', fontSize: 56, fontWeight: 'bold' }, title.slice(0, 34)),
      h('text', { x: 115, y: 200, fill: '#bfb789', fontSize: 24 }, subtitle.slice(0, 80)),
      h('text', { x: 115, y: 612, fill: '#bfb789', fontSize: 20 }, `Win rate 0–100${shown.some(e => e.interval) ? ' · error bars: 95% range' : ''}${sharedRoute ? ` · all ${sharedRoute}` : ''}${entries.length > shown.length ? ` · top ${shown.length} of ${entries.length}` : ''}`))));
  return card.replace('</svg>', `${chart}</svg>`);
}
