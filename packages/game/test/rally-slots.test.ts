/**
 * Rally points and destination slots: default rallies stand past the Spire footprint toward the centre, new units
 * leave by the side facing the rally and line up in size-scaled slots, and multi-unit moves give every unit its own
 * slot. Every case runs for both teams and checks the exact mirror.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, ECON, MAP_SIZES, PLANES, PRODUCED_UNITS, STATS, TERRAIN_PRESETS, footprintDistance, isOpenCell, toTicks, type Plane, type ArmyId, type ProducedUnit } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { cellOf } from '../src/util/grid.ts';
import { type Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

/** Only the Spires and islands left (and the derelict ruin unless `ruin` is false: it fills the S48 centre). */
function arena(seed: number, terrain: (typeof TERRAIN_PRESETS)[number] = 'open', size: number = DEFAULT_RULES.map.size, ruin = true): AgentCommandGame {
  const g = createGame({ seed, options: { terrain, map: { params: { size } }, orbit: { derelictEnabled: ruin }, queue: { seatMax: 10 } } });
  for (const e of g.sim.ents) if (e.unit) e.hp = 0;
  g.step();
  return g;
}

/** Deepest overlap among `us` (tiles; ≤ 0 means apart). */
function overlap(us: readonly Ent[]): number {
  let worst = -Infinity;
  for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) {
    worst = Math.max(worst, us[i]!.radius + us[j]!.radius - Math.hypot(us[i]!.x - us[j]!.x, us[i]!.y - us[j]!.y));
  }
  return worst;
}

function expectMirrored(g: AgentCommandGame, blue: readonly Ent[], red: readonly Ent[]): void {
  expect(red).toHaveLength(blue.length);
  blue.forEach((b, i) => {
    expect(red[i]!.x).toBe(g.sim.size - b.x);
    expect(red[i]!.y).toBe(g.sim.size - b.y);
  });
}

/** Separation leaves overlaps shallower than this alone (sim SEP_DEADBAND): bodies brushing past each other. */
const BRUSH = 0.05;

describe('default rally points', () => {
  it('stand past the Spire footprint toward the centre on open ground, mirrored, on every preset and size', () => {
    for (const size of MAP_SIZES) for (const terrain of TERRAIN_PRESETS) {
      const g = arena(3, terrain, size);
      const s = g.sim;
      const f = STATS.spire.footprint;
      for (const plane of PLANES) {
        const blue = s.armies[slotOfArmyId('nw', 2)]!.rally[plane];
        const red = s.armies[slotOfArmyId('se', 2)]!.rally[plane];
        expect(red.x, `${terrain}/${size}/${plane}`).toBe(s.size - blue.x);
        expect(red.y).toBe(s.size - blue.y);
        const p = s.spireAt[slotOfArmyId('nw', 2)]!;
        // Outside the footprint, on the map-centre side of the Spire.
        expect(Math.max(Math.abs(blue.x - p.x) - f.w / 2, Math.abs(blue.y - p.y) - f.h / 2)).toBeGreaterThan(0);
        expect((blue.x - p.x) * (s.size / 2 - p.x) + (blue.y - p.y) * (s.size / 2 - p.y)).toBeGreaterThan(0);
        const c = cellOf(blue.x, blue.y, s.size);
        if (plane === 'surface') expect(s.block[c], `${terrain}/${size} surface rally on blocked ground`).toBe(0);
        if (plane === 'depths') expect(isOpenCell(s.armies[slotOfArmyId('nw', 2)]!.group.known[c]!)).toBe(true);
      }
      // The Surface rally sits rules.movement.surfaceRally past the footprint edge when that ground is open.
      if (terrain === 'open' && size === DEFAULT_RULES.map.size) {
        const r = s.armies[slotOfArmyId('nw', 2)]!.rally.surface;
        const p = s.spireAt[slotOfArmyId('nw', 2)]!;
        expect(Math.hypot(r.x - p.x, r.y - p.y)).toBeCloseTo(f.w / 2 * Math.SQRT2 + ECON.surfaceRally, 1);
      }
    }
  });
});

