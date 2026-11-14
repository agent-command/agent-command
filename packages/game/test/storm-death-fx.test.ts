/**
 * A unit killed inside a storm: its owner's view carries the death record (position and kind) the client plays its
 * death from, while the fog closes over the spot; an enemy whose only eye on the spot is outside the storm never
 * gets it; an enemy inside the same storm, which saw the unit, does. Mirrored for both armies.
 */
import { describe, expect, it } from 'vitest';
import { sampleStorm, type StormSample } from '../src/planes/weather.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const SIDES = [['nw', 'se'], ['se', 'nw']] as const;
/** A natural storm that forms at once and stays: no forecast, growth or calm to wait out, no breakup. */
const SKY = {
  stormSets: 1, fogRadius: 0, stormForecastMin: 0.05, stormForecastMax: 0.05, stormGrow: 0.05, stormCalmMin: 0.05, stormCalmMax: 0.05,
  stormSpeed: 0.1, stormDrift: 0, stormLifetimeMin: 600, stormLifetimeMax: 600, stormMinRadius: 8, stormRadius: 8,
};

function arena(owner: 'nw' | 'se', enemy: 'nw' | 'se', enemyInside: boolean) {
  const g = createGame({ seed: 7, options: { terrain: 'open', sky: SKY } });
  const s = g.sim;
  const own = slotOfArmyId(owner, 2), foe = slotOfArmyId(enemy, 2);
  const victim = s.spawnUnit(own, 'interceptor', 'sky');
  const watcher = s.spawnUnit(foe, 'interceptor', 'sky');
  const storm = {} as StormSample;
  const place = () => {
    sampleStorm(s.weather.data.storms[0]!, s.tick, storm, 0, s.size);
    victim.x = storm.x + 1.5; victim.y = storm.y;
    // inside: the same storm; outside: just past its edge, the victim well inside its vision radius
    watcher.x = enemyInside ? storm.x - 1.5 : storm.x + storm.radius + 1.5; watcher.y = storm.y;
    victim.hp = victim.maxHp; watcher.hp = watcher.maxHp;
  };
  for (let t = 0; t < VISION_EVERY * 3; t++) {
    g.step();
    if (s.weather.data.storms.length) place();
  }
  g.step();
  place();
  for (let t = 0; t < VISION_EVERY; t++) {
    g.step();
    place();
  }
  expect(storm.stage).toBe('mature');
  return { g, s, own, foe, victim, watcher };
}

const deaths = (g: AgentCommandGame, army: 'nw' | 'se') => g.view(army).fx.filter((f) => f.kind === 'death' && f.subject === 'interceptor');

describe.each(SIDES)('a death inside a storm (%s killed, %s watching)', (owner, enemy) => {
  it('reaches its owner with position and kind, never an enemy watching from outside the storm', () => {
    const { g, s, own, foe, victim, watcher } = arena(owner, enemy, false);
    expect(s.stormAt(victim.x, victim.y)).toBe(true);
    expect(s.stormAt(watcher.x, watcher.y)).toBe(false);
    expect(s.sees(own, victim)).toBe(true);
    expect(s.sees(foe, victim)).toBe(false);
    const x = victim.x, y = victim.y;
    s.kill(victim);
    const [death] = deaths(g, owner);
    expect(death).toMatchObject({ plane: 'sky', side: owner });
    expect(Math.abs(death!.x - x) + Math.abs(death!.y - y)).toBeLessThan(0.05);
    expect(deaths(g, enemy)).toEqual([]);
    // The next vision pass has no eye left in the storm: the owner keeps the record (the client plays it while the
    // fog closes), the enemy still has none.
    for (let t = 0; t < VISION_EVERY; t++) g.step();
    expect(s.seesCell(own, 'sky', Math.floor(y) * s.size + Math.floor(x))).toBe(false);
    expect(deaths(g, owner)).toHaveLength(1);
    expect(deaths(g, enemy)).toEqual([]);
  });

  it('reaches an enemy that had sight of the spot from inside the same storm', () => {
    const { g, s, foe, victim } = arena(owner, enemy, true);
    expect(s.sees(foe, victim)).toBe(true);
    s.kill(victim);
    expect(deaths(g, enemy)).toHaveLength(1);
    expect(deaths(g, owner)).toHaveLength(1);
  });
});
