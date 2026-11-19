import { describe, expect, it } from 'vitest';
import { BufferGeometry, Mesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { axisLateral, derelictPeriod, fold, folded, type DerelictGeometry } from '@agent-command/game/contract';
import { Kit, ruinArt, type RuinArt } from '../src/world/derelict-art.ts';
import { DerelictRuin } from '../src/world/derelict.ts';

/** Run the sliced build to completion in one go. */
function buildRuinArt(g: DerelictGeometry, seed: number): RuinArt {
  const steps = ruinArt(g, seed);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

function ruinOf(size: number, slots = 2): { g: DerelictGeometry; seed: number } {
  const view = createGame({ seed: 7, options: { map: { params: { size, slots } } } }).view('nw');
  return { g: view.match!.derelict!, seed: view.match!.mapSeed };
}

/** Distance of local point (x, z) from the nearest of `n` aperture axes (the sim's lateral test). */
function lateral(n: number, x: number, z: number): number {
  fold(x, z);
  return axisLateral(n, folded.x, folded.y);
}

function points(geo: BufferGeometry, name = 'position'): Float32Array {
  return geo.getAttribute(name).array as Float32Array;
}

const CASES = [[48, 2], [64, 2], [80, 2], [48, 4]] as const;

describe.each(CASES)('derelict art on a %s-tile, %s-slot map', (size, slots) => {
  const { g, seed } = ruinOf(size, slots);
  const art = buildRuinArt(g, seed);
  const T = g.hullOuter - g.hullInner;
  /** Beam half-widths and float slack: nothing solid reaches further into an aperture. */
  const SLACK = 0.05;

  it('stands hull plating only where the sim has hull wall, never in a breach', () => {
    const p = points(art.hull);
    let inBand = 0;
    let nearest = Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i]!, p[i + 2]!);
      if (r > g.hullOuter + 0.05 * T || r < g.hullInner - 0.05 * T) continue;
      inBand++;
      nearest = Math.min(nearest, lateral(g.breaches, p[i]!, p[i + 2]!));
    }
    expect(inBand).toBeGreaterThan(1000);
    expect(nearest).toBeGreaterThan(g.breachWidth / 2 - SLACK);
  });

  it('closes the hull band all round between the breaches (no gap where the sim is solid)', () => {
    // Every bearing whose mid-hull point is wall in the sim has plating there (some top face covers its angle).
    const p = points(art.hull);
    const n = points(art.hull, 'normal');
    const BINS = 3600;
    const TAU = 2 * Math.PI;
    const bin = (a: number): number => Math.floor((((a % TAU) + TAU) % TAU) / TAU * BINS) % BINS;
    const covered = new Uint8Array(BINS);
    for (let i = 0; i < p.length; i += 9) {
      if (n[i + 1]! < 0.99) continue; // tops only
      const as = [0, 3, 6].map((o) => Math.atan2(p[i + o + 2]!, p[i + o]!));
      const rs = [0, 3, 6].map((o) => Math.hypot(p[i + o]!, p[i + o + 2]!));
      if (Math.min(...rs) > (g.hullInner + g.hullOuter) / 2 || Math.max(...rs) < (g.hullInner + g.hullOuter) / 2) continue;
      const lo = Math.min(...as), hi = Math.max(...as);
      // a triangle straddling the ±π seam covers hi … lo + 2π
      const [from, to] = hi - lo > Math.PI ? [bin(hi), bin(lo)] : [bin(lo), bin(hi)];
      for (let b = from; ; b = (b + 1) % BINS) {
        covered[b] = 1;
        if (b === to) break;
      }
    }
    const mid = (g.hullInner + g.hullOuter) / 2;
    const gaps: number[] = [];
    for (let b = 0; b < BINS; b++) {
      const a = ((b + 0.5) / BINS) * TAU;
      if (lateral(g.breaches, mid * Math.cos(a), mid * Math.sin(a)) > g.breachWidth / 2 + 2 * SLACK && !covered[b]) gaps.push(a);
    }
    expect(gaps).toEqual([]);
  });

  it('keeps the ring out of its gates; shut leaves fill them, open leaves retract into the wall', () => {
    const p = points(art.ring);
    let nearest = Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i]!, p[i + 2]!);
      if (r > g.ringOuter + 0.01 || r < g.ringInner - 0.01) continue;
      nearest = Math.min(nearest, lateral(g.gates, p[i]!, p[i + 2]!));
    }
    expect(nearest).toBeGreaterThan(g.gateWidth / 2 - 1e-6);
    const d = points(art.doors);
    const s = points(art.doors, 'swing');
    let shutMax = 0, openMin = Infinity, rMin = Infinity, rMax = 0;
    for (let v = 0; v < d.length / 3; v++) {
      const x = d[v * 3]!, z = d[v * 3 + 2]!, b = s[v]!;
      shutMax = Math.max(shutMax, lateral(g.gates, x, z));
      openMin = Math.min(openMin, lateral(g.gates, x * Math.cos(b) - z * Math.sin(b), x * Math.sin(b) + z * Math.cos(b)));
      rMin = Math.min(rMin, Math.hypot(x, z));
      rMax = Math.max(rMax, Math.hypot(x, z));
    }
    expect(shutMax).toBeCloseTo(g.gateWidth / 2 + 0.01, 3);
    expect(openMin).toBeGreaterThan(g.gateWidth / 2);
    expect(rMin).toBeGreaterThan(g.ringInner);
    expect(rMax).toBeLessThan(g.ringOuter);
  });

  it('keeps every debris piece out of the chamber, the core and its gates', () => {
    for (const geo of [art.debris, art.debrisDetail]) {
      const p = points(geo);
      const o = points(geo, 'dOrbit');
      let clearance = Infinity;
      for (let v = 0; v < p.length / 3; v++) clearance = Math.min(clearance, o[v * 4]! - Math.hypot(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!));
      expect(clearance).toBeGreaterThan(g.ringOuter);
    }
  });
});

