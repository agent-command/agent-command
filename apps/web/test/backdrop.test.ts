import { describe, expect, it, vi } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame } from '@agent-command/game';
import { CELL, MAP_SIZES, VISION_BITS_PER_WORD, viewSchema, type MatchOptions } from '@agent-command/game/contract';
import { attract } from '../src/backdrop.ts';
import { buildPreview, buildPreviewView } from '../src/preview-map.ts';
import { previewKey } from '../src/preview-client.ts';
import { previewViewAt } from '../src/map-preview.ts';
import type { World } from '../src/world/world.ts';

const MAPS: MatchOptions[] = [
  ...MAP_SIZES.map((size) => ({ terrain: 'ridges' as const, map: { seed: 1234, params: { size } } })),
  { terrain: 'canyons', map: { seed: 99, params: { size: 64 } } },
  { terrain: 'chokepoint', map: { name: 'crossfire' } },
];

/** A generated map's hidden layers differ per match seed; its Surface (lode sites included) never does. */
const generated = (options: MatchOptions): boolean => options.map?.name === undefined;

describe('home preview map', () => {
  it.each(MAPS)('thumbnails the public map a match with $map would play on, and lodes only when authored', (options) => {
    const preview = buildPreview(options);
    const sim = createGame({ seed: 5, options }).sim;
    expect(preview.size).toBe(sim.size);
    if (options.map?.params) expect(preview.size).toBe(options.map.params.size);
    expect(preview.terrain).toEqual(sim.terrain);
    expect(preview.lodes.map((l) => l.y * sim.size + l.x)).toEqual(generated(options) ? [] : sim.lodes.map((l) => l.c));
  });

  it.each(MAPS)('previews $map with the bootstrap, islands and Spires of a match on it, and a Depths illustration', (options) => {
    const preview = buildPreviewView(options);
    const game = createGame({ seed: 5, options });
    const sim = game.sim;
    // A generated map's Depths are secret per match: the backdrop draws hidden seed 0's, never a live match's.
    const illustration = generated(options) ? createGame({ seed: 0, options }).sim : sim;
    const n = sim.size * sim.size;
    expect(validate(viewSchema, preview).ok).toBe(true);
    // Public bootstrap: identical to the match's, as every army receives it (posts named alike by all).
    for (const army of preview.match.armies) expect(preview.match).toEqual(game.matchData({ team: army.id, role: 'surface' }));
    expect(preview.islands).toEqual(game.view('nw').islands);
    // Islands then posts take every army's first names (game sim/aliases.ts), so a preview id names the same body or post
    // for whichever army the client plays.
    const named = (id: number): string => {
      const names = preview.match.armies.map((a) => game.entityId(a.id, id));
      expect(new Set(names).size).toBe(1);
      return names[0]!;
    };
    const islands = sim.ents.filter((e) => e.kind === 'island');
    expect(preview.entities.filter((e) => e.kind === 'island').map((e) => [e.id, e.x, e.y])).toEqual(islands.map((e) => [named(e.id), expect.closeTo(e.x, 9), expect.closeTo(e.y, 9)]));
    const spires = preview.entities.filter((e) => e.kind === 'spire');
    expect(spires.map((e) => [e.side, e.plane, e.x, e.y])).toEqual(sim.ents.filter((e) => e.kind === 'spire').map((e) => [sim.armyIds[e.side], e.plane, preview.match.armies[e.side]!.spireAt.x, preview.match.armies[e.side]!.spireAt.y]));
    const posts = sim.ents.filter((e) => e.kind === 'post');
    expect(preview.entities.filter((e) => e.kind === 'post').map((e) => [e.id, e.x, e.y])).toEqual(posts.map((e) => [named(e.id), e.x, e.y]));
    expect(preview.entities).toHaveLength(islands.length + spires.length + posts.length);
    // Unfogged illustration: every Depths cell with sealed magma shown, every lode, every plane visible.
    expect(preview.depths).toEqual(Array.from(illustration.cells, (c, i) => (illustration.magma[i] ? CELL.magma : c)));
    expect(preview.pockets).toHaveLength(illustration.magma.filter(Boolean).length);
    expect(preview.lodes.map((l) => l.y * sim.size + l.x)).toEqual(illustration.lodes.map((l) => l.c));
    for (const words of Object.values(preview.vision)) {
      for (let c = 0; c < n; c++) expect((words[Math.floor(c / VISION_BITS_PER_WORD)]! >>> (c % VISION_BITS_PER_WORD)) & 1).toBe(1);
    }
  });

  it('moves islands, the sun and fog banks exactly as the match would, without a sim', () => {
    const options = MAPS[0]!;
    const base = buildPreviewView(options);
    const game = createGame({ seed: 5, options });
    for (let i = 0; i < 300; i++) game.step();
    const view = previewViewAt(base, game.tick);
    expect(view.tick).toBe(300);
    expect(base.tick).toBe(0);
    expect(validate(viewSchema, view).ok).toBe(true);
    const islands = game.sim.ents.filter((e) => e.kind === 'island');
    expect(view.entities.slice(0, islands.length).map((e) => [e.x, e.y])).toEqual(islands.map((e) => [expect.closeTo(e.x, 6), expect.closeTo(e.y, 6)]));
    expect(view.sun.angle).toBeCloseTo(game.sim.sunAngle, 6);
    expect(view.weather.fog).toEqual(game.view('nw').weather.fog.map((f) => ({ x: expect.closeTo(f.x, 6), y: expect.closeTo(f.y, 6), radius: f.radius })));
    expect(view.entities.slice(islands.length)).toEqual(base.entities.slice(islands.length));
  });

  it('keys on map identity, seed and size', () => {
    expect(previewKey({ terrain: 'ridges', map: { seed: 1, params: { size: 48 } } })).not.toBe(previewKey({ terrain: 'ridges', map: { seed: 1, params: { size: 80 } } }));
    expect(previewKey({ terrain: 'ridges', map: { seed: 1, params: { size: 48 } } })).not.toBe(previewKey({ terrain: 'ridges', map: { seed: 2, params: { size: 48 } } }));
  });
});

