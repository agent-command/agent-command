/**
 * The instant home backdrop: a still of the selected map's first live backdrop frame, shown with the menu and covered
 * by the live 3D scene as it fades in (match-runtime.ts). Stills come from this browser's previous visit (captured from
 * the live canvas, encoded by poster.worker.ts into Cache Storage) or, on a first visit, from the baked still in
 * assets/posters/, whose map a first visit opens on (terrain-choice.ts), so the still matches the scene it bridges.
 * index.html's boot shell paints that same baked still before any JavaScript.
 * This module is in the entry chunk: nothing here may import the menu or the renderer.
 */

/** localStorage key of the public map selection; terrain-choice.ts owns its format, a map-link query string. */
export const MAP_CHOICE_KEY = 'agent-command.map-choice';
export const POSTER_CACHE = 'agent-command-posters';
/** Stills kept (the most recently shown maps); each is ~40–90 KB. */
export const POSTER_KEEP = 6;
/** Captured still width (px): it only bridges the seconds before the live scene. */
const POSTER_WIDTH = 1280;
/** style.css `.battlefield` opacity transition: the still leaves once the live scene covers it. */
const COVER_MS = 450;

export interface PosterJob { key: string; bitmap: ImageBitmap }

/** Baked first-visit still(s), named `<mapId>.<mapSeed>.<size>.webp`; without the directory a first visit has none. */
const BAKED: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../assets/posters/*.webp', { query: '?no-inline', import: 'default', eager: true }))
    .map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -'.webp'.length), url]),
);

/** Still key of a map selection. */
export const choicePosterKey = (choice: { mapId: string; mapSeed: number; size: number }): string => `${choice.mapId}.${choice.mapSeed}.${choice.size}`;

/** Still key of a map-link query (`map`, `mapSeed`, `size`); undefined when one is missing. */
export function posterKey(query: string): string | undefined {
  const q = new URLSearchParams(query);
  const map = q.get('map');
  const seed = q.get('mapSeed');
  const size = q.get('size');
  return map && seed && size ? `${map}.${seed}.${size}` : undefined;
}

/** Synthetic same-origin Cache Storage URL of a still (never requested from the network). */
export const posterUrl = (key: string): string => `/posters/${encodeURIComponent(key)}`;

let firstVisit: string | null | undefined;
/** The map-link query a first visit opens on: one baked still's map, picked once per page. */
export function firstVisitChoice(): string | undefined {
  if (firstVisit === undefined) {
    const keys = Object.keys(BAKED);
    const [map, mapSeed, size] = keys[Math.floor(Math.random() * keys.length)]?.split('.') ?? [];
    firstVisit = map && mapSeed && size ? new URLSearchParams({ map, mapSeed, size }).toString() : null;
  }
  return firstVisit ?? undefined;
}

let loading: Promise<HTMLImageElement | undefined> | undefined;
let shown: HTMLImageElement | undefined;
let objectUrl: string | undefined;
let retired = false;

/** Start fetching and decoding the still of the map the home will open on, in parallel with the menu's chunks. */
export function preparePoster(): void {
  loading ??= load().catch((error: unknown) => {
    console.warn('Backdrop poster unavailable', error);
    return undefined;
  });
}

async function load(): Promise<HTMLImageElement | undefined> {
  let stored: string | null = null;
  try { stored = localStorage.getItem(MAP_CHOICE_KEY); } catch { /* storage unavailable */ }
  // The same precedence as TerrainChoice: a map link, then the saved selection, then a first visit's baked map.
  const query = new URLSearchParams(location.search).has('map') ? location.search : stored || firstVisitChoice();
  const key = query ? posterKey(query) : undefined;
  if (!key) return undefined;
  let src = BAKED[key];
  if ('caches' in globalThis) {
    let hit: Response | undefined;
    try { hit = await caches.match(posterUrl(key), { cacheName: POSTER_CACHE }); } catch { /* storage blocked: baked still only */ }
    if (hit) src = objectUrl = URL.createObjectURL(await hit.blob());
  }
  if (!src) return undefined;
  const img = new Image();
  img.className = 'backdrop-poster';
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.setAttribute('aria-hidden', 'true');
  img.src = src;
  await img.decode();
  return img;
}

function release(): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
}

/** Put the still behind the menu as soon as it is decoded, unless the live scene (or a match) got there first. */
export function showPoster(app: HTMLElement): void {
  void loading?.then((img) => {
    if (!img || retired) {
      release();
      return;
    }
    shown = img;
    app.prepend(img);
    performance.mark('ac:backdrop-poster');
  });
}

/** The live scene is fading in over the still, or a match is starting: drop the still once it is covered. */
export function retirePoster(): void {
  if (retired) return;
  retired = true;
  const img = shown;
  if (!img) return;
  setTimeout(() => {
    img.remove();
    release();
  }, COVER_MS);
}

let encoder: Worker | undefined;
/** Keep `canvas`'s just-drawn frame as the still for `key`. Call in the task that drew it (the drawing buffer is not
 *  preserved); the snapshot is a GPU copy, and scaling, encoding and storage happen off the main thread. */
export function capturePoster(canvas: HTMLCanvasElement, key: string): void {
  if (!('caches' in globalThis) || typeof OffscreenCanvas === 'undefined' || !canvas.width || !canvas.height) return;
  const width = Math.min(POSTER_WIDTH, canvas.width);
  const height = Math.round((canvas.height * width) / canvas.width);
  createImageBitmap(canvas, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' }).then((bitmap) => {
    encoder ??= new Worker(new URL('./poster.worker.ts', import.meta.url), { type: 'module' });
    encoder.postMessage({ key, bitmap } satisfies PosterJob, [bitmap]);
  }).catch((error: unknown) => console.warn('Backdrop poster capture failed', error));
}
