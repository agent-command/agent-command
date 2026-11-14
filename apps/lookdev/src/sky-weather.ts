/**
 * Sky weather study (`?dir=weather`), isolated from the simulation and the live client like the Orbit atlas. Weather
 * drawn as the thing itself instead of chart ink: lit storm clouds built from the cel puff clusters with lightning,
 * Wind Waker-style curling wind streaks along a jet lane, a low layered mist for a fog bank, a cloud-sea fog-of-war
 * wash, and island drift rings as the only lines (owner-tinted, the hovered one emphasised).
 *
 * URL: `zoom` normal | wide (camera distance 30 | 78, the game's play and zoomed-out range), `t` freezes the clock,
 * `flash` 0..1 forces the lightning envelope for stills.
 */
import {
  Color, DataTexture, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, LinearFilter,
  Mesh, MeshBasicNodeMaterial, Object3D, PlaneGeometry, RenderPipeline, RepeatWrapping, RGBAFormat, BlendMode,
  MaterialBlending, BufferAttribute, BufferGeometry, UnsignedByteType, type Node,
} from 'three/webgpu';
import {
  abs, color, cos, dot, float, instancedDynamicBufferAttribute, max, mix, mrt, mx_noise_float, normalView, output,
  packNormalToRGB, pass, perspectiveDepthToViewZ, positionGeometry, positionLocal, positionWorld, screenSize, screenUV,
  sin, smoothstep, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { cel } from './dirs/shared.ts';
import { clock, type Ctx, type F1, type V3 } from './kit.ts';
import { cloudGeometry, hash2, islandGeometry, unitGeometry } from './world.ts';

const q = new URLSearchParams(location.search);
const FORCE_FLASH = q.get('flash');

const PAPER = '#e4ecef';
const INK = '#22304a';
const TEAM = { blue: '#3aa8ff', red: '#ff4f5e', neutral: '#5d6878' };

// ------------------------------------------------------------------ shared building blocks
/** Line weight in the normal MRT alpha (the game's convention): 1 inked, 0 no lines (overlays). */
const LINED = mrt({ normal: vec4(packNormalToRGB(normalView), 1) });
const NO_LINES = mrt({ normal: vec4(0, 0, 0, 0) });

function overlay(m: MeshBasicNodeMaterial): MeshBasicNodeMaterial {
  m.transparent = true;
  m.depthWrite = false;
  m.mrtNode = NO_LINES;
  return m;
}

/** Tileable two-channel value-noise fbm (128², RGBA8: r = broad billows, g = fine), baked once. */
export function noiseTexture(size = 128): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const lattice = (cells: number, salt: number) => {
    const v = new Float32Array(cells * cells);
    for (let i = 0; i < v.length; i++) v[i] = hash2(i, salt);
    return (x: number, y: number) => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const at = (a: number, b: number) => v[((b % cells + cells) % cells) * cells + ((a % cells + cells) % cells)]!;
      const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
      const bot = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
      return top + (bot - top) * sy;
    };
  };
  const octaves = [lattice(4, 1), lattice(8, 2), lattice(16, 3), lattice(32, 4)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, w = y / size;
    const broad = octaves[0]!(u * 4, w * 4) * 0.55 + octaves[1]!(u * 8, w * 8) * 0.3 + octaves[2]!(u * 16, w * 16) * 0.15;
    const fine = octaves[2]!(u * 16, w * 16) * 0.6 + octaves[3]!(u * 32, w * 32) * 0.4;
    const o = (y * size + x) * 4;
    data[o] = Math.round(broad * 255);
    data[o + 1] = Math.round(fine * 255);
    data[o + 2] = 0;
    data[o + 3] = 255;
  }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}
const NOISE = noiseTexture();
const noise = (p: Node<'vec2'>): Node<'vec4'> => texture(NOISE, p) as unknown as Node<'vec4'>;

/** Lightning envelope for cell `id` at `s` seconds: occasional double-struck flashes, deterministic. */
export function flashAt(s: number, id: number): number {
  const P = 2.6;
  const u = s / P + hash2(id, 101);
  const slot = Math.floor(u);
  if (hash2(id * 31 + 7, slot) > 0.55) return 0;
  const dt = (u - slot - (0.1 + hash2(id * 31 + 9, slot) * 0.7)) * P;
  if (dt < 0 || dt > 0.6) return 0;
  return Math.min(1, Math.exp(-dt * 12) + (dt > 0.1 ? 0.85 * Math.exp(-(dt - 0.1) * 16) : 0));
}

