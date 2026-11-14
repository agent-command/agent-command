// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from 'playerthree/protocol';
import type { SeatInfo } from 'playerthree';
import { Connection } from '../src/match-connection.ts';
import { ApiError } from '../src/api.ts';
import type { ConnectionEvents, MatchTicket } from '../src/net.ts';
import { MATCH_CLOSE } from '@agent-command/game/lobby';
import type { Plane } from '@agent-command/game/contract';

const mocks = vi.hoisted(() => ({ join: vi.fn(), call: vi.fn(), ticket: vi.fn(), renew: vi.fn(), leave: vi.fn() }));
vi.mock('@colyseus/sdk', () => ({ Client: class { joinById = mocks.join; } }));
// Lobby calls by action, with the credential that admitted the match (the body is always empty).
vi.mock('../src/profile.ts', () => ({
  profileCall: (path: string, { body, ...auth }: { body: unknown }) => {
    mocks.call(path, body);
    const [, code, action] = /^\/api\/lobbies\/([^/]+)\/(ticket|renew|leave)$/.exec(path)!;
    return ({ ticket: mocks.ticket, renew: mocks.renew, leave: mocks.leave } as Record<string, (...args: unknown[]) => unknown>)[action!]!(decodeURIComponent(code!), auth);
  },
}));
const PROFILE = { secret: 'profile-secret' };

