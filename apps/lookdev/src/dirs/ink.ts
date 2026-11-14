/**
 * Direction A — "Field Journal": an ink-and-watercolour cel diorama. Two-tone cel ramp with hue-shifted shadows,
 * screen-space ink lines (depth Laplacian + normals), a paper ground per plane, and fog of war as the *unpainted
 * pencil underdrawing*: what you can't see is still drawn (shapes stay readable) but has no colour.
 * Ghosted planes become blue construction-pencil sketches. Threats are amber stamps with an ink border.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  OctahedronGeometry,
  RenderPipeline,
} from 'three/webgpu';
import {
  attribute,
  color,
  float,
  max,
  mix,
  mrt,
  mx_noise_float,
  mx_worley_noise_float,
  normalView,
  normalWorld,
  output,
  pass,
  positionLocal,
  positionWorld,
  screenUV,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { FOCUS, ARMY_COLOR, clock, disc, maskAt, rgb, telegraphPattern, vis, type Ctx, type F1, type Look, type V3 } from '../kit.ts';
import { DEPTHS_MAP, SURFACE_MAP, THREAT_HEX, cellMask, merge, wx, wz, type Plane, type ArmyColour, type Unit } from '../world.ts';
import { cel, edges, hatch, lines, lum } from './shared.ts';

const PAPER: Record<Plane, string> = { surface: '#efe6d0', depths: '#2b241f', sky: '#e4ecef', orbit: '#1e2245' };
const INK: Record<Plane, string> = { surface: '#2b2019', depths: '#0c0806', sky: '#22304a', orbit: '#07081a' };
const SHADOW: Record<Plane, string> = { surface: '#8a86b8', depths: '#6a5a8a', sky: '#9fb0d6', orbit: '#6a5c9e' };
/** Pencil used for the unpainted (fogged) drawing. */
const PENCIL: Record<Plane, string> = { surface: '#5a5048', depths: '#cbb9a3', sky: '#5d6878', orbit: '#b9bfe6' };

function mat(c: V3, opts: { alpha?: F1; additive?: boolean; side?: boolean } = {}): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.colorNode = c;
  if (opts.side) m.side = DoubleSide;
  if (opts.alpha) {
    m.transparent = true;
    m.depthWrite = false;
    m.opacityNode = opts.alpha;
  }
  if (opts.additive) m.blending = AdditiveBlending;
  return m;
}

/** Paper and pencil of the *viewed* plane: ghosted planes are sketched onto the page you are looking at. */
const VIEW_PAPER = uniform(new Color(PAPER.surface));
const VIEW_PENCIL = uniform(new Color('#6f8fbf'));
const GHOST_PENCIL: Record<Plane, string> = { surface: '#6f8fbf', depths: '#8a7a9a', sky: '#6f8fbf', orbit: '#7f8fd0' };

/**
 * Fogged → the unpainted pencil drawing: three graphite values (posterized tone) with hatching only in the darkest,
 * so shapes stay readable without colour. A watercolour edge-darkening rim marks where the wash (vision) stops.
 * Ghosted plane → faint construction pencil on the viewed plane's paper.
 */
function finish(col: V3, plane: Plane, glow: V3 | undefined = undefined, fog = true, toneOf: V3 = col): V3 {
  const tone = lum(toneOf).div(0.75).clamp(0, 1) as F1;
  const dark = plane === 'depths' || plane === 'orbit';
  const band = smoothstep(0.3, 0.5, tone).add(smoothstep(0.6, 0.8, tone)).mul(0.5);
  const deepHatch = hatch(float(0.6) as F1, 4.5).mul(float(1).sub(smoothstep(0.3, 0.42, tone)));
  // light paper: graphite darkens shadows; dark paper: chalk picks out the lit faces
  const graphite = dark ? band.mul(0.3).add(deepHatch.mul(0.12)).add(0.05) : float(1).sub(band).mul(0.28).add(deepHatch.mul(0.3)).add(0.04);
  const sketch = mix(color(PAPER[plane]).mul(dark ? 1.15 : 1), color(PENCIL[plane]), graphite);
  const v = fog ? vis(plane) : float(1);
  const rim = smoothstep(0.35, 0.55, v).mul(float(1).sub(smoothstep(0.55, 0.9, v)));
  let painted = col.mul(float(1).sub(rim.mul(0.28))) as V3;
  if (glow) painted = painted.add(glow) as V3;
  const shown = mix(sketch, painted, smoothstep(0.45, 0.55, v)) as V3;
  const ghost = mix(VIEW_PAPER, VIEW_PENCIL, float(1).sub(band).mul(0.2).add(0.07));
  return mix(ghost, shown, FOCUS[plane]) as V3;
}

