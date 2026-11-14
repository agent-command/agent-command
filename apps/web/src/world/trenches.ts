/**
 * Trench lines (docs/art/DIRECTIONS.md "Deploy stances"): dug-in troopers of one army standing close together share a
 * trench, a dark earth floor between two low sandbag walls (`trenchModel`) joining their foxholes, so a dug-in squad
 * reads as one line instead of a scatter of rings. Each trooper links to its two nearest dug-in neighbours of its army
 * within `TRENCH.join` tiles and `TRENCH.step` of its height (never down a cliff); a segment is as wide as the lesser
 * of its two troopers' dig-in progress, so it opens and fills in with them. Only troopers in the current view are
 * linked (no fog inference). One instanced draw; nothing allocates per frame.
 */
import { DynamicDrawUsage, InstancedMesh } from 'three/webgpu';
import { attribute } from 'three/tsl';
import type { ArmyId } from '@agent-command/game/contract';
import { inkMaterial, type V3 } from './materials.ts';
import { FOXHOLE, trenchModel } from './models.ts';
import type { FogField } from './fog.ts';

/** Join reach (tiles, centre to centre), the height step a trench never spans (world units), and the trooper cap. */
export const TRENCH = { join: 1.7, step: 0.3, cap: 256 } as const;

/**
 * Trench links among `n` dug-in troopers at (xs, zs) with heights `ys` (world units) and armies `sides`: each one to
 * its two nearest of its army within `join` (and `step` in height), deduplicated. Writes index pairs (i < j) into `out`
 * (2 per link, at most 2n links) using `near` (2n) as scratch; returns the link count. Allocation-free.
 */
export function trenchLinks(xs: Float32Array, zs: Float32Array, ys: Float32Array, sides: readonly (ArmyId | undefined)[], n: number,
  join: number, step: number, near: Int32Array, out: Int32Array): number {
  const reach = join * join;
  for (let i = 0; i < n; i++) {
    let a = -1, b = -1, da = reach, db = reach;
    for (let j = 0; j < n; j++) {
      if (j === i || sides[j] !== sides[i] || Math.abs(ys[j]! - ys[i]!) > step) continue;
      const d = (xs[j]! - xs[i]!) ** 2 + (zs[j]! - zs[i]!) ** 2;
      // ties go to the lower index, so mirrored squads link alike whatever the iteration order
      if (d < da || (d === da && j < a)) { b = a; db = da; a = j; da = d; }
      else if (d < db || (d === db && j < b)) { b = j; db = d; }
    }
    near[i * 2] = a;
    near[i * 2 + 1] = b;
  }
  let links = 0;
  for (let i = 0; i < n; i++) for (let k = 0; k < 2; k++) {
    const j = near[i * 2 + k]!;
    if (j < 0) continue;
    // a mutual pair is written once, from its lower index
    if (j < i && (near[j * 2] === i || near[j * 2 + 1] === i)) continue;
    out[links * 2] = Math.min(i, j);
    out[links * 2 + 1] = Math.max(i, j);
    links++;
  }
  return links;
}

/** The trench draw: collect dug-in troopers with `add` during the entity frame, then `publish` once. */
export class Trenches {
  readonly mesh: InstancedMesh;
  private n = 0;
  private readonly xs = new Float32Array(TRENCH.cap);
  private readonly zs = new Float32Array(TRENCH.cap);
  private readonly ys = new Float32Array(TRENCH.cap);
  private readonly dig = new Float32Array(TRENCH.cap);
  private readonly scale = new Float32Array(TRENCH.cap);
  private readonly sides: (ArmyId | undefined)[] = new Array<ArmyId | undefined>(TRENCH.cap).fill(undefined);
  private readonly near = new Int32Array(TRENCH.cap * 2);
  private readonly links = new Int32Array(TRENCH.cap * 4);

  constructor(fogField?: FogField) {
    const m = inkMaterial('surface', attribute<'vec3'>('paint', 'vec3') as unknown as V3, { fogField });
    this.mesh = new InstancedMesh(trenchModel(), m, TRENCH.cap * 2);
    this.mesh.name = 'trench-lines';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 39;
  }

  begin(): void {
    this.n = 0;
  }

  /** A trooper at world (x, y, z) of `side`, dug in to `dig` (deploy progress 0…1), drawn at model scale `scale`. */
  add(x: number, y: number, z: number, side: ArmyId, dig: number, scale: number): void {
    if (this.n >= TRENCH.cap || dig <= 0) return;
    const i = this.n++;
    this.xs[i] = x; this.ys[i] = y; this.zs[i] = z;
    this.sides[i] = side;
    this.dig[i] = dig;
    this.scale[i] = scale;
  }

  /** Link this frame's troopers and upload one segment per link, from foxhole rim to foxhole rim. */
  publish(): void {
    const links = trenchLinks(this.xs, this.zs, this.ys, this.sides, this.n, TRENCH.join, TRENCH.step, this.near, this.links);
    const m = this.mesh.instanceMatrix.array as Float32Array;
    let count = 0;
    for (let l = 0; l < links; l++) {
      const i = this.links[l * 2]!, j = this.links[l * 2 + 1]!;
      const dx = this.xs[j]! - this.xs[i]!, dz = this.zs[j]! - this.zs[i]!;
      const d = Math.hypot(dx, dz);
      const s = Math.min(this.scale[i]!, this.scale[j]!);
      // the walls run into each foxhole's lip a little, so the line reads unbroken
      const len = d - 1.6 * FOXHOLE.radius * s;
      const w = s * Math.min(this.dig[i]!, this.dig[j]!);
      if (len <= 0.02 || w <= 0) continue;
      const cx = dx / d, cz = dz / d;
      const o = count++ * 16;
      m[o] = cx * len; m[o + 1] = 0; m[o + 2] = cz * len; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = w; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = -cz * w; m[o + 9] = 0; m[o + 10] = cx * w; m[o + 11] = 0;
      m[o + 12] = (this.xs[i]! + this.xs[j]!) / 2; m[o + 13] = (this.ys[i]! + this.ys[j]!) / 2; m[o + 14] = (this.zs[i]! + this.zs[j]!) / 2; m[o + 15] = 1;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
