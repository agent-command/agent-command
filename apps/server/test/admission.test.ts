import { afterEach, describe, expect, it, vi } from 'vitest';
import { addLoad, Admission, matchLoad } from '../src/admission.ts';

const instances: Admission[] = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
function create(active: () => number, maxQueue = 3) {
  const admission = new Admission({ maxMatches: 1, maxQueue, lagThresholdMs: 1000, active, estimatedMatchMs: 60_000 });
  admission.start();
  instances.push(admission);
  return admission;
}
async function settled() { const done = Promise.withResolvers<void>(); setImmediate(done.resolve); await done.promise; }

describe('FIFO admission', () => {
  it('queues without starting work, admits FIFO as capacity frees, and keeps polling idempotent', async () => {
    let active = 1;
    const admission = create(() => active);
    const order: number[] = [];
    const first = await admission.submit('a', async () => { active++; order.push(1); return { roomId: 'first' }; });
    const second = await admission.submit('b', async () => { active++; order.push(2); return { roomId: 'second' }; });
    expect(first).toMatchObject({ state: 'queued', position: 1, estimatedWaitMs: 60_000 });
    expect(second).toMatchObject({ state: 'queued', position: 2 });
    expect(order).toEqual([]);
    if (first.state !== 'queued' || second.state !== 'queued') throw new Error('expected queue');
    active = 0;
    admission.released(60_000);
    await settled();
    expect(order).toEqual([1]);
    expect(admission.poll(first.queue)).toEqual({ state: 'admitted', result: { roomId: 'first' } });
    expect(admission.poll(first.queue)).toEqual({ state: 'admitted', result: { roomId: 'first' } });
    active = 0;
    admission.released(60_000);
    await settled();
    expect(order).toEqual([1, 2]);
  });
  it('reserves in-flight creates and does not let new callers leapfrog a class-blocked head', async () => {
    const gate = Promise.withResolvers<number>();
    const admission = create(() => 0);
    const start = admission.submit('first', () => gate.promise);
    const next = await admission.submit('second', async () => 2);
    expect(next.state).toBe('queued');
    gate.resolve(1);
    expect(await start).toEqual({ state: 'admitted', result: 1 });
    await settled();
    const blocked = await admission.submit('blocked', async () => 3, () => false);
    expect(blocked.state).toBe('queued');
    expect((await admission.submit('later', async () => 4)).state).toBe('queued');
  });
  it('claims a queued class slot synchronously before another poll can overbook it', async () => {
    let available = false;
    const gate = Promise.withResolvers<number>();
    const admission = new Admission({ maxMatches: 8, maxQueue: 3, lagThresholdMs: 1000, active: () => 0, estimatedMatchMs: 60_000 });
    admission.start();
    instances.push(admission);
    const allocate = vi.fn(() => { available = false; return gate.promise; });
    const first = await admission.submit('first', allocate, () => available);
    const second = await admission.submit('second', allocate, () => available);
    if (first.state !== 'queued' || second.state !== 'queued') throw new Error('expected queue');
    available = true;
    admission.released(1000);
    expect(available).toBe(false);
    expect(admission.poll(second.queue).state).toBe('queued');
    expect(allocate).toHaveBeenCalledTimes(1);
    gate.resolve(1);
    await settled();
    expect(admission.poll(first.queue)).toEqual({ state: 'admitted', result: 1 });
  });
  it('bounds the queue, prevents duplicate IP places, and cancellation frees a place', async () => {
    const admission = create(() => 1, 1);
    const first = await admission.submit('same-ip', async () => 1);
    await expect(admission.submit('same-ip', async () => 2)).rejects.toMatchObject({ code: 'already_queued' });
    await expect(admission.submit('different-ip', async () => 2)).rejects.toMatchObject({ code: 'queue_full' });
    if (first.state !== 'queued') throw new Error('expected queue');
    expect(admission.cancel(first.queue)).toBe(true);
    expect(admission.cancel(first.queue)).toBe(false);
    expect((await admission.submit('different-ip', async () => 2)).state).toBe('queued');
  });
  it('expires abandoned heartbeats and refuses new admissions while draining', async () => {
    const admission = create(() => 1);
    const waiting = await admission.submit('a', async () => 1);
    if (waiting.state !== 'queued') throw new Error('expected queue');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    expect(() => admission.poll(waiting.queue)).toThrow('queue_expired');
    admission.close();
    await expect(admission.submit('b', async () => 2)).rejects.toMatchObject({ code: 'server_updating' });
  });
});

