/** Depths terrain: caverns, highways and rails, fault lines → chasms (and bridges), breaches, magma pockets. */
import { describe, expect, it } from 'vitest';
import { CELL, DEFAULT_RULES, ECON, SURFACE, TERRAIN_PRESETS, TICK_RATE, surfaceFeature, isOpenCell, toTicks, spirePositions, type Plane, type ArmyId, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { HOLE, VISION_EVERY } from '../src/sim/constants.ts';
import { cellFor, cellOfEnt } from '../src/util/grid.ts';
import { type Ent } from '../src/sim/ent.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

/** Spire centres under the default rules (every match here uses them). */
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);

const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
// Cell helpers for the default-size arenas every fixture here uses.
const cx = (c: number): number => (c % DEFAULT_RULES.map.size) + 0.5;
const cy = (c: number): number => Math.floor(c / DEFAULT_RULES.map.size) + 0.5;
const at = (c: number): { x: number; y: number } => ({ x: c % DEFAULT_RULES.map.size, y: Math.floor(c / DEFAULT_RULES.map.size) });
const spireDist = (c: number): number => Math.min(...Object.values(DEFAULT_SPIRES).map((p) => Math.hypot(cx(c) - p.x, cy(c) - p.y)));

/** Only the Spires and islands left. */
function arena(seed: number, terrain: 'open' | 'ridges' | 'canyons' = 'open', spireInset = DEFAULT_RULES.map.spireInset): AgentCommandGame {
  const g = createGame({ seed, options: { terrain, map: { params: { spireInset } } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}
/** A unit standing at the centre of cell `c` on `plane`. */
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, c: number, plane: Plane): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, plane);
  e.x = cx(c);
  e.y = cy(c);
  return e;
}
/** Dig a straight corridor of tunnel cells, walled in by rock on both sides (no side branches), known to both teams. */
function corridor(g: AgentCommandGame, cells: number[]): void {
  const s = g.sim;
  for (const c of cells) {
    s.cells[c] = CELL.tunnel;
    s.magma[c] = 0;
  }
  for (const c of cells) {
    for (const n of [c - s.size, c + s.size, c - 1, c + 1]) {
      if (cells.includes(n) || s.cells[n] === CELL.bedrock) continue;
      s.cells[n] = CELL.rock;
    }
  }
  for (const c of cells) for (const grp of s.groups) grp.known[c] = CELL.tunnel;
}
/** Ticks until `e` stands on cell `goal` (or `limit`). */
function travel(g: AgentCommandGame, e: Ent, goal: number, limit = toTicks(60)): number {
  for (let t = 1; t <= limit; t++) {
    g.step();
    if (cellOfEnt(e, g.sim.size) === goal && Math.hypot(e.x - cx(goal), e.y - cy(goal)) < 1e-6) return t;
  }
  return Infinity;
}

