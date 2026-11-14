/**
 * Depths defence and the Surface economy: rock damage and cracks, fortify repairs and reinforces, fortified
 * faults, bulkheads, and lodes with their Headframes (DESIGN §4.1, §4.2).
 */
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { CELL, DEFAULT_RULES, ECON, STATS, SURFACE, TERRAIN_PRESETS, TICK_RATE, crackStage, observationSchema, toTicks, type MatchOptions, type Plane, type ArmyId, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { HOLE, VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { LODE_SEAL } from '../src/maps/world.ts';
import { playBotMatch } from '../src/bots/play.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { createBot } from '../src/bots/bots.ts';
import { slotOfArmyId } from '../src/util/teams.ts';
import { orbitAsymmetry } from './mirror.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
// Cell helpers for the default-size arenas every fixture here uses.
const cx = (c: number): number => (c % DEFAULT_RULES.map.size) + 0.5;
const cy = (c: number): number => Math.floor(c / DEFAULT_RULES.map.size) + 0.5;
const at = (c: number): { x: number; y: number } => ({ x: c % DEFAULT_RULES.map.size, y: Math.floor(c / DEFAULT_RULES.map.size) });
const cell = (x: number, y: number): number => y * DEFAULT_RULES.map.size + x;
const mirror = (size: number, c: number): number => size * size - 1 - c;
const NO_LODES: MatchOptions = { map: { params: { homeLodes: 0, contestedZones: [] } } };

/** Only the Spires and islands left (no lodes unless asked: tests carve their own tunnels). */
function arena(seed: number, options: MatchOptions = NO_LODES): AgentCommandGame {
  const g = createGame({ seed, options: { terrain: 'open', ...options } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.sim.magma.fill(0);
  steps(g, VISION_EVERY);
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, c: number, plane: Plane = 'depths'): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, plane);
  e.x = cx(c);
  e.y = cy(c);
  if (plane === 'depths') e.cell = c;
  return e;
}
/** Tunnel cells walled in by rock; `known` teams learn them. */
function tunnel(g: AgentCommandGame, cells: number[], known: readonly ArmyId[] = ['nw', 'se']): void {
  const s = g.sim;
  // Dug by the first knowing army (owners matter: fortify hardens walls of its own tunnels only).
  for (const c of cells) {
    s.cells[c] = CELL.tunnel;
    s.owner[c] = slotOfArmyId(known[0] ?? 'nw', 2) + 1;
  }
  for (const c of cells) for (const n of [c - s.size, c + s.size, c - 1, c + 1]) if (!cells.includes(n) && s.cells[n] !== CELL.bedrock && !s.cells[n]!) s.cells[n] = CELL.rock;
  for (const c of cells) for (const team of known) s.armies[slotOfArmyId(team, 2)]!.group.known[c] = CELL.tunnel;
}
/** A row of cells from (x0, y) to (x1, y) inclusive. */
const row = (y: number, x0: number, x1: number): number[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => cell(x0 + i, y));
/** Step until `done` (or `limit` ticks); the ticks it took. */
function until(g: AgentCommandGame, done: () => boolean, limit = toTicks(120)): number {
  for (let t = 1; t <= limit; t++) {
    g.step();
    if (done()) return t;
  }
  return Infinity;
}

describe('rock damage belongs to the cell', () => {
  it('diggers stack on one cell, the damage stays when they leave, and a digger carries none of it to the next cell', () => {
    const g = arena(8);
    const s = g.sim;
    tunnel(g, row(20, 14, 20));
    const wall = cell(21, 20);
    // The cells dug below are plain rock whatever the seed put there.
    for (const c of [wall, cell(22, 20), cell(23, 20), cell(24, 20), cell(22, 21), cell(23, 21), cell(22, 19), cell(23, 19)]) s.cells[c] = CELL.rock;
    // One digger: the cell opens after digRock ticks of work.
    const a = put(g, 'nw', 'digger', cell(20, 20));
    expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, 'nw', a)], ...at(wall) })).toEqual({ ok: true });
    const one = until(g, () => s.cells[wall] === CELL.tunnel);
    expect(one).toBeGreaterThanOrEqual(ECON.digRock);
    expect(one).toBeLessThanOrEqual(ECON.digRock + 2);

    // Two diggers on the next cell finish it in half the time.
    const next = cell(22, 20);
    const b = put(g, 'nw', 'digger', cell(21, 20));
    a.x = b.x;
    a.y = b.y;
    a.cell = b.cell;
    expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, 'nw', a), id(g, 'nw', b)], ...at(next) })).toEqual({ ok: true });
    const two = until(g, () => s.cells[next] === CELL.tunnel);
    expect(two).toBeLessThanOrEqual(Math.ceil(ECON.digRock / 2) + 2);

    // Half a dig, then the digger leaves: the cell keeps the damage and shows cracks to the team that sees it.
    const half = cell(23, 20);
    expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, 'nw', a)], ...at(half) })).toEqual({ ok: true });
    b.hp = 0;
    steps(g, ECON.digRock / 2 + 1);
    act(g, 'nw', 'depths', { kind: 'stop', units: [id(g, 'nw', a)] });
    steps(g, VISION_EVERY * 2);
    const done = s.work[half]!;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(ECON.digRock);
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).cracks).toContainEqual({ ...at(half), stage: crackStage(done, ECON.digRock) });
    // The same digger now digs another cell: that one takes its full time (no carried-over progress).
    const other = cell(22, 21);
    s.cells[other] = CELL.rock;
    expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, 'nw', a)], ...at(other) })).toEqual({ ok: true });
    expect(until(g, () => s.cells[other] === CELL.tunnel)).toBeGreaterThanOrEqual(ECON.digRock);
    // Back at the half-dug cell, a digger finishes only what is left.
    a.x = cx(cell(22, 20));
    a.y = cy(cell(22, 20));
    a.cell = cell(22, 20);
    expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, 'nw', a)], ...at(half) })).toEqual({ ok: true });
    const rest = until(g, () => s.cells[half] === CELL.tunnel);
    expect(rest).toBeLessThanOrEqual(ECON.digRock - done + 2);
    expect(s.work[half]).toBe(0);
  });
});

