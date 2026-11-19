import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, MAP_SIZES, RULE_FIELDS, TERRAIN_PRESETS, checkRules, resolveRules, type TerrainPreset } from '../src/rules/contract.ts';
import { MAPS, generateMapDocument, hashMapDocument, namedMap, registerNamedMap, resolveMapDocument } from '../src/maps/maps.ts';
import { buildWorldFromDocument, validateMapDocument } from '../src/maps/document.ts';
import { isTemplatePreset } from '../src/maps/templates.ts';
import { generateTerrain, generateWorld } from '../src/maps/world.ts';
import { Rng } from '../src/util/rng.ts';
import { rotCell } from '../src/util/teams.ts';
import { lobbyMode } from '../src/lobby/lobby.ts';
import { Sim } from '../src/sim/sim.ts';
import { matchData } from '../src/agent/present.ts';

describe('map document pipeline', () => {
  for (const size of MAP_SIZES) for (const preset of TERRAIN_PRESETS) {
    it(`${preset}/${size} validates deterministic, exactly fair rotated geometry`, () => {
      const rules = resolveRules({ terrain: preset, map: { params: { size } } });
      for (const seed of [1, 17, 99]) {
        const document = generateMapDocument(seed, preset, rules.map, 2, seed);
        const result = validateMapDocument(document);
        expect(result.errors, `${preset}/${size}/${seed}`).toEqual([]);
        expect(result.valid).toBe(true);
        const [blue, red] = result.fairness!.slots;
        expect(blue!.surfaceDistances[1]).toBeGreaterThan(0);
        expect(blue!.surfaceDistances[1]).toBe(red!.surfaceDistances[0]);
        expect(blue!.sectorOre).toBe(red!.sectorOre);
        expect(blue!.accessibleLodeLoads).toBe(red!.accessibleLodeLoads);
        expect(blue!.nearestOre).toBe(red!.nearestOre);
        expect(blue!.nearestLode).toBe(red!.nearestLode);
        expect(blue!.chokeClearance).toBe(red!.chokeClearance);
        expect(blue!.exposure).toEqual(red!.exposure);
        expect(hashMapDocument(document)).toBe(hashMapDocument(generateMapDocument(seed, preset, rules.map, 2, seed)));
        expect(document.generation.stages!.map(stage => stage.name)).toEqual(['terrain', 'depths', 'magma', 'ore', 'faults', 'features', 'islands-orbit', 'lava']);
      }
    });
  }

  it('derives ordered stage seeds from the raw map seed, including zero', () => {
    for (const seed of [0, 1, 0xffffffff]) {
      const document = generateMapDocument(seed, 'open', DEFAULT_RULES.map, 2, seed);
      expect(document.generation.stages!.slice(0, 6)).toEqual([
        { name: 'terrain', seed: (seed ^ 0x5eed7e44) >>> 0 },
        { name: 'depths', seed: (seed ^ 0x44455054) >>> 0 },
        { name: 'magma', seed: (seed ^ 0x4d41474d) >>> 0 },
        { name: 'ore', seed: (seed ^ 0x4f524553) >>> 0 },
        { name: 'faults', seed: (seed ^ 0x4641554c) >>> 0 },
        { name: 'features', seed: (seed ^ 0x46454154) >>> 0 },
      ]);
    }
  });

  it('independent stage streams do not reshuffle unrelated layers', () => {
    const base = generateMapDocument(2048, 'ridges', DEFAULT_RULES.map, 2, 2048);
    const changed = generateMapDocument(2048, 'ridges', resolveRules({ map: { params: { oreRim: 7, oreCentre: 24, islandRings: 2 } } }).map, 2, 2048);
    const a = buildWorldFromDocument(base), b = buildWorldFromDocument(changed);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.cells).toEqual(b.cells);
    expect(a.magma).toEqual(b.magma);
    expect(a.cavern).toEqual(b.cavern);
    expect(a.lodes).toEqual(b.lodes);
    expect(a.ore).not.toEqual(b.ore);
    // Fewer rings: islands follow islandRings (on S48 only three rings fit at islandClearance, so fewer, not more).
    expect(b.islands.length).toBeLessThan(a.islands.length);
  });

  // Twin worlds: the public map seed is all a client is told; the match seed stays secret on a live server.
  /** The public bootstrap: lode sites are prepared from public layers, so nothing in it may differ between twins. */
  const twinView = (s: Sim) => JSON.stringify(matchData(s, 0));
  for (const preset of TERRAIN_PRESETS) {
    it(`${preset}: one public map seed with two secret match seeds gives the same bootstrap over different hidden worlds`, () => {
      const map = { seed: 77, params: { size: 64 } };
      const a = new Sim(1, { terrain: preset, map });
      const b = new Sim(2 ** 40 + 5, { terrain: preset, map });
      // Everything the bootstrap names rebuilds the public map only, never the match's hidden layers or events.
      const data = matchData(a, 0);
      const rebuilt = new Sim(data.mapSeed, { terrain: data.preset, map: { seed: data.mapSeed, params: { size: data.rules.map.size } } });
      expect(data.mapSeed).toBe(77);
      expect(JSON.stringify(data)).not.toContain('eventSeed');
      const [va, vb, vr] = [twinView(a), twinView(b), twinView(rebuilt)];
      expect(vb).toBe(va);
      expect(vr).toBe(va);
      expect(b.terrain).toEqual(a.terrain);
      expect(rebuilt.terrain).toEqual(a.terrain);
      for (const other of [b, rebuilt]) {
        expect(other.cells).not.toEqual(a.cells);
        expect(other.ore).not.toEqual(a.ore);
        // Lodes come from the secret features stream (a zone whose public sites leave no choice may still match;
        // lode-zones.test checks that secrets move lodes across presets).
        expect(other.mapDocument.generation.stages!.find((s) => s.name === 'features')).not.toEqual(a.mapDocument.generation.stages!.find((s) => s.name === 'features'));
        expect(other.rng.state).not.toBe(a.rng.state);
        expect(other.rockRng.state).not.toBe(a.rockRng.state);
        expect(JSON.stringify(other.weather.random)).not.toBe(JSON.stringify(a.weather.random));
      }
    });
  }

  it('a secret match seed wider than a map seed never becomes the published map seed', () => {
    expect(() => new Sim(2 ** 40 + 5, { map: { params: { size: 64 } } })).toThrow(/Map seed/);
  });

  it('content hashes ignore JSON property insertion order', () => {
    const document = generateMapDocument(1, 'open', DEFAULT_RULES.map, 2, 1);
    const reordered = Object.fromEntries(Object.entries(document).reverse()) as typeof document;
    expect(hashMapDocument(reordered)).toBe(hashMapDocument(document));
    reordered.identity += ' Changed';
    expect(hashMapDocument(reordered)).not.toBe(hashMapDocument(document));
  });
});

