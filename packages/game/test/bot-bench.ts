/**
 * Per-think cost of the built-in bot packages (pnpm bots:build) on recorded observations: one match per plane and
 * level, the nw seat of the plane recorded (match data, every observation, every answer), then replayed.
 *   node --expose-gc test/bot-bench.ts trusted [planes = all] [level = veteran] [seed = 1] [ticks = 6000] [rounds = 4]
 *   node --expose-gc test/bot-bench.ts sandbox [planes = all] [levels = standard,veteran] [seed = 1] [ticks = 6000]
 * `trusted`: the in-process bot (`createBot`) and its package through PlayerThree's trusted runner (`seatBot`), a fresh
 * instance of each per round, paired: on call i both think before either moves on (alternating which goes first),
 * inside one hang-guard batch as a match round runs them (`eachBot`), so load, GC and the guard's fixed cost land on
 * both alike. Round 0 warms the JIT and is not counted.
 *   node --expose-gc test/bot-bench.ts starter [planes = all] [seeds = 1,2,3] [ticks = 6000] [rounds = 3]
 * `sandbox`: the package's script in the QuickJS policy sandbox, with the manifest's limits except a lifted
 * `msPerCall`, so every call's CPU time is seen against the real budget.
 * `starter`: each plane's starter (skill policies/<plane>.js, default knobs: the sandbox tier) the same way, recorded
 * in-process in its seat of a standard vs standard match on each seed, against its budget (STARTER_P95_MS,
 * STARTER_MAX_MS: well inside msPerCall, which a slower host still has to fit). Each call counts its least CPU time
 * over `rounds` replays (a fresh instance each): a shared or virtualised host bills stolen time as CPU, which only
 * ever adds to a call's own work.
 * Every replayed answer is checked against the recording.
 */
import { guardedEach, loadPolicy } from 'playerthree/policy';
import { seatBot, type SeatBot } from 'playerthree/host';
import type { BotCommander } from 'playerthree';
import { definition } from '../src/agent/adapter.ts';
import type { AgentCommandManifest } from '../src/agent/manifest.ts';
import { createBot } from '../src/bots/bots.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { botPolicy, type BotLevel } from '../src/bots/policy.ts';
import { starterPolicy } from '../src/bots/starter.ts';
import { DepthsBot } from '../src/bots/depths.ts';
import { OrbitBot } from '../src/bots/orbit.ts';
import { SkyBot } from '../src/bots/sky.ts';
import { SurfaceBot } from '../src/bots/surface.ts';
import { PLANES, type ArmyId, type MatchData, type Observation, type Plane } from '../src/rules/contract.ts';
import { starterScript } from './starter-policies.ts';

type Commander = BotCommander<AgentCommandManifest>;
const args = process.argv.slice(2);
const [mode = 'trusted', planesArg = PLANES.join(','), levelsArg] = args;
const planes = planesArg.split(',') as Plane[];
// `starter` takes seeds where the others take levels, and has no single seed.
const [seedArg = '1', ticksArg = '6000', roundsArg] = mode === 'starter' ? ['1', ...args.slice(3)] : args.slice(3);
const seed = Number(seedArg);
const ticks = Number(ticksArg);
const SEAT: ArmyId = 'nw';
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});

interface Recording { matchData: MatchData; obs: string[]; out: string[]; decided: boolean[] }

const BOTS = { depths: DepthsBot, surface: SurfaceBot, sky: SkyBot, orbit: OrbitBot } as const;
/** A starter's per-call budget in QuickJS CPU ms over a recorded match: 95th percentile and worst call. */
const STARTER_P95_MS = 12;
const STARTER_MAX_MS = 20;

/**
 * `plane`'s nw seat through one match of `level` against `level`, every seat in-process; `starter`: that seat plays the
 * plane's starter in-process (default knobs) instead.
 */
function record(plane: Plane, level: BotLevel, matchSeed = seed, starter = false): Recording {
  const rec: Recording = { matchData: null as unknown as MatchData, obs: [], out: [], decided: [] };
  const seats: Partial<Record<ArmyId, Partial<Record<Plane, Commander>>>> = {};
  for (const army of ['nw', 'se'] as const) {
    seats[army] = Object.fromEntries(PLANES.map((role) => {
      if (army !== SEAT || role !== plane) return [role, createBot(army, role, level)];
      const policy = starter ? starterPolicy(BOTS[plane], plane, null) : botPolicy(BOTS[plane], { plane, level });
      const bot = { init: (data: MatchData) => policy.init(data), think: (obs: Observation) => policy.think(obs), get nextAt() { return Reflect.get(policy.bot ?? {}, 'nextAt'); } };
      return [role, {
        init: (data: MatchData) => { rec.matchData = structuredClone(data); bot.init?.(data); },
        think: (obs: Observation) => {
          rec.obs.push(JSON.stringify(obs));
          // A think that plans (the bot's cadence moved on) rather than only checking its clock.
          const before = Reflect.get(bot, 'nextAt');
          const out = bot.think(obs);
          rec.decided.push(Reflect.get(bot, 'nextAt') !== before);
          rec.out.push(JSON.stringify(out));
          return out;
        },
      } satisfies Commander];
    }));
  }
  playBotMatch({ seed: matchSeed, levels: { nw: level, se: level }, maxTicks: ticks, seats });
  return rec;
}

