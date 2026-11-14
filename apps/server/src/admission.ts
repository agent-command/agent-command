/** Bounded FIFO match admission. Queue tickets are bearer secrets; polling renews a waiting place. */
import { randomBytes } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Capacity is counted in duel units; loads are multiples of 0.1, so sums snap to a 0.01 grid instead of drifting. */
const LOAD_GRID = 100;
/** Per-tick cost of each army beyond a duel's pair (DESIGN §15.14: four armies measured ~2.4× a duel). */
const FFA_LOAD_PER_PAIR = 1.2;
/** Capacity units of one match: a duel is 1; more armies cost armies / 2 × 1.2 (three 1.8, four 2.4). */
export function matchLoad(armies: number): number {
  return armies > 2 ? Math.round(armies / 2 * FFA_LOAD_PER_PAIR * LOAD_GRID) / LOAD_GRID : 1;
}
/** Exact sum of capacity units (no float drift across many admissions and releases). */
export const addLoad = (a: number, b: number): number => Math.round((a + b) * LOAD_GRID) / LOAD_GRID;
export interface QueueState {
  state: 'queued';
  queue: string;
  position: number;
  estimatedWaitMs: number;
  pollAfterMs: number;
}
export type AdmissionResult<T> = QueueState | { state: 'admitted'; result: T };
interface Entry {
  id: string;
  identity: string;
  /** Capacity units the match takes once started (`matchLoad`). */
  load: number;
  /** Runs on the main thread: only these wait out main-thread lag. */
  onMain: boolean;
  touched: number;
  start: () => Promise<unknown>;
  canStart: () => boolean;
  status: 'waiting' | 'starting' | 'admitted' | 'failed';
  result?: unknown;
  error?: unknown;
}
export class AdmissionError extends Error {
  readonly code: 'queue_full' | 'already_queued' | 'queue_expired' | 'server_updating';
  constructor(code: AdmissionError['code']) { super(code); this.code = code; }
}
export interface AdmissionOptions {
  maxMatches: number;
  maxQueue: number;
  /** Main-thread event-loop delay (ms) above which main-thread admissions wait (`ADMISSION_LAG_MS`). */
  lagThresholdMs: number;
  /** Rolling window the main-thread delay is judged over, in seconds (default 10, like the workers'). */
  lagWindowSeconds?: number;
  /** Percentile of that window compared with `lagThresholdMs` (default 95). */
  lagPercentile?: number;
  /**
   * Whether main-thread lag also holds matches placed on worker threads (default false: those wait only on their
   * worker's health and the pool's capacity, which the caller's `canStart` checks).
   */
  mainLagGatesWorkers?: boolean;
  /** Capacity units in use (`matchLoad` per live match), compared with `maxMatches` duel units. */
  active: () => number;
  accepting?: () => boolean;
  /** Separate from the frontend heartbeat TTL: used only to estimate a full queue's wait. */
  estimatedMatchMs: number;
}

const EVENT_LOOP_RESOLUTION_MS = 10;
/** Each second contributes the same number of quantile points, however few samples a blocked loop managed to take. */
const POINTS_PER_SECOND = 100;
/** 1 ms delay bins; the last one collects everything from 1 s up. */
const LAG_BINS = 1001;
/**
 * Rolling per-second quantile sketch of main-thread event-loop delay. Judging a percentile over many seconds, not the
 * worst sample of one second, means a single slow tick no longer pauses admission; sustained lag still does.
 */
