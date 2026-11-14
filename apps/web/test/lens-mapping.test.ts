import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { type Entity, type Plane, type View } from '@agent-command/game/contract';
import { HOLO_LIFT, HOLO_STEP, configureLens, createLens, holoY, inLens, lensStack, pickLens, previewLens, type Lens } from '../src/tools/lens.ts';
import type { ToolContext, ToolPointer } from '../src/tools/types.ts';
import { AIM_Y } from '../src/world/common.ts';
import type { Track } from '../src/world/entities.ts';
import { quadDistance } from '../src/footprints.ts';
import { fillGlyphs, glyphBuffers } from '../src/world/holo.ts';

const HALF = 24;
const viewport = { left: 30, top: 20, width: 1600, height: 1000 };
function camera(yaw = 0, distance = 60, height = 0) {
  const result = new PerspectiveCamera(50, 1.6, 0.1, 900);
  result.position.set(Math.sin(yaw) * distance, height + distance, Math.cos(yaw) * distance);
  result.lookAt(0, height, 0);
  result.updateMatrixWorld();
  return result;
}
function unit(kind: Entity['kind'], x: number, y: number, plane: Plane = 'surface'): Entity {
  return { id: `${kind}:${x}`, kind, x, y, plane, side: 'nw', state: 'idle' } as Entity;
}
function holo(source: Plane, target: Plane): Lens {
  const lens = createLens(48);
  configureLens(lens, { units: [], spire: false }, source, { plane: target, radius: 9, cursor: true });
  return Object.assign(lens, { x: 24, y: 25 });
}

describe('holo lens planes', () => {
  it.each([
    ['orbit', 'surface', ['sky', 'surface']],
    ['orbit', 'sky', ['sky']],
    ['orbit', 'depths', ['sky', 'surface', 'depths']],
    ['sky', 'surface', ['surface']],
    ['surface', 'sky', ['sky']],
    ['surface', 'depths', ['depths']],
    ['depths', 'surface', ['surface']],
    ['depths', 'orbit', ['surface', 'sky', 'orbit']],
    ['sky', 'sky', []],
  ] as const)('%s toward %s stacks %j, nearest first', (source, target, stack) => {
    expect(lensStack(source, target, [])).toEqual(stack);
  });

  it('compresses each stacked plane onto the viewing plane, deeper layers a step further, below when looking down', () => {
    const lens = holo('orbit', 'surface');
    expect(lens).toMatchObject({ active: true, down: true, stack: ['sky', 'surface'] });
    expect(lens.layerY('sky')).toBeCloseTo(AIM_Y.orbit - HOLO_LIFT, 8);
    expect(lens.layerY('surface')).toBeCloseTo(AIM_Y.orbit - HOLO_LIFT - HOLO_STEP, 8);
    expect(lens.layerY()).toBe(lens.layerY('surface'));
    const up = holo('surface', 'sky');
    expect(up.layerY('sky')).toBeCloseTo(AIM_Y.surface + HOLO_LIFT, 8);
    expect(holoY('depths', 0, false)).toBeGreaterThan(AIM_Y.depths);
  });
});

describe('in-place holo coordinates', () => {
  it.each([0, 0.7, Math.PI])('picks and projects through the main camera on the target layer at yaw %s', (yaw) => {
    const lens = holo('orbit', 'surface');
    const cam = camera(yaw, 30, AIM_Y.orbit);
    lens.update(cam, viewport);
    // The focus projects where the main camera draws that map point at the layer's height.
    const expected = new Vector3(lens.x - HALF, lens.layerY(), lens.y - HALF).project(cam);
    expect(lens.px).toBeCloseTo(viewport.left + (expected.x + 1) / 2 * viewport.width, 6);
    expect(lens.py).toBeCloseTo(viewport.top + (1 - expected.y) / 2 * viewport.height, 6);
    const centre = lens.point(lens.px, lens.py);
    expect(centre.x).toBeCloseTo(lens.x, 6);
    expect(centre.y).toBeCloseTo(lens.y, 6);
    for (const [dx, dy] of [[5, 0], [0, -4], [-3, 3]] as const) {
      const at = lens.project(lens.x + dx - HALF, lens.layerY(), lens.y + dy - HALF);
      const back = lens.point(at.x, at.y);
      expect(back.x).toBeCloseTo(lens.x + dx, 6);
      expect(back.y).toBeCloseTo(lens.y + dy, 6);
    }
    expect(lens.pixels).toBeGreaterThan(0);
    expect(inLens(lens, lens.px + lens.pixels * 0.5, lens.py)).toBe(true);
    expect(inLens(lens, lens.px + lens.pixels * 1.01, lens.py)).toBe(false);
  });

  it('keeps the focus aligned with the world: the hologram never moves to a HUD-safe disc', () => {
    const lens = holo('sky', 'surface');
    lens.x = -500; lens.y = -500;
    const cam = camera(0, 30, AIM_Y.sky);
    lens.update(cam, viewport);
    const back = lens.point(lens.px, lens.py);
    expect(back.x).toBeCloseTo(-500, 4);
    expect(back.y).toBeCloseTo(-500, 4);
  });
});

