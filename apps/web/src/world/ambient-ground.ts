/** Render-only flyovers and tunnel skitterers. No entity data, pathfinding or simulation state. */
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial, Object3D } from 'three/webgpu';
import { abs, attribute, color, mix, positionGeometry, positionLocal, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import { CELL, PLANE_Y, type Plane } from '@agent-command/game/contract';
import type { MatchView } from '../match-view.ts';
import { hash2 } from './common.ts';
import type { FogField } from './fog.ts';
import { inkMaterial } from './materials.ts';
import type { TerrainField } from './terrain.ts';

const BIRDS = 5;
const BUGS = 6;
const BUG_RADIUS = .43;
const TAU = Math.PI * 2;

/** Narrow swept wings, a pointed head and split tail: a bird silhouette, not a flying unit. */
function birdGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -.06, 0, -.17, -.28, .035, -.12, -.53, .01, .16,
    -.06, 0, -.17, -.53, .01, .16, -.17, 0, .07,
    .06, 0, -.17, .53, .01, .16, .28, .035, -.12,
    .06, 0, -.17, .17, 0, .07, .53, .01, .16,
    0, .045, -.3, -.065, .02, -.07, .065, .02, -.07,
    -.065, .02, -.07, -.035, .015, .16, .035, .015, .16,
    -.065, .02, -.07, .035, .015, .16, .065, .02, -.07,
    0, .015, .08, -.09, 0, .27, 0, .015, .21,
    0, .015, .08, 0, .015, .21, .09, 0, .27,
  ]), 3));
  return geometry;
}

/** Two low body masses and eight bent, tapered legs. Built once; only feet/knees receive the walking offset. */
function bugGeometry(): BufferGeometry {
  const positions: number[] = [], gait: number[] = [], paint: number[] = [];
  const triangle = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, step: number, tone: number): void => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    gait.push(step, step, step);
    paint.push(tone, tone, tone);
  };
  for (const z of [-.075, .1]) {
    const radius = z < 0 ? .085 : .12;
    for (let side = 0; side < 6; side++) {
      const a = side * TAU / 6, b = (side + 1) * TAU / 6;
      triangle(0, .105, z, Math.cos(a) * radius, .025, z + Math.sin(a) * radius, Math.cos(b) * radius, .025, z + Math.sin(b) * radius, 0, side < 3 ? .75 : .25);
    }
  }
  for (let side = -1; side <= 1; side += 2) for (let leg = 0; leg < 4; leg++) {
    const z = -.13 + leg * .075, tipZ = -.25 + leg * .16;
    const kneeX = side * (.21 + (leg === 1 || leg === 2 ? .025 : 0));
    const footX = side * (.27 + (leg === 1 || leg === 2 ? .025 : 0));
    const step = side * (leg % 2 ? -1 : 1);
    triangle(side * .045, .05, z, kneeX, .075, tipZ - .018, kneeX, .075, tipZ + .018, step, .6);
    triangle(kneeX, .075, tipZ - .018, footX, .012, tipZ + side * .035, kneeX, .075, tipZ + .018, step, .25);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('gait', new BufferAttribute(new Float32Array(gait), 1));
  geometry.setAttribute('paint', new BufferAttribute(new Float32Array(paint), 1));
  return geometry;
}

export class GroundAmbience {
  readonly group = new Group();
  readonly shaderTemplates: readonly Object3D[];
  private readonly size: number;
  private readonly fog: FogField;
  private readonly birds: InstancedMesh<BufferGeometry, MeshBasicNodeMaterial>;
  private readonly bugs: InstancedMesh<BufferGeometry, MeshBasicNodeMaterial>;
  private readonly pose = new Object3D();
  private readonly birdClock = uniform(0);
  private readonly bugStep = new InstancedBufferAttribute(new Float32Array(BUGS * 3), 3);
  private readonly x = new Float64Array(BUGS);
  private readonly y = new Float64Array(BUGS);
  private readonly targetX = new Float64Array(BUGS);
  private readonly targetY = new Float64Array(BUGS);
  private readonly rest = new Float64Array(BUGS);
  private readonly life = new Float64Array(BUGS);
  private readonly duration = new Float64Array(BUGS);
  private readonly speed = new Float64Array(BUGS);
  private readonly yaw = new Float64Array(BUGS);
  private readonly step = new Float64Array(BUGS);
  private readonly active = new Uint8Array(BUGS);
  private view: MatchView | undefined;
  private disposed = false;
  private seed = 0;
  private serial = 0;
  private birdAge = -1;
  private birdWait = 1.5;
  private birdDuration = 0;
  private birdCount = 0;
  private birdSpeed = 0;
  private birdAnchor = 0;
  private birdSlope = 0;
  private birdAxis = 0;
  private birdReverse = false;
  private birdVariant = 0;
  private bugWait = 1.2;
  private bugBurst = 0;
  private lastMs = Number.NaN;
  private activePlane: Plane | undefined;

