/**
 * Headless bot sweeps for developer tools: 2–4 built-in-bot entrants, one army each, over seeds × slot rotations, each
 * match played by the game's own `playBotMatch` in a pool of worker threads. Reports per-entrant placements and
 * per-slot win rates so slot bias and strength read apart (DESIGN §15.13).
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { COLOURS, DEFAULT_TERRAIN, DEFAULT_TIME_CAP_TICKS, MAX_ARMIES, slotArmyIds, TICK_RATE, type ArmyId, type MatchArmy, type MatchOptions, type Opponent, type Outcome, type TerrainPreset } from '@agent-command/game';
import { lobbyLayout, lobbyMap, MAPS } from '@agent-command/game/lobby';

/** An entrant is a built-in bot level playing every seat of its army. */
export type SweepEntrant = Opponent;
/** Slot orders per seed: entrant k on slot k only, the N cyclic rotations (each entrant plays each slot once), or all N!. */
export const ROTATIONS = ['none', 'cyclic', 'full'] as const;
export type Rotations = (typeof ROTATIONS)[number];

export interface SweepOptions {
  entrants: readonly SweepEntrant[];
  seeds: readonly number[];
  /** Default `cyclic`. */
  rotations?: Rotations;
  /** Default the 30 min cap. */
  maxTicks?: number;
  /** Surface terrain of generated maps (game default when absent). */
  terrain?: TerrainPreset;
  /** Registry map id (authored or a generated recipe); default the terrain's generated recipe. */
  map?: string;
  /** Extra canonical match options merged into every match. */
  rules?: MatchOptions;
  /** Worker threads (default: cores − 1, at most the number of matches). */
  workers?: number;
}

/** One match as a worker plays it. */
export interface SweepJob {
  seed: number;
  armies: MatchArmy[];
  levels: Partial<Record<ArmyId, Opponent>>;
  options: MatchOptions;
  maxTicks: number;
}
export interface SweepJobResult {
  outcome: Partial<Record<ArmyId, Outcome>>;
  rank: Partial<Record<ArmyId, number>>;
  ticks: number;
  ms: number;
}

export interface SweepRun {
  seed: number;
  /** Entrant index per slot (slot order = `armies`). */
  order: number[];
  /** Stopped by `maxTicks` before the match ended. */
  timeout: boolean;
  /** Final placement per slot (1 = winner, ties share); empty on a timeout. */
  ranks: number[];
  /** Slot of the outright winner, if any (a shared first place is a draw). */
  winner: number | null;
  ticks: number;
  ms: number;
}