describe('match load (DESIGN §15.14)', () => {
  it('weighs a duel as one and more armies at armies / 2 × 1.2, summing exactly', () => {
    expect([2, 3, 4].map(matchLoad)).toEqual([1, 1.8, 2.4]);
    let load = 0;
    for (let i = 0; i < 1000; i++) load = addLoad(load, matchLoad(4));
    for (let i = 0; i < 1000; i++) load = addLoad(load, -matchLoad(4));
    expect(load).toBe(0);
    expect(addLoad(addLoad(addLoad(addLoad(addLoad(0, 2.4), 2.4), 2.4), 2.4), 2.4)).toBe(12);
  });
  it('admits a four-army match only with room for ~2.4 duels; duels behind it wait their FIFO turn', async () => {
    let active = 1;
    const admission = new Admission({ maxMatches: 3, maxQueue: 3, lagThresholdMs: 1000, active: () => active, estimatedMatchMs: 60_000 });
    admission.start();
    instances.push(admission);
    expect(admission.canStart(matchLoad(4))).toBe(false);
    expect(admission.canStart(matchLoad(2))).toBe(true);
    const ffa = await admission.submit('ffa', async () => 'ffa', () => true, matchLoad(4));
    expect(ffa.state).toBe('queued');
    expect((await admission.submit('duel', async () => 'duel')).state).toBe('queued');
    active = 0.6;
    admission.released(60_000);
    await settled();
    if (ffa.state !== 'queued') throw new Error('expected queue');
    expect(admission.poll(ffa.queue)).toEqual({ state: 'admitted', result: 'ffa' });
  });
});

describe('startup admission handoff', () => {
  it('waits briefly for readiness and admits idle capacity without a queue ticket', async () => {
    vi.useFakeTimers();
    const admission = new Admission({ maxMatches: 1, maxQueue: 3, lagThresholdMs: 25, active: () => 0, estimatedMatchMs: 60_000 });
    instances.push(admission);
    const allocate = vi.fn(async () => 'match');
    let returned = false;
    const request = admission.submit('first-visitor', allocate).then((result) => { returned = true; return result; });
    await vi.advanceTimersByTimeAsync(2500);
    expect(returned).toBe(false);
    expect(allocate).not.toHaveBeenCalled();
    admission.start();
    expect(await request).toEqual({ state: 'admitted', result: 'match' });
    expect(admission.queued).toBe(0);
    expect(allocate).toHaveBeenCalledTimes(1);
  });

  it('bounds the startup wait at three seconds, then preserves the FIFO place until ready', async () => {
    vi.useFakeTimers();
    const admission = new Admission({ maxMatches: 1, maxQueue: 3, lagThresholdMs: 25, active: () => 0, estimatedMatchMs: 60_000 });
    instances.push(admission);
    const request = admission.submit('visitor', async () => 'match');
    await vi.advanceTimersByTimeAsync(3000);
    const waiting = await request;
    expect(waiting).toMatchObject({ state: 'queued', position: 1 });
    admission.start();
    await vi.advanceTimersByTimeAsync(0);
    if (waiting.state !== 'queued') throw new Error('expected a bounded startup queue');
    expect(admission.poll(waiting.queue)).toEqual({ state: 'admitted', result: 'match' });
  });

  it('releases a startup waiter on shutdown without allocating a match', async () => {
    vi.useFakeTimers();
    const admission = new Admission({ maxMatches: 1, maxQueue: 3, lagThresholdMs: 25, active: () => 0, estimatedMatchMs: 60_000 });
    instances.push(admission);
    const allocate = vi.fn(async () => 'match');
    const request = admission.submit('visitor', allocate);
    const stopped = expect(request).rejects.toMatchObject({ code: 'server_updating' });
    admission.close();
    await stopped;
    expect(allocate).not.toHaveBeenCalled();
  });
});
