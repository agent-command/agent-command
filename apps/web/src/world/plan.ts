/**
 * The plannable world on the client: island drift paths and the sun are public, deterministic schedules, so the
 * renderer can draw where things will be (the same formulas agents get as exact data).
 */
/** Seconds of island drift previewed ahead. */
export const PATH_AHEAD_S = 60;
/** Seconds of sunlight previewed ahead (dawn / dusk bands). */
export const SUN_AHEAD_S = 20;

/**
 * Seconds until a point whose bearing offset from the nearer wedge centre is `o` (contract `sunOffset`) enters
 * (`enter`) or leaves a lit wedge of half-width `half`, with the wedges turning at `speed` rad/s.
 */
export function sunEdgeIn(o: number, half: number, speed: number, enter: boolean): number {
  if (!speed) return Infinity;
  // a fixed point's offset decreases as the wedges turn with positive speed; mirror for negative speed
  const off = speed > 0 ? o : -o;
  if (!enter) return (off + half) / Math.abs(speed);
  const d = off - half;
  return ((((d % Math.PI) + Math.PI) % Math.PI) || Math.PI) / Math.abs(speed);
}