import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { ARMIES, CELL, DEFAULT_RULES, frameOf, rotX, rotY, PLANES, PLANE_Y, SURFACE, spirePositions, type Plane, type View } from '@agent-command/game/contract';
import { digCount, digRect } from '../src/designate.ts';
import { placementFootprint, projectFootprint } from '../src/footprints.ts';
import { Minimap, minimapTurns } from '../src/minimap.ts';
import { createLens } from '../src/tools/lens.ts';
import { round2 } from '../src/tools/types.ts';
import { CameraRig } from '../src/world/camera.ts';
import { wx, wz } from '../src/world/common.ts';
import type { Track } from '../src/world/entities.ts';
import { World } from '../src/world/world.ts';

const SIZES = [48, 64, 80] as const;

describe('active match client geometry', () => {
  it.each(SIZES)('frames every plane and every army\'s home from behind it on S%s', (size) => {
    const rig = new CameraRig(size);
    rig.resize(1600, 1000);
    const area = { left: 240, top: 100, right: 1340, bottom: 780 };
    rig.setSafeArea(area);
    expect(rig.dist).toBeCloseTo(30 * size / 48);
    for (const army of ARMIES) {
      const home = spirePositions(DEFAULT_RULES.map.spireInset, size)[army];
      rig.centerOn(frameOf(army), home);
      // The camera sits outward of its own corner, looking across the map centre (each frame a quarter turn on).
      const out = Math.hypot(home.x - size / 2, home.y - size / 2);
      expect(Math.cos(rig.yaw)).toBeCloseTo((home.x - size / 2) / out, 12);
      expect(Math.sin(rig.yaw)).toBeCloseTo((home.y - size / 2) / out, 12);
      for (const plane of PLANES) {
        rig.goTo(plane, 0, 'jump');
        rig.update(2000, 0, 0);
        rig.camera.updateMatrixWorld();
        const point = new Vector3(wx(home.x, size), PLANE_Y[plane], wz(home.y, size)).project(rig.camera);
        expect((point.x + 1) * 800).toBeCloseTo((area.left + area.right) / 2, 8);
        expect((1 - point.y) * 500).toBeCloseTo((area.top + area.bottom) / 2, 8);
      }
    }
    rig.zoom(100000);
    expect(rig.dist).toBeCloseTo(78 * size / 48);
    rig.pan(100000, 100000);
    expect(Math.abs(rig.tx)).toBeLessThanOrEqual(size / 2 + 4);
    expect(Math.abs(rig.tz)).toBeLessThanOrEqual(size / 2 + 4);
  });

  it('changes camera framing without retaining a previous match dimension', () => {
    const rig = new CameraRig(48);
    for (const size of [80, 64, 48, 80]) {
      rig.setSize(size);
      expect(rig.dist).toBeCloseTo(30 * size / 48);
      rig.lookAtTile(size / 2, size / 2);
      expect([rig.tx, rig.tz]).toEqual([0, 0]);
    }
  });

  it.each(SIZES)('clips picking and projects footprints on S%s across every plane', (size) => {
    const world = new World({} as HTMLCanvasElement, size);
    const ground = vi.spyOn(world, 'groundPoint');
    for (const plane of PLANES) {
      ground.mockReturnValue({ x: size - 0.01, y: size - 0.01 });
      expect(world.pickTile(0, 0, plane)).toEqual({ x: size - 0.01, y: size - 0.01 });
      for (const point of [{ x: size, y: 1 }, { x: 1, y: size }, { x: -0.01, y: 1 }, { x: 1, y: Number.NaN }]) {
        ground.mockReturnValue(point);
        expect(world.pickTile(0, 0, plane)).toBeUndefined();
      }
    }
    const tr = { e: { kind: 'shaft' }, rx: size / 2, ry: size / 2, wy: 0 } as Track;
    const project = (x: number, _y: number, z: number) => ({ x, y: z, behind: false });
    const quad = projectFootprint({ size, project }, tr, new Float64Array(8))!;
    expect(Array.from(quad)).toEqual([-1, -1, 1, -1, 1, 1, -1, 1]);
    expect(round2(size - 0.123, size)).toBe(size - 0.12);
    expect(round2(size + 1, size)).toBe(size);
  });

  it.each(SIZES)('keeps lens projection and pointer coordinates reciprocal on S%s', (size) => {
    const rig = new CameraRig(size);
    rig.resize(1600, 1000);
    rig.update(0, 0, 0);
    for (const target of PLANES) {
      const lens = createLens(size);
      Object.assign(lens, { active: true, source: 'surface', target, x: size - 7, y: size - 8, radius: 5 });
      lens.update(rig.camera, { left: 0, top: 0, width: 1600, height: 1000 });
      const point = { ...lens.point(lens.px, lens.py) };
      expect(point.x).toBeCloseTo(lens.x, 8);
      expect(point.y).toBeCloseTo(lens.y, 8);
      const pixel = lens.project(wx(point.x, size), PLANE_Y[target], wz(point.y, size));
      expect(pixel.x).toBeCloseTo(lens.px, 6);
      expect(pixel.y).toBeCloseTo(lens.py, 6);
    }
  });

  it.each(SIZES)('uses the full designation bitset and placement stride on S%s', (size) => {
    const n = size * size;
    const tags = { normal: Array<number>(Math.ceil(n / 30)).fill(0), urgent: Array<number>(Math.ceil(n / 30)).fill(0) };
    for (const cell of [0, n - 1]) tags.normal[Math.floor(cell / 30)]! |= 1 << (cell % 30);
    expect(digCount(tags, size)).toBe(2);
    expect(digRect({ x: size - 2.1, y: size - 2.1 }, { x: size + 20, y: size + 20 }, size))
      .toEqual({ x0: size - 3, y0: size - 3, x1: size - 1, y1: size - 1 });
    const view = {
      entities: [], memory: [], queue: [], lodes: [], holes: [],
      depths: Array<number>(n).fill(CELL.tunnel),
      vision: Object.fromEntries(PLANES.map((plane) => [plane, Array<number>(Math.ceil(n / 30)).fill(1073741823)])),
    } as unknown as View;
    const terrain = new Uint8Array(n).fill(SURFACE.ground);
    // The last in-map columns: the stride reaches size - 1, and an apron past the map edge does not count.
    const preview = placementFootprint('shaft', size - 2, size - 3, view, terrain, size);
    expect(preview.cells.map((cell) => [cell.x, cell.y, cell.valid])).toEqual([[size - 2, size - 3, true], [size - 1, size - 3, true], [size - 2, size - 2, true], [size - 1, size - 2, true]]);
    // A footprint running off the map is no site at all, as the sim rejects it.
    expect(placementFootprint('shaft', size - 1, size - 3, view, terrain, size).cells.map((cell) => cell.valid)).toEqual([false, false, false, false]);
    view.depths.fill(CELL.rock);
    const cell = (size - 4) * size + size - 4;
    view.depths[cell] = view.depths[cell + size] = CELL.tunnel;
    expect(placementFootprint('bulkhead', size - 4, size - 4, view, terrain, size).cells[0]!.valid).toBe(true);
    view.depths[cell + size] = CELL.rock;
    expect(placementFootprint('bulkhead', size - 4, size - 4, view, terrain, size).cells[0]!.valid).toBe(false);
  });
});

