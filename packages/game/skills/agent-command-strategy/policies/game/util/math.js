// Agent Command's built-in bot library: packages/game/src/util/math.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/** Small numeric helpers shared by the sim, observations and bots: rounding, distance, angles and float tolerances. */

/** Two-decimal rounding of presented scalars (rates, progress, shields, headings); positions use `gridPosition`. */
export const round2 = (v) => Math.round(v * 100) / 100;

/**
 * `v` on the binary grid of 1/`steps` tile (`steps` a power of two), ties to even. A binary grid is closed under the
 * map's quarter turns (size − v is exact, and half-to-even rounding commutes with it since size·steps is even), so
 * rotated twins land on exact rotations. A decimal grid is not (48 − 13.9 ≠ 34.1 in binary floats): twins' distances
 * differed in the last bit and flipped mirrored decisions at thresholds.
 */
export function onGrid(v, steps) {
  const s = v * steps;
  const f = Math.floor(s);
  const d = s - f;
  return (d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f) / steps;
}

/**
 * A presented position on a `size` map: `v` on the 1/`steps` grid (onGrid), never on a cell edge. On an integer,
 * floor would put rotated twins in different cells (floor(size − n) = size − n, not size − 1 − floor(n)), so a grid
 * point on an edge moves one step to the side `v` lies on (floor still names the cell it is in), or toward the map
 * centre when `v` is exactly on the edge; only the centre line itself (a fixed point of every turn) stays.
 */
export function gridPosition(v, steps, size) {
  const p = onGrid(v, steps);
  if (p !== Math.floor(p)) return p;
  const side = v !== p ? v - p : size / 2 - p;
  return side > 0 ? p + 1 / steps : side < 0 ? p - 1 / steps : p;
}

/**
 * Length of the vector (`dx`, `dy`), bit-identical on every engine: ECMA-262 (2025 on) defines `Math.sqrt` as the
 * correctly rounded square root (𝔽 of the exact root; IEEE 754 requires the same of hardware and libm), and `*`, `+`
 * round to nearest-even, so unlike `Math.hypot` (implementation-approximated) nothing here varies between engines,
 * and it costs a fraction of fdlibm's `dmath.hypot`. Without hypot's scaling, squares overflow only beyond 1e154,
 * nowhere near map coordinates and speeds.
 */
export const norm = (dx, dy) => Math.sqrt(dx * dx + dy * dy);

/** Squared length of (`dx`, `dy`): threshold tests compare it with the squared threshold (`sq`) and take no root. */
export const norm2 = (dx, dy) => dx * dx + dy * dy;

/** Euclidean distance between two points. */
export const dist = (a, b) => norm(a.x - b.x, a.y - b.y);

/** `v` squared, exactly `v * v`: `**` is the engine's pow, which differs between engines. */
export const sq = (v) => v * v;

/** Geometric tolerance (tiles, or a dimensionless line parameter): lengths and gaps below it count as zero. */
export const GEOM_EPS = 1e-9;

/** Velocity components (tiles/tick) whose magnitude is below this are flushed to exactly zero. */
export const ZERO_EPS = 1e-12;

/** One full turn (radians). */
export const TAU = Math.PI * 2;

/**
 * Brings an angle (radians) within one turn of zero back into [-π, π] with at most one correction each way: callers
 * pass a `% TAU` remainder or a bearing that moved by less than a turn. No modulo here, so a sum stays bit-exact.
 */
export function wrapPi(a) {
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}
