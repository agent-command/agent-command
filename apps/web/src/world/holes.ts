/** Exposed cell edges only: adjoining crater cells become one opening, never overlapping circular rims. */
import { BufferAttribute, BufferGeometry, Group, Mesh } from 'three/webgpu';
import { attribute, color, float, mix } from 'three/tsl';
import { PLANE_Y } from '@agent-command/game/contract';
import { hash2, wx, wz } from './common.ts';
import { emptyGeometry, hatch, inkMaterial, type V3 } from './materials.ts';
import type { FogField } from './fog.ts';

export interface HoleEdge { x: number; y: number; dx: number; dy: number }

/** Clockwise edges keep the hole on the right. No seam at mixed-kind joins, islands remain outlined. */
export function holeEdges(cells: ReadonlySet<number>, size: number): HoleEdge[] {
  const edges: HoleEdge[] = [];
  for (const c of cells) {
    const x = c % size, y = Math.floor(c / size);
    if (y === 0 || !cells.has(c - size)) edges.push({ x, y, dx: 1, dy: 0 });
    if (x === size - 1 || !cells.has(c + 1)) edges.push({ x: x + 1, y, dx: 0, dy: 1 });
    if (y === size - 1 || !cells.has(c + size)) edges.push({ x: x + 1, y: y + 1, dx: -1, dy: 0 });
    if (x === 0 || !cells.has(c - 1)) edges.push({ x, y: y + 1, dx: 0, dy: -1 });
  }
  return edges;
}

type Point = readonly [number, number, number];

/** One shared merged decal mesh, independent of area: all detail scales with exposed perimeter. */
export class HoleLips {
  readonly size: number;
  readonly mesh: Mesh;
  private readonly cells = new Set<number>();
  private sampledHeights = new Float32Array(0);

  constructor(parent: Group, size: number, fogField?: FogField) {
    this.size = size;
    const paint = attribute<'vec3'>('paint', 'vec3') as V3;
    const ink = hatch(float(0.48), 7).mul(0.3);
    this.mesh = new Mesh(emptyGeometry(), inkMaterial('surface', mix(paint, color('#282620'), ink) as V3, { side: true, fogField }));
    this.mesh.name = 'surface-hole-lips';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /** Rebuild only for changed cells or changed terrain under the lip; never from the frame loop. */
  rebuild(cells: ReadonlySet<number>, height: (x: number, y: number) => number): void {
    let changed = cells.size !== this.cells.size;
    if (!changed) for (const c of cells) if (!this.cells.has(c)) { changed = true; break; }
    const previous = this.mesh.geometry.getAttribute('position');
    if (!changed && previous) for (let i = 0; i < previous.count; i++) {
      if (Math.abs(height(previous.getX(i) + this.size / 2, previous.getZ(i) + this.size / 2) - this.sampledHeights[i]!) > 1e-5) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.cells.clear();
    for (const c of cells) this.cells.add(c);
    const positions: number[] = [], paints: number[] = [];
    const palette = { ink: [0.025, 0.022, 0.016], turf: [0.28, 0.32, 0.12], soil: [0.31, 0.20, 0.12], rock: [0.18, 0.12, 0.09], grass: [0.35, 0.42, 0.17], chip: [0.45, 0.36, 0.24] } as const;
    const vertex = (p: Point, rgb: readonly number[]) => { positions.push(wx(p[0], this.size), PLANE_Y.surface + p[1], wz(p[2], this.size)); paints.push(...rgb); };
    const triangle = (a: Point, b: Point, c: Point, rgb: readonly number[]) => { vertex(a, rgb); vertex(b, rgb); vertex(c, rgb); };
    for (const e of holeEdges(cells, this.size)) {
      const nx = e.dy, ny = -e.dx;
      const point = (t: number, offset: number, lift = 0.025): Point => {
        const x = e.x + e.dx * t + nx * offset, y = e.y + e.dy * t + ny * offset;
        return [x, height(x, y) + lift, y];
      };
      for (let j = 0; j < 4; j++) {
        const t0 = j / 4;
        const seed = hash2(e.x * 7 + j, e.y * 11);
        const t = t0 + 0.12;
        if (seed > 0.52) {
          // A split, tapering crack with no repeated radial pattern.
          const a = point(t, 0.24), b = point(t + 0.035, 0.24);
          const tip = point(t + (seed - 0.5) * 0.3, 0.34 + seed * 0.16);
          triangle(a, b, tip, palette.ink);
        }
        if (seed > 0.72) {
          const a = point(t, 0.27), b = point(t + 0.12, 0.29), c = point(t + 0.04, 0.4);
          const tip: Point = [(a[0] + b[0] + c[0]) / 3, Math.max(a[1], b[1], c[1]) + 0.065, (a[2] + b[2] + c[2]) / 3];
          triangle(a, b, tip, palette.chip); triangle(b, c, tip, palette.rock); triangle(c, a, tip, palette.soil);
        } else if (seed < 0.25) {
          const a = point(t, 0.24), b = point(t + 0.075, 0.25);
          const tip: Point = [a[0] + nx * 0.045, a[1] + 0.12, a[2] + ny * 0.045];
          triangle(a, b, tip, palette.grass);
        } else if (seed < 0.48) {
          // Broken scraps, not a second continuous perimeter/selection-box line.
          triangle(point(t - 0.06, 0.08), point(t + 0.09, 0.09), point(t, 0.22), palette.turf);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    const samples = geometry.getAttribute('position');
    this.sampledHeights = new Float32Array(samples.count);
    for (let i = 0; i < samples.count; i++) this.sampledHeights[i] = height(samples.getX(i) + this.size / 2, samples.getZ(i) + this.size / 2);
    geometry.setAttribute('paint', new BufferAttribute(new Float32Array(paints), 3));
    geometry.computeVertexNormals();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.mesh.visible = positions.length > 0;
  }
}
