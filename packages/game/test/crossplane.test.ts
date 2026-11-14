/** Cross-plane play and what the client is shown: fx, vision, memory, charges, tremors, scans, portals, segments. */
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import {
  CELL,
  ECON,
  STATS,
  VISION_BITS_PER_WORD,
  observationSchema,
  toTicks,
  viewSchema,
  type MatchOptions,
  type Plane,
  type ArmyId,
  type UnitKind,
  type View,
} from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';
import { HOLE, VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';

const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const cell = (g: AgentCommandGame, x: number, y: number): number => y * g.sim.size + x;
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
function arena(seed = 6, orbit: MatchOptions['orbit'] = {}): AgentCommandGame {
  const g = createGame({ seed, options: { map: { params: { spireInset: 8 } }, orbit } }); // Fixed-layout cross-plane combat fixtures.
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, x: number, y: number, plane: Plane = STATS[kind].plane): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, plane);
  e.x = x;
  e.y = y;
  return e;
}
const hold = (g: AgentCommandGame, team: ArmyId, e: Ent): void => {
  act(g, team, e.plane, { kind: 'stance', units: [id(g, team, e)], stance: 'hold' });
};
/** Open a hole (what a collapse or a crater does to the map). */
function hole(g: AgentCommandGame, x: number, y: number): void {
  g.sim.openCells([cell(g, x, y)], HOLE.sinkhole, NEUTRAL);
}
/** Step and gather every fx a team's views carried meanwhile (views only hold the last half second). */
function collect(g: AgentCommandGame, ticks: number): Record<'nw' | 'se', View['fx']> {
  const out: Record<'nw' | 'se', View['fx']> = { nw: [], se: [] };
  for (let i = 0; i < ticks; i++) {
    g.step();
    for (const team of ['nw', 'se'] as const) for (const f of g.view(team).fx) if (f.tick === g.tick) out[team].push(f);
  }
  return out;
}
const visible = (bits: number[], c: number): boolean => ((bits[(c / VISION_BITS_PER_WORD) | 0]! >>> c % VISION_BITS_PER_WORD) & 1) === 1;

describe('Spire segment beams', () => {
  it('the Orbit segment fires at Orbit enemies but never reaches an adjacent plane', () => {
    const g = arena();
    const segment = g.sim.armies[0]!.spire.orbit;
    for (const plane of ['depths', 'surface', 'sky', 'orbit'] as const) {
      expect(g.sim.canHit(segment, plane), plane).toBe(plane === 'orbit');
      if (plane !== 'orbit') g.sim.armies[0]!.spire[plane].cd = Infinity;
    }
    const raider = put(g, 'se', 'lancer', segment.x + 4, segment.y);
    const below = put(g, 'se', 'interceptor', segment.x + 4, segment.y);
    hold(g, 'se', raider);
    hold(g, 'se', below);
    steps(g, toTicks(2));
    expect(raider.hp + raider.shield).toBeLessThan(STATS.lancer.hp + STATS.lancer.shield!);
    expect(below.hp).toBe(STATS.interceptor.hp);
  });
});

