import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { CELL, DEFAULT_RULES, INTENTS, PLANES, designationFrontier, observationSchema, viewSchema, type MatchOptions, type ArmyId } from '../src/rules/contract.ts';
import { slotOfArmyId } from '../src/util/teams.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import type { Ent } from '../src/sim/ent.ts';

// Cell helpers for the default-size arenas and fixtures every test here uses.
const N = DEFAULT_RULES.map.size * DEFAULT_RULES.map.size;
const c = (x: number, y = 20) => y * DEFAULT_RULES.map.size + x;
const xy = (n: number) => ({ x: n % DEFAULT_RULES.map.size, y: Math.floor(n / DEFAULT_RULES.map.size) });
const mirror = (n: number) => N - 1 - n;
const steps = (g: AgentCommandGame, n: number) => { for (let i = 0; i < n; i++) g.step(); };
const act = (g: AgentCommandGame, intent: AgentCommandIntent, team: ArmyId = 'nw') => g.apply({ team, role: 'depths' }, intent);
const tag = (g: AgentCommandGame, cells: number[], priority = 1, team: ArmyId = 'nw') => act(g, { kind: 'designate', cells: cells.map(xy), priority }, team);
const bit = (words: number[], n: number) => (words[Math.floor(n / 30)]! >>> (n % 30)) & 1;
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 91, options: { terrain: 'open', map: { params: { homeLodes: 0, contestedZones: [] } }, ...options } });
  for (const e of g.sim.ents) if (e.unit) e.hp = 0;
  steps(g, 2);
  g.sim.cells.fill(CELL.rock);
  g.sim.magma.fill(0);
  g.sim.ore.fill(0);
  for (const team of ['nw', 'se'] as const) g.sim.armies[slotOfArmyId(team, 2)]!.group.known.fill(CELL.unknown);
  return g;
}
function tunnel(g: AgentCommandGame, cells: number[], team: ArmyId = 'nw'): void {
  for (const n of cells) {
    g.sim.cells[n] = CELL.tunnel;
    g.sim.armies[slotOfArmyId(team, 2)]!.group.known[n] = CELL.tunnel;
  }
}
function worker(g: AgentCommandGame, n: number, team: ArmyId = 'nw'): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), 'digger', 'depths');
  e.x = n % g.sim.size + 0.5;
  e.y = Math.floor(n / g.sim.size) + 0.5;
  e.cell = n;
  return e;
}

describe('shared fog-safe dig designations', () => {
  it('accepts every seat, inclusive reversed rectangles, priority updates and removal, but never enemy tags', () => {
    const g = arena();
    for (const role of PLANES) expect(g.apply({ team: 'nw', role }, { kind: 'designate', rect: { x0: 14, y0: 21, x1: 12, y1: 20 }, priority: 1 })).toEqual({ ok: true });
    expect(g.sim.armies[0]!.designationCount).toBe(6);
    expect(tag(g, [c(12)], 2)).toEqual({ ok: true });
    expect(tag(g, [c(13)], 0)).toEqual({ ok: true });
    expect(g.sim.armies[0]!.designationCount).toBe(5);
    for (const role of PLANES) {
      const obs = g.observe({ team: 'nw', role }, 0);
      expect(bit(obs.designations.urgent, c(12))).toBe(1);
      expect(bit(obs.designations.normal, c(13))).toBe(0);
      expect(validate(observationSchema, obs).ok).toBe(true);
    }
    expect(g.view('se').designations.normal.every((n) => n === 0)).toBe(true);
    expect(validate(viewSchema, g.view('nw')).ok).toBe(true);
  });

  it('rejects malformed shape, empty lists and bounded input atomically; duplicates count once against team cap', () => {
    const g = arena({ depths: { designateCells: 4, designateMax: 2 } });
    expect(act(g, { kind: 'designate', priority: 1 })).toMatchObject({ ok: false, code: 'invalid_target' });
    expect(act(g, { kind: 'designate', rect: { x0: 1, y0: 1, x1: 1, y1: 1 }, cells: [], priority: 1 })).toMatchObject({ ok: false, code: 'invalid_target' });
    expect(tag(g, [])).toMatchObject({ ok: false, code: 'invalid_target' });
    expect(tag(g, [c(10), c(10), c(11)])).toEqual({ ok: true });
    expect(g.sim.armies[0]!.designationCount).toBe(2);
    expect(tag(g, [c(11), c(12)])).toMatchObject({ ok: false, code: 'designation_limit' });
    expect(g.sim.armies[0]!.designations[c(12)]).toBe(0);
    expect(act(g, { kind: 'designate', rect: { x0: 10, y0: 20, x1: 14, y1: 20 }, priority: 0 })).toMatchObject({ ok: false, code: 'designation_limit' });
    expect(tag(g, Array(5).fill(c(10)))).toMatchObject({ ok: false, code: 'designation_limit' });
    expect(tag(g, [c(10)], 0)).toEqual({ ok: true });
    expect(tag(g, [c(12)])).toEqual({ ok: true });
    expect(validate(INTENTS.designate.params.priority, 3).ok).toBe(false);
    expect(validate(INTENTS.designate.params.rect, { x0: -1, y0: 0, x1: 48, y1: 0 }).ok).toBe(false);
  });

  it.each([CELL.tunnel, CELL.bedrock])('keeps hidden tags identical across twin worlds until learning code %i', (code) => {
    const a = arena();
    const b = arena();
    const n = c(24, 24);
    a.sim.cells[n] = code;
    expect(tag(a, [n])).toEqual(tag(b, [n]));
    steps(a, 4); steps(b, 4);
    expect(a.observe({ team: 'nw', role: 'depths' }, 0)).toEqual(b.observe({ team: 'nw', role: 'depths' }, 0));
    expect(bit(a.view('nw').designations.normal, n)).toBe(1);
    for (const g of [a, b]) {
      tunnel(g, [n - 1]);
      worker(g, n - 1);
      steps(g, 2);
    }
    expect(a.sim.armies[0]!.group.known[n]).toBe(code);
    expect(a.sim.armies[0]!.designations[n]).toBe(0);
    expect(b.sim.armies[0]!.designations[n]).toBe(1);
    expect(tag(a, [n])).toEqual({ ok: true });
    expect(a.sim.armies[0]!.designations[n]).toBe(0);
  });
});

