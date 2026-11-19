import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { ISLAND_STRUCTURES, TICK_RATE, entitySchema, matchDataSchema, observationSchema, type ArmyId, type MatchOptions } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';
import { PLANE_INDEX } from '../src/sim/constants.ts';
import { cellOf } from '../src/util/grid.ts';

const SKY = { team: 'nw', role: 'sky' } as const;
const ENEMY = { team: 'se', role: 'sky' } as const;
const id = (g: AgentCommandGame, e: Ent, team: ArmyId = 'nw'): string => g.entityId(team, e.id);

function arena(sky: MatchOptions['sky'] = {}) {
  const g = createGame({ seed: 31, options: {
    terrain: 'open', economy: { baseEnergyCap: 0, minimumEnergyCap: 0, spireAlloyRate: 0 }, spire: { dmg: 0 },
    orbit: { maxAsteroids: 0, derelictEnabled: false, stationPdDamage: 0 },
    sky: { stormSets: 0, fogRadius: 0, jetWidth: 0, ...sky },
  } });
  const s = g.sim;
  for (const e of s.ents) if (e.unit) e.dead = true;
  g.step();
  for (const army of s.armies) { army.alloy = army.energy = 1000; army.energyBank = 0; }
  const island = s.ents.find(e => e.kind === 'island')!;
  s.setSide(island, 0);
  island.oreCapacity = island.oreRemaining = 240;
  island.oreBuffer = 0;
  return { g, s, island };
}

function rig(a: ReturnType<typeof arena>): Ent {
  const e = a.s.add('ore_extractor', 0, 'sky', a.island.x, a.island.y);
  e.built = true;
  e.link = a.island.id;
  e.elevation = a.island.elevation;
  a.island.hardpoint = e.id;
  a.s.armies[0]!.structures++;
  return e;
}

function work(a: ReturnType<typeof arena>, ticks: number): void {
  for (let tick = 0; tick < ticks; tick++) { a.s.tick++; a.s.economy(); }
}

function steps(g: AgentCommandGame, ticks: number): void {
  for (let tick = 0; tick < ticks; tick++) g.step();
}

