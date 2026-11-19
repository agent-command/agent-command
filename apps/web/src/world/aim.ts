/**
 * Shots between planes (docs/art/DIRECTIONS.md "Shots between planes"). Where a shot that leaves its own plane, or hits
 * a falling rock, visibly ends in 3D. One resolver feeds both the tracer (`combat.ts`) and the mount's barrel elevation
 * (`entities.ts`), so a barrel always points where its own tracer goes. Same-plane shots at ordinary targets are not
 * resolved here and keep their nominal endpoints.
 *
 * Fog: FX carry positions, not identities. A target track is matched only against this view's own tracks (what the
 * team already knows); falling rocks and their trajectories are public.
 */
import type { Plane, View } from '@agent-command/game/contract';
import { unitY, wx, wz } from './common.ts';
import { asteroidPosition, type Fall } from './asteroid.ts';
import { groundAt, type TerrainField } from './terrain.ts';
import type { Track } from './entities.ts';

type FxEntry = View['fx'][number];

/** FX has positions, not identities. Match only unique received poses at the event tick, never nearby guesses. */
export function shotDistance(tr: Track, tick: number, x: number, y: number, elevation?: number): number {
  let px = tr.e.x, py = tr.e.y, height = tr.e.elevation ?? 0;
  if (tr.n > 1 && tick >= tr.st[0]! && tick < tr.st[tr.n - 1]!) {
    for (let i = 1; i < tr.n; i++) {
      if (tick > tr.st[i]!) continue;
      const u = (tick - tr.st[i - 1]!) / Math.max(1, tr.st[i]! - tr.st[i - 1]!);
      px = tr.sx[i - 1]! + (tr.sx[i]! - tr.sx[i - 1]!) * u;
      py = tr.sy[i - 1]! + (tr.sy[i]! - tr.sy[i - 1]!) * u;
      if (tr.sh) height = tr.sh[i - 1]! + (tr.sh[i]! - tr.sh[i - 1]!) * u;
      break;
    }
  }
  return (px - x) ** 2 + (py - y) ** 2 + (elevation === undefined ? 0 : (height - elevation) ** 2);
}

/** Exact-pose tolerance for unit targets (tiles²): the wire grid, as everywhere FX meet tracks. */
const UNIT_MATCH = 1 / 256 ** 2;
/**
 * A falling rock moves fast along a straight logical path, and its interpolated track and the shot's target point are
 * both wire-rounded: match within a quarter tile (tiles²). Falls are public, so a near miss reveals nothing.
 */
const ROCK_MATCH = 0.25 ** 2;
/** Body centre above a target's standing height, in model units (× its drawn scale). */
export const BODY_CENTRE = 0.2;

/** Nominal body height of an unmatched target on `plane` (the drawn hover of an ordinary unit there). */
export function nominalBodyY(plane: Plane, x: number, y: number, terrain: TerrainField): number {
  return unitY(plane) + (plane === 'sky' ? 1.6 : plane === 'orbit' ? 0.2 : 0.35) + (plane === 'surface' ? groundAt(x, y, terrain) : 0);
}

/** A resolved 3D shot end (world units) and what it is: a falling rock (`fall`), a known unit (`target`), or neither. */
export interface ShotAim {
  x: number;
  y: number;
  z: number;
  fall: Fall | undefined;
  target: Track | undefined;
}

export function shotAim(): ShotAim {
  return { x: 0, y: 0, z: 0, fall: undefined, target: undefined };
}

const ROCK = { x: 0, y: 0, z: 0 };

/**
 * Resolve `f`'s visible 3D end into `out`: a falling rock where it is drawn when the shot arrives, or a target on
 * another plane or elevation at its body (its live track height when this view has it). Ordinary same-plane,
 * same-height shots retain their existing lightweight path.
 *
 * Unseen shooters expose only the target (`plane`, `x`, `y`): only a falling rock can be resolved for them.
 */
export function crossPlaneAim(out: ShotAim, f: FxEntry, impacts: View['impacts'], tracks: ReadonlyMap<string, Track> | undefined, size: number, terrain: TerrainField): boolean {
  out.fall = undefined;
  out.target = undefined;
  const seen = f.tp !== undefined && f.tx !== undefined && f.ty !== undefined;
  const tp = seen ? f.tp! : f.plane, tx = seen ? f.tx! : f.x, ty = seen ? f.ty! : f.y;
  // Falling rocks are Sky-plane payloads in the sim but drawn on their own descent from the Orbit.
  if (tp === 'sky' && tracks) {
    let nearest = ROCK_MATCH;
    for (const fall of impacts) {
      const rock = tracks.get(fall.id);
      if (!rock) continue;
      const d = shotDistance(rock, f.tick, tx, ty);
      if (d < nearest) { nearest = d; out.fall = fall; }
    }
    if (out.fall) {
      asteroidPosition(out.fall, f.arrive ?? f.tick, ROCK, size);
      out.x = ROCK.x; out.y = ROCK.y; out.z = ROCK.z;
      return true;
    }
  }
  if (!seen || (tp === f.plane && f.targetElevation === undefined && f.sourceElevation === undefined)) return false;
  let nearest = UNIT_MATCH, ambiguous = false;
  if (tracks) {
    for (const tr of tracks.values()) {
      if (tr.e.plane !== tp || tr.e.kind === 'asteroid' || (f.side && tr.e.side === f.side)) continue;
      const d = shotDistance(tr, f.tick, tx, ty, f.targetElevation);
      if (d < nearest - 1e-10) { nearest = d; out.target = tr; ambiguous = false; }
      else if (Math.abs(d - nearest) <= 1e-10) ambiguous = true;
    }
    if (ambiguous) out.target = undefined;
  }
  out.x = wx(tx, size);
  out.z = wz(ty, size);
  out.y = out.target ? out.target.wy + BODY_CENTRE * out.target.scale : nominalBodyY(tp, tx, ty, terrain) + (f.targetElevation ?? 0);
  return true;
}
