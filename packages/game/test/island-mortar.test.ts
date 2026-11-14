/** Island Mortars share the gunner hardpoint, not the main slot, and use ordinary finite splash projectiles. */
import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { ISLAND_STRUCTURES, TICK_RATE, slotOfArmyId, type ArmyId } from '../src/rules/contract.ts';
import { PLANE_INDEX } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);
const SKY = { team: 'nw', role: 'sky' } as const;
const id = (g: AgentCommandGame, e: Ent, team: ArmyId = 'nw'): string => g.entityId(team, e.id);
const steps = (g: AgentCommandGame, n: number): void => { for (let i = 0; i < n; i++) g.step(); };

function arena(sky: object = {}) {
  const g = createGame({ seed: 5, options: { terrain: 'open', sky: { stormSets: 0, fogRadius: 0, jetWidth: 0, ...sky } } });
  const s = g.sim;
  for (const e of s.ents) if (e.unit) e.dead = true;
  g.step();
  const islands = s.ents.filter((e) => e.kind === 'island');
  const inner = Math.min(...islands.map((e) => e.orbitR));
  const island = islands.find((e) => e.orbitR === inner)!;
  s.setSide(island, BLUE);
  s.armies[BLUE]!.alloy = s.armies[BLUE]!.energy = 5000;
  return { g, s, island };
}

function mount(s: AgentCommandGame['sim'], island: Ent): Ent {
  const mortar = s.add('island_mortar', BLUE, 'sky', island.x, island.y);
  mortar.link = island.id;
  mortar.elevation = island.elevation;
  island.hardpoint = mortar.id;
  s.armies[BLUE]!.structures++;
  return mortar;
}

function visible(s: AgentCommandGame['sim']): void {
  s.vis[PLANE_INDEX.surface]!.fill(s.armies[BLUE]!.group.bit);
  s.vis[PLANE_INDEX.sky]!.fill(s.armies[BLUE]!.group.bit);
  s.noteSightings();
}

/** Stationary targets and one active weapon make timing/damage assertions independent of other armies' fire. */
function battery() {
  const a = arena();
  const mortar = mount(a.s, a.island);
  const target = a.s.add('tank', RED, 'surface', mortar.x + 4, mortar.y);
  target.stance = 'hold';
  for (const e of a.s.ents) e.cd = 1e9;
  mortar.cd = 0;
  visible(a.s);
  a.s.buildIndex();
  return { ...a, mortar, target };
}

function shoot(a: { g: AgentCommandGame; s: AgentCommandGame['sim']; mortar: Ent; target: Ent }): void {
  expect(a.g.apply(SKY, { kind: 'attack', units: [id(a.g, a.mortar)], target: id(a.g, a.target) })).toEqual({ ok: true });
  a.s.combat();
  a.s.settleShots();
  expect(a.s.projectiles).toHaveLength(1);
}

