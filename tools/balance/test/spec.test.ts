import { describe, expect, it } from 'vitest';
import { rotations, setMatches, standardPlan } from '../src/spec.ts';
import { balanceConfigs, trialCount } from '../src/bench.ts';

describe('sweep plan', () => {
  it('rotations play every entrant on every slot once', () => {
    expect(rotations(2)).toEqual([[0, 1], [1, 0]]);
    expect(rotations(4)).toEqual([[0, 1, 2, 3], [3, 0, 1, 2], [2, 3, 0, 1], [1, 2, 3, 0]]);
    // rotation r puts entrant 0 on slot r
    expect(rotations(4).map((p) => p.indexOf(0))).toEqual([0, 1, 2, 3]);
  });

  it('mirrors, ladder and probes; rotated sets play every orientation', () => {
    const sets = standardPlan({ seeds: 2, probeSeeds: 1, probes: ['surface-rush'], probeLevels: ['veteran'] });
    expect(sets.map((s) => s.key)).toEqual([
      'mirror-novice',
      'mirror-standard',
      'mirror-veteran',
      'veteran-vs-novice',
      'veteran-vs-standard',
      'standard-vs-novice',
      'probe-surface-rush-veteran',
    ]);
    expect(sets.every((s) => s.options === undefined && s.layout === 'duel')).toBe(true);
    const configs = balanceConfigs(sets, 100);
    // 3 mirrors × 2 seeds + 3 ladders × 2 seeds × 2 sides + 1 probe × 1 seed × 2 sides
    expect(configs.reduce((sum, config) => sum + trialCount(config.spec), 0)).toBe(6 + 12 + 2);
    expect(sets.reduce((sum, set) => sum + setMatches(set), 0)).toBe(6 + 12 + 2);
    const probe = configs[sets.findIndex((set) => set.key === 'probe-surface-rush-veteran')]!;
    expect(probe.spec.permutations).toHaveLength(2);
    expect(Object.keys(probe.policies!.A!)).toEqual(['surface']);
    expect(Object.keys(probe.policies!.B!)).toEqual([]);
  });

  it('several terrain presets tag every set; one preset only sets the option', () => {
    const many = standardPlan({ seeds: 1, probeSeeds: 1, probes: [], probeLevels: [], terrains: ['open', 'canyons'] });
    expect(many.map((s) => s.key).slice(0, 2)).toEqual(['mirror-novice@open', 'mirror-standard@open']);
    expect(many.filter((s) => s.options?.['terrain'] === 'canyons').map((s) => s.title)).toContain('veteran mirror (canyons)');
    expect(many).toHaveLength(12);
    const one = standardPlan({ seeds: 1, probeSeeds: 1, probes: [], probeLevels: [], terrains: ['ridges'] });
    expect(one[0]).toMatchObject({ key: 'mirror-novice', options: { terrain: 'ridges' } });
  });

  it('seeds 0 plays the probes only', () => {
    const sets = standardPlan({ seeds: 0, probeSeeds: 2, probes: ['rail-economy'], probeLevels: ['standard', 'veteran'] });
    expect(sets.map((s) => s.key)).toEqual(['probe-rail-economy-standard', 'probe-rail-economy-veteran']);
  });

  it('rejects unknown probes and probes of another layout', () => {
    expect(() => standardPlan({ seeds: 1, probeSeeds: 1, probes: ['nope'], probeLevels: ['standard'] })).toThrow(/unknown probe nope/);
    expect(() => standardPlan({ seeds: 1, probeSeeds: 1, probes: ['ffa-turtle'], probeLevels: ['standard'] })).toThrow(/does not play the duel layout/);
  });

  it('the duel plan never runs the FFA-only probes', () => {
    const keys = standardPlan({ seeds: 0, probeSeeds: 1, probeLevels: ['standard'] }).map((s) => s.key);
    expect(keys).toHaveLength(10);
    expect(keys.some((key) => key.includes('ffa-'))).toBe(false);
  });

  it('four-army FFA: C4 maps per size, four-entrant mirrors, probes in all four rotations, no ladder', () => {
    const sets = standardPlan({
      layout: 'ffa', seeds: 2, probeSeeds: 1, probes: ['ffa-turtle', 'ffa-vulture'], probeLevels: ['standard'],
      mirrorLevels: ['standard', 'veteran'], sizes: [48, 64],
    });
    expect(sets.map((s) => s.key)).toEqual([
      'ffa-mirror-standard@s48', 'ffa-mirror-veteran@s48', 'ffa-probe-ffa-turtle-standard@s48', 'ffa-probe-ffa-vulture-standard@s48',
      'ffa-mirror-standard@m64', 'ffa-mirror-veteran@m64', 'ffa-probe-ffa-turtle-standard@m64', 'ffa-probe-ffa-vulture-standard@m64',
    ]);
    expect(sets[0]!.title).toBe('FFA standard mirror (S48)');
    expect(sets.every((s) => s.layout === 'ffa' && s.entrants.length === 4)).toBe(true);
    expect(sets[0]!.options).toEqual({ map: { params: { slots: 4, size: 48 } } });
    expect(sets[4]!.options).toEqual({ map: { params: { slots: 4, size: 64 } } });
    expect(sets[0]!.permutations).toEqual([[0, 1, 2, 3]]);
    expect(sets[2]!.permutations).toEqual(rotations(4));
    expect(sets[2]!.entrants).toEqual([{ level: 'standard', probe: 'ffa-turtle' }, { level: 'standard' }, { level: 'standard' }, { level: 'standard' }]);
    // 2 mirrors × 2 seeds + 2 probes × 1 seed × 4 rotations, per size
    expect(sets.reduce((sum, set) => sum + setMatches(set), 0)).toBe(2 * (4 + 8));
    // One size alone only sets the option; FFA defaults to every probe that plays it.
    const one = standardPlan({ layout: 'ffa', seeds: 0, probeSeeds: 1, probeLevels: ['veteran'], sizes: [64] });
    expect(one[0]).toMatchObject({ key: 'ffa-probe-surface-rush-veteran', options: { map: { params: { slots: 4, size: 64 } } } });
    expect(one.map((s) => s.key)).toContain('ffa-probe-ffa-vulture-veteran');
  });

  it('FFA run sets resolve to four-army series on the C4 recipe', () => {
    const [mirror, probe] = standardPlan({ layout: 'ffa', seeds: 1, probeSeeds: 1, probes: ['ffa-vulture'], probeLevels: ['standard'], mirrorLevels: ['standard'] });
    const configs = balanceConfigs([mirror!, probe!], 100, 0);
    expect(configs[0]!.spec.template.sides.map((side) => side.id)).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(configs[0]!.spec.template.map.layout).toBe('ffa');
    expect(configs[1]!.spec.permutations.map((p) => p.sideEntrants.map((entry) => entry.entrantId))).toEqual([
      ['A', 'B', 'C', 'D'], ['D', 'A', 'B', 'C'], ['C', 'D', 'A', 'B'], ['B', 'C', 'D', 'A'],
    ]);
    expect(Object.keys(configs[1]!.policies!.A!)).toEqual(['surface']);
    expect(trialCount(configs[1]!.spec)).toBe(4);
  });
});
