/**
 * The built-in Depths bot (standard and veteran) plays the Depths features by their match rules: Drill Bits and Shaped
 * Charges research, backfilling holes near home of the kinds rules.depths.backfillKinds allows, and a Mother Lode crew.
 * Every case runs for both duel armies (point mirrors) and every emitted order is accepted by the game.
 */
import { describe, expect, it } from 'vitest';
import { CELL, DEFAULT_RULES, HOLE_KINDS, spirePositions, toTicks, type ArmyId, type HoleKind, type MatchData, type MatchOptions, type Opponent } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { HOLE } from '../src/sim/constants.ts';
import { cellOf } from '../src/util/grid.ts';
import { TIERS } from '../src/bots/tuning.ts';

const DUEL = ['nw', 'se'] as const;
const armyOf = (id: ArmyId): number => DUEL.indexOf(id as (typeof DUEL)[number]);
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);
const LEVELS = ['standard', 'veteran'] as const satisfies readonly Opponent[];

interface Seat {
  g: AgentCommandGame;
  s: { team: ArmyId; role: 'depths' };
  data: MatchData;
}

/** A fresh default match for `team`'s depths seat with `diggers` extra diggers (and `sappers` sappers) at the root. */
function seat(team: ArmyId, options: MatchOptions = {}, diggers = 0, sappers = 0): Seat {
  const g = createGame({ seed: 5, options });
  for (let i = 0; i < diggers; i++) g.sim.spawnUnit(armyOf(team), 'digger', 'depths');
  for (let i = 0; i < sappers; i++) g.sim.spawnUnit(armyOf(team), 'sapper', 'depths');
  const s = { team, role: 'depths' } as const;
  return { g, s, data: g.matchData(s) };
}

function think(level: Opponent, f: Seat, obs = f.g.observe(f.s, 0)): AgentCommandIntent[] {
  const bot = createBot(f.s.team, 'depths', level);
  bot.init?.(f.data);
  return bot.think(obs);
}

const researched = (out: AgentCommandIntent[]) => out.flatMap((i) => (i.kind === 'research' ? [i.upgrade] : []));

describe('depths bot research', () => {
  for (const level of LEVELS) for (const team of DUEL) {
    it(`${level} ${team}: researches Drill Bits once its dig crew stands, and the game accepts it`, () => {
      const f = seat(team, {}, TIERS[level].researchMinimum.digger!);
      const out = think(level, f);
      expect(researched(out)).toEqual(['drill_bits']);
      expect(f.g.apply(f.s, out.find((i) => i.kind === 'research')!)).toEqual({ ok: true });
    });

    it(`${level} ${team}: never researches a Depths upgrade the rules switch off`, () => {
      const f = seat(team, { research: { drillBitsEnabled: false, shapedChargesEnabled: false } }, TIERS[level].researchMinimum.digger!, 2);
      const obs = f.g.observe(f.s, 0);
      expect(obs.research.available).not.toContain('drill_bits');
      expect(researched(think(level, f, obs))).toEqual([]);
    });
  }

  for (const team of DUEL) {
    it(`veteran ${team}: researches Shaped Charges once it has sappers for its waves, never when switched off`, () => {
      const on = seat(team, {}, 0, 1);
      const obs = on.g.observe(on.s, 0);
      obs.research.available = obs.research.available.filter((id) => id !== 'drill_bits');
      const out = think('veteran', on, obs);
      expect(researched(out)).toEqual(['shaped_charges']);
      expect(on.g.apply(on.s, out.find((i) => i.kind === 'research')!)).toEqual({ ok: true });
      const off = seat(team, { research: { shapedChargesEnabled: false } }, 0, 1);
      const seen = off.g.observe(off.s, 0);
      seen.research.available = seen.research.available.filter((id) => id !== 'drill_bits');
      expect(researched(think('veteran', off, seen))).toEqual([]);
    });

    // Standard runs sapper strikes from below (tier.sappers is 2), so its waves earn
    // Shaped Charges like the veteran's; novice (no sappers) still buys no research.
    it(`standard ${team} researches Shaped Charges once its strike sappers stand; novice buys no research`, () => {
      const f = seat(team, {}, TIERS.veteran.researchMinimum.digger!, TIERS.standard.sappers);
      const obs = f.g.observe(f.s, 0);
      obs.research.available = obs.research.available.filter((id) => id !== 'drill_bits');
      const out = think('standard', f, obs);
      expect(researched(out)).toEqual(['shaped_charges']);
      expect(f.g.apply(f.s, out.find((i) => i.kind === 'research')!)).toEqual({ ok: true });
      expect(researched(think('novice', f))).toEqual([]);
    });
  }
});

