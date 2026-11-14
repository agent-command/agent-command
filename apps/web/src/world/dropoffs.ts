import type { Entity, Fx } from '@agent-command/game/contract';
import type { DropoffKind } from './models.ts';

/** Counterparts are derived only from observed/remembered structures, never public holes or lode locations. */
export function dropoffKind(e: Pick<Entity, 'kind' | 'plane'>): DropoffKind | undefined {
  if (e.plane === 'surface' && (e.kind === 'shaft' || e.kind === 'headframe')) return e.kind;
  if (e.plane === 'depths' && e.kind === 'spire') return 'spire';
  return undefined;
}

/**
 * The counterpart a live (or remembered) structure shows in the Depths: portals only once built, the root always. A
 * Spire segment reports `constructing` while it produces a unit (sim `updateProduction`), never as an unfinished build.
 */
export function landingKind(e: Pick<Entity, 'kind' | 'plane'> & Partial<Pick<Entity, 'state'>>): DropoffKind | undefined {
  return e.state === 'constructing' && e.kind !== 'spire' ? undefined : dropoffKind(e);
}

export function receivesDelivery(e: Entity, fx: Fx): boolean {
  if (fx.kind !== 'deliver' || fx.plane !== 'depths' || fx.side !== e.side || !landingKind(e)) return false;
  const x = Math.floor(fx.x), y = Math.floor(fx.y);
  return e.kind === 'spire' ? Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y) <= 1.6 : Math.floor(e.x) === x && Math.floor(e.y) === y;
}

export interface HaulState { pressure: number; phase: number; until: number }

/** Five seconds of recent deliveries control presentation only; several arrivals make the cable busier. */
export function delivered(state: HaulState, now: number): void {
  state.pressure = Math.min(4, now < state.until ? state.pressure + 1 : 1);
  state.until = now + 5000;
}

/** Finish the current trip before parking the skip at its landing. No idle motion or phase discontinuities. */
export function stepHaul(state: HaulState, now: number, dt: number, reduced: boolean): number {
  if (now >= state.until && state.phase === 0) return 0;
  state.phase += dt * (0.22 + state.pressure * 0.18) * (reduced ? 0.08 : 1);
  if (state.phase >= 1) {
    state.phase %= 1;
    if (now >= state.until) { state.phase = 0; state.pressure = 0; }
  }
  return state.pressure / 4;
}
