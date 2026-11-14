import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { FirstSseFrame, HeaderObservations, Histogram, LOBBY_PRESET, PLAYER_PRESET, acquireTicket, classify, endpoint, observerView, options, retryDelay } from '../src/core.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/`;
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const publicRequest = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json(), headers: response.headers };
};

const CODE = 'C'.repeat(16);
const SETUP = { mapId: 'open', layoutId: 'duel' };
const started = (_roomId, _token, events) => { events.snapshot({ phase: 'started' }); return { leave() {} }; };
/** Lobby routes after creation: connect grants the pregame socket, ticket mints the creator's observer ticket. */
function lobbyRoutes(req, res) {
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, 'Visitor visitor_secret');
  if (req.url === `/api/lobbies/${CODE}/connect`) return send(res, 200, { roomId: 'pregame', token: 'grant', expiresAt: 0 });
  assert.equal(req.url, `/api/lobbies/${CODE}/ticket`);
  send(res, 200, { roomId: 'room_1', token: 'observer', observer: true, readOnly: true });
}
const created = () => ({ status: 200, body: { code: CODE, roomId: 'pregame', visitorToken: 'visitor_secret' }, headers: new Headers() });
const fake = (routes) => async (url, init) => {
  const path = new URL(url).pathname;
  if (path === '/api/lobbies') return routes.create();
  if (path.endsWith('/connect')) return { status: 200, body: { roomId: 'pregame', token: 'grant' }, headers: new Headers() };
  return routes.other(path, init);
};

// Public HTTP fixture, not the dev/admin API. Real WebSocket handshakes are done by
// @colyseus/sdk in main.mjs; these deterministic tests isolate admission behavior.
test('creates an all-bot auto-start lobby, attaches, reports queueing, then mints the creator observer ticket', async (t) => {
  let posts = 0;
  const base = await fixture(t, async (req, res) => {
    if (req.url !== '/api/lobbies') return lobbyRoutes(req, res);
    posts++;
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { ...SETUP, ...LOBBY_PRESET });
    send(res, 200, { code: CODE, roomId: 'pregame', visitorToken: 'visitor_secret' });
  });
  const pending = new Set();
  const positions = [];
  let left = 0;
  const { ticket } = await acquireTicket({ base, setup: SETUP, signal: new AbortController().signal,
    timeout: 3000, request: publicRequest, pending, onQueued: (body) => positions.push(body.position),
    joinLobby: (roomId, token, events) => {
      assert.deepEqual([roomId, token], ['pregame', 'grant']);
      events.snapshot({ phase: 'preparing', queuePosition: 2 });
      events.snapshot({ phase: 'preparing', queuePosition: 1 });
      events.snapshot({ phase: 'started' });
      return { leave() { left++; } };
    } });
  assert.equal(posts, 1);
  assert.deepEqual(ticket, { roomId: 'room_1', token: 'observer', lobby: { code: CODE, authorization: 'Visitor visitor_secret' } });
  assert.deepEqual(positions, [2, 1]);
  assert.equal(left, 1);
  assert.equal(pending.size, 0);
});

test('429 and 409 capacity only retry explicit rejections and honor Retry-After', async (t) => {
  let posts = 0;
  const base = await fixture(t, (req, res) => {
    if (req.url !== '/api/lobbies') return lobbyRoutes(req, res);
    posts++;
    if (posts === 1) return send(res, 429, { error: 'rate_limited' }, { 'retry-after': '0.1' });
    if (posts === 2) return send(res, 409, { error: 'capacity' }, { 'retry-after': '0.1' });
    send(res, 200, { code: CODE, roomId: 'pregame', visitorToken: 'visitor_secret' });
  });
  const result = await acquireTicket({ base, setup: SETUP, signal: new AbortController().signal,
    timeout: 3000, request: publicRequest, pending: new Set(), joinLobby: started });
  assert.equal(result.ticket.roomId, 'room_1');
  assert.equal(posts, 3);
  assert.ok(result.waitMs >= 180);
});

test('ambiguous POST network failure is never retried', async () => {
  let calls = 0;
  await assert.rejects(acquireTicket({ base: 'http://example.test/', setup: SETUP, signal: new AbortController().signal,
    timeout: 1000, pending: new Set(), joinLobby: started,
    request: async () => { calls++; throw new Error('network_failure'); } }), /network_failure/);
  assert.equal(calls, 1);
});

