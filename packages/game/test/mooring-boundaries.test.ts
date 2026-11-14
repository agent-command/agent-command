import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { entityOut } from '../src/agent/present.ts';
import { TICK_RATE, type MatchOptions } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';
import type { Sim } from '../src/sim/sim.ts';
import { cellOf } from '../src/util/grid.ts';

/** Keep real Spires and islands, but remove starting scouts and uncontrolled weather. */
function arena(sky: MatchOptions['sky'] = {}) {
  const game = createGame({ seed: 7, options: { terrain: 'open', sky: {
    stormSets: 0, fogRadius: 0, jetWidth: 0, ...sky,
  } } });
  for (const e of game.sim.ents) if (e.unit) e.dead = true;
  for (const army of game.sim.armies) army.alloy = army.energy = 5000;
  return game;
}

function aircraft(sim: Sim, side: number, x: number, y: number, elevation = -8): Ent {
  const e = sim.add('interceptor', side, 'sky', x, y);
  e.built = true;
  e.elevation = elevation;
  e.stance = 'hold';
  e.cd = 100000;
  return e;
}

/** Use the actual weather lifecycle with a mature, stationary storm. */
function storm(sim: Sim, x: number, y: number): void {
  for (const c of [...sim.weather.data.forecast, ...sim.weather.data.storms]) {
    c.originX = x;
    c.originY = y;
    c.dx = c.dy = 0;
    c.maxRadius = sim.econ.stormRadius;
    c.start = c.grown = 0;
    c.breaking = 1000000;
    c.end = 1000001;
  }
  sim.weather.update(sim.tick);
  sim.weather.refreshMask();
}

function islandAt(sim: Sim, x: number, y: number): Ent {
  const island = sim.ents.find(e => e.kind === 'island')!;
  island.x = x;
  island.y = y;
  island.elevation = -8;
  island.mooringPhase = 2;
  return island;
}

describe('mooring preserves planar weather and sight', () => {
  it('damages and slows lowered aircraft exactly like normal Sky aircraft, not Surface bodies', () => {
    const { sim } = arena({ stormSets: 1, stormRadius: 7 });
    storm(sim, 24, 24);
    const low = aircraft(sim, 0, 23, 24);
    const high = aircraft(sim, 0, 25, 24, 0);
    const ground = sim.add('tank', 0, 'surface', 24, 24);
    ground.stance = 'hold';
    const relay = sim.add('relay', 0, 'sky', 24, 25);
    relay.built = true;
    relay.elevation = -8;
    const hp = low.hp;
    expect(sim.airborne(low)).toBe(true);
    expect(sim.stormHarm(low)).toBeGreaterThan(0);
    expect(sim.speedOf(low, 1, 0)).toBe(sim.baseSpeed(low) * sim.econ.stormSpeed);
    expect(sim.speedOf(low, 1, 0)).toBe(sim.speedOf(high, 1, 0));
    sim.step();
    expect(low.hp).toBeCloseTo(hp - sim.econ.stormDps / TICK_RATE, 10);
    expect(low.hp).toBe(high.hp);
    expect(low.plane).toBe('sky');
    expect(ground.hp).toBe(ground.maxHp);
    expect(relay.hp).toBe(relay.maxHp);
  });

  it('keeps lowered island attachments and aircraft concealed by Sky storms, including from ground fire', () => {
    const game = arena({ stormSets: 1, stormRadius: 5, stormDps: 0 });
    const sim = game.sim;
    storm(sim, 24, 24);
    const island = islandAt(sim, 24, 24);
    const relay = sim.add('relay', 1, 'sky', 24, 24);
    relay.built = true;
    relay.link = island.id;
    relay.elevation = -8;
    island.link = relay.id;
    const low = aircraft(sim, 1, 24, 24);
    const flak = sim.add('flak', 0, 'surface', 24, 26);
    flak.built = true;
    aircraft(sim, 0, 30, 24, 0);
    sim.computeVision();
    expect(sim.sees(0, island)).toBe(true); // Island routes remain public, not Surface vision.
    for (const target of [relay, low]) {
      expect(sim.sees(0, target)).toBe(false);
      expect(game.view('nw').entities.some(e => e.id === `e_${sim.aliasOf(0, target.id)}`)).toBe(false);
    }
    expect(sim.lineOfFire(flak, low)).toBe(false);
    sim.scan(0, 24, 24);
    for (const target of [relay, low]) expect(sim.sees(0, target)).toBe(true);
    expect(sim.lineOfFire(flak, low)).toBe(true);
  });

  it('does not grant Surface observers sight of lowered aircraft or put islands into Surface observations', () => {
    const game = arena();
    const sim = game.sim;
    const island = islandAt(sim, 24, 24);
    const low = aircraft(sim, 1, 24, 24);
    const scout = sim.add('tank', 0, 'surface', 24, 25);
    scout.built = true;
    sim.computeVision();
    expect(sim.seesCell(0, 'surface', cellOf(24, 24, sim.size))).toBe(true);
    expect(sim.sees(0, low)).toBe(false);
    const surface = game.observe({ team: 'nw', role: 'surface' }, 0, ['surface']);
    expect(surface.entities.some(e => e.id === game.entityId('nw', island.id) || e.id === `e_${sim.aliasOf(0, low.id)}`)).toBe(false);
    const sky = game.observe({ team: 'nw', role: 'sky' }, 0, ['sky']);
    expect(sky.entities.find(e => e.id === game.entityId('nw', island.id))).toMatchObject({ plane: 'sky', elevation: -8 });
    // Lowering an interceptor is not a new downward-looking capability either.
    scout.dead = true;
    low.side = 0;
    const enemy = sim.add('tank', 1, 'surface', 24, 24);
    sim.computeVision();
    expect(sim.sees(0, enemy)).toBe(false);
  });

  it('still shortens lowered aircraft vision in the original planar fog bank', () => {
    const { sim } = arena({ fogRadius: 7, fogPathRadius: 0, fogVision: 0.25 });
    const fog = sim.weather.data.fog[0]!;
    const source = aircraft(sim, 0, fog.x, fog.y);
    const distance = sim.stat(source).vision * 0.7;
    const target = aircraft(sim, 1, fog.x + distance, fog.y);
    expect(sim.weather.fogAt(source.x, source.y)).toBe(true);
    sim.computeVision();
    expect(sim.sees(0, target)).toBe(false);
    source.elevation = 0;
    sim.computeVision();
    expect(sim.sees(0, target)).toBe(false);
    source.elevation = -8;
    for (const bank of sim.weather.data.fog) bank.radius = 0;
    sim.computeVision();
    expect(sim.sees(0, target)).toBe(true);
  });
});

