/**
 * Deploy stances (DESIGN §4.2 Deploy states): dug-in Troopers, sieged tanks and emplaced flak, and flak
 * against falling payloads. Every sim scenario runs for both armies on point-mirrored positions.
 */
import { describe, expect, it } from 'vitest';
import { DAMAGE_VS, DEPLOY_SPECS, ECON, STATS, SURFACE, footprintDistance, toTicks, type ArmyId, type Plane, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { LineOfSight } from '../src/nav/nav.ts';
import { DEPLOY_NONE, DEPLOY_UP, PLANE_INDEX, VISION_EVERY } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const TEAMS = ['nw', 'se'] as const;
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const foeOf = (team: ArmyId): ArmyId => (team === 'nw' ? 'se' : 'nw');
/** Army frame → world: se sees the map turned half a turn. */
const at = (g: AgentCommandGame, team: ArmyId, x: number, y: number): [number, number] => (team === 'se' ? [g.sim.size - x, g.sim.size - y] : [x, y]);

/** Only the Spires (and neutral islands) left, on level open ground: these tests measure the stances alone. */
function arena(options: Record<string, unknown> = {}): AgentCommandGame {
  const g = createGame({ seed: 5, options: { terrain: 'open', ...options } });
  g.sim.terrain.fill(SURFACE.ground);
  g.sim.surfaceCost.fill(1);
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.step();
  return g;
}
/** A `kind` of `team` at (x, y) in `owner`'s frame (default: `team`'s own), holding its ground. */
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, x: number, y: number, owner: ArmyId = team): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, STATS[kind].plane);
  [e.x, e.y] = at(g, owner, x, y);
  e.stance = 'hold';
  return e;
}
function turret(g: AgentCommandGame, team: ArmyId, x: number, y: number, owner: ArmyId): Ent {
  const [wx, wy] = at(g, owner, x, y);
  const t = g.sim.build(slotOfArmyId(team, 2), 'turret', wx, wy, 'surface');
  steps(g, STATS.turret.build + 1);
  expect(t.built).toBe(true);
  return t;
}
/** Deploy `e` and wait until its stance is fully up. */
function deployed(g: AgentCommandGame, team: ArmyId, e: Ent): void {
  expect(act(g, team, 'surface', { kind: 'deploy', units: [id(g, team, e)], on: true })).toEqual({ ok: true });
  steps(g, g.sim.econ[DEPLOY_SPECS[STATS[e.kind as 'tank'].deploy!].deployTicks] + 1);
  expect(e.deploy).toBe(DEPLOY_UP);
}
/** Range `e` has against `t` beyond the edge term (what reach() adds to the target's edge). */
function ownRange(g: AgentCommandGame, e: Ent, t: Ent): number {
  const d = Math.hypot(t.x - e.x, t.y - e.y);
  return g.sim.reach(e, t) - (t.structure ? d - footprintDistance(t.kind, t.x, t.y, e.x, e.y) : t.radius);
}

describe('deploy stance rules', () => {
  it('ships the wave 1 numbers', () => {
    expect([ECON.digInTicks, ECON.digOutTicks, ECON.dugInDamageTaken, ECON.dugInVision]).toEqual([40, 20, 0.6, 1]);
    expect([ECON.siegeDeployTicks, ECON.siegePackTicks, ECON.siegeRangeStructures, ECON.siegeRangeUnits, ECON.siegeMinRange]).toEqual([60, 60, 9, 7.5, 2]);
    expect([ECON.emplaceTicks, ECON.unemplaceTicks, ECON.emplacedFlakRange, ECON.emplacedFlakCooldown]).toEqual([40, 40, 9, 0.75]);
    expect([ECON.flakPayloadMultiplier, ECON.flakPayloadRange]).toEqual([2, 2]);
    expect(DEPLOY_SPECS.dug_in.damageFrom).toEqual(['rifle', 'cannon', 'turret']);
    expect([STATS.trooper.deploy, STATS.tank.deploy, STATS.flak.deploy, STATS.warden.deploy]).toEqual(['dug_in', 'siege', 'emplaced', 'walled']);
  });

  it('rejects kinds without a stance, and stances switched off by the match rules', () => {
    const g = arena({ surface: { siegeEnabled: false } });
    const tank = put(g, 'nw', 'tank', 16, 24);
    const trooper = put(g, 'nw', 'trooper', 18, 24);
    expect(act(g, 'nw', 'surface', { kind: 'deploy', units: [id(g, 'nw', tank)], on: true })).toEqual({ ok: false, code: 'blocked' });
    expect(act(g, 'nw', 'surface', { kind: 'deploy', units: [id(g, 'nw', trooper)], on: true })).toEqual({ ok: true });
    const digger = put(g, 'nw', 'digger', 20, 24);
    expect(act(g, 'nw', 'depths', { kind: 'deploy', units: [id(g, 'nw', digger)], on: true })).toEqual({ ok: false, code: 'wrong_kind' });
    expect(tank.deploy).toBe(DEPLOY_NONE);
  });
});

