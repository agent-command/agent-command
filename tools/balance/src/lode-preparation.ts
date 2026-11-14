#!/usr/bin/env node
/** Count home terrain preparation on the current generator, without simulating any matches. */
import { writeFileSync } from 'node:fs';
import { DEFAULT_RULES, TERRAIN_PRESETS } from '../../../packages/game/src/rules/contract.ts';
import { generateTerrain, generateWorld } from '../../../packages/game/src/maps/world.ts';

const presets = TERRAIN_PRESETS.map((terrain) => {
  const seeds = Array.from({ length: 100 }, (_, i) => i + 1).map((seed) => {
    const world = generateWorld(seed, generateTerrain(seed, terrain, DEFAULT_RULES.map, 2), DEFAULT_RULES.map, 2, seed);
    const home = world.generation.lodes.find((s) => s.zone === 'home')!;
    return { seed, ...home };
  });
  return {
    terrain,
    maps: seeds.length,
    cliffPreparedMaps: seeds.filter((s) => s.cliffPrepared > 0).length,
    preparedPairs: seeds.reduce((n, s) => n + s.prepared, 0),
    cliffPreparedPairs: seeds.reduce((n, s) => n + s.cliffPrepared, 0),
    fallbackPairs: seeds.reduce((n, s) => n + s.fallback, 0),
    missingPairs: seeds.reduce((n, s) => n + s.missing, 0),
    seeds,
  };
});
const result = { seeds: '1–100', countingUnit: 'mirrored pairs (two outcrops per pair)', presets };
const path = process.argv[2] ?? 'docs/balance/lode-zones-preparation.json';
writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(presets.map(({ seeds: _seeds, ...summary }) => summary), null, 2) + '\n');
