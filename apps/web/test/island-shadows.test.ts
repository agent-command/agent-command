import { afterEach, describe, expect, it } from 'vitest';
import { createGame } from '@agent-command/game';
import { PLANE_Y, type View } from '@agent-command/game/contract';
import { wx, wz } from '../src/world/common.ts';
import { Entities, type Track } from '../src/world/entities.ts';
import { applyFade } from '../src/world/fade.ts';
import { IslandShadows, PROFILE_BINS, SHADOW_CAP, SUN_SHIFT } from '../src/world/island-shadows.ts';
import { SUN_DIR } from '../src/world/materials.ts';

afterEach(() => applyFade(1));

const islandTracks = (units: Entities): Track[] => [...units.tracks.values()].filter((tr) => tr.e.kind === 'island');

/** Instance n sits on its island's interpolated position, leaning SUN_SHIFT tiles away from the sun, on the Surface. */
function expectFollows(shadows: IslandShadows, tracks: Track[], size: number): void {
  const sl = Math.hypot(SUN_DIR.x, SUN_DIR.z);
  const ox = (-SUN_DIR.x / sl) * SUN_SHIFT, oy = (-SUN_DIR.z / sl) * SUN_SHIFT;
  const m = shadows.mesh.instanceMatrix.array;
  expect(shadows.mesh.count).toBe(tracks.length);
  tracks.forEach((tr, n) => {
    expect(m[n * 16 + 12]).toBeCloseTo(wx(tr.rx + ox, size), 4);
    expect(m[n * 16 + 13]).toBe(PLANE_Y.surface);
    expect(m[n * 16 + 14]).toBeCloseTo(wz(tr.ry + oy, size), 4);
  });
}

describe('Sky island shadows on the Surface', () => {
  it('draw every island silhouette at its interpolated track, regardless of Sky visibility, in one bounded draw', () => {
    const view = createGame({ seed: 11 }).view('nw');
    const size = view.match!.rules.map.size;
    const islands = view.entities.filter((e) => e.kind === 'island');
    expect(islands.length).toBeGreaterThan(1);
    expect(islands.length).toBeLessThanOrEqual(SHADOW_CAP);
    const units = new Entities(false, undefined, size);
    const shadows = new IslandShadows(size);
    // Surface focused: the Sky (and so each island track) is faded out, yet island positions are public.
    applyFade(1);
    units.ingest(view, 1000);
    units.frame(1000, 1, new Set(), undefined, 'nw', 'surface', 30);
    shadows.frame(units.tracks, units.root);
    const tracks = islandTracks(units);
    expect(tracks.length).toBe(islands.length);
    expect(tracks.every((tr) => !tr.visible)).toBe(true);
    expectFollows(shadows, tracks, size);
    expect(Math.hypot(SUN_DIR.x, SUN_DIR.z)).toBeGreaterThan(0);
    expect(SUN_SHIFT).toBeLessThanOrEqual(2);

    // Each profile is the island's blob outline, not a circle, normalised to a plausible island radius.
    for (const island of islands) {
      const row = shadows.rows.get(island.id)!;
      expect(row).toBeGreaterThanOrEqual(0);
      const bins = shadows.profile.subarray(row * PROFILE_BINS, (row + 1) * PROFILE_BINS);
      expect(Math.max(...bins)).toBe(255);
      expect(Math.max(...bins) - Math.min(...bins)).toBeGreaterThan(20);
      expect(shadows.radius[row]).toBeGreaterThan(1.5);
      expect(shadows.radius[row]).toBeLessThan(6);
    }

    // Per-frame writes reuse the same storage and never rebuild a profile.
    const matrix = shadows.mesh.instanceMatrix.array, profile = shadows.profile, rows = [...shadows.rows];
    const version = shadows.mesh.instanceMatrix.version;

    // A drifting island: the shadow follows the interpolated track, not the snapshot.
    const moved = islands[0]!;
    const later: View = { ...view, tick: view.tick + 1, entities: view.entities.map((e) => (e.id === moved.id ? { ...e, x: e.x + 0.6, y: e.y - 0.4 } : e)) };
    units.ingest(later, 1050);
    for (const now of [1060, 1090, 1400]) {
      units.frame(now, now / 1000, new Set(), undefined, 'nw', 'surface', 30);
      shadows.frame(units.tracks, units.root);
      expectFollows(shadows, islandTracks(units), size);
    }
    const track = units.tracks.get(moved.id)!;
    expect(track.rx).toBeGreaterThan(moved.x + 0.3);
    expect(shadows.mesh.instanceMatrix.version).toBeGreaterThan(version);
    expect(shadows.mesh.instanceMatrix.array).toBe(matrix);
    expect(shadows.profile).toBe(profile);
    expect([...shadows.rows]).toEqual(rows);

    // An island leaving the view takes its shadow with it.
    const fewer: View = { ...later, tick: later.tick + 1, entities: later.entities.filter((e) => e.id !== moved.id) };
    units.ingest(fewer, 1450);
    units.frame(1460, 1.46, new Set(), undefined, 'nw', 'surface', 30);
    shadows.frame(units.tracks, units.root);
    expect(islandTracks(units).length).toBe(islands.length - 1);
    expectFollows(shadows, islandTracks(units), size);

    shadows.reset();
    expect(shadows.mesh.count).toBe(0);
    expect(shadows.rows.size).toBe(0);
  });
});
