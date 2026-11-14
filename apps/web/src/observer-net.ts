import { Client, type Room } from '@colyseus/sdk';
import { MSG, type ObserverGrant, type ObserverMessage } from 'playerthree/protocol';
import { matchCloseReason, type MatchCloseReason } from '@agent-command/game/lobby';
import { colyseusEndpoint } from './net.ts';
import { openArenaObserverStream, sseEvents, type ArenaAccess } from './arena-net.ts';

export interface ObserverTransport { perspective(perspective: string): void; resync(): void; close(): void }

/** Deliberately has no act, tell, control, mint or deploy methods. Admission is server-authorized. */
export class ObserverConnection {
  private closed = false;
  private current = '';
  private readonly room: Room;
  readonly grant: ObserverGrant;
  private constructor(room: Room, grant: ObserverGrant) { this.room = room; this.grant = grant; }

  /** `disconnected(reason)`: the stream ended; `reason` when the server took the match away (`MATCH_CLOSE`). */
  static async join(roomId: string, token: string, grant: ObserverGrant, receive: (message: ObserverMessage) => void, disconnected: (reason?: MatchCloseReason) => void): Promise<ObserverConnection> {
    const room = await new Client(colyseusEndpoint()).joinById(roomId, { token });
    const connection = new ObserverConnection(room, grant);
    room.onMessage(MSG.observer, (message: ObserverMessage) => { if (!connection.closed) receive(message); });
    room.onLeave((code: number) => { if (!connection.closed) disconnected(matchCloseReason(code)); });
    connection.perspective(grant.kind === 'team' ? grant.team : 'all');
    return connection;
  }

  perspective(perspective: string): void {
    if (this.closed) return;
    if (this.grant.kind === 'team' ? perspective !== this.grant.team : perspective !== 'all' && !this.grant.teams.includes(perspective)) throw new Error('Perspective unavailable.');
    this.current = perspective;
    this.room.send(MSG.observer, { perspective });
  }

  /** A request without a cursor makes the server send that perspective's released keyframe. */
  resync(): void { this.perspective(this.current); }

  close(): void { if (this.closed) return; this.closed = true; void this.room.leave(true); }
}

/** Series matches are real host executions, not Colyseus rooms or owner control connections. */
export class SeriesObserverConnection implements ObserverTransport {
  private readonly access: ArenaAccess;
  private readonly matchId: string;
  private readonly grant: ObserverGrant;
  private readonly receive: (message: ObserverMessage) => void;
  private readonly disconnected: () => void;
  private controller: AbortController | undefined;
  private closed = false;
  private current = '';

  private constructor(access: ArenaAccess, matchId: string, grant: ObserverGrant, receive: (message: ObserverMessage) => void, disconnected: () => void) {
    this.access = access; this.matchId = matchId; this.grant = grant; this.receive = receive; this.disconnected = disconnected;
  }

  static async join(access: ArenaAccess, matchId: string, grant: ObserverGrant, receive: (message: ObserverMessage) => void, disconnected: () => void): Promise<SeriesObserverConnection> {
    const connection = new SeriesObserverConnection(access, matchId, grant, receive, disconnected);
    connection.current = grant.kind === 'team' ? grant.team : 'all';
    await connection.connect(connection.current);
    return connection;
  }

  perspective(perspective: string): void {
    if (this.closed) return;
    if (this.grant.kind === 'team' ? perspective !== this.grant.team : perspective !== 'all' && !this.grant.teams.includes(perspective)) throw new Error('Perspective unavailable.');
    this.current = perspective;
    void this.connect(perspective).catch(() => { if (!this.closed) this.disconnected(); });
  }

  /** A new stream without a cursor starts at the released keyframe. */
  resync(): void { this.perspective(this.current); }

