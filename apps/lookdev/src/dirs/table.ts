/**
 * Direction B — "War Table": a lamp-lit tabletop of four stacked boards (3-D chess): carved, painted terrain with
 * chamfered terraces and flocked felt, glossy painted miniatures on team-coloured bases, frosted-acrylic Sky and
 * Orbit boards on brass posts, cotton-wool clouds, brass orrery rails for drift paths. Fog of war is *lamplight*:
 * what you see sits in a warm pool of light, the rest of the board falls into cool shadow. Real shadows, soft PBR,
 * tilt-shift post.
 */
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  IcosahedronGeometry,
  type Material,
  Mesh,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  OctahedronGeometry,
  PCFShadowMap,
  PMREMGenerator,
  PointLight,
  RenderPipeline,
  AdditiveBlending,
} from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  attribute,
  color,
  float,
  max,
  mix,
  mx_noise_float,
  mx_worley_noise_float,
  normalWorld,
  pass,
  positionLocal,
  positionWorld,
  screenUV,
  smoothstep,
  uv,
  vec3,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { FOCUS, ARMY_COLOR, clock, maskAt, rgb, telegraphPattern, vis, type Ctx, type F1, type Look, type V3 } from '../kit.ts';
import { DEPTHS_MAP, PLANE_Y, S, SUN_DIR, SURFACE_MAP, THREAT_HEX, cellMask, merge, wx, wz, type Plane, type ArmyColour, type Unit } from '../world.ts';
import { lum } from './shared.ts';

interface StdOpts {
  roughness?: number;
  metalness?: number;
  emissive?: V3;
  alpha?: F1;
  physical?: boolean;
  ao?: F1;
  side?: boolean;
}

/** Lamplight fog: unseen board falls into cool shadow; a warm rim marks the edge of the light pool. Ghost: dim. */
function lamp(c: V3, plane: Plane, fog = true): V3 {
  const v = fog ? vis(plane, 0.03) : float(1);
  const l = lum(c);
  const cold = mix(vec3(l, l, l), c, 0.45).mul(color('#7d88a8')).mul(0.62);
  const rim = smoothstep(0.3, 0.5, v).mul(float(1).sub(smoothstep(0.5, 0.8, v)));
  const warm = c.mul(mix(float(1), float(1.18), rim)).add(color('#ffb060').mul(rim.mul(0.05)));
  const shown = mix(cold, warm, smoothstep(0.35, 0.6, v));
  const ghost = mix(vec3(l, l, l).mul(0.35), color('#4a5878').mul(0.4), 0.4);
  return mix(ghost, shown, FOCUS[plane]) as V3;
}

function std(c: V3, o: StdOpts = {}): MeshStandardNodeMaterial {
  const m = o.physical ? new MeshPhysicalNodeMaterial({ roughness: o.roughness ?? 0.5, metalness: o.metalness ?? 0, clearcoat: 0.8, clearcoatRoughness: 0.25 }) : new MeshStandardNodeMaterial({ roughness: o.roughness ?? 0.9, metalness: o.metalness ?? 0 });
  m.colorNode = c;
  if (o.emissive) m.emissiveNode = o.emissive;
  if (o.ao) m.aoNode = o.ao;
  if (o.side) m.side = DoubleSide;
  if (o.alpha) {
    m.transparent = true;
    m.depthWrite = false;
    m.opacityNode = o.alpha;
  }
  return m;
}

const wall = (): F1 => smoothstep(0.3, 0.55, float(1).sub(normalWorld.y)) as F1;
/** The board's cut edge: the slice border, shown as varnished wood. */
const boardEdge = (): F1 => smoothstep(7.9, 7.99, max(positionLocal.x.abs(), positionLocal.z.abs())).mul(smoothstep(0.6, 0.9, float(1).sub(normalWorld.y.abs()))) as F1;
const wood = (): V3 => mix(color('#6e4426'), color('#94623a'), smoothstep(0.3, 0.7, mx_noise_float(positionLocal.mul(vec3(0.6, 14, 0.6))).mul(0.5).add(0.5))) as V3;
/** Flocked felt: high-frequency speckle like model-railway static grass. */
const flock = (a: string, b: string): V3 => mix(color(a), color(b), mx_noise_float(positionLocal.mul(9)).mul(0.5).add(0.5)) as V3;

