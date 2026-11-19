/**
 * Collapse audit: every way a hole opens (breach, impacts, sapper charges, fault chasms, rule maxima), what it does to
 * units, structures, the land and the Depths below, which armies hear of it, and that mirrored and rotated collapses
 * give mirrored and rotated results. Every case is the rule as DESIGN (§4.1, §4.2) and the agent docs state it: units
 * fall only where the Depths cell below is open and step off anything else, holes never empty a lode, fallen vehicles
 * are wrecked, falls credit a hostile opener, survivors stand over their pit, move goals snap to known open ground.
 */
import { describe, expect, it } from 'vitest';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import { CELL, STATS, SURFACE, TRANSITS, surfaceFeature, type ArmyId, type MatchOptions, type Plane, type RockSize, type UnitKind } from '../src/rules/contract.ts';
import { HOLD_ZONE_HP, HOLE, VISION_EVERY } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { DESIGNATE_NORMAL } from '../src/nav/nav.ts';
import { canonCell, canonX, canonY, NEUTRAL, rotCell, rotX, rotY, slotOfArmyId, type Army } from '../src/util/teams.ts';

const TEAMS = ['nw', 'se'] as const;
const army = (team: ArmyId): Army => slotOfArmyId(team, 2);
const foeOf = (team: ArmyId): ArmyId => (team === 'nw' ? 'se' : 'nw');
const frame = (team: ArmyId): number => (team === 'nw' ? 0 : 2);
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/** An open-terrain duel with only the Spires, islands and posts left (seed 6, Spires at 8.5 and 39.5), no beams, no rocks. */
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 6, options: { terrain: 'open', map: { params: { spireInset: 8 } }, spire: { dmg: 0 }, orbit: { maxAsteroids: 0 }, ...options } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island' && e.kind !== 'post') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}

/** A frame-relative stage: (x, y) and cells are given in `team`'s frame and land on its rotated twin. */
function stage(g: AgentCommandGame, team: ArmyId) {
  const s = g.sim;
  const k = frame(team);
  const size = s.size;
  const cell = (x: number, y: number): number => rotCell(k, y * size + x, size);
  const put = (side: ArmyId, kind: UnitKind, x: number, y: number, plane: Plane = STATS[kind].plane): Ent => {
    const e = s.spawnUnit(army(side), kind, plane);
    e.x = rotX(k, x, y, size);
    e.y = rotY(k, x, y, size);
    return e;
  };
  /** A finished structure centred at frame point (x, y). */
  const structure = (side: ArmyId, kind: 'turret' | 'shaft' | 'mooring_tower' | 'drill_yard' | 'headframe', x: number, y: number, site = false): Ent => {
    const e = s.build(army(side), kind, rotX(k, x, y, size), rotY(k, x, y, size), 'surface');
    if (!site) {
      e.built = true;
      e.hp = e.maxHp;
      e.progress = 1;
      e.state = 'active';
    }
    return e;
  };
  /** Plant `side`'s charge (`stack` sappers) at frame cell (x, y), a tunnel, due next tick. */
  const charge = (side: ArmyId, x: number, y: number, stack = 1): number => {
    const c = cell(x, y);
    s.cells[c] = CELL.tunnel;
    for (let i = 0; i < stack; i++) s.plantCharge(army(side), c);
    s.charges.find((ch) => ch.c === c)!.at = s.tick + 1;
    return c;
  };
  /** Frame-relative facts about entity `e`: plane, HP, death and canonical position. */
  const fate = (e: Ent) => ({ plane: e.plane, hp: e.hp, dead: e.dead, x: canonX(k, e.x, e.y, size), y: canonY(k, e.x, e.y, size) });
  /** Canonical cells holed now, ascending. */
  const holes = (): number[] => {
    const out: number[] = [];
    for (let c = 0; c < s.n; c++) if (s.holes[c]) out.push(canonCell(k, c, size));
    return out.sort((a, b) => a - b);
  };
  /** Rock everywhere within `r` cells (Chebyshev) of frame cell (x, y), so mirrored stages start on identical Depths. */
  const rock = (x: number, y: number, r: number): void => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const c = cell(x + dx, y + dy);
      s.cells[c] = CELL.rock;
      s.ore[c] = 0;
      s.magma[c] = 0;
    }
  };
  return { s, k, cell, put, structure, charge, fate, holes, rock };
}

/** Cells whose centres lie within `r` of world point (x, y): the disc openHoles cuts on open terrain. */
function disc(size: number, x: number, y: number, r: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < size * size; c++) if ((c % size + 0.5 - x) ** 2 + (Math.floor(c / size) + 0.5 - y) ** 2 <= r * r) out.push(c);
  return out;
}

/** A neutral metal asteroid of `size`, dropped by `by` at world point (x, y) and landed. */
function impact(g: AgentCommandGame, size: RockSize, by: ArmyId, x: number, y: number): void {
  const a = g.sim.add('asteroid', NEUTRAL, 'orbit', 24, 24);
  a.rockSize = size;
  a.resourceType = 'slag';
  a.hp = a.maxHp = g.sim.rocks[size].hp;
  a.state = 'drifting';
  expect(g.sim.dropPayload(a, army(by), x, y)).toBe(true);
  g.sim.tick = a.impactTick - 1;
  g.step();
}

/** Stage centre for most cases: open rock well clear of Spires, posts, lodes, faults and lakes in both frames. */
const AT = { x: 24, y: 41 };

