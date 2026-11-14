/**
 * Pooled particles for every world effect (sparks, flashes, smoke, dust, debris, embers, flames): one instanced draw
 * per pool, two simulations behind one API.
 *
 * - WebGPU (`GpuParticles`): the particle state lives in storage buffers. Spawns are staged on the CPU (one small
 *   buffer, uploaded only on frames that spawn); a spawn kernel copies them into ring slots by index, an update kernel
 *   integrates gravity, drag and the floor for every slot, and the draw reads the same buffers as instance attributes.
 *   No per-particle CPU work after the spawn call.
 * - WebGL2, offline renderers and tests (`CpuParticles`): a dense struct-of-arrays pool integrated on the CPU and
 *   written to instance matrices (swap-remove on death).
 *
 * Both draw with the same material: a paint stroke (additive pools) or cel-shaded solid (lit pools), faded by the
 * particle's plane, near the camera and by its plane's fog. Spawning is plain deterministic CPU code in either case;
 * nothing in the simulation or HUD reads particles back.
 */
import {
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  DynamicDrawUsage,
  type BufferGeometry,
  type Color,
  type ComputeNode,
  type Renderer,
  type StorageInstancedBufferAttribute,
} from 'three/webgpu';
import { Fn, If, cos, float, instanceIndex, instancedArray, instancedDynamicBufferAttribute, max, mix, normalGeometry, normalLocal, positionGeometry, positionWorld, sin, smoothstep, uint, uniform, vec3, vec4 } from 'three/tsl';
import { FADE } from './fade.ts';
import type { FogField } from './fog.ts';
import { cel, overlay, type F1, type V3 } from './materials.ts';
import { SHADOW } from './palette.ts';

export interface ParticleOpts {
  readonly cap: number;
  readonly geo: BufferGeometry;
  /** Bright paint strokes (sparks, flashes); else lit solids keep their colour as is. */
  readonly additive: boolean;
  /** Cel-shaded solids (smoke puffs, debris) instead of flat paint. */
  readonly lit: boolean;
}

/** The one API every effect spawns through, whichever simulation runs the pool. */
export interface ParticlePool {
  /** The pool's single instanced draw. */
  readonly mesh: Mesh;
  /** Live particles: bookkeeping for tests and diagnostics, never read by gameplay. */
  readonly n: number;
  /** Compute passes to dispatch each frame (WebGPU only; empty for the CPU pool). */
  readonly kernels: readonly ComputeNode[];
  /**
   * One particle on plane index `plane` (0 Depths … 3 Orbit; + `REVEALED` to skip the fog fade) at world (x, y, z),
   * velocity in tiles/s, `life` seconds, size s0 → s1, colour `c` at opacity a0, gravity `grav` (tiles/s², negative
   * rises), linear `drag` (1/s) and a world-height `floor` it rests on.
   */
  spawn(plane: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, c: Color, a0: number, grav?: number, drag?: number, floor?: number): void;
  /** Advance by `dt` seconds: the CPU pool integrates now; the GPU pool banks the step for its next `commit`. */
  update(dt: number): void;
  /**
   * Ready this frame's kernels just before they are dispatched (banked step, staged spawns); true when they have work.
   * The CPU pool has none.
   */
  commit(): boolean;
  clear(): void;
}

/** Camera height for the under-camera fade, set each frame by `Combat.frame`. */
export const PARTICLE_CAMERA_Y = uniform(100);

/**
 * Added to a spawn's plane index: the particle keeps its plane's fade but not the fog fade. Only for an effect the
 * server already admitted to this view whose spot the fog closes over as it plays: a death, whose dying unit was
 * the last eye on its cell (inside a storm, the only one), would otherwise vanish with its own vision.
 */
export const REVEALED = 4;