// ------------------------------------------------------------------ storm
interface Puff { dx: number; dz: number; y: number; s: number; shape: number; spin: number }
/** Storm cluster layout for radius `r`: a towering core, an inner ring and a rim ring whose silhouette is the boundary. */
export function stormLayout(r: number, seed: number): Puff[] {
  const out: Puff[] = [{ dx: 0, dz: 0, y: -2.1, s: r * 0.36, shape: 0, spin: hash2(seed, 1) * 6.28 }];
  const n1 = Math.max(3, Math.round(r * 0.6));
  const n2 = Math.max(5, Math.round(r * 1.05));
  for (let i = 0; i < n1; i++) {
    const a = (i + hash2(seed, i + 10) * 0.5) / n1 * Math.PI * 2;
    out.push({ dx: Math.cos(a) * r * 0.42, dz: Math.sin(a) * r * 0.42, y: -1.9, s: r * (0.27 + hash2(seed, i + 20) * 0.05), shape: (i + 1) % 4, spin: a });
  }
  for (let i = 0; i < n2; i++) {
    const a = (i + 0.5 + hash2(seed, i + 30) * 0.4) / n2 * Math.PI * 2;
    out.push({ dx: Math.cos(a) * r * 0.74, dz: Math.sin(a) * r * 0.74, y: -1.5, s: r * (0.19 + hash2(seed, i + 40) * 0.04), shape: (i + 2) % 4, spin: a + 1.3 });
  }
  return out;
}

/**
 * Storm cloud: the cloud deck's cel puff with a bruised slate ramp. Drawn in the transparent queue (opaque, depth
 * writing) after the fog-of-war veil: the forecast is public, so storms are never washed out over unseen sky.
 */
function stormMaterial(flash: Node<'float'>): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.transparent = true;
  // pale lit crowns, an indigo belly; the cel ramp adds a violet shadow side
  const h = positionLocal.y.mul(1.5).add(0.4).clamp(0, 1);
  const base = mix(color('#3c405c'), color('#a3a6bd'), h) as V3;
  const lit = cel(base, '#66659a', 1, 1, 0.3);
  // lightning lights the cloud from inside, brightest in the belly; only the strike's neighbours pass 1 and bloom
  const glow = color('#d9d3ff').mul(flash.mul(flash).mul(float(1.5).sub(h.mul(0.7)))) as V3;
  m.colorNode = mix(lit, color('#e9e6ff'), flash.mul(0.45)).add(glow);
  m.mrtNode = LINED;
  return m;
}

/** Jagged bolt: midpoint-displaced polyline with two forks as a flat ribbon, unit length along +x. */
export function boltGeometry(seed: number): BufferGeometry {
  const pos: number[] = [], uvs: number[] = [];
  const strand = (pts: [number, number, number][], w: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay, az] = pts[i]!, [bx, by, bz] = pts[i + 1]!;
      const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l * w, nz = dx / l * w;
      const u0 = i / (pts.length - 1), u1 = (i + 1) / (pts.length - 1);
      const taper0 = 1 - u0 * 0.7, taper1 = 1 - u1 * 0.7;
      const quad: [number, number, number, number, number][] = [
        [ax - nx * taper0, ay, az - nz * taper0, u0, 0], [ax + nx * taper0, ay, az + nz * taper0, u0, 1],
        [bx + nx * taper1, by, bz + nz * taper1, u1, 1], [bx - nx * taper1, by, bz - nz * taper1, u1, 0],
      ];
      for (const k of [0, 1, 2, 0, 2, 3]) { const v = quad[k]!; pos.push(v[0], v[1], v[2]); uvs.push(v[3], v[4]); }
    }
  };
  const jag = (ax: number, az: number, bx: number, bz: number, depth: number, salt: number): [number, number, number][] => {
    let pts: [number, number][] = [[ax, az], [bx, bz]];
    for (let d = 0; d < depth; d++) {
      const next: [number, number][] = [pts[0]!];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, z0] = pts[i]!, [x1, z1] = pts[i + 1]!;
        const l = Math.hypot(x1 - x0, z1 - z0);
        const off = (hash2(seed * 97 + salt, d * 64 + i) - 0.5) * l * 0.55;
        next.push([(x0 + x1) / 2 - (z1 - z0) / l * off, (z0 + z1) / 2 + (x1 - x0) / l * off], pts[i + 1]!);
      }
      pts = next;
    }
    // drape over the cloud crowns
    return pts.map(([x, z]) => [x, Math.sin(Math.min(1, Math.hypot(x, z)) * Math.PI) * 0.25, z]);
  };
  const main = jag(0, 0, 1, (hash2(seed, 3) - 0.5) * 0.3, 5, 0);
  strand(main, 0.045);
  const fork = (at: number, salt: number) => {
    const p = main[Math.floor(at * (main.length - 1))]!;
    const a = (hash2(seed, salt) - 0.5) * 1.6;
    strand(jag(p[0], p[2], p[0] + Math.cos(a) * 0.4, p[2] + Math.sin(a) * 0.4, 4, salt), 0.03);
  };
  fork(0.35, 11);
  fork(0.6, 12);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  return g;
}