describe('finite island extraction and shared power', () => {
  it('conserves a finite deposit, pauses a full buffer without upkeep, and never grants alloy directly', () => {
    const a = arena({ extractorBuffer: 4 });
    const extractor = rig(a);
    a.island.oreCapacity = a.island.oreRemaining = 6;
    work(a, 12 * TICK_RATE);
    expect(a.island.oreRemaining).toBeCloseTo(2, 8);
    expect(a.island.oreBuffer).toBeCloseTo(4, 8);
    expect(a.s.armies[0]!.energy).toBeCloseTo(992, 8);
    expect(a.s.armies[0]!.alloy).toBe(1000);
    expect(extractor.state).toBe('idle');
    const fullEnergy = a.s.armies[0]!.energy;
    work(a, TICK_RATE);
    expect(a.s.armies[0]!.energy).toBe(fullEnergy);
    expect(a.g.apply(SKY, { kind: 'drop_ore', island: id(a.g, a.island) })).toEqual({ ok: true });
    expect(a.island.oreBuffer).toBe(0);
    expect(a.s.oreCaches).toHaveLength(1);
    expect(a.s.oreCaches[0]!.alloy).toBeCloseTo(4, 8);
    expect(a.s.armies[0]!.alloy).toBe(1000);
    work(a, 5 * TICK_RATE);
    expect(a.island.oreRemaining).toBe(0);
    expect(a.island.oreBuffer).toBeCloseTo(2, 8);
    expect(a.island.oreRemaining + a.island.oreBuffer + a.s.oreCaches[0]!.alloy).toBeCloseTo(6, 8);
    expect(a.s.armies[0]!.energy).toBeCloseTo(988, 8);
    expect(extractor.state).toBe('idle');
  });

  it('exhausts whole-buffer deposits without requiring a microscopic final drop', () => {
    const a = arena({ extractorRate: 2, extractorBuffer: 4 });
    const extractor = rig(a);
    a.island.oreCapacity = a.island.oreRemaining = 12;
    for (let load = 0; load < 3; load++) {
      work(a, 2 * TICK_RATE);
      expect(a.island.oreBuffer).toBe(4);
      expect(a.g.apply(SKY, { kind: 'drop_ore', island: id(a.g, a.island) })).toEqual({ ok: true });
    }
    expect(a.island.oreRemaining).toBe(0);
    work(a, TICK_RATE);
    expect(a.island.oreBuffer).toBe(0);
    expect(a.s.oreCaches.reduce((sum, cache) => sum + cache.alloy, 0)).toBe(12);
    expect(a.g.apply(SKY, { kind: 'drop_ore', island: id(a.g, a.island) }).ok).toBe(false);
    expect(a.g.apply(SKY, { kind: 'dismantle', structure: id(a.g, extractor) })).toEqual({ ok: true });
  });

  it('requires actual grid payment and charges a final partial load proportionally', () => {
    const a = arena();
    const extractor = rig(a);
    a.s.armies[0]!.energy = 0;
    work(a, TICK_RATE);
    expect(a.island.oreBuffer).toBe(0);
    expect(a.island.oreRemaining).toBe(240);
    expect(extractor.state).toBe('idle');
    expect(a.s.armies[0]!.powered).toBe(false);
    a.s.armies[0]!.energy = 1;
    a.island.oreRemaining = 0.01;
    work(a, 1);
    expect(a.island.oreRemaining).toBe(0);
    expect(a.island.oreBuffer).toBe(0.01);
    expect(a.s.armies[0]!.energy).toBeCloseTo(0.98, 12);
    expect(extractor.state).toBe('mining');
    work(a, 1);
    expect(extractor.state).toBe('idle');
    expect(a.s.armies[0]!.energy).toBeCloseTo(0.98, 12);
  });

  it('shares the same grid with other consumers instead of mining on a separate power budget', () => {
    const a = arena({ aerieUpkeep: 1 });
    rig(a);
    const aerie = a.s.add('aerie', 0, 'sky', a.island.x, a.island.y);
    aerie.link = a.island.id;
    a.island.link = aerie.id;
    a.s.armies[0]!.energy = 0.075; // enough for either 1 E/s consumer, not both this tick
    work(a, 1);
    expect(a.s.armies[0]!.powered).toBe(false);
    expect(a.island.oreBuffer).toBe(0);
    expect(aerie.state).toBe('idle');
    expect(a.s.armies[0]!.energy).toBe(0.075);
  });

  it('extracts identically while drifting or moored, with only the tower adding upkeep', () => {
    const drifting = arena(), held = arena();
    rig(drifting); rig(held);
    const tower = held.s.add('mooring_tower', 0, 'surface', held.island.x, held.island.y);
    tower.mooringTarget = held.island.id;
    tower.mooringGrace = held.s.econ.mooringGraceTicks;
    held.island.mooringTower = tower.id;
    held.island.mooringPhase = 2;
    held.island.mooringAt = -held.s.econ.mooringTravelTicks;
    held.island.elevation = -8;
    steps(drifting.g, 2 * TICK_RATE); steps(held.g, 2 * TICK_RATE);
    expect(held.island.oreBuffer).toBeCloseTo(drifting.island.oreBuffer, 12);
    expect(held.island.oreRemaining).toBeCloseTo(drifting.island.oreRemaining, 12);
    expect(held.s.armies[0]!.energy).toBeCloseTo(drifting.s.armies[0]!.energy - 2 * held.s.econ.mooringUpkeep, 8);
  });
});