interface Stats { n: number; median: number; p95: number; max: number }
function stats(xs: readonly number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  return { n: s.length, median: q(0.5), p95: q(0.95), max: s.at(-1) ?? NaN };
}
const ms = (v: number): string => v.toFixed(3);

function trusted(level: BotLevel): void {
  const rounds = Number(roundsArg ?? 4);
  const rows: string[] = [];
  for (const plane of planes) {
    const rec = record(plane, level);
    const kinds = ['in-process', 'package'] as const;
    const all: Record<(typeof kinds)[number], number[]> = { 'in-process': [], package: [] };
    const decided: Record<(typeof kinds)[number], number[]> = { 'in-process': [], package: [] };
    let diffs = 0;
    for (let r = 0; r < rounds; r++) {
      const bots: SeatBot[] = [createBot(SEAT, plane, level), seatBot(definition, { team: SEAT, role: plane }, level, undefined, seed)];
      for (const b of bots) b.init?.(structuredClone(rec.matchData));
      if (bots[1]!.packageHash === undefined) throw new Error(`${plane} ${level}: no current package (run pnpm bots:build)`);
      for (let i = 0; i < rec.obs.length; i++) {
        const inputs = bots.map(() => JSON.parse(rec.obs[i]!) as Observation);
        guardedEach(bots.length, (j) => {
          const k = (i + j) % bots.length;
          const t0 = performance.now();
          const out = bots[k]!.think(inputs[k]!);
          const dt = performance.now() - t0;
          if (JSON.stringify(out) !== rec.out[i]) diffs++;
          if (r === 0) return;
          all[kinds[k]!].push(dt);
          if (rec.decided[i]) decided[kinds[k]!].push(dt);
        });
      }
      for (const b of bots) b.dispose?.();
      gc();
    }
    for (const kind of kinds) {
      const a = stats(all[kind]), d = stats(decided[kind]);
      rows.push(`| ${plane} | ${kind} | ${a.n} | ${ms(a.median)} | ${ms(a.p95)} | ${ms(a.max)} | ${d.n} | ${ms(d.median)} | ${ms(d.p95)} |`);
    }
    const ratio = (pick: (s: Stats) => number, set: typeof all): string => (pick(stats(set.package)) / pick(stats(set['in-process']))).toFixed(2);
    rows.push(`| ${plane} | **package ÷ in-process** | | ${ratio((s) => s.median, all)}× | ${ratio((s) => s.p95, all)}× | | | ${ratio((s) => s.median, decided)}× | ${ratio((s) => s.p95, decided)}× |`);
    console.error(`${plane}: ${rec.obs.length} thinks × ${rounds - 1} counted rounds, ${diffs} answer diffs`);
    if (diffs > 0) process.exitCode = 1;
  }
  console.log(`${level}, seed ${seed}, ${ticks} ticks; ms per think (all thinks; and thinks that planned)\n`);
  console.log('| plane | runner | thinks | median | p95 | max | planned | median | p95 |\n|---|---|---|---|---|---|---|---|---|');
  console.log(rows.join('\n'));
}

