/**
 * Opt-in --target mode: ramps match concurrency level by level against a live host, holding each level for --dwell,
 * and stops protectively on an /api/capacity event-loop or worker-lag breach, HTTP 429 or --max-wall. Never starts or
 * reconfigures a server; cleanup leaves every lobby it created.
 */
import { Client } from '@colyseus/sdk';
import { MSG } from 'playerthree/protocol';
import { HeaderObservations, Histogram, createLobby, endpoint, lobbyRejected, lobbyRoute, observerView, sleep, startLobby } from './core.mjs';

const MIN_WINDOW_SAMPLES = 100; // Same admission-window contract as the server.
export const TARGET_CREATE_INTERVAL_MS = 2000;

export function targetBreach(capacity, budget) {
  if (Number.isFinite(capacity?.eventLoop?.p99Ms) && capacity.eventLoop.p99Ms > budget) {
    return { code: 'main_event_loop_budget', p99Ms: capacity.eventLoop.p99Ms, budgetMs: budget };
  }
  for (const [index, worker] of (Array.isArray(capacity?.workers) ? capacity.workers : []).entries()) {
    if (worker.windowSamples >= MIN_WINDOW_SAMPLES && Number.isFinite(worker.p95LagMs) && worker.p95LagMs > budget) {
      return { code: 'worker_lag_budget', worker: worker.id ?? worker.workerId ?? index,
        p95LagMs: worker.p95LagMs, windowSamples: worker.windowSamples, budgetMs: budget };
    }
  }
  return null;
}

export function targetTelemetryAvailable(capacity) {
  if (!Number.isFinite(capacity?.eventLoop?.p99Ms) || !Array.isArray(capacity?.workers)) return false;
  const active = capacity.workers.filter((worker) => worker.active > 0 || worker.rooms?.some((room) => !room.ended));
  return active.length > 0 && active.every((worker) => worker.windowSamples >= MIN_WINDOW_SAMPLES && Number.isFinite(worker.p95LagMs));
}

const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const finite = (value) => Number.isFinite(value) ? value : null;

// SDK extension point exposes the room before its handshake finishes, so a
// deadline can close a blackholed WebSocket instead of waiting for OS timeout.
class TargetClient extends Client {
  constructor(url, onRoom) { super(url); this.onCreatedRoom = onRoom; }
  createRoom(name, schema) {
    const room = super.createRoom(name, schema);
    this.onCreatedRoom(room);
    return room;
  }
}

