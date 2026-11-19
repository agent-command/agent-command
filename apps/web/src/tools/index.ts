/**
 * Plane tool registry: gives each TOOL_META entry (tools/catalog.ts) its behavior (card/eligibility, readiness, aim,
 * preview, commit to intents), and ToolSession runs the active tool's pointer lifecycle. Preview and commit share
 * one rule table per verb.
 */
import { CELL, ECON, HARDPOINT_KINDS, PLANES, STATS, SURFACE, TRANSITS, footprintDistance, hostileSide, isOpenCell, lavaBridgeable, surfaceFeature, type Entity, type Kind, type Plane, type UnitKind, type View } from '@agent-command/game/contract';
import type { Intent } from '../controls.ts';
import { PLANE_ACCENT } from '../dom.ts';
import { KIND_LABEL, NEED_LABEL, PLANE_NAME, signalTo } from '../text.ts';
import { requestIntent, requestTarget } from '../signals.ts';
import type { Track } from '../world/entities.ts';
import { buildAnchor } from '../footprints.ts';
import { TOOL_META, type ToolId } from './catalog.ts';
import { commitDesignation, designationTool, moveDesignationDrag, previewDesignationDrag, resetDesignationDrag } from './designate.ts';
import { buildPreview, islandBuildPreview, islandBuildTarget, ping, PING, queue, resolvePointer, round2, tilePreview, unitIds, type PlaneTool, type ToolContext, type ToolPointer, type ToolSelection } from './types.ts';
import { createLens, PEEK_RADIUS, previewLens, type LensAim } from './lens.ts';
import { DROP_HEX, dropRadius, forecastDrop, forecastStrike } from './drop.ts';
import { canFireContact, canTarget, configureContacts, contactFireCount, createContacts, pickContact, type Contacts } from './contacts.ts';
import { movementOrders, orbitMoveOptions } from './orders.ts';
import { resolveSmartAction } from './smart.ts';
import { orbitAbilityReady, orbitAbilityState } from './orbit-abilities.ts';
import { alloyCost, ascentReadiness, ascentReady, ascentUnits, backfillable, backfillReadiness, convertReadiness, coreTugs, releaseReadiness, towingTugs, deployedUp, deployReadiness, deploySpecOf, emplaceAvailable, emplaceReadiness, emplaceSite, emplaceUnits, flareReadiness, flareReady, mineReadiness, mobile, ownDeployable, ownWardens, scanReadiness, ventReadiness, WAITING } from './readiness.ts';
import { mooringReadiness, mooringTargetRefusal, selectedMooringTower } from './mooring.ts';
export type { Armed, OrbitFormation, PlaneTool, ToolContext, ToolPointer, ToolSelection, ToolState } from './types.ts';
export { resolvePointer, round2, unitIds } from './types.ts';

export const isFighter = (e: Entity): boolean => (STATS[e.kind as UnitKind]?.dmg ?? 0) > 0;
/** Move/attack-move/patrol/stop need something that can move: armed structures (turrets) are selectable but static. */
const hasUnits = (s: ToolSelection) => s.units.some((e) => (STATS[e.kind as UnitKind]?.speed ?? 0) > 0);
const hasCrossPlaneWeapon = (s: ToolSelection, view: View | undefined): boolean => {
  for (const e of s.units) for (const plane of PLANES) if (plane !== e.plane && canTarget(e, plane, view)) return true;
  return false;
};
const PEEK_AIMS = {
  depths: { plane: 'surface', radius: 0 },
  surface: { plane: 'sky', radius: 0 },
  sky: { plane: 'surface', radius: 0 },
  // Orbit looks down through the Sky to the Surface: both layers, stacked.
  orbit: { plane: 'surface', radius: 0 },
} as const;
const MOORING_AIM: LensAim = { plane: 'sky', radius: 20, islands: true };
const MORTAR_AIM: LensAim = { plane: 'surface', radius: 12 };
const REVERSE_PEEK_AIMS = {
  ...PEEK_AIMS,
  surface: { plane: 'depths', radius: 0 },
  sky: { plane: 'orbit', radius: 0 },
} as const;
/** Drops open the Surface scope on the cursor, framing the selection's largest public blast (retained: aims run every frame). */
const DROP_AIM: LensAim = { plane: 'surface', radius: PEEK_RADIUS, cursor: true };
/** Hologram reach per tile of blast radius: room round the ring to read the base it lands among. */
const DROP_FRAME = 2.5;
/** The O tool's hologram: the targeted plane around the cursor, view only (retained; `plane` set per frame). */
const STRIKE_AIM: LensAim = { plane: 'surface', radius: 0, view: true };
/** A Depths charge aimed up: the Surface it would collapse, around the cursor, view only. */
const COLLAPSE_AIM: LensAim = { plane: 'surface', radius: 0, view: true };
/** Units that walk through Surface↔Depths portals (the descend transit's kinds: troopers and Breachers). */
const portalWalker = (e: Entity): boolean => (TRANSITS.descend.kinds as readonly string[]).includes(e.kind);
const hasKind = (kind: Kind) => (s: ToolSelection) => s.units.some((e) => e.kind === kind);
const kindCard = (kind: Kind) => (s: ToolSelection) => s.units.some((e) => e.kind === kind) && (!s.activeKind || s.activeKind === kind);
const ofKind = (c: ToolContext, kind: Kind) => c.selection.units.filter((e) => e.kind === kind);
const canFortify = (e: Entity): boolean => !!STATS[e.kind as UnitKind]?.capabilities.fortify;
/** Diggers and Wardens fortify: the card shows for either unless Tab picked another kind. */
const fortifyCard = (s: ToolSelection) => s.units.some(canFortify) && (!s.activeKind || !!STATS[s.activeKind as UnitKind]?.capabilities.fortify);
const FLARE_COLOR = '#ffd0a0';
const cell = (c: ToolContext, x: number, y: number) => c.host.view()?.depths[Math.floor(y) * c.world.size + Math.floor(x)] ?? CELL.unknown;
/** A selected unit with a deploy stance on its own plane: Deploy/Pack show for it unless Tab picked another kind. */
const deployable = (e: Entity): boolean => deploySpecOf(e.kind)?.plane === e.plane;
const deployCard = (s: ToolSelection) => s.units.some(deployable) && (!s.activeKind || !!deploySpecOf(s.activeKind));
/** The plane the deploy order goes to: the first selected deployable unit's (one seat per order). */
const deployRole = (c: ToolContext): Plane => c.selection.units.find(deployable)?.plane ?? 'surface';
/** Deploy (dig in, siege, emplace, shield wall) or pack the selected units on the order's plane. */
function deployTool(on: boolean): Behavior {
  return {
    immediate: true, card: deployCard, applies: (s) => s.units.some(deployable), role: deployRole,
    readiness: (s, v) => deployReadiness(s.units, v, on),
    commit(c) {
      const view = c.host.view();
      const plane = deployRole(c);
      const units = view ? ownDeployable(c.selection.units, view).filter((e) => e.plane === plane && (on ? mobile(e) : deployedUp(e))) : [];
      if (!units.length) { c.host.toast(on ? 'Select mobile troopers, tanks, flak or Wardens' : 'No selected unit is deployed'); return []; }
      return [{ kind: 'deploy', units: unitIds(units), on }];
    },
  };
}
const nearest = (units: Entity[], x: number, y: number) => units.reduce((a, b) => Math.hypot(b.x - x - 0.5, b.y - y - 0.5) < Math.hypot(a.x - x - 0.5, a.y - y - 0.5) ? b : a);
const VERB_COLOR = { breach: '#b98bff', rail: '#bfe6ff', bridge: '#ffd34d', undermine: '#ff6a3d' };
type DepthsVerb = keyof typeof VERB_COLOR;

