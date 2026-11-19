/** ACBench v1 defaults (`bench/acbench.config.ts` reads overrides from its environment; `bench/acbench.ts` from flags). */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReasoningEffort } from 'playerthree/arena';
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
/**
 * What every run starts from, deployed by reference on each plane before the clock: `skeleton`, the economy-only
 * skeletons (`policies/skeleton/<plane>.js`, no army, attacks or research; they score about 0, so every point is the
 * model's own work), or `bots`, the built-in bot starters (`policies/<plane>.js`, the pilot's start).
 */
export const STARTS = ['skeleton', 'bots'] as const;
export type Start = typeof STARTS[number];
export const isStart = (value: string): value is Start => (STARTS as readonly string[]).includes(value);
/** A scoring scenario's two match seeds: the first for the candidate on the first side (nw), the second on the other. */
export type SeedPair = readonly [number, number];

export const ACBENCH = {
  /**
   * Suite design version: 2 (ACBench v0.2) states the evaluation rules in the authoring brief, gives each side of a
   * pairing its own seed and gives every model the same system prompt (bench/acbench-system-prompt.txt); 1 was v0.1.
   */
  id: 'acbench-v1', version: 2,
  /** Hex characters of the settings-and-build digest a suite id carries (`acbench-v1-<key>`). */
  suiteKeyChars: 12,
  /** The entrant whose four policies each run authors. */
  candidateId: 'candidate',
  /** Three runs per model by default: a run-to-run spread, at three times one run's authoring cap and scoring time. */
  runs: 3, minutes: 45, maxUsdPerRun: 40, start: 'skeleton' as Start,
  /**
   * One seed pair per map: the 30 full-length scoring duels (3 maps × 5 rungs × 2 sides) take about 32 minutes on two
   * cores (63 s per duel at concurrency 2, measured with the bot starters on crown), plus at most as long again once per
   * campaign for the start baseline.
   */
  maps: ['crossfire', 'twin_fords', 'crown'], seedsPerMap: 1,
  ladder: LADDER,
  /** The default roster: every rung, weakest first. */
  opponents: ['novice', 'standard', 'veteran', 'elite', 'champion'] as readonly Rung[],
  harness: 'opencode',
  opencode: join(homedir(), '.local/opencode-1.19.5/node_modules/opencode-linux-x64/bin/opencode'),
  /**
   * Public held-out scoring seed pairs (disjoint from practice); a suite uses the first `seedsPerMap` pairs per map. The
   * sim is deterministic and an exact mirror, so one seed would make a pairing's two sides one game played twice: the
   * candidate plays a pair's first seed from the first side (nw) and its second seed from the other (`ladderSeed`).
   */
  scoringSeeds: [[5101, 5202], [5303, 5404], [5505, 5606], [5707, 5808], [5909, 6010], [6111, 6212]] as readonly SeedPair[],
  practiceSeeds: [17, 29],
  /**
   * One reply's output cap, every model: room for high-effort thinking plus real policy code in one reply (on most
   * routes it covers thinking and the visible reply together). 16,384 left a high-effort turn that writes a module little
   * room; omp's auth-gateway itself gives Claude 16,384 more at effort high.
   */
  maxOutputTokens: 32_768,
  /**
   * The one reasoning effort every authoring request asks for (`authoring.reasoning`). Without it each route picks its
   * own: omp's auth-gateway ran Claude at effort low, Anthropic via OpenRouter at the API default, Codex at its own.
   */
  reasoning: 'high' as ReasoningEffort,
  /**
   * The one context window every model's OpenCode session is compacted against (`authoring.contextTokens`, capped at a
   * model's own; every v0.2 model's is about 1M): about where StarSkirmish compacts every harness. Per-model windows
   * made a model that filled its context faster be summarized, and told it may stop, more often.
   */
  contextTokens: 250_000,
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
