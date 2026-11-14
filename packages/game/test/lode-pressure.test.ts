/**
 * Mother Lode pressure (rules.depths.lodePressure*): one shared, public pressure that loads build and time bleeds, the
 * warn/critical telegraph, the fuse that commits it at lodeCritical, the vent at its end (the blast, then a magma flood
 * out of the ring sized by recent loads, public to every army that knows the lode), the post-vent cooling, and the bots
 * and example policy pacing their crews by it. Every case runs mirrored.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CELL, ECON, LODE_PRESSURE_MAX, isOpenCell, toTicks, type ArmyId, type MatchData, type MatchOptions, type Observation, type UnitKind } from '../src/rules/contract.ts';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { DECIDING_STARTERS } from './starter-policies.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { NEUTRAL, armyIdOfSlot, rotCell, slotOfArmyId } from '../src/util/teams.ts';

const DUEL = ['nw', 'se'] as const;
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const LOAD = Math.round(ECON.digOre * ECON.motherLodeDig);

/** Only the Spires and islands left; open terrain. */
function arena(options: MatchOptions = {}, seed = 3): AgentCommandGame {
  const g = createGame({ seed, options: { terrain: 'open', ...options } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}
/** A unit of army `army` (a digger unless `kind` says otherwise) standing in Depths cell `c`. */
function put(g: AgentCommandGame, army: number, c: number, kind: UnitKind = 'digger'): Ent {
  const e = g.sim.spawnUnit(army, kind, 'depths');
  e.x = (c % g.sim.size) + 0.5;
  e.y = Math.floor(c / g.sim.size) + 0.5;
  e.cell = c;
  return e;
}
/** Cell `c` turned from the first army's frame into army `a`'s (its slot's rotation). */
const turn = (g: AgentCommandGame, a: number, c: number): number => rotCell(((g.sim.armySlot[a]! - g.sim.armySlot[0]! + g.sim.sides) % g.sim.sides) * g.sim.slotStep, c, g.sim.size);
const teamOf = (g: AgentCommandGame, a: number): ArmyId => armyIdOfSlot(g.sim.armySlot[a]!, g.sim.sides);
const obsOf = (g: AgentCommandGame, a: number): Observation => g.observe({ team: teamOf(g, a), role: 'depths' }, 0);
/** The open cells within the map's ring width of any lode cell. */
function ringCells(g: AgentCommandGame): Set<number> {
  const s = g.sim, w = s.rules.map.motherLode.ringWidth, out = new Set<number>();
  for (const l of s.motherCells) for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) {
    const c = l + dy * s.size + dx;
    if (isOpenCell(s.cells[c]!)) out.add(c);
  }
  return out;
}
/** Every cell's rotations under the map's turns are in the set too. */
const symmetric = (g: AgentCommandGame, cells: readonly number[]): boolean => cells.every((c) => cells.includes(rotCell(g.sim.slotStep, c, g.sim.size)));

describe('Mother Lode pressure builds per digger', () => {
  /**
   * `n` diggers of `team` (the other army's diggers removed) mine the Mother Lode on the default map: the tick it
   * vents, counted from the first load (-1: not within `limit`), and the highest pressure seen.
   */
  function crew(team: ArmyId, n: number, limit: number): { vent: number; peak: number } {
    const g = createGame({ seed: 7, options: {} });
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    const own = s.ents.filter((e) => e.kind === 'digger' && e.side === army && !e.dead);
    while (own.length < n) own.push(s.spawnUnit(army, 'digger', 'depths'));
    for (const e of s.ents) if (e.kind === 'digger' && (e.side !== army || !own.slice(0, n).includes(e))) e.hp = 0;
    g.step();
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[army])!;
    expect(g.apply({ team, role: 'depths' }, { kind: 'mine', units: own.slice(0, n).map((e) => g.entityId(team, e.id)), x: (lode % s.size) + 0.5, y: Math.floor(lode / s.size) + 0.5 })).toEqual({ ok: true });
    let first = -1, peak = 0;
    for (let t = 0; t < limit; t++) {
      g.step();
      if (first < 0 && s.lodePressure > 0) first = s.tick;
      if (s.lodeCooling()) return { vent: s.tick - first, peak: LODE_PRESSURE_MAX };
      peak = Math.max(peak, s.lodePressure);
    }
    return { vent: -1, peak };
  }

  it('one hauling digger about breaks even; two vent in about 1.5 minutes, four within a minute; mirrored exactly', () => {
    const runs = DUEL.map((team) => [1, 2, 4].map((n) => crew(team, n, toTicks(n === 1 ? 300 : 180))));
    expect(runs[1]).toEqual(runs[0]);
    const [one, two, four] = runs[0]!;
    expect(one!.vent).toBe(-1);
    expect(one!.peak).toBeLessThan(ECON.lodeWarn);
    expect(two!.vent).toBeGreaterThan(toTicks(60));
    expect(two!.vent).toBeLessThan(toTicks(150));
    expect(four!.vent).toBeGreaterThan(0);
    expect(four!.vent).toBeLessThan(toTicks(45));
  });

  it('each load adds lodePressurePerLoad and it bleeds lodePressureBleed/s; the public rate is the window\'s pace net of the bleed', () => {
    const g = arena({ depths: { lodePressurePerLoad: 7, lodePressureBleed: 0.5 } });
    const s = g.sim;
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[0])!;
    const diggers = s.allArmies.map((a) => put(g, a, turn(g, a, lode - s.size)));
    s.allArmies.forEach((a) => {
      const at = turn(g, a, lode);
      g.apply({ team: teamOf(g, a), role: 'depths' }, { kind: 'mine', units: [g.entityId(teamOf(g, a), diggers[a]!.id)], x: (at % s.size) + 0.5, y: Math.floor(at / s.size) + 0.5 });
    });
    while (diggers[0]!.carry === 0) g.step();
    // Both armies' first loads landed this tick: 2 × 7, minus one tick of bleed (from 0).
    expect(diggers.map((d) => d.carry)).toEqual(diggers.map(() => ECON.motherLodeAlloyPerLoad));
    expect(s.lodePressure).toBeCloseTo(2 * 7 - 0.5 / 20, 9);
    expect(s.lodeRecent).toBe(2);
    steps(g, toTicks(1));
    expect(s.lodePressure).toBeCloseTo(2 * 7 - 0.5 / 20 - 0.5, 9);
    const window = ECON.lodeVentWindowTicks / 20;
    for (const a of s.allArmies) expect(obsOf(g, a).motherLode!.rate).toBe(Math.round((2 * 7 / window - 0.5) * 100) / 100);
  });
});

