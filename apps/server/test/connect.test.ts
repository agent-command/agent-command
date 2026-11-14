import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectionInfo, PairingCode, PairingResult } from '@playerthree/connect';
import { connectSeat } from '@playerthree/runner';
import type { GameServer } from '../src/app.ts';
import { clientKind } from '../src/clients.ts';
import type { RosterResponse } from '../src/roster.ts';
import { freshIp, json, start } from './helpers.ts';

let server: GameServer;
let base: string;

beforeAll(async () => {
  ({ server, base } = await start({ matchesPerIp: 50 }));
});

afterAll(async () => {
  await server.close();
});

const REDIRECT = 'http://127.0.0.1:4545/callback';

function api(path: string, opts: { method?: string; secret?: string; body?: unknown; ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? freshIp() };
  if (opts.secret) headers.authorization = `Bearer ${opts.secret}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function newProfile(): Promise<{ id: string; secret: string }> {
  return json(await api('/api/profile', { body: {} }));
}

/** Plays harness + browser: DCR, PKCE authorization and token exchange. */
async function pending(clientName = 'Paired harness', softwareId?: string) {
  const reg = await json<{ client_id: string }>(await api('/oauth/register', {
    body: { client_name: clientName, redirect_uris: [REDIRECT], ...(softwareId ? { software_id: softwareId } : {}) },
  }));
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, resource: `${base}/mcp`,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const response = await fetch(`${base}/oauth/authorize?${params}`, { redirect: 'manual', headers: { 'x-forwarded-for': freshIp() } });
  expect(response.status).toBe(302);
  const consent = new URL(response.headers.get('location')!);
  expect(consent.pathname).toBe('/connect');
  return {
    id: consent.searchParams.get('r')!,
    async redeem(redirect: string) {
      const response = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier, code: new URL(redirect).searchParams.get('code')! }),
      });
      expect(response.status).toBe(200);
      return json<{ access_token: string; refresh_token: string }>(response);
    },
  };
}

async function createCommander(secret: string, name: string, roles: string[]) {
  const before = await json<RosterResponse>(await api('/api/profile', { secret }));
  const response = await api('/api/profile/commanders', {
    secret, body: { name, kind: 'agent', roles, isolation: { independentSessions: false }, metadata: { provider: 'Example', model: 'Model 1' } },
  });
  expect(response.status).toBe(201);
  const roster = await json<RosterResponse>(response);
  return roster.commanders.find((commander) => !before.commanders.some((old) => old.id === commander.id))!;
}

async function signIn(secret: string, commander: string, roles: string[], name = 'playerthree-mcp') {
  const request = await pending(name, 'dev.playerthree.bridge');
  const info = await json(await api(`/api/connect/${request.id}`));
  expect(info).toMatchObject({ client: { name }, roles: ['depths', 'surface', 'sky', 'orbit'], redirect: { host: '127.0.0.1:4545', loopback: true } });
  const answer = await json<{ redirect: string }>(await api(`/api/connect/${request.id}`, { secret, body: { commander, roles, approve: true } }));
  return request.redeem(answer.redirect);
}

describe('named commander connections', () => {
  it('grants a chosen named commander without assigning seats or modifying a same-role peer', async () => {
    const { secret } = await newProfile();
    const first = await createCommander(secret, 'First', ['sky', 'orbit']);
    const second = await createCommander(secret, 'Second', ['sky', 'orbit']);
    const token = await signIn(secret, second.id, ['sky', 'orbit']);
    const conns = await json<ConnectionInfo[]>(await api('/api/profile/connections', { secret }));
    expect(conns).toMatchObject([{ commander: second.id, roles: ['sky', 'orbit'], client: { name: 'playerthree-mcp' }, createdAt: expect.any(Number), authorizedAt: expect.any(Number) }]);
    const roster = await json<RosterResponse>(await api('/api/profile', { secret }));
    expect(roster.commanders.map((commander) => [commander.id, commander.roles, commander.seated])).toEqual([
      [first.id, ['sky', 'orbit'], null], [second.id, ['sky', 'orbit'], null],
    ]);
    const seat = await connectSeat({ url: `${base}/mcp`, token: token.access_token });
    try {
      expect((await seat.call('game_briefing', {})).isError).not.toBe(true);
      const [conn] = conns;
      expect(await json(await api(`/api/profile/connections/${conn!.id}`, { method: 'PATCH', secret, body: { roles: ['sky'] } }))).toMatchObject([{ commander: second.id, roles: ['sky'] }]);
      expect((await api(`/api/profile/connections/${conn!.id}`, { method: 'PATCH', secret, body: { roles: ['surface'] } })).status).toBe(404);
      expect(await json(await api(`/api/profile/connections/${conn!.id}`, { method: 'DELETE', secret }))).toEqual([]);
      const probe = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
      expect(probe.status).toBe(401);
    } finally { await seat.close(); }
  });

  it('keeps independent connections for two commanders sharing a role and enforces owner boundaries', async () => {
    const alice = await newProfile();
    const bob = await newProfile();
    const first = await createCommander(alice.secret, 'Same label', ['surface']);
    const second = await createCommander(alice.secret, 'Same label', ['surface']);
    await signIn(alice.secret, first.id, ['surface'], 'Same client');
    await signIn(alice.secret, second.id, ['surface'], 'Same client');
    const connections = await json<ConnectionInfo[]>(await api('/api/profile/connections', { secret: alice.secret }));
    expect(connections.map((connection) => [connection.commander, connection.roles])).toEqual([[first.id, ['surface']], [second.id, ['surface']]]);
    expect(connections[0]!.client.domain).toBeUndefined();
    expect(await json(await api('/api/profile/connections', { secret: bob.secret }))).toEqual([]);
    expect((await api(`/api/profile/connections/${connections[0]!.id}`, { method: 'DELETE', secret: bob.secret })).status).toBe(404);
    const request = await pending();
    expect((await api(`/api/connect/${request.id}`, { secret: bob.secret, body: { commander: first.id, roles: ['surface'], approve: true } })).status).toBe(400);
    expect((await api(`/api/connect/${request.id}`, { secret: alice.secret, body: { commander: first.id, roles: ['sky'], approve: true } })).status).toBe(400);
  });

  it('rejects missing identity and old/extra fields, then consumes a denial exactly once without creating a roster entry', async () => {
    const { secret } = await newProfile();
    const request = await pending();
    expect((await api('/api/profile/connections')).status).toBe(401);
    expect((await api(`/api/connect/${request.id}`, { body: { commander: '', roles: [], approve: false } })).status).toBe(401);
    for (const body of [
      { roles: ['sky'], approve: true },
      { commander: 'id', roles: ['moon'], approve: true },
      { commander: 'id', roles: ['sky', 'sky'], approve: true },
      { commander: 'id', roles: [], approve: true },
      { commander: 'id', roles: ['sky'], approve: true, team: 'nw' },
      { commander: 'id', role: 'sky', roles: ['sky'], approve: true },
    ]) expect((await api(`/api/connect/${request.id}`, { secret, body })).status).toBe(400);
    const denial = { commander: '', roles: [], approve: false };
    const denied = await json<{ redirect: string }>(await api(`/api/connect/${request.id}`, { secret, body: denial }));
    expect(new URL(denied.redirect).searchParams.get('error')).toBe('access_denied');
    expect((await api(`/api/connect/${request.id}`)).status).toBe(404);
    expect((await api(`/api/connect/${request.id}`, { secret, body: denial })).status).toBe(404);
    expect((await json<RosterResponse>(await api('/api/profile', { secret }))).commanders).toEqual([]);
  });
});

describe('cross-browser pairing', () => {
  it('projects named commanders without secrets and binds the original owner to one request only', async () => {
    const alice = await newProfile();
    const bob = await newProfile();
    const commander = await createCommander(alice.secret, 'Original commander', ['sky', 'orbit']);
    const request = await pending();
    const other = await pending();
    const minted = await json<PairingCode>(await api('/api/profile/pairing', { secret: alice.secret, body: {} }));
    expect(minted.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    const paired = await json<PairingResult>(await api(`/api/connect/${request.id}/pair`, { body: { code: minted.code.toLowerCase() } }));
    expect(paired.commanders).toMatchObject([{
      id: commander.id, name: 'Original commander', kind: 'agent', roles: ['sky', 'orbit'],
      isolation: { independentSessions: false }, metadata: { provider: 'Example', model: 'Model 1' }, holder: null,
    }]);
    expect(Object.keys(paired.commanders[0]!).sort()).toEqual(['holder', 'id', 'isolation', 'kind', 'mandate', 'metadata', 'name', 'roles', 'scopes']);
    for (const secret of [alice.secret, alice.id, commander.token]) expect(JSON.stringify(paired)).not.toContain(secret);
    expect(paired.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await api(`/api/connect/${other.id}/pair`, { body: { code: minted.code } })).status).toBe(400);
    const answer = { commander: commander.id, roles: ['sky'], approve: true, pairingToken: paired.pairingToken };
    expect((await api(`/api/connect/${other.id}`, { body: answer })).status).toBe(400);
    expect((await api(`/api/connect/${request.id}`, { secret: bob.secret, body: { commander: commander.id, roles: ['sky'], approve: true } })).status).toBe(403);
    expect((await api('/api/profile', { secret: paired.pairingToken })).status).toBe(401);
    expect((await api('/api/profile/commanders', { body: { pairingToken: paired.pairingToken, name: 'No', kind: 'agent', roles: ['sky'] } })).status).toBe(401);
    const approved = await json<{ redirect: string }>(await api(`/api/connect/${request.id}`, { body: answer }));
    expect((await request.redeem(approved.redirect)).access_token).toMatch(/^playerthree_at_/);
    expect((await api(`/api/connect/${request.id}`, { body: answer })).status).toBe(404);
    expect(await json(await api('/api/profile/connections', { secret: alice.secret }))).toMatchObject([{ commander: commander.id, roles: ['sky'] }]);
    expect(await json(await api('/api/profile/connections', { secret: bob.secret }))).toEqual([]);
  });

  it('reports holders by commander ID, not by a shared compatible role', async () => {
    const { secret } = await newProfile();
    const first = await createCommander(secret, 'First Surface', ['surface']);
    const second = await createCommander(secret, 'Second Surface', ['surface']);
    await signIn(secret, first.id, ['surface'], 'First harness');
    const request = await pending();
    const minted = await json<PairingCode>(await api('/api/profile/pairing', { secret, body: {} }));
    const paired = await json<PairingResult>(await api(`/api/connect/${request.id}/pair`, { body: { code: minted.code } }));
    expect(paired.commanders.find((commander) => commander.id === first.id)!.holder).toMatchObject({ name: 'First harness' });
    expect(paired.commanders.find((commander) => commander.id === second.id)!.holder).toBeNull();
  });

  it('pairs an empty original roster without inventing commanders and permits denial', async () => {
    const { secret } = await newProfile();
    const request = await pending();
    const minted = await json<PairingCode>(await api('/api/profile/pairing', { secret, body: {} }));
    const paired = await json<PairingResult>(await api(`/api/connect/${request.id}/pair`, { body: { code: minted.code } }));
    expect(paired.commanders).toEqual([]);
    const denied = await json<{ redirect: string }>(await api(`/api/connect/${request.id}`, { body: { commander: '', pairingToken: paired.pairingToken, roles: [], approve: false } }));
    expect(new URL(denied.redirect).searchParams.get('error')).toBe('access_denied');
    expect((await json<RosterResponse>(await api('/api/profile', { secret }))).commanders).toEqual([]);
  });

  it('supports direct code denial, replaces old codes and expires codes and request capabilities', async () => {
    const { secret } = await newProfile();
    const request = await pending();
    const mint = () => api('/api/profile/pairing', { secret, body: {} }).then(json<PairingCode>);
    const old = await mint();
    const current = await mint();
    expect((await api(`/api/connect/${request.id}/pair`, { body: { code: old.code } })).status).toBe(400);
    const denied = await json<{ redirect: string }>(await api(`/api/connect/${request.id}`, { body: { commander: '', pairingCode: current.code, roles: [], approve: false } }));
    expect(new URL(denied.redirect).searchParams.get('error')).toBe('access_denied');
    const next = await pending();
    const expiring = await mint();
    const paired = await json<PairingResult>(await api(`/api/connect/${next.id}/pair`, { body: { code: expiring.code } }));
    const unpaired = await mint();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
    try {
      expect((await api(`/api/connect/${next.id}`, { body: { commander: '', pairingToken: paired.pairingToken, roles: [], approve: false } })).status).toBe(404);
      const later = await pending();
      expect((await api(`/api/connect/${later.id}/pair`, { body: { code: unpaired.code } })).status).toBe(400);
    } finally { clock.mockRestore(); }
  });

  it('limits minting per owner/IP and attempts per request/IP', async () => {
    const { secret } = await newProfile();
    for (let i = 0; i < 5; i++) expect((await api('/api/profile/pairing', { secret, body: {} })).status).toBe(200);
    expect((await api('/api/profile/pairing', { secret, body: {} })).status).toBe(429);
    const mintIp = freshIp();
    for (let i = 0; i < 6; i++) {
      const owner = await newProfile();
      expect((await api('/api/profile/pairing', { secret: owner.secret, ip: mintIp, body: {} })).status).toBe(i < 5 ? 200 : 429);
    }
    const request = await pending();
    for (let i = 0; i < 6; i++) expect((await api(`/api/connect/${request.id}/pair`, { body: { code: 'AAAAAA' } })).status).toBe(i < 5 ? 400 : 404);
    const tryIp = freshIp();
    for (let i = 0; i < 11; i++) {
      const next = await pending();
      expect((await api(`/api/connect/${next.id}/pair`, { ip: tryIp, body: { code: 'AAAAAA' } })).status).toBe(i < 10 ? 400 : 429);
    }
  });
});

describe('sign-in endpoints', () => {
  it('dev: both the Vite origin (PUBLIC_URL) and the server origin are the MCP resource; production: PUBLIC_URL only', async () => {
    const prm = async (b: string, headers: Record<string, string> = {}) =>
      json<{ resource: string; authorization_servers: string[] }>(await fetch(`${b}/.well-known/oauth-protected-resource/mcp`, { headers: { 'x-forwarded-for': freshIp(), ...headers } }));
    const dev = await start({ publicUrl: new URL('http://localhost:5173') });
    try {
      expect(await prm(dev.base)).toMatchObject({ resource: `${dev.base}/mcp`, authorization_servers: [dev.base] });
      // Through the Vite proxy (xfwd): the Vite origin.
      expect(await prm(dev.base, { 'x-forwarded-host': 'localhost:5173', 'x-forwarded-proto': 'http' })).toMatchObject({ resource: 'http://localhost:5173/mcp', authorization_servers: ['http://localhost:5173'] });
      const challenge = (await fetch(`${dev.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).headers.get('www-authenticate');
      expect(challenge).toContain(`resource_metadata="${dev.base}/.well-known/oauth-protected-resource/mcp"`);
    } finally {
      await dev.server.close();
    }
    const prod = await start({ publicUrl: new URL('https://game.example') });
    try {
      expect(await prm(prod.base)).toMatchObject({ resource: 'https://game.example/mcp', authorization_servers: ['https://game.example'] });
      expect(await prm(prod.base, { 'x-forwarded-host': '127.0.0.1:1' })).toMatchObject({ resource: 'https://game.example/mcp' });
    } finally {
      await prod.server.close();
    }
  });

  it('are rate-limited per IP; registrations have their own budget', async () => {
    const limited = await start({ oauthCallsPerMin: 3, oauthRegistrationsPerHour: 1 });
    try {
      const ip = freshIp();
      const hit = () => fetch(`${limited.base}/.well-known/oauth-authorization-server`, { headers: { 'x-forwarded-for': ip } });
      expect([(await hit()).status, (await hit()).status, (await hit()).status, (await hit()).status]).toEqual([200, 200, 200, 429]);
      const reg = (addr: string) =>
        fetch(`${limited.base}/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': addr },
          body: JSON.stringify({ client_name: 'x', redirect_uris: [REDIRECT] }),
        });
      const other = freshIp();
      expect([(await reg(other)).status, (await reg(other)).status]).toEqual([201, 429]);
    } finally {
      await limited.server.close();
    }
  });

  it('client kinds: metadata-document hosts vouch for names; DCR names are hints', () => {
    expect(clientKind({ id: 'https://claude.ai/oauth/claude-code-client-metadata', registration: 'cimd', name: 'Claude Code' })).toBe('claude-code');
    expect(clientKind({ id: 'https://evil.example/oauth/claude-code-client-metadata', registration: 'cimd', name: 'Claude Code' })).toBe('generic');
    expect(clientKind({ id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', registration: 'cimd', name: 'Claude' })).toBe('generic');
    expect(clientKind({ id: 'https://nousresearch.com/hermes/client.json', registration: 'cimd', name: 'Hermes Agent' })).toBe('hermes');
    expect(clientKind({ id: 'dcr_1', registration: 'dcr', name: 'Codex' })).toBe('codex');
    expect(clientKind({ id: 'dcr_2', registration: 'dcr', name: 'hermes-agent' })).toBe('hermes');
    expect(clientKind({ id: 'dcr_3', registration: 'dcr', name: 'playerthree-run', softwareId: 'dev.playerthree.runner' })).toBe('playerthree-runner');
    expect(clientKind({ id: 'https://opencode.ai/oauth/opencode/client.json', registration: 'cimd', name: 'OpenCode' })).toBe('opencode');
    expect(clientKind({ id: 'https://pi.dev/oauth/client.json', registration: 'cimd', name: 'Pi' })).toBe('pi');
    expect(clientKind({ id: 'https://evil.example/oauth/client.json', registration: 'cimd', name: 'Pi' })).toBe('generic');
    expect(clientKind({ id: 'dcr_5', registration: 'dcr', name: 'oh-my-pi' })).toBe('oh-my-pi');
    expect(clientKind({ id: 'dcr_6', registration: 'dcr', name: 'Pi' })).toBe('pi');
    expect(clientKind({ id: 'dcr_7', registration: 'dcr', name: 'Piper' })).toBe('generic');
    expect(clientKind({ id: 'dcr_8', registration: 'dcr', name: 'opencode' })).toBe('opencode');
    expect(clientKind({ id: 'dcr_4', registration: 'dcr', name: 'Some Client' })).toBe('generic');
  });
});
