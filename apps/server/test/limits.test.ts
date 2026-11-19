import { afterAll, beforeAll, expect, it } from 'vitest';
import type { GameServer } from '../src/app.ts';
import { lobbyHandoff, json, postLobby, start, until } from './helpers.ts';

let server: GameServer;
let base: string;

beforeAll(async () => {
  // Keep setup inside the abandonment grace; duration reclamation is independent of lobby retention.
  // The cap leaves room for both handoffs and `b`'s abandonment on a loaded machine. No end grace: the capped
  // match's room closes as soon as its draw is reported.
  ({ server, base } = await start({ maxMatches: 2, abandonGraceMs: 1500, maxMatchMs: 10_000, endGraceMs: 0 }));
});

afterAll(async () => {
  await server.close();
});

const live = async () => (await json<{ matches: number }>(await fetch(`${base}/healthz`))).matches;

// Waits out the 10 s duration cap, so it runs past vitest's 5 s default by design.
it('caps concurrent matches, disposes idle ones, and ends matches at the duration cap', async () => {
  const a = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
  const b = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
  const full = await postLobby(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
  expect(full.status).toBe(409);
  expect(await json(full)).toMatchObject({ error: 'capacity' });

  // Every exact human seat in `a` stays attached; `b` has no remaining game clients.
  await Promise.all(b.connections.map((connection) => connection.room.leave()));
  const owner = a.connections[0]!;
  await until(async () => (await live()) === 1);
  expect(server.host.authenticate(b.token)).toBeUndefined();
  expect(server.host.authenticate(a.token)).toBeDefined();

  // The duration cap ends the match as a draw, which revokes the owner's seat; the room closes after end grace.
  const left = Promise.withResolvers<number>();
  owner.room.onLeave(left.resolve);
  await left.promise;
  await until(async () => (await live()) === 0);
  expect(server.host.authenticate(a.token)).toBeUndefined();
  // Both finished lobbies released themselves with their matches; no explicit leave is needed to play again.
  for (const ticket of [a, b]) {
    expect((await fetch(`${base}/api/lobbies/${ticket.code}/leave`, {
      method: 'POST', headers: { authorization: ticket.authorization, 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(404);
  }

  expect((await postLobby(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true })).status).toBe(200);
}, 30_000);
