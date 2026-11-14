import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { CELL, DEFAULT_RULES, ECON, OBS_GRID, SPIRE_HP, STATS, SUN, TICK_RATE, eventSchema, observationSchema, sunAngleAt, sunHalfWidth, sunLit, sunOffset, sunSpeedOf, toTicks, type Plane, type ArmyId } from '../src/rules/contract.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';
import { MAX_ARMIES } from '../src/rules/vocabulary.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { HOLE, PLANE_INDEX, VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { PAYLOADS, resolvePayloads } from '../src/rules/payload.ts';
import { entityOut } from '../src/agent/present.ts';
import { entitySchema, fxSchema } from '../src/rules/contract.ts';

const id = (g: AgentCommandGame, e: Ent, team: ArmyId = 'nw'): string => g.entityId(team, e.id);
/** Cell index on the default-size maps every fixture here uses. */
const cell = (x: number, y: number): number => y * DEFAULT_RULES.map.size + x;
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const own = (g: AgentCommandGame, team: ArmyId, kind: Ent['kind']): Ent[] => g.sim.ents.filter((e) => e.side === slotOfArmyId(team, 2) && e.kind === kind && !e.dead);
const removeAll = (g: AgentCommandGame, pred: (e: Ent) => boolean): void => {
  for (const e of g.sim.ents) if (pred(e)) e.hp = 0;
  g.step();
};

describe('authoritative state hash', () => {
  const changes: [string, (g: AgentCommandGame, e: Ent) => void][] = [
    ['same-length kind', (_g, e) => { e.kind = 'sapper'; }],
    ['side', (_g, e) => { e.side = 1; }],
    ['state', (_g, e) => { e.state = 'moving'; }],
    ['velocity x', (_g, e) => { e.vx = 0.125; }],
    ['velocity y', (_g, e) => { e.vy = -0.125; }],
    ['cooldown', (_g, e) => { e.cd++; }],
    ['work progress', (_g, e) => { e.workT++; }],
    ['engagement', (_g, e) => { e.engage++; }],
    ['order kind', (_g, e) => { e.order = { k: 'attack', target: 123 }; }],
    ['order target', (_g, e) => { if (e.order.k === 'move') e.order.x++; }],
    ['queued order target', (_g, e) => { e.queue[0] = { k: 'attack', target: 124 }; }],
    ['projectile damage', (g) => { g.sim.projectiles[0]!.dmg++; }],
    ['projectile arrival', (g) => { g.sim.projectiles[0]!.arrive++; }],
    ['charge deadline', (g) => { g.sim.charges[0]!.at++; }],
    ['charge defusing', (g) => { g.sim.charges[0]!.defuse++; }],
    ['charge knowledge', (g) => { g.sim.charges[0]!.known |= 2; }],
    ['flood cells', (g) => { g.sim.floods[0]!.cells[0] = 44; }],
    ['flood deadline', (g) => { g.sim.floods[0]!.nextAt++; }],
    ['flood limit', (g) => { g.sim.floods[0]!.limit++; }],
    ['flood orbit', (g) => { g.sim.floods[0]!.orbit = true; }],
    ['lode pressure', (g) => { g.sim.lodePressure += 1; }],
    ['lode cooling', (g) => { g.sim.lodeCoolUntil += 1; }],
    ['lode window', (g) => { g.sim.lodeWindow[3] = 1; }],
    ['RNG state', (g) => { g.sim.rng.next(); }],
    ['solar bank', (g) => { g.sim.armies[0]!.energyBank += 1; }],
  ];
  it.each(changes)('detects divergence in %s before another tick', (_name, change) => {
    const g = createGame({ seed: 7 });
    const e = g.sim.add('digger', 0, 'depths', 12.5, 12.5);
    e.order = { k: 'move', x: 15.5, y: 12.5, fight: false, speed: 0 };
    e.queue = [{ k: 'attack', target: 123 }];
    g.sim.projectiles.push({
      by: 0, source: 'tank', sourcePlane: 'surface', w: 'cannon', dmg: 10, splash: 1, plane: 'surface',
      sourceElevation: 0, targetElevation: 0,
      x: 24, y: 24, target: 123, homing: false, arrive: 20, reserved: 10,
    });
    g.sim.charges.push({ side: 0, c: 42, at: 20, defuse: 0, stack: 1, reach: g.sim.econ.chasmReach, known: 1 });
    const knownAt = new Int32Array(MAX_ARMIES).fill(-1);
    knownAt[0] = 42;
    g.sim.floods.push({ side: 0, origin: 42, cells: [42, 43], limit: 7, orbit: false, nextAt: 20, coolAt: 100, knownAt });
    const twin = g.clone();
    const before = g.stateHash();
    expect(twin.stateHash()).toBe(before);
    change(g, e);
    expect(g.stateHash()).not.toBe(before);
    expect(twin.stateHash()).toBe(before);
  });
});

describe('depths economy', () => {
  it('dig, mine and haul ore turns into alloy at the Spire', () => {
    const setup = (): AgentCommandGame => {
      const g = createGame({ seed: 7, options: { map: { params: { spireInset: 8 } } } });
      for (const [x, y] of [
        [11, 8],
        [12, 8],
        [11, 9],
      ] as const) {
        g.sim.cells[cell(x, y)] = CELL.ore;
        g.sim.ore[cell(x, y)] = 6;
      }
      steps(g, VISION_EVERY); // diggers see the new walls
      return g;
    };
    const mining = setup();
    const idle = setup();
    expect(mining.observe({ team: 'nw', role: 'depths' }, 0).depths![cell(11, 8)]).toBe(CELL.ore);
    const diggers = own(mining, 'nw', 'digger');
    expect(act(mining, 'nw', 'depths', { kind: 'mine', units: diggers.map((d) => id(mining, d)) })).toEqual({ ok: true });
    steps(mining, toTicks(90));
    steps(idle, toTicks(90));
    const mined = mining.sim.armies[0]!.stats.alloyMined;
    expect(mined).toBeGreaterThanOrEqual(80);
    // Every mined load reached the stockpile (same trickle in both games).
    expect(mining.sim.armies[0]!.alloy - idle.sim.armies[0]!.alloy).toBeCloseTo(mined, 6);
    expect(mining.report('nw').armies[0]!.stats.alloyMined).toBe(mined);
    const left = [cell(11, 8), cell(12, 8), cell(11, 9)].reduce((n, c) => n + mining.sim.ore[c]!, 0);
    expect(left).toBeLessThan(18);
  });

  it('dig tunnels through rock and the team learns the new cells', () => {
    const g = createGame({ seed: 7, options: { map: { params: { spireInset: 8 } } } });
    for (let y = 11; y <= 14; y++) g.sim.cells[cell(8, y)] = CELL.rock;
    const [digger] = own(g, 'nw', 'digger');
    expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, digger!)], x: 8, y: 14 })).toEqual({ ok: true });
    expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, digger!)], x: 0, y: 0 })).toEqual({ ok: false, code: 'invalid_target' });
    steps(g, 4 * (ECON.digRock + toTicks(1)) + toTicks(4));
    for (let y = 11; y <= 14; y++) expect(g.sim.cells[cell(8, y)]).toBe(CELL.tunnel);
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).depths![cell(8, 14)]).toBe(CELL.tunnel);
    expect(g.observe({ team: 'se', role: 'depths' }, 0).depths![cell(8, 14)]).toBe(CELL.unknown);
  });
});

