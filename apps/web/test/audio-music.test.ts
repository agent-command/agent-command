// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { LOOP_PAD, SEGMENTS, STINGS, loopOf } from '../src/audio/catalog.ts';
import { AudioEngine } from '../src/audio/engine.ts';
import { GROUP_TRACKS, MusicDeck, TRACKS, battleTrack, stingFor, trackPlace } from '../src/audio/music.ts';
import { audioMix, resetAudioMixCache, setAudioMix } from '../src/audio/settings.ts';
import { fakeBuffer, fakeContext, fakeListener } from './audio-fake.ts';

afterEach(() => {
  localStorage.clear();
  resetAudioMixCache();
});

/**
 * An engine on a fake context: each file decodes to a buffer tagged with its URL (`.url`), long enough for any loop
 * (or a 45 s streamed segment), so tests can see what started where.
 */
function engine(deck = new MusicDeck(), level = 0, waitFor?: (url: string) => Promise<void>) {
  const listener = fakeListener();
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => new Response(new TextEncoder().encode(String(input)));
  const e = new AudioEngine(listener, fetcher as typeof fetch, deck);
  const fake = fakeContext(async (bytes) => {
    const url = new TextDecoder().decode(bytes);
    await waitFor?.(url);
    return Object.assign(fakeBuffer(/\/home\d_/.test(url) ? 45 : 95), { url });
  }, level);
  e.start(() => fake.ctx);
  const clock = fake.clock as { currentTime: number };
  const started = (name: string) => fake.starts.filter((s) => (s.buffer as AudioBuffer & { url: string }).url.includes(name));
  /** Run frames of 250 ms (the engine's dt cap) for `seconds`, advancing the audio clock alongside. */
  let t = 1000;
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * 4; i++) {
      clock.currentTime += 0.25;
      e.frame((t += 250));
    }
  };
  return { e, deck, listener, clock, started, run };
}
/** Let pending fetch/decode promises settle. */
const settle = async (e: AudioEngine, ...files: string[]): Promise<void> => {
  await Promise.all(files.map((f) => e.load(f)));
};

describe('music deck', () => {
  it('defaults to Auto, first variation everywhere, Home II, playing', () => {
    expect(new MusicDeck().state).toEqual({ mode: 'auto', beds: { orbit: 0, sky: 0, surface: 0, depths: 0 }, track: 'home2', group: null, paused: false });
  });

  it('Auto at home starts on Home II each session; a returning player\'s Manual pick still wins', () => {
    const a = new MusicDeck();
    expect(a.cue('home', 'surface')).toBe('home2');
    a.next(1, 'home', 'surface');
    expect(a.cue('home', 'surface')).toBe('home1');
    expect(new MusicDeck().cue('home', 'surface')).toBe('home2'); // the Auto turn is not stored
    a.pin('home1');
    expect(new MusicDeck().cue('home', 'surface')).toBe('home1');
    const b = new MusicDeck();
    b.setMode('auto');
    b.playGroup('home');
    expect(b.state.track).toBe('home1'); // the pinned track belongs to the group: the playlist continues from it
    localStorage.clear();
    const c = new MusicDeck();
    c.playGroup('home');
    expect(c.state.track).toBe('home2'); // a fresh Home playlist starts on the default
  });

  it('lists Home I and II, War Room I and II, seven beds per plane and seven battle tracks, grouped', () => {
    expect(TRACKS).toHaveLength(39);
    expect(trackPlace('bed_surface_2')).toEqual({ group: 'surface', n: 2, of: 7 });
    expect(trackPlace('bed_orbit_7')).toEqual({ group: 'orbit', n: 7, of: 7 });
    expect(trackPlace('bed_sky_7')).toEqual({ group: 'sky', n: 7, of: 7 });
    expect(trackPlace('bed_depths_7')).toEqual({ group: 'depths', n: 7, of: 7 });
    expect(trackPlace('battle_3')).toEqual({ group: 'battle', n: 3, of: 7 });
    expect(trackPlace('home2')).toEqual({ group: 'home', n: 2, of: 2 });
    expect(trackPlace('lobby2')).toEqual({ group: 'lobby', n: 2, of: 2 });
  });

  it('persists mode, per-plane bed choices, pinned track or group, and pause', () => {
    const a = new MusicDeck();
    a.stepBed('surface', 1);
    a.stepBed('depths', -1);
    a.playGroup('sky');
    a.pause();
    expect(new MusicDeck().state).toEqual({ mode: 'manual', beds: { orbit: 0, sky: 0, surface: 1, depths: 6 }, track: 'bed_sky_1', group: 'sky', paused: true });
    localStorage.setItem('agent-command.music', '{broken');
    expect(new MusicDeck().state.mode).toBe('auto');
  });

  it('next/prev: Auto steps the home themes at home and the focused plane\'s beds in a match; Manual steps its group or the list', () => {
    const d = new MusicDeck();
    expect(d.cue('home', 'surface')).toBe('home2');
    d.next(1, 'home', 'surface');
    expect(d.cue('home', 'surface')).toBe('home1');
    expect(d.state.beds.surface).toBe(0);
    d.next(1, 'home', 'surface');
    expect(d.cue('home', 'surface')).toBe('home2');
    expect(d.cue('lobby', 'surface')).toBe('lobby1');
    d.next(1, 'lobby', 'surface');
    expect(d.cue('lobby', 'surface')).toBe('lobby2');
    expect(d.cue('home', 'surface')).toBe('home2');
    d.next(1, 'match', 'surface');
    expect(d.cue('match', 'surface')).toBe('bed_surface_2');
    d.next(-1, 'match', 'surface');
    d.next(-1, 'match', 'surface');
    expect(d.cue('match', 'surface')).toBe('bed_surface_7');
    d.playGroup('battle');
    for (let i = 0; i < 7; i++) d.next(1, 'match', 'surface');
    expect(d.state.track).toBe('battle_1');
    d.pin('bed_depths_7');
    d.next(1, 'home', 'surface');
    expect(d.state.track).toBe('battle_1'); // the whole list wraps from the last bed into Battle
  });
});

