import { Client, type Room } from '@colyseus/sdk';
import { LOBBY_MOVED_CLOSE, type LobbySnapshot, type LobbySummary, type SlotOccupant } from '@agent-command/game/lobby';
import type { ArmyId, Colour, Plane, MatchOptions } from '@agent-command/game/contract';
import { colyseusEndpoint, CallError } from './net.ts';
import type { LobbyAdmission } from './profile.ts';

export type LobbyCommand =
  | { op: 'assign'; team: string; roles: Plane[]; occupant: SlotOccupant }
  | { op: 'configure'; mapId?: string; layoutId?: string; mapSeed?: number; size?: number; visibility?: 'public' | 'private'; featured?: boolean; rules?: MatchOptions; rulesPreset?: string; autoStart?: boolean; observerPolicy?: { minDelayMs: number }; colours?: Partial<Record<ArmyId, Colour>> }
  | { op: 'ready'; ready: boolean } | { op: 'start' } | { op: 'observe' }
  | { op: 'kick'; memberId: string } | { op: 'leave' };
type Result = { seq: number; ok: true } | { seq: number; ok: false; code: string };

/** A socket closed because its server went away mid-connection (a crashed cluster node), not by the server's choice. */
const ABNORMAL_CLOSURE = 1006;

/** Admission is obtained over authenticated HTTP; only the ephemeral admission enters the join body. */
export class LobbySocket {
  private seq = 1;
  private closed = false;
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: number }>();
  private readonly room: Room;

  /**
   * `left(rejoin)`: the socket closed without the client asking. `rejoin` when the lobby lives on elsewhere (its
   * server handed it to another, or the connection broke): a fresh admission should get it back at once.
   */
  private constructor(room: Room, left: (rejoin: boolean) => void) {
    this.room = room;
    room.reconnection.enabled = false;
    room.onMessage('lobby:result', (result: Result) => {
      const pending = this.pending.get(result.seq);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(result.seq);
      if (result.ok) pending.resolve();
      else pending.reject(new CallError(result.code));
    });
    room.onLeave((code) => {
      const intentional = this.closed;
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new CallError('disconnected'));
      }
      this.pending.clear();
      if (!intentional) left(code === LOBBY_MOVED_CLOSE || code === ABNORMAL_CLOSURE);
    });
  }

  static async directory(admission: LobbyAdmission, list: (lobbies: LobbySummary[]) => void, left: (rejoin: boolean) => void): Promise<LobbySocket> {
    const room = await new Client(colyseusEndpoint()).joinById(admission.roomId, { token: admission.token });
    const socket = new LobbySocket(room, left);
    room.onMessage('lobby:list', (message: { lobbies: LobbySummary[] }) => list(message.lobbies));
    return socket;
  }

  static async pregame(admission: LobbyAdmission, snapshot: (value: LobbySnapshot) => void, left: (rejoin: boolean) => void): Promise<LobbySocket> {
    const room = await new Client(colyseusEndpoint()).joinById(admission.roomId, { token: admission.token });
    const socket = new LobbySocket(room, left);
    room.onMessage('lobby:snapshot', snapshot);
    return socket;
  }

  command(command: LobbyCommand, revision: number): Promise<void> {
    if (this.closed) return Promise.reject(new CallError('disconnected'));
    const seq = this.seq++;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = window.setTimeout(() => {
      this.pending.delete(seq);
      reject(new CallError('timeout'));
    }, 10_000);
    this.pending.set(seq, { resolve, reject, timer });
    this.room.send('lobby:command', { ...command, revision, seq });
    return promise;
  }

  leave(): void {
    this.closed = true;
    void this.room.leave(true);
  }
}