const wall = (): F1 => smoothstep(0.32, 0.55, float(1).sub(normalWorld.y)) as F1;

function surfaceTerrain(): Material {
  const m = attribute<'vec4'>('m', 'vec4');
  const sun = attribute<'float'>('sun', 'float');
  const ao = attribute<'float'>('ao', 'float');
  const p = positionLocal;
  const n = mx_noise_float(p.mul(0.32));
  const n2 = mx_noise_float(p.mul(1.9)).mul(0.5).add(0.5);
  // painted patches: crisp steps in low-frequency noise rather than smooth blends
  const grass = mix(color('#9ab86a'), color('#b5c178'), smoothstep(0.1, 0.16, n));
  const meadow = mix(grass, color('#cdb77c'), smoothstep(0.42, 0.48, n).mul(0.85));
  const floor = mix(meadow, color('#6e8f4f'), smoothstep(0.3, 0.6, m.x));
  const plateau = mix(color('#dcc791'), color('#e7d6a4'), n2);
  const top = mix(floor, plateau, smoothstep(0.45, 0.6, p.y));
  const bank = mix(top, color('#dbc9a0'), smoothstep(0.05, 0.3, m.z));
  const bed = mix(bank, color('#7e9c95'), smoothstep(0.55, 0.8, m.z));
  const strata = smoothstep(0.45, 0.55, p.y.mul(3.2).add(n2.mul(0.6)).fract());
  const rock = mix(color('#a9978a'), color('#8b7a6e'), strata);
  const crag = mix(color('#beb29c'), color('#a59a86'), n2);
  const deep = smoothstep(-0.4, -2.6, p.y);
  const chasmWall = mix(rock, color('#4a3340'), deep);
  let base = mix(mix(bed, crag, smoothstep(0.4, 0.7, m.y)), m.w.greaterThan(0.05).select(chasmWall, rock), wall()) as V3;
  base = mix(base, chasmWall, deep) as V3;
  const lit = cel(base, SHADOW.surface, sun, ao);
  const shadowInk = hatch(lum(lit).div(0.6).clamp(0, 1) as F1, 9).mul(0.22).mul(float(1).sub(smoothstep(0.3, 0.55, sun)));
  const inked = mix(lit, color(INK.surface), shadowInk) as V3;
  const glow = color('#ff8a3a').mul(smoothstep(-2.2, -3.1, p.y).mul(2.2)) as V3;
  return mat(finish(inked, 'surface', glow, true, lit));
}

function depthsTerrain(): Material {
  const m = attribute<'vec4'>('m', 'vec4');
  const sun = attribute<'float'>('sun', 'float');
  const ao = attribute<'float'>('ao', 'float');
  const p = positionLocal;
  const n2 = mx_noise_float(p.mul(1.7)).mul(0.5).add(0.5);
  // the cut plane of the rock is drawn like a section in an engineering drawing: flat fill + diagonal section lines
  const cut = smoothstep(1.0, 1.15, p.y).mul(float(1).sub(wall()));
  const section = lines(p.x.add(p.z).mul(2.2) as F1, 0.1).mul(0.35);
  const bedrock = smoothstep(0.4, 0.7, m.w);
  const cutCol = mix(mix(color('#5a4a52'), color('#3a3036'), bedrock), color('#1c1416'), section);
  const strata = smoothstep(0.45, 0.55, p.y.mul(3.5).add(n2.mul(0.7)).fract());
  const wallCol = mix(color('#9a7f68'), color('#7d6655'), strata);
  const floor = mix(color('#c7a77a'), color('#d8bb8c'), n2);
  const ore = smoothstep(0.3, 0.6, m.x);
  const veins = smoothstep(0.82, 0.9, mx_worley_noise_float(p.mul(2.3)).oneMinus());
  let base = mix(floor, wallCol, wall()) as V3;
  base = mix(base, color('#5fc9b8'), ore.mul(veins).mul(wall().add(cut).min(1))) as V3;
  const lit = cel(base, SHADOW.depths, max(sun, 0.6) as F1, ao);
  const shaded = mix(lit, cutCol.mul(mix(float(1), float(1.25), ore)), cut) as V3;
  const glow = color('#ff7a2a').mul(smoothstep(0.35, 0.7, m.y).mul(float(1).sub(cut)).mul(0.6)) as V3;
  return mat(finish(shaded, 'depths', glow, true, mix(lit, color('#4a3e46'), cut) as V3));
}

