import { describe, expect, it } from 'vitest';
import { actionOf, summarize, toTicks, type ArmyId, type DamageOrigin, type MatchTrace, type Plane, type SapperMetrics, type SpireDamage, type TraceEvent } from '@agent-command/game';
import { aggregate, type MatchMeta, type MatchSummary } from '../src/metrics.ts';
import { binomialTwoSided, uniformFit } from '../src/stats.ts';
import type { RunSet } from '../src/spec.ts';

const s = (sec: number): number => toTicks(sec);
const ev = (t: number, k: string, plane: Plane, side: TraceEvent['side'], extra: Partial<TraceEvent> = {}): TraceEvent => ({ t, k, plane, side, ...extra });
const planes = (n: number[]) => ({ depths: n[0]!, surface: n[1]!, sky: n[2]!, orbit: n[3]! });
const units = (nw: number[], se: number[]) => ({ nw: planes(nw), se: planes(se) });

const segment = (from: Partial<Record<DamageOrigin, number>> = {}, by: Record<string, number> = {}): SpireDamage =>
  ({ from: { depths: 0, surface: 0, sky: 0, orbit: 0, none: 0, ...from }, by });
const segments = (over: Partial<Record<Plane, SpireDamage>> = {}): Record<Plane, SpireDamage> =>
  ({ depths: segment(), surface: segment(), sky: segment(), orbit: segment(), ...over });
const sapperRow = (over: Partial<SapperMetrics> = {}): SapperMetrics =>
  ({ ordered: 0, noTunnel: 0, rejected: 0, planted: 0, defused: 0, dud: 0, hit: 0, damage: 0, chasmOrdered: 0, chasmRejected: 0, ...over });

const meta = (over: Partial<MatchMeta> = {}): MatchMeta => ({
  set: 'mirror-standard',
  seed: 1,
  entrants: [0, 1],
  winner: 'nw',
  rank: { nw: 1, se: 2 },
  capped: false,
  spire: { nw: 10000, se: 0 },
  wallMs: 100,
  ...over,
});

