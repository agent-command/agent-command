import { patch } from 'playerthree/delta';
import type { ObserverFrame, ObserverMessage } from 'playerthree/protocol';

/** A released frame with its full projection rebuilt from the keyframe and deltas (structurally shared). */
export interface PlayedFrame { frame: ObserverFrame; world: unknown }

/** Smallest playout margin over the best observed transit (ms): absorbs server release batching and network jitter. */
const MIN_JITTER_MS = 80;
const MAX_JITTER_MS = 400;
/** Transit samples kept for the jitter estimate (about three seconds at 20 Hz). */
const SAMPLES = 64;
/** Frames this far behind playout (tab hidden, stall) are skipped to the newest: each frame is a full state. */
const CATCH_UP_MS = 1000;

/**
 * Observer playback: rebuilds every released frame (keyframe, then `playerthree/delta` deltas in sequence order) and
 * plays the frames out on the server's recording clock behind a small adaptive jitter buffer, so the renderer's own
 * snapshot interpolation sees evenly spaced frames even when the transport delivers them in bursts.
 */
export class ObserverFeed {
  private readonly deliver: (played: PlayedFrame) => void;
  private readonly resync: () => void;
  private perspective: string;
  private sequence = -1;
  private world: unknown;
  private readonly queue: { at: number; played: PlayedFrame }[] = [];
  private readonly transit = new Float64Array(SAMPLES);
  private readonly sorted = new Float64Array(SAMPLES);
  private samples = 0;
  private offset = Number.NaN;
  private jitter = MIN_JITTER_MS;
  /** Frames received in the current one-second window; `rate` is the last completed window (frames/s). */
  private counted = { start: 0, frames: 0 };
  private resyncing = false;
  rate = 0;

  constructor(perspective: string, deliver: (played: PlayedFrame) => void, resync: () => void) {
    this.perspective = perspective;
    this.deliver = deliver;
    this.resync = resync;
  }

  /** Switch perspective: drop everything until that perspective's keyframe arrives. */
  reset(perspective: string): void {
    this.perspective = perspective;
    this.sequence = -1;
    this.world = undefined;
    this.queue.length = 0;
    // The caller's perspective request already asks the server for that perspective's keyframe.
    this.resyncing = true;
    this.samples = 0;
    this.offset = Number.NaN;
  }

  /** Current playout margin (ms) behind the best transit, for the stream badge. */
  get bufferMs(): number { return this.jitter; }

  receive(message: ObserverMessage, now = performance.now()): void {
    const frame = message.frame;
    if (message.state !== 'ready' || !frame || frame.perspective !== this.perspective) return;
    if (frame.world !== undefined) { this.world = frame.world; this.resyncing = false; }
    else if (this.sequence < 0 || frame.sequence !== this.sequence + 1) {
      // A missed frame (or a delta before any keyframe) cannot be applied: ask once for a fresh keyframe.
      if (!this.resyncing && frame.sequence > this.sequence) { this.resyncing = true; this.resync(); }
      return;
    } else if (frame.delta) this.world = patch(this.world, frame.delta);
    this.sequence = frame.sequence;
    if (now - this.counted.start >= 1000) { this.rate = this.counted.frames * 1000 / Math.max(1, now - this.counted.start); this.counted.start = now; this.counted.frames = 0; }
    this.counted.frames++;
    this.sample(now - frame.recordedAt);
    this.queue.push({ at: frame.recordedAt, played: { frame, world: this.world } });
  }

  /**
   * Transit = arrival − recording (clock skew included). The playout delay targets the best recent transit plus its
   * spread. It grows by at most 5 ms per frame (late frames starve playout) and shrinks by at most 1 ms per frame, so
   * the cadence on screen never visibly changes.
   */
  private sample(transit: number): void {
    this.transit[this.samples % SAMPLES] = transit;
    this.samples++;
    const n = Math.min(this.samples, SAMPLES);
    this.sorted.set(this.transit.subarray(0, n));
    const ordered = this.sorted.subarray(0, n).sort();
    const best = ordered[0]!;
    const p95 = ordered[Math.min(n - 1, Math.floor(n * 0.95))]!;
    this.jitter = Math.min(MAX_JITTER_MS, Math.max(MIN_JITTER_MS, p95 - best + 30));
    const target = best + this.jitter;
    this.offset = Number.isNaN(this.offset) ? target : this.offset + Math.max(-1, Math.min(5, target - this.offset));
  }

  /** Call once per animation frame: hands every due frame to the renderer, in order. */
  pump(now = performance.now()): void {
    const queue = this.queue;
    if (!queue.length) return;
    const playout = now - this.offset;
    let due = 0;
    while (due < queue.length && queue[due]!.at <= playout) due++;
    if (!due) return;
    // Far behind (hidden tab, stall): each frame is a full state, so only the newest due one matters.
    const from = playout - queue[due - 1]!.at > CATCH_UP_MS ? due - 1 : 0;
    for (let i = from; i < due; i++) this.deliver(queue[i]!.played);
    queue.splice(0, due);
  }
}
