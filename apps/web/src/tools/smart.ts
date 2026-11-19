/**
 * Smart right-click: one table decides what a right-click on the hovered target does for the current selection.
 * Each row pairs a target kind with a unit capability; the first row whose target matches and which at least one
 * selected unit can perform wins, so hover feedback (cursor, tip) and the committed intents never disagree.
 *
 * Fog: resolution reads only the team's View. A hovered entity counts only while it is in `view.entities` (seen now,
 * never a fading track or a remembered ghost), and Depths cells only by their known code; holes are public.
 *
 * Client-only by design: agents already issue the same explicit intents (`attack`, `transfer` with a portal point,
 * `grapple`, `mine`, …) and the one server-side contextual rule, attack on an island, lives in the `attack` intent.
 */
import { CELL, PLANES, STATS, TRANSITS, footprintDistance, gatesOpen, hostileSide, isAircraft, isDiggable, isHardpointKind, lavaBridgeable, type ArmyId, type Capabilities, type Entity, type Kind, type Plane, type Side, type UnitKind, type View } from '@agent-command/game/contract';
import type { Intent } from '../controls.ts';
import { CURSOR } from '../cursors.ts';
import { digTagged } from '../designate.ts';
import { canTarget } from './contacts.ts';
import { moveIntents } from './orders.ts';
import { PING, round2, unitIds, type ToolSelection } from './types.ts';
import { MOTHER_LODE_LABEL, RICH_ORE_LABEL } from '../text.ts';

/** What the pointer rests on: the focused plane, its ground point and the picked entity id (if any). */
export interface SmartHover { plane: Plane; tile?: { x: number; y: number }; entity?: string }
export interface SmartModifiers { shiftKey: boolean; altKey: boolean }
export type SmartActionId = 'attack' | 'capture' | 'hangar' | 'convert' | 'mine_asteroid' | 'grapple' | 'dock' | 'transfer' | 'repair' | 'bridge' | 'lava' | 'work' | 'mine' | 'dig' | 'enter' | 'move' | 'rally';
export interface SmartAction {
  id: SmartActionId;
  /** Minimal hover tip, e.g. "Descend". */
  label: string;
  cursor: string;
  intents: Intent[];
  /** Order ping: the target point and colour. */
  x: number;
  y: number;
  color: string;
  /** A refused right-click: no intents; the commit toasts `label` (why) instead of a silent move. */
  refused?: true;
}

/** The hovered target, classified once from the army's knowledge. */
interface Target {
  army: ArmyId;
  /** Is `side` hostile to the viewing army (matchData.armies colours)? */
  hostile: (side: Side) => boolean;
  plane: Plane;
  size: number;
  /** The hovered entity as the team sees it now. */
  entity?: Entity;
  /** An island's visible hostile slot structure. */
  slot?: Entity;
  /** An island's visible hostile hardpoint attachment (a Gun Platform): it freezes any capture until destroyed. */
  guard?: Entity;
  tile?: { x: number; y: number };
  /** Target point: the entity's or portal's centre, else the ground point. */
  x: number;
  y: number;
  /** Known Depths cell code under the pointer (CELL.unknown off the Depths or off the map). */
  code: number;
  tagged: boolean;
  /** A known lava-lake cell diggers may bridge now (lavaBridgeable on team knowledge), what one cell costs, and how far out a span reaches. */
  bridgeable: boolean;
  bridgeCost: number;
  bridgeSpan: number;
  /** A Surface↔Depths portal: an own built Shaft that is not sealed. */
  portal: boolean;
  /** An Orbit ground point inside the derelict's chamber, and whether its gates are sealed right now (public cycle). */
  chamber: boolean;
  sealed: boolean;
  /** The hovered asteroid or derelict core is under tow by a hostile tug (any Orbit weapon may shoot it). */
  enemyTow: boolean;
  /** Orbit formation and Shift, for the move intents rows issue. */
  formation: ToolSelection['formation'];
  shift: boolean;
}

