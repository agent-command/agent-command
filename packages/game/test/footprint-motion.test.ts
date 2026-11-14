import { describe, expect, it } from 'vitest';
import { STATS, SURFACE, footprintDistance } from '../src/rules/contract.ts';
import { createGame } from '../src/agent/adapter.ts';
import { cellOfEnt } from '../src/util/grid.ts';
import { rotCell, rotX, rotY, slotOfArmyId } from '../src/util/teams.ts';
import { hullLineClear } from '../src/nav/nav.ts';
import { NAV_BLOCKED, SEP_DEADBAND } from '../src/sim/constants.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);

function arena(terrain: number = SURFACE.ground) {
  const g = createGame({ seed: 7, options: { terrain: 'open' } });
  g.sim.terrain.fill(terrain);
  g.sim.surfaceCost.fill(1);
  for (const e of g.sim.ents) if (e.unit) e.hp = 0;
  g.step();
  return g;
}

describe('solid registry footprints', () => {
  for (const kind of ['turret', 'shaft', 'headframe'] as const) {
    it(`routes mirrored units around the ${STATS[kind].footprint!.w}×${STATS[kind].footprint!.h} ${kind}`, () => {
      const g = arena();
      const f = STATS[kind].footprint!;
      const x = 18 + f.w / 2;
      const y = 19 + f.h / 2;
      const a = g.sim.add(kind, BLUE, 'surface', x, y);
      const b = g.sim.add(kind, RED, 'surface', g.sim.size - x, g.sim.size - y);
      const u = g.sim.add('trooper', BLUE, 'surface', x - 5, y);
      const v = g.sim.add('trooper', RED, 'surface', g.sim.size - u.x, g.sim.size - u.y);
      u.stance = v.stance = 'hold';
      g.sim.order(u, { k: 'move', x: x + 5, y, fight: false, speed: 0 });
      g.sim.order(v, { k: 'move', x: g.sim.size - x - 5, y: g.sim.size - y, fight: false, speed: 0 });
      let detoured = false;
      for (let i = 0; i < 500; i++) {
        g.step();
        expect(footprintDistance(kind, a.x, a.y, u.x, u.y)).toBeGreaterThan(0);
        expect(footprintDistance(kind, b.x, b.y, v.x, v.y)).toBeGreaterThan(0);
        expect(u.x + v.x).toBeCloseTo(g.sim.size, 7);
        expect(u.y + v.y).toBeCloseTo(g.sim.size, 7);
        detoured ||= Math.abs(u.y - y) > f.h / 2;
      }
      expect(detoured).toBe(true);
      expect(u.x).toBeGreaterThan(x + 4);
    });
  }

  for (const [kind, terrain] of [['tank', SURFACE.ground], ['trooper', SURFACE.ground], ['tank', SURFACE.highForest]] as const) {
    it(`walks the seed-21 Headframe/Shaft obstruction with the ${kind}'s real hull on terrain ${terrain}`, () => {
      const g = arena(terrain);
      const s = g.sim;
      // Exact structures and starting position from the captured natural seed-21 match, without a long bot replay.
      const structures = [
        s.add('headframe', BLUE, 'surface', 10.5, 4.5),
        s.add('shaft', BLUE, 'surface', 7, 7),
        s.add('headframe', BLUE, 'surface', 4.5, 10.5),
        s.add('turret', BLUE, 'surface', 10.5, 10.5),
      ];
      s.refreshSurfaceFootprints(BLUE);
      const u = s.add(kind, BLUE, 'surface', 8.4000001885, 5.5527867191);
      u.stance = 'hold';
      const x = 7.5413876027, y = 30.4325027727;
      expect(u.radius).toBe(STATS[kind].radius);
      expect(s.reachable(u, x, y)).toBe(true);
      expect(s.planSurface(u, Math.floor(y) * s.size + Math.floor(x), x, y)).toBe(true);
      expect(u.navDirect).toBe(false);
      expect(hullLineClear(s.surfaceNav[BLUE]!, u.x, u.y, u.wx, u.wy, u.radius, u.frame, s.size, true)).toBe(true);
      s.order(u, { k: 'move', x, y, fight: false, speed: 0 });
      let throughGap = false;
      let wentAround = false;
      for (let i = 0; i < 1600 && Math.hypot(u.x - x, u.y - y) > 0.05; i++) {
        const px = u.x, py = u.y;
        g.step();
        if (u.order.k === 'move') {
          expect(u.order.x, 'an obstacle along the route must not shift the destination').toBe(x);
          expect(u.order.y, 'an obstacle along the route must not shift the destination').toBe(y);
        }
        // Production stepping includes planning, inertia, ORCA and separation. No isolated waypoint-only proof.
        expect(hullLineClear(s.block, px, py, u.x, u.y, u.radius, u.frame, s.size, true), `terrain at tick ${i}`).toBe(true);
        for (const o of structures) {
          expect(footprintDistance(o.kind, o.x, o.y, u.x, u.y), `${o.kind} at tick ${i}`).toBeGreaterThanOrEqual(u.radius - SEP_DEADBAND);
        }
        throughGap ||= u.x > 8 && u.x < 9 && u.y > 6 && u.y < 8;
        wentAround ||= (u.x < 6 && u.y > 6 && u.y < 8) || (u.x > 12 && u.y > 3 && u.y < 6);
      }
      expect(Math.hypot(u.x - x, u.y - y)).toBeLessThan(0.05);
      expect(throughGap).toBe(kind === 'trooper');
      if (kind === 'tank') expect(wentAround).toBe(true);
    });
  }

  it('uses hull-safe firing fields and connectors from a blocked cell centre', () => {
    const g = arena();
    const s = g.sim;
    s.add('headframe', BLUE, 'surface', 10.5, 4.5);
    s.add('shaft', BLUE, 'surface', 7, 7);
    const target = s.add('headframe', RED, 'surface', 7.5, 20.5);
    const u = s.add('tank', BLUE, 'surface', 8.4000001885, 5.5527867191);
    s.refreshSurfaceFootprints(BLUE);
    const field = s.firingField(u, target);
    const c = cellOfEnt(u, s.size);
    const geometry = s.flows[BLUE]!.geometry(u.radius, u.frame, s.holesVersion, s.tick);
    expect(hullLineClear(s.surfaceNav[BLUE]!, c % s.size + 0.5, Math.floor(c / s.size) + 0.5, c % s.size + 0.5, Math.floor(c / s.size) + 0.5, u.radius, u.frame, s.size)).toBe(false);
    expect(hullLineClear(s.surfaceNav[BLUE]!, geometry.x[c]!, geometry.y[c]!, geometry.x[c]!, geometry.y[c]!, u.radius, u.frame, s.size)).toBe(true);
    expect(field[c]).toBeLessThan(Infinity);
    expect(s.canReachFiring(u, target)).toBe(true);
    expect(s.approach(u, target)).not.toBe(NAV_BLOCKED);
    expect(hullLineClear(s.surfaceNav[BLUE]!, u.x, u.y, u.wx, u.wy, u.radius, u.frame, s.size, true)).toBe(true);
    for (let goal = 0; goal < s.n; goal++) {
      if (field[goal] !== 0) continue;
      u.x = geometry.x[goal]!;
      u.y = geometry.y[goal]!;
      expect(hullLineClear(s.surfaceNav[BLUE]!, u.x, u.y, u.x, u.y, u.radius, u.frame, s.size)).toBe(true);
      expect(s.inRange(u, target), `firing representative ${goal}`).toBe(true);
      expect(s.lineOfFire(u, target), `firing representative ${goal}`).toBe(true);
    }
  });

  it('invalidates a cached legal hull route when a footprint appears and disappears', () => {
    const g = arena();
    const s = g.sim;
    const u = s.add('tank', BLUE, 'surface', 15.5, 20.5);
    s.refreshSurfaceFootprints(BLUE);
    expect(s.planSurface(u, 20 * s.size + 25, 25.5, 20.5)).toBe(true);
    expect(u.navDirect).toBe(true);
    const before = s.holesVersion;
    const shaft = s.add('shaft', BLUE, 'surface', 21, 21);
    g.step();
    expect(s.holesVersion).toBeGreaterThan(before);
    expect(s.navTo(u, 25.5, 20.5)).not.toBe(NAV_BLOCKED);
    expect(u.navDirect).toBe(false);
    expect(hullLineClear(s.surfaceNav[BLUE]!, u.x, u.y, u.wx, u.wy, u.radius, u.frame, s.size, true)).toBe(true);
    shaft.hp = 0;
    g.step();
    g.step();
    expect(s.navTo(u, 25.5, 20.5)).not.toBe(NAV_BLOCKED);
    expect(u.navDirect).toBe(true);
  });

  it('walks mirrored tanks through a bent two-cell corridor without a direct-line shortcut', () => {
    const trail: [number, number][] = [];
    for (const army of [BLUE, RED]) {
      const g = arena();
      const s = g.sim;
      const frame = s.armyFrame[army]!;
      // A sealed L-shaped corridor, two cells wide in both legs. Its cell centres are too close to a wall for r=.6,
      // but the integer centreline has a full tile of clearance. Neither an outside detour nor a direct line exists.
      for (let y = 10; y <= 23; y++) for (let x = 15; x <= 28; x++) {
        const open = (x >= 16 && x <= 25 && y >= 11 && y <= 12) || (x >= 24 && x <= 25 && y >= 11 && y <= 21);
        const c = rotCell(frame, y * s.size + x, s.size);
        s.block[c] = open ? 0 : 1;
        s.terrain[c] = open ? SURFACE.ground : SURFACE.cliff;
      }
      s.refreshSurfaceFootprints(army);
      const u = s.add('tank', army, 'surface', rotX(frame, 17.5, 12, s.size), rotY(frame, 17.5, 12, s.size));
      u.stance = 'hold';
      const x = rotX(frame, 25, 20.5, s.size), y = rotY(frame, 25, 20.5, s.size);
      expect(u.radius).toBe(0.6);
      expect(hullLineClear(s.surfaceNav[army]!, u.x, u.y, x, y, u.radius, u.frame, s.size)).toBe(false);
      expect(s.reachable(u, x, y)).toBe(true);
      expect(s.reachableNear(u, x, y)).toEqual([x, y]);
      s.order(u, { k: 'move', x, y, fight: false, speed: 0 });
      let steps = 0;
      for (; steps < 1000 && Math.hypot(u.x - x, u.y - y) > 0.05; steps++) {
        const px = u.x, py = u.y;
        g.step();
        expect(hullLineClear(s.block, px, py, u.x, u.y, u.radius, u.frame, s.size), `corridor tick ${steps}`).toBe(true);
        const rx = rotX(frame, u.x, u.y, s.size), ry = rotY(frame, u.x, u.y, s.size);
        if (army === BLUE) trail.push([rx, ry]);
        else {
          expect(rx, `rotated x tick ${steps}`).toBe(trail[steps]![0]);
          expect(ry, `rotated y tick ${steps}`).toBe(trail[steps]![1]);
        }
      }
      expect(Math.hypot(u.x - x, u.y - y)).toBeLessThan(0.05);
      if (army === RED) expect(steps).toBe(trail.length);
    }
  });

  it('closes a choke and reopens it when the structure is removed', () => {
    const g = arena();
    for (let y = 0; y < g.sim.size; y++) if (y !== 20 && y !== 21) g.sim.block[y * g.sim.size + 20] = 1;
    const shaft = g.sim.add('shaft', BLUE, 'surface', 21, 21);
    const u = g.sim.add('trooper', BLUE, 'surface', 17.5, 20.5);
    g.step();
    expect(g.sim.navTo(u, 25.5, 20.5)).toBe(2);
    shaft.hp = 0;
    g.step();
    g.step();
    expect(g.sim.navTo(u, 25.5, 20.5)).not.toBe(2);
  });

  it('does not route through the solid Depths root, and delivers on its apron', () => {
    const g = arena();
    const p = g.sim.armies[BLUE]!.spire.depths;
    const u = g.sim.spawnUnit(BLUE, 'digger', 'depths');
    expect(g.sim.depthBodies[cellOfEnt(u, g.sim.size)]).toBe(0);
    expect(g.sim.armies[BLUE]!.drop[cellOfEnt(u, g.sim.size)]).toBe(1);
    expect(g.sim.planDepths(u, cellOfEnt(p, g.sim.size), true)).toBe(true);
    expect(u.path!.every((c) => !g.sim.depthBodies[c])).toBe(true);
    for (const e of g.sim.ents) if (e.unit && e.plane === 'depths') expect(g.sim.depthBodies[cellOfEnt(e, g.sim.size)]).toBe(0);
  });

  it('mirrors the lower landing and drop cell of an even-sized Shaft exactly', () => {
    const g = arena();
    const a = g.sim.build(BLUE, 'shaft', 20, 12, 'surface');
    const b = g.sim.build(RED, 'shaft', g.sim.size - 20, g.sim.size - 12, 'surface');
    expect(cellOfEnt(a, g.sim.size) + cellOfEnt(b, g.sim.size)).toBe(g.sim.size * g.sim.size - 1);
    for (let i = 0; i <= STATS.shaft.build; i++) g.step();
    expect(a.built && b.built).toBe(true);
    expect(g.sim.armies[BLUE]!.drop[cellOfEnt(a, g.sim.size)]).toBe(1);
    expect(g.sim.armies[RED]!.drop[cellOfEnt(b, g.sim.size)]).toBe(1);
    expect(g.sim.cells[cellOfEnt(a, g.sim.size)]).toBe(g.sim.cells[cellOfEnt(b, g.sim.size)]);
  });

  it('keeps hidden footprints out of team path queries', () => {
    const a = arena();
    const b = arena();
    b.sim.add('headframe', RED, 'surface', 24.5, 24.5);
    a.step(); b.step();
    expect(a.sim.surfaceNav[BLUE]).toEqual(b.sim.surfaceNav[BLUE]);
    expect(a.sim.depthNav[BLUE]).toEqual(b.sim.depthNav[BLUE]);
  });

  it('reveals a structure at its visible footprint edge, not on neighbouring empty cells', () => {
    const g = arena();
    const target = g.sim.add('headframe', RED, 'surface', 24.5, 24.5);
    const vis = g.sim.vis[1]!;
    vis.fill(0);
    vis[22 * g.sim.size + 23] = g.sim.armies[BLUE]!.group.bit;
    expect(g.sim.sees(BLUE, target)).toBe(false);
    vis[23 * g.sim.size + 23] = g.sim.armies[BLUE]!.group.bit;
    expect(g.sim.sees(BLUE, target)).toBe(true);
  });

  it('measures weapon reach against rectangle faces and corners', () => {
    const g = arena();
    const target = g.sim.add('headframe', RED, 'surface', 24.5, 24.5);
    const u = g.sim.add('trooper', BLUE, 'surface', 24.5, 24.5);
    const range = g.sim.stat(u).range;
    u.x = target.x + STATS.headframe.footprint!.w / 2 + range - 0.01;
    expect(g.sim.inRange(u, target)).toBe(true);
    u.x += 0.02;
    expect(g.sim.inRange(u, target)).toBe(false);
    u.x = target.x + STATS.headframe.footprint!.w / 2 + range / Math.SQRT2 - 0.01;
    u.y = target.y + STATS.headframe.footprint!.h / 2 + range / Math.SQRT2 - 0.01;
    expect(g.sim.inRange(u, target)).toBe(true);
  });
});
