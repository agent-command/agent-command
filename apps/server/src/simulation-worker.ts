/** One complete human/built-in-bot host per OS thread; profiles, agents, and policies stay on the canonical host. */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { createAuthContext, defineRoom, matchMaker, registerRoomDefinitions } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { TOKEN_RE } from 'playerthree';
import { createPlayerThreeHost } from 'playerthree/host';
import { createDevtoolsHandler, createPlayerApiHandler } from 'playerthree/devtools';
import { openPostgresStorage } from 'playerthree/postgres';
import { ARMIES, definition, type Plane } from '@agent-command/game';
import { registerNamedMap, type MapDocument } from '@agent-command/game/maps';
import type { ServerConfig } from './config.ts';
import { clientIp, cors, HttpError, RateLimiter, readJson, securityHeaders, sendJson } from './http.ts';
import { createAgentCommandRoom, MatchRegistry, ROOM_NAME, type GameMatch } from './room.ts';
import { featuredFrames } from './featured.ts';
import type { SimulationCall, SimulationMessage, SimulationResult, SimulationSnapshot, SimulationStats } from './simulation-protocol.ts';
import { SimulationMetrics } from './simulation-metrics.ts';
import type { LobbyMatchSnapshot } from './lobby-match.ts';

if (!parentPort) throw new Error('simulation-worker must run in a Worker');
const channel = parentPort;
const input = workerData as { worker: number; warmupTicks?: number; seed?: number; maps: MapDocument[]; config: Omit<ServerConfig, 'publicUrl'> & { publicUrl?: string } };
const config: ServerConfig = { ...input.config, publicUrl: input.config.publicUrl ? new URL(input.config.publicUrl) : undefined };
for (const document of input.maps) registerNamedMap(document.id, document);
const storage = config.databaseUrl
  ? await openPostgresStorage({ url: config.databaseUrl, migrations: { scope: 'agent-command', dir: fileURLToPath(new URL('../migrations', import.meta.url)) } })
  : undefined;
const game = definition.manifest.id;
// Workers of different cluster nodes must not share (and prune) one history scope; the node's internal address is
// its stable identity across restarts.
const historyScope = config.cluster
  ? `${game}-simulation-${createHash('sha256').update(config.cluster.address).digest('hex').slice(0, 12)}-${input.worker}`
  : `${game}-simulation-${input.worker}`;
const host = createPlayerThreeHost({
  definition,
  maxMatches: config.maxMatches,

  ...(config.rules ? { matchOptions: config.rules } : {}),
  history: {
    maxSessions: config.historySessions,
    maxAgeMs: config.historyMs,
    maxBytes: config.historyBytes,
    ...(storage ? { store: storage.history(historyScope) } : config.historyDir ? { dir: config.historyDir } : {}),
  },
});
const registry = new MatchRegistry();
const http = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 });
const maxMessageBytes = 64 * 1024; // Human/bot controls never carry policy artifacts.
const transport = new WebSocketTransport({ noServer: true, maxPayload: maxMessageBytes, pingInterval: 5000, pingMaxRetries: 3 });
transport.attachToServer(http);
let draining = false;
let closing = false;
const lags = new Float64Array(4096);
const durations = new Float64Array(4096);
let tickSamples = 0;
/** Active observer relays by `roomId:team`; deleting the entry stops its loop at the next frame. */
const relays = new Map<string, symbol>();
const allocations = new Map<string, { match: GameMatch; speed: number; unsubscribe(): void }>();
const post = (message: SimulationMessage) => channel.postMessage(message);
registerRoomDefinitions({
  [ROOM_NAME]: defineRoom(createAgentCommandRoom({
    config, registry, host, maxMessageBytes, tickRate: definition.manifest.tickRate,
    isDraining: () => draining,
    onReleased(roomId, durationMs) {
      allocations.get(roomId)?.unsubscribe();
      allocations.get(roomId)?.match.dispose();
      allocations.delete(roomId);
      for (const team of ARMIES) relays.delete(`${roomId}:${team}`);
      post({ kind: 'released', roomId, durationMs });
    },
    recordTick(lag, duration, matchTick) {
      metrics.recordTick(lag, performance.now(), matchTick);
      // Preserve the existing per-report samples without allocating on each tick.
      if (tickSamples < lags.length) {
        lags[tickSamples] = lag;
        durations[tickSamples++] = duration;
      } else {
        lags[0] = Math.max(lags[0]!, lag);
        durations[0] = Math.max(durations[0]!, duration);
      }
    },
  })),
});
const player = createPlayerApiHandler(host, { path: '/playerthree/player' });
const joinLimiter = new RateLimiter(config.joinsPerIpPerMin, 60_000);
const devtools = config.devtools ? createDevtoolsHandler(host, {
  path: '/playerthree/devtools',
  ...(config.operatorToken ? { operatorToken: config.operatorToken } : {}),
  ...(config.benchResultsDir ? { benchResultsDir: config.benchResultsDir } : {}),
  ...(config.safetyCard ? { safetyCard: config.safetyCard } : {}),
}) : undefined;

