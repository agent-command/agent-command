/** RTS movement and combat: fight-move, stances, ranges, projectiles, overkill, formations, separation. */
import { describe, expect, it } from 'vitest';
import { DAMAGE_VS, ECON, LEASH, SPIRE_CORNER, STATS, SURFACE, TICK_RATE, footprintDistance, toTicks, VIEW_GRID, type Plane, type ArmyId, type UnitKind, isOpenCell } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { HOLE } from '../src/sim/constants.ts';
import { cellFor } from '../src/util/grid.ts';
import { type Ent } from '../src/sim/ent.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { NEUTRAL, slotOfArmyId, frameOf } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);

/**
 * A game with only the Spires (and neutral islands) left, plus `units` placed by hand. The ground is level: the `open`
 * preset has no cliffs, and its forests, hills and fords are flattened, so these tests measure movement and combat alone.
 */
function arena(seed = 5): AgentCommandGame {
  const g = createGame({ seed, options: { terrain: 'open' } });
  expect(g.sim.los.any).toBe(false);
  g.sim.terrain.fill(SURFACE.ground);
  g.sim.surfaceCost.fill(1);
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.step();
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, x: number, y: number): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, STATS[kind].plane);
  e.x = x;
  e.y = y;
  return e;
}
const gap = (a: Ent, b: Ent): number => Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;
/** Army frame → world (red sees the map turned half a turn). */
const world = (g: AgentCommandGame, team: ArmyId, x: number, y: number): [number, number] => (team === 'se' ? [g.sim.size - x, g.sim.size - y] : [x, y]);

