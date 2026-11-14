import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { connectSeat } from '@playerthree/runner';
import { PLANES } from '@agent-command/game/contract';
import { start } from './helpers.ts';

// Real AC adapter, policy sandbox and HTTP MCP transport; no long game or balance sweep.
describe('four-plane commander HTTP lifecycle', () => {
  it('restores each plane through two real matches and reconnects with role-local final receipts', { timeout: 15_000 }, async () => {
    const { server, base } = await start({ rules: { spire: { timeCap: 77 } } });
    const owner = 'lifecycle_four_planes';
    const commander = server.host.commanders.create(owner, { name: 'Four planes', kind: 'agent', roles: [...PLANES], isolation: { independentSessions: true } });
    const token = server.host.commanders.token(owner, commander.id);
    let agent = await connectSeat({ url: `${base}/mcp`, token });
    // Respect the shared commander's normal 10-call/s budget, including across reconnects.
    const request = async (name: string, args: Record<string, unknown>) => {
      await sleep(110);
      return agent.call(name, args);
    };
    try {
      for (const [index, role] of PLANES.entries()) {
        const result = await request('policy_deploy', { role, runtime: 'js', code: `let calls = 0; function init(data) { if (data.rules.spire.timeCap !== 77) throw new Error('configured rules missing'); } function think() { log('${role}', ++calls); return []; }` });
        expect(result, result.text).toMatchObject({ isError: false, structured: { ok: true, version: index + 1 } });
      }
      let previous: string | undefined;
      for (let round = 0; round < 2; round++) {
        for (const role of PLANES) {
          server.host.commanders.reserve(owner, commander.id, role, { team: 'nw', start: { kind: 'host' } });
          const ready = await request('game_ready', { role });
          expect(ready, ready.text).toMatchObject({ isError: false, structured: { phase: 'lobby', you: { ready: true } } });
        }
        const teams = round === 0 ? ['nw', 'se'] as const : ['nw', 'ne', 'se', 'sw'] as const;
        const match = server.host.createMatch({ seed: 17 + round, teams, realtime: false,
          ...(round === 1 ? { options: { map: { name: 'four_corners' } } } : {}),
          assignments: PLANES.map((role) => ({ team: 'nw', role, owner, kind: 'agent' as const, commander: { id: commander.id } })) });
        expect(match.teams).toEqual(teams);
        if (round === 1) expect(match.replay().options).toMatchObject({ map: { name: 'four_corners' }, spire: { timeCap: 77 } });
        for (const [index, role] of PLANES.entries()) {
          expect(await request('policy_status', { role })).toMatchObject({ isError: false, structured: { policy: { version: index + 1, calls: 0 } } });
          const entry = await request('game_wait', { role, seconds: 0 });
          expect(entry).toMatchObject({ isError: false, structured: { phase: 'match', outcome: 'running' } });
          if (previous) expect(entry.structured).toMatchObject({ previousMatch: { match: previous, role, disposition: 'final', outcome: 'win' } });
        }
        await match.step(1);
        for (const [index, role] of PLANES.entries()) expect(await request('policy_status', { role })).toMatchObject({ isError: false,
          structured: { policy: { version: index + 1, successfulCalls: 1, logs: [`${role} 1`] } } });
        const pending = PLANES.map((role) => request('game_wait', { role, seconds: 60 }));
        // A subsequent round trip ensures the waits are submitted before the authoritative end.
        await request('policy_status', { role: 'surface' });
        match.end(Object.fromEntries(teams.map((team) => [team, team === 'nw' ? 'win' : 'loss'] as const)));
        for (const [index, result] of (await Promise.all(pending)).entries()) expect(result).toMatchObject({ isError: false,
          structured: { outcome: 'win', previousMatch: { match: match.id, role: PLANES[index], team: 'nw', outcome: 'win', disposition: 'final' } } });
        await agent.close();
        match.dispose();
        agent = await connectSeat({ url: `${base}/mcp`, token });
        for (const role of PLANES) expect(await request('game_observe', { role })).toMatchObject({ isError: false,
          structured: { phase: 'lobby', previousMatch: { match: match.id, role, team: 'nw', outcome: 'win', disposition: 'final' } } });
        previous = match.id;
      }
      expect(server.host.commanders.roster(owner)[0]!.policy.activeByRole).toEqual(Object.fromEntries(PLANES.map((role, index) => [role, index + 1])));
    } finally { await agent.close(); await server.close(); }
  });
});
