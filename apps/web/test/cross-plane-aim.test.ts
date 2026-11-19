import { afterEach, describe, expect, it } from 'vitest';
import { InstancedBufferGeometry, Mesh, type InterleavedBufferAttribute } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { type Entity, type Fx, type View } from '@agent-command/game/contract';
import { Combat, PIDX } from '../src/world/combat.ts';
import { Entities, orbitMuzzle, type Track } from '../src/world/entities.ts';
import { applyFade } from '../src/world/fade.ts';
import { asteroidPosition } from '../src/world/asteroid.ts';
import { BODY_CENTRE } from '../src/world/aim.ts';
import { RIG } from '../src/world/models.ts';
import { MOUNT_PITCH_STEPS, MOUNT_YAW_SPAN } from '../src/world/rig.ts';
import { unitY, wx, wz } from '../src/world/common.ts';
import { TerrainField } from '../src/world/terrain.ts';

const size = 48;
const terrain = new TerrainField(size);
const base = createGame({ seed: 7 }).view('nw');
const noSelection = new Set<string>();
afterEach(() => applyFade(1));

/** A Sky payload falling toward (30, 20); the sim slides its logical position, the client draws its own descent. */
const fall: View['impacts'][number] = { x: 30, y: 20, tick: 200, side: 'se', id: 'e_900', start: 0 };
const rock: Entity = { id: 'e_900', kind: 'asteroid', side: 'neutral', plane: 'sky', x: 28, y: 21, hp: 60, maxHp: 60, state: 'falling', tx: 30, ty: 20 };

function track(e: Entity, scale = 1.35): Track {
  return {
    e, x: e.x, y: e.y, st: new Float64Array(4), sx: new Float32Array(4), sy: new Float32Array(4), sh: new Float32Array(4), elevation: e.elevation ?? 0, n: 1,
    heading: 0, goal: 0, aim: 0, mountPitch: 0, aimUntil: -Infinity, aimX: 0, aimY: 0, aimZ: 0, phase: 0, towHeading: 0,
    rx: e.x, ry: e.y, wy: unitY(e.plane) + (e.plane === 'orbit' ? 0.2 : 0) + (e.elevation ?? 0), scale, motionEpoch: 0, wakeSlot: -1, visible: true,
    fireAt: -1e9, hitAt: -1e9, shieldAt: -1e9, speed: 0, accel: 0, turn: 0, odo: 0, roll: 0, bank: 0, pitch: 0, dive: 0, diveFrom: e.plane,
  };
}

/** Test seam: the projectile pool's endpoints and plane indices are what the GPU draws toward. */
function shots(combat: Combat): { n: number; e: Float32Array; s: Float32Array; tp: Uint8Array } {
  return combat.shots as unknown as { n: number; e: Float32Array; s: Float32Array; tp: Uint8Array };
}

