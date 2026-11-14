/**
 * Field Journal shading (docs/art/DIRECTIONS.md §1): unlit `MeshBasicNodeMaterial` with a two-tone cel ramp
 * (hue-shifted shadows, thin highlight, stepped AO), ink lines from the post pass, and a paper `finish()` with three
 * fog tiers:
 * - visible → paint; explored but not visible → the unpainted pencil drawing (three graphite values, hatching only in
 *   the darkest), with a watercolour edge-darkening rim where vision ends; never seen → blank paper, outlines only;
 * - ghosted plane → faint construction pencil on the viewed plane's paper.
 * There are no scene lights: the key light is the `SUN` uniform.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DepthTexture,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  type MRTNode,
  type Node,
  type NodeMaterial,
} from 'three/webgpu';
import { abs, cameraFar, cameraNear, color, dot, float, fwidth, max, mix, mrt, normalView, normalWorld, packNormalToRGB, perspectiveDepthToViewZ, positionLocal, positionView, positionWorld, screenUV, sin, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { PLANES, rotVX, rotVY, type Plane } from '@agent-command/game/contract';
import { FADE } from './fade.ts';
import { MAP_SIZE, mapUV, type FogField } from './fog.ts';
import { DARK, PAPER, PENCIL, SHADOW, VIEW } from './palette.ts';
import { hash2 } from './common.ts';
import { prepareStartup } from './startup.ts';

export type V3 = Node<'vec3'>;
export type F1 = Node<'float'>;

const T0 = performance.now();
/** Client clock (seconds since load) for effects keyed to server ticks; advanced by `World.frame`. */
export const clock = uniform(0);
/** performance.now() milliseconds → `clock` seconds. */
export const clockAt = (ms: number): number => (ms - T0) / 1000;

/**
 * The Surface breeze (forest canopies, ground grass): a sine travelling across the map, rate rad/s and wavenumbers
 * along x and z, bending a stem by `amp` × height² (its tip most), `skew` of it across z.
 */
export const WIND = { rate: 1.3, kx: 0.7, kz: 0.5, amp: 0.04, skew: 0.35 } as const;
/** The breeze's local offset of a vertex `height` up its plant (world units), on the client clock. */
export function windBend(height: F1): V3 {
  const bend = sin(clock.mul(WIND.rate).add(positionLocal.x.mul(WIND.kx)).add(positionLocal.z.mul(WIND.kz))).mul(height.max(0).mul(height)).mul(WIND.amp);
  return vec3(bend, 0, bend.mul(WIND.skew)) as unknown as V3;
}

/**
 * A placeholder geometry for a mesh whose real geometry arrives later: an empty `position` attribute, so warming
 * its material up compiles against the attribute it will read (no "position not found" warning).
 */
export function emptyGeometry(): BufferGeometry {
  return new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
}

/** Direction toward the key light, in world space. Upper-left of the screen in the army's default camera. */
export const SUN_DIR = new Vector3(0.62, 0.72, -0.24).normalize();
export const SUN = uniform(SUN_DIR.clone());

/** Point the key light for the camera of the army in `frame` (its horizontal direction turns with the camera yaw). */
export function setSun(frame: number): void {
  SUN_DIR.set(rotVX(frame, 0.62, -0.24), 0.72, rotVY(frame, 0.62, -0.24)).normalize();
  SUN.value.copy(SUN_DIR);
}

/** A hex colour as a vec3 node (the TSL typings keep `color()` apart from `vec3`). */
export const rgb = (hex: string): V3 => color(hex) as unknown as V3;

/** Luminance used for tone banding (graphite values, hatching). */
export const lum = (c: V3): F1 => dot(c, vec3(0.3, 0.55, 0.15)) as F1;

/**
 * Two-tone cel ramp with a hue-shifted shadow, a thin highlight band and stepped AO. `sunVis` is the baked (terrain)
 * or 1 (units) sun visibility; `soft` widens the terminator (clouds).
 */
