import { afterEach, describe, expect, it } from 'vitest';
import { Group, InstancedBufferGeometry, InstancedMesh, Mesh, PlaneGeometry, type InstancedBufferAttribute, type InterleavedBufferAttribute } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { CELL, PLANE_Y, type Entity, type View } from '@agent-command/game/contract';
import { asteroidPosition } from '../src/world/asteroid.ts';
import { Awareness } from '../src/world/awareness.ts';
import { Combat, HEAT_CELL } from '../src/world/combat.ts';
import { Deposits } from '../src/world/deposits.ts';
import { cpuPool } from './cpu-pool.ts';
import { Designations } from '../src/world/designations.ts';
import { Entities, orbitMuzzle } from '../src/world/entities.ts';
import { applyFade } from '../src/world/fade.ts';
import { FogField } from '../src/world/fog.ts';
import { Fx } from '../src/world/fx.ts';
import { model } from '../src/world/models.ts';
import { OrbitAbilityFx } from '../src/world/orbit-ability-fx.ts';
import { OrbitLayer } from '../src/world/orbit.ts';
import { SkyLayer } from '../src/world/sky.ts';
import { Telegraphs } from '../src/world/telegraphs.ts';
import { TerrainField } from '../src/world/terrain.ts';
import { UndergroundArt } from '../src/world/underground.ts';
import { WeatherLayer, weatherAt, weatherUnder } from '../src/world/weather.ts';

const sizes = [48, 64, 80] as const;
const at = (tick: number) => tick * 50;
const selected = new Set<string>();
afterEach(() => applyFade(1));

function snapshot(size: typeof sizes[number]): View {
  const view = createGame({ seed: 7, options: { map: { params: { size } } } }).view('nw');
  return { ...view, tick: 100, entities: [], memory: [], fx: [], impacts: [], tremors: [], charges: [], cracks: [], rally: [], oreCaches: [], scorches: [] };
}
function position(mesh: InstancedMesh, slot = 0): number[] {
  const o = slot * 16;
  return [mesh.instanceMatrix.array[o + 12]!, mesh.instanceMatrix.array[o + 14]!];
}

