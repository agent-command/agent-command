/**
 * The ACBench ladder, shared by the campaign config (`bench/acbench.config.ts`), the start baseline and the re-score
 * (`bench/acbench-rescore.ts`): the bot rungs (a built-in tier at a public income handicap), the series every entrant
 * plays against them, the resolver that puts each rung's handicap on the army it plays, frozen-policy scoring without
 * model calls, and the trial scores read back from a results envelope.
 */
import { fileURLToPath } from 'node:url';
import { runBench, type BenchConfig, type MatchSpec, type ResultsEnvelope, type SeriesSpec } from '@playerthree/bench';
import { servedSkills, type PolicyArtifact } from 'playerthree';
import { buildStarter, parseStarterRef, starterCatalog } from 'playerthree/policy';
import { definition } from '../packages/game/src/agent/adapter.ts';
import { SKELETONS, STARTERS } from '../packages/game/src/agent/manifest.ts';
import { botVersion } from '../packages/game/src/bots/packages.ts';
import { resolveArenaMatch } from '../packages/game/src/lobby/arena.ts';
import { DEFAULT_TIME_CAP_TICKS, NO_HANDICAP, resolveRules, type MatchOptions } from '../packages/game/src/rules/contract.ts';
import { PLANES } from '../packages/game/src/rules/vocabulary.ts';
import { ACBENCH, type Rung, type SeedPair, type Start } from './acbench-settings.ts';
import { seriesSpec } from './series.ts';

/**
 * The sources a suite pins (`suite.build`): the game, its served skills (the start policies and everything a model
 * reads) and the bench code that defines the suite, and the PlayerThree checkout that actually runs (resolved through
 * the linked package, so worktrees pin the same source).
 */
