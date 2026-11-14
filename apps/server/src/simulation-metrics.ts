/** Ten one-second buckets bound worker admission telemetry independently of match lifetime/count. */
import type { SimulationStats } from './simulation-protocol.ts';

const SECONDS = 10;
const BINS = 1001;
export const MIN_SIMULATION_WINDOW_SAMPLES = 100;

export interface SimulationPressure extends Pick<SimulationStats, 'p95LagMs' | 'windowSamples' | 'p99LagMs' | 'cpuFraction'> {}

export class SimulationMetrics {
  readonly #histogram = new Uint32Array(SECONDS * BINS);
  readonly #samples = new Uint32Array(SECONDS);
  readonly #cpuMicros = new Float64Array(SECONDS);
  readonly #wallMs = new Float64Array(SECONDS);
  #second: number;
  #head = 0;
  #lastCpuAt: number;
  #lastCpuMicros: number;
  readonly #startupTicks: number;

  constructor(nowMs: number, usage: NodeJS.CpuUsage, tickRate: number) {
    this.#startupTicks = tickRate * 2;
    this.#second = Math.floor(nowMs / 1000);
    this.#lastCpuAt = nowMs;
    this.#lastCpuMicros = usage.user + usage.system;
  }

  recordTick(lagMs: number, nowMs: number, matchTick: number): void {
    // Each match gets its own startup exclusion, even when joining an already-warm worker.
    if (matchTick < this.#startupTicks) return;
    this.#advance(nowMs);
    const bin = Math.min(BINS - 1, Math.max(0, Math.ceil(lagMs)));
    const index = this.#head * BINS + bin;
    this.#histogram[index] = this.#histogram[index]! + 1;
    this.#samples[this.#head] = this.#samples[this.#head]! + 1;
  }

  sample(nowMs: number, usage: NodeJS.CpuUsage): { p95LagMs: number; windowSamples: number; cpuFraction: number } {
    this.#advance(nowMs);
    const elapsedMs = nowMs - this.#lastCpuAt;
    const currentCpu = usage.user + usage.system;
    if (elapsedMs > 0) {
      const deltaCpu = Math.max(0, currentCpu - this.#lastCpuMicros);
      const first = Math.max(this.#lastCpuAt, (this.#second - SECONDS + 1) * 1000);
      // A delayed report may span several buckets. Weight its measured CPU delta by actual wall overlap so
      // old work expires gradually, rather than attributing a long blocked interval entirely to its last second.
      for (let second = Math.floor(first / 1000); second <= this.#second; second++) {
        const overlap = Math.min(nowMs, (second + 1) * 1000) - Math.max(first, second * 1000);
        if (overlap <= 0) continue;
        const index = (this.#head - (this.#second - second) + SECONDS) % SECONDS;
        this.#cpuMicros[index] = this.#cpuMicros[index]! + deltaCpu * overlap / elapsedMs;
        this.#wallMs[index] = this.#wallMs[index]! + overlap;
      }
      this.#lastCpuAt = nowMs;
      this.#lastCpuMicros = currentCpu;
    }

    let windowSamples = 0;
    let cpuMicros = 0;
    let wallMs = 0;
    for (let second = 0; second < SECONDS; second++) {
      windowSamples += this.#samples[second]!;
      cpuMicros += this.#cpuMicros[second]!;
      wallMs += this.#wallMs[second]!;
    }
    let remaining = Math.ceil(windowSamples * .95);
    let p95LagMs = 0;
    if (remaining > 0) {
      for (let bin = 0; bin < BINS; bin++) {
        for (let second = 0; second < SECONDS; second++) remaining -= this.#histogram[second * BINS + bin]!;
        if (remaining <= 0) { p95LagMs = bin; break; }
      }
    }
    // process.threadCpuUsage measures only this worker thread. Microseconds / wall microseconds is a fraction
    // of ONE core, not the replica's CPU count and not process.cpuUsage's sum across all worker threads.
    return { p95LagMs, windowSamples, cpuFraction: wallMs > 0 ? cpuMicros / (wallMs * 1000) : 0 };
  }

  #advance(nowMs: number): void {
    const second = Math.floor(nowMs / 1000);
    const elapsed = second - this.#second;
    if (elapsed <= 0) return;
    if (elapsed >= SECONDS) {
      this.#histogram.fill(0);
      this.#samples.fill(0);
      this.#cpuMicros.fill(0);
      this.#wallMs.fill(0);
      this.#head = (this.#head + elapsed) % SECONDS;
    } else {
      for (let i = 0; i < elapsed; i++) {
        this.#head = (this.#head + 1) % SECONDS;
        this.#histogram.fill(0, this.#head * BINS, (this.#head + 1) * BINS);
        this.#samples[this.#head] = 0;
        this.#cpuMicros[this.#head] = 0;
        this.#wallMs[this.#head] = 0;
      }
    }
    this.#second = second;
  }
}

export function hasSimulationHeadroom(stats: SimulationPressure, maxLagMs: number, maxCpuFraction = .75): boolean {
  const lagReady = stats.windowSamples >= MIN_SIMULATION_WINDOW_SAMPLES;
  return (!lagReady || stats.p95LagMs <= maxLagMs) && stats.cpuFraction < maxCpuFraction;
}

export function simulationLoadScore(stats: SimulationPressure, roomsAndPending: number, staticCeiling: number): number {
  return Math.max(stats.cpuFraction, roomsAndPending / staticCeiling);
}
