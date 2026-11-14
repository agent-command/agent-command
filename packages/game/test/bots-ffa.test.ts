// @module-tag timing — full four-army bot matches; serial timing set (pnpm test:timing, test:mirrors).
import { expect, it } from 'vitest';
import { playBotMatch } from '../src/bots/play.ts';
import type { TerrainPreset } from '../src/rules/contract.ts';
import { orbitAsymmetry } from './mirror.ts';

const FOUR_CORNERS = { map: { name: 'four_corners' } } as const;

// Equal bots in a C4 layout play an exact orbit of four (DESIGN §15.4): checked every tick. AC_EXTENDED_MIRRORS adds
// seeds and the veteran tier and plays to the end. Seed 3 once lost the orbit to a portal step mid-update: a trooper
// that dropped into a hole vanished from the targeting of units later in the entity order, not of their twins.
const extended = !!process.env.AC_EXTENDED_MIRRORS;
const LEVELS = extended ? ['standard', 'veteran'] as const : ['standard'] as const;
for (const level of LEVELS) {
  for (const seed of extended ? [1, 2, 3] : [1, 3]) {
    it(`four_corners ${level} seed ${seed}: four equal bots stay an exact orbit of four every tick`, { tags: ['timing'], timeout: 600_000 }, () => {
      let first: string | undefined;
      playBotMatch({
        seed, options: FOUR_CORNERS, levels: { nw: level, ne: level, se: level, sw: level },
        maxTicks: extended ? undefined : 6000,
        onTick: (g) => { first ??= orbitAsymmetry(g.sim); },
      });
      expect(first).toBeUndefined();
    });
  }
}

// Generated four-slot maps at every size keep the orbit too. They broke when observations carried 2-decimal positions
// (48 − 13.9 ≠ 34.1 in binary floats, so mirrored bots disagreed at thresholds: the reduced FFA sweep's S48 mirror
// split at tick 841) and when portal steps and breaches landed mid-update (units later in the entity order reacted
// before their twins); L80 seed 1002 split at tick 5701 before both fixes.
const GENERATED: [size: number, seed: number, terrain: TerrainPreset][] = [[48, 1001, 'ridges'], [64, 1002, 'ridges'], [80, 1002, 'ridges']];
for (const level of LEVELS) {
  for (const [size, seed, terrain] of GENERATED) {
    it(`generated C4 S${size} ${terrain} ${level} seed ${seed}: four equal bots stay an exact orbit of four every tick`, { tags: ['timing'], timeout: 600_000 }, () => {
      let first: string | undefined;
      playBotMatch({
        seed, options: { terrain, map: { seed, params: { size, slots: 4 } } }, levels: { nw: level, ne: level, se: level, sw: level },
        maxTicks: extended ? undefined : 6000,
        onTick: (g) => { first ??= orbitAsymmetry(g.sim); },
      });
      expect(first).toBeUndefined();
    });
  }
}

// A full FFA to a single winner by elimination: a veteran against three idle armies on a generated S48 four-slot map
// re-focuses after each elimination and takes them out one by one (on M64 four_corners, and among closer tiers, the
// 30-minute cap arrives first; the FFA length band is measured by the balance sweeps).
it('a veteran FFA on a generated S48 four-slot map plays to a single winner with ranks 1–4, eliminated in rank order', { tags: ['timing'], timeout: 600_000 }, () => {
  const eliminated: string[] = [];
  // Public events reach every army, eliminated or not: read nw's since the last tick read.
  let since = -1;
  const r = playBotMatch({
    seed: 1, options: { map: { seed: 1, params: { slots: 4 } } }, levels: { nw: 'veteran', ne: 'idle', se: 'idle', sw: 'idle' },
    onTick: (g) => {
      for (const ev of g.observe({ team: 'nw', role: 'surface' }, since).events) {
        if (ev.kind === 'army_eliminated' && ev.side && !eliminated.includes(ev.side)) eliminated.push(ev.side);
      }
      since = g.tick;
    },
  });
  expect(r.game.sim.result).not.toBeNull();
  expect(Object.values(r.outcome).filter((o) => o === 'win')).toHaveLength(1);
  expect(Object.values(r.rank).sort()).toEqual([1, 2, 3, 4]);
  // Three eliminations, last place first; the winner is the one left.
  expect(eliminated).toHaveLength(3);
  expect(eliminated.map((id) => r.rank[id as keyof typeof r.rank])).toEqual([4, 3, 2]);
});
