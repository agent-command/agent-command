import { STATS, UNITS_PER_INTENT, type Entity, type Plane, type UnitKind } from '@agent-command/game/contract';
import type { Intent } from '../controls.ts';
import { canTarget } from './contacts.ts';
import { ping, PING, round2, unitIds, type OrbitFormation, type ToolContext, type ToolPointer } from './types.ts';

/** One contextual default for ordinary ground orders. Explicit A-move overrides it. */
export function contextualMoveMode(): 'move' | 'fight' { return 'move'; }

/**
 * The player's chosen Orbit formation for a multi-ship order; none chosen sends a plain move (each ship its own
 * size-scaled slot). Only the ships in this order can anchor an escort; never inspect hovered or unselected entities.
 */
export function orbitMoveOptions(plane: Plane, formation: OrbitFormation | undefined, units: readonly Entity[]): { formation: OrbitFormation; escort?: string } | undefined {
  const count = Math.min(units.length, UNITS_PER_INTENT);
  if (!formation || plane !== 'orbit' || count < 2) return undefined;
  let anchor = units[0]!;
  for (let i = 0; i < count; i++) {
    const e = units[i]!;
    if (e.plane !== 'orbit') return undefined;
    if (anchor.kind !== 'tug' && anchor.kind !== 'solar' && (e.kind === 'tug' || e.kind === 'solar')) anchor = e;
  }
  return formation === 'escort' ? { formation, escort: anchor.id } : { formation };
}

/**
 * Move intents for `units` to a point, without side effects: emplacements never move, and in `fight` mode the units
 * whose weapons reach `targetPlane` (default: any armed unit) fight-move while the rest plain-move.
 */
export function moveIntents(plane: Plane, size: number, formation: OrbitFormation | undefined, p: Pick<ToolPointer, 'shiftKey' | 'altKey'>, units: readonly Entity[], x: number, y: number, targetPlane?: Plane, mode = contextualMoveMode()): Intent[] {
  const fighters: Entity[] = [], movers: Entity[] = [];
  for (const e of units) {
    const stats = STATS[e.kind as UnitKind];
    if (!stats?.speed) continue; // Emplacements can focus fire, never move.
    const fights = mode === 'fight' && !p.altKey && (targetPlane ? canTarget(e, targetPlane) : stats.dmg > 0);
    (fights ? fighters : movers).push(e);
  }
  const intents: Intent[] = [];
  const queue = p.shiftKey ? { queue: true } : {};
  if (fighters.length) intents.push({ kind: 'move', units: unitIds(fighters), x: round2(x, size), y: round2(y, size), mode: 'fight', ...orbitMoveOptions(plane, formation, fighters), ...queue });
  if (movers.length) intents.push({ kind: 'move', units: unitIds(movers), x: round2(x, size), y: round2(y, size), mode: 'move', ...orbitMoveOptions(plane, formation, movers), ...queue });
  return intents;
}

export function movementOrders(c: ToolContext, p: ToolPointer, units: Entity[], x: number, y: number, targetPlane?: Plane, mode = contextualMoveMode()): Intent[] {
  const intents = moveIntents(c.world.rig.focus, c.world.size, c.selection.formation, p, units, x, y, targetPlane, mode);
  if (intents.length) ping(c, x, y, c.world.rig.focus, intents[0]!.mode === 'fight' ? PING.fight : PING.move);
  return intents;
}
