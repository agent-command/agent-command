/** One warmed real-network match, profiled only after initialization. Run from the repository root. */
import { Session } from 'node:inspector';
import { writeFile } from 'node:fs/promises';
import { Client } from '@colyseus/sdk';
import { MSG } from 'playerthree/protocol';
import { createGameServer } from '../../../apps/server/src/app.ts';
import { loadConfig } from '../../../apps/server/src/config.ts';
const server = createGameServer(loadConfig({ NODE_ENV: 'production', PORT: '0', HOST: '127.0.0.1', SIM_WORKERS: '0', FEATURED_MATCH: '0', MAIN_MAX_MATCHES: '2' }), undefined, { warmupTicks: 9600, seed: 41 });
const port = await server.listen();
const base = `http://127.0.0.1:${port}`;
// The public lobby flow: a private all-bot auto-start lobby whose anonymous creator observes the match.
const created = await fetch(`${base}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'benchmark', autoStart: true }) });
const lobby = await created.json() as { code: string; visitorToken: string };
if (created.status !== 200) throw new Error(`Profile fixture failed: ${JSON.stringify(lobby)}`);
async function route<T>(path: string): Promise<T> {
  const response = await fetch(`${base}/api/lobbies/${lobby.code}/${path}`, {
    method: 'POST', headers: { authorization: `Visitor ${lobby.visitorToken}`, 'content-type': 'application/json' }, body: '{}',
  });
  if (response.status !== 200) throw new Error(`Profile fixture ${path} failed: ${response.status}`);
  return await response.json() as T;
}
const client = new Client(base);
const grant = await route<{ roomId: string; token: string }>('connect');
const pregame = await client.joinById(grant.roomId, { token: grant.token });
const started = Promise.withResolvers<void>();
pregame.onMessage('lobby:snapshot', (snapshot: { phase: string }) => { if (snapshot.phase === 'started') started.resolve(); });
pregame.onMessage('*', () => {});
await started.promise;
await pregame.leave();
const ticket = await route<{ roomId: string; token: string }>('ticket');
const observer = await client.joinById(ticket.roomId, { token: ticket.token });
observer.onMessage('*', () => {});
observer.send(MSG.observer, { perspective: 'all' });
const session = new Session(); session.connect();
function command(method: string) {
  const pending = Promise.withResolvers<unknown>();
  session.post(method, (error, value) => error ? pending.reject(error) : pending.resolve(value));
  return pending.promise;
}
await command('Profiler.enable'); await command('Profiler.start');
const elapsed = Promise.withResolvers<void>(); setTimeout(elapsed.resolve, 20_000); await elapsed.promise;
const profile = await command('Profiler.stop') as { profile: unknown };
await writeFile('/tmp/ac-hug/warmed-match.cpuprofile', JSON.stringify(profile.profile));
session.disconnect();
await observer.leave(); await server.close();
console.log('CPU profile saved: /tmp/ac-hug/warmed-match.cpuprofile (20 seconds, seed 41, 9600 warmup ticks, real lobby observer)');
