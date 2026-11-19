import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { ACBENCH } from '../../../bench/acbench-settings.ts';
import { evaluationBrief, ladderSeries, resolveLadderMatch } from '../../../bench/acbench-ladder.ts';
import { referencesEntry, type ScoredTier } from '../../../bench/acbench-reference-bots.ts';
import { MODELS, openRouter, wireOf, type FrontierModel } from '../../../bench/frontier-models.ts';
import type { AgentCommandGame } from '../../../packages/game/src/agent/adapter.ts';
import { playBotMatch } from '../../../packages/game/src/bots/play.ts';
import { DEFAULT_RULES, type MatchOptions } from '../../../packages/game/src/rules/contract.ts';
import type { ArmyId } from '../../../packages/game/src/rules/vocabulary.ts';

const spec = ladderSeries({ maps: ACBENCH.maps, seeds: ACBENCH.scoringSeeds.slice(0, ACBENCH.seedsPerMap), rungs: ACBENCH.opponents, gameDigest: 'a'.repeat(64),
  authoring: { practiceSeeds: [...ACBENCH.practiceSeeds], maxOutputTokens: ACBENCH.maxOutputTokens, maxWallMs: ACBENCH.minutes * 60_000 } });

/** Every trial's match as the series schedules it (each scenario × permutation over the template), ladder-resolved. */
const trials = spec.scenarios.flatMap(scenario => spec.permutations.map(permutation => {
  const bindings = spec.template.bindings.map(binding => ({ ...binding, entrantId: permutation.sideEntrants.find(side => side.team === binding.seat.team)!.entrantId }));
  const match = resolveLadderMatch({ ...spec.template, rulesHash: '', seed: scenario.seed, map: scenario.map, options: { ...spec.template.options, ...scenario.options }, bindings });
  const opponent = permutation.sideEntrants.find(side => side.entrantId !== ACBENCH.candidateId)!.entrantId;
  return { scenario: scenario.id, map: scenario.map.id, opponent, side: permutation.sideEntrants.find(side => side.entrantId === ACBENCH.candidateId)!.team, match };
}));

