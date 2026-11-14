/** Depths identity pack: Drill Bits and Shaped Charges research, gates harden their flanks, backfilling any hole, the Mother Lode. */
import { describe, expect, it } from 'vitest';
import { CELL, DEFAULT_RULES, ECON, HOLE_KINDS, MOTHER_LODE_MAX_CELLS, STATS, TERRAIN_PRESETS, isOpenCell, resolveRules, toTicks, type ArmyId, type MatchOptions, type Plane, type UnitKind } from '../src/rules/contract.ts';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { HOLE, VISION_EVERY } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { cellOfEnt } from '../src/util/grid.ts';
import { NEUTRAL, armyIdOfSlot, rotCell, slotOfArmyId } from '../src/util/teams.ts';
import { generateMapDocument, publicMapDocument } from '../src/maps/maps.ts';
import { documentFromWorld, expandMapDocument, exportLdtk, importLdtk, mapEntities, mapEntity, mapLayerValues, setMapLayerValues, validateMapDocument, type MapDocument } from '../src/maps/document.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/** Only the Spires and islands left; open terrain. */
function arena(options: MatchOptions = {}, seed = 3): AgentCommandGame {
  const g = createGame({ seed, options: { terrain: 'open', ...options } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}
const cell = (g: AgentCommandGame, x: number, y: number): number => y * g.sim.size + x;
const xy = (g: AgentCommandGame, c: number): { x: number; y: number } => ({ x: c % g.sim.size, y: Math.floor(c / g.sim.size) });
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, c: number, plane: Plane = 'depths'): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, plane);
  e.x = (c % g.sim.size) + 0.5;
  e.y = Math.floor(c / g.sim.size) + 0.5;
  e.cell = c;
  return e;
}
/** Open tunnel cells walled by plain rock on every side, known to both teams; no magma. */
function corridor(g: AgentCommandGame, cells: number[]): void {
  const s = g.sim;
  for (const c of cells) {
    s.cells[c] = CELL.tunnel;
    s.magma[c] = 0;
  }
  for (const c of cells) {
    for (const n of [c - s.size, c + s.size, c - 1, c + 1, c - s.size - 1, c - s.size + 1, c + s.size - 1, c + s.size + 1]) {
      if (cells.includes(n)) continue;
      s.cells[n] = CELL.rock;
      s.magma[n] = 0;
      s.work[n] = 0;
      s.tough[n] = 0;
    }
  }
  for (const grp of s.groups) for (const c of cells) grp.known[c] = CELL.tunnel;
  s.depthsVersion++;
}
/** Ticks until cell `c` is open (or `limit`). */
function openAfter(g: AgentCommandGame, c: number, limit = toTicks(60)): number {
  for (let t = 1; t <= limit; t++) {
    g.step();
    if (isOpenCell(g.sim.cells[c]!)) return t;
  }
  return Infinity;
}

describe('Drill Bits', () => {
  it('a researched digger digs a cell open in drillBitsDig of the time; the rule switch withholds the research', () => {
    const time = (research: boolean): number => {
      const g = arena();
      const row = 12;
      corridor(g, [cell(g, 20, row)]);
      if (research) g.sim.armies[BLUE]!.research.add('drill_bits');
      const digger = put(g, 'nw', 'digger', cell(g, 20, row));
      const target = cell(g, 21, row);
      expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, 'nw', digger)], ...xy(g, target) })).toEqual({ ok: true });
      return openAfter(g, target);
    };
    const plain = time(false);
    const drilled = time(true);
    expect(plain - drilled).toBe(ECON.digRock - Math.ceil(ECON.digRock * ECON.drillBitsDig));

    const g = arena({ research: { drillBitsEnabled: false } });
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).research.available).not.toContain('drill_bits');
    expect(act(g, 'nw', 'depths', { kind: 'research', upgrade: 'drill_bits' })).toEqual({ ok: false, code: 'blocked' });
    const on = arena();
    expect(on.observe({ team: 'nw', role: 'depths' }, 0).research.available).toEqual(expect.arrayContaining(['drill_bits', 'shaped_charges']));
    expect(act(on, 'nw', 'depths', { kind: 'research', upgrade: 'drill_bits' })).toEqual({ ok: true });
  });
});

