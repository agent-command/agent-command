import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ObserverFrame, ObserverGrant } from 'playerthree/protocol';
import { patch } from 'playerthree/delta';
import { builtInBotsOnly, createFeatured, FEATURED_DELAY_MS, featuredFrames, featuredMatchup, PUBLIC_OBSERVER_DELAY_MS, type FeaturedOptions, type FeaturedPerspective, type FeaturedSession, type PublicGame } from '../src/featured.ts';
import type { LobbyMatch } from '../src/lobby-match.ts';

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writable = true;
  status = 0;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; }
  flushHeaders() {}
  write(bytes: Buffer) { this.chunks.push(bytes); return this.writable; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  end(bytes?: string) { if (bytes) this.chunks.push(Buffer.from(bytes)); this.writableEnded = true; }
  get response() { return this as unknown as ServerResponse; }
  /** Parsed SSE events, in order. */
  events() {
    return this.chunks.map((chunk) => {
      const [event, data] = chunk.toString().split('\n');
      return { event: event!.slice('event: '.length), data: JSON.parse(data!.slice('data: '.length)) as { state?: string; frame?: ObserverFrame; grant?: ObserverGrant; roomId?: string; omniscient?: boolean } };
    });
  }
}

/** A stream request; `owner` stands for the lobby identity its credential names (the fixture's `viewer`). */
const req = (method = 'GET', url = '/api/featured/stream', owner?: string) => ({ method, url, headers: owner ? { authorization: owner } : {} }) as unknown as IncomingMessage;
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
const viewerLimits = { total: 500, perIp: 8, ip: () => '127.0.0.1' };
/** The relay without public games: the bot playlist alone. */
const playlistOnly = { publicGames: () => [], openPublic: (): FeaturedSession => { throw new Error('no public games'); }, viewer: () => undefined };

