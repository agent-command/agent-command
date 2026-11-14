/**
 * Ground-following decals: a flat 16×16-vertex grid per instance, lifted in the vertex shader onto a per-instance row
 * of a small height texture (`groundAt` sampled under the grid on the CPU). Each vertex takes the highest ground of its
 * 3×3 neighbourhood plus a small lift, so triangles spanning a cliff edge or a crater rim stay above it. Used by the
 * island shadows and the scorch marks; one `InstancedMesh` each, no render target.
 */
import { BufferAttribute, DataTexture, NearestFilter, PlaneGeometry, RedFormat, UnsignedByteType } from 'three/webgpu';
import { attribute, float, positionLocal, texture, vec2, vec3 } from 'three/tsl';
import type { TerrainField } from './terrain.ts';
import type { F1, V3 } from './materials.ts';

/** Drape grid vertices per side, and per instance. */
export const DRAPE_GRID = 16;
const VERTS = DRAPE_GRID * DRAPE_GRID;
/**
 * Height row encoding (tiles): the Surface spans the diorama skirt (−4) up to crag tops with lodes (< 2.4). One byte
 * steps 0.025 tiles; values are rounded up, so the drape never dips below the ground it was sampled from.
 */
const H_MIN = -4;
const H_SPAN = 6.4;

export class Drape {
  /** A 2×2 quad laid flat (−1..1 on x/z), with each vertex's grid index as the `cell` attribute. */
  readonly geometry: PlaneGeometry;
  readonly tex: DataTexture;
  private readonly rows: number;
  private readonly lift: number;
  private readonly heights: Uint8Array;
  /** Grid in quad-local units (−1..1), indexed like `cell`. */
  private readonly gx = new Float32Array(VERTS);
  private readonly gz = new Float32Array(VERTS);
  private readonly ground = new Float32Array(VERTS);

  /** `rows` instances; `lift`: tiles above the sampled ground (clears ground and water sheets without floating). */
  constructor(rows: number, lift: number) {
    this.rows = rows;
    this.lift = lift;
    this.heights = new Uint8Array(VERTS * rows);
    this.tex = new DataTexture(this.heights, VERTS, rows, RedFormat, UnsignedByteType);
    this.tex.magFilter = this.tex.minFilter = NearestFilter;
    this.tex.needsUpdate = true;
    this.geometry = new PlaneGeometry(2, 2, DRAPE_GRID - 1, DRAPE_GRID - 1).rotateX(-Math.PI / 2);
    const pos = this.geometry.getAttribute('position');
    const cell = new Float32Array(VERTS);
    for (let i = 0; i < VERTS; i++) {
      cell[i] = i;
      this.gx[i] = pos.getX(i);
      this.gz[i] = pos.getZ(i);
    }
    this.geometry.setAttribute('cell', new BufferAttribute(cell, 1));
  }

  /** The texture row coordinate of instance row `n`, for the shader's `position`. */
  rowV(n: number): number {
    return (n + 0.5) / this.rows;
  }

  /** Height row `n`: the ground under the grid centred at tile (x, y) with half extent `extent` tiles. */
  write(n: number, x: number, y: number, extent: number, terrain: TerrainField): void {
    const g = this.ground;
    for (let i = 0; i < VERTS; i++) g[i] = terrain.groundAt(x + this.gx[i]! * extent, y + this.gz[i]! * extent);
    const out = this.heights;
    const base = n * VERTS;
    for (let j = 0; j < DRAPE_GRID; j++)
      for (let i = 0; i < DRAPE_GRID; i++) {
        let h = -Infinity;
        for (let b = Math.max(0, j - 1); b <= Math.min(DRAPE_GRID - 1, j + 1); b++)
          for (let a = Math.max(0, i - 1); a <= Math.min(DRAPE_GRID - 1, i + 1); a++) h = Math.max(h, g[b * DRAPE_GRID + a]!);
        out[base + j * DRAPE_GRID + i] = Math.min(255, Math.max(0, Math.ceil(((h + this.lift - H_MIN) / H_SPAN) * 255)));
      }
    this.tex.needsUpdate = true;
  }

  /** The instance's flat local position lifted onto its height row `rowV` (see `rowV`). */
  position(rowV: F1): V3 {
    const column = attribute<'float'>('cell', 'float').add(0.5).div(VERTS);
    const h = (texture(this.tex, vec2(column, rowV)).level(float(0)).r as unknown as F1).mul(H_SPAN).add(H_MIN);
    return vec3(positionLocal.x, positionLocal.y.add(h), positionLocal.z) as V3;
  }
}
