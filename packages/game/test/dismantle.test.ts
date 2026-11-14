import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { CELL, STRUCTURE_KINDS, type Plane, type StructureKind } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';
import { GOAL_HAUL } from '../src/sim/constants.ts';
import { cellOfEnt } from '../src/util/grid.ts';

const id = (g: AgentCommandGame, e: Ent) => g.entityId('nw', e.id);
function fixture() {
  const g = createGame({ seed: 31, options: { terrain: 'open', spire: { dmg: 0 }, sky: { stormSets: 0 }, orbit: { maxAsteroids: 0, derelictEnabled: false } } });
  const s = g.sim, army = s.armies[0]!;
  army.alloy = army.energy = 10000;
  const island = s.ents.find(e => e.kind === 'island')!;
  s.setSide(island, 0);
  const build = (kind: Exclude<StructureKind, 'spire'>) => {
    const plane = s.stats[kind].plane;
    const e = s.add(kind, 0, plane, plane === 'sky' ? island.x : 14.5, plane === 'sky' ? island.y : 14.5);
    e.built = true; e.hp = e.maxHp; e.state = 'active'; e.progress = -1;
    army.structures++;
    return e;
  };
  const destroy = (e: Ent, role: Plane = e.plane) => g.apply({ team: 'nw', role }, { kind: 'dismantle', structure: id(g, e) });
  return { g, s, army, island, build, destroy };
}

