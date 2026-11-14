// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { LobbySocket } from '../src/lobby-net.ts';
import { LOBBY_MOVED_CLOSE } from '@agent-command/game/lobby';

const transport = vi.hoisted(() => ({ join: vi.fn() }));
vi.mock('@colyseus/sdk', () => ({ Client: class { joinById = transport.join; } }));

const admission = { roomId: 'pregame-room', token: 'one-use-admission', expiresAt: 100000 };
let messages: Map<string, (value: unknown) => void>;
let send: Mock;
let leave: Mock;
let left: (code?: number) => void;
let reconnection: { enabled: boolean };

beforeEach(() => {
  vi.useFakeTimers();
  messages = new Map();
  send = vi.fn();
  leave = vi.fn(async () => left());
  reconnection = { enabled: true };
  transport.join.mockResolvedValue({
    reconnection,
    onMessage: (type: string, callback: (value: unknown) => void) => { messages.set(type, callback); },
    onLeave: (callback: (code?: number) => void) => { left = callback; }, send, leave,
  });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('private lobby admission transport', () => {
  it('sends only the ephemeral socket token in the join body and listens to live directory lists', async () => {
    const update = vi.fn();
    const socket = await LobbySocket.directory(admission, update, vi.fn());
    expect(transport.join).toHaveBeenCalledWith('pregame-room', { token: admission.token });
    expect(reconnection.enabled).toBe(false);
    messages.get('lobby:list')!({ lobbies: [{ code: 'ROOM1234' }] });
    expect(update).toHaveBeenCalledWith([{ code: 'ROOM1234' }]);
    socket.leave();
    expect(leave).toHaveBeenCalledWith(true);
  });

  it('forwards snapshots and matches sequenced command results', async () => {
    const snapshot = vi.fn();
    const socket = await LobbySocket.pregame(admission, snapshot, vi.fn());
    messages.get('lobby:snapshot')!({ code: 'ROOM1234', phase: 'waiting' });
    expect(snapshot).toHaveBeenCalledWith({ code: 'ROOM1234', phase: 'waiting' });
    const done = socket.command({ op: 'assign', team: 'nw', roles: ['orbit'], occupant: { kind: 'commander', ref: { id: 'named-policy', kind: 'policy', version: 3 } } }, 8);
    expect(send).toHaveBeenCalledWith('lobby:command', { seq: 1, revision: 8, op: 'assign', team: 'nw', roles: ['orbit'], occupant: { kind: 'commander', ref: { id: 'named-policy', kind: 'policy', version: 3 } } });
    messages.get('lobby:result')!({ seq: 1, ok: true });
    await expect(done).resolves.toBeUndefined();
    socket.leave();
  });

  it('rejects a failed claim with a closed code, not a server response object', async () => {
    const socket = await LobbySocket.pregame(admission, vi.fn(), vi.fn());
    const done = socket.command({ op: 'ready', ready: true }, 3);
    const rejected = expect(done).rejects.toMatchObject({ code: 'not_ready' });
    messages.get('lobby:result')!({ seq: 1, ok: false, code: 'not_ready', private: 'must-not-be-retained' });
    await rejected;
    socket.leave();
  });

  it('fails pending commands immediately on disconnect and exposes recovery', async () => {
    const disconnected = vi.fn();
    const socket = await LobbySocket.pregame(admission, vi.fn(), disconnected);
    const pending = socket.command({ op: 'start' }, 5);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    left();
    await rejected;
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('does not treat an intentional leave as a recoverable failure', async () => {
    const disconnected = vi.fn();
    const socket = await LobbySocket.pregame(admission, vi.fn(), disconnected);
    socket.leave();
    expect(disconnected).not.toHaveBeenCalled();
    await expect(socket.command({ op: 'start' }, 5)).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('asks for an immediate rejoin only when the lobby moved servers or the connection broke', async () => {
    for (const [code, rejoin] of [[LOBBY_MOVED_CLOSE, true], [1006, true], [4000, false], [4001, false], [1000, false]] as const) {
      const disconnected = vi.fn();
      await LobbySocket.pregame(admission, vi.fn(), disconnected);
      left(code);
      expect(disconnected).toHaveBeenCalledExactlyOnceWith(rejoin);
    }
  });
});
