/**
 * Direction C — "Signal": the commander's sensor table. Every plane is a dark slate read through instruments:
 * terrain as height-coded contour lines with a faint tactical grid, walls as bright scanned edges, forests as
 * stipple, water as flow lines; units as solid silhouettes with team-colour rims, ground glyphs and altitude stalks
 * (Homeworld). Each plane owns a hue (the game's plane accents). Fog of war is *loss of signal*: contours drop to
 * dim dashes under static, bounded by a bright sensor-horizon line. Unlit, additive, bloom + scanlines.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  RenderPipeline,
} from 'three/webgpu';
import {
  attribute,
  color,
  dot,
  float,
  max,
  mix,
  mrt,
  mx_noise_float,
  normalView,
  normalWorld,
  output,
  pass,
  positionLocal,
  positionWorld,
  screenCoordinate,
  screenUV,
  smoothstep,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { FOCUS, ARMY_COLOR, clock, maskAt, rgb, telegraphPattern, vis, type Ctx, type F1, type Look, type V3 } from '../kit.ts';
import { DEPTHS_MAP, SURFACE_MAP, THREAT_HEX, ARMY_HEX, cellMask, merge, wx, wz, type Plane, type ArmyColour, type Unit } from '../world.ts';
import { SUN, edges, lines } from './shared.ts';

/** Plane hues (apps/web PLANE_ACCENT, depths shifted to copper so it stays apart from the threat amber). */
const HUE: Record<Plane, string> = { depths: '#e0905a', surface: '#8fe36d', sky: '#7fd6ff', orbit: '#c79bff' };
const SLATE: Record<Plane, string> = { depths: '#0d0806', surface: '#04100b', sky: '#03101a', orbit: '#07051a' };

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

/**
 * Loss of signal: unseen → base dims, lines become dashed and faint, static crawls; a bright sensor-horizon line
 * traces the vision boundary. `ink` is the line layer (bright), `base` the fill (dark).
 */
function sense(base: V3, ink: V3, plane: Plane, fog = true): V3 {
  const v = fog ? vis(plane, 0.012) : float(1);
  const p = positionWorld;
  const dash = smoothstep(0.35, 0.45, p.x.add(p.z).mul(3).fract());
  const stat = mx_noise_float(vec3(p.x.mul(14), p.z.mul(14), clock.mul(6))).mul(0.5).add(0.5);
  const l = dot(ink, vec3(0.33));
  const lost = base.mul(0.45).add(color('#5a6a7c').mul(l.mul(dash).mul(0.35))).add(color('#7a8a9c').mul(stat.mul(0.03)));
  const shown = mix(lost, base.add(ink), smoothstep(0.4, 0.6, v));
  const horizon = float(1).sub(smoothstep(0.0, 0.07, v.sub(0.5).abs())).mul(fog ? 1 : 0);
  const withH = shown.add(color(HUE[plane]).mul(horizon.mul(0.9)));
  // ghosted plane: just the line layer, faint, in the plane's hue
  const ghost = rgb(SLATE[plane]).add(rgb(HUE[plane]).mul(dot(ink, vec3(0.33)).mul(0.35)));
  return mix(ghost, withH, FOCUS[plane]) as V3;
}

const wall = (): F1 => smoothstep(0.3, 0.55, float(1).sub(normalWorld.y)) as F1;
/** Height contours offset to miss the flat levels (0, 0.8, 1.25) so open ground stays clean; every 2nd brighter. */
const contours = (h: F1): F1 => max(lines(h.sub(0.2).div(0.4).add(0.5) as F1, 0.05).mul(0.45), lines(h.sub(0.2).div(0.8).add(0.5) as F1, 0.06)) as F1;
/** Tactical grid on tile borders (integer world coords). */
const grid = (): F1 => max(lines(positionWorld.x.add(0.5) as F1, 0.015), lines(positionWorld.z.add(0.5) as F1, 0.015)) as F1;