describe('sapper collapse', () => {
  it('collapses the surface: sinkhole, structure damage, surface units fall into the depths', () => {
    const g = createGame({ seed: 3, options: { map: { params: { spireInset: 8 } } } });
    const s = g.sim;
    const sapper = s.spawnUnit(0, 'sapper', 'depths');
    const trooper = own(g, 'nw', 'trooper')[0]!;
    trooper.x = 10.5;
    trooper.y = 10.6;
    g.step();
    expect(act(g, 'nw', 'depths', { kind: 'undermine', units: [id(g, sapper)], x: 10, y: 10 })).toEqual({ ok: true });
    steps(g, ECON.undermineTicks + toTicks(3));
    expect(s.holes[cell(10, 10)]).toBe(1);
    const obs = g.observe({ team: 'se', role: 'surface' }, 0);
    expect(obs.holes).toContainEqual({ x: 10, y: 10, kind: 'sinkhole' });
    expect(trooper.plane).toBe('depths');
    expect(trooper.hp).toBe(trooper.maxHp * 0.75);
    expect(s.cells[cell(10, 10)]).toBe(CELL.tunnel);
    expect(s.armies[0]!.spire.surface.hp).toBe(SPIRE_HP.surface - ECON.collapseDamage);
    const kinds = g.events({ team: 'nw', role: 'surface' }, 0).map((e) => e.kind);
    expect(kinds).toContain('collapse');
    expect(kinds).toContain('fell_into_depths');
    // The fallen trooper is now commanded from the depths seat, not the surface seat, and the sinkhole is no way back
    // up (only an own Shaft is).
    expect(act(g, 'nw', 'surface', { kind: 'stop', units: [id(g, trooper)] })).toEqual({ ok: false, code: 'wrong_plane' });
    expect(act(g, 'nw', 'depths', { kind: 'transfer', units: [id(g, trooper)], to: 'surface' })).toEqual({ ok: false, code: 'no_shaft' });
  });

  it('surface units route around sinkholes instead of crossing them', () => {
    const g = createGame({ seed: 3, options: { terrain: 'open' } });
    const s = g.sim;
    const trench: number[] = [];
    for (let y = 14; y <= 30; y++) for (let x = 18; x <= 20; x++) trench.push(cell(x, y));
    s.openCells(trench, HOLE.sinkhole, NEUTRAL);
    const t = own(g, 'nw', 'trooper')[0]!;
    t.x = 15.5;
    t.y = 22.5;
    // A move into the trench snaps to the nearest open rim cell, ties toward the unit (the west rim).
    expect(act(g, 'nw', 'surface', { kind: 'move', units: [id(g, t)], x: 19.5, y: 20.5 })).toEqual({ ok: true });
    const rim = t.order as { k: string; x: number; y: number };
    expect([rim.k, rim.x, rim.y]).toEqual(['move', 17.5, 20.5]);
    expect(act(g, 'nw', 'surface', { kind: 'move', units: [id(g, t)], x: 24.5, y: 22.5 })).toEqual({ ok: true });
    for (let i = 0; i < toTicks(40) && Math.hypot(t.x - 24.5, t.y - 22.5) > 0.01; i++) {
      g.step();
      expect(s.holes[cell(Math.floor(t.x), Math.floor(t.y))]).toBe(0);
    }
    expect(Math.hypot(t.x - 24.5, t.y - 22.5)).toBeLessThan(0.01);
  });
});

