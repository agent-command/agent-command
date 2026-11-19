/**
 * Timed plane visits (any `TRANSITS` entry with a stay, e.g. an ascent raid in Orbit) end with an instant server hop to
 * `transit.return`. These pure derivations turn the public transit fields into the presentation states around it: the
 * expiry warning, the dive from the visited plane and the arrival on the return plane. Fog: a hop is only derived from
 * two snapshots of an entity this view saw; an entity that vanished at its return tick yields an unseen arrival.
 */
import { TICK_RATE, type ArmyId, type Entity, type Kind, type Plane, type View } from '@agent-command/game/contract';

/** The last stretch of a timed visit that warns of the automatic return (ticks). */
export const RETURN_WARN = 3 * TICK_RATE;
/** The presentation-only dive from the visited plane to the return plane after the server hop (ticks). */
export const RETURN_DIVE = Math.round(0.8 * TICK_RATE);
/** The departure ring and dive trail fade out over this long after the dive (ticks). */
export const RETURN_LINGER = Math.round(1.2 * TICK_RATE);

type Transiting = Pick<Entity, 'plane' | 'transit'>;

/** Ticks until an arrived timed visit returns, or -1 when `e` is not on a timed visit with a return plane. */
export function returnLeft(e: Transiting, tick: number): number {
  const t = e.transit;
  if (!t || !t.until || !t.return || t.return === e.plane || e.plane !== t.to || t.at > tick) return -1;
  return Math.max(0, t.until - tick);
}

/** Warning progress over the last RETURN_WARN ticks: 0 as it starts … 1 at the return; -1 outside the window. */
export function returnWarning(e: Transiting, tick: number): number {
  return countdownWarning(returnLeft(e, tick));
}

/**
 * Progress through the last RETURN_WARN ticks before any public countdown runs out (`left` ticks; negative = none):
 * 0 as the warning starts … 1 at zero; -1 outside the window. Timed visits and the derelict's gates share it.
 */
export function countdownWarning(left: number): number {
  return left < 0 || left > RETURN_WARN ? -1 : 1 - left / RETURN_WARN;
}

/** Whole seconds left on the warning countdown (never 0 while still visiting). */
export function returnSeconds(left: number): number {
  return Math.max(1, Math.ceil(left / TICK_RATE));
}

export interface ReturnHop {
  from: Plane;
  to: Plane;
  /** server tick of the return (the visit's `until`) */
  tick: number;
  /** the entity is visible on the return plane in this view */
  seen: boolean;
}

/**
 * A timed visit that ended between two snapshots of one entity: `next` is its newer snapshot, or undefined when it left
 * this view at snapshot `tick` (an enemy falling into fog), which only counts once its return tick has passed.
 */
export function returnHop(prev: Transiting, next: Transiting | undefined, tick: number): ReturnHop | undefined {
  const t = prev.transit;
  if (!t || !t.until || !t.return || t.return === prev.plane || prev.plane !== t.to) return undefined;
  if (!next) return tick >= t.until ? { from: prev.plane, to: t.return, tick: t.until, seen: false } : undefined;
  if (next.plane !== t.return || next.transit?.until) return undefined;
  return { from: prev.plane, to: t.return, tick: t.until, seen: true };
}

/**
 * The dive from a hop's visited plane to its return plane at render tick `rt`: 0 before the return tick … 1 landed.
 * Eased in, like a fall that gathers speed.
 */
export function diveProgress(rt: number, hopTick: number): number {
  const u = Math.min(1, Math.max(0, (rt - hopTick) / RETURN_DIVE));
  return u * u;
}

/**
 * Opacity of the departure ring and trail at render tick `rt`: held at 1 until the return tick is on screen (the ring
 * takes over from the visit's own mark), then fading to 0 over the dive and linger.
 */
export function hopFade(rt: number, hopTick: number): number {
  const u = (rt - hopTick) / (RETURN_DIVE + RETURN_LINGER);
  return u <= 0 ? 1 : Math.max(0, 1 - u);
}

/** Own units of one kind that came back to `plane` together at `tick` (one feed line). */
export interface ReturnArrival {
  tick: number;
  plane: Plane;
  x: number;
  y: number;
  subject: Kind;
  side: ArmyId;
  count: number;
}

type Snapshot = Pick<View, 'army' | 'tick' | 'entities'>;

/** The viewing army's own returns between two consecutive views of that army, grouped per return tick, plane and kind. */
export function returnArrivals(prev: Snapshot, next: Snapshot): ReturnArrival[] {
  const out: ReturnArrival[] = [];
  if (prev.army !== next.army || next.tick <= prev.tick) return out;
  let visiting: Map<string, Entity> | undefined;
  for (const e of prev.entities) if (e.side === prev.army && returnLeft(e, prev.tick) >= 0) (visiting ??= new Map()).set(e.id, e);
  if (!visiting) return out;
  for (const e of next.entities) {
    const before = visiting.get(e.id);
    const hop = before && returnHop(before, e, next.tick);
    if (!hop) continue;
    const same = out.find((a) => a.tick === hop.tick && a.plane === hop.to && a.subject === e.kind);
    if (same) same.count++;
    else out.push({ tick: hop.tick, plane: hop.to, x: e.x, y: e.y, subject: e.kind, side: next.army, count: 1 });
  }
  return out;
}
