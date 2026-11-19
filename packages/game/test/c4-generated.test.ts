/** Generated four-slot (C4) maps in the sim: four armies start, and stay, an exact orbit of quarter turns. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, TERRAIN_PRESETS } from '../src/rules/contract.ts';
import { generateMapDocument } from '../src/maps/maps.ts';
import { Sim } from '../src/sim/sim.ts';
import { orbitAsymmetry, rotationGroup } from './mirror.ts';

const SIZE = 48;
const SEED = 3;

const fourArmies = (preset: (typeof TERRAIN_PRESETS)[number]): Sim =>
  new Sim(SEED, {}, generateMapDocument(SEED, preset, { ...DEFAULT_RULES.map, size: SIZE }, 4, SEED));

describe('generated four-slot maps in the sim', () => {
  it('build four armies in an exact quarter-turn orbit', () => {
    for (const preset of TERRAIN_PRESETS) {
      const sim = fourArmies(preset);
      expect(sim.sides, preset).toBe(4);
      expect(sim.allArmies, preset).toHaveLength(4);
      expect(rotationGroup(sim), preset).toEqual([0, 1, 2, 3]);
      expect(orbitAsymmetry(sim), preset).toBeUndefined();
    }
  });

  for (const preset of TERRAIN_PRESETS) {
    it(`${preset} keeps the orbit for 200 ticks`, { tags: ['timing'] }, () => {
      const sim = fourArmies(preset);
      for (let i = 0; i < 200; i++) sim.step();
      expect(orbitAsymmetry(sim)).toBeUndefined();
    });
  }
});
