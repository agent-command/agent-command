import { type BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedMesh, MeshBasicNodeMaterial, Object3D, RingGeometry } from 'three/webgpu';
import { attribute, color, fract, step, uv } from 'three/tsl';
import { PLANE_Y, type Plane, type View } from '@agent-command/game/contract';
import { FADE } from './fade.ts';
import { hash2, wx, wz } from './common.ts';
import { inkMaterial, overlay, seen, type F1, type V3 } from './materials.ts';
import { oreHeapModel } from './models.ts';
import { ScorchMarks } from './scorch.ts';
import { TerrainField, groundAt } from './terrain.ts';
import type { FogField } from './fog.ts';

/** Ore heap radius (tiles): a pile a tile across, wider than it is tall, so a cache reads as a resource, not a unit. */
const HEAP_RADIUS = 0.5;
const tmp = new Object3D();

/** Painted, ink-outlined heap material; crystal tips and lumps glow by their baked `glow`. */
function heapMaterial(plane: Plane, fogField: FogField | undefined): MeshBasicNodeMaterial {
  const paint = attribute<'vec3'>('paint', 'vec3') as V3;
  const glow = attribute<'float'>('glow', 'float') as F1;
  return inkMaterial(plane, paint, { fogField, glow: paint.mul(glow.mul(0.5)) as V3 });
}

/** Only the current fog-filtered lists feed these pools; nothing persists as resource memory. */
export class Deposits {
  readonly surface = new Group();
  readonly depths = new Group();
  readonly ore: InstancedMesh;
  readonly below: InstancedMesh;
  readonly rings: InstancedMesh;
  /** Burning ground from volatile impacts: charred, ember-cracked marks (`scorch.ts`). */
  readonly scorch: ScorchMarks;
  private readonly cap: number;
  /** Heap enlargement this frame: units' zoom readability scale, so a cache stays legible beside them far out. */
  private zoomScale = 1;

  readonly size: number;
  private readonly terrain: TerrainField;

  constructor(size: number, terrain = new TerrainField(size), fogField?: FogField) {
    this.size = size;
    this.terrain = terrain;
    this.cap = size * size;
    const heap = oreHeapModel();
    this.ore = this.pool(heap, heapMaterial('surface', fogField), this.cap, this.surface);
    this.below = this.pool(heap, heapMaterial('depths', fogField), this.cap, this.depths);
    const ring = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    const p = uv().sub(0.5).mul(2);
    const dash = step(0.35, fract(p.x.add(p.y).mul(12)));
    ring.colorNode = color('#71d6bf');
    ring.opacityNode = dash.mul(0.65).mul(FADE.surface.alpha).mul(seen('surface', fogField));
    this.rings = this.pool(new RingGeometry(0.94, 1, 48).rotateX(-Math.PI / 2), ring, this.cap, this.surface);
    this.scorch = new ScorchMarks(size, terrain, fogField);
    this.surface.add(this.scorch.mesh);
  }

  private pool(geometry: BufferGeometry, material: MeshBasicNodeMaterial, cap: number, root: Group): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, cap);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    root.add(mesh);
    return mesh;
  }

  /** One static ore heap per cache share, turned by its id so neighbouring heaps differ. */
  private heap(mesh: InstancedMesh, n: number, id: number, x: number, y: number, alloy: number, plane: Plane): number {
    if (alloy <= 0 || n >= this.cap) return n;
    tmp.position.set(wx(x, this.size), PLANE_Y[plane] + (plane === 'surface' ? groundAt(x, y, this.terrain) : 0), wz(y, this.size));
    tmp.rotation.set(0, hash2(id, 91) * Math.PI * 2, 0);
    tmp.scale.setScalar(HEAP_RADIUS * this.zoomScale);
    tmp.updateMatrix();
    mesh.setMatrixAt(n, tmp.matrix);
    return n + 1;
  }

  /** Follow the units' zoom enlargement (`unitZoomScale`); rescales the heaps in place only when it changes. */
  zoom(scale: number): void {
    if (scale === this.zoomScale) return;
    this.zoomScale = scale;
    this.rescale(this.ore, HEAP_RADIUS * scale);
    this.rescale(this.below, HEAP_RADIUS * scale);
  }

  private rescale(mesh: InstancedMesh, radius: number): void {
    const m = mesh.instanceMatrix.array;
    for (let o = 0; o < mesh.count * 16; o += 16) {
      // yaw + uniform scale: renormalise the 3×3 basis from its measured length (no drift over many zoom steps)
      const k = radius / Math.hypot(m[o]!, m[o + 1]!, m[o + 2]!);
      for (let c = 0; c < 12; c += 4) {
        m[o + c] = m[o + c]! * k;
        m[o + c + 1] = m[o + c + 1]! * k;
        m[o + c + 2] = m[o + c + 2]! * k;
      }
    }
    if (mesh.count) mesh.instanceMatrix.needsUpdate = true;
  }

  update(view: View, at: (tick: number) => number): void {
    let ore = 0, below = 0, rings = 0;
    for (const cache of view.oreCaches ?? []) {
      ore = this.heap(this.ore, ore, cache.id, cache.x, cache.y, cache.alloy, 'surface');
      if (cache.below) below = this.heap(this.below, below, cache.id, cache.below.x, cache.below.y, cache.below.alloy, 'depths');
      if (cache.alloy <= 0 || rings >= this.cap) continue;
      this.disc(this.rings, rings++, cache.x, cache.y, cache.radius);
    }
    this.scorch.update(view, at);
    this.ore.count = ore;
    this.below.count = below;
    this.rings.count = rings;
    if (ore) this.ore.instanceMatrix.needsUpdate = true;
    if (below) this.below.instanceMatrix.needsUpdate = true;
    if (rings) this.rings.instanceMatrix.needsUpdate = true;
  }

  private disc(mesh: InstancedMesh, i: number, x: number, y: number, radius: number): void {
    // Match threat stamps: lift the flat ring above the highest sampled ground, including crater rims.
    const r = radius * 0.7;
    const top = Math.max(groundAt(x, y, this.terrain), groundAt(x - r, y, this.terrain), groundAt(x + r, y, this.terrain), groundAt(x, y - r, this.terrain), groundAt(x, y + r, this.terrain));
    tmp.position.set(wx(x, this.size), PLANE_Y.surface + top + 0.07, wz(y, this.size));
    tmp.rotation.set(0, 0, 0);
    tmp.scale.set(radius, 1, radius);
    tmp.updateMatrix();
    mesh.setMatrixAt(i, tmp.matrix);
  }


  reset(): void {
    this.ore.count = this.below.count = this.rings.count = 0;
    this.scorch.reset();
  }
}
