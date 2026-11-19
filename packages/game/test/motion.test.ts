// @module-tag timing — bounded bot matches near their wall timeout under load; serial timing set (pnpm test:timing).
/**
 * Smooth motion on the open planes (kinematics + ORCA avoidance + flow-field paths): in bounded bot matches, moving
 * units almost never reverse, zig-zag sideways or jump in speed from one tick to the next. A reversal or zig-zag is
 * counted only while the unit's goal stays the same (order, its target or point, and the engaged enemy): turning round
 * onto a newly acquired target behind it is a decision, not jitter.
 */
import { describe, expect, it } from 'vitest';
import { toTicks, type Opponent, type TerrainPreset } from '../src/rules/contract.ts';
import { playBotMatch } from '../src/bots/play.ts';
import type { Ent } from '../src/sim/ent.ts';

interface Rates {
  n: number;
  reversals: number;
  lateralFlips: number;
  speedJumps: number;
}

/** What a unit is heading for this tick: its order, the order's target or point, and the enemy it engages. */
const goalOf = (e: Ent): string => {
  const o = e.order;
  return `${o.k} ${'target' in o ? o.target : ''} ${'x' in o ? `${o.x},${o.y}` : ''} ${e.engage}`;
};

/** Per kind:state, over every open-plane unit moving ≥ 0.02 tiles/tick (≥ 0.4 tiles/s) on the previous tick. */
function measure(seed: number, level: Opponent, terrain: TerrainPreset, seconds: number): Record<string, Rates> {
  const prev = new Map<number, { x: number; y: number; dx: number; dy: number; lat: number; goal: string }>();
  const out: Record<string, Rates> = {};
  playBotMatch({
    seed,
    levels: { nw: level, se: level },
    options: { terrain },
    maxTicks: toTicks(seconds),
    onTick: (g) => {
      for (const e of g.sim.ents) {
        if (e.dead || !e.unit || e.plane === 'depths') {
          prev.delete(e.id);
          continue;
        }
        const p = prev.get(e.id);
        const dx = p ? e.x - p.x : 0;
        const dy = p ? e.y - p.y : 0;
        let lat = 0;
        const psp = p ? Math.hypot(p.dx, p.dy) : 0;
        const sp = Math.hypot(dx, dy);
        const goal = goalOf(e);
        if (p && psp > 0.02 && sp > 0) {
          const r = (out[`${e.kind}:${e.state}`] ??= { n: 0, reversals: 0, lateralFlips: 0, speedJumps: 0 });
          r.n++;
          const same = p.goal === goal;
          if (same && (dx * p.dx + dy * p.dy) / (sp * psp) < -0.2) r.reversals++;
          // Sideways component of this step relative to the last one; a sign flip between ticks is a zig-zag.
          lat = (p.dx * dy - p.dy * dx) / psp;
          if (same && Math.abs(lat) > 0.003 && Math.abs(p.lat) > 0.003 && Math.sign(lat) !== Math.sign(p.lat)) r.lateralFlips++;
          if (sp > psp * 1.6 || sp < psp * 0.4) r.speedJumps++;
        }
        prev.set(e.id, { x: e.x, y: e.y, dx, dy, lat, goal });
      }
    },
  });
  return out;
}

describe('motion smoothness (bounded bot matches)', () => {
  it('reversals stay under 0.5% and sideways zig-zags under 1% (2% while chasing a target) in every busy kind:state; speed jumps under 1% overall', () => {
    const all: Record<string, Rates> = {};
    for (const [seed, level, terrain] of [
      [7, 'standard', 'ridges'],
      [3, 'veteran', 'open'],
      [11, 'veteran', 'canyons'],
    ] as const) {
      for (const [k, r] of Object.entries(measure(seed, level, terrain, 180))) {
        const a = (all[k] ??= { n: 0, reversals: 0, lateralFlips: 0, speedJumps: 0 });
        a.n += r.n;
        a.reversals += r.reversals;
        a.lateralFlips += r.lateralFlips;
        a.speedJumps += r.speedJumps;
      }
    }
    let n = 0;
    let jumps = 0;
    for (const [k, r] of Object.entries(all)) {
      n += r.n;
      jumps += r.speedJumps;
      if (r.n < 1000) continue;
      expect(r.reversals / r.n, `${k} reversals`).toBeLessThan(0.005);
      // Units chasing a moving target in a melee still curve around each other more often.
      expect(r.lateralFlips / r.n, `${k} lateral flips`).toBeLessThan(k.endsWith(':attacking') ? 0.02 : 0.01);
    }
    expect(n).toBeGreaterThan(50_000);
    expect(jumps / n).toBeLessThan(0.01);
  }, 120_000);
});
