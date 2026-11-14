import { uniform } from 'three/tsl';
import type { UniformNode } from 'three/webgpu';
import { PLANES, type Plane } from '@agent-command/game/contract';

/**
 * Per-plane visibility shared by every material on that plane.
 * `alpha`: opacity (dithered on plane geometry): the focused plane and the one below show, planes above vanish as the
 * camera passes through them, planes further below are covered by the ghost page.
 * `focus`: 1 = painted focused plane, 0 = ghost (construction-pencil sketch on the viewed plane's paper).
 */
export interface PlaneFade {
  alpha: UniformNode<'float'>;
  focus: UniformNode<'float'>;
}

function make(): PlaneFade {
  return { alpha: uniform(1), focus: uniform(1) };
}

export const FADE: Record<Plane, PlaneFade> = { depths: make(), surface: make(), sky: make(), orbit: make() };

/** CPU mirrors of FADE for per-instance work (instanced entities, overlay). */
export const fadeValue: Record<Plane, number> = { depths: 1, surface: 1, sky: 1, orbit: 1 };
export const focusValue: Record<Plane, number> = { depths: 1, surface: 1, sky: 1, orbit: 1 };

/** `level` = continuous camera plane index (0 depths … 3 orbit), fractional during dives. */
export function applyFade(level: number): void {
  for (let i = 0; i < PLANES.length; i++) {
    const p = PLANES[i]!;
    const d = level - i; // >0: plane is below the camera's focus
    const a = d >= 0 ? Math.min(1, Math.max(0, (1.7 - d) / 0.7)) : Math.max(0, 1 + d * 1.6);
    const f = Math.max(0, 1 - Math.abs(d) * 1.4);
    fadeValue[p] = a;
    focusValue[p] = f;
    FADE[p].alpha.value = a;
    FADE[p].focus.value = f;
  }
}
