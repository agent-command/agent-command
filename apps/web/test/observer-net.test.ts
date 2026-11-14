import { afterEach, expect, it, vi } from 'vitest';
import type { ObserverGrant, ObserverMessage } from 'playerthree/protocol';
import { MSG } from 'playerthree/protocol';
const transport = vi.hoisted(() => ({ send: vi.fn(), leave: vi.fn(), handlers: new Map<string, (message: ObserverMessage) => void>(), join: vi.fn(), left: undefined as ((code?: number) => void) | undefined }));
vi.mock('@colyseus/sdk', () => ({ Client: class { joinById = transport.join; } }));
vi.mock('../src/net.ts', () => ({ colyseusEndpoint: () => 'ws://arena.invalid' }));
import { ObserverConnection, SeriesObserverConnection } from '../src/observer-net.ts';
import { MATCH_CLOSE } from '@agent-command/game/lobby';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); transport.handlers.clear(); });

function prepare() {
  transport.join.mockResolvedValue({ send: transport.send, leave: transport.leave, onMessage: (name: string, callback: (message: ObserverMessage) => void) => transport.handlers.set(name, callback), onLeave: (callback: (code?: number) => void) => { transport.left = callback; } });
}

it('joins only an observer capability and sends only perspective requests', async () => {
  prepare(); const receive = vi.fn(); const disconnected = vi.fn();
  const grant: ObserverGrant = { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 180000 };
  const conn = await ObserverConnection.join('room', 'observer-secret', grant, receive, disconnected);
  expect(transport.join).toHaveBeenCalledWith('room', { token: 'observer-secret' });
  expect([...transport.handlers.keys()]).toEqual([MSG.observer]);
  expect(transport.send).toHaveBeenCalledWith(MSG.observer, { perspective: 'all' });
  conn.perspective('se');
  expect(transport.send).toHaveBeenLastCalledWith(MSG.observer, { perspective: 'se' });
  for (const method of ['act', 'tell', 'mint', 'setController', 'deploy', 'setMandate']) expect(method in conn).toBe(false);
  expect(() => conn.perspective('other')).toThrow();
  transport.handlers.get(MSG.observer)!({ op: 'observer', state: 'buffering', grant });
  expect(receive).toHaveBeenCalledWith({ op: 'observer', state: 'buffering', grant });
  conn.close(); transport.left!(); expect(disconnected).not.toHaveBeenCalled();
  conn.perspective('nw'); expect(transport.send).toHaveBeenCalledTimes(2);
});

it('names the reason when the server takes the match away, and none for a plain drop', async () => {
  prepare(); const disconnected = vi.fn();
  await ObserverConnection.join('room', 'token', { kind: 'team', team: 'nw', delayMs: 0 }, vi.fn(), disconnected);
  transport.left!(MATCH_CLOSE.restart);
  expect(disconnected).toHaveBeenLastCalledWith('restart');
  transport.left!(1006);
  expect(disconnected).toHaveBeenLastCalledWith(undefined);
});

it('cannot upgrade a fixed team observer to All or another side', async () => {
  prepare(); const conn = await ObserverConnection.join('room', 'token', { kind: 'team', team: 'nw', delayMs: 0 }, vi.fn(), vi.fn());
  expect(() => conn.perspective('all')).toThrow(); expect(() => conn.perspective('se')).toThrow();
  expect(transport.send).toHaveBeenCalledOnce(); conn.close();
});

it('watches a real series match through authorized SSE without a fabricated room or control connection', async () => {
  const grant: ObserverGrant = { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 180000 };
  const request = vi.fn().mockImplementation(async () => new Response(`data: ${JSON.stringify({ op: 'observer', state: 'buffering', grant })}\n\ndata: ${JSON.stringify({ op: 'observer', state: 'ready', grant, frame: { sequence: 1, tick: 20, recordedAt: 0, releaseAt: 180000, perspective: 'all', world: {}, outcomes: { nw: 'win', se: 'loss' } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', request);
  const receive = vi.fn(); const disconnected = vi.fn();
  const access = { kind: 'owner' as const, seriesId: 'series', credential: () => 'private' };
  const conn = await SeriesObserverConnection.join(access, 'real-host-match', grant, receive, disconnected);
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[0]![0]).toBe('/api/arena/series/series/matches/real-host-match/observer/events?perspective=all');
  expect(request.mock.calls[0]![1].headers.authorization).toBe('Bearer private');
  expect(transport.join).not.toHaveBeenCalled();
  for (const method of ['act', 'tell', 'mint', 'deploy', 'setController']) expect(method in conn).toBe(false);
  conn.perspective('se');
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]![0]).toContain('perspective=se');
  expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(() => conn.perspective('other')).toThrow();
  conn.close(); expect(request.mock.calls[1]![1].signal.aborted).toBe(true);
  expect(disconnected).not.toHaveBeenCalled();
});
