/**
 * The WebAudio engine (lazy chunk). Buses: safety compressor ← master ← music (→ level meter) | sfx (focused plane direct, other planes
 * through a low-pass "muffle") ← loops (weather ambience, close-zoom activity). Plane-bound sounds (catalog HEARD_ON)
 * are gated by the plane in view: one-shots as they play, loops the frame the view changes planes. Effects use a fixed pool of 32
 * gain+pan voices with per-category limits (mixer.ts). Music follows the deck (music.ts): Auto crossfades the focused
 * plane's bed variation on dives under a rotating battle layer driven by combat heat near the camera; Manual plays a
 * pinned track or group. The long home theme streams in segments. Files load on demand; a missing or undecodable file
 * stays silent. The per-frame path (`frame`) does scalar maths and AudioParam automation only when a target changes;
 * it allocates only when a streamed segment is scheduled (every ~30 s).
 */
import { PLANES, type Plane } from '@agent-command/game/contract';
import {
  ACTIVITY, ACTIVITY_IDS, ACTIVITY_VOICES, AMBIENCE_IDS, BATTLE_IDS, INITIAL_FILES, LOOP_PAD, MUSIC_GAIN, SEGMENTS, SFX,
  heardOn, loopOf, segmentFile, soundUrl, type ActivityId, type AlertCue, type AmbienceId, type BattleId, type MusicId, type SoundKey,
} from './catalog.ts';
import type { AudioSink, Listener, OneShot } from './director.ts';
import { AlertGate, VOICES, VoicePool } from './mixer.ts';
import { GROUP_TRACKS, TRACKS, battleTrack, musicDeck, stingFor, type MusicWhere, type GroupId, type MusicDeck, type MusicMode, type TrackId } from './music.ts';
import type { AudioMix } from './settings.ts';
import { DOTS_FROM } from '../unit-dots.ts';

export type Scene = 'silent' | 'home' | 'lobby' | 'match' | 'outcome';
export type UiSound = 'select' | 'confirm' | 'error';

/** Camera state the engine positions sounds against (tile coordinates; right = camera right axis on the map). */
export interface AudioListener extends Listener {
  /** Fractional plane index (PLANES order) during dives. */
  level: number;
  /** Camera distance (zoom). */
  dist: number;
}

/** Frames crossfaded at a loop's end into the decoded pre-roll before its start, hiding codec edge mismatch. */
const HEAL = 1024;
/** Combat heat for a full battle layer, and its decay time constant (s). */
const HEAT_FULL = 24;
const HEAT_DECAY = 5;
/** A battle that stays quiet this long (s) ends; the next one gets the next battle track. */
const BATTLE_GAP_S = 12;
/** Music fades (time constants, s). */
const FADE = 1.1;
/** Close-zoom activity loops: full at or below this camera distance, silent from where the unit dots begin. */
const ACTIVITY_CLOSE = 34;
/** Seconds before a streamed segment's start when it is fetched/decoded, and when it is scheduled. */
const STREAM_LOAD_S = 12;
/** Playlist handover: seconds before the end of a pass when the next track starts (crossfading over FADE). */
const HANDOVER_S = 3;
const STREAM_SCHEDULE_S = 2;
/** Select ticks cycle through these playback rates so repeated selects don't sound robotic. */
const SELECT_RATES = [1, 1.06, 0.95, 1.03, 0.97, 1.08, 0.93] as const;
const UI_SFX: Readonly<Record<UiSound, OneShot>> = { select: 'ui_click', confirm: 'ui_confirm', error: 'ui_error' };

/**
 * Make a looping buffer's [start, end) loop seamless after lossy decoding: crossfade the last HEAL frames before
 * `end` into the frames just before `start` (the encoded wrap padding), so the jump end → start is continuous.
 */
export function healLoopSeam(channels: readonly Float32Array[], start: number, end: number): void {
  const k = Math.min(HEAL, start, end - start);
  for (const d of channels)
    for (let i = 0; i < k; i++) {
      const t = (i + 1) / k;
      const a = end - k + i;
      d[a] = d[a]! * (1 - t) + d[start - k + i]! * t;
    }
}

