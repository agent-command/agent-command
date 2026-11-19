/**
 * The derelict ruin at the map centre (DESIGN §4.4): static hull band with axis breaches, a ring of gates that opens
 * on a public cycle, the chamber inside. Pure functions of the public geometry (`matchData.derelict`) and the tick,
 * shared by the sim, bots, policies and the client. Coordinates are relative to the ruin centre; every test works on
 * the point folded into one quarter (exact quarter turns), so rotated twins get bit-identical answers.
 */
import { dmath } from '../util/fdlibm.js';
import { norm } from '../util/math.ts';
import type { Econ } from './econ.ts';
import { SPIRE_CORNER, type StatKind, type Stats } from './stats.ts';
import type { SpirePositions } from './terrain.ts';
import { MAP_SIZES, UNIT_KINDS } from './vocabulary.ts';

/** Clearance (tiles) kept between a hull, ring or aperture edge and a body steering past it. */
export const WALL_CLEAR = 0.15;

/**
 * The narrowest breach or gate a body of `radius` lines up on and crosses: its body plus twice WALL_CLEAR on each side
 * (routing waits at the mouth and aims through with that clearance).
 */
export const passWidth = (radius: number): number => 2 * (radius + 2 * WALL_CLEAR);

/** Public ruin geometry (tiles, scaled to the map; durations in ticks), as `matchData.derelict` carries it. */
export interface DerelictGeometry {
  readonly x: number;
  readonly y: number;
  readonly hullInner: number;
  readonly hullOuter: number;
  readonly breaches: number;
  readonly breachWidth: number;
  readonly ringInner: number;
  readonly ringOuter: number;
  readonly gates: number;
  readonly gateWidth: number;
  /** open window, each ring turn and the sealed span of one cycle (ticks); the cycle starts open at tick 0 */
  readonly open: number;
  readonly turn: number;
  readonly closed: number;
}

/** Ruin layers by radius: inside the ring, between ring and hull, beyond the hull. */
export const CHAMBER = 0;
export const CORRIDOR = 1;
export const OUTSIDE = 2;

/** The widest Orbit ship's radius (tiles): what the ruin's breaches and gates must pass. */
export function widestOrbitShip(stats: Readonly<Record<StatKind, Stats>>): number {
  let r = 0;
  for (const kind of UNIT_KINDS) if (stats[kind].plane === 'orbit') r = Math.max(r, stats[kind].radius);
  return r;
}

/**
 * Map tiles per S48 ruin tile: size / 48, or less where the Spires stand closer to the centre (spireInset), so that
 * the hull plus derelictLane stays inside every Spire's Orbit reach — the segment beam's reach to the widest Orbit
 * ship and a tug's body at the deorbit stand-off (halfway between the beam's reach to a tug and deorbitRange, where
 * bots release strikes). The beam reaches from the footprint edge: farthest on the diagonal,
 * toward the centre. Every Spire stands equally far out, on two-slot and four-slot maps alike.
 */
export function derelictScale(econ: Econ, stats: Readonly<Record<StatKind, Stats>>, spires: SpirePositions, size: number): number {
  const spire = norm(spires.nw.x - size / 2, spires.nw.y - size / 2);
  const beam = stats.spire.range + SPIRE_CORNER;
  const tug = stats.tug.radius;
  const reach = Math.max(beam + widestOrbitShip(stats), (beam + tug + econ.deorbitRange) / 2 + tug);
  return Math.min(size / MAP_SIZES[0], (spire - reach) / (econ.derelictHullOuter + econ.derelictLane));
}

export function derelictGeometry(econ: Econ, stats: Readonly<Record<StatKind, Stats>>, spires: SpirePositions, size: number): DerelictGeometry {
  const k = derelictScale(econ, stats, spires, size);
  return {
    x: size / 2, y: size / 2,
    hullInner: econ.derelictHullInner * k, hullOuter: econ.derelictHullOuter * k,
    breaches: econ.derelictBreaches, breachWidth: econ.derelictBreachWidth * k,
    ringInner: econ.derelictRingInner * k, ringOuter: econ.derelictRingOuter * k,
    gates: econ.derelictGates, gateWidth: econ.derelictGateWidth * k,
    open: econ.derelictOpen, turn: econ.derelictTurn, closed: econ.derelictClosed,
  };
}

