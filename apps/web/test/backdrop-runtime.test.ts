// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANES, type MatchOptions, type TerrainPreset } from '@agent-command/game/contract';
import type { MatchView } from '../src/match-view.ts';
import { MatchRuntime } from '../src/match-runtime.ts';
import type { ObserverOptions, SessionOptions } from '../src/game.ts';

const state = vi.hoisted(() => ({ begin: vi.fn(), worlds: [] as FakeWorld[], games: [] as unknown[], playerConstruct: vi.fn(), observerConstruct: vi.fn(), playerDispose: vi.fn(), observerDispose: vi.fn(), compile: vi.fn(), finish: vi.fn(), views: [] as MatchView[], frames: [] as FrameRequestCallback[], clock: 0, toured: [] as boolean[], capture: vi.fn(), retire: vi.fn(), cursor: { value: '' } }));
class FakeWorld {
  readonly rig = { yaw: 0, dist: 30, pitch: 1, tx: 0, tz: 0, focus: 'surface', diving: false, goTo: vi.fn() };
  readonly canvas = document.createElement('canvas');
  readonly layers = { orbit: { setRegions: vi.fn(), setRegionsFocused: vi.fn() }, depths: { ready: async () => {} }, surface: { ready: async () => {} } };
  size = 48;
  view: MatchView | undefined;
  readonly setView = vi.fn(async (view: MatchView) => {
    this.view = view;
    this.size = view.match.rules.map.size;
    // Adopting a first view re-aims the camera (World.adoptView → rig.centerOn).
    if (view.tick === 0) this.rig.yaw = 99;
    state.views.push(view);
  });
  readonly init = vi.fn(async () => {});
  readonly resize = vi.fn();
  onReset: (() => void) | undefined;
  readonly reset = vi.fn(() => { this.view = undefined; this.onReset?.(); });
  readonly frame = vi.fn();
  /** The session's first view arrives as soon as it is awaited (tests that hold it override this). */
  readonly whenView = vi.fn(async () => { this.view ??= { tick: 1, match: { mapId: 'match', rules: { map: { size: this.size } } } } as unknown as MatchView; });
  readonly prepareFirstFrame = state.compile;
  constructor() { state.worlds.push(this); }
}
vi.mock('../src/world/world.ts', () => ({ World: class { constructor() { return new FakeWorld(); } } }));
vi.mock('../src/world/startup.ts', () => ({ yieldStartup: async () => {} }));
vi.mock('../src/game.ts', () => ({
  Game: class {
    constructor(app: unknown, world: unknown, overlay: unknown, options: SessionOptions) {
      state.games.push(world);
      state.playerConstruct(app, world, overlay, options);
    }
    async start() { return true; }
    dispose = state.playerDispose;
    frame() {}
  },
  ObserverGame: class {
    private readonly world: FakeWorld;
    constructor(app: unknown, world: FakeWorld, overlay: unknown, options: ObserverOptions) {
      this.world = world;
      state.observerConstruct(app, world, overlay, options);
    }
    async start() { return true; }
    dispose = state.observerDispose;
    // A released observer frame can still contain a director target after its streams close.
    frame() { this.world.rig.focus = 'orbit'; }
  },
}));
vi.mock('../src/overlay.ts', () => ({ Overlay: class { peek = undefined; cursor = { reset: () => { state.cursor.value = ''; } }; draw() {} } }));
vi.mock('../src/peek.ts', () => ({ Peek: class { update() {} } }));
vi.mock('../src/cursors.ts', () => ({ installCursors: vi.fn() }));
vi.mock('../src/loading.ts', () => ({ setLoading: vi.fn(), beginLoading: state.begin, finishLoading: state.finish }));
vi.mock('../src/backdrop.ts', () => ({
  attract: (world: FakeWorld, _t: number, _dt: number, _pinned: unknown, toured: boolean) => {
    world.rig.dist = 46;
    state.toured.push(toured);
  },
}));
vi.mock('../src/poster.ts', () => ({ capturePoster: state.capture, retirePoster: state.retire }));
vi.mock('../src/map-preview.ts', () => ({ PREVIEW_VIEW_TICKS: 5, previewViewAt: (base: MatchView, tick: number) => ({ ...base, tick }) }));
vi.mock('../src/preview-client.ts', () => ({
  previewKey: (options: MatchOptions) => JSON.stringify([options.terrain, options.map]),
  previewViews: { get: async (options: MatchOptions) => ({ tick: 0, match: { mapId: options.terrain, rules: { map: { size: options.map?.params?.size ?? 48 } }, orbitRegions: [{ x: options.map?.params?.size ?? 48 }] } }) },
}));
const pick = (terrain: TerrainPreset, size = 48): MatchOptions => ({ terrain, map: { seed: 7, params: { size } } });
const shown = (): [string, number][] => state.views.map((v) => [v.match.mapId, v.tick]);
/** Run queued animation frames `ms` apart. */
function frames(count: number, ms: number): void {
  for (let i = 0; i < count; i++) {
    state.clock += ms;
    const queued = state.frames.splice(0);
    for (const frame of queued) frame(state.clock);
  }
}

