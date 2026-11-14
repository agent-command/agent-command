import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientState, type Client } from '@colyseus/core';
import { createPlayerThreeHost, type CreateMatchOptions } from 'playerthree/host';
import { definition, type ArmyId } from '@agent-command/game';
import { loadConfig } from '../src/config.ts';
import { createAgentCommandRoom, MatchRegistry, type LiveMatch } from '../src/room.ts';

const OWNER = 'abandon_owner_0001';
const GRACE = 100;
const cleanups: (() => void)[] = [];
let nextId = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Real host, leases, binding, room timers and disposal; only framework transport shutdown is controlled here. */
async function fixture(options: {
  featured?: boolean;
  preparing?: boolean;
  idleExempt?: boolean;
  observerDelayMs?: number;
  maxLifeMs?: number;
  assignment?: { team: ArmyId; kind: 'human' | 'agent' };
  readySeconds?: number;
} = {}) {
  const host = createPlayerThreeHost({ definition });
  await host.ready;
  const matchOptions: CreateMatchOptions<typeof definition.manifest> = { realtime: false, teams: ['nw', 'se'] };
  const commander = options.assignment?.kind === 'agent'
    ? host.commanders.create(OWNER, { name: 'Abandon', kind: 'agent', roles: ['surface'], isolation: { independentSessions: false } })
    : undefined;
  if (options.assignment) {
    matchOptions.assignments = [{ ...options.assignment, role: 'surface', owner: OWNER, ...(commander ? { commander: { id: commander.id } } : {}) }];
  }
  if (options.readySeconds !== undefined) matchOptions.readySeconds = options.readySeconds;
  const match = host.createMatch(matchOptions);
  const registry = new MatchRegistry();
  const live: LiveMatch = {
    match, mode: 'agents', createdAt: Date.now(), ownerKey: `profile:${OWNER}`,
    ...(options.featured ? { featured: true } : {}),
    ...(options.preparing ? { preparing: true } : {}),
    ...(options.idleExempt ? { idleExempt: true } : {}),
    ...(options.observerDelayMs === undefined ? {} : { observerDelayMs: options.observerDelayMs }),
    ...(options.maxLifeMs === undefined ? {} : { maxLifeMs: options.maxLifeMs }),
  };
  const released = vi.fn();
  let draining = false;
  const Room = createAgentCommandRoom({
    host, registry, config: { ...loadConfig({}), abandonGraceMs: GRACE, endGraceMs: 500, maxMatchMs: 60_000 },
    maxMessageBytes: 64 * 1024, tickRate: 20,
    isDraining: () => draining, onReleased: released,
  });
  const room = new Room();
  room.roomId = `abandon-${++nextId}`;
  const dispose = () => {
    room.onDispose();
    room.clock.clear();
    room.clock.stop();
  };
  const disconnect = vi.spyOn(room, 'disconnect').mockImplementation(async () => { dispose(); });
  room.onCreate({ ticket: registry.ticket(live) });
  cleanups.push(() => {
    room.clock.clear();
    room.clock.stop();
    if (host.matches().includes(match)) room.onDispose();
    host.dispose();
  });

  const join = (token: string) => {
    const client = {
      sessionId: `client-${++nextId}`, state: ClientState.JOINED,
      enqueueRaw: vi.fn(), raw: vi.fn(), send: vi.fn(), leave: vi.fn(),
    } as unknown as Client;
    expect(room.onAuth(client, { token })).not.toBe(false);
    room.clients.push(client);
    room.onJoin(client, { token });
    return client;
  };
  const leave = (client: Client) => {
    room.clients.splice(room.clients.indexOf(client), 1);
    room.onLeave(client);
  };
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    room.clock.tick();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { host, match, registry, live, room, released, disconnect, dispose, join, leave, advance, commander,
    setDraining(value: boolean) { draining = value; } };
}

