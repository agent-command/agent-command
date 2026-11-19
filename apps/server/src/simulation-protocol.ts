/** Private structured-clone protocol; never exposed on the public HTTP listener. */
import type { ArmyId, MatchOptions, Outcome, Report, View } from '@agent-command/game';
import type { SeatInfo } from 'playerthree';
import type { ObserverFrame, ObserverGrant } from 'playerthree/protocol';
import type { SeatAssignment, SeatTicket } from 'playerthree/host';
import type { GameMatch } from './room.ts';
import type { LobbyOpenOptions } from './lobby.ts';
import type { LobbyMatchSnapshot } from './lobby-match.ts';
import type { MatchCloseReason } from '@agent-command/game/lobby';
import type { FeaturedPerspective } from './featured.ts';

/** Only exact human/bot/empty assignments can leave the canonical commander host. */
export type SimulationSeatAssignment = Omit<SeatAssignment, 'kind' | 'commander' | 'policy'> & { kind: 'human' | 'bot' | 'none' };
export interface SimulationLobbyRequest extends LobbyOpenOptions {
  /** The secret match seed (secretMatchSeed), chosen by the canonical host and never sent to a client. */
  seed: number;
  assignments: SimulationSeatAssignment[];
  rules: MatchOptions;
  /** Reserved server-owned showcase, never a public creation option. */
  featured?: boolean;
}
export interface SimulationLobbyResponse {
  roomId: string;
  state: LobbyMatchSnapshot;
}
export interface SimulationSnapshot {
  views: View[];
  seats: SeatInfo[];
  reports: { team: ArmyId; data: Report }[];
  ended: boolean;
}
export interface SimulationRoom { roomId: string; tick: number; ended: boolean }
export interface SimulationStats {
  worker: number;
  /** Wall-clock timestamp of this worker's coherent room-counter sample. */
  sampledAt: number;
  rooms: SimulationRoom[];
  tickSamples: number;
  /** Tick lateness across the trailing ten one-second buckets. */
  p95LagMs: number;
  windowSamples: number;
  /** Smoothed worker-thread CPU consumption as a fraction of one core. */
  cpuFraction: number;
  p99LagMs: number;
  maxLagMs: number;
  maxDurationMs: number;
}
export type SimulationCall =
  | { op: 'createLobby'; request: SimulationLobbyRequest }
  | { op: 'start'; roomId: string }
  | { op: 'mintHumanToken'; roomId: string; args: Parameters<GameMatch['mintHumanToken']> }
  | { op: 'renewHumanToken'; roomId: string; args: Parameters<GameMatch['renewHumanToken']> }
  | { op: 'mintObserverToken'; roomId: string; args: Parameters<GameMatch['mintObserverToken']> }
  | { op: 'mintSpectatorToken'; roomId: string; args: Parameters<GameMatch['mintSpectatorToken']> }
  | { op: 'assign'; roomId: string; args: Parameters<GameMatch['assign']> }
  | { op: 'revokeToken'; roomId: string; token: string }
  | { op: 'revokeSeat'; roomId: string; args: Parameters<GameMatch['revokeSeat']> }
  | { op: 'setHumanReady'; roomId: string; args: Parameters<GameMatch['setHumanReady']> }
  | { op: 'end'; roomId: string; args: Parameters<GameMatch['end']> }
  | { op: 'forfeit'; roomId: string; args: Parameters<GameMatch['forfeit']> }
  | { op: 'outcome'; roomId: string; args: Parameters<GameMatch['outcome']> }
  | { op: 'snapshot'; roomId: string }
  /** Relay one perspective's delayed observer frames to the parent (the featured broadcast); never to a public socket. */
  | { op: 'observe'; roomId: string; team: FeaturedPerspective; grant: ObserverGrant }
  | { op: 'unobserve'; roomId: string; team: FeaturedPerspective }
  | { op: 'remove'; roomId: string }
  | { op: 'abandon'; roomId: string }
  | { op: 'drain' }
  /** Stop the worker; its live matches close with `reason` and retain interrupted/unknown outcomes. */
  | { op: 'close'; reason: MatchCloseReason };
export type SimulationResult = SimulationLobbyResponse | SimulationSnapshot | SeatTicket | Pick<SeatTicket, 'expiresAt'> | Record<string, Outcome> | Outcome | undefined;
export type SimulationMessage =
  | { kind: 'ready'; port: number }
  | { kind: 'reply'; id: number; value?: SimulationResult; error?: string }
  | { kind: 'released'; roomId: string; durationMs: number }
  | { kind: 'state'; roomId: string; state: LobbyMatchSnapshot }
  | { kind: 'observer'; roomId: string; team: FeaturedPerspective; frame: ObserverFrame }
  | { kind: 'stats'; stats: SimulationStats; lags: number[]; durations: number[] };
