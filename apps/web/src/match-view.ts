import type { MatchData, View } from '@agent-command/game/contract';

/**
 * A view with its match. `names`: whose entity ids it carries. Absent, its army's own (a team view: the server names
 * entities per army, game sim/aliases.ts); 'sim' for an observer's omniscient row and the lenses made over it.
 */
export type MatchView = View & { match: MatchData; names?: 'sim' };

/** The entity id namespace of a view: tracks, follows, selections and control groups never carry across two. */
export function idSpace(view: Pick<MatchView, 'army' | 'names'>): string {
  return view.names ?? view.army;
}

/** Resolve only within one Game's army cache; a changed hash or rewound stream needs a new snapshot. */
export function matchView(view: View, previous?: MatchView): MatchView | undefined {
  if (view.match && view.match.rulesHash !== view.rulesHash) return undefined;
  if (!view.match && previous?.army === view.army && previous.rulesHash === view.rulesHash && view.tick >= previous.tick)
    view.match = previous.match;
  return view.match ? view as MatchView : undefined;
}
