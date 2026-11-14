/**
 * Direction-agnostic scene assembly and TSL helpers. A direction (`dirs/*.ts`) supplies a `Look`: materials per
 * element, optional extra props, lights and the post-processing pipeline. Everything is placed from `world.ts`.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  type DataTexture,
  Group,
  InstancedMesh,
  type Material,
  Mesh,
  Object3D,
  PlaneGeometry,
  type PerspectiveCamera,
  type RenderPipeline,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import { atan, color, float, fwidth, mx_noise_vec3, positionWorld, smoothstep, texture, uniform, uv, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import {
  ASTEROID,
  CHARGE,
  DEPTHS_MAP,
  FAULT,
  type Field,
  type FieldOpts,
  HALF,
  IMPACT,
  ISLANDS,
  type Kind,
  PLANE_Y,
  PLANES,
  type Plane,
  S,
  SUN_WEDGE,
  SURFACE_MAP,
  ARMY_HEX,
  type ArmyColour,
  UNITS,
  type Unit,
  asteroidGeometry,
  buildField,
  cellMask,
  cloudGeometry,
  code,
  hash2,
  isVisible,
  islandGeometry,
  railGeometry,
  tileTexture,
  unitGeometry,
  visionMask,
  wx,
  wz,
  DEPTHS_H,
  SURFACE_H,
} from './world.ts';

export type F1 = Node<'float'>;
export type V3 = Node<'vec3'>;

/** Animation clock (seconds); frozen by `?t=` for screenshots. */
export const clock = uniform(0);
/** 1 for the focused plane(s), 0 for ghosted ones (the game fades unfocused planes to holograms). */
export const FOCUS = {
  depths: uniform(1),
  surface: uniform(1),
  sky: uniform(1),
  orbit: uniform(1),
};

const FOG_TEX = Object.fromEntries(PLANES.map((p) => [p, tileTexture(visionMask(p))])) as Record<Plane, DataTexture>;

/** Smoothed 0..1 visibility at this fragment (bilinear 16×16 texture like the game's, with a noisy edge). */
export function vis(plane: Plane, wobble = 0.018): F1 {
  const p = positionWorld;
  const n = mx_noise_vec3(p.mul(0.9)).xz.mul(wobble);
  const u = vec2(p.x.add(HALF).div(S), p.z.add(HALF).div(S)).add(n);
  return smoothstep(0.3, 0.7, texture(FOG_TEX[plane], u).r) as F1;
}

/** Per-tile mask texture (e.g. water cells) sampled at this fragment. */
export function maskAt(mask: Float32Array): F1 {
  const t = tileTexture(mask);
  const p = positionWorld;
  return texture(t, vec2(p.x.add(HALF).div(S), p.z.add(HALF).div(S))).r as F1;
}

export const ARMY_COLOR = { blue: color(ARMY_HEX.blue), red: color(ARMY_HEX.red) } as const;

/** Telegraph pattern on a quad's uv: outer ring, 12 ticks, countdown pie (elapsed `t`), centre cross. */
export function telegraphPattern(t: number): { ring: F1; ticks: F1; pie: F1; core: F1; r: F1 } {
  const q = uv().sub(0.5).mul(2);
  const r = q.length();
  const aa = fwidth(r).mul(1.2);
  const ring = smoothstep(aa.negate().add(0.8), aa.add(0.8), r).mul(float(1).sub(smoothstep(aa.negate().add(0.88), aa.add(0.88), r))) as F1;
  const a = atan(q.y, q.x).div(Math.PI * 2).add(0.5);
  const tick = smoothstep(0.42, 0.46, a.mul(12).fract().sub(0.5).abs());
  const ticks = tick.mul(smoothstep(0.9, 0.92, r)).mul(float(1).sub(smoothstep(0.98, 1, r))) as F1;
  const along = a.sub(0.25).fract(); // start at 12 o'clock
  const pie = float(1).sub(smoothstep(t - 0.004, t, along)).mul(float(1).sub(smoothstep(0.74, 0.76, r))) as F1;
  const cross = float(1).sub(smoothstep(0.02, 0.035, q.x.abs().min(q.y.abs()))).mul(float(1).sub(smoothstep(0.2, 0.22, r)));
  return { ring, ticks, pie, core: cross as F1, r: r as F1 };
}