  constructor(size: number, fog: FogField, _terrain: TerrainField) {
    this.size = size;
    this.fog = fog;
    const bird = birdGeometry();
    const phases = new Float32Array(BIRDS);
    for (let i = 0; i < BIRDS; i++) phases[i] = i * 2.39;
    bird.setAttribute('phase', new InstancedBufferAttribute(phases, 1));
    const birdMaterial = inkMaterial('surface', color('#555448').rgb, { fogField: fog, side: true });
    const phase = attribute('phase', 'float');
    const flapping = smoothstep(-.15, .6, sin(this.birdClock.mul(.85).add(phase)));
    const wing = sin(this.birdClock.mul(12).add(phase)).mul(flapping).mul(abs(positionGeometry.x)).mul(.55);
    // Custom positions run after instancing; retain the transformed position, not the geometry origin.
    birdMaterial.positionNode = positionLocal.add(vec3(0, wing, 0));
    this.birds = new InstancedMesh(bird, birdMaterial, BIRDS);
    this.birds.name = 'surface-ambient-flyover';

    const bug = bugGeometry();
    this.bugStep.setUsage(DynamicDrawUsage);
    bug.setAttribute('step', this.bugStep);
    const stride = attribute('step', 'vec3'), gait = attribute('gait', 'float');
    const bugMaterial = inkMaterial('depths', mix(color('#51473f'), color('#9a8b70'), attribute('paint', 'float')), { fogField: fog, side: true, alpha: stride.z });
    const walking = sin(stride.x.add(gait.mul(Math.PI / 2))).mul(abs(gait)).mul(stride.y);
    bugMaterial.positionNode = positionLocal.add(vec3(0, abs(walking).mul(.012), walking.mul(.025)));
    this.bugs = new InstancedMesh(bug, bugMaterial, BUGS);
    this.bugs.name = 'depths-ambient-skitterers';
    for (const mesh of [this.bugs, this.birds]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.count = 0;
    }
    this.group.name = 'ground-ambience';
    this.group.add(this.bugs, this.birds);
    this.shaderTemplates = [this.bugs, this.birds];
    this.reset();
  }

  ingest(view: MatchView | undefined): void {
    if (this.disposed) return;
    if (!view || view.match.rules.map.size !== this.size) { this.reset(); return; }
    if (this.view && (view.army !== this.view.army || view.match.mapHash !== this.view.match.mapHash || view.rulesHash !== this.view.rulesHash || view.tick < this.view.tick)) this.reset();
    this.view = view;
    this.seed = view.match.mapSeed;
  }

  private random(): number { return hash2(++this.serial + this.seed, this.serial * .731 + 19); }