describe('fight-move and ranges', () => {
  it('six tanks shelling an undefended Spire from the axis to the diagonal take its beam fire, mirrored', () => {
    const g = arena();
    const tanks: Record<ArmyId, Ent[]> = { nw: [], se: [], ne: [], sw: [] };
    // Each tank stands 0.2 inside its own cannon reach (no siege bonus against a Spire) on bearings from the axis
    // (0°) to the diagonal (45°) and on to the other axis (90°), facing the enemy Spire from its own side.
    for (const team of ['nw', 'se'] as const) {
      const spire = g.sim.armies[slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2)]!.spire.surface;
      const sign = team === 'nw' ? -1 : 1;
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 10;
        const ux = sign * Math.cos(a), uy = sign * Math.sin(a);
        let lo = 0, hi = 20;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (footprintDistance('spire', 0, 0, ux * mid, uy * mid) < STATS.tank.range - 0.2) lo = mid;
          else hi = mid;
        }
        const tank = put(g, team, 'tank', spire.x + ux * lo, spire.y + uy * lo);
        tank.stance = 'hold';
        expect(g.sim.inRange(tank, spire)).toBe(true);
        // The beam reaches from the footprint edge: no bearing out-ranges it.
        expect(g.sim.inRange(spire, tank)).toBe(true);
        tanks[team].push(tank);
      }
    }
    // Red's tanks are blue's turned half a turn: the outcome must be too.
    for (let i = 0; i < 6; i++) {
      expect(tanks.se[i]!.x + tanks.nw[i]!.x).toBe(g.sim.size);
      expect(tanks.se[i]!.y + tanks.nw[i]!.y).toBe(g.sim.size);
    }
    for (let tick = 0; tick < 2; tick++) g.step();
    // The defender has nothing but the Spire: its own sight covers every tank, with no scan.
    for (const team of ['nw', 'se'] as const) for (const tank of tanks[team]) expect(g.sim.sees(slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2), tank)).toBe(true);
    const hp = (team: ArmyId): number => tanks[team].reduce((sum, e) => sum + Math.max(0, e.hp), 0);
    for (let tick = 0; tick < toTicks(6); tick++) g.step();
    for (const team of ['nw', 'se'] as const) {
      expect(hp(team)).toBeLessThan(6 * STATS.tank.hp);
      expect(g.sim.armies[slotOfArmyId(team, 2)]!.spire.surface.hp).toBeLessThan(STATS.spire.hp);
    }
    expect(hp('se')).toBe(hp('nw'));
    expect(g.sim.armies[BLUE]!.spire.surface.hp).toBe(g.sim.armies[RED]!.spire.surface.hp);
  });

  it('tanks moving through an enemy group stop at range and kill it without ever overlapping', () => {
    const g = arena();
    const tanks = [0, 1, 2, 3, 4, 5].map((i) => put(g, 'nw', 'tank', 10 + (i % 3) * 1.5, 22 + Math.floor(i / 3) * 1.5));
    const enemies = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => put(g, 'se', 'trooper', 24 + (i % 4) * 0.9, 22 + Math.floor(i / 4) * 0.9));
    expect(act(g, 'se', 'surface', { kind: 'stance', units: enemies.map((e) => id(g, 'se', e)), stance: 'hold' })).toEqual({ ok: true });
    expect(act(g, 'nw', 'surface', { kind: 'move', units: tanks.map((e) => id(g, 'nw', e)), x: 38, y: 23, mode: 'fight' })).toEqual({ ok: true });
    let closest = Infinity;
    let overlap = Infinity;
    const all = [...tanks, ...enemies];
    for (let t = 0; t < toTicks(40); t++) {
      g.step();
      for (const a of tanks) for (const b of enemies) if (!b.dead) closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      if (t > toTicks(1))
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++) if (!all[i]!.dead && !all[j]!.dead) overlap = Math.min(overlap, gap(all[i]!, all[j]!));
    }
    expect(enemies.every((e) => e.dead)).toBe(true);
    // Tanks (range 6) out-range troopers (range 4): they engage from range and never close in.
    expect(closest).toBeGreaterThan(STATS.trooper.range + 0.5);
    // Moves are simultaneous (each unit checks the start-of-tick bodies), so two tanks can each take one step into the
    // same gap before separation pushes them apart: never deeper than those two steps.
    expect(overlap).toBeGreaterThan(-2 * (STATS.tank.speed / TICK_RATE));
    // After the fight they resume the fight-move to the destination.
    expect(tanks.filter((e) => !e.dead).every((e) => Math.hypot(e.x - 38, e.y - 23) < 4)).toBe(true);
  });

  it('fixed-mount troopers fire no shots during a plain move', () => {
    const g = arena();
    const troopers = [0, 1].map((i) => put(g, 'nw', 'trooper', 10, 22 + i * 2));
    const enemy = put(g, 'se', 'trooper', 24, 30);
    enemy.hp = 1e6;
    act(g, 'se', 'surface', { kind: 'stance', units: [id(g, 'se', enemy)], stance: 'hold' });
    expect(act(g, 'nw', 'surface', { kind: 'move', units: troopers.map((e) => id(g, 'nw', e)), x: 38, y: 23, mode: 'move' })).toEqual({ ok: true });
    let shots = 0;
    for (let t = 0; t < toTicks(20); t++) {
      g.step();
      shots += g.sim.fx.filter((r) => r.fx.tick === g.tick && r.fx.kind === 'shot' && r.fx.side === BLUE).length;
    }
    expect(shots).toBe(0);
    expect(troopers.every((e) => Math.hypot(e.x - 38, e.y - 23) < 2.5)).toBe(true);
  });

  for (const hole of [HOLE.crater, HOLE.chasm]) {
    for (const team of ['nw', 'se'] as const) {
      it(`fight-move resumes when a Spire chase is blocked by hole ${hole} (${team})`, () => {
        const g = arena();
        const enemy = team === 'nw' ? 'se' : 'nw';
        const spire = g.sim.ents.find((e) => e.kind === 'spire' && e.side === slotOfArmyId(enemy, 2) && e.plane === 'surface')!;
        const direction = team === 'nw' ? -1 : 1;
        g.sim.openCells([cellFor(frameOf(team), spire.x, spire.y, g.sim.size)], hole, slotOfArmyId(team, 2));
        const u = put(g, team, 'trooper', spire.x + direction * 6, spire.y);
        u.hp = 1e6;
        g.step();
        g.step(); // refresh vision before issuing the order
        const x = spire.x + direction * 16;
        expect(act(g, team, 'surface', { kind: 'move', units: [id(g, team, u)], x, y: spire.y, mode: 'fight' })).toEqual({ ok: true });
        g.step();
        // Acquiring the same impossible target used to consume every tick and leave the line red indefinitely.
        expect(u.state).toBe('moving');
        expect(u.engage).toBe(0);
        expect(u.firing).toBe(false);
        for (let t = 0; t < toTicks(10); t++) {
          g.step();
          expect(g.sim.block[cellFor(frameOf(team), u.x, u.y, g.sim.size)]).toBe(0);
          expect(gap(u, spire)).toBeGreaterThanOrEqual(0);
        }
        expect([u.x, u.y]).toEqual([x, spire.y]);
        expect(u.order.k).toBe('none');
      });
    }
  }

  it('a plain retreat overrides a crowded Spire firing line', () => {
    const g = arena();
    const spire = g.sim.ents.find((e) => e.kind === 'spire' && e.side === RED && e.plane === 'surface')!;
    const units = Array.from({ length: 16 }, (_, i) => {
      const u = put(g, 'nw', 'trooper', spire.x - 5 - (i % 4) * 0.8, spire.y + (Math.floor(i / 4) - 1.5) * 0.8);
      u.hp = 1e6;
      return u;
    });
    for (let t = 0; t < toTicks(5); t++) g.step();
    expect(units.some((u) => u.firing)).toBe(true);
    const retreat = { kind: 'move', units: units.map((e) => id(g, 'nw', e)), x: spire.x - 20, y: spire.y } as const;
    expect(act(g, 'nw', 'surface', { ...retreat, mode: 'move' })).toEqual({ ok: true });
    for (let t = 0; t < toTicks(30); t++) {
      g.step();
      for (const u of units) {
        expect(u.engage).toBe(0);
        expect(u.firing).toBe(false);
        expect(g.sim.block[cellFor(u.side, u.x, u.y, g.sim.size)]).toBe(0);
        expect(gap(u, spire)).toBeGreaterThanOrEqual(0);
      }
    }
    expect(units.every((u) => u.x < spire.x - 12)).toBe(true);
  });
  for (const scenario of ['bomber', 'squad', 'advance', 'contact', 'arrival'] as const) {
    it(`${scenario}: fight-move respects direction and body contact (both teams, mirrored)`, () => {
      const g = arena();
      const movers: Record<'nw' | 'se', Ent[]> = { nw: [], se: [] };
      const targets: Record<'nw' | 'se', Ent> = {} as Record<'nw' | 'se', Ent>;
      for (const team of ['nw', 'se'] as const) {
        const enemy = team === 'nw' ? 'se' : 'nw';
        const target = scenario === 'bomber'
          ? g.sim.add('turret', slotOfArmyId(enemy, 2), 'surface', ...world(g, team, 26, 12))
          : put(g, enemy, 'trooper', ...world(g, team, scenario === 'contact' ? 19.5 : 23, 12));
        target.hp = 1e6;
        target.built = true;
        target.stance = 'hold';
        targets[team] = target;
        const count = scenario === 'squad' ? 3 : 1;
        for (let i = 0; i < count; i++) {
          const u = put(g, team, scenario === 'bomber' ? 'bomber' : 'tank', ...world(g, team, scenario === 'bomber' ? 26 : 18, 12 + i * 1.5));
          u.hp = 1e6;
          u.stance = 'hold';
          movers[team].push(u);
        }
      }
      for (let t = 0; t < toTicks(2); t++) g.step();
      for (const team of ['nw', 'se'] as const) {
        expect(movers[team].every((e) => e.firing)).toBe(true);
        const [x, y] = world(g, team, scenario === 'advance' ? 32 : scenario === 'arrival' ? 18 : 10, 12);
        expect(act(g, team, scenario === 'bomber' ? 'sky' : 'surface', { kind: 'move', units: movers[team].map((e) => id(g, team, e)), x, y, mode: 'fight' })).toEqual({ ok: true });
        for (const e of movers[team]) {
          expect(e.engage).toBe(0);
          expect(e.firing).toBe(false);
        }
      }
      for (let t = 0; t < toTicks(2); t++) {
        g.step();
        movers.nw.forEach((b, i) => {
          expect(movers.se[i]!.x).toBeCloseTo(g.sim.size - b.x, 10);
          expect(movers.se[i]!.y).toBeCloseTo(g.sim.size - b.y, 10);
        });
      }
      for (const team of ['nw', 'se'] as const) {
        for (const e of movers[team]) {
          if (scenario === 'bomber' || scenario === 'squad') {
            expect(e.engage).toBe(0);
            expect(e.firing).toBe(false);
            const [startX] = world(g, team, scenario === 'bomber' ? 26 : 18, 12);
            expect((startX - e.x) * (team === 'nw' ? 1 : -1)).toBeGreaterThan(2);
          } else {
            expect(e.engage).toBe(targets[team].id);
            expect(e.firing).toBe(true);
          }
        }
      }
    });
  }
});

