import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { CELL, TICK_RATE, type ArmyId, type MatchData, type Observation } from '../src/rules/contract.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { DECIDING_STARTERS } from './starter-policies.ts';

function fixture(team: ArmyId) {
  const g = createGame({ seed: 91, options: { map: { params: { homeLodes: 0, contestedZones: [] } } } });
  const obs = g.observe({ team, role: 'depths' }, 0);
  const matchData = g.matchData({ team, role: 'depths' });
  const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: 47 - x, y: 47 - y };
  const cell = (x: number, y: number) => { const p = point(x, y); return p.y * g.sim.size + p.x; };
  obs.depths!.fill(CELL.bedrock);
  // Clear of the solid 3×3 Spire root (cells 7–9): a tap site must not overlap any Depths footprint.
  for (const y of [12, 13]) { obs.depths![cell(12, y)] = CELL.tunnel; obs.depths![cell(13, y)] = CELL.rock; obs.depths![cell(14, y)] = CELL.magma; }
  obs.pockets = [12, 13].map(y => ({ ...point(14, y), id: 1 }));
  matchData.faults = []; obs.lodes = []; obs.cracks = []; obs.charges = []; obs.queue = [];
  obs.research.available = [];
  obs.res.alloy = obs.res.freeAlloy = 2000; obs.res.energy = obs.res.freeEnergy = 2000;
  const p = point(12, 12);
  obs.entities = obs.entities.filter(e => e.side === team && e.kind === 'digger').map(e => ({ ...e, x: p.x + 0.5, y: p.y + 0.5, state: 'idle' as const }));
  return { obs, matchData, point };
}
const decide = (mode: 'bot' | 'policy', obs: Observation, matchData: MatchData): AgentCommandIntent[] => {
  if (mode === 'bot') {
    const bot = createBot(obs.army, 'depths', 'veteran');
    bot.init?.(matchData);
    return bot.think(obs);
  }
  const policy = runInNewContext(`${DECIDING_STARTERS.depths}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
  policy.init(matchData);
  return structuredClone(policy.think(obs));
};
const taps = (intents: AgentCommandIntent[]) => intents.filter(i => i.kind === 'queue_add' && i.item === 'geothermal');

for (const mode of ['bot', 'policy'] as const) describe(`${mode} fallback decisions`, () => {
  for (const team of ['nw', 'se'] as const) {
    it(`${team}: preserves healthy Orbit and builds a tap only after loss`, () => {
      const { obs, matchData, point } = fixture(team);
      expect(taps(decide(mode, obs, matchData))).toEqual([]);
      obs.spire.find(s => s.plane === 'orbit')!.hp = 0;
      expect(taps(decide(mode, obs, matchData))).toHaveLength(1);
      expect(taps(decide(mode, obs, matchData))[0]).toMatchObject({ ...point(13, 12), item: 'geothermal' });
      obs.pockets = [];
      expect(taps(decide(mode, obs, matchData))).toEqual([]);
    });
    it(`${team}: deduplicates multi-cell pockets using queued cell-centre coordinates`, () => {
      const { obs, matchData, point } = fixture(team);
      obs.spire.find(s => s.plane === 'orbit')!.hp = 0;
      const p = point(13, 12);
      obs.queue = [{ id: 'q_1', item: 'geothermal', plane: 'depths', by: 'depths', byCtl: 'human', x: p.x + 0.5, y: p.y + 0.5, alloy: 120, energy: 0, heldAlloy: 0, heldEnergy: 0, recovery: false, paid: false, next: true, status: 'waiting', progress: 0 }];
      expect(taps(decide(mode, obs, matchData))).toEqual([]);
    });
    it(`${team}: replaces rootless diggers at a completed own Shaft, charging the full surcharge`, () => {
      const g = createGame({ seed: 91 });
      const s = g.sim, t = s.armies[s.armyIndex(team)]!;
      for (const e of s.ents) if (e.kind !== 'spire') e.dead = true;
      const p = team === 'nw' ? 12.5 : s.size - 12.5;
      const shaft = s.build(s.armyIndex(team), 'shaft', p, p, 'surface');
      shaft.built = true;
      shaft.state = 'active';
      const seat = { team, role: 'depths' } as const;
      const matchData = g.matchData(seat);
      // A living root remains the normal producer even when a Shaft exists.
      expect(decide(mode, g.observe(seat, 0), matchData).filter(i => i.kind === 'queue_add' && i.item === 'digger')
        .every(i => i.kind === 'queue_add' && i.producer === undefined)).toBe(true);
      t.spire.depths.hp = 0;
      t.alloy = 2000; t.energy = 2000;
      const intent = decide(mode, g.observe(seat, 0), matchData).find(i => i.kind === 'queue_add' && i.item === 'digger');
      // No queue position: the simulation funds and starts a recovery digger ahead of its lane (allocateQueue).
      expect(intent).toEqual({ kind: 'queue_add', item: 'digger', producer: g.entityId(team, shaft.id) });
      expect(g.apply(seat, intent!, { source: mode })).toEqual({ ok: true });
      const alloy = Math.ceil(s.stats.digger.alloy * s.econ.shaftDiggerMultiplier);
      const energy = Math.ceil(s.stats.digger.energy * s.econ.shaftDiggerMultiplier);
      expect(g.observe(seat, 0).queue[0]).toMatchObject({ alloy, energy, producer: g.entityId(team, shaft.id) });
      const before = t.alloy;
      g.step();
      expect(t.queue[0]!.started).toBe(true);
      expect(t.alloy).toBeCloseTo(before - alloy + s.econ.spireAlloyRate * s.econ.rootlessTrickle / TICK_RATE);
      t.queue.length = 0;
      shaft.built = false;
      shaft.state = 'constructing';
      expect(decide(mode, g.observe(seat, 0), matchData).some(i => i.kind === 'queue_add' && i.item === 'digger')).toBe(false);
    });
  }
});
