import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { ISLAND_STRUCTURES, TICK_RATE, TRANSITS } from '../src/rules/contract.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);

const setup = (options: object = {}) => {
  const g = createGame({ seed: 9, options });
  const s = g.sim;
  s.armies[BLUE]!.alloy = 5000;
  s.armies[BLUE]!.energy = 5000;
  const island = s.ents.find(e => e.kind === 'island')!;
  s.setSide(island, BLUE);
  return { g, s, island };
};

describe('island slots and upkeep', () => {
  for (const kind of ISLAND_STRUCTURES) it(`${kind} reserves the one shared island slot`, () => {
    const { g, s, island } = setup();
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: kind, island: g.entityId('nw', island.id) })).toEqual({ ok: true });
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'relay', island: g.entityId('nw', island.id) })).toMatchObject({ ok: false, code: 'occupied' });
    g.step();
    const structure = s.alive(island.link)!;
    expect(structure.kind).toBe(kind);
    expect(structure.link).toBe(island.id);
    g.step();
    expect(structure.x).toBe(island.x);
    expect(structure.y).toBe(island.y);
  });

  it('suspends consuming structures when the team cannot fund their upkeep', () => {
    const { g, s, island } = setup();
    const aerie = s.add('aerie', BLUE, 'sky', island.x, island.y);
    aerie.link = island.id;
    island.link = aerie.id;
    for (const e of s.ents) if (e.kind === 'solar' && e.side === BLUE) e.dead = true;
    s.armies[BLUE]!.energy = 0;
    g.step();
    expect(s.armies[BLUE]!.upkeep).toBe(s.econ.aerieUpkeep);
    expect(g.observe({ team: 'nw', role: 'sky' }, 0).res.income.sky.upkeep).toBe(s.econ.aerieUpkeep);
    expect(s.armies[BLUE]!.powered).toBe(false);
    s.armies[BLUE]!.energy = 1;
    g.step();
    expect(s.armies[BLUE]!.powered).toBe(true);
  });
});

describe('Aerie', () => {
  it('houses air without vision, combat or capture and launches only after preparation', () => {
    const { g, s, island } = setup();
    const aerie = s.add('aerie', BLUE, 'sky', island.x, island.y);
    island.link = aerie.id;
    aerie.link = island.id;
    const air = s.add('interceptor', BLUE, 'sky', island.x, island.y);
    const seat = { team: 'nw', role: 'sky' } as const;
    const unit = g.entityId('nw', air.id);
    expect(g.apply(seat, { kind: 'hangar', units: [unit], target: g.entityId('nw', aerie.id) })).toEqual({ ok: true });
    expect(s.sees(RED, air)).toBe(false);
    expect(s.canHit(air, 'sky')).toBe(false);
    const hp = air.hp;
    s.damage(air, 1000, RED);
    expect(air.hp).toBe(hp);
    expect(g.apply(seat, { kind: 'move', units: [unit], x: 24, y: 24 })).toMatchObject({ ok: false });
    expect(g.apply(seat, { kind: 'launch', units: [unit] })).toEqual({ ok: true });
    for (let i = 0; i < s.econ.aerieLaunchTicks - 1; i++) g.step();
    expect(air.hangar).toBe(aerie.id);
    g.step();
    expect(air.hangar).toBe(0);
  });

  it('evacuates a destroyed Aerie with the configured remaining health fraction', () => {
    const { g, s, island } = setup();
    const aerie = s.add('aerie', BLUE, 'sky', island.x, island.y);
    const air = s.add('bomber', BLUE, 'sky', island.x, island.y);
    air.hangar = aerie.id;
    air.state = 'hangared';
    const hp = air.hp;
    aerie.hp = 0;
    g.step();
    expect(air.hangar).toBe(0);
    expect(air.hp).toBeLessThanOrEqual(hp * s.econ.aerieLossHealth);
  });

  it('runs a forward producer independently of its destroyed Sky segment', () => {
    const { g, s, island } = setup();
    const aerie = s.add('aerie', BLUE, 'sky', island.x, island.y);
    island.link = aerie.id;
    aerie.link = island.id;
    s.armies[BLUE]!.spire.sky.hp = 0;
    const before = s.ents.filter(e => e.kind === 'interceptor' && e.side === BLUE).length;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'interceptor', producer: g.entityId('nw', aerie.id) })).toEqual({ ok: true });
    for (let i = 0; i < s.stats.interceptor.build; i++) g.step();
    const made = s.ents.filter(e => e.kind === 'interceptor' && e.side === BLUE);
    expect(made).toHaveLength(before + 1);
    expect(Math.hypot(made.at(-1)!.x - aerie.x, made.at(-1)!.y - aerie.y)).toBeLessThan(2);
  });

  it('airdrops paid troops through the shared registry and enforces cooldown', () => {
    const { g, s } = setup();
    const aerie = s.add('aerie', BLUE, 'sky', 12, 12);
    const seat = { team: 'nw', role: 'sky' } as const;
    const alloy = s.armies[BLUE]!.alloy;
    expect(g.apply(seat, { kind: 'airdrop', aerie: g.entityId('nw', aerie.id) })).toEqual({ ok: true });
    const drops = s.ents.filter(e => e.transitKind === TRANSITS.airdrop);
    expect(drops).toHaveLength(s.econ.aerieDropCount);
    expect(s.armies[BLUE]!.alloy).toBe(alloy - s.econ.aerieDropCount * s.stats.trooper.alloy);
    expect(g.apply(seat, { kind: 'airdrop', aerie: g.entityId('nw', aerie.id) })).toMatchObject({ ok: false });
    for (let i = 0; i < s.econ.aerieDropTravel; i++) g.step();
    for (const u of drops) expect(u.plane).toBe('surface');
  });

  it('repairs housed aircraft in a powered Aerie at aerieRepair HP/s', () => {
    const { s, island } = setup();
    const aerie = s.add('aerie', BLUE, 'sky', island.x, island.y);
    aerie.link = island.id;
    island.link = aerie.id;
    const plane = s.add('gunship', BLUE, 'sky', island.x, island.y);
    plane.hp = 100;
    plane.hangar = aerie.id;
    plane.state = 'hangared';
    for (let i = 0; i < 20; i++) s.step();
    expect(plane.hp).toBeCloseTo(100 + s.econ.aerieRepair, 6);
    s.econ.aerieRepairEnabled = false;
    s.step();
    expect(plane.hp).toBeCloseTo(100 + s.econ.aerieRepair, 6);
  });
});