describe('shots at falling rocks', () => {
  it('end where the rock is drawn when they arrive, keeping the shooter plane all the way up', () => {
    const combat = new Combat(undefined, size, terrain);
    combat.tracks = new Map([[rock.id, track(rock)]]);
    const event: Fx = { kind: 'shot', tick: 40, arrive: 46, w: 'flak', plane: 'surface', x: 26, y: 22, tp: 'sky', tx: rock.x, ty: rock.y, side: 'nw' };
    combat.ingest({ ...base, tick: 40, fx: [event], impacts: [fall] }, (tick) => tick * 50);
    const p = shots(combat);
    expect(p.n).toBe(1);
    const at = { x: 0, y: 0, z: 0 };
    asteroidPosition(fall, 46, at, size);
    expect([p.e[0], p.e[1], p.e[2]]).toEqual([Math.fround(at.x), Math.fround(at.y), Math.fround(at.z)]);
    // not the nominal Sky-plane hover under the rock: the rock is still high on its descent from the Orbit
    expect(at.y).toBeGreaterThan(unitY('sky') + 10);
    expect(p.tp[0]).toBe(PIDX.surface);
  });

  it('draw a Bastion\'s point defence at a Sky payload from both blisters (a weapon lock cannot follow a rock)', () => {
    applyFade(3);
    const combat = new Combat(undefined, size, terrain);
    const bastion: Entity = { id: 'e_910', kind: 'bastion', side: 'nw', plane: 'orbit', x: 27, y: 21, hp: 240, maxHp: 240, state: 'attacking', heading: 0, aim: 0 };
    combat.tracks = new Map([[rock.id, track(rock)], [bastion.id, track(bastion, 1.82)]]);
    const event: Fx = { kind: 'shot', tick: 20, arrive: 21, w: 'point_defence', subject: 'bastion', plane: 'orbit', x: bastion.x, y: bastion.y, tp: 'sky', tx: rock.x, ty: rock.y, side: 'nw', src: bastion.id };
    combat.ingest({ ...base, tick: 20, fx: [event], impacts: [fall] }, (tick) => tick * 50);
    const p = shots(combat);
    expect(p.n).toBe(2);
    expect(combat.orbitShots.n).toBe(0);
    const at = { x: 0, y: 0, z: 0 };
    asteroidPosition(fall, 21, at, size);
    for (let i = 0; i < 2; i++) expect(p.e[i * 3 + 1]).toBeCloseTo(at.y, 4);
    // The first rendered frame launches each tracer from its own blister's muzzle.
    combat.frame(1000, 0, 200, 20);
    const muzzle = new Float64Array(3);
    for (let barrel = 0; barrel < 2; barrel++) {
      orbitMuzzle(muzzle, combat.tracks.get(bastion.id)!, barrel, 1000, size);
      expect(p.s[barrel * 3 + 1]).toBeCloseTo(muzzle[1]!, 4);
    }
  });

  it('launch a Gunship\'s fire at a rock from both of its raised chin barrels', () => {
    applyFade(2);
    const combat = new Combat(undefined, size, terrain);
    const gunship: Entity = { id: 'e_920', kind: 'gunship', side: 'nw', plane: 'sky', x: 27, y: 21, hp: 320, maxHp: 320, state: 'attacking', heading: 0, aim: 0 };
    const ship = track(gunship, 2.46);
    ship.mountPitch = 0.5;
    combat.tracks = new Map([[rock.id, track(rock)], [gunship.id, ship]]);
    const event: Fx = { kind: 'shot', tick: 20, arrive: 20, w: 'rifle', subject: 'gunship', plane: 'sky', x: gunship.x, y: gunship.y, tp: 'sky', tx: rock.x, ty: rock.y, side: 'nw', src: gunship.id };
    combat.ingest({ ...base, tick: 20, fx: [event], impacts: [fall] }, (tick) => tick * 50);
    const p = shots(combat);
    expect(p.n).toBe(2);
    combat.frame(1000, 0, 200, 20);
    const muzzle = new Float64Array(3);
    for (let barrel = 0; barrel < 2; barrel++) {
      orbitMuzzle(muzzle, ship, barrel, 1000, size);
      expect(p.s[barrel * 3 + 1]).toBeCloseTo(muzzle[1]!, 4);
    }
    // the raised barrels lift the muzzles above a level chin turret's
    ship.mountPitch = 0;
    orbitMuzzle(muzzle, ship, 0, 1000, size);
    expect(p.s[1]).toBeGreaterThan(muzzle[1]! + 0.1);
  });

  it('keep a same-plane shot\'s nominal end (unchanged by cross-plane aiming)', () => {
    const combat = new Combat(undefined, size, terrain);
    combat.tracks = new Map([[rock.id, track(rock)]]);
    const event: Fx = { kind: 'shot', tick: 20, arrive: 30, w: 'cannon', plane: 'surface', x: 20, y: 24, tp: 'surface', tx: 26, ty: 24, side: 'nw' };
    combat.ingest({ ...base, tick: 20, fx: [event], impacts: [fall] }, (tick) => tick * 50);
    const p = shots(combat);
    expect([p.e[0], p.e[2]]).toEqual([wx(26, size), wz(24, size)]);
    expect(p.tp[0]).toBe(PIDX.surface);
  });
});

describe('overlapping Sky elevation targeting', () => {
  it('ends a same-plane shot at the lowered attachment instead of the passing attachment above it', () => {
    const low: Entity = { id: 'low', kind: 'relay', side: 'se', plane: 'sky', x: 18, y: 12, hp: 100, maxHp: 100, state: 'idle', elevation: -8 };
    const high: Entity = { ...low, id: 'high', elevation: 0 };
    const target = track(low), passing = track(high);
    const combat = new Combat(undefined, size, terrain);
    combat.tracks = new Map([[high.id, passing], [low.id, target]]);
    const event: Fx = { kind: 'shot', tick: 20, arrive: 22, w: 'rifle', plane: 'sky', x: 16, y: 12, tp: 'sky', tx: 18, ty: 12, sourceElevation: 0, targetElevation: -8, side: 'nw' };
    combat.ingest({ ...base, tick: 20, fx: [event] }, (tick) => tick * 50);
    expect(shots(combat).e[1]).toBeCloseTo(target.wy + BODY_CENTRE * target.scale);
    expect(shots(combat).e[1]).toBeLessThan(passing.wy);
  });
});

