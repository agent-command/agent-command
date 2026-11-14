import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, SURFACE, isSurfaceBlocked, isSurfaceCode, isSurfaceHigh, isSurfaceWet, packTerrain, surfaceFeature, surfaceSiteLevel, unpackTerrain, withSurfaceElevation, withSurfaceFeature } from '../src/rules/contract.ts';
import { generateTerrain, generateWorld } from '../src/maps/world.ts';
import { buildWorldFromDocument, createMapDocument, documentFromWorld, exportLdtk, importLdtk, mapEntities, mapEntity, mapLayerValues, setMapLayerValues, validateMapDocument } from '../src/maps/document.ts';
import { hashMapDocument, publicMapDocument } from '../src/maps/maps.ts';
import { createGame } from '../src/agent/adapter.ts';
import { matchData } from '../src/agent/present.ts';
import { Sim } from '../src/sim/sim.ts';

const metadata = { id: 'elevated_features', label: 'Elevated features', identity: 'Explicit feature elevations', seed: 71, size: 48, sides: 2 as const, spireInset: 6, preset: 'open' as const };
/** Canonical C2 placements; every feature has a low and high counterpart. Wet pairs are separate level bodies. */
function authoredFeatures() {
  const document = createMapDocument(metadata), cells = mapLayerValues(document, 'Surface');
  for (const [x, code] of [[12, SURFACE.forest], [16, SURFACE.highForest], [20, SURFACE.fault], [24, SURFACE.highFault]] as const) cells[14 * 48 + x] = code;
  for (const [x, code] of [[12, SURFACE.ford], [13, SURFACE.water], [20, SURFACE.highFord], [21, SURFACE.highWater]] as const) cells[18 * 48 + x] = code;
  for (const x of [20, 24]) mapEntities(document).push(mapEntity('Fault', `fault-${x}`, x + 0.5, 14.5, { path: `fault-${x}`, order: 0, rotation: 0, cells: [[x, 14]] }));
  setMapLayerValues(document, 'Surface', cells);
  return document;
}

function expectLevelWater(terrain: Uint8Array, size: number): void {
  for (let c = 0; c < terrain.length; c++) {
    if (!isSurfaceWet(terrain[c]!)) continue;
    for (const n of [c % size < size - 1 ? c + 1 : -1, c + size]) {
      if (n >= 0 && n < terrain.length && isSurfaceWet(terrain[n]!)) expect(isSurfaceHigh(terrain[n]!)).toBe(isSurfaceHigh(terrain[c]!));
    }
  }
}