/** A particle's plane fade: ghosted planes keep their particles at 30 %, like the other effects. */
function planeFade(pl: F1): F1 {
  return max(pl.lessThan(0.5).select(FADE.depths.alpha, pl.lessThan(1.5).select(FADE.surface.alpha, pl.lessThan(2.5).select(FADE.sky.alpha, FADE.orbit.alpha))), 0.3) as F1;
}

/** Fog visibility of this fragment on the particle's plane (1 without a fog field, offline, or `REVEALED`). */
function planeSeen(encoded: F1, pl: F1, fog: FogField | undefined): F1 {
  if (!fog) return float(1);
  const v = pl.lessThan(0.5).select(fog.fogVis('depths'), pl.lessThan(1.5).select(fog.fogVis('surface'), pl.lessThan(2.5).select(fog.fogVis('sky'), fog.fogVis('orbit'))));
  return encoded.greaterThan(REVEALED - 0.5).select(float(1), smoothstep(0.3, 0.7, v)) as F1;
}

/** Shared look of both simulations: colour `rgb`, base opacity `alpha`, encoded plane index `encoded`. */
function particleMaterial(o: ParticleOpts, rgb: V3, alpha: F1, encoded: F1, fog: FogField | undefined): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial());
  // lit: cel-shaded solids (smoke puffs, debris); else bright paint strokes (sparks, flashes)
  m.colorNode = o.lit ? cel(rgb, SHADOW.surface) : rgb.mul(o.additive ? 1.15 : 1);
  // hidden right under the camera (it would fill the lens), faded with its plane, gone under fog
  const near = PARTICLE_CAMERA_Y.sub(positionWorld.y).sub(2).div(6).clamp(0, 1);
  // the plane index with `REVEALED` stripped
  const pl = encoded.sub(encoded.greaterThan(REVEALED - 0.5).select(float(REVEALED), float(0))) as F1;
  m.opacityNode = alpha.mul(planeFade(pl)).mul(near).mul(planeSeen(encoded, pl, fog));
  return m;
}

/** Fading over a particle's life `u` (0..1): fast at first, then easing out. */
const lifeFade = (u: number): number => (1 - u) * (1 - u * 0.3);

// ---------------------------------------------------------------- CPU pool (WebGL2, offline, tests)

/** Dense struct-of-arrays pool rendered as one InstancedMesh (swap-remove on death). */
export class CpuParticles implements ParticlePool {
  readonly mesh: InstancedMesh;
  readonly kernels: readonly ComputeNode[] = [];
  private readonly tint: InstancedBufferAttribute;
  private readonly plane: InstancedBufferAttribute;
  private readonly cap: number;
  n = 0;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly cr: Float32Array;
  private readonly cg: Float32Array;
  private readonly cb: Float32Array;
  private readonly a0: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly spin: Float32Array;
  private readonly floor: Float32Array;
  private readonly pl: Float32Array;

