import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstancedMesh, Mesh, NoBlending, type Object3D } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { KINDS } from '@agent-command/game/contract';
import { Combat } from '../src/world/combat.ts';
import { Entities } from '../src/world/entities.ts';
import { Layers } from '../src/world/layers.ts';
import { HoloLens } from '../src/world/holo.ts';
import { cloudShapes, model, prepareCloudShapes } from '../src/world/models.ts';

beforeEach(() => {
  vi.stubGlobal('scheduler', { yield: vi.fn(async () => {}) });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sameDraws(actual: Object3D, expected: Object3D): void {
  expect(actual.children).toHaveLength(expected.children.length);
  for (let i = 0; i < expected.children.length; i++) {
    const a = actual.children[i]!, b = expected.children[i]!;
    expect(a.name).toBe(b.name);
    expect(a.type).toBe(b.type);
    expect(a.renderOrder).toBe(b.renderOrder);
    expect(a.visible).toBe(b.visible);
    expect(a.position.toArray()).toEqual(b.position.toArray());
    if (a instanceof Mesh && b instanceof Mesh) {
      expect(Object.keys(a.geometry.attributes)).toEqual(Object.keys(b.geometry.attributes));
      // Compare all authored geometry, excluding only per-instance records (whose layout is checked above).
      for (const name of ['position', 'normal', 'paint', 'accent', 'glow', 'part', 'uv']) {
        const aa = a.geometry.getAttribute(name), ba = b.geometry.getAttribute(name);
        expect(aa?.itemSize).toBe(ba?.itemSize);
        expect(aa?.array).toEqual(ba?.array);
      }
      expect(a.geometry.index?.array).toEqual(b.geometry.index?.array);
    }
    sameDraws(a, b);
  }
}

describe('prepared procedural startup', () => {
  it('prepares four cached rounded cloud shapes with smooth normals and a bounded triangle cost', async () => {
    const prepared = await prepareCloudShapes();
    expect(prepared).toHaveLength(4);
    expect(cloudShapes()).toBe(prepared);
    expect(await prepareCloudShapes()).toBe(prepared);
    for (const actual of prepared) {
      const position = actual.getAttribute('position'), normal = actual.getAttribute('normal');
      expect(position.count / 3).toBeGreaterThan(500);
      expect(position.count / 3).toBeLessThanOrEqual(1800);
      expect(normal.count).toBe(position.count);
      let smooth = 0;
      for (let i = 0; i < position.count; i++) {
        expect(position.getY(i)).toBeGreaterThan(-0.16);
        expect(position.getY(i)).toBeLessThan(1);
        expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 5);
        if (i % 3 === 0 && Math.hypot(normal.getX(i) - normal.getX(i + 1), normal.getY(i) - normal.getY(i + 1), normal.getZ(i) - normal.getZ(i + 1)) > 1e-4) smooth++;
      }
      // Rounded lobes interpolate their normals across triangles instead of sharing a stone-like face normal.
      expect(smooth).toBeGreaterThan(position.count / 3 * 0.95);
      expect(actual.boundingSphere?.radius).toBeGreaterThan(0);
    }
    expect(prepared[0]!.getAttribute('position').array).not.toEqual(prepared[1]!.getAttribute('position').array);
  });

  it('publishes every live, remembered and dropoff draw with the same cached geometry as synchronous Entities', async () => {
    const prepared = await Entities.create(false, 48);
    const synchronous = new Entities(false, undefined, 48);
    sameDraws(prepared.root, synchronous.root);
    const kinds = KINDS.filter(kind => kind !== 'spire' && kind !== 'island');
    for (let i = 0; i < kinds.length; i++) {
      const draw = prepared.root.children[i] as Mesh;
      expect(prepared.root.renderOrder).toBe(40);
      expect(draw.material).toMatchObject({ transparent: true, blending: NoBlending, alphaHash: true, depthWrite: true });
      const geometry = model(kinds[i]!);
      for (const name of Object.keys(geometry.attributes)) {
        expect(draw.geometry.getAttribute(name)).toBe(geometry.getAttribute(name));
      }
    }
    for (const kind of ['headframe', 'shaft', 'spire']) {
      expect(prepared.root.getObjectByName(`depths-dropoff-${kind}`)).toBeDefined();
      expect(prepared.root.getObjectByName(`depths-dropoff-memory-${kind}`)).toBeDefined();
    }
    expect(prepared.tracks.size).toBe(0);
  });

  it('prepares every combat pool and publishes even empty Orbit draws for the material warm-up traversal', async () => {
    const prepared = await Combat.create(48);
    const synchronous = new Combat(undefined, 48);
    sameDraws(prepared.root, synchronous.root);
    const draws: Mesh[] = [];
    prepared.root.traverseVisible(object => {
      if (object instanceof Mesh) draws.push(object);
    });
    expect(draws).toHaveLength(9);
    for (const draw of [prepared.orbitShots.bolts, prepared.orbitShots.halos, prepared.orbitShields.mesh]) {
      expect(draws).toContain(draw);
      expect(draw.count).toBe(0);
      expect(draw.material).toBeDefined();
    }
    expect(prepared.orbitShots.n + prepared.orbitShields.n).toBe(0);
  });

  it.each([48, 64, 80])('publishes every plane at size %i before resolving Layers.create', async size => {
    const prepared = await Layers.create(size);
    const synchronous = new Layers(size);
    sameDraws(prepared.root, synchronous.root);
    expect(prepared.surface.group.children).toContain(prepared.deposits.surface);
    expect(prepared.depths.group.children).toContain(prepared.deposits.depths);
  });

  it('builds the holo lens as pooled, hidden layers: no second entity renderer or render target', () => {
    const holo = new HoloLens(48);
    const draws: Mesh[] = [];
    holo.root.traverse(object => { if (object instanceof Mesh) draws.push(object); });
    expect(draws).toHaveLength(2 * 3);
    expect(draws.every(draw => !draw.visible)).toBe(true);
    expect(holo.root.visible).toBe(false);
  });

  it('prepares each island before ingestion with exact terrain and grove instance data, then reuses its draws', async () => {
    const source = createGame({ seed: 42 }).view('nw');
    const islands = source.entities.filter(entity => entity.kind === 'island');
    expect(islands.length).toBeGreaterThan(1);
    const view = { ...source, entities: islands };
    const prepared = new Entities(false, undefined, 48), synchronous = new Entities(false, undefined, 48);
    await prepared.prepareView(view);
    expect(prepared.tracks.size).toBe(0);
    const terrains = islands.map(island => prepared.root.getObjectByName(`island-terrain-${island.id}`) as Mesh);
    const groves = islands.map(island => prepared.root.getObjectByName(`island-grove-${island.id}`)!);
    expect(groves).toHaveLength(islands.length);
    for (const draw of [...terrains, ...groves]) expect(draw.visible).toBe(false);
    prepared.ingest(view, 1000);
    synchronous.ingest(view, 1000);
    sameDraws(prepared.root, synchronous.root);
    const expectedGroves = islands.map(island => synchronous.root.getObjectByName(`island-grove-${island.id}`)!);
    for (let island = 0; island < groves.length; island++) {
      for (let species = 0; species < groves[island]!.children.length; species++) {
        const a = groves[island]!.children[species] as InstancedMesh;
        const b = expectedGroves[island]!.children[species] as InstancedMesh;
        expect(a.geometry).toBe(b.geometry);
        expect(a.instanceMatrix.array).toEqual(b.instanceMatrix.array);
        expect(a.instanceColor!.array).toEqual(b.instanceColor!.array);
      }
    }
    await prepared.prepareView(view);
    for (let i = 0; i < islands.length; i++) {
      expect(prepared.root.getObjectByName(`island-terrain-${islands[i]!.id}`)).toBe(terrains[i]);
      expect(prepared.tracks.get(islands[i]!.id)!.n).toBe(1);
    }
    expect(islands.map(island => prepared.root.getObjectByName(`island-grove-${island.id}`))).toEqual(groves);
  });

  it('schedules canonical geometry and each missing island as separate bounded tasks', async () => {
    const source = createGame({ seed: 42 }).view('nw');
    const islands = source.entities.filter(entity => entity.kind === 'island');
    const units = new Entities(false, undefined, 48);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => { now += 5; return now; });
    const yields: number[] = [];
    vi.stubGlobal('scheduler', { yield: async () => {
      yields.push(units.root.children.filter(child => child.name.startsWith('island-terrain-')).length);
    } });
    await units.prepareView({ ...source, entities: islands });
    // Shared species and canonical terrain are warmed as their own tasks; then exactly one island lands per task, so a
    // heavier per-island build (ore, grove) never folds two islands into one budget slice.
    const shared = yields.length - islands.length;
    expect(shared).toBeGreaterThanOrEqual(5);
    expect(yields.slice(0, shared).every(count => count === 0)).toBe(true);
    expect(yields.slice(shared)).toEqual(islands.map((_, i) => i + 1));
  });

  it('keeps synchronous ingestion for islands that arrive after preparation', async () => {
    const source = createGame({ seed: 42 }).view('nw');
    const islands = source.entities.filter(entity => entity.kind === 'island');
    const units = new Entities(false, undefined, 48);
    await units.prepareView({ ...source, entities: islands.slice(0, 1) });
    const first = units.root.getObjectByName(`island-terrain-${islands[0]!.id}`);
    units.ingest({ ...source, entities: islands }, 1000);
    for (const island of islands) expect(units.root.getObjectByName(`island-terrain-${island.id}`)).toBeDefined();
    expect(units.root.getObjectByName(`island-terrain-${islands[0]!.id}`)).toBe(first);
    expect(units.tracks.size).toBe(islands.length);
  });

  it.each(['team', 'rewind'] as const)('resets a changed %s stream before preparing, not during the following ingest', async change => {
    const game = createGame({ seed: 42 });
    const source = game.view('nw');
    const island = source.entities.find(entity => entity.kind === 'island')!;
    const units = new Entities(false, undefined, 48);
    units.ingest({ ...source, tick: 10, entities: [island] }, 1000);
    const previous = units.root.getObjectByName(`island-terrain-${island.id}`);
    const incoming = {
      ...(change === 'team' ? game.view('se') : source),
      tick: change === 'team' ? 11 : 1,
      entities: [island],
    };
    await units.prepareView(incoming);
    const prepared = units.root.getObjectByName(`island-terrain-${island.id}`);
    expect(prepared).toBeDefined();
    expect(prepared).not.toBe(previous);
    expect(units.tracks.size).toBe(0);
    units.ingest(incoming, 1050);
    expect(units.root.getObjectByName(`island-terrain-${island.id}`)).toBe(prepared);
    expect(units.root.getObjectByName(`island-grove-${island.id}`)).toBeDefined();
  });
});
