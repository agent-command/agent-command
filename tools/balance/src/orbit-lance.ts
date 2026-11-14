#!/usr/bin/env node
/** Cheap paired fleet probe: node tools/balance/src/orbit-lance.ts [seconds=60].
 * Identical standard bot combat paths; only one fleet may submit Sun lance (each army in turn).
 * Production/research/civilian orders are excluded to isolate the ability's fleet impact.
 * Reports attempts/accepted casts and surviving hull+shield per army; no balance verdict is implied.
 */
import { createGame } from '../../../packages/game/src/agent/adapter.ts';
import { createBot } from '../../../packages/game/src/bots/bots.ts';
import { TICK_RATE } from '../../../packages/game/src/rules/contract.ts';
import type { Ent } from '../../../packages/game/src/sim/ent.ts';

const seconds = Number(process.argv[2] ?? 60);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('seconds must be positive');
const rows = [];
const armyIds = createGame({ seed: 47 }).sim.armyIds;
for (const enabled of armyIds) {
  const g = createGame({ seed: 47, options: { orbit: { maxAsteroids: 0 } } });
  const armies = g.sim.armyIds;
  for (const e of g.sim.ents) if (e.kind !== 'spire') e.hp = 0;
  g.step();
  const angle = g.observe({ team: armies[0]!, role: 'orbit' }, 0).sun.angle;
  const centre = g.sim.size / 2;
  // Fleets on spokes through the centre, one per army at equal quarter-turn steps (exact: swaps and negations); a duel
  // keeps the sun-line pair with the first army on the far side of the centre.
  const fleets: Ent[][] = armies.map((_, index) => {
    let dx = Math.cos(angle), dy = Math.sin(angle);
    for (let turn = 0; turn < 2 + (index * 4) / armies.length; turn++) [dx, dy] = [-dy, dx];
    g.sim.armies[index]!.energy = 2000;
    return Array.from({ length: 4 }, (_, i) => g.sim.add('lancer', index, 'orbit', centre + (4 + i * 0.9) * dx, centre + (4 + i * 0.9) * dy));
  });
  const bots = armies.map((army) => createBot(army, 'orbit', 'standard'));
  for (const [index, army] of armies.entries()) bots[index]!.init?.(g.matchData({ team: army, role: 'orbit' }));
  const alive = (fleet: Ent[]): boolean => fleet.some((e) => e.hp > 0);
  let attempted = 0, accepted = 0;
  for (let tick = 0; tick < seconds * TICK_RATE && fleets.filter(alive).length > 1; tick++) {
    if (tick % (TICK_RATE / 2) === 0) for (const [index, army] of armies.entries()) {
      const seat = { team: army, role: 'orbit' as const };
      const obs = g.observe(seat, g.tick);
      // Disable at decision time as well, so the control fleets retain their normal combat orders.
      if (army !== enabled) for (const e of obs.entities) if (e.side === army) e.abilityReady = obs.tick + 1;
      for (const intent of bots[index]!.think(obs)) {
        if (intent.kind !== 'attack' && intent.kind !== 'move' && intent.kind !== 'sun_lance') continue;
        if (intent.kind === 'sun_lance') {
          if (army !== enabled) continue;
          attempted++;
        }
        const result = g.apply(seat, intent, { source: 'bot' });
        if (intent.kind === 'sun_lance' && result.ok) accepted++;
      }
    }
    g.step();
  }
  const health = Object.fromEntries(armies.map((army, index) => [army, fleets[index]!.reduce((sum, e) => sum + (e.hp > 0 ? e.hp + e.shield : 0), 0)]));
  rows.push({ enabled, seconds: g.tick / TICK_RATE, attempted, accepted, health });
}
console.log(JSON.stringify(rows, null, 2));