describe('ordinary ore cache release and collection', () => {
  it('creates the exact impact OreCache shape through shared placement, without damage or double release', () => {
    const a = arena();
    a.s.holes.fill(0);
    a.island.oreBuffer = 12.5;
    const asteroid = a.s.add('asteroid', 0, 'orbit', a.island.x, a.island.y);
    asteroid.ix = a.island.x; asteroid.iy = a.island.y;
    a.s.formOreCache(asteroid, 12.5);
    const impactCache = a.s.oreCaches[0]!;
    const energy = a.s.armies[0]!.energy;
    expect(a.g.apply(SKY, { kind: 'drop_ore', island: id(a.g, a.island) })).toEqual({ ok: true });
    const dropCache = a.s.oreCaches[1]!;
    expect(dropCache.id).not.toBe(a.island.id);
    expect(dropCache.id).not.toBe(impactCache.id);
    expect({ ...dropCache, id: impactCache.id }).toEqual(impactCache);
    expect(a.s.holes.every(hole => hole === 0)).toBe(true);
    expect(a.s.armies[0]!.energy).toBe(energy);
    expect(a.s.armies[0]!.alloy).toBe(1000);
    expect(a.g.apply(SKY, { kind: 'drop_ore', island: id(a.g, a.island) })).toMatchObject({ ok: false });
    expect(a.s.oreCaches).toHaveLength(2);
    const effect = a.g.view('nw').fx.find(f => f.kind === 'deliver' && f.subject === 'ore_extractor')!;
    expect(effect).toMatchObject({ plane: 'surface', x: dropCache.x, y: dropCache.y });
    for (const field of ['src', 'sourceElevation', 'tp', 'tx', 'ty', 'mooringTower']) expect(effect).not.toHaveProperty(field);
  });

  it('lets an opposing Surface army collect through the existing contested cache timer, with no special collector', () => {
    const a = arena();
    a.island.oreBuffer = a.s.econ.oreCacheLoad;
    a.s.dropIslandOre(a.island);
    const cache = a.s.oreCaches[0]!;
    const blue = a.s.add('trooper', 0, 'surface', cache.x, cache.y);
    const red = a.s.add('trooper', 1, 'surface', cache.x, cache.y);
    blue.stance = red.stance = 'hold';
    for (let tick = 0; tick < a.s.econ.oreCacheTicks + 1; tick++) a.s.updateRockGround();
    expect(a.s.armies[0]!.alloy).toBe(1000);
    expect(a.s.armies[1]!.alloy).toBe(1000);
    blue.dead = true;
    for (let tick = 0; tick < a.s.econ.oreCacheTicks; tick++) a.s.updateRockGround();
    expect(a.s.armies[1]!.alloy).toBe(1000 + a.s.econ.oreCacheLoad);
    expect(a.s.armies[0]!.alloy).toBe(1000);
    expect(a.s.oreCaches).toHaveLength(0);
  });

  it('retains released cargo if the Surface has no legal cache cell and uses the ordinary placement retry', () => {
    const a = arena();
    a.island.oreBuffer = 9;
    a.s.block.fill(1);
    a.s.dropIslandOre(a.island);
    const cache = a.s.oreCaches[0]!;
    expect(cache).toMatchObject({ alloy: 9, belowAlloy: 0, placed: false });
    expect(a.island.oreBuffer).toBe(0);
    const cell = 24 * a.s.size + 24;
    a.s.block[cell] = 0;
    a.s.updateRockGround();
    expect(cache).toMatchObject({ alloy: 9, placed: true, x: 24.5, y: 24.5 });
  });
});

