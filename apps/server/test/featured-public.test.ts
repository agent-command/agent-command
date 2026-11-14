/**
 * Watch live shows a real public game: eligibility (public lobbies left on Watch live and rated matches, never private
 * ones), the public observer delay on every relayed frame, the player rules, and a fog twin check of what leaves the
 * relay. The delay is the real `PUBLIC_OBSERVER_DELAY_MS`: the clock tests move only `Date` (what the observer stream
 * and the relay release by), never the simulation's tick timers.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { ObserverFrame, ObserverMessage } from 'playerthree/protocol';
import { patch } from 'playerthree/delta';
import type { GameServer } from '../src/app.ts';
import { PUBLIC_OBSERVER_DELAY_MS, type FeaturedStats } from '../src/featured.ts';
import { freshIp, json, lobbyAttach, lobbyEnter, start, type AttachedLobby, type LobbyCreate } from './helpers.ts';
import { fullLineup, headers, linkedProfile, policyCommander, startRanked, type RankedServer } from './ranked-fixture.ts';

const ADMIN = 'featured-public-admin-token-0123456789';
const PUBLIC_PLAY = { mapId: 'open', layoutId: 'duel', visibility: 'public', preset: 'play', autoStart: true } as const;

let server: GameServer | undefined;
let ranked: RankedServer | undefined;
const streams: Stream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  vi.useRealTimers();
  await server?.close(); server = undefined;
  await ranked?.close(); ranked = undefined;
});

/** Polls on the performance clock: these tests move `Date`. */
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error('timed out');
    await pause(25);
  }
}

