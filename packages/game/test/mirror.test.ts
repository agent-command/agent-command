import { expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { CELL } from '../src/rules/contract.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { route } from '../src/planes/derelict.ts';
import { HOLE, VISION_EVERY } from '../src/sim/constants.ts';
import { cellOf } from '../src/util/grid.ts';
import { NEUTRAL } from '../src/util/teams.ts';
import { orbitAsymmetry } from './mirror.ts';

// Two-army matches: army 0 is the NW slot (blue), army 1 the SE slot (red).
const BLUE = 0;
const RED = 1;

it('ongoing ice mining, a fogged full return and drifting-site reacquisition preserve exact point symmetry', () => {
  const g = createGame({ seed: 31, options: { terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0, derelictEnabled: false, stationPdDamage: 0 } } });
  const home = g.sim.armies[BLUE]!.spire.orbit;
  const pairs = (['nw', 'se'] as const).map((team, army) => {
    const x = team === 'nw' ? home.x + 14 : g.sim.size - home.x - 14;
    const y = team === 'nw' ? home.y + 3 : g.sim.size - home.y - 3;
    const tug = g.sim.add('tug', army, 'orbit', x, y);
    const rock = g.sim.add('asteroid', NEUTRAL, 'orbit', x + (team === 'nw' ? 1 : -1) * g.sim.econ.tugMineReach, y);
    rock.vx = (team === 'nw' ? 1 : -1) * g.sim.econ.asteroidDrift / 20;
    rock.vy = (team === 'nw' ? 1 : -1) * g.sim.econ.asteroidDrift / 40;
    rock.resourceType = 'ice';
    rock.resourceRemaining = g.sim.rocks.medium.dockYield.ice.energy;
    rock.state = 'drifting';
    return { team, tug, rock };
  });
  g.sim.computeVision();
  for (const { team, tug, rock } of pairs) expect(g.apply({ team, role: 'orbit' }, { kind: 'mine_asteroid', units: [g.entityId(team, tug.id)], asteroid: g.entityId(team, rock.id) })).toEqual({ ok: true });
  // Mirrored twins carry the same name in their own army's namespace.
  for (const key of ['tug', 'rock'] as const) expect(g.entityId('se', pairs[1]![key].id)).toBe(g.entityId('nw', pairs[0]![key].id));
  const blueRock = g.entityId('nw', pairs[0]!.rock.id);
  let unloaded = false, resumed = false, hidden = false;
  for (let i = 0; i < 2000 && !resumed; i++) {
    g.step();
    expect(orbitAsymmetry(g.sim), `mining tick ${g.tick}`).toBeUndefined();
    const { tug, rock } = pairs[0]!;
    if (i > 500 && tug.cargoEnergy === 0) unloaded = true;
    if (unloaded && tug.miningTarget === rock.id && tug.cargoEnergy > 0) resumed = true;
    if (unloaded && !g.view('nw').entities.some(e => e.id === blueRock)) hidden = true;
  }
  expect(unloaded).toBe(true); expect(hidden).toBe(true); expect(resumed).toBe(true);
  expect(pairs[0]!.rock.resourceRemaining).toBeLessThan(70);
});

// Full bot matches checked every tick: the serial timing set (pnpm test:timing); AC_EXTENDED_MIRRORS opts into all seeds.
for (const seed of process.env.AC_EXTENDED_MIRRORS ? [1, 2, 3, 4, 5, 6] : [1]) {
  it(`open/standard seed ${seed} mirrors contested-lode scouting and the economy`, { tags: ['timing'] }, () => {
    playBotMatch({
      seed, options: { terrain: 'open' }, levels: { nw: 'standard', se: 'standard' },
      maxTicks: process.env.AC_EXTENDED_MIRRORS ? undefined : 2800,
      onTick: (g) => {
        const first = orbitAsymmetry(g.sim);
        if (first) throw new Error(first);
      },
    });
  });
}

it('island pairs use exactly mirrored quantized positions at a trigonometric rounding boundary', () => {
  const g = createGame({ seed: 6, options: { terrain: 'open' } });
  for (const e of g.sim.ents) if (e.kind !== 'island' && e.kind !== 'spire') e.dead = true;
  // At this phase the independent sin/cos evaluations of a and a + PI rounded one quantum apart.
  g.sim.tick = 8770;
  g.step();
  expect(orbitAsymmetry(g.sim)).toBeUndefined();
});