describe('shafts, fortify and depths alarms', () => {
  it('a shaft opens a tunnel below and works as ore drop-off and trooper transfer point', () => {
    const g = createGame({ seed: 12, options: { map: { params: { spireInset: 8 } } } });
    const s = g.sim;
    for (const [x, y] of [
      [12, 12],
      [12, 13],
    ] as const) s.cells[cell(x, y)] = CELL.rock;
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'shaft', x: 12, y: 12 })).toEqual({ ok: true });
    steps(g, STATS.shaft.build + 1);
    expect(g.events({ team: 'nw', role: 'surface' }, 0).some((e) => e.kind === 'constructed' && e.subject === 'shaft')).toBe(true);
    expect(s.cells[cell(13, 13)]).toBe(CELL.tunnel);

    // A loaded digger in a pocket next to the shaft (cut off from the Spire) delivers there.
    s.cells[cell(12, 13)] = CELL.tunnel;
    const digger = s.spawnUnit(0, 'digger', 'depths');
    digger.x = 12.5;
    digger.y = 13.5;
    digger.carry = 40;
    expect(act(g, 'nw', 'depths', { kind: 'mine', units: [id(g, digger)] })).toEqual({ ok: true });
    steps(g, toTicks(1));
    expect(digger.carry).toBe(0);
    expect(s.armies[0]!.stats.alloyMined).toBe(40);

    const trooper = own(g, 'nw', 'trooper')[0]!;
    trooper.x = 14.5;
    trooper.y = 13.5;
    expect(act(g, 'nw', 'surface', { kind: 'transfer', units: [id(g, trooper)], to: 'depths' })).toEqual({ ok: true });
    steps(g, toTicks(1.5));
    expect(trooper.plane).toBe('depths');
    expect(cell(Math.floor(trooper.x), Math.floor(trooper.y))).toBe(cell(13, 13));
  });

  it('fortify hardens a rock wall of an own tunnel for free and never fills a tunnel; enemy sappers in your tunnels raise an alarm', () => {
    const g = createGame({ seed: 12, options: { map: { params: { spireInset: 8 } } } });
    const s = g.sim;
    for (let y = 11; y <= 16; y++) {
      s.cells[cell(8, y)] = CELL.tunnel;
      s.owner[cell(8, y)] = 1;
    }
    s.cells[cell(9, 13)] = CELL.rock;
    steps(g, VISION_EVERY); // Observe the hand-carved corridor rather than relying on this seed's old lode layout.
    const digger = own(g, 'nw', 'digger')[0]!;
    const alloy = s.armies[0]!.alloy;
    expect(act(g, 'nw', 'depths', { kind: 'fortify', units: [id(g, digger)], x: 8, y: 13 })).toEqual({ ok: false, code: 'invalid_target' });
    expect(act(g, 'nw', 'depths', { kind: 'fortify', units: [id(g, digger)], x: 9, y: 13 })).toEqual({ ok: true });
    const ticks = ECON.fortifyTicks + toTicks(4);
    steps(g, ticks);
    expect(s.cells[cell(9, 13)]).toBe(CELL.fortified);
    expect(s.cells[cell(8, 13)]).toBe(CELL.tunnel);
    expect(ECON.fortifyCost).toBe(0);
    expect(s.armies[0]!.alloy).toBeCloseTo(alloy + (ticks * ECON.spireAlloyRate) / TICK_RATE, 6);

    const intruder = s.spawnUnit(1, 'sapper', 'depths');
    intruder.x = 8.5;
    intruder.y = 11.5;
    steps(g, VISION_EVERY);
    const alarm = g.events({ team: 'nw', role: 'depths' }, 0).find((e) => e.kind === 'enemy_sapper_seen');
    expect(alarm).toMatchObject({ plane: 'depths', subject: 'sapper', side: 'se' });
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).entities.some((e) => e.id === id(g, intruder))).toBe(true);
  });
});

describe('relays', () => {
  it('a relay gives its team surface vision under its (moving) island', () => {
    const g = createGame({ seed: 8 });
    const s = g.sim;
    const island = s.ents
      .filter((e) => e.kind === 'island')
      .reduce((a, b) => (Math.hypot(a.x - 8, a.y - 8) > Math.hypot(b.x - 8, b.y - 8) ? a : b));
    s.setSide(island, 0);
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'relay', island: id(g, island) })).toEqual({ ok: true });
    const scout = s.spawnUnit(1, 'flak', 'surface');
    const follow = (): void => {
      scout.x = island.x;
      scout.y = island.y;
      scout.order = { k: 'none' };
    };
    follow();
    g.step();
    expect(s.aliasOf(0, scout.id)).toBe(0); // never seen, so no view can name it
    for (let i = 0; i <= STATS.relay.build; i++) {
      g.step();
      follow();
    }
    g.step();
    expect(island.link).not.toBe(0);
    expect(g.view('nw').entities.some((e) => e.id === id(g, scout))).toBe(true);
  });
});

describe('energy', () => {
  // Arrays anchor at once and earn their full rate anywhere: these tests measure light, cap and bank alone.
  const flat = { orbit: { solarDeployTime: 0, solarRampStart: 1, solarFarFactor: 1, solarShadePer: 0, solarNight: 0 } };
  it('delivery is capped by the Spire base plus relays', () => {
    const g = createGame({ seed: 5, options: flat });
    const s = g.sim;
    while (own(g, 'nw', 'solar').length < 6) s.spawnUnit(0, 'solar', 'orbit');
    own(g, 'nw', 'solar').forEach((a, i) => {
      // on the lit wedge's centre line at tick 0
      a.x = g.sim.size / 2 + (6 + 1.5 * i) * Math.cos(SUN.startAngle);
      a.y = g.sim.size / 2 + (6 + 1.5 * i) * Math.sin(SUN.startAngle);
    });
    g.step();
    let res = g.observe({ team: 'nw', role: 'orbit' }, 0).res;
    expect(res.solarRate).toBe(6 * ECON.solarRate);
    expect(res.energyCap).toBe(ECON.baseEnergyCap);
    expect(res.energyRate).toBe(ECON.baseEnergyCap);
    const e0 = s.armies[0]!.energy;
    steps(g, toTicks(10));
    expect(s.armies[0]!.energy - e0).toBeCloseTo(ECON.baseEnergyCap * 10, 6);

    const island = s.ents.find((e) => e.kind === 'island')!;
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'relay', island: id(g, island) })).toEqual({ ok: false, code: 'not_held' });
    s.setSide(island, 0);
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'relay', island: id(g, island) })).toEqual({ ok: true });
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'relay', island: id(g, island) })).toEqual({ ok: false, code: 'occupied' });
    steps(g, STATS.relay.build + 1);
    res = g.observe({ team: 'nw', role: 'orbit' }, 0).res;
    expect(res.energyCap).toBe(ECON.baseEnergyCap + ECON.relayEnergyCap);
    expect(res.energyRate).toBe(ECON.baseEnergyCap + ECON.relayEnergyCap);
  });

  it('centres daylight on each map size and preserves point symmetry', () => {
    for (const size of [48, 64, 80]) for (const angle of [0, 0.7, 2.1]) {
      const x = size / 2 + 10 * Math.cos(angle);
      const y = size / 2 + 10 * Math.sin(angle);
      expect(sunOffset(x, y, angle, size, 2)).toBeCloseTo(0, 9);
      expect(sunLit(x, y, angle, size, 2)).toBe(true);
      expect(sunLit(size - x, size - y, angle, size, 2)).toBe(true);
      expect(sunLit(size / 2 - 10 * Math.sin(angle), size / 2 + 10 * Math.cos(angle), angle, size, 2)).toBe(false);
    }
  });

  it('solar arrays only produce inside the two lit wedges, which turn around the centre', () => {
    const g = createGame({ seed: 5, options: flat });
    const arrays = own(g, 'nw', 'solar');
    // A quarter turn off the wedges at tick 0: dark. Mirror pair (point-symmetric positions) shares the light.
    const dark = SUN.startAngle + Math.PI / 2;
    arrays[0]!.x = g.sim.size / 2 + 10 * Math.cos(dark);
    arrays[0]!.y = g.sim.size / 2 + 10 * Math.sin(dark);
    arrays[1]!.x = g.sim.size - arrays[0]!.x;
    arrays[1]!.y = g.sim.size - arrays[0]!.y;
    for (const a of arrays) a.order = { k: 'none' };
    g.step();
    let obs = g.observe({ team: 'nw', role: 'orbit' }, 0);
    const matchData = g.matchData({ team: 'nw', role: 'orbit' });
    expect(obs.res.solarRate).toBe(0);
    expect(matchData.sun.speed).toBeCloseTo(sunSpeedOf(ECON.sunPeriodTicks, g.sim.sunWedges), 9);
    expect(matchData.sun.half).toBeCloseTo(sunHalfWidth(g.sim.sunWedges), 9);
    // Half a period later the wedges have turned a quarter turn: both arrays are on the centre lines.
    steps(g, ECON.sunPeriodTicks / 2 - 1);
    obs = g.observe({ team: 'nw', role: 'orbit' }, 0);
    expect(obs.sun.angle).toBeCloseTo(sunAngleAt(g.tick, g.sim.sunSpeed), 9);
    expect(Math.abs(sunOffset(arrays[0]!.x, arrays[0]!.y, obs.sun.angle, g.sim.size, g.sim.sunWedges))).toBeLessThan(0.01);
    expect(obs.res.solarRate).toBe(ECON.solarRate * 2);
    for (const [x, y] of [
      [arrays[0]!.x, arrays[0]!.y],
      [5, 30],
      [17.3, 2.2],
    ]) {
      for (let tick = 0; tick < ECON.sunPeriodTicks * 2; tick += 7) expect(sunLit(x!, y!, sunAngleAt(tick, g.sim.sunSpeed), g.sim.size, g.sim.sunWedges)).toBe(sunLit(g.sim.size - x!, g.sim.size - y!, sunAngleAt(tick, g.sim.sunSpeed), g.sim.size, g.sim.sunWedges));
    }
  });

});