describe('natural caverns', () => {
  it('link each base pocket to a shared central chamber; ore is finite and richer toward the centre', () => {
    for (const terrain of TERRAIN_PRESETS) {
      for (const seed of [1, 5, 77]) {
        const s = createGame({ seed, options: { terrain } }).sim;
        const size = s.size, N = size * size;
        const seen = new Uint8Array(N);
        const start = s.armies[BLUE]!.spire.depths.cell;
        const queue = [start];
        seen[start] = 1;
        for (let i = 0; i < queue.length; i++) {
          const c = queue[i]!;
          const x = c % size;
          for (const n of [x < size - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + size, c - size]) {
            if (n < 0 || n >= N || seen[n] || !isOpenCell(s.cells[n]!)) continue;
            seen[n] = 1;
            queue.push(n);
          }
        }
        // The centre 2×2 is the Mother Lode (solid); the chamber ring around it joins every cavern.
        for (const c of s.motherCells) expect(s.cells[c], `${terrain} seed ${seed}: Mother Lode`).toBe(CELL.lode);
        expect(s.motherCells).toHaveLength(4);
        expect(seen[(size / 2) * size + size / 2 + 1], `${terrain} seed ${seed}: centre chamber`).toBe(1);
        expect(seen[s.armies[RED]!.spire.depths.cell], `${terrain} seed ${seed}: enemy pocket`).toBe(1);
        let centre = 0;
        let rim = 0;
        let loads = 0;
        for (let c = 0; c < N; c++) {
          // Lode pockets are their own economy (sealed until a Headframe opens them; see defence.test.ts).
          if (s.cells[c] !== CELL.ore || s.lodeAt[c]! >= 0) continue;
          loads += s.ore[c]!;
          const d = Math.hypot(cx(c) - size / 2, cy(c) - size / 2);
          if (d < 6) centre = Math.max(centre, s.ore[c]!);
          else if (spireDist(c) < 9) rim = Math.max(rim, s.ore[c]!);
          expect(s.ore[c]).toBe(s.ore[N - 1 - c]);
        }
        expect(centre).toBeGreaterThan(DEFAULT_RULES.map.oreRim * 2);
        expect(rim).toBeLessThan(centre);
        // Veins that run out: over 200 seeds per preset the whole map holds ~10.5k alloy (median), 5.9–16.9k extremes.
        expect(loads * ECON.oreLoad, `${terrain} seed ${seed}: ore on the map`).toBeGreaterThan(5000);
        expect(loads * ECON.oreLoad, `${terrain} seed ${seed}: ore on the map`).toBeLessThan(18000);
      }
    }
  });
});

describe('highways and rails', () => {
  it('diggers lay rail (alloy per cell); rails are ×2.5, tunnels ×1.5, and either team rides any rail', () => {
    const g = arena(8);
    const s = g.sim;
    const row = (y: number): number[] => Array.from({ length: 12 }, (_, i) => y * s.size + 14 + i);
    const railed = row(20);
    const plain = row(27);
    corridor(g, railed);
    corridor(g, plain);
    const digger = put(g, 'nw', 'digger', railed[0]!, 'depths');
    const alloy = s.armies[BLUE]!.alloy;
    expect(act(g, 'nw', 'depths', { kind: 'rail', units: [id(g, 'nw', digger)], ...at(railed[11]!) })).toEqual({ ok: true });
    let ticks = 0;
    while (digger.order.k === 'rail' && ticks < toTicks(60)) {
      g.step();
      ticks++;
    }
    for (const c of railed) expect(s.cells[c]).toBe(CELL.rail);
    const trickle = (ticks * ECON.spireAlloyRate) / TICK_RATE;
    expect(s.armies[BLUE]!.alloy).toBeCloseTo(alloy + trickle - railed.length * ECON.railCost, 6);
    digger.hp = 0;
    g.step();
    // A red sapper on blue's rail outruns a blue sapper in a plain tunnel by railSpeed / tunnelSpeed.
    const fast = put(g, 'se', 'sapper', railed[0]!, 'depths');
    const slow = put(g, 'nw', 'sapper', plain[0]!, 'depths');
    expect(act(g, 'se', 'depths', { kind: 'move', units: [id(g, 'se', fast)], x: cx(railed[11]!), y: cy(railed[11]!) })).toEqual({ ok: true });
    expect(act(g, 'nw', 'depths', { kind: 'move', units: [id(g, 'nw', slow)], x: cx(plain[11]!), y: cy(plain[11]!) })).toEqual({ ok: true });
    const tFast = travel(g, fast, railed[11]!);
    const tSlow = travel(g, slow, plain[11]!) + tFast;
    const cellTicks = TICK_RATE / 2.5; // sapper speed 2.5 tiles/s
    expect(tFast).toBeCloseTo((11 * cellTicks) / ECON.railSpeed, -0.5);
    expect(tSlow).toBeCloseTo((11 * cellTicks) / ECON.tunnelSpeed, -0.5);
  });
});