describe('production at the rally', () => {
  /** Queue `n` units through their output role, respecting the wire's five-unit batch maximum. */
  function produce(g: AgentCommandGame, team: ArmyId, kind: ProducedUnit, n: number): void {
    const t = g.sim.armies[slotOfArmyId(team, 2)]!;
    t.alloy = t.energy = 1e6;
    let left = n;
    while (left > 0) {
      const count = Math.min(left, 5);
      expect(g.apply({ team, role: STATS[kind].plane }, { kind: 'queue_add', item: kind, count })).toEqual({ ok: true });
      left -= count;
    }
  }

  for (const rally of ['default', 'player'] as const) {
    it(`10 tanks produced in a row never pile up or get stuck and settle in their own slots (${rally} rally)`, () => {
      const g = arena(7, 'ridges');
      const s = g.sim;
      for (const team of (['nw', 'se'] as const)) {
        if (rally === 'player') {
          const [x, y] = team === 'nw' ? [12, 10] : [s.size - 12, s.size - 10];
          expect(g.apply({ team, role: 'surface' }, { kind: 'rally', x, y })).toEqual({ ok: true });
        }
        produce(g, team, 'tank', 10);
      }
      const slots = new Map<number, [number, number]>();
      let brush = 0;
      let settledAt = -1;
      const tanks = (team: ArmyId): Ent[] => s.ents.filter((e) => !e.dead && e.kind === 'tank' && e.side === slotOfArmyId(team, 2));
      const limit = 10 * STATS.tank.build + toTicks(60);
      for (let t = 0; t < limit && settledAt < 0; t++) {
        g.step();
        const blue = tanks('nw');
        for (const e of blue) if (e.order.k === 'move' && !slots.has(e.id)) slots.set(e.id, [e.order.x, e.order.y]);
        brush = Math.max(brush, overlap(blue));
        if (blue.length === 10 && blue.every((e) => e.order.k === 'none')) settledAt = t;
      }
      // Settled: every tank produced, idle and standing exactly on its own slot.
      expect(settledAt).toBeGreaterThan(0);
      const blue = tanks('nw');
      for (const e of blue) {
        const [x, y] = slots.get(e.id)!;
        expect(Math.hypot(e.x - x, e.y - y)).toBeLessThan(1e-6);
      }
      // Slots never overlap; moving tanks only brush past within the separation tolerance.
      expect(overlap(blue)).toBeLessThanOrEqual(0);
      expect(brush).toBeLessThan(BRUSH);
      expectMirrored(g, blue, tanks('se'));
      // A short while later nobody has moved: no oscillation.
      const before = blue.map((e) => [e.x, e.y]);
      for (let t = 0; t < toTicks(5); t++) g.step();
      blue.forEach((e, i) => expect([e.x, e.y]).toEqual(before[i]));
    });
  }

  it('consecutive spawns leave by different free exits, facing the rally first, never stacked', () => {
    const g = arena(4);
    const s = g.sim;
    const out: Record<'nw' | 'se', Ent[]> = { nw: [], se: [] };
    // Eight at once (nobody has walked off yet): the facing exits fill first, then the others; none overlap.
    for (const team of (['nw', 'se'] as const)) for (let i = 0; i < 8; i++) out[team].push(s.spawnUnit(slotOfArmyId(team, 2), 'tank', 'surface'));
    for (const team of (['nw', 'se'] as const)) {
      const p = s.spireAt[slotOfArmyId(team, 2)]!;
      const r = s.armies[slotOfArmyId(team, 2)]!.rally.surface;
      expect(overlap(out[team])).toBeLessThanOrEqual(0);
      for (const e of out[team]) expect(footprintDistance('spire', p.x, p.y, e.x, e.y)).toBeGreaterThanOrEqual(e.radius);
      for (const e of out[team].slice(0, 3)) expect((e.x - p.x) * (r.x - p.x) + (e.y - p.y) * (r.y - p.y)).toBeGreaterThan(0);
    }
    expectMirrored(g, out.nw, out.se);
  });
});