function terrain(plane: 'surface' | 'depths'): Material {
  const m = attribute<'vec4'>('m', 'vec4');
  const p = positionLocal;
  const hue = color(HUE[plane]);
  const ndl = dot(normalWorld, SUN).max(0);
  const wl = wall();
  const relief = rgb(SLATE[plane]).add(hue.mul(ndl.mul(0.05).add(0.015)));
  let lineK = contours(p.y as F1).mul(0.55).add(grid().mul(0.14).mul(float(1).sub(wl)));
  // scanned walls: bright rim + horizontal scan lines
  lineK = lineK.add(wl.mul(lines(p.y.mul(10) as F1, 0.12).mul(0.35).add(0.12)));
  let ink = hue.mul(lineK) as V3;
  if (plane === 'surface') {
    // forest stipple, ford flow lines, chasm void with a hot lip
    const cell = p.xz.mul(5).fract().sub(0.5).length();
    const dots = float(1).sub(smoothstep(0.16, 0.24, cell)).mul(smoothstep(0.3, 0.6, m.x));
    const flow = lines(p.x.mul(0.3).add(p.z).mul(5).add(mx_noise_float(p.mul(0.8)).mul(0.6)).sub(clock.mul(0.8)) as F1, 0.08).mul(smoothstep(0.5, 0.8, m.z));
    const deep = smoothstep(-0.4, -2.4, p.y);
    const lip = smoothstep(-0.2, -0.6, p.y).mul(float(1).sub(smoothstep(-0.6, -1.2, p.y)));
    ink = ink.mul(float(1).sub(deep.mul(0.8))).add(color('#5fe08a').mul(dots.mul(0.55))).add(color('#5ad2ff').mul(flow.mul(0.7))).add(color('#ff6a2a').mul(lip.mul(m.w).mul(1.2))) as V3;
    ink = ink.add(color('#ff6a2a').mul(smoothstep(-2.4, -3.1, p.y).mul(1.5))) as V3;
  } else {
    const top = smoothstep(1.0, 1.15, p.y).mul(float(1).sub(wl));
    const floor = float(1).sub(smoothstep(0.1, 0.3, p.y));
    const ore = smoothstep(0.3, 0.6, m.x);
    ink = ink.mul(float(1).sub(top.mul(0.45))).add(hue.mul(grid().mul(floor).mul(0.5))).add(color('#5fffe0').mul(ore.mul(top).mul(lines(p.x.sub(p.z).mul(4) as F1, 0.15)).mul(0.7))) as V3;
  }
  return mat(sense(relief as V3, ink, plane));
}

function glyphMat(plane: Plane, c: string, k = 1): Material {
  // fresnel-rimmed silhouette: dark body, bright rim
  const rim = float(1).sub(normalView.z.abs()).pow(1.5);
  return mat(sense(color(SLATE[plane]).mul(1.5) as V3, color(c).mul(rim.mul(0.9).add(0.12).mul(k)) as V3, plane));
}

function unit(plane: Plane, team: ArmyColour, ghost: boolean): Material {
  const accent = attribute<'float'>('accent', 'float');
  const glow = attribute<'float'>('glow', 'float');
  const t = ARMY_COLOR[team];
  const rim = float(1).sub(normalView.z.abs()).pow(1.4);
  if (ghost) {
    const dash = smoothstep(0.4, 0.5, positionWorld.y.mul(14).fract());
    return mat(t.mul(rim.mul(dash).mul(0.7)) as V3, { alpha: rim.mul(dash).mul(0.9) as F1, additive: true });
  }
  const body = rgb('#0a0f16').add(t.mul(accent.mul(0.35)));
  const c = body.add(t.mul(rim.mul(1.1))).add(t.mul(glow.mul(1.5)));
  return mat(sense(c as V3, vec3(0) as unknown as V3, plane, false));
}

function telegraph(plane: Plane, t: number): Material {
  const tp = telegraphPattern(t);
  const amber = color(THREAT_HEX);
  // rotating outer ticks, radial sweep lines inside the countdown pie
  const q = uv().sub(0.5).mul(2);
  const sweep = lines(q.length().mul(10).sub(clock.mul(2)) as F1, 0.12).mul(tp.pie);
  const k = max(max(tp.ring.mul(1.4), tp.ticks), max(tp.core, sweep.mul(0.6).add(tp.pie.mul(0.12))));
  const m = mat(amber.mul(k.mul(1.6)) as V3, { alpha: k.min(1).mul(FOCUS[plane].mul(0.7).add(0.3)) as F1, additive: true });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  return m;
}