/** `omniscient`: the opened sessions' seats are all built-in bots, so the relay may serve `all`. */
function fixture(limits: FeaturedOptions['viewerLimits'] = viewerLimits, omniscient = true) {
  let ended = false;
  let allowed = true;
  let sequence = 0;
  const listeners = new Map<string, (frame: ObserverFrame) => void>();
  const release = vi.fn(async () => {});
  const observed: FeaturedPerspective[] = [];
  /** Eligible public games (a game leaves the list when it ends, as the lobby releases it). */
  const games: PublicGame[] = [];
  const publicEnded = new Set<string>();
  const observe = (roomId: string) => (perspective: FeaturedPerspective, frame: (frame: ObserverFrame) => void) => {
    observed.push(perspective);
    listeners.set(`${roomId}:${perspective}`, frame);
    return () => listeners.delete(`${roomId}:${perspective}`);
  };
  const open = vi.fn(async (): Promise<FeaturedSession> => {
    const roomId = `featured-${++sequence}`;
    return {
      roomId, public: false, delayMs: FEATURED_DELAY_MS, armies: ['nw', 'se'], seats: [{ team: 'nw', role: 'surface', kind: 'bot', level: 'standard' }], label: 'Standard mirror · Ridges 48', omniscient,
      observe: observe(roomId), ended: () => ended, close: release,
    };
  });
  const openPublic = vi.fn((game: PublicGame): FeaturedSession => ({
    roomId: game.roomId, public: true, delayMs: game.delayMs, armies: game.armies, seats: game.seats, label: game.label, omniscient: game.omniscient,
    observe: observe(game.roomId), ended: () => publicEnded.has(game.roomId), close: async () => {}, played: game.played,
  }));
  const featured = createFeatured({
    // Outlives a public game's delayed playback: a bot match cut away from runs on through it.
    open, canStart: () => allowed, openPublic, maxMatchMs: 600_000, viewerLimits: limits,
    publicGames: () => games.filter((game) => !publicEnded.has(game.roomId)),
    viewer: (request) => request.headers.authorization,
  });
  /** Push one released frame of `perspective` of the current bot match, or of `roomId`. */
  const emit = (perspective: FeaturedPerspective, frame: Omit<ObserverFrame, 'recordedAt' | 'releaseAt' | 'perspective'>, roomId = `featured-${sequence}`) =>
    listeners.get(`${roomId}:${perspective}`)?.({ ...frame, recordedAt: 0, releaseAt: FEATURED_DELAY_MS, perspective });
  /** A public game starts: `profile:<team>` played its army. */
  const start = (roomId: string, startedAt: number, extra: Partial<PublicGame> = {}) => {
    games.push({
      roomId, startedAt, delayMs: PUBLIC_OBSERVER_DELAY_MS, omniscient: true, armies: ['nw', 'se'], label: `Player 1 vs Standard bot · ${roomId}`,
      seats: [{ team: 'nw', role: 'surface', kind: 'human', name: 'Player 1' }, { team: 'se', role: 'surface', kind: 'bot', level: 'standard' }],
      game: {} as LobbyMatch, played: (owner) => owner === 'profile:nw' ? ['nw'] : undefined, ...extra,
    });
  };
  return {
    featured, open, openPublic, release, emit, observed, listeners, start,
    end: () => { ended = true; }, gate: () => { allowed = false; }, endPublic: (roomId: string) => { publicEnded.add(roomId); },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

it('relays one delayed team stream to every viewer with a single encoding per frame', async () => {
  const f = fixture();
  f.featured.start();
  f.featured.start();
  await flush();
  expect(f.open).toHaveBeenCalledTimes(1);
  const a = new Response();
  const b = new Response();
  expect(f.featured.handle(req(), a.response, '/api/featured/stream')).toBe(true);
  f.featured.handle(req(), b.response, '/api/featured/stream');
  expect(a.events().map((event) => event.event)).toEqual(['observer', 'match']);
  expect(a.events()[0]!.data.state).toBe('buffering');
  f.emit('nw', { sequence: 1, tick: 20, world: { tick: 20, units: [{ id: 'u_1', x: 1 }] } });
  f.emit('nw', { sequence: 2, tick: 21, delta: { o: { units: { k: 1, u: { u_1: { v: { x: 2 } } } } }, v: { tick: 21 } } });
  f.emit('se', { sequence: 1, tick: 20, world: { secret: 'red only' } });
  // Every viewer of a team gets the identical buffer: serialized once, then fanned out.
  expect(b.chunks.at(-1)).toBe(a.chunks.at(-1));
  expect(a.chunks.some((chunk) => chunk.toString().includes('red only'))).toBe(false);
  const frames = a.events().filter((event) => event.data.frame).map((event) => event.data.frame!);
  expect(frames.map((frame) => frame.sequence)).toEqual([1, 2]);
  // A late join gets one keyframe of the current released state, never the backlog.
  const late = new Response();
  f.featured.handle(req(), late.response, '/api/featured/stream');
  const key = late.events().find((event) => event.data.frame)!.data.frame!;
  expect(key).toMatchObject({ sequence: 2, world: { tick: 21, units: [{ id: 'u_1', x: 2 }] } });
  expect(patch(frames[0]!.world, frames[1]!.delta!)).toEqual(key.world);
  const red = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=se'), red.response, '/api/featured/stream');
  expect(red.events().find((event) => event.data.frame)!.data.frame!.world).toEqual({ secret: 'red only' });
  expect(a.headers['X-Accel-Buffering']).toBe('no');
  await f.featured.close();
});

it('resumes a stalled reader at a keyframe and drops a reader stalled too long', async () => {
  const f = fixture();
  f.featured.start();
  await flush();
  const slow = new Response();
  f.featured.handle(req(), slow.response, '/api/featured/stream');
  f.emit('nw', { sequence: 1, tick: 1, world: { tick: 1 } });
  slow.writable = false;
  f.emit('nw', { sequence: 2, tick: 2, delta: { v: { tick: 2 } } });
  const written = slow.chunks.length;
  f.emit('nw', { sequence: 3, tick: 3, delta: { v: { tick: 3 } } });
  expect(slow.chunks).toHaveLength(written);
  slow.writable = true;
  slow.emit('drain');
  expect(slow.events().at(-1)!.data.frame).toMatchObject({ sequence: 3, world: { tick: 3 } });
  f.emit('nw', { sequence: 4, tick: 4, delta: { v: { tick: 4 } } });
  expect(slow.events().at(-1)!.data.frame).toMatchObject({ sequence: 4, delta: { v: { tick: 4 } } });
  slow.writable = false;
  f.emit('nw', { sequence: 5, tick: 5, delta: { v: { tick: 5 } } });
  await vi.advanceTimersByTimeAsync(6000);
  expect(slow.destroyed).toBe(true);
  expect(f.featured.stats().viewers).toBe(0);
  await f.featured.close();
});

it('a keyframe larger than the socket buffer is written once: drain without a missed frame continues with deltas', async () => {
  const f = fixture();
  f.featured.start();
  await flush();
  const viewer = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=all'), viewer.response, '/api/featured/stream');
  // Every write of the big omniscient keyframe fills the buffer; the socket then flushes it.
  viewer.writable = false;
  f.emit('all', { sequence: 1, tick: 1, world: { tick: 1, sides: [] } });
  viewer.writable = true;
  for (let flushes = 0; flushes < 3; flushes++) viewer.emit('drain');
  f.emit('all', { sequence: 2, tick: 2, delta: { v: { tick: 2 } } });
  expect(viewer.events().filter((event) => event.data.frame).map((event) => [event.data.frame!.sequence, event.data.frame!.world !== undefined])).toEqual([[1, true], [2, false]]);
  await f.featured.close();
});

it('holds the end through its delay, then rotates to a new match without dropping viewers', async () => {
  const f = fixture();
  f.featured.start();
  await flush();
  const viewer = new Response();
  f.featured.handle(req(), viewer.response, '/api/featured/stream');
  f.emit('nw', { sequence: 1, tick: 1, world: { tick: 1 }, outcomes: { nw: 'win' } });
  f.end();
  await vi.advanceTimersByTimeAsync(FEATURED_DELAY_MS + 1000);
  expect(f.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.open).toHaveBeenCalledTimes(2);
  expect(viewer.destroyed).toBe(false);
  expect(viewer.events().filter((event) => event.event === 'match').map((event) => event.data.roomId)).toEqual(['featured-1', 'featured-2']);
  await f.featured.close();
  expect(viewer.destroyed).toBe(true);
});

it('honors the host admission gate and refuses command methods and unknown teams', async () => {
  const f = fixture();
  f.gate();
  f.featured.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.open).not.toHaveBeenCalled();
  const response = new Response();
  f.featured.handle(req('POST'), response.response, '/api/featured/stream');
  expect(response.status).toBe(405);
  expect(response.headers.Allow).toBe('GET');
  const unknown = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=everyone'), unknown.response, '/api/featured/stream');
  expect(unknown.status).toBe(400);
  expect(f.featured.handle(req(), new Response().response, '/api/match')).toBe(false);
  await f.featured.close();
});

it('rotates before the transport lifetime limit and closes a session opened during shutdown', async () => {
  const f = fixture();
  const featured = createFeatured({ open: f.open, canStart: () => true, maxMatchMs: 5000, viewerLimits, ...playlistOnly });
  featured.start();
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.open).toHaveBeenCalledTimes(2);
  await featured.close();

  const opening = Promise.withResolvers<FeaturedSession>();
  const delayed = createFeatured({ open: () => opening.promise, canStart: () => true, maxMatchMs: 60_000, viewerLimits, ...playlistOnly });
  delayed.start();
  const closing = delayed.close();
  opening.resolve({ roomId: 'late', public: false, delayMs: FEATURED_DELAY_MS, armies: ['nw', 'se'], seats: [], label: '', omniscient: true, observe: () => () => {}, ended: () => false, close: f.release });
  await closing;
  expect(f.release).toHaveBeenCalledTimes(3);
});

