/** Home and explicitly released benchmark documents are crawlable; gameplay and bearer shares are not. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { ServerConfig } from './config.ts';
import { PAGE_CSP } from './http.ts';

const PUBLIC_ORIGIN = 'https://agentcommand.gg';
const HOME_METADATA = /<!-- public-page-meta:start -->[\s\S]*?<!-- public-page-meta:end -->/;

/** Replace the entire page identity, not individual tags: unlisted shares must never inherit home metadata. */
export function replacePublicMetadata(shell: string, metadata: string): string {
  if (!HOME_METADATA.test(shell)) throw new Error('Web shell is missing its public page metadata boundary');
  return shell.replace(HOME_METADATA, () => metadata);
}

export function createPublicPages(config: ServerConfig, benchmarkPaths: () => Promise<string[]> = async () => []) {
  // Configuration only; Host and forwarded headers never supply metadata or sitemap URLs.
  const origin = config.publicUrl?.origin ?? PUBLIC_ORIGIN;
  const canonical = `${origin}/`;
  let pages: Promise<{ home: string; private: string; csp: string }> | undefined;
  const load = () => pages ??= readFile(join(config.webDist, 'index.html'), 'utf8').then(shell => {
    const metadata = HOME_METADATA.exec(shell)?.[0];
    if (!metadata) throw new Error('Web shell is missing its public page metadata boundary');
    const home = replacePublicMetadata(shell, metadata.replaceAll(PUBLIC_ORIGIN, origin));
    const structured = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(home)?.[1];
    if (!structured) throw new Error('Web shell is missing its game structured data');
    const hash = createHash('sha256').update(structured).digest('base64');
    return {
      home,
      private: replacePublicMetadata(shell, '<title>Agent Command</title><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">'),
      csp: PAGE_CSP.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`),
    };
  });
  const robots = `User-agent: *\nAllow: /\nDisallow: /connect\nDisallow: /api/\nDisallow: /oauth\nDisallow: /mcp\nDisallow: /playerthree\nDisallow: /matchmake/\nDisallow: /colyseus\nDisallow: /dev\nDisallow: /*?\n\nSitemap: ${origin}/sitemap.xml\n`;

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (!['/', '/index.html', '/connect', '/robots.txt', '/sitemap.xml'].includes(path)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }).end();
      return true;
    }
    if (path === '/index.html') {
      res.writeHead(308, { Location: `${canonical}${url.search}`, 'Cache-Control': 'no-store' }).end();
      return true;
    }
    let body: string;
    if (path === '/robots.txt' || path === '/sitemap.xml') {
      const paths = path === '/sitemap.xml' ? ['/', ...await benchmarkPaths()] : [];
      const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
      body = path === '/robots.txt' ? robots : `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...new Set(paths)].map(p => `<url><loc>${xml(origin + p)}</loc></url>`).join('')}</urlset>\n`;
      res.setHeader('Content-Type', path === '/robots.txt' ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      const rendered = await load();
      const isHome = path === '/' && !url.search;
      body = isHome ? rendered.home : rendered.private;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', isHome ? rendered.csp : PAGE_CSP);
      res.setHeader('Cache-Control', isHome ? 'no-store' : 'private, no-store');
      if (isHome) res.removeHeader('X-Robots-Tag');
      else res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.writeHead(200).end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
