/**
 * Guardrails from DESIGN §11.5 and §15.13 (and the §2 length target), evaluated on a sweep's run-set stats. `check`
 * exits non-zero when any fails. Sets a sweep did not run are skipped, not failed: a guardrail needs its evidence.
 */
import type { Opponent } from '@agent-command/game';
import type { Guardrail } from '@playerthree/bench';
import { LAYOUT_ARMIES, layoutArmies, type Layout, type RunSet } from './spec.ts';
import type { SetStats } from './metrics.ts';

export const GUARDRAILS: {
  /** Slot bias: per mirror, goodness of fit of decisive wins per slot against uniform; Bonferroni across mirrors. */
  biasAlpha: number;
  /** Veteran beats novice in a duel (both orientations pooled; draws are not wins). */
  veteranOverNovice: number;
  /** Median match length between equal bots, minutes: DESIGN §2 (10–15) for duels, §15.13 (12–20) for four-army FFA. */
  lengthBand: Readonly<Record<Layout, readonly [number, number]>>;
  /** Mirrors the length band applies to: novice bots are deliberately passive and run to the time cap. */
  lengthLevels: Readonly<Record<Layout, readonly Opponent[]>>;
  /** No forced strategy wins more than this multiple of the uniform share (1 / armies) against bots of its level. */
  probeShare: number;
} = {
  biasAlpha: 0.05,
  veteranOverNovice: 0.8,
  lengthBand: { duel: [10, 15], ffa: [12, 20] },
  lengthLevels: { duel: ['standard', 'veteran'], ffa: ['standard'] },
  probeShare: 1.3,
};

/** The probe ceiling of a layout: 65% in a duel, 32.5% in four-army FFA. */
export const probeMax = (layout: Layout): number => GUARDRAILS.probeShare / LAYOUT_ARMIES[layout];

/** The veteran-over-novice evidence: a pure duel ladder (no probe seats). */
const isVeteranOverNovice = (set: Pick<RunSet, 'kind' | 'layout' | 'entrants'>): boolean =>
  set.kind === 'ladder' && set.layout === 'duel' && set.entrants.length === 2 && set.entrants[0]!.level === 'veteran' &&
  set.entrants[1]!.level === 'novice' && !set.entrants.some((e) => e.probe || e.policies);

/**
 * The same thresholds expressed as data for the shared benchmark evaluator. Its aggregations include the two-sided
 * binomial but no multinomial test, so FFA slot bias is evaluated by `evaluate` only.
 */
export function benchGuardrails(sets: readonly RunSet[]): Guardrail[] {
  const mirrors = sets.filter((set) => set.kind === 'mirror');
  const alpha = GUARDRAILS.biasAlpha / Math.max(1, mirrors.length);
  const out: Guardrail[] = [];
  for (const set of mirrors) {
    if (LAYOUT_ARMIES[set.layout] !== 2) continue;
    out.push({ id: `slot_bias:${set.key}`, metric: 'outcome.win', scope: `team:${layoutArmies(set.layout)[0]}`, aggregation: 'binomialTwoSided', comparator: '>=', threshold: alpha });
  }
  for (const set of sets) {
    if (isVeteranOverNovice(set)) {
      out.push({ id: `veteran_over_novice:${set.key}`, metric: 'outcome.win', scope: 'entrant:A', aggregation: 'mean', comparator: '>=', threshold: GUARDRAILS.veteranOverNovice });
    }
  }
  for (const set of mirrors) {
    if (GUARDRAILS.lengthLevels[set.layout].includes(set.entrants[0]!.level)) {
      out.push({ id: `length_band:${set.key}`, metric: 'minutes', scope: 'match', aggregation: 'median', comparator: 'between', threshold: [...GUARDRAILS.lengthBand[set.layout]] });
    }
  }
  for (const set of sets) {
    if (set.kind === 'probe') out.push({ id: `probe_ceiling:${set.key}`, metric: 'outcome.win', scope: 'entrant:A', aggregation: 'mean', comparator: '<=', threshold: probeMax(set.layout) });
  }
  return out;
}

export interface GuardrailResult {
  id: 'slot_bias' | 'veteran_over_novice' | 'length_band' | 'probe_ceiling';
  /** run set it was evaluated on */
  set: string;
  pass: boolean;
  /** measured value, human-readable */
  value: string;
  /** threshold, human-readable */
  target: string;
}

const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`;
const min1 = (v: number): string => `${v.toFixed(1)} min`;

export function evaluate(sets: readonly SetStats[]): GuardrailResult[] {
  const out: GuardrailResult[] = [];
  const mirrors = sets.filter((s) => s.kind === 'mirror');
  const alpha = GUARDRAILS.biasAlpha / Math.max(1, mirrors.length);
  for (const s of mirrors) {
    out.push({
      id: 'slot_bias',
      set: s.key,
      pass: s.bias.p >= alpha,
      value: `${s.slots.map((army, i) => `${army} ${s.slotWins[i]}`).join(' · ')} (${s.draws} draws), p = ${s.bias.p.toFixed(3)}`,
      target: `p ≥ ${alpha.toFixed(4)} (α ${GUARDRAILS.biasAlpha} / ${mirrors.length} mirrors)`,
    });
  }
  for (const vn of sets) {
    if (!isVeteranOverNovice(vn)) continue;
    out.push({
      id: 'veteran_over_novice',
      set: vn.key,
      pass: vn.aRate.p >= GUARDRAILS.veteranOverNovice,
      value: `${pct(vn.aRate.p)} (${vn.wins[0]}/${vn.n}; 95% CI ${pct(vn.aRate.lo)}–${pct(vn.aRate.hi)})`,
      target: `≥ ${pct(GUARDRAILS.veteranOverNovice)}`,
    });
  }
  for (const s of mirrors) {
    if (!GUARDRAILS.lengthLevels[s.layout].includes(s.entrants[0]!.level)) continue;
    const [lo, hi] = GUARDRAILS.lengthBand[s.layout];
    out.push({
      id: 'length_band',
      set: s.key,
      pass: s.length.median >= lo && s.length.median <= hi,
      value: `median ${min1(s.length.median)} (p25–p75 ${s.length.p25.toFixed(1)}–${s.length.p75.toFixed(1)})`,
      target: `${lo}–${hi} min`,
    });
  }
  for (const s of sets) {
    if (s.kind !== 'probe') continue;
    const max = probeMax(s.layout);
    out.push({
      id: 'probe_ceiling',
      set: s.key,
      pass: s.aRate.p <= max,
      value: `${pct(s.aRate.p)} (${s.wins[0]}/${s.n}; 95% CI ${pct(s.aRate.lo)}–${pct(s.aRate.hi)})`,
      target: `≤ ${pct(max)}`,
    });
  }
  return out;
}