describe('Shaped Charges', () => {
  it('a researched sapper plants a shorter fuse, and its charge splits a fault shapedChasmReach cells each way', () => {
    const g = arena();
    const s = g.sim;
    s.armies[BLUE]!.research.add('shaped_charges');
    const c = cell(g, 20, 12);
    corridor(g, [c]);
    const sapper = put(g, 'nw', 'sapper', c);
    expect(act(g, 'nw', 'depths', { kind: 'undermine', units: [id(g, 'nw', sapper)], ...xy(g, c) })).toEqual({ ok: true });
    for (let i = 0; i < toTicks(2) && s.charges.length === 0; i++) g.step();
    const charge = s.charges[0]!;
    expect(charge.at - g.tick).toBe(ECON.shapedUndermineTicks);
    expect(charge.reach).toBe(ECON.shapedChasmReach);
    // The base fuse without the research.
    const h = arena();
    const d = cell(h, 20, 12);
    corridor(h, [d]);
    const plain = put(h, 'nw', 'sapper', d);
    act(h, 'nw', 'depths', { kind: 'undermine', units: [id(h, 'nw', plain)], ...xy(h, d) });
    for (let i = 0; i < toTicks(2) && h.sim.charges.length === 0; i++) h.step();
    expect(h.sim.charges[0]!.at - h.tick).toBe(ECON.undermineTicks);

    // A longer chasm along a fault.
    const seed = [3, 4, 5, 6, 7, 8, 9, 10].find((n) => createGame({ seed: n, options: { terrain: 'open' } }).sim.faults.some((f) => f.length >= 2 * ECON.shapedChasmReach + 1))!;
    const f = arena({}, seed);
    const fault = f.sim.faults.find((line) => line.length >= 2 * ECON.shapedChasmReach + 1)!;
    const mid = fault[ECON.shapedChasmReach]!;
    f.sim.cells[mid] = CELL.tunnel;
    f.sim.magma.fill(0);
    for (const n of fault) if (f.sim.cells[n] === CELL.fortified) f.sim.cells[n] = CELL.rock;
    f.sim.plantCharge(BLUE, mid, true);
    steps(f, ECON.shapedUndermineTicks + 1);
    expect(fault.filter((n) => f.sim.holes[n] === HOLE.chasm)).toHaveLength(2 * ECON.shapedChasmReach + 1);
  });
});

describe('gates harden their flanks', () => {
  it('a completed bulkhead fortifies the rock beside it, so digging round through a flank is no quicker than the gate', () => {
    const g = arena();
    const s = g.sim;
    const row = 12;
    const cells = [18, 19, 20, 21, 22].map((x) => cell(g, x, row));
    corridor(g, cells);
    const gate = cell(g, 20, row);
    s.placeBulkhead(BLUE, gate);
    const north = gate - s.size;
    const south = gate + s.size;
    expect(s.cells[north]).toBe(CELL.fortified);
    expect(s.cells[south]).toBe(CELL.fortified);
    // Corridor cells beside the gate stay open (tunnels never close).
    expect(isOpenCell(s.cells[gate - 1]!)).toBe(true);
    expect(isOpenCell(s.cells[gate + 1]!)).toBe(true);
    // Round the gate through its flank: the wall before it, the flank, the wall after it.
    const around = s.digNeed(north - 1) + s.digNeed(north) + s.digNeed(north + 1);
    expect(around).toBeGreaterThanOrEqual(s.econ.bulkheadDigTicks);
    // Before the change one digger went round in three rock cells.
    expect(3 * ECON.digRock).toBeLessThan(s.econ.bulkheadDigTicks);

    // Off: plain rock stays plain.
    const h = arena({ depths: { bulkheadFlankFortify: 0 } });
    corridor(h, cells);
    h.sim.placeBulkhead(BLUE, gate);
    expect(h.sim.cells[north]).toBe(CELL.rock);
    // Two levels: fortified and reinforced once.
    const k = arena({ depths: { bulkheadFlankFortify: 2 } });
    corridor(k, cells);
    k.sim.placeBulkhead(RED, gate);
    expect(k.sim.cells[north]).toBe(CELL.fortified);
    expect(k.sim.tough[north]).toBe(1);
  });
});