describe('Mother Lode pressure thresholds and the fuse', () => {
  for (const sides of [2, 4] as const) it(`calm, warn from lodeWarn, critical (committed: alert lode_critical at the vent tick) from lodeCritical, the same for every army (C${sides})`, () => {
    const g = arena(sides === 4 ? { map: { seed: 5, params: { slots: 4 } } } : {}, sides === 4 ? 5 : 3);
    const s = g.sim;
    for (const [p, state] of [[ECON.lodeWarn - 0.01, 'calm'], [ECON.lodeWarn, 'warn'], [ECON.lodeCritical - 0.01, 'warn']] as const) {
      s.lodePressure = p;
      for (const o of s.allArmies.map((a) => obsOf(g, a))) {
        expect(o.motherLode).toMatchObject({ pressure: p, state });
        expect(o.motherLode!.ventAt).toBeUndefined();
        expect(o.alerts.some((x) => x.kind === 'lode_critical')).toBe(false);
        expect(o.schedule.some((x) => x.kind === 'lode_vent')).toBe(false);
      }
    }
    // Just below lodeCritical it bleeds back and never commits.
    g.step();
    expect([s.lodeVentAt, s.lodePressure < ECON.lodeCritical - 0.01]).toEqual([0, true]);
    s.lodePressure = ECON.lodeCritical;
    g.step();
    const ventAt = s.tick + ECON.lodeFuseTicks;
    expect(s.lodeVentAt).toBe(ventAt);
    const seen = s.allArmies.map((a) => obsOf(g, a));
    for (const o of seen) {
      expect(o.motherLode).toMatchObject({ state: 'critical', ventAt });
      expect(o.alerts.find((x) => x.kind === 'lode_critical')).toEqual({ plane: 'depths', kind: 'lode_critical', tick: ventAt, x: o.motherLode!.x, y: o.motherLode!.y });
      expect(o.schedule.find((x) => x.kind === 'lode_vent')).toEqual({ kind: 'lode_vent', tick: ventAt, x: o.motherLode!.x, y: o.motherLode!.y });
    }
    // Each army's point is the nearest lode cell to its own Spire: the first army's turned into its frame.
    s.allArmies.forEach((a) => {
      const c = turn(g, a, Math.floor(seen[0]!.motherLode!.y!) * s.size + Math.floor(seen[0]!.motherLode!.x!));
      expect([seen[a]!.motherLode!.x, seen[a]!.motherLode!.y]).toEqual([(c % s.size) + 0.5, Math.floor(c / s.size) + 0.5]);
    });
  });

  for (const sides of [2, 4] as const) it(`C${sides}: once committed it climbs to ${LODE_PRESSURE_MAX} and vents exactly at ventAt with nobody mining; the bleed stops`, () => {
    const g = arena(sides === 4 ? { map: { seed: 5, params: { slots: 4 } } } : {}, sides === 4 ? 5 : 3);
    const s = g.sim;
    s.lodePressure = ECON.lodeCritical;
    g.step();
    const ventAt = s.lodeVentAt;
    expect(ventAt).toBe(s.tick + ECON.lodeFuseTicks);
    let last = s.lodePressure;
    while (s.tick < ventAt - 1) {
      g.step();
      // Equal steps up, whatever happens: the public rate is the climb.
      expect(s.lodePressure).toBeGreaterThan(last);
      expect(s.lodePressure).toBeCloseTo(ECON.lodeCritical + ((LODE_PRESSURE_MAX - ECON.lodeCritical) * (s.tick - (ventAt - ECON.lodeFuseTicks))) / ECON.lodeFuseTicks, 9);
      expect(s.lodeCooling()).toBe(false);
      for (const a of s.allArmies) expect(obsOf(g, a).motherLode!.rate).toBeCloseTo(((LODE_PRESSURE_MAX - ECON.lodeCritical) * 20) / ECON.lodeFuseTicks, 1);
      last = s.lodePressure;
    }
    g.step();
    expect(s.tick).toBe(ventAt);
    expect([s.lodeCooling(), s.lodeVentAt, s.lodePressure]).toEqual([true, 0, 0]);
    expect(s.floods.at(-1)!.orbit).toBe(true);
    for (const a of s.allArmies) expect(obsOf(g, a).motherLode).toMatchObject({ state: 'cooling', until: ventAt + ECON.lodeVentCooldownTicks });
  });

  it('the load that reaches lodeCritical commits it, never one below; lodeFuse 0 vents at once', () => {
    for (const [p, fuse, commits] of [[ECON.lodeCritical - ECON.lodePressurePerLoad - 1, 8, false], [ECON.lodeCritical - ECON.lodePressurePerLoad + 1, 8, true], [ECON.lodeCritical - ECON.lodePressurePerLoad + 1, 0, true]] as const) {
      const g = arena({ depths: { lodeFuse: fuse } });
      const s = g.sim;
      const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[0])!;
      const d = put(g, 0, lode - s.size);
      g.apply({ team: teamOf(g, 0), role: 'depths' }, { kind: 'mine', units: [g.entityId(teamOf(g, 0), d.id)], x: (lode % s.size) + 0.5, y: Math.floor(lode / s.size) + 0.5 });
      steps(g, LOAD - 1);
      s.lodePressure = p;
      while (d.carry === 0 && !d.dead) g.step();
      const label = `${p} fuse ${fuse}`;
      if (!commits) expect([s.lodeVentAt, s.lodeCooling()], label).toEqual([0, false]);
      else if (fuse === 0) expect([s.lodeVentAt, s.lodeCooling()], label).toEqual([0, true]);
      else expect([s.lodeVentAt, s.lodeCooling()], label).toEqual([s.tick + toTicks(fuse), false]);
    }
  });
});

