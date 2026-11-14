/** Surface terrain: presets (point-symmetric, connected), line of sight, forests, high ground. */
import { describe, expect, it } from 'vitest';
import { ECON, STATS, SURFACE, TERRAIN_PRESETS, isSurfaceHigh, surfaceFeature, packTerrain, toTicks, unpackTerrain, DEFAULT_RULES, spirePositions, type Plane, type ArmyId, type TerrainPreset, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { generateTerrain, generateWorld } from '../src/maps/world.ts';
import { mirrorCell } from '../src/util/grid.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { Rng } from '../src/util/rng.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

/** Spire centres under the default rules (every match here uses them). */
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);

/** Cells of the default-size maps every fixture here runs on. */
const N = DEFAULT_RULES.map.size * DEFAULT_RULES.map.size;
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const cx = (c: number): number => (c % DEFAULT_RULES.map.size) + 0.5;
const cy = (c: number): number => Math.floor(c / DEFAULT_RULES.map.size) + 0.5;
const cellDist = (a: number, b: number): number => Math.hypot(cx(a) - cx(b), cy(a) - cy(b));
/** Distance from a cell centre to the nearer Spire. */
const spireDist = (c: number): number => Math.min(...[DEFAULT_SPIRES.nw, DEFAULT_SPIRES.se].map((p) => Math.hypot(cx(c) - p.x, cy(c) - p.y)));
/** Far enough from both Spires that neither shoots nor sees it. */
const wild = (c: number): boolean => spireDist(c) > 12;

/** Only the Spires and islands left; `units` are placed by hand. */
function arena(seed: number, terrain: TerrainPreset): AgentCommandGame {
  const g = createGame({ seed, options: { terrain } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, c: number, stance: 'hold' | 'aggressive' = 'hold'): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, STATS[kind].plane);
  e.x = cx(c);
  e.y = cy(c);
  act(g, team, e.plane, { kind: 'stance', units: [id(g, team, e)], stance });
  return e;
}
/** First (seed, cell pair) on a preset that satisfies `pick`; the map search keeps these tests honest on real terrain. */
function find(preset: TerrainPreset, pick: (g: AgentCommandGame) => [number, number] | null): { g: AgentCommandGame; a: number; b: number } {
  for (let seed = 1; seed < 60; seed++) {
    const g = arena(seed, preset);
    const hit = pick(g);
    if (hit) return { g, a: hit[0], b: hit[1] };
  }
  throw new Error(`no ${preset} map with the wanted feature`);
}
const shots = (g: AgentCommandGame, side: ArmyId, ticks: number): number => {
  let n = 0;
  for (let i = 0; i < ticks; i++) {
    g.step();
    n += g.sim.fx.filter((r) => r.fx.tick === g.tick && r.fx.kind === 'shot' && r.fx.side === slotOfArmyId(side, 2)).length;
  }
  return n;
};

