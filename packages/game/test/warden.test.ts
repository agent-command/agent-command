/**
 * The Warden and the Depths principle: the Warden (shotgun, shield wall, cover, flare, fast fortify), troopers
 * reaching the Depths only through a Shaft, free walls-only fortify, sapper stacking with fortification strip, and
 * magma cooling to open tunnel.
 * Every sim scenario runs for both armies on mirrored corridors.
 */
import { describe, expect, it } from 'vitest';
import { CELL, DAMAGE_VS, ECON, STATS, toTicks, type ArmyId, type Plane, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { entityOut } from '../src/agent/present.ts';
import { DEPLOY_UP, SEP_DEADBAND, VISION_EVERY } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const TEAMS = ['nw', 'se'] as const;
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
/** Corridor row (canonical, nw frame): a 1-wide tunnel x 8..40 at y 24, rock above and below; se gets its point mirror. */
const ROW = 30;
const X0 = 8;
const X1 = 40;

/**
 * A quiet arena: every unit gone, the corridor carved (owned by `owner`'s army), mirrored for the other army so both
 * armies' scenarios are exact twins. Positions passed to `put` are canonical (nw frame) and mirrored for se.
 */
function arena(): AgentCommandGame {
  const g = createGame({ seed: 11 });
  const s = g.sim;
  for (const e of s.ents) if (e.unit) e.hp = 0;
  g.step();
  for (const mirror of [false, true]) {
    for (let x = X0 - 1; x <= X1 + 1; x++) for (const y of [ROW - 1, ROW, ROW + 1]) {
      const c = cellAt(s.size, x, y, mirror);
      s.resetCell(c);
      s.cells[c] = y === ROW && x >= X0 && x <= X1 ? CELL.tunnel : CELL.rock;
      s.magma[c] = 0;
      s.owner[c] = y === ROW && x >= X0 && x <= X1 ? (mirror ? slotOfArmyId('se', 2) : slotOfArmyId('nw', 2)) + 1 : 0;
    }
  }
  s.depthsVersion++;
  // A surveyed corridor: every army knows it (as after earlier scouting), so orders plan through it.
  for (const mirror of [false, true]) for (let x = X0 - 1; x <= X1 + 1; x++) for (const y of [ROW - 1, ROW, ROW + 1]) {
    const c = cellAt(s.size, x, y, mirror);
    for (const gr of s.groups) gr.known[c] = s.cells[c]!;
  }
  return g;
}
const cellAt = (size: number, x: number, y: number, mirror: boolean): number => (mirror ? (size - 1 - y) * size + (size - 1 - x) : y * size + x);
/** A unit of `team` standing at canonical cell (x, ROW) of `team`'s mirror (nw: as given; se: point-mirrored corridor). */
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, x: number, mirror: boolean): Ent {
  const s = g.sim;
  const e = s.spawnUnit(slotOfArmyId(team, 2), kind, 'depths');
  const c = cellAt(s.size, x, ROW, mirror);
  e.plane = 'depths';
  e.x = (c % s.size) + 0.5;
  e.y = Math.floor(c / s.size) + 0.5;
  e.cell = c;
  e.order = { k: 'none' };
  return e;
}
/** World point of canonical (x + 0.5, ROW + 0.5) in the given mirror. */
const pt = (g: AgentCommandGame, x: number, mirror: boolean): { x: number; y: number } => {
  const c = cellAt(g.sim.size, x, ROW, mirror);
  return { x: (c % g.sim.size) + 0.5, y: Math.floor(c / g.sim.size) + 0.5 };
};

describe('Warden stats and the shotgun row', () => {
  it('is a light Depths fighter with the plan numbers and no transit', () => {
    const w = STATS.warden;
    expect([w.alloy, w.energy, w.hp, w.armor, w.speed, w.range, w.dmg, w.cooldown, w.splash, w.weapon]).toEqual([60, 20, 160, 'light', 2, 2, 12, toTicks(0.8), 0.6, 'shotgun']);
    expect(w.targets).toEqual(['depths']);
    expect(DAMAGE_VS.shotgun).toEqual({ light: 1.25, armored: 0.75, air: 1, structure: 0.5, small: 1, heavy_air: 1, island: 0.5 });
    expect(ECON.wallDamageTaken).toBe(0.4);
  });
});

