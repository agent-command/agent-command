import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, type InstancedBufferAttribute } from 'three/webgpu';
import { createGame } from '@agent-command/game';
import { ECON, PLANE_Y, STATS, type Fx, type View, type Weapon } from '@agent-command/game/contract';
import { Combat, RING, WEAPON_VISUALS } from '../src/world/combat.ts';
import { applyFade, fadeValue } from '../src/world/fade.ts';
import { unitY } from '../src/world/common.ts';
import { orbitPulse, projectilePoint, projectileSegment } from '../src/world/projectile.ts';
import { TerrainField, groundAt } from '../src/world/terrain.ts';
import { orbitMuzzle, type Track } from '../src/world/entities.ts';
import { BREACHER, MORTAR_MUZZLE, WARDEN, footprintModelScale, model } from '../src/world/models.ts';
import { cpuPool } from './cpu-pool.ts';

const pigment = new Color('#e06a2a');
const terrain = new TerrainField(48);
const base = createGame({ seed: 7 }).view('nw');
const clock = (tick: number) => tick * 50;
function view(fx: Fx[], tick = 20): View { return { ...base, tick, fx }; }
function shot(w: Weapon, arrive = 30): Fx {
  return { kind: 'shot', tick: 20, arrive, w, plane: 'surface', x: 20, y: 24, tp: 'surface', tx: 26, ty: 24, side: 'nw' };
}
/** The +Z end of a unit instance must meet the analytical projectile head. */
function head(matrix: ArrayLike<number>, index = 0): number[] {
  const k = index * 16;
  return [matrix[k + 12]! + matrix[k + 8]! / 2, matrix[k + 13]! + matrix[k + 9]! / 2, matrix[k + 14]! + matrix[k + 10]! / 2];
}
function close(actual: number[], expected: number[]) {
  actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i]!, 4));
}
afterEach(() => applyFade(1));

describe('island mortar flight and impact warning', () => {
  it.each([0, -8])('launches an arcing fixed-point shell from authoritative elevation %s', (elevation) => {
    const combat = new Combat(undefined, 48, terrain);
    const add = vi.spyOn(combat.shots, 'add');
    const event: Fx = { ...shot('bomb', 60), subject: 'island_mortar', plane: 'sky', sourceElevation: elevation, targetElevation: 0 };
    combat.ingest(view([event]), clock);
    expect(add).toHaveBeenCalledOnce();
    const args = add.mock.calls[0]!;
    expect(args[0]).toMatchObject({ trajectory: 'arc', arc: 8, shape: 'shell' });
    expect(args[3]).toBeCloseTo(unitY('sky') + 0.05 + MORTAR_MUZZLE.y * footprintModelScale('island_mortar', model('island_mortar')) + elevation);
    expect(args[6]).toBeCloseTo(2);
    expect(args[8]).toBeCloseTo(0);
  });

  it('retains one fog-filtered warning on reconnect, with no hidden shooter, and removes it exactly at arrival', () => {
    applyFade(1);
    const combat = new Combat(undefined, 48, terrain);
    const add = vi.spyOn(combat.rings, 'add');
    const event: Fx = { kind: 'shot', tick: 20, arrive: 60, subject: 'island_mortar', w: 'bomb', plane: 'surface', x: 26, y: 24, sourceElevation: 0 };
    combat.ingest(view([event], 45), clock);
    combat.ingest(view([event], 46), clock);
    const warnings = add.mock.calls.filter((args) => args[10] === RING.warning);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.slice(1, 4)).toEqual([2, groundAt(26, 24, terrain) + 0.08, 0]);
    expect(warnings[0]![4]).toBe(STATS.island_mortar.splash);
    combat.rings.update(clock(59));
    expect(combat.rings.mesh.count).toBe(1);
    combat.rings.update(clock(60));
    expect(combat.rings.mesh.count).toBe(0);
  });
});