describe('Island Mortar construction and hardpoint ownership', () => {
  for (const main of ISLAND_STRUCTURES) it(`constructs beside ${main}, reserving only the gunner slot`, () => {
    const { g, s, island } = arena();
    expect(g.apply(SKY, { kind: 'queue_add', item: main, island: id(g, island) })).toEqual({ ok: true });
    expect(g.apply(SKY, { kind: 'queue_add', item: 'island_mortar', island: id(g, island) })).toEqual({ ok: true });
    expect(g.apply(SKY, { kind: 'queue_add', item: 'island_mortar', island: id(g, island) })).toMatchObject({ ok: false, code: 'occupied' });
    const before = { alloy: s.armies[BLUE]!.alloy, energy: s.armies[BLUE]!.energy };
    s.updateProduction();
    const mortar = s.alive(island.hardpoint)!;
    expect(mortar.kind).toBe('island_mortar');
    expect(mortar.built).toBe(false);
    expect(mortar.link).toBe(island.id);
    expect(s.alive(island.link)!.kind).toBe(main);
    expect(s.armies[BLUE]!.alloy).toBe(before.alloy - s.stats[main].alloy - 140);
    expect(s.armies[BLUE]!.energy).toBe(before.energy - s.stats[main].energy - 80);
    expect(g.observe(SKY, 0).queue.find((e) => e.item === 'island_mortar')!.island).toBe(id(g, island));
    expect(s.stats.island_mortar.build).toBe(20 * TICK_RATE);
    for (let tick = 0; tick <= s.stats.island_mortar.build; tick++) s.updateConstruction();
    s.updateProduction();
    expect(mortar.built).toBe(true);
    expect(mortar.hp).toBe(300);
    expect(s.armies[BLUE]!.queue).toHaveLength(0);
    expect(g.observe(SKY, 0).islands.find((e) => e.id === id(g, island))!.hardpoint).toEqual({ kind: 'island_mortar', side: 'nw' });
  });

  it('reserves against emplacement before funding; cancellation releases the reservation', () => {
    const { g, s, island } = arena();
    s.armies[BLUE]!.alloy = 0;
    const gun = s.spawnUnit(BLUE, 'gunship', 'sky');
    gun.x = island.x; gun.y = island.y;
    expect(g.apply(SKY, { kind: 'queue_add', item: 'island_mortar', island: id(g, island) })).toEqual({ ok: true });
    s.updateProduction();
    expect(island.hardpoint).toBe(0);
    expect(g.apply(SKY, { kind: 'emplace', unit: id(g, gun), island: id(g, island) })).toMatchObject({ ok: false, code: 'occupied' });
    const entry = g.observe(SKY, 0).queue[0]!;
    expect(g.apply(SKY, { kind: 'queue_cancel', entry: entry.id })).toEqual({ ok: true });
    expect(g.apply(SKY, { kind: 'emplace', unit: id(g, gun), island: id(g, island) })).toEqual({ ok: true });
    expect(g.apply(SKY, { kind: 'queue_add', item: 'island_mortar', island: id(g, island) })).toMatchObject({ ok: false, code: 'occupied' });
    expect(g.apply(SKY, { kind: 'queue_add', item: 'relay', island: id(g, island) })).toEqual({ ok: true });
  });

  it('enforces Sky construction, held ownership, the hardpoint toggle and the live Sky segment', () => {
    const { g, s, island } = arena();
    const order = { kind: 'queue_add', item: 'island_mortar', island: id(g, island) } as const;
    expect(g.apply({ team: 'nw', role: 'surface' }, order)).toMatchObject({ ok: false, code: 'wrong_plane' });
    s.setSide(island, RED);
    expect(g.apply(SKY, order)).toMatchObject({ ok: false, code: 'not_held' });
    s.setSide(island, BLUE);
    s.armies[BLUE]!.spire.sky.hp = 0;
    expect(g.apply(SKY, order)).toMatchObject({ ok: false, code: 'segment_destroyed' });
    const off = arena({ islandHardpoints: 0 });
    expect(off.g.apply(SKY, { ...order, island: id(off.g, off.island) })).toMatchObject({ ok: false, code: 'blocked' });
  });

  it('does not start a reserved hardpoint after ownership or its Sky segment is lost', () => {
    const { g, s, island } = arena();
    expect(g.apply(SKY, { kind: 'queue_add', item: 'island_mortar', island: id(g, island) })).toEqual({ ok: true });
    s.setSide(island, RED);
    s.updateProduction();
    expect(s.armies[BLUE]!.queue[0]!.reason).toBe('not_held');
    expect(island.hardpoint).toBe(0);
    s.setSide(island, BLUE);
    s.armies[BLUE]!.spire.sky.hp = 0;
    s.updateProduction();
    expect(s.armies[BLUE]!.queue[0]!.reason).toBe('segment_destroyed');
    expect(island.hardpoint).toBe(0);
  });

  it('inherits a lowered berth immediately and frees a funded site without disturbing the main slot', () => {
    const { g, s, island } = arena();
    island.elevation = -8;
    const main = s.add('aerie', BLUE, 'sky', island.x, island.y);
    main.link = island.id;
    island.link = main.id;
    expect(g.apply(SKY, { kind: 'queue_add', item: 'island_mortar', island: id(g, island) })).toEqual({ ok: true });
    s.updateProduction();
    const mortar = s.alive(island.hardpoint)!;
    expect([mortar.x, mortar.y, mortar.elevation]).toEqual([island.x, island.y, -8]);
    const entry = g.observe(SKY, 0).queue[0]!;
    expect(g.apply(SKY, { kind: 'queue_cancel', entry: entry.id })).toEqual({ ok: true });
    expect(mortar.dead).toBe(true);
    expect(island.hardpoint).toBe(0);
    expect(island.link).toBe(main.id);
    expect(g.apply(SKY, { kind: 'queue_add', item: 'island_mortar', island: id(g, island) })).toEqual({ ok: true });
  });

  it('launches Aerie-produced aircraft at the producer berth height', () => {
    const { g, s, island } = arena();
    const aerie = s.add('aerie', BLUE, 'sky', island.x, island.y);
    aerie.link = island.id;
    aerie.elevation = island.elevation = -8;
    island.link = aerie.id;
    expect(g.apply(SKY, { kind: 'queue_add', item: 'interceptor', producer: id(g, aerie) })).toEqual({ ok: true });
    for (let tick = 0; tick <= s.stats.interceptor.build; tick++) s.updateProduction();
    const air = s.ents.find((e) => !e.dead && e.side === BLUE && e.kind === 'interceptor')!;
    expect(air.elevation).toBe(-8);
    expect(air.skyIsland).toBe(island.id);
    expect(air.plane).toBe('sky');
  });
});

