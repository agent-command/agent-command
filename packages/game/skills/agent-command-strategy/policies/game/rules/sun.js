// Agent Command's built-in bot library: packages/game/src/rules/sun.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * Public world schedules: the rotating sun wedges and island drift paths, as pure functions of the tick.
 */
import { dmath } from '../util/fdlibm.js';
import { TAU } from '../util/math.js';
import { TICK_RATE } from './vocabulary.js';

/**
 * The sun: `wedges` lit wedges (one per map slot: 2 on C2 maps, 4 on C4) rotating around the map centre, so no slot
 * is favoured. A point is lit iff its bearing from the centre is within the half-width of a wedge's centre line. Half
 * the map is lit, and every point sees the same day/night cycle length and day fraction whatever the wedge count
 * (`rules.econ.sunPeriodTicks` is the cycle seen at a point): more wedges turn proportionally slower.
 */
export const SUN = {
  /** wedge angle at tick 0 (rad, bearing atan2(y - size / 2, x - size / 2) from the map centre): wedge centres on the diagonals, so every corner starts in daylight */
  startAngle: Math.PI / 4,
};
/** Half-width (rad) of each of `wedges` lit wedges: half the map is lit. */
export const sunHalfWidth = (wedges) => Math.PI / (2 * wedges);
/** Wedge speed (rad/s) for a day/night cycle of `periodTicks` at every point with `wedges` wedges. */
export const sunSpeedOf = (periodTicks, wedges) => (TAU / wedges) / (periodTicks / TICK_RATE);
/** Wedge angle (rad, 0..2π) at any tick: the sun is a public schedule. `speed`: the match's `sun.speed` (rad/s). */
export function sunAngleAt(tick, speed) {
  return (((SUN.startAngle + (speed * tick) / TICK_RATE) % TAU) + TAU) % TAU;
}
/** Signed bearing offset (rad, ±π/wedges) of (x, y) from the nearest of `wedges` wedge centre lines at `angle`. */
export function sunOffset(x, y, angle, size, wedges) {
  let dx = x - size / 2;
  let dy = y - size / 2;
  // Fold onto one sector by exact turns first: rotated points then take the exact same path (no rounding asymmetry).
  if (wedges === 2) {
    if (dy < 0 || (dy === 0 && dx < 0)) {
      dx = -dx;
      dy = -dy;
    }
  } else {
    for (let i = 0; i < 3 && !(dx > 0 && dy >= 0); i++) {
      const t = dx;
      dx = dy;
      dy = -t;
    }
  }
  const d = dmath.atan2(dy, dx) - angle;
  const period = TAU / wedges;
  return d - period * Math.round(d / period);
}
/** Is (x, y) in daylight with `wedges` wedges at `angle`? (exactly the rule the sim uses for solar arrays) */
export function sunLit(x, y, angle, size, wedges) {
  return Math.abs(sunOffset(x, y, angle, size, wedges)) < sunHalfWidth(wedges);
}
/** Fully lowered Sky deck offset and vertical island envelope, independent of planar islandClearance. */
export const MOORING_DEPTH = 8;
export const MOORING_ISLAND_HEIGHT = 6;
/** Aircraft must actually reach the deck before capturing or entering its hangar. */
export const MOORING_CAPTURE_HEIGHT = 0.5;

/** Public island position. Vertical mooring pauses the delayed circle indefinitely, without changing its x/y. */
export function islandAt(p, tick, out = { x: 0, y: 0 }) {
  const a = p.phase + (p.speed * (p.pausedAt === undefined ? tick : Math.min(tick, p.pausedAt))) / TICK_RATE;
  out.x = p.cx + p.r * dmath.cos(a);
  out.y = p.cy + p.r * dmath.sin(a);
  return out;
}
