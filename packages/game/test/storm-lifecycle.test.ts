import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, STATS, TICK_RATE, spirePositions, compileRules, resolveRules, toTicks, type MatchOptions, type NaturalStorm } from '../src/rules/contract.ts';
import { Sim } from '../src/sim/sim.ts';
import { SkyWeather, sampleStorm, weatherStormAt, type StormSample } from '@agent-command/game/weather';

const quick: MatchOptions['sky'] = {
  stormSets: 2, stormForecastMin: 1, stormForecastMax: 1, stormGrow: 2,
  stormLifetimeMin: 3, stormLifetimeMax: 5, stormBreak: 2, stormCalmMin: 1, stormCalmMax: 2,
};
const scratch = (): StormSample => ({ x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' });
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);
const makeWeather = (seed = 42, sky: MatchOptions['sky'] = {}): SkyWeather =>
  new SkyWeather(compileRules(resolveRules({ sky })).econ, seed, [DEFAULT_SPIRES.nw, DEFAULT_SPIRES.se], STATS.spire.range, DEFAULT_RULES.map.size, 2);

function expectPairs(cells: NaturalStorm[], size: number): void {
  expect(cells.length % 2).toBe(0);
  for (let i = 0; i < cells.length; i += 2) {
    const a = cells[i]!, b = cells[i + 1]!;
    expect(a.turns).toBe(0);
    expect(b.turns).toBe(2);
    expect(b.id).toBe(a.id + 1);
    expect(b.x).toBe(size - a.x);
    expect(b.y).toBe(size - a.y);
    for (const key of ['originX', 'originY', 'dx', 'dy', 'maxRadius', 'radius', 'strength', 'stage', 'start', 'grown', 'breaking', 'end'] as const) {
      expect(b[key]).toBe(a[key]);
    }
  }
}

describe('natural storm lifecycles', () => {
  it('samples linear drift and exact lifecycle boundaries into caller-owned scratch', () => {
    const c: NaturalStorm = {
      id: 0, x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast', maxRadius: 8,
      originX: 46, originY: 20, dx: 0.1, dy: -0.05, turns: 0,
      start: 10, grown: 30, breaking: 50, end: 70,
    };
    const out = scratch();
    for (const [tick, radius, stage] of [
      [0, 0, 'forecast'], [10, 0, 'forming'], [20, 4, 'forming'], [30, 8, 'mature'],
      [49, 8, 'mature'], [50, 8, 'breaking'], [60, 4, 'breaking'], [70, 0, 'breaking'], [100, 0, 'breaking'],
    ] as const) {
      sampleStorm(c, tick, out, 0, DEFAULT_RULES.map.size);
      const age = Math.max(0, Math.min(tick - c.start, c.end - c.start));
      expect(out).toEqual({ x: c.originX + c.dx * age, y: c.originY + c.dy * age, radius, strength: radius / c.maxRadius, stage });
      const mirrored = scratch();
      sampleStorm({ ...c, turns: 2 }, tick, mirrored, 0, DEFAULT_RULES.map.size);
      expect(mirrored).toEqual({ ...out, x: DEFAULT_RULES.map.size - out.x, y: DEFAULT_RULES.map.size - out.y });
    }
    expect(c.radius).toBe(0);
    expect(c.stage).toBe('forecast');
  });

  it('starts with only a 20–30 second forecast, then forms exactly the announced lifecycle', () => {
    const w = makeWeather();
    expect(w.data.storms).toEqual([]);
    expect(w.data.forecast).toHaveLength(2);
    expectPairs(w.data.forecast, w.size);
    const announced = structuredClone(w.data.forecast);
    for (const c of announced) {
      expect(c.start).toBeGreaterThanOrEqual(toTicks(20));
      expect(c.start).toBeLessThanOrEqual(toTicks(30));
      expect(c.stage).toBe('forecast');
      expect(c.radius).toBe(0);
      expect(c.strength).toBe(0);
      expect(w.stormMask(c.x, c.y)).toBe(0);
      expect(w.strengthAt(c.x, c.y)).toBe(0);
      expect(weatherStormAt(w.data, c.x, c.y, w.size)).toBe(false);
    }
    const first = announced[0]!;
    for (const tick of [first.start - 1, first.start, first.start + 1, first.grown, first.breaking, first.end - 1]) {
      w.update(tick);
      for (const c of announced) {
        const actual = [...w.data.storms, ...w.data.forecast].find(storm => storm.id === c.id)!;
        expect(actual).toBeDefined();
        const expected = scratch();
        sampleStorm(c, tick, expected, 0, w.size);
        expect(actual).toEqual({ ...c, ...expected });
      }
    }
    w.update(first.end);
    expect(w.data.storms.some(c => announced.some(old => old.id === c.id))).toBe(false);
    expect(w.data.forecast.some(c => announced.some(old => old.id === c.id))).toBe(false);
  });

  it('preserves exact mirrored pairs and bounded counts over hours of reforms', () => {
    const w = makeWeather(91);
    const sites = new Map<number, { x: number; y: number }>();
    let maxCurrent = 0;
    for (let tick = 0; tick <= toTicks(4 * 60 * 60); tick += 137) {
      w.update(tick);
      expect(w.data.storms.length + w.data.forecast.length).toBeLessThanOrEqual(4);
      maxCurrent = Math.max(maxCurrent, w.data.storms.length);
      expectPairs(w.data.storms, w.size);
      expectPairs(w.data.forecast, w.size);
      for (const c of [...w.data.storms, ...w.data.forecast]) {
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.x).toBeLessThanOrEqual(w.size);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeLessThanOrEqual(w.size);
        expect(c.radius).toBeGreaterThanOrEqual(0);
        expect(c.radius).toBeLessThanOrEqual(c.maxRadius);
        expect(c.strength).toBeCloseTo(c.radius / c.maxRadius, 14);
        if (c.turns !== 0 || sites.has(c.id)) continue;
        const previous = sites.get(c.id - 4);
        if (previous) expect({ x: c.originX, y: c.originY }).not.toEqual(previous);
        sites.set(c.id, { x: c.originX, y: c.originY });
      }
      for (const c of w.data.storms) {
        expect(c.stage).not.toBe('forecast');
        expect(c.start).toBeLessThanOrEqual(tick);
        expect(c.end).toBeGreaterThan(tick);
        expect(w.stormMask(c.x, c.y) === 0).toBe(w.stormMask(w.size - c.x, w.size - c.y) === 0);
        expect(w.strengthAt(c.x, c.y)).toBe(w.strengthAt(w.size - c.x, w.size - c.y));
      }
      for (const c of w.data.forecast) {
        expect(c.stage).toBe('forecast');
        expect(c.start).toBeGreaterThan(tick);
        expect(c.start - tick).toBeLessThanOrEqual(toTicks(30));
      }
    }
    expect(maxCurrent).toBe(4);
    expect(sites.size).toBeGreaterThan(100);
  });

  it('hides future sites until the warning and preserves calm before the next forecast', () => {
    const w = makeWeather(8, { ...quick, stormSets: 1, stormCalmMin: 2, stormCalmMax: 2 });
    const first = structuredClone(w.data.forecast[0]!);
    w.update(first.start);
    expect(w.data.forecast).toEqual([]);
    w.update(first.end);
    expect(w.data.storms).toEqual([]);
    expect(w.data.forecast).toEqual([]);
    w.update(first.end + toTicks(2) - 1);
    expect(w.data.forecast).toEqual([]);
    w.update(first.end + toTicks(2));
    expect(w.data.storms).toEqual([]);
    expect(w.data.forecast).toHaveLength(2);
    const next = w.data.forecast[0]!;
    expect(next.id).not.toBe(first.id);
    expect(next.start).toBe(first.end + toTicks(3));
    expect({ x: next.originX, y: next.originY }).not.toEqual({ x: first.originX, y: first.originY });
  });

  it('never forms a full-radius cell inside rule-derived Spire beam reach', () => {
    for (const beam of [3, 7, 12]) for (const seed of [1, 9, 77, 999]) {
      const s = new Sim(seed, { spire: { range: beam }, sky: quick });
      const seen = new Set<number>();
      for (let tick = 0; tick <= toTicks(180); tick += 11) {
        s.weather.update(tick);
        for (const c of [...s.weather.data.forecast, ...s.weather.data.storms]) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          const x = c.turns === 2 ? s.size - c.originX : c.originX;
          const y = c.turns === 2 ? s.size - c.originY : c.originY;
          for (const t of s.armies) {
            const spire = t.spire.sky;
            expect(Math.hypot(x - spire.x, y - spire.y)).toBeGreaterThan(beam + c.maxRadius);
          }
        }
      }
      expect(seen.size).toBeGreaterThan(20);
    }
  });

  it('is seed-deterministic across update cadence without consuming the simulation RNG', () => {
    const a = makeWeather(17, quick), b = makeWeather(17, quick);
    const other = makeWeather(18, quick);
    expect(a.data).toEqual(b.data);
    expect(a.data.forecast).not.toEqual(other.data.forecast);
    for (let tick = 0; tick <= toTicks(120); tick++) {
      a.update(tick);
      if (tick % 137 === 0 || tick === toTicks(120)) {
        b.update(tick);
        expect(a.data).toEqual(b.data);
      }
    }
    const enabled = new Sim(17, { sky: quick });
    const disabled = new Sim(17, { sky: { stormSets: 0 } });
    expect(enabled.rng).toEqual(disabled.rng);
    const before = structuredClone(enabled.rng);
    for (let tick = 0; tick <= toTicks(600); tick += 73) enabled.weather.update(tick);
    expect(enabled.rng).toEqual(before);
  });

  it('keeps an existing pair independent of the other pair and other random systems', () => {
    const one = makeWeather(23, { ...quick, stormSets: 1 });
    const two = makeWeather(23, quick);
    // The match's weather stream is its own (one-way from the match seed): asteroid draws never shift it.
    const s = new Sim(23, { sky: quick });
    const quiet = new Sim(23, { sky: quick });
    for (let tick = 0; tick <= toTicks(120); tick += 17) {
      one.update(tick);
      two.update(tick);
      s.rng.next();
      s.rockRng.next();
      s.weather.update(tick);
      quiet.weather.update(tick);
      expect([...one.data.storms, ...one.data.forecast].filter(c => c.id % 4 < 2))
        .toEqual([...two.data.storms, ...two.data.forecast].filter(c => c.id % 4 < 2));
      expect(s.weather.data).toEqual(quiet.weather.data);
    }
  });
  it('isolates and hashes future weather RNG and lifecycle state across checkpoint re-forms', () => {
    const s = new Sim(17, { sky: quick });
    const copy = s.clone();
    expect(copy.hash()).toBe(s.hash());
    copy.weather.random[0]!.next();
    expect(copy.hash()).not.toBe(s.hash());
    const changed = s.clone();
    changed.weather.data.forecast[0]!.maxRadius -= 0.1;
    expect(changed.hash()).not.toBe(s.hash());
    const replay = s.clone();
    for (let tick = 0; tick <= toTicks(120); tick += 11) {
      s.weather.update(tick);
      replay.weather.update(tick);
      expect(replay.weather.data).toEqual(s.weather.data);
      expect(replay.hash()).toBe(s.hash());
    }
  });

  it('stamps exactly the same membership bits for four natural cells and seeded storms', () => {
    const w = makeWeather(17, quick);
    w.update(toTicks(6));
    expect(w.data.storms).toHaveLength(4);
    w.seed(0, 16, 16, 5, toTicks(30), 0);
    w.finishSeeds(1, 0);
    w.refreshMask();
    for (let y = 0; y < w.size; y++) for (let x = 0; x < w.size; x++) {
      expect(w.mask[y * w.size + x]).toBe(w.stormMask(x + 0.5, y + 0.5));
    }
  });


  it('uses the strongest overlapping lifecycle and preserves full-strength seeded cells', () => {
    const w = makeWeather(6, { ...quick, stormSets: 1 });
    const cells = w.data.forecast;
    for (const c of cells) {
      c.originX = c.originY = w.size / 2;
      c.dx = c.dy = 0;
      c.maxRadius = 8;
      c.start = 0;
      c.grown = toTicks(2);
      c.breaking = toTicks(4);
      c.end = toTicks(6);
    }
    w.update(TICK_RATE);
    expect(w.data.storms[0]!.radius).toBe(4);
    expect(w.strengthAt(24, 24)).toBe(0.5);
    expect(w.strengthAt(29, 24)).toBe(0);
    w.seed(0, 24, 24, 5, toTicks(30), 0);
    w.finishSeeds(1, 0);
    expect(w.strengthAt(24, 24)).toBe(1);
    expect(w.strengthAt(29, 24)).toBe(1);
    w.finishSeeds(0, 0);
    expect(w.strengthAt(24, 24)).toBe(0.5);
    w.update(toTicks(5));
    expect(w.strengthAt(24, 24)).toBe(0.5);
    w.update(toTicks(6));
    expect(w.strengthAt(24, 24)).toBe(0);
  });
});