test('other create rejections fail rather than being retried', async () => {
  let calls = 0;
  await assert.rejects(acquireTicket({ base: 'http://example.test/', setup: SETUP, signal: new AbortController().signal,
    timeout: 1000, pending: new Set(), joinLobby: started, request: async () => {
      calls++;
      return { status: 400, body: { error: 'unsupported_layout' }, headers: new Headers() };
    } }), /Create HTTP 400: unsupported_layout/);
  assert.equal(calls, 1);
});

test('admission deadline leaves the created lobby immediately', async () => {
  const pending = new Set();
  const cancelled = [];
  await assert.rejects(acquireTicket({ base: 'http://example.test/', setup: SETUP, signal: new AbortController().signal,
    timeout: 30, pending, joinLobby: () => ({ leave() {} }),
    request: fake({ create: created, other: () => assert.fail('no ticket before start') }),
    cancel: async (lobby) => { cancelled.push(lobby.code); pending.delete(lobby); },
  }), { name: 'TimeoutError' });
  assert.deepEqual(cancelled, [CODE]);
  assert.equal(pending.size, 0);
});

test('failed leave retains the pending lobby for final cleanup', async () => {
  const pending = new Set();
  await assert.rejects(acquireTicket({ base: 'http://example.test/', setup: SETUP, signal: new AbortController().signal,
    timeout: 30, pending, joinLobby: () => ({ leave() {} }),
    request: fake({ create: created, other: () => assert.fail('no ticket before start') }),
    cancel: async () => { throw new Error('leave_network_failure'); },
  }), { name: 'TimeoutError' });
  assert.deepEqual([...pending].map((lobby) => lobby.code), [CODE]);
});

test('a lobby preparation error fails admission and leaves the lobby', async () => {
  const cancelled = [];
  await assert.rejects(acquireTicket({ base: 'http://example.test/', setup: SETUP, signal: new AbortController().signal,
    timeout: 1000, pending: new Set(),
    joinLobby: (_roomId, _token, events) => { events.error('busy'); return { leave() {} }; },
    request: fake({ create: created, other: () => assert.fail('no ticket after a failed start') }),
    cancel: async (lobby) => { cancelled.push(lobby.code); },
  }), /Lobby error: busy/);
  assert.deepEqual(cancelled, [CODE]);
});

test('observer frames yield ticks, and an outcome only once every team is decided', () => {
  assert.equal(observerView({ op: 'observer', state: 'buffering' }), undefined);
  assert.deepEqual(observerView({ frame: { tick: 40, outcomes: { nw: 'running', ne: 'running', se: 'running', sw: 'running' } } }), { tick: 40 });
  assert.deepEqual(observerView({ frame: { tick: 41 } }), { tick: 41 });
  assert.deepEqual(observerView({ frame: { tick: 900, outcomes: { nw: 'loss', se: 'win' } } }), { tick: 900, outcome: 'loss' });
});