  /** Entire silhouettes must be CURRENTLY visible; explored terrain does not admit wildlife. */
  private visible(plane: Plane, x: number, y: number, radius: number): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!this.fog.tileVisible(plane, x + dx * radius, y + dy * radius)) return false;
    }
    return true;
  }

  private tunnel(x: number, y: number): boolean {
    if (!this.fog.tileVisible('depths', x, y)) return false;
    return this.view?.depths[Math.floor(y) * this.size + Math.floor(x)] === CELL.tunnel;
  }

  private floorClear(x: number, y: number): boolean {
    return this.tunnel(x, y) && this.tunnel(x - BUG_RADIUS, y - BUG_RADIUS)
      && this.tunnel(x + BUG_RADIUS, y - BUG_RADIUS) && this.tunnel(x - BUG_RADIUS, y + BUG_RADIUS)
      && this.tunnel(x + BUG_RADIUS, y + BUG_RADIUS);
  }

  frame(nowMs: number, dtSeconds: number, focus: Plane, reducedMotion: boolean): void {
    this.bugs.visible = this.birds.visible = false;
    if (!this.view || reducedMotion || (typeof document !== 'undefined' && document.hidden)
      || dtSeconds <= 0 || (focus !== 'surface' && focus !== 'depths')) {
      // Preparation/hidden frames never contribute elapsed time to the next live frame.
      this.lastMs = Number.NaN;
      return;
    }
    if (this.activePlane !== focus || !Number.isFinite(this.lastMs) || nowMs < this.lastMs) {
      this.activePlane = focus;
      this.lastMs = nowMs;
      return;
    }
    const elapsed = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    // World's physics dt is capped at .1. Ordinary slow rendering must not slow analytic wildlife tenfold;
    // suspension is discarded, not replayed as a backlog of appearances when the tab returns.
    if (elapsed <= 0 || elapsed > 2) return;
    const dt = Math.min(1, elapsed);
    if (focus === 'surface') this.flyover(dt);
    else {
      // Preserve footprint checks along every short movement step, even with a 1 Hz software renderer.
      const steps = Math.ceil(dt / .1), step = dt / steps;
      for (let i = 0; i < steps; i++) this.skitter(step);
    }
  }

  /** A complete map chord, never a resident orbit or a loop around a habitat patch. */
  private startFlyover(): boolean {
    let x = 0, y = 0, found = false;
    // A bounded search chooses a currently seen crossing point, not a terrain or unit attachment.
    for (let attempt = 0; attempt < 96; attempt++) {
      x = .5 + Math.floor(this.random() * this.size);
      y = .5 + Math.floor(this.random() * this.size);
      if (this.visible('surface', x, y, .7)) { found = true; break; }
    }
    if (!found) return false;
    this.birdAxis = this.random() < .5 ? 0 : 1;
    this.birdReverse = this.random() < .5;
    this.birdSlope = (this.random() - .5) * .36;
    this.birdAnchor = (this.birdAxis ? x : y) - this.birdSlope * (this.birdAxis ? y : x);
    this.birdSpeed = 2.1 + this.random() * .8;
    this.birdDuration = (this.size + 10) / this.birdSpeed;
    this.birdCount = 3 + Math.floor(this.random() * 3);
    this.birdVariant = this.random() * TAU;
    this.birdAge = 0;
    return true;
  }

  private flyover(dt: number): void {
    if (this.birdAge < 0) {
      this.birdWait -= dt;
      if (this.birdWait > 0) return;
      if (!this.startFlyover()) { this.birdWait = 3; return; }
    }
    this.birdAge += dt;
    if (this.birdAge >= this.birdDuration) {
      this.birdAge = -1;
      this.birdWait = 18 + this.random() * 14;
      this.birds.count = 0;
      return;
    }
    this.birdClock.value += dt;
    const sign = this.birdReverse ? -1 : 1;
    const along = this.birdReverse ? this.size + 5 - this.birdAge * this.birdSpeed : -5 + this.birdAge * this.birdSpeed;
    const across = this.birdAnchor + this.birdSlope * along;
    const dx = this.birdAxis ? this.birdSlope * sign : sign;
    const dy = this.birdAxis ? sign : this.birdSlope * sign;
    const heading = Math.atan2(-dx, -dy);
    let visible = false;
    for (let i = 0; i < this.birdCount; i++) {
      const rank = Math.ceil(i / 2), side = i % 2 ? -1 : 1;
      const lag = rank * .85 + Math.sin(this.birdAge * .37 + i) * .12;
      const lateral = side * rank * .9 + Math.sin(this.birdAge * .5 + i + this.birdVariant) * .16;
      const x = (this.birdAxis ? across : along) - dx * lag - dy * lateral;
      const y = (this.birdAxis ? along : across) - dy * lag + dx * lateral;
      const shown = this.visible('surface', x, y, .7);
      visible ||= shown;
      this.pose.position.set(x - this.size / 2, PLANE_Y.surface + 4.1 + Math.sin(this.birdAge * .6 + i) * .12, y - this.size / 2);
      this.pose.rotation.set(0, heading, Math.sin(this.birdAge * .5 + i) * .055);
      this.pose.scale.setScalar(shown ? .82 + i * .025 : 0);
      this.pose.updateMatrix();
      this.birds.setMatrixAt(i, this.pose.matrix);
    }
    this.birds.count = this.birdCount;
    this.birds.visible = visible;
    if (visible) this.birds.instanceMatrix.needsUpdate = true;
  }

  private startBug(i: number): boolean {
    for (let attempt = 0; attempt < 64; attempt++) {
      const x = Math.floor(this.random() * this.size) + .5;
      const y = Math.floor(this.random() * this.size) + .5;
      if (!this.floorClear(x, y)) continue;
      this.x[i] = this.targetX[i] = x;
      this.y[i] = this.targetY[i] = y;
      this.active[i] = 1;
      this.life[i] = 0;
      this.duration[i] = 5 + this.random() * 4;
      this.yaw[i] = this.random() * TAU;
      this.rest[i] = .2 + this.random() * .6;
      return true;
    }
    return false;
  }

  /** Short cardinal runs keep the complete footprint inside adjacent known tunnel cells.
   * At most four directions and three cells are probed at a rest boundary, never a map scan. */
  private nextHop(i: number): void {
    const first = Math.floor(this.random() * 4);
    for (let n = 0; n < 4; n++) {
      const direction = (first + n) % 4;
      const dx = direction === 0 ? 1 : direction === 2 ? -1 : 0;
      const dy = direction === 1 ? 1 : direction === 3 ? -1 : 0;
      const length = 1 + Math.floor(this.random() * 3);
      let clear = 0;
      for (let distance = 1; distance <= length; distance++) {
        if (!this.floorClear(this.x[i]! + dx * distance, this.y[i]! + dy * distance)) break;
        clear = distance;
      }
      if (!clear) continue;
      this.targetX[i] = this.x[i]! + dx * clear;
      this.targetY[i] = this.y[i]! + dy * clear;
      this.yaw[i] = Math.atan2(-dx, -dy);
      this.speed[i] = .65 + this.random() * .85;
      return;
    }
    this.rest[i] = .4 + this.random();
  }

  private skitter(dt: number): void {
    this.bugWait -= dt;
    let visible = false;
    for (let i = 0; i < BUGS; i++) {
      if (!this.active[i] && this.bugWait <= 0) {
        if (!this.bugBurst) this.bugBurst = 1 + Math.floor(this.random() * 3);
        if (this.startBug(i)) {
          this.bugBurst--;
          this.bugWait = this.bugBurst ? .6 + this.random() * .9 : 14 + this.random() * 14;
        } else this.bugWait = 3;
      }
      let walking = 0;
      if (this.active[i]) {
        this.life[i] = this.life[i]! + dt;
        if (this.life[i]! >= this.duration[i]! || !this.floorClear(this.x[i]!, this.y[i]!)) {
          this.active[i] = 0;
        } else if (this.rest[i]! > 0) {
          this.rest[i] = this.rest[i]! - dt;
          if (this.rest[i]! <= 0) this.nextHop(i);
        } else {
          const dx = this.targetX[i]! - this.x[i]!, dy = this.targetY[i]! - this.y[i]!;
          const distance = Math.hypot(dx, dy);
          if (distance > .001) {
            const move = Math.min(distance, this.speed[i]! * dt);
            const x = this.x[i]! + dx * move / distance, y = this.y[i]! + dy * move / distance;
            if (this.floorClear(x, y)) {
              this.x[i] = x;
              this.y[i] = y;
              this.step[i] = this.step[i]! + move * 36;
              walking = 1;
            } else {
              // Knowledge can change mid-hop: retire rather than crossing a newly hidden wall or lava cell.
              this.active[i] = 0;
            }
            if (move >= distance) this.rest[i] = .15 + this.random() ** 2 * 1.15;
          } else this.nextHop(i);
        }
      }
      const shown = this.active[i] === 1;
      visible ||= shown;
      const envelope = shown ? Math.min(1, this.life[i]! / .6, (this.duration[i]! - this.life[i]!) / .6) : 0;
      this.pose.position.set(this.x[i]! - this.size / 2, PLANE_Y.depths + .025, this.y[i]! - this.size / 2);
      this.pose.rotation.set(0, this.yaw[i]!, 0);
      this.pose.scale.setScalar(shown ? 1 : 0);
      this.pose.updateMatrix();
      this.bugs.setMatrixAt(i, this.pose.matrix);
      this.bugStep.setXYZ(i, this.step[i]!, walking, envelope);
    }
    this.bugs.count = BUGS;
    this.bugs.visible = visible;
    if (visible) {
      this.bugs.instanceMatrix.needsUpdate = true;
      this.bugStep.needsUpdate = true;
    }
  }

  reset(): void {
    this.view = undefined;
    this.seed = this.serial = 0;
    this.lastMs = Number.NaN;
    this.activePlane = undefined;
    this.birdAge = -1;
    this.birdWait = 1.5;
    this.birdClock.value = 0;
    this.active.fill(0);
    this.step.fill(0);
    this.bugWait = 1.2;
    this.bugBurst = 0;
    this.rest.fill(0);
    this.birds.count = this.bugs.count = 0;
    this.birds.visible = this.bugs.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    for (const mesh of [this.bugs, this.birds]) {
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.group.clear();
  }
}