describe('designation frontier scheduling', () => {
  it('transfers full connector reservations when an urgent diagonal tag supersedes normal work', () => {
    const g = arena({ depths: { designateWorkers: 2 } });
    tunnel(g, [c(10)]);
    for (const n of [c(10, 19), c(10, 21)]) g.sim.cells[n] = g.sim.armies[0]!.group.known[n] = CELL.bedrock;
    const a = worker(g, c(10)), b = worker(g, c(10));
    tag(g, [c(11, 21)]);
    g.step();
    expect([a.designation, b.designation]).toEqual([c(11, 21), c(11, 21)]);
    tag(g, [c(11, 19)], 2);
    g.step();
    expect([a.designation, b.designation]).toEqual([c(11, 19), c(11, 19)]);
    expect(g.sim.armies[0]!.designationReserved[c(11)]).toBe(2);
    expect(g.sim.armies[0]!.designationReserved[c(11, 21)]).toBe(0);
  });

  it.each(['nw', 'se'] as const)('chooses a single mirrored connector by tags, material, then fixed order for %s', (team) => {
    const m = (n: number) => team === 'nw' ? n : mirror(n);
    const cells = new Uint8Array(N).fill(CELL.rock), tags = new Uint8Array(N), blocked = new Uint8Array(N);
    const goal = m(c(11, 21)), first = m(c(10, 21)), second = m(c(11, 20));
    cells[m(c(10, 20))] = CELL.tunnel;
    tags[goal] = 1;
    const pick = () => designationFrontier(cells, tags, goal, team === 'se' ? 2 : 0, blocked, DEFAULT_RULES.map.size);
    expect(pick()).toBe(first);
    cells[first] = CELL.ore;
    expect(pick()).toBe(second);
    cells[second] = CELL.fortified;
    expect(pick()).toBe(first);
    tags[second] = 1;
    expect(pick()).toBe(second);
    blocked[second] = 1;
    expect(pick()).toBe(first);
    cells[first] = CELL.bedrock;
    expect(pick()).toBe(-1);
    cells[first] = CELL.magma;
    expect(pick()).toBe(-1);
    cells[first] = CELL.unknown;
    expect(pick()).toBe(first);
    cells[first] = CELL.tunnel;
    expect(pick()).toBe(goal);
    expect(designationFrontier(cells, tags, m(c(13, 23)), team === 'se' ? 2 : 0, undefined, DEFAULT_RULES.map.size)).toBe(-1);
  });

  it('caps a shared connector as well as its tags, steals other work, and releases both reservations', () => {
    const g = arena({ depths: { designateWorkers: 2 } });
    tunnel(g, [c(8), c(9), c(10)]);
    for (const n of [c(10, 19), c(10, 21)]) g.sim.cells[n] = g.sim.armies[0]!.group.known[n] = CELL.bedrock;
    const workers = Array.from({ length: 5 }, () => worker(g, c(10)));
    tag(g, [c(11, 19), c(11, 21), c(7)]);
    g.step();
    const t = g.sim.armies[0]!;
    expect(t.designationReserved[c(11)]).toBe(2);
    expect(t.designationReserved[c(11, 19)]).toBe(2);
    expect(t.designationReserved[c(11, 21)]).toBe(0);
    expect(t.designationReserved[c(7)]).toBe(2);
    expect(workers[4]!.designation).toBe(-1);
    workers[0]!.hp = 0;
    steps(g, 2);
    expect(t.designationReserved[c(11)]).toBe(2);
    expect(workers[4]!.designationConnector).toBe(c(11));
    expect(act(g, { kind: 'mine', units: [g.entityId('nw', workers[4]!.id)] }).ok).toBe(true);
    expect(t.designationReserved[c(11)]).toBe(1);
    expect(workers[4]!.designationConnector).toBe(-1);
  });

  it('mirrors diagonal connector choices, reservations, and movement tick for tick', () => {
    const g = arena();
    const workers: Ent[] = [];
    for (const team of ['nw', 'se'] as const) {
      const m = (n: number) => team === 'nw' ? n : mirror(n);
      tunnel(g, [m(c(10))], team);
      workers.push(worker(g, m(c(10)), team));
      tag(g, [c(11, 21), c(12, 22), c(13, 23)].map(m), 2, team);
    }
    for (let tick = 0; tick < 400; tick++) {
      g.step();
      const a = workers[0]!, b = workers[1]!;
      expect(a.designation < 0 ? -1 : mirror(a.designation)).toBe(b.designation);
      expect(a.designationConnector < 0 ? -1 : mirror(a.designationConnector)).toBe(b.designationConnector);
      expect(a.x + b.x).toBeCloseTo(g.sim.size, 9);
      expect(a.y + b.y).toBeCloseTo(g.sim.size, 9);
    }
    expect(g.sim.cells[c(13, 23)]).toBe(CELL.tunnel);
    expect(g.sim.cells[mirror(c(13, 23))]).toBe(CELL.tunnel);
  });

  it.each(['nw', 'se'] as const)('keeps every diagonal successor tagged and digs one connector per step for %s', (team) => {
    const g = arena();
    const m = (n: number) => team === 'nw' ? n : mirror(n);
    const plan = [c(11, 20), c(12, 21), c(13, 22), c(14, 23)].map(m);
    const start = m(c(10, 20));
    tunnel(g, [start], team);
    worker(g, start, team);
    expect(tag(g, plan, 1, team)).toEqual({ ok: true });
    for (let tick = 0; tick < 420; tick++) {
      g.step();
      const t = g.sim.armies[slotOfArmyId(team, 2)]!;
      const observed = g.observe({ team, role: 'depths' }, 0).designations.normal;
      for (const n of plan) {
        const expected = t.group.known[n] === CELL.tunnel || t.group.known[n] === CELL.rail || t.group.known[n] === CELL.bedrock ? 0 : 1;
        expect(t.designations[n], `tag ${n} at tick ${tick}`).toBe(expected);
        expect(bit(observed, n), `packed tag ${n} at tick ${tick}`).toBe(expected);
      }
    }
    for (const n of plan) expect(g.sim.cells[n], `diagonal cell ${n}`).toBe(CELL.tunnel);
    let connectors = 0;
    for (let n = 0; n < N; n++) if (g.sim.cells[n] === CELL.tunnel && n !== start && !plan.includes(n)) connectors++;
    expect(connectors).toBe(3);
  });

  it.each(['nw', 'se'] as const)('works urgent before nearby normal, stays sticky, and advances a corridor for %s', (team) => {
    const g = arena();
    const m = (n: number) => team === 'nw' ? n : mirror(n);
    tunnel(g, [c(10), c(11), c(12), c(13)].map(m), team);
    const d = worker(g, m(c(11)), team);
    tag(g, [m(c(11, 19))], 1, team);
    tag(g, [c(14), c(15), c(16)].map(m), 2, team);
    g.step();
    expect(d.designation).toBe(m(c(14)));
    tag(g, [m(c(11, 21))], 2, team);
    g.step();
    expect(d.designation).toBe(m(c(14)));
    tag(g, [m(c(11, 21))], 0, team);
    steps(g, 220);
    for (const n of [c(14), c(15), c(16)]) expect(g.sim.cells[m(n)]).toBe(CELL.tunnel);
    expect(g.sim.armies[slotOfArmyId(team, 2)]!.designations[m(c(16))]).toBe(0);
  });

  it('uses walking distance rather than straight-line proximity, and cannot tunnel arbitrary untagged walls en route', () => {
    const g = arena();
    tunnel(g, [c(10), c(11), c(12), c(13), c(13, 21), c(13, 22), c(12, 22), c(11, 22)]);
    const d = worker(g, c(10));
    tag(g, [c(10, 22), c(12, 19), c(8, 18)]);
    g.step();
    expect(d.designation).toBe(c(12, 19));
    expect(g.sim.work[c(8, 18)]).toBe(0);
  });

  it('caps reservations, steals the next reachable job and releases a dead worker reservation', () => {
    const g = arena({ depths: { designateWorkers: 2 } });
    tunnel(g, [c(10), c(11), c(12)]);
    const ds = [worker(g, c(11)), worker(g, c(11)), worker(g, c(11)), worker(g, c(11)), worker(g, c(11))];
    tag(g, [c(11, 19), c(12, 19)]);
    g.step();
    expect(g.sim.armies[0]!.designationReserved[c(11, 19)]).toBe(2);
    expect(g.sim.armies[0]!.designationReserved[c(12, 19)]).toBe(2);
    expect(ds.filter((d) => d.designation < 0)).toHaveLength(1);
    ds[0]!.hp = 0;
    steps(g, 2);
    expect(g.sim.armies[0]!.designationReserved[c(11, 19)]).toBe(2);
    expect(ds[4]!.designation).toBe(c(11, 19));
  });

  it('normal work yields to new urgent work, but not another nearer normal tag', () => {
    const g = arena();
    tunnel(g, [c(10), c(11), c(12)]);
    const d = worker(g, c(10));
    tag(g, [c(13)]);
    g.step();
    expect(d.designation).toBe(c(13));
    tag(g, [c(10, 19)]);
    g.step();
    expect(d.designation).toBe(c(13));
    tag(g, [c(10, 19)], 2);
    g.step();
    expect(d.designation).toBe(c(10, 19));
  });

  it('reuses the shared field and sticky path until tags change, and skips unreachable urgent work', () => {
    const g = arena();
    tunnel(g, [c(10), c(11)]);
    const d = worker(g, c(11));
    tag(g, [c(12)]);
    tag(g, [c(20)], 2);
    steps(g, 4);
    expect(d.designation).toBe(c(12));
    const t = g.sim.armies[0]!;
    const revision = t.designationRevision;
    const path = d.path;
    steps(g, 4);
    expect(t.designationRevision).toBe(revision);
    expect(d.path).toBe(path);
    tag(g, [c(12)], 0);
    g.step();
    expect(d.designation).toBe(-1);
    expect(t.designationReserved[c(12)]).toBe(0);
    const before = t.designationWords.urgent.slice();
    g.observe({ team: 'nw', role: 'depths' }, 0).designations.urgent.fill(0);
    expect(t.designationWords.urgent).toEqual(before);
  });

  it.each(['dig', 'mine', 'fortify'] as const)('explicit %s overrides tags, while auto_mine yields', (kind) => {
    const g = arena();
    tunnel(g, [c(10), c(11)]);
    g.sim.armies[0]!.group.known[c(12)] = CELL.rock;
    g.sim.cells[c(12)] = CELL.rock;
    for (const n of [c(10), c(11)]) g.sim.owner[n] = 1;
    const d = worker(g, c(11));
    tag(g, [c(11, 19)], 2);
    expect(act(g, { kind: 'macro', action: 'auto_mine' })).toEqual({ ok: true });
    g.step();
    expect(d.designation).toBe(c(11, 19));
    const units = [g.entityId('nw', d.id)];
    expect(act(g, kind === 'mine' ? { kind, units } : { kind, units, ...xy(c(12)) })).toEqual({ ok: true });
    g.step();
    expect(d.designation).toBe(-1);
    expect(d.order.k).toBe(kind);
  });

  it('is point-symmetric for reservations, ties, positions and corridor progress', () => {
    const g = arena();
    const base = [c(10), c(11), c(12)];
    const blue: Ent[] = []; const red: Ent[] = [];
    for (const team of ['nw', 'se'] as const) {
      const m = (n: number) => team === 'nw' ? n : mirror(n);
      tunnel(g, base.map(m), team);
      for (let i = 0; i < 4; i++) (team === 'nw' ? blue : red).push(worker(g, m(c(11)), team));
      tag(g, [c(10, 19), c(12, 19), c(10, 18), c(12, 18)].map(m), 2, team);
    }
    for (let tick = 0; tick < 160; tick++) {
      g.step();
      for (let i = 0; i < blue.length; i++) {
        const a = blue[i]!; const b = red[i]!;
        expect(a.designation < 0 ? -1 : mirror(a.designation)).toBe(b.designation);
        expect(a.x + b.x).toBeCloseTo(g.sim.size, 9);
        expect(a.y + b.y).toBeCloseTo(g.sim.size, 9);
      }
    }
  });
});