describe('collapse audit: hole sources and shapes', () => {
  it('each source opens its documented shape; stacking changes damage, never the hole', () => {
    const g = arena();
    const s = g.sim;
    const size = s.size;
    const sizes: Record<string, number> = {};
    const count = (): number => s.holeCount;
    let before = count();
    const opened = (): number => {
      const n = count() - before;
      before = count();
      return n;
    };
    // Breach: troopers dig up through one cell.
    const st = stage(g, 'nw');
    st.rock(30, 30, 1);
    const b = st.cell(30, 30);
    s.cells[b] = CELL.tunnel;
    s.armies[army('nw')]!.group.known[b] = CELL.tunnel;
    const digger = st.put('nw', 'trooper', 30.5, 30.5, 'depths');
    expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'breach', units: [id(g, 'nw', digger)], x: 30, y: 30 })).toEqual({ ok: true });
    steps(g, s.econ.breachTicks + 2);
    sizes.breach = opened();
    expect(s.holes[b]).toBe(HOLE.breach);
    // Pebble: no crater. Medium on a cell corner: 2×2; on a cell centre: 3×3. Large: 21 cells at a centre, 4×4 on a corner.
    impact(g, 'pebble', 'se', 14.5, 30.5);
    sizes.pebble = opened();
    impact(g, 'medium', 'se', 14, 26);
    sizes.mediumCorner = opened();
    impact(g, 'medium', 'se', 30.5, 20.5);
    sizes.mediumCentre = opened();
    impact(g, 'large', 'se', 24.5, 36.5);
    sizes.largeCentre = opened();
    impact(g, 'large', 'se', 36, 24);
    sizes.largeCorner = opened();
    // Sapper charges: one sapper or a full stack open the same collapseRadius sinkhole.
    st.rock(AT.x, AT.y, 2);
    st.charge('se', AT.x, AT.y, 1);
    steps(g, 2);
    sizes.charge1 = opened();
    st.rock(20, 14, 2);
    st.charge('se', 20, 14, s.econ.chargeStackMax);
    steps(g, 2);
    sizes.charge3 = opened();
    // A core drop's crater (coreDropCrater) through the same registry radius.
    const core = s.add('core', NEUTRAL, 'orbit', 24, 24);
    expect(s.payloadDrop(core)!.impact.crater).toBe(s.econ.coreDropCrater);
    core.hp = 0;
    s.openHoles(40.5, 6.5, s.econ.coreDropCrater, HOLE.crater, army('se'));
    sizes.coreDrop = opened();
    expect(sizes).toEqual({ breach: 1, pebble: 0, mediumCorner: 4, mediumCentre: 9, largeCentre: 21, largeCorner: 16, charge1: 9, charge3: 9, coreDrop: 13 });
    // The disc is exactly the cells whose centres lie within the radius (clipped by cliffs and water, none here).
    for (const c of disc(size, 24.5, 36.5, s.econ.largeCraterRadius)) expect(s.holes[c], `large crater cell ${c}`).toBe(HOLE.crater);
  });

  it('a fault charge splits up to chasmReach cells each way and stops at fortified fault rock beyond the blast', () => {
    const g = arena();
    const s = g.sim;
    const reach = s.econ.chasmReach;
    const fault = s.faults.find((f) => f.length >= 2 * reach + 1)!;
    const mid = reach;
    for (const n of fault) {
      s.cells[n] = CELL.rock;
      s.magma[n] = 0;
    }
    s.cells[fault[mid]!] = CELL.tunnel;
    // Fortified three fault cells on: outside chargeStripReach, the chasm stops short of it.
    s.cells[fault[mid + 3]!] = CELL.fortified;
    s.plantCharge(army('se'), fault[mid]!);
    s.charges[0]!.at = s.tick + 1;
    steps(g, 2);
    expect(fault.map((n) => s.holes[n])).toEqual(fault.map((_, i) => (i >= mid - reach && i < mid + 3 ? HOLE.chasm : 0)));
    // Public: every army hears chasm_opened, none hears a round `collapse` for it.
    for (const a of s.allArmies) {
      expect(s.armies[a]!.events.some((e) => e.kind === 'chasm_opened')).toBe(true);
      expect(s.armies[a]!.events.some((e) => e.kind === 'collapse')).toBe(false);
    }
  });
});

describe('collapse audit: units on, beside, above and below a sinkhole', () => {
  /** One charge of `foe` under a cluster of `team`'s units; returns their frame-relative fates. */
  function run(team: ArmyId) {
    const g = arena();
    const st = stage(g, team);
    const foe = foeOf(team);
    st.rock(AT.x, AT.y, 3);
    for (const [dx, dy] of [[0, 1], [0, 3], [0, -1]] as const) st.s.cells[st.cell(AT.x + dx, AT.y + dy)] = CELL.tunnel;
    st.charge(foe, AT.x, AT.y);
    const u = {
      trooper: st.put(team, 'trooper', AT.x + 0.5, AT.y + 0.5),
      tank: st.put(team, 'tank', AT.x - 0.5, AT.y - 0.5),
      flak: st.put(team, 'flak', AT.x + 1.5, AT.y + 1.5),
      breacher: st.put(team, 'breacher', AT.x + 1.5, AT.y - 0.5),
      beside: st.put(team, 'trooper', AT.x + 2.75, AT.y + 0.5),
      bomber: st.put(team, 'bomber', AT.x + 0.5, AT.y + 0.5),
      interceptor: st.put(team, 'interceptor', AT.x + 0.5, AT.y - 0.5),
      diggerHit: st.put(team, 'digger', AT.x + 0.5, AT.y + 1.5),
      diggerFar: st.put(team, 'digger', AT.x + 0.5, AT.y + 3.5),
      ownSapper: st.put(foe, 'sapper', AT.x + 0.5, AT.y - 0.5),
    };
    steps(g, 2);
    const s = st.s;
    const events = (side: ArmyId, kind: string) => s.armies[army(side)]!.events.filter((e) => e.kind === kind);
    return {
      st,
      fates: Object.fromEntries(Object.entries(u).map(([k, e]) => [k, st.fate(e)])),
      holes: st.holes(),
      collapse: TEAMS.map((t) => events(t, 'collapse').map((e) => ({ side: e.side, x: canonX(st.k, e.x, e.y, s.size), y: canonY(st.k, e.x, e.y, s.size) }))),
      fell: { own: events(team, 'fell_into_depths').length, foe: events(foe, 'fell_into_depths').length },
    };
  }

  it('drops every Surface unit on it (fall damage), spares units beside and above, hurts hostile diggers in reach; mirrored', () => {
    const out = TEAMS.map(run);
    const [nw] = out;
    const { st, fates } = nw!;
    const fall = (kind: UnitKind) => STATS[kind].hp - Math.ceil(STATS[kind].hp * st.s.econ.fallDamage);
    for (const kind of ['trooper', 'breacher'] as const) expect(fates[kind], kind).toMatchObject({ plane: 'depths', hp: fall(kind), dead: false });
    // Vehicles cannot climb back out or hit Depths units: the fall wrecks them (vehicleFallDamage 1).
    for (const kind of ['tank', 'flak'] as const) expect(fates[kind], kind).toMatchObject({ plane: 'depths', dead: true });
    expect(fates.trooper).toMatchObject({ x: AT.x + 0.5, y: AT.y + 0.5 });
    expect(fates.beside).toMatchObject({ plane: 'surface', hp: STATS.trooper.hp });
    expect(fates.bomber).toMatchObject({ plane: 'sky', hp: STATS.bomber.hp });
    expect(fates.interceptor).toMatchObject({ plane: 'sky', hp: STATS.interceptor.hp });
    expect(fates.diggerHit).toMatchObject({ plane: 'depths', hp: STATS.digger.hp - st.s.econ.chargeUnitDamage });
    expect(fates.diggerFar).toMatchObject({ hp: STATS.digger.hp });
    expect(fates.ownSapper).toMatchObject({ hp: STATS.sapper.hp });
    // A public collapse (every army, the planter named); the fall is told to the fallen units' army only.
    expect(nw!.collapse).toEqual([[{ side: army('se'), x: AT.x + 0.5, y: AT.y + 0.5 }], [{ side: army('se'), x: AT.x + 0.5, y: AT.y + 0.5 }]]);
    expect(nw!.fell).toEqual({ own: 4, foe: 0 });
    // Red's mirrored collapse is blue's, rotated (fates and holes in each defender's frame; the planter differs).
    expect(out[1]!.fates).toEqual(out[0]!.fates);
    expect(out[1]!.holes).toEqual(out[0]!.holes);
    expect(out[1]!.fell).toEqual(out[0]!.fell);
  });

  it('a fallen tank or flak is wrecked (vehicleFallDamage, cause fall), its population slot freed, the hostile planter credited; a trooper loses fallDamage; mirrored', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const st = stage(g, team);
      const s = st.s;
      const foe = foeOf(team);
      st.rock(AT.x, AT.y, 2);
      st.charge(foe, AT.x, AT.y);
      const tank = st.put(team, 'tank', AT.x + 0.5, AT.y + 0.5);
      const flak = st.put(team, 'flak', AT.x - 0.5, AT.y + 0.5);
      const trooper = st.put(team, 'trooper', AT.x + 0.5, AT.y - 0.5);
      const pop = s.armies[army(team)]!.pop;
      const kills = s.armies[army(foe)]!.stats.kills;
      steps(g, 2);
      return {
        tank: { ...st.fate(tank), cause: tank.lastHitCause, by: tank.lastHitBy === army(foe) },
        flak: { ...st.fate(flak), cause: flak.lastHitCause, by: flak.lastHitBy === army(foe) },
        trooper: st.fate(trooper),
        freed: pop - s.armies[army(team)]!.pop,
        kills: s.armies[army(foe)]!.stats.kills - kills,
      };
    });
    expect(out[0]).toMatchObject({
      tank: { plane: 'depths', dead: true, cause: 'fall', by: true },
      flak: { plane: 'depths', dead: true, cause: 'fall', by: true },
      trooper: { plane: 'depths', dead: false, hp: STATS.trooper.hp - Math.ceil(STATS.trooper.hp * 0.25) },
      freed: 2,
      kills: 2,
    });
    expect(out[1]).toEqual(out[0]);
  });

  it('a self-dug hole credits nobody; a hostile one credits its opener; vehicleFallDamage 0.25 keeps a fallen tank; mirrored', () => {
    const out = TEAMS.map((team) => {
      const g = arena({ surface: { vehicleFallDamage: 0.25 } });
      const st = stage(g, team);
      const s = st.s;
      st.rock(AT.x, AT.y, 2);
      const own = st.put(team, 'tank', AT.x + 0.5, AT.y + 0.5);
      const hostile = st.put(team, 'trooper', AT.x + 0.5, AT.y - 3.5);
      s.cells[st.cell(AT.x, AT.y - 4)] = CELL.tunnel;
      s.openCells([st.cell(AT.x, AT.y)], HOLE.breach, army(team));
      s.openCells([st.cell(AT.x, AT.y - 4)], HOLE.crater, army(foeOf(team)));
      return { own: { ...st.fate(own), by: own.lastHitBy }, hostile: { ...st.fate(hostile), by: hostile.lastHitBy === army(foeOf(team)) } };
    });
    expect(out[0]).toMatchObject({ own: { plane: 'depths', dead: false, hp: STATS.tank.hp - Math.ceil(STATS.tank.hp * 0.25), by: NEUTRAL }, hostile: { plane: 'depths', by: true } });
    expect(out[1]).toEqual(out[0]);
  });
});

