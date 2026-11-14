/**
 * Orbit → Surface drop forecast: where a `deorbit` lands, how big its blast is and what the fall passes, as the sim
 * resolves it (planes/payloads.ts). The towed payload releases where it is (at its tug), falls through the Sky in a
 * straight line to the landing point for its warning time and is interceptable all the way down; the target must lie
 * within `deorbitRange` of the payload, and the derelict core drops only from outside the hull.
 *
 * Fog-safe: reads only the team's current view (own tows, visible shooters, public islands). The blast ring is the
 * public size radius, the same one every army's falling marker and auto-intercept use: a hidden volatility multiplier
 * (volatile) never widens it.
 */
import {
  DEPLOY_SPECS, OUTSIDE, PAYLOADS, STATS, TICK_RATE, UNITS_PER_INTENT, derelictLayer, footprint, footprintDistance, resolvePayloads,
  type Entity, type Kind, type PayloadKind, type RockSize, type RuleTables, type Rules, type UnitKind, type View,
} from '@agent-command/game/contract';
import { ruleTables } from '../unit-stats.ts';
import { relation } from '../world/common.ts';
import { canFireContact, canTarget, weaponReach } from './contacts.ts';

/** Strike red of the drop's blast ring, in the scope and on the main view. */
export const DROP_HEX = '#ff3b2a';

export interface PublicDrop { readonly radius: number; readonly fall: number }
interface DropRows { readonly kinds: Readonly<Partial<Record<Kind, PublicDrop>>>; readonly sizes: Readonly<Record<RockSize, PublicDrop>> }

const rows = new WeakMap<Rules, DropRows>();
/**
 * Public rows resolved once per rules object from the shared payload registry, never per pointer move: every payload
 * that drops from Orbit (whatever lands on the Surface), and the asteroid's per-size rows.
 */
function dropRows(rules: Rules): DropRows {
  let out = rows.get(rules);
  if (!out) {
    const econ = ruleTables(rules).econ;
    const resolved = resolvePayloads(econ);
    const kinds: Partial<Record<Kind, PublicDrop>> = {};
    for (const kind of Object.keys(PAYLOADS) as PayloadKind[]) {
      const row = resolved[kind];
      if (row?.from === 'orbit') kinds[kind] = { radius: row.impact.radius, fall: row.fall };
    }
    const sizes = {} as Record<RockSize, PublicDrop>;
    for (const size of Object.keys(PAYLOADS.asteroid.sizes) as RockSize[]) {
      const spec = PAYLOADS.asteroid.sizes[size];
      sizes[size] = { radius: econ[spec.radius], fall: econ[spec.warning] };
    }
    rows.set(rules, out = { kinds, sizes });
  }
  return out;
}

/** Public blast radius (tiles) and fall (ticks) of a payload dropped from Orbit; undefined for anything else. */
export function publicDrop(e: Entity, rules: Rules): PublicDrop | undefined {
  const r = dropRows(rules);
  const row = r.kinds[e.kind];
  return row && e.kind === 'asteroid' && e.rockSize ? r.sizes[e.rockSize] : row;
}

/** The payload an own selected tug tows, from the current view (undefined while it tows nothing seen). */
function towOf(tug: Entity, view: View): Entity | undefined {
  if (tug.side !== view.army || tug.link === undefined) return undefined;
  for (const e of view.entities) if (e.id === tug.link) return e;
  return undefined;
}

/** Largest public blast radius among the selection's tows (0: no drop in tow). */
export function dropRadius(units: readonly Entity[], view: View | undefined): number {
  const rules = view?.match?.rules;
  if (!view || !rules) return 0;
  let radius = 0, tugs = 0;
  for (const unit of units) {
    if (unit.kind !== 'tug') continue;
    if (++tugs > UNITS_PER_INTENT) break;
    const tow = towOf(unit, view);
    const drop = tow && publicDrop(tow, rules);
    if (drop) radius = Math.max(radius, drop.radius);
  }
  return radius;
}

