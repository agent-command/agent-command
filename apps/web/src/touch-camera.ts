/**
 * Touch camera gestures on Pointer Events (`pointerType === 'touch'`; mouse and pen keep their own handlers): one finger
 * drags the ground under it, two fingers pan with their midpoint, pinch to zoom and twist to turn the camera. A touch
 * that never travels past TAP_SLOP_PX with one finger is a tap. Fixed two-finger state, no allocation per move.
 */
import { Vector3 } from 'three/webgpu';
import type { CameraRig } from './world/camera.ts';

/** The canvas rectangle pointer coordinates are taken against (CSS px; `World.viewport`). */
export interface TouchViewport { left: number; top: number; width: number; height: number }

/** Travel (CSS px) under which a one-finger touch is still a tap. */
export const TAP_SLOP_PX = 8;
/** Per-move pinch factor bounds: a finger landing or lifting between two moves can't snap the zoom. */
export const PINCH_STEP_MIN = 0.5;
export const PINCH_STEP_MAX = 2;

/** One pinch step: finger spread now over spread before, clamped to [PINCH_STEP_MIN, PINCH_STEP_MAX]; 1 if undefined. */
export function pinchScale(before: number, now: number): number {
  if (!(before > 0) || !(now > 0)) return 1;
  return Math.min(PINCH_STEP_MAX, Math.max(PINCH_STEP_MIN, now / before));
}

const ray = new Vector3();
const from = { x: 0, z: 0 };
const to = { x: 0, z: 0 };

/** The focus plane's point (world x/z) under a screen point; false when the ray runs level or upward. */
function groundUnder(rig: CameraRig, x: number, y: number, view: TouchViewport, out: { x: number; z: number }): boolean {
  const camera = rig.camera;
  ray.set(((x - view.left) / view.width) * 2 - 1, 1 - ((y - view.top) / view.height) * 2, 0.5).unproject(camera).sub(camera.position);
  if (ray.y > -1e-6) return false;
  const t = (rig.ty - camera.position.y) / ray.y;
  out.x = camera.position.x + ray.x * t;
  out.z = camera.position.z + ray.z * t;
  return true;
}

/**
 * Pan so the ground under a finger that moved from (x0, y0) to (x1, y1) stays under it: both points are cast onto the
 * focus plane and the camera shifts by their difference. Rays from one camera pose differ by the same shift whatever
 * that pose's offset, so several moves inside one frame (the pose updates per frame) still add up exactly.
 */
export function dragPan(rig: CameraRig, x0: number, y0: number, x1: number, y1: number, view: TouchViewport): void {
  rig.camera.updateMatrixWorld();
  if (!groundUnder(rig, x0, y0, view, from) || !groundUnder(rig, x1, y1, view, to)) return;
  // World shift → the rig's screen-relative pan (inverse of CameraRig.pan's basis), so its map clamp still applies.
  const dx = from.x - to.x, dz = from.z - to.z;
  const s = Math.sin(rig.yaw), c = Math.cos(rig.yaw);
  rig.pan(dx * s - dz * c, dx * c + dz * s);
}

/** A signed angle difference wrapped to (−π, π]. */
function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

export class TouchGesture {
  /** Pointer ids of the (at most two) tracked fingers; -1 = free slot. */
  private readonly ids = [-1, -1];
  private readonly xs = [0, 0];
  private readonly ys = [0, 0];
  private fingers = 0;
  /** Still a tap candidate: one finger, under the slop. */
  private tap = false;
  private startX = 0;
  private startY = 0;
  /** True from the first move past the slop (or the second finger) until every finger lifts. */
  moved = false;

  /** A finger landed; a third is ignored (false). */
  down(id: number, x: number, y: number): boolean {
    const slot = this.ids[0] === -1 ? 0 : this.ids[1] === -1 ? 1 : -1;
    if (slot < 0) return false;
    this.ids[slot] = id;
    this.xs[slot] = x;
    this.ys[slot] = y;
    this.fingers++;
    if (this.fingers === 1) {
      this.tap = true;
      this.moved = false;
      this.startX = x;
      this.startY = y;
    } else {
      this.tap = false;
      this.moved = true;
    }
    return true;
  }

  /** A tracked finger moved: apply the gesture to `rig` (pointer coordinates against `view`). False if not ours. */
  move(id: number, x: number, y: number, rig: CameraRig, view: TouchViewport): boolean {
    const slot = this.ids[0] === id ? 0 : this.ids[1] === id ? 1 : -1;
    if (slot < 0) return false;
    if (this.fingers === 1) {
      if (this.tap && Math.hypot(x - this.startX, y - this.startY) < TAP_SLOP_PX) return true;
      this.tap = false;
      this.moved = true;
      dragPan(rig, this.xs[slot]!, this.ys[slot]!, x, y, view);
      this.xs[slot] = x;
      this.ys[slot] = y;
      return true;
    }
    const other = 1 - slot;
    const ox = this.xs[other]!, oy = this.ys[other]!;
    const px = this.xs[slot]!, py = this.ys[slot]!;
    // The midpoint carries the ground; spread and twist are measured from the still finger.
    dragPan(rig, (px + ox) / 2, (py + oy) / 2, (x + ox) / 2, (y + oy) / 2, view);
    const scale = pinchScale(Math.hypot(px - ox, py - oy), Math.hypot(x - ox, y - oy));
    if (scale !== 1) rig.zoomBy(scale);
    // Screen angles grow clockwise (y down); the map turns with the fingers, so the camera turns the other way.
    rig.yaw -= wrapAngle(Math.atan2(y - oy, x - ox) - Math.atan2(py - oy, px - ox));
    this.xs[slot] = x;
    this.ys[slot] = y;
    return true;
  }

  /** A finger lifted or was cancelled. True when it ends a tap (one finger that never left the slop). */
  up(id: number): boolean {
    const slot = this.ids[0] === id ? 0 : this.ids[1] === id ? 1 : -1;
    if (slot < 0) return false;
    this.ids[slot] = -1;
    this.fingers--;
    return this.fingers === 0 && this.tap;
  }

  reset(): void {
    this.ids[0] = this.ids[1] = -1;
    this.fingers = 0;
    this.tap = false;
    this.moved = false;
  }
}
