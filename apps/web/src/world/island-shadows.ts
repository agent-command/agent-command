/**
 * Sky islands' shadows on the Surface: a soft violet-grey wash in each island's own silhouette, so a Surface player
 * always knows roughly where the islands drift overhead. Island positions are public, so the shadows ignore fog and
 * draw every island track the client holds (`Track.visible` is the Sky's plane fade, ~0 while the Surface is focused,
 * so it is deliberately not consulted); nothing about structures on an island is shown.
 *
 * - **Silhouette:** built once per island from the vertices of the island model Entities already draws (its
 *   `island-terrain-<id>` mesh), so no model is rebuilt: the max radius per angular bin, closed and box-filtered into
 *   a blob, stored normalised as one row of a small profile texture. Islands never yaw at render time and the model
 *   bakes its quarter turns, so the profile is in world x/z directly.
 * - **Draw:** one `InstancedMesh` for every island (≤ `SHADOW_CAP`), no shadow map or render target. The fragment
 *   compares the distance from the island centre with the profile radius at that bearing and feathers the edge wide.
 * - **Ground:** each quad is a draped grid (`drape.ts`, re-sampled under the moving island every frame, 256 samples per
 *   island), lifted over cliff edges. The quad keeps depth testing: units, structures and trees standing on the ground
 *   occlude the wash, so it never darkens them, and it never shades the island itself when the stack is seen mid-dive.
 * - **Light:** the scene's key light (`SUN_DIR`) is steep; the true projection would throw the shadow far from the
 *   island it marks, so the shadow only leans `SUN_SHIFT` tiles away from the sun.
 * - **Colour:** the Surface shadow tint taken down in value (`DEPTH`), drawn with normal blending at a low opacity: a
 *   cool, darker wash that reads on painted ground as well as on paper, never black.
 * - **Planes:** `FADE.surface.alpha × FADE.surface.focus`: full while the Surface is focused, easing out through a dive,
 *   0 when the Sky (ghost Surface below) or any other plane is focused.
 */
import { DataTexture, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, LinearFilter, MeshBasicNodeMaterial, RedFormat, RepeatWrapping, UnsignedByteType, type BufferAttribute, type InterleavedBufferAttribute, type Mesh, type Object3D } from 'three/webgpu';
import { abs, atan, float, instancedDynamicBufferAttribute, smoothstep, step, texture, uv, vec2 } from 'three/tsl';
import { PLANE_Y } from '@agent-command/game/contract';
import { wx, wz } from './common.ts';
import type { Track } from './entities.ts';
import { FADE } from './fade.ts';
import { mapUV } from './fog.ts';
import { SUN_DIR, overlay, rgb, type F1 } from './materials.ts';
import { SHADOW } from './palette.ts';
import { TerrainField } from './terrain.ts';
import { Drape } from './drape.ts';

/** Shadow slots: Entities holds at most 16 islands; four armies' sets with headroom. */
export const SHADOW_CAP = 32;
/** Angular bins of a silhouette profile (5.6° each). */
export const PROFILE_BINS = 64;
/** Leaning away from the sun, in tiles: enough to read the light direction, never enough to detach from the island. */
export const SUN_SHIFT = 1.2;
/** Feather (tiles) inside and outside the silhouette radius: a soft-edged blob, not a cut-out, with a solid core. */
const FEATHER_IN = 0.7;
const FEATHER_OUT = 0.55;
/** Peak opacity: readable on painted ground and on paper, never hiding units or terrain detail. */
const OPACITY = 0.4;
/**
 * The wash is the Surface shadow tint taken down to this fraction: the plain tint is near the paper's value and all but
 * vanishes on painted grass, while this drops the ground about a quarter in value with a cool cast.
 */
const DEPTH = 0.35;
/** Height above the sampled ground (tiles): clears ground and water sheets without visibly floating. */
const LIFT = 0.06;
/** Profile smoothing: a closing (bridges root/strata notches) then box-filter passes for the blur. */
const SMOOTH_PASSES = 2;

type Positions = BufferAttribute | InterleavedBufferAttribute;