class Wire {
  readonly reconnection = { enabled: true };
  authority?: { roles: Plane[]; queuePriority: boolean };
  readonly messages = new Map<string, (message: never) => void>();
  readonly sent: { type: string; message: Record<string, unknown> }[] = [];
  left: (code: number) => void = () => {};
  onMessage(type: string, handler: (message: never) => void) { this.messages.set(type, handler); }
  onLeave(handler: (code: number) => void) { this.left = handler; }
  send(type: string, message: Record<string, unknown>) {
    this.sent.push({ type, message });
    if (type === 'ac:authority') {
      if (this.authority) this.emit(type, this.authority);
      return;
    }
    this.emit(MSG.result, { op: 'result', seq: message.seq, ok: true, data: [] });
  }
  async leave() { this.left(1000); }
  emit(type: string, message: unknown) { this.messages.get(type)?.(message as never); }
}
let wires: Wire[];
let events: ConnectionEvents;
let ticket: MatchTicket;
let connection: Connection | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  wires = [];
  events = { view: vi.fn(), seats: vi.fn(), report: vi.fn(), left: vi.fn(), said: vi.fn(), cards: vi.fn(), recovering: vi.fn(), authorityChanged: vi.fn() };
  ticket = { roomId: 'match', token: 'surface-private', lobbyCode: 'public-lobby-code', lobbyAuth: PROFILE, tickets: [
    { role: 'surface', token: 'surface-private', expiresAt: 220_000 },
    { role: 'orbit', token: 'orbit-private', expiresAt: 220_000 },
  ] };
  mocks.join.mockImplementation(async () => { const wire = new Wire(); wires.push(wire); return wire; });
  mocks.renew.mockImplementation(async () => ({ roomId: 'match', tickets: ticket.tickets!.map(({ role }) => ({ role, expiresAt: Date.now() + 600_000 })) }));
  mocks.leave.mockResolvedValue(undefined);
  mocks.ticket.mockResolvedValue({ ...ticket, tickets: ticket.tickets!.map((item) => ({ ...item, token: `${item.token}-replacement`, expiresAt: 500_000 })) });
});
afterEach(() => {
  connection?.leave();
  connection = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('exact-seat match connections', () => {
  it.each([
    { principal: 'team', roles: ['surface', 'sky', 'orbit', 'depths'], queuePriority: true },
    { principal: 'human', roles: ['sky'], queuePriority: true },
    { principal: 'seat', roles: ['orbit'], queuePriority: false },
    { principal: 'observer', roles: [], queuePriority: false },
  ] satisfies { principal: string; roles: Plane[]; queuePriority: boolean }[])(
    'requests $principal authority after handlers attach when join metadata was dropped',
    async ({ roles, queuePriority }) => {
      mocks.join.mockImplementationOnce(async () => {
        const wire = new Wire();
        wire.authority = { roles, queuePriority };
        // Match the SDK lifecycle: onJoin data has no receiver before joinById resolves.
        wire.emit('ac:authority', wire.authority);
        expect(wire.messages.has('ac:authority')).toBe(false);
        wires.push(wire);
        return wire;
      });
      connection = await Connection.join('private-match', 'authenticated-token', events);
      expect(wires[0]!.sent).toEqual([{ type: 'ac:authority', message: {} }]);
      expect(events.authorityChanged).toHaveBeenCalledOnce();
      for (const role of ['surface', 'sky', 'orbit', 'depths'] as const) {
        expect(connection.canAct(role)).toBe(roles.some((allowed) => allowed === role));
        expect(connection.canPrioritize(role)).toBe(roles.some((allowed) => allowed === role) && queuePriority);
      }
      // A later authoritative revocation replaces, rather than unions with, old authority.
      wires[0]!.emit('ac:authority', { roles: [], queuePriority: false });
      for (const role of ['surface', 'sky', 'orbit', 'depths'] as const) expect(connection.canAct(role)).toBe(false);
    },
  );

  it('fails closed until the requested authority arrives and never infers it from public seats', async () => {
    connection = await Connection.join('private-match', 'authenticated-token', events);
    wires[0]!.emit(MSG.seats, { seats: [{ team: 'nw', role: 'surface', controller: 'human' }] });
    expect(connection.canAct('surface')).toBe(false);
    expect(connection.canPrioritize('surface')).toBe(false);
    wires[0]!.emit('ac:authority', { roles: ['surface'], queuePriority: true });
    expect(connection.canAct('surface')).toBe(true);
    connection.handOff();
    wires[0]!.emit('ac:authority', { roles: ['surface', 'orbit'], queuePriority: true });
    expect(connection.canAct('surface')).toBe(false);
    expect(connection.canAct('orbit')).toBe(false);
  });

  it('exposes all successfully joined split tickets without widening seat priority or accepting legacy metadata', async () => {
    ticket.tickets![0]!.queuePriority = true;
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    expect(events.authorityChanged).toHaveBeenCalledOnce();
    expect(connection.canAct('surface')).toBe(true);
    expect(connection.canAct('orbit')).toBe(true);
    expect(connection.canAct('sky')).toBe(false);
    expect(connection.canPrioritize('surface')).toBe(true);
    expect(connection.canPrioritize('orbit')).toBe(false);
    for (const wire of wires) {
      expect(wire.sent).toEqual([]);
      wire.emit('ac:authority', { roles: ['sky', 'depths'], queuePriority: true });
    }
    expect(connection.canAct('sky')).toBe(false);
    expect(connection.canAct('depths')).toBe(false);
    expect(connection.canPrioritize('orbit')).toBe(false);
  });

  it('replaces revoked split roles with the recovered exact ticket and notifies after authority is usable', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    const states: boolean[][] = [];
    events.authorityChanged = () => states.push(['surface', 'orbit', 'sky'].map((role) => connection!.canAct(role as Plane)));
    mocks.ticket.mockResolvedValueOnce({ ...ticket, tickets: [{ role: 'sky', token: 'new-human', expiresAt: 500_000, queuePriority: true }] });
    wires[0]!.left(1006);
    expect(connection.canAct('surface')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual([[false, false, false], [false, false, true]]);
    expect(connection.canPrioritize('sky')).toBe(true);
    wires[0]!.emit('ac:authority', { roles: ['surface'], queuePriority: true });
    expect(connection.canAct('surface')).toBe(false);
  });

  it('recovery to an observer ticket removes every former acting role', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    mocks.ticket.mockResolvedValueOnce({ ...ticket, tickets: [{ token: 'observer', expiresAt: 500_000 }] });
    wires[0]!.left(1006);
    await vi.advanceTimersByTimeAsync(0);
    for (const role of ['surface', 'sky', 'orbit', 'depths'] as const) {
      expect(connection.canAct(role)).toBe(false);
      expect(connection.canPrioritize(role)).toBe(false);
    }
    expect(wires[2]!.sent).toEqual([]);
    expect(events.authorityChanged).toHaveBeenCalledTimes(3);
  });

  it.each(['report', 'eliminated'] as const)('notifies consumers when %s removes ticket authority', async (end) => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    const states: boolean[] = [];
    events.authorityChanged = () => states.push(connection!.canAct('surface'));
    if (end === 'report') wires[0]!.emit(MSG.report, { op: 'report', team: 'nw', data: { outcome: 'win' } });
    else connection.eliminated();
    expect(states).toEqual([false]);
  });

  it('joins each private seat separately and routes operations only through the matching capability', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    expect(mocks.join.mock.calls).toEqual([
      ['match', { token: 'surface-private' }],
      ['match', { token: 'orbit-private', view: false }],
    ]);
    expect(wires.every((wire) => !wire.reconnection.enabled)).toBe(true);
    await connection.act('surface', [{ kind: 'rally', x: 10, y: 10 }]);
    await connection.setController('orbit', 'agent');
    expect(wires[0]!.sent[0]!.message).toMatchObject({ role: 'surface', method: 'act' });
    expect(wires[1]!.sent[0]!.message).toMatchObject({ role: 'orbit', controller: 'agent' });
    await expect(connection.setController('sky', 'human')).rejects.toMatchObject({ code: 'forbidden' });
    expect(wires.flatMap((wire) => wire.sent).some((item) => item.message.role === 'sky')).toBe(false);
    await connection.tell('all', 'owner-private');
    expect(wires[0]!.sent.at(-1)!.message).toMatchObject({ op: 'tell', roles: ['surface'] });
    expect(wires[1]!.sent.at(-1)!.message).toMatchObject({ op: 'tell', roles: ['orbit'] });
  });

  it('correlates out-of-order seat replies and ignores a timed-out reply without settling a later request', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    for (const wire of wires) vi.spyOn(wire, 'send').mockImplementation((type, message) => { wire.sent.push({ type, message }); });
    const surface = connection.policyStatus('surface');
    const orbit = connection.policyStatus('orbit');
    const surfaceSeq = wires[0]!.sent.at(-1)!.message.seq;
    const orbitSeq = wires[1]!.sent.at(-1)!.message.seq;
    expect(surfaceSeq).not.toBe(orbitSeq);
    wires[1]!.emit(MSG.result, { op: 'result', seq: orbitSeq, ok: true, data: null });
    await expect(orbit).resolves.toBeNull();
    const timedOut = expect(surface).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10_000);
    await timedOut;

    const later = connection.policyStatus('surface');
    const laterSeq = wires[0]!.sent.at(-1)!.message.seq;
    const settled = vi.fn();
    void later.then(settled, settled);
    wires[0]!.emit(MSG.result, { op: 'result', seq: surfaceSeq, ok: true, data: null });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    wires[0]!.emit(MSG.result, { op: 'result', seq: laterSeq, ok: false, code: 'forbidden' });
    await expect(later).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects pending requests on room replacement and keeps sequence identity across recovery', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    const old = wires[0]!;
    vi.spyOn(old, 'send').mockImplementation((type, message) => { old.sent.push({ type, message }); });
    const before = connection.policyStatus('surface');
    const oldSeq = old.sent.at(-1)!.message.seq;
    const disconnected = expect(before).rejects.toMatchObject({ code: 'disconnected' });
    old.left(1006);
    await disconnected;
    await vi.advanceTimersByTimeAsync(0);
    const replacement = wires[3]!;
    vi.spyOn(replacement, 'send').mockImplementation((type, message) => { replacement.sent.push({ type, message }); });
    const after = connection.policyStatus('surface');
    const newSeq = replacement.sent.at(-1)!.message.seq;
    expect(newSeq).not.toBe(oldSeq);
    const settled = vi.fn();
    void after.then(settled, settled);
    old.emit(MSG.result, { op: 'result', seq: newSeq, ok: true, data: null });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    replacement.emit(MSG.result, { op: 'result', seq: newSeq, ok: true, data: null });
    await expect(after).resolves.toBeNull();
  });

  it('uses one own-side presentation stream while merging exact-role private state and public cards', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    wires[0]!.emit(MSG.view, { op: 'view', team: 'nw', version: 1, view: { tick: 1, res: { alloy: 5 } } });
    wires[1]!.emit(MSG.view, { op: 'view', team: 'nw', version: 1, view: { tick: 999 } });
    expect(events.view).toHaveBeenCalledExactlyOnceWith({ tick: 1, res: { alloy: 5 } });
    // Deltas apply onto the previous version; untouched members keep their identity.
    wires[0]!.emit(MSG.view, { op: 'view', team: 'nw', version: 2, delta: { v: { tick: 2 } } });
    expect(events.view).toHaveBeenLastCalledWith({ tick: 2, res: { alloy: 5 } });
    const [first, second] = vi.mocked(events.view).mock.calls.map(([v]) => v as unknown as { res: unknown });
    expect(second!.res).toBe(first!.res);
    wires[0]!.emit(MSG.seats, { seats: [{ team: 'nw', role: 'surface' } as SeatInfo] });
    wires[1]!.emit(MSG.seats, { seats: [{ team: 'nw', role: 'orbit' } as SeatInfo] });
    expect(events.seats).toHaveBeenLastCalledWith([{ team: 'nw', role: 'surface' }, { team: 'nw', role: 'orbit' }]);
    const cards = [{ seat: { team: 'nw', role: 'orbit' }, kind: 'agent', aiPlayer: true, mode: 'live' }];
    wires[0]!.emit(MSG.cards, { cards });
    expect(events.cards).toHaveBeenCalledExactlyOnceWith(cards);
  });

  it('renews connected seats in place: same sockets, same view stream, no reconnect, commands keep flowing', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    wires[0]!.emit(MSG.view, { op: 'view', team: 'nw', version: 1, view: { tick: 1 } });
    // Halfway through the 120 s admission: one in-place renewal, nothing rejoins and nothing reads "Reconnecting…".
    await vi.advanceTimersByTimeAsync(59_000);
    expect(mocks.renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(ticket.lobbyCode, PROFILE);
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(mocks.join).toHaveBeenCalledTimes(2);
    expect(events.recovering).not.toHaveBeenCalled();
    wires[0]!.emit(MSG.view, { op: 'view', team: 'nw', version: 2, delta: { v: { tick: 2 } } });
    expect(events.view).toHaveBeenLastCalledWith({ tick: 2 });
    // Commands still go out over the same seat socket (a reconnect rejected them as `disconnected`).
    await expect(connection.act('surface', [{ kind: 'stop' }])).resolves.toEqual([]);
    expect(wires[0]!.sent.at(-1)!.message).toMatchObject({ role: 'surface', method: 'act' });
    // The next renewal follows the extended expiry (600 s → after 300 s), not the original one.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(mocks.renew).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.renew).toHaveBeenCalledTimes(2);
    expect(mocks.join).toHaveBeenCalledTimes(2);
    expect(events.left).not.toHaveBeenCalled();
  });

  it('a network blip during renewal retries in place; the seats stay up meanwhile', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    mocks.renew.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.renew).toHaveBeenCalledOnce();
    // Half of the remaining 60 s later.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.renew).toHaveBeenCalledTimes(2);
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(mocks.join).toHaveBeenCalledTimes(2);
    expect(events.recovering).not.toHaveBeenCalled();
  });

  it('a seat the server cannot extend takes fresh tickets and ignores packets from the replaced connections', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    const old = wires[0]!;
    mocks.renew.mockRejectedValueOnce(new ApiError('not_renewable'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.ticket).toHaveBeenCalledExactlyOnceWith(ticket.lobbyCode, PROFILE);
    expect(mocks.join).toHaveBeenCalledTimes(4);
    expect(events.recovering).toHaveBeenNthCalledWith(1, true);
    expect(events.recovering).toHaveBeenLastCalledWith(false);
    old.emit(MSG.view, { op: 'view', team: 'nw', version: 1, view: { tick: -1 } });
    expect(events.view).not.toHaveBeenCalled();
    // The view-receiving seat rejoins last (wires[3]): its keyframe starts the new stream.
    expect(mocks.join.mock.calls.slice(2)).toEqual([
      ['match', { token: 'orbit-private-replacement', view: false }],
      ['match', { token: 'surface-private-replacement' }],
    ]);
    wires[3]!.emit(MSG.view, { op: 'view', team: 'nw', version: 7, view: { tick: 3 } });
    expect(events.view).toHaveBeenCalledExactlyOnceWith({ tick: 3 });
    expect(events.left).not.toHaveBeenCalled();
  });

  it('a delta without its base version recovers through a fresh admission instead of rendering a guess', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    wires[0]!.emit(MSG.view, { op: 'view', team: 'nw', version: 1, view: { tick: 1 } });
    wires[0]!.emit(MSG.view, { op: 'view', team: 'nw', version: 3, delta: { v: { tick: 3 } } });
    expect(events.view).toHaveBeenCalledExactlyOnceWith({ tick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ticket).toHaveBeenCalledExactlyOnceWith(ticket.lobbyCode, PROFILE);
    expect(events.recovering).toHaveBeenNthCalledWith(1, true);
  });

  it('reauthorizes a dropped match connection without creating or replacing the browser profile', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    wires[0]!.left(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ticket).toHaveBeenCalledExactlyOnceWith(ticket.lobbyCode, PROFILE);
    expect(mocks.join).toHaveBeenCalledTimes(4);
    expect(events.left).not.toHaveBeenCalled();
    connection.leave();
    expect(mocks.leave).toHaveBeenCalledExactlyOnceWith(ticket.lobbyCode, PROFILE);
  });
  it('anonymous Play (no stored profile) renews, recovers and leaves with its lobby visitor capability', async () => {
    const visitor = { visitorToken: 'visitor-capability' };
    connection = await Connection.join(ticket.roomId, ticket.token, events, { ...ticket, lobbyAuth: visitor });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(ticket.lobbyCode, visitor);
    wires[0]!.left(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ticket).toHaveBeenCalledExactlyOnceWith(ticket.lobbyCode, visitor);
    expect(events.left).not.toHaveBeenCalled();
    connection.leave();
    expect(mocks.leave).toHaveBeenCalledExactlyOnceWith(ticket.lobbyCode, visitor);
  });
  it('bounds recovery without a lobby credential instead of silently creating a new identity', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, { ...ticket, lobbyAuth: undefined });
    wires[0]!.left(1006);
    await expect(connection.setController('surface', 'human')).rejects.toMatchObject({ code: 'disconnected' });
    await vi.advanceTimersByTimeAsync(750);
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.join).toHaveBeenCalledTimes(2);
    expect(events.left).toHaveBeenCalledExactlyOnceWith('lost');
  });

  it.each(['restart', 'update', 'closed'] as const)('a match the server takes away (%s) says so: no rejoin, and nothing after is shown as a result', async (reason) => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    // The server's own record of the match (a draw) must never reach the screen, even if a late packet carried it.
    const closing = wires[0]!;
    closing.left(MATCH_CLOSE[reason]);
    await expect(connection.setController('surface', 'human')).rejects.toMatchObject({ code: 'disconnected' });
    closing.emit(MSG.report, { op: 'report', team: 'nw', data: { outcome: 'draw' } });
    closing.emit(MSG.view, { op: 'view', team: 'nw', version: 1, view: { tick: 9, outcome: 'draw' } });
    wires[1]!.left(MATCH_CLOSE[reason]);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(events.left).toHaveBeenCalledExactlyOnceWith(reason);
    expect(events.report).not.toHaveBeenCalled();
    expect(events.view).not.toHaveBeenCalled();
    expect(events.recovering).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.join).toHaveBeenCalledTimes(2);
  });

  it('a rejoin that finds the lobby gone (the server restarted while we were cut off) says restarted, at once', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    mocks.ticket.mockRejectedValue(new ApiError('lobby_not_found'));
    wires[0]!.left(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ticket).toHaveBeenCalledOnce();
    expect(events.left).toHaveBeenCalledExactlyOnceWith('restart');
    expect(events.recovering).toHaveBeenLastCalledWith(false);
  });

  it('a rejoin whose room is gone says restarted, not a lost connection', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    // The SDK's matchmaking error carries the server's code as its message.
    mocks.join.mockRejectedValueOnce(Object.assign(new Error('room_not_found'), { code: 404 }));
    wires[0]!.left(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.ticket).toHaveBeenCalledOnce();
    expect(events.left).toHaveBeenCalledExactlyOnceWith('restart');
  });

  it('a real outcome already received stands when the server then closes the room for a restart', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    wires[0]!.emit(MSG.report, { op: 'report', team: 'nw', data: { outcome: 'win' } });
    for (const wire of wires) wire.left(MATCH_CLOSE.restart);
    expect(events.report).toHaveBeenCalledExactlyOnceWith('nw', { outcome: 'win' });
    expect(events.left).not.toHaveBeenCalled();
  });


  it('retains the private legacy team path without issuing profile or lobby requests', async () => {
    connection = await Connection.join('private-match', 'private-root', events);
    await connection.setController('sky', 'human');
    connection.leave();
    expect(mocks.join).toHaveBeenCalledExactlyOnceWith('private-match', { token: 'private-root' });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it('does not renew or reconnect credentials revoked after the authorized terminal report', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    wires[0]!.emit(MSG.report, { op: 'report', team: 'nw', data: { outcome: 'win' } });
    for (const wire of wires) wire.left(1000);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(events.report).toHaveBeenCalledExactlyOnceWith('nw', { outcome: 'win' });
    expect(events.left).not.toHaveBeenCalled();
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(mocks.join).toHaveBeenCalledTimes(2);
    await expect(connection.setController('surface', 'human')).rejects.toMatchObject({ code: 'disconnected' });
  });


  it('never re-tickets seats once our army is eliminated: a dropped seat is not a disconnect', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    connection.eliminated();
    wires[0]!.left(4000);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(events.recovering).not.toHaveBeenCalled();
    expect(events.left).not.toHaveBeenCalled();
  });

  it('stops quietly when the server refuses seat tickets because the army is out', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    mocks.ticket.mockRejectedValue(new ApiError('eliminated'));
    wires[0]!.left(4000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.ticket).toHaveBeenCalledOnce();
    expect(events.recovering).toHaveBeenLastCalledWith(false);
    expect(events.left).not.toHaveBeenCalled();
    // Later drops are not recovered either.
    wires[1]!.left(4000);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(mocks.ticket).toHaveBeenCalledOnce();
  });

  it('hands an eliminated seat over to the observer without leaving the lobby that carries the observer pass', async () => {
    connection = await Connection.join(ticket.roomId, ticket.token, events, ticket);
    connection.eliminated();
    connection.handOff();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.leave).not.toHaveBeenCalled();
    expect(mocks.ticket).not.toHaveBeenCalled();
    expect(events.left).not.toHaveBeenCalled();
    connection.leave();
    expect(mocks.leave).not.toHaveBeenCalled();
  });
});
