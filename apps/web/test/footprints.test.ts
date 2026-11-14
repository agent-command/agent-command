import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three/webgpu';
import { CELL, DEFAULT_RULES, PLANES, STATS, STRUCTURE_KINDS, SURFACE, isHardpointKind, type ArmyId, type Entity, type MatchData, type View } from '@agent-command/game/contract';
import { buildAnchor, placementFootprint, projectFootprint, quadDistance, quadIntersectsBox } from '../src/footprints.ts';
import { World } from '../src/world/world.ts';
import type { Track } from '../src/world/entities.ts';
import { AIR_SCALE, HARDPOINT_PAD, PART, UNIT_SCALE, footprintModelScale, model } from '../src/world/models.ts';
import { Minimap } from '../src/minimap.ts';
import { configureLens, createLens, pickLens } from '../src/tools/lens.ts';

/** Every view, terrain and projection here is a default-size map. */
const size = DEFAULT_RULES.map.size;
function knownView(): View {
  return { army: 'nw', rulesHash: 0, entities: [], memory: [], queue: [], lodes: [], holes: [],
    depths: Array<number>(size * size).fill(CELL.tunnel),
    vision: Object.fromEntries(PLANES.map((p) => [p, Array<number>(77).fill(1073741823)])),
  } as unknown as View;
}
const ground = new Uint8Array(size * size).fill(SURFACE.ground);
const track = (kind: Entity['kind'], x = 20.5, y = 20.5, plane: Entity['plane'] = 'surface'): Track => ({
  e: { id: kind, kind, x, y, plane, side: 'se' }, rx: x, ry: y, wy: 0, visible: true,
} as Track);
const project = (x: number, _height: number, z: number) => ({ x: (x + size / 2) * 40, y: (z + size / 2) * 40, behind: false });