describe('plannable world', () => {
  it('island paths and the schedule in observations predict the future exactly', () => {
    const g = createGame({ seed: 9 });
    const obs = g.observe({ team: 'se', role: 'sky' }, 0);
    const matchData = g.matchData({ team: 'se', role: 'sky' });
    expect(obs.islands).toHaveLength(DEFAULT_RULES.map.islandRings * 2);
    const ahead = toTicks(47);
    const predicted = obs.islands.map((i) => {
      const a = i.phase + (i.speed * ahead) / TICK_RATE;
      return { id: i.id, x: i.cx + i.r * Math.cos(a), y: i.cy + i.r * Math.sin(a) };
    });
    const spawnAt = obs.schedule.find((s) => s.kind === 'asteroid_spawn')!.tick;
    expect(toTicks(matchData.rules.spire.timeCap)).toBe(toTicks(DEFAULT_RULES.spire.timeCap));
    const count = (): number => g.sim.ents.filter((e) => e.kind === 'asteroid' && !e.dead).length;
    const before = count();
    steps(g, spawnAt - 1);
    expect(count()).toBe(before);
    g.step();
    expect(count()).toBe(before + 2);
    expect(g.observe({ team: 'se', role: 'sky' }, 0).schedule.find((s) => s.kind === 'asteroid_spawn')!.tick).toBe(spawnAt + ECON.asteroidSpawnTicks);
    steps(g, ahead - g.tick);
    for (const p of predicted) {
      const isl = g.sim.byId.get(g.sim.aliasTarget(g.sim.armyIndex('se'), Number(p.id.slice(2))))!;
      expect(isl.x).toBeCloseTo(p.x, 6);
      expect(isl.y).toBeCloseTo(p.y, 6);
    }
  });
});