describe('Extractor hardpoint construction, capture and retirement', () => {
  for (const main of ISLAND_STRUCTURES) it(`builds independently beside ${main}, without regenerating the deposit`, () => {
    const a = arena();
    a.island.oreRemaining = 111;
    a.island.oreBuffer = 13;
    expect(a.g.apply(SKY, { kind: 'queue_add', item: main, island: id(a.g, a.island) })).toEqual({ ok: true });
    expect(a.g.apply(SKY, { kind: 'queue_add', item: 'ore_extractor', island: id(a.g, a.island) })).toEqual({ ok: true });
    steps(a.g, 2);
    const extractor = a.s.alive(a.island.hardpoint)!;
    expect(extractor.kind).toBe('ore_extractor');
    expect(a.s.alive(a.island.link)!.kind).toBe(main);
    expect(a.island.oreRemaining).toBe(111);
    expect(a.island.oreBuffer).toBe(13);
    expect(a.g.apply(SKY, { kind: 'dismantle', structure: id(a.g, extractor) })).toMatchObject({ ok: false });
    for (let tick = 0; tick <= a.s.stats.ore_extractor.build; tick++) a.s.updateConstruction();
    a.s.updateProduction();
    expect(extractor.built).toBe(true);
    expect(extractor.hp).toBe(250);
    const resources = { alloy: a.s.armies[0]!.alloy, energy: a.s.armies[0]!.energy };
    expect(a.g.apply(SKY, { kind: 'dismantle', structure: id(a.g, extractor) })).toEqual({ ok: true });
    expect(a.island.hardpoint).toBe(0);
    expect(a.island.oreRemaining).toBe(111);
    expect(a.island.oreBuffer).toBe(13);
    expect(a.s.armies[0]).toMatchObject(resources);
    expect(a.g.apply(SKY, { kind: 'queue_add', item: 'ore_extractor', island: id(a.g, a.island) })).toEqual({ ok: true });
    a.s.updateProduction();
    expect(a.s.alive(a.island.hardpoint)!.id).not.toBe(extractor.id);
    expect(a.island.oreRemaining).toBe(111);
    expect(a.island.oreBuffer).toBe(13);
  });

  it('reserves against both weapons, releases cancellation, and enforces ownership, plane, segment and finite ore', () => {
    const a = arena();
    const order = { kind: 'queue_add', item: 'ore_extractor', island: id(a.g, a.island) } as const;
    expect(a.g.apply({ team: 'nw', role: 'surface' }, order)).toMatchObject({ ok: false, code: 'wrong_plane' });
    expect(a.g.apply(ENEMY, { ...order, island: id(a.g, a.island, 'se') })).toMatchObject({ ok: false, code: 'not_held' });
    expect(a.g.apply(SKY, order)).toEqual({ ok: true });
    expect(a.g.apply(SKY, { ...order, item: 'island_mortar' })).toMatchObject({ ok: false, code: 'occupied' });
    const gun = a.s.add('gunship', 0, 'sky', a.island.x, a.island.y);
    expect(a.g.apply(SKY, { kind: 'emplace', unit: id(a.g, gun), island: id(a.g, a.island) })).toMatchObject({ ok: false, code: 'occupied' });
    const entry = a.g.observe(SKY, 0).queue[0]!;
    expect(a.g.apply(SKY, { kind: 'queue_cancel', entry: entry.id })).toEqual({ ok: true });
    expect(a.g.apply(SKY, { kind: 'emplace', unit: id(a.g, gun), island: id(a.g, a.island) })).toEqual({ ok: true });
    expect(a.g.apply(SKY, order)).toMatchObject({ ok: false, code: 'occupied' });
    a.s.kill(a.s.alive(a.island.hardpoint)!);
    a.island.oreRemaining = 0;
    expect(a.g.apply(SKY, order)).toMatchObject({ ok: false, code: 'invalid_target' });
    a.island.oreRemaining = 1;
    a.s.armies[0]!.spire.sky.hp = 0;
    expect(a.g.apply(SKY, order)).toMatchObject({ ok: false, code: 'segment_destroyed' });
  });

  it('preserves undropped cargo through destruction and depleted dismantling without requiring a replacement rig', () => {
    for (const dismantle of [false, true]) {
      const a = arena();
      const extractor = rig(a);
      a.island.oreRemaining = 0;
      a.island.oreBuffer = 7;
      // Red must see the extractor to name it at all; seen, it still cannot dismantle it.
      const sky = a.s.vis[PLANE_INDEX.sky]!, at = cellOf(a.island.x, a.island.y, a.s.size);
      sky[at] = sky[at]! | a.s.armies[1]!.group.bit;
      a.s.noteSightings();
      expect(a.g.apply(ENEMY, { kind: 'dismantle', structure: id(a.g, extractor, 'se') })).toMatchObject({ ok: false });
      if (dismantle) expect(a.g.apply(SKY, { kind: 'dismantle', structure: id(a.g, extractor) })).toEqual({ ok: true });
      else a.s.kill(extractor);
      expect(a.island.hardpoint).toBe(0);
      expect(a.island.oreRemaining).toBe(0);
      expect(a.island.oreBuffer).toBe(7);
      a.s.armies[0]!.energy = 0;
      expect(a.g.apply(SKY, { kind: 'drop_ore', island: id(a.g, a.island) })).toEqual({ ok: true });
      expect(a.s.oreCaches[0]!.alloy).toBe(7);
    }
  });

  it('allows normal capture of an unarmed extractor and transfers remaining ore and cargo to the new owner', () => {
    const a = arena({ captureTime: 0.1 });
    const extractor = rig(a);
    a.island.oreRemaining = 20;
    a.island.oreBuffer = 11;
    const attacker = a.s.add('interceptor', 1, 'sky', a.island.x, a.island.y);
    attacker.order = { k: 'capture', island: a.island.id };
    attacker.stance = 'hold';
    a.s.computeVision();
    for (let tick = 0; tick < 10 && a.island.side !== 1; tick++) a.g.step();
    expect(a.island.side).toBe(1);
    expect(extractor.dead || extractor.hp <= 0).toBe(true);
    expect(a.island.oreRemaining + a.island.oreBuffer).toBeCloseTo(31, 10);
    const inherited = a.island.oreBuffer;
    expect(a.g.apply(SKY, { kind: 'drop_ore', island: id(a.g, a.island) })).toMatchObject({ ok: false, code: 'not_held' });
    expect(a.g.apply(ENEMY, { kind: 'drop_ore', island: id(a.g, a.island, 'se') })).toEqual({ ok: true });
    expect(a.s.oreCaches[0]).toMatchObject({ alloy: inherited, side: 1 });
    expect(a.island.oreBuffer).toBe(0);
  });
});