describe('match-end stings', () => {
  it('pick one take per result, deterministic per match, from the original stinger and both new takes', () => {
    for (const r of ['win', 'loss'] as const) {
      const picks = new Set(Array.from({ length: 64 }, (_, seed) => stingFor(seed, r)));
      expect([...picks].sort()).toEqual([...STINGS[r]].sort());
      expect(stingFor(1234, r)).toBe(stingFor(1234, r));
    }
  });

  it('the engine plays the match\'s sting on the outcome', async () => {
    const { e } = engine();
    e.setScene('match');
    e.battleSeed(99);
    e.outcome('win');
    await settle(e, `music/${stingFor(99, 'win')}`);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(e.stats.sting).toBe(stingFor(99, 'win'));
  });
});

describe('battle rotation', () => {
  it('is deterministic per match and never repeats a track back to back', () => {
    for (const seed of [1, 42, 0xdeadbeef]) {
      const seq = Array.from({ length: 60 }, (_, k) => battleTrack(seed, k));
      expect(seq).toEqual(Array.from({ length: 60 }, (_, k) => battleTrack(seed, k)));
      for (let k = 1; k < seq.length; k++) expect(seq[k]).not.toBe(seq[k - 1]);
      expect(new Set(seq).size).toBe(7);
    }
    expect(Array.from({ length: 8 }, (_, k) => battleTrack(1, k))).not.toEqual(Array.from({ length: 8 }, (_, k) => battleTrack(42, k)));
  });
});