describe('depths steering', () => {
  /** A rock box at (x0, y0) with `open` local cells cut as tunnel, the same box point-mirrored for red; both teams know both. */
  function carve(g: AgentCommandGame, x0: number, y0: number, w: number, h: number, open: (x: number, y: number) => boolean): void {
    const s = g.sim;
    const last = s.size * s.size - 1;
    for (let y = -1; y <= h; y++) {
      for (let x = -1; x <= w; x++) {
        const c = (y0 + y) * s.size + x0 + x;
        for (const k of [c, last - c]) {
          s.cells[k] = open(x, y) ? CELL.tunnel : CELL.rock;
          s.magma[k] = 0;
          for (const grp of s.groups) grp.known[k] = s.cells[k]!;
        }
      }
    }
  }
  /** Walk a blue digger and its red twin from local cell `from` to `to`; checks the twins every tick and returns blue's trail. */
  function walk(g: AgentCommandGame, x0: number, y0: number, from: [number, number], to: [number, number]): { x: number; y: number; heading: number }[] {
    const s = g.sim;
    const last = s.size * s.size - 1;
    const a = (y0 + from[1]) * s.size + x0 + from[0];
    const b = (y0 + to[1]) * s.size + x0 + to[0];
    const blue = put(g, 'nw', 'digger', a, 'depths');
    const red = put(g, 'se', 'digger', last - a, 'depths');
    expect(act(g, 'nw', 'depths', { kind: 'move', units: [id(g, 'nw', blue)], x: cx(b), y: cy(b) })).toEqual({ ok: true });
    expect(act(g, 'se', 'depths', { kind: 'move', units: [id(g, 'se', red)], x: cx(last - b), y: cy(last - b) })).toEqual({ ok: true });
    const trail = [{ x: blue.x, y: blue.y, heading: blue.heading }];
    for (let t = 0; t < toTicks(30) && cellOfEnt(blue, s.size) !== b; t++) {
      g.step();
      expect(red.x, `tick ${t}`).toBe(s.size - blue.x);
      expect(red.y, `tick ${t}`).toBe(s.size - blue.y);
      expect(red.heading, `tick ${t}`).toBe(blue.heading);
      trail.push({ x: blue.x, y: blue.y, heading: blue.heading });
    }
    expect(cellOfEnt(blue, s.size)).toBe(b);
    return trail;
  }
  /** Every point of every tick's step lies in an open cell (no cut through rock). */
  function inTunnels(g: AgentCommandGame, trail: { x: number; y: number }[]): void {
    for (let i = 1; i < trail.length; i++) {
      for (let f = 0; f <= 8; f++) {
        const x = trail[i - 1]!.x + ((trail[i]!.x - trail[i - 1]!.x) * f) / 8;
        const y = trail[i - 1]!.y + ((trail[i]!.y - trail[i - 1]!.y) * f) / 8;
        expect(isOpenCell(g.sim.cells[Math.floor(y) * g.sim.size + Math.floor(x)]!), `tick ${i} at ${x},${y}`).toBe(true);
      }
    }
  }

  it('a diagonal tunnel is walked straight: no back-and-forth heading flips; the twins stay exact mirrors', () => {
    const g = arena(8);
    // A diagonal band three cells wide (4-connected paths through it zig-zag cell by cell).
    carve(g, 18, 6, 12, 12, (x, y) => Math.abs(x - y) <= 1);
    const trail = walk(g, 18, 6, [0, 0], [11, 11]);
    // Back-and-forth flips of the travel direction (from the positions) and of the reported heading.
    const flips = (angles: number[]): number => {
      let n = 0;
      let lastTurn = 0;
      for (let i = 1; i < angles.length; i++) {
        const turn = angles[i]! - angles[i - 1]!;
        if (Math.abs(turn) < 1e-6) continue;
        if (lastTurn !== 0 && Math.sign(turn) !== Math.sign(lastTurn)) n++;
        lastTurn = turn;
      }
      return n;
    };
    const travel: number[] = [];
    for (let i = 1; i < trail.length; i++) {
      const dx = trail[i]!.x - trail[i - 1]!.x;
      const dy = trail[i]!.y - trail[i - 1]!.y;
      if (Math.hypot(dx, dy) > 1e-9) travel.push(Math.atan2(dy, dx));
    }
    expect(travel.length).toBeGreaterThan(20);
    expect(flips(travel)).toBe(0);
    expect(flips(trail.map((p) => p.heading))).toBe(0);
    // Straight down the diagonal: every step heads along it.
    for (const a of travel) expect(a).toBeCloseTo(Math.PI / 4, 6);
    inTunnels(g, trail);
  });

  it('never cuts a corner through rock; the twins stay exact mirrors', () => {
    const g = arena(8);
    // An L, and a dog-leg whose straight line from end to end would graze rock corners.
    carve(g, 18, 6, 10, 10, (x, y) => (y === 0 && x <= 8) || (x === 8 && y <= 8) || (y === 8 && x >= 8));
    inTunnels(g, walk(g, 18, 6, [0, 0], [9, 8]));
    const h = arena(9);
    carve(h, 18, 6, 10, 10, (x, y) => (y <= 1 && x <= 4) || (x >= 3 && x <= 4 && y <= 6) || (y >= 5 && y <= 6 && x >= 3));
    inTunnels(h, walk(h, 18, 6, [0, 0], [9, 6]));
  });

  it('a smoothed walker is seen, and sees, from the cell it stands in, never from a path cell behind it (both teams)', () => {
    const g = arena(8);
    const s = g.sim;
    const size = s.size;
    const last = size * size - 1;
    // An open hall crossed corner to corner: each straight-line leg cuts across cells off the 4-connected path, so
    // the last path cell reached lags several cells behind the walker. A one-cell pocket diagonal to the hall's start
    // corner (walled off from it) is a peephole: from there the enemy sees that corner cell and nothing else of the hall.
    const [x0, y0, side] = [18, 6, 12];
    carve(g, x0 - 1, y0 - 1, side + 1, side + 1, (x, y) => (x === 0 && y === 0) || (x > 0 && y > 0));
    const a = y0 * size + x0;
    const b = (y0 + side - 1) * size + x0 + side - 1;
    const walkers = { nw: put(g, 'nw', 'digger', a, 'depths'), se: put(g, 'se', 'digger', last - a, 'depths') };
    const peep = a - size - 1;
    put(g, 'se', 'digger', peep, 'depths');
    put(g, 'nw', 'digger', last - peep, 'depths');
    expect(act(g, 'nw', 'depths', { kind: 'move', units: [id(g, 'nw', walkers.nw)], x: cx(b), y: cy(b) })).toEqual({ ok: true });
    expect(act(g, 'se', 'depths', { kind: 'move', units: [id(g, 'se', walkers.se)], x: cx(last - b), y: cy(last - b) })).toEqual({ ok: true });
    // Cells of the blue walker's hall (red's is its mirror): only the walker sees there for its team.
    const hall = Array.from({ length: side * side }, (_, i) => (y0 + Math.floor(i / side)) * size + x0 + (i % side));
    // Depths vision floods `vision` steps from the walker's cell and shows the walls beside them.
    const reach = s.stat(walkers.nw).vision + 2;
    let hidden = 0;
    for (let t = 1; t <= toTicks(20); t++) {
      g.step();
      if (t % VISION_EVERY !== 0) continue;
      for (const team of ['nw', 'se'] as const) {
        const w = walkers[team];
        const foe = team === 'nw' ? 'se' : 'nw';
        const here = cellFor(g.sim.armyFrame[slotOfArmyId(team, 2)]!, w.x, w.y, size);
        for (const h of hall) {
          const c = team === 'nw' ? h : last - h;
          if (!(s.vis[0]![c]! & s.armies[slotOfArmyId(team, 2)]!.group.bit)) continue;
          const steps = Math.abs((c % size) - (here % size)) + Math.abs(Math.floor(c / size) - Math.floor(here / size));
          expect(steps, `${team} sees cell ${c} from ${here}, tick ${t}`).toBeLessThanOrEqual(reach);
        }
        const seen = g.view(foe).entities.some((e) => s.aliasTarget(slotOfArmyId(foe, 2), Number(e.id.slice(2))) === w.id);
        expect(seen, `${foe} sees ${team}'s walker only where it stands, tick ${t}`).toBe((s.vis[0]![here]! & s.armies[slotOfArmyId(foe, 2)]!.group.bit) !== 0);
        if (!seen) hidden++;
      }
    }
    expect(cellOfEnt(walkers.nw, size)).toBe(b);
    expect(cellOfEnt(walkers.se, size)).toBe(last - b);
    expect(hidden).toBeGreaterThan(0);
  });
});