describe('fog-safe structure footprint previews', () => {
  it('snaps minimum corners, preserves even-size centres, and rejects whole sites that leave the map', () => {
    const view = knownView();
    expect(buildAnchor('shaft', 12.9, 14.1, view)).toEqual({ x: 12, y: 14 });
    const p = placementFootprint('shaft', 47.8, 12.4, view, ground, size);
    expect(p).toMatchObject({ x: 47, y: 12, w: 2, h: 2 });
    expect(p.cells.map((c) => c.valid)).toEqual([false, false, false, false]);
  });

  it('snaps every known lode cell to the same complete headframe and does not infer undiscovered twins', () => {
    const view = knownView();
    view.lodes = [{ x: 20, y: 20, rich: false, open: false, loads: 80 }];
    for (let y = 19; y <= 21; y++) for (let x = 19; x <= 21; x++) {
      expect(buildAnchor('headframe', x + 0.2, y + 0.8, view)).toEqual({ x: 19, y: 19 });
      const p = placementFootprint('headframe', x + 0.2, y + 0.8, view, ground, 48);
      expect(p.cells).toHaveLength(9);
      expect(p.cells.every((c) => c.valid)).toBe(true);
    }
    expect(placementFootprint('turret', 19, 21, view, ground, 48).cells[0]?.valid).toBe(false);
    expect(placementFootprint('headframe', 27, 27, view, ground, 48).cells.every((c) => !c.valid)).toBe(true);
    expect(buildAnchor('headframe', 27.2, 27.8, view)).toEqual({ x: 27, y: 27 });
  });

  it('marks invalid cells individually for visible holes, shaft bedrock and fog', () => {
    const view = knownView();
    view.holes = [{ x: 11, y: 10, kind: 'crater' }];
    view.depths[11 * size + 10] = CELL.bedrock;
    const unseen = 11 * size + 11;
    view.vision.surface[Math.floor(unseen / 30)]! &= ~(1 << (unseen % 30));
    expect(placementFootprint('shaft', 10, 10, view, ground, size).cells.map((c) => c.valid)).toEqual([true, false, false, false]);
    view.depths[11 * size + 10] = CELL.unknown;
    expect(placementFootprint('shaft', 10, 10, view, ground, size).cells.map((c) => c.valid)).toEqual([true, false, true, false]);
    // Underground terrain not in the view cannot alter a Surface preview.
    view.depths[11 * size + 10] = CELL.rock;
    expect(placementFootprint('shaft', 10, 10, view, ground, size).cells.map((c) => c.valid)).toEqual([true, false, true, false]);
  });

  it('requires the whole site and its apron on one level: all ground or all high', () => {
    const view = knownView(), terrain = ground.slice();
    // A 6×6 plateau holds a 2×2 shaft at 10..11 with its one-cell apron 9..12 entirely on high ground.
    for (let y = 9; y <= 14; y++) for (let x = 9; x <= 14; x++) terrain[y * size + x] = SURFACE.high;
    const valid = (x: number, y: number, t = terrain) => placementFootprint('shaft', x, y, view, t, size).cells.map((c) => c.valid);
    expect(valid(10, 10)).toEqual([true, true, true, true]);
    expect(valid(12, 12)).toEqual([true, true, true, true]);
    // Apron straddles the cliff edge although the footprint itself is all high.
    expect(valid(9, 10)).toEqual([false, false, false, false]);
    // Footprint itself straddles high and ground.
    expect(valid(14, 12)).toEqual([false, false, false, false]);
    // Lodes may sit on plateaus too.
    view.lodes = [{ x: 12, y: 12, rich: false, open: false, loads: 80 }];
    expect(placementFootprint('headframe', 12, 12, view, terrain, size).cells.every((c) => c.valid)).toBe(true);
    view.lodes = [{ x: 9, y: 12, rich: false, open: false, loads: 80 }];
    expect(placementFootprint('headframe', 9, 12, view, terrain, size).cells.every((c) => !c.valid)).toBe(true);
  });

  it('rejects every cell when forest, cliff or water touches the footprint or apron', () => {
    const view = knownView();
    for (const blocker of [SURFACE.forest, SURFACE.cliff, SURFACE.water]) {
      const terrain = ground.slice();
      terrain[9 * size + 12] = blocker;
      expect(placementFootprint('shaft', 10, 10, view, terrain, size).cells.every((c) => !c.valid)).toBe(true);
      expect(placementFootprint('shaft', 13, 10, view, terrain, size).cells.every((c) => !c.valid)).toBe(true);
      expect(placementFootprint('shaft', 10, 11, view, terrain, size).cells.every((c) => c.valid)).toBe(true);
    }
  });

  it('uses known entity, memory and queue rectangles with exactly one empty Surface cell between them', () => {
    const view = knownView();
    const obstacle = { id: 'enemy', kind: 'turret', plane: 'surface', side: 'se', x: 10.5, y: 10.5 } as Entity;
    view.entities = [obstacle];
    expect(placementFootprint('shaft', 11, 10, view, ground, 48).cells.map((c) => c.valid)).toEqual([false, true, false, true]);
    expect(placementFootprint('shaft', 12, 10, view, ground, 48).cells.every((c) => c.valid)).toBe(true);
    view.entities = [];
    view.memory = [{ ...obstacle, seen: 1 }];
    expect(placementFootprint('shaft', 11, 10, view, ground, 48).cells.map((c) => c.valid)).toEqual([false, true, false, true]);
    view.memory = [];
    view.queue = [{ item: 'turret', plane: 'surface', x: 10.5, y: 10.5 } as View['queue'][number]];
    expect(placementFootprint('shaft', 11, 10, view, ground, 48).cells.map((c) => c.valid)).toEqual([false, true, false, true]);
  });

  it('requires a known tunnel and open neighbour for bulkheads and rejects root overlap', () => {
    const view = knownView();
    expect(placementFootprint('bulkhead', 10, 10, view, ground, 48).cells[0]?.valid).toBe(true);
    view.depths[10 * size + 10] = CELL.rail;
    expect(placementFootprint('bulkhead', 10, 10, view, ground, 48).cells[0]?.valid).toBe(false);
    view.depths.fill(CELL.rock);
    view.depths[10 * size + 10] = CELL.tunnel;
    expect(placementFootprint('bulkhead', 10, 10, view, ground, 48).cells[0]?.valid).toBe(false);
    view.depths[10 * size + 11] = CELL.tunnel;
    view.entities = [{ kind: 'spire', plane: 'depths', x: 10.5, y: 10.5 } as Entity];
    expect(placementFootprint('bulkhead', 10, 10, view, ground, 48).cells[0]?.valid).toBe(false);
  });
});

