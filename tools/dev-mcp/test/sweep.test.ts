/** ac_sweep's N-entrant FFA sweep: slot orders, map setup, aggregation, and real matches on worker threads. */
import { describe, expect, it } from 'vitest';
import { slotOrders, sweep, sweepReport, sweepSetup, sweepStats, type SweepRun } from '../src/sweep.ts';

describe('FFA sweep', () => {
  it('plays each entrant on each slot once per seed (cyclic), every order (full) or the lineup only (none)', () => {
    expect(slotOrders(4, 'cyclic')).toEqual([[0, 1, 2, 3], [1, 2, 3, 0], [2, 3, 0, 1], [3, 0, 1, 2]]);
    for (const n of [2, 3, 4]) for (let slot = 0; slot < n; slot++) {
      expect(new Set(slotOrders(n, 'cyclic').map((order) => order[slot]))).toEqual(new Set(Array.from({ length: n }, (_, k) => k)));
    }
    const full = slotOrders(4, 'full');
    expect(full).toHaveLength(24);
    expect(new Set(full.map((order) => order.join(''))).size).toBe(24);
    expect(full[0]).toEqual([0, 1, 2, 3]);
    expect(slotOrders(2, 'cyclic')).toEqual([[0, 1], [1, 0]]);
    expect(slotOrders(3, 'none')).toEqual([[0, 1, 2]]);
  });

  it('sets up duels on the C2 diagonal and FFA on the four-slot layout of generated or authored maps', () => {
    expect(sweepSetup(2, { terrain: 'open' })).toEqual({ map: 'open', armies: ['nw', 'se'], options: { terrain: 'open', map: { params: { slots: 2 } } } });
    expect(sweepSetup(4, { terrain: 'open', rules: { spire: { timeCap: 60 } } })).toEqual({ map: 'open', armies: ['nw', 'ne', 'se', 'sw'], options: { spire: { timeCap: 60 }, terrain: 'open', map: { params: { slots: 4 } } } });
    expect(sweepSetup(3, { map: 'four_corners' })).toMatchObject({ map: 'four_corners', armies: ['nw', 'ne', 'se'], options: { map: { name: 'four_corners' } } });
    expect(sweepSetup(2, { map: 'four_corners' }).armies).toEqual(['nw', 'se']);
    expect(() => sweepSetup(4, { map: 'crown' })).toThrow(/no ffa layout/);
    expect(() => sweepSetup(5, {})).toThrow(/2–4 entrants/);
  });

  it('reports rank distributions, mean placement and per-slot win rates from the runs', () => {
    const run = (order: number[], ranks: number[]): SweepRun => ({ seed: 1, order, ranks, timeout: false, winner: ranks.filter((rank) => rank === 1).length === 1 ? ranks.indexOf(1) : null, ticks: 100, ms: 1 });
    const stats = sweepStats(['standard', 'novice', 'idle', 'idle'], ['nw', 'ne', 'se', 'sw'], 'open', [
      run([0, 1, 2, 3], [1, 2, 3, 4]),
      run([1, 2, 3, 0], [3, 2, 4, 1]),
      run([2, 3, 0, 1], [1, 1, 3, 3]),
      { seed: 2, order: [3, 0, 1, 2], ranks: [], timeout: true, winner: null, ticks: 300, ms: 1 },
    ]);
    expect(stats.perEntrant[0]).toEqual({ wins: 2, games: 3, ranks: [2, 0, 1, 0], meanPlacement: 5 / 3 });
    expect(stats.perEntrant[2]!.ranks).toEqual([1, 1, 1, 0]);
    expect(stats.perSlot).toEqual([{ army: 'nw', wins: 1, games: 3 }, { army: 'ne', wins: 0, games: 3 }, { army: 'se', wins: 0, games: 3 }, { army: 'sw', wins: 1, games: 3 }]);
    expect([stats.draws, stats.timeouts, stats.medianTicks]).toEqual([1, 1, 100]);
    expect(sweepReport(stats)).toContain('A standard: wins 2 (67%) · ranks 1:2 2:0 3:1 4:0 · mean placement 1.67');
  });

  // Four 60 s four-army matches (16 bots each) on worker threads: a few seconds idle, much longer on a loaded machine.
  it('plays a four-entrant FFA to the time cap and ranks every army', { timeout: 300_000 }, async () => {
    const stats = await sweep({ entrants: ['standard', 'idle', 'idle', 'idle'], seeds: [3], terrain: 'open', rules: { spire: { timeCap: 60 } } });
    expect(stats.runs.map((run) => run.order)).toEqual(slotOrders(4, 'cyclic'));
    expect(stats.timeouts).toBe(0);
    for (const run of stats.runs) {
      expect(run.ticks).toBe(1200);
      expect(run.ranks).toHaveLength(4);
      expect(run.ranks.every((rank) => rank >= 1 && rank <= 4)).toBe(true);
    }
    expect(stats.perEntrant.map((row) => row.games)).toEqual([4, 4, 4, 4]);
    expect(stats.perSlot.map((slot) => slot.games)).toEqual([4, 4, 4, 4]);
    expect(sweepReport(stats)).toMatch(/^4 entrants on open \(nw, ne, se, sw; 4 matches\)/);
  });
});
