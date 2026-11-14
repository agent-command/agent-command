import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstancedMesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import type { Plane } from '@agent-command/game/contract';
import { matchView } from '../src/match-view.ts';
import { AirAmbience } from '../src/world/ambient-air.ts';
import { FogField } from '../src/world/fog.ts';

const instances: AirAmbience[] = [];
afterEach(() => {
  for (const air of instances) air.dispose();
  instances.length = 0;
  vi.unstubAllGlobals();
});

function fixture() {
  const game = createGame({ seed: 11 });
  const view = matchView(game.view('nw'))!;
  const fog = new FogField(view.match.rules.map.size);
  const air = new AirAmbience(fog.size, fog);
  instances.push(air);
  air.ingest(view);
  const sky = air.group.getObjectByName('ambient-sky')!.children[0] as InstancedMesh;
  const orbit = air.group.getObjectByName('ambient-orbit')!.children[0] as InstancedMesh;
  let now = 0;
  const step = (plane: Plane, reduced = false, gap = 50) => {
    now += gap;
    air.frame(now, Math.min(0.1, gap / 1000), plane, reduced);
  };
  const start = (plane: 'sky' | 'orbit') => {
    const mesh = plane === 'sky' ? sky : orbit;
    for (let i = 0; i < 1200 && mesh.count === 0; i++) step(plane);
    expect(mesh.count).toBeGreaterThan(0);
  };
  return { game, view, fog, air, sky, orbit, step, start };
}