describe('shot fx', () => {
  it('carry true planes for cross-plane fire, and only show an unseen shooter as an incoming hit', () => {
    const g = arena();
    const flak = put(g, 'nw', 'flak', 20, 20);
    hold(g, 'nw', flak);
    const plane = put(g, 'se', 'interceptor', 25, 20);
    plane.hp = 1e6;
    hold(g, 'se', plane);
    const bomber = put(g, 'nw', 'bomber', 30, 30);
    bomber.hp = 1e6;
    const ground = put(g, 'se', 'trooper', 30.5, 30);
    ground.hp = 1e6;
    hold(g, 'se', ground);
    const seen = collect(g, toTicks(4));
    const blueFx = seen.nw;
    const flakShot = blueFx.find((f) => f.kind === 'shot' && f.subject === 'flak');
    expect(flakShot).toMatchObject({ plane: 'surface', tp: 'sky', w: 'flak', src: id(g, 'nw', flak), side: 'nw' });
    expect(flakShot!.arrive).toBeGreaterThan(flakShot!.tick);
    const bomb = blueFx.find((f) => f.kind === 'shot' && f.subject === 'bomber');
    expect(bomb).toMatchObject({ plane: 'sky', tp: 'surface', w: 'bomb', src: id(g, 'nw', bomber) });
    // Red's interceptor cannot see the flak (no red surface vision there): it gets an incoming hit at itself only.
    const redFx = seen.se.filter((f) => f.kind === 'shot' && f.w === 'flak');
    expect(redFx.length).toBeGreaterThan(0);
    for (const f of redFx) {
      expect(f.plane).toBe('sky');
      expect(f.src).toBeUndefined();
      expect(f.tp).toBeUndefined();
      expect(Math.hypot(f.x - plane.x, f.y - plane.y)).toBeLessThan(3);
    }
    expect(validate(viewSchema, g.view('se')).ok).toBe(true);
  });
});

describe('vision, memory, fog', () => {
  it('vision bitsets mirror team vision; enemy structures leave ghosts until their cell is seen empty', () => {
    const g = arena();
    const s = g.sim;
    const scout = put(g, 'nw', 'trooper', 30, 30);
    const turret = s.build(1, 'turret', 32.5, 30.5, 'surface');
    turret.built = true;
    turret.hp = turret.maxHp;
    steps(g, VISION_EVERY);
    let view = g.view('nw');
    for (let c = 0; c < s.size * s.size; c += 7) expect(visible(view.vision.surface, c)).toBe((s.vis[1]![c]! & s.armies[0]!.group.bit) !== 0);
    expect(view.entities.some((e) => e.id === id(g, 'nw', turret))).toBe(true);
    expect(view.memory).toEqual([]);
    // Walk away: the turret becomes a ghost at its last known position.
    scout.x = 12;
    scout.y = 30;
    steps(g, VISION_EVERY);
    view = g.view('nw');
    expect(view.entities.some((e) => e.id === id(g, 'nw', turret))).toBe(false);
    expect(view.memory).toEqual([expect.objectContaining({ id: id(g, 'nw', turret), kind: 'turret', side: 'se', plane: 'surface' })]);
    // It dies unseen; the ghost stays until blue looks again.
    turret.hp = 0;
    steps(g, VISION_EVERY);
    expect(g.view('nw').memory).toHaveLength(1);
    scout.x = 30;
    scout.y = 30;
    steps(g, VISION_EVERY);
    expect(g.view('nw').memory).toEqual([]);
  });

  it('tremors reveal enemy depths units right under your surface presence, at cell precision only', () => {
    const g = arena();
    const sapper = put(g, 'se', 'sapper', 30.5, 30.5, 'depths');
    g.sim.cells[cell(g, 30, 30)] = CELL.tunnel;
    steps(g, VISION_EVERY);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).tremors).toEqual([]);
    put(g, 'nw', 'trooper', 31.2, 31.4);
    steps(g, VISION_EVERY);
    const obs = g.observe({ team: 'nw', role: 'sky' }, 0);
    expect(obs.tremors).toEqual([{ x: 30, y: 30 }]);
    // Sensed, not seen: Blue has no name for the sapper and sees no Red sapper.
    expect(g.sim.aliasOf(g.sim.armyIndex('nw'), sapper.id)).toBe(0);
    expect(obs.entities.some((e) => e.side === 'se' && e.kind === 'sapper')).toBe(false);
  });
});