describe('depths bot backfill', () => {
  /** Three cells of hole `kind` across the lane 6 tiles out from `team`'s Spire, over cavern its depths seat reaches. */
  const holed = (team: ArmyId, kind: HoleKind, options: MatchOptions = {}) => {
    const f = seat(team, options);
    const p = DEFAULT_SPIRES[team];
    const m = team === 'nw' ? 1 : -1;
    const c = cellOf(p.x + m * 6, p.y + m * 6, f.g.sim.size);
    f.g.sim.openCells([c, c + 1, c - 1], HOLE[kind], armyOf(team === 'nw' ? 'se' : 'nw'));
    f.g.step();
    return { ...f, c };
  };

  for (const level of LEVELS) for (const team of DUEL) for (const kind of ['crater', 'sinkhole', 'chasm'] as const) {
    it(`${level} ${team}: backfills a ${kind} near home, accepted by the game`, () => {
      const f = holed(team, kind);
      const fill = think(level, f).find((i) => i.kind === 'bridge');
      expect(fill).toBeDefined();
      if (fill?.kind !== 'bridge') return;
      expect(f.g.apply(f.s, fill)).toEqual({ ok: true });
      expect(Math.hypot(fill.x - (f.c % f.g.sim.size), fill.y - Math.floor(f.c / f.g.sim.size))).toBeLessThanOrEqual(1);
    });
  }

  for (const level of LEVELS) for (const team of DUEL) {
    it(`${level} ${team}: leaves holes alone when backfillKinds is 0 or excludes their kind`, () => {
      expect(think(level, holed(team, 'chasm', { depths: { backfillKinds: 0 } })).filter((i) => i.kind === 'bridge')).toEqual([]);
      const chasmOnly = 1 << HOLE_KINDS.indexOf('chasm');
      expect(think(level, holed(team, 'crater', { depths: { backfillKinds: chasmOnly } })).filter((i) => i.kind === 'bridge')).toEqual([]);
    });
  }
});

