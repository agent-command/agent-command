/**
 * Cluster mode (REDIS_URL): configuration checks always; the two-process suite (two real servers sharing one Redis)
 * only when `AC_TEST_REDIS_URL` names a disposable Redis (e.g. a local `redis-server`), whose `ac:cluster:*` and
 * Colyseus keys it uses live.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { Client as SdkClient, type Room as SdkRoom } from '@colyseus/sdk';
import type { LobbySnapshot } from '@agent-command/game/lobby';
import type { ObserverFrame } from 'playerthree/protocol';
import { loadConfig } from '../src/config.ts';
import { freshIp, join, json, lobbyEnter, lobbyRoute, postLobby, until, webDist, type AttachedLobby } from './helpers.ts';

const REDIS_URL = process.env.AC_TEST_REDIS_URL;
const SECRET = randomBytes(32).toString('base64url');
/** Client rooms left before the servers stop, so the SDK does not try to reconnect during teardown. */
const opened: SdkRoom[] = [];

interface Node {
  child: ChildProcessWithoutNullStreams;
  base: string;
  internal: string;
  id: string;
  output: () => string;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const { port } = server.address() as { port: number };
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

async function startNode(dist: string, overrides: Record<string, string> = {}): Promise<Node> {
  const [port, clusterPort] = [await freePort(), await freePort()];
  const internal = `http://127.0.0.1:${clusterPort}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', TRUST_PROXY: '1', PUBLIC_URL: '', DATABASE_URL: '',
      DATA_DIR: '', HISTORY_DIR: '', PLAYERTHREE_DEVTOOLS: '0', RULES_FILE: '', RULES_JSON: '', WEB_DIST: dist, FEATURED_MATCH: '0',
      // One worker slot per node: the second concurrent worker match must be placed on the other node.
      SIM_WORKERS: '1', MATCHES_PER_WORKER: '1', ADMISSION_LAG_MS: '1000',
      REDIS_URL, CLUSTER_SECRET: SECRET, CLUSTER_PORT: String(clusterPort), CLUSTER_HOST: '127.0.0.1', CLUSTER_ADDRESS: internal,
      ...overrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  await until(() => {
    if (child.exitCode !== null) throw new Error(output);
    return /agent-command server on :\d+/.test(output);
  }, 30_000);
  const id = /cluster: node ([0-9a-f]{24}) at/.exec(output)?.[1];
  if (!id) throw new Error(output);
  return { child, base: `http://127.0.0.1:${port}`, internal, id, output: () => output };
}

async function stopNode(node: Node | undefined): Promise<void> {
  if (!node || node.child.exitCode !== null || node.child.signalCode !== null) return;
  const exited = Promise.withResolvers<void>();
  node.child.once('exit', () => exited.resolve());
  node.child.kill('SIGINT');
  await exited.promise;
}

/** The leader's lobby, created on `creator`, then joined, attached and started entirely through `edge`. */
async function lobbyThrough(creator: string, edge: string, setup: Record<string, unknown> = { mapId: 'open', layoutId: 'duel' }): Promise<AttachedLobby> {
  const created = await postLobby(creator, { ...setup, visibility: 'private', preset: 'play', autoStart: true });
  expect(created.status).toBe(200);
  const { code, visitorToken } = await json<{ code: string; visitorToken: string }>(created);
  const authorization = `Visitor ${visitorToken}`;
  const joined = await fetch(`${edge}/api/lobbies/join`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ code }),
  });
  expect(joined.status).toBe(200);
  const grant = await json<{ roomId: string; token: string }>(await lobbyRoute(edge, code, 'connect', authorization));
  const sdk = new SdkClient(edge);
  const lobby = await sdk.joinById(grant.roomId, { token: grant.token });
  opened.push(lobby);
  const snapshots: LobbySnapshot[] = [];
  lobby.onMessage('lobby:snapshot', (snapshot: LobbySnapshot) => snapshots.push(snapshot));
  return { code, authorization, sdk, lobby, snapshots, setCookie: null };
}

