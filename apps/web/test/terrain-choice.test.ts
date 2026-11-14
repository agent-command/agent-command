// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAPS } from '@agent-command/game/lobby';
import { mapChoiceUrl, parseMapChoice, TerrainChoice } from '../src/terrain-choice.ts';

const firstVisit = vi.hoisted(() => ({ query: undefined as string | undefined }));
vi.mock('../src/poster.ts', () => ({ MAP_CHOICE_KEY: 'agent-command.map-choice', firstVisitChoice: () => firstVisit.query }));

const catalogue = (maps: readonly unknown[]) => vi.fn(async () => new Response(JSON.stringify({ maps }), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); vi.stubGlobal('fetch', catalogue(MAPS)); });
afterEach(() => { vi.unstubAllGlobals(); firstVisit.query = undefined; });

describe('public map selection', () => {
  it('opens a first visit on a map with a baked backdrop still, and a returning visit on its saved map', async () => {
    firstVisit.query = 'map=ridges&mapSeed=123&size=48';
    const first = new TerrainChoice(); await first.ready;
    expect(first.getMap()).toEqual({ mapId: 'ridges', mapSeed: 123, size: 48 });
    firstVisit.query = 'map=ridges&mapSeed=456&size=48';
    const returning = new TerrainChoice(); await returning.ready;
    expect(returning.getMap()).toEqual({ mapId: 'ridges', mapSeed: 123, size: 48 });
  });

  it('restores a public map link with its exact seed and size as generated match options', async () => {
    history.replaceState(null, '', '/?map=rivers&mapSeed=4294967295&size=80');
    const choice = new TerrainChoice(); await choice.ready;
    expect(choice.getMap()).toEqual({ mapId: 'rivers', mapSeed: 4294967295, size: 80 });
    expect(choice.options()).toEqual({ terrain: 'rivers', map: { seed: 4294967295, params: { size: 80 } } });
  });

  it('shares only public selection fields and rejects malformed or unsupported map links', () => {
    history.replaceState(null, '', '/?profileSecret=secret#r=room&t=credential');
    const link = new URL(mapChoiceUrl({ mapId: 'rivers', mapSeed: 27, size: 64 }));
    expect([...link.searchParams.keys()]).toEqual(['map', 'mapSeed', 'size']);
    expect(link.hash).toBe('');
    expect(link.href).not.toMatch(/secret|credential|room/);
    expect(parseMapChoice(link.search)).toEqual({ mapId: 'rivers', mapSeed: 27, size: 64 });
    for (const query of [
      '?map=four_corners&mapSeed=0&size=48', '?map=four_corners&mapSeed=1&size=64', '?map=bad-id&mapSeed=0&size=48',
      '?map=ridges&mapSeed=-1&size=48', '?map=ridges&mapSeed=1.5&size=48',
      '?map=ridges&mapSeed=4294967296&size=48', '?map=ridges&mapSeed=0&size=60',
      '?map=crown&mapSeed=1&size=48', '?map=crown&mapSeed=0&size=64',
    ]) expect(parseMapChoice(query)).toBeUndefined();
  });

  it('selects authored classics by identity with their fixed seed and size, ignoring seed edits', async () => {
    const choice = new TerrainChoice(); await choice.ready;
    choice.set('twin_fords');
    choice.setSeed(99); choice.setSize(80);
    expect(choice.getMap()).toEqual({ mapId: 'twin_fords', mapSeed: 0, size: 48 });
    expect(choice.options()).toEqual({ terrain: 'rivers', map: { name: 'twin_fords' } });
    // Four-slot authored maps are playable (FFA and the C4 duel) at their own seed and size.
    choice.set('four_corners');
    expect(choice.getMap()).toEqual({ mapId: 'four_corners', mapSeed: 0, size: 64 });
    expect(parseMapChoice('?map=four_corners&mapSeed=0&size=64')).toEqual({ mapId: 'four_corners', mapSeed: 0, size: 64 });
  });

  it('notifies only on real changes, so mirroring lobby snapshots stays quiet', async () => {
    history.replaceState(null, '', '/?map=open&mapSeed=5&size=48');
    const choice = new TerrainChoice(); await choice.ready;
    const listener = vi.fn(); choice.onChange(listener);
    choice.set('open'); choice.setSeed(5); choice.setSize(48);
    expect(listener).not.toHaveBeenCalled();
    choice.setSize(64);
    expect(listener).toHaveBeenCalledExactlyOnceWith('open');
  });

  it('hydrates saved map links from public catalogue descriptors', async () => {
    const descriptor = {
      ...MAPS.find((map) => map.id === 'crossfire')!, id: 'browser_saved_map', label: 'Browser Saved Map',
      terrain: 'highlands' as const, mapSeed: 77, size: 64, sizes: [64], tags: ['authored', 'saved'],
    };
    vi.stubGlobal('fetch', catalogue([...MAPS, descriptor]));
    history.replaceState(null, '', '/?map=browser_saved_map&mapSeed=77&size=64');
    const choice = new TerrainChoice(); await choice.ready;
    expect(choice.get()).toBe('highlands');
    expect(choice.options()).toEqual({ terrain: 'highlands', map: { name: 'browser_saved_map' } });
  });
});
