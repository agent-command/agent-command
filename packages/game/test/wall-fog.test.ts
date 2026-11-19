/**
 * Walls block sight on every plane (DESIGN §7): twin worlds that differ only by an enemy just behind a wall must tell
 * the viewer the same thing, for every army of a mirrored duel (C2) and, in Orbit, of a four-army match (C4).
 */
import { describe, expect, it } from 'vitest';
import { AgentCommandGame } from '../src/agent/adapter.ts';
import { CELL, PLANES, SURFACE, isSurfaceHigh, surfaceFeature, type MatchOptions, type UnitKind } from '../src/rules/contract.ts';
import { PLANE_INDEX } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { rotCell, rotX, rotY } from '../src/util/teams.ts';

const quiet = (orbit: MatchOptions['orbit'] = {}, extra: MatchOptions = {}): MatchOptions =>
  ({ terrain: 'open', spire: { dmg: 0 }, ...extra, orbit: { maxAsteroids: 0, stationPdDamage: 0, ...orbit } });

/** Everything army `a` is told: its view and every seat's full observation. */
function told(g: AgentCommandGame, a: number): string {
  const team = g.sim.armyIds[a]!;
  return JSON.stringify(g.view(team, { snapshot: true })) + PLANES.map((role) => JSON.stringify(g.observe({ team, role }, 0))).join('');
}

interface Scene {
  /** viewer and enemy kinds, plane and canonical (army-0 frame) positions */
  plane: 'depths' | 'surface' | 'orbit';
  viewer: UnitKind;
  at: readonly [number, number];
  enemy: UnitKind;
  behind: readonly [number, number];
  /** canonical setup before units are placed (carving, tick) */
  setup?: (g: AgentCommandGame, frame: number) => void;
  patch?: (e: Ent) => void;
}

/**
 * Twin worlds for army `a`: the scene rotated into its frame, with and without a hostile unit at `behind`. Returns
 * whether the enemy is seen and whether the twins told `a` anything different.
 */
function twin(seed: number, options: MatchOptions, a: number, scene: Scene): { seen: boolean; differs: boolean } {
  const build = (withEnemy: boolean) => {
    const g = new AgentCommandGame(seed, options);
    const s = g.sim;
    const k = s.armyFrame[a]!;
    const enemyArmy = s.allArmies.find((b) => s.hostile(a, b))!;
    scene.setup?.(g, k);
    const [vx, vy] = scene.at;
    s.add(scene.viewer, a, scene.plane, rotX(k, vx, vy, s.size), rotY(k, vx, vy, s.size)).stance = 'hold';
    let enemy: Ent | undefined;
    if (withEnemy) {
      const [ex, ey] = scene.behind;
      enemy = s.add(scene.enemy, enemyArmy, scene.plane, rotX(k, ex, ey, s.size), rotY(k, ex, ey, s.size));
      enemy.stance = 'hold';
      scene.patch?.(enemy);
    }
    s['computeVision']();
    return { g, enemy };
  };
  const without = build(false);
  const withEnemy = build(true);
  return { seen: withEnemy.g.sim.sees(a, withEnemy.enemy!), differs: told(without.g, a) !== told(withEnemy.g, a) };
}