describe('cracks are fog-safe', () => {
  it('refresh only in vision, retain the last seen stage outside it, and never reveal an unseen breakthrough', () => {
    const ours = row(20, 12, 18);
    const theirs = row(20, 20, 26);
    // Layout-dependent: the first seed where blue starts without cavern knowledge of red's row and the hidden cell. The
    // default lava channel's dry way round (part of blue's starting cavern) runs down through this row, so lakes are off.
    const quiet: MatchOptions = { map: { params: { homeLodes: 0, contestedZones: [], lavaLakes: { enabled: false } } } };
    const g = arena([4, 5, 9, 14, 16].find((n) => { const k = arena(n, quiet).sim.armies[BLUE]!.group.known; return [...theirs, cell(24, 21)].every((c) => k[c] === CELL.unknown); })!, quiet);
    const s = g.sim;
    const wall = cell(19, 20);
    tunnel(g, ours, ['nw']);
    tunnel(g, theirs, ['se']);
    s.cells[wall] = CELL.rock;
    s.work[wall] = ECON.digRock / 4;
    // Blue looks once (its digger sees the wall), then leaves: it keeps knowing the wall.
    const scout = put(g, 'nw', 'digger', cell(18, 20));
    steps(g, VISION_EVERY);
    expect(s.armies[BLUE]!.group.known[wall]).toBe(CELL.rock);
    scout.hp = 0;
    steps(g, VISION_EVERY);
    expect(s.vis[0]![wall]! & s.armies[BLUE]!.group.bit).toBe(0);
    // Red digs the wall from its side, and also a cell blue has never known.
    const hidden = cell(24, 21);
    const d1 = put(g, 'se', 'digger', cell(20, 20));
    const d2 = put(g, 'se', 'digger', cell(24, 20));
    expect(act(g, 'se', 'depths', { kind: 'dig', units: [id(g, 'se', d1)], ...at(wall) })).toEqual({ ok: true });
    expect(act(g, 'se', 'depths', { kind: 'dig', units: [id(g, 'se', d2)], ...at(hidden) })).toEqual({ ok: true });
    steps(g, ECON.digRock / 2 + VISION_EVERY);
    let cracks = g.observe({ team: 'nw', role: 'surface' }, 0).cracks;
    expect(cracks.find((k) => k.x === 19 && k.y === 20)?.stage).toBe(1);
    expect(cracks.some((k) => k.x === 24 && k.y === 21)).toBe(false);
    for (const c of theirs) expect(s.armies[BLUE]!.group.known[c]).toBe(CELL.unknown);
    // Red breaks through unseen: blue still knows a cracked wall there, not a tunnel.
    until(g, () => s.cells[wall] === CELL.tunnel);
    steps(g, VISION_EVERY);
    cracks = g.observe({ team: 'nw', role: 'depths' }, 0).cracks;
    expect(s.armies[BLUE]!.group.known[wall]).toBe(CELL.rock);
    expect(cracks.find((k) => k.x === 19 && k.y === 20)?.stage).toBe(1);
    // Red, who sees its own work, sees no crack on the opened cell.
    expect(g.observe({ team: 'se', role: 'depths' }, 0).cracks.some((k) => k.x === 19 && k.y === 20)).toBe(false);
    const obs = g.observe({ team: 'nw', role: 'depths' }, 0);
    expect(validate(observationSchema, obs).ok).toBe(true);
  });
});