describe.each(['sky', 'orbit'] as const)('%s render-only ambient lifecycle', plane => {
  it('updates only the focused plane with bounded, reused instance storage', () => {
    const f = fixture();
    const mesh = plane === 'sky' ? f.sky : f.orbit;
    const inactive = plane === 'sky' ? f.orbit : f.sky;
    const storage = mesh.instanceMatrix.array;
    const inactiveVersion = inactive.instanceMatrix.version;
    f.start(plane);
    for (let i = 0; i < 60; i++) {
      f.step(plane);
      expect(mesh.instanceMatrix.array).toBe(storage);
      expect(mesh.count).toBeLessThanOrEqual(storage.length / 16);
      expect(inactive.count).toBe(0);
      expect(inactive.instanceMatrix.version).toBe(inactiveVersion);
      expect(inactive.parent!.visible).toBe(false);
    }
    const version = mesh.instanceMatrix.version;
    for (let i = 0; i < 120; i++) f.step('surface');
    expect(mesh.count).toBe(0);
    expect(mesh.instanceMatrix.version).toBe(version);
    expect(f.air.group.visible).toBe(false);
  });

  it('removes all marks immediately when current vision is lost, even over explored space', () => {
    const f = fixture();
    const mesh = plane === 'sky' ? f.sky : f.orbit;
    f.start(plane);
    // Smoothed shader fog may still be bright; decoded current visibility must win immediately.
    f.fog.explored[plane].fill(1);
    f.fog.visible[plane].fill(0);
    f.step(plane);
    expect(mesh.count).toBe(0);
    expect(f.air.group.visible).toBe(false);
    const version = mesh.instanceMatrix.version;
    for (let i = 0; i < 1200; i++) f.step(plane);
    expect(mesh.count).toBe(0);
    expect(mesh.instanceMatrix.version).toBe(version);
  });

  it('keeps every drawn silhouette inside currently visible cells', () => {
    const f = fixture();
    const mesh = plane === 'sky' ? f.sky : f.orbit;
    f.start(plane);
    const m = mesh.instanceMatrix.array;
    const x = m[12]! + f.fog.size / 2;
    const y = m[14]! + f.fog.size / 2;
    // Restrict vision to one tile; any remaining draw must fit wholly within it.
    f.fog.visible[plane].fill(0);
    f.fog.visible[plane][Math.floor(y) * f.fog.size + Math.floor(x)] = 1;
    f.step(plane);
    for (let i = 0; i < mesh.count; i++) {
      const positions = mesh.geometry.getAttribute('position');
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let vertex = 0; vertex < positions.count; vertex++) {
        const localX = positions.getX(vertex), localZ = positions.getZ(vertex);
        const px = m[i * 16]! * localX + m[i * 16 + 8]! * localZ + m[i * 16 + 12]! + f.fog.size / 2;
        const py = m[i * 16 + 2]! * localX + m[i * 16 + 10]! * localZ + m[i * 16 + 14]! + f.fog.size / 2;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      for (let cy = Math.floor(minY); cy <= Math.floor(maxY); cy++)
        for (let cx = Math.floor(minX); cx <= Math.floor(maxX); cx++)
          expect(f.fog.tileVisible(plane, cx, cy)).toBe(true);
    }
  });

  it('travels across the map on one continuous course instead of circling a local patch', () => {
    const f = fixture();
    const mesh = plane === 'sky' ? f.sky : f.orbit;
    f.start(plane);
    const m = mesh.instanceMatrix.array;
    const startX = m[12]!, startY = m[14]!;
    let previousX = startX, previousY = startY, previousCount = mesh.count;
    f.step(plane);
    const directionX = m[12]! - previousX, directionY = m[14]! - previousY;
    let travelled = 0;
    for (let frame = 0; frame < 2400; frame++) {
      f.step(plane);
      // Once the lead bird leaves the map, compaction changes which bird occupies slot zero.
      if (mesh.count < previousCount) break;
      const x = m[12]!, y = m[14]!;
      expect((x - previousX) * directionX + (y - previousY) * directionY).toBeGreaterThan(0);
      travelled = Math.hypot(x - startX, y - startY);
      previousX = x; previousY = y; previousCount = mesh.count;
    }
    expect(travelled).toBeGreaterThan(f.fog.size * 0.8);
  });

  it('continues the same course through fog without respawning near revealed terrain', () => {
    const a = fixture(), b = fixture();
    a.start(plane); b.start(plane);
    b.fog.visible[plane].fill(0);
    for (let i = 0; i < 30; i++) {
      a.step(plane); b.step(plane);
      expect((plane === 'sky' ? b.sky : b.orbit).count).toBe(0);
    }
    b.fog.visible[plane].fill(1);
    a.step(plane); b.step(plane);
    const am = plane === 'sky' ? a.sky : a.orbit;
    const bm = plane === 'sky' ? b.sky : b.orbit;
    expect(am.count).toBeGreaterThan(0);
    expect(bm.count).toBe(am.count);
    expect(bm.instanceMatrix.array).toEqual(am.instanceMatrix.array);
  });

  it('quiets reduced motion, hidden tabs and long frame gaps without catch-up', () => {
    const f = fixture();
    const mesh = plane === 'sky' ? f.sky : f.orbit;
    f.start(plane);
    f.step(plane, true);
    expect(mesh.count).toBe(0);
    f.step(plane);
    expect(mesh.count).toBe(0);
    f.start(plane);
    vi.stubGlobal('document', { hidden: true });
    const version = mesh.instanceMatrix.version;
    for (let i = 0; i < 100; i++) f.step(plane);
    expect(mesh.count).toBe(0);
    expect(mesh.instanceMatrix.version).toBe(version);
    vi.stubGlobal('document', { hidden: false });
    f.step(plane);
    expect(mesh.count).toBe(0);
    f.start(plane);
    const x = mesh.instanceMatrix.array[12]!, y = mesh.instanceMatrix.array[14]!;
    f.step(plane, false, 60_000);
    expect(mesh.count).toBe(0);
    f.step(plane);
    expect(mesh.count).toBeGreaterThan(0);
    expect(Math.hypot(mesh.instanceMatrix.array[12]! - x, mesh.instanceMatrix.array[14]! - y)).toBeLessThan(1);
  });

  it('admits a natural first crossing despite ordinary slow-renderer frames and a clamped World dt', () => {
    const f = fixture();
    const mesh = plane === 'sky' ? f.sky : f.orbit;
    let elapsed = 0;
    while (mesh.count === 0 && elapsed < 45_000) {
      // Software rendering/recording can regularly exceed 250ms; this is not a suspended tab.
      f.step(plane, false, 400);
      elapsed += 400;
    }
    expect(mesh.count).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(plane === 'sky' ? 30_000 : 45_000);
  });

  it('clears old observer and match state on army changes, rewinds and reset', () => {
    const f = fixture();
    const mesh = plane === 'sky' ? f.sky : f.orbit;
    f.start(plane);
    f.air.ingest(matchView(f.game.view('se'))!);
    expect(mesh.count).toBe(0);
    f.start(plane);
    f.air.ingest({ ...f.view, tick: f.view.tick + 100 });
    f.start(plane);
    f.air.ingest(f.view);
    expect(mesh.count).toBe(0);
    f.start(plane);
    f.air.reset();
    for (let i = 0; i < 240; i++) f.step(plane);
    expect(mesh.count).toBe(0);
    f.air.ingest(f.view);
    f.start(plane);
    f.air.ingest(undefined);
    for (let i = 0; i < 240; i++) f.step(plane);
    expect(mesh.count).toBe(0);
  });
});

it('releases owned GPU resources once and cannot restart after disposal', () => {
  const f = fixture();
  f.start('sky');
  const disposed = vi.fn();
  for (const mesh of [f.sky, f.orbit]) {
    mesh.addEventListener('dispose', disposed);
    mesh.geometry.addEventListener('dispose', disposed);
    const material = mesh.material;
    if (Array.isArray(material)) throw new Error('Expected one ambience material per draw');
    material.addEventListener('dispose', disposed);
  }
  f.air.dispose();
  expect(disposed).toHaveBeenCalledTimes(6);
  f.air.dispose();
  f.air.ingest(f.view);
  for (let i = 0; i < 240; i++) f.step('sky');
  expect(disposed).toHaveBeenCalledTimes(6);
  expect(f.air.group.children).toHaveLength(0);
  expect(f.air.group.visible).toBe(false);
});