/**
 * Make streamed segment `next` continue seamlessly from `prev`: crossfade next's first HEAL played frames (after its
 * `pad` pre-roll) from prev's post-roll (the same music, decoded from prev's file) into its own.
 */
export function healSegmentJoin(prev: readonly Float32Array[], prevEnd: number, next: readonly Float32Array[], pad: number): void {
  for (let c = 0; c < next.length; c++) {
    const p = prev[Math.min(c, prev.length - 1)]!, d = next[c]!;
    const k = Math.min(HEAL, p.length - prevEnd, d.length - pad);
    for (let i = 0; i < k; i++) {
      const t = (i + 1) / k;
      d[pad + i] = p[prevEnd + i]! * (1 - t) + d[pad + i]! * t;
    }
  }
}

const channelsOf = (b: AudioBuffer): Float32Array[] => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));

interface Track {
  readonly key: SoundKey;
  readonly gain: GainNode;
  /** Activity voices: their panner, and where in the loop they start (so two voices of one sound don't phase). */
  readonly pan: StereoPannerNode | undefined;
  readonly phase: number;
  src: AudioBufferSourceNode | undefined;
  buffer: AudioBuffer | undefined;
  loading: boolean;
  target: number;
  /** ctx time the target last dropped to 0 (release after a while). */
  silentSince: number;
  /** Streamed (segmented) track state; undefined for a single looping file. */
  stream: Stream | undefined;
}

interface Stream {
  readonly frames: readonly number[];
  playing: boolean;
  /** Segment to schedule next, ctx time it starts, and the segment playing before it. */
  next: number;
  at: number;
  prev: number;
  sources: (AudioBufferSourceNode | undefined)[];
}

interface Slot {
  readonly gain: GainNode;
  readonly pan: StereoPannerNode;
  src: AudioBufferSourceNode | undefined;
  out: AudioNode | undefined;
}

export class AudioEngine implements AudioSink {
  readonly listener: AudioListener;
  private readonly fetcher: typeof fetch;
  private readonly deck: MusicDeck;
  private ctx: AudioContext | undefined;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private near!: GainNode;
  private far!: GainNode;
  private loopBus!: GainNode;
  private analyser: AnalyserNode | undefined;
  private readonly meter = new Float32Array(512);
  private readonly bytes = new Map<string, Promise<ArrayBuffer | undefined>>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly decoding = new Map<string, Promise<AudioBuffer | undefined>>();
  private readonly missing = new Set<string>();
  private readonly pool = new VoicePool();
  private readonly slots: Slot[] = [];
  private readonly alerts = new AlertGate();
  private readonly music = new Map<TrackId, Track>();
  private readonly ambience = new Map<AmbienceId, Track>();
  /** Ambience levels from the director, before the plane gate. */
  private readonly ambienceLevel: Record<AmbienceId, number> = { wind_loop: 0, storm_loop: 0 };
  /** The plane in view the loop gates were last applied for. */
  private gatePlane: Plane | undefined;
  /** Activity voices, index ACTIVITY_IDS.indexOf(id) * ACTIVITY_VOICES + voice; their levels before the zoom fade. */
  private readonly activityTracks: Track[] = [];
  private readonly activityLevel = new Float64Array(ACTIVITY_IDS.length * ACTIVITY_VOICES);
  private readonly activityPan = new Float64Array(ACTIVITY_IDS.length * ACTIVITY_VOICES);
  /** Every track as one array, so the per-frame sweep allocates no iterators. */
  private readonly allTracks: Track[] = [];
  private scene: Scene = 'silent';
  private deckVersion = -1;
  private bedFocus: Plane | undefined;
  /** Leading track (undefined while paused), the track shown (a battle track once it dominates), seconds played. */
  private lead: TrackId | undefined;
  private heard: TrackId | undefined;
  private played = 0;
  /** The next playlist track's first file was requested for this pass. */
  private nextLoaded = false;
  private heat = 0;
  private battleSet = -1;
  /** Battle rotation: per-match seed, battles so far, the current battle track and when the layer fell silent. */
  private seed = 0;
  private battles = 0;
  private battle: BattleId | undefined;
  private battleQuietAt = -Infinity;
  private zoomSet = -1;
  private selectTurn = 0;
  private lastFrame = 0;
  private mix: Readonly<AudioMix> | undefined;
  /** Errors are reported once per file, never thrown into the game. */
  private readonly warned = new Set<string>();

