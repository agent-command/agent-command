/**
 * Geometry of the derelict ruin's art (`derelict.ts`): a broken circular station built once per match from the
 * public ruin geometry (`matchData.derelict`) and the public map seed, every plan dimension a share of the hull and ring
 * radii so the ruin reads the same at any size. Heights are absolute world units (ships ride at 0, the Orbit page lies
 * at −0.3), so walls stay under the fleets whatever the ruin's size.
 *
 * Gameplay walls are exact: the hull and ring bands are solid wherever the sim's lateral aperture test
 * (`axisLateral`) says so and nothing solid stands inside an aperture; only floating, swaying and drifting dressing
 * (cables, gas, debris) ever crosses an opening, and none of it blocks anything.
 *
 * All geometry is non-indexed flat-shaded triangles with a `paint` colour and a `look` channel (burn, glow, flicker
 * seed, sway). Debris pieces carry their own orbit and tumble (`dOrbit`, `dSpin`): the vertex shader moves them, so
 * nothing is updated per frame on the CPU.
 */
import { BufferAttribute, BufferGeometry, Color } from 'three/webgpu';
import type { DerelictGeometry } from '@agent-command/game/contract';

type P = readonly [number, number, number];

/** Orbit page sheet (world y); every wall rises from it. */
export const FLOOR = -0.3;
/** Hull plating top, its frames, and the ring's top (world y). */
export const HULL_TOP = 0.3;
const RIB_RISE = 0.08;
export const RING_TOP = 0.22;
/** Door leaves stay just under the ring top so retracted leaves hide inside the wall. */
const DOOR_TOP = RING_TOP - 0.035;
const PYLON_TOP = RING_TOP + 0.2;
/** Debris altitude bands (world y): under the ships, just above the hull, high halo (faded at close zoom). */
export const DEBRIS_HIGH = 0.95;
/** Longest arc (rad) one flat facet of a curved wall spans. */
const FACET = Math.PI / 72;

const PAINT = {
  plate: ['#9a8d7f', '#8f8477', '#a39785', '#8a8172', '#968a7a'],
  rust: '#8b6f5a',
  rib: '#6b635b',
  girder: '#7d7166',
  scorch: '#3b3431',
  deck: '#5d554f',
  solar: '#34406e',
  solarFrame: '#8f8c86',
  ring: ['#c4b394', '#b8a88b', '#cbbb9c'],
  ringRib: '#8c7f69',
  pylon: '#5b554e',
  hazard: '#d49a3a',
  hazardDark: '#2f2b29',
  door: '#6f675d',
  greeble: '#7f776c',
  cable: ['#4a4646', '#5b4f45', '#3f4552'],
  light: ['#ffc46b', '#8fe8c0', '#ff6a3d', '#bfe1ff'],
  debris: ['#5c5a6a', '#4f4d5f', '#666071', '#5e4f49', '#2f3a62', '#6e6872'],
} as const;

/** Seeded uniform [0, 1) stream (mulberry32): the public map seed gives every client the same ruin. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: P): P => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));
/** Rotate v about the unit axis k by angle a (Rodrigues). */
const turn = (v: P, k: P, a: number): P => add(add(mul(v, Math.cos(a)), mul(cross(k, v), Math.sin(a))), mul(k, dot(k, v) * (1 - Math.cos(a))));
const UP: P = [0, 1, 0];
const at = (r: number, a: number, y: number): P => [r * Math.cos(a), y, r * Math.sin(a)];
const radial = (a: number): P => [Math.cos(a), 0, Math.sin(a)];
const tangent = (a: number): P => [-Math.sin(a), 0, Math.cos(a)];

/** Right-handed frame (u, v, w = u × v) with u along `d` and v as close to `up` as allowed. */
function frame(d: P, up: P = UP): [P, P, P] {
  const u = unit(d);
  const ref = Math.abs(dot(u, up)) > 0.95 ? ([1, 0, 0] as P) : up;
  const v = unit(sub(ref, mul(u, dot(u, ref))));
  return [u, v, cross(u, v)];
}

/** Hexahedron faces as corner indices i + 2j + 4k (i along u, j along v, k along w), wound outward. */
const FACES = {
  pu: [1, 3, 7, 5], nu: [0, 4, 6, 2], pv: [2, 6, 7, 3], nv: [0, 1, 5, 4], pw: [4, 5, 7, 6], nw: [0, 2, 3, 1],
} as const;
type Face = keyof typeof FACES;
const ALL: readonly Face[] = ['pu', 'nu', 'pv', 'nv', 'pw', 'nw'];
const NO_BOTTOM: readonly Face[] = ['pu', 'nu', 'pv', 'pw', 'nw'];

