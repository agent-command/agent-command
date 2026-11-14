import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES, MAX_ARMIES, MOORING_DEPTH, PLANE_Y, TICK_RATE, type MatchData, type View } from '@agent-command/game/contract';
import { sampleStorm, type NaturalStorm } from '@agent-command/game/weather';
import { Group, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, Vector3, type InstancedBufferAttribute, type InstancedMesh } from 'three/webgpu';
import { CELL_CAP, UNIT_CAP, WeatherLayer, flashAt, weatherAt, weatherUnder } from '../src/world/weather.ts';
import { StormClouds } from '../src/world/storm-clouds.ts';
import { SkyLayer } from '../src/world/sky.ts';
import { applyFade } from '../src/world/fade.ts';
import { FogField } from '../src/world/fog.ts';
import type { Track } from '../src/world/entities.ts';
import { islandModel } from '../src/world/models.ts';

afterEach(() => vi.unstubAllGlobals());

/** Every layer and lookup here is a default-size map. */
const size = DEFAULT_RULES.map.size;
const path = { cx: 12, cy: 16, radius: 5, phase: 0.7, speed: 0.02, turns: 0 };
const emptyMatch: Pick<MatchData, 'jets' | 'fogPaths'> = { jets: [], fogPaths: [] };
const storm: NaturalStorm = {
  id: 0, x: 10, y: 12, radius: 4, maxRadius: 4, strength: 1, stage: 'mature',
  originX: 10, originY: 12, dx: 0, dy: 0, start: 0, grown: 20, breaking: 180, end: 220, turns: 0,
};

