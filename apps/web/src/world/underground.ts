/** Knowledge-only Depths cracks. Instances come from the fogged view, never the sim. */
import { BufferAttribute, BufferGeometry, Group, InstancedMesh, Object3D } from 'three/webgpu';
import { color } from 'three/tsl';
import { PLANE_Y, isDiggable, type View } from '@agent-command/game/contract';
import { wx, wz } from './common.ts';
import { inkMaterial, type V3 } from './materials.ts';

/** Successive branching strokes retain earlier fractures, so increasing damage never changes the crack's identity. */
const BRANCHES = [
  [[-.32, -.28], [-.10, -.12], [-.18, .05], [.02, .20]],
  [[-.10, -.12], [.10, -.18], [.28, -.36]],
  [[-.18, .05], [-.35, .19], [-.30, .36]],
  [[.02, .20], [.20, .09], [.34, .27]],
] as const;

export function crackGeometry(stage: number): BufferGeometry {
  const p: number[] = [];
  for (let b = 0; b < stage; b++) {
    const points = BRANCHES[b]!;
    for (let i = 1; i < points.length; i++) {
      const [x, z] = points[i - 1]!;
      const [xx, zz] = points[i]!;
      const length = Math.hypot(xx - x, zz - z);
      const width = .012 + stage * .005;
      const dx = (zz - z) / length * width;
      const dz = (x - xx) / length * width;
      p.push(x-dx,0,z-dz, xx+dx,0,zz+dz, x+dx,0,z+dz, x-dx,0,z-dz, xx-dx,0,zz-dz, xx+dx,0,zz+dz);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
  g.computeVertexNormals();
  return g;
}

export class UndergroundArt {
  readonly depths = new Group();
  private readonly cracks: InstancedMesh[] = [];
  private readonly pose = new Object3D();

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    for (let stage = 1; stage <= 4; stage++) {
      // Chalk lips contrast with the dark section cut; remembered damage stays legible outside current vision.
      const mesh = new InstancedMesh(crackGeometry(stage), inkMaterial('depths', color('#e9dcc4') as unknown as V3, { fog: false }), this.size * this.size);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.cracks.push(mesh);
      this.depths.add(mesh);
    }
  }

  update(view: View): void {
    this.reset();
    const p = this.pose;
    p.scale.set(1, 1, 1);
    for (const c of view.cracks) {
      const code = view.depths[c.y * this.size + c.x];
      if (code === undefined || !isDiggable(code)) continue;
      const mesh = this.cracks[c.stage - 1];
      if (!mesh) continue;
      p.rotation.set(0, ((c.x + c.y) & 3) * Math.PI / 2, 0);
      // The section cut peaks at 1.25 + .06 roughness; lift avoids z-fighting without exposing hidden wall faces.
      p.position.set(wx(c.x + .5, this.size), PLANE_Y.depths + 1.33, wz(c.y + .5, this.size));
      p.updateMatrix();
      mesh.setMatrixAt(mesh.count++, p.matrix);
    }
    for (const mesh of this.cracks) mesh.instanceMatrix.needsUpdate = true;
  }

  reset(): void {
    for (const mesh of this.cracks) mesh.count = 0;
  }
}