describe('asteroid mining API', () => {
  function fixture() {
    const g = createGame({ seed: 31, options: { orbit: { maxAsteroids: 0 } } });
    const s = g.sim;
    const tug = s.spawnUnit(0, 'tug', 'orbit');
    const rock = s.add('asteroid', NEUTRAL, 'orbit', 20, 20);
    rock.state = 'drifting';
    rock.resourceType = 'metal';
    rock.resourceRemaining = s.rocks.medium.dock;
    s.vis[PLANE_INDEX.orbit]!.fill(s.armies[0]!.group.bit);
    s.noteSightings();
    const intent = { kind: 'mine_asteroid', units: [id(g, tug)], asteroid: id(g, rock) } as const;
    return { g, s, tug, rock, intent: { ...intent, units: [...intent.units] } };
  }

  it('dispatches and queues mining with visible waypoints and the original target', () => {
    const { g, s, tug, rock, intent } = fixture();
    expect(act(g, 'nw', 'orbit', intent)).toEqual({ ok: true });
    expect(tug.order).toEqual({ k: 'mine_asteroid', asteroid: rock.id, returning: false, site: { x: rock.x, y: rock.y, vx: rock.vx, vy: rock.vy, tick: s.tick } });
    expect(act(g, 'nw', 'orbit', { ...intent, queue: true })).toEqual({ ok: true });
    expect(tug.queue).toEqual([{ k: 'mine_asteroid', asteroid: rock.id, returning: false, site: { x: rock.x, y: rock.y, vx: rock.vx, vy: rock.vy, tick: s.tick } }]);
    const target = entityOut(s, rock, 'nw');
    expect(entityOut(s, tug, 'nw')).toMatchObject({ tx: target.x, ty: target.y, wp: [{ x: target.x, y: target.y }], queue: 1 });
    tug.order = { k: 'mine_asteroid', asteroid: rock.id, returning: true };
    const dock = entityOut(s, s.armies[0]!.spire.orbit, 'nw');
    expect(entityOut(s, tug, 'nw')).toMatchObject({ tx: dock.x, ty: dock.y });
  });

  it('hashes the mining target and trip phase and releases a miner without discarding cargo', () => {
    const { g, tug, rock, intent } = fixture();
    expect(act(g, 'nw', 'orbit', intent)).toEqual({ ok: true });
    const outbound = g.stateHash();
    tug.order = { k: 'mine_asteroid', asteroid: rock.id, returning: true };
    expect(g.stateHash()).not.toBe(outbound);
    tug.order = { k: 'mine_asteroid', asteroid: rock.id + 1, returning: false };
    expect(g.stateHash()).not.toBe(outbound);
    tug.order = { k: 'mine_asteroid', asteroid: rock.id, returning: false };
    tug.miningTarget = rock.id;
    rock.miningTug = tug.id;
    tug.cargoAlloy = 12.5;
    tug.cargoEnergy = 7.5;
    expect(act(g, 'nw', 'orbit', { kind: 'release', units: [id(g, tug)] })).toEqual({ ok: true });
    expect(tug.order.k).toBe('none');
    expect(tug.miningTarget).toBe(0);
    expect(rock.miningTug).toBe(0);
    expect(tug.cargoAlloy).toBe(12.5);
    expect(tug.cargoEnergy).toBe(7.5);
  });

  it('rejects hidden or non-resource targets, wrong units, towing and missing own docks atomically', () => {
    const { g, s, tug, rock, intent } = fixture();
    const solar = s.spawnUnit(0, 'solar', 'orbit');
    expect(act(g, 'nw', 'orbit', { ...intent, units: [id(g, tug), id(g, solar)] })).toEqual({ ok: false, code: 'wrong_kind' });
    expect(tug.order.k).toBe('none');
    rock.resourceType = 'slag';
    expect(act(g, 'nw', 'orbit', intent)).toEqual({ ok: false, code: 'invalid_target' });
    rock.resourceType = 'ice';
    rock.resourceRemaining = 0;
    expect(act(g, 'nw', 'orbit', intent)).toEqual({ ok: false, code: 'invalid_target' });
    rock.resourceRemaining = 120;
    rock.state = 'falling';
    s.vis[PLANE_INDEX.orbit]!.fill(0);
    expect(act(g, 'nw', 'orbit', intent)).toEqual({ ok: false, code: 'not_visible' });
    s.vis[PLANE_INDEX.orbit]!.fill(s.armies[0]!.group.bit);
    expect(act(g, 'nw', 'orbit', intent)).toEqual({ ok: false, code: 'invalid_target' });
    rock.state = 'drifting';
    tug.link = rock.id;
    expect(act(g, 'nw', 'orbit', intent)).toEqual({ ok: false, code: 'occupied' });
    tug.link = 0;
    s.armies[0]!.spire.orbit.hp = 0;
    expect(act(g, 'nw', 'orbit', intent)).toEqual({ ok: false, code: 'segment_destroyed' });
  });

  it('reveals resource details locally but never through public falls or hidden mining targets', () => {
    const { g, s, tug, rock } = fixture();
    rock.resourceType = 'ice';
    rock.volatile = true;
    rock.resourceRemaining = 42.5;
    tug.cargoAlloy = 3.25;
    tug.cargoEnergy = 6.5;
    tug.miningTarget = rock.id;
    tug.state = 'mining';
    tug.order = { k: 'mine_asteroid', asteroid: rock.id, returning: false };
    const seen = entityOut(s, rock, 'nw');
    expect(seen).toMatchObject({ resourceType: 'ice', volatile: true, resourceRemaining: 42.5 });
    expect(seen).not.toHaveProperty('composition');
    expect(validate(entitySchema, seen).ok).toBe(true);
    const miner = entityOut(s, tug, 'nw');
    expect(miner).toMatchObject({ cargoAlloy: 3.25, cargoEnergy: 6.5, miningTarget: id(g, rock), work: { x: seen.x, y: seen.y } });
    expect(validate(entitySchema, miner).ok).toBe(true);
    // Red, seeing the tug and its rock, still never learns what it mines.
    s.vis[PLANE_INDEX.orbit]!.fill(s.armies[0]!.group.bit | s.armies[1]!.group.bit);
    s.noteSightings();
    expect(entityOut(s, tug, 'se').miningTarget).toBeUndefined();
    rock.state = 'falling';
    s.vis[PLANE_INDEX.orbit]!.fill(0);
    const hidden = entityOut(s, rock, 'nw');
    expect(hidden.rockSize).toBe('medium');
    for (const field of ['resourceType', 'volatile', 'resourceRemaining', 'fuseUntil']) expect(hidden).not.toHaveProperty(field);
    expect(entityOut(s, tug, 'nw').miningTarget).toBeUndefined();
    expect(entityOut(s, tug, 'nw').tx).toBeUndefined();
    expect(entityOut(s, tug, 'nw').work).toBeUndefined();
    expect(entityOut(s, rock, 'observer').resourceType).toBe('ice');
  });

  it('accepts the nonpublic mining effect vocabulary and returning state', () => {
    for (const kind of ['mining_start', 'mining_depleted', 'mining_unload'] as const) {
      expect(validate(fxSchema, { kind, tick: 1, plane: 'orbit', x: 20, y: 20, side: 'nw', subject: kind === 'mining_depleted' ? 'asteroid' : 'tug', ...(kind === 'mining_start' ? { tx: 21, ty: 21 } : {}) }).ok).toBe(true);
    }
    const { s, tug } = fixture();
    tug.state = 'returning';
    expect(validate(entitySchema, entityOut(s, tug, 'nw')).ok).toBe(true);
  });
});

