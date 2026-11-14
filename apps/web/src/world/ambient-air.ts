/** Render-only crossings: migrating cloud gulls and a distant chalk shooting star. No entity data is retained. */
import {
  BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute,
  InstancedMesh, MeshBasicNodeMaterial, Object3D,
} from 'three/webgpu';
import { abs, color, instancedDynamicBufferAttribute, positionGeometry, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
import { PLANE_Y, type Plane } from '@agent-command/game/contract';
import type { MatchView } from '../match-view.ts';
import { hash2, wx, wz } from './common.ts';
import { FADE } from './fade.ts';
import type { FogField } from './fog.ts';
import { overlay } from './materials.ts';

type AirPlane = 'sky' | 'orbit';
const GULL_CAP = 5;
const TAU = Math.PI * 2;

/** Long, swept wings and a tiny body; not a triangular aircraft/chevron silhouette. */
function gullGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0.02, -0.24, 0, -0.07, -0.59, 0, 0.09,
    0, 0, 0.02, -0.59, 0, 0.09, -0.43, 0, 0.16,
    0, 0, 0.02, -0.43, 0, 0.16, -0.18, 0, 0.11,
    0, 0, 0.02, 0.59, 0, 0.09, 0.24, 0, -0.07,
    0, 0, 0.02, 0.43, 0, 0.16, 0.59, 0, 0.09,
    0, 0, 0.02, 0.18, 0, 0.11, 0.43, 0, 0.16,
    0, 0, -0.14, -0.045, 0, 0.05, 0, 0, 0.2,
    0, 0, -0.14, 0, 0, 0.2, 0.045, 0, 0.05,
  ]), 3));
  return geometry;
}

/** A tapered, unlit chalk stroke: no bright head, flash, impact, targeting marker or particle wake. */
function starGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -0.5, 0, 0, 0.28, 0, -0.5, 0.5, 0, 0,
    -0.5, 0, 0, 0.5, 0, 0, 0.28, 0, 0.5,
  ]), 3));
  return geometry;
}

export class AirAmbience {
  readonly group = new Group();
  private readonly sky = new Group();
  private readonly orbit = new Group();
  private readonly gulls: InstancedMesh<BufferGeometry, MeshBasicNodeMaterial>;
  private readonly stars: InstancedMesh<BufferGeometry, MeshBasicNodeMaterial>;
  /** World warms detached copies; these canonical meshes never need to be made visible for compilation. */
  readonly shaderTemplates: readonly Object3D[];
  private readonly gullAlpha = uniform(0);
  private readonly starAlpha = uniform(0);
  /** Compacted with visible gulls: wing bend and individual scale-independent opacity. */
  private readonly birdMotion = new InstancedBufferAttribute(new Float32Array(GULL_CAP * 2), 2).setUsage(DynamicDrawUsage);
  private readonly transform = new Object3D();
  private enabled = false;
  private disposed = false;
  private army: MatchView['army'] | undefined;
  private mapHash = -1;
  private rulesHash = -1;
  private tick = -1;
  private seed = 0;
  private serial = 0;
  private active: AirPlane | undefined;
  private lastMs = Number.NaN;
  private age = -1;
  private delay = 0;
  private x = 0;
  private y = 0;
  private bearing = 0;
  private dx = 0;
  private dy = 0;
  private distance = 0;
  private duration = 0;
  private curve = 0;
  private flockSize = GULL_CAP;
  private streakLength = 0;
  private readonly size: number;
  private readonly fog: FogField;

  constructor(size: number, fog: FogField) {
    this.size = size;
    this.fog = fog;
    this.group.name = 'air-ambience';
    this.sky.name = 'ambient-sky';
    this.orbit.name = 'ambient-orbit';
    const gullMaterial = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    gullMaterial.colorNode = color('#566c83');
    const bird = instancedDynamicBufferAttribute<'vec2'>(this.birdMotion, 'vec2');
    gullMaterial.positionNode = positionLocal.add(vec3(0, abs(positionGeometry.x).mul(bird.x), 0));
    gullMaterial.opacityNode = this.gullAlpha.mul(bird.y).mul(FADE.sky.alpha).mul(smoothstep(0.7, 1, fog.fogVis('sky')));
    this.gulls = new InstancedMesh(gullGeometry(), gullMaterial, GULL_CAP);
    this.gulls.name = 'ambient-gulls';
    const starMaterial = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    starMaterial.colorNode = color('#c6cbdc');
    starMaterial.opacityNode = this.starAlpha.mul(smoothstep(-0.5, 0.38, positionGeometry.x))
      .mul(FADE.orbit.alpha).mul(smoothstep(0.7, 1, fog.fogVis('orbit')));
    this.stars = new InstancedMesh(starGeometry(), starMaterial, 1);
    this.stars.name = 'ambient-shooting-star';
    for (const mesh of [this.gulls, this.stars]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
    }
    this.sky.add(this.gulls);
    this.orbit.add(this.stars);
    this.group.add(this.sky, this.orbit);
    this.shaderTemplates = [this.gulls, this.stars];
    this.quiet();
  }

