import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { islandAt, MOORING_DEPTH, MOORING_ISLAND_HEIGHT, SURFACE, TICK_RATE, type ArmyId } from '../src/rules/contract.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';
import type { Sim } from '../src/sim/sim.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);
const seat = { team: 'nw', role: 'surface' } as const;

/** Isolate an existing paid hold from movement, weather income and unrelated consumers. */
function holding(owner = BLUE) {
  const g = createGame({ seed: 9, options: { sky: { stormSets: 0 } } });
  const s = g.sim;
  for (const e of s.ents) if (e.kind !== 'island' && e.kind !== 'spire') e.dead = true;
  const island = s.ents.find(e => e.kind === 'island')!;
  s.setSide(island, owner);
  const tower = s.add('mooring_tower', BLUE, 'surface', 12, 12);
  tower.mooringTarget = island.id;
  tower.mooringGrace = s.econ.mooringGraceTicks;
  island.mooringTower = tower.id;
  island.mooringPhase = 2;
  island.elevation = -MOORING_DEPTH;
  island.mooringAt = -s.econ.mooringTravelTicks;
  s.armies[BLUE]!.energy = 100;
  return { g, s, tower, island, army: s.armies[BLUE]! };
}

describe('Mooring Tower energy and ownership', () => {
  for (const owner of [BLUE, RED, NEUTRAL]) it(`charges the same continuous upkeep for island owner ${owner}`, () => {
    const { s, tower, island, army } = holding(owner);
    const before = army.energy;
    for (let tick = 0; tick < TICK_RATE; tick++) s.economy();
    expect(army.energy).toBeCloseTo(before - s.econ.mooringUpkeep, 8);
    expect(army.upkeep).toBe(s.econ.mooringUpkeep);
    expect(tower.mooringGrace).toBe(s.econ.mooringGraceTicks);
    expect(island.side).toBe(owner);
    expect(island.mooringPhase).toBe(2);
  });

  it('adds upkeep per tower rather than enforcing an army-wide hold cap', () => {
    const { s, army } = holding();
    const other = s.ents.filter(e => e.kind === 'island')[1]!;
    const tower = s.add('mooring_tower', BLUE, 'surface', 18, 12);
    tower.mooringTarget = other.id;
    tower.mooringGrace = s.econ.mooringGraceTicks;
    other.mooringTower = tower.id;
    other.mooringPhase = 2;
    const before = army.energy;
    s.economy();
    expect(army.upkeep).toBe(2 * s.econ.mooringUpkeep);
    expect(army.energy).toBeCloseTo(before - 2 * s.econ.mooringUpkeep / TICK_RATE, 8);
  });

  it('never renews unpaid grace on power flicker and collects arrears on recovery', () => {
    const { s, tower, island, army } = holding();
    const due = s.econ.mooringUpkeep / TICK_RATE;
    for (let tick = 0; tick < s.econ.mooringGraceTicks - 1; tick++) {
      army.energy = 0;
      s.economy();
      expect(tower.mooringDebt).toBeCloseTo(due, 8);
      const left = tower.mooringGrace;
      army.energy = 10;
      s.economy();
      expect(army.energy).toBeCloseTo(10 - 2 * due, 8);
      expect(tower.mooringDebt).toBe(0);
      expect(tower.mooringGrace).toBe(left);
    }
    army.energy = 0;
    s.economy();
    expect(tower.mooringGrace).toBe(0);
    expect(island.mooringPhase).toBe(3);
    expect(tower.mooringTarget).toBe(0);
    expect(tower.mooringDebt).toBeGreaterThan(0);
  });

  it('tower destruction immediately starts release, without changing island ownership or slots', () => {
    const { s, tower, island } = holding(RED);
    const relay = s.add('relay', RED, 'sky', island.x, island.y);
    island.link = relay.id;
    relay.link = island.id;
    s.kill(tower);
    expect(island.mooringPhase).toBe(3);
    expect(island.mooringTower).toBe(0);
    expect(island.side).toBe(RED);
    expect(island.link).toBe(relay.id);
    expect(relay.dead).toBe(false);
  });

  it('capturing an island does not transfer or release another army’s tower control', () => {
    const { g, s, tower, island } = holding();
    s.captureIsland(island, RED);
    expect(island.side).toBe(RED);
    expect(island.mooringTower).toBe(tower.id);
    expect(island.mooringPhase).toBe(2);
    // Red must see the tower to name it at all; seen, it is still not Red's to release.
    s.add('trooper', RED, 'surface', tower.x, tower.y + 1);
    s.computeVision();
    expect(g.apply({ team: 'se', role: 'surface' }, { kind: 'unmoor', tower: g.entityId('se', tower.id) })).toEqual({ ok: false, code: 'invalid_target' });
    expect(g.apply(seat, { kind: 'unmoor', tower: g.entityId('nw', tower.id) })).toEqual({ ok: true });
    expect(island.mooringPhase).toBe(3);
  });

  it('does not expose private tower targeting or grace through a public island', () => {
    const { g, s, tower, island } = holding();
    tower.x = tower.y = 4;
    s.add('interceptor', BLUE, 'sky', island.x, island.y);
    s.computeVision();
    expect(s.sees(RED, tower)).toBe(false);
    const hostile = g.observe({ team: 'se' as ArmyId, role: 'sky' }, 0);
    const publicIsland = hostile.entities.find(e => e.id === g.entityId('se', island.id))!;
    expect(publicIsland.mooringState).toBe('held');
    expect(publicIsland.mooringTower).toBeUndefined();
    expect(publicIsland.mooringGrace).toBeUndefined();
    const own = g.observe(seat, 0).entities.find(e => e.id === g.entityId('nw', tower.id))!;
    expect(own.mooringTarget).toBe(g.entityId('nw', island.id));
    expect(own.mooringGrace).toBe(s.econ.mooringGraceTicks);
    expect(own.mooringPowered).toBe(true);
  });
});

