/** Match RPC correlation only; Connection owns admission, room selection and stale-room rejection. */
import type { Room } from '@colyseus/sdk';
import { MSG, type ClientMsg, type ServerMsg } from 'playerthree/protocol';
import { CallError } from './net.ts';

/** Distribute over the SDK union: each operation retains its own required fields. */
export type MatchRequest = { [Op in ClientMsg['op']]: Omit<Extract<ClientMsg, { op: Op }>, 'seq'> }[ClientMsg['op']];
type ResultMessage = Extract<ServerMsg, { op: 'result' }>;
const REQUEST_TIMEOUT_MS = 10_000;

export class MatchRequests {
  /** All seat sockets share one sequence space, which survives room replacement. */
  private seq = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: number }>();

  send(room: Room, body: MatchRequest): Promise<unknown> {
    const seq = this.seq++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = window.setTimeout(() => {
      this.pending.delete(seq);
      reject(new CallError('timeout'));
    }, REQUEST_TIMEOUT_MS);
    this.pending.set(seq, { resolve, reject, timer });
    // Derive the channel from the discriminant; callers cannot pair a valid body with a different RPC channel.
    room.send(MSG[body.op], { ...body, seq });
    return promise;
  }

  receive(message: ResultMessage): void {
    const pending = this.pending.get(message.seq);
    if (!pending) return;
    this.pending.delete(message.seq);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new CallError(message.code));
  }

  disconnect(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CallError('disconnected'));
    }
    this.pending.clear();
  }
}