describe('build radius previews', () => {
  /** A default-rules duel bootstrap: Spires at (3.5, 3.5) and (44.5, 44.5). */
  const DUEL: MatchData['armies'] = [
    { id: 'nw', slot: 0, frame: 0, colour: 'blue', spireAt: { x: 3.5, y: 3.5 } },
    { id: 'se', slot: 1, frame: 2, colour: 'red', spireAt: { x: size - 3.5, y: size - 3.5 } },
  ];
  function radiusView(army: ArmyId, armies: MatchData['armies'] = DUEL): View & { match: MatchData } {
    const view = knownView() as View & { match: MatchData };
    view.army = army;
    view.eliminated = [];
    // matchData.posts is always present (empty here: no posts project radius in this fixture).
    view.match = { rules: DEFAULT_RULES, armies, posts: [] } as unknown as MatchData;
    view.entities = [{ id: 'e_1', kind: 'spire', side: army, plane: 'surface', ...armies.find((a) => a.id === army)!.spireAt, hp: 7000, maxHp: 7000, state: 'active' }];
    return view;
  }
  /** NW's turret anchor, or SE's 1×1 point mirror. */
  const at = (army: 'nw' | 'se', x: number, y: number) => (army === 'nw' ? { x, y } : { x: size - 1 - x, y: size - 1 - y });

  it.each(['nw', 'se'] as const)('%s: refuses the whole site outside the own radius or near a hostile Spire, with the reason', (army) => {
    const view = radiusView(army);
    const verdict = (x: number, y: number) => {
      const a = at(army, x, y);
      const p = placementFootprint('turret', a.x, a.y, view, ground, size);
      return { reason: p.reason, valid: p.cells.every((c) => c.valid) };
    };
    expect(verdict(11, 11)).toEqual({ reason: null, valid: true });
    expect(verdict(12, 12)).toEqual({ reason: 'out_of_radius', valid: false });
    // Own sources: a completed Shaft (centre (34, 34), mirrored) projects radius, one under construction and a turret do not.
    const shaft = army === 'nw' ? 34 : size - 34;
    view.entities.push({ id: 'e_2', kind: 'shaft', side: army, plane: 'surface', x: shaft, y: shaft, hp: 50, maxHp: 500, state: 'constructing' });
    const turret = at(army, 39, 35); // 3.2 tiles from the (36, 36) site: it would cover it if turrets projected radius
    view.entities.push({ id: 'e_3', kind: 'turret', side: army, plane: 'surface', x: turret.x + 0.5, y: turret.y + 0.5, hp: 400, maxHp: 400, state: 'active' });
    expect(verdict(36, 36)).toEqual({ reason: 'out_of_radius', valid: false });
    view.entities[1]!.state = 'active';
    expect(verdict(36, 36)).toEqual({ reason: null, valid: true });
    // Inside the Shaft's radius but 6.4 tiles from the enemy Spire edge.
    expect(verdict(38, 38)).toEqual({ reason: 'no_build_zone', valid: false });
  });

  it('leaves Sky and Depths structures and match-less previews to their own rules', () => {
    const view = radiusView('nw');
    view.depths[30 * size + 31] = CELL.tunnel;
    expect(placementFootprint('bulkhead', 30, 30, view, ground, size).reason).toBeNull();
    expect(placementFootprint('turret', 30, 30, knownView(), ground, size).reason).toBeNull();
  });
});