function paintMat(plane: Plane, glowK = 1): Material {
  const paint = attribute<'vec3'>('paint', 'vec3');
  const glow = attribute<'float'>('glow', 'float');
  return mat(finish(cel(paint as V3, SHADOW[plane]), plane, paint.mul(glow.mul(glowK)) as V3));
}

function unit(plane: Plane, team: ArmyColour, ghost: boolean): Material {
  const paint = attribute<'vec3'>('paint', 'vec3');
  const accent = attribute<'float'>('accent', 'float');
  const glow = attribute<'float'>('glow', 'float');
  const base = mix(paint, ARMY_COLOR[team], accent) as V3;
  if (ghost) {
    // remembered structure: red-pencil sketch, no paint
    const tone = lum(cel(base, SHADOW[plane]));
    return mat(mix(color(PAPER[plane]), color('#c0505a'), float(0.35).add(hatch(tone as F1, 10).mul(0.5))) as V3);
  }
  const c = cel(base, SHADOW[plane]);
  return mat(finish(c, plane, base.mul(glow.mul(1.6)) as V3, false));
}

function telegraph(plane: Plane, t: number): Material {
  const tp = telegraphPattern(t);
  const amber = color(THREAT_HEX);
  const ink = color(INK[plane === 'depths' ? 'surface' : plane]);
  const pieHatch = lines(positionWorld.x.add(positionWorld.z).mul(6) as F1, 0.22);
  const fill = tp.pie.mul(pieHatch.mul(0.5).add(0.25));
  const border = tp.ring;
  const c = mix(mix(amber, ink, tp.ticks.add(tp.core).min(1)), amber.mul(1.15), border);
  const a = max(max(border, tp.ticks), max(fill, tp.core)).mul(FOCUS[plane].mul(0.6).add(0.4));
  // ink rim around the amber ring
  const rimR = smoothstep(0.77, 0.79, tp.r).mul(float(1).sub(smoothstep(0.79, 0.8, tp.r))).add(
    smoothstep(0.88, 0.89, tp.r).mul(float(1).sub(smoothstep(0.89, 0.91, tp.r))),
  );
  const m = mat(mix(c, ink, rimR) as V3, { alpha: max(a, rimR) as F1 });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  return m;
}

