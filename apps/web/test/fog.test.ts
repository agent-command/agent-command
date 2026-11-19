import { describe, expect, it } from 'vitest';
import { CELL, DEFAULT_RULES, MAX_MAP_SIZE, SURFACE, type DerelictGeometry, type MatchData, type View } from '@agent-command/game/contract';
import { createGame } from '@agent-command/game';
import { FogField } from '../src/world/fog.ts';

const fog = new FogField(DEFAULT_RULES.map.size);
const { visible, explored } = fog;
const ingestVision = fog.ingestVision.bind(fog);
const resetFog = fog.resetFog.bind(fog);
const stepFog = fog.stepFog.bind(fog);
const tileVisible = fog.tileVisible.bind(fog);

/** Encode visible cells with the contract's 30-bit words. */
function words(cells: number[], size = fog.size): number[] {
  const w = new Array<number>(Math.ceil(size * size / 30)).fill(0);
  for (const c of cells) w[Math.floor(c / 30)]! |= 1 << c % 30;
  return w;
}

/** Fake view carrying only `vision`, built from visible cell indices per plane. */
function viewWith(vision: Partial<Record<'depths' | 'surface' | 'sky' | 'orbit', number[]>>, size = fog.size): View {
  return { rulesHash: 0, vision: { depths: words(vision.depths ?? [], size), surface: words(vision.surface ?? [], size), sky: words(vision.sky ?? [], size), orbit: words(vision.orbit ?? [], size) } } as View;
}

describe('fog of war decoding', () => {
  it('maps vision bits to row-major tiles, including word boundaries and the last cell', () => {
    const last = fog.size * fog.size - 1;
    const cells = [0, 29, 30, 59, 60, 8 * fog.size + 8, last];
    ingestVision(viewWith({ surface: cells }));
    for (const c of cells) expect(visible.surface[c]).toBe(1);
    expect(visible.surface.reduce((a, b) => a + b, 0)).toBe(cells.length);
    expect(tileVisible('surface', 8.7, 8.2)).toBe(true);
    expect(tileVisible('surface', 9, 8)).toBe(false);
    expect(tileVisible('surface', fog.size - 0.5, fog.size - 0.5)).toBe(true);
  });

  it('keeps planes independent and treats off-map points as unseen', () => {
    ingestVision(viewWith({ sky: [5], depths: [100] }));
    expect(tileVisible('sky', 5, 0)).toBe(true);
    expect(tileVisible('surface', 5, 0)).toBe(false);
    expect(tileVisible('depths', 100 % fog.size, Math.floor(100 / fog.size))).toBe(true);
    expect(tileVisible('sky', -1, 0)).toBe(false);
    expect(tileVisible('sky', fog.size, 0)).toBe(false);
  });

  it('retains explored cells after vision leaves, independently on every plane', () => {
    ingestVision(viewWith({ surface: [29, 30], sky: [100] }), true);
    stepFog(1);
    ingestVision(viewWith({ surface: [30, fog.size * fog.size - 1] }));
    stepFog(1);
    expect(visible.surface[29]).toBe(0);
    expect(explored.surface[29]).toBe(1);
    expect(explored.surface[30]).toBe(1);
    expect(explored.surface[fog.size * fog.size - 1]).toBe(1);
    expect(explored.surface[31]).toBe(0);
    expect(visible.sky[100]).toBe(0);
    expect(explored.sky[100]).toBe(1);
    expect(explored.depths.some(Boolean)).toBe(false);
  });

  it('resets exploration between matches and restores full lobby visibility', () => {
    ingestVision(viewWith({ surface: [7], orbit: [12] }), true);
    resetFog();
    stepFog(1);
    for (const plane of ['surface', 'depths', 'sky', 'orbit'] as const) {
      expect(visible[plane].every((value) => value === 1)).toBe(true);
      expect(explored[plane].every((value) => value === 1)).toBe(true);
    }
    ingestVision(viewWith({ surface: [8] }), true);
    stepFog(1);
    expect(explored.surface[7]).toBe(0);
    expect(explored.surface[8]).toBe(1);
    expect(explored.orbit[12]).toBe(0);
    expect(visible.surface[7]).toBe(0);
  });
});

describe.each([48, 64, 80])('world-owned fog (%i)', size => {
  it('decodes every plane through the last partial word with independent retained storage', () => {
    const a = new FogField(size), b = new FogField(size);
    const last = size * size - 1;
    const vision = viewWith({ depths: [last], surface: [last], sky: [last], orbit: [last] }, size);
    const arrays = a.planes.surface;
    const { data, cur, target, tex } = arrays;
    a.ingestVision(vision, true);
    a.stepFog(1);
    for (const plane of ['depths', 'surface', 'sky', 'orbit'] as const) {
      expect(a.visible[plane]).toHaveLength(size * size);
      // One fixed-capacity texture serves every size (shared shader nodes); the map fills its top-left texels.
      expect(a.planes[plane].tex.image.width).toBe(MAX_MAP_SIZE);
      expect(a.planes[plane].tex.image.height).toBe(MAX_MAP_SIZE);
      const texel = ((size - 1) * MAX_MAP_SIZE + size - 1) * 4;
      expect(a.planes[plane].data[texel]).toBe(255);
      expect(a.planes[plane].data[texel - 4 * MAX_MAP_SIZE]).toBe(0);
      expect(a.tileVisible(plane, size - 0.5, size - 0.5)).toBe(true);
      expect(a.tileVisible(plane, size, size - 1)).toBe(false);
      expect(a.explored[plane][0]).toBe(0);
      expect(b.explored[plane][0]).toBe(1);
    }
    a.ingestVision(viewWith({}, size));
    a.stepFog(0.1);
    expect(a.explored.surface[last]).toBe(1);
    expect(a.planes.surface.data).toBe(data);
    expect(a.planes.surface.cur).toBe(cur);
    expect(a.planes.surface.target).toBe(target);
    expect(a.planes.surface.tex).toBe(tex);
    expect(a.visible.surface).not.toBe(b.visible.surface);
  });
});