describe('mooring information boundaries', () => {
  it('does not expose the hidden tower through a public island or expose enemy tower orders and grace', () => {
    const game = arena();
    const sim = game.sim;
    const island = islandAt(sim, 24, 24);
    const tower = sim.add('mooring_tower', 1, 'surface', 24, 24);
    tower.built = true;
    tower.mooringTarget = island.id;
    tower.mooringGrace = 17;
    island.mooringTower = tower.id;
    sim.computeVision();
    expect(sim.sees(0, tower)).toBe(false);
    expect(entityOut(sim, island, 'nw')).not.toHaveProperty('mooringTower');
    expect(game.view('nw').entities.some(e => e.id === `e_${sim.aliasOf(0, tower.id)}`)).toBe(false);
    const ownHidden = entityOut(sim, tower, 'se');
    expect(ownHidden.mooringGrace).toBe(17);
    expect(ownHidden).not.toHaveProperty('mooringTarget');
    expect(ownHidden).not.toHaveProperty('mooringState');
    sim.add('trooper', 0, 'surface', tower.x, tower.y);
    sim.computeVision();
    expect(sim.sees(0, tower)).toBe(true);
    expect(entityOut(sim, island, 'nw')).not.toHaveProperty('mooringTower');
    sim.scan(0, tower.x, tower.y);
    expect(sim.sees(0, tower)).toBe(true);
    expect(entityOut(sim, island, 'nw').mooringTower).toBe(game.entityId('nw', tower.id));
    const visible = game.view('nw').entities.find(e => e.id === game.entityId('nw', tower.id))!;
    expect(visible).toBeDefined();
    for (const field of ['mooringTarget', 'mooringGrace', 'mooringPowered']) expect(visible).not.toHaveProperty(field);
  });
});

