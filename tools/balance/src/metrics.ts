/** Aggregate native game measurements into the balance report tables, per layout slot. */
import { CROSS, DAMAGE_ORIGINS, isStatKind, PLANES, SAPPER_FIELDS, STATS, STRUCTURE_KINDS, TICK_RATE, type ArmyId, type DamageOrigin, type MatchMeasurements, type MatchOptions, type Plane, type SapperMetrics } from '@agent-command/game';
import { layoutArmies, type EntrantSpec, type RunSet } from './spec.ts';
import { histogram, mean, quantile, uniformFit, wilson, type Interval } from './stats.ts';

const bump = (rec: Record<string, number>, key: string, n = 1): void => {
  rec[key] = (rec[key] ?? 0) + n;
};

// ---------------------------------------------------------------- one match

export interface ProbeHealth {
  calls: number;
  errors: number;
  timeouts: number;
  intents: number;
  rejected: number;
  /** rejected intents by closed code (`game:cannot_afford`, …) */
  codes: Record<string, number>;
}

export interface MatchMeta {
  set: string;
  seed: number;
  /** entrant index (into the run set's `entrants`) per layout slot, in slot order (`layoutArmies`) */
  entrants: number[];
  options?: MatchOptions;
  winner: ArmyId | 'draw';
  /** final rank per army (1 = winner; ties share a rank) as the host reported it */
  rank: Partial<Record<ArmyId, number>>;
  /** reached the game's time cap (decided on Spire HP) or the sweep's hard stop */
  capped: boolean;
  /** total Spire HP left per army */
  spire: Partial<Record<ArmyId, number>>;
  wallMs: number;
  /** probe policies' sandbox stats, summed over the seats they drive */
  probe?: ProbeHealth;
}

export interface MatchSummary extends MatchMeta, MatchMeasurements {}

// ---------------------------------------------------------------- one run set

export interface LengthStats {
  /** minutes */
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  min: number;
  max: number;
  /** match count per LENGTH_EDGES bucket */
  hist: number[];
}

/** Match length buckets (minutes): 0–5, 5–10, 10–15, 15–20, 20–25, 25–30, 30+ (time cap). */
export const LENGTH_EDGES = [0, 5, 10, 15, 20, 25, 30] as const;

export interface SlotAverages {
  /** matches that reached this minute */
  n: number;
  /** per layout slot */
  slots: Record<Plane, number>[];
}

/** Spire HP lost per match by one segment (mean), all armies pooled: in all, by plane of origin and by cause. */
export interface SegmentDamage {
  total: number;
  from: Record<DamageOrigin, number>;
  by: Record<string, number>;
}

/** Unit-mix diversity of one plane: its production by kind, all armies pooled. */
export interface PlaneMix {
  /** units produced per match (mean) */
  produced: number;
  /** Shannon entropy of the production shares by kind, in bits (0: a single kind) */
  entropy: number;
  /** kinds at ≥ MIX_SHARE of the plane's production */
  kinds: number;
}

/** A kind counts toward a plane's mix at this share of its production (phase acceptance: ≥ 2 such kinds per plane). */
export const MIX_SHARE = 0.15;

export interface SetStats {
  key: string;
  kind: RunSet['kind'];
  title: string;
  layout: RunSet['layout'];
  entrants: EntrantSpec[];
  options?: MatchOptions;
  /** army id per layout slot */
  slots: ArmyId[];
  n: number;
  /** wins per entrant */
  wins: number[];
  draws: number;
  capped: number;
  /** entrant 0's win rate over all matches (draws are not wins) */
  aRate: Interval;
  /** entrant 0 per layout slot: matches played there and won */
  aBySlot: { n: number; wins: number }[];
  /** entrant 0's finishing places: matches per rank (index 0 = rank 1), and the mean rank */
  aRanks: number[];
  aPlacement: number;
  /** decisive wins per layout slot */
  slotWins: number[];
  /** each slot's share of decisive matches, and the goodness-of-fit p against uniform (two slots: exact binomial at 0.5) */
  bias: { decisive: number; shares: Interval[]; p: number };
  length: LengthStats;
  /** units alive per plane (mean per slot) by sample minute */
  units: Record<string, SlotAverages>;
  firstMinute: {
    slots: Record<Plane, number>[];
    /** share of matches in which every army had ≥1 action on every plane */
    allPlanes: number;
    /** per plane: share of matches in which every army had ≥1 action there */
    active: Record<Plane, number>;
  };
  /** CROSS key → mean per match and share of matches with at least one */
  cross: Record<string, { mean: number; share: number }>;
  /** share of all units produced, by kind */
  produced: Record<string, number>;
  /** share of all deaths, by hostile killer kind / cause */
  kills: Record<string, number>;
  /** share of all deaths without a hostile killer, by named environmental/friendly cause */
  environmental: Record<string, number>;
  /** share of deaths without attribution */
  unattributed: number;
  /**
   * Per structure kind: matches in which one army completed more of it than every other, and how many of those it
   * won. Correlational (winners build more); forced-strategy probes are the causal measurement.
   */
  structureEdge: Record<string, { n: number; wins: number }>;
  /** per segment */
  spireDamage: Record<Plane, SegmentDamage>;
  /** per entrant: undermine intents and charge outcomes per match (mean), summed over the armies it played */
  sappers: SapperMetrics[];
  /** per plane */
  mix: Record<Plane, PlaneMix>;
  probe?: ProbeHealth;
  wallMs: { mean: number; total: number };
}