/** A second visitor joins the started lobby as an observer through `edge` and watches the match there. */
async function observeThrough(edge: string, code: string) {
  const connected = await fetch(`${edge}/api/lobbies/directory/connect`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{}',
  });
  expect(connected.status).toBe(200);
  const directory = await json<{ roomId: string; token: string; visitorToken: string }>(connected);
  const sdk = new SdkClient(edge);
  const directoryRoom = await sdk.joinById(directory.roomId, { token: directory.token });
  const listed = Promise.withResolvers<void>();
  directoryRoom.onMessage('lobby:list', () => listed.resolve());
  await listed.promise;
  const authorization = `Visitor ${directory.visitorToken}`;
  const joined = await fetch(`${edge}/api/lobbies/join`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ code, observer: true }),
  });
  expect(joined.status).toBe(200);
  const ticket = await json<{ roomId: string; token: string; observer: boolean }>(await lobbyRoute(edge, code, 'ticket', authorization));
  expect(ticket.observer).toBe(true);
  const watcher = await join(sdk, ticket.roomId, ticket.token);
  opened.push(watcher.room);
  await until(() => watcher.inbox.length > 0, 15_000);
  await directoryRoom.leave();
  return watcher;
}

describe('cluster configuration', () => {
  const env = { REDIS_URL: 'redis://127.0.0.1:6379', CLUSTER_SECRET: 's'.repeat(32), CLUSTER_PORT: '3601', CLUSTER_ADDRESS: 'http://127.0.0.1:3601' };

  it('is absent without REDIS_URL and refuses stray cluster settings', () => {
    expect(loadConfig({}).cluster).toBeUndefined();
    expect(() => loadConfig({ CLUSTER_PORT: '3601' })).toThrow('require REDIS_URL');
  });

  it('validates the URL, secret, internal port and address', () => {
    expect(loadConfig(env).cluster).toEqual({ redisUrl: env.REDIS_URL, secret: env.CLUSTER_SECRET, port: 3601, host: '0.0.0.0', address: 'http://127.0.0.1:3601' });
    expect(loadConfig({ ...env, CLUSTER_ADDRESS: 'http://[fd12::1]:3601' }).cluster?.host).toBe('::');
    expect(() => loadConfig({ ...env, REDIS_URL: 'http://x' })).toThrow('REDIS_URL');
    expect(() => loadConfig({ ...env, CLUSTER_SECRET: 'short' })).toThrow('CLUSTER_SECRET');
    expect(() => loadConfig({ ...env, CLUSTER_SECRET: undefined })).toThrow('CLUSTER_SECRET');
    expect(() => loadConfig({ ...env, CLUSTER_PORT: undefined })).toThrow('CLUSTER_PORT');
    expect(() => loadConfig({ ...env, PORT: '3601' })).toThrow('CLUSTER_PORT must differ');
    expect(() => loadConfig({ ...env, CLUSTER_ADDRESS: 'https://node:3601/x' })).toThrow('CLUSTER_ADDRESS');
  });
});