beforeEach(() => {
  state.worlds.length = 0;
  state.games.length = 0;
  state.playerConstruct.mockReset();
  state.observerConstruct.mockReset();
  state.playerDispose.mockReset();
  state.observerDispose.mockReset();
  state.compile.mockReset().mockResolvedValue(true);
  state.toured.length = 0;
  state.capture.mockReset();
  state.retire.mockReset();
  state.finish.mockReset();
  state.begin.mockReset();
  state.cursor.value = '';
  state.views.length = 0;
  state.frames.length = 0;
  state.clock = 1000;
  document.body.replaceChildren();
  performance.clearMarks();
  vi.spyOn(performance, 'now').mockImplementation(() => state.clock);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => state.frames.push(frame));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { state.frames.length = 0; });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('shared idle backdrop runtime', () => {
  it('fades a complete backdrop in and reuses the same World for a match', async () => {
    const runtime = await MatchRuntime.create(document.body);
    const container = document.querySelector<HTMLElement>('.battlefield')!;
    expect(container.style.opacity).toBe('0');
    await runtime.showBackdrop(pick('ridges'));
    expect(container.style.opacity).toBe('1');
    expect(performance.getEntriesByName('ac:backdrop-first-frame')).toHaveLength(1);
    expect(state.finish).not.toHaveBeenCalled();
    await runtime.enter({ roomId: 'test', token: 'test', label: 'test', onExit() {} });
    expect(state.worlds).toHaveLength(1);
    expect(state.games).toEqual([runtime.world]);
    expect(state.finish).toHaveBeenCalledWith('match');
  });

  it('drops the shared canvas cursor on every entry, stop and world drop (rotation, lost snapshot)', async () => {
    const runtime = await MatchRuntime.create(document.body);
    // A player session's edge-scroll up arrow (the green arrow) left on the canvas.
    const arrow = 'sccscroll6';
    state.cursor.value = arrow;
    await runtime.enter({ roomId: 'test', token: 'test', label: 'test', onExit() {} });
    expect(state.cursor.value).toBe('');
    state.cursor.value = arrow;
    runtime.stop();
    expect(state.cursor.value).toBe('');
    state.cursor.value = arrow;
    await runtime.enterObserver({ roomId: 'test', token: 'test', grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 }, onExit() {} });
    expect(state.cursor.value).toBe('');
    state.cursor.value = arrow;
    state.worlds[0]!.reset();
    expect(state.cursor.value).toBe('');
    runtime.stop();
  });

  it('releases the observer camera before resuming the backdrop or entering another match', async () => {
    const runtime = await MatchRuntime.create(document.body);
    await runtime.enterObserver({
      roomId: 'test', token: 'test',
      grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 },
      onExit() {},
    });
    const world = state.worlds[0]!;
    frames(2, 16);
    expect(world.rig.focus).toBe('orbit');
    runtime.stop();
    world.rig.focus = 'surface';
    await runtime.showBackdrop(pick('ridges'));
    frames(120, 16);
    expect(world.rig.focus).toBe('surface');
    runtime.stop();
    await runtime.enter({ roomId: 'next', token: 'test', label: 'next', onExit() {} });
    frames(2, 16);
    expect(world.rig.focus).toBe('surface');
    runtime.stop();
  });

  it('dispatches human → all-bot observer → human entries without retaining the prior session', async () => {
    const runtime = await MatchRuntime.create(document.body);
    const world = state.worlds[0]!;
    const onExit = vi.fn();
    const human: SessionOptions = { roomId: 'human', token: 'player-token', label: 'You', onExit };
    await runtime.enter(human);
    expect(state.playerConstruct).toHaveBeenCalledExactlyOnceWith(document.body, world, expect.anything(), human);
    expect(state.observerConstruct).not.toHaveBeenCalled();

    // play.ts stops the previous match on return to the lobby; enter owns the next dispatch.
    runtime.stop();
    expect(state.playerDispose).toHaveBeenCalledOnce();
    expect(world.reset.mock.invocationCallOrder.at(-1)).toBeGreaterThan(state.playerDispose.mock.invocationCallOrder[0]!);
    const observer: SessionOptions = {
      roomId: 'bots', token: 'observer-token', label: 'Bots', onExit,
      lobbyCode: 'ROOM1234', lobbyAuth: { secret: 'owner-secret' },
      observer: true, grant: { kind: 'team', team: 'nw', delayMs: 180000 },
    };
    await runtime.enter(observer);
    expect(state.playerConstruct).toHaveBeenCalledOnce();
    expect(state.observerConstruct).toHaveBeenCalledExactlyOnceWith(document.body, world, expect.anything(), {
      roomId: 'bots', token: 'observer-token', label: 'Bots', onExit,
      lobbyCode: 'ROOM1234', lobbyAuth: { secret: 'owner-secret' },
      observer: true, grant: { kind: 'team', team: 'nw', delayMs: 180000 },
    });
    expect(state.observerConstruct.mock.invocationCallOrder[0]).toBeGreaterThan(world.reset.mock.invocationCallOrder.at(-1)!);
    expect(state.observerConstruct.mock.calls[0]![3]).not.toHaveProperty('readOnly');
    expect(state.observerConstruct.mock.calls[0]![3]).not.toHaveProperty('perspective');
    frames(2, 16);
    expect(world.rig.focus).toBe('orbit');

    runtime.stop();
    expect(state.observerDispose).toHaveBeenCalledOnce();
    expect(world.reset.mock.invocationCallOrder.at(-1)).toBeGreaterThan(state.observerDispose.mock.invocationCallOrder[0]!);
    world.rig.focus = 'surface';
    const nextHuman: SessionOptions = { roomId: 'you-again', token: 'next-player-token', label: 'You again', onExit };
    await runtime.enter(nextHuman);
    expect(state.playerConstruct).toHaveBeenCalledTimes(2);
    expect(state.playerConstruct).toHaveBeenLastCalledWith(document.body, world, expect.anything(), nextHuman);
    expect(state.playerConstruct.mock.invocationCallOrder[1]).toBeGreaterThan(world.reset.mock.invocationCallOrder.at(-1)!);
    expect(state.observerConstruct).toHaveBeenCalledOnce();
    frames(2, 16);
    expect(world.rig.focus).toBe('surface');
    runtime.stop();
  });

  it('rejects observer admission without a server grant instead of falling back to a player or guessed perspective', async () => {
    const runtime = await MatchRuntime.create(document.body);
    await expect(runtime.enter({
      roomId: 'bots', token: 'observer-token', label: 'Bots', observer: true, onExit() {},
    })).rejects.toThrow('Observer admission has no authorized perspective.');
    expect(state.playerConstruct).not.toHaveBeenCalled();
    expect(state.observerConstruct).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('serializes a match handoff behind pending backdrop compilation', async () => {
    const ready = Promise.withResolvers<boolean>();
    state.compile.mockImplementationOnce(() => ready.promise);
    const runtime = await MatchRuntime.create(document.body);
    const background = runtime.showBackdrop(pick('ridges'));
    const match = runtime.enter({ roomId: 'test', token: 'test', label: 'test', onExit() {} });
    await Promise.resolve();
    expect(state.games).toHaveLength(0);
    ready.resolve(true);
    await background;
    await match;
    expect(state.games).toEqual([runtime.world]);
    expect(performance.getEntriesByName('ac:backdrop-first-frame')).toHaveLength(0);
    // The match took over before the preview map arrived: only the match warms shaders.
    expect(state.compile).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest map selection while an older backdrop is being prepared', async () => {
    const ready = Promise.withResolvers<boolean>();
    state.compile.mockImplementationOnce(() => ready.promise);
    const runtime = await MatchRuntime.create(document.body);
    const background = runtime.showBackdrop(pick('ridges'));
    await vi.waitFor(() => expect(state.compile).toHaveBeenCalled());
    runtime.previewMap(pick('canyons'));
    ready.resolve(true);
    await background;
    expect(shown()).toEqual([['ridges', 0], ['canyons', 0]]);
    runtime.stop();
    expect(document.querySelector<HTMLElement>('.battlefield')!.hidden).toBe(true);
  });

  it('resizes the preview world to the chosen map size and re-previews on every change', async () => {
    const runtime = await MatchRuntime.create(document.body);
    await runtime.showBackdrop(pick('ridges', 48));
    for (const size of [80, 64, 48]) {
      runtime.previewMap(pick('ridges', size));
      await vi.waitFor(() => expect(runtime.world.size).toBe(size));
    }
    expect(state.views.map((v) => v.match.rules.map.size)).toEqual([48, 80, 64, 48]);
    // Each size's first bundle warms its Surface view before drawing (its other planes warm behind it); 48 is warm.
    expect(state.compile.mock.calls.filter(([options]) => !options.live)).toHaveLength(3);
  });

  it('shows approach-region ink only for the focused or pinned Orbit preview, never in a match', async () => {
    const runtime = await MatchRuntime.create(document.body);
    await runtime.showBackdrop(pick('ridges'));
    const world = state.worlds[0]!;
    expect(world.layers.orbit.setRegionsFocused).toHaveBeenLastCalledWith(false);
    world.rig.focus = 'orbit';
    frames(1, 16);
    expect(world.layers.orbit.setRegionsFocused).toHaveBeenLastCalledWith(true);
    world.rig.focus = 'sky';
    frames(1, 16);
    expect(world.layers.orbit.setRegionsFocused).toHaveBeenLastCalledWith(false);
    document.querySelector<HTMLButtonElement>('.home-plane[aria-label="Orbit"]')!.click();
    frames(1, 16);
    expect(world.layers.orbit.setRegionsFocused).toHaveBeenLastCalledWith(true);
    document.querySelector<HTMLButtonElement>('.home-plane[aria-label="Surface"]')!.click();
    frames(1, 16);
    expect(world.layers.orbit.setRegionsFocused).toHaveBeenLastCalledWith(false);
    world.rig.focus = 'orbit';
    await runtime.enter({ roomId: 'test', token: 'test', label: 'test', onExit() {} });
    expect(world.layers.orbit.setRegionsFocused).toHaveBeenLastCalledWith(false);
    expect(state.compile).toHaveBeenCalledTimes(3);
  });

  it('warms only the Surface before the first live frame; the other planes warm behind it and the tour waits', async () => {
    const later = Promise.withResolvers<boolean>();
    state.compile.mockResolvedValueOnce(true).mockImplementationOnce(() => later.promise);
    const runtime = await MatchRuntime.create(document.body);
    await runtime.showBackdrop(pick('ridges'));
    expect(performance.getEntriesByName('ac:backdrop-first-frame')).toHaveLength(1);
    expect(state.compile.mock.calls[0]![0]).toEqual({ planes: ['surface'], templates: false });
    expect(state.compile.mock.calls[1]![0]).toEqual({ planes: PLANES.filter((plane) => plane !== 'surface'), live: true });
    frames(2, 16);
    expect(state.toured).not.toContain(true);
    expect(performance.getEntriesByName('ac:backdrop-detail')).toHaveLength(0);
    // A match entered meanwhile waits for the warm-up instead of compiling beside it.
    const match = runtime.enter({ roomId: 'test', token: 'test', label: 'test', onExit() {} });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(state.games).toHaveLength(0);
    later.resolve(true);
    await match;
    expect(performance.getEntriesByName('ac:backdrop-detail')).toHaveLength(1);
    expect(state.games).toEqual([runtime.world]);
    expect(state.compile).toHaveBeenCalledTimes(3);
  });

  it('tours once every plane is warm', async () => {
    const runtime = await MatchRuntime.create(document.body);
    await runtime.showBackdrop(pick('ridges'));
    await vi.waitFor(() => expect(performance.getEntriesByName('ac:backdrop-detail')).toHaveLength(1));
    frames(1, 16);
    expect(state.toured.at(-1)).toBe(true);
  });

  it('keeps each shown map\'s first settled Surface frame as its poster and retires the poster under the live scene', async () => {
    const runtime = await MatchRuntime.create(document.body);
    await runtime.showBackdrop(pick('ridges'), 'ridges.7.48');
    const world = state.worlds[0]!;
    expect(state.capture).toHaveBeenCalledExactlyOnceWith(world.canvas, 'ridges.7.48');
    expect(state.retire).toHaveBeenCalled();
    frames(3, 16);
    expect(state.capture).toHaveBeenCalledTimes(1);
    // A newly picked map is kept from its first Surface frame that is not mid-dive.
    world.rig.diving = true;
    runtime.previewMap(pick('canyons'), 'canyons.7.48');
    await vi.waitFor(() => expect(performance.getEntriesByName('ac:backdrop-map')).toHaveLength(2));
    frames(1, 16);
    expect(state.capture).toHaveBeenCalledTimes(1);
    world.rig.diving = false;
    frames(1, 16);
    expect(state.capture).toHaveBeenLastCalledWith(world.canvas, 'canyons.7.48');
    // Never a match frame.
    await runtime.enter({ roomId: 'test', token: 'test', label: 'test', onExit() {} });
    frames(3, 16);
    expect(state.capture).toHaveBeenCalledTimes(2);
  });

  it('advances the map preview on drawn frames only and restarts it at tick 0 on a new map', async () => {
    const runtime = await MatchRuntime.create(document.body);
    await runtime.showBackdrop(pick('ridges', 48));
    const world = state.worlds[0]!;
    // 100 ms frames: a view every 5 ticks (250 ms) of preview time.
    frames(6, 100);
    expect(shown()).toEqual([['ridges', 0], ['ridges', 6], ['ridges', 12]]);
    // A hidden tab draws nothing; its first frame back advances at most one capped frame step.
    frames(1, 60_000);
    expect(shown()).toHaveLength(3);
    frames(2, 100);
    expect(shown().at(-1)).toEqual(['ridges', 18]);
    const yaw = world.rig.yaw;
    runtime.previewMap(pick('canyons', 80));
    // A new size compiles cold, then the loop restarts.
    await vi.waitFor(() => {
      expect(performance.getEntriesByName('ac:backdrop-map')).toHaveLength(2);
      expect(state.frames).toHaveLength(1);
    });
    expect(world.size).toBe(80);
    expect(world.reset).toHaveBeenCalled();
    expect(world.rig.yaw).toBe(yaw);
    expect(shown().at(-1)).toEqual(['canyons', 0]);
    expect(world.layers.orbit.setRegions).toHaveBeenLastCalledWith([{ x: 80 }]);
    frames(3, 100);
    expect(shown().at(-1)).toEqual(['canyons', 6]);
    // A real match takes the World: the preview stops and its view is dropped first.
    world.reset.mockClear();
    const sent = state.views.length;
    await runtime.enter({ roomId: 'test', token: 'test', label: 'test', onExit() {} });
    expect(world.reset).toHaveBeenCalled();
    frames(10, 100);
    expect(state.views).toHaveLength(sent);
  });
});