describe('projectile trajectory and oriented geometry', () => {
  it('keeps horizontal bomb drift linear while the vertical fall accelerates', () => {
    const p = new Float64Array(3);
    projectilePoint(p, 'fall', 0.5, 0, 20, 2, 8, 0, 10, 0);
    close(Array.from(p), [4, 15, 6]);
    for (const trajectory of ['linear', 'arc', 'fall'] as const) {
      projectilePoint(p, trajectory, -1, 0, 20, 2, 8, 0, 10, 3);
      close(Array.from(p), [0, 20, 2]);
      projectilePoint(p, trajectory, 2, 0, 20, 2, 8, 0, 10, 3);
      close(Array.from(p), [8, 0, 10]);
    }
    projectilePoint(p, 'arc', 0.5, 0, 20, 2, 8, 0, 10, 3);
    close(Array.from(p), [4, 13, 6]);
  });

  it.each([[0, 8, 0], [0, -8, 0], [8, 3, -4], [0, 0, 0]])('writes finite orthogonal axes for endpoint %s,%s,%s', (x, y, z) => {
    const m = new Float32Array(16);
    projectileSegment(m, 0, 0, 0, 0, x, y, z, 0.2, 0.3);
    expect(Array.from(m).every(Number.isFinite)).toBe(true);
    close(head(m), [x, y, z]);
    expect(m[0]! * m[4]! + m[1]! * m[5]! + m[2]! * m[6]!).toBeCloseTo(0);
    expect(m[0]! * m[8]! + m[1]! * m[9]! + m[2]! * m[10]!).toBeCloseTo(0);
    expect(Math.hypot(m[0]!, m[1]!, m[2]!)).toBeCloseTo(0.2);
  });
});