describe('terrain presets', () => {
  const seeds = [1, 2, 3, 17, 99, 2048, 12345, 424242];

  it('are point-symmetric, keep the bases clear, and leave one connected walkable region', () => {
    for (const preset of TERRAIN_PRESETS) {
      let blockers = 0;
      for (const seed of seeds) {
        const base = generateTerrain(seed, preset, DEFAULT_RULES.map, 2);
        expect(base.faults).toEqual([]);
        const { terrain, faults, size } = generateWorld(seed, base, DEFAULT_RULES.map, 2, seed);
        for (let c = 0; c < N; c++) {
          expect(terrain[c]).toBe(terrain[mirrorCell(c, size)]);
          if (terrain[c] === SURFACE.cliff || surfaceFeature(terrain[c]!) === SURFACE.water) blockers++;
          if (spireDist(c) <= 6) expect(terrain[c]).toBe(SURFACE.ground);
        }
        const seen = new Uint8Array(N);
        const start = Math.floor(DEFAULT_SPIRES.nw.y) * size + Math.floor(DEFAULT_SPIRES.nw.x);
        const queue = [start];
        seen[start] = 1;
        for (let i = 0; i < queue.length; i++) {
          const c = queue[i]!;
          const x = c % size;
          for (const n of [x < size - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + size, c - size]) {
            if (n < 0 || n >= N || seen[n] || terrain[n] === SURFACE.cliff || surfaceFeature(terrain[n]!) === SURFACE.water) continue;
            seen[n] = 1;
            queue.push(n);
          }
        }
        for (let c = 0; c < N; c++) expect(seen[c] === 1, `${preset} seed ${seed}: cell ${c % size},${Math.floor(c / size)} walkable but cut off`).toBe(terrain[c] !== SURFACE.cliff && surfaceFeature(terrain[c]!) !== SURFACE.water);
        // 3–4 public fault lines on open ground, as mirrored pairs (or self-mirrored through the centre).
        expect(faults.length).toBeGreaterThanOrEqual(3);
        expect(faults.length).toBeLessThanOrEqual(4);
        const all = new Set(faults.flat());
        for (const f of faults) {
          f.forEach((c, i) => {
            expect(surfaceFeature(terrain[c]!)).toBe(SURFACE.fault);
            expect(all.has(mirrorCell(c, size))).toBe(true);
            if (i > 0) expect(Math.max(Math.abs((c % size) - (f[i - 1]! % size)), Math.abs(Math.floor(c / size) - Math.floor(f[i - 1]! / size)))).toBe(1);
          });
        }
        const codes = new Set(terrain);
        if (!['archipelago', 'rivers'].includes(preset)) expect(codes.has(SURFACE.high)).toBe(true);
        if (!['chokepoint', 'fortress'].includes(preset)) expect(codes.has(SURFACE.forest)).toBe(true);
        if (preset === 'archipelago' || preset === 'rivers') {
          expect(codes.has(SURFACE.water)).toBe(true);
          expect(codes.has(SURFACE.ford)).toBe(true);
        }
        // The packed form round-trips (observations and views carry it).
        expect([...unpackTerrain(packTerrain(terrain), size)]).toEqual([...terrain]);
      }
      if (preset === 'open') expect(blockers).toBe(0);
      else expect(blockers).toBeGreaterThan(seeds.length * 20);
    }
  });

  it('are what the match runs on, and what separate match data and view snapshots carry', () => {
    const g = createGame({ seed: 17, options: { terrain: 'canyons' } });
    expect(g.sim.preset).toBe('canyons');
    // Lode site preparation is part of the authoritative terrain, after the preset's base terrain stage.
    const world = generateWorld(17, generateTerrain(17, 'canyons', DEFAULT_RULES.map, 2), DEFAULT_RULES.map, 2, 17);
    expect([...g.sim.terrain]).toEqual([...world.terrain]);
    const obs = g.observe({ team: 'se', role: 'surface' }, 0);
    const matchData = g.matchData({ team: 'se', role: 'surface' });
    expect(matchData.preset).toBe('canyons');
    expect([...unpackTerrain(matchData.terrain, g.sim.size)]).toEqual([...g.sim.terrain]);
    expect(matchData.faults.map((f) => f.cells.map((p) => p.y * g.sim.size + p.x))).toEqual(g.sim.faults);
    // Agent observations are dynamic from their first call; only views carry snapshot match data.
    expect(obs).not.toHaveProperty('match');
    expect(obs.rulesHash).toBe(matchData.rulesHash);
    expect(g.view('nw').match).toEqual(matchData);
    expect(g.view('nw').match).toBeUndefined();
    expect(g.view('nw', { snapshot: true }).match).toEqual(matchData);
    expect(g.view('nw').rulesHash).toBe(obs.rulesHash);
    expect(createGame({ seed: 17 }).sim.preset).toBe('ridges');
  });
});