it('bounds featured fan-out globally and per IP and releases disconnected reservations', async () => {
  const f = fixture({ total: 2, perIp: 1, ip: (request) => request.headers['x-forwarded-for'] as string });
  const connect = (ip: string) => {
    const response = new Response();
    f.featured.handle(Object.assign(req(), { headers: { 'x-forwarded-for': ip } }), response.response, '/api/featured/stream');
    return response;
  };
  const first = connect('first');
  expect(first.status).toBe(200);
  const duplicate = connect('first');
  expect(duplicate.status).toBe(429);
  expect(duplicate.headers['Retry-After']).toBe('5');
  expect(connect('second').status).toBe(200);
  expect(connect('third').status).toBe(503);
  expect(f.featured.stats().viewers).toBe(2);
  first.destroy();
  expect(connect('first').status).toBe(200);
  expect(f.featured.stats().viewers).toBe(2);
  await f.featured.close();
  expect(f.featured.stats().viewers).toBe(0);
});

it('serves the delayed omniscient projection as `all` for an all-bot match, apart from each army’s fog', async () => {
  const f = fixture();
  f.featured.start();
  await flush();
  expect(f.observed).toEqual(['all', 'nw', 'se']);
  const all = new Response();
  const blue = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=all'), all.response, '/api/featured/stream');
  f.featured.handle(req('GET', '/api/featured/stream?team=nw'), blue.response, '/api/featured/stream');
  expect(all.events()[0]!.data.grant).toEqual({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: FEATURED_DELAY_MS });
  expect(all.events().find((event) => event.event === 'match')!.data.omniscient).toBe(true);
  f.emit('all', { sequence: 1, tick: 20, world: { sides: ['nw', 'se'] } });
  f.emit('nw', { sequence: 1, tick: 20, world: { army: 'nw' } });
  expect(all.events().filter((event) => event.data.frame).map((event) => event.data.frame!.world)).toEqual([{ sides: ['nw', 'se'] }]);
  expect(blue.chunks.some((chunk) => chunk.toString().includes('sides'))).toBe(false);
  // Serialized once, fanned out: a second All viewer receives the very same keyframe buffer.
  const again = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=all'), again.response, '/api/featured/stream');
  const late = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=all'), late.response, '/api/featured/stream');
  expect(late.chunks.at(-1)).toBe(again.chunks.at(-1));
  await f.featured.close();
});