export const derelictPeriod = (g: DerelictGeometry): number => g.open + 2 * g.turn + g.closed;

/** Ticks into the current cycle. */
export const derelictPhase = (g: DerelictGeometry, tick: number): number => ((tick % derelictPeriod(g)) + derelictPeriod(g)) % derelictPeriod(g);

/** Are the gates aligned with the breaches (the chamber passable) on `tick`? */
export const gatesOpen = (g: DerelictGeometry, tick: number): boolean => derelictPhase(g, tick) < g.open;

/** Is the ring turning (sealed and pushing out whatever stands in a gate) on `tick`? */
export function ringTurning(g: DerelictGeometry, tick: number): boolean {
  const p = derelictPhase(g, tick);
  return (p >= g.open && p < g.open + g.turn) || p >= g.open + g.turn + g.closed;
}

/** Ring rotation (rad) from the open alignment: 0 open, half a gate spacing sealed, turning in between (render only). */
export function ringAngle(g: DerelictGeometry, tick: number): number {
  const p = derelictPhase(g, tick);
  const half = Math.PI / g.gates;
  if (p < g.open) return 0;
  if (p < g.open + g.turn) return (half * (p - g.open)) / g.turn;
  if (p < g.open + g.turn + g.closed) return half;
  return half + (half * (p - g.open - g.turn - g.closed)) / g.turn;
}

/** Start tick of the open window `k` windows from now (k = 0: the current one while open, else the next). */
export function openWindow(g: DerelictGeometry, tick: number, k = 0): number {
  const period = derelictPeriod(g);
  const start = tick - derelictPhase(g, tick);
  return (gatesOpen(g, tick) ? start : start + period) + k * period;
}

/** Folded point: the quarter turn of (dx, dy) with x > 0, y ≥ 0, and how many quarter turns undo the fold. */
export const folded = { x: 0, y: 0, turns: 0 };

/** Fold (dx, dy) into the first quarter by exact quarter turns (x, y) → (y, −x); the centre stays put. */
export function fold(dx: number, dy: number): void {
  let x = dx;
  let y = dy;
  let turns = 0;
  if (x !== 0 || y !== 0) {
    while (!(x > 0 && y >= 0)) {
      const t = x;
      x = y;
      y = -t;
      turns++;
    }
  }
  folded.x = x;
  folded.y = y + 0; // fold −0 so twins agree on the sign of zero
  folded.turns = turns;
}

/** Undo `turns` folds of a folded vector (x, y): each step is the quarter turn (x, y) → (−y, x). */
export function unfoldX(turns: number, x: number, y: number): number {
  const t = turns & 3;
  return t === 0 ? x : t === 1 ? -y : t === 2 ? -x : y;
}
export function unfoldY(turns: number, x: number, y: number): number {
  const t = turns & 3;
  return t === 0 ? y : t === 1 ? x : t === 2 ? -y : -x;
}

/** Bearing (rad, in the folded quarter) of the aperture axis nearest the folded point; axes every 2π / n from east. */
export function nearestAxis(n: number, fx: number, fy: number): number {
  if (n === 4) return fy <= fx ? 0 : Math.PI / 2;
  const step = (2 * Math.PI) / n;
  return Math.round(dmath.atan2(fy, fx) / step) * step;
}

/** Distance of the folded point from the nearest aperture axis line. */
export function axisLateral(n: number, fx: number, fy: number): number {
  if (n === 4) return Math.min(fx, fy);
  const a = nearestAxis(n, fx, fy);
  return Math.abs(fy * dmath.cos(a) - fx * dmath.sin(a));
}

/** Layer of a point `r` tiles from the centre: inside the ring's inner edge, inside the hull's inner edge, beyond. */
export function derelictLayer(g: DerelictGeometry, r: number): number {
  return r < (g.ringInner + g.ringOuter) / 2 ? CHAMBER : r < (g.hullInner + g.hullOuter) / 2 ? CORRIDOR : OUTSIDE;
}

/** Is the chamber interior (strictly inside the ring) at relative (dx, dy)? */
export const inChamber = (g: DerelictGeometry, dx: number, dy: number): boolean => dx * dx + dy * dy < g.ringInner * g.ringInner;

