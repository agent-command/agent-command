import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { Client as SdkClient } from '@colyseus/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MSG } from 'playerthree';
import { createPlayerThreeHost } from 'playerthree/host';
import { definition, PLANES, resolveRules, rulesOptions, slotArmyIds } from '@agent-command/game';
import { namedMap, registerNamedMap } from '@agent-command/game/maps';
import { MATCH_CLOSE } from '@agent-command/game/lobby';
import { loadConfig } from '../src/config.ts';
import { HttpError, sendJson } from '../src/http.ts';
import { SimulationPool, type SimulationLobbyRequest } from '../src/simulation-pool.ts';
import { join, requestAuthority, until } from './helpers.ts';

let pool: SimulationPool;
let gateway: Server;
let base: string;
let sdk: SdkClient;
const historyDir = mkdtempSync(joinPath(tmpdir(), 'ac-worker-history-'));
const created: string[] = [];
const released: number[] = [];

/** The default duel's armies: nw (blue) and se (red). */
const ARMIES = slotArmyIds(2);

function allocation(humans: readonly string[] = []): SimulationLobbyRequest {
  return {
    identity: 'worker-test', seed: 41, speed: 1, teams: ARMIES, alliances: { blue: ['nw'], red: ['se'] }, rules: rulesOptions(resolveRules()),
    observerPolicy: { allowOmniscient: true, minDelayMs: 180_000, public: true },
    assignments: ARMIES.flatMap((team) => PLANES.map((role) => ({
      team, role, owner: `visitor:${team}`, kind: humans.includes(`${team}/${role}`) ? 'human' as const : 'bot' as const,
    }))),
    botSeats: ARMIES.flatMap((team) => PLANES.filter((role) => !humans.includes(`${team}/${role}`)).map((role) => ({
      team, role, level: team === 'nw' ? 'standard' : 'novice', options: {},
    }))),
  };
}

