/**
 * The 3D world: WebGPURenderer (automatic WebGL2 fallback), the ink pipeline (`ink.ts`), layers, entities, effects.
 * No scene lights: materials are unlit cel shading keyed to the `SUN` uniform (`materials.ts`).
 */
import { Plane as MathPlane, Raycaster, type Object3D, type RenderPipeline, Scene, Vector2, Vector3, WebGPURenderer } from 'three/webgpu';
import { mix, screenUV } from 'three/tsl';
import { DEFAULT_RULES, PLANES, PLANE_Y, frameOf, type ArmyId, type Plane, type Side, type View } from '@agent-command/game/contract';
import { matchArmy } from '../armies.ts';
import { setArmyColours } from './common.ts';
import { CameraRig } from './camera.ts';
import { Entities, type Track } from './entities.ts';
import { Designations } from './designations.ts';
import { applyFade } from './fade.ts';
import { Awareness } from './awareness.ts';
import { unitZoomScale } from './rig.ts';
import { Combat } from './combat.ts';
import { FogField, MAP_SIZE } from './fog.ts';
import { Fx } from './fx.ts';
import { LINE_DIST, compileInkOutput, compileInkScene, inkPipeline, setDiveFx, showInkOverlays } from './ink.ts';
import { StormClouds } from './storm-clouds.ts';
import { Layers } from './layers.ts';
import { GRID, clock, clockAt, prepareMaterials, setSun } from './materials.ts';
import { VIEW, setViewLevel } from './palette.ts';
import { Telegraphs } from './telegraphs.ts';
import { faultsOf } from './terrain.ts';
import { GROUND } from './common.ts';
import { UndergroundArt } from './underground.ts';
import { HoloLens } from './holo.ts';
import { projectFootprint, quadDistance, quadIntersectsBox, type FootprintQuad } from '../footprints.ts';
import { rockScale } from './asteroid.ts';
import { idSpace, matchView, type MatchView } from '../match-view.ts';
import { OrbitAbilityFx } from './orbit-ability-fx.ts';
import { yieldStartup } from './startup.ts';
import { GroundAmbience } from './ambient-ground.ts';
import { AirAmbience } from './ambient-air.ts';
import { SPIRE_SPAN, spireBaseY } from './spires.ts';
import { QUALITY, backendChoice, qualityTier, type Quality } from './quality.ts';
import { isPhone } from '../mobile-banner.ts';

/** Returned by view updates that apply synchronously (one shared promise, no allocation per view). */
const SETTLED = Promise.resolve();
/** Main-thread time (ms) a live warm-up may spend starting compiles between two rendered frames. */
const FRAME_SLICE_MS = 4;

export interface ScreenPoint {
  x: number;
  y: number;
  behind: boolean;
}

/** What World.prepareFirstFrame warms. */
export interface WarmOptions {
  /** Planes whose exact startup views are warmed (default: every plane). */
  planes?: readonly Plane[];
  /** Also warm match-only draw templates (units, effects) no view has admitted yet (default true). */
  templates?: boolean;
  /** Frames render while warming: skip the output composite (warmed by an earlier call with no frames running). */
  live?: boolean;
  progress?: (event: ProgressEvent) => void;
}

export class World {
  renderer!: WebGPURenderer;
  readonly scene = new Scene();
  /** Drawn after the storms against this scene's depth: command overlays and public effects above the storm
   * (`Entities.overlays`, `Fx.aboveStorm`). */
  private readonly overlayScene = new Scene();
  readonly rig: CameraRig;
  /** Populated in bounded startup tasks by init(), before a Game can observe the world. */
  layers!: Layers;
  entities!: Entities;
  fx!: Fx;
  combat!: Combat;
  orbitAbilities!: OrbitAbilityFx;
  awareness!: Awareness;
  designations!: Designations;
  lens!: HoloLens;
  telegraphs!: Telegraphs;
  underground!: UndergroundArt;
  groundAmbience!: GroundAmbience;
  airAmbience!: AirAmbience;
  /** One fog for every size: its textures and shader nodes are shared, so materials compile once for all sizes. */
  readonly fog: FogField;
  private renderSize: number;
  /** Each bounded size keeps its GPU resources; switching matches never mutates another world's fields. */
  private readonly scenes = new Map<number, Pick<World, 'layers' | 'entities' | 'fx' | 'combat' | 'orbitAbilities' | 'awareness' | 'designations' | 'lens' | 'telegraphs' | 'underground' | 'groundAmbience' | 'airAmbience'>>();