describe('owned structure demolition', () => {
  it('accepts every non-Spire structure registry kind without refund or hostile kill credit, exactly once', () => {
    for (const kind of STRUCTURE_KINDS) {
      if (kind === 'spire') continue;
      const { s, army, build, destroy } = fixture();
      const e = build(kind);
      const count = army.structures, lost = army.stats.structuresLost;
      const alloy = army.alloy, energy = army.energy, kills = s.armies[1]!.stats.kills;
      e.lastHitBy = 1; e.lastHitKind = 'tank'; e.lastHitPlane = 'surface';
      expect(destroy(e), kind).toEqual({ ok: true });
      expect(e.dead).toBe(true);
      expect(army.structures).toBe(count - 1);
      expect(army.stats.structuresLost).toBe(lost + 1);
      expect([army.alloy, army.energy]).toEqual([alloy, energy]);
      expect(s.armies[1]!.stats.kills).toBe(kills);
      const death = s.fx.at(-1)!;
      expect(death.fx.kind).toBe('death');
      expect(death.killer).toBeUndefined();
      expect(death.cause).toBe('dismantle');
      expect(destroy(e)).toMatchObject({ ok: false, code: 'invalid_target' });
      s.kill(e); s.removeSite(e); s.cleanup();
      expect(army.structures).toBe(count - 1);
      expect(army.stats.structuresLost).toBe(lost + 1);
    }
  });

  it('revalidates existence, owner, plane, protected kinds and construction at execution', () => {
    const { g, s, army, island, build, destroy } = fixture();
    const turret = build('turret');
    expect(destroy(turret, 'sky')).toMatchObject({ ok: false, code: 'wrong_plane' });
    turret.built = false;
    expect(destroy(turret)).toMatchObject({ ok: false, code: 'blocked' });
    turret.built = true;
    s.setSide(turret, 1);
    s.computeVision();
    expect(destroy(turret).ok).toBe(false);
    s.setSide(turret, 0);
    for (const e of [army.spire.surface, island, s.ents.find(e => e.kind === 'post')!, s.add('solar', 0, 'orbit', 10, 10), s.add('tank', 0, 'surface', 10, 10)]) {
      expect(destroy(e).ok, e.kind).toBe(false);
      expect(e.dead).toBe(false);
    }
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'dismantle', structure: 'e_999999' })).toMatchObject({ ok: false, code: 'invalid_target' });
    expect(turret.dead).toBe(false);
  });

  it('rejects a nonhostile other army, independently of hostility or shared visibility', () => {
    const { g, s } = fixture();
    // Shared-colour matches are not enabled yet; exercise the existing nonhostile visibility seam.
    s.hostileMask[0] = s.hostileMask[1] = 0;
    const turret = s.add('turret', 1, 'surface', 12, 12);
    expect(s.hostile(0, 1)).toBe(false);
    s.computeVision();
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'dismantle', structure: id(g, turret) })).toEqual({ ok: false, code: 'not_your_unit' });
    expect(turret.dead).toBe(false);
  });

  it('frees both independent island slots without deleting reserves, cargo or paying a cache', () => {
    const { g, s, island, build, destroy } = fixture();
    const relay = build('relay'), extractor = build('ore_extractor');
    relay.link = extractor.link = island.id;
    island.link = relay.id; island.hardpoint = extractor.id;
    island.oreCapacity = 240; island.oreRemaining = 111; island.oreBuffer = 17;
    expect(destroy(relay)).toEqual({ ok: true });
    expect(island.link).toBe(0); expect(island.hardpoint).toBe(extractor.id);
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'relay', island: id(g, island) })).toEqual({ ok: true });
    expect(destroy(extractor)).toEqual({ ok: true });
    expect(island.hardpoint).toBe(0);
    expect([island.oreRemaining, island.oreBuffer]).toEqual([111, 17]);
    expect(s.oreCaches).toHaveLength(0);
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'ore_extractor', island: id(g, island) })).toEqual({ ok: true });
  });

  it('releases a moored island physically and ends seeded weather on the normal update', () => {
    const { s, island, build, destroy } = fixture();
    const tower = build('mooring_tower');
    tower.mooringTarget = island.id; island.mooringTower = tower.id;
    island.mooringPhase = 2; island.elevation = -8;
    const position = [island.x, island.y, island.elevation];
    expect(destroy(tower)).toEqual({ ok: true });
    expect(island.mooringPhase).toBe(3); expect(island.mooringTower).toBe(0);
    expect([island.x, island.y, island.elevation]).toEqual(position);
    expect(island.side).toBe(0);
    for (const warning of [false, true]) {
      const seeder = build('storm_seeder');
      seeder.activeUntil = s.tick + s.econ.seederDuration + (warning ? s.econ.seederTelegraph : 0);
      s.updateWeather();
      expect(s.weather.data.seeded.length + s.weather.data.seedWarnings.length).toBe(1);
      expect(destroy(seeder)).toEqual({ ok: true });
      s.updateWeather();
      expect(s.weather.data.seeded.length + s.weather.data.seedWarnings.length).toBe(0);
    }
  });

  it('evacuates hangared aircraft and strands paid/unpaid producer work without a demolition refund', () => {
    const { s, army, island, build, destroy } = fixture();
    const aerie = build('aerie'); aerie.link = island.id; island.link = aerie.id;
    const air = s.add('bomber', 0, 'sky', island.x, island.y);
    s.houseAircraft(air, aerie);
    const paid = s.queueAdd(0, 'sky', 'interceptor', { producer: aerie.id });
    const waiting = s.queueAdd(0, 'sky', 'bomber', { producer: aerie.id });
    s.updateProduction();
    expect(paid.started).toBe(true); expect(waiting.started).toBe(false);
    const hp = air.hp, alloy = army.alloy, energy = army.energy, left = paid.left;
    expect(destroy(aerie)).toEqual({ ok: true });
    s.updateHangars(); s.updateProduction();
    expect(air.hangar).toBe(0); expect(air.hp).toBe(hp * s.econ.aerieLossHealth);
    expect(air.state).toBe('idle');
    expect(paid).toMatchObject({ status: 'blocked', reason: 'producer', left });
    expect(waiting).toMatchObject({ status: 'blocked', reason: 'producer', started: false });
    expect([army.alloy, army.energy]).toEqual([alloy, energy]);
    s.queueCancel(0, 'sky', 0);
    expect(army.alloy).toBe(alloy + s.stats.interceptor.alloy * s.econ.queueRefund);
  });

  it('releases Drill Yard trainees as troopers without refunding paid conversion', () => {
    const { s, army, build, destroy } = fixture();
    const yard = build('drill_yard'), trooper = s.add('trooper', 0, 'surface', yard.x, yard.y);
    s.order(trooper, { k: 'convert', yard: yard.id, at: true });
    s.updateConversions();
    expect(trooper.hangar).toBe(yard.id);
    const alloy = army.alloy, energy = army.energy;
    expect(destroy(yard)).toEqual({ ok: true });
    s.updateConversions();
    expect(trooper).toMatchObject({ kind: 'trooper', hangar: 0, state: 'idle', dead: false });
    expect(trooper.order.k).toBe('none');
    expect([army.alloy, army.energy]).toEqual([alloy, energy]);
  });
  it('removes dropoffs without paying carried ore and invalidates hauling paths to the lost site', () => {
    for (const kind of ['shaft', 'headframe'] as const) {
      const { s, army, build, destroy } = fixture();
      const site = build(kind), c = cellOfEnt(site, s.size);
      s.cells[c] = CELL.tunnel; army.group.known[c] = CELL.tunnel;
      s.refreshDrops(); expect(army.drop[c]).toBe(1);
      const digger = s.add('digger', 0, 'depths', c % s.size + 0.5, Math.floor(c / s.size) + 0.5);
      digger.carry = 7; digger.path = [c]; digger.pathI = 0; digger.navGoal = GOAL_HAUL;
      const alloy = army.alloy;
      expect(destroy(site)).toEqual({ ok: true });
      expect(army.drop[c]).toBe(0);
      s.updateMine(digger, { k: 'mine', ore: c, exploring: false, near: -1 });
      expect(digger.carry).toBe(7); expect(army.alloy).toBe(alloy);
      expect(digger.path).toBeNull();
    }
  });

  it('clears bulkhead gates and rebuilds freed structure footprints on the next tick', () => {
    const { g, s, build, destroy } = fixture();
    const gate = build('bulkhead'), c = cellOfEnt(gate, s.size);
    gate.cell = c; s.bulkheadAt[c] = gate.id; s.gate[c] = s.hostileMask[0]!;
    const version = s.depthsVersion;
    expect(destroy(gate)).toEqual({ ok: true });
    expect(s.gate[c]).toBe(0); expect(s.bulkheadAt[c]).toBe(0);
    expect(s.depthsVersion).toBeGreaterThan(version);
    const turret = build('turret');
    g.step();
    const cell = cellOfEnt(turret, s.size);
    expect(s.surfaceBodies[cell]).not.toBe(0);
    expect(destroy(turret)).toEqual({ ok: true });
    expect(s.footprintsDirty).toBe(true);
    g.step();
    expect(s.surfaceBodies[cell]).toBe(0);
    expect(s.alive(turret.id)).toBeUndefined();
  });
});