  /** Only public identity is consumed; terrain, units, island paths and hidden observations are not read. */
  ingest(view: MatchView | undefined): void {
    if (this.disposed) return;
    if (!view || view.match.rules.map.size !== this.size) {
      this.reset();
      return;
    }
    if (view.army !== this.army || view.match.mapHash !== this.mapHash || view.rulesHash !== this.rulesHash || view.tick < this.tick) {
      this.reset();
      this.army = view.army;
      this.mapHash = view.match.mapHash;
      this.rulesHash = view.rulesHash;
      this.seed = view.match.mapSeed;
    }
    this.tick = view.tick;
    this.enabled = true;
  }

  /** Only the focused course advances. Routes are not chosen from visible patches and never restart at fog edges. */
  frame(nowMs: number, dtSeconds: number, focus: Plane, reducedMotion: boolean): void {
    if (this.disposed) return;
    if (!this.enabled || reducedMotion || (typeof document !== 'undefined' && document.hidden)
      || this.fog.size !== this.size || (focus !== 'sky' && focus !== 'orbit')) {
      this.quiet();
      return;
    }
    // Only focus/clock changes restart a course. A slow visible renderer must not starve its countdown.
    if (this.active !== focus || !Number.isFinite(this.lastMs) || nowMs < this.lastMs) {
      this.quiet();
      this.active = focus;
      this.delay = (focus === 'sky' ? 8 : 18) + hash2(this.serial + 1, this.seed + 41) * (focus === 'sky' ? 10 : 20);
      this.lastMs = nowMs;
      return;
    }
    const elapsed = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    // Preparation renders do not advance life. World caps its physics dt at .1; analytic flight instead uses
    // active wall time so ordinary 250–1000ms frames neither restart events nor put them into slow motion.
    if (dtSeconds <= 0) return;
    if (elapsed > 2) {
      // A suspended tab/renderer skips the elapsed interval, keeping its route rather than spawning a new one.
      this.group.visible = this.sky.visible = this.orbit.visible = false;
      this.gulls.count = this.stars.count = 0;
      return;
    }
    const dt = Math.max(0, Math.min(elapsed, 1));
    if (this.age < 0) {
      this.delay -= dt;
      if (this.delay > 0) return;
      this.start(focus);
    }
    this.age += dt;
    if (this.age >= this.duration) {
      this.gulls.count = this.stars.count = 0;
      this.group.visible = this.sky.visible = this.orbit.visible = false;
      this.age = -1;
      this.delay = (focus === 'sky' ? 45 : 60) + hash2(this.serial, this.seed + 19) * (focus === 'sky' ? 50 : 70);
      return;
    }
    const fade = focus === 'sky' ? 2 : 0.6;
    const edge = Math.min(1, this.age / fade, (this.duration - this.age) / fade);
    const envelope = edge * edge * (3 - 2 * edge);
    if (focus === 'sky') this.drawGulls(envelope);
    else this.drawStars(envelope);
  }

  /** One seed-derived edge-to-opposite-edge course; bounded arithmetic, no map/entity/visibility search. */
  private start(plane: AirPlane): void {
    const n = ++this.serial;
    const margin = 6;
    const entry = this.size * (0.2 + hash2(n, this.seed + 3) * 0.6);
    const exit = this.size * (0.2 + hash2(n, this.seed + 7) * 0.6);
    const side = Math.floor(hash2(n, this.seed + 11) * 4);
    const horizontal = side < 2;
    const reverse = side % 2 === 1;
    this.x = horizontal ? (reverse ? this.size + margin : -margin) : entry;
    this.y = horizontal ? entry : (reverse ? this.size + margin : -margin);
    const endX = horizontal ? (reverse ? -margin : this.size + margin) : exit;
    const endY = horizontal ? exit : (reverse ? -margin : this.size + margin);
    this.distance = Math.hypot(endX - this.x, endY - this.y);
    this.dx = (endX - this.x) / this.distance;
    this.dy = (endY - this.y) / this.distance;
    this.bearing = Math.atan2(this.dy, this.dx);
    const speed = plane === 'sky' ? 1.6 + hash2(n, this.seed + 13) * 0.4 : 10 + hash2(n, this.seed + 13) * 3;
    this.duration = this.distance / speed;
    this.curve = plane === 'sky' ? (hash2(n, this.seed + 17) - 0.5) * 5 : 0;
    this.flockSize = hash2(n, this.seed + 23) < 0.45 ? 4 : GULL_CAP;
    this.streakLength = 2.2 + hash2(n, this.seed + 29);
    this.age = 0;
  }

