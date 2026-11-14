/**
 * The derelict ruin at the Orbit's centre (`matchData.derelict`, DESIGN §4.4), drawn in the page's cel-and-ink style
 * as a huge broken wheel station (art geometry: `derelict-art.ts`): a static hull band of plated modules and frames,
 * torn open at the breaches on the axis bearings with exposed ribs, snapped girders and cables trailing into space,
 * dead solar wings, a broken dish and mast, scorch and a few flickering lights; an inner ring with heavy gate pylons
 * that turns with the public cycle (`ringAngle`, smooth between ticks) and whose door leaves swing shut while it is
 * sealed; a deck-plate wash in the corridor, a faint radiation hatch over the chamber, gate thresholds that hatch amber
 * over the last few seconds before the gates move, a countdown arc round the hull to the next open or close (the same
 * warning window as timed visits, `returns.ts`), vented gas and a drifting, tumbling debris halo.
 *
 * Walls match the sim's walls exactly; all dressing is visual only (no collision, pathing or fire effect) and stays
 * low-contrast under the ships. Debris drift, gas and cable sway run on the match clock (render tick), placed from the
 * public map seed, so every client sees the same ruin.
 *
 * LOD: far out the ruin is one draw per layer (hull, ring, doors, large debris, overlays); close in, the hull dressing,
 * small debris and gas add three more. Geometry is built once per match ruin, in startup slices (nothing shows until
 * it is done); a frame sets one rotation, a few uniforms and three visibilities.
 */