export function cel(base: V3, shadowTint: string, sunVis: F1 | number = 1, ao: F1 | number = 1, soft = 0.08): V3 {
  const ndl = dot(normalWorld, SUN);
  const sv: F1 = typeof sunVis === 'number' ? float(sunVis) : sunVis;
  const occ: F1 = typeof ao === 'number' ? float(ao) : ao;
  const lit = smoothstep(0, soft, ndl).mul(smoothstep(0.3, 0.55, sv));
  const hi = smoothstep(0.7, 0.76, ndl).mul(lit).mul(0.1);
  const shade = base.mul(color(shadowTint));
  const occl = mix(float(0.74), float(1), smoothstep(0.55, 0.8, occ));
  return mix(shade, base, lit).add(hi).mul(occl) as V3;
}

/**
 * Antialiased line mask for a scalar field whose integer+0.5 crossings are lines; `w` = half width (0..0.5). Lines
 * thinner than a pixel fade with their width (w → 0 draws nothing, not a hairline), and where they get denser than
 * about two per pixel they settle to their mean coverage (2w) instead of breaking into moiré.
 */
export function lines(s: F1, w: F1 | number): F1 {
  const d = abs(s.fract().sub(0.5));
  const fw = fwidth(s).max(1e-4);
  const wn: F1 = typeof w === 'number' ? float(w) : w;
  const line = float(1).sub(smoothstep(wn.sub(fw), wn.add(fw), d)).mul(wn.div(fw).clamp(0, 1));
  return mix(line, wn.mul(2), smoothstep(0.25, 0.6, fw)) as F1;
}

/** World-space tonal hatching: one direction below `tone` 0.75, cross-hatch below 0.45. Returns ink coverage. */
export function hatch(tone: F1, freq = 7): F1 {
  const p = positionWorld;
  const s1 = dot(p, vec3(1, 0.7, 1)).mul(freq) as F1;
  const s2 = dot(p, vec3(1, -0.7, -1)).mul(freq) as F1;
  const w1 = smoothstep(0.85, 0.35, tone).mul(0.32);
  const w2 = smoothstep(0.5, 0.15, tone).mul(0.28);
  return max(lines(s1, w1), lines(s2, w2)) as F1;
}

/** Visibility (0..1) of this fragment for the viewing team, thresholded from the bilinear fog with a noisy edge. */
export function seen(plane: Plane, fogField?: FogField): F1 {
  return smoothstep(0.3, 0.7, fogField ? fogField.fogAt(plane).x : float(1)) as F1;
}

export interface FinishOpts {
  /** World-owned fog; omitted for fully visible offline scenes. */
  fogField?: FogField | undefined;
  /** Emissive added on top of the paint (visible plane only). */
  glow?: V3 | undefined;
  /** false: never fogged (public information, own units). */
  fog?: boolean | undefined;
  /** Colour the graphite tone is taken from (default: the painted colour). */
  tone?: V3 | undefined;
}

/**
 * Paint → pencil → blank page → ghost construction pencil (see file header). Three fog tiers from the fog texture:
 * visible = painted; explored but not visible = the pencil drawing (three graphite values, hatching in the darkest);
 * never seen = blank paper with the outline ink only (the Depths: a section fill), so the map stays navigable but
 * plainly unknown. A watercolour rim darkens the paint where vision ends.
 */
export function finish(col: V3, plane: Plane, o: FinishOpts = {}): V3 {
  const tone = lum(o.tone ?? col).div(0.75).clamp(0, 1) as F1;
  const dark = DARK[plane];
  const band = smoothstep(0.3, 0.5, tone).add(smoothstep(0.6, 0.8, tone)).mul(0.5);
  const ghost = mix(VIEW.paper, VIEW.ghostPencil, float(1).sub(band).mul(0.2).add(0.07));
  let painted = col;
  let shown: V3;
  if (o.fog === false || !o.fogField) {
    if (o.glow) painted = painted.add(o.glow) as V3;
    shown = painted;
  } else {
    const fog = o.fogField.fogAt(plane);
    const v = smoothstep(0.3, 0.7, fog.x);
    const known = smoothstep(0.3, 0.7, fog.y);
    const paper = color(PAPER[plane]).mul(dark ? 1.15 : 1);
    const pencil = color(PENCIL[plane]);
    const deepHatch = hatch(float(0.6) as F1, 4.5).mul(float(1).sub(smoothstep(0.3, 0.42, tone)));
    // light paper: graphite darkens shadows; dark paper: chalk picks out the lit faces
    const graphite = dark ? band.mul(0.3).add(deepHatch.mul(0.12)).add(0.05) : float(1).sub(band).mul(0.28).add(deepHatch.mul(0.3)).add(0.04);
    const fill = plane === 'depths' ? lines(positionWorld.x.add(positionWorld.z).mul(2.2) as F1, 0.08).mul(0.3).add(0.03) : float(0.025);
    const sketch = mix(mix(paper, pencil, fill), mix(paper, pencil, graphite), known);
    const rim = smoothstep(0.35, 0.55, v).mul(float(1).sub(smoothstep(0.55, 0.9, v)));
    painted = painted.mul(float(1).sub(rim.mul(0.28))) as V3;
    if (o.glow) painted = painted.add(o.glow) as V3;
    shown = mix(sketch, painted, smoothstep(0.45, 0.55, v)) as V3;
  }
  return mix(ghost, shown, FADE[plane].focus) as V3;
}

