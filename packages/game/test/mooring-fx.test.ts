import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { fxSchema, type Weapon } from '../src/rules/contract.ts';
import { FX_WINDOW, PLANE_INDEX } from '../src/sim/constants.ts';
import { NEUTRAL } from '../src/util/teams.ts';

const setup = () => {
  const g = createGame({ seed: 71 });
  g.sim.weather.mask.fill(0);
  for (const vis of g.sim.vis) vis.fill(0);
  g.sim.fx.length = 0;
  return g;
};

const reveal = (g: AgentCommandGame) => {
  for (const vis of g.sim.vis) vis.fill(3);
  g.sim.spot.fill(3);
};

describe('mooring combat endpoint elevations', () => {
  it.each(['rifle', 'beam', 'missile'] as const)('%s snapshots exact entity heights despite overlapping islands', (weapon: Weapon) => {
    const g = setup();
    const s = g.sim;
    const upper = s.add('island', NEUTRAL, 'sky', 24.5, 24.5);
    const lower = s.add('island', NEUTRAL, 'sky', upper.x, upper.y);
    lower.elevation = -8;
    const shooter = s.add(weapon === 'missile' ? 'interceptor' : 'gun_platform', 0, 'sky', lower.x, lower.y);
    shooter.link = lower.id;
    shooter.elevation = lower.elevation;
    const target = s.add('gunship', 1, 'sky', upper.x, upper.y);
    target.elevation = -3.5;
    reveal(g);
    s.fire(shooter, target, weapon);
    const shot = g.view('nw').fx.find(f => f.kind === 'shot')!;
    expect(shot).toMatchObject({ sourceElevation: -8, targetElevation: -3.5, src: g.entityId('nw', shooter.id), w: weapon });
    expect(validate(fxSchema, shot).ok).toBe(true);
    shooter.elevation = 0;
    target.elevation = -8;
    expect(g.view('nw').fx.find(f => f.kind === 'shot')).toMatchObject({ sourceElevation: -8, targetElevation: -3.5 });
    if (weapon === 'missile') expect(s.projectiles[0]).toMatchObject({ sourceElevation: -8, targetElevation: -3.5 });
  });

  it('does not reveal hidden target altitude from an owned visible shooter', () => {
    const g = setup();
    const shooter = g.sim.add('interceptor', 0, 'sky', 24.5, 24.5);
    const target = g.sim.add('gunship', 1, 'sky', 27.5, 24.5);
    shooter.elevation = -8;
    target.elevation = -5;
    expect(g.sim.sees(0, target)).toBe(false);
    g.sim.fire(shooter, target);
    const shot = g.view('nw').fx.find(f => f.kind === 'shot')!;
    expect(shot.sourceElevation).toBe(-8);
    expect(shot).not.toHaveProperty('targetElevation');
    // Arriving vision cannot recover an endpoint height unknown at fire time.
    reveal(g);
    expect(g.view('nw').fx.find(f => f.kind === 'shot')).not.toHaveProperty('targetElevation');
  });

  it('remaps only the known incoming endpoint height and hides the shooter', () => {
    const g = setup();
    const shooter = g.sim.add('interceptor', 1, 'sky', 27.5, 24.5);
    const target = g.sim.add('gunship', 0, 'sky', 24.5, 24.5);
    shooter.elevation = -2;
    target.elevation = -8;
    g.sim.fire(shooter, target);
    const shot = g.view('nw').fx.find(f => f.kind === 'shot')!;
    expect(shot).toMatchObject({ plane: 'sky', sourceElevation: -8, arrive: g.sim.projectiles[0]!.arrive });
    for (const key of ['src', 'side', 'tp', 'tx', 'ty', 'targetElevation']) expect(shot).not.toHaveProperty(key);
    expect(validate(fxSchema, shot).ok).toBe(true);
  });

  it('does not expose hidden mooring tower state through incoming mortar warnings', () => {
    const g = setup();
    const shooter = g.sim.add('island_mortar', 1, 'sky', 24.5, 24.5);
    const tower = g.sim.add('mooring_tower', 0, 'surface', 24.5, 24.5);
    shooter.elevation = -8;
    tower.mooringTarget = 123;
    tower.mooringGrace = 19;
    g.sim.fire(shooter, tower);
    const shot = g.view('nw').fx.find(f => f.kind === 'shot')!;
    expect(shot).toMatchObject({ subject: 'island_mortar', plane: 'surface', sourceElevation: 0, arrive: g.tick + g.sim.econ.mortarFlightTicks });
    for (const key of ['src', 'side', 'targetElevation', 'mooringTarget', 'mooringGrace']) expect(shot).not.toHaveProperty(key);
    const enemyShot = g.view('se').fx.find(f => f.kind === 'shot')!;
    expect(enemyShot).not.toHaveProperty('targetElevation');
    expect(g.sim.vis[PLANE_INDEX.surface]!.every(v => v === 0)).toBe(true);
  });

  it('records lowered death height before removing the entity', () => {
    const g = setup();
    const flyer = g.sim.add('gunship', 0, 'sky', 24.5, 24.5);
    flyer.elevation = -8;
    g.sim.kill(flyer);
    expect(g.view('nw').fx.find(f => f.kind === 'death')).toMatchObject({ sourceElevation: -8 });
  });

  it('clones projectile heights and native endpoint audiences independently', () => {
    const g = setup();
    const shooter = g.sim.add('interceptor', 0, 'sky', 24.5, 24.5);
    const target = g.sim.add('gunship', 1, 'sky', 27.5, 24.5);
    shooter.elevation = -8;
    target.elevation = -4;
    g.sim.fire(shooter, target);
    const twin = g.clone();
    expect(twin.sim.projectiles).toEqual(g.sim.projectiles);
    expect(twin.sim.fx).toEqual(g.sim.fx);
    g.sim.projectiles[0]!.targetElevation = 0;
    g.sim.fx[0]!.targetViewers = 3;
    expect(twin.sim.projectiles[0]!.targetElevation).toBe(-4);
    expect(twin.sim.fx[0]!.targetViewers).not.toBe(3);
  });

  it.each(['elevation', 'skyIsland', 'mooringAt', 'mooringRiseAt'] as const)('hashes authoritative %s state', field => {
    const g = setup();
    const e = g.sim.add('gunship', 0, 'sky', 24.5, 24.5);
    const before = g.stateHash();
    const twin = g.clone();
    e[field] += 1;
    expect(g.stateHash()).not.toBe(before);
    expect(twin.stateHash()).toBe(before);
  });

  it.each(['sourceElevation', 'targetElevation'] as const)('hashes projectile %s independently of current entities', field => {
    const g = setup();
    g.sim.fire(g.sim.add('interceptor', 0, 'sky', 24.5, 24.5), g.sim.add('gunship', 1, 'sky', 27.5, 24.5));
    const before = g.stateHash();
    g.sim.projectiles[0]![field] = -8;
    expect(g.stateHash()).not.toBe(before);
  });

  it('retains in-flight mortar FX for late joins without retaining unrelated expired effects', () => {
    const g = setup();
    const arrive = FX_WINDOW + 5;
    g.sim.fxAdd('shot', 'sky', 24.5, 24.5, 0, false, { subject: 'island_mortar', tp: 'surface', tx: 25.5, ty: 24.5, sourceElevation: -8, targetElevation: 0, arrive });
    g.sim.fxAdd('shot', 'sky', 24.5, 24.5, 0, false, { subject: 'interceptor', arrive: 1 });
    for (let tick = 0; tick < FX_WINDOW; tick++) g.step();
    expect(g.view('nw').fx.some(f => f.subject === 'island_mortar' && f.arrive === arrive)).toBe(true);
    expect(g.sim.fx.some(r => r.fx.subject === 'interceptor' && r.fx.tick === 0)).toBe(false);
    while (g.tick < arrive) g.step();
    expect(g.sim.fx.some(r => r.fx.subject === 'island_mortar' && r.fx.arrive === arrive)).toBe(true);
    g.step();
    expect(g.sim.fx.some(r => r.fx.subject === 'island_mortar' && r.fx.arrive === arrive)).toBe(false);
  });

  it('reconnects to a retained real mortar warning with only the Surface target visible', () => {
    const g = createGame({ seed: 7, options: { terrain: 'open', sky: { stormSets: 1, stormRadius: 7, stormDps: 0, fogRadius: 0, jetWidth: 0 } } });
    const s = g.sim;
    for (const e of s.ents) if (e.unit) e.dead = true;
    for (const army of s.armies) army.energy = 1000;
    const island = s.ents.find(e => e.kind === 'island')!;
    island.x = island.y = 24.5;
    island.side = 1;
    island.elevation = -8;
    island.mooringPhase = 2;
    island.mooringAt = -s.econ.mooringTravelTicks;
    const tower = s.add('mooring_tower', 1, 'surface', 20.5, 24.5);
    tower.mooringTarget = island.id;
    island.mooringTower = tower.id;
    const mortar = s.add('island_mortar', 1, 'sky', island.x, island.y);
    mortar.link = island.id;
    mortar.elevation = island.elevation;
    island.hardpoint = mortar.id;
    const target = s.add('turret', 0, 'surface', 31.5, 24.5);
    const spotter = s.add('trooper', 1, 'surface', 30.5, 25.5);
    spotter.stance = 'hold';
    spotter.cd = 100000;
    for (const cloud of [...s.weather.data.forecast, ...s.weather.data.storms]) {
      cloud.originX = cloud.originY = 24.5;
      cloud.dx = cloud.dy = 0;
      cloud.maxRadius = s.econ.stormRadius;
      cloud.start = cloud.grown = 0;
      cloud.breaking = 1000000;
      cloud.end = 1000001;
    }
    s.weather.update(s.tick);
    s.weather.refreshMask();
    s.computeVision();
    expect(s.sees(0, mortar)).toBe(false);
    expect(s.sees(0, tower)).toBe(false);
    expect(s.sees(1, target)).toBe(true);
    s.fire(mortar, target);
    const arrive = s.projectiles.find(p => p.source === 'island_mortar')!.arrive;
    for (let tick = 0; tick <= FX_WINDOW; tick++) g.step();
    expect(g.tick).toBeLessThan(arrive);
    const reconnected = g.clone();
    for (const game of [g, reconnected]) {
      const view = game.view('nw');
      const warning = view.fx.find(f => f.kind === 'shot' && f.subject === 'island_mortar' && f.tick === 0)!;
      expect(warning).toMatchObject({ plane: 'surface', x: target.x, y: target.y, sourceElevation: 0, arrive });
      expect(Object.keys(warning).sort()).toEqual(['arrive', 'kind', 'plane', 'sourceElevation', 'subject', 'tick', 'w', 'x', 'y']);
      expect(view.entities.some(e => e.id === `e_${s.aliasOf(0, mortar.id)}` || e.id === `e_${s.aliasOf(0, tower.id)}`)).toBe(false);
      const publicIsland = view.entities.find(e => e.id === game.entityId('nw', island.id))!;
      expect(publicIsland).toBeDefined();
      expect(publicIsland).not.toHaveProperty('mooringTower');
      expect(publicIsland).not.toHaveProperty('hardpoint');
      expect(publicIsland).not.toHaveProperty('link');
      expect(view.islands.find(path => path.id === publicIsland.id)).not.toHaveProperty('hardpoint');
      expect(game.view('se').islands.find(path => path.id === publicIsland.id)?.hardpoint).toEqual({ kind: 'island_mortar', side: 'se' });
    }
    while (g.tick <= arrive) g.step();
    expect(g.view('nw').fx.some(f => f.kind === 'shot' && f.subject === 'island_mortar' && f.tick === 0)).toBe(false);
  });
});