describe('depths bot Mother Lode crew', () => {
  const lodeTargets = (out: AgentCommandIntent[], depths: readonly number[], size: number) =>
    out.flatMap((i) => (i.kind === 'mine' && i.x !== undefined && i.y !== undefined && depths[Math.floor(i.y) * size + Math.floor(i.x)] === CELL.lode ? [i] : []));

  for (const level of LEVELS) for (const team of DUEL) {
    it(`${level} ${team}: sends its crew to the lode cells on its side (veteran also the contested ones), one per cell, and replaces a lost member`, () => {
      const f = seat(team, {}, 7);
      const size = f.g.sim.size;
      const obs = f.g.observe(f.s, 0);
      const cells = obs.depths!.flatMap((code, n) => (code === CELL.lode ? [n] : []));
      expect(cells.length).toBeGreaterThan(0);
      // Squared distances to each Spire centre: ours nearer, or as near (contested; veteran steals while unseen foes).
      const d2 = (n: number, p: { x: number; y: number }) => (n % size + 0.5 - p.x) ** 2 + (Math.floor(n / size) + 0.5 - p.y) ** 2;
      const foe = DEFAULT_SPIRES[team === 'nw' ? 'se' : 'nw'];
      const ours = cells.filter((n) => d2(n, DEFAULT_SPIRES[team]) < d2(n, foe));
      const tied = cells.filter((n) => d2(n, DEFAULT_SPIRES[team]) === d2(n, foe));
      expect(ours).toHaveLength(1);
      const bot = createBot(team, 'depths', level);
      bot.init?.(f.data);
      const crew = lodeTargets(bot.think(obs), obs.depths!, size);
      expect(crew).toHaveLength(Math.min(TIERS[level].motherCrew, ours.length + (TIERS[level].steal ? tied.length : 0)));
      expect(crew.some((i) => i.kind === 'mine' && cellOf(i.x!, i.y!, size) === ours[0])).toBe(true);
      expect(new Set(crew.map((i) => `${i.x},${i.y}`)).size).toBe(crew.length);
      for (const order of crew) expect(f.g.apply(f.s, order)).toEqual({ ok: true });
      // One member is lost: the next decision sends another digger to its cell.
      const lost = crew[0]!;
      if (lost.kind !== 'mine') return;
      const next = f.g.observe(f.s, 0);
      next.tick = toTicks(10);
      next.entities = next.entities.filter((e) => e.id !== lost.units[0]);
      const again = lodeTargets(bot.think(next), next.depths!, size).filter((i) => i.kind === 'mine' && i.x === lost.x && i.y === lost.y);
      expect(again).toHaveLength(1);
      expect(again[0]!.kind === 'mine' && again[0]!.units[0]).not.toBe(lost.units[0]);
    });

    it(`${level} ${team}: crews rules.depths.motherLodeCrewPerCell diggers per lode cell`, () => {
      const f = seat(team, { depths: { motherLodeCrewPerCell: 2 } }, 7);
      const size = f.g.sim.size;
      const obs = f.g.observe(f.s, 0);
      const cells = obs.depths!.flatMap((code, n) => (code === CELL.lode ? [n] : []));
      const d2 = (n: number, p: { x: number; y: number }) => (n % size + 0.5 - p.x) ** 2 + (Math.floor(n / size) + 0.5 - p.y) ** 2;
      const foe = DEFAULT_SPIRES[team === 'nw' ? 'se' : 'nw'];
      const ours = cells.filter((n) => d2(n, DEFAULT_SPIRES[team]) < d2(n, foe));
      const tied = cells.filter((n) => d2(n, DEFAULT_SPIRES[team]) === d2(n, foe));
      const bot = createBot(team, 'depths', level);
      bot.init?.(f.data);
      const crew = lodeTargets(bot.think(obs), obs.depths!, size);
      expect(crew).toHaveLength(Math.min(TIERS[level].motherCrew, 2 * (ours.length + (TIERS[level].steal ? tied.length : 0))));
      const per = new Map<number, number>();
      for (const i of crew) if (i.kind === 'mine') per.set(cellOf(i.x!, i.y!, size), (per.get(cellOf(i.x!, i.y!, size)) ?? 0) + 1);
      expect(per.get(ours[0]!)).toBe(2);
      for (const n of per.values()) expect(n).toBeLessThanOrEqual(2);
      for (const order of crew) expect(f.g.apply(f.s, order)).toEqual({ ok: true });
    });

    it(`${level} ${team}: no crew without the Mother Lode or the home diggers`, () => {
      const off = seat(team, { map: { params: { motherLode: { enabled: false } } } }, 7);
      const obs = off.g.observe(off.s, 0);
      expect(obs.depths!.includes(CELL.lode)).toBe(false);
      expect(think(level, off, obs).filter((i) => i.kind === 'mine')).toEqual([]);
      const few = seat(team);
      const seen = few.g.observe(few.s, 0);
      expect(lodeTargets(think(level, few, seen), seen.depths!, few.g.sim.size)).toEqual([]);
    });

    it(`${level} ${team}: paces its crew by the lode pressure: one from warn while rising, pulled home at critical, none while cooling`, () => {
      const f = seat(team, { depths: { motherLodeCrewPerCell: 4 } }, 9);
      const size = f.g.sim.size;
      const bot = createBot(team, 'depths', level);
      bot.init?.(f.data);
      const at = (state: 'calm' | 'warn' | 'critical' | 'cooling', tick: number, foe = false) => {
        const obs = f.g.observe(f.s, 0);
        obs.tick = tick;
        obs.motherLode = { pressure: state === 'cooling' ? 0 : 70, rate: 1, state, ...(state === 'cooling' ? { until: tick + 100 } : {}) };
        if (foe) {
          // A hostile digger in sight in the ring below nw's last lode cell (above se's first: its mirror).
          const cell = team === 'nw' ? obs.depths!.lastIndexOf(CELL.lode) + size : obs.depths!.indexOf(CELL.lode) - size;
          const own = obs.entities.find((e) => e.kind === 'digger' && e.side === team)!;
          obs.entities.push({ ...own, id: 'e_99999', side: team === 'nw' ? 'se' : 'nw', x: (cell % size) + 0.5, y: Math.floor(cell / size) + 0.5 });
        }
        return bot.think(obs);
      };
      const home = (out: AgentCommandIntent[]) => out.flatMap((i) => (i.kind === 'mine' && i.x === DEFAULT_SPIRES[team].x && i.y === DEFAULT_SPIRES[team].y ? i.units : []));
      const depths = f.g.observe(f.s, 0).depths!;
      expect(lodeTargets(at('calm', 0), depths, size)).toHaveLength(TIERS[level].motherCrew);
      expect(home(at('warn', toTicks(10)))).toHaveLength(TIERS[level].motherCrew - 1);
      // The veteran with an enemy digger in sight at the lode keeps its last one mining to tip it over; others pull out.
      expect(home(at('critical', toTicks(20), TIERS[level].overMine))).toHaveLength(TIERS[level].overMine ? 0 : 1);
      expect(lodeTargets(at('cooling', toTicks(30)), depths, size)).toEqual([]);
    });
  }
});