describe('the derelict ruin\'s walls block Orbit sight (orbit.derelictBlocksVision)', () => {
  const at = (tick: number) => (g: AgentCommandGame) => { g.sim.tick = tick; };
  for (const slots of [2, 4] as const) {
    const options = (rule: boolean) => ({ ...quiet({ derelictBlocksVision: rule }), map: { params: { slots } } });
    const label = slots === 2 ? 'C2' : 'C4';
    const ruin = new AgentCommandGame(7, options(true)).sim.derelict!;
    const c = ruin.x;
    // On the diagonal the hull and the ring are solid whatever the gates do.
    const diag = (r: number): readonly [number, number] => [c - r * Math.SQRT1_2, c - r * Math.SQRT1_2];
    // On the east axis a breach and (while open) a gate line up.
    const east = (r: number): readonly [number, number] => [c + r, c];
    const outside = diag(ruin.hullOuter + 0.7);
    const corridorByHull = diag(ruin.hullInner - 0.4);
    const corridorByRing = diag(ruin.ringOuter + 0.7);
    const chamber = diag(ruin.ringInner - 0.7);
    const sealed = ruin.open + ruin.turn + 1;
    const walls: readonly (readonly [string, readonly [number, number], readonly [number, number], number])[] = [
      ['outside the hull into the corridor (gates open)', outside, corridorByHull, 0],
      ['outside the hull into the corridor (gates sealed)', outside, corridorByHull, sealed],
      ['the corridor out past the hull', corridorByHull, outside, 0],
      ['the chamber out through the sealed ring', chamber, corridorByRing, sealed],
      ['the chamber out through the ring between its open gates', chamber, corridorByRing, 0],
    ];
    for (const [what, from, behind, tick] of walls) {
      it(`${label}: every army sees nothing from ${what}, which it would without the rule`, () => {
        const scene: Scene = { plane: 'orbit', viewer: 'lancer', at: from, enemy: 'skiff', behind, setup: at(tick) };
        for (let a = 0; a < slots; a++) {
          expect(twin(7, options(true), a, scene), `army ${a}`).toEqual({ seen: false, differs: false });
          expect(twin(7, options(false), a, scene).seen, `army ${a} without the rule`).toBe(true);
        }
      });
    }
    it(`${label}: every army sees through a breach`, () => {
      for (let a = 0; a < slots; a++) {
        const breach = twin(7, options(true), a, { plane: 'orbit', viewer: 'lancer', at: east(ruin.hullOuter + 0.7), enemy: 'skiff', behind: east(ruin.hullInner - 0.7) });
        expect(breach.seen, `army ${a} through the breach`).toBe(true);
      }
    });
    // Daylight everywhere, so the longer sightline from outside the hull is not cut short by night (rules.orbit.night*).
    const day = (rule: boolean) => ({ ...quiet({ derelictBlocksVision: rule, nightVision: 1, nightSignature: 1 }), map: { params: { slots } } });
    const into = east(ruin.ringInner - 0.7);
    for (const [where, from] of [['the corridor', east(ruin.ringOuter + 0.7)], ['outside the hull', east(ruin.hullOuter + 0.6)]] as const) {
      it(`${label}: every army sees into the chamber from ${where} along an open gate's line, never through the sealed ring`, () => {
        const scene = (tick: number): Scene => ({ plane: 'orbit', viewer: 'lancer', at: from, enemy: 'skiff', behind: into, setup: at(tick) });
        for (let a = 0; a < slots; a++) {
          expect(twin(7, day(true), a, scene(0)).seen, `army ${a} through an open gate`).toBe(true);
          expect(twin(7, day(true), a, scene(sealed)), `army ${a} through the sealed ring`).toEqual({ seen: false, differs: false });
          // Without the rule the walls are transparent and the chamber alone stays hidden from outside.
          expect(twin(7, day(false), a, scene(0)), `army ${a} without the rule`).toEqual({ seen: false, differs: false });
        }
      });
    }
    it(`${label}: cloak detection reaches into the chamber only through an open gate`, () => {
      const from = east(ruin.ringOuter + 0.6), hidden = east(ruin.ringInner - 0.5);
      expect(from[0] - hidden[0]).toBeLessThan(new AgentCommandGame(7, options(true)).sim.stats.bastion.range);
      const scene = (tick: number): Scene => ({ plane: 'orbit', viewer: 'bastion', at: from, enemy: 'skiff', behind: hidden, setup: at(tick), patch: (e) => { e.cloaked = true; } });
      for (let a = 0; a < slots; a++) {
        expect(twin(7, day(true), a, scene(0)).seen, `army ${a} through an open gate`).toBe(true);
        expect(twin(7, day(true), a, scene(sealed)), `army ${a} through the sealed ring`).toEqual({ seen: false, differs: false });
      }
    });
    it(`${label}: a cloaked ship in the dark behind the hull escapes a Bastion's detection range`, () => {
      const g = new AgentCommandGame(7, options(true));
      let dark = 0;
      for (g.sim.tick = 0; g.sim.lit(corridorByHull[0], corridorByHull[1]); g.sim.tick += 20) dark = g.sim.tick + 20;
      const from = diag(ruin.hullOuter + 0.75);
      const scene: Scene = { plane: 'orbit', viewer: 'bastion', at: from, enemy: 'skiff', behind: corridorByHull, setup: at(dark), patch: (e) => { e.cloaked = true; } };
      expect(Math.hypot(from[0] - corridorByHull[0], from[1] - corridorByHull[1])).toBeLessThan(g.sim.stats.bastion.range);
      for (let a = 0; a < slots; a++) {
        expect(twin(7, options(true), a, scene), `army ${a}`).toEqual({ seen: false, differs: false });
        expect(twin(7, options(false), a, scene).seen, `army ${a} without the rule`).toBe(true);
      }
    });
  }
});

