/** Heavy 3D modules live behind this menu-to-match boundary, never in the home module graph; the match HUD (game.ts)
 *  is a further chunk, so the backdrop never waits on it. */
import type { Game, ObserverGame, ObserverOptions, SessionOptions } from './game.ts';
import { Overlay } from './overlay.ts';
import { Peek } from './peek.ts';
import { h, PLANE_ACCENT } from './dom.ts';
import { icon } from './icons.ts';
import { tip } from './tooltip.ts';
import { World } from './world/world.ts';
import { installCursors } from './cursors.ts';
import { beginLoading, finishLoading, setLoading } from './loading.ts';
import { yieldStartup } from './world/startup.ts';
import { PLANES, TICK_RATE, type MatchOptions, type Plane } from '@agent-command/game/contract';
import { attract } from './backdrop.ts';
import { previewKey, previewViews } from './preview-client.ts';
import { PREVIEW_VIEW_TICKS, previewViewAt } from './map-preview.ts';
import { capturePoster, retirePoster } from './poster.ts';
import type { MatchView } from './match-view.ts';
import { StatsReadout, statsWanted } from './stats-readout.ts';
import './home-planes.css';

/** Top to bottom, the order the planes stack in the world. */
const RAIL_PLANES = ['orbit', 'sky', 'surface', 'depths'] as const satisfies readonly Plane[];
const RAIL_LABEL: Record<Plane, string> = { orbit: 'Orbit', sky: 'Sky', surface: 'Surface', depths: 'Depths' };
/** The backdrop opens on its Surface showcase (backdrop.ts): only that view is warmed before the first live frame;
 *  the other planes (and the match templates) warm behind it while it animates, before the tour may leave it. */
const FIRST_PLANES = ['surface'] as const satisfies readonly Plane[];
const LATER_PLANES = PLANES.filter((plane) => plane !== 'surface');
/** How long past its broadcast delay a session's first view may take before the loader reports a failure. */
const FIRST_VIEW_TIMEOUT_MS = 30_000;

export class MatchRuntime {
  private game: Game | ObserverGame | undefined;
  private frameId = 0;
  private readonly peek = new Peek();
  private readonly app: HTMLElement;
  private readonly container: HTMLElement;
  readonly world: World;
  private readonly overlay: Overlay;
  private mode: 'stopped' | 'home' | 'match' = 'stopped';
  private backdropReady: Promise<void> | undefined;
  private wantedMap: MatchOptions = {};
  /** Poster key (poster.ts) of the wanted map, and of the map whose next Surface frame becomes its poster. */
  private wantedPoster: string | undefined;
  private capture: string | undefined;
  private shownMap: string | undefined;
  /** Map sizes whose scene bundle has compiled every plane's pipelines (a bundle is kept per size). */
  private readonly warmSizes = new Set<number>();
  /** The backdrop's background warm-up of its later planes, while frames render. */
  private warming: Promise<void> | undefined;
  private attractAt = performance.now();
  private lastDraw = performance.now();
  /** Home plane picker: a pinned plane holds the backdrop there instead of touring. */
  private pinned: Plane | undefined;
  private readonly planeRail: HTMLElement;
  private readonly railButtons = new Map<Plane, HTMLButtonElement>();
  /** Home map preview: the shown map's tick-0 view, and preview time (ms, advanced by drawn frames only, so a hidden
   *  tab pauses it) with the tick of the last view sent. */
  private preview: MatchView | undefined;
  private previewMs = 0;
  private previewTick = 0;
  private readonly stats: StatsReadout | undefined;
  /** The session whose first frame (on entry, or after its world was dropped) the loader is holding for. */
  private pending: Game | ObserverGame | undefined;
  /** The session's broadcast delay: an observer's first view can be that late. */
  private delayMs = 0;
  /** A shown session's world was dropped and its next frame never came; play.ts offers a retry. */
  onFail: ((message: string) => void) | undefined;