  constructor(listener: AudioListener, fetcher: typeof fetch = (input, init) => fetch(input, init), deck: MusicDeck = musicDeck) {
    this.listener = listener;
    this.fetcher = fetcher;
    this.deck = deck;
  }

  get started(): boolean {
    return this.ctx !== undefined;
  }

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  /** Smoke tests: whether a music track's files (first and last segment of a streamed one) fetch and decode. */
  async probeMusic(id: MusicId): Promise<boolean> {
    if (!this.ctx) return false;
    const key: SoundKey = `music/${id}`;
    const segs = SEGMENTS[key];
    const files = segs ? [segmentFile(key, 0), segmentFile(key, segs.length - 1)] : [key];
    const fresh = files.filter((f) => !this.buffers.has(f));
    const buffers = await Promise.all(files.map((f) => this.load(f)));
    // only decoding is checked: drop the PCM decoded here (the compressed bytes stay cached)
    for (const f of fresh) this.buffers.delete(f);
    return buffers.every((b) => b !== undefined);
  }

  /** The last match-end sting started (diagnostics). */
  private stung: string | undefined;

  /** Decoded buffers held, files found missing or undecodable, and the last sting started (diagnostics). */
  get stats(): { decoded: number; missing: number; sting: string | undefined } {
    return { decoded: this.buffers.size, missing: this.missing.size, sting: this.stung };
  }

  /** Fetch compressed bytes ahead of time (no AudioContext needed). */
  prefetch(files: readonly string[] = INITIAL_FILES): void {
    for (const f of files) void this.fetchBytes(f);
  }

