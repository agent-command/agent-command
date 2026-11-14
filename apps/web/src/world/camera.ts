/**
 * RTS camera rig with the plane dive: pan (keys, edge, drag), zoom, rotate, and a swooping
 * ascent/descent between stacked planes. `level` is the continuous plane index the fades follow; `look` is the dive's
 * frame for the ink pass's plane transition (`dive.ts`).
 */
import { PerspectiveCamera } from 'three/webgpu';
import { PLANES, PLANE_Y, type Plane } from '@agent-command/game/contract';
import { clamp, lerp, wx, wz } from './common.ts';
import { DIVES, diveLook, diveStyle, restingLook, type DiveKind, type DiveStyle } from './dive.ts';
import type { ViewportRect } from '../hud-safe-area.ts';

const FOV = 50;

function planeYAt(level: number): number {
  const i = clamp(Math.floor(level), 0, PLANES.length - 1);
  const j = clamp(i + 1, 0, PLANES.length - 1);
  return lerp(PLANE_Y[PLANES[i]!], PLANE_Y[PLANES[j]!], level - i);
}

export class CameraRig {
  readonly camera = new PerspectiveCamera(FOV, 1, 0.5, 900);
  /** Logical focus point in world x/z, projected at the HUD-safe area's centre. */
  tx = 0;
  tz = 0;
  /** World height of the focus point (the plane the camera rests on or dives between), as of the last update. */
  ty = 0;
  yaw = Math.PI * 0.25;
  pitch = 1.0;
  dist = 30;
  level = 1;
  focus: Plane = 'surface';
  private dive: { from: number; to: number; t0: number; ms: number; fx: number; style: DiveStyle } | undefined;
  /** The dive's frame (all zero at rest); written in place every update. */
  readonly look = restingLook();
  /** Held pan directions; the key layout (arrows, optionally WASD) is mapped in controls.ts. */
  readonly keys = new Set<'up' | 'down' | 'left' | 'right'>();
  edge = { x: 0, y: 0 };
  private shakeT = 0;
  private hold: number | undefined;
  private width = 1;
  private height = 1;
  private safeArea: ViewportRect | undefined;


  size: number;

  constructor(size: number) {
    this.size = size;
    this.dist *= size / 48;
  }

  setSize(size: number): void {
    if (size === this.size) return;
    this.dist *= size / this.size;
    this.size = size;
  }
  get framingArea(): ViewportRect | undefined { return this.safeArea; }

  setSafeArea(area: ViewportRect | undefined): void {
    this.safeArea = area;
  }

  /**
   * Centre on an army's Spire at `at` (its `matchData.armies[].spireAt`), looking across the map from behind it. The
   * NW army (frame 0) looks from yaw 1.25π; each frame turns the camera by the same quarter turn as its corner.
   */
  centerOn(frame: number, at: { x: number; y: number }): void {
    this.lookAtTile(at.x, at.y);
    this.yaw = Math.PI * ((1.25 + frame * 0.5) % 2);
  }

  lookAtTile(x: number, y: number): void {
    this.tx = wx(x, this.size);
    this.tz = wz(y, this.size);
  }

  /**
   * Dive to `plane`. Choosing the plane a dive is already heading for lands it at once (the transition is skippable);
   * any other plane retargets from where the camera is.
   */
  goTo(plane: Plane, now: number, kind: DiveKind): void {
    const to = PLANES.indexOf(plane);
    if (this.dive?.to === to) return this.land();
    if (!this.dive && to === Math.round(this.level)) return;
    const { ms, fx } = DIVES[kind];
    this.dive = { from: this.level, to, t0: now, ms, fx, style: diveStyle(kind) };
    this.focus = plane;
  }

  /** +1 while diving up, -1 while diving down, 0 at rest. */
  get diveDir(): number {
    return this.dive ? Math.sign(this.dive.to - this.dive.from) : 0;
  }

  private land(): void {
    if (this.dive) this.level = this.dive.to;
    this.dive = undefined;
    diveLook(this.look, 0, 0, 'plain', 0);
  }

  /** Hold the current dive at progress k (0..1); `undefined` releases it. Debug/screenshot hook. */
  holdDive(k: number | undefined): void {
    this.hold = k;
  }

  get diving(): boolean {
    return this.dive !== undefined;
  }

  /** Startup-only snapshot: resume even an in-flight dive where it paused, not after the warmup's elapsed time. */
  saveForPreparation(): () => void {
    const at = performance.now();
    const camera = this.camera.clone();
    const { tx, tz, level, focus, dive, hold, shakeT } = this;
    const look = { ...this.look };
    return () => {
      this.tx = tx;
      this.tz = tz;
      this.level = level;
      this.focus = focus;
      this.dive = dive ? { ...dive, t0: dive.t0 + performance.now() - at } : undefined;
      this.hold = hold;
      Object.assign(this.look, look);
      this.shakeT = shakeT;
      this.camera.copy(camera);
    };
  }

