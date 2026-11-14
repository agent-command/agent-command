import { describe, expect, it } from 'vitest';
import { hasSimulationHeadroom, SimulationMetrics, simulationLoadScore, type SimulationPressure } from '../src/simulation-metrics.ts';

const IDLE: SimulationPressure = { p95LagMs: 0, windowSamples: 0, p99LagMs: 0, cpuFraction: 0 };

describe('rolling simulation pressure', () => {
  it('calculates nearest-rank p95 with conservative millisecond bins', () => {
    const metrics = new SimulationMetrics(0, { user: 0, system: 0 }, 20);
    for (let i = 0; i < 95; i++) metrics.recordTick(1.1, 100, 40);
    for (let i = 0; i < 5; i++) metrics.recordTick(900, 100, 40);
    expect(metrics.sample(100, { user: 0, system: 0 })).toMatchObject({ windowSamples: 100, p95LagMs: 2 });
    metrics.recordTick(900, 101, 40);
    expect(metrics.sample(101, { user: 0, system: 0 })).toMatchObject({ windowSamples: 101, p95LagMs: 900 });
  });

  it('expires old buckets at the ten-second boundary and clears long idle gaps', () => {
    const metrics = new SimulationMetrics(0, { user: 0, system: 0 }, 20);
    metrics.recordTick(80, 0, 40);
    metrics.recordTick(20, 999, 40);
    metrics.recordTick(5, 1000, 40);
    expect(metrics.sample(9000, { user: 0, system: 0 }).windowSamples).toBe(3);
    expect(metrics.sample(10_000, { user: 0, system: 0 })).toMatchObject({ windowSamples: 1, p95LagMs: 5 });
    expect(metrics.sample(11_000, { user: 0, system: 0 })).toMatchObject({ windowSamples: 0, p95LagMs: 0 });
    metrics.recordTick(5000, 12_000, 40);
    expect(metrics.sample(12_000, { user: 0, system: 0 }).p95LagMs).toBe(1000);
    expect(metrics.sample(1_000_000, { user: 0, system: 0 })).toMatchObject({ windowSamples: 0, p95LagMs: 0, cpuFraction: 0 });
  });

  it('keeps only the fixed window over many bucket rotations', () => {
    const metrics = new SimulationMetrics(0, { user: 0, system: 0 }, 20);
    for (let second = 0; second < 100; second++) metrics.recordTick(second % 5, second * 1000, 40);
    expect(metrics.sample(99_000, { user: 0, system: 0 })).toMatchObject({ windowSamples: 10, p95LagMs: 4 });
  });

  it('normalizes thread user plus system microseconds to one core, not replica cores', () => {
    const metrics = new SimulationMetrics(0, { user: 100_000, system: 100_000 }, 20);
    expect(metrics.sample(1000, { user: 600_000, system: 350_000 }).cpuFraction).toBeCloseTo(.75);
    expect(metrics.sample(2000, { user: 1_100_000, system: 600_000 }).cpuFraction).toBeCloseTo(.75);
    expect(metrics.sample(2000, { user: 1_100_000, system: 600_000 }).cpuFraction).toBeCloseTo(.75);
  });

  it('smooths CPU over recent buckets and expires a short CPU burst', () => {
    const metrics = new SimulationMetrics(0, { user: 0, system: 0 }, 20);
    expect(metrics.sample(1000, { user: 1_000_000, system: 0 }).cpuFraction).toBe(1);
    expect(metrics.sample(2000, { user: 1_000_000, system: 0 }).cpuFraction).toBeCloseTo(.5);
    expect(metrics.sample(9000, { user: 1_000_000, system: 0 }).cpuFraction).toBeCloseTo(1 / 9);
    expect(metrics.sample(10_000, { user: 1_000_000, system: 0 }).cpuFraction).toBe(0);
  });

  it('weights delayed CPU reports across their wall-time overlap', () => {
    const metrics = new SimulationMetrics(0, { user: 0, system: 0 }, 20);
    expect(metrics.sample(12_000, { user: 6_000_000, system: 0 }).cpuFraction).toBeCloseTo(.5);
    expect(metrics.sample(22_000, { user: 6_000_000, system: 0 }).cpuFraction).toBe(0);
  });
  it.each([20, 30])('excludes the first two game seconds of every match at %i Hz', (tickRate) => {
    const metrics = new SimulationMetrics(0, { user: 0, system: 0 }, tickRate);
    for (let tick = 0; tick < tickRate * 2; tick++) metrics.recordTick(1000, tick * 50, tick);
    expect(metrics.sample(2000, { user: 0, system: 0 })).toMatchObject({ windowSamples: 0, p95LagMs: 0 });
    metrics.recordTick(1, 2100, tickRate * 2);
    // A new match on a warm worker gets the same exclusion; it cannot poison the existing window.
    metrics.recordTick(1000, 2200, 0);
    expect(metrics.sample(2200, { user: 0, system: 0 })).toMatchObject({ windowSamples: 1, p95LagMs: 1 });
  });

});

describe('simulation admission pressure', () => {
  it('requires 100 mature samples before lateness can reject admission, without a cold p99 fallback', () => {
    expect(hasSimulationHeadroom(IDLE, 25)).toBe(true);
    expect(hasSimulationHeadroom({ ...IDLE, p99LagMs: 1000 }, 25)).toBe(true);
    expect(hasSimulationHeadroom({ ...IDLE, windowSamples: 14, p95LagMs: 27, p99LagMs: 100 }, 25)).toBe(true);
    expect(hasSimulationHeadroom({ ...IDLE, windowSamples: 99, p95LagMs: 100 }, 25)).toBe(true);
    expect(hasSimulationHeadroom({ ...IDLE, windowSamples: 100, p95LagMs: 27 }, 25)).toBe(false);
    expect(hasSimulationHeadroom({ ...IDLE, windowSamples: 100, p95LagMs: 25 }, 25)).toBe(true);
  });

  it('requires both tick and CPU headroom with a configurable CPU fraction', () => {
    expect(hasSimulationHeadroom({ ...IDLE, cpuFraction: .749 }, 50)).toBe(true);
    expect(hasSimulationHeadroom({ ...IDLE, cpuFraction: .75 }, 50)).toBe(false);
    expect(hasSimulationHeadroom({ ...IDLE, cpuFraction: .8 }, 50, .9)).toBe(true);
    expect(hasSimulationHeadroom({ ...IDLE, windowSamples: 100, p95LagMs: 60, cpuFraction: .1 }, 50)).toBe(false);
  });

  it('scores the greater of one-core CPU pressure and live-plus-pending occupancy', () => {
    expect(simulationLoadScore(IDLE, 2, 8)).toBe(.25);
    expect(simulationLoadScore({ ...IDLE, cpuFraction: .7 }, 1, 8)).toBe(.7);
    expect(simulationLoadScore({ ...IDLE, cpuFraction: .2 }, 3, 8)).toBe(.375);
    // A worker with more rooms but much more CPU headroom wins, unlike a pure room-count balancer.
    expect(simulationLoadScore({ ...IDLE, cpuFraction: .2 }, 3, 8)).toBeLessThan(
      simulationLoadScore({ ...IDLE, cpuFraction: .7 }, 1, 8),
    );
    expect(simulationLoadScore(IDLE, 8, 8)).toBe(1);
  });
});
