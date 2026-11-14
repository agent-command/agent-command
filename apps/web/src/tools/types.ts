import { STATS, UNITS_PER_INTENT, footprint, isHardpointKind, isRadiusBound, type BUILDABLE, type Entity, type IslandBuild, type Plane, type StructureKind, type SupportNeed, type View } from '@agent-command/game/contract';
import type { ControlHost, Intent } from '../controls.ts';
import type { DigModifiers, DigPoint, DigRect } from '../designate.ts';
import type { Overlay, Preview } from '../overlay.ts';
import type { World } from '../world/world.ts';
import type { ToolId, ToolMeta } from './catalog.ts';
import { inLens, pickLens, type LensAim, type Lens } from './lens.ts';
import type { Contacts } from './contacts.ts';
import { AIM_Y } from '../world/common.ts';
import { placementFootprint } from '../footprints.ts';
import type { AbilityReadiness } from './readiness.ts';
import { hardpointOffset, islandIdentity } from '../world/models.ts';
const BUILD_PAD = { x: 0, y: 0 };

export type Armed =
  | { kind: 'build'; structure: (typeof BUILDABLE)[number] | IslandBuild }
  | { kind: 'pick'; role: Plane }
  /** Team support request (signals.ts): the map click places it. */
  | { kind: 'request'; need: SupportNeed }
  | { kind: Exclude<ToolId, 'default' | 'build' | 'pick' | 'request' | 'stop' | 'hold' | 'mine' | 'transfer'> };
export interface ToolPointer extends DigModifiers { x: number; y: number; button: number }
export type OrbitFormation = 'wedge' | 'line' | 'escort';
export interface ToolSelection { units: Entity[]; spire: boolean; activeKind?: string; formation?: OrbitFormation }
export interface ToolState {
  start?: DigPoint;
  pointer?: ToolPointer;
  hint?: string;
  rightDrag?: { start: DigPoint; rect?: DigRect; active: boolean };
  lens?: Lens;
  contacts?: Contacts;
  /** Hold-peek is observational; it never redirects orders to the other plane. */
  lensViewOnly?: boolean;
}
export interface ToolContext {
  world: World;
  overlay: Overlay;
  host: ControlHost;
  selection: ToolSelection;
  mode?: Armed;
  state: ToolState;
  select(x: number, y: number, add: boolean, ctrl: boolean): void;
  box(x0: number, y0: number, x1: number, y1: number, add: boolean): void;
  cancel(): void;
}
export interface PlaneTool extends ToolMeta {
  id: ToolId;
  immediate?: boolean;
  persistent?: boolean;
  /** Re-evaluate occupied cells/decks while the pointer rests and the match changes. */
  livePreview?: boolean;
  /** Preserve the mode when navigating between eligible planes. */
  followsPlane?: boolean;
  /** Consume modifier gestures before camera rotation/pinging. */
  capturesDrag?: boolean;
  /** Command card visibility may narrow applicability to the active subgroup. */
  card?(selection: ToolSelection, view: View | undefined): boolean;
  applies(selection: ToolSelection, view: View | undefined): boolean;
  readiness?(selection: ToolSelection, view: View | undefined): AbilityReadiness;
  role?(context: ToolContext): Plane;
  /**
   * Explicit cross-plane ability aim; ordinary weapons use projected contacts. A function sizes the scope to the
   * selection (it returns a retained aim: it runs every frame).
   */
  aim?: LensAim | ((context: ToolContext) => LensAim);
  enter?(context: ToolContext): void;
  click?(context: ToolContext, pointer: ToolPointer): Intent[];
  dragStart?(context: ToolContext, pointer: ToolPointer): void;
  dragMove?(context: ToolContext, pointer: ToolPointer): void;
  dragEnd?(context: ToolContext, pointer: ToolPointer): Intent[];
  preview?(context: ToolContext, pointer: ToolPointer): void;
  leave?(context: ToolContext): void;
  reset?(context: ToolContext): void;
  success?(context: ToolContext): void;
  commit(context: ToolContext, pointer: ToolPointer): Intent[];
}