it('never serves `all` for a match with a seat that is not a built-in bot', async () => {
  const f = fixture(viewerLimits, false);
  f.featured.start();
  await flush();
  expect(f.observed).toEqual(['nw', 'se']);
  const all = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=all'), all.response, '/api/featured/stream');
  expect(all.events().find((event) => event.event === 'match')!.data.omniscient).toBe(false);
  f.emit('all', { sequence: 1, tick: 20, world: { sides: ['nw', 'se'] } });
  f.emit('nw', { sequence: 1, tick: 20, world: { army: 'nw' } });
  await vi.advanceTimersByTimeAsync(3000);
  expect(all.events().filter((event) => event.data.frame)).toEqual([]);
  await f.featured.close();
});

it('ends an omniscient source at the first frame after any seat stops being a built-in bot; fog streams continue', async () => {
  const bot = { controller: 'bot' as const, agentActive: false };
  const seats = [{ ...bot }, { ...bot }];
  const match = {
    seats: () => seats,
    async *observerFrames(grant: ObserverGrant) { for (let tick = 1; tick <= 4; tick++) { if (tick === 3) seats[1] = { controller: 'human' as never, agentActive: false }; yield { sequence: tick, tick, perspective: grant.kind === 'team' ? grant.team : 'all' } as ObserverFrame; } },
  } as unknown as Parameters<typeof featuredFrames>[0];
  const ticks = async (grant: ObserverGrant) => { const out: number[] = []; for await (const frame of featuredFrames(match, grant)) out.push(frame.tick); return out; };
  expect(await ticks({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: FEATURED_DELAY_MS })).toEqual([1, 2]);
  seats[1] = { ...bot };
  expect(await ticks({ kind: 'team', team: 'nw', delayMs: FEATURED_DELAY_MS })).toEqual([1, 2, 3, 4]);
  // A public game's omniscient view at the public observer delay is what the public rules give anyone, whoever plays.
  seats[1] = { ...bot };
  expect(await ticks({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: PUBLIC_OBSERVER_DELAY_MS })).toEqual([1, 2, 3, 4]);
  expect(builtInBotsOnly([bot, { controller: 'bot', agentActive: true }])).toBe(false);
  expect(builtInBotsOnly([bot, { controller: 'agent', agentActive: false }])).toBe(false);
  expect(builtInBotsOnly([])).toBe(false);
  expect(builtInBotsOnly([bot, bot])).toBe(true);
});

