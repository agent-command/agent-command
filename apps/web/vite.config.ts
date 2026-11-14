import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type HtmlTagDescriptor, type Plugin, type Rolldown } from 'vite';

const target = `http://localhost:${process.env.AC_SERVER_PORT ?? 2567}`;
const workspaces = fileURLToPath(new URL('../../../', import.meta.url));

const MAIN = fileURLToPath(new URL('./src/main.ts', import.meta.url));
const PLAY = fileURLToPath(new URL('./src/play.ts', import.meta.url));
const CONNECT = fileURLToPath(new URL('./src/connect-page.ts', import.meta.url));
const BENCHMARKS = fileURLToPath(new URL('./src/benchmarks/client.ts', import.meta.url));
const LADDER = fileURLToPath(new URL('./src/ladder/client.ts', import.meta.url));

/**
 * The build's release stamp (`__AC_RELEASE__`), shown small on Home. A deploy writes `release.json` (both repos'
 * revisions) at the image root, beside the two checkouts; a local build reads each checkout's HEAD.
 */
function release(): { version: string; agentCommand: string; playerThree: string; builtAt: string } {
  const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
  const builtAt = new Date().toISOString().slice(0, 10);
  const stamp = fileURLToPath(new URL('../../../release.json', import.meta.url));
  if (existsSync(stamp)) {
    const { agentCommand, playerThree } = JSON.parse(readFileSync(stamp, 'utf8')) as { agentCommand: string; playerThree: string };
    return { version, agentCommand, playerThree, builtAt };
  }
  const head = (cwd: string) => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(); } catch { return 'dev'; } };
  return { version, agentCommand: head(fileURLToPath(new URL('.', import.meta.url))), playerThree: head(fileURLToPath(new URL('../../../player-three', import.meta.url))), builtAt };
}

/**
 * The home menu loads in a handful of chunks, requested by the HTML itself.
 *
 * Chunking: what play.ts reaches statically is grouped into three chunks instead of the dozens of shared fragments the
 * lazy screens (commanders, agent console, lobby sockets, results) would otherwise split it into, each one more request
 * on the critical path: `boot` (the entry's own imports), `shared` (what the /connect page also imports) and `menu`
 * (the rest, with one stylesheet). /connect never evaluates `menu`; only play.ts does.
 *
 * Preloads: the menu's chunks and stylesheets, style.css and the hero's Bangers face are requested alongside the
 * entry, instead of in three serial round trips (entry → style.css → menu) and a late font swap. Preloads neither
 * evaluate modules nor apply stylesheets, so the HTML shell still paints without JS. A missing piece fails the build.
 */
