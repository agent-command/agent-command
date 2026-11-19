import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import {
  CELL, MAP_SIZES, PLANES, SURFACE, TERRAIN_CELLS_PER_WORD, TICK_RATE, VISION_BITS_PER_WORD, checkRules, resolveRules,
  matchDataSchema, observationSchema, packTerrain, unpackTerrain, viewSchema,
} from '../src/rules/contract.ts';
import { applyIntent } from '../src/agent/intents.ts';
import { createGame } from '../src/agent/adapter.ts';
import { matchData, view } from '../src/agent/present.ts';
import { mapEntities, mapEntity, mapLayerValues, setMapLayerValues } from '../src/maps/document.ts';
import { generateMapDocument } from '../src/maps/maps.ts';
import { Sim } from '../src/sim/sim.ts';
import { adjacent4, cellFor, cellOf, cellOfEnt, clampPos } from '../src/util/grid.ts';
import { sampleStorm, weatherStormAt } from '../src/planes/weather.ts';
import { Rng } from '../src/util/rng.ts';

const make = (size: number, seed = 123): Sim => new Sim(seed, { terrain: 'open', map: { params: { size } } });
const bitAt = (words: readonly number[], c: number): number => (words[Math.floor(c / VISION_BITS_PER_WORD)]! >>> (c % VISION_BITS_PER_WORD)) & 1;
/** Clears one army's vision group bit from every plane, leaving other groups' vision alone. */
const blind = (sim: Sim, army: number): void => {
  const bit = sim.armies[army]!.group.bit;
  for (const plane of sim.vis) for (let c = 0; c < plane.length; c++) plane[c]! &= ~bit;
};