function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** One open Watch live stream: every event it has received, in order. */
class Stream {
  readonly events: { event: string; data: unknown }[] = [];
  readonly #abort = new AbortController();
  status = 0;
  constructor(base: string, team: string, authorization?: string) {
    void (async () => {
      const response = await fetch(`${base}/api/featured/stream?team=${team}`, { headers: { 'x-forwarded-for': freshIp(), ...(authorization ? { authorization } : {}) }, signal: this.#abort.signal });
      this.status = response.status;
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const [head, body] = buffer.slice(0, cut).split('\n');
          buffer = buffer.slice(cut + 2);
          this.events.push({ event: head!.slice('event: '.length), data: JSON.parse(body!.slice('data: '.length)) as unknown });
        }
      }
    })().catch(() => {});
    streams.push(this);
  }
  /** Released frames of the match announced last (each perspective's frames follow its announcement). */
  frames(roomId: string): ObserverFrame[] {
    const from = this.events.findLastIndex((entry) => entry.event === 'match' && (entry.data as { roomId: string }).roomId === roomId);
    if (from < 0) return [];
    return this.events.slice(from).flatMap((entry) => entry.event === 'observer' && (entry.data as ObserverMessage).frame ? [(entry.data as ObserverMessage).frame!] : []);
  }
  /** The perspective's state rebuilt from the frames of `roomId` (keyframe, then deltas). */
  state(roomId: string): { sequence: number; world: unknown } | undefined {
    let state: { sequence: number; world: unknown } | undefined;
    for (const frame of this.frames(roomId)) {
      if (frame.world !== undefined) state = { sequence: frame.sequence, world: frame.world };
      else if (state && frame.sequence === state.sequence + 1) state = { sequence: frame.sequence, world: frame.delta ? patch(state.world, frame.delta) : state.world };
    }
    return state;
  }
  announced(roomId: string): Record<string, unknown> | undefined {
    return this.events.findLast((entry) => entry.event === 'match' && (entry.data as { roomId: string }).roomId === roomId)?.data as Record<string, unknown> | undefined;
  }
  close(): void { this.#abort.abort(); }
}

const featured = async (base: string, init: RequestInit = {}) => json<FeaturedStats>(await fetch(`${base}/api/featured`, init));

/** A public (or private) human-vs-bots lobby whose human has joined its seats: the match runs. */
async function running(base: string, body: Record<string, unknown>): Promise<{ attached: AttachedLobby; roomId: string; token: string }> {
  const attached = await lobbyAttach(base, body as unknown as LobbyCreate);
  const entered = await lobbyEnter(base, attached, 20_000);
  return { attached, roomId: entered.roomId, token: entered.token };
}

it('features public lobbies by default, never one its host opted out of, never a private one', { timeout: 120_000 }, async () => {
  const running0 = await start({ featuredMatch: true, featuredPlaylist: false, lobbyCountdownMs: 10 });
  server = running0.server;
  const { base } = running0;
  const featuredOn = await running(base, PUBLIC_PLAY);
  expect(featuredOn.attached.snapshots.at(-1)).toMatchObject({ visibility: 'public', featured: true });
  await waitFor(async () => (await featured(base)).upcoming?.roomId === featuredOn.roomId);
  // Newer games that are not eligible never take the pick: the newest eligible stays the first.
  const optedOut = await running(base, { ...PUBLIC_PLAY, featured: false });
  expect(optedOut.attached.snapshots.at(-1)).toMatchObject({ visibility: 'public', featured: false });
  const hidden = await running(base, { ...PUBLIC_PLAY, visibility: 'private' });
  // A negative: nothing signals "the relay skipped them", so let a few of its one-second pumps pass.
  await pause(2500);
  expect((await featured(base)).upcoming?.roomId).toBe(featuredOn.roomId);
  expect([optedOut.roomId, hidden.roomId]).not.toContain((await featured(base)).upcoming?.roomId);
  // A newer eligible game takes over the pick (the newest is featured).
  const newer = await running(base, PUBLIC_PLAY);
  await waitFor(async () => (await featured(base)).upcoming?.roomId === newer.roomId);
  // The upcoming notice names the game by what the public lobby shows: its display names and bot levels.
  const watcher = new Stream(base, 'all');
  const notice = await waitFor(() => watcher.events.find((entry) => entry.event === 'upcoming')?.data as { roomId: string; label: string; liveInMs: number } | undefined);
  expect(notice).toMatchObject({ roomId: newer.roomId, label: expect.stringMatching(/^Player 1 vs Standard bot · /) });
  expect(notice.liveInMs).toBeGreaterThan(PUBLIC_OBSERVER_DELAY_MS - 30_000);
  // Meanwhile the bot playlist stays on air.
  expect((await featured(base)).onAir).toMatchObject({ public: false });
});

it('includes rated matches: per-army views only, at the public delay', { timeout: 120_000 }, async () => {
  ranked = await startRanked({ readyMs: 20_000 }, { featuredMatch: true, featuredPlaylist: false });
  const r = ranked;
  const a = await linkedProfile(r, 5001, '10.50.1.1');
  const b = await linkedProfile(r, 5002, '10.51.1.1');
  const [ca, cb] = [await policyCommander(r, a.secret, 'A'), await policyCommander(r, b.secret, 'B')];
  for (const [profile, commander, ip] of [[a, ca, '10.50.1.1'], [b, cb, '10.51.1.1']] as const) {
    const joined = await fetch(`${r.base}/api/queue`, { method: 'POST', headers: headers(profile.secret, ip), body: JSON.stringify({ pool: 'policy_1v1', lineup: fullLineup(commander) }) });
    expect(joined.status).toBe(200);
  }
  const playing = await waitFor(async () => {
    const status = await json<{ match: { state: string; roomId: string | null } | null }>(await fetch(`${r.base}/api/queue`, { headers: headers(a.secret, '10.50.1.1') }));
    return status.match?.state === 'playing' && status.match.roomId;
  }, 60_000);
  const [game] = r.server.ranked.matchmaker!.featuredGames();
  expect(game).toMatchObject({ roomId: playing, omniscient: false, delayMs: PUBLIC_OBSERVER_DELAY_MS, armies: ['nw', 'se'], label: expect.stringMatching(/^Ranked · AI Player vs AI Player · /) });
  expect(game!.played(a.id)).toHaveLength(1);
  expect(game!.played('someone else')).toBeUndefined();
  await waitFor(async () => (await featured(r.base, { headers: headers() })).upcoming?.roomId === playing);
});

it('relays a human game as its delayed public projection (fog twin check), and a player of it gets only its own side', { timeout: 120_000 }, async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const t0 = Date.now();
  const running0 = await start({ featuredMatch: true, featuredPlaylist: false, lobbyCountdownMs: 0, devAdminToken: ADMIN });
  server = running0.server;
  const { base } = running0;
  const game = await running(base, PUBLIC_PLAY);
  const match = server.host.authenticate(game.token)!.match;
  await waitFor(async () => (await featured(base)).upcoming?.roomId === game.roomId);
  const all = new Stream(base, 'all');
  const blue = new Stream(base, 'nw');
  // Some ticks recorded at t0 (the sim runs on its own timers; only `Date` is moved here).
  const before = match.tick;
  await waitFor(() => match.tick >= before + 20);
  const t1 = t0 + 10_000;
  vi.setSystemTime(t1);
  const cheat = await fetch(`${base}/dev/matches/${game.roomId}/cheat`, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'spawn', army: 'se', kind: 'tank', x: 24, y: 24, count: 3 }),
  });
  expect(cheat.status).toBe(200);
  const { simIds } = await json<{ simIds: string[] }>(cheat);
  const spawnedAt = match.tick;
  await waitFor(() => match.tick >= spawnedAt + 20);
  const shows = (world: unknown) => simIds.filter((id) => JSON.stringify(world).includes(`"${id}"`)).length;

  // Past t0's delay, before t1's: the relay cuts over to the public game at its first released frame.
  vi.setSystemTime(t0 + PUBLIC_OBSERVER_DELAY_MS + 1000);
  await waitFor(() => all.state(game.roomId));
  expect(all.announced(game.roomId)).toMatchObject({ public: true, delayMs: PUBLIC_OBSERVER_DELAY_MS, omniscient: true, armies: ['nw', 'se'] });
  expect((await featured(base)).onAir).toEqual({ roomId: game.roomId, public: true });
  for (const frame of [...all.frames(game.roomId), ...blue.frames(game.roomId)]) {
    expect(frame.releaseAt - frame.recordedAt).toBe(PUBLIC_OBSERVER_DELAY_MS);
    expect(frame.recordedAt).toBeLessThan(t1);
  }
  // What the relay serves is exactly what the match's public observer policy gives anyone at that delay.
  const relayed = all.state(game.roomId)!;
  const projection = await (async () => { for await (const frame of match.observerFrames({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: PUBLIC_OBSERVER_DELAY_MS })) return frame; })();
  expect(projection!.sequence).toBe(relayed.sequence);
  expect(relayed.world).toEqual(projection!.world);
  // Twin check: the live sim has had the tanks for 171 s; nothing relayed shows them.
  expect(shows(relayed.world)).toBe(0);
  expect(shows(all.events)).toBe(0);
  expect(shows(blue.events)).toBe(0);

  // A player of the game (its lobby credential) is announced only its own side and never gets All.
  const player = new Stream(base, 'all', game.attached.authorization);
  const own = new Stream(base, 'nw', game.attached.authorization);
  await waitFor(() => player.announced(game.roomId) && own.state(game.roomId));
  expect(player.announced(game.roomId)).toMatchObject({ armies: ['nw'], omniscient: false, played: true });

  // Past t1's delay the tanks reach the relayed All stream, still exactly the public projection.
  vi.setSystemTime(t1 + PUBLIC_OBSERVER_DELAY_MS + 1000);
  await waitFor(() => shows(all.state(game.roomId)!.world) === simIds.length);
  expect(player.frames(game.roomId)).toEqual([]);
  expect(own.frames(game.roomId).every((frame) => frame.perspective === 'nw')).toBe(true);
});
