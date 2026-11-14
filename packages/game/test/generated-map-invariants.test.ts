/**
 * Generated maps are implementation output, not a versioned external fixture. Check their contracts instead of
 * pinning incidental hashes. Bot replay and army symmetry remain covered by determinism.test.ts and mirror tests.
 */
import { expect, it } from 'vitest';
import { generateMapDocument } from '../src/maps/maps.ts';
import { buildWorldFromDocument, validateMapDocument } from '../src/maps/document.ts';
import { crowdsPost } from '../src/maps/posts.ts';
import { LODE_APRON, LODE_POCKET } from '../src/maps/world.ts';
import { DEFAULT_RULES, TERRAIN_PRESETS } from '../src/rules/contract.ts';
import { rotCell } from '../src/util/teams.ts';

for (const preset of TERRAIN_PRESETS) for (const size of [48, 64, 80]) {
  it(`${preset} S${size} generation is deterministic, symmetric and keeps complete resources clear of flags`, () => {
    for (const enabled of [true, false]) {
      const rules = { ...DEFAULT_RULES.map, size, motherLode: { ...DEFAULT_RULES.map.motherLode, enabled } };
      const doc = generateMapDocument(7, preset, rules, 2, 7);
      expect(generateMapDocument(7, preset, rules, 2, 7)).toEqual(doc);
      const validation = validateMapDocument(doc);
      expect(validation.valid, validation.errors.join('; ')).toBe(true);
      const world = buildWorldFromDocument(doc);
      for (const zone of world.generation.lodes) expect(zone.placed, zone.zone).toBe(zone.requested);
      expect(world.lodes.filter((l) => !l.rich)).toHaveLength(2 * rules.homeLodes);
      for (const l of world.lodes) {
        expect(crowdsPost(l.c, LODE_POCKET + LODE_APRON, world.posts, size, 0)).toBe(false);
        expect(world.lodes).toContainEqual({ ...l, c: rotCell(2, l.c, size) });
      }
      for (let c = 0; c < world.terrain.length; c++) {
        expect(world.terrain[c]).toBe(world.terrain[rotCell(2, c, size)]);
      }
    }
  });
}