describe('fortify repairs and reinforces', () => {
  it('clears the damage, hardens the cell, reinforces up to the cap, and holds a wall against a digger', () => {
    const g = arena(10);
    const s = g.sim;
    tunnel(g, row(20, 12, 18));
    tunnel(g, row(20, 20, 26));
    const wall = cell(19, 20);
    s.cells[wall] = CELL.rock;
    s.work[wall] = ECON.digRock - 5;
    for (const c of [cell(19, 19), cell(19, 21)]) s.cells[c] = CELL.rock;
    const mason = put(g, 'nw', 'digger', cell(18, 20));
    s.armies[BLUE]!.alloy = 10_000;
    steps(g, VISION_EVERY);
    expect(act(g, 'nw', 'depths', { kind: 'fortify', units: [id(g, 'nw', mason)], ...at(wall) })).toEqual({ ok: true });
    until(g, () => s.cells[wall] === CELL.fortified, ECON.fortifyTicks + 10);
    expect(s.work[wall]).toBe(0);
    expect(s.tough[wall]).toBe(0);
    expect(s.digNeed(wall)).toBe(ECON.digFortified);
    steps(g, VISION_EVERY); // the team sees the fortified cell before it orders the reinforce
    for (let level = 1; level <= ECON.fortifyLevels + 1; level++) {
      expect(act(g, 'nw', 'depths', { kind: 'fortify', units: [id(g, 'nw', mason)], ...at(wall) })).toEqual({ ok: true });
      steps(g, ECON.fortifyTicks + VISION_EVERY + 2);
      expect(s.tough[wall]).toBe(Math.min(level, ECON.fortifyLevels));
    }
    expect(s.digNeed(wall)).toBe(ECON.digFortified + ECON.fortifyLevels * ECON.reinforceTicks);
    expect(s.armies[BLUE]!.stats.fortified).toBe(ECON.fortifyLevels + 2);

    // Repairing faster than the attacker digs: the wall never opens.
    const raider = put(g, 'se', 'digger', cell(20, 20));
    expect(act(g, 'se', 'depths', { kind: 'dig', units: [id(g, 'se', raider)], ...at(cell(12, 20)) })).toEqual({ ok: true });
    for (let t = 0; t < toTicks(120); t++) {
      if (mason.order.k === 'none') act(g, 'nw', 'depths', { kind: 'fortify', units: [id(g, 'nw', mason)], ...at(wall) });
      g.step();
      expect(s.cells[wall]).toBe(CELL.fortified);
    }
    expect(s.work[wall]).toBeLessThan(s.digNeed(wall));
  });
});

describe('fortified faults', () => {
  it('a chasm stops spreading at a fortified fault cell', () => {
    const seed = [3, 4, 5, 6, 7, 8].find((n) => createGame({ seed: n, options: { terrain: 'open', ...NO_LODES } }).sim.faults.some((f) => f.length >= 11))!;
    const g = arena(seed);
    const s = g.sim;
    const fault = s.faults.find((f) => f.length >= 11)!;
    s.cells[fault[5]!] = CELL.tunnel;
    // Beyond the charge's fortification strip (chargeStripReach), so the fortified cell survives the blast.
    s.cells[fault[8]!] = CELL.fortified;
    expect(Math.hypot((fault[8]! % s.size) - (fault[5]! % s.size), Math.floor(fault[8]! / s.size) - Math.floor(fault[5]! / s.size))).toBeGreaterThan(ECON.chargeStripReach);
    s.plantCharge(BLUE, fault[5]!);
    steps(g, ECON.undermineTicks + 1);
    const open = fault.slice(5 - ECON.chasmReach, 8);
    for (const n of fault) expect(s.holes[n], `fault cell ${fault.indexOf(n)}`).toBe(open.includes(n) ? HOLE.chasm : 0);
    expect(s.cells[fault[8]!]).toBe(CELL.fortified);
  });
});

