import { canHitPlane, ECON, footprint, footprintDistance, isIslandBuild, PLANES, STATS, UNIT_KINDS, UPGRADES, type Entity, type Plane, type UnitKind, type UpgradeId, type View } from '@agent-command/game/contract';
import { quadDistance, type FootprintQuad } from '../footprints.ts';
import { ruleTables } from '../unit-stats.ts';
import { relation, unitY } from '../world/common.ts';
import type { Track } from '../world/entities.ts';
import { groundAt, type TerrainField } from '../world/terrain.ts';
import type { World } from '../world/world.ts';
import type { ToolSelection } from './types.ts';

export const CONTACT_ICON_PX = 18;
export const CONTACT_PICK_PX = 12;
const NO_UNITS: readonly Entity[] = [];

/** Cross-plane contacts belong to the selected source, not a second viewport or a simulated extra weapon. */
export class Contacts {
  active = false;
  source: Plane = 'surface';
  readonly planes = new Set<Plane>();
  units: readonly Entity[] = NO_UNITS;
  x = 0;
  y = 0;
  radius = 0;
  hovered?: string;
}
export const createContacts = (): Contacts => new Contacts();

/** Upgrades granting the Lancer Lens capability (registry effects, not an upgrade id), with the kinds they grant it. */
const LENS_GRANTS: readonly { id: UpgradeId; units: readonly string[] }[] = Object.values(UPGRADES).flatMap((u) =>
  u.effects.flatMap((f) => f.kind === 'grant_capability' && f.capability === 'lens' ? [{ id: u.id, units: f.units }] : []));

/**
 * Does `e` reach the Sky below through a researched Lens (the sim's `lensShot`)? Own units only: the team's completed
 * research is the one fog-safe source of a granted capability.
 */
function lensTo(e: Entity, plane: Plane, view?: View): boolean {
  if (plane !== 'sky' || e.plane !== 'orbit' || !view || e.side !== view.army) return false;
  for (const grant of LENS_GRANTS) if (grant.units.includes(e.kind) && view.research.completed.includes(grant.id)) return true;
  return false;
}

/** Current-plane weapon capability is the same registry/transit/research rule used by the simulation. */
export function canTarget(e: Entity, plane: Plane, view?: View): boolean {
  return !!STATS[e.kind as UnitKind]?.dmg && canHitPlane(e.kind, e.plane, plane, e.transit, lensTo(e, plane, view));
}

/** Rules compile once by identity; scalar reads allocate nothing during pointer and overlay frames. `plane`: the target plane (a Lens reaches rules.orbit.lensReach). */
export function weaponReach(e: Entity, view?: View, plane?: Plane): number {
  const rules = view?.match?.rules;
  if (plane && lensTo(e, plane, view)) return rules?.orbit.lensReach ?? ECON.lensReach;
  return (rules ? ruleTables(rules).stats : STATS)[e.kind as UnitKind]?.range ?? 0;
}

export function configureContacts(out: Contacts, selection: ToolSelection, source: Plane, view?: View): void {
  out.active = false;
  out.source = source;
  out.units = selection.units;
  out.hovered = undefined;
  out.planes.clear();
  let x = 0, y = 0, count = 0, radius = 0;
  for (const e of selection.units) {
    if (e.plane !== source) continue;
    x += e.x; y += e.y; count++;
    for (const plane of PLANES) if (plane !== source && canTarget(e, plane, view)) {
      out.planes.add(plane);
      radius = Math.max(radius, weaponReach(e, view, plane));
    }
  }
  if (count) { out.x = x / count; out.y = y / count; }
  out.radius = radius;
  out.active = out.planes.size > 0;
}

/** Candidate classification; callers enumerate the team's current view, never stale tracks or remembered enemies. */
export function isContact(contacts: Contacts, view: View | undefined, e: Entity): boolean {
  return !!view && contacts.active && relation(view.army, e.side) === 'hostile' && contacts.planes.has(e.plane);
}

