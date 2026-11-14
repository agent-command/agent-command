import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { observationSchema, toTicks, viewSchema, type ArmyId } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';

const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const step = (g: AgentCommandGame, n: number): void => { for (let i = 0; i < n; i++) g.step(); };
function arena(): AgentCommandGame {
  const g = createGame({ seed: 19, options: { research: { ascentThrustersTime: 0.1 }, ascent: { climb: 2, duration: 20, cooldown: 45 } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  step(g, 2);
  for (const army of g.sim.allArmies) { g.sim.armies[army]!.alloy = 10000; g.sim.armies[army]!.energy = 10000; }
  return g;
}
function research(g: AgentCommandGame, team: ArmyId): void {
  expect(g.apply({ team, role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' }).ok).toBe(true);
  step(g, toTicks(0.1) + 1);
}
function interceptor(g: AgentCommandGame, team: ArmyId, x = 24, y = 24): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), 'interceptor', 'sky');
  e.x = x; e.y = y; e.stance = 'hold';
  return e;
}

describe('Ascent Thrusters', () => {
  for (const team of (['nw', 'se'] as const)) it(`${team}: research gates ascent, charges energy, telegraphs, climbs, falls at current position and cools down`, () => {
    const g = arena();
    const e = interceptor(g, team);
    const intent = { kind: 'ascend', units: [id(g, team, e)] } as const;
    const ascend = () => g.apply({ team, role: 'sky' }, { ...intent, units: [...intent.units] });
    expect(ascend().ok).toBe(false);
    research(g, team);
    g.sim.armies[slotOfArmyId(team, 2)]!.energy = g.sim.econ.ascentEnergy - 1;
    expect(ascend()).toMatchObject({ ok: false, code: 'cannot_afford' });
    expect(e.transitUntil).toBe(0);
    g.sim.armies[slotOfArmyId(team, 2)]!.energy = 100;
    const start = g.tick;
    expect(ascend().ok).toBe(true);
    expect(g.sim.armies[slotOfArmyId(team, 2)]!.energy).toBe(100 - g.sim.econ.ascentEnergy);
    expect(e.transitAt).toBe(start + toTicks(2));
    expect(e.transitUntil).toBe(start + toTicks(22));
    expect(e.transitReady).toBe(start + toTicks(45));
    expect(g.view(team).entities.find((v) => v.id === id(g, team, e))?.transit).toEqual({ to: 'orbit', at: e.transitAt, until: e.transitUntil });
    step(g, toTicks(2) - 1);
    expect(e.plane).toBe('sky');
    g.step();
    expect(e.plane).toBe('orbit');
    expect(e.transitAt).toBe(0);
    expect(g.view(team).entities.find((v) => v.id === id(g, team, e))?.transit?.return).toBe('sky');
    expect(g.sim.canHit(e, 'orbit')).toBe(true);
    expect(g.sim.canHit(e, 'sky')).toBe(false);
    expect(g.sim.canHit(e, 'surface')).toBe(false);
    expect(g.apply({ team, role: 'sky' }, { kind: 'move', units: [id(g, team, e)], x: 26, y: 26, mode: 'move' }).ok).toBe(true);
    step(g, toTicks(20) - 1);
    const x = e.x, y = e.y;
    g.step();
    expect(e.plane).toBe('sky');
    expect(e.x).toBeCloseTo(x, 4); expect(e.y).toBeCloseTo(y, 4);
    expect(e.transitUntil).toBe(0);
    expect(ascend()).toMatchObject({ ok: false, code: 'cooldown' });
    step(g, e.transitReady - g.tick);
    expect(ascend().ok).toBe(true);
    expect(validate(viewSchema, g.view(team)).ok).toBe(true);
    expect(validate(observationSchema, g.observe({ team, role: 'sky' }, 0)).ok).toBe(true);
  });

  it('shows contrails only to observers of either endpoint and reveals the research only when seen', () => {
    const g = arena();
    research(g, 'nw');
    const e = interceptor(g, 'nw', 20, 20);
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'ascend', units: [id(g, 'nw', e)] }).ok).toBe(true);
    // Unseen by Red: it has no name for the interceptor at all.
    expect(g.sim.aliasOf(g.sim.armyIndex('se'), e.id)).toBe(0);
    expect(g.observe({ team: 'se', role: 'orbit' }, 0).research.seen.flatMap((row) => row.upgrades)).not.toContain('ascent_thrusters');
    const scout = g.sim.spawnUnit(slotOfArmyId('se', 2), 'solar', 'orbit'); scout.x = 20; scout.y = 20;
    step(g, 4);
    expect(g.view('se').entities.find((v) => v.id === id(g, 'se', e))?.transit?.at).toBe(e.transitAt);
    expect(g.observe({ team: 'se', role: 'orbit' }, 0).research.seen).toEqual([{ army: 'nw', upgrades: ['ascent_thrusters'] }]);
    expect(g.view('se').entities.find((v) => v.id === id(g, 'se', e))?.transitReady).toBeUndefined();
  });

  for (const team of (['nw', 'se'] as const)) it(`${team}: raiders hit Orbit combat, logistics and structures and are exposed to Lancers`, () => {
    const g = arena(), enemy = team === 'nw' ? 'se' : 'nw';
    research(g, team);
    const e = interceptor(g, team);
    e.hp = e.maxHp = 10000;
    expect(g.apply({ team, role: 'sky' }, { kind: 'ascend', units: [id(g, team, e)] }).ok).toBe(true);
    step(g, g.sim.econ.ascentClimb);
    for (const kind of ['lancer', 'tug', 'solar'] as const) {
      const target = g.sim.spawnUnit(slotOfArmyId(enemy, 2), kind, 'orbit');
      target.x = e.x + 2; target.y = e.y; target.stance = 'hold';
      step(g, 2);
      expect(g.apply({ team, role: 'sky' }, { kind: 'attack', units: [id(g, team, e)], target: id(g, team, target) }).ok).toBe(true);
      step(g, toTicks(2));
      expect(target.hp + target.shield).toBeLessThan(target.maxHp + target.maxShield);
      if (kind === 'lancer') expect(e.hp + e.shield).toBeLessThan(e.maxHp + e.maxShield);
      target.hp = 0;
      g.step();
    }
    const target = g.sim.armies[slotOfArmyId(enemy, 2)]!.spire.orbit;
    e.x = target.x + (team === 'nw' ? -3 : 3); e.y = target.y;
    step(g, 2);
    expect(g.apply({ team, role: 'sky' }, { kind: 'attack', units: [id(g, team, e)], target: id(g, team, target) }).ok).toBe(true);
    step(g, toTicks(2));
    expect(target.hp).toBeLessThan(target.maxHp);
  });

  it('rejects a group atomically if any interceptor lacks energy or is cooling down', () => {
    const g = arena(); research(g, 'nw');
    const a = interceptor(g, 'nw', 20, 20), b = interceptor(g, 'nw', 21, 20);
    g.sim.armies[0]!.energy = g.sim.econ.ascentEnergy;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'ascend', units: [id(g, 'nw', a), id(g, 'nw', b)] }).ok).toBe(false);
    expect(a.transitAt).toBe(0); expect(b.transitAt).toBe(0);
    g.sim.armies[0]!.energy = 1000; b.transitReady = g.tick + 1;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'ascend', units: [id(g, 'nw', a), id(g, 'nw', b)] }).ok).toBe(false);
    expect(a.transitAt).toBe(0);
  });

  it('keeps climbing and Orbit raiders out of Sky macros and island capture', () => {
    const g = arena(); research(g, 'nw');
    const e = interceptor(g, 'nw');
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'ascend', units: [id(g, 'nw', e)] }).ok).toBe(true);
    const island = g.sim.ents.find((v) => v.kind === 'island')!;
    for (const ticks of [0, g.sim.econ.ascentClimb]) {
      step(g, ticks);
      expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'move', units: [id(g, 'nw', e)], x: 25, y: 25 }).ok).toBe(true);
      for (const action of ['intercept', 'recapture', 'attack_nearest'] as const) {
        expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'macro', action }).ok).toBe(true);
        expect(e.order.k).toBe('move');
      }
      expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'capture', units: [id(g, 'nw', e)], island: id(g, 'nw', island) }).ok).toBe(false);
    }
  });

  it('does not passively capture an island while climbing', () => {
    const g = arena(); research(g, 'nw');
    const island = g.sim.ents.find((v) => v.kind === 'island')!;
    const e = interceptor(g, 'nw', island.x, island.y);
    island.capSide = slotOfArmyId('nw', 2); island.capT = g.sim.econ.captureTicks - 1;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'ascend', units: [id(g, 'nw', e)] }).ok).toBe(true);
    g.step();
    expect(island.side).toBe(NEUTRAL);
    expect(island.capT).toBe(0);
  });

  it('clones active raid membership without sharing units and preserves the forced fall', () => {
    const g = arena(); research(g, 'nw');
    const e = interceptor(g, 'nw');
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'ascend', units: [id(g, 'nw', e)] }).ok).toBe(true);
    const copy = g.clone();
    expect(copy.sim.alive(e.id)).not.toBe(e);
    for (let n = 0; n < toTicks(23); n++) {
      g.step(); copy.step();
      expect(copy.stateHash()).toBe(g.stateHash());
    }
    expect(copy.sim.alive(e.id)?.plane).toBe('sky');
    expect(copy.sim.alive(e.id)?.transitUntil).toBe(0);
  });

  it('remains point-symmetric and deterministic throughout simultaneous mirrored raids', () => {
    const run = (): string[] => {
      const g = arena();
      for (const team of (['nw', 'se'] as const)) expect(g.apply({ team, role: 'sky' }, { kind: 'research', upgrade: 'ascent_thrusters' }).ok).toBe(true);
      step(g, 4);
      const blue = interceptor(g, 'nw', 18, 18), red = interceptor(g, 'se', 30, 30);
      for (const e of [blue, red]) { const team = g.sim.armyIds[e.side]!; expect(g.apply({ team, role: 'sky' }, { kind: 'ascend', units: [id(g, team, e)] }).ok).toBe(true); }
      const hashes: string[] = [];
      for (let i = 0; i < toTicks(46); i++) {
        g.step();
        expect(blue.plane).toBe(red.plane);
        expect(blue.x + red.x).toBeCloseTo(g.sim.size, 8);
        expect(blue.y + red.y).toBeCloseTo(g.sim.size, 8);
        expect(blue.hp).toBe(red.hp);
        expect(blue.transitAt).toBe(red.transitAt);
        expect(blue.transitUntil).toBe(red.transitUntil);
        if (i % 20 === 0) hashes.push(g.stateHash());
      }
      return hashes;
    };
    expect(run()).toEqual(run());
  });
});