describe('the Mother Lode vents', () => {
  const OPTIONS = { depths: { lodeVentBase: 4, lodeVentPerLoad: 2, lodeVentMax: 30 } } satisfies MatchOptions;
  for (const sides of [2, 4] as const) for (const loads of [0, 3, 20]) {
    it(`C${sides}, ${loads} recent loads: the ring floods at once, then min(max, base + perLoad × loads) more cells in whole orbits`, () => {
      const g = arena(sides === 4 ? { ...OPTIONS, map: { seed: 5, params: { slots: 4 } } } : OPTIONS, sides === 4 ? 5 : 3);
      const s = g.sim;
      const ring = ringCells(g);
      const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[0])!;
      const burnt = s.allArmies.map((a) => put(g, a, turn(g, a, lode - s.size)));
      s.lodeWindow[0] = loads;
      s.lodeRecent = loads;
      s.lodePressure = 99;
      s.ventMotherLode();
      const f = s.floods.at(-1)!;
      expect([...f.cells].sort((a, b) => a - b)).toEqual([...ring].sort((a, b) => a - b));
      for (const c of ring) expect(s.cells[c]).toBe(CELL.magma);
      const spread = Math.floor(Math.min(30, 4 + 2 * loads) / sides) * sides;
      expect(f.limit).toBe(ring.size + spread);
      expect([s.lodePressure, s.lodeRecent, s.lodeWindow.some((v) => v > 0), s.lodeCoolUntil]).toEqual([0, 0, false, s.tick + ECON.lodeVentCooldownTicks]);
      // Every army knows the lode (knownAtStart): told at once, with the cooling on its schedule.
      for (const a of s.allArmies) {
        expect(g.events({ team: teamOf(g, a), role: 'depths' }, 0).some((e) => e.kind === 'magma_flood')).toBe(true);
        expect(obsOf(g, a).schedule.some((e) => e.kind === 'magma_cools' && e.tick === f.coolAt)).toBe(true);
      }
      steps(g, (spread / sides + 1) * s.magmaStep + 1);
      expect(f.cells).toHaveLength(ring.size + spread);
      expect(symmetric(g, f.cells)).toBe(true);
      for (const c of f.cells) expect(s.cells[c]).toBe(CELL.magma);
      // The crews in the ring take the blast alike: a digger does not survive it.
      for (const d of burnt) expect([d.dead, d.lastHitCause]).toEqual([true, 'eruption']);
    });
  }

  it('the spread follows connected tunnel from the ring and never passes rock', () => {
    const g = arena(OPTIONS);
    const s = g.sim;
    s.lodeRecent = 20;
    s.ventMotherLode();
    const f = s.floods.at(-1)!;
    steps(g, toTicks(30));
    const cells = new Set(f.cells);
    const ring = ringCells(g);
    for (const c of f.cells) {
      if (ring.has(c)) continue;
      expect([c - 1, c + 1, c - s.size, c + s.size].some((n) => cells.has(n)), `${c}`).toBe(true);
    }
  });
});