/** White-hot core in a violet halo; drawn over the crowns (a strike lasts a few frames, so no depth test). */
function boltMaterial(alpha: Node<'float'>): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
  m.depthTest = false;
  const across = abs(uv().y.sub(0.5)).mul(2);
  const core = float(1).sub(smoothstep(0.1, 0.4, across));
  m.colorNode = mix(color('#9d8fff').mul(1.3), color('#ffffff').mul(3.5), core);
  m.opacityNode = float(1).sub(smoothstep(0.5, 1, across)).mul(alpha);
  return m;
}

// ------------------------------------------------------------------ wind
export const STREAK_SEGS = 40;
/** Strip along u (uv.x 0..1) with two edge vertices (uv.y 0/1); the vertex shader lays it out. */
export function streakGeometry(): BufferGeometry {
  const pos = new Float32Array((STREAK_SEGS + 1) * 2 * 3);
  const uvs = new Float32Array((STREAK_SEGS + 1) * 2 * 2);
  const idx: number[] = [];
  for (let i = 0; i <= STREAK_SEGS; i++) {
    for (let j = 0; j < 2; j++) { uvs[(i * 2 + j) * 2] = i / STREAK_SEGS; uvs[(i * 2 + j) * 2 + 1] = j; }
    if (i < STREAK_SEGS) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Wind Waker wind trail, all on the GPU: each instance (seed, lateral offset, curl, period) respawns at a hashed spot
 * every period, draws its head forward along a gently waving path that may end in a loop, then its tail chases the
 * head out. `lane` = (x1, z1, dx, dz), `dims` = (lane length, streak length, speed, height).
 */
function streakMaterial(a: Node<'vec4'>, lane: Node<'vec4'>, dims: Node<'vec4'>, fade: Node<'float'>): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
  const seed = a.x, offset = a.y, curl = a.z, period = a.w;
  const len = dims.y, speed = dims.z;
  const cyc = clock.div(period).add(seed.mul(13.7));
  const k = cyc.floor();
  const ph = cyc.fract();
  const room = dims.x.sub(len).sub(speed.mul(period)).max(0);
  const start = k.mul(0.618).add(seed.mul(7.13)).fract().mul(room);
  const head = smoothstep(0, 0.55, ph);
  const tail = smoothstep(0.4, 1, ph);
  const along = start.add(ph.mul(speed).mul(period));
  const C = 0.6;
  const R = len.mul(0.07);
  const sideSign = seed.mul(17.3).fract().greaterThan(0.5).select(float(1), float(-1));
  // path point at u: along-lane distance and lateral offset
  const path = (u: F1): Node<'vec2'> => {
    const wave = sin(u.mul(4.2).add(seed.mul(40))).mul(0.22);
    const th = u.sub(C).max(0).div(1 - C).mul(5.6);
    const looped = curl.greaterThan(0.5).and(u.greaterThan(C));
    const loopA = u.min(C).mul(len).add(sin(th).mul(R));
    const loopL = sin(float(C).mul(4.2).add(seed.mul(40))).mul(0.22).add(float(1).sub(cos(th)).mul(R).mul(sideSign));
    return vec2(looped.select(loopA, u.mul(len)), looped.select(loopL, wave));
  };
  const u = uv().x as F1;
  const p0 = path(u);
  const p1 = path(u.add(0.01) as F1);
  const t = p1.sub(p0).normalize();
  const vis = smoothstep(tail, tail.add(0.06), u).mul(float(1).sub(smoothstep(head.sub(0.06), head, u)));
  const span = head.sub(tail).max(1e-3);
  const taper = sin(u.sub(tail).div(span).clamp(0, 1).mul(Math.PI)).max(0).pow(0.6);
  const w = float(0.16).mul(taper).mul(vis);
  const side = uv().y.mul(2).sub(1);
  // lane frame: along = (dx, dz), lateral = (-dz, dx)
  const dir = lane.zw, perp = vec2(lane.w.negate(), lane.z);
  const at = lane.xy.add(dir.mul(along.add(p0.x))).add(perp.mul(offset.add(p0.y)));
  const nrm = dir.mul(t.y.negate()).add(perp.mul(t.x));
  const xz = at.add(nrm.mul(w.mul(side)));
  m.positionNode = vec3(xz.x, dims.w.add(sin(u.mul(3).add(seed.mul(9))).mul(0.12)), xz.y);
  const s = abs(side);
  m.colorNode = mix(color('#ffffff'), color('#9fb3cf'), smoothstep(0.2, 1, s));
  m.opacityNode = float(1).sub(smoothstep(0.65, 1, s)).mul(vis).mul(0.95).mul(fade);
  return m;
}

// ------------------------------------------------------------------ fog
/**
 * Low layered mist: stacked horizontal slices of scrolling baked noise, stretched into stratified wisps (horizontal
 * banding reads as fog on paper), blue-grey in the low slices and white on top, with a billowing lost edge.
 */
function mistMaterial(cell: Node<'vec4'>, slice: Node<'float'>, fade: Node<'float'>): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
  const p = positionWorld.xz;
  const d = p.sub(cell.xy).length().div(cell.z);
  const drift = vec2(clock.mul(0.018), clock.mul(0.005));
  const n1 = noise(p.mul(vec2(0.03, 0.06)).add(drift.mul(slice.add(1))).add(slice.mul(0.37))).x;
  const n2 = noise(p.mul(vec2(0.08, 0.16)).sub(drift.mul(2)).add(slice.mul(0.71))).y;
  const billow = n1.mul(0.65).add(n2.mul(0.35));
  // noise-broken edge, hard-limited inside the 2.6r quad
  const edge = float(1).sub(smoothstep(0.45, 1.0, d.add(billow.sub(0.5).mul(0.9)))).mul(float(1).sub(smoothstep(0.95, 1.25, d)));
  const body = smoothstep(0.28, 0.6, billow.add(float(1).sub(d).mul(0.25)));
  // the lowest slice is the shadowed underside; the rest are white crests with soft blue-grey troughs
  const low = float(1).sub(slice.min(1));
  const crest = smoothstep(0.42, 0.72, billow);
  m.colorNode = mix(mix(color('#c2ccd9'), color('#ffffff'), crest), color('#aebacb'), low.mul(0.8));
  m.opacityNode = edge.mul(body).mul(mix(float(0.5), float(0.42), low)).mul(fade);
  return m;
}

