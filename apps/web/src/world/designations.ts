/** Team-authored plans, not terrain: gold ink stays visible even on unexplored rock. */
import { Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Mesh, MeshBasicNodeMaterial, Object3D, PlaneGeometry } from 'three/webgpu';
import { abs, float, fract, max, positionWorld, smoothstep } from 'three/tsl';
import { PLANE_Y, designationFrontier, frameOf, type View } from '@agent-command/game/contract';
import { digTagged, type DigPriority, type DigRect } from '../designate.ts';
import { wx, wz } from './common.ts';
import { FADE } from './fade.ts';
import { lines, overlay, type F1 } from './materials.ts';

const GOLD = '#d8ad4e';
const URGENT = '#fff0a0';
const CLEAR = '#cbb9a3';
const INVALID = '#ff6a3d';
const HEIGHT = PLANE_Y.depths + 1.45;
const DIM = 0.45;

export class Designations {
  readonly root = new Group();
  private readonly normal: InstancedMesh;
  private readonly urgent: InstancedMesh;
  private readonly preview: Mesh;
  private readonly previewMaterial: MeshBasicNodeMaterial;
  private readonly transform = new Object3D();
  private readonly tint = new Color();
  private readonly cells: Uint8Array;
  private readonly tags: Uint8Array;
  /** Frame of the army whose plans are shown: its tie-break order for diagonal connectors. */
  private frame: number | undefined;

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.cells = new Uint8Array(size * size);
    this.tags = new Uint8Array(size * size);
    const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const p = positionWorld;
    const hatch = lines(p.x.sub(p.z).mul(3) as F1, 0.09);
    // Cell borders: every map size is even, so world x/z (centred) and tile x/y share their fractional part.
    const border = smoothstep(0.43, 0.48, max(abs(fract(p.x).sub(0.5)), abs(fract(p.z).sub(0.5))));
    const coverage = max(hatch, border.mul(0.55));
    const material = (color: string) => {
      const m = overlay(new MeshBasicNodeMaterial({ color }));
      // Plans are UI ink, not terrain decals. Bedrock roughness and ore crystals can exceed
      // HEIGHT, and rebuilding a cut must never occlude a still-pending designation.
      m.depthTest = false;
      m.opacityNode = coverage.mul(FADE.depths.alpha).mul(FADE.depths.focus).mul(0.85);
      return m;
    };
    this.normal = new InstancedMesh(geo, material(GOLD), this.size * this.size);
    this.urgent = new InstancedMesh(geo, material(URGENT), this.size * this.size);
    for (const mesh of [this.normal, this.urgent]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(this.size * this.size * 3), 3).setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      this.root.add(mesh);
    }
    this.previewMaterial = material(GOLD);
    this.previewMaterial.opacityNode = float(0.12).add(coverage.mul(0.8)).mul(FADE.depths.alpha).mul(FADE.depths.focus);
    this.preview = new Mesh(geo, this.previewMaterial);
    this.preview.renderOrder = 9;
    this.preview.visible = false;
    this.root.add(this.preview);
  }

  ingest(view: Pick<View, 'designations' | 'depths' | 'army'>): void {
    const frame = frameOf(view.army);
    let changed = this.frame !== frame;
    this.frame = frame;
    // Copy values, not snapshot references: adapters may mutate and reuse both arrays.
    // All topology changes matter, even when no packed designation word changed.
    for (let i = 0; i < this.size * this.size; i++) {
      const priority = digTagged(view.designations.urgent, i) ? 2 : digTagged(view.designations.normal, i) ? 1 : 0;
      const cell = view.depths[i]!;
      if (this.tags[i] !== priority || this.cells[i] !== cell) changed = true;
      this.tags[i] = priority;
      this.cells[i] = cell;
    }
    if (!changed) return;
    this.normal.count = this.urgent.count = 0;
    for (let i = 0; i < this.size * this.size; i++) {
      const mesh = this.tags[i] === 2 ? this.urgent : this.tags[i] === 1 ? this.normal : undefined;
      if (!mesh) continue;
      // Frontier status changes brightness only, never membership. Diagonal tags are
      // workable via the same connector rule as the sim, using team knowledge only.
      const workable = designationFrontier(this.cells, this.tags, i, frame, undefined, this.size) >= 0;
      this.tint.setScalar(workable ? 1 : DIM);
      this.transform.position.set(wx(i % this.size + 0.5, this.size), HEIGHT, wz(Math.floor(i / this.size) + 0.5, this.size));
      this.transform.updateMatrix();
      mesh.setMatrixAt(mesh.count, this.transform.matrix);
      mesh.setColorAt(mesh.count++, this.tint);
    }
    // Matrix and tint use the same compacted slot and are uploaded together, including
    // when clearing a predecessor moves its successor to an earlier instance.
    this.normal.instanceMatrix.needsUpdate = true;
    this.urgent.instanceMatrix.needsUpdate = true;
    this.normal.instanceColor!.needsUpdate = true;
    this.urgent.instanceColor!.needsUpdate = true;
  }

  showPreview(rect?: DigRect, priority: DigPriority = 1, valid = true): void {
    this.preview.visible = rect !== undefined;
    if (!rect) return;
    this.preview.position.set(wx((rect.x0 + rect.x1 + 1) / 2, this.size), HEIGHT + 0.015, wz((rect.y0 + rect.y1 + 1) / 2, this.size));
    this.preview.scale.set(rect.x1 - rect.x0 + 1, 1, rect.y1 - rect.y0 + 1);
    this.previewMaterial.color.set(valid ? priority === 0 ? CLEAR : priority === 2 ? URGENT : GOLD : INVALID);
  }

  reset(): void {
    this.normal.count = this.urgent.count = 0;
    this.tags.fill(0);
    this.cells.fill(0);
    this.frame = undefined;
    this.preview.visible = false;
  }
}
