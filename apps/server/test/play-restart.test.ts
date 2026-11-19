import { afterEach, describe, expect, it } from 'vitest';
import type { LobbySnapshot } from '@agent-command/game/lobby';
import type { GameServer } from '../src/app.ts';
import { freshIp, json, lobbyAttach, lobbyEnter, lobbyHandoff, lobbyRoute, postLobby, start, until, type LobbyCreate } from './helpers.ts';

const PLAY: LobbyCreate = { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true };
const servers: GameServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
async function boot(overrides: Parameters<typeof start>[0] = {}) {
  const running = await start({ mainMaxMatches: 1, maxMatches: 8, abandonGraceMs: 60_000, ...overrides });
  servers.push(running.server);
  return running;
}
async function profile(base: string): Promise<{ id: string; secret: string }> {
  const response = await fetch(`${base}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{}' });
  expect(response.status).toBe(200);
  return json(response);
}
const bearer = (secret: string) => `Bearer ${secret}`;
const queuedAt = (snapshots: LobbySnapshot[], position: number) => until(() => snapshots.some((snapshot) => snapshot.queuePosition === position));

describe('Quick Play restarts through the lobby', () => {
  it('immediately admits a profile owner again without accumulating live matches', async () => {
    const { server, base } = await boot();
    const account = await profile(base);
    let previous: string | undefined;
    // The lobby's per-profile creation limit allows three creations per window.
    for (let attempt = 0; attempt < 3; attempt++) {
      const handoff = await lobbyHandoff(base, PLAY, bearer(account.secret));
      const match = server.host.authenticate(handoff.token)!.match;
      expect(server.host.matches()).toHaveLength(1);
      if (previous) expect(server.host.history.get(previous)).toBeDefined();
      for (const connection of handoff.connections) await connection.room.leave(true);
      previous = match.id;
    }
    expect(server.host.history.list()).toHaveLength(2);
  });

  // Two abandon-then-admit cycles in sequence (about 2 s each with a 500 ms grace) put it past vitest's 5 s default.
  it('queues lobbies FIFO at the local cap, then admits as abandoned matches release', async () => {
    const { base } = await boot({ abandonGraceMs: 500 });
    const [a, b, c] = await Promise.all([profile(base), profile(base), profile(base)]);
    const first = await lobbyHandoff(base, PLAY, bearer(a.secret));
    const waitingB = await lobbyAttach(base, PLAY, { authorization: bearer(b.secret) });
    await queuedAt(waitingB.snapshots, 1);
    const waitingC = await lobbyAttach(base, PLAY, { authorization: bearer(c.secret) });
    await queuedAt(waitingC.snapshots, 2);
    for (const connection of first.connections) await connection.room.leave(true);
    const second = await lobbyEnter(base, waitingB, 10_000);
    expect(waitingC.snapshots.some((snapshot) => snapshot.phase === 'started')).toBe(false);
    for (const connection of second.connections) await connection.room.leave(true);
    expect((await lobbyEnter(base, waitingC, 10_000)).roomId).not.toBe(second.roomId);
  }, 30_000);

  it('starting a new game forfeits a match you dropped out of: the opponent still connected wins', async () => {
    const { server, base, sdk } = await boot({ mainMaxMatches: 2, abandonGraceMs: 60_000, lobbyCountdownMs: 50 });
    const [blue, red] = await Promise.all([profile(base), profile(base)]);
    const host = await lobbyAttach(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'host' }, { authorization: bearer(blue.secret) });
    expect((await fetch(`${base}/api/lobbies/join`, {
      method: 'POST', headers: { authorization: bearer(red.secret), 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      body: JSON.stringify({ code: host.code }),
    })).status).toBe(200);
    const guest = await json<{ roomId: string; token: string }>(await lobbyRoute(base, host.code, 'connect', bearer(red.secret)));
    const redLobby = await sdk.joinById(guest.roomId, { token: guest.token });
    const results = new Map<number, { ok: boolean }>();
    for (const room of [host.lobby, redLobby]) room.onMessage('lobby:result', (result: { seq: number; ok: boolean }) => results.set(result.seq, result));
    let seq = 0;
    const command = async (room: typeof redLobby, body: Record<string, unknown>) => {
      const id = ++seq;
      room.send('lobby:command', { ...body, seq: id, revision: (await until(() => host.snapshots.at(-1))).revision });
      expect(await until(() => results.get(id))).toMatchObject({ ok: true });
    };
    await command(host.lobby, { op: 'ready', ready: true });
    await command(redLobby, { op: 'ready', ready: true });
    await command(host.lobby, { op: 'start' });
    // The match ticks only once every human seat has joined, so both teams enter together.
    const [blueGame, redGame] = await Promise.all([lobbyEnter(base, host), lobbyEnter(base, { ...host, authorization: bearer(red.secret) })]);
    const match = server.host.authenticate(blueGame.token)!.match;
    for (const connection of blueGame.connections) await connection.room.leave(true);
    // Standard RTS: starting another game is quitting this one. Blue forfeits, the connected red human wins, and blue
    // is never locked out with "leave your current game" (a reload must not trap anyone).
    const next = await lobbyHandoff(base, PLAY, bearer(blue.secret));
    expect(next.roomId).not.toBe(blueGame.roomId);
    await until(() => match.over);
    expect({ nw: match.outcome('nw'), se: match.outcome('se') }).toEqual({ nw: 'loss', se: 'win' });
    for (const connection of redGame.connections) await connection.room.leave(true);
  });

  it.each(['profile', 'visitor'] as const)('releases a finished %s lobby so the next Play is admitted immediately', async (kind) => {
    const { server, base } = await boot({ maxMatches: 1, endGraceMs: 0 });
    const authorization = kind === 'profile' ? bearer((await profile(base)).secret) : undefined;
    const first = await lobbyHandoff(base, PLAY, authorization);
    const match = server.host.authenticate(first.token)!.match;
    match.end({ nw: 'win', se: 'loss' });
    // Neither the owner's lobby membership nor the single lobby slot outlives the finished match:
    // the create inside this handoff must succeed at once (lobbyAttach throws on any non-200).
    const next = await lobbyHandoff(base, PLAY, authorization);
    expect(next.roomId).not.toBe(first.roomId);
    expect(server.host.history.get(match.id)?.outcomes).toEqual({ nw: 'win', se: 'loss' });
  });

  it('counts SDK sessions without rooms before admitting a lobby match', async () => {
    const { server, base } = await boot({ maxMatches: 1, mainMaxMatches: 8 });
    const occupied = server.host.createMatch({ teams: ['nw', 'se'], realtime: false });
    const waiting = await lobbyAttach(base, PLAY);
    await queuedAt(waiting.snapshots, 1);
    expect(await json(await fetch(`${base}/api/capacity`))).toMatchObject({ active: 1, queued: 1 });
    expect(await json(await fetch(`${base}/healthz`))).toMatchObject({ matches: 1 });
    occupied.end('draw');
    occupied.dispose();
    const next = await lobbyEnter(base, waiting, 10_000);
    expect(server.host.authenticate(next.token)).toBeDefined();
  });

  it.each([0, 1])('reclaims anonymous Play games using an HttpOnly owner cookie (%i workers)', async (simWorkers) => {
    const { server, base } = await boot({ simWorkers, mainMaxMatches: 1, maxMatches: 1, matchesPerWorker: 1 });
    let cookie = '';
    const rooms = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt++) {
      const attached = await lobbyAttach(base, PLAY, cookie ? { cookie } : {});
      if (attempt === 0) {
        expect(attached.setCookie).toContain('HttpOnly; SameSite=Strict');
        cookie = attached.setCookie!.split(';')[0]!;
      } else expect(attached.setCookie).toBeNull();
      const handoff = await lobbyEnter(base, attached);
      expect(rooms.has(handoff.roomId)).toBe(false);
      rooms.add(handoff.roomId);
      for (const connection of handoff.connections) await connection.room.leave(true);
      const capacity = await json<{ active: number }>(await fetch(`${base}/api/capacity`));
      expect(capacity.active).toBe(1);
    }
    if (!simWorkers) expect(server.host.history.list()).toHaveLength(4);
  });

  it('does not treat a shared IP as anonymous ownership', async () => {
    const { server, base } = await boot({ maxMatches: 1 });
    const ip = freshIp();
    const first = await lobbyAttach(base, PLAY, { 'x-forwarded-for': ip });
    const handoff = await lobbyEnter(base, first);
    const match = server.host.authenticate(handoff.token)!.match;
    for (const connection of handoff.connections) await connection.room.leave(true);
    // Same network but no cookie: the unattended game is another visitor's and keeps its lobby slot.
    expect((await postLobby(base, PLAY, { 'x-forwarded-for': ip })).status).toBe(409);
    expect(match.over).toBe(false);
  });
});
