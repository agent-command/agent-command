import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { PAGE_CSP, securityHeaders } from '../src/http.ts';
import type { Room } from '@colyseus/sdk';
import { json, lobbyHandoff, start, until, type Conn, type Handoff } from './helpers.ts';

const EVIL = 'https://evil.example';
const RESOURCE_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe('production configuration', () => {
  it('refuses the dev-admin API and the unauthenticated operator console with NODE_ENV=production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AC_DEV_ADMIN_TOKEN: 'a'.repeat(32) })).toThrow(/development only/);
    expect(loadConfig({ NODE_ENV: 'production' })).toMatchObject({ devtools: false, trustProxy: false });
    expect(loadConfig({ NODE_ENV: 'production' }).devAdminToken).toBeUndefined();
    expect(loadConfig({ NODE_ENV: 'production', OPERATOR_TOKEN: 'o'.repeat(32), PLAYERTHREE_DEVTOOLS: '0' }).devtools).toBe(false);
    // X-Forwarded-For is trusted only on the exact opt-in.
    for (const value of ['true', 'yes', '2', '']) expect(loadConfig({ TRUST_PROXY: value }).trustProxy).toBe(false);
  });

  it('the production image runs with NODE_ENV=production and the operator console off', () => {
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    const env = /^ENV (.+)$/m.exec(dockerfile)?.[1] ?? '';
    expect(env).toContain('NODE_ENV=production');
    expect(env).toContain('PLAYERTHREE_DEVTOOLS=0');
    expect(dockerfile).not.toMatch(/AC_DEV_ADMIN_TOKEN/);
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it('sends HSTS only for an https PUBLIC_URL', () => {
    const sent = (env: Record<string, string>) => {
      const headers = new Map<string, string>();
      securityHeaders({ setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value) } as never, loadConfig(env));
      return headers.get('strict-transport-security');
    };
    expect(sent({ PUBLIC_URL: 'https://play.example' })).toBe('max-age=31536000; includeSubDomains');
    expect(sent({ PUBLIC_URL: 'http://localhost:5173' })).toBeUndefined();
    expect(sent({})).toBeUndefined();
  });
});

describe('HTTP edge (direct clients, TRUST_PROXY unset)', () => {
  let server: GameServer;
  let base: string;
  beforeAll(async () => {
    ({ server, base } = await start({ trustProxy: false, joinsPerIpPerMin: 3 }));
  });
  afterAll(() => server.close());

  function expectHardened(res: Response, csp: string) {
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(res.headers.get('content-security-policy')).toBe(csp);
    // HSTS only for an https PUBLIC_URL.
    expect(res.headers.get('strict-transport-security')).toBeNull();
  }

  it('every response carries the security headers; only HTML gets the page CSP, everything else loads nothing', async () => {
    const post = (path: string, body: string, type = 'application/json') =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': type }, body });
    const cases: [Promise<Response>, number][] = [
      [fetch(`${base}/play/anything`), 404],
      [fetch(`${base}/api/nope`), 404],
      [fetch(`${base}/api/maps`), 200],
      [fetch(`${base}/healthz`), 200],
      [fetch(`${base}/dev/matches`), 404],
      [fetch(`${base}/missing.js`), 404],
      [fetch(`${base}/assets/app-abc123.js`), 200],
      [post('/api/profile', 'x'.repeat(4096)), 413],
      [post('/api/profile', '{}', 'text/plain'), 415],
      [post('/api/profile', '{nope'), 400],
      [fetch(`${base}/api/maps`, { method: 'DELETE' }), 405],
    ];
    for (const [pending, status] of cases) {
      const res = await pending;
      expect(res.status, res.url).toBe(status);
      expectHardened(res, RESOURCE_CSP);
      const body = await res.text();
      // Error bodies are closed codes: no stack traces or server paths.
      if (status >= 400 && body) expect(Object.keys(JSON.parse(body) as object).every((key) => key === 'error' || key === 'detail')).toBe(true);
      expect(body).not.toMatch(/\bat \S+ \(|\/home\/|node:internal|\.ts:\d+/);
    }
    for (const path of ['/connect', '/?screen=commanders']) {
      const page = await fetch(`${base}${path}`);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expectHardened(page, PAGE_CSP);
    }
  });

  it('ignores a spoofed X-Forwarded-For when TRUST_PROXY is unset', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/matchmake/joinById/no-such-room`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` }, body: '{}',
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([404, 404, 404, 429]);
  });

  it('refuses cross-origin matchmaking before any lookup', async () => {
    const res = await fetch(`${base}/matchmake/joinById/no-such-room`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: EVIL }, body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'forbidden_origin' });
  });
});

describe('worker-hosted matches behind the main HTTP edge', () => {
  let server: GameServer;
  let base: string;
  let ticket: Handoff & { lobby: Room; connections: Conn[] };
  beforeAll(async () => {
    ({ server, base } = await start({ simWorkers: 1, matchesPerWorker: 1, maxMatches: 2, mainMaxMatches: 1, admissionLagMs: 25 }));
    ticket = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
  }, 30_000);
  afterAll(async () => {
    for (const connection of ticket?.connections ?? []) await connection.room.leave(true);
    await ticket?.lobby.leave(true);
    await server.close();
  }, 30_000);

  it('the match runs on the worker, and its seat tickets say commanders cannot join it mid-match', () => {
    // Not in the main host: every request below is the pool's forwarding path.
    expect(server.host.authenticate(ticket.tickets[0]!.token)).toBeUndefined();
    expect(ticket.agentHandOver).toBe(false);
  });

  it('refuses a cross-origin seat reservation for a worker room', async () => {
    const reserve = (headers: Record<string, string>) => fetch(`${base}/matchmake/joinById/${ticket.roomId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token: ticket.tickets[0]!.token }),
    });
    const evil = await reserve({ origin: EVIL });
    expect(evil.status).toBe(403);
    expect(await json(evil)).toEqual({ error: 'forbidden_origin' });
    expect((await reserve({})).status).toBe(200);
  });

  it('caps concurrent player-console streams per client IP, forwarded ones included', async () => {
    const aborts: AbortController[] = [];
    const open = async () => {
      const abort = new AbortController();
      aborts.push(abort);
      return fetch(`${base}/playerthree/player/stream`, { headers: { authorization: `Bearer ${ticket.tickets[0]!.token}` }, signal: abort.signal });
    };
    try {
      for (let i = 0; i < 8; i++) expect((await open()).status).toBe(200);
      const refused = await open();
      expect(refused.status).toBe(429);
      expect(await json(refused)).toEqual({ error: 'stream_capacity' });
      aborts[0]!.abort();
      // The slot frees when that stream's response closes (a network event the helper polls for).
      expect(await until(async () => (await open()).status === 200)).toBe(true);
    } finally {
      for (const abort of aborts) abort.abort();
    }
  });

  it('publishes worker load as counts, never room ids', async () => {
    const capacity = await json<{ workers: { active: number; rooms?: unknown }[] }>(await fetch(`${base}/api/capacity`));
    expect(capacity.workers[0]).toMatchObject({ active: 1 });
    expect(capacity.workers[0]!.rooms).toBeUndefined();
    expect(JSON.stringify(capacity)).not.toContain(ticket.roomId);
  });
});
