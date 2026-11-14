/** Out-of-band recording hook: listeners see every emitted event and effect without being match state. */
import type { Plane } from '../rules/contract.ts';
import type { AgentCommandIntent, ApplyResult } from '../agent/intents.ts';
import type { Army, SideId } from '../util/teams.ts';
import type { Ent } from './ent.ts';
import type { Sim } from './sim.ts';
import type { FxRec, SimEvent } from './state.ts';

interface SimRecordingListener {
  event(event: SimEvent): void;
  effect(effect: FxRec): void;
  /** `dealt` HP actually taken from `e` (> 0), with the provenance `Sim.damage` stores on it. */
  damage(e: Ent, dealt: number, by: SideId, cause: string, sourcePlane: Plane | undefined): void;
  /** One intent at the game boundary and its result. */
  intent(team: Army, role: Plane, intent: AgentCommandIntent, result: ApplyResult): void;
}

/** Outside Sim so native observers neither enter cloned state nor change authoritative hashing. */
export const recordingListeners = new WeakMap<Sim, Set<SimRecordingListener>>();

export function subscribeRecording(sim: Sim, listener: SimRecordingListener): () => void {
  let listeners = recordingListeners.get(sim);
  if (!listeners) {
    listeners = new Set();
    recordingListeners.set(sim, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) recordingListeners.delete(sim);
  };
}

export function recordDamage(sim: Sim, e: Ent, dealt: number, by: SideId, cause: string, sourcePlane: Plane | undefined): void {
  const listeners = recordingListeners.get(sim);
  if (listeners) for (const listener of listeners) listener.damage(e, dealt, by, cause, sourcePlane);
}

export function recordIntent(sim: Sim, team: Army, role: Plane, intent: AgentCommandIntent, result: ApplyResult): void {
  const listeners = recordingListeners.get(sim);
  if (listeners) for (const listener of listeners) listener.intent(team, role, intent, result);
}
