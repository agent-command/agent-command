/** The sweep result schema (JSON) and the report sections built on it: Spire damage, sappers and chasms, unit mix. */
import { describe, expect, it } from 'vitest';
import { DAMAGE_ORIGINS, PLANES, SAPPER_FIELDS, summarize, toTicks, type ArmyId, type DamageOrigin, type MatchTrace, type Plane, type SapperMetrics, type SpireDamage } from '@agent-command/game';
import { evaluate } from '../src/guardrails.ts';
import { aggregate, type MatchSummary } from '../src/metrics.ts';
import { archive, toJson, toMarkdown, type SweepResult } from '../src/report.ts';
import type { RunSet } from '../src/spec.ts';

const segment = (from: Partial<Record<DamageOrigin, number>> = {}, by: Record<string, number> = {}): SpireDamage =>
  ({ from: { depths: 0, surface: 0, sky: 0, orbit: 0, none: 0, ...from }, by });
const segments = (over: Partial<Record<Plane, SpireDamage>> = {}): Record<Plane, SpireDamage> =>
  ({ depths: segment(), surface: segment(), sky: segment(), orbit: segment(), ...over });
const sapperRow = (over: Partial<SapperMetrics> = {}): SapperMetrics =>
  ({ ordered: 0, noTunnel: 0, rejected: 0, planted: 0, defused: 0, dud: 0, hit: 0, damage: 0, chasmOrdered: 0, chasmRejected: 0, ...over });

const trace = (): MatchTrace => ({
  armies: ['nw', 'se'],
  ticks: toTicks(12 * 60),
  samples: [],
  events: [
    { t: 100, k: 'produced', plane: 'surface', side: 'nw', subject: 'trooper' },
    { t: 120, k: 'produced', plane: 'surface', side: 'se', subject: 'tank' },
    { t: 140, k: 'produced', plane: 'depths', side: 'se', subject: 'sapper' },
  ],
  spireDamage: {
    nw: segments({ surface: segment({ orbit: 600, surface: 300 }, { impact: 600, tank: 300 }) }),
    se: segments({ surface: segment({ depths: 400, orbit: 200 }, { collapse: 400, core_drop: 200 }), orbit: segment({ orbit: 250 }, { lancer: 250 }) }),
  },
  sappers: { nw: sapperRow(), se: sapperRow({ ordered: 3, noTunnel: 1, planted: 2, defused: 1, hit: 1, damage: 400, chasmOrdered: 1 }) },
});

const summary = (set: string, entrants: number[], winner: ArmyId): MatchSummary => summarize(trace(), {
  set, seed: 1, entrants, winner, rank: winner === 'nw' ? { nw: 1, se: 2 } : { nw: 2, se: 1 }, capped: false, spire: { nw: 1, se: 0 }, wallMs: 10,
});

const mirror: RunSet = { key: 'mirror-standard', kind: 'mirror', title: 'standard mirror', layout: 'duel', entrants: [{ level: 'standard' }, { level: 'standard' }], seeds: [1], permutations: [[0, 1]] };
const probe: RunSet = {
  key: 'probe-sapper-swarm-standard', kind: 'probe', title: 'sapper-swarm vs standard', layout: 'duel',
  entrants: [{ level: 'standard', probe: 'sapper-swarm' }, { level: 'standard' }], seeds: [1], permutations: [[0, 1], [1, 0]],
};

function sweep(): SweepResult {
  const matches = [summary(mirror.key, [0, 1], 'nw'), summary(probe.key, [1, 0], 'se'), summary(probe.key, [0, 1], 'nw')];
  const sets = [mirror, probe].map((set) => aggregate(set, matches.filter((m) => m.set === set.key)));
  return {
    label: 'schema', node: '24', workers: 1, wallMs: 1,
    plan: { layout: 'duel', seeds: 1, probeSeeds: 1, probeLevels: ['standard'], probes: ['sapper-swarm'] },
    sets, guardrails: evaluate(sets), matches: matches.map(archive),
  };
}