describe('asteroids', () => {
  it('resolves payload declarations from this match without changing the default drop', () => {
    expect(Object.keys(PAYLOADS)).toEqual(['asteroid', 'core']);
    expect(resolvePayloads(ECON).asteroid).toEqual({
      from: 'orbit',
      warning: ECON.impactTicks,
      fall: ECON.impactTicks,
      hp: ECON.asteroidHp,
      interceptable: true,
      impact: { damage: ECON.impactDamage, radius: ECON.impactRadius, crater: 1.5 },
      cause: 'impact',
    });
    const g = createGame({ seed: 11, options: { orbit: { impactDelay: 3, asteroidHp: 725, impactDamage: 275, impactRadius: 2, impactCraterRadius: 1, pebbleChance: 0, largeChance: 0, metalChance: 0, iceChance: 0, volatileChance: 0 } } });
    const s = g.sim;
    expect(s.payloads.asteroid).toEqual({
      from: 'orbit',
      warning: toTicks(3),
      fall: toTicks(3),
      hp: 725,
      interceptable: true,
      impact: { damage: 275, radius: 2, crater: 1 },
      cause: 'impact',
    });
    s.tick = s.nextAsteroidSpawn() - 1;
    g.step();
    const rock = s.ents.find((e) => e.kind === 'asteroid')!;
    expect(rock.hp).toBe(725);
    expect(rock.maxHp).toBe(725);
    const tug = s.spawnUnit(0, 'tug', 'orbit');
    tug.link = rock.id;
    rock.link = tug.id;
    rock.state = 'towed';
    s.deorbit(tug, rock, 24, 24);
    expect(tug.link).toBe(0);
    expect(rock.link).toBe(0);
    expect(rock.impactTick).toBe(s.tick + toTicks(3));
    expect(s.sees(1, rock)).toBe(true);
    s.noteSightings(); // what a step's end does: red names the falling rock it sees
    expect(g.observe({ team: 'se', role: 'surface' }, 0).impacts).toContainEqual({ x: 24, y: 24, tick: rock.impactTick, side: 'nw', id: id(g, rock, 'se') });
    const launch = s.fx.find((r) => r.fx.kind === 'deorbit')!.fx;
    expect(launch.plane).toBe(PAYLOADS.asteroid.drop.from);
    expect(launch.tx).toBe(24);
    expect(launch.ty).toBe(24);
  });

  it('drops a deorbit commanded in a decision round once every seat has applied, in the same tick', () => {
    const g = createGame({ seed: 11 });
    const s = g.sim;
    const rock = s.add('asteroid', NEUTRAL, 'orbit', 20, 20);
    const tug = s.spawnUnit(0, 'tug', 'orbit');
    tug.x = rock.x;
    tug.y = rock.y;
    tug.link = rock.id;
    rock.link = tug.id;
    rock.state = 'towed';
    const tick = s.tick;
    s.round(() => {
      expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'deorbit', units: [id(g, tug)], x: 22, y: 22 })).toEqual({ ok: true });
      // Later seats of the same round still see the tow (blue's drop cannot invalidate red's simultaneous orders).
      expect(rock.state).toBe('towed');
      expect(tug.link).toBe(rock.id);
    });
    expect(s.tick).toBe(tick);
    expect(rock.state).toBe('falling');
    expect(tug.link).toBe(0);
  });

  it('uses payload impact rules and retains the terminal render boundary', () => {
    const g = createGame({ seed: 11, options: { terrain: 'open', orbit: { impactDelay: 3, impactDamage: 275, impactRadius: 2, impactCraterRadius: 1 } } });
    const s = g.sim;
    const rock = s.add('asteroid', NEUTRAL, 'orbit', 24, 24);
    rock.hp = rock.maxHp = s.payloads.asteroid!.hp;
    const inside = s.add('turret', 1, 'surface', 25.5, 24.5);
    const outside = s.add('turret', 1, 'surface', 27.5, 24.5);
    const hp = inside.hp;
    expect(s.dropPayload(rock, 0, 24, 24)).toBe(true);
    const at = rock.impactTick;
    s.tick = at - 1;
    g.step();
    expect(inside.hp).toBe(hp - 275);
    expect(outside.hp).toBe(hp);
    expect(s.armies[0]!.stats.impacts).toBe(1);
    expect(s.byId.has(rock.id)).toBe(false);
    expect(s.fx.find((r) => r.fx.kind === 'impact')!.fx.fall).toEqual({ id: rock.id, x: 24, y: 24, tick: at });
    expect(s.holes[cell(24, 24)]).toBe(HOLE.crater);
    expect(s.holes[cell(25, 24)]).toBe(0);
  });

  it('keeps intercepted payload landing metadata without applying an impact', () => {
    const g = createGame({ seed: 11 });
    const s = g.sim;
    const rock = s.add('asteroid', NEUTRAL, 'orbit', 24, 24);
    expect(s.dropPayload(rock, 0, 24, 24)).toBe(true);
    const at = rock.impactTick;
    rock.hp = 0;
    rock.lastHitBy = 1;
    g.step();
    expect(s.armies[1]!.stats.interceptions).toBe(1);
    expect(s.armies[0]!.stats.impacts).toBe(0);
    expect(s.holeCount).toBe(0);
    expect(s.fx.find((r) => r.fx.kind === 'intercept')!.fx.fall).toEqual({ id: rock.id, x: 24, y: 24, tick: at });
    expect(s.byId.has(rock.id)).toBe(false);
  });

  const strike = (defenders: number) => {
    const g = createGame({ seed: 11, options: { map: { params: { spireInset: 8 } } } });
    const s = g.sim;
    removeAll(g, (e) => e.side === 1 && e.kind === 'interceptor');
    for (let i = 0; i < defenders; i++) {
      const d = s.spawnUnit(1, 'interceptor', 'sky');
      d.x = 39;
      d.y = 39;
    }
    const tug = s.spawnUnit(0, 'tug', 'orbit');
    tug.x = 36;
    tug.y = 36;
    const rock = s.add('asteroid', NEUTRAL, 'orbit', 37, 37);
    rock.hp = rock.maxHp = ECON.asteroidHp;
    rock.state = 'drifting';
    g.step();
    expect(act(g, 'nw', 'orbit', { kind: 'grapple', units: [id(g, tug)], asteroid: id(g, rock) })).toEqual({ ok: true });
    steps(g, toTicks(1));
    expect(tug.link).toBe(rock.id);
    expect(act(g, 'nw', 'orbit', { kind: 'deorbit', units: [id(g, tug)], x: 30, y: 10 })).toEqual({ ok: false, code: 'invalid_target' });
    expect(act(g, 'nw', 'orbit', { kind: 'deorbit', units: [id(g, tug)], x: 40, y: 40 })).toEqual({ ok: true });
    s.noteSightings(); // what a step's end does: red names the falling rock it sees
    const redObs = g.observe({ team: 'se', role: 'sky' }, 0);
    // The impact point sits on cell edges: presented one grid step toward the map centre (never on an edge).
    expect(redObs.impacts).toEqual([{ x: 40 - 1 / OBS_GRID, y: 40 - 1 / OBS_GRID, tick: g.tick + ECON.impactTicks, side: 'nw', id: id(g, rock, 'se') }]);
    expect(redObs.entities.some((e) => e.id === id(g, rock, 'se') && e.state === 'falling')).toBe(true);
    expect(g.events({ team: 'se', role: 'surface' }, 0).some((e) => e.kind === 'impact_incoming')).toBe(true);
    steps(g, ECON.impactTicks - 1);
    const impactDamage = rock.dead ? 0 : ECON.impactDamage * Math.max(0, rock.hp / rock.maxHp);
    steps(g, 2);
    return { g, impactDamage };
  };

  it('a deorbited asteroid hits the target: damage, craters into the depths, events', () => {
    const { g, impactDamage } = strike(0);
    const s = g.sim;
    // One impact, one segment: the Surface one, at ×spireImpactMultiplier; the Sky segment above it is untouched.
    expect(impactDamage).toBeGreaterThan(0);
    expect(s.armies[1]!.spire.surface.hp).toBe(SPIRE_HP.surface - impactDamage * ECON.spireImpactMultiplier);
    expect(s.armies[1]!.spire.sky.hp).toBe(SPIRE_HP.sky);
    expect(s.holes[cell(40, 40)]).toBe(2);
    expect(s.cells[cell(40, 40)]).toBe(CELL.tunnel);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).holes).toContainEqual({ x: 40, y: 40, kind: 'crater' });
    expect(g.report('nw').armies[0]!.stats.impacts).toBe(1);
    expect(g.events({ team: 'se', role: 'sky' }, 0).some((e) => e.kind === 'impact')).toBe(true);
  });

  it('interceptors shoot a falling asteroid down before impact', () => {
    const { g } = strike(3);
    const s = g.sim;
    expect(s.armies[1]!.spire.surface.hp).toBe(SPIRE_HP.surface);
    expect(s.holeCount).toBe(0);
    expect(g.report('se').armies[1]!.stats.interceptions).toBe(1);
    expect(g.events({ team: 'nw', role: 'orbit' }, 0).some((e) => e.kind === 'asteroid_intercepted')).toBe(true);
    expect(g.events({ team: 'nw', role: 'orbit' }, 0).some((e) => e.kind === 'impact')).toBe(false);
  });
});

