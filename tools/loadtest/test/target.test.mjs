import assert from 'node:assert/strict';
import test from 'node:test';
import { options } from '../src/core.mjs';
import { runTarget, TARGET_CREATE_INTERVAL_MS, targetBreach, targetTelemetryAvailable } from '../src/target.mjs';
import { Client } from '@colyseus/sdk';
import { MSG } from 'playerthree/protocol';

test('target requires an explicit host and preserves completion defaults', () => {
  const normal = options([]);
  assert.equal(normal.target, undefined);
  assert.equal(normal.lagBudgetMs, 50);
  assert.equal(normal.sampleInterval, 2000);
  const target = options(['--target', 'https://agentcommand.gg', '--levels', '1,2,4,8,16']);
  assert.equal(target.target, 'https://agentcommand.gg/');
  assert.equal(target.url, 'https://agentcommand.gg/');
  assert.equal(target.wsUrl, 'https://agentcommand.gg/');
  assert.equal(target.dwell, 30);
  assert.equal(target.maxWall, 600000);
  assert.equal(target.maxMatches, 64);
  assert.equal(target.lagBudgetMs, 25);
  assert.equal(target.sampleInterval, 1000);
});

test('target caps wall time and total game creation without bypass options', () => {
  assert.throws(() => options(['--target', 'https://example.test', '--max-wall', '601']));
  assert.throws(() => options(['--target', 'https://example.test', '--max-matches', '65']));
  assert.throws(() => options(['--target', 'https://example.test', '--max-matches', '4', '--levels', '8']));
  assert.throws(() => options(['--target', 'https://example.test', '--featured-viewers', '1']));
  assert.throws(() => options(['--target', 'https://example.test', '--spectators', '1']));
  assert.throws(() => options(['--target', 'https://example.test', '--home-rps', '1']));
  assert.throws(() => options(['--target', 'https://example.test', '--dwell', '0']));
});

test('first exposed main or sampled worker lateness breach stops target mode', () => {
  assert.deepEqual(targetBreach({ eventLoop: { p99Ms: 26 }, workers: [] }, 25),
    { code: 'main_event_loop_budget', p99Ms: 26, budgetMs: 25 });
  const capacity = { eventLoop: { p99Ms: 1 }, workers: [
    { id: 'worker0', p95LagMs: 2, windowSamples: 200 },
    { id: 'worker1', p95LagMs: 26, windowSamples: 200 },
  ] };
  assert.deepEqual(targetBreach(capacity, 25),
    { code: 'worker_lag_budget', worker: 'worker1', p95LagMs: 26, windowSamples: 200, budgetMs: 25 });
  assert.equal(targetBreach({ workers: [{ p95LagMs: 100, windowSamples: 0 }] }, 25), null);
  assert.equal(targetBreach({ eventLoop: { p99Ms: 25 }, workers: [{ p95LagMs: 25, windowSamples: 20 }] }, 25), null);
  assert.equal(targetBreach({ workers: [{ p95LagMs: 27, windowSamples: 14 }] }, 25), null);
  assert.equal(targetBreach({ workers: [{ p95LagMs: 100, windowSamples: 99 }] }, 25), null);
  assert.deepEqual(targetBreach({ workers: [{ worker: 0, p95LagMs: 27, windowSamples: 100 }] }, 25),
    { code: 'worker_lag_budget', worker: 0, p95LagMs: 27, windowSamples: 100, budgetMs: 25 });
});

