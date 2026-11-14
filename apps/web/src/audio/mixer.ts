/**
 * Pure voice bookkeeping for the audio engine (no WebAudio here, so it is testable): the effect voice pool with
 * per-category and per-sound limits, and the alert-chirp rate limit.
 */
import { ALERT_CUES, SFX, SFX_CATEGORIES, type AlertCue, type SfxCategory } from './catalog.ts';
import type { OneShot } from './director.ts';

/** Fixed number of effect voices; categories share them under their own caps. */
export const VOICES = 32;
/** Effects quieter than this are not worth a voice. */
export const MIN_LEVEL = 0.02;

/**
 * Effect voice slots. `claim` picks a free slot, or steals the quietest playing voice of the same sound or category
 * when that one is quieter than the newcomer; otherwise the newcomer is dropped (-1). Times are seconds.
 */
export class VoicePool {
  readonly id: (OneShot | undefined)[] = new Array<OneShot | undefined>(VOICES).fill(undefined);
  readonly cat: (SfxCategory | undefined)[] = new Array<SfxCategory | undefined>(VOICES).fill(undefined);
  readonly level = new Float64Array(VOICES);
  readonly end = new Float64Array(VOICES);
  private readonly lastStart: Partial<Record<OneShot, number>> = {};
  /** Whether the last successful claim cut a still-playing voice short. */
  stolen = false;

  /** Playing voices of `cat` (or of sound `id`) at `now`. */
  count(now: number, cat?: SfxCategory, id?: OneShot): number {
    let n = 0;
    for (let i = 0; i < VOICES; i++) if (this.end[i]! > now && (cat === undefined || this.cat[i] === cat) && (id === undefined || this.id[i] === id)) n++;
    return n;
  }

  /** Slot for sound `id` at `level` starting `start` and lasting `duration`, or -1 when it should not play. */
  claim(id: OneShot, level: number, now: number, start: number, duration: number): number {
    if (level < MIN_LEVEL) return -1;
    const def = SFX[id];
    const last = this.lastStart[id];
    if (last !== undefined && start - last < def.gap / 1000 && start >= last) return -1;
    let slot = -1;
    if (this.count(now, undefined, id) >= def.max) slot = this.quietest(now, (i) => this.id[i] === id);
    else if (this.count(now, def.cat) >= SFX_CATEGORIES[def.cat].max) slot = this.quietest(now, (i) => this.cat[i] === def.cat);
    else {
      for (let i = 0; i < VOICES && slot < 0; i++) if (this.end[i]! <= now) slot = i;
      if (slot < 0) slot = this.quietest(now, () => true);
    }
    if (slot < 0 || (this.end[slot]! > now && this.level[slot]! >= level)) return -1;
    this.stolen = this.end[slot]! > now;
    this.id[slot] = id;
    this.cat[slot] = def.cat;
    this.level[slot] = level;
    this.end[slot] = start + duration;
    this.lastStart[id] = start;
    return slot;
  }

  private quietest(now: number, match: (i: number) => boolean): number {
    let best = -1;
    for (let i = 0; i < VOICES; i++) if (this.end[i]! > now && match(i) && (best < 0 || this.level[i]! < this.level[best]!)) best = i;
    return best;
  }

  reset(): void {
    this.end.fill(0);
    for (const k of Object.keys(this.lastStart) as OneShot[]) delete this.lastStart[k];
  }
}

/** Silence between two alert chirps (ms), so simultaneous alerts don't stack. */
const ALERT_GAP_MS = 1200;

/** Rate limit for important-moment alert chirps: a cooldown per cue plus a short global gap. Times are ms. */
export class AlertGate {
  private readonly last: Partial<Record<AlertCue, number>> = {};
  private any = -Infinity;

  /** True when `cue` may sound now (and records it). */
  allow(cue: AlertCue, now: number): boolean {
    const last = this.last[cue];
    if (last !== undefined && now - last < ALERT_CUES[cue]) return false;
    if (now - this.any < ALERT_GAP_MS) return false;
    this.last[cue] = now;
    this.any = now;
    return true;
  }

  reset(): void {
    this.any = -Infinity;
    for (const k of Object.keys(this.last) as AlertCue[]) delete this.last[k];
  }
}