/** Retained per scope: filled in place on every pointer move and match change, never reallocated. */
export class DropForecast {
  active = false;
  /** Landing point (map tiles), as the intent sends it. */
  x = 0;
  y = 0;
  /** Largest public blast radius (tiles) of the tows in this drop. */
  radius = 0;
  /** Longest release-to-impact time (seconds). */
  fall = 0;
  /** rules.orbit.deorbitRange: the farthest landing from a payload's release point. */
  reach = 0;
  /** `drop`: a payload falling from Orbit (`forecastDrop`); `strike`: weapons fired down or up at a contact (`forecastStrike`). */
  kind: 'drop' | 'strike' = 'drop';
  /** A strike's firing units include bombers (labels). */
  bomb = false;
  /** The derelict core is among the tows (labels and its radius). */
  core = false;
  /** Largest rock size among the tows (undefined: only the core). */
  rock: RockSize | undefined = undefined;
  /** Release points: x, y per tow, `count` of them (each payload falls from where it is now). */
  readonly from = new Float64Array(2 * UNITS_PER_INTENT);
  count = 0;
  /** Tows farther than `reach` from the landing (the sim rejects the whole drop). */
  outOfReach = 0;
  /** The core is still inside the derelict hull (the sim rejects it until it is out). */
  inHull = false;
  /** An own/allied or a hostile island deck lies over the blast: the Sky column takes the impact too. */
  ownIsland = false;
  enemyIsland = false;
  /** Visible hostile Sky-reaching weapons whose reach crosses some fall path, or interceptors that auto-intercept it. */
  screens = 0;
  /** Armies with a visible Surface structure in the blast: their idle interceptors auto-intercept (scratch). */
  readonly struck: string[] = [];
  /** Ids the hologram highlights: hostile island decks over the blast and the Sky screens counted above. */
  readonly threats: string[] = [];
  /** Own or allied units and structures the blast would hit (Surface, and the Sky column over it), own decks included. */
  readonly friendly: string[] = [];
  /** Nothing in reach blocks the drop: every tow is within `reach` and no core is inside the hull. */
  get valid(): boolean { return this.count > 0 && this.outOfReach === 0 && !this.inHull; }
}
export const createDropForecast = (): DropForecast => new DropForecast();

/** Distance from (px, py) to the segment (ax, ay)–(bx, by), and its nearest point in `near` (no allocation). */
const near = { x: 0, y: 0 };
export function segmentNearest(px: number, py: number, ax: number, ay: number, bx: number, by: number): { x: number; y: number } {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  near.x = ax + dx * t;
  near.y = ay + dy * t;
  return near;
}

/**
 * The reach (tiles) at which `e` can shoot a falling payload: a fully deployed stance's units range replaces stats range,
 * and flak adds flakPayloadRange (the sim's rangeBonus for a payload target).
 */
export function payloadReach(e: Entity, tables: RuleTables): number {
  const stats = tables.stats[e.kind as UnitKind];
  if (!stats) return 0;
  const stance = stats.deploy ? DEPLOY_SPECS[stats.deploy] : undefined;
  let reach = stance?.range && e.state === stance.states[1] ? tables.econ[stance.range.units] : stats.range;
  if (stats.weapon === 'flak') reach += tables.econ.flakPayloadRange;
  return reach;
}

/**
 * Forecast the selection's drop onto (x, y). Selected tugs beyond the intent's unit cap are ignored, as `unitIds`
 * drops them from the order.
 */