/** Real catch, with a Sky scout explicitly following only its selected island. */
function catching(slot = 0, sides: 2 | 4 = 2, owner = NEUTRAL) {
  const g = createGame({ seed: 9, options: { map: { params: { slots: sides } }, sky: { stormSets: 0, fogRadius: 0, jetWidth: 0 } } });
  const s = g.sim;
  for (const e of s.ents) if (e.unit) e.dead = true;
  const island = s.ents.filter(e => e.kind === 'island')[slot]!;
  s.setSide(island, owner);
  const team = s.armyIds[slot]!;
  const tower = s.add('mooring_tower', slot, 'surface', island.x, island.y);
  const scout = s.add('interceptor', slot, 'sky', island.x, island.y);
  scout.order = { k: 'capture', island: island.id };
  scout.stance = 'hold';
  s.armies[slot]!.energy = 1e6;
  s.computeVision();
  const who = { team, role: 'surface' } as const;
  expect(g.apply(who, { kind: 'moor', tower: g.entityId(team, tower.id), island: g.entityId(team, island.id) })).toEqual({ ok: true });
  g.step();
  expect(island.mooringPhase).toBe(1);
  return { g, s, island, tower, scout, who };
}

/** Exercise actual island motion/capture and economy without unrelated combat over a full ring period. */
function motion(s: Sim): void {
  s.tick++;
  s.updateIslands();
  s.economy();
}

function safeIslands(s: Sim): void {
  const islands = s.ents.filter(e => e.kind === 'island');
  for (let i = 0; i < islands.length; i++) for (let j = i + 1; j < islands.length; j++) {
    const a = islands[i]!, b = islands[j]!;
    if (Math.abs(a.elevation - b.elevation) < MOORING_ISLAND_HEIGHT - 1e-7) {
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(s.rules.map.islandClearance - 1e-7);
    }
  }
}