  private constructor(
    app: HTMLElement,
    container: HTMLElement,
    world: World,
    overlay: Overlay,
  ) {
    this.app = app;
    this.container = container;
    this.world = world;
    this.overlay = overlay;
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
      Object.assign(window, { __agentCommand: { world, game: () => this.game } });
    }
    // A shown match's world dropped (a featured rotation, a series jump, a lost snapshot): the loader returns at once.
    // Every reset (entry, stop, rotation) also drops the canvas's game cursor: the next session sets its own, if any.
    world.onReset = () => {
      overlay.cursor.reset();
      if (this.mode === 'match' && this.game && !this.pending) this.reload(this.game);
    };
    this.planeRail = h('nav', { class: 'home-planes', 'aria-label': 'Preview a plane', hidden: true });
    for (const plane of RAIL_PLANES) {
      const button = h('button', { type: 'button', class: 'home-plane', 'aria-label': RAIL_LABEL[plane], 'aria-pressed': 'false', style: `--accent:${PLANE_ACCENT[plane]}` }, icon(plane, 20));
      tip(button, `${RAIL_LABEL[plane]} · click again to resume the tour`);
      button.addEventListener('click', () => this.pinPlane(this.pinned === plane ? undefined : plane));
      this.railButtons.set(plane, button);
      this.planeRail.append(button);
    }
    app.append(this.planeRail);
    if (statsWanted()) {
      this.stats = new StatsReadout();
      document.body.append(this.stats.el);
    }
  }

  /** Pin the backdrop to one plane (or resume the tour with `undefined`, restarting on the Surface showcase). */
  private pinPlane(plane: Plane | undefined): void {
    this.pinned = plane;
    if (!plane) this.attractAt = performance.now();
    for (const [p, button] of this.railButtons) {
      button.classList.toggle('active', p === plane);
      button.setAttribute('aria-pressed', String(p === plane));
    }
  }

  static async create(app: HTMLElement): Promise<MatchRuntime> {
    setLoading('world', 0.35, 'Preparing the four planes.');
    await yieldStartup();
    const gl = h('canvas', { class: 'gl' });
    const ov = h('canvas', { class: 'overlay' });
    const container = h('div', { class: 'battlefield', style: 'position:absolute;inset:0;opacity:0' }, gl, ov);
    app.append(container);
    const world = new World(gl);
    await world.init();
    await yieldStartup();
    const overlay = new Overlay(ov);
    installCursors();
    return new MatchRuntime(app, container, world, overlay);
  }

  /** Start after the DOM home has painted; a later match reuses this renderer, scenery and shader cache.
   *  `map`: the selected map's match options (TerrainChoice.options()); the backdrop shows exactly that map.
   *  `poster`: its poster key (poster.ts), so its first live frame becomes the next visit's instant backdrop. */
  showBackdrop(map: MatchOptions, poster?: string): Promise<void> {
    this.mode = 'home';
    this.wantedMap = map;
    this.wantedPoster = poster;
    this.container.hidden = false;
    this.planeRail.hidden = false;
    this.world.resize();
    if (!this.backdropReady) {
      this.backdropReady = this.prepareBackdrop().finally(() => { this.backdropReady = undefined; });
    }
    return this.backdropReady;
  }

  previewMap(map: MatchOptions, poster?: string): void {
    if (this.mode !== 'home') return;
    void this.showBackdrop(map, poster).catch((error: unknown) => console.error('Backdrop preparation failed', error));
  }

  private async prepareBackdrop(): Promise<void> {
    do {
      const key = previewKey(this.wantedMap);
      const poster = this.wantedPoster;
      // The map's view is built in a worker; the shown map keeps animating meanwhile.
      const base = await previewViews.get(this.wantedMap);
      if (this.mode !== 'home') return;
      if (previewKey(this.wantedMap) !== key) continue;
      const size = base.match.rules.map.size;
      // A different map restarts the preview at tick 0 on its size's bundle: both field planes bake whole in their
      // workers and stream into their meshes in bounded bands. The reset also abandons a previous map's background
      // warm-up; it winds down before this map's.
      this.preview = undefined;
      this.capture = undefined;
      this.world.reset();
      await this.warming;
      if (this.mode !== 'home') return;
      // A size's first bundle must compile before it is drawn (drawing it raw builds every shader synchronously), so the
      // backdrop holds its last frame while its Surface view warms; warm sizes swap while animating.
      const cold = !this.warmSizes.has(size);
      if (cold) {
        cancelAnimationFrame(this.frameId);
        this.frameId = 0;
      }
      // Adopting a view re-aims the camera; the tour keeps its yaw.
      const yaw = this.world.rig.yaw;
      await this.world.setView(base);
      if (this.mode !== 'home') return;
      this.world.rig.yaw = yaw;
      this.world.layers.orbit.setRegions(base.match.orbitRegions);
      await Promise.all([this.world.layers.surface.ready(), this.world.layers.depths.ready()]);
      if (this.mode !== 'home') return;
      // Pipelines are size-independent (MAP_SIZE uniform, shared fog nodes); only a size's first bundle needs warming.
      // A reset (a match, or stop() and back home) supersedes it: re-check what is wanted.
      if (cold && !await this.world.prepareFirstFrame({ planes: FIRST_PLANES, templates: false })) continue;
      if (this.mode !== 'home') return;
      this.preview = base;
      this.previewMs = 0;
      this.previewTick = 0;
      this.shownMap = key;
      this.capture = poster;
      // Restart the tour on the Surface so the newly picked map is what the player sees.
      this.attractAt = performance.now();
      performance.mark('ac:backdrop-map', { detail: key });
    } while (this.mode === 'home' && this.shownMap !== previewKey(this.wantedMap));
    if (this.mode !== 'home') return;
    if (!this.frameId) {
      await yieldStartup();
      if (this.mode !== 'home') return;
      this.attractAt = performance.now();
      this.lastDraw = this.attractAt;
      this.draw();
      // The live scene fades in over the poster (style.css .battlefield transition), which then leaves.
      this.container.style.opacity = '1';
      retirePoster();
      performance.mark('ac:backdrop-first-frame');
      this.frameId = requestAnimationFrame(this.loop);
    }
    this.warmLater(this.world.size);
  }

  /** Warm the remaining planes and match templates behind the animating backdrop; the tour waits for them. */
  private warmLater(size: number): void {
    if (this.warming || this.warmSizes.has(size)) return;
    const warming = this.world.prepareFirstFrame({ planes: LATER_PLANES, live: true }).then((complete) => {
      if (!complete) return;
      this.warmSizes.add(size);
      performance.mark('ac:backdrop-detail');
      // The code-split match HUD chunk is not needed until Play: fetch and evaluate it once the backdrop is complete.
      const fetchGame = (): void => void import('./game.ts').catch(() => {});
      if ('requestIdleCallback' in window) requestIdleCallback(fetchGame, { timeout: 5000 });
      else setTimeout(fetchGame, 1000);
    }, (error: unknown) => console.error('Backdrop warm-up failed', error)).finally(() => {
      if (this.warming === warming) this.warming = undefined;
    });
    this.warming = warming;
  }

  async enter(options: SessionOptions): Promise<void> {
    await this.prepareEntry();
    if (options.observer && !options.grant) throw new Error('Observer admission has no authorized perspective.');
    // Code-split: the match HUD chunk loads on entry, not with the backdrop.
    const { Game, ObserverGame } = await import('./game.ts');
    const game = options.observer && options.grant
      ? new ObserverGame(this.app, this.world, this.overlay, { ...options, grant: options.grant })
      : new Game(this.app, this.world, this.overlay, options);
    await this.startGame(game, game instanceof ObserverGame, options.grant?.delayMs ?? 0);
  }

  async enterObserver(options: ObserverOptions): Promise<void> {
    await this.prepareEntry();
    // Code-split: the match HUD chunk loads on entry, not with the backdrop.
    const { ObserverGame } = await import('./game.ts');
    await this.startGame(new ObserverGame(this.app, this.world, this.overlay, options), true, options.grant.delayMs);
  }

  private async prepareEntry(): Promise<void> {
    this.mode = 'match';
    this.planeRail.hidden = true;
    this.capture = undefined;
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.container.style.opacity = '0';
    // Never run two asynchronous compiler sessions against the same renderer.
    await this.backdropReady;
    await this.warming;
    // The map preview's view must not carry into the match's first view.
    this.preview = undefined;
    this.world.reset();
    this.container.hidden = false;
    this.world.resize();
    setLoading('connecting', 0.65, 'Joining the battlefield.');
    await yieldStartup();
  }

  /** Resolves on the session's first rendered frame; rejects if it cannot join or its first view never arrives. */
  private async startGame(game: Game | ObserverGame, observer: boolean, delayMs: number): Promise<void> {
    this.game = game;
    this.delayMs = delayMs;
    this.pending = game;
    if (!await game.start()) throw new Error('Could not join this match. The link may have expired.');
    if (this.game !== game) return;
    // An observer's released frames play out on drawn frames (game.frame); the loader holds until one is shown.
    if (observer) this.frameId = requestAnimationFrame(this.loop);
    await this.firstFrame(game);
  }

  /**
   * Hold the loader until the session has a view, its shaders are warm and one frame is drawn: the first entry, and
   * again whenever the match's world is dropped mid-session (a featured rotation, a series jump, a lost snapshot).
   * Bounded: a view that never arrives (the broadcast delay plus FIRST_VIEW_TIMEOUT_MS) rejects.
   */
  private async firstFrame(game: Game | ObserverGame): Promise<void> {
    this.pending = game;
    const delayMs = this.delayMs;
    // A public game Watch live just cut over to names itself on the loader card ("Live: public game · …").
    const note = 'loadingNote' in game ? game.loadingNote() : undefined;
    setLoading('connecting', 0.7, note ?? (delayMs >= 10000 ? `Waiting for the broadcast. It runs ${Math.round(delayMs / 1000)} s behind live.` : 'Waiting for the match.'));
    do {
      const late = Promise.withResolvers<false>();
      const timer = window.setTimeout(() => late.resolve(false), delayMs + FIRST_VIEW_TIMEOUT_MS);
      const arrived = await Promise.race([this.world.whenView().then(() => true), late.promise]);
      window.clearTimeout(timer);
      if (this.game !== game) return;
      if (!arrived) throw new Error('The match did not arrive. It may have ended.');
      setLoading('first-frame', 0.75, note ?? 'Warming shaders. Your controls stay responsive.');
      await this.world.prepareFirstFrame({
        progress: (event) => {
          if (event.total) setLoading('first-frame', 0.75 + 0.2 * event.loaded / event.total, note ?? 'Warming shaders.');
        },
      });
      if (this.game !== game) return;
      await yieldStartup();
      if (this.game !== game) return;
      // Dropped again while warming: wait for the next view.
    } while (!this.world.view);
    this.pending = undefined;
    this.draw();
    finishLoading('match');
    this.container.style.opacity = '1';
    if (!this.frameId) this.frameId = requestAnimationFrame(this.loop);
  }

  /** The shown match's world was dropped: the loader returns over it until the next first frame. */
  private reload(game: Game | ObserverGame): void {
    beginLoading();
    void this.firstFrame(game).catch((error: unknown) => {
      if (this.game !== game) return;
      console.error(error);
      this.onFail?.(error instanceof Error ? error.message : 'The battlefield could not be loaded.');
    });
  }

  stop(): void {
    this.mode = 'stopped';
    this.planeRail.hidden = true;
    this.capture = undefined;
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    const game = this.game;
    this.game = undefined;
    this.pending = undefined;
    game?.dispose();
    this.world.reset();
    this.preview = undefined;
    this.shownMap = undefined;
    this.container.hidden = true;
  }

  private draw(): void {
    // The home backdrop renders scenery without a match view. In a match, nothing is drawn until its first frame is
    // ready (the loader shows); a view dropped after that brings the loader back.
    if (this.mode === 'match' && (!this.world.view || this.pending)) {
      this.game?.frame();
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastDraw) / 1000);
    this.lastDraw = now;
    if (this.mode === 'home') {
      attract(this.world, now - this.attractAt, dt, this.pinned, this.warmSizes.has(this.world.size));
      if (this.preview) this.advancePreview(dt);
    }
    this.world.layers.orbit.setRegionsFocused(this.mode === 'home' && (this.pinned ?? this.world.rig.focus) === 'orbit');
    this.world.frame();
    // A shown map's first settled Surface frame becomes its poster; the snapshot must be taken in the drawing task.
    if (this.capture && this.mode === 'home' && this.world.rig.focus === 'surface' && !this.world.rig.diving) {
      capturePoster(this.world.canvas, this.capture);
      this.capture = undefined;
    }
    this.overlay.draw(this.world, now);
    this.stats?.update(this.world);
    if (this.game) this.peek.update(now, this.overlay.peek);
    this.game?.frame();
  }

  /** Move the map preview along its public schedules: a new view every PREVIEW_VIEW_TICKS of preview time. */
  private advancePreview(dt: number): void {
    this.previewMs += dt * 1000;
    const tick = Math.floor((this.previewMs * TICK_RATE) / 1000);
    if (tick < this.previewTick + PREVIEW_VIEW_TICKS) return;
    this.previewTick = tick;
    void this.world.setView(previewViewAt(this.preview!, tick));
  }

  private readonly loop = (): void => {
    this.draw();
    this.frameId = requestAnimationFrame(this.loop);
  };
}
