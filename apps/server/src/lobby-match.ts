/** The lobby's complete allocation capability, implemented by local matches and worker RPC. */
import type { PublicSeatCard, ReadinessSnapshot } from 'playerthree/host';
import type { GameMatch } from './room.ts';

type RemoteMethod<K extends keyof GameMatch> = GameMatch[K] extends (...args: infer A) => infer R
  ? (...args: A) => R | Promise<R>
  : never;

export interface LobbyMatchState {
  readonly over: boolean;
  readiness: GameMatch['readiness'];
  cards: GameMatch['cards'];
  mintHumanToken: RemoteMethod<'mintHumanToken'>;
  /** A fixed-team fogged view for an owner with no human seat left on that army (its seats all reassigned). */
  mintSpectatorToken: RemoteMethod<'mintSpectatorToken'>;
  /** Mid-match seat hand-over (`PlayerThreeMatch.assign`); named commanders need the canonical (main-process) host. */
  assign: RemoteMethod<'assign'>;
  /** Extends a connected seat's credential in place: the periodic renewal without a rejoin. */
  renewHumanToken: RemoteMethod<'renewHumanToken'>;
  mintObserverToken: RemoteMethod<'mintObserverToken'>;
  revokeToken: RemoteMethod<'revokeToken'>;
  revokeSeat: RemoteMethod<'revokeSeat'>;
  setHumanReady: RemoteMethod<'setHumanReady'>;
  end: RemoteMethod<'end'>;
  /** Eliminate one army (it leaves, is kicked or stays absent); the match goes on for the others. */
  forfeit: RemoteMethod<'forfeit'>;
  /** One army's outcome (`running` until it is final): gates an eliminated human's observer ticket. */
  outcome: RemoteMethod<'outcome'>;
}

export interface LobbyMatch {
  match: LobbyMatchState;
  roomId: string;
  /** Present only on canonical-host allocations that support series metrics and artifacts. */
  localMatch?: GameMatch;
  start(): void | Promise<void>;
  close(): Promise<void>;
}

export interface LobbyMatchSnapshot {
  readiness: ReadinessSnapshot;
  cards: PublicSeatCard[];
  over: boolean;
}
