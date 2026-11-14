import type { IntentAck, SeatInfo } from 'playerthree';
import type { ObserverGrant } from 'playerthree/arena';
import type { ArmyId, Plane, Report, View } from '@agent-command/game/contract';
import type { MatchCloseReason, PublicLobbyCard } from '@agent-command/game/lobby';

export type MatchMode = 'bots' | 'pvp' | 'agents';

export interface MatchTicket {
  roomId: string;
  token: string;
  invite?: string;
  spectator?: string;
  /** Private per-seat admissions; never rendered or placed in shared links. */
  tickets?: { role?: Plane; token: string; expiresAt: number; queuePriority?: boolean }[];
  quickPlay?: boolean;
  readOnly?: boolean;
  /** Observer capability must be routed exclusively to the read-only observer transport. */
  observer?: true;
  grant?: ObserverGrant;
  /** Nonsecret locator of the lobby that admitted us: seat renewal, recovery and leave go through it. */
  lobbyCode?: string;
  /**
   * This tab's admission to that lobby: the profile secret, or the visitor capability of an anonymous Quick Play
   * (which has no stored profile). Never rendered or placed in links.
   */
  lobbyAuth?: LobbyAuth;
  /** Lobby seat tickets: a commander can take one of my seats mid-match (false: a worker-hosted match refuses agents). */
  agentHandOver?: boolean;
}

/** A lobby member's HTTP credential (`Authorization: Bearer` or `Visitor`). */
export interface LobbyAuth { secret?: string; visitorToken?: string }


/** Canonical private match capability fragment; lobby invitations use credential-free `#l=`. */
export function parseFragment(hash: string): { roomId: string; token: string } | undefined {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const roomId = p.get('r');
  const token = p.get('t');
  if (!roomId || !token) return undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId) || !/^[A-Za-z0-9_-]{32}$/.test(token)) return undefined;
  return { roomId, token };
}

export function fragmentFor(roomId: string, token: string): string {
  return `r=${encodeURIComponent(roomId)}&t=${encodeURIComponent(token)}`;
}

export function colyseusEndpoint(): string {
  const override = import.meta.env.VITE_COLYSEUS_URL as string | undefined;
  if (override) return override;
  // Dev: Vite proxies `/colyseus` (HTTP + WS) to the game server with the prefix stripped.
  return import.meta.env.DEV ? `${location.origin}/colyseus` : location.origin;
}


/**
 * Why a match connection ended without a result: the server took the match away (`MatchCloseReason`; a rejoin that
 * finds the lobby or room gone counts as `restart`), or the connection could not be restored (`lost`).
 */
export type MatchLeft = MatchCloseReason | 'lost';

export interface ConnectionEvents {
  view(view: View): void;
  seats(seats: SeatInfo[]): void;
  /** A real outcome from the match itself: the only source of a win, loss or draw on screen. */
  report(army: ArmyId, report: Report): void;
  left(reason: MatchLeft): void;
  /** One of our agents replied (agent-authored text: render as plain text). */
  said?(said: { role: string; tick: number; text: string }): void;
  recovering?(active: boolean): void;
  /** Authenticated role capabilities changed; refresh controls even while the simulation is paused. */
  authorityChanged?(): void;
  cards?(cards: PublicLobbyCard[]): void;
}

export class CallError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}


/** Human-readable text for closed error codes (our own text; never server-provided strings). */
export function ackText(ack: IntentAck): string {
  if (ack.ok) return 'ok';
  switch (ack.code) {
    case 'game':
      return ack.gameCode;
    case 'invalid':
      return `invalid (${ack.schemaCode})`;
    case 'signal':
      return ack.signalCode;
    default:
      return ack.code;
  }
}
