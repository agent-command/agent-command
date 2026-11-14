import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { observationSchema, toTicks, type ArmyId, type Observation, type RockResourceType, type RockSize } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';
import { NEUTRAL } from '../src/util/teams.ts';

const seat = { team: 'nw', role: 'orbit' } as const;
const enemy = { team: 'se', role: 'orbit' } as const;
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
/** Whether `team`'s view shows `e`: the team has a name for it and that name is among the view's entities. */
const shown = (g: AgentCommandGame, team: ArmyId, e: Ent): boolean => {
  const entities = g.view(team).entities;
  const alias = g.sim.aliasOf(g.sim.armyIndex(team), e.id);
  return alias !== 0 && entities.some(v => v.id === `e_${alias}`);
};
const cargo = (tug: Ent): number => tug.cargoAlloy + tug.cargoEnergy;
const steps = (g: AgentCommandGame, n: number): void => { for (let i = 0; i < n; i++) g.step(); };
function until(g: AgentCommandGame, done: () => boolean, limit = 500): void {
  for (let i = 0; i < limit && !done(); i++) g.step();
  expect(done(), `condition reached by tick ${g.tick}`).toBe(true);
}
function fixture(resourceType: RockResourceType = 'metal', size: RockSize = 'medium', army: 0 | 1 = 0) {
  const g = createGame({ seed: 31, options: { terrain: 'open', economy: { baseEnergyCap: 0, minimumEnergyCap: 0, spireAlloyRate: 0 }, spire: { dmg: 0 }, orbit: {
    maxAsteroids: 0, derelictEnabled: false, stationPdDamage: 0, dockHull: 0, dockShield: 0,
  } } });
  // Only this tug works: no idle tug or policy may silently create another mining order.
  for (const e of g.sim.ents) if (e.unit) e.dead = true;
  g.step();
  const home = g.sim.armies[army]!.spire.orbit;
  const direction = army === 0 ? 1 : -1;
  const tug = g.sim.add('tug', army, 'orbit', home.x + direction * 6, home.y + direction);
  const rock = g.sim.add('asteroid', NEUTRAL, 'orbit', tug.x + direction * g.sim.econ.tugMineReach, tug.y);
  rock.rockSize = size;
  rock.resourceType = resourceType;
  rock.hp = rock.maxHp = g.sim.rocks[size].hp;
  const yieldValue = g.sim.rocks[size].dockYield[resourceType];
  rock.resourceRemaining = yieldValue.alloy + yieldValue.energy;
  rock.state = 'drifting';
  g.sim.computeVision();
  return { g, tug, rock, home };
}
function mine(g: AgentCommandGame, tug: Ent, rock: Ent): void {
  expect(g.apply(seat, { kind: 'mine_asteroid', units: [id(g, 'nw', tug)], asteroid: id(g, 'nw', rock) })).toEqual({ ok: true });
}
function moveHome(g: AgentCommandGame, tug: Ent): void {
  const home = g.sim.armies[0]!.spire.orbit;
  expect(g.apply(seat, { kind: 'move', units: [id(g, 'nw', tug)], x: home.x, y: home.y })).toEqual({ ok: true });
}

