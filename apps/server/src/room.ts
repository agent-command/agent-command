/** A server-allocated exact-seat match room. Public clients may join, never create rooms. */
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Room, type Client } from '@colyseus/core';
import { bindPlayerThreeRoom, type PlayerThreeRoomBinding } from '@playerthree/colyseus';
import { PlayerThreeError, type PlayerThreeHost, type PlayerThreeMatch } from 'playerthree';
import { PLANES, type manifest } from '@agent-command/game';
import { MATCH_CLOSE, type MatchCloseReason } from '@agent-command/game/lobby';
import type { ServerConfig } from './config.ts';
import { addLoad, matchLoad } from './admission.ts';

export const ROOM_NAME = 'agent_command';

/** Dev/featured match setups (lobby matches are `pvp`); `ffa`: you on the first army, bots on the others. */
export type MatchMode = 'bots' | 'pvp' | 'agents' | 'ffa';

export type GameHost = PlayerThreeHost<typeof manifest>;
export type GameMatch = PlayerThreeMatch<typeof manifest>;

export interface LiveMatch {
  match: GameMatch;
  mode: MatchMode;
  createdAt: number;
  /** Featured rooms have SSE viewers rather than game clients and are never abandoned. */
  featured?: boolean;
  /** Headless armies/series remain alive without game-room clients, within the match lifetime bound; never abandoned. */
  idleExempt?: boolean;
  /** After the match ends (normally or abandoned), keep the room until the final delayed observer frame is released. */
  observerDelayMs?: number;
  /** Series deadlines are runner-owned; this watchdog includes their release/cleanup grace. */
  maxLifeMs?: number;
  /** Lobby pregame gate while the allocation is held; cleared when the lobby starts its match. */
  preparing?: boolean;
  /** Play owner identity installed by the parent at lobby handoff, never a client-supplied match option. */
  ownerKey?: string;
  /** Reclaim an unattended room immediately, awaiting its normal disposal/history path. */
  abandonIfUnattended?: () => Promise<boolean>;
  /**
   * The server takes the match away (restart, update, closed): close with that reason's `MATCH_CLOSE` code.
   * An undecided match remains interrupted/unknown in history; closing a process is not a game draw.
   */
  closeWithoutResult?: (reason: MatchCloseReason) => Promise<void>;
  /**
   * Set for matches the room steps itself (non-realtime: SIM_SPEED > 1 or dev-admin on): game ticks per room tick,
   * 0 = paused. Undefined: the match drives itself in real time. The dev-admin API changes it per match.
   */
  speed?: number;
}

/** Shared between the HTTP layer and the room class. */
export class MatchRegistry {
  readonly #pending = new Map<string, LiveMatch>();
  readonly #rooms = new Map<string, LiveMatch>();

  /** Reserve a creation ticket for a match. */
  ticket(live: LiveMatch): string {
    const ticket = randomBytes(18).toString('base64url');
    this.#pending.set(ticket, live);
    return ticket;
  }

  /** One-time: the room claims its match. */
  claim(ticket: unknown): LiveMatch | undefined {
    if (typeof ticket !== 'string') return undefined;
    const live = this.#pending.get(ticket);
    this.#pending.delete(ticket);
    return live;
  }

  drop(ticket: string): void {
    this.#pending.delete(ticket);
  }

  opened(roomId: string, live: LiveMatch): void {
    this.#rooms.set(roomId, live);
  }

  closed(roomId: string): void {
    this.#rooms.delete(roomId);
  }

  get(roomId: string): LiveMatch | undefined {
    return this.#rooms.get(roomId);
  }

  /** Live rooms: [roomId, match]. */
  rooms(): IterableIterator<[string, LiveMatch]> {
    return this.#rooms.entries();
  }

