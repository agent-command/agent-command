// @module-tag timing — a recorded four-army match replayed through the QuickJS sandbox under the real limits; serial timing set.
/**
 * The Depths starter's sandbox budget, the one check of it: functional tests give the sandbox FUNCTIONAL_TEST_MS_PER_CALL
 * (starter-policies.ts) so their behaviour never hangs on a loaded machine's timing. The default starter, in-process, plays
 * the nw Depths seat of a recorded four-army match on the wide C4 map; every observation is replayed in order through
 * BUDGET_RUNS fresh QuickJS instances under the manifest's real limits. Each instance answers exactly as the in-process
 * starter did, and each call's least sandbox CPU over the runs (load noise only ever adds) stays inside `msPerCall`.
 */
import type { BotCommander } from 'playerthree';
import { loadPolicy, type PolicyInstance } from 'playerthree/policy';
import { expect, it } from 'vitest';
import { definition } from '../src/agent/adapter.ts';
import type { AgentCommandManifest } from '../src/agent/manifest.ts';
import { DepthsBot } from '../src/bots/depths.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { starterPolicy } from '../src/bots/starter.ts';
import type { MatchData, Observation } from '../src/rules/contract.ts';
import { exactJson } from './bot-trace.ts';
import { FUNCTIONAL_LIMITS, STARTER_POLICIES } from './starter-policies.ts';

const SEED = 1;
const TICKS = 6000;
/** Fresh sandbox instances each observation is replayed through; a call's cost is its least CPU over them. */
const BUDGET_RUNS = 3;

it('the default Depths starter answers a wide four-army match exactly, every call inside the real sandbox budget', { timeout: 900_000 }, async () => {
  let matchData: MatchData | undefined;
  const obs: string[] = [], answers: string[] = [];
  const starter = starterPolicy(DepthsBot, 'depths', null);
  const recorder: BotCommander<AgentCommandManifest> = {
    init: (data) => { matchData = structuredClone(data) as MatchData; starter.init(data as MatchData); },
    think: (o) => { obs.push(JSON.stringify(o)); const out = starter.think(o as Observation); answers.push(exactJson(out)); return out; },
  };
  playBotMatch({
    seed: SEED, maxTicks: TICKS, options: { map: { params: { slots: 4, size: 64 } } },
    levels: { nw: 'standard', ne: 'standard', se: 'standard', sw: 'standard' }, seats: { nw: { depths: recorder } },
  });

  const limits = definition.manifest.control.policy!;
  // The runs themselves get the functional budget: a noisy call over msPerCall must not kill a run (and its state)
  // before the least of the runs is judged against the real one.
  const runs: PolicyInstance[] = [];
  for (let r = 0; r < BUDGET_RUNS; r++) {
    const loaded = await loadPolicy('js', STARTER_POLICIES.depths, FUNCTIONAL_LIMITS, { seed: SEED, matchData });
    if (!loaded.ok) throw new Error(`Depths starter load: ${loaded.error.code} ${loaded.error.message ?? ''}`);
    runs.push(loaded.instance);
  }
  const cpu: number[] = [];
  let diffs = 0;
  try {
    for (let i = 0; i < obs.length; i++) {
      let least = Infinity;
      for (const run of runs) {
        const r = await run.call(JSON.parse(obs[i]!) as Observation);
        if (!r.ok) throw new Error(`call ${i}: ${r.error.code} ${r.error.message ?? ''} after ${r.cpuMs ?? '?'} ms CPU`);
        least = Math.min(least, r.value.cpuMs);
        if (exactJson(r.value.intents) !== answers[i]) diffs++;
      }
      cpu.push(least);
    }
  } finally { for (const run of runs) run.dispose(); }
  const sorted = [...cpu].sort((a, b) => a - b);
  console.log(`Depths starter in QuickJS (C4, 64 cells): ${cpu.length} calls, median ${sorted[cpu.length >> 1]!.toFixed(2)} ms, p95 ${sorted[Math.floor(cpu.length * 0.95)]!.toFixed(2)} ms, max ${sorted.at(-1)!.toFixed(2)} ms CPU (least of ${BUDGET_RUNS}; msPerCall ${limits.msPerCall})`);
  expect(obs.length).toBeGreaterThan(0);
  expect(diffs).toBe(0);
  expect(sorted.at(-1)!).toBeLessThanOrEqual(limits.msPerCall);
});