describe('sky islands', () => {
  it('uncontested air units capture an island; contested ones do not', () => {
    const g = createGame({ seed: 2 });
    const s = g.sim;
    const island = s.ents.find((e) => e.kind === 'island')!;
    const air = [0, 1, 2].map(() => s.spawnUnit(0, 'interceptor', 'sky'));
    for (const a of air) {
      a.x = island.x;
      a.y = island.y;
    }
    const bomber = s.spawnUnit(1, 'bomber', 'sky');
    expect(act(g, 'nw', 'sky', { kind: 'capture', units: air.map((a) => id(g, a)), island: id(g, island) })).toEqual({ ok: true });
    expect(act(g, 'se', 'sky', { kind: 'capture', units: [id(g, bomber, 'se')], island: id(g, island, 'se') })).toEqual({ ok: true });
    bomber.x = island.x;
    bomber.y = island.y;
    bomber.hp = 1e9; // keep the contest going while we watch
    steps(g, ECON.captureTicks + toTicks(2));
    expect(island.side).toBe(NEUTRAL); // contested while the bomber lives
    bomber.hp = 0;
    steps(g, ECON.captureTicks + toTicks(0.5));
    expect(island.side).toBe(0);
    expect(g.events({ team: 'nw', role: 'sky' }, 0).some((e) => e.kind === 'island_captured')).toBe(true);
    // Islands are public: red sees the new owner.
    expect(g.view('se').entities.find((e) => e.id === id(g, island, 'se'))!.side).toBe('nw');
  });
});

describe('outcome', () => {
  it('destroying the enemy surface segment wins; the game then rejects intents', () => {
    const g = createGame({ seed: 4 });
    const s = g.sim;
    s.armies[1]!.spire.surface.hp = 25;
    const tank = s.spawnUnit(0, 'tank', 'surface');
    // Within cannon range of the footprint edge (no siege bonus against a Spire): 5.83 tiles.
    tank.x = 38;
    tank.y = 40;
    steps(g, VISION_EVERY); // the tank now sees the Spire
    expect(act(g, 'nw', 'surface', { kind: 'attack', units: [id(g, tank)], target: id(g, s.armies[1]!.spire.surface) })).toEqual({ ok: true });
    steps(g, toTicks(3));
    expect(g.outcome('nw')).toBe('win');
    expect(g.outcome('se')).toBe('loss');
    expect(g.report('se').outcome).toBe('loss');
    expect(g.observe({ team: 'nw', role: 'sky' }, 0).outcome).toBe('win');
    const tick = g.tick;
    g.step();
    expect(g.tick).toBe(tick);
    expect(act(g, 'nw', 'surface', { kind: 'stop', units: [id(g, tank)] })).toEqual({ ok: false, code: 'game_over' });
  });

  it('the time cap decides by total Spire HP, equal HP is a draw', () => {
    const even = createGame({ seed: 4 });
    removeAll(even, (e) => e.kind !== 'spire' && e.kind !== 'island');
    even.sim.tick = toTicks(DEFAULT_RULES.spire.timeCap) - 1;
    even.step();
    expect(even.outcome('nw')).toBe('draw');
    expect(even.outcome('se')).toBe('draw');

    const ahead = createGame({ seed: 4 });
    removeAll(ahead, (e) => e.kind !== 'spire' && e.kind !== 'island');
    ahead.sim.armies[1]!.spire.depths.hp -= 1;
    ahead.sim.tick = toTicks(DEFAULT_RULES.spire.timeCap) - 1;
    ahead.step();
    expect(ahead.outcome('nw')).toBe('win');
    expect(ahead.outcome('se')).toBe('loss');
  });

  it('both surface segments falling in the same tick: more total Spire HP wins, equal HP is a draw', () => {
    for (const [redDepths, blue] of [
      [0, 'draw'],
      [1, 'win'],
    ] as const) {
      const g = createGame({ seed: 4 });
      removeAll(g, (e) => e.kind !== 'spire' && e.kind !== 'island');
      g.sim.armies[1]!.spire.depths.hp -= redDepths;
      for (const team of ['nw', 'se'] as const) g.sim.armies[slotOfArmyId(team, 2)]!.spire.surface.hp = 0;
      g.step();
      expect(g.outcome('nw')).toBe(blue);
      expect(g.outcome('se')).toBe(blue === 'win' ? 'loss' : 'draw');
    }
  });
});