/** The last `match` announcement and released frame a reader got. */
const announced = (viewer: Response) => viewer.events().filter((event) => event.event === 'match').at(-1)?.data as Record<string, unknown> | undefined;
const frames = (viewer: Response) => viewer.events().filter((event) => event.data?.frame).map((event) => event.data.frame!);

it('announces a public game ahead, cuts over at its first delayed frame, keeps the bot match running off air and resumes it after the result', async () => {
  const f = fixture();
  f.featured.start();
  await flush();
  const viewer = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=all'), viewer.response, '/api/featured/stream');
  f.emit('all', { sequence: 1, tick: 1, world: { bot: 1 } });
  // A public game starts: announced with its live-in countdown while the bot match stays on air.
  await vi.advanceTimersByTimeAsync(1000);
  f.start('public-1', 1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.openPublic).toHaveBeenCalledTimes(1);
  expect(viewer.events().filter((event) => event.event === 'upcoming').at(-1)!.data).toEqual({ roomId: 'public-1', label: 'Player 1 vs Standard bot · public-1', liveInMs: PUBLIC_OBSERVER_DELAY_MS - 1000 });
  f.emit('all', { sequence: 2, tick: 2, delta: { v: { bot: 2 } } });
  expect(frames(viewer).at(-1)).toMatchObject({ sequence: 2 });
  expect(f.featured.stats()).toMatchObject({ onAir: { roomId: 'featured-1', public: false }, upcoming: { roomId: 'public-1' }, activeRoomId: 'featured-1' });
  // Its delayed stream releases a frame: held until the next pump, which cuts over to it.
  f.emit('all', { sequence: 7, tick: 140, world: { public: 1 } }, 'public-1');
  expect(frames(viewer).at(-1)).toMatchObject({ sequence: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(announced(viewer)).toEqual({ roomId: 'public-1', public: true, delayMs: PUBLIC_OBSERVER_DELAY_MS, armies: ['nw', 'se'], omniscient: true, label: 'Player 1 vs Standard bot · public-1',
    seats: [{ team: 'nw', role: 'surface', kind: 'human', name: 'Player 1' }, { team: 'se', role: 'surface', kind: 'bot', level: 'standard' }] });
  expect(frames(viewer).at(-1)).toMatchObject({ sequence: 7, world: { public: 1 } });
  expect(viewer.events().filter((event) => event.event === 'upcoming').at(-1)!.data).toBeNull();
  // Every reader of the public game gets the public delay in its grant.
  const late = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=nw'), late.response, '/api/featured/stream');
  expect(late.events()[0]!.data.grant).toEqual({ kind: 'team', team: 'nw', delayMs: PUBLIC_OBSERVER_DELAY_MS });
  // The bot match runs on off air: never released, no longer relayed.
  expect(f.release).not.toHaveBeenCalled();
  expect(f.listeners.has('featured-1:all')).toBe(false);
  expect(f.featured.stats()).toMatchObject({ onAir: { roomId: 'public-1', public: true }, activeRoomId: 'featured-1', delayMs: PUBLIC_OBSERVER_DELAY_MS });
  // The public game ends: its delayed end plays out and the result holds, then the same bot match is back.
  f.endPublic('public-1');
  await vi.advanceTimersByTimeAsync(PUBLIC_OBSERVER_DELAY_MS);
  expect(f.featured.stats().onAir).toEqual({ roomId: 'public-1', public: true });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(announced(viewer)).toMatchObject({ roomId: 'featured-1', public: false, delayMs: FEATURED_DELAY_MS });
  expect(f.open).toHaveBeenCalledTimes(1);
  f.emit('all', { sequence: 40, tick: 40, world: { bot: 40 } });
  expect(frames(viewer).at(-1)).toMatchObject({ sequence: 40, world: { bot: 40 } });
  await f.featured.close();
});

it('releases a bot match cut away from at its own end, and opens the next one once the public game is over', async () => {
  const f = fixture();
  f.start('public-1', 0);
  f.featured.start();
  await flush();
  expect(f.open).toHaveBeenCalledTimes(1);
  f.emit('all', { sequence: 1, tick: 1, world: { public: 1 } }, 'public-1');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.featured.stats().onAir).toEqual({ roomId: 'public-1', public: true });
  f.end();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.featured.stats().activeRoomId).toBeUndefined();
  expect(f.open).toHaveBeenCalledTimes(1);
  f.endPublic('public-1');
  await vi.advanceTimersByTimeAsync(PUBLIC_OBSERVER_DELAY_MS + 10_000);
  expect(f.open).toHaveBeenCalledTimes(2);
  expect(f.featured.stats().onAir).toEqual({ roomId: 'featured-2', public: false });
  await f.featured.close();
});

