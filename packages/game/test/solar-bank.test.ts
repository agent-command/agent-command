/**
 * Solar bank: solar above the delivery cap charges `energyBank` at `solarBankRate` up to `solarBankMax`, and the
 * bank discharges through the cap whenever solar is below it. Every check runs for both duel armies (point mirrors).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, TICK_RATE, type MatchOptions } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import type { Ent } from '../src/sim/ent.ts';

const DUEL = ['nw', 'se'] as const;
const R = DEFAULT_RULES.economy;
const steps = (g: AgentCommandGame, n: number): void => { for (let i = 0; i < n; i++) g.step(); };

/**
 * Arrays anchor at once and earn their full solarRate anywhere by day and nothing at night (no exposure ramp, distance
 * or shade: the array factors), so these checks measure light, cap and bank alone (as mechanics.test.ts does).
 */
const FLAT = { solarDeployTime: 0, solarRampStart: 1, solarFarFactor: 1, solarShadePer: 0, solarNight: 0 };

/** Spires and islands only, so no starting unit, upkeep or fallback income muddies the energy books. */
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 5, options: { terrain: 'open', ...options, orbit: { ...FLAT, ...options.orbit } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, 2);
  return g;
}

/** `n` stationary arrays per army, 10 tiles out at `bearing`; army 1 gets the point mirror of army 0's spots. */
function arrays(g: AgentCommandGame, n: number, bearing: number): Ent[][] {
  const s = g.sim;
  return [0, 1].map((army) => Array.from({ length: n }, () => {
    const e = s.spawnUnit(army, 'solar', 'orbit');
    const x = s.size / 2 + 10 * Math.cos(bearing), y = s.size / 2 + 10 * Math.sin(bearing);
    e.x = army === 0 ? x : s.size - x;
    e.y = army === 0 ? y : s.size - y;
    e.vx = e.vy = 0;
    e.order = { k: 'none' };
    return e;
  }));
}

describe('solar bank', () => {
  it('two arrays past the cap bank their surplus at solarBankRate, deliver only the cap, clamp at the max and discharge in the dark', () => {
    const g = arena();
    const s = g.sim;
    // Without the Sky segment the cap is the 1/s floor, so two lit arrays (4/s) run 3/s past it.
    for (const t of s.armies) t.spire.sky.hp = 0;
    const placed = arrays(g, 2, s.sunAngle);
    const surplus = 2 * R.solarRate - R.minimumEnergyCap;
    const ticks = 10 * TICK_RATE;
    steps(g, ticks);
    for (const [army, team] of DUEL.entries()) {
      const t = s.armies[army]!;
      expect(t.solar).toBe(2 * R.solarRate);
      expect(t.cap).toBe(R.minimumEnergyCap);
      expect(t.delivered).toBe(R.minimumEnergyCap);
      expect(t.energyBank).toBeCloseTo((ticks * surplus * R.solarBankRate) / TICK_RATE, 9);
      const res = g.observe({ team, role: 'orbit' }, 0).res;
      expect(res.energyBank).toBe(Math.floor(t.energyBank));
      expect(res.energyRate).toBe(R.minimumEnergyCap);
      expect(res.income.orbit.energy).toBe(R.minimumEnergyCap);
    }
    expect(s.armies[1]!.energyBank).toBe(s.armies[0]!.energyBank);

    for (const t of s.armies) t.energyBank = R.solarBankMax - 0.01;
    steps(g, 1);
    for (const t of s.armies) expect(t.energyBank).toBe(R.solarBankMax);

    // A quarter turn off the sun is dark for both mirrors: the bank tops delivery back up to the cap, never above.
    const dark = s.sunAngle + Math.PI / 2;
    placed.forEach((own, army) => own.forEach((e) => {
      const x = s.size / 2 + 10 * Math.cos(dark), y = s.size / 2 + 10 * Math.sin(dark);
      e.x = army === 0 ? x : s.size - x;
      e.y = army === 0 ? y : s.size - y;
    }));
    const energy = s.armies.map((t) => t.energy);
    steps(g, 1);
    for (const [army, team] of DUEL.entries()) {
      const t = s.armies[army]!;
      expect(t.solar).toBe(0);
      expect(t.delivered).toBe(R.minimumEnergyCap);
      expect(t.energyBank).toBeCloseTo(R.solarBankMax - R.minimumEnergyCap / TICK_RATE, 9);
      expect(t.energy - energy[army]!).toBeCloseTo(R.minimumEnergyCap / TICK_RATE, 9);
      expect(g.observe({ team, role: 'orbit' }, 0).res.income.orbit.energy).toBe(R.minimumEnergyCap);
    }
    // The last sliver drains exactly, then delivery stops.
    for (const t of s.armies) t.energyBank = 0.02;
    steps(g, 1);
    for (const t of s.armies) { expect(t.delivered).toBeCloseTo(0.02 * TICK_RATE, 9); expect(t.energyBank).toBe(0); }
    steps(g, 1);
    for (const t of s.armies) expect(t.delivered).toBe(0);
  });

  it('an array past the base cap raises energy delivered over day/night cycles, mostly through the bank', () => {
    // A 10 s day/night cycle keeps the scenario short; arrays stay put, so each is lit for part of every cycle.
    const ticks = 4 * 10 * TICK_RATE;
    const delivered = (n: number, economy: MatchOptions['economy'] = {}): number[] => {
      const g = arena({ orbit: { sunPeriod: 10 }, economy });
      arrays(g, n, g.sim.sunAngle + 0.3);
      let peak = 0;
      for (let i = 0; i < ticks; i++) {
        g.step();
        for (const t of g.sim.armies) peak = Math.max(peak, t.delivered);
      }
      expect(peak).toBeLessThanOrEqual(R.baseEnergyCap);
      const out = g.sim.armies.map((t) => t.stats.energyDelivered);
      expect(out[1]).toBe(out[0]);
      return out;
    };
    // `full` lit arrays fill the base cap (three, since the base cap is 6/s); one more runs past it by day.
    const full = Math.ceil(R.baseEnergyCap / R.solarRate);
    const filled = delivered(full)[0]!;
    const past = delivered(full + 1)[0]!;
    const wasted = delivered(full + 1, { solarBankRate: 0 })[0]!;
    expect(filled).toBeGreaterThan(0);
    // Without the bank, the extra array helps only while one of the others is dark (formation spread at wedge edges).
    expect(wasted).toBeGreaterThanOrEqual(filled);
    expect(past).toBeGreaterThan(wasted + 1);
  });
});