describe('four-slot (C4) generated maps', () => {
  for (const size of MAP_SIZES) for (const preset of TERRAIN_PRESETS) {
    it(`${preset}/${size} validates with equal rotated slots and a full lode economy`, () => {
      const rules = resolveRules({ terrain: preset, map: { params: { size } } });
      for (const seed of [1, 17]) {
        const document = generateMapDocument(seed, preset, rules.map, 4, seed);
        expect(document.sides).toBe(4);
        expect(document.symmetry).toBe('C4');
        const result = validateMapDocument(document);
        expect(result.errors, `${preset}/${size}/${seed}`).toEqual([]);
        const slots = result.fairness!.slots;
        expect(slots).toHaveLength(4);
        expect(result.fairness!.layouts.every(layout => layout.equalRotatedSlots)).toBe(true);
        for (const slot of slots) {
          expect(slot.sectorOre).toBe(slots[0]!.sectorOre);
          expect(slot.accessibleLodeLoads).toBe(slots[0]!.accessibleLodeLoads);
          expect(slot.nearestLode).toBe(slots[0]!.nearestLode);
          expect(slot.exposure).toEqual(slots[0]!.exposure);
        }
        // Every slot reaches every other slot, and every requested home and flank lode orbit is placed.
        for (const slot of slots) expect(slot.surfaceDistances.every(d => d !== null)).toBe(true);
        for (const zone of document.generation.lodes) expect(zone.missing, `${preset}/${size}/${seed} ${zone.zone}`).toBe(0);
        expect(hashMapDocument(document)).toBe(hashMapDocument(generateMapDocument(seed, preset, rules.map, 4, seed)));
      }
    });
  }

  it('generated four-slot worlds are invariant under quarter turns', () => {
    for (const preset of TERRAIN_PRESETS) for (const size of MAP_SIZES) {
      const map = { ...DEFAULT_RULES.map, size };
      const world = generateWorld(5, generateTerrain(5, preset, map, 4), map, 4, 5);
      const label = `${preset}/${size}`;
      // Owners rotate slot s → s + 1; magma pocket k·4 + r → k·4 + (r + 1) % 4. First mismatching cell, if any.
      let broken: string | undefined;
      for (let c = 0; c < size * size && broken === undefined; c++) {
        const t = rotCell(1, c, size), owner = world.owner[c]!, magma = world.magma[c]!;
        if (world.terrain[t] !== world.terrain[c] || world.cells[t] !== world.cells[c] || world.ore[t] !== world.ore[c] ||
          world.owner[t] !== (owner ? owner % 4 + 1 : 0) ||
          world.magma[t] !== (magma ? magma - 1 - ((magma - 1) % 4) + ((magma - 1) % 4 + 1) % 4 + 1 : 0)) broken = `${label} cell ${c}`;
      }
      expect(broken).toBeUndefined();
      const lodes = new Set(world.lodes.map(l => `${l.c}:${l.rich}:${l.loads}`));
      for (const l of world.lodes) expect(lodes.has(`${rotCell(1, l.c, size)}:${l.rich}:${l.loads}`), label).toBe(true);
      const faults = new Set(world.faults.map(path => path.join(',')));
      for (const path of world.faults) {
        const turned = path.map(c => rotCell(1, c, size));
        expect(faults.has(turned.join(',')) || faults.has([...turned].reverse().join(',')), label).toBe(true);
      }
    }
  });
});

