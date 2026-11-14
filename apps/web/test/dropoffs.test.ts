import { afterEach, describe, expect, it } from 'vitest';
import { type BufferGeometry, Color, InstancedBufferGeometry, Mesh, type InterleavedBufferAttribute } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { CELL, type Entity, type Fx } from '@agent-command/game/contract';
import { delivered, dropoffKind, landingKind, receivesDelivery, stepHaul } from '../src/world/dropoffs.ts';
import { Entities } from '../src/world/entities.ts';
import { fadeValue, focusValue } from '../src/world/fade.ts';
import { depthsDropoffModel, oreHeapModel, PART } from '../src/world/models.ts';
import { ORE_HEAP_PAINT, UNIT_PAINT } from '../src/world/palette.ts';

const headframe: Entity = { id: 'e_100', kind: 'headframe', plane: 'surface', side: 'nw', x: 14.5, y: 14.5, hp: 100, maxHp: 100, state: 'active' };
const delivery: Fx = { tick: 1, kind: 'deliver', plane: 'depths', side: 'nw', x: 14.2, y: 14.7, subject: 'digger' };
const selected = new Set<string>();
const previousFade = { ...fadeValue }, previousFocus = { ...focusValue };
afterEach(() => { Object.assign(fadeValue, previousFade); Object.assign(focusValue, previousFocus); });
const landing = (units: Entities, kind = 'headframe', memory = false) => units.root.getObjectByName(`depths-dropoff-${memory ? 'memory-' : ''}${kind}`) as Mesh<InstancedBufferGeometry>;