describe('mooring checkpoint continuity', () => {
  function caught() {
    const game = arena();
    const sim = game.sim;
    const island = sim.ents.find(e => e.kind === 'island')!;
    const tower = sim.add('mooring_tower', 0, 'surface', island.x, island.y);
    tower.built = true;
    const scout = aircraft(sim, 0, island.x, island.y, 0);
    scout.order = { k: 'capture', island: island.id };
    sim.computeVision();
    expect(game.apply({ team: 'nw', role: 'surface' }, {
      kind: 'moor', tower: game.entityId('nw', tower.id), island: game.entityId('nw', island.id),
    })).toEqual({ ok: true });
    game.step();
    // Selection is not an immediate catch: this seeded phase can put another ring's
    // swept arc in the lowering envelope. Keep sight and wait for a legal window.
    const deadline = sim.tick + Math.ceil(2 * Math.PI / Math.abs(island.orbitW));
    while (island.mooringPhase === 0 && sim.tick < deadline) {
      expect(tower.mooringTarget).toBe(island.id);
      expect(sim.armies[0]!.powered).toBe(true);
      expect(sim.seesCell(0, 'sky', cellOf(island.x, island.y, sim.size))).toBe(true);
      // This fixture starts in range; distinguish traffic waiting from a lost
      // target, unaffordable tower, or visibility failure.
      expect(Math.hypot(tower.x - island.x, tower.y - island.y)).toBeLessThanOrEqual(sim.econ.mooringRange);
      expect(sim.mooringGap(island, false)).toBe(false);
      game.step();
    }
    expect(island.mooringPhase).toBe(1);
    return { game, island, tower };
  }

  it('keeps linked structures and housed aircraft on Sky while inheriting the island elevation', () => {
    const { game, island } = caught();
    const sim = game.sim;
    const aerie = sim.add('aerie', 0, 'sky', island.x, island.y);
    aerie.built = true;
    aerie.link = island.id;
    island.link = aerie.id;
    const housed = aircraft(sim, 0, island.x, island.y, 0);
    housed.hangar = aerie.id;
    const platform = sim.add('gun_platform', 0, 'sky', island.x, island.y);
    platform.built = true;
    platform.link = island.id;
    island.hardpoint = platform.id;
    for (let t = 0; t < sim.econ.mooringTravelTicks; t++) game.step();
    expect(island.elevation).toBe(-8);
    for (const e of [aerie, platform, housed]) {
      expect(e.elevation).toBe(-8);
      expect(e.plane).toBe('sky');
      expect([e.x, e.y]).toEqual([island.x, island.y]);
    }
    expect(sim.sees(1, housed)).toBe(false);
    expect(game.view('se').entities.some(e => e.id === `e_${sim.aliasOf(1, housed.id)}`)).toBe(false);
    expect(game.observe({ team: 'nw', role: 'surface' }, 0, ['surface']).entities
      .some(e => [island.id, aerie.id, platform.id, housed.id].some(id => e.id === game.entityId('nw', id)))).toBe(false);
  });

  for (const phase of [1, 2, 3] as const) {
    it(`clones phase ${phase} independently and replays every subsequent tick and projection`, () => {
      const { game, island, tower } = caught();
      const sim = game.sim;
      expect(sim.econ.mooringTravelTicks).toBe(60);
      if (phase === 1) {
        for (let t = 0; t < 20; t++) game.step();
        expect(island.elevation).toBeGreaterThan(-8);
        expect(island.elevation).toBeLessThan(0);
      } else {
        for (let t = 0; t < sim.econ.mooringTravelTicks; t++) game.step();
        expect(island.mooringPhase).toBe(2);
        expect(island.elevation).toBe(-8);
        if (phase === 3) {
          expect(game.apply({ team: 'nw', role: 'surface' }, {
            kind: 'unmoor', tower: game.entityId('nw', tower.id),
          })).toEqual({ ok: true });
          // A released island may wait for a safe route gap; checkpoint actual ascent, not merely release.
          for (let t = 0; t < 1200 && island.mooringRiseAt < 0; t++) game.step();
          expect(island.mooringRiseAt).toBeGreaterThanOrEqual(0);
          for (let t = 0; t < 10; t++) game.step();
          expect(island.elevation).toBeGreaterThan(-8);
          expect(island.elevation).toBeLessThan(0);
        }
      }
      expect(island.mooringPhase).toBe(phase);
      expect(entityOut(sim, island, 'nw')).toMatchObject({
        plane: 'sky', mooringState: phase === 1 ? 'lowering' : phase === 2 ? 'held' : 'raising',
      });
      const copy = game.clone();
      const twin = copy.sim.alive(island.id)!;
      expect(twin).not.toBe(island);
      expect(twin).toMatchObject({
        elevation: island.elevation, mooringPhase: phase,
        mooringAt: island.mooringAt, mooringRiseAt: island.mooringRiseAt,
      });
      expect(copy.stateHash()).toBe(game.stateHash());
      for (let t = 0; t <= sim.econ.mooringTravelTicks + 1; t++) {
        expect(copy.stateHash(), `phase ${phase}, replay tick ${t}`).toBe(game.stateHash());
        for (const team of ['nw', 'se'] as const) {
          expect(copy.view(team, { snapshot: true })).toEqual(game.view(team, { snapshot: true }));
          expect(copy.observe({ team, role: 'sky' }, 0)).toEqual(game.observe({ team, role: 'sky' }, 0));
        }
        game.step();
        copy.step();
      }
    });
  }

  it('hashes elevation and each vertical-transition clock independently of planar position', () => {
    const { game, island } = caught();
    const before = game.stateHash();
    for (const field of ['elevation', 'mooringPhase', 'mooringAt', 'mooringRiseAt'] as const) {
      const copy = game.clone();
      const twin = copy.sim.alive(island.id)!;
      twin[field] += field === 'elevation' ? -0.5 : 1;
      expect([twin.x, twin.y, twin.plane]).toEqual([island.x, island.y, island.plane]);
      expect(copy.stateHash(), field).not.toBe(before);
      expect(game.stateHash(), `${field} mutation must remain isolated`).toBe(before);
    }
  });
});