export function canFireContact(e: Entity, target: Entity, view?: View): boolean {
  const weapon = STATS[e.kind as UnitKind]?.weapon;
  return target.kind !== 'island' && e.plane !== target.plane && canTarget(e, target.plane, view)
    // The Lens beams Sky units only, as the sim's isTarget.
    && (!lensTo(e, target.plane, view) || (UNIT_KINDS as readonly string[]).includes(target.kind))
    && (view?.match?.rules.sky.groundHitsIslandStructures || !isIslandBuild(target.kind) || (weapon !== 'flak' && weapon !== 'turret'))
    && footprintDistance(target.kind, target.x, target.y, e.x, e.y) <= weaponReach(e, view, target.plane) + 1e-8;
}

export function contactFireCount(contacts: Contacts, target: Entity, view?: View): number {
  if (!contacts.active || !contacts.planes.has(target.plane)) return 0;
  let count = 0;
  for (const e of contacts.units) if (e.plane === contacts.source && canFireContact(e, target, view)) count++;
  return count;
}

/** The contact's map anchor is registered onto the current terrain/deck, never its native layer altitude. */
export function contactHeight(source: Plane, x: number, y: number, terrain: TerrainField): number {
  return unitY(source) + (source === 'surface' ? groundAt(x, y, terrain) : 0) + 0.04;
}

export interface ContactProjection {
  x: number;
  y: number;
  behind: boolean;
  quad: FootprintQuad;
  icon: boolean;
}
export const createContactProjection = (): ContactProjection => ({ x: 0, y: 0, behind: false, quad: new Float64Array(8), icon: false });

type ContactWorld = Pick<World, 'project' | 'size'> & { layers: { surface: { field: TerrainField } } };

/** Shared drawing/picking footprint. Unit bodies use registry radii; structures use their occupied rectangles. */
export function projectContact(world: ContactWorld, source: Plane, tr: Track, out: ContactProjection): boolean {
  const height = contactHeight(source, tr.rx, tr.ry, world.layers.surface.field);
  const centre = world.project(tr.rx - world.size / 2, height, tr.ry - world.size / 2);
  out.x = centre.x; out.y = centre.y; out.behind = centre.behind;
  if (centre.behind) return false;
  const body = footprint(tr.e.kind);
  const radius = STATS[tr.e.kind as UnitKind]?.radius ?? 0.4;
  const hw = body ? body.w / 2 : radius, hh = body ? body.h / 2 : radius;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (let i = 0; i < 4; i++) {
    const p = world.project(tr.rx + (i === 1 || i === 2 ? hw : -hw) - world.size / 2, height, tr.ry + (i >= 2 ? hh : -hh) - world.size / 2);
    if (p.behind) { out.behind = true; return false; }
    out.quad[i * 2] = p.x; out.quad[i * 2 + 1] = p.y;
    left = Math.min(left, p.x); right = Math.max(right, p.x);
    top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
  }
  out.icon = Math.max(right - left, bottom - top) < CONTACT_ICON_PX;
  return true;
}

const pickProjection = createContactProjection();

/** Includes grey/out-of-reach contacts so hover can explain invalidity; commitment separately counts legal weapons. */
export function pickContact(contacts: Contacts, view: View | undefined, world: ContactWorld & { entities: Pick<World['entities'], 'tracks'> }, x: number, y: number): Track | undefined {
  if (!view || !contacts.active) return undefined;
  let best: Track | undefined;
  let nearest = Infinity;
  for (const e of view.entities) {
    if (!isContact(contacts, view, e)) continue;
    const tr = world.entities.tracks.get(e.id);
    if (!tr || !projectContact(world, contacts.source, tr, pickProjection)) continue;
    const centre = Math.hypot(x - pickProjection.x, y - pickProjection.y);
    const distance = pickProjection.icon ? centre : quadDistance(pickProjection.quad, x, y);
    if (distance > (pickProjection.icon ? CONTACT_PICK_PX : 4)) continue;
    const score = distance + centre * 1e-6;
    if (score < nearest) { nearest = score; best = tr; }
  }
  return best;
}
