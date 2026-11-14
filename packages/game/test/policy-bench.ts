/**
 * Serialized timing-set benchmark of the Depths starter (skill policies/depths.js, default knobs). Real QuickJS
 * sandbox, unchanged manifest limits, no test-runner transform.
 * node test/policy-bench.ts [alternate built Depths policy script path] [extra JSON observation trace]
 * The same observations feed either script; returned intents are measured, not applied to this trace.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadPolicy } from 'playerthree/policy';
import { validate } from 'playerthree/schema';
import { createGame } from '../src/agent/adapter.ts';
import { manifest } from '../src/agent/manifest.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { matchDataSchema, type MatchData } from '../src/rules/contract.ts';

const script = process.argv[2];
const source = script ? await readFile(script, 'utf8') : STARTER_POLICIES.depths;
const open = createGame({ seed: 3 });
for (let i = 0; i < 3; i++) open.sim.spawnUnit(open.sim.armyIndex('nw'), 'sapper', 'depths');
const observation = open.observe({ team: 'nw', role: 'depths' }, 0);
observation.depths!.fill(4);
observation.mandate.limits = { collapses: false };
const fixtures = Array.from({ length: 50 }, (_, i) => JSON.stringify({ ...observation, tick: 4800 + i * 10 }));
const match: string[] = [];
const { game: matchGame } = playBotMatch({
  seed: 21, levels: { nw: 'standard', se: 'novice' }, maxTicks: 10000,
  onTick: (game) => {
    if (game.tick % 20 === 0) match.push(JSON.stringify(game.observe({ team: 'nw', role: 'depths' }, game.tick - 20)));
  },
});

const seat = { team: 'nw', role: 'depths' } as const;
const traces: [string, MatchData, string[]][] = [
  ['open-cavern', open.matchData(seat), fixtures],
  ['match', matchGame.matchData(seat), match],
];
if (process.argv[3]) {
  const extra: unknown = JSON.parse(await readFile(process.argv[3], 'utf8'));
  if (!extra || typeof extra !== 'object' || !('matchData' in extra) || !('observations' in extra)
    || !validate(matchDataSchema, extra.matchData).ok || !Array.isArray(extra.observations)
    || !extra.observations.every((json: unknown) => typeof json === 'string')) {
    throw new Error('extra trace must contain matchData and an observations array of serialized dynamic observations');
  }
  const trace = extra as { matchData: MatchData; observations: string[] };
  traces.push(['extra', trace.matchData, trace.observations]);
}
for (const [name, matchData, samples] of traces) {
  let loaded = await loadPolicy('js', source, manifest.control.policy, { seed: 1, matchData });
  const times: number[] = [];
  /** Sandbox-thread CPU per call: the quantity msPerCall budgets. `times` (sandbox-side wall) is information. */
  const cpu: number[] = [];
  const observations = createHash('sha256');
  const decisions = createHash('sha256');
  const failures: { tick: number; code: string; ms: number; cpuMs?: number }[] = [];
  for (const json of samples) {
    if (!loaded.ok) throw new Error(`load: ${loaded.error.code}`);
    observations.update(json);
    const obs = JSON.parse(json);
    const result = await loaded.instance.call(obs);
    times.push(result.ok ? result.value.ms : result.ms);
    const cpuMs = result.ok ? result.value.cpuMs : result.cpuMs;
    if (cpuMs !== undefined) cpu.push(cpuMs);
    if (result.ok) decisions.update(JSON.stringify(result.value.intents));
    else {
      failures.push({ tick: obs.tick, code: result.error.code, ms: result.ms, ...(cpuMs === undefined ? {} : { cpuMs }) });
      loaded.instance.dispose();
      // A timeout kills an instance. Record it, then continue measuring the remaining trace, never raise its budget.
      loaded = await loadPolicy('js', source, manifest.control.policy, { seed: 1, matchData });
    }
  }
  if (loaded.ok) loaded.instance.dispose();
  times.sort((a, b) => a - b);
  cpu.sort((a, b) => a - b);
  console.log(JSON.stringify({
    name, calls: times.length, observationHash: observations.digest('hex'), decisionHash: decisions.digest('hex'),
    budgetCpuMs: manifest.control.policy.msPerCall,
    cpuMeanMs: cpu.reduce((a, b) => a + b, 0) / cpu.length,
    cpuP50Ms: cpu[Math.floor(cpu.length * 0.5)], cpuP95Ms: cpu[Math.floor(cpu.length * 0.95)],
    cpuP99Ms: cpu[Math.floor(cpu.length * 0.99)], cpuMaxMs: cpu.at(-1),
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
    p50Ms: times[Math.floor(times.length * 0.5)], p95Ms: times[Math.floor(times.length * 0.95)],
    p99Ms: times[Math.floor(times.length * 0.99)], maxMs: times.at(-1), failures,
  }));
  if (failures.length) process.exitCode = 1;
}