/** Shared by Ctrl-right-click commit and preview: no second contextual rule table. */
export function depthsVerbAt(c: ToolContext, x: number, y: number): { kind: DepthsVerb; label: string } | undefined {
  const ix = Math.floor(x), iy = Math.floor(y);
  const view = c.host.view();
  const hole = view?.holes.find((h) => h.x === ix && h.y === iy)?.kind;
  if (view?.match && ofKind(c, 'digger').length && lavaBridgeable(view.depths, iy * c.world.size + ix, c.world.size, view.match.rules.depths.lavaBridgeSpan))
    return { kind: 'bridge', label: 'Bridge this lava' };
  if (hole && view?.match && backfillable(view.match.rules.depths, hole) && ofKind(c, 'digger').length) return { kind: 'bridge', label: `Backfill this ${hole}` };
  if (hole === 'chasm') return undefined;
  const code = cell(c, x, y);
  if (!isOpenCell(code)) return undefined;
  if (ofKind(c, 'trooper').length && !hole) return { kind: 'breach', label: 'Breach up here' };
  if (ofKind(c, 'sapper').length) return { kind: 'undermine', label: surfaceFeature(c.world.layers.surface.field.terrainCodes[iy * c.world.size + ix]!) === SURFACE.fault ? 'Open fault → chasm' : 'Plant charge' };
  if (ofKind(c, 'digger').length && code === CELL.tunnel) return { kind: 'rail', label: 'Lay rail to here' };
  return undefined;
}

export function attackIntents(c: ToolContext, target: Track, p: ToolPointer): Intent[] {
  const own = c.selection.units;
  // An island resolves to its slot on the server: its enemy structure, else a capture (the rest move onto it).
  if (target.e.kind === 'island') {
    ping(c, target.rx, target.ry, c.world.rig.focus, PING.attack);
    return own.length ? [{ kind: 'attack', units: unitIds(own), target: target.e.id, ...queue(p) }] : [];
  }
  const view = c.host.view();
  const can = own.filter((e) => canTarget(e, target.e.plane, view));
  const rest = own.filter((e) => !can.includes(e) && STATS[e.kind as UnitKind]?.speed);
  const intents: Intent[] = [];
  if (can.length) intents.push({ kind: 'attack', units: unitIds(can), target: target.e.id, ...queue(p) });
  if (rest.length) intents.push({ kind: 'move', units: unitIds(rest), x: round2(target.e.x, c.world.size), y: round2(target.e.y, c.world.size), mode: 'move', ...orbitMoveOptions(c.world.rig.focus, c.selection.formation, rest), ...queue(p) });
  ping(c, target.rx, target.ry, c.world.rig.focus, PING.attack);
  return intents;
}

/** Picking, cursor validity and commits share the renderer's source-height contact projection. */
export function contactAttackTarget(c: ToolContext, p: ToolPointer) {
  const contacts = c.state.contacts;
  const view = c.host.view();
  if (!contacts?.active || contacts.source !== c.world.rig.focus || !view || p.altKey) return undefined;
  const track = pickContact(contacts, view, c.world, p.x, p.y);
  if (!track) return undefined;
  return track;
}

/** Ctrl+right-click in the Depths: special verbs; otherwise the smart right-click table (tools/smart.ts). */
function contextual(c: ToolContext, p: ToolPointer): Intent[] {
  const v = c.host.view();
  if (!v) return [];
  const focus = c.world.rig.focus;
  const { tile, track } = resolvePointer(c, p, { entity: true, lens: false });
  if (!(c.selection.spire && !c.selection.units.length) && !p.altKey && (p.ctrlKey || p.metaKey) && focus === 'depths' && tile) {
    const verb = depthsVerbAt(c, tile.x, tile.y);
    if (verb) return getTool(verb.kind).commit(c, p);
    c.host.toast('No special order here for this selection');
    return [];
  }
  const action = resolveSmartAction(c.selection, { plane: focus, tile, entity: track?.e.id }, v, p);
  if (!action) return [];
  if (action.refused) { c.host.toast(action.label); return []; }
  ping(c, action.x, action.y, focus, action.color);
  return action.intents;
}

/** Why the pointed island cannot take an emplace now (public data only), or '' when a selected Gunship can land there. */
function emplaceRefusal(c: ToolContext, view: View, track: Track | undefined): string {
  if (!track || track.e.kind !== 'island' || track.e.side !== view.army) return 'Pick an island you hold';
  if (view.islands.find((p) => p.id === track.e.id)?.hardpoint) return 'Its hardpoint is taken';
  if (track.e.state === 'capturing') return 'Being captured';
  return emplaceUnits(c.selection.units, view).some((e) => emplaceSite(e, view, track.e))
    ? '' : `Move a Gunship within ${view.match?.rules.sky.captureRadius ?? 0} tiles first`;
}

type Behavior = Omit<PlaneTool, 'id' | 'planes' | 'label' | 'hint' | 'hotkey' | 'cursor'>;
function depthsVerb(kind: DepthsVerb, unit: Kind, radius: number, label: string, snap = false, readiness?: Behavior['readiness']): Behavior {
  return {
    card: kindCard(unit), applies: kind === 'undermine' ? () => true : hasKind(unit), role: () => 'depths', readiness,
    ...(kind === 'undermine' ? { aim: COLLAPSE_AIM } : {}),
    commit(c, p) {
      const { tile } = resolvePointer(c, p);
      const units = ofKind(c, unit);
      if (!tile) return [];
      if (!units.length) { c.host.toast(unit === 'sapper' ? 'Select sappers first' : unit === 'trooper' ? 'Select troopers in the Depths first' : 'Select diggers first'); return []; }
      const x = Math.min(c.world.size - 1, Math.floor(tile.x)), y = Math.min(c.world.size - 1, Math.floor(tile.y));
      ping(c, x + 0.5, y + 0.5, 'depths', VERB_COLOR[kind]);
      // A hole is one digger's job; a lava cell's price is paid once and every digger sent speeds it up.
      const all = kind !== 'bridge' || cell(c, x, y) === CELL.lake;
      return [{ kind, units: unitIds(all ? units : [nearest(units, x, y)]), x, y, ...queue(p) }];
    },
    preview(c, p) {
      const tile = resolvePointer(c, p).tile;
      const fault = tile && surfaceFeature(c.world.layers.surface.field.terrainCodes[Math.floor(tile.y) * c.world.size + Math.floor(tile.x)]!) === SURFACE.fault;
      tilePreview(c, p, radius, VERB_COLOR[kind], kind === 'undermine' && fault ? 'Open fault → chasm' : label, snap);
    },
  };
}
/** The berth preview's output tint: logo bronze at no output to logo gold at full (share 0…1), brighter = more. */
const BERTH_DIM = [0x9c, 0x42, 0x00] as const;
const BERTH_LIT = [0xff, 0xd2, 0x1f] as const;
function outputGold(share: number): string {
  const t = Math.max(0, Math.min(1, share));
  return `rgb(${BERTH_DIM.map((v, i) => Math.round(v + (BERTH_LIT[i]! - v) * t)).join(',')})`;
}