describe('the vent blast', () => {
  for (const sides of [2, 4] as const) it(`C${sides}: lodeVentBlast hits every Depths unit within the ring plus lodeVentBlastReach at once, nobody's, and nothing beyond; the armies that saw it are told`, () => {
    const g = arena(sides === 4 ? { map: { seed: 5, params: { slots: 4 } } } : {}, sides === 4 ? 5 : 3);
    const s = g.sim;
    const reach = s.rules.map.motherLode.ringWidth + ECON.lodeVentBlastReach;
    // Straight up from the first army's lode cell (every other lode cell lies level with it or below): the ring, the
    // blast's edge and just beyond it, turned into each army's frame.
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[0])!;
    const up = (k: number): number => lode - k * s.size;
    const units = s.allArmies.map((a) => ({ ring: put(g, a, turn(g, a, up(1))), edge: put(g, a, turn(g, a, up(reach)), 'warden'), out: put(g, a, turn(g, a, up(reach + 1))) }));
    steps(g, VISION_EVERY);
    for (const u of units) expect([s.lodeDistance(u.ring.cell), s.lodeDistance(u.edge.cell), s.lodeDistance(u.out.cell)]).toEqual([1, reach, reach + 1]);
    const since = s.tick;
    s.lodeVentAt = s.tick + 1;
    g.step();
    expect(s.lodeCooling()).toBe(true);
    for (const u of units) {
      expect([u.ring.hp <= 0, u.ring.lastHitCause, u.ring.lastHitBy]).toEqual([true, 'eruption', NEUTRAL]);
      expect(u.edge.hp).toBe(u.edge.maxHp - ECON.lodeVentBlast);
      expect(u.out.hp).toBe(u.out.maxHp);
    }
    g.step();
    for (const a of s.allArmies) {
      const kinds = g.events({ team: teamOf(g, a), role: 'depths' }, since).map((e) => e.kind);
      expect(kinds.filter((k) => k === 'lode_erupted')).toHaveLength(1);
      expect(kinds).toContain('unit_lost');
      expect(kinds).not.toContain('enemy_killed');
    }
  });
});