  /** Room id of a live match. */
  roomOf(matchId: string): string | undefined {
    for (const [roomId, live] of this.#rooms) if (live.match.id === matchId) return roomId;
    return undefined;
  }

  /** Live rooms plus matches still being created. */
  get size(): number {
    return this.#rooms.size + this.#pending.size;
  }

  /** Capacity units (admission.ts `matchLoad`) of the live rooms and pending creations. */
  get load(): number {
    let load = 0;
    for (const live of this.#pending.values()) load = addLoad(load, matchLoad(live.match.teams.length));
    for (const live of this.#rooms.values()) load = addLoad(load, matchLoad(live.match.teams.length));
    return load;
  }
}

export interface RoomContext {
  config: ServerConfig;
  registry: MatchRegistry;
  /** Inbound message cap (also the WebSocket maxPayload). */
  maxMessageBytes: number;
  tickRate: number;
  host: GameHost;
  isDraining?(): boolean;
  onReleased?(roomId: string, durationMs: number): void;
  /** Scheduled delay, completed tick wall time, and the tick's starting game-clock index. */
  recordTick?(lagMs: number, durationMs: number, matchTick: number): void;
}


export function createAgentCommandRoom(ctx: RoomContext) {
  const { config, registry } = ctx;

  return class AgentCommandRoom extends Room {
    playerThree: PlayerThreeRoomBinding | undefined;
    match: GameMatch | undefined;
    unattendedSince: number | undefined;
    disconnecting: Promise<void> | undefined;
    stepping = false;
    tickTimer: NodeJS.Timeout | undefined;

    onCreate(options: { ticket?: unknown }) {
      const live = registry.claim(options?.ticket);
      if (!live) throw new Error('rooms require a server allocation ticket');
      const match = live.match;
      this.match = match;
      this.unattendedSince = live.preparing ? undefined : Date.now();
      this.autoDispose = false;
      // Observers have their own cap: they only receive the shared, once-encoded frame stream.
      this.maxClients = config.maxClientsPerRoom + config.maxObserversPerRoom;
      this.maxMessagesPerSecond = 40;
      // The binding coalesces views and applies per-client backpressure for realtime and room-stepped matches alike.
      // The room disposes the match itself (onDispose), preserving an undecided shutdown as interrupted.
      this.playerThree = bindPlayerThreeRoom(this, { host: ctx.host, match, maxMessageBytes: ctx.maxMessageBytes, disposeMatch: false });
      // The client asks only after installing its listener: an onJoin-only message can be dropped by the SDK.
      this.onMessage('ac:authority', (client) => this.sendAuthority(client));
      // Do not echo unknown message names or payloads into framework diagnostics.
      this.onMessage('*', (client) => client.error(400, 'invalid_message'));
      registry.opened(this.roomId, live);
      // Featured showcases and headless armies/series are bounded by their lifetime, not attendance.
      const exempt = live.featured || live.idleExempt;
      live.abandonIfUnattended = async () => {
        if (exempt || live.preparing || ctx.isDraining?.() || this.hasParticipants()) return false;
        const observerDelayMs = live.observerDelayMs ?? 0;
        if (observerDelayMs === 0) {
          await this.closeRoom(true);
          return true;
        }
        // Nobody remains to read the report, but delayed observers still receive the final frames before the close.
        if (!match.over) match.end('draw');
        this.clock.setTimeout(() => void this.closeRoom(), observerDelayMs);
        return true;
      };

      live.closeWithoutResult = async (reason) => {
        await (this.disconnecting ??= Promise.resolve().then(async () => { await this.disconnect(MATCH_CLOSE[reason]); }));
      };

      match.onEnd(() => {
        this.clock.setTimeout(() => void this.closeRoom(), config.endGraceMs + (live.observerDelayMs ?? 0));
      });
      this.clock.setTimeout(() => {
        if (!ctx.isDraining?.() && !match.over) match.end('draw');
      }, live.maxLifeMs ?? config.maxMatchMs);
      this.clock.setInterval(() => {
        if (exempt || live.preparing || ctx.isDraining?.() || match.over || this.disconnecting) {
          this.unattendedSince = undefined;
          return;
        }
        const now = Date.now();
        if (this.hasParticipants()) {
          this.unattendedSince = undefined;
          return;
        }
        this.unattendedSince ??= now;
        if (now - this.unattendedSince < config.abandonGraceMs) return;
        // An absent preferred agent gets its full ready-check window, but a stale pending human gate is finite.
        const ready = match.readyCheck();
        if (ready?.pending && now < ready.deadline) return;
        void live.abandonIfUnattended?.();
      }, Math.min(5000, config.abandonGraceMs));

      // The native timer is independent of Colyseus's patch-driven room clock, preserving the manifest's cadence.
      // `speed` is game ticks per wall tick (1 = realtime; 0 = paused), with no overlapping or catch-up steps.
      if (live.speed !== undefined) {
        const period = 1000 / ctx.tickRate;
        let scheduled = performance.now() + period;
        this.tickTimer = setInterval(() => {
          const started = performance.now();
          const lag = Math.max(0, started - scheduled);
          // No catch-up bursts: missed wall-clock ticks slow the game, not its deterministic tick sequence.
          scheduled = started + period;
          // A ready check holds the match at tick 0 (realtime matches are held by PlayerThree itself).
          const speed = live.speed ?? 0;
          if (speed === 0 || this.stepping || match.readyCheck()?.pending || match.paused()) return;
          this.stepping = true;
          const before = match.tick;
          Promise.resolve()
            .then(() => match.step(speed))
            .catch((error: unknown) => {
              // A pause can begin at any tick boundary of a multi-tick step; it is not a failed match.
              if (!(error instanceof PlayerThreeError && error.code === 'paused')) void this.closeRoom();
            })
            .finally(() => {
              if (match.tick !== before) ctx.recordTick?.(lag, performance.now() - started, before);
              this.stepping = false;
            });
        }, 1000 / ctx.tickRate);
      }
    }

    /** The binding reauthorizes leases here; a revoked or spectator socket is not a participant. */
    hasParticipants(except?: Client): boolean {
      for (const client of this.clients) {
        if (client === except) continue;
        const principal = this.playerThree?.principal(client);
        if (principal && principal.kind !== 'spectator') return true;
      }
      return this.match?.seats().some((seat) => seat.agentActive) ?? false;
    }

    /** End grace, abandonment and the hard cap share one in-flight framework disconnect. */
    closeRoom(abandoned = false): Promise<void> {
      if (abandoned && this.match && !this.match.over) this.match.end('draw');
      // A match that decided nothing (a failed step) closes with `closed`: its players see no result, not a rejoin.
      const code = this.match?.over ? undefined : MATCH_CLOSE.closed;
      return this.disconnecting ??= Promise.resolve().then(async () => {
        await this.disconnect(code);
      });
    }

    onAuth(client: Client, options: unknown) {
      // Classify without claiming the single-use token, so a full room never burns an admission.
      const token = typeof options === 'object' && options !== null && 'token' in options ? options.token : undefined;
      const kind = typeof token === 'string' ? ctx.host.authenticate(token)?.principal.kind : undefined;
      let observers = 0;
      for (const joined of this.clients) if (this.playerThree?.principal(joined)?.kind === 'observer') observers++;
      if (kind === 'observer' ? observers >= config.maxObserversPerRoom : this.clients.length - observers >= config.maxClientsPerRoom) return false;
      return this.playerThree?.onAuth(client, options) ?? false;
    }

    /** Private metadata is always derived from this connection's current authenticated lease, never request fields. */
    sendAuthority(client: Client): void {
      const principal = this.playerThree?.principal(client);
      if (!principal) return;
      client.send('ac:authority', {
        roles: principal.kind === 'team' ? [...PLANES] : principal.kind === 'human' || principal.kind === 'seat' ? [principal.role] : [],
        queuePriority: principal.kind === 'team' || principal.kind === 'human',
      });
    }

    onJoin(client: Client, options: unknown) {
      this.playerThree?.onJoin(client, options);
      const principal = this.playerThree?.principal(client);
      if (principal && principal.kind !== 'spectator') this.unattendedSince = undefined;
    }

    onLeave(client: Client) {
      const principal = this.playerThree?.principal(client);
      this.playerThree?.onLeave(client);
      if (principal && principal.kind !== 'spectator') {
        this.unattendedSince = this.hasParticipants(client) ? undefined : Date.now();
      }
    }

    onDispose() {
      clearInterval(this.tickTimer);
      const live = registry.get(this.roomId);
      registry.closed(this.roomId);
      this.playerThree?.dispose();
      const match = this.match;
      match?.dispose();
      ctx.onReleased?.(this.roomId, live ? Date.now() - live.createdAt : 0);
    }
  };
}
