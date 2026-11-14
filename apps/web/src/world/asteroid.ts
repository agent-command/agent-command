import { ECON, PLANE_Y, TICK_RATE, type Entity, type View } from '@agent-command/game/contract';
import { Euler, Matrix4, Ray, Vector3 } from 'three/webgpu';
import { wx, wz } from './common.ts';
import { clockAt } from './materials.ts';
import { model } from './models.ts';
import type { Track } from './entities.ts';

export type Fall = NonNullable<View['fx'][number]['fall']>;

/** Missing vision metadata keeps the ordinary, unidentified rock silhouette and paint. */
export function rockScale(rock: Pick<Entity, 'rockSize'>): number {
  return rock.rockSize === 'pebble' ? 0.55 : rock.rockSize === 'large' ? 1.55 : 1;
}

/**
 * Per-rock shape variation: one cached rock stretched along its own axes before it tumbles, each axis by
 * 1 + amp · wave(phase · rate) (sin, sin, cos), so neighbouring rocks never read as clones. The vertex rig (`rig.ts`)
 * applies the same factors.
 */
export const ROCK_STRETCH = { x: { amp: 0.25, rate: 3.1 }, y: { amp: 0.2, rate: 5.3 }, z: { amp: 0.22, rate: 2.7 } } as const;

/** The stretch of the rock with idle phase `phase` (`Track.phase`), into `out`. */
export function rockStretch(phase: number, out: { x: number; y: number; z: number }): typeof out {
  out.x = 1 + ROCK_STRETCH.x.amp * Math.sin(phase * ROCK_STRETCH.x.rate);
  out.y = 1 + ROCK_STRETCH.y.amp * Math.sin(phase * ROCK_STRETCH.y.rate);
  out.z = 1 + ROCK_STRETCH.z.amp * Math.cos(phase * ROCK_STRETCH.z.rate);
  return out;
}

// Shared draw-thread scratch: one cached low-poly mesh, no per-beam geometry/vector allocations.
const surfaceRay = new Ray(), surfaceTransform = new Matrix4(), surfaceInverse = new Matrix4();
const surfaceRotation = new Euler(), surfaceScale = new Vector3(), surfaceShift = new Vector3();
const surfaceA = new Vector3(), surfaceB = new Vector3(), surfaceC = new Vector3();
const surfaceHit = new Vector3(), surfaceNearest = new Vector3(), surfaceStretch = { x: 1, y: 1, z: 1 };

/** First actual rendered rock triangle along a mining ray, including scale, tumbling and hit flinch. */
export function miningSurface(out: Float64Array, origin: Float64Array, rock: Pick<Track, 'rx' | 'ry' | 'wy' | 'scale' | 'phase' | 'hitAt'>, now: number, size: number): boolean {
  const t = clockAt(now), hit = Math.max(0, Math.min(1, 1 - (now - rock.hitAt) / 250));
  // Exactly rig.ts's rotX(rotY(rotZ(p, phase*2), t*.2), t*.3+phase).
  surfaceRotation.set(t * 0.3 + rock.phase, t * 0.2, rock.phase * 2, 'XYZ');
  surfaceTransform.makeRotationFromEuler(surfaceRotation);
  rockStretch(rock.phase, surfaceStretch);
  surfaceScale.set(rock.scale * surfaceStretch.x, rock.scale * (1 - hit * 0.06) * surfaceStretch.y, rock.scale * surfaceStretch.z);
  surfaceTransform.scale(surfaceScale);
  surfaceShift.set(0, 0, Math.sin(t * 60) * 0.03 * hit * rock.scale * surfaceStretch.z).applyEuler(surfaceRotation);
  surfaceTransform.setPosition(wx(rock.rx, size) + surfaceShift.x, rock.wy + surfaceShift.y, wz(rock.ry, size) + surfaceShift.z);
  surfaceInverse.copy(surfaceTransform).invert();
  surfaceRay.origin.set(origin[0]!, origin[1]!, origin[2]!).applyMatrix4(surfaceInverse);
  surfaceRay.direction.copy(surfaceRay.origin).negate().normalize();
  const geometry = model('asteroid'), positions = geometry.getAttribute('position'), index = geometry.index;
  let nearest = Infinity;
  for (let i = 0, n = index?.count ?? positions.count; i < n; i += 3) {
    surfaceA.fromBufferAttribute(positions, index ? index.getX(i) : i);
    surfaceB.fromBufferAttribute(positions, index ? index.getX(i + 1) : i + 1);
    surfaceC.fromBufferAttribute(positions, index ? index.getX(i + 2) : i + 2);
    if (!surfaceRay.intersectTriangle(surfaceA, surfaceB, surfaceC, false, surfaceHit)) continue;
    const distance = surfaceRay.origin.distanceToSquared(surfaceHit);
    if (distance < nearest) { nearest = distance; surfaceNearest.copy(surfaceHit); }
  }
  if (!Number.isFinite(nearest)) return false;
  surfaceNearest.applyMatrix4(surfaceTransform);
  out[0] = surfaceNearest.x; out[1] = surfaceNearest.y; out[2] = surfaceNearest.z;
  return true;
}

