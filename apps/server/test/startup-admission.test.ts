import { expect, it } from 'vitest';
import { MSG } from 'playerthree';
import { lobbyHandoff, start, until } from './helpers.ts';

it('admits the first Play-vs-bots request immediately after worker startup with idle capacity', async () => {
  const { server, base } = await start({
    simWorkers: 2, matchesPerWorker: 1, maxMatches: 2, mainMaxMatches: 1,
    admissionLagMs: 25, simWorkerCpuPercent: 75, featuredMatch: false,
  });
  try {
    // No stabilization delay, polling, or admission retry after listen() reports readiness.
    const ticket = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
    expect(typeof ticket.roomId).toBe('string');
    const connection = ticket.connections[0]!;
    try {
      await until(() => connection.inbox.some((message) => message.type === MSG.view));
    } finally { await connection.room.leave(); }
  } finally { await server.close(); }
}, 15_000);