describe('attack orders among holes', () => {
  const enemyOf = (team: ArmyId): ArmyId => (team === 'nw' ? 'se' : 'nw');
  const spireOf = (g: AgentCommandGame, team: ArmyId): Ent => g.sim.ents.find((e) => e.kind === 'spire' && e.side === slotOfArmyId(team, 2) && e.plane === 'surface')!;
  /** Open crater-sized discs (radius 1.5) at team-frame points, mirrored exactly for red. */
  function craters(g: AgentCommandGame, team: ArmyId, at: readonly (readonly [number, number])[], radius = 1.5): void {
    const size = g.sim.size, N = size * size;
    const cells: number[] = [];
    for (const [px, py] of at)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          if ((x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 > radius * radius) continue;
          const c = team === 'se' ? N - 1 - (y * size + x) : y * size + x;
          if (!g.sim.holes[c] && !cells.includes(c)) cells.push(c);
        }
    g.sim.openCells(cells, HOLE.crater, slotOfArmyId(team, 2));
  }
  /** Craters on the enemy Spire (team frame: always at 40, 40) and, with `ring`, eight more around it. */
  function crateredSpire(g: AgentCommandGame, team: ArmyId, ring: number): void {
    const at: [number, number][] = [[40, 40]];
    for (let k = 0; ring > 0 && k < 8; k++) at.push([40 + Math.cos((k * Math.PI) / 4) * ring, 40 + Math.sin((k * Math.PI) / 4) * ring]);
    craters(g, team, at);
  }
  /** Units around the enemy Spire (team frame offsets from 40, 40), on open ground, unkillable. */
  function squad(g: AgentCommandGame, team: ArmyId, spots: readonly (readonly [UnitKind, number, number])[]): Ent[] {
    return spots.map(([kind, dx, dy]) => {
      const [x, y] = world(g, team, 40 + dx, 40 + dy);
      const p = g.sim.openSurfaceNear(x, y, 3, slotOfArmyId(team, 2))!;
      const u = put(g, team, kind, p.x, p.y);
      u.hp = 1e6;
      return u;
    });
  }
  const SPOTS = [
    ['trooper', -9, 0],
    ['trooper', -6.4, -6.4],
    ['trooper', 0, -9],
    ['trooper', -13, -4],
    ['tank', -9, -3],
    ['tank', -3, -12],
    ['tank', 6, -5],
    ['trooper', 5, 6],
  ] as const satisfies readonly (readonly [UnitKind, number, number])[];

  for (const ring of [0, 3.5]) {
    it(`units ordered to attack a cratered enemy Spire reach a firing spot and fire, both teams mirrored (ring ${ring})`, () => {
      const g = arena();
      for (const team of ['nw', 'se'] as const) {
        spireOf(g, team).hp = 1e6;
        crateredSpire(g, team, ring);
      }
      // The Spire centre is a crater: the old chase toward it gave up at once and left the units idle.
      expect(g.sim.block[cellFor(frameOf('nw'), 40, 40, g.sim.size)]).toBe(1);
      const units = { nw: squad(g, 'nw', SPOTS), se: squad(g, 'se', SPOTS) };
      for (const team of ['nw', 'se'] as const) g.sim.armies[slotOfArmyId(team, 2)]!.scans.push({ ...spireOf(g, enemyOf(team)), until: 1e9 });
      g.step();
      g.step();
      for (const team of ['nw', 'se'] as const) {
        expect(act(g, team, 'surface', { kind: 'attack', units: units[team].map((e) => id(g, team, e)), target: id(g, team, spireOf(g, enemyOf(team))) })).toEqual({ ok: true });
      }
      const fired = new Set<Ent>();
      for (let t = 0; t < toTicks(40); t++) {
        g.step();
        for (const team of ['nw', 'se'] as const) for (const u of units[team]) if (u.firing) fired.add(u);
        units.nw.forEach((b, i) => {
          const r = units.se[i]!;
          expect(Math.abs(r.x - (g.sim.size - b.x))).toBeLessThan(1e-6);
          expect(Math.abs(r.y - (g.sim.size - b.y))).toBeLessThan(1e-6);
          expect(r.order.k).toBe(b.order.k);
        });
      }
      for (const team of ['nw', 'se'] as const) {
        for (const u of units[team]) {
          expect(fired.has(u)).toBe(true);
          expect(u.order.k).toBe('attack');
          expect(g.sim.inRange(u, spireOf(g, enemyOf(team)))).toBe(true);
        }
      }
      expect(spireOf(g, 'se').hp).toBe(spireOf(g, 'nw').hp);
      expect(spireOf(g, 'se').hp).toBeLessThan(1e6);
    });
  }

  for (const team of ['nw', 'se'] as const) {
    it(`an attack on a Spire cut off by a moat fails with no_path, and one cut off on the way says so (${team})`, () => {
      const g = arena();
      const spire = spireOf(g, enemyOf(team));
      spire.hp = 1e6;
      // Firing cells reach cannon range beyond the footprint (no siege bonus vs a Spire; farthest on its diagonals)
      // plus the high-ground bonus; the moat must cover all of them.
      const far = STATS.tank.range + SPIRE_CORNER + ECON.highRange;
      const start = far + 4;
      const units = squad(g, team, [['trooper', -start, -1], ['tank', -start, 1]]);
      g.sim.armies[slotOfArmyId(team, 2)]!.scans.push({ x: spire.x, y: spire.y, until: 1e9 });
      g.step();
      g.step();
      const order = { kind: 'attack', units: units.map((e) => id(g, team, e)), target: id(g, team, spire) } as const;
      expect(act(g, team, 'surface', order)).toEqual({ ok: true });
      for (let t = 0; t < toTicks(1); t++) g.step();
      // The moat extends beyond every firing cell; increasing reach must not weaken the unreachable-target check.
      const outer = far + 1;
      const moat: [number, number][] = [];
      for (let y = Math.floor(40 - outer); y < Math.ceil(40 + outer); y++) for (let x = Math.floor(40 - outer); x < Math.ceil(40 + outer); x++) {
        const distance = Math.hypot(x + 0.5 - 40, y + 0.5 - 40);
        if (distance >= 2 && distance <= outer) moat.push([x + 0.5, y + 0.5]);
      }
      craters(g, team, moat, 0.5);
      g.step();
      for (const u of units) expect(u.order.k).toBe('none');
      const events = g.sim.armies[slotOfArmyId(team, 2)]!.events.filter((e) => e.kind === 'target_unreachable');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ subject: 'spire', side: slotOfArmyId(team, 2), x: spire.x, y: spire.y });
      expect(g.sim.armies[slotOfArmyId(enemyOf(team), 2)]!.events.some((e) => e.kind === 'target_unreachable')).toBe(false);
      expect(act(g, team, 'surface', order)).toEqual({ ok: false, code: 'no_path' });
    });
  }

  for (const team of ['nw', 'se'] as const) {
    it(`a move into a pocket ringed by holes goes as close as it can instead of nowhere (${team})`, () => {
      const g = arena();
      const enemy = spireOf(g, enemyOf(team));
      enemy.hp = 1e6;
      crateredSpire(g, team, 3.5);
      const [u] = squad(g, team, [['trooper', -12, 0]]);
      const [x, y] = world(g, team, 40, 41.6); // open ground inside the ring, cut off from outside
      expect(g.sim.block[cellFor(frameOf(team), x, y, g.sim.size)]).toBe(0);
      const sealed = g.sim.flows[slotOfArmyId(team, 2)]!.get(cellFor(frameOf(team), x, y, g.sim.size), frameOf(team), g.sim.holesVersion, g.tick);
      expect(sealed[cellFor(frameOf(team), u!.x, u!.y, g.sim.size)]).toBe(Infinity);
      expect(act(g, team, 'surface', { kind: 'move', units: [id(g, team, u!)], x, y, mode: 'move' })).toEqual({ ok: true });
      expect(u!.order.k).toBe('move');
      const start = Math.hypot(u!.x - x, u!.y - y);
      for (let t = 0; t < toTicks(20); t++) g.step();
      expect(u!.order.k).toBe('none');
      expect(Math.hypot(u!.x - x, u!.y - y)).toBeLessThan(start - 5);
    });
  }
});