function surfaceTerrain(): Material {
  const m = attribute<'vec4'>('m', 'vec4');
  const ao = attribute<'float'>('ao', 'float');
  const p = positionLocal;
  const n = mx_noise_float(p.mul(0.3)).mul(0.5).add(0.5);
  const grass = mix(flock('#5f9a3e', '#7cb24c'), flock('#8fae4a', '#a8b85a'), smoothstep(0.55, 0.7, n));
  const forest = flock('#3f7034', '#4e8a3c');
  const plateau = flock('#d8b874', '#e6cc8c');
  const sand = color('#e2cf9a');
  const bed = color('#4d7f8c');
  const stone = mix(color('#b6ada0'), color('#8f877c'), mx_noise_float(p.mul(2.5)).mul(0.5).add(0.5));
  let c = mix(grass, forest, smoothstep(0.3, 0.6, m.x)) as V3;
  c = mix(c, plateau, smoothstep(0.45, 0.6, p.y)) as V3;
  c = mix(c, sand, smoothstep(0.05, 0.3, m.z)) as V3;
  c = mix(c, bed, smoothstep(0.55, 0.85, m.z)) as V3;
  c = mix(c, stone, max(wall(), smoothstep(0.4, 0.7, m.y))) as V3;
  c = mix(c, color('#3a2a30'), smoothstep(-0.5, -2.6, p.y)) as V3;
  c = mix(c, wood(), boardEdge()) as V3;
  const glow = color('#ff7a2a').mul(smoothstep(-2.3, -3.1, p.y).mul(3)) as V3;
  return std(lamp(c, 'surface'), { roughness: 0.95, ao: smoothstep(0.3, 0.9, ao) as F1, emissive: glow.mul(FOCUS.surface) as V3 });
}

function depthsTerrain(): Material {
  const m = attribute<'vec4'>('m', 'vec4');
  const ao = attribute<'float'>('ao', 'float');
  const p = positionLocal;
  const top = smoothstep(1.0, 1.15, p.y).mul(float(1).sub(wall()));
  const slate = mix(color('#50535c'), color('#3c3e46'), smoothstep(0.4, 0.7, m.w));
  const stone = mix(color('#a39484'), color('#857668'), mx_noise_float(p.mul(2.2)).mul(0.5).add(0.5));
  const planks = mix(color('#a27445'), color('#7f5532'), smoothstep(0.45, 0.55, p.x.add(p.z).mul(3).fract()));
  const ore = smoothstep(0.3, 0.6, m.x);
  let c = mix(planks, stone, wall()) as V3;
  c = mix(c, slate, top) as V3;
  c = mix(c, color('#3fb7a6'), ore.mul(smoothstep(0.75, 0.85, mx_worley_noise_float(p.mul(2.5)).oneMinus()))) as V3;
  c = mix(c, wood(), boardEdge()) as V3;
  return std(lamp(c, 'depths'), { roughness: 0.85, ao: smoothstep(0.3, 0.9, ao) as F1 });
}

function paintMat(plane: Plane, rough = 0.8): Material {
  const paint = attribute<'vec3'>('paint', 'vec3');
  const glow = attribute<'float'>('glow', 'float');
  return std(lamp(paint as V3, plane), { roughness: rough, emissive: paint.mul(glow).mul(FOCUS[plane]) as V3 });
}

function unit(plane: Plane, team: ArmyColour, ghost: boolean): Material {
  const paint = attribute<'vec3'>('paint', 'vec3');
  const accent = attribute<'float'>('accent', 'float');
  const glow = attribute<'float'>('glow', 'float');
  // enamel paint: team colours pushed deeper so they survive ACES and the clearcoat sheen
  const enamel = { blue: color('#1670d8'), red: color('#d8202e') }[team];
  const base = mix(paint, enamel, accent) as V3;
  if (ghost) {
    // a remembered structure: an unpainted grey-primer mini left on the board
    return std(lamp(mix(vec3(lum(base), lum(base), lum(base)), ARMY_COLOR[team], 0.15) as V3, plane, false).mul(0.55) as V3, { roughness: 0.9, alpha: float(0.75) as F1 });
  }
  return std(lamp(base, plane, false), { physical: true, roughness: 0.45, emissive: base.mul(glow.mul(1.4)) as V3 });
}