describe('charges', () => {
  it('one our team knows of (here inside our Spire\'s Depths vision) can be defused by any of our depths units standing next to it for 2 s', () => {
    const g = arena();
    const s = g.sim;
    const sapper = put(g, 'se', 'sapper', 10.5, 10.5, 'depths');
    s.armies[1]!.group.known[cell(g, 10, 10)] = CELL.tunnel;
    expect(act(g, 'se', 'depths', { kind: 'undermine', units: [id(g, 'se', sapper)], x: 10, y: 10 })).toEqual({ ok: true });
    steps(g, 2);
    const planted = g.observe({ team: 'nw', role: 'surface' }, 0).charges;
    expect(planted).toEqual([{ x: 10, y: 10, side: 'se', tick: expect.any(Number) }]);
    expect(g.events({ team: 'nw', role: 'depths' }, 0).some((e) => e.kind === 'charge_spotted')).toBe(true);
    sapper.hp = 0; // the charge stays armed without its sapper
    const digger = put(g, 'nw', 'digger', 10.5, 8.5, 'depths');
    expect(act(g, 'nw', 'depths', { kind: 'move', units: [id(g, 'nw', digger)], x: 10.5, y: 10.5, mode: 'move' })).toEqual({ ok: true });
    const seen = collect(g, ECON.defuseTicks + toTicks(1.5));
    expect(s.charges).toEqual([]);
    expect(g.events({ team: 'se', role: 'depths' }, 0).some((e) => e.kind === 'charge_defused')).toBe(true);
    expect(seen.se.some((f) => f.kind === 'defuse')).toBe(true);
    expect(seen.nw.some((f) => f.kind === 'defuse')).toBe(true);
    steps(g, ECON.undermineTicks);
    expect(s.holeCount).toBe(0);
    expect(s.armies[0]!.spire.surface.hp).toBe(s.armies[0]!.spire.surface.maxHp);
  });
});

describe('holes are no portals', () => {
  it('no trooper of either team transfers through a sinkhole', () => {
    const g = arena();
    hole(g, 24, 24);
    for (const team of ['nw', 'se'] as const) {
      const t = put(g, team, 'trooper', team === 'nw' ? 22.6 : 26.4, 24.5);
      expect(act(g, team, 'surface', { kind: 'transfer', units: [id(g, team, t)], to: 'depths', x: 24.5, y: 24.5 })).toEqual({ ok: false, code: 'no_shaft' });
      const below = put(g, team, 'trooper', 24.5, 24.5, 'depths');
      expect(act(g, team, 'depths', { kind: 'transfer', units: [id(g, team, below)], to: 'surface', x: 24.5, y: 24.5 })).toEqual({ ok: false, code: 'no_shaft' });
    }
  });
});

describe('orbital scan', () => {
  it('reveals every plane around a point (depths cells become known), then expires; costs energy, has a cooldown', () => {
    const g = arena();
    const s = g.sim;
    const target = { x: 40, y: 40 };
    const sky = put(g, 'se', 'interceptor', 38, 41);
    const ground = put(g, 'se', 'tank', 41, 38);
    const below = put(g, 'se', 'digger', 40.5, 39.5, 'depths');
    for (const e of [sky, ground]) hold(g, 'se', e);
    steps(g, VISION_EVERY);
    // Unseen before the scan: Blue has no name for any of them.
    expect([sky, ground, below].map((u) => s.aliasOf(s.armyIndex('nw'), u.id))).toEqual([0, 0, 0]);
    s.armies[0]!.energy = 200;
    expect(act(g, 'nw', 'orbit', { kind: 'scan', x: target.x, y: target.y })).toEqual({ ok: true });
    expect(s.armies[0]!.energy).toBe(200 - ECON.scanCost);
    expect(act(g, 'nw', 'orbit', { kind: 'scan', x: 20, y: 20 })).toEqual({ ok: false, code: 'cooldown' });
    const during = g.view('nw');
    for (const u of [sky, ground, below]) expect(during.entities.some((e) => e.id === id(g, 'nw', u))).toBe(true);
    expect(during.depths[cell(g, 40, 40)]).toBe(CELL.tunnel);
    expect(g.observe({ team: 'nw', role: 'orbit' }, 0).res.scanReadyAt).toBe(g.tick + ECON.scanCooldownTicks);
    steps(g, ECON.scanTicks + VISION_EVERY + 1);
    const after = g.view('nw');
    expect(after.entities.some((e) => [sky, ground, below].some((u) => id(g, 'nw', u) === e.id))).toBe(false);
    expect(after.depths[cell(g, 40, 40)]).toBe(CELL.tunnel); // knowledge persists
    steps(g, ECON.scanCooldownTicks);
    s.armies[0]!.spire.orbit.hp = 0;
    expect(act(g, 'nw', 'orbit', { kind: 'scan', x: 20, y: 20 })).toEqual({ ok: false, code: 'segment_destroyed' });
  });
});