describe('units that used to get stuck', () => {
  /** Unkillable unit at a team-frame point. */
  const at = (g: AgentCommandGame, team: ArmyId, kind: UnitKind, x: number, y: number): Ent => {
    const u = put(g, team, kind, ...world(g, team, x, y));
    u.hp = 1e6;
    return u;
  };
  const mirrored = (g: AgentCommandGame, blue: readonly Ent[], red: readonly Ent[]): void =>
    blue.forEach((b, i) => {
      expect(Math.abs(red[i]!.x - (g.sim.size - b.x))).toBeLessThan(1e-6);
      expect(Math.abs(red[i]!.y - (g.sim.size - b.y))).toBeLessThan(1e-6);
    });

  it('units sent onto a spot a crowd already stands on settle around it instead of pressing on (both teams, mirrored)', () => {
    const g = arena();
    const movers: Record<'nw' | 'se', Ent[]> = { nw: [], se: [] };
    for (const team of ['nw', 'se'] as const) {
      for (let i = 0; i < 12; i++) at(g, team, 'trooper', 24 + ((i % 4) - 1.5) * 0.72, 14 + (Math.floor(i / 4) - 1) * 0.72);
      for (let i = 0; i < 6; i++) movers[team].push(at(g, team, 'trooper', 14 + (i % 3) * 0.9, 13 + Math.floor(i / 3) * 0.9));
      movers[team].push(at(g, team, 'tank', 12, 14), at(g, team, 'tank', 12, 15.5));
      const [x, y] = world(g, team, 24, 14);
      expect(act(g, team, 'surface', { kind: 'move', units: movers[team].map((e) => id(g, team, e)), x, y, mode: 'move' })).toEqual({ ok: true });
    }
    for (let t = 0; t < toTicks(15); t++) {
      g.step();
      mirrored(g, movers.nw, movers.se);
    }
    for (const team of ['nw', 'se'] as const) {
      const [x, y] = world(g, team, 24, 14);
      for (const u of movers[team]) {
        // Arrived (no order left) beside the crowd, not hovering at its edge with the move still open.
        expect(u.order.k).toBe('none');
        expect(Math.hypot(u.x - x, u.y - y)).toBeLessThan(3.5);
      }
    }
  });

  it('a unit boxed in by idle friends in a corridor shoves through them (both teams, mirrored)', () => {
    const g = arena();
    const tanks: Record<'nw' | 'se', Ent[]> = { nw: [], se: [] };
    const cells: number[] = [];
    for (const team of ['nw', 'se'] as const) {
      // A three-cell corridor (rows 12-14) between hole walls, with a resting squad filling its middle. The teams'
      // corridors lie far apart (no fighting across them). Full hulls stay clear of holes: the squad's two
      // rows can make way on both sides of a tank (0.7 + 1.2 + 0.7 tiles) only in three cells; in the two the test had
      // when centres alone kept off holes, the troopers' hulls overhung the walls to let it by.
      for (let x = 8; x <= 36; x++) for (const y of [11, 15]) cells.push(cellFor(frameOf(team), ...world(g, team, x + 0.5, y + 0.5), g.sim.size));
      tanks[team].push(at(g, team, 'tank', 12, 13.5));
    }
    g.sim.openCells(cells, HOLE.chasm, NEUTRAL);
    const squads = { nw: [] as Ent[], se: [] as Ent[] };
    for (const team of ['nw', 'se'] as const) {
      for (let i = 0; i < 6; i++) squads[team].push(at(g, team, 'trooper', 21.5 + (i % 3) * 0.75, 13.05 + Math.floor(i / 3) * 0.9));
      const [x, y] = world(g, team, 32, 13.5);
      expect(act(g, team, 'surface', { kind: 'move', units: tanks[team].map((e) => id(g, team, e)), x, y, mode: 'move' })).toEqual({ ok: true });
    }
    let shoved = false;
    for (let t = 0; t < toTicks(30); t++) {
      g.step();
      shoved ||= tanks.nw[0]!.shove > 0;
      mirrored(g, [...tanks.nw, ...squads.nw], [...tanks.se, ...squads.se]);
    }
    // Boxed in: neither side of the squad leaves its hull a way past without shoving.
    expect(shoved).toBe(true);
    for (const team of ['nw', 'se'] as const) {
      const [x, y] = world(g, team, 32, 13.5);
      expect(tanks[team][0]!.order.k).toBe('none');
      expect(Math.hypot(tanks[team][0]!.x - x, tanks[team][0]!.y - y)).toBeLessThan(0.5);
      // The squad stepped aside to let it pass (not bulldozed down the corridor, never into the holes).
      squads[team].forEach((u, i) => {
        const [sx, sy] = world(g, team, 21.5 + (i % 3) * 0.75, 13.05 + Math.floor(i / 3) * 0.9);
        expect(Math.hypot(u.x - sx, u.y - sy)).toBeLessThan(1.5);
        expect(g.sim.block[cellFor(frameOf(team), u.x, u.y, g.sim.size)]).toBe(0);
      });
    }
  });

  it('a depths unit replanned mid-step finishes the step instead of turning back (chasers used to swing in place)', () => {
    const g = createGame({ seed: 5 });
    const s = g.sim;
    // A straight run of three open tunnel cells: west, middle, east.
    let c = -1;
    for (let n = s.size + 1; n < s.size * s.size - s.size - 1 && c < 0; n++) if ([n - 1, n, n + 1].every((k) => isOpenCell(s.cells[k]!) && s.armies[BLUE]!.group.known[k] === s.cells[k])) c = n;
    expect(c).toBeGreaterThan(0);
    const u = s.spawnUnit(BLUE, 'trooper', 'depths');
    u.cell = c;
    u.x = (c % s.size) + 0.8; // 0.3 of the way toward the east cell
    u.y = Math.floor(c / s.size) + 0.5;
    u.path = [c + 1];
    u.pathI = 0;
    expect(s.planDepths(u, c - 1, false)).toBe(true);
    expect(u.path).toEqual([c + 1, c, c - 1]);
    // At a cell centre it plans straight from there.
    u.x = (c % s.size) + 0.5;
    expect(s.planDepths(u, c - 1, false)).toBe(true);
    expect(u.path).toEqual([c - 1]);
  });
});

