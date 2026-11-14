import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareStartup, yieldStartup } from '../src/world/startup.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cooperative startup tasks', () => {
  it('lets the loading UI run before starting preparation', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    vi.stubGlobal('scheduler', { yield: () => promise });
    const calls: number[] = [];
    const prepared = prepareStartup((function* () {
      calls.push(1);
      yield;
      return 'complete';
    })());
    expect(calls).toEqual([]);
    resolve();
    expect(await prepared).toBe('complete');
    expect(calls).toEqual([1]);
  });

  it('yields between bounded tasks at the four millisecond budget, not around the whole constructor', async () => {
    let now = 0;
    const yields: number[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('scheduler', { yield: async () => { yields.push(now); } });
    const calls: number[] = [];
    const prepared = await prepareStartup((function* () {
      for (let i = 0; i < 5; i++) {
        calls.push(i);
        now += 2;
        yield;
      }
      return calls;
    })());
    expect(prepared).toBe(calls);
    expect(calls).toEqual([0, 1, 2, 3, 4]);
    expect(yields).toEqual([0, 4, 8]);
  });

  it('propagates construction errors without returning partial resources', async () => {
    vi.stubGlobal('scheduler', { yield: async () => {} });
    const failure = new Error('geometry construction failed');
    await expect(prepareStartup((function* () {
      yield;
      throw failure;
    })())).rejects.toBe(failure);
  });

  it('uses a task boundary when the browser scheduler API is absent', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('scheduler', undefined);
    let resumed = false;
    const pending = yieldStartup().then(() => { resumed = true; });
    expect(resumed).toBe(false);
    await vi.runAllTimersAsync();
    await pending;
    expect(resumed).toBe(true);
  });
});
