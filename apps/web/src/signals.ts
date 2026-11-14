/**
 * Team signals in the client (DESIGN §9.2): the team board arrives as `view.signals` (the viewing team's own board,
 * never another team's); the feed, the plane chips and the Request tool derive everything from it. Humans send and
 * answer as the seats they control through the ordinary `act` path.
 */
import { NEED_ANSWERERS, SUPPORT_NEEDS, type MatchData, type Plane, type SupportNeed, type View } from '@agent-command/game/contract';

export type SignalEntry = View['signals'][number];
export type SignalTarget = Plane | 'team';
/** What a human may do with a request now, as the plane they control. */
export interface SignalAction { plane: Plane; update: 'ack' | 'done' }
/** The game's side of signal UI: the human's seats and the answer path. */
export interface SignalHooks {
  /** The human controls this plane of the team (and may answer as it). */
  mine(plane: Plane): boolean;
  /** Jump to the request (on `plane`, else the plane that answers it) and take it there when the human may. */
  open(e: SignalEntry, plane?: Plane): void;
  answer(e: SignalEntry, plane: Plane, update: 'ack' | 'decline' | 'done'): void;
}

/** Signals are on unless the match rules turn them off (the bootstrap snapshot's rules, kept by matchView). */
export const signalsOn = (match: Pick<MatchData, 'rules'> | undefined): boolean => !!match && match.rules.signals.enabled;

/** Planes that may take `e`: its addressee, or for `team` every teammate whose card answers the need (not the sender). */
export function answerers(e: SignalEntry): readonly Plane[] {
  return e.to === 'team' ? NEED_ANSWERERS[e.need].filter((p) => p !== e.from) : [e.to as Plane];
}

/** Where a request lives now: the plane that took it, else the (first) plane asked. */
export const signalPlane = (e: SignalEntry): Plane => e.by ?? answerers(e)[0] ?? e.from;

/** Open requests show on the chips of the planes they wait for: every possible answerer until taken, then the taker. */
export const showsOn = (e: SignalEntry, plane: Plane): boolean =>
  e.state === 'working' ? e.by === plane : e.state === 'submitted' && answerers(e).includes(plane);

/** Who `from` asks for `need`: the one other plane that answers it, the team when several do, none when only `from` does. */
export function requestTarget(from: Plane, need: SupportNeed): SignalTarget | undefined {
  const others = NEED_ANSWERERS[need].filter((p) => p !== from);
  return others.length > 1 ? 'team' : others[0];
}

/** The needs `from` can ask teammates for. */
export const requestNeeds = (from: Plane): SupportNeed[] => SUPPORT_NEEDS.filter((need) => requestTarget(from, need));

/** A request from `from`'s seat; `defend` asks the team to hold `from`'s own segment (its `plane`). */
export function requestIntent(from: Plane, to: SignalTarget, need: SupportNeed, x: number, y: number) {
  return { kind: 'signal', signal: { kind: 'request_support', to, need, x, y, ...(need === 'defend' ? { plane: from } : {}) } };
}

/** The human's one-click answer: take a submitted request on a plane they control, or finish one that plane took. */
export function signalAction(e: SignalEntry, mine: (plane: Plane) => boolean): SignalAction | undefined {
  if (e.state === 'submitted') {
    const plane = answerers(e).find(mine);
    return plane ? { plane, update: 'ack' } : undefined;
  }
  return e.state === 'working' && e.by && mine(e.by) ? { plane: e.by, update: 'done' } : undefined;
}