describe('explicit ability and peek holograms', () => {
  it.each(['nw', 'ne', 'se', 'neutral'] as const)('picks visible %s islands for mooring, but never a stale fog track', (side) => {
    const lens = createLens(48);
    const tower = unit('mooring_tower', 24, 24);
    configureLens(lens, { units: [tower], spire: false }, 'surface', { plane: 'sky', radius: 20, islands: true });
    lens.update(camera(0, 30, AIM_Y.surface), viewport);
    const island = { ...unit('island', 24, 24, 'sky'), side, elevation: -8 };
    const track = { e: island, rx: 24, ry: 24, wy: 14.9, elevation: -8 } as Track;
    const world = { entities: { tracks: new Map([[island.id, track]]) } } as unknown as ToolContext['world'];
    const view = createGame({ seed: 1 }).view('nw');
    view.entities = [island];
    view.vision.sky.fill(1073741823);
    const p = lens.project(0, lens.entityY(track), 0);
    expect(pickLens(lens, view, world, p.x, p.y)).toBe(track);
    const upper = { ...island, id: 'passing', elevation: 0 };
    const upperTrack = { ...track, e: upper, elevation: 0, wy: 22.9 };
    view.entities = [upper, island];
    world.entities.tracks.set(upper.id, upperTrack);
    expect(pickLens(lens, view, world, p.x, p.y)).toBe(track);
    const above = lens.project(0, lens.entityY(upperTrack), 0);
    expect(pickLens(lens, view, world, above.x, above.y)).toBe(upperTrack);
    view.vision.sky.fill(0);
    expect(pickLens(lens, view, world, p.x, p.y)).toBeUndefined();
    view.vision.sky.fill(1073741823);
    view.entities = [];
    expect(pickLens(lens, view, world, p.x, p.y)).toBeUndefined();
    configureLens(lens, { units: [tower], spire: false }, 'surface');
    expect(lens.islands).toBe(false);
    expect(lens.active).toBe(false);
  });

  it('picks and composites the upper stacked island independently of incoming entity order', () => {
    const lens = createLens(48), tower = unit('mooring_tower', 24, 24);
    configureLens(lens, { units: [tower], spire: false }, 'surface', { plane: 'sky', radius: 20, islands: true });
    const cam = camera();
    cam.position.set(0, 60, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    lens.update(cam, viewport);
    const low = { ...unit('island', 24, 24, 'sky'), id: 'low', elevation: -8 };
    const high = { ...low, id: 'high', elevation: 0 };
    const tracks = new Map([low, high].map((e) => [e.id, { e, rx: e.x, ry: e.y, wy: 22.9 + e.elevation, elevation: e.elevation } as Track]));
    const world = { entities: { tracks } } as unknown as ToolContext['world'];
    const view = createGame({ seed: 1 }).view('nw');
    view.vision.sky.fill(1073741823); view.memory = [];
    const glyphs = glyphBuffers(4);
    const point = { ...lens.project(0, lens.entityY(tracks.get(high.id)!), 0) };
    for (const order of [[low, high], [high, low]]) {
      view.entities = order;
      expect(pickLens(lens, view, world, point.x, point.y)).toBe(tracks.get(high.id));
      fillGlyphs(glyphs, view, tracks, 'sky', { x: 24, y: 24, radius: 20, x2: 0, y2: 0, two: false }, 48, 2.6, () => 0);
      expect(glyphs.count).toBe(2);
      expect(glyphs.c[3]).toBeCloseTo(-1.6);
      expect(glyphs.c[7]).toBe(0);
    }
  });

  it('breaks zero-distance overlapping deck-footprint ties by height but keeps an exposed lower footprint selectable', () => {
    const lens = createLens(48), tower = unit('mooring_tower', 24, 24);
    configureLens(lens, { units: [tower], spire: false }, 'surface', { plane: 'sky', radius: 20 });
    lens.update(camera(0, 30, AIM_Y.surface), viewport);
    const low = { ...unit('relay', 24, 24, 'sky'), id: 'low', side: 'se', elevation: -1 } as Entity;
    const high = { ...low, id: 'high', elevation: 0 };
    const lower = { e: low, rx: 24, ry: 24, elevation: -1 } as Track;
    const upper = { ...lower, e: high, elevation: 0 };
    const tracks = new Map([[low.id, lower], [high.id, upper]]);
    const world = { entities: { tracks } } as unknown as ToolContext['world'];
    const view = createGame({ seed: 1 }).view('nw');
    const lq = new Float64Array(8), uq = new Float64Array(8);
    lens.projectFootprint('sky', lower, lq); lens.projectFootprint('sky', upper, uq);
    const overlap = { x: (lq[0]! + lq[4]! + uq[0]! + uq[4]!) / 4, y: (lq[1]! + lq[5]! + uq[1]! + uq[5]!) / 4 };
    expect(quadDistance(lq, overlap.x, overlap.y)).toBe(0);
    expect(quadDistance(uq, overlap.x, overlap.y)).toBe(0);
    const exposed = Array.from({ length: 4 }, (_, i) => ({ x: lq[i * 2]!, y: lq[i * 2 + 1]! })).find((p) => quadDistance(uq, p.x, p.y) > 0)!;
    expect(exposed).toBeDefined();
    for (const order of [[low, high], [high, low]]) {
      view.entities = order;
      expect(pickLens(lens, view, world, overlap.x, overlap.y)).toBe(upper);
      expect(pickLens(lens, view, world, exposed.x, exposed.y)).toBe(lower);
    }
  });

  it('never activates automatically from a cross-plane weapon selection', () => {
    const lens = createLens(48);
    configureLens(lens, { units: [unit('flak', 20, 22)], spire: false }, 'surface');
    expect(lens.active).toBe(false);
    expect(lens.stack).toEqual([]);
  });

  it('anchors explicit abilities to the selection and cursor aims to the map point under the cursor on the layer', () => {
    const lens = createLens(48);
    const cam = camera(0, 30, AIM_Y.surface);
    const world = { size: 48, rig: { focus: 'surface', camera: cam }, viewport, entities: { tracks: new Map() }, lens: { show: vi.fn() } };
    const c = { world, state: { lens }, selection: { units: [unit('flak', 20, 22)], spire: false }, host: { view: () => undefined } } as unknown as ToolContext;
    const p = { x: 700, y: 600, altKey: false } as ToolPointer;
    previewLens(c, p);
    expect(lens.active).toBe(false);
    previewLens(c, p, { plane: 'depths', radius: 0 });
    expect(lens).toMatchObject({ active: true, target: 'depths', stack: ['depths'] });
    const under = { ...lens.point(p.x, p.y) };
    expect(lens.x).toBeCloseTo(under.x, 6);
    expect(lens.y).toBeCloseTo(under.y, 6);
    previewLens(c, p, { plane: 'sky', radius: 3 });
    expect(lens).toMatchObject({ active: true, target: 'sky', x: 20, y: 22, radius: 3 });
    expect(world.lens.show).toHaveBeenLastCalledWith(lens);
    previewLens(c, { ...p, altKey: true }, { plane: 'sky', radius: 3 });
    expect(lens.active).toBe(false);
    expect(world.lens.show).toHaveBeenLastCalledWith();
  });
});
