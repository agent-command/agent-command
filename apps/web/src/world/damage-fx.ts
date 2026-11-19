/**
 * The damaged look (HP-driven, presentation only): soot smoke below half health, sparks below a quarter and fire on
 * structures below `fire`, each emitted into the shared particle pools at a rate that grows as health falls. Orbit
 * hulls only spark (no air to carry smoke or flame, as their deaths, `death-profiles.ts`).
 */
import type { Plane } from '@agent-command/game/contract';

/** HP fractions where each effect starts, and its emission rate (particles/s) at zero health. */
export const DAMAGE = {
  smoke: { below: 0.5, rate: 10 },
  sparks: { below: 0.25, rate: 10 },
  fire: { below: 0.35, rate: 12 },
} as const;

export interface DamageRates { smoke: number; sparks: number; fire: number }

/** How far below a threshold `hp` sits, 0 at the threshold … 1 at zero health. */
const severity = (hp: number, below: number): number => Math.min(1, Math.max(0, (below - hp) / below));

/** Emission rates (particles/s) for a model at health fraction `hp`, written into `out` (no allocation). */
export function damageRates(hp: number, structure: boolean, plane: Plane, out: DamageRates): DamageRates {
  const orbit = plane === 'orbit';
  out.smoke = orbit ? 0 : DAMAGE.smoke.rate * severity(hp, DAMAGE.smoke.below);
  out.sparks = DAMAGE.sparks.rate * severity(hp, DAMAGE.sparks.below);
  out.fire = structure && !orbit ? DAMAGE.fire.rate * severity(hp, DAMAGE.fire.below) : 0;
  return out;
}