describe('public Sky weather VFX', () => {
  it('keeps fog on its exact turned circular path using caller-owned scratch', () => {
    const point = { x: 0, y: 0 }, twin = { x: 0, y: 0 };
    for (const tick of [0, 1, 1200, 100000]) {
      weatherAt(path, tick, point, size);
      expect(point.x).toBe(path.cx + Math.cos(path.phase + tick / TICK_RATE * path.speed) * path.radius);
      // One quarter turn about the centre is (x, y) → (size − y, x); two is the C2 point mirror.
      let x = point.x, y = point.y;
      for (let turns = 1; turns < 4; turns++) {
        weatherAt({ ...path, turns }, tick, twin, size);
        const nx = size - y; y = x; x = nx;
        expect(twin.x).toBeCloseTo(x, 9);
        expect(twin.y).toBeCloseTo(y, 9);
        if (turns === 2) { expect(twin.x).toBe(size - point.x); expect(twin.y).toBe(size - point.y); }
      }
    }
  });

  it('inherits the Sky page render order instead of hiding public forecasts beneath its veil', () => {
    const layer = new WeatherLayer(size);
    // Three resets groupOrder at every nested Group; an Object3D retains the parent's page ordering.
    expect(layer.group).not.toBeInstanceOf(Group);
    layer.update({ storms: [storm], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    expect(layer.group.children[0]!.renderOrder).toBeGreaterThan(5);
  });

  it('publishes only supplied public weather into reused cloud-field slots and drops expired seed cells', () => {
    const layer = new WeatherLayer(size);
    const weather: View['weather'] = {
      storms: [storm], forecast: [],
      fog: [{ x: 20, y: 15, radius: 3 }],
      seeded: [{ x: 15, y: 20, radius: 4, until: 100 }], seedWarnings: [],
    };
    const match = {
      fogPaths: [{ ...path, turns: 2 }],
      jets: [{ x1: 0, y1: 10, x2: size, y2: 10, width: 2, dx: 1, dy: 0 }],
    };
    const field = layer.cloudField, slots = [...field.centres];
    layer.update(weather, match);
    layer.frame(0);
    layer.frame(50);
    expect(field.count).toBe(2);
    expect(field.centres[1]!.x).toBeCloseTo(15 - size / 2);
    layer.frame(100);
    expect(field.count).toBe(1);
    field.centres.forEach((slot, i) => expect(slot).toBe(slots[i]));
    layer.update({ storms: [], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    layer.frame(101);
    expect(field.count).toBe(0);
    for (const mesh of layer.group.children as InstancedMesh[]) if (mesh.renderOrder !== 8) expect(mesh.count).toBe(0);
  });

  it('draws a fog bank for every army slot inside the mist buffers (four-army matches)', () => {
    const layer = new WeatherLayer(size);
    const fog = Array.from({ length: 4 }, (_, i) => ({ x: 10 + i * 8, y: 15, radius: 3 }));
    const fogPaths = fog.map((_, i) => ({ ...path, cx: 10 + i * 8, turns: i }));
    layer.update({ storms: [], forecast: [], fog, seeded: [], seedWarnings: [] }, { jets: [], fogPaths });
    layer.frame(0);
    const mist = layer.group.children.find((m) => m.renderOrder === 7) as InstancedMesh;
    // WebGPU rejects a draw whose instance count exceeds the bound buffer, blanking the whole frame.
    expect(mist.count).toBe(32);
    expect(mist.instanceMatrix.array[13]).toBeCloseTo(PLANE_Y.sky - MOORING_DEPTH + 0.3);
    expect(mist.instanceMatrix.array[7 * 16 + 13]).toBeCloseTo(PLANE_Y.sky + 2.1);
    expect(mist.instanceMatrix.count).toBeGreaterThanOrEqual(mist.count);
    for (const attribute of Object.values(mist.geometry.attributes)) {
      if ('meshPerAttribute' in attribute) expect(attribute.count).toBeGreaterThanOrEqual(mist.count);
    }
  });

  it('draws one fused hurricane per public cell only while the Sky shows, cut away round the active layer’s islands', () => {
    const camera = new PerspectiveCamera();
    const storms = new StormClouds(camera);
    const layer = new WeatherLayer(size);
    // The cloud field is the only storm draw path: the weather layer owns no storm carriers of its own.
    expect(layer.group.children.every(m => m.renderOrder === 7 || m.renderOrder === 8)).toBe(true);
    layer.update({ storms: [storm, { ...storm, id: 1, originX: 30 }], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    layer.frame(40);
    applyFade(2);
    storms.sync(layer);
    const packets = storms.packets.count;
    expect(packets).toBeGreaterThan(0);
    expect(packets % 2).toBe(0);
    expect(storms.trails.count).toBeGreaterThan(0);
    expect(storms.bolts.count).toBe(2);
    // A dive away from the Sky (planes above the camera vanish) admits no storm draws at all.
    applyFade(1);
    storms.sync(layer);
    expect(storms.packets.count + storms.trails.count + storms.bolts.count).toBe(0);
    applyFade(2);
    layer.update({ storms: [storm], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    layer.frame(41);
    storms.sync(layer);
    expect(storms.packets.count).toBe(packets / 2);
    // Clearance follows exactly the layer's admitted islands, so a closed (fogged or removed) cutaway closes here too.
    const clearance = storms as unknown as { islands: { x: number }[]; islandCount: { value: number } };
    layer.islands[0]!.set(3, 22, 4, 0);
    layer.islandCount.value = 1;
    storms.sync(layer);
    expect(clearance.islandCount.value).toBe(1);
    expect(clearance.islands[0]!.x).toBe(3);
    layer.islandCount.value = 0;
    storms.sync(layer);
    expect(clearance.islandCount.value).toBe(0);
    storms.dispose();
  });

  it('shrinks white deck puffs drifting into a storm instead of poking them through the dark mass', () => {
    const sky = new SkyLayer(size);
    const deck = sky as unknown as { clouds: InstancedMesh[]; cloudData: { r: number; a: number }[] };
    const inside = deck.cloudData[0]!, at = { x: Math.cos(inside.a) * inside.r + size / 2, y: Math.sin(inside.a) * inside.r + size / 2 };
    const scale = (i: number) => {
      const m = deck.clouds[i % deck.clouds.length]!.instanceMatrix.array, at = Math.floor(i / deck.clouds.length) * 16;
      return Math.hypot(m[at]!, m[at + 1]!, m[at + 2]!);
    };
    sky.frame(0);
    const open = scale(0);
    expect(open).toBeGreaterThan(0);
    sky.weather.update({ storms: [{ ...storm, originX: at.x, originY: at.y, x: at.x, y: at.y, maxRadius: 6 }], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    sky.weather.frame(40);
    sky.frame(0);
    expect(scale(0)).toBeCloseTo(0);
    sky.weather.update({ storms: [], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    sky.weather.frame(41);
    sky.frame(0);
    expect(scale(0)).toBeCloseTo(open);
  });

  it('shares island cutaways with the ordinary cloud deck so it cannot re-cover a lowered island', () => {
    const sky = new SkyLayer(size);
    const deck = sky.group.children[0] as InstancedMesh;
    const material = deck.material as MeshBasicNodeMaterial;
    expect(material.maskNode).toBeNull();
    expect(material.alphaHash).toBe(false);
    expect(material.alphaToCoverage).toBe(true);
    expect(material.opacityNode).not.toBeNull();
  });

  it('projects cached actual island geometry bounds through drift/mooring, with no hidden or missing-model cutaway', () => {
    const layer = new WeatherLayer(size), fog = new FogField(size), models = new Group();
    fog.visible.sky.fill(0);
    const geometry = islandModel(0, 0, true);
    const compute = vi.spyOn(geometry, 'computeBoundingBox');
    const track = (id: string, x: number, kind = 'island') => {
      const mesh = new Mesh(geometry);
      mesh.name = `island-terrain-${id}`;
      if (kind === 'island') models.add(mesh);
      return { e: { id, kind, plane: 'sky' }, visible: true, rx: x, ry: 12, wy: PLANE_Y.sky, scale: 1 } as Track;
    };
    const shown = track('shown', 10), hidden = track('hidden', 14), unit = track('unit', 30, 'gunship');
    const faded = track('faded', 10);
    faded.visible = false;
    const tracks = new Map([shown, hidden, unit, faded].map(tr => [tr.e.id, tr]));
    fog.visible.sky[12 * size + 10] = 1;
    // Inspect retained uniform storage, not a second implementation of the shader projection.
    const state = layer;
    const buffers = state.islands, slot = buffers[0]!;
    layer.cutaways(tracks, models, fog);
    expect(state.islandCount.value).toBe(1);
    expect(compute).toHaveBeenCalledOnce();
    const initial = slot.clone(), axes = state.islandAxes[0]!.clone();
    expect(axes.x).toBeGreaterThan(2);
    expect(axes.y).toBeGreaterThan(2);
    shown.rx += 0.4;
    shown.wy -= MOORING_DEPTH;
    layer.cutaways(tracks, models, fog);
    expect(state.islands).toBe(buffers);
    expect(state.islands[0]).toBe(slot);
    expect(slot.x).toBeCloseTo(initial.x + 0.4);
    expect(slot.y).toBeCloseTo(initial.y - MOORING_DEPTH);
    state.islandAxes[0]!.toArray().forEach((axis, i) => expect(axis).toBeCloseTo(axes.getComponent(i), 9));
    expect(compute).toHaveBeenCalledOnce();
    const model = models.getObjectByName('island-terrain-shown') as Mesh;
    model.visible = false;
    layer.cutaways(tracks, models, fog);
    expect(state.islandCount.value).toBe(0);
    model.visible = true;
    model.removeFromParent();
    layer.cutaways(tracks, models, fog);
    expect(state.islandCount.value).toBe(0);
    models.add(model);
    const replacement = geometry.clone().scale(1.5, 1, 1);
    model.geometry = replacement;
    layer.cutaways(tracks, models, fog);
    expect(state.islandCount.value).toBe(1);
    expect(state.islandAxes[0]!.x).toBeGreaterThan(axes.x);
    model.geometry = geometry;
    replacement.dispose();
    fog.visible.sky.fill(0);
    layer.cutaways(tracks, models, fog);
    expect(state.islandCount.value).toBe(0);
    layer.cutaways(undefined, models, fog);
    expect(state.islandCount.value).toBe(0);
    fog.visible.sky.fill(1);
    for (let i = 0; i < 24; i++) tracks.set(`extra-${i}`, track(`extra-${i}`, 10));
    layer.cutaways(tracks, models, fog);
    expect(state.islandCount.value).toBe(16);
    tracks.clear();
    layer.cutaways(tracks, models, fog);
    expect(state.islandCount.value).toBe(0);
    const missing = track('missing', 10);
    models.remove(models.getObjectByName('island-terrain-missing')!);
    tracks.set('missing', missing);
    layer.cutaways(tracks, models, fog);
    expect(state.islandCount.value).toBe(0); // no arbitrary-radius fallback
  });

  it('opens the lowered deck at its rendered height and visible aircraft nearest the camera, never hidden ones', () => {
    const layer = new WeatherLayer(size), fog = new FogField(size), models = new Group();
    fog.visible.sky.fill(1);
    const mesh = new Mesh(islandModel(0, 0, true));
    mesh.name = 'island-terrain-deck';
    models.add(mesh);
    const deck = { e: { id: 'deck', kind: 'island', plane: 'sky' }, visible: true, rx: 10, ry: 12, wy: PLANE_Y.sky - MOORING_DEPTH, scale: 1 } as Track;
    const plane = { e: { id: 'plane', kind: 'interceptor', plane: 'sky' }, visible: true, rx: 10.2, ry: 12, wy: PLANE_Y.sky - 3, scale: 1 } as Track;
    const tracks = new Map([[deck.e.id, deck], [plane.e.id, plane]]);
    layer.cutaways(tracks, models, fog);
    expect(layer.islands[0]!.y).toBeLessThan(PLANE_Y.sky - MOORING_DEPTH / 2); // follows the rendered, lowered deck
    expect(layer.unitCount).toBe(1);
    expect(layer.units[0]!.y).toBe(PLANE_Y.sky - 3); // the descending aircraft at its own rendered height
    fog.visible.sky[12 * size + 10] = 0;
    layer.cutaways(tracks, models, fog);
    expect(layer.islandCount.value + layer.unitCount).toBe(0); // fogged: no opening for deck or aircraft
    fog.visible.sky.fill(1);
    plane.visible = false;
    layer.cutaways(tracks, models, fog);
    expect(layer.unitCount).toBe(0);
    // Over capacity, the aircraft nearest the camera keep their openings.
    for (let i = 0; i < UNIT_CAP + 8; i++) {
      const far = { ...plane, visible: true, e: { ...plane.e, id: `far-${i}` }, rx: 40, ry: 40 } as Track;
      tracks.set(far.e.id, far);
    }
    plane.visible = true;
    tracks.delete(plane.e.id);
    tracks.set(plane.e.id, plane);
    const eye = new Vector3(10 - size / 2, PLANE_Y.sky + 20, 12 - size / 2);
    layer.cutaways(tracks, models, fog, eye);
    expect(layer.unitCount).toBe(UNIT_CAP);
    expect(layer.units.some(u => Math.abs(u.x - (10.2 - size / 2)) < 1e-9)).toBe(true);
  });

  it('opens a gap round every other visible Sky structure; a linked building joins its admitted island instead', () => {
    const layer = new WeatherLayer(size), fog = new FogField(size), models = new Group();
    fog.visible.sky.fill(1);
    const mesh = new Mesh(islandModel(0, 0, true));
    mesh.name = 'island-terrain-deck';
    models.add(mesh);
    const deck = { e: { id: 'deck', kind: 'island', plane: 'sky' }, visible: true, rx: 10, ry: 12, wy: PLANE_Y.sky, scale: 1, heading: 0 } as Track;
    const linked = { e: { id: 'aerie', kind: 'aerie', plane: 'sky', link: 'deck' }, visible: true, rx: 10, ry: 12, wy: PLANE_Y.sky, scale: 1, heading: 0 } as Track;
    const standalone = { e: { id: 'lone', kind: 'aerie', plane: 'sky', link: 'gone' }, visible: true, rx: 30, ry: 30, wy: PLANE_Y.sky, scale: 1, heading: 0 } as Track;
    const tracks = new Map([[deck.e.id, deck], [linked.e.id, linked], [standalone.e.id, standalone]]);
    layer.cutaways(tracks, models, fog);
    expect(layer.islandCount.value).toBe(1);
    expect(layer.unitCount).toBe(1); // only the building whose island holds no opening
    expect(layer.units[0]!.x).toBe(30 - size / 2);
    fog.visible.sky[30 * size + 30] = 0;
    layer.cutaways(tracks, models, fog);
    expect(layer.unitCount).toBe(0); // a fogged building opens nothing
  });

  it('fades a seeded storm in at its full extent instead of growing it from a point', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const layer = new WeatherLayer(size);
    layer.update({
      storms: [], forecast: [], fog: [],
      seeded: [{ x: 15, y: 20, radius: 7, until: 600 }], seedWarnings: [],
    }, emptyMatch);
    layer.frame(0);
    layer.frame(1);
    const field = layer.cloudField;
    expect(field.count).toBe(1);
    expect(field.centres[0]!.w).toBe(7);
    const faint = field.states[0]!.x;
    layer.frame(40);
    expect(field.centres[0]!.w).toBe(7);
    expect(field.states[0]!.x).toBeGreaterThan(faint);
    layer.frame(601);
    expect(field.count).toBe(0);
  });

  it('suppresses cosmetic motion and lightning for reduced motion without freezing public storm progression', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const tick = Array.from({ length: 1200 }, (_, i) => i + 100).find((t) => flashAt(t / TICK_RATE, storm.id) > 0.8)!;
    const layer = new WeatherLayer(size);
    const c = { ...storm, start: tick - 80, grown: tick - 60, breaking: tick + 20, end: tick + 40 };
    layer.update({ storms: [c], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    layer.frame(tick);
    const field = layer.cloudField;
    expect(field.count).toBe(1);
    expect(field.motion).toBe(0);
    expect(field.states[0]!.y).toBe(0);
    expect(field.strikes[0]!.w).toBe(0);
    expect(weatherUnder({ storms: [c], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch, tick, c.originX, c.originY, size)).toBe('storm');
    layer.frame(c.end);
    expect(field.count).toBe(0);
  });

  it('fits eight natural, eight forecast, sixteen seeded and sixteen warning cells in the bounded field', () => {
    const layer = new WeatherLayer(size);
    // Largest gameplay seed radius does not change capacity.
    const radius = DEFAULT_RULES.sky.seederRadius;
    layer.update({
      storms: Array.from({ length: MAX_ARMIES }, (_, id) => ({ ...storm, id, turns: id % 4 })),
      forecast: Array.from({ length: MAX_ARMIES }, (_, id) => ({ ...storm, id: id + 8, start: 100, grown: 120 })),
      fog: [],
      seeded: Array.from({ length: 16 }, (_, i) => ({ x: i + 10, y: 20, radius, until: 1000 })),
      seedWarnings: Array.from({ length: 16 }, (_, i) => ({ x: i + 10, y: 30, radius, from: 1000 })),
    }, emptyMatch);
    layer.frame(0);
    layer.frame(40);
    expect(layer.cloudField.count).toBe(2 * MAX_ARMIES + 32);
    expect(layer.cloudField.count).toBeLessThanOrEqual(CELL_CAP);
    expect(layer.cloudField.centres).toHaveLength(CELL_CAP);
    expect(layer.group.children.filter(m => m.renderOrder === 7)).toHaveLength(1); // fog only, no storm slices
  });

  it('releases its owned geometries, materials and instance buffers on disposal', () => {
    const layer = new WeatherLayer(size);
    const draws = [...layer.group.children] as InstancedMesh[];
    const disposed = draws.map(mesh => {
      const geo = vi.spyOn(mesh.geometry, 'dispose');
      const material = vi.spyOn(mesh.material as MeshBasicNodeMaterial, 'dispose');
      const instances = vi.spyOn(mesh, 'dispose');
      return { geo, material, instances };
    });
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
    for (const item of disposed) {
      expect(item.geo).toHaveBeenCalledOnce();
      expect(item.material).toHaveBeenCalledOnce();
      expect(item.instances).toHaveBeenCalledOnce();
    }
  });

  it('uses deterministic bounded lightning with both dark and flashing frames', () => {
    const a = Array.from({ length: 1200 }, (_, tick) => flashAt(tick / TICK_RATE, 3));
    expect(a).toEqual(Array.from({ length: 1200 }, (_, tick) => flashAt(tick / TICK_RATE, 3)));
    expect(a.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(a.some((v) => v > 0.8)).toBe(true);
    expect(a.some((v) => v === 0)).toBe(true);
    expect(a).not.toEqual(Array.from({ length: 1200 }, (_, tick) => flashAt(tick / TICK_RATE, 4)));
  });

  it('names weather by public forecast boundaries, prioritising damage and ignoring expired seeds', () => {
    const weather: View['weather'] = {
      storms: [{ ...storm, originX: 20, originY: 20 }], forecast: [],
      fog: [{ x: 0, y: 0, radius: 6 }],
      seeded: [{ x: 30, y: 20, radius: 3, until: 100 }],
      seedWarnings: [{ x: 30, y: 40, radius: 3, from: 100 }],
    };
    const match = {
      fogPaths: [{ ...path, radius: 0, cx: 20, cy: 20 }],
      jets: [{ x1: 0, y1: 20, x2: size, y2: 20, width: 2, dx: 1, dy: 0 }],
    };
    expect(weatherUnder(weather, match, 50, 24, 20, size)).toBe('storm');
    expect(weatherUnder(weather, match, 50, 25, 20, size)).toBe('fog');
    expect(weatherUnder(weather, match, 50, 33, 20, size)).toBe('seeded');
    expect(weatherUnder(weather, match, 100, 33, 20, size)).toBe('jet');
    expect(weatherUnder(weather, match, 100, 40, 22, size)).toBe('jet');
    expect(weatherUnder(weather, match, 100, 40, 22.01, size)).toBeUndefined();
    // a seed telegraph names its coming storm until it forms, then nothing (the seeded storm takes over)
    expect(weatherUnder(weather, match, 50, 31, 40, size)).toBe('seeding');
    expect(weatherUnder(weather, match, 100, 31, 40, size)).toBeUndefined();
  });

  it('samples natural drift and mirroring at fractional render ticks, not snapshot coordinates', () => {
    const layer = new WeatherLayer(size);
    const c = { ...storm, x: 40, y: 40, dx: 0.1, dy: -0.02, turns: 2 };
    const sample = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' as NaturalStorm['stage'] };
    layer.update({ storms: [c], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    const slot = layer.cloudField.centres[0]!;
    for (const tick of [10.5, 60.25, 200.5]) {
      layer.frame(tick);
      sampleStorm(c, tick, sample, 0, size);
      expect(layer.cloudField.centres[0]).toBe(slot);
      expect(slot.x).toBeCloseTo(sample.x - size / 2);
      expect(slot.z).toBeCloseTo(sample.y - size / 2);
      expect(weatherUnder({ storms: [c], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch, tick, sample.x, sample.y, size)).toBe('storm');
    }
    layer.frame(c.end);
    expect(layer.cloudField.count).toBe(0);
  });

  it('grows a later storm monotonically from forecast through formation while others end and appear', () => {
    const layer = new WeatherLayer(size);
    const first = { ...storm, id: 0, start: 0, grown: 20, breaking: 120, end: 150 };
    const second = { ...storm, id: 1, originX: 14, start: 100, grown: 200, breaking: 400, end: 450 };
    const third = { ...storm, id: 2, originX: 18, start: 260, grown: 300, breaking: 400, end: 450 };
    let radius = 0, opacity = 0, frames = 0;
    for (let tick = 40; tick <= 210; tick += 0.5) {
      // The public lists hand a storm from `forecast` to `storms` at its start; a third is announced mid-growth.
      const all = [first, second, ...(tick >= 160 ? [third] : [])].filter(c => tick < c.end);
      layer.update({ storms: all.filter(c => tick >= c.start), forecast: all.filter(c => tick < c.start), fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
      layer.frame(tick);
      const field = layer.cloudField;
      const slot = field.states.findIndex((state, i) => i < field.count && state.z === second.id * 1.618);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(field.centres[slot]!.w).toBeGreaterThanOrEqual(radius);
      expect(field.states[slot]!.x).toBeGreaterThanOrEqual(opacity);
      radius = field.centres[slot]!.w;
      opacity = field.states[slot]!.x;
      frames++;
    }
    expect(frames).toBe(341);
    expect(radius).toBe(second.maxRadius);
    expect(opacity).toBe(1);
  });

  it('gathers faint forecasts, grows into formation and fades breaking storms without circulation or lightning', () => {
    const layer = new WeatherLayer(size);
    const c = { ...storm, start: 100, grown: 140, breaking: 180, end: 220 };
    const field = layer.cloudField;
    layer.update({ storms: [], forecast: [c], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    layer.frame(0);
    expect(field.count).toBe(1);
    expect(field.states[0]!.x).toBeGreaterThan(0);
    expect(field.states[0]!.x).toBeLessThan(0.2);
    expect(field.states[0]!.w).toBe(0); // a forecast draws no wind trails
    expect(weatherUnder({ storms: [], forecast: [c], fog: [], seeded: [], seedWarnings: [] }, emptyMatch, 0, c.originX, c.originY, size)).toBe('forecast');
    layer.frame(110);
    const small = field.centres[0]!.w;
    layer.frame(130);
    expect(field.centres[0]!.w).toBeGreaterThan(small);
    expect(field.states[0]!.w).toBe(1);
    expect(field.strikes[0]!.w).toBe(0);
    expect(weatherUnder({ storms: [], forecast: [c], fog: [], seeded: [], seedWarnings: [] }, emptyMatch, 130, c.originX + 3, c.originY, size)).toBe('storm');
    layer.frame(190);
    const early = field.states[0]!.x;
    layer.frame(210);
    expect(field.states[0]!.x).toBeLessThan(early);
    expect(field.strikes[0]!.w).toBe(0);
    layer.frame(c.end);
    expect(field.count).toBe(0);
  });

  it('telegraphs a seed as a faint full-extent cloud without circulation or lightning', () => {
    const layer = new WeatherLayer(size);
    const warning = { x: 20, y: 20, radius: 7, from: 160 };
    const field = layer.cloudField;
    layer.update({ storms: [], forecast: [], fog: [], seeded: [], seedWarnings: [warning] }, emptyMatch);
    layer.frame(100);
    expect(field.count).toBe(1);
    expect(field.centres[0]!.w).toBe(warning.radius);
    expect(field.states[0]!.w).toBe(0);
    expect(field.states[0]!.x).toBeGreaterThan(0);
    expect(field.states[0]!.x).toBeLessThan(0.5);
    layer.frame(150);
    expect(field.strikes[0]!.w).toBe(0);
    layer.frame(warning.from);
    expect(field.count).toBe(0);
  });

  it('restricts natural lightning to maturity while seeded storms keep their shared lightning', () => {
    const tick = Array.from({ length: 1200 }, (_, i) => i + 100).find((t) => flashAt(t / TICK_RATE, storm.id) > 0.8)!;
    expect(tick).toBeDefined();
    const layer = new WeatherLayer(size);
    const strike = layer.cloudField.strikes[0]!;
    const c = { ...storm, start: tick - 80, grown: tick - 60, breaking: tick + 20, end: tick + 40 };
    layer.update({ storms: [c], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    layer.frame(tick);
    expect(strike.w).toBeGreaterThan(0.8);
    // The strike lands on the storm's own bank, within its public radius.
    expect(Math.hypot(strike.x - layer.cloudField.centres[0]!.x, strike.y - layer.cloudField.centres[0]!.z)).toBeLessThan(c.maxRadius);
    layer.update({ storms: [{ ...c, grown: tick + 20 }], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    layer.frame(tick);
    expect(strike.w).toBe(0);
    layer.update({ storms: [{ ...c, breaking: tick - 20 }], forecast: [], fog: [], seeded: [], seedWarnings: [] }, emptyMatch);
    layer.frame(tick);
    expect(strike.w).toBe(0);
    const seedTick = Array.from({ length: 1200 }, (_, i) => i + 100).find((t) => flashAt(t / TICK_RATE, 4) > 0.8)!;
    layer.update({ storms: [], forecast: [], fog: [], seeded: [{ x: 20, y: 20, radius: 4, until: seedTick + 100 }], seedWarnings: [] }, emptyMatch);
    layer.frame(seedTick - 40);
    layer.frame(seedTick);
    expect(strike.w).toBeGreaterThan(0.8);
  });

  it('keeps owner-coloured island drift rings and emphasises only the highlighted path', () => {
    const layer = new SkyLayer(48);
    const view = { rulesHash: 0, islands: [
      { id: 'own', cx: 20, cy: 20, r: 8, phase: 0, speed: 0.02 },
      { id: 'enemy', cx: 28, cy: 28, r: 8, phase: Math.PI, speed: 0.02 },
    ] } as View;
    const state = layer as unknown as { ringData: InstancedBufferAttribute; ringTint: InstancedBufferAttribute };
    layer.paths(view, 100, true, new Set(), (id) => id === 'own' ? 'nw' : 'se', undefined, new Group());
    const idleWidth = state.ringData.getW(0), idleAlpha = state.ringTint.getW(0);
    expect(state.ringTint.getX(0)).not.toBe(state.ringTint.getX(1));
    layer.paths(view, 100, true, new Set(['own']), (id) => id === 'own' ? 'nw' : 'se', undefined, new Group());
    expect(state.ringData.getW(0)).toBeGreaterThan(idleWidth);
    expect(state.ringTint.getW(0)).toBeGreaterThan(idleAlpha);
    expect(state.ringData.getW(1)).toBe(idleWidth);
    layer.paths(undefined, 100, true, new Set(), () => 'neutral', undefined, new Group());
    for (const mesh of layer.group.children.filter((m) => m.renderOrder === 6) as InstancedMesh[]) expect(mesh.count).toBe(0);
  });
});