test('retry supports HTTP dates and bounded polling delay', () => {
  assert.equal(retryDelay(new Headers({ 'retry-after': '2' }), {}), 2000);
  assert.equal(retryDelay(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' }), {}, 1000), 4000);
  assert.equal(retryDelay(new Headers(), { pollAfterMs: 750 }), 750);
  assert.equal(retryDelay(new Headers(), { pollAfterMs: -1 }), 100);
});

test('capacity cannot pass on absent telemetry, missing saturation, or slow simulation', () => {
  const base = { failures: 0, saturated: true, tickP99: 3, hzP05: 20, lagBudgetMs: 50, minHz: 19, capacitySamples: 4 };
  assert.equal(classify(base).state, 'pass');
  assert.equal(classify({ ...base, tickP99: null }).state, 'unknown');
  assert.equal(classify({ ...base, hzP05: null }).state, 'unknown');
  assert.equal(classify({ ...base, saturated: false }).state, 'unknown');
  assert.equal(classify({ ...base, tickP99: 51 }).state, 'fail');
  assert.equal(classify({ ...base, hzP05: 18 }).state, 'fail');
  assert.equal(classify({ ...base, failures: 1 }).state, 'fail');
});

test('bounded histogram reports sample statistics without retaining all values', () => {
  const h = new Histogram();
  assert.equal(h.quantile(0.99), null);
  for (let n = 1; n <= 1000; n++) h.add(n);
  assert.equal(h.json().count, 1000);
  assert.equal(h.json().mean, 500.5);
  assert.ok(h.quantile(0.99) >= 990 && h.quantile(0.99) <= 1000);
  assert.ok(h.bins.size < 200);
});

test('CLI validates concurrency, ascending sweep levels, and flood asset paths', () => {
  assert.equal(options(['--matches', '4', '--spectators', '12']).concurrency, 4);
  assert.equal(options(['--levels', '1,2,4']).duration, 60);
  assert.equal(options(['--', '--matches', '2']).matches, 2);
  assert.throws(() => options(['--matches', '1', '--concurrency', '2']));
  assert.throws(() => options(['--levels', '2,1']));
  assert.throws(() => options(['--static-rps', '10']));
  assert.throws(() => options(['--static-path', '//other.test/asset']));
  assert.equal(endpoint('http://example.test/prefix/', '/api/lobbies'), 'http://example.test/prefix/api/lobbies');
  assert.deepEqual(options([]).lobby, { mapId: 'open', layoutId: 'duel', ...LOBBY_PRESET });
  assert.deepEqual(options(['--map', 'ridges', '--layout', 'duel']).lobby, { mapId: 'ridges', layoutId: 'duel', ...LOBBY_PRESET });
  assert.deepEqual(options(['--fixture', 'ffa']).lobby, { mapId: 'four_corners', layoutId: 'ffa', ...LOBBY_PRESET });
  assert.deepEqual(options(['--fixture', 'ffa', '--map', 'open']).lobby, { mapId: 'open', layoutId: 'ffa', ...LOBBY_PRESET });
  assert.throws(() => options(['--fixture', 'toString']), /--fixture/);
  // Players play a 'play' lobby as its creator; they never mix with extra observers or target mode.
  assert.deepEqual(options(['--players']).lobby, { mapId: 'open', layoutId: 'duel', ...PLAYER_PRESET });
  assert.throws(() => options(['--players', '--spectators', '2']));
  assert.throws(() => options(['--players', '--target', 'http://example.test']));
});

test('headers preserve cache/compression evidence and enforce public response policies', () => {
  const h = new HeaderObservations();
  const observe = (path, kind, values) => h.observe(`http://example.test${path}`, kind,
    { status: 200, headers: new Headers(values) });
  observe('/assets/main-abc123.js', 'static', {
    'content-type': 'application/javascript', 'cache-control': 'public,max-age=31536000,immutable',
    'content-encoding': 'br', vary: 'Accept-Encoding',
  });
  observe('/', 'home', { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', vary: 'Accept-Encoding' });
  observe('/api/capacity', 'capacity', { 'content-type': 'application/json', 'cache-control': 'no-store' });
  assert.equal(h.failures, 0);
  const result = h.json();
  assert.equal(result.urls[0].expectedCachePolicy, 'immutable');
  assert.equal(result.urls[0].variants[0].contentEncoding, 'br');
  assert.equal(result.urls[0].checks.encodingVary.pass, 1);
  assert.equal(result.urls[1].expectedCachePolicy, 'no-cache');
  assert.equal(result.urls[2].checks.cacheControl.pass, 1);
  assert.equal(result.urls[2].checks.encodingVary.notApplicable, 1);
});

test('headers fail mutable hashed assets, cached HTML/API and missing negotiation Vary', () => {
  const h = new HeaderObservations();
  for (const [path, kind, contentType, cache] of [
    ['/assets/main-abc123.css', 'static', 'text/css', 'public,max-age=10'],
    ['/', 'home', 'text/html', 'public,max-age=600'],
    ['/api/lobbies', 'create', 'application/json', 'no-cache'],
  ]) {
    h.observe(`http://example.test${path}`, kind, { status: 200,
      headers: new Headers({ 'content-type': contentType, 'cache-control': cache, 'content-encoding': 'gzip' }) });
  }
  assert.equal(h.failures, 3);
  assert.equal(h.json().urls[0].checks.encodingVary.fail, 1);
  const verdict = classify({ failures: 0, headerFailures: h.failures, saturated: true,
    tickP99: 1, hzP05: 20, lagBudgetMs: 50, minHz: 19, capacitySamples: 1 });
  assert.equal(verdict.reason, 'response_header_policy_failure');
});

test('header evidence bounds URLs and variants while checking every response', () => {
  const h = new HeaderObservations();
  for (let n = 0; n < 60; n++) h.observe(`http://example.test/assets/path${n}.png`, 'static',
    { status: 200, headers: new Headers({ 'content-type': 'image/png' }) });
  assert.equal(h.json().urls.length, 50);
  assert.equal(h.json().omittedResponses, 10);
  for (let n = 0; n < 12; n++) h.observe('http://example.test/assets/path0.png', 'static',
    { status: 200, headers: new Headers({ vary: `X-Variant-${n}` }) });
  assert.equal(h.json().urls[0].variants.length, 8);
  assert.equal(h.json().urls[0].omittedVariants, 5);
});

test('header observations redact lobby codes and collapse their URLs; a bodiless leave is not cache-checked', () => {
  const h = new HeaderObservations();
  for (const code of ['privateFirst0000', 'privateSecond000']) {
    h.observe(`http://example.test/api/lobbies/${code}/ticket`, 'ticket',
      { status: 200, headers: new Headers({ 'cache-control': 'no-store' }) });
    h.observe(`http://example.test/api/lobbies/${code}/leave`, 'cancel', { status: 204, headers: new Headers() });
  }
  assert.equal(h.failures, 0);
  assert.deepEqual(h.json().urls.map((entry) => [entry.url, entry.responses]), [
    ['http://example.test/api/lobbies/:code/ticket', 2], ['http://example.test/api/lobbies/:code/leave', 2]]);
  assert.doesNotMatch(JSON.stringify(h.json()), /private/);
  assert.equal(options(['--headers']).headers, true);
});

test('measurement-only requires a bounded hold and forbids multiple server-contaminating levels', () => {
  assert.equal(options([]).measurementOnly, false);
  assert.throws(() => options(['--measurement-only']), /positive --duration/);
  assert.throws(() => options(['--measurement-only', '--duration', '0']), /positive --duration/);
  assert.throws(() => options(['--measurement-only', '--levels', '1,2', '--duration', '120']), /at most one/);
  const config = options(['--measurement-only', '--levels', '4', '--duration', '120', '--ramp', '20']);
  assert.equal(config.measurementOnly, true);
  assert.equal(config.duration, 120);
  assert.deepEqual(config.levels, [4]);
  assert.equal(config.ramp, 20);
  assert.equal(options(['--measurement-only', '--matches', '4', '--duration', '180']).concurrency, 4);
});

test('featured viewer count defaults to zero and is bounded at ten thousand', () => {
  assert.equal(options([]).featuredViewers, 0);
  assert.equal(options(['--featured-viewers', '10000']).featuredViewers, 10000);
  for (const value of ['10001', '-1', '1.5', 'NaN']) {
    assert.throws(() => options(['--featured-viewers', value]), /featured-viewers/);
  }
});

test('SSE first-frame latency boundary ignores comments and admission and waits for a released frame', () => {
  const frame = new FirstSseFrame();
  assert.equal(frame.push(Buffer.from(': heartbeat\n\nevent: observer\ndata: {"op":"observer","state":"buffering"}\n\n')), false);
  assert.equal(frame.push(Buffer.from('event: match\ndata: {"roomId":"r"}\n\nevent: observer\n')), false);
  assert.equal(frame.push(Buffer.from('da')), false);
  assert.equal(frame.push(Buffer.from('ta: {"op":"observer","state":"ready","frame":{"tick":20}}')), false);
  assert.equal(frame.push(Buffer.from('\n')), false);
  assert.equal(frame.push(Buffer.from('\n')), true);
  assert.equal(frame.found, true);
});

test('SSE first frame handles CRLF split across chunks without false event boundaries', () => {
  const frame = new FirstSseFrame();
  assert.equal(frame.push(Buffer.from('event: observer\r')), false);
  assert.equal(frame.push(Buffer.from('\ndata: {"op":"observer","state":"ready","frame":{}}\r')), false);
  assert.equal(frame.push(Buffer.from('\ndata: second\r')), false);
  assert.equal(frame.push(Buffer.from('\n\r')), true);
});

test('SSE framing retains no frame bytes and stops scanning after the first frame', () => {
  const frame = new FirstSseFrame();
  assert.equal(frame.push(Buffer.from('data: {"op":"observer","state":"ready","frame":')), false);
  assert.equal(frame.push(Buffer.alloc(1024 * 1024, 120)), false);
  assert.equal(frame.push(Buffer.from('\n\n')), true);
  assert.ok(Object.values(frame).every((value) => typeof value === 'number' || typeof value === 'boolean'));
  const scannedBytes = frame.lineLength;
  assert.equal(frame.push(Buffer.alloc(1024 * 1024, 120)), true);
  assert.equal(frame.lineLength, scannedBytes);
});