export class IslandShadows {
  readonly mesh: InstancedMesh;
  /** island id → profile row; rows persist for the match (ids keep their model), freed on reset or when full. */
  readonly rows = new Map<string, number>();
  /** Normalised silhouette radius (0..255) per row × bin, and each row's max radius (tiles). */
  readonly profile: Uint8Array;
  readonly radius = new Float32Array(SHADOW_CAP);
  /** This frame's lean away from the sun (tiles, x/y): the field map draws the same shadow spot. */
  readonly offset = new Float64Array(2);
  private readonly size: number;
  private readonly terrain: TerrainField;
  private readonly used = new Uint8Array(SHADOW_CAP);
  private readonly profileTex: DataTexture;
  private readonly drape = new Drape(SHADOW_CAP, LIFT);
  /** Per instance: profile row v, height row v, max radius (tiles), quad half extent (tiles). */
  private readonly inst: InstancedBufferAttribute;
  private readonly bins = new Float32Array(PROFILE_BINS);
  private readonly binsTmp = new Float32Array(PROFILE_BINS);

  constructor(size: number, terrain = new TerrainField(size)) {
    this.size = size;
    this.terrain = terrain;
    this.profile = new Uint8Array(PROFILE_BINS * SHADOW_CAP);
    this.profileTex = new DataTexture(this.profile, PROFILE_BINS, SHADOW_CAP, RedFormat, UnsignedByteType);
    this.profileTex.wrapS = RepeatWrapping;
    this.profileTex.magFilter = this.profileTex.minFilter = LinearFilter;
    this.profileTex.needsUpdate = true;
    this.inst = new InstancedBufferAttribute(new Float32Array(SHADOW_CAP * 4), 4);
    this.inst.setUsage(DynamicDrawUsage);
    this.mesh = new InstancedMesh(this.drape.geometry, this.material(), SHADOW_CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Surface group: after the water sheet (2), before ore rings and scorches (8).
    this.mesh.renderOrder = 7;
  }

  private material(): MeshBasicNodeMaterial {
    const t = instancedDynamicBufferAttribute<'vec4'>(this.inst, 'vec4');
    const m = overlay(new MeshBasicNodeMaterial());
    // Drape: the instance transform places the flat grid at the Surface; lift each vertex onto its sampled ground.
    m.positionNode = this.drape.position(t.y as F1);
    // PlaneGeometry rotated flat: u runs along +x, v along −z.
    const q = uv().mul(2).sub(1);
    const px = q.x, pz = q.y.negate();
    const d = vec2(px, pz).length().mul(t.w);
    const bearing = atan(pz, px).div(Math.PI * 2);
    const rim = (texture(this.profileTex, vec2(bearing, t.x)).r as unknown as F1).mul(t.z);
    const body = float(1).sub(smoothstep(rim.sub(FEATHER_IN), rim.add(FEATHER_OUT), d));
    // the terrain ends at the map edge; an island drifting near it must not shade the empty page beyond
    const edge = abs(mapUV().sub(0.5));
    const inside = step(edge.x, 0.5).mul(step(edge.y, 0.5));
    m.colorNode = rgb(SHADOW.surface).mul(DEPTH);
    m.opacityNode = body.mul(inside).mul(OPACITY).mul(FADE.surface.alpha).mul(FADE.surface.focus);
    return m;
  }

  /**
   * Every frame after `Entities.frame` (interpolated `rx`/`ry`). `models`: the Entities root holding each island's
   * `island-terrain-<id>` mesh, read once per island for its silhouette.
   */
  frame(tracks: ReadonlyMap<string, Track>, models: Object3D): void {
    // away from the sun, horizontally; world x/z and tile x/y share axes (`wx`, `wz`)
    const sl = Math.hypot(SUN_DIR.x, SUN_DIR.z);
    const ox = sl > 1e-6 ? (-SUN_DIR.x / sl) * SUN_SHIFT : 0;
    const oy = sl > 1e-6 ? (-SUN_DIR.z / sl) * SUN_SHIFT : 0;
    this.offset[0] = ox;
    this.offset[1] = oy;
    const mat = this.mesh.instanceMatrix.array as Float32Array;
    const inst = this.inst.array as Float32Array;
    let n = 0;
    for (const tr of tracks.values()) {
      if (tr.e.kind !== 'island' || n >= SHADOW_CAP) continue;
      const row = this.rowOf(tr.e.id, tracks, models);
      if (row < 0) continue;
      const r = this.radius[row]!;
      const extent = r + FEATHER_OUT + 0.1;
      const x = tr.rx + ox, y = tr.ry + oy;
      const o = n * 16;
      mat[o] = extent; mat[o + 1] = 0; mat[o + 2] = 0; mat[o + 3] = 0;
      mat[o + 4] = 0; mat[o + 5] = 1; mat[o + 6] = 0; mat[o + 7] = 0;
      mat[o + 8] = 0; mat[o + 9] = 0; mat[o + 10] = extent; mat[o + 11] = 0;
      mat[o + 12] = wx(x, this.size); mat[o + 13] = PLANE_Y.surface; mat[o + 14] = wz(y, this.size); mat[o + 15] = 1;
      inst[n * 4] = (row + 0.5) / SHADOW_CAP;
      inst[n * 4 + 1] = this.drape.rowV(n);
      inst[n * 4 + 2] = r;
      inst[n * 4 + 3] = extent;
      this.drape.write(n, x, y, extent, this.terrain);
      n++;
    }
    this.mesh.count = n;
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.inst.needsUpdate = true;
    }
  }

