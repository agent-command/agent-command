import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { CELL, DEFAULT_RULES, SPIRE_INSET_MAX, SPIRE_INSET_MIN, STATS, STRUCTURE_SPACING, SURFACE, TERRAIN_PRESETS, checkRules, compileRules, footprintDistance, footprintMinX, footprintMinY, resolveRules } from '../src/rules/contract.ts';
import { cellOf } from '../src/util/grid.ts';
import { slotOfArmyId } from '../src/util/teams.ts';
import { generateTerrain, generateWorld } from '../src/maps/world.ts';
import { mirrorCell } from '../src/util/grid.ts';
import { orbitAsymmetry } from './mirror.ts';

const inner = (x: number, y: number, size: number): boolean => x >= 1 && y >= 1 && x <= size - 2 && y <= size - 2;
/** The rule holding each plane's default rally distance past the Spire footprint edge. */
const RALLY = { surface: 'surfaceRally', sky: 'skyRally', orbit: 'orbitRally' } as const;
const options = (spireInset: number) => (spireInset === DEFAULT_RULES.map.spireInset ? {} : { map: { params: { spireInset } } });

describe('map.spireInset', () => {
  it('rejects insets that cannot hold the Spire pocket and home layout, naming the field', () => {
    for (const spireInset of [SPIRE_INSET_MIN - 1, SPIRE_INSET_MAX + 1, 4.5]) {
      expect(checkRules({ map: { params: { spireInset } } })).toEqual({ ok: false, error: `rules.map.params.spireInset: must be an integer from ${SPIRE_INSET_MIN} to ${SPIRE_INSET_MAX}` });
    }
    for (let spireInset = SPIRE_INSET_MIN; spireInset <= SPIRE_INSET_MAX; spireInset++) expect(checkRules({ map: { params: { spireInset } } }).ok).toBe(true);
  });

  it(`the outer island ring stays outside the Sky segment beam's reach to a relay at the default inset (${DEFAULT_RULES.map.spireInset})`, () => {
    // At insets 4 and 8 the same ring passes inside it (by 0.13 and 5.79 tiles), so the check can tell them apart.
    for (const [spireInset, clear] of [[DEFAULT_RULES.map.spireInset, true], [4, false], [8, false]] as const) {
      const s = createGame({ seed: 1, options: options(spireInset) }).sim;
      const outer = Math.max(...s.ents.filter((e) => e.kind === 'island').map((e) => e.orbitR));
      expect(outer).toBe(20);
      for (const team of (['nw', 'se'] as const)) {
        const segment = s.armies[slotOfArmyId(team, 2)]!.spire.sky;
        // Island structures ride exactly on their island: sweep a relay round the whole ring.
        const relay = s.add('relay', slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2), 'sky', s.size / 2, s.size / 2);
        let hit = false;
        for (let k = 0; k < 7200 && !hit; k++) {
          const a = (k / 7200) * Math.PI * 2;
          relay.x = s.size / 2 + Math.cos(a) * outer;
          relay.y = s.size / 2 + Math.sin(a) * outer;
          hit = s.inRange(segment, relay);
        }
        expect(hit, `inset ${spireInset}, ${team} Sky segment`).toBe(!clear);
        relay.dead = true;
      }
    }
  });

  for (const spireInset of [DEFAULT_RULES.map.spireInset, 4, 5, 8]) {
    describe(`inset ${spireInset}`, () => {
      const map = resolveRules(options(spireInset)).map;
      const spires = compileRules(resolveRules(options(spireInset))).spires;

      it('places point-mirrored Spire centres on whole cells', () => {
        expect(spires.nw).toEqual({ x: spireInset + 0.5, y: spireInset + 0.5 });
        expect(spires.se).toEqual({ x: map.size - spires.nw.x, y: map.size - spires.nw.y });
        const f = STATS.spire.footprint;
        expect(footprintMinX('spire', spires.nw.x)).toBe(spireInset - 1);
        expect(footprintMinY('spire', spires.se.y)).toBe(map.size - f.h - footprintMinY('spire', spires.nw.y));
      });

      for (const preset of TERRAIN_PRESETS) {
        it(`${preset}: lays out the pocket, home lodes and cavern around the Spire, mirrored`, () => {
          for (const seed of [1, 2, 3, 4]) {
            const terrain = generateTerrain(seed, preset, map, 2);
            const world = generateWorld(seed, terrain, map, 2, seed);
            const size = world.size, N = size * size;
            for (let c = 0; c < N; c++) {
              expect(world.cells[c]).toBe(world.cells[mirrorCell(c, size)]);
              expect(world.terrain[c]).toBe(world.terrain[mirrorCell(c, size)]);
            }
            // The solid footprint and its loading apron are pre-dug, owned and inside the bedrock border.
            const f = STATS.spire.footprint;
            for (const team of (['nw', 'se'] as const)) {
              const p = spires[team];
              for (let y = p.y - f.h / 2 - STRUCTURE_SPACING; y < p.y + f.h / 2 + STRUCTURE_SPACING; y++) {
                for (let x = p.x - f.w / 2 - STRUCTURE_SPACING; x < p.x + f.w / 2 + STRUCTURE_SPACING; x++) {
                  expect(inner(x, y, size)).toBe(true);
                  expect(world.cells[y * size + x]).toBe(CELL.tunnel);
                  // Pocket cells carry their slot + 1; army i holds slot i in a two-army match.
                  expect(world.owner[y * size + x]).toBe(slotOfArmyId(team, 2) + 1);
                }
              }
              // Bases stay clear ground.
              expect(world.terrain[cellOf(p.x, p.y, size)]).toBe(SURFACE.ground);
            }
            // Every requested home lode pair is placed in the band around the blue Spire (its twin mirrors it).
            const home = world.generation.lodes.find((z) => z.zone === 'home')!;
            expect(home).toMatchObject({ requested: map.homeLodes, placed: map.homeLodes, missing: 0, fallback: 0 });
            const homeLodes = world.lodes.filter((l, i) => i % 2 === 0 && !l.rich);
            expect(homeLodes).toHaveLength(map.homeLodes);
            for (const l of homeLodes) {
              const r = Math.hypot((l.c % size) + 0.5 - spires.nw.x, Math.floor(l.c / size) + 0.5 - spires.nw.y);
              expect(r).toBeGreaterThanOrEqual(map.homeLodeMinRadius);
              expect(r).toBeLessThanOrEqual(map.homeLodeMaxRadius);
            }
            // The cavern leaves blue's pocket and reaches the centre chamber through tunnel cells.
            const start = cellOf(spires.nw.x, spires.nw.y, size);
            const seen = new Uint8Array(N);
            const queue = [start];
            seen[start] = 1;
            for (let i = 0; i < queue.length; i++) {
              const c = queue[i]!;
              for (const n of [c % size ? c - 1 : -1, c % size < size - 1 ? c + 1 : -1, c - size, c + size]) {
                if (n < 0 || n >= N || seen[n] || world.cells[n] !== CELL.tunnel) continue;
                seen[n] = 1;
                queue.push(n);
              }
            }
            // The cavern reaches the centre chamber: the Mother Lode fills the centre 2×2 (map.motherLode: solid, never
            // dug), so the walk ends in its open ring, beside the lode cell at (size/2 − 1, size/2 − 1).
            const lode = (size / 2 - 1) * size + size / 2 - 1;
            expect(world.cells[lode]).toBe(CELL.lode);
            expect(seen[lode - 1]! | seen[lode - size]!).toBe(1);
            expect(world.cavern.some((c) => c !== start && seen[c])).toBe(true);
          }
        });
      }

      it('spawns every starting unit on the map around its own Spire, mirrored', () => {
        for (const seed of [1, 2]) {
          const g = createGame({ seed, options: options(spireInset) });
          expect(g.sim.spireAt).toEqual((['nw', 'se'] as const).map((team) => spires[team]));
          for (const team of (['nw', 'se'] as const)) {
            for (const seg of Object.values(g.sim.armies[slotOfArmyId(team, 2)]!.spire)) expect({ x: seg.x, y: seg.y }).toEqual(spires[team]);
          }
          for (const e of g.sim.ents) {
            if (!e.unit) continue;
            const home = spires[g.sim.armyIds[e.side]!];
            expect(e.x > 0 && e.y > 0 && e.x < g.sim.size && e.y < g.sim.size).toBe(true);
            if (e.plane === 'depths') {
              // On an open tunnel by its Spire that its own army knows (the pocket or the cavern mouth beside it).
              const c = cellOf(e.x, e.y, g.sim.size);
              expect(g.sim.cells[c]).toBe(CELL.tunnel);
              expect(g.sim.armies[e.side]!.group.known[c]).toBe(CELL.tunnel);
              expect(footprintDistance('spire', home.x, home.y, e.x, e.y)).toBeLessThan(STRUCTURE_SPACING + 1);
              continue;
            }
            if (e.plane === 'surface') expect(g.sim.terrain[cellOf(e.x, e.y, g.sim.size)]).not.toBe(SURFACE.cliff);
            // Off the Depths new units clear their Spire by movement.rallyClearance (its exits stay free) and stand no
            // farther out than the plane's default rally point.
            const edge = footprintDistance('spire', home.x, home.y, e.x, e.y);
            expect(edge - e.radius).toBeGreaterThanOrEqual(g.sim.econ.rallyClearance);
            expect(edge).toBeLessThanOrEqual(g.sim.econ[RALLY[e.plane]]);
          }
          expect(orbitAsymmetry(g.sim)).toBeUndefined();
          const matchData = g.matchData({ team: 'se', role: 'surface' });
          expect(Object.fromEntries(matchData.armies.map((a) => [a.id, a.spireAt]))).toEqual({ nw: spires.nw, se: spires.se });
          for (let t = 0; t < 200; t++) g.step();
          expect(orbitAsymmetry(g.sim)).toBeUndefined();
        }
      });
    });
  }
});