describe.skipIf(!REDIS_URL)('cluster mode (two processes, one Redis)', () => {
  let redis: Redis;
  let a: Node | undefined;
  let b: Node | undefined;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!);
    // A previous run's lease must lapse first so node A deterministically becomes the primary.
    await until(async () => await redis.get('ac:cluster:primary') === null, 10_000);
    const dist = webDist();
    a = await startNode(dist);
    expect(await redis.get('ac:cluster:primary')).toBe(a.id);
    b = await startNode(dist);
    // Both nodes see each other's heartbeat (the primary reports every node's workers).
    await until(async () => (await json<{ workers: { node: string }[] }>(await fetch(`${b!.base}/api/capacity`))).workers
      .map((worker) => worker.node).sort().join() === [a!.id, b!.id].sort().join(), 10_000);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(opened.map((room) => room.leave()));
    await stopNode(b);
    await stopNode(a);
    if (a) {
      expect(await redis.get('ac:cluster:primary')).toBeNull();
      expect(await redis.sismember('ac:cluster:nodes', a.id)).toBe(0);
    }
    redis.disconnect();
  }, 30_000);

  it('keeps cluster RPC off the public listener and requires the secret on the internal one', async () => {
    const rpc = { op: 'abandonOwner', ownerKey: 'visitor:x' };
    const publicCall = await fetch(`${b!.base}/_cluster/sim`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ac-cluster-secret': SECRET }, body: JSON.stringify(rpc),
    });
    expect(publicCall.status).toBe(404);
    for (const secret of [undefined, 'x'.repeat(43)]) {
      const internalCall = await fetch(`${b!.internal}/_cluster/sim`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-ac-cluster-secret': secret } : {}) }, body: JSON.stringify(rpc),
      });
      expect(internalCall.status).toBe(403);
    }
    const forwarded = await fetch(`${b!.internal}/api/maps`, { headers: { 'x-forwarded-for': freshIp() } });
    expect(forwarded.status).toBe(403);
  });

  // Placement follows worker load (CPU or slots, ties local), so the first match may land on either node. Each node
  // has one worker slot: while the first match lives, the primary must place the second on the other node.
  let firstHost: string | undefined;

  it('serves a lobby created on node A end to end through node B', async () => {
    const lobby = await lobbyThrough(a!.base, b!.base);
    const entered = await lobbyEnter(b!.base, lobby, 20_000);
    opened.push(...entered.connections.map((connection) => connection.room));
    firstHost = await redis.hget('ac:cluster:rooms', entered.roomId) ?? undefined;
    expect([a!.id, b!.id]).toContain(firstHost);
    const view = entered.connections.flatMap((connection) => connection.inbox).find(({ msg }) => msg.op === 'view');
    expect(view?.type).toBe('playerthree:view');
    const watcher = await observeThrough(b!.base, lobby.code);
    expect(watcher.room.roomId).toBe(entered.roomId);
  }, 60_000);

  it('places the next worker match on the other node and proxies it from both edges', async () => {
    expect(firstHost).toBeDefined();
    const lobby = await lobbyThrough(a!.base, b!.base);
    const entered = await lobbyEnter(b!.base, lobby, 20_000);
    opened.push(...entered.connections.map((connection) => connection.room));
    const host = await redis.hget('ac:cluster:rooms', entered.roomId);
    expect(host).toBe(firstHost === a!.id ? b!.id : a!.id);
    const views = entered.connections.flatMap((connection) => connection.inbox).filter(({ type, msg }) => type === 'playerthree:view' && msg.op === 'view');
    expect(views.length).toBeGreaterThan(0);
    // The observer's ticket and match socket go through the primary this time.
    const watcher = await observeThrough(a!.base, lobby.code);
    expect(watcher.room.roomId).toBe(entered.roomId);
    // Peer worker counts arrive with the next one-second heartbeat.
    await until(async () => (await json<{ workers: { node: string; active: number }[] }>(await fetch(`${b!.base}/api/capacity`))).workers
      .filter((worker) => worker.active > 0).map((worker) => worker.node).sort().join() === [a!.id, b!.id].sort().join(), 5000);
  }, 60_000);

  it('a live primary re-takes its lease in place when Redis loses the key (a peer never races it)', async () => {
    await redis.del('ac:cluster:primary');
    const seen = new Set<string | null>();
    await until(async () => {
      const holder = await redis.get('ac:cluster:primary');
      seen.add(holder);
      return holder === a!.id;
    }, 5000);
    expect(seen.has(b!.id)).toBe(false);
  });

  // Last: it leaves node A draining. A deploy's old primary must not hold new lobbies hostage for its whole drain.
  it('a draining primary hands the lease on at once and the other node takes new lobbies', async () => {
    a!.child.kill('SIGTERM');
    await until(async () => await redis.get('ac:cluster:primary') === b!.id, 5000);
    const created = await postLobby(b!.base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play' });
    expect(created.status).toBe(200);
  });
});