/** Non-indexed triangle soup with flat normals, paint and per-vertex channels (current values stamp new vertices). */
export class Kit {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly col: number[] = [];
  private readonly channels = new Map<string, { size: number; data: number[]; cur: number[] }>();
  private readonly c = new Color();
  private paintRgb: [number, number, number] = [1, 1, 1];

  constructor(channels: Record<string, number>) {
    for (const [name, size] of Object.entries(channels)) this.channels.set(name, { size, data: [], cur: new Array<number>(size).fill(0) });
  }

  paint(hex: string): this {
    this.c.set(hex);
    this.paintRgb = [this.c.r, this.c.g, this.c.b];
    return this;
  }

  set(name: string, ...v: number[]): this {
    const ch = this.channels.get(name)!;
    for (let i = 0; i < ch.size; i++) ch.cur[i] = v[i] ?? 0;
    return this;
  }

  get vertices(): number {
    return this.pos.length / 3;
  }

  tri(a: P, b: P, c: P): void {
    const n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) return;
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0] / l, n[1] / l, n[2] / l);
      this.col.push(...this.paintRgb);
      for (const ch of this.channels.values()) ch.data.push(...ch.cur);
    }
  }

  quad(a: P, b: P, c: P, d: P): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Eight corners (index i + 2j + 4k, right-handed i, j, k), only the listed faces. */
  hexa(c: readonly P[], faces: readonly Face[] = ALL): void {
    for (const f of faces) {
      const [a, b, cc, d] = FACES[f];
      this.quad(c[a]!, c[b]!, c[cc]!, c[d]!);
    }
  }

  /** Oriented box: centre, right-handed unit frame and half sizes. */
  box(o: P, [u, v, w]: readonly [P, P, P], hu: number, hv: number, hw: number, faces: readonly Face[] = ALL): void {
    const c: P[] = [];
    for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      c.push(add(add(add(o, mul(u, i ? hu : -hu)), mul(v, j ? hv : -hv)), mul(w, k ? hw : -hw)));
    }
    this.hexa(c, faces);
  }

  /** A thin beam from a to b (square section, half width h). */
  beam(a: P, b: P, h: number, up: P = UP): void {
    const d = sub(b, a);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-6) return;
    this.box(mul(add(a, b), 0.5), frame(d, up), len / 2, h, h);
  }

  /**
   * Curved wall band: inner radius r0 over angles ai0…ai1, outer r1 over ao0…ao1 (straight cheeks between their
   * ends), from y0 to y1; top, inner and outer faces plus the end caps asked for.
   */
  slab(r0: number, r1: number, ai0: number, ai1: number, ao0: number, ao1: number, y0: number, y1: number, caps: readonly ('start' | 'end')[] = ['start', 'end']): void {
    const steps = Math.max(1, Math.ceil(Math.max(ai1 - ai0, ao1 - ao0) / FACET));
    for (let s = 0; s < steps; s++) {
      const c: P[] = [];
      for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const t = (s + k) / steps;
        c.push(at(i ? r1 : r0, i ? lerp(ao0, ao1, t) : lerp(ai0, ai1, t), j ? y1 : y0));
      }
      const faces: Face[] = ['pu', 'nu', 'pv'];
      if (s === 0 && caps.includes('start')) faces.push('nw');
      if (s === steps - 1 && caps.includes('end')) faces.push('pw');
      this.hexa(c, faces);
    }
  }

  /** Polyline tube (square beams joined end to end). */
  cable(points: readonly P[], h: number, sway?: (t: number) => number): void {
    for (let i = 1; i < points.length; i++) {
      if (sway) this.channels.get('look')!.cur[3] = sway(i / (points.length - 1));
      this.beam(points[i - 1]!, points[i]!, h);
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('paint', new BufferAttribute(new Float32Array(this.col), 3));
    for (const [name, ch] of this.channels) g.setAttribute(name, new BufferAttribute(new Float32Array(ch.data), ch.size));
    g.computeBoundingSphere();
    return g;
  }
}

