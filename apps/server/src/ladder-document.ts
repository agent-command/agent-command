/** Server rendering of public commander cards and the leaderboard (the ACBench SSR stack, Agent Command branding). */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { LadderDocument } from '../../web/src/ladder/components.ts';
import type { LadderDocumentProps, LadderPage } from '../../web/src/ladder/model.ts';

interface ViteEntry { file: string; css?: string[]; imports?: string[] }
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const ENTRY = 'src/ladder/client.ts';

export function createLadderRenderer(webDist: string): (page: LadderPage) => Promise<string> {
  let assets: Promise<LadderDocumentProps['assets']> | undefined;
  async function loadAssets(): Promise<LadderDocumentProps['assets']> {
    let manifest: Record<string, ViteEntry> | undefined;
    // Vite serves source URLs in development; a stale local build must not pin hydration there.
    if (process.env.NODE_ENV !== 'development') {
      try { manifest = JSON.parse(await readFile(join(webDist, '.vite', 'manifest.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || process.env.NODE_ENV === 'production') throw error; }
    }
    if (!manifest) return {
      script: `/${ENTRY}`, styles: ['/src/ladder/styles.css?direct'],
      brand: { logo: '/src/brand/logo.webp', icon: '/src/brand/icon.png', touchIcon: '/src/brand/apple-touch-icon.png',
        font: `/@fs${webRequire.resolve('@fontsource/bangers/files/bangers-latin-400-normal.woff2')}` },
    };
    const built = manifest;
    const entry = built[ENTRY];
    if (!entry) throw new Error('Web build is missing the ladder hydration entry');
    const styles = new Set<string>(); const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visited.has(key)) return; visited.add(key);
      const chunk = built[key]; if (!chunk) throw new Error('Invalid ladder asset manifest');
      for (const css of chunk.css ?? []) styles.add(`/${css}`);
      for (const dependency of chunk.imports ?? []) visit(dependency);
    };
    visit(ENTRY);
    const logo = built['src/brand/logo.webp'], icon = built['src/brand/icon.png'], touchIcon = built['src/brand/apple-touch-icon.png'];
    const font = Object.entries(built).find(([key]) => key.endsWith('/bangers-latin-400-normal.woff2'))?.[1];
    if (!logo || !icon || !touchIcon || !font) throw new Error('Web build is missing Agent Command brand assets');
    return { script: `/${entry.file}`, styles: [...styles], brand: { logo: `/${logo.file}`, icon: `/${icon.file}`, touchIcon: `/${touchIcon.file}`, font: `/${font.file}` } };
  }
  return async (page) => `<!doctype html>${renderToString(h(LadderDocument, { page, assets: await (assets ??= loadAssets()) }), { identifierPrefix: 'acladder-' })}`;
}
