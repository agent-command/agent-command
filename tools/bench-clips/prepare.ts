/**
 * Re-simulate a benchmark match from its recorded replay and dump the omniscient observer frames of one moment.
 *   node tools/bench-clips/prepare.ts <momentId> [--verify-only]
 * Reads the moment from moments.json (campaign run directory, match id, tick window). The replay (playerthree.replay
 * v2) carries the seed, options, sides and every applied input (policy, bot and seat entries), so re-simulating it
 * reproduces the match exactly on the frozen build without re-running policies or bots.
 * Before dumping it proves that: the replay's sha256 matches the run's artifact row, the replayed outcomes and length
 * match the recorded match row, and the game's own metrics recorder (attached as the host attaches it, collecting
 * right after every step) yields exactly the recorded timeline: every event row (bar the host's intent acks) and
 * every kill-cause row, field for field.
 * Writes <work>/<momentId>/frames.jsonl.gz (one observer world row per tick, WARM_TICKS before the moment through
 * TAIL_TICKS past its end) and verify.json. Pure simulation: run it in a sim lane, not beside the browser.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { definition, type AgentCommandGame } from '../../packages/game/src/agent/adapter.ts';
import { TICK_RATE } from '../../packages/game/src/rules/vocabulary.ts';
import { replaySimulation } from '../../node_modules/playerthree/src/host/replay.ts';
import { loadMoment, momentDir, TAIL_TICKS, WARM_TICKS } from './moments.ts';

const id = process.argv[2];
if (!id) throw new Error('usage: node tools/bench-clips/prepare.ts <momentId> [--verify-only]');
const verifyOnly = process.argv.includes('--verify-only');
const moment = loadMoment(id);
const out = momentDir(id);
mkdirSync(out, { recursive: true });

const replayBytes = readFileSync(moment.replayPath);
const replaySha = createHash('sha256').update(replayBytes).digest('hex');
const replay = JSON.parse(replayBytes.toString('utf8'));

type Row = Record<string, unknown> & { tick: number; kind?: string; team?: string; data?: Record<string, unknown> };
// The run's results envelope: this match's row, replay artifact row and recorded timeline.
const results = JSON.parse(readFileSync(moment.resultsPath, 'utf8'));
const mine = (rows: Row[]) => rows.filter((r) => r.matchId === moment.matchId);
const row = mine(results.tables.matches)[0];
if (!row) throw new Error(`match ${moment.matchId} not in ${moment.resultsPath}`);
const artifact = mine(results.tables.artifacts).find((a) => a.kind === 'replay');
// The host's own rows: intent acks (no sim content) and each army's final game report (compared to the replayed report).
const recordedEvents = mine(results.tables.events).filter((e) => e.kind !== 'intent_ack' && e.kind !== 'game_report');
const recordedReports = mine(results.tables.events).filter((e) => e.kind === 'game_report');
const recordedCauses = mine(results.tables.causes);
const candidate = (row.spec.bindings as { entrantId: string; seat: { team: string } }[]).find((b) => b.entrantId === 'candidate')?.seat.team;

/** A row without its stream bookkeeping (sequence numbers interleave with the host's intent acks), keys sorted. */
const canonical = (r: Row): string => {
  const { sequence: _s, matchId: _m, ...rest } = r;
  return JSON.stringify(rest, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
};
/** Rows in `a` not matched one for one in `b`. */
const unmatched = (a: Row[], b: Row[]): string[] => {
  const pool = new Map<string, number>();
  for (const r of b) { const k = canonical(r); pool.set(k, (pool.get(k) ?? 0) + 1); }
  const left: string[] = [];
  for (const r of a) {
    const k = canonical(r);
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else left.push(k);
  }
  return left;
};

const frames: string[] = [];
const from = moment.from - WARM_TICKS;
const t0 = Date.now();
const sim = replaySimulation(definition, replay, replay.ticks);
let first = sim.next();
if (first.done) throw new Error('empty replay');
const game = first.value.adapter as AgentCommandGame;
const metrics = definition.metrics!(game);
let collected = game.tick;
let frameTick = -1;
let result;
for (;;) {
  const next = sim.next();
  if (next.done) { result = next.value; break; }
  // The host collects right after each step, before that tick's inputs (P3 host/match.ts).
  if (game.tick !== collected) { metrics.collect(); collected = game.tick; }
  // A tick's frame: its state once its step and all of its recorded inputs are applied (as a live host broadcasts it).
  const pending = replay.entries[next.value.entryIndex]?.[0] ?? Infinity;
  if (!verifyOnly && game.tick !== frameTick && pending > game.tick && game.tick >= from && game.tick <= moment.to + TAIL_TICKS) {
    frameTick = game.tick;
    const world = game.observerView().world as Record<string, unknown>;
    // The match block (terrain, rules) rides on the first frame only; the client keeps it (match-view.ts).
    if (frames.length) delete world.match;
    frames.push(JSON.stringify(world));
  }
}
metrics.finish();
const rows = metrics.drain() as unknown as { events: Row[]; causes: Row[] };
const replayedEvents = rows.events.filter((e) => e.kind !== 'intent_ack');

const missing = [...unmatched(recordedEvents, replayedEvents), ...unmatched(recordedCauses, rows.causes)];
const extra = [...unmatched(replayedEvents, recordedEvents), ...unmatched(rows.causes, recordedCauses)];
const teams: string[] = replay.teams;
const outcomes = Object.fromEntries(teams.map((t) => [t, result.outcomes[t]]));
const recordedOutcomes = Object.fromEntries((row.outcomes as { team: string; outcome: string }[]).map((o) => [o.team, o.outcome]));
const finalTick = game.tick;
const reportsMatch = recordedReports.length === teams.length && recordedReports.every((r) =>
  canonical({ tick: 0, report: r.data?.report }) === canonical({ tick: 0, report: game.report(r.team as never) }));
const checks = {
  replaySha256: replaySha === artifact?.sha256,
  outcomes: JSON.stringify(outcomes) === JSON.stringify(recordedOutcomes),
  length: finalTick * 1000 / TICK_RATE === row.simulatedMs,
  timeline: missing.length === 0 && extra.length === 0,
  reports: reportsMatch,
};
const verify = {
  momentId: id, matchId: moment.matchId, candidate, replaySha256: replaySha, finalTick, simulatedMs: row.simulatedMs, outcomes, recordedOutcomes,
  comparedEvents: recordedEvents.length, comparedCauses: recordedCauses.length, comparedReports: recordedReports.length,
  missing: missing.slice(0, 20), extra: extra.slice(0, 20), checks, frames: frames.length, wallMs: Date.now() - t0,
};
writeFileSync(join(out, 'verify.json'), JSON.stringify(verify, null, 2) + '\n');
console.log(JSON.stringify({ ...verify, missing: missing.length, extra: extra.length }));
if (!Object.values(checks).every(Boolean)) {
  console.error('determinism check failed: not dumping frames');
  process.exit(1);
}
if (!verifyOnly) writeFileSync(join(out, 'frames.jsonl.gz'), gzipSync(frames.join('\n')));