/**
 * Moving own solar arrays in the Orbit view: preview the berth under the cursor as its outline, an output-tinted dot
 * and a chip with its daylight output once ramped, naming the shade (other own arrays within the shade radius) and
 * distance (from the own Orbit segment's footprint edge) penalties only where they apply. False when the selection is
 * not all own arrays.
 */
function arrayHint(c: ToolContext, p: ToolPointer): boolean {
  const view = c.host.view();
  const sel = c.selection.units;
  if (!view?.match || c.world.rig.focus !== 'orbit' || !sel.length || sel.some((e) => e.kind !== 'solar' || e.side !== view.army)) return false;
  const { tile, plane } = resolvePointer(c, p, { target: 'orbit' });
  if (!tile) return false;
  const r = view.match.rules.orbit;
  const seg = view.entities.find((e) => e.kind === 'spire' && e.plane === 'orbit' && e.side === view.army);
  const d = seg ? footprintDistance('spire', seg.x, seg.y, tile.x, tile.y) : Infinity;
  const distance = d <= r.solarFullRange ? 1 : d >= r.solarFarRange ? r.solarFarFactor
    : 1 - ((1 - r.solarFarFactor) * (d - r.solarFullRange)) / (r.solarFarRange - r.solarFullRange);
  const moving = new Set(sel.map((e) => e.id));
  let n = 0;
  for (const e of view.entities) if (e.kind === 'solar' && e.side === view.army && !moving.has(e.id) && Math.hypot(e.x - tile.x, e.y - tile.y) < r.solarShadeRadius) n++;
  const shade = Math.max(r.solarShadeFloor, 1 - r.solarShadePer * n);
  const share = distance * shade;
  const penalty = (word: string, f: number) => (f < 1 ? ` · ${word} −${Math.round((1 - f) * 100)}%` : '');
  const label = `${(view.match.rules.economy.solarRate * share).toFixed(1)}/s${penalty('shade', shade)}${penalty('distance', distance)}`;
  c.overlay.preview = { x: tile.x, y: tile.y, plane, radius: 0, berth: 2 * STATS.solar.radius, color: outputGold(share), label };
  return true;
}

