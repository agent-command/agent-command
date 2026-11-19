import { describe, expect, it } from 'vitest';
import { benchGuardrails, evaluate, GUARDRAILS, probeMax } from '../src/guardrails.ts';
import type { SetStats } from '../src/metrics.ts';
import { layoutArmies, standardPlan, type EntrantSpec, type Layout } from '../src/spec.ts';
import { binomialTwoSided, uniformFit, wilson } from '../src/stats.ts';

const noDamage = { total: 0, from: { depths: 0, surface: 0, sky: 0, orbit: 0, none: 0 }, by: {} };
const noMix = { produced: 0, entropy: 0, kinds: 0 };

/**
 * Minimal run-set stats: only the fields the guardrails read are meaningful. `wins` are per slot (= per entrant: one
 * orientation), entrant 0 on slot 0.
 */
function stats(key: string, kind: SetStats['kind'], entrants: EntrantSpec[], w: { wins: number[]; draws?: number; median?: number; layout?: Layout }): SetStats {
  const layout = w.layout ?? 'duel';
  const decisive = w.wins.reduce((a, b) => a + b, 0);
  const n = decisive + (w.draws ?? 0);
  const plane = { depths: 0, surface: 0, sky: 0, orbit: 0 };
  return {
    key,
    kind,
    title: key,
    layout,
    entrants,
    slots: layoutArmies(layout),
    n,
    wins: w.wins,
    draws: w.draws ?? 0,
    capped: 0,
    aRate: wilson(w.wins[0]!, n),
    aBySlot: w.wins.map((wins, slot) => (slot === 0 ? { n, wins } : { n: 0, wins: 0 })),
    aRanks: [],
    aPlacement: Number.NaN,
    slotWins: w.wins,
    bias: { decisive, shares: w.wins.map((x) => wilson(x, decisive)), p: uniformFit(w.wins) },
    length: { median: w.median ?? 12, p10: 0, p25: 0, p75: 0, p90: 0, min: 0, max: 0, hist: [] },
    units: {},
    firstMinute: { slots: w.wins.map(() => plane), allPlanes: 1, active: { depths: 1, surface: 1, sky: 1, orbit: 1 } },
    cross: {},
    produced: {},
    kills: {},
    environmental: {},
    unattributed: 0,
    structureEdge: {},
    spireDamage: { depths: noDamage, surface: noDamage, sky: noDamage, orbit: noDamage },
    sappers: entrants.map(() => ({ ordered: 0, noTunnel: 0, rejected: 0, planted: 0, defused: 0, dud: 0, hit: 0, damage: 0, chasmOrdered: 0, chasmRejected: 0 })),
    mix: { depths: noMix, surface: noMix, sky: noMix, orbit: noMix },
    wallMs: { mean: 0, total: 0 },
  };
}

const field = (level: EntrantSpec['level'], n: number): EntrantSpec[] => Array.from({ length: n }, () => ({ level }));
const mirror = (level: EntrantSpec['level'], nw: number, se: number, median = 12): SetStats =>
  stats(`mirror-${level}`, 'mirror', field(level, 2), { wins: [nw, se], median });
const ffaMirror = (level: EntrantSpec['level'], wins: number[], median = 15): SetStats =>
  stats(`ffa-mirror-${level}`, 'mirror', field(level, 4), { wins, median, layout: 'ffa' });
const probe = (layout: Layout, wins: number[]): SetStats =>
  stats(`probe-x-${layout}`, 'probe', [{ level: 'standard', probe: 'x' }, ...field('standard', wins.length - 1)], { wins, layout });