/**
 * Does a body of radius `radius` at relative (dx, dy) overlap solid ruin wall? The hull is solid outside its breaches;
 * the ring is solid outside its gates while open and everywhere otherwise (the gates face the hull wall).
 */
export function wallHit(g: DerelictGeometry, open: boolean, dx: number, dy: number, radius: number): boolean {
  const r2 = dx * dx + dy * dy;
  const hull = r2 < dmath.pow(g.hullOuter + radius, 2) && r2 > dmath.pow(Math.max(0, g.hullInner - radius), 2);
  const ring = r2 < dmath.pow(g.ringOuter + radius, 2) && r2 > dmath.pow(Math.max(0, g.ringInner - radius), 2);
  if (!hull && !ring) return false;
  fold(dx, dy);
  if (hull && axisLateral(g.breaches, folded.x, folded.y) + radius > g.breachWidth / 2) return true;
  return ring && (!open || axisLateral(g.gates, folded.x, folded.y) + radius > g.gateWidth / 2);
}

/** Does the segment between relative points a and b cross the wall `R` (mid radius) outside its apertures? */
function crossesWall(n: number, half: number, R: number, ax: number, ay: number, bx: number, by: number): boolean {
  const ux = bx - ax;
  const uy = by - ay;
  const A = ux * ux + uy * uy;
  if (A === 0) return false;
  const B = ax * ux + ay * uy;
  const C = ax * ax + ay * ay - R * R;
  const disc = B * B - A * C;
  if (disc <= 0) return false;
  const s = Math.sqrt(disc);
  for (let k = -1; k <= 1; k += 2) {
    const t = (-B + k * s) / A;
    if (t <= 0 || t >= 1) continue;
    fold(ax + ux * t, ay + uy * t);
    if (axisLateral(n, folded.x, folded.y) > half) return true;
  }
  return false;
}

/**
 * Does a body of `radius` going straight between relative points a and b cross the band from `inner` to `outer`
 * (with `n` apertures `half` wide) only through an aperture, WALL_CLEAR off its sides? Its centre line must cross the
 * band's inner, middle and outer circles that far inside the opening. Routing uses it to cut straight into a breach
 * or gate instead of first turning on the mouth.
 */
export function throughAperture(n: number, half: number, inner: number, outer: number, radius: number, ax: number, ay: number, bx: number, by: number): boolean {
  const h = half - radius - WALL_CLEAR;
  return h > 0 && !crossesWall(n, h, inner, ax, ay, bx, by) && !crossesWall(n, h, (inner + outer) / 2, ax, ay, bx, by) && !crossesWall(n, h, outer, ax, ay, bx, by);
}

/**
 * Line of fire (radius 0) or a body's straight path (its radius) between relative points a and b: blocked where it
 * crosses the hull's mid circle outside a breach, or the ring's mid circle outside an open gate (anywhere while
 * sealed). One quadratic per wall. Orbit sight uses it too while orbit.derelictBlocksVision holds (Sim.stampOrbit).
 */
export function wallBlocks(g: DerelictGeometry, open: boolean, ax: number, ay: number, bx: number, by: number, radius = 0): boolean {
  return crossesWall(g.breaches, g.breachWidth / 2 - radius, (g.hullInner + g.hullOuter) / 2, ax, ay, bx, by)
    || crossesWall(g.gates, open ? g.gateWidth / 2 - radius : -1, (g.ringInner + g.ringOuter) / 2, ax, ay, bx, by);
}

/**
 * Sight between relative points a and b (orbit.derelictBlocksVision): blocked exactly as wallBlocks blocks a line of
 * fire, testing only the walls flagged: a caller that knows a segment cannot cross the hull's or the ring's mid
 * circle skips that wall's quadratic.
 */
export function sightBlocked(g: DerelictGeometry, open: boolean, hull: boolean, ring: boolean, ax: number, ay: number, bx: number, by: number): boolean {
  return (hull && crossesWall(g.breaches, g.breachWidth / 2, (g.hullInner + g.hullOuter) / 2, ax, ay, bx, by))
    || (ring && crossesWall(g.gates, open ? g.gateWidth / 2 : -1, (g.ringInner + g.ringOuter) / 2, ax, ay, bx, by));
}