export function forecastDrop(out: DropForecast, view: View | undefined, units: readonly Entity[], x: number, y: number): DropForecast {
  clear(out, 'drop');
  const match = view?.match;
  if (!view || !match) return out;
  const rules = match.rules;
  const tables = ruleTables(rules);
  const econ = tables.econ;
  out.x = x;
  out.y = y;
  out.reach = econ.deorbitRange;
  let fall = 0, tugs = 0;
  const ruin = match.derelict;
  for (const unit of units) {
    if (unit.kind !== 'tug') continue;
    if (++tugs > UNITS_PER_INTENT) break;
    const tow = towOf(unit, view);
    const drop = tow && publicDrop(tow, rules);
    if (!tow || !drop) continue;
    out.from[out.count * 2] = tow.x;
    out.from[out.count * 2 + 1] = tow.y;
    out.count++;
    out.radius = Math.max(out.radius, drop.radius);
    fall = Math.max(fall, drop.fall);
    if (tow.kind === 'core') {
      out.core = true;
      if (ruin && derelictLayer(ruin, Math.hypot(tow.x - ruin.x, tow.y - ruin.y)) !== OUTSIDE) out.inHull = true;
    } else if (tow.rockSize && (!out.rock || drop.radius >= dropRows(rules).sizes[out.rock].radius)) out.rock = tow.rockSize;
    if (Math.hypot(tow.x - x, tow.y - y) > econ.deorbitRange) out.outOfReach++;
  }
  if (!out.count) return out;
  out.fall = fall / TICK_RATE;
  // The sim's auto-intercept: an idle interceptor engages a rock whose public blast reaches its own army's Surface
  // structures and that lands within autoInterceptRadius of its post (here: where it is seen).
  if (econ.autoInterceptEnabled) for (const e of view.entities) {
    if (e.plane !== 'surface' || !footprint(e.kind) || e.kind === 'post' || relation(view.army, e.side) !== 'hostile' || out.struck.includes(e.side)) continue;
    if (footprintDistance(e.kind, e.x, e.y, x, y) <= out.radius) out.struck.push(e.side);
  }
  for (const e of view.entities) {
    const rel = relation(view.army, e.side);
    if (e.kind === 'island') {
      // The impact hits the Sky column too (islands themselves excepted): what stands on a deck over the blast.
      if (Math.hypot(e.x - x, e.y - y) > econ.islandRadius + out.radius) continue;
      if (rel === 'own' || rel === 'allied') { out.ownIsland = true; out.friendly.push(e.id); }
      else if (rel === 'hostile') { out.enemyIsland = true; out.threats.push(e.id); }
      continue;
    }
    if (rel === 'own' || rel === 'allied') {
      // The sim's blast: Surface and Sky entities within the radius (structures to their footprint), payloads excepted.
      if ((e.plane === 'surface' || e.plane === 'sky') && e.kind !== 'post' && !publicDrop(e, rules)
        && (footprint(e.kind) ? footprintDistance(e.kind, e.x, e.y, x, y) : Math.hypot(e.x - x, e.y - y)) <= out.radius) out.friendly.push(e.id);
      continue;
    }
    if (rel !== 'hostile' || !canTarget(e, 'sky', view)) continue;
    if (e.kind === 'interceptor' && e.plane === 'sky' && out.struck.includes(e.side) && Math.hypot(e.x - x, e.y - y) <= econ.autoInterceptRadius) { out.screens++; out.threats.push(e.id); continue; }
    const reach = payloadReach(e, tables);
    for (let i = 0; i < out.count; i++) {
      const p = segmentNearest(e.x, e.y, out.from[i * 2]!, out.from[i * 2 + 1]!, x, y);
      if (footprintDistance(e.kind, e.x, e.y, p.x, p.y) <= reach) { out.screens++; out.threats.push(e.id); break; }
    }
  }
  out.active = true;
  return out;
}

function clear(out: DropForecast, kind: DropForecast['kind']): void {
  out.active = false;
  out.kind = kind;
  out.count = out.outOfReach = out.screens = out.struck.length = out.threats.length = out.friendly.length = 0;
  out.radius = out.fall = out.reach = 0;
  out.core = out.inHull = out.ownIsland = out.enemyIsland = out.bomb = false;
  out.rock = undefined;
}

/**
 * Forecast a cross-plane strike at `target` (the O tool's hovered contact): the selected own units whose weapons can
 * fire at it now, the largest splash among them around it, own or allied units and structures in that splash (friendly
 * fire), and visible hostiles that can shoot back at the firing plane from where the run must go (over the target).
 */
export function forecastStrike(out: DropForecast, view: View | undefined, units: readonly Entity[], target: Entity): DropForecast {
  clear(out, 'strike');
  const rules = view?.match?.rules;
  if (!view || !rules) return out;
  const stats = ruleTables(rules).stats;
  let source: Entity['plane'] | undefined;
  for (const e of units) {
    if (out.count >= UNITS_PER_INTENT || e.side !== view.army || !canFireContact(e, target, view)) continue;
    source ??= e.plane;
    out.from[out.count * 2] = e.x;
    out.from[out.count * 2 + 1] = e.y;
    out.count++;
    out.radius = Math.max(out.radius, stats[e.kind as UnitKind]?.splash ?? 0);
    if (STATS[e.kind as UnitKind]?.weapon === 'bomb') out.bomb = true;
    if (e.kind === 'island_mortar') {
      out.reach = Math.max(out.reach, weaponReach(e, view, target.plane));
      out.fall = Math.max(out.fall, rules.sky.mortarFlightTime, Math.ceil(Math.hypot(e.x - target.x, e.y - target.y) * TICK_RATE / Math.max(0.001, stats.island_mortar.projectileSpeed)) / TICK_RATE);
    }
  }
  if (!out.count || !source) return out;
  out.x = target.x;
  out.y = target.y;
  for (const e of view.entities) {
    if (e.id === target.id || e.kind === 'island') continue;
    const rel = relation(view.army, e.side);
    const d = footprint(e.kind) ? footprintDistance(e.kind, e.x, e.y, target.x, target.y) : Math.hypot(e.x - target.x, e.y - target.y);
    if (rel === 'own' || rel === 'allied') {
      if (e.plane === target.plane && out.radius > 0 && d <= out.radius) out.friendly.push(e.id);
    } else if (rel === 'hostile' && canTarget(e, source, view) && d <= weaponReach(e, view, source)) {
      out.screens++;
      out.threats.push(e.id);
    }
  }
  out.active = true;
  return out;
}
