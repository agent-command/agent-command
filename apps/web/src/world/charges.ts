/**
 * Planted sapper charges as models on their Depths cell (DESIGN §13): a Field Journal bundle of dynamite sticks in
 * ink, tied with a band in the planting army's colour, with more sticks (and a pip per sapper) when sappers stack on
 * it. A cord fuse burns down toward the bundle with a spark that blinks faster as detonation nears, a small countdown
 * dial on the floor fills toward it, and in the public last rules.depths.chargePublicTime the dial adds a hot warning
 * glow.
 *
 * Drawn only from `view.charges` (own and allied charges plus the hostile ones the team knows of), so a hostile
 * charge that leaves that list simply vanishes, as does a defused one (its fizzle is the `defuse` effect in
 * `combat.ts`). Each also vanishes at its detonation tick on screen, where the collapse effect takes over.
 * Fixed instanced pools; per-frame work allocates nothing.
 */
import { AdditiveBlending, BufferAttribute, Color, CylinderGeometry, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, PlaneGeometry, Quaternion, Vector3, type BufferGeometry, type Node } from 'three/webgpu';
import { abs, atan, attribute, color, float, fract, fwidth, instancedDynamicBufferAttribute, max, mix, positionGeometry, smoothstep, uv } from 'three/tsl';
import { TICK_RATE, type ArmyId, type Plane, type View } from '@agent-command/game/contract';
import { THREAT_COLOR, clamp, hash2, relation, sideColor, unitY, wx, wz } from './common.ts';
import { FADE, fadeValue, focusValue } from './fade.ts';
import { inkMaterial, overlay, type F1, type V3 } from './materials.ts';
import { CHARGE_PAINT, INK } from './palette.ts';
import type { ParticlePool } from './gpu-particles.ts';

type V4 = Node<'vec4'>;
type Charge = View['charges'][number];

/** Charges drawn at once (a fogged view lists at most 32; the omniscient observer row may list more). */
export const CHARGE_DRAWN = 64;
/** Sticks for a lone charge; each further sapper on it adds STICKS_PER_SAPPER, up to STICKS_MAX. */
const STICKS_BASE = 3;
const STICKS_PER_SAPPER = 2;
export const STICKS_MAX = 9;
/** Pips on the band: one per sapper on a stacked charge, at most PIPS_MAX. */
export const PIPS_MAX = 6;
/** Stick size (tiles): radius and length. */
const STICK = { r: 0.076, len: 0.56 } as const;
/** The band round each stick: its width and how far it stands off the paper; cream edge stripes frame the colour. */
const BAND = { w: 0.13, grow: 1.16, edge: 0.018 } as const;
/** Pip radius and spacing (tiles). */
const PIP = { r: 0.03, gap: 0.085 } as const;
/** The fuse cord: full length (tiles), share left at detonation, radius, lean off vertical (rad). */
const FUSE = { len: 0.34, min: 0.12, r: 0.015, lean: 0.75 } as const;
/** The fuse spark: radius (tiles) and its blink swell. */
const SPARK = { r: 0.035, swell: 0.5 } as const;
/** Sparks thrown off the burning fuse per second, early in the fuse and at detonation. */
const SPARK_RATE = { early: 2.5, late: 14 } as const;
/** Countdown dial radius (tiles): a little wider than the bundle. */
const DIAL_R = 0.6;
/**
 * Urgency blink: rate = a / (left + b) Hz, so it accelerates like a bomb's beep (0.6 Hz with 20 s left, 6 Hz at
 * the end). The phase is its integral over time, continuous however the rate grows.
 */
const BLINK = { a: 15, b: 2.5 } as const;
/** Seconds the public warning glow takes to come up once the charge enters its public window. */
const HEAT_RAMP_S = 0.4;

/** Sticks in the bundle: STICKS_BASE, plus STICKS_PER_SAPPER for each further sapper (hostile: stack unknown → one). */
export function chargeSticks(stack: number | undefined): number {
  const n = Math.max(1, Math.floor(stack ?? 1));
  return Math.min(STICKS_MAX, STICKS_BASE + (n - 1) * STICKS_PER_SAPPER);
}

/** Pips on the band: one per sapper on a stacked charge (none on a lone or hostile one, whose stack we don't know). */
export function chargePips(stack: number | undefined): number {
  return stack !== undefined && stack > 1 ? Math.min(PIPS_MAX, Math.floor(stack)) : 0;
}

/** Share of the fuse burnt (0 planted … 1 detonation) with `left` seconds of a `fuse`-second fuse to go. */
export function chargeElapsed(left: number, fuse: number): number {
  return clamp(1 - left / Math.max(1e-3, fuse), 0, 1);
}

