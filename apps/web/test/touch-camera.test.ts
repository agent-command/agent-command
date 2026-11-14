import { describe, expect, it } from 'vitest';
import { Plane, Raycaster, Vector2, Vector3 } from 'three/webgpu';
import { PINCH_STEP_MAX, PINCH_STEP_MIN, TAP_SLOP_PX, TouchGesture, dragPan, pinchScale } from '../src/touch-camera.ts';
import { CameraRig } from '../src/world/camera.ts';

const W = 412;
const H = 915;
const view = { left: 0, top: 0, width: W, height: H };

function rigAt(): CameraRig {
  const rig = new CameraRig(48);
  rig.resize(W, H);
  rig.update(0, 0, 0);
  rig.camera.updateMatrixWorld();
  return rig;
}

/** The focus plane's point under a screen pixel (an independent raycast). */
function groundAt(rig: CameraRig, x: number, y: number): Vector3 {
  const ray = new Raycaster();
  ray.setFromCamera(new Vector2((x / W) * 2 - 1, 1 - (y / H) * 2), rig.camera);
  return ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -rig.ty), new Vector3())!;
}

/** Where a world point lands on the 412×915 screen (CSS px). */
function screenOf(rig: CameraRig, point: Vector3): { x: number; y: number } {
  rig.camera.updateMatrixWorld();
  const v = point.clone().project(rig.camera);
  return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H };
}

describe('touch pan', () => {
  it('keeps the ground under the finger, anywhere on screen', () => {
    for (const [x0, y0, x1, y1] of [[206, 457, 236, 457], [60, 120, 140, 260], [380, 860, 300, 700]] as const) {
      const rig = rigAt();
      const ground = groundAt(rig, x0, y0);
      dragPan(rig, x0, y0, x1, y1, view);
      rig.update(0, 0, 0);
      const at = screenOf(rig, ground);
      expect(Math.hypot(at.x - x1, at.y - y1)).toBeLessThan(0.01);
    }
  });
  it('adds up several moves inside one frame', () => {
    const rig = rigAt();
    const ground = groundAt(rig, 100, 300);
    const touch = new TouchGesture();
    touch.down(1, 100, 300);
    for (const [x, y] of [[120, 330], [150, 360], [190, 420]] as const) touch.move(1, x, y, rig, view);
    rig.update(0, 0, 0);
    const at = screenOf(rig, ground);
    expect(Math.hypot(at.x - 190, at.y - 420)).toBeLessThan(0.01);
  });
  it('pans only past the tap slop, and a still touch is a tap', () => {
    const rig = rigAt();
    const touch = new TouchGesture();
    touch.down(1, 200, 400);
    touch.move(1, 200 + TAP_SLOP_PX - 1, 400, rig, view);
    expect([rig.tx, rig.tz]).toEqual([0, 0]);
    expect(touch.up(1)).toBe(true);
    touch.down(2, 200, 400);
    touch.move(2, 200 + TAP_SLOP_PX + 20, 400, rig, view);
    expect(Math.hypot(rig.tx, rig.tz)).toBeGreaterThan(0);
    expect(touch.up(2)).toBe(false);
  });
});

describe('pinch', () => {
  it('scales by the finger spread, clamped per step', () => {
    expect(pinchScale(100, 120)).toBeCloseTo(1.2);
    expect(pinchScale(100, 900)).toBe(PINCH_STEP_MAX);
    expect(pinchScale(100, 5)).toBe(PINCH_STEP_MIN);
    expect(pinchScale(0, 50)).toBe(1);
  });
  it('zooms the rig within its distance range and twists with the fingers', () => {
    const rig = rigAt();
    const touch = new TouchGesture();
    const dist = rig.dist;
    touch.down(1, 100, 500);
    touch.down(2, 300, 500);
    touch.move(2, 400, 500, rig, view);
    expect(rig.dist).toBeCloseTo(dist / 1.5);
    // Spread on and on: the rig stops at its closest distance.
    for (let x = 400; x < 4000; x += 300) touch.move(2, x + 300, 500, rig, view);
    expect(rig.dist).toBe(12);
    // A quarter turn clockwise on screen turns the camera a quarter turn the other way.
    const yaw = rig.yaw;
    touch.move(2, 100, 500 + 3900, rig, view);
    expect(rig.yaw).toBeCloseTo(yaw - Math.PI / 2);
    expect(touch.up(2)).toBe(false);
    expect(touch.up(1)).toBe(false);
  });
});