describe('depths bot Mother Lode fuse', () => {
  /**
   * Both duel armies' Depths seats are `level` bots with diggers to spare for a crew; once both crews are mining the
   * lode the pressure is set to lodeCritical: the fuse commits it and the crews have lodeFuse to get out. Returns, per
   * army, the diggers the eruption hit.
   */
  function fuse(level: Opponent): number[] {
    const g = createGame({ seed: 7 });
    const s = g.sim;
    for (const team of DUEL) for (let i = 0; i < 7; i++) s.spawnUnit(armyOf(team), 'digger', 'depths');
    const seats = DUEL.map((team) => {
      const seat = { team, role: 'depths' } as const;
      const bot = createBot(team, 'depths', level);
      bot.init?.(g.matchData(seat));
      return { seat, bot, since: 0 };
    });
    const crewed = (army: number): boolean => [...s.motherHolders].some((id) => id !== 0 && s.alive(id)?.side === army);
    // Every digger that ever lived here (the dead leave `ents`, the objects keep their last hit).
    const all = new Set(s.ents.filter((e) => e.kind === 'digger'));
    let committed = false;
    for (let t = 0; t < toTicks(300) && !s.lodeCooling(); t++) {
      if (g.tick % BOT_PERIOD === 0) {
        const decided = seats.map((p) => {
          const obs = g.observe(p.seat, p.since);
          p.since = g.tick;
          return p.bot.think(obs);
        });
        s.round(() => seats.forEach((p, i) => { for (const intent of decided[i]!) g.apply(p.seat, intent); }));
      }
      g.step();
      for (const e of s.ents) if (e.kind === 'digger') all.add(e);
      if (!committed && DUEL.every((team) => crewed(armyOf(team)))) {
        s.lodePressure = s.econ.lodeCritical;
        committed = true;
      }
    }
    expect(committed, 'both crews reached the lode').toBe(true);
    expect(s.lodeCooling(), 'it vented').toBe(true);
    return DUEL.map((team) => [...all].filter((e) => e.side === armyOf(team) && e.lastHitCause === 'eruption').length);
  }

  it('standard: both crews run on the fuse and are out of the blast when it vents (mirrored)', () => {
    expect(fuse('standard')).toEqual([0, 0]);
  }, 120_000);

  it('veteran: the greedy last digger stays while an enemy crew is in sight and the blast catches it, the same on both sides', () => {
    expect(fuse('veteran')).toEqual([1, 1]);
  }, 120_000);
});