/** Blink rate (Hz) with `left` seconds to go: rises steeply into the last seconds. */
export function chargeBlinkRate(left: number): number {
  return BLINK.a / (Math.max(0, left) + BLINK.b);
}

/** Blink phase (cycles) with `left` seconds to go: the integral of `chargeBlinkRate` as `left` runs down. */
export function chargeBlinkPhase(left: number): number {
  return -BLINK.a * Math.log(Math.max(0, left) + BLINK.b);
}

/** Blink brightness 0..1: a short flash once per cycle. */
export function chargeBlink(left: number): number {
  const c = 0.5 + 0.5 * Math.cos(chargeBlinkPhase(left) * Math.PI * 2);
  return c * c * c;
}

/** The public-window warning 0..1: up within HEAT_RAMP_S of entering the last `publicS` seconds, 0 once blown. */
export function chargeHeat(left: number, publicS: number): number {
  return left <= 0 ? 0 : clamp((publicS - left) / HEAT_RAMP_S, 0, 1);
}

/** Seconds left on `c` at on-screen time `now`, given the view tick's screen time and ms per tick. */
export function chargeLeft(c: Charge, viewTick: number, viewMs: number, msPerTick: number, now: number): number {
  return Math.max(0, (viewMs + (c.tick - viewTick) * msPerTick - now) / 1000);
}

/** Fuse length (s) for charges of `side`: Shaped Charges when the planter's research is known to include it. */
function fuseFor(view: View, side: Charge['side']): number {
  const d = view.match!.rules.depths;
  const shaped = side === view.army ? view.research.completed.includes('shaped_charges') : view.research.seen.some((s) => s.army === side && s.upgrades.includes('shaped_charges'));
  return shaped ? d.shapedChargesUndermineTime : d.undermineTime;
}

const UP = new Vector3(0, 1, 0);
const Q = new Quaternion();
const QF = new Quaternion();
const LEAN = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -FUSE.lean);
const P = new Vector3();
const S = new Vector3();
const D = new Vector3();
const M = new Matrix4();
const ONE = new Quaternion();
const HOT = new Color(CHARGE_PAINT.spark);

export class ChargeModels {
  readonly root = new Group();
  private readonly sticks: InstancedMesh;
  private readonly bands: InstancedMesh;
  private readonly bandTint: InstancedBufferAttribute;
  private readonly pips: InstancedMesh;
  private readonly fuses: InstancedMesh;
  private readonly sparks: InstancedMesh;
  private readonly sparkTint: InstancedBufferAttribute;
  private readonly dials: InstancedMesh;
  private readonly dialTint: InstancedBufferAttribute;
  /** per dial: elapsed 0..1, blink 0..1, heat 0..1, - */
  private readonly dialData: InstancedBufferAttribute;
  /** Every pool above, for the per-frame upload flags. */
  private readonly meshes: readonly InstancedMesh[];
  private charges: View['charges'] = [];
  private army: ArmyId = 'nw';
  /** Fuse seconds per listed charge (index-aligned with `charges`, the first CHARGE_DRAWN), refreshed per view. */
  private readonly fuse = new Float32Array(CHARGE_DRAWN);
  /** rules.depths.undermineTime: the fuse of charges listed past CHARGE_DRAWN. */
  private plainFuse = 1;
  /** rules.depths.chargePublicTime (s): the last stretch of every fuse, when the warning glow is up. */
  publicS = 0;
  private viewTick = 0;
  private viewMs = 0;
  private msPerTick = 1000 / TICK_RATE;
  private seq = 0;
  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.root.name = 'charges';
    const plane: Plane = 'depths';

    this.sticks = pool('charge-sticks', stickGeometry(), inkMaterial(plane, attribute<'vec3'>('paint', 'vec3') as V3, { fog: false }), CHARGE_DRAWN * STICKS_MAX);

    this.bandTint = dynamic(CHARGE_DRAWN * STICKS_MAX, 3);
    const team = instancedDynamicBufferAttribute<'vec3'>(this.bandTint, 'vec3') as V3;
    const stripe = smoothstep(BAND.w / 2 - BAND.edge - 0.002, BAND.w / 2 - BAND.edge, abs(positionGeometry.x));
    const bandGeo = new CylinderGeometry(STICK.r * BAND.grow, STICK.r * BAND.grow, BAND.w, 12).rotateZ(Math.PI / 2);
    this.bands = pool('charge-bands', bandGeo, inkMaterial(plane, mix(team, color(CHARGE_PAINT.pip), stripe) as V3, { fog: false }), CHARGE_DRAWN * STICKS_MAX);

