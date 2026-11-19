import { describe, expect, it, vi } from 'vitest';
import type { InstancedMesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { CELL, PLANE_Y, SURFACE, type Plane } from '@agent-command/game/contract';
import { matchView } from '../src/match-view.ts';
import { GroundAmbience } from '../src/world/ambient-ground.ts';
import { FogField } from '../src/world/fog.ts';
import { TerrainField } from '../src/world/terrain.ts';

function habitat() {
  const view = matchView(createGame({ seed: 19 }).view('nw'))!;
  const size = view.match.rules.map.size;
  const fog = new FogField(size);
  const terrain = new TerrainField(size);
  // Flyovers must work over water and clear ground too, not depend on a forest roost.
  terrain.terrainCodes.fill(SURFACE.water);
  view.depths.fill(CELL.tunnel);
  const ambience = new GroundAmbience(size, fog, terrain);
  ambience.ingest(view);
  const depths = ambience.group.children[0] as InstancedMesh;
  const surface = ambience.group.children[1] as InstancedMesh;
  return { view, size, fog, ambience, depths, surface };
}

function appears(ambience: GroundAmbience, mesh: InstancedMesh, plane: Plane): boolean {
  let seen = false;
  for (let i = 0; i < 900; i++) {
    ambience.frame(i * 100, .1, plane, false);
    seen ||= mesh.visible;
  }
  return seen;
}

/** Degenerate matrices suppress individual silhouettes at fog boundaries without repacking stable slots. */
function shown(mesh: InstancedMesh, i: number): boolean {
  return mesh.visible && mesh.instanceMatrix.array[i * 16 + 5]! > .1;
}

describe('render-only travelling ground wildlife', () => {
  it('takes a coherent map-scale Surface course, then leaves a genuine quiet interval', () => {
    const { ambience, surface, depths, size } = habitat();
    try {
      let firstX = Number.NaN, firstY = 0, greatestDistance = 0;
      let quiet = 0, longestQuiet = 0, sawFlight = false;
      for (let frame = 0; frame < 900; frame++) {
        ambience.frame(frame * 100, .1, 'surface', false);
        expect(depths.visible).toBe(false);
        if (shown(surface, 0)) {
          const x = surface.instanceMatrix.array[12]!, y = surface.instanceMatrix.array[14]!;
          if (Number.isNaN(firstX)) { firstX = x; firstY = y; }
          greatestDistance = Math.max(greatestDistance, Math.hypot(x - firstX, y - firstY));
          sawFlight = true;
          quiet = 0;
        } else if (sawFlight) longestQuiet = Math.max(longestQuiet, quiet += .1);
      }
      expect(greatestDistance).toBeGreaterThan(size * .65);
      expect(longestQuiet).toBeGreaterThan(10);
    } finally { ambience.dispose(); }
  });

  it('skitters and stops along an observed corridor without crossing its walls or floating above the floor', () => {
    const { ambience, depths, view, size } = habitat();
    view.depths.fill(CELL.rock);
    const row = Math.floor(size / 2);
    for (let x = 2; x < size - 2; x++) view.depths[row * size + x] = CELL.tunnel;
    ambience.ingest(view);
    try {
      const previous = new Map<number, { x: number; y: number }>();
      let moved = false, stopped = false, quiet = 0, longestQuiet = 0;
      for (let frame = 0; frame < 900; frame++) {
        ambience.frame(frame * 100, .1, 'depths', false);
        let count = 0;
        for (let i = 0; i < depths.count; i++) {
          if (!shown(depths, i)) { previous.delete(i); continue; }
          count++;
          const matrix = depths.instanceMatrix.array;
          const x = matrix[i * 16 + 12]! + size / 2, y = matrix[i * 16 + 14]! + size / 2;
          expect(matrix[i * 16 + 13]).toBeGreaterThanOrEqual(PLANE_Y.depths);
          expect(matrix[i * 16 + 13]).toBeLessThan(PLANE_Y.depths + .2);
          for (const dx of [-.4, .4]) for (const dy of [-.4, .4]) {
            expect(view.depths[Math.floor(y + dy) * size + Math.floor(x + dx)]).toBe(CELL.tunnel);
          }
          const old = previous.get(i);
          if (old) {
            const distance = Math.hypot(x - old.x, y - old.y);
            moved ||= distance > .01 && distance < .2;
            stopped ||= distance < .0001;
          }
          previous.set(i, { x, y });
        }
        expect(count).toBeLessThanOrEqual(3);
        if (count) quiet = 0;
        else longestQuiet = Math.max(longestQuiet, quiet += .1);
      }
      expect(moved).toBe(true);
      expect(stopped).toBe(true);
      expect(longestQuiet).toBeGreaterThan(3);
    } finally { ambience.dispose(); }
  });

  it('admits no silhouette in explored-only fog and revokes mid-hop tunnel knowledge', () => {
    const { ambience, depths, surface, fog, view } = habitat();
    try {
      expect(appears(ambience, depths, 'depths')).toBe(true);
      view.depths.fill(CELL.magma);
      ambience.ingest(view);
      expect(appears(ambience, depths, 'depths')).toBe(false);
      view.depths.fill(CELL.unknown);
      expect(appears(ambience, depths, 'depths')).toBe(false);
      view.depths.fill(CELL.tunnel);
      fog.visible.depths.fill(0);
      fog.visible.surface.fill(0);
      fog.explored.depths.fill(1);
      fog.explored.surface.fill(1);
      expect(appears(ambience, depths, 'depths')).toBe(false);
      expect(appears(ambience, surface, 'surface')).toBe(false);
      ambience.ingest({ ...view, army: 'se', tick: view.tick + 1 });
      expect(appears(ambience, depths, 'depths')).toBe(false);
      expect(appears(ambience, surface, 'surface')).toBe(false);
    } finally { ambience.dispose(); }
  });

  it('never exposes a bird wing past a current-vision boundary', () => {
    const { ambience, surface, fog, size } = habitat();
    fog.visible.surface.fill(0);
    for (let y = 4; y < size - 4; y++) for (let x = 4; x < size / 2; x++) fog.visible.surface[y * size + x] = 1;
    try {
      let seen = false;
      for (let frame = 0; frame < 900; frame++) {
        ambience.frame(frame * 100, .1, 'surface', false);
        for (let i = 0; i < surface.count; i++) if (shown(surface, i)) {
          seen = true;
          const x = surface.instanceMatrix.array[i * 16 + 12]! + size / 2;
          const y = surface.instanceMatrix.array[i * 16 + 14]! + size / 2;
          for (const dx of [-.6, 0, .6]) for (const dy of [-.6, 0, .6]) {
            expect(fog.tileVisible('surface', x + dx, y + dy)).toBe(true);
          }
        }
      }
      expect(seen).toBe(true);
    } finally { ambience.dispose(); }
  });

  it('retains buffers, stays inactive on other planes and during reduced motion, and clears reset state', () => {
    const { ambience, depths, surface } = habitat();
    try {
      const storage = surface.instanceMatrix.array;
      expect(appears(ambience, surface, 'surface')).toBe(true);
      expect(surface.instanceMatrix.array).toBe(storage);
      const version = surface.instanceMatrix.version;
      ambience.frame(1e8, 1e6, 'orbit', false);
      ambience.frame(2e8, 1e6, 'surface', true);
      expect(surface.visible).toBe(false);
      expect(depths.visible).toBe(false);
      expect(surface.instanceMatrix.version).toBe(version);
      ambience.reset();
      expect(surface.count).toBe(0);
      expect(depths.count).toBe(0);
      expect(appears(ambience, surface, 'surface')).toBe(false);
      expect(appears(ambience, depths, 'depths')).toBe(false);
    } finally { ambience.dispose(); }
  });

  it('keeps a flyover on active wall time when World supplies a capped physics delta', () => {
    const fast = habitat(), slow = habitat();
    try {
      fast.ambience.frame(0, .1, 'surface', false);
      slow.ambience.frame(0, .1, 'surface', false);
      let compared = 0;
      for (let now = 500; now <= 30000; now += 500) {
        for (let step = now - 400; step <= now; step += 100) fast.ambience.frame(step, .1, 'surface', false);
        slow.ambience.frame(now, .1, 'surface', false);
        if (shown(fast.surface, 0) && shown(slow.surface, 0)) {
          compared++;
          const a = fast.surface.instanceMatrix.array, b = slow.surface.instanceMatrix.array;
          // The event can start within one slow frame of the fast renderer, not run five times slower.
          expect(Math.hypot(a[12]! - b[12]!, a[14]! - b[14]!)).toBeLessThan(2);
        }
      }
      expect(compared).toBeGreaterThan(5);
    } finally { fast.ambience.dispose(); slow.ambience.dispose(); }
  });

  it('keeps slow-frame skitter movement confined and skips suspension/preparation time', () => {
    const { ambience, depths, view, size } = habitat();
    view.depths.fill(CELL.rock);
    const row = Math.floor(size / 2);
    for (let x = 2; x < size - 2; x++) view.depths[row * size + x] = CELL.tunnel;
    ambience.ingest(view);
    try {
      let seen = false;
      for (let now = 0; now <= 60000; now += 500) {
        ambience.frame(now, .1, 'depths', false);
        for (let i = 0; i < depths.count; i++) if (shown(depths, i)) {
          seen = true;
          const x = depths.instanceMatrix.array[i * 16 + 12]! + size / 2;
          const y = depths.instanceMatrix.array[i * 16 + 14]! + size / 2;
          for (const dx of [-.4, .4]) for (const dy of [-.4, .4])
            expect(view.depths[Math.floor(y + dy) * size + Math.floor(x + dx)]).toBe(CELL.tunnel);
        }
      }
      expect(seen).toBe(true);
      const version = depths.instanceMatrix.version;
      ambience.frame(160000, .1, 'depths', false);
      expect(depths.visible).toBe(false);
      expect(depths.instanceMatrix.version).toBe(version);
      ambience.frame(260000, 0, 'depths', false);
      ambience.frame(360000, .1, 'depths', false);
      expect(depths.instanceMatrix.version).toBe(version);
    } finally { ambience.dispose(); }
  });

  it('releases owned geometry and instance resources once and cannot readmit a disposed match', () => {
    const { ambience, depths, surface, view } = habitat();
    const geometry = vi.fn(), instances = vi.fn();
    surface.geometry.addEventListener('dispose', geometry);
    depths.geometry.addEventListener('dispose', geometry);
    surface.addEventListener('dispose', instances);
    depths.addEventListener('dispose', instances);
    ambience.dispose();
    ambience.dispose();
    ambience.ingest(view);
    expect(appears(ambience, surface, 'surface')).toBe(false);
    expect(ambience.group.children).toHaveLength(0);
    expect(geometry).toHaveBeenCalledTimes(2);
    expect(instances).toHaveBeenCalledTimes(2);
  });
});