describe('Mooring Tower physical transitions', () => {
  it('lowers without horizontal dragging, permits a full ordinary orbit overhead, then rejoins the delayed circle', () => {
    const { g, s, island, tower, who } = catching();
    const at = { x: island.x, y: island.y };
    let prior = island.elevation;
    for (let tick = 0; tick < s.econ.mooringTravelTicks; tick++) {
      motion(s);
      expect(island.elevation).toBeLessThanOrEqual(prior);
      expect(prior - island.elevation).toBeLessThanOrEqual(MOORING_DEPTH / s.econ.mooringTravelTicks + 1e-9);
      expect({ x: island.x, y: island.y }).toEqual(at);
      safeIslands(s);
      prior = island.elevation;
    }
    expect(island.elevation).toBe(-MOORING_DEPTH);
    expect(island.mooringPhase).toBe(2);
    const other = s.ents.find(e => e.kind === 'island' && e !== island && e.orbitR === island.orbitR)!;
    let passed = false;
    const period = Math.ceil(Math.PI * 2 / Math.abs(other.orbitW));
    for (let tick = 0; tick < period; tick++) {
      motion(s);
      safeIslands(s);
      if (Math.hypot(other.x - island.x, other.y - island.y) < 1) passed = true;
    }
    expect(passed).toBe(true);
    expect(island.mooringPhase).toBe(2);
    expect({ x: island.x, y: island.y }).toEqual(at);
    expect(g.apply(who, { kind: 'unmoor', tower: g.entityId(who.team, tower.id) })).toEqual({ ok: true });
    for (let tick = 0; tick < period && island.mooringPhase; tick++) { motion(s); safeIslands(s); }
    expect(island.mooringPhase).toBe(0);
    expect(island.elevation).toBe(0);
    expect({ x: island.x, y: island.y }).toEqual(at);
    expect(island.mooringReadyAt).toBe(s.tick + s.econ.mooringCooldown);
    expect(g.apply(who, { kind: 'moor', tower: g.entityId(who.team, tower.id), island: g.entityId(who.team, island.id) })).toMatchObject({ ok: false, code: 'cooldown' });
    const path = g.observe({ team: who.team, role: 'sky' }, 0).islands.find(p => p.id === g.entityId(who.team, island.id))!;
    motion(s);
    expect(islandAt(path, s.tick).x).toBeCloseTo(island.x, 7);
    expect(islandAt(path, s.tick).y).toBeCloseTo(island.y, 7);
    expect(Math.hypot(island.x - at.x, island.y - at.y)).toBeLessThanOrEqual(Math.abs(island.orbitW) * island.orbitR + 1e-7);
  });

  it('does not let two towers lower overlapping berths, and a released island waits below passing traffic', () => {
    const { g, s, island, tower, who } = catching();
    const other = s.ents.find(e => e.kind === 'island' && e !== island && e.orbitR === island.orbitR)!;
    const period = Math.ceil(Math.PI * 2 / Math.abs(other.orbitW));
    for (let tick = 0; tick < period && (island.mooringPhase !== 2 || Math.hypot(other.x - island.x, other.y - island.y) > 1); tick++) motion(s);
    expect(Math.hypot(other.x - island.x, other.y - island.y)).toBeLessThanOrEqual(1);
    const second = s.add('mooring_tower', 0, 'surface', tower.x + 3, tower.y);
    s.computeVision();
    expect(g.apply(who, { kind: 'moor', tower: g.entityId(who.team, second.id), island: g.entityId(who.team, other.id) })).toEqual({ ok: true });
    motion(s);
    expect(other.mooringPhase).toBe(0);
    expect(second.mooringTarget).toBe(other.id);
    expect(g.apply(who, { kind: 'unmoor', tower: g.entityId(who.team, tower.id) })).toEqual({ ok: true });
    motion(s);
    expect(island.mooringPhase).toBe(3);
    expect(island.mooringRiseAt).toBe(-1);
    expect(island.elevation).toBe(-MOORING_DEPTH);
    for (let tick = 0; tick < period && island.mooringPhase; tick++) { motion(s); safeIslands(s); }
    expect(island.mooringPhase).toBe(0);
  });

  it('finishes an early released descent before returning, rather than reversing into the reserved traffic window', () => {
    const { g, s, island, tower, who } = catching();
    for (let tick = 0; tick < 10; tick++) motion(s);
    const height = island.elevation;
    expect(g.apply(who, { kind: 'unmoor', tower: g.entityId(who.team, tower.id) })).toEqual({ ok: true });
    motion(s);
    expect(island.elevation).toBeLessThan(height);
    expect(island.mooringTower).toBe(0);
    expect(tower.mooringTarget).toBe(0);
    for (let tick = 0; tick < 3 * s.econ.mooringTravelTicks && island.mooringPhase; tick++) { motion(s); safeIslands(s); }
    expect(island.mooringPhase).toBe(0);
  });

  for (const sides of [2, 4] as const) it(`keeps C${sides} rotated catches and returns tick-identical`, () => {
    const histories: number[][] = [];
    for (let slot = 0; slot < sides; slot++) {
      const { g, s, island, tower, who } = catching(slot, sides);
      const history: number[] = [];
      for (let tick = 0; tick < 200; tick++) {
        if (tick === 100) expect(g.apply(who, { kind: 'unmoor', tower: g.entityId(who.team, tower.id) })).toEqual({ ok: true });
        motion(s);
        history.push(island.mooringPhase, island.elevation, island.orbitDelay, island.mooringReadyAt);
        safeIslands(s);
      }
      histories.push(history);
    }
    for (const history of histories.slice(1)) expect(history).toEqual(histories[0]);
  });

  it('descends before capture or hangar entry and climbs on departure without changing plane', () => {
    const { g, s, island, tower, who } = catching();
    for (let tick = 0; tick < s.econ.mooringTravelTicks; tick++) g.step();
    const aerie = s.add('aerie', 0, 'sky', island.x, island.y);
    aerie.link = island.id;
    aerie.elevation = island.elevation;
    island.link = aerie.id;
    const air = s.add('interceptor', 0, 'sky', island.x + 1, island.y);
    air.stance = 'hold';
    expect(g.apply({ team: who.team, role: 'sky' }, { kind: 'hangar', units: [g.entityId(who.team, air.id)], target: g.entityId(who.team, aerie.id) })).toEqual({ ok: true });
    expect(air.hangar).toBe(0);
    expect(air.order.k).toBe('hangar');
    for (let tick = 0; tick < s.econ.mooringTravelTicks + 5; tick++) g.step();
    expect(air.hangar).toBe(aerie.id);
    expect(air.elevation).toBe(-MOORING_DEPTH);
    expect(g.apply({ team: who.team, role: 'sky' }, { kind: 'launch', units: [g.entityId(who.team, air.id)] })).toEqual({ ok: true });
    for (let tick = 0; tick < s.econ.aerieLaunchTicks; tick++) g.step();
    expect(air.hangar).toBe(0);
    expect(g.apply({ team: who.team, role: 'sky' }, { kind: 'move', units: [g.entityId(who.team, air.id)], x: 2, y: 2 })).toEqual({ ok: true });
    const before = air.elevation;
    g.step();
    expect(air.elevation).toBeGreaterThan(before);
    expect(air.elevation).toBeLessThan(0);
    expect(air.plane).toBe('sky');
    expect(tower.mooringTarget).toBe(island.id);
  });
});