describe('collapse audit: structures by footprint and stack', () => {
  type Kind = 'turret' | 'shaft' | 'mooring_tower' | 'drill_yard';
  /** A `kind` of `team` centred over the charge cell (full overlap), hit by `stack` stacked sappers of the foe. */
  function hit(team: ArmyId, kind: Kind, stack: number, site = false) {
    const g = arena();
    const st = stage(g, team);
    st.rock(AT.x, AT.y, 3);
    const f = STATS[kind].footprint;
    const e = st.structure(team, kind, AT.x + (f.w % 2 ? 0.5 : 0), AT.y + (f.h % 2 ? 0.5 : 0), site);
    st.charge(foeOf(team), AT.x, AT.y, stack);
    steps(g, 2);
    return { fate: st.fate(e), holes: st.holes(), st };
  }

  const damage = (stack: number): number => 400 * (1 + 0.5 * (stack - 1));
  for (const kind of ['turret', 'shaft', 'mooring_tower', 'drill_yard'] as const) {
    for (const stack of [1, 2]) {
      it(`${kind} (${STATS[kind].footprint.w}×${STATS[kind].footprint.h}, ${STATS[kind].hp} HP) under ${stack} stacked sapper(s): ${STATS[kind].hp <= damage(stack) ? 'destroyed' : 'damaged, standing over the hole'}; mirrored`, () => {
        const [a, b] = TEAMS.map((t) => hit(t, kind, stack));
        expect(a!.st.s.chargeDamage({ stack } as never)).toBe(damage(stack));
        const hp = Math.max(0, STATS[kind].hp - damage(stack));
        expect(a!.fate.dead).toBe(hp === 0);
        if (hp > 0) expect(a!.fate.hp).toBe(hp);
        // The footprint cells are holes either way (structures do not shield the ground).
        expect(a!.holes.length).toBe(9);
        expect(b!.fate).toEqual(a!.fate);
        expect(b!.holes).toEqual(a!.holes);
      });
    }
  }

  it('a construction site caves in with its ground', () => {
    expect(hit('nw', 'shaft', 1, true).fate.dead).toBe(true);
  });

  it('only the blast damages structures: a surviving Shaft stands on over its sinkhole (on its footing), its landing now open tunnel; mirrored', () => {
    const out = TEAMS.map((team) => {
      const { st, fate } = hit(team, 'shaft', 1);
      const shaft = st.s.ents.find((e) => e.kind === 'shaft' && !e.dead)!;
      return { fate, hole: st.s.holes[st.cell(AT.x, AT.y)], sealed: st.s.shaftSealed(army(team), shaft) };
    });
    expect(out[0]).toMatchObject({ fate: { dead: false, hp: STATS.shaft.hp - 400, plane: 'surface' }, hole: HOLE.sinkhole, sealed: false });
    expect(out[1]).toEqual(out[0]);
  });

  it('partial overlap, reach-only and out-of-reach footprints: damage by footprint distance, holes only where the disc is', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const st = stage(g, team);
      st.rock(AT.x, AT.y, 4);
      // Shaft at (26, 42): its west column (25, 41..42) is in the 3×3 disc, the east column is not.
      const partial = st.structure(team, 'shaft', AT.x + 2, AT.y + 1);
      // Turret two cells north: footprint distance 1.5 ≤ collapseRadius + collapseStructureReach, no hole under it.
      const reach = st.structure(team, 'turret', AT.x + 0.5, AT.y - 1.5);
      // Turret four cells west: footprint distance 3.5, out of reach.
      const far = st.structure(team, 'turret', AT.x - 3.5, AT.y + 0.5);
      st.charge(foeOf(team), AT.x, AT.y);
      steps(g, 2);
      return {
        partial: st.fate(partial), reach: st.fate(reach), far: st.fate(far),
        partialHoles: [[1, 0], [1, 1], [2, 0], [2, 1]].map(([dx, dy]) => st.s.holes[st.cell(AT.x + dx!, AT.y + dy!)]),
        reachHole: st.s.holes[st.cell(AT.x, AT.y - 2)],
      };
    });
    const [a] = out;
    expect(a!.partial.hp).toBe(STATS.shaft.hp - 400);
    expect(a!.partialHoles).toEqual([HOLE.sinkhole, HOLE.sinkhole, 0, 0]);
    expect(a!.reach.dead).toBe(true);
    expect(a!.reachHole).toBe(0);
    expect(a!.far).toMatchObject({ dead: false, hp: STATS.turret.hp });
    expect(out[1]).toEqual(out[0]);
  });

  it('a Headframe on an opened lode: one charge leaves it at 200 HP over a pocket that keeps every ore cell, so it keeps paying; two fell it; mirrored', () => {
    const out = TEAMS.map((team) => [1, 2].map((stack) => {
      const g = arena();
      const s = g.sim;
      const k = frame(team);
      // The team's own canonical lode (lodes come in mirrored pairs).
      const l = s.lodes.find((x) => canonCell(k, x.c, s.size) === s.lodes[0]!.c)!;
      const x = canonX(k, (l.c % s.size) + 0.5, Math.floor(l.c / s.size) + 0.5, s.size);
      const y = canonY(k, (l.c % s.size) + 0.5, Math.floor(l.c / s.size) + 0.5, s.size);
      const st = stage(g, team);
      const hf = st.structure(team, 'headframe', x, y);
      s.openLode(l, army(team));
      const left = l.left;
      const pocket = s.lodeCells(l.c, 1);
      const before = pocket.map((n) => [s.cells[n], s.ore[n]]);
      st.charge(foeOf(team), Math.floor(x), Math.floor(y), stack);
      steps(g, 2);
      const paid = s.armies[army(team)]!.stats.lodeAlloy;
      steps(g, 20);
      return {
        left, after: l.left, fate: st.fate(hf), kept: pocket.every((n, i) => s.cells[n] === before[i]![0] && s.ore[n] === before[i]![1]),
        holed: pocket.every((n) => s.holes[n] === HOLE.sinkhole), paying: s.armies[army(team)]!.stats.lodeAlloy > paid,
      };
    }));
    const [one, two] = out[0]!;
    expect(one!.left).toBeGreaterThan(0);
    expect(one).toMatchObject({ fate: { dead: false, hp: STATS.headframe.hp - 400 }, after: one!.left, kept: true, holed: true, paying: true });
    expect(two).toMatchObject({ fate: { dead: true }, after: two!.left, kept: true, paying: false });
    expect(out[1]).toEqual(out[0]);
  });

  it('the Spire edge is not protected: a charge beside it deals collapseDamage to the Surface segment and holes its edge cells', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const s = g.sim;
      const st = stage(g, team);
      const seg = s.armies[army(team)]!.spire.surface;
      // Frame Spire 8.5, 8.5 (footprint 7..9): the charge one cell east of the footprint holes its east column.
      st.charge(foeOf(team), 10, 8);
      steps(g, 2);
      const unit = s.spawnUnit(army(team), 'trooper', 'surface');
      return { hp: seg.hp, dead: seg.dead, edge: [7, 8, 9].map((y) => s.holes[st.cell(9, y)]), inner: s.holes[st.cell(8, 8)], exit: s.holes[Math.floor(unit.y) * s.size + Math.floor(unit.x)] };
    });
    expect(out[0]).toEqual({ hp: STATS.spire.hp - 400, dead: false, edge: [HOLE.sinkhole, HOLE.sinkhole, HOLE.sinkhole], inner: 0, exit: 0 });
    expect(out[1]).toEqual(out[0]);
  });

  it('the largest sinkhole the rules allow (collapseRadius 6) under a base: segment damaged once, base units fall, new units still spawn on open ground', () => {
    const out = TEAMS.map((team) => {
      const g = arena({ depths: { collapseRadius: 6 } });
      const s = g.sim;
      const st = stage(g, team);
      const seg = s.armies[army(team)]!.spire.surface;
      const shaft = st.structure(team, 'shaft', 14, 10);
      const guard = st.put(team, 'trooper', 13.5, 6.5);
      st.charge(foeOf(team), 10, 8);
      steps(g, 2);
      const unit = s.spawnUnit(army(team), 'trooper', 'surface');
      return { holes: st.holes(), disc: disc(s.size, 10.5, 8.5, 6), seg: seg.hp, shaft: st.fate(shaft), guard: st.fate(guard), exit: s.holes[Math.floor(unit.y) * s.size + Math.floor(unit.x)] };
    });
    const [a] = out;
    expect(a!.holes).toEqual(a!.disc);
    expect(a!.seg).toBe(STATS.spire.hp - 400);
    expect(a!.shaft).toMatchObject({ dead: false, hp: STATS.shaft.hp - 400 });
    expect(a!.guard.plane).toBe('depths');
    expect(a!.exit).toBe(0);
    expect(out[1]).toEqual(out[0]);
  });
});