function order(kind: 'amove' | 'move' | 'patrol'): Behavior {
  const color = kind === 'amove' ? PING.fight : kind === 'move' ? PING.move : PING.patrol;
  return {
    card: hasUnits, applies: hasUnits,
    commit(c, p) {
      const { tile, track, plane } = resolvePointer(c, p, { entity: kind === 'amove' });
      const view = c.host.view();
      if (kind === 'amove' && track && view?.match && hostileSide(view.match, view.army, track.e.side)) return attackIntents(c, track, p);
      if (kind === 'amove' && tile && plane !== c.world.rig.focus) return movementOrders(c, p, c.selection.units, tile.x, tile.y, plane, 'fight');
      if (!tile || !c.selection.units.length) return [];
      const x = round2(tile.x, c.world.size), y = round2(tile.y, c.world.size);
      ping(c, x, y, c.world.rig.focus, color);
      return [{ kind: kind === 'patrol' ? 'patrol' : 'move', units: unitIds(c.selection.units), x, y, ...(kind === 'patrol' ? {} : { mode: kind === 'amove' ? 'fight' : 'move', ...orbitMoveOptions(c.world.rig.focus, c.selection.formation, c.selection.units) }), ...queue(p) }];
    },
    preview(c, p) {
      if (kind === 'move' && arrayHint(c, p)) return;
      tilePreview(c, p, 0.7, color, `${getTool(kind).label}${p.shiftKey && kind !== 'patrol' ? ' (queued)' : ''}`);
    },
  };
}
const behaviors: Record<Exclude<ToolId, 'designate'>, Behavior> = {
  default: {
    persistent: true, applies: () => true,
    click(c, p) {
      if (p.button === 2) return contextual(c, p);
      c.select(p.x, p.y, p.shiftKey, p.ctrlKey || p.metaKey);
      return [];
    },
    dragStart(c, p) {
      if (p.button === 0) c.state.start = { x: p.x, y: p.y };
      else if (p.button === 2) {
        const start = resolvePointer(c, p).tile;
        if (start) c.state.rightDrag = { start, active: false };
      }
    },
    dragMove(c, p) {
      if (c.state.rightDrag) { moveDesignationDrag(c, p); return; }
      const start = c.state.start;
      if (start && Math.hypot(p.x - start.x, p.y - start.y) > 6) c.overlay.drag = { x0: start.x, y0: start.y, x1: p.x, y1: p.y };
    },
    dragEnd(c, p) {
      if (p.button === 2) {
        moveDesignationDrag(c, p);
        const drag = c.state.rightDrag;
        const intents = drag?.active
          ? c.world.rig.focus === 'depths' ? commitDesignation(c, p, drag.rect, true) : []
          : contextual(c, p);
        resetDesignationDrag(c);
        return intents;
      }
      c.state.start = undefined;
      const drag = c.overlay.drag;
      c.overlay.drag = undefined;
      if (!drag) return getTool('default').click!(c, p);
      c.box(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.max(drag.x0, drag.x1), Math.max(drag.y0, drag.y1), p.shiftKey);
      return [];
    },
    preview(c, p) {
      c.overlay.preview = undefined;
      if (c.state.rightDrag?.active) { previewDesignationDrag(c, p); return; }
      if (arrayHint(c, p)) return;
      if (!(p.ctrlKey || p.metaKey) || c.world.rig.focus !== 'depths') return;
      const tile = resolvePointer(c, p).tile;
      const verb = tile && depthsVerbAt(c, tile.x, tile.y);
      if (verb) tilePreview(c, p, 0, VERB_COLOR[verb.kind], `${verb.label} · Ctrl+right-click`, true);
    },
    commit: contextual,
    reset: resetDesignationDrag,
  },
  amove: order('amove'), move: order('move'), patrol: order('patrol'),
  lensAttack: {
    card: hasCrossPlaneWeapon, applies: hasCrossPlaneWeapon,
    commit(c, p) {
      if (p.button !== 0) return [];
      const track = contactAttackTarget(c, p);
      if (!track) return [];
      const contacts = c.state.contacts!;
      const view = c.host.view();
      if (!contactFireCount(contacts, track.e, view)) return [];
      const units = contacts.units.filter((e) => e.plane === contacts.source && canFireContact(e, track.e, view));
      if (!units.length) return [];
      ping(c, track.rx, track.ry, contacts.source, PING.attack);
      return [{ kind: 'attack', units: unitIds(units), target: track.e.id, ...queue(p) }];
    },
  },
  stop: { immediate: true, card: (s) => hasUnits(s) || hasKind('island_mortar')(s), applies: (s) => hasUnits(s) || hasKind('island_mortar')(s), commit: (c) => [{ kind: 'stop', units: unitIds(c.selection.units) }] },
  hold: { immediate: true, card: (s) => s.units.some(isFighter), applies: (s) => s.units.some(isFighter), commit: (c) => [{ kind: 'stance', stance: 'hold', units: unitIds(c.selection.units.filter(isFighter)) }] },
  mine: { immediate: true, card: kindCard('digger'), applies: hasKind('digger'), role: () => 'depths', readiness: (_s, v) => mineReadiness(v), commit: (c, p) => [{ kind: 'mine', units: unitIds(ofKind(c, 'digger')), ...queue(p) }] },
  transfer: {
    immediate: true, card: (s) => kindCard('trooper')(s) || kindCard('breacher')(s), applies: (s) => s.units.some(portalWalker),
    commit: (c, p) => [{ kind: 'transfer', units: unitIds(c.selection.units.filter(portalWalker)), to: c.world.rig.focus === 'depths' ? 'surface' : 'depths', ...queue(p) }],
  },
  convert: {
    immediate: true, card: kindCard('trooper'), applies: hasKind('trooper'), role: () => 'surface',
    readiness: (s, v) => convertReadiness(s.units, v),
    commit: (c, p) => [{ kind: 'convert', units: unitIds(ofKind(c, 'trooper').filter((e) => e.state !== 'converting')), to: 'breacher', ...queue(p) }],
    success: (c) => c.host.toast('Troopers heading to the Drill Yard', 'ok'),
  },
  fortify: {
    card: fortifyCard, applies: () => true, role: () => 'depths',
    commit(c, p) {
      const tile = resolvePointer(c, p).tile;
      if (!tile) return [];
      const units = c.selection.units.filter(canFortify);
      if (!units.length) { c.host.toast('Select diggers or Wardens first'); return []; }
      const x = Math.min(c.world.size - 1, Math.floor(tile.x)), y = Math.min(c.world.size - 1, Math.floor(tile.y));
      ping(c, x + 0.5, y + 0.5, 'depths', PING.patrol);
      return [{ kind: 'fortify', units: unitIds(units), x, y, ...queue(p) }];
    },
    preview: (c, p) => tilePreview(c, p, 0, PING.patrol, 'Fortify'),
  },
  bulkhead: {
    livePreview: true,
    card: kindCard('digger'), applies: hasKind('digger'), role: () => 'depths',
    commit(c, p) {
      const tile = resolvePointer(c, p).tile;
      const units = ofKind(c, 'digger');
      if (!tile || !units.length) return [];
      const x = Math.min(c.world.size - 1, Math.floor(tile.x)), y = Math.min(c.world.size - 1, Math.floor(tile.y));
      ping(c, x + 0.5, y + 0.5, 'depths', PING.patrol);
      return [{ kind: 'queue_add', item: 'bulkhead', x, y, digger: nearest(units, x, y).id }];
    },
    success: (c) => c.host.toast('Bulkhead queued', 'ok'),
    preview: (c, p) => buildPreview(c, p, 'bulkhead', PING.patrol, 'Bulkhead'),
  },
  geothermal: {
    card: kindCard('digger'), applies: () => true, role: () => 'depths',
    readiness: (_s, v) => v?.match ? alloyCost(v.match.rules.stats.geothermal.alloy, 'per tap') : WAITING,
    commit(c, p) {
      const tile = resolvePointer(c, p).tile;
      const v = c.host.view();
      if (!tile || !v) return [];
      const x = Math.max(0, Math.min(c.world.size - 1, Math.floor(tile.x)));
      const y = Math.max(0, Math.min(c.world.size - 1, Math.floor(tile.y)));
      if (cell(c, x, y) !== CELL.rock || !v.pockets.some((pocket) => Math.abs(pocket.x - x) + Math.abs(pocket.y - y) === 1)) {
        c.host.toast('Choose known rock cardinally beside a located sealed magma pocket');
        return [];
      }
      const units = ofKind(c, 'digger');
      ping(c, x + 0.5, y + 0.5, 'depths', PING.patrol);
      return [{ kind: 'queue_add', item: 'geothermal', x, y, ...(units.length ? { digger: nearest(units, x, y).id } : {}) }];
    },
    success: (c) => c.host.toast('Geothermal tap queued', 'ok'),
    preview: (c, p) => tilePreview(c, p, 0, PING.patrol, 'Geothermal tap · beside sealed magma', true),
  },
  undermine: depthsVerb('undermine', 'sapper', ECON.collapseRadius, 'Collapse zone', true),
  breach: depthsVerb('breach', 'trooper', 0.7, 'Breach up here (6 s)', true),
  rail: depthsVerb('rail', 'digger', 0, 'Lay rail to here', false, (_s, v) => v?.match ? alloyCost(v.match.rules.depths.railCost, 'per cell') : WAITING),
  bridge: depthsVerb('bridge', 'digger', 0, 'Backfill or bridge here', false, (_s, v) => backfillReadiness(v)),
  deploy: deployTool(true),
  pack: deployTool(false),
  flare: {
    card: kindCard('warden'), applies: hasKind('warden'), role: () => 'depths',
    readiness: (s, v) => flareReadiness(s.units, v),
    commit(c, p) {
      const view = c.host.view();
      const tile = resolvePointer(c, p).tile;
      const range = view?.match?.rules.depths.flareRange;
      if (!view || !tile || range === undefined) return [];
      const x = Math.max(0, Math.min(c.world.size - 1, Math.floor(tile.x))), y = Math.max(0, Math.min(c.world.size - 1, Math.floor(tile.y)));
      if (!isOpenCell(cell(c, x, y))) { c.host.toast('Throw flares onto a known open tunnel cell'); return []; }
      const ready = ownWardens(c.selection.units, view).filter((e) => flareReady(e, view) && Math.hypot(e.x - x - 0.5, e.y - y - 0.5) <= range);
      if (!ready.length) { c.host.toast(`No ready Warden within ${range} tiles`); return []; }
      ping(c, x + 0.5, y + 0.5, 'depths', FLARE_COLOR);
      return [{ kind: 'flare', unit: nearest(ready, x, y).id, x: x + 0.5, y: y + 0.5 }];
    },
    preview: (c, p) => tilePreview(c, p, c.host.view()?.match?.rules.depths.flareRange ?? 0, FLARE_COLOR, 'Flare · lights the tunnels round it', true),
  },
  mine_asteroid: {
    card: kindCard('tug'), applies: hasKind('tug'), role: () => 'orbit',
    commit(c, p) {
      const { track } = resolvePointer(c, p, { target: 'orbit', entity: true });
      const rock = c.host.view()?.entities.find((e) => e.id === track?.e.id);
      if (!rock || rock.kind !== 'asteroid' || rock.state !== 'drifting' || (rock.resourceType !== 'metal' && rock.resourceType !== 'ice') || (rock.resourceRemaining ?? 0) <= 0) {
        c.host.toast('Choose a visible drifting metal or ice asteroid with resources remaining');
        return [];
      }
      ping(c, rock.x, rock.y, 'orbit', PING.patrol);
      return [{ kind: 'mine_asteroid', units: unitIds(ofKind(c, 'tug')), asteroid: rock.id, ...queue(p) }];
    },
  },
  grapple: {
    card: kindCard('tug'), applies: hasKind('tug'), role: () => 'orbit',
    commit(c, p) {
      const { track } = resolvePointer(c, p, { target: 'orbit', entity: true });
      const rock = c.host.view()?.entities.find((e) => e.id === track?.e.id);
      if (!rock || !((rock.kind === 'asteroid' && rock.state === 'drifting') || (rock.kind === 'core' && rock.state === 'idle'))) {
        c.host.toast('Choose a drifting asteroid or resting core');
        return [];
      }
      ping(c, rock.x, rock.y, 'orbit', PING.patrol);
      return [{ kind: 'grapple', units: unitIds(ofKind(c, 'tug')), asteroid: rock.id, ...queue(p) }];
    },
  },
  deorbit: {
    aim: (c) => {
      DROP_AIM.radius = Math.max(PEEK_RADIUS, dropRadius(c.selection.units, c.host.view()) * DROP_FRAME);
      return DROP_AIM;
    },
    // The tug keeps moving and the Sky changes while the pointer rests: the release point and warnings follow.
    livePreview: true,
    card: (s) => kindCard('tug')(s) && s.units.some((e) => e.kind === 'tug' && (e.state === 'towing' || e.link !== undefined)), applies: () => true, role: () => 'orbit',
    commit(c, p) {
      const { tile, plane } = resolvePointer(c, p, { target: 'surface' });
      if (!tile) return [];
      const units = ofKind(c, 'tug');
      if (!units.length) { c.host.toast('Select a towing tug first'); return []; }
      const x = round2(tile.x, c.world.size), y = round2(tile.y, c.world.size);
      ping(c, x, y, plane, PING.attack);
      return [{ kind: 'deorbit', units: unitIds(units), x, y }];
    },
    preview(c, p) {
      const { tile } = resolvePointer(c, p, { target: 'surface' });
      const view = c.host.view();
      const lens = c.state.lens;
      if (lens?.active && tile) {
        // The Surface scope draws the forecast where the intent lands; no second ring far below on the main view.
        forecastDrop(lens.drop, view, c.selection.units, round2(tile.x, c.world.size), round2(tile.y, c.world.size));
        c.overlay.preview = undefined;
        return;
      }
      const core = !!view && coreTugs(c.selection.units, view).length > 0;
      tilePreview(c, p, dropRadius(c.selection.units, view), DROP_HEX, core ? 'Core strike zone' : 'Impact zone', false, 'surface');
    },
  },
  vent: {
    immediate: true, role: () => 'orbit',
    card: (s, v) => kindCard('tug')(s) && !!v && coreTugs(s.units, v).length > 0, applies: hasKind('tug'),
    readiness: (s, v) => ventReadiness(s.units, v),
    commit(c) {
      const view = c.host.view();
      const units = view ? coreTugs(c.selection.units, view) : [];
      if (!units.length) { c.host.toast('Select a tug towing the derelict core'); return []; }
      return [{ kind: 'vent', units: unitIds(units) }];
    },
  },
  release: {
    immediate: true, role: () => 'orbit',
    card: (s, v) => kindCard('tug')(s) && !!v && towingTugs(s.units, v).length > 0, applies: hasKind('tug'),
    readiness: (s, v) => releaseReadiness(s.units, v),
    commit(c) {
      const view = c.host.view();
      const units = view ? towingTugs(c.selection.units, view) : [];
      if (!units.length) { c.host.toast('Select a tug with something in tow'); return []; }
      return [{ kind: 'release', units: unitIds(units) }];
    },
  },
  sun_lance: {
    card: kindCard('lancer'), applies: hasKind('lancer'), role: () => 'orbit',
    readiness: (s, v) => orbitAbilityState(s.units, 'sun_lance', v),
    commit(c, p) {
      const view = c.host.view();
      const tile = resolvePointer(c, p, { projection: 'orbit', lens: false }).tile;
      if (!view || !tile) return [];
      const state = orbitAbilityState(c.selection.units, 'sun_lance', view);
      if (!state.enabled) { c.host.toast(state.status); return []; }
      const units = c.selection.units.filter((e) => orbitAbilityReady(e, 'sun_lance', view));
      return [{ kind: 'sun_lance', units: unitIds(units), x: round2(tile.x, c.world.size), y: round2(tile.y, c.world.size) }];
    },
    preview(c, p) {
      const tile = resolvePointer(c, p, { projection: 'orbit', lens: false }).tile;
      c.world.orbitAbilities.aim(tile?.x, tile?.y, c.selection.units);
      tilePreview(c, p, 0.2, '#ffe4a0', 'Sun lance · aim direction', false, 'orbit');
    },
    leave: (c) => c.world.orbitAbilities.aim(),
    reset: (c) => c.world.orbitAbilities.aim(),
  },
  aegis: {
    immediate: true, card: kindCard('bastion'), applies: hasKind('bastion'), role: () => 'orbit',
    readiness: (s, v) => orbitAbilityState(s.units, 'aegis', v),
    commit(c) {
      const view = c.host.view();
      if (!view) return [];
      const state = orbitAbilityState(c.selection.units, 'aegis', view);
      if (!state.enabled) { c.host.toast(state.status); return []; }
      return [{ kind: 'aegis', units: unitIds(c.selection.units.filter((e) => orbitAbilityReady(e, 'aegis', view))) }];
    },
  },
  ascend: {
    immediate: true, card: kindCard('interceptor'), applies: hasKind('interceptor'), role: () => 'sky',
    readiness: (s, v) => ascentReadiness(s.units, v),
    commit(c) {
      const view = c.host.view();
      if (!view?.match) return [];
      const state = ascentReadiness(c.selection.units, view);
      if (!state.enabled) { c.host.toast(state.status); return []; }
      return [{ kind: 'ascend', units: unitIds(ascentReady(ascentUnits(c.selection.units, view), view)) }];
    },
  },
  moor: {
    card: kindCard('mooring_tower'), applies: hasKind('mooring_tower'), role: () => 'surface',
    livePreview: true,
    readiness: (s, v) => mooringReadiness(s.units, v),
    aim(c) {
      MOORING_AIM.radius = (c.host.view()?.match?.rules.surface.mooringRange ?? 10) * 2;
      return MOORING_AIM;
    },
    commit(c, p) {
      const view = c.host.view();
      const tower = selectedMooringTower(c.selection.units, view);
      if (!view || !tower) { c.host.toast('Select exactly one of your Mooring Towers'); return []; }
      const readiness = mooringReadiness(c.selection.units, view);
      if (!readiness.enabled) { c.host.toast(readiness.status); return []; }
      const { track } = resolvePointer(c, p, { target: 'sky', pickRadius: 40 });
      const refusal = mooringTargetRefusal(tower, track?.e, view);
      if (refusal || !track) { c.host.toast(refusal ?? 'Pick a visible island through the Sky Lens'); return []; }
      ping(c, tower.x, tower.y, 'surface', PING.patrol);
      return [{ kind: 'moor', tower: tower.id, island: track.e.id }];
    },
    success(c) { c.host.toast('Catch requested · waiting for island to enter range', 'ok'); c.cancel(); },
    preview(c, p) {
      const view = c.host.view();
      const tower = selectedMooringTower(c.selection.units, view);
      if (!view || !tower || !mooringReadiness(c.selection.units, view).enabled) { c.overlay.preview = undefined; c.cancel(); return; }
      const range = view.match!.rules.surface.mooringRange;
      const { track } = resolvePointer(c, p, { target: 'sky', pickRadius: 40 });
      const refusal = mooringTargetRefusal(tower, track?.e, view);
      const inside = track && Math.hypot(track.rx - tower.x, track.ry - tower.y) <= range;
      c.overlay.preview = { x: tower.x, y: tower.y, plane: 'surface', radius: range,
        color: refusal && track ? PING.attack : PING.patrol,
        label: refusal ?? (inside ? 'Catch and lower below Sky traffic · ownership unchanged' : 'Pending catch · wait for island to enter range') };
    },
  },
  unmoor: {
    immediate: true, card: kindCard('mooring_tower'), applies: hasKind('mooring_tower'), role: () => 'surface',
    readiness: (s, v) => mooringReadiness(s.units, v, true),
    commit(c) {
      const view = c.host.view();
      const tower = selectedMooringTower(c.selection.units, view);
      const readiness = mooringReadiness(c.selection.units, view, true);
      if (!tower || !readiness.enabled) { c.host.toast(readiness.status); return []; }
      return [{ kind: 'unmoor', tower: tower.id }];
    },
    success: (c) => c.host.toast('Catch cancelled / island will rise into a safe gap', 'ok'),
  },
  bombard: {
    card: kindCard('island_mortar'), applies: hasKind('island_mortar'), role: () => 'sky', livePreview: true,
    readiness: (s, v) => ({
      enabled: !!v && s.units.some((e) => e.kind === 'island_mortar' && e.side === v.army && e.state !== 'constructing'),
      status: s.units.some((e) => e.kind === 'island_mortar' && e.state !== 'constructing') ? 'Aim through Surface Lens' : 'Under construction',
      cost: {}, description: 'Slow arcing splash strikes the fired point, not a homing target. The impact circle warns everyone who can see that Surface point. Works while drifting or moored; friendly fire applies.',
    }),
    aim(c) {
      MORTAR_AIM.radius = (c.host.view()?.match?.rules.stats.island_mortar.range ?? 8) * 1.5;
      return MORTAR_AIM;
    },
    commit(c, p) {
      const view = c.host.view();
      const target = resolvePointer(c, p, { target: 'surface', pickRadius: 30 }).track?.e;
      if (!view || !target || !view.entities.some((e) => e.id === target.id) || !hostileSide(view.match!, view.army, target.side)) {
        c.host.toast('Pick a visible enemy Surface target through the Lens'); return [];
      }
      const units = c.selection.units.filter((e) => e.kind === 'island_mortar' && e.side === view.army && e.state !== 'constructing' && canFireContact(e, target, view));
      if (!units.length) { c.host.toast('Target outside mortar range'); return []; }
      return [{ kind: 'attack', units: unitIds(units), target: target.id, ...queue(p) }];
    },
    preview(c, p) {
      const view = c.host.view(), lens = c.state.lens;
      const mortar = c.selection.units.find((e) => e.kind === 'island_mortar' && e.side === view?.army);
      if (!view || !mortar || !lens) { c.overlay.preview = undefined; return; }
      const target = resolvePointer(c, p, { target: 'surface', pickRadius: 30 }).track?.e;
      const valid = target && canFireContact(mortar, target, view);
      if (target) forecastStrike(lens.drop, view, c.selection.units, target);
      const track = c.world.entities.tracks.get(mortar.id);
      c.overlay.preview = { x: mortar.x, y: mortar.y, plane: 'sky', height: track ? track.wy + 0.1 : undefined,
        radius: view.match!.rules.stats.island_mortar.range, color: valid ? PING.patrol : PING.attack,
        label: !target ? 'Lens · pick a visible Surface target' : valid ? `Arcing splash · impact in ${lens.drop.fall.toFixed(1)}s · friendly fire` : 'Outside mortar range' };
    },
  },
  emplace: {
    // Registry-driven: the unit a hardpoint attachment converts from (today the Gunship → Gun Platform).
    card: (s, v) => emplaceAvailable(v) && kindCard(HARDPOINT_KINDS.gun_platform.from)(s),
    applies: (s, v) => emplaceAvailable(v) && hasKind(HARDPOINT_KINDS.gun_platform.from)(s), role: () => 'sky',
    readiness: (s, v) => emplaceReadiness(s.units, v),
    commit(c, p) {
      const view = c.host.view();
      const { track } = resolvePointer(c, p, { pickRadius: 40 });
      const refusal = view ? emplaceRefusal(c, view, track) : 'Waiting for match';
      if (!view || !track || refusal) { c.host.toast(refusal); return []; }
      // the selected Gunship nearest the island that can land there (emplaceRefusal guarantees one)
      let unit: Entity | undefined, best = Infinity;
      for (const e of emplaceUnits(c.selection.units, view)) {
        const d = Math.hypot(e.x - track.e.x, e.y - track.e.y);
        if (d < best && emplaceSite(e, view, track.e)) { unit = e; best = d; }
      }
      if (!unit) return [];
      ping(c, track.rx, track.ry, 'sky', PING.patrol);
      return [{ kind: 'emplace', unit: unit.id, island: track.e.id }];
    },
    success: (c) => c.host.toast('Gun Platform emplaced', 'ok'),
    preview(c, p) {
      const view = c.host.view();
      const { track } = resolvePointer(c, p, { pickRadius: 40 });
      if (!view || !track || track.e.kind !== 'island') { c.overlay.preview = undefined; return; }
      const refusal = emplaceRefusal(c, view, track);
      c.overlay.preview = { x: track.rx, y: track.ry, plane: 'sky', height: track.wy + 0.15, radius: view.match?.rules.sky.captureRadius ?? 3, color: refusal ? PING.attack : PING.patrol, label: refusal || 'Emplace Gun Platform' };
    },
  },
  scan: {
    followsPlane: true, card: () => true, applies: () => true, role: () => 'orbit',
    readiness: (_s, v) => scanReadiness(v),
    commit(c, p) {
      const tile = resolvePointer(c, p).tile;
      if (!tile) return [];
      const x = round2(tile.x, c.world.size), y = round2(tile.y, c.world.size);
      for (const plane of PLANES) ping(c, x, y, plane, PING.patrol);
      return [{ kind: 'scan', x, y }];
    },
    preview: (c, p) => tilePreview(c, p, ECON.scanRadius, PING.patrol, 'Scan (all planes)'),
  },
  rally: {
    card: (s) => s.spire && !s.units.length, applies: () => true,
    commit(c, p) {
      const tile = resolvePointer(c, p).tile;
      if (!tile) return [];
      const x = round2(tile.x, c.world.size), y = round2(tile.y, c.world.size), plane = c.world.rig.focus;
      ping(c, x, y, plane, PLANE_ACCENT[plane]);
      return [{ kind: 'rally', x, y }];
    },
    preview: (c, p) => tilePreview(c, p, 0.6, PLANE_ACCENT[c.world.rig.focus], `${PLANE_NAME[c.world.rig.focus]} rally`),
  },
  build: {
    livePreview: true,
    applies: () => true, role: (c) => c.mode?.kind === 'build' ? STATS[c.mode.structure].plane : c.world.rig.focus,
    commit(c, p) {
      if (c.mode?.kind === 'build' && STATS[c.mode.structure].plane === 'sky') {
        const track = islandBuildTarget(c, p);
        if (!track || track.e.kind !== 'island') { c.host.toast('Pick an island'); return []; }
        return [{ kind: 'queue_add', item: c.mode.structure, island: track.e.id }];
      }
      const tile = resolvePointer(c, p).tile;
      if (!tile || c.mode?.kind !== 'build') return [];
      const { x, y } = buildAnchor(c.mode.structure, tile.x, tile.y, c.host.view());
      const f = STATS[c.mode.structure].footprint;
      ping(c, x + f.w / 2, y + f.h / 2, STATS[c.mode.structure].plane, PING.move);
      return [{ kind: 'queue_add', item: c.mode.structure, x, y }];
    },
    success(c) { if (c.mode?.kind === 'build') c.host.toast(`${KIND_LABEL[c.mode.structure]} queued`, 'ok'); },
    preview(c, p) {
      if (c.mode?.kind !== 'build') return;
      if (STATS[c.mode.structure].plane === 'sky') islandBuildPreview(c, p, c.mode.structure, PING.move, KIND_LABEL[c.mode.structure]);
      else buildPreview(c, p, c.mode.structure, PING.move, KIND_LABEL[c.mode.structure]);
    },
  },
  relay: {
    livePreview: true,
    applies: () => true, role: () => 'sky',
    commit(c, p) {
      const track = islandBuildTarget(c, p);
      if (!track || track.e.kind !== 'island') { c.host.toast('Pick an island'); return []; }
      return [{ kind: 'queue_add', item: 'relay', island: track.e.id }];
    },
    preview: (c, p) => islandBuildPreview(c, p, 'relay', PING.move, 'Relay'),
    success: (c) => c.host.toast('Relay queued', 'ok'),
  },
  pick: {
    followsPlane: true, applies: () => true,
    commit(c, p) {
      const tile = resolvePointer(c, p).tile;
      if (!tile || c.mode?.kind !== 'pick') return [];
      const x = round2(tile.x, c.world.size), y = round2(tile.y, c.world.size);
      ping(c, x, y, c.world.rig.focus, PLANE_ACCENT[c.mode.role]);
      c.host.pickDirective(c.mode.role, x, y);
      c.cancel();
      return [];
    },
    preview(c, p) { if (c.mode?.kind === 'pick') tilePreview(c, p, 1.2, PLANE_ACCENT[c.mode.role], `${PLANE_NAME[c.mode.role]} focus`); },
  },
  request: {
    applies: () => true,
    commit(c, p) {
      if (c.mode?.kind !== 'request') return [];
      const from = c.world.rig.focus, to = requestTarget(from, c.mode.need);
      const tile = resolvePointer(c, p).tile;
      if (!tile || !to) return [];
      // Signal tiles are whole cells (all planes share x/y).
      const x = Math.min(c.world.size - 1, Math.max(0, Math.floor(tile.x))), y = Math.min(c.world.size - 1, Math.max(0, Math.floor(tile.y)));
      ping(c, x + 0.5, y + 0.5, from, PLANE_ACCENT[to === 'team' ? from : to]);
      return [requestIntent(from, to, c.mode.need, x, y)];
    },
    preview(c, p) {
      if (c.mode?.kind !== 'request') return;
      const to = requestTarget(c.world.rig.focus, c.mode.need);
      if (to) tilePreview(c, p, 0.6, PLANE_ACCENT[to === 'team' ? c.world.rig.focus : to], `${NEED_LABEL[c.mode.need]} → ${signalTo(to)}`, true);
    },
    success(c) { if (c.mode?.kind === 'request') c.host.toast(`${NEED_LABEL[c.mode.need]} requested`, 'ok'); },
  },
};