export interface SweepStats {
  entrants: readonly SweepEntrant[];
  /** Slot order: the army id of each slot. */
  armies: readonly ArmyId[];
  map: string;
  runs: SweepRun[];
  /** Per entrant: outright wins, finished matches, count per rank (index 0 = rank 1) and mean placement. */
  perEntrant: { wins: number; games: number; ranks: number[]; meanPlacement: number }[];
  /** Per slot: outright wins of whoever played it, over finished matches. */
  perSlot: { army: ArmyId; wins: number; games: number }[];
  draws: number;
  timeouts: number;
  medianTicks: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Entrant per slot for every order of a sweep (index 0 is always entrant k on slot k). */
export function slotOrders(entrants: number, rotations: Rotations): number[][] {
  if (rotations === 'full') {
    const orders: number[][] = [];
    const extend = (prefix: number[]): void => {
      if (prefix.length === entrants) { orders.push(prefix); return; }
      for (let entrant = 0; entrant < entrants; entrant++) if (!prefix.includes(entrant)) extend([...prefix, entrant]);
    };
    extend([]);
    return orders;
  }
  return Array.from({ length: rotations === 'cyclic' ? entrants : 1 }, (_, k) => Array.from({ length: entrants }, (_, slot) => (slot + k) % entrants));
}

/** The map, armies and options of a sweep: duels on the map's duel layout, more entrants on its four-slot ffa layout. */
export function sweepSetup(entrants: number, opts: Pick<SweepOptions, 'map' | 'terrain' | 'rules'>): { map: string; armies: ArmyId[]; options: MatchOptions } {
  if (entrants < 2 || entrants > MAX_ARMIES) throw new Error(`a sweep needs 2–${MAX_ARMIES} entrants`);
  const terrain = opts.terrain ?? DEFAULT_TERRAIN;
  const map = opts.map === undefined ? MAPS.find((entry) => entry.tags.includes('generated') && entry.terrain === terrain) : lobbyMap(opts.map);
  if (!map) throw new Error(`unknown map ${opts.map ?? `for terrain ${terrain}`}`);
  if (opts.terrain !== undefined && map.terrain !== opts.terrain) throw new Error(`map ${map.id} is ${map.terrain} terrain, not ${opts.terrain}`);
  const layout = lobbyLayout(map.id, entrants === 2 ? 'duel' : 'ffa');
  if (!layout) throw new Error(`map ${map.id} has no ${entrants === 2 ? 'duel' : 'ffa'} layout`);
  if (entrants > layout.sides) throw new Error(`map ${map.id} has ${layout.sides} slots`);
  const params = (opts.rules?.map as { params?: Record<string, unknown> } | undefined)?.params;
  const selection = map.tags.includes('generated') ? { params: { ...params, slots: layout.sides } } : { name: map.id };
  // Two entrants take the diagonal corners (the C4 duel); more take the slots in order.
  const armies = entrants === 2 ? slotArmyIds(2) : slotArmyIds(layout.sides).slice(0, entrants);
  return { map: map.id, armies, options: { ...opts.rules, terrain: map.terrain, map: selection } as MatchOptions };
}

/** Aggregate runs of one sweep (pure; the reporting half of `sweep`). */
export function sweepStats(entrants: readonly SweepEntrant[], armies: readonly ArmyId[], map: string, runs: SweepRun[]): SweepStats {
  const perEntrant = entrants.map(() => ({ wins: 0, games: 0, ranks: entrants.map(() => 0), meanPlacement: 0 }));
  const perSlot = armies.map((army) => ({ army, wins: 0, games: 0 }));
  let draws = 0;
  for (const run of runs) {
    if (run.timeout) continue;
    if (run.winner === null) draws++;
    run.order.forEach((entrant, slot) => {
      const row = perEntrant[entrant]!;
      row.games++;
      row.ranks[run.ranks[slot]! - 1]!++;
      row.meanPlacement += run.ranks[slot]!;
      perSlot[slot]!.games++;
      if (run.winner === slot) { row.wins++; perSlot[slot]!.wins++; }
    });
  }
  for (const row of perEntrant) row.meanPlacement = row.games ? row.meanPlacement / row.games : 0;
  return { entrants, armies, map, runs, perEntrant, perSlot, draws, timeouts: runs.filter((run) => run.timeout).length, medianTicks: median(runs.map((run) => run.ticks)) };
}

/** Plays every seed × slot order on worker threads (each match deterministic in its seed and order). */
export async function sweep(opts: SweepOptions): Promise<SweepStats> {
  const n = opts.entrants.length;
  const { map, armies, options } = sweepSetup(n, opts);
  const orders = slotOrders(n, opts.rotations ?? 'cyclic');
  const maxTicks = opts.maxTicks ?? DEFAULT_TIME_CAP_TICKS;
  const plan = opts.seeds.flatMap((seed) => orders.map((order) => ({ seed, order })));
  const jobs = plan.map(({ seed, order }): SweepJob => ({
    seed, maxTicks, options,
    armies: armies.map((id, slot) => ({ id, colour: COLOURS[slot]! })),
    levels: Object.fromEntries(armies.map((id, slot) => [id, opts.entrants[order[slot]!]!])),
  }));
  const results = new Array<SweepJobResult>(jobs.length);
  const threads = Math.max(1, Math.min(jobs.length, opts.workers ?? availableParallelism() - 1));
  let next = 0;
  await Promise.all(Array.from({ length: threads }, async () => {
    const worker = new Worker(new URL('./sweep-worker.ts', import.meta.url));
    try {
      while (next < jobs.length) {
        const index = next++;
        const done = Promise.withResolvers<SweepJobResult>();
        worker.once('message', done.resolve);
        worker.once('error', done.reject);
        worker.postMessage(jobs[index]);
        results[index] = await done.promise;
        worker.removeListener('error', done.reject);
      }
    } finally { await worker.terminate(); }
  }));
  const runs = plan.map(({ seed, order }, index): SweepRun => {
    const result = results[index]!;
    const timeout = armies.some((id) => result.outcome[id] === 'running');
    const ranks = timeout ? [] : armies.map((id) => result.rank[id]!);
    const firsts = ranks.flatMap((rank, slot) => rank === 1 ? [slot] : []);
    return { seed, order, timeout, ranks, winner: firsts.length === 1 ? firsts[0]! : null, ticks: result.ticks, ms: Math.round(result.ms) };
  });
  return sweepStats(opts.entrants, armies, map, runs);
}

export function sweepReport(stats: SweepStats): string {
  const label = (entrant: number): string => `${String.fromCharCode(65 + entrant)} ${stats.entrants[entrant]}`;
  const pct = (k: number, n: number): string => `${Math.round((k / Math.max(1, n)) * 100)}%`;
  const finished = stats.runs.length - stats.timeouts;
  const lines = [
    `${stats.entrants.length} entrants on ${stats.map} (${stats.armies.join(', ')}; ${stats.runs.length} matches): draws ${stats.draws} · timeouts ${stats.timeouts} · median ${stats.medianTicks} ticks (${(stats.medianTicks / TICK_RATE / 60).toFixed(1)} min)`,
  ];
  stats.perEntrant.forEach((row, entrant) => {
    lines.push(`  ${label(entrant)}: wins ${row.wins} (${pct(row.wins, row.games)}) · ranks ${row.ranks.map((count, rank) => `${rank + 1}:${count}`).join(' ')} · mean placement ${row.games ? row.meanPlacement.toFixed(2) : '-'}`);
  });
  lines.push(`  slots: ${stats.perSlot.map((slot) => `${slot.army} ${slot.wins}/${slot.games} (${pct(slot.wins, slot.games)})`).join(' · ')} of ${finished} finished`);
  for (const run of stats.runs) {
    const seats = run.order.map((entrant, slot) => `${stats.armies[slot]} ${String.fromCharCode(65 + entrant)}${run.timeout ? '' : ` ${run.ranks[slot]}`}`).join(', ');
    lines.push(`  seed ${run.seed}: ${run.timeout ? 'timeout' : run.winner === null ? 'draw' : `${stats.armies[run.winner]} wins`} at t${run.ticks} · ${seats} · ${(run.ms / 1000).toFixed(1)}s`);
  }
  return lines.join('\n');
}
