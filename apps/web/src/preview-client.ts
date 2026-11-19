/**
 * Home-module side of the map preview: asks preview.worker.ts for maps and caches them per selection. Imports no
 * generator code, so map cards and the backdrop never pull map generation into the home bundle or main thread.
 */
import type { MatchOptions } from '@agent-command/game/contract';
import type { MatchView } from './match-view.ts';
import type { PreviewMap } from './preview-map.ts';

/** Map seed, size and identity only: the preview key never depends on match credentials. */
export const previewKey = (options: MatchOptions): string => JSON.stringify([options.terrain, options.map]);

/** `view`: the backdrop's map-only View (preview-map.ts buildPreviewView); `thumbnail`: a map card's PreviewMap. */
export type PreviewKind = 'view' | 'thumbnail';
export interface PreviewJob { id: number; kind: PreviewKind; options: MatchOptions }
export type PreviewReply = { id: number; result: MatchView | PreviewMap } | { id: number; error: string };

/** One worker, jobs in request order; results are cached per map selection. */
export class PreviewJobs<T extends MatchView | PreviewMap> {
  private worker: Worker | undefined;
  private next = 1;
  private readonly kind: PreviewKind;
  private readonly pending = new Map<number, { resolve: (result: T) => void; reject: (error: Error) => void }>();
  private readonly cache = new Map<string, Promise<T>>();

  constructor(kind: PreviewKind) {
    this.kind = kind;
  }

  get(options: MatchOptions): Promise<T> {
    const key = previewKey(options);
    let result = this.cache.get(key);
    if (!result) {
      result = this.run(options);
      result.catch(() => this.cache.delete(key));
      this.cache.set(key, result);
      // Keep only recent selections (an 80² preview view is ~60 KB).
      if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }

  private run(options: MatchOptions): Promise<T> {
    this.worker ??= this.start();
    const id = this.next++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pending.set(id, { resolve, reject });
    this.worker.postMessage({ id, kind: this.kind, options } satisfies PreviewJob);
    return promise;
  }

  private start(): Worker {
    const worker = new Worker(new URL('./preview.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<PreviewReply>) => {
      const reply = event.data;
      const job = this.pending.get(reply.id);
      if (!job) return;
      this.pending.delete(reply.id);
      if ('result' in reply) job.resolve(reply.result as T);
      else job.reject(new Error(reply.error));
    };
    worker.onerror = (event) => {
      for (const job of this.pending.values()) job.reject(new Error(event.message || 'Map preview worker failed'));
      this.pending.clear();
    };
    return worker;
  }
}

/** The backdrop's map-only views. */
export const previewViews = new PreviewJobs<MatchView>('view');
/** Map-card thumbnails: their own worker, so a card grid never delays the backdrop's map. */
export const thumbnailMaps = new PreviewJobs<PreviewMap>('thumbnail');