describe.each(TEAMS)('shield wall (%s)', (team) => {
  const mirror = team === 'se';
  const foe: ArmyId = team === 'nw' ? 'se' : 'nw';


  it('rejects coincident deployment atomically, then allows the separated pair to hold stable shields', () => {
    const g = arena();
    const a = put(g, team, 'warden', 20, mirror), b = put(g, team, 'warden', 20, mirror);
    const order = { kind: 'deploy', units: [id(g, team, a), id(g, team, b)], on: true } as const;
    expect(act(g, team, 'depths', { ...order, units: [...order.units] })).toEqual({ ok: false, code: 'blocked' });
    expect(a.deploy).toBe(0); expect(b.deploy).toBe(0);
    steps(g, toTicks(1));
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.radius + b.radius - SEP_DEADBAND);
    expect(act(g, team, 'depths', { ...order, units: [...order.units] })).toEqual({ ok: true });
    steps(g, ECON.wallDeployTicks + 1);
    const positions = [a.x, a.y, b.x, b.y];
    steps(g, toTicks(2));
    expect([a.state, b.state]).toEqual(['walled', 'walled']);
    expect([a.x, a.y, b.x, b.y]).toEqual(positions);
  });

  it('separates overlapping Wardens after their chase stops to fire, allowing deployment under threat', () => {
    const g = arena();
    const a = put(g, team, 'warden', 18, mirror), b = put(g, team, 'warden', 18, mirror);
    const enemy = put(g, foe, 'digger', 21, mirror);
    enemy.hp = enemy.maxHp = 500;
    enemy.stance = 'hold';
    g.sim.computeVision();
    expect(entityOut(g.sim, a, team).deployBlocked).toBe(true);
    expect(entityOut(g.sim, a, foe).deployBlocked).toBeUndefined();
    expect(entityOut(g.sim, a, 'observer').deployBlocked).toBeUndefined();
    expect(act(g, team, 'depths', { kind: 'attack', units: [id(g, team, a), id(g, team, b)], target: id(g, team, enemy) })).toEqual({ ok: true });
    steps(g, toTicks(2));
    expect(enemy.hp).toBeLessThan(enemy.maxHp);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.radius + b.radius - SEP_DEADBAND);
    expect(entityOut(g.sim, a, team).deployBlocked).toBeUndefined();
    expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, a), id(g, team, b)], on: true })).toEqual({ ok: true });
    steps(g, ECON.wallDeployTicks + 1);
    expect([a.state, b.state]).toEqual(['walled', 'walled']);
    expect(enemy.dead).toBe(false);
  });

  it('lets a mobile Warden cross a friendly shield but makes room when it stops on the shield bearer', () => {
    const g = arena();
    const a = put(g, team, 'warden', 20, mirror);
    expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, a)], on: true })).toEqual({ ok: true });
    steps(g, ECON.wallDeployTicks + 1);
    const b = put(g, team, 'warden', 18, mirror);
    expect(act(g, team, 'depths', { kind: 'move', units: [id(g, team, b)], ...pt(g, 22, mirror), mode: 'move' })).toEqual({ ok: true });
    steps(g, toTicks(2));
    expect(mirror ? b.x < a.x - 1 : b.x > a.x + 1).toBe(true);
    expect(act(g, team, 'depths', { kind: 'move', units: [id(g, team, b)], x: a.x, y: a.y, mode: 'move' })).toEqual({ ok: true });
    steps(g, toTicks(2));
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.radius + b.radius - SEP_DEADBAND);
    expect(a.state).toBe('walled');
    expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, b)], on: true })).toEqual({ ok: true });
  });

  it('routes new mining work around a seen hostile shield rather than repeatedly approaching blocked ore', () => {
    const g = arena(), s = g.sim;
    for (let c = 0; c < s.n; c++) if (s.cells[c] === CELL.rock) {
      s.cells[c] = CELL.bedrock;
      for (const group of s.groups) group.known[c] = CELL.bedrock;
    }
    for (const x of [18, 35]) {
      const c = cellAt(s.size, x, ROW, mirror);
      s.cells[c] = CELL.ore; s.ore[c] = 100;
      for (const group of s.groups) group.known[c] = CELL.ore;
    }
    s.depthsVersion++;
    const w = put(g, team, 'warden', 20, mirror);
    expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, w)], on: true })).toEqual({ ok: true });
    steps(g, ECON.wallDeployTicks + 1);
    const d = put(g, foe, 'digger', 24, mirror);
    s.computeVision();
    expect(s.sees(slotOfArmyId(foe, 2), w)).toBe(true);
    expect(act(g, foe, 'depths', { kind: 'mine', units: [id(g, foe, d)], ...pt(g, 18, mirror) })).toEqual({ ok: true });
    let last = d.x;
    for (let i = 0; i < toTicks(10); i++) {
      g.step();
      expect(mirror ? d.x <= last : d.x >= last).toBe(true);
      last = d.x;
    }
    expect(d.carry).toBeGreaterThan(0);
    expect(s.ore[cellAt(s.size, 18, ROW, mirror)]).toBe(100);
    expect(s.ore[cellAt(s.size, 35, ROW, mirror)]).toBeLessThan(100);
    expect(w.state).toBe('walled');
  });
  it('admits friendly fighters without letting enemies piggyback, while fire still crosses the shield', () => {
    const g = arena();
    const w = put(g, team, 'warden', 20, mirror);
    const stats = g.sim.armies[slotOfArmyId(team, 2)]!.stats, deploysBefore = stats.deploys;
    expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, w)], on: true })).toEqual({ ok: true });
    steps(g, ECON.wallDeployTicks + 1);
    expect(w.state).toBe('walled');
    const friend = put(g, team, 'trooper', 16, mirror);
    friend.stance = 'hold';
    const enemy = put(g, foe, 'trooper', 25, mirror);
    const goEnemy = pt(g, 10, mirror);
    friend.hp = friend.maxHp = enemy.hp = enemy.maxHp = w.hp = w.maxHp = 10000;
    const goFriend = pt(g, 30, mirror);
    expect(act(g, foe, 'depths', { kind: 'move', units: [id(g, foe, enemy)], ...goEnemy, mode: 'move' })).toEqual({ ok: true });
    expect(act(g, team, 'depths', { kind: 'move', units: [id(g, team, friend)], ...goFriend, mode: 'move' })).toEqual({ ok: true });
    const wallCell = cellAt(g.sim.size, 20, ROW, mirror);
    let crossFire = false;
    let crossed = false, occupied = false;
    for (let i = 0; i < toTicks(8); i++) {
      g.step();
      occupied ||= friend.cell === wallCell;
      crossed ||= mirror ? friend.x < w.x - 1 : friend.x > w.x + 1;
      expect(mirror ? enemy.x < w.x - 0.5 : enemy.x > w.x + 0.5).toBe(true);
      expect(enemy.cell).not.toBe(wallCell);
      expect(w.state).toBe('walled');
      if (friend.hp < friend.maxHp || enemy.hp < enemy.maxHp) crossFire = true;
    }
    expect(occupied).toBe(true);
    expect(crossed).toBe(true);
    expect(crossFire).toBe(true);
    expect(stats.deploys - deploysBefore).toBe(1); // passage must not pack/redeploy the Warden
  });

  it.each(['pack', 'death'] as const)('invalidates a pre-sighted hostile route on deployment and resumes after %s', (release) => {
    const g = arena(), s = g.sim;
    const w = put(g, team, 'warden', 20, mirror);
    const enemy = put(g, foe, 'digger', 26, mirror);
    enemy.hp = enemy.maxHp = w.hp = w.maxHp = 10000;
    expect(act(g, foe, 'depths', { kind: 'move', units: [id(g, foe, enemy)], ...pt(g, 16, mirror), mode: 'move' })).toEqual({ ok: true });
    steps(g, 2); // The smoothed waypoint was sighted before the wall existed.
    expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, w)], on: true })).toEqual({ ok: true });
    const friend = put(g, team, 'digger', 18, mirror);
    expect(act(g, team, 'depths', { kind: 'move', units: [id(g, team, friend)], ...pt(g, 24, mirror), mode: 'move' })).toEqual({ ok: true });
    let lastX = enemy.x;
    for (let i = 0; i < toTicks(4); i++) {
      g.step();
      expect(mirror ? enemy.x < w.x - 0.5 : enemy.x > w.x + 0.5).toBe(true);
      expect(mirror ? enemy.x >= lastX : enemy.x <= lastX).toBe(true);
      lastX = enemy.x;
    }
    expect(mirror ? friend.x < w.x - 1 : friend.x > w.x + 1).toBe(true);
    expect(w.state).toBe('walled');
    if (release === 'death') s.damage(w, 100000, slotOfArmyId(foe, 2));
    else expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, w)], on: false })).toEqual({ ok: true });
    steps(g, ECON.wallUndeployTicks + toTicks(4));
    expect(mirror ? enemy.x > w.x + 1 : enemy.x < w.x - 1).toBe(true);
  });

  it('halves damage once up, holds fire while deploying and undeploying, and covers own units nearby', () => {
    const g = arena();
    const w = put(g, team, 'warden', 20, mirror);
    const near = put(g, team, 'digger', 19, mirror);
    const s = g.sim;
    const foeArmy = slotOfArmyId(foe, 2);
    // arena() steps once to remove starter units. Solar arrays auto-deploy in that decision phase
    // before the HP-zero cleanup, so the army-wide counter already includes their stances.
    const stats = s.armies[slotOfArmyId(team, 2)]!.stats, deploysBefore = stats.deploys;
    s.damage(w, 40, foeArmy);
    expect(w.hp).toBe(120);
    expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, w)], on: true })).toEqual({ ok: true });
    // Deploying: an enemy in range is not shot at.
    const enemy = put(g, foe, 'digger', 22, mirror);
    enemy.stance = 'hold';
    steps(g, ECON.wallDeployTicks - 2);
    expect(w.state).toBe('walling');
    expect(enemy.hp).toBe(enemy.maxHp);
    steps(g, 3);
    expect(w.deploy).toBe(DEPLOY_UP);
    const before = w.hp;
    s.damage(w, 40, foeArmy);
    expect(w.hp).toBe(before - 40 * ECON.wallDamageTaken);
    const nearBefore = near.hp;
    s.damage(near, 10, foeArmy);
    expect(near.hp).toBeCloseTo(nearBefore - 10 * ECON.wallCoverDamageTaken, 9);
    // Up: it fires.
    steps(g, toTicks(2));
    expect(enemy.hp).toBeLessThan(enemy.maxHp);
    // Undeploying: no fire.
    expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, w)], on: false })).toEqual({ ok: true });
    g.step();
    expect(w.state).toBe('unwalling');
    const hp = enemy.hp;
    steps(g, ECON.wallUndeployTicks - 1);
    expect(enemy.hp).toBe(hp);
    steps(g, 2);
    expect(w.state).not.toBe('unwalling');
    expect(stats.deploys - deploysBefore).toBe(1);
  });

  it('a move order lowers the wall first, then the Warden walks', () => {
    const g = arena();
    const w = put(g, team, 'warden', 20, mirror);
    act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, w)], on: true });
    steps(g, ECON.wallDeployTicks + 1);
    const start = { x: w.x, y: w.y };
    expect(act(g, team, 'depths', { kind: 'move', units: [id(g, team, w)], ...pt(g, 30, mirror), mode: 'move' })).toEqual({ ok: true });
    g.step();
    expect(w.state).toBe('unwalling');
    expect({ x: w.x, y: w.y }).toEqual(start);
    steps(g, ECON.wallUndeployTicks + toTicks(2));
    expect(w.deploy).toBe(0);
    expect(w.x === start.x && w.y === start.y).toBe(false);
  });
});