/** Every ruin part, in ruin-local coordinates (tile x → local x, tile y → local z, centre at the origin). */
export interface RuinArt {
  /** Static hull: plated modules, frames, torn ends, girders, solar wings, the dead dish and mast, lights. */
  hull: BufferGeometry;
  /** Close-zoom hull dressing: greebles, pipes and the swaying cables at the tears. */
  hullDetail: BufferGeometry;
  /** Inner ring (turns with `ringAngle`): plated modules, gate pylons with hazard caps and beacons. */
  ring: BufferGeometry;
  /** Gate door leaves in their shut pose; `swing` is the turn (rad about the ruin centre) to their open pose. */
  doors: BufferGeometry;
  /** Drifting, tumbling debris halo: large pieces (every zoom) and small pieces and clouds (close zoom). */
  debris: BufferGeometry;
  debrisDetail: BufferGeometry;
  /** Vented gas puffs: one quad per puff; `wisp` = origin x, z, heading, seed; `wispSize` = travel, size, rate. */
  wisps: BufferGeometry;
}

/** Wall kits carry `look` = burn, glow, flicker seed, sway (see `derelict.ts` plating). */
const PLATING = { look: 4 };

/** Angular half-width of a straight-sided aperture of lateral half-width `half` at radius r. */
const spread = (half: number, r: number): number => Math.asin(Math.min(1, half / r));

/**
 * Build the ruin's art, one bounded task per step (a hull segment, the cables, the ring, the doors, a debris layer,
 * the gas): run it with `prepareStartup` so a large ruin never blocks a frame. Pure: the same geometry and seed give
 * the same buffers.
 */
