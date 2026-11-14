// @module-tag timing — CPU-heavy short bot matches; run by pnpm test:quick (and test:timing), not the parallel default set.
/**
 * The quick lane (`pnpm test:quick`, about a minute): short versions of the invariants the long suites guard, run before
 * every "ready to merge". Equal bots play the opening minutes and must stay an exact mirror (duel) or orbit of four
 * (four armies) on every tick; the full matches stay in `test:mirrors`.
 *
 * Horizons are set by real catches: the Warden merge's Depths bot broke four_corners standard seeds 1 and 3 at ticks
 * 4651 and 4831, so the standard four-army runs cover five minutes.
 */
import { expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { playBotMatch } from '../src/bots/play.ts';
import type { TerrainPreset } from '../src/rules/contract.ts';
import type { MatchOptions } from '../src/rules/match-rules.ts';
import { toTicks } from '../src/rules/vocabulary.ts';
import { orbitAsymmetry } from './mirror.ts';

type Level = 'standard' | 'veteran';
const FOUR_ARMIES = ['nw', 'ne', 'se', 'sw'] as const;
const DUEL_ARMIES = ['nw', 'se'] as const;

function firstAsymmetry(seed: number, options: MatchOptions, level: Level, armies: readonly string[], ticks: number): string | undefined {
  let first: string | undefined;
  playBotMatch({
    seed, options, levels: Object.fromEntries(armies.map((army) => [army, level])), maxTicks: ticks,
    onTick: (g) => { first ??= orbitAsymmetry(g.sim); },
  });
  return first;
}

const FOUR_CORNERS: MatchOptions = { map: { name: 'four_corners' } };
const C4_S48: MatchOptions = { terrain: 'ridges', map: { seed: 1001, params: { size: 48, slots: 4 } } };
const CASES: readonly (readonly [label: string, seed: number, options: MatchOptions, level: Level, armies: readonly string[], seconds: number])[] = [
  ['four_corners', 1, FOUR_CORNERS, 'standard', FOUR_ARMIES, 300],
  ['four_corners', 3, FOUR_CORNERS, 'standard', FOUR_ARMIES, 300],
  ['generated C4 S48', 1001, C4_S48, 'standard', FOUR_ARMIES, 300],
  ['four_corners', 2, FOUR_CORNERS, 'veteran', FOUR_ARMIES, 150],
  ...([[1, 'ridges'], [2, 'canyons']] as [number, TerrainPreset][]).flatMap(([seed, terrain]) =>
    (['standard', 'veteran'] as const).map((level) => [`duel ${terrain}`, seed, { terrain }, level, DUEL_ARMIES, 300] as const)),
  // Equal income handicaps (rules.handicap.income) keep the duel an exact mirror.
  ['duel ridges, both armies at the champion handicap', 1, { terrain: 'ridges', handicap: { income: { nw: 1.3, se: 1.3 } } }, 'veteran', DUEL_ARMIES, 300],
];

for (const [label, seed, options, level, armies, seconds] of CASES) {
  it(`${label} ${level} seed ${seed}: equal bots stay exactly symmetric for ${seconds} s`, () => {
    expect(firstAsymmetry(seed, options, level, armies, toTicks(seconds))).toBeUndefined();
  });
}

it('the same seed and bots replay to the same state hashes', () => {
  const run = (): string[] => {
    const hashes: string[] = [];
    playBotMatch({ seed: 7, options: { terrain: 'ridges' }, levels: { nw: 'veteran', se: 'standard' }, maxTicks: toTicks(60), onTick: (g) => { if (g.tick % 200 === 0) hashes.push(g.stateHash()); } });
    return hashes;
  };
  const a = run();
  expect(a.length).toBeGreaterThan(0);
  expect(run()).toEqual(a);
  expect(createGame({ seed: 1 }).stateHash()).not.toBe(createGame({ seed: 2 }).stateHash());
});