class LagWindow {
  readonly #bins: Uint16Array;
  readonly #seconds: number;
  #head = 0;
  #filled = 0;
  constructor(seconds: number) {
    this.#seconds = seconds;
    this.#bins = new Uint16Array(seconds * LAG_BINS);
  }
  /** One finished second: `quantile(k)` is its k-th percentile delay in ms (k = 1..100). */
  push(quantile: (k: number) => number): void {
    this.#head = (this.#head + 1) % this.#seconds;
    const base = this.#head * LAG_BINS;
    this.#bins.fill(0, base, base + LAG_BINS);
    for (let k = 1; k <= POINTS_PER_SECOND; k++) {
      const bin = Math.min(LAG_BINS - 1, Math.max(0, Math.ceil(quantile(k))));
      this.#bins[base + bin] = this.#bins[base + bin]! + 1;
    }
    this.#filled = Math.min(this.#seconds, this.#filled + 1);
  }
  /** The window's `percent`-th percentile delay in whole ms (0 before the first second). */
  percentile(percent: number): number {
    let remaining = Math.ceil(this.#filled * POINTS_PER_SECOND * percent / 100);
    if (remaining <= 0) return 0;
    for (let bin = 0; bin < LAG_BINS; bin++) {
      for (let second = 0; second < this.#seconds; second++) remaining -= this.#bins[second * LAG_BINS + bin]!;
      if (remaining <= 0) return bin;
    }
    return LAG_BINS - 1;
  }
}

export class Admission {
  readonly #entries = new Map<string, Entry>();
  readonly #waiting: Entry[] = [];
  readonly #identities = new Set<string>();
  readonly #delay = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  readonly #window: LagWindow;
  readonly #percentile: number;
  #timer: NodeJS.Timeout | undefined;
  /** Capacity units of the matches being started now. */
  #pending = 0;
  #closed = false;
  #started = false;
  readonly #ready = Promise.withResolvers<void>();
  #loop = { p50Ms: 0, p99Ms: 0, maxMs: 0, resolutionMs: EVENT_LOOP_RESOLUTION_MS, windowSeconds: 0, percentile: 0, lagMs: 0 };
  #averageMatchMs: number;
  readonly options: AdmissionOptions;
  constructor(options: AdmissionOptions) {
    this.options = options;
    this.#averageMatchMs = options.estimatedMatchMs;
    this.#window = new LagWindow(options.lagWindowSeconds ?? 10);
    this.#percentile = options.lagPercentile ?? 95;
    this.#loop.windowSeconds = options.lagWindowSeconds ?? 10;
    this.#loop.percentile = this.#percentile;
  }
  /** Measure serving pressure, not the worker/authentication bootstrap that precedes public readiness. */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#delay.enable();
    // The histogram includes the sampling interval: 10.1 ms at resolution 10 means ~0.1 ms of lag.
    const lag = (k: number) => Math.max(0, this.#delay.percentile(k) / 1e6 - EVENT_LOOP_RESOLUTION_MS);
    this.#timer = setInterval(() => {
      this.#window.push(lag);
      this.#loop.p50Ms = lag(50);
      this.#loop.p99Ms = lag(99);
      this.#loop.maxMs = Math.max(0, this.#delay.max / 1e6 - EVENT_LOOP_RESOLUTION_MS);
      this.#loop.lagMs = this.#window.percentile(this.#percentile);
      this.#delay.reset();
      this.#expire();
      this.#pump();
    }, 1000);
    this.#timer.unref();
    this.#ready.resolve();
    this.#pump();
  }
  /**
   * Running work is never slowed to serve a queue. `onMain`: the match would run on the main thread, so sustained
   * main-thread lag (the window percentile above the threshold) holds it; worker placements ignore main-thread lag
   * unless `mainLagGatesWorkers`.
   */
  canStart(load = 1, onMain = true): boolean {
    return this.healthy && !this.lagHolds(onMain) &&
      addLoad(addLoad(this.options.active(), this.#pending), load) <= this.options.maxMatches;
  }
  /** Serving and not draining; says nothing about lag. */
  get healthy(): boolean { return this.#started && !this.#closed && (this.options.accepting?.() ?? true); }
  /** The main thread's delay percentile over the window exceeds the threshold. */
  get lagging(): boolean { return this.#loop.lagMs > this.options.lagThresholdMs; }
  /** Main-thread lag holds this placement now. */
  lagHolds(onMain: boolean): boolean { return this.lagging && (onMain || !!this.options.mainLagGatesWorkers); }
  get eventLoop() { return { ...this.#loop }; }
  get queued(): number { return this.#waiting.length; }
  get starting(): number { return this.#pending; }
  /** A duel would be admitted now on the main thread (`onMain`) or on a worker. */
  accepting(onMain: boolean): boolean { return this.canStart(1, onMain) && this.#waiting.length === 0; }
  /** Called when a room releases its capacity, to improve wait estimates without storing match histories. */
  released(durationMs: number): void {
    this.#averageMatchMs = this.#averageMatchMs * 0.8 + Math.max(1000, durationMs) * 0.2;
    this.#pump();
  }
  /**
   * `load`: the match's capacity units (`matchLoad`); a four-army match waits for room for ~2.4 duels. `onMain`: the
   * match runs on the main thread (agents, policies, series) rather than a simulation worker.
   */
  async submit<T>(identity: string, start: () => Promise<T>, canStart: () => boolean = () => true, load = 1, onMain = true): Promise<AdmissionResult<T>> {
    if (!this.#started && !this.#closed) {
      const timeout = Promise.withResolvers<void>();
      const timer = setTimeout(timeout.resolve, 3000);
      timer.unref();
      try { await Promise.race([this.#ready.promise, timeout.promise]); }
      finally { clearTimeout(timer); }
    }
    if (this.#closed || !(this.options.accepting?.() ?? true)) throw new AdmissionError('server_updating');
    this.#expire();
    if (this.#identities.has(identity)) throw new AdmissionError('already_queued');
    if ((this.#waiting.length === 0 || !onMain && this.#waiting.every((entry) => this.#lagHeld(entry))) && this.canStart(load, onMain) && canStart()) {
      this.#pending = addLoad(this.#pending, load);
      try { return { state: 'admitted', result: await start() }; }
      finally { this.#pending = addLoad(this.#pending, -load); this.#pump(); }
    }
    if (this.#waiting.length >= this.options.maxQueue) throw new AdmissionError('queue_full');
    const entry: Entry = { id: randomBytes(24).toString('base64url'), identity, load, onMain, touched: Date.now(), start, canStart, status: 'waiting' };
    this.#entries.set(entry.id, entry);
    this.#identities.add(identity);
    this.#waiting.push(entry);
    return this.#state(entry);
  }
  poll<T>(id: string): AdmissionResult<T> {
    this.#expire();
    const entry = this.#entries.get(id);
    if (!entry) throw new AdmissionError('queue_expired');
    entry.touched = Date.now();
    if (entry.status === 'failed') throw entry.error;
    if (entry.status === 'admitted') return { state: 'admitted', result: entry.result as T };
    if (this.#closed || !(this.options.accepting?.() ?? true)) throw new AdmissionError('server_updating');
    this.#pump();
    return this.#state(entry);
  }
  cancel(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || entry.status !== 'waiting') return false;
    const index = this.#waiting.indexOf(entry);
    if (index >= 0) this.#waiting.splice(index, 1);
    this.#entries.delete(id);
    this.#identities.delete(entry.identity);
    return true;
  }
  close(): void {
    this.#closed = true;
    this.#ready.resolve();
    clearInterval(this.#timer);
    this.#delay.disable();
    this.#waiting.length = 0;
    this.#entries.clear();
    this.#identities.clear();
  }
  #state(entry: Entry): QueueState {
    const position = entry.status === 'starting' ? 1 : this.#waiting.indexOf(entry) + 1;
    const batches = Math.ceil(Math.max(1, position) / Math.max(1, this.options.maxMatches));
    return { state: 'queued', queue: entry.id, position: Math.max(1, position), estimatedWaitMs: Math.round(batches * this.#averageMatchMs), pollAfterMs: 2000 };
  }
  #expire(): void {
    const now = Date.now();
    for (const entry of this.#entries.values()) {
      // The browser polls every two seconds; a backgrounded tab gets a full minute before losing its place.
      if (entry.status === 'waiting' && now - entry.touched > 60_000) this.cancel(entry.id);
      else if ((entry.status === 'admitted' || entry.status === 'failed') && now - entry.touched > 60_000) this.#entries.delete(entry.id);
    }
  }
  #pump(): void {
    // Claim class-specific capacity synchronously; subsequent queued starts happen on later turns. FIFO, except that a
    // main-thread match held only by main-thread lag does not hold up a worker match behind it.
    let index = 0;
    for (; index < this.#waiting.length; index++) {
      const entry = this.#waiting[index]!;
      if (this.canStart(entry.load, entry.onMain) && entry.canStart()) break;
      if (!this.#lagHeld(entry)) return;
    }
    const head = this.#waiting[index];
    if (!head) return;
    this.#waiting.splice(index, 1);
    head.status = 'starting';
    this.#pending = addLoad(this.#pending, head.load);
    void this.#allocate(head);
  }
  /** Waits only because it runs on the main thread while that thread lags: room and health are there. */
  #lagHeld(entry: Entry): boolean { return entry.onMain && this.lagging && this.canStart(entry.load, false); }
  async #allocate(entry: Entry): Promise<void> {
    try {
      entry.result = await entry.start();
      entry.status = 'admitted';
    } catch (error) {
      entry.error = error;
      entry.status = 'failed';
    } finally {
      entry.touched = Date.now();
      this.#identities.delete(entry.identity);
      this.#pending = addLoad(this.#pending, -entry.load);
      if (this.#waiting.length) setImmediate(() => this.#pump());
    }
  }
}
