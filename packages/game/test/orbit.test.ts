/**
 * Rotated-script harness (DESIGN §15.4): one canonical intent script per role is applied to every army
 * through its frame on the same tick, and the orbit of the layout's rotation group is checked every tick
 * (test/mirror.ts `orbitAsymmetry`). Four armies on the C4 `four_corners` map must stay an exact orbit of 4.
 */
import { describe, expect, it } from 'vitest';
import { applyIntent, type GameIntent } from '../src/agent/intents.ts';
import { observe } from '../src/agent/present.ts';
import { namedMap } from '../src/maps/maps.ts';
import { CELL, type Kind, type MatchOptions, OBS_GRID, PLANES, type Plane } from '../src/rules/contract.ts';
import { Sim } from '../src/sim/sim.ts';
import type { Ent } from '../src/sim/ent.ts';
import { gridPosition } from '../src/util/math.ts';
import { type Army, canonCell, NEUTRAL, rotCell, rotX, rotY } from '../src/util/teams.ts';
import { orbitAsymmetry, rotationGroup } from './mirror.ts';

/** What a canonical (slot-0 frame) script sees of one army: its frame and its entities by kind in serial order. */
interface Frame {
  army: Army;
  sim: Sim;
  /** a canonical point in this army's frame */
  x(x: number, y: number): number;
  y(x: number, y: number): number;
  /** a canonical cell in this army's frame, as cell coordinates */
  cx(x: number, y: number): number;
  cy(x: number, y: number): number;
  /** own entity ids (`e_<id>`) of these kinds, serial order: twins line up across armies */
  units(...kinds: Kind[]): string[];
}

type Step = (f: Frame) => { role: Plane; intent: GameIntent }[];
type Script = Map<number, Step>;

function frameOf(sim: Sim, army: Army): Frame {
  const k = sim.armyFrame[army]!;
  const size = sim.size;
  return {
    army, sim,
    x: (x, y) => rotX(k, x, y, size),
    y: (x, y) => rotY(k, x, y, size),
    cx: (x, y) => rotCell(k, y * size + x, size) % size,
    cy: (x, y) => Math.floor(rotCell(k, y * size + x, size) / size),
    units: (...kinds) => sim.ents.filter((e) => !e.dead && e.side === army && kinds.includes(e.kind)).sort((a, b) => a.seq - b.seq).map((e) => `e_${e.id}`),
  };
}

/**
 * Run `ticks` ticks of `script`, checking the orbit every tick; every army's intents must get the same results,
 * returned per scripted tick so a test can require that its orders really landed.
 */
function run(sim: Sim, script: Script, ticks: number): Map<number, string[]> {
  const landed = new Map<number, string[]>();
  expect(rotationGroup(sim)).toEqual(sim.sides === 4 && sim.allArmies.length === 4 ? [0, 1, 2, 3] : [0, 2]);
  for (let t = 0; t < ticks && !sim.over; t++) {
    const step = script.get(sim.tick);
    if (step) {
      const plans = sim.allArmies.map((a) => step(frameOf(sim, a)));
      const results: string[][] = sim.allArmies.map(() => []);
      sim.round(() => {
        for (const a of sim.allArmies) for (const { role, intent } of plans[a]!) results[a]!.push(JSON.stringify(applyIntent(sim, a, role, intent)));
      });
      for (const a of sim.allArmies) expect(results[a], `tick ${sim.tick} army ${a} intent results`).toEqual(results[0]);
      landed.set(sim.tick, results[0]!);
      if (process.env.ORBIT_DEBUG) console.log(sim.tick, results[0]!.join(' '));
    }
    sim.step();
    const first = orbitAsymmetry(sim);
    if (first) throw new Error(first);
  }
  if (process.env.ORBIT_DEBUG) {
    const t = sim.armies[0]!;
    console.log(`end tick ${sim.tick} over ${sim.over} stats ${JSON.stringify(t.stats)} alloy ${t.alloy} pop ${t.pop} ents ${sim.ents.length} holes ${sim.holes.filter(Boolean).length} storms ${sim.weather.data.storms.length} asteroids ${sim.ents.filter((e) => e.kind === 'asteroid').length} held ${sim.ents.filter((e) => e.kind === 'island' && e.side !== 4).length} charges ${sim.charges.length} floods ${sim.floods.length}`);
  }
  return landed;
}

