import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/app.ts';
import { isLoopback } from '../src/dev-admin.ts';
import type { Client as SdkClient } from '@colyseus/sdk';
import { MSG } from 'playerthree';
import { PLANES } from '@agent-command/game';
import { join, json, requestAuthority, start, until } from './helpers.ts';
import { matchMaker } from '@colyseus/core';

const TOKEN = 'dev-admin-test-token-0123456789';
const PATHS = ['/dev', '/dev/', '/dev/matches', '/dev/matches/abc', '/dev/matches/abc/god', '/dev/matches/abc/speed', '/dev/anything/else'];

interface MatchInfo {
  roomId: string;
  mode: string;
  tick: number;
  speed: number | null;
  seed?: number;
  terrain?: string;
  outcomes: Record<string, string>;
  seats: Record<string, Record<string, string>>;
  tokens?: Record<string, string>;
  armies: { id: string; colour: string }[];
}
interface God {
  tick: number;
  armies: Record<string, { colour: string; alloy: number; energy: number; spire: Record<string, string>; units: Record<string, Record<string, number>> }>;
  entities?: { id: string; kind: string; side: string; plane: string; x: number; y: number; hp: number; maxHp: number }[];
}

function dev(base: string, path: string, init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  Object.assign(headers, init.headers);
  return fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
}

async function ok<T>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  if (r.status !== 200) throw new Error(`${r.url} → ${r.status} ${await r.text()}`);
  return json<T>(r);
}

