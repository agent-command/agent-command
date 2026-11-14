/**
 * Abuse cases through the real lobby handoff and Colyseus room binding: a public human seat socket, an observer and
 * a flooding client, each against a live match served by the same server the browser uses.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMessageBytes, Protocol } from '@colyseus/core';
import type { Client as SdkClient } from '@colyseus/sdk';
import { MSG, type ServerMsg } from 'playerthree';
import { definition, isUnitKind, PLANES, type AgentCommandGame } from '@agent-command/game';
import type { GameServer } from '../src/app.ts';
import type { GameMatch } from '../src/room.ts';
import { freshIp, json, join, lobbyAttach, lobbyEnter, lobbyHandoff, lobbyRoute, requestAuthority, start, until, type Conn } from './helpers.ts';

/** Every match's game: nw's orders name se's entities as nw names them (game sim/aliases.ts). */
const games: AgentCommandGame[] = [];
const create = definition.create.bind(definition);
vi.spyOn(definition, 'create').mockImplementation((options) => {
  const game = create(options) as AgentCommandGame;
  games.push(game);
  return game;
});

let server: GameServer;
let base: string;
let sdk: SdkClient;
describe('main-process room security', () => {
beforeAll(async () => { ({ server, base, sdk } = await start({ lobbyCountdownMs: 1000 })); });
afterAll(async () => { await server.close(); vi.restoreAllMocks(); });

const PLAY = { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true } as const;

let seq = 0;
async function request(conn: Conn, type: string, body: Record<string, unknown>): Promise<Extract<ServerMsg, { op: 'result' }>> {
  const s = ++seq;
  conn.room.send(type, { ...body, seq: s });
  const got = await until(() => conn.inbox.find(({ msg }) => msg.op === 'result' && msg.seq === s));
  return got.msg as Extract<ServerMsg, { op: 'result' }>;
}

/** A started play match: nw is every human seat (one socket per plane), se is all bots. */
async function playMatch() {
  const handoff = await lobbyHandoff(base, PLAY);
  const match = server.host.authenticate(handoff.token)!.match as GameMatch;
  const seat = (role: string) => handoff.connections[handoff.tickets.findIndex((ticket) => ticket.role === role)]!;
  return { ...handoff, match, seat };
}

describe('human seat sockets', () => {
  it('command only their own seat: enemy, other-plane, out-of-role and malformed orders are rejected unapplied', async () => {
    const { match, seat } = await playMatch();
    for (const role of PLANES) {
      expect(await requestAuthority(seat(role), { roles: [...PLANES], queuePriority: false, team: 'se', kind: 'team' }))
        .toEqual({ roles: [role], queuePriority: true });
    }
    const surface = seat('surface');
    const act = (intents: unknown) => request(surface, MSG.call, { op: 'call', role: 'surface', method: 'act', args: { intents } });
    const game = games.at(-1)!;
    const se = game.sim.ents.filter((e) => !e.dead && e.side === game.sim.armyIndex('se'));
    const nw = match.view('nw').entities;
    const enemyUnit = se.find((e) => isUnitKind(e.kind))!;
    const enemySpireUnit = se.find((e) => e.kind === 'spire')!;
    const ownDepths = nw.find((e) => e.side === 'nw' && e.plane === 'depths' && isUnitKind(e.kind))!;
    expect(enemyUnit && enemySpireUnit && ownDepths).toBeTruthy();
    // nw has a name for them, as if it had seen them once; they are out of its sight now.
    const army = game.sim.armyIndex('nw');
    for (const e of [enemyUnit, enemySpireUnit]) game.sim.giveAlias(army, e.id);
    const enemy = { id: game.entityId('nw', enemyUnit.id) };
    const enemySpire = { id: game.entityId('nw', enemySpireUnit.id) };
    // A corner no bot heads for: if the enemy order were applied, some se unit would target it.
    const spot = { x: 1.25, y: 1.25 };
    const rejected = (await act([
      { kind: 'move', units: [enemy.id], ...spot },
      { kind: 'move', units: [ownDepths.id], ...spot },
      { kind: 'stop', units: [enemySpire.id] },
      { kind: 'queue_add', item: 'digger', producer: enemySpire.id },
    ]));
    expect(rejected.ok).toBe(true);
    const acks = rejected.ok ? rejected.data as { ok: boolean; code?: string; gameCode?: string }[] : [];
    expect(acks).toHaveLength(4);
    for (const ack of acks) expect(ack).toMatchObject({ ok: false, code: 'game' });
    expect(acks[1]!.gameCode).toBe('wrong_plane');
    expect(acks[3]!.gameCode).toBe('wrong_plane');
    // The output-plane fence runs first; the authorized lane must still reject an opponent's producer.
    expect(await request(seat('depths'), MSG.call, {
      op: 'call', role: 'depths', method: 'act', args: { intents: [{ kind: 'queue_add', item: 'digger', producer: enemySpire.id }] },
    })).toMatchObject({ ok: true, data: [{ ok: false, code: 'game', gameCode: 'invalid_target' }] });
    // Depths-only intents never pass the role check, whatever the payload.
    expect(await act([{ kind: 'dig', units: [ownDepths.id], x: 5, y: 5 }])).toMatchObject({ ok: true, data: [{ ok: false, code: 'forbidden_role' }] });
    // Schema bounds: non-finite (msgpack carries NaN/Infinity), out-of-range, unknown kinds and prototype keys.
    const malformed = [
      { kind: 'rally', x: Number.NaN, y: 3 }, { kind: 'rally', x: Number.POSITIVE_INFINITY, y: 3 }, { kind: 'rally', x: -1, y: 3 },
      { kind: 'rally', x: 1e12, y: 3 }, { kind: 'teleport', x: 3, y: 3 }, { kind: 'rally', x: 3, y: 3, extra: 1 },
      JSON.parse('{"kind":"rally","x":3,"y":3,"__proto__":{"polluted":true}}') as unknown,
      { kind: 'move', units: Array.from({ length: 5000 }, () => enemy.id), x: 3, y: 3 },
    ];
    const bad = await act(malformed);
    expect(bad).toMatchObject({ ok: true, data: malformed.map(() => ({ ok: false, code: 'invalid' })) });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await act(Array.from({ length: 65 }, () => ({ kind: 'stop', units: [] })))).toMatchObject({ ok: false, code: 'invalid' });
    // Another plane of the same team needs that plane's own ticket: this socket may not act, steer or speak for it.
    for (const [type, body] of [
      [MSG.call, { op: 'call', role: 'depths', method: 'act', args: { intents: [{ kind: 'stop', units: [ownDepths.id] }] } }],
      [MSG.controller, { op: 'controller', role: 'depths', controller: 'bot' }],
      [MSG.mint, { op: 'mint', role: 'depths' }],
      [MSG.mandate, { op: 'mandate', role: 'depths', mandate: { autonomy: 'autonomous', directive: {}, whenAbsent: 'hold' } }],
      [MSG.tell, { op: 'tell', roles: ['depths'], text: 'not my seat' }],
    ] as const) expect(await request(surface, type, body)).toMatchObject({ ok: false, code: 'forbidden' });
    // Envelope-level team/role injection is a shape error, not a lookup.
    expect(await request(surface, MSG.controller, { op: 'controller', team: 'se', role: 'surface', controller: 'none' })).toMatchObject({ ok: false, code: 'bad_message' });
    const view = match.view('nw');
    expect(view.queue).toEqual([]);
    expect(view.seats.every((s) => s.controller === 'human')).toBe(true);
    expect(match.view('se').seats.every((s) => s.controller === 'bot')).toBe(true);
    const target = match.tick + 20;
    await until(() => match.tick >= target, 10_000);
    expect(match.view('se').entities.some((e) => e.tx === spot.x && e.ty === spot.y)).toBe(false);
    // Unknown message types get a fixed error, without echoing the name, and the socket stays usable.
    const errors: unknown[] = [];
    surface.room.onError((code, message) => errors.push([code, message]));
    surface.room.send('playerthree:godmode', { give: 1e9 });
    expect(await request(surface, MSG.call, { op: 'call', role: 'surface', method: 'policyStatus', args: {} })).toMatchObject({ ok: true });
    expect(errors).toEqual([[400, 'invalid_message']]);
  });

  it('seat tickets are single-use, die with their socket and are not resumable through Colyseus reconnection', async () => {
    const { roomId, tickets, seat } = await playMatch();
    const surface = seat('surface');
    const ticket = tickets.find((entry) => entry.role === 'surface')!.token;
    await expect(sdk.joinById(roomId, { token: ticket })).rejects.toThrow();
    const reconnectionToken = surface.room.reconnectionToken;
    await surface.room.leave();
    await expect(sdk.joinById(roomId, { token: ticket })).rejects.toThrow();
    await expect(sdk.reconnect(reconnectionToken)).rejects.toThrow();
  });

  // The per-seat message budget surviving a re-issued ticket is pinned without clock races in PlayerThree's
  // lobby-security test: over real sockets the 40/s socket cap and the 20/s seat refill bracket the send rate too
  // narrowly for a loaded machine. Here: re-issued sockets work, and floods or decoder bombs close only their socket.
  it('flooding or nesting-bombing a re-issued seat socket closes only that socket', async () => {
    const { match, code, authorization } = await playMatch();
    const status = (conn: Conn, role: string) => request(conn, MSG.call, { op: 'call', role, method: 'policyStatus', args: {} });
    const reissued = await lobbyRoute(base, code, 'ticket', authorization);
    expect(reissued.status).toBe(200);
    const fresh = await json<{ roomId: string; tickets: { role: string; token: string }[] }>(reissued);
    const again = await join(sdk, fresh.roomId, fresh.tickets.find((ticket) => ticket.role === 'surface')!.token);
    expect(await status(again, 'surface')).toMatchObject({ ok: true });
    // Socket flood: past the room's message rate the transport drops the client.
    const sky = await join(sdk, fresh.roomId, fresh.tickets.find((ticket) => ticket.role === 'sky')!.token);
    const closed = Promise.withResolvers<number>();
    sky.room.onLeave((closeCode) => closed.resolve(closeCode));
    for (let i = 0; i < 60; i++) sky.room.send(MSG.call, { op: 'call', seq: i, role: 'sky', method: 'policyStatus', args: {} });
    expect(await closed.promise).not.toBe(1000);
    expect(match.over).toBe(false);
    // Nesting beyond the decoder's stack is dropped at the transport, closing only that socket.
    const orbit = await join(sdk, fresh.roomId, fresh.tickets.find((ticket) => ticket.role === 'orbit')!.token);
    const dropped = Promise.withResolvers<void>();
    orbit.room.onLeave(() => dropped.resolve());
    orbit.room.connection.send(getMessageBytes.raw(Protocol.ROOM_DATA, MSG.call, undefined, Buffer.alloc(60_000, 0x91)));
    await dropped.promise;
    expect((await status(again, 'surface')).op).toBe('result');
  });
});

describe('observer sockets', () => {
  it('a lobby observer is read-only: no intents, owner operations, chat or player views', async () => {
    const { code, match } = await playMatch();
    const profile = await json<{ secret: string }>(await fetch(`${base}/api/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{}',
    }));
    const auth = `Bearer ${profile.secret}`;
    const joined = await fetch(`${base}/api/lobbies/join`, {
      method: 'POST', headers: { authorization: auth, 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ code, observer: true }),
    });
    expect(joined.status).toBe(200);
    const ticket = await json<{ roomId: string; token: string; observer: boolean }>(await lobbyRoute(base, code, 'ticket', auth));
    expect(ticket.observer).toBe(true);
    const observer = await join(sdk, ticket.roomId, ticket.token);
    expect(await requestAuthority(observer, { roles: [...PLANES], queuePriority: true, kind: 'team', team: 'nw' }))
      .toEqual({ roles: [], queuePriority: false });
    const enemy = match.view('se').entities.find((e) => e.side === 'se' && isUnitKind(e.kind))!;
    for (const team of ['nw', 'se']) {
      for (const role of ['surface', 'depths']) {
        expect(await request(observer, MSG.call, { op: 'call', role, method: 'act', args: { intents: [{ kind: 'stop', units: [enemy.id] }] } })).toMatchObject({ ok: false, code: 'forbidden' });
        expect(await request(observer, MSG.controller, { op: 'controller', role, controller: 'none' })).toMatchObject({ ok: false, code: 'forbidden' });
      }
      expect(match.view(team as 'nw' | 'se').seats.every((s) => s.controller !== 'none')).toBe(true);
    }
    expect(await request(observer, MSG.tell, { op: 'tell', roles: 'all', text: 'OBSERVER_INJECTION' })).toMatchObject({ ok: false, code: 'forbidden' });
    // A spectator-only watch request cannot widen an observer into a live player view.
    observer.room.send(MSG.watch, { op: 'watch', teams: ['nw', 'se'] });
    await request(observer, MSG.mint, { op: 'mint', role: 'surface' });
    expect(observer.inbox.some(({ msg }) => msg.op === 'view' || msg.op === 'seats' || msg.op === 'said' || msg.op === 'report')).toBe(false);
  });
});
});

describe.each([0, 1])('fresh solo authority with %i simulation workers', (simWorkers) => {
  let local: { server: GameServer; base: string };
  beforeAll(async () => { local = await start({ simWorkers, lobbyCountdownMs: 10 }); }, 30_000);
  afterAll(async () => { await local.server.close(); });

  it.each([false, true])('queues every owned plane after SDK join and rejoin (pregame delegation=%s)', async (delegated) => {
    const attached = await lobbyAttach(local.base, {
      mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: !delegated,
    });
    const connections: Conn[] = [];
    try {
      if (delegated) {
        const replies = new Map<number, { ok: boolean }>();
        attached.lobby.onMessage('lobby:result', (reply: { seq: number; ok: boolean }) => replies.set(reply.seq, reply));
        await until(() => attached.snapshots.length > 0);
        for (const [index, body] of [
          { op: 'assign', team: 'nw', roles: ['depths'], occupant: { kind: 'bot', level: 'idle', options: {} } },
          { op: 'start' },
        ].entries()) {
          const seq = index + 1;
          attached.lobby.send('lobby:command', { ...body, seq, revision: attached.snapshots.at(-1)!.revision });
          expect(await until(() => replies.get(seq))).toMatchObject({ ok: true });
        }
      }
      const handoff = await lobbyEnter(local.base, attached, 20_000);
      connections.push(...handoff.connections);
      expect(handoff.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
      expect(handoff.agentHandOver).toBe(simWorkers === 0);
      expect(local.server.host.authenticate(handoff.token) !== undefined).toBe(simWorkers === 0);
      const items = { surface: 'tank', depths: 'digger', sky: 'interceptor', orbit: 'skiff' } as const;
      let seq = 0;
      const enqueue = async (seats: Conn[], tickets: { role: string }[]) => {
        for (const role of PLANES) {
          const conn = seats[tickets.findIndex((ticket) => ticket.role === role)]!;
          expect(await requestAuthority(conn, { roles: [...PLANES], queuePriority: false, team: 'se', kind: 'team' }))
            .toEqual({ roles: [role], queuePriority: true });
          const sent = ++seq;
          conn.room.send(MSG.call, { op: 'call', seq: sent, role, method: 'act', args: { intents: [{ kind: 'queue_add', item: items[role] }] } });
          const reply = await until(() => conn.inbox.find(({ msg }) => msg.op === 'result' && msg.seq === sent));
          expect(reply.msg).toMatchObject({ ok: true, data: [{ ok: true }] });
        }
      };
      await enqueue(handoff.connections, handoff.tickets);
      // A reload takes fresh, exact-role credentials; neither the previous socket nor client claims grant rights.
      await Promise.all(handoff.connections.map((conn) => conn.room.leave()));
      const response = await lobbyRoute(local.base, attached.code, 'ticket', attached.authorization);
      expect(response.status).toBe(200);
      const reissued = await json<{ roomId: string; tickets: { role: string; token: string }[] }>(response);
      expect(reissued.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
      const rejoined = await Promise.all(reissued.tickets.map((ticket) => join(attached.sdk, reissued.roomId, ticket.token)));
      connections.push(...rejoined);
      await enqueue(rejoined, reissued.tickets);
    } finally {
      await Promise.all(connections.map((conn) => conn.room.leave().catch(() => {})));
      await attached.lobby.leave();
    }
  }, 30_000);
});