describe('fault lines and chasms', () => {
  it('a charge under a fault opens a chasm along it (public), units there fall; diggers bridge it back', () => {
    // A map with a fault long enough to open a full chasm in its middle.
    const seed = [3, 4, 5, 6, 7, 8].find((n) => createGame({ seed: n, options: { terrain: 'open' } }).sim.faults.some((f) => f.length >= 11))!;
    const g = arena(seed);
    const s = g.sim;
    const fault = s.faults.find((f) => f.length >= 11)!;
    const c = fault[5]!;
    const victim = put(g, 'se', 'trooper', fault[6]!, 'surface');
    act(g, 'se', 'surface', { kind: 'stance', units: [id(g, 'se', victim)], stance: 'hold' });
    s.cells[c] = CELL.tunnel;
    s.magma.fill(0);
    s.plantCharge(BLUE, c);
    steps(g, ECON.undermineTicks + 1);
    const open = fault.slice(5 - ECON.chasmReach, 5 + ECON.chasmReach + 1);
    for (const n of fault) expect(s.holes[n]).toBe(open.includes(n) ? HOLE.chasm : 0);
    // The Depths below open, except a Mother Lode cell (this seed's fault crosses the centre): it stays solid.
    for (const n of open) {
      if (s.motherCells.includes(n)) expect(s.cells[n]).toBe(CELL.lode);
      else expect(isOpenCell(s.cells[n]!)).toBe(true);
      expect(s.block[n]).toBe(1);
    }
    expect(s.fx.filter((r) => r.fx.kind === 'chasm' && r.pub)).toHaveLength(open.length);
    for (const team of ['nw', 'se'] as const) {
      expect(g.events({ team, role: 'surface' }, 0).some((e) => e.kind === 'chasm_opened')).toBe(true);
      expect(g.observe({ team, role: 'surface' }, 0).holes).toContainEqual({ ...at(c), kind: 'chasm' });
    }
    expect(victim.plane).toBe('depths');
    // A chasm is no portal: the fallen trooper cannot climb back out through it.
    expect(act(g, 'se', 'depths', { kind: 'transfer', units: [id(g, 'se', victim)], to: 'surface', ...at(c) })).toEqual({ ok: false, code: 'no_shaft' });
    expect(victim.plane).toBe('depths');

    // Bridging: a digger works from the tunnel beside the chasm cell; the surface becomes walkable, the tunnel stays.
    const k = fault[4]!;
    const digger = put(g, 'nw', 'digger', fault[3]!, 'depths');
    const alloy = s.armies[BLUE]!.alloy;
    const t0 = g.tick;
    expect(act(g, 'nw', 'depths', { kind: 'bridge', units: [id(g, 'nw', digger)], ...at(k) })).toEqual({ ok: true });
    for (let i = 0; i < toTicks(30) && s.holes[k]; i++) g.step();
    expect(s.holes[k]).toBe(0);
    expect(s.block[k]).toBe(0);
    expect(surfaceFeature(s.terrain[k]!)).toBe(SURFACE.fault);
    expect(isOpenCell(s.cells[k]!)).toBe(true);
    expect(s.armies[BLUE]!.alloy).toBeCloseTo(alloy - ECON.bridgeCost + ((g.tick - t0) * ECON.spireAlloyRate) / TICK_RATE, 6);
    expect(g.tick - t0).toBeGreaterThanOrEqual(ECON.bridgeTicks);
    expect(g.events({ team: 'se', role: 'surface' }, 0).some((e) => e.kind === 'hole_bridged')).toBe(true);
    expect(act(g, 'nw', 'depths', { kind: 'bridge', units: [id(g, 'nw', digger)], ...at(k) })).toEqual({ ok: false, code: 'invalid_target' });
  });
});

