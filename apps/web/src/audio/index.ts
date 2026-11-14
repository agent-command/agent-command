/**
 * Audio facade (eager, tiny). The WebAudio engine is a separate chunk imported when the home is idle, and the
 * AudioContext starts on the first user gesture (autoplay rules). Until then every call is a cheap no-op, and with no
 * audio files present the game is simply silent. Callers: play.ts (boot, scenes), game.ts (views, frames, outcome,
 * orders), controls.ts (selection), the music player and settings (mix).
 */
import type { Plane } from '@agent-command/game/contract';
import type { ActivityId, AlertCue, AmbienceId, MusicId } from './catalog.ts';
import type { AudioSink, OneShot } from './director.ts';
import type { AudioEngine, AudioListener, Scene, UiSound } from './engine.ts';
import { audioMix, onAudioMix } from './settings.ts';
import { TRACKS, musicDeck, type MusicWhere, type GroupId, type MusicMode, type TrackId } from './music.ts';

/** Camera state, updated in place every frame by the match (no allocation); placeholders until the first frame. */
export const listener: AudioListener = { plane: 'surface', x: 0, y: 0, level: 1, rightX: 1, rightY: 0, dist: 30 };

let engine: AudioEngine | undefined;
let loading: Promise<AudioEngine | undefined> | undefined;
let scene: Scene = 'silent';
let gestured = false;
let booted = false;
/** performance.now() of the last order sent to the server (its acknowledgement decides confirm or error). */
let orderAt = -Infinity;

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

/** Engine housekeeping between match frames (home streaming, deck changes, playlist, releases); matches add rAF frames. */
const TICK_MS = 250;
let ticker: ReturnType<typeof setInterval> | undefined;

function unlock(): void {
  gestured = true;
  if (!engine) {
    // A gesture before the deferred engine load starts it now; the load unlocks once ready.
    void loadAudio();
    return;
  }
  if (engine.start()) for (const g of GESTURES) removeEventListener(g, unlock, true);
  ticker ??= setInterval(() => engine?.frame(performance.now()), TICK_MS);
}

/**
 * The interface sound of a pressed control: committing buttons (`.primary`, `[data-commit]`) confirm, any other
 * enabled button, tab or menu item gives the light select tick; nothing when the click sent an order (the server's
 * acknowledgement decides confirm or error) or hit no control.
 */
export function uiSoundFor(target: EventTarget | null, orderSent: boolean): UiSound | undefined {
  const el = target instanceof Element ? target.closest('button, [role="button"], [role="tab"], [role="menuitem"], [role="option"]') : null;
  if (!el || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' || orderSent) return undefined;
  return el.matches('.primary, [data-commit]') ? 'confirm' : 'select';
}

function clicked(e: Event): void {
  if (!engine) return;
  const t = performance.now();
  // Decide after the whole click dispatch: the control's own handler may send an order meanwhile.
  setTimeout(() => {
    const kind = uiSoundFor(e.target, orderAt >= t);
    if (kind) engine?.ui(kind);
  }, 0);
}

/** Load the engine chunk (idempotent); resolves undefined where WebAudio is unavailable. */
export function loadAudio(): Promise<AudioEngine | undefined> {
  loading ??= typeof AudioContext === 'undefined'
    ? Promise.resolve(undefined)
    : import('./engine.ts').then(({ AudioEngine }) => {
      const e = new AudioEngine(listener);
      e.setMix(audioMix());
      e.setScene(scene);
      e.prefetch();
      onAudioMix((mix) => e.setMix(mix));
      engine = e;
      if (gestured) unlock();
      return e;
    }).catch((error: unknown) => {
      console.warn('audio: engine unavailable', error);
      return undefined;
    });
  return loading;
}

/** Arm audio once the page is interactive: gesture listeners now, the engine chunk (and its first downloads) when the
 *  browser is idle after `after` settles (the home passes its backdrop start), or at the first gesture. */
export function bootAudio(after: Promise<unknown> = Promise.resolve()): void {
  if (booted || typeof window === 'undefined') return;
  booted = true;
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) Object.assign(window, { __agentCommandAudio: audioStatus, __agentCommandMusicProbe: (id: MusicId) => engine?.probeMusic(id) });
  for (const g of GESTURES) addEventListener(g, unlock, { capture: true, passive: true });
  addEventListener('click', clicked, { capture: true, passive: true });
  const go = (): void => void loadAudio();
  void after.finally(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 4000 });
    else setTimeout(go, 200);
  });
}

