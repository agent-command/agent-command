/** Elimination, last-alliance-standing victory and ranks (DESIGN §15.7). */
import { describe, expect, it } from 'vitest';
import { namedMap } from '../src/maps/maps.ts';
import { CELL } from '../src/rules/contract.ts';
import { Sim } from '../src/sim/sim.ts';
import { type Army, NEUTRAL } from '../src/util/teams.ts';

const four = (): Sim => new Sim(5, {}, namedMap('four_corners')!);

/** Knock `army`'s Surface segment down with a hit from `by` (resolved by the next step). */
function fell(sim: Sim, army: Army, by: number = NEUTRAL): void {
  const seg = sim.armies[army]!.spire.surface;
  sim.damage(seg, seg.hp + 1, by, true, 'test');
}

describe('elimination', () => {
  it('removes every entity of the fallen army, frees its islands and gates, forgets its ghosts and goes on', () => {
    const sim = four();
    const victim = 2;
    const t = sim.armies[victim]!;
    // A bulkhead, a held island and a ghost others remember.
    const c = sim.armies[victim]!.spire.depths.cell;
    sim.cells[c + 1] = CELL.tunnel;
    const bulkhead = sim.add('bulkhead', victim, 'depths', (c + 1) % sim.size + 0.5, Math.floor((c + 1) / sim.size) + 0.5);
    bulkhead.cell = c + 1;
    sim.gate[c + 1] = sim.hostileMask[victim]!;
    sim.bulkheadAt[c + 1] = bulkhead.id;
    const island = sim.ents.find((e) => e.kind === 'island')!;
    sim.setSide(island, victim);
    sim.armies[0]!.group.memory.set(bulkhead.id, { kind: 'bulkhead', side: victim, plane: 'depths', x: bulkhead.x, y: bulkhead.y, seen: 0 });
    sim.charges.push({ side: victim, c: c + 1, at: sim.tick + 1000, defuse: 0, stack: 1, reach: sim.econ.chasmReach, known: sim.armies[victim]!.group.bit });
    t.alloy = 500;
    fell(sim, victim, 1);
    sim.step();
    expect(sim.over).toBe(false);
    expect(sim.inPlay(victim)).toBe(false);
    expect(sim.eliminatedAt[victim]).toBe(sim.tick);
    expect(sim.eliminatedBy[victim]).toBe(1);
    expect(sim.ents.some((e) => e.side === victim)).toBe(false);
    expect(island.side).toBe(NEUTRAL);
    expect(sim.gate[c + 1]).toBe(0);
    expect(sim.armies[0]!.group.memory.has(bulkhead.id)).toBe(false);
    expect(sim.charges.some((ch) => ch.side === victim)).toBe(false);
    expect(t.alloy).toBe(0);
    expect(t.queue).toEqual([]);
    // Removal is not a kill: the killer of the Surface segment got its one structure credit, nothing more.
    expect(sim.armies[1]!.stats.kills).toBe(0);
    // The rest keep playing.
    for (let i = 0; i < 40; i++) sim.step();
    expect(sim.over).toBe(false);
  });

  it('the last alliance standing wins; later eliminations rank higher', () => {
    const sim = four();
    fell(sim, 3);
    sim.step();
    fell(sim, 1);
    sim.step();
    expect(sim.over).toBe(false);
    fell(sim, 0);
    sim.step();
    expect(sim.result?.outcome).toEqual(['loss', 'loss', 'win', 'loss']);
    expect(sim.result?.rank).toEqual([2, 3, 1, 4]);
  });

  it('armies falling on the same tick are ordered by their Spire HP just before removal; equal totals share a rank', () => {
    const sim = four();
    sim.armies[0]!.spire.orbit.hp -= 100;
    fell(sim, 0);
    fell(sim, 1);
    fell(sim, 3);
    sim.step();
    // Army 2 stands alone: it wins; 1 and 3 fell with equal HP, 0 with less.
    expect(sim.result?.outcome).toEqual(['loss', 'loss', 'win', 'loss']);
    expect(sim.result?.rank).toEqual([4, 2, 1, 2]);
  });

  it('when every remaining alliance falls on one tick, more total Spire HP wins', () => {
    const sim = four();
    fell(sim, 3);
    sim.step();
    sim.armies[0]!.spire.sky.hp -= 50;
    fell(sim, 0);
    fell(sim, 1);
    fell(sim, 2);
    sim.step();
    expect(sim.result?.outcome).toEqual(['loss', 'draw', 'draw', 'loss']);
    expect(sim.result?.rank).toEqual([3, 1, 1, 4]);
  });

  it('at the time cap surviving alliances rank by total Spire HP; eliminated ones rank below', () => {
    const sim = four();
    fell(sim, 1);
    sim.step();
    sim.armies[0]!.spire.depths.hp -= 10;
    sim.armies[3]!.spire.depths.hp -= 20;
    sim.tick = sim.timeCap - 1;
    sim.step();
    expect(sim.result?.outcome).toEqual(['loss', 'loss', 'win', 'loss']);
    expect(sim.result?.rank).toEqual([2, 4, 1, 3]);
  });

  it('three armies on a four-slot map: an unclaimed slot is neutral ground', () => {
    const sim = new Sim(5, {}, namedMap('four_corners')!, [{ slot: 0, colour: 'blue' }, { slot: 1, colour: 'red' }, { slot: 3, colour: 'green' }]);
    expect(sim.allArmies).toEqual([0, 1, 2]);
    expect([...sim.armyFrame.slice(0, 3)]).toEqual([0, 1, 3]);
    // Slot 2's home tunnels exist but belong to nobody.
    const home2 = sim.armies[0]!.spire.depths.cell;
    expect(sim.owner[sim.n - 1 - home2]).toBe(0);
    expect(sim.ents.filter((e) => e.kind === 'spire')).toHaveLength(12);
  });

  it('rejects matches that do not fit the map', () => {
    const doc = namedMap('four_corners')!;
    expect(() => new Sim(1, {}, doc, [{ slot: 0, colour: 'blue' }])).toThrow(/armies/);
    expect(() => new Sim(1, {}, doc, [{ slot: 0, colour: 'blue' }, { slot: 0, colour: 'red' }])).toThrow(/slot/);
    expect(() => new Sim(1, {}, doc, [{ slot: 0, colour: 'blue' }, { slot: 4, colour: 'red' }])).toThrow(/slot/);
    expect(() => new Sim(1, {}, doc, [{ slot: 0, colour: 'blue' }, { slot: 2, colour: 'blue' }])).toThrow(/colour/);
  });
});