  /** Place an exact startup view without animating; pair with saveForPreparation(). */
  setPreparationPlane(plane: Plane, now: number): void {
    this.land();
    this.hold = undefined;
    this.focus = plane;
    this.level = PLANES.indexOf(plane);
    this.update(now, 0, 0);
  }

  update(now: number, dt: number, shake: number): void {
    // pan
    const speed = (this.dist / 34) * 26 * dt;
    let px = 0;
    let pz = 0;
    if (this.keys.has('up')) pz -= 1;
    if (this.keys.has('down')) pz += 1;
    if (this.keys.has('left')) px -= 1;
    if (this.keys.has('right')) px += 1;
    px += this.edge.x;
    pz += this.edge.y;
    if (px || pz) this.pan(px * speed, pz * speed);

    let fov = 0;
    let swing = 0;
    const dive = this.dive;
    if (dive) {
      const k = this.hold ?? clamp((now - dive.t0) / dive.ms, 0, 1);
      const look = diveLook(this.look, k, Math.abs(dive.to - dive.from), dive.style, dive.fx);
      this.level = lerp(dive.from, dive.to, look.ease);
      swing = look.swing;
      fov = look.fov;
      if (k >= 1) this.land();
    }
    const pitch = clamp(this.pitch + swing * 0.38, 0.45, 1.5);
    const dist = this.dist + swing * 16;
    this.camera.fov = FOV + fov;
    this.camera.updateProjectionMatrix();

    const ty = this.ty = planeYAt(this.level);
    const c = this.camera;
    c.position.set(
      this.tx + Math.cos(this.yaw) * Math.cos(pitch) * dist,
      ty + Math.sin(pitch) * dist,
      this.tz + Math.sin(this.yaw) * Math.cos(pitch) * dist,
    );
    this.shakeT += dt;
    if (shake > 0.01) {
      c.position.x += Math.sin(this.shakeT * 53) * shake * 0.5;
      c.position.y += Math.sin(this.shakeT * 61 + 1) * shake * 0.4;
    }
    c.lookAt(this.tx, ty, this.tz);
    const area = this.safeArea;
    if (area) {
      // Translate along camera right/up without changing its orientation or frustum. The logical
      // target then projects at the clear rectangle's centre; picking and scopes use the
      // same ordinary camera matrices. CSS pixels cancel here, independent of device pixel ratio.
      const halfHeight = dist * Math.tan(c.fov * Math.PI / 360);
      const right = (1 - (area.left + area.right) / this.width) * halfHeight * c.aspect;
      const up = ((area.top + area.bottom) / this.height - 1) * halfHeight;
      const cosYaw = Math.cos(this.yaw);
      const sinYaw = Math.sin(this.yaw);
      c.position.x += sinYaw * right - cosYaw * Math.sin(pitch) * up;
      c.position.y += Math.cos(pitch) * up;
      c.position.z += -cosYaw * right - sinYaw * Math.sin(pitch) * up;
    }
  }

  pan(dx: number, dz: number): void {
    // screen-relative: forward is from camera toward target
    const fx = -Math.cos(this.yaw);
    const fz = -Math.sin(this.yaw);
    const rx = -fz;
    const rz = fx;
    this.tx = clamp(this.tx + rx * dx + fx * -dz, -this.size / 2 - 4, this.size / 2 + 4);
    this.tz = clamp(this.tz + rz * dx + fz * -dz, -this.size / 2 - 4, this.size / 2 + 4);
  }

  /** Zoom limits (world units = tiles): the wheel and the auto-director share them. */
  get minDist(): number { return 12; }
  get maxDist(): number { return 78 * this.size / 48; }

  zoom(delta: number): void {
    this.zoomBy(Math.exp(-delta * 0.0012));
  }

  /** Zoom in by `scale` (> 1 closer, a pinch spreading), within the zoom limits. */
  zoomBy(scale: number): void {
    this.dist = clamp(this.dist / scale, this.minDist, this.maxDist);
  }

  /**
   * Camera distance at which a ground disc of `radius` tiles round the focus fills the HUD-safe clear area, times
   * `padding` (1 = touching its nearer edges). The tilted ground footprint is taken at the focus: its depth is the
   * vertical half-extent over sin(pitch). Unclamped; callers clamp to the zoom limits.
   */
  fitDistance(radius: number, padding: number): number {
    const area = this.safeArea;
    const w = area ? Math.max(1, area.right - area.left) / this.width : 1;
    const h = area ? Math.max(1, area.bottom - area.top) / this.height : 1;
    const half = Math.tan(FOV * Math.PI / 360);
    return radius * padding / (half * Math.min(this.camera.aspect * w, h / Math.sin(this.pitch)));
  }

  rotate(dx: number, dy: number): void {
    this.yaw += dx * 0.006;
    this.pitch = clamp(this.pitch + dy * 0.004, 0.5, 1.45);
  }

  resize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }
}
