/**
 * Depths workers commit to a job until it finishes or the job becomes invalid (bots/depths.ts), in the built-in bot
 * matches where diggers used to go back and forth in the tunnels. A digger dithers when it steps back into the cell it
 * just left (A, B, A) at least DITHER_REVERSALS times within DITHER_WINDOW ticks without mining, digging, building or
 * delivering anything. Equal bots play both armies, so each check is also made twin against twin (nw and se are
 * point mirrors of each other).
 */
import { describe, expect, it } from 'vitest';
import { toTicks, type ArmyId, type MatchOptions, type Opponent } from '../src/rules/contract.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { BOT_PERIOD, playBotMatch } from '../src/bots/play.ts';

const DITHER_WINDOW = toTicks(20);
const DITHER_REVERSALS = 4;
/** Work this soon before the first step-back still counts for the episode (the decision that turned it round). */
const WORK_LEAD = 2 * BOT_PERIOD;
/** Digger states that are work done on the spot (mining, digging, building), not travel. */
const WORKING = new Set(['mining', 'digging', 'laying', 'constructing', 'fortifying', 'bridging']);
/** Depths orders that give a digger a maintenance job. */
const JOBS = new Set<AgentCommandIntent['kind']>(['fortify', 'rail', 'bridge']);

interface Track {
  army: ArmyId;
  /** distinct consecutive cells walked, with the tick each was entered */
  path: { tick: number; cell: number }[];
  /** ticks where the digger worked or its cargo changed */
  busy: number[];
  carry: number;
  /** whether it had an order at the end of the last tick, before this round's intents */
  ordered: boolean;
  /** depths-seat intents naming the digger, by tick; `ordered`: it had an order then (a stop takes it off one) */
  orders: { tick: number; kind: AgentCommandIntent['kind']; ordered: boolean }[];
}

/** Play `level` against itself for `seconds` and record every Depths digger of both armies. */
function play(seed: number, level: Opponent, seconds: number, options: MatchOptions = {}): Map<number, Track> {
  const tracks = new Map<number, Track>();
  playBotMatch({
    seed, options, levels: { nw: level, se: level }, maxTicks: toTicks(seconds),
    onIntent: (g, seat, intent) => {
      if (seat.role !== 'depths' || !('units' in intent)) return;
      for (const id of intent.units) {
        const t = tracks.get(Number(id.slice(2)));
        t?.orders.push({ tick: g.tick, kind: intent.kind, ordered: t.ordered });
      }
    },
    onTick: (g) => {
      const s = g.sim;
      for (const e of s.ents) {
        if (e.dead || e.kind !== 'digger' || e.plane !== 'depths') continue;
        let t = tracks.get(e.id);
        if (!t) tracks.set(e.id, t = { army: s.armyIds[e.side]!, path: [], busy: [], carry: e.carry, ordered: false, orders: [] });
        const cell = Math.floor(e.y) * s.size + Math.floor(e.x);
        if (t.path.at(-1)?.cell !== cell) t.path.push({ tick: g.tick, cell });
        if (WORKING.has(e.state) || e.carry !== t.carry) t.busy.push(g.tick);
        t.carry = e.carry;
        t.ordered = e.order.k !== 'none';
      }
    },
  });
  return tracks;
}

/**
 * Dither episodes per army: a run of step-backs each within DITHER_WINDOW of the first, DITHER_REVERSALS or more of
 * them, with no work from WORK_LEAD before the first to the last.
 */
function dithers(tracks: Map<number, Track>): Record<ArmyId, number> {
  const out: Record<string, number> = { nw: 0, se: 0 };
  for (const t of tracks.values()) {
    const back: number[] = [];
    for (let i = 2; i < t.path.length; i++) if (t.path[i]!.cell === t.path[i - 2]!.cell) back.push(t.path[i]!.tick);
    for (let i = 0; i < back.length;) {
      const from = back[i]!;
      let j = i;
      while (j + 1 < back.length && back[j + 1]! - from <= DITHER_WINDOW) j++;
      const to = back[j]!;
      if (j - i + 1 >= DITHER_REVERSALS && !t.busy.some((tick) => tick >= from - WORK_LEAD && tick <= to)) {
        out[t.army]!++;
        i = j + 1;
      } else i++;
    }
  }
  return out as Record<ArmyId, number>;
}

/**
 * Diggers per army sent back to work they had just been stopped from: a maintenance job, the next order a stop that
 * takes the digger off an order, then a maintenance job again, all within DITHER_WINDOW (a job released for the economy
 * and a new one much later is fine; so is a digger whose job ended on its own, an unpaid bridge say, kept standing).
 */
function jobChurn(tracks: Map<number, Track>): Record<ArmyId, number> {
  const out: Record<string, number> = { nw: 0, se: 0 };
  for (const t of tracks.values()) {
    const o = t.orders;
    if (o.some((job, i) => JOBS.has(job.kind) && o[i + 1]?.kind === 'stop' && o[i + 1]!.ordered
      && o.slice(i + 2).some((again) => JOBS.has(again.kind) && again.tick - job.tick <= DITHER_WINDOW))) out[t.army]!++;
  }
  return out as Record<ArmyId, number>;
}

describe('depths workers commit to their jobs', () => {
  // ridges seed 1 veteran: from the first decisions the fault guard's fortify went to the free digger nearest the fault,
  // which then stood nearest home among the two kept on the economy and was stopped, every other decision.
  it('veteran: a fault guard keeps its job; the economy hands are not re-picked every decision (mirrored)', () => {
    const tracks = play(1, 'veteran', 20, { terrain: 'ridges' });
    expect(jobChurn(tracks)).toEqual({ nw: 0, se: 0 });
    expect(dithers(tracks)).toEqual({ nw: 0, se: 0 });
  });

  // ridges seed 1 standard: a loaded worker going home under threat was sent one straight run per decision; idle at the
  // end of each, the simulation's designation work took it away, and the next decision sent it back.
  it('standard: a loaded worker walks its safe way home without being pulled to and fro at the corners (mirrored)', () => {
    const tracks = play(1, 'standard', 120, { terrain: 'ridges' });
    expect(dithers(tracks)).toEqual({ nw: 0, se: 0 });
    expect(jobChurn(tracks)).toEqual({ nw: 0, se: 0 });
  }, 120_000);
});

// Bounded bot matches near their wall timeout under load: the serial timing set.
describe('depths workers commit to their jobs, longer matches', { tags: ['timing'] }, () => {
  // Each case dithered before: maintenance jobs churned (canyons veteran 3), loaded workers returning under threat were
  // pulled off their safe route by designation work at every waypoint (canyons standard 2), workers going to ore were
  // turned back at a crowded apron or by an envelope shifting a cell (ridges veteran 1), workers chased an exploration
  // route that hopped from side to side of home as each dug cell revealed the next (ridges veteran 2), and designation
  // workers turned round as tags were withdrawn and published again (ridges standard 1).
  for (const [seed, level, terrain] of [[1, 'veteran', 'ridges'], [2, 'veteran', 'ridges'], [1, 'standard', 'ridges'], [2, 'standard', 'canyons'], [3, 'veteran', 'canyons']] as const) {
    it(`${terrain} ${level} seed ${seed}: no digger dithers in five minutes (mirrored)`, () => {
      const tracks = play(seed, level, 300, { terrain });
      expect(dithers(tracks)).toEqual({ nw: 0, se: 0 });
      expect(jobChurn(tracks)).toEqual({ nw: 0, se: 0 });
    }, 300_000);
  }
});