describe('Mooring Tower acquisition boundaries', () => {
  for (const owner of [BLUE, RED, NEUTRAL]) it(`accepts a visible island owned by ${owner} without transferring its ownership`, () => {
    const { island, tower } = catching(0, 2, owner);
    expect(island.side).toBe(owner);
    expect(island.mooringTower).toBe(tower.id);
    expect(island.link).toBe(0);
    expect(island.hardpoint).toBe(0);
  });

  it('waits rather than starting a descent that the following island would hit', () => {
    const g = createGame({ seed: 9, options: { sky: { stormSets: 0, fogRadius: 0, jetWidth: 0 } } });
    const s = g.sim;
    for (const e of s.ents) if (e.unit) e.dead = true;
    const islands = s.ents.filter(e => e.kind === 'island');
    const island = islands[0]!, follower = islands[1]!;
    const gap = 2 * Math.asin((s.rules.map.islandClearance + 0.1) / (2 * island.orbitR));
    let delay = (Math.PI + Math.sign(island.orbitW) * gap) / island.orbitW;
    if (delay < 0) delay += Math.PI * 2 / Math.abs(island.orbitW);
    follower.orbitDelay = Math.round(delay);
    s.placeIsland(follower);
    const tower = s.add('mooring_tower', BLUE, 'surface', island.x, island.y);
    const scout = s.add('interceptor', BLUE, 'sky', island.x, island.y);
    scout.order = { k: 'capture', island: island.id };
    s.armies[BLUE]!.energy = 100;
    s.computeVision();
    expect(Math.hypot(island.x - follower.x, island.y - follower.y)).toBeGreaterThan(s.rules.map.islandClearance);
    expect(g.apply(seat, { kind: 'moor', tower: g.entityId('nw', tower.id), island: g.entityId('nw', island.id) })).toEqual({ ok: true });
    for (let tick = 0; tick < 10; tick++) {
      motion(s);
      expect(island.mooringPhase).toBe(0);
      expect(island.elevation).toBe(0);
      safeIslands(s);
    }
    expect(tower.mooringTarget).toBe(island.id);
  });

  it('rejects hidden targets, a competing held target, busy-tower retargeting and disabled construction', () => {
    const { g, s, island, tower } = catching();
    const hidden = s.ents.find(e => e.kind === 'island' && !s.seesCell(BLUE, 'sky', Math.floor(e.y) * s.size + Math.floor(e.x)))!;
    expect(hidden).toBeDefined();
    const other = s.add('mooring_tower', BLUE, 'surface', tower.x + 3, tower.y);
    expect(g.apply(seat, { kind: 'moor', tower: g.entityId('nw', other.id), island: g.entityId('nw', hidden.id) })).toEqual({ ok: false, code: 'invalid_target' });
    expect(g.apply(seat, { kind: 'moor', tower: g.entityId('nw', other.id), island: g.entityId('nw', island.id) })).toEqual({ ok: false, code: 'cooldown' });
    expect(g.apply(seat, { kind: 'moor', tower: g.entityId('nw', tower.id), island: g.entityId('nw', island.id) })).toEqual({ ok: false, code: 'cooldown' });
    const disabled = createGame({ seed: 9, options: { surface: { mooringEnabled: false } } });
    expect(disabled.apply(seat, { kind: 'queue_add', item: 'mooring_tower', x: 10, y: 10 })).toEqual({ ok: false, code: 'blocked' });
  });
});