describe('explicit ongoing asteroid mining', () => {
  it.each(['metal', 'ice'] as const)('%s fills a real hold, unloads, resumes the same rock and returns its final load', resourceType => {
    const { g, tug, rock } = fixture(resourceType);
    const value = rock.resourceRemaining;
    const control = g.clone();
    const mined = g.sim.armies[0]!.stats.alloyMined;
    const effects = new Set<string>();
    const stepBoth = (): void => {
      g.step(); control.step();
      for (const effect of g.view('nw').fx) effects.add(effect.kind);
    };
    mine(g, tug, rock);
    for (let i = 0; i < toTicks(25); i++) stepBoth();
    expect(cargo(tug)).toBeCloseTo(50, 7);
    expect(tug.order).toMatchObject({ k: 'mine_asteroid', asteroid: rock.id, returning: true });
    expect(rock.state).toBe('drifting'); expect(rock.link).toBe(0); expect(tug.link).toBe(0);
    expect(rock.resourceRemaining + cargo(tug)).toBeCloseTo(value, 7);
    expect(rock.hp / rock.maxHp).toBeCloseTo(rock.resourceRemaining / value, 7);
    for (let i = 0; i < 300 && cargo(tug) > 0; i++) stepBoth();
    expect(cargo(tug)).toBe(0);
    expect(tug.order).toMatchObject({ k: 'mine_asteroid', asteroid: rock.id, returning: false });
    for (let i = 0; i < 300 && cargo(tug) === 0; i++) stepBoth();
    expect(tug.miningTarget).toBe(rock.id);
    expect(cargo(tug)).toBeGreaterThan(0);
    for (let i = 0; i < 1600 && (!rock.dead || cargo(tug) > 0); i++) stepBoth();
    expect(rock.dead).toBe(true); expect(rock.resourceRemaining).toBe(0); expect(rock.hp).toBe(0);
    expect(cargo(tug)).toBe(0); expect(tug.order.k).toBe('none');
    const actual = g.sim.armies[0]!, baseline = control.sim.armies[0]!;
    expect(actual.alloy - baseline.alloy).toBeCloseTo(resourceType === 'metal' ? value : 0, 5);
    expect(actual.energy - baseline.energy).toBeCloseTo(resourceType === 'ice' ? value : 0, 5);
    expect(actual.stats.alloyMined - mined).toBeCloseTo(resourceType === 'metal' ? value : 0, 5);
    expect(effects.has('mining_depleted')).toBe(true);
    expect(effects.has('mining_unload')).toBe(true);
  });

  it.each(['metal', 'ice'] as const)('%s resumes across a normal fogged cargo trip using observed drift, not hidden entity state', type => {
    const { g, tug, rock, home } = fixture(type);
    tug.x = home.x + 14; tug.y = home.y + 3;
    rock.x = tug.x + g.sim.econ.tugMineReach; rock.y = tug.y;
    rock.vx = g.sim.econ.asteroidDrift / 20; rock.vy = g.sim.econ.asteroidDrift / 40;
    g.sim.computeVision(); mine(g, tug, rock);
    until(g, () => cargo(tug) >= 50 - 1e-8, 700);
    until(g, () => cargo(tug) === 0, 800);
    expect(shown(g, 'nw', rock)).toBe(false);
    expect(tug.order).toMatchObject({ k: 'mine_asteroid', returning: false });
    expect(g.view('nw').entities.find(e => e.id === id(g, 'nw', tug))).toMatchObject({ miningAssigned: true });
    expect(g.view('nw').entities.find(e => e.id === id(g, 'nw', tug))!.miningTarget).toBeUndefined();
    const missing = g.clone(), twin = missing.sim.alive(tug.id)!;
    const hidden = missing.sim.alive(rock.id)!;
    hidden.dead = true; hidden.hp = 0;
    // Neither the route nor assignment may expose the hidden disappearance.
    for (let i = 0; i < 12; i++) {
      g.step(); missing.step();
      expect(missing.view('nw').entities.find(e => e.id === id(missing, 'nw', twin))).toEqual(g.view('nw').entities.find(e => e.id === id(g, 'nw', tug)));
      expect(twin.order).toEqual(tug.order);
    }
    until(g, () => tug.state === 'mining' && cargo(tug) > 0, 1000);
    expect(rock.resourceRemaining + cargo(tug) + 50).toBeCloseTo(type === 'metal' ? 150 : 120, 7);
    expect(Math.hypot(tug.x - rock.x, tug.y - rock.y)).toBeCloseTo(g.sim.econ.tugMineReach, 1);
    until(missing, () => twin.order.k === 'none', 1000);
    expect(cargo(twin)).toBe(0);
  });

  it.each([false, true])('approaches a real stand-off before mining, including a boundary-side start: %s', edge => {
    const { g, tug, rock } = fixture();
    if (edge) { rock.x = 1.5; rock.y = 18; tug.x = 0.6; tug.y = 18; }
    else { tug.x = rock.x; tug.y = rock.y; }
    g.sim.computeVision(); mine(g, tug, rock);
    g.step();
    expect(cargo(tug)).toBe(0);
    until(g, () => cargo(tug) > 0, 400);
    expect(Math.hypot(tug.x - rock.x, tug.y - rock.y)).toBeCloseTo(g.sim.econ.tugMineReach, 2);
    expect(tug.x).toBeGreaterThanOrEqual(tug.radius);
    expect(tug.y).toBeGreaterThanOrEqual(tug.radius);
    expect(g.sim.econ.grappleReach).toBe(1.5);
  });

  it('does nothing without an explicit order and station-keeps natural drift rather than towing', () => {
    const { g, tug, rock } = fixture();
    steps(g, 20);
    expect(cargo(tug)).toBe(0); expect(rock.resourceRemaining).toBe(150);
    rock.vx = 1 / 1024; rock.vy = -1 / 1024;
    const control = g.clone();
    mine(g, tug, rock);
    let offset: [number, number] | undefined;
    for (let i = 0; i < 40; i++) {
      g.step(); control.step();
      const drift = control.sim.alive(rock.id)!;
      expect([rock.x, rock.y, rock.vx, rock.vy]).toEqual([drift.x, drift.y, drift.vx, drift.vy]);
      const current: [number, number] = [tug.x - rock.x, tug.y - rock.y];
      if (offset) expect(current).toEqual(offset);
      else offset = current;
    }
    expect(cargo(tug)).toBeCloseTo(4, 8);
    expect(rock.miningTug).toBe(tug.id); expect(tug.link).toBe(0); expect(rock.link).toBe(0);
  });

  it.each(['release', 'stop', 'move'] as const)('%s detaches a partial hold without discarding it; manual home arrival unloads once', kind => {
    const { g, tug, rock } = fixture();
    mine(g, tug, rock); steps(g, 20);
    const held = cargo(tug), remaining = rock.resourceRemaining;
    const result = kind === 'move'
      ? g.apply(seat, { kind, units: [id(g, 'nw', tug)], x: tug.x + 2, y: tug.y })
      : g.apply(seat, { kind, units: [id(g, 'nw', tug)] });
    expect(result).toEqual({ ok: true });
    expect(tug.miningTarget).toBe(0); expect(rock.miningTug).toBe(0);
    steps(g, 10);
    expect(cargo(tug)).toBe(held); expect(rock.resourceRemaining).toBe(remaining);
    const before = g.sim.armies[0]!.stats.alloyMined;
    moveHome(g, tug); until(g, () => cargo(tug) === 0);
    expect(g.sim.armies[0]!.stats.alloyMined - before).toBeCloseTo(held, 8);
    steps(g, 20);
    expect(g.sim.armies[0]!.stats.alloyMined - before).toBeCloseTo(held, 8);
    expect(rock.resourceRemaining).toBe(remaining);
  });

  it.each(['metal', 'ice'] as const)('%s can switch a partial mining load to whole-rock tow without creating extra yield', type => {
    const { g, tug, rock } = fixture(type);
    const control = g.clone(), value = rock.resourceRemaining;
    mine(g, tug, rock); steps(g, 20);
    const held = cargo(tug);
    expect(g.apply(seat, { kind: 'grapple', units: [id(g, 'nw', tug)], asteroid: id(g, 'nw', rock) })).toEqual({ ok: true });
    until(g, () => tug.link === rock.id);
    expect(rock.miningTug).toBe(0); expect(tug.miningTarget).toBe(0); expect(cargo(tug)).toBe(held);
    moveHome(g, tug); until(g, () => rock.dead && cargo(tug) === 0);
    while (control.tick < g.tick) control.step();
    expect(g.sim.armies[0]!.alloy - control.sim.armies[0]!.alloy).toBeCloseTo(type === 'metal' ? value : 0, 6);
    expect(g.sim.armies[0]!.energy - control.sim.armies[0]!.energy).toBeCloseTo(type === 'ice' ? value : 0, 6);
  });

  it('rock destruction discards only unextracted resources and returns the surviving tug cargo', () => {
    const { g, tug, rock } = fixture();
    mine(g, tug, rock); steps(g, 20);
    const held = cargo(tug), before = g.sim.armies[0]!.stats.alloyMined;
    g.sim.damage(rock, rock.hp, 1);
    until(g, () => cargo(tug) === 0);
    expect(rock.dead).toBe(true); expect(rock.resourceRemaining).toBe(0);
    expect(g.sim.armies[0]!.stats.alloyMined - before).toBeCloseTo(held, 8);
    expect(tug.order.k).toBe('none'); expect(tug.miningTarget).toBe(0);
  });

  it('tug destruction loses its cargo, frees the latch and leaves only the unextracted resource', () => {
    const { g, tug, rock } = fixture();
    mine(g, tug, rock); steps(g, 20);
    const remaining = rock.resourceRemaining, before = g.sim.armies[0]!.stats.alloyMined;
    g.sim.damage(tug, tug.hp, 1); g.step();
    expect(g.sim.alive(tug.id)).toBeUndefined(); expect(rock.miningTug).toBe(0);
    expect(rock.resourceRemaining).toBe(remaining);
    expect(g.sim.armies[0]!.stats.alloyMined).toBe(before);
    const replacement = g.sim.add('tug', 0, 'orbit', rock.x - g.sim.econ.tugMineReach, rock.y);
    g.sim.computeVision(); mine(g, replacement, rock); g.step();
    expect(rock.miningTug).toBe(replacement.id);
    expect(rock.resourceRemaining + cargo(replacement)).toBeCloseTo(remaining, 8);
  });

  it('losing the home Orbit segment cancels mining but retains cargo without paying it out', () => {
    const { g, tug, rock, home } = fixture();
    mine(g, tug, rock); steps(g, 20);
    const held = cargo(tug), remaining = rock.resourceRemaining, before = g.sim.armies[0]!.stats.alloyMined;
    home.hp = 0; g.step();
    expect(tug.order.k).toBe('none'); expect(tug.miningTarget).toBe(0); expect(rock.miningTug).toBe(0);
    expect(cargo(tug)).toBe(held); expect(rock.resourceRemaining).toBe(remaining);
    moveHome(g, tug); steps(g, 200);
    expect(cargo(tug)).toBe(held); expect(g.sim.armies[0]!.stats.alloyMined).toBe(before);
  });

  it.each(['mine_asteroid', 'grapple'] as const)('a simultaneous mining/%s race gives one exclusive latch and no double extraction', kind => {
    const { g, tug, rock } = fixture();
    const second = g.sim.add('tug', 0, 'orbit', tug.x + 1, tug.y);
    g.sim.computeVision(); mine(g, tug, rock);
    expect(g.apply(seat, { kind, units: [id(g, 'nw', second)], asteroid: id(g, 'nw', rock) })).toEqual({ ok: true });
    steps(g, 20);
    expect(rock.miningTug).toBe(tug.id); expect(rock.link).toBe(0); expect(second.link).toBe(0);
    expect(cargo(second)).toBe(0);
    expect(cargo(tug)).toBeCloseTo(2, 8);
    expect(rock.resourceRemaining + cargo(tug) + cargo(second)).toBeCloseTo(150, 8);
    expect(g.apply(seat, { kind: 'stop', units: [id(g, 'nw', tug), id(g, 'nw', second)] })).toEqual({ ok: true });
    const before = g.sim.armies[0]!.stats.alloyMined;
    moveHome(g, tug); moveHome(g, second);
    until(g, () => cargo(tug) === 0);
    steps(g, 20);
    expect(g.sim.armies[0]!.stats.alloyMined - before).toBeCloseTo(2, 8);
    expect(rock.resourceRemaining).toBeCloseTo(148, 8);
  });

  it('an equally close enemy contest extracts nothing until one contender leaves', () => {
    const { g, tug, rock } = fixture();
    tug.x = rock.x - g.sim.econ.tugMineReach;
    const second = g.sim.add('tug', 1, 'orbit', rock.x + g.sim.econ.tugMineReach, rock.y);
    g.sim.computeVision(); mine(g, tug, rock);
    expect(g.apply(enemy, { kind: 'mine_asteroid', units: [id(g, 'se', second)], asteroid: id(g, 'se', rock) })).toEqual({ ok: true });
    g.step();
    expect(cargo(tug) + cargo(second)).toBe(0); expect(rock.miningTug).toBe(0);
    expect(g.apply(enemy, { kind: 'move', units: [id(g, 'se', second)], x: second.x + 4, y: second.y })).toEqual({ ok: true });
    until(g, () => cargo(tug) > 0, 30);
    expect(rock.miningTug).toBe(tug.id);
    expect(cargo(second)).toBe(0);
  });

  it.each([0, 1] as const)('a rock depleted by army %i leaves no approaching enemy tug targeting the removed rock', army => {
    const { g, tug, rock } = fixture('metal', 'medium', army);
    const own = army === 0 ? seat : enemy, other = army === 0 ? enemy : seat;
    const direction = army === 0 ? 1 : -1;
    const approach = g.sim.add('tug', 1 - army, 'orbit', rock.x + direction * 3, rock.y);
    g.sim.computeVision();
    expect(g.apply(own, { kind: 'mine_asteroid', units: [id(g, own.team, tug)], asteroid: id(g, own.team, rock) })).toEqual({ ok: true });
    steps(g, 5);
    expect(rock.miningTug).toBe(tug.id);
    expect(g.apply(other, { kind: 'mine_asteroid', units: [id(g, other.team, approach)], asteroid: id(g, other.team, rock) })).toEqual({ ok: true });
    g.step();
    expect(approach.miningTarget).toBe(rock.id);
    // The latched miner takes the last sliver this tick, after the approaching tug already updated toward it.
    rock.resourceRemaining = 1e-3;
    g.step();
    expect(rock.dead).toBe(true); expect(g.sim.byId.has(rock.id)).toBe(false);
    expect(tug.miningTarget).toBe(0); expect(approach.miningTarget).toBe(0);
  });
});