describe('breach', () => {
  it('troopers dig up from a tunnel (the defender feels tremors), open a breach hole and climb out', () => {
    const g = arena(4);
    const s = g.sim;
    // Under open ground near red's base.
    let c = -1;
    for (let n = 0; n < s.size * s.size && c < 0; n++) {
      const d = Math.hypot(cx(n) - DEFAULT_SPIRES.se.x, cy(n) - DEFAULT_SPIRES.se.y);
      if (d > 9 && d < 11 && [n - 2, n - 1, n, n + 1].every((k) => s.terrain[k] === SURFACE.ground)) c = n;
    }
    corridor(g, [c - 2, c - 1, c]);
    for (const n of [c - 2, c - 1, c]) s.armies[BLUE]!.group.known[n] = CELL.tunnel;
    const squad = [0, 1, 2].map(() => put(g, 'nw', 'trooper', c - 2, 'depths'));
    const sentry = put(g, 'se', 'trooper', c + 1, 'surface');
    sentry.hp = 1e6;
    act(g, 'se', 'surface', { kind: 'stance', units: [id(g, 'se', sentry)], stance: 'hold' });
    expect(act(g, 'nw', 'depths', { kind: 'breach', units: squad.map((e) => id(g, 'nw', e)), ...at(c) })).toEqual({ ok: true });
    steps(g, toTicks(2));
    expect(squad.every((e) => e.state === 'breaching')).toBe(true);
    expect(g.events({ team: 'se', role: 'surface' }, 0).filter((e) => e.kind === 'breach_tremor')).toHaveLength(1);
    expect(g.events({ team: 'nw', role: 'depths' }, 0).some((e) => e.kind === 'breach_tremor')).toBe(false);
    expect(g.view('se').tremors).toContainEqual({ ...at(c), breach: true });
    for (let i = 0; i < ECON.breachTicks && !s.holes[c]; i++) g.step();
    expect(s.holes[c]).toBe(HOLE.breach);
    expect(g.view('se').fx.some((f) => f.kind === 'breakout')).toBe(true);
    expect(squad.every((e) => e.plane === 'surface' && s.block[Math.floor(e.y) * s.size + Math.floor(e.x)] === 0)).toBe(true);
    for (const team of ['nw', 'se'] as const) {
      expect(g.events({ team, role: 'surface' }, 0).some((e) => e.kind === 'breach_opened')).toBe(true);
      expect(g.observe({ team, role: 'surface' }, 0).holes).toContainEqual({ ...at(c), kind: 'breach' });
    }
    // One way: the breach is no portal, neither back down for the squad nor down for the defender.
    expect(act(g, 'nw', 'surface', { kind: 'transfer', units: squad.map((e) => id(g, 'nw', e)), to: 'depths', ...at(c) })).toEqual({ ok: false, code: 'no_shaft' });
    expect(act(g, 'se', 'surface', { kind: 'transfer', units: [id(g, 'se', sentry)], to: 'depths' })).toEqual({ ok: false, code: 'no_shaft' });
    expect(sentry.plane).toBe('surface');
  });

  it('needs open ground above: no breach under a cliff, a hole or a structure', () => {
    const g = arena(2, 'ridges');
    const s = g.sim;
    let cliff = -1;
    for (let n = 0; n < s.size * s.size && cliff < 0; n++) if (s.terrain[n] === SURFACE.cliff && spireDist(n) > 10) cliff = n;
    corridor(g, [cliff - 1, cliff]);
    s.armies[BLUE]!.group.known[cliff] = s.armies[BLUE]!.group.known[cliff - 1] = CELL.tunnel;
    const t = put(g, 'nw', 'trooper', cliff - 1, 'depths');
    expect(act(g, 'nw', 'depths', { kind: 'breach', units: [id(g, 'nw', t)], ...at(cliff) })).toEqual({ ok: false, code: 'blocked' });
    const root = s.armies[RED]!.spire.depths.cell;
    s.armies[BLUE]!.group.known[root] = CELL.tunnel;
    expect(act(g, 'nw', 'depths', { kind: 'breach', units: [id(g, 'nw', t)], ...at(root) }).ok).toBe(false);
  });
});

