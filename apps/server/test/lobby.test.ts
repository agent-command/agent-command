import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { MSG } from 'playerthree/protocol';
import { PLANES } from '@agent-command/game';
import type { LobbySnapshot } from '@agent-command/game/lobby';
import type { GameServer } from '../src/app.ts';
import { PUBLIC_OBSERVER_DELAY_MS } from '../src/featured.ts';
import { start, freshIp, join, json, requestAuthority, until } from './helpers.ts';
interface ConnectedLobby {
  code: string; roomId: string; visitorToken?: string; auth: string;
  room: Room; client: LobbyClient; snapshot: LobbySnapshot;
}

class LobbyClient extends Client {
  readonly snapshots = new Map<Room, LobbySnapshot>();
  readonly replies = new Map<number, { ok: boolean; code?: string }>();
  protected override createRoom<T>(name: string) {
    const room = super.createRoom<T>(name);
    room.reconnection.enabled = false;
    room.onMessage('lobby:snapshot', (snapshot: LobbySnapshot) => this.snapshots.set(room, snapshot));
    room.onMessage('lobby:result', (reply: { seq: number; ok: boolean; code?: string }) => this.replies.set(reply.seq, reply));
    room.onMessage('lobby:error', () => {});
    return room;
  }
}
let server: GameServer;
let base: string;
let sequence = 0;
const clients: Room[] = [];
beforeAll(async () => { ({ server, base } = await start({ lobbyCountdownMs: 10, lobbyReservationMs: 30_000, lobbyRecoveryMs: 30_000 })); });
afterAll(async () => { await Promise.all(clients.map((room) => room.leave().catch(() => {}))); await server.close(); });
async function request(path: string, body?: unknown, authorization?: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-forwarded-for': freshIp(), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authorization ? { authorization } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function profile(): Promise<{ id: string; auth: string }> {
  const created = await json<{ id: string; secret: string }>(await request('/api/profile', {})); return { id: created.id, auth: `Bearer ${created.secret}` };
}
async function lobby(auth?: string, preset = 'host', visibility = 'private', autoStart = false, selection = { mapId: 'open', layoutId: 'duel' }): Promise<ConnectedLobby> {
  const response = await request('/api/lobbies', { ...selection, visibility, preset, autoStart }, auth);
  expect(response.status).toBe(200);
  const location = await json<{ code: string; roomId: string; visitorToken?: string }>(response);
  const authorization = auth ?? `Visitor ${location.visitorToken}`;
  const grant = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${location.code}/connect`, {}, authorization));
  const client = new LobbyClient(base); const room = await client.joinById(grant.roomId, { token: grant.token }); clients.push(room);
  const snapshot = await until(() => client.snapshots.get(room));
  return { ...location, auth: authorization, room, client, snapshot };
}
async function command(current: ConnectedLobby, body: Record<string, unknown>, revision?: number) {
  const seq = ++sequence;
  current.room.send('lobby:command', { seq, revision: revision ?? current.client.snapshots.get(current.room)!.revision, ...body });
  return until(() => current.client.replies.get(seq));
}

describe('one all-side lobby', () => {
  it('quick play uses ephemeral identity and exact human seats through the same held pipeline', async () => {
    const current = await lobby(undefined, 'play', 'private', true);
    // A duel is the two-army subset of the four-army manifest: nw (blue) vs se (red), alliances keyed by colour.
    expect(current.snapshot.sides).toMatchObject([{ id: 'nw', alliance: 'blue' }, { id: 'se', alliance: 'red' }]);
    expect(current.snapshot.seats.filter((seat) => seat.team === 'nw').every((seat) => seat.occupant.kind === 'human')).toBe(true);
    expect(current.snapshot.seats.filter((seat) => seat.team === 'se').every((seat) => seat.occupant.kind === 'bot')).toBe(true);
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started');
    const handoff = await json<{ roomId: string; token: string; tickets: { token: string; role: string }[] }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
    expect(handoff.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
    const match = server.host.authenticate(handoff.token)!.match;
    expect(match.teams).toEqual(['nw', 'se']);
    expect(match.alliances).toEqual({ blue: ['nw'], red: ['se'] });
    expect(server.host.authenticate(handoff.token)!.principal.kind).toBe('human');
    expect(match.tick).toBe(0);
    expect(match.readiness().seats.filter((seat) => seat.kind === 'human').every((seat) => seat.state !== 'ready')).toBe(true);
    for (const ticket of handoff.tickets) { const room = await new Client(base).joinById(handoff.roomId, { token: ticket.token }); clients.push(room); }
    await until(() => match.tick > 0);
  });
  it.each(['private', 'public'])('changing the last You seat to Bot enters a read-only %s observer with every army visible', async (visibility) => {
    const current = await lobby((await profile()).auth, 'play', visibility);
    expect(current.snapshot.you.observer).toBe(false);
    expect(current.snapshot.seats.filter((seat) => seat.team === 'nw').every((seat) => seat.occupant.kind === 'human')).toBe(true);
    expect(await command(current, { op: 'assign', team: 'nw', roles: PLANES.filter((role) => role !== 'surface'), occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    expect(current.client.snapshots.get(current.room)!.you.observer).toBe(false);
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['surface'], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    const snapshot = await until(() => { const value = current.client.snapshots.get(current.room); return value?.you.observer ? value : undefined; });
    const grant = { kind: 'omniscient', teams: ['nw', 'se'], delayMs: visibility === 'public' ? PUBLIC_OBSERVER_DELAY_MS : 0 };
    expect(snapshot.you.grant).toEqual(grant);
    expect(snapshot.seats.every((seat) => seat.occupant.kind === 'bot')).toBe(true);
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    // Normal handoff requests {}, not the eliminated-player observer request.
    const response = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
    expect(response.status).toBe(200);
    const handoff = await json<{ roomId: string; token: string; tickets: { token: string; role?: string; queuePriority?: boolean; expiresAt: number }[] }>(response);
    expect(handoff).toMatchObject({ observer: true, readOnly: true, grant });
    expect(handoff.tickets).toHaveLength(1);
    expect(handoff.tickets[0]).not.toHaveProperty('role');
    expect(handoff.tickets[0]).not.toHaveProperty('queuePriority');
    expect(handoff.tickets[0]!.expiresAt - Date.now()).toBeGreaterThan(grant.delayMs);
    expect(server.host.authenticate(handoff.token)!.principal.kind).toBe('observer');
    const match = server.host.authenticate(handoff.token)!.match;
    for (const team of ['nw', 'se'] as const) {
      for (const role of PLANES) expect(() => match.mintHumanToken(team, role)).toThrow('forbidden');
    }
    const conn = await join(new Client(base), handoff.roomId, handoff.token); clients.push(conn.room);
    expect(await requestAuthority(conn, { roles: [...PLANES], queuePriority: true })).toEqual({ roles: [], queuePriority: false });
    const seq = ++sequence;
    conn.room.send(MSG.call, { op: 'call', seq, role: 'surface', method: 'act', args: { intents: [{ kind: 'queue_add', item: 'tank' }] } });
    const denied = await until(() => conn.inbox.find(({ msg }) => msg.op === 'result' && msg.seq === seq));
    expect(denied.msg).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('returning one all-Bot seat to You before start restores player mode and retained bot-role tickets', async () => {
    const current = await lobby((await profile()).auth, 'play');
    expect(await command(current, { op: 'assign', team: 'nw', roles: [...PLANES], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.you.observer === true);
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['surface'], occupant: { kind: 'human' } })).toMatchObject({ ok: true });
    const restored = await until(() => { const value = current.client.snapshots.get(current.room); return value?.you.observer === false ? value : undefined; });
    expect(restored.you).not.toHaveProperty('grant');
    expect(restored.seats.filter((seat) => seat.team === 'nw' && seat.occupant.kind === 'human').map((seat) => seat.role)).toEqual(['surface']);
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    const response = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
    expect(response.status).toBe(200);
    const handoff = await json<{ token: string; tickets: { role: string; token: string; queuePriority: boolean }[] }>(response);
    expect(handoff).toMatchObject({ team: 'nw', readOnly: false });
    expect(handoff).not.toHaveProperty('observer');
    expect(handoff.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
    for (const ticket of handoff.tickets) {
      expect(ticket.queuePriority).toBe(true);
      expect(server.host.authenticate(ticket.token)!.principal).toMatchObject({ kind: 'human', team: 'nw', role: ticket.role });
    }
    const match = server.host.authenticate(handoff.token)!.match;
    for (const role of PLANES.filter((role) => role !== 'surface')) expect(match.seats().find((seat) => seat.team === 'nw' && seat.role === role)!.controller).toBe('bot');
    expect((await request(`/api/lobbies/${current.code}/ticket`, { observer: true }, current.auth)).status).toBe(409);
  });
  it('dropping the last human army by layout change enters observer mode and starts without the lapsed delegation', async () => {
    const current = await lobby((await profile()).auth, 'play', 'private', false, { mapId: 'open', layoutId: 'ffa' });
    expect(await command(current, { op: 'assign', team: 'nw', roles: [...PLANES], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    expect(await command(current, { op: 'assign', team: 'ne', roles: ['surface'], occupant: { kind: 'human' } })).toMatchObject({ ok: true });
    expect(current.client.snapshots.get(current.room)!.you.observer).toBe(false);
    expect(await command(current, { op: 'configure', layoutId: 'duel' })).toMatchObject({ ok: true });
    const snapshot = await until(() => { const value = current.client.snapshots.get(current.room); return value?.layoutId === 'duel' ? value : undefined; });
    expect(snapshot.you).toMatchObject({ observer: true, grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 } });
    expect(snapshot.seats.every((seat) => seat.occupant.kind === 'bot')).toBe(true);
    // Taking You on ne let the nw delegation lapse: nothing of the old army is still this player's.
    expect(snapshot.players.find((player) => player.id === snapshot.you.memberId)!.seats).toEqual([]);
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    const response = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
    expect(response.status).toBe(200);
    const handoff = await json<{ token: string }>(response);
    expect(handoff).toMatchObject({ observer: true, readOnly: true, grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 } });
    const match = server.host.authenticate(handoff.token)!.match;
    for (const team of ['nw', 'se'] as const) {
      for (const role of PLANES) expect(() => match.mintHumanToken(team, role)).toThrow('forbidden');
    }
  });
  for (const army of ['se', 'nw'] as const) {
    it(`switching to ${army} after delegating the other army to Bot plays ${army} alone: its tickets, no lockout`, { timeout: 60_000 }, async () => {
      const current = await lobby((await profile()).auth, 'play');
      const other = army === 'nw' ? 'se' : 'nw';
      const bots = { kind: 'bot', level: 'idle', options: {} };
      // nw (the play seat) to Bot, then You on se; for nw, se to Bot again and You back on nw.
      const moves: [string, unknown][] = [['nw', bots], ['se', { kind: 'human' }], ...(army === 'nw' ? [['se', bots], ['nw', { kind: 'human' }]] as [string, unknown][] : [])];
      for (const [team, occupant] of moves) expect(await command(current, { op: 'assign', team, roles: [...PLANES], occupant })).toMatchObject({ ok: true });
      const snapshot = await until(() => {
        const value = current.client.snapshots.get(current.room);
        return value?.seats.every((seat) => seat.occupant.kind === (seat.team === army ? 'human' : 'bot')) ? value : undefined;
      });
      expect(snapshot.you.observer).toBe(false);
      expect(snapshot.players.find((player) => player.id === snapshot.you.memberId)!.seats.every((seat) => seat.team === army)).toBe(true);
      expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
      await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
      const response = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
      expect(response.status).toBe(200);
      const handoff = await json<{ roomId: string; token: string; tickets: { role: string; token: string; queuePriority: boolean }[] }>(response);
      expect(handoff).toMatchObject({ team: army, readOnly: false });
      expect(handoff.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
      for (const ticket of handoff.tickets) {
        expect(ticket.queuePriority).toBe(true);
        expect(server.host.authenticate(ticket.token)!.principal).toMatchObject({ kind: 'human', team: army, role: ticket.role });
      }
      const match = server.host.authenticate(handoff.token)!.match;
      for (const role of PLANES) {
        expect(match.seats().find((seat) => seat.team === other && seat.role === role)!.controller).toBe('bot');
        expect(() => match.mintHumanToken(other, role)).toThrow('forbidden');
      }
      for (const ticket of handoff.tickets) { const room = await new Client(base).joinById(handoff.roomId, { token: ticket.token }); clients.push(room); }
      await until(() => match.tick > 0, 20_000);
      expect(match.over).toBe(false);
    });
  }
  it('an all-Bot observer hands its own delegated seat to its commander mid-match; taking control itself is refused with its own code', { timeout: 60_000 }, async () => {
    const owner = await profile();
    const roster = await json<{ commanders: { id: string }[] }>(await request('/api/profile/commanders', { name: 'Observer depths', kind: 'agent', roles: ['depths'], isolation: { independentSessions: true } }, owner.auth));
    const commander = roster.commanders[0]!;
    const ownerKey = server.host.commanders.owners().find((key) => server.host.commanders.roster(key).some((entry) => entry.id === commander.id))!;
    const session = server.host.agentSession(server.host.commanders.token(ownerKey, commander.id), 'depths');
    if (session?.kind !== 'commander') throw new Error('commander session expected');
    const current = await lobby(owner.auth, 'play');
    expect(await command(current, { op: 'assign', team: 'nw', roles: [...PLANES], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.you.observer === true);
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    const watched = await json<{ token: string }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
    expect(watched).toMatchObject({ observer: true, grant: { kind: 'omniscient' } });
    const match = server.host.authenticate(watched.token)!.match;
    const entry = session.control.wait({ seconds: 30 });
    const handed = await request(`/api/lobbies/${current.code}/seat`, { team: 'nw', role: 'depths', occupant: { kind: 'commander', ref: { id: commander.id, kind: 'agent' } } }, current.auth);
    expect(handed.status).toBe(200);
    expect(await entry).toMatchObject({ phase: 'match', observation: { army: 'nw', role: 'depths' } });
    expect(match.seats().find((seat) => seat.team === 'nw' && seat.role === 'depths')).toMatchObject({ controller: 'agent', commander: true });
    // The hand-over grants no owner control, and a full-vision watcher cannot take control itself.
    expect(() => match.mintHumanToken('nw', 'depths')).toThrow('forbidden');
    const refused = await request(`/api/lobbies/${current.code}/seat`, { team: 'nw', role: 'surface', occupant: { kind: 'human' } }, current.auth);
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ error: 'observer_vision_held' });
    expect(match.seats().find((seat) => seat.team === 'nw' && seat.role === 'surface')!.controller).toBe('bot');
  });
  it('the leader replaces another member’s dormant all-Bot delegation before and during the match, never a live one', { timeout: 60_000 }, async () => {
    const leader = await profile(); const guest = await profile();
    const current = await lobby(leader.auth, 'play');
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['depths', 'sky'], occupant: { kind: 'open' } })).toMatchObject({ ok: true });
    expect((await request('/api/lobbies/join', { code: current.code, team: 'nw' }, guest.auth)).status).toBe(200);
    const grant = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${current.code}/connect`, {}, guest.auth));
    const client = new LobbyClient(base);
    const room = await client.joinById(grant.roomId, { token: grant.token }); clients.push(room);
    const other: ConnectedLobby = { ...current, auth: guest.auth, client, room, snapshot: await until(() => client.snapshots.get(room)) };
    const standard = { kind: 'bot', level: 'standard', options: {} };
    // Each command carries its sender's revision: the leader acts on the guest's change only once it has seen it.
    const synced = () => until(() => current.client.snapshots.get(current.room)?.revision === client.snapshots.get(room)?.revision ? true : undefined);
    // Delegated while the guest still plays depths: a live claim.
    expect(await command(other, { op: 'assign', team: 'nw', roles: ['sky'], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    await synced();
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['sky'], occupant: standard })).toMatchObject({ ok: false, code: 'release_required' });
    // The guest's last You seat to Bot: an observer whose draft delegation is dormant.
    expect(await command(other, { op: 'assign', team: 'nw', roles: ['depths'], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    await until(() => client.snapshots.get(room)?.you.observer === true);
    await synced();
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['sky'], occupant: standard })).toMatchObject({ ok: true });
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    // Mid-match the guest's depths bot carries no control: the leader, playing that army, takes it over.
    const taken = await request(`/api/lobbies/${current.code}/seat`, { team: 'nw', role: 'depths', occupant: { kind: 'human' } }, leader.auth);
    expect(taken.status).toBe(200);
    const handoff = await json<{ token: string; team: string; tickets: { role: string; token: string }[] }>(await request(`/api/lobbies/${current.code}/ticket`, {}, leader.auth));
    expect(handoff.team).toBe('nw');
    expect(handoff.tickets.map((ticket) => ticket.role).sort()).toEqual(PLANES.filter((role) => role !== 'sky').sort());
    const match = server.host.authenticate(handoff.token)!.match;
    expect(match.seats().find((seat) => seat.team === 'nw' && seat.role === 'depths')!.controller).toBe('human');
  });
  it('issues owner tickets for pregame delegated bot and agent roles without granting synthetic opponents', async () => {
    const owner = await profile();
    const roster = await json<{ commanders: { id: string }[] }>(await request('/api/profile/commanders', { name: 'Delegated depths', kind: 'agent', roles: ['depths'], isolation: { independentSessions: true } }, owner.auth));
    const commander = roster.commanders[0]!;
    const ownerKey = server.host.commanders.owners().find((key) => server.host.commanders.roster(key).some((entry) => entry.id === commander.id))!;
    const session = server.host.agentSession(server.host.commanders.token(ownerKey, commander.id), 'depths');
    if (session?.kind !== 'commander') throw new Error('commander session expected');
    const current = await lobby(owner.auth, 'play');
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['depths'], occupant: { kind: 'commander', ref: { id: commander.id, kind: 'agent' } } })).toMatchObject({ ok: true });
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['sky'], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    expect(await session.control.ready()).toMatchObject({ phase: 'lobby', seat: { team: 'nw', role: 'depths' }, you: { ready: true } });
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => session.seat());
    // Allocation starts a new presence generation: the ready agent must observe its actual held seat.
    expect(await session.control.observe()).toMatchObject({ phase: 'lobby', seat: { team: 'nw', role: 'depths' }, you: { ready: true } });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    const handoff = await json<{ token: string; team: string; tickets: { role: string; token: string; queuePriority: boolean }[] }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
    expect(handoff.team).toBe('nw');
    expect(handoff.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
    for (const ticket of handoff.tickets) {
      expect(ticket.queuePriority).toBe(true);
      expect(server.host.authenticate(ticket.token)!.principal).toMatchObject({ kind: 'human', team: 'nw', role: ticket.role });
    }
    const match = server.host.authenticate(handoff.token)!.match;
    expect(match.seats().find((seat) => seat.team === 'nw' && seat.role === 'depths')!.controller).toBe('agent');
    expect(match.seats().find((seat) => seat.team === 'nw' && seat.role === 'sky')!.controller).toBe('bot');
    expect((await request(`/api/lobbies/${current.code}/ticket`, { observer: true }, current.auth)).status).toBe(409);
    expect((await request(`/api/lobbies/${current.code}/seat`, { team: 'se', role: 'sky', occupant: { kind: 'human' } }, current.auth)).status).toBe(403);
  });

  it('never issues another same-army owner’s ticket after a released role is claimed', async () => {
    const alice = await profile();
    const bob = await profile();
    const current = await lobby(alice.auth, 'play');
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['depths', 'sky'], occupant: { kind: 'open' } })).toMatchObject({ ok: true });
    expect((await request('/api/lobbies/join', { code: current.code, team: 'nw' }, bob.auth)).status).toBe(200);
    const grant = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${current.code}/connect`, {}, bob.auth));
    const client = new LobbyClient(base);
    const room = await client.joinById(grant.roomId, { token: grant.token }); clients.push(room);
    const other: ConnectedLobby = { ...current, auth: bob.auth, client, room, snapshot: await until(() => client.snapshots.get(room)) };
    expect(await command(other, { op: 'assign', team: 'nw', roles: ['sky'], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    // Bob keeps an actual human depths seat; delegating his last human would intentionally make him an observer.
    expect(await command(other, { op: 'ready', ready: true })).toMatchObject({ ok: true });
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    type Tickets = { roomId: string; team: string; tickets: { role: string; token: string; queuePriority: boolean }[] };
    const first = await json<Tickets>(await request(`/api/lobbies/${current.code}/ticket`, {}, alice.auth));
    const second = await json<Tickets>(await request(`/api/lobbies/${current.code}/ticket`, {}, bob.auth));
    expect(first.team).toBe('nw'); expect(second.team).toBe('nw');
    expect(first.tickets.map((ticket) => ticket.role).sort()).toEqual(PLANES.filter((role) => role !== 'depths' && role !== 'sky').sort());
    expect(second.tickets.map((ticket) => ticket.role).sort()).toEqual(['depths', 'sky']);
    expect(second.tickets.every((ticket) => ticket.queuePriority)).toBe(true);
    expect((await request(`/api/lobbies/${current.code}/seat`, { team: 'nw', role: 'sky', occupant: { kind: 'human' } }, alice.auth)).status).toBe(403);
    for (const [handoff, deniedRole] of [[first, 'sky'], [second, 'surface']] as const) {
      const ticket = handoff.tickets[0]!;
      const conn = await join(new Client(base), handoff.roomId, ticket.token); clients.push(conn.room);
      expect(await requestAuthority(conn, { roles: [...PLANES], kind: 'team', team: 'se', queuePriority: true }))
        .toEqual({ roles: [ticket.role], queuePriority: true });
      const seq = ++sequence;
      conn.room.send(MSG.call, { op: 'call', seq, role: deniedRole, method: 'act', args: { intents: [{ kind: 'queue_add', item: deniedRole === 'sky' ? 'interceptor' : 'tank' }] } });
      const denied = await until(() => conn.inbox.find(({ msg }) => msg.op === 'result' && msg.seq === seq));
      expect(denied.msg).toMatchObject({ ok: false, code: 'forbidden' });
    }
  });
  it('a seat ticket the match refuses is a 403 answer, not a logged 500', async () => {
    const current = await lobby(undefined, 'play', 'private', true);
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started');
    const handoff = await json<{ token: string }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
    const match = server.host.authenticate(handoff.token)!.match;
    match.revokeSeat('nw', 'surface');
    const errors = vi.spyOn(console, 'error');
    try {
      const refused = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
      expect(refused.status).toBe(403); expect(await json(refused)).toEqual({ error: 'forbidden' });
      expect(errors).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });
  it('a player who hands planes to their agent, a bot or hold keeps their seats: in-place renewal and fresh tickets both work', async () => {
    const current = await lobby(undefined, 'play', 'private', true);
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started');
    type Ticket = { roomId: string; token: string; tickets: { token: string; role: string }[] };
    const handoff = await json<Ticket>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
    const match = server.host.authenticate(handoff.token)!.match;
    const seats = new Map<string, Room>();
    for (const ticket of handoff.tickets) { const room = await new Client(base).joinById(handoff.roomId, { token: ticket.token }); room.reconnection.enabled = false; clients.push(room); seats.set(ticket.role, room); }
    await until(() => match.tick > 0);
    // The commander pop-up's hand-off, over each plane's own seat connection.
    const handed = { surface: 'agent', depths: 'bot', sky: 'none' } as const;
    for (const [role, controller] of Object.entries(handed)) {
      const room = seats.get(role)!; const seq = ++sequence;
      const reply = Promise.withResolvers<{ ok: boolean }>();
      room.onMessage(MSG.result, (m: { seq: number; ok: boolean }) => { if (m.seq === seq) reply.resolve(m); });
      room.send(MSG.controller, { op: 'controller', seq, role, controller });
      expect(await reply.promise, role).toMatchObject({ ok: true });
    }
    const dropped = new Set<string>();
    for (const [role, room] of seats) room.onLeave(() => dropped.add(role));
    // The client renews halfway through its credentials' lifetime, in place: every seat socket stays up.
    const before = Date.now();
    const extended = await request(`/api/lobbies/${current.code}/renew`, {}, current.auth);
    expect(extended.status).toBe(200);
    const renewal = await json<{ roomId: string; tickets: { role: string; expiresAt: number }[] }>(extended);
    expect(renewal.roomId).toBe(handoff.roomId);
    expect(renewal.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
    for (const ticket of renewal.tickets) expect(ticket.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    const at = match.tick;
    await until(() => match.tick > at + 5);
    expect([...dropped]).toEqual([]);
    // Fresh tickets (the fallback, and a reload): refused with 500 `forbidden` once any plane was handed off, after the
    // old seat tokens had already been revoked, so the player was dropped back to the lobby.
    const reissued = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
    expect(reissued.status).toBe(200);
    const next = await json<Ticket>(reissued);
    expect(next.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
    const rejoined: Room[] = [];
    for (const ticket of next.tickets) { const room = await new Client(base).joinById(next.roomId, { token: ticket.token, view: false }); room.reconnection.enabled = false; clients.push(room); rejoined.push(room); }
    expect(match.over).toBe(false);
    // A seat whose socket is gone has nothing to extend: the client falls back to fresh tickets.
    await rejoined[0]!.leave();
    const stale = await request(`/api/lobbies/${current.code}/renew`, {}, current.auth);
    expect(stale.status).toBe(409); expect(await json(stale)).toEqual({ error: 'not_renewable' });
  });
  it('a played human delegating every role through HTTP keeps player authority and cannot become a full observer', async () => {
    const current = await lobby(undefined, 'play', 'private', true);
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    type Handoff = { roomId: string; token: string; tickets: { token: string; role: string; queuePriority: boolean }[] };
    const handoff = await json<Handoff>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
    const match = server.host.authenticate(handoff.token)!.match;
    for (const ticket of handoff.tickets) {
      const room = await new Client(base).joinById(handoff.roomId, { token: ticket.token }); clients.push(room);
    }
    await until(() => match.tick > 0);
    for (const role of PLANES) {
      const response = await request(`/api/lobbies/${current.code}/seat`, { team: 'nw', role, occupant: { kind: 'bot' } }, current.auth);
      expect(response.status).toBe(200);
    }
    const snapshot = await until(() => {
      const value = current.client.snapshots.get(current.room);
      return value?.seats.filter((seat) => seat.team === 'nw').every((seat) => seat.occupant.kind === 'bot') ? value : undefined;
    });
    expect(snapshot.you.observer).toBe(false);
    expect(snapshot.you).not.toHaveProperty('grant');
    for (const role of PLANES) expect(match.seats().find((seat) => seat.team === 'nw' && seat.role === role)!.controller).toBe('bot');
    const response = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
    expect(response.status).toBe(200);
    const delegated = await json<Handoff>(response);
    expect(delegated).toMatchObject({ team: 'nw', readOnly: false });
    expect(delegated).not.toHaveProperty('observer');
    expect(delegated.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
    for (const ticket of delegated.tickets) {
      expect(ticket.queuePriority).toBe(true);
      expect(server.host.authenticate(ticket.token)!.principal).toMatchObject({ kind: 'human', team: 'nw', role: ticket.role });
    }
    const observer = await request(`/api/lobbies/${current.code}/ticket`, { observer: true }, current.auth);
    expect(observer.status).toBe(409);
    expect(await json(observer)).toEqual({ error: 'still_playing' });
  });
  it('whole-army assignment is atomic, revision guarded and clears readiness', async () => {
    const owner = await profile(); const current = await lobby(owner.auth);
    expect((await command(current, { op: 'ready', ready: true })).ok).toBe(true);
    const revision = current.client.snapshots.get(current.room)!.revision;
    expect((await command(current, { op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'bot', level: 'veteran', options: { aggression: 0.8, economyReserve: 0.2 } } })).ok).toBe(true);
    const next = await until(() => { const value = current.client.snapshots.get(current.room); return value && value.revision > revision ? value : undefined; });
    expect(next.players.every((member) => !member.ready)).toBe(true);
    expect(next.seats.filter((seat) => seat.team === 'se').every((seat) => seat.occupant.kind === 'bot')).toBe(true);
    expect(await command(current, { op: 'assign', team: 'se', roles: ['surface'], occupant: { kind: 'closed' } }, revision)).toMatchObject({ ok: false, code: 'stale_revision' });
    const before = current.client.snapshots.get(current.room)!;
    expect((await command(current, { op: 'assign', team: 'se', roles: ['surface', 'invalid'], occupant: { kind: 'closed' } })).ok).toBe(false);
    expect(current.client.snapshots.get(current.room)!.revision).toBe(before.revision);
    await command(current, { op: 'ready', ready: true });
    expect((await command(current, { op: 'configure', rules: { economy: { startAlloy: 777 } } })).ok).toBe(true);
    const changed = await until(() => { const value = current.client.snapshots.get(current.room); return value && value.revision > before.revision ? value : undefined; });
    expect(changed.players.every((member) => !member.ready)).toBe(true);
    expect(changed.rules.economy.startAlloy).toBe(777);
    expect(changed.customRules).toBe(true); expect(changed.unrankedPractice).toBe(true);
    expect(changed.rulesDiff.length).toBeGreaterThan(0);
    expect(changed.rulesHash).not.toBe(before.rulesHash);
  });
  it('open seats block start and invalid configure does not partially mutate state', async () => {
    const current = await lobby((await profile()).auth);
    await command(current, { op: 'ready', ready: true });
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: false, code: 'not_ready' });
    const before = current.client.snapshots.get(current.room)!;
    expect((await command(current, { op: 'configure', visibility: 'public', size: -1 })).ok).toBe(false);
    expect(current.client.snapshots.get(current.room)!.visibility).toBe(before.visibility);
    expect(current.client.snapshots.get(current.room)!.revision).toBe(before.revision);
  });
  it('selects maps through the registry: seed and size are validated, published and unsupported layouts rejected', async () => {
    const host = (await profile()).auth;
    const created = await request('/api/lobbies', { mapId: 'open', layoutId: 'duel', visibility: 'public', preset: 'host', mapSeed: 12, size: 64 }, host);
    expect(created.status).toBe(200);
    const { code } = await json<{ code: string }>(created);
    const listing = await json<{ lobbies: { code: string }[] }>(await request('/api/lobbies'));
    expect(listing.lobbies.find((entry) => entry.code === code)).toMatchObject({ mapId: 'open', mapSeed: 12, size: 64, rules: { map: { size: 64 } } });
    for (const selection of [{ mapId: 'four_corners', layoutId: 'adjacent' }, { mapId: 'open', layoutId: 'opposite' }, { mapId: 'missing' }]) {
      const response = await request('/api/lobbies', { layoutId: 'duel', visibility: 'private', preset: 'host', ...selection }, (await profile()).auth);
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ error: 'unsupported_layout' });
    }
    for (const selection of [{ size: 60 }, { mapSeed: -1 }, { mapSeed: 0x100000000 }, { mapId: 'crown', size: 64 }, { mapId: 'crown', mapSeed: 1 }]) {
      expect((await request('/api/lobbies', { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'host', ...selection }, (await profile()).auth)).status).toBe(400);
    }
    const current = await lobby((await profile()).auth);
    expect(await command(current, { op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'bot', level: 'veteran', options: {} } })).toMatchObject({ ok: true });
    const seatsOf = (value: { seats: { team: string; role: string; occupant: unknown }[] }) => value.seats.map((seat) => [seat.team, seat.role, seat.occupant]);
    const before = await until(() => { const value = current.client.snapshots.get(current.room); return value?.seats.some((seat) => seat.occupant.kind === 'bot') ? value : undefined; });
    expect(await command(current, { op: 'configure', mapId: 'crown' })).toMatchObject({ ok: true });
    const after = await until(() => { const value = current.client.snapshots.get(current.room); return value?.mapId === 'crown' ? value : undefined; });
    expect(after).toMatchObject({ mapSeed: 0, size: 48 });
    // Changing the battlefield keeps every seat choice (same duel layout): nothing reopens, nobody is benched.
    expect(seatsOf(after)).toEqual(seatsOf(before));
    expect(after.you.observer).toBe(before.you.observer);
    expect(await command(current, { op: 'configure', mapId: 'four_corners', layoutId: 'adjacent' })).toMatchObject({ ok: false, code: 'unsupported_layout' });
  });
  it('creating a new game leaves your previous room instead of failing (capacity / already_joined)', async () => {
    const host = (await profile()).auth;
    const setup = { mapId: 'open', layoutId: 'duel', visibility: 'public', preset: 'host' };
    const first = await json<{ code: string }>(await request('/api/lobbies', setup, host));
    const second = await request('/api/lobbies', setup, host);
    expect(second.status).toBe(200);
    const { code } = await json<{ code: string }>(second);
    const codes = (await json<{ lobbies: { code: string }[] }>(await request('/api/lobbies'))).lobbies.map((entry) => entry.code);
    expect(codes).toContain(code); expect(codes).not.toContain(first.code);
  });
  it('after a reload mid-match, starting a new game forfeits the old one instead of "leave your current game"', async () => {
    const host = (await profile()).auth;
    const current = await lobby(host, 'play', 'private', true);
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    await current.room.leave(); // the reload: the old tab's connection is gone, nothing told the server to leave
    const again = await request('/api/lobbies', { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play' }, host);
    expect(again.status).toBe(200);
  });
  it('a fresh all-Bot lobby does not inherit player mode or army history from the previous human game', async () => {
    const owner = await profile();
    const previous = await lobby(owner.auth, 'host');
    expect(await command(previous, { op: 'observe' })).toMatchObject({ ok: true });
    expect(await command(previous, { op: 'assign', team: 'nw', roles: [...PLANES], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    expect(await command(previous, { op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'human' } })).toMatchObject({ ok: true });
    expect(await command(previous, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => previous.client.snapshots.get(previous.room)?.phase === 'started', 20_000);
    const played = await json<{ roomId: string; token: string; tickets: { token: string }[] }>(await request(`/api/lobbies/${previous.code}/ticket`, {}, previous.auth));
    expect(played).toMatchObject({ team: 'se', readOnly: false });
    const oldMatch = server.host.authenticate(played.token)!.match;
    for (const ticket of played.tickets) {
      const room = await new Client(base).joinById(played.roomId, { token: ticket.token }); clients.push(room);
    }
    await until(() => oldMatch.tick > 0);
    const current = await lobby(owner.auth, 'play');
    expect(current.code).not.toBe(previous.code);
    expect(await command(current, { op: 'assign', team: 'nw', roles: [...PLANES], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
    const snapshot = await until(() => { const value = current.client.snapshots.get(current.room); return value?.you.observer ? value : undefined; });
    expect(snapshot.you.grant).toEqual({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 });
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    const response = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
    expect(response.status).toBe(200);
    const handoff = await json<{ token: string }>(response);
    expect(handoff).toMatchObject({ observer: true, readOnly: true, grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 } });
    expect(server.host.authenticate(handoff.token)!.principal.kind).toBe('observer');
  });
  it('private benchmark observer gets read-only omniscience; public policy never drops below 180 seconds', async () => {
    const privateLobby = await lobby((await profile()).auth, 'benchmark');
    expect(privateLobby.snapshot.you.observer).toBe(true);
    expect(privateLobby.snapshot.you.grant).toMatchObject({ kind: 'omniscient', delayMs: 0 });
    expect(privateLobby.snapshot.seats.every((seat) => seat.occupant.kind === 'bot')).toBe(true);
    const publicLobby = await lobby((await profile()).auth, 'benchmark', 'public');
    expect(publicLobby.snapshot.observerPolicy.minDelayMs).toBe(PUBLIC_OBSERVER_DELAY_MS);
    expect(publicLobby.snapshot.you.grant).toMatchObject({ kind: 'omniscient', delayMs: 180_000 });
    expect(await command(publicLobby, { op: 'start' })).toMatchObject({ ok: true });
    await until(() => publicLobby.client.snapshots.get(publicLobby.room)?.phase === 'started');
    const handoff = await json<{ token: string; observer: boolean; grant: { delayMs: number }; tickets: { expiresAt: number }[] }>(await request(`/api/lobbies/${publicLobby.code}/ticket`, {}, publicLobby.auth));
    expect(handoff.observer).toBe(true); expect(handoff.grant.delayMs).toBe(180_000);
    expect(server.host.authenticate(handoff.token)!.principal.kind).toBe('observer');
    expect(handoff.tickets.every((ticket) => !('queuePriority' in ticket) || ticket.queuePriority !== true)).toBe(true);
    expect(handoff.tickets[0]!.expiresAt - Date.now()).toBeGreaterThan(PUBLIC_OBSERVER_DELAY_MS);
    const match = server.host.authenticate(handoff.token)!.match;
    for (const team of ['nw', 'se'] as const) {
      for (const role of PLANES) expect(() => match.mintHumanToken(team, role)).toThrow('forbidden');
    }
  });
  it('other members cannot replace occupied human claims', async () => {
    const owner = await profile(); const current = await lobby(owner.auth);
    const second = await profile();
    expect((await request('/api/lobbies/join', { code: current.code, observer: false, team: 'se' }, second.auth)).status).toBe(200);
    await until(() => current.client.snapshots.get(current.room)?.players.length === 2);
    expect(await command(current, { op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'bot', level: 'standard', options: {} } })).toMatchObject({ ok: false, code: 'release_required' });
  });
  it('a running match cannot be ended or stripped by kicking a seat owner; seatless observers can still be removed', async () => {
    const leader = await profile(); const current = await lobby(leader.auth);
    const rival = await profile(); const watcher = await profile();
    expect((await request('/api/lobbies/join', { code: current.code, observer: false, team: 'se' }, rival.auth)).status).toBe(200);
    expect((await request('/api/lobbies/join', { code: current.code, observer: true }, watcher.auth)).status).toBe(200);
    const grant = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${current.code}/connect`, {}, rival.auth));
    const rivalClient = new LobbyClient(base); const rivalRoom = await rivalClient.joinById(grant.roomId, { token: grant.token }); clients.push(rivalRoom);
    const rivalLobby: ConnectedLobby = { ...current, auth: rival.auth, room: rivalRoom, client: rivalClient, snapshot: await until(() => rivalClient.snapshots.get(rivalRoom)) };
    await until(() => current.client.snapshots.get(current.room)?.players.length === 3 && rivalClient.snapshots.get(rivalRoom)?.players.length === 3);
    expect(await command(rivalLobby, { op: 'ready', ready: true })).toMatchObject({ ok: true });
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    const started = await until(() => { const value = current.client.snapshots.get(current.room); return value?.phase === 'started' ? value : undefined; }, 20_000);
    const handoff = await json<{ token: string }>(await request(`/api/lobbies/${current.code}/ticket`, {}, leader.auth));
    const match = server.host.authenticate(handoff.token)!.match;
    const rivalId = started.players.find((player) => !player.leader && !player.observer)!.id;
    const watcherId = started.players.find((player) => player.observer)!.id;
    // Kicking the opponent would convert the leader's loss into a draw (and revoke the other side's seats).
    expect(await command(current, { op: 'kick', memberId: rivalId })).toMatchObject({ ok: false, code: 'not_open' });
    expect(match.over).toBe(false);
    expect(match.seats().filter((seat) => seat.team === 'se').every((seat) => seat.controller === 'human')).toBe(true);
    expect(await command(current, { op: 'kick', memberId: watcherId })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.players.length === 2);
    expect(match.over).toBe(false);
  });
  it('only the leader\'s own attachment auto-starts a lobby; an early observer joins without forcing readiness', async () => {
    const created = await json<{ code: string; visitorToken: string }>(await request('/api/lobbies', { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true }));
    const watcher = await profile();
    expect((await request('/api/lobbies/join', { code: created.code, observer: true }, watcher.auth)).status).toBe(200);
    const grant = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${created.code}/connect`, {}, watcher.auth));
    const client = new LobbyClient(base); const room = await client.joinById(grant.roomId, { token: grant.token }); clients.push(room);
    const snapshot = await until(() => client.snapshots.get(room));
    expect(snapshot.phase).toBe('waiting');
    expect(snapshot.players.find((player) => player.id === snapshot.you.memberId)).toMatchObject({ observer: true, ready: false, connected: true });
  });
  it('seatless members cannot toggle readiness or "observe", which would reset preparation and the countdown', async () => {
    const current = await lobby((await profile()).auth);
    const watcher = await profile();
    expect((await request('/api/lobbies/join', { code: current.code, observer: true }, watcher.auth)).status).toBe(200);
    const grant = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${current.code}/connect`, {}, watcher.auth));
    const client = new LobbyClient(base); const room = await client.joinById(grant.roomId, { token: grant.token }); clients.push(room);
    const watching: ConnectedLobby = { ...current, auth: watcher.auth, room, client, snapshot: await until(() => client.snapshots.get(room)) };
    const revision = await until(() => current.client.snapshots.get(current.room)?.players.length === 2 && current.client.snapshots.get(current.room)!.revision);
    expect(await command(watching, { op: 'ready', ready: true })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await command(watching, { op: 'observe' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await command(current, { op: 'ready', ready: true })).toMatchObject({ ok: true });
    expect(current.client.snapshots.get(current.room)!.revision).toBe(revision);
  });
  it('adopts a visitor lobby into a profile without replacing its human membership', async () => {
    const current = await lobby();
    const owner = await profile();
    const before = current.client.snapshots.get(current.room)!;
    const response = await request(`/api/lobbies/${current.code}/claim-owner`, {
      visitorToken: current.visitorToken, revision: before.revision,
    }, owner.auth);
    expect(response.status).toBe(200);
    expect((await request(`/api/lobbies/${current.code}/connect`, {}, current.auth)).status).toBe(401);
    const grant = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${current.code}/connect`, {}, owner.auth));
    const client = new LobbyClient(base);
    const room = await client.joinById(grant.roomId, { token: grant.token }); clients.push(room);
    const adopted = await until(() => client.snapshots.get(room));
    expect(adopted.you.memberId).toBe(before.you.memberId);
    expect(adopted.revision).toBeGreaterThan(before.revision);
    expect(adopted.players).toHaveLength(1);
    expect(adopted.seats.filter((seat) => seat.team === 'nw').every((seat) =>
      seat.occupant.kind === 'human' && seat.occupant.memberId === before.you.memberId)).toBe(true);
  });
  it('named commander refs stay private to their owner, including public directory snapshots', async () => {
    const owner = await profile();
    const roster = await json<{ commanders: { id: string }[] }>(await request('/api/profile/commanders', { name: 'Private endpoint-free identity', kind: 'agent', roles: ['surface'], isolation: { independentSessions: true } }, owner.auth));
    const commander = roster.commanders[0]!;
    const current = await lobby(owner.auth, 'benchmark', 'public');
    expect((await command(current, { op: 'assign', team: 'nw', roles: ['surface'], occupant: { kind: 'commander', ref: { id: commander.id, kind: 'agent' } } })).ok).toBe(true);
    const own = await until(() => { const value = current.client.snapshots.get(current.room); return value?.seats.some((seat) => seat.occupant.kind === 'commander') ? value : undefined; });
    expect(own.seats.find((seat) => seat.occupant.kind === 'commander')!.occupant).toHaveProperty('ref.id', commander.id);
    const listing = await (await request('/api/lobbies')).text(); expect(listing).not.toContain(commander.id); expect(listing).not.toContain(owner.id);
    expect(listing).not.toContain('token'); expect(listing).not.toContain('secret');
    expect((await command(current, { op: 'start' })).ok).toBe(true);
    const seated = await until(async () => {
      const response = await json<{ commanders: { id: string; seated: { match: string; roomId: string; team: string; roles: string[] } | null }[] }>(
        await request('/api/profile', undefined, owner.auth));
      return response.commanders.find((entry) => entry.id === commander.id)?.seated ?? undefined;
    });
    expect(seated).toMatchObject({ team: 'nw', roles: ['surface'] });
    expect(seated.roomId).not.toBe(current.roomId);
    expect(server.host.getMatch(seated.match)?.id).toBe(seated.match);
    expect(await (await request('/api/lobbies')).text()).not.toContain(seated.match);
  });
  it('an agent seat sees its reservation, goes online then ready, keeps ready into the held match and gets its first observation at the start', async () => {
    const owner = await profile();
    const roster = await json<{ commanders: { id: string }[] }>(await request('/api/profile/commanders', { name: 'Ready agent', kind: 'agent', roles: ['surface'], isolation: { independentSessions: true } }, owner.auth));
    const commander = roster.commanders[0]!;
    const ownerKey = server.host.commanders.owners().find((key) => server.host.commanders.roster(key).some((entry) => entry.id === commander.id))!;
    const session = server.host.agentSession(server.host.commanders.token(ownerKey, commander.id), 'surface');
    if (session?.kind !== 'commander') throw new Error('commander session expected');
    const agent = session.control;
    const current = await lobby(owner.auth, 'benchmark', 'private');
    const seatState = () => current.client.snapshots.get(current.room)?.seats.find((seat) => seat.team === 'nw' && seat.role === 'surface')?.ready;
    expect((await command(current, { op: 'assign', team: 'nw', roles: ['surface'], occupant: { kind: 'commander', ref: { id: commander.id, kind: 'agent' } } })).ok).toBe(true);
    // The lobby reserves the seat: the agent's lobby state names it, the match summary and who starts it.
    expect(await agent.observe()).toMatchObject({
      phase: 'lobby', seat: { team: 'nw', role: 'surface' }, you: { ready: false }, startsWhen: { kind: 'host' },
      match: { map: 'open', layout: 'duel', armies: [{ army: 'nw', colour: 'blue' }, { army: 'se', colour: 'red' }], rules: { custom: true, changed: [{ rule: 'terrain', value: '"open"' }] } },
    });
    expect(await until(() => seatState() === 'online' ? true : undefined)).toBe(true);
    expect(await agent.ready()).toMatchObject({ phase: 'lobby', you: { ready: true } });
    expect(await until(() => seatState() === 'ready' ? true : undefined)).toBe(true);
    // Start: the held match carries the ready mark, so the lobby counts down at once; the wait returns the entry.
    const entry = agent.wait({ seconds: 30 });
    expect((await command(current, { op: 'start' })).ok).toBe(true);
    expect(await entry).toMatchObject({ phase: 'match', outcome: 'running', observation: { army: 'nw', role: 'surface' }, instruction: expect.any(String) });
    expect(server.host.commanders.roster(ownerKey).find((entry) => entry.id === commander.id)!.reservations).toEqual([]);
    const match = server.host.matches().find((candidate) => candidate.id === session.seat()!.match)!;
    // An initial agent assignment is not a former human claim, even for that commander's owner.
    expect(() => match.mintHumanToken('nw', 'surface')).toThrow('forbidden');
    expect(() => match.mintHumanToken('se', 'surface')).toThrow('forbidden');
  });
  for (const army of ['nw', 'se'] as const) {
    it(`the ${army} owner hands a running human seat to a named commander and back: the agent acts next tick, the old controller is detached`, { timeout: 60_000 }, async () => {
      const owner = await profile();
      const roster = await json<{ commanders: { id: string }[] }>(await request('/api/profile/commanders', { name: `Swap ${army}`, kind: 'agent', roles: ['depths'], isolation: { independentSessions: true } }, owner.auth));
      const commander = roster.commanders[0]!;
      const ownerKey = server.host.commanders.owners().find((key) => server.host.commanders.roster(key).some((entry) => entry.id === commander.id))!;
      const session = server.host.agentSession(server.host.commanders.token(ownerKey, commander.id), 'depths');
      if (session?.kind !== 'commander') throw new Error('commander session expected');
      const current = await lobby(owner.auth, 'host');
      const other = army === 'nw' ? 'se' : 'nw';
      if (army === 'se') {
        expect(await command(current, { op: 'observe' })).toMatchObject({ ok: true });
        expect(await command(current, { op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'human' } })).toMatchObject({ ok: true });
      }
      expect(await command(current, { op: 'assign', team: other, roles: [...PLANES], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
      await until(() => current.client.snapshots.get(current.room)?.seats.every((seat) => seat.occupant.kind !== 'open'));
      expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
      await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
      const handoff = await json<{ roomId: string; token: string; tickets: { token: string; role: string }[]; agentHandOver: boolean }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
      // A main-process match: the seat picker offers commanders mid-match.
      expect(handoff.agentHandOver).toBe(true);
      const match = server.host.authenticate(handoff.token)!.match;
      for (const ticket of handoff.tickets) { const room = await new Client(base).joinById(handoff.roomId, { token: ticket.token }); clients.push(room); }
      await until(() => match.tick > 0, 20_000);
      const depthsTicket = handoff.tickets.find((ticket) => ticket.role === 'depths')!.token;

      // Mid-match: the depths seat goes to the commander; its waiting agent gets its entry and acts at once.
      const entry = session.control.wait({ seconds: 30 });
      expect(await request(`/api/lobbies/${current.code}/seat`, { team: army, role: 'depths', occupant: { kind: 'commander', ref: { id: commander.id, kind: 'agent' } } }, current.auth)).toHaveProperty('status', 200);
      expect(await entry).toMatchObject({ phase: 'match', outcome: 'running', observation: { army, role: 'depths' } });
      expect(match.seats().find((seat) => seat.team === army && seat.role === 'depths')).toMatchObject({ controller: 'agent', commander: true });
      // The human's depths ticket no longer authenticates; the other planes are untouched.
      expect(server.host.authenticate(depthsTicket)).toBeUndefined();
      const delegated = await json<{ tickets: { role: string; queuePriority: boolean }[] }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
      expect(delegated.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
      expect(delegated.tickets.every((ticket) => ticket.queuePriority)).toBe(true);
      expect(await session.control.act([{ kind: 'queue_add', item: 'digger' }])).toEqual([{ ok: true }]);
      const snapshot = await until(() => { const value = current.client.snapshots.get(current.room); return value?.seats.find((seat) => seat.team === army && seat.role === 'depths')?.occupant.kind === 'commander' ? value : undefined; });
      expect(snapshot.seats.find((seat) => seat.team === army && seat.role === 'depths')?.occupant).toHaveProperty('ref.id', commander.id);
      // Another army's seat is not this owner's to hand over.
      expect(await request(`/api/lobbies/${current.code}/seat`, { team: other, role: 'depths', occupant: { kind: 'commander', ref: { id: commander.id, kind: 'agent' } } }, current.auth)).toHaveProperty('status', 403);

      // And back to the human: the commander returns to its lobby; a fresh ticket covers the depths seat again.
      expect(await request(`/api/lobbies/${current.code}/seat`, { team: army, role: 'depths', occupant: { kind: 'human' } }, current.auth)).toHaveProperty('status', 200);
      expect(await session.control.observe()).toMatchObject({ phase: 'lobby', seat: null });
      const again = await json<{ tickets: { role: string }[] }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
      expect(again.tickets.map((ticket) => ticket.role).sort()).toEqual([...PLANES].sort());
      expect(match.seats().find((seat) => seat.team === army && seat.role === 'depths')).toMatchObject({ controller: 'human' });
    });
  }
  /** A named agent commander of `owner` for `roles`, with one live session per role. */
  async function agentCommander(owner: { auth: string }, name: string, roles: readonly string[]) {
    const roster = await json<{ commanders: { id: string; name: string }[] }>(await request('/api/profile/commanders', { name, kind: 'agent', roles, isolation: { independentSessions: true } }, owner.auth));
    const commander = roster.commanders.find((entry) => entry.name === name)!;
    const ownerKey = server.host.commanders.owners().find((key) => server.host.commanders.roster(key).some((entry) => entry.id === commander.id))!;
    const sessions = Object.fromEntries(roles.map((role) => {
      const session = server.host.agentSession(server.host.commanders.token(ownerKey, commander.id), role as never);
      if (session?.kind !== 'commander') throw new Error('commander session expected');
      return [role, session];
    }));
    return { id: commander.id, ownerKey, sessions, occupant: { kind: 'commander', ref: { id: commander.id, kind: 'agent' } } };
  }
  it('one commander plays one army: a second army is refused before the start, its agent never sees both sides, and roles on one army are fine', { timeout: 60_000 }, async () => {
    const owner = await profile();
    const both = await agentCommander(owner, 'Two-army hopeful', ['surface', 'orbit']);
    const current = await lobby(owner.auth, 'benchmark');
    const reservations = () => server.host.commanders.roster(both.ownerKey).find((entry) => entry.id === both.id)!.reservations;
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['surface'], occupant: both.occupant })).toMatchObject({ ok: true });
    await until(() => reservations().length === 1 || undefined);
    // The other army is refused, by plane and whole army alike, and nothing about the room changes.
    const revision = current.client.snapshots.get(current.room)!.revision;
    expect(await command(current, { op: 'assign', team: 'se', roles: ['orbit'], occupant: both.occupant })).toMatchObject({ ok: false, code: 'commander_other_army' });
    expect(await command(current, { op: 'assign', team: 'se', roles: ['surface', 'orbit'], occupant: both.occupant })).toMatchObject({ ok: false, code: 'commander_other_army' });
    expect(current.client.snapshots.get(current.room)!.revision).toBe(revision);
    expect(current.client.snapshots.get(current.room)!.seats.filter((seat) => seat.team === 'se').every((seat) => seat.occupant.kind === 'bot')).toBe(true);
    expect(reservations()).toEqual([{ team: 'nw', role: 'surface', ready: false }]);
    expect(await both.sessions.orbit!.control.observe()).toMatchObject({ phase: 'lobby', seat: null });
    // Another plane of the same army is fine; so is replacing its own seats with the whole army.
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['orbit'], occupant: both.occupant })).toMatchObject({ ok: true });
    expect(await until(() => reservations().length === 2 ? reservations() : undefined)).toEqual([{ team: 'nw', role: 'surface', ready: false }, { team: 'nw', role: 'orbit', ready: false }]);
    expect(current.client.snapshots.get(current.room)!.practiceReasons).not.toContain('cross-side owner');
    for (const session of Object.values(both.sessions)) expect(await session.control.ready()).toMatchObject({ phase: 'lobby', seat: { team: 'nw' }, you: { ready: true } });
    const entries = Object.values(both.sessions).map((session) => session.control.wait({ seconds: 30 }));
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    for (const entry of entries) expect(await entry).toMatchObject({ phase: 'match', observation: { army: 'nw' } });
    const match = server.host.matches().find((candidate) => candidate.id === both.sessions.surface!.seat()!.match)!;
    expect(match.seats().filter((seat) => seat.commander).map((seat) => `${seat.team}/${seat.role}`).sort()).toEqual(['nw/orbit', 'nw/surface']);
    expect(match.sameOwnerOpposed).toBe(false);
  });
  it('mid-match: a commander is refused a seat of the other army; the owner’s different commanders may face each other as marked practice', { timeout: 60_000 }, async () => {
    const owner = await profile();
    const blue = await agentCommander(owner, 'Blue side', ['surface', 'orbit']);
    const red = await agentCommander(owner, 'Red side', ['surface']);
    const current = await lobby(owner.auth, 'benchmark');
    expect(await command(current, { op: 'assign', team: 'nw', roles: ['surface'], occupant: blue.occupant })).toMatchObject({ ok: true });
    await until(() => current.client.snapshots.get(current.room)?.seats.find((seat) => seat.team === 'nw' && seat.role === 'surface')?.occupant.kind === 'commander' || undefined);
    // Distinct isolated commanders of one owner may oppose each other (DESIGN §2.4): unranked practice, labelled.
    expect(await command(current, { op: 'assign', team: 'se', roles: ['surface'], occupant: red.occupant })).toMatchObject({ ok: true });
    const drafted = await until(() => { const value = current.client.snapshots.get(current.room); return value?.practiceReasons.includes('cross-side owner') ? value : undefined; });
    expect(drafted.unrankedPractice).toBe(true);
    for (const commander of [blue, red]) expect(await commander.sessions.surface!.control.ready()).toMatchObject({ you: { ready: true } });
    // Both agents wait through the start: a seat's presence is its agent's activity after allocation.
    const [entry, redEntry] = [blue, red].map((commander) => commander.sessions.surface!.control.wait({ seconds: 30 }));
    expect(await command(current, { op: 'start' })).toMatchObject({ ok: true });
    expect(await entry).toMatchObject({ phase: 'match', observation: { army: 'nw' } });
    expect(await redEntry).toMatchObject({ phase: 'match', observation: { army: 'se' } });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started' || undefined, 20_000);
    const match = server.host.matches().find((candidate) => candidate.id === blue.sessions.surface!.seat()!.match)!;
    // The P3 match carries the self-play mark, so no ranking or commander record counts it.
    expect(match.sameOwnerOpposed).toBe(true);

    const seat = (team: string, role: string) => request(`/api/lobbies/${current.code}/seat`, { team, role, occupant: blue.occupant }, owner.auth);
    const refused = await seat('se', 'orbit');
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ error: 'commander_other_army' });
    expect(match.seats().find((entry) => entry.team === 'se' && entry.role === 'orbit')).toMatchObject({ controller: 'bot' });
    expect(blue.sessions.orbit!.seat()).toBeFalsy();
    // Its own army's other plane is fine mid-match.
    const orbit = blue.sessions.orbit!.control.wait({ seconds: 30 });
    expect((await seat('nw', 'orbit')).status).toBe(200);
    expect(await orbit).toMatchObject({ phase: 'match', observation: { army: 'nw', role: 'orbit' } });
    expect(current.client.snapshots.get(current.room)!.practiceReasons).toContain('cross-side owner');
  });
  it('creates and configures FFA lobbies: four armies, seats carried by slot, distinct colours enforced', async () => {
    const ffa = await lobby((await profile()).auth, 'play', 'private', false, { mapId: 'four_corners', layoutId: 'ffa' });
    expect(ffa.snapshot.sides).toMatchObject([{ id: 'nw', alliance: 'blue' }, { id: 'ne', alliance: 'red' }, { id: 'se', alliance: 'green' }, { id: 'sw', alliance: 'violet' }]);
    expect(ffa.snapshot.seats.filter((seat) => seat.team === 'nw').every((seat) => seat.occupant.kind === 'human')).toBe(true);
    expect(ffa.snapshot.seats.filter((seat) => seat.team !== 'nw')).toHaveLength(3 * PLANES.length);
    expect(ffa.snapshot.seats.filter((seat) => seat.team !== 'nw').every((seat) => seat.occupant.kind === 'bot')).toBe(true);

    // A generated recipe's duel becomes its C4 ffa: the nw and se seats carry over by slot, ne and sw open.
    const current = await lobby((await profile()).auth);
    expect(await command(current, { op: 'assign', team: 'se', roles: [...PLANES], occupant: { kind: 'bot', level: 'veteran', options: {} } })).toMatchObject({ ok: true });
    const before = await until(() => { const value = current.client.snapshots.get(current.room); return value?.seats.some((seat) => seat.occupant.kind === 'bot') ? value : undefined; });
    expect(await command(current, { op: 'configure', layoutId: 'ffa' })).toMatchObject({ ok: true });
    const four = await until(() => { const value = current.client.snapshots.get(current.room); return value?.layoutId === 'ffa' ? value : undefined; });
    expect(four.rules.map.slots).toBe(4);
    expect(four.sides.map((side) => side.id)).toEqual(['nw', 'ne', 'se', 'sw']);
    const occupants = (value: LobbySnapshot, team: string) => value.seats.filter((seat) => seat.team === team).map((seat) => seat.occupant);
    expect(occupants(four, 'nw')).toEqual(occupants(before, 'nw'));
    expect(occupants(four, 'se')).toEqual(occupants(before, 'se'));
    expect([...occupants(four, 'ne'), ...occupants(four, 'sw')].every((occupant) => occupant.kind === 'open')).toBe(true);

    // Colours: sparse by army, applied over the current ones; every army keeps a distinct colour (stage 2).
    expect(await command(current, { op: 'configure', colours: { nw: 'violet', sw: 'blue' } })).toMatchObject({ ok: true });
    const recoloured = await until(() => { const value = current.client.snapshots.get(current.room); return value?.sides[0]!.alliance === 'violet' ? value : undefined; });
    expect(recoloured.sides.map((side) => side.alliance)).toEqual(['violet', 'red', 'green', 'blue']);
    expect(await command(current, { op: 'configure', colours: { ne: 'green' } })).toMatchObject({ ok: false, code: 'colour_taken' });
    for (const colours of [{ ne: 'orange' }, { north: 'blue' }, ['blue'], 'blue']) {
      expect(await command(current, { op: 'configure', colours })).toMatchObject({ ok: false, code: 'bad_colour' });
    }
    expect(current.client.snapshots.get(current.room)!.revision).toBe(recoloured.revision);
    // A layout change starts from the new layout's default colours.
    expect(await command(current, { op: 'configure', layoutId: 'duel' })).toMatchObject({ ok: true });
    const back = await until(() => { const value = current.client.snapshots.get(current.room); return value?.layoutId === 'duel' ? value : undefined; });
    expect(back.sides).toMatchObject([{ id: 'nw', alliance: 'blue' }, { id: 'se', alliance: 'red' }]);
    expect(back.rules.map.slots).toBe(2);
  });
  it('FFA observer grants list every army', async () => {
    const bench = await lobby((await profile()).auth, 'benchmark', 'private', false, { mapId: 'four_corners', layoutId: 'ffa' });
    expect(bench.snapshot.you.grant).toMatchObject({ kind: 'omniscient', teams: ['nw', 'ne', 'se', 'sw'], delayMs: 0 });
    expect(bench.snapshot.seats).toHaveLength(4 * PLANES.length);
  });
  it('FFA forfeit eliminates the leaving army and the match goes on; an eliminated human gets an every-army observer grant', { timeout: 60_000 }, async () => {
    const enter = async (current: ConnectedLobby) => {
      await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
      const handoff = await json<{ roomId: string; token: string; tickets: { token: string; role: string }[] }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
      const match = server.host.authenticate(handoff.token)!.match;
      for (const ticket of handoff.tickets) { const room = await new Client(base).joinById(handoff.roomId, { token: ticket.token }); clients.push(room); }
      await until(() => match.tick > 0, 20_000);
      return match;
    };
    const select = { mapId: 'four_corners', layoutId: 'ffa' };

    // Leaving mid-match forfeits: nw is out, the three bot armies play on (a started public lobby outlives its members).
    const leaver = await lobby((await profile()).auth, 'play', 'public', true, select);
    const left = await enter(leaver);
    expect(left.teams).toEqual(['nw', 'ne', 'se', 'sw']);
    expect((await request(`/api/lobbies/${leaver.code}/leave`, {}, leaver.auth)).status).toBe(204);
    await until(() => left.outcome('nw') === 'loss', 20_000);
    expect(left.over).toBe(false);
    expect((['ne', 'se', 'sw'] as const).map((army) => left.outcome(army))).toEqual(['running', 'running', 'running']);

    // Eliminated (here: forfeited through PlayerThree), the human still in the lobby watches every army.
    const stayer = await lobby((await profile()).auth, 'play', 'private', true, select);
    const stayed = await enter(stayer);
    const early = await request(`/api/lobbies/${stayer.code}/ticket`, { observer: true }, stayer.auth);
    expect(early.status).toBe(409); expect(await json(early)).toEqual({ error: 'still_playing' });
    stayed.forfeit('nw');
    await until(() => stayed.outcome('nw') === 'loss', 20_000);
    expect(stayed.over).toBe(false);
    const watched = await json<{ observer: boolean; token: string; grant: unknown }>(await request(`/api/lobbies/${stayer.code}/ticket`, { observer: true }, stayer.auth));
    expect(watched).toMatchObject({ observer: true, grant: { kind: 'omniscient', teams: ['nw', 'ne', 'se', 'sw'], delayMs: 0 } });
    expect(server.host.authenticate(watched.token)!.principal.kind).toBe('observer');
  });
  it('a kick never decides a running match: seat owners of a started duel or FFA cannot be kicked', { timeout: 90_000 }, async () => {
    /** Leader on nw, a second human on `guestArmy`, bots on every other army; started, with the leader's seats joined. */
    const started = async (selection: { mapId: string; layoutId: string }, guestArmy: string) => {
      const leader = await lobby((await profile()).auth, 'host', 'private', false, selection);
      const guest = await profile();
      expect((await request('/api/lobbies/join', { code: leader.code, observer: false, team: guestArmy }, guest.auth)).status).toBe(200);
      const grant = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${leader.code}/connect`, {}, guest.auth));
      const client = new LobbyClient(base); const room = await client.joinById(grant.roomId, { token: grant.token }); clients.push(room);
      const joined: ConnectedLobby = { code: leader.code, roomId: leader.roomId, auth: guest.auth, room, client, snapshot: await until(() => client.snapshots.get(room)) };
      for (const side of leader.snapshot.sides) if (side.id !== 'nw' && side.id !== guestArmy) {
        expect(await command(leader, { op: 'assign', team: side.id, roles: [...PLANES], occupant: { kind: 'bot', level: 'idle', options: {} } })).toMatchObject({ ok: true });
      }
      await until(() => joined.client.snapshots.get(joined.room)?.seats.every((seat) => seat.occupant.kind !== 'open'));
      expect(await command(joined, { op: 'ready', ready: true })).toMatchObject({ ok: true });
      expect(await command(leader, { op: 'start' })).toMatchObject({ ok: true });
      await until(() => leader.client.snapshots.get(leader.room)?.phase === 'started', 20_000);
      const handoff = await json<{ roomId: string; token: string; tickets: { token: string }[] }>(await request(`/api/lobbies/${leader.code}/ticket`, {}, leader.auth));
      for (const ticket of handoff.tickets) { const seat = await new Client(base).joinById(handoff.roomId, { token: ticket.token }); clients.push(seat); }
      const kick = () => command(leader, { op: 'kick', memberId: joined.snapshot.you.memberId });
      return { match: server.host.authenticate(handoff.token)!.match, kick };
    };

    const duel = await started({ mapId: 'open', layoutId: 'duel' }, 'se');
    expect(await duel.kick()).toMatchObject({ ok: false, code: 'not_open' });
    expect([duel.match.outcome('nw'), duel.match.outcome('se')]).toEqual(['running', 'running']);

    const ffa = await started({ mapId: 'four_corners', layoutId: 'ffa' }, 'ne');
    expect(await ffa.kick()).toMatchObject({ ok: false, code: 'not_open' });
    expect(ffa.match.over).toBe(false);
    expect((['nw', 'ne', 'se', 'sw'] as const).map((army) => ffa.match.outcome(army))).toEqual(['running', 'running', 'running', 'running']);
  });
});

