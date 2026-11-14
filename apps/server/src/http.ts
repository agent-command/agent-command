/** Small HTTP helpers: security headers, CORS, bounded JSON bodies, static files, rate limits. */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { extname, join, normalize, sep } from 'node:path';
import type { ServerConfig } from './config.ts';

/** CSP for the web client. Inline styles are allowed for web-component shadow roots; scripts are same-origin only. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * CSP for every other response (JSON, errors, SSE, assets): nothing may load or run if one is opened as a document
 * (e.g. an error page or a static SVG). HTML responses replace it with their own policy.
 */
const RESOURCE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function securityHeaders(res: ServerResponse, config: ServerConfig): void {
  res.setHeader('Content-Security-Policy', RESOURCE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (config.publicUrl?.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Origins allowed to make cross-origin API calls: PUBLIC_URL's origin + CORS_ORIGINS. Same-origin always passes. */
export function originAllowed(req: Pick<IncomingMessage, 'headers'>, config: ServerConfig): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (config.publicUrl && origin === config.publicUrl.origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  const host = req.headers.host;
  return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
}

/** Adds CORS headers for allowed cross-origin callers. Returns true if the request was a preflight (answered). */
export function cors(req: IncomingMessage, res: ServerResponse, config: ServerConfig): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method !== 'OPTIONS') return false;
  if (origin !== undefined && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  res.writeHead(204).end();
  return true;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json);
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Developer-written explanation sent as `detail` (never echoes request input). */
  readonly detail: string | undefined;
  constructor(status: number, code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Reads a JSON body of at most `maxBytes`. Throws HttpError 413/415/400. */
export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new HttpError(415, 'unsupported_media_type');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      throw new HttpError(413, 'too_large');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

/** Cluster mode: original client addresses of requests that arrived on the secret-authenticated internal listener. */
const forwardedClients = new WeakMap<IncomingMessage, string>();

/** Only the cluster's internal listener calls this, after checking the cluster secret. */
export function trustForwardedClient(req: IncomingMessage, ip: string): void {
  forwardedClients.set(req, ip);
}

/** The original client address when another cluster node forwarded this request, else undefined. */
export function forwardedClient(req: IncomingMessage): string | undefined {
  return forwardedClients.get(req);
}

export function clientIp(req: IncomingMessage, config: ServerConfig): string {
  const forwarded = forwardedClients.get(req);
  if (forwarded !== undefined) return forwarded;
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const last = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Hand an HTTP upgrade to another listener as raw TCP: replay the request line with `headers`, then pipe both
 * directions. The upstream answers the handshake itself. Returns the upstream socket (the caller may track it).
 */
export function pipeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: { host: string; port: number }, headers: IncomingHttpHeaders): Socket {
  const upstream = connect({ port: target.port, host: target.host, noDelay: true });
  socket.pause();
  upstream.once('connect', () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(headers).flatMap(([key, value]) =>
      value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((entry) => `${key}: ${entry}\r\n`)).join('')}\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
    socket.resume();
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.once('close', () => upstream.destroy());
  upstream.once('close', () => socket.destroy());
  return upstream;
}

/** Fixed-window counter per key. */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  readonly #sweep: NodeJS.Timeout;

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#sweep = setInterval(() => {
      const now = Date.now();
      for (const [key, hit] of this.#hits) if (hit.resetAt <= now) this.#hits.delete(key);
    }, Math.max(windowMs, 10_000));
    this.#sweep.unref();
  }

  /** Counts a hit. Returns 0 if allowed, else seconds until the window resets. */
  take(key: string, now = Date.now()): number {
    let hit = this.#hits.get(key);
    if (!hit || hit.resetAt <= now) {
      hit = { count: 0, resetAt: now + this.#windowMs };
      this.#hits.set(key, hit);
    }
    if (hit.count >= this.#limit) return Math.ceil((hit.resetAt - now) / 1000);
    hit.count++;
    return 0;
  }

  close(): void {
    clearInterval(this.#sweep);
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.ogg': 'audio/ogg',
};

/** Proxied by the Vite dev server with `changeOrigin`: never a page, so never redirected (a redirect would loop). */
const PROXIED = ['/api/', '/matchmake/', '/mcp', '/oauth', '/.well-known/', '/playerthree', '/colyseus'];

/**
 * PUBLIC_URL set and a page (extension-less SPA route or .html) requested on another host: redirect there.
 * Profiles live in per-origin browser storage and agent sign-in completes on PUBLIC_URL, so a page opened on a second
 * address (e.g. the server's own port in dev) would hold a different profile and never see its agents.
 * The fragment (match links) survives: browsers re-apply it when the Location has none.
 */
export function redirectToCanonical(req: IncomingMessage, res: ServerResponse, url: URL, config: ServerConfig): boolean {
  const canonical = config.publicUrl;
  if (!canonical || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  if (PROXIED.some((p) => url.pathname.startsWith(p))) return false;
  const ext = extname(url.pathname);
  if (ext !== '' && ext !== '.html') return false;
  const forwarded = req.headers['x-forwarded-host'];
  if (req.headers.host === canonical.host || forwarded === canonical.host) return false;
  res.writeHead(302, { Location: `${canonical.origin}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

const COMPRESSIBLE: Record<string, true> = { '.html': true, '.js': true, '.css': true, '.json': true, '.svg': true, '.txt': true, '.wasm': true };
const HASHED_ASSET = /^(?:assets|social)\/[^/]+-[A-Za-z0-9_-]{6,}\.[^/.]+$/;

/** Explicit encodings override the wildcard, including an explicit refusal (q=0). */
function encodingQualities(header: string | undefined): Map<string, number> {
  const qualities = new Map<string, number>();
  for (const entry of (header ?? '').split(',')) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [key, value] = parameter.trim().split(/\s*=\s*/);
      if (key !== 'q') continue;
      quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value ?? '') ? Number(value) : 0;
    }
    qualities.set(name.trim(), quality);
  }
  return qualities;
}

function varyAcceptEncoding(res: ServerResponse): void {
  const current = res.getHeader('Vary');
  const value = Array.isArray(current) ? current.join(', ') : String(current ?? '');
  if (value.split(',').some((part) => /^(?:accept-encoding|\*)$/i.test(part.trim()))) return;
  res.setHeader('Vary', value ? `${value}, Accept-Encoding` : 'Accept-Encoding');
}

/**
 * Serves existing files under `root` for GET/HEAD. Page routes are handled explicitly, never a catch-all soft 404.
 * Build-time .br/.gz sidecars are negotiated, never exposed as request paths. HTML is never cached.
 * Returns false if nothing was served (caller answers 404).
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, root: string): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let rel: string;
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.split(/[/\\]/).some((part) => part.startsWith('.') || /\.(?:br|gz)$/i.test(part))) return false;
    rel = normalize(decoded).replace(/^([/\\])+/, '');
  } catch {
    return false;
  }
  let file = join(root, rel || 'index.html');
  if (file !== root && !file.startsWith(root + sep)) return false;
  let info = await stat(file).catch(() => undefined);
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await stat(file).catch(() => undefined);
  }
  if (!info?.isFile()) return false;
  const ext = extname(file);
  if (ext !== '.html') res.removeHeader('X-Robots-Tag');
  varyAcceptEncoding(res);
  const qualities = encodingQualities(req.headers['accept-encoding']);
  const wildcard = qualities.get('*') ?? 0;
  const identity = qualities.get('identity');
  let encoding: 'br' | 'gzip' | undefined;
  let selectedInfo = info;
  // An omitted identity preference is a fallback, not a preference over requested compression.
  let quality = identity ?? 0;
  if (Object.hasOwn(COMPRESSIBLE, ext)) {
    for (const candidate of ['br', 'gzip'] as const) {
      const candidateQuality = qualities.get(candidate) ?? wildcard;
      if (candidateQuality <= 0 || candidateQuality < quality || (candidateQuality === quality && encoding)) continue;
      const sidecar = `${file}.${candidate === 'gzip' ? 'gz' : 'br'}`;
      const sidecarInfo = await stat(sidecar).catch(() => undefined);
      if (!sidecarInfo?.isFile()) continue;
      // Keep `file` pointing at the original until negotiation has considered both sidecars.
      encoding = candidate;
      quality = candidateQuality;
      selectedInfo = sidecarInfo;
    }
  }
  if (!encoding && (identity === 0 || (identity === undefined && qualities.get('*') === 0))) {
    res.writeHead(406, { 'Cache-Control': 'no-store', 'Content-Length': 0 }).end();
    return true;
  }
  if (encoding) {
    file += encoding === 'gzip' ? '.gz' : '.br';
    info = selectedInfo;
  }
  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': ext === '.html' ? 'no-store' : HASHED_ASSET.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (ext === '.html') headers['Content-Security-Policy'] = PAGE_CSP;
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}
