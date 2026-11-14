import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameServer } from '../src/app.ts';
import { freshIp, json, lobbyHandoff, namedCommander, start } from './helpers.ts';

let server: GameServer;
let base: string;

beforeAll(async () => {
  ({ server, base } = await start({ matchesPerIp: 50 }));
});

afterAll(async () => {
  await server.close();
});

interface State {
  match: string | null;
  team: string | null;
  seats: { team: string; role: string }[];
  events: { team?: string }[];
  commanders?: { id: string; name: string; roles: string[]; seated: { team: string } | null }[];
}

const state = (credential: string) => fetch(`${base}/playerthree/player/state`, { headers: { authorization: `Bearer ${credential}` } });

describe('player API (/playerthree/player): the in-game agent console', () => {
  it('a profile sees its own commanders, then its own team once a match seats them; never the opponent', async () => {
    const profile = await json<{ id: string; secret: string }>(await fetch(`${base}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{}' }));
    const commander = await namedCommander(base, profile.secret, 'Console strategist', ['orbit', 'sky']);
    const lobby = await json<State>(await state(profile.secret));
    expect(lobby).toMatchObject({ match: null, team: null, seats: [] });
    expect(lobby.commanders).toEqual([expect.objectContaining({ id: commander.id, name: 'Console strategist', roles: ['orbit', 'sky'] })]);
    // Commander tokens are the roster API's business, not the console's.
    expect(JSON.stringify(lobby)).not.toMatch(/"token"/);

    const ticket = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true }, `Bearer ${profile.secret}`);
    const match = server.host.authenticate(ticket.token)!.match;
    expect(await json<State>(await state(profile.secret))).toMatchObject({ match: null, team: null, seats: [] });
    for (const seatTicket of ticket.tickets) {
      const credential = seatTicket.token;
      const s = await json<State>(await state(credential));
      expect(s.match).toBe(match.id);
      expect(s.team).toBe('nw');
      expect(s.seats).toEqual([expect.objectContaining({ team: 'nw', role: seatTicket.role })]);
      expect(s.events.every((e) => e.team === undefined || e.team === 'nw')).toBe(true);
    }
  });

  it('refuses spectators, unknown credentials and writes', async () => {
    const ticket = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
    const match = server.host.authenticate(ticket.token)!.match;
    const observer = match.mintObserverToken({ kind: 'omniscient', teams: ['nw', 'se'], delayMs: 0 }, { owner: 'observer:test' });
    expect((await state(observer.token)).status).toBe(403);
    expect((await state('x'.repeat(43))).status).toBe(401);
    expect((await fetch(`${base}/playerthree/player/state`)).status).toBe(401);
    expect((await fetch(`${base}/playerthree/player/state`, { method: 'POST', headers: { authorization: `Bearer ${ticket.token}` } })).status).toBe(405);
  });
});