describe('fog shared across map sizes', () => {
  it('keeps one texture and one shader node per plane through size changes, so materials never recompile', () => {
    const fog = new FogField(48);
    const tex = fog.planes.surface.tex;
    const at = fog.fogAt('surface');
    const vis = fog.fogVis('depths');
    for (const size of [80, 64, 48]) {
      fog.setSize(size);
      expect(fog.planes.surface.tex).toBe(tex);
      expect(fog.fogAt('surface')).toBe(at);
      expect(fog.fogVis('depths')).toBe(vis);
      expect(fog.visible.surface).toHaveLength(size * size);
    }
  });
});

describe('fog edge stops at walls (blend classes, DESIGN §7)', () => {
  const game = createGame({ seed: 7 });
  const size = game.sim.size;
  const view = game.view('nw') as View & { match: MatchData };
  const g = view.match.derelict as DerelictGeometry;
  /** Blend class uploaded for cell (x, y) of `plane`. */
  const blendAt = (fog: FogField, plane: 'depths' | 'surface' | 'orbit', x: number, y: number) => fog.planes[plane].data[(y * MAX_MAP_SIZE + x) * 4 + 2];
  const fresh = (tick: number) => {
    const fog = new FogField(size);
    fog.ingestWalls({ ...view, tick });
    fog.ingestVision(view, true);
    // The first step eases to the target, the second finds it settled.
    fog.stepFog(1);
    fog.stepFog(1);
    return fog;
  };

  it('splits the Orbit ruin into outside, hull, corridor, ring and chamber, its breaches and open gates joining them', () => {
    const open = fresh(0);
    const sealed = fresh(g.open + g.turn + 1);
    const cx = Math.floor(g.x), cy = Math.floor(g.y);
    // On the diagonal: solid hull and ring whatever the gates do.
    const diag = (r: number) => Math.floor(g.x - r * Math.SQRT1_2);
    const classes = [g.hullOuter + 1, (g.hullInner + g.hullOuter) / 2, (g.ringOuter + g.hullInner) / 2, (g.ringInner + g.ringOuter) / 2, g.ringInner / 2]
      .map((r) => blendAt(open, 'orbit', diag(r), diag(r)));
    expect(new Set(classes).size).toBe(5);
    // East axis: the breach and the gate are one class with everything while open; the gate shuts with the ring.
    const gate = blendAt(open, 'orbit', cx + Math.floor((g.ringInner + g.ringOuter) / 2), cy);
    const breach = blendAt(open, 'orbit', cx + Math.floor((g.hullInner + g.hullOuter) / 2), cy);
    expect(gate).toBe(breach);
    expect(blendAt(sealed, 'orbit', cx + Math.floor((g.hullInner + g.hullOuter) / 2), cy)).toBe(breach);
    expect(blendAt(sealed, 'orbit', cx + Math.floor((g.ringInner + g.ringOuter) / 2), cy)).toBe(classes[3]);
    // Open, the east axis runs chamber, gate, corridor, breach, outside with no wall class on it: the fog edge joins the
    // chamber to the outside along the gate line, as sight does (DESIGN §4.4). Sealed, the ring cuts it.
    const walls = new Set([classes[1], classes[3]]);
    const axis = (fog: FogField) => Array.from({ length: Math.ceil(g.hullOuter) + 2 }, (_, i) => blendAt(fog, 'orbit', cx + i, cy));
    expect(axis(open).filter((b) => walls.has(b))).toEqual([]);
    expect(axis(open)[0]).toBe(classes[4]);
    expect(axis(open).at(-1)).toBe(classes[0]);
    expect(axis(sealed).filter((b) => walls.has(b)).length).toBeGreaterThan(0);
  });

  it('splits the Depths into tunnel and rock from team knowledge, and the Surface into ground, cliff and high ground', () => {
    const fog = fresh(0);
    const tunnel = view.depths.indexOf(CELL.tunnel);
    const rock = view.depths.indexOf(CELL.unknown);
    expect(blendAt(fog, 'depths', tunnel % size, Math.floor(tunnel / size))).not.toBe(blendAt(fog, 'depths', rock % size, Math.floor(rock / size)));
    const ridges = createGame({ seed: 7, options: { terrain: 'ridges' } });
    const surface = new FogField(size);
    const rv = ridges.view('nw') as View & { match: MatchData };
    surface.ingestWalls(rv);
    surface.ingestVision(rv, true);
    surface.stepFog(1);
    const terrain = ridges.sim.terrain;
    const cliff = terrain.indexOf(SURFACE.cliff);
    const ground = terrain.indexOf(SURFACE.ground);
    expect(cliff).toBeGreaterThanOrEqual(0);
    expect(blendAt(surface, 'surface', cliff % size, Math.floor(cliff / size))).not.toBe(blendAt(surface, 'surface', ground % size, Math.floor(ground / size)));
  });

  it('re-uploads a plane only when its classes change', () => {
    const fog = fresh(0);
    for (const p of ['depths', 'surface', 'sky', 'orbit'] as const) expect(fog.planes[p].settled).toBe(true);
    fog.ingestWalls({ ...view, tick: 1 });
    expect(fog.planes.orbit.settled).toBe(true);
    expect(fog.planes.depths.settled).toBe(true);
    fog.ingestWalls({ ...view, tick: g.open + g.turn + 1 });
    expect(fog.planes.orbit.settled).toBe(false);
  });
});