export function* ruinArt(g: DerelictGeometry, seed: number): Generator<void, RuinArt> {
  const rnd = seeded(seed ^ 0x5eed_d3e1);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const range = (a: number, b: number): number => lerp(a, b, rnd());

  const hull = new Kit(PLATING);
  const detail = new Kit(PLATING);
  const r0 = g.hullInner;
  const r1 = g.hullOuter;
  const T = r1 - r0;
  const half = g.breachWidth / 2;
  const n = g.breaches;
  // Unique features: the dead comm dish and the leaning mast, on seeded segments.
  const dishAt = Math.floor(rnd() * n);
  const mastAt = (dishAt + 1 + Math.floor(rnd() * (n - 1))) % n;
  const tears: { a: number; side: 1 | -1 }[] = [];

  for (let k = 0; k < n; k++) {
    const c0 = (k * 2 * Math.PI) / n;
    const c1 = ((k + 1) * 2 * Math.PI) / n;
    const i0 = c0 + spread(half, r0), i1 = c1 - spread(half, r0);
    const o0 = c0 + spread(half, r1), o1 = c1 - spread(half, r1);
    const ai = (s: number): number => lerp(i0, i1, s);
    const ao = (s: number): number => lerp(o0, o1, s);
    const mid = (s: number): number => (ai(s) + ao(s)) / 2;
    const L = ((i1 - i0) * r0 + (o1 - o0) * r1) / 2;
    const M = Math.max(5, Math.round(L / (1.2 * T)));
    const plate = (s0: number, s1: number, y1: number, caps: readonly ('start' | 'end')[] = []): void => {
      hull.slab(r0, r1, ai(s0), ai(s1), ao(s0), ao(s1), FLOOR, y1, caps);
    };
    tears.push({ a: c0, side: 1 }, { a: c1, side: -1 });
    const wings = new Set<number>();
    const want = 1 + Math.floor(rnd() * 2);
    while (wings.size < want && M > 5) wings.add(2 + Math.floor(rnd() * (M - 4)));

    for (let j = 0; j < M; j++) {
      const s0 = j / M, s1 = (j + 1) / M;
      const torn = j === 0 || j === M - 1;
      const roll = rnd();
      const kind = torn ? 'torn' : roll < 0.16 ? 'gutted' : roll < 0.32 ? 'scorched' : 'intact';
      const base = rnd() < 0.18 ? PAINT.rust : pick(PAINT.plate);
      const top = HULL_TOP + range(-0.035, 0.035);
      if (kind === 'torn') {
        // Crumpled plating stepping down toward the cheek, burnt; the cheek face itself stays at the aperture line.
        const cheekAtStart = j === 0;
        const parts = 4;
        for (let q = 0; q < parts; q++) {
          const fromCheek = cheekAtStart ? q : parts - 1 - q;
          const y = lerp(FLOOR + 0.12 + rnd() * 0.06, top - 0.03, fromCheek / (parts - 1)) + range(-0.03, 0.03);
          hull.paint(fromCheek < 2 ? PAINT.scorch : base).set('look', fromCheek < 2 ? 0.9 : 0.5, 0, 0, 0);
          const a = s0 + ((s1 - s0) * q) / parts, b = s0 + ((s1 - s0) * (q + 1)) / parts;
          const caps: ('start' | 'end')[] = ['start', 'end'];
          plate(a, b, y, caps);
        }
        // Exposed frames: the ribs the plating tore away from, rising above the crumple, one bent.
        hull.paint(PAINT.girder).set('look', 0.3, 0, 0, 0);
        for (const f of [0.2, 0.55]) {
          const s = cheekAtStart ? s0 + (s1 - s0) * f : s1 - (s1 - s0) * f;
          const ri = r0 + 0.07 * T, ro = r1 - 0.07 * T;
          const a = mid(s);
          const lean = range(-0.12, 0.12);
          const hi = top + 0.12 + range(-0.05, 0.08);
          const pi = at(ri, a, hi), po = add(at(ro, a, hi - range(0, 0.1)), mul(radial(a), lean));
          hull.beam(at(ri, a, FLOOR + 0.05), pi, 0.035);
          hull.beam(at(ro, a, FLOOR + 0.05), po, 0.035);
          hull.beam(pi, po, 0.03);
        }
        // A girder snapped outward past the hull, at its aperture-side angle so it never enters the opening.
        const sa = cheekAtStart ? s0 + (s1 - s0) * 0.12 : s1 - (s1 - s0) * 0.12;
        const ga = ao(sa);
        hull.beam(at(r1 - 0.1 * T, ga, top - 0.02), at(r1 + range(0.35, 0.7) * T, ga, top + range(0.12, 0.3)), 0.03);
        tears[tears.length - (cheekAtStart ? 2 : 1)]!.a = mid(cheekAtStart ? s0 : s1);
      } else if (kind === 'gutted') {
        // Plating blown off: a burnt deck and the bare girders over it.
        hull.paint(PAINT.deck).set('look', 0.8, 0, 0, 0);
        plate(s0, s1, FLOOR + 0.17);
        hull.paint(PAINT.girder).set('look', 0.25, 0, 0, 0);
        for (const rr of [r0 + 0.08 * T, r1 - 0.08 * T]) {
          if (rnd() < 0.2) continue;
          hull.slab(rr - 0.03, rr + 0.03, ai(s0), ai(s1), ai(s0), ai(s1), top - 0.07, top, ['start', 'end']);
        }
        for (const f of [0.33, 0.66]) {
          const a = mid(lerp(s0, s1, f));
          hull.beam(at(r0 + 0.04 * T, a, top - 0.035), at(r1 - 0.04 * T, a, top - 0.035 - range(0, 0.08)), 0.03);
        }
      } else {
        hull.paint(kind === 'scorched' ? PAINT.scorch : base).set('look', kind === 'scorched' ? 0.75 : rnd() * 0.25, 0, 0, 0);
        plate(s0, s1, top);
        // Close-zoom dressing: vents and tanks on top, a conduit run along the outer edge.
        detail.paint(PAINT.greeble).set('look', 0.1, 0, 0, 0);
        const count = Math.floor(rnd() * 3);
        for (let q = 0; q < count; q++) {
          const a = mid(range(s0 + 0.1 * (s1 - s0), s1 - 0.1 * (s1 - s0)));
          const rr = range(r0 + 0.2 * T, r1 - 0.2 * T);
          const s = range(0.05, 0.12) * T;
          detail.box(at(rr, a, top + s * 0.5), [radial(a), UP, tangent(a)] as const, s * range(0.6, 1.2), s * 0.5, s * range(0.6, 1.4), NO_BOTTOM);
        }
        if (rnd() < 0.5) {
          const rr = r1 - 0.15 * T;
          detail.slab(rr - 0.025, rr + 0.025, mid(s0), mid(s1), mid(s0), mid(s1), top, top + 0.05);
        }
        // A light on the hull: a steady glow that drops out now and then.
        if (rnd() < 0.3) {
          const a = mid(range(s0, s1));
          hull.paint(pick(PAINT.light)).set('look', 0, 1, rnd(), 0);
          hull.box(at(r1 - 0.12 * T, a, top + 0.025), [radial(a), UP, tangent(a)] as const, 0.04, 0.025, 0.04, NO_BOTTOM);
        }
      }
      // Frame between modules: a darker rib proud of the plating.
      if (j > 0) {
        const s = s0;
        const da = (0.09 * T) / ((r0 + r1) / 2);
        hull.paint(PAINT.rib).set('look', 0.2, 0, 0, 0);
        hull.slab(r0 - 0.03 * T, r1 + 0.03 * T, ai(s) - da, ai(s) + da, ao(s) - da, ao(s) + da, FLOOR, Math.max(top, HULL_TOP) + RIB_RISE);
      }
      // Dead solar wings off the outer face, low, under the ships.
      if (wings.has(j)) solarWing(hull, rnd, ao(s0), r1, T);
      if (k === dishAt && j === Math.floor(M / 2)) dish(hull, rnd, mid((s0 + s1) / 2), (r0 + r1) / 2, T, top);
      if (k === mastAt && j === Math.floor(M / 3)) mast(hull, rnd, mid((s0 + s1) / 2), (r0 + r1) / 2, T, top);
    }
    yield;
  }

  // Cables torn loose at every breach: drooping down the cheek and trailing out into space, away from the opening.
  for (const { a, side } of tears) {
    const cables = 2 + Math.floor(rnd() * 2);
    for (let q = 0; q < cables; q++) {
      detail.paint(pick(PAINT.cable)).set('look', 0.1, 0, rnd(), 0);
      const pts: P[] = [];
      const start = range(r0 + 0.2 * T, r1 - 0.1 * T);
      const reach = range(0.8, 2.4) * T;
      const drift = side * range(0.02, 0.09);
      const yTop = HULL_TOP - range(0.02, 0.12);
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const r = t < 0.3 ? lerp(start, r1, t / 0.3) : r1 + (t - 0.3) / 0.7 * reach;
        const y = t < 0.3 ? lerp(yTop, -0.12, t / 0.3) : -0.12 - Math.sin(((t - 0.3) / 0.7) * Math.PI) * 0.08;
        pts.push(at(r, a + drift * t * t, y));
      }
      detail.cable(pts, 0.018, (t) => Math.max(0, t - 0.3));
    }
  }
  yield;

  // Inner ring: plated modules between heavy gate pylons; the pylons carry hazard caps and beacons.
  const ring = new Kit(PLATING);
  const q0 = g.ringInner, q1 = g.ringOuter;
  const Tr = q1 - q0;
  const gh = g.gateWidth / 2;
  for (let k = 0; k < g.gates; k++) {
    const c0 = (k * 2 * Math.PI) / g.gates;
    const c1 = ((k + 1) * 2 * Math.PI) / g.gates;
    const i0 = c0 + spread(gh, q0), i1 = c1 - spread(gh, q0);
    const o0 = c0 + spread(gh, q1), o1 = c1 - spread(gh, q1);
    const ai = (s: number): number => lerp(i0, i1, s);
    const ao = (s: number): number => lerp(o0, o1, s);
    const L = ((i1 - i0) * q0 + (o1 - o0) * q1) / 2;
    const sp = Math.min(0.2, (0.4 * g.gateWidth) / L);
    const M = Math.max(3, Math.round((L * (1 - 2 * sp)) / (1.4 * Tr)));
    for (const [a, b] of [[0, sp], [1 - sp, 1]] as const) {
      ring.paint(PAINT.pylon).set('look', 0.15, 0, 0, 0);
      ring.slab(q0, q1, ai(a), ai(b), ao(a), ao(b), FLOOR, PYLON_TOP);
      // hazard cap: alternating amber and black bands across the pylon top
      for (let z = 0; z < 4; z++) {
        ring.paint(z % 2 ? PAINT.hazardDark : PAINT.hazard).set('look', 0, 0, 0, 0);
        const ra = lerp(q0, q1, z / 4), rb = lerp(q0, q1, (z + 1) / 4);
        const t0 = (ra - q0) / Tr, t1 = (rb - q0) / Tr;
        ring.slab(ra, rb, lerp(ai(a), ao(a), t0), lerp(ai(b), ao(b), t0), lerp(ai(a), ao(a), t1), lerp(ai(b), ao(b), t1), PYLON_TOP, PYLON_TOP + 0.03);
      }
      const ba = (ai((a + b) / 2) + ao((a + b) / 2)) / 2;
      ring.paint(PAINT.light[2]).set('look', 0, 1, 0.9 + rnd() * 0.1, 0);
      ring.box(at((q0 + q1) / 2, ba, PYLON_TOP + 0.06), [radial(ba), UP, tangent(ba)] as const, 0.05, 0.03, 0.05, NO_BOTTOM);
    }
    for (let j = 0; j < M; j++) {
      const s0 = lerp(sp, 1 - sp, j / M), s1 = lerp(sp, 1 - sp, (j + 1) / M);
      const top = RING_TOP + range(-0.02, 0.02);
      ring.paint(rnd() < 0.15 ? PAINT.scorch : pick(PAINT.ring)).set('look', rnd() * 0.4, 0, 0, 0);
      ring.slab(q0, q1, ai(s0), ai(s1), ao(s0), ao(s1), FLOOR, top, []);
      if (j > 0) {
        const da = (0.08 * Tr) / ((q0 + q1) / 2);
        ring.paint(PAINT.ringRib).set('look', 0.1, 0, 0, 0);
        ring.slab(q0, q1, ai(s0) - da, ai(s0) + da, ao(s0) - da, ao(s0) + da, FLOOR, RING_TOP + 0.05);
      }
    }
  }
  yield;

  // Door leaves, shut: two chords per gate meeting on the axis, set as deep in the ring band as their reach allows;
  // open, each swings about the ruin centre into the ring wall beside its gate (a chord keeps its radii as it turns).
  const doors = new Kit({ swing: 1 });
  const reach = Math.sqrt(Math.max(0, q1 * q1 - (gh + 0.01) ** 2));
  const th = Math.min(0.5, Math.max(0.06, (reach - q0) * 0.85));
  const d = (q0 + reach) / 2;
  const swing = Math.asin(Math.min(1, (gh + 0.01) / (d - th / 2))) + 0.03;
  for (let k = 0; k < g.gates; k++) {
    const c = (k * 2 * Math.PI) / g.gates;
    const ea = radial(c), el = tangent(c);
    for (const side of [1, -1]) {
      doors.set('swing', side * swing);
      doors.paint(PAINT.door);
      const o = add(add(mul(ea, d), mul(el, (side * gh) / 2)), [0, (FLOOR + DOOR_TOP) / 2, 0]);
      doors.box(o, [ea, UP, el] as const, th / 2, (DOOR_TOP - FLOOR) / 2, gh / 2 + 0.01, NO_BOTTOM);
    }
  }

  const debris = new Kit({ dOrbit: 4, dSpin: 4 });
  const debrisDetail = new Kit({ dOrbit: 4, dSpin: 4 });
  yield* halo(g, rnd, debris, debrisDetail);

  // Vented gas: puffs streaming out of the tears and a few hull wounds.
  const wisps = new Kit({ wisp: 4, wispSize: 4 });
  const vent = (a: number, heading: number): void => {
    const seedV = rnd();
    for (let p = 0; p < 3; p++) {
      wisps.set('wisp', r1 * Math.cos(a), r1 * Math.sin(a), heading, (seedV + p / 3) % 1);
      wisps.set('wispSize', range(1.2, 2.2) * T, range(0.35, 0.6) * T, range(0.08, 0.14), 0);
      wisps.paint('#cfd8f0');
      wisps.quad([-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1]);
    }
  };
  for (const { a, side } of tears) vent(a, a + side * range(0.1, 0.4));
  for (let v = 0; v < Math.max(2, n / 2); v++) {
    const a = rnd() * Math.PI * 2;
    vent(a, a + range(-0.3, 0.3));
  }
  yield;
  return {
    hull: hull.geometry(), hullDetail: detail.geometry(), ring: ring.geometry(), doors: doors.geometry(),
    debris: debris.geometry(), debrisDetail: debrisDetail.geometry(), wisps: wisps.geometry(),
  };
}