describe('ore observation boundaries and persistence', () => {
  it('publishes static mineral identity but not unseen reserves, enemy cargo or hidden extractor power', () => {
    const a = arena();
    const extractor = rig(a);
    a.island.oreRemaining = 17;
    a.island.oreBuffer = 3;
    for (const vision of a.s.vis) vision.fill(0);
    const owner = a.g.view('nw').entities.find(e => e.id === id(a.g, a.island))!;
    expect(owner).toMatchObject({ oreCapacity: 240, oreRemaining: 17, oreBuffer: 3 });
    expect(validate(entitySchema, owner).ok).toBe(true);
    const enemy = a.g.view('se');
    const hidden = enemy.entities.find(e => e.id === id(a.g, a.island, 'se'))!;
    expect(hidden.oreCapacity).toBe(240);
    expect(hidden).not.toHaveProperty('oreRemaining');
    expect(hidden).not.toHaveProperty('oreBuffer');
    const path = enemy.islands.find(e => e.id === id(a.g, a.island, 'se'))!;
    expect(path.oreCapacity).toBe(240);
    expect(path).not.toHaveProperty('oreRemaining');
    expect(path).not.toHaveProperty('oreBuffer');
    a.s.vis[PLANE_INDEX.sky]![cellOf(a.island.x, a.island.y, a.s.size)] = a.s.armies[1]!.group.bit;
    a.s.noteSightings();
    const seen = a.g.view('se').entities.find(e => e.id === id(a.g, a.island, 'se'))!;
    expect(seen.oreRemaining).toBe(17);
    expect(seen).not.toHaveProperty('oreBuffer');
    expect(a.g.view('se').entities.find(e => e.id === id(a.g, extractor, 'se'))!).not.toHaveProperty('extractorPowered');
    const surface = a.g.observe({ team: 'se', role: 'surface' }, 0, ['surface']);
    expect(surface.entities.some(e => e.id === id(a.g, a.island, 'se') || e.id === id(a.g, extractor, 'se'))).toBe(false);
    expect(surface).not.toHaveProperty('islands');
    expect(validate(observationSchema, surface).ok).toBe(true);
    expect(validate(matchDataSchema, a.g.matchData(SKY)).ok).toBe(true);
  });

  it('hashes every island resource scalar and independently clones extraction, drop and collection state', () => {
    const a = arena();
    rig(a);
    work(a, 7);
    const base = a.g.stateHash();
    for (const field of ['oreCapacity', 'oreRemaining', 'oreBuffer'] as const) {
      const value = a.island[field];
      a.island[field] = value + 1;
      expect(a.g.stateHash()).not.toBe(base);
      a.island[field] = value;
      expect(a.g.stateHash()).toBe(base);
    }
    const twin = a.g.clone();
    for (let tick = 0; tick < 2 * TICK_RATE; tick++) {
      if (tick === TICK_RATE) {
        expect(a.g.apply(SKY, { kind: 'drop_ore', island: id(a.g, a.island) })).toEqual({ ok: true });
        expect(twin.apply(SKY, { kind: 'drop_ore', island: id(twin, a.island) })).toEqual({ ok: true });
      }
      a.g.step(); twin.step();
      expect(a.g.stateHash()).toBe(twin.stateHash());
      expect(a.g.view('nw')).toEqual(twin.view('nw'));
    }
    const saved = twin.sim.alive(a.island.id)!.oreBuffer;
    a.island.oreBuffer++;
    expect(twin.sim.alive(a.island.id)!.oreBuffer).toBe(saved);
    expect(a.g.stateHash()).not.toBe(twin.stateHash());
  });
});