describe('Depths drop-off counterparts', () => {
  it('uses the instanced kit within the structure budget, with tagged moving skips', () => {
    for (const kind of ['headframe', 'shaft', 'spire'] as const) {
      const geometry = depthsDropoffModel(kind);
      expect(geometry).toBe(depthsDropoffModel(kind));
      expect(geometry.getAttribute('position').count / 3).toBeLessThanOrEqual(320);
      if (kind !== 'spire') expect(new Set(geometry.getAttribute('part').array).has(PART.cargo)).toBe(true);
    }
  });

  it('maps only Surface portals and the existing Depths root, not holes, lodes or other planes', () => {
    expect(dropoffKind(headframe)).toBe('headframe');
    expect(dropoffKind({ kind: 'shaft', plane: 'surface' })).toBe('shaft');
    expect(dropoffKind({ kind: 'spire', plane: 'depths' })).toBe('spire');
    expect(dropoffKind({ kind: 'spire', plane: 'surface' })).toBeUndefined();
    expect(dropoffKind({ kind: 'turret', plane: 'surface' })).toBeUndefined();
    expect(receivesDelivery(headframe, delivery)).toBe(true);
    expect(receivesDelivery(headframe, { ...delivery, side: 'se' })).toBe(false);
    expect(receivesDelivery(headframe, { ...delivery, x: 15.2 })).toBe(false);
    expect(receivesDelivery({ ...headframe, state: 'constructing' }, delivery)).toBe(false);
  });

  it('draws own and observed counterparts with Surface hidden, and only pencil instances for remembered enemies', () => {
    const game = createGame({ seed: 11 });
    const view = game.view('nw');
    const units = new Entities(false, undefined, 48);
    fadeValue.depths = focusValue.depths = 1;
    fadeValue.surface = 0;
    const enemy: Entity = { ...headframe, id: 'e_101', side: 'se', x: 17.5 };
    view.depths[Math.floor(enemy.y) * game.sim.size + Math.floor(enemy.x)] = CELL.tunnel;
    units.ingest({ ...view, entities: [headframe, enemy], memory: [] }, 1000);
    units.frame(1000, 1, selected, undefined, 'nw', 'depths', 30);
    expect(landing(units).geometry.instanceCount).toBe(2);
    units.ingest({ ...view, tick: 1, entities: [headframe], memory: [{ id: enemy.id, kind: enemy.kind, side: enemy.side, plane: enemy.plane, x: enemy.x, y: enemy.y, seen: 0 }] }, 1050);
    units.frame(1050, 1.05, selected, undefined, 'nw', 'depths', 30);
    expect(landing(units).geometry.instanceCount).toBe(1);
    const ghost = landing(units, 'headframe', true);
    expect(ghost.geometry.instanceCount).toBe(1);
    const drive = ghost.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    expect(drive.getY(0)).toBe(0);
    expect(drive.getW(0)).toBe(0);
    const version = drive.data.version;
    units.frame(1100, 1.1, selected, undefined, 'nw', 'depths', 30);
    expect(drive.data.version).toBe(version);
    units.ingest({ ...view, tick: 2, entities: [], memory: [] }, 1100);
    units.frame(1150, 1.15, selected, undefined, 'nw', 'depths', 30);
    expect(landing(units).geometry.instanceCount).toBe(0);
    expect(ghost.geometry.instanceCount).toBe(0);
    expect(landing(units, 'spire').geometry.instanceCount).toBe(0);
  });

  it('keeps the root landed while its segment produces a unit; only unfinished portals have none', () => {
    expect(landingKind({ kind: 'spire', plane: 'depths', state: 'constructing' })).toBe('spire');
    expect(landingKind({ kind: 'headframe', plane: 'surface', state: 'constructing' })).toBeUndefined();
    expect(landingKind({ kind: 'shaft', plane: 'surface' })).toBe('shaft');
    // The sim reports a producing segment as `constructing`: the real root, mid-build of a Digger.
    const game = createGame({ seed: 11 });
    expect(game.apply({ team: 'nw', role: 'depths' }, { kind: 'queue_add', item: 'digger' })).toEqual({ ok: true });
    for (let i = 0; i < 5; i++) game.step();
    const view = game.view('nw');
    const root = view.entities.find((e) => e.kind === 'spire' && e.plane === 'depths' && e.side === 'nw')!;
    expect(root.state).toBe('constructing');
    expect(receivesDelivery(root, { ...delivery, x: root.x, y: root.y })).toBe(true);
    const enemy: Entity = { ...root, id: 'e_102', side: 'se', x: 39, y: 39 };
    view.depths[Math.floor(enemy.y) * game.sim.size + Math.floor(enemy.x)] = CELL.tunnel;
    const units = new Entities(false, undefined, 48);
    fadeValue.depths = focusValue.depths = 1;
    units.ingest({ ...view, entities: [root, enemy, { ...headframe, state: 'constructing' }] }, 1000);
    units.frame(1000, 1, selected, undefined, 'nw', 'depths', 30);
    expect(landing(units, 'spire').geometry.instanceCount).toBe(2);
    expect(landing(units, 'spire').visible).toBe(true);
    expect(landing(units).geometry.instanceCount).toBe(0);
  });

  for (const army of ['nw', 'se'] as const) for (const kind of ['headframe', 'shaft'] as const) {
    it(`requires underground knowledge for hostile ${kind} landings in ${army}'s live and remembered views`, () => {
      const game = createGame({ seed: 11 });
      const view = game.view(army);
      view.depths.fill(CELL.unknown);
      view.vision.depths.fill(0); // Known-but-unseen cells must still support remembered landings.
      view.vision.surface.fill(1073741823);
      const own: Entity = { ...headframe, kind, side: army };
      const enemy: Entity = { ...headframe, kind, id: 'e_101', side: army === 'nw' ? 'se' : 'nw', x: 17.5 };
      const memory = [{ id: enemy.id, kind: enemy.kind, side: enemy.side, plane: enemy.plane, x: enemy.x, y: enemy.y, seen: 0 }];
      const units = new Entities(false, undefined, 48);
      fadeValue.depths = focusValue.depths = 1;
      const draw = (tick: number, remembered: boolean): void => {
        units.ingest({ ...view, tick, entities: remembered ? [own] : [own, enemy], memory: remembered ? memory : [] }, 1000 + tick * 50);
        units.frame(1000 + tick * 50, 1 + tick * 0.05, selected, undefined, army, 'depths', 30);
      };
      draw(0, false);
      expect(landing(units, kind).geometry.instanceCount).toBe(1); // Own landing ignores underground fog.
      draw(1, true);
      expect(landing(units, kind).geometry.instanceCount).toBe(1);
      expect(landing(units, kind, true).geometry.instanceCount).toBe(0);
      view.depths[Math.floor(enemy.y) * game.sim.size + Math.floor(enemy.x)] = CELL.tunnel;
      draw(2, false);
      expect(landing(units, kind).geometry.instanceCount).toBe(2);
      draw(3, true);
      expect(landing(units, kind).geometry.instanceCount).toBe(1);
      const ghost = landing(units, kind, true);
      expect(ghost.geometry.instanceCount).toBe(1);
      expect((ghost.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute).getY(0)).toBe(0);
    });
  }

  it('deduplicates fogged delivery FX and keeps an active-but-idle Headframe still', () => {
    const view = createGame({ seed: 11 }).view('nw');
    const units = new Entities(false, undefined, 48);
    units.ingest({ ...view, tick: 0, entities: [headframe], fx: [] }, 1000);
    units.frame(1000, 1, selected, undefined, 'nw', 'depths', 30);
    expect(units.tracks.get(headframe.id)!.haul!.phase).toBe(0);
    units.ingest({ ...view, tick: 1, entities: [headframe], fx: [delivery] }, 1050);
    expect(units.tracks.get(headframe.id)!.haul!.pressure).toBe(1);
    units.ingest({ ...view, tick: 2, entities: [headframe], fx: [delivery] }, 1100);
    expect(units.tracks.get(headframe.id)!.haul!.pressure).toBe(1);
    units.ingest({ ...view, tick: 3, entities: [headframe], fx: [{ ...delivery, tick: 3 }, { ...delivery, tick: 3 }] }, 1150);
    expect(units.tracks.get(headframe.id)!.haul!.pressure).toBe(3);
  });

  it('increases throughput with arrivals, slows reduced motion twelve-fold, and parks after the last trip', () => {
    const idle = { pressure: 0, phase: 0, until: 0 };
    expect(stepHaul(idle, 1000, 1, false)).toBe(0);
    const regular = { ...idle }, busy = { ...idle }, reduced = { ...idle };
    delivered(regular, 1000); delivered(reduced, 1000);
    for (let i = 0; i < 4; i++) delivered(busy, 1000);
    stepHaul(regular, 1100, 0.1, false);
    stepHaul(busy, 1100, 0.1, false);
    stepHaul(reduced, 1100, 0.1, true);
    expect(busy.phase).toBeGreaterThan(regular.phase);
    expect(reduced.phase).toBeCloseTo(regular.phase * 0.08);
    for (let i = 0; i < 40; i++) stepHaul(regular, 7000 + i * 100, 0.1, false);
    expect(regular.phase).toBe(0);
    expect(regular.pressure).toBe(0);
  });
});

