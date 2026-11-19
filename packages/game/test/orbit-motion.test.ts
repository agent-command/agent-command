import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { STATS, TICK_RATE, footprint, sunAngleAt, sunLit, toTicks, type MatchOptions, type OrbitFormation, type ArmyId } from '../src/rules/contract.ts';
import { entityOut } from '../src/agent/present.ts';
import type { Ent } from '../src/sim/ent.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
/** Open Orbit (the derelict ruin, scaled to the map, fills the centre these routes cross; derelict.test.ts covers it). */
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 19, options: { terrain: 'open', ...options, orbit: { derelictEnabled: false, ...options.orbit } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.step();
  return g;
}
function ship(g: AgentCommandGame, kind: 'solar' | 'tug' | 'lancer', team: ArmyId, x: number, y: number): Ent {
  const e = g.sim.add(kind, slotOfArmyId(team, 2), 'orbit', x, y);
  e.stance = 'hold';
  return e;
}
function move(g: AgentCommandGame, e: Ent, x: number, y: number): void {
  const team = g.sim.armyIds[e.side]!;
  expect(g.apply({ team, role: 'orbit' }, { kind: 'move', units: [id(g, team, e)], x, y })).toEqual({ ok: true });
}

describe('Orbit momentum and formations', () => {
  it('coasts through a reversal and bounds stopping overshoot by registry thrust', () => {
    const g = arena();
    const e = ship(g, 'lancer', 'nw', 12, 12);
    move(g, e, 30, 12);
    for (let i = 0; i < 45; i++) g.step();
    const before = e.x;
    const oldVx = e.vx;
    move(g, e, 8, 12);
    g.step();
    expect(e.x).toBeGreaterThan(before);
    expect(e.vx).toBeGreaterThan(0);
    const turn = Math.acos(Math.max(-1, Math.min(1, e.vx / Math.hypot(e.vx, e.vy))));
    expect(turn).toBeLessThanOrEqual(STATS.lancer.orbitTurnRate! / TICK_RATE + 1e-7);
    expect(oldVx).toBeGreaterThan(0);
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'stop', units: [id(g, 'nw', e)] })).toEqual({ ok: true });
    const x = e.x;
    const y = e.y;
    let speed = Math.hypot(e.vx, e.vy);
    const maximum = speed * TICK_RATE;
    for (let i = 0; i < toTicks(3); i++) {
      g.step();
      const next = Math.hypot(e.vx, e.vy);
      expect(next).toBeLessThanOrEqual(speed + 1e-8);
      speed = next;
    }
    expect(Math.hypot(e.x - x, e.y - y)).toBeGreaterThan(0.1);
    expect(Math.hypot(e.x - x, e.y - y)).toBeLessThanOrEqual(maximum * maximum / (2 * STATS.lancer.orbitAcceleration!) + maximum / TICK_RATE + 1e-6);
    expect(speed).toBe(0);
    expect(entityOut(g.sim, e, 'nw').heading).toBeDefined();
  });

  for (const formation of ['wedge', 'line', 'escort'] as const satisfies readonly OrbitFormation[]) {
    it(`keeps ${formation} slots at the slowest speed with exact mirrored integration and checkpoint determinism`, () => {
      const g = arena();
      const blue = [ship(g, 'solar', 'nw', 12, 12), ship(g, 'tug', 'nw', 14, 12), ship(g, 'lancer', 'nw', 16, 12)];
      const red = blue.map((e) => ship(g, e.kind as 'solar' | 'tug' | 'lancer', 'se', g.sim.size - e.x, g.sim.size - e.y));
      for (const [team, fleet] of [['nw', blue], ['se', red]] as const) {
        expect(g.apply({ team, role: 'orbit' }, { kind: 'move', units: fleet.map((e) => id(g, team, e)), x: team === 'nw' ? 24 : 24, y: team === 'nw' ? 14 : 34, formation, ...(formation === 'escort' ? { escort: id(g, team, fleet[0]!) } : {}) })).toEqual({ ok: true });
      }
      const orders = blue.map((e) => e.order);
      const copy = g.clone();
      for (let tick = 0; tick < 700; tick++) {
        g.step(); copy.step();
        expect(g.stateHash()).toBe(copy.stateHash());
        for (let i = 0; i < blue.length; i++) {
          const a = blue[i]!;
          const b = red[i]!;
          expect(a.x + b.x).toBe(g.sim.size);
          expect(a.y + b.y).toBe(g.sim.size);
          expect(a.vx + b.vx).toBe(0);
          expect(a.vy + b.vy).toBe(0);
          expect(Math.hypot(a.vx, a.vy)).toBeLessThanOrEqual(STATS.solar.speed / TICK_RATE + 2e-8);
        }
      }
      for (let i = 0; i < blue.length; i++) {
        const o = orders[i]!;
        expect(o.k).toBe('move');
        if (o.k === 'move') expect(Math.hypot(blue[i]!.x - o.x, blue[i]!.y - o.y)).toBeLessThan(0.3);
      }
      if (formation === 'escort' && orders[0]!.k === 'move') {
        expect(orders[0]!.ox).toBe(0);
        expect(orders[0]!.oy).toBe(0);
      }
    });
  }

  it('starts queued formations from the completed leg and finishes every member together', () => {
    const g = arena();
    const a = ship(g, 'solar', 'nw', 12, 12);
    const b = ship(g, 'tug', 'nw', 14, 12);
    const units = [id(g, 'nw', a), id(g, 'nw', b)];
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'move', units, x: 18, y: 12, formation: 'line' })).toEqual({ ok: true });
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'move', units, x: 24, y: 14, formation: 'escort', escort: id(g, 'nw', a), queue: true })).toEqual({ ok: true });
    const next = a.queue[0]!;
    let started = false;
    for (let tick = 0; tick < 1100; tick++) {
      g.step();
      if (a.order === next && next.k === 'move' && next.fleet!.started && !started) {
        started = true;
        expect(a.x).toBeGreaterThan(16);
        expect(next.fleet!.x).toBeGreaterThan(16);
      }
      expect(a.order.k === 'none').toBe(b.order.k === 'none');
    }
    expect(started).toBe(true);
    expect(a.order.k).toBe('none');
    expect(Math.hypot(a.x - 24, a.y - 14)).toBeLessThan(0.1);
  });

  it('Orbit thrust overrides have no effect on Sky interceptor motion', () => {
    const a = arena();
    const b = arena({ stats: { interceptor: { orbitAcceleration: 0.1, orbitTurnRate: 0.1 } } });
    const ships = [a, b].map((g) => {
      const e = g.sim.add('interceptor', BLUE, 'sky', 12, 12);
      e.stance = 'hold';
      g.sim.order(e, { k: 'move', x: 30, y: 12, fight: false, speed: 0 });
      return e;
    });
    for (let tick = 0; tick < 150; tick++) {
      a.step(); b.step();
      expect(ships[0]!.x).toBe(ships[1]!.x);
      expect(ships[0]!.y).toBe(ships[1]!.y);
      expect(ships[0]!.vx).toBe(ships[1]!.vx);
      expect(ships[0]!.vy).toBe(ships[1]!.vy);
    }
  });

  it('rejects an unseen or unselected escort without changing an order', () => {
    const g = arena();
    const a = ship(g, 'tug', 'nw', 12, 12);
    const b = ship(g, 'lancer', 'nw', 14, 12);
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'move', units: [id(g, 'nw', a), id(g, 'nw', b)], x: 24, y: 16, formation: 'escort', escort: 'e_999999' })).toEqual({ ok: false, code: 'invalid_target' });
    expect(a.order.k).toBe('none');
    expect(b.order.k).toBe('none');
  });
});