describe('stances', () => {
  it('defensive units chase within their leash, then return to their post', () => {
    const g = arena();
    const guard = put(g, 'nw', 'trooper', 20, 20);
    act(g, 'nw', 'surface', { kind: 'stance', units: [id(g, 'nw', guard)], stance: 'defensive' });
    g.step();
    g.step();
    const bait = put(g, 'se', 'tank', 25.2, 20);
    bait.hp = 1e6;
    act(g, 'se', 'surface', { kind: 'move', units: [id(g, 'se', bait)], x: 44, y: 20, mode: 'move' });
    let far = 0;
    for (let t = 0; t < toTicks(25); t++) {
      g.step();
      far = Math.max(far, Math.hypot(guard.x - 20, guard.y - 20));
    }
    expect(far).toBeGreaterThan(0.5); // it did give chase
    expect(far).toBeLessThanOrEqual(LEASH.defensive + STATS.trooper.range + 1);
    expect(Math.hypot(guard.x - 20, guard.y - 20)).toBeLessThan(1.6);
  });

  it('hold units never move; they only shoot what is in range', () => {
    const g = arena();
    const post = put(g, 'nw', 'trooper', 20, 20);
    act(g, 'nw', 'surface', { kind: 'stance', units: [id(g, 'nw', post)], stance: 'hold' });
    const near = put(g, 'se', 'trooper', 25, 20); // inside acquisition, outside rifle range
    near.hp = 1e6;
    act(g, 'se', 'surface', { kind: 'stance', units: [id(g, 'se', near)], stance: 'hold' });
    for (let t = 0; t < toTicks(10); t++) g.step();
    expect([post.x, post.y]).toEqual([20, 20]);
    expect(near.hp).toBe(1e6);
  });
});