describe('map recipes at the rule bounds', () => {
  // Every recipe checkRules accepts must build (generateMapDocument validates its document), on two and four slots.
  // Route templates draw geometry that can leave no walkable route at the bounds (one-tile diagonal fords and ramps,
  // lakes over the centre, a lake lattice missing itself at the sector seam); generateTerrain opens one, so the cavern
  // finds its centre chamber and every Spire stays connected. Seed 5 is where the unbuildable recipes first surfaced.
  const template = RULE_FIELDS.filter(field => field.path[0] === 'map' && field.path[1] === 'template');
  const build = (preset: TerrainPreset, seed: number, params: Record<string, unknown>): void => {
    const checked = checkRules({ terrain: preset, map: { params } });
    if (!checked.ok) throw new Error(checked.error);
    const map = resolveRules(checked.options).map;
    for (const sides of [2, 4] as const) expect(() => generateMapDocument(seed, preset, map, sides, seed), `${preset}/${seed}/${sides} ${JSON.stringify(params)}`).not.toThrow();
  };
  for (const preset of TERRAIN_PRESETS.filter(isTemplatePreset)) for (const size of MAP_SIZES) {
    it(`${preset}/${size} builds with each template field at its minimum and maximum`, () => {
      for (const field of template) for (const value of [field.min!, field.max!]) build(preset, 5, { size, template: { [field.path[2]!]: value } });
    });

    it(`${preset}/${size} builds random corners of the template bounds, with and without contested zones`, () => {
      const rng = new Rng(MAP_SIZES.indexOf(size) * TERRAIN_PRESETS.length + TERRAIN_PRESETS.indexOf(preset));
      for (let k = 0; k < 8; k++) {
        const corner = Object.fromEntries(template.map(field => [field.path[2]!, rng.next() < 0.5 ? field.min! : field.max!]));
        build(preset, rng.int(1000), {
          size, template: corner, spireInset: rng.next() < 0.5 ? 3 : 12, ...(k % 2 ? { contestedZones: [] } : {}),
        });
      }
    });
  }
});

describe('map catalogue and authored maps', () => {
  it('publishes playable generated sizes with a C2 duel and a C4 FFA, and four_corners FFA and duel', () => {
    const generated = MAPS.filter(map => map.tags.includes('generated'));
    expect(generated.map(map => map.id)).toEqual(TERRAIN_PRESETS);
    for (const map of generated) {
      expect(map.sizes).toEqual(MAP_SIZES);
      expect(map.sides).toBe(4);
      expect(lobbyMode(map.id, 'duel')).toMatchObject({ supported: true, slots: 2 });
      expect(lobbyMode(map.id, 'ffa')).toMatchObject({ supported: true, slots: 4 });
    }
    const four = MAPS.find(map => map.id === 'four_corners')!;
    expect(four.sides).toBe(4);
    expect(four.layouts.filter(layout => layout.supported).map(layout => layout.id)).toEqual(['ffa', 'duel']);
  });

  for (const name of ['crossfire', 'twin_fords', 'crown', 'four_corners']) {
    it(`${name} is a named, valid canonical document rather than a generator alias`, () => {
      const document = namedMap(name)!;
      expect(document.id).toBe(name);
      expect(validateMapDocument(document).errors).toEqual([]);
      expect(resolveMapDocument(123, 'open', DEFAULT_RULES.map, { name })).toBe(document);
      expect(Object.isFrozen(document)).toBe(true);
      if (document.sides === 4) {
        const result = validateMapDocument(document);
        expect(result.fairness!.slots).toHaveLength(4);
        expect(new Set(result.fairness!.slots.map(slot => slot.sectorOre)).size).toBe(1);
        expect(result.fairness!.layouts.every(layout => layout.equalRotatedSlots)).toBe(true);
        // The sim plays four armies on it, and it launches (DESIGN §2.3, §15).
        expect(new Sim(1, { map: { name } }).allArmies).toHaveLength(4);
        expect(checkRules({ map: { name } }).ok).toBe(true);
      } else {
        const sim = new Sim(999, { map: { name } });
        expect(sim.mapDocument.id).toBe(name);
        expect(sim.size).toBe(document.size);
      }
    });
  }

  it('host-saved maps expose a descriptor and their actual geometry without leaking layers', () => {
    const document = structuredClone(namedMap('crossfire')!);
    document.id = 'saved_fixture';
    document.label = 'Saved fixture';
    document.seed = 1234;
    registerNamedMap(document.id, document);
    const descriptor = MAPS.find(map => map.id === document.id)!;
    expect(descriptor.mapSeed).toBe(1234);
    expect(descriptor).not.toHaveProperty('levels');
    expect(descriptor).not.toHaveProperty('generation');
    expect(lobbyMode(document.id, 'duel')?.sides.map(side => side.id)).toEqual(['nw', 'se']);
    expect(new Sim(1, { map: { name: document.id } }).mapDocument.seed).toBe(1234);
  });
});