describe('magma pockets', () => {
  it('scans locate them (shown as magma, avoided by diggers); breaking one floods tunnels, burns, then cools to open tunnel', () => {
    const g = arena(6, 'open', 8);
    const s = g.sim;
    let p = -1;
    const N = s.size * s.size;
    for (let c = 0; c < N && p < 0; c++) if (s.magma[c] && !s.magma[c - 2] && !s.magma[c + 2] && c % s.size >= 12 && c % s.size <= s.size - 4) p = c;
    expect(p).toBeGreaterThanOrEqual(0);
    const pocket = [...Array(N).keys()].filter((c) => s.magma[c] === s.magma[p]);
    expect(s.cells[p]).toBe(CELL.rock);
    expect(s.armies[BLUE]!.group.known[p]).not.toBe(CELL.magma);
    expect(act(g, 'nw', 'orbit', { kind: 'scan', x: cx(p), y: cy(p) })).toEqual({ ok: true });
    for (const c of pocket) expect(s.armies[BLUE]!.group.known[c]).toBe(CELL.magma);
    expect(s.armies[RED]!.group.known[p]).not.toBe(CELL.magma);
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).depths![p]).toBe(CELL.magma);
    // Diggers route around located magma.
    const probe = put(g, 'nw', 'digger', p - 2, 'depths');
    s.cells[p - 2] = CELL.tunnel;
    expect(s.planDepths(probe, p + 2, true)).toBe(true);
    for (const c of pocket) expect(probe.path).not.toContain(c);
    probe.hp = 0;
    steps(g, 1);

    // A corridor west of the pocket; a blue digger stands in it when red breaks the pocket open.
    const west = Array.from({ length: 8 }, (_, i) => p - 1 - i);
    corridor(g, west);
    for (const c of [p - s.size, p + s.size, p + 1]) if (!pocket.includes(c) && s.cells[c] !== CELL.bedrock) s.cells[c] = CELL.rock;
    const miner = put(g, 'nw', 'digger', west[2]!, 'depths');
    steps(g, VISION_EVERY);
    s.digCell(p, RED);
    expect(s.cells[p]).toBe(CELL.magma);
    for (const c of pocket) expect(s.magma[c]).toBe(0);
    steps(g, ECON.magmaSpreadTicks + toTicks(1));
    const flooded = [p, ...west].filter((c) => s.cells[c] === CELL.magma);
    expect(flooded).toEqual([p, ...west.slice(0, ECON.magmaCells)]);
    expect(miner.hp).toBeLessThan(80);
    expect(miner.lastHitBy).toBe(RED);
    expect(g.events({ team: 'se', role: 'depths' }, 0).some((e) => e.kind === 'magma_flood')).toBe(true);
    expect(g.events({ team: 'nw', role: 'depths' }, 0).some((e) => e.kind === 'magma_flood')).toBe(true);
    const cools = g.observe({ team: 'nw', role: 'depths' }, 0).schedule.find((e) => e.kind === 'magma_cools');
    expect(cools).toMatchObject({ x: cx(p), y: cy(p) });
    expect(cools!.tick - g.tick).toBeLessThanOrEqual(ECON.magmaCoolTicks);
    steps(g, cools!.tick - g.tick);
    for (const c of flooded) expect(s.cells[c]).toBe(CELL.tunnel);
    expect(s.fx.some((r) => r.fx.kind === 'cool')).toBe(true);
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).schedule.some((e) => e.kind === 'magma_cools')).toBe(false);
  });
});