describe('line of sight', () => {
  it('row-span stamping matches individual sight queries inside and beyond the cached window', () => {
    for (const terrain of TERRAIN_PRESETS) {
      const s = createGame({ seed: 3, options: { terrain } }).sim;
      const stamped = new Uint8Array(N);
      const expected = new Uint8Array(N);
      for (const from of [0, s.size - 1, N - s.size, N - 1, 20 * s.size + 20, 24 * s.size + 24]) {
        for (const width of [0, 6, 12, 18]) {
          // Existing visibility must be preserved, including high ground revealed by another observer.
          for (let c = 0; c < N; c++) stamped[c] = expected[c] = c % 7 === 0 ? 1 : 0;
          const fx = from % s.size;
          const fy = Math.floor(from / s.size);
          for (let y = Math.max(0, fy - width); y <= Math.min(s.size - 1, fy + width); y++) {
            const start = y * s.size + Math.max(0, fx - width);
            const end = y * s.size + Math.min(s.size - 1, fx + width);
            s.los.stamp(stamped, s.terrain, from, start, end, 1);
            for (let c = start; c <= end; c++) {
              if (!expected[c] && !isSurfaceHigh(s.terrain[c]!) && s.los.visible(from, c)) expected[c] = 1;
            }
          }
          expect(stamped).toEqual(expected);
        }
      }
    }
  });

  it('is symmetric both ways and under the map mirror', () => {
    const g = createGame({ seed: 3, options: { terrain: 'canyons' } });
    const los = g.sim.los;
    const rng = new Rng(7);
    let blocked = 0;
    for (let i = 0; i < 4000; i++) {
      const a = rng.int(N);
      const b = Math.min(N - 1, Math.max(0, a + (rng.int(25) - 12) + (rng.int(25) - 12) * g.sim.size));
      const v = los.visible(a, b);
      expect(los.visible(b, a)).toBe(v);
      expect(los.visible(mirrorCell(a, g.sim.size), mirrorCell(b, g.sim.size))).toBe(v);
      if (!v) blocked++;
    }
    expect(blocked).toBeGreaterThan(100);
  });

  it('cliffs block sight, direct fire and movement; around the cliff the same units fight', () => {
    const { g, a, b } = find('ridges', (g) => {
      const t = g.sim.terrain;
      for (let c = 2 * g.sim.size; c < N - 2 * g.sim.size; c++) {
        const x = c % g.sim.size;
        if (x < 3 || x > g.sim.size - 4 || !wild(c) || t[c] !== SURFACE.cliff) continue;
        const row = [c - 2, c - 1, c + 1, c + 2];
        if (row.every((n) => t[n] === SURFACE.ground) && !g.sim.los.visible(c - 2, c + 2)) return [c - 2, c + 2];
      }
      return null;
    });
    const s = g.sim;
    const tank = put(g, 'nw', 'tank', a);
    const foe = put(g, 'se', 'trooper', b);
    foe.hp = 1e6;
    expect(shots(g, 'nw', toTicks(3)) + shots(g, 'se', toTicks(1))).toBe(0);
    expect(s.sees(slotOfArmyId('nw', 2), foe)).toBe(false);
    expect(s.sees(slotOfArmyId('se', 2), tank)).toBe(false);
    expect(s.block[a + 2]).toBe(1);
    // The same distance with a clear line: the tank sees the trooper and fires.
    const clear = [a - 4 * s.size, a + 4 * s.size, a - 4].find((c) => c >= 0 && c < N && s.terrain[c] === SURFACE.ground && s.los.visible(a, c));
    expect(clear).toBeDefined();
    foe.x = cx(clear!);
    foe.y = cy(clear!);
    expect(shots(g, 'nw', toTicks(3))).toBeGreaterThan(0);
    expect(s.sees(slotOfArmyId('nw', 2), foe)).toBe(true);
    // Walking to the far side goes around the cliff, never through it.
    tank.hp = 1e6;
    expect(act(g, 'nw', 'surface', { kind: 'move', units: [id(g, 'nw', tank)], x: cx(b), y: cy(b), mode: 'move' })).toEqual({ ok: true });
    for (let i = 0; i < toTicks(60) && Math.hypot(tank.x - cx(b), tank.y - cy(b)) > 0.05; i++) {
      g.step();
      expect(s.block[Math.floor(tank.y) * s.size + Math.floor(tank.x)]).toBe(0);
    }
    expect(Math.hypot(tank.x - cx(b), tank.y - cy(b))).toBeLessThan(0.05);
  });
});

describe('forests', () => {
  it('slow units and hide them: the hidden side shoots first, until an enemy comes within 2 tiles (or a scan)', () => {
    const { g, a: wood, b: field } = find('open', (g) => {
      const t = g.sim.terrain;
      for (let f = 0; f < N; f++) {
        if (t[f] !== SURFACE.forest || !wild(f)) continue;
        for (let c = 0; c < N; c++) {
          const d = cellDist(f, c);
          if (t[c] === SURFACE.ground && wild(c) && d >= 3 && d <= 3.6) return [f, c];
        }
      }
      return null;
    });
    const s = g.sim;
    const hidden = put(g, 'se', 'trooper', wood);
    const scout = put(g, 'nw', 'trooper', field);
    hidden.hp = scout.hp = 1e6;
    expect(s.speedOf(hidden)).toBeCloseTo(s.baseSpeed(hidden) * ECON.forestSpeed, 9);
    expect(s.speedOf(scout)).toBeCloseTo(s.baseSpeed(scout), 9);
    const blueShots = shots(g, 'nw', toTicks(3));
    expect(s.sees(slotOfArmyId('nw', 2), hidden)).toBe(false);
    expect(s.sees(slotOfArmyId('se', 2), scout)).toBe(true);
    expect(blueShots).toBe(0);
    expect(shots(g, 'se', toTicks(2))).toBeGreaterThan(0);
    expect(scout.hp).toBeLessThan(1e6);
    // Blue's view shows the incoming fire at its trooper, never the hidden shooter.
    const view = g.view('nw');
    expect(view.entities.some((e) => s.aliasTarget(slotOfArmyId('nw', 2), Number(e.id.slice(2))) === hidden.id)).toBe(false);
    for (const f of view.fx) if (f.kind === 'shot') expect(Math.hypot(f.x - hidden.x, f.y - hidden.y)).toBeGreaterThan(1);
    // Walking up to the forest edge spots it.
    scout.x = hidden.x + 1.2;
    scout.y = hidden.y;
    steps(g, VISION_EVERY);
    expect(s.sees(slotOfArmyId('nw', 2), hidden)).toBe(true);
    // An orbital scan spots it from afar as well.
    scout.x = cx(field);
    scout.y = cy(field);
    steps(g, VISION_EVERY);
    expect(s.sees(slotOfArmyId('nw', 2), hidden)).toBe(false);
    expect(act(g, 'nw', 'orbit', { kind: 'scan', x: hidden.x, y: hidden.y })).toEqual({ ok: true });
    expect(s.sees(slotOfArmyId('nw', 2), hidden)).toBe(true);
  });
});