  get size(): number { return this.view?.match.rules.map.size ?? this.renderSize; }
  /** Islands whose drift path is highlighted (hovered or selected); reused every frame. */
  private readonly highlight = new Set<string>();
  private readonly islandSide = (id: string): Side => this.entities.tracks.get(id)?.e.side ?? 'neutral';
  private readonly footprintQuad: FootprintQuad = new Float64Array(8);
  private pipeline!: RenderPipeline;
  /** The Sky's fused storm pass, composited over the ink output; follows the active map's weather layer. */
  private storms!: StormClouds;
  view: MatchView | undefined;
  /** Set by the observer surface: `all` labels every Spire as an objective; any observer starts the camera at the map
   * centre instead of the first army's Spire. Unset while playing. */
  observing: ArmyId | 'all' | undefined;
  private viewAt = 0;
  private viewReady = Promise.withResolvers<void>();
  private pendingView: MatchView | undefined;
  /** The first view's asynchronous preparation (size bundle, island art); settles when adopted or reset. */
  private preparingView: Promise<void> | undefined;
  private generation = 0;
  private last = performance.now();
  private readonly ray = new Raycaster();
  /** Frames rendered and time spent (the `?stats` readout); `draws`/`passes`/`computes` are the last frame's draw
   *  calls, render passes (scene, quad and target renders) and compute dispatches. */
  readonly perf = { frames: 0, since: performance.now(), fps: 0, frameMs: 0, draws: 0, passes: 0, computes: 0 };
  backend = 'webgpu';
  /** The GPU as the backend names it (WebGPU adapter info, or WebGL's unmasked renderer); empty when withheld. */
  gpu = '';
  /** The render tier (`quality.ts`), chosen once at init. */
  quality: Quality = QUALITY.full;
  selected = new Set<string>();
  hovered: string | undefined;
  /** The army whose view is shown. */
  army: ArmyId = 'nw';

  readonly canvas: HTMLCanvasElement;
  private rect = { left: 0, top: 0, width: 1, height: 1 };
  private readonly scratch = new Vector3();
  private readonly groundPlane = new MathPlane(new Vector3(0, 1, 0), 0);
  private readonly ndc = new Vector2();
  private readonly ground = { x: 0, y: 0 };
  private readonly screen: ScreenPoint = { x: 0, y: 0, behind: false };

  /** Retained CSS viewport shared by scope rendering and pointer mapping. */
  get viewport() { return this.rect; }

  constructor(canvas: HTMLCanvasElement, size = DEFAULT_RULES.map.size) {
    this.canvas = canvas;
    this.renderSize = size;
    this.rig = new CameraRig(size);
    this.fog = new FogField(size);
  }