/** Vertices of `geometry` painted `hex`, as [x, y, z] (paint is baked per vertex by the model kit). */
function painted(geometry: BufferGeometry, hex: string, part?: number): number[][] {
  const c = new Color(hex);
  const pos = geometry.getAttribute('position'), paint = geometry.getAttribute('paint'), tag = geometry.getAttribute('part');
  const out: number[][] = [];
  for (let i = 0; i < pos.count; i++) {
    if (part !== undefined && tag && tag.getX(i) !== part) continue;
    if (Math.abs(paint.getX(i) - c.r) + Math.abs(paint.getY(i) - c.g) + Math.abs(paint.getZ(i) - c.b) < 1e-4) out.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
  }
  return out;
}
const extent = (pts: number[][], axis: number) => Math.max(...pts.map(p => p[axis]!)) - Math.min(...pts.map(p => p[axis]!));

describe('stored and dropped ore', () => {
  // Regression: a landing kept its ore in an iron hopper box under one teal crystal, the digger's own silhouette.
  it('heaps landing ore loose on the floor, never in an iron hopper', () => {
    for (const kind of ['headframe', 'shaft', 'spire'] as const) {
      const geometry = depthsDropoffModel(kind);
      const rubble = painted(geometry, ORE_HEAP_PAINT.rubble);
      expect(rubble.length, kind).toBeGreaterThan(0);
      const lo = [Math.min(...rubble.map(p => p[0]!)), Math.min(...rubble.map(p => p[2]!))];
      const hi = [Math.max(...rubble.map(p => p[0]!)), Math.max(...rubble.map(p => p[2]!))];
      // Static (non-cargo) iron directly under the heap would be a hopper; the band and cable stand clear of it.
      const under = painted(geometry, UNIT_PAINT.iron, PART.body).filter(([x, y, z]) => x! > lo[0]! && x! < hi[0]! && z! > lo[1]! && z! < hi[1]! && y! > 0.1);
      expect(under, kind).toEqual([]);
    }
  });

  it('draws a cache as a wide, team-neutral mineral heap with no unit paint', () => {
    const geometry = oreHeapModel();
    const pos = geometry.getAttribute('position');
    const all = Array.from({ length: pos.count }, (_, i) => [pos.getX(i), Math.max(0, pos.getY(i)), pos.getZ(i)]);
    expect(Math.min(extent(all, 0), extent(all, 2))).toBeGreaterThan(1.6 * extent(all, 1));
    const minerals = Object.values(ORE_HEAP_PAINT).reduce((n, hex) => n + painted(geometry, hex).length, 0);
    expect(minerals).toBe(pos.count);
    expect(Array.from(geometry.getAttribute('accent').array).every(a => a === 0)).toBe(true);
  });
});
