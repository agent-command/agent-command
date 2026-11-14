import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { verifyCommanderLog } from 'playerthree/results';
import { PLANES } from '@agent-command/game';
import type { LobbySnapshot } from '@agent-command/game/lobby';
import { generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { freshIp, json, start, until } from './helpers.ts';
import { agentCommander, closeDatabase, fullLineup, headers, linkedProfile, policyCommander, startRanked, type RankedServer } from './ranked-fixture.ts';

let r: RankedServer | undefined;
const rooms: Room[] = [];
afterEach(async () => {
  await Promise.all(rooms.splice(0).map((room) => room.leave().catch(() => {})));
  await r?.close();
  r = undefined;
});
afterAll(() => closeDatabase());

const queue = (base: string, secret: string, body?: unknown, ip = freshIp(), method = body === undefined ? 'GET' : 'POST') =>
  fetch(`${base}/api/queue`, { method, headers: headers(secret, ip), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('rated routes on a server without RATED=on', () => {
  it('answers 404 for the queue, ladder, cards and results keys', async () => {
    const { server, base } = await start();
    try {
      for (const path of ['/api/queue', '/api/ladder/cards', '/leaderboard', '/commanders/c_abcdefghijklmnopqrst', '/commanders/c_abcdefghijklmnopqrst/log.json', '/.well-known/agent-command/results-keys.json']) {
        expect((await fetch(`${base}${path}`)).status, path).toBe(404);
      }
      expect((await fetch(`${base}/api/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    } finally { await server.close(); }
  });
});

describe('startup guard', () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const official = { RATED: 'on', RESULTS_SIGNING_KEY: key, DATABASE_URL: 'postgres://db/ac', ARENA_SEED_KEY: 'a'.repeat(64), PUBLIC_URL: 'https://agentcommand.gg', GITHUB_CLIENT_ID: 'Iv1.client01', GITHUB_CLIENT_SECRET: 'secret-secret-secret', PLAYERTHREE_DEVTOOLS: '0' };
  it('enables rated play only with the key, Postgres, https and GitHub, and refuses every dev surface', () => {
    expect(loadConfig(official).rated?.signer.keyId).toMatch(/^k_[0-9a-f]{16}$/);
    expect(loadConfig({ ...official, RATED: undefined }).rated).toBeUndefined();
    const { RESULTS_SIGNING_KEY: _key, ...keyless } = official;
    expect(() => loadConfig(keyless)).toThrow('RESULTS_SIGNING_KEY');
    expect(() => loadConfig({ ...official, DATABASE_URL: undefined })).toThrow('DATABASE_URL');
    expect(() => loadConfig({ ...official, PUBLIC_URL: 'http://agentcommand.gg' })).toThrow('https');
    expect(() => loadConfig({ ...official, AC_DEV_ADMIN_TOKEN: 'a'.repeat(20) })).toThrow('AC_DEV_ADMIN_TOKEN');
    expect(() => loadConfig({ ...official, PLAYERTHREE_DEVTOOLS: undefined })).toThrow('devtools');
    expect(() => loadConfig({ ...official, SIM_SPEED: '20' })).toThrow('SIM_SPEED');
    expect(() => loadConfig({ ...official, RULES_JSON: '{}' })).toThrow('standard rules');
    expect(() => loadConfig({ ...official, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined })).toThrow('GitHub');
    expect(() => loadConfig({ ...official, RESULTS_SIGNING_KEY: 'not-a-key' })).toThrow('Ed25519');
  });
});

describe('rated queue', () => {
  it('refuses unlinked accounts, foreign and mixed-kind lineups and partial plane coverage', { timeout: 60_000 }, async () => {
    r = await startRanked();
    const a = await linkedProfile(r, 3001);
    const policy = await policyCommander(r, a.secret, 'Policy A');
    const agent = await agentCommander(r, a.secret, 'Agent A');
    const other = await linkedProfile(r, 3002);
    const foreign = await policyCommander(r, other.secret, 'Policy B');
    const unlinked = await json<{ secret: string }>(await fetch(`${r.base}/api/profile`, { method: 'POST', headers: headers(), body: '{}' }));
    const code = async (res: Response) => ({ status: res.status, ...(await json<{ error?: string }>(res)) });
    expect(await code(await queue(r.base, unlinked.secret, { pool: 'policy_1v1', lineup: fullLineup(policy) }))).toMatchObject({ status: 403, error: 'account_required' });
    expect(await code(await queue(r.base, a.secret, { pool: 'policy_1v1', lineup: fullLineup(foreign) }))).toMatchObject({ status: 403, error: 'not_owner' });
    expect(await code(await queue(r.base, a.secret, { pool: 'policy_1v1', lineup: [{ commanderId: policy, roles: ['depths', 'surface'] }, { commanderId: agent, roles: ['sky', 'orbit'] }] }))).toMatchObject({ status: 400, error: 'mixed_kind' });
    expect(await code(await queue(r.base, a.secret, { pool: 'live_1v1', lineup: fullLineup(policy) }))).toMatchObject({ status: 400, error: 'mixed_kind' });
    expect(await code(await queue(r.base, a.secret, { pool: 'policy_1v1', lineup: [{ commanderId: policy, roles: ['depths', 'surface', 'sky'] }] }))).toMatchObject({ status: 400, error: 'planes_incomplete' });
    expect(await code(await queue(r.base, a.secret, { pool: 'policy_1v1', lineup: [{ commanderId: policy, roles: [...PLANES, 'surface'] }] }))).toMatchObject({ status: 400, error: 'planes_overlap' });
    expect(await code(await queue(r.base, a.secret, { pool: 'ranked_anything', lineup: fullLineup(policy) }))).toMatchObject({ status: 400, error: 'bad_pool' });
    expect((await queue(r.base, a.secret, { pool: 'policy_1v1', lineup: fullLineup(policy) })).status).toBe(200);
    expect(await code(await queue(r.base, a.secret, { pool: 'policy_1v1', lineup: fullLineup(policy) }))).toMatchObject({ status: 409, error: 'already_queued' });
  });

  it('pairs owners across clusters only, opens the frozen ranked match and signs its log entries', { timeout: 90_000 }, async () => {
    // Long enough for every policy to load before the start (unready policies would fall back to bots).
    r = await startRanked({ readyMs: 20_000 });
    // Two accounts on one network share a cluster: never paired, and at most two of one cluster queue per pool.
    const a = await linkedProfile(r, 4001, '10.40.1.1');
    const b = await linkedProfile(r, 4002, '10.40.1.2');
    const d = await linkedProfile(r, 4004, '10.40.1.3');
    const c = await linkedProfile(r, 4003, '10.41.7.7');
    const [ca, cb, cd, cc] = [await policyCommander(r, a.secret, 'A'), await policyCommander(r, b.secret, 'B'), await policyCommander(r, d.secret, 'D'), await policyCommander(r, c.secret, 'C')];
    expect((await queue(r.base, a.secret, { pool: 'policy_1v1', lineup: fullLineup(ca) }, '10.40.1.1')).status).toBe(200);
    expect((await queue(r.base, b.secret, { pool: 'policy_1v1', lineup: fullLineup(cb) }, '10.40.1.2')).status).toBe(200);
    expect(await json(await queue(r.base, d.secret, { pool: 'policy_1v1', lineup: fullLineup(cd) }, '10.40.1.3'))).toEqual({ error: 'cluster_busy' });
    // Matchmaking passes run on demand here: two passes find no pair inside one cluster.
    await r.server.ranked.matchmaker!.tick();
    await r.server.ranked.matchmaker!.tick();
    expect(await json(await queue(r.base, a.secret))).toMatchObject({ queued: { pool: 'policy_1v1' }, match: null });
    expect((await queue(r.base, c.secret, { pool: 'policy_1v1', lineup: fullLineup(cc) }, '10.41.7.7')).status).toBe(200);
    const playing = await until(async () => {
      const status = await json<{ match: { state: string; matchId: string | null; roomId: string | null } | null }>(await queue(r!.base, c.secret));
      return status.match?.state === 'playing' && status.match;
    }, 30_000);
    expect(playing.roomId).toBeTruthy();
    // B (same cluster as A) is still waiting; A was paired with C.
    expect(await json(await queue(r.base, b.secret))).toMatchObject({ queued: { pool: 'policy_1v1' }, match: null });
    expect(await json(await queue(r.base, a.secret))).toMatchObject({ queued: null, match: { state: 'playing' } });
    const [record] = await r.storage.query<{ record: { sides: { owner: string; cluster: string }[]; rulesHash: string } }>('SELECT record FROM ac_rated_matches WHERE match_id = $1', [playing.matchId]);
    expect(new Set(record!.record.sides.map((s) => s.owner))).toEqual(new Set([a.id, c.id]));
    const match = r.server.host.getMatch(playing.matchId!)!;
    // No owner control and no human tokens: coaching is off by construction.
    expect(match.seats().map((seat) => seat.controller)).toEqual(Array(8).fill('policy'));
    expect(() => match.mintHumanToken(match.teams[0]!, 'surface')).toThrow();
    // Owner coaching through the roster is refused while the commander plays rated.
    const tell = await fetch(`${r.base}/api/profile/tell`, { method: 'POST', headers: headers(a.secret), body: JSON.stringify({ commanderIds: [ca], text: 'push now' }) });
    expect(await json(tell)).toEqual({ error: 'rated_match' });
    match.end({ [match.teams[0]!]: 'win', [match.teams[1]!]: 'loss' });
    await r.server.host.commanderLog.flush();
    await r.server.ranked.settled();
    const entries = await r.server.host.commanderLog.match(playing.matchId!);
    expect(entries).toHaveLength(2);
    for (const { entry } of entries) {
      expect(entry).toMatchObject({ queue: 'rated_policy_1v1', mode: expect.stringMatching(/^duel_(1v1|c4)$/), host: { official: true, keyId: r.rated.signer.keyId }, customRules: false, rulesHash: record!.record.rulesHash });
      // Far below the rated minimum length and nobody left early: flagged, then void at application.
      expect(entry.verdict).toMatchObject({ pool: 'policy_1v1', reasons: expect.arrayContaining(['too_short']) });
      expect(verifyCommanderLog([entry], r.rated.keys)).toEqual({ ok: true, entries: 1 });
    }
    expect(r.server.ranked.ratings().size).toBe(0);
    const keys = await json<{ keys: unknown[] }>(await fetch(`${r.base}/.well-known/agent-command/results-keys.json`));
    expect(keys.keys).toEqual(r.rated.keys);
  });

  it('locks the queue after three dodges of a live ready check', { timeout: 90_000 }, async () => {
    r = await startRanked({ readyMs: 300 });
    const a = await linkedProfile(r, 5001, '10.50.1.1');
    const b = await linkedProfile(r, 5002, '10.51.1.1');
    const [ca, cb] = [await agentCommander(r, a.secret, 'Live A'), await agentCommander(r, b.secret, 'Live B')];
    for (let round = 0; round < 3; round++) {
      const rejoin = await queue(r.base, a.secret, { pool: 'live_1v1', lineup: fullLineup(ca) }, '10.50.1.1');
      expect({ round, status: rejoin.status, body: await rejoin.json() }).toMatchObject({ round, status: 200 });
      const joined = await queue(r.base, b.secret, { pool: 'live_1v1', lineup: fullLineup(cb) }, '10.51.1.1');
      expect([200, 409]).toContain(joined.status);
      // No agent marks its reserved seat ready: both entrants dodged once the ready window closes.
      await until(async () => (await json<{ queued: unknown; match: unknown }>(await queue(r!.base, a.secret))).match === null && (await json<{ queued: unknown }>(await queue(r!.base, a.secret))).queued === null, 15_000);
      await until(async () => (await json<{ match: unknown; queued: unknown }>(await queue(r!.base, b.secret))).match === null, 15_000);
    }
    const locked = await queue(r.base, a.secret, { pool: 'live_1v1', lineup: fullLineup(ca) }, '10.50.1.1');
    expect(locked.status).toBe(429);
    const body = await json<{ error: string; lockedUntil: number }>(locked);
    expect(body.error).toBe('dodge_locked');
    expect(body.lockedUntil).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect((await json<{ lockedUntil: number | null }>(await queue(r.base, a.secret))).lockedUntil).toBe(body.lockedUntil);
  });

  it('keeps a lobby room unranked: its entries name no queue and stay lobby_match', { timeout: 90_000 }, async () => {
    r = await startRanked();
    const owner = await linkedProfile(r, 6001);
    const commander = await policyCommander(r, owner.secret, 'Lobby policy');
    const created = await fetch(`${r.base}/api/lobbies`, { method: 'POST', headers: headers(owner.secret), body: JSON.stringify({ mapId: 'crossfire', layoutId: 'duel', visibility: 'private', preset: 'play' }) });
    expect(created.status).toBe(200);
    const { code } = await json<{ code: string }>(created);
    const grant = await json<{ roomId: string; token: string }>(await fetch(`${r.base}/api/lobbies/${code}/connect`, { method: 'POST', headers: headers(owner.secret), body: '{}' }));
    const client = new Client(r.base);
    const room = await client.joinById(grant.roomId, { token: grant.token });
    rooms.push(room);
    const snapshots: LobbySnapshot[] = [];
    const replies = new Map<number, { ok: boolean }>();
    room.onMessage('lobby:snapshot', (s: LobbySnapshot) => snapshots.push(s));
    room.onMessage('lobby:result', (reply: { seq: number; ok: boolean }) => replies.set(reply.seq, reply));
    room.onMessage('lobby:error', () => {});
    await until(() => snapshots.at(-1));
    room.send('lobby:command', { seq: 1, revision: snapshots.at(-1)!.revision, op: 'assign', team: 'nw', roles: [...PLANES], occupant: { kind: 'commander', ref: { id: commander, kind: 'policy' } } });
    expect(await until(() => replies.get(1))).toMatchObject({ ok: true });
    room.send('lobby:command', { seq: 2, revision: snapshots.at(-1)!.revision, op: 'start' });
    expect(await until(() => replies.get(2))).toMatchObject({ ok: true });
    await until(() => snapshots.at(-1)?.phase === 'started', 30_000);
    const match = await until(() => r!.server.host.matches().find((m) => m.seats().some((seat) => seat.commander)));
    match.end({ nw: 'win', se: 'loss' });
    await r.server.host.commanderLog.flush();
    const [entry] = (await r.server.host.commanderLog.match(match.id)).map((row) => row.entry);
    expect(entry).toMatchObject({ mode: 'lobby', queue: null, host: { official: true } });
    expect(entry!.verdict).toMatchObject({ rated: false, reasons: expect.arrayContaining(['lobby_match']) });
  });
});