export const BUILD = {
  game: { root: fileURLToPath(new URL('../', import.meta.url)), paths: ['packages/game/src', 'packages/game/skills', 'packages/game/package.json', 'pnpm-lock.yaml', 'bench/series.ts', 'bench/acbench.config.ts', 'bench/acbench-settings.ts', 'bench/acbench-ladder.ts', 'bench/frontier-models.ts'] },
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

/** Each scoring pair, by either of its seeds. */
const PAIRS: ReadonlyMap<number, SeedPair> = new Map(ACBENCH.scoringSeeds.flatMap((pair) => pair.map((seed) => [seed, pair] as const)));

/**
 * The match seed a trial plays: of its scoring pair (`ACBENCH.scoringSeeds`), the first seed when the candidate holds
 * the first side (nw), else the second. The sim is deterministic and an exact mirror, so with one seed a pairing's two
 * sides would replay one game mirrored; with its own seed each side is a game of its own. A seed of no pair, or a match
 * without the candidate, keeps its seed. A function of the pair and the side only, so re-resolving keeps it.
 */
export function ladderSeed(spec: MatchSpec): number {
  const pair = PAIRS.get(spec.seed);
  const side = spec.bindings.find((binding) => binding.entrantId === ACBENCH.candidateId)?.seat.team;
  if (!pair || side === undefined) return spec.seed;
  return side === spec.sides[0]!.id ? pair[0] : pair[1];
}

/**
 * The arena resolver with the ladder's handicaps and side seeds: each side's income multiplier (rules.handicap.income)
 * is its bound entrant's rung handicap, everyone else's none, and the match plays the candidate's side seed
 * (`ladderSeed`). Idempotent, so a resolved trial re-resolves to the same seed and rules hash.
 */
export function resolveLadderMatch(spec: MatchSpec): MatchSpec {
  const options = spec.options as MatchOptions;
  const income: Record<string, number> = { ...options.handicap?.income };
  for (const side of spec.sides) {
    const entrant = spec.bindings.find((binding) => binding.seat.team === side.id)?.entrantId ?? '';
    income[side.id] = isRung(entrant) ? ACBENCH.ladder[entrant].income : NO_HANDICAP;
  }
  return resolveArenaMatch({ ...spec, seed: ladderSeed(spec), options: { ...options, handicap: { ...options.handicap, income } } });
}

export interface LadderInput {
  /** Scoring seed pairs, each one of `ACBENCH.scoringSeeds` (the resolver plays the second from the other side). */
  maps: readonly string[]; seeds: readonly SeedPair[]; rungs: readonly Rung[]; gameDigest: string;
  budgets?: SeriesSpec['budgets']; authoring?: SeriesSpec['authoring'];
}
/**
 * The candidate against every rung from both duel sides on every map × seed pair, one scenario per map × pair (its seed
 * the pair's first; the trials where the candidate holds the other side play the second, see `ladderSeed`). Each
 * permutation is named `<opponent>-<side>`: the reference entrant the candidate meets (an id in `suite.references`) and
 * the map side (slot id, `nw`/`se`) the candidate plays, e.g. `veteran-se`.
 */
export function ladderSeries(input: LadderInput): SeriesSpec {
  const candidateId = ACBENCH.candidateId;
  for (const pair of input.seeds) if (PAIRS.get(pair[0]) !== PAIRS.get(pair[1]) || PAIRS.get(pair[0])?.[0] !== pair[0]) throw new Error(`seed pair ${pair.join('/')} is not one of ACBENCH.scoringSeeds`);
  const entrants: SeriesSpec['entrants'] = [
    { id: candidateId, label: 'Candidate', kind: 'agent', aiPlayer: true, botLevel: 'standard', stateResetSource: 'runner' },
    ...input.rungs.map((rung) => rungEntrant(rung, input.gameDigest)),
  ];
  const permutations = input.rungs.flatMap((rung) => [[candidateId, rung], [rung, candidateId]]);
  // One spec per map, merged: every scenario carries its own map and options; the first map's spec is the template.
  const perMap = input.maps.map((name) => seriesSpec({ track: 'policy', entrants, seeds: input.seeds.map((pair) => pair[0]), ticks: DEFAULT_TIME_CAP_TICKS + 1, options: { map: { name } }, layout: 'duel',
    permutations, policyRoles: { [candidateId]: [...PLANES] }, ...(input.budgets ? { budgets: input.budgets } : {}), ...(input.authoring ? { authoring: input.authoring } : {}),
    maxInfraRetries: 1, concurrency: ACBENCH.concurrency, sampleEveryTicks: ACBENCH.sampleEveryTicks }));
  return { ...perMap[0]!,
    permutations: perMap[0]!.permutations.map((permutation) => {
      const opponent = permutation.sideEntrants.find((side) => side.entrantId !== candidateId)!.entrantId;
      return { ...permutation, id: `${opponent}-${permutation.sideEntrants.find((side) => side.entrantId === candidateId)!.team}` };
    }),
    scenarios: perMap.flatMap((mapSpec, index) => mapSpec.scenarios.map((scenario) => ({ ...scenario, id: `${input.maps[index]}-seed-${scenario.seed}` }))) };
}

/**
 * The evaluation rules of a ladder series in a few sentences, for the authoring brief (`authoring.brief`): duels,
 * sides, maps, rungs with their handicaps, the elimination rule and time cap of the scenarios' resolved rules, and the
 * score. Read from the series itself, so the brief cannot drift from what is scored.
 */
export function evaluationBrief(spec: SeriesSpec): string {
  const candidateId = ACBENCH.candidateId;
  const maps = [...new Set(spec.scenarios.map((scenario) => scenario.map.id))];
  const sides = spec.template.sides.map((side) => side.id);
  const rungs = spec.entrants.filter((entrant) => entrant.id !== candidateId).map((entrant) => {
    if (!isRung(entrant.id)) throw new Error(`evaluationBrief: ${entrant.id} is not a ladder rung`);
    return { id: entrant.id, ...ACBENCH.ladder[entrant.id] };
  });
  const spires = spec.scenarios.map((scenario) => {
    const rules = resolveRules(scenario.options as MatchOptions);
    // The brief says "every rule at its default except the map": hold the scenarios to it.
    if (JSON.stringify(rules) !== JSON.stringify(resolveRules({ map: { name: scenario.map.id }, terrain: rules.terrain }))) throw new Error(`evaluationBrief: ${scenario.id} changes rules beyond its map`);
    return rules.spire;
  });
  const { lossRule, timeCap, crownsSurface, crownsSide, crownsToLose } = spires[0]!;
  if (spires.some((spire) => spire.lossRule !== lossRule || spire.timeCap !== timeCap)) throw new Error('evaluationBrief: scenarios differ in elimination rule or time cap');
  const plain = rungs.filter((rung) => rung.income === NO_HANDICAP).map((rung) => rung.id);
  const handicapped = rungs.filter((rung) => rung.income !== NO_HANDICAP);
  const elimination = lossRule === 'surface' ? 'an army is out when its Surface segment falls; crowns are not used'
    : `a fallen Surface segment costs ${crownsSurface} crowns, any other ${crownsSide}, and an army is out at ${crownsToLose}`;
  const tiebreak = lossRule === 'surface' ? 'most total Spire HP, then most contested-point score' : 'fewest crowns lost, then most total Spire HP, then most contested-point score';
  const games = spec.scenarios.length * spec.permutations.length * spec.repetitions;
  return [
    `EVALUATION (fixed by this benchmark). After the deadline your frozen policies play ${games} duels: every opponent below from both map sides (${sides.join(' and ')}) on ${maps.join(', ')}, ${spec.scenarios.length / maps.length} held-out seed(s) per map and side, never the practice seeds (${spec.authoring?.practiceSeeds.join(', ') ?? 'none'}).`,
    `Opponents: ${[plain.length ? `the built-in ${plain.join(', ')} bot(s) at normal income` : '', ...handicapped.map((rung) => `${rung.id} (evaluation only: the ${rung.level} bot earning ×${rung.income} income, match rule handicap.income on its army)`)].filter(Boolean).join('; ')}.`,
    `Rules: every match rule at its default except the map: rules.spire.lossRule ${lossRule} (${elimination}); at the ${timeCap / 60}-minute time cap the leader wins (${tiebreak}); a full tie is a draw.`,
    `Score: win 1, draw ½, loss 0, averaged over every duel. Practise under the same rules: options naming only the map ({map:{name}}), plus handicap.income on the opponent's army to rehearse ${handicapped.length ? handicapped.map((rung) => rung.id).join(' or ') : 'a handicap'}.`,
    'Reference: the built-in bot starters (topic starters), deployed unchanged at default knobs, play the same duels and are published beside every model\'s score as "Default starters".',
  ].join('\n');
}

/** Each start's policy per plane, as `policy_deploy {from}` names it (see `Start`). */
export const START_REFS: Readonly<Record<Start, Readonly<Record<string, string>>>> = { skeleton: SKELETONS, bots: STARTERS };

/**
 * A start's four policies exactly as `policy_deploy {from}` freezes them (default knobs), untouched: the baseline's
 * policies, what a run is scored from before the model changes anything.
 */
export async function startPolicies(start: Start): Promise<Record<string, PolicyArtifact>> {
  const catalog = starterCatalog(definition.manifest);
  const skills = servedSkills(definition.manifest);
  const policies: Record<string, PolicyArtifact> = {};
  for (const role of PLANES) {
    const from = START_REFS[start][role]!;
    const built = await buildStarter(parseStarterRef(catalog, from, undefined, role), skills);
    if (!built.ok) throw new Error(`starter ${from} does not build: ${built.message}`);
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
