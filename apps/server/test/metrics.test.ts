import { describe, expect, it } from 'vitest';
import { TickMetrics } from '../src/metrics.ts';

describe('tick telemetry', () => {
  it('keeps scheduler lateness separate from execution duration', () => {
    const metrics = new TickMetrics();
    expect(metrics.snapshot()).toEqual({ samples: 0, p99LagMs: 0, maxLagMs: 0, p99DurationMs: 0, maxDurationMs: 0 });
    for (let i = 0; i < 99; i++) metrics.record(1.2, 3.4);
    metrics.record(100, 200);
    expect(metrics.snapshot()).toEqual({ samples: 100, p99LagMs: 2, maxLagMs: 100, p99DurationMs: 4, maxDurationMs: 200 });
  });
  it('retains exact maxima above the bounded histogram range', () => {
    const metrics = new TickMetrics();
    metrics.record(-2, -4);
    metrics.record(5000.5, 6000.5);
    expect(metrics.snapshot()).toEqual({ samples: 2, p99LagMs: 2000, maxLagMs: 5000.5, p99DurationMs: 2000, maxDurationMs: 6000.5 });
  });
});