  async init(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const quality = this.quality = QUALITY[qualityTier(params, isPhone())];
    // Driver extension discovery is synchronous; pre-enable each extension in its own startup task.
    const forceWebGL = backendChoice(params, 'gpu' in navigator) === 'webgl';
    let context: WebGL2RenderingContext | undefined;
    if (forceWebGL) {
      await yieldStartup();
      context = this.canvas.getContext('webgl2', { antialias: quality.msaa, alpha: true, depth: true, stencil: false, powerPreference: 'high-performance' }) ?? undefined;
      if (!context) throw new Error('Agent Command needs WebGPU or WebGL2.');
      await yieldStartup();
      for (const extension of context.getSupportedExtensions() ?? []) {
        context.getExtension(extension);
        await yieldStartup();
      }
    }
    this.renderer = new WebGPURenderer({ canvas: this.canvas, antialias: quality.msaa, powerPreference: 'high-performance', forceWebGL, ...(context ? { context } : {}) });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, quality.maxPixelRatio));
    await this.renderer.init();
    // World.frame resets the per-frame counters itself: three only auto-resets them in its own animation loop.
    this.renderer.info.autoReset = false;
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean; device?: GPUDevice; gl?: WebGL2RenderingContext };
    this.backend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    this.gpu = gpuName(backend);
    await prepareMaterials();
    await this.prepareSize(this.renderSize);
    const s = this.scene;
    s.backgroundNode = mix(VIEW.bgBottom, VIEW.bgTop, screenUV.y.oneMinus().pow(0.8));
    // prepareSize attaches the active map's renderer roots to this scene.
    this.storms = new StormClouds(this.rig.camera, quality.stormScale);
    this.overlayScene.add(this.storms.aboveStorm);
    this.pipeline = inkPipeline(this.renderer, s, this.rig.camera, (base, depth, edge) => this.storms.composite(base, depth, edge), this.overlayScene, quality);
    this.resize();
    addEventListener('resize', () => this.resize());
    applyFade(this.rig.level);
    setViewLevel(this.rig.level);
  }

  private async prepareSize(size: number, generation = this.generation): Promise<void> {
    let bundle = this.scenes.get(size);
    if (!bundle) {
      const fog = this.fog;
      const layers = await Layers.create(size, fog, this.quality);
      const terrain = layers.surface.field;
      const entities = await Entities.create(false, size, terrain, fog);
      entities.selectionContours.bindTerrain(layers.surface.drawnGeometry);
      const lens = new HoloLens(size, terrain, fog);
      await yieldStartup();
      const fx = new Fx(size);
      await yieldStartup();
      // WebGPU simulates particles in compute; WebGL2 keeps the CPU pools (`gpu-particles.ts`).
      const combat = await Combat.create(size, terrain, fog, this.backend === 'WebGPU');
      combat.tracks = entities.tracks;
      combat.deaths.configure(this.quality);
      entities.deaths = combat.deaths;
      await yieldStartup();
      const orbitAbilities = new OrbitAbilityFx(size, fog);
      const awareness = new Awareness(combat, size, terrain);
      const designations = new Designations(size);
      await yieldStartup();
      const telegraphs = new Telegraphs(combat, size, terrain, layers.depths);
      const underground = new UndergroundArt(size);
      layers.depths.group.add(underground.depths);
      const groundAmbience = new GroundAmbience(size, fog, terrain);
      const airAmbience = new AirAmbience(size, fog);
      bundle = { layers, entities, lens, fx, combat, orbitAbilities, awareness, designations, telegraphs, underground, groundAmbience, airAmbience };
      this.scenes.set(size, bundle);
    }
    if (generation !== this.generation) return;
    if (this.layers) {
      this.scene.remove(this.layers.root, this.designations.root, this.awareness.root, this.lens.root, this.telegraphs.root, this.entities.root, this.fx.root, this.combat.root, this.orbitAbilities.root, this.groundAmbience.group, this.airAmbience.group);
      this.overlayScene.remove(this.entities.overlays, this.fx.aboveStorm);
    }
    Object.assign(this, bundle);
    this.renderSize = size;
    MAP_SIZE.value = size;
    if (this.fog.size !== size) this.fog.setSize(size);
    this.rig.setSize(size);
    this.scene.add(this.layers.root, this.designations.root, this.awareness.root, this.lens.root, this.telegraphs.root, this.entities.root, this.fx.root, this.combat.root, this.orbitAbilities.root, this.groundAmbience.group, this.airAmbience.group);
    this.overlayScene.add(this.entities.overlays, this.fx.aboveStorm);
  }

  whenView(): Promise<void> { return this.view ? Promise.resolve() : this.viewReady.promise; }

  /**
   * Warm the draws each plane's exact startup view admits (a view-less backdrop included), plus, by default, the
   * match-only draw templates and the output composite, without admitting hidden entities or the closed scope. Draws
   * are gathered per plane with the live camera, fades and visibility restored at once, then compiled with their
   * programs linking in parallel. `live`: frames keep rendering meanwhile (the backdrop's later planes); the output
   * composite holds renderer state across awaits, so it is only warmed by a call with no frames running. Resolves
   * false when a reset (another map, a match) superseded the warm-up.
   */
  async prepareFirstFrame(options: WarmOptions = {}): Promise<boolean> {
    const { planes = PLANES, templates = true, live = false, progress } = options;
    await Promise.all([this.layers.surface.ready(), this.layers.depths.ready(), this.layers.orbit.ruin.ready()]);
    const generation = this.generation;
    const draws = new Set<Object3D>();
    for (const plane of planes) {
      await yieldStartup();
      if (generation !== this.generation) return false;
      this.collectDraws(plane, draws);
    }
    // Only explicitly supplied canonical templates bypass visibility, and only as detached copies: the live meshes,
    // fog state and closed scope keep their own visibility and instance counts. The home preview's Orbit approach
    // regions count as one: they show only while the preview focuses the Orbit, never in a startup pose; so does the
    // derelict's close-zoom dressing, hidden in a far startup pose.
    if (templates) for (const template of [...this.entities.shaderTemplates, ...this.fx.shaderTemplates, this.layers.orbit.regions, ...this.layers.orbit.ruin.shaderTemplates, ...this.groundAmbience.shaderTemplates, ...this.airAmbience.shaderTemplates]) draws.add(template.clone(false));
    const total = draws.size + (live ? 0 : 1);
    let loaded = 0;
    const step = progress ? (): void => progress(new ProgressEvent('progress', { lengthComputable: true, loaded: ++loaded, total })) : undefined;
    // Live: leave each frame most of its budget (FRAME_SLICE_MS of draw starts between rendered frames).
    await compileInkScene(this.pipeline, [...draws], { stop: () => generation !== this.generation, linked: step, frameSliceMs: live ? FRAME_SLICE_MS : undefined });
    if (generation !== this.generation) return false;
    if (!live) {
      await compileInkOutput(this.pipeline);
      await this.storms.compile(this.renderer);
      step?.();
      // Preparation time is not animation time.
      this.last = performance.now();
    }
    return generation === this.generation;
  }

  /** Add the draws `plane`'s exact startup view admits, then restore the live camera, fades and visibility. */
  private collectDraws(plane: Plane, into: Set<Object3D>): void {
    const restore = this.rig.saveForPreparation();
    try {
      const now = performance.now();
      this.rig.setPreparationPlane(plane, now);
      this.updateScene(now, 0);
      for (const root of [this.scene, this.overlayScene]) root.traverseVisible((object) => {
        const draw = object as Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
        if (draw.isMesh || draw.isLine || draw.isPoints || draw.isSprite) into.add(object);
      });
    } finally {
      restore();
      // Restore fades, instance admission and focus overlays without advancing the caller's camera/dive.
      this.updateScene(performance.now(), 0);
    }
  }

  resize(): void {
    this.rect = this.canvas.getBoundingClientRect();
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w, h);
  }

  /** Show a view. The promise settles once it is on screen (the first view of a match is prepared asynchronously,
   *  switching to its map size's bundle) or a reset dropped it; later views apply synchronously.
   *  `perspective`: the caller shows another army's view (or id namespace) of the match already on screen (an
   *  observer's vision switch, a spectator's army toggle). The old perspective's state is cleared in place, never
   *  reported as a dropped match (`onReset`): the frame stays up and no loader shows. */
  setView(incoming: View, perspective = false): Promise<void> {
    const view = matchView(incoming, this.view ?? this.pendingView);
    if (!view) return SETTLED;
    if (this.view && view.match.rules.map.size !== this.renderSize) this.reset();
    if (!this.view) {
      this.pendingView = view;
      this.preparingView ??= this.prepareView();
      return this.preparingView;
    }
    this.adoptView(view, perspective);
    return SETTLED;
  }

  private async prepareView(): Promise<void> {
    const generation = this.generation;
    try {
      for (;;) {
        while (this.pendingView!.match.rules.map.size !== this.renderSize) {
          await this.prepareSize(this.pendingView!.match.rules.map.size, generation);
          if (generation !== this.generation) return;
        }
        await this.entities.prepareView(this.pendingView!);
        await yieldStartup();
        if (generation !== this.generation) return;
        const view = this.pendingView!;
        if (view.match.rules.map.size !== this.renderSize) continue;
        this.pendingView = undefined;
        this.preparingView = undefined;
        this.adoptView(view);
        return;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.preparingView = undefined;
      this.viewReady.reject(error);
    }
  }

  private adoptView(view: MatchView, perspective = false): void {
    const previous = this.view;
    // Entity ids are per army (or the sim's, for an observer's omniscient row): tracks never carry across namespaces.
    const first = !previous || previous.army !== view.army || idSpace(previous) !== idSpace(view) || previous.rulesHash !== view.rulesHash || view.tick < previous.tick;
    const now = performance.now();
    if (first && previous) {
      if (perspective) this.clear();
      else this.reset();
    }
    this.view = view;
    this.viewAt = now;
    this.army = view.army;
    if (first) setArmyColours(view.match!.armies);
    // A player's key light turns with their army's camera frame, so every seat sees the same screen-relative light.
    // An observer keeps the camera across perspective switches (ObserverGame.show), so the sun stays with the frame
    // the session's camera opened on: a team switch must never swing shadows or re-bake terrain light in world space.
    if (first && (!previous || this.observing === undefined)) setSun(frameOf(view.army));
    this.entities.ingest(view, now);
    this.layers.update(view, (tick) => clockAt(this.entities.tickTime(tick, now)));
    this.designations.ingest(view);
    this.underground.update(view);
    if (view.match !== previous?.match || first) this.telegraphs.setFaults(faultsOf(view.match));
    this.fx.ingest(view);
    this.fog.ingestWalls(view);
    this.fog.ingestVision(view, first);
    this.groundAmbience.ingest(view);
    this.airAmbience.ingest(view);
    this.combat.focus = this.rig.focus;
    this.combat.ingest(view, (tick) => this.entities.tickTime(tick, now));
    this.orbitAbilities.ingest(view, (tick) => this.entities.tickTime(tick, now));
    this.telegraphs.ingest(view, (tick) => this.entities.tickTime(tick, now), now);
    for (const f of view.fx)
      if (f.kind === 'shot' && f.tp !== undefined && f.tx !== undefined && f.ty !== undefined && f.tick >= view.tick - 1)
        this.entities.fire(f, this.entities.tickTime(f.tick, now), view.impacts);
    if (first) {
      const at = this.observing !== undefined && !previous ? { x: view.match!.rules.map.size / 2, y: view.match!.rules.map.size / 2 } : matchArmy(view.match!, view.army).spireAt;
      this.rig.centerOn(frameOf(view.army), at);
    }
    this.viewReady.resolve();
  }

  /** Agent replies shown as speech bubbles over our Spire segment (plain text only, drawn by the overlay). */
  readonly speeches: { plane: Plane; text: string; until: number }[] = [];

  /** Show `text` (~6 s) as a speech bubble over our Spire segment on `plane`. Plain text, clipped to 120 chars. */
  speech(plane: Plane, text: string): void {
    const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!clean) return;
    const clipped = clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
    const i = this.speeches.findIndex((s) => s.plane === plane);
    if (i >= 0) this.speeches.splice(i, 1);
    this.speeches.push({ plane, text: clipped, until: performance.now() + 6000 });
  }

  /** Called at the end of every reset(): the match was dropped (entry, stop, another match, a lost snapshot), so the
   *  match runtime brings its loader back over it. A perspective switch within the shown match never calls it. */
  onReset: (() => void) | undefined;

  /** Drop all match state when leaving the battlefield. */
  reset(): void {
    this.clear();
    this.onReset?.();
  }

  /** Drop all match state: views, tracks, effects and fog. */
  private clear(): void {
    this.view = undefined;
    this.viewReady = Promise.withResolvers<void>();
    this.generation++;
    this.pendingView = undefined;
    this.preparingView = undefined;
    this.selected = new Set();
    this.hovered = undefined;
    this.entities.reset();
    this.speeches.length = 0;
    this.fx.reset();
    this.combat.reset();
    this.orbitAbilities.reset();
    this.telegraphs.reset();
    this.layers.reset();
    this.designations.reset();
    this.lens.reset();
    this.underground.reset();
    this.groundAmbience.reset();
    this.airAmbience.reset();
    this.fog.resetFog();
  }

  get sinceView(): number {
    return this.view ? Math.min(1.5, (performance.now() - this.viewAt) / 1000) : 0;
  }

  frame(render = true): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.rig.update(now, dt, this.combat.shake);
    this.updateScene(now, dt);
    if (!render) return;
    // A background warm-up (compileInkScene) leaves its scene-pass target and MRT bound between its tasks.
    this.renderer.setRenderTarget(null);
    this.renderer.setMRT(null);
    const info = this.renderer.info;
    info.reset();
    // after every spawn of this frame (`updateScene`), before any draw that reads the particle buffers
    this.combat.dispatch(this.renderer);
    this.pipeline.render();
    const p = this.perf;
    p.draws = info.render.drawCalls;
    p.passes = info.render.frameCalls;
    p.computes = info.compute.frameCalls;
    p.frames++;
    p.frameMs = p.frameMs * 0.95 + (performance.now() - now) * 0.05;
    if (now - p.since > 1000) {
      p.fps = (p.frames * 1000) / (now - p.since);
      p.frames = 0;
      p.since = now;
    }
  }

  /** Shared by live frames and bounded startup views; preparation must not advance the camera animation. */
  private updateScene(now: number, dt: number): void {
    const t = now / 1000;
    applyFade(this.rig.level);
    setViewLevel(this.rig.level);
    setDiveFx(this.rig.look, this.rig.focus, this.rig.diveDir);
    LINE_DIST.value = this.rig.dist;
    this.layers.surface.ground.frame(this.rig.camera.position, this.rig.dist);
    this.fog.stepFog(dt);
    clock.value = clockAt(now);
    this.layers.frame(t, this.view, this.sinceView);
    const quietAmbience = this.combat.reducedMotion || (typeof document !== 'undefined' && document.hidden);
    this.groundAmbience.frame(now, dt, this.rig.focus, quietAmbience);
    this.airAmbience.frame(now, dt, this.rig.focus, quietAmbience);
    // ore caches and post beds keep pace with the units' zoom enlargement so they stay legible beside them far out
    const zs = unitZoomScale(this.rig.dist);
    this.layers.deposits.zoom(zs);
    this.layers.surface.postBeds.zoom(zs);
    this.entities.frame(now, t, this.selected, this.hovered, this.army, this.rig.focus, this.rig.dist, this.layers.orbit.sunAngle.value);
    this.layers.orbit.follow(this.entities.tracks, t);
    this.layers.islandShadows.frame(this.entities.tracks, this.entities.root);
    this.layers.orbit.ruin.frame(this.entities.renderTick, this.rig.dist);
    this.highlight.clear();
    for (const id of this.selected) this.highlight.add(id);
    if (this.hovered) this.highlight.add(this.hovered);
    this.layers.sky.paths(this.view, this.entities.renderTick, this.rig.focus === 'sky', this.highlight, this.islandSide, this.entities.tracks, this.entities.root, this.rig.camera.position, this.combat.deaths);
    this.storms.sync(this.layers.sky.weather);
    showInkOverlays(this.pipeline, this.entities.overlaysShown || this.fx.aboveStormShown || this.storms.boltsShown);
    this.awareness.frame(this.view, this.entities.tracks, this.sinceView, this.rig.focus, this.layers.orbit.sunAngle.value);
    this.telegraphs.focus = this.rig.focus;
    this.telegraphs.frame(now, this.army);
    // A snapshot removes a dead asteroid before that tick is on screen. Rock retirement and its
    // explosion must both follow the interpolated entity clock, not wall time since packet arrival.
    this.fx.frame(now, this.entities.renderTick);
    this.combat.frame(now, dt, this.rig.camera.position.y, this.entities.renderTick);
    this.orbitAbilities.update(now, this.entities.tracks, this.rig.camera.position.y);
    this.lens.frame(this.view, this.entities.tracks, this.rig.focus, this.entities.renderTick, now);
  }

  /** The ink grid under the cursor on the focused plane: the cell under it while hovering, a wider patch while placing. */
  pointAt(clientX: number, clientY: number, placing: boolean): void {
    const g = this.groundPoint(clientX, clientY);
    const hit = g.x >= 0 && g.y >= 0 && g.x < this.size && g.y < this.size;
    GRID.cursor.value.set(g.x - this.size / 2, g.y - this.size / 2);
    GRID.k.value = hit ? (placing ? 0.9 : 0.4) : 0;
    GRID.r.value = placing ? 3.4 : 1.4;
  }

  /** Cursor left the map view: no grid. */
  pointAway(): void {
    GRID.k.value = 0;
  }

  /** Screen point → tile coords on a plane, unbounded (shared scratch object; NaN if the ray misses). */
  groundPoint(clientX: number, clientY: number, plane: Plane = this.rig.focus, height = PLANE_Y[plane] + GROUND[plane] + (plane === 'sky' ? 1 : 0)): { x: number; y: number } {
    const r = this.rect;
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.rig.camera);
    this.groundPlane.constant = -height;
    const hit = this.ray.ray.intersectPlane(this.groundPlane, this.scratch);
    this.ground.x = hit ? hit.x + this.size / 2 : Number.NaN;
    this.ground.y = hit ? hit.z + this.size / 2 : Number.NaN;
    return this.ground;
  }

  /** Screen point → tile coords on a plane (undefined if off the map). */
  pickTile(clientX: number, clientY: number, plane: Plane = this.rig.focus): { x: number; y: number } | undefined {
    const g = this.groundPoint(clientX, clientY, plane);
    if (!(g.x >= 0 && g.y >= 0 && g.x < this.size && g.y < this.size)) return undefined;
    return { x: g.x, y: g.y };
  }

  /** World → client pixel coords. Returns a shared scratch object: read it before the next call. */
  project(x: number, y: number, z: number): ScreenPoint {
    const v = this.scratch.set(x, y, z).project(this.rig.camera);
    const r = this.rect;
    const sp = this.screen;
    sp.x = r.left + ((v.x + 1) / 2) * r.width;
    sp.y = r.top + ((1 - v.y) / 2) * r.height;
    sp.behind = v.z > 1;
    return sp;
  }
  /** Shared scratch quad: consume before projecting another structure. */
  projectFootprint(tr: Track): FootprintQuad | undefined {
    return projectFootprint(this, tr, this.footprintQuad);
  }

  footprintInBox(tr: Track, x0: number, y0: number, x1: number, y1: number): boolean {
    const q = this.projectFootprint(tr);
    return !!q && quadIntersectsBox(q, x0, y0, x1, y1);
  }


  /** Screen-space pick of the entity under the cursor on the focused plane. */
  pickEntity(clientX: number, clientY: number, radiusPx = 22): Track | undefined {
    const focus = this.rig.focus;
    let best: Track | undefined;
    let bd = Infinity;
    for (const tr of this.entities.tracks.values()) {
      if (tr.e.plane !== focus || !tr.visible) continue;
      const big = tr.e.kind === 'island' ? 3.2 : tr.e.kind === 'spire' ? 2 : tr.e.kind === 'asteroid' ? Math.max(1, rockScale(tr.e)) : tr.e.kind === 'core' ? 1.5 : 1;
      const p = this.project(tr.rx - this.size / 2, tr.wy + 0.3, tr.ry - this.size / 2);
      if (p.behind) continue;
      let d = Math.hypot(p.x - clientX, p.y - clientY);
      const corners = this.projectFootprint(tr);
      if (corners) d = quadDistance(corners, clientX, clientY);
      if (tr.e.kind === 'spire') {
        // Pick the landmark's actual unscaled extent, not its cross-plane connector.
        const [lo, hi] = SPIRE_SPAN[tr.e.plane];
        const base = spireBaseY(tr.e.plane, tr.rx, tr.ry, this.layers.surface.field);
        const a = this.project(tr.rx - this.size / 2, base + lo, tr.ry - this.size / 2);
        const ax = a.x;
        const ay = a.y;
        const b = this.project(tr.rx - this.size / 2, base + hi, tr.ry - this.size / 2);
        if (!b.behind) {
          const vx = b.x - ax;
          const vy = b.y - ay;
          const k = Math.min(1, Math.max(0, ((clientX - ax) * vx + (clientY - ay) * vy) / (vx * vx + vy * vy || 1)));
          d = Math.min(d, Math.hypot(ax + vx * k - clientX, ay + vy * k - clientY));
        }
      }
      if (!corners) d /= big;
      // Overlapping horizontal decks/footprints can both score zero; the upper visible surface wins only ties.
      if (d < radiusPx && (d < bd || (d === bd && best && tr.wy > best.wy))) {
        bd = d;
        best = tr;
      }
    }
    return best;
  }
}

/** The GPU behind the backend: WebGPU's adapter info, else WebGL's unmasked renderer string (empty if withheld). */
function gpuName(backend: { device?: GPUDevice; gl?: WebGL2RenderingContext }): string {
  const info = backend.device?.adapterInfo;
  if (info) return [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
  const gl = backend.gl;
  if (!gl) return '';
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
}