describe('per-match map dimensions', () => {
  it('accepts exactly the supported numeric sizes and defaults to S48', () => {
    expect(new Sim(123).size).toBe(48);
    for (const size of MAP_SIZES) expect(checkRules({ map: { params: { size } } }).ok).toBe(true);
    for (const size of [0, 47, 49, 63, 65, 79, 81, 64.5, '64']) {
      expect(checkRules({ map: { params: { size } } }).ok).toBe(false);
    }
  });

  it('keeps simultaneous S48, M64, and L80 simulations and checkpoints independent', () => {
    const small = make(48);
    const reference = small.clone();
    const medium = make(64);
    const large = make(80);
    for (const sim of [small, medium, large]) {
      expect(sim.size).toBe(sim.rules.map.size);
      expect(sim.n).toBe(sim.size * sim.size);
      for (const grid of [sim.cells, sim.ore, sim.owner, sim.terrain, sim.holes, sim.block,
        sim.surfaceBodies, sim.depthBodies, sim.surfaceCost, sim.gate, sim.bulkheadAt,
        sim.work, sim.tough, sim.magma, sim.lodeAt, sim.faultOf, sim.faultAt, sim.weather.mask]) {
        expect(grid.length).toBe(sim.n);
      }
      // Vision, tremor and spotting bit-planes are shared by every vision group.
      for (const grid of [...sim.vis, sim.feel, sim.spot]) expect(grid.length).toBe(sim.n);
      for (const army of sim.allArmies) {
        const state = sim.armies[army]!;
        const group = state.group;
        for (const grid of [group.known, state.designations, state.designationKnown,
          state.designationGate, state.designationReserved, state.designationDistance,
          state.designationOwner, state.designationNext, state.designationVia, state.drop,
          state.oreField, state.oreGoal, group.pocketKnown,
          group.cracks, group.gateKnown, sim.surfaceNav[army]!, sim.depthNav[army]!, sim.knownKeep[army]!]) {
          expect(grid.length).toBe(sim.n);
        }
        expect(state.designationWords.normal.length).toBe(Math.ceil(sim.n / VISION_BITS_PER_WORD));
        expect(state.designationWords.urgent.length).toBe(Math.ceil(sim.n / VISION_BITS_PER_WORD));
      }
      expect(sim.spireAt[1]!.x).toBe(sim.size - sim.spireAt[0]!.x);
      expect(sim.weather.data.jets.every(lane => lane.x1 <= sim.size && lane.x2 <= sim.size)).toBe(true);
      expect(sim.weather.data.fog.every(cloud => cloud.path.cx === sim.size / 2 && cloud.path.cy === sim.size / 2)).toBe(true);
    }
    for (let tick = 0; tick < 12; tick++) {
      large.step();
      small.step();
      medium.step();
      reference.step();
    }
    expect(small.hash()).toBe(reference.hash());
    expect(small.cells).not.toBe(medium.cells);
    expect(medium.vis[0]).not.toBe(large.vis[0]);
    const checkpoint = large.clone();
    large.step();
    checkpoint.step();
    expect(checkpoint.size).toBe(80);
    expect(checkpoint.hash()).toBe(large.hash());
  });

  for (const size of MAP_SIZES) {
    it(`uses explicit S/M/L geometry for coordinates and row bounds at ${size}`, () => {
      const last = size * size - 1;
      expect(cellOf(size, size, size)).toBe(last);
      expect(cellOf(-1, -1, size)).toBe(0);
      expect(cellOf(size - 1.5, size - 2.5, size)).toBe((size - 3) * size + size - 2);
      expect(cellFor(2, size - 10, size - 12, size)).toBe(last - cellFor(0, 10, 12, size));
      expect(cellOfEnt({ cell: -1, frame: 0, x: size - 1.5, y: size - 1.5 }, size)).toBe((size - 2) * size + size - 2);
      expect(cellOfEnt({ cell: last, frame: 2, x: 1, y: 1 }, size)).toBe(last);
      expect(adjacent4(size - 1, size, size)).toBe(false);
      expect(adjacent4(last, last - size, size)).toBe(true);
      expect(clampPos(size + 1, size)).toBeLessThan(size);
      expect(clampPos(-1, size)).toBeGreaterThan(0);
      expect(clampPos(7.25, size) + clampPos(size - 7.25, size)).toBe(size);
    });

    it(`packs complete terrain, knowledge, fog and designations at ${size}`, () => {
      // Through the adapter: what clients and agents receive, with the team signals the wire schemas require.
      const g = createGame({ seed: 123, options: { terrain: 'open', map: { params: { size } } } });
      const sim = g.sim;
      const codes = Object.values(SURFACE);
      const terrain = Uint8Array.from({ length: sim.n }, (_, c) => codes[c % codes.length]!);
      const packed = packTerrain(terrain);
      expect(packed.length).toBe(Math.ceil(sim.n / TERRAIN_CELLS_PER_WORD));
      expect(unpackTerrain(packed, size)).toEqual(terrain);
      const data = matchData(sim, 0);
      expect(data.rules.map.size).toBe(size);
      expect(data.terrain.length).toBe(Math.ceil(sim.n / TERRAIN_CELLS_PER_WORD));
      expect(unpackTerrain(data.terrain, size)).toEqual(sim.terrain);
      expect(validate(matchDataSchema, data).ok).toBe(true);

      const last = sim.n - 1;
      for (const visibility of sim.vis) visibility.fill(0);
      sim.vis[3]![last] = sim.armies[0]!.group.bit;
      sim.designateCell(sim.armies[0]!, last - 1, 2);
      const snapshot = g.view('nw', { snapshot: true });
      expect(snapshot.depths.length).toBe(sim.n);
      for (const plane of PLANES) expect(snapshot.vision[plane].length).toBe(Math.ceil(sim.n / VISION_BITS_PER_WORD));
      expect(bitAt(snapshot.vision.orbit, last)).toBe(1);
      expect(bitAt(snapshot.vision.surface, last)).toBe(0);
      expect(bitAt(snapshot.designations.urgent, last - 1)).toBe(1);
      const lastWord = snapshot.vision.orbit.at(-1)!;
      if (sim.n % VISION_BITS_PER_WORD) expect(lastWord >>> (sim.n % VISION_BITS_PER_WORD)).toBe(0);
      expect(validate(viewSchema, snapshot).ok).toBe(true);
      const obs = g.observe({ team: 'nw', role: 'depths' }, -1, PLANES);
      expect(obs.depths?.length).toBe(sim.n);
      expect(validate(observationSchema, obs).ok).toBe(true);
    });

    it(`rejects out-of-match coordinates before reading terrain at ${size}`, () => {
      const sim = make(size);
      const unit = sim.spawnUnit(0, 'digger', 'depths');
      const units = [`e_${unit.id}`];
      expect(applyIntent(sim, 0, 'depths', { kind: 'move', units, x: size + 0.1, y: 2 })).toEqual({ ok: false, code: 'invalid_target' });
      expect(applyIntent(sim, 0, 'depths', { kind: 'dig', units, x: size, y: 2 })).toEqual({ ok: false, code: 'invalid_target' });
      expect(applyIntent(sim, 0, 'depths', { kind: 'designate', rect: { x0: 2, y0: 2, x1: size, y1: 3 }, priority: 1 })).toEqual({ ok: false, code: 'invalid_target' });
      expect(applyIntent(sim, 0, 'depths', { kind: 'designate', cells: [{ x: size, y: 2 }], priority: 1 })).toEqual({ ok: false, code: 'invalid_target' });
      expect(applyIntent(sim, 0, 'surface', { kind: 'queue_add', item: 'turret', x: size, y: 2 })).toEqual({ ok: false, code: 'invalid_target' });
      const c = (size - 2) * size + size - 2;
      sim.armies[0]!.group.known[c] = CELL.unknown;
      expect(applyIntent(sim, 0, 'depths', { kind: 'designate', cells: [{ x: size - 2, y: size - 2 }], priority: 2 })).toEqual({ ok: true });
      expect(sim.armies[0]!.designations[c]).toBe(2);
    });

    it(`routes depths orders at the far edge and never wraps rows at ${size}`, () => {
      const sim = make(size);
      for (const entity of sim.ents) if (entity.unit) entity.dead = true;
      sim.cells.fill(CELL.bedrock);
      const y = size - 12;
      const x = size - 16;
      for (let dx = 0; dx <= 4; dx++) sim.cells[y * size + x + dx] = CELL.tunnel;
      sim.armies[0]!.group.known.set(sim.cells);
      const unit = sim.add('trooper', 0, 'depths', x + 0.5, y + 0.5);
      unit.cell = y * size + x;
      unit.stance = 'hold';
      expect(applyIntent(sim, 0, 'depths', { kind: 'move', units: [`e_${unit.id}`], x: x + 4.5, y: y + 0.5 })).toEqual({ ok: true });
      for (let tick = 0; tick < 80; tick++) sim.step();
      expect(unit.cell).toBe(y * size + x + 4);
      expect(unit.x).toBe(x + 4.5);
      expect(unit.y).toBe(y + 0.5);
    });

    it(`does not reveal far-side entities through incorrectly indexed fog at ${size}`, () => {
      const sim = make(size);
      const hidden = sim.add('trooper', 1, 'surface', size - 8.5, size - 8.5);
      blind(sim, 0);
      // Fog read at the wrong cell would show it now and so name it; unnamed, no view can show it.
      sim.noteSightings();
      expect(sim.aliasOf(0, hidden.id)).toBe(0);
      sim.scan(0, hidden.x, hidden.y);
      expect(view(sim, 'nw').entities.some(e => e.id === `e_${sim.aliasOf(0, hidden.id)}`)).toBe(true);
      const c = cellOfEnt(hidden, size);
      expect(bitAt(view(sim, 'nw').vision.surface, c)).toBe(1);
    });

    it(`reflects weather and stamps storm masks at ${size}`, () => {
      const sim = make(size);
      sim.weather.seed(0, size - 2.5, size - 2.5, 1, 100, 0);
      sim.weather.finishSeeds(1, 0);
      sim.weather.refreshMask();
      expect(sim.weather.mask[(size - 3) * size + size - 3]! & 16).toBe(16);
      expect(weatherStormAt(sim.weather.data, size - 2.5, size - 2.5, size)).toBe(true);
      const cloud = {
        id: 0, x: 0, y: 0, radius: 0, maxRadius: 3, strength: 0, stage: 'forecast' as const,
        originX: 5, originY: 7, dx: 0, dy: 0, turns: 2, start: 0, grown: 10, breaking: 20, end: 30,
      };
      const sampled = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' as 'forecast' | 'forming' | 'mature' | 'breaking' };
      sampleStorm(cloud, 15, sampled, 0, size);
      expect(sampled).toMatchObject({ x: size - 5, y: size - 7, radius: 3, strength: 1, stage: 'mature' });
    });

    it(`spawns weighted map-authored Orbit pairs within clipped rectangles at ${size}`, () => {
      const document = structuredClone(make(size).mapDocument);
      const features = mapEntities(document);
      for (let i = features.length - 1; i >= 0; i--) if (features[i]!.__identifier === 'OrbitRegion') features.splice(i, 1);
      features.push(
        mapEntity('OrbitRegion', 'rare_lane', size / 4, 6, { width: 4, height: 4, dx: 1, dy: 0, weight: 0.01, spread: 0 }),
        mapEntity('OrbitRegion', 'main_lane', size / 2, 6, { width: 4, height: 4, dx: 0, dy: 1, weight: 100, spread: 0.25 }),
      );
      // The derelict pushes rocks drawn inside its hull out to its edge (derelict.test.ts); here only the regions draw.
      const sim = new Sim(123, { orbit: { asteroidEdge: 12, derelictEnabled: false } }, document);
      expect(sim.orbitRegions.length).toBe(4);
      const predictor = new Rng(0);
      predictor.state = sim.rng.state;
      const pick = predictor.range(0, sim.orbitRegions.reduce((sum, region) => sum + region.weight, 0));
      let cumulative = 0;
      const expected = sim.orbitRegions.find(region => (cumulative += region.weight) > pick)!;
      const edge = sim.econ.asteroidEdge;
      const bound = (v: number): number => Math.max(edge, Math.min(size - edge, v));
      const x = predictor.range(bound(expected.x - expected.width / 2), bound(expected.x + expected.width / 2));
      const y = predictor.range(bound(expected.y - expected.height / 2), bound(expected.y + expected.height / 2));
      const vx = (expected.dx * (1 - expected.spread) + predictor.range(-1, 1) * expected.spread) * sim.econ.asteroidDrift / TICK_RATE;
      const vy = (expected.dy * (1 - expected.spread) + predictor.range(-1, 1) * expected.spread) * sim.econ.asteroidDrift / TICK_RATE;
      sim.tick = sim.nextAsteroidSpawn() - 1;
      sim.step();
      const rocks = sim.ents.filter(entity => entity.kind === 'asteroid' && !entity.dead);
      expect(rocks.length).toBe(2);
      const [first, second] = rocks;
      expect(first!.x).toBe(clampPos(x, size));
      expect(first!.y).toBe(clampPos(y, size));
      expect(first!.vx).toBe(vx);
      expect(first!.vy).toBe(vy);
      expect(first!.x + second!.x).toBe(size);
      expect(first!.y + second!.y).toBe(size);
      expect(first!.vx).toBe(-second!.vx);
      expect(first!.vy).toBe(-second!.vy);
      for (const rock of rocks) {
        expect(rock.x).toBeGreaterThanOrEqual(edge);
        expect(rock.x).toBeLessThanOrEqual(size - edge);
        expect(rock.y).toBeGreaterThanOrEqual(edge);
        expect(rock.y).toBeLessThanOrEqual(size - edge);
      }
      const bootstrap = matchData(sim, 0);
      expect(bootstrap.orbitRegions).toEqual(sim.orbitRegions);
      expect(bootstrap.orbitRegions).not.toBe(sim.orbitRegions);
      expect(bootstrap.orbitRegions[0]).not.toBe(sim.orbitRegions[0]);
      expect(validate(matchDataSchema, bootstrap).ok).toBe(true);
      for (let i = features.length - 1; i >= 0; i--) if (features[i]!.__identifier === 'OrbitRegion') features.splice(i, 1);
      expect(() => new Sim(123, {}, document)).toThrow();
    });
  }

  it('takes authored document geometry and publishes its map seed, never the match seed', () => {
    const source = make(80, 17);
    const authored = { ...source.mapDocument, id: 'authored_test', spireInset: source.mapDocument.spireInset };
    const sim = new Sim(29, {}, authored);
    expect(sim.size).toBe(80);
    expect(sim.n).toBe(6400);
    expect(sim.rules.map.size).toBe(80);
    expect(sim.terrain).toEqual(source.terrain);
    expect(sim.cells).not.toBe(source.cells);
    const data = matchData(sim, 0);
    expect(data).toMatchObject({ mapId: 'authored_test', mapSeed: 17, mapHash: sim.mapHash });
    expect(JSON.stringify(data)).not.toContain('eventSeed');
    expect(validate(matchDataSchema, data).ok).toBe(true);
    // Four-slot maps build four-army sims and launch.
    const c4 = generateMapDocument(17, 'open', resolveRules({}).map, 4, 17);
    expect(new Sim(29, {}, c4).armies).toHaveLength(4);
    expect(checkRules({ map: { document: c4 } }).ok).toBe(true);
  });

  it('treats deep water as movement-blocking terrain without making it opaque', () => {
    const source = new Sim(123, { terrain: 'open', map: { params: { size: 64, faultSets: 0, homeLodes: 0, contestedZones: [] } } });
    const document = structuredClone(source.mapDocument);
    const terrain = mapLayerValues(document, 'Surface');
    const c = 20 * 64 + 40;
    terrain[c] = SURFACE.water;
    setMapLayerValues(document, 'Surface', terrain);
    const sim = new Sim(123, {}, document);
    expect(sim.terrain[c]).toBe(SURFACE.water);
    expect(sim.block[c]).toBe(1);
    expect(sim.los.visible(c - 1, c + 1)).toBe(true);
  });
});