type Queue = { queue?: true };
interface SmartRule {
  id: SmartActionId;
  planes: readonly Plane[];
  /** Spire rows answer a Spire-only selection; every other row needs a selected unit that `can` act. */
  spire?: true;
  target(t: Target): boolean;
  can(e: Entity, t: Target): boolean;
  label(t: Target): string;
  cursor: string;
  color: string;
  /**
   * Selected units without the capability: `follow` plain-moves them onto the target point; `join` puts them in the
   * same intent (the server splits them, as attack on an island does); `stay` leaves them out of the order.
   */
  others: 'follow' | 'join' | 'stay';
  /** The row refuses: it matches to say why there (label, invalid cursor) and issues nothing. */
  refuses?: true;
  intents(units: Entity[], t: Target, q: Queue): Intent[];
}

/** Dig targets: known solid rock of any kind (green rich ore included) or unexplored cells. */
const diggable = (code: number): boolean => code === CELL.unknown || isDiggable(code);

const capable = (e: Entity, capability: keyof Capabilities): boolean => !!STATS[e.kind as UnitKind]?.capabilities[capability];
const mobile = (e: Entity): boolean => (STATS[e.kind as UnitKind]?.speed ?? 0) > 0;
const own = (t: Target, kind: Kind): boolean => t.entity?.kind === kind && t.entity.side === t.army;
const built = (e: Entity): boolean => e.progress === undefined || e.progress >= 1;
const towing = (e: Entity): boolean => e.state === 'towing' || e.link !== undefined;
const cellOf = (t: Target): { x: number; y: number } => ({ x: Math.min(t.size - 1, Math.floor(t.x)), y: Math.min(t.size - 1, Math.floor(t.y)) });
const moveTo = (units: readonly Entity[], t: Target, x: number, y: number): Intent[] => moveIntents(t.plane, t.size, t.formation, { shiftKey: t.shift, altKey: false }, units, x, y, undefined, 'move');

