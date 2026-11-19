import { describe, expect, it } from 'vitest';
import { Group, Mesh, type InstancedMesh } from 'three/webgpu';
import { holeEdges, HoleLips } from '../src/world/holes.ts';
import { SurfaceLayer } from '../src/world/terrain.ts';
import { CELL, DEFAULT_RULES, SURFACE, VIEW_GRID, type Entity, type View } from '@agent-command/game/contract';

describe('Surface opening boundaries', () => {
  it('outlines only the union perimeter, not individual crater cells', () => {
    const cells = new Set([11, 12, 21, 22]);
    const edges = holeEdges(cells, 10);
    expect(edges).toHaveLength(8);
    expect(edges.some(e => e.x === 2 && e.y === 1 && e.dx === 0 && e.dy === 1)).toBe(false);
  });

  it('keeps long chasms coherent, isolated cells separate and islands outlined', () => {
    expect(holeEdges(new Set([11, 12, 13, 14, 15]), 10)).toHaveLength(12);
    expect(holeEdges(new Set([11, 22]), 10)).toHaveLength(8);
    const ring = new Set([11, 12, 13, 21, 23, 31, 32, 33]);
    expect(holeEdges(ring, 10)).toHaveLength(16);
  });

  it('does not wrap row boundaries into false neighbours', () => {
    expect(holeEdges(new Set([9, 10]), 10)).toHaveLength(8);
    expect(holeEdges(new Set([0]), 10)).toHaveLength(4);
  });

  it('merges torn turf, ink, cracks and rubble into one terrain-following mesh', () => {
    const group = new Group(), lips = new HoleLips(group, 48);
    const cells = new Set([10 * 48 + 10, 10 * 48 + 11]);
    lips.rebuild(cells, (x, y) => x * 0.1 + y * 0.05);
    expect(group.children).toHaveLength(1);
    const first = Array.from(lips.mesh.geometry.getAttribute('position').array);
    const geometry = lips.mesh.geometry;
    expect(first.length).toBeGreaterThan(0);
    expect(first.every(Number.isFinite)).toBe(true);
    lips.rebuild(cells, (x, y) => x * 0.1 + y * 0.05);
    expect(Array.from(lips.mesh.geometry.getAttribute('position').array)).toEqual(first);
    expect(lips.mesh.geometry).toBe(geometry);
    lips.rebuild(cells, (x, y) => x * 0.1 + y * 0.05 + 0.2);
    expect(lips.mesh.geometry).not.toBe(geometry);
    lips.rebuild(new Set(), () => 0);
    expect(lips.mesh.visible).toBe(false);
  });

  it('retains shared geometry on unchanged views and never creates per-cell torus rims', () => {
    const surface = new SurfaceLayer(DEFAULT_RULES.map.size);
    surface.setTerrain({ codes: new Uint8Array(surface.size * surface.size).fill(SURFACE.ground), faults: [], posts: [] });
    const holes = [{ x: 10, y: 10, kind: 'crater' as const }, { x: 11, y: 10, kind: 'breach' as const }];
    surface.update(holes);
    const lips = surface.group.getObjectByName('surface-hole-lips') as HoleLips['mesh'];
    const geometry = lips.geometry;
    surface.update(holes);
    surface.setDepths(Array<number>(surface.size * surface.size).fill(CELL.unknown));
    surface.setDepths(Array<number>(surface.size * surface.size).fill(CELL.tunnel));
    expect(lips.geometry).toBe(geometry);
    expect(surface.group.children.some(child => child instanceof Mesh && child.geometry.type === 'TorusGeometry')).toBe(false);
    surface.update([]);
    expect(lips.visible).toBe(false);
    surface.reset();
    expect(lips.visible).toBe(false);
  });

  it('draws a footing pier only under the hole cells a surviving structure stands on, not the rest of its pit', () => {
    const surface = new SurfaceLayer(DEFAULT_RULES.map.size);
    surface.setTerrain({ codes: new Uint8Array(surface.size * surface.size).fill(SURFACE.ground), faults: [], posts: [] });
    // A single charge's 3×3 sinkhole (cells 17..19 × 19..21) under a 2×2 Shaft centred on (18, 20): cells 17..18 × 19..20.
    const holes = [];
    for (let y = 19; y <= 21; y++) for (let x = 17; x <= 19; x++) holes.push({ x, y, kind: 'sinkhole' as const });
    surface.update(holes);
    const footings = surface.group.getObjectByName('surface-footings') as InstancedMesh;
    // Views present the centre one 1/VIEW_GRID step off the cell edge, to either side (gridPosition); a ghost likewise.
    for (const d of [1 / VIEW_GRID, -1 / VIEW_GRID, 0]) {
      const shaft = { id: 'e_1', kind: 'shaft', side: 'nw', plane: 'surface', x: 18 + d, y: 20 + d, hp: 100, maxHp: 500 } as Entity;
      surface.setFootings({ entities: [shaft], memory: [] } as unknown as View);
      expect(footings.count, `offset ${d}`).toBe(4);
      surface.setFootings({ entities: [], memory: [{ ...shaft, x: 18 - d, y: 20 + d }] } as unknown as View);
      expect(footings.count, `ghost offset ${d}`).toBe(4);
    }
    surface.setFootings({ entities: [], memory: [] } as unknown as View);
    expect(footings.count).toBe(0);
  });
});

describe.each([48, 64, 80])('map-sized hole lips (%i)', size => {
  it('uses the far map corner and retains unchanged terrain-following geometry', () => {
    const lips = new HoleLips(new Group(), size);
    const cells = new Set([(size - 2) * size + size - 2]);
    const height = (x: number, y: number) => x * 0.1 + y * 0.05;
    lips.rebuild(cells, height);
    const geometry = lips.mesh.geometry;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      expect(position.getX(i)).toBeGreaterThan(size / 2 - 3);
      expect(position.getZ(i)).toBeGreaterThan(size / 2 - 3);
    }
    lips.rebuild(cells, height);
    expect(lips.mesh.geometry).toBe(geometry);
    expect(holeEdges(new Set([size - 1, size]), size)).toHaveLength(8);
  });
});