describe('intent validation', () => {
  it('rejects commands on other teams, wrong planes, wrong kinds and unseen targets', () => {
    const g = createGame({ seed: 9, options: { map: { params: { spireInset: 8 } } } });
    const blueTrooper = own(g, 'nw', 'trooper')[0]!;
    const redTrooper = own(g, 'se', 'trooper')[0]!;
    const blueDigger = own(g, 'nw', 'digger')[0]!;
    // Fog safety: blue has no name for an unseen enemy, and a name it never gave is as unknown as a dead id (was a
    // liveness oracle when ids were global).
    expect(g.sim.aliasOf(0, redTrooper.id)).toBe(0);
    expect(act(g, 'nw', 'surface', { kind: 'move', units: [id(g, blueDigger)], x: 10, y: 10 })).toEqual({ ok: false, code: 'wrong_plane' });
    expect(act(g, 'nw', 'surface', { kind: 'move', units: ['e_999999'], x: 10, y: 10 })).toEqual({ ok: false, code: 'unknown_unit' });
    expect(act(g, 'nw', 'surface', { kind: 'attack', units: [id(g, blueTrooper)], target: 'e_999999' })).toEqual({ ok: false, code: 'not_visible' });
    expect(act(g, 'nw', 'depths', { kind: 'undermine', units: [id(g, blueDigger)], x: 8, y: 8 })).toEqual({ ok: false, code: 'wrong_kind' });
    expect(act(g, 'nw', 'surface', { kind: 'macro', action: 'haul_core' })).toEqual({ ok: false, code: 'wrong_plane' });
    // An in-radius site nobody sees (behind the Spire: start units stand rules.movement.rallyClearance out, toward the centre).
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', x: 3, y: 18 })).toEqual({ ok: false, code: 'not_visible' });
    // The build radius reads only own structures and public Spire positions, so it is judged before visibility.
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', x: 30, y: 30 })).toEqual({ ok: false, code: 'out_of_radius' });
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', x: 8, y: 8 })).toEqual({ ok: false, code: 'occupied' });
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret' })).toEqual({ ok: false, code: 'invalid_target' });
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', x: 12, y: 12, count: 2 })).toEqual({ ok: false, code: 'invalid_target' });
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', x: 12, y: 12 })).toEqual({ ok: true });
    // A queued (not yet funded) site already claims its spot (this Shaft site and its apron are all plain ground).
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'shaft', x: 13, y: 11 })).toEqual({ ok: false, code: 'occupied' });
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'relay', island: id(g, blueTrooper) })).toEqual({ ok: false, code: 'invalid_target' });
    expect(act(g, 'nw', 'surface', { kind: 'queue_cancel', entry: 'q_999' })).toEqual({ ok: false, code: 'invalid_target' });
    expect(act(g, 'nw', 'surface', { kind: 'queue_move', entry: 'q_999', index: 0 })).toEqual({ ok: false, code: 'invalid_target' });
  });

  for (const team of ['nw', 'se'] as const) {
    it(`${team}: other armies' units are 'not_your_unit' only while seen, otherwise as unknown as a dead id`, () => {
      const enemy = team === 'nw' ? 'se' : 'nw';
      const g = createGame({ seed: 9, options: { map: { params: { spireInset: 8 } } } });
      const mine = own(g, team, 'trooper')[0]!;
      const theirs = own(g, enemy, 'trooper')[0]!;
      const move = (unit: Ent): AgentCommandIntent => ({ kind: 'move', units: [id(g, unit, team)], x: 10, y: 10 });
      expect(g.sim.sees(slotOfArmyId(team, 2), theirs)).toBe(false);
      // Unseen: no name at all, so a guess is a name it never gave.
      expect(g.sim.aliasOf(slotOfArmyId(team, 2), theirs.id)).toBe(0);
      expect(act(g, team, 'surface', { kind: 'move', units: ['e_999999'], x: 10, y: 10 })).toEqual({ ok: false, code: 'unknown_unit' });
      theirs.x = mine.x + 1;
      theirs.y = mine.y;
      steps(g, VISION_EVERY);
      expect(g.sim.sees(slotOfArmyId(team, 2), theirs)).toBe(true);
      expect(act(g, team, 'surface', move(theirs))).toEqual({ ok: false, code: 'not_your_unit' });
      theirs.hp = 0;
      steps(g, 1);
      expect(act(g, team, 'surface', move(theirs))).toEqual({ ok: false, code: 'unknown_unit' });
    });
  }

  it('produces units from the plane segment and pays when production starts', () => {
    const g = createGame({ seed: 9 });
    const before = own(g, 'nw', 'digger').length;
    const alloy = g.sim.armies[0]!.alloy;
    // Production belongs to its output plane's seat: the Depths seat queues diggers.
    expect(act(g, 'nw', 'depths', { kind: 'queue_add', item: 'digger', count: 2 })).toEqual({ ok: true });
    g.step();
    expect(g.sim.armies[0]!.alloy).toBeCloseTo(alloy - STATS.digger.alloy + ECON.spireAlloyRate / TICK_RATE, 6);
    const q = g.observe({ team: 'nw', role: 'depths' }, 0).queue;
    expect(q.map((e) => [e.id, e.item, e.plane, e.by, e.status, e.reason ?? null])).toEqual([
      ['q_1', 'digger', 'depths', 'depths', 'building', null],
      ['q_2', 'digger', 'depths', 'depths', 'waiting', 'producer'],
    ]);
    expect(q[0]!.progress).toBeCloseTo(1 / STATS.digger.build, 2);
    expect(q[0]!.eta).toBe(STATS.digger.build - 1);
    // Unpaid work has no ETA: its start depends on future income, never a promise.
    expect(q[1]!.eta).toBeUndefined();
    steps(g, 2 * STATS.digger.build);
    expect(own(g, 'nw', 'digger').length).toBe(before + 2);
    expect(own(g, 'nw', 'digger').every((d) => d.plane === 'depths' && g.sim.cells[cell(Math.floor(d.x), Math.floor(d.y))] === CELL.tunnel)).toBe(true);
    const evs = g.events({ team: 'nw', role: 'depths' }, 0);
    expect(evs.filter((e) => e.kind === 'produced')).toHaveLength(2);
    for (const e of evs) expect(validate(eventSchema, e).ok).toBe(true);
    expect(validate(observationSchema, g.observe({ team: 'nw', role: 'depths' }, 0)).ok).toBe(true);
  });
});
