import { describe, expect, it, vi } from 'vitest';
import { createGame } from '@agent-command/game';
import { PLANES, type ArmyId, type View } from '@agent-command/game/contract';
import { matchView, type MatchView } from '../src/match-view.ts';
import { FogField } from '../src/world/fog.ts';
import { SUN, SUN_DIR } from '../src/world/materials.ts';
import { World } from '../src/world/world.ts';

const game = createGame({ seed: 19, options: { economy: { oreLoad: 25 } } });

function snapshot(team: ArmyId = 'nw'): MatchView {
  return matchView(game.view(team, { snapshot: true }))!;
}

function delta(team: ArmyId = 'nw', tick = 1): View {
  const { match: _match, ...view } = game.view(team, { snapshot: true });
  return { ...view, tick };
}

describe('match snapshot resolution', () => {
  it('requires bootstrap and retains the exact match data on later dynamic views', () => {
    const first = snapshot();
    const next = delta();
    expect(next.match).toBeUndefined();
    expect(matchView(next)).toBeUndefined();
    expect(matchView(next, first)?.match).toBe(first.match);
    expect(next.rulesHash).toBe(first.match.rulesHash);
    expect(next).not.toHaveProperty('rules');
    expect(next).not.toHaveProperty('terrain');
    expect(next).not.toHaveProperty('spireAt');
    expect(next.sun).not.toHaveProperty('speed');
    expect(next.weather).not.toHaveProperty('jets');
    expect(next.weather.fog.every((cell) => !('path' in cell))).toBe(true);
  });

  it('keeps team bootstrap data separate even when rules hashes match', () => {
    const views = new Map<ArmyId, MatchView>();
    for (const team of ['nw', 'se'] as const) views.set(team, snapshot(team));
    expect(matchView(delta('se'), views.get('nw'))).toBeUndefined();
    const blue = matchView(delta('nw'), views.get('nw'))!;
    const red = matchView(delta('se'), views.get('se'))!;
    expect(blue.match).toBe(views.get('nw')!.match);
    expect(red.match).toBe(views.get('se')!.match);
    expect(blue.entities).not.toBe(red.entities);
  });

  it('rejects changed identities and mismatched snapshots instead of using default rules', () => {
    const first = snapshot();
    const next = delta();
    next.rulesHash = (next.rulesHash + 1) >>> 0;
    expect(matchView(next, first)).toBeUndefined();
    expect(matchView({ ...first, rulesHash: next.rulesHash }, first)).toBeUndefined();
    expect(next.match).toBeUndefined();
  });

  it('requires a new snapshot on rewind and never borrows a previous match session', () => {
    const old = matchView({ ...snapshot(), tick: 50 })!;
    expect(matchView(delta('nw', 2), old)).toBeUndefined();
    expect(matchView(delta('nw', 50), old)?.match).toBe(old.match);
    expect(matchView(delta('nw', 51))).toBeUndefined();
    const rejoined = snapshot();
    expect(matchView(rejoined, old)?.match).toBe(rejoined.match);
    expect(rejoined.match.rules.economy.oreLoad).toBe(25);
  });

  it('replaces a cached snapshot even when the new terrain has the same rules identity', () => {
    const old = snapshot();
    const replacement = createGame({ seed: 29, options: { economy: { oreLoad: 25 } } }).view('nw');
    expect(replacement.rulesHash).toBe(old.rulesHash);
    expect(matchView(replacement, old)?.match).toBe(replacement.match);
    expect(replacement.match).not.toBe(old.match);
  });
});

