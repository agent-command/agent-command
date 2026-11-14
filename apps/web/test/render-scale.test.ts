import { describe, expect, it } from 'vitest';
import { createGame } from '@agent-command/game';
import { KINDS, STATS, footprint, isStatKind, type Entity, type Kind, type Plane, type StatKind } from '@agent-command/game/contract';
import { Entities, buildRecord, orbitMuzzle } from '../src/world/entities.ts';
import { wx, wz } from '../src/world/common.ts';
import { AIR_SCALE, PART, UNIT_SCALE, footprintModelScale, model } from '../src/world/models.ts';
import { CONSTRUCTION_BASE, REC, STRIDE, unitZoomScale } from '../src/world/rig.ts';

interface Draw { data: Float32Array; geo: { instanceCount: number }; footprintScale: number }
const game = createGame({ seed: 11 });
const view = game.view('nw');
const size = game.sim.size;
const selected = new Set<string>();

/** Every kind the renderer draws through its own instanced record (Spire and neutral objects are sized on their own). */
const DRAWN = KINDS.filter((kind): kind is Exclude<StatKind, 'spire'> => kind !== 'spire' && isStatKind(kind));
type Drawn = (typeof DRAWN)[number];
function planeOf(kind: Drawn): Plane {
  return STATS[kind].plane as Plane;
}
function registryScale(kind: Drawn, zoom: number): number {
  if (footprint(kind)) return footprintModelScale(kind, model(kind)) * (kind === 'gun_platform' ? unitZoomScale(zoom) : 1);
  const air = planeOf(kind) === 'sky' || planeOf(kind) === 'orbit';
  return UNIT_SCALE * unitZoomScale(zoom) * (air ? AIR_SCALE : 1);
}
function record(units: Entities, kind: Kind, i = 0): Float32Array {
  // Test seam: the per-kind instanced draws are private; their records are what the GPU draws.
  const kinds = (units as unknown as { kinds: Map<Kind, Draw> }).kinds;
  const draw = kinds.get(kind)!;
  expect(draw.geo.instanceCount).toBeGreaterThan(i);
  return draw.data.subarray(i * STRIDE, (i + 1) * STRIDE);
}

describe('steady render scale', () => {
  for (const zoom of [14, 40, 78]) {
    it(`draws every kind at its registry scale and full height once steady (zoom ${zoom})`, () => {
      const units = new Entities(false, undefined, size);
      const entities: Entity[] = DRAWN.map((kind, i) => ({
        id: `e_${500 + i}`, kind, side: 'nw', plane: planeOf(kind), x: 4 + (i % 8) * 4, y: 4 + Math.floor(i / 8) * 4, hp: 100, maxHp: 100, state: 'idle',
      }));
      units.ingest({ ...view, tick: 0, entities }, 1000);
      for (let f = 0; f < 4; f++) units.frame(1000 + f * 50, 1 + f * 0.05, selected, undefined, 'nw', 'surface', zoom);
      for (const kind of DRAWN) {
        const rec = record(units, kind);
        expect(rec[REC.scale], kind).toBeCloseTo(registryScale(kind, zoom), 4);
        expect(rec[REC.build], kind).toBe(1);
      }
    });
  }

  it('keeps a digger full size while it constructs a Headframe; only structures grow in', () => {
    const builder: Entity = { id: 'e_100', kind: 'digger', side: 'nw', plane: 'depths', x: 12.5, y: 12.5, hp: 80, maxHp: 80, state: 'constructing', progress: 0.1 };
    const site: Entity = { id: 'e_101', kind: 'headframe', side: 'nw', plane: 'surface', x: 12.5, y: 12.5, hp: 50, maxHp: 500, state: 'constructing', progress: 0.1 };
    expect(buildRecord(builder)).toBe(1);
    expect(buildRecord(site)).toBeCloseTo(CONSTRUCTION_BASE + 0.1, 5);
    const units = new Entities(false, undefined, size);
    units.ingest({ ...view, tick: 0, entities: [builder, site] }, 1000);
    units.frame(1000, 1, selected, undefined, 'nw', 'depths', 30);
    expect(record(units, 'digger')[REC.build]).toBe(1);
    expect(record(units, 'digger')[REC.scale]).toBeCloseTo(registryScale('digger', 30), 4);
    expect(record(units, 'headframe')[REC.build]).toBeCloseTo(CONSTRUCTION_BASE + 0.1, 5);
    // After construction the builder is idle again and still full size.
    units.ingest({ ...view, tick: 1, entities: [{ ...builder, state: 'idle', progress: undefined }, { ...site, state: 'active', progress: undefined }] }, 1050);
    units.frame(1100, 1.1, selected, undefined, 'nw', 'depths', 30);
    expect(record(units, 'digger')[REC.build]).toBe(1);
    expect(record(units, 'headframe')[REC.build]).toBe(1);
  });
});

describe('armed structures', () => {
  it('scale head and base as one rigid whole at every zoom, like every other structure', () => {
    // Regression: the turret head and barrel used to grow with zoom about the mount pivot while the plinth kept its
    // footprint, so zooming out sank the base under an ever larger head. The muzzle is the CPU mirror of the rig.
    const units = new Entities(false, undefined, size);
    const turret: Entity = { id: 'e_300', kind: 'turret', side: 'nw', plane: 'surface', x: 10.5, y: 10.5, hp: 400, maxHp: 400, state: 'idle', heading: 0 };
    units.ingest({ ...view, tick: 0, entities: [turret] }, 1000);
    const out = new Float64Array(3);
    const base = footprintModelScale('turret', model('turret'));
    const reach = (zoom: number) => {
      units.frame(1000, 1, selected, undefined, 'nw', 'surface', zoom);
      expect(record(units, 'turret')[REC.scale]).toBeCloseTo(base, 6);
      orbitMuzzle(out, units.tracks.get('e_300')!, 0, 1000, size);
      return Math.hypot(out[0]! - wx(turret.x, size), out[2]! - wz(turret.y, size));
    };
    const near = reach(14);
    for (const zoom of [40, 78]) expect(reach(zoom), `zoom ${zoom}`).toBeCloseTo(near, 6);
    // The barrel tip stays inside the footprint the plinth is fitted to.
    expect(near).toBeLessThanOrEqual(footprint('turret')!.w / 2 * Math.SQRT2);
  });

  it('gives the turret a gun house about a tank turret\'s size on a plinth clearly wider than it', () => {
    // Regression: fitted with its barrel inside the cell, the turret drew a head about half a near-zoom tank turret's.
    const span = (kind: Kind, part: number) => {
      const p = model(kind).getAttribute('position'), parts = model(kind).getAttribute('part');
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < p.count; i++) if (parts.getX(i) === part) { lo = Math.min(lo, p.getX(i)); hi = Math.max(hi, p.getX(i)); }
      return hi - lo;
    };
    const head = span('turret', PART.top) * footprintModelScale('turret', model('turret'));
    const tank = span('tank', PART.top) * registryScale('tank', 14);
    expect(head / tank).toBeGreaterThan(0.75);
    expect(head / tank).toBeLessThan(1.25);
    // the plinth fills the cell: it stays clearly wider than the head at every zoom (one rigid scale)
    expect(footprint('turret')!.w / head).toBeGreaterThan(1.4);
  });
});