describe('absent human of an eliminated army', () => {
  /** A short recovery window so absence is reached within the test (the main server holds absent humans 30 s). */
  const RECOVERY_MS = 500;
  const ADMIN = 'lobby-test-admin-token-0123456789';
  let main: { server: GameServer; base: string };
  beforeAll(async () => {
    main = { server, base };
    ({ server, base } = await start({ lobbyCountdownMs: 10, lobbyReservationMs: 30_000, lobbyRecoveryMs: RECOVERY_MS, devAdminToken: ADMIN }));
  });
  afterAll(async () => { await server.close(); ({ server, base } = main); });

  it('never forfeits, ends or removes the lobby, and the human can still watch every army', { timeout: 60_000 }, async () => {
    const current = await lobby((await profile()).auth, 'play', 'private', true, { mapId: 'four_corners', layoutId: 'ffa' });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    const handoff = await json<{ roomId: string; tickets: { token: string }[]; token: string }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
    const match = server.host.authenticate(handoff.token)!.match;
    const seats: Room[] = [];
    for (const ticket of handoff.tickets) seats.push(await new Client(base).joinById(handoff.roomId, { token: ticket.token }));
    await until(() => match.tick > 0, 20_000);
    // nw's Surface Spire falls (the sim eliminates the army; nothing was forfeited), then its human leaves the game.
    const cheat = await fetch(`${base}/dev/matches/${handoff.roomId}/cheat`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'spire', army: 'nw', plane: 'surface', hp: 0 }) });
    expect(cheat.status).toBe(200);
    await until(() => match.outcome('nw') === 'loss', 20_000);
    for (const seat of seats) await seat.leave();
    // Absence is a real-time window (lobbyRecoveryMs) checked by the lobby sweep: wait it out plus two sweeps.
    await sleep(RECOVERY_MS + 600);
    expect(match.over).toBe(false);
    const watched = await request(`/api/lobbies/${current.code}/ticket`, { observer: true }, current.auth);
    expect(watched.status).toBe(200);
    expect(await json(watched)).toMatchObject({ observer: true, grant: { kind: 'omniscient', teams: ['nw', 'ne', 'se', 'sw'], delayMs: 0 } });
    expect((['ne', 'se', 'sw'] as const).map((army) => match.outcome(army))).toEqual(['running', 'running', 'running']);
  });

  it('switches a still-connected eliminated human to an every-army observer without ending or closing the match', { timeout: 60_000 }, async () => {
    const current = await lobby((await profile()).auth, 'play', 'private', true, { mapId: 'four_corners', layoutId: 'ffa' });
    await until(() => current.client.snapshots.get(current.room)?.phase === 'started', 20_000);
    const handoff = await json<{ roomId: string; tickets: { token: string }[]; token: string }>(await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth));
    const match = server.host.authenticate(handoff.token)!.match;
    const seats: Room[] = [];
    for (const ticket of handoff.tickets) seats.push(await new Client(base).joinById(handoff.roomId, { token: ticket.token }));
    await until(() => match.tick > 0, 20_000);
    // The Surface segment's fall alone eliminates nw; its remaining segments are removed on that tick, so further
    // per-plane cheats would race the sim tick (409 segment_destroyed).
    const cheat = await fetch(`${base}/dev/matches/${handoff.roomId}/cheat`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'spire', army: 'nw', plane: 'surface', hp: 0 }) });
    expect(cheat.status).toBe(200);
    await until(() => match.outcome('nw') === 'loss', 20_000);
    // The client's real sequence: observer ticket, its seat connections drop, then it joins as the observer.
    const observed = await json<{ roomId: string; token: string }>(await request(`/api/lobbies/${current.code}/ticket`, { observer: true }, current.auth));
    expect(observed).toMatchObject({ observer: true, grant: { kind: 'omniscient', teams: ['nw', 'ne', 'se', 'sw'], delayMs: 0 } });
    for (const seat of seats) await seat.leave().catch(() => {});
    // A seat ticket for an army already out is refused as such, and does not revoke the observer pass.
    const seat = await request(`/api/lobbies/${current.code}/ticket`, {}, current.auth);
    expect(seat.status).toBe(409); expect(await json(seat)).toEqual({ error: 'eliminated' });
    const devList = async () => (await json<{ matches: { roomId: string }[] }>(await fetch(`${base}/dev/matches`, { headers: { authorization: `Bearer ${ADMIN}` } }))).matches.map((entry) => entry.roomId);
    expect(await devList()).toContain(handoff.roomId);
    const observer = await new Client(base).joinById(observed.roomId, { token: observed.token }); clients.push(observer);
    let frames = 0; observer.onMessage('*', () => { frames++; });
    const at = match.tick;
    await until(() => match.tick > at + 20 && frames > 0, 20_000);
    expect(match.over).toBe(false);
    expect(await devList()).toContain(handoff.roomId);
    // Leaving the lobby altogether (its last member) never closes a match that still has armies in play.
    expect((await request(`/api/lobbies/${current.code}/leave`, {}, current.auth)).status).toBe(204);
    const after = match.tick;
    await until(() => match.tick > after + 20, 20_000);
    expect(match.over).toBe(false);
    expect(await devList()).toContain(handoff.roomId);
  });
});