describe('collapse audit: the land after a hole', () => {
  it('no building, no breaching, no standing in it; nav, routes and queued sites follow', () => {
    const g = arena();
    const s = g.sim;
    const st = stage(g, 'nw');
    const blue = s.armies[army('nw')]!;
    blue.alloy = blue.energy = 0;
    // A turret queued (unfunded) two cells from the coming sinkhole's edge... and one on it.
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'turret', x: 13, y: 12 })).toMatchObject({ ok: true });
    st.rock(13, 12, 2);
    const version = s.holesVersion;
    st.charge('se', 13, 12);
    steps(g, 2);
    const c = st.cell(13, 12);
    expect(s.holes[c]).toBe(HOLE.sinkhole);
    expect(s.block[c]).toBe(1);
    for (const a of s.allArmies) expect(s.surfaceNav[a]![c]).toBe(1);
    expect(s.holesVersion).toBeGreaterThan(version);
    // The queued site is blocked, new sites on it are refused, whatever the footprint.
    expect(blue.queue.find((e) => e.item === 'turret')).toMatchObject({ status: 'blocked', reason: 'blocked' });
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'turret', x: 13, y: 11 })).toEqual({ ok: false, code: 'blocked' });
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'shaft', x: 12, y: 11 })).toEqual({ ok: false, code: 'blocked' });
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'mooring_tower', x: 13, y: 12 })).toEqual({ ok: false, code: 'blocked' });
    // A breach under it is refused; a move onto its edge cells stops at the rim.
    const below = st.put('nw', 'trooper', 13.5, 12.5, 'depths');
    expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'breach', units: [id(g, 'nw', below)], x: 13, y: 12 })).toEqual({ ok: false, code: 'blocked' });
    const walker = st.put('nw', 'trooper', 17.5, 12.5);
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'move', units: [id(g, 'nw', walker)], x: 14.5, y: 12.5 })).toEqual({ ok: true });
    const o = walker.order as { k: string; x: number; y: number };
    expect(o.k).toBe('move');
    expect(s.holes[Math.floor(o.y) * s.size + Math.floor(o.x)]).toBe(0);
    // Any depth: a move into the centre of the sinkhole goes to the open rim cell nearest it, ties toward the unit.
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'move', units: [id(g, 'nw', walker)], x: 13.5, y: 12.5 })).toEqual({ ok: true });
    const deep = walker.order as { k: string; x: number; y: number };
    expect([deep.k, deep.x, deep.y]).toEqual(['move', 15.5, 12.5]);
  });

  it('a move deep into a wide crater or a lake snaps to the nearest open ground the team knows, ties toward the unit; mirrored', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const st = stage(g, team);
      const s = st.s;
      const w = (x: number, y: number) => ({ x: rotX(st.k, x, y, s.size), y: rotY(st.k, x, y, s.size) });
      // A radius-4 crater: its centre lies four tiles from any open cell (once past the old two-tile rim snap).
      const at = w(24.5, 36.5);
      s.openHoles(at.x, at.y, 4, HOLE.crater, army(foeOf(team)));
      const walker = st.put(team, 'trooper', 31.5, 36.5);
      const moved = g.apply({ team, role: 'surface' }, { kind: 'move', units: [id(g, team, walker)], ...at });
      const o = walker.order as { x: number; y: number };
      return { moved, x: canonX(st.k, o.x, o.y, s.size), y: canonY(st.k, o.x, o.y, s.size) };
    });
    // Eight open cells lie √17 from the centre; of those, (28.5, 35.5) and (28.5, 37.5) are nearest the unit, and the
    // owner's row-major order takes the first.
    expect(out[0]).toEqual({ moved: { ok: true }, x: 28.5, y: 35.5 });
    expect(out[1]).toEqual(out[0]);
    const lake = TEAMS.map((team) => {
      const g = createGame({ seed: 6, options: { terrain: 'rivers', spire: { dmg: 0 }, orbit: { maxAsteroids: 0 } } });
      const s = g.sim;
      const k = frame(team);
      const water = (c: number): boolean => surfaceFeature(s.terrain[rotCell(k, c, s.size)]!) === SURFACE.water;
      // The first canonical water cell with water all round it: deep in a lake, off every shore.
      let deep = -1;
      for (let c = s.size + 1; c < s.n - s.size - 1 && deep < 0; c++) if ([-s.size - 1, -s.size, -s.size + 1, -1, 0, 1, s.size - 1, s.size, s.size + 1].every((d) => water(c + d))) deep = c;
      expect(deep).toBeGreaterThan(0);
      const walker = s.spawnUnit(army(team), 'trooper', 'surface');
      const x = rotX(k, (deep % s.size) + 0.5, Math.floor(deep / s.size) + 0.5, s.size);
      const y = rotY(k, (deep % s.size) + 0.5, Math.floor(deep / s.size) + 0.5, s.size);
      const moved = g.apply({ team, role: 'surface' }, { kind: 'move', units: [id(g, team, walker)], x, y });
      const o = walker.order as { x: number; y: number };
      return { moved, open: s.surfaceNav[army(team)]![Math.floor(o.y) * s.size + Math.floor(o.x)], deep, x: canonX(k, o.x, o.y, s.size), y: canonY(k, o.x, o.y, s.size) };
    });
    expect(lake[0]).toMatchObject({ moved: { ok: true }, open: 0 });
    expect(lake[1]).toEqual(lake[0]);
  });

  it('FOG (twin worlds): a hidden hostile structure on the nearest rim cell never moves a snapped goal; mirrored', () => {
    const out = TEAMS.map((team) => [false, true].map((hidden) => {
      const g = arena();
      const st = stage(g, team);
      const s = st.s;
      const at = { x: rotX(st.k, 30.5, 20.5, s.size), y: rotY(st.k, 30.5, 20.5, s.size) };
      s.openHoles(at.x, at.y, s.econ.collapseRadius, HOLE.sinkhole, army(foeOf(team)));
      // The open cell the team would snap to (west of the 3×3 hole, nearest the unit), now under a hostile turret.
      const turret = hidden ? st.structure(foeOf(team), 'turret', 28.5, 20.5) : undefined;
      steps(g, VISION_EVERY);
      const walker = st.put(team, 'trooper', 10.5, 10.5);
      const moved = g.apply({ team, role: 'surface' }, { kind: 'move', units: [id(g, team, walker)], ...at });
      const o = walker.order as { x: number; y: number };
      const truth = s.openSurfaceNear(at.x, at.y, s.size, army(team), walker.x, walker.y)!;
      return { moved, x: canonX(st.k, o.x, o.y, s.size), y: canonY(st.k, o.x, o.y, s.size), seen: turret ? s.sees(army(team), turret) : false, truth: [canonX(st.k, truth.x, truth.y, s.size), canonY(st.k, truth.x, truth.y, s.size)] };
    }));
    const [open, hidden] = out[0]!;
    expect(open).toMatchObject({ moved: { ok: true }, x: 28.5, y: 20.5, seen: false });
    // The true body grid would skip the hidden turret; the team's knowledge does not, so the answer matches.
    expect(hidden!.truth).not.toEqual([28.5, 20.5]);
    expect({ ...hidden, truth: open!.truth }).toEqual(open);
    expect(out[1]).toEqual(out[0]);
  });

  it('posts and contested points are never damaged by a crater', () => {
    const g = arena();
    const s = g.sim;
    const home = s.posts.find((p) => p.x === 18.5 && p.y === 11.5)!;
    const centre = s.posts.find((p) => p.x === 24 && p.y === 24)!;
    impact(g, 'large', 'se', home.x, home.y);
    impact(g, 'large', 'se', centre.x, centre.y);
    for (const p of [home, centre]) {
      expect(p.dead).toBe(false);
      expect(p.hp).toBe(HOLD_ZONE_HP);
      expect(s.holes[Math.floor(p.y) * s.size + Math.floor(p.x)]).toBe(HOLE.crater);
    }
  });

  it('an ore cache under a new crater moves once to the nearest open cell (row-major in its dropper\'s frame on ties); mirrored', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const st = stage(g, team);
      const s = st.s;
      const x = rotX(st.k, 30.5, 14.5, s.size);
      const y = rotY(st.k, 30.5, 14.5, s.size);
      const cache = s.createOreCache(s.nextId++, army(team), x, y, 100);
      const before = [canonX(st.k, cache.x, cache.y, s.size), canonY(st.k, cache.x, cache.y, s.size), cache.placed];
      s.openHoles(x, y, s.econ.largeCraterRadius, HOLE.crater, army(foeOf(team)));
      return { before, after: [canonX(st.k, cache.x, cache.y, s.size), canonY(st.k, cache.x, cache.y, s.size), cache.placed], open: s.block[Math.floor(cache.y) * s.size + Math.floor(cache.x)] };
    });
    // The disc spans 2.5 tiles: the four diagonal cells at √8 are nearest; the dropper's row-major order takes the first.
    expect(out[0]).toEqual({ before: [30.5, 14.5, true], after: [28.5, 12.5, true], open: 0 });
    expect(out[1]).toEqual(out[0]);
  });
});