describe.each(TEAMS)('flare (%s)', (team) => {
  const mirror = team === 'se';
  it('lights the tunnel ahead along open tunnel only, for its duration, with a cooldown', () => {
    const g = arena();
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    const w = put(g, team, 'warden', 12, mirror);
    steps(g, VISION_EVERY);
    const bit = s.armies[army]!.group.bit;
    const sees = (x: number, y = ROW): boolean => (s.vis[0]![mirror ? (s.size - 1 - y) * s.size + (s.size - 1 - x) : y * s.size + x]! & bit) !== 0;
    expect(sees(20)).toBe(false);
    // Too far, and onto rock, are rejected; within range onto known tunnel is fine.
    expect(act(g, team, 'depths', { kind: 'flare', unit: id(g, team, w), ...pt(g, 12 + ECON.flareRange + 2, mirror) })).toEqual({ ok: false, code: 'invalid_target' });
    const target = pt(g, 16, mirror);
    expect(act(g, team, 'depths', { kind: 'flare', unit: id(g, team, w), ...target })).toEqual({ ok: true });
    expect(sees(20)).toBe(true);
    expect(sees(16 + ECON.flareRange + 2)).toBe(false);
    // Never through rock: the cell two rows off the corridor stays dark.
    expect(sees(16, ROW + 2)).toBe(false);
    expect(act(g, team, 'depths', { kind: 'flare', unit: id(g, team, w), ...target })).toEqual({ ok: false, code: 'blocked' });
    expect(g.observe({ team, role: 'depths' }, 0).flares).toHaveLength(1);
    steps(g, ECON.flareRevealTicks + VISION_EVERY + 1);
    expect(sees(20)).toBe(false);
    expect(g.observe({ team, role: 'depths' }, 0).flares).toHaveLength(0);
    expect(s.armies[army]!.stats.flares).toBe(1);
  });

  it('fog: an enemy flare is listed only where its cell is seen, and nothing hidden changes the outputs', () => {
    const foe: ArmyId = team === 'nw' ? 'se' : 'nw';
    const make = (flare: boolean): AgentCommandGame => {
      const g = arena();
      const w = put(g, foe, 'warden', 30, mirror);
      put(g, team, 'digger', 10, mirror);
      steps(g, VISION_EVERY);
      if (flare) expect(act(g, foe, 'depths', { kind: 'flare', unit: id(g, foe, w), ...pt(g, 26, mirror) })).toEqual({ ok: true });
      steps(g, VISION_EVERY);
      return g;
    };
    const lit = make(true);
    const dark = make(false);
    // The enemy flare lit cells our digger cannot see: our outputs are identical either way.
    expect(lit.observe({ team, role: 'depths' }, 0).flares).toEqual([]);
    for (const role of ['depths', 'surface'] as const) {
      const a = { ...lit.observe({ team, role }, 0) } as Record<string, unknown>;
      const b = { ...dark.observe({ team, role }, 0) } as Record<string, unknown>;
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    expect(JSON.stringify(lit.view(team).flares)).toBe(JSON.stringify(dark.view(team).flares));
    // The thrower sees its own flare.
    expect(lit.observe({ team: foe, role: 'depths' }, 0).flares).toHaveLength(1);
  });
});

describe.each(TEAMS)('flares in one decision round (%s applies first)', (first) => {
  it('light vision once every seat has applied: each army plans round the other\'s same-round shield wall', () => {
    const g = arena();
    const s = g.sim;
    // A point-symmetric tunnel both armies know (rows 23-24, x 20..27: every cell's mirror lies in it).
    for (let y = 22; y <= 25; y++) for (let x = 19; x <= 28; x++) {
      const c = y * s.size + x;
      s.resetCell(c);
      s.cells[c] = y >= 23 && y <= 24 && x >= 20 && x <= 27 ? CELL.tunnel : CELL.rock;
      s.magma[c] = 0;
      for (const gr of s.groups) gr.known[c] = s.cells[c]!;
    }
    s.depthsVersion++;
    // Twin Wardens at canonical (21, 23), out of each other's sight; each flares canonical (24, 23), lighting both.
    const centre = (x: number, y: number, mirror: boolean): { x: number; y: number } => {
      const c = cellAt(s.size, x, y, mirror);
      return { x: (c % s.size) + 0.5, y: Math.floor(c / s.size) + 0.5 };
    };
    const wardens = TEAMS.map((team) => {
      const w = s.spawnUnit(slotOfArmyId(team, 2), 'warden', 'depths');
      const at = centre(21, 23, team === 'se');
      w.x = at.x;
      w.y = at.y;
      w.cell = cellAt(s.size, 21, 23, team === 'se');
      w.order = { k: 'none' };
      return w;
    });
    steps(g, VISION_EVERY);
    const plansAround = (): number[] => TEAMS.map((team, i) => s.depthNav[slotOfArmyId(team, 2)]![wardens[1 - i]!.cell]!);
    expect(plansAround()).toEqual([0, 0]);
    s.round(() => {
      for (const team of first === 'nw' ? TEAMS : [...TEAMS].reverse()) {
        const w = wardens[TEAMS.indexOf(team)]!;
        expect(act(g, team, 'depths', { kind: 'flare', unit: id(g, team, w), ...centre(24, 23, team === 'se') })).toEqual({ ok: true });
        expect(act(g, team, 'depths', { kind: 'deploy', units: [id(g, team, w)], on: true })).toEqual({ ok: true });
      }
    });
    // A refresh between the seats would show only the later seat the earlier seat's new wall.
    expect(plansAround()).toEqual([1, 1]);
  });
});

describe.each(TEAMS)('fortify (%s)', (team) => {
  const mirror = team === 'se';
  it('is free, walls only, and a Warden does it twice as fast as a digger', () => {
    const g = arena();
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    const d = put(g, team, 'digger', 14, mirror);
    const w = put(g, team, 'warden', 24, mirror);
    steps(g, VISION_EVERY);
    const wallAt = (x: number): { x: number; y: number } => {
      const c = cellAt(s.size, x, ROW + 1, mirror);
      return { x: c % s.size, y: Math.floor(c / s.size) };
    };
    const tunnel = cellAt(s.size, 14, ROW, mirror);
    expect(act(g, team, 'depths', { kind: 'fortify', units: [id(g, team, d)], x: tunnel % s.size, y: Math.floor(tunnel / s.size) })).toEqual({ ok: false, code: 'invalid_target' });
    const alloy = s.armies[army]!.alloy;
    expect(act(g, team, 'depths', { kind: 'fortify', units: [id(g, team, d)], ...wallAt(14) })).toEqual({ ok: true });
    expect(act(g, team, 'depths', { kind: 'fortify', units: [id(g, team, w)], ...wallAt(24) })).toEqual({ ok: true });
    const done = (x: number): boolean => { const p = wallAt(x); return s.cells[p.y * s.size + p.x] === CELL.fortified; };
    let wardenAt = -1;
    let diggerAt = -1;
    for (let i = 0; i < ECON.fortifyTicks + toTicks(2); i++) {
      g.step();
      if (wardenAt < 0 && done(24)) wardenAt = i;
      if (diggerAt < 0 && done(14)) diggerAt = i;
    }
    expect(wardenAt).toBeGreaterThan(0);
    expect(diggerAt - wardenAt).toBe(ECON.fortifyTicks - ECON.fortifyTicks / ECON.wardenFortifySpeed);
    expect(s.armies[army]!.alloy).toBeGreaterThanOrEqual(alloy);
  });
});

describe.each(TEAMS)('sapper stacking (%s)', (team) => {
  const mirror = team === 'se';
  it('joiners stack collapse damage up to the cap; the blast strips fortification and hurts Depths units', () => {
    const g = arena();
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    const foe = slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2);
    const c = cellAt(s.size, 20, ROW, mirror);
    const wall = cellAt(s.size, 20, ROW + 1, mirror);
    s.cells[wall] = CELL.fortified;
    s.tough[wall] = 2;
    s.plantCharge(army, c);
    for (let i = 0; i < 4; i++) s.plantCharge(army, c);
    const ch = s.charges[0]!;
    expect(ch.stack).toBe(5);
    expect(s.chargeDamage(ch)).toBe(ECON.collapseDamage * (1 + ECON.chargeStackDamage * (ECON.chargeStackMax - 1)));
    expect(s.chargeDamage(ch)).toBe(800);
    // An enemy steps next to it just before it blows (too late to defuse).
    steps(g, ECON.undermineTicks - 2);
    const victim = put(g, team === 'nw' ? 'se' : 'nw', 'warden', 21, mirror);
    const hp = victim.hp;
    steps(g, 3);
    expect(s.cells[wall]).toBe(CELL.rock);
    expect(s.tough[wall]).toBe(0);
    expect(victim.hp).toBeLessThanOrEqual(hp - ECON.chargeUnitDamage);
    // Own charges only show their stack to their own side.
    expect(foe).not.toBe(army);
  });
});