  constructor(o: ParticleOpts, fog?: FogField) {
    this.cap = o.cap;
    const f = () => new Float32Array(o.cap);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f(); this.s0 = f(); this.s1 = f(); this.cr = f(); this.cg = f(); this.cb = f();
    this.a0 = f(); this.grav = f(); this.drag = f(); this.spin = f(); this.floor = f(); this.pl = f();
    this.tint = new InstancedBufferAttribute(new Float32Array(o.cap * 4), 4);
    this.tint.setUsage(DynamicDrawUsage);
    this.plane = new InstancedBufferAttribute(new Float32Array(o.cap), 1);
    this.plane.setUsage(DynamicDrawUsage);
    const t = instancedDynamicBufferAttribute<'vec4'>(this.tint, 'vec4');
    const pl = instancedDynamicBufferAttribute<'float'>(this.plane, 'float') as F1;
    this.mesh = new InstancedMesh(o.geo, particleMaterial(o, t.xyz as V3, t.w as F1, pl, fog), o.cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  spawn(plane: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, c: Color, a0: number, grav = 0, drag = 0, floor = -1e9): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1;
    this.cr[i] = c.r; this.cg[i] = c.g; this.cb[i] = c.b; this.a0[i] = a0;
    this.grav[i] = grav; this.drag[i] = drag; this.spin[i] = spinOf(x, z); this.floor[i] = floor;
    this.pl[i] = plane;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    this.px[i] = this.px[j]!; this.py[i] = this.py[j]!; this.pz[i] = this.pz[j]!;
    this.vx[i] = this.vx[j]!; this.vy[i] = this.vy[j]!; this.vz[i] = this.vz[j]!;
    this.age[i] = this.age[j]!; this.life[i] = this.life[j]!; this.s0[i] = this.s0[j]!; this.s1[i] = this.s1[j]!;
    this.cr[i] = this.cr[j]!; this.cg[i] = this.cg[j]!; this.cb[i] = this.cb[j]!; this.a0[i] = this.a0[j]!;
    this.grav[i] = this.grav[j]!; this.drag[i] = this.drag[j]!; this.spin[i] = this.spin[j]!; this.floor[i] = this.floor[j]!;
    this.pl[i] = this.pl[j]!;
  }

  /** Integrate pooled particles in seconds and write their dense instance range. */
  update(dt: number): void {
    let i = 0;
    while (i < this.n) {
      const a = (this.age[i] = this.age[i]! + dt);
      if (a >= this.life[i]!) {
        this.kill(i);
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i]! * dt);
      this.vx[i] = this.vx[i]! * d;
      this.vy[i] = (this.vy[i]! - this.grav[i]! * dt) * d;
      this.vz[i] = this.vz[i]! * d;
      this.px[i] = this.px[i]! + this.vx[i]! * dt;
      this.py[i] = Math.max(this.floor[i]!, this.py[i]! + this.vy[i]! * dt);
      this.pz[i] = this.pz[i]! + this.vz[i]! * dt;
      i++;
    }
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const tint = this.tint.array as Float32Array;
    const plane = this.plane.array as Float32Array;
    for (let k = 0; k < this.n; k++) {
      const u = this.age[k]! / this.life[k]!;
      const s = this.s0[k]! + (this.s1[k]! - this.s0[k]!) * u;
      const r = this.spin[k]! + this.age[k]! * 3;
      const c = Math.cos(r) * s;
      const sn = Math.sin(r) * s;
      const o = k * 16;
      arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0;
      arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0;
      arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
      arr[o + 12] = this.px[k]!; arr[o + 13] = this.py[k]!; arr[o + 14] = this.pz[k]!; arr[o + 15] = 1;
      const t = k * 4;
      tint[t] = this.cr[k]!; tint[t + 1] = this.cg[k]!; tint[t + 2] = this.cb[k]!;
      tint[t + 3] = this.a0[k]! * lifeFade(u);
      plane[k] = this.pl[k]!;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.tint.needsUpdate = true;
    this.plane.needsUpdate = true;
  }

  commit(): boolean {
    return false;
  }

  clear(): void {
    this.n = 0;
    this.mesh.count = 0;
  }
}

// ---------------------------------------------------------------- GPU pool (WebGPU compute)

/** vec4s per staged spawn: position + age, velocity + life, gravity/drag/floor, colour + opacity, sizes/plane/spin. */
const STAGE_STRIDE = 5;
/** Spawns one frame may stage per pool (more are dropped that frame, like a full CPU pool drops them). */
const STAGE_CAP = 512;
/** Longest step one dispatch integrates (the CPU pools' per-frame cap, `World.frame`). */
const MAX_STEP = 0.1;

/**
 * Ring-buffer pool simulated by compute kernels. Spawns overwrite the oldest slot once the ring is full, so a burst in a
 * big fight replaces the oldest sparks instead of being dropped. The CPU keeps only each slot's death time (for `n`,
 * and to stop dispatching once everything has died).
 */
export class GpuParticles implements ParticlePool {
  readonly mesh: Mesh;
  readonly kernels: readonly ComputeNode[];
  private readonly spawnKernel: ComputeNode;
  private readonly updateKernel: ComputeNode;
  /** The staged spawns, STAGE_STRIDE vec4 each, uploaded whole on frames that spawn. */
  readonly stage: StorageInstancedBufferAttribute;
  /**
   * Position + age per ring slot, the update kernel's state: `scripts/check-particles.mjs` reads it back to check the
   * compute step against the CPU pool.
   */
  readonly positions: StorageInstancedBufferAttribute;
  private readonly cap: number;
  private readonly stageCap: number;
  private readonly dt = uniform(0);
  /** Ring slot the first staged spawn goes to. */
  private readonly base = uniform(0, 'uint');
  private staged = 0;
  private head = 0;
  /** Slots written since the last clear: the draw and update range until the ring wraps. */
  private used = 0;
  /** Seconds simulated by dispatched steps; slot i is alive while `time < deathAt[i]`. */
  private time = 0;
  /** Seconds banked by `update` since the last `commit`. */
  private pending = 0;
  private lastDeath = 0;
  private readonly deathAt: Float64Array;

