import { describe, expect, it } from 'vitest';
import { createGame } from '@agent-command/game';
import { STATS, UNITS_PER_INTENT, type Entity, type RockSize, type View } from '@agent-command/game/contract';
import { createDropForecast, dropRadius, forecastDrop, payloadReach, publicDrop, segmentNearest } from '../src/tools/drop.ts';
import { ruleTables } from '../src/unit-stats.ts';

function view(entities: Entity[]): View & { match: NonNullable<View['match']> } {
  const v = createGame({ seed: 1 }).view('nw');
  return { ...v, match: v.match!, entities };
}
const ent = (id: string, kind: Entity['kind'], side: Entity['side'], plane: Entity['plane'], x: number, y: number, extra: Partial<Entity> = {}): Entity =>
  ({ id, kind, side, plane, x, y, state: 'idle', hp: 100, maxHp: 100, ...extra }) as Entity;
const tug = (x: number, y: number, link = 'rock'): Entity => ent(`tug:${link}`, 'tug', 'nw', 'orbit', x, y, { state: 'towing', link });
const rock = (x: number, y: number, rockSize: RockSize = 'medium', volatile = false, id = 'rock'): Entity =>
  ent(id, 'asteroid', 'neutral', 'orbit', x, y, { state: 'towed', rockSize, resourceType: 'metal', volatile });