describe('world match boundaries', () => {
  it('clears explored fog on a team switch and refuses deltas after reset until bootstrap', async () => {
    const fog = new FogField(48);
    const world: World = Object.assign(Object.create(World.prototype) as World, {
      view: undefined,
      renderSize: 48,
      fog,
      generation: 0,
      viewReady: { resolve: vi.fn(), reject: vi.fn() },
      entities: { ingest: vi.fn(), prepareView: vi.fn(async () => {}), tickTime: (tick: number) => tick * 50, fire: vi.fn() },
      layers: { update: vi.fn() },
      lens: { ingest: vi.fn(), entities: { prepareView: vi.fn(async () => {}) } },
      designations: { ingest: vi.fn() },
      underground: { update: vi.fn() },
      telegraphs: { setFaults: vi.fn(), ingest: vi.fn() },
      fx: { ingest: vi.fn() },
      combat: { ingest: vi.fn(), focus: 'surface' },
      orbitAbilities: { ingest: vi.fn() },
      groundAmbience: { ingest: vi.fn(), reset: vi.fn() },
      airAmbience: { ingest: vi.fn(), reset: vi.fn() },
      rig: { focus: 'surface', centerOn: vi.fn() },
      reset: vi.fn(() => { world.view = undefined; fog.resetFog(); }),
    });
    const blue = snapshot();
    blue.vision = Object.fromEntries(PLANES.map((plane) => [plane, Array<number>(Math.ceil(blue.match.rules.map.size ** 2 / 30)).fill(0)])) as View['vision'];
    blue.vision.surface[0] = 1;
    // The first view of a match is prepared asynchronously (startup chunking) before it is adopted.
    world.setView(blue);
    await vi.waitFor(() => expect(world.view?.army).toBe('nw'));
    expect(fog.explored.surface[0]).toBe(1);
    const red = snapshot('se');
    red.vision = Object.fromEntries(PLANES.map((plane) => [plane, Array<number>(Math.ceil(red.match.rules.map.size ** 2 / 30)).fill(0)])) as View['vision'];
    world.setView(red);
    expect(world.reset).toHaveBeenCalledOnce();
    expect(fog.explored.surface[0]).toBe(0);
    world.reset();
    world.setView(delta('se'));
    expect(world.view).toBeUndefined();
    world.setView(snapshot('se'));
    await vi.waitFor(() => expect(world.view?.army).toBe('se'));
  });
});

describe('successive world map sizes', () => {
  it('prepares the retained snapshot size before adopting each new match', async () => {
    const world = new World({} as HTMLCanvasElement);
    const entities = { ingest: vi.fn(), prepareView: vi.fn(async () => {}), tickTime: (tick: number) => tick * 50, fire: vi.fn(), reset: vi.fn() };
    Object.assign(world, {
      entities,
      fog: new FogField(48),
      layers: { update: vi.fn(), reset: vi.fn() },
      lens: { ingest: vi.fn(), reset: vi.fn(), entities: { prepareView: vi.fn(async () => {}), reset: vi.fn() }, show: vi.fn() },
      designations: { ingest: vi.fn(), reset: vi.fn() },
      underground: { update: vi.fn(), reset: vi.fn() },
      telegraphs: { setFaults: vi.fn(), ingest: vi.fn(), reset: vi.fn() },
      fx: { ingest: vi.fn(), reset: vi.fn() },
      combat: { ingest: vi.fn(), reset: vi.fn(), focus: 'surface' },
      orbitAbilities: { ingest: vi.fn(), reset: vi.fn() },
      groundAmbience: { ingest: vi.fn(), reset: vi.fn() },
      airAmbience: { ingest: vi.fn(), reset: vi.fn() },
    });
    const prepared: number[] = [];
    Object.assign(world, {
      prepareSize: vi.fn(async (size: number) => {
        prepared.push(size);
        await Promise.resolve();
        Object.assign(world, { renderSize: size, fog: new FogField(size) });
        world.rig.setSize(size);
      }),
    });
    for (const size of [48, 80, 64, 48] as const) {
      const view = createGame({ seed: 19, options: { map: { params: { size } } } }).view('nw', { snapshot: true });
      world.setView(view);
      await world.whenView();
      expect(world.view?.match).toBe(view.match);
      expect(world.size).toBe(size);
      expect(world.rig.size).toBe(size);
      expect(world.fog.visible.surface).toHaveLength(size * size);
      expect(entities.ingest).toHaveBeenLastCalledWith(view, expect.any(Number));
    }
    expect(prepared).toEqual([80, 64, 48]);
  });
});