describe('ore action boundaries and ordinary island rules', () => {
  it('keeps ore release on Sky and demolition on the target plane, preserving the independent hardpoint', () => {
    const a = arena();
    const extractor = rig(a);
    a.island.oreBuffer = 5;
    const surface = { team: 'nw', role: 'surface' } as const;
    expect(a.g.apply(surface, { kind: 'drop_ore', island: id(a.g, a.island) })).toMatchObject({ ok: false, code: 'wrong_plane' });
    expect(a.g.apply(surface, { kind: 'dismantle', structure: id(a.g, extractor) })).toMatchObject({ ok: false, code: 'wrong_plane' });
    const relay = a.s.add('relay', 0, 'sky', a.island.x, a.island.y);
    a.s.armies[0]!.structures++;
    expect(a.g.apply(SKY, { kind: 'dismantle', structure: id(a.g, relay) })).toEqual({ ok: true });
    expect(a.island.oreBuffer).toBe(5);
    expect(a.s.oreCaches).toHaveLength(0);
    expect(extractor.dead).toBe(false);
    expect(relay.dead).toBe(true);
  });

  it('retains deposit state on cancellation and rejects disabled or subsequently depleted reservations', () => {
    const disabled = arena({ islandHardpoints: 0 });
    expect(disabled.g.apply(SKY, { kind: 'queue_add', item: 'ore_extractor', island: id(disabled.g, disabled.island) })).toMatchObject({ ok: false, code: 'blocked' });
    const a = arena();
    expect(a.g.apply(SKY, { kind: 'queue_add', item: 'ore_extractor', island: id(a.g, a.island) })).toEqual({ ok: true });
    a.island.oreRemaining = 0;
    a.island.oreBuffer = 9;
    const energy = a.s.armies[0]!.energy, alloy = a.s.armies[0]!.alloy;
    a.s.updateProduction();
    expect(a.s.armies[0]!.queue[0]!.reason).toBe('blocked');
    expect(a.island.hardpoint).toBe(0);
    expect(a.s.armies[0]).toMatchObject({ energy, alloy });
    const observation = a.g.observe(SKY, 0);
    const validation = validate(observationSchema, observation);
    expect(validation.ok ? true : validation).toBe(true);
    const entry = observation.queue[0]!;
    expect(a.g.apply(SKY, { kind: 'queue_cancel', entry: entry.id })).toEqual({ ok: true });
    expect(a.island).toMatchObject({ oreCapacity: 240, oreRemaining: 0, oreBuffer: 9 });
  });

  it('uses the existing ground-to-island weapon exemption, without granting a weapon or sight', () => {
    for (const enabled of [false, true]) {
      const a = arena({ groundHitsIslandStructures: enabled });
      const extractor = rig(a);
      expect(a.s.groundSpares('flak', extractor)).toBe(!enabled);
      expect(a.s.groundSpares('turret', extractor)).toBe(!enabled);
      expect(a.s.groundSpares('missile', extractor)).toBe(false);
      expect(a.s.armed(extractor)).toBe(false);
      expect(a.s.stats.ore_extractor.vision).toBe(0);
      expect(a.s.capable(extractor, 'spotterDown')).toBe(false);
    }
  });
});