describe('guardrails', () => {
  it('a balanced sweep passes every guardrail', () => {
    const r = evaluate([
      mirror('novice', 11, 9, 30),
      mirror('standard', 12, 12),
      mirror('veteran', 10, 14, 11),
      stats('veteran-vs-novice', 'ladder', [{ level: 'veteran' }, { level: 'novice' }], { wins: [45, 3] }),
      stats('probe-surface-rush-veteran', 'probe', [{ level: 'veteran', probe: 'surface-rush' }, { level: 'veteran' }], { wins: [8, 12] }),
    ]);
    expect(r.every((g) => g.pass)).toBe(true);
    // novice is exempt from the length band; bias is checked on all three mirrors
    expect(r.map((g) => `${g.id}:${g.set}`)).toEqual([
      'slot_bias:mirror-novice',
      'slot_bias:mirror-standard',
      'slot_bias:mirror-veteran',
      'veteran_over_novice:veteran-vs-novice',
      'length_band:mirror-standard',
      'length_band:mirror-veteran',
      'probe_ceiling:probe-surface-rush-veteran',
    ]);
    expect(r[0]!.value).toBe(`nw 11 · se 9 (0 draws), p = ${binomialTwoSided(11, 20).toFixed(3)}`);
  });

  it('two-army slot bias is the Bonferroni-corrected exact binomial test', () => {
    // 17–7 has p ≈ 0.064 (passes even uncorrected); 19–5 has p ≈ 0.0066, under 0.05 / 3 = 0.0167
    expect(evaluate([mirror('standard', 17, 7)])[0]!.pass).toBe(true);
    const three = evaluate([mirror('novice', 12, 12), mirror('standard', 19, 5), mirror('veteran', 12, 12)]).filter((g) => g.id === 'slot_bias');
    expect(three.map((g) => g.pass)).toEqual([true, false, true]);
    expect(three[1]!.target).toContain('0.0167');
    // with one mirror the threshold is the plain α: 18–6 (p ≈ 0.023) fails
    expect(evaluate([mirror('standard', 18, 6)])[0]!.pass).toBe(false);
    for (const [nw, se] of [[17, 7], [19, 5], [18, 6], [3, 1]] as const) expect(mirror('standard', nw, se).bias.p).toBe(binomialTwoSided(nw, nw + se));
  });

  it('four-army slot bias tests decisive wins per slot against uniform, Bonferroni across every mirror', () => {
    const fair = ffaMirror('standard', [6, 5, 7, 6]);
    const biased = ffaMirror('veteran', [16, 3, 3, 2]);
    const r = evaluate([mirror('standard', 12, 12), fair, biased]).filter((g) => g.id === 'slot_bias');
    expect(r.map((g) => [g.set, g.pass])).toEqual([['mirror-standard', true], ['ffa-mirror-standard', true], ['ffa-mirror-veteran', false]]);
    expect(r[2]!.value).toBe(`nw 16 · ne 3 · se 3 · sw 2 (0 draws), p = ${uniformFit([16, 3, 3, 2]).toFixed(3)}`);
    expect(r[2]!.target).toContain('0.0167');
    // Every match drawn (equal bots in an exact orbit): no evidence of bias, not a failure.
    expect(evaluate([ffaMirror('standard', [0, 0, 0, 0])])[0]).toMatchObject({ id: 'slot_bias', pass: true });
  });

  it('veteran must beat novice in a duel at least 80% of all matches, draws counting against it', () => {
    const vn = (w: number, l: number, d: number) =>
      evaluate([stats('veteran-vs-novice', 'ladder', [{ level: 'veteran' }, { level: 'novice' }], { wins: [w, l], draws: d })])[0]!;
    expect(vn(40, 10, 0).pass).toBe(true);
    expect(vn(39, 1, 10).pass).toBe(false);
    expect(vn(39, 11, 0).pass).toBe(false);
    // one result per terrain preset
    const ladder = (key: string) => stats(key, 'ladder', [{ level: 'veteran' }, { level: 'novice' }], { wins: [20, 0] });
    expect(evaluate([ladder('veteran-vs-novice@open'), ladder('veteran-vs-novice@canyons')]).map((g) => g.set)).toEqual(['veteran-vs-novice@open', 'veteran-vs-novice@canyons']);
    // a probe-vs-novice ladder is not the guardrail's evidence
    expect(evaluate([stats('x', 'ladder', [{ level: 'veteran', probe: 'surface-rush' }, { level: 'novice' }], { wins: [0, 50] })])).toEqual([]);
  });

  it('median length must sit in the layout band for its competent mirrors', () => {
    const [lo, hi] = GUARDRAILS.lengthBand.duel;
    expect([lo, hi]).toEqual([10, 15]);
    const len = (median: number) => evaluate([mirror('veteran', 12, 12, median)]).find((g) => g.id === 'length_band')!.pass;
    expect([len(lo - 0.1), len(lo), len(hi), len(hi + 0.1)]).toEqual([false, true, true, false]);
    expect(evaluate([mirror('novice', 12, 12, 30)]).some((g) => g.id === 'length_band')).toBe(false);
    // Four-army FFA: standard only, 12–20 min.
    expect(GUARDRAILS.lengthBand.ffa).toEqual([12, 20]);
    const ffa = (median: number) => evaluate([ffaMirror('standard', [1, 1, 1, 1], median)]).find((g) => g.id === 'length_band')!.pass;
    expect([ffa(11.9), ffa(12), ffa(20), ffa(20.1)]).toEqual([false, true, true, false]);
    expect(evaluate([ffaMirror('veteran', [1, 1, 1, 1], 30)]).some((g) => g.id === 'length_band')).toBe(false);
  });

  it('no probe may win more than 1.3× the uniform share against its own level', () => {
    expect(probeMax('duel')).toBe(0.65);
    expect(probeMax('ffa')).toBe(0.325);
    const pass = (layout: Layout, wins: number[]) => evaluate([probe(layout, wins)])[0]!.pass;
    expect(pass('duel', [13, 7])).toBe(true); // 65%
    expect(pass('duel', [14, 6])).toBe(false); // 70%
    expect(pass('ffa', [13, 9, 9, 9])).toBe(true); // 32.5%
    expect(pass('ffa', [14, 9, 9, 8])).toBe(false); // 35%
    expect(evaluate([probe('ffa', [14, 9, 9, 8])])[0]!.target).toBe('≤ 32.5%');
  });

  it('missing evidence is skipped, not failed', () => {
    expect(evaluate([])).toEqual([]);
  });

  it('benchmark data guardrails: binomial slot bias on duels, FFA ceilings and bands', () => {
    const duel = standardPlan({ seeds: 1, probeSeeds: 1, probes: ['surface-rush'], probeLevels: ['standard'] });
    const ffa = standardPlan({ layout: 'ffa', seeds: 1, probeSeeds: 1, probes: ['ffa-vulture'], probeLevels: ['standard'], sizes: [48] });
    const rules = benchGuardrails([...duel, ...ffa]);
    const bias = rules.filter((rule) => rule.id.startsWith('slot_bias:'));
    // The shared evaluator has no multinomial aggregation: FFA slot bias is evaluated by `evaluate` alone.
    expect(bias.map((rule) => rule.id)).toEqual(['slot_bias:mirror-novice', 'slot_bias:mirror-standard', 'slot_bias:mirror-veteran']);
    expect(bias.every((rule) => rule.scope === 'team:nw' && rule.aggregation === 'binomialTwoSided' && rule.threshold === 0.05 / 6)).toBe(true);
    expect(rules.find((rule) => rule.id === 'probe_ceiling:ffa-probe-ffa-vulture-standard')).toMatchObject({ threshold: 0.325, scope: 'entrant:A' });
    expect(rules.find((rule) => rule.id === 'length_band:ffa-mirror-standard')).toMatchObject({ threshold: [12, 20] });
    expect(rules.some((rule) => rule.id === 'length_band:ffa-mirror-veteran')).toBe(false);
  });
});