type MapGeometry = { size: number; turns: number; tileAt(plane: Plane, x: number, y: number): { x: number; y: number } | undefined };

describe('four-plane field map sizes', () => {
  it('maps every match size and army frame onto the same journal-page pixels, own corner at the bottom', () => {
    const map = Object.create(Minimap.prototype) as MapGeometry;
    expect(ARMIES.map(minimapTurns)).toEqual([2, 1, 0, 3]);
    for (const size of [48, 80, 64, 48]) for (const army of ARMIES) {
      const turns = minimapTurns(army);
      Object.assign(map, { size, turns });
      const a = 48 * 1.85 / size, b = 48 * 0.92 / size;
      // The army's own home lands at the page's bottom corner (largest x + y once turned).
      const home = spirePositions(DEFAULT_RULES.map.spireInset, size)[army];
      const hx = rotX(turns, home.x, home.y, size), hy = rotY(turns, home.x, home.y, size);
      expect(hx).toBeGreaterThan(size / 2); expect(hy).toBeGreaterThan(size / 2);
      expect(hx).toBeCloseTo(hy, 9);
      for (const plane of PLANES) {
        const origin = 14 + 62 * (3 - PLANES.indexOf(plane));
        for (const point of [{ x: 0.5, y: 0.5 }, { x: size / 2, y: size / 2 }, { x: size - 0.5, y: size - 0.5 }, { x: 3.25, y: size - 7.5 }]) {
          const x = rotX(turns, point.x, point.y, size), y = rotY(turns, point.x, point.y, size);
          const picked = map.tileAt(plane, 26 + size * a + (x - y) * a, origin + (x + y) * b)!;
          expect(picked.x).toBeCloseTo(point.x, 8);
          expect(picked.y).toBeCloseTo(point.y, 8);
        }
        expect(map.tileAt(plane, 26 + size * a + (size + 1) * a, origin + (size + 1) * b)).toBeUndefined();
      }
    }
  });
});
