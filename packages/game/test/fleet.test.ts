import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { STATS, TRANSITS, TICK_RATE, toTicks, type MatchOptions, type ArmyId, type UnitKind } from '../src/rules/contract.ts';
import { entityOut } from '../src/agent/present.ts';
import type { Ent } from '../src/sim/ent.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

function arena(options: MatchOptions = {}): AgentCommandGame {
  // The derelict ruin at the centre would wall these duels in: fleet mechanics are measured in open space.
  const g = createGame({ seed: 47, options: { ...options, orbit: { maxAsteroids: 0, derelictEnabled: false, ...options.orbit } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire') e.hp = 0;
  g.step();
  return g;
}

function advance(g: AgentCommandGame, ticks: number): void {
  for (let i = 0; i < ticks; i++) g.step();
}

function duel(winner: UnitKind, winnerCount: number, loser: UnitKind, loserCount: number, team: ArmyId): { g: AgentCommandGame; winners: Ent[]; losers: Ent[] } {
  const g = arena();
  const enemy = team === 'nw' ? 'se' : 'nw';
  const mirror = team === 'nw' ? 1 : -1;
  const winners: Ent[] = [];
  const losers: Ent[] = [];
  for (let i = 0; i < winnerCount; i++) winners.push(g.sim.add(winner, slotOfArmyId(team, 2), 'orbit', 24 - mirror * 4, 24 + mirror * (i - (winnerCount - 1) / 2)));
  for (let i = 0; i < loserCount; i++) losers.push(g.sim.add(loser, slotOfArmyId(enemy, 2), 'orbit', 24 + mirror * 4, 24 - mirror * (i - (loserCount - 1) / 2)));
  for (const e of winners) g.sim.order(e, { k: 'move', x: 24 + mirror * 4, y: 24, fight: true, speed: 0 });
  for (const e of losers) g.sim.order(e, { k: 'move', x: 24 - mirror * 4, y: 24, fight: true, speed: 0 });
  advance(g, 2);
  for (let tick = 0; tick < toTicks(45) && winners.some((e) => e.hp > 0) && losers.some((e) => e.hp > 0); tick++) g.step();
  return { g, winners, losers };
}

describe('Orbit fleet', () => {
  it.each([
    ['skiff', 3, 'lancer', 1],
    ['bastion', 1, 'skiff', 3],
    ['lancer', 1, 'bastion', 1],
  ] as const)('%s beats its counter in affordable mirrored micro-fights', (winner, winnerCount, loser, loserCount) => {
    const blue = duel(winner, winnerCount, loser, loserCount, 'nw');
    const red = duel(winner, winnerCount, loser, loserCount, 'se');
    for (const fight of [blue, red]) {
      expect(fight.losers.every((e) => e.hp <= 0)).toBe(true);
      expect(fight.winners.some((e) => e.hp > 0)).toBe(true);
    }
    expect(blue.g.tick).toBe(red.g.tick);
    expect(blue.winners.map((e) => e.hp)).toEqual(red.winners.map((e) => e.hp));
    expect(blue.winners.map((e) => e.shield)).toEqual(red.winners.map((e) => e.shield));
    expect(duel(winner, winnerCount, loser, loserCount, 'nw').g.stateHash()).toBe(blue.g.stateHash());
  });

  it('compiles host shield capacities, recharge rates and delays from seconds', () => {
    const g = arena({ stats: { skiff: { shield: 40, shieldRegen: 20, shieldDelay: 0.5 } } });
    const ship = g.sim.add('skiff', BLUE, 'orbit', 24, 24);
    expect(ship.maxShield).toBe(40);
    expect(g.sim.stats.skiff.shieldDelay).toBe(toTicks(0.5));
    g.sim.damage(ship, 30, RED);
    advance(g, toTicks(0.5) - 1);
    expect(ship.shield).toBe(10);
    g.step();
    expect(ship.shield).toBe(11);
  });

  it('absorbs damage before hull, spills through depleted shields, and respects the recharge deadline', () => {
    const g = arena();
    const ship = g.sim.add('lancer', BLUE, 'orbit', 24, 24);
    g.sim.damage(ship, 20, RED);
    expect(ship.hp).toBe(ship.maxHp);
    expect(ship.shield).toBe(STATS.lancer.shield! - 20);
    advance(g, STATS.lancer.shieldDelay! - 1);
    expect(ship.shield).toBe(STATS.lancer.shield! - 20);
    g.step();
    expect(ship.shield).toBeCloseTo(STATS.lancer.shield! - 20 + STATS.lancer.shieldRegen! / TICK_RATE);
    g.sim.damage(ship, ship.shield + 17, RED);
    expect(ship.shield).toBe(0);
    expect(ship.hp).toBe(ship.maxHp - 17);
  });

  it('reserves incoming damage against shield plus hull rather than abandoning a shielded low-hull target', () => {
    const g = arena();
    const target = g.sim.add('lancer', RED, 'orbit', 25, 24);
    target.hp = 1;
    target.cd = toTicks(10);
    target.stance = 'hold';
    for (const y of [23.5, 24.5]) {
      const ship = g.sim.add('lancer', BLUE, 'orbit', 23, y);
      ship.heading = Math.atan2(24 - y, 2); // a fixed mount fires along its hull
      g.sim.order(ship, { k: 'attack', target: target.id });
    }
    advance(g, 2);
    g.step();
    expect(target.hp).toBe(1);
    expect(target.shield).toBe(STATS.lancer.shield! - 2 * STATS.lancer.dmg);
  });

  it('sustained outgoing fire also delays shield recharge', () => {
    const g = arena();
    const ship = g.sim.add('lancer', BLUE, 'orbit', 24, 24);
    const target = g.sim.add('tug', RED, 'orbit', 25, 24);
    target.hp = target.maxHp = 100000;
    ship.shield = 0;
    ship.combatAt = g.tick;
    g.sim.order(ship, { k: 'attack', target: target.id });
    advance(g, 2);
    advance(g, toTicks(8));
    expect(ship.shield).toBe(0);
    expect(target.hp).toBeLessThan(target.maxHp);
  });

  it('repairs hull and shields only at an own live Orbit segment within the docking radius', () => {
    const g = arena();
    const home = g.sim.armies[BLUE]!.spire.orbit;
    const enemy = g.sim.armies[RED]!.spire.orbit;
    const docked = g.sim.add('bastion', BLUE, 'orbit', home.x + 2, home.y);
    const outside = g.sim.add('bastion', BLUE, 'orbit', home.x + g.sim.econ.dockRadius + 1, home.y);
    const wrongDock = g.sim.add('bastion', BLUE, 'orbit', enemy.x - 2, enemy.y);
    for (const ship of [docked, outside, wrongDock]) {
      ship.hp -= 40;
      ship.shield = 0;
      ship.combatAt = g.tick;
      ship.stance = 'hold';
    }
    enemy.cd = toTicks(10);
    enemy.stationPdCd = toTicks(10);
    g.step();
    expect(docked.hp).toBeCloseTo(docked.maxHp - 40 + g.sim.econ.orbitDockHull / TICK_RATE);
    expect(docked.shield).toBeCloseTo(g.sim.econ.orbitDockShield / TICK_RATE);
    expect(outside.hp).toBe(outside.maxHp - 40);
    expect(outside.shield).toBe(0);
    expect(wrongDock.shield).toBe(0);
    home.hp = 0;
    const before = docked.hp;
    g.step();
    expect(docked.hp).toBe(before);
  });

  it('ascended interceptors gain small Orbit shields and lose them on return to Sky', () => {
    const g = arena();
    const ship = g.sim.add('interceptor', BLUE, 'sky', 24, 24);
    expect(entityOut(g.sim, ship, 'nw').shield).toBeUndefined();
    g.sim.startTransit(ship, TRANSITS.ascend);
    advance(g, g.sim.econ.ascentClimb);
    expect(ship.plane).toBe('orbit');
    expect(ship.shield).toBe(STATS.interceptor.shield);
    g.sim.damage(ship, 10, RED);
    expect(ship.hp).toBe(ship.maxHp);
    expect(entityOut(g.sim, ship, 'nw').shield).toBe(STATS.interceptor.shield! - 10);
    advance(g, g.sim.econ.ascentDuration);
    expect(ship.plane).toBe('sky');
    expect(ship.shield).toBe(0);
    expect(entityOut(g.sim, ship, 'nw').shield).toBeUndefined();
  });

  it('Bastion point defence intercepts incoming payloads without firing on neutral salvage or ordinary Sky aircraft', () => {
    const g = arena();
    const ship = g.sim.add('bastion', BLUE, 'orbit', 24, 24);
    const rock = g.sim.add('asteroid', RED, 'sky', 25, 24);
    rock.state = 'falling';
    rock.hp = rock.maxHp = 60;
    rock.fx = rock.ix = rock.x;
    rock.fy = rock.iy = rock.y;
    rock.impactTick = g.tick + toTicks(8);
    const neutral = g.sim.add('asteroid', NEUTRAL, 'orbit', 24, 25);
    neutral.state = 'drifting';
    neutral.hp = neutral.maxHp = 60;
    const aircraft = g.sim.add('interceptor', RED, 'sky', 24, 25);
    aircraft.stance = 'hold';
    let traced = false;
    for (let tick = 0; tick < toTicks(2); tick++) {
      g.step();
      if (g.sim.fx.some(({ fx }) => fx.w === 'point_defence' && fx.src === ship.id)) traced = true;
    }
    expect(rock.hp).toBeLessThanOrEqual(0);
    expect(neutral.hp).toBe(60);
    expect(aircraft.hp).toBe(aircraft.maxHp);
    expect(traced).toBe(true);
  });

  it('keeps the segment beam and independent point-defence battery', () => {
    const g = arena();
    const home = g.sim.armies[BLUE]!.spire.orbit;
    const target = g.sim.add('skiff', RED, 'orbit', home.x + 2, home.y);
    target.stance = 'hold';
    advance(g, 2);
    g.step();
    const shots = g.sim.fx.filter(({ fx }) => fx.src === home.id);
    expect(shots.some(({ fx }) => fx.w === 'beam')).toBe(true);
    expect(shots.some(({ fx }) => fx.w === 'point_defence')).toBe(true);
  });

  it.each(['shield', 'maxShield', 'combatAt', 'stationPdCd'] as const)('hashes %s and preserves it across clones', (field) => {
    const g = arena();
    const ship = g.sim.add('lancer', BLUE, 'orbit', 24, 24);
    const twin = g.clone();
    const original = g.stateHash();
    expect(twin.stateHash()).toBe(original);
    ship[field]++;
    expect(g.stateHash()).not.toBe(original);
    expect(twin.stateHash()).toBe(original);
  });
});