    this.pips = pool('charge-pips', new IcosahedronGeometry(PIP.r, 1), inkMaterial(plane, color(CHARGE_PAINT.pip) as unknown as V3, { fog: false }), CHARGE_DRAWN * PIPS_MAX);

    const cord = new CylinderGeometry(FUSE.r, FUSE.r, 1, 5).translate(0, 0.5, 0);
    this.fuses = pool('charge-fuses', cord, inkMaterial(plane, color(CHARGE_PAINT.cord) as unknown as V3, { fog: false }), CHARGE_DRAWN);

    // the spark: an additive hot bead (> 1 blooms), its brightness per instance
    this.sparkTint = dynamic(CHARGE_DRAWN, 4);
    const st = instancedDynamicBufferAttribute<'vec4'>(this.sparkTint, 'vec4') as V4;
    const sparkMat = overlay(new MeshBasicNodeMaterial());
    sparkMat.blending = AdditiveBlending;
    sparkMat.colorNode = st.xyz;
    sparkMat.opacityNode = st.w.mul(FADE.depths.alpha);
    this.sparks = pool('charge-sparks', new IcosahedronGeometry(1, 1), sparkMat, CHARGE_DRAWN);

    this.dialTint = dynamic(CHARGE_DRAWN, 4);
    this.dialData = dynamic(CHARGE_DRAWN, 4);
    this.dials = pool('charge-dials', new PlaneGeometry(2, 2).rotateX(-Math.PI / 2), dialMaterial(this.dialTint, this.dialData), CHARGE_DRAWN);
    this.dials.renderOrder = 2;