// ------------------------------------------------------------------ the look contract
export interface Ctx {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGPURenderer;
  view: Plane | 'stack';
  roots: Record<Plane, Group>;
  fields: Partial<Record<'surface' | 'depths', Field>>;
}

export interface Look {
  name: string;
  /** Background gradient (top, bottom) per viewed plane. */
  bg: Record<Plane | 'stack', [string, string]>;
  surfaceField: FieldOpts;
  depthsField: FieldOpts;
  terrain(plane: 'surface' | 'depths'): Material;
  water(): Material;
  magma(): Material;
  /** Forest trees: geometry + material (instanced on forest cells). */
  tree(plane: 'surface' | 'sky'): { geo: BufferGeometry; mat: Material; perCell: number; scale: number };
  fault(): Material;
  ore(): { geo: BufferGeometry; mat: Material };
  rail(): Material;
  island(): Material;
  cloud(storm: boolean): Material;
  /** Island drift-path ribbon (uv.x runs along the path). */
  path(): Material;
  sunWedge(): Material;
  asteroid(): Material;
  /** Sky/orbit fog sheet just under the units. */
  veil(plane: 'sky' | 'orbit'): Material;
  unit(plane: Plane, team: ArmyColour, ghost: boolean): Material;
  telegraph(plane: Plane, t: number): Material;
  /** Extra per-unit dressing (bases, blob shadows, stalks). */
  unitExtra?(u: Unit, plane: Plane, y: number): Object3D | undefined;
  /** Extra props, lights, backdrop. */
  dress?(ctx: Ctx): void;
  /** Post-processing; return the pipeline to render with. */
  post(ctx: Ctx): RenderPipeline;
}

// ------------------------------------------------------------------ assembly
const tmp = new Object3D();

function instanced(geo: BufferGeometry, mat: Material, mats: { x: number; y: number; z: number; s: number; r: number; sy?: number }[]): InstancedMesh {
  const m = new InstancedMesh(geo, mat, Math.max(1, mats.length));
  mats.forEach((t, i) => {
    tmp.position.set(t.x, t.y, t.z);
    tmp.rotation.set(0, t.r, 0);
    tmp.scale.set(t.s, t.s * (t.sy ?? 1), t.s);
    tmp.updateMatrix();
    m.setMatrixAt(i, tmp.matrix);
  });
  m.count = mats.length;
  return m;
}

