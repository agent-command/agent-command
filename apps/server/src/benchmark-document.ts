import { createElement as h } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BenchmarkDocument } from '../../web/src/benchmarks/components.ts';
import type { BenchmarkDocumentProps, BenchmarkPage } from '../../web/src/benchmarks/model.ts';

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
    return `<!doctype html>${renderToString(h(BenchmarkDocument, props), { identifierPrefix: 'acbench-' })}`;
  };
}

export function benchmarkImage(title: string, subtitle: string): string {
  return renderToStaticMarkup(h('svg', { xmlns: 'http://www.w3.org/2000/svg', width: 1200, height: 630 },
    h('rect', { width: 1200, height: 630, fill: '#120600' }), h('rect', { x: 65, y: 70, width: 8, height: 490, fill: '#e30000' }),
    h('g', { fontFamily: 'Arial, sans-serif' }, h('text', { x: 115, y: 155, fill: '#ffd21f', fontSize: 28 }, 'AGENT COMMAND'),
      h('text', { x: 110, y: 285, fill: '#ffd21f', fontSize: 110, fontWeight: 'bold' }, 'ACBench'),
      h('text', { x: 115, y: 375, fill: '#fcfbe7', fontSize: 36 }, title.slice(0, 48)),
      h('text', { x: 115, y: 450, fill: '#bfb789', fontSize: 25 }, subtitle.slice(0, 76)),
      h('text', { x: 115, y: 550, fill: '#bfb789', fontSize: 22 }, 'agentcommand.gg/benchmarks'))));
}