  private async connect(perspective: string): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController(); this.controller = controller;
    let messages: AsyncIterable<ObserverMessage>;
    try { messages = await openArenaObserverStream(this.access, this.matchId, perspective, controller.signal); }
    catch (error) { if (controller.signal.aborted) return; throw error; }
    if (controller.signal.aborted || this.closed) return;
    void (async () => {
      let terminal = false;
      try {
        for await (const message of messages) {
          if (this.closed || controller.signal.aborted) return;
          this.receive(message);
          if (message.state === 'closed' || message.frame?.outcomes && Object.values(message.frame.outcomes).every((outcome) => outcome !== 'running')) terminal = true;
        }
        if (!terminal && !controller.signal.aborted && !this.closed) this.disconnected();
      } catch { if (!controller.signal.aborted && !this.closed) this.disconnected(); }
    })();
  }

  close(): void { if (this.closed) return; this.closed = true; this.controller?.abort(); }
}

/**
 * Watch live's match on air, announced before its first keyframe: its armies (two or four), public seats (bots by
 * level, humans by display name, commanders by public card), the matchup line (`label`, empty when unnamed), whether
 * it serves `all` (`omniscient`) and its release delay. `public`: a running public game, not the bot playlist;
 * `played`: this reader played it, so it gets only its own sides.
 */
export interface FeaturedMatch { roomId: string; public: boolean; delayMs: number; armies: string[]; seats: FeaturedSeat[]; label: string; omniscient: boolean; played?: true }
export interface FeaturedSeat { team: string; role: string; kind: 'bot' | 'human' | 'agent' | 'policy'; level?: string; name?: string }
/** A public game whose delayed stream starts in `liveInMs`; Watch live cuts over to it then. */
export interface FeaturedUpcoming { roomId: string; label: string; liveInMs: number }

/** The relay closed a stream (a server restart, a handover to the next primary): reconnect after this long. */
const FEATURED_RETRY_MS = 2000;

/**
 * The featured broadcast relay: delayed streams over fetch-based SSE (each served perspective's projection), no
 * token and no command channel. A signed-in viewer's profile credential rides along so the relay can apply the
 * player rules to a public game it played. A perspective change reconnects to that stream; a new match on air is
 * announced before its first keyframe; a dropped stream reconnects on its own.
 */
export class FeaturedObserverConnection implements ObserverTransport {
  private controller: AbortController | undefined;
  private readonly receive: (message: ObserverMessage) => void;
  private readonly match: (match: FeaturedMatch) => void;
  private readonly upcoming: (upcoming: FeaturedUpcoming | null) => void;
  private readonly disconnected: () => void;
  private readonly authorization: string | undefined;
  private team = '';
  private closed = false;

  constructor(team: string, receive: (message: ObserverMessage) => void, match: (match: FeaturedMatch) => void, upcoming: (upcoming: FeaturedUpcoming | null) => void, disconnected: () => void, secret?: string) {
    this.receive = receive; this.match = match; this.upcoming = upcoming; this.disconnected = disconnected;
    this.authorization = secret ? `Bearer ${secret}` : undefined;
    this.perspective(team);
  }

  perspective(team: string): void {
    if (this.closed) return;
    this.team = team;
    void this.connect();
  }

  private async connect(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch(`/api/featured/stream?team=${encodeURIComponent(this.team)}`, {
        headers: { accept: 'text/event-stream', ...(this.authorization ? { authorization: this.authorization } : {}) }, signal: controller.signal,
      });
      for await (const { event, data } of sseEvents(response, controller.signal)) {
        if (this.controller !== controller) return;
        if (event === 'observer') this.receive(data as ObserverMessage);
        else if (event === 'match') this.match(data as FeaturedMatch);
        else if (event === 'upcoming') this.upcoming(data as FeaturedUpcoming | null);
      }
    } catch { /* Refused, or dropped: reconnect below unless this stream was replaced or closed. */ }
    if (this.closed || this.controller !== controller || controller.signal.aborted) return;
    this.disconnected();
    window.setTimeout(() => { if (!this.closed && this.controller === controller) void this.connect(); }, FEATURED_RETRY_MS);
  }

  /** The relay resends a keyframe to any new reader. */
  resync(): void { this.perspective(this.team); }

  close(): void { this.closed = true; this.controller?.abort(); }
}