describe.each(TEAMS)('dug in (%s)', (team) => {
  const foe = foeOf(team);

  it('digs in for digInTime, takes ×0.6 from rifle, cannon and turret only, cannot move, climbs out before a move', () => {
    const g = arena();
    const s = g.sim;
    const u = put(g, team, 'trooper', 16.5, 24.5);
    expect(act(g, team, 'surface', { kind: 'deploy', units: [id(g, team, u)], on: true })).toEqual({ ok: true });
    expect(u.state).toBe('digging_in');
    steps(g, ECON.digInTicks - 1);
    expect(u.state).toBe('digging_in');
    expect(u.progress).toBeGreaterThan(0.9);
    expect(s.dugIn(u)).toBe(false);
    steps(g, 2);
    expect(u.state).toBe('dug_in');
    expect(s.dugIn(u)).toBe(true);
    for (const w of ['rifle', 'cannon', 'turret'] as const) expect(s.weaponVs(w, u)).toBeCloseTo(DAMAGE_VS[w].light * ECON.dugInDamageTaken, 12);
    for (const w of ['bomb', 'beam', 'flak', 'shotgun'] as const) expect(s.weaponVs(w, u)).toBe(DAMAGE_VS[w].light);
    // Impacts, collapses and falls arrive as plain damage: unchanged.
    const hp = u.hp;
    s.damage(u, 30, slotOfArmyId(foe, 2), false, 'impact');
    expect(u.hp).toBe(hp - 30);
    // Rooted: an own body dropped on top of it is pushed away, not the other way round.
    const start = { x: u.x, y: u.y };
    const friend = put(g, team, 'trooper', 16.6, 24.5);
    steps(g, 20);
    expect({ x: u.x, y: u.y }).toEqual(start);
    expect(Math.hypot(friend.x - u.x, friend.y - u.y)).toBeGreaterThan(0.1);
    // A move packs first (digOutTime, still rooted), then walks.
    const [mx, my] = at(g, team, 24.5, 24.5);
    expect(act(g, team, 'surface', { kind: 'move', units: [id(g, team, u)], x: mx, y: my })).toEqual({ ok: true });
    g.step();
    expect(u.state).toBe('digging_out');
    steps(g, ECON.digOutTicks - 2);
    expect({ x: u.x, y: u.y }).toEqual(start);
    steps(g, ECON.digOutTicks + 20);
    expect(u.deploy).toBe(DEPLOY_NONE);
    expect(u.x === start.x && u.y === start.y).toBe(false);
    expect(s.armies[slotOfArmyId(team, 2)]!.stats.deploys).toBe(1);
  });

  it('sees dugInVision further, and the enemy sees the stance and its progress only while it sees the trooper', () => {
    const g = arena();
    const s = g.sim;
    const u = put(g, team, 'trooper', 16.5, 24.5);
    const [cx, cy] = at(g, team, 23.5, 24.5); // the cell 6.5–7.5 tiles along the row: beyond trooper vision 6, within 7
    const cell = Math.floor(cy) * s.size + Math.floor(cx);
    const bit = s.armies[slotOfArmyId(team, 2)]!.group.bit;
    steps(g, VISION_EVERY + 1);
    expect(s.vis[PLANE_INDEX.surface]![cell]! & bit).toBe(0);
    act(g, team, 'surface', { kind: 'deploy', units: [id(g, team, u)], on: true });
    // Never seen, so the enemy has no name for it at all (every entity in its observation is named).
    expect(s.aliasOf(slotOfArmyId(foe, 2), u.id)).toBe(0);
    put(g, foe, 'flak', 21.5, 24.5, team); // no ground weapon: it only watches
    steps(g, VISION_EVERY + 1);
    const seen = g.observe({ team: foe, role: 'surface' }, 0).entities.find((e) => e.id === id(g, foe, u));
    expect(seen?.state).toBe('digging_in');
    expect(seen?.progress).toBeGreaterThan(0);
    steps(g, ECON.digInTicks + VISION_EVERY);
    expect(s.vis[PLANE_INDEX.surface]![cell]! & bit).not.toBe(0);
    expect(g.observe({ team: foe, role: 'surface' }, 0).entities.find((e) => e.id === id(g, foe, u))?.state).toBe('dug_in');
  });
});

