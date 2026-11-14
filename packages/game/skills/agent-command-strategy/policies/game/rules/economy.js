// Agent Command's built-in bot library: packages/game/src/rules/economy.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").

/** Carry is expressed in alloy in both simulation and views, not in number of ore loads. */
export function diggerCarryMax(rules) {
  return rules.economy.diggerLoads * rules.economy.oreLoad;
}


/**
 * What a seat's direct spend (abilities, work orders, conditional admission) may use: the free bank plus its own
 * lane's normal earmark, never another lane's or the recovery worker's (sim `available` with a lane).
 */
export function seatSpendable(res, queue, plane) {
  let alloy = res.freeAlloy, energy = res.freeEnergy;
  for (const e of queue) {
    if (e.plane !== plane || e.paid || e.recovery) continue;
    alloy += e.heldAlloy;
    energy += e.heldEnergy;
  }
  return { alloy, energy };
}
