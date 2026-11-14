/**
 * An Orbit ship gliding round the derelict hull's arc, with the small position corrections the sim makes there (a
 * slide along the wall, a separation nudge): the client spreads each over the frames up to its snapshot. No snap and
 * no jolt in the drawn track or heading: rendering never amplifies a sim correction.
 */
import { describe, expect, it } from 'vitest';
import { createGame } from '@agent-command/game';
import { Entities } from '../src/world/entities.ts';

const noSelection = new Set<string>();
const delta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

describe('Orbit glide rendering', () => {
  it.each([30, 60])('spreads small sim corrections along a hull arc instead of snapping at %i fps', fps => {
    const view = createGame({ seed: 7 }).view('nw');
    const base = view.entities.find(e => e.kind === 'solar')!;
    const units = new Entities(false, undefined, 48);
    // 0.1 tiles/tick round a 14.5-tile arc (the S48 hull's face plus clearance), nudged 0.03 tiles out every 7 ticks.
    const radius = 14.5;
    const step = 0.1;
    const snapshot = (tick: number): void => {
      const angle = (tick * step) / radius;
      const r = radius + (tick % 7 === 3 ? 0.03 : 0);
      units.ingest({
        ...view,
        tick,
        entities: [{ ...base, state: 'moving', heading: angle + Math.PI / 2, x: Math.round((24 + r * Math.cos(angle)) * 100) / 100, y: Math.round((24 + r * Math.sin(angle)) * 100) / 100 }],
      }, 1000 + tick * 50);
    };
    let nextTick = 0;
    let px: number | undefined;
    let py = 0;
    let ph = 0;
    let largestMove = 0;
    let largestTurn = 0;
    for (let frame = 0; frame <= 8 * fps; frame++) {
      const ms = frame * 1000 / fps;
      while (nextTick * 50 <= ms + 1e-6) snapshot(nextTick++);
      units.frame(1000 + ms, ms / 1000, noSelection, undefined, 'nw', base.plane, 26);
      const tr = units.tracks.get(base.id)!;
      if (ms > 1000 && px !== undefined) {
        largestMove = Math.max(largestMove, Math.hypot(tr.rx - px, tr.ry - py));
        largestTurn = Math.max(largestTurn, Math.abs(delta(ph, tr.heading)));
      }
      px = tr.rx;
      py = tr.ry;
      ph = tr.heading;
    }
    // Travel per frame plus the correction spread over its snapshot interval; a snap would add the whole 0.03 at once.
    const travel = step * 20 / fps;
    expect(largestMove).toBeLessThan(travel + 0.03 * (20 / fps) + 0.012);
    // The arc turns 0.4°/tick; the drawn heading never jolts by more than a fraction of a degree per frame.
    expect(largestTurn * 180 / Math.PI).toBeLessThan(0.6);
  });
});