describe('ACBench v0.2 ladder', () => {
  it('plays every trial as its own game: the two sides of a pairing never share a seed', () => {
    expect(trials).toHaveLength(ACBENCH.maps.length * ACBENCH.seedsPerMap * ACBENCH.opponents.length * 2);
    // The sim is deterministic and an exact mirror: on one map and seed, the same pairing from either side is one game.
    const worlds = trials.map(t => JSON.stringify([t.map, t.match.seed, t.opponent]));
    expect(new Set(worlds).size).toBe(trials.length);
    // Side balance: every rung from both sides on every map, each side on its pair's own seed.
    for (const t of trials) {
      const pair = ACBENCH.scoringSeeds.find(p => p[0] === Number(t.scenario.slice(t.scenario.lastIndexOf('-') + 1)))!;
      expect(t.match.seed).toBe(t.side === 'nw' ? pair[0] : pair[1]);
    }
    expect(trials.filter(t => t.side === 'nw')).toHaveLength(trials.length / 2);
    const seeds = ACBENCH.scoringSeeds.flat();
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(seeds.filter(seed => (ACBENCH.practiceSeeds as readonly number[]).includes(seed))).toEqual([]);
  });

  it('re-resolves a resolved trial to the same seed and rules', () => {
    for (const { match } of trials) {
      const again = resolveLadderMatch(match);
      expect([again.seed, again.rulesHash]).toEqual([match.seed, match.rulesHash]);
    }
  });

  // A deterministic candidate (the built-in veteran bots) against the veteran rung, its mirror: each army's resources and
  // every unit's kind, plane and HP, every 100 ticks of the opening, candidate's army first.
  const opening = (seed: number, options: MatchOptions, candidate: ArmyId): string[] => {
    const rows: string[] = [];
    const army = (game: AgentCommandGame, team: ArmyId): string => {
      const index = game.sim.armyIndex(team), state = game.sim.armies[index]!;
      return `${state.alloy}/${state.energy}|${game.sim.ents.filter(e => e.side === index && !e.dead).map(e => `${e.kind}:${e.plane}:${e.hp}`).sort().join(',')}`;
    };
    const other: ArmyId = candidate === 'nw' ? 'se' : 'nw';
    playBotMatch({ seed, options, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: 2000,
      onTick: game => { if (game.tick % 100 === 0) rows.push(`${army(game, candidate)}#${army(game, other)}`); } });
    return rows;
  };
  it.each(ACBENCH.maps)('gives a deterministic candidate a different game from each side on %s', (map) => {
    const [nw, se] = (['nw', 'se'] as const).map(side => trials.find(t => t.map === map && t.opponent === 'veteran' && t.side === side)!.match);
    const options = nw!.options as MatchOptions;
    const fromNw = opening(nw!.seed, options, 'nw');
    // The v0.1 schedule (both sides on one seed) replays one game mirrored: the control that the fingerprint sees it.
    expect(opening(nw!.seed, options, 'se')).toEqual(fromNw);
    expect(opening(se!.seed, se!.options as MatchOptions, 'se')).not.toEqual(fromNw);
  }, 60_000);

  it('states the evaluation rules in the authoring brief, read from the series', () => {
    const brief = evaluationBrief(spec);
    expect(brief.length).toBeLessThanOrEqual(4096);
    expect(brief).toContain(`play ${trials.length} duels`);
    for (const map of ACBENCH.maps) expect(brief).toContain(map);
    expect(brief).toContain('both map sides (nw and se)');
    expect(brief).toContain('the built-in novice, standard, veteran bot(s) at normal income');
    expect(brief).toContain('elite (evaluation only: the veteran bot earning ×1.15 income');
    expect(brief).toContain('champion (evaluation only: the veteran bot earning ×1.3 income');
    expect(brief).toContain(`rules.spire.lossRule ${DEFAULT_RULES.spire.lossRule} (an army is out when its Surface segment falls; crowns are not used)`);
    expect(brief).toContain(`${DEFAULT_RULES.spire.timeCap / 60}-minute time cap the leader wins (most total Spire HP, then most contested-point score)`);
    expect(brief).toContain('win 1, draw ½, loss 0');
    // A series whose scenarios change a rule beyond the map would make the brief's "defaults" untrue.
    const crowns = { ...spec, scenarios: spec.scenarios.map(s => ({ ...s, options: { ...s.options, spire: { lossRule: 'crowns' } } })) };
    expect(() => evaluationBrief(crowns)).toThrow('changes rules beyond its map');
  });
});

