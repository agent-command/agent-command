/**
 * Audio mix settings (master, music and SFX volumes, mute and music-only mute), stored in this browser. Tiny and dependency-free so
 * the settings popover can render them before the lazily loaded audio engine exists.
 */
export interface AudioMix {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
  /** Music only (the music player's mute). */
  musicMuted: boolean;
}
export type AudioChannel = Exclude<keyof AudioMix, 'muted' | 'musicMuted'>;
export const AUDIO_CHANNELS: readonly AudioChannel[] = ['master', 'music', 'sfx'];

const STORAGE_KEY = 'agent-command.audio';
export const DEFAULT_MIX: Readonly<AudioMix> = { master: 0.8, music: 0.6, sfx: 0.8, muted: false, musicMuted: false };
const listeners = new Set<(mix: Readonly<AudioMix>) => void>();
let current: AudioMix | undefined;

const unit = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

export function audioMix(): Readonly<AudioMix> {
  if (current === undefined) {
    let stored: Partial<AudioMix> = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw) as Partial<AudioMix>;
    } catch {
      /* storage unavailable or corrupt: defaults */
    }
    current = {
      master: unit(stored.master, DEFAULT_MIX.master),
      music: unit(stored.music, DEFAULT_MIX.music),
      sfx: unit(stored.sfx, DEFAULT_MIX.sfx),
      muted: stored.muted === true,
      musicMuted: stored.musicMuted === true,
    };
  }
  return current;
}

/** Update part of the mix; persists and notifies listeners. */
export function setAudioMix(patch: Partial<AudioMix>): void {
  const mix = audioMix() as AudioMix;
  for (const c of AUDIO_CHANNELS) if (patch[c] !== undefined) mix[c] = unit(patch[c], mix[c]);
  if (patch.muted !== undefined) mix.muted = patch.muted;
  if (patch.musicMuted !== undefined) mix.musicMuted = patch.musicMuted;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mix));
  } catch {
    /* storage unavailable: this session only */
  }
  for (const l of listeners) l(mix);
}

/** Mix changes. Returns unsubscribe. */
export function onAudioMix(listener: (mix: Readonly<AudioMix>) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: forget the cached mix so the next read comes from storage. */
export function resetAudioMixCache(): void {
  current = undefined;
}