import { BufferAttribute, BufferGeometry, CircleGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, RingGeometry } from 'three/webgpu';
import {
  atan, attribute, cameraViewMatrix, color, cos, cross, dot, float, floor, fract, length, max, mix, mrt, normalGeometry, packNormalToRGB, positionGeometry,
  positionLocal, positionWorld, sin, smoothstep, step, time, uniform, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { PLANE_Y, TICK_RATE, derelictPeriod, derelictPhase, ringAngle, type DerelictGeometry } from '@agent-command/game/contract';
import { FADE } from './fade.ts';
import { LINE_DIST } from './ink.ts';
import { SUN, emptyGeometry, finish, inkMaterial, lines, noise, overlay, rgb, type F1, type V3 } from './materials.ts';
import { LINE, SHADOW } from './palette.ts';
import { wx, wz } from './common.ts';
import { countdownWarning } from './returns.ts';
import { DEBRIS_HIGH, FLOOR, HULL_TOP, ruinArt, type RuinArt } from './derelict-art.ts';
import { prepareStartup } from './startup.ts';

/** Countdown arc just outside the hull (tiles beyond hullOuter), and its width as a share of the hull band (min). */
const ARC_GAP = 0.3;
const ARC_WIDTH = 0.1;
const ARC_MIN = 0.16;
/** Close-zoom dressing shows while the camera is nearer than this many hull radii. */
const DETAIL_ZOOM = 3.2;
/** The high debris halo fades in between these camera distances (hull radii): hidden at play zoom, over the gates. */
const HIGH_FADE = [2.4, 3.4] as const;
/** Share of a ring turn over which the door leaves swing (shut as the turn starts, open as the window starts). */
const DOOR_SHARE = 0.25;
/** Corridor deck plates: size as a share of the hull band. */
const PLATE = 0.8;
const TAU = Math.PI * 2;

const same = (a: DerelictGeometry, b: DerelictGeometry): boolean =>
  a.x === b.x && a.y === b.y && a.hullInner === b.hullInner && a.hullOuter === b.hullOuter && a.breaches === b.breaches
  && a.breachWidth === b.breachWidth && a.ringInner === b.ringInner && a.ringOuter === b.ringOuter && a.gates === b.gates
  && a.gateWidth === b.gateWidth;

/**
 * A ruin the art can build: every size finite and positive, bands nested chamber < ring < corridor < hull. Anything
 * else (missing fields from an older server, a hand-edited match) shows no ruin rather than NaN geometry.
 */
export function buildable(g: DerelictGeometry | undefined): g is DerelictGeometry {
  if (!g) return false;
  const sizes = [g.x, g.y, g.ringInner, g.ringOuter, g.hullInner, g.hullOuter, g.breachWidth, g.gateWidth, g.breaches, g.gates, g.open, g.turn, g.closed];
  return sizes.every((v) => typeof v === 'number' && Number.isFinite(v)) && g.ringInner > 0
    && g.ringInner < g.ringOuter && g.ringOuter < g.hullInner && g.hullInner < g.hullOuter
    && g.breachWidth > 0 && g.gateWidth > 0 && g.breaches > 0 && g.gates > 0 && g.open + 2 * g.turn + g.closed > 0;
}

/** Flat thresholds filling each ring gate (the apertures the ring leaves), just above the floor. */
function thresholds(n: number, half: number, r0: number, r1: number, y: number): BufferGeometry {
  const pos: number[] = [];
  for (let k = 0; k < n; k++) {
    const c = (k * TAU) / n;
    const s0 = Math.asin(Math.min(1, half / r0));
    const s1 = Math.asin(Math.min(1, half / r1));
    const p = [
      [r0 * Math.cos(c - s0), y, r0 * Math.sin(c - s0)],
      [r0 * Math.cos(c + s0), y, r0 * Math.sin(c + s0)],
      [r1 * Math.cos(c + s1), y, r1 * Math.sin(c + s1)],
      [r1 * Math.cos(c - s1), y, r1 * Math.sin(c - s1)],
    ] as const;
    pos.push(...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  return g;
}

/**
 * Hull and ring plating: the vertex paint, burnt where `look.x` marks it (broken up by the baked noise), with lights
 * where `look.y` is set: a steady glow that drops out now and then, or (flicker seed `look.z` ≥ 0.88) a slow beacon.
 */
function plating(): MeshBasicNodeMaterial {
  const look = attribute<'vec4'>('look', 'vec4');
  const paint = attribute<'vec3'>('paint', 'vec3') as unknown as V3;
  const burn = look.x.mul(smoothstep(0.3, 0.62, noise(positionLocal.xz.mul(0.45)).x)).mul(0.85);
  const base = mix(paint, rgb('#2e2826'), burn) as V3;
  const seed = look.z;
  const beat = floor(time.mul(6).add(seed.mul(97)));
  const steady = step(0.12, fract(sin(beat.mul(12.9898).add(seed.mul(78.233))).mul(43758.5453)));
  const beacon = smoothstep(0.55, 1, sin(time.mul(2.4).add(seed.mul(40))));
  const glow = paint.mul(look.y.mul(mix(steady, beacon, step(0.88, seed))).mul(2.2)) as V3;
  return inkMaterial('orbit', base, { fog: false, glow });
}

export class DerelictRuin {
  readonly group = new Group();
  /** The rotating ring with its door leaves and gate thresholds. */
  private readonly ring = new Group();
  private readonly hull: Mesh;
  private readonly hullDetail: Mesh;
  private readonly ringWall: Mesh;
  private readonly doors: Mesh;
  private readonly gates: Mesh;
  private readonly chamber: Mesh;
  private readonly deck: Mesh;
  private readonly inkRings: Mesh;
  private readonly arc: Mesh;
  private readonly debris: Mesh;
  private readonly debrisDetail: Mesh;
  private readonly wisps: Mesh;
  private readonly meshes: Mesh[];
  /** The close-zoom draws (hidden far out). */
  private readonly detail: readonly Mesh[];
  /** 1 while the gates stand open (aligned with the breaches). */
  private readonly open = uniform(0);
  /** Warning progress before the next change (0 … 1), −1 outside the warning window. */
  private readonly warn = uniform(-1);
  /** Share of the current open window, or of the sealed span, still to run. */
  private readonly left = uniform(1);
  /** Door leaves: 0 retracted (open) … 1 shut. */
  private readonly shut = uniform(1);
  /** Match clock (seconds of render tick): debris drift and tumble, gas, cable sway. */
  private readonly clock = uniform(0);
  /** Camera distances (world units) over which the high debris halo fades in. */
  private readonly highNear = uniform(1e9);
  private readonly highFar = uniform(2e9);
  /** Deck seams: radial plate size (tiles) and plates per radian. */
  private readonly plate = uniform(1);
  private readonly platesPerRad = uniform(1);
  /** The ruin last adopted, and the one whose art is built and shown (the build runs in startup slices). */
  private geometry: DerelictGeometry | undefined;
  private shown: DerelictGeometry | undefined;
  private seed = 0;
  private build = 0;
  private pending: Promise<void> = Promise.resolve();
  private detailDist = 0;
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
    const alpha = FADE.orbit.alpha;
    const empty = (): BufferGeometry => emptyGeometry();
    const t = this.clock;

    this.hull = new Mesh(empty(), plating());
    this.ringWall = new Mesh(empty(), plating());
    // Close-zoom hull dressing; cable vertices sway with `look.w` (0 at the anchor … 1 at the free end).
    const dm = plating();
    const look = attribute<'vec4'>('look', 'vec4');
    const ph = look.z.mul(20);
    dm.positionNode = positionLocal.add(vec3(sin(t.mul(0.7).add(ph).add(look.w.mul(4))), sin(t.mul(0.9).add(ph)).mul(0.3), cos(t.mul(0.6).add(ph).add(look.w.mul(3)))).mul(look.w.mul(0.22)));
    this.hullDetail = new Mesh(empty(), dm);

    // Door leaves: dark steel with amber hazard bands, sliding from their open (retracted) offset to shut.
    const pg = positionGeometry;
    const band = step(0.6, fract(pg.x.sub(pg.z).add(pg.y.mul(2)).mul(1.4)));
    const doorm = inkMaterial('orbit', mix(rgb('#6f675d'), rgb('#d49a3a'), band.mul(0.85)) as V3, { fog: false });
    // Open leaves hide inside the ring wall, so only the brief swing shows their (unturned) normals.
    const swing = attribute<'float'>('swing', 'float').mul(float(1).sub(this.shut));
    const pl = positionLocal;
    doorm.positionNode = vec3(pl.x.mul(cos(swing)).sub(pl.z.mul(sin(swing))), pl.y, pl.x.mul(sin(swing)).add(pl.z.mul(cos(swing))));
    this.doors = new Mesh(empty(), doorm);

    // Gate thresholds: dim slate while sealed, mint while open; amber stripes sweeping across in the warning window.
    const warning = step(0, this.warn);
    const stripes = step(0.5, fract(positionWorld.x.add(positionWorld.z).mul(2.4).sub(time.mul(1.6))));
    const gm = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    gm.colorNode = mix(mix(color('#6d78a8'), color('#8fe8c0'), this.open), color('#ffb347'), warning);
    gm.opacityNode = mix(this.open.mul(0.25).add(0.3), stripes.mul(this.warn.mul(0.35).add(0.5)), warning).mul(alpha);
    this.gates = new Mesh(empty(), gm);
    this.gates.renderOrder = 6;

    // The chamber floor: a faint radiation hatch inside the ring (units in there take radiation damage).
    const cm = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    cm.colorNode = color('#c8f07a');
    cm.opacityNode = lines(positionWorld.x.sub(positionWorld.z).mul(3) as F1, 0.12).mul(0.16).add(0.04).mul(alpha);
    this.chamber = new Mesh(empty(), cm);
    this.chamber.renderOrder = 4;

    // The corridor deck: worn plate seams in chalk, rings and spokes, worn through in patches.
    const r = length(pg.xz);
    const a = atan(pg.z, pg.x);
    const seams = max(lines(r.div(this.plate) as F1, 0.05), lines(a.mul(this.platesPerRad) as F1, 0.04));
    const worn = smoothstep(0.32, 0.52, noise(pg.xz.mul(0.12)).x);
    const km = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    km.colorNode = color(LINE.orbit);
    km.opacityNode = seams.mul(0.11).add(0.025).mul(worn).mul(alpha);
    this.deck = new Mesh(empty(), km);
    this.deck.renderOrder = 4;

    // Chalk ink ring on the floor at the chamber edge (where the radiation starts).
    const im = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    im.colorNode = color(LINE.orbit);
    im.opacityNode = float(0.4).mul(alpha);
    this.inkRings = new Mesh(empty(), im);
    this.inkRings.renderOrder = 5;

    // Countdown to the next open or close: the lit share of the ring empties clockwise from the page's top (north),
    // mint while open, amber while sealed, pulsing through the warning window.
    const around = fract(atan(positionGeometry.x, positionGeometry.z.negate()).div(TAU).add(1));
    const lit = step(around, this.left);
    const pulse = mix(float(1), sin(time.mul(10)).mul(0.25).add(0.75), warning);
    const am = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    am.colorNode = mix(mix(color('#ffb347'), color('#8fe8c0'), this.open), color(LINE.orbit), float(1).sub(lit).mul(0.6));
    am.opacityNode = lit.mul(0.55).add(0.12).mul(pulse).mul(alpha);
    this.arc = new Mesh(empty(), am);
    this.arc.renderOrder = 6;

    const dmat = this.debrisMaterial();
    this.debris = new Mesh(empty(), dmat);
    this.debrisDetail = new Mesh(empty(), dmat);
    this.wisps = new Mesh(empty(), this.wispMaterial());
    this.wisps.renderOrder = 7;
    // Debris and gas are placed by their vertex shaders: their geometry bounds say nothing about where they are drawn.
    for (const m of [this.debris, this.debrisDetail, this.wisps, this.hullDetail]) m.frustumCulled = false;

    this.ring.add(this.ringWall, this.doors, this.gates);
    this.group.add(this.chamber, this.deck, this.inkRings, this.hull, this.hullDetail, this.ring, this.arc, this.debris, this.debrisDetail, this.wisps);
    this.meshes = [this.hull, this.hullDetail, this.ringWall, this.doors, this.gates, this.chamber, this.deck, this.inkRings, this.arc, this.debris, this.debrisDetail, this.wisps];
    this.detail = [this.hullDetail, this.debrisDetail, this.wisps];
    this.group.visible = false;
  }

  /** Close-zoom draws for `World.prepareFirstFrame` to warm whatever the startup zoom; none without a ruin. */
  get shaderTemplates(): readonly Mesh[] {
    return this.shown ? this.detail : [];
  }

  /** Resolves once the adopted ruin's art is built and shown. */
  ready(): Promise<void> {
    return this.pending;
  }

  /**
   * Debris pieces: each orbits the ruin centre (`dOrbit` = radius, start bearing, rad/s, altitude) and tumbles about
   * its own axis (`dSpin` = axis × rad/s, phase seed), all on the match clock. Low-contrast faint lines; the high halo
   * fades out at close zoom so nothing above hides gates, core or units.
   */
  private debrisMaterial(): MeshBasicNodeMaterial {
    const t = this.clock;
    const o = attribute<'vec4'>('dOrbit', 'vec4');
    const s = attribute<'vec4'>('dSpin', 'vec4');
    const rate = length(s.xyz);
    const axis = s.xyz.div(max(rate, 1e-4));
    const ang = rate.mul(t).add(s.w.mul(TAU));
    const c = cos(ang), sn = sin(ang);
    const spin = (v: V3): V3 => v.mul(c).add(cross(axis, v).mul(sn)).add(axis.mul(dot(axis, v).mul(float(1).sub(c)))) as V3;
    const phi = o.y.add(o.z.mul(t));
    const centre = vec3(o.x.mul(cos(phi)), o.w.add(sin(t.mul(0.35).add(s.w.mul(TAU))).mul(0.03)), o.x.mul(sin(phi)));
    const nrm = (varying(spin(normalGeometry as unknown as V3), 'vDebrisNormal') as unknown as V3).normalize() as V3;
    const paint = attribute<'vec3'>('paint', 'vec3') as unknown as V3;
    const ndl = dot(nrm, SUN);
    const lit = smoothstep(0, 0.08, ndl);
    const col = mix(paint.mul(color(SHADOW.orbit)), paint, lit).add(smoothstep(0.7, 0.76, ndl).mul(lit).mul(0.1)) as V3;
    const high = step(DEBRIS_HIGH, o.w);
    const mid = step(HULL_TOP + 0.1, o.w).mul(float(1).sub(high));
    const show = mix(float(1), smoothstep(this.highNear, this.highFar, LINE_DIST), high)
      .mul(mix(float(1), smoothstep(this.highNear.mul(0.4), this.highNear.mul(0.8), LINE_DIST).mul(0.5).add(0.5), mid));
    const m = new MeshBasicNodeMaterial();
    m.positionNode = centre.add(spin(positionGeometry as unknown as V3));
    m.colorNode = finish(col, 'orbit', { fog: false });
    m.opacityNode = FADE.orbit.alpha.mul(show);
    m.alphaHash = true;
    // the ink pass reads the tumbling normal; a fainter line weight than the walls keeps the halo quiet
    const view = cameraViewMatrix.mul(vec4(nrm, 0)).xyz.normalize();
    m.mrtNode = mrt({ normal: vec4(packNormalToRGB(view), FADE.orbit.focus.mul(0.3).add(0.5)) });
    return m;
  }

  /** Gas puffs: each quad streams out from its vent along its heading, swelling and thinning over its life. */
  private wispMaterial(): MeshBasicNodeMaterial {
    const t = this.clock;
    const w = attribute<'vec4'>('wisp', 'vec4');
    const z = attribute<'vec4'>('wispSize', 'vec4');
    const life = fract(t.mul(z.z).add(w.w));
    const size = z.y.mul(life.mul(1.4).add(0.35));
    const turn = w.w.mul(TAU).add(life.mul(0.8));
    const pg = positionGeometry;
    const cx = pg.x.mul(cos(turn)).sub(pg.z.mul(sin(turn)));
    const cz = pg.x.mul(sin(turn)).add(pg.z.mul(cos(turn)));
    const travel = life.mul(z.x);
    const m = overlay(new MeshBasicNodeMaterial({ side: DoubleSide }));
    m.positionNode = vec3(w.x.add(cos(w.z).mul(travel)).add(cx.mul(size)), life.mul(0.25).add(HULL_TOP * 0.4), w.y.add(sin(w.z).mul(travel)).add(cz.mul(size)));
    const puff = float(1).sub(smoothstep(0.25, 1, length(pg.xz)));
    const wisp = smoothstep(0.35, 0.65, noise(positionWorld.xz.mul(0.5).add(vec2(t.mul(0.03), 0))).x.add(puff.mul(0.3)));
    m.colorNode = color('#cfd8f0');
    m.opacityNode = puff.mul(wisp).mul(smoothstep(0, 0.12, life)).mul(float(1).sub(life)).mul(0.3).mul(FADE.orbit.alpha);
    return m;
  }

  /** Adopt a match's ruin (undefined: none) and its public map seed. Rebuilds only when either changes. */
  set(g: DerelictGeometry | undefined, seed = 0): void {
    if (!buildable(g)) {
      if (g) console.warn('derelict ruin: unusable geometry in match data; the ruin is not drawn', g);
      g = undefined;
    }
    if ((g === this.geometry || (g && this.geometry && same(g, this.geometry))) && seed === this.seed) {
      this.geometry = g;
      return;
    }
    this.geometry = g;
    this.seed = seed;
    const build = ++this.build;
    this.shown = undefined;
    this.group.visible = false;
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.geometry = emptyGeometry();
    }
    this.pending = g ? prepareStartup(ruinArt(g, seed)).then((art) => {
      if (build === this.build) this.show(g, art);
      else for (const geo of Object.values(art)) geo.dispose();
    }) : Promise.resolve();
  }

  private show(g: DerelictGeometry, art: RuinArt): void {
    const flat = (geo: BufferGeometry): BufferGeometry => geo.rotateX(-Math.PI / 2);
    const T = g.hullOuter - g.hullInner;
    this.hull.geometry = art.hull;
    this.hullDetail.geometry = art.hullDetail;
    this.ringWall.geometry = art.ring;
    this.doors.geometry = art.doors;
    this.debris.geometry = art.debris;
    this.debrisDetail.geometry = art.debrisDetail;
    this.wisps.geometry = art.wisps;
    this.gates.geometry = thresholds(g.gates, g.gateWidth / 2, g.ringInner, g.ringOuter, FLOOR + 0.04);
    this.chamber.geometry = flat(new CircleGeometry(g.ringInner, 64)).translate(0, FLOOR + 0.02, 0);
    this.deck.geometry = flat(new RingGeometry(g.ringOuter, g.hullInner, 128, 2)).translate(0, FLOOR + 0.015, 0);
    this.inkRings.geometry = flat(new RingGeometry(g.ringInner - 0.05, g.ringInner, 96)).translate(0, FLOOR + 0.03, 0);
    const arc = Math.max(ARC_MIN, ARC_WIDTH * T);
    this.arc.geometry = flat(new RingGeometry(g.hullOuter + ARC_GAP, g.hullOuter + ARC_GAP + arc, 160)).translate(0, FLOOR + 0.05, 0);
    const plate = PLATE * T;
    this.plate.value = plate;
    this.platesPerRad.value = Math.round((TAU * (g.ringOuter + g.hullInner)) / 2 / plate) / TAU;
    this.highNear.value = HIGH_FADE[0] * g.hullOuter;
    this.highFar.value = HIGH_FADE[1] * g.hullOuter;
    this.detailDist = DETAIL_ZOOM * g.hullOuter;
    this.group.position.set(wx(g.x, this.size), PLANE_Y.orbit, wz(g.y, this.size));
    this.shown = g;
    this.group.visible = true;
  }

  /** Ring rotation, doors, gate telegraphs and drift at render tick `tick` (fractional), close dressing within reach of `dist`. */
  frame(tick: number, dist: number): void {
    const g = this.shown;
    if (!g) return;
    // A tile-frame rotation by +a (east toward south) is a world rotation of −a about +y.
    this.ring.rotation.y = -ringAngle(g, tick);
    const p = derelictPhase(g, tick);
    const open = p < g.open;
    // Open: the window runs out as the ring starts to turn shut. Otherwise: it reopens at the next period.
    const left = open ? g.open - p : derelictPeriod(g) - p;
    this.open.value = open ? 1 : 0;
    this.left.value = left / (open ? g.open : derelictPeriod(g) - g.open);
    this.warn.value = countdownWarning(left);
    // Leaves shut as soon as the gates seal (the sim's ring is solid from then on) and open only once the window has.
    const swing = g.turn * DOOR_SHARE;
    this.shut.value = open ? 1 - Math.min(1, p / swing) : p < g.open + g.turn ? Math.min(1, (p - g.open) / swing) : 1;
    this.clock.value = tick / TICK_RATE;
    const near = dist < this.detailDist;
    this.hullDetail.visible = near;
    this.debrisDetail.visible = near;
    this.wisps.visible = near;
  }
}
