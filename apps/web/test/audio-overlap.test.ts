// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { Plane } from '@agent-command/game/contract';
import { SEGMENTS, loopOf } from '../src/audio/catalog.ts';
import { AudioEngine } from '../src/audio/engine.ts';
import { MusicDeck, TRACKS, battleTrack } from '../src/audio/music.ts';
import { resetAudioMixCache } from '../src/audio/settings.ts';
import { fakeBuffer, fakeContext, fakeListener } from './audio-fake.ts';

afterEach(() => {
  localStorage.clear();
  resetAudioMixCache();
});

/** A music track whose gain is above this (about -34 dB under a full bed) counts as heard. */
const HEARD = 0.02;
/** The longest music fade-out (the battle layer ending), plus two frames. */
const LONGEST_FADE_S = 2.5 + 0.1;

/**
 * An engine on a fake context whose gains follow their automation and whose decodes finish `decodeS` seconds of
 * audio-clock time after they were requested, driven in 50 ms frames (the rAF loop and the housekeeping tick).
 */
function rig(beds: Record<Plane, number>, decodeS: number) {
  localStorage.setItem('agent-command.music', JSON.stringify({ mode: 'auto', beds }));
  const listener = fakeListener();
  const pending: { at: number; done: () => void }[] = [];
  const fetcher = async (input: RequestInfo | URL) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(String(input)).buffer });
  const e = new AudioEngine(listener, fetcher as unknown as typeof fetch, new MusicDeck());
  const fake = fakeContext(async (bytes) => {
    const url = new TextDecoder().decode(bytes);
    const { promise, resolve } = Promise.withResolvers<void>();
    pending.push({ at: fake.clock.currentTime + decodeS, done: resolve });
    await promise;
    // scheduling follows the catalog's segment frames, not buffer lengths: keep the stand-ins' samples small
    return Object.assign(fakeBuffer(1), { url });
  });
  e.start(() => fake.ctx);
  const clock = fake.clock as { currentTime: number };
  let ms = 1000;
  const run = async (seconds: number, each: (t: number) => void): Promise<void> => {
    for (let i = 0; i < seconds * 20; i++) {
      clock.currentTime += 0.05;
      e.frame((ms += 50));
      for (let j = pending.length - 1; j >= 0; j--) {
        if (pending[j]!.at > clock.currentTime) continue;
        pending[j]!.done();
        pending.splice(j, 1);
      }
      // fetches and finished decodes settle through promise chains (and the engine's callbacks): let them run
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
      each(clock.currentTime);
    }
  };
  /** Music sources playing now, by track id, with their track gain now. */
  const sources = (): { id: string; gain: number }[] => {
    const t = clock.currentTime;
    const out: { id: string; gain: number }[] = [];
    for (const s of fake.starts) {
      const url = (s.buffer as AudioBuffer & { url: string }).url;
      if (!url.includes('/music/') || s.when > t || s.src.stop.mock.calls.length || s.src.disconnect.mock.calls.length) continue;
      if (!s.src.loop && s.when + (s.duration ?? s.buffer.duration) <= t) continue;
      const file = /\/music\/([^/.?]+)\.ogg/.exec(url)![1]!;
      const id = TRACKS.find((track) => file === track || (SEGMENTS[`music/${track}`] && file.startsWith(`${track}_`))) ?? file;
      out.push({ id, gain: (s.src.connect.mock.calls[0]![0] as { gain: { at: (t: number) => number } }).gain.at(t) });
    }
    return out;
  };
  const heard = (): string[] => [...new Set(sources().filter((s) => s.gain > HEARD).map((s) => s.id))].sort();
  return { e, listener, run, heard, sources, starts: fake.starts };
}

describe('music under the observer director', () => {
  it('rapid plane cuts, streamed beds still decoding and a battle rotation never stack faded-out tracks', async () => {
    // streamed beds on three planes (variations 4..7), slow decodes so cuts land while segments load
    const { e, listener, run, heard, sources } = rig({ orbit: 3, sky: 4, surface: 5, depths: 0 }, 1.5);
    /** Audio-clock time each music track was last wanted (a target above 0), and how long each was heard after. */
    const wanted = new Map<string, number>();
    const lingered = new Map<string, number>();
    const check = (t: number): void => {
      for (const m of e.stats.music) if (m.target > 0) wanted.set(m.id, t);
      for (const id of heard()) lingered.set(id, Math.max(lingered.get(id) ?? 0, t - (wanted.get(id) ?? -Infinity)));
      // one source per track at a time (a streamed track's segments play back to back)
      const ids = sources().map((s) => s.id);
      expect(ids.length, `sources at ${t.toFixed(2)} s: ${ids.join(', ')}`).toBe(new Set(ids).size);
    };
    const cuts = async (plan: readonly (readonly [Plane, number])[]): Promise<void> => {
      for (const [plane, s] of plan) {
        listener.plane = plane;
        await run(s, check);
      }
    };
    e.setScene('match');
    e.battleSeed(42);
    await cuts([['surface', 3]]);
    e.combat(100);
    // the director cuts around the fight: surface -> orbit -> sky -> surface within a few seconds, mid-fade
    await cuts([['orbit', 0.6], ['sky', 1.2], ['surface', 0.8], ['depths', 2], ['orbit', 0.4], ['surface', 3]]);
    // the battle ends and stays quiet past the gap; the next fight brings the next battle track
    await cuts([['sky', 4], ['surface', 26]]);
    e.combat(100);
    await cuts([['depths', 0.5], ['orbit', 1.5], ['sky', 0.7], ['surface', 2]]);
    expect(e.current).toBe(battleTrack(42, 1));
    await run(30, check);
    expect(heard()).toEqual(['bed_surface_6']);
    // a track the engine stopped wanting is silent once its fade-out is over: no tails stacking under the next cuts
    const longest = Math.max(...lingered.values());
    expect(longest, `seconds heard after last wanted: ${JSON.stringify(Object.fromEntries(lingered))}`).toBeLessThanOrEqual(LONGEST_FADE_S);
  });
});

describe('streamed loops', () => {
  it('an odd number of segments loops back to back: no segment is cut short at the wrap', async () => {
    // War Room I: three segments (the last one shorter), pinned so it loops instead of handing over
    expect(SEGMENTS['music/lobby1']).toHaveLength(3);
    const { e, run, starts } = rig({ orbit: 0, sky: 0, surface: 0, depths: 0 }, 0.2);
    e.setScene('lobby');
    e.pin('lobby1');
    const segments = () => starts.filter((s) => (s.buffer as AudioBuffer & { url: string }).url.includes('/lobby1_'));
    const pass = loopOf('music/lobby1')!.end - loopOf('music/lobby1')!.start;
    await run(2 * pass + 10, (t) => {
      // a source disconnected (or stopped) before its segment's end cuts the music short
      for (const s of segments()) {
        if (!s.src.disconnect.mock.calls.length && !s.src.stop.mock.calls.length) continue;
        expect(t, `${(s.buffer as AudioBuffer & { url: string }).url} ended early`).toBeGreaterThanOrEqual(s.when + s.duration! - 1e-9);
      }
    });
    const played = segments();
    // looped twice: 1 2 3 1 2 3 1, each segment starting where the previous one ends
    expect(played.map((s) => /lobby1_(\d)/.exec((s.buffer as AudioBuffer & { url: string }).url)![1]).join('')).toMatch(/^1231231/);
    for (let i = 1; i < played.length; i++) expect(played[i]!.when).toBeCloseTo(played[i - 1]!.when + played[i - 1]!.duration!, 6);
  });
});
