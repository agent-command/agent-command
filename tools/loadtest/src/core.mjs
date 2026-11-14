/**
 * Shared core of the public-protocol load runner (main.mjs, target.mjs): CLI options and HELP, lobby create/start
 * over the public HTTP API, histograms and pass/fail classification. Never retries an ambiguous lobby POST and never
 * prints lobby codes or credentials.
 */
import { parseArgs } from 'node:util';

export const HELP = `Public-protocol Agent Command load runner (Node >=24, no browser).

  pnpm --filter @agent-command/loadtest start -- --url http://localhost:2567 --matches 4 --spectators 12
  pnpm --filter @agent-command/loadtest start -- --url https://example.test --levels 1,2,4,8 --duration 120 --ramp 20
  pnpm --filter @agent-command/loadtest start -- --url http://localhost:2567 --matches 4 --home-rps 10 --static-rps 30 --static-path /assets/index-HASH.js
  pnpm --filter @agent-command/loadtest start -- --target https://YOUR-HOST --levels 1,2,4 --dwell 30
  pnpm --filter @agent-command/loadtest start -- --url http://localhost:2567 --players --levels 4 --duration 60 --measurement-only

Options (seconds unless named otherwise):
  --url URL                  HTTP server origin/base path (default http://localhost:2567)
  --target URL               Opt-in live public-server ramp; never starts/deploys a server
  --dwell S                  Target-mode stable hold per level (default 30)
  --max-wall S               Target-mode workload deadline (default/maximum 600)
  --max-matches N            Target-mode total creation budget (default/maximum 64)
  --ws-url URL               Colyseus endpoint, e.g. http://localhost:5173/colyseus
  --matches N                Matches to finish (default 1); all run concurrently by default
  --concurrency N            Concurrent match slots, at most --matches
  --spectators M             Extra observer sockets TOTAL, divided across concurrent slots (at most 15 per match)
  --players                  Each match's creator plays instead of observing: a 'play' lobby (the creator's
                             side human, the other side bots) entered with the creator's exact-seat tickets,
                             the first seat receiving the team's view stream; reports view bytes/s per player.
                             The idle human side loses eventually; combine with --duration/--measurement-only.
  --featured-viewers M       Public /api/featured/stream SSE viewers (default 0, maximum 10000)
  --levels N,N,...           Ascending concurrency sweep; replenish each level during --duration
  --duration S              Replenishment/measurement hold per level; default 60 for sweeps,
                             0 otherwise (finish exactly --matches). Then naturally drain matches.
  --ramp S                   Stagger slot starts across S seconds (default 0)
  --measurement-only         Close sockets at hold end instead of waiting for outcomes;
                             requires positive --duration and at most one --levels value
  --queue-timeout S          Admission deadline including 429/409 waits (default 900)
  --match-timeout S          Completion deadline AFTER admission (default 3600)
  --request-timeout S        Per HTTP/join deadline (default 15)
  --sample-interval S        /api/capacity sampling interval (default 2)
  --lag-budget-ms N          Maximum exposed ticks.p99LagMs (default 50, one 20Hz period)
  --min-hz N                 Minimum observed simulation p05 Hz (default 19)
  --home-rps N               GET / target requests/sec (default 0)
  --static-rps N             Static target requests/sec, round-robin paths (default 0)
  --static-path PATH         Repeat for each real asset; required with --static-rps
  --flood-concurrency N      Maximum simultaneous flood requests (default 16)
  --fixture duel|ffa         Lobby preset: duel = open/duel (default); ffa = four_corners/ffa, four
                             bot armies per match (admission counts each as ~2.4 duels)
  --map ID                   Lobby map id (overrides the fixture's)
  --layout ID                Lobby layout id (overrides the fixture's)
  --headers                  Summarize/check response headers for existing requests (max 50 URLs)
  --help                     Print this usage

Only the public lobby flow and joinById({token}) are used: each match is a private,
anonymously created all-bot 'benchmark' lobby with autoStart, attached over its pregame
socket and entered with the creator's omniscient observer ticket. No dev APIs, cheats,
seed/rules/speed overrides or fabricated X-Forwarded-For. Run against a default-speed
server; configure server IP limits for your intended load source or expect rate-limit/queue
pressure, which is reported, never bypassed. Each match has its creator's observer plus its
allocated extra observers; each extra observer creates an anonymous profile and joins the
lobby as an observer (lobbies hold 16 members; profile creation is IP-limited as well).
Observers watch all teams. Default matches run to an observed outcome;
duration/sweep runs replenish slots, stop creating, then wait for natural outcomes.
Featured SSE viewers follow --ramp, count streamed bytes without retaining snapshots,
and measure the first complete data frame (not flushed headers/comments). They close
at stage end; requested featured viewers must all receive a frame for saturation.
Deadlines/signals leave each unfinished match's lobby, which ends its game (the creator
leaving its own lobby is the public termination path); lobbies still waiting for
admission are left the same way. 429 and 409 capacity (every lobby slot taken) are waited out.
Do not run overlapping stages/other loads when determining a capacity ceiling.
--measurement-only is opt-in for a dedicated server that will be restarted after
the run. It intentionally truncates active matches and cancels pending admissions
at ramp+duration; those are reported separately, not counted as completion/failure.
In-flight admission may have already created a game. Never reuse that server for
another level without restarting it; multiple --levels values are rejected.

stdout is NDJSON: config, capacity (raw endpoint body), stage, summary, error.
Redirect stdout to a .jsonl file; diagnostics/usage go to stderr. No tokens emitted.
With --headers, each stage includes bounded per-URL Cache-Control, Content-Encoding,
Vary and Content-Type variants/checks; lobby codes in URLs are redacted. No extra
requests or per-request events are generated. Use --home-rps/--static-rps to observe
HTML/assets. Hashed assets require public,max-age>=31536000,immutable; HTML requires
no-cache; API requires no-store. Compressed/negotiated static types must vary on
Accept-Encoding. Header policy failures fail the stage independently of tick data.
Histograms use logarithmic bins (5% width in value+1); pXX values are upper bounds.
Hz admission uses the conservative p05 lower bound instead. CPU percent
uses delta process CPU / wall time (100% = one core). Worker bodies remain raw;
parent-process metrics are not mislabeled as aggregate worker CPU. Capacity safety
requires tick telemetry AND >=5s hold-view windows, observed slot/viewer saturation,
no failures, and lag/Hz budgets. Missing telemetry yields unknown, not a fake pass.
The reported maximum is the highest passing tested level, not an untested limit.
Server tick percentiles are cumulative since boot (including workers); successive
sweep levels share that history. Restart the server and run each level separately
for independent certification; the runner never resets or invents server buckets.
Exit 0 = all stages within exposed budgets (or completion with unknown telemetry),
1 = failed/over-budget or sweep/measurement-only unknown, 2 = usage/fatal error, 130 = interrupted.

Target mode grows existing matches in place (default levels 1,2,4,8,16,32,64), creates
at most one match every two seconds, and samples capacity every second. Worker rolling
p95 can stop the ramp only with >=100 mature samples (the server excludes each match's
first two game seconds); main event-loop p99 can stop it immediately. Either lateness
budget defaults to 25ms. A queued lobby admission, 409 capacity or HTTP 429 also stop the
ramp. It never waits for natural completion: sockets close and every created lobby is left,
which ends its game. This is real production load, not a dry-run.
Lobby creation is limited per IP by the server's MATCHES_PER_IP per MATCH_RATE_WINDOW_S (default
30 per 10 minutes) unless an operator raises it; the tool never bypasses limits. No spectators,
featured viewers or flood controls in target mode. Largest stable level requires
an active-worker window with >=100 mature samples by the end of its dwell; a cold
window alone cannot trip lateness or certify a level. Missing data is not certified.
Bounded cleanup may take up to two additional seconds after --max-wall.
Target mode exits 0 only when all requested levels finish; protective/error stops
exit 1, and interruption exits 130. A protective stop is not a passed load stage.
`;

