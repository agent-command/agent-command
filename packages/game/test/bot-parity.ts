/**
 * Parity gate for the built-in bot packages (pnpm bots:build): every seat played in-process by `createBot` (the
 * fallback PlayerThree keeps), then by its tier's package through the trusted runner, same seed. Every think answer
 * of every seat (empty ones too) and the final state hash must be equal.
 *   node test/bot-parity.ts [seeds = 1,2,3] [ticks = 6000]
 * Cases per seed: standard vs standard and veteran vs novice (duels), and a four-army free-for-all (four_corners).
 */
import { surfaceHash, type BotCommander } from 'playerthree';
import { seatBot, type SeatBot } from 'playerthree/host';
import { definition } from '../src/agent/adapter.ts';
import type { AgentCommandManifest } from '../src/agent/manifest.ts';
import { playBotMatch, type BotMatchOptions } from '../src/bots/play.ts';
import { PLANES, type ArmyId, type Opponent, type Plane } from '../src/rules/contract.ts';
import { exactJson } from './bot-trace.ts';

const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
const ticks = Number(process.argv[3] ?? 6000);

const CASES: { name: string; levels: Partial<Record<ArmyId, Opponent>>; options?: BotMatchOptions['options'] }[] = [
  { name: 'standard vs standard', levels: { nw: 'standard', se: 'standard' } },
  { name: 'veteran vs novice', levels: { nw: 'veteran', se: 'novice' } },
  { name: 'FFA vet/std/nov/std', levels: { nw: 'veteran', ne: 'standard', se: 'novice', sw: 'standard' }, options: { map: { name: 'four_corners' } } },
];

type Make = (team: ArmyId, role: Plane, level: Opponent) => BotCommander<AgentCommandManifest>;
interface Run { traces: Map<string, string[]>; hash: string }

function play(c: (typeof CASES)[number], seed: number, make: Make, onTick?: () => void): Run {
  const seats: NonNullable<BotMatchOptions['seats']> = {};
  for (const [team, level] of Object.entries(c.levels) as [ArmyId, Opponent][]) {
    seats[team] = Object.fromEntries(PLANES.map((role) => [role, make(team, role, level)]));
  }
  const traces = new Map<string, string[]>();
  const { game } = playBotMatch({
    seed, levels: c.levels, maxTicks: ticks, seats, ...(c.options ? { options: c.options } : {}), ...(onTick ? { onTick } : {}),
    onDecision: (g, seat, intents) => {
      const key = `${seat.team}/${seat.role}`;
      let lines = traces.get(key);
      if (!lines) traces.set(key, (lines = []));
      lines.push(`${g.tick}:${exactJson(intents)}`);
    },
  });
  return { traces, hash: game.stateHash() };
}

const surface = surfaceHash(definition.manifest);
for (const level of ['novice', 'standard', 'veteran'] as const) {
  for (const role of PLANES) {
    const pkg = definition.botPackages?.(level, role);
    if (!pkg || pkg.surfaceHash !== surface) throw new Error(`no current package for ${level}/${role}: run pnpm bots:build`);
  }
}

const rows: string[] = [];
let failed = false;
for (const c of CASES) {
  for (const seed of seeds) {
    const t0 = performance.now();
    const old = play(c, seed, (team, role, level) => definition.createBot({ team, role }, level));
    const t1 = performance.now();
    const packaged: SeatBot[] = [];
    // Every package seat must play its package to the end: no load failure, no hang fallback.
    const fellBack = new Set<SeatBot>();
    const now = play(c, seed, (team, role, level) => {
      const bot = seatBot(definition, { team, role }, level, undefined, seed);
      packaged.push(bot);
      return bot as BotCommander<AgentCommandManifest>;
    }, () => { for (const b of packaged) if (b.packageHash === undefined) fellBack.add(b); });
    const t2 = performance.now();
    for (const plane of PLANES) {
      let calls = 0, nonEmpty = 0, diffs = 0;
      let first = '';
      for (const [key, lines] of old.traces) {
        if (!key.endsWith(`/${plane}`)) continue;
        const other = now.traces.get(key) ?? [];
        calls += lines.length;
        diffs += Math.abs(other.length - lines.length);
        for (let i = 0; i < Math.min(lines.length, other.length); i++) {
          if (!lines[i]!.endsWith(':[]')) nonEmpty++;
          if (lines[i] !== other[i]) { diffs++; first ||= `${key} ${lines[i]!.slice(0, 120)} ≠ ${other[i]!.slice(0, 120)}`; }
        }
      }
      const equal = old.hash === now.hash;
      failed ||= diffs > 0 || !equal || fellBack.size > 0;
      rows.push(`| ${c.name} | ${seed} | ${plane} | ${calls} (${nonEmpty} non-empty) | ${diffs} | ${equal ? `equal ${now.hash}` : `${old.hash} ≠ ${now.hash}`} |${first ? ` ${first}` : ''}`);
    }
    console.error(`${c.name} seed ${seed}: in-process ${((t1 - t0) / 1000).toFixed(1)} s, packages ${((t2 - t1) / 1000).toFixed(1)} s, fallbacks ${fellBack.size}`);
  }
}
console.log(`${ticks} ticks per match\n\n| case | seed | plane | think calls compared | intent diffs | final hash |\n|---|---|---|---|---|---|\n${rows.join('\n')}`);
if (failed) process.exitCode = 1;