describe('engine music', () => {
  it('Auto follows the scene and the focused plane\'s remembered bed variation', async () => {
    const { e, deck, listener } = engine();
    e.setScene('home');
    expect(e.current).toBe('home2');
    e.setScene('match');
    listener.plane = 'surface';
    e.frame(1000);
    expect(e.current).toBe('bed_surface_1');
    e.next();
    e.frame(1016);
    expect(e.current).toBe('bed_surface_2');
    listener.plane = 'sky';
    e.frame(1032);
    expect(e.current).toBe('bed_sky_1');
    listener.plane = 'surface';
    e.frame(1048);
    expect(e.current).toBe('bed_surface_2');
    expect(deck.state.beds.surface).toBe(1);
  });

  it('finishes both the lobby fade and an older home fade on the audio clock before early plane changes', async () => {
    const { e, listener, clock, started } = engine();
    e.setScene('home');
    await settle(e, 'music/home2_1');
    const home = started('/home2_1')[0]!.src.connect.mock.calls[0]![0] as GainNode;
    clock.currentTime = 3;
    e.setScene('lobby');
    await settle(e, 'music/lobby1_1');
    const lobby = started('/lobby1_1')[0]!.src.connect.mock.calls[0]![0] as GainNode;
    clock.currentTime = 3.2;
    listener.plane = 'orbit';
    e.setScene('match');
    // each menu track fades to silence on the audio clock from the moment the scene left it
    expect(home.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 3 + 1.1 * 1.6);
    expect(lobby.gain.cancelAndHoldAtTime).toHaveBeenLastCalledWith(3.2);
    // anchored at its level then (Chromium would start a ramp after a held setTarget from 0: a hard cut)
    expect(lobby.gain.setValueAtTime).toHaveBeenLastCalledWith(expect.closeTo(0.8 * (1 - Math.exp(-0.2 / 1.1)), 6), 3.2);
    expect(lobby.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 3.2 + 1.1 * 1.6);
    // The timer/RAF can stall or the camera can keep changing: neither may extend the menu fade.
    listener.plane = 'depths';
    clock.currentTime = 6;
    e.frame(1000);
    listener.plane = 'sky';
    e.frame(1250);
    for (const node of [home, lobby]) expect(node.gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1);
  });

  it('cancels the Auto menu fade endpoint when Manual pins that song during the handoff', async () => {
    const { e, clock, started } = engine();
    e.setScene('home');
    await settle(e, 'music/home2_1');
    const home = started('/home2_1')[0]!.src.connect.mock.calls[0]![0] as GainNode;
    clock.currentTime = 3;
    e.setScene('match');
    clock.currentTime = 3.3;
    e.pin('home2');
    e.frame(1000);
    expect(e.current).toBe('home2');
    expect(home.gain.cancelAndHoldAtTime).toHaveBeenLastCalledWith(3.3);
    expect(home.gain.setTargetAtTime).toHaveBeenLastCalledWith(expect.any(Number), 3.3, 1.1);
    expect(started('/home2_1')).toHaveLength(1);
  });

  it('does not start a menu source when its decode completes after match entry and rapid plane changes', async () => {
    const pending = Promise.withResolvers<void>();
    const { e, listener, clock, started } = engine(new MusicDeck(), 0, async (url) => {
      if (url.includes('/home2_1')) await pending.promise;
    });
    e.setScene('home');
    clock.currentTime = 1;
    e.setScene('lobby');
    await settle(e, 'music/lobby1_1');
    clock.currentTime = 2;
    e.setScene('match');
    listener.plane = 'orbit';
    e.frame(1000);
    listener.plane = 'depths';
    e.frame(1250);
    pending.resolve();
    await settle(e, 'music/home2_1');
    expect(started('/home2_1')).toEqual([]);
    expect(e.current).toBe('bed_depths_1');
    // Returning home remains legitimate; the prior cancellation must not poison the next visit.
    e.setScene('home');
    expect(started('/home2_1')).toHaveLength(1);
    expect(e.current).toBe('home2');
  });

  it('rotates the plane\'s bed after each full pass and remembers it', async () => {
    const { e, deck, listener, run } = engine();
    e.setScene('match');
    listener.plane = 'orbit';
    e.frame(1000);
    await settle(e, 'music/bed_orbit_1');
    const pass = loopOf('music/bed_orbit_1')!;
    run(pass.end - pass.start + 1);
    expect(deck.state.beds.orbit).toBe(1);
    expect(e.current).toBe('bed_orbit_2');
  });

  it('the battle layer takes over near fights, one rotating battle track per battle, then returns to the bed', async () => {
    const { e, listener, run } = engine();
    e.setScene('match');
    e.battleSeed(42);
    listener.plane = 'depths';
    e.frame(1000);
    e.combat(100);
    run(0.25);
    expect(e.current).toBe(battleTrack(42, 0));
    run(40); // heat decays, the battle ends and stays quiet past the gap
    expect(e.current).toBe('bed_depths_1');
    e.combat(100);
    run(0.25);
    expect(e.current).toBe(battleTrack(42, 1));
    expect(battleTrack(42, 1)).not.toBe(battleTrack(42, 0));
  });

  it('Manual pins a track or plays a group, ignoring plane switches and battles', async () => {
    const { e, deck, listener, run } = engine();
    e.setScene('match');
    e.pin('bed_depths_3');
    e.frame(1000);
    listener.plane = 'orbit';
    e.combat(100);
    e.frame(1016);
    expect(e.current).toBe('bed_depths_3');
    e.playGroup('battle');
    e.frame(1032);
    expect(e.current).toBe('battle_1');
    await settle(e, 'music/battle_1');
    const pass = loopOf('music/battle_1')!;
    run(pass.end - pass.start + 1);
    expect(deck.state.track).toBe('battle_2');
    expect(e.current).toBe('battle_2');
    e.setMode('auto');
    run(0.25);
    expect(e.current).not.toBe('battle_2');
  });

  it('the lobby and Create Game play the two War Room tracks in turn', async () => {
    const { e, run } = engine();
    e.setScene('lobby');
    expect(e.current).toBe('lobby1');
    await settle(e, 'music/lobby1_1');
    e.frame(1000);
    const pass = loopOf('music/lobby1')!;
    run(pass.end - pass.start - 20);
    await settle(e, 'music/lobby2_1');
    run(18);
    expect(e.current).toBe('lobby2');
  });

  it('at home plays Home II, then hands over to Home I at the end of its pass (and back)', async () => {
    const { e, run, started } = engine();
    e.setScene('home');
    expect(e.current).toBe('home2');
    await settle(e, 'music/home2_1');
    e.frame(1000);
    const pass = loopOf('music/home2')!;
    run(pass.end - pass.start - 20);
    await settle(e, 'music/home1_1'); // preloaded ahead of the handover
    run(18);
    expect(e.current).toBe('home1');
    run(1);
    expect(started('/home1_1')).toHaveLength(1);
  });

  it('streams a home theme segment by segment, back to back on the audio clock', async () => {
    const { e, clock, started } = engine();
    e.setScene('home');
    await settle(e, 'music/home2_1');
    e.frame(1000);
    const frames = SEGMENTS['music/home2']!;
    const first = started('/home2_1')[0]!;
    expect(first.offset).toBeCloseTo(LOOP_PAD / 48000, 6);
    expect(first.duration).toBeCloseTo(frames[0]! / 48000, 6);
    // near the end of segment 1, segment 2 is fetched, decoded and scheduled exactly where segment 1 ends
    clock.currentTime = first.when + frames[0]! / 48000 - 5;
    e.frame(1100);
    await settle(e, 'music/home2_2');
    clock.currentTime += 3.5;
    e.frame(1200);
    const second = started('/home2_2')[0]!;
    expect(second.when).toBeCloseTo(first.when + frames[0]! / 48000, 6);
    expect(started('/home2_3')).toEqual([]);
  });

  it('pause keeps the cued track; the meter reads the music bus', async () => {
    const { e, deck } = engine(new MusicDeck(), 0.1);
    e.setScene('home');
    e.pause();
    e.frame(1000);
    expect(deck.state.paused).toBe(true);
    expect(e.current).toBe('home2');
    e.play();
    e.frame(1016);
    expect(e.musicLevel()).toBeCloseTo(0.4, 5);
  });

  it('music mute and volume share the persisted mix', () => {
    setAudioMix({ music: 0.3, musicMuted: true });
    resetAudioMixCache();
    expect(audioMix()).toMatchObject({ music: 0.3, musicMuted: true });
  });
});

describe('close-zoom activity loops', () => {
  it('fade in up close, are silent from where unit dots begin, and only in matches', async () => {
    const { e, listener, started } = engine(new MusicDeck());
    e.setScene('match');
    listener.dist = 60;
    e.activity('treads', 1, 0.8, 0.4);
    e.frame(1000);
    await settle(e, 'sfx/treads_loop');
    e.frame(1016);
    expect(started('treads_loop')).toEqual([]);
    listener.dist = 30;
    e.frame(1032);
    await settle(e, 'sfx/treads_loop');
    e.frame(1048);
    expect(started('treads_loop')).toHaveLength(1);
  });

  it('use a fixed pool of two voices per category', () => {
    for (const g of Object.values(GROUP_TRACKS)) expect(g.length).toBeGreaterThan(0);
    const { e, listener, started } = engine(new MusicDeck());
    e.setScene('match');
    listener.dist = 20;
    for (let i = 0; i < 50; i++) e.activity('drill', i % 2, 1, 0);
    e.frame(1000);
    return settle(e, 'sfx/drill_loop').then(() => {
      e.frame(1016);
      expect(started('drill_loop').length).toBeLessThanOrEqual(2);
    });
  });
});