async function sandbox(levels: readonly BotLevel[]): Promise<void> {
  const real = definition.manifest.control.policy!;
  // Every call runs to the end so its CPU time shows; the real budget is the column it is judged against.
  const limits = { ...real, msPerCall: 60_000 };
  const rows: string[] = [];
  for (const plane of planes) {
    for (const level of levels) {
      const rec = record(plane, level);
      const pkg = definition.botPackages?.(level, plane);
      if (!pkg) throw new Error(`${plane} ${level}: no package (run pnpm bots:build)`);
      const t0 = performance.now();
      const loaded = await loadPolicy('js', pkg.script, limits, { seed, matchData: rec.matchData });
      const loadMs = performance.now() - t0;
      if (!loaded.ok) { rows.push(`| ${plane} | ${level} | load failed: ${loaded.error.code} ${loaded.error.message ?? ''} |`); continue; }
      const cpu: number[] = [], planned: number[] = [];
      let diffs = 0, over = 0, failed = '';
      for (let i = 0; i < rec.obs.length; i++) {
        const r = await loaded.instance.call(JSON.parse(rec.obs[i]!));
        if (!r.ok) { failed = `call ${i}: ${r.error.code} ${r.error.message ?? ''}`; break; }
        cpu.push(r.value.cpuMs);
        if (rec.decided[i]) planned.push(r.value.cpuMs);
        if (r.value.cpuMs > real.msPerCall) over++;
        if (JSON.stringify(r.value.intents) !== rec.out[i]) diffs++;
      }
      loaded.instance.dispose();
      const a = stats(cpu), d = stats(planned);
      rows.push(`| ${plane} | ${level} | ${ms(loadMs)} | ${a.n} | ${ms(a.median)} | ${ms(a.p95)} | ${ms(a.max)} | ${ms(d.median)} | ${ms(d.p95)} | ${over} | ${diffs} |${failed ? ` ${failed}` : ''}`);
      console.error(`${plane} ${level}: done${failed ? ` (${failed})` : ''}`);
      gc();
    }
  }
  console.log(`QuickJS sandbox, seed ${seed}, ${ticks} ticks; CPU ms per call against msPerCall ${real.msPerCall}\n`);
  console.log(`| plane | level | load ms | calls | median | p95 | max | planned median | planned p95 | calls > ${real.msPerCall} ms | answer diffs |\n|---|---|---|---|---|---|---|---|---|---|---|`);
  console.log(rows.join('\n'));
}

async function starters(seeds: readonly number[]): Promise<void> {
  const limits = { ...definition.manifest.control.policy!, msPerCall: 60_000 };
  const rows: string[] = [];
  for (const plane of planes) {
    const script = await starterScript(plane);
    const all: number[] = [];
    for (const s of seeds) {
      const rec = record(plane, 'standard', s, true);
      const cpu: number[] = rec.obs.map(() => Infinity);
      let diffs = 0, raw = 0;
      for (let round = 0; round < Number(roundsArg ?? 3); round++) {
        const loaded = await loadPolicy('js', script, limits, { seed: s, matchData: rec.matchData });
        if (!loaded.ok) throw new Error(`${plane} starter load: ${loaded.error.code} ${loaded.error.message ?? ''}`);
        for (let i = 0; i < rec.obs.length; i++) {
          const r = await loaded.instance.call(JSON.parse(rec.obs[i]!));
          if (!r.ok) throw new Error(`${plane} seed ${s} call ${i}: ${r.error.code} ${r.error.message ?? ''}`);
          cpu[i] = Math.min(cpu[i]!, r.value.cpuMs);
          raw = Math.max(raw, r.value.cpuMs);
          if (JSON.stringify(r.value.intents) !== rec.out[i]) diffs++;
        }
        loaded.instance.dispose();
        gc();
      }
      all.push(...cpu);
      const a = stats(cpu);
      const fits = a.p95 <= STARTER_P95_MS && a.max <= STARTER_MAX_MS;
      if (!fits || diffs > 0) process.exitCode = 1;
      rows.push(`| ${plane} | ${s} | ${a.n} | ${ms(a.median)} | ${ms(a.p95)} | ${ms(a.max)} | ${ms(raw)} | ${diffs} | ${fits ? 'yes' : 'NO'} |`);
      console.error(`${plane} seed ${s}: done`);
      gc();
    }
    const a = stats(all);
    rows.push(`| ${plane} | all | ${a.n} | ${ms(a.median)} | ${ms(a.p95)} | ${ms(a.max)} | | | ${a.p95 <= STARTER_P95_MS && a.max <= STARTER_MAX_MS ? 'yes' : 'NO'} |`);
  }
  console.log(`Starters in the QuickJS sandbox, standard vs standard, ${ticks} ticks; CPU ms per call (budget p95 ≤ ${STARTER_P95_MS}, max ≤ ${STARTER_MAX_MS})\n`);
  console.log('| plane | seed | calls | median | p95 | max | raw max (any replay) | answer diffs | fits |\n|---|---|---|---|---|---|---|---|---|');
  console.log(rows.join('\n'));
}

if (mode === 'trusted') trusted((levelsArg ?? 'veteran') as BotLevel);
else if (mode === 'sandbox') await sandbox((levelsArg ?? 'standard,veteran').split(',') as BotLevel[]);
else if (mode === 'starter') await starters((levelsArg ?? '1,2,3').split(',').map(Number));
else throw new Error(`unknown mode ${mode}: trusted | sandbox | starter`);