/** Opt-in real public production load. Never starts a server or modifies its settings. */
export async function runTarget(config, outerSignal, emit) {
  const start = performance.now();
  const abort = new AbortController();
  const signal = AbortSignal.any([outerSignal, abort.signal]);
  const created = [];
  // Every lobby this run created, admitted or not; cleanup leaves each one, which ends its game.
  const lobbies = [];
  const levels = config.levels ?? [1, 2, 4, 8, 16, 32, 64].filter((level) => level <= config.maxMatches);
  const headers = config.headers ? new HeaderObservations() : undefined;
  const createLatencyMs = new Histogram();
  const joinLatencyMs = new Histogram();
  const capacityLatencyMs = new Histogram();
  const errors = [];
  const cancellations = [];
  const testedLevels = [];
  let stopReason, before, after, samples = 0, ambiguousCreates = 0, largestStableLevel = null;
  let level = 0, levelSamples = 0, levelMatureSamples = 0;
  let lastCreateAt = start - TARGET_CREATE_INTERVAL_MS;
  let monitor;
  let pendingSample;
  const live = () => created.filter((match) => !match.outcome || match.outcome === 'running');
  const stop = (reason) => {
    if (!stopReason) stopReason = reason;
    if (!abort.signal.aborted) abort.abort(new Error(reason.code));
  };
  const timer = setTimeout(() => stop({ code: 'max_wall', limitMs: config.maxWall }), config.maxWall);
  const recordError = (kind, error) => { if (errors.length < 20) errors.push({ kind, message: errorMessage(error) }); };
  const statuses = {};
  async function json(path, init = {}, kind) {
    const t = performance.now();
    const response = await fetch(endpoint(config.url, path), { ...init,
      signal: AbortSignal.any([init.signal ?? signal, AbortSignal.timeout(config.requestTimeout)]) });
    statuses[`${kind}:${response.status}`] = (statuses[`${kind}:${response.status}`] ?? 0) + 1;
    headers?.observe(endpoint(config.url, path), kind, response);
    if (response.status === 429) {
      // A proxy may return HTML here. Explicit rejection is never an ambiguous
      // create and never waits for body parsing before stopping the ramp.
      void response.body?.cancel().catch(() => {});
      if (kind === 'capacity') capacityLatencyMs.add(performance.now() - t);
      if (kind === 'create') createLatencyMs.add(performance.now() - t);
      return { status: response.status, body: null, headers: response.headers };
    }
    if (response.status === 204) return { status: response.status, body: null, headers: response.headers };
    let body;
    try { body = await response.json(); } catch (error) {
      if (signal.aborted && !init.signal) throw signal.reason;
      throw new Error(`${kind} returned invalid JSON`, { cause: error });
    }
    if (kind === 'capacity') capacityLatencyMs.add(performance.now() - t);
    if (kind === 'create') createLatencyMs.add(performance.now() - t);
    return { status: response.status, body, headers: response.headers };
  }

  async function readCapacity() {
    const result = await json('/api/capacity', {}, 'capacity');
    if (result.status === 429) {
      stop({ code: 'http_429', endpoint: 'capacity', retryAfter: result.headers.get('retry-after') });
      return null;
    }
    if (result.status !== 200 || !result.body || typeof result.body !== 'object') {
      throw new Error(`Capacity HTTP ${result.status}`);
    }
    const body = result.body;
    const at = performance.now();
    if (!before) before = { at, metrics: body };
    after = { at, metrics: body };
    samples++;
    if (level) { levelSamples++; if (targetTelemetryAvailable(body)) levelMatureSamples++; }
    emit('capacity', { mode: 'target', level, elapsedMs: at - start, metrics: body });
    const breach = targetBreach(body, config.lagBudgetMs);
    if (breach) stop(breach);
    if (headers?.failures) stop({ code: 'response_header_policy_failure' });
    return body;
  }

  async function sample() {
    if (pendingSample) return pendingSample;
    pendingSample = readCapacity();
    try { return await pendingSample; }
    finally { pendingSample = undefined; }
  }

  async function create() {
    const createDelay = Math.max(0, lastCreateAt + TARGET_CREATE_INTERVAL_MS - performance.now());
    if (createDelay > 0) await sleep(Math.ceil(createDelay), signal);
    if (signal.aborted) return;
    if (created.length >= config.maxMatches) { stop({ code: 'max_matches', limit: config.maxMatches }); return; }
    lastCreateAt = performance.now();
    let response;
    try {
      response = await createLobby(json, config.url, config.lobby, signal);
    } catch (error) {
      ambiguousCreates++;
      if (!signal.aborted) { recordError('create', error); stop({ code: 'create_request_error', ambiguous: true }); }
      return;
    }
    if (response.status === 429) {
      stop({ code: 'http_429', serverError: typeof response.body?.error === 'string' ? response.body.error : null,
        retryAfter: response.headers.get('retry-after') });
      return;
    }
    if (lobbyRejected(response)) { stop({ code: 'lobby_capacity' }); return; }
    if (!response.lobby) { stop({ code: 'create_response_error', status: response.status }); return; }
    const lobby = response.lobby;
    lobbies.push(lobby);
    let ticket;
    try {
      ticket = await startLobby({ request: json, base: config.url, lobby, joinLobby,
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeout)]),
        onQueued(state) { stop({ code: 'queued', position: state.position ?? null }); } });
    } catch (error) {
      if (!signal.aborted) { recordError('admission', error); stop({ code: 'admission_failed' }); }
      return;
    }
    const match = { roomId: ticket.roomId, room: null, outcome: 'running', views: 0,
      firstTick: null, lastTick: null, firstAt: null, lastAt: null, left: false };
    created.push(match);
    if (signal.aborted) return;
    const joinedAt = performance.now();
    const joinSignal = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeout)]);
    try {
      match.room = await new Promise((resolve, reject) => {
        const onAbort = () => {
          if (match.room) {
            void match.room.leave(true).catch(() => {});
            match.room.connection?.close();
          }
          reject(joinSignal.reason);
        };
        joinSignal.addEventListener('abort', onAbort, { once: true });
        if (joinSignal.aborted) { joinSignal.removeEventListener('abort', onAbort); reject(joinSignal.reason); return; }
        const client = new TargetClient(config.wsUrl, (room) => {
          match.room = room;
          room.reconnection.enabled = false;
        });
        client.http.options.signal = joinSignal;
        client.joinById(ticket.roomId, { token: ticket.token }).then((room) => {
          joinSignal.removeEventListener('abort', onAbort);
          room.reconnection.enabled = false;
          if (joinSignal.aborted) {
            void room.leave(true).catch(() => {});
            room.connection.close();
            return;
          }
          room.onMessage('*', (type, body) => {
            const view = type === MSG.observer ? observerView(body) : undefined;
            if (!view) return;
            const now = performance.now();
            if (match.firstAt === null) { match.firstAt = now; match.firstTick = view.tick; }
            match.lastAt = now; match.lastTick = view.tick; match.views++;
            if (view.outcome) match.outcome = view.outcome;
          });
          room.onError((code) => { if (!signal.aborted) stop({ code: 'websocket_error', roomId: match.roomId, errorCode: code }); });
          room.onLeave((code) => {
            match.left = true;
            if (!signal.aborted && match.outcome === 'running') stop({ code: 'websocket_closed', roomId: match.roomId, closeCode: code });
          });
          room.send(MSG.observer, { perspective: 'all' });
          resolve(room);
        }, (error) => { joinSignal.removeEventListener('abort', onAbort); reject(error); });
      });
      joinLatencyMs.add(performance.now() - joinedAt);
    } catch (error) {
      if (!signal.aborted) { recordError('join', error); stop({ code: 'join_failed', roomId: match.roomId }); }
    }
  }

  /** The pregame socket only starts the lobby and reports admission; the match is entered with an observer ticket. */
  async function joinLobby(roomId, token, events) {
    const client = new Client(config.wsUrl);
    client.http.options.signal = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeout)]);
    const room = await client.joinById(roomId, { token });
    room.reconnection.enabled = false;
    room.onMessage('lobby:snapshot', events.snapshot);
    room.onMessage('lobby:error', (body) => events.error(body?.code));
    room.onMessage('*', () => {});
    room.onLeave(events.left);
    return { leave: () => room.leave(true).catch(() => { room.connection.close(); }) };
  }

  emit('config', { mode: 'target', config: { ...config, levels, sampleInterval: 1000, createIntervalMs: TARGET_CREATE_INTERVAL_MS },
    warning: 'REAL public-server load. Lobby creation per IP is limited by the server\'s MATCHES_PER_IP (default 30 per 10 minutes) unless operator-raised; no bypass. Every created lobby is left at the end, which ends its game.' });
  try {
    await sample(); // Capture before RSS/CPU, and refuse load if already late.
    monitor = (async () => {
      await sleep(1000, signal);
      while (!signal.aborted) {
        const at = performance.now();
        if (signal.aborted) break;
        await sample();
        // One in-flight request at a one-second cadence; no sampling backlog.
        await sleep(Math.max(0, 1000 - (performance.now() - at)), signal);
      }
    })().catch((error) => {
      if (!signal.aborted) { recordError('capacity', error); stop({ code: 'capacity_request_error' }); }
    });
    for (const requested of levels) {
      if (signal.aborted) break;
      while (live().length < requested && !signal.aborted) await create();
      if (signal.aborted) break;
      level = requested; levelSamples = 0; levelMatureSamples = 0;
      const holdStart = performance.now();
      const holdEnd = holdStart + config.dwell * 1000;
      emit('target_level_start', { level, elapsedMs: holdStart - start, liveMatches: live().length });
      while (performance.now() < holdEnd && !signal.aborted) {
        while (live().length < requested && !signal.aborted) await create();
        if (!signal.aborted) await sleep(Math.min(100, Math.max(0, holdEnd - performance.now())), signal);
      }
      if (signal.aborted) break;
      // A final sample ensures a breach at the dwell boundary cannot be certified.
      await sample();
      if (signal.aborted) break;
      const allViewed = live().length >= requested && live().every((match) => match.views > 1);
      const stable = levelMatureSamples > 0 && targetTelemetryAvailable(after?.metrics) && allViewed;
      const result = { level, dwellMs: performance.now() - holdStart, liveMatches: live().length,
        samples: levelSamples, matureSamples: levelMatureSamples, stable, reason: stable ? 'rolling_lag_budget_met' : 'telemetry_or_view_coverage_missing' };
      testedLevels.push(result);
      emit('target_level', result);
      if (!stable) { stop({ code: 'telemetry_unavailable', level }); break; }
      largestStableLevel = requested;
      level = 0;
    }
    if (!signal.aborted) stop({ code: 'levels_complete' });
  } catch (error) {
    if (!signal.aborted) { recordError('target', error); stop({ code: 'target_request_error' }); }
  } finally {
    clearTimeout(timer);
    if (outerSignal.aborted && !stopReason) stopReason = { code: 'interrupted' };
    if (!abort.signal.aborted) abort.abort(new Error('target_finished'));
    // No natural drain. Fresh, bounded cleanup: leave sockets, then leave every created lobby (ending its game).
    const cleanup = AbortSignal.timeout(2000);
    const work = created.filter((match) => match.room && !match.left).map(async (match) => {
      let timer;
      try {
        await Promise.race([match.room.leave(true).catch(() => {}),
          new Promise((resolve) => {
            timer = setTimeout(() => { if (!match.left) match.room.connection.close(); resolve(); }, 1900);
          })]);
      } finally { clearTimeout(timer); }
    });
    for (const lobby of lobbies) work.push((async () => {
      try {
        const response = await lobbyRoute(json, config.url, lobby, 'leave', 'cancel', cleanup);
        cancellations.push({ status: response.status, left: response.status === 204 || response.status === 404 });
      } catch (error) { recordError('lobby_leave', error); cancellations.push({ status: null, left: false }); }
    })());
    await Promise.allSettled(work);
    if (monitor) await monitor;
  }
  const cpuBefore = before?.metrics.process;
  const cpuAfter = after?.metrics.process;
  const cpuStart = Number.isFinite(cpuBefore?.cpuUserMicros) && Number.isFinite(cpuBefore?.cpuSystemMicros)
    ? cpuBefore.cpuUserMicros + cpuBefore.cpuSystemMicros : null;
  const cpuEnd = Number.isFinite(cpuAfter?.cpuUserMicros) && Number.isFinite(cpuAfter?.cpuSystemMicros)
    ? cpuAfter.cpuUserMicros + cpuAfter.cpuSystemMicros : null;
  const sampleWallMs = before && after ? after.at - before.at : 0;
  const summary = { mode: 'target', target: config.target, elapsedMs: performance.now() - start,
    stopReason: stopReason ?? { code: 'interrupted' }, largestStableLevel, testedLevels, created: created.length,
    completed: created.filter((match) => match.outcome !== 'running').length,
    liveGamesAtStop: live().map((match) => match.roomId),
    liveGamesAtStopCount: live().length, ambiguousCreates, lobbyLeaves: cancellations,
    // An ambiguous create or a failed leave may leave a game running server-side until its lifetime cap.
    orphanedGamesPossible: ambiguousCreates > 0 || cancellations.some((result) => !result.left),
    perMatch: created.map((match) => ({ roomId: match.roomId, outcome: match.outcome, views: match.views,
      firstTick: match.firstTick, lastTick: match.lastTick,
      observedHz: match.lastAt > match.firstAt ? (match.lastTick - match.firstTick) * 1000 / (match.lastAt - match.firstAt) : null })),
    capacity: { samples, before: before?.metrics ?? null, after: after?.metrics ?? null,
      rssBeforeBytes: finite(cpuBefore?.rssBytes), rssAfterBytes: finite(cpuAfter?.rssBytes),
      rssDeltaBytes: Number.isFinite(cpuBefore?.rssBytes) && Number.isFinite(cpuAfter?.rssBytes) ? cpuAfter.rssBytes - cpuBefore.rssBytes : null,
      parentCpuPercent: cpuStart !== null && cpuEnd !== null && cpuEnd >= cpuStart && sampleWallMs > 0
        ? (cpuEnd - cpuStart) / (sampleWallMs * 10) : null,
      workerCpuFractionUnits: '1 = one CPU core', globalTicks: after?.metrics.ticks ?? null },
    latencyMs: { create: createLatencyMs.json(), join: joinLatencyMs.json(), capacity: capacityLatencyMs.json() },
    statuses, ...(headers ? { headers: headers.json() } : {}), errors,
    warning: 'Joined clients left and every created lobby was left, ending its game. Ambiguous creates or failed leaves may remain until the server lifetime cap.' };
  emit('summary', summary);
  return outerSignal.aborted ? 130 : summary.stopReason.code === 'levels_complete' ? 0 : 1;
}