  /** Create/resume the AudioContext; call from a user gesture. Returns true once audio is running. */
  start(make: () => AudioContext = () => new AudioContext({ latencyHint: 'interactive' })): boolean {
    if (!this.ctx) {
      const ctx = make();
      this.ctx = ctx;
      this.master = ctx.createGain();
      // A look-ahead safety compressor catches summed combat transients, not individual sounds.
      // Leave ordinary cues/ambience untouched; settings still control the entire final output.
      const ceiling = ctx.createDynamicsCompressor();
      ceiling.threshold.value = -3;
      ceiling.knee.value = 0;
      ceiling.ratio.value = 20;
      ceiling.attack.value = 0.002;
      ceiling.release.value = 0.12;
      this.master.connect(ceiling).connect(ctx.destination);
      this.musicBus = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = this.meter.length;
      this.musicBus.connect(this.analyser).connect(this.master);
      this.sfxBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.near = ctx.createGain();
      this.near.connect(this.sfxBus);
      const muffle = ctx.createBiquadFilter();
      muffle.type = 'lowpass';
      muffle.frequency.value = 650;
      muffle.Q.value = 0.5;
      this.far = ctx.createGain();
      this.far.connect(muffle).connect(this.sfxBus);
      this.loopBus = ctx.createGain();
      this.loopBus.connect(this.sfxBus);
      for (let i = 0; i < VOICES; i++) {
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner();
        pan.connect(gain);
        this.slots.push({ gain, pan, src: undefined, out: undefined });
      }
      for (const id of TRACKS) this.music.set(id, this.track(`music/${id}`, this.musicBus));
      for (const id of AMBIENCE_IDS) this.ambience.set(id, this.track(`sfx/${id}`, this.loopBus));
      for (const id of ACTIVITY_IDS)
        for (let v = 0; v < ACTIVITY_VOICES; v++) this.activityTracks.push(this.track(`sfx/${ACTIVITY[id].loop}`, this.loopBus, true, v / ACTIVITY_VOICES + 0.17));
      this.allTracks.push(...this.music.values(), ...this.ambience.values(), ...this.activityTracks);
      if (this.mix) this.setMix(this.mix);
      for (const f of INITIAL_FILES) if (!f.startsWith('music/')) void this.load(f);
      this.setScene(this.scene);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    return this.ctx.state === 'running';
  }

  private track(key: SoundKey, bus: AudioNode, panned = false, phase = 0): Track {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = panned ? ctx.createStereoPanner() : undefined;
    if (pan) gain.connect(pan).connect(bus);
    else gain.connect(bus);
    const frames = SEGMENTS[key];
    const stream = frames ? { frames, playing: false, next: 0, at: 0, prev: -1, sources: [undefined, undefined] } : undefined;
    return { key, gain, pan, phase, src: undefined, buffer: undefined, loading: false, target: 0, silentSince: 0, stream };
  }

  setMix(mix: Readonly<AudioMix>): void {
    this.mix = mix;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(mix.muted ? 0 : mix.master, t, 0.03);
    this.musicBus.gain.setTargetAtTime(mix.musicMuted ? 0 : mix.music, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(mix.sfx, t, 0.03);
  }

  // ------------------------------------------------------------------ loading

  private fetchBytes(file: string): Promise<ArrayBuffer | undefined> {
    let p = this.bytes.get(file);
    if (!p) {
      const url = soundUrl(file);
      p = url === undefined
        ? Promise.resolve(undefined)
        : this.fetcher(url).then((r) => (r.ok ? r.arrayBuffer() : undefined)).catch(() => undefined);
      this.bytes.set(file, p);
    }
    return p;
  }

  /** Decoded buffer of a file (`sfx/w_cannon`, `music/home_3`; cached), or undefined when absent or undecodable. */
  load(file: string): Promise<AudioBuffer | undefined> {
    const have = this.buffers.get(file);
    if (have) return Promise.resolve(have);
    if (this.missing.has(file) || !this.ctx) return Promise.resolve(undefined);
    let p = this.decoding.get(file);
    if (!p) {
      const ctx = this.ctx;
      p = this.fetchBytes(file).then(async (bytes) => {
        if (!bytes) {
          this.missing.add(file);
          return undefined;
        }
        try {
          // decodeAudioData detaches its input: keep the compressed copy for a later re-decode.
          const buffer = await ctx.decodeAudioData(bytes.slice(0));
          const loop = SEGMENTS[file as SoundKey] ? undefined : loopOf(file as SoundKey);
          if (loop) healLoopSeam(channelsOf(buffer), Math.round(loop.start * buffer.sampleRate), Math.round(loop.end * buffer.sampleRate));
          this.buffers.set(file, buffer);
          return buffer;
        } catch (error) {
          this.missing.add(file);
          this.warn(file, error);
          return undefined;
        } finally {
          this.decoding.delete(file);
        }
      });
      this.decoding.set(file, p);
    }
    return p;
  }

  private warn(file: string, error: unknown): void {
    if (this.warned.has(file)) return;
    this.warned.add(file);
    console.warn(`audio: ${file} unavailable`, error);
  }

  // ------------------------------------------------------------------ effects

  /** Outputs of `place`: stereo pan and whether the sound is on another plane (muffled bus). */
  private panOut = 0;
  private farOut = false;

  /** Gain of a sound at tile (x, y) on `plane` relative to the listener; sets panOut/farOut. */
  private place(plane: Plane, x: number, y: number): number {
    const l = this.listener;
    const dx = x - l.x, dy = y - l.y;
    const ref = Math.min(30, Math.max(8, l.dist * 0.45));
    const d2 = (dx * dx + dy * dy) / (ref * ref);
    const apart = Math.abs(PLANES.indexOf(plane) - l.level);
    this.panOut = Math.max(-1, Math.min(1, (dx * l.rightX + dy * l.rightY) / (ref * 1.5))) * 0.8;
    this.farOut = apart >= 0.5;
    return (1 / (1 + d2)) * (this.farOut ? 0.5 / Math.max(1, apart) : 1);
  }

  sfx(id: OneShot, plane: Plane, x: number, y: number, delayMs: number, level = 1): void {
    if (this.scene !== 'match' || !this.ctx || !heardOn(id, this.listener.plane)) return;
    const at = this.place(plane, x, y);
    this.playSfx(id, SFX[id].gain * level * at, this.panOut, this.farOut, delayMs, 1);
  }

  /** Interface sounds, centred and unmuffled in any scene: select ticks vary their pitch slightly each time. */
  ui(kind: UiSound): void {
    if (!this.ctx) return;
    const id = UI_SFX[kind];
    const rate = kind === 'select' ? SELECT_RATES[this.selectTurn++ % SELECT_RATES.length]! : 1;
    this.playSfx(id, SFX[id].gain, 0, false, 0, rate);
  }

  /** An important moment: the alert chirp, rate-limited per cue (AlertGate). */
  alert(cue: AlertCue): void {
    if (!this.ctx || this.scene !== 'match') return;
    if (this.alerts.allow(cue, performance.now())) this.playSfx('alert', SFX.alert.gain, 0, false, 0, 1);
  }

  private playSfx(id: OneShot, level: number, pan: number, far: boolean, delayMs: number, rate: number): void {
    const ctx = this.ctx!;
    const key: SoundKey = `sfx/${id}`;
    const buffer = this.buffers.get(key);
    if (!buffer) {
      void this.load(key);
      return;
    }
    const now = ctx.currentTime;
    const start = now + delayMs / 1000;
    const i = this.pool.claim(id, level, now, start, buffer.duration / rate);
    if (i < 0) return;
    const slot = this.slots[i]!;
    const begin = this.pool.stolen ? Math.max(start, now + 0.02) : start;
    if (slot.src && this.pool.stolen) {
      slot.gain.gain.cancelScheduledValues(now);
      slot.gain.gain.setTargetAtTime(0, now, 0.005);
      slot.src.stop(now + 0.02);
    }
    const out = far ? this.far : this.near;
    if (slot.out !== out) {
      if (slot.out) slot.gain.disconnect();
      slot.gain.connect(out);
      slot.out = out;
    }
    slot.gain.gain.setValueAtTime(level, begin);
    slot.pan.pan.setValueAtTime(pan, begin);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(slot.pan);
    src.start(begin);
    slot.src = src;
  }

  combat(heat: number): void {
    this.heat = Math.min(HEAT_FULL * 2, this.heat + heat);
  }

  battleSeed(seed: number): void {
    this.seed = seed >>> 0;
    this.battles = 0;
    this.battle = undefined;
    this.battleQuietAt = -Infinity;
    if (this.ctx) void this.load(`music/${battleTrack(this.seed, 0)}`);
  }

  loop(id: AmbienceId, level: number): void {
    this.ambienceLevel[id] = level;
    const t = this.ambience.get(id);
    if (t) this.retarget(t, this.scene === 'match' && heardOn(id, this.listener.plane) ? level : 0, 0.4);
  }

  /** Re-apply every ambience loop's plane gate (the plane in view changed). */
  private applyAmbience(): void {
    for (const id of AMBIENCE_IDS) this.loop(id, this.ambienceLevel[id]);
  }

  activity(id: ActivityId, voice: number, level: number, pan: number): void {
    const k = ACTIVITY_IDS.indexOf(id) * ACTIVITY_VOICES + voice;
    this.activityLevel[k] = level;
    const t = this.activityTracks[k];
    if (t?.pan && Math.abs(this.activityPan[k]! - pan) > 0.05) {
      this.activityPan[k] = pan;
      t.pan.pan.setTargetAtTime(pan, this.ctx!.currentTime, 0.25);
    }
    this.zoomSet = -1;
  }

  /** Close-zoom fade 0..1: full up close, silent where the unit dots begin. */
  private zoomFade(): number {
    return Math.max(0, Math.min(1, (DOTS_FROM - this.listener.dist) / (DOTS_FROM - ACTIVITY_CLOSE)));
  }

  private applyActivity(fade: number): void {
    this.zoomSet = fade;
    const on = this.scene === 'match' ? fade : 0;
    const plane = this.listener.plane;
    for (let i = 0; i < ACTIVITY_IDS.length; i++) {
      const a = ACTIVITY[ACTIVITY_IDS[i]!];
      const gain = heardOn(a.loop, plane) ? on * a.gain : 0;
      for (let v = 0; v < ACTIVITY_VOICES; v++) {
        const k = i * ACTIVITY_VOICES + v;
        this.retarget(this.activityTracks[k]!, this.activityLevel[k]! * gain, 0.35);
      }
    }
  }

  // ------------------------------------------------------------------ music

  setScene(scene: Scene): void {
    const enteringMatch = scene === 'match' && this.scene !== 'match';
    this.scene = scene;
    if (!this.ctx) return;
    if (scene !== 'match') {
      this.heat = 0;
      for (const t of this.ambience.values()) this.retarget(t, 0, 0.3);
      this.alerts.reset();
    }
    this.zoomSet = -1;
    this.applyMusic(0, enteringMatch);
    if (scene === 'match') {
      // Stream the match's music and effects in the background, focused bed first.
      void this.load(`music/${this.deck.bed(this.listener.plane)}`);
      this.prefetch(PLANES.map((p) => `music/${this.deck.bed(p)}`));
      for (const id of Object.keys(SFX) as OneShot[]) void this.load(`sfx/${id}`);
    }
  }

  /** Match result: stop the looping music and play the victory or defeat stinger. */
  outcome(result: 'win' | 'loss' | 'draw'): void {
    this.setScene('outcome');
    if (!this.ctx || result === 'draw') return;
    // one of the outcome's stinger takes, deterministic per match
    const id = stingFor(this.seed, result);
    void this.load(`music/${id}`).then((buffer) => {
      if (!buffer || this.scene !== 'outcome') return;
      const ctx = this.ctx!;
      const g = ctx.createGain();
      g.gain.value = MUSIC_GAIN[id];
      g.connect(this.musicBus);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(g);
      src.start(ctx.currentTime + 0.3);
      this.stung = id;
    });
  }

  private get where(): MusicWhere {
    return this.scene === 'home' || this.scene === 'lobby' || this.scene === 'match' ? this.scene : 'none';
  }

  /**
   * Music targets from the scene and the deck. Auto: home theme at home; in matches the focused plane's bed leads
   * (crossfading on dives) under the battle layer of `battle` 0..1, one battle track per battle. Manual: only the deck's
   * track, no plane crossfade or battle. Paused, silent and outcome scenes: no looping music.
   */
  private applyMusic(battle: number, enteringMatch = false): void {
    const deck = this.deck.state;
    const focus = this.listener.plane;
    this.deckVersion = this.deck.version;
    this.bedFocus = focus;
    const cue = this.deck.cue(this.where, focus);
    const lead = deck.paused ? undefined : cue;
    const auto = deck.mode === 'auto' && this.scene === 'match' && lead !== undefined;
    const layer = auto ? battle : 0;
    const now = this.ctx!.currentTime;
    if (layer > 0 && this.battleSet <= 0 && (this.battle === undefined || now - this.battleQuietAt > BATTLE_GAP_S)) this.battle = battleTrack(this.seed, this.battles++);
    if (layer <= 0 && this.battleSet > 0) this.battleQuietAt = now;
    this.battleSet = layer;
    const bed = 1 - layer * 0.5;
    for (let i = 0; i < TRACKS.length; i++) {
      const id = TRACKS[i]!;
      const isBattle = (BATTLE_IDS as readonly TrackId[]).includes(id);
      const want = id === lead && !(auto && isBattle) ? MUSIC_GAIN[id] * bed : auto && id === this.battle ? layer * MUSIC_GAIN[id] : 0;
      // Auto hands menu ownership to the match once: finish that fade on the audio clock rather than leaving
      // an eight-second exponential menu tail under the player's first plane changes (or a slow bed decode).
      const track = this.music.get(id)!;
      const menuExit = deck.mode === 'auto' && this.scene === 'match' &&
        (id === 'home1' || id === 'home2' || id === 'lobby1' || id === 'lobby2') && (enteringMatch || track.target > 0);
      this.retarget(track, want, isBattle && auto ? (layer > 0 ? 0.6 : 2.5) : want > 0 ? FADE : FADE * 1.6, menuExit);
    }
    if (lead !== this.lead) this.played = 0;
    this.lead = lead;
    this.heard = auto && layer >= 0.5 && this.battle ? this.battle : cue;
  }

  /** One full pass of the leading track: Auto moves the plane's bed on (remembered); a Manual group plays on. */
  private advance(dt: number): void {
    const t = this.lead === undefined ? undefined : this.music.get(this.lead);
    if (!t || (!t.src && !t.stream?.playing)) return;
    this.played += dt;
    const loop = loopOf(t.key);
    if (!loop) return;
    const deck = this.deck.state;
    const moves = (deck.mode === 'manual' && deck.group !== null && GROUP_TRACKS[deck.group].length > 1) || (deck.mode === 'auto' && this.where !== 'none');
    if (!moves) return;
    const left = loop.end - loop.start - this.played;
    // the next track's first file decodes ahead, so the handover lands on its first bar
    if (left < STREAM_LOAD_S && !this.nextLoaded) {
      this.nextLoaded = true;
      const next = this.deck.peekNext(this.where, this.listener.plane);
      if (next) void this.load(SEGMENTS[`music/${next}`] ? segmentFile(`music/${next}`, 0) : `music/${next}`);
    }
    // hand over a moment before the pass ends: the outgoing outro fades under the incoming opening
    if (left > HANDOVER_S) return;
    this.played = 0;
    this.nextLoaded = false;
    this.deck.next(1, this.where, this.listener.plane);
  }

  private retarget(t: Track, target: number, tau: number, linear = false): void {
    if (!linear && Math.abs(t.target - target) < 0.02 && (target > 0 || t.target === 0)) return;
    const ctx = this.ctx!;
    if (target > 0 && t.target === 0) t.silentSince = 0;
    if (target === 0 && t.target > 0) t.silentSince = ctx.currentTime;
    t.target = target;
    // A returning/pinned track must cancel the previous scene's scheduled fade endpoint without a gain jump.
    t.gain.gain.cancelAndHoldAtTime(ctx.currentTime);
    if (linear) t.gain.gain.linearRampToValueAtTime(target, ctx.currentTime + tau);
    else t.gain.gain.setTargetAtTime(target, ctx.currentTime, tau);
    if (target > 0) this.ensure(t);
  }

  /** Start a track's loop when it is wanted (loading it first if needed). */
  private ensure(t: Track): void {
    if (t.stream) {
      this.pump(t, t.stream);
      return;
    }
    if (t.src || t.loading) return;
    if (!t.buffer) {
      t.loading = true;
      void this.load(t.key).then((b) => {
        t.loading = false;
        t.buffer = b;
        if (b && t.target > 0) this.ensure(t);
      });
      return;
    }
    const ctx = this.ctx!;
    const loop = loopOf(t.key);
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    src.loop = true;
    if (loop) {
      src.loopStart = loop.start;
      src.loopEnd = loop.end;
    }
    src.connect(t.gain);
    src.start(ctx.currentTime, loop ? loop.start + (loop.end - loop.start) * (t.phase % 1) : 0);
    t.src = src;
  }

  /**
   * Streamed track: keep the next segment decoded and scheduled back to back on the audio clock (sample-accurate),
   * healing each join; only the playing and the next segment stay decoded.
   */
  private pump(t: Track, s: Stream): void {
    const ctx = this.ctx!;
    const n = s.frames.length;
    const file = segmentFile(t.key, s.next);
    const buffer = this.buffers.get(file);
    if (!s.playing) {
      if (!buffer) {
        void this.load(file).then((b) => b && t.target > 0 && this.pump(t, s));
        return;
      }
      s.playing = true;
      s.at = ctx.currentTime + 0.05;
      s.prev = -1;
    }
    const now = ctx.currentTime;
    if (now < s.at - STREAM_LOAD_S) return;
    if (!buffer) {
      void this.load(file);
      return;
    }
    if (now < s.at - STREAM_SCHEDULE_S) return;
    const rate = buffer.sampleRate;
    if (s.prev >= 0) {
      const prev = this.buffers.get(segmentFile(t.key, s.prev));
      if (prev) healSegmentJoin(channelsOf(prev), Math.round((LOOP_PAD + s.frames[s.prev]!) * rate / 48000), channelsOf(buffer), Math.round(LOOP_PAD * rate / 48000));
      // the segment before the one playing is no longer needed
      const old = (s.prev - 1 + n) % n;
      if (old !== s.next) this.buffers.delete(segmentFile(t.key, old));
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(t.gain);
    const start = Math.max(s.at, now + 0.02);
    src.start(start, LOOP_PAD / 48000, s.frames[s.next]! / 48000);
    s.sources[s.next % 2]?.disconnect();
    s.sources[s.next % 2] = src;
    s.at = start + s.frames[s.next]! / 48000;
    s.prev = s.next;
    s.next = (s.next + 1) % n;
    void this.fetchBytes(segmentFile(t.key, s.next));
  }

  /** Stop and forget long-silent tracks so decoded PCM does not pile up (compressed bytes stay cached). */
  private release(t: Track, now: number): void {
    if (t.target > 0 || t.silentSince === 0 || now - t.silentSince < 8) return;
    if (t.stream?.playing) {
      const s = t.stream;
      for (let i = 0; i < s.sources.length; i++) {
        s.sources[i]?.stop();
        s.sources[i]?.disconnect();
        s.sources[i] = undefined;
      }
      for (let i = 0; i < s.frames.length; i++) this.buffers.delete(segmentFile(t.key, i));
      s.playing = false;
      s.next = 0;
      s.prev = -1;
      return;
    }
    if (!t.src) return;
    t.src.stop();
    t.src.disconnect();
    t.src = undefined;
    if (t.key.startsWith('music/')) {
      t.buffer = undefined;
      this.buffers.delete(t.key);
    }
  }

  // ------------------------------------------------------------------ music player API

  /** Every loopable track, grouped (the Manual list). */
  get tracks(): readonly TrackId[] {
    return TRACKS;
  }

  /** The track playing (or paused) now; Auto shows the battle track once it dominates. Undefined: no music scene. */
  get current(): TrackId | undefined {
    return this.heard;
  }

  get mode(): MusicMode {
    return this.deck.state.mode;
  }

  setMode(mode: MusicMode): void {
    this.deck.setMode(mode);
  }

  pin(track: TrackId): void {
    this.deck.pin(track);
  }

  playGroup(group: GroupId): void {
    this.deck.playGroup(group);
  }

  next(): void {
    this.deck.next(1, this.where, this.listener.plane);
  }

  prev(): void {
    this.deck.next(-1, this.where, this.listener.plane);
  }

  play(): void {
    this.deck.play();
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  pause(): void {
    this.deck.pause();
  }

  /** Music output level 0..1 for a meter (allocation-free; 0 before audio starts). */
  musicLevel(): number {
    const a = this.analyser;
    if (!a) return 0;
    const buf = this.meter;
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }

  /** Per frame: music targets, battle heat, zoom fade, streaming, playlist, releases. `now` = performance.now(). */
  frame(now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dt = this.lastFrame ? Math.min(0.25, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    let battle = this.battleSet;
    if (this.scene === 'match') {
      this.heat *= Math.exp(-dt / HEAT_DECAY);
      const intensity = Math.min(1, this.heat / HEAT_FULL);
      battle = intensity < 0.08 ? 0 : intensity;
    }
    if (this.deck.version !== this.deckVersion || this.listener.plane !== this.bedFocus || Math.abs(battle - this.battleSet) > 0.04 || (battle === 0) !== (this.battleSet <= 0)) this.applyMusic(battle);
    if (this.listener.plane !== this.gatePlane) {
      // the view changed planes: silence the old plane's loops now, not at the next view
      this.gatePlane = this.listener.plane;
      this.applyAmbience();
      this.zoomSet = -1;
    }
    const fade = this.zoomFade();
    if (Math.abs(fade - this.zoomSet) > 0.03) this.applyActivity(fade);
    this.advance(dt);
    const t = ctx.currentTime;
    for (let i = 0; i < this.allTracks.length; i++) {
      const tr = this.allTracks[i]!;
      if (tr.stream?.playing && tr.target > 0) this.pump(tr, tr.stream);
      this.release(tr, t);
    }
  }

  /** Close the context (tests, teardown). */
  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.pool.reset();
    this.alerts.reset();
    if (ctx) await ctx.close().catch(() => undefined);
  }
}