describe('the vent is public to every army that knows the lode', () => {
  for (const sides of [2, 4] as const) it(`C${sides}: with no vision there, each army that knows a lode cell sees the ring flood, the eruption, and the ring cool`, () => {
    const g = arena({ depths: { magmaCoolTime: 5 }, ...(sides === 4 ? { map: { seed: 5, params: { slots: 4 } } } : {}) }, sides === 4 ? 5 : 3);
    const s = g.sim;
    const ring = [...ringCells(g)];
    for (const a of s.allArmies) for (const c of ring) expect(s.seesCell(a, 'depths', c)).toBe(false);
    const since = s.tick;
    s.lodeVentAt = s.tick + 1;
    g.step();
    for (const a of s.allArmies) {
      const o = obsOf(g, a);
      for (const c of ring) expect(o.depths![c], `army ${a} cell ${c}`).toBe(CELL.magma);
      const fx = g.view(teamOf(g, a)).fx;
      expect(fx.filter((f) => f.kind === 'lode_vent')).toHaveLength(s.motherCells.length);
      expect(fx.filter((f) => f.kind === 'magma')).toHaveLength(ring.length);
      const kinds = g.events({ team: teamOf(g, a), role: 'depths' }, since).map((e) => e.kind);
      expect(kinds).toContain('magma_flood');
      // Nobody saw the blast itself.
      expect(kinds).not.toContain('lode_erupted');
    }
    steps(g, toTicks(5));
    for (const a of s.allArmies) for (const c of ring) expect(obsOf(g, a).depths![c]).toBe(CELL.tunnel);
  });

  it('an army that knows no lode cell learns nothing of the ring', () => {
    const g = arena({ map: { params: { motherLode: { knownAtStart: false } } } });
    const s = g.sim;
    const ring = [...ringCells(g)];
    s.lodeVentAt = s.tick + 1;
    g.step();
    for (const a of s.allArmies) {
      const o = obsOf(g, a);
      for (const c of ring) expect(o.depths![c]).not.toBe(CELL.magma);
      expect(g.view(teamOf(g, a)).fx.some((f) => f.kind === 'lode_vent' || f.kind === 'magma')).toBe(false);
    }
  });
});