describe('Lancers', () => {
  for (const team of (['nw', 'se'] as const)) it(`${team}: attacks Orbit units and segment, never Surface or Sky`, () => {
    const g = arena(), enemy = team === 'nw' ? 'se' : 'nw';
    const e = g.sim.spawnUnit(slotOfArmyId(team, 2), 'lancer', 'orbit');
    const segment = g.sim.armies[slotOfArmyId(enemy, 2)]!.spire.orbit;
    e.x = segment.x + (team === 'nw' ? -3 : 3); e.y = segment.y; e.stance = 'hold';
    expect(g.sim.canHit(e, 'orbit')).toBe(true);
    expect(g.sim.canHit(e, 'sky')).toBe(false);
    expect(g.sim.canHit(e, 'surface')).toBe(false);
    const hp = segment.hp;
    step(g, toTicks(4));
    expect(segment.hp).toBeLessThan(hp);
    const solar = g.sim.spawnUnit(slotOfArmyId(enemy, 2), 'solar', 'orbit'); solar.x = e.x; solar.y = e.y + 2;
    step(g, 2);
    expect(g.apply({ team, role: 'orbit' }, { kind: 'attack', units: [id(g, team, e)], target: id(g, team, solar) }).ok).toBe(true);
    step(g, toTicks(4));
    expect(solar.hp).toBeLessThan(solar.maxHp);
  });
});
