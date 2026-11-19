import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { cors, securityHeaders, serveStatic } from '../src/http.ts';

const ORIGIN = 'https://client.example';
const APP = '/assets/app-Ab_123-X.js';
const fixtures = new Map<string, { identity: Buffer; br: Buffer; gzip: Buffer }>();
let root: string;
let server: Server;
let port: number;

async function fixture(path: string, encodings: readonly ('br' | 'gzip')[] = ['br', 'gzip']): Promise<void> {
  const identity = Buffer.from(path.endsWith('.html') ? '<!doctype html><title>Agent Command</title>' : `fixture ${path}\n`.repeat(20));
  const data = { identity, br: brotliCompressSync(identity), gzip: gzipSync(identity) };
  fixtures.set(path, data);
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, identity);
  for (const encoding of encodings) await writeFile(`${file}.${encoding === 'gzip' ? 'gz' : 'br'}`, data[encoding]);
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** node:http leaves the encoded bytes and request path untouched (unlike fetch). */
function get(path: string, encoding?: string, method = 'GET', headers: Record<string, string> = {}): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const req = request({
    host: '127.0.0.1', port, path, method,
    headers: { ...(encoding === undefined ? {} : { 'Accept-Encoding': encoding }), ...headers },
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
  return promise;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ac-static-'));
  await fixture('/index.html');
  await fixture(APP);
  await fixture('/assets/gzip-only-abc123.js', ['gzip']);
  await fixture('/assets/br-only-abc123.js', ['br']);
  await fixture('/assets/plain-abc123.js', []);
  await fixture('/assets/sidecar-dir-abc123.js', ['gzip']);
  await mkdir(join(root, 'assets/sidecar-dir-abc123.js.br'));
  await fixture('/assets/unhashed.js');
  await fixture('/assets/short-abc12.js');
  await fixture('/assets/invalid-abc+123.js');
  await fixture('/assets/page-abc123.html');
  await fixture('/assets/nested/index.html');
  await fixture('/assets/nested/app-abc123.js');
  await fixture('/app-abc123.js');
  await fixture('/images/logo-abc123.png');
  for (const ext of ['css', 'json', 'svg', 'txt', 'wasm']) await fixture(`/assets/file-abc123.${ext}`);
  await fixture('/benchmarks/clips/release/model.mp4', []);
  await writeFile(join(root, 'assets/orphan-abc123.js.br'), 'orphan sidecar');
  await writeFile(join(root, '.env'), 'secret');
  const config = loadConfig({ CORS_ORIGINS: ORIGIN });
  server = createServer((req, res) => {
    securityHeaders(res, config);
    if (cors(req, res, config)) return;
    void serveStatic(req, res, req.url!.split('?')[0]!, root).then((served) => {
      if (!served) res.writeHead(404).end();
    }).catch(() => res.destroy());
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP listener');
  port = address.port;
});

afterAll(async () => {
  if (server) {
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe('precompressed representation negotiation', () => {
  it.each([
    ['br, gzip', 'br'],
    ['gzip, br', 'br'],
    ['br;q=0.3, gzip;q=0.9', 'gzip'],
    ['gzip;q=0.2, br;q=0.8', 'br'],
    ['gzip;q=0.7, br;q=0.7', 'br'],
    ['BR; Q=0.7, GZIP; q=0.8', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['br, gzip;q=0', 'br'],
    ['*', 'br'],
    ['*;q=0.8, br;q=0', 'gzip'],
    ['*;q=0, gzip;q=0.5', 'gzip'],
    ['identity;q=0, br', 'br'],
    ['identity;q=0.2, gzip;q=0.8', 'gzip'],
    ['identity;q=0.8, br;q=0.8', 'br'],
  ])('selects %s as %s', async (accept, selected) => {
    const res = await get(APP, accept);
    const expected = fixtures.get(APP)![selected as 'br' | 'gzip'];
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe(selected);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['content-length']).toBe(String(expected.length));
    expect(res.body).toEqual(expected);
  });

  it.each([
    undefined,
    '',
    'identity',
    'deflate',
    'br;q=0, gzip;q=0',
    'br;q=invalid, gzip;q=0',
    'br;q=1.5, gzip;q=0',
    'identity;q=1, br;q=0.5, gzip;q=0.8',
    '*;q=0, identity;q=1',
  ])('uses identity for %s', async (accept) => {
    const res = await get(APP, accept);
    const expected = fixtures.get(APP)!.identity;
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['content-length']).toBe(String(expected.length));
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.body).toEqual(expected);
  });

  it.each([
    ['/assets/gzip-only-abc123.js', 'br, gzip;q=0.2', 'gzip'],
    ['/assets/br-only-abc123.js', 'gzip, br;q=0.2', 'br'],
    ['/assets/sidecar-dir-abc123.js', 'br, gzip;q=0.2', 'gzip'],
    ['/assets/plain-abc123.js', 'br, gzip', undefined],
    ['/assets/br-only-abc123.js', 'gzip', undefined],
  ] as const)('negotiates only existing files for %s', async (path, accept, selected) => {
    const res = await get(path, accept);
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe(selected);
    const representation = selected === 'br' ? 'br' : selected === 'gzip' ? 'gzip' : 'identity';
    expect(res.body).toEqual(fixtures.get(path)![representation]);
  });

  it.each([
    [APP, 'br;q=0, gzip;q=0, identity;q=0'],
    [APP, '*;q=0'],
    [APP, 'deflate, identity;q=0'],
    ['/assets/plain-abc123.js', 'br, identity;q=0'],
    ['/assets/br-only-abc123.js', 'gzip, identity;q=0'],
  ])('returns 406 when no available representation is acceptable: %s %s', async (path, accept) => {
    for (const method of ['GET', 'HEAD']) {
      const res = await get(path, accept, method);
      expect(res.status).toBe(406);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-length']).toBe('0');
      expect(res.headers.vary).toBe('Accept-Encoding');
      expect(res.body.length).toBe(0);
    }
  });

  it.each(['br', 'gzip', 'identity'])('HEAD has the same representation headers as GET for %s', async (accept) => {
    const getRes = await get(APP, accept);
    const headRes = await get(APP, accept, 'HEAD');
    expect(headRes.status).toBe(200);
    for (const header of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'vary']) {
      expect(headRes.headers[header]).toBe(getRes.headers[header]);
    }
    expect(headRes.body.length).toBe(0);
  });

  it.each([
    ['css', 'text/css; charset=utf-8'],
    ['json', 'application/json; charset=utf-8'],
    ['svg', 'image/svg+xml'],
    ['txt', 'text/plain; charset=utf-8'],
    ['wasm', 'application/wasm'],
  ])('keeps the original MIME type for compressed .%s', async (ext, type) => {
    const res = await get(`/assets/file-abc123.${ext}`, 'br');
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['content-type']).toBe(type);
  });

  it('does not select sidecars for non-compressible assets', async () => {
    const res = await get('/images/logo-abc123.png', 'br, gzip');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(fixtures.get('/images/logo-abc123.png')!.identity);
  });
});

describe('static cache and security semantics', () => {
  it('appends Accept-Encoding to the existing CORS Vary without losing Origin', async () => {
    for (const accept of ['br', 'identity', '*;q=0']) {
      const res = await get(APP, accept, 'GET', { Origin: ORIGIN });
      expect(res.headers.vary).toBe('Origin, Accept-Encoding');
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    }
  });

  it.each(['/', '/index.html', '/assets/page-abc123.html', '/assets/nested/'])('HTML at %s is never cached and carries CSP', async (path) => {
    for (const accept of ['br', 'gzip', 'identity']) {
      const res = await get(path, accept);
      const head = await get(path, accept, 'HEAD');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      for (const header of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'content-security-policy', 'vary']) {
        expect(head.headers[header]).toBe(res.headers[header]);
      }
      expect(head.body.length).toBe(0);
    }
  });

  it.each([APP, '/assets/file-abc123.css', '/assets/file-abc123.wasm'])('gives immutable caching only to hashed /assets files: %s', async (path) => {
    for (const accept of ['br', 'gzip', 'identity']) {
      const res = await get(path, accept);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
  });

  it.each(['/assets/unhashed.js', '/assets/short-abc12.js', '/assets/invalid-abc+123.js', '/app-abc123.js', '/assets/nested/app-abc123.js'])('revalidates nonmatching asset paths: %s', async (path) => {
    expect((await get(path, 'br')).headers['cache-control']).toBe('no-cache');
  });

  it.each([
    '/play/anything',
    '/not-a-real-page',
    '/assets/app-Ab_123-X.js.br',
    '/assets/app-Ab_123-X.js.gz',
    '/assets/app-Ab_123-X.js%2ebr',
    '/assets/app-Ab_123-X.js.br/route',
    '/assets/orphan-abc123.js',
    '/assets/orphan-abc123.js.br',
    '/index.html.br',
    '/index.html.gz',
    '/missing.js',
    '/missing.html',
    '/.env',
    '/%2eenv',
    '/../index.html',
    '/%2e%2e/index.html',
    '/assets/%2e%2e/index.html',
    '/assets/%2e%2e%5cindex.html',
    '/..%2f..%2f..%2fetc%2fpasswd',
    '/assets/..%5c..%5c.env',
    '/assets%2f%2e%2e%2f.env',
    '/index.html%00.js',
    '/%2e%2e%2f%2e%2e%2fetc/passwd.txt',
    '/%E0%A4%A',
  ])('rejects sidecar, traversal, hidden, malformed and missing-file paths: %s', async (path) => {
    for (const method of ['GET', 'HEAD']) {
      const res = await get(path, 'br, gzip', method);
      expect(res.status).toBe(404);
      expect(res.body.length).toBe(0);
      expect(res.headers['content-encoding']).toBeUndefined();
    }
  });

  it('does not serve static files for non-GET/HEAD methods', async () => {
    expect((await get(APP, 'br', 'POST')).status).toBe(404);
  });

  it.each([APP, '/assets/file-abc123.svg', '/assets/file-abc123.json'])('non-HTML responses keep the load-nothing CSP: %s', async (path) => {
    const res = await get(path, 'identity');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  });

  it('serves MP4 clips in byte ranges, whole without a Range header', async () => {
    const clip = '/benchmarks/clips/release/model.mp4';
    const bytes = fixtures.get(clip)!.identity;
    const whole = await get(clip, 'identity');
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.body.equals(bytes)).toBe(true);
    const part = await get(clip, 'identity', 'GET', { Range: 'bytes=10-19' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${bytes.length}`);
    expect(part.body.equals(bytes.subarray(10, 20))).toBe(true);
    const tail = await get(clip, 'identity', 'GET', { Range: 'bytes=-5' });
    expect(tail.status).toBe(206);
    expect(tail.body.equals(bytes.subarray(-5))).toBe(true);
    const open = await get(clip, 'identity', 'GET', { Range: `bytes=${bytes.length - 3}-` });
    expect(open.body.equals(bytes.subarray(-3))).toBe(true);
    const beyond = await get(clip, 'identity', 'GET', { Range: `bytes=${bytes.length}-` });
    expect(beyond.status).toBe(416);
    expect(beyond.headers['content-range']).toBe(`bytes */${bytes.length}`);
  });
});
