#!/usr/bin/env node
// Node >=24; use a FRESH isolated server with DATA_DIR (or Postgres), plus matching PUBLIC_URL/CORS.
// pnpm --filter @agent-command/web test:arena
// AC_ARENA_URL=http://127.0.0.1:5173 SERVER_URL=http://127.0.0.1:2567 AC_ARENA_OUTPUT=/tmp/ac-arena
// Optional CHROMIUM_PATH, AC_ARENA_PLAYWRIGHT_PATH, AC_ARENA_TIMEOUT_MS (default 480000).
// Uses two independent browsers (one context each: separate users never share a renderer/GPU process),
// real runner MCP sessions and natural simulation outcomes.
// Public observation intentionally waits the real 180-second release clock. No dev/admin endpoints,
// fabricated state, request interception, injected winners, clock overrides, or browser-binary download.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const webRequire = createRequire(new URL('../package.json', import.meta.url));
const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
// playwright-core is a dev dependency of tools/dev-mcp (as for the sibling check scripts); its ESM entry sits beside package.json.
const toolsRequire = createRequire(new URL('../../../tools/dev-mcp/package.json', import.meta.url));
const playwrightPath = process.env.AC_ARENA_PLAYWRIGHT_PATH ?? join(dirname(toolsRequire.resolve('playwright-core/package.json')), 'index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const { connectSeat } = await import(pathToFileURL(serverRequire.resolve('@playerthree/runner')).href);
const { resolveRules } = await import(pathToFileURL(serverRequire.resolve('@agent-command/game/contract')).href);
const { Client } = webRequire('@colyseus/sdk');
const web = (process.env.AC_ARENA_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const server = (process.env.SERVER_URL ?? 'http://127.0.0.1:2567').replace(/\/$/, '');
const out = process.env.AC_ARENA_OUTPUT ?? '/tmp/ac-arena';
const timeout = Number(process.env.AC_ARENA_TIMEOUT_MS ?? 480000);
assert(Number.isFinite(timeout) && timeout >= 360000, 'Acceptance needs at least 360000ms for public 180s release and two real-time 60s agent matches.');
const deadline = Date.now() + timeout;
const report = { startedAt: new Date().toISOString(), phases: [], http: [], consoleErrors: [], removedApiRequests: [], checks: [] };
const secrets = new Set();
const sessions = [];
const cleanups = [];
const agentJobs = [];
const agentFailures = [];
const agentEvidence = new Map();
const liveStreams = new Set();
let agentsStopped = false;
let phase = 'startup';
const browsers = [];
let owner;
let guest;
let a;
let b;
let currentSeries;
let failure;
const remaining = () => Math.max(1, deadline - Date.now());
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digestRules = (rules) => `sha256:${sha256(canonical(rules))}`;
function check(label, evidence = {}) { report.checks.push({ label, ...evidence }); }
function noSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert(!text.includes(secret), 'A private credential/owner/commander reference leaked into public evidence.');
}
async function until(read, label, limit = 20000) {
  const end = Math.min(deadline, Date.now() + limit);
  do {
    const value = await read();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < end);
  assert.fail(`Timed out: ${label}`);
}
async function phaseStart(name) { phase = name; report.phases.push({ name, at: new Date().toISOString() }); }
async function screenshot(page, name) {
  // Never expand Connection setup, record a Playwright trace, or serialize localStorage into artifacts.
  // Headless WebGL is software-rendered (llvmpipe); a full-page capture waits for a fresh composited frame.
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true, timeout: Math.min(60000, remaining()) });
}
async function api(path, { profile, visitor, body, method, status = 200, signal } = {}) {
  const response = await fetch(new URL(path, server), {
    method: method ?? (body === undefined ? 'GET' : 'POST'), signal: signal ?? AbortSignal.timeout(Math.min(20000, remaining())),
    headers: { ...(profile ? { authorization: `Bearer ${profile.secret}` } : visitor ? { authorization: `Visitor ${visitor}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, status, `${method ?? (body === undefined ? 'GET' : 'POST')} ${path.replace(/\/share\/[^/]+/, '/share/[token]')}`);
  return response;
}
async function json(path, options) { return (await api(path, options)).json(); }
function track(page, label) {
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/match(?:\/|$)/.test(path)) report.removedApiRequests.push({ context: label, method: request.method(), path });
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/') && !path.endsWith('/events')) report.http.push({ context: label, method: response.request().method(), path: path.replace(/(\/commanders\/)[^/]+/g, '$1[id]'), status: response.status() });
  });
  page.on('pageerror', (error) => report.consoleErrors.push({ context: label, message: error.message }));
  page.on('dialog', (dialog) => dialog.accept());
}
async function home(page) {
  await page.goto(`${web}/?renderer=webgl&debug`, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, remaining()) });
  await page.locator('[data-lobby-action="play"]').waitFor();
}
async function idle(page) {
  await page.waitForFunction(() => !document.querySelector('.prematch[aria-busy="true"]'));
  const message = await page.locator('.lobby-msg').textContent();
  assert.equal(message?.trim(), '', `Lobby action failed: ${message}`);
}
async function action(page, name) { await page.locator(`[data-lobby-action="${name}"]`).first().click(); await idle(page); }
async function openDetails(page, selector) {
  const details = page.locator(selector);
  if (!await details.evaluate((element) => element.open)) await details.locator(':scope > summary').click();
}
/** Switch an army card's seat mode: per plane (a row per plane) or all planes (one army selector). */
async function seatMode(page, side, mode) {
  const button = page.locator(`[data-lobby-action="seat-mode-${side}-${mode}"]`);
  if (await button.getAttribute('aria-checked') !== 'true') { await button.click(); await idle(page); }
}
const perPlane = (page, side) => seatMode(page, side, 'planes');
async function lobbyCode(page) { return until(async () => new URLSearchParams(new URL(page.url()).hash.slice(1)).get('l'), 'lobby code'); }
/** Home's `play` (Quick Play) or `create` (Create Game) opens a fresh room; the response carries its code. */
async function create(page, entry) {
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/lobbies' && response.request().method() === 'POST');
  await page.locator(`[data-lobby-action="${entry}"]`).first().click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, `Create ${entry}`);
  const address = await response.json();
  const input = response.request().postDataJSON();
  if (address.visitorToken) secrets.add(address.visitorToken);
  cleanups.push({ code: address.code, visitor: address.visitorToken, page });
  return { ...address, input };
}
/** Create Game, then the organizer moves to Observers and both whole armies become bots: an agent/bot-only lineup. */
async function createBotLineup(page) {
  const room = await create(page, 'create');
  await page.locator('.lobby-army[data-side="red"]').waitFor();
  await action(page, 'move-observer');
  for (const side of ['blue', 'red']) { await page.locator(`.lobby-army[data-side="${side}"] .lobby-whole-army select[data-occupant]`).selectOption('bot'); await idle(page); }
  return room;
}
/** The room's setup column is tabbed (Match / Rules / Series). */
async function tab(page, id) { await page.locator(`[data-setup-tab="${id}"]`).click(); }
/** Seats one of my commanders by dragging its dock chip onto a slot (the room's primary placement gesture). */
async function dragCommander(page, id, seat) {
  await page.locator(`.pm-dock [data-commander-id="${id}"]`).dragTo(page.locator(`[data-seat="${seat}"]`));
  await idle(page);
  await until(async () => await page.locator(`[data-occupant="${seat}"]`).inputValue() === `commander:${id}`, `dragged ${id} onto ${seat}`);
}
async function profile(page) {
  const value = await page.evaluate(() => JSON.parse(localStorage.getItem('agent-command.profile') ?? 'null'));
  assert(value?.id && value?.secret, 'UI must lazily create its real authenticated profile.');
  secrets.add(value.id); secrets.add(value.secret);
  return value;
}
async function rule(page, path, value) {
  await tab(page, 'rules');
  await openDetails(page, '.rules-editor__advanced');
  const group = path.startsWith('spire.') ? 'match' : path.split('.')[0];
  await openDetails(page, `[data-rule-group="${group}"]`);
  const control = page.locator(`[data-rule-path="${path}"]`);
  await control.fill(String(value));
  await control.press('Tab');
  await idle(page);
  await until(async () => await page.locator(`[data-rule-path="${path}"]`).inputValue() === String(value), `committed ${path}`);
}
async function rendered(page) {
  await page.waitForFunction(() => !!window.__agentCommand?.world?.view && window.__agentCommand.world.perf.frames > 0, undefined, { timeout: Math.min(40000, remaining()) });
  await page.evaluate(() => document.fonts.ready);
}
async function game(page, team) {
  await page.waitForFunction((expected) => {
    const game = window.__agentCommand?.game();
    return game?.view && (!expected || game.view.team === expected) && game.view.tick > 0;
  }, team, { timeout: Math.min(40000, remaining()) });
  await rendered(page);
  await page.locator('canvas.gl').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.__agentCommand.world.backend), 'WebGL2', 'Acceptance must use the real WebGL renderer.');
  return page.evaluate(() => {
    const g = window.__agentCommand.game();
    return { team: g.view.team, tick: g.view.tick, roomId: g.opts.roomId, roles: g.opts.tickets.map((ticket) => ticket.role).sort(), rules: g.view.match.rules };
  });
}
async function watchWire(page) {
  await page.waitForFunction(() => !!window.__agentCommand?.game()?.streams?.get('all')?.conn?.room);
  await page.evaluate(() => {
    const room = window.__agentCommand.game().streams.get('all').conn.room;
    const evidence = { messages: [], frames: [], connectedAt: Date.now() };
    window.__arenaAcceptanceWire = evidence;
    const record = (type, message) => {
      const at = Date.now();
      if (type === 'playerthree:observer') {
        const frame = message.frame;
        evidence.messages.push({ type, at, state: message.state, hasFrame: !!frame, keys: Object.keys(message).sort() });
        if (frame) {
          const world = 'world' in frame.world ? frame.world.world : frame.world;
          evidence.frames.push({ at, sequence: frame.sequence, tick: frame.tick, recordedAt: frame.recordedAt, releaseAt: frame.releaseAt, perspective: frame.perspective, hasOutcome: !!frame.outcomes, vision: Object.fromEntries(Object.entries(world.vision).map(([plane, bits]) => [plane, { length: bits.length, hidden: [...bits].filter((bit) => bit === 0).length }])) });
        }
      } else evidence.messages.push({ type: String(type), at, ok: message?.ok });
      if (evidence.messages.length > 10000) evidence.messages.shift();
    };
    // The SDK routes '*' only to types without a registered handler; the observer client owns 'playerthree:observer', so tap
    // it with a second listener (it runs in the same task, right after the client's own handler).
    room.onMessage('playerthree:observer', (message) => record('playerthree:observer', message));
    room.onMessage('*', record);
    room.send('playerthree:observer', { perspective: 'all' });
  });
}
async function rpc(page, type, message, expected = 'forbidden') {
  const result = await page.evaluate(async ({ type, message }) => {
    const room = window.__agentCommand.game().streams.get('all').conn.room;
    const seq = 900000 + Math.floor(Math.random() * 900000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`No actual transport rejection for ${type}`)); }, 10000);
      const off = room.onMessage('playerthree:result', (result) => {
        if (result.seq !== seq) return;
        clearTimeout(timer); off(); resolve(result);
      });
      room.send(type, { ...message, seq });
    });
  }, { type, message });
  assert.equal(result.ok, false, `${type} must be denied on observer transport`);
  assert.equal(result.code, expected, `${type} exact authority error`);
}
async function observerNegatives(page) {
  for (const [type, body] of [
    ['playerthree:call', { op: 'call', role: 'surface', method: 'act', args: { intents: [{ kind: 'rally', x: 20, y: 20 }] } }],
    ['playerthree:call', { op: 'call', role: 'surface', method: 'observe', args: {} }],
    ['playerthree:call', { op: 'call', role: 'surface', method: 'policyDeploy', args: { runtime: 'js', code: 'export default () => []' } }],
    ['playerthree:mint', { op: 'mint', role: 'surface' }],
    ['playerthree:controller', { op: 'controller', role: 'surface', controller: 'human' }],
    ['playerthree:mandate', { op: 'mandate', role: 'surface', mandate: {} }],
    ['playerthree:scopes', { op: 'scopes', role: 'surface', scopes: [] }],
    ['playerthree:tell', { op: 'tell', roles: ['surface'], text: 'Observer authority probe; must never be delivered.' }],
  ]) await rpc(page, type, body);
  assert.equal(await page.locator('.hud, .chat-bar, .playerthree-console, .commander-pop').count(), 0, 'Observer must not construct player or coaching UI.');
  const types = await page.evaluate(() => window.__arenaAcceptanceWire.messages.map((message) => message.type));
  for (const type of ['playerthree:view', 'playerthree:obs', 'playerthree:report', 'playerthree:said', 'playerthree:seats', 'playerthree:cards']) assert(!types.includes(type), `Observer leaked ${type}`);
}
/** A zero-delay private observer sees both real armies with every battlefield cell revealed (not a union of fog). */
async function noFog(page) {
  await page.waitForFunction(() => !!window.__agentCommand?.game()?.worldView && window.__agentCommand.game().all?.sides.length === 2, undefined, { timeout: Math.min(40000, remaining()) });
  const all = await page.evaluate(() => {
    const g = window.__agentCommand.game();
    // Terrain is packed (10 cells/word); the battlefield's cell count is the match's own map size squared.
    return { entities: g.worldView.entities.map((entity) => ({ id: entity.id, side: entity.side, plane: entity.plane })), vision: Object.values(g.worldView.vision).map((bits) => [...bits]), cells: g.worldView.match.rules.map.size ** 2, sides: g.all.sides.map((side) => side.team), grant: g.opts.grant };
  });
  assert.equal(all.grant.kind, 'omniscient'); assert.equal(all.grant.delayMs, 0);
  assert.deepEqual(all.sides.sort(), ['blue', 'red']);
  assert(all.entities.some((entity) => entity.side === 'blue') && all.entities.some((entity) => entity.side === 'red'));
  assert(all.vision.every((words) => words.length === Math.ceil(all.cells / 30) && words.every((word, index) => word === 2 ** Math.min(30, all.cells - index * 30) - 1)), 'All must reveal every actual battlefield cell, not a union of player fog.');
  noSecrets(all);
  return all;
}
/** Per-seat occupant values exactly as the lobby UI renders them ("<team>:<role>" → you/open/bot/commander:<id>/closed). */
async function seatValues(page) {
  for (const side of ['blue', 'red']) await perPlane(page, side);
  return page.locator('.lobby-seat select[data-occupant]').evaluateAll((selects) => Object.fromEntries(selects.map((select) => [select.dataset.occupant, select.value])));
}
async function lobbyShot(page, name) {
  for (const side of ['blue', 'red']) await perPlane(page, side);
  await page.locator('.lobby-armies').scrollIntoViewIfNeeded();
  await screenshot(page, name);
}
function startAgentLoops() {
  for (const [index, session] of sessions.entries()) {
    agentJobs.push((async () => {
      while (!agentsStopped) {
        try {
          const briefing = await session.briefing();
          if (briefing.phase === 'match') {
            assert.equal(briefing.seat.role, 'surface');
            const observation = await session.observe();
            assert(['blue', 'red'].includes(observation.team), 'A real agent observation must identify exactly one current physical side.');
            assert.equal(observation.role, 'surface');
            assert(!Object.hasOwn(observation, 'world'), 'An agent received an observer projection.');
            if (observation.tick > 0 && observation.outcome === 'running') {
              // A transparent deterministic acceptance agent: rally at its own visible Spire.
              // No model, usage, provider, simulated winner or hidden cross-side state is claimed.
              const spire = observation.entities.find((entity) => entity.side === observation.team && entity.plane === 'surface' && entity.kind === 'spire');
              assert(spire, 'The guarded surface agent must see its own real Spire.');
              const acks = await session.act([{ kind: 'rally', x: spire.x, y: spire.y }]);
              if (acks.every((ack) => ack.ok)) {
                const key = `${index}:${observation.team}`;
                const record = agentEvidence.get(key) ?? { commander: index, team: observation.team, role: 'surface', accepted: 0, firstTick: observation.tick, lastTick: observation.tick };
                record.accepted += acks.length; record.lastTick = observation.tick; agentEvidence.set(key, record);
              } else assert(acks.every((ack) => !ack.ok && ack.code === 'game_over'), 'A live exact-seat acceptance agent was denied a normal in-scope command.');
            }
          }
        } catch (error) {
          // Binding release/start is a real phase boundary, not a transport retry or fake fallback.
          if (!agentsStopped && !['not_in_match', 'paused'].includes(error.code)) throw error;
        }
        if (!agentsStopped) await sleep(500);
      }
    })().catch((error) => { if (!agentsStopped) agentFailures.push({ commander: index, message: error.message, code: error.code }); }));
  }
}
async function publishShare(page, seriesId) {
  await page.getByRole('button', { name: 'Share / preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share result preview', exact: true });
  assert.equal(await dialog.getByLabel('Include consented agent commentary', { exact: true }).isChecked(), false);
  assert.equal(await dialog.getByRole('button', { name: 'Publish this preview', exact: true }).isDisabled(), true, 'Publishing requires an explicit public projection preview.');
  const previewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/arena/series/${seriesId}/share/preview`);
  await dialog.getByRole('button', { name: 'Preview public projection', exact: true }).click();
  const previewReply = await previewResponse; assert.equal(previewReply.status(), 200);
  const preview = await previewReply.json();
  assert.equal(preview.disclosure.audience, 'shared'); assert.equal(preview.disclosure.commentary, false); noSecrets(preview);
  const publishedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/arena/series/${seriesId}/share`);
  await dialog.getByRole('button', { name: 'Publish this preview', exact: true }).click();
  const publishedReply = await publishedResponse; assert.equal(publishedReply.status(), 201);
  const published = await publishedReply.json();
  const share = new URL(published.url, web); assert(/^\/arena\/share\/[A-Za-z0-9_-]{32}$/.test(share.pathname));
  return { preview, published, share, dialog };
}
async function revokedRoutes(share, revision) {
  for (const suffix of ['', '/data', '/events', `/export.json?revision=${revision}`, `/export.csv?revision=${revision}`, '/image.png']) {
    const response = await api(share.pathname + suffix, { status: 404 });
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  }
}
async function leave(page, address, authenticated) {
  // A finished match (natural end, cap or the other side's forfeit) releases its lobby on the next server sweep; the
  // product client treats that exact lobby_not_found as already left, so the check accepts only that release.
  const response = await fetch(new URL(`/api/lobbies/${address.code}/leave`, server), {
    method: 'POST', signal: AbortSignal.timeout(Math.min(20000, remaining())),
    headers: { authorization: authenticated ? `Bearer ${authenticated.secret}` : `Visitor ${address.visitorToken}`, 'content-type': 'application/json' }, body: '{}',
  });
  if (response.status !== 204) assert.deepEqual({ status: response.status, body: await response.json() }, { status: 404, body: { error: 'lobby_not_found' } }, `POST /api/lobbies/[code]/leave`);
  const cleanup = cleanups.find((item) => item.code === address.code && item.page === page);
  if (cleanup) cleanup.done = true;
  await home(page);
}
function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += char;
  }
  assert(!quoted, 'Unterminated CSV quote');
  assert.equal(field, '', 'CSV must terminate each record with CRLF');
  assert.equal(row.length, 0);
  return rows;
}
function csvValue(value) {
  if (value === null || value === undefined) return '\\N';
  if (typeof value !== 'string') return typeof value === 'object' ? canonical(value) : String(value);
  return value.startsWith('\\') ? `\\${value}` : /^[=+\-@\t\r\n']/.test(value) ? `'${value}` : value;
}
function unzip(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0, 'CSV export must be a complete ZIP archive.');
  const count = bytes.readUInt16LE(end + 10); let cursor = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength), offset = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    assert(method === 0 || method === 8, 'Unsupported ZIP compression');
    const value = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed));
    assert.equal(value.length, size, `Truncated ${name}`);
    assert(!files.has(name), `Duplicate ZIP member ${name}`);
    files.set(name, value.toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
async function download(page, label, filename) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const item = await waiting;
  assert.equal(await item.failure(), null, `${label} download failed`);
  const path = join(out, filename); await item.saveAs(path); return readFile(path);
}
/** A page summary is the same revision of the full envelope with each table bounded and its sampling declared. */
function assertSummaryOf(summary, full) {
  assert.equal(summary.format, 'playerthree.results.summary'); assert.equal(full.format, 'playerthree.results');
  for (const key of ['version', 'seriesId', 'revision', 'state', 'completedAt', 'comparisonHash', 'spec', 'completeness', 'disclosure']) assert.deepEqual(summary[key], full[key], `summary ${key} must match its full envelope revision`);
  for (const [table, rows] of Object.entries(full.tables)) {
    const sampled = summary.sampling.tables[table];
    assert.equal(sampled.rows, rows.length, `${table} summary must account for every full row`);
    assert.equal(summary.tables[table].length, sampled.included, `${table} summary included rows`);
    if (sampled.method === 'complete') assert.deepEqual(summary.tables[table], rows, `${table} complete summary rows`);
  }
}
function validateDataset(result, frozenRules, rulesHash) {
  assert.equal(result.format, 'playerthree.results'); assert.equal(result.version, 1); assert.equal(result.state, 'completed');
  assert.equal(result.tables.schedule.length, 2, 'One seed with both side permutations must schedule exactly two real games.');
  assert.equal(result.tables.matches.length, 2, 'No capped, retried or infrastructure substitute attempts may satisfy acceptance.');
  assert.equal(result.tables.entrants.length, 2);
  assert.equal(result.spec.template.rulesHash, rulesHash);
  assert.deepEqual(resolveRules(result.spec.template.options), frozenRules);
  assert.equal(digestRules(frozenRules), rulesHash);
  assert.equal(result.spec.template.rules.ranked, false);
  assert(result.spec.template.map.identity && result.spec.surfaceHash && result.comparisonHash, 'Frozen map, surface and comparison identities are required.');
  for (const scenario of result.spec.scenarios) assert.deepEqual(resolveRules(scenario.options), frozenRules);
  for (const match of result.tables.matches) {
    assert.equal(match.status, 'finished', 'Only natural simulation finishes count; a time/budget abort is not a completed game.');
    assert.equal(match.acceptedAttempt, true);
    assert(match.ticks > 0 && match.ticks <= 1200, 'Actual sim tick count must respect the 60s rules cap.');
    assert(match.outcomes.length === 2 && match.outcomes.every((row) => ['win', 'loss', 'draw'].includes(row.outcome)));
    assert.deepEqual(resolveRules(match.spec.options), frozenRules);
    assert.equal(match.spec.rulesHash, rulesHash);
    assert.equal(match.spec.surfaceHash, result.spec.surfaceHash);
    assert.equal(match.spec.map.identity, result.tables.schedule.find((trial) => trial.trialId === match.trialId).mapIdentity);
    assert(!/infrastructure|abort|maximum|max_ticks|budget/i.test(match.terminalReason), 'Infrastructure or execution-limit outcomes cannot replace real sim completion.');
    for (const team of ['blue', 'red']) {
      const surface = result.tables.seats.find((seat) => seat.matchId === match.matchId && seat.team === team && seat.role === 'surface');
      assert.equal(surface?.executionKind, 'agent', 'Both opposing named commanders must really execute in every series game.');
      assert.equal(surface.fallbackKind, null, 'A bot fallback cannot stand in for the real connected commander.');
      assert.equal(surface.entrantId, match.spec.bindings.find((binding) => binding.seat.team === team && binding.seat.role === 'surface').entrantId, 'Per-seat accounting must preserve the frozen logical entrant identity through side swaps.');
      assert(surface.submittedIntents > 0 && surface.acceptedIntents > 0, 'Each exact agent seat must record real accepted commands.');
      assert(result.tables.intents.some((row) => row.matchId === match.matchId && row.team === team && row.role === 'surface' && row.accepted > 0), 'Raw intent accounting must include both sides of every agent match.');
    }
  }
  assert.equal(result.tables.seats.length, 16, 'Two complete four-plane sides per game must be recorded.');
  assert(result.tables.metrics.length > 0 && result.tables.events.length > 0, 'Real sampled metrics and timeline must be present.');
  assert.equal(result.completeness.scheduleComplete, true);
  assert.equal(result.completeness.rawComplete, true);
  assert.deepEqual(result.completeness.missing, []);
  for (const [table, rows] of Object.entries(result.tables)) assert.equal(result.accounting.tables[table].rows, rows.length, `${table} JSON accounting`);
  for (const standing of result.tables.standings) {
    assert.equal(standing.games, 2);
    assert.equal(standing.wins + standing.losses + standing.draws, 2);
  }
  for (const trial of result.tables.schedule) {
    assert.equal(trial.rulesHash, rulesHash);
    assert.deepEqual(resolveRules(trial.resolvedOptions), frozenRules);
    assert.equal(trial.surfaceHash, result.spec.surfaceHash);
  }
  noSecrets(result);
}

await mkdir(out, { recursive: true });
try {
  await json('/healthz');
  // One browser process per participant: two contexts in one headless browser share a single GPU process, so one
  // participant's live WebGL frames would starve the other's shader warmup past the server's real handoff window.
  const launch = () => chromium.launch({
    headless: true, executablePath: process.env.CHROMIUM_PATH ?? join(homedir(), '.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'],
  }).then((browser) => { browsers.push(browser); return browser; });
  owner = await (await launch()).newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  guest = await (await launch()).newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  // Software-rendered WebGL (llvmpipe) on a shared machine: rAF-polled page waits can stall for tens of seconds.
  owner.setDefaultTimeout(60000); guest.setDefaultTimeout(60000);
  a = await owner.newPage(); b = await guest.newPage(); track(a, 'owner'); track(b, 'independent');

  await phaseStart('play-opens-setup-then-starts');
  await home(a);
  assert.equal(await a.evaluate(() => localStorage.getItem('agent-command.profile')), null, 'Fresh play must not require a profile.');
  const played = await create(a, 'play');
  await a.locator('.lobby-army[data-side="red"]').waitFor();
  const preset = await a.locator('.lobby-army').evaluateAll((armies) => armies.map((army) => ({ side: army.dataset.side, occupant: army.querySelector('.lobby-whole-army select[data-occupant]').value, botLevel: army.querySelector('.lobby-whole-army select[aria-label$="bot level"]')?.value })));
  assert.equal(preset.find((army) => army.side === 'blue').occupant, 'you');
  assert.deepEqual(preset.find((army) => army.side === 'red'), { side: 'red', occupant: 'bot', botLevel: 'standard' });
  assert.equal(await a.locator('.lobby-live-status').textContent(), 'waiting', 'Play must stop on setup, not start.');
  await screenshot(a, '01-play-setup');
  await action(a, 'start-lobby');
  const quick = await game(a, 'blue');
  assert.equal(quick.roles.length, 4, 'Start must hand off all four exact human seats.');
  assert.equal(await a.evaluate(() => localStorage.getItem('agent-command.profile')), null, 'Anonymous play cannot silently create a saved identity.');
  await screenshot(a, '02-play-real-game');
  await leave(a, played);
  check('Play opens setup; Start alone (no separate Ready) enters the real game', { roles: quick.roles });

  await phaseStart('named-commanders-real-runner-sessions');
  await action(a, 'commanders');
  await a.getByLabel('Commander name', { exact: true }).waitFor();
  const commanderNames = ['Acceptance Blue Surface', 'Acceptance Red Surface'];
  for (const name of commanderNames) {
    await a.getByLabel('Commander name', { exact: true }).fill(name);
    // The isolation flag sits in the add form's Advanced disclosure.
    await openDetails(a, '.named-commander-create > details');
    await a.getByLabel('Harness supports independent isolated sessions', { exact: false }).check();
    await a.getByRole('button', { name: 'Add commander', exact: false }).click();
    await a.locator('[data-commander-id]').filter({ hasText: name }).first().waitFor();
  }
  const alice = await profile(a);
  const roster = await json('/api/profile', { profile: alice });
  const commanders = commanderNames.map((name) => roster.commanders.find((entry) => entry.name === name));
  assert(commanders.every(Boolean)); assert.notEqual(commanders[0].id, commanders[1].id); assert.notEqual(commanders[0].token, commanders[1].token);
  for (const commander of commanders) {
    secrets.add(commander.id); secrets.add(commander.token);
    const session = await connectSeat({ url: `${server}/mcp`, token: commander.token, role: 'surface', clientName: 'arena-browser-acceptance' });
    sessions.push(session);
    const briefing = await session.briefing();
    assert.equal(briefing.phase, 'lobby');
  }
  await until(async () => {
    const response = await json('/api/profile', { profile: alice });
    return commanders.every((commander) => response.commanders.find((entry) => entry.id === commander.id)?.connected);
  }, 'both real named runner connections');
  await screenshot(a, '03-independent-named-commanders');
  check('Two distinct named commanders connect through real @playerthree/runner sessions');

  await phaseStart('open-human-join-rules-ready-handoff-recovery');
  await home(b);
  const humanLobby = await create(b, 'create');
  await b.locator('.lobby-army').first().waitFor();
  const bob = await profile(b);
  assert.notEqual(alice.id, bob.id); assert.notEqual(alice.secret, bob.secret, 'Browser contexts must not share identity.');
  // Commanders → Home → Lobby (the public list), whose header joins a private game by code.
  await action(a, 'home'); await action(a, 'lobby');
  await a.getByLabel('Join by code').fill(humanLobby.code);
  await a.locator('.lobby-join-form').getByRole('button', { name: 'Join', exact: true }).click(); await idle(a);
  await a.locator('.lobby-army[data-side="red"]').waitFor();
  await perPlane(a, 'red');
  assert.equal(await a.locator('[data-occupant="red:surface"]').inputValue(), 'you');
  await action(a, 'ready'); await action(b, 'ready');
  assert.equal((await a.locator('[data-lobby-action="ready"]').textContent()).trim(), 'Unready');
  await tab(b, 'rules'); await b.getByLabel('Rules preset', { exact: true }).selectOption('fast'); await idle(b);
  await until(async () => (await a.locator('[data-lobby-action="ready"]').textContent()).trim() === 'Ready', 'preset clears remote Ready');
  assert.equal((await b.locator('[data-lobby-action="ready"]').textContent()).trim(), 'Ready');
  assert((await a.getByLabel('Changes from Standard', { exact: true }).textContent()).includes('→'));
  await action(a, 'ready'); await action(b, 'ready');
  const beforeAdvanced = await b.locator('.lobby-rules-hash').textContent();
  await rule(b, 'spire.timeCap', 60);
  await until(async () => (await a.locator('[data-lobby-action="ready"]').textContent()).trim() === 'Ready', 'advanced rules clear remote Ready');
  assert.equal((await b.locator('[data-lobby-action="ready"]').textContent()).trim(), 'Ready');
  assert.notEqual(await b.locator('.lobby-rules-hash').textContent(), beforeAdvanced);
  await screenshot(b, '04-advanced-diff-clears-ready');
  await b.getByLabel('Rules preset', { exact: true }).selectOption('standard'); await idle(b);
  assert.equal(await b.locator('.rules-editor__diff li').count(), 0, 'Preset replacement must remove every hidden advanced override.');
  await rule(b, 'spire.timeCap', 60);
  await action(a, 'ready'); await action(b, 'ready');
  const tickets = [a.waitForResponse((response) => new URL(response.url()).pathname === `/api/lobbies/${humanLobby.code}/ticket`), b.waitForResponse((response) => new URL(response.url()).pathname === `/api/lobbies/${humanLobby.code}/ticket`)];
  await action(b, 'start-lobby');
  const [redTicketResponse, blueTicketResponse] = await Promise.all(tickets);
  const redTicket = await redTicketResponse.json(), blueTicket = await blueTicketResponse.json();
  for (const ticket of [...redTicket.tickets, ...blueTicket.tickets]) secrets.add(ticket.token);
  const [redGame, blueGame] = await Promise.all([game(a, 'red'), game(b, 'blue')]);
  assert.equal(redGame.roomId, blueGame.roomId);
  assert.deepEqual(redGame.roles, ['depths', 'orbit', 'sky', 'surface']);
  assert.deepEqual(blueGame.roles, redGame.roles);
  assert.equal(redGame.rules.spire.timeCap, 60);
  const renewal = a.waitForResponse((response) => new URL(response.url()).pathname === `/api/lobbies/${humanLobby.code}/ticket`);
  // Close the actual live socket. The app, not the check, must recover its exact-seat capabilities.
  await a.evaluate(() => window.__agentCommand.game().conn.room.connection.close());
  const replacement = await (await renewal).json();
  assert.equal(replacement.roomId, redTicket.roomId);
  assert.deepEqual(replacement.tickets.map((ticket) => ticket.role).sort(), redGame.roles);
  assert(replacement.tickets.every((ticket) => !redTicket.tickets.some((old) => old.token === ticket.token)));
  for (const ticket of replacement.tickets) secrets.add(ticket.token);
  await a.waitForFunction((tick) => window.__agentCommand?.game()?.view?.tick > tick && !window.__agentCommand.game().conn.recovering, redGame.tick);
  await assert.rejects(new Client(server).joinById(redTicket.roomId, { token: redTicket.tickets[0].token }), 'Recovered-away bearer must not replay.');
  await screenshot(a, '05-human-real-handoff-and-recovery');
  await leave(a, humanLobby, alice); await leave(b, humanLobby, bob);
  check('Independent human claims Open, rules clear both Ready states, exact-seat handoff/recovery rotates capabilities');

  await phaseStart('private-omniscient-observer-and-seat-isolation');
  const privateLobby = await createBotLineup(a);
  for (const [index, team] of ['blue', 'red'].entries()) {
    await perPlane(a, team);
    await dragCommander(a, commanders[index].id, `${team}:surface`);
  }
  await rule(a, 'spire.timeCap', 60);
  await action(a, 'start-lobby');
  const briefings = await until(async () => {
    const values = await Promise.all(sessions.map((session) => session.briefing()));
    return values.every((briefing) => briefing.phase === 'match') ? values : false;
  }, 'actual named commanders prepare held game', 40000);
  assert.deepEqual(briefings.map((briefing) => briefing.seat.team), ['blue', 'red']);
  assert(briefings.every((briefing) => briefing.seat.role === 'surface'));
  // Match data is the paged `match-data` topic: one `key: JSON` line per top-level key (a large object as `key.sub`).
  for (const session of sessions) {
    let text = '';
    for (let page = 1; page; ) {
      const topic = await session.briefing('match-data', page);
      text += `${topic.text}\n`;
      page = topic.next?.page;
    }
    const rules = text.match(/^rules: (.*)$/m);
    const spire = rules ? JSON.parse(rules[1]).spire : JSON.parse(text.match(/^rules\.spire: (.*)$/m)[1]);
    assert.equal(spire.timeCap, 60);
  }
  await a.getByLabel('Read-only observer', { exact: true }).waitFor();
  await watchWire(a);
  await noFog(a);
  const observerToken = await a.evaluate(() => window.__agentCommand.game().opts.token);
  secrets.add(observerToken);
  await assert.rejects(connectSeat({ url: `${server}/mcp`, token: observerToken, role: 'surface' }), (error) => error.code === 'bad_token', 'Observer capability cannot authenticate an agent session.');
  await api(`/api/lobbies/${privateLobby.code}/ticket`, { profile: { secret: observerToken }, body: {}, status: 401 });
  const observations = await Promise.all(sessions.map((session) => session.observe()));
  assert.deepEqual(observations.map((observation) => observation.team), ['blue', 'red']);
  for (const [index, observation] of observations.entries()) {
    assert(!observation.entities.some((entity) => entity.side === (index === 0 ? 'red' : 'blue') && entity.kind === 'spire'), 'An agent cannot receive the unseen opposing Spire from the observer projection.');
    // Maps are generated per match, so a fixed point can be blocked terrain; rally on the agent's own visible Spire.
    const spire = observation.entities.find((entity) => entity.side === observation.team && entity.plane === 'surface' && entity.kind === 'spire');
    assert(spire, 'The guarded surface agent must see its own real Spire.');
    const acted = await sessions[index].act([{ kind: 'rally', x: spire.x, y: spire.y }]);
    assert.deepEqual(acted, [{ ok: true }], 'Real isolated commander must command its own exact lane.');
    const wrongRole = await sessions[index].call('game_observe', { role: 'orbit' });
    assert.equal(wrongRole.isError, true); assert.equal(JSON.parse(wrongRole.text).error, 'forbidden');
  }
  await a.getByLabel('Vision: blue', { exact: true }).click();
  await a.waitForFunction(() => window.__agentCommand?.game()?.worldView?.team === 'blue');
  assert(await a.evaluate(() => Object.values(window.__agentCommand.game().worldView.vision).some((bits) => [...bits].some((bit) => bit === 0))), 'Selecting a side must show that side\'s real fog, not just move the camera.');
  await a.getByLabel('Vision: All', { exact: true }).click();
  await a.waitForFunction(() => window.__agentCommand?.game()?.all?.sides.length === 2 && window.__agentCommand.game().vision === 'all');
  assert.equal(await a.locator('.obs-side').count(), 2);
  await a.getByLabel('Army', { exact: true }).click();
  await a.getByLabel('Side colours: standard / colour-blind safe', { exact: true }).click();
  assert.equal(await a.getByLabel('Vision: All', { exact: true }).getAttribute('aria-checked'), 'true', 'Tabs and palette must not change vision authority.');
  await observerNegatives(a);
  await rendered(a);
  await screenshot(a, '06-private-real-no-fog-observer');
  await leave(a, privateLobby, alice);
  check('Private observer receives both real armies without fog; separate runner sessions remain side-guarded; observer act/coaching/control denied');

  await phaseStart('play-lobby-own-commanders-opposed-leveled-bots-observer-no-fog');
  // One ordinary (play) lobby: the organizer's own two isolated commanders oppose each other beside leveled bots, the
  // organizer moves to Observers, starts, and watches the live match with no fog. Lobby states are captured on the way.
  const ownLobby = await create(a, 'create');
  await a.locator('.lobby-army[data-side="red"]').waitFor();
  await a.locator('.lobby-army[data-side="blue"] .lobby-whole-army select[data-occupant]').selectOption('open'); await idle(a);
  const roles = ['orbit', 'sky', 'surface', 'depths'];
  const seatsOf = (assign) => Object.fromEntries(['blue', 'red'].flatMap((team) => roles.map((role) => [`${team}:${role}`, assign(team, role)])));
  await until(async () => canonical(await seatValues(a)) === canonical(seatsOf(() => 'open')), 'every seat Open');
  await lobbyShot(a, 'lobby-1-empty');
  await a.locator('[data-occupant="blue:surface"]').selectOption(`commander:${commanders[0].id}`); await idle(a);
  await until(async () => canonical(await seatValues(a)) === canonical(seatsOf((team, role) => team === 'blue' && role === 'surface' ? `commander:${commanders[0].id}` : 'open')), 'one named commander claimed');
  await lobbyShot(a, 'lobby-2-partly-claimed');
  const levels = { blue: 'novice', red: 'veteran' };
  await perPlane(a, 'blue');
  for (const role of ['orbit', 'sky', 'depths']) {
    await a.locator(`[data-occupant="blue:${role}"]`).selectOption('bot'); await idle(a);
    await a.locator(`[data-seat="blue:${role}"] select[aria-label$="bot level"]`).selectOption(levels.blue); await idle(a);
  }
  await seatMode(a, 'red', 'all');
  await a.locator('.lobby-army[data-side="red"] .lobby-whole-army select[data-occupant]').selectOption('bot'); await idle(a);
  await a.locator('.lobby-army[data-side="red"] .lobby-whole-army select[aria-label$="bot level"]').selectOption(levels.red); await idle(a);
  await perPlane(a, 'red');
  const botLevels = () => a.locator('.lobby-seat[data-seat] select[aria-label$="bot level"]').evaluateAll((selects) => Object.fromEntries(selects.map((select) => [select.closest('[data-seat]').dataset.seat, select.value])));
  await until(async () => canonical(await botLevels()) === canonical({ 'blue:orbit': 'novice', 'blue:sky': 'novice', 'blue:depths': 'novice', 'red:orbit': 'veteran', 'red:sky': 'veteran', 'red:surface': 'veteran', 'red:depths': 'veteran' }), 'leveled bots on every other seat');
  await lobbyShot(a, 'lobby-3-configured-bots-vs-my-agent');
  await a.locator('[data-occupant="red:surface"]').selectOption(`commander:${commanders[1].id}`); await idle(a);
  await until(async () => canonical(await seatValues(a)) === canonical(seatsOf((team, role) => role === 'surface' ? `commander:${commanders[team === 'blue' ? 0 : 1].id}` : 'bot')), 'own commanders opposed, bots elsewhere');
  await action(a, 'move-observer');
  await until(async () => await a.locator('[data-lobby-action="ready"]').count() === 0, 'organizer seated in Observers (no Ready control)');
  await lobbyShot(a, 'lobby-4-own-commanders-opposed-organizer-observing');
  await action(a, 'start-lobby');
  const ownBriefings = await until(async () => {
    const values = await Promise.all(sessions.map((session) => session.briefing()));
    return values.every((briefing) => briefing.phase === 'match') ? values : false;
  }, 'own opposed commanders prepare held play match', 40000);
  assert.deepEqual(ownBriefings.map((briefing) => [briefing.seat.team, briefing.seat.role]), [['blue', 'surface'], ['red', 'surface']]);
  await a.getByLabel('Read-only observer', { exact: true }).waitFor({ timeout: Math.min(40000, remaining()) });
  await watchWire(a);
  await noFog(a);
  for (const [index, session] of sessions.entries()) {
    const observation = await session.observe();
    assert.equal(observation.team, index === 0 ? 'blue' : 'red', 'Each own commander keeps its own isolated side.');
    assert(!Object.hasOwn(observation, 'world'), 'An agent received an observer projection.');
    assert.deepEqual(await session.act([{ kind: 'rally', x: 20, y: 20 }]), [{ ok: true }]);
  }
  await observerNegatives(a);
  await rendered(a);
  await screenshot(a, '07-play-lobby-own-commanders-no-fog');
  await leave(a, ownLobby, alice);
  check('Play lobby: own commanders on opposing sides beside novice/veteran bots, organizer in Observers watches with no fog', { levels });

  await phaseStart('public-observer-real-wall-clock-delay');
  const publicLobby = await createBotLineup(a);
  await tab(a, 'match'); await a.locator('[aria-label="Visibility"] [data-visibility="public"]').click(); await idle(a);
  await rule(a, 'spire.timeCap', 60);
  await action(b, 'lobby');
  await b.locator(`[data-lobby-action="observe-${publicLobby.code}"]`).waitFor();
  await b.locator(`[data-lobby-action="observe-${publicLobby.code}"]`).click(); await idle(b);
  await action(a, 'start-lobby');
  await b.getByLabel('Read-only observer', { exact: true }).waitFor();
  await watchWire(b);
  const publicStarted = Date.now();
  const publicGrant = await b.evaluate(() => window.__agentCommand.game().opts.grant);
  assert.equal(publicGrant.kind, 'omniscient'); assert(publicGrant.delayMs >= 180000);
  assert((await b.locator('.obs-status').textContent()).includes('Delayed 180 s'));
  assert((await b.locator('.obs-status').textContent()).includes('Buffering'));
  assert.equal(await b.evaluate(() => window.__agentCommand.game().boards.size), 0);
  assert.equal(await b.evaluate(() => window.__agentCommand.game().worldView), undefined, 'No live bootstrap before released authority.');
  await observerNegatives(b);
  // Forged cursor/clock/vision switches cannot request a live bootstrap or learn completion.
  await b.evaluate(() => {
    const room = window.__agentCommand.game().streams.get('all').conn.room;
    room.send('playerthree:observer', { perspective: 'all', after: Number.MAX_SAFE_INTEGER });
    room.send('playerthree:observer', { perspective: 'all', noFog: true, delayMs: 0 });
    room.send('playerthree:observer', { perspective: 'all' });
  });
  await screenshot(b, '07-public-delayed-buffering-no-live-bootstrap');
  let bufferedChecks = 0;
  while (true) {
    // One page task: a frame released between two separate reads must not look like a world without its frame.
    const wire = await b.evaluate(() => ({ messages: window.__arenaAcceptanceWire.messages, frames: window.__arenaAcceptanceWire.frames, world: window.__agentCommand.game().worldView !== undefined, sides: window.__agentCommand.game().boards.size }));
    for (const message of wire.messages) assert(!['playerthree:view', 'playerthree:obs', 'playerthree:report', 'playerthree:said', 'playerthree:seats', 'playerthree:cards'].includes(message.type), `Public observer leaked correlated live ${message.type}`);
    for (const message of wire.messages.filter((message) => message.type === 'playerthree:observer' && !message.hasFrame)) {
      assert.deepEqual(message.keys, ['grant', 'op', 'state'], 'A buffering observer message may disclose admission metadata only, not tick, outcome or world.');
      assert(['buffering', 'closed'].includes(message.state), 'A rejected forged cursor may not contain live state.');
    }
    if (wire.frames.length) {
      for (const frame of wire.frames) {
        assert(frame.releaseAt - frame.recordedAt >= 180000, 'Public delay must be actual wall time, not accelerated sim ticks.');
        assert(frame.at >= frame.releaseAt, 'A public world/outcome escaped before its release watermark.');
      }
      report.publicDelay = { bufferedChecks, waitedMs: Date.now() - publicStarted, firstReleasedFrame: wire.frames[0] };
      break;
    }
    assert.equal(wire.world, false, 'A live world bypassed delayed transport.');
    assert.equal(wire.sides, 0);
    bufferedChecks++;
    assert(Date.now() - publicStarted < 205000 && remaining() > 1000, 'Public observer failed closed or never released a real frame after its delay.');
    await sleep(1000);
  }
  await b.waitForFunction(() => window.__agentCommand.game().boards.size === 2);
  await rendered(b);
  await screenshot(b, '08-public-real-released-world');
  await leave(b, publicLobby, bob); await leave(a, publicLobby, alice);
  check('Public observer withholds every correlated channel, then releases real world only after ≥180 seconds wall time', { bufferedChecks });

  await phaseStart('real-series-incremental-standings-and-exports');
  const seriesLobby = await createBotLineup(a);
  for (const [index, team] of ['blue', 'red'].entries()) {
    await perPlane(a, team);
    await dragCommander(a, commanders[index].id, `${team}:surface`);
  }
  await tab(a, 'rules'); await a.getByLabel('Rules preset', { exact: true }).selectOption('no-asteroids'); await idle(a);
  await rule(a, 'spire.timeCap', 60);
  const hashText = await a.locator('.lobby-rules-hash').textContent();
  const rulesHash = hashText.match(/sha256:[a-f0-9]{64}/)?.[0]; assert(rulesHash, 'Lobby must disclose canonical rules SHA-256.');
  const frozenRules = await a.locator('[data-rule-path]').evaluateAll((controls) => Object.fromEntries(controls.filter((control) => control.dataset.rulePath !== 'preset').map((control) => [control.dataset.rulePath, control.type === 'checkbox' ? control.checked : control.value])));
  // A series is Create Game's Series tab: Single game → Series once every seat is a bot or commander.
  await tab(a, 'series'); await a.locator('[data-series-mode="series"]').click();
  await a.getByLabel('Series seed list', { exact: true }).fill('7301');
  for (const [label, value] of [['Speed ×', '1'], ['Concurrency', '1'], ['Max ticks', '1300'], ['Retries', '0']]) {
    await a.getByLabel(label, { exact: true }).fill(value); await a.getByLabel(label, { exact: true }).press('Tab');
  }
  const acceptedSnapshots = [];
  const responses = new Set();
  const receiveResult = (response) => {
    if (!/^\/api\/arena\/series\/[^/]+$/.test(new URL(response.url()).pathname) || response.request().method() !== 'GET' || response.status() !== 200) return;
    const pending = response.json().then((result) => {
      if (result.format === 'playerthree.results.summary') acceptedSnapshots.push(result);
    }).catch(() => { report.consoleErrors.push({ context: 'owner', message: 'Invalid JSON from the real owner results endpoint.' }); });
    responses.add(pending); pending.then(() => responses.delete(pending));
  };
  a.on('response', receiveResult);
  startAgentLoops();
  const seriesResponse = a.waitForResponse((response) => new URL(response.url()).pathname === `/api/lobbies/${seriesLobby.code}/series`);
  await a.getByRole('button', { name: 'Start series', exact: true }).click();
  const started = await seriesResponse; assert.equal(started.status(), 201);
  currentSeries = (await started.json()).seriesId; assert(currentSeries);
  await a.getByRole('main', { name: 'Benchmark results', exact: true }).waitFor();
  // Revoke a genuinely RUNNING result stream, not an already-terminal SSE response.
  const runningShare = await publishShare(a, currentSeries);
  await runningShare.dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  await guest.clearCookies();
  await b.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await b.goto(`${web}${runningShare.share.pathname}`, { waitUntil: 'domcontentloaded' });
  await b.getByRole('main', { name: 'Benchmark results', exact: true }).waitFor();
  await until(async () => (await b.locator('.arena-results-header [role="status"]').textContent()).includes('Public read-only'), 'live unauthenticated shared results UI');
  const running = await json(`/api/arena/series/${currentSeries}`, { profile: alice });
  assert.equal(running.state, 'running', 'Active revocation must happen while the actual series is still running.');
  const activeStreamAbort = new AbortController();
  liveStreams.add(activeStreamAbort);
  const activeStream = await api(`${runningShare.share.pathname}/events`, { signal: activeStreamAbort.signal });
  assert.match(activeStream.headers.get('content-type') ?? '', /text\/event-stream/);
  const activeReader = activeStream.body.getReader();
  let activeEnded = false, activeReadError;
  const activeClosed = (async () => {
    try { while (!(await activeReader.read()).done) {} }
    catch (error) { activeReadError = error; }
    finally { activeEnded = true; }
  })();
  await sleep(100);
  assert.equal(activeEnded, false, 'A running result SSE stream must really be open before revocation.');
  const liveRevoke = a.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/share/revoke'));
  await a.getByRole('button', { name: 'Revoke all share links', exact: true }).click();
  assert.equal((await liveRevoke).status(), 204);
  assert.equal(await Promise.race([activeClosed.then(() => true), sleep(10000).then(() => false)]), true, 'Revocation must close an actual active public stream even without another allowed update.');
  assert.equal(activeReadError, undefined, 'Revoked SSE must finish cleanly, not expose a server stream error.');
  activeStreamAbort.abort(); liveStreams.delete(activeStreamAbort);
  await revokedRoutes(runningShare.share, runningShare.preview.revision);
  await screenshot(b, '09-live-share-revoked');
  check('Revoking a running series share closes its actual active SSE and disables all public projections');
  const uiCommits = [];
  for (let finished = 1; finished <= 2; finished++) {
    const snapshot = await until(() => {
      assert.deepEqual(agentFailures, [], 'Persistent real runner session failed.');
      return acceptedSnapshots.find((result) => result.tables.matches.filter((match) => match.acceptedAttempt).length === finished);
    }, `UI receives committed result after EACH finish (${finished}/2)`, 100000);
    await a.waitForFunction(({ finished, revision }) => {
      const status = document.querySelector('.arena-results-header [role="status"]')?.textContent ?? '';
      const standings = [...document.querySelectorAll('.arena-panel')].find((panel) => panel.querySelector('h2')?.textContent === 'Standings');
      const rows = [...(standings?.querySelectorAll('tbody tr') ?? [])];
      return Number(status.match(/revision (\d+)/)?.[1]) >= revision && status.includes(`${finished}/2 games`) && rows.length === 2 && rows.every((row) => row.cells[4].textContent === String(finished));
    }, { finished, revision: snapshot.revision });
    assert(snapshot.tables.standings.every((standing) => standing.games === finished), 'Standings cannot wait until the final series commit.');
    uiCommits.push({ finished, revision: snapshot.revision, state: snapshot.state });
    await screenshot(a, `09-series-live-${finished}-finished`);
  }
  const result = await until(async () => {
    const result = await json(`/api/arena/series/${currentSeries}`, { profile: alice });
    return result.state === 'completed' ? result : false;
  }, 'natural completed series', 20000);
  await Promise.all(responses); a.off('response', receiveResult);
  assert.deepEqual(agentFailures, []);
  assert.equal(result.spec.track, 'live');
  assert.deepEqual(result.spec.entrants.map((entrant) => entrant.label).sort(), [...commanderNames].sort(), 'The frozen series identities must name the two real selected commanders.');
  assert(result.spec.entrants.every((entrant) => entrant.kind === 'agent' && entrant.aiPlayer));
  assert.deepEqual(result.tables.entrants.map((entrant) => entrant.label).sort(), [...commanderNames].sort());
  for (const entrant of result.spec.entrants) {
    const teams = result.tables.matches.map((match) => match.spec.bindings.find((binding) => binding.entrantId === entrant.id && binding.seat.role === 'surface')?.seat.team).sort();
    assert.deepEqual(teams, ['blue', 'red'], 'Both named entrants must execute each physical side exactly once.');
  }
  for (const index of [0, 1]) for (const team of ['blue', 'red']) {
    assert(agentEvidence.get(`${index}:${team}`)?.accepted > 0, 'Each persistent isolated agent session must follow both paired side bindings and submit real accepted commands.');
  }
  report.agentExecutions = [...agentEvidence.values()];
  const resolved = resolveRules(result.spec.template.options);
  assert.equal(resolved.spire.timeCap, 60); assert.equal(resolved.orbit.maxAsteroids, 0);
  for (const [path, displayed] of Object.entries(frozenRules)) {
    const actual = path.split('.').reduce((value, key) => value[key], resolved);
    assert.equal(String(actual), String(displayed), `Export differs from the exact pre-Ready UI rule ${path}`);
  }
  // Live owner/share pages read the bounded `playerthree.results.summary` (design §7.4); Download JSON/CSV stream the full
  // canonical envelope, so the raw dataset is validated on the download and the page summary is checked against it.
  const downloaded = JSON.parse((await download(a, 'Download JSON', 'results-owner.json')).toString('utf8'));
  validateDataset(downloaded, resolved, rulesHash);
  assertSummaryOf(result, downloaded);
  const zipBytes = await download(a, 'CSV tables ZIP', 'results-owner.zip');
  const files = unzip(zipBytes), schema = JSON.parse(files.get('schema.json')), csvSpec = JSON.parse(files.get('spec.json')), manifest = JSON.parse(files.get('manifest.json'));
  assert.deepEqual(csvSpec, downloaded.spec);
  assert.equal(manifest.digest.canonicalJson, sha256(canonical(downloaded)));
  assert.equal(manifest.revision, downloaded.revision);
  assert.deepEqual([...files.keys()].sort(), [...Object.keys(downloaded.tables).map((table) => `${table}.csv`), 'schema.json', 'spec.json', 'manifest.json'].sort());
  const tableCounts = {};
  for (const [table, expected] of Object.entries(downloaded.tables)) {
    const csv = parseCsv(files.get(`${table}.csv`));
    assert.deepEqual(csv[0], schema.tables[table].columns);
    assert.equal(csv.length - 1, expected.length, `${table} CSV vs JSON table rows`);
    for (const row of csv.slice(1)) assert.equal(row.length, csv[0].length);
    for (const [index, row] of csv.slice(1).entries()) {
      assert.deepEqual(row, csv[0].map((column) => csvValue(expected[index][column])), `${table} CSV must preserve every JSON value and its schema escaping.`);
    }
    tableCounts[table] = expected.length;
    if (table === 'schedule') for (const row of csv.slice(1)) {
      const item = Object.fromEntries(csv[0].map((column, index) => [column, row[index]]));
      assert.equal(item.rulesHash, rulesHash); assert.equal(item.surfaceHash, result.spec.surfaceHash);
      assert.deepEqual(resolveRules(JSON.parse(item.resolvedOptions)), resolved);
    }
  }
  noSecrets([...files.values()].join('\n'));
  report.series = { id: currentSeries, rulesHash, mapIdentity: result.spec.template.map.identity, surfaceHash: result.spec.surfaceHash, revision: result.revision, uiCommits, tableCounts };
  check('Two real natural finishes each advance live UI standings; versioned JSON and every CSV table preserve exact specs/rules/counts', { uiCommits, tableCounts });

  await phaseStart('opt-in-public-share-ssr-og-png-and-revoke');
  const { preview, share, dialog } = await publishShare(a, currentSeries);
  await screenshot(a, '10-opt-in-share-preview');
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  await guest.clearCookies();
  await b.goto(`${web}/?renderer=webgl&debug`);
  await b.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  assert.equal(await b.evaluate(() => localStorage.getItem('agent-command.profile')), null);
  const ssr = await api(share.pathname);
  assert.match(ssr.headers.get('content-type') ?? '', /text\/html/);
  assert.match(ssr.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(ssr.headers.get('referrer-policy'), 'no-referrer');
  const html = await ssr.text(); noSecrets(html);
  assert.match(html, /<h1[\s>]/, 'Unauthenticated SSR must contain a real result heading.');
  for (const entrant of result.tables.entrants) assert(html.includes(entrant.label), 'SSR must contain the actual public entrants.');
  assert.match(html, /<table[\s>]/, 'Unauthenticated SSR must contain standings, not just an empty SPA shell.');
  assert.match(html, /property=["']og:title["']/);
  const imageMatch = html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i) ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  assert(imageMatch, 'SSR must expose a real Open Graph image.');
  const imageUrl = new URL(imageMatch[1].replaceAll('&amp;', '&'), server);
  assert.equal(imageUrl.pathname, `${share.pathname}/image.png`);
  assert.equal(imageUrl.search, '', 'OG image may not smuggle an owner credential into its URL.');
  const imageResponse = await api(imageUrl.pathname);
  assert.match(imageResponse.headers.get('content-type') ?? '', /image\/png/);
  assert.match(imageResponse.headers.get('cache-control') ?? '', /no-store/);
  const png = Buffer.from(await imageResponse.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert(png.readUInt32BE(16) >= 600 && png.readUInt32BE(20) >= 300, 'OG must be an actual rendered social PNG.');
  await writeFile(join(out, 'share-ssr.html'), html); await writeFile(join(out, 'share-og.png'), png);
  const shared = await json(`${share.pathname}/data`);
  assert.equal(shared.disclosure.audience, 'shared'); assert.equal(shared.disclosure.commentary, false); noSecrets(shared);
  assert.deepEqual(shared.tables, preview.tables);
  assert.deepEqual(shared.spec, result.spec);
  const publicAuthorization = [];
  b.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith(share.pathname) && request.headers().authorization) publicAuthorization.push(request.method());
  });
  await b.goto(`${web}${share.pathname}`, { waitUntil: 'domcontentloaded' });
  await b.getByRole('main', { name: 'Benchmark results', exact: true }).waitFor();
  await until(async () => (await b.locator('.arena-results-header [role="status"]').textContent()).includes('Public read-only'), 'unauthenticated public results UI');
  assert.equal(await b.getByRole('button', { name: 'Share / preview', exact: true }).count(), 0);
  const publicJson = JSON.parse((await download(b, 'Download JSON', 'results-shared.json')).toString('utf8'));
  noSecrets(publicJson); assert.equal(publicJson.disclosure.audience, 'shared');
  assertSummaryOf(shared, publicJson);
  const publicCsv = unzip(await download(b, 'CSV tables ZIP', 'results-shared.zip'));
  assert.deepEqual(JSON.parse(publicCsv.get('spec.json')), publicJson.spec);
  for (const [table, rows] of Object.entries(publicJson.tables)) assert.equal(parseCsv(publicCsv.get(`${table}.csv`)).length - 1, rows.length);
  assert.deepEqual(publicAuthorization, [], 'The second context must use only its public share capability, never owner authorization.');
  await api(`/api/arena/series/${currentSeries}`, { status: 401 });
  await api(`/api/arena/series/${currentSeries}`, { profile: bob, status: 404 });
  await api(`${share.pathname}/start`, { body: {}, status: 405 });
  await screenshot(b, '11-unauthenticated-real-public-results');
  const revokeResponse = a.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/share/revoke'));
  await a.getByRole('button', { name: 'Revoke all share links', exact: true }).click();
  assert.equal((await revokeResponse).status(), 204);
  await revokedRoutes(share, shared.revision);
  await b.reload({ waitUntil: 'domcontentloaded' });
  const revokedHtml = await b.content();
  assert(!revokedHtml.includes('Public read-only · server-released results'), 'Revoked page cannot retain an authorized dataset after reload.');
  await screenshot(b, '12-share-revoked');
  check('Share requires opt-in preview; independent unauthenticated context receives safe SSR/OG/PNG/exports; revoke disables page, data, events, exports and image');
  assert.deepEqual(report.removedApiRequests, [], 'No entry point may call removed /api/match creation/ready/start APIs.');
  assert.deepEqual(report.consoleErrors, [], 'Real browser pages must not throw uncaught errors.');
} catch (error) {
  failure = error;
  report.failure = { phase, message: error.message, stack: error.stack };
  if (a && !a.isClosed()) await screenshot(a, 'failure-owner').catch(() => {});
  if (b && !b.isClosed()) await screenshot(b, 'failure-independent').catch(() => {});
} finally {
  agentsStopped = true;
  for (const stream of liveStreams) stream.abort();
  await Promise.allSettled(sessions.map((session) => session.close()));
  await Promise.allSettled(agentJobs);
  for (const cleanup of cleanups.filter((item) => !item.done)) {
    try {
      const identity = cleanup.visitor ? undefined : await profile(cleanup.page);
      await api(`/api/lobbies/${cleanup.code}/leave`, { profile: identity, visitor: cleanup.visitor, body: {}, status: 204 });
    } catch { /* An already-retired lobby has no cleanup capability left. Never create a replacement. */ }
  }
  await Promise.allSettled(browsers.map((browser) => browser.close()));
  report.finishedAt = new Date().toISOString();
  // Failure messages can contain SDK diagnostics; keep private capabilities out of the artifact too.
  let serialized = JSON.stringify(report, null, 2);
  for (const secret of secrets) serialized = serialized.replaceAll(secret, '[private]');
  await writeFile(join(out, 'arena-acceptance.json'), serialized + '\n');
}
if (failure) throw failure;
console.log(`Arena acceptance passed: ${report.checks.length} end-to-end checks. Screenshots, JSON/CSV, SSR and PNG evidence: ${out}`);