describe('collapse audit: the Depths under a hole', () => {
  it('rock and ore open to tunnel; rich ore, bedrock, rail and lava stay; walls strip; bulkheads in reach blow; designations and dig work clear; everyone learns the cells', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const s = g.sim;
      const st = stage(g, team);
      const foe = foeOf(team);
      st.rock(AT.x, AT.y, 3);
      const at = (dx: number, dy: number): number => st.cell(AT.x + dx, AT.y + dy);
      s.work[at(-1, -1)] = 40;
      s.designateCell(s.armies[army(team)]!, at(-1, -1), DESIGNATE_NORMAL);
      s.cells[at(0, -1)] = CELL.ore;
      s.ore[at(0, -1)] = 3;
      s.cells[at(1, -1)] = CELL.rich;
      s.ore[at(1, -1)] = 3;
      s.cells[at(-1, 0)] = CELL.bedrock;
      s.cells[at(1, 0)] = CELL.rail;
      s.cells[at(-1, 1)] = CELL.fortified;
      s.tough[at(-1, 1)] = 2;
      s.cells[at(0, 1)] = CELL.lake;
      s.cells[at(1, 1)] = CELL.tunnel;
      s.cells[at(2, 0)] = CELL.fortified;
      s.tough[at(2, 0)] = 1;
      s.cells[at(0, 3)] = CELL.tunnel;
      s.cells[at(0, 2)] = CELL.tunnel;
      const near = s.placeBulkhead(army(team), at(1, 1));
      const far = s.placeBulkhead(army(team), at(0, 3));
      st.charge(foe, AT.x, AT.y);
      steps(g, 2);
      const ring: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) ring.push(s.cells[at(dx, dy)]!);
      const known = s.groups.map((gr) => [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => gr.known[at(dx, dy)])));
      return {
        ring, known, work: s.work[at(-1, -1)], designation: s.armies[army(team)]!.designations[at(-1, -1)], ore: [s.ore[at(0, -1)], s.ore[at(1, -1)]],
        wall: [s.cells[at(2, 0)], s.tough[at(2, 0)]], near: near.dead, far: far.dead, below: [0, 2, 3].map((dy) => s.holes[at(0, dy)]),
      };
    });
    const T = CELL.tunnel;
    expect(out[0]!.ring).toEqual([T, T, CELL.rich, CELL.bedrock, T, CELL.rail, T, CELL.lake, T]);
    for (const k of out[0]!.known) expect(k).toEqual(out[0]!.ring);
    expect(out[0]).toMatchObject({ work: 0, designation: 0, ore: [0, 3], wall: [CELL.fortified, 1], near: true, far: false, below: [HOLE.sinkhole, 0, 0] });
    expect(out[1]).toEqual(out[0]);
  });

  it('an impact crater leaves the Depths units, tunnels and live charges below alone (and hits the Sky above)', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const s = g.sim;
      const st = stage(g, team);
      const foe = foeOf(team);
      st.rock(AT.x, AT.y, 2);
      // Digger and charge both under the 3×3 crater, two cells apart: out of defuse and blast reach of each other.
      s.cells[st.cell(AT.x - 1, AT.y - 1)] = CELL.tunnel;
      s.cells[st.cell(AT.x + 1, AT.y + 1)] = CELL.tunnel;
      s.cells[st.cell(AT.x + 1, AT.y)] = CELL.rail;
      const digger = st.put(team, 'digger', AT.x - 0.5, AT.y - 0.5);
      const bomber = st.put(team, 'bomber', AT.x + 0.5, AT.y + 0.5);
      bomber.hp = bomber.maxHp = 1e6;
      s.plantCharge(army(foe), st.cell(AT.x + 1, AT.y + 1));
      const due = s.charges[0]!.at;
      impact(g, 'medium', foe, rotX(st.k, AT.x + 0.5, AT.y + 0.5, s.size), rotY(st.k, AT.x + 0.5, AT.y + 0.5, s.size));
      const below = st.fate(digger);
      const crater = st.holes().length;
      const pending = s.charges.length;
      const hit = 1e6 - bomber.hp;
      steps(g, Math.max(0, due - s.tick) + 1);
      return { below, crater, hit, rail: s.cells[st.cell(AT.x + 1, AT.y)], pending, blew: s.armies[army(team)]!.events.filter((e) => e.kind === 'collapse').length };
    });
    expect(out[0]).toMatchObject({ below: { plane: 'depths', hp: STATS.digger.hp, dead: false }, crater: 9, rail: CELL.rail, pending: 1, blew: 1 });
    expect(out[0]!.hit).toBeGreaterThan(0);
    expect(out[1]).toEqual(out[0]);
  });
});