describe.each(sizes)('effect geometry on a %s-tile map', size => {
  it('aligns falling rocks and terminal bursts without replacing frame storage', () => {
    applyFade(1);
    const view = snapshot(size);
    const terrain = new TerrainField(size);
    const fog = new FogField(size);
    const rock = new Fx(size);
    const combat = new Combat(undefined, size, terrain, fog);
    const fall = { id: 'e_900', side: 'nw' as const, x: size - 2, y: size - 3, start: 0, tick: 200 };
    const point = { x: 0, y: 0, z: 0 };
    asteroidPosition(fall, 100, point, size);
    rock.ingest({ ...view, impacts: [fall] });
    rock.frame(5000, 100);
    const group = rock.root.children[0]!;
    expect(group.position.toArray()).toEqual([point.x, point.y, point.z]);
    const storage = group.position;
    combat.ingest({ ...view, fx: [{ kind: 'intercept', plane: 'sky', x: fall.x, y: fall.y, tick: 100, fall }] }, at);
    combat.frame(5000, 0, 100, 100);
    const matrix = cpuPool(combat.sparks).mesh.instanceMatrix.array;
    expect(matrix[28]).toBeCloseTo(point.x, 4);
    expect(matrix[30]).toBeCloseTo(point.z, 4);
    rock.frame(5001, 100.02);
    expect(group.position).toBe(storage);
    asteroidPosition(fall, 200, point, size);
    expect([point.x, point.z]).toEqual([size / 2 - 2, size / 2 - 3]);
  });

  it('renders and selects the same entity pose, and keeps unknown Depths counterparts hidden', () => {
    applyFade(1);
    const view = snapshot(size);
    const units = new Entities(false, undefined, size, new TerrainField(size), new FogField(size));
    const tank: Entity = { id: 'e_901', kind: 'tank', side: 'nw', plane: 'surface', x: size - 3.5, y: size - 4.5, hp: 100, maxHp: 100, state: 'idle' };
    const enemy: Entity = { ...tank, id: 'e_902', kind: 'headframe', side: 'se', x: size - 1.5, y: size - 2.5, state: 'active' };
    view.depths.fill(CELL.unknown);
    const draw = (tick: number) => {
      units.ingest({ ...view, tick, entities: [tank, enemy] }, at(tick));
      units.frame(at(tick), tick / 20, new Set([tank.id]), undefined, 'nw', 'surface', 26);
    };
    draw(100);
    const tankMesh = units.root.children.find(object => object instanceof Mesh && object.geometry instanceof InstancedBufferGeometry && object.geometry.getAttribute('position') === model('tank').getAttribute('position')) as Mesh<InstancedBufferGeometry>;
    const pose = tankMesh.geometry.getAttribute('unitPose') as InterleavedBufferAttribute;
    expect([pose.getX(0), pose.getZ(0)]).toEqual([tank.x - size / 2, tank.y - size / 2]);
    const selection = units.root.children.find(object => object instanceof InstancedMesh && object.count === 1 && position(object)[0] === tank.x - size / 2 && position(object)[1] === tank.y - size / 2);
    expect(selection).toBeDefined();
    const landing = units.root.getObjectByName('depths-dropoff-headframe') as Mesh<InstancedBufferGeometry>;
    expect(landing.geometry.instanceCount).toBe(0);
    view.depths[Math.floor(enemy.y) * size + Math.floor(enemy.x)] = CELL.tunnel;
    applyFade(0.5);
    draw(101);
    expect(landing.geometry.instanceCount).toBe(1);
    const landingPose = landing.geometry.getAttribute('unitPose') as InterleavedBufferAttribute;
    expect([landingPose.getX(0), landingPose.getZ(0)]).toEqual([enemy.x - size / 2, enemy.y - size / 2]);
  });

  it('sizes cell pools through the final row and preserves knowledge-only crack filtering', () => {
    const view = snapshot(size);
    const last = size * size - 1;
    const words = Math.ceil(size * size / 30);
    view.depths.fill(CELL.unknown);
    view.depths[last] = CELL.rock;
    view.cracks = [{ x: size - 1, y: size - 1, stage: 4 }, { x: size - 2, y: size - 1, stage: 4 }];
    const underground = new UndergroundArt(size);
    underground.update(view);
    const crack = underground.depths.children[3] as InstancedMesh;
    expect(crack.instanceMatrix.count).toBe(size * size);
    expect(crack.count).toBe(1);
    expect(position(crack)).toEqual([size / 2 - 0.5, size / 2 - 0.5]);
    const designations = new Designations(size);
    view.designations = { normal: Array<number>(words).fill(0), urgent: Array<number>(words).fill(0) };
    view.designations.normal[Math.floor(last / 30)] = 1 << last % 30;
    designations.ingest(view);
    const normal = designations.root.children[0] as InstancedMesh;
    expect(normal.instanceMatrix.count).toBe(size * size);
    expect(normal.count).toBe(1);
    expect(position(normal)).toEqual(position(crack));
    designations.showPreview({ x0: size - 2, y0: size - 2, x1: size - 1, y1: size - 1 });
    const preview = designations.root.children[2]!;
    expect([preview.position.x, preview.position.z]).toEqual([size / 2 - 1, size / 2 - 1]);
    const deposits = new Deposits(size, new TerrainField(size), new FogField(size));
    view.oreCaches = [{ id: 1, x: size - 0.5, y: size - 0.5, alloy: 10, radius: 1 }];
    view.scorches = [{ x: size - 0.5, y: size - 0.5, radius: 1, until: 200 }];
    deposits.update(view, at);
    expect(deposits.ore.instanceMatrix.count).toBe(size * size);
    expect(position(deposits.ore)).toEqual(position(crack));
    expect(deposits.rings.instanceMatrix.count).toBe(size * size);
    expect(position(deposits.rings)).toEqual(position(crack));
    expect(position(deposits.scorch.mesh)).toEqual(position(crack));
    deposits.update({ ...view, oreCaches: [], scorches: [] }, at);
    expect(deposits.ore.count + deposits.rings.count + deposits.scorch.mesh.count).toBe(0);
  });

  it('keeps heat world-local and places awareness pulses and breach stamps on the far edge', () => {
    applyFade(3);
    const view = snapshot(size);
    const terrain = new TerrainField(size);
    const combat = new Combat(undefined, size, terrain, new FogField(size));
    const other = new Combat(undefined, size, new TerrainField(size), new FogField(size));
    view.fx = [{ kind: 'volatile_detonation', plane: 'orbit', tick: 100, x: size - 1, y: size - 1, radius: 4 }];
    combat.ingest(view, at);
    combat.frame(5000, 0, 100, 100);
    expect(combat.heatN).toBe(size / HEAT_CELL);
    expect(combat.heat.orbit.length).toBe((size / HEAT_CELL) ** 2);
    expect(combat.heat.orbit.at(-1)).toBe(3);
    expect(other.heat.orbit.every(value => value === 0)).toBe(true);
    const awareness = new Awareness(combat, size, terrain);
    awareness.frame(view, new Map(), 0, 'orbit', 0);
    const draws = awareness.root.children.filter((object): object is InstancedMesh => object instanceof InstancedMesh && object.visible && object.count > 0);
    expect(draws).toHaveLength(1); // this fixture supplies only combat heat, no entities, rallies or other cues
    const pulses = draws[0]!;
    expect(pulses.count).toBe(1);
    expect(position(pulses)).toEqual([size / 2 - HEAT_CELL / 2, size / 2 - HEAT_CELL / 2]);
    applyFade(1);
    const telegraphs = new Telegraphs(combat, size, terrain);
    telegraphs.ingest({ ...view, fx: [], tremors: [{ x: size - 1, y: size - 1, breach: true }] }, at, 5000);
    telegraphs.frame(5000, 'nw');
    const breachDraws = telegraphs.root.children.filter((object): object is InstancedMesh => object instanceof InstancedMesh && object.visible && object.count > 0);
    const heights: number[] = [];
    for (const draw of breachDraws) for (let i = 0; i < draw.count; i++) {
      expect(position(draw, i)).toEqual([size / 2 - 0.5, size / 2 - 0.5]);
      heights.push(draw.instanceMatrix.array[i * 16 + 13]!);
    }
    // Both planes must carry the warning; batching cracks and stamps is not part of that contract.
    const betweenPlanes = (PLANE_Y.surface + PLANE_Y.depths) / 2;
    expect(heights.some(y => y < betweenPlanes)).toBe(true);
    expect(heights.some(y => y > betweenPlanes)).toBe(true);
  });

  it('centres orbital hull attachments, ability rings and plane-sized sheets', () => {
    applyFade(3);
    const view = snapshot(size);
    const units = new Entities(false, undefined, size, new TerrainField(size), new FogField(size));
    const ship: Entity = { id: 'e_903', kind: 'bastion', side: 'nw', plane: 'orbit', x: size - 5, y: size - 6, hp: 100, maxHp: 100, state: 'idle', aegis: { until: 200, pool: 100 } };
    units.ingest({ ...view, entities: [ship] }, 5000);
    units.frame(5000, 5, selected, undefined, 'nw', 'orbit', 26);
    const track = units.tracks.get(ship.id)!;
    const muzzle = new Float64Array(3);
    orbitMuzzle(muzzle, track, 0, 5000, size);
    const baseline = new Float64Array(3);
    orbitMuzzle(baseline, track, 0, 5000, 48);
    expect(muzzle[0]! - baseline[0]!).toBeCloseTo((48 - size) / 2);
    expect(muzzle[2]! - baseline[2]!).toBeCloseTo((48 - size) / 2);
    const abilities = new OrbitAbilityFx(size, new FogField(size));
    abilities.ingest({ ...view, entities: [ship] }, at);
    abilities.update(5000, units.tracks, 100);
    const rings = abilities.root.getObjectByName('orbit-ability-rings') as InstancedMesh;
    expect(rings.count).toBeGreaterThan(0);
    expect(position(rings)).toEqual([ship.x - size / 2, ship.y - size / 2]);
    const orbit = new OrbitLayer(size, new FogField(size));
    const sheet = orbit.group.children.find(object => object instanceof Mesh && object.geometry instanceof PlaneGeometry && object.geometry.parameters.width === size) as Mesh<PlaneGeometry>;
    expect(sheet.geometry.parameters.height).toBe(size);
    expect([sheet.position.x, sheet.position.z]).toEqual([0, 0]);
  });

  it('matches public weather picking, cloud geometry and rotated paths at runtime size', () => {
    const path = { cx: 8, cy: 10, radius: 3, phase: 0, speed: 0.02, turns: 2 };
    const point = { x: 0, y: 0 };
    weatherAt(path, 0, point, size);
    expect(point).toEqual({ x: size - 11, y: size - 10 });
    const weather = { storms: [], forecast: [], seeded: [], seedWarnings: [], fog: [{ x: point.x, y: point.y, radius: 2 }] };
    const jets = [0, 1].map(i => ({ x1: 0, y1: i ? size : 0, x2: size, y2: i ? 0 : size, width: 2, dx: Math.SQRT1_2, dy: i ? -Math.SQRT1_2 : Math.SQRT1_2 }));
    const match = { jets, fogPaths: [path] };
    expect(weatherUnder(weather, match, 0, point.x, point.y, size)).toBe('fog');
    const layer = new WeatherLayer(size);
    layer.update(weather, match);
    layer.frame(0);
    const mist = layer.group.children.find(object => object.renderOrder === 7) as InstancedMesh;
    expect(position(mist)).toEqual([point.x - size / 2, point.y - size / 2]);
    const streaks = layer.group.children.find(object => object.renderOrder === 8) as InstancedMesh;
    expect(streaks.count).toBe(2 * Math.round(size * Math.SQRT2 * 0.6));
    expect(streaks.count).toBeLessThanOrEqual(streaks.instanceMatrix.count);
    const buffer = mist.instanceMatrix.array;
    layer.frame(1);
    expect(mist.instanceMatrix.array).toBe(buffer);
    applyFade(2);
    const sky = new SkyLayer(size, new FogField(size));
    const view = snapshot(size);
    view.islands = [{ id: 'island', cx: size - 8, cy: size - 9, r: 5, phase: 0, speed: 0.02 }];
    sky.paths(view, 0, true, selected, () => 'nw', undefined, new Group());
    const state = sky as unknown as { ringData: InstancedBufferAttribute };
    expect([state.ringData.getX(0), state.ringData.getY(0)]).toEqual([size / 2 - 8, size / 2 - 9]);
  });
});
