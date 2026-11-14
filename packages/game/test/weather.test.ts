import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { DEFAULT_RULES, PLANES, STATS, fullObservation, TICK_RATE, TRANSITS, checkRules, compileRules, observationSchema, resolveRules, toTicks, viewSchema, spirePositions, type MatchOptions, type ArmyId } from '../src/rules/contract.ts';
import { slotOfArmyId } from '../src/util/teams.ts';
import { createGame } from '../src/agent/adapter.ts';
import { matchData, view } from '../src/agent/present.ts';
import { Sim } from '../src/sim/sim.ts';
import { type Ent } from '../src/sim/ent.ts';
import { SkyWeather, weatherStormAt } from '../src/planes/weather.ts';

/** Spire centres under the default rules (what the old SkyWeather defaulted to). */
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);

function arena(sky: MatchOptions['sky'] = {}): Sim {
  const s = new Sim(5, { terrain: 'open', sky: { stormRadius: 0, fogRadius: 0, jetWidth: 0, stormSets: 1, ...sky } });
  for (const e of s.ents) if (e.unit) e.dead = true;
  if (sky.stormRadius) matureStorms(s);
  return s;
}
/** Combat fixtures keep real pooled lifecycle descriptors, stationary and mature for the whole case. */
function matureStorms(s: Sim, x = 24, y = 24): void {
  for (const c of [...s.weather.data.forecast, ...s.weather.data.storms]) {
    c.originX = x;
    c.originY = y;
    c.dx = c.dy = 0;
    c.maxRadius = s.econ.stormRadius;
    c.start = c.grown = 0;
    c.breaking = 1000000;
    c.end = 1000001;
  }
  s.weather.update(s.tick);
}
function air(s: Sim, team: ArmyId, x: number, y: number): Ent {
  const e = s.add('interceptor', slotOfArmyId(team, 2), 'sky', x, y);
  e.stance = 'hold';
  e.cd = 100000;
  return e;
}
function advance(s: Sim, ticks = 2): void {
  for (let i = 0; i < ticks; i++) s.step();
}

