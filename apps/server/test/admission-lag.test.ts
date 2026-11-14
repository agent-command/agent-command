import { afterEach, beforeEach, expect, it, vi } from 'vitest';
/** Each second's event-loop delay distribution: `delayMs(k)` is its k-th percentile, sampling interval included. */
const loop = vi.hoisted(() => ({ delayMs: (_k: number): number => 10, maxMs: 10 as number }));
vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: () => ({
    enable() {}, disable() {}, reset() {},
    percentile: (k: number) => loop.delayMs(k) * 1e6,
    get max() { return loop.maxMs * 1e6; },
  }),
}));
import { Admission, type AdmissionOptions } from '../src/admission.ts';

/** About 0.1 ms of real lag: the 10 ms sampling interval plus noise. */
const calm = () => 10.1;
/** One 60 ms stall in the second: only its top percentiles are late. The old p99-of-one-second gate held on this. */
const oneSlowTick = (k: number) => k >= 99 ? 70 : 10.1;
/** Every sample of the second is 30 ms late: the main thread is saturated. */
const saturated = () => 40;

let admission: Admission | undefined;
const make = (options: Partial<AdmissionOptions> = {}) => {
  admission = new Admission({ active: () => 0, maxMatches: 4, maxQueue: 8, estimatedMatchMs: 60_000, lagThresholdMs: 25, ...options });
  admission.start();
  return admission;
};
beforeEach(() => { vi.useFakeTimers(); loop.delayMs = calm; loop.maxMs = 10.1; });
afterEach(() => { admission?.close(); admission = undefined; vi.useRealTimers(); });

it('a single slow tick every second never pauses admission (p95 over ten seconds, not the worst sample of one)', async () => {
  const a = make();
  loop.delayMs = oneSlowTick; loop.maxMs = 70;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(a.eventLoop.p99Ms).toBe(60);
  expect(a.eventLoop.lagMs).toBeLessThanOrEqual(1);
  expect(a.lagging).toBe(false);
  expect(await a.submit('player', async () => 'match')).toEqual({ state: 'admitted', result: 'match' });
});

it('sustained main-thread lag holds main-thread matches until the window has rolled past it', async () => {
  const a = make();
  await vi.advanceTimersByTimeAsync(3000);
  loop.delayMs = saturated;
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.eventLoop).toMatchObject({ lagMs: 30, percentile: 95, windowSeconds: 10 });
  expect(a.lagging).toBe(true);
  expect(a.accepting(true)).toBe(false);
  const start = vi.fn(async () => 'match');
  const waiting = await a.submit('agent-match', start);
  expect(waiting.state).toBe('queued');
  loop.delayMs = calm;
  // The saturated second is still in the window for ten seconds.
  await vi.advanceTimersByTimeAsync(9000);
  expect(start).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.lagging).toBe(false);
  expect(start).toHaveBeenCalledOnce();
  if (waiting.state !== 'queued') throw new Error('expected queue');
  expect(a.poll(waiting.queue)).toEqual({ state: 'admitted', result: 'match' });
});

it('main-thread lag does not hold worker placements, not even behind a held main-thread match', async () => {
  const a = make();
  loop.delayMs = saturated;
  await vi.advanceTimersByTimeAsync(2000);
  expect(a.lagging).toBe(true);
  expect(a.accepting(false)).toBe(true);
  const main = await a.submit('agent-match', async () => 'main');
  expect(main.state).toBe('queued');
  // Submitted behind the held main-thread match: admitted at once.
  expect(await a.submit('worker-match', async () => 'worker', () => true, 1, false)).toEqual({ state: 'admitted', result: 'worker' });
  // Queued behind it for capacity reasons, then let through once the worker pool has room.
  let room = false;
  const queued = await a.submit('worker-later', async () => 'later', () => room, 1, false);
  expect(queued.state).toBe('queued');
  room = true;
  await vi.advanceTimersByTimeAsync(1000);
  if (queued.state !== 'queued' || main.state !== 'queued') throw new Error('expected queue');
  expect(a.poll(queued.queue)).toEqual({ state: 'admitted', result: 'later' });
  expect(a.poll(main.queue).state).toBe('queued');
});

it('capacity keeps FIFO order: only lag, not a full server, lets a worker match pass', async () => {
  let active = 4;
  const a = make({ active: () => active });
  loop.delayMs = saturated;
  await vi.advanceTimersByTimeAsync(1000);
  const main = await a.submit('agent-match', async () => 'main');
  const worker = await a.submit('worker-match', async () => 'worker', () => true, 1, false);
  expect([main.state, worker.state]).toEqual(['queued', 'queued']);
  active = 3;
  await vi.advanceTimersByTimeAsync(1000);
  if (worker.state !== 'queued') throw new Error('expected queue');
  expect(a.poll(worker.queue)).toEqual({ state: 'admitted', result: 'worker' });
});

it('ADMISSION_MAIN_LAG_GATES_WORKERS keeps the old rule: main-thread lag holds worker placements too', async () => {
  const a = make({ mainLagGatesWorkers: true });
  loop.delayMs = saturated;
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.accepting(false)).toBe(false);
  expect((await a.submit('worker-match', async () => 'worker', () => true, 1, false)).state).toBe('queued');
});

it('window and percentile are configurable', async () => {
  const a = make({ lagWindowSeconds: 2, lagPercentile: 50 });
  loop.delayMs = saturated;
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.lagging).toBe(true);
  loop.delayMs = calm;
  await vi.advanceTimersByTimeAsync(1000);
  // Half the two-second window is saturated: its median is not.
  expect(a.lagging).toBe(false);
});

it('does not carry bootstrap loop stalls into the first serving admission', async () => {
  loop.delayMs = () => 100; loop.maxMs = 200;
  admission = new Admission({ active: () => 0, maxMatches: 1, maxQueue: 3, estimatedMatchMs: 60_000, lagThresholdMs: 25 });
  await vi.advanceTimersByTimeAsync(2500);
  expect(admission.eventLoop.p99Ms).toBe(0);
  loop.delayMs = calm; loop.maxMs = 10.1;
  admission.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await admission.submit('first-visitor', async () => 'match')).toEqual({ state: 'admitted', result: 'match' });
  expect(admission.queued).toBe(0);
});
