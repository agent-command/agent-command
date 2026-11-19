import { afterEach, describe, expect, it } from 'vitest';
import { InstancedMesh, Mesh, type InstancedBufferGeometry, type InterleavedBufferAttribute } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import type { Entity, View } from '@agent-command/game/contract';
import { wx, wz } from '../src/world/common.ts';
import { Entities, orbitMuzzle, type Track } from '../src/world/entities.ts';
import { fadeValue, focusValue } from '../src/world/fade.ts';
import { IslandGrove } from '../src/world/island-groves.ts';
import { GUNSHIP, GUN_PLATFORM_TURRET_Y, HARDPOINT_AT, HARDPOINT_PAD, hardpointOffset, islandIdentity, islandModel, islandPlantModel, islandPlants } from '../src/world/models.ts';
import { FogField } from '../src/world/fog.ts';

const beforeFade = { ...fadeValue }, beforeFocus = { ...focusValue };
afterEach(() => { Object.assign(fadeValue, beforeFade); Object.assign(focusValue, beforeFocus); });

describe('Sky island journal dressing', () => {
  it('responds on turf and trees only to canonical active storms on currently visible rendered islands', () => {
    const grove = new IslandGrove(0, 0), fog = new FogField(48);
    const weather: View['weather'] = { storms: [], forecast: [], fog: [], seeded: [{ x: 10, y: 12, radius: 4, until: 200 }], seedWarnings: [] };
    const track = { e: { kind: 'island', x: 10, y: 12, plane: 'sky' }, rx: 10, ry: 12, visible: true } as Track;
    const state = grove.storm.value;
    // A frame long enough to finish the wet ease: these checks are about membership, not the ramp.
    const settle = () => grove.updateWeather(weather, track, 48, fog, false, 10);
    fog.visible.sky.fill(1);
    settle();
    expect(state.toArray()).toEqual([1, 1]);
    grove.updateWeather(weather, track, 48, fog, true, 0);
    expect(state.toArray()).toEqual([1, 0]); // reduced motion keeps the readable static weather palette
    track.e.elevation = -8;
    settle();
    expect(state.x).toBe(1); // mooring does not grant weather immunity
    track.e.x = 14.001;
    settle();
    expect(state.toArray()).toEqual([0, 0]); // rendered/cloud proximity is not the gameplay boundary
    track.e.x = 14;
    settle();
    expect(state.x).toBe(1); // exact shared inclusive radius
    fog.visible.sky.fill(0);
    grove.updateWeather(weather, track, 48, fog, false, 0);
    expect(state.toArray()).toEqual([0, 0]); // losing sight drops the response at once
    fog.visible.sky.fill(1);
    track.visible = false;
    grove.updateWeather(weather, track, 48, fog, false, 0);
    expect(state.x).toBe(0);
    track.visible = true;
    weather.seeded = [];
    weather.seedWarnings = [{ x: 10, y: 12, radius: 7, from: 200 }];
    settle();
    expect(state.x).toBe(0); // warning clouds cannot invent an active weather response
    expect(grove.storm.value).toBe(state);
    grove.dispose();
  });

  it('eases the wet look in and out over 1.5 s instead of snapping, and at once under reduced motion', () => {
    const grove = new IslandGrove(0, 0), fog = new FogField(48);
    const weather: View['weather'] = { storms: [], forecast: [], fog: [], seeded: [{ x: 10, y: 12, radius: 4, until: 200 }], seedWarnings: [] };
    const track = { e: { kind: 'island', x: 10, y: 12, plane: 'sky' }, rx: 10, ry: 12, visible: true } as Track;
    const state = grove.storm.value;
    fog.visible.sky.fill(1);
    grove.updateWeather(weather, track, 48, fog, false, 0.75);
    expect(state.x).toBeCloseTo(0.5); // half way in after 0.75 s
    grove.updateWeather(weather, track, 48, fog, false, 0.75);
    expect(state.x).toBe(1);
    track.e.x = 20; // left the storm
    grove.updateWeather(weather, track, 48, fog, false, 0.3);
    expect(state.x).toBeCloseTo(0.8);
    expect(state.y).toBe(1); // still drying: the cosmetic motion continues until fully dry
    grove.updateWeather(weather, track, 48, fog, false, -2);
    expect(state.x).toBeCloseTo(0.8); // a rewound clock holds; it never drives the look past dry or wet
    grove.updateWeather(weather, track, 48, fog, true, 0);
    expect(state.toArray()).toEqual([0, 0]);
    grove.dispose();
  });

  it('seeds consecutive permanent sets (one island per map slot) independently of owner, position and reload order', () => {
    for (let set = 0; set < 8; set++) {
      expect(islandIdentity(`e_${set * 2 + 1}`, 2)).toEqual({ seed: set, turns: 0 });
      expect(islandIdentity(`e_${set * 2 + 2}`, 2)).toEqual({ seed: set, turns: 2 });
      for (let k = 0; k < 4; k++) expect(islandIdentity(`e_${set * 4 + k + 1}`, 4)).toEqual({ seed: set, turns: k });
      const a = islandModel(set, 0, true), b = islandModel(set, 0, true);
      expect(a.getAttribute('position').array).toEqual(b.getAttribute('position').array);
      const p = a.getAttribute('position');
      expect(p.count / 3).toBeLessThan(2400);
      for (let i = 0; i < p.count; i++) {
        if (Math.hypot(p.getX(i), p.getZ(i)) < 0.75 && Math.abs(p.getY(i)) < 0.3) expect(p.getY(i)).toBeLessThanOrEqual(0.051);
      }
      // A world quarter turn maps (x, z) → (−z, x); the C2 twin (two turns) is an exact point mirror.
      for (let turns = 1; turns < 4; turns++) {
        const twin = islandModel(set, turns, true);
        expect(a.getAttribute('paint').array).toEqual(twin.getAttribute('paint').array);
        const q = twin.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          let x = p.getX(i), z = p.getZ(i);
          for (let t = 0; t < turns; t++) { const nx = -z; z = x; x = nx; }
          if (turns === 2) { expect(q.getX(i) - x).toBe(0); expect(q.getZ(i) - z).toBe(0); }
          else { expect(q.getX(i)).toBeCloseTo(x, 5); expect(q.getZ(i)).toBeCloseTo(z, 5); }
          expect(q.getY(i) - p.getY(i)).toBe(0);
        }
        twin.dispose();
      }
      a.dispose(); b.dispose();
    }
    expect(islandModel(0, 0, true).getAttribute('position').array).not.toEqual(islandModel(1, 0, true).getAttribute('position').array);
  });

  it('carries the hardpoint deck on the rim opposite the pennant only while the match has hardpoints', () => {
    for (let seed = 0; seed < 8; seed++) {
      const bare = islandModel(seed, 0, false), decked = islandModel(seed, 0, true);
      expect(decked.getAttribute('position').count).toBeGreaterThan(bare.getAttribute('position').count);
      // The deck is a level landing at the slot pad's height: nothing of the island pokes through it.
      const p = decked.getAttribute('position');
      let deck = 0;
      for (let i = 0; i < p.count; i++) {
        const r = Math.hypot(p.getX(i) - HARDPOINT_AT.x, p.getZ(i) - HARDPOINT_AT.z);
        if (r < HARDPOINT_PAD.r * 0.45 && p.getY(i) > -0.2) { expect(p.getY(i)).toBeLessThanOrEqual(0.055); deck++; }
      }
      expect(deck).toBeGreaterThan(0);
      bare.dispose(); decked.dispose();
      // Plants keep their crowns off the deck.
      for (const plant of islandPlants(seed, 0)) {
        const crown = plant.species === 2 ? 0.94 : plant.species === 1 ? 0.52 : plant.species === 0 ? 0.3 : 0.4;
        expect(Math.hypot(plant.x - HARDPOINT_AT.x, plant.z - HARDPOINT_AT.z) - plant.scale * crown).toBeGreaterThanOrEqual(HARDPOINT_PAD.r);
      }
    }
    // The client offset turns with the island exactly as its geometry does ((x, z) → (−z, x) per quarter turn).
    for (let turns = 0; turns < 4; turns++) {
      const { x, y } = hardpointOffset(turns, { x: 0, y: 0 });
      let ex = HARDPOINT_AT.x, ez = HARDPOINT_AT.z;
      for (let t = 0; t < turns; t++) { const nx = -ez; ez = ex; ex = nx; }
      expect(x).toBeCloseTo(ex, 9);
      expect(y).toBeCloseTo(ez, 9);
    }
  });

  it('varies silhouettes, sizes, pigments and clustered counts while protecting the slot and low flight band', () => {
    const counts = new Set<number>(), silhouettes = new Set<number>(), scales = new Set<number>();
    for (let seed = 0; seed < 8; seed++) {
      const plants = islandPlants(seed, 0), half = islandPlants(seed, 2), quarter = islandPlants(seed, 1);
      expect(plants).toEqual(islandPlants(seed, 0));
      expect(plants.length).toBeGreaterThan(2);
      counts.add(plants.length);
      for (let i = 0; i < plants.length; i++) {
        const plant = plants[i]!;
        expect(half[i]).toEqual({ ...plant, x: -plant.x, z: -plant.z });
        expect(quarter[i]).toEqual({ ...plant, x: -plant.z, z: plant.x });
        const crown = plant.species === 2 ? 0.94 : plant.species === 1 ? 0.52 : plant.species === 0 ? 0.3 : 0.4;
        expect(Math.hypot(plant.x, plant.z) - plant.scale * crown).toBeGreaterThanOrEqual(1.25);
        expect(plant.x > 0.7 && Math.abs(plant.z) < 0.6).toBe(false);
        expect(plant.y + plant.scale * 1.11).toBeLessThan(1.35);
        silhouettes.add(plant.species); scales.add(plant.scale);
      }
    }
    expect(counts.size).toBeGreaterThan(1);
    expect(silhouettes.size).toBe(4);
    expect(scales.size).toBeGreaterThan(10);
    for (let species = 0; species < 4; species++) {
      const model = islandPlantModel(species);
      expect(model.getAttribute('position').count / 3).toBeLessThan(200);
      model.dispose();
    }
  });

  it('instances static trees and never rotates terrain or rebuilds it while drifting or changing ownership', () => {
    const view = createGame({ seed: 42 }).view('nw');
    const island = view.entities.find((entity) => entity.kind === 'island')!;
    const units = new Entities(false, undefined, 48);
    fadeValue.sky = focusValue.sky = 1;
    units.ingest({ ...view, entities: [island] }, 1000);
    units.frame(1000, 1, new Set([island.id]), undefined, 'nw', 'sky', 30);
    const terrain = units.root.getObjectByName(`island-terrain-${island.id}`) as Mesh;
    const pose = terrain.geometry.getAttribute('unitPose') as InterleavedBufferAttribute;
    expect(pose.getW(0)).toBe(0);
    const groves = units.root.children.filter((child) => child.name === `island-grove-${island.id}`);
    expect(groves.length).toBe(1);
    const grove = groves[0]!;
    const matrices = grove.children.map((child) => (child as InstancedMesh).instanceMatrix.version);
    const geometry = terrain.geometry;
    units.ingest({ ...view, tick: 1, entities: [{ ...island, side: 'nw', x: island.x + 0.1 }] }, 1050);
    units.frame(1050, 1.05, new Set(), undefined, 'nw', 'sky', 30);
    expect(terrain.geometry).toBe(geometry);
    expect(pose.getW(0)).toBe(0);
    expect(grove.rotation.y).toBe(0);
    expect(grove.children.map((child) => (child as InstancedMesh).instanceMatrix.version)).toEqual(matrices);
    units.ingest({ ...view, tick: 2, entities: [] }, 1100);
    units.frame(1100, 1.1, new Set(), undefined, 'nw', 'sky', 30);
    expect(grove.visible).toBe(false);
    units.reset();
    expect(units.root.getObjectByName(`island-terrain-${island.id}`)).toBeUndefined();
    expect(units.root.getObjectByName(`island-grove-${island.id}`)).toBeUndefined();
  });

  it('keeps underside minerals attached through drift and lowering, and preserves spent knowledge until the match resets', () => {
    const view = createGame({ seed: 42 }).view('nw'), size = view.match!.rules.map.size;
    const island: Entity = { ...view.entities.find((e) => e.kind === 'island')!, oreCapacity: 240, oreRemaining: 240, oreBuffer: 0 };
    const units = new Entities(false, undefined, size);
    const initial = { ...view, entities: [island], oreCaches: [] };
    fadeValue.sky = focusValue.sky = 1;
    units.ingest(initial, 1000);
    units.frame(1000, 1, new Set(), undefined, 'nw', 'sky', 30);
    const ore = units.root.getObjectByName(`island-ore-${island.id}`) as InstancedMesh;
    expect(ore.count).toBeGreaterThan(0);
    expect(ore.visible).toBe(true);
    expect(ore.boundingBox!.max.y).toBeLessThan(0);
    const fullCount = ore.count, fullY = ore.position.y;
    const geometry = ore.geometry, material = ore.material, matrices = ore.instanceMatrix.array;
    const lower = { ...island, x: island.x + 0.5, y: island.y + 0.25, elevation: -8, oreRemaining: 60 };
    units.ingest({ ...initial, tick: 20, entities: [lower] }, 2000);
    units.frame(2200, 2.2, new Set(), undefined, 'nw', 'sky', 30);
    const tr = units.tracks.get(island.id)!;
    expect(ore.count).toBeGreaterThan(0);
    expect(ore.count).toBeLessThan(fullCount);
    expect(ore.position.toArray()).toEqual([wx(tr.rx, size), tr.wy, wz(tr.ry, size)]);
    expect(ore.position.y).toBeLessThan(fullY - 3);
    expect(ore.geometry).toBe(geometry);
    expect(ore.material).toBe(material);
    expect(ore.instanceMatrix.array).toBe(matrices);
    const version = ore.instanceMatrix.version;
    units.frame(2250, 2.25, new Set(), undefined, 'nw', 'sky', 60);
    expect(ore.instanceMatrix.version).toBe(version);
    fadeValue.sky = 0;
    units.frame(2300, 2.3, new Set(), undefined, 'nw', 'surface', 30);
    expect(ore.visible).toBe(false);
    fadeValue.sky = 1;
    units.frame(2350, 2.35, new Set(), undefined, 'nw', 'sky', 30);
    expect(ore.visible).toBe(true);

    const spent = { ...lower, oreRemaining: 0 };
    units.ingest({ ...initial, tick: 40, entities: [spent] }, 3000);
    units.frame(3200, 3.2, new Set(), undefined, 'nw', 'sky', 30);
    expect(ore.count).toBe(0);
    const captured: Entity = { ...spent, side: 'se' };
    delete captured.oreRemaining;
    delete captured.oreBuffer;
    const replacement: Entity = { id: 'e_900', kind: 'ore_extractor', side: 'se', plane: 'sky', x: captured.x, y: captured.y,
      hp: 160, maxHp: 160, state: 'idle', link: captured.id };
    units.ingest({ ...initial, tick: 60, entities: [captured, replacement] }, 4000);
    units.frame(4200, 4.2, new Set(), undefined, 'nw', 'sky', 30);
    expect(units.root.getObjectByName(`island-ore-${island.id}`)).toBe(ore);
    expect(ore.count).toBe(0);
    expect(ore.visible).toBe(false);
    units.ingest({ ...initial, tick: 80, entities: [captured] }, 5000);
    units.frame(5200, 5.2, new Set(), undefined, 'nw', 'sky', 30);
    expect(ore.count).toBe(0);
    units.reset();
    expect(units.root.getObjectByName(`island-ore-${island.id}`)).toBeUndefined();
    units.ingest(initial, 6000);
    units.frame(6000, 6, new Set(), undefined, 'nw', 'sky', 30);
    const fresh = units.root.getObjectByName(`island-ore-${island.id}`) as InstancedMesh;
    expect(fresh).not.toBe(ore);
    expect(fresh.count).toBe(fullCount);
    units.reset();
  });

  it.each([14, 40, 78])('keeps live and remembered hardpoint airframes and muzzles at flying scale on the deck (zoom %s)', (zoom) => {
    const view = createGame({ seed: 42 }).view('nw');
    const match = view.match!, size = match.rules.map.size;
    const island = view.entities.find((entity) => entity.kind === 'island')!;
    const pad = hardpointOffset(islandIdentity(island.id, match.symmetry === 'C4' ? 4 : 2).turns, { x: 0, y: 0 });
    const units = new Entities(false, undefined, size);
    fadeValue.sky = focusValue.sky = 1;
    const platform = { id: 'e_900', kind: 'gun_platform', side: 'nw', plane: 'sky', x: island.x, y: island.y, hp: 320, maxHp: 320, state: 'idle', link: island.id } as Entity;
    const gunship = { id: 'e_901', kind: 'gunship', side: 'nw', plane: 'sky', x: 10, y: 10, hp: 320, maxHp: 320, state: 'idle' } as Entity;
    units.ingest({ ...view, entities: [island, platform, gunship] }, 1000);
    units.frame(1000, 1, new Set(), undefined, 'nw', 'sky', zoom);
    const tr = units.tracks.get(platform.id)!, isle = units.tracks.get(island.id)!;
    expect(tr.rx).toBeCloseTo(isle.rx + pad.x, 6);
    expect(tr.ry).toBeCloseTo(isle.ry + pad.y, 6);
    expect(tr.heading).toBeCloseTo(Math.atan2(pad.y, pad.x), 6);
    const flyer = units.tracks.get(gunship.id)!;
    expect(tr.scale).toBe(flyer.scale);
    expect(tr.wy).toBeCloseTo(isle.wy + 0.05, 6);
    // Mirror the rig with a level, outward-facing turret: the muzzle must inherit the complete airframe scale.
    tr.aim = tr.heading; tr.mountPitch = 0;
    const muzzle = new Float64Array(3);
    expect(orbitMuzzle(muzzle, tr, 0, 1000, size)).toBe(2);
    expect(Math.hypot(muzzle[0]! - wx(tr.rx, size), muzzle[2]! - wz(tr.ry, size))).toBeCloseTo(Math.hypot(GUNSHIP.turret.tip, GUNSHIP.turret.twin) * tr.scale, 6);
    expect(muzzle[1]).toBeCloseTo(tr.wy + GUN_PLATFORM_TURRET_Y * tr.scale, 6);
    expect((units.root.getObjectByName('gunship-rotor-wash') as InstancedMesh).count).toBe(2);
    expect((units.root.getObjectByName('gunship-rotor-ripples') as InstancedMesh).count).toBe(2);
    // An explicitly disclosed occupant without a live entity uses retained island-pad geometry.
    const ghost = units.root.getObjectByName('remembered-gun_platform') as Mesh;
    expect((ghost.geometry as InstancedBufferGeometry).instanceCount).toBe(0);
    const islands = view.islands.map((p) => (p.id === island.id ? { ...p, hardpoint: { kind: 'gun_platform' as const, side: 'se' as const } } : p));
    units.ingest({ ...view, tick: 1, entities: [island], islands }, 1050);
    units.frame(1050, 1.05, new Set(), undefined, 'nw', 'sky', zoom);
    expect((ghost.geometry as InstancedBufferGeometry).instanceCount).toBe(1);
    const pose = ghost.geometry.getAttribute('unitPose') as InterleavedBufferAttribute;
    expect(pose.getX(0)).toBeCloseTo(wx(isle.rx + pad.x, size), 4);
    expect(pose.getZ(0)).toBeCloseTo(wz(isle.ry + pad.y, size), 4);
    expect(pose.getY(0)).toBeCloseTo(tr.wy, 4);
    expect((ghost.geometry.getAttribute('unitForm') as InterleavedBufferAttribute).getX(0)).toBeCloseTo(tr.scale, 6);
    expect((units.root.getObjectByName('gunship-rotor-wash') as InstancedMesh).count).toBe(0);
    // Losing the disclosure must remove that silhouette, not reconstruct an enemy mount from its public path.
    units.ingest({ ...view, tick: 2, entities: [island], islands: view.islands.map(({ hardpoint: _hidden, ...path }) => path) }, 1100);
    units.frame(1100, 1.1, new Set(), undefined, 'nw', 'sky', zoom);
    expect((ghost.geometry as InstancedBufferGeometry).instanceCount).toBe(0);
    expect(units.tracks.has(platform.id)).toBe(false);
  });

  it.each(['island_mortar', 'ore_extractor'] as const)('lowers island, main slot, %s and visiting aircraft without lateral drift or Surface disclosure', (kind) => {
    const view = createGame({ seed: 42 }).view('nw');
    const match = view.match;
    if (!match) throw new Error('Island fixture requires match bootstrap');
    const size = match.rules.map.size;
    const island: Entity = { ...view.entities.find((e) => e.kind === 'island')!, mooringState: 'lowering', mooringTower: 'tower' };
    const tower: Entity = { id: 'tower', kind: 'mooring_tower', plane: 'surface', side: 'nw', x: island.x, y: island.y, hp: 400, maxHp: 400, state: 'idle', mooringTarget: island.id, mooringState: 'lowering' };
    const relay: Entity = { id: 'relay', kind: 'relay', plane: 'sky', side: 'nw', x: island.x, y: island.y, hp: 100, maxHp: 100, state: 'idle', link: island.id };
    const attachment: Entity = { ...relay, id: 'attachment', kind };
    const flyer: Entity = { ...relay, id: 'flyer', kind: 'interceptor', link: undefined };
    const units = new Entities(false, undefined, size);
    fadeValue.sky = fadeValue.surface = 1;
    const selected = new Set([tower.id]);
    units.ingest({ ...view, entities: [tower, island, relay, attachment, flyer] }, 1000);
    units.frame(1000, 1, selected, undefined, 'nw', 'sky', 30);
    const base = units.tracks.get(island.id)!.wy;
    const flyerBase = units.tracks.get(flyer.id)!.wy;
    const fields = units.root.getObjectByName('mooring-tesla-fields') as InstancedMesh;
    const tethers = units.root.getObjectByName('mooring-island-tethers') as InstancedMesh;
    expect(fields.count).toBe(1);
    expect(Math.hypot(...Array.from(tethers.instanceMatrix.array.slice(4, 7)))).toBeGreaterThan(0);
    const pad = hardpointOffset(islandIdentity(island.id, 2).turns, { x: 0, y: 0 });
    for (const [tick, state, elevation] of [[20, 'held', -8], [40, 'raising', -4], [60, undefined, 0]] as const) {
      units.ingest({ ...view, tick, entities: [{ ...tower, mooringState: state }, ...[island, relay, attachment, flyer].map((e) => ({ ...e, elevation, mooringState: e.kind === 'island' ? state : undefined }))] }, 1000 + tick * 50);
      units.frame(1200 + tick * 50, 1.2 + tick * 0.05, selected, undefined, 'nw', 'sky', 30);
      const isle = units.tracks.get(island.id)!, air = units.tracks.get(flyer.id)!;
      expect(isle.rx).toBeCloseTo(island.x, 6);
      expect(isle.wy).toBeCloseTo(base + isle.elevation, 6);
      expect(units.tracks.get(relay.id)!.wy).toBeCloseTo(isle.wy + 0.05, 6);
      expect(units.tracks.get(attachment.id)!.wy).toBeCloseTo(isle.wy + 0.05, 6);
      expect(units.tracks.get(attachment.id)!.rx).toBeCloseTo(isle.rx + pad.x, 6);
      expect(air.wy).toBeCloseTo(flyerBase + air.elevation, 6);
    }
    fadeValue.sky = 0;
    units.frame(4250, 4.25, selected, undefined, 'nw', 'surface', 30);
    for (const e of [island, relay, attachment, flyer]) expect(units.tracks.get(e.id)!.visible).toBe(false);
    expect(Math.hypot(...Array.from(tethers.instanceMatrix.array.slice(4, 7)))).toBe(0);
    units.ingest({ ...view, tick: 65, entities: [{ ...tower, mooringState: undefined, mooringTarget: undefined, mooringGrace: 20 }] }, 4250);
    units.frame(4250, 4.25, selected, undefined, 'nw', 'surface', 30);
    expect(fields.count).toBe(1);
    expect(Math.hypot(...Array.from(tethers.instanceMatrix.array.slice(4, 7)))).toBe(0);
    units.ingest({ ...view, tick: 66, entities: [island] }, 4300);
    units.frame(4300, 4.3, selected, undefined, 'nw', 'sky', 30);
    expect(fields.count).toBe(0);
    expect(tethers.count).toBe(0);
  });

  it('fades a lowered Aerie drop’s source elevation toward its Surface landing without turning it into an Orbit climb', () => {
    const view = createGame({ seed: 42 }).view('nw');
    const match = view.match;
    if (!match) throw new Error('Airdrop fixture requires match bootstrap');
    const duration = Math.round(match.rules.sky.aerieDropTravel * 20);
    const high: Entity = { id: 'high', kind: 'trooper', plane: 'sky', side: 'nw', x: 24, y: 24, hp: 100, maxHp: 100, state: 'idle', elevation: 0, transit: { to: 'surface', at: duration, until: 0 } };
    const low: Entity = { ...high, id: 'low', elevation: -8 };
    const units = new Entities(false, undefined, match.rules.map.size);
    fadeValue.sky = 1; fadeValue.surface = 0;
    units.ingest({ ...view, tick: Math.floor(duration / 2), entities: [low, high] }, 1000);
    units.frame(1000, 1, new Set(), undefined, 'nw', 'sky', 30);
    const progress = Math.max(0, Math.min(1, units.renderTick / duration));
    const lower = units.tracks.get(low.id)!, upper = units.tracks.get(high.id)!;
    // the descent eases out (a flare onto the ground), so the elevations converge as 1 − (1 − progress)³
    expect(upper.wy - lower.wy).toBeCloseTo(8 * (1 - progress) ** 3);
    expect(upper.wy).toBeLessThan(22);
    fadeValue.sky = 0; fadeValue.surface = 1;
    units.frame(1050, 1.05, new Set(), undefined, 'nw', 'surface', 30);
    expect(lower.visible).toBe(false);
    expect(upper.visible).toBe(false);
  });

  it('owns instance buffers but shares the immutable species kit', () => {
    const a = new IslandGrove(0, 0), b = new IslandGrove(0, 2);
    expect((a.group.children[0] as InstancedMesh).geometry).toBe((b.group.children[0] as InstancedMesh).geometry);
    expect((a.group.children[0] as InstancedMesh).instanceMatrix).not.toBe((b.group.children[0] as InstancedMesh).instanceMatrix);
    a.dispose(); b.dispose();
  });
});