describe('Spire segment loss', () => {
  it('depths root lost: ore only at shafts and half trickle; sky lost: minimum base energy delivery', () => {
    const g = arena();
    const s = g.sim;
    const t = s.armies[0]!;
    const a0 = t.alloy;
    steps(g, toTicks(10));
    const fullTrickle = t.alloy - a0;
    expect(fullTrickle).toBeCloseTo(10 * ECON.spireAlloyRate, 6);
    t.spire.depths.hp = 0;
    steps(g, 1);
    expect(Array.from(t.drop).some((v) => v === 1)).toBe(false);
    const a1 = t.alloy;
    steps(g, toTicks(10));
    expect(t.alloy - a1).toBeCloseTo(10 * ECON.spireAlloyRate * ECON.rootlessTrickle, 6);
    const solar = put(g, 'nw', 'solar', s.size / 2 + 10 * Math.cos(s.sunAngle), s.size / 2 + 10 * Math.sin(s.sunAngle));
    solar.order = { k: 'none' };
    steps(g, 2);
    expect(g.observe({ team: 'nw', role: 'orbit' }, 0).res.energyCap).toBe(ECON.baseEnergyCap);
    t.spire.sky.hp = 0;
    steps(g, 2);
    const res = g.observe({ team: 'nw', role: 'orbit' }, 0).res;
    expect(res.energyCap).toBe(ECON.minimumEnergyCap);
    expect(res.energyRate).toBe(ECON.minimumEnergyCap);
  });
});

describe('sky over the enemy', () => {
  it('turrets and flak shoot a relay whose island drifts overhead', () => {
    const g = arena();
    const s = g.sim;
    const island = s.ents.find((e) => e.kind === 'island')!;
    s.setSide(island, 0);
    expect(act(g, 'nw', 'sky', { kind: 'queue_add', item: 'relay', island: id(g, 'nw', island) })).toEqual({ ok: true });
    g.step(); // the queue funds the relay and places its site
    const relay = s.alive(island.link)!;
    relay.built = true;
    relay.hp = relay.maxHp;
    // Red defences under the island's path.
    const turret = s.build(1, 'turret', island.x, island.y, 'surface');
    turret.built = true;
    turret.hp = turret.maxHp;
    put(g, 'se', 'flak', island.x + 1, island.y + 1);
    steps(g, toTicks(4));
    expect(relay.hp).toBeLessThan(relay.maxHp);
  });

  it('nothing in the sky reaches orbit: interceptors neither see nor shoot arrays above them', () => {
    // No derelict: its chamber at the centre irradiates Orbit ships, which is not what this measures.
    const g = arena(6, { derelictEnabled: false });
    const hunter = put(g, 'nw', 'interceptor', 24, 24);
    const array = put(g, 'se', 'solar', 26, 24);
    array.order = { k: 'none' };
    hold(g, 'nw', hunter);
    const seen = collect(g, toTicks(3));
    expect(array.hp).toBe(STATS.solar.hp);
    expect(seen.nw.some((f) => f.kind === 'shot' && f.tp === 'orbit')).toBe(false);
    // Never seen, so Blue has no name for the array; a name it never gave answers like a hidden target.
    expect(g.sim.aliasOf(g.sim.armyIndex('nw'), array.id)).toBe(0);
    const unnamed = `e_${g.sim.armies[g.sim.armyIndex('nw')]!.aliases.count + 1}`;
    expect(act(g, 'nw', 'sky', { kind: 'attack', units: [id(g, 'nw', hunter)], target: unnamed })).toEqual({ ok: false, code: 'not_visible' });
  });
});