describe('dev-admin disabled (no AC_DEV_ADMIN_TOKEN)', () => {
  let server: GameServer;
  let base: string;
  beforeAll(async () => {
    ({ server, base } = await start());
  });
  afterAll(() => server.close());

  it('every /dev/* route 404s, with or without a token', async () => {
    for (const path of PATHS) {
      for (const method of ['GET', 'POST']) {
        expect((await dev(base, path, { method })).status, `${method} ${path}`).toBe(404);
        expect((await dev(base, path, { method, token: null })).status, `${method} ${path}`).toBe(404);
      }
    }
  });

  it('no request can switch it on: loopback spoofing, host, query and header tokens all 404', async () => {
    const spoofs: Record<string, string>[] = [
      { 'x-forwarded-for': '127.0.0.1' }, { 'x-real-ip': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' },
      { 'x-forwarded-host': 'localhost' }, { host: 'localhost' }, { 'x-dev-admin': '1', 'x-ac-dev-admin-token': TOKEN },
    ];
    for (const headers of spoofs) {
      for (const method of ['GET', 'POST']) {
        const res = await dev(base, `/dev/matches?token=${TOKEN}&AC_DEV_ADMIN_TOKEN=${TOKEN}`, { method, headers });
        expect(res.status, `${method} ${JSON.stringify(headers)}`).toBe(404);
      }
    }
  });
});

describe('dev-admin enabled', () => {
  let server: GameServer;
  let base: string;
  let port: number;
  let sdk: SdkClient;
  beforeAll(async () => {
    ({ server, base, sdk } = await start({ devAdminToken: TOKEN, host: '0.0.0.0' }));
    port = Number(new URL(base).port);
  });
  afterAll(() => server.close());

  it('requires the bearer token', async () => {
    expect((await dev(base, '/dev/matches', { token: null })).status).toBe(401);
    expect((await dev(base, '/dev/matches', { token: 'wrong-token-wrong-token' })).status).toBe(401);
    expect((await dev(base, '/dev/matches', { headers: { authorization: TOKEN } })).status).toBe(401);
    expect((await dev(base, '/dev/matches')).status).toBe(200);
  });

  it('serves loopback clients only (no proxied requests)', async () => {
    expect(['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1'].every(isLoopback)).toBe(true);
    expect(['10.0.0.1', '192.168.1.2', '::ffff:10.0.0.1', 'fe80::1', '', undefined].some(isLoopback)).toBe(false);
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host']) {
      expect((await dev(base, '/dev/matches', { headers: { [h]: '127.0.0.1' } })).status).toBe(403);
    }
    // The token is a header credential only: a query string never authorizes.
    expect((await dev(base, `/dev/matches?token=${TOKEN}`, { token: null })).status).toBe(401);
    const external = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (external) expect((await dev(`http://${external}:${port}`, '/dev/matches')).status).toBe(403);
  });

  it('links the operator console (localhost, no credential), which exposes bounded unfogged adapter state', async () => {
    const m = await ok<MatchInfo & { devtools: string }>(dev(base, '/dev/matches', { body: { mode: 'agents', seed: 17, speed: 0 } }));
    const match = server.host.authenticate(m.tokens!.nw!)!.match;
    expect(m.devtools).toBe(`/playerthree/devtools#sessions/${match.id}`);
    const root = '/playerthree/devtools/api/';
    expect((await dev(base, root + 'sessions', { headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(403);
    expect((await dev(base, root + 'sessions', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const listed = await ok<{ sessions: { id: string }[] }>(dev(base, root + 'sessions', { token: null }));
    expect(listed.sessions.some((x) => x.id === match.id)).toBe(true);
    const session = `${root}sessions/${match.id}/`;
    const god = await ok<{ data: God & { entitiesOmitted: number } }>(dev(base, session + 'view?perspective=god', { token: null }));
    expect(Object.keys(god.data.armies)).toEqual(['nw', 'se']);
    expect(god.data.entities!.some((e) => e.side === 'nw')).toBe(true);
    expect(god.data.entities!.some((e) => e.side === 'se')).toBe(true);
    expect(god.data.entities!.length).toBeLessThanOrEqual(2048);
    expect(god.data.entitiesOmitted).toBe(0);
    for (const team of ['nw', 'se'] as const) {
      await match.seat(team, 'surface').observe();
      const side = await ok<{ data: { army: string } }>(dev(base, session + `view?perspective=side:${team}`, { token: null }));
      expect(side.data.army).toBe(team);
      const seat = await ok<{ observation: { team: string; role: string } }>(dev(base, session + `view?perspective=seat:${team}/surface`, { token: null }));
      expect(seat.observation).toMatchObject({ team, role: 'surface' });
    }
  });

  it('answers post-join authority requests and queues every operator-owned plane without elevating agents or spectators', async () => {
    const m = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'bots', seed: 17, speed: 0 } }));
    const match = server.host.authenticate(m.tokens!.nw!)!.match;
    const root = await join(sdk, m.roomId, m.tokens!.nw!);
    const agent = await join(sdk, m.roomId, match.mintSeatToken('nw', 'depths'));
    const spectator = await join(sdk, m.roomId, match.mintSpectatorToken('nw').token);
    try {
      const claims = { roles: [...PLANES], queuePriority: true, team: 'se', kind: 'team' };
      expect(await requestAuthority(root)).toEqual({ roles: [...PLANES], queuePriority: true });
      expect(await requestAuthority(agent, claims)).toEqual({ roles: ['depths'], queuePriority: false });
      expect(await requestAuthority(spectator, claims)).toEqual({ roles: [], queuePriority: false });
      const items = { surface: 'tank', depths: 'digger', sky: 'interceptor', orbit: 'skiff' } as const;
      for (const [seq, role] of PLANES.entries()) {
        root.room.send(MSG.call, { op: 'call', seq, role, method: 'act', args: { intents: [{ kind: 'queue_add', item: items[role] }] } });
        const result = await until(() => root.inbox.find(({ msg }) => msg.op === 'result' && msg.seq === seq));
        expect(result.msg).toMatchObject({ ok: true, data: [{ ok: true }] });
      }
      expect(match.view('nw').queue).toEqual(PLANES.map((role) => expect.objectContaining({ plane: role, item: items[role] })));
      expect(match.view('se').queue).toEqual([]);
      const entries = match.replay().entries.filter((entry) => entry[3] === 'intent');
      expect(entries).toHaveLength(PLANES.length);
      for (const entry of entries) {
        expect(entry[5]).toBe('owner');
        expect(entry[6]).toEqual([...PLANES]);
      }
      expect(JSON.stringify(await match.seat('nw', 'surface').observe())).not.toContain('operator:');
    } finally {
      await Promise.all([root, agent, spectator].map((conn) => conn.room.leave()));
    }
  });

  it('creates seeded matches on a chosen terrain, pauses, steps and changes speed', async () => {
    const m = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'bots', opponent: 'novice', seed: 7, rules: { terrain: 'canyons' }, speed: 0 } }));
    expect(m).toMatchObject({ mode: 'bots', tick: 0, speed: 0, seed: 7, terrain: 'canyons', outcomes: { nw: 'running', se: 'running' } });
    expect(server.host.authenticate(m.tokens!.nw!)!.match.view('nw').match?.preset).toBe('canyons');
    expect((await dev(base, '/dev/matches', { body: { mode: 'bots', rules: { terrain: 'moon' } } })).status).toBe(400);
    expect(m.seats.nw!.surface).toBe('human');
    expect(server.host.authenticate(m.tokens!.se!)?.principal).toMatchObject({ kind: 'team', team: 'se' });
    expect(server.host.authenticate(m.tokens!.spectator!)?.principal).toMatchObject({ kind: 'spectator' });
    expect(server.host.authenticate(m.tokens!.nw!)!.match.replay().seed).toBe(7);

    // The room clock is real time (20 Hz); a paused match must not move across several room ticks.
    await sleep(150);
    expect((await ok<MatchInfo>(dev(base, `/dev/matches/${m.roomId}`))).tick).toBe(0);
    expect(await ok(dev(base, `/dev/matches/${m.roomId}/step`, { body: { ticks: 25 } }))).toMatchObject({ from: 0, tick: 25 });
    expect((await ok<God>(dev(base, `/dev/matches/${m.roomId}/god`))).tick).toBe(25);

    await ok(dev(base, `/dev/matches/${m.roomId}/speed`, { body: { speed: 10 } }));
    expect((await dev(base, `/dev/matches/${m.roomId}/step`, { body: { ticks: 1 } })).status).toBe(409);
    const running = await until(async () => {
      const info = await ok<MatchInfo>(dev(base, `/dev/matches/${m.roomId}`));
      return info.tick > 25 + 10 && info;
    });
    expect(running.speed).toBe(10);

    await ok(dev(base, `/dev/matches/${m.roomId}/speed`, { body: { speed: 0 } }));
    await sleep(100); // let an in-flight room step finish
    const paused = (await ok<MatchInfo>(dev(base, `/dev/matches/${m.roomId}`))).tick;
    await sleep(150);
    expect((await ok<MatchInfo>(dev(base, `/dev/matches/${m.roomId}`))).tick).toBe(paused);

    for (const speed of [-1, 51, 1.5, '2']) expect((await dev(base, `/dev/matches/${m.roomId}/speed`, { body: { speed } })).status).toBe(400);
    expect((await dev(base, `/dev/matches/${m.roomId}/step`, { body: { ticks: 0 } })).status).toBe(400);
    expect((await dev(base, '/dev/matches/nope/god')).status).toBe(404);

    const list = await ok<{ matches: MatchInfo[] }>(dev(base, '/dev/matches'));
    const listed = list.matches.find((x) => x.roomId === m.roomId);
    expect(listed).toMatchObject({ mode: 'bots', speed: 0 });
    expect(listed!.tokens).toBeUndefined();
  });

  it('cheats change the sim', async () => {
    const m = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'agents', seed: 3, speed: 0 } }));
    const at = (p: string) => `/dev/matches/${m.roomId}${p}`;
    const cheat = (body: Record<string, unknown>) => ok<Record<string, unknown>>(dev(base, at('/cheat'), { body }));
    const god = (q = '') => ok<God>(dev(base, at(`/god${q}`)));

    const before = await god();
    await cheat({ op: 'give', army: 'nw', alloy: 1000, energy: 500 });
    const rich = await god();
    expect(rich.armies.nw!.alloy).toBe(before.armies.nw!.alloy + 1000);
    expect(rich.armies.nw!.energy).toBe(before.armies.nw!.energy + 500);

    // A spawn names its entities as the spawning army does (`ids`, for its views and orders) and by sim id (`simIds`, for
    // god views and damage/kill).
    type Spawned = { plane: string; ids: string[]; simIds: string[] };
    const spawned = (await cheat({ op: 'spawn', army: 'se', kind: 'tank', x: 24, y: 24, count: 3 })) as Spawned;
    expect(spawned.ids).toHaveLength(3);
    expect(spawned.simIds).toHaveLength(3);
    const ents = (await god('?plane=surface&detail=entities')).entities!;
    const tanks = ents.filter((e) => spawned.simIds.includes(e.id));
    expect(tanks.map((e) => [e.kind, e.side, e.plane])).toEqual(Array(3).fill(['tank', 'se', 'surface']));
    expect(tanks.every((e) => Math.hypot(e.x - 24, e.y - 24) < 3)).toBe(true);
    expect(ents.every((e) => e.plane === 'surface')).toBe(true);
    expect((await god('?plane=surface')).armies.se!.units.surface!.tank).toBe((before.armies.se!.units.surface!.tank ?? 0) + 3);
    expect((await dev(base, at('/cheat'), { body: { op: 'spawn', army: 'se', kind: 'tank', x: 24, y: 24, plane: 'sky' } })).status).toBe(400);
    // Surface units can stand in the depths too (transfer, breach, falling through holes); structures cannot.
    const down = (await cheat({ op: 'spawn', army: 'nw', kind: 'trooper', x: 8.5, y: 8.5, plane: 'depths', count: 2 })) as Spawned;
    expect(down.plane).toBe('depths');
    const deep = (await god('?plane=depths&detail=entities')).entities!.filter((e) => down.simIds.includes(e.id));
    expect(deep.map((e) => [e.kind, e.side, e.plane])).toEqual(Array(2).fill(['trooper', 'nw', 'depths']));
    for (const [kind, plane] of [
      ['turret', 'depths'],
      ['digger', 'surface'],
      ['interceptor', 'orbit'],
    ] as const) {
      expect((await dev(base, at('/cheat'), { body: { op: 'spawn', army: 'nw', kind, x: 8, y: 8, plane } })).status).toBe(400);
    }

    const turret = (await cheat({ op: 'spawn', army: 'nw', kind: 'turret', x: 12, y: 12 })) as Spawned;
    await cheat({ op: 'damage', id: spawned.simIds[0], amount: 100 });
    await cheat({ op: 'kill', id: spawned.simIds[1] });
    await cheat({ op: 'spire', army: 'se', plane: 'sky', hp: 1234 });
    await ok(dev(base, at('/step'), { body: { ticks: 1 } }));
    const after = (await god('?detail=entities')).entities!;
    expect(after.find((e) => e.id === spawned.simIds[0])?.hp).toBe(200);
    expect(after.find((e) => e.id === spawned.simIds[1])).toBeUndefined();
    expect(after.find((e) => e.id === turret.simIds[0])).toMatchObject({ kind: 'turret', side: 'nw', hp: 400 });
    const seView = server.host.authenticate(m.tokens!.se!)!.match.view('se').entities;
    expect([spawned.ids[0], spawned.ids[2]].map((id) => seView.find((e) => e.id === id)?.kind)).toEqual(['tank', 'tank']);
    expect(seView.some((e) => e.id === spawned.ids[1])).toBe(false);
    expect((await god()).armies.se!.spire.sky).toBe('1234/2500');

    // Reveal: se's own fogged view now contains every nw entity.
    const match = server.host.authenticate(m.tokens!.se!)!.match;
    const blueCount = after.filter((e) => e.side === 'nw').length;
    expect(match.view('se').entities.filter((e) => e.side === 'nw').length).toBeLessThan(blueCount);
    await cheat({ op: 'reveal', army: 'se' });
    await ok(dev(base, at('/step'), { body: { ticks: 2 } }));
    const shown = match.view('se').entities.filter((e) => e.side === 'nw').length;
    const now = (await god('?detail=entities')).entities!.filter((e) => e.side === 'nw').length;
    expect(shown).toBe(now);

    expect(await ok(dev(base, at('/end'), { body: { winner: 'se' } }))).toMatchObject({ outcomes: { nw: 'loss', se: 'win' } });
    expect((await dev(base, at('/cheat'), { body: { op: 'give', army: 'nw', alloy: 1 } })).status).toBe(409);
  });

  // Regression: views used to go out once per game tick, so at speed N a browser got N× the realtime rate (a step of
  // thousands of ticks, thousands of views), backed up its socket and was dropped as unresponsive ("Match closed.").
  it('sends clients at most one view per room tick, at any speed and through big steps', async () => {
    const m = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'bots', seed: 5, speed: 0 } }));
    const conn = await join(sdk, m.roomId, m.tokens!.nw!);
    const views = () => conn.viewTicks;
    await until(() => views().length > 0); // the join keyframe

    await ok(dev(base, `/dev/matches/${m.roomId}/step`, { body: { ticks: 600 } }));
    await until(() => views().at(-1) === 600);
    expect(views().length).toBeLessThanOrEqual(3);

    const before = views().length;
    await ok(dev(base, `/dev/matches/${m.roomId}/speed`, { body: { speed: 10 } }));
    await sleep(1000);
    await ok(dev(base, `/dev/matches/${m.roomId}/speed`, { body: { speed: 0 } }));
    await sleep(200); // let an in-flight room step finish
    const tick = (await ok<MatchInfo>(dev(base, `/dev/matches/${m.roomId}`))).tick;
    // ~20 room ticks of 10 game ticks each: one view per room tick, not one per game tick.
    expect(tick - 600).toBeGreaterThan(50);
    await until(() => views().at(-1) === tick);
    const sent = views().length - before;
    expect(sent).toBeGreaterThan(3);
    expect(sent).toBeLessThanOrEqual(26);
    expect(sent).toBeLessThan((tick - 600) / 2);
    expect(conn.gaps).toBe(0);
    void conn.room.leave();
  }, 30_000);

  it('holds views back from a client that has not read the previous ones, and resumes once it has', async () => {
    const m = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'bots', seed: 6, speed: 0 } }));
    const conn = await join(sdk, m.roomId, m.tokens!.nw!);
    const ticks = () => conn.viewTicks;
    const views = () => ticks().length;
    await until(() => views() > 0);
    // Swallow this connection's pongs on the server side: a client that stopped reading its socket never answers.
    const ws = matchMaker.getLocalRoomById(m.roomId)!.clients[0]!.ref;
    const emit = ws.emit.bind(ws);
    let reading = false;
    let heldPong: Buffer | undefined;
    ws.emit = (event: string | symbol, ...args: unknown[]) => {
      if (event === 'pong' && !reading) {
        const data = args[0];
        if (Buffer.isBuffer(data) && data.toString().startsWith('playerthree:view:')) heldPong = data;
        return false;
      }
      return emit(event, ...args);
    };
    // Each flush of views ends with one tagged ping: count flushes, not messages (a flush carries every missed delta).
    // The ws transport's client ref is a `ws` WebSocket; Colyseus types it as a plain EventEmitter.
    const socket = ws as typeof ws & { ping(...args: unknown[]): void };
    let flushes = 0;
    const ping = socket.ping.bind(socket);
    socket.ping = (...args: unknown[]) => {
      if (Buffer.isBuffer(args[0]) && args[0].toString().startsWith('playerthree:view:')) flushes++;
      ping(...args);
    };

    const before = views();
    await ok(dev(base, `/dev/matches/${m.roomId}/speed`, { body: { speed: 5 } }));
    await until(async () => (await ok<MatchInfo>(dev(base, `/dev/matches/${m.roomId}`))).tick > 60);
    await sleep(200);
    // One flush went out (and its ping); nothing more until the client reads it.
    expect(flushes).toBe(1);
    const held = views();
    expect(held).toBeGreaterThan(before);
    await sleep(200);
    expect(views()).toBe(held);
    expect(conn.inbox.some((x) => x.type === MSG.seats)).toBe(true);
    // Paused while held back: once the client reads, it still gets the latest state.
    await ok(dev(base, `/dev/matches/${m.roomId}/speed`, { body: { speed: 0 } }));
    await sleep(200); // let an in-flight room step finish
    const tick = (await ok<MatchInfo>(dev(base, `/dev/matches/${m.roomId}`))).tick;
    expect(ticks().at(-1)).toBeLessThan(tick);

    reading = true;
    expect(heldPong).toBeDefined();
    ws.emit('pong', heldPong);
    await until(() => ticks().at(-1) === tick);
    await sleep(200);
    // One more flush brought it to the latest state (the missed deltas, or one keyframe), and only once.
    expect(flushes).toBe(2);
    const caught = views();
    await sleep(200);
    expect(views()).toBe(caught);
    expect(conn.gaps).toBe(0);
    void conn.room.leave();
  }, 30_000);

  it('ends a match as a draw by default', async () => {
    const m = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'bots' } }));
    expect(m.speed).toBe(1);
    expect(await ok(dev(base, `/dev/matches/${m.roomId}/end`, { body: {} }))).toMatchObject({ outcomes: { nw: 'draw', se: 'draw' } });
  });

  it('ends a match with a winner over the match teams', async () => {
    const m = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'bots' } }));
    expect(await ok(dev(base, `/dev/matches/${m.roomId}/end`, { body: { winner: 'se' } }))).toMatchObject({ outcomes: { nw: 'loss', se: 'win' } });
    expect(await ok<MatchInfo>(dev(base, `/dev/matches/${m.roomId}`))).toMatchObject({ outcomes: { nw: 'loss', se: 'win' } });
  });

  it('creates four-army FFA matches: armies, distinct colours, per-army tokens and cheats, a winning army', async () => {
    const m = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'ffa', seed: 9, speed: 0, colours: ['violet', 'green', 'red', 'blue'] } }));
    expect(m).toMatchObject({ mode: 'ffa', outcomes: { nw: 'running', ne: 'running', se: 'running', sw: 'running' } });
    expect(m.armies).toEqual([{ id: 'nw', colour: 'violet' }, { id: 'ne', colour: 'green' }, { id: 'se', colour: 'red' }, { id: 'sw', colour: 'blue' }]);
    expect(Object.keys(m.tokens!).sort()).toEqual(['ne', 'nw', 'se', 'spectator', 'sw']);
    expect([m.seats.nw!.surface, m.seats.ne!.surface, m.seats.sw!.orbit]).toEqual(['human', 'bot', 'bot']);
    const at = (p: string) => `/dev/matches/${m.roomId}${p}`;
    const before = await ok<God>(dev(base, at('/god')));
    expect(Object.fromEntries(Object.entries(before.armies).map(([id, army]) => [id, army.colour]))).toEqual({ nw: 'violet', ne: 'green', se: 'red', sw: 'blue' });
    await ok(dev(base, at('/cheat'), { body: { op: 'give', army: 'sw', alloy: 300 } }));
    expect((await ok<God>(dev(base, at('/god')))).armies.sw!.alloy).toBe(before.armies.sw!.alloy + 300);
    expect((await dev(base, at('/cheat'), { body: { op: 'give', army: 'blue', alloy: 1 } })).status).toBe(400);

    const three = await ok<MatchInfo>(dev(base, '/dev/matches', { body: { mode: 'ffa', armies: 3, speed: 0 } }));
    expect(three.armies).toEqual([{ id: 'nw', colour: 'blue' }, { id: 'ne', colour: 'red' }, { id: 'se', colour: 'green' }]);
    for (const body of [
      { mode: 'ffa', colours: ['blue', 'blue', 'red', 'green'] },
      { mode: 'ffa', colours: ['blue', 'red'] },
      { mode: 'ffa', armies: 5 },
      { mode: 'ffa', map: 'crown' },
      { mode: 'bots', armies: 4 },
    ]) expect((await dev(base, '/dev/matches', { body })).status, JSON.stringify(body)).toBe(400);

    expect(await ok(dev(base, at('/end'), { body: { winner: 'ne' } }))).toMatchObject({ outcomes: { nw: 'loss', ne: 'win', se: 'loss', sw: 'loss' } });
  });
});
