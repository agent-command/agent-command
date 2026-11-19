import { TICK_RATE, VISION_BITS_PER_WORD, type Entity, type Rules, type View } from '@agent-command/game/contract';
import type { AbilityReadiness } from './readiness.ts';

/** A catch always belongs to one explicitly selected own tower, never to an army-wide slot. */
export function selectedMooringTower(units: readonly Entity[], view: View | undefined): Entity | undefined {
  if (!view || units.length !== 1) return undefined;
  const tower = units[0]!;
  return tower.kind === 'mooring_tower' && tower.side === view.army ? tower : undefined;
}

export function mooringDescription(rules: Rules): string {
  const r = rules.surface;
  return `Pick a visible friendly, allied, enemy or neutral island through the Sky Lens. Its route must pass within ${r.mooringRange} tiles; the tower waits for a clear catch, then lowers it below normal Sky traffic over ${r.mooringTravelTime}s without moving it sideways. One island per tower, ${r.mooringUpkeep} energy/s while held; no army-wide limit. Power or payment failure consumes a non-renewing ${r.mooringGraceTime}s grace, then releases. Release waits for a safe gap and raises it back onto its original route, then ${r.mooringCooldown}s before another catch. Fliers descend to visit and climb on departure. It remains in the Sky: storms, fog, ownership, capture, production and building slots are unchanged.`;
}

export function mooringStatus(e: Entity, view: View): string {
  const r = view.match?.rules.surface;
  if (!e.mooringState && e.mooringGrace !== undefined)
    return `Field active · target obscured${e.mooringPowered === false ? ' · POWER LOST' : ''}${r && e.mooringGrace < r.mooringGraceTime * TICK_RATE ? ` · power grace ${Math.max(0, e.mooringGrace / TICK_RATE).toFixed(1)}s left (does not refill)` : ''}`;
  if (e.mooringState === 'raising') return 'Releasing · waiting for a safe gap / rising to flight level';
  if (e.mooringState === 'lowering' || e.mooringState === 'held') {
    const state = e.mooringState === 'lowering' ? 'Lowering below Sky traffic' : 'Held below Sky traffic';
    if (r && e.mooringGrace !== undefined && e.mooringGrace < r.mooringGraceTime * TICK_RATE)
      return `${state} · ${e.mooringPowered === false ? 'POWER LOST · ' : ''}power grace ${Math.max(0, e.mooringGrace / TICK_RATE).toFixed(1)}s left (does not refill)`;
    return `${state}${r ? ` · ${r.mooringUpkeep} energy/s` : ''}`;
  }
  if (e.mooringState === 'waiting') return e.mooringPowered === false ? 'Pending catch · waiting for power' : 'Pending catch · waiting for island / clear catch';
  if ((e.mooringReadyAt ?? 0) > view.tick) return `Drifting · catch available in ${Math.ceil((e.mooringReadyAt! - view.tick) / TICK_RATE)}s`;
  if (e.state === 'constructing') return 'Under construction';
  return e.kind === 'mooring_tower' ? e.mooringPowered === false ? 'Unpowered · catch waits for power' : 'Ready · choose an island' : 'Drifting';
}

export function mooringReadiness(units: readonly Entity[], view: View | undefined, release = false): AbilityReadiness {
  const rules = view?.match?.rules;
  const tower = selectedMooringTower(units, view);
  const description = rules ? mooringDescription(rules) : '';
  if (!view || !rules) return { enabled: false, status: 'Waiting for match', cost: {}, description };
  const status = !tower ? 'Select exactly one of your Mooring Towers'
    : tower.state === 'constructing' ? 'Under construction'
      : !rules.surface.mooringEnabled ? 'Mooring is off in this match'
        : release ? tower.mooringGrace === undefined && !tower.mooringTarget || tower.mooringState === 'raising' ? 'No pending catch or held island' : ''
          : tower.mooringState || tower.mooringTarget || tower.mooringGrace !== undefined ? 'Release the current target first' : '';
  return { enabled: !status, status: status || (tower ? mooringStatus(tower, view) : ''), cost: {}, description };
}

/** Public island paths are not sight: only currently seen Sky cells can be chosen for a catch. */
export function islandSeen(island: Entity, view: View): boolean {
  const size = view.match?.rules.map.size ?? 0;
  const cell = Math.floor(island.y) * size + Math.floor(island.x);
  return size > 0 && (((view.vision.sky[Math.floor(cell / VISION_BITS_PER_WORD)] ?? 0) >>> (cell % VISION_BITS_PER_WORD)) & 1) !== 0;
}

/** Only fogged public path geometry and visible movement state participate; no inferred hidden catch occupancy. */
export function mooringTargetRefusal(tower: Entity, island: Entity | undefined, view: View): string | undefined {
  if (!island || island.kind !== 'island' || !view.entities.some((e) => e.id === island.id) || !islandSeen(island, view)) return 'Pick a visible island through the Sky Lens';
  if (island.mooringState || island.mooringTower) return 'Island already held or rising';
  if ((island.mooringReadyAt ?? 0) > view.tick) return `Island recovering · ${Math.ceil((island.mooringReadyAt! - view.tick) / TICK_RATE)}s to next catch`;
  const path = view.islands.find((p) => p.id === island.id);
  const range = view.match?.rules.surface.mooringRange ?? 0;
  if (!path || Math.abs(Math.hypot(tower.x - path.cx, tower.y - path.cy) - path.r) > range) return `Island route misses the ${range}-tile catch range`;
  return undefined;
}