export const ink: Look = {
  name: 'A · Field Journal (ink & watercolour cel)',
  bg: {
    surface: ['#f3ead6', '#e2d6bb'],
    depths: ['#2f2722', '#1b1512'],
    sky: ['#eef4f6', '#d6e2e8'],
    orbit: ['#262a55', '#10122a'],
    stack: ['#f1e8d3', '#d9ccb0'],
  },
  surfaceField: { res: 8, blur: 0.42, sharp: 0.16, rough: 0.35, skirt: -1.6 },
  depthsField: { res: 8, blur: 0.35, sharp: 0.2, rough: 0.25, skirt: -0.8 },
  terrain: (plane) => (plane === 'surface' ? surfaceTerrain() : depthsTerrain()),
  water() {
    const w = maskAt(cellMask(SURFACE_MAP, 'W'));
    const p = positionWorld;
    const flow = mx_noise_float(vec3(p.x.mul(1.2).add(clock.mul(0.6)), 0, p.z.mul(2.4)));
    const streak = smoothstep(0.35, 0.42, flow).mul(float(1).sub(smoothstep(0.42, 0.5, flow)));
    const foam = float(1).sub(smoothstep(0.32, 0.5, w));
    const c = mix(mix(color('#7fb2c2'), color('#9ccad3'), streak), color('#f6f1e2'), foam.max(streak.mul(0.6)));
    return mat(finish(c as V3, 'surface'), { alpha: smoothstep(0.24, 0.3, w).mul(0.85) as F1 });
  },
  magma() {
    const mm = maskAt(cellMask(DEPTHS_MAP, 'M'));
    const p = positionWorld;
    const n = mx_noise_float(vec3(p.x.mul(1.5), clock.mul(0.4), p.z.mul(1.5))).mul(0.5).add(0.5);
    const c = mix(color('#ff5a1a'), color('#ffd27a'), smoothstep(0.55, 0.7, n)).mul(2.2);
    return mat(finish(c as V3, 'depths'), { alpha: smoothstep(0.28, 0.34, mm) as F1 });
  },
  tree(plane) {
    const parts = [
      { geo: new ConeGeometry(0.34, 0.62, 7).translate(0, 0.52, 0), paint: '#5c8a4a' },
      { geo: new ConeGeometry(0.26, 0.5, 7).translate(0, 0.86, 0), paint: '#6f9c52' },
      { geo: new ConeGeometry(0.06, 0.3, 5).translate(0, 0.15, 0), paint: '#6b4a32' },
    ];
    return { geo: merge(parts), mat: paintMat(plane), perCell: 3, scale: 0.95 };
  },
  fault() {
    const across = uv().y.sub(0.5).abs().mul(2);
    const along = uv().x;
    const jag = mx_noise_float(vec3(along.mul(6), 0, 0)).mul(0.35);
    const core = float(1).sub(smoothstep(0.1, 0.3, across.add(jag)));
    const pulse = smoothstep(0.6, 1, along.mul(0.8).sub(clock.mul(1.5)).sin().mul(0.5).add(0.5));
    const c = mix(color(INK.surface), color('#ff8a3a').mul(1.6), core.mul(pulse.mul(0.7).add(0.2)));
    return mat(c as V3, { alpha: max(core, float(1).sub(smoothstep(0.4, 0.9, across.add(jag))).mul(0.5)).mul(FOCUS.surface.mul(0.6).add(0.4)) as F1 });
  },
  ore() {
    return {
      geo: merge([{ geo: new OctahedronGeometry(0.22, 0).scale(0.6, 1.6, 0.6), paint: '#7fe8d6', glow: 0.5 }]),
      mat: paintMat('depths', 1.4),
    };
  },
  rail: () => paintMat('depths'),
  island() {
    const top = attribute<'float'>('top', 'float');
    const p = positionLocal;
    const n2 = mx_noise_float(p.mul(2.2)).mul(0.5).add(0.5);
    const grassy = top.mul(smoothstep(0.2, 0.5, normalWorld.y));
    const strata = smoothstep(0.45, 0.55, p.y.mul(2.4).add(n2.mul(0.8)).fract());
    const rock = mix(mix(color('#b39c84'), color('#957f6c'), strata), color('#7d6f8a'), smoothstep(-0.5, -3.5, p.y));
    const c = mix(rock, mix(color('#a6c477'), color('#bccb83'), n2), grassy);
    return mat(finish(cel(c as V3, SHADOW.sky), 'sky'));
  },
  cloud(storm) {
    const lit = storm ? '#8a8fab' : '#ffffff';
    const c = cel(rgb(lit), storm ? '#6a6f92' : '#c3cde3', 1, 1, 0.35);
    return mat(finish(c, 'sky'));
  },
  path() {
    const dash = smoothstep(0.45, 0.5, uv().x.mul(2.2).sub(clock.mul(0.3)).fract());
    return mat(rgb('#3d5a80'), { alpha: dash.mul(0.7).mul(FOCUS.sky.mul(0.7).add(0.3)) as F1, side: true });
  },
  sunWedge() {
    // a gold-leaf wash: additive on the indigo page, dashed ink-gold edges
    const u = uv();
    const across = u.x.sub(0.5).abs().mul(2);
    const wash = float(1).sub(smoothstep(0.6, 1, across)).mul(0.22);
    const edge = smoothstep(0.9, 0.95, across).mul(float(1).sub(smoothstep(0.97, 1, across)));
    const dash = smoothstep(0.45, 0.5, u.y.mul(70).fract());
    const k = max(wash, edge.mul(dash).mul(0.9)).mul(vis('orbit').mul(0.5).add(0.5)).mul(FOCUS.orbit.mul(0.7).add(0.3));
    return mat(color('#f6e7bf').mul(k.mul(1.6)) as V3, { alpha: float(1) as F1, additive: true, side: true });
  },
  asteroid() {
    const p = positionLocal;
    const crater = smoothstep(0.08, 0.02, mx_worley_noise_float(p.mul(2.2)));
    const c = mix(color('#b3a395'), color('#6f6058'), crater.mul(0.7));
    return mat(finish(cel(c as V3, SHADOW.orbit), 'orbit'));
  },
  veil(plane) {
    const v = vis(plane);
    const p = positionWorld;
    const h = lines(p.x.add(p.z).mul(2.2) as F1, 0.1);
    const c = mix(color(PAPER[plane]), color(PENCIL[plane]), h.mul(0.35));
    return mat(c as V3, { alpha: float(1).sub(v).mul(0.6).mul(FOCUS[plane]) as F1 });
  },
  unit,
  telegraph,
  unitExtra(u: Unit, plane: Plane, y: number) {
    // a team-coloured watercolour dab under every unit: ownership reads even when the model is tiny
    if (u.ghost) return undefined;
    const r = uv().sub(0.5).length().mul(2);
    const edge = mx_noise_float(vec3(uv().mul(5), u.x)).mul(0.25);
    const a = float(1).sub(smoothstep(0.55, 0.95, r.add(edge))).mul(0.5);
    const rim = smoothstep(0.5, 0.8, r.add(edge)).mul(a).mul(0.6);
    const m = mat(ARMY_COLOR[u.team].mul(float(1).sub(rim)) as V3, { alpha: a.add(rim) as F1 });
    const big = u.kind === 'spire' ? 1.3 : u.kind === 'tank' || u.kind === 'turret' || u.kind === 'bomber' ? 0.62 : 0.42;
    const air = plane === 'sky' && u.kind !== 'relay';
    const d = disc(big, m, wx(u.x - 0.5), air ? 0.42 : plane === 'orbit' ? -0.22 : y + 0.025, wz(u.y - 0.5));
    d.renderOrder = 6;
    return d;
  },
  dress(ctx: Ctx) {
    const view: Plane = ctx.view === 'stack' ? 'surface' : ctx.view;
    VIEW_PAPER.value.set(PAPER[view]);
    VIEW_PENCIL.value.set(GHOST_PENCIL[view]);
    // stars on the orbit's indigo paper
    const starMat = mat(rgb('#f3eedc'));
    const g = new CircleGeometry(0.04, 5).rotateX(-Math.PI / 2);
    for (let i = 0; i < 90; i++) {
      const s = new Mesh(g, starMat);
      s.position.set(Math.sin(i * 12.9898) * 13, -1.2 - (i % 5) * 0.3, Math.cos(i * 78.233) * 13);
      s.scale.setScalar(0.6 + (i % 3) * 0.5);
      ctx.roots.orbit.add(s);
    }
  },
  post(ctx: Ctx) {
    const scenePass = pass(ctx.scene, ctx.camera);
    scenePass.setMRT(mrt({ output, normal: normalView }));
    const col = scenePass.getTextureNode('output');
    const plane: Plane = ctx.view === 'stack' ? 'surface' : ctx.view;
    const e = edges(scenePass, ctx.camera, 1.25, 0.35);
    const inkCol = color(INK[plane]);
    const dark = plane === 'depths' || plane === 'orbit';
    const lineCol = dark ? color('#e9dcc4') : inkCol;
    let out = mix(col.rgb, lineCol, e.mul(dark ? 0.55 : 0.88)) as V3;
    // paper grain + fibres, gentle vignette
    const g = mx_noise_float(vec3(screenUV.mul(vec2(520, 300)), 0)).mul(0.035);
    const fib = mx_noise_float(vec3(screenUV.mul(vec2(60, 900)), 3)).mul(0.02);
    const vig = float(1).sub(screenUV.sub(0.5).length().mul(0.35));
    out = out.mul(float(1).add(g).add(fib)).mul(vig) as V3;
    const pipe = new RenderPipeline(ctx.renderer);
    pipe.outputNode = out.add(bloom(col, 0.45, 0.3, 1.0).rgb);
    return pipe;
  },
};