describe('collapse audit: odd ground under the hole', () => {
  it('REGRESSION: units on a hole over bedrock or a sealed lode pocket step off onto open ground and can move on; the pocket keeps its ore; mirrored', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const s = g.sim;
      const k = frame(team);
      const st = stage(g, team);
      // A sealed lode's bedrock ring: a large crater (the hole alone, without its blast) on the outcrop holes the
      // pocket and most of the ring.
      const l = s.lodes.find((x) => canonCell(k, x.c, s.size) === s.lodes[0]!.c)!;
      const wx = (l.c % s.size) + 0.5;
      const wy = Math.floor(l.c / s.size) + 0.5;
      const lx = canonX(k, wx, wy, s.size);
      const ly = canonY(k, wx, wy, s.size);
      const onRing = st.put(team, 'trooper', lx + 2, ly);
      const inPocket = st.put(team, 'trooper', lx, ly);
      expect(s.cells[st.cell(Math.floor(lx) + 2, Math.floor(ly))]).toBe(CELL.bedrock);
      const left = l.left;
      s.openHoles(wx, wy, s.econ.largeCraterRadius, HOLE.crater, army(foeOf(team)));
      const ringFate = st.fate(onRing);
      const standing = s.holes[Math.floor(onRing.y) * s.size + Math.floor(onRing.x)];
      const dest = { x: rotX(k, lx + 6, ly, s.size), y: rotY(k, lx + 6, ly, s.size) };
      const moved = g.apply({ team, role: 'surface' }, { kind: 'move', units: [id(g, team, onRing)], ...dest });
      steps(g, 40);
      return { ringFate, standing, moved, travelled: canonX(k, onRing.x, onRing.y, s.size) - ringFate.x, pocket: st.fate(inPocket), sealed: l.open, kept: l.left === left && left > 0 };
    });
    const [a] = out;
    expect(a!.ringFate).toMatchObject({ plane: 'surface', hp: STATS.trooper.hp });
    expect(a!.standing).toBe(0);
    expect(a!.moved).toEqual({ ok: true });
    expect(a!.travelled).toBeGreaterThan(1);
    // The outcrop's trooper never drops into the sealed pocket (solid ore, bedrock all round): it steps off too.
    expect(a!.pocket).toMatchObject({ plane: 'surface', hp: STATS.trooper.hp });
    expect(a!.sealed).toBe(false);
    expect(a!.kept).toBe(true);
    expect(out[1]).toEqual(out[0]);
  });

  it('REGRESSION: an airdrop coming down into a hole opened meanwhile falls through it like units standing there; mirrored', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const s = g.sim;
      const st = stage(g, team);
      st.rock(30, 20, 1);
      const drop = st.put(team, 'trooper', 30.5, 20.5, 'sky');
      s.startTransit(drop, TRANSITS.airdrop);
      s.openCells([st.cell(30, 20)], HOLE.crater, army(foeOf(team)));
      steps(g, s.econ.aerieDropTravel + 1);
      return { fate: st.fate(drop), fell: s.armies[army(team)]!.events.filter((e) => e.kind === 'fell_into_depths').length, by: drop.lastHitBy === army(foeOf(team)) };
    });
    // The crater's opener is credited with the fall (it is hostile), whenever the drop lands in it.
    expect(out[0]).toEqual({ fate: { plane: 'depths', hp: STATS.trooper.hp - Math.ceil(STATS.trooper.hp * 0.25), dead: false, x: 30.5, y: 20.5 }, fell: 1, by: true });
    expect(out[1]).toEqual(out[0]);
  });

  it('a hole over a lava lake drops units into the lava: they burn and can walk out to dry tunnel', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const s = g.sim;
      const st = stage(g, team);
      const c = st.cell(17, 12);
      expect(s.cells[c]).toBe(CELL.lake);
      const u = st.put(team, 'trooper', 17.5, 12.5);
      s.openCells([c], HOLE.crater, army(foeOf(team)));
      const fell = st.fate(u);
      expect(g.apply({ team, role: 'depths' }, { kind: 'move', units: [id(g, team, u)], x: rotX(st.k, 17.5, 11.5, s.size), y: rotY(st.k, 17.5, 11.5, s.size) })).toEqual({ ok: true });
      steps(g, 100);
      return { fell, after: st.fate(u), on: s.cells[Math.floor(u.y) * s.size + Math.floor(u.x)] };
    });
    const [a] = out;
    expect(a!.fell).toMatchObject({ plane: 'depths', hp: STATS.trooper.hp - 25 });
    expect(a!.after.dead).toBe(false);
    expect(a!.after.hp).toBeLessThan(STATS.trooper.hp - 25);
    expect(a!.on).toBe(CELL.tunnel);
    expect(out[1]).toEqual(out[0]);
  });

  it('REGRESSION: a Trooper housed in a Drill Yard sits out the cave-in but falls when it steps out onto the hole (yard felled, or converted); mirrored', () => {
    const out = TEAMS.map((team) => [2, 1].map((stack) => {
      const g = arena();
      const s = g.sim;
      const st = stage(g, team);
      st.rock(AT.x, AT.y, 3);
      // A 2×2 yard over cells 23..24 × 40..41, its trainee at the doorstep cell east of it, all inside the 3×3 sinkhole.
      const yard = st.structure(team, 'drill_yard', AT.x, AT.y);
      const trainee = st.put(team, 'trooper', AT.x + 1.5, AT.y + 0.5);
      trainee.hangar = yard.id;
      trainee.state = 'converting';
      yard.link = trainee.id;
      // Two stacked fell the yard (500 HP); one leaves it standing to finish the conversion this very tick.
      yard.workT = s.stats.breacher.build - 1;
      st.charge(foeOf(team), AT.x, AT.y, stack);
      s.charges[0]!.at = s.tick;
      g.step();
      const unit = s.ents.find((e) => !e.dead && e.side === army(team) && (e.kind === 'trooper' || e.kind === 'breacher'))!;
      return { yard: yard.hp > 0, kind: unit.kind, ...st.fate(unit) };
    }));
    const [felled, converted] = out[0]!;
    expect(felled).toMatchObject({ yard: false, kind: 'trooper', plane: 'depths', hp: STATS.trooper.hp - 25 });
    expect(converted).toMatchObject({ yard: true, kind: 'breacher', plane: 'depths' });
    expect(out[1]).toEqual(out[0]);
  });

  it('the Mother Lode stays solid under a crater and units over it step off onto open ground; mirrored', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const s = g.sim;
      const st = stage(g, team);
      const lode = s.motherCells[0]!;
      const u = st.put(team, 'trooper', (lode % s.size) + 0.5, Math.floor(lode / s.size) + 0.5);
      s.openHoles(24, 24, s.econ.largeCraterRadius, HOLE.crater, army(foeOf(team)));
      return { solid: s.motherCells.every((c) => s.cells[c] === CELL.lode), fate: st.fate(u), standing: s.holes[Math.floor(u.y) * s.size + Math.floor(u.x)] };
    });
    expect(out[0]).toMatchObject({ solid: true, fate: { plane: 'surface', hp: STATS.trooper.hp }, standing: 0 });
    expect(out[1]).toEqual(out[0]);
  });

  it('a Depths structure below (a bulkhead) holds the ground for units over it: they step off; green rich ore too; mirrored', () => {
    const out = TEAMS.map((team) => {
      const g = arena();
      const s = g.sim;
      const st = stage(g, team);
      st.rock(AT.x, AT.y, 2);
      s.cells[st.cell(AT.x, AT.y)] = CELL.tunnel;
      s.placeBulkhead(army(foeOf(team)), st.cell(AT.x, AT.y));
      s.cells[st.cell(AT.x + 1, AT.y)] = CELL.rich;
      s.ore[st.cell(AT.x + 1, AT.y)] = 3;
      const gated = st.put(team, 'trooper', AT.x + 0.5, AT.y + 0.5);
      const rich = st.put(team, 'tank', AT.x + 1.5, AT.y + 0.5);
      const open = st.put(team, 'trooper', AT.x + 0.5, AT.y - 0.5);
      s.openCells([st.cell(AT.x, AT.y), st.cell(AT.x + 1, AT.y), st.cell(AT.x, AT.y - 1)], HOLE.crater, army(foeOf(team)));
      const on = (e: Ent): number => s.holes[Math.floor(e.y) * s.size + Math.floor(e.x)]!;
      return { gated: { ...st.fate(gated), on: on(gated) }, rich: { ...st.fate(rich), on: on(rich), ore: s.ore[st.cell(AT.x + 1, AT.y)] }, open: st.fate(open) };
    });
    expect(out[0]).toMatchObject({
      gated: { plane: 'surface', hp: STATS.trooper.hp, on: 0 },
      rich: { plane: 'surface', hp: STATS.tank.hp, on: 0, ore: 3 },
      open: { plane: 'depths' },
    });
    expect(out[1]).toEqual(out[0]);
  });
});