describe('the Mother Lode cools after a vent', () => {
  it('pressure 0 and unminable (state cooling until `until`) for lodeVentCooldown, then mined again; mirrored', () => {
    const g = arena({ depths: { magmaDps: 0, magmaCoolTime: 2, lodeVentCooldown: 8, lodeVentBlast: 0 } });
    const s = g.sim;
    // No plain ore anywhere: a `mine` order can only mine the Mother Lode.
    for (let c = 0; c < s.n; c++) if (s.cells[c] === CELL.ore) {
      s.cells[c] = CELL.rock;
      s.ore[c] = 0;
      for (const grp of s.groups) if (grp.known[c] === CELL.ore) grp.known[c] = CELL.rock;
    }
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[0])!;
    const crew = s.allArmies.map((a) => put(g, a, turn(g, a, lode - s.size)));
    const mine = (): void => s.allArmies.forEach((a) => {
      const at = turn(g, a, lode);
      expect(g.apply({ team: teamOf(g, a), role: 'depths' }, { kind: 'mine', units: [g.entityId(teamOf(g, a), crew[a]!.id)], x: (at % s.size) + 0.5, y: Math.floor(at / s.size) + 0.5 })).toEqual({ ok: true });
    });
    mine();
    steps(g, LOAD + 1);
    expect(crew.map((d) => d.carry)).toEqual(crew.map(() => ECON.motherLodeAlloyPerLoad));
    s.ventMotherLode();
    const until = s.tick + toTicks(8);
    expect(s.lodeCoolUntil).toBe(until);
    for (const a of s.allArmies) {
      expect(obsOf(g, a).motherLode).toMatchObject({ pressure: 0, state: 'cooling', until });
      expect(s.motherOpenFor(s.motherCells.indexOf(turn(g, a, lode)), a)).toBe(false);
    }
    // The crew beside it keeps its order but mines nothing there until the cooling ends.
    while (s.tick < until - 1) {
      g.step();
      expect([...s.motherHolders].every((h) => h === 0)).toBe(true);
      expect([s.lodeRecent, s.lodePressure]).toEqual([0, 0]);
      expect(crew.map((d) => d.carry)).toEqual(crew.map(() => ECON.motherLodeAlloyPerLoad));
    }
    g.step();
    expect(s.lodeCooling()).toBe(false);
    for (const a of s.allArmies) expect(obsOf(g, a).motherLode!.state).toBe('calm');
    mine();
    for (let t = 0; t < toTicks(30) && s.lodeRecent === 0; t++) g.step();
    expect(s.lodeRecent).toBe(s.sides);
    expect(crew.map((d) => d.carry)).toEqual(crew.map(() => 2 * ECON.motherLodeAlloyPerLoad));
    expect(s.lodePressure).toBeGreaterThan(0);
  });
});

describe('Mother Lode pressure is public', () => {
  it('every army and observers read the same pressure and fuse; the point (and the alert) only with a known lode cell', () => {
    const g = arena({ map: { params: { motherLode: { knownAtStart: false } } } });
    const s = g.sim;
    s.lodePressure = ECON.lodeCritical + 1;
    g.step();
    const seen = s.allArmies.map((a) => obsOf(g, a));
    for (const o of seen) {
      expect(o.motherLode).toEqual(seen[0]!.motherLode);
      expect(o.motherLode).toMatchObject({ state: 'critical', ventAt: s.lodeVentAt });
      expect(o.motherLode!.x).toBeUndefined();
      expect(o.alerts.some((x) => x.kind === 'lode_critical')).toBe(false);
      expect(o.schedule.find((x) => x.kind === 'lode_vent')).toEqual({ kind: 'lode_vent', tick: s.lodeVentAt });
    }
    expect(g.view('nw').motherLode).toEqual(seen[0]!.motherLode);
    expect(g.observerView().world.motherLode).toMatchObject({ state: 'critical', ventAt: s.lodeVentAt });
    // A digger beside a lode cell sees it: its army learns the point; the other army still has none.
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[0])!;
    put(g, 0, lode - s.size);
    steps(g, VISION_EVERY);
    const [blue, red] = s.allArmies.map((a) => obsOf(g, a));
    expect(blue!.motherLode).toMatchObject({ x: (lode % s.size) + 0.5, y: Math.floor(lode / s.size) + 0.5 });
    expect(blue!.alerts.find((x) => x.kind === 'lode_critical')).toMatchObject({ tick: s.lodeVentAt });
    expect(red!.motherLode!.x).toBeUndefined();
    expect(red!.motherLode!.pressure).toBe(blue!.motherLode!.pressure);
  });

  it('lodePressureEnabled false: no field, and mining never builds pressure', () => {
    const g = arena({ depths: { lodePressureEnabled: false } });
    const s = g.sim;
    const lode = s.motherCells[0]!;
    const d = put(g, 0, lode - s.size);
    g.apply({ team: teamOf(g, 0), role: 'depths' }, { kind: 'mine', units: [g.entityId(teamOf(g, 0), d.id)], x: (lode % s.size) + 0.5, y: Math.floor(lode / s.size) + 0.5 });
    steps(g, 2 * LOAD + 1);
    expect(d.carry).toBe(2 * ECON.motherLodeAlloyPerLoad);
    expect(s.lodePressure).toBe(0);
    for (const a of s.allArmies) expect(obsOf(g, a).motherLode).toBeUndefined();
  });
});