describe('high ground', () => {
  it('+1 range and +2 vision, sees over cliffs, and stays invisible from low ground unless a scan looks', () => {
    const { g, a: hill, b: low } = find('ridges', (g) => {
      const t = g.sim.terrain;
      for (let h = 0; h < N; h++) {
        if (!isSurfaceHigh(t[h]!) || !wild(h)) continue;
        for (let c = 0; c < N; c++) {
          const d = cellDist(h, c);
          if (t[c] === SURFACE.ground && wild(c) && d >= 6.9 && d <= 7.2 && !g.sim.los.visible(h, c)) return [h, c];
        }
      }
      return null;
    });
    const s = g.sim;
    const top = put(g, 'se', 'tank', hill);
    const below = put(g, 'nw', 'tank', low);
    top.hp = below.hp = 1e6;
    expect(s.onHigh(top)).toBe(true);
    expect(s.reach(top, below)).toBeCloseTo(STATS.tank.range + ECON.highRange + below.radius, 9);
    const fromBelow = shots(g, 'nw', toTicks(4));
    expect(fromBelow).toBe(0);
    expect(s.sees(slotOfArmyId('nw', 2), top)).toBe(false);
    expect(s.sees(slotOfArmyId('se', 2), below)).toBe(true);
    expect(below.hp).toBeLessThan(1e6);
    expect(top.hp).toBe(1e6);
    expect(act(g, 'nw', 'orbit', { kind: 'scan', x: top.x, y: top.y })).toEqual({ ok: true });
    expect(s.sees(slotOfArmyId('nw', 2), top)).toBe(true);
  });

  it('never leaks to low ground: over seeds × presets, no high cell is in the vision of a team standing only on low ground', () => {
    // Archipelago and rivers are water templates without high ground (see the preset surface-code test).
    for (const preset of TERRAIN_PRESETS.filter((p) => p !== 'archipelago' && p !== 'rivers')) {
      for (const seed of [4, 8, 15]) {
        const g = arena(seed, preset);
        const s = g.sim;
        const rng = new Rng(seed * 31 + preset.length);
        const high: number[] = [];
        for (let c = 0; c < N; c++) if (isSurfaceHigh(s.terrain[c]!)) high.push(c);
        expect(high.length).toBeGreaterThan(0);
        // Low-ground viewers (on hold, so nobody wanders uphill) all over the map and right below plateau rims.
        const spots: number[] = [];
        while (spots.length < 24) {
          const c = rng.int(N);
          if (!s.block[c] && !isSurfaceHigh(s.terrain[c]!)) spots.push(c);
        }
        for (const h of high.slice(0, 6)) {
          const below = [h - 2, h + 2, h - 2 * s.size, h + 2 * s.size].find((c) => c >= 0 && c < N && !s.block[c] && !isSurfaceHigh(s.terrain[c]!));
          if (below !== undefined) spots.push(below);
        }
        spots.forEach((c, i) => put(g, 'nw', i % 3 ? 'trooper' : 'tank', c));
        steps(g, VISION_EVERY);
        const vis = s.vis[1]!;
        const bit = s.armies[slotOfArmyId('nw', 2)]!.group.bit;
        for (const c of high) expect(vis[c]! & bit, `${preset} seed ${seed}: high cell ${c % s.size},${Math.floor(c / s.size)} seen from low ground`).toBe(0);
        // One unit up there sees the high ground around it (vision + 2).
        put(g, 'nw', 'trooper', high[0]!);
        steps(g, VISION_EVERY);
        for (const c of high) if (cellDist(c, high[0]!) <= STATS.trooper.vision + ECON.highVision - 0.8) expect(vis[c]! & bit).toBe(bit);
      }
    }
  });
});