/** A synthetic match: one of every interesting interaction, some inside the first 60 s and some after. */
const TRACE: MatchTrace = {
  armies: ['nw', 'se'],
  ticks: s(12 * 60),
  samples: [
    { minute: 1, units: units([4, 6, 2, 3], [4, 6, 2, 3]) },
    { minute: 3, units: units([8, 10, 4, 4], [6, 12, 3, 4]) },
  ],
  events: [
    ev(s(5), 'deliver', 'depths', 'nw'),
    ev(s(6), 'deliver', 'depths', 'se'),
    ev(s(10), 'grapple', 'orbit', 'nw'),
    ev(s(20), 'island_captured', 'sky', 'se', { subject: 'island' }),
    ev(s(25), 'constructed', 'surface', 'nw', { subject: 'turret' }),
    ev(s(26), 'constructed', 'sky', 'se', { subject: 'relay' }),
    ev(s(30), 'kill', 'surface', 'se', { subject: 'trooper', by: 'tank', killer: 'nw' }),
    ev(s(40), 'charge_defused', 'depths', 'se', { subject: 'sapper', killer: 'nw' }), // se's charge, defused by nw
    ev(s(50), 'scan', 'orbit', 'se'),
    ev(s(55), 'transfer', 'surface', 'nw', { subject: 'trooper', to: 'depths' }),
    ev(s(59), 'produced', 'surface', 'nw', { subject: 'trooper' }), // production is not an action
    ev(s(59), 'dig', 'depths', 'nw'), // neither is digging
    // after the first minute
    ev(s(61), 'deliver', 'depths', 'nw'),
    ev(s(90), 'collapse', 'surface', 'nw'),
    ev(s(90), 'kill', 'surface', 'se', { subject: 'turret', by: 'collapse', killer: 'nw' }),
    ev(s(100), 'impact_incoming', 'surface', 'se', { subject: 'asteroid' }),
    ev(s(108), 'impact', 'surface', 'se', { subject: 'asteroid' }),
    ev(s(108), 'kill', 'surface', 'nw', { subject: 'tank', by: 'impact', killer: 'se' }),
    ev(s(120), 'asteroid_intercepted', 'sky', 'nw', { subject: 'asteroid' }),
    ev(s(130), 'kill', 'sky', 'se', { subject: 'bomber', by: 'flak', killer: 'nw' }),
    ev(s(131), 'kill', 'sky', 'nw', { subject: 'interceptor', by: 'turret', killer: 'se' }),
    ev(s(140), 'kill', 'surface', 'nw', { subject: 'tank', by: 'bomber', killer: 'se' }),
    ev(s(150), 'kill', 'depths', 'se', { subject: 'sapper', by: 'trooper', killer: 'nw' }),
    ev(s(160), 'kill', 'orbit', 'nw', { subject: 'solar', by: 'interceptor', killer: 'se' }),
    ev(s(170), 'kill', 'surface', 'se', { subject: 'trooper', by: 'unknown' }),
    ev(s(171), 'kill', 'sky', 'nw', { subject: 'interceptor', by: 'storm' }),
    ev(s(172), 'kill', 'depths', 'se', { subject: 'digger', by: 'flood' }),
    ev(s(200), 'fell_into_depths', 'depths', 'se', { subject: 'tank' }),
    ev(s(210), 'chasm_opened', 'surface', 'nw'),
    ev(s(220), 'breach_opened', 'surface', 'se'),
    ev(s(230), 'fx:rail', 'depths', 'nw'),
    ev(s(232), 'hole_bridged', 'surface', 'se'),
    ev(s(235), 'magma_flood', 'depths', 'nw'),
    ev(s(240), 'produced', 'sky', 'se', { subject: 'bomber' }),
    ev(s(241), 'produced', 'surface', 'nw', { subject: 'trooper' }),
  ],
  spireDamage: {
    // nw's Surface segment: an asteroid and a tank; its Orbit segment: a Lancer.
    nw: segments({ surface: segment({ orbit: 600, surface: 300 }, { impact: 600, tank: 300 }), orbit: segment({ orbit: 100 }, { lancer: 100 }) }),
    // se's Surface segment: a collapse, and a derelict core dropped from Orbit (its own cause, never an impact).
    se: segments({ surface: segment({ depths: 400, orbit: 200 }, { collapse: 400, core_drop: 200 }) }),
  },
  sappers: {
    nw: sapperRow({ ordered: 2, noTunnel: 1, planted: 2, hit: 1, damage: 400, chasmOrdered: 1 }),
    se: sapperRow({ ordered: 1, rejected: 1, planted: 1, defused: 1, chasmRejected: 1 }),
  },
};