export const PLANE_TOOLS: readonly PlaneTool[] = TOOL_META.map((meta) => meta.id === 'designate' ? designationTool(meta) : { ...meta, ...behaviors[meta.id] });
const tools = new Map(PLANE_TOOLS.map((tool) => [tool.id, tool]));
export function getTool(id: ToolId): PlaneTool { return tools.get(id)!; }
export function toolForCommand(id: string | undefined): PlaneTool | undefined { return id ? tools.get(id as ToolId) : undefined; }
export function eligible(tool: PlaneTool, plane: Plane, selection: ToolSelection, view: View | undefined): boolean {
  return tool.planes.includes(plane) && tool.applies(selection, view);
}

/** Stateful pointer lifecycle belongs to the active tool, not to Controls or a verb-specific event path. */
export class ToolSession {
  readonly state: ToolContext['state'];
  readonly tool: PlaneTool;
  private readonly context: () => Omit<ToolContext, 'state'>;
  private readonly current: ToolContext;
  private peeking = false;
  private reversePeek = false;
  private contactsVisible = false;
  constructor(tool: PlaneTool, context: () => Omit<ToolContext, 'state'>) {
    this.tool = tool;
    this.context = context;
    const initial = context();
    this.state = { lens: createLens(initial.world.size) };
    this.current = { ...initial, state: this.state };
    if (tool.id === 'lensAttack') this.state.contacts = createContacts();
  }
  private get c(): ToolContext {
    Object.assign(this.current, this.context());
    this.current.state = this.state;
    return this.current;
  }
  enter(): void {
    const c = this.c;
    this.tool.enter?.(c);
    if (this.state.contacts) this.updateContacts(c, this.state.pointer);
  }
  get capturesDrag(): boolean { return !!this.tool.capturesDrag || !!this.state.rightDrag?.active; }
  reset(): void {
    this.state.start = this.state.pointer = undefined;
    this.state.hint = undefined;
    const c = this.c;
    c.overlay.drag = c.overlay.preview = undefined;
    if (this.state.lens) this.state.lens.active = false;
    this.clearContacts(c);
    c.world.lens.show();
    this.tool.reset?.(c);
  }
  leave(): void {
    if (!this.capturesDrag) this.state.pointer = undefined;
    this.clearContacts(this.c);
    this.c.world.lens.show();
    if (this.state.lens) this.state.lens.active = false;
    this.tool.leave?.(this.c);
  }
  /** Hold-peek may be used without units and does not arm a command. */
  peek(active: boolean, reverse = false): void {
    this.peeking = active;
    this.reversePeek = reverse;
    this.preview();
  }
  private clearContacts(c: ToolContext): void {
    this.contactsVisible = false;
    if (this.state.contacts) {
      this.state.contacts.active = false;
      this.state.contacts.hovered = undefined;
    }
    c.overlay.contacts = undefined;
  }
  private updateContacts(c: ToolContext, p?: ToolPointer): void {
    this.contactsVisible = true;
    const contacts = c.state.contacts!;
    configureContacts(contacts, c.selection, c.world.rig.focus, c.host.view());
    c.overlay.contacts = contacts.active ? contacts : undefined;
    c.overlay.preview = undefined;
    c.world.hovered = undefined;
    contacts.hovered = p ? contactAttackTarget(c, p)?.e.id : undefined;
    this.strikeHolo(c, contacts, p);
  }
  /**
   * The O tool's targeted planes as a holo lens around the cursor (view only: contacts still pick and order), with the
   * hovered contact's strike forecast: splash, friendly fire and what shoots back at the firing plane.
   */
  private strikeHolo(c: ToolContext, contacts: Contacts, p?: ToolPointer): void {
    const lens = c.state.lens;
    const view = c.host.view();
    c.state.lensViewOnly = true;
    if (!lens || !p || !view || !contacts.active || c.host.readOnly) {
      if (lens) lens.active = false;
      c.world.lens.show();
      return;
    }
    const source = contacts.source;
    let target: Plane | undefined;
    let hovered: Entity | undefined;
    if (contacts.hovered) for (const e of view.entities) if (e.id === contacts.hovered) { hovered = e; target = e.plane; break; }
    // Otherwise the nearest targeted plane, below first (bombers and drops look down; flak and the Spire up).
    if (!target) {
      let best = Infinity;
      for (const plane of contacts.planes) {
        const d = PLANES.indexOf(source) - PLANES.indexOf(plane);
        const rank = d > 0 ? d : -d + 0.5;
        if (rank < best) { best = rank; target = plane; }
      }
    }
    if (!target) { lens.active = false; c.world.lens.show(); return; }
    STRIKE_AIM.plane = target;
    previewLens(c, p, STRIKE_AIM);
    if (lens.active && hovered) forecastStrike(lens.drop, view, contacts.units, hovered);
  }
  private updateLens(c: ToolContext, p: ToolPointer): void {
    if (this.state.contacts) {
      this.updateContacts(c, p);
      return;
    }
    // A spectator cannot order, so nothing is aimed: held peek still views.
    const aim = c.host.readOnly ? undefined : typeof this.tool.aim === 'function' ? this.tool.aim(c) : this.tool.aim;
    const interactive = !!aim;
    c.state.lensViewOnly = interactive ? !!aim.view : this.peeking;
    if (interactive) previewLens(c, p, aim);
    else if (this.peeking) previewLens(c, p, (this.reversePeek ? REVERSE_PEEK_AIMS : PEEK_AIMS)[c.world.rig.focus]);
    else if (c.state.lens?.active) {
      c.state.lens.active = false;
      c.world.lens.show();
    }
  }
  preview(pointer?: ToolPointer): void {
    if (pointer) this.state.pointer = pointer;
    if (this.state.pointer) {
      const c = this.c;
      this.updateLens(c, this.state.pointer);
      this.tool.preview?.(c, this.state.pointer);
    }
  }
  frame(): void {
    if (this.state.contacts) {
      if (this.contactsVisible) this.updateContacts(this.c, this.state.pointer);
      return;
    }
    if (this.state.start || this.tool.livePreview) this.preview();
    else if (this.state.pointer && !this.state.rightDrag?.active) this.updateLens(this.c, this.state.pointer);
  }
  modifiers(modifiers: Pick<ToolPointer, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): void {
    if (this.state.pointer) this.preview({ ...this.state.pointer, shiftKey: modifiers.shiftKey, altKey: modifiers.altKey, ctrlKey: modifiers.ctrlKey, metaKey: modifiers.metaKey });
  }
  start(p: ToolPointer): void { this.state.pointer = p; this.tool.dragStart?.(this.c, p); }
  move(p: ToolPointer): void {
    this.state.pointer = p;
    const c = this.c;
    this.tool.dragMove?.(c, p);
    this.updateLens(c, p);
    this.tool.preview?.(c, p);
  }
  end(p: ToolPointer): void { this.send(p, this.tool.dragEnd ?? this.tool.click ?? this.tool.commit); }
  click(p: ToolPointer): void { this.send(p, this.tool.click ?? this.tool.commit); }
  private send(p: ToolPointer, commit: PlaneTool['commit']): void {
    this.state.pointer = p;
    const c = this.c;
    if (!eligible(this.tool, c.world.rig.focus, c.selection, c.host.view())) return;
    this.updateLens(c, p);
    const intents = commit(c, p);
    if (!intents.length) return;
    void c.host.act(this.tool.role?.(c) ?? c.world.rig.focus, intents).then((ok) => {
      if (!ok) return;
      this.tool.success?.(c);
      if (!this.tool.persistent && !this.tool.immediate && !p.shiftKey) c.cancel();
    });
  }
}