/** A dead solar wing: a boom off the outer face carrying one or two panels, snapped, drooping or rolled. */
function solarWing(k: Kit, rnd: () => number, a: number, r1: number, T: number): void {
  const range = (lo: number, hi: number): number => lerp(lo, hi, rnd());
  const y = -0.12;
  const boom = range(0.35, 0.6) * T;
  const out = radial(a);
  k.paint(PAINT.solarFrame).set('look', 0.2, 0, 0, 0);
  k.beam(at(r1 - 0.05, a, y), at(r1 + boom, a, y), 0.035);
  const panels = 1 + Math.floor(rnd() * 2);
  let r = r1 + boom;
  for (let p = 0; p < panels; p++) {
    const len = range(0.6, 1.0) * T;
    const roll = range(-0.35, 0.35);
    const droop = range(0, 0.18);
    const snapped = rnd() < 0.3;
    const width = range(0.55, 0.8) * T * (snapped ? 0.55 : 1);
    const [u, , w] = frame(out);
    const tilt = turn(u, w, -droop);
    const fr = frame(tilt);
    const v = turn(fr[1], fr[0], roll), ww = turn(fr[2], fr[0], roll);
    const centre = add(at(r, a, y), mul(tilt, len / 2 + 0.04));
    const offset = snapped ? mul(ww, width * 0.45) : ([0, 0, 0] as P);
    k.paint(PAINT.solar).set('look', snapped ? 0.6 : 0.1, 0, 0, 0);
    k.box(add(centre, offset), [fr[0], v, ww] as const, len / 2, 0.012, width / 2);
    k.paint(PAINT.solarFrame).set('look', 0.2, 0, 0, 0);
    k.box(centre, [fr[0], v, ww] as const, len / 2, 0.02, 0.025);
    r += len + 0.08;
    if (snapped) break;
  }
}