/**
 * 1 on the diorama skirt cut down from the map edge (`FieldMesh`), 0 elsewhere. The skirt's vertices only repeat the
 * border samples, so per-cell paint, fog and marks there would stretch the last texels straight down the wall.
 */
export const mapEdge = (): F1 => smoothstep(MAP_SIZE.mul(0.5).sub(0.004), MAP_SIZE.mul(0.5).sub(0.002), max(abs(positionWorld.x), abs(positionWorld.z))) as F1;

/**
 * The map's cut edge as a plain section on the plane's paper: strata ruled in pencil, darkening toward the `skirt`
 * floor (local y), toned by the key light. Never fogged: it describes no cell, only the sheet's thickness.
 */
export function edgeSection(plane: Plane, skirt: number): V3 {
  const y = positionLocal.y;
  const depth = smoothstep(0, skirt, y);
  const strata = lines(y.mul(2.5) as F1, 0.05);
  const lit = mix(float(0.84), float(1), smoothstep(-0.3, 0.4, dot(normalWorld, SUN)));
  const col = mix(color(PAPER[plane]), color(PENCIL[plane]), strata.mul(0.4).add(depth.mul(0.2)).add(0.06)).mul(lit) as V3;
  return finish(col, plane, { fog: false });
}

// ---------------------------------------------------------------- line control (MRT normal attachment)
/**
 * The post pass reads view normals (rgb) and a line weight (a) from the scene MRT. Weight 1 = full ink line,
 * 0.5 = faint ghost pencil, 0 = no line. Plane materials write their plane's weight; overlays write nothing.
 */
export const sceneNormal = (weight: F1 | number): Node<'vec4'> => vec4(packNormalToRGB(normalView), weight);
const LINES = Object.fromEntries(PLANES.map((p) => [p, mrt({ normal: sceneNormal(FADE[p].focus.mul(0.5).add(0.5) as F1) })])) as Record<Plane, MRTNode>;
/**
 * Transparent overlays (water, veils, telegraphs, rings, FX): write a zero normal with zero alpha, which blends into
 * nothing (the pass MRT blends `normal` with each material's mode, `ink.ts`), so lines below them stay untouched.
 */
export const NO_LINES = mrt({ normal: vec4(0, 0, 0, 0) });

/** Mark a blended overlay material: no depth write, no lines. Returns it for chaining. */
export function overlay<M extends NodeMaterial>(m: M): M {
  m.transparent = true;
  m.depthWrite = false;
  m.mrtNode = NO_LINES;
  return m;
}

/** The ink scene pass's depth (`inkPipeline` binds it), for command overlays drawn in a later pass. */
export const SCENE_DEPTH = texture(new DepthTexture(1, 1));

/**
 * The viewer's command overlays (selection markers, order lines): `overlay` materials drawn by the ink overlay pass
 * after the Sky's storms. That pass has no scene depth, so each fragment tests itself against the scene pass's:
 * terrain, decks, Spires and models in front still hide it, and coplanar decals still show. The test runs per
 * fragment, so MSAA keeps thin lines antialiased. Slack, in view units: the fragment's depth change across one pixel
 * (polygon offset's slope term) plus 0.1% of its distance (depth quantization).
 */
export function commandOverlay<M extends NodeMaterial>(m: M): M {
  overlay(m);
  const z = positionView.z.negate();
  const scene = perspectiveDepthToViewZ(SCENE_DEPTH.sample(screenUV).r, cameraNear, cameraFar).negate();
  m.maskNode = z.lessThanEqual(scene.add(fwidth(z)).add(z.mul(0.001)));
  return m;
}