describe('Island Mortar targeting and the shared projectile engine', () => {
  it('accepts ordinary static attack and stop, but not movement or another seat\'s orders', () => {
    const a = battery();
    const { g, s, mortar, target } = a;
    expect(g.apply(SKY, { kind: 'attack', units: [id(g, mortar)], target: id(g, target) })).toEqual({ ok: true });
    expect(mortar.order).toEqual({ k: 'attack', target: target.id });
    expect(g.apply(SKY, { kind: 'stop', units: [id(g, mortar)] })).toEqual({ ok: true });
    expect(mortar.order.k).toBe('none');
    expect(g.apply(SKY, { kind: 'move', units: [id(g, mortar)], x: 20, y: 20 })).toMatchObject({ ok: false, code: 'not_your_unit' });
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'attack', units: [id(g, mortar)], target: id(g, target) })).toMatchObject({ ok: false, code: 'wrong_plane' });
    // Red must see the mortar to name it at all; seen, it still cannot order it.
    for (const plane of [PLANE_INDEX.surface, PLANE_INDEX.sky]) s.vis[plane]!.fill(s.armies[BLUE]!.group.bit | s.armies[RED]!.group.bit);
    s.noteSightings();
    expect(g.apply({ team: 'se', role: 'sky' }, { kind: 'attack', units: [id(g, mortar, 'se')], target: id(g, target, 'se') }).ok).toBe(false);
  });

  it('acquires only actually visible Surface targets, at no more than eight centre-to-centre tiles', () => {
    const { g, s, mortar, target } = battery();
    target.x = mortar.x + 8;
    s.buildIndex();
    expect(s.acquire(mortar, 8, false)?.id).toBe(target.id);
    expect(s.inRange(mortar, target)).toBe(true);
    target.x += 0.01;
    s.buildIndex();
    expect(s.inRange(mortar, target)).toBe(false);
    expect(s.acquire(mortar, 8, false)).toBeUndefined();
    target.x = mortar.x + 4;
    s.vis[PLANE_INDEX.surface]!.fill(0);
    s.buildIndex();
    expect(s.acquire(mortar, 8, false)).toBeUndefined();
    expect(g.apply(SKY, { kind: 'attack', units: [id(g, mortar)], target: id(g, target) })).toMatchObject({ ok: false, code: 'not_visible' });
    const air = s.add('gunship', RED, 'sky', mortar.x + 1, mortar.y);
    s.noteSightings();
    expect(g.apply(SKY, { kind: 'attack', units: [id(g, mortar)], target: id(g, air) })).toMatchObject({ ok: false, code: 'invalid_target' });
    expect(s.canHit(mortar, 'surface')).toBe(true);
    for (const plane of ['sky', 'orbit', 'depths'] as const) expect(s.canHit(mortar, plane)).toBe(false);
    expect(s.stats.island_mortar.vision).toBe(0);
    expect(s.capable(mortar, 'spotterDown')).toBe(false);
  });

  it.each([undefined, 3.5])('compiles the public minimum flight duration %s into authoritative projectile ticks', configured => {
    const { s, island } = arena(configured === undefined ? {} : { mortarFlightTime: configured });
    const seconds = configured ?? 2;
    expect(s.rules.sky.mortarFlightTime).toBe(seconds);
    expect(s.econ.mortarFlightTicks).toBe(seconds * TICK_RATE);
    const mortar = mount(s, island);
    const target = s.add('tank', RED, 'surface', mortar.x, mortar.y);
    s.fire(mortar, target);
    expect(s.projectiles[0]!.arrive - s.tick).toBe(seconds * TICK_RATE);
    expect(s.fx.find(record => record.fx.src === mortar.id)?.fx.arrive).toBe(s.tick + seconds * TICK_RATE);
  });

  it('telegraphs a finite slow round, lands direct and splash damage only at arrival, and never hits allies', () => {
    const a = battery();
    const { s, mortar, target } = a;
    const nearby = s.add('tank', RED, 'surface', target.x + 1.5, target.y);
    const ally = s.add('tank', BLUE, 'surface', target.x + 1, target.y);
    nearby.cd = ally.cd = 1e9;
    s.buildIndex();
    const hp = target.hp, nearbyHp = nearby.hp, allyHp = ally.hp;
    shoot(a);
    const p = s.projectiles[0]!;
    expect(p).toMatchObject({ source: 'island_mortar', plane: 'surface', w: 'bomb', homing: false, x: target.x, y: target.y, splash: 2.5 });
    expect(p.arrive - s.tick).toBe(Math.max(s.econ.mortarFlightTicks, Math.ceil(4 / 5 * TICK_RATE)));
    expect(p.arrive - s.tick).toBeGreaterThanOrEqual(2 * TICK_RATE);
    expect(mortar.cd).toBe(6 * TICK_RATE);
    expect(s.fx.find((e) => e.fx.kind === 'shot' && e.fx.src === mortar.id)?.fx).toMatchObject({ tx: target.x, ty: target.y, tp: 'surface', arrive: p.arrive });
    s.tick = p.arrive - 1;
    s.landProjectiles();
    expect(target.hp).toBe(hp);
    expect(nearby.hp).toBe(nearbyHp);
    s.tick++;
    s.landProjectiles();
    expect(target.hp).toBeCloseTo(hp - 60 * s.weaponVs('bomb', target), 6);
    expect(nearby.hp).toBeCloseTo(nearbyHp - 60 * s.econ.splashFactor * s.weaponVs('bomb', nearby), 6);
    expect(ally.hp).toBe(allyHp);
    expect(s.projectiles).toHaveLength(0);
  });

  it('keeps the fired ground point when the target evades and the island moves', () => {
    const a = battery();
    const { s, mortar, target } = a;
    shoot(a);
    const p = s.projectiles[0]!;
    const aim = { x: p.x, y: p.y };
    const hp = target.hp;
    target.x += 6;
    mortar.x -= 3;
    s.buildIndex();
    s.tick = p.arrive;
    s.landProjectiles();
    expect({ x: p.x, y: p.y }).toEqual(aim);
    expect(target.hp).toBe(hp);
  });
});

