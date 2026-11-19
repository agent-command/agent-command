import { createHash } from 'node:crypto';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/app.ts';
import { start, webDist } from './helpers.ts';

let server: GameServer;
let base: string;
const root = webDist();
const origin = 'https://public.example';
const request = (path: string, method = 'GET', headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method, redirect: 'manual', headers: { 'x-forwarded-host': 'public.example', 'user-agent': 'Discordbot/2.0', ...headers },
});
const value = (html: string, name: string) => new RegExp(`<meta (?:name|property)="${name}" content="([^"]+)"`).exec(html)?.[1];

beforeAll(async () => {
  cpSync(new URL('../../web/public/social', import.meta.url), join(root, 'social'), { recursive: true });
  ({ server, base } = await start({ webDist: root, publicUrl: new URL(origin) }));
});
afterAll(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });

describe('public crawler and social responses', () => {
  it('delivers one truthful home identity, structured data and readable game content without JavaScript', async () => {
    const page = await request('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-robots-tag')).toBeNull();
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('strict-transport-security')).toContain('max-age=31536000');
    const html = await page.text();
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain(`rel="canonical" href="${origin}/"`);
    expect(html).not.toContain('https://agentcommand.gg');
    for (const name of ['description', 'robots', 'og:type', 'og:url', 'og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:title', 'twitter:image']) {
      expect(html.match(new RegExp(`(?:name|property)="${name}"`, 'g')), name).toHaveLength(1);
    }
    expect(value(html, 'robots')).toBe('index,follow,max-image-preview:large');
    expect(value(html, 'twitter:card')).toBe('summary_large_image');
    expect(value(html, 'og:url')).toBe(`${origin}/`);
    expect(value(html, 'og:image')).toBe(value(html, 'twitter:image'));
    expect(value(html, 'og:image:alt')).toBeTruthy();
    expect(value(html, 'twitter:image:alt')).toBe(value(html, 'og:image:alt'));
    expect(html).toContain('Surface, Depths, Sky and Orbit');
    expect(html).toContain('<summary>About Agent Command</summary>');
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const data = JSON.parse(scripts[0]![1]!);
    expect(data).toMatchObject({ '@type': 'VideoGame', name: 'Agent Command', url: `${origin}/`, gamePlatform: 'Web browser' });
    for (const field of ['aggregateRating', 'review', 'offers', 'award']) expect(data[field]).toBeUndefined();
    const hash = createHash('sha256').update(scripts[0]![1]!).digest('base64');
    expect(page.headers.get('content-security-policy')).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(page.headers.get('content-security-policy')).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    const image = await request(new URL(value(html, 'og:image')!).pathname);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe(value(html, 'og:image:type'));
    expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(image.headers.get('x-robots-tag')).toBeNull();
    expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({ width: 1200, height: 630, format: 'jpeg' });
    expect(value(html, 'og:image:width')).toBe('1200');
    expect(value(html, 'og:image:height')).toBe('630');
  });

  it('advertises public home and benchmark pages without inventing dates or private URLs', async () => {
    const robots = await request('/robots.txt');
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(robots.headers.get('cache-control')).toBe('no-cache');
    const text = await robots.text();
    expect(text).toContain(`Sitemap: ${origin}/sitemap.xml`);
    expect(text).toContain('Disallow: /connect');
    expect(text).not.toContain('Disallow: /arena/share');
    const sitemap = await request('/sitemap.xml');
    expect(sitemap.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xml = await sitemap.text();
    expect(xml).toContain(`<loc>${origin}/</loc>`);
    expect(xml).toContain(`<loc>${origin}/benchmarks/</loc>`);
    expect(xml).toContain(`<loc>${origin}/benchmarks/methodology/</loc>`);
    expect(xml).not.toMatch(/lastmod|changefreq|priority|token|series|profile/);
  });

  it.each(['/connect?r=private-request', '/?screen=commanders', '/?screen=game', '/?watch=live', '/?map=ridges&mapSeed=4409', '/?token=do-not-reflect'])('keeps private or parameterized screens out of search: %s', async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await response.text();
    expect(value(html, 'robots')).toBe('noindex,nofollow,noarchive');
    expect(html).not.toMatch(/rel="canonical"|application\/ld\+json|property="og:|name="twitter:|private-request|do-not-reflect/);
  });

  it.each(['/not-a-page', '/profile', '/series', '/play/anything', '/assets/missing.js', '/arena/share/invalid', '/api/missing'])('returns an actual non-indexable 404: %s', async path => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-type')).not.toContain('text/html');
  });

  it('canonicalizes the legacy shell URL and never reflects hostile host headers', async () => {
    const index = await request('/index.html?screen=lobby');
    expect(index.status).toBe(308);
    expect(index.headers.get('location')).toBe(`${origin}/?screen=lobby`);
    const hostile = await request('/', 'GET', { 'x-forwarded-host': 'evil.example' });
    expect(hostile.status).toBe(302);
    expect(hostile.headers.get('location')).toBe(`${origin}/`);
    const sitemap = await request('/sitemap.xml', 'GET', { host: 'evil.example', 'x-forwarded-host': 'evil.example' });
    expect(await sitemap.text()).not.toContain('evil.example');
  });

  it.each(['/', '/connect', '/robots.txt', '/sitemap.xml'])('supports matching HEAD responses and refuses page mutations: %s', async path => {
    const get = await request(path);
    const head = await request(path, 'HEAD');
    expect(head.status).toBe(200);
    for (const name of ['content-type', 'content-length', 'cache-control', 'content-security-policy', 'x-robots-tag']) expect(head.headers.get(name)).toBe(get.headers.get(name));
    expect(await head.text()).toBe('');
    const post = await request(path, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});