describe('remaining asteroid value and fog', () => {
  it.each(['metal', 'ice', 'slag'] as const)('%s docking uses its remaining resource and never converts another resource to alloy', type => {
    const { g, tug, rock } = fixture(type, 'pebble');
    const control = g.clone();
    g.sim.damage(rock, rock.hp / 2, 1);
    const yieldValue = g.sim.rocks.pebble.dockYield[type];
    expect(rock.resourceRemaining).toBeCloseTo((yieldValue.alloy + yieldValue.energy) / 2, 8);
    expect(g.apply(seat, { kind: 'grapple', units: [id(g, 'nw', tug)], asteroid: id(g, 'nw', rock) })).toEqual({ ok: true });
    until(g, () => tug.link === rock.id); moveHome(g, tug); until(g, () => rock.dead);
    while (control.tick < g.tick) control.step();
    expect(g.sim.armies[0]!.alloy - control.sim.armies[0]!.alloy).toBeCloseTo(yieldValue.alloy / 2, 7);
    expect(g.sim.armies[0]!.energy - control.sim.armies[0]!.energy).toBeCloseTo(yieldValue.energy / 2, 7);
  });

  it.each(['metal', 'ice'] as const)('%s extraction reduces later drop damage and only remaining nonvolatile metal becomes a cache', type => {
    const { g, tug, rock } = fixture(type);
    mine(g, tug, rock); steps(g, 20);
    expect(g.apply(seat, { kind: 'release', units: [id(g, 'nw', tug)] })).toEqual({ ok: true });
    const held = cargo(tug);
    g.sim.damage(rock, rock.maxHp / 4, 1);
    const fraction = rock.hp / rock.maxHp, remaining = rock.resourceRemaining;
    const target = g.sim.add('shaft', 1, 'surface', 24, 24);
    target.hp = target.maxHp = 10000;
    expect(g.sim.dropPayload(rock, 0, 24, 24)).toBe(true);
    g.sim.tick = rock.impactTick - 1; g.step();
    expect(target.hp).toBeCloseTo(10000 - g.sim.rocks.medium.drops[type].impact.damage * fraction, 6);
    if (type === 'metal') {
      expect(g.sim.oreCaches).toHaveLength(1);
      const cache = g.sim.oreCaches[0]!;
      expect(cache.alloy + cache.belowAlloy).toBeCloseTo(remaining * g.sim.econ.oreCacheMultiplier, 6);
    } else expect(g.sim.oreCaches).toHaveLength(0);
    expect(cargo(tug)).toBe(held);
  });

  it('slag remains a drop-only rock with zero salvage, and volatile metal never creates a cache', () => {
    for (const type of ['slag', 'metal'] as const) {
      const { g, rock } = fixture(type, 'pebble');
      rock.volatile = type === 'metal';
      expect(g.sim.dropPayload(rock, 0, 24, 24)).toBe(true);
      g.sim.tick = rock.impactTick - 1; g.step();
      expect(g.sim.oreCaches).toHaveLength(0);
      expect(g.sim.armies[0]!.stats.impacts).toBe(1);
    }
  });

  it('keeps depletion and unloading private when the opponent gains vision only afterward', () => {
    const { g, tug, rock, home } = fixture('ice', 'pebble');
    mine(g, tug, rock);
    until(g, () => rock.dead, 300);
    expect(g.view('nw').fx.some(e => e.kind === 'mining_depleted')).toBe(true);
    expect(g.view('se').fx.some(e => e.kind === 'mining_depleted')).toBe(false);
    // Reveal immediately in a checkpoint while the depletion effect is still retained.
    const revealed = g.clone();
    revealed.sim.scan(1, rock.x, rock.y);
    expect(revealed.view('se').fx.some(e => e.kind === 'mining_depleted')).toBe(false);
    until(g, () => cargo(tug) === 0);
    expect(g.view('nw').fx.some(e => e.kind === 'mining_unload')).toBe(true);
    expect(g.view('se').fx.some(e => e.kind === 'mining_unload')).toBe(false);
    g.sim.scan(1, rock.x, rock.y); g.sim.scan(1, home.x, home.y);
    expect(g.view('se').fx.some(e => e.kind.startsWith('mining_'))).toBe(false);
  });

  it('hides mining fields and event-time audiences through fog, including after later scan vision', () => {
    const { g, tug, rock } = fixture();
    mine(g, tug, rock); g.step();
    const own = g.view('nw').entities.find(e => e.id === id(g, 'nw', tug))!;
    expect(own.miningTarget).toBe(id(g, 'nw', rock)); expect(own.cargoAlloy).toBeCloseTo(0.1, 8); expect(own.cargoEnergy).toBe(0);
    expect(shown(g, 'se', tug) || shown(g, 'se', rock)).toBe(false);
    expect(g.view('nw').fx.some(e => e.kind === 'mining_start')).toBe(true);
    expect(g.view('se').fx.some(e => e.kind.startsWith('mining_'))).toBe(false);
    g.sim.scan(1, rock.x, rock.y);
    const seen = g.view('se').entities.find(e => e.id === id(g, 'se', rock))!;
    expect(seen.resourceType).toBe('metal'); expect(seen.volatile).toBe(false); expect(seen.resourceRemaining).toBeCloseTo(149.9, 6);
    expect(g.view('se').entities.find(e => e.id === id(g, 'se', tug))!.miningTarget).toBeUndefined();
    expect(g.view('se').fx.some(e => e.kind === 'mining_start')).toBe(false);
    expect(validate(observationSchema, g.observe(seat, 0)).ok).toBe(true);
  });
});