describe('Island Mortar island lifecycle', () => {
  it('targets a hostile hardpoint before its main slot when ordered to attack the island', () => {
    const { g, s, island } = arena();
    const mortar = mount(s, island);
    const aerie = s.add('aerie', BLUE, 'sky', island.x, island.y);
    aerie.link = island.id;
    island.link = aerie.id;
    const raider = s.spawnUnit(RED, 'interceptor', 'sky');
    raider.x = island.x; raider.y = island.y;
    s.vis[PLANE_INDEX.sky]!.fill(s.armies[RED]!.group.bit);
    expect(g.apply({ team: 'se', role: 'sky' }, { kind: 'attack', units: [id(g, raider, 'se')], target: id(g, island, 'se') })).toEqual({ ok: true });
    expect(raider.order).toEqual({ k: 'attack', target: mortar.id });
    s.kill(mortar);
    expect(island.hardpoint).toBe(0);
    expect(island.link).toBe(aerie.id);
  });

  it('blocks hostile capture until destroyed, then frees its hardpoint', () => {
    const { g, s, island } = arena();
    const mortar = mount(s, island);
    const raider = s.spawnUnit(RED, 'interceptor', 'sky');
    raider.cd = 1e9;
    raider.x = island.x; raider.y = island.y;
    expect(g.apply({ team: 'se', role: 'sky' }, { kind: 'capture', units: [id(g, raider, 'se')], island: id(g, island, 'se') })).toEqual({ ok: true });
    steps(g, s.econ.captureTicks * 2);
    expect(island.side).toBe(BLUE);
    expect(island.state).toBe('contested');
    expect(mortar.hp).toBe(mortar.maxHp);
    s.damage(mortar, mortar.hp + 1, RED);
    steps(g, s.econ.captureTicks + 10);
    expect(island.side).toBe(RED);
    expect(island.hardpoint).toBe(0);
  });

  it('rides drift and a real Surface mooring transition without changing plane or ownership, and fires at either height', () => {
    const a = battery();
    const { g, s, island, mortar, target } = a;
    mortar.cd = 1e9;
    const start = { x: island.x, y: island.y };
    steps(g, 20);
    expect({ x: island.x, y: island.y }).not.toEqual(start);
    expect([mortar.x, mortar.y, mortar.elevation]).toEqual([island.x, island.y, 0]);
    const tower = s.add('mooring_tower', BLUE, 'surface', island.x, island.y);
    visible(s);
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'moor', tower: id(g, tower), island: id(g, island) })).toEqual({ ok: true });
    steps(g, s.econ.mooringTravelTicks + 2);
    expect(island.mooringPhase).toBe(2);
    expect(island.elevation).toBe(-8);
    expect([mortar.x, mortar.y, mortar.elevation]).toEqual([island.x, island.y, -8]);
    expect(mortar.plane).toBe('sky');
    expect(island.side).toBe(BLUE);
    expect(mortar.side).toBe(BLUE);
    target.x = mortar.x + 4; target.y = mortar.y;
    target.hp = target.maxHp;
    mortar.cd = 0;
    visible(s);
    s.buildIndex();
    shoot(a);
    expect(s.projectiles[0]!.sourceElevation).toBe(-8);
    expect(s.projectiles[0]!.plane).toBe('surface');
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'unmoor', tower: id(g, tower) })).toEqual({ ok: true });
    for (let n = 0; n < 6000 && island.mooringPhase; n++) g.step();
    expect(island.mooringPhase).toBe(0);
    expect(mortar.elevation).toBe(0);
    expect(mortar.link).toBe(island.id);
    expect(island.hardpoint).toBe(mortar.id);
  });
});