describe('bulkheads', () => {
  for (const [own, foe] of [
    ['nw', 'se'],
    ['se', 'nw'],
  ] as const) {
    // The blue layout, mirrored for red, so both teams' bulkheads and planners are exercised the same way.
    const m = (c: number): number => (own === 'nw' ? c : mirror(DEFAULT_RULES.map.size, c));
    it(`a ${own} staircase gate cannot be bypassed diagonally by ${foe}, even on an already planned route`, () => {
      const g = arena(11), s = g.sim;
      for (let y = 16; y <= 24; y++) for (let x = 16; x <= 24; x++) s.cells[m(cell(x, y))] = CELL.bedrock;
      const stairs = [[18, 18], [19, 18], [19, 19], [20, 19], [20, 20], [21, 20], [21, 21], [22, 21], [22, 22]].map(([x, y]) => m(cell(x!, y!)));
      tunnel(g, stairs);
      const intruder = put(g, foe, 'sapper', stairs.at(-1)!);
      expect(act(g, foe, 'depths', { kind: 'move', units: [id(g, foe, intruder)], x: cx(stairs[0]!), y: cy(stairs[0]!) })).toEqual({ ok: true });
      g.step(); // start moving before the gate exists: also exercise the physical next-cell barrier check
      const gate = s.placeBulkhead(slotOfArmyId(own, 2), stairs[4]!);
      const runner = put(g, own, 'sapper', stairs[0]!);
      expect(act(g, own, 'depths', { kind: 'move', units: [id(g, own, runner)], x: cx(stairs.at(-1)!), y: cy(stairs.at(-1)!) })).toEqual({ ok: true });
      for (let t = 0; t < toTicks(20); t++) {
        g.step();
        expect(stairs.indexOf(intruder.cell)).toBeGreaterThan(4);
      }
      expect(runner.cell).toBe(stairs.at(-1));
      expect(gate.hp).toBe(gate.maxHp);
      expect(act(g, foe, 'depths', { kind: 'move', units: [id(g, foe, intruder)], x: cx(stairs[0]!), y: cy(stairs[0]!) })).toEqual({ ok: false, code: 'no_path' });
    });

    it(`a ${own} bulkhead lets ${own} through, blocks ${foe} in both teams' planners, and falls to digging, fire and charges`, () => {
      const g = arena(11);
      const s = g.sim;
      const line = row(20, 12, 28).map(m);
      tunnel(g, line);
      // Bedrock along both sides: the only way past is through the gate.
      for (const c of [...row(19, 11, 29), ...row(21, 11, 29), cell(11, 20), cell(29, 20)].map(m)) s.cells[c] = CELL.bedrock;
      const gate = m(cell(20, 20));
      s.armies[slotOfArmyId(own, 2)]!.alloy = 10_000;
      const builder = put(g, own, 'digger', m(cell(13, 20)));
      expect(act(g, own, 'depths', { kind: 'queue_add', item: 'bulkhead', ...at(gate), digger: id(g, own, builder) })).toEqual({ ok: true });
      until(g, () => s.bulkheadAt[gate] !== 0, toTicks(30));
      const b = s.alive(s.bulkheadAt[gate]!)!;
      expect(b.kind).toBe('bulkhead');
      expect(b.side).toBe(slotOfArmyId(own, 2));
      expect(s.armies[slotOfArmyId(own, 2)]!.stats.bulkheads).toBe(1);
      expect(act(g, own, 'depths', { kind: 'queue_add', item: 'bulkhead', ...at(gate) })).toEqual({ ok: false, code: 'occupied' });
      expect(act(g, own, 'depths', { kind: 'queue_add', item: 'bulkhead', ...at(m(cell(20, 21))) })).toEqual({ ok: false, code: 'invalid_target' });

      // Own units walk through it.
      const runner = put(g, own, 'sapper', m(cell(27, 20)));
      expect(act(g, own, 'depths', { kind: 'move', units: [id(g, own, runner)], x: cx(m(cell(14, 20))), y: cy(m(cell(14, 20))) })).toEqual({ ok: true });
      expect(until(g, () => runner.cell === m(cell(14, 20)), toTicks(20))).toBeLessThan(Infinity);

      // The enemy cannot: its sapper stops at the gate, and once it has seen it, the planner reports no path.
      const intruder = put(g, foe, 'sapper', m(cell(27, 20)));
      act(g, foe, 'depths', { kind: 'move', units: [id(g, foe, intruder)], x: cx(m(cell(14, 20))), y: cy(m(cell(14, 20))) });
      steps(g, toTicks(15));
      expect(line.indexOf(intruder.cell)).toBeGreaterThan(line.indexOf(gate));
      expect(s.sees(slotOfArmyId(foe, 2), b)).toBe(true);
      expect(act(g, foe, 'depths', { kind: 'move', units: [id(g, foe, intruder)], x: cx(m(cell(14, 20))), y: cy(m(cell(14, 20))) })).toEqual({ ok: false, code: 'no_path' });
      const ghost = g.view(foe).memory.find((x) => x.id === id(g, foe, b));
      expect(ghost === undefined || ghost.kind === 'bulkhead').toBe(true);

      // Repair: fortify on an own bulkhead repairs it to full and adds HP (free, time only).
      b.hp = 100;
      expect(act(g, own, 'depths', { kind: 'fortify', units: [id(g, own, builder)], ...at(gate) })).toEqual({ ok: true });
      steps(g, ECON.fortifyTicks + toTicks(3));
      expect(b.maxHp).toBe(STATS.bulkhead.hp + ECON.bulkheadReinforce);
      expect(b.hp).toBe(b.maxHp);

      // An enemy digger digs through it (it loses HP like rock loses its toughness), then passes.
      const miner = put(g, foe, 'digger', m(cell(21, 20)));
      expect(act(g, foe, 'depths', { kind: 'dig', units: [id(g, foe, miner)], ...at(m(cell(12, 20))) })).toEqual({ ok: true });
      steps(g, toTicks(2));
      expect(b.hp).toBeLessThan(b.maxHp);
      expect(miner.state).toBe('digging');
      until(g, () => b.dead, ECON.bulkheadDigTicks * 2);
      expect(s.gate[gate]).toBe(0);
      expect(g.events({ team: foe, role: 'depths' }, 0).some((e) => e.kind === 'structure_destroyed' && e.subject === 'bulkhead')).toBe(true);
      expect(until(g, () => line.indexOf(miner.cell) < line.indexOf(gate), toTicks(10))).toBeLessThan(Infinity);

      // A sapper charge next to a bulkhead blows it.
      const second = s.placeBulkhead(slotOfArmyId(own, 2), m(cell(24, 20)));
      s.plantCharge(slotOfArmyId(foe, 2), m(cell(25, 20)));
      steps(g, ECON.undermineTicks + 2);
      expect(second.dead).toBe(true);
    });
  }
});