describe('drop footprint math', () => {
  const rules = view([]).match.rules.orbit;
  it.each([
    ['pebble', 'pebbleImpactRadius', 'pebbleImpactDelay'],
    ['medium', 'impactRadius', 'impactDelay'],
    ['large', 'largeImpactRadius', 'largeImpactDelay'],
  ] as const)('blasts a %s rock at its size radius and falls for its size warning', (size, radius, delay) => {
    const v = view([tug(10, 20), rock(10, 20, size)]);
    const f = forecastDrop(createDropForecast(), v, [v.entities[0]!], 16, 20);
    expect(f).toMatchObject({ active: true, x: 16, y: 20, radius: rules[radius], rock: size, core: false, count: 1, outOfReach: 0 });
    expect(f.fall).toBeCloseTo(rules[delay], 6);
    expect([...f.from.subarray(0, 2)]).toEqual([10, 20]);
    expect(f.valid).toBe(true);
  });

  it('shows a volatile rock at its public size radius only, never the hidden volatility multiplier', () => {
    const v = view([tug(10, 20), rock(10, 20, 'large', true)]);
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], 12, 20).radius).toBe(rules.largeImpactRadius);
    expect(publicDrop(v.entities[1]!, v.match.rules)!.radius).toBe(rules.largeImpactRadius);
    expect(rules.largeImpactRadius * rules.volatileRadiusMultiplier).toBeGreaterThan(rules.largeImpactRadius);
  });

  it('drops the derelict core at the core-drop radius and flags it inside the hull', () => {
    const v = view([]);
    const ruin = v.match.derelict!;
    expect(ruin).toBeDefined();
    const inside = ent('core', 'core', 'neutral', 'orbit', ruin.x, ruin.y, { state: 'towed' });
    const out = ruin.x + ruin.hullOuter + 1;
    v.entities.push(tug(ruin.x, ruin.y, 'core'), inside);
    const f = forecastDrop(createDropForecast(), v, [v.entities[0]!], ruin.x + 2, ruin.y);
    expect(f).toMatchObject({ active: true, core: true, rock: undefined, radius: rules.coreDropRadius, inHull: true });
    expect(f.fall).toBeCloseTo(rules.coreDropTime, 6);
    expect(f.valid).toBe(false);
    v.entities[0] = tug(out, ruin.y, 'core');
    inside.x = out;
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], out + 2, ruin.y)).toMatchObject({ inHull: false, valid: true });
  });

  it('measures the deorbit reach from each release point (the tow), not the landing', () => {
    const v = view([tug(10, 20, 'a'), rock(10, 20, 'medium', false, 'a'), tug(30, 20, 'b'), rock(30, 20, 'pebble', false, 'b')]);
    const tugs = [v.entities[0]!, v.entities[2]!];
    const reach = rules.deorbitRange;
    const f = forecastDrop(createDropForecast(), v, tugs, 10 + reach, 20);
    expect(f).toMatchObject({ count: 2, outOfReach: 0, reach, radius: rules.impactRadius, rock: 'medium' });
    expect([...f.from.subarray(0, 4)]).toEqual([10, 20, 30, 20]);
    expect(forecastDrop(f, v, tugs, 10 + reach + 0.01, 20)).toMatchObject({ outOfReach: 1, valid: false });
    expect(forecastDrop(f, v, tugs, 50, 50)).toMatchObject({ outOfReach: 2 });
  });

  it('forecasts nothing without a seen tow, for hostile tugs, or past the intent unit cap', () => {
    const v = view([tug(10, 20)]);
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], 12, 20).active).toBe(false);
    v.entities.unshift(rock(10, 20));
    expect(forecastDrop(createDropForecast(), v, [v.entities[1]!], 12, 20).active).toBe(true);
    expect(forecastDrop(createDropForecast(), v, [{ ...v.entities[1]!, side: 'se' }], 12, 20).active).toBe(false);
    expect(forecastDrop(createDropForecast(), undefined, [v.entities[1]!], 12, 20).active).toBe(false);
    const idle = Array.from({ length: UNITS_PER_INTENT }, (_, i) => ent(`idle${i}`, 'tug', 'nw', 'orbit', 0, 0));
    expect(forecastDrop(createDropForecast(), v, [...idle, v.entities[1]!], 12, 20).active).toBe(false);
    expect(dropRadius([...idle, v.entities[1]!], v)).toBe(0);
    expect(dropRadius([v.entities[1]!], v)).toBe(rules.impactRadius);
  });

  it('warns of own and enemy island decks over the blast', () => {
    const v = view([tug(10, 20), rock(10, 20)]);
    const reach = rules.impactRadius + v.match.rules.sky.islandRadius;
    v.entities.push(ent('own-isl', 'island', 'nw', 'sky', 16 + reach - 0.01, 20), ent('foe-isl', 'island', 'se', 'sky', 16, 20 + reach + 0.01));
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], 16, 20)).toMatchObject({ ownIsland: true, enemyIsland: false });
    v.entities[3]!.y -= 0.02;
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], 16, 20)).toMatchObject({ ownIsland: true, enemyIsland: true });
  });

  it('counts hostile Sky screens that reach the fall path: flak gains its payload range, allies never shoot', () => {
    const v = view([tug(10, 20), rock(10, 20)]);
    const tables = ruleTables(v.match.rules);
    const flakReach = tables.stats.flak.range + tables.econ.flakPayloadRange;
    expect(payloadReach(ent('f', 'flak', 'se', 'surface', 0, 0), tables)).toBe(flakReach);
    // Perpendicular to the middle of the path (10, 20) → (18, 20).
    v.entities.push(ent('flak', 'flak', 'se', 'surface', 14, 20 + flakReach - 0.01));
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], 18, 20).screens).toBe(1);
    v.entities[2]!.y += 0.02;
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], 18, 20).screens).toBe(0);
    v.entities[2]!.y -= 0.02;
    v.entities[2]!.side = 'nw';
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], 18, 20).screens).toBe(0);
  });

  it('counts an interceptor past its weapon reach only when the blast reaches its army’s Surface structures (auto-intercept)', () => {
    const v = view([tug(10, 20), rock(10, 20)]);
    const tables = ruleTables(v.match.rules);
    const off = (STATS.interceptor.range + tables.econ.autoInterceptRadius) / 2;
    v.entities.push(ent('int', 'interceptor', 'se', 'sky', 18 + off, 20));
    expect(off).toBeGreaterThan(tables.stats.interceptor.range);
    expect(forecastDrop(createDropForecast(), v, [v.entities[0]!], 18, 20).screens).toBe(0);
    v.entities.push(ent('shaft', 'shaft', 'se', 'surface', 18, 20));
    const f = forecastDrop(createDropForecast(), v, [v.entities[0]!], 18, 20);
    expect(f.screens).toBe(1);
    expect(f.struck).toEqual(['se']);
  });

  it('finds the nearest point on a fall segment, clamped to its ends', () => {
    expect({ ...segmentNearest(5, 3, 0, 0, 10, 0) }).toEqual({ x: 5, y: 0 });
    expect({ ...segmentNearest(-4, 3, 0, 0, 10, 0) }).toEqual({ x: 0, y: 0 });
    expect({ ...segmentNearest(14, -3, 0, 0, 10, 0) }).toEqual({ x: 10, y: 0 });
    expect({ ...segmentNearest(1, 1, 2, 2, 2, 2) }).toEqual({ x: 2, y: 2 });
  });
});
