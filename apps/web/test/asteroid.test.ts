import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEUTRAL, createGame } from '@agent-command/game';
import { DEFAULT_RULES, ECON, PLANE_Y, TICK_RATE, type Entity, type View } from '@agent-command/game/contract';
import { Fx } from '../src/world/fx.ts';
import { Combat } from '../src/world/combat.ts';
import { applyFade } from '../src/world/fade.ts';
import { TerrainField, groundAt } from '../src/world/terrain.ts';
import { DoubleSide, Euler, InstancedBufferGeometry, InstancedMesh, Mesh, MeshBasicNodeMaterial, Raycaster, Vector3, type InterleavedBufferAttribute } from 'three/webgpu';
import { asteroidPosition, impactLook, miningSurface, rockResource, rockFuseGlow, rockFuseLeft, rockScale, rockStretch } from '../src/world/asteroid.ts';
import { Deposits } from '../src/world/deposits.ts';
import { unitZoomScale } from '../src/world/rig.ts';
import { Entities, orbitMuzzle } from '../src/world/entities.ts';
import { Awareness } from '../src/world/awareness.ts';
import { model } from '../src/world/models.ts';
import { clockAt } from '../src/world/materials.ts';
import { wx, wz } from '../src/world/common.ts';
import { cpuPool } from './cpu-pool.ts';

const terrain = new TerrainField(48);

/** Real sim termination through the public, serialized view; no synthetic FX or renderer spies. */
function scenario(kind: 'intercept' | 'impact') {
  const game = createGame({ seed: 7 });
  const sim = game.sim;
  const tug = sim.spawnUnit(1, 'tug', 'orbit');
  const asteroid = sim.add('asteroid', NEUTRAL, 'orbit', 20, 22);
  asteroid.hp = asteroid.maxHp = ECON.asteroidHp;
  sim.deorbit(tug, asteroid, 24, 24);
  // Falling payloads are public: the step that launched it would have named it for every army (game sim/aliases.ts).
  sim.noteSightings();
  sim.tick = (kind === 'intercept' ? ECON.impactTicks / 2 : ECON.impactTicks) - 1;
  const before = game.view('nw', { snapshot: true });
  if (kind === 'intercept') sim.damage(asteroid, asteroid.hp, 0);
  game.step();
  const after: View = JSON.parse(JSON.stringify(game.view('nw', { snapshot: true })));
  const event = after.fx.find(f => f.kind === kind)!;
  expect(event).toBeDefined();
  expect(after.entities.some(e => e.id === game.entityId('nw', asteroid.id))).toBe(false);
  expect(after.impacts).toHaveLength(0);
  return { game, before, after, event };
}

function core(combat: Combat): number[] {
  // The second spark is the stationary explosion body, not the raised flash or moving debris.
  return Array.from(cpuPool(combat.sparks).mesh.instanceMatrix.array.slice(28, 31));
}

function expectPosition(actual: number[], expected: number[]) {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 4);
}