/** Lobby presets: today's duel and the four-army FFA (DESIGN §15.14: measure FFA before enabling it publicly). */
export const FIXTURES = { duel: { mapId: 'open', layoutId: 'duel' }, ffa: { mapId: 'four_corners', layoutId: 'ffa' } };

export function options(argv) {
  if (argv[0] === '--') argv = argv.slice(1);
  const { values: v } = parseArgs({ args: argv, allowPositionals: false, options: {
    help: { type: 'boolean' }, url: { type: 'string', default: 'http://localhost:2567' },
    target: { type: 'string' }, dwell: { type: 'string', default: '30' },
    'max-wall': { type: 'string', default: '600' }, 'max-matches': { type: 'string', default: '64' },
    headers: { type: 'boolean', default: false }, players: { type: 'boolean', default: false },
    'measurement-only': { type: 'boolean', default: false },
    'ws-url': { type: 'string' }, matches: { type: 'string', default: '1' },
    concurrency: { type: 'string' }, spectators: { type: 'string', default: '0' },
    'featured-viewers': { type: 'string', default: '0' },
    levels: { type: 'string' }, duration: { type: 'string' }, ramp: { type: 'string', default: '0' },
    'queue-timeout': { type: 'string', default: '900' }, 'match-timeout': { type: 'string', default: '3600' },
    'request-timeout': { type: 'string', default: '15' }, 'sample-interval': { type: 'string' },
    'lag-budget-ms': { type: 'string' }, 'min-hz': { type: 'string', default: '19' },
    'home-rps': { type: 'string', default: '0' }, 'static-rps': { type: 'string', default: '0' },
    'static-path': { type: 'string', multiple: true, default: [] }, 'flood-concurrency': { type: 'string', default: '16' },
    fixture: { type: 'string', default: 'duel' }, map: { type: 'string' }, layout: { type: 'string' },
  } });
  if (v.help) return { help: true };
  const fixture = Object.hasOwn(FIXTURES, v.fixture) ? FIXTURES[v.fixture] : undefined;
  if (!fixture) throw new Error('--fixture must be duel or ffa');
  const number = (key, fallback, min = 0, integer = false) => {
    const n = Number(v[key] ?? fallback);
    if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new Error(`Invalid --${key}`);
    return n;
  };
  const matches = number('matches', 1, 1, true);
  const concurrency = number('concurrency', matches, 1, true);
  if (concurrency > matches && !v.levels) throw new Error('--concurrency must not exceed --matches');
  const levels = v.levels?.split(',').map((s) => Number(s));
  if (levels && (levels.some((n, i) => !Number.isInteger(n) || n < 1 || (i && n <= levels[i - 1])))) throw new Error('--levels must be positive ascending integers');
  if (levels && v.concurrency) throw new Error('--levels replaces --concurrency');
  const duration = number('duration', levels ? 60 : 0);
  if (levels && duration <= 0) throw new Error('--levels requires positive --duration');
  if (v['measurement-only'] && (duration <= 0 || (levels && levels.length > 1))) {
    throw new Error('--measurement-only requires positive --duration and at most one --levels value; restart the dedicated server between runs');
  }
  const base = new URL(v.target ?? v.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('--url must be an HTTP(S) base without credentials/query/fragment');
  base.pathname = base.pathname.replace(/\/$/, '') + '/';
  const staticPaths = v['static-path'];
  for (const path of staticPaths) if (!path.startsWith('/') || path.startsWith('//')) throw new Error('--static-path must be a same-origin path');
  if (number('static-rps', 0) > 0 && !staticPaths.length) throw new Error('--static-rps needs --static-path');
  const featuredViewers = number('featured-viewers', 0, 0, true);
  if (featuredViewers > 10000) throw new Error('--featured-viewers must not exceed 10000');
  const maxWall = number('max-wall', 600, 0.001);
  const maxMatches = number('max-matches', 64, 1, true);
  if (v.target && (maxWall > 600 || maxMatches > 64)) throw new Error('--target caps --max-wall at 600 and --max-matches at 64');
  if (v.target && levels?.some((level) => level > maxMatches)) throw new Error('--target levels must not exceed --max-matches');
  if (v.target && (featuredViewers || number('spectators', 0) || number('home-rps', 0) || number('static-rps', 0)
    || v['measurement-only'] || v.players)) throw new Error('--target does not combine with spectators, featured viewers, floods, --players or --measurement-only');
  if (v.players && number('spectators', 0)) throw new Error('--players does not combine with --spectators');
  return {
    url: base.href, wsUrl: v['ws-url'] ?? base.href, matches, concurrency, levels, duration,
    target: v.target ? base.href : undefined, dwell: number('dwell', 30, 0.001),
    maxWall: Math.ceil(maxWall * 1000), maxMatches,
    spectators: number('spectators', 0, 0, true), ramp: number('ramp', 0),
    featuredViewers,
    queueTimeout: Math.ceil(number('queue-timeout', 900, 0.001) * 1000),
    matchTimeout: Math.ceil(number('match-timeout', 3600, 0.001) * 1000),
    requestTimeout: Math.ceil(number('request-timeout', 15, 0.001) * 1000),
    sampleInterval: number('sample-interval', v.target ? 1 : 2, 0.05) * 1000,
    lagBudgetMs: number('lag-budget-ms', v.target ? 25 : 50), minHz: number('min-hz', 19, 0.001),
    homeRps: number('home-rps', 0), staticRps: number('static-rps', 0), staticPaths,
    floodConcurrency: number('flood-concurrency', 16, 1, true),
    headers: v.headers,
    measurementOnly: v['measurement-only'],
    players: v.players,
    lobby: { mapId: v.map ?? fixture.mapId, layoutId: v.layout ?? fixture.layoutId, ...(v.players ? PLAYER_PRESET : LOBBY_PRESET) },
  };
}

export class Histogram {
  count = 0; sum = 0; min = Infinity; max = 0; bins = new Map();
  add(value) {
    if (!Number.isFinite(value) || value < 0) return;
    this.count++; this.sum += value; this.min = Math.min(this.min, value); this.max = Math.max(this.max, value);
    const bin = Math.ceil(Math.log1p(value) / Math.log(1.05));
    this.bins.set(bin, (this.bins.get(bin) ?? 0) + 1);
  }
  quantile(q, lowerBound = false) {
    if (!this.count) return null;
    let seen = 0;
    for (const [bin, n] of [...this.bins].sort((a, b) => a[0] - b[0])) {
      seen += n;
      if (seen >= Math.max(1, Math.ceil(q * this.count))) {
        return lowerBound ? Math.max(this.min, Math.expm1((bin - 1) * Math.log(1.05)))
          : Math.min(this.max, Math.expm1(bin * Math.log(1.05)));
      }
    }
    return this.max;
  }
  json() {
    return { count: this.count, min: this.count ? this.min : null, max: this.count ? this.max : null,
      mean: this.count ? this.sum / this.count : null, p05: this.quantile(0.05), p50: this.quantile(0.5), p95: this.quantile(0.95), p99: this.quantile(0.99) };
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function retryDelay(headers, body, now = Date.now()) {
  const retry = headers.get('retry-after');
  if (retry !== null) {
    const seconds = Number(retry);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now;
    if (Number.isFinite(ms)) return Math.max(100, ms);
  }
  return typeof body?.pollAfterMs === 'number' && Number.isFinite(body.pollAfterMs)
    ? Math.max(100, body.pollAfterMs) : 2000;
}

export function endpoint(base, path) { return new URL(path.replace(/^\//, ''), base).href; }

/** A private all-bot auto-start lobby: the public equivalent of a headless bot match its creator observes. */
export const LOBBY_PRESET = { visibility: 'private', preset: 'benchmark', autoStart: true };
/** A private auto-start play lobby: the creator holds its side's human seats, the other side is built-in bots. */
export const PLAYER_PRESET = { visibility: 'private', preset: 'play', autoStart: true };

/** POST a lobby member route (`connect`, `ticket`, `leave`) with that member's credential. */
export function lobbyRoute(request, base, lobby, path, kind, signal) {
  return request(endpoint(base, `/api/lobbies/${encodeURIComponent(lobby.code)}/${path}`), {
    method: 'POST', headers: { authorization: lobby.authorization, 'content-type': 'application/json' }, body: '{}', signal,
  }, kind);
}

/** One anonymous lobby creation. Never retry an ambiguous POST/network failure: it could already have created a lobby. */
export async function createLobby(request, base, setup, signal) {
  const response = await request(endpoint(base, '/api/lobbies'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...LOBBY_PRESET, ...setup }), signal,
  }, 'create');
  if (response.status !== 200) return response;
  if (typeof response.body?.code !== 'string' || typeof response.body?.visitorToken !== 'string') throw new Error('Lobby response missing code/visitorToken');
  return { ...response, lobby: { code: response.body.code, authorization: `Visitor ${response.body.visitorToken}` } };
}

/** 429 and 409 capacity (every lobby slot taken) are explicit rejections: nothing was created. */
export function lobbyRejected(response) { return response.status === 429 || (response.status === 409 && response.body?.error === 'capacity'); }

/**
 * Connect → attach (which starts the auto-start lobby) → started → the member's ticket: an observer ticket, or with
 * `player` the creator's exact-seat tickets. Admission queueing is reported through the lobby's own snapshots.
 * `joinLobby(roomId, token, events)` opens the pregame socket.
 */
export async function startLobby({ request, base, lobby, joinLobby, signal, player = false, onQueued = () => {} }) {
  const grant = await lobbyRoute(request, base, lobby, 'connect', 'connect', signal);
  if (grant.status !== 200 || typeof grant.body?.roomId !== 'string' || typeof grant.body?.token !== 'string') throw new Error(`Lobby connect HTTP ${grant.status}`);
  const started = Promise.withResolvers();
  started.promise.catch(() => {});
  const abort = () => started.reject(signal.reason);
  if (signal.aborted) throw signal.reason;
  signal.addEventListener('abort', abort, { once: true });
  let socket;
  try {
    socket = await joinLobby(grant.body.roomId, grant.body.token, {
      snapshot(snapshot) {
        if (Number.isFinite(snapshot?.queuePosition)) onQueued({ position: snapshot.queuePosition, estimatedWaitMs: snapshot.estimatedWaitMs });
        if (snapshot?.phase === 'started') started.resolve();
      },
      error(code) { started.reject(new Error(`Lobby error: ${code}`)); },
      left(code) { started.reject(new Error(`Lobby socket closed: ${code}`)); },
    });
    await started.promise;
  } finally {
    signal.removeEventListener('abort', abort);
    // A started lobby keeps the membership; the pregame socket is no longer needed.
    await socket?.leave();
  }
  const ticket = await lobbyRoute(request, base, lobby, 'ticket', 'ticket', signal);
  const body = ticket.body;
  const valid = ticket.status === 200 && typeof body?.roomId === 'string' && typeof body?.token === 'string' && (player
    ? body.observer !== true && Array.isArray(body.tickets) && body.tickets.length > 0 && body.tickets.every((seat) => typeof seat?.token === 'string')
    : body.observer === true);
  if (!valid) throw new Error(`Lobby ticket HTTP ${ticket.status}`);
  return { roomId: body.roomId, token: body.token, ...(player ? { tickets: body.tickets.map((seat) => ({ role: seat.role, token: seat.token })) } : {}) };
}

/** Waits out explicit rejections, then starts the lobby. Unstarted lobbies stay in `pending` until left. */
export async function acquireTicket({ base, setup, signal, timeout, request, joinLobby, onQueued = () => {}, pending, cancel }) {
  const started = performance.now();
  const admission = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  let lobby;
  try {
    for (;;) {
      const response = await createLobby(request, base, setup, admission);
      if (response.lobby) { lobby = response.lobby; pending.add(lobby); break; }
      if (!lobbyRejected(response)) throw new Error(`Create HTTP ${response.status}: ${typeof response.body?.error === 'string' ? response.body.error : 'bad_response'}`);
      await sleep(retryDelay(response.headers, response.body), admission);
    }
    const ticket = await startLobby({ request, base, lobby, joinLobby, signal: admission, player: setup.preset === PLAYER_PRESET.preset, onQueued });
    pending.delete(lobby);
    return { ticket: { ...ticket, lobby }, waitMs: performance.now() - started };
  } catch (error) {
    // Leave immediately, not after other slots finish (which may take an hour).
    // Preserve the original failure; failed cancellation remains in pending.
    if (lobby && pending.has(lobby) && cancel) await cancel(lobby).catch(() => {});
    throw error;
  }
}

/** Observer frames carry every army's outcome once the match is decided; the creator follows the first army's. */
export function observerView(message) {
  const frame = message?.frame;
  if (!frame || !Number.isFinite(frame.tick)) return undefined;
  const outcomes = frame.outcomes ? Object.values(frame.outcomes) : [];
  const decided = outcomes.length > 0 && outcomes.every((outcome) => outcome !== 'running');
  return decided ? { tick: frame.tick, outcome: outcomes[0] } : { tick: frame.tick };
}

export function classify({ failures, headerFailures = 0, saturated, tickP99, hzP05, lagBudgetMs, minHz, capacitySamples }) {
  if (failures) return { state: 'fail', reason: 'request_join_or_match_failure' };
  if (headerFailures) return { state: 'fail', reason: 'response_header_policy_failure' };
  if (Number.isFinite(tickP99) && tickP99 > lagBudgetMs) return { state: 'fail', reason: 'tick_lag_budget_exceeded' };
  if (Number.isFinite(hzP05) && hzP05 < minHz) return { state: 'fail', reason: 'observed_tick_rate_below_budget' };
  if (!saturated) return { state: 'unknown', reason: 'target_not_observed_during_hold' };
  if (!capacitySamples || !Number.isFinite(tickP99)) return { state: 'unknown', reason: 'server_tick_telemetry_unavailable' };
  if (!Number.isFinite(hzP05)) return { state: 'unknown', reason: 'insufficient_5s_tick_windows' };
  return { state: 'pass', reason: 'measured_20hz_budget_met' };
}

/** Bounded evidence from requests already made; never prints lobby codes or credentials. */
export class HeaderObservations {
  urls = new Map();
  responses = 0;
  failures = 0;
  omittedResponses = 0;

  observe(url, kind, response) {
    this.responses++;
    const parsed = new URL(url);
    const api = ['create', 'connect', 'ticket', 'profile', 'join', 'cancel', 'capacity', 'featured'].includes(kind);
    const contentType = response.headers.get('content-type');
    const cacheControl = response.headers.get('cache-control');
    const contentEncoding = response.headers.get('content-encoding');
    const vary = response.headers.get('vary');
    const directives = new Set((cacheControl ?? '').toLowerCase().split(',').map((part) => part.trim()));
    const varyFields = new Set((vary ?? '').toLowerCase().split(',').map((part) => part.trim()));
    const html = /^text\/html(?:;|$)/i.test(contentType ?? '');
    const hashed = /\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[^/]+$/.test(parsed.pathname);
    // A bodiless 204 (lobby leave) carries no cacheable representation.
    const expected = api && response.status !== 204 ? 'no-store' : html ? 'no-cache' : hashed ? 'immutable' : null;
    const maxAge = [...directives].find((part) => /^max-age\s*=/.test(part));
    const maxAgeSeconds = maxAge ? Number(maxAge.split('=')[1].replaceAll('"', '').trim()) : NaN;
    const cacheOk = expected === 'immutable'
      ? directives.has('public') && directives.has('immutable') && maxAgeSeconds >= 31536000
        && !directives.has('no-cache') && !directives.has('no-store')
      : expected ? directives.has(expected) : null;
    const encoded = contentEncoding && contentEncoding.toLowerCase().trim() !== 'identity';
    const varyOk = encoded ? varyFields.has('accept-encoding') || varyFields.has('*') : null;
    const checks = { cacheControl: cacheOk === null ? 'notApplicable' : cacheOk ? 'pass' : 'fail',
      encodingVary: varyOk === null ? 'notApplicable' : varyOk ? 'pass' : 'fail' };
    if (cacheOk === false || varyOk === false) this.failures++;
    if (api) {
      parsed.pathname = parsed.pathname.replace(/(\/api\/lobbies\/)[A-Za-z0-9_-]{16}(?=\/)/, '$1:code');
      parsed.search = '';
    }
    const key = parsed.href;
    let entry = this.urls.get(key);
    if (!entry) {
      if (this.urls.size >= 50) { this.omittedResponses++; return; }
      entry = { url: key, kind, responses: 0, statuses: {}, expectedCachePolicy: expected,
        checks: { cacheControl: { pass: 0, fail: 0, notApplicable: 0 }, encodingVary: { pass: 0, fail: 0, notApplicable: 0 } },
        variants: [], omittedVariants: 0 };
      this.urls.set(key, entry);
    }
    entry.responses++;
    entry.statuses[response.status] = (entry.statuses[response.status] ?? 0) + 1;
    for (const [name, result] of Object.entries(checks)) entry.checks[name][result]++;
    const variant = { cacheControl, contentEncoding, vary, contentType };
    const match = entry.variants.find((value) => Object.keys(variant).every((name) => value[name] === variant[name]));
    if (match) match.responses++;
    else if (entry.variants.length < 8) entry.variants.push({ ...variant, responses: 1 });
    else entry.omittedVariants++;
  }

  json() {
    return { responses: this.responses, failures: this.failures, maxUrls: 50, maxVariantsPerUrl: 8,
      omittedResponses: this.omittedResponses, urls: [...this.urls.values()] };
  }
}

// A released frame of the featured relay; admission (`buffering`) and match announcements are not frames.
const FRAME_FIELD = [...Buffer.from('data: {"op":"observer","state":"ready"')];

/** Finds only the first complete SSE event carrying a released observer frame, retaining no payload bytes. */
export class FirstSseFrame {
  found = false;
  lineLength = 0;
  dataPrefix = true;
  eventHasData = false;
  previousCr = false;

  push(chunk) {
    if (this.found) return true;
    for (const byte of chunk) {
      if (byte === 10 && this.previousCr) { this.previousCr = false; continue; }
      if (byte === 10 || byte === 13) {
        this.previousCr = byte === 13;
        if (!this.lineLength) {
          if (this.eventHasData) { this.found = true; return true; }
          this.eventHasData = false;
        } else if (this.dataPrefix && this.lineLength >= FRAME_FIELD.length) this.eventHasData = true;
        this.lineLength = 0;
        this.dataPrefix = true;
      } else {
        this.previousCr = false;
        if (this.lineLength < FRAME_FIELD.length && byte !== FRAME_FIELD[this.lineLength]) this.dataPrefix = false;
        this.lineLength++;
      }
    }
    return false;
  }
}