/** Priority order: the first row whose target matches and which a selected unit can perform wins. */
export const SMART_RULES: readonly SmartRule[] = [
  {
    // Islands answer the island rows below, never this one. Cross-plane contacts stay with the explicit O tool. A
    // neutral asteroid or derelict core under an enemy tow is fair game too.
    id: 'attack', planes: PLANES, target: (t) => !!t.entity && t.entity.kind !== 'island' && (t.hostile(t.entity.side) || t.enemyTow), can: (e, t) => canTarget(e, t.entity!.plane),
    label: () => 'Attack', cursor: CURSOR.attack, color: PING.attack, others: 'follow',
    intents: (units, t, q) => [{ kind: 'attack', units: unitIds(units), target: t.entity!.id, ...q }],
  },
  {
    // A visible hostile slot structure: the server's island attack targets it (non-shooters move under it).
    id: 'attack', planes: ['sky'], target: (t) => t.entity?.kind === 'island' && !!t.slot, can: (e, t) => canTarget(e, t.slot!.plane),
    label: () => 'Attack', cursor: CURSOR.attack, color: PING.attack, others: 'join',
    intents: (units, t, q) => [{ kind: 'attack', units: unitIds(units), target: t.entity!.id, ...q }],
  },
  {
    // No hostile slot structure but a hostile Gun Platform on its hardpoint: the island attack would only capture, which
    // the platform blocks, so shoot the platform itself.
    id: 'attack', planes: ['sky'], target: (t) => t.entity?.kind === 'island' && !t.slot && !!t.guard, can: (e, t) => canTarget(e, t.guard!.plane),
    label: () => 'Attack', cursor: CURSOR.attack, color: PING.attack, others: 'follow',
    intents: (units, t, q) => [{ kind: 'attack', units: unitIds(units), target: t.guard!.id, ...q }],
  },
  {
    // Nothing hostile seen on a neutral or enemy island: the same server rule captures with capture-capable aircraft.
    id: 'capture', planes: ['sky'], target: (t) => t.entity?.kind === 'island' && !t.slot && t.entity.side !== t.army,
    can: (e) => capable(e, 'capture') && !e.hangar && !e.transit,
    label: () => 'Capture', cursor: CURSOR.capture, color: PING.patrol, others: 'join',
    intents: (units, t, q) => [{ kind: 'attack', units: unitIds(units), target: t.entity!.id, ...q }],
  },
  {
    id: 'hangar', planes: ['sky'], target: (t) => own(t, 'aerie') && built(t.entity!), can: (e) => isAircraft(e.kind) && !e.hangar,
    label: () => 'Hangar', cursor: CURSOR.enter, color: PING.patrol, others: 'stay',
    intents: (units, t) => [{ kind: 'hangar', units: unitIds(units), target: t.entity!.id }],
  },
  {
    // Own built Drill Yard (a working one shows progress to its owner): troopers go in to become Breachers.
    id: 'convert', planes: ['surface'], target: (t) => own(t, 'drill_yard') && t.entity!.state !== 'constructing',
    can: (e) => e.kind === 'trooper' && e.state !== 'converting',
    label: () => 'Convert', cursor: CURSOR.enter, color: PING.enter, others: 'stay',
    intents: (units, t, q) => [{ kind: 'convert', units: unitIds(units), to: 'breacher', yard: t.entity!.id, ...q }],
  },
  {
    id: 'mine_asteroid', planes: ['orbit'],
    target: (t) => t.entity?.kind === 'asteroid' && t.entity.state === 'drifting' && (t.entity.resourceType === 'metal' || t.entity.resourceType === 'ice') && (t.entity.resourceRemaining ?? 0) > 0,
    can: (e) => e.kind === 'tug' && !towing(e),
    label: () => 'Mine asteroid', cursor: CURSOR.build, color: PING.patrol, others: 'stay',
    intents: (units, t, q) => [{ kind: 'mine_asteroid', units: unitIds(units), asteroid: t.entity!.id, ...q }],
  },
  {
    // A drifting asteroid, or the derelict core resting (in the chamber or wherever it was dropped).
    id: 'grapple', planes: ['orbit'], target: (t) => (t.entity?.kind === 'asteroid' && t.entity.state === 'drifting') || (t.entity?.kind === 'core' && t.entity.state === 'idle'),
    can: (e) => capable(e, 'tow') && !towing(e),
    label: (t) => t.entity!.kind === 'core' ? 'Grapple core' : 'Grapple', cursor: CURSOR.grapple, color: PING.patrol, others: 'stay',
    intents: (units, t, q) => [{ kind: 'grapple', units: unitIds(units), asteroid: t.entity!.id, ...q }],
  },
  {
    // Docking is automatic within dockRadius of the own live segment: towing tugs salvage, shielded warships repair.
    id: 'dock', planes: ['orbit'], target: (t) => own(t, 'spire') && t.entity!.hp > 0,
    can: (e) => (capable(e, 'tow') && (towing(e) || (e.cargoAlloy ?? 0) + (e.cargoEnergy ?? 0) > 0)) || (!!e.maxShield && (e.hp < e.maxHp || (e.shield ?? 0) < e.maxShield)),
    label: () => 'Dock', cursor: CURSOR.enter, color: PING.move, others: 'join',
    intents: (units, t) => moveTo(units, t, t.x, t.y),
  },
  {
    id: 'transfer', planes: ['surface', 'depths'], target: (t) => t.portal,
    can: (e, t) => (t.plane === 'surface' ? TRANSITS.descend : TRANSITS.emerge).kinds.includes(e.kind as 'trooper'),
    label: (t) => t.plane === 'surface' ? 'Descend' : 'Climb', cursor: CURSOR.enter, color: PING.enter, others: 'follow',
    intents: (units, t, q) => [{ kind: 'transfer', units: unitIds(units), to: t.plane === 'surface' ? 'depths' : 'surface', x: round2(t.x, t.size), y: round2(t.y, t.size), ...q }],
  },
  {
    // Fortifying an own bulkhead repairs it to full (and reinforces it); diggers and Wardens both fortify.
    id: 'repair', planes: ['depths'], target: (t) => own(t, 'bulkhead') && built(t.entity!) && t.entity!.hp < t.entity!.maxHp, can: (e) => capable(e, 'fortify'),
    label: () => 'Repair', cursor: CURSOR.build, color: PING.patrol, others: 'stay',
    intents: (units, t, q) => [{ kind: 'fortify', units: unitIds(units), ...cellOf(t), ...q }],
  },
  {
    // A lake cell beside dry ground or a bridge span: every selected digger works it (one price per cell, more
    // diggers finish sooner); the rest stay off the lava.
    id: 'bridge', planes: ['depths'], target: (t) => !t.entity && t.bridgeable, can: (e) => capable(e, 'build'),
    label: (t) => `Bridge lava · ${t.bridgeCost} alloy`, cursor: CURSOR.build, color: PING.patrol, others: 'stay',
    intents: (units, t, q) => [{ kind: 'bridge', units: unitIds(units), ...cellOf(t), ...q }],
  },
  {
    // Any other known lake cell: nothing walks into lava on a right-click, and the tip says how far a span reaches.
    id: 'lava', planes: ['depths'], target: (t) => !t.entity && t.code === CELL.lake, can: mobile, refuses: true,
    label: (t) => `Too far out to bridge · lava bridges reach ${t.bridgeSpan} cell${t.bridgeSpan === 1 ? '' : 's'} from dry ground or a bridge`,
    cursor: CURSOR.invalid, color: PING.move, others: 'stay',
    intents: () => [],
  },
  {
    id: 'work', planes: ['depths'], target: (t) => !t.entity && t.tagged && diggable(t.code), can: (e) => capable(e, 'dig'),
    label: () => 'Dig tag', cursor: CURSOR.build, color: PING.fight, others: 'follow',
    intents: (units, t, q) => [{ kind: 'dig', units: unitIds(units), ...cellOf(t), ...q }],
  },
  {
    // Mother Lode cells are mined from beside them like ore, never dug (so never diggable); green rich ore like ore.
    id: 'mine', planes: ['depths'], target: (t) => !t.entity && (t.code === CELL.ore || t.code === CELL.rich || t.code === CELL.lode), can: (e) => capable(e, 'carry'),
    label: (t) => t.code === CELL.lode ? `Mine the ${MOTHER_LODE_LABEL}` : t.code === CELL.rich ? `Mine ${RICH_ORE_LABEL.toLowerCase()}` : 'Mine', cursor: CURSOR.build, color: PING.fight, others: 'follow',
    intents: (units, t, q) => [{ kind: 'mine', units: unitIds(units), x: round2(t.x, t.size), y: round2(t.y, t.size), ...q }],
  },
  {
    id: 'dig', planes: ['depths'], target: (t) => !t.entity && diggable(t.code), can: (e) => capable(e, 'dig'),
    label: () => 'Dig', cursor: CURSOR.build, color: PING.fight, others: 'follow',
    intents: (units, t, q) => [{ kind: 'dig', units: unitIds(units), ...cellOf(t), ...q }],
  },
  {
    // Into the derelict's chamber: a plain move (the server routes through the breaches and holds at a sealed gate).
    id: 'enter', planes: ['orbit'], target: (t) => t.chamber && !t.entity, can: mobile,
    label: (t) => t.sealed ? 'Enter derelict · waits for the gates' : 'Enter derelict', cursor: CURSOR.enter, color: PING.move, others: 'stay',
    intents: (units, t) => moveTo(units, t, t.tile!.x, t.tile!.y),
  },
  {
    // Plain move to the ground point; multi-unit slots are the server's (group moves spread around the point).
    id: 'move', planes: PLANES, target: (t) => !!t.tile, can: mobile,
    label: () => 'Move', cursor: CURSOR.move, color: PING.move, others: 'stay',
    intents: (units, t) => moveTo(units, t, t.tile!.x, t.tile!.y),
  },
  {
    id: 'rally', planes: PLANES, spire: true, target: (t) => !!t.tile, can: () => false,
    label: () => 'Set rally', cursor: CURSOR.rally, color: PING.move, others: 'stay',
    intents: (_, t) => [{ kind: 'rally', x: round2(t.tile!.x, t.size), y: round2(t.tile!.y, t.size) }],
  },
];
const MOVE = SMART_RULES.find((rule) => rule.id === 'move')!;
/** Alt bypasses context: only the plain ground rows. */
const PLAIN = SMART_RULES.filter((rule) => rule.id === 'move' || rule.id === 'rally');