describe.skipIf(!REDIS_URL)('cluster mode with four-army matches', () => {
  let redis: Redis;
  let a: Node | undefined;
  let b: Node | undefined;
  /** A 60 s four-army FFA (human nw, bots elsewhere): long enough to forfeit and spectate, short enough to finish. */
  const FFA = { mapId: 'four_corners', layoutId: 'ffa', rules: { spire: { timeCap: 60 } } };
  const workers = async (edge: string) => (await json<{ workers: { node: string; active: number; capacity: number }[] }>(await fetch(`${edge}/api/capacity`))).workers;
  let first: { lobby: AttachedLobby; roomId: string; host: string; connections: { room: SdkRoom }[] } | undefined;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!);
    await until(async () => await redis.get('ac:cluster:primary') === null, 10_000);
    const dist = webDist();
    // Three duel units per worker: one four-army match (2.4) fits a node, a second one does not. Absent humans are
    // forfeited after the shortest recovery window.
    const env = { MATCHES_PER_WORKER: '3', LOBBY_RECOVERY_SECONDS: '5' };
    a = await startNode(dist, env);
    b = await startNode(dist, env);
    await until(async () => (await workers(b!.base)).map((worker) => worker.node).sort().join() === [a!.id, b!.id].sort().join(), 10_000);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(opened.map((room) => room.leave()));
    await stopNode(b);
    await stopNode(a);
    redis.disconnect();
  }, 30_000);

  it('places a four-army match by its 2.4 load, skips a node without room for all of it, and queues when none has', async () => {
    const lobby = await lobbyThrough(a!.base, b!.base, FFA);
    const entered = await lobbyEnter(b!.base, lobby, 30_000);
    const host = await redis.hget('ac:cluster:rooms', entered.roomId);
    expect([a!.id, b!.id]).toContain(host);
    first = { lobby, roomId: entered.roomId, host: host!, connections: entered.connections };
    // Both nodes account the hosting worker at 2.4 of its 3 units (the peer's view arrives with its heartbeat).
    for (const edge of [a!.base, b!.base]) {
      await until(async () => (await workers(edge)).find((worker) => worker.node === host)?.active === 2.4, 5000);
    }
    // 0.6 units are left there: the next four-army match must go to the other node.
    const second = await lobbyThrough(b!.base, a!.base, FFA);
    const placed = await lobbyEnter(a!.base, second, 30_000);
    opened.push(...placed.connections.map((connection) => connection.room));
    expect(await redis.hget('ac:cluster:rooms', placed.roomId)).toBe(host === a!.id ? b!.id : a!.id);
    // Neither node has 2.4 free now: a third waits in the admission queue instead of overbooking.
    const third = await lobbyThrough(a!.base, b!.base, FFA);
    await until(() => third.snapshots.some((snapshot) => snapshot.queuePosition !== undefined), 15_000);
    expect(third.snapshots.some((snapshot) => snapshot.phase === 'started')).toBe(false);
    expect((await lobbyRoute(b!.base, third.code, 'leave', third.authorization)).status).toBe(204);
  }, 120_000);

  it('forfeits an absent human army on the remote match through the other node; the match goes on, the human spectates, outcomes arrive', async () => {
    expect(first).toBeDefined();
    const { lobby, roomId } = first!;
    // The human leaves the game (stays in the lobby): absence forfeits nw on the hosting node, the others play on.
    for (const connection of first!.connections) await connection.room.leave();
    const ticket = await until(async () => {
      const response = await fetch(`${b!.base}/api/lobbies/${lobby.code}/ticket`, {
        method: 'POST', headers: { authorization: lobby.authorization, 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ observer: true }),
      });
      return response.status === 200 ? await json<{ roomId: string; token: string; grant: { kind: string; teams: string[] } }>(response) : undefined;
    }, 30_000);
    expect(ticket.roomId).toBe(roomId);
    expect(ticket.grant).toMatchObject({ kind: 'omniscient', teams: ['nw', 'ne', 'se', 'sw'] });
    // A seat ticket for the forfeited army is refused, through the other node too.
    const seat = await lobbyRoute(b!.base, lobby.code, 'ticket', lobby.authorization);
    expect(seat.status).toBe(409); expect(await json(seat)).toEqual({ error: 'eliminated' });
    const watcher = await join(new SdkClient(b!.base), ticket.roomId, ticket.token);
    opened.push(watcher.room);
    // The socket carries observer messages; only the observer ones have a frame.
    const frames = (): ObserverFrame[] => watcher.inbox.flatMap(({ msg }) => 'frame' in msg && msg.frame ? [msg.frame as ObserverFrame] : []);
    // The match goes on without nw: frames keep advancing while ne, se and sw are still in play.
    await until(() => frames().length > 1 && frames().at(-1)!.tick > frames()[0]!.tick, 15_000);
    // At the 60 s cap the final outcomes of every army reach the observer, and the lobby, seeing the remote match
    // over, releases itself.
    const final = await until(() => frames().find((frame) => frame.outcomes && Object.values(frame.outcomes).every((outcome) => outcome !== 'running')), 90_000);
    expect(Object.keys(final.outcomes!).sort()).toEqual(['ne', 'nw', 'se', 'sw']);
    expect(final.outcomes!.nw).toBe('loss');
    await until(async () => (await lobbyRoute(b!.base, lobby.code, 'connect', lobby.authorization)).status === 404, 15_000);
  }, 150_000);
});
