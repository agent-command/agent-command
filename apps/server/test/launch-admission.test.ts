import { afterEach, expect, it } from 'vitest';
import type { GameServer } from '../src/app.ts';
import { freshIp, json, postLobby, start, until } from './helpers.ts';

let server: GameServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

it('rejected anonymous requests do not exhaust visitor admission', async () => {
  const running = await start({ matchesPerIp: 1 });
  server = running.server;
  const headers = { 'x-forwarded-for': freshIp() };
  // One malformed request, then more refused retries than the entire visitor table can hold. No simulations start.
  for (let attempt = 0; attempt < 1025; attempt++) {
    const response = await postLobby(running.base, {}, headers);
    expect(await json(response)).toEqual({ error: attempt === 0 ? 'bad_request' : 'rate_limited' });
  }
  const valid = await postLobby(running.base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'host' });
  expect(valid.status).toBe(200);
  const lobby = await json<{ code: string; visitorToken: string }>(valid);
  const grant = await fetch(`${running.base}/api/lobbies/${lobby.code}/connect`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Visitor ${lobby.visitorToken}`, 'x-forwarded-for': freshIp() }, body: '{}',
  });
  expect(grant.status).toBe(200);
}, 30_000);

it('concurrent directory admissions cannot exceed the per-IP reservation cap', async () => {
  const running = await start();
  server = running.server;
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': freshIp() };
  const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${running.base}/api/lobbies/directory/connect`, { method: 'POST', headers, body: '{}' })));
  expect(responses.filter(response => response.status === 200)).toHaveLength(8);
  expect(responses.filter(response => response.status === 429)).toHaveLength(4);
  for (const response of responses) await response.arrayBuffer();
  const other = await fetch(`${running.base}/api/lobbies/directory/connect`, { method: 'POST', headers: { ...headers, 'x-forwarded-for': freshIp() }, body: '{}' });
  expect(other.status).toBe(200);
  const grant = await json<{ roomId: string; token: string }>(other);
  const room = await running.sdk.joinById(grant.roomId, { token: grant.token });
  room.onMessage('lobby:list', () => {});
  await room.leave();
});

it('real featured SSE admission rejects overload and reuses disconnected capacity', async () => {
  const running = await start({ featuredMatch: true, featuredMaxViewers: 2, featuredViewersPerIp: 1 });
  server = running.server;
  const streams: Response[] = [];
  const connect = (ip: string) => fetch(`${running.base}/api/featured/stream`, { headers: { 'x-forwarded-for': ip } });
  try {
    const first = await connect('10.10.0.1'); streams.push(first);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    const duplicate = await connect('10.10.0.1');
    expect(duplicate.status).toBe(429);
    expect(await json(duplicate)).toEqual({ error: 'stream_capacity' });
    const second = await connect('10.10.0.2'); streams.push(second);
    expect(second.status).toBe(200);
    const full = await connect('10.10.0.3');
    expect(full.status).toBe(503);
    expect(full.headers.get('retry-after')).toBe('5');
    expect(await json(full)).toEqual({ error: 'stream_capacity' });
    const reader = first.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: observer');
    await reader.cancel();
    await until(async () => (await json<{ viewers: number }>(await fetch(`${running.base}/api/featured`))).viewers === 1);
    const replacement = await connect('10.10.0.1'); streams.push(replacement);
    expect(replacement.status).toBe(200);
  } finally {
    for (const stream of streams) if (!stream.body?.locked) await stream.body?.cancel();
  }
});