describe('Orbit pursuit fire', () => {
  for (const towing of [false, true]) for (const mode of ['attack', 'fight', 'move'] as const) {
    it(`fires while overtaking a ${towing ? 'towing' : 'moving'} tug with ${mode}, mirrored`, () => {
      const g = arena({ spire: { dmg: 0 }, orbit: { maxAsteroids: 0 } });
      const pairs = (['nw', 'se'] as const).map((team) => {
        const mirror = team === 'nw' ? 1 : -1;
        const x = (v: number): number => team === 'nw' ? v : g.sim.size - v;
        const y = x(12);
        const skiff = g.sim.add('skiff', slotOfArmyId(team, 2), 'orbit', x(12), y);
        const tug = ship(g, 'tug', team === 'nw' ? 'se' : 'nw', x(15), y);
        // A target already under way must be caught before it slows for its destination.
        tug.vx = mirror * STATS.tug.speed / TICK_RATE * (towing ? g.sim.rocks.pebble.tow : 1);
        if (towing) {
          const rock = g.sim.add('asteroid', NEUTRAL, 'orbit', tug.x, tug.y);
          rock.rockSize = 'pebble';
          rock.resourceType = 'slag';
          rock.resourceRemaining = g.sim.rocks.pebble.dockYield.slag.alloy + g.sim.rocks.pebble.dockYield.slag.energy;
          rock.hp = rock.maxHp = g.sim.rocks.pebble.hp;
          rock.state = 'towed';
          rock.link = tug.id;
          tug.link = rock.id;
        }
        move(g, tug, x(42), y);
        return { team, skiff, tug, goalX: x(42), y };
      });
      g.step(); g.step();
      for (const { team, skiff, tug, goalX, y } of pairs) {
        expect(g.sim.sees(slotOfArmyId(team, 2), tug)).toBe(true);
        const result = mode === 'attack'
          ? g.apply({ team, role: 'orbit' }, { kind: 'attack', units: [id(g, team, skiff)], target: id(g, team, tug) })
          : g.apply({ team, role: 'orbit' }, { kind: 'move', units: [id(g, team, skiff)], x: goalX, y, mode });
        expect(result).toEqual({ ok: true });
      }
      const fired = [0, 0];
      for (let tick = 0; tick < toTicks(6); tick++) {
        g.step();
        for (let i = 0; i < pairs.length; i++) {
          const { skiff, tug } = pairs[i]!;
          const shot = g.sim.fx.find(({ fx }) => fx.tick === g.tick && fx.kind === 'shot' && fx.src === skiff.id);
          if (!shot) continue;
          fired[i]!++;
          expect(Math.abs(tug.vx)).toBeGreaterThan(0.05);
          expect(g.sim.inRange(skiff, tug)).toBe(true);
          const mirror = skiff.side === BLUE ? 1 : -1;
          const dx = (tug.x - skiff.x) * mirror;
          const dy = (tug.y - skiff.y) * mirror;
          expect(dx * Math.cos(skiff.heading) + dy * Math.sin(skiff.heading))
            .toBeGreaterThanOrEqual(Math.hypot(dx, dy) * Math.cos(Math.PI / 6) - 1e-6);
        }
        expect(fired[0]).toBe(fired[1]);
        expect(pairs[0]!.skiff.x + pairs[1]!.skiff.x).toBe(g.sim.size);
        expect(pairs[0]!.skiff.y + pairs[1]!.skiff.y).toBe(g.sim.size);
      }
      expect(fired[0]).toBeGreaterThan(0);
      expect(fired[1]).toBeGreaterThan(0);
      for (const { tug } of pairs) expect(tug.hp).toBeLessThan(tug.maxHp);
    });
  }
});

