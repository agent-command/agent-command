/** Shared economy helpers (`@agent-command/game/economy`) for the client, bots and policies. */
import type { Rules } from './match-rules.ts';
import type { Plane } from './vocabulary.ts';

/** Carry is expressed in alloy in both simulation and views, not in number of ore loads. */
export function diggerCarryMax(rules: Pick<Rules, 'economy'>): number {
  return rules.economy.diggerLoads * rules.economy.oreLoad;
}

/** The queue-entry fields that decide a lane's own hold (an observation `queue` entry satisfies it). */
export interface LaneHold {
  plane: Plane;
  paid: boolean;
  recovery: boolean;
  heldAlloy: number;
  heldEnergy: number;
}

/**
 * What a seat's direct spend (abilities, work orders, conditional admission) may use: the free bank plus its own
 * lane's normal earmark, never another lane's or the recovery worker's (sim `available` with a lane).
 */
export function seatSpendable(res: { freeAlloy: number; freeEnergy: number }, queue: readonly LaneHold[], plane: Plane): { alloy: number; energy: number } {
  let alloy = res.freeAlloy, energy = res.freeEnergy;
  for (const e of queue) {
    if (e.plane !== plane || e.paid || e.recovery) continue;
    alloy += e.heldAlloy;
    energy += e.heldEnergy;
  }
  return { alloy, energy };
}