/** The dead comm dish on its stub mast, knocked askew. */
function dish(k: Kit, rnd: () => number, a: number, r: number, T: number, top: number): void {
  const base = at(r, a, top);
  const h = 0.35 + rnd() * 0.15;
  k.paint(PAINT.girder).set('look', 0.2, 0, 0, 0);
  k.beam(base, add(base, [0, h, 0]), 0.05);
  const axis = unit(turn(turn(UP, tangent(a), 0.6 + rnd() * 0.5), UP, rnd() * Math.PI * 2));
  const rad = 0.42 * T;
  const centre = add(base, [0, h, 0]);
  const [, v, w] = frame(axis);
  const segs = 14;
  const missing = Math.floor(rnd() * segs);
  k.paint('#b9b2a6').set('look', 0.3, 0, 0, 0);
  for (let i = 0; i < segs; i++) {
    if (i === missing || i === (missing + 1) % segs) continue; // a bite torn out of the rim
    const e0 = (i / segs) * Math.PI * 2, e1 = ((i + 1) / segs) * Math.PI * 2;
    const rim = (e: number): P => add(add(centre, mul(axis, rad * 0.35)), add(mul(v, Math.cos(e) * rad), mul(w, Math.sin(e) * rad)));
    // both windings: the dish is a shell seen from either side
    k.tri(centre, rim(e1), rim(e0));
    k.tri(centre, rim(e0), rim(e1));
  }
  k.paint(PAINT.girder);
  k.beam(centre, add(centre, mul(axis, rad * 0.9)), 0.02);
  k.paint(PAINT.light[0]).set('look', 0, 1, 0.5 + rnd() * 0.3, 0);
  k.box(add(centre, mul(axis, rad * 0.95)), frame(axis), 0.04, 0.04, 0.04);
}