describe('the match loader holds until the first rendered frame', () => {
  const observer = (delayMs: number): ObserverOptions => ({ roomId: 'live', token: 'test', grant: { kind: 'omniscient', teams: ['nw', 'se'], delayMs }, onExit() {} });
  /** Hold the world's first view until `arrive` is called. */
  function holdView(world: FakeWorld): () => void {
    const gate = Promise.withResolvers<void>();
    world.whenView.mockImplementation(() => world.view ? Promise.resolve() : gate.promise);
    return () => { world.view = { tick: 1, match: { mapId: 'match', rules: { map: { size: 48 } } } } as unknown as MatchView; gate.resolve(); };
  }
  /** Let the entry's awaits (the code-split HUD import, game start) run until its frame loop is requested. */
  const settle = (): Promise<void> => vi.waitFor(() => { if (!state.frames.length) throw new Error('no frame loop yet'); });

  it('keeps the loader over an observer of a running match until its first view is drawn', async () => {
    const runtime = await MatchRuntime.create(document.body);
    const arrive = holdView(state.worlds[0]!);
    const entry = runtime.enterObserver(observer(3000));
    await settle();
    frames(3, 16);
    // The observer's feed keeps playing out (game.frame) under the loader; nothing is shown yet.
    expect(state.worlds[0]!.rig.focus).toBe('orbit');
    expect(state.worlds[0]!.frame).not.toHaveBeenCalled();
    expect(state.finish).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('.battlefield')!.style.opacity).toBe('0');
    arrive();
    await entry;
    expect(state.finish).toHaveBeenCalledExactlyOnceWith('match');
    expect(state.worlds[0]!.frame).toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('.battlefield')!.style.opacity).toBe('1');
    runtime.stop();
  });

  it('brings the loader back when the shown world is dropped (rotation, lost snapshot) and clears it on the next frame', async () => {
    const runtime = await MatchRuntime.create(document.body);
    const world = state.worlds[0]!;
    await runtime.enterObserver(observer(3000));
    expect(state.finish).toHaveBeenCalledOnce();
    const arrive = holdView(world);
    world.reset();
    // The reset itself brings the loader back; frames before the next view keep it up.
    expect(state.begin).toHaveBeenCalledOnce();
    frames(5, 16);
    expect(state.begin).toHaveBeenCalledOnce();
    expect(state.finish).toHaveBeenCalledOnce();
    arrive();
    await vi.waitFor(() => expect(state.finish).toHaveBeenCalledTimes(2));
    runtime.stop();
  });

  it('fails a first view that never arrives (the broadcast delay plus 30 s) instead of loading forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const runtime = await MatchRuntime.create(document.body);
      holdView(state.worlds[0]!);
      const entry = runtime.enterObserver(observer(3000));
      const failed = expect(entry).rejects.toThrow('The match did not arrive. It may have ended.');
      await vi.advanceTimersByTimeAsync(32_999);
      expect(state.finish).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      runtime.stop();
    } finally { vi.useRealTimers(); }
  });

  it('reports a dropped world whose next view never comes through onFail', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const runtime = await MatchRuntime.create(document.body);
      const onFail = vi.fn();
      runtime.onFail = onFail;
      await runtime.enter({ roomId: 'test', token: 'test', label: 'test', onExit() {} });
      holdView(state.worlds[0]!);
      state.worlds[0]!.reset();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onFail).toHaveBeenCalledExactlyOnceWith('The match did not arrive. It may have ended.');
      runtime.stop();
    } finally { vi.useRealTimers(); }
  });
});
