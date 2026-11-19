import { afterEach, expect, it, vi } from 'vitest';
import type { ResultsSummary } from 'playerthree/arena';
import { arenaPath, arenaRequest, streamArena, type ArenaAccess } from '../src/arena-net.ts';
import { availableReplays, chartPoints, duration } from '../src/arena-present.ts';

afterEach(() => vi.unstubAllGlobals());
const access: ArenaAccess = { kind: 'owner', seriesId: 'series', credential: () => 'private-bearer' };

it('keeps private profile credentials in Authorization and public shares read-only', async () => {
  const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ revision: 2 })));
  vi.stubGlobal('fetch', request);
  await arenaRequest(access);
  expect(request.mock.calls[0]![0]).toBe('/api/arena/series/series');
  expect(request.mock.calls[0]![1].headers).toEqual({ authorization: 'Bearer private-bearer' });
  await arenaRequest({ kind: 'share', token: 'public-token' });
  expect(request.mock.calls[1]![0]).toBe('/arena/share/public-token/data');
  expect(request.mock.calls[1]![1].headers).toEqual({});
  expect(arenaPath(access)).not.toContain('private-bearer');
});

it('refetches the authorized snapshot at each committed SSE revision and resumes without credentials in URLs', async () => {
  const result = { format: 'playerthree.results.summary', revision: 3 } as ResultsSummary;
  const request = vi.fn().mockResolvedValueOnce(new Response('event: update\ndata: {"seriesId":"series","revision":3}\n\n', { headers: { 'content-type': 'text/event-stream' } })).mockResolvedValueOnce(new Response(JSON.stringify(result)));
  vi.stubGlobal('fetch', request); const receive = vi.fn();
  await streamArena(access, 2, new AbortController().signal, receive);
  expect(request.mock.calls[0]![0]).toBe('/api/arena/series/series/events');
  expect(request.mock.calls[0]![1].headers['last-event-id']).toBe('2');
  expect(receive).toHaveBeenCalledWith(result);
});

it('labels missing durations and maps recorded chart samples without making observations', () => {
  expect(duration(null)).toBe('Not reported'); expect(duration(123000)).toBe('2m 3s');
  expect(chartPoints([{ tick: 0, value: 0 }, { tick: 20, value: 100 }])).toBe('4,96 296,4');
});

it('never advertises expired or unrecorded artifacts as replay links', () => {
  const result = { tables: { artifacts: [{ id: 'available', kind: 'replay', availability: 'available' }, { id: 'expired', kind: 'replay', availability: 'expired' }, { id: 'missing', kind: 'recording', availability: 'not_recorded' }] } } as unknown as ResultsSummary;
  expect(availableReplays(result).map((artifact) => artifact.id)).toEqual(['available']);
});