/** A lattice antenna mast leaning off the hull, crossbars missing. */
function mast(k: Kit, rnd: () => number, a: number, r: number, T: number, top: number): void {
  const lean = unit(add(UP, add(mul(radial(a), 0.25 + rnd() * 0.2), mul(tangent(a), (rnd() - 0.5) * 0.3))));
  const h = 0.9 + 0.3 * T;
  const base = at(r, a, top);
  const [, v, w] = frame(lean, radial(a));
  const s = 0.07;
  k.paint(PAINT.girder).set('look', 0.3, 0, 0, 0);
  const legs = [add(mul(v, s), mul(w, s)), add(mul(v, -s), mul(w, s)), add(mul(v, -s), mul(w, -s)), add(mul(v, s), mul(w, -s))];
  for (const l of legs) k.beam(add(base, l), add(add(base, l), mul(lean, h)), 0.012);
  for (let i = 1; i < 6; i++) {
    if (rnd() < 0.35) continue;
    const p = add(base, mul(lean, (h * i) / 6));
    k.beam(add(p, legs[i % 4]!), add(p, legs[(i + 1) % 4]!), 0.01);
  }
  k.paint(PAINT.light[2]).set('look', 0, 1, 0.92, 0);
  k.box(add(base, mul(lean, h + 0.03)), frame(lean), 0.035, 0.035, 0.035);
}

/**
 * The debris halo: pieces orbiting the ruin centre at layered altitudes (under the ships, just over the hull, a high
 * thin halo) at their own slow rates, each tumbling about its own axis; breach clouds hover outside every breach.
 * Nothing enters the chamber (the core and its gates stay clear) and the orbit radii stay near the hull band, low
 * where they reach the solar arrays' circle outside it.
 */