describe('real instanced projectile lifecycle', () => {
  it('delays muzzle and impact to render time, and hitscan spans both endpoints on its first frame', () => {
    const combat = new Combat(undefined, 48, terrain);
    combat.ingest(view([shot('beam', 20)]), clock);
    combat.frame(999, 0, 100, 19.98);
    expect(combat.sparks.n).toBe(0);
    expect(combat.shots.bolts.count).toBe(0);
    combat.frame(1000, 0, 100, 20);
    expect(combat.sparks.n).toBe(4); // one muzzle + three actual impact sparks
    expect(combat.shots.bolts.count).toBe(2); // pigment sleeve + paper core
    close(head(combat.shots.bolts.instanceMatrix.array), [2, PLANE_Y.surface + groundAt(26, 24, terrain) + 0.47, 0]);
    combat.frame(1100, 0, 100, 22);
    combat.ingest(view([shot('beam', 20)]), clock);
    combat.frame(1240, 0, 100, 24.8);
    expect(combat.sparks.n).toBe(4);
    expect(combat.shots.n).toBe(0);
    expect(combat.shots.bolts.count).toBe(0);
  });

  it('does not impose a minimum flight time and keeps long-running clocks precise', () => {
    const combat = new Combat(undefined, 48, terrain);
    const start = 2 ** 30 + 0.25;
    combat.shots.add(WEAPON_VISUALS.cannon, 1, 0, 1, 0, 1, 4, 1, 0, start, start + 25, pigment, 0, false);
    combat.frame(start + 12.5, 0, 100, 0);
    close(head(combat.shots.bodies.instanceMatrix.array), [2, 2.2, 0]);
    expect(combat.sparks.n).toBe(0);
    combat.frame(start + 25, 0, 100, 0);
    expect(combat.shots.n).toBe(0);
    expect(combat.sparks.n).toBe(1);
    expect(combat.rings.n).toBe(1);
  });

  it('culls expired snapshots without replaying muzzle flashes, smoke or impacts', () => {
    const combat = new Combat(undefined, 48, terrain);
    combat.ingest(view([shot('missile')]), clock);
    combat.frame(1700, 0, 100, 34);
    expect(combat.shots.n).toBe(0);
    expect(combat.sparks.n).toBe(0);
    expect(combat.smoke.n).toBe(0);
    expect(combat.rings.n).toBe(0);
    combat.ingest(view([shot('missile')], 34), clock);
    combat.frame(1800, 0, 100, 36);
    expect(combat.shots.n).toBe(0);
  });

  it('keeps target-only fog events anonymous and suppresses their fictional muzzle', () => {
    const combat = new Combat(undefined, 48, terrain);
    const event: Fx = { kind: 'shot', tick: 20, arrive: 30, w: 'cannon', plane: 'surface', x: 26, y: 24 };
    combat.ingest(view([event]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.sparks.n).toBe(0);
    expect(combat.smoke.n).toBe(0);
    const start = head(combat.shots.bodies.instanceMatrix.array);
    expect(Math.hypot(start[0]! - 2, start[2]!)).toBeCloseTo(3);
    combat.frame(1500, 0, 100, 30);
    expect(combat.sparks.n).toBe(1);
    close(Array.from(cpuPool(combat.sparks).mesh.instanceMatrix.array.slice(12, 15)), [2, PLANE_Y.surface + groundAt(26, 24, terrain) + 0.47, 0]);
  });

  it('swap-removes without skipping the moved slot or corrupting its colour/impact flag', () => {
    const combat = new Combat(undefined, 48, terrain);
    combat.shots.add(WEAPON_VISUALS.rifle, 1, 0, 1, 0, 1, 4, 1, 0, 0, 0, pigment, 0, false);
    combat.shots.add(WEAPON_VISUALS.missile, 1, 2, 1, 0, 1, 6, 1, 0, 0, 1000, pigment, 0, false);
    combat.frame(200, 0, 100, 4);
    expect(combat.shots.n).toBe(1);
    expect(combat.shots.bodies.count).toBe(1);
    close(head(combat.shots.bodies.instanceMatrix.array), [2.8, 1.416, 0]);
    // Inspect the actual GPU upload, not a mocked renderer callback. Previously slot zero read colour[-3].
    // The pool intentionally keeps its upload buffer private; this assertion exposes it only to the test.
    const upload = combat.shots as unknown as { boltTint: InstancedBufferAttribute };
    const tint = upload.boltTint;
    expect(tint.getX(0)).toBeCloseTo(pigment.r);
    expect(tint.getY(0)).toBeCloseTo(pigment.g);
    expect(tint.getZ(0)).toBeCloseTo(pigment.b);
    combat.frame(1000, 0, 100, 20);
    const sparks = combat.sparks.n;
    combat.frame(1000, 0, 100, 20);
    expect(combat.sparks.n).toBe(sparks);
  });

  it('fans a shotgun burst into three pellets that diverge to the spread by the target', () => {
    // the burst leaves the drawn shotgun (models.ts WARDEN, × the unit readability scale)
    expect(WEAPON_VISUALS.shotgun.forward).toBeCloseTo(WARDEN.muzzle.x * 1.35, 9);
    expect(WEAPON_VISUALS.shotgun.height).toBeCloseTo(WARDEN.muzzle.y * 1.35, 9);
    expect(WEAPON_VISUALS.shotgun.lateral).toBeCloseTo(WARDEN.muzzle.z * 1.35, 9);
    const combat = new Combat(undefined, 48, terrain);
    const spread = WEAPON_VISUALS.shotgun.spread!;
    combat.shots.add(WEAPON_VISUALS.shotgun, 0, 0, 1, 0, 0, 4, 1, 0, 0, 200, pigment, 0, false);
    combat.frame(100, 0, 100, 2);
    expect(combat.shots.bolts.count).toBe(3);
    const m = combat.shots.bolts.instanceMatrix.array;
    close(head(m, 0), [2, 1, -spread / 2]);
    close(head(m, 1), [2, 1, 0]);
    close(head(m, 2), [2, 1, spread / 2]);
  });

  it('fills the Breacher cone with pooled flame and a hot core instead of three projectile strokes', () => {
    const half = (ECON.breacherConeArc * Math.PI) / 360;
    expect(WEAPON_VISUALS.flamer.cone).toBeCloseTo(half, 9);
    expect(WEAPON_VISUALS.flamer.forward).toBeCloseTo(BREACHER.nozzle.x * 1.35, 9);
    expect(WEAPON_VISUALS.flamer.height).toBeCloseTo(BREACHER.nozzle.y * 1.35, 9);
    expect(WEAPON_VISUALS.flamer.lateral).toBeCloseTo(BREACHER.nozzle.z * 1.35, 9);
    for (const run of [STATS.breacher.range, 0.8]) {
      const combat = new Combat(undefined, 48, terrain);
      combat.shots.add(WEAPON_VISUALS.flamer, 0, 0, 1, 0, 0, run, 1, 0, 0, 0, pigment, 0, false);
      combat.frame(0, 0, 100, 0);
      expect(combat.shots.bolts.count).toBe(0);
      expect(combat.sparks.n).toBe(36); // ten three-lobe sections, five hot cores, one ember
      const m = cpuPool(combat.sparks).mesh.instanceMatrix.array;
      // Last section: its outer edge meets the actual cone, and no flame reaches beyond the target.
      const last = 32 * 16;
      const radius = Math.hypot(m[last]!, m[last + 2]!);
      expect(Math.abs(m[last + 14]!) + radius).toBeCloseTo(Math.tan(half) * run * 9 / 11);
      expect(m[last + 12]! + radius).toBeLessThanOrEqual(run + 0.001);
      const n = combat.sparks.n;
      combat.frame(0, 0, 100, 0);
      expect(combat.sparks.n).toBe(n);
      combat.frame(32, 0, 100, 0.64);
      expect(combat.sparks.n).toBe(n * 2);
      combat.frame(500, 0.5, 100, 10);
      expect(combat.sparks.n).toBe(0);
      expect(combat.shots.n).toBe(0);
    }
  });

  it('keeps both body and hot core legible after the maximum render step', () => {
    const combat = new Combat(undefined, 48, terrain);
    combat.flame(1, 0, 1, 0, 2, 1, 0, 0);
    combat.sparks.update(0.1);
    expect(combat.sparks.n).toBe(36);
    const upload = cpuPool(combat.sparks) as unknown as { tint: InstancedBufferAttribute };
    expect(upload.tint.getW(0)).toBeGreaterThan(0.2);
    expect(upload.tint.getW(3)).toBeGreaterThan(0.2);
  });

  it('keeps the flame origin on the moving, recoiling nozzle and stops emitting on lost visibility', () => {
    const combat = new Combat(undefined, 48, terrain);
    const source = orbitTrack('e_901', 'skiff', 'nw', 20);
    source.e = { ...source.e, kind: 'breacher', plane: 'surface' };
    source.wy = unitY('surface'); source.speed = 0.6; source.odo = 0.12; source.fireAt = 1000;
    source.st[0] = 20; source.sx[0] = 20; source.sy[0] = 24;
    combat.tracks = new Map([[source.e.id, source]]);
    combat.ingest(view([{ ...shot('flamer', 20), subject: 'breacher' }]), clock);
    combat.frame(1000, 0, 100, 20);
    const muzzle = new Float64Array(3);
    orbitMuzzle(muzzle, source, 0, 1000, 48);
    close(Array.from(cpuPool(combat.sparks).mesh.instanceMatrix.array.slice(12, 15)), Array.from(muzzle));
    const n = combat.sparks.n;
    source.rx += 0.4; source.ry += 0.2; source.heading = 0.2;
    combat.frame(1032, 0, 100, 20.64);
    orbitMuzzle(muzzle, source, 0, 1032, 48);
    close(Array.from(cpuPool(combat.sparks).mesh.instanceMatrix.array.slice(n * 16 + 12, n * 16 + 15)), Array.from(muzzle));
    source.visible = false;
    combat.frame(1064, 0, 100, 21.28);
    expect(combat.sparks.n).toBe(n * 2);
    expect(combat.shots.n).toBe(0);
  });

  it('honours custom cone rules and reduced motion without secondary embers or smoke', () => {
    const combat = new Combat(undefined, 48, terrain);
    vi.spyOn(combat, 'reducedMotion', 'get').mockReturnValue(true);
    const v = view([]);
    combat.ingest({ ...v, match: { ...v.match!, rules: { ...v.match!.rules, surface: { ...v.match!.rules.surface, breacherConeArc: 40 } } } }, clock);
    combat.flame(1, 0, 1, 0, 2, 1, 0, 0);
    combat.sparks.update(0);
    expect(combat.sparks.n).toBe(35);
    expect(combat.smoke.n).toBe(0);
    const m = cpuPool(combat.sparks).mesh.instanceMatrix.array, k = 32 * 16;
    expect(Math.abs(m[k + 14]!) + Math.hypot(m[k]!, m[k + 2]!)).toBeCloseTo(Math.tan(Math.PI / 9) * 2 * 9 / 11);
  });

  it('never reconstructs a hidden flamer nozzle from a target-only fog event', () => {
    const combat = new Combat(undefined, 48, terrain);
    combat.ingest(view([{ kind: 'shot', tick: 20, w: 'flamer', subject: 'breacher', plane: 'surface', x: 26, y: 24 }]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.sparks.n).toBe(3);
    expect(combat.shots.bolts.count).toBe(0);
    expect(combat.smoke.n).toBe(0);
    expect(combat.shots.n).toBe(0);
  });

  it('lobs a Warden flare from its seen thrower and ignites it on landing; an unseen thrower only shows the ignition', () => {
    const flare: Fx = { kind: 'flare', tick: 20, plane: 'depths', x: 26.5, y: 24.5, side: 'nw', subject: 'warden', src: 'e_901' };
    const thrower = { e: { id: 'e_901', kind: 'warden', side: 'nw', plane: 'depths', x: 24, y: 24.5, hp: 160, maxHp: 160, state: 'idle' }, rx: 24, ry: 24.5, visible: true } as unknown as Track;
    const lobbed = new Combat(undefined, 48, terrain);
    lobbed.tracks = new Map([[thrower.e.id, thrower]]);
    lobbed.ingest(view([flare]), clock);
    expect(lobbed.shots.n).toBe(1);
    expect(lobbed.rings.n).toBe(2);
    const unseen = new Combat(undefined, 48, terrain);
    unseen.ingest(view([flare]), clock);
    expect(unseen.shots.n).toBe(0);
    expect(unseen.sparks.n).toBeGreaterThan(0);
    expect(unseen.rings.n).toBe(2);
  });

  it('caps geometry and admissions, then reset forgets every pending lifecycle event', () => {
    const combat = new Combat(undefined, 48, terrain);
    for (let i = 0; i < 600; i++) combat.shots.add(WEAPON_VISUALS.missile, 1, 0, 1, 0, 1, 4, 1, 0, 1000, 2000, pigment);
    expect(combat.shots.n).toBe(512);
    combat.frame(1500, 0, 100, 30);
    expect(combat.shots.bodies.count).toBe(512);
    expect(combat.shots.bolts.count).toBe(512 * 5);
    combat.reset();
    combat.frame(2000, 0, 100, 40);
    expect(combat.shots.n).toBe(0);
    expect(combat.shots.bodies.count).toBe(0);
    expect(combat.shots.bolts.count).toBe(0);
    expect(combat.sparks.n + combat.smoke.n + combat.rings.n).toBe(0);
  });

  it('does not backfill trail bursts on a hitch or emit twice at a repeated timestamp', () => {
    const combat = new Combat(undefined, 48, terrain);
    combat.shots.add(WEAPON_VISUALS.missile, 1, 0, 1, 0, 1, 4, 1, 0, 0, 2000, pigment);
    combat.frame(50, 0, 100, 1);
    expect(combat.smoke.n).toBe(1);
    combat.frame(50, 0, 100, 1);
    expect(combat.smoke.n).toBe(1);
    combat.frame(1800, 0, 100, 36);
    expect(combat.smoke.n).toBe(2);
  });

  it('hides a bomb body on an invisible plane without pausing or replaying its lifetime', () => {
    const combat = new Combat(undefined, 48, terrain);
    combat.shots.add(WEAPON_VISUALS.bomb, 2, 0, 20, 0, 2, 4, 10, 0, 1000, 2000, pigment);
    applyFade(2);
    combat.frame(1500, 0, 100, 30);
    close(head(combat.shots.bodies.instanceMatrix.array), [2, 17.5, 0]);
    applyFade(0);
    expect(fadeValue.sky).toBe(0);
    combat.frame(1600, 0, 100, 32);
    expect(combat.shots.bodies.count).toBe(0);
    expect(combat.shots.bolts.count).toBe(0);
    combat.frame(2200, 0, 100, 44);
    applyFade(2);
    combat.frame(2201, 0, 100, 44.02);
    expect(combat.shots.n).toBe(0);
    expect(combat.shots.bodies.count).toBe(0);
  });

  it('draws both Bastion barrels with bounded cool tracer sleeves and compact flak pops', () => {
    applyFade(3);
    const combat = new Combat(undefined, 48, terrain);
    const event: Fx = { ...shot('point_defence', 20), subject: 'bastion', plane: 'orbit', tp: 'orbit' };
    combat.ingest(view([event]), clock);
    combat.frame(1010, 0, 100, 20.2);
    expect(combat.orbitShots.bolts.count).toBe(4); // flare and tracer for each physical barrel
    expect(combat.orbitShots.halos.count).toBe(4);
    expect(combat.shots.bodies.count).toBe(0);
    expect(combat.smoke.n).toBe(0);
    expect(combat.rings.n).toBe(2); // small scorch and flak pop, not an artillery blast
    const matrix = combat.orbitShots.bolts.instanceMatrix.array;
    expect(Math.abs(matrix[14]! - matrix[46]!)).toBeGreaterThan(1);
    combat.frame(1170, 0, 100, 23.4);
    expect(combat.orbitShots.n).toBe(0);
    expect(combat.orbitShots.bolts.count).toBe(0);
    for (let i = 0; i < 600; i++)
      combat.shots.add(WEAPON_VISUALS.point_defence, 3, 0, unitY('orbit'), 0, 3, 4, unitY('orbit'), 0, 2000, 2000, pigment);
    combat.frame(2000, 0, 100, 40);
    expect(combat.shots.n).toBe(512);
    expect(combat.shots.bolts.count).toBe(512 * 3);
    expect(combat.shots.bodies.count).toBe(0);
  });

  it.each([['skiff', 'rifle', 0.656], ['lancer', 'beam', 1.54]] as const)('keeps the %s nominal muzzle when no live tracks are supplied', (subject, weapon, forward) => {
    applyFade(3);
    const combat = new Combat(undefined, 48, terrain);
    combat.ingest(view([{ ...shot(weapon, 20), subject, plane: 'orbit', tp: 'orbit' }]), clock);
    combat.frame(1000, 0, 100, 20);
    const m = combat.orbitShots.bolts.instanceMatrix.array;
    close([m[12]! - m[8]! / 2, m[13]! - m[9]! / 2, m[14]! - m[10]! / 2], [-4 + forward, unitY('orbit') + 0.2, 0]);
  });

  it('anchors a cross-plane muzzle and target to actual nominal model heights', () => {
    const combat = new Combat(undefined, 48, terrain);
    const event: Fx = { ...shot('flak'), subject: 'flak', tp: 'sky' };
    combat.ingest(view([event]), clock);
    combat.frame(1000, 0, 100, 20);
    close(head(combat.shots.bodies.instanceMatrix.array), [-4 + 0.62, PLANE_Y.surface + groundAt(20, 24, terrain) + 1.16, -0.108]);
    // Show both endpoints during the dive. A hidden target plane correctly culls its instance instead of
    // updating an invisible buffer, so inspect the rendered midpoint rather than stale hidden geometry.
    applyFade(1.5);
    combat.frame(1250, 0, 100, 25);
    expect(combat.shots.bodies.count).toBe(2);
    close(head(combat.shots.bodies.instanceMatrix.array), [
      (-4 + 0.62 + 2) / 2,
      (PLANE_Y.surface + groundAt(20, 24, terrain) + 1.16 + PLANE_Y.sky + 2.5) / 2,
      -0.054,
    ]);
  });

});

function orbitTrack(id: string, kind: 'lancer' | 'skiff' | 'bastion', side: 'nw' | 'se', x: number, shield = 20): Track {
  return {
    e: { ...base.entities[0]!, id, kind, side, plane: 'orbit', x, y: 24, hp: 65, maxHp: 65, shield, maxShield: 20, state: 'attacking' },
    x, y: 24, st: new Float64Array(8), sx: new Float32Array(8), sy: new Float32Array(8), sh: new Float32Array(8), elevation: 0, n: 1,
    heading: 0, goal: 0, aim: 0, mountPitch: 0, aimUntil: -Infinity, aimX: 0, aimY: 0, aimZ: 0, phase: 0, towHeading: 0, rx: x, ry: 24, wy: unitY('orbit') + 0.2,
    scale: 1.35, motionEpoch: 0, wakeSlot: -1, visible: true, fireAt: -1e9, hitAt: -1e9, shieldAt: -1e9,
    speed: 0, accel: 0, turn: 0, odo: 0, roll: 0, bank: 0, pitch: 0, dive: 0, diveFrom: 'orbit',
  };
}

describe('Orbit pulse combat presentation', () => {
  it('keeps heavy stutters, a twin Skiff tap and cool PD rhythms finite and distinct', () => {
    expect(orbitPulse(-1, 'lancer')).toBe(0);
    expect(orbitPulse(0, 'lancer')).toBeGreaterThan(orbitPulse(80, 'lancer'));
    expect(orbitPulse(110, 'lancer')).toBeGreaterThan(orbitPulse(80, 'lancer'));
    expect(orbitPulse(620, 'lancer')).toBe(0);
    expect(orbitPulse(0, 'skiff')).toBe(1);
    expect(orbitPulse(70, 'skiff')).toBe(0);
    expect(orbitPulse(82, 'skiff')).toBe(1);
    expect(orbitPulse(140, 'skiff')).toBe(0);
    expect(orbitPulse(35, 'bastion')).toBe(0);
    expect(orbitPulse(48, 'bastion')).toBe(1);
    expect(orbitPulse(170, 'bastion')).toBe(0);
  });

  it('fires both physical Skiff blasters on each short twin tap without duplicating the hit', () => {
    applyFade(3);
    const combat = new Combat(undefined, 48, terrain), source = orbitTrack('e_901', 'skiff', 'nw', 20), target = orbitTrack('e_902', 'bastion', 'se', 26);
    combat.tracks = new Map([[source.e.id, source], [target.e.id, target]]);
    combat.ingest(view([{ ...shot('rifle', 20), subject: 'skiff', plane: 'orbit', tp: 'orbit' }]), clock);
    combat.frame(1010, 0, 100, 20.2);
    expect(combat.orbitShots.bolts.count).toBe(4);
    expect(combat.orbitShots.halos.count).toBe(4);
    const firstHitParticles = combat.sparks.n;
    const m = combat.orbitShots.bolts.instanceMatrix.array;
    expect(Math.abs((m[14]! - m[10]! / 2) - (m[46]! - m[42]! / 2))).toBeCloseTo(0.20 * source.scale);
    combat.frame(1092, 0, 100, 21.84);
    expect(combat.orbitShots.bolts.count).toBe(4);
    expect(combat.sparks.n).toBe(firstHitParticles);
  });

  it('tracks current rendered source and target, then retires both core and halo immediately on fog', () => {
    applyFade(3);
    const combat = new Combat(undefined, 48, terrain), source = orbitTrack('e_901', 'lancer', 'nw', 20), target = orbitTrack('e_902', 'skiff', 'se', 26);
    const tracks = new Map([[source.e.id, source], [target.e.id, target]]);
    combat.tracks = tracks;
    combat.ingest(view([{ ...shot('beam', 20), subject: 'lancer', plane: 'orbit', tp: 'orbit' }]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.orbitShots.n).toBe(1);
    expect(combat.orbitShields.n).toBe(1);
    target.rx = 27; target.ry = 25; source.rx = 20.5;
    combat.frame(1110, 0, 100, 22.2);
    close(head(combat.orbitShots.bolts.instanceMatrix.array, 1), [3, target.wy + 0.12 * target.scale, 1]);
    const muzzle = new Float64Array(3);
    orbitMuzzle(muzzle,source,0,1110,48);
    const m = combat.orbitShots.bolts.instanceMatrix.array;
    close([m[12]! - m[8]! / 2, m[13]! - m[9]! / 2, m[14]! - m[10]! / 2], Array.from(muzzle));
    target.visible = false;
    combat.frame(1120, 0, 100, 22.4);
    expect(combat.orbitShots.n).toBe(0);
    expect(combat.orbitShots.bolts.count + combat.orbitShots.halos.count + combat.orbitShields.mesh.count).toBe(0);
  });

  it('never recovers an unseen source from full coordinates or gives a target-only event a muzzle', () => {
    applyFade(3);
    const combat = new Combat(undefined, 48, terrain), target = orbitTrack('e_902', 'skiff', 'se', 26);
    combat.tracks = new Map([[target.e.id, target]]);
    combat.ingest(view([{ ...shot('beam', 20), subject: 'lancer', plane: 'orbit', tp: 'orbit' }]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.orbitShots.n + combat.sparks.n).toBe(0);
    const anonymous = new Combat(undefined, 48, terrain);
    anonymous.tracks = combat.tracks;
    anonymous.ingest(view([{ kind: 'shot', tick: 20, w: 'beam', plane: 'orbit', x: 26, y: 24 }]), clock);
    anonymous.frame(1000, 0, 100, 20);
    expect(anonymous.orbitShots.n).toBe(0);
    expect(anonymous.sparks.n).toBe(1); // shield impact only, no fictional muzzle
    expect(anonymous.orbitShields.n).toBe(1);
  });

  it('shows shield-strength bubbles and a break flash without adding hull debris, then resets all pools', () => {
    applyFade(3);
    const combat = new Combat(undefined, 48, terrain), source = orbitTrack('e_901', 'lancer', 'nw', 20), target = orbitTrack('e_902', 'skiff', 'se', 26, 0);
    target.shieldAt = 1000;
    combat.tracks = new Map([[source.e.id, source], [target.e.id, target]]);
    combat.ingest(view([{ ...shot('beam', 20), subject: 'lancer', plane: 'orbit', tp: 'orbit' }]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.orbitShields.mesh.count).toBe(1);
    expect(combat.debris.n).toBe(0);
    const upload = combat.orbitShields as unknown as { look: InstancedBufferAttribute };
    expect(upload.look.getY(0)).toBe(0);
    expect(upload.look.getZ(0)).toBe(1);
    combat.reset();
    combat.frame(1200, 0, 100, 24);
    expect(combat.orbitShots.n + combat.orbitShields.n + combat.orbitShots.bolts.count + combat.orbitShots.halos.count).toBe(0);
  });

  it('emits hull sparks, a small scorch and debris exactly once per shot despite sustained pulse trains', () => {
    applyFade(3);
    const combat = new Combat(undefined, 48, terrain), source = orbitTrack('e_901', 'lancer', 'nw', 20), target = orbitTrack('e_902', 'skiff', 'se', 26, 0);
    combat.tracks = new Map([[source.e.id, source], [target.e.id, target]]);
    combat.ingest(view([{ ...shot('beam', 20), subject: 'lancer', plane: 'orbit', tp: 'orbit' }]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.sparks.n).toBe(7);
    expect(combat.debris.n).toBe(1);
    expect(combat.rings.n).toBe(1);
    expect(combat.orbitShields.n).toBe(0);
    combat.frame(1000, 0, 100, 20);
    target.rx = 27;
    combat.frame(1110, 0, 100, 22.2);
    expect(combat.sparks.n).toBe(7);
    expect(combat.debris.n).toBe(1);
    expect(combat.rings.mesh.instanceMatrix.array[12]).toBeCloseTo(3);
    target.visible = false;
    combat.frame(1120, 0, 100, 22.4);
    expect(combat.rings.n).toBe(0);
  });

  it('keeps pulse admissions and geometry bounded and skips stale impacts', () => {
    applyFade(3);
    const combat = new Combat(undefined, 48, terrain);
    for (let i = 0; i < 200; i++) combat.orbitShots.add('bastion', undefined, undefined, 1000, 1000, 0, 30, 0, 4, 30, 0, pigment, 3);
    expect(combat.orbitShots.n).toBe(128);
    combat.frame(1010, 0, 100, 20.2);
    expect(combat.orbitShots.bolts.count).toBe(128 * 4);
    expect(combat.orbitShots.halos.count).toBe(128 * 4);
    combat.reset();
    combat.orbitShots.add('lancer', undefined, undefined, 1000, 1000, 0, 30, 0, 4, 30, 0, pigment, 3);
    combat.frame(1500, 0, 100, 30);
    expect(combat.sparks.n + combat.debris.n + combat.rings.n).toBe(0);
    combat.frame(1620, 0, 100, 32.4);
    expect(combat.orbitShots.n).toBe(0);
  });

  it('rejects ambiguous visible FX endpoints and retires an idle shooter without overriding its aim', () => {
    applyFade(3);
    const source = orbitTrack('e_901', 'bastion', 'nw', 20), target = orbitTrack('e_902', 'skiff', 'se', 26), duplicate = orbitTrack('e_903', 'skiff', 'se', 26);
    source.aim = 0.7; source.e.aim = 0.7;
    const combat = new Combat(undefined, 48, terrain);
    combat.tracks = new Map([[source.e.id, source], [target.e.id, target], [duplicate.e.id, duplicate]]);
    const event: Fx = { ...shot('point_defence', 20), subject: 'bastion', plane: 'orbit', tp: 'orbit' };
    combat.ingest(view([event]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.orbitShots.n).toBe(0);
    combat.reset();
    duplicate.visible = false;
    combat.ingest(view([event]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.orbitShots.n).toBe(1);
    expect(source.aim).toBe(0.7);
    expect(source.e.aim).toBe(0.7);
    source.e.state = 'idle';
    combat.frame(1010, 0, 100, 20.2);
    expect(combat.orbitShots.n).toBe(0);
  });

  it('launches each physical flak barrel once while only one produces an impact burst', () => {
    const combat = new Combat(undefined, 48, terrain), source = orbitTrack('e_904', 'bastion', 'nw', 20);
    source.e = { ...source.e, kind: 'flak', plane: 'surface' };
    source.wy = unitY('surface') + groundAt(20, 24, terrain);
    source.fireAt = 1000;
    combat.tracks = new Map([[source.e.id, source]]);
    combat.ingest(view([{ ...shot('flak'), subject: 'flak', tp: 'sky' }]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.shots.bodies.count).toBe(2);
    expect(combat.sparks.n).toBe(2);
    const muzzle = new Float64Array(3);
    for (let barrel = 0; barrel < 2; barrel++) {
      expect(orbitMuzzle(muzzle,source,barrel,1000,48)).toBe(2);
      close(head(combat.shots.bodies.instanceMatrix.array, barrel), Array.from(muzzle));
    }
    combat.frame(1500, 0, 100, 30);
    expect(combat.smoke.n).toBe(4); // one fragmentation burst, not one per cosmetic barrel
    expect(combat.sparks.n).toBe(11); // two muzzles + one nine-spark hit
    expect(combat.shots.n).toBe(0);
  });

  it('leaves an expanding debris ring and a cold vacuum flash on an Orbit kill, not a smoke column', () => {
    const combat = new Combat(undefined, 48, terrain);
    combat.ingest(view([{ kind: 'death', tick: 20, subject: 'lancer', plane: 'orbit', x: 24, y: 24 }]), clock);
    combat.frame(1000, 0, 100, 20);
    expect(combat.debris.n).toBe(22); // cold hull plates and the army's colour
    expect(combat.sparks.n).toBe(27); // the white-hot flash, sixteen sparks and ten cold glints (the cold flash is 60 ms on)
    expect(combat.rings.n).toBe(2);
    expect(combat.smoke.n).toBe(0);
    combat.frame(3500, 2.5, 100, 70); // the slowest plates drift for up to 2.2 s
    expect(combat.debris.n + combat.sparks.n + combat.rings.n).toBe(0);
  });
});
