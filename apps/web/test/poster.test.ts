// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** poster.ts keeps one still per page: each test loads a fresh module. */
async function freshPoster() {
  vi.resetModules();
  return import('../src/poster.ts');
}

const stored = new Map<string, Blob>();
beforeEach(() => {
  stored.clear();
  localStorage.clear();
  history.replaceState(null, '', '/');
  document.body.replaceChildren();
  performance.clearMarks();
  vi.stubGlobal('caches', { match: vi.fn(async (url: string) => stored.has(url) ? new Response(stored.get(url)) : undefined) });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:poster');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  HTMLImageElement.prototype.decode = async () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('backdrop poster', () => {
  it('keys stills by map, seed and size, from a selection or a map link', async () => {
    const { choicePosterKey, posterKey } = await freshPoster();
    expect(posterKey('?map=ridges&mapSeed=7&size=48')).toBe('ridges.7.48');
    expect(posterKey('map=ridges&size=48&mapSeed=7')).toBe(choicePosterKey({ mapId: 'ridges', mapSeed: 7, size: 48 }));
    expect(posterKey('?map=ridges&mapSeed=7')).toBeUndefined();
  });

  it('shows the saved map\'s still behind the menu, then drops it once the live scene covers it', async () => {
    localStorage.setItem('agent-command.map-choice', 'map=rivers&mapSeed=9&size=64');
    const poster = await freshPoster();
    stored.set(poster.posterUrl('rivers.9.64'), new Blob(['webp'], { type: 'image/webp' }));
    const app = document.createElement('div');
    app.append(document.createElement('main'));
    poster.preparePoster();
    poster.showPoster(app);
    await vi.waitFor(() => expect(app.firstElementChild?.className).toBe('backdrop-poster'));
    expect((app.firstElementChild as HTMLImageElement).src).toBe('blob:poster');
    expect(performance.getEntriesByName('ac:backdrop-poster')).toHaveLength(1);
    vi.useFakeTimers();
    poster.retirePoster();
    expect(app.querySelector('.backdrop-poster')).not.toBeNull();
    vi.advanceTimersByTime(450);
    expect(app.querySelector('.backdrop-poster')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:poster');
  });

  it('never shows a still that arrives after the live scene or a match', async () => {
    localStorage.setItem('agent-command.map-choice', 'map=rivers&mapSeed=9&size=64');
    const poster = await freshPoster();
    stored.set(poster.posterUrl('rivers.9.64'), new Blob(['webp'], { type: 'image/webp' }));
    const app = document.createElement('div');
    poster.preparePoster();
    poster.retirePoster();
    poster.showPoster(app);
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
    expect(app.children).toHaveLength(0);
  });

  it('shows nothing for a map without a still', async () => {
    history.replaceState(null, '', '/?map=ridges&mapSeed=1&size=48');
    const poster = await freshPoster();
    const app = document.createElement('div');
    poster.preparePoster();
    poster.showPoster(app);
    await vi.waitFor(() => expect(caches.match).toHaveBeenCalledWith(poster.posterUrl('ridges.1.48'), { cacheName: poster.POSTER_CACHE }));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(app.children).toHaveLength(0);
  });
});