describe('multi-unit moves spread destinations by unit size', () => {
  const cases: { kind: ProducedUnit; n: number; plane: Plane; settle: number }[] = [
    { kind: 'bastion', n: 2, plane: 'orbit', settle: 60 },
    { kind: 'tank', n: 6, plane: 'surface', settle: 30 },
    { kind: 'trooper', n: 12, plane: 'surface', settle: 30 },
  ];
  for (const { kind, n, plane, settle } of cases) {
    it(`${n} ${kind}s moved to one point end in non-overlapping slots without oscillating, mirrored`, () => {
      const g = arena(5, 'open', DEFAULT_RULES.map.size, false); // open Orbit: the ruin is covered elsewhere
      const s = g.sim;
      const groups: Record<'nw' | 'se', Ent[]> = { nw: [], se: [] };
      for (const team of (['nw', 'se'] as const)) {
        for (let i = 0; i < n; i++) {
          const e = s.spawnUnit(slotOfArmyId(team, 2), kind, plane);
          // A loose block well away from the other team, mirrored.
          const bx = 10 + (i % 4) * 1.5;
          const by = 10 + Math.floor(i / 4) * 1.5;
          e.x = team === 'nw' ? bx : s.size - bx;
          e.y = team === 'nw' ? by : s.size - by;
          groups[team].push(e);
        }
      }
      g.step();
      for (const team of (['nw', 'se'] as const)) {
        const x = team === 'nw' ? 14 : s.size - 14;
        const y = team === 'nw' ? 22 : s.size - 22;
        expect(g.apply({ team, role: plane }, { kind: 'move', units: groups[team].map((e) => g.entityId(team, e.id)), x, y })).toEqual({ ok: true });
      }
      const blue = groups.nw;
      const slots = blue.map((e) => (e.order.k === 'move' ? [e.order.x, e.order.y] as const : [NaN, NaN] as const));
      // Every unit has its own slot, clear of the others by its size.
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        expect(Math.hypot(slots[i]![0] - slots[j]![0], slots[i]![1] - slots[j]![1])).toBeGreaterThanOrEqual(blue[i]!.radius + blue[j]!.radius + ECON.slotGap - 1e-6);
      }
      let settledAt = -1;
      for (let t = 0; t < toTicks(settle) && settledAt < 0; t++) {
        g.step();
        if (blue.every((e) => e.order.k === 'none')) settledAt = t;
      }
      expect(settledAt).toBeGreaterThan(0);
      expect(blue.every((e) => !e.dead)).toBe(true);
      blue.forEach((e, i) => expect(Math.hypot(e.x - slots[i]![0], e.y - slots[i]![1])).toBeLessThan(0.05));
      expect(overlap(blue)).toBeLessThanOrEqual(0);
      expectMirrored(g, blue, groups.se);
      const before = blue.map((e) => [e.x, e.y]);
      for (let t = 0; t < toTicks(5); t++) g.step();
      blue.forEach((e, i) => expect([e.x, e.y]).toEqual(before[i]));
    });
  }

  it('a single unit still goes to the point itself', () => {
    const g = arena(5);
    const s = g.sim;
    for (const team of (['nw', 'se'] as const)) {
      const e = s.spawnUnit(slotOfArmyId(team, 2), 'tank', 'surface');
      const x = team === 'nw' ? 14.25 : s.size - 14.25;
      const y = team === 'nw' ? 22.75 : s.size - 22.75;
      expect(g.apply({ team, role: 'surface' }, { kind: 'move', units: [g.entityId(team, e.id)], x, y })).toEqual({ ok: true });
      expect(e.order).toMatchObject({ k: 'move', x, y });
    }
  });

  it('a shared destination resolves to distinct slots: a second order to the same point stays clear of the first', () => {
    const g = arena(5, 'open', DEFAULT_RULES.map.size, false); // open Orbit: the ruin is covered elsewhere
    const s = g.sim;
    const waves: Record<'nw' | 'se', Ent[][]> = { nw: [], se: [] };
    for (const team of (['nw', 'se'] as const)) {
      for (const [plane, kind, n] of [['orbit', 'bastion', 3], ['orbit', 'bastion', 3], ['surface', 'tank', 1], ['surface', 'tank', 1]] as const) {
        const wave: Ent[] = [];
        for (let i = 0; i < n; i++) {
          const e = s.spawnUnit(slotOfArmyId(team, 2), kind, plane);
          const bx = 10 + i * 1.5;
          const by = 10 + waves[team].length * 1.5;
          e.x = team === 'nw' ? bx : s.size - bx;
          e.y = team === 'nw' ? by : s.size - by;
          wave.push(e);
        }
        waves[team].push(wave);
      }
    }
    g.step();
    for (const team of (['nw', 'se'] as const)) {
      for (const wave of waves[team]) {
        const [x, y] = wave[0]!.plane === 'orbit' ? [16, 20] : [20, 16];
        expect(g.apply({ team, role: wave[0]!.plane }, { kind: 'move', units: wave.map((e) => g.entityId(team, e.id)), x: team === 'nw' ? x : s.size - x, y: team === 'nw' ? y : s.size - y })).toEqual({ ok: true });
      }
    }
    for (const team of (['nw', 'se'] as const)) {
      const all = waves[team].flat();
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!.order;
        const b = all[j]!.order;
        if (a.k !== 'move' || b.k !== 'move' || all[i]!.plane !== all[j]!.plane) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(all[i]!.radius + all[j]!.radius + ECON.slotGap - 1e-6);
      }
    }
    for (let t = 0; t < toTicks(40); t++) g.step();
    const blue = waves.nw.flat();
    expect(blue.every((e) => e.order.k === 'none')).toBe(true);
    expect(overlap(blue.filter((e) => e.plane === 'orbit'))).toBeLessThan(BRUSH);
    expect(overlap(blue.filter((e) => e.plane === 'surface'))).toBeLessThan(BRUSH);
    expectMirrored(g, blue, waves.se.flat());
  });
});