export const signal: Look = {
  name: 'C · Signal (holo sensor table)',
  bg: {
    surface: ['#06140f', '#010403'],
    depths: ['#140b06', '#030100'],
    sky: ['#061624', '#010307'],
    orbit: ['#0e0820', '#020106'],
    stack: ['#0a0f14', '#010203'],
  },
  surfaceField: { res: 8, blur: 0.4, sharp: 0.16, rough: 0.3, skirt: -1.4 },
  depthsField: { res: 8, blur: 0.35, sharp: 0.2, rough: 0.2, skirt: -0.8 },
  terrain,
  water() {
    const w = maskAt(cellMask(SURFACE_MAP, 'W'));
    const edge = float(1).sub(smoothstep(0.28, 0.4, w));
    return mat(color('#5ad2ff').mul(edge.mul(0.6).add(0.06)) as V3, { alpha: smoothstep(0.24, 0.3, w).mul(vis('surface').mul(0.7).add(0.3)).mul(FOCUS.surface) as F1, additive: true });
  },
  magma() {
    const mm = maskAt(cellMask(DEPTHS_MAP, 'M'));
    const n = mx_noise_float(vec3(positionWorld.x.mul(2), clock.mul(0.5), positionWorld.z.mul(2))).mul(0.5).add(0.5);
    const c = mix(color('#ff4a1a'), color('#fff0b0'), smoothstep(0.55, 0.75, n)).mul(1.4);
    return mat(sense(c as V3, vec3(0) as unknown as V3, 'depths'), { alpha: smoothstep(0.28, 0.34, mm) as F1 });
  },
  tree(plane) {
    // forests are mostly the stipple in the terrain; sparse marker pins keep their height readable
    const geo = merge([{ geo: new ConeGeometry(0.12, 0.7, 4).translate(0, 0.35, 0), paint: '#ffffff' }]);
    return { geo, mat: glyphMat(plane, '#5fe08a', 0.9), perCell: 1, scale: 0.9 };
  },
  fault() {
    const across = uv().y.sub(0.5).abs().mul(2);
    const dash = smoothstep(0.3, 0.4, uv().x.mul(3).sub(clock.mul(1.2)).fract());
    const core = float(1).sub(smoothstep(0.15, 0.4, across));
    return mat(color('#ff7a3a').mul(core.mul(dash.mul(0.9).add(0.25))) as V3, { alpha: core.mul(FOCUS.surface.mul(0.7).add(0.3)) as F1, additive: true });
  },
  ore() {
    return { geo: merge([{ geo: new OctahedronGeometry(0.2, 0).scale(0.6, 1.6, 0.6), paint: '#ffffff' }]), mat: glyphMat('depths', '#5fffe0', 1.4) };
  },
  rail() {
    const glow = attribute<'float'>('glow', 'float');
    return mat(sense(color(HUE.depths).mul(glow.mul(4).add(0.15)) as V3, vec3(0) as unknown as V3, 'depths'));
  },
  island() {
    const top = attribute<'float'>('top', 'float');
    const p = positionLocal;
    const hue = color(HUE.sky);
    const rim = float(1).sub(normalView.z.abs()).pow(2);
    const slices = lines(p.y.mul(5) as F1, 0.08).mul(float(1).sub(top));
    const topGrid = max(lines(positionWorld.x.add(0.5) as F1, 0.03), lines(positionWorld.z.add(0.5) as F1, 0.03)).mul(top).mul(0.4);
    return mat(sense(color(SLATE.sky).mul(2) as V3, hue.mul(slices.mul(0.5).add(rim.mul(0.6)).add(topGrid)) as V3, 'sky'));
  },
  cloud(storm) {
    // volumetric "CT scan": thin horizontal slices through the puffs, fresnel-faded
    const rim = float(1).sub(normalView.z.abs()).pow(1.2);
    const slices = lines(positionWorld.y.mul(9) as F1, 0.1);
    const c = storm ? color('#d98cff') : color('#bfe8ff');
    const flash = storm ? mx_noise_float(vec3(clock.mul(3), 0, 0)).mul(0.5).add(0.5).pow(6).mul(2) : float(0);
    const k = slices.mul(0.35).add(rim.mul(0.35)).add(flash);
    return mat(c.mul(k).mul(vis('sky').mul(0.75).add(0.25)).mul(FOCUS.sky.mul(0.75).add(0.25)) as V3, { alpha: k.min(1) as F1, additive: true });
  },
  path() {
    const dash = smoothstep(0.4, 0.5, uv().x.mul(3).sub(clock.mul(0.6)).fract());
    return mat(color(HUE.sky).mul(dash.mul(0.9).add(0.1)) as V3, { alpha: FOCUS.sky.mul(0.7).add(0.3) as F1, additive: true, side: true });
  },
  sunWedge() {
    // radar-sweep daylight: soft fill brightening to a hard leading edge, range rings every 4 tiles
    const u = uv();
    const lead = smoothstep(0.0, 1.0, u.x).pow(2);
    const edge = smoothstep(0.97, 0.995, u.x).add(float(1).sub(smoothstep(0.005, 0.03, u.x)).mul(0.4));
    const rings = lines(u.y.mul(34 / 4) as F1, 0.04).mul(0.35);
    const k = lead.mul(0.1).add(edge.mul(0.8)).add(rings.mul(0.5)).mul(vis('orbit').mul(0.6).add(0.4)).mul(FOCUS.orbit.mul(0.7).add(0.3));
    return mat(color('#ffd98a').mul(k) as V3, { alpha: float(1) as F1, additive: true, side: true });
  },
  asteroid() {
    const rim = float(1).sub(normalView.z.abs()).pow(1.6);
    const slices = lines(positionLocal.y.mul(7) as F1, 0.08);
    return mat(sense(color('#0c0a14') as unknown as V3, color('#e8e0ff').mul(rim.mul(0.8).add(slices.mul(0.35))) as V3, 'orbit'));
  },
  veil(plane) {
    const v = vis(plane, 0.012);
    const stat = mx_noise_float(vec3(positionWorld.x.mul(10), positionWorld.z.mul(10), clock.mul(5))).mul(0.5).add(0.5);
    const horizon = float(1).sub(smoothstep(0.0, 0.07, v.sub(0.5).abs()));
    const c = mix(color('#000000'), color(HUE[plane]).mul(0.25), stat.mul(0.3)).add(color(HUE[plane]).mul(horizon));
    return mat(c as V3, { alpha: max(float(1).sub(v).mul(0.75), horizon.mul(0.8)).mul(FOCUS[plane]) as F1 });
  },
  unit,
  telegraph,
  unitExtra(u: Unit, plane: Plane, y: number) {
    // ground glyph (ring + heading tick) in team colour; flyers and orbit units get an altitude stalk
    const t = u.ghost ? '#ff4f5e' : ARMY_HEX[u.team];
    const q = uv().sub(0.5).mul(2);
    const r = q.length();
    const ring = lines(r.mul(3.2) as F1, 0.07);
    const dir = float(1).sub(smoothstep(0.05, 0.1, q.y.abs())).mul(smoothstep(0.6, 0.7, q.x)).mul(float(1).sub(smoothstep(0.95, 1, q.x)));
    const k = max(ring.mul(float(1).sub(smoothstep(0.9, 1, r))), dir);
    const gm = mat(color(t).mul(k.mul(1.2)) as V3, { alpha: k.mul(u.ghost ? 0.4 : 0.9) as F1, additive: true });
    const big = u.kind === 'spire' ? 1.4 : u.kind === 'tank' || u.kind === 'turret' || u.kind === 'bomber' || u.kind === 'relay' ? 0.6 : 0.4;
    const floorY = plane === 'sky' ? 0.42 : plane === 'orbit' ? -0.25 : y + 0.03;
    const glyph = new Mesh(new PlaneGeometry(big * 2, big * 2).rotateX(-Math.PI / 2).rotateY(-u.rot), gm);
    glyph.position.set(wx(u.x - 0.5), floorY, wz(u.y - 0.5));
    glyph.renderOrder = 7;
    const air = (plane === 'sky' && u.kind !== 'relay') || plane === 'orbit';
    if (air) {
      const top = plane === 'sky' ? 0.9 : 0;
      const stalk = new Mesh(
        new CylinderGeometry(0.012, 0.012, top - floorY, 4).translate(0, (top - floorY) / 2, 0),
        mat(color(t).mul(0.8) as V3, { alpha: float(0.7) as F1, additive: true }),
      );
      glyph.add(stalk);
    }
    return glyph;
  },
  dress(ctx: Ctx) {
    // pinpoint stars under the orbit plane
    const g = new BufferGeometry().copy(new OctahedronGeometry(0.03, 0));
    const sm = mat(rgb('#d8d0ff'));
    for (let i = 0; i < 110; i++) {
      const s = new Mesh(g, sm);
      s.position.set(Math.sin(i * 12.9898) * 13, -1.5 - (i % 7) * 0.4, Math.cos(i * 78.233) * 13);
      ctx.roots.orbit.add(s);
    }
  },
  post(ctx: Ctx) {
    const scenePass = pass(ctx.scene, ctx.camera);
    scenePass.setMRT(mrt({ output, normal: normalView }));
    const col = scenePass.getTextureNode('output');
    const plane: Plane = ctx.view === 'stack' ? 'surface' : ctx.view;
    // vector-display silhouettes in the plane hue
    const e = edges(scenePass, ctx.camera, 1, 0, 0.5, 0.9);
    let out = col.rgb.add(color(HUE[plane]).mul(e.mul(0.45))) as V3;
    out = out.add(bloom(col, 0.9, 0.45, 0.25).rgb) as V3;
    const scan = screenCoordinate.y.mul(0.5).fract().step(0.5).mul(0.08).oneMinus();
    const grain = mx_noise_float(vec3(screenUV.mul(vec2(800, 450)), clock.mul(20))).mul(0.025);
    const vig = float(1).sub(screenUV.sub(0.5).length().mul(0.55).pow(2));
    out = out.mul(scan).add(grain).mul(vig) as V3;
    const pipe = new RenderPipeline(ctx.renderer);
    pipe.outputNode = out;
    return pipe;
  },
};