it('features the newest eligible public game and switches to a newer one once its delayed stream is ready', async () => {
  const f = fixture();
  f.start('older', 0);
  f.start('newer', 5000);
  f.featured.start();
  await flush();
  expect(f.openPublic.mock.calls.map(([game]) => game.roomId)).toEqual(['newer']);
  f.emit('all', { sequence: 1, tick: 1, world: { game: 'newer' } }, 'newer');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.featured.stats().onAir).toEqual({ roomId: 'newer', public: true });
  // While a public game is on air, an older one never cuts in; a newer one does once its stream has a frame.
  f.start('newest', 9000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.featured.stats()).toMatchObject({ onAir: { roomId: 'newer' }, upcoming: { roomId: 'newest' } });
  f.emit('all', { sequence: 1, tick: 1, world: { game: 'newest' } }, 'newest');
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.featured.stats().onAir).toEqual({ roomId: 'newest', public: true });
  expect(f.listeners.has('newer:all')).toBe(false);
  expect(f.openPublic.mock.calls.map(([game]) => game.roomId)).toEqual(['newer', 'newest']);
  await f.featured.close();
});

it('a player of the public game on air watches only its own side, anonymous readers everything', async () => {
  const f = fixture();
  f.featured.start();
  await flush();
  // Already watching (the bot match) when the relay cuts over to the game it plays.
  const watching = new Response();
  f.featured.handle(req('GET', '/api/featured/stream?team=all', 'profile:nw'), watching.response, '/api/featured/stream');
  f.emit('all', { sequence: 1, tick: 1, world: { bot: 1 } });
  expect(frames(watching)).toHaveLength(1);
  f.start('public-1', 0);
  await vi.advanceTimersByTimeAsync(1000);
  for (const perspective of ['all', 'nw', 'se'] as const) f.emit(perspective, { sequence: 1, tick: 1, world: { view: perspective } }, 'public-1');
  await vi.advanceTimersByTimeAsync(1000);
  expect(announced(watching)).toMatchObject({ roomId: 'public-1', armies: ['nw'], omniscient: false, played: true });
  const connect = (team: string, owner?: string) => {
    const response = new Response();
    f.featured.handle(req('GET', `/api/featured/stream?team=${team}`, owner), response.response, '/api/featured/stream');
    return response;
  };
  const [all, red, own, anonymous] = [connect('all', 'profile:nw'), connect('se', 'profile:nw'), connect('nw', 'profile:nw'), connect('all')];
  for (const perspective of ['all', 'nw', 'se'] as const) f.emit(perspective, { sequence: 2, tick: 2, delta: { v: { tick: 2 } } }, 'public-1');
  expect(announced(all)).toMatchObject({ armies: ['nw'], omniscient: false, played: true });
  expect(frames(watching)).toHaveLength(1);
  expect(frames(all)).toEqual([]);
  expect(frames(red)).toEqual([]);
  expect(frames(own).map((frame) => frame.sequence)).toEqual([1, 2]);
  expect(frames(own)[0]!.world).toEqual({ view: 'nw' });
  expect(announced(anonymous)).toMatchObject({ armies: ['nw', 'se'], omniscient: true });
  expect(announced(anonymous)).not.toHaveProperty('played');
  expect(frames(anonymous).map((frame) => frame.sequence)).toEqual([1, 2]);
  await f.featured.close();
});

it('names a matchup by the public names on each side', () => {
  expect(featuredMatchup(['nw', 'se'], [
    { team: 'nw', role: 'surface', kind: 'human', name: 'Player 1' }, { team: 'nw', role: 'sky', kind: 'agent', name: 'AI Player' },
    { team: 'se', role: 'surface', kind: 'bot', level: 'veteran' }, { team: 'se', role: 'sky', kind: 'bot', level: 'veteran' },
  ])).toBe('Player 1 + AI Player vs Veteran bot');
});
