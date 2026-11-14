/**
 * A rated (official) test server: PGlite Postgres with every migration, an Ed25519 results key, a fake GitHub OAuth
 * provider and short ready/lock windows. Real HTTP and WebSocket transports, like production.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { openPostgresStorage, type PostgresStorage } from 'playerthree/postgres';
import { parseResultsSigner, resultsPublicKey } from 'playerthree/results';
import { PLANES } from '@agent-command/game';
import { loadConfig, type RatedConfig, type ServerConfig } from '../src/config.ts';
import { createGameServer, type GameServer } from '../src/app.ts';
import { freshIp, json, webDist } from './helpers.ts';
import type { RosterResponse } from '../src/roster.ts';

export interface FakeGithub {
  url: string;
  /** GitHub users by the next authorization code. */
  users: Map<string, { id: number; login: string; created_at: string }>;
  /** The PKCE challenge each authorize URL carried, by state. */
  challenges: Map<string, string>;
  close(): Promise<void>;
}

/** Fake GitHub OAuth (authorize is a URL the test reads; token checks the PKCE verifier; /user returns the user). */
export async function fakeGithub(): Promise<FakeGithub> {
  const users = new Map<string, { id: number; login: string; created_at: string }>();
  const challenges = new Map<string, string>();
  const tokens = new Map<string, { id: number; login: string; created_at: string }>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://github.test');
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const { code, code_verifier: verifier } = JSON.parse(body) as { code: string; code_verifier: string };
        const user = users.get(code);
        const challenge = [...challenges.values()].includes(createHash('sha256').update(verifier).digest('base64url'));
        if (!user || !challenge) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad_verification_code' })); return; }
        const token = `gho_${code}`;
        tokens.set(token, user);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: token, token_type: 'bearer' }));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/user') {
      const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      res.writeHead(user ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(user ?? { message: 'Bad credentials' }));
      return;
    }
    res.writeHead(404).end();
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = (): Promise<void> => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  };
  return { url, users, challenges, close };
}

export interface RankedServer {
  server: GameServer;
  base: string;
  storage: PostgresStorage;
  github: FakeGithub;
  rated: RatedConfig;
  close(): Promise<void>;
}

/** A fresh in-process Postgres per server; PGlite is single-session, so the pool uses one connection. */
async function database(): Promise<{ url: string; close(): Promise<void> }> {
  const db = await PGlite.create();
  const socket = new PGLiteSocketServer({ db, port: 0, maxConnections: 2 });
  await socket.start();
  return { url: `postgres://postgres@${socket.getServerConn()}/postgres`, async close() { await socket.stop(); await db.close(); } };
}

/** Kept for symmetry with suites that share one database; each server owns its own. */
export async function closeDatabase(): Promise<void> {}

export async function startRanked(overrides: Partial<RatedConfig> = {}, config: Partial<ServerConfig> = {}): Promise<RankedServer> {
  const github = await fakeGithub();
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = parseResultsSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const rated: RatedConfig = {
    signer, keys: [resultsPublicKey(signer, 0)], queueJoinMs: 0, matchesPerDay: 60, metadataEditsPerDay: 3, readyMs: 300,
    dodges: { count: 3, windowMs: 86_400_000, lockMs: 1_800_000 }, minAccountAgeMs: 30 * 86_400_000, replayMs: 180 * 86_400_000, ...overrides,
  };
  const pg = await database();
  const storage = await openPostgresStorage({ url: pg.url, max: 1, migrations: { scope: 'agent-command', dir: fileURLToPath(new URL('../migrations', import.meta.url)) } });
  const full: ServerConfig = {
    ...loadConfig({}), port: 0, host: '127.0.0.1', trustProxy: true, webDist: webDist(), simWorkers: 0, mainMaxMatches: 1000, maxMatches: 1000,
    admissionLagMs: 1000, featuredMatch: false, readySeconds: 5, publicUrl: new URL('https://ladder.test'), corsOrigins: [], arenaSeedKey: 'a'.repeat(64),
    github: { clientId: 'Iv1.testclient', clientSecret: 'test-client-secret-0001', oauthUrl: github.url, apiUrl: github.url }, rated, ...config,
  };
  const server = createGameServer(full, storage);
  const port = await server.listen();
  return {
    server, base: `http://127.0.0.1:${port}`, storage, github, rated,
    async close() { await server.close(); await storage.close(); await github.close(); await pg.close(); },
  };
}

/** Requests on the official origin (the rated server's PUBLIC_URL). */
export function headers(secret?: string, ip = freshIp()): Record<string, string> {
  return { 'content-type': 'application/json', origin: 'https://ladder.test', 'x-forwarded-for': ip, ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
}

export async function newProfile(base: string): Promise<{ id: string; secret: string }> {
  return json(await fetch(`${base}/api/profile`, { method: 'POST', headers: headers(), body: '{}' }));
}

/** A profile with a GitHub account old enough for rated play, linked through the real OAuth flow. */
export async function linkedProfile(r: RankedServer, githubId: number, ip = freshIp(), createdAt = '2000-01-01T00:00:00Z'): Promise<{ id: string; secret: string }> {
  const profile = await newProfile(r.base);
  const start = await fetch(`${r.base}/api/auth/github/start`, { method: 'POST', headers: headers(profile.secret, ip), body: '{}' });
  if (start.status !== 200) throw new Error(`github start → ${start.status}`);
  const { url } = await json<{ url: string }>(start);
  const authorize = new URL(url);
  const state = authorize.searchParams.get('state')!;
  r.github.challenges.set(state, authorize.searchParams.get('code_challenge')!);
  const code = `code${githubId}`;
  r.github.users.set(code, { id: githubId, login: `user${githubId}`, created_at: createdAt });
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const callback = await fetch(`${r.base}/api/auth/github/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: { cookie, 'x-forwarded-for': ip }, redirect: 'manual' });
  if (callback.status !== 303) throw new Error(`github callback → ${callback.status} ${await callback.text()}`);
  return profile;
}

/** A policy commander covering every plane, each plane's no-op policy deployed. */
export async function policyCommander(r: RankedServer, secret: string, name: string, code = 'function think() { return []; }'): Promise<string> {
  const created = await fetch(`${r.base}/api/profile/commanders`, { method: 'POST', headers: headers(secret), body: JSON.stringify({ name, kind: 'policy', roles: PLANES, isolation: { independentSessions: true } }) });
  if (created.status !== 201) throw new Error(`policy commander → ${created.status}`);
  const roster = await json<RosterResponse>(created);
  const commander = roster.commanders.find((c) => c.name === name)!;
  for (const role of PLANES) {
    const result = await r.server.host.agentSession(commander.token, role)!.control.policyDeploy({ runtime: 'js', code });
    if (!('ok' in result) || !result.ok) throw new Error(`deploy ${role} failed`);
  }
  return commander.id;
}

export async function agentCommander(r: RankedServer, secret: string, name: string): Promise<string> {
  const created = await fetch(`${r.base}/api/profile/commanders`, { method: 'POST', headers: headers(secret), body: JSON.stringify({ name, kind: 'agent', roles: PLANES, isolation: { independentSessions: true } }) });
  const roster = await json<RosterResponse>(created);
  return roster.commanders.find((c) => c.name === name)!.id;
}

export const fullLineup = (commanderId: string) => [{ commanderId, roles: [...PLANES] }];