const fourCorners = (options: MatchOptions = {}, seed = 3): Sim => new Sim(seed, options, namedMap('four_corners')!);
/** Remove every unit (keeps Spires and neutral bodies) so a scenario starts from a known board. */
function clearUnits(sim: Sim): void {
  for (const e of sim.ents) if (e.unit) e.dead = true;
  sim.ents = sim.ents.filter((e) => !e.dead);
  for (const t of sim.armies) t.pop = 0;
}
/** Spawn the same canonical unit for every army, turned into its frame. */
function spawnAll(sim: Sim, kind: Kind, plane: Plane, x: number, y: number): Ent[] {
  return sim.allArmies.map((a) => {
    const k = sim.armyFrame[a]!;
    const e = sim.add(kind, a, plane, rotX(k, x, y, sim.size), rotY(k, x, y, sim.size));
    sim.armies[a]!.pop++;
    return e;
  });
}

describe('four armies on four_corners stay an exact orbit of 4', () => {
  it('the start is an exact orbit and every army is in play', () => {
    const sim = fourCorners();
    expect(sim.allArmies).toEqual([0, 1, 2, 3]);
    expect([...sim.armyFrame.slice(0, 4)]).toEqual([0, 1, 2, 3]);
    expect(orbitAsymmetry(sim)).toBeUndefined();
    // Every army knows its own home cavern: the rotated cells of slot 0's.
    const k0 = sim.armies[0]!.group.known;
    for (const a of [1, 2, 3]) for (let c = 0; c < sim.n; c++) expect(sim.armies[a]!.group.known[rotCell(sim.armyFrame[a]!, c, sim.size)]).toBe(k0[c]);
  });

  it('explicit mining latches and resource depletion rotate through every quarter-turn', () => {
    const sim = fourCorners({ orbit: { maxAsteroids: 0, derelictEnabled: false }, spire: { dmg: 0 } });
    clearUnits(sim);
    const tugs = spawnAll(sim, 'tug', 'orbit', 16, 8);
    const rocks = sim.allArmies.map((army) => {
      const rock = sim.add('asteroid', NEUTRAL, 'orbit', rotX(sim.armyFrame[army]!, 16 + sim.econ.tugMineReach, 8, sim.size), rotY(sim.armyFrame[army]!, 16 + sim.econ.tugMineReach, 8, sim.size));
      rock.resourceType = 'metal';
      rock.resourceRemaining = sim.rocks.medium.dockYield.metal.alloy;
      rock.state = 'drifting';
      return rock;
    });
    sim.computeVision();
    for (const army of sim.allArmies) expect(applyIntent(sim, army, 'orbit', {
      kind: 'mine_asteroid', units: [`e_${tugs[army]!.id}`], asteroid: `e_${rocks[army]!.id}`,
    })).toEqual({ ok: true });
    run(sim, new Map(), 40);
    for (const army of sim.allArmies) {
      expect(tugs[army]!.cargoAlloy).toBeCloseTo(4, 8);
      expect(rocks[army]!.resourceRemaining).toBeCloseTo(146, 8);
      expect(rocks[army]!.miningTug).toBe(tugs[army]!.id);
    }
  });

  it('opening economy for three minutes: mining, production, construction, research, islands and the sun', { tags: ['timing'] }, () => {
    const sim = fourCorners();
    const script: Script = new Map<number, Step>([
      [0, (f) => [
        { role: 'depths', intent: { kind: 'macro', action: 'auto_mine' } },
        { role: 'depths', intent: { kind: 'queue_add', item: 'digger', count: 2 } },
        { role: 'surface', intent: { kind: 'queue_add', item: 'tank', count: 2 } },
        { role: 'sky', intent: { kind: 'macro', action: 'recapture' } },
        { role: 'depths', intent: { kind: 'designate', rect: { x0: f.cx(6, 6), y0: f.cy(6, 6), x1: f.cx(9, 8), y1: f.cy(9, 8) }, priority: 1 } },
      ]],
      [400, (f) => [
        { role: 'surface', intent: { kind: 'queue_add', item: 'turret', x: Math.min(f.cx(8, 8), f.cx(8, 8)), y: f.cy(8, 8) } },
        { role: 'surface', intent: { kind: 'move', units: f.units('tank', 'trooper'), x: f.x(16, 16), y: f.y(16, 16), mode: 'fight' } },
        { role: 'orbit', intent: { kind: 'queue_add', item: 'solar' } },
      ]],
      [1200, (f) => [
        { role: 'sky', intent: { kind: 'move', units: f.units('interceptor'), x: f.x(24, 24), y: f.y(24, 24), mode: 'fight' } },
        { role: 'surface', intent: { kind: 'queue_add', item: 'shaft', x: f.cx(10, 4), y: f.cy(10, 4) } },
      ]],
    ]);
    const landed = run(sim, script, 3600);
    // Production orders go through their output role, so this covers real production rather than refusals.
    const ok = JSON.stringify({ ok: true });
    expect(landed.get(0)!.slice(0, 3)).toEqual([ok, ok, ok]);
    expect(landed.get(400)![2]).toBe(ok);
  });

  it('a centre melee with equidistant three-way targets', { tags: ['timing'] }, () => {
    const sim = fourCorners();
    clearUnits(sim);
    for (let i = 0; i < 4; i++) spawnAll(sim, 'tank', 'surface', 24 + i, 26.5);
    for (let i = 0; i < 3; i++) spawnAll(sim, 'trooper', 'surface', 26.5, 24 + i);
    for (let i = 0; i < 3; i++) spawnAll(sim, 'interceptor', 'sky', 25 + i, 25);
    const script: Script = new Map<number, Step>([
      [0, (f) => [
        { role: 'surface', intent: { kind: 'move', units: f.units('tank', 'trooper'), x: f.x(32, 32), y: f.y(32, 32), mode: 'fight' } },
        { role: 'sky', intent: { kind: 'move', units: f.units('interceptor'), x: f.x(32, 32), y: f.y(32, 32), mode: 'fight' } },
      ]],
    ]);
    run(sim, script, 900);
    // Somebody fought: equal losses all round.
    expect(sim.armies.map((t) => t.stats.unitsLost)).toEqual(sim.armies.map(() => sim.armies[0]!.stats.unitsLost));
  });

  it('armies shooting one target on the same tick: no army sees another\'s shot in flight, hits land in relative order', () => {
    const sim = fourCorners();
    clearUnits(sim);
    // A pinwheel round the centre: each army's two riflemen stand equidistant from both neighbours' one-shot troopers.
    // Armies are made one after the other (as at a match start), so the entity order runs army by army: army 0's
    // second rifleman finds its neighbour's trooper doomed by its own first shot and turns to the other neighbour's,
    // which army 2 is about to shoot too. Overkill prevention counting army 0's same-tick shot sent army 2 elsewhere,
    // and the killing blow on a trooper two armies shot went to whichever fired later in the entity order.
    for (const a of sim.allArmies) {
      const k = sim.armyFrame[a]!;
      for (const [x, y, hp] of [[30, 30, 100], [29.5, 29.5, 100], [31, 31, 1]] as const) {
        sim.add('trooper', a, 'surface', rotX(k, x, y, sim.size), rotY(k, x, y, sim.size)).hp = hp;
        sim.armies[a]!.pop++;
      }
    }
    sim.computeVision();
    run(sim, new Map(), 60);
    expect(sim.armies[0]!.stats.unitsLost).toBeGreaterThan(0);
    for (const stat of ['unitsLost', 'kills'] as const) expect(sim.armies.map((t) => t.stats[stat])).toEqual(sim.armies.map(() => sim.armies[0]!.stats[stat]));
  });

  it('observations present rotated twins as exact rotations: binary grid, ties to even, never on a cell edge', () => {
    const sim = fourCorners();
    clearUnits(sim);
    // An off-grid point, an eighth-tile tie, a point a 2-decimal presentation turned apart on this 64-tile map
    // (64 − 10.77 ≠ 53.23 in binary floats; on the generated S48 map a bot's distance to a post came out 0.5 ± 1 ulp
    // for rotated twins, so half the armies moved), and points that round onto and sit exactly on a cell edge (floor
    // of an edge names different cells for rotated twins: a digger at x = 20 counted as off a reachable pocket).
    const points = [[10.7712, 14.4812], [20.0625, 9.1875], [31.37, 28.903], [19.97, 30.02], [24, 9.5]] as const;
    for (const [x, y] of points) spawnAll(sim, 'trooper', 'surface', x, y);
    sim.computeVision();
    const seen = sim.allArmies.map((a) => {
      const obs = observe(sim, sim.armyIds[a]!, 'surface', -1, PLANES);
      return obs.entities.filter((e) => e.side === obs.army && e.kind === 'trooper');
    });
    expect(seen[0]!.length).toBe(points.length);
    for (const a of sim.allArmies) {
      const k = sim.armyFrame[a]!;
      seen[a]!.forEach((e, i) => {
        const twin = seen[0]![i]!;
        expect([e.x * OBS_GRID % 1, e.y * OBS_GRID % 1], `${e.kind} on the grid`).toEqual([0, 0]);
        expect([e.x % 1, e.y % 1], `${e.kind} off cell edges`).not.toContain(0);
        expect([e.x, e.y], `army ${a} ${e.kind}`).toEqual([rotX(k, twin.x, twin.y, sim.size), rotY(k, twin.x, twin.y, sim.size)]);
      });
    }
    expect([seen[0]![3]!.x, seen[0]![4]!.x]).toEqual([19.875, 24.125]);
    for (let v = 0; v <= sim.size; v += 1 / 256) {
      expect(gridPosition(sim.size - v, OBS_GRID, sim.size)).toBe(sim.size - gridPosition(v, OBS_GRID, sim.size));
      if (v !== sim.size / 2) expect(gridPosition(v, OBS_GRID, sim.size) % 1).not.toBe(0);
    }
  });

  it('dig contests on sector seams and at the centre', { tags: ['timing'] }, () => {
    const sim = fourCorners();
    clearUnits(sim);
    // Each army digs a cell X next to its neighbour's seam and the cell its clockwise neighbour digs, so adjacent
    // armies contest the same cells (army a digs X_a and turned X_(a−1)).
    for (let i = 0; i < 2; i++) spawnAll(sim, 'digger', 'depths', 30.5, 3.5);
    for (let i = 0; i < 2; i++) spawnAll(sim, 'digger', 'depths', 31.5, 30.5);
    const size = sim.size;
    const script: Script = new Map<number, Step>([
      [0, (f) => {
        const diggers = f.units('digger');
        const seam = { x: 32, y: 3 };
        // The same world cell turned back one slot: the anticlockwise neighbour's canonical seam cell.
        const back = rotCell(3, seam.y * size + seam.x, size);
        return [
          { role: 'depths', intent: { kind: 'dig', units: [diggers[0]!], x: f.cx(seam.x, seam.y), y: f.cy(seam.x, seam.y) } },
          { role: 'depths', intent: { kind: 'dig', units: [diggers[1]!], x: f.cx(back % size, Math.floor(back / size)), y: f.cy(back % size, Math.floor(back / size)) } },
          { role: 'depths', intent: { kind: 'dig', units: diggers.slice(2), x: f.cx(31, 31), y: f.cy(31, 31) } },
        ];
      }],
    ]);
    run(sim, script, 900);
    // The contested cells opened and each went to exactly one army, turned consistently.
    const c = 3 * size + 32;
    expect(sim.cells[c]).toBe(CELL.tunnel);
    for (const a of [1, 2, 3]) expect(sim.owner[rotCell(sim.armyFrame[a]!, c, size)]! - 1).toBe((sim.owner[c]! - 1 + a) % 4);
  });

  it('asteroid orbits: natural spawns, metal rocks deorbited onto sector seams and towed volatile rocks detonating', { tags: ['timing'] }, () => {
    const sim = fourCorners();
    // One extra orbit of each volatility beside every army's tugs (neutral serials stay in whole orbits of 4).
    expect(sim.seqs[NEUTRAL]! % 4).toBe(0);
    spawnAll(sim, 'tug', 'orbit', 28, 8);
    for (const volatile of [false, true]) {
      for (const a of sim.allArmies) {
        const k = sim.armyFrame[a]!;
        const [x, y] = !volatile ? [29, 8] : [10, 7];
        const rock = sim.add('asteroid', NEUTRAL, 'orbit', rotX(k, x, y, sim.size), rotY(k, x, y, sim.size));
        rock.resourceType = 'metal';
        rock.volatile = volatile;
        rock.resourceRemaining = sim.rocks.medium.dockYield.metal.alloy;
        rock.state = 'drifting';
      }
    }
    sim.computeVision();
    const rock = (f: Frame, volatile: boolean): string => {
      const k = f.sim.armyFrame[f.army]!;
      const [x, y] = !volatile ? [29, 8] : [10, 7];
      const e = f.sim.ents.find((r) => r.kind === 'asteroid' && r.volatile === volatile && r.x === rotX(k, x, y, f.sim.size) && r.y === rotY(k, x, y, f.sim.size))!;
      return `e_${e.id}`;
    };
    const script: Script = new Map<number, Step>([
      [0, (f) => [
        { role: 'orbit', intent: { kind: 'grapple', units: [f.units('tug')[1]!], asteroid: rock(f, false) } },
        { role: 'orbit', intent: { kind: 'grapple', units: [f.units('tug')[0]!], asteroid: rock(f, true) } },
      ]],
      // Onto the seam between this army's sector and its clockwise neighbour's.
      [200, (f) => [{ role: 'orbit', intent: { kind: 'deorbit', units: [f.units('tug')[1]!], x: f.x(32, 10), y: f.y(32, 10) } }]],
    ]);
    // Natural spawns keep drifting in: the tugs then take the nearest visible one, ties in their own frame.
    for (let t = 900; t < 3000; t += 300) {
      script.set(t, (f) => {
        const k = f.sim.armyFrame[f.army]!;
        let best: Ent | undefined;
        let bd = Infinity;
        for (const r of f.sim.ents) {
          if (r.kind !== 'asteroid' || r.dead || r.state !== 'drifting' || !f.sim.sees(f.army, r)) continue;
          const d = (r.x - f.x(20, 20)) ** 2 + (r.y - f.y(20, 20)) ** 2;
          if (d < bd || (d === bd && best && canonCell(k, Math.floor(r.y) * f.sim.size + Math.floor(r.x), f.sim.size) < canonCell(k, Math.floor(best.y) * f.sim.size + Math.floor(best.x), f.sim.size))) { bd = d; best = r; }
        }
        const tug = f.units('tug')[0];
        if (!tug) return [];
        const out: { role: Plane; intent: GameIntent }[] = [{ role: 'orbit', intent: { kind: 'deorbit', units: [tug], x: f.x(20, 32), y: f.y(20, 32) } }];
        if (best) out.push({ role: 'orbit', intent: { kind: 'grapple', units: [tug], asteroid: `e_${best.id}` } });
        return out;
      });
    }
    run(sim, script, 3200);
    expect(sim.armies[0]!.events.some((e) => e.kind === 'volatile_detonation')).toBe(true);
    expect(sim.armies[0]!.stats.impacts).toBeGreaterThan(0);
    expect(sim.holes.some((h) => h !== 0)).toBe(true);
  });

  it('storms, fog banks, jets and the four-wedge sun keep the orbit', { tags: ['timing'] }, () => {
    const sim = fourCorners({ sky: { stormEvery: 30 } } as MatchOptions);
    expect(sim.sunWedges).toBe(4);
    const script: Script = new Map<number, Step>([
      [0, (f) => [
        { role: 'sky', intent: { kind: 'move', units: f.units('interceptor'), x: f.x(20, 26), y: f.y(20, 26), mode: 'move' } },
        { role: 'orbit', intent: { kind: 'move', units: f.units('solar', 'tug'), x: f.x(22, 30), y: f.y(22, 30), mode: 'move' } },
      ]],
      [1500, (f) => [{ role: 'sky', intent: { kind: 'move', units: f.units('interceptor'), x: f.x(30, 14), y: f.y(30, 14), mode: 'move' } }]],
    ]);
    run(sim, script, 4000);
  });

  it('bulkheads, sappers and collapses, and a magma flood', { tags: ['timing'] }, () => {
    const sim = fourCorners();
    clearUnits(sim);
    for (let i = 0; i < 2; i++) spawnAll(sim, 'digger', 'depths', 20.5, 3.5);
    spawnAll(sim, 'sapper', 'depths', 21.5, 3.5);
    for (let i = 0; i < 2; i++) spawnAll(sim, 'digger', 'depths', 31.5, 11.5);
    // A hidden magma pocket orbit (ids as the document numbers rotated pockets: one per slot).
    for (const r of [0, 1, 2, 3]) for (const [x, y] of [[29, 12], [28, 12]] as const) sim.magma[rotCell(r, y * sim.size + x, sim.size)] = r + 1;
    const script: Script = new Map<number, Step>([
      [0, (f) => [
        { role: 'depths', intent: { kind: 'queue_add', item: 'bulkhead', x: f.cx(24, 3), y: f.cy(24, 3) } },
        { role: 'depths', intent: { kind: 'undermine', units: f.units('sapper'), x: f.cx(28, 3), y: f.cy(28, 3) } },
        { role: 'depths', intent: { kind: 'dig', units: f.units('digger').slice(2), x: f.cx(29, 12), y: f.cy(29, 12) } },
      ]],
    ]);
    run(sim, script, 1800);
    const t = sim.armies[0]!;
    expect(t.stats.bulkheads).toBe(1);
    expect(t.stats.collapses).toBe(1);
    expect(t.timeline.some((e) => e.kind === 'magma_flood') || t.events.some((e) => e.kind === 'magma_flood')).toBe(true);
  });

  it('every Surface segment falling on one tick ends the match as a four-way draw with equal ranks', () => {
    const sim = fourCorners();
    for (const t of sim.armies) t.spire.surface.hp = 1;
    run(sim, new Map<number, Step>([[0, () => []]]), 1);
    for (const t of sim.armies) sim.damage(t.spire.surface, 10, 4, true, 'test');
    sim.step();
    expect(sim.result?.outcome).toEqual(['draw', 'draw', 'draw', 'draw']);
    expect(sim.result?.rank).toEqual([1, 1, 1, 1]);
  });
});

