import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three/webgpu';
import { STATS, type Entity } from '@agent-command/game/contract';
import { orbitMuzzle, stepMountAim, type Track } from '../src/world/entities.ts';
import { BASTION_PD, RIG } from '../src/world/models.ts';
import { clockAt } from '../src/world/materials.ts';
import { wx, wz } from '../src/world/common.ts';

function track(kind: 'bastion' | 'turret' | 'flak' | 'skiff' = 'bastion'): Track {
  return { e: { kind, state: 'idle', plane: 'orbit' } as Entity, rx: 17, ry: 23, wy: 15,
    scale: 2.4, heading: 0, aim: 0, bank: 0, pitch: 0, phase: 0.7, mountPitch: 0, aimUntil: -Infinity, aimX: 0, aimY: 0, aimZ: 0,
    speed: 0, odo: 0, fireAt: -1e9, hitAt: -1e9 } as Track;
}
const NO_TRACKS = new Map<string, Track>();
function step(tr: Track, dt: number): void {
  stepMountAim(tr, dt, 0, 0, 48, NO_TRACKS);
}

describe('hull-attached orbital mounts', () => {
  it('keeps both PD pivots fixed in hull space through bank, yaw, pitch and independent traverse', () => {
    const tr = track();
    const out = new Float64Array(3);
    const now = 1000;
    const bob = Math.sin(clockAt(now) * 0.9 + tr.phase) * RIG.bastion.hover!;
    for (const heading of [0, 0.9, -2.4]) for (const bank of [-0.08, 0, 0.08]) for (const aim of [-1.7, 0.3, 2.8]) {
      tr.heading = heading; tr.bank = bank; tr.pitch = 0.12; tr.aim = aim;
      const hull = new Matrix4();
      // Rig order is pitch about Z, then bank about X, then world heading about Y.
      hull.makeRotationZ(tr.pitch).premultiply(new Matrix4().makeRotationX(bank)).premultiply(new Matrix4().makeRotationY(-heading));
      for (let index = 0; index < 2; index++) {
        expect(orbitMuzzle(out,tr,index,now,48)).toBe(2);
        const local = new Vector3(out[0]! - wx(tr.rx,48), out[1]! - tr.wy, out[2]! - wz(tr.ry,48))
          .applyMatrix4(hull.clone().invert()).divideScalar(tr.scale);
        const yaw = heading - aim;
        const reach = BASTION_PD.tip - BASTION_PD.x;
        // Removing barrel-local reach must recover the unmoving shoulder, not a shared centre orbit.
        expect(local.x - Math.cos(yaw) * reach).toBeCloseTo(BASTION_PD.x, 8);
        expect(local.y - bob).toBeCloseTo(BASTION_PD.height, 8);
        expect(local.z + Math.sin(yaw) * reach).toBeCloseTo((index === 0 ? -1 : 1) * BASTION_PD.z, 8);
      }
    }
  });

  it.each([['flak', 0.16], ['skiff', 0.20]] as const)('attaches both %s barrels without collapsing their hull-local separation', (kind, separation) => {
    const tr = track(kind);
    tr.heading = 1.3; tr.aim = -0.9; tr.bank = 0.07; tr.pitch = -0.03;
    const a = new Float64Array(3), b = new Float64Array(3);
    expect(orbitMuzzle(a,tr,0,1000,48)).toBe(2);
    expect(orbitMuzzle(b,tr,1,1000,48)).toBe(2);
    expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)).toBeCloseTo(separation * tr.scale, 8);
  });

  it('smoothly tracks exposed bearings within each mount traverse rate and returns idle guns forward', () => {
    for (const kind of ['bastion', 'turret', 'flak'] as const) {
      const tr = track(kind);
      tr.e.state = 'attacking';
      tr.e.aim = Math.PI;
      const mount = STATS[kind].mount;
      if (mount?.kind !== 'turret') throw new Error(`${kind} must have a traversing mount`);
      step(tr, 0.01);
      expect(tr.aim).toBeGreaterThan(0);
      expect(tr.aim).toBeLessThanOrEqual(mount.traverse * 0.01);
      const aimed = tr.aim;
      tr.e.state = 'idle';
      tr.e.aim = 2;
      step(tr, 0.01);
      expect(tr.aim).toBeLessThan(aimed);
      tr.e.state = 'attacking';
      step(tr, 0.01);
      expect(tr.aim).toBeGreaterThan(0);
    }
  });
});