    this.meshes = [this.dials, this.sticks, this.bands, this.pips, this.fuses, this.sparks];
    this.root.add(...this.meshes);
  }

  reset(): void {
    this.charges = [];
    this.publicS = 0;
    this.seq = 0;
    this.hide();
  }

  /** The view's known charges and its tick → screen-time mapping (`viewMs` at `viewTick`, `msPerTick`). */
  ingest(view: View, viewMs: number, msPerTick: number): void {
    this.charges = view.charges;
    this.army = view.army;
    this.viewTick = view.tick;
    this.viewMs = viewMs;
    this.msPerTick = msPerTick;
    this.publicS = view.match!.rules.depths.chargePublicTime;
    this.plainFuse = view.match!.rules.depths.undermineTime;
    const n = Math.min(CHARGE_DRAWN, view.charges.length);
    for (let i = 0; i < n; i++) this.fuse[i] = fuseFor(view, view.charges[i]!.side);
  }

  /** Fuse seconds of the view's `i`th charge (Shaped Charges when its planter is known to have them). */
  fuseS(i: number): number {
    return i < CHARGE_DRAWN ? this.fuse[i]! : this.plainFuse;
  }

  /** Lay out every listed, unexploded charge for screen time `now`; `dt` seconds since the last frame. */
  frame(now: number, dt: number, sparks?: ParticlePool): void {
    if (fadeValue.depths <= 0.03) {
      this.hide();
      return;
    }
    const fade = 0.45 + 0.55 * focusValue.depths;
    const sm = this.sticks.instanceMatrix.array as Float32Array;
    const bm = this.bands.instanceMatrix.array as Float32Array;
    const band = this.bandTint.array as Float32Array;
    const pm = this.pips.instanceMatrix.array as Float32Array;
    const fm = this.fuses.instanceMatrix.array as Float32Array;
    const km = this.sparks.instanceMatrix.array as Float32Array;
    const kt = this.sparkTint.array as Float32Array;
    const dm = this.dials.instanceMatrix.array as Float32Array;
    const dtint = this.dialTint.array as Float32Array;
    const dd = this.dialData.array as Float32Array;
    const y0 = unitY('depths');
    let nc = 0, ns = 0, np = 0;
    const n = Math.min(CHARGE_DRAWN, this.charges.length);
    for (let i = 0; i < n; i++) {
      const c = this.charges[i]!;
      const left = chargeLeft(c, this.viewTick, this.viewMs, this.msPerTick, now);
      // blown on screen: the collapse effect takes over
      if (left <= 0) continue;
      const el = chargeElapsed(left, this.fuse[i]!);
      const blink = chargeBlink(left);
      const heat = chargeHeat(left, this.publicS);
      const cx = wx(c.x + 0.5, this.size);
      const cz = wz(c.y + 0.5, this.size);
      const yaw = hash2(c.x * 7 + 3, c.y * 13 + 1) * Math.PI;
      Q.setFromAxisAngle(UP, yaw);

      // the bundle: a bottom row and a top row nestled into its grooves, all lying along local x
      const total = chargeSticks(c.stack);
      const bottom = (total + 1) >> 1;
      const top = total - bottom;
      const topY = STICK.r * (1 + Math.sqrt(3));
      const team = sideColor(c.side);
      for (let k = 0; k < total; k++) {
        const upper = k >= bottom;
        const j = upper ? k - bottom : k;
        const row = upper ? top : bottom;
        const jitter = (hash2(k, c.x * 31 + c.y) - 0.5) * 0.05;
        put(P.set(jitter, upper ? topY : STICK.r, (j - (row - 1) / 2) * STICK.r * 2), cx, y0, cz);
        M.compose(P, Q, S.set(1, 1, 1));
        M.toArray(sm, ns * 16);
        M.toArray(bm, ns * 16);
        band[ns * 3] = team.r; band[ns * 3 + 1] = team.g; band[ns * 3 + 2] = team.b;
        ns++;
      }
      // one pip per sapper along the band's crown
      const pips = chargePips(c.stack);
      const crown = (top > 0 ? topY : STICK.r) + STICK.r * BAND.grow + PIP.r * 0.4;
      for (let k = 0; k < pips; k++) {
        put(P.set(0, crown, (k - (pips - 1) / 2) * PIP.gap), cx, y0, cz);
        M.compose(P, ONE, S.set(1, 1, 1));
        M.toArray(pm, np++ * 16);
      }

      // the fuse leaves the end of the top row's middle stick, leaning out, and burns down toward it
      const tj = Math.floor(((top > 0 ? top : bottom) - 1) / 2);
      const tRow = top > 0 ? top : bottom;
      put(P.set(STICK.len / 2 - 0.035, (top > 0 ? topY : STICK.r) + STICK.r * 0.55, (tj - (tRow - 1) / 2) * STICK.r * 2), cx, y0, cz);
      QF.multiplyQuaternions(Q, LEAN);
      const len = FUSE.len * (FUSE.min + (1 - FUSE.min) * (1 - el));
      M.compose(P, QF, S.set(1, len, 1));
      M.toArray(fm, nc * 16);
      // the spark at the burning end
      D.copy(UP).applyQuaternion(QF).multiplyScalar(len).add(P);
      const flicker = 0.85 + 0.3 * hash2(this.seq & 1023, i);
      const r = SPARK.r * flicker * (1 + SPARK.swell * blink) * (1 + 0.25 * heat);
      M.compose(D, ONE, S.set(r, r, r));
      M.toArray(km, nc * 16);
      const glow = 1.2 + 1.2 * blink + 0.6 * heat;
      kt[nc * 4] = HOT.r * glow; kt[nc * 4 + 1] = HOT.g * glow; kt[nc * 4 + 2] = HOT.b * glow; kt[nc * 4 + 3] = 1;
      if (sparks && dt > 0 && hash2(this.seq & 4095, i * 17 + 5) < dt * (SPARK_RATE.early + (SPARK_RATE.late - SPARK_RATE.early) * el * el)) {
        const u = hash2(i, this.seq & 2047);
        const v = hash2(this.seq & 511, i + 9);
        sparks.spawn(0, D.x, D.y, D.z, (u - 0.5) * 0.9, 0.6 + v * 0.9, (v - 0.5) * 0.9, 0.3 + u * 0.25, 0.035, 0.008, HOT, 1, 4, 0.5);
      }

      // the countdown dial on the floor: own and allied in their colour, hostile in threat amber
      M.compose(P.set(cx, y0 + 0.012, cz), ONE, S.set(DIAL_R, 1, DIAL_R));
      M.toArray(dm, nc * 16);
      const col = relation(this.army, c.side) === 'hostile' ? THREAT_COLOR : team;
      dtint[nc * 4] = col.r; dtint[nc * 4 + 1] = col.g; dtint[nc * 4 + 2] = col.b; dtint[nc * 4 + 3] = fade;
      dd[nc * 4] = el; dd[nc * 4 + 1] = blink; dd[nc * 4 + 2] = heat; dd[nc * 4 + 3] = 0;
      nc++;
    }
    this.seq++;
    this.sticks.count = ns;
    this.bands.count = ns;
    this.pips.count = np;
    this.fuses.count = nc;
    this.sparks.count = nc;
    this.dials.count = nc;
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
    this.bandTint.needsUpdate = true;
    this.sparkTint.needsUpdate = true;
    this.dialTint.needsUpdate = true;
    this.dialData.needsUpdate = true;
  }

  /** Charges currently drawn (tests, diagnostics). */
  get drawn(): number {
    return this.dials.count;
  }

  private hide(): void {
    this.sticks.count = this.bands.count = this.pips.count = this.fuses.count = this.sparks.count = this.dials.count = 0;
  }
}

