import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { ARMIES, DEFAULT_RULES, PLANES, PLANE_Y, frameOf, spirePositions } from '@agent-command/game/contract';
import { hudSafeArea } from '../src/hud-safe-area.ts';
import { CameraRig } from '../src/world/camera.ts';
import { wx, wz } from '../src/world/common.ts';

const viewport = { left: 20, top: 30, right: 1620, bottom: 930 };
const panels = {
  top: { left: 20, top: 30, right: 1620, bottom: 120 },
  bottom: { left: 300, top: 750, right: 1300, bottom: 930 },
  left: { left: 20, top: 120, right: 260, bottom: 930 },
  right: { left: 1340, top: 120, right: 1620, bottom: 930 },
};

describe('live HUD safe rectangle', () => {
  it('excludes every HUD edge and converts viewport coordinates to canvas pixels', () => {
    expect(hudSafeArea(viewport, panels)).toEqual({ left: 240, top: 90, right: 1320, bottom: 720 });
  });
  it('uses the full viewport without visible panels', () => {
    expect(hudSafeArea(viewport, {})).toEqual({ left: 0, top: 0, right: 1600, bottom: 900 });
  });
  it('clamps offscreen panels and collapses crossed bounds without inverting the area', () => {
    expect(hudSafeArea(viewport, { top: { ...panels.top, bottom: 0 }, bottom: { ...panels.bottom, top: 1000 } }))
      .toEqual({ left: 0, top: 0, right: 1600, bottom: 900 });
    expect(hudSafeArea(viewport, { left: { ...panels.left, right: 1000 }, right: { ...panels.right, left: 800 } }))
      .toEqual({ left: 880, top: 0, right: 880, bottom: 900 });
  });
});

describe('HUD-centred camera projection', () => {
  for (const [width, height] of [[1920, 1080], [1600, 900], [1280, 800], [1024, 768]]) {
    for (const army of ARMIES) {
      it(`centres home and tile/entity jumps on every plane at ${width}×${height}, ${army}`, () => {
        const rig = new CameraRig(48);
        const area = { left: 240, top: 100, right: width! - 260, bottom: height! - 220 };
        rig.resize(width!, height!);
        rig.setSafeArea(area);
        const home = spirePositions(DEFAULT_RULES.map.spireInset, 48)[army];
        rig.centerOn(frameOf(army), home);
        for (const plane of PLANES) {
          rig.goTo(plane, 0, 'jump');
          for (const tile of [home, { x: 32, y: 27 }, { x: 0, y: 64 }]) {
            rig.lookAtTile(tile.x, tile.y);
            rig.update(2000, 0, 0);
            rig.camera.updateMatrixWorld();
            const projected = new Vector3(wx(tile.x, 48), PLANE_Y[plane], wz(tile.y, 48)).project(rig.camera);
            expect((projected.x + 1) * width! / 2).toBeCloseTo((area.left + area.right) / 2, 8);
            expect((1 - projected.y) * height! / 2).toBeCloseTo((area.top + area.bottom) / 2, 8);
          }
        }
      });
    }
  }
  it('retains the logical target across resize, zoom and rotation, then resets for the lobby', () => {
    const rig = new CameraRig(48);
    rig.lookAtTile(12, 18);
    for (const [width, height] of [[1600, 900], [1024, 768]]) {
      const area = { left: 250, top: 100, right: width! - 300, bottom: height! - 250 };
      rig.resize(width!, height!);
      rig.setSafeArea(area);
      rig.zoom(100);
      rig.rotate(30, -20);
      rig.update(0, 0, 0);
      rig.camera.updateMatrixWorld();
      const projected = new Vector3(wx(12, 48), PLANE_Y.surface, wz(18, 48)).project(rig.camera);
      expect((projected.x + 1) * width! / 2).toBeCloseTo((area.left + area.right) / 2, 8);
      expect((1 - projected.y) * height! / 2).toBeCloseTo((area.top + area.bottom) / 2, 8);
      expect([rig.tx, rig.tz]).toEqual([wx(12, 48), wz(18, 48)]);
    }
    rig.setSafeArea(undefined);
    rig.update(0, 0, 0);
    rig.camera.updateMatrixWorld();
    const projected = new Vector3(wx(12, 48), PLANE_Y.surface, wz(18, 48)).project(rig.camera);
    expect(projected.x).toBeCloseTo(0, 8);
    expect(projected.y).toBeCloseTo(0, 8);
  });

  it('restores a warmup camera and resumes its active dive without counting startup time', () => {
    let now = 400;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const rig = new CameraRig(48);
      rig.resize(1600, 900);
      rig.goTo('sky', 0, 'jump');
      rig.update(now, 0, 0);
      const level = rig.level;
      const swing = rig.look.swing;
      const camera = rig.camera.clone();
      const restore = rig.saveForPreparation();
      now = 5000;
      rig.setPreparationPlane('orbit', now);
      expect(rig.level).toBe(3);
      expect(rig.focus).toBe('orbit');
      expect(rig.diving).toBe(false);
      restore();
      expect(rig.focus).toBe('sky');
      expect(rig.level).toBe(level);
      expect(rig.look.swing).toBe(swing);
      expect(rig.diving).toBe(true);
      expect(rig.camera.position.equals(camera.position)).toBe(true);
      expect(rig.camera.quaternion.equals(camera.quaternion)).toBe(true);
      expect(rig.camera.projectionMatrix.equals(camera.projectionMatrix)).toBe(true);
      rig.update(now, 0, 0);
      expect(rig.level).toBeCloseTo(level, 12);
      now += 100;
      rig.update(now, 0, 0);
      expect(rig.level).toBeGreaterThan(level);
    } finally {
      clock.mockRestore();
    }
  });
});