describe('lodes and Headframes', () => {
  it('are seeded in mirrored pairs (default 2 home + 1 contested pair per side), sealed in bedrock under buildable outcrops', () => {
    let placed = 0;
    let maps = 0;
    for (const terrain of TERRAIN_PRESETS) {
      for (const seed of [1, 2, 5, 77, 123]) {
        const s = createGame({ seed, options: { terrain } }).sim;
        maps++;
        placed += s.lodes.length;
        expect(s.lodes.length % 2).toBe(0);
        for (let i = 0; i < s.lodes.length; i += 2) {
          const [a, b] = [s.lodes[i]!, s.lodes[i + 1]!];
          expect(b.c).toBe(mirror(s.size, a.c));
          expect(b.rich).toBe(a.rich);
          expect(b.loads).toBe(a.loads);
        }
        for (const l of s.lodes) {
          let loads = 0;
          for (const n of s.lodeCells(l.c, LODE_SEAL)) {
            const ring = Math.max(Math.abs((n % s.size) - (l.c % s.size)), Math.abs(Math.floor(n / s.size) - Math.floor(l.c / s.size)));
            expect(s.cells[n]).toBe(ring === LODE_SEAL ? CELL.bedrock : ring === 0 ? CELL.rock : CELL.ore);
            if (ring === 1) loads += s.ore[n]!;
            if (ring <= 1) expect(s.terrain[n] === SURFACE.cliff || s.terrain[n] === SURFACE.fault).toBe(false);
            expect(s.ore[n]).toBe(s.ore[mirror(s.size, n)]);
          }
          expect(loads).toBe(l.loads);
          expect(l.loads).toBe(l.rich ? 150 : 80);
        }
        expect(s.lodes.filter((l) => !l.rich).length).toBeLessThanOrEqual(4);
      }
    }
    // The map allows all six on nearly every seed.
    expect(placed / maps).toBeGreaterThan(5.5);
  });

  it('a Headframe opens the seal: drop-off, trickle, lode knowledge; either team mines the pocket', () => {
    const g = arena(5, { map: { params: { spireInset: 8 } } }); // This fixture needs six cells of access on both sides of its home lode.
    const s = g.sim;
    const l = s.lodes.find((x) => !x.rich && Math.hypot(cx(x.c) - 8, cy(x.c) - 8) < 12)!;
    const [lx, ly] = [l.c % s.size, Math.floor(l.c / s.size)];
    const pocket = cell(lx + 1, ly);
    // Sealed: a corridor up to the seal; a digger ordered into the pocket cannot get there.
    tunnel(g, row(ly, lx + 3, lx + 6), ['nw']);
    const digger = put(g, 'nw', 'digger', cell(lx + 3, ly));
    s.armies[BLUE]!.alloy = 10_000;
    act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, 'nw', digger)], ...at(pocket) });
    steps(g, toTicks(5));
    expect(s.cells[cell(lx + 2, ly)]).toBe(CELL.bedrock);
    expect(s.cells[pocket]).toBe(CELL.ore);

    // Placement rules: a Headframe only on a lode; nothing else on one.
    const eye = put(g, 'nw', 'trooper', l.c - 2, 'surface');
    steps(g, VISION_EVERY);
    const off = s.lodes.every((x) => Math.max(Math.abs((x.c % s.size) - 8), Math.abs(Math.floor(x.c / s.size) - 8)) > 2) ? cell(8, 11) : cell(11, 8);
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'headframe', ...at(off) })).toEqual({ ok: false, code: 'no_lode' });
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'turret', ...at(l.c) })).toEqual({ ok: false, code: 'blocked' });
    // Queued next to the outcrop, it stands on it.
    expect(act(g, 'nw', 'surface', { kind: 'queue_add', item: 'headframe', ...at(pocket) })).toEqual({ ok: true });
    g.step();
    const frame = s.ents.find((e) => e.kind === 'headframe')!;
    expect([frame.x, frame.y]).toEqual([cx(l.c), cy(l.c)]);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).lodes.find((x) => x.x === lx && x.y === ly)?.open).toBe(false);
    steps(g, STATS.headframe.build + VISION_EVERY);
    expect(frame.built).toBe(true);
    expect(l.open).toBe(true);
    expect(s.cells[l.c]).toBe(CELL.tunnel);
    for (const n of s.lodeCells(l.c, LODE_SEAL)) if (Math.max(Math.abs((n % s.size) - lx), Math.abs(Math.floor(n / s.size) - ly)) === LODE_SEAL) expect(s.cells[n]).toBe(CELL.rock);
    expect(s.armies[BLUE]!.drop[l.c]).toBe(1);
    expect(s.armies[BLUE]!.stats.headframes).toBe(1);
    expect(g.events({ team: 'nw', role: 'depths' }, 0).some((e) => e.kind === 'lode_opened')).toBe(true);
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).lodes.find((x) => x.x === lx && x.y === ly)?.open).toBe(true);
    // Red neither sees the outcrop nor the pocket: it is not told.
    expect(g.observe({ team: 'se', role: 'surface' }, 0).lodes.find((x) => x.x === lx && x.y === ly)).toBeUndefined();
    expect(g.events({ team: 'se', role: 'depths' }, 0).some((e) => e.kind === 'lode_opened')).toBe(false);

    // The trickle: headframeRate alloy/s on top of the Spire's.
    const a0 = s.armies[BLUE]!.alloy;
    const lode0 = s.armies[BLUE]!.stats.lodeAlloy;
    steps(g, TICK_RATE);
    expect(s.armies[BLUE]!.alloy - a0).toBeCloseTo(ECON.spireAlloyRate + ECON.headframeRate, 6);
    expect(s.armies[BLUE]!.stats.lodeAlloy - lode0).toBeCloseTo(ECON.headframeRate, 6);

    // Our miner digs in from beside and hauls to the Headframe (a short haul).
    eye.hp = 0;
    expect(act(g, 'nw', 'depths', { kind: 'mine', units: [id(g, 'nw', digger)], x: lx + 0.5, y: ly + 0.5 })).toEqual({ ok: true });
    const left0 = l.left;
    const mined0 = s.armies[BLUE]!.stats.alloyMined;
    until(g, () => s.armies[BLUE]!.stats.alloyMined > mined0, toTicks(90));
    expect(s.armies[BLUE]!.stats.alloyMined).toBeGreaterThan(mined0);
    expect(s.armies[BLUE]!.stats.lodeAlloy - lode0).toBeGreaterThan(30);
    expect(l.left).toBeLessThan(left0);
    // Miners never tunnelled through pocket ore: every pocket cell is still ore or was mined out.
    let ore = 0;
    for (const n of s.lodeCells(l.c, 1)) if (n !== l.c && s.cells[n] === CELL.ore) ore += s.ore[n]!;
    expect(ore).toBe(l.left);

    // The enemy can steal from an opened pocket: a red digger mines a load from it.
    // It comes in along blue's corridor, the side away from blue's Spire beam.
    tunnel(g, row(ly, lx + 3, lx + 6), ['se']);
    const thief = put(g, 'se', 'digger', cell(lx + 4, ly));
    // Red has located the pocket (a scan, say): the thief knows where its ore is.
    for (const n of s.lodeCells(l.c, 1)) s.armies[RED]!.group.known[n] = s.cells[n]!;
    expect(act(g, 'se', 'depths', { kind: 'mine', units: [id(g, 'se', thief)], x: lx + 0.5, y: ly + 0.5 })).toEqual({ ok: true });
    until(g, () => thief.lodeCarry > 0, toTicks(60));
    expect(thief.lodeCarry).toBeGreaterThan(0);
  });
});