describe('participant-aware room abandonment', () => {
  it('defaults to sixty seconds and validates the configurable grace', () => {
    expect(loadConfig({}).abandonGraceMs).toBe(60_000);
    expect(loadConfig({ ABANDON_GRACE_SECONDS: '7' }).abandonGraceMs).toBe(7000);
    for (const value of ['0', '-1', '1.5', 'NaN', '86401']) {
      expect(() => loadConfig({ ABANDON_GRACE_SECONDS: value })).toThrow('ABANDON_GRACE_SECONDS');
    }
  });

  it('releases never-joined bots-only rooms with a draw and history', async () => {
    const f = await fixture();
    const ended = vi.fn();
    f.match.onEnd(ended);
    expect(f.registry.get(f.room.roomId)).toBe(f.live);
    expect(f.live.abandonIfUnattended).toEqual(expect.any(Function));
    await f.advance(GRACE - 1);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(1);
    expect(ended).toHaveBeenCalledExactlyOnceWith({ nw: 'draw', se: 'draw' }, { nw: 1, se: 1 });
    expect(f.match.report('nw')).toMatchObject({ outcome: 'draw' });
    expect(f.host.matches()).not.toContain(f.match);
    expect(f.host.matches()).toEqual([]);
    expect(f.registry.size).toBe(0);
    expect(f.host.authenticate(f.match.tokens.teams.nw!)).toBeUndefined();
    expect(f.host.history.get(f.match.id)).toMatchObject({
      outcomes: { nw: 'draw', se: 'draw' }, endedAt: expect.any(Number), releasedAt: expect.any(Number),
    });
    expect(f.released).toHaveBeenCalledExactlyOnceWith(f.room.roomId, GRACE);
  });

  it.each(['nw', 'se'] as const)('protects a connected %s team owner and resets grace on reconnect', async (team) => {
    const f = await fixture();
    const token = f.match.tokens.teams[team]!;
    const owner = f.join(token);
    await f.advance(3 * GRACE);
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    f.leave(owner);
    await f.advance(GRACE / 2);
    const reconnected = f.join(token);
    await f.advance(3 * GRACE);
    expect(f.disconnect).not.toHaveBeenCalled();
    f.leave(reconnected);
    await f.advance(GRACE - 1);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(GRACE + 1);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it.each(['nw', 'se'] as const)('protects a public %s human principal without a private owner token', async (team) => {
    const f = await fixture({ assignment: { team, kind: 'human' } });
    const human = f.join(f.match.mintHumanToken(team, 'surface').token);
    expect(f.room.playerThree?.principal(human)).toMatchObject({ kind: 'human', team });
    await f.advance(3 * GRACE);
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    expect(f.host.matches()).toContain(f.match);
    f.leave(human);
    await f.advance(GRACE);
    expect(f.host.matches()).not.toContain(f.match);
    expect(f.host.authenticate(f.match.tokens.teams[team]!)).toBeUndefined();
  });

  it('does not start grace while a participant on the other team remains', async () => {
    const f = await fixture();
    const blue = f.join(f.match.tokens.teams.nw!);
    const red = f.join(f.match.tokens.teams.se!);
    f.leave(blue);
    await f.advance(3 * GRACE);
    expect(f.disconnect).not.toHaveBeenCalled();
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    f.leave(red);
    await f.advance(GRACE);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it('protects authorized seat sockets even when they have not issued an agent call', async () => {
    const f = await fixture();
    f.join(f.match.mintSeatToken('se', 'orbit'));
    expect(f.match.seats().some((seat) => seat.agentActive)).toBe(false);
    await f.advance(3 * GRACE);
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    expect(f.disconnect).not.toHaveBeenCalled();
  });

  it.each(['connected', 'leaving'] as const)('does not renew the clock for a %s spectator', async (presence) => {
    const f = await fixture();
    await f.advance(GRACE - 1);
    const spectator = f.join(f.match.tokens.spectator);
    if (presence === 'leaving') f.leave(spectator);
    await f.advance(1);
    expect(f.host.matches()).not.toContain(f.match);
    expect(f.released).toHaveBeenCalledExactlyOnceWith(f.room.roomId, GRACE);
  });

  it('ignores spectator churn during the last player\'s reconnect grace', async () => {
    const f = await fixture();
    const owner = f.join(f.match.tokens.teams.nw!);
    await f.advance(3 * GRACE);
    f.leave(owner);
    await f.advance(GRACE - 1);
    const spectator = f.join(f.match.tokens.spectator);
    f.leave(spectator);
    await f.advance(1);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it('does not count a revoked lease even if its transport still appears connected', async () => {
    const f = await fixture({ assignment: { team: 'nw', kind: 'human' } });
    const token = f.match.mintHumanToken('nw', 'surface').token;
    const human = f.join(token);
    f.match.revokeToken(token);
    expect(f.room.clients).toContain(human);
    expect(f.room.playerThree?.principal(human)).toBeUndefined();
    expect(await f.live.abandonIfUnattended!()).toBe(true);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it.each(['seat', 'commander'] as const)('protects a live SDK %s agent with no game sockets, then grants departure grace', async (kind) => {
    const f = await fixture(kind === 'commander' ? { assignment: { team: 'se', kind: 'agent' } } : {});
    const token = kind === 'commander' ? f.host.commanders.token(OWNER, f.commander!.id) : f.match.mintSeatToken('se', 'surface');
    const session = f.host.agentSession(token, 'surface')!;
    await session.control.briefing();
    expect(f.room.clients).toHaveLength(0);
    expect(f.match.seats().some((seat) => seat.agentActive)).toBe(true);
    await f.advance(3 * GRACE);
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    expect(f.host.matches()).toContain(f.match);
    // PlayerThree's own agentActive lease determines departure, including its recent-call liveness window.
    await f.advance(30_000);
    expect(f.match.seats().some((seat) => seat.agentActive)).toBe(false);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(GRACE - 1);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(GRACE + 1);
    expect(f.host.matches()).not.toContain(f.match);
    if (f.commander) expect(f.host.commanders.roster(OWNER).find((entry) => entry.id === f.commander!.id)?.seated).toBeNull();
  });

  it('reclaims immediately despite spectators and a pending ready check, awaiting disposal', async () => {
    const f = await fixture({ assignment: { team: 'nw', kind: 'agent' }, readySeconds: 10 });
    f.join(f.match.tokens.spectator);
    expect(f.match.readyCheck()?.pending).toBe(true);
    expect(await f.live.abandonIfUnattended!()).toBe(true);
    expect(f.host.matches()).not.toContain(f.match);
    expect(f.registry.get(f.room.roomId)).toBeUndefined();
    expect(f.released).toHaveBeenCalledOnce();
    expect(f.host.history.get(f.match.id)?.outcomes).toEqual({ nw: 'draw', se: 'draw' });
  });

  it('still declares a draw when reclaiming during an already-pending hard-cap disconnect', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.disconnect.mockImplementation(async () => { await gate.promise; f.dispose(); });
    const closing = f.room.closeRoom();
    await f.advance(0);
    expect(f.match.over).toBe(false);
    const reclaiming = f.live.abandonIfUnattended!();
    expect(f.match.outcome('nw')).toBe('draw');
    expect(f.disconnect).toHaveBeenCalledOnce();
    gate.resolve();
    await closing;
    expect(await reclaiming).toBe(true);
    expect(f.host.history.get(f.match.id)?.outcomes).toEqual({ nw: 'draw', se: 'draw' });
  });

  it('coalesces repeated reclamation, expiry and end-grace callbacks while disconnect is pending', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.disconnect.mockImplementation(async () => { await gate.promise; f.dispose(); });
    const end = vi.spyOn(f.match, 'end');
    const first = f.live.abandonIfUnattended!();
    const second = f.live.abandonIfUnattended!();
    await f.advance(1000);
    expect(end).toHaveBeenCalledExactlyOnceWith('draw');
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.released).not.toHaveBeenCalled();
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(f.released).toHaveBeenCalledOnce();
  });

  it.each(['agent', 'human'] as const)('allows the full %s ready deadline without retaining an abandoned gate forever', async (kind) => {
    const f = await fixture({ assignment: { team: 'nw', kind }, readySeconds: 0.4 });
    await f.advance(GRACE);
    expect(f.match.readyCheck()?.pending).toBe(true);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(299);
    expect(f.match.readyCheck()?.pending).toBe(true);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(101);
    expect(f.host.matches()).not.toContain(f.match);
    expect(f.match.outcome('nw')).toBe('draw');
  });

  it('never abandons featured rooms, even through explicit reclaim', async () => {
    const f = await fixture({ featured: true });
    await f.advance(10 * GRACE);
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    expect(f.disconnect).not.toHaveBeenCalled();
  });

  it('never abandons headless army/series rooms, even through explicit reclaim', async () => {
    const f = await fixture({ idleExempt: true });
    await f.advance(10 * GRACE);
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    expect(f.match.over).toBe(false);
    expect(f.disconnect).not.toHaveBeenCalled();
  });

  it('abandons an unattended delayed-observer room, closing once the final delayed frame is released', async () => {
    const f = await fixture({ observerDelayMs: 300 });
    const owner = f.join(f.match.tokens.teams.nw!);
    await f.advance(3 * GRACE);
    expect(f.match.over).toBe(false);
    f.leave(owner);
    // Observers are not participants: they neither protect the game nor reset its grace.
    f.join(f.match.tokens.spectator);
    await f.advance(GRACE);
    expect({ nw: f.match.outcome('nw'), se: f.match.outcome('se') }).toEqual({ nw: 'draw', se: 'draw' });
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(299);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(1);
    expect(f.host.matches()).not.toContain(f.match);
    expect(f.host.history.get(f.match.id)?.outcomes).toEqual({ nw: 'draw', se: 'draw' });
  });

  it('reclaims a delayed-observer room immediately on explicit request without cutting the delayed tail', async () => {
    const f = await fixture({ observerDelayMs: 300 });
    expect(await f.live.abandonIfUnattended!()).toBe(true);
    expect(f.match.over).toBe(true);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(300);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it('holds a finished delayed-observer room through end grace plus the observer delay', async () => {
    const f = await fixture({ observerDelayMs: 300 });
    f.match.end('draw');
    await f.advance(500);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(300);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it('ends at the per-match lifetime bound as a draw, then keeps the report through end grace', async () => {
    const f = await fixture({ idleExempt: true, maxLifeMs: 1000 });
    await f.advance(999);
    expect(f.match.over).toBe(false);
    await f.advance(1);
    expect({ nw: f.match.outcome('nw'), se: f.match.outcome('se') }).toEqual({ nw: 'draw', se: 'draw' });
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(500);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it('begins departure grace if preparation ends before the first attendance sample', async () => {
    const f = await fixture({ preparing: true });
    await f.advance(GRACE / 2);
    f.live.preparing = false;
    await f.advance(GRACE / 2);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(GRACE - 1);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(GRACE + 1);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it('exempts public pregame preparation and begins a fresh grace when the lobby starts', async () => {
    const f = await fixture({ preparing: true });
    await f.advance(10 * GRACE);
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    f.live.preparing = false;
    await f.advance(GRACE);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(GRACE);
    expect(f.host.matches()).not.toContain(f.match);
  });

  it('preserves deployment drains rather than automatically ending unattended matches', async () => {
    const f = await fixture();
    f.setDraining(true);
    await f.advance(10 * GRACE);
    expect(await f.live.abandonIfUnattended!()).toBe(false);
    expect(f.match.over).toBe(false);
    expect(f.disconnect).not.toHaveBeenCalled();
  });

  it('preserves a completed match\'s outcome and normal report-reading end grace', async () => {
    const f = await fixture();
    f.match.end({ nw: 'win', se: 'loss' });
    await f.advance(GRACE);
    expect(f.disconnect).not.toHaveBeenCalled();
    await f.advance(400);
    expect(f.host.matches()).not.toContain(f.match);
    expect(f.host.history.get(f.match.id)?.outcomes).toEqual({ nw: 'win', se: 'loss' });
  });
});