describe('Stormcatcher and Storm Seeder', () => {
  it('generates direct local energy in storms even without Orbit or delivery capacity', () => {
    const { g, s } = setup();
    for (const c of s.weather.data.forecast) {
      c.start = c.grown = 0;
      c.breaking = 1000000;
      c.end = 1000001;
      c.dx = c.dy = 0;
    }
    s.weather.update(s.tick);
    const storm = s.weather.data.storms[0]!;
    const catcher = s.add('stormcatcher', BLUE, 'sky', storm.x, storm.y);
    for (const e of s.ents) if (e.side === BLUE && e.kind === 'solar') e.dead = true;
    s.armies[BLUE]!.spire.sky.hp = 0;
    s.armies[BLUE]!.spire.orbit.hp = 0;
    const energy = s.armies[BLUE]!.energy;
    g.step();
    expect(s.armies[BLUE]!.stormcatcher).toBe(s.econ.stormcatcherRate);
    expect(s.armies[BLUE]!.energy - energy).toBeCloseTo(s.econ.stormcatcherRate / 20, 8);
    expect(g.observe({ team: 'nw', role: 'sky' }, 0).res.income.sky.energy).toBe(s.econ.stormcatcherRate);
    catcher.x = catcher.y = 0;
    g.step();
    expect(s.armies[BLUE]!.stormcatcher).toBe(0);
    expect(catcher.state).toBe('idle');
  });

  it('earns nothing from forecast clouds and scales natural income with current strength', () => {
    const { g, s } = setup();
    const announced = s.weather.data.forecast[0]!;
    const catcher = s.add('stormcatcher', BLUE, 'sky', announced.x, announced.y);
    g.step();
    expect(s.armies[BLUE]!.stormcatcher).toBe(0);
    expect(catcher.state).toBe('idle');
    for (const c of s.weather.data.forecast) {
      c.start = 0;
      c.grown = 4;
      c.breaking = 1000;
      c.end = 1001;
      c.dx = c.dy = 0;
    }
    g.step();
    expect(s.weather.data.storms[0]!.strength).toBe(0.5);
    expect(s.armies[BLUE]!.stormcatcher).toBe(s.econ.stormcatcherRate * 0.5);
    expect(g.observe({ team: 'nw', role: 'sky' }, 0).res.income.sky.energy).toBe(s.econ.stormcatcherRate * 0.5);
  });

  it('seeds on demand: telegraph, storm, upkeep (the seederUpkeep rule) only while blowing, cooldown, power loss', () => {
    const { g, s } = setup({ sky: { seederUpkeep: 1 } });
    const seat = { team: 'nw', role: 'sky' } as const;
    const seeder = s.add('storm_seeder', BLUE, 'sky', 5, 5);
    g.step();
    expect(s.weather.data.seeded).toHaveLength(0);
    expect(seeder.state).toBe('idle');
    expect(s.armies[BLUE]!.skyUpkeep).toBe(0);
    const energy = s.armies[BLUE]!.energy;
    expect(g.apply(seat, { kind: 'seed', seeder: g.entityId('nw', seeder.id) })).toEqual({ ok: true });
    expect(s.armies[BLUE]!.energy).toBe(energy - s.econ.seederCost);
    expect(g.apply(seat, { kind: 'seed', seeder: g.entityId('nw', seeder.id) })).toMatchObject({ ok: false, code: 'cooldown' });
    const start = s.tick + s.econ.seederTelegraph;
    g.step();
    // Telegraph: public, no storm, no upkeep.
    expect(s.weather.data.seeded).toHaveLength(0);
    expect(g.observe({ team: 'se', role: 'sky' }, 0).weather.seedWarnings).toEqual([{ x: seeder.x, y: seeder.y, radius: s.econ.seederRadius, from: start }]);
    expect(s.armies[BLUE]!.skyUpkeep).toBe(0);
    while (s.tick < start) g.step();
    expect(s.weather.data.seedWarnings).toHaveLength(0);
    expect(s.weather.data.seeded).toHaveLength(1);
    expect(s.weather.data.seeded[0]!.until).toBe(start + s.econ.seederDuration);
    expect(s.weather.data.seeded[0]!.radius).toBe(s.econ.seederRadius);
    expect(seeder.state).toBe('active');
    g.step();
    expect(s.armies[BLUE]!.skyUpkeep).toBe(s.econ.seederUpkeep);
    for (const e of s.ents) if (e.side === BLUE && e.kind === 'solar') e.dead = true;
    s.armies[BLUE]!.energy = 0;
    g.step();
    g.step();
    expect(s.weather.data.seeded).toHaveLength(0);
    expect(seeder.state).toBe('idle');
    expect(s.armies[BLUE]!.stats.seeds).toBe(1);
  });

  it('upkeep is 0 by default: one Stormcatcher in a seeded storm earns more than the seed costs', () => {
    const { s } = setup();
    expect(s.econ.seederUpkeep).toBe(0);
    const seconds = s.econ.seederDuration / TICK_RATE;
    // 1.5 energy/s × 30 s = 45 for a 40-energy seed: +5 per Stormcatcher (it was 45 − 40 − 1 × 30 = −25).
    expect(s.econ.stormcatcherRate * seconds - s.econ.seederCost - s.econ.seederUpkeep * seconds).toBe(5);
    const seeder = s.add('storm_seeder', BLUE, 'sky', 10, 10);
    seeder.activeUntil = s.tick + s.econ.seederDuration;
    s.step();
    expect(s.weather.data.seeded).toHaveLength(1);
    expect(s.armies[BLUE]!.skyUpkeep).toBe(0);
  });

  it('reaches a Stormcatcher on a neighbouring island: seederRadius exceeds islandClearance', () => {
    const { s } = setup();
    expect(s.econ.seederRadius).toBeGreaterThan(s.rules.map.islandClearance);
    const seeder = s.add('storm_seeder', BLUE, 'sky', 10, 10);
    const catcher = s.add('stormcatcher', BLUE, 'sky', 10 + s.rules.map.islandClearance, 10);
    seeder.activeUntil = s.tick + s.econ.seederDuration;
    for (const e of s.ents) if (e.side === BLUE && e.kind === 'solar') e.dead = true;
    s.armies[BLUE]!.energy = 1000;
    s.step();
    expect(s.stormAt(catcher.x, catcher.y)).toBe(true);
    expect(s.armies[BLUE]!.stormcatcher).toBeGreaterThan(0);
  });

  it('cannot seed or build Seeders when seederEnabled is off', () => {
    const g = createGame({ seed: 9, options: { sky: { seederEnabled: false } } });
    const s = g.sim;
    s.armies[BLUE]!.energy = 5000;
    s.armies[BLUE]!.alloy = 5000;
    const island = s.ents.find(e => e.kind === 'island')!;
    s.setSide(island, BLUE);
    const seat = { team: 'nw', role: 'sky' } as const;
    expect(g.apply(seat, { kind: 'queue_add', item: 'storm_seeder', island: g.entityId('nw', island.id) })).toMatchObject({ ok: false, code: 'blocked' });
    const seeder = s.add('storm_seeder', BLUE, 'sky', 5, 5);
    expect(g.apply(seat, { kind: 'seed', seeder: g.entityId('nw', seeder.id) })).toMatchObject({ ok: false, code: 'blocked' });
  });
});