async function route(req: IncomingMessage, res: ServerResponse) {
  securityHeaders(res, config);
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/mcp') return sendJson(res, 403, { error: 'unsupported_worker_operation' });
  if (path === '/playerthree/devtools' || path.startsWith('/playerthree/devtools/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 403, { error: 'unsupported_worker_operation' });
    if (devtools && await devtools.handle(req, res)) return;
    return sendJson(res, 404, { error: 'not_found' });
  }
  if (path === '/playerthree/player' || path.startsWith('/playerthree/player/')) {
    if (await player.handle(req, res)) return;
  }
  const join = /^\/matchmake\/joinById\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (join && cors(req, res, config)) return;
  if (join && req.method === 'POST') {
    const retry = joinLimiter.take(clientIp(req, config));
    if (retry > 0) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retry) });
    const body = await readJson(req, 4096);
    const options = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    const auth = typeof options.token === 'string' && TOKEN_RE.test(options.token) ? host.authenticate(options.token) : undefined;
    const live = registry.get(join[1]!);
    if (!live) return sendJson(res, 404, { error: 'room_not_found' });
    if (!auth || auth.match.id !== live.match.id) return sendJson(res, 401, { error: 'bad_token' });
    const reservation = await matchMaker.joinById(join[1]!, { token: options.token, watch: options.watch, view: options.view }, createAuthContext({
      headers: req.headers as Record<string, string | undefined>, remoteAddress: clientIp(req, config),
    }));
    return sendJson(res, 200, reservation);
  }
  sendJson(res, 404, { error: 'not_found' });
}
http.on('request', (req, res) => {
  void route(req, res).catch((error: unknown) => {
    if (res.headersSent) return void res.destroy();
    sendJson(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.code : 'internal' });
  });
});

function live(roomId: string) {
  const found = registry.get(roomId);
  if (!found) throw new Error('room_not_found');
  return found;
}


function state(match: GameMatch): LobbyMatchSnapshot {
  return { readiness: match.readiness(), cards: match.cards(), over: match.over };
}

function publish(roomId: string): void {
  const entry = allocations.get(roomId);
  if (entry) post({ kind: 'state', roomId, state: state(entry.match) });
}
async function call(call: SimulationCall): Promise<SimulationResult> {
  switch (call.op) {
    case 'createLobby': {
      if (draining) throw new Error('draining');
      const request = call.request;
      if (request.assignments.some((seat) => !['human', 'bot', 'none'].includes(seat.kind) || 'commander' in seat || 'policy' in seat)) throw new Error('unsupported_worker_assignment');
      const controllers: Record<string, Partial<Record<Plane, 'human' | 'bot' | 'none'>>> = {};
      for (const seat of request.assignments) (controllers[seat.team] ??= {})[seat.role as Plane] = seat.kind;
      const match = host.createMatch({
        teams: request.teams, alliances: request.alliances,
        assignments: request.assignments, controllers, realtime: false,
        botSeats: request.botSeats.map((seat) => ({ ...seat })),
        seed: input.seed ?? request.seed, options: request.rules,
        readySeconds: config.readySeconds, observerPolicy: request.observerPolicy,
      });
      let ticket: string | undefined;
      try {
        // Benchmark-only warmup uses this same exact allocation; production preparation always stays at tick 0.
        if (input.warmupTicks) {
          match.skipReadyCheck();
          await match.step(input.warmupTicks);
          if (match.over) throw new Error('warmup_ended');
        } else match.holdStart();
        ticket = registry.ticket({
          match, mode: 'pvp', createdAt: Date.now(), speed: 0, featured: request.featured,
          // The parent lobby owns pregame expiry; abandonment applies once its `start` releases the gate.
          preparing: true,
          observerDelayMs: request.observerPolicy.minDelayMs,
          idleExempt: request.assignments.every((seat) => seat.kind !== 'human'),
        });
        const room = await matchMaker.createRoom(ROOM_NAME, { ticket });
        // Lobby state carries readiness and cards, which also change on agent arrival (not only seat status).
        const status = match.onReadiness(() => publish(room.roomId));
        const ended = match.onEnd(() => publish(room.roomId));
        allocations.set(room.roomId, { match, speed: request.speed, unsubscribe() { status(); ended(); } });
        return { roomId: room.roomId, state: state(match) };
      } catch (error) {
        if (ticket) registry.drop(ticket);
        match.dispose();
        throw error;
      }
    }
    case 'start': {
      const entry = allocations.get(call.roomId);
      if (!entry) throw new Error('room_not_found');
      const match = entry.match;
      if (match.readiness().seats.some((seat) => seat.kind === 'human' && seat.state !== 'ready')) throw new Error('humans_not_ready');
      match.skipReadyCheck();
      const started = live(call.roomId);
      started.preparing = false;
      started.speed = entry.speed;
      publish(call.roomId);
      return;
    }
    case 'mintHumanToken': {
      const ticket = live(call.roomId).match.mintHumanToken(...call.args);
      publish(call.roomId);
      return ticket;
    }
    case 'renewHumanToken': return live(call.roomId).match.renewHumanToken(...call.args);
    case 'mintObserverToken': return live(call.roomId).match.mintObserverToken(...call.args);
    case 'mintSpectatorToken': return live(call.roomId).match.mintSpectatorToken(...call.args);
    // Workers host no commander roster: a named commander fails `invalid` here (the lobby refuses it before).
    case 'assign': live(call.roomId).match.assign(...call.args); publish(call.roomId); return;
    case 'revokeToken': live(call.roomId).match.revokeToken(call.token); publish(call.roomId); return;
    case 'revokeSeat': live(call.roomId).match.revokeSeat(...call.args); publish(call.roomId); return;
    case 'setHumanReady': live(call.roomId).match.setHumanReady(...call.args); publish(call.roomId); return;
    case 'end': {
      const outcomes = live(call.roomId).match.end(...call.args);
      publish(call.roomId);
      return outcomes;
    }
    case 'forfeit': live(call.roomId).match.forfeit(...call.args); publish(call.roomId); return;
    case 'outcome': return live(call.roomId).match.outcome(...call.args);
    case 'snapshot': {
      const match = live(call.roomId).match;
      return { views: match.teams.map((team) => match.view(team)), seats: match.seats(),
        reports: match.teams.flatMap((team) => { const data = match.report(team); return data ? [{ team, data }] : []; }),
        ended: match.over,
      } satisfies SimulationSnapshot;
    }
    case 'observe': {
      const key = `${call.roomId}:${call.team}`;
      // An omniscient relay stops once any seat is not a built-in bot.
      const frames = featuredFrames(live(call.roomId).match, call.grant);
      const run = Symbol(key);
      relays.set(key, run);
      void (async () => {
        try {
          for await (const frame of frames) {
            if (relays.get(key) !== run) return;
            post({ kind: 'observer', roomId: call.roomId, team: call.team, frame });
          }
        } catch { /* The stream closed with its match; the parent rotates on release. */ }
      })();
      return;
    }
    case 'unobserve': relays.delete(`${call.roomId}:${call.team}`); return;
    case 'abandon':
      await registry.get(call.roomId)?.abandonIfUnattended?.();
      return;
    case 'remove': {
      const live = registry.get(call.roomId);
      const match = live?.match;
      if (!match) return;
      try {
        // Administrative removal interrupts undecided play; it does not declare a winner or a draw.
        if (!match.over) await live.closeWithoutResult?.('closed');
        await matchMaker.getLocalRoomById(call.roomId)?.disconnect();
      } finally { match.dispose(); }
      return;
    }
    case 'drain': draining = true; return;
    case 'close': {
      if (closing) return;
      draining = true; closing = true;
      clearInterval(reportTimer);
      // Restart/update interrupts undecided play, including its historical record.
      await Promise.all([...registry.rooms()].filter(([, entry]) => !entry.match.over).map(([, entry]) => entry.closeWithoutResult?.(call.reason)));
      await matchMaker.gracefullyShutdown();
      transport.shutdown();
      player.close(); devtools?.close(); joinLimiter.close(); host.dispose();
      await Promise.all([host.history.flush(), host.commanders.flush()]);
      await storage?.close();
      http.closeAllConnections();
      const stopped = Promise.withResolvers<void>();
      http.close(() => stopped.resolve());
      await stopped.promise;
      return;
    }
  }
}

