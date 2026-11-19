import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { connectSeat } from '@playerthree/runner';
import { MSG } from 'playerthree';
import { MATCH_CLOSE, type LobbySnapshot } from '@agent-command/game/lobby';
import { loadConfig } from '../src/config.ts';
import { lobbyHandoff, lobbyRoute, join, json, postLobby, start, until, type Handoff } from './helpers.ts';

const ADMIN = 'drain-test-admin-token-0123456789';
const UPDATING = { error: 'server_updating', detail: 'Server updating, try again in a moment' };

function dev(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}/dev/matches${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('deployment drain', () => {
  it('documents configurable drain durations and rejects unsafe values', () => {
    expect(loadConfig({})).toMatchObject({ drainMaxMs: 1_200_000, drainLogIntervalMs: 30_000 });
    expect(loadConfig({ DRAIN_MAX_SECONDS: '20', DRAIN_LOG_INTERVAL_SECONDS: '5' })).toMatchObject({ drainMaxMs: 20_000, drainLogIntervalMs: 5000 });
    for (const value of ['0', '-1', '1.5', 'NaN']) {
      expect(() => loadConfig({ DRAIN_MAX_SECONDS: value })).toThrow('DRAIN_MAX_SECONDS');
      expect(() => loadConfig({ DRAIN_LOG_INTERVAL_SECONDS: value })).toThrow('DRAIN_LOG_INTERVAL_SECONDS');
    }
  });

  it('refuses new work, preserves live WebSocket/MCP sessions and reconnections, then closes at the normal outcome', async () => {
    const { server, base, sdk } = await start({ devAdminToken: ADMIN, drainMaxMs: 10_000, endGraceMs: 250, lobbyCountdownMs: 350 });
    try {
      const lobbyPost = async <T>(path: string, body: unknown, secret?: string): Promise<T> => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
          body: JSON.stringify(body),
        });
        expect(response.status, path).toBe(200);
        return json<T>(response);
      };
      const profile = await lobbyPost<{ secret: string }>('/api/profile', {});
      const opponent = await lobbyPost<{ secret: string }>('/api/profile', {});
      const authorization = `Bearer ${profile.secret}`;
      const lobby = await lobbyPost<{ code: string }>('/api/lobbies', { mapId: 'ridges', layoutId: 'duel', visibility: 'public', preset: 'host' }, profile.secret);
      await lobbyPost('/api/lobbies/join', { code: lobby.code }, opponent.secret);
      const blueGrant = await lobbyPost<{ roomId: string; token: string }>(`/api/lobbies/${lobby.code}/connect`, {}, profile.secret);
      const redGrant = await lobbyPost<{ roomId: string; token: string }>(`/api/lobbies/${lobby.code}/connect`, {}, opponent.secret);
      const blueLobby = await sdk.joinById(blueGrant.roomId, { token: blueGrant.token });
      const redLobby = await sdk.joinById(redGrant.roomId, { token: redGrant.token });
      const snapshots: LobbySnapshot[] = [];
      const results = new Map<number, { seq: number; ok: boolean; code?: string }>();
      blueLobby.onMessage('lobby:snapshot', (snapshot: LobbySnapshot) => snapshots.push(snapshot));
      for (const room of [blueLobby, redLobby]) {
        room.reconnection.enabled = false;
        room.onMessage('lobby:result', (result: { seq: number; ok: boolean; code?: string }) => results.set(result.seq, result));
      }
      let seq = 0;
      const command = async (room: typeof blueLobby, body: Record<string, unknown>): Promise<void> => {
        const commandSeq = ++seq;
        const snapshot = await until(() => snapshots.at(-1));
        room.send('lobby:command', { ...body, seq: commandSeq, revision: snapshot.revision });
        expect(await until(() => results.get(commandSeq))).toMatchObject({ ok: true });
      };
      await command(blueLobby, { op: 'ready', ready: true });
      await command(redLobby, { op: 'ready', ready: true });
      const ticket = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
      const match = server.host.authenticate(ticket.token)!.match;
      const seat = await connectSeat({ url: `${base}/mcp`, token: match.mintSeatToken('nw', 'orbit') });
      await command(blueLobby, { op: 'start' });
      await until(() => snapshots.findLast((snapshot) => snapshot.phase === 'started'));
      const held = server.host.matches().find((candidate) => candidate.id !== match.id)!;
      expect(server.host.matches()).toHaveLength(2);
      expect(held.tick).toBe(0);
      expect(held.readiness().seats.filter((seat) => seat.kind === 'human').every((seat) => seat.state === 'waiting')).toBe(true);
      let stopped = false;
      const stopping = server.drain().then(() => { stopped = true; });
      try {
        await until(() => !server.host.matches().some((candidate) => candidate.id === held.id));
        expect(server.host.matches()).toEqual([match]);
        const health = await fetch(`${base}/healthz`);
        expect(health.status).toBe(503);
        expect(await json(health)).toMatchObject({ ok: false, draining: true, matches: 1 });
        const refused = await postLobby(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
        expect(refused.status).toBe(503);
        expect(await json(refused)).toEqual(UPDATING);
        expect(await json(await fetch(`${base}/api/lobbies`))).toEqual({ lobbies: [] });
        for (const [path, body] of [
          ['/api/lobbies', { mapId: 'ridges', layoutId: 'duel', visibility: 'public', preset: 'host' }],
          ['/api/lobbies/join', { code: lobby.code }],
          ['/matchmake/joinById/no-such-room', {}],
        ] as const) {
          const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
          expect(response.status, path).toBe(503);
          expect(await json(response)).toEqual(UPDATING);
        }
        expect((await dev(base, '', { mode: 'bots' })).status).toBe(503);
        expect(await seat.briefing()).toMatchObject({ phase: 'match', seat: { role: 'orbit' } });
        expect((await seat.call('game_observe', {})).isError).not.toBe(true);
        const tick = match.tick;
        await until(() => match.tick > tick + 2);
        expect(server.host.authenticate(ticket.token)?.match).toBe(match);
        expect(stopped).toBe(false);
        // Seat tickets are single-use: reconnection takes a fresh ticket from the running lobby, even while draining.
        for (const connection of ticket.connections) await connection.room.leave();
        const again = await json<Handoff>(await lobbyRoute(base, ticket.code, 'ticket', ticket.authorization));
        const reconnected = await Promise.all(again.tickets.map((entry) => join(sdk, again.roomId, entry.token)));
        await until(() => reconnected.some((connection) => connection.inbox.some((m) => m.type === MSG.view)));
        expect(stopped).toBe(false);
        const finalWait = seat.call('game_wait', { seconds: 60 });
        await until(() => match.seats().some((entry) => entry.role === 'orbit' && entry.team === 'nw' && entry.agentActive));
        expect((await dev(base, `/${ticket.roomId}/cheat`, { op: 'spire', army: 'se', plane: 'surface', hp: 0 })).status).toBe(200);
        expect(await finalWait).toMatchObject({ isError: false, structured: { phase: 'match', outcome: 'win' } });
        await stopping;
        expect(match.outcome('nw')).toBe('win');
        expect(match.report('nw')).toMatchObject({ outcome: 'win' });
        expect(server.host.history.get(match.id)).toMatchObject({ outcomes: { nw: 'win', se: 'loss' }, endedAt: expect.any(Number) });
        expect(stopped).toBe(true);
        expect(server.http.listening).toBe(false);
      } finally {
        // Drain has shut down HTTP; the client's best-effort DELETE cannot reach that closed listener.
        await seat.close().catch(() => {});
      }
    } finally {
      await server.close();
    }
  });

  it('caps the drain as interrupted without inventing draws, and persists history before resolving', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'ac-drain-history-'));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { server, base } = await start({ devAdminToken: ADMIN, historyDir: dir, drainMaxMs: 250, drainLogIntervalMs: 50, endGraceMs: 60_000 });
    try {
      const running = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
      const match = server.host.authenticate(running.token)!.match;
      const completed = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
      const winner = server.host.authenticate(completed.token)!.match;
      winner.end({ nw: 'win', se: 'loss' });
      let ended = 0;
      match.onEnd(() => { ended++; });
      const codes: number[] = [];
      for (const connection of running.connections) connection.room.onLeave((code) => codes.push(code));
      const stopping = server.drain();
      expect(server.drain()).toBe(stopping);
      await stopping;
      expect(ended).toBe(0);
      // A server update is not a game outcome, for either the players or the historical record.
      await until(() => codes.length === running.connections.length);
      expect(new Set(codes)).toEqual(new Set([MATCH_CLOSE.update]));
      expect(running.connections.flatMap((connection) => connection.inbox).some(({ msg }) => msg.op === 'report')).toBe(false);
      expect(match.outcome('nw')).toBe('running');
      expect(winner.outcome('nw')).toBe('win');
      expect(completed.connections.flatMap((connection) => connection.inbox).some(({ msg }) => msg.op === 'report')).toBe(true);
      expect(logs.mock.calls.filter(([text]) => text === 'draining: 1 live match(es) remaining').length).toBeGreaterThanOrEqual(2);
      expect(logs).toHaveBeenCalledWith(`drain cap: interrupting match ${match.id} (server update; outcome unknown)`);
      const persisted = readdirSync(dir).map((name) => JSON.parse(readFileSync(joinPath(dir, name), 'utf8')) as { record: { id: string; outcomes: Record<string, string>; endedAt: number | null }; replay: { outcomes: Record<string, string> } });
      expect(persisted.find((item) => item.record.id === match.id)).toMatchObject({
        record: { outcomes: { nw: 'running', se: 'running' }, endedAt: null },
        replay: { outcomes: { nw: 'running', se: 'running' } },
      });
      expect(persisted.find((item) => item.record.id === winner.id)?.record.outcomes.nw).toBe('win');
    } finally {
      await server.close();
      logs.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a restart closes live match rooms with the restart code before anything else: no player is sent a result', async () => {
    const { server, base } = await start({ devAdminToken: ADMIN });
    let closed = false;
    try {
      const running = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
      const codes: number[] = [];
      for (const connection of running.connections) connection.room.onLeave((code) => codes.push(code));
      await server.close(); closed = true;
      await until(() => codes.length === running.connections.length);
      expect(new Set(codes)).toEqual(new Set([MATCH_CLOSE.restart]));
      const received = running.connections.flatMap((connection) => connection.inbox);
      expect(received.some(({ msg }) => msg.op === 'report')).toBe(false);
      expect(running.connections.flatMap((connection) => [...connection.views.values()]).every(({ view }) => (view as { outcome: string }).outcome === 'running')).toBe(true);
    } finally { if (!closed) await server.close(); }
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('%s reaches process-level shutdown with live matches', async (signal) => {
    const historyDir = mkdtempSync(joinPath(tmpdir(), 'ac-drain-process-'));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
      env: {
        ...process.env, NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1', PUBLIC_URL: '', DATABASE_URL: '', DATA_DIR: '',
        HISTORY_DIR: historyDir, AC_DEV_ADMIN_TOKEN: ADMIN, PLAYERTHREE_DEVTOOLS: '0', RULES_FILE: '', RULES_JSON: '',
        DRAIN_MAX_SECONDS: '5', END_GRACE_SECONDS: '120',
        SIM_WORKERS: '0', FEATURED_MATCH: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    child.once('exit', (code, received) => exited.resolve({ code, signal: received }));
    child.once('error', exited.reject);
    try {
      const port = await until(() => {
        if (child.exitCode !== null) throw new Error(output);
        return /agent-command server on :(\d+)/.exec(output)?.[1];
      }, 15_000);
      const base = `http://127.0.0.1:${port}`;
      const ticket = await lobbyHandoff(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play', autoStart: true });
      child.kill(signal);
      if (signal === 'SIGTERM') {
        await until(async () => (await fetch(`${base}/healthz`)).status === 503);
        expect((await postLobby(base, { mapId: 'open', layoutId: 'duel', visibility: 'private', preset: 'play' })).status).toBe(503);
        await sleep(100);
        expect(child.exitCode).toBeNull();
        expect((await dev(base, `/${ticket.roomId}/cheat`, { op: 'spire', army: 'se', plane: 'surface', hp: 0 })).status).toBe(200);
      }
      expect(await exited.promise, output).toEqual({ code: 0, signal: null });
      expect(output).toContain(signal === 'SIGTERM' ? 'SIGTERM: draining live matches' : 'SIGINT: shutting down');
      const files = readdirSync(historyDir);
      expect(files).toHaveLength(1);
      const persisted = JSON.parse(readFileSync(joinPath(historyDir, files[0]!), 'utf8')) as { record: { outcomes: Record<string, string> } };
      expect(persisted.record.outcomes.nw).toBe(signal === 'SIGTERM' ? 'win' : 'running');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited.promise;
      }
      rmSync(historyDir, { recursive: true, force: true });
    }
  }, 20_000);
});