describe('collapse audit: C4 rotation', () => {
  /** A four-army match and the first canonical cell (row-major, inside slot 0's quarter) whose 5×5 block is open, non-fault ground in every rotation. */
  function c4() {
    const g = new AgentCommandGame(5, { map: { name: 'four_corners' }, spire: { dmg: 0 }, orbit: { maxAsteroids: 0 } });
    const s = g.sim;
    for (const e of s.ents) if (e.kind !== 'spire' && e.kind !== 'island' && e.kind !== 'post') e.hp = 0;
    steps(g, VISION_EVERY);
    const size = s.size;
    // The map is C4, so one rotation decides, but the check covers all four.
    const clear = (x: number, y: number): boolean => s.allArmies.every((a) => {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const c = rotCell(s.armyFrame[a]!, (y + dy) * size + x + dx, size);
        if (s.block[c] || s.faultOf[c]! >= 0) return false;
      }
      return true;
    });
    let at = { x: -1, y: -1 };
    for (let y = 12; y < size / 2 - 3 && at.x < 0; y++) for (let x = 12; x < size / 2 - 3 && at.x < 0; x++) if (clear(x, y)) at = { x, y };
    expect(at.x).toBeGreaterThan(0);
    return { g, s, size, at };
  }

  it('four rotated charges under four rotated squads give rotated holes and fates (the tank wrecked, falls credited to the planter)', () => {
    const { g, s, size, at } = c4();
    const fates: unknown[] = [];
    const holes: number[][] = [];
    const placed: Ent[][] = [];
    for (const a of s.allArmies) {
      const k = s.armyFrame[a]!;
      const cell = (x: number, y: number): number => rotCell(k, y * size + x, size);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const c = cell(at.x + dx, at.y + dy);
        expect(s.block[c], `army ${a} cell ${dx},${dy}`).toBe(0);
        s.cells[c] = CELL.rock;
        s.magma[c] = 0;
      }
      s.cells[cell(at.x, at.y)] = CELL.tunnel;
      const foe = s.allArmies[(a + 1) % s.allArmies.length]!;
      s.plantCharge(foe, cell(at.x, at.y));
      const units: Ent[] = [];
      for (const [kind, x, y] of [['trooper', 0.5, 0.5], ['tank', -0.5, 1.5], ['trooper', 2.75, 0.5]] as const) {
        const e = s.spawnUnit(a, kind, 'surface');
        e.x = rotX(k, at.x + x, at.y + y, size);
        e.y = rotY(k, at.x + x, at.y + y, size);
        units.push(e);
      }
      placed.push(units);
    }
    for (const ch of s.charges) ch.at = s.tick + 1;
    steps(g, 2);
    for (const a of s.allArmies) {
      const k = s.armyFrame[a]!;
      const foe = s.allArmies[(a + 1) % s.allArmies.length]!;
      fates.push(placed[a]!.map((e) => ({ plane: e.plane, hp: e.hp, dead: e.dead, credited: e.plane === 'depths' ? e.lastHitBy === foe : null, x: canonX(k, e.x, e.y, size), y: canonY(k, e.x, e.y, size) })));
      const mine: number[] = [];
      for (let c = 0; c < s.n; c++) {
        if (!s.holes[c]) continue;
        const cc = canonCell(k, c, size);
        if (Math.abs((cc % size) - at.x) <= 2 && Math.abs(Math.floor(cc / size) - at.y) <= 2) mine.push(cc);
      }
      holes.push(mine.sort((x, y) => x - y));
    }
    expect(holes[0]).toHaveLength(9);
    expect(fates[0]).toMatchObject([{ plane: 'depths', dead: false, credited: true }, { plane: 'depths', dead: true, credited: true }, { plane: 'surface', dead: false }]);
    for (let a = 1; a < 4; a++) {
      expect(holes[a], `army ${a}`).toEqual(holes[0]);
      expect(fates[a], `army ${a}`).toEqual(fates[0]);
    }
  });

  it('four rotated craters: a tank over rich ore and a unit over a bulkhead step off, a cache moves and a move into the crater snaps to rotated rim cells', () => {
    const { g, s, size, at } = c4();
    const out = s.allArmies.map((a) => {
      const k = s.armyFrame[a]!;
      const foe = s.allArmies[(a + 1) % s.allArmies.length]!;
      const cell = (x: number, y: number): number => rotCell(k, y * size + x, size);
      const w = (x: number, y: number) => ({ x: rotX(k, x, y, size), y: rotY(k, x, y, size) });
      const put = (kind: UnitKind, x: number, y: number): Ent => Object.assign(s.spawnUnit(a, kind, 'surface'), w(x, y));
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        s.cells[cell(at.x + dx, at.y + dy)] = CELL.rock;
        s.magma[cell(at.x + dx, at.y + dy)] = 0;
      }
      s.cells[cell(at.x + 1, at.y)] = CELL.rich;
      s.ore[cell(at.x + 1, at.y)] = 3;
      s.cells[cell(at.x - 1, at.y)] = CELL.tunnel;
      s.placeBulkhead(foe, cell(at.x - 1, at.y));
      const tank = put('tank', at.x + 1.5, at.y + 0.5);
      const gated = put('trooper', at.x - 0.5, at.y + 0.5);
      const faller = put('trooper', at.x + 0.5, at.y + 0.5);
      const cache = s.createOreCache(s.nextId++, a, w(at.x + 0.5, at.y + 0.5).x, w(at.x + 0.5, at.y + 0.5).y, 100);
      const centre = w(at.x + 0.5, at.y + 0.5);
      s.openHoles(centre.x, centre.y, s.econ.collapseRadius, HOLE.crater, foe);
      const walker = put('trooper', at.x + 2.5, at.y + 2.5);
      const moved = g.apply({ team: s.sideId(a) as ArmyId, role: 'surface' }, { kind: 'move', units: [id(g, s.sideId(a) as ArmyId, walker)], ...centre });
      const o = walker.order as { x: number; y: number };
      const canon = (p: { x: number; y: number }) => [canonX(k, p.x, p.y, size), canonY(k, p.x, p.y, size)];
      return {
        tank: { plane: tank.plane, at: canon(tank) }, gated: { plane: gated.plane, at: canon(gated) },
        faller: { plane: faller.plane, credited: faller.lastHitBy === foe }, rich: s.cells[cell(at.x + 1, at.y)],
        cache: [...canon(cache), cache.placed], moved, goal: canon(o),
      };
    });
    expect(out[0]).toMatchObject({ tank: { plane: 'surface' }, gated: { plane: 'surface' }, faller: { plane: 'depths', credited: true }, rich: CELL.rich, cache: [at.x + 0.5, at.y - 1.5, true], moved: { ok: true } });
    for (let a = 1; a < 4; a++) expect(out[a], `army ${a}`).toEqual(out[0]);
  });
});