function homeMenu(): Plugin {
  const boot = new Set<string>();
  const shared = new Set<string>();
  const menu = new Set<string>();
  return {
    name: 'ac-home-menu',
    apply: 'build',
    config: () => ({
      build: { rolldownOptions: { output: { codeSplitting: { groups: [
        // Each set is closed under static imports bar the earlier sets (loaded first), so no recursion is needed.
        { name: 'boot', test: (id: string) => boot.has(id), includeDependenciesRecursively: false },
        { name: 'shared', test: (id: string) => shared.has(id), includeDependenciesRecursively: false },
        { name: 'menu', test: (id: string) => menu.has(id), includeDependenciesRecursively: false },
      ] } } } },
    }),
    buildEnd() {
      const closure = (id: string, into: Set<string>, includeDynamic = false): Set<string> => {
        if (into.has(id)) return into;
        into.add(id);
        const info = this.getModuleInfo(id);
        for (const dep of info?.importedIds ?? []) closure(dep, into, includeDynamic);
        if (includeDynamic) for (const dep of info?.dynamicallyImportedIds ?? []) closure(dep, into, true);
        return into;
      };
      // Shared runtime helpers must not pull the game's DOM-dependent boot code into ACBench.
      const benchmarks = closure(LADDER, closure(BENCHMARKS, new Set(), true), true);
      for (const id of closure(MAIN, new Set())) if (id !== MAIN && !benchmarks.has(id)) boot.add(id);
      const connect = closure(CONNECT, new Set());
      for (const id of closure(PLAY, new Set())) if (id !== MAIN && !boot.has(id) && !benchmarks.has(id)) (connect.has(id) ? shared : menu).add(id);
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle }) {
        if (!bundle) return;
        const files = Object.values(bundle);
        const chunks = new Map(files.filter((file): file is Rolldown.OutputChunk => file.type === 'chunk').map((chunk) => [chunk.fileName, chunk]));
        const asset = (name: string): string => {
          const found = files.find((file) => file.type === 'asset' && file.names.includes(name));
          if (!found) throw new Error(`homeMenu: no ${name} in the bundle`);
          return found.fileName;
        };
        const menu = [...chunks.values()].find((chunk) => chunk.name === 'menu');
        if (!menu?.moduleIds.includes(PLAY)) throw new Error('homeMenu: play.ts is not in the menu chunk');
        // `import('./play.ts')` resolves to its own facade chunk, which imports the menu chunk.
        const play = [...chunks.values()].find((chunk) => chunk.facadeModuleId === PLAY);
        if (!play) throw new Error('homeMenu: no play.ts chunk');
        // The entry's static graph is already in the HTML (Vite's own modulepreloads); the menu adds what it shares
        // with the /connect page.
        const loaded = new Set<string>();
        const visit = (chunk: Rolldown.OutputChunk, into: Set<string>): void => {
          if (into.has(chunk.fileName)) return;
          into.add(chunk.fileName);
          for (const file of chunk.imports) visit(chunks.get(file)!, into);
        };
        for (const chunk of chunks.values()) if (chunk.isEntry && chunk.facadeModuleId !== BENCHMARKS) visit(chunk, loaded);
        const scripts = new Set<string>(loaded);
        visit(play, scripts);
        for (const file of loaded) scripts.delete(file);
        const styles = [asset('style.css'), ...[...scripts].flatMap((file) => [...chunks.get(file)!.viteMetadata?.importedCss ?? []])];
        // Vite's dynamic-import preloader skips a module that already has a <link href> and appends stylesheets after
        // these preloads, without crossorigin: the hrefs and request modes below match its own so nothing loads twice.
        const link = (attrs: Record<string, string | boolean>): HtmlTagDescriptor => ({ tag: 'link', attrs, injectTo: 'head' });
        return [
          ...styles.map((file) => link({ rel: 'preload', as: 'style', href: `/${file}` })),
          ...[...scripts].map((file) => link({ rel: 'modulepreload', crossorigin: true, href: `/${file}` })),
          link({ rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: true, href: `/${asset('bangers-latin-400-normal.woff2')}` }),
        ];
      },
    },
  };
}

export default defineConfig({
  server: {
    port: 5173,
    // playerthree is linked from the sibling repo.
    fs: { allow: [workspaces] },
    proxy: {
      '/api': { target, changeOrigin: true },
      '/arena/share': { target, changeOrigin: true },
      '/benchmarks': { target, changeOrigin: true, xfwd: true },
      '/leaderboard': { target, changeOrigin: true, xfwd: true },
      '/commanders': { target, changeOrigin: true, xfwd: true },
      // xfwd: the server sees X-Forwarded-Host (changeOrigin rewrites Host), so OAuth metadata names this origin.
      '/mcp': { target, changeOrigin: true, xfwd: true },
      '/playerthree': { target, changeOrigin: true },
      // MCP authorization (OAuth 2.1): authorization server endpoints and their metadata documents.
      '/oauth': { target, changeOrigin: true, xfwd: true },
      '/.well-known': { target, changeOrigin: true, xfwd: true },
      // Colyseus matchmaking (HTTP) and room websockets; the SDK is pointed at `/colyseus` in dev.
      '/colyseus': { target, changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/colyseus/, '') || '/' },
    },
  },
  preview: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/arena/share': { target, changeOrigin: true },
      '/benchmarks': { target, changeOrigin: true, xfwd: true },
      '/mcp': { target, changeOrigin: true, xfwd: true },
      '/playerthree': { target, changeOrigin: true },
      '/oauth': { target, changeOrigin: true, xfwd: true },
      '/.well-known': { target, changeOrigin: true, xfwd: true },
      '/colyseus': { target, changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/colyseus/, '') || '/' },
    },
  },
  build: {
    target: 'es2023', chunkSizeWarningLimit: 1500, manifest: true,
    rolldownOptions: { input: { game: fileURLToPath(new URL('./index.html', import.meta.url)), benchmarks: BENCHMARKS, ladder: LADDER } },
  },
  define: { __AC_RELEASE__: JSON.stringify(release()) },
  plugins: [homeMenu()],
});
