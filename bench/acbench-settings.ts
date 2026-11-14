/** ACBench v1 defaults (`bench/acbench.config.ts` reads overrides from its environment; `bench/acbench.ts` from flags). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NO_HANDICAP } from '../packages/game/src/rules/match-rules.ts';
import type { Opponent } from '../packages/game/src/rules/opponents.ts';

/**
 * The ladder's rungs: a built-in bot tier at a public income handicap (rules.handicap.income on the rung's army).
 * Elite and Champion are the veteran bot earning 15 % and 30 % more ("cheater AI" rungs): headroom above the best public
 * bot without hidden code, and a copy of the public veteran meets a richer mirror of itself.
 */
const LADDER = {
  novice: { level: 'novice', income: NO_HANDICAP },
  standard: { level: 'standard', income: NO_HANDICAP },
  veteran: { level: 'veteran', income: NO_HANDICAP },
  elite: { level: 'veteran', income: 1.15 },
  champion: { level: 'veteran', income: 1.3 },
} as const satisfies Record<string, { level: Opponent; income: number }>;
export type Rung = keyof typeof LADDER;

export const ACBENCH = {
  id: 'acbench-v1', version: 1,
  /** Hex characters of the settings-and-build digest a suite id carries (`acbench-v1-<key>`). */
  suiteKeyChars: 12,
  /** The entrant whose four policies each run authors. */
  candidateId: 'candidate',
  runs: 5, minutes: 45, maxUsdPerRun: 10,
  /**
   * One seed per map: the 30 full-length scoring duels (3 maps × 5 rungs × 2 sides) take about 32 minutes on two cores
   * (63 s per duel at concurrency 2, measured with the starters on crown), plus as long again once per campaign for the
   * starters baseline.
   */
  maps: ['crossfire', 'twin_fords', 'crown'], seedsPerMap: 1,
  ladder: LADDER,
  /** The default roster: every rung, weakest first. */
  opponents: ['novice', 'standard', 'veteran', 'elite', 'champion'] as readonly Rung[],
  harness: 'opencode',
  opencode: join(homedir(), '.local/opencode-1.19.5/node_modules/opencode-linux-x64/bin/opencode'),
  /** Public held-out scoring seeds (disjoint from practice); a suite uses the first `seedsPerMap`. */
  scoringSeeds: [5101, 5202, 5303, 5404, 5505, 5606, 5707, 5808, 5909, 6010, 6111],
  practiceSeeds: [17, 29],
  /** Room for a reasoning model's thinking plus real policy code in one reply. */
  maxOutputTokens: 16_384,
  /** Safety ceilings only: the wall clock and the USD cap bind first. */
  maxTokens: 200_000_000, maxTurns: 20_000,
  /** Two scoring matches at once: the bench machine gives evaluation two cores. */
  concurrency: 2,
  /**
   * Scoring telemetry cadence, ticks (one game minute): every sample is a durable store write, and at the default one
   * second a full-length duel spent most of its wall time writing (173 s vs 95 s per bot duel at 30 s samples).
   */
  sampleEveryTicks: 1200,
} as const;