describe('summarize', () => {
  const m = summarize(TRACE, meta());

  it('counts pillar-4 actions per side and plane in the first 60 s only', () => {
    expect(m.firstMinute).toEqual({
      // nw: delivery + defuse (depths); turret + kill + transfer (surface); grapple (orbit)
      nw: { depths: 2, surface: 3, sky: 0, orbit: 1 },
      // se: delivery (depths); island + relay (sky); scan (orbit)
      se: { depths: 1, surface: 0, sky: 2, orbit: 1 },
    });
  });

  it('credits actions to the right side and plane', () => {
    // The defuser is named on the event (`killer`): with several hostile armies it cannot be inferred.
    expect(actionOf(ev(0, 'charge_defused', 'depths', 'se', { killer: 'nw' }))).toEqual({ plane: 'depths', side: 'nw' });
    expect(actionOf(ev(0, 'charge_defused', 'depths', 'se'))).toBeUndefined();
    expect(actionOf(ev(0, 'constructed', 'sky', 'se', { subject: 'relay' }))).toEqual({ plane: 'sky', side: 'se' });
    expect(actionOf(ev(0, 'kill', 'sky', 'se', { by: 'flak', killer: 'nw' }))).toEqual({ plane: 'sky', side: 'nw' });
    expect(actionOf(ev(0, 'kill', 'sky', 'se', { by: 'unknown' }))).toBeUndefined();
    expect(actionOf(ev(0, 'produced', 'surface', 'nw'))).toBeUndefined();
    expect(actionOf(ev(0, 'island_captured', 'sky', 'neutral'))).toBeUndefined();
  });

  it('counts cross-plane interactions', () => {
    expect(m.cross).toMatchObject({
      collapse: 1,
      chasm: 1,
      breach: 1,
      fell: 1,
      transfer: 1,
      defuse: 1,
      impact: 1,
      intercept: 1,
      scan: 1,
      flak_sky: 1,
      ground_air: 2,
      bomber: 1,
      troops_down: 1,
      collapse_kills: 1,
      impact_kills: 1,
      tunnel_breach: 0,
      bridge: 1,
      magma: 1,
    });
  });

  it('tallies production, construction, kills and raw kinds', () => {
    expect(m.produced).toEqual({ nw: { trooper: 2 }, se: { bomber: 1 } });
    expect(m.built).toEqual({ nw: { turret: 1 }, se: { relay: 1 } });
    expect(m.kills).toEqual({ nw: { tank: 1, collapse: 1, flak: 1, trooper: 1 }, se: { impact: 1, turret: 1, bomber: 1, interceptor: 1 } });
    expect(m.unattributed).toBe(1);
    expect(m.environmental).toEqual({ storm: 1, flood: 1 });
    expect(m.kinds['fx:rail']).toBe(1);
    expect(m.kinds['kill']).toBe(11);
    expect(m.units['3']).toEqual(units([8, 10, 4, 4], [6, 12, 3, 4]));
    expect(m.units['5']).toBeUndefined();
  });
});