function telegraph(plane: Plane, t: number): Material {
  // a translucent amber acrylic token with the countdown engraved
  const tp = telegraphPattern(t);
  const amber = color(THREAT_HEX);
  const disc = float(1).sub(smoothstep(0.9, 0.92, tp.r));
  const engraved = max(max(tp.ring, tp.ticks), tp.core);
  const c = mix(amber.mul(0.6), amber, engraved);
  const m = std(c as V3, { roughness: 0.15, emissive: amber.mul(tp.pie.mul(0.35).add(engraved.mul(0.9))) as V3, alpha: disc.mul(tp.pie.mul(0.35).add(0.3).add(engraved.mul(0.5))).mul(FOCUS[plane].mul(0.6).add(0.4)) as F1 });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  return m;
}

const BRASS = '#c9a24e';

export const table: Look = {
  name: 'B · War Table (lamp-lit tabletop miniatures)',
  bg: {
    surface: ['#3a2c24', '#1a1311'],
    depths: ['#241a16', '#0e0a09'],
    sky: ['#3a3430', '#1c1715'],
    orbit: ['#1a1620', '#08070b'],
    stack: ['#3a2c24', '#140e0c'],
  },
  surfaceField: { res: 4, blur: 0.32, sharp: 0.14, rough: 0.3, facet: true, terrace: 0.22, skirt: -1.4 },
  depthsField: { res: 4, blur: 0.26, sharp: 0.16, rough: 0.15, facet: true, terrace: 0.3, skirt: -0.9 },
  terrain: (plane) => (plane === 'surface' ? surfaceTerrain() : depthsTerrain()),
  water() {
    const w = maskAt(cellMask(SURFACE_MAP, 'W'));
    const p = positionWorld;
    const ripple = mx_noise_float(vec3(p.x.mul(2).add(clock.mul(0.5)), 0, p.z.mul(3))).mul(0.5).add(0.5);
    const foam = float(1).sub(smoothstep(0.3, 0.42, w));
    const c = mix(mix(color('#2f8aa6'), color('#4fb0c4'), ripple), color('#d6e4e2'), foam.mul(0.8));
    return std(lamp(c as V3, 'surface'), { roughness: 0.22, alpha: smoothstep(0.24, 0.3, w).mul(0.8) as F1 });
  },
  magma() {
    const mm = maskAt(cellMask(DEPTHS_MAP, 'M'));
    const n = mx_noise_float(vec3(positionWorld.x.mul(1.4), clock.mul(0.3), positionWorld.z.mul(1.4))).mul(0.5).add(0.5);
    const c = mix(color('#ff4a12'), color('#ffc060'), smoothstep(0.5, 0.7, n));
    return std(lamp(c as V3, 'depths'), { roughness: 0.1, emissive: c.mul(2.4).mul(vis('depths').mul(0.8).add(0.2)) as V3, alpha: smoothstep(0.28, 0.34, mm) as F1 });
  },
  tree(plane) {
    // model-railway "lollipop" trees: faceted canopy on a dowel
    const geo = merge([
      { geo: new IcosahedronGeometry(0.3, 1).scale(1, 1.15, 1).translate(0, 0.62, 0), paint: '#4f8f3c' },
      { geo: new IcosahedronGeometry(0.2, 1).translate(0.12, 0.86, 0.05), paint: '#63a447' },
      { geo: new CylinderGeometry(0.045, 0.06, 0.4, 6).translate(0, 0.2, 0), paint: '#6b4a2e' },
    ]);
    return { geo, mat: paintMat(plane), perCell: 2, scale: 1 };
  },
  fault() {
    const across = uv().y.sub(0.5).abs().mul(2);
    const core = float(1).sub(smoothstep(0.1, 0.35, across.add(mx_noise_float(vec3(uv().x.mul(5), 0, 0)).mul(0.3))));
    const pulse = uv().x.mul(0.8).sub(clock.mul(1.5)).sin().mul(0.5).add(0.5);
    return std(color('#2a1a12') as unknown as V3, { emissive: color('#ff7a2a').mul(core.mul(pulse.mul(1.5).add(0.6))) as V3, alpha: core.max(0.15).mul(float(1).sub(smoothstep(0.6, 1, across))) as F1 });
  },
  ore() {
    return { geo: merge([{ geo: new OctahedronGeometry(0.22, 0).scale(0.6, 1.6, 0.6), paint: '#5ee0cc', glow: 0.9 }]), mat: paintMat('depths', 0.2) };
  },
  rail: () => paintMat('depths', 0.4),
  island() {
    const top = attribute<'float'>('top', 'float');
    const p = positionLocal;
    const grassy = top.mul(smoothstep(0.2, 0.5, normalWorld.y));
    const cork = mix(color('#a8794a'), color('#c59a68'), mx_noise_float(p.mul(6)).mul(0.5).add(0.5));
    const c = mix(mix(cork, color('#7a5a40'), smoothstep(-0.5, -3, p.y)), flock('#6aa846', '#88bb55'), grassy);
    return std(lamp(c as V3, 'sky'), { roughness: 0.95 });
  },
  cloud(storm) {
    // cotton wool: matte, slightly self-lit so it reads soft
    const c = storm ? color('#7c7f8e') : color('#f7f4ee');
    const fuzz = mx_noise_float(positionWorld.mul(7)).mul(0.06);
    return std(lamp(c.sub(fuzz) as V3, 'sky'), { roughness: 1, emissive: c.mul(0.18).mul(FOCUS.sky) as V3 });
  },
  path: () => std(rgb(BRASS), { metalness: 1, roughness: 0.3, side: true }),
  sunWedge() {
    const u = uv();
    const across = u.x.sub(0.5).abs().mul(2);
    const k = float(1).sub(smoothstep(0.5, 1, across)).mul(0.09).mul(FOCUS.orbit.mul(0.7).add(0.3));
    const m = std(color('#000000') as unknown as V3, { emissive: color('#ffd890').mul(k) as V3, alpha: float(1) as F1, side: true });
    m.blending = AdditiveBlending;
    return m;
  },
  asteroid() {
    const p = positionLocal;
    const crater = smoothstep(0.1, 0.03, mx_worley_noise_float(p.mul(2.2)));
    const c = mix(color('#9a8a7c'), color('#5e5048'), crater.mul(0.7));
    return std(lamp(c as V3, 'orbit'), { roughness: 0.9 });
  },
  veil(plane) {
    // smoked glass over what you can't see on the acrylic boards
    return std(rgb('#0c0f18'), { roughness: 0.3, alpha: float(1).sub(vis(plane, 0.03)).mul(0.55).mul(FOCUS[plane]) as F1 });
  },
  unit,
  telegraph,
  unitExtra(u: Unit, plane: Plane, y: number) {
    // painted-miniature base in the team colour (+ clear acrylic flight stand for flyers)
    const big = u.kind === 'spire' ? 1.1 : u.kind === 'tank' || u.kind === 'turret' || u.kind === 'bomber' || u.kind === 'relay' ? 0.42 : 0.26;
    const air = (plane === 'sky' && u.kind !== 'relay') || plane === 'orbit';
    const by = plane === 'sky' && air ? 0.42 : plane === 'orbit' ? -0.38 : y;
    const g = merge([
      { geo: new CylinderGeometry(big, big * 1.08, 0.07, 24).translate(0, 0.035, 0), paint: '#ffffff', accent: 1 },
      { geo: new CylinderGeometry(big * 1.1, big * 1.12, 0.02, 24).translate(0, 0.01, 0), paint: '#1a1a1e' },
    ]);
    const baseMat = u.ghost ? std(rgb('#55565c'), { roughness: 0.9 }) : unit(plane, u.team, false);
    const base = new Mesh(g, baseMat);
    base.position.set(wx(u.x - 0.5), by, wz(u.y - 0.5));
    if (!air) return base;
    const top = plane === 'orbit' ? 0 : 0.9;
    const rod = new Mesh(new CylinderGeometry(0.018, 0.018, top - by, 6).translate(0, (top - by) / 2, 0), std(rgb('#dfefff'), { roughness: 0.1, alpha: float(0.35) as F1 }));
    base.add(rod);
    return base;
  },
  dress(ctx: Ctx) {
    const r = ctx.renderer;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.3;
    const view: Plane = ctx.view === 'stack' ? 'surface' : ctx.view;
    const ty = ctx.view === 'stack' ? (PLANE_Y.depths + PLANE_Y.orbit) / 2 : PLANE_Y[view];
    const sun = new DirectionalLight('#ffe2b8', 2.8);
    sun.position.set(SUN_DIR.x * 40, ty + SUN_DIR.y * 40, SUN_DIR.z * 40);
    sun.target.position.set(0, ty, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const ext = ctx.view === 'stack' ? 30 : 12;
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 120 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    ctx.scene.add(sun, sun.target, new HemisphereLight('#ffe9d0', '#2a2030', 1.0));
    // a soft studio environment so brass, resin and gloss paint have something to reflect
    const pmrem = new PMREMGenerator(r);
    ctx.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    ctx.scene.environmentIntensity = 0.35;
    // lanterns in the Depths tunnels
    for (const [x, y] of [[4, 10], [7, 13], [5, 7], [10, 7]] as const) {
      const l = new PointLight('#ffb56a', 2.2, 5, 1.6);
      l.position.set(wx(x), 0.9, wz(y));
      ctx.roots.depths.add(l);
      const bulb = new Mesh(new IcosahedronGeometry(0.07, 1), std(rgb('#ffcf8a'), { emissive: color('#ffb060').mul(3) as V3 }));
      bulb.position.copy(l.position);
      ctx.roots.depths.add(bulb);
    }
    // frosted acrylic boards for the Sky and Orbit with brass frames, brass posts between all boards
    const brass = std(rgb(BRASS), { metalness: 1, roughness: 0.32 });
    for (const p of ['sky', 'orbit'] as const) {
      const y = p === 'sky' ? -0.6 : -0.45;
      const glass = new Mesh(
        new BoxGeometry(S, 0.06, S),
        p === 'sky' ? std(rgb('#d8e6ee'), { roughness: 0.3, alpha: float(0.1) as F1 }) : std(rgb('#0d0c14'), { roughness: 1 }),
      );
      glass.position.y = y;
      ctx.roots[p].add(glass);
      for (const [sx, sz, w, d] of [[0, S / 2, S + 0.2, 0.12], [0, -S / 2, S + 0.2, 0.12], [S / 2, 0, 0.12, S + 0.2], [-S / 2, 0, 0.12, S + 0.2]] as const) {
        const f = new Mesh(new BoxGeometry(w, 0.1, d), brass);
        f.position.set(sx, y, sz);
        ctx.roots[p].add(f);
      }
    }
    if (ctx.view === 'stack') for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const h = PLANE_Y.orbit - PLANE_Y.depths + 1;
      const post = new Mesh(new CylinderGeometry(0.09, 0.09, h, 10), brass);
      post.position.set(cx * (S / 2 + 0.06), (PLANE_Y.orbit + PLANE_Y.depths) / 2 - 1, cz * (S / 2 + 0.06));
      ctx.scene.add(post);
    }
    // pinprick stars on the orbit board
    const pins = std(rgb('#fff4d8'), { emissive: color('#fff0c8').mul(1.2) as V3 });
    for (let i = 0; i < 70; i++) {
      const s = new Mesh(new IcosahedronGeometry(0.035, 0), pins);
      s.position.set(Math.sin(i * 12.9898) * 7.8, -0.4, Math.cos(i * 78.233) * 7.8);
      ctx.roots.orbit.add(s);
    }
    ctx.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const tr = Array.isArray(o.material) || o.material.transparent;
      o.castShadow = !tr;
      o.receiveShadow = true;
    });
  },
  post(ctx: Ctx) {
    const scenePass = pass(ctx.scene, ctx.camera);
    const col = scenePass.getTextureNode('output');
    // tilt-shift: sharp band across the middle of the frame, blurred top and bottom (reads as a miniature)
    const blurred = gaussianBlur(col, 2.2);
    const band = smoothstep(0.18, 0.42, screenUV.y.sub(0.52).abs());
    let out = mix(col, blurred, band.mul(ctx.view === 'stack' ? 0.4 : 0.85)).rgb as V3;
    out = out.add(bloom(col, 0.35, 0.4, 0.9).rgb) as V3;
    const vig = float(1).sub(screenUV.sub(0.5).length().mul(0.6).pow(2.4));
    out = mix(vec3(lum(out), lum(out), lum(out)), out, 1.12).mul(vig) as V3;
    const pipe = new RenderPipeline(ctx.renderer);
    pipe.outputNode = out;
    return pipe;
  },
};
