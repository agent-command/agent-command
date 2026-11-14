/** Encodes a captured backdrop frame (poster.ts capturePoster) and keeps the latest few in Cache Storage. */
import { POSTER_CACHE, POSTER_KEEP, posterUrl, type PosterJob } from './poster.ts';

/** The dedicated-worker global (the app compiles against the DOM lib, where `self` is a Window). */
const scope = self as unknown as { onmessage: ((e: MessageEvent<PosterJob>) => void) | null };

scope.onmessage = (e) => {
  void store(e.data).catch((error: unknown) => console.warn('Backdrop poster not stored', error));
};

async function store({ key, bitmap }: PosterJob): Promise<void> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
  // Without a WebP encoder the result is PNG: JPEG keeps the still small there.
  if (blob.type !== 'image/webp') blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const cache = await caches.open(POSTER_CACHE);
  const url = posterUrl(key);
  // Re-adding moves the still to the end of the cache's insertion order, which the trim below keeps.
  await cache.delete(url);
  await cache.put(url, new Response(blob, { headers: { 'content-type': blob.type } }));
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - POSTER_KEEP)).map((request) => cache.delete(request)));
}