await host.ready;
await matchMaker.setup();
await matchMaker.accept();
const listening = Promise.withResolvers<void>();
http.once('error', listening.reject);
http.listen(0, '127.0.0.1', () => {
  http.off('error', listening.reject);
  listening.resolve();
});
await listening.promise;
// Importing, restoring history, and binding the transport are bootstrap costs, not match CPU pressure.
const metrics = new SimulationMetrics(performance.now(), process.threadCpuUsage(), definition.manifest.tickRate);
const reportTimer = setInterval(() => {
  const reportedLags = Array.from(lags.subarray(0, tickSamples));
  const reportedDurations = Array.from(durations.subarray(0, tickSamples));
  const ordered = [...reportedLags].sort((a, b) => a - b);
  const pressure = metrics.sample(performance.now(), process.threadCpuUsage());
  const stats: SimulationStats = {
    worker: input.worker,
    sampledAt: Date.now(),
    ...pressure,
    rooms: [...registry.rooms()].map(([roomId, entry]) => ({ roomId, tick: entry.match.tick, ended: entry.match.over })),
    tickSamples: ordered.length, p99LagMs: ordered[Math.max(0, Math.ceil(ordered.length * .99) - 1)] ?? 0,
    maxLagMs: ordered.at(-1) ?? 0, maxDurationMs: reportedDurations.reduce((max, value) => Math.max(max, value), 0),
  };
  post({ kind: 'stats', stats, lags: reportedLags, durations: reportedDurations });
  tickSamples = 0;
}, 1000);
reportTimer.unref();
post({ kind: 'ready', port: (http.address() as AddressInfo).port });
channel.on('message', (message: { id: number; call: SimulationCall }) => {
  void call(message.call).then((value) => {
    post({ kind: 'reply', id: message.id, value });
    if (message.call.op === 'close') channel.close();
  }, (error: unknown) => post({ kind: 'reply', id: message.id, error: error instanceof Error ? error.message : 'internal' }));
});