for (const mode of ['standard', 'veteran', 'policy'] as const) describe(`real Orbit mining decisions: ${mode}`, () => {
  it.each(['metal', 'ice'] as const)('%s is mined, unloaded and re-harvested without replacing its ongoing order', resourceType => {
    const { g, tug, rock } = fixture(resourceType);
    const home = g.sim.armies[0]!.spire.orbit;
    tug.x = home.x + 14; tug.y = home.y + 3;
    rock.x = tug.x + g.sim.econ.tugMineReach; rock.y = tug.y;
    rock.vx = g.sim.econ.asteroidDrift / 20; rock.vy = g.sim.econ.asteroidDrift / 40;
    g.sim.computeVision();
    // Keep production unfunded: this is one real tug's lifecycle, not a fleet-growth/full-match test.
    g.sim.armies[0]!.alloy = g.sim.armies[0]!.energy = 0;
    const bootstrap = g.matchData(seat);
    let think: (obs: Observation) => AgentCommandIntent[];
    if (mode === 'policy') {
      think = runInNewContext(`${STARTER_POLICIES.orbit}\ninit(bootstrap);\nthink;`, { bootstrap, log() {} }) as typeof think;
    } else {
      const bot = createBot('nw', 'orbit', mode);
      bot.init?.(bootstrap);
      think = obs => bot.think(obs);
    }
    let since = 0, issuedMining = 0, full = false, unloaded = false, resumed = false, hidden = false;
    const effects = new Set<string>();
    for (let tick = 0; tick < 2000 && !resumed; tick++) {
      if (g.tick % BOT_PERIOD === 0) {
        const obs = g.observe(seat, since);
        since = g.tick;
        for (const intent of structuredClone(think(obs))) {
          const result = g.apply(seat, intent, { source: mode === 'policy' ? 'policy' : 'bot' });
          if (intent.kind === 'mine_asteroid' && intent.units.includes(id(g, 'nw', tug))) {
            expect(result).toEqual({ ok: true });
            expect(intent.asteroid).toBe(id(g, 'nw', rock));
            issuedMining++;
          }
        }
      }
      const before = cargo(tug);
      g.step();
      const view = g.view('nw');
      for (const effect of view.fx) effects.add(effect.kind);
      if (unloaded && !view.entities.some(e => e.id === id(g, 'nw', rock))) hidden = true;
      if (cargo(tug) >= 50 - 1e-8) full = true;
      if (full && before > 0 && cargo(tug) === 0) unloaded = true;
      if (unloaded && cargo(tug) > 0 && tug.miningTarget === rock.id) resumed = true;
    }
    expect(issuedMining).toBe(1); expect(full).toBe(true); expect(unloaded).toBe(true); expect(hidden).toBe(true); expect(resumed).toBe(true);
    expect(rock.dead).toBe(false); expect(rock.state).toBe('drifting');
    expect(tug.link).toBe(0);
    expect(resourceType === 'metal' ? tug.cargoEnergy : tug.cargoAlloy).toBe(0);
    expect(effects.has('mining_unload')).toBe(true);
  });
});