it('derelict waypoints round the hull at exactly mirrored quantized points', () => {
  const g = createGame({ seed: 3, options: { terrain: 'open' } });
  const s = g.sim;
  // Extended-mirror seed 3's tug at tick 14666: centre minus the arc offset rounded in [8, 16), centre plus it in
  // [32, 48), and the waypoints came out one quantum apart.
  const from = [6.023857085034251, 10.247856580652297] as const;
  const to = [20.246259999461472, 38.00569298584014] as const;
  s.tick = 14666;
  expect(s.derelictRoute(from[0], from[1], 0.5, to[0], to[1], -1)).toBe(true);
  const blue = { ...route };
  expect(s.derelictRoute(s.size - from[0], s.size - from[1], 0.5, s.size - to[0], s.size - to[1], -1)).toBe(true);
  expect([s.size - route.x, s.size - route.y, route.skirt]).toEqual([blue.x, blue.y, blue.skirt]);
});

it('vision chords ending exactly on a cell edge mark mirrored cells for mirrored viewers', () => {
  const g = createGame({ seed: 2, options: { terrain: 'open', sky: { stormRadius: 0, fogRadius: 0 } } });
  const s = g.sim;
  for (const e of s.ents) if (e.kind !== 'island' && e.kind !== 'spire') e.dead = true;
  // On its own row, an interceptor at an integer x sees a chord from x - vision to x + vision: both ends on cell edges.
  const blue = s.add('interceptor', BLUE, 'sky', 13, 32.5);
  s.add('interceptor', RED, 'sky', s.size - blue.x, s.size - blue.y);
  expect(s.stat(blue).vision % 1).toBe(0);
  s['computeVision']();
  const last = s.size * s.size - 1;
  for (let p = 0; p < 4; p++) {
    const vis = s.vis[p]!;
    const blueBit = s.armies[BLUE]!.group.bit;
    const redBit = s.armies[RED]!.group.bit;
    for (let c = 0; c <= last; c++) expect((vis[last - c]! & redBit) !== 0, `plane ${p} cell ${c % s.size},${Math.floor(c / s.size)}`).toBe((vis[c]! & blueBit) !== 0);
  }
});

it('a single unit ordered to mirrored decimal points steers to exactly mirrored destinations', () => {
  const g = createGame({ seed: 2, options: { terrain: 'open' } });
  const s = g.sim;
  for (const e of s.ents) if (e.kind !== 'island' && e.kind !== 'spire') e.dead = true;
  const blue = s.add('bastion', BLUE, 'orbit', 28, 9);
  const red = s.add('bastion', RED, 'orbit', s.size - 28, s.size - 9);
  // 48 - 32.62 !== 15.38 in floating point: the decimal point a red bot sends is not the exact mirror of blue's.
  expect(s.size - 32.62).not.toBe(15.38);
  expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'move', units: [g.entityId('nw', blue.id)], x: 32.62, y: 9.75 })).toEqual({ ok: true });
  expect(g.apply({ team: 'se', role: 'orbit' }, { kind: 'move', units: [g.entityId('se', red.id)], x: 15.38, y: 38.25 })).toEqual({ ok: true });
  if (blue.order.k !== 'move' || red.order.k !== 'move') throw new Error('move orders expected');
  expect(red.order.x).toBe(s.size - blue.order.x);
  expect(red.order.y).toBe(s.size - blue.order.y);
  for (let t = 0; t < 600 && blue.order.k === 'move'; t++) {
    g.step();
    expect(orbitAsymmetry(g.sim), `tick ${t}`).toBeUndefined();
  }
});

it('separation pushes mirrored overlapping units by exactly mirrored steps', () => {
  const g = createGame({ seed: 5 });
  const s = g.sim;
  for (const e of s.ents) if (e.kind !== 'island' && e.kind !== 'spire') e.dead = true;
  s.cells.fill(CELL.tunnel);
  for (const t of s.armies) t.group.known.fill(CELL.tunnel);
  // A breach squad captured from a veteran canyons match (seed 11, tick 16520): four troopers pinned at the cell's
  // corners and one between them. Its push summed onto y near 38.5 and onto the mirrored 9.5 rounded one quantum
  // apart when the sum was quantized instead of the push.
  const squad = [
    [39.500067981891334, 38.499967427924275],
    [39.15000000037253, 38.15000000037253],
    [39.84999999962747, 38.84999999962747],
    [39.15000000037253, 38.84999999962747],
    [39.84999999962747, 38.15000000037253],
  ] as const;
  for (const [x, y] of squad) {
    const b = s.add('trooper', BLUE, 'depths', x, y);
    const r = s.add('trooper', RED, 'depths', s.size - x, s.size - y);
    b.cell = cellOf(x, y, s.size);
    r.cell = s.size * s.size - 1 - b.cell;
  }
  for (let t = 0; t < 10; t++) {
    g.step();
    expect(orbitAsymmetry(g.sim), `tick ${t}`).toBeUndefined();
  }
});