describe('backfill any hole', () => {
  for (const kind of HOLE_KINDS) {
    it(`a digger beside the cell below backfills a ${kind}; the depths below stay open`, () => {
      const g = arena();
      const s = g.sim;
      const row = 12;
      const below = cell(g, 21, row);
      corridor(g, [cell(g, 20, row), below]);
      s.openCells([below], HOLE[kind], NEUTRAL);
      expect(s.holes[below]).toBe(HOLE[kind]);
      const digger = put(g, 'nw', 'digger', cell(g, 20, row));
      const alloy = s.armies[BLUE]!.alloy;
      expect(act(g, 'nw', 'depths', { kind: 'bridge', units: [id(g, 'nw', digger)], ...xy(g, below) })).toEqual({ ok: true });
      for (let i = 0; i < toTicks(30) && s.holes[below]; i++) g.step();
      expect(s.holes[below]).toBe(0);
      expect(s.block[below]).toBe(0);
      expect(isOpenCell(s.cells[below]!)).toBe(true);
      expect(s.armies[BLUE]!.alloy).toBeLessThan(alloy - ECON.bridgeCost + 1 + 2 * ECON.spireAlloyRate * 30);
      expect(g.events({ team: 'se', role: 'surface' }, 0).some((e) => e.kind === 'hole_bridged')).toBe(true);
    });
  }

  it('rules.depths.backfillKinds limits the kinds (0: off)', () => {
    const chasmOnly = arena({ depths: { backfillKinds: 1 << HOLE_KINDS.indexOf('chasm') } });
    const c = cell(chasmOnly, 21, 12);
    corridor(chasmOnly, [cell(chasmOnly, 20, 12), c]);
    chasmOnly.sim.openCells([c], HOLE.crater, NEUTRAL);
    const digger = put(chasmOnly, 'nw', 'digger', cell(chasmOnly, 20, 12));
    expect(act(chasmOnly, 'nw', 'depths', { kind: 'bridge', units: [id(chasmOnly, 'nw', digger)], ...xy(chasmOnly, c) })).toEqual({ ok: false, code: 'invalid_target' });
    chasmOnly.sim.holes[c] = HOLE.chasm;
    expect(act(chasmOnly, 'nw', 'depths', { kind: 'bridge', units: [id(chasmOnly, 'nw', digger)], ...xy(chasmOnly, c) })).toEqual({ ok: true });
    const off = arena({ depths: { backfillKinds: 0 } });
    corridor(off, [cell(off, 20, 12), c]);
    off.sim.openCells([c], HOLE.chasm, NEUTRAL);
    const d = put(off, 'nw', 'digger', cell(off, 20, 12));
    expect(act(off, 'nw', 'depths', { kind: 'bridge', units: [id(off, 'nw', d)], ...xy(off, c) })).toEqual({ ok: false, code: 'invalid_target' });
  });
});