describe('ACBench v0.2 campaign config', () => {
  it('briefs the authoring session with the evaluation rules of the series it scores, runs each model 3 times and caps a run at 40 USD', async () => {
    vi.stubEnv('ACBENCH_MODEL', 'gpt-6.1-sol');
    vi.stubEnv('ACBENCH_HARNESS', 'runner');
    // The config reads its settings from the environment as it loads: import it once they are set.
    const { default: config } = await import('../../../bench/acbench.config.ts');
    vi.unstubAllEnvs();
    const { authoring, ...series } = config.bench.spec;
    const { brief, systemPrompt, contextTokens, reasoning, ...settings } = authoring!;
    expect(brief).toBe(evaluationBrief({ ...series, authoring: settings }));
    // Every model's system prompt is the committed file verbatim; the suite publishes it with the file's SHA-256.
    const file = await readFile(new URL('../../../bench/acbench-system-prompt.txt', import.meta.url));
    expect(systemPrompt).toBe(file.toString('utf8'));
    expect(config.suite.authoring.systemPrompt).toEqual({ text: systemPrompt, digest: createHash('sha256').update(file).digest('hex') });
    // One compaction window for every model, published in the suite; every model's own window is larger.
    expect([contextTokens, config.suite.authoring.contextTokens]).toEqual([250_000, 250_000]);
    expect(config.bench.models!.candidate!.contextTokens).toBeGreaterThanOrEqual(250_000);
    for (const model of Object.values(MODELS)) expect(model.contextTokens).toBeGreaterThanOrEqual(ACBENCH.contextTokens);
    // One reasoning effort and one reply cap for every model, both in the suite (the cap through its series).
    expect([reasoning, config.suite.authoring.reasoning]).toEqual(['high', 'high']);
    expect(settings.maxOutputTokens).toBe(32_768);
    // Each model on its family's own wire, named in the profile: Claude Anthropic Messages, GPT Responses, the rest OpenRouter chat.
    expect(config.bench.models!.candidate).toMatchObject({ provider: 'openai', wire: 'responses' });
    expect(config.system).toMatchObject({ provider: 'openai', label: 'gpt-6.1-sol (via OpenRouter, responses wire)' });
    expect(Object.fromEntries(Object.keys(MODELS).map(id => [id, wireOf(id as FrontierModel)]))).toEqual({
      'claude-opus-5.5': 'messages', 'gemini-4-carbon': 'openrouter-chat', 'gpt-6.1-sol': 'responses', 'deepseek-v4.1-flash': 'openrouter-chat', 'kimi-k3.1-pro': 'openrouter-chat',
      'glm-5.3': 'openrouter-chat', 'qwen4-max': 'openrouter-chat', 'gpt-6.2-sol': 'responses', 'gpt-6.2-astra': 'responses', 'gpt-6-astra': 'responses',
    });
    expect(openRouter('claude-opus-5.5')).toMatchObject({ provider: 'anthropic', wire: 'messages', baseUrl: 'https://openrouter.ai/api' });
    expect(brief).toContain(`play ${config.suite.blocks.length * config.bench.spec.permutations.length} duels`);
    expect(brief).toContain('published beside every model\'s score as "Default starters"');
    expect(config.suite.version).toBe(2);
    expect([ACBENCH.runs, config.suite.authoring.replicates]).toEqual([3, 3]);
    expect([ACBENCH.maxUsdPerRun, config.suite.authoring.budgets.maxCostUsd]).toEqual([40, '40']);
  }, 60_000);
});

describe('ACBench reference bars', () => {
  const tier = (id: ScoredTier['tier'], score: number): ScoredTier => ({ tier: id, score, complete: true, trials: Array.from({ length: 30 }) });

  it('builds the release REFERENCES entry from every scored tier and the start baseline, strongest first', () => {
    const entry = referencesEntry([tier('novice', 0.4), tier('standard', 0.55), tier('veteran', 0.6), tier('elite', 0.7), tier('champion', 0.75), tier('starters', 0.3)], { start: 'skeleton', score: 0 });
    expect(entry.bars).toEqual([
      { id: 'champion', label: 'Champion bot (veteran, ×1.3 income)', score: 0.75 },
      { id: 'elite', label: 'Elite bot (veteran, ×1.15 income)', score: 0.7 },
      { id: 'veteran', label: 'Veteran bot', score: 0.6 },
      { id: 'standard', label: 'Standard bot', score: 0.55 },
      { id: 'novice', label: 'Novice bot', score: 0.4 },
      { id: 'starters', label: 'Default starters', score: 0.3 },
      { id: 'skeleton', label: 'Starting skeleton', score: 0 },
    ]);
    expect(entry.source).toBe('Each built-in tier\'s four bot packages and the four default starter policies (default knobs) played as the candidate on the same 30-game ladder, and the untouched skeleton policies every run starts from.');
  });

  it('refuses a version with a tier not completely scored', () => {
    expect(() => referencesEntry([tier('novice', 0.4), { ...tier('veteran', 0.6), complete: false }], null)).toThrow('not completely scored: veteran');
  });
});