describe('two armies reduce to the old outcome rule', () => {
  it('one Surface segment falls: the other army wins, rank 1 and 2', () => {
    const sim = new Sim(4);
    fell(sim, 1, 0);
    sim.step();
    expect(sim.result).toEqual({ outcome: ['win', 'loss'], rank: [1, 2] });
    // The match is over: nothing is removed.
    expect(sim.ents.some((e) => e.side === 1 && e.unit)).toBe(true);
  });

  it('both fall on one tick: more total Spire HP wins, equal draws', () => {
    const even = new Sim(4);
    fell(even, 0);
    fell(even, 1);
    even.step();
    expect(even.result).toEqual({ outcome: ['draw', 'draw'], rank: [1, 1] });
    const ahead = new Sim(4);
    ahead.armies[1]!.spire.sky.hp -= 1;
    fell(ahead, 0);
    fell(ahead, 1);
    ahead.step();
    expect(ahead.result).toEqual({ outcome: ['win', 'loss'], rank: [1, 2] });
  });

  it('at the time cap more total Spire HP wins, equal draws', () => {
    const sim = new Sim(4);
    sim.armies[0]!.spire.orbit.hp -= 1;
    sim.tick = sim.timeCap - 1;
    sim.step();
    expect(sim.result).toEqual({ outcome: ['loss', 'win'], rank: [2, 1] });
  });
});