describe('projectiles', () => {
  it('a shell lands after its flight time, carries the arrival tick, and splashes neighbours', () => {
    const g = arena();
    const tank = put(g, 'nw', 'tank', 20, 20);
    act(g, 'nw', 'surface', { kind: 'stance', units: [id(g, 'nw', tank)], stance: 'hold' });
    const target = put(g, 'se', 'trooper', 25.5, 20);
    const beside = put(g, 'se', 'trooper', 25.5, 20.75);
    for (const e of [target, beside]) act(g, 'se', 'surface', { kind: 'stance', units: [id(g, 'se', e)], stance: 'hold' });
    let shot: { tick: number; arrive?: number } | undefined;
    for (let t = 0; t < toTicks(3) && !shot; t++) {
      g.step();
      shot = g.sim.fx.find((r) => r.fx.kind === 'shot' && r.fx.subject === 'tank')?.fx;
    }
    expect(shot).toBeDefined();
    const flight = Math.ceil(5.5 / (STATS.tank.projectileSpeed / TICK_RATE));
    expect(shot!.arrive! - shot!.tick).toBeGreaterThanOrEqual(flight - 1);
    const hp0 = target.hp + beside.hp;
    while (g.tick < shot!.arrive! - 1) g.step();
    expect(target.hp + beside.hp).toBe(hp0); // still in flight
    g.step();
    expect(target.hp).toBeCloseTo(100 - STATS.tank.dmg * DAMAGE_VS.cannon.light, 6);
    expect(beside.hp).toBeLessThan(100); // splash
  });

  it('unguided shells miss a target that moved away; damage follows the armor table', () => {
    const g = arena();
    // The runner is already at full speed when the tank first sees it.
    const runner = put(g, 'se', 'trooper', 25.6, 19);
    act(g, 'se', 'surface', { kind: 'move', units: [id(g, 'se', runner)], x: 25.6, y: 40, mode: 'move' });
    for (let t = 0; t < toTicks(0.5); t++) g.step();
    const tank = put(g, 'nw', 'tank', 20, 20);
    act(g, 'nw', 'surface', { kind: 'stance', units: [id(g, 'nw', tank)], stance: 'hold' });
    let landed = 0;
    const shots: number[] = [];
    for (let t = 0; t < toTicks(3); t++) {
      g.step();
      for (const r of g.sim.fx) if (r.fx.kind === 'shot' && r.fx.subject === 'tank' && r.fx.tick === g.tick) shots.push(r.fx.arrive!);
      landed = shots.filter((a) => a <= g.tick).length;
    }
    expect(landed).toBeGreaterThan(0);
    expect(runner.hp).toBe(100);
    // Rifles barely scratch armor.
    const g2 = arena();
    const rifle = put(g2, 'nw', 'trooper', 20, 20);
    const armor = put(g2, 'se', 'tank', 23, 20);
    for (const [team, e] of [['nw', rifle], ['se', armor]] as const) act(g2, team, 'surface', { kind: 'stance', units: [id(g2, team, e)], stance: 'hold' });
    armor.hp = 1000;
    let hits = 0;
    for (let t = 0; t < toTicks(2); t++) {
      g2.step();
      hits += g2.sim.fx.filter((r) => r.fx.tick === g2.tick && r.fx.kind === 'shot' && r.fx.subject === 'trooper').length;
    }
    expect(hits).toBeGreaterThan(0);
    expect(1000 - armor.hp).toBeCloseTo(hits * STATS.trooper.dmg * DAMAGE_VS.rifle.armored, 6);
  });

  it('no overkill: a volley spreads over targets instead of wasting shells on a doomed one', () => {
    const g = arena();
    const tanks = [0, 1, 2, 3].map((i) => put(g, 'nw', 'tank', 20, 18 + i * 1.3));
    act(g, 'nw', 'surface', { kind: 'stance', units: tanks.map((e) => id(g, 'nw', e)), stance: 'hold' });
    const a = put(g, 'se', 'trooper', 25, 19);
    const b = put(g, 'se', 'trooper', 25, 21);
    a.hp = b.hp = 20;
    for (const e of [a, b]) act(g, 'se', 'surface', { kind: 'stance', units: [id(g, 'se', e)], stance: 'hold' });
    let firstTick = -1;
    for (let t = 0; t < toTicks(2) && firstTick < 0; t++) {
      g.step();
      if (g.sim.fx.some((r) => r.fx.kind === 'shot' && r.fx.subject === 'tank')) firstTick = g.tick;
    }
    const volley = g.sim.fx.filter((r) => r.fx.kind === 'shot' && r.fx.subject === 'tank' && r.fx.tick === firstTick);
    expect(volley).toHaveLength(2);
    expect(new Set(volley.map((r) => `${r.fx.tx},${r.fx.ty}`)).size).toBe(2);
    for (let t = 0; t < toTicks(1.5); t++) g.step();
    expect(a.dead && b.dead).toBe(true);
  });
});

