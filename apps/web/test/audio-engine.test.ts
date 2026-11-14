// @vitest-environment happy-dom
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY, AMBIENCE_IDS, INITIAL_FILES, MUSIC_IDS, SEGMENTS, SFX_IDS, loopOf, segmentFile, soundUrl, type SoundKey } from '../src/audio/catalog.ts';
import { AudioEngine, healLoopSeam, healSegmentJoin } from '../src/audio/engine.ts';
import { TRACKS } from '../src/audio/music.ts';
import { fakeBuffer, fakeContext, fakeListener } from './audio-fake.ts';
import { MusicDeck } from '../src/audio/music.ts';
import { followRig } from '../src/audio/director.ts';
import type { Plane } from '@agent-command/game/contract';
import { DEFAULT_MIX, audioMix, resetAudioMixCache, setAudioMix } from '../src/audio/settings.ts';

const ASSETS = resolve(import.meta.dirname, '../assets/audio');
const KEYS: SoundKey[] = [...MUSIC_IDS.map((id) => `music/${id}` as const), ...SFX_IDS.map((id) => `sfx/${id}` as const)];
/** Shipped files: one per sound, a streamed (segmented) sound as its segment files. */
const FILES = KEYS.flatMap((key) => SEGMENTS[key]?.map((_, i) => segmentFile(key, i)) ?? [key]);

const listener = fakeListener;

afterEach(() => {
  localStorage.clear();
  resetAudioMixCache();
});

