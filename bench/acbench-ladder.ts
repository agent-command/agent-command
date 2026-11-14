/**
 * The ACBench ladder, shared by the campaign config (`bench/acbench.config.ts`), the starters baseline and the re-score
 * (`bench/acbench-rescore.ts`): the bot rungs (a built-in tier at a public income handicap), the series every entrant
 * plays against them, the resolver that puts each rung's handicap on the army it plays, frozen-policy scoring without
 * model calls, and the trial scores read back from a results envelope.
 */
import { fileURLToPath } from 'node:url';
import { runBench, type BenchConfig, type MatchSpec, type ResultsEnvelope, type SeriesSpec } from '@playerthree/bench';
import { servedSkills, type PolicyArtifact } from 'playerthree';
import { buildStarter, parseStarterRef, starterCatalog } from 'playerthree/policy';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { STARTERS } from '../packages/game/src/agent/manifest.ts';
import { botVersion } from '../packages/game/src/bots/packages.ts';
import { resolveArenaMatch } from '../packages/game/src/lobby/arena.ts';
import { DEFAULT_TIME_CAP_TICKS, NO_HANDICAP, type MatchOptions } from '../packages/game/src/rules/contract.ts';
import { PLANES } from '../packages/game/src/rules/vocabulary.ts';
import { ACBENCH, type Rung } from './acbench-settings.ts';
import { seriesSpec } from './series.ts';

/**
 * The sources a suite pins (`suite.build`): the game with the bench code that defines the suite, and the PlayerThree
 * checkout that actually runs (resolved through the linked package, so worktrees pin the same source).
 */
export const BUILD = {
  game: { root: fileURLToPath(new URL('../', import.meta.url)), paths: ['packages/game/src', 'packages/game/package.json', 'pnpm-lock.yaml', 'bench/series.ts', 'bench/acbench.config.ts', 'bench/acbench-settings.ts', 'bench/acbench-ladder.ts', 'bench/frontier-models.ts'] },
  runner: { root: fileURLToPath(new URL('../../../', import.meta.resolve('@playerthree/bench'))), paths: ['packages/bench/src', 'packages/playerthree/src', 'packages/runner/src', 'packages/runner/bin', 'packages/bench/package.json', 'packages/playerthree/package.json', 'packages/runner/package.json', 'pnpm-lock.yaml'] },
};

export const isRung = (id: string): id is Rung => Object.hasOwn(ACBENCH.ladder, id);

/** A rung's entrant card: its tier's bot packages plus its handicap, so the reference digest names both. */
export function rungEntrant(rung: Rung, gameDigest: string): SeriesSpec['entrants'][number] {
  const { level, income } = ACBENCH.ladder[rung];
  const version = botVersion(definition.manifest, level);
  return { id: rung, label: income === NO_HANDICAP ? level : `${rung} (${level}, ×${income} income)`, kind: 'bot', aiPlayer: true, botLevel: level,
    botVersion: `${version ?? level}${income === NO_HANDICAP ? '' : `+income:${income}`}+sha256:${gameDigest}`, stateResetSource: 'runner' };
}

/**
 * The arena resolver with the ladder's handicaps: each side's income multiplier (rules.handicap.income) is its bound
 * entrant's rung handicap, everyone else's none. Idempotent, so a resolved trial re-resolves to the same rules hash.
 */
export function resolveLadderMatch(spec: MatchSpec): MatchSpec {
  const options = spec.options as MatchOptions;
  const income: Record<string, number> = { ...options.handicap?.income };
  for (const side of spec.sides) {
    const entrant = spec.bindings.find((binding) => binding.seat.team === side.id)?.entrantId ?? '';
    income[side.id] = isRung(entrant) ? ACBENCH.ladder[entrant].income : NO_HANDICAP;
  }
  return resolveArenaMatch({ ...spec, options: { ...options, handicap: { ...options.handicap, income } } });
}