describe('formations and separation', () => {
  it('a stacked group arrives spread out around the destination', () => {
    const g = arena();
    const squad = Array.from({ length: 12 }, () => put(g, 'nw', 'trooper', 15, 15));
    act(g, 'nw', 'surface', { kind: 'move', units: squad.map((e) => id(g, 'nw', e)), x: 30, y: 30, mode: 'move' });
    for (let t = 0; t < toTicks(15); t++) g.step();
    for (let i = 0; i < squad.length; i++) for (let j = i + 1; j < squad.length; j++) expect(gap(squad[i]!, squad[j]!)).toBeGreaterThan(-0.06);
    for (const e of squad) expect(Math.hypot(e.x - 30, e.y - 30)).toBeLessThan(3.5);
  });

  it('an overlapping idle cluster settles within ~2 s and then stays perfectly still', () => {
    const g = arena();
    const blob = Array.from({ length: 20 }, (_, i) => put(g, 'nw', i % 3 ? 'trooper' : 'tank', 20 + (i % 5) * 0.2, 20 + Math.floor(i / 5) * 0.2));
    for (let t = 0; t < toTicks(2.5); t++) g.step();
    const settled = blob.map((e) => [e.x, e.y]);
    for (let t = 0; t < toTicks(10); t++) g.step();
    expect(blob.map((e) => [e.x, e.y])).toEqual(settled);
    for (let i = 0; i < blob.length; i++) for (let j = i + 1; j < blob.length; j++) expect(gap(blob[i]!, blob[j]!)).toBeGreaterThan(-0.06);
  });

  it('escapes opposing structure contacts without bouncing between their corrections', () => {
    const g = arena();
    const unit = put(g, 'nw', 'tank', 20.1, 20.01);
    // New construction can overlap a unit. These shafts leave room to escape upward, but initially both push
    // the tank sideways toward the gap's centre. Summing two full corrections makes it overshoot that centre.
    const shafts = [18.8, 21.2].map((x) => {
      const shaft = g.sim.build(BLUE, 'shaft', x, 20, 'surface');
      shaft.built = true;
      shaft.progress = -1;
      return shaft;
    });
    let previous = { dx: 0, dy: 0 };
    let reversals = 0;
    for (let t = 0; t < toTicks(5); t++) {
      const x = unit.x;
      const y = unit.y;
      g.step();
      const dx = unit.x - x;
      const dy = unit.y - y;
      const speed = Math.hypot(dx, dy);
      const before = Math.hypot(previous.dx, previous.dy);
      if (before > 0.02 && speed > 0 && (dx * previous.dx + dy * previous.dy) / (speed * before) < -0.2) reversals++;
      previous = { dx, dy };
    }
    expect(reversals).toBe(0);
    for (const shaft of shafts) expect(gap(unit, shaft)).toBeGreaterThan(-0.05);
  });

  it('a group moving in formation does not jitter (no velocity sign flips)', () => {
    const g = arena();
    const squad = Array.from({ length: 12 }, (_, i) => put(g, 'nw', i % 2 ? 'trooper' : 'tank', 12 + (i % 4) * 1.4, 20 + Math.floor(i / 4) * 1.4));
    act(g, 'nw', 'surface', { kind: 'move', units: squad.map((e) => id(g, 'nw', e)), x: 34, y: 22, mode: 'move' });
    const last = squad.map((e) => [e.x, e.y]);
    const sign = squad.map(() => [0, 0]);
    let flips = 0;
    for (let t = 0; t < toTicks(15); t++) {
      g.step();
      squad.forEach((e, i) => {
        for (const k of [0, 1] as const) {
          const v = (k === 0 ? e.x : e.y) - last[i]![k]!;
          // Sub-millimetre avoidance corrections are not jitter: count flips of real motion (≥ 0.02 tiles/s).
          const sg = Math.abs(v) < 1e-3 ? 0 : Math.sign(v);
          if (sg !== 0 && sign[i]![k] !== 0 && sg !== sign[i]![k]) flips++;
          if (sg !== 0) sign[i]![k] = sg;
        }
        last[i] = [e.x, e.y];
      });
    }
    expect(flips).toBe(0);
    // Same speed as the slowest member while travelling together.
    expect(squad.every((e) => Math.hypot(e.x - 34, e.y - 22) < 3.5)).toBe(true);
  });

  it.each(['trooper', 'flak', 'tank'] as const)('%s keeps a smooth avoidance curve when entering a forest', (kind) => {
    const g = arena();
    for (let y = 0; y < g.sim.size; y++) {
      for (let x = 16; x < g.sim.size; x++) g.sim.terrain[y * g.sim.size + x] = SURFACE.forest;
    }
    const unit = put(g, 'nw', kind, 13, 20);
    const obstacle = put(g, 'nw', 'tank', 16.5, 19.5);
    act(g, 'nw', 'surface', { kind: 'stance', units: [id(g, 'nw', obstacle)], stance: 'hold' });
    expect(act(g, 'nw', 'surface', { kind: 'move', units: [id(g, 'nw', unit)], x: 24, y: 20, mode: 'move' })).toEqual({ ok: true });
    let previous = { dx: 0, dy: 0, lateral: 0 };
    let flips = 0;
    let closest = Infinity;
    for (let t = 0; t < toTicks(15); t++) {
      const x = unit.x;
      const y = unit.y;
      g.step();
      const dx = unit.x - x;
      const dy = unit.y - y;
      const speed = Math.hypot(previous.dx, previous.dy);
      const lateral = speed > 0.02 ? (previous.dx * dy - previous.dy * dx) / speed : 0;
      // Keeping the old absolute avoidance bend when the forest reduces speed makes the unit oversteer,
      // then turn back on the next tick. Measure actual displacement, including collision separation.
      if (Math.abs(lateral) > 0.003 && Math.abs(previous.lateral) > 0.003 && lateral * previous.lateral < 0) flips++;
      previous = { dx, dy, lateral };
      closest = Math.min(closest, gap(unit, obstacle));
    }
    expect(flips).toBe(0);
    expect(closest).toBeGreaterThan(-0.05);
    expect(Math.hypot(unit.x - 24, unit.y - 20)).toBeLessThan(0.05);
  });
});