describe('mount elevation toward another plane', () => {
  const turret: Entity = { id: 'e_100', kind: 'turret', side: 'nw', plane: 'surface', x: 12.5, y: 12.5, hp: 400, maxHp: 400, state: 'active', heading: 0, aim: 0 };
  const flyer: Entity = { id: 'e_101', kind: 'interceptor', side: 'se', plane: 'sky', x: 18.5, y: 12.5, hp: 120, maxHp: 120, state: 'idle' };
  const shot = (tp: Fx['tp'], tx: number, ty: number): Fx => ({ kind: 'shot', tick: 0, arrive: 2, w: 'turret', subject: 'turret', plane: 'surface', x: turret.x, y: turret.y, tp, tx, ty, side: 'nw', src: turret.id });
  function setup(entities: Entity[], impacts: View['impacts'] = []): { units: Entities; tr: Track; drive: () => number } {
    const units = new Entities(false, undefined, size);
    units.ingest({ ...base, tick: 0, entities, impacts }, 1000);
    units.frame(1000, 1, noSelection, undefined, 'nw', 'surface', 26);
    // the turret's instanced draw: the one whose single record stands at the turret, on the Surface
    const mesh = units.root.children.find(c => c instanceof Mesh && c.geometry instanceof InstancedBufferGeometry && c.renderOrder === 40 && c.geometry.instanceCount === 1
      && (c.geometry.getAttribute('unitPose') as InterleavedBufferAttribute | undefined)?.getX(0) === wx(turret.x, size)
      && (c.geometry.getAttribute('unitPose') as InterleavedBufferAttribute).getY(0) < unitY('sky')) as Mesh;
    const drive = mesh.geometry.getAttribute('unitDrive') as InterleavedBufferAttribute;
    return { units, tr: units.tracks.get(turret.id)!, drive: () => drive.getW(0) };
  }
  function settle(units: Entities, from: number, to: number): void {
    for (let now = from; now <= to; now += 50) units.frame(now, now / 1000, noSelection, undefined, 'nw', 'surface', 26);
  }

  it('raises the barrel toward a Sky target, packs it into the record and lifts the muzzle onto it', () => {
    const { units, tr, drive } = setup([turret, flyer]);
    const target = units.tracks.get(flyer.id)!;
    units.fire(shot('sky', flyer.x, flyer.y), 1000, []);
    settle(units, 1050, 2000);
    const elevate = RIG.turret.elevate!;
    const rise = target.wy + BODY_CENTRE * target.scale - (tr.wy + elevate.y * tr.scale);
    const expected = Math.atan2(rise, wx(flyer.x, size) - wx(tr.rx, size));
    expect(expected).toBeGreaterThan(1);
    expect(tr.mountPitch).toBeCloseTo(expected, 2);
    const packed = drive();
    const steps = Math.floor(packed / MOUNT_YAW_SPAN + 0.5);
    expect(steps / MOUNT_PITCH_STEPS).toBeCloseTo(tr.mountPitch, 2);
    expect(packed - steps * MOUNT_YAW_SPAN).toBeCloseTo(0, 3);
    // Past the recoil kick, the muzzle sits on the raised barrel: its bearing from the trunnion is the elevation.
    const muzzle = new Float64Array(3);
    orbitMuzzle(muzzle, tr, 0, 2000, size);
    const run = muzzle[0]! - (wx(tr.rx, size) + elevate.x * tr.scale);
    const lift = muzzle[1]! - (tr.wy + elevate.y * tr.scale);
    expect(Math.atan2(lift, run)).toBeCloseTo(steps / MOUNT_PITCH_STEPS, 4);
  });

  it('lowers the barrel again for a same-plane shot and when the hold lapses', () => {
    const { units, tr } = setup([turret, flyer]);
    units.fire(shot('sky', flyer.x, flyer.y), 1000, []);
    settle(units, 1050, 1500);
    expect(tr.mountPitch).toBeGreaterThan(1);
    units.fire(shot('surface', 16.5, 12.5), 1500, []);
    settle(units, 1550, 2500);
    expect(tr.mountPitch).toBeCloseTo(0, 3);
    units.fire(shot('sky', flyer.x, flyer.y), 2500, []);
    settle(units, 2550, 3000);
    expect(tr.mountPitch).toBeGreaterThan(1);
    settle(units, 3050, 6000);
    expect(tr.mountPitch).toBeCloseTo(0, 3);
  });

  it('follows a falling rock where it is drawn, bearing included', () => {
    const { units, tr } = setup([turret, rock], [fall]);
    units.fire(shot('sky', rock.x, rock.y), 1000, [fall]);
    settle(units, 1050, 1800);
    const at = { x: 0, y: 0, z: 0 };
    asteroidPosition(fall, units.renderTick, at, size);
    const dx = at.x - wx(tr.rx, size), dz = at.z - wz(tr.ry, size);
    expect(Math.cos(tr.aim - Math.atan2(dz, dx))).toBeCloseTo(1, 2);
    const elevate = RIG.turret.elevate!;
    const expected = Math.min(elevate.max, Math.atan2(at.y - (tr.wy + elevate.y * tr.scale), Math.hypot(dx, dz)));
    expect(tr.mountPitch).toBeCloseTo(expected, 1);
  });
});
