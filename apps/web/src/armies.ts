/** Client names and lookups for a match's armies (DESIGN §15.1): an army is its corner, drawn in its colour. */
import type { ArmyId, Colour, MatchData } from '@agent-command/game/contract';

export const COLOUR_LABEL: Readonly<Record<Colour, string>> = { blue: 'Blue', red: 'Red', green: 'Green', violet: 'Violet' };
export const CORNER_LABEL: Readonly<Record<ArmyId, string>> = { nw: 'Northwest', ne: 'Northeast', se: 'Southeast', sw: 'Southwest' };

type Armies = Pick<MatchData, 'armies'>;

/** The match's entry for army `id` (every army a view or report names is one of the match's). */
export function matchArmy(match: Armies, id: ArmyId): MatchData['armies'][number] {
  const army = match.armies.find((a) => a.id === id);
  if (!army) throw new Error(`Army ${id} is not in this match`);
  return army;
}

/** How an army is named on screen: its colour (unique per army in free-for-all). */
export const armyLabel = (match: Armies, id: ArmyId): string => COLOUR_LABEL[matchArmy(match, id).colour];

/** 1 → "1st", 2 → "2nd" … (ranks run 1..MAX_ARMIES). */
export const placeLabel = (rank: number): string => `${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'}`;