it('completing enemy rail does not accelerate only the later mirrored path follower', () => {
  const g = createGame({ seed: 5, options: { depths: { railTime: 0.05 } } });
  const s = g.sim;
  for (const e of s.ents) if (e.kind !== 'island' && e.kind !== 'spire') e.dead = true;
  s.cells.fill(CELL.tunnel);
  for (const t of s.armies) t.group.known.fill(CELL.tunnel);
  // Each visitor walks onto the enemy's completing rail. Blue decides before the red layer,
  // while red decides after the blue layer: both must still use this tick's tunnel speed.
  const blueLayer = s.add('digger', BLUE, 'depths', 17.5, 14.5);
  const blueVisitor = s.add('digger', BLUE, 'depths', 29.75, 33.5);
  const redLayer = s.add('digger', RED, 'depths', 30.5, 33.5);
  const redVisitor = s.add('digger', RED, 'depths', s.size - blueVisitor.x, s.size - blueVisitor.y);
  for (const e of [blueLayer, blueVisitor, redLayer, redVisitor]) e.cell = cellOf(e.x, e.y, s.size);
  for (const e of [blueLayer, redLayer]) e.order = { k: 'rail', c: e.cell };
  for (const [e, layer] of [[blueVisitor, redLayer], [redVisitor, blueLayer]] as const) {
    e.order = { k: 'move', x: layer.x, y: layer.y, fight: false, speed: 0 };
    e.path = [layer.cell];
    e.pathI = 0;
    e.navGoal = layer.cell;
  }
  g.step();
  expect(s.cells[blueLayer.cell]).toBe(CELL.rail);
  expect(s.cells[redLayer.cell]).toBe(CELL.rail);
  expect(blueVisitor.x).toBeGreaterThan(29.75);
  expect(redVisitor.x).toBe(s.size - blueVisitor.x);
  expect(redVisitor.y).toBe(s.size - blueVisitor.y);
});

it('automatic acquisition breaks equal-distance ties by serial, not spatial-index storage order', () => {
  const g = createGame({ seed: 5 });
  const s = g.sim;
  for (const e of s.ents) if (e.kind !== 'island' && e.kind !== 'spire') e.dead = true;
  s.cells.fill(CELL.tunnel);
  for (const t of s.armies) t.group.known.fill(CELL.tunnel);
  const n = s.size;
  // Mirrored twins share serials; the enemies on either side of each digger are equally near.
  const blue = s.add('digger', BLUE, 'depths', 12.5, 12.5);
  const red = s.add('digger', RED, 'depths', n - 12.5, n - 12.5);
  for (const dx of [-1, 1]) {
    s.add('digger', RED, 'depths', 12.5 + dx, 12.5);
    s.add('digger', BLUE, 'depths', n - 12.5 - dx, n - 12.5);
  }
  for (const e of s.ents) if (!e.dead && e.plane === 'depths') e.cell = cellOf(e.x, e.y, n);
  for (let i = 0; i < VISION_EVERY; i++) g.step();
  const pb = s.acquire(blue, 2, false)!, pr = s.acquire(red, 2, false)!;
  expect(pb.seq).toBe(pr.seq);
  expect(pb.x + pr.x).toBe(n);
});

it('mirrored craters start their magma floods at mirrored cells', () => {
  const g = createGame({ seed: 5 });
  const s = g.sim;
  const n = s.size;
  const crater = [cellOf(12.5, 20.5, n), cellOf(13.5, 20.5, n), cellOf(12.5, 21.5, n)];
  const mirrored = crater.map((c) => n * n - 1 - c).sort((a, b) => a - b);
  s.magma.fill(0);
  for (const c of crater) s.magma[c] = 101;
  for (const c of mirrored) s.magma[c] = 102;
  s.openCells(crater, HOLE.crater, BLUE);
  s.openCells(mirrored, HOLE.crater, RED);
  const [a, b] = s.floods;
  expect(a!.origin + b!.origin).toBe(n * n - 1);
});

it('emerging beside a hole picks mirrored spots although x + 0.8 and its mirror round differently', () => {
  const g = createGame({ seed: 3, options: { terrain: 'open' } });
  const s = g.sim;
  const n = s.size;
  s.block.fill(0);
  s.surfaceBodies.fill(0);
  // A 3×3 blocked patch around the arrival point: cells (13, 22) and (11, 24) tie for nearest open ground.
  for (let y = 23; y <= 25; y++) for (let x = 12; x <= 14; x++) {
    const c = cellOf(x + 0.5, y + 0.5, n);
    s.block[c] = 1;
    s.block[n * n - 1 - c] = 1;
  }
  const hx = 12.5, hy = 23.5;
  const blue = s.openSurfaceNear(hx + 0.8, hy + 0.8, 4, BLUE)!;
  const red = s.openSurfaceNear(n - hx - 0.8, n - hy - 0.8, 4, RED)!;
  expect(blue.x + red.x).toBe(n);
  expect(blue.y + red.y).toBe(n);
});
