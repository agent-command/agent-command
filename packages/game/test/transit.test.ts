import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { CELL, TRANSITS, type PlaneTransit } from '../src/rules/contract.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2);

// Test data, never shipped content: a permanent relocation uses the same path as today's timed visit.
const relocation = {
  from: 'sky', to: 'orbit', cost: { alloy: 0, energy: 0 }, prep: 1, travel: 1,
  stay: 0, cooldown: 0, telegraph: 'contrail', arrival: 'column',
} as const satisfies PlaneTransit;

describe('registry plane transits', () => {
  it('omits inactive transit and elapsed readiness while preserving explicit non-default stances', () => {
    const g = createGame({ seed: 19 });
    const e = g.sim.add('interceptor', BLUE, 'sky', 20, 20);
    e.transitReady = g.tick;
    const out = () => g.view('nw').entities.find((v) => v.id === g.entityId('nw', e.id))!;
    expect(out().transit).toBeUndefined();
    expect(out().transitReady).toBeUndefined();
    expect(out().stance).toBeUndefined();
    e.stance = 'hold';
    expect(out().stance).toBe('hold');
    e.stance = 'defensive';
    expect(out().stance).toBe('defensive');
    e.transitReady++;
    expect(out().transitReady).toBe(g.tick + 1);
  });

  it('runs permanent travel without an ability-specific timer', () => {
    const g = createGame({ seed: 19 });
    const e = g.sim.add('interceptor', BLUE, 'sky', 20, 20);
    expect(g.sim.canTransit(e, relocation)).toBe(true);
    g.sim.startTransit(e, relocation);
    expect(g.view('nw').entities.find((v) => v.id === g.entityId('nw', e.id))?.transit)
      .toEqual({ to: 'orbit', at: 2, until: 0 });
    g.step();
    expect(e.plane).toBe('sky');
    g.step();
    expect(e.plane).toBe('orbit');
    expect(e.kind).toBe('interceptor');
    expect(e.transitKind).toBeUndefined();
    expect(e.transitAt).toBe(0);
  });

  it('uses the same arrival path for zero-duration portals without retaining timer state', () => {
    const g = createGame({ seed: 19, options: { map: { params: { spireInset: 8 } } } });
    g.sim.cells.fill(CELL.tunnel);
    const e = g.sim.add('trooper', BLUE, 'surface', 8, 8);
    g.sim.startTransit(e, TRANSITS.descend, 8.5, 8.5);
    expect(e.plane).toBe('depths');
    expect(e.x).toBe(8.5);
    expect(e.y).toBe(6.5); // The portal lands on the root's nearest open apron cell, not inside its footprint.
    expect(e.transitAt).toBe(0);
    expect(e.transitUntil).toBe(0);
    expect(e.transitReady).toBe(0);
    expect(e.transitKind).toBeUndefined();
    g.sim.startTransit(e, TRANSITS.emerge, 8.5, 8.5);
    expect(e.plane).toBe('surface');
    expect(e.cell).toBe(-1);
  });
});
