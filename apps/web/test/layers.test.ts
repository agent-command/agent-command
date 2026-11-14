import { describe, expect, it } from 'vitest';
import { InstancedMesh, Line, Mesh } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { CELL, DEFAULT_RULES, type Entity } from '@agent-command/game/contract';
import { Layers } from '../src/world/layers.ts';
import { Entities } from '../src/world/entities.ts';
import { OrbitLayer } from '../src/world/orbit.ts';
import { DepthsLayer, lodeHeat } from '../src/world/depths.ts';
import { FogField } from '../src/world/fog.ts';
import { TileMask } from '../src/world/materials.ts';

describe.each([48, 64, 80])('map-sized plane resources (%i)', size => {
  it('centres every plane frame on its own map dimensions', () => {
    const layers = new Layers(size, new FogField(size));
    expect(layers.surface.field.terrainCodes).toHaveLength(size * size);
    expect(layers.surface.marks.data).toHaveLength(size * size);
    // The page frames (Depths, Surface, Orbit) are the borders group, the root's last child.
    const frames = layers.root.children.at(-1)!.children;
    expect(frames).toHaveLength(3);
    for (const frame of frames as Line[]) {
      expect(frame).toBeInstanceOf(Line);
      const position = frame.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        expect(Math.abs(position.getX(i))).toBeCloseTo(size / 2 + 0.6, 5);
        expect(Math.abs(position.getZ(i))).toBeCloseTo(size / 2 + 0.6, 5);
      }
    }
  });

  it('allocates independent full-sized material masks and Depths terrain buffers', () => {
    const a = new TileMask(size), b = new TileMask(size);
    a.data[size * size - 1] = 255;
    expect(a.tex.image.width).toBe(size);
    expect(a.tex.image.height).toBe(size);
    expect(b.data[size * size - 1]).toBe(0);
    const layer = new DepthsLayer(size);
    const terrain = layer.group.children[0] as Mesh;
    const positions = terrain.geometry.getAttribute('position');
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.count; i++) {
      minX = Math.min(minX, positions.getX(i));
      maxX = Math.max(maxX, positions.getX(i));
      minZ = Math.min(minZ, positions.getZ(i));
      maxZ = Math.max(maxZ, positions.getZ(i));
    }
    expect([minX, maxX, minZ, maxZ]).toEqual([-size / 2, size / 2, -size / 2, size / 2]);
    const tracks = layer.group.children[1] as InstancedMesh;
    expect(tracks.instanceMatrix.count).toBe(size * size * 2);
    const cells = new Array<number>(size * size).fill(CELL.unknown);
    cells[size * size - 2] = CELL.tunnel;
    cells[size * size - 1] = CELL.tunnel;
    layer.update({ depths: cells });
    expect(tracks.count).toBe(1);
    const storage = tracks.instanceMatrix.array;
    expect(storage[12]).toBeCloseTo(size / 2 - 1);
    expect(storage[14]).toBeCloseTo(size / 2 - 0.5);
    const geometry = terrain.geometry;
    layer.update({ depths: cells });
    expect(terrain.geometry).toBe(geometry);
    expect(tracks.instanceMatrix.array).toBe(storage);
  });

  it('keeps Orbit preview regions hidden until focused, reusing their buffers and material', () => {
    const layer = new OrbitLayer(size);
    const regions = layer.group.getObjectByName('orbit-regions') as InstancedMesh;
    const matrix = regions.instanceMatrix;
    const storage = matrix.array;
    const geometry = regions.geometry;
    const material = regions.material;
    expect(regions.visible).toBe(false);
    const region = { x: size / 4, y: size / 2, width: 6, height: 3, dx: 1, dy: 0, weight: 1, spread: 0.5 };
    layer.setRegions([region, { ...region, x: size - size / 4, dx: -1 }]);
    expect(regions.count).toBe(2);
    expect(regions.visible).toBe(false);
    layer.setRegionsFocused(true);
    expect(regions.visible).toBe(true);
    expect(regions.count).toBe(2);
    layer.setRegionsFocused(false);
    expect(regions.visible).toBe(false);
    layer.setRegionsFocused(true);
    layer.setRegions([]);
    expect(regions.count).toBe(0);
    layer.setRegions([region]);
    expect(regions.count).toBe(1);
    expect(regions.visible).toBe(true);
    expect(regions.instanceMatrix).toBe(matrix);
    expect(matrix.array).toBe(storage);
    expect(regions.geometry).toBe(geometry);
    expect(regions.material).toBe(material);
  });
});