  /** Every overlapped cell must be visible NOW, not merely explored or still bright in the eased fog texture. */
  private visibleRect(plane: AirPlane, x0: number, y0: number, x1: number, y1: number): boolean {
    if (x0 < 0 || y0 < 0 || x1 >= this.size || y1 >= this.size) return false;
    const visible = this.fog.visible[plane];
    const right = Math.floor(x1), bottom = Math.floor(y1);
    // A gull covers at most 3×3 cells; the longest diagonal star covers at most 4×4.
    for (let y = Math.floor(y0); y <= bottom; y++)
      for (let x = Math.floor(x0); x <= right; x++)
        if (visible[y * this.size + x] !== 1) return false;
    return true;
  }

  private drawGulls(envelope: number): void {
    const t = this.age / this.duration;
    const along = t * this.distance;
    const bend = Math.sin(t * Math.PI) * this.curve;
    const slope = Math.cos(t * Math.PI) * this.curve * Math.PI / this.distance;
    const heading = this.bearing + Math.atan(slope);
    const c = Math.cos(heading), s = Math.sin(heading);
    const cx = this.x + this.dx * along - this.dy * bend;
    const cy = this.y + this.dy * along + this.dx * bend;
    this.gullAlpha.value = envelope * 0.72;
    const motion = this.birdMotion.array as Float32Array;
    let count = 0;
    for (let i = 0; i < this.flockSize; i++) {
      // Uneven loose echelon, not a rigid icon/V. Relative motion is tiny compared with forward travel.
      const side = i % 2 ? -1 : 1;
      const across = i === 0 ? 0 : side * (0.8 + i * 0.37) + Math.sin(this.age * 0.19 + i) * 0.09;
      const behind = i === 0 ? 0 : 0.8 + i * 0.78;
      const x = cx - c * behind - s * across;
      const y = cy - s * behind + c * across;
      if (!this.visibleRect('sky', x - 0.75, y - 0.75, x + 0.75, y + 0.75)) continue;
      const gliding = Math.max(0, Math.sin(this.age * TAU / 9 + i * 1.7));
      motion[count * 2] = 0.08 + Math.sin(this.age * TAU * 1.25 + i * 1.9) * 0.55 * gliding ** 3;
      motion[count * 2 + 1] = 0.8 + (i % 3) * 0.1;
      // Cross above the ordinary cloud deck; keep depth testing against islands and weather.
      this.transform.position.set(wx(x, this.size), PLANE_Y.sky + 1.25 + Math.sin(this.age * 0.27 + i) * 0.08, wz(y, this.size));
      this.transform.rotation.set(0, -heading - Math.PI / 2, 0);
      this.transform.scale.setScalar(0.88 + (i % 3) * 0.08);
      this.transform.updateMatrix();
      this.gulls.setMatrixAt(count++, this.transform.matrix);
    }
    this.gulls.count = count;
    this.sky.visible = count > 0;
    this.group.visible = count > 0;
    if (count) {
      this.gulls.instanceMatrix.needsUpdate = true;
      this.birdMotion.needsUpdate = true;
    }
  }

  private drawStars(envelope: number): void {
    const along = this.age / this.duration * this.distance;
    const x = this.x + this.dx * along;
    const y = this.y + this.dy * along;
    const halfLength = this.streakLength / 2;
    const rx = Math.abs(this.dx) * halfLength + Math.abs(this.dy) * 0.04;
    const ry = Math.abs(this.dy) * halfLength + Math.abs(this.dx) * 0.04;
    const visible = this.visibleRect('orbit', x - rx, y - ry, x + rx, y + ry);
    this.stars.count = visible ? 1 : 0;
    this.orbit.visible = this.group.visible = visible;
    if (!visible) return;
    this.starAlpha.value = envelope * 0.42;
    // Beneath ships/gameplay, on the background sheet: a distant pass, never a targeted arrival.
    this.transform.position.set(wx(x, this.size), PLANE_Y.orbit - 0.15, wz(y, this.size));
    this.transform.rotation.set(0, -this.bearing, 0);
    this.transform.scale.set(this.streakLength, 1, 0.08);
    this.transform.updateMatrix();
    this.stars.setMatrixAt(0, this.transform.matrix);
    this.stars.instanceMatrix.needsUpdate = true;
  }

  private quiet(): void {
    this.group.visible = this.sky.visible = this.orbit.visible = false;
    this.gulls.count = this.stars.count = 0;
    this.active = undefined;
    this.lastMs = Number.NaN;
    this.age = -1;
    this.delay = 0;
  }

  reset(): void {
    this.quiet();
    this.enabled = false;
    this.army = undefined;
    this.mapHash = this.rulesHash = this.tick = -1;
    this.seed = this.serial = 0;
    this.gullAlpha.value = this.starAlpha.value = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.gulls.dispose();
    this.gulls.geometry.dispose();
    this.gulls.material.dispose();
    this.stars.dispose();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    this.sky.clear();
    this.orbit.clear();
    this.group.clear();
  }
}