describe('Orbit auto_mine macro', () => {
  const auto = { kind: 'macro', action: 'auto_mine' } as const;
  const assigned = (tug: Ent): number => tug.order.k === 'mine_asteroid' ? tug.order.asteroid : 0;
  function another(g: AgentCommandGame, source: Ent, x: number, y: number): Ent {
    const rock = g.sim.add('asteroid', NEUTRAL, 'orbit', x, y);
    rock.rockSize = source.rockSize;
    rock.resourceType = source.resourceType;
    rock.hp = rock.maxHp = source.maxHp;
    const value = g.sim.rocks[rock.rockSize].dockYield[rock.resourceType];
    rock.resourceRemaining = value.alloy + value.energy;
    rock.state = 'drifting';
    return rock;
  }

  for (const army of [0, 1] as const) it.each(['metal', 'ice'] as const)(`army ${army}: %s mines, delivers, reacquires and exhausts only finite value`, type => {
    const { g, tug, rock, home } = fixture(type, 'pebble', army);
    const who = army === 0 ? seat : enemy, direction = army === 0 ? 1 : -1;
    const next = another(g, rock, home.x + direction * 4, home.y + direction * 6);
    const value = rock.resourceRemaining + next.resourceRemaining;
    g.sim.computeVision();
    const control = g.clone();
    expect(g.apply(who, auto)).toEqual({ ok: true });
    g.step();
    expect(assigned(tug)).toBe(rock.id);
    until(g, () => rock.dead, 500);
    expect(cargo(tug)).toBeGreaterThan(0);
    until(g, () => cargo(tug) === 0, 500);
    until(g, () => assigned(tug) === next.id && cargo(tug) > 0, 500);
    until(g, () => next.dead && cargo(tug) === 0, 1000);
    steps(g, 5);
    expect(tug.order).toMatchObject({ k: 'mine_asteroid', auto: true, asteroid: 0 });
    expect(tug.state).toBe('idle');
    const own = g.view(who.team).entities.find(e => e.id === id(g, who.team, tug))!;
    expect(own.miningAssigned).toBe(true); expect(own.tx).toBeUndefined();
    while (control.tick < g.tick) control.step();
    expect(g.sim.armies[army]!.alloy - control.sim.armies[army]!.alloy).toBeCloseTo(type === 'metal' ? value : 0, 6);
    expect(g.sim.armies[army]!.energy - control.sim.armies[army]!.energy).toBeCloseTo(type === 'ice' ? value : 0, 6);
  });

  it('resumes the original viable rock, clones deterministically and hashes automation state', () => {
    const { g, tug, rock } = fixture();
    expect(g.apply(seat, auto)).toEqual({ ok: true });
    until(g, () => cargo(tug) >= g.sim.econ.tugHold - 1e-8, 700);
    const copy = g.clone(), twin = copy.sim.alive(tug.id)!;
    expect(copy.stateHash()).toBe(g.stateHash());
    if (twin.order.k === 'mine_asteroid') twin.order.auto = false;
    expect(copy.stateHash()).not.toBe(g.stateHash());
    if (twin.order.k === 'mine_asteroid') twin.order.auto = true;
    for (let i = 0; i < 400; i++) {
      g.step(); copy.step();
      expect(copy.stateHash()).toBe(g.stateHash());
    }
    expect(assigned(tug)).toBe(rock.id);
    expect(cargo(tug)).toBeGreaterThan(0);
    expect(g.sim.armies[0]!.stats.alloyMined).toBeGreaterThanOrEqual(50 - 1e-8);
  });

  it.each(['stop', 'release', 'move'] as const)('%s cancels permanently, keeping cargo for manual delivery', kind => {
    const { g, tug, rock } = fixture();
    g.apply(seat, auto); until(g, () => cargo(tug) > 1);
    const held = cargo(tug), remaining = rock.resourceRemaining;
    expect(g.apply(seat, kind === 'move' ? { kind, units: [id(g, 'nw', tug)], x: tug.x, y: tug.y + 2 } : { kind, units: [id(g, 'nw', tug)] })).toEqual({ ok: true });
    steps(g, 20);
    expect(cargo(tug)).toBe(held); expect(rock.resourceRemaining).toBe(remaining);
    moveHome(g, tug); until(g, () => cargo(tug) === 0);
    steps(g, 20);
    expect(tug.order.k).not.toBe('mine_asteroid');
    expect(rock.resourceRemaining).toBe(remaining);
  });

  it.each([false, true])('queued explicit work takes over without waiting for depletion; loaded=%s', loaded => {
    const { g, tug, rock, home } = fixture();
    g.apply(seat, auto);
    if (loaded) until(g, () => cargo(tug) > 1);
    const remaining = rock.resourceRemaining;
    expect(g.apply(seat, { kind: 'move', units: [id(g, 'nw', tug)], x: home.x + 1, y: home.y + 5, queue: true })).toEqual({ ok: true });
    until(g, () => tug.order.k === 'move', 500);
    expect(cargo(tug)).toBe(0); expect(rock.resourceRemaining).toBe(remaining);
    expect(tug.queue).toHaveLength(0);
  });

  it('does not steal other roles, enemies, manual mining, core/tow work or queued orders; Depths stays unchanged', () => {
    const { g, tug, rock, home } = fixture();
    const manual = g.sim.add('tug', 0, 'orbit', home.x + 2, home.y);
    mine(g, manual, rock);
    const worker = g.sim.add('tug', 0, 'orbit', home.x, home.y + 2);
    g.sim.order(worker, { k: 'move', x: home.x + 8, y: home.y, fight: false, speed: 0 });
    const tower = g.sim.add('tug', 0, 'orbit', home.x + 1, home.y);
    const core = g.sim.add('core', NEUTRAL, 'orbit', tower.x, tower.y);
    tower.link = core.id; core.link = tower.id;
    const queued = g.sim.add('tug', 0, 'orbit', home.x, home.y + 1);
    queued.queue.push({ k: 'move', x: home.x + 4, y: home.y, fight: false, speed: 0 });
    const hostile = g.sim.add('tug', 1, 'orbit', home.x + 3, home.y);
    const wrongPlane = g.sim.add('tug', 0, 'sky', home.x, home.y);
    const digger = g.sim.add('digger', 0, 'depths', home.x, home.y);
    expect(g.apply({ team: 'nw', role: 'surface' }, auto)).toMatchObject({ ok: false, code: 'wrong_plane' });
    expect(g.apply({ team: 'nw', role: 'sky' }, auto)).toMatchObject({ ok: false, code: 'wrong_plane' });
    expect(g.apply(seat, auto)).toEqual({ ok: true });
    expect(tug.order).toMatchObject({ auto: true });
    expect(manual.order).toMatchObject({ k: 'mine_asteroid', asteroid: rock.id });
    expect(manual.order).not.toHaveProperty('auto');
    expect(worker.order.k).toBe('move'); expect(tower.order.k).toBe('none'); expect(tower.link).toBe(core.id);
    expect(queued.order.k).toBe('none'); expect(queued.queue).toHaveLength(1);
    expect(hostile.order.k).toBe('none'); expect(wrongPlane.order.k).toBe('none'); expect(digger.order.k).toBe('none');
    expect(g.apply({ team: 'nw', role: 'depths' }, auto)).toEqual({ ok: true });
    expect(digger.order).toMatchObject({ k: 'mine', auto: true });
  });

  it('reserves separate rocks through home trips rather than oscillating between friendly targets', () => {
    const { g, tug, rock, home } = fixture();
    const second = g.sim.add('tug', 0, 'orbit', home.x + 3, home.y + 7);
    const next = another(g, rock, second.x + g.sim.econ.tugMineReach, second.y);
    g.sim.computeVision(); g.apply(seat, auto); g.step();
    expect(assigned(tug)).toBe(rock.id); expect(assigned(second)).toBe(next.id);
    steps(g, 600);
    expect(assigned(tug)).toBe(rock.id); expect(assigned(second)).toBe(next.id);
    expect(g.sim.armies[0]!.stats.alloyMined).toBeGreaterThan(0);
  });

  it('idle search ignores hidden rocks, slag, volatile rocks, enemy tows and core; a later visible rock is acquired', () => {
    const { g, tug, rock, home } = fixture('slag');
    const volatile = another(g, rock, tug.x + 2, tug.y + 2);
    volatile.resourceType = 'metal'; volatile.resourceRemaining = 150; volatile.volatile = true;
    const towed = another(g, volatile, tug.x, tug.y + 3);
    const enemyTug = g.sim.add('tug', 1, 'orbit', towed.x, towed.y);
    towed.state = 'towed'; towed.link = enemyTug.id; enemyTug.link = towed.id;
    const core = g.sim.add('core', NEUTRAL, 'orbit', tug.x + 1, tug.y + 1);
    const hidden = another(g, volatile, g.sim.size - home.x, g.sim.size - home.y);
    g.sim.computeVision(); g.apply(seat, auto); steps(g, 20);
    expect(assigned(tug)).toBe(0); expect(tug.state).toBe('idle'); expect(tug.link).toBe(0);
    expect(shown(g, 'nw', hidden)).toBe(false);
    expect(core.link).toBe(0);
    const fresh = another(g, hidden, tug.x + 3, tug.y);
    g.sim.computeVision();
    until(g, () => assigned(tug) === fresh.id);
    expect(g.apply(seat, { kind: 'release', units: [id(g, 'nw', tug)] })).toEqual({ ok: true });
    expect(tug.order.k).toBe('none');
  });

  it('loss of home cancels without deleting or paying cargo, and prevents new enrollment', () => {
    const { g, tug, home } = fixture();
    g.apply(seat, auto); until(g, () => cargo(tug) > 1);
    const held = cargo(tug), delivered = g.sim.armies[0]!.stats.alloyMined;
    home.hp = 0; g.step();
    expect(tug.order.k).toBe('none'); expect(tug.miningTarget).toBe(0);
    expect(cargo(tug)).toBe(held); expect(g.sim.armies[0]!.stats.alloyMined).toBe(delivered);
    expect(g.apply(seat, auto)).toMatchObject({ ok: false, code: 'segment_destroyed' });
  });

  it('visible target removal returns cargo and reacquires another real resource', () => {
    const { g, tug, rock, home } = fixture();
    const next = another(g, rock, home.x + 4, home.y + 6);
    g.sim.computeVision(); g.apply(seat, auto); until(g, () => cargo(tug) > 1);
    const held = cargo(tug);
    g.sim.damage(rock, rock.hp, 1);
    until(g, () => assigned(tug) === next.id, 700);
    expect(g.sim.armies[0]!.stats.alloyMined).toBeCloseTo(held, 6);
    until(g, () => cargo(tug) > 0);
  });

  it('retains observed drift through fog and reacquires only after inspecting the missing site', () => {
    const { g, tug, rock, home } = fixture();
    tug.x = home.x + 14; tug.y = home.y + 3;
    rock.x = tug.x + g.sim.econ.tugMineReach; rock.y = tug.y;
    rock.vx = g.sim.econ.asteroidDrift / 20; rock.vy = g.sim.econ.asteroidDrift / 40;
    const next = another(g, rock, home.x + 3, home.y + 4);
    g.sim.computeVision(); g.apply(seat, auto);
    until(g, () => cargo(tug) >= 50 - 1e-8, 700);
    until(g, () => cargo(tug) === 0, 800);
    expect(shown(g, 'nw', rock)).toBe(false);
    const missing = g.clone(), twin = missing.sim.alive(tug.id)!;
    const hidden = missing.sim.alive(rock.id)!;
    hidden.dead = true; hidden.hp = 0;
    for (let i = 0; i < 12; i++) {
      g.step(); missing.step();
      expect(missing.view('nw').entities.find(e => e.id === id(missing, 'nw', twin))).toEqual(g.view('nw').entities.find(e => e.id === id(g, 'nw', tug)));
      expect(twin.order).toEqual(tug.order);
    }
    until(g, () => tug.state === 'mining' && cargo(tug) > 0, 1000);
    until(missing, () => assigned(twin) !== rock.id, 1000);
    expect(twin.order).toMatchObject({ k: 'mine_asteroid', auto: true });
    // Search must not remotely select a home rock that is no longer visible from the empty site.
    if (!shown(missing, 'nw', next)) expect(assigned(twin)).toBe(0);
  });

  for (const mode of ['standard', 'veteran', 'policy'] as const) it(`${mode} preserves auto-mine's idle search and cargo return`, () => {
    const { g, tug, rock } = fixture('slag');
    g.sim.armies[0]!.alloy = g.sim.armies[0]!.energy = 0;
    g.apply(seat, auto); g.step();
    const bootstrap = g.matchData(seat);
    let think: (obs: Observation) => AgentCommandIntent[];
    if (mode === 'policy') think = runInNewContext(`${STARTER_POLICIES.orbit}\ninit(bootstrap);\nthink;`, { bootstrap, log() {} }) as typeof think;
    else {
      const bot = createBot('nw', 'orbit', mode);
      bot.init?.(bootstrap);
      think = obs => bot.think(obs);
    }
    for (const loaded of [false, true]) {
      if (loaded) {
        rock.resourceType = 'metal'; rock.resourceRemaining = 150;
        tug.cargoAlloy = g.sim.econ.tugHold;
        g.step();
      }
      const order = structuredClone(tug.order);
      for (const intent of structuredClone(think(g.observe(seat, 0)))) g.apply(seat, intent, { source: mode === 'policy' ? 'policy' : 'bot' });
      expect(tug.order).toEqual(order);
      expect(g.view('nw').entities.find(e => e.id === id(g, 'nw', tug))!.miningAssigned).toBe(true);
    }
  });

  it('blocked ruin sites are ignored until public geometry permits a collection and home route', () => {
    const g = createGame({ seed: 31, options: { orbit: { maxAsteroids: 0 } } });
    for (const e of g.sim.ents) if (e.unit) e.dead = true;
    g.step();
    const ruin = g.sim.derelict!, home = g.sim.armies[0]!.spire.orbit;
    const tug = g.sim.add('tug', 0, 'orbit', home.x, home.y);
    const rock = g.sim.add('asteroid', NEUTRAL, 'orbit', ruin.x, ruin.y);
    rock.state = 'drifting'; rock.resourceType = 'metal'; rock.resourceRemaining = 150;
    // A body centred in solid hull cannot be a harvest site, even with scan vision.
    rock.x = ruin.x + (ruin.hullInner + ruin.hullOuter) / Math.sqrt(8);
    rock.y = ruin.y + (ruin.hullInner + ruin.hullOuter) / Math.sqrt(8);
    g.sim.scan(0, rock.x, rock.y);
    g.apply(seat, auto); g.step();
    expect(assigned(tug)).toBe(0); expect(tug.state).toBe('idle');
    rock.x = home.x + 5; rock.y = home.y + 1;
    g.sim.computeVision();
    until(g, () => assigned(tug) === rock.id);
  });
});