describe('the Depths starter paces its Mother Lode crew by pressure', () => {
  /** The policy's decisions for `team` on the default map with enough diggers for a crew, at the given pressure state. */
  function decide(team: ArmyId, lode: Observation['motherLode'][]): AgentCommandIntent[][] {
    const g = createGame({ seed: 5, options: { depths: { motherLodeCrewPerCell: 3 } } });
    const army = slotOfArmyId(team, 2);
    for (let i = 0; i < 9; i++) g.sim.spawnUnit(army, 'digger', 'depths');
    const seat = { team, role: 'depths' } as const;
    const policy = runInNewContext(`${DECIDING_STARTERS.depths}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
    policy.init(g.matchData(seat));
    return lode.map((m, i) => {
      const obs = g.observe(seat, 0);
      obs.tick += i * 40;
      if (m) obs.motherLode = m; else delete obs.motherLode;
      return structuredClone(policy.think(obs));
    });
  }
  const atLode = (out: AgentCommandIntent[], g: AgentCommandGame): string[] => out.flatMap((i) => i.kind === 'mine' && i.x !== undefined && i.y !== undefined && g.sim.cells[Math.floor(i.y) * g.sim.size + Math.floor(i.x)] === CELL.lode ? i.units : []);
  const home = (out: AgentCommandIntent[], team: ArmyId, g: AgentCommandGame): string[] => {
    const at = g.sim.spireAt[slotOfArmyId(team, 2)]!;
    return out.flatMap((i) => i.kind === 'mine' && i.x === at.x && i.y === at.y ? i.units : []);
  };

  for (const team of DUEL) it(`${team}: a crew while calm; one from warn while rising; pulled home at critical; none while cooling`, () => {
    const g = createGame({ seed: 5, options: {} });
    const calm = { pressure: 10, rate: 0, state: 'calm' } as const;
    const [first, warn, critical, cooling] = decide(team, [calm, { pressure: 70, rate: 1, state: 'warn' }, { pressure: 90, rate: 1, state: 'critical' }, { pressure: 0, rate: 0, state: 'cooling', until: 9999 }]);
    const crew = atLode(first!, g);
    expect(crew.length).toBeGreaterThan(1);
    // Warn while rising: all but one go home.
    expect(home(warn!, team, g)).toHaveLength(crew.length - 1);
    expect(home(critical!, team, g)).toHaveLength(1);
    expect(atLode(critical!, g)).toEqual([]);
    expect(atLode(cooling!, g)).toEqual([]);
  });

  // The built-in tiers and the starter alike: a Warden fleeing the fuse used to get its post order back, into the blast.
  for (const mode of ['novice', 'standard', 'veteran', 'policy'] as const) for (const team of DUEL) it(`${mode} ${team}: on the fuse every own Depths unit in the blast walks to the root and gets no other order`, () => {
    const g = createGame({ seed: 5, options: {} });
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    const seat = { team, role: 'depths' } as const;
    const policy = mode === 'policy'
      ? runInNewContext(`${DECIDING_STARTERS.depths}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] }
      : createBot(team, 'depths', mode);
    policy.init?.(g.matchData(seat));
    // Two of ours in the ring of the lode cell nearest our Spire, a Warden at the blast's edge.
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[army])!;
    const ring = [lode - s.size, lode + s.size, lode - 1, lode + 1].filter((n) => isOpenCell(s.cells[n]!)).slice(0, 2);
    const edge = s.lodeCells(lode, 2).find((c) => s.lodeDistance(c) === 2)!;
    const runners = [...ring.map((c) => put(g, army, c)), put(g, army, edge, 'warden')];
    const obs = g.observe(seat, 0);
    obs.motherLode = { pressure: 90, rate: 2, state: 'critical', ventAt: obs.tick + 100 };
    const out = structuredClone(policy.think(obs));
    const root = s.spireAt[army]!;
    const flee = out.filter((i) => i.kind === 'move' && Math.hypot(i.x - root.x, i.y - root.y) < 4);
    expect(flee).toHaveLength(1);
    expect(flee.flatMap((i) => (i.kind === 'move' ? i.units : [])).sort()).toEqual(runners.map((e) => g.entityId(team, e.id)).sort());
    const others = out.flatMap((i) => (i !== flee[0] && 'units' in i ? i.units : []));
    for (const e of runners) expect(others).not.toContain(g.entityId(team, e.id));
  });
});