export interface LadderInput {
  maps: readonly string[]; seeds: readonly number[]; rungs: readonly Rung[]; gameDigest: string;
  budgets?: SeriesSpec['budgets']; authoring?: SeriesSpec['authoring'];
}
/** The candidate against every rung from both duel sides on every map × seed, one scenario per map × seed. */
export function ladderSeries(input: LadderInput): SeriesSpec {
  const candidateId = ACBENCH.candidateId;
  const entrants: SeriesSpec['entrants'] = [
    { id: candidateId, label: 'Candidate', kind: 'agent', aiPlayer: true, botLevel: 'standard', stateResetSource: 'runner' },
    ...input.rungs.map((rung) => rungEntrant(rung, input.gameDigest)),
  ];
  const permutations = input.rungs.flatMap((rung) => [[candidateId, rung], [rung, candidateId]]);
  // One spec per map, merged: every scenario carries its own map and options; the first map's spec is the template.
  const perMap = input.maps.map((name) => seriesSpec({ track: 'policy', entrants, seeds: input.seeds, ticks: DEFAULT_TIME_CAP_TICKS + 1, options: { map: { name } }, layout: 'duel',
    permutations, policyRoles: { [candidateId]: [...PLANES] }, ...(input.budgets ? { budgets: input.budgets } : {}), ...(input.authoring ? { authoring: input.authoring } : {}),
    maxInfraRetries: 1, concurrency: ACBENCH.concurrency, sampleEveryTicks: ACBENCH.sampleEveryTicks }));
  return { ...perMap[0]!, scenarios: perMap.flatMap((mapSpec, index) => mapSpec.scenarios.map((scenario) => ({ ...scenario, id: `${input.maps[index]}-seed-${scenario.seed}` }))) };
}

/** The four default starters exactly as `policy_deploy {from}` freezes them (default knobs): the baseline's policies. */
export async function starterPolicies(): Promise<Record<string, PolicyArtifact>> {
  const catalog = starterCatalog(definition.manifest);
  const skills = servedSkills(definition.manifest);
  const policies: Record<string, PolicyArtifact> = {};
  for (const role of PLANES) {
    const built = await buildStarter(parseStarterRef(catalog, STARTERS[role], undefined, role), skills);
    if (!built.ok) throw new Error(`starter ${STARTERS[role]} does not build: ${built.message}`);
    policies[role] = { runtime: 'js', code: built.code };
  }
  return policies;
}

/** Scores frozen candidate policies on `spec` (no model, no tokens); results go to `outDir`. */
export function scoreFrozen(spec: SeriesSpec, policies: Record<string, PolicyArtifact>, outDir: string, signal?: AbortSignal): Promise<ResultsEnvelope> {
  const { authoring: _authoring, ...evaluation } = spec;
  const config: BenchConfig = { definition, resolve: resolveLadderMatch, spec: { ...evaluation, budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null } }, policies: { [ACBENCH.candidateId]: policies } };
  return runBench(config, { outDir, ...(signal ? { signal } : {}) });
}

export interface TrialScore {
  trialId: string; map: string; seed: number; opponent: string; side: string;
  status: 'win' | 'draw' | 'timeout' | 'loss' | 'forfeit' | 'incomplete'; score: number | null;
  simulatedSeconds: number | null; wallMs: number | null;
}
/** The candidate's result per trial, scored as the PlayerThree campaign scores it: win 1, draw or timeout ½, loss 0. */
export function trialScores(results: ResultsEnvelope): TrialScore[] {
  const candidateId = ACBENCH.candidateId;
  return results.tables.schedule.map((trial) => {
    const attempts = results.tables.matches.filter((match) => match.trialId === trial.trialId);
    const accepted = attempts.find((match) => match.acceptedAttempt);
    const side = trial.sideBindings.find((binding) => binding.entrantId === candidateId)!.team;
    const outcome = accepted?.outcomes.find((row) => row.team === side)?.outcome;
    const status: TrialScore['status'] = !results.completeness.rawComplete ? 'incomplete'
      : outcome === 'win' ? 'win' : outcome === 'draw' ? 'draw' : outcome === 'loss' ? accepted?.status === 'forfeit' ? 'forfeit' : 'loss'
      : attempts.at(-1)?.terminalReason === 'tick_limit' ? 'timeout' : 'incomplete';
    return { trialId: trial.trialId, map: trial.mapId, seed: trial.seed, opponent: trial.sideBindings.find((binding) => binding.entrantId !== candidateId)!.entrantId, side, status,
      score: status === 'win' ? 1 : status === 'draw' || status === 'timeout' ? 0.5 : status === 'incomplete' ? null : 0,
      simulatedSeconds: accepted ? Math.round(accepted.simulatedMs / 1000) : null, wallMs: accepted?.wallMs == null ? null : Math.round(accepted.wallMs) };
  });
}