describe('projected structure rectangles', () => {
  it('projects full registry rectangles, including continuously drifting relays', () => {
    const out = new Float64Array(8);
    expect(Array.from(projectFootprint({ project, size: 48 }, track('shaft', 20, 20), out)!)).toEqual([760, 760, 840, 760, 840, 840, 760, 840]);
    projectFootprint({ project, size: 48 }, track('relay', 20.23, 20.67, 'sky'), out);
    expect(out[0]).toBeCloseTo(19.73 * 40);
    expect(out[1]).toBeCloseTo(20.17 * 40);
    expect(projectFootprint({ project, size: 48 }, track('trooper'), out)).toBeUndefined();
  });

  it('picks the far corner of a headframe, not just its centre radius', () => {
    const tr = track('headframe');
    const world: World = Object.assign(Object.create(World.prototype), {
      renderSize: size,
      rig: { focus: 'surface' }, entities: { tracks: new Map([[tr.e.id, tr]]) }, project,
      footprintQuad: new Float64Array(8),
    });
    expect(world.pickEntity(875, 875, 5)).toBe(tr);
    expect(world.pickEntity(900, 900, 5)).toBeUndefined();
    expect(world.footprintInBox(tr, 875, 875, 885, 885)).toBe(true);
    expect(world.footprintInBox(tr, 900, 900, 905, 905)).toBe(false);
  });

  it('picks stacked Sky islands at their rendered elevations rather than their identical map coordinates', () => {
    const low = { e: { id: 'low', kind: 'island', plane: 'sky', x: 24, y: 24 }, rx: 24, ry: 24, wy: 14.9, visible: true } as Track;
    const high = { ...low, e: { ...low.e, id: 'high' }, wy: 22.9 };
    const projection = (x: number, height: number, z: number) => ({ x: 800 + x * 20, y: 600 + z * 20 - height * 10, behind: false });
    const world: World = Object.assign(Object.create(World.prototype), {
      renderSize: size, rig: { focus: 'sky' }, entities: { tracks: new Map([[high.e.id, high], [low.e.id, low]]) },
      project: projection, footprintQuad: new Float64Array(8),
    });
    for (const order of [[high, low], [low, high]]) {
      world.entities.tracks.clear();
      for (const tr of order) world.entities.tracks.set(tr.e.id, tr);
      for (const tr of [low, high]) {
        const p = projection(0, tr.wy + 0.3, 0);
        expect(world.pickEntity(p.x, p.y)).toBe(tr);
      }
      // A straight-down projection puts both island centres on exactly the same screen pixel.
      world.project = project;
      expect(world.pickEntity(24 * 40, 24 * 40)).toBe(high);
      world.project = projection;
    }
    world.rig.focus = 'surface';
    expect(world.pickEntity(800, 448)).toBeUndefined();
  });

  it('resolves overlapping Sky attachment rectangles by visible height only when screen distances tie', () => {
    const lower = { e: { id: 'low', kind: 'relay', plane: 'sky', x: 24, y: 24 }, rx: 24, ry: 24, wy: 14, visible: true } as Track;
    const upper = { ...lower, e: { ...lower.e, id: 'high' }, wy: 15 };
    const world: World = Object.assign(Object.create(World.prototype), {
      renderSize: size, rig: { focus: 'sky' }, entities: { tracks: new Map() }, footprintQuad: new Float64Array(8),
      project: (x: number, y: number, z: number) => ({ x: 800 + x * 20, y: 600 + z * 20 - y * 10, behind: false }),
    });
    for (const order of [[lower, upper], [upper, lower]]) {
      world.entities.tracks.clear();
      for (const tr of order) world.entities.tracks.set(tr.e.id, tr);
      expect(world.pickEntity(800, 455)).toBe(upper);
      expect(world.pickEntity(800, 465)).toBe(lower);
    }
  });

  it('uses exact convex intersections rather than selecting empty corners of screen bounding boxes', () => {
    const diamond = new Float64Array([0, -2, 2, 0, 0, 2, -2, 0]);
    expect(quadDistance(diamond, 0, 0)).toBe(0);
    expect(quadDistance(diamond, 2, 2)).toBeCloseTo(Math.SQRT2);
    expect(quadIntersectsBox(diamond, 1.6, 1.6, 2, 2)).toBe(false);
    expect(quadIntersectsBox(diamond, 1.8, -0.1, 2.2, 0.1)).toBe(true);
    expect(quadIntersectsBox(diamond, -0.1, -3, 0.1, 3)).toBe(true);
    expect(quadIntersectsBox(diamond, -3, -3, 3, 3)).toBe(true);
  });

  it('uses rectangle edges for fog-safe cross-plane lens picking', () => {
    const tr = track('headframe');
    const view = knownView();
    view.entities = [tr.e];
    const lens = createLens(size);
    configureLens(lens, { units: [], spire: false }, 'sky', { plane: 'surface', radius: 6, cursor: true });
    lens.x = tr.rx; lens.y = tr.ry;
    const camera = new PerspectiveCamera(50, 1.6, 0.1, 900), h = lens.layerY();
    camera.position.set(tr.rx - size / 2, h + 10, tr.ry - size / 2 + 10);
    camera.lookAt(tr.rx - size / 2, h, tr.ry - size / 2);
    lens.update(camera, { left: 0, top: 0, width: 1600, height: 1000 });
    const corners = lens.projectFootprint('surface', tr, new Float64Array(8))!;
    const center = lens.project(tr.rx - size / 2, h, tr.ry - size / 2);
    const x = corners[0]! * 0.98 + center.x * 0.02, y = corners[1]! * 0.98 + center.y * 0.02;
    expect(Math.hypot(x - center.x, y - center.y)).toBeGreaterThan(5);
    const world = { entities: { tracks: new Map([[tr.e.id, tr]]) } } as unknown as Pick<World, 'entities'>;
    expect(pickLens(lens, view, world, x, y, 5)).toBe(tr);
    view.entities = [];
    expect(pickLens(lens, view, world, x, y, 5)).toBeUndefined();
  });
});