describe('Orbit night sensors', () => {
  it('matches the public sunlight predicate at every cell centre throughout the day', () => {
    const g = arena();
    for (const tick of [0, 1, 2, 299, 600, 1200, 2399]) {
      g.sim.tick = tick;
      // A direct refresh, not a scan: scans are funded spends since the economy lanes and stop refreshing once energy runs out.
      g.sim.refreshVision();
      const dark = g.sim['orbitDark'];
      for (let c = 0; c < g.sim.size * g.sim.size; c++) {
        expect(dark[c]).toBe(sunLit((c % g.sim.size) + 0.5, Math.floor(c / g.sim.size) + 0.5, g.sim.sunAngle, g.sim.size, g.sim.sunWedges) ? 0 : 1);
      }
    }
  });

  for (const penalties of [{ nightVision: 0.5, nightSignature: 1 }, { nightVision: 1, nightSignature: 0.5 }]) {
    it(`shortens night visibility with ${JSON.stringify(penalties)} and scans reveal only briefly`, () => {
      const g = arena({ orbit: penalties });
      const observer = ship(g, 'tug', 'nw', 30.5, 10.5);
      const far = ship(g, 'solar', 'se', 36.5, 10.5);
      const close = ship(g, 'solar', 'se', 33.5, 10.5);
      expect(sunLit(observer.x, observer.y, g.sim.sunAngle, g.sim.size, g.sim.sunWedges)).toBe(false);
      expect(sunLit(far.x, far.y, g.sim.sunAngle, g.sim.size, g.sim.sunWedges)).toBe(false);
      g.step();
      expect(g.sim.sees(BLUE, close)).toBe(true);
      expect(g.sim.sees(BLUE, far)).toBe(false);
      expect(g.view('nw').entities.some((e) => e.id === `e_${g.sim.aliasOf(BLUE, far.id)}`)).toBe(false);
      g.sim.scan(BLUE, far.x, far.y);
      expect(g.sim.sees(BLUE, far)).toBe(true);
      for (let tick = 0; tick < g.sim.econ.scanTicks + 2; tick++) g.step();
      expect(g.sim.sees(BLUE, far)).toBe(false);
      observer.x = 12.5; observer.y = 12.5;
      far.x = 18.5; far.y = 12.5;
      expect(sunLit(observer.x, observer.y, g.sim.sunAngle, g.sim.size, g.sim.sunWedges)).toBe(true);
      expect(sunLit(far.x, far.y, g.sim.sunAngle, g.sim.size, g.sim.sunWedges)).toBe(true);
      g.step(); g.step();
      expect(g.sim.sees(BLUE, far)).toBe(true);
    });
  }

  it('remote scouts cannot extend the Orbit segment night detector past its beam-range floor, but scans can', () => {
    const g = arena();
    g.sim.tick = toTicks(60);
    const spire = g.sim.armies[BLUE]!.spire.orbit;
    const half = footprint('spire')!.w / 2;
    // Inside the beam (range + tug radius from the footprint edge) but past the floor (range from the edge).
    const target = ship(g, 'tug', 'se', spire.x + half + STATS.spire.range + 0.25, spire.y);
    ship(g, 'solar', 'nw', target.x + 1.5, target.y);
    expect(sunLit(target.x, target.y, g.sim.sunAngle, g.sim.size, g.sim.sunWedges)).toBe(false);
    g.step(); g.step();
    expect(g.sim.sees(BLUE, target)).toBe(true);
    expect(g.sim.reach(spire, target)).toBeGreaterThan(Math.hypot(target.x - spire.x, target.y - spire.y));
    expect(g.sim.lineOfFire(spire, target)).toBe(false);
    g.sim.scan(BLUE, target.x, target.y);
    expect(g.sim.lineOfFire(spire, target)).toBe(true);
  });

  it('Lancers sieging the Orbit segment from its diagonal at night take its beam fire, unscanned and mirrored', () => {
    const g = arena();
    const blueSegment = g.sim.armies[BLUE]!.spire.orbit;
    const redSegment = g.sim.armies[RED]!.spire.orbit;
    // Three blue Lancers across red's diagonal toward the map centre, the middle one 0.5 inside its reach to the
    // footprint corner; red's are their exact half-turn twins on blue's diagonal.
    const d = (STATS.lancer.range - 0.5 + (footprint('spire')!.w / 2) * Math.SQRT2) / Math.SQRT2;
    const blue = [-1, 0, 1].map((k) => ship(g, 'lancer', 'nw', redSegment.x - d - k, redSegment.y - d + k));
    const red = blue.map((e) => ship(g, 'lancer', 'se', g.sim.size - e.x, g.sim.size - e.y));
    // The attackers scan the Spire they siege; the defenders get no scan.
    g.sim.armies[BLUE]!.scans.push({ x: redSegment.x, y: redSegment.y, until: 1e9 });
    g.sim.armies[RED]!.scans.push({ x: blueSegment.x, y: blueSegment.y, until: 1e9 });
    // A night tick for every Lancer (the sun is point symmetric: blue's and red's darkness agree).
    let tick = 0;
    while (tick < toTicks(600) && [...blue, ...red].some((e) => sunLit(e.x, e.y, sunAngleAt(tick, g.sim.sunSpeed), g.sim.size, g.sim.sunWedges))) tick += TICK_RATE;
    g.sim.tick = tick;
    for (const [own, segment] of [[blue, redSegment], [red, blueSegment]] as const) {
      for (const e of own) {
        expect(g.sim.lit(e.x, e.y)).toBe(false);
        // Far beyond the old vision × nightSignature sensor from the centre, inside the beam-range floor.
        expect(Math.hypot(e.x - segment.x, e.y - segment.y)).toBeGreaterThan(STATS.spire.vision * g.sim.econ.nightSignature);
        expect(g.sim.inRange(e, segment)).toBe(true);
        expect(g.sim.inRange(segment, e)).toBe(true);
      }
    }
    const health = (own: Ent[]): number => own.reduce((sum, e) => sum + Math.max(0, e.hp) + e.shield, 0);
    const full = health(blue);
    for (let t = 0; t < toTicks(4); t++) g.step();
    expect([...blue, ...red].every((e) => !g.sim.lit(e.x, e.y))).toBe(true);
    expect(health(blue)).toBeLessThan(full);
    expect(redSegment.hp).toBeLessThan(redSegment.maxHp);
    expect(health(red)).toBe(health(blue));
    expect(blueSegment.hp).toBe(redSegment.hp);
  });
});
