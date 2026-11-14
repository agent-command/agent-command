// @module-tag timing — a recorded 6000-tick match replayed through the QuickJS sandbox; serial timing set.
/**
 * The Sky starter (`policies/sky.js`) forks the built-in Sky bot: unchanged, deployed as policy_deploy stores it
 * (its modules bundled) and run in the QuickJS policy sandbox under the manifest's real limits, it answers every
 * observation of a recorded match exactly as the built-in veteran Sky bot did, every call inside `msPerCall` (a call
 * over it would kill the instance: a timeout).
 */
import type { BotCommander } from 'playerthree';
import { loadPolicy } from 'playerthree/policy';
import { expect, it } from 'vitest';
import { definition } from '../src/agent/adapter.ts';
import type { AgentCommandManifest } from '../src/agent/manifest.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { PLANES, type ArmyId, type Observation, type Plane } from '../src/rules/contract.ts';
import { exactJson } from './bot-trace.ts';
import { STARTER_POLICIES } from './starter-policies.ts';

const SEED = 1;
const TICKS = 6000;

it('an unchanged Sky starter plays the built-in veteran Sky bot exactly, inside the sandbox budget', { timeout: 900_000 }, async () => {
  let matchData: unknown;
  const obs: string[] = [], answers: string[] = [];
  const seats: Partial<Record<ArmyId, Partial<Record<Plane, BotCommander<AgentCommandManifest>>>>> = {};
  for (const team of ['nw', 'se'] as const) {
    seats[team] = Object.fromEntries(PLANES.map((role) => {
      const bot = definition.createBot({ team, role }, 'veteran');
      if (team !== 'nw' || role !== 'sky') return [role, bot];
      const recorder: BotCommander<AgentCommandManifest> = {
        init: (data) => { matchData = structuredClone(data); bot.init?.(data); },
        think: (o) => { obs.push(JSON.stringify(o)); const out = bot.think(o); answers.push(exactJson(out)); return out; },
      };
      return [role, recorder];
    }));
  }
  playBotMatch({ seed: SEED, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: TICKS, seats });

  const limits = definition.manifest.control.policy!;
  const loaded = await loadPolicy('js', STARTER_POLICIES.sky, limits, { seed: SEED, matchData });
  if (!loaded.ok) throw new Error(`Sky starter load: ${loaded.error.code} ${loaded.error.message ?? ''}`);
  const cpu: number[] = [];
  let diffs = 0;
  for (let i = 0; i < obs.length; i++) {
    const r = await loaded.instance.call(JSON.parse(obs[i]!) as Observation);
    if (!r.ok) throw new Error(`call ${i}: ${r.error.code} ${r.error.message ?? ''}`);
    cpu.push(r.value.cpuMs);
    // Answers cross the sandbox as JSON: the recording keeps -0, NaN and undefined visible, so any such value differs.
    if (exactJson(r.value.intents) !== answers[i]) diffs++;
  }
  loaded.instance.dispose();
  const sorted = [...cpu].sort((a, b) => a - b);
  console.log(`Sky starter in QuickJS: ${cpu.length} calls, median ${sorted[cpu.length >> 1]!.toFixed(2)} ms, p95 ${sorted[Math.floor(cpu.length * 0.95)]!.toFixed(2)} ms, max ${sorted.at(-1)!.toFixed(2)} ms CPU (msPerCall ${limits.msPerCall})`);
  expect(obs.length).toBeGreaterThan(0);
  expect(diffs).toBe(0);
  expect(sorted.at(-1)!).toBeLessThanOrEqual(limits.msPerCall);
});
