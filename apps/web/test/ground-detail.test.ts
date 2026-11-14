import { describe, expect, it } from 'vitest';
import { Group, Vector3 } from 'three/webgpu';
import { PLANE_Y, SURFACE, type View } from '@agent-command/game/contract';
import { GROUND_FADE, GroundDetail, SCATTER_CHUNK, SCATTER_SLOTS, boxDistance, groundDetailCounts, scatterChunks, scatterInstances, scatterSlots } from '../src/world/ground-detail.ts';
import { QUALITY } from '../src/world/quality.ts';
import { TerrainField } from '../src/world/terrain.ts';

/** Every (cell, slot) the lists hold, per chunk, decoded. */
function decode(size: number, cap: number, ids: Float32Array, prefix: Uint32Array) {
  const per = scatterChunks(size), room = SCATTER_CHUNK * SCATTER_CHUNK * cap, area = size * size;
  return Array.from({ length: per * per }, (_, k) => {
    const n = prefix[k * (cap + 1) + cap]!;
    return Array.from(ids.subarray(k * room, k * room + n), (v) => ({ cell: v % area, slot: Math.floor(v / area) }));
  });
}

describe('ground detail chunks', () => {
  it('lists every live slot once, in its own chunk, slot-major so a prefix caps the slots per cell', () => {
    // a size that is no multiple of the chunk: the last row and column of chunks are partial
    const size = SCATTER_CHUNK * 2 + 7, cap = 4;
    const grass = new Uint8Array(size * size), pebbles = new Uint8Array(size * size);
    for (let i = 0; i < grass.length; i++) { grass[i] = (i * 7) % 6; pebbles[i] = (i * 5) % 4; }
    const per = scatterChunks(size);
    expect(per).toBe(3);
    const ids = new Float32Array(per * per * SCATTER_CHUNK * SCATTER_CHUNK * cap), prefix = new Uint32Array(per * per * (cap + 1));
    scatterInstances(size, grass, pebbles, cap, ids, prefix);
    const lists = decode(size, cap, ids, prefix);
    const seen = new Set<number>();
    lists.forEach((list, k) => {
      const x0 = (k % per) * SCATTER_CHUNK, y0 = Math.floor(k / per) * SCATTER_CHUNK;
      list.forEach(({ cell, slot }, j) => {
        const x = cell % size, y = Math.floor(cell / size);
        expect(x >= x0 && x < x0 + SCATTER_CHUNK && y >= y0 && y < y0 + SCATTER_CHUNK).toBe(true);
        expect(slot < grass[cell]! || slot < pebbles[cell]!).toBe(true);
        expect(slot).toBeLessThan(cap);
        if (j) expect(slot).toBeGreaterThanOrEqual(list[j - 1]!.slot);
        // the prefix below slot s ends exactly where slot s starts
        expect(j < prefix[k * (cap + 1) + slot]!).toBe(false);
        expect(j).toBeLessThan(prefix[k * (cap + 1) + slot + 1]!);
        seen.add(cell * 8 + slot);
      });
    });
    let want = 0;
    for (let c = 0; c < size * size; c++) want += Math.min(cap, Math.max(grass[c]!, pebbles[c]!));
    expect(seen.size).toBe(want);
  });

  it('draws every slot up close, fewer as the tufts fade, none past the fade', () => {
    expect(scatterSlots(0, SCATTER_SLOTS)).toBe(SCATTER_SLOTS);
    expect(scatterSlots(GROUND_FADE.near, SCATTER_SLOTS)).toBe(SCATTER_SLOTS);
    expect(scatterSlots(GROUND_FADE.far, SCATTER_SLOTS)).toBe(0);
    expect(scatterSlots(GROUND_FADE.far + 10, SCATTER_SLOTS)).toBe(0);
    let last = SCATTER_SLOTS;
    for (let d = GROUND_FADE.near; d < GROUND_FADE.far; d += 0.25) {
      const s = scatterSlots(d, SCATTER_SLOTS);
      expect(s).toBeLessThanOrEqual(last);
      expect(s).toBeGreaterThanOrEqual(1);
      last = s;
    }
    expect(last).toBe(1);
    expect(scatterSlots(0, QUALITY.phone.scatter.slots)).toBe(QUALITY.phone.scatter.slots);
  });

  it('measures the distance to a chunk box (zero inside it)', () => {
    const box = new Float32Array([0, 0, 0, 2, 1, 3]);
    expect(boxDistance(1, 0.5, 1, box, 0)).toBe(0);
    expect(boxDistance(5, 0.5, 1, box, 0)).toBeCloseTo(3);
    expect(boxDistance(5, 5, 7, box, 0)).toBeCloseTo(Math.hypot(3, 4, 4));
  });
});

