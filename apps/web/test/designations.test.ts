import { describe, expect, it } from 'vitest';
import { Color, DynamicDrawUsage, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { ARMIES, CELL, DEFAULT_RULES, PLANE_Y, frameOf, rotCell, type ArmyId, type View } from '@agent-command/game/contract';
import { Designations } from '../src/world/designations.ts';

/** Every layer and snapshot here is a default-size map. */
const size = DEFAULT_RULES.map.size;

function tags(normal: number[] = [], urgent: number[] = []): View['designations'] {
  const out = { normal: Array<number>(Math.ceil(size * size / 30)).fill(0), urgent: Array<number>(Math.ceil(size * size / 30)).fill(0) };
  for (const i of normal) out.normal[Math.floor(i / 30)]! |= 1 << (i % 30);
  for (const i of urgent) out.urgent[Math.floor(i / 30)]! |= 1 << (i % 30);
  return out;
}

function snapshot(designations = tags(), army: ArmyId = 'nw'): Pick<View, 'designations' | 'depths' | 'army'> {
  return { designations, army, depths: Array<number>(size * size).fill(CELL.unknown) };
}

function cellAt(mesh: InstancedMesh, slot: number): number {
  const matrix = new Matrix4();
  mesh.getMatrixAt(slot, matrix);
  expect(matrix.elements[13]).toBeCloseTo(PLANE_Y.depths + 1.45);
  return Math.round(matrix.elements[14]! + size / 2 - 0.5) * size + Math.round(matrix.elements[12]! + size / 2 - 0.5);
}

function brightness(mesh: InstancedMesh, slot: number): number {
  const color = new Color();
  mesh.getColorAt(slot, color);
  expect(color.r).toBe(color.g);
  expect(color.r).toBe(color.b);
  return color.r;
}

describe('army dig plan rendering', () => {
  it('retains packed tags on repeat snapshots and replaces them when tags clear or the viewing army changes', () => {
    const layer = new Designations(size);
    const normal = layer.root.children[0] as InstancedMesh;
    const urgent = layer.root.children[1] as InstancedMesh;
    const plan = tags([29, 30], [size * size - 1]);
    layer.ingest(snapshot(plan));
    expect([normal.count, urgent.count]).toEqual([2, 1]);
    const version = normal.instanceMatrix.version;
    layer.ingest(snapshot(tags([29, 30], [size * size - 1])));
    expect([normal.count, urgent.count]).toEqual([2, 1]);
    expect(normal.instanceMatrix.version).toBe(version);
    const matrix = new Matrix4();
    normal.getMatrixAt(1, matrix);
    expect(matrix.elements[12]).toBe(30.5 - size / 2);
    expect(matrix.elements[14]).toBe(0.5 - size / 2);
    // Snapshots may reuse arrays; storing the caller's array would miss this clear.
    plan.normal.fill(0);
    layer.ingest(snapshot(plan));
    expect([normal.count, urgent.count]).toEqual([0, 1]);
    layer.ingest(snapshot(tags([0]), 'se'));
    expect([normal.count, urgent.count]).toEqual([1, 0]);
    layer.ingest(snapshot(tags(), 'se'));
    expect([normal.count, urgent.count]).toEqual([0, 0]);
  });

  it('puts brighter urgent ink on its own instances and resets plans and preview between matches', () => {
    const layer = new Designations(size);
    layer.ingest(snapshot(tags([0], [30])));
    const normal = layer.root.children[0] as InstancedMesh;
    const urgent = layer.root.children[1] as InstancedMesh;
    const preview = layer.root.children[2] as Mesh;
    const normalColor = (normal.material as MeshBasicNodeMaterial).color;
    const urgentColor = (urgent.material as MeshBasicNodeMaterial).color;
    expect(urgentColor.r + urgentColor.g + urgentColor.b).toBeGreaterThan(normalColor.r + normalColor.g + normalColor.b);
    layer.showPreview({ x0: 3, y0: 4, x1: 7, y1: 9 }, 2);
    expect(preview.visible).toBe(true);
    expect(preview.scale.toArray()).toEqual([5, 1, 6]);
    expect((preview.material as MeshBasicNodeMaterial).color.equals(urgentColor)).toBe(true);
    layer.reset();
    expect([normal.count, urgent.count, preview.visible]).toEqual([0, 0, false]);
    layer.ingest(snapshot(tags([0], [30])));
    expect([normal.count, urgent.count]).toEqual([1, 1]);
  });

  for (const army of ARMIES) for (const priority of ['normal', 'urgent'] as const) {
    it(`keeps ${army} ${priority} diagonal successors through predecessor clear and compacted uploads`, () => {
      // The same plan in the army's own frame (its corner rotated onto the NW corner).
      const mirror = (c: number) => rotCell(frameOf(army), c, size);
      const predecessor = mirror(10 * size + 10);
      const successor = mirror(11 * size + 11);
      const later = mirror(12 * size + 12);
      const planned = [0, predecessor, successor, later];
      const view = snapshot(priority === 'normal' ? tags(planned) : tags([], planned), army);
      view.depths.fill(CELL.rock);
      view.depths[mirror(10 * size + 9)] = CELL.tunnel;
      const layer = new Designations(size);
      layer.ingest(view);
      const mesh = layer.root.children[priority === 'normal' ? 0 : 1] as InstancedMesh;
      const ordered = [...planned].sort((a, b) => a - b);
      expect(mesh.count).toBe(4);
      expect(brightness(mesh, ordered.indexOf(predecessor))).toBe(1);
      expect(brightness(mesh, ordered.indexOf(successor))).toBeGreaterThan(0);
      expect(brightness(mesh, ordered.indexOf(successor))).toBeLessThan(1);
      const matrixArray = mesh.instanceMatrix.array;
      const colorArray = mesh.instanceColor!.array;
      const matrixVersion = mesh.instanceMatrix.version;
      const colorVersion = mesh.instanceColor!.version;
      // Same caller-owned arrays: remove the dug predecessor and an earlier slot.
      for (const cell of [0, predecessor]) view.designations[priority][Math.floor(cell / 30)]! &= ~(1 << (cell % 30));
      view.depths[predecessor] = CELL.tunnel;
      layer.ingest(view);
      const remaining = [successor, later].sort((a, b) => a - b);
      expect(mesh.count).toBe(2);
      expect([cellAt(mesh, 0), cellAt(mesh, 1)]).toEqual(remaining);
      expect(brightness(mesh, remaining.indexOf(successor))).toBe(1);
      expect(brightness(mesh, remaining.indexOf(later))).toBeGreaterThan(0);
      expect(brightness(mesh, remaining.indexOf(later))).toBeLessThan(1);
      expect(mesh.instanceMatrix.array).toBe(matrixArray);
      expect(mesh.instanceColor!.array).toBe(colorArray);
      expect(mesh.instanceMatrix.version).toBeGreaterThan(matrixVersion);
      expect(mesh.instanceColor!.version).toBeGreaterThan(colorVersion);
      expect(mesh.instanceMatrix.usage).toBe(DynamicDrawUsage);
      expect(mesh.instanceColor!.usage).toBe(DynamicDrawUsage);
      expect(mesh.frustumCulled).toBe(false);
      // An identical snapshot neither rebuilds nor uploads again.
      const unchanged = mesh.instanceMatrix.version;
      layer.ingest(view);
      expect(mesh.instanceMatrix.version).toBe(unchanged);
    });

    it(`updates ${army} ${priority} brightness from known topology without changing tag membership`, () => {
      const mirror = (c: number) => rotCell(frameOf(army), c, size);
      const cell = mirror(10 * size + 10);
      const source = mirror(9 * size + 9);
      const left = mirror(10 * size + 9);
      const above = mirror(9 * size + 10);
      const right = mirror(10 * size + 11);
      const view = snapshot(priority === 'normal' ? tags([cell]) : tags([], [cell]), army);
      const layer = new Designations(size);
      const mesh = layer.root.children[priority === 'normal' ? 0 : 1] as InstancedMesh;
      const ingest = (bright: boolean) => {
        const version = mesh.instanceColor!.version;
        layer.ingest(view);
        expect(mesh.count).toBe(1);
        expect(cellAt(mesh, 0)).toBe(cell);
        expect(brightness(mesh, 0)).toBeCloseTo(bright ? 1 : 0.45);
        expect(mesh.instanceColor!.version).toBeGreaterThan(version);
      };
      ingest(false);
      // Unknown connectors are workable rock, but unknown cells are not open sources.
      view.depths[source] = CELL.tunnel;
      ingest(true);
      view.depths[left] = CELL.bedrock;
      view.depths[above] = CELL.magma;
      ingest(false);
      view.depths[left] = CELL.fortified;
      ingest(true);
      view.depths[source] = CELL.magma;
      ingest(false);
      view.depths[right] = CELL.rail;
      ingest(true);
      view.depths[right] = CELL.rock;
      ingest(false);
      // Switching viewers with identical arrays must not retain the previous army's cache.
      view.army = ARMIES[(ARMIES.indexOf(army) + 1) % ARMIES.length]!;
      ingest(false);
    });
  }

  it('preserves every packed pending bit, including non-workable terrain and overlapping priorities', () => {
    const cells = [0, 29, 30, size - 1, size * size - 1];
    const view = snapshot(tags(cells, [30]));
    view.depths[0] = CELL.bedrock;
    view.depths[29] = CELL.magma;
    view.depths[30] = CELL.tunnel;
    // A linear-array neighbor across the map edge is not a spatial frontier.
    view.depths[size] = CELL.tunnel;
    const layer = new Designations(size);
    layer.ingest(view);
    const normal = layer.root.children[0] as InstancedMesh;
    const urgent = layer.root.children[1] as InstancedMesh;
    expect(normal.count).toBe(4);
    expect(urgent.count).toBe(1);
    expect(Array.from({ length: normal.count }, (_, i) => cellAt(normal, i))).toEqual([0, 29, size - 1, size * size - 1]);
    expect(cellAt(urgent, 0)).toBe(30);
    expect(brightness(normal, 2)).toBeCloseTo(0.45);
    for (const mesh of [normal, urgent]) for (let i = 0; i < mesh.count; i++) expect(brightness(mesh, i)).toBeGreaterThan(0);
  });

  it('keeps plan ink above changing depth geometry in the depth policy, including the preview', () => {
    const layer = new Designations(size);
    layer.ingest(snapshot(tags([29], [30])));
    for (const child of layer.root.children) {
      const material = (child as Mesh).material as MeshBasicNodeMaterial;
      // +1.45 alone is not clearance: bedrock roughness and ore crystals reach higher.
      expect(material.depthTest).toBe(false);
      expect(material.depthWrite).toBe(false);
      expect(material.transparent).toBe(true);
    }
  });
});
