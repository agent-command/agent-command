import { describe, expect, it } from 'vitest';
import { InstancedMesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { CELL, QUEUE_ITEMS, STATS, SURFACE } from '@agent-command/game/contract';
import { model, PART, RIG } from '../src/world/models.ts';
import { UndergroundArt, crackGeometry } from '../src/world/underground.ts';
import { TerrainField, groundAt } from '../src/world/terrain.ts';
import { ICONS } from '../src/icons.ts';

const terrain = new TerrainField(48);

describe('underground art', () => {
  it('gives structures distinct silhouettes within the 320 triangle kit budget', () => {
    for (const kind of ['headframe', 'bulkhead', 'geothermal'] as const) {
      const geo = model(kind);
      expect(geo.getAttribute('position').count / 3).toBeLessThanOrEqual(320);
      expect(geo).not.toBe(model(kind === 'headframe' ? 'shaft' : 'turret'));
      expect(new Set(geo.getAttribute('accent').array)).toEqual(new Set([0, 1]));
    }
    expect(Array.from(model('headframe').getAttribute('part').array)).toContain(PART.rotor);
    expect(RIG.headframe.rotor?.idle).toBe(0);
    expect(RIG.headframe.rotor?.work).toBeGreaterThan(0);
  });

  it('accumulates four crack silhouettes', () => {
    let previous = 0;
    for (let stage = 1; stage <= 4; stage++) {
      const geo = crackGeometry(stage);
      expect(geo.getAttribute('position').count).toBeGreaterThan(previous);
      previous = geo.getAttribute('position').count;
      geo.dispose();
    }
  });

  it('embeds only listed lodes in the field and distinguishes sealed, open and rich profiles', () => {
    const codes = new Uint8Array(terrain.size * terrain.size).fill(SURFACE.ground);
    const lode = { x: 16, y: 8, rich: false, open: false, loads: 80 };
    terrain.setHeights(codes, new Map());
    const plain = groundAt(16.5, 8.5, terrain);
    const f = STATS.headframe.footprint;
    const outcrop: { x: number; y: number; before: number }[] = [];
    for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) {
      const x = lode.x + 1 - f.w / 2 + dx, y = lode.y + 1 - f.h / 2 + dy;
      outcrop.push({ x, y, before: groundAt(x, y, terrain) });
    }
    terrain.setHeights(codes, new Map(), [lode]);
    const sealed = groundAt(16.5, 8.5, terrain);
    expect(sealed).toBeGreaterThan(plain + 0.3);
    expect(groundAt(17.5, 8.5, terrain)).toBeGreaterThan(0.05);
    for (const cell of outcrop) expect(groundAt(cell.x, cell.y, terrain)).toBeGreaterThan(cell.before);
    terrain.setHeights(codes, new Map(), [{ ...lode, rich: true }]);
    expect(groundAt(16.5, 8.5, terrain)).toBeGreaterThan(sealed + 0.1);
    terrain.setHeights(codes, new Map(), [{ ...lode, open: true }]);
    expect(groundAt(16.5, 8.5, terrain)).toBeLessThan(sealed - 0.2);
    terrain.setHeights(codes, new Map([[8 * terrain.size + 16, 'crater']]), [lode]);
    expect(groundAt(16.5, 8.5, terrain)).toBeLessThan(0);
    terrain.setHeights(codes, new Map());
    expect(groundAt(16.5, 8.5, terrain)).toBeCloseTo(plain);
  });

  it('draws only provided damage on known solid cells and clears stale instances', () => {
    const view = createGame({ seed: 11 }).view('nw');
    const art = new UndergroundArt(48);
    const depths = Array<number>(48 * 48).fill(CELL.unknown);
    depths[49] = CELL.rock;
    depths[50] = CELL.tunnel;
    // the Mother Lode is never dug: no crack instance even when damage is listed on it
    depths[51] = CELL.lode;
    art.update({ ...view, depths, cracks: [{ x: 1, y: 1, stage: 4 }, { x: 2, y: 1, stage: 2 }, { x: 3, y: 1, stage: 1 }] });
    const count = () => art.depths.children.reduce((n, m) => n + (m as InstancedMesh).count, 0);
    expect(count()).toBe(1);
    art.update({ ...view, depths, cracks: [] });
    expect(count()).toBe(0);
    art.reset();
    expect(count()).toBe(0);
  });

  it('provides a distinct ink silhouette for every queue item', () => {
    expect(QUEUE_ITEMS.every((item) => Object.hasOwn(ICONS, item))).toBe(true);
    expect(new Set(QUEUE_ITEMS.map((item) => JSON.stringify(ICONS[item]))).size).toBe(QUEUE_ITEMS.length);
  });
});