describe('sweep report schema', () => {
  const result = sweep();
  const json = JSON.parse(toJson(result)) as SweepResult;

  it('round-trips through the JSON file', () => {
    expect(json).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it('run sets carry the measurement sections with closed keys', () => {
    for (const set of json.sets) {
      expect(Object.keys(set).sort()).toEqual([
        'aBySlot', 'aPlacement', 'aRanks', 'aRate', 'bias', 'capped', 'cross', 'draws', 'entrants', 'environmental', 'firstMinute', 'key', 'kills', 'kind',
        'layout', 'length', 'mix', 'n', 'produced', 'sappers', 'slotWins', 'slots', 'spireDamage', 'structureEdge', 'title', 'unattributed', 'units', 'wallMs', 'wins',
      ]);
      expect(Object.keys(set.spireDamage)).toEqual([...PLANES]);
      for (const plane of PLANES) {
        expect(Object.keys(set.spireDamage[plane]).sort()).toEqual(['by', 'from', 'total']);
        expect(Object.keys(set.spireDamage[plane].from)).toEqual([...DAMAGE_ORIGINS]);
        expect(set.spireDamage[plane].total).toBeCloseTo(DAMAGE_ORIGINS.reduce((a, o) => a + set.spireDamage[plane].from[o], 0));
      }
      expect(set.sappers).toHaveLength(set.entrants.length);
      for (const row of set.sappers) expect(Object.keys(row).sort()).toEqual([...SAPPER_FIELDS].sort());
      expect(Object.keys(set.mix)).toEqual([...PLANES]);
      for (const plane of PLANES) expect(Object.keys(set.mix[plane]).sort()).toEqual(['entropy', 'kinds', 'produced']);
    }
  });

  it('archived matches keep per-army Spire damage and sapper rows', () => {
    for (const match of json.matches) {
      for (const army of match.armies) {
        expect(Object.keys(match.spireDamage[army]!)).toEqual([...PLANES]);
        for (const plane of PLANES) expect(Object.keys(match.spireDamage[army]![plane].from)).toEqual([...DAMAGE_ORIGINS]);
        expect(Object.keys(match.sappers[army]!).sort()).toEqual([...SAPPER_FIELDS].sort());
      }
    }
  });

  it('keeps impacts and core drops apart, and splits sapper outcomes by entrant', () => {
    const [m, p] = json.sets;
    expect(m!.spireDamage.surface.by['impact']).toBe(600);
    expect(m!.spireDamage.surface.by['core_drop']).toBe(200);
    expect(m!.spireDamage.surface.from.orbit).toBe(800);
    // The probe (entrant 0) played se, then nw.
    expect(p!.sappers[0]).toEqual(sapperRow({ ordered: 1.5, noTunnel: 0.5, planted: 1, defused: 0.5, hit: 0.5, damage: 200, chasmOrdered: 0.5 }));
    expect(m!.mix.surface).toEqual({ produced: 2, entropy: 1, kinds: 2 });
  });

  it('renders the Spire damage, sapper and unit-mix sections', () => {
    const md = toMarkdown(json);
    expect(md).toContain('## Spire damage by segment');
    expect(md).toContain('| run set | segment | HP per match | from depths | from surface | from sky | from orbit | from none | impact | core_drop | top causes |');
    // standard mirror, Surface: 1500 HP per match, 53% from Orbit, impacts 40%, core drops 13%.
    expect(md).toContain('| standard mirror | surface | 1500.0 | 27% | 20% | 0% | 53% | 0% | 40% | 13% | impact 40%, collapse 27%, tank 20% |');
    expect(md).toContain('Surface Spire damage (standard mirror): 1500.0 HP per match; impacts 40%, core drops 13%');
    expect(md).toContain('## Sappers and chasms');
    expect(md).toContain('| standard mirror | all armies | 3.0 | 1.0 | 0.0 | 2.0 | 1.0 | 0.0 | 1.0 | 400.0 | 1.0 / 0.0 |');
    expect(md).toContain('| sapper-swarm vs standard | sapper-swarm | 1.5 | 0.5 | 0.0 | 1.0 | 0.5 | 0.0 | 0.5 | 200.0 | 0.5 / 0.0 |');
    expect(md).toContain('### Unit mix per plane');
    expect(md).toContain('| standard mirror | 1.0 | 2.0 | 0.0 | 0.0 | 0.0 (1) | 1.0 (2) | 0.0 (0) | 0.0 (0) |');
  });
});