export function setAudioScene(next: Scene): void {
  scene = next;
  engine?.setScene(next);
}

export function audioOutcome(result: 'win' | 'loss' | 'draw'): void {
  scene = 'outcome';
  engine?.outcome(result);
}

/**
 * Game interface sounds: `select` (units or structures selected, a menu pick: a light tick), `confirm` (an order the
 * server accepted, a committed action: a rising chirp), `error` (rejected: the low buzz).
 */
export function audioUi(kind: UiSound): void {
  engine?.ui(kind);
}

/** An order is being sent: the click that sent it stays silent; its acknowledgement plays confirm or error. */
export function audioOrderSent(): void {
  orderAt = performance.now();
}

/** Per frame from the match loop (listener already updated). */
export function audioFrame(now: number): void {
  engine?.frame(now);
}

/** The sink the match's AudioDirector drives. */
export const audioSink: AudioSink = {
  sfx(id: OneShot, plane: Plane, x: number, y: number, delayMs: number, level?: number): void {
    engine?.sfx(id, plane, x, y, delayMs, level);
  },
  alert(cue: AlertCue): void {
    engine?.alert(cue);
  },
  combat(heat: number): void {
    engine?.combat(heat);
  },
  battleSeed(seed: number): void {
    engine?.battleSeed(seed);
  },
  loop(id: AmbienceId, level: number): void {
    engine?.loop(id, level);
  },
  activity(id: ActivityId, voice: number, level: number, pan: number): void {
    engine?.activity(id, voice, level, pan);
  },
};

/** Diagnostics for smoke tests: engine loaded, context state, decoded and missing files. */
export function audioStatus(): { loaded: boolean; state: AudioContextState | 'none'; scene: Scene; decoded: number; missing: number; sting: string | undefined } {
  return { loaded: engine !== undefined, state: engine?.state ?? 'none', scene, ...(engine?.stats ?? { decoded: 0, missing: 0, sting: undefined }) };
}

const where = (): MusicWhere => (scene === 'home' || scene === 'lobby' || scene === 'match' ? scene : 'none');

/**
 * The music player's API: the engine's music controls once it is loaded, the persisted deck before that (same state,
 * so choices made before the first gesture apply when audio starts).
 */
export const musicPlayer = {
  tracks: TRACKS,
  /** The track playing or paused now (Auto: a battle track once it dominates). */
  current(): TrackId | undefined {
    return engine ? engine.current : musicDeck.cue(where(), listener.plane);
  },
  /** Where the music is: home, a match or neither (Auto's display depends on it). */
  where,
  focus(): Plane {
    return listener.plane;
  },
  mode(): MusicMode {
    return musicDeck.state.mode;
  },
  paused(): boolean {
    return musicDeck.state.paused;
  },
  group(): GroupId | null {
    return musicDeck.state.group;
  },
  setMode(mode: MusicMode): void {
    musicDeck.setMode(mode);
  },
  pin(track: TrackId): void {
    musicDeck.pin(track);
  },
  playGroup(group: GroupId): void {
    musicDeck.playGroup(group);
  },
  next(): void {
    if (engine) engine.next();
    else musicDeck.next(1, where(), listener.plane);
  },
  prev(): void {
    if (engine) engine.prev();
    else musicDeck.next(-1, where(), listener.plane);
  },
  play(): void {
    if (engine) engine.play();
    else musicDeck.play();
  },
  pause(): void {
    musicDeck.pause();
  },
  /** Music output level 0..1 (allocation-free). */
  level(): number {
    return engine ? engine.musicLevel() : 0;
  },
  onChange: (listener: () => void): (() => void) => musicDeck.onChange(listener),
};