/** Bundle-local point `P` (rotated by `Q`) moved to the cell centre (cx, y0, cz). */
function put(p: Vector3, cx: number, y0: number, cz: number): Vector3 {
  return p.applyQuaternion(Q).add(D.set(cx, y0, cz));
}

function dynamic(n: number, itemSize: number): InstancedBufferAttribute {
  const a = new InstancedBufferAttribute(new Float32Array(n * itemSize), itemSize);
  a.setUsage(DynamicDrawUsage);
  return a;
}

function pool(name: string, geo: BufferGeometry, material: MeshBasicNodeMaterial, cap: number): InstancedMesh {
  const m = new InstancedMesh(geo, material, cap);
  m.name = name;
  m.instanceMatrix.setUsage(DynamicDrawUsage);
  m.count = 0;
  m.frustumCulled = false;
  return m;
}

/** A stick lying along x: red paper body, pale wadded ends (`paint` per vertex, by the face normal). */
function stickGeometry(): BufferGeometry {
  const g = new CylinderGeometry(STICK.r, STICK.r, STICK.len, 10, 1).rotateZ(Math.PI / 2).toNonIndexed();
  const normal = g.getAttribute('normal');
  const paint = new Float32Array(normal.count * 3);
  const body = new Color(CHARGE_PAINT.stick);
  const end = new Color(CHARGE_PAINT.end);
  for (let i = 0; i < normal.count; i++) {
    const c = Math.abs(normal.getX(i)) > 0.5 ? end : body;
    paint[i * 3] = c.r; paint[i * 3 + 1] = c.g; paint[i * 3 + 2] = c.b;
  }
  g.setAttribute('paint', new BufferAttribute(paint, 3));
  return g;
}

/**
 * The countdown dial on a 2×2 quad's uv: a pencil track between ink rims whose elapsed share fills clockwise from
 * 12 o'clock in the tint, a soft hot glow under the bundle that flashes with the blink, and in the public window
 * (heat) a brighter steady glow and a hot outer halo.
 */
function dialMaterial(tintAttr: InstancedBufferAttribute, dataAttr: InstancedBufferAttribute): MeshBasicNodeMaterial {
  const tint = instancedDynamicBufferAttribute<'vec4'>(tintAttr, 'vec4') as V4;
  const d = instancedDynamicBufferAttribute<'vec4'>(dataAttr, 'vec4') as V4;
  const q = uv().sub(0.5).mul(2);
  const r = q.length();
  const aa = fwidth(r).mul(1.2);
  const band = (lo: number, hi: number): F1 =>
    smoothstep(aa.negate().add(lo), aa.add(lo), r).mul(float(1).sub(smoothstep(aa.negate().add(hi), aa.add(hi), r))) as F1;
  const track = band(0.72, 0.86);
  const rims = max(band(0.68, 0.72), band(0.86, 0.9));
  const along = fract(atan(q.y, q.x).div(Math.PI * 2).add(0.5).sub(0.25));
  const el = d.x;
  const blink = d.y;
  const heat = d.z;
  const filled = float(1).sub(smoothstep(el.sub(0.006), el, along)).mul(track);
  const glowFall = float(1).sub(smoothstep(0, 0.95, r));
  const glow = glowFall.mul(glowFall).mul(blink.mul(0.35).add(heat.mul(0.55)).add(0.08));
  const halo = band(0.9, 1).mul(heat).mul(blink.mul(0.4).add(0.45));
  const hot = color(CHARGE_PAINT.spark);
  const ink = color(INK.depths);
  const ring = mix(mix(color(CHARGE_PAINT.pip), tint.xyz, filled.greaterThan(0.01).select(float(1), float(0))), ink, rims);
  const m = overlay(new MeshBasicNodeMaterial());
  m.colorNode = mix(hot.mul(heat.mul(0.8).add(1.2)), ring, max(track, rims).clamp(0, 1)).add(hot.mul(halo));
  m.opacityNode = max(max(track.mul(filled.mul(0.6).add(0.35)), rims.mul(0.85)), max(glow, halo)).mul(tint.w).mul(FADE.depths.alpha).min(1);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  return m;
}