describe('schemas', () => {
  it('observations and views with every new field validate', () => {
    const g = arena();
    put(g, 'nw', 'trooper', 30, 30);
    put(g, 'se', 'sapper', 30.5, 30.5, 'depths');
    act(g, 'nw', 'surface', { kind: 'rally', x: 15, y: 15 });
    steps(g, toTicks(1));
    for (const team of ['nw', 'se'] as const) {
      const v = validate(viewSchema, g.view(team));
      expect(v.ok ? true : v).toBe(true);
      for (const role of ['depths', 'surface', 'sky', 'orbit'] as const) {
        const o = validate(observationSchema, g.observe({ team, role }, 0));
        expect(o.ok ? true : o).toBe(true);
      }
    }
  });
});

describe('turret focus fire', () => {
  it.each(['nw', 'se'] as const)('%s can focus a visible Sky target without gaining structure movement orders', (team) => {
    const g = arena();
    const enemy = team === 'nw' ? 'se' : 'nw';
    const x = team === 'nw' ? 20.5 : g.sim.size - 20.5;
    const y = team === 'nw' ? 24.5 : g.sim.size - 24.5;
    const dx = team === 'nw' ? 1 : -1;
    const turret = g.sim.build(slotOfArmyId(team, 2), 'turret', x, y, 'surface');
    turret.built = true;
    turret.hp = turret.maxHp;
    g.sim.armies[slotOfArmyId(team, 2)]!.energy = 1000;
    const target = put(g, enemy, 'bomber', x + dx, y);
    target.hp = 1e6;
    const other = put(g, enemy, 'interceptor', x + 2 * dx, y);
    other.hp = 1e6;
    hold(g, enemy, target);
    hold(g, enemy, other);
    steps(g, VISION_EVERY);
    const order: AgentCommandIntent = { kind: 'attack', units: [id(g, team, turret)], target: id(g, team, target) };
    expect(act(g, team, 'surface', order)).toEqual({ ok: true });
    expect(turret.order).toEqual({ k: 'attack', target: target.id });
    const shots = collect(g, toTicks(2))[team].filter((f) => f.kind === 'shot' && f.src === id(g, team, turret));
    expect(shots.some((f) => f.tp === 'sky' && Math.abs((f.tx ?? 0) - target.x) < 0.5)).toBe(true);
    expect([turret.x, turret.y]).toEqual([x, y]);
    for (const intent of [
      { kind: 'move', units: [id(g, team, turret)], x: 22, y: 24 },
      { kind: 'patrol', units: [id(g, team, turret)], x: 22, y: 24 },
      { kind: 'stance', units: [id(g, team, turret)], stance: 'hold' },
    ] as AgentCommandIntent[]) expect(act(g, team, 'surface', intent)).toEqual({ ok: false, code: 'not_your_unit' });
    expect(act(g, team, 'sky', order)).toEqual({ ok: false, code: 'wrong_plane' });
    // A target seen once and now out of sight: still named, but not attackable.
    const hidden = put(g, enemy, 'interceptor', x + 3 * dx, y);
    hidden.hp = 1e6;
    hold(g, enemy, hidden);
    steps(g, VISION_EVERY);
    const hiddenId = id(g, team, hidden);
    hidden.x = x;
    hidden.y = 40;
    steps(g, VISION_EVERY);
    expect(act(g, team, 'surface', { ...order, target: hiddenId })).toEqual({ ok: false, code: 'not_visible' });
    const ownTarget = put(g, team, 'interceptor', x, 24);
    steps(g, VISION_EVERY);
    expect(act(g, enemy, 'surface', { ...order, units: [id(g, enemy, turret)], target: id(g, enemy, ownTarget) })).toEqual({ ok: false, code: 'not_your_unit' });
    const spire = g.sim.ents.find((e) => e.kind === 'spire' && e.side === slotOfArmyId(team, 2) && e.plane === 'surface')!;
    expect(act(g, team, 'surface', { ...order, units: [id(g, team, spire)] })).toEqual({ ok: false, code: 'not_your_unit' });
  });
});