describe.each(TEAMS)('siege (%s)', (team) => {
  const foe = foeOf(team);

  it('reaches 9 vs structures, the beam\'s reach vs Spire segments and 7.5 vs units sieged; mobile keeps +2 vs turrets and none vs Spires', () => {
    const g = arena();
    const s = g.sim;
    const t = turret(g, foe, 30.5, 24.5, team);
    const tank = put(g, team, 'tank', 20.5, 24.5);
    const unit = put(g, foe, 'trooper', 26.5, 24.5, team);
    const spire = s.armies[slotOfArmyId(foe, 2)]!.spire.surface;
    expect(ownRange(g, tank, t)).toBeCloseTo(STATS.tank.range + ECON.siegeRange, 9);
    expect(ownRange(g, tank, spire)).toBeCloseTo(STATS.tank.range, 9);
    expect(ownRange(g, tank, unit)).toBeCloseTo(STATS.tank.range, 9);
    deployed(g, team, tank);
    expect(ownRange(g, tank, t)).toBeCloseTo(ECON.siegeRangeStructures, 9);
    // Measured like the beam: footprint edge to the tank's body edge.
    expect(ownRange(g, tank, spire)).toBeCloseTo(ECON.siegeSpireRange + STATS.tank.radius, 9);
    expect(ownRange(g, tank, unit)).toBeCloseTo(ECON.siegeRangeUnits, 9);
  });

  it('sets up for siegeDeployTime without firing, then shells a unit at 7 tiles but nothing inside 2', () => {
    const g = arena();
    const tank = put(g, team, 'tank', 16.5, 24.5);
    const far = put(g, foe, 'trooper', 16.5 + 7 + STATS.trooper.radius, 24.5, team);
    const near = put(g, foe, 'trooper', 16.5, 24.5 + 1.5 + STATS.trooper.radius, team);
    // Mobile: the near trooper is in range, the far one is not.
    expect(g.sim.inRange(tank, near)).toBe(true);
    expect(g.sim.inRange(tank, far)).toBe(false);
    far.hp = near.hp = 1e6;
    act(g, team, 'surface', { kind: 'deploy', units: [id(g, team, tank)], on: true });
    steps(g, ECON.siegeDeployTicks - 1);
    expect(tank.state).toBe('sieging');
    expect(far.hp + near.hp).toBe(2e6);
    steps(g, 2 + STATS.tank.cooldown * 3);
    expect(tank.state).toBe('sieged');
    expect(g.sim.inRange(tank, near)).toBe(false);
    expect(g.sim.inRange(tank, far)).toBe(true);
    expect(near.hp).toBe(1e6);
    expect(far.hp).toBeLessThan(1e6);
  });

  it('fires over a cliff only at targets its team sees; a move packs it first', () => {
    const g = arena();
    const s = g.sim;
    const t = turret(g, foe, 26.5, 24.5, team);
    // A cliff wall across the line of fire, x = 22, y 18..30 (army frame).
    const cliffs = new Uint8Array(s.n);
    for (let y = 18; y <= 30; y++) {
      const [wx, wy] = at(g, team, 22.5, y + 0.5);
      const c = Math.floor(wy) * s.size + Math.floor(wx);
      s.terrain[c] = SURFACE.cliff;
      s.block[c] = 1;
      cliffs[c] = 1;
    }
    // The sim builds its sight lines once from the map; this test raises a cliff afterwards (readonly is not runtime).
    const sight: { los: LineOfSight } = s;
    sight.los = new LineOfSight(cliffs, s.size);
    s.holesVersion++;
    const tank = put(g, team, 'tank', 18.5, 24.5);
    deployed(g, team, tank);
    steps(g, toTicks(4));
    expect(t.hp).toBe(t.maxHp);
    // A spotter beside the turret (flak: it cannot hurt the turret) lends the team its sight.
    put(g, team, 'flak', 27.5, 27.5);
    steps(g, toTicks(5));
    expect(t.hp).toBeLessThan(t.maxHp);
    const start = { x: tank.x, y: tank.y };
    const [mx, my] = at(g, team, 12.5, 24.5);
    act(g, team, 'surface', { kind: 'move', units: [id(g, team, tank)], x: mx, y: my });
    g.step();
    expect(tank.state).toBe('unsieging');
    steps(g, ECON.siegePackTicks - 2);
    expect({ x: tank.x, y: tank.y }).toEqual(start);
  });
});