afterEach(() => { applyFade(1); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('asteroid destruction placement', () => {
  it.each([false, true])('meets the falling rock at the fractional render boundary (missing prior entity: %s)', firstView => {
    const { before, after, event } = scenario('intercept');
    const rock = new Fx(48);
    const combat = new Combat(undefined, 48, terrain);
    if (!firstView) {
      rock.ingest(before);
      combat.ingest(before, () => 1000);
    }
    rock.ingest(after);
    combat.ingest(after, () => 1050);
    rock.frame(1049, event.tick - 0.001);
    combat.frame(1049, 0, 100, event.tick - 0.001);
    expect(rock.root.children[0]!.visible).toBe(true);
    expect(combat.sparks.n).toBe(0);
    const lastRock = rock.root.children[0]!.position.toArray();
    // Halfway down the quadratic descent: neither the logical (22,23) nor the sky plane.
    const expected = [-4.5, PLANE_Y.orbit + (PLANE_Y.surface - PLANE_Y.orbit) / 4 + 0.6, -2.25];
    expectPosition(lastRock, [-4.500037499765625, expected[1]! + 0.00032499796875, -2.2500187498828126]);
    rock.frame(1050, event.tick);
    combat.frame(1050, 0, 100, event.tick);
    expect(rock.root.children.every(child => !child.visible)).toBe(true);
    expectPosition(core(combat), expected);
    const particles = combat.sparks.n;
    // Repeated event windows and plane switches must not replay or re-anchor the explosion.
    for (const level of [3, 2, 1, 0, 2.5]) {
      applyFade(level);
      combat.focus = level >= 2 ? 'orbit' : 'surface';
      rock.ingest(after);
      combat.ingest(after, () => 1050);
      rock.frame(1051, event.tick + 0.001);
      combat.frame(1051, 0, 100, event.tick + 0.001);
      expect(rock.root.children.every(child => !child.visible)).toBe(true);
      expect(combat.sparks.n).toBe(particles);
      expectPosition(core(combat), expected);
    }
  });

  it('uses the event trajectory, not arrival time, after the entity and impact marker have disappeared', () => {
    const { before, after, event } = scenario('intercept');
    const combat = new Combat(undefined, 48, terrain);
    combat.ingest(before, () => 1000);
    // An already-running client receives the termination four rendered ticks late.
    combat.ingest({ ...after, tick: after.tick + 4 }, () => 1000);
    combat.frame(1200, 0, 100, event.tick + 4);
    expectPosition(core(combat), [-4.5, PLANE_Y.orbit + (PLANE_Y.surface - PLANE_Y.orbit) / 4 + 0.6, -2.25]);
  });

  it('retires a missing rock at the snapshot boundary when backpressure outlasts the terminal FX window', () => {
    const { game, before, event } = scenario('intercept');
    const rock = new Fx(48);
    rock.ingest(before);
    for (let i = 0; i < 11; i++) game.step();
    const resumed: View = JSON.parse(JSON.stringify(game.view('nw')));
    expect(resumed.impacts).toHaveLength(0);
    expect(resumed.fx.some(f => f.fall?.id === event.fall!.id)).toBe(false);
    rock.ingest(resumed);
    rock.frame(1500, resumed.tick - 0.001);
    expect(rock.root.children.some(child => child.visible)).toBe(true);
    rock.frame(1501, resumed.tick);
    expect(rock.root.children.every(child => !child.visible)).toBe(true);
  });

  it('keeps an actual landing on the ground and retires the rock at the same render tick', () => {
    const { before, after, event } = scenario('impact');
    const rock = new Fx(48);
    const combat = new Combat(undefined, 48, terrain);
    rock.ingest(before);
    combat.ingest(before, () => 1000);
    rock.ingest(after);
    combat.ingest(after, () => 1050);
    rock.frame(1049, event.tick - 0.001);
    combat.frame(1049, 0, 100, event.tick - 0.001);
    expect(rock.root.children[0]!.visible).toBe(true);
    expect(combat.sparks.n).toBe(0);
    rock.frame(1050, event.tick);
    combat.frame(1050, 0, 100, event.tick);
    expect(rock.root.children.every(child => !child.visible)).toBe(true);
    expectPosition(core(combat), [0, PLANE_Y.surface + groundAt(24, 24, terrain) + 0.45, 0]);
    expect(event.plane).toBe('surface');
    expect([event.x, event.y]).toEqual([24, 24]);
  });

  it('forgets queued termination and retained rocks when leaving the match', () => {
    const { after, event } = scenario('intercept');
    const rock = new Fx(48);
    const combat = new Combat(undefined, 48, terrain);
    rock.ingest(after);
    combat.ingest(after, () => 1000);
    rock.reset();
    combat.reset();
    rock.frame(1000, event.tick);
    combat.frame(1000, 0, 100, event.tick);
    expect(rock.root.children.every(child => !child.visible)).toBe(true);
    expect(combat.sparks.n).toBe(0);
  });
});

describe('rock metadata and visible deposits', () => {
  const falling: Entity = { id: 'e_900', kind: 'asteroid', side: 'neutral', plane: 'sky', x: 24, y: 24, hp: 60, maxHp: 60, state: 'falling', rockSize: 'pebble' };
  const fall = { id: falling.id, side: 'nw', x: 24, y: 24, start: 80, tick: 160, radius: 1.5 } satisfies View['impacts'][number];
  const event: View['fx'][number] = { kind: 'impact', plane: 'surface', tick: fall.tick, x: fall.x, y: fall.y, fall };
  const snapshot = (): View => ({ ...createGame({ seed: 7 }).view('nw'), entities: [falling], impacts: [fall], oreCaches: [], scorches: [], fx: [] });

  it('uses explicit resource metadata, never inferring it from HP', () => {
    expect(rockScale({})).toBe(1);
    expect(rockScale({ rockSize: 'pebble' })).toBeLessThan(rockScale({ rockSize: 'medium' }));
    expect(rockScale({ rockSize: 'large' })).toBeGreaterThan(1);
    const damaged: Entity = { ...falling, hp: 1 };
    const healthy: Entity = { ...falling, hp: 800 };
    expect(rockResource(damaged)).toBe(0);
    expect(rockResource(healthy)).toBe(0);
    expect(rockResource({ resourceType: 'metal' })).toBe(0.5);
    expect(rockResource({ resourceType: 'ice' })).toBe(1);
    expect(rockResource({ resourceType: 'slag' })).toBe(0);
  });

  it('intensifies only a received fuse and clears on drop or missing metadata', () => {
    const armed: Entity = { ...falling, plane: 'orbit', volatile: true, fuseUntil: 900 };
    expect(rockFuseLeft(armed, 880)).toBe(1);
    expect(rockFuseGlow(armed, 0, 45)).toBe(0.25);
    expect(rockFuseGlow(armed, 450, 45)).toBe(0.625);
    expect(rockFuseGlow(armed, 901, 45)).toBe(1);
    expect(rockFuseGlow(armed, 300, 30)).toBe(0.25);
    for (const unknown of [{ ...armed, fuseUntil: undefined }, { ...armed, volatile: undefined }, { ...armed, plane: 'sky' as const }]) {
      expect(rockFuseLeft(unknown, 880)).toBe(-1);
      expect(rockFuseGlow(unknown, 880, 45)).toBe(unknown.volatile ? 0.12 : 0);
    }
  });

  it.each(['pebble', 'medium', 'large'] as const)('preserves %s size and explicit paint while resetting reused fuse records', size => {
    const view = snapshot();
    const units = new Entities(false, undefined, 48);
    const selected = new Set<string>();
    const armed: Entity = { ...falling, plane: 'orbit', state: 'towed', rockSize: size, resourceType: 'ice', volatile: true, fuseUntil: 900 };
    const render = (rock: Entity) => {
      units.ingest({ ...view, tick: 100, entities: [rock], impacts: [] }, 1000);
      units.frame(1000, 1, selected, undefined, 'nw', 'orbit', 26);
      return units.root.children.find(child => child instanceof Mesh && child.geometry instanceof InstancedBufferGeometry && child.geometry.instanceCount === 1 && child.renderOrder === 40) as Mesh;
    };
    applyFade(3);
    const mesh = render(armed);
    const form = mesh.geometry.getAttribute('unitForm') as InterleavedBufferAttribute;
    const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    expect(form.getX(0)).toBeCloseTo(rockScale(armed));
    expect(drive.getW(0)).toBe(1);
    expect(drive.getY(0)).toBeGreaterThan(0);
    render({ ...armed, fuseUntil: undefined });
    expect(drive.getY(0)).toBeCloseTo(0.12, 2);
    render({ ...armed, resourceType: undefined, volatile: undefined });
    expect(drive.getW(0)).toBe(0);
    expect(drive.getY(0)).toBe(0);
    units.reset();
    render({ ...armed, id: 'e_901', resourceType: 'metal', volatile: false, fuseUntil: undefined });
    expect(drive.getW(0)).toBe(0.5);
    expect(drive.getY(0)).toBe(0);
    units.ingest({ ...view, tick: 101, entities: [], impacts: [] }, 1050);
    units.frame(1050, 1.05, selected, undefined, 'nw', 'orbit', 26);
    expect((mesh.geometry as InstancedBufferGeometry).instanceCount).toBe(0);
  });

  it('samples the actual size-specific warning interval without allocating the output', () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(asteroidPosition(fall,fall.start,out,48)).toBe(0);
    expect(out.y).toBe(PLANE_Y.orbit + 0.6);
    expect(asteroidPosition(fall,120,out,48)).toBe(0.5);
    expect(out.y).toBe(PLANE_Y.orbit + (PLANE_Y.surface - PLANE_Y.orbit) / 4 + 0.6);
    expect(asteroidPosition(fall,fall.tick,out,48)).toBe(1);
    expect(out.y).toBe(PLANE_Y.surface + 0.6);
  });

  it('changes falling size and paint only from the received entity metadata', () => {
    const view = snapshot();
    const fx = new Fx(48);
    fx.ingest(view);
    fx.frame(1000, 100);
    const group = fx.root.children[0]!;
    const mesh = group.children[0] as Mesh;
    const unidentified = mesh.material;
    expect(group.scale.x).toBe(rockScale(falling));
    view.entities = [{ ...falling, volatile: true }];
    fx.ingest(view);
    fx.frame(1001, 101);
    expect(mesh.material).not.toBe(unidentified);
    view.entities = [{ ...falling, hp: 1 }];
    fx.ingest(view);
    fx.frame(1002, 102);
    expect(mesh.material).toBe(unidentified);
  });

  it('keeps the public base blast unless observed volatility or a matching visible scorch identifies it', () => {
    const view = snapshot();
    expect(impactLook(view, event)).toEqual({ radius: 1.5, volatile: false });
    view.entities = [{ ...falling, volatile: true }];
    expect(impactLook(view, event)).toEqual({ radius: 1.5 * DEFAULT_RULES.orbit.volatileRadiusMultiplier, volatile: true });
    view.entities = [];
    view.scorches = [{ x: fall.x, y: fall.y, radius: 2.25, until: fall.tick + DEFAULT_RULES.orbit.scorchDuration * TICK_RATE }];
    expect(impactLook(view, event)).toEqual({ radius: 2.25, volatile: true });
    view.scorches[0]!.until -= TICK_RATE;
    expect(impactLook(view, event)).toEqual({ radius: 1.5, volatile: false });
    view.scorches = [];
    expect(impactLook(view, event)).toEqual({ radius: 1.5, volatile: false });
  });

  it('retains only actually observed fall volatility for its terminal blast, and forgets it on reset', () => {
    const known = new Combat(undefined, 48, terrain);
    const unseen = new Combat(undefined, 48, terrain);
    const forgotten = new Combat(undefined, 48, terrain);
    const before = snapshot();
    before.tick = 100;
    before.entities = [{ ...falling, volatile: true }];
    const at = (tick: number) => tick * 50;
    known.ingest(before, at);
    forgotten.ingest(before, at);
    forgotten.reset();
    unseen.ingest({ ...before, entities: [falling] }, at);
    // The destroyed entity is gone; no scorch exists for an island strike.
    const after = { ...before, tick: fall.tick, entities: [], impacts: [], fx: [{ ...event, plane: 'sky' as const }] };
    for (const combat of [known, unseen, forgotten]) {
      combat.ingest(after, at);
      combat.frame(at(fall.tick), 0, 100, fall.tick);
    }
    expect(known.sparks.n).toBeGreaterThan(unseen.sparks.n);
    expect(forgotten.sparks.n).toBe(unseen.sparks.n);
  });

  it('renders only current cache/scorch lists, including explicit Depths shares and reset', () => {
    const deposits = new Deposits(48);
    const view = snapshot();
    view.tick = 160;
    view.oreCaches = [{ id: 1, x: 20, y: 22, alloy: 90, radius: 2, below: { x: 20, y: 22, alloy: 30 } }];
    view.scorches = [{ x: 24, y: 24, radius: 4.5, until: 360 }];
    deposits.update(view, tick => tick / TICK_RATE);
    // one ore heap per cache share
    expect(deposits.ore.count).toBe(1);
    expect(deposits.below.count).toBe(1);
    expect(deposits.rings.count).toBe(1);
    expect(deposits.scorch.mesh.count).toBe(1);
    // A Depths-only observation must not create any Surface resource prop or collection ring.
    view.oreCaches[0]!.alloy = 0;
    view.tick = 360;
    deposits.update(view, tick => tick / TICK_RATE);
    expect(deposits.ore.count).toBe(0);
    expect(deposits.rings.count).toBe(0);
    expect(deposits.below.count).toBe(1);
    expect(deposits.scorch.mesh.count).toBe(0);
    view.oreCaches = [];
    deposits.update(view, tick => tick / TICK_RATE);
    expect(deposits.below.count).toBe(0);
    view.oreCaches = [{ id: 2, x: 18, y: 18, alloy: 60, radius: 2 }];
    deposits.update(view, tick => tick / TICK_RATE);
    deposits.reset();
    expect(deposits.ore.count + deposits.below.count + deposits.rings.count + deposits.scorch.mesh.count).toBe(0);
  });

  it('grows ore heaps with the units\' zoom enlargement, in place and without drift', () => {
    const deposits = new Deposits(48);
    const view = snapshot();
    view.oreCaches = [{ id: 1, x: 20, y: 22, alloy: 90, radius: 2, below: { x: 21, y: 23, alloy: 30 } }];
    deposits.update(view, tick => tick / TICK_RATE);
    const m = deposits.ore.instanceMatrix.array;
    const basis = () => Math.hypot(m[0]!, m[1]!, m[2]!);
    const at = [m[12], m[13], m[14]];
    const near = basis();
    for (const zoom of [40, 60, 78, 30, 78]) deposits.zoom(unitZoomScale(zoom));
    expect(basis()).toBeCloseTo(near * unitZoomScale(78), 6);
    expect(Math.hypot(deposits.below.instanceMatrix.array[0]!, deposits.below.instanceMatrix.array[1]!, deposits.below.instanceMatrix.array[2]!)).toBeCloseTo(near * unitZoomScale(78), 6);
    expect([m[12], m[13], m[14]]).toEqual(at);
    // a fresh view written while zoomed out keeps the enlargement; zooming back in restores the authored size
    deposits.update(view, tick => tick / TICK_RATE);
    expect(basis()).toBeCloseTo(near * unitZoomScale(78), 6);
    deposits.zoom(unitZoomScale(14));
    expect(basis()).toBeCloseTo(near, 6);
  });
});

describe('visible volatile Orbit detonations', () => {
  const at = (tick: number) => tick * 50;
  const event: View['fx'][number] = { kind: 'volatile_detonation', plane: 'orbit', tick: 100, x: 20, y: 22, radius: 6 };
  const snapshot = (fx: View['fx']): View => ({ ...createGame({ seed: 7 }).view('nw'), tick: 100, entities: [], impacts: [], fx });

  it('uses only received FX, waits for the render boundary, and honors the supplied radius in Orbit', () => {
    const combat = new Combat(undefined, 48, terrain);
    const view = snapshot([event]);
    applyFade(3);
    combat.focus = 'orbit';
    combat.ingest(view, at);
    combat.frame(at(100) - 1, 0, 100, 99.999);
    expect(combat.sparks.n).toBe(0);
    combat.frame(at(100), 0, 100, 100);
    expectPosition(core(combat), [-4, PLANE_Y.orbit + 0.3, -2]);
    const count = combat.sparks.n;
    const rings = combat.rings.n;
    expect(count).toBeGreaterThan(0);
    expect(rings).toBeGreaterThan(0);
    for (let i = 0; i < rings; i++) {
      expect(combat.rings.mesh.instanceMatrix.array[i * 16 + 13]).toBeGreaterThanOrEqual(PLANE_Y.orbit);
    }
    combat.ingest(view, at);
    combat.frame(at(100) + 350, 0, 100, 107);
    expect(combat.sparks.n).toBe(count);
    // The final dashed radius ring is halfway through its eased expansion: 0.15 + (6 - 0.15) × 0.75.
    expect(combat.rings.mesh.instanceMatrix.array[(rings - 1) * 16]).toBeCloseTo(4.5375);
    const hidden = new Combat(undefined, 48, terrain);
    hidden.ingest(snapshot([]), at);
    hidden.frame(at(100), 0, 100, 100);
    expect(hidden.sparks.n + hidden.rings.n).toBe(0);
  });

  it('clears queued and active pooled blasts, including shake, before a new match', () => {
    const combat = new Combat(undefined, 48, terrain);
    const view = snapshot([event]);
    combat.ingest(view, at);
    combat.reset();
    combat.frame(at(100), 0, 100, 100);
    expect(combat.sparks.n + combat.rings.n).toBe(0);
    combat.ingest(view, at);
    combat.frame(at(100), 0, 100, 100);
    expect(combat.sparks.n).toBeGreaterThan(0);
    combat.reset();
    expect(combat.shake).toBe(0);
    expect(combat.sparks.mesh.count + combat.smoke.mesh.count + combat.debris.mesh.count + combat.rings.mesh.count).toBe(0);
  });
});

describe('stand-off mining optics', () => {
  it.each(['pebble', 'medium', 'large'] as const)('joins the physical emitter to the first actual %s triangle, not the rock centre', size => {
    const now = 1000;
    vi.spyOn(performance, 'now').mockReturnValue(now);
    const game = createGame({ seed: 31, options: { orbit: { maxAsteroids: 0, derelictEnabled: false } } });
    const tug = game.sim.add('tug', 0, 'orbit', 20, 12);
    const rock = game.sim.add('asteroid', NEUTRAL, 'orbit', 23, 12);
    rock.state = 'drifting'; rock.rockSize = size; rock.resourceType = 'metal';
    rock.hp = rock.maxHp = game.sim.rocks[size].hp; rock.resourceRemaining = game.sim.rocks[size].dockYield.metal.alloy;
    game.sim.computeVision();
    const tugId = game.entityId('nw', tug.id), rockId = game.entityId('nw', rock.id);
    expect(game.apply({ team: 'nw', role: 'orbit' }, { kind: 'mine_asteroid', units: [tugId], asteroid: rockId })).toEqual({ ok: true });
    game.step();
    const view = game.view('nw', { snapshot: true });
    const units = new Entities(false, undefined, 48);
    units.ingest(view, now); applyFade(3);
    units.frame(now, 1, new Set(), undefined, 'nw', 'orbit', 26);
    const ship = units.tracks.get(tugId)!, body = units.tracks.get(rockId)!;
    ship.heading = 0.3; ship.pitch = 0.12; ship.bank = -0.16;
    const origin = new Float64Array(3), contact = new Float64Array(3);
    expect(orbitMuzzle(origin, ship, 0, now, 48)).toBe(1);
    expect(miningSurface(contact, origin, body, now, 48)).toBe(true);
    const mesh = new Mesh(model('asteroid'), new MeshBasicNodeMaterial({ side: DoubleSide }));
    mesh.position.set(wx(body.rx, 48), body.wy, wz(body.ry, 48));
    // the rig stretches each rock along its own axes by its phase (`rockStretch`) before it tumbles
    const stretch = rockStretch(body.phase, { x: 1, y: 1, z: 1 });
    mesh.scale.set(body.scale * stretch.x, body.scale * stretch.y, body.scale * stretch.z);
    const t = clockAt(now);
    mesh.quaternion.setFromEuler(new Euler(t * 0.3 + body.phase, t * 0.2, body.phase * 2, 'XYZ'));
    mesh.updateMatrixWorld(true);
    const rayOrigin = new Vector3(origin[0], origin[1], origin[2]);
    const hits = new Raycaster(rayOrigin, mesh.position.clone().sub(rayOrigin).normalize()).intersectObject(mesh);
    expect(hits.length).toBeGreaterThan(0);
    expectPosition(Array.from(contact), hits[0]!.point.toArray());
    expect(rayOrigin.distanceTo(hits[0]!.point)).toBeGreaterThan(0.15);
    expect(rayOrigin.distanceTo(mesh.position) - hits[0]!.point.distanceTo(mesh.position)).toBeGreaterThan(0.15);
    const awareness = new Awareness(new Combat(undefined, 48, terrain), 48, terrain);
    awareness.frame(view, units.tracks, 0, 'orbit', 0);
    const beam = awareness.root.getObjectByName('orbit-mining-beams') as InstancedMesh;
    expect(beam.count).toBe(1);
    const matrix = beam.instanceMatrix.array;
    expectPosition(Array.from(matrix.slice(12, 15)), Array.from(origin));
    expectPosition([matrix[12]! + matrix[4]!, matrix[13]! + matrix[5]!, matrix[14]! + matrix[6]!], Array.from(contact));
    view.entities = view.entities.filter(e => e.id !== rockId);
    awareness.frame(view, units.tracks, 0, 'orbit', 0);
    expect(beam.count).toBe(0); // fading cached track is not current local vision
  });

  it.each([false, true])('uses bounded contacts and respects reduced motion, order cancellation and plane fade: %s', reduced => {
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    const view = createGame({ seed: 31 }).view('nw', { snapshot: true });
    view.entities = [
      { id: 'e_900', kind: 'tug', side: 'nw', plane: 'orbit', x: 20, y: 12, hp: 200, maxHp: 200, state: 'mining', miningTarget: 'e_901' },
      { id: 'e_901', kind: 'asteroid', side: 'neutral', plane: 'orbit', x: 23, y: 12, hp: 100, maxHp: 100, state: 'drifting', rockSize: 'medium', resourceType: 'ice' },
    ];
    const units = new Entities(false, undefined, 48);
    units.ingest(view, 1000); applyFade(3);
    units.frame(1000, 1, new Set(), undefined, 'nw', 'orbit', 26);
    const awareness = new Awareness(new Combat(undefined, 48, terrain), 48, terrain);
    const beam = awareness.root.getObjectByName('orbit-mining-beams') as InstancedMesh;
    const contacts = awareness.root.getObjectByName('orbit-mining-contacts') as InstancedMesh;
    awareness.frame(view, units.tracks, 0, 'orbit', 0);
    expect(beam.count).toBe(1); expect(contacts.count).toBe(reduced ? 1 : 4);
    for (const state of ['returning', 'moving', 'idle'] as const) {
      view.entities[0]!.state = state;
      awareness.frame(view, units.tracks, 0, 'orbit', 0);
      expect(beam.count).toBe(0); expect(contacts.count).toBe(0);
    }
    view.entities[0]!.state = 'mining'; applyFade(1);
    awareness.frame(view, units.tracks, 0, 'surface', 0);
    expect(beam.count).toBe(0); expect(contacts.count).toBe(0);
  });
});