describe('explicit surface feature elevation', () => {
  it('keeps canonical features and elevation independent, including across packed word boundaries', () => {
    const codes = Object.values(SURFACE);
    for (const feature of [SURFACE.ground, SURFACE.forest, SURFACE.ford, SURFACE.fault, SURFACE.water]) {
      for (const high of [false, true]) {
        const code = withSurfaceElevation(feature, high);
        expect(isSurfaceCode(code)).toBe(true);
        expect(surfaceFeature(code)).toBe(feature);
        expect(isSurfaceHigh(code)).toBe(high);
        expect(withSurfaceFeature(code, SURFACE.forest)).toBe(high ? SURFACE.highForest : SURFACE.forest);
        expect(withSurfaceElevation(code, !high)).toBe(withSurfaceElevation(feature, !high));
        expect(isSurfaceBlocked(code)).toBe(feature === SURFACE.water);
      }
    }
    expect(withSurfaceElevation(SURFACE.cliff, true)).toBe(SURFACE.cliff);
    for (const invalid of [-1, 7, 8, 9, 11, 15, 16, 2.5]) expect(isSurfaceCode(invalid)).toBe(false);
    const cells = Uint8Array.from({ length: 48 * 48 }, (_, c) => codes[c % codes.length]!);
    const packed = packTerrain(cells);
    expect(packed).toHaveLength(Math.ceil(cells.length / 7));
    expect(packed.every(word => word >= 0 && word < 2 ** 28)).toBe(true);
    expect(unpackTerrain(packed, 48)).toEqual(cells);
  });

  it('stamps generated faults through a plateau without flattening the underlying public base', () => {
    const map = { ...DEFAULT_RULES.map, faultSets: 1, centralFault: 1 };
    const base = generateTerrain(71, 'open', map, 2);
    // A public central plateau ensures the generated central fault crosses both elevations.
    for (let y = 18; y < 30; y++) for (let x = 18; x < 30; x++) base.terrain[y * map.size + x] = SURFACE.high;
    const before = base.terrain.slice();
    const a = generateWorld(71, { ...base, terrain: before.slice() }, map, 2, 100);
    const b = generateWorld(71, { ...base, terrain: before.slice() }, map, 2, 200);
    expect(a.faults.flat().some(c => isSurfaceHigh(before[c]!))).toBe(true);
    for (const c of a.faults.flat()) {
      expect(surfaceFeature(a.terrain[c]!)).toBe(SURFACE.fault);
      expect(isSurfaceHigh(a.terrain[c]!)).toBe(isSurfaceHigh(before[c]!));
    }
    expect(a.terrain).toEqual(b.terrain);
    expect(a.faults).toEqual(b.faults);
    expect(hashMapDocument(publicMapDocument(documentFromWorld(a, { ...metadata, spireInset: map.spireInset }))))
      .toBe(hashMapDocument(publicMapDocument(documentFromWorld(b, { ...metadata, spireInset: map.spireInset }))));
  });

  it('retains forest cover when raising hills and terminates streams at a change of base elevation', () => {
    const map = { ...DEFAULT_RULES.map, featureMargin: 23,
      open: { ...DEFAULT_RULES.map.open, forests: 1, forestRadius: 4, forestSpan: 0, hills: 1, hillRadius: 8, hillSpan: 0, hillMargin: 23 } };
    const generated = generateTerrain(17, 'open', map, 2);
    expect(generated.terrain.includes(SURFACE.highForest)).toBe(true);
    expect(generated.terrain.includes(SURFACE.highFord)).toBe(true);
    expectLevelWater(generated.terrain, map.size);
    for (const preset of ['open', 'canyons', 'archipelago', 'rivers'] as const) {
      const world = generateWorld(17, generateTerrain(17, preset, DEFAULT_RULES.map, 2), DEFAULT_RULES.map, 2, 999);
      expectLevelWater(world.terrain, world.size);
    }
  });

  it('roundtrips elevated authored features through JSON, LDtk, public identity and match data', () => {
    const document = authoredFeatures();
    expect(validateMapDocument(document).errors).toEqual([]);
    const world = buildWorldFromDocument(JSON.parse(JSON.stringify(document)));
    const rebuilt = documentFromWorld(world, metadata);
    expect(buildWorldFromDocument(rebuilt).terrain).toEqual(world.terrain);
    expect(buildWorldFromDocument(importLdtk(exportLdtk(document))).terrain).toEqual(world.terrain);
    expect(mapLayerValues(publicMapDocument(document), 'Surface')).toEqual(mapLayerValues(document, 'Surface'));
    const lowered = structuredClone(document), cells = mapLayerValues(lowered, 'Surface');
    cells[14 * 48 + 16] = SURFACE.forest;
    setMapLayerValues(lowered, 'Surface', cells);
    expect(hashMapDocument(publicMapDocument(lowered))).not.toBe(hashMapDocument(publicMapDocument(document)));
    const sim = new Sim(71, {}, document);
    expect(unpackTerrain(matchData(sim, 0).terrain, sim.size)).toEqual(world.terrain);
    const copy = buildWorldFromDocument(document);
    copy.terrain.fill(SURFACE.ground);
    expect(buildWorldFromDocument(document).terrain).toEqual(world.terrain);
  });

  it('preserves elevated authored terrain through checkpoints and deterministic intent replay', () => {
    const document = authoredFeatures();
    const start = () => {
      const game = createGame({ seed: 71, options: { map: { document } } });
      const unit = game.sim.add('trooper', 0, 'surface', 16.5, 14.5);
      unit.stance = 'hold';
      return { game, id: game.entityId('nw', unit.id) };
    };
    const original = start(), replay = start(), copy = original.game.clone();
    const intent = { kind: 'move' as const, units: [original.id], x: 18.5, y: 14.5, mode: 'move' as const };
    for (const game of [original.game, replay.game, copy]) expect(game.apply({ team: 'nw', role: 'surface' }, intent).ok).toBe(true);
    for (let tick = 0; tick < 40; tick++) {
      original.game.step(); replay.game.step(); copy.step();
      expect(copy.stateHash()).toBe(original.game.stateHash());
      expect(replay.game.stateHash()).toBe(original.game.stateHash());
    }
    expect(copy.sim.terrain).toEqual(original.game.sim.terrain);
    expect(copy.sim.terrain).not.toBe(original.game.sim.terrain);
    expect(matchData(replay.game.sim, 0).terrain).toEqual(matchData(original.game.sim, 0).terrain);
  });

  it('rejects reserved codes and mixed-level connected water bodies, while isolated low/high bodies are valid', () => {
    for (const code of [7, 8, 9, 11, 15]) {
      const document = authoredFeatures(), cells = mapLayerValues(document, 'Surface');
      cells[12 * 48 + 18] = code;
      setMapLayerValues(document, 'Surface', cells);
      expect(validateMapDocument(document).errors.some(error => error.includes('run/code/range'))).toBe(true);
    }
    const document = authoredFeatures(), cells = mapLayerValues(document, 'Surface');
    cells[18 * 48 + 20] = SURFACE.ford;
    setMapLayerValues(document, 'Surface', cells);
    expect(validateMapDocument(document).errors.some(error => error.includes('Water body changes elevation'))).toBe(true);
  });

  it('combines forest cover and speed with high-ground rules, while blocking high water and feature construction', () => {
    const sim = new Sim(71, {}, authoredFeatures()), forest = 14 * 48 + 16;
    const unit = sim.add('trooper', 0, 'surface', 16.5, 14.5);
    expect(sim.onHigh(unit)).toBe(true);
    expect(sim.speedOf(unit)).toBeCloseTo(sim.baseSpeed(unit) * sim.econ.forestSpeed);
    expect(sim.surfaceCost[forest]).toBeCloseTo(1 / sim.econ.forestSpeed);
    expect(sim.surfaceCost[18 * 48 + 20]).toBeCloseTo(1 / sim.econ.fordSpeed);
    expect(sim.block[18 * 48 + 21]).toBe(1);
    expect(sim.block[18 * 48 + 20]).toBe(0);
    const bit = sim.armies[1]!.group.bit;
    sim.vis[1]![forest] = bit;
    sim.spot[forest] = 0;
    expect(sim.seesCell(1, 'surface', forest)).toBe(false);
    sim.spot[forest] = bit;
    expect(sim.seesCell(1, 'surface', forest)).toBe(true);
    const stamped = new Uint8Array(sim.n);
    sim.los.stamp(stamped, sim.terrain, forest - 1, forest, forest, bit);
    expect(stamped[forest]).toBe(0);
    for (const feature of [SURFACE.highForest, SURFACE.highFord, SURFACE.highFault, SURFACE.highWater]) {
      const terrain = new Uint8Array(sim.n).fill(feature);
      expect(surfaceSiteLevel(terrain, sim.size, 15, 14, 1, 1)).toBe(-1);
    }
    expect(surfaceSiteLevel(new Uint8Array(sim.n).fill(SURFACE.high), sim.size, 15, 14, 1, 1)).toBe(SURFACE.high);
  });
});
