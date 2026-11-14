import { afterEach, expect, it } from 'vitest';
import type { ObserverMessage } from 'playerthree/protocol';
import type { GameServer } from '../src/app.ts';
import { FEATURED_DELAY_MS } from '../src/featured.ts';
import { FeaturedPlaylist, featuredBotSeats } from '../src/featured-playlist.ts';
import { start } from './helpers.ts';

/** A playlist seed whose first entry is a four-army FFA. */
const FFA_SEED = 2;

let server: GameServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

/** Read SSE events from `stream` until `done` accepts one; returns every event read. */
async function readUntil(stream: Response, done: (event: string, data: unknown) => boolean): Promise<{ event: string; data: unknown }[]> {
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
  try {
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) return events;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const [head, body] = buffer.slice(0, cut).split('\n');
        buffer = buffer.slice(cut + 2);
        const entry = { event: head!.slice('event: '.length), data: JSON.parse(body!.slice('data: '.length)) as unknown };
        events.push(entry);
        if (done(entry.event, entry.data)) return events;
      }
    }
  } finally { await reader.cancel(); }
}

const ready = (event: string, data: unknown) => event === 'observer' && (data as ObserverMessage).state === 'ready';

// Production hosts the showcase in a simulation worker; a worker-less server opens it in the main process.
it.each([0, 1])('serves Watch live’s All (simWorkers %i, FEATURED_PLAYLIST=off): the fixed duel’s delayed omniscient projection, beside each army’s fog', async (simWorkers) => {
  const running = await start({ featuredMatch: true, featuredPlaylist: false, simWorkers });
  server = running.server;
  const [all, blue] = await Promise.all([
    fetch(`${running.base}/api/featured/stream?team=all`),
    fetch(`${running.base}/api/featured/stream?team=nw`),
  ]);
  expect(all.status).toBe(200);
  const [allEvents, blueEvents] = await Promise.all([readUntil(all, ready), readUntil(blue, ready)]);
  expect(allEvents.find((entry) => entry.event === 'match')?.data).toMatchObject({ omniscient: true, armies: ['nw', 'se'], label: '' });
  const frame = (allEvents.at(-1)!.data as ObserverMessage).frame!;
  expect(frame.perspective).toBe('all');
  expect(frame.releaseAt - frame.recordedAt).toBeGreaterThanOrEqual(FEATURED_DELAY_MS);
  // The omniscient projection discloses both armies; the fogged stream is one army's view with no sides.
  expect((frame.world as { sides: { army: string }[] }).sides.map((side) => side.army)).toEqual(['nw', 'se']);
  const fog = (blueEvents.at(-1)!.data as ObserverMessage).frame!;
  expect(fog.perspective).toBe('nw');
  expect(fog.world).not.toHaveProperty('sides');
}, 30_000);

it.each([0, 1])('plays the playlist’s entry (simWorkers %i): a four-army FFA announced with its real armies, seat levels and matchup', async (simWorkers) => {
  const entry = new FeaturedPlaylist({ seed: FFA_SEED }).next();
  expect(entry.armies).toHaveLength(4);
  const running = await start({ featuredMatch: true, featuredPlaylist: true, featuredPlaylistSeed: FFA_SEED, simWorkers });
  server = running.server;
  const [all, violet] = await Promise.all([
    fetch(`${running.base}/api/featured/stream?team=all`),
    fetch(`${running.base}/api/featured/stream?team=sw`),
  ]);
  const [allEvents, violetEvents] = await Promise.all([readUntil(all, ready), readUntil(violet, ready)]);
  expect(allEvents.find((entry) => entry.event === 'match')?.data).toEqual({
    roomId: expect.any(String), public: false, delayMs: FEATURED_DELAY_MS, omniscient: true, label: entry.label,
    armies: ['nw', 'ne', 'se', 'sw'], seats: featuredBotSeats(entry).map(({ team, role, level }) => ({ team, role, kind: 'bot', level })),
  });
  const frame = (allEvents.at(-1)!.data as ObserverMessage).frame!;
  expect((frame.world as { sides: { army: string }[] }).sides.map((side) => side.army)).toEqual(['nw', 'ne', 'se', 'sw']);
  expect((violetEvents.at(-1)!.data as ObserverMessage).frame!.perspective).toBe('sw');
}, 60_000);
