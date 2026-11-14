import { describe, expect, it } from 'vitest';
import { createGame, isFlank, LodeRecorder } from '@agent-command/game';

describe('lode measurements', () => {
  it('uses fixed slot geometry: the empty corners of two-slot maps, edge midpoints of four-slot maps', () => {
    expect(isFlank(40, 8, 48, 2)).toBe(true);
    expect(isFlank(8, 40, 48, 2)).toBe(true);
    expect(isFlank(24, 24, 48, 2)).toBe(false);
    expect(isFlank(8, 8, 48, 2)).toBe(false);
    expect(isFlank(30, 8, 48, 2)).toBe(false);
    // Four slots: each flank sits between two neighbouring corners (all four rotations), never at a base.
    for (const [x, y] of [[24, 8], [40, 24], [24, 40], [8, 24]] as const) expect(isFlank(x, y, 48, 4)).toBe(true);
    expect(isFlank(40, 8, 48, 4)).toBe(false);
    expect(isFlank(24, 24, 48, 4)).toBe(false);
    // Scaled with the map: the S48 anchor scales to M64.
    expect(isFlank(32, 64 / 6, 64, 4)).toBe(true);
  });

  it('separates completed frame deaths from unfinished site losses and counts rebuilds', () => {
    const rec = new LodeRecorder(createGame({ seed: 1001, options: {} }).sim);
    const event = { tick: 1, plane: 'surface', subject: 'headframe', side: 0, x: 40.5, y: 8.5 } as const;
    rec.event({ ...event, kind: 'structure_lost' });
    rec.event({ ...event, kind: 'constructed' });
    rec.event({ ...event, kind: 'structure_lost' });
    rec.event({ ...event, kind: 'constructed' });
    expect(rec.metrics.sides.nw).toMatchObject({ headframesBuilt: 2, headframesLost: 1, flankBuilt: 2, flankLost: 1, flankSitesLost: 1 });
    expect(rec.metrics.sides.se!.flankBuilt).toBe(0);
  });

  it('sums earned income only, independent of stock, refunds and spend', () => {
    const game = createGame({ seed: 1001, options: {} });
    const rec = new LodeRecorder(game.sim);
    const sim = game.sim;
    const t = sim.armies[0]!;
    // Earned alloy is the sim's accounted income total (offset 0); spend (2), refunds (4) and raw stock never count.
    sim.account(0, 0, 12, 0);
    t.stats.lodeAlloy = 4;
    rec.collect();
    sim.account(0, 0, 3, 0);
    sim.account(0, 2, 50, 0);
    sim.account(0, 4, 20, 0);
    t.alloy += 1000;
    t.stats.lodeAlloy = 6;
    rec.collect();
    expect(rec.metrics.sides.nw!.earnedAlloy).toBe(15);
    expect(rec.metrics.sides.nw!.lodeAlloy).toBe(6);
  });
});