describe('structure model and minimap dimensions', () => {
  // A hardpoint attachment's registry footprint is a sim cell at the island centre; on screen it stands on the round
  // rim pad instead (below), so the rectangle fit applies to every other structure. Its hull fills the rectangle; only
  // a barrel may reach past it (the turret's gun), and never beyond the cell's corners.
  it.each(STRUCTURE_KINDS.filter((kind) => kind !== 'bulkhead' && !isHardpointKind(kind)))('fits %s to its registry footprint without zoom-dependent enlargement', (kind) => {
    const geometry = model(kind), scale = footprintModelScale(kind, geometry), f = STATS[kind].footprint;
    const p = geometry.getAttribute('position'), part = geometry.getAttribute('part');
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, reach = 0;
    for (let i = 0; i < p.count; i++) {
      if (part.getX(i) === PART.barrel) {
        reach = Math.max(reach, Math.hypot(p.getX(i), p.getZ(i)));
        continue;
      }
      minX = Math.min(minX, p.getX(i)); maxX = Math.max(maxX, p.getX(i));
      minZ = Math.min(minZ, p.getZ(i)); maxZ = Math.max(maxZ, p.getZ(i));
    }
    expect((maxX - minX) * scale).toBeCloseTo(f.w, 5);
    expect((maxZ - minZ) * scale).toBeCloseTo(f.h, 5);
    expect(reach * scale).toBeLessThanOrEqual(Math.hypot(f.w, f.h) / 2);
  });

  it('keeps the emplaced airframe full length with its landing contact on the pad, not fitted into the sim cell', () => {
    const flying = model('gunship'), platform = model('gun_platform');
    flying.computeBoundingBox(); platform.computeBoundingBox();
    const scale = footprintModelScale('gun_platform', platform);
    expect(scale).toBe(UNIT_SCALE * AIR_SCALE);
    expect(platform.boundingBox!.max.x - platform.boundingBox!.min.x).toBeCloseTo(flying.boundingBox!.max.x - flying.boundingBox!.min.x, 6);
    expect(platform.boundingBox!.min.y).toBeCloseTo(0, 6);
    // The hull may overhang; fitting every vertex inside this radius caused the miniature airframe.
    expect(Math.max(-platform.boundingBox!.min.x, platform.boundingBox!.max.x) * scale).toBeGreaterThan(HARDPOINT_PAD.r);
    expect(STATS.gun_platform.footprint).toEqual({ w: 1, h: 1 });
  });

  it('keeps a bulkhead inside its occupied cell while preserving diagonal passage poses', () => {
    const geometry = model('bulkhead'), scale = footprintModelScale('bulkhead', geometry);
    const p = geometry.getAttribute('position'), f = STATS.bulkhead.footprint;
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) for (let i = 0; i < p.count; i++) {
      const x = (p.getX(i) * Math.cos(angle) - p.getZ(i) * Math.sin(angle)) * scale;
      const y = (p.getX(i) * Math.sin(angle) + p.getZ(i) * Math.cos(angle)) * scale;
      expect(Math.abs(x)).toBeLessThanOrEqual(f.w / 2 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual(f.h / 2 + 1e-6);
    }
  });

  it('draws minimap structure and lode paths from projected cell corners', () => {
    const moveTo = vi.fn(), lineTo = vi.fn(), beginPath = vi.fn(), closePath = vi.fn();
    const map = Object.assign(Object.create(Minimap.prototype), { size, ctx: { moveTo, lineTo, beginPath, closePath }, turns: 0 }) as {
      footprintPath(plane: 'surface', kind: 'shaft' | 'headframe', x: number, y: number): void;
      turns: number;
    };
    map.footprintPath('surface', 'shaft', 20, 20);
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(lineTo).toHaveBeenCalledTimes(3);
    const small = lineTo.mock.calls.map(([x, y]) => [x as number, y as number]);
    lineTo.mockClear();
    map.footprintPath('surface', 'headframe', 20, 20);
    const large = lineTo.mock.calls.map(([x, y]) => [x as number, y as number]);
    expect(large[0]![0]! - large[2]![0]!).toBeCloseTo((small[0]![0]! - small[2]![0]!) * 1.5);
    expect(closePath).toHaveBeenCalledTimes(2);
    // The C2 mirror (two quarter turns) draws the twin cell on the same page corners.
    map.turns = 2;
    map.footprintPath('surface', 'headframe', size - 20, size - 20);
    expect(lineTo.mock.calls[3]).toEqual(large[2]);
  });
});
