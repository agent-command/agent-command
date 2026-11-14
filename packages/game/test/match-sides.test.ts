import { describe, expect, it } from 'vitest';
import { createPlayerThreeHost } from 'playerthree/host';
import { definition, type AgentCommandGame } from '../src/agent/adapter.ts';

describe('PlayerThree match sides', () => {
  it('plays the corners of the map, each army on its own colour', () => {
    expect(() => definition.create({ seed: 1, teams: ['nw'] })).toThrow(/armies/);
    expect(() => definition.create({ seed: 1, teams: ['nw', 'se'], alliances: { blue: ['nw', 'se'] } })).toThrow('unsupported alliances');
    const game = definition.create({ seed: 1, teams: ['nw', 'se'], alliances: { blue: ['nw'], red: ['se'] } }) as AgentCommandGame;
    expect(game.sim.seed).toBe(1);
    expect(game.matchData({ team: 'nw', role: 'surface' }).armies.map((a) => [a.id, a.colour])).toEqual([['nw', 'blue'], ['se', 'red']]);
    const host = createPlayerThreeHost({ definition });
    try {
      expect(() => host.createMatch({ seed: 1, realtime: false, teams: ['se'] })).toThrow();
      expect(host.createMatch({ seed: 1, realtime: false, teams: ['se', 'nw'] }).teams).toEqual(['nw', 'se']);
    } finally { host.dispose(); }
  });

  it('adopts an early end and ranks it like the two-army result', () => {
    const games: AgentCommandGame[] = [];
    const recording = { ...definition, create: (o: Parameters<typeof definition.create>[0]) => { const g = definition.create(o) as AgentCommandGame; games.push(g); return g; } };
    const recorded = createPlayerThreeHost({ definition: recording });
    try {
      const won = recorded.createMatch({ seed: 2, realtime: false, teams: ['nw', 'se'], botLevel: { nw: 'idle', se: 'idle' } });
      expect(won.end({ se: 'win', nw: 'loss' })).toEqual({ nw: 'loss', se: 'win' });
      expect(games[0]!.sim.result).toEqual({ outcome: ['loss', 'win'], rank: [2, 1] });
      expect([won.rank('nw'), won.rank('se')]).toEqual([2, 1]);
      const drawn = recorded.createMatch({ seed: 2, realtime: false, teams: ['nw', 'se'], botLevel: { nw: 'idle', se: 'idle' } });
      expect(drawn.end('draw')).toEqual({ nw: 'draw', se: 'draw' });
      expect(games[1]!.sim.result).toEqual({ outcome: ['draw', 'draw'], rank: [1, 1] });
      expect([drawn.rank('nw'), drawn.rank('se')]).toEqual([1, 1]);
    } finally { recorded.dispose(); }
  });
});
