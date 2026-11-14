/**
 * Plane visuals: the Depths (`depths.ts`), the Surface terrain (`terrain.ts`), the Sky's cloud deck and island drift
 * paths (`sky.ts`), the Orbit's sun wedges, debris and tow ropes (`orbit.ts`), and a frame per plane.
 * Distant scenery and stars live in `backdrop.ts`; entities live in `entities.ts`.
 */
import { BufferAttribute, BufferGeometry, Group, LineBasicNodeMaterial, Line, type Object3D } from 'three/webgpu';
import { color, mix } from 'three/tsl';
import { PLANES, PLANE_Y, unpackTerrain, type Plane, type View } from '@agent-command/game/contract';
import { FADE, fadeValue } from './fade.ts';
import { FogField } from './fog.ts';
import { DepthsLayer } from './depths.ts';
import { overlay } from './materials.ts';
import { OrbitLayer } from './orbit.ts';
import { LINE, VIEW } from './palette.ts';
import { SkyLayer } from './sky.ts';
import { SurfaceLayer, faultsOf } from './terrain.ts';
import { Deposits } from './deposits.ts';
import { IslandShadows } from './island-shadows.ts';
import { prepareCloudShapes } from './models.ts';
import { QUALITY, type Quality } from './quality.ts';
import { prepareStartup } from './startup.ts';
import { PlaneBackdrop } from './backdrop.ts';

/** Pencil border per plane so the stack reads as pages. */
function frame(plane: Plane, size: number): Line {
  const s = size / 2 + 0.6;
  const pts = new Float32Array([-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s, -s, 0, -s]);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pts, 3));
  const m = overlay(new LineBasicNodeMaterial());
  m.colorNode = mix(VIEW.ghostPencil, color(LINE[plane]), FADE[plane].focus);
  m.opacityNode = FADE[plane].alpha.mul(FADE[plane].focus.mul(0.4).add(0.25));
  const line = new Line(geo, m);
  line.position.y = PLANE_Y[plane] + (plane === 'surface' ? 0.05 : 0);
  return line;
}
interface LayerParts {
  depths: DepthsLayer;
  surface: SurfaceLayer;
  sky: SkyLayer;
  orbit: OrbitLayer;
  deposits: Deposits;
}

/** One plane per task; the cloud geometry is prepared before either Sky or Weather can request the whole cache. */
function* layerParts(size: number, fogField: FogField, quality: Quality): Generator<void, LayerParts> {
  const depths = new DepthsLayer(size, fogField);
  yield;
  const surface = new SurfaceLayer(size, fogField, undefined, quality);
  yield;
  const sky = new SkyLayer(size, fogField);
  yield;
  const orbit = new OrbitLayer(size, fogField);
  yield;
  const deposits = new Deposits(size, surface.field, fogField);
  yield;
  return { depths, surface, sky, orbit, deposits };
}

export class Layers {
  readonly size: number;
  readonly root = new Group();
  private readonly backdrop = new PlaneBackdrop();
  readonly depths: DepthsLayer;
  readonly surface: SurfaceLayer;
  readonly sky: SkyLayer;
  readonly orbit: OrbitLayer;
  readonly deposits: Deposits;
  /** Sky islands' silhouettes on the Surface; World feeds it the interpolated island tracks every frame. */
  readonly islandShadows: IslandShadows;
  private readonly planeGroups: Group[];
  private match: View['match'];

  /** `quality`: the render tier (`quality.ts`), which sets the Surface's scatter density and shore resolution. */
  static async create(size: number, fogField = new FogField(size), quality: Quality = QUALITY.full): Promise<Layers> {
    await prepareCloudShapes();
    return new Layers(size, fogField, await prepareStartup(layerParts(size, fogField, quality)));
  }

  /** Offline callers can still build a complete scene synchronously. */
  constructor(size: number, fogField = new FogField(size), prepared?: LayerParts) {
    this.size = size;
    if (!prepared) {
      const tasks = layerParts(size, fogField, QUALITY.full);
      let next = tasks.next();
      while (!next.done) next = tasks.next();
      prepared = next.value;
    }
    this.depths = prepared.depths;
    this.surface = prepared.surface;
    this.sky = prepared.sky;
    this.orbit = prepared.orbit;
    this.deposits = prepared.deposits;
    this.islandShadows = new IslandShadows(size, this.surface.field);
    this.planeGroups = [this.depths.group, this.surface.group, this.sky.group, this.orbit.group];
    this.surface.group.add(this.deposits.surface, this.islandShadows.mesh);
    this.depths.group.add(this.deposits.depths);
    const depthsFrame = frame('depths', size), surfaceFrame = frame('surface', size), orbitFrame = frame('orbit', size);
    const borders = new Group();
    borders.add(depthsFrame, surfaceFrame, orbitFrame);
    this.root.add(...this.planeGroups, this.surface.canopyRoot, this.backdrop.group, borders);
    // Lower planes are farther from a top-down camera: draw them first so ghost layers blend correctly.
    // (A Group's renderOrder becomes the groupOrder of its subtree.)
    for (let i = 0; i < this.planeGroups.length; i++) this.planeGroups[i]!.renderOrder = i * 10;
  }

  /** `at(tick)`: server tick → client clock seconds (magma fill/cool timing). */
  update(view: View, at: (tick: number) => number): void {
    if (view.match && view.match !== this.match) {
      this.surface.setTerrain({ codes: unpackTerrain(view.match.terrain, this.size), faults: faultsOf(view.match), posts: view.match.posts });
      this.match = view.match;
    }
    this.surface.update(view.holes, view.lodes);
    this.surface.setFootings(view);
    this.surface.setGroundDetail(view);
    this.surface.setDepths(view.depths);
    this.surface.setPresence(view);
    this.surface.setMarks(view);
    this.deposits.update(view, at);
    this.depths.update(view, at, this.match?.rules);
    this.sky.update(view);
  }

  /** Back to the lobby backdrop. */
  reset(): void {
    this.match = undefined;
    this.surface.reset();
    this.depths.reset();
    this.deposits.reset();
    this.islandShadows.reset();
    this.orbit.setRegions([]);
    this.orbit.ruin.set(undefined);
  }

  frame(t: number, view: View | undefined, sinceView: number): void {
    this.backdrop.frame();
    // Hidden planes must not write depth (they would punch holes in the planes below).
    for (let i = 0; i < this.planeGroups.length; i++) this.planeGroups[i]!.visible = fadeValue[PLANES[i]!] > 0.02;
    this.surface.canopyRoot.visible = this.surface.group.visible;
    this.sky.frame(t);
    if (view) this.orbit.update(view, sinceView);
  }
}