describe('fog per vision group with four armies', () => {
  it('hidden state of one army never changes the other groups\' fog state (twin worlds)', () => {
    const plain = fourCorners();
    const twin = fourCorners();
    // Army 2 gets extra bodies deep in its own corner on every plane: nobody else can see or feel them.
    const k = twin.armyFrame[2]!;
    for (const [kind, plane] of [['tank', 'surface'], ['digger', 'depths'], ['interceptor', 'sky'], ['solar', 'orbit']] as const) {
      const e = twin.add(kind, 2, plane, rotX(k, 6, 6, twin.size), rotY(k, 6, 6, twin.size));
      if (plane === 'depths') e.cell = twin.armies[2]!.spire.depths.cell;
    }
    for (let t = 0; t < 200; t++) { plain.step(); twin.step(); }
    for (const g of [0, 1, 3]) {
      const a = plain.groups[g]!, b = twin.groups[g]!;
      for (let p = 0; p < 4; p++) for (let c = 0; c < plain.n; c++) expect(twin.vis[p]![c]! & b.bit, `plane ${p} cell ${c}`).toBe(plain.vis[p]![c]! & a.bit);
      for (let c = 0; c < plain.n; c++) {
        expect(twin.feel[c]! & b.bit).toBe(plain.feel[c]! & a.bit);
        expect(twin.spot[c]! & b.bit).toBe(plain.spot[c]! & a.bit);
      }
      expect(b.known).toEqual(a.known);
      expect(b.pocketKnown).toEqual(a.pocketKnown);
      expect(b.cracks).toEqual(a.cracks);
      expect(b.wallDig).toEqual(a.wallDig);
      expect(b.gateKnown).toEqual(a.gateKnown);
      expect([...b.memory.keys()]).toEqual([...a.memory.keys()]);
      expect(b.seenResearch.map((s) => [...s])).toEqual(a.seenResearch.map((s) => [...s]));
      expect(twin.armies[g]!.events).toEqual(plain.armies[g]!.events);
    }
  });
});