describe('the Mother Lode map', () => {
  const C4 = { map: { seed: 5, params: { slots: 4 } } } satisfies MatchOptions;
  /** Every cell's twin under the map's turns is in the set too. */
  const symmetric = (cells: readonly number[], size: number, sides: number): boolean => cells.every((c) => cells.includes(rotCell(4 / sides, c, size)));
  /** The cells within Chebyshev `w` of a lode cell that are not lode cells, ascending. */
  const ringOf = (cells: readonly number[], size: number, w: number): number[] => {
    const ring = new Set<number>();
    for (const c of cells) for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) ring.add(c + dy * size + dx);
    return [...ring].filter((c) => !cells.includes(c)).sort((a, b) => a - b);
  };
  const lodeCellsOf = (cells: Uint8Array): number[] => [...cells.keys()].filter((c) => cells[c] === CELL.lode);

  it('fills the centre 2×2 with lode cells ringed by tunnel, rotation-exact and known to every army (C2 and C4)', () => {
    for (const g of [createGame({ seed: 7 }), new AgentCommandGame(5, C4)]) {
      const s = g.sim;
      const h = s.size / 2;
      const centre = [cell(g, h - 1, h - 1), cell(g, h, h - 1), cell(g, h - 1, h), cell(g, h, h)];
      expect([...s.motherCells].sort((a, b) => a - b)).toEqual(centre);
      expect(symmetric(s.motherCells, s.size, s.sides)).toBe(true);
      for (const c of centre) expect(s.cells[c]).toBe(CELL.lode);
      for (const c of ringOf(centre, s.size, 1)) expect(isOpenCell(s.cells[c]!), `ring ${c}`).toBe(true);
      for (const t of s.armies) for (const c of [...centre, ...ringOf(centre, s.size, 1)]) expect(t.group.known[c]).toBe(s.cells[c]);
      for (const t of s.armies) expect(g.observe({ team: armyIdOfSlot(g.sim.armySlot[t.army]!, g.sim.sides), role: 'depths' }, 0).depths![centre[0]!]).toBe(CELL.lode);
      // The map document carries it as public MotherLode entities (one per orbit), so the public map hash covers it.
      expect(mapEntities(s.mapDocument).filter((e) => e.__identifier === 'MotherLode')).toHaveLength(4 / s.sides);
    }
  });

  it('is a public stage: two secret seeds give the same lode cells, ring and public map; hidden layers keep off it', () => {
    const variants = [{}, { placement: 'ring', cells: 8, ringWidth: 2 }] as const;
    for (const terrain of TERRAIN_PRESETS) for (const sides of [2, 4] as const) for (const motherLode of variants) {
      const map = resolveRules({ terrain, map: { params: { slots: sides, motherLode } } }).map;
      const label = `${terrain}/${sides}/${JSON.stringify(motherLode)}`;
      const [a, b] = [11, 2 ** 31 + 77].map((secret) => generateMapDocument(9, terrain, map, sides, secret)) as [MapDocument, MapDocument];
      expect(JSON.stringify(publicMapDocument(b)), label).toBe(JSON.stringify(publicMapDocument(a)));
      const [wa, wb] = [a, b].map((d) => expandMapDocument(d).world);
      const lodes = lodeCellsOf(wa!.cells);
      expect(lodeCellsOf(wb!.cells), label).toEqual(lodes);
      expect(lodes, label).toHaveLength(map.motherLode.cells);
      expect(symmetric(lodes, map.size, sides), label).toBe(true);
      const w = map.motherLode.ringWidth;
      for (const world of [wa!, wb!]) {
        for (const c of ringOf(lodes, map.size, w)) expect(world.cells[c], `${label} ring ${c}`).toBe(CELL.tunnel);
        // No magma pocket borders the ring (a breach there would flood it) and no Headframe lode seal overlaps it.
        for (const c of ringOf(lodes, map.size, w + 1)) expect(world.magma[c], `${label} magma ${c}`).toBe(0);
        for (const l of world.lodes) for (const c of lodes) expect(Math.max(Math.abs((l.c % map.size) - (c % map.size)), Math.abs(Math.floor(l.c / map.size) - Math.floor(c / map.size))), label).toBeGreaterThan(2 + w);
      }
    }
    // A live match with a secret seed and a public map seed: the same cells, ring knowledge and public map hash.
    const [x, y] = [3, 2 ** 31 + 5].map((secret) => createGame({ seed: secret, options: { map: { seed: 21 } } }).sim);
    expect(y!.motherCells).toEqual(x!.motherCells);
    expect(y!.mapHash).toBe(x!.mapHash);
    for (const c of ringOf(x!.motherCells, x!.size, 1)) expect(y!.armies[BLUE]!.group.known[c]).toBe(x!.armies[BLUE]!.group.known[c]);
  });

  it('whole orbits only: pairs on two-slot maps, fours on four-slot maps; off, or an authored map without one, has none', () => {
    const two = createGame({ seed: 7, options: { map: { params: { motherLode: { cells: 3 } } } } }).sim;
    expect(two.motherCells).toHaveLength(2);
    expect(two.motherCells[1]).toBe(two.n - 1 - two.motherCells[0]!);
    const four = new AgentCommandGame(5, { map: { seed: 5, params: { slots: 4, motherLode: { cells: 3 } } } }).sim;
    expect(four.motherCells).toHaveLength(0);
    expect(four.cells.includes(CELL.lode)).toBe(false);
    const off = createGame({ seed: 7, options: { map: { params: { motherLode: { enabled: false } } } } }).sim;
    expect(off.motherCells).toHaveLength(0);
    expect(off.cells.includes(CELL.lode)).toBe(false);
    expect(mapEntities(off.mapDocument).some((e) => e.__identifier === 'MotherLode')).toBe(false);
    // four_corners is an authored document that places none.
    const authored = new AgentCommandGame(5, { map: { name: 'four_corners' } }).sim;
    expect(authored.motherCells).toHaveLength(0);
    expect(authored.cells.includes(CELL.lode)).toBe(false);
  });

  it('ring placement: evenly spaced at radius, off the Spire bearings, rotation-exact, ringWidth of tunnel (C2 and C4)', () => {
    for (const sides of [2, 4] as const) {
      const g = new AgentCommandGame(5, { map: { seed: 5, params: { size: 64, slots: sides, motherLode: { placement: 'ring', cells: 8, radius: 9, ringWidth: 2 } } } });
      const s = g.sim;
      const h = s.size / 2;
      expect(s.motherCells, `${sides}`).toHaveLength(8);
      expect(symmetric(s.motherCells, s.size, sides)).toBe(true);
      const radius = (9 * s.size) / 48;
      const bearings = s.motherCells.map((c) => Math.atan2(Math.floor(c / s.size) + 0.5 - h, (c % s.size) + 0.5 - h)).sort((p, q) => p - q);
      for (const c of s.motherCells) expect(Math.abs(Math.hypot((c % s.size) + 0.5 - h, Math.floor(c / s.size) + 0.5 - h) - radius)).toBeLessThan(1);
      // Eight bearings an eighth of a turn apart (up to the cell grid), none on a Spire's diagonal bearing.
      bearings.forEach((a, i) => expect(Math.abs((i ? a - bearings[i - 1]! : a + 2 * Math.PI - bearings[7]!) - Math.PI / 4)).toBeLessThan(0.25));
      for (const a of bearings) expect(Math.abs(Math.abs(Math.sin(2 * a))), `${sides} ${a}`).toBeLessThan(0.9);
      for (const c of ringOf(s.motherCells, s.size, 2)) {
        expect(s.cells[c], `${sides} ring ${c}`).toBe(CELL.tunnel);
        for (const t of s.armies) expect(t.group.known[c]).toBe(CELL.tunnel);
      }
    }
  });

  it('every preset, size and slot count builds a valid map at the ring bounds (radius 4 and 12, ringWidth 3, 8 cells)', () => {
    for (const terrain of TERRAIN_PRESETS) for (const size of [48, 64, 80]) for (const radius of [4, 12]) {
      const map = resolveRules({ terrain, map: { params: { size, motherLode: { placement: 'ring', cells: 8, radius, ringWidth: 3 } } } }).map;
      for (const sides of [2, 4] as const) {
        const lodes = lodeCellsOf(expandMapDocument(generateMapDocument(5, terrain, map, sides, 5)).world.cells);
        expect(lodes, `${terrain}/${size}/${sides}/${radius}`).toHaveLength(8);
      }
    }
  });

  it('knownAtStart false: nobody knows the cells at the start; a digger beside one sees it', () => {
    const g = arena({ map: { params: { motherLode: { knownAtStart: false } } } });
    const s = g.sim;
    expect(s.motherCells).toHaveLength(4);
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[BLUE])!;
    for (const t of s.armies) for (const c of s.motherCells) expect(t.group.known[c]).not.toBe(CELL.lode);
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).depths!.includes(CELL.lode)).toBe(false);
    put(g, 'nw', 'digger', lode - s.size);
    steps(g, VISION_EVERY);
    expect(s.armies[BLUE]!.group.known[lode]).toBe(CELL.lode);
    expect(s.armies[RED]!.group.known[lode]).not.toBe(CELL.lode);
  });

  it('a hole over a lode cell (crater, chasm, sinkhole) leaves it solid, like bedrock; the ring below opens as usual', () => {
    for (const kind of HOLE_KINDS) {
      const g = arena();
      const s = g.sim;
      const lode = s.motherCells[0]!;
      s.openCells([lode, lode - s.size], HOLE[kind], BLUE);
      expect(s.holes[lode], kind).toBe(HOLE[kind]);
      expect(s.cells[lode], kind).toBe(CELL.lode);
      expect(isOpenCell(s.cells[lode - s.size]!), kind).toBe(true);
      for (const t of s.armies) expect(t.group.known[lode], kind).toBe(CELL.lode);
    }
  });

  it('the map document carries it: the validator rejects a mismatched, oversized, closed or unreachable Mother Lode', () => {
    const doc = generateMapDocument(3, 'open', DEFAULT_RULES.map, 2, 3);
    expect(validateMapDocument(doc).valid).toBe(true);
    const { size } = doc, h = size / 2;
    const errors = (edit: (d: MapDocument) => void): string => {
      const d = structuredClone(doc);
      edit(d);
      return validateMapDocument(d).errors.join('; ');
    };
    const mother = (d: MapDocument) => mapEntities(d).filter((e) => e.__identifier === 'MotherLode');
    expect(mother(doc)).toHaveLength(2);
    expect(mother(importLdtk(exportLdtk(doc)))).toEqual(mother(doc));
    // Asymmetric: one cell of an orbit without its twin cannot become a document.
    const world = expandMapDocument(doc).world;
    world.cells[(h - 1) * size + h - 1] = CELL.tunnel;
    const { id, label, identity, seed, sides, spireInset, preset } = doc;
    expect(() => documentFromWorld(world, { id, label, identity, seed, size, sides, spireInset, preset })).toThrow(/symmetry in Depths/);
    expect(errors((d) => mapEntities(d).splice(mapEntities(d).indexOf(mother(d)[0]!), 1))).toContain('lacks a MotherLode entity');
    expect(errors((d) => mapEntities(d).push(mapEntity('MotherLode', 'stray', 10.5, 10.5, {})))).toContain('MotherLode entity at 490 is not a lode cell');
    expect(errors((d) => {
      for (const x of [10, 13, 16]) mapEntities(d).push(mapEntity('MotherLode', `extra-${x}`, x + 0.5, 10.5, {}));
    })).toContain(`More than ${MOTHER_LODE_MAX_CELLS} Mother Lode cells`);
    // The canonical (top) half of the Depths layer: a ring cell walled, then the whole ring sealed off by bedrock.
    const depths = (d: MapDocument, cells: [number, number][], code: number): void => {
      const values = mapLayerValues(d, 'Depths');
      for (const [x, y] of cells) values[y * size + x] = code;
      setMapLayerValues(d, 'Depths', values);
    };
    expect(errors((d) => depths(d, [[h - 1, h - 2]], CELL.rock))).toContain(`Mother Lode ring cell ${(h - 2) * size + h - 1} is not open`);
    const shell: [number, number][] = [];
    for (let x = h - 3; x <= h + 2; x++) shell.push([x, h - 3]);
    for (const y of [h - 2, h - 1]) shell.push([h - 3, y], [h + 2, y]);
    const sealed = errors((d) => depths(d, shell, CELL.bedrock));
    expect(sealed).toContain('unreachable from start 0');
    expect(sealed).toContain('unreachable from start 1');
  });
});

