#!/usr/bin/env node
/** Usage, measurement semantics and safety notes: core.mjs HELP (also --help).
 * Examples are intentionally opt-in; this tool never starts a server or changes speed.
 */
import { Client } from '@colyseus/sdk';
import { applyView, MSG } from 'playerthree/protocol';
import { HELP, FirstSseFrame, HeaderObservations, Histogram, acquireTicket, classify, endpoint, lobbyRoute, observerView, options, sleep } from './core.mjs';
import { runTarget } from './target.mjs';

const emit = (event, data) => process.stdout.write(`${JSON.stringify({ schema: 'ac-loadtest/v1', event, at: new Date().toISOString(), ...data })}\n`);
const message = (error) => error instanceof Error ? error.message : String(error);
const overall = new AbortController();
let interrupted = false;
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => {
  interrupted = true;
  overall.abort(new Error(name));
});

function requestMetrics() { return { requests: 0, responses: 0, errors: 0, bytes: 0, statuses: {}, latency: new Histogram() }; }
function summarizeRequests(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, { ...value, latency: value.latency.json() }]));
}

async function runStage(config, slots, index) {
  const started = performance.now();
  const stop = new AbortController();
  const measurementStop = new AbortController();
  const measurementReason = new Error('measurement_window_finished');
  const signal = AbortSignal.any([overall.signal, stop.signal, measurementStop.signal]);
  // Lobbies created but not yet started; left (cancelled) on failure and at stage end.
  const pending = new Set();
  // A lobby holds 16 members: its creator plus at most 15 extra observers.
  if (Math.ceil(config.spectators / slots) > 15) throw new Error('--spectators allows at most 15 extra observers per concurrent match');
  const rooms = new Set();
  const metrics = {};
  const headers = config.headers ? new HeaderObservations() : undefined;
  const admissionMs = new Histogram();
  const completionMs = new Histogram();
  const joinMs = new Histogram();
  const tickHz = new Histogram();
  const viewDerivedPerTickLagMs = new Histogram();
  const cpuPercent = new Histogram();
  const eventLoopP99Ms = new Histogram();
  const tickP99LagMs = new Histogram();
  const tickP99DurationMs = new Histogram();
  const tickMaxDurationMs = new Histogram();
  const rssBytes = new Histogram();
  const heapUsedBytes = new Histogram();
  // Every worker's thread CPU summed per sample (cores), and the view stream's received bytes per player socket.
  const workerCpuCores = new Histogram();
  const playerBytesPerSecond = new Histogram();
  let playerHoldBytes = 0, playerSockets = 0, peakPlayers = 0, viewGaps = 0;
  let previousCpu;
  let capacitySamples = 0;
  let queuePolls = 0;
  let lastQueuePosition;
  let created = 0, completed = 0, failed = 0, abandoned = 0, ownerSockets = 0, spectatorSockets = 0;
  let intentionallyTruncated = 0, cancelledAdmissions = 0;
  let peakOwners = 0, peakSpectators = 0, peakReady = 0, ready = 0, saturated = false;
  let nextMatch = 0;
  let floodSkipped = 0;
  let floodFailures = 0;
  const featured = { requested: config.featuredViewers, attempted: 0, connected: 0, active: 0, peakConnected: 0,
    firstFrames: 0, ready: 0, peakReady: 0, bytes: 0, chunks: 0, streamErrors: 0, statuses: {} };
  const featuredConnectMs = new Histogram();
  const featuredFirstFrameMs = new Histogram();
  const errors = [];
  const outcomes = {};
  const holdStart = started + config.ramp * 1000;
  const holdEnd = config.duration > 0 ? holdStart + config.duration * 1000 : Infinity;
  const measurementTimer = config.measurementOnly
    ? setTimeout(() => measurementStop.abort(measurementReason), Math.max(0, holdEnd - performance.now()))
    : undefined;
  const phase = () => performance.now() < holdStart ? 'ramp' : performance.now() < holdEnd ? 'hold' : 'drain';
  const observeSaturation = () => {
    if (phase() === 'hold' && ready >= slots && spectatorSockets >= config.spectators
      && featured.ready >= config.featuredViewers) saturated = true;
  };
  const recordError = (kind, error, match) => {
    if (errors.length < 30) errors.push({ kind, ...(match === undefined ? {} : { match }), message: message(error) });
  };

  async function request(url, init = {}, kind = 'other', json = true) {
    const metric = metrics[kind] ??= requestMetrics();
    metric.requests++;
    const t = performance.now();
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.any([init.signal ?? signal, AbortSignal.timeout(config.requestTimeout)]) });
      metric.responses++;
      metric.statuses[response.status] = (metric.statuses[response.status] ?? 0) + 1;
      headers?.observe(url, kind, response);
      let body;
      if (json) {
        const text = await response.text();
        metric.bytes += Buffer.byteLength(text);
        try { body = JSON.parse(text); } catch { body = null; }
      } else if (response.body) {
        // Drain actual asset bodies without retaining them in the load generator.
        for await (const chunk of response.body) metric.bytes += chunk.byteLength;
      }
      return { status: response.status, body, headers: response.headers };
    } catch (error) {
      metric.errors++;
      throw error;
    } finally { metric.latency.add(performance.now() - t); }
  }

  async function sampleCapacity() {
    while (!signal.aborted) {
      const at = performance.now();
      try {
        const sample = await request(endpoint(config.url, '/api/capacity'), {}, 'capacity');
        if (sample.status === 200 && sample.body && typeof sample.body === 'object') {
          capacitySamples++;
          const body = sample.body;
          emit('capacity', { stage: index, phase: phase(), elapsedMs: at - started, metrics: body });
          if (phase() === 'hold') {
            observeSaturation();
            eventLoopP99Ms.add(body.eventLoop?.p99Ms);
            if (body.ticks?.samples !== 0) {
              tickP99LagMs.add(body.ticks?.p99LagMs);
              tickP99DurationMs.add(body.ticks?.p99DurationMs);
              tickMaxDurationMs.add(body.ticks?.maxDurationMs);
            }
            rssBytes.add(body.process?.rssBytes);
            heapUsedBytes.add(body.process?.heapUsedBytes);
            const workers = Array.isArray(body.workers) ? body.workers : [];
            if (workers.length) workerCpuCores.add(workers.reduce((sum, worker) => sum + (Number.isFinite(worker?.cpuFraction) ? worker.cpuFraction : 0), 0));
            const p = body.process;
            if (Number.isFinite(p?.cpuUserMicros) && Number.isFinite(p?.cpuSystemMicros)) {
              const cpu = p.cpuUserMicros + p.cpuSystemMicros;
              if (previousCpu && at > previousCpu.at && cpu >= previousCpu.cpu) cpuPercent.add((cpu - previousCpu.cpu) / ((at - previousCpu.at) * 10));
              previousCpu = { at, cpu };
            }
          } else previousCpu = undefined;
        } else {
          emit('capacity_error', { stage: index, status: sample.status });
          if (sample.status === 404) return; // Older deployments can still run completion tests.
        }
      } catch (error) {
        if (!signal.aborted) emit('capacity_error', { stage: index, message: message(error) });
      }
      try { await sleep(Math.max(0, config.sampleInterval - (performance.now() - at)), signal); } catch { return; }
    }
  }

  async function flood() {
    if (!config.homeRps && !config.staticRps) return;
    const inflight = new Set();
    const streams = [
      { kind: 'home', rps: config.homeRps, credit: 0, path: () => '/' },
      { kind: 'static', rps: config.staticRps, credit: 0, cursor: 0,
        path() { return config.staticPaths[this.cursor++ % config.staticPaths.length]; } },
    ];
    let last = performance.now();
    try {
      while (!signal.aborted) {
        const now = performance.now();
        const elapsed = (now - last) / 1000;
        last = now;
        for (const stream of streams) {
          stream.credit += stream.rps * elapsed;
          const due = Math.floor(stream.credit);
          stream.credit -= due;
          const available = Math.min(due, Math.max(0, config.floodConcurrency - inflight.size));
          floodSkipped += due - available;
          for (let i = 0; i < available; i++) {
            const task = request(endpoint(config.url, stream.path()), {}, stream.kind, false)
              .then(({ status }) => { if (status < 200 || status >= 300) floodFailures++; })
              .catch((error) => { if (!signal.aborted) { floodFailures++; recordError(stream.kind, error); } })
              .finally(() => inflight.delete(task));
            inflight.add(task);
          }
        }
        await sleep(20, signal);
      }
    } catch { /* Stage cancellation is expected; requests are aborted and drained below. */ }
    await Promise.allSettled(inflight);
  }

  /**
   * Colyseus does the real HTTP reservation + WebSocket handshake. A late reservation must not leave a socket
   * alive after its deadline or SIGINT.
   */
  function openRoom(roomId, token, joinSignal, extra = {}) {
    const opened = Promise.withResolvers();
    if (joinSignal.aborted) { opened.reject(joinSignal.reason); return opened.promise; }
    const abort = () => opened.reject(joinSignal.reason);
    joinSignal.addEventListener('abort', abort, { once: true });
    new Client(config.wsUrl).joinById(roomId, { token, ...extra }).then((room) => {
      joinSignal.removeEventListener('abort', abort);
      // Fail visibly on disconnects instead of hiding them behind SDK retries
      // (whose console.info chatter would also corrupt stdout's NDJSON).
      room.reconnection.enabled = false;
      if (joinSignal.aborted) { void room.leave(true).catch(() => room.connection.close()); return; }
      opened.resolve(room);
    }, (error) => {
      joinSignal.removeEventListener('abort', abort);
      opened.reject(error);
    });
    return opened.promise;
  }

  /** The pregame socket only starts the lobby and reports admission; the match is entered with an observer ticket. */
  async function joinLobby(roomId, token, events) {
    const room = await openRoom(roomId, token, AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeout)]));
    room.onMessage('lobby:snapshot', events.snapshot);
    room.onMessage('lobby:error', (body) => events.error(body?.code));
    room.onMessage('*', () => {});
    room.onLeave(events.left);
    return { leave: () => leaveSocket(room) };
  }

  async function join(roomId, token, spectator, onView, onLeft, matchSignal) {
    const t = performance.now();
    const room = await openRoom(roomId, token, AbortSignal.any([matchSignal, AbortSignal.timeout(config.requestTimeout)]));
    rooms.add(room);
    if (spectator) spectatorSockets++; else ownerSockets++;
    peakOwners = Math.max(peakOwners, ownerSockets);
    peakSpectators = Math.max(peakSpectators, spectatorSockets);
    const streamMetric = metrics[spectator ? 'spectatorMessages' : 'ownerMessages'] ??= { messages: 0, views: 0 };
    room.onMessage('*', (type, body) => {
      streamMetric.messages++;
      if (type !== MSG.observer) return;
      const view = observerView(body);
      if (!view) return;
      streamMetric.views++;
      onView(view);
    });
    room.onError((code) => onLeft(`websocket_error_${code}`));
    room.onLeave((code) => {
      rooms.delete(room);
      if (spectator) spectatorSockets--; else ownerSockets--;
      onLeft(`websocket_closed_${code}`);
    });
    // Every observer, the creator included, watches all teams.
    room.send(MSG.observer, { perspective: 'all' });
    joinMs.add(performance.now() - t);
    observeSaturation();
    return room;
  }

  /**
   * The creator's exact seats, like the web client: the first seat receives its team's view stream, the others join
   * with `view: false`. The view seat joins last, so its keyframe never arrives before its handlers. Counts every
   * byte the view seat's socket receives during the hold (views dominate it) in 5 s windows.
   */
  async function joinPlayer(ticket, onView, onLeft, matchSignal) {
    const t = performance.now();
    const joined = [];
    const joinSignal = AbortSignal.any([matchSignal, AbortSignal.timeout(config.requestTimeout)]);
    for (let i = ticket.tickets.length - 1; i >= 0; i--) {
      const room = await openRoom(ticket.roomId, ticket.tickets[i].token, joinSignal, i === 0 ? {} : { view: false });
      rooms.add(room);
      joined.push(room);
      room.onError((code) => onLeft(`websocket_error_${code}`));
      room.onLeave((code) => { rooms.delete(room); onLeft(`websocket_closed_${code}`); });
      if (i > 0) { room.onMessage('*', () => {}); continue; }
      playerSockets++;
      peakPlayers = Math.max(peakPlayers, playerSockets);
      room.onLeave(() => { playerSockets--; });
      const streamMetric = metrics.playerMessages ??= { messages: 0, views: 0, keyframes: 0 };
      let state;
      room.onMessage(MSG.view, (body) => {
        streamMetric.messages++;
        streamMetric.views++;
        if ('view' in body) streamMetric.keyframes++;
        state = applyView(state, body);
        if (!state) { viewGaps++; onLeft('view_gap'); return; }
        onView({ tick: state.view.tick, ...(state.view.outcome === 'running' ? {} : { outcome: state.view.outcome }) });
      });
      room.onMessage('*', () => { streamMetric.messages++; });
      const window = { at: performance.now(), bytes: 0 };
      room.connection.transport.ws.addEventListener('message', (event) => {
        const now = performance.now();
        if (phase() !== 'hold') { window.at = now; window.bytes = 0; return; }
        const bytes = event.data?.byteLength ?? 0;
        playerHoldBytes += bytes;
        window.bytes += bytes;
        if (now - window.at < 5000) return;
        playerBytesPerSecond.add(window.bytes * 1000 / (now - window.at));
        window.at = now; window.bytes = 0;
      });
    }
    joinMs.add(performance.now() - t);
    observeSaturation();
    return joined;
  }

  /** Each extra observer is a distinct anonymous profile joining the lobby as an observer. */
  async function spectatorToken(lobby, matchSignal) {
    const profile = await request(endpoint(config.url, '/api/profile'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: matchSignal,
    }, 'profile');
    if (profile.status !== 200 || typeof profile.body?.secret !== 'string') throw new Error(`Profile HTTP ${profile.status}`);
    const member = { code: lobby.code, authorization: `Bearer ${profile.body.secret}` };
    const joined = await request(endpoint(config.url, '/api/lobbies/join'), {
      method: 'POST', headers: { authorization: member.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ code: lobby.code, observer: true }), signal: matchSignal,
    }, 'join');
    if (joined.status !== 200) throw new Error(`Lobby join HTTP ${joined.status}`);
    const ticket = await lobbyRoute(request, config.url, member, 'ticket', 'ticket', matchSignal);
    if (ticket.status !== 200 || ticket.body?.observer !== true || typeof ticket.body?.token !== 'string') {
      throw new Error(`Observer ticket HTTP ${ticket.status}`);
    }
    return ticket.body.token;
  }

  async function play(slot) {
    const matchNumber = nextMatch++;
    const extra = Math.floor(config.spectators / slots) + (slot < config.spectators % slots ? 1 : 0);
    let admitted = false, observedOutcome = false, countedReady = false;
    let admittedAt, lobby;
    const connections = [];
    const matchStop = new AbortController();
    let doneResolve, doneReject;
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    // Disconnections can arrive while another spectator join is in flight.
    done.catch(() => {});
    let matchSignal;
    let onAbort;
    try {
      const { ticket, waitMs } = await acquireTicket({ base: config.url, setup: config.lobby, signal,
        timeout: config.queueTimeout, request, joinLobby, pending, cancel: leaveLobby,
        onQueued(body) { queuePolls++; lastQueuePosition = body.position; },
      });
      lobby = ticket.lobby;
      created++; admitted = true; admissionMs.add(waitMs);
      const t = admittedAt = performance.now();
      matchSignal = AbortSignal.any([signal, matchStop.signal, AbortSignal.timeout(config.matchTimeout)]);
      onAbort = () => doneReject(matchSignal.reason);
      matchSignal.addEventListener('abort', onAbort, { once: true });
      if (matchSignal.aborted) throw matchSignal.reason;
      let checkpoint;
      let previousView;
      const view = (v) => {
        if (!v || !Number.isFinite(v.tick)) return;
        if (phase() === 'hold' && !observedOutcome) {
          const now = performance.now();
          if (previousView && v.tick > previousView.tick) {
            viewDerivedPerTickLagMs.add(Math.max(0, (now - previousView.at) / (v.tick - previousView.tick) - 50));
          }
          previousView = { at: now, tick: v.tick };
          if (!checkpoint) checkpoint = { at: now, tick: v.tick };
          else if (now - checkpoint.at >= 5000) {
            tickHz.add((v.tick - checkpoint.tick) / ((now - checkpoint.at) / 1000));
            checkpoint = { at: now, tick: v.tick };
          }
        } else { checkpoint = undefined; previousView = undefined; }
        if (v.outcome && v.outcome !== 'running' && !observedOutcome) {
          observedOutcome = true;
          outcomes[v.outcome] = (outcomes[v.outcome] ?? 0) + 1;
          doneResolve();
        }
      };
      const left = (why) => { if (!observedOutcome && !matchStop.signal.aborted) doneReject(new Error(why)); };
      if (config.players) connections.push(...await joinPlayer(ticket, view, left, matchSignal));
      else connections.push(await join(ticket.roomId, ticket.token, false, view, left, matchSignal));
      for (let n = 0; n < extra && !observedOutcome; n++) {
        connections.push(await join(ticket.roomId, await spectatorToken(lobby, matchSignal), true, () => {}, left, matchSignal));
      }
      ready++; countedReady = true; peakReady = Math.max(peakReady, ready); observeSaturation();
      await done;
      completed++;
      completionMs.add(performance.now() - t);
    } catch (error) {
      const measurementAbort = error === measurementReason
        || (error?.name === 'AbortError' && signal.reason === measurementReason);
      if (measurementAbort && !overall.signal.aborted) {
        if (admitted && !observedOutcome) intentionallyTruncated++;
        else if (!admitted) cancelledAdmissions++;
        else { completed++; completionMs.add(performance.now() - admittedAt); }
      } else {
        if (admitted && !observedOutcome) abandoned++;
        failed++;
        recordError('match', error, matchNumber);
      }
    } finally {
      if (countedReady) ready--;
      if (onAbort) matchSignal.removeEventListener('abort', onAbort);
      matchStop.abort(new Error('match_finished'));
      await Promise.allSettled(connections.map((room) => closeRoom(room)));
      // The creator leaving its own lobby ends an unfinished game instead of leaving it running server-side.
      if (lobby && !observedOutcome) await leaveLobby(lobby).catch(() => {});
    }
  }

  async function leaveSocket(room) {
    let timer;
    try {
      await Promise.race([
        room.leave(true).catch(() => { room.connection.close(); }),
        new Promise((resolve) => {
          timer = setTimeout(() => { room.connection.close(); resolve(); }, 2000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function closeRoom(room) {
    if (rooms.has(room)) await leaveSocket(room);
  }

  async function leaveLobby(lobby) {
    try {
      const response = await lobbyRoute(request, config.url, lobby, 'leave', 'cancel', AbortSignal.timeout(config.requestTimeout));
      // 404: the lobby already released itself when its match ended.
      if (response.status !== 204 && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      pending.delete(lobby);
    } catch (error) { recordError('cancel', error); throw error; }
  }

  async function featuredViewer(index) {
    let reader, body, timer;
    let connected = false, receivedFrame = false;
    const firstFrameTimeout = new AbortController();
    try {
      await sleep(config.featuredViewers <= 1 ? 0 : config.ramp * 1000 * index / (config.featuredViewers - 1), signal);
      const start = performance.now();
      featured.attempted++;
      timer = setTimeout(() => firstFrameTimeout.abort(new Error('featured_first_frame_timeout')), config.requestTimeout);
      const response = await fetch(endpoint(config.url, '/api/featured/stream'), {
        headers: { accept: 'text/event-stream' },
        signal: AbortSignal.any([signal, firstFrameTimeout.signal]),
      });
      body = response.body;
      featured.statuses[response.status] = (featured.statuses[response.status] ?? 0) + 1;
      headers?.observe(endpoint(config.url, '/api/featured/stream'), 'featured', response);
      if (response.status !== 200) throw new Error(`Featured stream HTTP ${response.status}`);
      if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !body) {
        throw new Error('Featured response is not an SSE stream');
      }
      connected = true;
      featured.connected++; featured.active++;
      featured.peakConnected = Math.max(featured.peakConnected, featured.active);
      featuredConnectMs.add(performance.now() - start);
      const frame = new FirstSseFrame();
      reader = body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!signal.aborted) throw new Error('Featured stream ended before stage completion');
          break;
        }
        featured.bytes += chunk.value.byteLength;
        featured.chunks++;
        // Scan only until the first complete event, then count chunks/bytes.
        // No TextDecoder, JSON parsing, snapshot retention or per-line allocation.
        if (!receivedFrame && frame.push(chunk.value)) {
          receivedFrame = true;
          clearTimeout(timer);
          featured.firstFrames++; featured.ready++;
          featured.peakReady = Math.max(featured.peakReady, featured.ready);
          featuredFirstFrameMs.add(performance.now() - start);
          observeSaturation();
        }
      }
    } catch (error) {
      if (!signal.aborted) { featured.streamErrors++; recordError('featured_stream', error); }
    } finally {
      clearTimeout(timer);
      if (receivedFrame) featured.ready--;
      if (connected) featured.active--;
      if (reader) await reader.cancel().catch(() => {});
      else if (body) await body.cancel().catch(() => {});
    }
  }

  const background = [sampleCapacity(), flood(),
    ...Array.from({ length: config.featuredViewers }, (_, index) => featuredViewer(index))];
  const slotsWork = Array.from({ length: slots }, async (_, slot) => {
    try {
      await sleep(slots <= 1 ? 0 : config.ramp * 1000 * slot / (slots - 1), signal);
      let attempts = 0;
      while (!signal.aborted) {
        if (config.duration > 0) {
          if (performance.now() >= holdEnd) break;
        } else if (slot + attempts * slots >= config.matches) break;
        const before = failed;
        await play(slot);
        attempts++;
        // Do not amplify a failing endpoint with an unbounded fast-create loop.
        if (failed > before) break;
      }
    } catch (error) { if (!signal.aborted) { failed++; recordError('slot', error); } }
  });
  await Promise.all(slotsWork);
  clearTimeout(measurementTimer);
  stop.abort(new Error('stage_finished'));
  await Promise.allSettled(background);
  await Promise.allSettled([...rooms].map(closeRoom));
  await Promise.allSettled([...pending].map(leaveLobby));
  const verdict = classify({ failures: failed + floodFailures + featured.streamErrors + (interrupted ? 1 : 0), saturated: saturated && !floodSkipped,
    headerFailures: headers?.failures ?? 0,
    tickP99: tickP99LagMs.count ? tickP99LagMs.max : null, hzP05: tickHz.quantile(0.05, true),
    lagBudgetMs: config.lagBudgetMs, minHz: config.minHz, capacitySamples });
  const httpMetrics = Object.fromEntries(Object.entries(metrics).filter(([, v]) => v.latency));
  const messageMetrics = Object.fromEntries(Object.entries(metrics).filter(([, v]) => !v.latency));
  const result = { stage: index, slots, spectators: config.spectators, elapsedMs: performance.now() - started,
    holdSeconds: config.duration, rampSeconds: config.ramp, created, completed, failed, abandoned,
    measurementOnly: config.measurementOnly, intentionallyTruncated, cancelledAdmissions,
    serverRestartRequired: config.measurementOnly || abandoned > 0,
    peakOwners, peakSpectators, peakReady, saturated, queuePolls, lastQueuePosition,
    ...(config.players ? { players: { peak: peakPlayers, holdBytes: playerHoldBytes, viewGaps,
      bytesPerSecondPerPlayer: playerBytesPerSecond.json(),
      scope: 'every byte the view-receiving seat socket got during the hold, per 5 s window' } } : {}),
    floodSkipped, floodFailures, outcomes, errors, verdict,
    latencyMs: { admission: admissionMs.json(), join: joinMs.json(), completion: completionMs.json() },
    http: summarizeRequests(httpMetrics), websocket: messageMetrics,
    featured: { ...featured, connectLatencyMs: featuredConnectMs.json(), firstFrameLatencyMs: featuredFirstFrameMs.json() },
    ...(headers ? { headers: headers.json() } : {}),
    observedSimulationHz: { ...tickHz.json(), p05LowerBound: tickHz.quantile(0.05, true) },
    viewDerivedPerTickLagMs: { ...viewDerivedPerTickLagMs.json(),
      inference: 'max(0, wall view interval / tick delta - 50ms); includes network/broadcast jitter, NOT server tick p99' },
    server: { capacitySamples, cpuPercent: cpuPercent.json(), workerCpuCores: workerCpuCores.json(), rssBytes: rssBytes.json(), heapUsedBytes: heapUsedBytes.json(),
      eventLoopP99Ms: eventLoopP99Ms.json(), tickP99LagMs: tickP99LagMs.json(),
      tickP99DurationMs: tickP99DurationMs.json(), tickMaxDurationMs: tickMaxDurationMs.json(),
      tickTelemetryScope: 'cumulative_since_server_boot; independent levels require a server restart' },
  };
  emit('stage', result);
  return result;
}

try {
  const config = options(process.argv.slice(2));
  if (config.help) process.stderr.write(HELP);
  else if (config.target) process.exitCode = await runTarget(config, overall.signal, emit);
  else {
    emit('config', { config });
    const results = [];
    for (const [index, level] of (config.levels ?? [config.concurrency]).entries()) {
      if (overall.signal.aborted) break;
      const result = await runStage(config, level, index);
      results.push(result);
      // Unfinished games would contaminate any next level's capacity measurement.
      if (result.intentionallyTruncated || result.abandoned || result.failed || result.verdict.state === 'fail') break;
    }
    const passing = results.filter((r) => r.verdict.state === 'pass');
    emit('summary', { interrupted, maxPassingTestedMatches: passing.length ? Math.max(...passing.map((r) => r.slots)) : null,
      testedLevels: results.map((r) => ({ slots: r.slots, ...r.verdict })),
      sweepComplete: results.length === (config.levels?.length ?? 1),
      completed: results.reduce((sum, r) => sum + r.completed, 0),
      failed: results.reduce((sum, r) => sum + r.failed, 0),
      intentionallyTruncated: results.reduce((sum, r) => sum + r.intentionallyTruncated, 0),
      cancelledAdmissions: results.reduce((sum, r) => sum + r.cancelledAdmissions, 0),
      serverRestartRequired: results.some((r) => r.serverRestartRequired),
      note: 'Raw worker telemetry is retained in capacity events; parent process CPU/memory are not aggregate worker usage.' });
    process.exitCode = interrupted ? 130 : results.some((r) => r.verdict.state === 'fail' || ((config.levels || config.measurementOnly) && r.verdict.state === 'unknown')) ? 1 : 0;
  }
} catch (error) {
  emit('error', { message: message(error) });
  process.stderr.write(`${message(error)}\nUse --help for usage.\n`);
  process.exitCode = interrupted ? 130 : 2;
}