test('stable target level requires actual rolling samples on active workers', () => {
  assert.equal(targetTelemetryAvailable({ eventLoop: { p99Ms: 1 }, workers: [] }), false);
  assert.equal(targetTelemetryAvailable({ eventLoop: { p99Ms: 1 }, workers: [{ active: 1, p95LagMs: 0, windowSamples: 0 }] }), false);
  assert.equal(targetTelemetryAvailable({ eventLoop: { p99Ms: 1 }, workers: [{ active: 1, p95LagMs: 27, windowSamples: 99 }] }), false);
  assert.equal(targetTelemetryAvailable({ eventLoop: { p99Ms: 1 }, workers: [{ active: 1, p95LagMs: 2, windowSamples: 100 }] }), true);
  assert.equal(targetTelemetryAvailable({ eventLoop: { p99Ms: 1 }, workers: [
    { active: 1, p95LagMs: 2, windowSamples: 200 }, { active: 0, p95LagMs: 0, windowSamples: 0 },
  ] }), true);
  assert.equal(targetTelemetryAvailable({ eventLoop: { p99Ms: 1 }, workers: [
    { rooms: [{ ended: false }], p95LagMs: 2, windowSamples: 200 },
  ] }), true);
});

function mockTargetNetwork(t, pressure) {
  const createdAt = [];
  const left = [];
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/lobbies') {
      createdAt.push(performance.now());
      return Response.json({ code: `L${createdAt.length}`.padEnd(16, '0'), roomId: 'pregame', visitorToken: 'v'.repeat(32) });
    }
    if (path.endsWith('/connect')) return Response.json({ roomId: 'pregame', token: 'g'.repeat(32), expiresAt: 0 });
    if (path.endsWith('/ticket')) return Response.json({ roomId: `room${path.split('/')[3]}`, token: 'a'.repeat(32), observer: true, readOnly: true });
    if (path.endsWith('/leave')) { left.push(path.split('/')[3]); return new Response(null, { status: 204 }); }
    return Response.json({ eventLoop: { p99Ms: 1 },
      workers: createdAt.length ? [{ worker: 0, active: createdAt.length, ...pressure(++reads) }] : [] });
  });
  t.mock.method(Client.prototype, 'joinById', async (roomId) => {
    let onLeave;
    return {
      reconnection: { enabled: true }, connection: { close() { onLeave?.(1000); } },
      onMessage(type, callback) {
        if (roomId === 'pregame') { if (type === 'lobby:snapshot') callback({ phase: 'started' }); return; }
        callback(MSG.observer, { op: 'observer', state: 'ready', frame: { tick: 1 } });
        callback(MSG.observer, { op: 'observer', state: 'ready', frame: { tick: 2, outcomes: { nw: 'running', se: 'running' } } });
      },
      send() {}, onError() {}, onLeave(callback) { onLeave = callback; },
      async leave() { onLeave?.(1000); },
    };
  });
  return { createdAt, left };
}

test('target match creation is staggered rather than bursting a new level', { timeout: 6000 }, async (t) => {
  const { createdAt, left } = mockTargetNetwork(t, () => ({ p95LagMs: 1, windowSamples: 100 }));
  const config = options(['--target', 'https://example.test', '--levels', '2', '--dwell', '.01', '--max-wall', '5']);
  assert.equal(await runTarget(config, new AbortController().signal, () => {}), 0);
  assert.equal(createdAt.length, 2);
  assert.ok(createdAt[1] - createdAt[0] >= TARGET_CREATE_INTERVAL_MS - 5); // Timer/request bookkeeping precision.
  // Cleanup leaves every created lobby, which ends its game rather than leaving it running.
  assert.equal(left.length, 2);
});

test('a cold late sample during the dwell does not prevent later mature certification', { timeout: 6000 }, async (t) => {
  mockTargetNetwork(t, (read) => read === 1
    ? { p95LagMs: 27, windowSamples: 14 } : { p95LagMs: 1, windowSamples: 100 });
  const events = [];
  const config = options(['--target', 'https://example.test', '--levels', '1', '--dwell', '1.2', '--max-wall', '5']);
  assert.equal(await runTarget(config, new AbortController().signal, (event, body) => events.push({ event, body })), 0);
  assert.equal(events.find((entry) => entry.event === 'summary').body.largestStableLevel, 1);
});