describe('the Mother Lode', () => {
  it('a digger mines a load every digOre × motherLodeDig from beside it, forever; it cannot be dug', () => {
    const g = arena();
    const s = g.sim;
    const lode = s.motherCells[0]!;
    const beside = lode - s.size;
    const digger = put(g, 'nw', 'digger', beside);
    expect(act(g, 'nw', 'depths', { kind: 'dig', units: [id(g, 'nw', digger)], ...xy(g, lode) })).toEqual({ ok: false, code: 'invalid_target' });
    expect(act(g, 'nw', 'depths', { kind: 'mine', units: [id(g, 'nw', digger)], x: xy(g, lode).x + 0.5, y: xy(g, lode).y + 0.5 })).toEqual({ ok: true });
    const load = Math.round(ECON.digOre * ECON.motherLodeDig);
    let first = -1;
    for (let t = 1; t <= 3 * load && digger.carry === 0; t++) {
      g.step();
      if (digger.carry > 0) first = t;
    }
    // One tick to claim the free cell, then a full load's mining.
    expect(first).toBe(load + 1);
    steps(g, load);
    expect(digger.carry).toBe(2 * ECON.motherLodeAlloyPerLoad);
    expect(s.cells[lode]).toBe(CELL.lode);
    expect(s.ore[lode]).toBe(0);
    // Endless by default: no reserve is kept or spent.
    expect(ECON.motherLodeLoads).toBe(0);
    expect(s.motherEmpty(s.motherCells.indexOf(lode))).toBe(false);
  });

  it('one digger mines a cell at a time; a rival waits beside it and takes over when the holder leaves', () => {
    const g = arena();
    const s = g.sim;
    const lode = s.motherCells[0]!;
    // Two ring cells beside the same lode cell (one above, one to its side, both outside the 2×2).
    const ring = [lode - s.size, lode - 1, lode + 1, lode + s.size].filter((n) => isOpenCell(s.cells[n]!));
    expect(ring.length).toBeGreaterThanOrEqual(2);
    const blue = put(g, 'nw', 'digger', ring[0]!);
    const red = put(g, 'se', 'digger', ring[1]!);
    const at = { x: xy(g, lode).x + 0.5, y: xy(g, lode).y + 0.5 };
    act(g, 'nw', 'depths', { kind: 'mine', units: [id(g, 'nw', blue)], ...at });
    act(g, 'se', 'depths', { kind: 'mine', units: [id(g, 'se', red)], ...at });
    steps(g, toTicks(1));
    const k = s.motherCells.indexOf(lode);
    const holder = s.motherHolders[k];
    expect([blue.id, red.id]).toContain(holder);
    const [mining, waiting] = holder === blue.id ? [blue, red] : [red, blue];
    // Ties go to the army whose sector holds the cell.
    expect(s.armySlot[mining.side as number]).toBe(s.cellSector(lode));
    expect(mining.state).toBe('mining');
    expect(waiting.state).toBe('contested');
    steps(g, toTicks(10));
    expect(waiting.carry).toBe(0);
    expect(mining.carry).toBeGreaterThan(0);
    mining.hp = 0;
    steps(g, toTicks(1) + Math.round(ECON.digOre * ECON.motherLodeDig) + 2);
    expect(s.motherHolders[k]).toBe(waiting.id);
    expect(waiting.carry).toBe(ECON.motherLodeAlloyPerLoad);
    expect(cellOfEnt(waiting, s.size)).not.toBe(lode);
  });

  it('motherLodeAlloyPerLoad is the alloy per load; the digger hauls once it carries at least diggerCarryMax', () => {
    const g = arena({ depths: { motherLodeAlloyPerLoad: 25 } });
    const s = g.sim;
    const lode = s.motherCells[0]!;
    const digger = put(g, 'nw', 'digger', lode - s.size);
    act(g, 'nw', 'depths', { kind: 'mine', units: [id(g, 'nw', digger)], x: xy(g, lode).x + 0.5, y: xy(g, lode).y + 0.5 });
    const load = Math.round(ECON.digOre * ECON.motherLodeDig);
    steps(g, load + 1);
    expect(digger.carry).toBe(25);
    // diggerLoads × oreLoad = 40: the second load (50) fills it, so it leaves the cell to haul.
    expect(ECON.diggerLoads * ECON.oreLoad).toBe(40);
    steps(g, load);
    expect(digger.carry).toBe(50);
    steps(g, load + 2);
    expect(digger.carry === 50 || digger.carry === 0).toBe(true);
    expect(s.motherHolders[s.motherCells.indexOf(lode)]).toBe(0);
  });

  it('motherLodeCrewPerCell 2: two diggers mine one cell at once; a third ally mines elsewhere, a rival waits', () => {
    const g = arena({ depths: { motherLodeCrewPerCell: 2 } });
    const s = g.sim;
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[BLUE])!;
    const k = s.motherCells.indexOf(lode);
    const ring = [lode - s.size, lode - 1, lode + 1, lode + s.size].filter((n) => isOpenCell(s.cells[n]!));
    const crew = [0, 1, 2].map((i) => put(g, 'nw', 'digger', ring[i % ring.length]!));
    const rival = put(g, 'se', 'digger', ring[1]!);
    const at = { x: xy(g, lode).x + 0.5, y: xy(g, lode).y + 0.5 };
    act(g, 'nw', 'depths', { kind: 'mine', units: crew.map((e) => id(g, 'nw', e)), ...at });
    act(g, 'se', 'depths', { kind: 'mine', units: [id(g, 'se', rival)], ...at });
    steps(g, toTicks(1));
    const slots = (): number[] => [...s.motherHolders.subarray(2 * k, 2 * k + 2)].sort((a, b) => a - b);
    // Free places go to the army whose sector holds the cell, lowest serial first.
    expect(slots()).toEqual([crew[0]!.id, crew[1]!.id].sort((a, b) => a - b));
    expect(crew[0]!.state).toBe('mining');
    expect(crew[1]!.state).toBe('mining');
    expect(rival.state).toBe('contested');
    expect(crew[2]!.state).not.toBe('contested');
    expect(s.motherFullForAlly(k, BLUE)).toBe(true);
    expect(s.motherFullForAlly(k, RED)).toBe(false);
    steps(g, Math.round(ECON.digOre * ECON.motherLodeDig));
    expect(crew[0]!.carry).toBe(ECON.motherLodeAlloyPerLoad);
    expect(crew[1]!.carry).toBe(ECON.motherLodeAlloyPerLoad);
    expect(rival.carry).toBe(0);
    expect(rival.state).toBe('contested');
    expect(slots()).not.toContain(crew[2]!.id);
    // One holder leaves: the waiting rival takes its place.
    crew[0]!.hp = 0;
    steps(g, 2);
    expect(slots()).toEqual([crew[1]!.id, rival.id].sort((a, b) => a - b));
  });

  it('motherLodeLoads: a cell runs dry after its loads and the digger beside it (who sees it) mines elsewhere', () => {
    const g = arena({ depths: { motherLodeLoads: 2 } });
    const s = g.sim;
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[BLUE])!;
    const k = s.motherCells.indexOf(lode);
    expect([...s.motherReserve]).toEqual(s.motherCells.map(() => 2));
    const digger = put(g, 'nw', 'digger', lode - s.size);
    act(g, 'nw', 'depths', { kind: 'mine', units: [id(g, 'nw', digger)], x: xy(g, lode).x + 0.5, y: xy(g, lode).y + 0.5 });
    const load = Math.round(ECON.digOre * ECON.motherLodeDig);
    steps(g, 2 * load + 1);
    expect(digger.carry).toBe(2 * ECON.motherLodeAlloyPerLoad);
    expect(s.motherReserve[k]).toBe(0);
    expect(s.motherEmpty(k)).toBe(true);
    steps(g, Math.max(2, VISION_EVERY));
    expect(s.motherHolders[k]).toBe(0);
    expect(s.cells[lode]).toBe(CELL.lode);
    // Fog: only an army that sees the empty cell drops it as an ore goal; the hidden reserve steers nobody else.
    expect(s.seesCell(BLUE, 'depths', lode)).toBe(true);
    expect(s.motherOpenFor(k, BLUE)).toBe(false);
    expect(s.seesCell(RED, 'depths', lode)).toBe(false);
    expect(s.motherOpenFor(k, RED)).toBe(true);
    steps(g, load + 2);
    expect(s.motherReserve[k]).toBe(0);
    expect(s.motherHolders[k]).toBe(0);
  });

  it('motherLodeRegen: an empty cell regains loads at the rate, up to motherLodeLoads, and yields again', () => {
    const g = arena({ depths: { motherLodeLoads: 2, motherLodeRegen: 0.5 } });
    const s = g.sim;
    const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[BLUE])!;
    const k = s.motherCells.indexOf(lode);
    s.motherReserve[k] = 0;
    steps(g, toTicks(1));
    expect(s.motherReserve[k]).toBeCloseTo(0.5, 9);
    steps(g, toTicks(1));
    expect(s.motherReserve[k]).toBeCloseTo(1, 9);
    steps(g, toTicks(10));
    expect(s.motherReserve[k]).toBe(2);
    const digger = put(g, 'nw', 'digger', lode - s.size);
    act(g, 'nw', 'depths', { kind: 'mine', units: [id(g, 'nw', digger)], x: xy(g, lode).x + 0.5, y: xy(g, lode).y + 0.5 });
    steps(g, Math.round(ECON.digOre * ECON.motherLodeDig) + 1);
    expect(digger.carry).toBe(ECON.motherLodeAlloyPerLoad);
    expect(s.motherReserve[k]).toBeCloseTo(1 + 0.5 / toTicks(1), 9);
  });

  it('crews, rivals and finite loads play out as an exact rotation orbit (C2 and C4)', () => {
    // Pressure off: these crews would vent it (the vent's own orbit is covered in lode-pressure.test.ts).
    const depths = { motherLodeCrewPerCell: 2, motherLodeLoads: 3, motherLodeRegen: 0.25, lodePressureEnabled: false };
    const games = [
      arena({ depths }),
      arena({ map: { seed: 5, params: { slots: 4 } }, depths }, 5),
    ];
    for (const g of games) {
      const s = g.sim;
      expect(s.allArmies.length).toBe(s.sides);
      const first = s.allArmies[0]!;
      const lode = s.motherCells.find((c) => s.cellSector(c) === s.armySlot[first])!;
      const ring = [lode - s.size, lode - 1, lode + 1, lode + s.size].filter((n) => isOpenCell(s.cells[n]!));
      const turn = (slot: number, c: number): number => rotCell(((slot - s.armySlot[first]! + s.sides) % s.sides) * s.slotStep, c, s.size);
      const team = (a: number): ArmyId => armyIdOfSlot(s.armySlot[a]!, s.sides);
      const spawn = (a: number, c: number): Ent => {
        const e = s.spawnUnit(a, 'digger', 'depths');
        e.x = (c % s.size) + 0.5;
        e.y = Math.floor(c / s.size) + 0.5;
        e.cell = c;
        return e;
      };
      const crews = s.allArmies.map(() => [] as Ent[]);
      // Each army: three diggers at its own sector's lode cell, one rival at the next slot's.
      for (let i = 0; i < 4; i++) for (const a of s.allArmies) {
        const slot = s.armySlot[a]!;
        crews[a]!.push(spawn(a, i < 3 ? turn(slot, ring[i % ring.length]!) : turn((slot + 1) % s.sides, ring[1]!)));
      }
      for (const a of s.allArmies) {
        const slot = s.armySlot[a]!;
        const own = turn(slot, lode);
        const next = turn((slot + 1) % s.sides, lode);
        act(g, team(a), 'depths', { kind: 'mine', units: crews[a]!.slice(0, 3).map((e) => id(g, team(a), e)), x: (own % s.size) + 0.5, y: Math.floor(own / s.size) + 0.5 });
        act(g, team(a), 'depths', { kind: 'mine', units: [id(g, team(a), crews[a]![3]!)], x: (next % s.size) + 0.5, y: Math.floor(next / s.size) + 0.5 });
      }
      // Each army's diggers turned back into the first army's frame.
      const back = (a: number, c: number): number => rotCell(((s.armySlot[first]! - s.armySlot[a]! + s.sides) % s.sides) * s.slotStep, c, s.size);
      const outcome = (a: number): string => JSON.stringify(crews[a]!.map((e) => [e.carry, e.state, e.workT, back(a, cellOfEnt(e, s.size))]));
      const reserves = (): number[] => s.allArmies.map((a) => s.motherReserve[s.motherCells.indexOf(turn(s.armySlot[a]!, lode))]!);
      let contested = false;
      let mined = false;
      let dry = false;
      for (let t = 0; t < 5 * Math.round(ECON.digOre * ECON.motherLodeDig); t++) {
        g.step();
        for (const a of s.allArmies) expect(outcome(a), `tick ${s.tick} army ${a}`).toBe(outcome(first));
        const r = reserves();
        for (const x of r) expect(x).toBe(r[0]);
        contested ||= crews[first]![3]!.state === 'contested';
        mined ||= crews[first]![0]!.carry > 0 && crews[first]![1]!.carry > 0;
        dry ||= r[0]! < 1;
      }
      // Two own holders mined while the rival waited, and the reserve ran low under that crew.
      expect([contested, mined, dry]).toEqual([true, true, true]);
    }
  });
});

it('the new research rows resolve their match costs', () => {
  const g = arena({ research: { drillBitsAlloy: 7, shapedChargesTime: 2 } });
  expect(g.sim.upgrades.drill_bits.alloy).toBe(7);
  expect(g.sim.upgrades.shaped_charges.build).toBe(toTicks(2));
  expect(STATS.digger.abilities).not.toContain('drill_bits');
});