/** The one screen→map boundary: an interactive scope uses its own orthographic map coordinates. */
export function resolvePointer(context: ToolContext, pointer: ToolPointer, options: { projection?: Plane; targetProjection?: Plane; target?: Plane; ground?: boolean; entity?: boolean; pickRadius?: number; lens?: boolean } = {}) {
  const lens = options.lens === false || context.state.lensViewOnly ? undefined : context.state.lens;
  const lensProjection = !options.projection && !pointer.altKey && lens?.active && (!options.target || options.target === lens.target) ? lens.target : undefined;
  const targetProjection = options.targetProjection ?? lensProjection;
  let projection = targetProjection ?? options.projection ?? context.world.rig.focus;
  let tile = targetProjection
    ? lens?.active && projection === lens.target ? lens.point(pointer.x, pointer.y) : context.world.groundPoint(pointer.x, pointer.y, projection, AIM_Y[projection])
    : options.ground ? context.world.groundPoint(pointer.x, pointer.y, projection)
      : context.world.pickTile(pointer.x, pointer.y, projection);
  const through = !pointer.altKey && projection === lens?.target && tile && inLens(lens, pointer.x, pointer.y);
  if (lensProjection && !options.targetProjection && !through) {
    projection = options.projection ?? context.world.rig.focus;
    tile = options.ground ? context.world.groundPoint(pointer.x, pointer.y, projection) : context.world.pickTile(pointer.x, pointer.y, projection);
  }
  const plane = options.target ?? (through ? lens!.target : projection);
  const track = options.entity || options.pickRadius !== undefined
    ? through ? pickLens(lens!, context.host.view(), context.world, pointer.x, pointer.y, options.pickRadius)
      : context.world.pickEntity(pointer.x, pointer.y, options.pickRadius)
    : undefined;
  return { plane, projection, tile, track: track?.e.plane === plane ? track : undefined };
}
export const round2 = (n: number, size: number): number => Math.max(0, Math.min(size, Math.round(n * 100) / 100));
export const unitIds = (units: Entity[]): string[] => units.slice(0, UNITS_PER_INTENT).map((e) => e.id);
export const queue = (p: ToolPointer): { queue?: true } => p.shiftKey ? { queue: true } : {};
/** Order ping colours by order family. */
export const PING = { move: '#9be36d', fight: '#ffb347', attack: '#ff5a4d', patrol: '#7fd6ff', enter: '#b98bff' } as const;
export function ping(c: ToolContext, x: number, y: number, plane: Plane, color: string): void {
  c.overlay.pings.push({ x, y, plane, color, t0: performance.now() });
}
export function tilePreview(c: ToolContext, p: ToolPointer, radius: number, color: string, label: string, snap = false, target?: Plane): void {
  const { tile, plane } = resolvePointer(c, p, { target });
  c.overlay.preview = tile ? { x: snap ? Math.floor(tile.x) + 0.5 : tile.x, y: snap ? Math.floor(tile.y) + 0.5 : tile.y, plane, radius, color, label } : undefined;
}

export function buildPreview(c: ToolContext, p: ToolPointer, kind: StructureKind, color: string, label: string): void {
  const tile = resolvePointer(c, p).tile;
  if (!tile) { c.overlay.preview = undefined; return; }
  const pv: Preview = c.overlay.preview ?? { x: 0, y: 0, plane: STATS[kind].plane, radius: 0, color, label };
  const f = placementFootprint(kind, tile.x, tile.y, c.host.view(), c.world.layers.surface.field.terrainCodes, c.world.size, pv.footprint);
  pv.x = f.x + f.w / 2; pv.y = f.y + f.h / 2;
  pv.plane = STATS[kind].plane; pv.height = undefined;
  pv.radius = 0; pv.color = color; pv.label = label; pv.footprint = f;
  pv.buildRadius = isRadiusBound(kind);
  c.overlay.preview = pv;
}

/** An existing main building must not obstruct placing a secondary hardpoint (and vice versa). */
export function islandBuildTarget(c: ToolContext, p: ToolPointer) {
  const { track } = resolvePointer(c, p, { pickRadius: 40 });
  const island = track?.e.kind === 'island' ? track : track?.e.plane === 'sky' && track.e.link ? c.world.entities.tracks.get(track.e.link) : undefined;
  return island?.e.kind === 'island' ? island : undefined;
}

/** Island structures follow the observed drifting deck rather than the ground cell grid. */
export function islandBuildPreview(c: ToolContext, p: ToolPointer, kind: StructureKind, color: string, label: string): void {
  const track = islandBuildTarget(c, p);
  const view = c.host.view();
  if (!track || track.e.kind !== 'island' || !view) { c.overlay.preview = undefined; return; }
  const { w, h } = STATS[kind].footprint;
  const secondary = isHardpointKind(kind);
  const pad = secondary ? hardpointOffset(islandIdentity(track.e.id, view.match?.symmetry === 'C4' ? 4 : 2).turns, BUILD_PAD) : undefined;
  const centreX = track.rx + (pad?.x ?? 0), centreY = track.ry + (pad?.y ?? 0);
  const x = centreX - w / 2, y = centreY - h / 2;
  const valid = track.e.side === view.army
    && (kind !== 'ore_extractor' || (track.e.oreCapacity ?? 0) > 0 && track.e.oreRemaining !== undefined && track.e.oreRemaining > 0)
    && (!secondary || !view.islands.find((p) => p.id === track.e.id)?.hardpoint)
    && !view.entities.some((e) => footprint(e.kind) && e.plane === 'sky' && e.link === track.e.id && isHardpointKind(e.kind) === secondary)
    && !view.queue.some((q) => q.island === track.e.id && isHardpointKind(q.item) === secondary);
  const pv: Preview = c.overlay.preview ?? { x: centreX, y: centreY, plane: 'sky', radius: 0, color, label };
  const f = pv.footprint ??= { x, y, w, h, cells: [], reason: null };
  f.x = x; f.y = y; f.w = w; f.h = h; f.cells.length = w * h; f.reason = null;
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
    const cell = f.cells[dy * w + dx] ??= { x: x + dx, y: y + dy, valid };
    cell.x = x + dx; cell.y = y + dy; cell.valid = valid;
  }
  pv.x = centreX; pv.y = centreY; pv.height = track.wy + 0.15;
  pv.plane = 'sky'; pv.radius = 0; pv.color = color;
  pv.label = kind === 'ore_extractor' && !((track.e.oreCapacity ?? 0) > 0) ? 'No ore deposit'
    : kind === 'ore_extractor' && track.e.oreRemaining === undefined ? 'Ore reserve unknown'
      : kind === 'ore_extractor' && track.e.oreRemaining === 0 ? 'Deposit depleted' : label;
  pv.buildRadius = false;
  c.overlay.preview = pv;
}