/** The Sky storm pass's fused cloud (`StormClouds` binds it: g coverage, a linear view depth, clear (0, 1)) and whether
 * it rendered this frame (1) or holds a stale storm (0). */
export const STORM_CLOUD = texture(new DataTexture(new Uint16Array(4), 1, 1, RGBAFormat, HalfFloatType));
export const STORM_LIVE = uniform(0);

/**
 * Public effects that rise above or through the Sky's storms (Spire connectors, ascent columns and rings, return arcs,
 * relay cones, falling-rock trails): drawn like command overlays after the storms, so a storm can no longer paint over
 * what floats in front of it, and hidden wherever the storm's own cloud lies in front, so they still pass behind and
 * into it as before. A storm faded on a ghosted Sky hides nothing.
 */
export function aboveStorm<M extends NodeMaterial>(m: M): M {
  commandOverlay(m);
  const scene = m.maskNode as Node<'bool'>;
  const cloud = STORM_CLOUD.sample(screenUV);
  // Bilinear coverage mixes the cloud texel with the clear (0, 1): depth = (a − (1 − cover)) / cover.
  const depth = cloud.a.sub(float(1).sub(cloud.g)).div(cloud.g.max(1e-4));
  const behind = cloud.g.mul(STORM_LIVE).mul(FADE.sky.alpha).greaterThan(0.3).and(depth.lessThan(positionView.z.negate()));
  m.maskNode = scene.and(behind.not());
  return m;
}

export interface InkOpts extends FinishOpts {
  /** Baked sun visibility (terrain), 1 elsewhere. */
  sun?: F1;
  /** Cavity occlusion (terrain), 1 elsewhere. */
  ao?: F1;
  /** Terminator softness (clouds). */
  soft?: number;
  /** Extra opacity on top of the plane fade. */
  alpha?: F1 | number;
  /** Real alpha blending (water sheets) instead of the dithered fade; such materials draw no lines. */
  blend?: boolean;
  side?: boolean;
}

/**
 * Cel-shaded, inked material on `plane`. Opaque with a dithered (`alphaHash`) plane fade, so stacked planes never need
 * transparency sorting; `blend` makes a translucent sheet instead.
 */
export function inkMaterial(plane: Plane, base: V3, o: InkOpts = {}): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const lit = cel(base, SHADOW[plane], o.sun ?? 1, o.ao ?? 1, o.soft);
  m.colorNode = finish(lit, plane, { glow: o.glow, fog: o.fog, fogField: o.fogField, tone: o.tone ?? lit });
  const f = FADE[plane].alpha;
  m.opacityNode = o.alpha === undefined ? f : f.mul(o.alpha);
  if (o.blend) overlay(m);
  else {
    m.alphaHash = true;
    m.mrtNode = LINES[plane];
  }
  if (o.side) m.side = DoubleSide;
  return m;
}

/** Line weight MRT for custom plane materials (same as `inkMaterial`'s). */
export const planeLines = (plane: Plane): MRTNode => LINES[plane];

/** A world-owned per-tile R8 mask, linearly sampled in map coordinates. */
export class TileMask {
  readonly size: number;
  readonly data: Uint8Array;
  readonly tex: DataTexture;
  constructor(size: number) {
    this.size = size;
    this.data = new Uint8Array(size * size);
    this.tex = new DataTexture(this.data, size, size, RedFormat, UnsignedByteType);
    this.tex.magFilter = LinearFilter;
    this.tex.minFilter = LinearFilter;
    this.tex.needsUpdate = true;
  }
  sample(): F1 {
    return texture(this.tex, mapUV()).r as unknown as F1;
  }
}

/** Ink grid on demand (the grid is never drawn everywhere): near the cursor, stronger while placing an order. */
export const GRID = { cursor: uniform(new Vector2(-1e3, -1e3)), k: uniform(0), r: uniform(1.6) };

