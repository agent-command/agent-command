// @module-tag timing — asserts a CPU-time budget; runs in the serial timing set (pnpm test:timing).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type BenchResult = { entities: number; entitiesAfter: number; cpuMs: number; procCpuMs: number; onCpu: number; wallMs: number; p95Ms: number; maxMs: number; trialCpuMs: number[] };
/** Run test/bench.ts outside the vitest module runner, whose import rewriting distorts hot-loop timings. */
function bench<T = BenchResult>(...args: string[]): T {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('./bench.ts', import.meta.url)), ...args], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop()!) as T;
}

describe('performance', () => {
  it('steps a ~600-entity battle in < 2 ms of sim-thread CPU per tick (plain Node, the server runtime)', () => {
    const r = bench('300');
    // Only the sim thread's CPU time is asserted; wall time, process CPU and the on-CPU share are information.
    console.log(
      `perf: ${r.entities} entities; best-trial sim-thread CPU ${r.cpuMs.toFixed(3)} ms/tick (trials ${r.trialCpuMs.map((m) => m.toFixed(3)).join(', ')}); ` +
        `info: process CPU ${r.procCpuMs.toFixed(3)} ms/tick, wall ${r.wallMs.toFixed(3)} ms (p95 ${r.p95Ms.toFixed(3)}, max ${r.maxMs.toFixed(3)}), on CPU ${(100 * r.onCpu).toFixed(0)}% of wall`,
    );
    expect(r.entities).toBeGreaterThanOrEqual(600);
    expect(r.entitiesAfter).toBeGreaterThanOrEqual(600);
    expect(r.cpuMs).toBeLessThan(2);
  });

  // Four armies at the same bodies per tile as two (density-equal four_corners fixture, same units per army). Profiled
  // at stage 1: no per-army loop over all entities and a flat vision stamp; every phase scales about linearly except
  // contact work (steering avoidance, acquisition), because in a four-way FFA three quarters of a unit's neighbours are
  // hostile instead of half and four streams cross the centre. So the budget asserts the invariants measured then:
  // the cost per unit-tick stays within 1.3× the duel's (measured ~1.2×), and the whole FFA fixture within 5 ms/tick
  // (measured ~4.6 ms; a four-army match weighs ~2.4 duels in admission, DESIGN §15.14).
  it('four armies at equal density: per-unit cost within 1.3× of two armies and at most 5 ms/tick (M64 four_corners)', () => {
    const duel = bench('200', 'ridges', 'duel4');
    const ffa = bench('200', 'ridges', 'ffa4');
    const perUnit = (ffa.cpuMs / ffa.entities) / (duel.cpuMs / duel.entities);
    console.log(`perf: four_corners duel ${duel.entities} entities ${duel.cpuMs.toFixed(3)} ms/tick; FFA ${ffa.entities} entities ${ffa.cpuMs.toFixed(3)} ms/tick; per-unit ratio ${perUnit.toFixed(2)}`);
    // Twice the armies' bodies (neutral islands/asteroids and the Spire segments aside, the plan is per army).
    expect(ffa.entities).toBeGreaterThanOrEqual(2 * duel.entities - 40);
    expect(perUnit).toBeLessThanOrEqual(1.3);
    expect(ffa.cpuMs).toBeLessThanOrEqual(5);
  });

  it('vision clear + stamp time is flat in the number of vision groups (bit-planes)', () => {
    const r = bench<{ groups: number[]; stampMs: number[] }>('200', 'ridges', 'vision');
    console.log(`perf: stampVision ${r.groups.map((g, i) => `G=${g} ${r.stampMs[i]!.toFixed(3)} ms`).join(', ')}`);
    // Same bodies, more groups: within timing noise of the two-group pass.
    for (const ms of r.stampMs) expect(ms).toBeLessThan(r.stampMs[0]! * 1.25);
  });
});