describe('mirror matches with the new mechanics', () => {
  it('separation keeps a digger standing exactly on a cell edge in the same cell as its mirror twin', () => {
    const g = arena(7, {});
    const s = g.sim;
    const pairs: [Ent, Ent][] = [];
    for (const team of ['nw', 'se'] as const) {
      const m = (c: number): number => team === 'nw' ? c : mirror(s.size, c);
      tunnel(g, [cell(9, 8), cell(9, 9)].map(m), [team]);
    }
    // Blue stands on the edge y = 9 of its cell (9, 9) (the boundary with (9, 8)); red's twin on y = size - 9 of its mirror cell.
    for (const [x, y] of [[9.5, 9], [9.5, 9.3]] as const) {
      const b = put(g, 'nw', 'digger', cell(9, 9));
      const r = put(g, 'se', 'digger', mirror(s.size, cell(9, 9)));
      b.x = x;
      b.y = y;
      r.x = s.size - x;
      r.y = s.size - y;
      pairs.push([b, r]);
    }
    g.step();
    for (const [b, r] of pairs) {
      expect(r.x).toBe(s.size - b.x);
      expect(r.y).toBe(s.size - b.y);
    }
    // The edge unit was pushed within its own cell (9, 9), not across into (9, 8).
    expect(Math.floor(pairs[0]![0].y)).toBe(9);
  });

  it('bot-queued Headframes and bulkheads are funded in order and built for both mirrored teams', () => {
    const g = arena(7, {});
    const s = g.sim;
    s.tick = toTicks(45);
    for (const team of ['nw', 'se'] as const) {
      const m = (c: number): number => team === 'nw' ? c : mirror(s.size, c);
      const t = s.armies[slotOfArmyId(team, 2)]!;
      t.alloy = 5000;
      t.energy = 5000;
      t.group.known.fill(CELL.rock);
      tunnel(g, row(8, 8, 19).map(m), [team]);
      for (const c of [...row(7, 8, 19), ...row(9, 8, 19)].map(m)) t.group.known[c] = CELL.rock;
      for (let i = 0; i < 3; i++) put(g, team, 'digger', m(cell(9 + i, 8)));
      const home = t.spire.surface;
      const lode = [...s.lodes].sort((a, b) => Math.hypot(cx(a.c) - home.x, cy(a.c) - home.y) - Math.hypot(cx(b.c) - home.x, cy(b.c) - home.y))[0]!;
      put(g, team, 'trooper', lode.c, 'surface');
      s.scan(slotOfArmyId(team, 2), cx(lode.c), cy(lode.c));
      for (let c = 0; c < s.n; c++) s.vis[1]![c]! |= t.group.bit;
      for (const [role, item] of [['surface', 'headframe'], ['depths', 'bulkhead']] as const) {
        t.seats[role].controller = 'bot';
        const bot = createBot(team, role, 'standard');
        bot.init?.(g.matchData({ team, role }));
        const intents = bot.think(g.observe({ team, role }, 0));
        const intent = intents.find((i) => i.kind === 'queue_add' && i.item === item);
        expect(intent, `${team} bot queues ${item}`).toBeDefined();
        expect(act(g, team, role, intent!)).toEqual({ ok: true });
      }
      expect(t.queue.map((q) => [q.item, q.byCtl])).toEqual([['headframe', 'bot'], ['bulkhead', 'bot']]);
      t.alloy = s.stats.bulkhead.alloy; // Enough for the gate, not the Headframe ahead of it.
    }
    g.step();
    for (const team of ['nw', 'se'] as const) {
      expect(s.armies[slotOfArmyId(team, 2)]!.queue.map((q) => [q.started, q.reason])).toEqual([[false, 'funds'], [false, 'funds']]);
      s.armies[slotOfArmyId(team, 2)]!.alloy = s.stats.headframe.alloy;
    }
    g.step();
    for (const team of ['nw', 'se'] as const) {
      expect(s.armies[slotOfArmyId(team, 2)]!.queue.map((q) => q.started)).toEqual([true, false]);
      s.armies[slotOfArmyId(team, 2)]!.alloy = s.stats.bulkhead.alloy;
    }
    g.step();
    for (const team of ['nw', 'se'] as const) {
      expect(s.armies[slotOfArmyId(team, 2)]!.queue.map((q) => q.started)).toEqual([true, true]);
      const obs = g.observe({ team, role: 'depths' }, 0);
      expect(validate(observationSchema, obs).ok).toBe(true);
      expect(obs.queue[1]!.digger).toBeDefined();
    }
    expect(until(g, () => s.armies[BLUE]!.queue.length === 0 && s.armies[RED]!.queue.length === 0, toTicks(60))).toBeLessThan(Infinity);
    for (const team of ['nw', 'se'] as const) {
      expect(s.armies[slotOfArmyId(team, 2)]!.stats.headframes).toBe(1);
      expect(s.armies[slotOfArmyId(team, 2)]!.stats.bulkheads).toBe(1);
    }
    const structures = (team: ArmyId) => s.ents.filter((e) => e.side === slotOfArmyId(team, 2) && (e.kind === 'headframe' || e.kind === 'bulkhead')).map((e) => [e.kind, e.built, e.hp, team === 'nw' ? e.x : s.size - e.x, team === 'nw' ? e.y : s.size - e.y]);
    expect(structures('se')).toEqual(structures('nw'));
    expect(s.armies[RED]!.alloy).toBe(s.armies[BLUE]!.alloy);
    expect(s.lodes.filter((l) => l.open)).toHaveLength(2);
  });
  it('veteran bots build Headframes and bulkheads, mine lodes and stay exactly mirrored', () => {
    let first: string | undefined;
    const check = (g: AgentCommandGame): void => {
      if (first || g.tick % 20 !== 0) return;
      const s = g.sim;
      // Every entity against its exact rotated twin (forward posts post-for-post: a captured post keeps the serial it
      // was born with as a neutral, so serials pair only army-born entities).
      first = orbitAsymmetry(s);
      if (first) return;
      for (let c = 0; c < s.size * s.size; c++) if (s.work[c] !== s.work[mirror(s.size, c)] || s.gate[c] !== (s.gate[mirror(s.size, c)] === 0 ? 0 : 3 - s.gate[mirror(s.size, c)]!)) first = `tick ${g.tick}: cell ${c}`;
      if (JSON.stringify(s.armies[BLUE]!.stats) !== JSON.stringify(s.armies[RED]!.stats)) first = `tick ${g.tick}: stats`;
      const queues = (['nw', 'se'] as const).map((team) => s.armies[slotOfArmyId(team, 2)]!.queue.map(({ x, y, island, ...q }) => ({
        ...q,
        site: s.alive(q.site)?.seq ?? 0,
        digger: s.alive(q.digger)?.seq ?? 0,
        island: island ? s.alive(island)?.orbitR : 0,
      })));
      if (JSON.stringify(queues[0]) !== JSON.stringify(queues[1])) first = `tick ${g.tick}: queue`;
      for (let i = 0; i < s.armies[BLUE]!.queue.length; i++) {
        const b = s.armies[BLUE]!.queue[i]!;
        const r = s.armies[RED]!.queue[i];
        if (!r || Math.abs(r.x - (s.size - b.x)) > 1e-6 || Math.abs(r.y - (s.size - b.y)) > 1e-6) first = `tick ${g.tick}: queue target`;
        const bi = s.alive(b.island);
        const ri = r && s.alive(r.island);
        if (bi && (!ri || Math.abs(ri.x - (s.size - bi.x)) > 1e-6 || Math.abs(ri.y - (s.size - bi.y)) > 1e-6)) first = `tick ${g.tick}: queue island`;
      }
    };
    const { game } = playBotMatch({ seed: 7, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: toTicks(300), onTick: check, options: { terrain: 'ridges' } });
    expect(first).toBeUndefined();
    const st = game.sim.armies[BLUE]!.stats;
    expect(st.headframes).toBeGreaterThan(0);
    expect(st.lodeAlloy).toBeGreaterThan(0);
    expect(st.bulkheads + st.fortified).toBeGreaterThan(0);
    for (let i = 0; i < game.sim.lodes.length; i += 2) expect(game.sim.lodes[i]!.left).toBe(game.sim.lodes[i + 1]!.left);
  }, 120_000);
});