function seen(view: View, id: string | undefined): Entity | undefined {
  if (id === undefined) return undefined;
  for (const e of view.entities) if (e.id === id) return e;
  return undefined;
}

/** Own built, unsealed Shaft at a ground point (the only Surface↔Depths portal); its centre. */
function portalAt(view: View, plane: Plane, entity: Entity | undefined, tile: { x: number; y: number } | undefined): { x: number; y: number } | undefined {
  if (plane !== 'surface' && plane !== 'depths') return undefined;
  const portal = (e: Entity): boolean => e.kind === 'shaft' && e.side === view.army && built(e) && !e.sealed;
  if (entity) return portal(entity) ? entity : undefined;
  if (!tile) return undefined;
  for (const e of view.entities) if (portal(e) && footprintDistance('shaft', e.x, e.y, tile.x, tile.y) <= 0) return e;
  return undefined;
}

function classify(view: View, hover: SmartHover, size: number, selection: ToolSelection, shift: boolean): Target {
  const entity = seen(view, hover.entity);
  const tile = hover.tile && Number.isFinite(hover.tile.x) && Number.isFinite(hover.tile.y) ? hover.tile : undefined;
  const army = view.army;
  const match = view.match;
  const hostile = (side: Side): boolean => match !== undefined && hostileSide(match, army, side);
  const link = entity?.kind === 'island' ? seen(view, entity.link) : undefined;
  const slot = link && hostile(link.side) ? link : undefined;
  let guard: Entity | undefined;
  if (entity?.kind === 'island') for (const e of view.entities) if (e.link === entity.id && isHardpointKind(e.kind) && hostile(e.side)) guard = e;
  const cell = tile && !entity && hover.plane === 'depths' && tile.x >= 0 && tile.y >= 0 && tile.x < size && tile.y < size
    ? Math.floor(tile.y) * size + Math.floor(tile.x) : -1;
  const portal = portalAt(view, hover.plane, entity, tile);
  const at = portal ?? entity ?? tile;
  const ruin = hover.plane === 'orbit' ? match?.derelict : undefined;
  const chamber = !!ruin && !!tile && Math.hypot(tile.x - ruin.x, tile.y - ruin.y) < ruin.ringInner;
  return {
    army, hostile, plane: hover.plane, size, entity, slot, guard, tile,
    x: at?.x ?? 0, y: at?.y ?? 0,
    code: cell >= 0 ? view.depths[cell] ?? CELL.unknown : CELL.unknown,
    tagged: cell >= 0 && (digTagged(view.designations.normal, cell) || digTagged(view.designations.urgent, cell)),
    bridgeable: cell >= 0 && !!match && lavaBridgeable(view.depths, cell, size, match.rules.depths.lavaBridgeSpan),
    bridgeCost: match?.rules.depths.lavaBridgeCost ?? 0,
    bridgeSpan: match?.rules.depths.lavaBridgeSpan ?? 0,
    portal: !!portal, chamber, sealed: chamber && !gatesOpen(ruin!, view.tick), formation: selection.formation, shift,
    enemyTow: (entity?.kind === 'asteroid' || entity?.kind === 'core') && entity.state === 'towed' && hostile(seen(view, entity.link)?.side ?? 'neutral'),
  };
}