/** Grid line coverage at this fragment: around `GRID.cursor` (radius `GRID.r`), and over `marked` cells (telegraphs). */
export function gridInk(marked: F1): F1 {
  const p = positionWorld;
  const near = float(1).sub(smoothstep(GRID.r.mul(0.45), GRID.r, p.xz.sub(GRID.cursor).length())).mul(GRID.k);
  const cell = max(lines(p.x.add(0.5) as F1, 0.025), lines(p.z.add(0.5) as F1, 0.025));
  return cell.mul(max(near, smoothstep(0.2, 0.6, marked).mul(0.7))) as F1;
}

/**
 * Tileable value-noise fbm prepared in bounded startup rows (128², RGBA8; r = broad billows, g = fine grain).
 * Soft weather and washes sample it instead of evaluating procedural noise per fragment.
 */
function* bakeNoise(): Generator<void, void> {
  const size = 128;
  const data = NOISE.image.data as Uint8Array;
  const lattice = (cells: number, salt: number) => {
    const v = new Float32Array(cells * cells);
    for (let i = 0; i < v.length; i++) v[i] = hash2(i, salt);
    return (x: number, y: number): number => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const at = (a: number, b: number): number => v[(b % cells) * cells + (a % cells)]!;
      const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
      const bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
      return top + (bottom - top) * sy;
    };
  };
  const o4 = lattice(4, 1), o8 = lattice(8, 2), o16 = lattice(16, 3), o32 = lattice(32, 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, w = y / size, o = (y * size + x) * 4;
      data[o] = Math.round((o4(u * 4, w * 4) * 0.55 + o8(u * 8, w * 8) * 0.3 + o16(u * 16, w * 16) * 0.15) * 255);
      data[o + 1] = Math.round((o16(u * 16, w * 16) * 0.6 + o32(u * 32, w * 32) * 0.4) * 255);
      data[o + 3] = 255;
    }
    yield;
  }
  NOISE.needsUpdate = true;
}
const NOISE = new DataTexture(new Uint8Array(128 * 128 * 4), 128, 128, RGBAFormat, UnsignedByteType);
NOISE.wrapS = NOISE.wrapT = RepeatWrapping;
NOISE.magFilter = NOISE.minFilter = LinearFilter;
let preparedMaterials: Promise<void> | undefined;

export function prepareMaterials(): Promise<void> {
  return preparedMaterials ??= prepareStartup(bakeNoise());
}
/** The baked noise at world-xz coordinates `p` (1 unit = one texture repeat): r broad, g fine. */
export const noise = (p: Node<'vec2'>): Node<'vec4'> => texture(NOISE, p) as unknown as Node<'vec4'>;

/**
 * Paper sheet over unseen parts of an open plane (Sky/Orbit have no ground to sketch). Orbit: single hatching over
 * explored cells, a denser cross-hatched sheet over never-seen ones. Sky: a mottled cloud-sea wash instead, heavier
 * over never-seen sky (no lines: the Sky's only lines are the island drift rings).
 */
export function veil(plane: 'sky' | 'orbit', y: number, size: number, fogField?: FogField): Mesh {
  const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
  const fog = fogField ? fogField.fogAt(plane) : vec2(1, 1);
  const v = smoothstep(0.3, 0.7, fog.x);
  const known = smoothstep(0.3, 0.7, fog.y);
  const p = positionWorld;
  if (plane === 'sky') {
    // a faint static paper mottle only: drifting grey-blue masses are fog banks, never the veil
    const n = noise(p.xz.mul(0.028)).x.mul(0.65).add(noise(p.xz.mul(0.085)).y.mul(0.35));
    m.colorNode = mix(color(PAPER.sky), color('#c3ceda'), smoothstep(0.4, 0.8, n).mul(mix(float(0.3), float(0.15), known)));
  } else {
    const h = max(lines(p.x.add(p.z).mul(2.2) as F1, 0.1), lines(p.x.sub(p.z).mul(2.2) as F1, 0.08).mul(float(1).sub(known)));
    m.colorNode = mix(color(PAPER[plane]), color(PENCIL[plane]), h.mul(0.35));
  }
  m.opacityNode = float(1).sub(v).mul(mix(float(0.75), float(0.5), known)).mul(FADE[plane].focus).mul(FADE[plane].alpha);
  const mesh = new Mesh(new PlaneGeometry(size, size).rotateX(-Math.PI / 2), m);
  mesh.position.y = y;
  mesh.renderOrder = 5;
  return mesh;
}