function* halo(g: DerelictGeometry, rnd: () => number, big: Kit, small: Kit): Generator<void, void> {
  const range = (lo: number, hi: number): number => lerp(lo, hi, rnd());
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const r0 = g.hullInner, r1 = g.hullOuter, T = r1 - r0;
  const count = Math.round(Math.min(110, Math.max(40, r1 * 4)));
  const piece = (kit: Kit, size: number, r: number, y: number, w: number): void => {
    const axis = unit([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
    const rate = range(0.12, 0.8);
    kit.set('dOrbit', r, rnd() * Math.PI * 2, w, y);
    kit.set('dSpin', axis[0] * rate, axis[1] * rate, axis[2] * rate, rnd());
    kit.paint(pick(PAINT.debris));
    shape(kit, rnd, size);
  };
  const speed = (): number => (rnd() < 0.85 ? 1 : -1) * range(0.004, 0.022);
  for (let i = 0; i < count; i++) {
    const layer = rnd();
    if (layer < 0.45) piece(big, range(0.25, 0.6) * T, range(r1 + 0.4 * T, r1 + 2.6 * T), range(-0.26, -0.12), speed());
    else if (layer < 0.78) piece(big, range(0.2, 0.45) * T, range(r0 - 0.15 * T, r1 + 0.35 * T), range(HULL_TOP + 0.18, HULL_TOP + 0.5), speed());
    else piece(big, range(0.2, 0.5) * T, range(r0 - 0.4 * T, r1 + 1.4 * T), range(DEBRIS_HIGH + 0.1, DEBRIS_HIGH + 1.4), speed());
  }
  yield;
  for (let i = 0; i < count * 2; i++) {
    const layer = rnd();
    const y = layer < 0.6 ? range(-0.27, -0.1) : layer < 0.85 ? range(HULL_TOP + 0.12, HULL_TOP + 0.45) : range(DEBRIS_HIGH + 0.05, DEBRIS_HIGH + 1.2);
    piece(small, range(0.06, 0.16) * T, range(r0 - 0.3 * T, r1 + 2.2 * T), y, speed());
    if (i % 40 === 39) yield;
  }
  yield;
  // Breach clouds: tight clusters hanging outside each breach mouth, under the ships, barely drifting.
  for (let k = 0; k < g.breaches; k++) {
    const c = (k * 2 * Math.PI) / g.breaches;
    const centreR = r1 + range(0.9, 1.6) * T;
    for (let i = 0; i < 9; i++) {
      const r = centreR + range(-0.5, 0.5) * T;
      const a = c + range(-0.9, 0.9) * (g.breachWidth / 2 + T) / r;
      small.set('dOrbit', r, a, range(-0.002, 0.002), range(-0.27, -0.12));
      const axis = unit([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
      const rate = range(0.2, 0.9);
      small.set('dSpin', axis[0] * rate, axis[1] * rate, axis[2] * rate, rnd());
      small.paint(pick(PAINT.debris));
      shape(small, rnd, range(0.05, 0.14) * T);
    }
  }
}

/** One debris piece centred on the origin, longest extent about `size`: a bent plate, an I-beam or a rock-like lump. */
function shape(k: Kit, rnd: () => number, size: number): void {
  const range = (lo: number, hi: number): number => lerp(lo, hi, rnd());
  const pick = rnd();
  if (pick < 0.4) {
    // torn hull plate with a folded flap
    const hu = size / 2, hw = size * range(0.25, 0.45);
    const th = Math.max(0.012, size * 0.04);
    const flat: [P, P, P] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    k.box([-hu * 0.25, 0, 0], flat, hu * 0.75, th, hw);
    const fold = range(0.4, 1.1);
    const u = turn([1, 0, 0], [0, 0, 1], fold);
    const v = turn([0, 1, 0], [0, 0, 1], fold);
    const len = hu * 0.25;
    k.box(add([hu * 0.5, 0, 0], mul(u, len)), [u, v, [0, 0, 1]], len, th, hw * range(0.6, 1));
  } else if (pick < 0.7) {
    // I-beam stub: two flanges and a web
    const hu = size / 2, f = size * 0.09, t = Math.max(0.01, size * 0.025);
    const flat: [P, P, P] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    k.box([0, f, 0], flat, hu, t, f);
    k.box([0, -f, 0], flat, hu, t, f);
    k.box([0, 0, 0], flat, hu, f, t);
  } else {
    // lump of wreckage: a jittered box
    const h = size / 2;
    const c: P[] = [];
    for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      c.push([(x ? h : -h) * range(0.55, 1), (y ? h : -h) * range(0.4, 0.8), (z ? h : -h) * range(0.55, 1)]);
    }
    k.hexa(c);
  }
}