/**
 * What a right-click on `hover` does for `selection` (own units and/or Spire on the focused plane), from the team's
 * View only: the action with its intents, or undefined when nothing applies. Alt bypasses context: plain move.
 */
export function resolveSmartAction(selection: ToolSelection, hover: SmartHover, view: View, modifiers: SmartModifiers): SmartAction | undefined {
  const size = view.match?.rules.map.size;
  if (!size) return undefined;
  const units = selection.units;
  const spireOnly = selection.spire && !units.length;
  if (!units.length && !spireOnly) return undefined;
  const t = classify(view, hover, size, selection, modifiers.shiftKey);
  const q: Queue = modifiers.shiftKey ? { queue: true } : {};
  for (const rule of modifiers.altKey ? PLAIN : SMART_RULES) {
    if (!rule.planes.includes(t.plane) || !!rule.spire !== spireOnly || !rule.target(t)) continue;
    const actors: Entity[] = [], others: Entity[] = [];
    for (const e of units) (rule.can(e, t) ? actors : others).push(e);
    if (!spireOnly && !actors.length) continue;
    const intents = rule.intents(rule.others === 'join' ? [...actors, ...others.filter(mobile)] : actors, t, q);
    if (rule.others === 'follow') intents.push(...moveTo(others, t, t.x, t.y));
    const ground = rule === MOVE || rule.spire;
    const x = ground ? t.tile!.x : t.x, y = ground ? t.tile!.y : t.y;
    return { id: rule.id, label: rule.label(t), cursor: rule.cursor, intents, x, y, color: rule.color, ...(rule.refuses ? { refused: true as const } : {}) };
  }
  return undefined;
}