  constructor(o: ParticleOpts, fog?: FogField, stageCap = Math.min(o.cap, STAGE_CAP)) {
    this.cap = o.cap;
    this.stageCap = stageCap;
    this.deathAt = new Float64Array(o.cap);
    const cap = o.cap;
    const pos = instancedArray(cap, 'vec4');
    const vel = instancedArray(cap, 'vec4');
    const dyn = instancedArray(cap, 'vec4');
    const look = instancedArray(cap, 'vec4');
    const size = instancedArray(cap, 'vec4');
    const stage = instancedArray(stageCap * STAGE_STRIDE, 'vec4');
    this.stage = stage.value as StorageInstancedBufferAttribute;
    this.positions = pos.value as StorageInstancedBufferAttribute;

    // Spawn: staged spawn i → ring slot (base + i) mod cap.
    const base = this.base;
    this.spawnKernel = Fn(() => {
      const slot = base.add(instanceIndex).mod(uint(cap));
      const o = instanceIndex.mul(uint(STAGE_STRIDE));
      pos.element(slot).assign(stage.element(o));
      vel.element(slot).assign(stage.element(o.add(uint(1))));
      dyn.element(slot).assign(stage.element(o.add(uint(2))));
      look.element(slot).assign(stage.element(o.add(uint(3))));
      size.element(slot).assign(stage.element(o.add(uint(4))));
    })().compute(stageCap);
    this.spawnKernel.count = 0;

    // Update: the CPU pool's explicit Euler step (drag, then gravity, then the floor), for every live slot.
    const dt = this.dt;
    this.updateKernel = Fn(() => {
      const p = pos.element(instanceIndex);
      const v = vel.element(instanceIndex);
      const k = dyn.element(instanceIndex);
      const age = p.w.add(dt).toVar();
      If(age.lessThan(v.w), () => {
        const d = max(float(0), float(1).sub(k.y.mul(dt)));
        const nv = vec3(v.x.mul(d), v.y.sub(k.x.mul(dt)).mul(d), v.z.mul(d)).toVar();
        v.assign(vec4(nv, v.w));
        p.assign(vec4(p.x.add(nv.x.mul(dt)), max(k.z, p.y.add(nv.y.mul(dt))), p.z.add(nv.z.mul(dt)), age));
      }).Else(() => {
        p.w.assign(age);
      });
    })().compute(cap);
    this.updateKernel.count = 0;
    this.kernels = [this.spawnKernel, this.updateKernel];

    // Draw: every used slot, read straight from the simulation buffers; a dead slot collapses to a point.
    const P = pos.toAttribute();
    const V = vel.toAttribute();
    const L = look.toAttribute();
    const S = size.toAttribute();
    const u = P.w.div(V.w).clamp(0, 1);
    const alive = P.w.lessThan(V.w).select(float(1), float(0));
    const s = mix(S.x, S.y, u).mul(alive);
    const r = S.w.add(P.w.mul(3));
    const cr = cos(r), sr = sin(r);
    const alpha = L.w.mul(float(1).sub(u)).mul(float(1).sub(u.mul(0.3))).mul(alive) as F1;
    const m = particleMaterial(o, L.xyz as V3, alpha, S.z as F1, fog);
    const g = positionGeometry;
    m.positionNode = Fn(() => {
      if (o.lit) {
        const n = normalGeometry;
        normalLocal.assign(vec3(cr.mul(n.x).add(sr.mul(n.z)), n.y, cr.mul(n.z).sub(sr.mul(n.x))));
      }
      return vec3(cr.mul(g.x).add(sr.mul(g.z)), g.y, cr.mul(g.z).sub(sr.mul(g.x))).mul(s).add(P.xyz);
    })();
    this.mesh = new Mesh(o.geo, m);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  get n(): number {
    let live = 0;
    for (let i = 0; i < this.cap; i++) if (this.deathAt[i]! > this.time) live++;
    return live;
  }

  spawn(plane: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, c: Color, a0: number, grav = 0, drag = 0, floor = -1e9): void {
    if (this.staged >= this.stageCap) return;
    const a = this.stage.array as Float32Array;
    const o = this.staged * STAGE_STRIDE * 4;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = 0;
    a[o + 4] = vx; a[o + 5] = vy; a[o + 6] = vz; a[o + 7] = life;
    a[o + 8] = grav; a[o + 9] = drag; a[o + 10] = floor; a[o + 11] = 0;
    a[o + 12] = c.r; a[o + 13] = c.g; a[o + 14] = c.b; a[o + 15] = a0;
    a[o + 16] = s0; a[o + 17] = s1; a[o + 18] = plane; a[o + 19] = spinOf(x, z);
    const death = this.time + life;
    this.deathAt[(this.head + this.staged) % this.cap] = death;
    if (death > this.lastDeath) this.lastDeath = death;
    this.staged++;
  }

  update(dt: number): void {
    this.pending += dt;
  }

  commit(): boolean {
    const dt = Math.min(this.pending, MAX_STEP);
    this.pending = 0;
    this.time += dt;
    this.dt.value = dt;
    this.base.value = this.head;
    this.spawnKernel.count = this.staged;
    if (this.staged) {
      this.stage.needsUpdate = true;
      this.head = (this.head + this.staged) % this.cap;
      this.used = Math.min(this.cap, this.used + this.staged);
    }
    const live = this.time < this.lastDeath ? this.used : 0;
    this.updateKernel.count = live;
    // never exactly one instance: a mesh drawn as 1 and then as many changes its render-object key (a cache miss)
    this.mesh.count = live && Math.max(2, live);
    const work = this.staged > 0 || live > 0;
    this.staged = 0;
    return work;
  }

  clear(): void {
    this.staged = this.head = this.used = this.time = this.pending = this.lastDeath = 0;
    this.deathAt.fill(0);
    this.spawnKernel.count = this.updateKernel.count = this.mesh.count = 0;
  }
}

/** Initial yaw of a particle: varied across a burst, the same on both simulations. */
function spinOf(x: number, z: number): number {
  return (x * 7.1 + z * 3.3) % 6.28;
}

/** The pool for this renderer: compute on WebGPU, the CPU pool on WebGL2 and without a renderer. */
export function createParticles(o: ParticleOpts, gpu: boolean, fog?: FogField): ParticlePool {
  return gpu ? new GpuParticles(o, fog) : new CpuParticles(o, fog);
}

/** Commit every pool, then run their compute passes in one call (nothing when every pool is idle). */
export function dispatchParticles(renderer: Renderer, pools: readonly ParticlePool[], kernels: readonly ComputeNode[]): void {
  if (!kernels.length) return;
  let work = false;
  for (const pool of pools) if (pool.commit()) work = true;
  if (work) renderer.compute(kernels as ComputeNode[]);
}