describe('derelict art', () => {
  it('is a pure function of the ruin and the public map seed', () => {
    const { g, seed } = ruinOf(48);
    const a = buildRuinArt(g, seed), b = buildRuinArt(g, seed), c = buildRuinArt(g, seed + 1);
    for (const key of ['hull', 'hullDetail', 'ring', 'doors', 'debris', 'debrisDetail', 'wisps'] as const) {
      expect(points(a[key])).toEqual(points(b[key]));
    }
    expect(points(a.debris)).not.toEqual(points(c.debris));
  });

  it('winds every box face outward (flat normals feed the cel ramp and the ink pass)', () => {
    const k = new Kit({});
    k.box([1, 2, 3], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], 0.5, 0.3, 0.2);
    const geo = k.geometry();
    const p = points(geo), n = points(geo, 'normal');
    for (let i = 0; i < p.length; i += 9) {
      const c = [0, 1, 2].map((a) => (p[i + a]! + p[i + 3 + a]! + p[i + 6 + a]!) / 3 - [1, 2, 3][a]!);
      expect(c[0]! * n[i]! + c[1]! * n[i + 1]! + c[2]! * n[i + 2]!).toBeGreaterThan(0);
    }
  });
});

describe('derelict ruin frames', () => {
  it('builds in slices, turns the ring, swings the doors and swaps close dressing by zoom without rebuilding', async () => {
    const { g, seed } = ruinOf(48);
    const ruin = new DerelictRuin(48);
    expect(ruin.shaderTemplates).toHaveLength(0);
    ruin.set(g, seed);
    expect(ruin.group.visible).toBe(false);
    await ruin.ready();
    expect(ruin.group.visible).toBe(true);
    const meshes: Mesh[] = [];
    ruin.group.traverse((o) => { if (o instanceof Mesh) meshes.push(o); });
    const geometries = meshes.map((m) => m.geometry);
    ruin.frame(1, 1);
    for (const m of ruin.shaderTemplates) expect(m.visible).toBe(true);
    ruin.frame(1, 1e4);
    for (const m of ruin.shaderTemplates) expect(m.visible).toBe(false);
    const sealed = g.open + g.turn + 1;
    ruin.frame(sealed, 30);
    const ring = meshes.find((m) => m.geometry.getAttribute('swing'))!.parent!;
    expect(ring.rotation.y).toBeCloseTo(-Math.PI / g.gates, 6);
    ruin.frame(derelictPeriod(g) + g.open / 2, 30);
    expect(ring.rotation.y).toBeCloseTo(0, 6);
    ruin.set({ ...g }, seed);
    await ruin.ready();
    expect(meshes.every((m, i) => m.geometry === geometries[i])).toBe(true);
    ruin.set(undefined);
    expect(ruin.group.visible).toBe(false);
  });
});
