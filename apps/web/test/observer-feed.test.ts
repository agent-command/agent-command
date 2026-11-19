import { expect, it, vi } from 'vitest';
import type { ObserverFrame, ObserverMessage } from 'playerthree/protocol';
import { ObserverFeed, type PlayedFrame } from '../src/observer-feed.ts';

const ready = (frame: Partial<ObserverFrame> & { sequence: number }): ObserverMessage => ({
  op: 'observer', state: 'ready',
  frame: { tick: frame.sequence, recordedAt: frame.sequence * 50, releaseAt: 0, perspective: 'all', ...frame },
});

it('rebuilds keyframe + deltas and plays every frame out evenly on the recording clock despite bursts', () => {
  const played: PlayedFrame[] = [];
  const resync = vi.fn();
  const feed = new ObserverFeed('all', (frame) => played.push(frame), resync);
  // Transit 1000 ms for the first frames, then a burst: frames 4-6 arrive together 100 ms late.
  feed.receive(ready({ sequence: 1, world: { tick: 1, units: [{ id: 'u_1', x: 0 }] } }), 1050);
  feed.receive(ready({ sequence: 2, delta: { v: { tick: 2 }, o: { units: { k: 1, u: { u_1: { v: { x: 1 } } } } } } }), 1100);
  feed.receive(ready({ sequence: 3, delta: { v: { tick: 3 } } }), 1150);
  for (const sequence of [4, 5, 6]) feed.receive(ready({ sequence, delta: { v: { tick: sequence } } }), 1350);
  const deliveredAt: number[] = [];
  for (let now = 1000; now <= 1800; now += 1) {
    const before = played.length;
    feed.pump(now);
    for (let i = before; i < played.length; i++) deliveredAt.push(now);
  }
  expect(played.map(({ frame }) => frame.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(played[1]!.world).toEqual({ tick: 2, units: [{ id: 'u_1', x: 1 }] });
  // Unchanged subtrees keep identity across frames (the renderer reuses them).
  expect((played[2]!.world as { units: unknown }).units).toBe((played[1]!.world as { units: unknown }).units);
  // Burst frames come out at the recording cadence (50 ms apart), not all at once.
  const gaps = deliveredAt.slice(1).map((at, i) => at - deliveredAt[i]!);
  expect(gaps.every((gap) => gap >= 45 && gap <= 55)).toBe(true);
  expect(resync).not.toHaveBeenCalled();
});

it('requests one keyframe after a missed delta and ignores other perspectives', () => {
  const played: PlayedFrame[] = [];
  const resync = vi.fn();
  const feed = new ObserverFeed('all', (frame) => played.push(frame), resync);
  feed.receive(ready({ sequence: 1, world: { tick: 1 } }), 0);
  feed.receive(ready({ sequence: 3, delta: { v: { tick: 3 } } }), 10);
  feed.receive(ready({ sequence: 4, delta: { v: { tick: 4 } } }), 20);
  expect(resync).toHaveBeenCalledTimes(1);
  feed.receive(ready({ sequence: 5, perspective: 'se', world: { secret: true } }), 30);
  feed.receive(ready({ sequence: 5, world: { tick: 5 } }), 30);
  feed.pump(10_000);
  expect(played.map(({ world }) => world)).toEqual([{ tick: 5 }]);
});