  /** The island's profile row, building it from its drawn model on first sight; −1 if not drawable yet. */
  private rowOf(id: string, tracks: ReadonlyMap<string, Track>, models: Object3D): number {
    const known = this.rows.get(id);
    if (known !== undefined) return known;
    const island = models.getObjectByName(`island-terrain-${id}`) as Mesh | undefined;
    if (!island) return -1;
    let row = this.used.indexOf(0);
    if (row < 0) {
      // full: release islands that left the view
      for (const [other, r] of this.rows) if (!tracks.has(other)) { this.rows.delete(other); this.used[r] = 0; }
      row = this.used.indexOf(0);
      if (row < 0) return -1;
    }
    this.used[row] = 1;
    this.rows.set(id, row);
    this.build(row, island.geometry.getAttribute('position') as Positions);
    return row;
  }

  /** Top-down footprint of the model: max radius per bearing, closed and blurred, normalised to its max radius. */
  private build(row: number, pos: Positions): void {
    const bins = this.bins, tmp = this.binsTmp;
    bins.fill(0);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const a = Math.atan2(z, x) / (Math.PI * 2);
      const b = Math.floor((a - Math.floor(a)) * PROFILE_BINS) % PROFILE_BINS;
      bins[b] = Math.max(bins[b]!, Math.hypot(x, z));
    }
    // closing: dilate then erode by one bin fills empty bins and thin notches between spikes
    ring(bins, tmp, Math.max);
    ring(tmp, bins, Math.min);
    for (let p = 0; p < SMOOTH_PASSES; p++) {
      ring(bins, tmp, (a, b, c) => (a + b + c) / 3);
      bins.set(tmp);
    }
    let r = 0;
    for (let b = 0; b < PROFILE_BINS; b++) r = Math.max(r, bins[b]!);
    this.radius[row] = r;
    const o = row * PROFILE_BINS;
    for (let b = 0; b < PROFILE_BINS; b++) this.profile[o + b] = r > 0 ? Math.round((bins[b]! / r) * 255) : 0;
    this.profileTex.needsUpdate = true;
  }

  /** Match switch: profiles belong to that match's island ids. */
  reset(): void {
    this.mesh.count = 0;
    this.rows.clear();
    this.used.fill(0);
  }
}

/** Circular 3-tap filter of `src` into `dst`. */
function ring(src: Float32Array, dst: Float32Array, f: (a: number, b: number, c: number) => number): void {
  const n = src.length;
  for (let i = 0; i < n; i++) dst[i] = f(src[(i + n - 1) % n]!, src[i]!, src[(i + 1) % n]!);
}