/** Flat ribbon along a polyline (local plane coords), uv.x = arc length, uv.y across. */
export function ribbon(pts: [number, number, number][], width: number): BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    const p = pts[i]!;
    if (i > 0) len += Math.hypot(p[0] - pts[i - 1]![0], p[2] - pts[i - 1]![2]);
    pos.push(p[0] + nx * width * 0.5, p[1], p[2] + nz * width * 0.5, p[0] - nx * width * 0.5, p[1], p[2] - nz * width * 0.5);
    uvs.push(len, 0, len, 1);
    if (i > 0) {
      const k = i * 2;
      idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function unitY(plane: Plane, u: Unit, ctx: Ctx): number {
  if (plane === 'surface') return ctx.fields.surface!.heightAt(wx(u.x - 0.5), wz(u.y - 0.5)) + 0.02;
  if (plane === 'depths') return ctx.fields.depths!.heightAt(wx(u.x - 0.5), wz(u.y - 0.5)) + 0.02;
  if (plane === 'sky') return u.kind === 'relay' ? 0.24 : 0.9;
  return 0;
}

const UNIT_SCALE: Partial<Record<Kind, number>> = { spire: 1, turret: 1, relay: 1, array: 1 };

export function assemble(ctx: Ctx, look: Look): void {
  const { roots } = ctx;
  // like the game: planes above the viewed one are faded out, the one below shows through as a ghost
  const vi = ctx.view === 'stack' ? -1 : PLANES.indexOf(ctx.view);
  for (const [i, p] of PLANES.entries()) {
    roots[p].position.y = PLANE_Y[p];
    roots[p].visible = vi < 0 || i === vi || i === vi - 1;
    ctx.scene.add(roots[p]);
  }

  // ---- surface
  const sf = buildField(SURFACE_MAP, SURFACE_H, ['F', 'C', 'W', 'X'], look.surfaceField);
  ctx.fields.surface = sf;
  roots.surface.add(new Mesh(sf.geometry, look.terrain('surface')));
  const water = new Mesh(new PlaneGeometry(S, S, 1, 1).rotateX(-Math.PI / 2), look.water());
  water.position.y = -0.1;
  water.renderOrder = 2;
  roots.surface.add(water);
  const tree = look.tree('surface');
  const trees: { x: number; y: number; z: number; s: number; r: number; sy?: number }[] = [];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (code(SURFACE_MAP, x, y) !== 'F') continue;
      for (let k = 0; k < tree.perCell; k++) {
        const tx = wx(x) + (hash2(x * 7 + k, y) - 0.5) * 0.7;
        const tz = wz(y) + (hash2(x, y * 7 + k) - 0.5) * 0.7;
        const s = tree.scale * (0.75 + hash2(x + k, y + 3) * 0.5);
        trees.push({ x: tx, y: sf.heightAt(tx, tz) - 0.02, z: tz, s, r: hash2(x, y + k) * 6.28, sy: 0.85 + hash2(y, x + k) * 0.4 });
      }
    }
  roots.surface.add(instanced(tree.geo, tree.mat, trees));
  // fault crack (skipped where it has opened into the chasm)
  const fpts: [number, number, number][] = [];
  const segs: [number, number, number][][] = [];
  for (let i = 0; i < FAULT.length - 1; i++) {
    const [ax, ay] = FAULT[i]!;
    const [bx, by] = FAULT[i + 1]!;
    for (let s = 0; s < 1; s += 0.1) {
      const x = wx(ax + (bx - ax) * s - 0.5) + (hash2(i, s * 100) - 0.5) * 0.12;
      const z = wz(ay + (by - ay) * s - 0.5) + (hash2(s * 100, i) - 0.5) * 0.12;
      const h = sf.heightAt(x, z);
      if (h < -0.2) {
        if (fpts.length > 1) segs.push(fpts.splice(0));
        fpts.length = 0;
        continue;
      }
      fpts.push([x, h + 0.03, z]);
    }
  }
  if (fpts.length > 1) segs.push(fpts);
  const faultMat = look.fault();
  for (const s of segs) roots.surface.add(new Mesh(ribbon(s, 0.32), faultMat));

  // ---- depths
  const df = buildField(DEPTHS_MAP, DEPTHS_H, ['O', 'M', 'TL', 'BK'], look.depthsField);
  ctx.fields.depths = df;
  roots.depths.add(new Mesh(df.geometry, look.terrain('depths')));
  const magma = new Mesh(new PlaneGeometry(S, S).rotateX(-Math.PI / 2), look.magma());
  magma.position.y = -0.06;
  roots.depths.add(magma);
  const rails = new Mesh(railGeometry(), look.rail());
  rails.position.y = 0.01;
  roots.depths.add(rails);
  const ore = look.ore();
  const crystals: { x: number; y: number; z: number; s: number; r: number; sy?: number }[] = [];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (code(DEPTHS_MAP, x, y) !== 'O') continue;
      for (let k = 0; k < 4; k++) {
        const cx = wx(x) + (hash2(x * 3 + k, y) - 0.5) * 0.7;
        const cz = wz(y) + (hash2(x, y * 3 + k) - 0.5) * 0.7;
        crystals.push({ x: cx, y: df.heightAt(cx, cz) - 0.05, z: cz, s: 0.35 + hash2(k, x + y) * 0.25, r: hash2(x + k, y) * 6.28, sy: 1.4 + hash2(y, k) });
      }
    }
  roots.depths.add(instanced(ore.geo, ore.mat, crystals));

  // ---- sky
  const islandMat = look.island();
  const skyTree = look.tree('sky');
  ISLANDS.forEach((isl, i) => {
    const m = new Mesh(islandGeometry(isl.r, i * 13 + 1), islandMat);
    m.position.set(wx(isl.x - 0.5), 0, wz(isl.y - 0.5));
    roots.sky.add(m);
    const tr: { x: number; y: number; z: number; s: number; r: number; sy?: number }[] = [];
    for (let k = 0; k < Math.round(isl.r * 2.2); k++) {
      const a = hash2(i, k) * 6.28;
      const d = (0.35 + hash2(k, i) * 0.45) * isl.r * 0.85;
      if (isl.team === 'blue' && d < 0.9) continue;
      tr.push({ x: m.position.x + Math.cos(a) * d, y: 0.1, z: m.position.z + Math.sin(a) * d, s: skyTree.scale * 0.8, r: a });
    }
    roots.sky.add(instanced(skyTree.geo, skyTree.mat, tr));
  });
  // a sparse cloud deck below the islands, plus one storm cell at unit height
  const cloudN = 13;
  for (let i = 0; i < cloudN; i++) {
    const storm = i >= cloudN - 3;
    const g = cloudGeometry(i + 3, storm ? 1.3 : 0.55 + hash2(i, 4) * 0.6);
    const m = new Mesh(g, look.cloud(storm));
    const sx = storm ? 12.6 + (i - cloudN + 3) * 1.2 : hash2(i, 1) * S;
    const sy = storm ? 12.2 + (i - cloudN + 3) * 0.9 : hash2(i, 2) * S;
    m.position.set(wx(sx - 0.5), storm ? -0.5 : -2.5 - hash2(i, 3) * 2.5, wz(sy - 0.5));
    m.rotation.y = hash2(i, 5) * 6.28;
    roots.sky.add(m);
  }
  // drift paths: circles around the (off-slice) map centre through each island
  const pathMat = look.path();
  for (const isl of ISLANDS) {
    const r = Math.hypot(isl.x - SUN_WEDGE.ax, isl.y - SUN_WEDGE.ay);
    const a0 = Math.atan2(isl.y - SUN_WEDGE.ay, isl.x - SUN_WEDGE.ax);
    const pts: [number, number, number][] = [];
    for (let a = a0 - 0.55; a <= a0 + 0.55; a += 0.01) {
      const px = SUN_WEDGE.ax + Math.cos(a) * r;
      const py = SUN_WEDGE.ay + Math.sin(a) * r;
      if (px >= 0 && px <= S && py >= 0 && py <= S) pts.push([wx(px - 0.5), 0.12, wz(py - 0.5)]);
    }
    roots.sky.add(new Mesh(ribbon(pts, 0.09), pathMat));
  }
  const skyVeil = new Mesh(new PlaneGeometry(S, S).rotateX(-Math.PI / 2), look.veil('sky'));
  skyVeil.position.y = 0.4;
  skyVeil.renderOrder = 5;
  roots.sky.add(skyVeil);

  // ---- orbit
  const wedge = new Mesh(wedgeGeometry(), look.sunWedge());
  wedge.position.y = -0.35;
  roots.orbit.add(wedge);
  const ast = new Mesh(asteroidGeometry(ASTEROID.r, 5), look.asteroid());
  ast.position.set(wx(ASTEROID.x - 0.5), 0.2, wz(ASTEROID.y - 0.5));
  ast.rotation.set(0.4, 0.8, 0.2);
  roots.orbit.add(ast);
  for (let k = 0; k < 7; k++) {
    const d = new Mesh(asteroidGeometry(0.12 + hash2(k, 9) * 0.18, k + 20), ast.material);
    d.position.set(wx(11 + hash2(k, 1) * 3.5), (hash2(k, 2) - 0.5) * 0.6, wz(1.5 + hash2(k, 3) * 3.5));
    roots.orbit.add(d);
  }
  const tug = UNITS.orbit.find((u) => u.kind === 'tug')!;
  const tether = new Mesh(
    ribbon(
      [
        [wx(tug.x - 0.5) + 0.3, 0.02, wz(tug.y - 0.5) - 0.3],
        [ast.position.x - 0.6, 0.05, ast.position.z + 0.6],
      ],
      0.05,
    ),
    look.path(),
  );
  roots.orbit.add(tether);
  const orbitVeil = new Mesh(new PlaneGeometry(S, S).rotateX(-Math.PI / 2), look.veil('orbit'));
  orbitVeil.position.y = -0.25;
  orbitVeil.renderOrder = 5;
  roots.orbit.add(orbitVeil);

  // ---- units (hidden in fog unless remembered)
  for (const p of PLANES) {
    for (const u of UNITS[p]) {
      if (u.team === 'red' && !u.ghost && !isVisible(p, u.x, u.y)) continue;
      const y = unitY(p, u, ctx);
      const m = new Mesh(unitGeometry(u.kind), look.unit(p, u.team, u.ghost ?? false));
      const s = UNIT_SCALE[u.kind] ?? 1.15;
      m.scale.setScalar(s);
      m.position.set(wx(u.x - 0.5), y, wz(u.y - 0.5));
      m.rotation.y = u.rot;
      m.renderOrder = 10;
      roots[p].add(m);
      const extra = look.unitExtra?.(u, p, y);
      if (extra) roots[p].add(extra);
    }
  }

  // ---- telegraphs
  const tg = (plane: Plane, x: number, y: number, r: number, t: number, h: number): void => {
    const m = new Mesh(new PlaneGeometry(r * 2, r * 2).rotateX(-Math.PI / 2), look.telegraph(plane, t));
    m.position.set(wx(x - 0.5), h, wz(y - 0.5));
    m.renderOrder = 8;
    roots[plane].add(m);
  };
  tg('surface', IMPACT.x, IMPACT.y, IMPACT.r, IMPACT.t, sf.heightAt(wx(IMPACT.x - 0.5), wz(IMPACT.y - 0.5)) + 0.08);
  tg('depths', CHARGE.x, CHARGE.y, CHARGE.r, CHARGE.t, 0.06);
  tg('orbit', ASTEROID.x, ASTEROID.y, 1.8, 0.2, -0.2);

  look.dress?.(ctx);
}

/** Lit sun wedge sector over the orbit slice (uv.x = angle 0..1 across the wedge, uv.y = radius 0..1). */
function wedgeGeometry(): BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const A = 40;
  const R = 34;
  const cx = wx(SUN_WEDGE.ax - 0.5);
  const cz = wz(SUN_WEDGE.ay - 0.5);
  for (let i = 0; i <= A; i++) {
    const a = SUN_WEDGE.angle - SUN_WEDGE.half + (2 * SUN_WEDGE.half * i) / A;
    for (const [rr, v] of [[0, 0], [R, 1]] as const) {
      pos.push(cx + Math.cos(a) * rr, 0, cz + Math.sin(a) * rr);
      uvs.push(i / A, v);
    }
    if (i > 0) {
      const k = i * 2;
      idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Simple ground disc for unit dressing. */
export function disc(r: number, mat: Material, x: number, y: number, z: number): Mesh {
  const m = new Mesh(new CircleGeometry(r, 24).rotateX(-Math.PI / 2), mat);
  m.position.set(x, y, z);
  return m;
}

/** A hex colour as a vec3 node (the TSL typings keep `color()` apart from `vec3`). */
export const rgb = (h: string): V3 => color(h) as unknown as V3;
