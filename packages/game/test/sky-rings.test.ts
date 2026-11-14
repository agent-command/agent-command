/** Sky islands: larger maps get more rings (one mirrored pair each), and no two islands ever come within islandClearance. */
import { describe, expect, it } from 'vitest';
import { MAP_SIZES, TERRAIN_PRESETS, checkRules, resolveRules } from '../src/rules/contract.ts';
import { buildWorldFromDocument, generateMapDocument } from '../src/maps/maps.ts';
import { createGame } from '../src/agent/adapter.ts';
import { rotatePoint } from '../src/maps/document.ts';

const SEEDS = [1, 7, 42, 2048];

function islandsOf(size: number, preset: (typeof TERRAIN_PRESETS)[number], seed: number) {
  const rules = resolveRules({ terrain: preset, map: { params: { size } } });
  return { rules, islands: buildWorldFromDocument(generateMapDocument(seed, preset, rules.map, 2, seed)).islands };
}

describe('sky island rings', () => {
  for (const sides of [2, 4] as const) {
    for (const preset of TERRAIN_PRESETS) it(`${preset}: assigns one equal outermost ore ring across sizes and seeds in C${sides}`, () => {
      for (const size of MAP_SIZES) for (const seed of SEEDS) {
        const rules = resolveRules({ terrain: preset, map: { params: { size, slots: sides } } });
        const islands = buildWorldFromDocument(generateMapDocument(seed, preset, rules.map, sides, seed)).islands;
        const deposits = islands.filter(island => island.oreCapacity > 0);
        expect(rules.map.islandOreRings).toBe(1);
        expect(rules.map.islandOreAmount).toBe(240);
        expect(deposits).toHaveLength(sides);
        const outer = Math.max(...islands.map(island => island.r));
        for (const island of islands) expect(island.oreCapacity).toBe(island.r === outer ? 240 : 0);
        const first = deposits[0]!;
        for (let slot = 0; slot < sides; slot++) {
          const island = deposits[slot]!, angle = first.a0 + slot * 2 * Math.PI / sides;
          expect(island.r).toBe(first.r);
          expect(island.w).toBe(first.w);
          expect(Math.cos(island.a0)).toBeCloseTo(Math.cos(angle), 12);
          expect(Math.sin(island.a0)).toBeCloseTo(Math.sin(angle), 12);
        }
        // Every rotated home has the same sorted distances to the same finite ore opportunities.
        const home = { x: rules.map.spireInset + 0.5, y: rules.map.spireInset + 0.5 };
        const distances = (slot: number) => {
          const point = rotatePoint(home, size, slot * 4 / sides);
          return deposits.map(island => Math.hypot(size / 2 + island.r * Math.cos(island.a0) - point.x,
            size / 2 + island.r * Math.sin(island.a0) - point.y)).sort((a, b) => a - b);
        };
        const reference = distances(0);
        for (let slot = 1; slot < sides; slot++) distances(slot).forEach((distance, i) => expect(distance).toBeCloseTo(reference[i]!, 10));
      }
    });

    it(`tunes or disables deposits without changing any other generated data in C${sides}`, () => {
      const generate = (params: { islandOreRings?: number; islandOreAmount?: number; islandRings?: number; islandClearance?: number }) => {
        const rules = resolveRules({ map: { params: { size: 48, slots: sides, ...params } } });
        return buildWorldFromDocument(generateMapDocument(42, 'open', rules.map, sides, 99));
      };
      const baseline = generate({});
      for (const params of [
        { islandOreRings: 0 }, { islandOreAmount: 0 }, { islandOreRings: 2, islandOreAmount: 777 },
        { islandOreRings: 8, islandOreAmount: 100000 },
      ]) {
        const world = generate(params), rings = params.islandOreRings ?? 1, amount = params.islandOreAmount ?? 240;
        const count = Math.min(world.islands.length, rings * sides);
        expect(world.islands.filter(island => island.oreCapacity > 0)).toHaveLength(amount ? count : 0);
        world.islands.forEach((island, i) => expect(island.oreCapacity).toBe(i >= world.islands.length - count ? amount : 0));
        expect({ ...world, islands: world.islands.map(({ oreCapacity: _ore, ...orbit }) => orbit) })
          .toEqual({ ...baseline, islands: baseline.islands.map(({ oreCapacity: _ore, ...orbit }) => orbit) });
      }
      const clipped = generate({ islandRings: 8, islandClearance: 16 });
      expect(clipped.islands.length).toBeGreaterThan(0);
      expect(clipped.islands.length).toBeLessThan(8 * sides);
      expect(clipped.islands.filter(island => island.oreCapacity > 0)).toHaveLength(sides);
      const outer = Math.max(...clipped.islands.map(island => island.r));
      expect(clipped.islands.every(island => island.oreCapacity === (island.r === outer ? 240 : 0))).toBe(true);
      expect(generate({ islandRings: 0 }).islands).toEqual([]);
    });
  }

  it('validates centralized ore knobs at the public deposit bounds', () => {
    expect(checkRules({ map: { params: { islandOreRings: 8, islandOreAmount: 100000 } } }).ok).toBe(true);
    for (const islandOreRings of [-1, 0.5, 9]) expect(checkRules({ map: { params: { islandOreRings } } }).ok).toBe(false);
    for (const islandOreAmount of [-1, 0.5, 100001]) expect(checkRules({ map: { params: { islandOreAmount } } }).ok).toBe(false);
  });

  for (const preset of TERRAIN_PRESETS) {
    it(`${preset}: ring count grows with map size, one mirrored pair per ring`, () => {
      for (const seed of SEEDS) {
        const counts = MAP_SIZES.map((size) => {
          const { islands } = islandsOf(size, preset, seed);
          const radii = islands.map((i) => i.r);
          const rings = [...new Set(radii)];
          for (const r of rings) expect(radii.filter((x) => x === r), `${preset} ${size} r=${r}`).toHaveLength(2);
          for (let k = 0; k < islands.length; k += 2) {
            // Point mirror: same orbit, opposite side, same angular speed.
            expect(islands[k + 1]!.r).toBe(islands[k]!.r);
            expect(islands[k + 1]!.w).toBe(islands[k]!.w);
            expect(Math.cos(islands[k + 1]!.a0)).toBeCloseTo(-Math.cos(islands[k]!.a0), 12);
            expect(Math.sin(islands[k + 1]!.a0)).toBeCloseTo(-Math.sin(islands[k]!.a0), 12);
          }
          return rings.length;
        });
        for (let i = 1; i < counts.length; i++) expect(counts[i], `${preset} seed ${seed}: ${counts.join(',')}`).toBeGreaterThan(counts[i - 1]!);
      }
    });

    it(`${preset}: no two islands come within islandClearance at any tick of the longest orbit`, () => {
      for (const size of MAP_SIZES) for (const seed of SEEDS) {
        const { rules, islands } = islandsOf(size, preset, seed);
        const c = size / 2;
        const period = Math.max(...islands.map((i) => Math.abs(2 * Math.PI / i.w)));
        let closest = Infinity;
        for (let t = 0; t <= period; t += 5) {
          const at = islands.map((i) => [c + i.r * Math.cos(i.a0 + i.w * t), c + i.r * Math.sin(i.a0 + i.w * t)] as const);
          for (let a = 0; a < at.length; a++) {
            expect(at[a]![0] - rules.map.islandClearance / 2).toBeGreaterThanOrEqual(-1e-9);
            expect(at[a]![0] + rules.map.islandClearance / 2).toBeLessThanOrEqual(size + 1e-9);
            expect(at[a]![1] - rules.map.islandClearance / 2).toBeGreaterThanOrEqual(-1e-9);
            expect(at[a]![1] + rules.map.islandClearance / 2).toBeLessThanOrEqual(size + 1e-9);
            for (let b = a + 1; b < at.length; b++) closest = Math.min(closest, Math.hypot(at[a]![0] - at[b]![0], at[a]![1] - at[b]![1]));
          }
        }
        expect(closest, `${preset} S${size} seed ${seed}`).toBeGreaterThanOrEqual(rules.map.islandClearance - 1e-9);
      }
    });
  }

  it('the match spawns exactly the generated islands at every size', () => {
    for (const size of MAP_SIZES) {
      const game = createGame({ seed: 3, options: { map: { seed: 3, params: { size } } } });
      const islands = game.sim.ents.filter((e) => e.kind === 'island' && !e.dead);
      expect(islands).toHaveLength(game.sim.mapDocument ? buildWorldFromDocument(game.sim.mapDocument).islands.length : 0);
      const orbits = buildWorldFromDocument(game.sim.mapDocument).islands;
      islands.forEach((island, i) => {
        expect(island.oreCapacity).toBe(orbits[i]!.oreCapacity);
        expect(island.oreRemaining).toBe(orbits[i]!.oreCapacity);
        expect(island.oreBuffer).toBe(0);
      });
    }
  });
});
