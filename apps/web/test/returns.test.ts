import { describe, expect, it } from 'vitest';
import { TICK_RATE, type Entity } from '@agent-command/game/contract';
import { RETURN_DIVE, RETURN_LINGER, RETURN_WARN, countdownWarning, diveProgress, hopFade, returnArrivals, returnHop, returnLeft, returnSeconds, returnWarning } from '../src/world/returns.ts';

const raider = (extra: Partial<Entity> = {}): Entity => ({
  id: 'i1', kind: 'interceptor', side: 'nw', plane: 'orbit', x: 10, y: 12, hp: 50, maxHp: 50, state: 'idle',
  transit: { to: 'orbit', at: 0, until: 1000, return: 'sky' }, ...extra,
} as Entity);

describe('timed visit return cues', () => {
  it('warns only over the last stretch of an arrived visit with a return plane', () => {
    const e = raider();
    expect(returnLeft(e, 900)).toBe(100);
    expect(returnWarning(e, 1000 - RETURN_WARN - 1)).toBe(-1);
    expect(returnWarning(e, 1000 - RETURN_WARN)).toBe(0);
    expect(returnWarning(e, 1000 - RETURN_WARN / 2)).toBeCloseTo(0.5);
    expect(returnWarning(e, 1000)).toBe(1);
    expect(returnSeconds(1000 - (1000 - RETURN_WARN))).toBe(3);
    expect(returnSeconds(1)).toBe(1);
    // still climbing, a permanent move, or no return plane: no countdown
    expect(returnWarning(raider({ plane: 'sky', transit: { to: 'orbit', at: 1000, until: 1400, return: 'sky' } }), 990)).toBe(-1);
    expect(returnWarning(raider({ transit: { to: 'orbit', at: 0, until: 0 } }), 990)).toBe(-1);
    expect(returnWarning(raider({ transit: { to: 'orbit', at: 0, until: 1000 } }), 990)).toBe(-1);
    expect(returnWarning(raider({ transit: undefined }), 990)).toBe(-1);
  });

  it('derives the departure from two snapshots, and an unseen arrival only once the return tick passed', () => {
    const before = raider();
    const after = raider({ plane: 'sky', transit: undefined });
    expect(returnHop(before, after, 1002)).toEqual({ from: 'orbit', to: 'sky', tick: 1000, seen: true });
    expect(returnHop(before, undefined, 1002)).toEqual({ from: 'orbit', to: 'sky', tick: 1000, seen: false });
    // vanished early (killed, out of sight) or still visiting: no hop
    expect(returnHop(before, undefined, 990)).toBeUndefined();
    expect(returnHop(before, raider(), 990)).toBeUndefined();
    // a climb landing is not a return
    expect(returnHop(raider({ plane: 'sky', transit: { to: 'orbit', at: 40, until: 440, return: 'sky' } }), raider({ transit: { to: 'orbit', at: 0, until: 440, return: 'sky' } }), 40)).toBeUndefined();
  });

  it('dives eased-in after the return tick and fades the departure marks over dive and linger', () => {
    expect(diveProgress(990, 1000)).toBe(0);
    expect(diveProgress(1000 + RETURN_DIVE / 2, 1000)).toBeCloseTo(0.25);
    expect(diveProgress(1000 + RETURN_DIVE * 2, 1000)).toBe(1);
    expect(hopFade(990, 1000)).toBe(1);
    expect(hopFade(1000 + (RETURN_DIVE + RETURN_LINGER) / 2, 1000)).toBeCloseTo(0.5);
    expect(hopFade(1000 + RETURN_DIVE + RETURN_LINGER, 1000)).toBe(0);
  });

  it('groups own returns per tick, plane and kind for the feed, never enemy ones', () => {
    const prev = { army: 'nw' as const, tick: 995, entities: [raider(), raider({ id: 'i2' }), raider({ id: 'r1', side: 'se' })] };
    const next = { army: 'nw' as const, tick: 1000 + TICK_RATE / 10, entities: [raider({ plane: 'sky', transit: undefined }), raider({ id: 'i2', plane: 'sky', transit: undefined }), raider({ id: 'r1', side: 'se', plane: 'sky', transit: undefined })] };
    expect(returnArrivals(prev, next)).toEqual([{ tick: 1000, plane: 'sky', x: 10, y: 12, subject: 'interceptor', side: 'nw', count: 2 }]);
    expect(returnArrivals({ ...prev, army: 'se' as const }, next)).toEqual([]);
  });
});

describe('public countdown warning (shared with the derelict gates)', () => {
  it('runs 0 → 1 over the last RETURN_WARN ticks and is -1 outside it', () => {
    expect(countdownWarning(-1)).toBe(-1);
    expect(countdownWarning(RETURN_WARN + 1)).toBe(-1);
    expect(countdownWarning(RETURN_WARN)).toBe(0);
    expect(countdownWarning(RETURN_WARN / 2)).toBeCloseTo(0.5);
    expect(countdownWarning(0)).toBe(1);
  });
});