describe('Depths rock blocks sight, corners included', () => {
  /** A tunnel ending beside a pocket that touches it only at a corner (both cells between are rock) or through one. */
  const carve = (pinched: boolean) => (g: AgentCommandGame, k: number) => {
    const s = g.sim;
    const cell = (x: number, y: number) => rotCell(k, y * s.size + x, s.size);
    for (let y = 14; y <= 22; y++) for (let x = 14; x <= 22; x++) s.cells[cell(x, y)] = CELL.rock;
    for (const [x, y] of [[16, 18], [17, 18], [18, 18], [19, 19]] as const) s.cells[cell(x, y)] = CELL.tunnel;
    if (!pinched) s.cells[cell(19, 18)] = CELL.tunnel;
  };
  const scene = (pinched: boolean): Scene => ({ plane: 'depths', viewer: 'digger', at: [16.5, 18.5], enemy: 'trooper', behind: [19.5, 19.5], setup: carve(pinched) });
  it('C2: neither army sees into a pocket touching its tunnel only at a corner, and both do once a cell between opens', () => {
    for (const a of [0, 1]) {
      expect(twin(7, quiet(), a, scene(true)), `army ${a}`).toEqual({ seen: false, differs: false });
      expect(twin(7, quiet(), a, scene(false)).seen, `army ${a} open corner`).toBe(true);
    }
  });
});

describe('Surface cliffs block sight however short the clip', () => {
  /**
   * Low-ground pairs within a trooper's sight whose centre line crosses the joint of two diagonally touching cliff
   * cells (the cells beside the joint open): the sightline passes through a cliff, if only by a corner.
   */
  function pinchPairs(g: AgentCommandGame, reach: number): [number, number][] {
    const s = g.sim;
    const n = s.size;
    const cliff = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && s.terrain[y * n + x] === SURFACE.cliff;
    const low = (c: number) => s.terrain[c] !== SURFACE.cliff && !isSurfaceHigh(s.terrain[c]!);
    const joints: [number, number, number, number][] = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (const dy of [1, -1]) {
      if (cliff(x, y) && cliff(x + 1, y + dy) && !cliff(x + 1, y) && !cliff(x, y + dy)) joints.push([x + 0.5, y + 0.5, x + 1.5, y + dy + 0.5]);
    }
    const cross = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const pairs: [number, number][] = [];
    for (const [px, py, qx, qy] of joints) {
      const mx = Math.floor((px + qx) / 2), my = Math.floor((py + qy) / 2);
      for (let oy = my - reach; oy <= my + reach; oy++) for (let ox = mx - reach; ox <= mx + reach; ox++) for (let ty = my - reach; ty <= my + reach; ty++) for (let tx = mx - reach; tx <= mx + reach; tx++) {
        if (ox < 0 || oy < 0 || tx < 0 || ty < 0 || ox >= n || oy >= n || tx >= n || ty >= n || (tx - ox) ** 2 + (ty - oy) ** 2 > reach * reach) continue;
        const o = oy * n + ox, t = ty * n + tx;
        // The enemy stands in the open: a forest would hide it anyway.
        if (!low(o) || !low(t) || surfaceFeature(s.terrain[t]!) === SURFACE.forest) continue;
        const [ax, ay, bx, by] = [ox + 0.5, oy + 0.5, tx + 0.5, ty + 0.5];
        if (cross(ax, ay, bx, by, px, py) * cross(ax, ay, bx, by, qx, qy) < 0 && cross(px, py, qx, qy, ax, ay) * cross(px, py, qx, qy, bx, by) < 0) pairs.push([o, t]);
      }
    }
    return pairs;
  }

  it('no sightline crosses the joint of a diagonal cliff line (ridges and canyons, every seed checked)', () => {
    for (const terrain of ['ridges', 'canyons'] as const) for (const seed of [1, 2]) {
      const g = new AgentCommandGame(seed, quiet({}, { terrain }));
      const pairs = pinchPairs(g, 6);
      expect(pairs.length, `${terrain} seed ${seed} has diagonal cliff joints`).toBeGreaterThan(0);
      for (const [o, t] of pairs) expect(g.sim.los.visible(o, t), `${terrain} seed ${seed}: ${o} → ${t}`).toBe(false);
    }
  });

  it('C2: neither army sees an enemy past a diagonal cliff joint', () => {
    const options = quiet({}, { terrain: 'ridges' });
    const g = new AgentCommandGame(1, options);
    const n = g.sim.size;
    // Pairs well away from both armies' own sight, so the twins differ only by what the viewer could see.
    const far = pinchPairs(g, 5).filter(([o, t]) => [o, t].every((c) => [0, 1].every((a) => (g.sim.vis[PLANE_INDEX.surface]![rotCell(g.sim.armyFrame[a]!, c, n)]! & g.sim.armies[a]!.group.bit) === 0)));
    expect(far.length).toBeGreaterThan(0);
    for (const [o, t] of far.slice(0, 4)) {
      const scene: Scene = { plane: 'surface', viewer: 'trooper', at: [(o % n) + 0.5, Math.floor(o / n) + 0.5], enemy: 'trooper', behind: [(t % n) + 0.5, Math.floor(t / n) + 0.5] };
      for (const a of [0, 1]) expect(twin(1, options, a, scene), `army ${a}: ${o} → ${t}`).toEqual({ seen: false, differs: false });
    }
  });
});
