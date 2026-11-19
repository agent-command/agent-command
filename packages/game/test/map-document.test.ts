import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { CELL, DEFAULT_RULES, STATS, SURFACE, checkRules, matchDataSchema, resolveRules, viewSchema, type TerrainPreset } from '../src/rules/contract.ts';
import {
  INLINE_MAP_DOCUMENT_BYTES, MAX_MAP_DOCUMENT_BYTES, MAP_LAYER_NAMES, buildWorldFromDocument, canonicalDimensions,
  createMapDocument, documentFromWorld, entityData, exportLdtk, importLdtk, mapEntities, mapEntity, mapLayer,
  mapLayerValues, rotateCell, rotateOrbitRegion, rotatePoint, rotateVector, setMapLayerValues, validateMapDocument,
  type MapDocument, type MapMetadata,
} from '../src/maps/document.ts';
import { generateTerrain, generateWorld, type World } from '../src/maps/world.ts';
import { generateMapDocument, hashMapDocument, publicMapDocument } from '../src/maps/maps.ts';
import { createGame } from '../src/agent/adapter.ts';
import { view } from '../src/agent/present.ts';
import { Sim } from '../src/sim/sim.ts';

interface EditableLdtkField {
  __identifier: string;
  __type: string;
  __value: unknown;
  realEditorValues: unknown[];
}
interface EditableLdtkProject {
  defs: { layers: unknown[]; entities: unknown[] };
  levels: {
    fieldInstances: EditableLdtkField[];
    layerInstances: { __identifier: string; intGridCsv: number[];
      entityInstances: { __identifier: string; fieldInstances: EditableLdtkField[] }[] }[];
  }[];
}
function metadata(size = 48, sides: 2 | 4 = 2): MapMetadata {
  return { id: 'authored_test', label: 'Authored test', identity: 'Equal rotating sectors', seed: 123,
    size, sides, spireInset: 6, preset: 'open' };
}
function paint(document: MapDocument, name: (typeof MAP_LAYER_NAMES)[number], x: number, y: number, value: number): void {
  const values = mapLayerValues(document, name), { width } = canonicalDimensions(document.size, document.sides);
  values[y * width + x] = value;
  setMapLayerValues(document, name, values);
}
function addLode(document: MapDocument, x: number, y: number): void {
  const { width } = canonicalDimensions(document.size, document.sides), radius = (STATS.headframe.footprint.w - 1) / 2 + 1;
  const cells = mapLayerValues(document, 'Depths'), ore = mapLayerValues(document, 'Ore');
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const ring = Math.max(Math.abs(dx), Math.abs(dy)), c = (y + dy) * width + x + dx;
    cells[c] = ring === radius ? CELL.bedrock : ring === 0 ? CELL.rock : CELL.ore;
    ore[c] = ring > 0 && ring < radius ? 10 : 0;
  }
  setMapLayerValues(document, 'Depths', cells);
  setMapLayerValues(document, 'Ore', ore);
  mapEntities(document).push(mapEntity('Lode', 'lode', x + 0.5, y + 0.5, { rich: true, loads: 80 }));
}
function authored(size = 48, sides: 2 | 4 = 2): MapDocument {
  const document = createMapDocument(metadata(size, sides));
  addLode(document, 15, 10);
  paint(document, 'Depths', 10, 15, CELL.ore);
  paint(document, 'Ore', 10, 15, 23);
  paint(document, 'Magma', 18, 17, 1);
  paint(document, 'Magma', 19, 17, 1);
  paint(document, 'Depths', 11, 16, CELL.tunnel);
  paint(document, 'Cavern', 11, 16, 1);
  for (let x = 13; x <= 16; x++) paint(document, 'Surface', x, 18, SURFACE.fault);
  mapEntities(document).push(mapEntity('Fault', 'fault', 13.5, 18.5,
    { path: 'crack', order: 0, rotation: 0, cells: [[13, 18], [14, 18], [15, 18], [16, 18]] }));
  const a = Math.PI * 1.25, r = 8;
  mapEntities(document).push(mapEntity('Island', 'island', size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, { r, w: 0.00123456789 }));
  return document;
}
function comparable(world: World): object {
  const faults = world.faults.map(path => {
    const forward = path.join(','), reverse = [...path].reverse().join(',');
    return forward < reverse ? forward : reverse;
  }).sort();
  const islands = world.islands.map(island => ({ r: island.r, w: island.w, oreCapacity: island.oreCapacity,
    a0: Math.round((((island.a0 % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * 1e10) })).sort((a, b) => a.a0 - b.a0);
  return { size: world.size, preset: world.preset, terrain: [...world.terrain], cells: [...world.cells], ore: [...world.ore], owner: [...world.owner],
    magma: [...world.magma], cavern: [...world.cavern].sort((a, b) => a - b), faults, islands,
    orbitRegions: [...world.orbitRegions].sort((a, b) => a.y - b.y || a.x - b.x || a.width - b.width),
    lodes: [...world.lodes].sort((a, b) => a.c - b.c), generation: world.generation };
}

describe('canonical-sector map documents', () => {
  for (const sides of [2, 4] as const) {
    it(`preserves authored finite deposits through C${sides} rotation, JSON, LDtk and canonical world roundtrips`, () => {
      for (const oreCapacity of [1, 240, 100000]) {
        const document = authored(48, sides);
        const island = mapEntities(document).find(entity => entity.__identifier === 'Island')!;
        island.fieldInstances.push({ __identifier: 'oreCapacity', __type: 'Int', __value: oreCapacity });
        expect(validateMapDocument(document).errors).toEqual([]);
        expect(checkRules({ map: { document } }).ok).toBe(true);
        const world = buildWorldFromDocument(document);
        expect(world.islands.map(orbit => orbit.oreCapacity)).toEqual(Array(sides).fill(oreCapacity));
        const origin = { x: island.px[0], y: island.px[1] };
        world.islands.forEach((orbit, slot) => {
          const point = rotatePoint(origin, 48, slot * 4 / sides);
          expect(24 + orbit.r * Math.cos(orbit.a0)).toBeCloseTo(point.x, 12);
          expect(24 + orbit.r * Math.sin(orbit.a0)).toBeCloseTo(point.y, 12);
        });
        const json = JSON.parse(JSON.stringify(document)) as MapDocument;
        const ldtk = importLdtk(exportLdtk(json));
        expect(ldtk).toEqual(document);
        expect(hashMapDocument(ldtk)).toBe(hashMapDocument(document));
        expect(comparable(buildWorldFromDocument(documentFromWorld(world, metadata(48, sides))))).toEqual(comparable(world));
        const plain = authored(48, sides);
        expect(hashMapDocument(document)).not.toBe(hashMapDocument(plain));
        expect(hashMapDocument(publicMapDocument(document))).not.toBe(hashMapDocument(publicMapDocument(plain)));
        expect(mapEntities(publicMapDocument(document)).find(entity => entity.__identifier === 'Island')).toEqual(island);
        world.islands[1]!.oreCapacity++;
        expect(() => documentFromWorld(world, metadata(48, sides))).toThrow(/Asymmetric island orbit/);
      }
    });

    it(`boots authored C${sides} deposits without filling cargo or publishing dynamic ore in orbit metadata`, () => {
      const document = authored(48, sides);
      mapEntities(document).find(entity => entity.__identifier === 'Island')!.fieldInstances.push(
        { __identifier: 'oreCapacity', __type: 'Int', __value: 100000 });
      const game = createGame({ seed: 29, options: { map: { document } } });
      const sim = game.sim, hash = hashMapDocument(document);
      const islands = sim.ents.filter(entity => entity.kind === 'island');
      expect(islands).toHaveLength(sides);
      for (const island of islands) {
        expect(island.oreCapacity).toBe(100000);
        expect(island.oreRemaining).toBe(100000);
        expect(island.oreBuffer).toBe(0);
        island.oreRemaining = 99960;
        island.oreBuffer = 40;
      }
      const bootstrap = game.matchData({ team: 'nw', role: 'sky' }), snapshot = game.view('nw');
      expect(bootstrap.mapHash).toBe(hash);
      const bootstrapResult = validate(matchDataSchema, bootstrap);
      const snapshotResult = validate(viewSchema, snapshot);
      expect(bootstrapResult.ok ? true : bootstrapResult).toBe(true);
      expect(snapshotResult.ok ? true : snapshotResult).toBe(true);
      expect(snapshot.islands).toHaveLength(sides);
      for (const orbit of snapshot.islands) {
        expect(orbit.oreCapacity).toBe(100000);
        expect(orbit).not.toHaveProperty('oreRemaining');
        expect(orbit).not.toHaveProperty('oreBuffer');
      }
      expect(hashMapDocument(sim.mapDocument)).toBe(hash);
      expect(buildWorldFromDocument(sim.mapDocument).islands.every(orbit => orbit.oreCapacity === 100000)).toBe(true);
    });
  }

  it('defaults omitted authored deposits to ordinary islands, not generator deposits', () => {
    const document = authored();
    const sim = new Sim(29, { map: { params: { islandOreRings: 8, islandOreAmount: 777 } } }, document);
    expect(buildWorldFromDocument(document).islands.every(island => island.oreCapacity === 0)).toBe(true);
    expect(sim.ents.filter(entity => entity.kind === 'island').every(island =>
      island.oreCapacity === 0 && island.oreRemaining === 0 && island.oreBuffer === 0)).toBe(true);
    expect(view(sim, 'nw').islands.every(island => !Object.hasOwn(island, 'oreCapacity'))).toBe(true);
  });

  it('hashes generated deposits publicly without exposing or depending on the hidden generation seed', () => {
    const rules = resolveRules({});
    const first = generateMapDocument(42, 'open', rules.map, 4, 7);
    const second = generateMapDocument(42, 'open', rules.map, 4, 99);
    const tuned = generateMapDocument(42, 'open', { ...rules.map, islandOreAmount: 241 }, 4, 7);
    expect(publicMapDocument(first)).toEqual(publicMapDocument(second));
    expect(hashMapDocument(publicMapDocument(first))).toBe(hashMapDocument(publicMapDocument(second)));
    expect(hashMapDocument(publicMapDocument(first))).not.toBe(hashMapDocument(publicMapDocument(tuned)));
  });

  for (const size of [48, 64, 80]) for (const sides of [2, 4] as const) {
    it(`builds and roundtrips all layers and features at ${size}, C${sides}`, () => {
      const document = authored(size, sides), raw: unknown = JSON.parse(JSON.stringify(document));
      const validation = validateMapDocument(raw);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
      expect(validation.fairness!.slots).toHaveLength(sides);
      expect(validation.fairness!.layouts.every(layout => layout.equalRotatedSlots)).toBe(true);
      const world = buildWorldFromDocument(raw as MapDocument);
      expect(world.size).toBe(size);
      expect(world.terrain).toHaveLength(size * size);
      expect(world.lodes).toHaveLength(sides);
      expect(world.islands).toHaveLength(sides);
      const rebuilt = documentFromWorld(world, metadata(size, sides));
      expect(comparable(buildWorldFromDocument(rebuilt))).toEqual(comparable(world));
      expect(importLdtk(JSON.stringify(exportLdtk(document)))).toEqual(document);
      expect(comparable(buildWorldFromDocument(importLdtk(exportLdtk(document))))).toEqual(comparable(world));
      for (const name of MAP_LAYER_NAMES) {
        const layer = mapLayer(document, name), { width, height } = canonicalDimensions(size, sides);
        expect(layer.__cWid).toBe(width);
        expect(layer.__cHei).toBe(height);
        expect(mapLayerValues(document, name)).toHaveLength(width * height);
        expect('intGridCsv' in layer).toBe(false);
      }
    });
  }

  it('uses the different cell and point quarter-turn formulae', () => {
    expect(rotateCell(3 * 48 + 7, 48)).toBe(7 * 48 + 44);
    expect(rotatePoint({ x: 7, y: 3 }, 48)).toEqual({ x: 45, y: 7 });
    expect(rotateCell(123, 64, 4)).toBe(123);
    expect(rotateCell(rotateCell(123, 80), 80, -1)).toBe(123);
  });

  it('rotates C4 owners, knowledge, resources, faults and islands exactly', () => {
    const document = authored(64, 4), world = buildWorldFromDocument(document);
    const root = 6 * 64 + 6, cavern = 16 * 64 + 11;
    for (let r = 0; r < 4; r++) {
      expect(world.owner[rotateCell(root, 64, r)]).toBe(r + 1);
      expect(world.lodes[r]!.c).toBe(rotateCell(10 * 64 + 15, 64, r));
      expect(world.ore[rotateCell(15 * 64 + 10, 64, r)]).toBe(23);
      expect(world.magma[rotateCell(17 * 64 + 18, 64, r)]).toBe(r + 1);
      expect(world.faults[r]!.length).toBe(4);
      expect(world.cavern.includes(rotateCell(cavern, 64, r))).toBe(r === 0);
    }
    const fairness = validateMapDocument(document).fairness!;
    expect(fairness.slots[0]!.surfaceDistances[1]).toBe(fairness.slots[0]!.surfaceDistances[3]);
    expect(fairness.slots[0]!.surfaceDistances[2]).toBeGreaterThan(fairness.slots[0]!.surfaceDistances[1]!);
    expect(fairness.resources).toHaveLength(4);
    for (const slot of fairness.slots) {
      expect(slot.sectorOre).toBe(103);
      expect(slot.accessibleLodeLoads).toBe(320);
      expect(slot.chokeClearance).toBeGreaterThan(0);
      expect(slot.exposure.entrances).toBeGreaterThan(0);
    }
    expect(document.layouts.map(l => [l.id, l.supported])).toEqual([['ffa', true], ['duel', true], ['adjacent', false], ['opposite', false]]);
  });

  it('preserves blue-known cavern cells in the noncanonical half', () => {
    const document = createMapDocument(metadata()), c = 16 * 48 + 11, opposite = rotateCell(c, 48, 2);
    paint(document, 'Depths', 11, 16, CELL.tunnel);
    const world = buildWorldFromDocument(document);
    world.cavern = [c, opposite];
    const rebuilt = buildWorldFromDocument(documentFromWorld(world, metadata()));
    expect([...rebuilt.cavern].sort((a, b) => a - b)).toEqual([c, opposite].sort((a, b) => a - b));
  });

  it('does not alias mutable simulation buffers or feature/accounting arrays', () => {
    const document = authored(), before = JSON.stringify(document);
    const a = buildWorldFromDocument(document), b = buildWorldFromDocument(document);
    a.ore.fill(0); a.cells.fill(CELL.magma); a.owner.fill(0); a.terrain.fill(SURFACE.cliff); a.magma.fill(0);
    a.cavern.length = 0; a.faults[0]!.length = 0; a.islands[0]!.r = 1; a.lodes[0]!.loads = 1;
    a.orbitRegions[0]!.weight = 99;
    a.generation.terrainEdits.push({ c: 0, before: 0, after: 1 });
    expect(JSON.stringify(document)).toBe(before);
    expect(comparable(b)).toEqual(comparable(buildWorldFromDocument(document)));
  });

  it('deduplicates a self-rotating central fault after source-world extraction', () => {
    const document = createMapDocument(metadata()), size = document.size;
    // One full anti-diagonal central crack; rotation reverses the same polyline.
    const path = Array.from({ length: 8 }, (_, k) => (20 + k) * size + (27 - k));
    const world = buildWorldFromDocument(document);
    world.faults = [path];
    for (const c of path) world.terrain[c] = SURFACE.fault;
    const rebuilt = buildWorldFromDocument(documentFromWorld(world, metadata()));
    expect(rebuilt.faults).toHaveLength(1);
    expect(comparable(rebuilt)).toEqual(comparable(world));
  });

  for (const sides of [2, 4] as const) {
    it(`roundtrips generated centralFault=1 without duplicate cracks (${sides} slots)`, () => {
      const preset: TerrainPreset = 'open', map = { ...DEFAULT_RULES.map, size: 48, faultSets: 1, centralFault: 1 };
      const world = generateWorld(71, generateTerrain(71, preset, map, sides), map, sides, 71);
      // The central set: one self-mirrored line on two slots, a centre cross of two lines on four.
      expect(world.faults).toHaveLength(sides === 2 ? 1 : 2);
      const document = documentFromWorld(world, { ...metadata(48, sides), seed: 71, spireInset: map.spireInset, preset });
      const rebuilt = buildWorldFromDocument(document);
      expect(rebuilt.faults).toHaveLength(world.faults.length);
      expect([...rebuilt.terrain]).toEqual([...world.terrain]);
      expect([...rebuilt.cells]).toEqual([...world.cells]);
      expect([...rebuilt.ore]).toEqual([...world.ore]);
    });
  }

  it('exports actual editable LDtk definitions and retains typed edited values', () => {
    // This fixture is produced by our exporter, not untrusted editor input.
    const document = authored(), project = exportLdtk(document) as unknown as EditableLdtkProject;
    expect(project.defs.layers).toHaveLength(7);
    // StartSlot, Fault, Lode, Island, OrbitRegion, MotherLode, Post, RichOre.
    expect(project.defs.entities).toHaveLength(8);
    expect(project.levels[0]!.fieldInstances.every(f => f.__identifier !== 'MapMetadata')).toBe(true);
    const surface = project.levels[0]!.layerInstances.find(l => l.__identifier === 'Surface')!;
    expect(surface.intGridCsv[0]).toBe(SURFACE.ground + 1);
    surface.intGridCsv[12 * 48 + 20] = SURFACE.forest + 1;
    const edited = importLdtk(project);
    expect(mapLayerValues(edited, 'Surface')[12 * 48 + 20]).toBe(SURFACE.forest);
    const lode = project.levels[0]!.layerInstances.find(l => l.__identifier === 'Features')!.entityInstances.find(e => e.__identifier === 'Lode')!;
    const rich = lode.fieldInstances.find(f => f.__identifier === 'rich')!;
    expect(rich.realEditorValues).toEqual([{ id: 'V_Bool', params: [true] }]);
    rich.__value = false;
    expect(entityData<{ rich: boolean }>(mapEntities(importLdtk(project)).find(e => e.__identifier === 'Lode')!).rich).toBe(false);
  });
  it('preserves native Float precision after LDtk rounds its convenient exported values', () => {
    // Model the documented LDtk export rounding while retaining its native V_Float editor values.
    const document = authored(), project = exportLdtk(document) as unknown as EditableLdtkProject;
    const fields = [...project.levels[0]!.fieldInstances,
      ...project.levels[0]!.layerInstances.flatMap(layer => layer.entityInstances.flatMap(entity => entity.fieldInstances))];
    for (const field of fields) if (field.__type === 'Float' && typeof field.__value === 'number') field.__value = Math.round(field.__value * 1000) / 1000;
    expect(importLdtk(project)).toEqual(document);
  });

  it('measures a short central pass and a longer still-connected flank using geometric diagonal travel', () => {
    const document = createMapDocument(metadata());
    for (let x = 8; x < 40; x++) if (x < 22 || x > 25) paint(document, 'Surface', x, 23, SURFACE.cliff);
    const open = validateMapDocument(document);
    expect(open.errors).toEqual([]);
    const shortDistance = open.fairness!.slots[0]!.surfaceDistances[1]!;
    expect(shortDistance).toBeLessThan(open.fairness!.slots[0]!.depthsDistances[1]!);
    for (let x = 22; x <= 25; x++) paint(document, 'Surface', x, 23, SURFACE.cliff);
    const blocked = validateMapDocument(document);
    expect(blocked.errors).toEqual([]);
    expect(blocked.fairness!.slots[0]!.surfaceDistances[1]).toBeGreaterThan(shortDistance);
  });
  it('expands authored Orbit placement regions and approach vectors under C4 without new collision semantics', () => {
    const document = createMapDocument(metadata(64, 4)), features = mapEntities(document);
    const index = features.findIndex(feature => feature.__identifier === 'OrbitRegion');
    features[index] = mapEntity('OrbitRegion', 'approach', 10.25, 14.75,
      { width: 8, height: 6, dx: 0.25, dy: -0.5, weight: 100, spread: 0.375 });
    const world = buildWorldFromDocument(document), canonical = world.orbitRegions[0]!;
    expect(world.orbitRegions).toHaveLength(4);
    for (let r = 0; r < 4; r++) expect(world.orbitRegions[r]).toEqual(rotateOrbitRegion(canonical, 64, r));
    expect(world.orbitRegions[1]).toEqual({ x: 49.25, y: 10.25, width: 6, height: 8, dx: 0.5, dy: 0.25, weight: 100, spread: 0.375 });
    expect(rotateVector({ x: 0.25, y: -0.5 }, 1)).toEqual({ x: 0.5, y: 0.25 });
    expect(rotateVector({ x: 0.25, y: -0.5 }, 4)).toEqual({ x: 0.25, y: -0.5 });
    expect(importLdtk(exportLdtk(document))).toEqual(document);
    expect(comparable(buildWorldFromDocument(documentFromWorld(world, metadata(64, 4))))).toEqual(comparable(world));
    world.orbitRegions[1]!.spread = 0.5;
    expect(() => documentFromWorld(world, metadata(64, 4))).toThrow(/Asymmetric OrbitRegion/);
  });
});

describe('map document rejection', () => {
  const reject = (document: unknown, pattern: RegExp): void => {
    const result = validateMapDocument(document);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toMatch(pattern);
  };
  it('rejects out-of-range or noninteger island deposits and authored runtime resource fields', () => {
    for (const oreCapacity of [-1, 0.5, 100001, NaN, Infinity]) {
      const document = authored();
      mapEntities(document).find(entity => entity.__identifier === 'Island')!.fieldInstances.push(
        { __identifier: 'oreCapacity', __type: 'Int', __value: oreCapacity });
      reject(document, /field/);
      expect(checkRules({ map: { document } }).ok).toBe(false);
    }
    for (const name of ['oreRemaining', 'oreBuffer']) {
      const document = authored();
      const island = mapEntities(document).find(entity => entity.__identifier === 'Island')!;
      Object.assign(island, { fieldInstances: [...island.fieldInstances, { __identifier: name, __type: 'Int', __value: 40 }] });
      reject(document, /field/);
    }
  });
  it('rejects versions, dimensions, symmetry and invalid metadata without coercion', () => {
    reject(null, /object/);
    reject({ ...createMapDocument(metadata()), version: 2 }, /version/);
    reject({ ...createMapDocument(metadata()), size: 56 }, /Size/);
    reject({ ...createMapDocument(metadata()), seed: -1 }, /Seed/);
    reject({ ...createMapDocument(metadata()), spireInset: 2 }, /inset/);
    reject({ ...createMapDocument(metadata()), symmetry: 'C4' }, /Symmetry/);
    reject({ ...createMapDocument(metadata()), preset: 'not_a_preset' }, /preset/);
    reject({ ...createMapDocument(metadata()), id: 'x'.repeat(97) }, /id/);
    reject({ ...createMapDocument(metadata()), cells: new Uint8Array(48 * 48) }, /Unknown map document field/);
  });
  it('rejects flat full-map layers, bad RLE counts and invalid native codes', () => {
    const full = createMapDocument(metadata());
    mapLayer(full, 'Surface').__cHei = 48;
    reject(full, /dimensions/);
    const count = createMapDocument(metadata());
    mapLayer(count, 'Ore').intGridRle = [48 * 24 - 1, 0];
    reject(count, /cell count/);
    const adjacent = createMapDocument(metadata());
    mapLayer(adjacent, 'Ore').intGridRle = [10, 0, 48 * 24 - 10, 0];
    reject(adjacent, /adjacent equal/);
    for (const [name, value] of [['Surface', 7], ['Depths', CELL.unknown], ['Owner', 3], ['Ore', 256], ['Magma', 255], ['Cavern', 4]] as const) {
      const document = createMapDocument(metadata());
      paint(document, name, 10, 10, value);
      reject(document, /code\/range/);
    }
    const duplicate = createMapDocument(metadata());
    duplicate.levels[0].layerInstances.push(mapLayer(duplicate, 'Ore'));
    reject(duplicate, /duplicate layer/);
  });
  it('rejects authored entities or fault vertices outside the canonical sector', () => {
    const document = createMapDocument(metadata(48, 4));
    mapEntities(document).push(mapEntity('Lode', 'outside', 30.5, 10.5, { rich: false, loads: 80 }));
    reject(document, /outside canonical/);
    const fault = createMapDocument(metadata(48, 4));
    mapEntities(fault).push(mapEntity('Fault', 'fault', 10.5, 10.5, { path: 'fault', order: 0, rotation: 0, cells: [[10, 10], [30, 10]] }));
    reject(fault, /canonical fault/);
  });
  it('rejects opaque/untyped features, illegal starts, feature footprints and resource bounds', () => {
    const untyped = createMapDocument(metadata());
    Object.assign(mapEntities(untyped)[0]!, { fieldInstances: [{ __identifier: 'Data', __type: 'String', __value: '{"slot":0}' }] });
    reject(untyped, /field/);
    const blocked = createMapDocument(metadata());
    paint(blocked, 'Surface', 6, 6, SURFACE.cliff);
    reject(blocked, /start|Start/);
    const lode = createMapDocument(metadata());
    mapEntities(lode).push(mapEntity('Lode', 'illegal', 15.5, 10.5, { rich: false, loads: 80 }));
    reject(lode, /lode footprint|contains/);
    const bounds = createMapDocument(metadata());
    mapEntities(bounds).push(mapEntity('Lode', 'illegal', 15.5, 10.5, { rich: false, loads: 2041 }));
    reject(bounds, /resource bounds/);
    const ore = createMapDocument(metadata());
    paint(ore, 'Ore', 10, 10, 50);
    reject(ore, /non-ore/);
    const knowledge = createMapDocument(metadata());
    paint(knowledge, 'Cavern', 10, 10, 1);
    reject(knowledge, /Cavern knowledge/);
    const magma = authored();
    paint(magma, 'Magma', 18, 20, 1);
    reject(magma, /Disconnected magma pocket/);
  });
  it('rejects missing, untyped, out-of-bounds and oversubscribed Orbit placement regions', () => {
    const missing = createMapDocument(metadata());
    const missingFeatures = mapEntities(missing);
    missingFeatures.splice(missingFeatures.findIndex(feature => feature.__identifier === 'OrbitRegion'), 1);
    reject(missing, /OrbitRegions are required/);
    for (const override of [{ width: 0 }, { height: 49 }, { dx: 1.01 }, { dy: -1.01 }, { weight: 0.001 }, { weight: 101 }, { spread: -0.1 }, { spread: 1.01 }]) {
      const document = createMapDocument(metadata()), features = mapEntities(document);
      features[features.findIndex(feature => feature.__identifier === 'OrbitRegion')] = mapEntity('OrbitRegion', 'bad_region', 12, 12,
        { width: 12, height: 12, dx: 0.5, dy: 0.5, weight: 1, spread: 0.25, ...override });
      reject(document, /OrbitRegion field bounds/);
    }
    const outside = createMapDocument(metadata());
    mapEntities(outside).push(mapEntity('OrbitRegion', 'outside_region', 2, 2,
      { width: 8, height: 6, dx: 0.5, dy: 0.5, weight: 1, spread: 0.25 }));
    reject(outside, /rectangle leaves map/);
    const crowded = createMapDocument(metadata(48, 4));
    for (let i = 0; i < 16; i++) mapEntities(crowded).push(mapEntity('OrbitRegion', `region_${i}`, 10 + i / 4, 12,
      { width: 1, height: 1, dx: 0.5, dy: 0.5, weight: 1, spread: 0.25 }));
    reject(crowded, /64 expanded/);
    const duplicate = createMapDocument(metadata());
    mapEntities(duplicate).push(mapEntity('OrbitRegion', 'duplicate_region', 12, 12,
      { width: 12, height: 12, dx: Math.SQRT1_2, dy: Math.SQRT1_2, weight: 1, spread: 0.25 }));
    reject(duplicate, /Duplicate OrbitRegion/);
  });
  it('requires all walkable surface and diggable depths to be connected, including water barriers', () => {
    for (const blocker of [SURFACE.cliff, SURFACE.water]) {
      const document = createMapDocument(metadata());
      for (const [x, y] of [[19, 20], [21, 20], [20, 19], [20, 21]]) paint(document, 'Surface', x!, y!, blocker);
      reject(document, /disconnected walkable/);
    }
    const document = createMapDocument(metadata());
    for (const [x, y] of [[19, 20], [21, 20], [20, 19], [20, 21]]) paint(document, 'Depths', x!, y!, CELL.bedrock);
    reject(document, /unreachable through diggable/);
  });
  it('rejects source asymmetry across complete layers and features instead of silently canonicalizing it', () => {
    const document = authored(), world = buildWorldFromDocument(document);
    world.ore[rotateCell(15 * 48 + 10, 48, 2)] = 24;
    expect(() => documentFromWorld(world, metadata())).toThrow(/symmetry/);
    const lodes = buildWorldFromDocument(document); lodes.lodes.pop();
    expect(() => documentFromWorld(lodes, metadata())).toThrow(/lode/);
    const islands = buildWorldFromDocument(document); islands.islands[1]!.w *= -1;
    expect(() => documentFromWorld(islands, metadata())).toThrow(/island/);
    const faults = buildWorldFromDocument(document); faults.faults.pop();
    expect(() => documentFromWorld(faults, metadata())).toThrow(/fault/);
    const pockets = buildWorldFromDocument(document);
    pockets.magma[rotateCell(17 * 48 + 19, 48, 2)] = 4;
    expect(() => documentFromWorld(pockets, metadata())).toThrow(/magma pocket topology/);
  });
  it('requires layouts to cover every start and keeps four-side alliance layouts unsupported', () => {
    const duplicate = createMapDocument(metadata(48, 4)); duplicate.layouts[0]!.teams = [[0], [0], [2], [3]];
    reject(duplicate, /each slot/);
    const supported = createMapDocument(metadata(48, 4)); supported.layouts[2]!.supported = true;
    reject(supported, /unsupported/);
  });
  it('distinguishes the inline and saved document byte caps and rejects oversized files', () => {
    expect(INLINE_MAP_DOCUMENT_BYTES).toBe(128 * 1024);
    expect(MAX_MAP_DOCUMENT_BYTES).toBe(1024 * 1024);
    reject({ ...createMapDocument(metadata()), label: 'x'.repeat(MAX_MAP_DOCUMENT_BYTES) }, /UTF-8 bytes/);
  });
  it('rejects malformed or empty LDtk layers and unsupported editor versions', () => {
    // Deliberately corrupt a known exporter fixture at the import boundary.
    const document = authored(), project = exportLdtk(document) as unknown as EditableLdtkProject;
    project.levels[0]!.layerInstances[0]!.intGridCsv[0] = 0;
    expect(() => importLdtk(project)).toThrow(/empty\/invalid/);
    expect(() => importLdtk({ ...exportLdtk(document), jsonVersion: '0.9.0' })).toThrow(/1\.5\.3/);
    expect(() => buildWorldFromDocument({ ...document, version: 99 } as unknown as MapDocument)).toThrow(/version/);
  });
});
