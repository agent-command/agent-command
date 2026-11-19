/** Fixed-size cumulative tick histograms: recording a tick never allocates or sorts. */
export class TickMetrics {
  readonly #lag = new Uint32Array(2001);
  readonly #duration = new Uint32Array(2001);
  #samples = 0;
  #maxLagMs = 0;
  #maxDurationMs = 0;
  record(lagMs: number, durationMs: number): void {
    const lag = Math.max(0, lagMs);
    const duration = Math.max(0, durationMs);
    this.#lag[Math.min(2000, Math.ceil(lag))]!++;
    this.#duration[Math.min(2000, Math.ceil(duration))]!++;
    this.#samples++;
    this.#maxLagMs = Math.max(this.#maxLagMs, lag);
    this.#maxDurationMs = Math.max(this.#maxDurationMs, duration);
  }
  snapshot() {
    const target = Math.ceil(this.#samples * 0.99);
    let lag = 0;
    let duration = 0;
    let lagCount = 0;
    let durationCount = 0;
    for (let i = 0; i < this.#lag.length; i++) {
      if (lagCount < target) { lagCount += this.#lag[i]!; lag = i; }
      if (durationCount < target) { durationCount += this.#duration[i]!; duration = i; }
      if (lagCount >= target && durationCount >= target) break;
    }
    return { samples: this.#samples, p99LagMs: lag, maxLagMs: this.#maxLagMs, p99DurationMs: duration, maxDurationMs: this.#maxDurationMs };
  }
}