describe('live Orbit chart and engine wakes', () => {
  function fixture() {
    const view = createGame({ seed: 7 }).view('nw');
    const units = new Entities(false, undefined, 48);
    const e: Entity = { id: 'e_900', kind: 'lancer', plane: 'orbit', side: 'se', x: 12, y: 12, hp: 100, maxHp: 100, state: 'moving', heading: 0 };
    units.ingest({ ...view, entities: [e] }, 1000);
    const tr = units.tracks.get(e.id)!;
    tr.speed = 2;
    tr.scale = 1.8;
    const layer = new OrbitLayer(DEFAULT_RULES.map.size);
    const engines = layer.group.getObjectByName('orbit-engines') as InstancedMesh;
    return { view, units, tr, layer, engines };
  }

  it('drives the terminators and daylight wedges from the same public sun uniforms', () => {
    const { view, layer } = fixture();
    const angle = layer.sunAngle;
    const half = layer.sunHalf;
    layer.update({ ...view, sun: { angle: 1.2 }, match: { ...view.match!, sun: { ...view.match!.sun, half: 0.43, speed: -0.3 } } }, 0.75);
    expect(layer.sunAngle).toBe(angle);
    expect(layer.sunHalf).toBe(half);
    expect(angle.value).toBeCloseTo(0.975);
    expect(half.value).toBe(0.43);
  });

  it('curves through past nozzle positions and reuses its bounded instance storage', () => {
    const { units, tr, layer, engines } = fixture();
    const matrix = engines.instanceMatrix;
    const storage = matrix.array;
    const geometry = engines.geometry;
    const material = engines.material;
    for (let frame = 0; frame <= 30; frame++) {
      const t = frame * 0.06;
      tr.rx = 12 + t * 2;
      tr.ry = 12 + t * t;
      tr.heading = Math.atan2(t * 2, 2);
      layer.follow(units.tracks, t);
      expect(engines.count).toBeLessThanOrEqual(19);
      expect(engines.instanceMatrix).toBe(matrix);
      expect(matrix.array).toBe(storage);
      expect(engines.geometry).toBe(geometry);
      expect(engines.material).toBe(material);
    }
    expect(engines.count).toBeGreaterThan(8);
    // Old and new wake segments retain different bearings, rather than rotating with the current hull.
    const a = 16;
    const b = (engines.count - 1) * 16;
    expect(Math.abs(storage[a]! * storage[b + 2]! - storage[a + 2]! * storage[b]!)).toBeGreaterThan(0.001);
  });

  it.each(['hidden', 'gone', 'plane'] as const)('immediately retires a %s owner and never restores its old wake', mode => {
    const { units, tr, layer, engines } = fixture();
    layer.follow(units.tracks, 0);
    tr.rx++;
    layer.follow(units.tracks, 0.06);
    expect(engines.count).toBeGreaterThan(1);
    if (mode === 'hidden') tr.visible = false;
    else if (mode === 'gone') units.tracks.delete(tr.e.id);
    else tr.e = { ...tr.e, plane: 'sky' };
    layer.follow(units.tracks, 0.12);
    expect(engines.count).toBe(0);
    expect(tr.wakeSlot).toBe(-1);
    tr.visible = true;
    tr.e = { ...tr.e, plane: 'orbit' };
    units.tracks.set(tr.e.id, tr);
    tr.rx += 10;
    layer.follow(units.tracks, 0.18);
    expect(engines.count).toBe(1);
  });

  it('clears discontinuities, hitches and stopped wakes without bridging them', () => {
    const { units, tr, layer, engines } = fixture();
    layer.follow(units.tracks, 0);
    tr.rx++;
    layer.follow(units.tracks, 0.06);
    expect(engines.count).toBeGreaterThan(1);
    tr.motionEpoch++;
    tr.rx += 20;
    layer.follow(units.tracks, 0.12);
    expect(engines.count).toBe(1);
    tr.rx++;
    layer.follow(units.tracks, 0.18);
    expect(engines.count).toBeGreaterThan(1);
    layer.follow(units.tracks, 1);
    expect(engines.count).toBe(1);
    tr.speed = 0;
    for (let frame = 1; frame <= 20; frame++) layer.follow(units.tracks, 1 + frame * 0.06);
    expect(engines.count).toBe(0);
    expect(tr.wakeSlot).toBe(-1);
  });

  it('bounds cosmetics at 600 owners and reuses slots released by fog', () => {
    const { units, tr, layer, engines } = fixture();
    units.tracks.clear();
    for (let i = 0; i < 601; i++) {
      const next = { ...tr, e: { ...tr.e, id: `e_${i}` }, wakeSlot: -1 };
      units.tracks.set(next.e.id, next);
    }
    layer.follow(units.tracks, 0);
    expect(engines.count).toBe(600);
    const overflow = units.tracks.get('e_600')!;
    expect(overflow.wakeSlot).toBe(-1);
    units.tracks.get('e_0')!.visible = false;
    layer.follow(units.tracks, 0.06);
    expect(engines.count).toBe(600);
    expect(overflow.wakeSlot).toBeGreaterThanOrEqual(0);
    expect(engines.instanceMatrix.count).toBe(600 * 19);
  });
});

describe('Mother Lode heat', () => {
  const rules = DEFAULT_RULES.depths;
  const heat = (pressure: number, state: 'calm' | 'warn' | 'critical' | 'cooling' = 'calm') => lodeHeat({ pressure, rate: 0, state }, rules, { hot: 0, white: 0, cracks: 0 });

  it('cool teal at 0, orange-hot at lodeWarn, white-hot at lodeCritical; cracks from lodeWarn; nothing while cooling', () => {
    expect(heat(0)).toEqual({ hot: 0, white: 0, cracks: 0 });
    expect(heat(rules.lodeWarn / 2).hot).toBeCloseTo(0.5, 9);
    expect(heat(rules.lodeWarn - 0.01).cracks).toBe(0);
    expect(heat(rules.lodeWarn, 'warn')).toEqual({ hot: 1, white: 0, cracks: 0.35 });
    expect(heat(rules.lodeCritical, 'critical')).toMatchObject({ hot: 1, white: 1 });
    expect(heat(100, 'critical').cracks).toBe(1);
    expect(heat(90, 'cooling')).toEqual({ hot: 0, white: 0, cracks: 0 });
    expect(lodeHeat(undefined, rules, { hot: 1, white: 1, cracks: 1 })).toEqual({ hot: 0, white: 0, cracks: 0 });
  });
});