describe('orders', () => {
  it('queued orders run in sequence and show as waypoints; patrol alternates; rally sends new units', () => {
    const g = arena();
    const u = put(g, 'nw', 'trooper', 12, 20);
    act(g, 'nw', 'surface', { kind: 'move', units: [id(g, 'nw', u)], x: 16, y: 20, mode: 'move' });
    act(g, 'nw', 'surface', { kind: 'move', units: [id(g, 'nw', u)], x: 16, y: 26, mode: 'move', queue: true });
    const seen = g.view('nw').entities.find((e) => e.id === id(g, 'nw', u))!;
    expect(seen.queue).toBe(1);
    // An order point on cell edges is presented one view-grid step toward the map centre (never on an edge).
    expect(seen.wp).toEqual([{ x: 16 + 1 / VIEW_GRID, y: 26 - 1 / VIEW_GRID }]);
    for (let t = 0; t < toTicks(5); t++) g.step();
    expect(Math.hypot(u.x - 16, u.y - 26)).toBeLessThan(0.05);

    act(g, 'nw', 'surface', { kind: 'patrol', units: [id(g, 'nw', u)], x: 22, y: 26 });
    let reachedB = false;
    let backAtA = false;
    for (let t = 0; t < toTicks(8); t++) {
      g.step();
      if (Math.hypot(u.x - 22, u.y - 26) < 0.05) reachedB = true;
      if (reachedB && Math.hypot(u.x - 16, u.y - 26) < 0.05) backAtA = true;
    }
    expect(reachedB && backAtA).toBe(true);

    expect(act(g, 'nw', 'surface', { kind: 'rally', x: 14, y: 14 })).toEqual({ ok: true });
    // Every segment has a rally (the defaults); the player's replaces the Surface one (on cell edges, presented one
    // view-grid step toward the map centre).
    expect(g.view('nw').rally.find((r) => r.plane === 'surface')).toEqual({ plane: 'surface', x: 14 + 1 / VIEW_GRID, y: 14 + 1 / VIEW_GRID });
    expect(g.view('nw').rally.map((r) => r.plane)).toEqual(['depths', 'surface', 'sky', 'orbit']);
    act(g, 'nw', 'surface', { kind: 'queue_add', item: 'trooper' });
    for (let t = 0; t < STATS.trooper.build + 1; t++) g.step();
    const fresh = g.sim.ents.find((e) => e.side === BLUE && e.kind === 'trooper' && e !== u)!;
    // The only unit headed there takes the front slot: the rally point itself.
    expect(fresh.order).toMatchObject({ k: 'move', x: 14, y: 14, fight: true });
    for (let t = 0; t < toTicks(10) && fresh.order.k !== 'none'; t++) g.step();
    expect(Math.hypot(fresh.x - 14, fresh.y - 14)).toBeLessThan(0.05);
  });
});

describe('turrets: upkeep and siege range', () => {
  /** Built turrets of `team` at the given cell centres. */
  const turrets = (g: AgentCommandGame, team: ArmyId, at: [number, number][]): Ent[] => {
    const out = at.map(([x, y]) => g.sim.build(slotOfArmyId(team, 2), 'turret', x, y, 'surface'));
    for (let i = 0; i <= STATS.turret.build; i++) g.step();
    for (const t of out) expect(t.built).toBe(true);
    return out;
  };

  it('each built turret draws ECON.turretUpkeep energy/s; a team that cannot pay has every turret offline', () => {
    const g = arena();
    const ring = turrets(g, 'nw', [[14.5, 20.5], [16.5, 20.5], [18.5, 20.5], [20.5, 20.5]]);
    const t = g.sim.armies[BLUE]!;
    t.energy = 10;
    for (let i = 0; i < TICK_RATE; i++) g.step();
    expect(t.energy).toBeCloseTo(10 - 4 * ECON.turretUpkeep, 6);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).res.upkeep).toBe(4 * ECON.turretUpkeep);
    // Out of energy: offline (state idle) and silent, even with an enemy in range.
    t.energy = 0;
    g.step(); // the upkeep is settled at the end of a tick: offline from the next one
    const raider = put(g, 'se', 'trooper', 17.5, 23.5);
    act(g, 'se', 'surface', { kind: 'stance', units: [id(g, 'se', raider)], stance: 'hold' });
    for (let i = 0; i < toTicks(3); i++) g.step();
    for (const r of ring) expect(r.state).toBe('idle');
    expect(raider.hp).toBe(raider.maxHp);
    // Paid again: back online and firing.
    t.energy = 100;
    for (let i = 0; i < toTicks(3); i++) g.step();
    for (const r of ring) expect(r.state).toBe('active');
    expect(raider.hp).toBeLessThan(raider.maxHp);
  });

  it('tanks out-range turrets (siege range) and shell them without being hit back', () => {
    const g = arena();
    const [turret] = turrets(g, 'se', [[30.5, 24.5]]);
    g.sim.armies[RED]!.energy = 1000;
    const reach = STATS.tank.range + ECON.siegeRange + turret!.radius;
    expect(reach).toBeGreaterThan(STATS.turret.range + STATS.tank.radius + 0.5);
    const tank = put(g, 'nw', 'tank', 30.5 - (reach - 0.4), 24.5);
    act(g, 'nw', 'surface', { kind: 'stance', units: [id(g, 'nw', tank)], stance: 'hold' });
    for (let i = 0; i < toTicks(10); i++) g.step();
    expect(turret!.hp).toBeLessThan(turret!.maxHp);
    expect(tank.hp).toBe(tank.maxHp);
  });
});
