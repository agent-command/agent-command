import type { ResultsSummary, SeriesUpdate } from 'playerthree/arena';
import type { ObserverMessage } from 'playerthree/protocol';

export type ArenaAccess =
  | { kind: 'owner'; seriesId: string; credential(): string | undefined }
  | { kind: 'share'; token: string };

export interface ArenaDelivery { delayMs: number; playback: 'buffering' | 'playing' | 'ended' }

export function arenaPath(access: ArenaAccess): string {
  return access.kind === 'owner'
    ? `/api/arena/series/${encodeURIComponent(access.seriesId)}`
    : `/arena/share/${encodeURIComponent(access.token)}`;
}

function headers(access: ArenaAccess): Record<string, string> {
  if (access.kind === 'share') return {};
  const credential = access.credential();
  if (!credential) throw new Error('Sign in to view this private series.');
  return { authorization: `Bearer ${credential}` };
}

export async function arenaRequest<T>(access: ArenaAccess, suffix = '', body?: unknown, signal?: AbortSignal, delivery?: (metadata: ArenaDelivery) => void): Promise<T> {
  const response = await fetch(arenaPath(access) + (access.kind === 'share' && !suffix ? '/data' : suffix), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers(access), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  });
  if (!response.ok) throw new Error(response.status === 404 || response.status === 403 ? 'This result is unavailable or access has been revoked.' : `Arena request failed (${response.status}).`);
  const playback = response.headers.get('x-arena-playback');
  if (delivery && (playback === 'buffering' || playback === 'playing' || playback === 'ended')) {
    delivery({ delayMs: Number(response.headers.get('x-arena-delay-ms') ?? 0), playback });
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

/** Each server-sent event of a fetch response: its `event:` name (`message` when unnamed) and parsed `data:` JSON. */
export async function* sseEvents(response: Response, signal: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
  if (!response.ok || !response.body) throw new Error('The authorized stream is unavailable.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending = (pending + chunk.value).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const lines = pending.slice(0, boundary).split('\n');
        pending = pending.slice(boundary + 2);
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const named = lines.find((line) => line.startsWith('event:'));
        yield { event: named ? named.slice(6).trim() : 'message', data: JSON.parse(data) as unknown };
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

async function* sseMessages<T>(response: Response, signal: AbortSignal): AsyncGenerator<T> {
  for await (const { data } of sseEvents(response, signal)) yield data as T;
}

/** Fetch-based SSE keeps private credentials out of URLs and supports the server resume cursor. */
export async function streamArena(access: ArenaAccess, revision: number, signal: AbortSignal, receive: (result: ResultsSummary) => void, delivery?: (metadata: ArenaDelivery) => void): Promise<void> {
  const response = await fetch(arenaPath(access) + '/events', {
    headers: { ...headers(access), accept: 'text/event-stream', 'last-event-id': String(revision) }, signal,
  });
  for await (const update of sseMessages<SeriesUpdate>(response, signal)) {
    if (update.revision <= revision) continue;
    const result = await arenaRequest<ResultsSummary>(access, '', undefined, signal, delivery);
    if (result.revision >= update.revision) { revision = result.revision; receive(result); }
  }
}

export async function openArenaObserverStream(access: ArenaAccess, matchId: string, perspective: string, signal: AbortSignal): Promise<AsyncIterable<ObserverMessage>> {
  const response = await fetch(`${arenaPath(access)}/matches/${encodeURIComponent(matchId)}/observer/events?perspective=${encodeURIComponent(perspective)}`, {
    headers: { ...headers(access), accept: 'text/event-stream' }, signal,
  });
  if (!response.ok || !response.body) throw new Error('Observer access is unavailable or revoked.');
  return sseMessages<ObserverMessage>(response, signal);
}

export async function downloadArena(access: ArenaAccess, format: 'json' | 'csv', revision: number): Promise<void> {
  const response = await fetch(`${arenaPath(access)}/export.${format}?revision=${revision}`, { headers: headers(access) });
  if (!response.ok) throw new Error('This revision cannot be downloaded.');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `arena-revision-${revision}.${format === 'csv' ? 'zip' : 'json'}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadArenaArtifact(access: ArenaAccess, artifactId: string): Promise<void> {
  const response = await fetch(`${arenaPath(access)}/artifacts/${encodeURIComponent(artifactId)}`, { headers: headers(access) });
  if (!response.ok) throw new Error('Replay unavailable or access revoked.');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${artifactId}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