/** Model-state channel contains only the explicitly observed resource, never inferred from hull. */
export function rockResource(rock: Pick<Entity, 'resourceType'>): number {
  return rock.resourceType === 'metal' ? 0.5 : rock.resourceType === 'ice' ? 1 : 0;
}

/** Only an explicitly observed Orbit fuse can drive a countdown or glow; towing/HP are not evidence. */
export function rockFuseLeft(rock: Pick<Entity, 'plane' | 'volatile' | 'fuseUntil'>, tick: number): number {
  return rock.plane === 'orbit' && rock.volatile === true && rock.fuseUntil !== undefined
    ? Math.max(0, (rock.fuseUntil - tick) / TICK_RATE) : -1;
}

/** Zero means inactive; an active fuse grows from a dim crackle to a hot bloom without allocating. */
export function rockFuseGlow(rock: Pick<Entity, 'plane' | 'volatile' | 'fuseUntil'>, tick: number, duration: number): number {
  const left = rockFuseLeft(rock, tick);
  return left < 0 ? (rock.volatile === true ? 0.12 : 0) : 0.25 + 0.75 * (1 - Math.min(1, left / duration));
}

/** Snapshot-time cosmetic metadata: the public fall never identifies hidden resources or volatility. */
export function impactLook(view: View, event: View['fx'][number]): { radius: number; volatile: boolean } {
  const rules = view.match!.rules.orbit;
  const rock = event.fall ? view.entities.find(e => e.id === event.fall!.id) : undefined;
  const volatile = rock?.volatile === true;
  const base = event.fall?.radius ?? rules.impactRadius;
  let radius = base * (volatile ? rules.volatileRadiusMultiplier : 1);
  // The rock may have disappeared. Match only a fog-filtered scorch created at this impact tick.
  if (event.plane === 'surface') {
    for (const scorch of view.scorches ?? []) {
      if (Math.abs(scorch.until - (event.tick + rules.scorchDuration * TICK_RATE)) <= 1 && Math.abs(scorch.x - event.x) < 0.01 && Math.abs(scorch.y - event.y) < 0.01) {
        radius = Math.max(radius, scorch.radius);
        return { radius, volatile: true };
      }
    }
  }
  return { radius, volatile };
}

/**
 * Sample the visual rock's center in world units, returning normalized descent time for the trail length.
 * `fall.tick` is the scheduled landing; `tick` is the fractional render tick (or the exact destruction tick).
 * Quadratic descent preserves the accelerating fall; the 6×3-unit approach offset makes its trail readable
 * from above and vanishes at landing. This is intentionally not the sim's logical sky-plane attack position.
 * Clamping holds at launch/landing under delayed snapshots; the caller controls visibility at termination.
 * Write into caller-owned storage so each rendered rock needs no per-frame position allocation.
 */
export function asteroidPosition(fall: Fall, tick: number, out: { x: number; y: number; z: number }, size: number): number {
  const p = Math.max(0, Math.min(1, 1 - (fall.tick - tick) / Math.max(1, fall.tick - (fall.start ?? fall.tick - ECON.impactTicks))));
  const descent = p * p;
  const off = (1 - descent) * 6;
  out.x = wx(fall.x, size) - off;
  out.y = PLANE_Y.orbit + (PLANE_Y.surface - PLANE_Y.orbit) * descent + 0.6;
  out.z = wz(fall.y, size) - off * 0.5;
  return p;
}