describe('vertical island capture selection', () => {
  it('retains incidental capture while travelling toward another ordinary island', () => {
    const { sim: s } = createGame({ seed: 9, options: { sky: { stormSets: 0 } } });
    for (const e of s.ents) if (e.unit) e.dead = true;
    const islands = s.ents.filter(e => e.kind === 'island');
    const nearby = islands[0]!;
    const destination = islands[1]!;
    const air = s.add('interceptor', BLUE, 'sky', nearby.x, nearby.y);
    air.order = { k: 'capture', island: destination.id };
    s.econ.captureTicks = 1;
    motion(s);
    expect(nearby.side).toBe(BLUE);
    expect(destination.side).toBe(NEUTRAL);
    expect(air.elevation).toBe(0);
  });

  it('a descent to a selected lower island never captures the overlapping upper island', () => {
    const { s, island } = holding(NEUTRAL);
    const upper = s.ents.find(e => e.kind === 'island' && e !== island && e.orbitR === island.orbitR)!;
    // This is the ordinary ring partner passing over an indefinitely held island.
    upper.orbitDelay = Math.round(Math.PI / Math.abs(upper.orbitW));
    s.placeIsland(upper);
    s.econ.captureTicks = 1;
    const air = s.add('interceptor', BLUE, 'sky', island.x, island.y);
    air.order = { k: 'capture', island: island.id };
    expect(Math.hypot(upper.x - island.x, upper.y - island.y)).toBeLessThan(0.1);
    motion(s);
    expect(air.elevation).toBeLessThan(0);
    expect(air.elevation).toBeGreaterThan(-MOORING_DEPTH);
    expect(island.side).toBe(NEUTRAL);
    expect(upper.side).toBe(NEUTRAL);
    for (let tick = 0; tick < s.econ.mooringTravelTicks; tick++) {
      motion(s);
      expect(upper.side).toBe(NEUTRAL);
    }
    expect(island.side).toBe(BLUE);
    expect(air.elevation).toBe(-MOORING_DEPTH);
  });
});

describe('Mooring Tower construction', () => {
  it('funds and completes an ordinary visible 2×2 Surface queue site without taking an island slot', () => {
    const g = createGame({ seed: 9, options: { surface: { buildRadiusSpire: 80 }, sky: { stormSets: 0 } } });
    const s = g.sim;
    for (const e of s.ents) if (e.unit) e.dead = true;
    for (let y = 19; y <= 22; y++) for (let x = 19; x <= 22; x++) {
      const cell = y * s.size + x;
      s.terrain[cell] = SURFACE.ground;
      s.holes[cell] = s.block[cell] = 0;
    }
    // A ground observer outside this prepared clearing can be occluded by the
    // generated cliffs. Use real downward sight over the entire footprint.
    const scout = s.add('bomber', BLUE, 'sky', 21, 21);
    scout.stance = 'hold';
    s.armies[BLUE]!.alloy = s.armies[BLUE]!.energy = 1000;
    s.computeVision();
    for (let y = 20; y <= 21; y++) for (let x = 20; x <= 21; x++) {
      expect(s.seesCell(BLUE, 'surface', y * s.size + x)).toBe(true);
    }
    expect(g.apply(seat, { kind: 'queue_add', item: 'mooring_tower', x: 20, y: 20 })).toEqual({ ok: true });
    g.step();
    const tower = s.ents.find(e => e.kind === 'mooring_tower')!;
    expect(tower).toMatchObject({ plane: 'surface', x: 21, y: 21, built: false });
    expect(g.apply(seat, { kind: 'moor', tower: g.entityId('nw', tower.id), island: g.entityId('nw', s.ents.find(e => e.kind === 'island')!.id) })).toMatchObject({ ok: false });
    for (let tick = 0; tick < s.stats.mooring_tower.build; tick++) g.step();
    expect(tower.built).toBe(true);
    expect(tower.hp).toBe(tower.maxHp);
    expect(s.ents.filter(e => e.kind === 'island').every(e => e.link !== tower.id && e.hardpoint !== tower.id)).toBe(true);
    expect(s.armies[BLUE]!.queue.some(e => e.item === 'mooring_tower')).toBe(false);
  });
});