// ------------------------------------------------------------------ fog of war: a cloud-sea wash (no hatching)
function seaVeil(seen: F1): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
  const p = positionWorld.xz;
  const n = noise(p.mul(0.028)).x.mul(0.65).add(noise(p.mul(0.085)).y.mul(0.35));
  m.colorNode = mix(color(PAPER), color('#c3ceda'), smoothstep(0.4, 0.8, n).mul(0.55));
  m.opacityNode = float(1).sub(seen).mul(0.78);
  return m;
}

// ------------------------------------------------------------------ drift rings (constant world width)
export function ringGeometry(segs = 128): BufferGeometry {
  const pos = new Float32Array((segs + 1) * 2 * 3), uvs = new Float32Array((segs + 1) * 2 * 2);
  const idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = i / segs * Math.PI * 2;
    for (let j = 0; j < 2; j++) {
      const o = i * 2 + j;
      pos[o * 3] = Math.cos(a); pos[o * 3 + 2] = Math.sin(a);
      uvs[o * 2] = i / segs; uvs[o * 2 + 1] = j;
    }
    if (i < segs) { const b = i * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

function ringMaterial(data: Node<'vec4'>, tint: Node<'vec4'>): MeshBasicNodeMaterial {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
  const e = uv().y.sub(0.5);
  const r = data.z.add(e.mul(data.w));
  m.positionNode = vec3(data.x.add(positionGeometry.x.mul(r)), 0.35, data.y.add(positionGeometry.z.mul(r)));
  m.colorNode = tint.xyz;
  m.opacityNode = tint.w.mul(float(1).sub(smoothstep(0.3, 0.5, abs(e))).mul(0.5).add(0.5));
  return m;
}

// ------------------------------------------------------------------ scene
const tmp = new Object3D();

export function assembleSkyWeather(ctx: Ctx): { update(t: number): void; post(): RenderPipeline } {
  const { scene } = ctx;
  const root = ctx.roots.sky;
  root.position.y = 0;
  scene.add(root);

  // cloud deck below the islands (the existing look: white crowns, cool grey belly)
  const deckMat = new MeshBasicNodeMaterial();
  deckMat.colorNode = cel(mix(color('#dde4f0'), color('#ffffff'), positionLocal.y.mul(2.2).add(0.35).clamp(0, 1)) as V3, '#9fb0d6', 1, 1, 0.35);
  deckMat.mrtNode = LINED;
  const shapes = [0, 1, 2, 3].map((k) => cloudGeometry(k * 7 + 3, 1));
  for (let i = 0; i < 18; i++) {
    const m = new Mesh(shapes[i % 4]!, deckMat);
    m.position.set((hash2(i, 1) - 0.5) * 60, -6 + hash2(i, 4) * 3, (hash2(i, 2) - 0.5) * 60);
    m.scale.setScalar(1.3 + hash2(i, 5) * 1.5);
    m.rotation.y = hash2(i, 6) * 6;
    root.add(m);
  }

  // islands + their drift rings: own (blue), enemy (red), neutral; the first is "hovered"
  const islandMat = new MeshBasicNodeMaterial();
  const top = positionLocal.y.greaterThan(-0.05);
  islandMat.colorNode = cel(top.select(color('#a6c477'), color('#a3907c')) as unknown as V3, '#9fb0d6');
  islandMat.mrtNode = LINED;
  const islands = [
    { x: 2, z: -2, cx: -3, cz: -7, r: 6.5, side: 'blue' as const, hi: true },
    { x: 13, z: 8, cx: 8, cz: 4, r: 6, side: 'red' as const, hi: false },
    { x: -16, z: -12, cx: -12, cz: -8, r: 5, side: 'neutral' as const, hi: false },
  ];
  const ringData = new InstancedBufferAttribute(new Float32Array(islands.length * 4), 4);
  const ringTint = new InstancedBufferAttribute(new Float32Array(islands.length * 4), 4);
  islands.forEach((p, i) => {
    const g = new Mesh(islandGeometry(2.1, i + 1), islandMat);
    const a = Math.atan2(p.z - p.cz, p.x - p.cx);
    const px = p.cx + Math.cos(a) * p.r, pz = p.cz + Math.sin(a) * p.r;
    g.position.set(px, 0, pz);
    root.add(g);
    ringData.setXYZW(i, p.cx, p.cz, p.r, p.hi ? 0.2 : 0.09);
    const c = new Color(TEAM[p.side]);
    ringTint.setXYZW(i, c.r, c.g, c.b, p.hi ? 0.95 : 0.5);
  });
  const rings = new InstancedMesh(ringGeometry(), ringMaterial(instancedDynamicBufferAttribute<'vec4'>(ringData, 'vec4'), instancedDynamicBufferAttribute<'vec4'>(ringTint, 'vec4')), islands.length);
  rings.frustumCulled = false;
  rings.renderOrder = 6;
  root.add(rings);

  // aircraft: two in the storm, one in the fog, one riding the wind
  const unitMat = new MeshBasicNodeMaterial();
  unitMat.colorNode = cel(color(TEAM.blue) as unknown as V3, '#9fb0d6');
  unitMat.mrtNode = LINED;
  const ug = unitGeometry('interceptor');
  for (const [x, z, r] of [[-11, 0, 0.4], [-8.5, 2.5, 0.6], [6, -6, -2.2], [0, 8.6, 0]] as const) {
    const u = new Mesh(ug, unitMat);
    u.position.set(x, 1.6, z);
    u.rotation.y = r;
    u.scale.setScalar(1.35);
    root.add(u);
  }

  // storm cell (game radius 8)
  const storm = { x: -10, z: 1, r: 8 };
  const layout = stormLayout(storm.r, 3);
  // one InstancedMesh per puff shape; each has its own per-instance flash
  const counts = shapes.map((_, k) => layout.filter((p) => p.shape === k).length);
  const bucketFlash = counts.map((n) => new InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1).setUsage(DynamicDrawUsage));
  const stormMeshes = shapes.map((g, k) => {
    const m = new InstancedMesh(g, stormMaterial(instancedDynamicBufferAttribute<'float'>(bucketFlash[k]!, 'float')), Math.max(1, counts[k]!));
    m.frustumCulled = false;
    m.renderOrder = 6;
    root.add(m);
    return m;
  });
  const boltAlpha = uniform(0);
  const bolt = new Mesh(boltGeometry(5), boltMaterial(boltAlpha));
  bolt.renderOrder = 8;
  root.add(bolt);

  // fog bank (game radius 6), four slices
  const fog = { x: 7, z: -7, r: 6 };
  const SLICES = 4;
  const fogCell = new InstancedBufferAttribute(new Float32Array(SLICES * 4), 4);
  for (let i = 0; i < SLICES; i++) fogCell.setXYZW(i, fog.x, fog.z, fog.r, i);
  const cellNode = instancedDynamicBufferAttribute<'vec4'>(fogCell, 'vec4');
  const mist = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mistMaterial(cellNode, cellNode.w, float(1)), SLICES);
  for (let i = 0; i < SLICES; i++) {
    tmp.position.set(fog.x, -0.7 + i * 0.65, fog.z);
    tmp.rotation.set(0, 0, 0);
    tmp.scale.set(fog.r * 2.6, 1, fog.r * 2.6);
    tmp.updateMatrix();
    mist.setMatrixAt(i, tmp.matrix);
  }
  mist.frustumCulled = false;
  mist.renderOrder = 7;
  root.add(mist);

  // jet lane along +x, half-width 3 (the game's jetWidth)
  const lane = { x1: -32, z1: 8, dx: 1, dz: 0, len: 64, w: 3 };
  const N = 40;
  const sA = new InstancedBufferAttribute(new Float32Array(N * 4), 4);
  const sLane = new InstancedBufferAttribute(new Float32Array(N * 4), 4);
  const sDims = new InstancedBufferAttribute(new Float32Array(N * 4), 4);
  for (let i = 0; i < N; i++) {
    sA.setXYZW(i, hash2(i, 51), (hash2(i, 52) * 2 - 1) * lane.w * 0.85, hash2(i, 53) < 0.45 ? 1 : 0, 2.4 + hash2(i, 54) * 1.4);
    sLane.setXYZW(i, lane.x1, lane.z1, lane.dx, lane.dz);
    sDims.setXYZW(i, lane.len, 6 + hash2(i, 55) * 5, 3.2 + hash2(i, 56) * 1.2, 1.0 + hash2(i, 57) * 1.3);
  }
  const streaks = new InstancedMesh(streakGeometry(), streakMaterial(
    instancedDynamicBufferAttribute<'vec4'>(sA, 'vec4'), instancedDynamicBufferAttribute<'vec4'>(sLane, 'vec4'),
    instancedDynamicBufferAttribute<'vec4'>(sDims, 'vec4'), float(1)), N);
  streaks.frustumCulled = false;
  streaks.renderOrder = 7;
  root.add(streaks);


  // fog of war: everything farther than 20 from the near corner is unseen
  const seen = float(1).sub(smoothstep(19, 22, positionWorld.xz.sub(vec2(-4, -2)).length())) as F1;
  const veil = new Mesh(new PlaneGeometry(90, 90).rotateX(-Math.PI / 2), seaVeil(seen));
  veil.position.y = 0.15;
  veil.renderOrder = 5;
  root.add(veil);

  const fill = new Uint16Array(4);
  const update = (t: number) => {
    // storm: slow churn of the whole cluster; puff matrices + flash per bucket
    const f = FORCE_FLASH !== null ? Number(FORCE_FLASH) : flashAt(t, 0);
    const strike = hash2(Math.floor(t / 2.6), 77) * Math.PI * 2;
    const sx = storm.x + Math.cos(strike) * storm.r * 0.25, sz = storm.z + Math.sin(strike) * storm.r * 0.25;
    fill.fill(0);
    for (const p of layout) {
      const k = p.shape;
      const j = fill[k]!++;
      const a = t * 0.02;
      const x = storm.x + p.dx * Math.cos(a) - p.dz * Math.sin(a), z = storm.z + p.dx * Math.sin(a) + p.dz * Math.cos(a);
      tmp.position.set(x, p.y + Math.sin(t * 0.4 + p.spin) * 0.08, z);
      tmp.rotation.set(0, p.spin + t * 0.03, 0);
      tmp.scale.set(p.s, p.s * 1.25, p.s);
      tmp.updateMatrix();
      stormMeshes[k]!.setMatrixAt(j, tmp.matrix);
      const near = 1 - Math.min(1, Math.hypot(x - sx, z - sz) / (storm.r * 0.9));
      bucketFlash[k]!.setX(j, f * (0.12 + 0.88 * near * near));
    }
    stormMeshes.forEach((m, k) => { m.count = fill[k]!; m.instanceMatrix.needsUpdate = true; bucketFlash[k]!.needsUpdate = true; });
    boltAlpha.value = f;
    bolt.visible = f > 0.02;
    bolt.position.set(sx, 1.1, sz);
    bolt.rotation.y = strike;
    bolt.scale.set(storm.r * 0.75, 1, storm.r * 0.75 * (hash2(Math.floor(t / 2.6), 78) > 0.5 ? 1 : -1));
  };

  const post = () => {
    const scenePass = pass(scene, ctx.camera);
    scenePass.setMRT(mrt({ output, normal: vec4(packNormalToRGB(normalView), 1) }).setBlendMode('normal', new BlendMode(MaterialBlending)));
    scenePass.getTexture('normal').type = UnsignedByteType;
    const col = scenePass.getTextureNode('output');
    const nrm = scenePass.getTextureNode('normal');
    const dep = scenePass.getTextureNode('depth');
    const near = uniform(ctx.camera.near), far = uniform(ctx.camera.far);
    const jitter = mx_noise_float(vec3(screenUV.mul(vec2(9, 6)), 1)).mul(0.35).add(1);
    const o = vec2(1.25, 1.25).div(screenSize).mul(jitter);
    const taps = [screenUV, screenUV.add(vec2(o.x, 0)), screenUV.sub(vec2(o.x, 0)), screenUV.add(vec2(0, o.y)), screenUV.sub(vec2(0, o.y))];
    const z = taps.map((u) => perspectiveDepthToViewZ(dep.sample(u).r, near, far).negate() as F1);
    const s = taps.map((u) => nrm.sample(u) as Node<'vec4'>);
    const n = s.map((tt) => tt.xyz.mul(2).sub(1) as V3);
    const z0 = z[0]!, n0 = n[0]!;
    const lap = abs(z[1]!.add(z[2]!).sub(z0.mul(2))).add(abs(z[3]!.add(z[4]!).sub(z0.mul(2)))).div(z0);
    const nd = float(4).sub(dot(n0, n[1]!).add(dot(n0, n[2]!)).add(dot(n0, n[3]!)).add(dot(n0, n[4]!)));
    const w = max(max(s[0]!.w, s[1]!.w), max(max(s[2]!.w, s[3]!.w), s[4]!.w));
    const e = max(smoothstep(0.006, 0.02, lap), smoothstep(0.3, 0.65, nd)).mul(smoothstep(0.02, 0.1, w)).mul(0.85);
    let out = mix(col.rgb, color(INK), e) as V3;
    const g = mx_noise_float(vec3(screenUV.mul(vec2(520, 300)), 0)).mul(0.035);
    const fib = mx_noise_float(vec3(screenUV.mul(vec2(60, 900)), 3)).mul(0.02);
    const vig = float(1).sub(screenUV.sub(0.5).length().mul(0.35));
    out = out.mul(float(1).add(g).add(fib)).mul(vig) as V3;
    const pipe = new RenderPipeline(ctx.renderer);
    pipe.outputNode = out.add(bloom(col, 0.45, 0.3, 1.0).rgb);
    return pipe;
  };
  return { update, post };
}
