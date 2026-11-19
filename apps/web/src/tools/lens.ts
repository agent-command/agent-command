/**
 * Holo lens: other planes drawn superimposed and compressed in height on the viewing plane around a focus point,
 * for held peek and cross-plane aimed abilities. Picking reads only the current fogged view; a hologram hit is the
 * map point the order targets.
 */
import { PLANES, type Plane, type View } from '@agent-command/game/contract';
import { Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { Track } from '../world/entities.ts';
import type { ToolContext, ToolPointer, ToolSelection } from './types.ts';
import { AIM_Y, relation } from '../world/common.ts';
import type { World } from '../world/world.ts';
import { projectFootprint, quadDistance } from '../footprints.ts';
import { createDropForecast } from './drop.ts';
import { islandSeen } from './mooring.ts';

const pickQuad = new Float64Array(8);
export const PEEK_RADIUS = 6;
/** Most planes a holo lens stacks (Orbit looking down through the Sky to the Surface needs two; the Spire's reach, three). */
export const HOLO_LAYERS = 3;
/**
 * Holo layer heights (tiles) off the viewing plane's aim height: each other plane is drawn compressed onto the
 * viewing plane, the nearest `HOLO_LIFT` away and each deeper one `HOLO_STEP` further, so it reads as directly under
 * (or over) you with a slight parallax between stacked layers.
 */
export const HOLO_LIFT = 0.3;
export const HOLO_STEP = 0.8;
/** Preserve lowered Sky geometry within the existing compressed hologram, without introducing another plane. */
export const HOLO_ELEVATION_SCALE = 0.2;
/**
 * `radius` 0: the peek reach. `cursor` (always for radius 0): centred on the point under the cursor, not on the
 * selection. `view`: the hologram only shows; clicks keep resolving on the viewing plane.
 */
export interface LensAim { plane: Plane; radius: number; cursor?: boolean; view?: boolean; islands?: boolean }

/**
 * The planes a lens from `source` toward `target` shows, nearest first, into `out`: every plane passed on the way
 * and the target itself (Orbit → Surface: Sky, then Surface). Empty when the target is the source.
 */
export function lensStack(source: Plane, target: Plane, out: Plane[]): Plane[] {
  out.length = 0;
  const from = PLANES.indexOf(source), to = PLANES.indexOf(target);
  const step = to > from ? 1 : -1;
  if (to !== from) for (let i = from + step; out.length < HOLO_LAYERS; i += step) {
    out.push(PLANES[i]!);
    if (i === to) break;
  }
  return out;
}

/** World height of the holo layer for the `index`-th plane of a stack seen from `source` (down: below its aim height). */
export const holoY = (source: Plane, index: number, down: boolean): number =>
  AIM_Y[source] + (down ? -1 : 1) * (HOLO_LIFT + HOLO_STEP * index);

/**
 * The holo lens state: which planes are drawn superimposed in place on the viewing plane, around which map point and
 * how far. The main perspective camera projects and picks it: what is under the cursor on the hologram is the map
 * point the order targets (`point`), aligned with the world.
 */
export class Lens {
  active = false;
  size: number;
  source: Plane = 'surface';
  target: Plane = 'sky';
  /** Planes drawn, nearest the source first, ending at `target`. */
  readonly stack: Plane[] = [];
  /** Focus: the map point the hologram centres on (cursor or aimed selection). */
  x = 0;
  y = 0;
  /** Falloff radius (tiles): the hologram dissolves into the viewing plane toward it. */
  radius = PEEK_RADIUS;
  /** Screen centre and approximate radius (px) of the region on the target layer, for hit tests. */
  px = 0;
  py = 0;
  pixels = 0;
  down = false;
  hovered?: string;
  /** Mooring accepts visible islands of every allegiance; other abilities retain hostile-only picking. */
  islands = false;
  /** Orbit → Surface drop forecast drawn over the hologram; inactive unless a drop tool filled it this pointer move. */
  readonly drop = createDropForecast();
  private camera?: PerspectiveCamera;
  private readonly near = new Vector3();
  private readonly far = new Vector3();
  private readonly tile = { x: 0, y: 0 };
  private readonly screen = { x: 0, y: 0, behind: false };
  private left = 0;
  private top = 0;
  private width = 1;
  private height = 1;
  /** projectFootprint adapter onto one holo layer (retained: picking allocates nothing). */
  private layer = 0;
  private readonly onLayer = { size: 0, project: (x: number, _y: number, z: number) => this.project(x, this.layer, z) };

  constructor(size: number) { this.size = size; }

  get viewportLeft(): number { return this.left; }
  get viewportTop(): number { return this.top; }

  /** World height of `plane`'s holo layer (the target's when `plane` is not stacked). */
  layerY(plane: Plane = this.target): number {
    const i = this.stack.indexOf(plane);
    return holoY(this.source, i < 0 ? Math.max(0, this.stack.length - 1) : i, this.down);
  }

  entityY(tr: Track, plane: Plane = tr.e.plane): number {
    return this.layerY(plane) + (tr.elevation ?? tr.e.elevation ?? 0) * HOLO_ELEVATION_SCALE;
  }
  update(camera: PerspectiveCamera, viewport?: { left: number; top: number; width: number; height: number }): void {
    this.camera = camera;
    camera.updateMatrixWorld();
    if (viewport) {
      this.left = viewport.left; this.top = viewport.top;
      this.width = viewport.width; this.height = viewport.height;
    }
    const h = this.layerY();
    const c = this.project(this.x - this.size / 2, h, this.y - this.size / 2);
    const cx = c.x, cy = c.y;
    const e = this.project(this.x + this.radius - this.size / 2, h, this.y - this.size / 2);
    this.px = cx; this.py = cy;
    this.pixels = Math.hypot(e.x - cx, e.y - cy);
  }

  /** Screen pixel → map point on the target's holo layer (the main camera ray); unbounded, NaN when the ray misses. */
  point(x: number, y: number): { x: number; y: number } {
    const cam = this.camera;
    if (!cam) { this.tile.x = this.tile.y = Number.NaN; return this.tile; }
    const nx = ((x - this.left) / this.width) * 2 - 1, ny = 1 - ((y - this.top) / this.height) * 2;
    this.near.set(nx, ny, -1).unproject(cam);
    this.far.set(nx, ny, 1).unproject(cam);
    const dy = this.far.y - this.near.y;
    const t = dy === 0 ? Number.NaN : (this.layerY() - this.near.y) / dy;
    this.tile.x = this.near.x + (this.far.x - this.near.x) * t + this.size / 2;
    this.tile.y = this.near.z + (this.far.z - this.near.z) * t + this.size / 2;
    return this.tile;
  }

  /** World point → page pixels through the main camera (shared scratch: read before the next call). */
  project(x: number, y: number, z: number) {
    const s = this.screen;
    if (!this.camera) { s.x = s.y = Number.NaN; s.behind = true; return s; }
    const v = this.near.set(x, y, z).project(this.camera);
    s.x = this.left + ((v.x + 1) / 2) * this.width;
    s.y = this.top + ((1 - v.y) / 2) * this.height;
    s.behind = v.z > 1;
    return s;
  }

  /** A structure's footprint projected on `plane`'s holo layer (shared scratch quad). */
  projectFootprint(plane: Plane, tr: Track, out: Float64Array) {
    this.layer = this.entityY(tr, plane);
    this.onLayer.size = this.size;
    return projectFootprint(this.onLayer, tr, out);
  }
}
export const createLens = (size: number): Lens => new Lens(size);

/** Only held peek and explicitly aimed abilities open the holo lens. */
export function configureLens(out: Lens, selection: ToolSelection, source: Plane, aim?: LensAim): void {
  out.active = !!aim && aim.plane !== source;
  out.hovered = undefined;
  out.islands = aim?.islands ?? false;
  out.drop.active = false;
  out.source = source;
  if (!aim) { out.stack.length = 0; return; }
  out.target = aim.plane;
  lensStack(source, aim.plane, out.stack);
  let x = 0, y = 0, count = 0;
  for (const e of selection.units) if (e.plane === source) { x += e.x; y += e.y; count++; }
  if (count) { out.x = x / count; out.y = y / count; }
  out.radius = aim.radius || PEEK_RADIUS;
  out.down = PLANES.indexOf(out.target) < PLANES.indexOf(source);
}

export function inLens(lens: Lens | undefined, x: number, y: number): boolean {
  return !!lens?.active && (x - lens.px) ** 2 + (y - lens.py) ** 2 <= lens.pixels ** 2;
}

/** Iterate only the current fogged view, with the active ability's target filter. */
export function pickLens(lens: Lens, view: View | undefined, world: Pick<World, 'entities'>, x: number, y: number, radiusPx = 22): Track | undefined {
  if (!view || !lens.active || !inLens(lens, x, y)) return undefined;
  let best: Track | undefined;
  let nearest = Infinity;
  for (const e of view.entities) {
    if (e.plane !== lens.target || (lens.islands ? e.kind !== 'island' || !islandSeen(e, view) : relation(view.army, e.side) !== 'hostile')) continue;
    const tr = world.entities.tracks.get(e.id);
    if (!tr) continue;
    if (Math.hypot(tr.rx - lens.x, tr.ry - lens.y) > lens.radius) continue;
    const corners = lens.projectFootprint(lens.target, tr, pickQuad);
    let d: number;
    if (corners) d = quadDistance(corners, x, y);
    else {
      const screen = lens.project(tr.rx - lens.size / 2, lens.entityY(tr), tr.ry - lens.size / 2);
      if (screen.behind) continue;
      d = Math.hypot(x - screen.x, y - screen.y);
    }
    // Horizontal hologram surfaces are composited lower-to-upper. Equal footprint distances must
    // select the visible upper surface, not whichever entity arrived first in the view.
    if (d <= radiusPx && (d < nearest || (d === nearest && best && lens.entityY(tr) > lens.entityY(best)))) { best = tr; nearest = d; }
  }
  return best;
}

/** Explicit abilities anchor on the selection unless their aim is cursor-centred (drops); held peek follows the cursor. */
export function previewLens(c: ToolContext, p: ToolPointer, aim?: LensAim): void {
  const lens = c.state.lens;
  if (!lens) return;
  const view = c.host.view();
  lens.size = c.world.size;
  configureLens(lens, c.selection, c.world.rig.focus, aim);
  if (!lens.active || p.altKey || c.state.rightDrag?.active) {
    lens.active = false;
    c.world.lens.show();
    return;
  }
  lens.update(c.world.rig.camera, c.world.viewport);
  if (aim?.radius === 0 || aim?.cursor) {
    const point = lens.point(p.x, p.y);
    lens.x = point.x; lens.y = point.y;
    lens.update(c.world.rig.camera, c.world.viewport);
  }
  const track = pickLens(lens, view, c.world, p.x, p.y);
  if (track) lens.hovered = track.e.id;
  c.world.lens.show(lens);
}
