/** Mother Lode crews: only the diggers a bot orders onto the lode mine it; every other miner keeps to veins and home ore. */
import { describe, expect, it } from 'vitest';
import { CELL, toTicks, type ArmyId, type MatchOptions } from '../src/rules/contract.ts';
import type { AgentCommandGame } from '../src/agent/adapter.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { TIERS } from '../src/bots/tuning.ts';

/** Sampled from the start: the lode is known from tick 0, often before any home ore, so the drift showed first there. */
const SAMPLE_EVERY = toTicks(5);
const LENGTH = toTicks(300);

/** Per army: diggers whose mining order targets a Mother Lode cell, and those mining ordinary ore. */
function census(g: AgentCommandGame, army: ArmyId): { lode: number; ore: number } {
  const s = g.sim;
  const a = s.armyIndex(army);
  let lode = 0;
  let ore = 0;
  for (const e of s.ents) {
    if (e.dead || e.side !== a || e.kind !== 'digger' || e.order.k !== 'mine' || e.order.ore < 0) continue;
    if (s.cells[e.order.ore] === CELL.lode) lode++;
    else if (s.cells[e.order.ore] === CELL.ore) ore++;
  }
  return { lode, ore };
}

function run(level: 'standard' | 'veteran', options: MatchOptions = {}): { most: number; lodeSeen: number; oreSeen: Record<string, number>; mirrored: boolean } {
  let most = 0;
  let lodeSeen = 0;
  let mirrored = true;
  const oreSeen: Record<string, number> = { nw: 0, se: 0 };
  playBotMatch({
    seed: 7, levels: { nw: level, se: level }, maxTicks: LENGTH, options,
    onTick: (g) => {
      if (g.tick % SAMPLE_EVERY !== 0) return;
      const nw = census(g, 'nw');
      const se = census(g, 'se');
      most = Math.max(most, nw.lode, se.lode);
      lodeSeen = Math.max(lodeSeen, nw.lode + se.lode);
      if (nw.lode !== se.lode || nw.ore !== se.ore) mirrored = false;
      oreSeen.nw = Math.max(oreSeen.nw!, nw.ore);
      oreSeen.se = Math.max(oreSeen.se!, se.ore);
    },
  });
  return { most, lodeSeen, oreSeen, mirrored };
}

describe('Mother Lode crews', () => {
  for (const level of ['standard', 'veteran'] as const) {
    it(`${level}: at most the tier's crew mines the lode; the rest keep mining ore (mirrored)`, () => {
      const r = run(level);
      expect(r.most, 'diggers on the lode per army').toBeLessThanOrEqual(TIERS[level].motherCrew);
      expect(r.lodeSeen, 'the crew does go').toBeGreaterThan(0);
      // The rest of the diggers mine ordinary ore (veins, home ore): far more of them than the crew.
      for (const army of ['nw', 'se']) expect(r.oreSeen[army], `${army} ore miners`).toBeGreaterThan(TIERS[level].motherCrew);
      expect(r.mirrored).toBe(true);
    }, 300_000);
  }

  // Green rich ore (and its moats) is richer generic work than the lode on seed 7, so it is off: this pins the rule alone.
  it('rules.depths.motherLodeAutoMine lets generic mining take the lode again: miners beyond the crew drift there', () => {
    expect(run('standard', { depths: { motherLodeAutoMine: true }, map: { params: { lavaLakes: { enabled: false }, richOre: { enabled: false } } } }).most).toBeGreaterThan(TIERS.standard.motherCrew);
  }, 300_000);
});