/** The parent's HTTP/upgrade routing in front of a pool, as the game server provides it. */
interface Gateway { gateway: Server; base: string; sdk: SdkClient }
async function serve(target: SimulationPool): Promise<Gateway> {
  const server = createServer((req, res) => {
    void target.handle(req, res).then((handled) => {
      if (!handled) sendJson(res, 404, { error: 'not_found' });
    }).catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500, { error: 'failed' }));
  });
  server.on('upgrade', (req, socket, head) => {
    if (target.ownsUpgrade(req)) target.upgrade(req, socket, head);
    else socket.destroy();
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { gateway: server, base: url, sdk: new SdkClient(url) };
}
async function closeGateway(server: Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  server.closeAllConnections();
  await closed.promise;
}

beforeAll(async () => {
  registerNamedMap('worker_saved_map', { ...namedMap('crown')!, id: 'worker_saved_map', seed: 123 });
  pool = new SimulationPool({ ...loadConfig({}), host: '127.0.0.1', port: 0, trustProxy: true,
    historyDir, abandonGraceMs: 10_000, endGraceMs: 0 }, { workers: 2, matchesPerWorker: 1, onRelease: (duration) => released.push(duration) });
  await pool.start();
  ({ gateway, base, sdk } = await serve(pool));
}, 30_000);

afterEach(async () => {
  await Promise.all(created.splice(0).map((roomId) => pool.remove(roomId)));
  await until(() => pool.active === 0);
});
afterAll(async () => {
  await pool?.close();
  if (gateway) await closeGateway(gateway);
  rmSync(historyDir, { recursive: true, force: true });
});

describe('lobby simulation workers', () => {
  it('abandons an unattended started game and leaves its proxy terminal', async () => {
    const expiring = new SimulationPool({ ...loadConfig({}), host: '127.0.0.1', port: 0, abandonGraceMs: 50 }, { workers: 1, matchesPerWorker: 1 });
    let front: Gateway | undefined;
    try {
      await expiring.start();
      front = await serve(expiring);
      const remote = await expiring.createLobby({
        ...allocation(['nw/surface']),
        observerPolicy: { allowOmniscient: true, minDelayMs: 0, public: false },
      }, 'visitor:owner');
      // Starting requires the human to be ready and actually joined; the game is unattended once they leave.
      await remote.match.setHumanReady('nw', 'surface', true);
      const human = await join(front.sdk, remote.roomId, (await remote.match.mintHumanToken('nw', 'surface')).token);
      await until(() => remote.match.readiness().seats.every((seat) => seat.kind !== 'human' || seat.state === 'ready'));
      await remote.start();
      await human.room.leave(true);
      await until(() => expiring.active === 0);
      expect(remote.match.over).toBe(true);
      expect(remote.match.readiness().pending).toBe(false);
      await remote.close();
      expect(expiring.canCreate()).toBe(true);
      const benchmark = await expiring.createLobby({
        ...allocation(),
        observerPolicy: { allowOmniscient: true, minDelayMs: 0, public: false },
      });
      const admittedAt = Date.now();
      await until(() => expiring.stats().some((worker) => worker.sampledAt > admittedAt));
      expect(expiring.owns(benchmark.roomId)).toBe(true);
      expect(benchmark.match.over).toBe(false);
      await benchmark.close();
    } finally { await expiring.close(); if (front) await closeGateway(front.gateway); }
  }, 30_000);

  it('a worker the server closes tells its players why (update) and records the draw only after: no result reaches them', async () => {
    const closing = new SimulationPool({ ...loadConfig({}), host: '127.0.0.1', port: 0, historyDir, endGraceMs: 0 }, { workers: 1, matchesPerWorker: 1 });
    let front: Gateway | undefined;
    try {
      await closing.start();
      front = await serve(closing);
      const remote = await closing.createLobby(allocation(['nw/surface']), 'visitor:owner');
      await remote.match.setHumanReady('nw', 'surface', true);
      const human = await join(front.sdk, remote.roomId, (await remote.match.mintHumanToken('nw', 'surface')).token);
      const left = Promise.withResolvers<number>();
      human.room.onLeave((code) => left.resolve(code));
      await until(() => remote.match.readiness().seats.every((seat) => seat.kind !== 'human' || seat.state === 'ready'));
      await remote.start();
      await until(() => (human.viewTicks.at(-1) ?? 0) > 0, 10_000);
      await closing.close('update');
      expect(await left.promise).toBe(MATCH_CLOSE.update);
      expect(human.inbox.some(({ msg }) => msg.op === 'report')).toBe(false);
      expect([...human.views.values()].every(({ view }) => (view as { outcome: string }).outcome === 'running')).toBe(true);
    } finally { await closing.close(); if (front) await closeGateway(front.gateway); }
  }, 30_000);

  it('a lobby removing an undecided worker match closes it for its players without a result', async () => {
    const remote = await pool.createLobby(allocation(['nw/surface']), 'visitor:owner');
    created.push(remote.roomId);
    await remote.match.setHumanReady('nw', 'surface', true);
    const human = await join(sdk, remote.roomId, (await remote.match.mintHumanToken('nw', 'surface')).token);
    const left = Promise.withResolvers<number>();
    human.room.onLeave((code) => left.resolve(code));
    await until(() => remote.match.readiness().seats.every((seat) => seat.kind !== 'human' || seat.state === 'ready'));
    await remote.start();
    await until(() => (human.viewTicks.at(-1) ?? 0) > 0, 10_000);
    await pool.remove(remote.roomId);
    expect(await left.promise).toBe(MATCH_CLOSE.closed);
    expect(human.inbox.some(({ msg }) => msg.op === 'report')).toBe(false);
  }, 30_000);

  it('rejects canonical-host-only assignments before reserving worker capacity', async () => {
    const request = allocation();
    Object.assign(request.assignments[0]!, { kind: 'agent', commander: { id: 'cmd_named' } });
    await expect(pool.createLobby(request)).rejects.toMatchObject({ status: 400, code: 'unsupported_worker_assignment' });
    expect(pool.active).toBe(0);
  });
  it('preserves explicit delegated owner authority through worker creation and reassignment', async () => {
    const request = allocation();
    request.assignments.find((seat) => seat.team === 'nw' && seat.role === 'depths')!.ownerControl = true;
    const remote = await pool.createLobby(request);
    created.push(remote.roomId);
    const ticket = await remote.match.mintHumanToken('nw', 'depths');
    const owner = await join(sdk, remote.roomId, ticket.token);
    let disconnected = false;
    owner.room.onLeave(() => { disconnected = true; });
    try {
      expect(await requestAuthority(owner, { roles: [...PLANES], queuePriority: false, team: 'se' })).toEqual({ roles: ['depths'], queuePriority: true });
      await expect(remote.match.mintHumanToken('nw', 'sky')).rejects.toMatchObject({ code: 'forbidden' });
      await expect(remote.match.mintHumanToken('se', 'depths')).rejects.toMatchObject({ code: 'forbidden' });
      await remote.start();
      owner.room.send(MSG.call, { op: 'call', seq: 1, role: 'depths', method: 'act', args: { intents: [{ kind: 'queue_add', item: 'digger' }] } });
      const queued = await until(() => owner.inbox.find(({ msg }) => msg.op === 'result' && msg.seq === 1));
      expect(queued.msg).toMatchObject({ ok: true, data: [{ ok: true }] });
      await remote.match.renewHumanToken('nw', 'depths');
      await remote.match.assign({ team: 'nw', role: 'depths', owner: 'visitor:replacement', kind: 'bot' });
      await until(() => disconnected);
      await expect(remote.match.mintHumanToken('nw', 'depths')).rejects.toMatchObject({ code: 'forbidden' });
      await remote.match.assign({ team: 'nw', role: 'depths', owner: 'visitor:replacement', kind: 'bot', ownerControl: true });
      const replacement = await remote.match.mintHumanToken('nw', 'depths');
      await expect(sdk.joinById(remote.roomId, { token: ticket.token })).rejects.toThrow();
      const rejoined = await join(sdk, remote.roomId, replacement.token);
      try {
        expect(await requestAuthority(rejoined, { roles: [...PLANES], kind: 'team', team: 'se' }))
          .toEqual({ roles: ['depths'], queuePriority: true });
      } finally { await rejoined.room.leave(); }
    } finally { await owner.room.leave().catch(() => {}); }
  });
  it('reserves pending slots, balances hosts, and releases cancelled preparation', async () => {
    const first = pool.createLobby(allocation(['nw/surface']));

    const second = pool.createLobby(allocation());
    expect(pool.active).toBe(2);
    expect(pool.canCreate()).toBe(false);
    await expect(pool.createLobby(allocation())).rejects.toMatchObject({ status: 503 });
    const results = await Promise.all([first, second]);
    created.push(...results.map((result) => result.roomId));
    expect(pool.stats().map((worker) => worker.active)).toEqual([1, 1]);
    expect((await pool.snapshot(results[0]!.roomId)).seats.find((seat) => seat.team === 'nw' && seat.role === 'surface')?.controller).toBe('human');
    expect(results[0]!.localMatch).toBeUndefined();
    expect(results[0]!.match.cards()).toEqual([]);
    expect((await pool.snapshot(results[1]!.roomId)).views.every((view) => view.tick === 0)).toBe(true);
    await results[1]!.close();
    await results[1]!.close();
    created.pop();
    expect(results[1]!.match.over).toBe(true);
    expect(pool.canCreate()).toBe(true);
    expect(released.at(-1)).toBeGreaterThanOrEqual(0);
  });

  it('reclaims only the owner\'s unattended started games through the parent-held owner key', async () => {
    const owned = await pool.createLobby({ ...allocation(['nw/surface']), observerPolicy: { allowOmniscient: true, minDelayMs: 0, public: false } }, 'visitor:a');
    created.push(owned.roomId);
    // Lobby preparation is held by its lobby, never reclaimed by a restart.
    await pool.abandonOwner('visitor:a');
    expect(owned.match.over).toBe(false);
    await owned.match.setHumanReady('nw', 'surface', true);
    const human = await join(sdk, owned.roomId, (await owned.match.mintHumanToken('nw', 'surface', { ttlSeconds: 120 })).token);
    await until(() => owned.match.readiness().seats.every((seat) => seat.kind !== 'human' || seat.state === 'ready'));
    await owned.start();
    await until(() => human.inbox.some((packet) => packet.type === MSG.view));
    await pool.abandonOwner('visitor:a');
    expect(owned.match.over).toBe(false);
    await human.room.leave(true);
    await pool.abandonOwner('visitor:b');
    expect(owned.match.over).toBe(false);
    await pool.abandonOwner('visitor:a');
    expect(owned.match.over).toBe(true);
    expect(pool.owns(owned.roomId)).toBe(false);
    created.pop();
  });

  it('uses the unchanged deterministic SDK/bot/simulation pipeline after the held start', async () => {
    const request = allocation();
    const remote = await pool.createLobby(request);
    created.push(remote.roomId);
    expect(remote.match.readiness().pending).toBe(true);
    expect((await pool.snapshot(remote.roomId)).views[0]!.tick).toBe(0);
    await remote.start();
    const snapshot = await until(async () => {
      const value = await pool.snapshot(remote.roomId);
      return value.views[0]!.tick >= 4 ? value : false;
    });
    const host = createPlayerThreeHost({ definition });
    try {
      const controllers = Object.fromEntries(ARMIES.map((team) => [team, Object.fromEntries(PLANES.map((plane) => [plane, 'bot' as const]))]));
      const match = host.createMatch({ seed: request.seed, realtime: false, teams: request.teams, alliances: request.alliances, assignments: request.assignments,
        controllers, options: request.rules, botSeats: request.botSeats.map((seat) => ({ ...seat })) });
      await match.step(snapshot.views[0]!.tick);
      expect(ARMIES.map((team) => match.view(team))).toEqual(snapshot.views);
    } finally { host.dispose(); }
  });

  it('transfers host-saved named maps to simulation workers without exposing their document', async () => {
    const remote = await pool.createLobby({ ...allocation(), rules: { map: { name: 'worker_saved_map' } } });
    created.push(remote.roomId);
    const snapshot = await pool.snapshot(remote.roomId);
    expect(snapshot.views[0]!.match).toMatchObject({
      mapId: 'worker_saved_map', mapSeed: 123, preset: 'fortress', rules: { map: { size: 48 } },
    });
    expect(JSON.stringify(snapshot.views)).not.toMatch(/intGridRle|entityInstances|fieldInstances/);
  });

  it('requires trusted readiness and actual exact-seat joins for humans on independent sides', async () => {
    const remote = await pool.createLobby(allocation(['nw/surface', 'se/orbit']));
    created.push(remote.roomId);
    await remote.match.setHumanReady('nw', 'surface', true);
    await remote.match.setHumanReady('se', 'orbit', true);
    await expect(remote.start()).rejects.toMatchObject({ code: 'humans_not_ready' });
    expect((await pool.snapshot(remote.roomId)).views[0]!.tick).toBe(0);
    const blue = await remote.match.mintHumanToken('nw', 'surface');
    const red = await remote.match.mintHumanToken('se', 'orbit');
    const first = await join(sdk, remote.roomId, blue.token);
    const second = await join(sdk, remote.roomId, red.token);
    try {
      await until(() => remote.match.readiness().seats.filter((seat) => seat.kind === 'human').every((seat) => seat.state === 'ready'));
      first.room.send(MSG.controller, { op: 'controller', role: 'orbit', controller: 'agent', seq: 1 });
      const denied = await until(() => first.inbox.find((item) => item.msg.op === 'result' && item.msg.seq === 1));
      expect(denied.msg).toMatchObject({ op: 'result', ok: false, code: 'forbidden' });
      await remote.start();
      await until(async () => (await pool.snapshot(remote.roomId)).views[0]!.tick > 0);
      await second.room.leave();
      await until(() => remote.match.readiness().seats.some((seat) => seat.team === 'se' && seat.role === 'orbit' && seat.state !== 'ready'));
    } finally { await first.room.leave(); await second.room.leave(); }
  });

  it('renews, revokes, expires and match-scopes tickets without exposing team authority', async () => {
    const first = await pool.createLobby(allocation(['nw/surface']));
    const other = await pool.createLobby(allocation(['nw/surface']));
    created.push(first.roomId, other.roomId);
    const old = await first.match.mintHumanToken('nw', 'surface');
    const fresh = await first.match.mintHumanToken('nw', 'surface');
    const reserve = (roomId: string, token: string) => fetch(`${base}/matchmake/joinById/${roomId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    expect((await reserve(first.roomId, old.token)).status).toBe(401);
    expect((await reserve(other.roomId, fresh.token)).status).toBe(401);
    await first.match.revokeToken(fresh.token);
    expect((await reserve(first.roomId, fresh.token)).status).toBe(401);
    const expiring = await first.match.mintHumanToken('nw', 'surface', { ttlSeconds: 0.01 });
    await until(() => Date.now() >= expiring.expiresAt);
    expect((await reserve(first.roomId, expiring.token)).status).toBe(401);
    // In-place renewal crosses the worker boundary: a joined seat extends, an unclaimed bearer cannot.
    const joined = await first.match.mintHumanToken('nw', 'surface');
    await expect(first.match.renewHumanToken('nw', 'surface', { ttlSeconds: 600 })).rejects.toMatchObject({ code: 'bad_token' });
    const live = await join(sdk, first.roomId, joined.token);
    try { expect((await first.match.renewHumanToken('nw', 'surface', { ttlSeconds: 600 })).expiresAt).toBeGreaterThan(joined.expiresAt); }
    finally { await live.room.leave(); }
    const seat = await first.match.mintHumanToken('nw', 'surface');
    await first.match.revokeSeat('nw', 'surface');
    expect((await reserve(first.roomId, seat.token)).status).toBe(401);
    // Revoking a seat releases its exact-seat lease: no further human ticket can be minted for it.
    await expect(first.match.mintHumanToken('nw', 'surface')).rejects.toMatchObject({ code: 'forbidden' });
    await first.match.end('draw');
    expect(first.match.over).toBe(true);
  });

  it('enforces the authoritative public observer delay and read-only observer tickets', async () => {
    const remote = await pool.createLobby(allocation());
    created.push(remote.roomId);
    await expect(remote.match.mintObserverToken({ kind: 'omniscient', teams: [...ARMIES], delayMs: 0 }, { owner: 'visitor:observer' })).rejects.toBeInstanceOf(Error);
    const ticket = await remote.match.mintObserverToken({ kind: 'omniscient', teams: [...ARMIES], delayMs: 180_000 }, { owner: 'visitor:observer' });
    const observer = await join(sdk, remote.roomId, ticket.token);
    try {
      observer.room.send(MSG.controller, { op: 'controller', role: 'surface', controller: 'human', seq: 1 });
      const denied = await until(() => observer.inbox.find((item) => item.msg.op === 'result' && item.msg.seq === 1));
      expect(denied.msg).toMatchObject({ op: 'result', ok: false, code: 'forbidden' });
      await remote.match.revokeToken(ticket.token);
    } finally { await observer.room.leave(); }
  });

  it('retains released sessions in worker history and exposes tick delay telemetry', async () => {
    const remote = await pool.createLobby({ ...allocation(), featured: true });
    created.push(remote.roomId);
    await remote.start();
    await until(() => pool.stats().some((worker) => worker.tickSamples > 0));
    expect(pool.stats().every((worker) => worker.p99LagMs >= 0 && worker.maxDurationMs >= 0)).toBe(true);
    await remote.close();
    created.pop();
    const histories = await Promise.all([0, 1].map(async (worker) => {
      const history = await fetch(`${base}/playerthree/devtools/api/sessions?simulationWorker=${worker}`, { headers: { Host: 'localhost' } });
      expect(history.status).toBe(200);
      return history.json();
    }));
    expect(JSON.stringify(histories)).toContain('released');
  });

  it('stops admitting at drain without deleting held matches', async () => {
    const draining = new SimulationPool({ ...loadConfig({}), host: '127.0.0.1', port: 0 }, { workers: 1, matchesPerWorker: 2 });
    try {
      await draining.start();
      const remote = await draining.createLobby(allocation());
      draining.beginDrain();
      expect(draining.canCreate()).toBe(false);
      await expect(draining.createLobby(allocation())).rejects.toMatchObject({ status: 503 });
      expect((await draining.snapshot(remote.roomId)).ended).toBe(false);
      expect((await draining.snapshot(remote.roomId)).views[0]!.tick).toBe(0);
    } finally { await draining.close(); }
  }, 30_000);
});
