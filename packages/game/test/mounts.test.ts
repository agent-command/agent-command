import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { STATS, SURFACE, toTicks, type ArmyId, type UnitKind } from '../src/rules/contract.ts';
import { entityOut } from '../src/agent/present.ts';
import type { Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const point = (g: AgentCommandGame, team: ArmyId, x: number, y: number): [number, number] => team === 'nw' ? [x, y] : [g.sim.size - x, g.sim.size - y];
const enemy = (team: ArmyId): ArmyId => team === 'nw' ? 'se' : 'nw';
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
function arena(): AgentCommandGame {
  // Open space: the derelict ruin at the centre walls fire and movement off (fleet.test.ts measures the same way).
  const g = createGame({ seed: 5, options: { terrain: 'open', orbit: { derelictEnabled: false } } });
  g.sim.terrain.fill(SURFACE.ground);
  g.sim.surfaceCost.fill(1);
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.step();
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, x: number, y: number): Ent {
  const e = g.sim.add(kind, slotOfArmyId(team, 2), STATS[kind].plane, x, y);
  e.hp = e.maxHp = 100000;
  e.stance = 'hold';
  return e;
}
function move(g: AgentCommandGame, e: Ent, team: ArmyId, x: number, y: number, mode?: 'move' | 'fight'): void {
  expect(g.apply({ team, role: e.plane }, { kind: 'move', units: [id(g, team, e)], x, y, ...(mode ? { mode } : {}) })).toEqual({ ok: true });
}
/** Sets (or clears) `team`'s vision bit on every cell of every plane, naming what it now sees. */
function vision(g: AgentCommandGame, team: ArmyId, on: boolean): void {
  const bit = g.sim.armies[slotOfArmyId(team, 2)]!.group.bit;
  for (const plane of g.sim.vis) for (let c = 0; c < plane.length; c++) plane[c] = on ? plane[c]! | bit : plane[c]! & ~bit;
  g.sim.noteSightings();
}
const shots = (g: AgentCommandGame, e: Ent): number => g.sim.fx.filter(({ fx }) => fx.tick === g.tick && fx.kind === 'shot' && fx.src === e.id).length;

describe('weapon mounts', () => {
  it('every armed registry kind declares a mount', () => {
    for (const stats of Object.values(STATS)) if (stats.dmg > 0) expect(stats.mount).toBeDefined();
  });
  it('mirrors hull bearings, turret traversal and shot ticks exactly across a half-turn', () => {
    const g = arena();
    const tanks = (['nw', 'se'] as const).map(team => {
      const tank = put(g, team, 'tank', ...point(g, team, 21, 14));
      tank.aim = 0;
      put(g, enemy(team), 'trooper', ...point(g, team, 16, 14));
      move(g, tank, team, ...point(g, team, 34, 14));
      vision(g, team, true);
      return tank;
    });
    let fired = 0;
    for (let tick = 0; tick < toTicks(1.2); tick++) {
      const previous = tanks[0]!.aim;
      g.step();
      expect(tanks[0]!.heading).toBe(tanks[1]!.heading);
      expect(tanks[0]!.aim).toBe(tanks[1]!.aim);
      expect(Math.abs(tanks[0]!.aim - previous)).toBeLessThanOrEqual(Math.PI / 20 + 1e-12);
      expect(shots(g, tanks[0]!)).toBe(shots(g, tanks[1]!));
      if (tick < 19) expect(shots(g, tanks[0]!)).toBe(0);
      fired += shots(g, tanks[0]!);
    }
    expect(fired).toBe(1);
  });
  for (const team of ['nw', 'se'] as const) {
    it(`explicit tank attacks retain their first-shot timing (${team})`, () => {
      const g = arena();
      const tank = put(g, team, 'tank', ...point(g, team, 21, 14));
      tank.aim = 0;
      const target = put(g, enemy(team), 'trooper', ...point(g, team, 16, 14));
      vision(g, team, true);
      expect(g.apply({ team, role: 'surface' }, { kind: 'attack', units: [id(g, team, tank)], target: id(g, team, target) })).toEqual({ ok: true });
      g.step();
      expect(shots(g, tank)).toBe(1);
    });
    it(`moving turrets do not turn toward or shoot an unseen target (${team})`, () => {
      const g = arena();
      const tank = put(g, team, 'tank', ...point(g, team, 21, 14));
      put(g, enemy(team), 'trooper', ...point(g, team, 16, 14));
      move(g, tank, team, ...point(g, team, 34, 14));
      vision(g, team, false);
      const aim = tank.aim;
      g.step();
      expect(shots(g, tank)).toBe(0);
      expect(tank.aim).toBe(aim);
    });
    it(`default move is plain and a retreating tank fires backwards without slowing (${team})`, () => {
      const g = arena();
      const control = arena();
      const tank = put(g, team, 'tank', ...point(g, team, 21, 14));
      const ghost = put(control, team, 'tank', ...point(g, team, 21, 14));
      const pursuer = put(g, enemy(team), 'trooper', ...point(g, team, 16, 14));
      const follower = put(control, enemy(team), 'trooper', ...point(g, team, 16, 14));
      const goal = point(g, team, 34, 14);
      move(g, tank, team, ...goal);
      move(control, ghost, team, ...goal);
      move(g, pursuer, enemy(team), ...goal);
      move(control, follower, enemy(team), ...goal);
      // A disabled gun is the movement-only baseline; matching bodies preserve local avoidance.
      ghost.cd = 10000;
      expect(tank.order).toMatchObject({ k: 'move', fight: false });
      let fired = 0;
      for (let tick = 0; tick < toTicks(3); tick++) {
        g.step(); control.step();
        fired += shots(g, tank);
        expect([tank.x, tank.y, tank.vx, tank.vy]).toEqual([ghost.x, ghost.y, ghost.vx, ghost.vy]);
        expect(tank.order).toMatchObject({ k: 'move', fight: false });
        expect(tank.firing).toBe(false);
        expect(tank.engage).toBe(0);
      }
      expect(fired).toBeGreaterThan(0);
      const view = entityOut(g.sim, tank, team);
      expect(Math.cos(view.aim! - view.heading!)).toBeLessThan(-0.9);
    });

    it(`fixed troopers never fire on a plain move (${team})`, () => {
      const g = arena();
      const unit = put(g, team, 'trooper', ...point(g, team, 20, 14));
      put(g, enemy(team), 'trooper', ...point(g, team, 20, 17));
      move(g, unit, team, ...point(g, team, 34, 14));
      for (let tick = 0; tick < toTicks(3); tick++) { g.step(); expect(shots(g, unit)).toBe(0); }
    });

    for (const bearing of [0, 25, 40, 180]) it(`interceptor arc excludes bearing ${bearing} degrees when appropriate (${team})`, () => {
      const g = arena();
      const unit = put(g, team, 'interceptor', ...point(g, team, 20, 14));
      const a = bearing * Math.PI / 180;
      put(g, enemy(team), 'interceptor', ...point(g, team, 20 + 4 * Math.cos(a), 14 + 4 * Math.sin(a)));
      move(g, unit, team, ...point(g, team, 35, 14));
      // Vision refreshes every other tick; inspect the first shot before travel can change the geometry materially.
      let fired = 0;
      for (let tick = 0; tick < 3; tick++) { g.step(); fired += shots(g, unit); }
      expect(fired > 0).toBe(bearing <= 25);
    });

    it(`bombers release on an overhead run, not at stand-off range (${team})`, () => {
      const g = arena();
      const unit = put(g, team, 'bomber', ...point(g, team, 20, 14));
      const target = put(g, enemy(team), 'trooper', ...point(g, team, 22, 14));
      move(g, unit, team, ...point(g, team, 34, 14));
      let fired = 0;
      for (let tick = 0; tick < toTicks(2); tick++) {
        g.step();
        if (shots(g, unit)) {
          expect(Math.hypot(target.x - unit.x, target.y - unit.y)).toBeLessThanOrEqual(target.radius + 0.5);
          fired++;
        }
      }
      expect(fired).toBeGreaterThan(0);
    });

    it(`explicit attack-move still stops and engages (${team})`, () => {
      const g = arena();
      const unit = put(g, team, 'trooper', ...point(g, team, 20, 14));
      put(g, enemy(team), 'trooper', ...point(g, team, 25, 14));
      move(g, unit, team, ...point(g, team, 34, 14), 'fight');
      let fired = 0;
      for (let tick = 0; tick < toTicks(3); tick++) { g.step(); fired += shots(g, unit); }
      expect(fired).toBeGreaterThan(0);
      expect(unit.firing).toBe(true);
      expect(Math.hypot(unit.vx, unit.vy)).toBe(0);
    });
  }

  /** Full cone (radians) a fixed or forward mount fires in around its body heading. */
  const cone = (g: AgentCommandGame, kind: UnitKind): number => {
    const mount = STATS[kind].mount!;
    return (mount.kind === 'forward' ? mount.arc : g.sim.econ.fixedMountArc) * Math.PI / 180;
  };
  /** Angle between `e`'s body heading and the bearing to (x, y), in its team's canonical frame. */
  const offBearing = (g: AgentCommandGame, e: Ent, x: number, y: number): number => {
    const mirror = e.side === slotOfArmyId('se', 2) ? -1 : 1;
    const goal = Math.atan2((y - e.y) * mirror, (x - e.x) * mirror);
    return Math.abs(Math.atan2(Math.sin(goal - e.heading), Math.cos(goal - e.heading)));
  };
  /** Shots `e` fired this tick, each checked to leave inside its mount's cone. */
  const checkedShots = (g: AgentCommandGame, e: Ent): number => {
    let n = 0;
    for (const { fx } of g.sim.fx) {
      if (fx.tick !== g.tick || fx.kind !== 'shot' || fx.src !== e.id) continue;
      if (Math.hypot(fx.tx! - e.x, fx.ty! - e.y) > 1e-6) expect(offBearing(g, e, fx.tx!, fx.ty!), `${e.kind} shot at tick ${g.tick}`).toBeLessThanOrEqual(cone(g, e.kind as UnitKind) / 2 + 1e-6);
      n++;
    }
    return n;
  };
  const victim: Record<string, UnitKind> = { surface: 'trooper', sky: 'interceptor', orbit: 'tug', depths: 'digger' };

  it('an attacking Lancer turns its hull onto a moving tug and fires only along it; the twins stay exact mirrors', () => {
    const g = arena();
    const pairs = (['nw', 'se'] as const).map((team) => {
      const lancer = put(g, team, 'lancer', ...point(g, team, 20, 14));
      lancer.heading = Math.PI; // facing away from the tug
      const tug = put(g, enemy(team), 'tug', ...point(g, team, 25, 12));
      vision(g, team, true);
      expect(g.apply({ team, role: 'orbit' }, { kind: 'attack', units: [id(g, team, lancer)], target: id(g, team, tug) })).toEqual({ ok: true });
      move(g, tug, enemy(team), ...point(g, team, 22, 18)); // crosses the Lancer's front, staying in range
      return { lancer, tug };
    });
    const [blue, red] = pairs as [typeof pairs[0], typeof pairs[0]];
    let fired = 0;
    for (let tick = 0; tick < toTicks(6); tick++) {
      g.step();
      for (const { lancer } of pairs) fired += checkedShots(g, lancer);
      expect(red.lancer.heading).toBe(blue.lancer.heading);
      expect(red.lancer.x + blue.lancer.x).toBe(g.sim.size);
    }
    expect(fired).toBeGreaterThanOrEqual(2);
    for (const { lancer, tug } of pairs) expect(offBearing(g, lancer, tug.x, tug.y)).toBeLessThan(cone(g, 'lancer') / 2);
  });

  for (const kind of (Object.keys(STATS) as UnitKind[]).filter((k) => STATS[k].dmg > 0 && STATS[k].speed > 0 && STATS[k].mount && STATS[k].mount!.kind !== 'turret')) {
    it(`${kind} (${STATS[kind].mount!.kind} mount) never fires outside its cone at a target behind it, either team`, () => {
      const g = arena();
      const plane = STATS[kind].plane;
      for (const team of ['nw', 'se'] as const) {
        const unit = put(g, team, kind, ...point(g, team, 20, 14));
        unit.heading = 0;
        const target = put(g, enemy(team), victim[STATS[kind].targets[0]!]!, ...point(g, team, 20 - 1.2, 14.4));
        vision(g, team, true);
        expect(g.apply({ team, role: plane }, { kind: 'attack', units: [id(g, team, unit)], target: id(g, team, target) })).toEqual({ ok: true });
      }
      const units = g.sim.ents.filter((e) => e.kind === kind && !e.dead);
      for (let tick = 0; tick < toTicks(3); tick++) {
        g.step();
        for (const u of units) checkedShots(g, u);
        expect(units[1]!.heading).toBe(units[0]!.heading);
      }
    });
  }
});