// The game also ships and runs without the (separately licensed) audio directory; then there is nothing to check.
describe.skipIf(!existsSync(ASSETS))('audio assets', () => {
  it('ships a file for every catalog sound (no voices), loop points for every loop, and nothing unlisted', () => {
    for (const file of FILES) expect(soundUrl(file), file).toBeTypeOf('string');
    for (const id of AMBIENCE_IDS) expect(loopOf(`sfx/${id}`), id).toBeDefined();
    for (const a of Object.values(ACTIVITY)) expect(loopOf(`sfx/${a.loop}`), a.loop).toBeDefined();
    for (const id of TRACKS) expect(loopOf(`music/${id}`), id).toBeDefined();
    expect(loopOf('music/victory')).toBeUndefined();
    expect(existsSync(resolve(ASSETS, 'voice'))).toBe(false);
    const files = readdirSync(ASSETS, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ogg')).map((f) => f.slice(0, -4).replaceAll('\\', '/'));
    expect(files.sort()).toEqual([...FILES].sort());
  });

  it('has seven beds per plane, seven battle tracks, two lobby tracks and three stinger takes per result', () => {
    const beds = (p: string) => MUSIC_IDS.filter((id) => id.startsWith(`bed_${p}_`)).length;
    expect([beds('orbit'), beds('sky'), beds('surface'), beds('depths')]).toEqual([7, 7, 7, 7]);
    expect(MUSIC_IDS.filter((id) => id.startsWith('battle_'))).toHaveLength(7);
    expect(MUSIC_IDS.filter((id) => id.startsWith('lobby'))).toEqual(['lobby1', 'lobby2']);
    expect(MUSIC_IDS.filter((id) => id.startsWith('sting_'))).toHaveLength(4);
  });

  it('streams Home I and Home II (the old home theme is gone) in segments; the initial download stays within 1.5 MB', () => {
    expect(MUSIC_IDS.filter((id) => id.startsWith('home'))).toEqual(['home1', 'home2']);
    for (const id of ['home1', 'home2'] as const) {
      const home = loopOf(`music/${id}`)!;
      expect(home.end - home.start).toBeGreaterThan(6 * 60);
      expect(SEGMENTS[`music/${id}`]!.length).toBeGreaterThan(1);
    }
    expect(INITIAL_FILES).toContain('music/home2_1'); // Home II is the default home theme
    const bytes = INITIAL_FILES.reduce((sum, file) => sum + statSync(resolve(ASSETS, `${file}.ogg`)).size, 0);
    expect(bytes).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});

describe('audio engine', () => {
  it('protects the summed output with a fast safety compressor', () => {
    const engine = new AudioEngine(listener(), vi.fn(async () => new Response(null, { status: 404 })));
    const { ctx, compressor } = fakeContext(async () => fakeBuffer(1));
    engine.start(() => ctx);
    expect(compressor.threshold.value).toBe(-3);
    expect(compressor.knee.value).toBe(0);
    expect(compressor.ratio.value).toBe(20);
    expect(compressor.attack.value).toBe(0.002);
    expect(compressor.release.value).toBe(0.12);
    expect(compressor.connect).toHaveBeenCalledWith(ctx.destination);
  });

  it('makes a decoded loop seamless across its loop points', () => {
    const d = new Float32Array(10_000);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * 0.37) + (i >= 9000 ? 0.5 : 0); // a step error at the seam
    healLoopSeam([d], 2400, 9000);
    // the sample before the loop end now continues into the pre-roll before loop start
    expect(Math.abs(d[8999]! - d[2399]!)).toBeLessThan(1e-6);
  });

  it('joins streamed segments seamlessly: the next segment starts from the previous one\'s post-roll', () => {
    const prev = new Float32Array(6000).map((_, i) => Math.sin(i * 0.05));
    const next = new Float32Array(6000).map((_, i) => Math.sin((i + 2600) * 0.05) + 0.3); // same music, offset decode error
    healSegmentJoin([prev], 3000, [next], 400);
    expect(Math.abs(next[400]! - prev[3000]!)).toBeLessThan(0.01);
    expect(Math.abs(next[400 + 1023]! - (Math.sin((1423 + 2600) * 0.05) + 0.3))).toBeLessThan(1e-6);
  });

  it('stays silent and error-free when audio files are missing', async () => {
    const engine = new AudioEngine(listener(), vi.fn(async () => new Response(null, { status: 404 })));
    const decode = vi.fn(async () => { throw new Error('never decoded'); });
    const { ctx, started } = fakeContext(decode);
    engine.setScene('match');
    expect(engine.start(() => ctx)).toBe(true);
    for (let i = 0; i < 3; i++) {
      engine.sfx('w_cannon', 'surface', 24, 24, 0);
      engine.alert('base_under_attack');
      engine.loop('wind_loop', 0.5);
      engine.activity('treads', 0, 0.8, 0.2);
      engine.frame(1000 + i * 16);
      // await the loads the calls above started (all resolve undefined: 404)
      expect(await Promise.all([engine.load('sfx/w_cannon'), engine.load('sfx/alert'), engine.load('sfx/wind_loop'), engine.load('sfx/treads_loop')])).toEqual([undefined, undefined, undefined, undefined]);
    }
    expect(decode).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it('plays effects once loaded and positions other planes on the muffled bus', async () => {
    const buffer = fakeBuffer(0.5);
    const silentMusic = new MusicDeck();
    silentMusic.pause();
    const engine = new AudioEngine(listener(), vi.fn(async () => new Response(new ArrayBuffer(8))), silentMusic);
    const { ctx, started } = fakeContext(async () => buffer);
    engine.setScene('match');
    engine.start(() => ctx);
    await engine.load('sfx/w_cannon');
    engine.sfx('w_cannon', 'surface', 24, 24, 0);
    engine.sfx('w_cannon', 'depths', 24, 24, 0);
    expect(started.length).toBe(1); // second start inside the per-sound gap is dropped
    expect(engine.state).toBe('running');
  });
});

describe('dive music', () => {
  it('crosses Sky and Surface on an Orbit-to-Depths dive with one bed change, straight to the Depths', () => {
    const deck = new MusicDeck();
    const beds: Plane[] = [];
    const cue = deck.cue.bind(deck);
    vi.spyOn(deck, 'cue').mockImplementation((where, focus) => { if (beds.at(-1) !== focus) beds.push(focus); return cue(where, focus); });
    const l = listener();
    const rig = { focus: 'orbit' as Plane, diving: false };
    followRig(l, rig);
    const engine = new AudioEngine(l, vi.fn(async () => new Response(null, { status: 404 })), deck);
    const { ctx } = fakeContext(async () => fakeBuffer(1));
    engine.setScene('match');
    engine.start(() => ctx);
    let now = 1000;
    const step = (): void => { followRig(l, rig); engine.frame(now += 16); };
    step();
    // one dive whose destination steps through the planes on the way down (chained dive keys retarget it)
    rig.diving = true;
    for (const p of ['sky', 'surface', 'depths'] as const) {
      rig.focus = p;
      for (let i = 0; i < 20; i++) step();
      expect(l.plane).toBe('orbit'); // the old plane is in view until the dive lands
    }
    rig.diving = false;
    step();
    step();
    expect(beds).toEqual(['orbit', 'depths']);
  });
});

describe('audio settings', () => {
  it('persists volumes and mute in this browser, clamped to 0..1 (no voice channel)', () => {
    expect(audioMix()).toEqual(DEFAULT_MIX);
    expect(Object.keys(DEFAULT_MIX)).not.toContain('voice');
    setAudioMix({ music: 0.25, sfx: 3, muted: true });
    resetAudioMixCache();
    expect(audioMix()).toMatchObject({ music: 0.25, sfx: 1, muted: true, master: DEFAULT_MIX.master });
    localStorage.setItem('agent-command.audio', '{not json');
    resetAudioMixCache();
    expect(audioMix()).toEqual(DEFAULT_MIX);
  });
});