describe.each(TEAMS)('emplaced flak and flak vs falling payloads (%s)', (team) => {
  const foe = foeOf(team);

  it('emplaces for emplaceTime: range 9 vs the Sky, cooldown ×0.75; payloads take ×2 from +2 range on top', () => {
    const g = arena();
    const s = g.sim;
    const flak = put(g, team, 'flak', 16.5, 24.5);
    const plane = put(g, foe, 'interceptor', 22.5, 24.5, team);
    const [rx, ry] = at(g, team, 18.5, 24.5);
    const rock = s.add('asteroid', slotOfArmyId(foe, 2), 'sky', rx, ry);
    rock.state = 'falling';
    expect(ownRange(g, flak, plane)).toBeCloseTo(STATS.flak.range, 9);
    expect(ownRange(g, flak, rock)).toBeCloseTo(STATS.flak.range + ECON.flakPayloadRange, 9);
    expect(s.cooldownOf(flak)).toBe(STATS.flak.cooldown);
    expect(s.weaponVs('flak', rock)).toBe(DAMAGE_VS.flak.air * ECON.flakPayloadMultiplier);
    expect(s.weaponVs('flak', plane)).toBe(DAMAGE_VS.flak.air);
    act(g, team, 'surface', { kind: 'deploy', units: [id(g, team, flak)], on: true });
    steps(g, ECON.emplaceTicks - 1);
    expect(flak.state).toBe('emplacing');
    steps(g, 2);
    expect(flak.state).toBe('emplaced');
    expect(ownRange(g, flak, plane)).toBeCloseTo(ECON.emplacedFlakRange, 9);
    expect(ownRange(g, flak, rock)).toBeCloseTo(ECON.emplacedFlakRange + ECON.flakPayloadRange, 9);
    expect(s.cooldownOf(flak)).toBe(Math.round(STATS.flak.cooldown * ECON.emplacedFlakCooldown));
    act(g, team, 'surface', { kind: 'deploy', units: [id(g, team, flak)], on: false });
    expect(flak.state).toBe('unemplacing');
    steps(g, ECON.unemplaceTicks + 1);
    expect(flak.deploy).toBe(DEPLOY_NONE);
  });
});

describe('deploy state is simulation state', () => {
  it('is hashed and cloned', () => {
    const g = arena();
    const u = put(g, 'nw', 'trooper', 16.5, 24.5);
    act(g, 'nw', 'surface', { kind: 'deploy', units: [id(g, 'nw', u)], on: true });
    const copy = g.sim.clone();
    expect(copy.hash()).toBe(g.sim.hash());
    expect(copy.byId.get(u.id)!.deploy).toBe(u.deploy);
    const before = g.sim.hash();
    u.deployAt++;
    expect(g.sim.hash()).not.toBe(before);
  });
});