describe('new units clear the Spire on every plane', () => {
  /**
   * Least gap (tiles) between a settled new unit's body and its Spire segment's footprint: rules.movement.rallyClearance
   * (1.5) keeps rally slots that far out on the open planes (an idle unit shoved by later arrivals can give a little of
   * it up); Depths units stand on the root pocket's tunnel cells, so they only must not overlap the root beyond the
   * separation tolerance (SEP_DEADBAND, with float slack).
   */
  const CLEAR: Record<Plane, number> = { depths: -BRUSH - 1e-5, surface: 1, sky: 1, orbit: 1 };
  for (const plane of PLANES) {
    it(`${plane}: 16 units produced in a row settle off the footprint at distinct slots, mirrored`, () => {
      const g = arena(7);
      const s = g.sim;
      const kinds = PRODUCED_UNITS.filter((k) => STATS[k].plane === plane);
      const made: Record<'nw' | 'se', number> = { nw: 0, se: 0 };
      for (const team of (['nw', 'se'] as const)) s.armies[slotOfArmyId(team, 2)]!.alloy = s.armies[slotOfArmyId(team, 2)]!.energy = 1e7;
      for (let t = 0; t < toTicks(240); t++) {
        for (const team of (['nw', 'se'] as const)) {
          if (made[team] < 16 && g.apply({ team, role: plane }, { kind: 'queue_add', item: kinds[made[team] % kinds.length]!, count: 1 }).ok) made[team]++;
        }
        g.step();
      }
      const units = (team: ArmyId): Ent[] => s.ents.filter((e) => !e.dead && e.unit && e.side === slotOfArmyId(team, 2)).sort((a, b) => a.seq - b.seq);
      const blue = units('nw');
      expect(blue).toHaveLength(16);
      const seg = s.armies[slotOfArmyId('nw', 2)]!.spire[plane];
      for (const e of blue) {
        expect(e.order.k, `${e.kind} still under way`).toBe('none');
        expect(e.plane).toBe(plane);
        expect(footprintDistance('spire', seg.x, seg.y, e.x, e.y) - e.radius, `${e.kind} at ${e.x},${e.y}`).toBeGreaterThanOrEqual(CLEAR[plane]);
      }
      expect(overlap(blue)).toBeLessThan(BRUSH);
      expectMirrored(g, blue, units('se'));
    }, 120_000);
  }
});