const minutes = (ticks: number): number => ticks / TICK_RATE / 60;

function shares(totals: Record<string, number>): Record<string, number> {
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(totals).sort((x, y) => y[1] - x[1])) out[k] = sum > 0 ? v / sum : 0;
  return out;
}

export function aggregate(set: Pick<RunSet, 'key' | 'kind' | 'title' | 'entrants' | 'layout' | 'options'>, runs: readonly MatchSummary[]): SetStats {
  const n = runs.length;
  const slots = layoutArmies(set.layout);
  const slotWins = slots.map((army) => runs.filter((r) => r.winner === army).length);
  const wins = set.entrants.map((_, entrant) => runs.filter((r) => r.winner !== 'draw' && r.entrants[slots.indexOf(r.winner)] === entrant).length);
  const aBySlot = slots.map((army, slot) => {
    const played = runs.filter((r) => r.entrants[slot] === 0);
    return { n: played.length, wins: played.filter((r) => r.winner === army).length };
  });
  const aRanks = slots.map(() => 0);
  const placements: number[] = [];
  for (const r of runs) {
    const rank = r.rank[slots[r.entrants.indexOf(0)]!];
    if (rank === undefined) continue;
    aRanks[rank - 1]!++;
    placements.push(rank);
  }
  const lengths = runs.map((r) => minutes(r.ticks));

  const units: Record<string, SlotAverages> = {};
  for (const minute of new Set(runs.flatMap((r) => Object.keys(r.units)))) {
    const reached = runs.filter((r) => r.units[minute]);
    units[minute] = {
      n: reached.length,
      slots: slots.map((army) => Object.fromEntries(PLANES.map((p) => [p, mean(reached.map((r) => r.units[minute]![army]![p]))])) as Record<Plane, number>),
    };
  }

  const firstSlots = slots.map((army) => Object.fromEntries(PLANES.map((p) => [p, mean(runs.map((r) => r.firstMinute[army]![p]))])) as Record<Plane, number>);
  const allActive = (r: MatchSummary, p: Plane): boolean => slots.every((army) => r.firstMinute[army]![p] > 0);
  const active = Object.fromEntries(PLANES.map((p) => [p, n ? runs.filter((r) => allActive(r, p)).length / n : 0])) as Record<Plane, number>;
  const allPlanes = n ? runs.filter((r) => PLANES.every((p) => allActive(r, p))).length / n : 0;

  const cross: SetStats['cross'] = {};
  for (const c of CROSS) {
    const xs = runs.map((r) => r.cross[c.key] ?? 0);
    cross[c.key] = { mean: n ? mean(xs) : 0, share: n ? xs.filter((x) => x > 0).length / n : 0 };
  }

  const producedTotals: Record<string, number> = {};
  const killTotals: Record<string, number> = {};
  const environmentTotals: Record<string, number> = {};
  let unattributed = 0;
  for (const r of runs) {
    for (const army of slots) {
      for (const [k, v] of Object.entries(r.produced[army]!)) bump(producedTotals, k, v);
      for (const [k, v] of Object.entries(r.kills[army]!)) bump(killTotals, k, v);
    }
    for (const [k, v] of Object.entries(r.environmental)) bump(environmentTotals, k, v);
    unattributed += r.unattributed;
  }
  const deaths = Object.values(killTotals).reduce((a, b) => a + b, 0) + Object.values(environmentTotals).reduce((a, b) => a + b, 0) + unattributed;

  const structureEdge: SetStats['structureEdge'] = {};
  for (const kind of STRUCTURE_KINDS) {
    if (kind === 'spire') continue;
    const edge = { n: 0, wins: 0 };
    for (const r of runs) {
      const counts = slots.map((army) => r.built[army]![kind] ?? 0);
      const most = Math.max(...counts);
      // A unique leader only: with two armies, exactly "one side built more than the other".
      if (counts.filter((c) => c === most).length !== 1) continue;
      edge.n++;
      if (r.winner === slots[counts.indexOf(most)]) edge.wins++;
    }
    structureEdge[kind] = edge;
  }

  const per = (total: number): number => (n ? total / n : 0);
  const spireDamage = Object.fromEntries(PLANES.map((plane) => {
    const from = Object.fromEntries(DAMAGE_ORIGINS.map((o) => [o, 0])) as Record<DamageOrigin, number>;
    const by: Record<string, number> = {};
    for (const r of runs) {
      for (const army of slots) {
        const d = r.spireDamage[army]![plane];
        for (const o of DAMAGE_ORIGINS) from[o] += d.from[o];
        for (const [cause, hp] of Object.entries(d.by)) bump(by, cause, hp);
      }
    }
    const total = DAMAGE_ORIGINS.reduce((a, o) => a + from[o], 0);
    return [plane, {
      total: per(total),
      from: Object.fromEntries(DAMAGE_ORIGINS.map((o) => [o, per(from[o])])) as Record<DamageOrigin, number>,
      by: Object.fromEntries(Object.entries(by).sort((x, y) => y[1] - x[1]).map(([cause, hp]) => [cause, per(hp)])),
    }];
  })) as Record<Plane, SegmentDamage>;

  const sappers = set.entrants.map((_, entrant) => {
    const row = {} as SapperMetrics;
    for (const field of SAPPER_FIELDS) row[field] = per(runs.reduce((a, r) => a + slots.reduce((b, army, slot) => b + (r.entrants[slot] === entrant ? r.sappers[army]![field] : 0), 0), 0));
    return row;
  });

  const mix = Object.fromEntries(PLANES.map((plane) => {
    const byKind = Object.entries(producedTotals).filter(([kind]) => isStatKind(kind) && STATS[kind].plane === plane).map(([, count]) => count);
    const units = byKind.reduce((a, b) => a + b, 0);
    const p = byKind.map((count) => count / units);
    return [plane, { produced: per(units), entropy: p.reduce((a, x) => a - x * Math.log2(x), 0), kinds: p.filter((x) => x >= MIX_SHARE).length }];
  })) as Record<Plane, PlaneMix>;

  let probe: ProbeHealth | undefined;
  for (const r of runs) {
    if (!r.probe) continue;
    probe ??= { calls: 0, errors: 0, timeouts: 0, intents: 0, rejected: 0, codes: {} };
    probe.calls += r.probe.calls;
    probe.errors += r.probe.errors;
    probe.timeouts += r.probe.timeouts;
    probe.intents += r.probe.intents;
    probe.rejected += r.probe.rejected;
    for (const [code, n] of Object.entries(r.probe.codes)) bump(probe.codes, code, n);
  }

  const decisive = slotWins.reduce((a, b) => a + b, 0);
  return {
    key: set.key,
    kind: set.kind,
    title: set.title,
    layout: set.layout,
    entrants: set.entrants,
    ...(set.options ? { options: set.options } : {}),
    slots,
    n,
    wins,
    draws: n - decisive,
    capped: runs.filter((r) => r.capped).length,
    aRate: wilson(wins[0]!, n),
    aBySlot,
    aRanks,
    aPlacement: placements.length ? mean(placements) : Number.NaN,
    slotWins,
    bias: { decisive, shares: slotWins.map((w) => wilson(w, decisive)), p: uniformFit(slotWins) },
    length: {
      median: quantile(lengths, 0.5),
      p10: quantile(lengths, 0.1),
      p25: quantile(lengths, 0.25),
      p75: quantile(lengths, 0.75),
      p90: quantile(lengths, 0.9),
      min: n ? Math.min(...lengths) : Number.NaN,
      max: n ? Math.max(...lengths) : Number.NaN,
      hist: histogram(lengths, LENGTH_EDGES),
    },
    units,
    firstMinute: { slots: firstSlots, allPlanes, active },
    cross,
    produced: shares(producedTotals),
    kills: Object.fromEntries(Object.entries(killTotals).map(([k, v]) => [k, deaths ? v / deaths : 0])),
    environmental: Object.fromEntries(Object.entries(environmentTotals).map(([k, v]) => [k, deaths ? v / deaths : 0])),
    unattributed: deaths ? unattributed / deaths : 0,
    structureEdge,
    spireDamage,
    sappers,
    mix,
    ...(probe ? { probe } : {}),
    wallMs: { mean: n ? mean(runs.map((r) => r.wallMs)) : 0, total: runs.reduce((a, r) => a + r.wallMs, 0) },
  };
}