describe('public Sky weather', () => {
  it('preserves the existing seed-independent circular fog paths and exact mirrored masks', () => {
    const a = new Sim(1, { sky: { stormRadius: 0 } });
    const b = new Sim(999, { sky: { stormRadius: 0 } });
    for (const tick of [0, 1, 17, 1200, 3599, 100000]) {
      a.weather.update(tick);
      b.weather.update(tick);
      expect(a.weather.data).toEqual(b.weather.data);
      const [first, second] = a.weather.data.fog;
      expect(a.weather.data.fog).toHaveLength(2);
      const p = first!.path;
      const angle = p.phase + tick / TICK_RATE * p.speed;
      expect(first!.x).toBe(p.cx + p.radius * Math.cos(angle));
      expect(first!.y).toBe(p.cy + p.radius * Math.sin(angle));
      expect(second!.x).toBe(a.size - first!.x);
      expect(second!.y).toBe(a.size - first!.y);
      expect(second!.path.turns).toBe(2);
      a.weather.refreshMask();
      for (let c = 0; c < a.size * a.size; c++) expect(a.weather.mask[c] === 0).toBe(a.weather.mask[a.size * a.size - 1 - c] === 0);
    }
  });

  it('exposes the same fog-safe forecast to every seat and returns detached snapshots', () => {
    // Through the adapter: what agents and clients receive, with the team signals the wire schemas require.
    const g = createGame({ seed: 7 });
    const s = g.sim;
    // Every seat asking for the Sky plane sees the same public weather.
    const blue = fullObservation(g.observe({ team: 'nw', role: 'sky' }, 0, PLANES));
    const red = g.observe({ team: 'se', role: 'depths' }, 0, PLANES);
    const data = matchData(s, s.armyIndex('se'));
    const v = g.view('se');
    expect(blue.weather).toEqual(red.weather);
    expect(v.weather).toEqual(blue.weather);
    expect(v.match).toEqual(data);
    expect(data.jets).toEqual(s.weather.data.jets);
    expect(data.fogPaths).toEqual(s.weather.data.fog.map(f => f.path));
    expect(blue.weather).not.toHaveProperty('jets');
    expect(blue.weather.fog[0]).not.toHaveProperty('path');
    expect(blue).not.toHaveProperty('match');
    expect(validate(observationSchema, blue).ok).toBe(true);
    expect(validate(viewSchema, v).ok).toBe(true);
    expect(blue.weather.storms).toHaveLength(0);
    const previous = structuredClone(blue.weather.forecast);
    advance(s);
    expect(blue.weather.forecast).toEqual(previous);
    expect(blue.weather.forecast[0]).not.toBe(s.weather.data.forecast[0]);
    expect(data.fogPaths[0]).not.toBe(s.weather.data.fog[0]!.path);
  });

  it('compiles configurable weather rules, validates bounds, and supports disabled weather', () => {
    const options: MatchOptions = { sky: {
      stormSpeed: 0.3, stormDps: 9, stormSets: 2, stormMinRadius: 4, stormRadius: 7,
      stormForecastMin: 12, stormForecastMax: 18, stormGrow: 5, stormLifetimeMin: 30,
      stormLifetimeMax: 75, stormBreak: 6, stormCalmMin: 3, stormCalmMax: 9,
      stormDrift: 0.2, stormSiteMinRadius: 8, stormSiteMaxRadius: 17, stormSiteLaneBias: 0.4,
      fogVision: 0.25, jetWith: 2.1, jetAgainst: 0.4,
    } };
    expect(checkRules(options).ok).toBe(true);
    const e = compileRules(resolveRules(options)).econ;
    for (const key of ['stormForecastMin', 'stormForecastMax', 'stormGrow', 'stormLifetimeMin', 'stormLifetimeMax', 'stormBreak', 'stormCalmMin', 'stormCalmMax'] as const) {
      expect(e[key]).toBe(toTicks(options.sky![key]!));
    }
    expect(e.stormDrift).toBe(0.2);
    expect(e.stormSets).toBe(2);
    expect(e.stormRadius).toBe(7);
    expect(e.stormSiteLaneBias).toBe(0.4);
    expect(e.stormDps).toBe(9);
    expect(e.fogVision).toBe(0.25);
    expect(checkRules({ sky: { stormSpeed: 0 } }).ok).toBe(false);
    expect(checkRules({ sky: { jetWith: 10 } }).ok).toBe(false);
    expect(checkRules({ sky: { stormSets: 3 } }).ok).toBe(false);
    expect(checkRules({ sky: { stormForecastMin: 0 } }).ok).toBe(false);
    expect(checkRules({ sky: { stormSiteLaneBias: 2 } }).ok).toBe(false);
    expect(arena().weather.data).toEqual({ storms: [], forecast: [], fog: [], jets: [], seeded: [], seedWarnings: [] });
    expect(new SkyWeather(compileRules(resolveRules({ sky: { stormSets: 0 } })).econ, 0, [DEFAULT_SPIRES.nw, DEFAULT_SPIRES.se], STATS.spire.range, 48, 2).data.forecast).toEqual([]);
  });

  it('slows air by .6 and deals exactly 4 dps once even where storms overlap', () => {
    const s = arena({ stormRadius: 5 });
    const unit = air(s, 'nw', 24, 24);
    const orbit = s.add('interceptor', 0, 'orbit', 24, 24);
    orbit.stance = 'hold';
    orbit.cd = 100000;
    const relay = s.add('relay', 0, 'sky', 24, 26);
    const hp = unit.hp;
    expect(s.speedOf(unit, 1, 0)).toBe(s.baseSpeed(unit) * 0.6);
    expect(s.speedOf(orbit, 1, 0)).toBe(s.baseSpeed(orbit));
    advance(s, TICK_RATE);
    expect(unit.hp).toBeCloseTo(hp - 4, 10);
    expect(orbit.hp).toBe(orbit.maxHp);
    expect(relay.hp).toBe(relay.maxHp);
  });

  it('scales natural slowdown and damage with lifecycle strength rather than stacking overlaps', () => {
    const s = arena({ stormRadius: 8 });
    for (const c of s.weather.data.storms) c.grown = toTicks(2);
    s.tick = TICK_RATE;
    s.weather.update(s.tick);
    const unit = air(s, 'nw', 24, 24);
    const hp = unit.hp;
    expect(s.weather.strengthAt(unit.x, unit.y)).toBe(0.5);
    expect(s.speedOf(unit, 1, 0)).toBe(s.baseSpeed(unit) * 0.8);
    advance(s, 1);
    expect(unit.hp).toBeCloseTo(hp - s.econ.stormDps * (TICK_RATE + 1) / toTicks(2) / TICK_RATE, 10);
  });

  it('hides storm occupants from outside Sky vision, but not nearby occupants of the same storm or scans', () => {
    const s = arena({ stormRadius: 5, stormDps: 0 });
    const hidden = air(s, 'se', 24, 24);
    const outside = air(s, 'nw', 30, 24);
    advance(s);
    expect(s.sees(0, hidden)).toBe(false);
    expect(view(s, 'nw').entities.some(e => s.aliasTarget(0, Number(e.id.slice(2))) === hidden.id)).toBe(false);
    outside.x = 27;
    advance(s);
    expect(s.sees(0, hidden)).toBe(true);
    outside.x = 30;
    advance(s);
    s.scan(0, 24, 24);
    expect(s.sees(0, hidden)).toBe(true);
    advance(s, s.econ.scanTicks + 2);
    expect(s.sees(0, hidden)).toBe(false);
  });

  it('matches full-scan storm sight through movement, new sources, transits, death and weather changes', () => {
    const s = arena({ stormRadius: 9, stormDps: 0, fogRadius: 5, fogPathRadius: 0 });
    const blue = air(s, 'nw', 23, 24);
    air(s, 'se', 25, 24);
    const unfinished = s.add('relay', 0, 'sky', 24, 24);
    unfinished.built = false;
    const housed = air(s, 'se', 24, 24);
    housed.hangar = 123;
    s.add('island', 0, 'sky', 24, 24);
    const check = (): void => {
      for (const team of (['nw', 'se'] as const)) for (let y = 12.5; y <= 35.5; y += 1) for (let x = 12.5; x <= 35.5; x += 1) {
        const mask = s.weather.stormMask(x, y);
        const scanned = s.armies[slotOfArmyId(team, 2)]!.scans.some((scan) => scan.until >= s.tick && Math.hypot(x - scan.x, y - scan.y) <= s.econ.scanRadius);
        const expected = !mask || scanned || s.ents.some((e) => {
          if (e.dead || e.hp <= 0 || e.side !== slotOfArmyId(team, 2) || e.plane !== 'sky' || e.hangar > 0 || e.kind === 'island' || e.kind === 'asteroid') return false;
          if (!e.built && e.kind !== 'spire') return false;
          if (!(mask & s.weather.stormMask(e.x, e.y))) return false;
          const r = s.stat(e).vision * (s.weather.fogAt(e.x, e.y) ? s.econ.fogVision : 1);
          return Math.hypot(e.x - x, e.y - y) <= r;
        });
        expect(s['skyVisible'](slotOfArmyId(team, 2), x, y), `${team}: ${x},${y}`).toBe(expected);
      }
    };
    s['indexSkySources']();
    check();
    blue.x = 29;
    blue.y = 25;
    unfinished.built = true;
    housed.hangar = 0;
    air(s, 'nw', 19, 24); // joins the index immediately, without a tick rebuild
    check();
    s.weather.seed(0, 15, 24, 4, 100, 0);
    s.weather.finishSeeds(1, 0);
    check();
    s.startTransit(blue, TRANSITS.ascend);
    s.tick = blue.transitAt;
    s['updateTransits']();
    expect(blue.plane).toBe('orbit');
    check();
    s.tick = blue.transitUntil;
    s['updateTransits']();
    expect(blue.plane).toBe('sky');
    check();
    blue.dead = true;
    housed.hp = 0;
    s.scan(1, 24, 24);
    s.weather.finishSeeds(0, 0);
    s.weather.update(1200);
    check();
    s['indexSkySources']();
    check();
  });

  it('stamps exactly the point-query storm mask, including overlaps, seeded storms and map edges', () => {
    for (const radius of [0, 0.25, 5, 48]) {
      const s = arena({ stormRadius: radius });
      for (const tick of [0, 1, 1200, 3599]) {
        s.weather.update(tick);
        s.weather.seed(0, 0.5, 0.5, 0.25, 100, 0);
        s.weather.seed(1, 23.5, 24.5, 7, 100, 0);
        s.weather.seed(2, s.size - 0.5, s.size - 0.5, 0.25, 100, 0);
        s.weather.finishSeeds(3, 0);
        s.weather.refreshMask();
        for (let y = 0; y < s.size; y++) for (let x = 0; x < s.size; x++) {
          expect(s.weather.mask[y * s.size + x]).toBe(s.weather.stormMask(x + 0.5, y + 0.5));
        }
        s.weather.finishSeeds(0, 0);
        s.weather.refreshMask();
        for (let y = 0; y < s.size; y++) for (let x = 0; x < s.size; x++) {
          expect(s.weather.mask[y * s.size + x]).toBe(s.weather.stormMask(x + 0.5, y + 0.5));
        }
      }
    }
  });

  it('blocks flak and Orbit targeting despite an allied in-storm spotter; scan overrides both', () => {
    const s = arena({ stormRadius: 5, stormDps: 0 });
    const target = air(s, 'se', 24, 24);
    air(s, 'nw', 24, 27);
    const flak = s.add('flak', 0, 'surface', 24, 22);
    flak.stance = 'hold';
    const orbit = s.add('lancer', 0, 'orbit', 24, 22);
    orbit.stance = 'hold';
    advance(s);
    expect(s.sees(0, target)).toBe(true);
    expect(s.lineOfFire(flak, target)).toBe(false);
    expect(s.lineOfFire(orbit, target)).toBe(false);
    expect(s.acquire(flak, 7, false)).toBeUndefined();
    s.order(flak, { k: 'attack', target: target.id });
    advance(s, 1);
    expect(s.fx.some(({ fx }) => fx.kind === 'shot' && fx.src === flak.id)).toBe(false);
    s.scan(0, 24, 24);
    expect(s.lineOfFire(flak, target)).toBe(true);
    expect(s.lineOfFire(orbit, target)).toBe(true);
    expect(s.acquire(flak, 7, false)).toBe(target);
    advance(s, 1);
    expect(s.fx.some(({ fx }) => fx.kind === 'shot' && fx.src === flak.id)).toBe(true);
  });

  it('halves vision from fog banks, including downward spotting, without hiding a unit from outside', () => {
    const s = arena({ fogRadius: 6, fogPathRadius: 0 });
    const observer = air(s, 'nw', 24, 24);
    const target = air(s, 'se', 30, 24);
    advance(s);
    expect(s.sees(0, target)).toBe(false);
    target.x = 27;
    advance(s);
    expect(s.sees(0, target)).toBe(true);
    observer.x = 31;
    target.x = 26;
    advance(s);
    expect(s.sees(0, target)).toBe(true);
    const bomber = s.add('bomber', 0, 'sky', 24, 24);
    bomber.stance = 'hold';
    bomber.cd = 100000;
    const ground = s.add('trooper', 1, 'surface', 26.5, 24.5);
    ground.stance = 'hold';
    advance(s);
    expect(s.sees(0, ground)).toBe(false);
  });

  it('uses two mirrored lanes: 1.8 with wind, .6 against, neutral crosswind and no Orbit effects', () => {
    const s = arena({ jetWidth: 3 });
    const north = air(s, 'nw', 24, 12);
    const south = air(s, 'se', 24, 36);
    const base = s.baseSpeed(north);
    expect(s.weather.data.jets).toHaveLength(2);
    expect(s.speedOf(north, 1, 0)).toBe(base * 1.8);
    expect(s.speedOf(north, -1, 0)).toBe(base * 0.6);
    expect(s.speedOf(north, 0, 1)).toBe(base);
    expect(s.speedOf(south, -1, 0)).toBe(base * 1.8);
    expect(s.speedOf(south, 1, 0)).toBe(base * 0.6);
    north.y = 24;
    expect(s.speedOf(north, 1, 0)).toBe(base);
    north.y = 12;
    north.plane = 'orbit';
    expect(s.speedOf(north, 1, 0)).toBe(base);
  });

  it('overlapping lanes at the rule extremes, and decimal lane edges, wind a unit and its mirror twin alike', () => {
    // Overlapping lanes (offset 8, width 8), and a decimal offset whose lane edge falls on row 19: 24 - 8.3 + 3.3.
    for (const [jetOffset, jetWidth] of [[8, 8], [8.3, 8], [8.3, 3.3]] as const) {
      const rules = { jetOffset, jetWidth };
      expect(checkRules({ sky: rules }).ok).toBe(true);
      const s = arena(rules);
      const [north, south] = s.weather.data.jets;
      expect(south!.y1).toBe(s.size - north!.y1);
      for (const y of [24, 20, 26.5, 30.25, 19, 29, north!.y1 - jetWidth, north!.y1 + jetWidth]) {
        const blue = air(s, 'nw', 17, y);
        const red = air(s, 'se', s.size - 17, s.size - y);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0.6, 0.8], [-0.28, 0.96], [0, 1]] as const) {
          expect(s.speedOf(red, -dx, -dy), `offset ${jetOffset} width ${jetWidth} row ${y} heading ${dx},${dy}`).toBe(s.speedOf(blue, dx, dy));
        }
      }
    }
    // Where both lanes cover a row their opposite winds both apply: with the northern wind, against the southern.
    const s = arena({ jetOffset: 8, jetWidth: 8 });
    const u = air(s, 'nw', 17, 24);
    expect(s.speedOf(u, 1, 0)).toBe(s.baseSpeed(u) * (1.8 * 0.6));
  });

  it('multiplies wind and storm slowdown and changes actual commanded movement', () => {
    const s = arena({ jetWidth: 3, stormRadius: 5, stormDps: 0 });
    matureStorms(s, 24, 12);
    const u = air(s, 'nw', 24, 12);
    expect(s.speedOf(u, 1, 0)).toBe(s.baseSpeed(u) * 0.6 * 1.8);
    const fast = arena({ jetWidth: 3 });
    const slow = arena({ jetWidth: 3 });
    const a = air(fast, 'nw', 24, 12);
    const b = air(slow, 'nw', 24, 12);
    fast.order(a, { k: 'move', x: 40, y: 12, fight: false, speed: 0 });
    slow.order(b, { k: 'move', x: 8, y: 12, fight: false, speed: 0 });
    advance(fast, toTicks(2));
    advance(slow, toTicks(2));
    expect(a.x - 24).toBeGreaterThan(24 - b.x);
  });

  it('reuses seeded cells, exposes only active geometry, and ends concealment when the source stops', () => {
    const w = new SkyWeather(compileRules(resolveRules({ sky: { stormRadius: 0 } })).econ, 0, [DEFAULT_SPIRES.nw, DEFAULT_SPIRES.se], STATS.spire.range, DEFAULT_RULES.map.size, 2);
    w.seed(0, 24, 24, 5, 600, 0);
    w.finishSeeds(1, 0);
    const source = w.data.seeded[0];
    expect(w.stormMask(24, 24)).not.toBe(0);
    expect(weatherStormAt(w.data, 24, 24, w.size)).toBe(true);
    w.seed(0, 25, 24, 5, 600, 0);
    expect(w.data.seeded[0]).toBe(source);
    w.finishSeeds(0, 0);
    expect(w.stormMask(24, 24)).toBe(0);
    expect(weatherStormAt(w.data, 24, 24, w.size)).toBe(false);
    expect(w.data.seeded).toHaveLength(0);
  });

  it('keeps hangared air safe from storm damage', () => {
    const s = arena({ stormRadius: 5 });
    const island = s.ents.find(e => e.kind === 'island')!;
    s.setSide(island, 0);
    island.orbitR = 0;
    const aerie = s.add('aerie', 0, 'sky', 24, 24);
    aerie.link = island.id;
    island.link = aerie.id;
    const parked = air(s, 'nw', 24, 24);
    parked.hangar = aerie.id;
    const hp = parked.hp;
    advance(s, TICK_RATE);
    expect(parked.hp).toBe(hp);
  });

  it('removes a seeded storm immediately when its upkeep (seederUpkeep set) cannot be paid; it stays off after power returns', () => {
    const s = arena({ seederUpkeep: 1 });
    const island = s.ents.find(e => e.kind === 'island')!;
    s.setSide(island, 0);
    const seeder = s.add('storm_seeder', 0, 'sky', island.x, island.y);
    seeder.link = island.id;
    island.link = seeder.id;
    seeder.activeUntil = s.tick + s.econ.seederDuration;
    advance(s);
    expect(s.weather.data.seeded).toHaveLength(1);
    s.armies[0]!.energy = 0;
    advance(s, 1);
    expect(s.armies[0]!.powered).toBe(false);
    expect(s.weather.data.seeded).toHaveLength(0);
    s.armies[0]!.energy = 100;
    advance(s, 1);
    expect(s.weather.data.seeded).toHaveLength(0);
  });

  it('follows an activated Seeder for its duration and stops when destroyed', () => {
    const s = arena();
    const island = s.ents.find(e => e.kind === 'island')!;
    s.setSide(island, 0);
    const seeder = s.add('storm_seeder', 0, 'sky', island.x, island.y);
    seeder.link = island.id;
    island.link = seeder.id;
    advance(s);
    expect(s.stormAt(island.x, island.y)).toBe(false);
    seeder.activeUntil = s.tick + s.econ.seederDuration;
    advance(s, 1);
    expect(s.stormAt(island.x, island.y)).toBe(true);
    expect(view(s, 'se').weather.seeded).toEqual([{ x: seeder.x, y: seeder.y, radius: s.econ.seederRadius, until: seeder.activeUntil }]);
    s.tick = seeder.activeUntil - 1;
    advance(s, 1);
    expect(s.weather.data.seeded).toHaveLength(0);
    seeder.activeUntil = s.tick + s.econ.seederDuration;
    advance(s, 1);
    expect(s.stormAt(island.x, island.y)).toBe(true);
    s.damage(seeder, seeder.hp, 1);
    advance(s, 1);
    expect(s.weather.data.seeded).toHaveLength(0);
  });

  it('own-alliance aircraft take seededOwnDamage inside their own seeded storm, others full damage (mirrored)', () => {
    const s = arena();
    const blue = s.add('storm_seeder', 0, 'sky', 12, 24);
    const red = s.add('storm_seeder', 1, 'sky', s.size - 12, s.size - 24);
    blue.activeUntil = red.activeUntil = s.tick + s.econ.seederDuration;
    const ownBlue = air(s, 'nw', 12, 24);
    const ownRed = air(s, 'se', s.size - 12, s.size - 24);
    const foeInBlue = air(s, 'se', 12.5, 24);
    const foeInRed = air(s, 'nw', s.size - 12.5, s.size - 24);
    for (const e of [ownBlue, ownRed, foeInBlue, foeInRed]) { e.shield = 0; e.maxShield = 0; }
    advance(s, TICK_RATE);
    const ownLoss = ownBlue.maxHp - ownBlue.hp;
    const foeLoss = foeInBlue.maxHp - foeInBlue.hp;
    expect(ownLoss).toBeGreaterThan(0);
    expect(ownLoss).toBeCloseTo(foeLoss * s.econ.seededOwnDamage, 6);
    expect(ownRed.hp).toBe(ownBlue.hp);
    expect(foeInRed.hp).toBe(foeInBlue.hp);
  });
});