describe('aggregate', () => {
  const set: Pick<RunSet, 'key' | 'kind' | 'title' | 'entrants' | 'layout'> = {
    key: 'mirror-standard', kind: 'mirror', title: 'standard mirror', layout: 'duel', entrants: [{ level: 'standard' }, { level: 'standard' }],
  };
  const run = (winner: ArmyId | 'draw', minutes: number, over: Partial<MatchMeta> = {}): MatchSummary => ({
    ...summarize({ ...TRACE, ticks: s(minutes * 60) }, meta({
      winner, capped: winner === 'draw', rank: winner === 'draw' ? { nw: 1, se: 1 } : winner === 'nw' ? { nw: 1, se: 2 } : { nw: 2, se: 1 }, ...over,
    })),
  });

  it('win counts, slot split, bias test and length distribution', () => {
    const runs = [run('nw', 8), run('nw', 10), run('se', 12), run('nw', 14), run('draw', 30)];
    const st = aggregate(set, runs);
    expect([st.n, st.wins, st.draws, st.capped]).toEqual([5, [3, 1], 1, 1]);
    expect(st.slots).toEqual(['nw', 'se']);
    expect(st.slotWins).toEqual([3, 1]);
    expect(st.bias.decisive).toBe(4);
    expect(st.bias.shares.map((share) => share.p)).toEqual([0.75, 0.25]);
    expect(st.bias.p).toBeCloseTo(0.625, 6); // 2 × P(X ≥ 3 | n 4) = 2 × 5/16
    expect(st.bias.p).toBe(binomialTwoSided(3, 4));
    expect(st.length.median).toBe(12);
    expect(st.length.hist).toEqual([0, 1, 3, 0, 0, 0, 1]);
    expect(st.aRate.p).toBe(0.6);
    // entrant 0 always on nw: first three times, second once, a shared first in the draw
    expect(st.aRanks).toEqual([4, 1]);
    expect(st.aPlacement).toBe(1.2);
  });

  it('pools a rotated matchup from the entrant under test, per slot', () => {
    const ladder = { ...set, key: 'veteran-vs-novice', kind: 'ladder' as const, entrants: [{ level: 'veteran' as const }, { level: 'novice' as const }] };
    const swapped = { entrants: [1, 0] };
    const runs = [run('nw', 7), run('se', 7, swapped), run('nw', 7, swapped), run('se', 7)];
    const st = aggregate(ladder, runs);
    expect(st.wins).toEqual([2, 2]);
    expect(st.aBySlot).toEqual([{ n: 2, wins: 1 }, { n: 2, wins: 1 }]);
    expect(st.slotWins).toEqual([2, 2]);
    // units stay per slot (the TRACE sample at 3:00 has 10 nw / 12 se surface units)
    expect(st.units['3']!.slots.map((u) => u.surface)).toEqual([10, 12]);
  });

  it('plane activity, cross-plane means, shares and structure edge', () => {
    const quiet: MatchSummary = { ...run('se', 9), firstMinute: { nw: planes([1, 1, 1, 1]), se: planes([1, 1, 1, 1]) } };
    const st = aggregate(set, [run('nw', 9), quiet]);
    expect(st.firstMinute.active).toEqual({ depths: 1, surface: 0.5, sky: 0.5, orbit: 1 });
    expect(st.firstMinute.allPlanes).toBe(0.5);
    expect(st.firstMinute.slots[0]!.surface).toBe(2);
    expect(st.cross['collapse']).toEqual({ mean: 1, share: 1 });
    expect(st.cross['tunnel_breach']).toEqual({ mean: 0, share: 0 });
    expect(st.produced).toEqual({ trooper: 2 / 3, bomber: 1 / 3 });
    // All death shares use one denominator, including named environmental and unknown deaths.
    expect(st.kills['tank']).toBeCloseTo(1 / 11);
    expect(st.environmental).toEqual({ storm: 1 / 11, flood: 1 / 11 });
    expect(st.unattributed).toBeCloseTo(1 / 11);
    expect([...Object.values(st.kills), ...Object.values(st.environmental), st.unattributed].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // nw built more turrets (won 1 of 2), se more relays (won the other)
    expect(st.structureEdge['turret']).toEqual({ n: 2, wins: 1 });
    expect(st.structureEdge['relay']).toEqual({ n: 2, wins: 1 });
    expect(st.structureEdge['shaft']).toEqual({ n: 0, wins: 0 });
  });

  it('Spire damage per segment by origin and cause, sapper outcomes per entrant, unit mix per plane', () => {
    const swapped = run('se', 9, { entrants: [1, 0] });
    const mixed: MatchSummary = { ...run('nw', 9), produced: { nw: { trooper: 2, tank: 2, digger: 3 }, se: { trooper: 4, bomber: 1, digger: 1 } } };
    const st = aggregate(set, [mixed, swapped]);
    // Per match, all armies pooled: impacts and core drops stay separate causes.
    expect(st.spireDamage.surface).toEqual({ total: 1500, from: { depths: 400, surface: 300, sky: 0, orbit: 800, none: 0 }, by: { impact: 600, collapse: 400, tank: 300, core_drop: 200 } });
    expect(Object.keys(st.spireDamage.surface.by)).toEqual(['impact', 'collapse', 'tank', 'core_drop']);
    expect(st.spireDamage.orbit.total).toBe(100);
    expect(st.spireDamage.sky).toEqual({ total: 0, from: { depths: 0, surface: 0, sky: 0, orbit: 0, none: 0 }, by: {} });
    // Entrant 0 played nw, then se.
    expect(st.sappers[0]).toEqual(sapperRow({ ordered: 1.5, noTunnel: 0.5, rejected: 0.5, planted: 1.5, defused: 0.5, hit: 0.5, damage: 200, chasmOrdered: 0.5, chasmRejected: 0.5 }));
    expect(st.sappers[1]).toEqual(st.sappers[0]);
    // Production pooled per plane: surface 2 + 2 + 4 troopers/tanks and the swapped run's 2 troopers; the Sky one bomber per run.
    expect(st.mix.surface.produced).toBe(5);
    expect(st.mix.surface.entropy).toBeCloseTo(-(0.8 * Math.log2(0.8) + 0.2 * Math.log2(0.2)));
    expect(st.mix.surface.kinds).toBe(2);
    expect(st.mix.depths).toEqual({ produced: 2, entropy: 0, kinds: 1 });
    expect(st.mix.sky).toEqual({ produced: 1, entropy: 0, kinds: 1 });
    expect(st.mix.orbit).toEqual({ produced: 0, entropy: 0, kinds: 0 });
  });

  it('four-army FFA: wins, ranks and activity per slot; bias is the multinomial fit', () => {
    const ffa: Pick<RunSet, 'key' | 'kind' | 'title' | 'entrants' | 'layout'> = {
      key: 'ffa-probe-x-standard', kind: 'probe', title: 'x vs standard', layout: 'ffa',
      entrants: [{ level: 'standard', probe: 'x' }, { level: 'standard' }, { level: 'standard' }, { level: 'standard' }],
    };
    const armies: ArmyId[] = ['nw', 'ne', 'se', 'sw'];
    const four = (winner: ArmyId | 'draw', rotation: number, ranks: number[]): MatchSummary => {
      const trace: MatchTrace = {
        armies, ticks: s(15 * 60), samples: [{ minute: 3, units: Object.fromEntries(armies.map((a, i) => [a, planes([i, i, i, i])])) }],
        events: [
          ev(s(5), 'deliver', 'depths', 'nw'), ev(s(5), 'deliver', 'depths', 'ne'), ev(s(5), 'deliver', 'depths', 'se'), ev(s(5), 'deliver', 'depths', 'sw'),
          ev(s(30), 'constructed', 'surface', 'ne', { subject: 'turret' }),
          ev(s(90), 'kill', 'surface', 'sw', { subject: 'tank', by: 'trooper', killer: 'se' }),
        ],
        spireDamage: Object.fromEntries(armies.map((a) => [a, segments()])),
        sappers: Object.fromEntries(armies.map((a) => [a, sapperRow()])),
      };
      return summarize(trace, meta({
        entrants: armies.map((_, slot) => (slot - rotation + 4) % 4), winner, capped: false,
        rank: Object.fromEntries(armies.map((a, i) => [a, ranks[i]!])), spire: {},
      }));
    };
    // The probe (entrant 0) plays slot r in rotation r: wins on ne (r 1), loses elsewhere.
    const runs = [four('nw', 0, [1, 2, 3, 4]), four('ne', 1, [4, 1, 2, 3]), four('nw', 2, [1, 4, 2, 3]), four('se', 3, [3, 2, 1, 4])];
    const st = aggregate(ffa, runs);
    expect(st.slots).toEqual(armies);
    expect(st.slotWins).toEqual([2, 1, 1, 0]);
    expect(st.bias.p).toBe(uniformFit([2, 1, 1, 0]));
    expect(st.wins).toEqual([2, 0, 1, 1]);
    expect(st.aRate.p).toBe(0.5);
    expect(st.aBySlot).toEqual([{ n: 1, wins: 1 }, { n: 1, wins: 1 }, { n: 1, wins: 0 }, { n: 1, wins: 0 }]);
    expect(st.aRanks).toEqual([2, 1, 0, 1]);
    expect(st.aPlacement).toBe(2);
    expect(st.units['3']!.slots.map((u) => u.depths)).toEqual([0, 1, 2, 3]);
    expect(st.firstMinute.active.depths).toBe(1);
    expect(st.firstMinute.active.surface).toBe(0);
    // ne alone completed the most turrets in every match (and won one of the four).
    expect(st.structureEdge['turret']).toEqual({ n: 4, wins: 1 });
    expect(st.kills).toEqual({ trooper: 1 });
  });
});