describe('attract camera', () => {
  it('holds the picked map on the Surface, then runs the six-stop orbit, respecting an in-flight dive', () => {
    const rig = { yaw: 0, dist: 30, pitch: 1, tx: 0, tz: 0, focus: 'sky', diving: false, goTo: vi.fn() };
    const world = { rig, size: 48 } as unknown as World;
    const hold = 12000;
    attract(world, 5200, 0.5, undefined, true);
    expect(rig.yaw).toBeCloseTo(0.03);
    expect(rig.dist).toBeCloseTo(46.08);
    expect(rig.pitch).toBe(0.78);
    expect(rig.goTo).toHaveBeenLastCalledWith('surface', expect.any(Number), 'tour');
    rig.focus = 'surface';
    attract(world, hold + 5200, 0, undefined, true);
    expect(rig.goTo).toHaveBeenLastCalledWith('sky', expect.any(Number), 'tour');
    attract(world, hold + 5200 * 5, 0, undefined, true);
    expect(rig.goTo).toHaveBeenLastCalledWith('depths', expect.any(Number), 'tour');
    rig.diving = true;
    rig.goTo.mockClear();
    attract(world, hold + 5200 * 2, 0, undefined, true);
    expect(rig.goTo).not.toHaveBeenCalled();
  });
  it('holds a pinned plane instead of touring', () => {
    const rig = { yaw: 0, dist: 30, pitch: 1, tx: 0, tz: 0, focus: 'surface', diving: false, goTo: vi.fn() };
    const world = { rig, size: 48 } as unknown as World;
    attract(world, 60_000, 0, 'depths', true);
    expect(rig.goTo).toHaveBeenLastCalledWith('depths', expect.any(Number), 'tour');
    rig.focus = 'depths';
    rig.goTo.mockClear();
    attract(world, 90_000, 0, 'depths', true);
    expect(rig.goTo).not.toHaveBeenCalled();
  });
  it('stays on the Surface, tour or pin, until every plane is warm', () => {
    const rig = { yaw: 0, dist: 30, pitch: 1, tx: 0, tz: 0, focus: 'surface', diving: false, goTo: vi.fn() };
    const world = { rig, size: 48 } as unknown as World;
    attract(world, 12000 + 5200, 0, undefined, false);
    attract(world, 60_000, 0, 'orbit', false);
    expect(rig.goTo).not.toHaveBeenCalled();
    attract(world, 60_000, 0, 'orbit', true);
    expect(rig.goTo).toHaveBeenLastCalledWith('orbit', expect.any(Number), 'tour');
  });
  it('frames larger maps from proportionally further out', () => {
    const rig = { yaw: 0, dist: 30, pitch: 1, tx: 0, tz: 0, focus: 'surface', diving: false, goTo: vi.fn() };
    attract({ rig, size: 80 } as unknown as World, 0, 0, undefined, true);
    expect(rig.dist).toBeCloseTo(80 * 0.96);
  });
});