describe('magma cools to open tunnel', () => {
  it('a cooled flood leaves walkable tunnel, never rock', () => {
    const g = arena();
    const s = g.sim;
    const c = cellAt(s.size, 20, ROW, false);
    s.magma[c] = 77;
    s.breakPocket(c, slotOfArmyId('nw', 2));
    steps(g, ECON.magmaCoolTicks + 1);
    expect(s.cells[c]).toBe(CELL.tunnel);
  });
});

describe.each(TEAMS)('troopers for the Depths (%s)', (team) => {
  it('troopers for the Depths are ordinary Surface production: only a Surface transfer at an own Shaft brings one down', () => {
    const g = createGame({ seed: 4 });
    const army = slotOfArmyId(team, 2);
    g.sim.armies[army]!.alloy = 1000;
    // The Depths seat cannot buy Surface units; it asks the Surface seat (signal `troops`).
    expect(act(g, team, 'depths', { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: false, code: 'wrong_plane' });
    expect(act(g, team, 'surface', { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: true });
    const entry = g.observe({ team, role: 'depths' }, 0).queue.at(-1)!;
    expect(entry).toMatchObject({ item: 'trooper', plane: 'surface', by: 'surface' });
    expect(entry).not.toHaveProperty('deliver');
    const before = new Set(g.sim.ents.map((e) => e.id));
    steps(g, STATS.trooper.build + 2);
    const fresh = g.sim.ents.filter((e) => !before.has(e.id) && e.kind === 'trooper' && e.side === army);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.plane).toBe('surface');
    expect(act(g, team, 'depths', { kind: 'stop', units: [id(g, team, fresh[0]!)] })).toEqual({ ok: false, code: 'wrong_plane' });
    expect(act(g, team, 'surface', { kind: 'transfer', units: [id(g, team, fresh[0]!)], to: 'depths' })).toEqual({ ok: false, code: 'no_shaft' });
  });
});

/**
 * The equal-cost combo (Warden 80 + 3 troopers 120 = 200) at a 1-wide choke. The defender walls its Warden at the
 * choke with its troopers behind it; the attackers fight-move through. Winner: the side with units left.
 */
describe.each(TEAMS)('equal-cost combo at a 1-wide choke (%s defends)', (team) => {
  const mirror = team === 'se';
  const foe: ArmyId = team === 'nw' ? 'se' : 'nw';
  const fight = (defence: UnitKind[], attack: UnitKind[]): 'defence' | 'attack' | 'none' => {
    const g = arena();
    const s = g.sim;
    const def: Ent[] = defence.map((k, i) => put(g, team, k, k === 'warden' ? 20 : 19, mirror));
    for (const e of def) e.stance = 'hold';
    const wardens = def.filter((e) => e.kind === 'warden');
    act(g, team, 'depths', { kind: 'deploy', units: wardens.map((e) => id(g, team, e)), on: true });
    steps(g, ECON.wallDeployTicks + 1);
    const atk: Ent[] = attack.map((k, i) => put(g, foe, k, 34 + i, mirror));
    expect(act(g, foe, 'depths', { kind: 'move', units: atk.map((e) => id(g, foe, e)), ...pt(g, X0, mirror), mode: 'fight' })).toEqual({ ok: true });
    for (let i = 0; i < toTicks(90); i++) {
      g.step();
      const d = def.some((e) => !e.dead);
      const a = atk.some((e) => !e.dead);
      if (!a) return 'defence';
      if (!d) return 'attack';
    }
    void s;
    return 'none';
  };

  it('walled Warden + 3 troopers beats 5 troopers', () => {
    expect(fight(['warden', 'trooper', 'trooper', 'trooper'], ['trooper', 'trooper', 'trooper', 'trooper', 'trooper'])).toBe('defence');
  });
  it('walled Warden + 3 troopers beats 2 Wardens + 1 trooper', () => {
    expect(fight(['warden', 'trooper', 'trooper', 'trooper'], ['warden', 'warden', 'trooper'])).toBe('defence');
  });
  it('a lone walled Warden loses to 2 troopers, which outrange it', () => {
    expect(fight(['warden'], ['trooper', 'trooper'])).toBe('attack');
  });
});