describe('ground detail layer', () => {
  const size = 30;
  const setup = (quality = QUALITY.full) => {
    const field = new TerrainField(size);
    // forest every third column: the ground between thickens toward it, past the low tier's slots
    const codes = new Uint8Array(size * size).fill(SURFACE.ground);
    for (let i = 0; i < codes.length; i++) if (i % size % 3 === 2) codes[i] = SURFACE.forest;
    field.setHeights(codes, new Map());
    const parent = new Group();
    const g = new GroundDetail(size, parent, field.field, undefined, quality);
    g.setMap(codes, 12345, []);
    g.setHeights();
    return { g, field, codes, parent };
  };
  const view = (holes: View['holes'] = []): View => ({ holes, entities: [], memory: [] }) as unknown as View;
  const counts = (codes: Uint8Array) => {
    const grass = new Uint8Array(size * size), pebbles = new Uint8Array(size * size);
    groundDetailCounts(codes, size, 12345, new Uint8Array(size * size), grass, pebbles);
    return { grass, pebbles };
  };
  /** Camera straight above chunk k's centre, `height` over the plane. */
  const above = (k: number, height: number) => {
    const per = scatterChunks(size);
    const x = ((k % per) + 0.5) * SCATTER_CHUNK - size / 2, z = (Math.floor(k / per) + 0.5) * SCATTER_CHUNK - size / 2;
    return new Vector3(x, PLANE_Y.surface + height, z);
  };

  it('clears claimed cells by rewriting the cell texture, never the chunk lists', () => {
    const { g, field, codes } = setup();
    const { grass, pebbles } = counts(codes);
    const hole = grass.findIndex((n) => n > 0);
    const lists = g.chunks.map((c) => Array.from(c.geometry.getAttribute('cell').array));
    const versions = () => g.chunks.map((c) => {
      const a = c.geometry.getAttribute('cell');
      return 'version' in a ? a.version : -1;
    });
    const before = versions();
    g.update(view(), field.holeAt, field.opened);
    const cells = g.cells.image.data as Uint8Array;
    expect(cells[hole * 2]).toBe(grass[hole]);
    field.holeAt.set(hole, 'crater');
    g.update(view([{ x: hole % size, y: Math.floor(hole / size), kind: 'crater' }] as View['holes']), field.holeAt, field.opened);
    expect(cells[hole * 2]).toBe(0);
    expect(cells[hole * 2 + 1]).toBe(0);
    for (let i = 0; i < size * size; i++) if (i !== hole) {
      expect(cells[i * 2]).toBe(grass[i]);
      expect(cells[i * 2 + 1]).toBe(pebbles[i]);
    }
    expect(g.chunks.map((c) => Array.from(c.geometry.getAttribute('cell').array))).toEqual(lists);
    expect(versions()).toEqual(before);
  });

  it('draws each chunk by its own distance, and nothing from the gameplay-far zoom', () => {
    const { g, codes } = setup();
    expect(Math.max(...counts(codes).grass)).toBeGreaterThan(QUALITY.phone.scatter.slots);
    const near = above(0, 4);
    g.frame(near, 10);
    expect(g.chunks[0]!.visible).toBe(true);
    const full = g.chunks[0]!.geometry.instanceCount;
    expect(full).toBeGreaterThan(0);
    // higher: the same chunk thins (its slots drop) before it goes
    g.frame(above(0, (GROUND_FADE.near + GROUND_FADE.far) / 2), 10);
    expect(g.chunks[0]!.geometry.instanceCount).toBeLessThan(full);
    expect(g.chunks[0]!.geometry.instanceCount).toBeGreaterThan(0);
    g.frame(above(0, GROUND_FADE.far + 1), 10);
    expect(g.chunks.every((c) => !c.visible)).toBe(true);
    // the rig resting past the fade hides it all, however close a chunk is
    g.frame(near, GROUND_FADE.far);
    expect(g.chunks.every((c) => !c.visible)).toBe(true);
  });

  it('bounds each chunk for frustum culling', () => {
    const { g, field } = setup();
    const per = scatterChunks(size);
    for (let k = 0; k < g.chunks.length; k++) {
      const s = g.chunks[k]!.geometry.boundingSphere!;
      const x0 = (k % per) * SCATTER_CHUNK, y0 = Math.floor(k / per) * SCATTER_CHUNK;
      for (const [x, y] of [[x0, y0], [Math.min(size, x0 + SCATTER_CHUNK), Math.min(size, y0 + SCATTER_CHUNK)]] as const) {
        const p = new Vector3(x - size / 2, PLANE_Y.surface + field.field.heightAt(x, y), y - size / 2);
        expect(p.distanceTo(s.center)).toBeLessThanOrEqual(s.radius + 1e-4);
      }
      expect(g.chunks[k]!.frustumCulled).toBe(true);
    }
  });

  it('caps the slots per cell by the render tier', () => {
    const full = setup(), phone = setup(QUALITY.phone);
    const cam = above(0, 4);
    full.g.frame(cam, 10);
    phone.g.frame(cam, 10);
    const sum = (g: GroundDetail) => g.chunks.reduce((n, c) => n + c.geometry.instanceCount, 0);
    expect(sum(phone.g)).toBeLessThan(sum(full.g));
    const phoneIds = phone.g.chunks.flatMap((c) => Array.from(c.geometry.getAttribute('cell').array.subarray(0, c.geometry.instanceCount)));
    for (const v of phoneIds) expect(Math.floor(v / (size * size))).toBeLessThan(QUALITY.phone.scatter.slots);
  });
});