/** A World with its scene subsystems stubbed: views, tracks, fog and the camera are real. */
function stubbedWorld(): World {
  const world = new World({} as HTMLCanvasElement);
  const reset = { reset: vi.fn() };
  Object.assign(world, {
    entities: { ingest: vi.fn(), prepareView: vi.fn(async () => {}), tickTime: (tick: number) => tick * 50, fire: vi.fn(), reset: vi.fn() },
    fog: new FogField(48),
    layers: { update: vi.fn(), ...reset },
    lens: { ingest: vi.fn(), entities: { prepareView: vi.fn(async () => {}), ...reset }, show: vi.fn(), ...reset },
    designations: { ingest: vi.fn(), ...reset },
    underground: { update: vi.fn(), ...reset },
    telegraphs: { setFaults: vi.fn(), ingest: vi.fn(), ...reset },
    fx: { ingest: vi.fn(), ...reset },
    combat: { ingest: vi.fn(), focus: 'surface', ...reset },
    orbitAbilities: { ingest: vi.fn(), ...reset },
    groundAmbience: { ingest: vi.fn(), ...reset },
    airAmbience: { ingest: vi.fn(), ...reset },
    prepareSize: vi.fn(async (size: number) => {
      Object.assign(world, { renderSize: size, fog: new FogField(size) });
      world.rig.setSize(size);
    }),
  });
  return world;
}

describe('world key light', () => {
  async function show(world: World, team: ArmyId): Promise<{ x: number; y: number; z: number }> {
    world.setView(snapshot(team));
    await world.whenView();
    expect(world.view?.army).toBe(team);
    expect(SUN.value.toArray()).toEqual(SUN_DIR.toArray());
    return { x: SUN_DIR.x, y: SUN_DIR.y, z: SUN_DIR.z };
  }

  it('turns with a player army but stays fixed in world space across observer perspective switches', async () => {
    const player = stubbedWorld();
    const nw = await show(player, 'nw');
    const se = await show(player, 'se');
    expect(se).not.toEqual(nw);

    const observer = stubbedWorld();
    observer.observing = 'se';
    const opened = await show(observer, 'se');
    expect(opened).toEqual(se);
    for (const [vision, team] of [['nw', 'nw'], ['all', 'nw'], ['se', 'se'], ['all', 'se'], ['nw', 'nw']] as const) {
      observer.observing = vision;
      expect(await show(observer, team)).toEqual(opened);
    }

    // Leaving the observer session hands the light back to the player's frame.
    observer.observing = undefined;
    observer.reset();
    expect(await show(observer, 'nw')).toEqual(nw);
  });
});

describe('world perspective switches', () => {
  it('clears another perspective of the shown match in place, never reporting a dropped match (the loader stays down)', async () => {
    const world = stubbedWorld();
    const dropped = vi.fn();
    world.onReset = dropped;
    world.setView(snapshot('nw'));
    await world.whenView();
    world.setView(snapshot('se'), true);
    expect(world.view?.army).toBe('se');
    // The old perspective's tracks name other things: cleared all the same.
    expect(world.entities.reset).toHaveBeenCalledOnce();
    expect(dropped).not.toHaveBeenCalled();
    await world.whenView();
    // Leaving, another match, a lost snapshot: the match is dropped.
    world.reset();
    expect(dropped).toHaveBeenCalledOnce();
    world.setView(snapshot('nw'));
    await world.whenView();
    // Unflagged, another army's view is another match's.
    world.setView(snapshot('se'));
    expect(dropped).toHaveBeenCalledTimes(2);
  });
});
