/**
 * Local multi-node rig for cluster mode (README “Cluster mode”): a real Redis, Postgres (the production store path),
 * N server nodes and a non-sticky round-robin proxy standing in for Railway's balancer (a fresh target per HTTP
 * request, per WebSocket connection; no affinity). The scenarios exercise every public surface across nodes, a
 * primary killed mid-match, a rolling restart under load, a small load run, the shared admission limits and Watch live
 * featuring a public game on another node across a primary handover.
 *
 *   node apps/server/scripts/cluster-rig.ts [--nodes 3] [--scenarios a,b,c,d,e,f,g,h] [--out <dir>]
 *     [--redis-url redis://…] [--database-url postgres://…] [--pg-bin <dir with initdb/postgres>] [--memory]
 *
 * Without `--redis-url` it starts `redis-server` (PATH or REDIS_SERVER); without `--database-url` it starts a
 * throwaway Postgres from `--pg-bin` / PG_BIN (or `--memory`: in-memory stores, which cannot survive a primary
 * change and so only fit the scenarios that never change it). Nodes run under `taskset -c 2,3 nice -n 10` unless
 * RIG_CPUS is set ("" disables it). It prints one JSON report (also written to `--out`/report.json) and exits non-zero
 * when a scenario fails. `test/cluster-rig.test.ts` runs the same scenarios with assertions.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import { Client as SdkClient, type Room } from '@colyseus/sdk';
import { connectSeat } from '@playerthree/runner';
import { applyView, type ServerMsg, type ViewState } from 'playerthree';
import { LOBBY_MOVED_CLOSE, type LobbySnapshot } from '@agent-command/game/lobby';

const SERVER_MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const LOADTEST_MAIN = fileURLToPath(new URL('../../../tools/loadtest/src/main.mjs', import.meta.url));
const WEB_INDEX = new URL('../../web/index.html', import.meta.url);
/** Node env every rig node shares (the production shape, sized for a shared two-core box). */
const NODE_ENV: Record<string, string> = {
  NODE_ENV: 'production', HOST: '127.0.0.1', TRUST_PROXY: '1', PLAYERTHREE_DEVTOOLS: '0', RULES_FILE: '', RULES_JSON: '',
  DATA_DIR: '', HISTORY_DIR: '',
  // One worker per node, four duel units each: twelve units across three nodes, one featured showcase included.
  SIM_WORKERS: '1', MATCHES_PER_WORKER: '4', MAIN_MAX_MATCHES: '4',
  // The per-IP limits scenario (g) proves across nodes.
  MATCHES_PER_IP: '6', FEATURED_VIEWERS_PER_IP: '2',
  // A shared development machine lags far beyond production's 25 ms; admission still gates on slots and CPU.
  ADMISSION_LAG_MS: '1000',
  // The fixed featured duel (one unit) rather than the playlist: scenario (g) counts units exactly.
  FEATURED_MATCH: '1', FEATURED_PLAYLIST: 'off',
  // A draining node waits for its (one-minute) rig matches instead of interrupting them.
  DRAIN_MAX_SECONDS: '240', DRAIN_LOG_INTERVAL_SECONDS: '10',
  // A finished match's room closes soon after its result (the rig counts results, not grace periods).
  END_GRACE_SECONDS: '10',
};

function tcpOpen(port: number): Promise<boolean> {
  const open = Promise.withResolvers<boolean>();
  const socket = connect(port, '127.0.0.1', () => { socket.destroy(); open.resolve(true); });
  socket.on('error', () => open.resolve(false));
  return open.promise;
}
/** Rig matches: one game minute, so a draining node finishes them during a rolling restart. */
const SHORT_MATCH = { spire: { timeCap: 60 } };
/** Seat tickets live 120 s; the web client renews well inside that, and so does the rig. */
const SEAT_RENEWAL_MS = 30_000;
const DUEL = { mapId: 'open', layoutId: 'duel' };
const FFA = { mapId: 'four_corners', layoutId: 'ffa' };
const READY_MS = 60_000;
/** Railway removes a crashed replica from rotation once its health check fails; the rig waits this long first. */
const LB_DETECTION_MS = 2000;
const COMMANDER_CALL_GAP_MS = 110;

// ------------------------------------------------------------------ small helpers

export async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000, what = 'condition'): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}

function pause(ms: number): Promise<void> {
  const done = Promise.withResolvers<void>();
  setTimeout(done.resolve, ms);
  return done.promise;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const { port } = server.address() as { port: number };
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

let ipCounter = 0;
/** A distinct simulated client address (the proxy passes a client-supplied X-Forwarded-For through). */
export function freshIp(): string {
  ipCounter++;
  return `10.77.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export interface Summary { n: number; p50: number; p95: number; max: number }
export function summary(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!) : 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1) ?? 0) };
}

/** Timed JSON call; throws with the status and server code on a non-2xx answer. */
async function call<T>(base: string, path: string, init: { method?: string; body?: unknown; authorization?: string; ip?: string; timings?: number[] } = {}): Promise<T> {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': init.ip ?? freshIp(), ...(init.authorization ? { authorization: init.authorization } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  init.timings?.push(performance.now() - started);
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${init.method ?? 'POST'} ${path} → ${response.status} ${text.slice(0, 200)}`), { status: response.status });
  return (text ? JSON.parse(text) : undefined) as T;
}

// ------------------------------------------------------------------ the balancer

interface Target { name: string; host: string; port: number }

/**
 * Non-sticky round robin, like Railway's random spread: every HTTP request and every WebSocket connection goes to
 * the next node in rotation. A client-supplied X-Forwarded-For passes through (the rig simulates many client
 * addresses); otherwise the socket address is appended, as an edge would.
 */
export class RoundRobinProxy {
  readonly server: Server;
  readonly #targets: Target[] = [];
  #next = 0;
  /** Requests and upgrades per node name, and per node for `/mcp` POSTs (scenario b counts the spread). */
  readonly http = new Map<string, number>();
  readonly sockets = new Map<string, number>();
  readonly mcp = new Map<string, number>();
  base = '';

  constructor() {
    this.server = createServer((req, res) => this.#request(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      const target = this.#pick();
      if (!target) { socket.destroy(); return; }
      this.sockets.set(target.name, (this.sockets.get(target.name) ?? 0) + 1);
      const upstream = connect({ host: target.host, port: target.port, noDelay: true });
      socket.pause();
      upstream.once('connect', () => {
        const headers = { ...req.headers, 'x-forwarded-for': req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '' };
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).flatMap(([key, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((entry) => `${key}: ${entry}\r\n`)).join('')}\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        socket.resume();
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
    });
  }

  async listen(): Promise<string> {
    const listening = Promise.withResolvers<void>();
    this.server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this.base;
  }

  add(name: string, port: number): void { this.#targets.push({ name, host: '127.0.0.1', port }); }
  remove(name: string): void {
    const index = this.#targets.findIndex((target) => target.name === name);
    if (index >= 0) this.#targets.splice(index, 1);
  }
  get rotation(): string[] { return this.#targets.map((target) => target.name); }

  #pick(): Target | undefined {
    if (!this.#targets.length) return undefined;
    this.#next = (this.#next + 1) % this.#targets.length;
    return this.#targets[this.#next];
  }

  #request(req: IncomingMessage, res: ServerResponse): void {
    const target = this.#pick();
    if (!target) { res.writeHead(503).end(); return; }
    this.http.set(target.name, (this.http.get(target.name) ?? 0) + 1);
    if (req.url === '/mcp' && req.method === 'POST') this.mcp.set(target.name, (this.mcp.get(target.name) ?? 0) + 1);
    const headers = { ...req.headers, 'x-forwarded-for': req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '' };
    const upstream = httpRequest({ host: target.host, port: target.port, path: req.url, method: req.method, headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    // A dead upstream: the balancer answers 502, as Railway's edge does for a replica that stopped responding.
    upstream.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"bad_gateway"}'); });
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  close(): Promise<void> {
    const closed = Promise.withResolvers<void>();
    this.server.close(() => closed.resolve());
    this.server.closeAllConnections();
    return closed.promise;
  }
}

// ------------------------------------------------------------------ the rig

export interface RigNode {
  name: string;
  child: ChildProcess;
  base: string;
  internal: string;
  id: string;
  output(): string;
  exited: Promise<number | null>;
}

export interface RigOptions {
  nodes?: number;
  dir: string;
  redisUrl?: string;
  databaseUrl?: string;
  pgBin?: string;
  memory?: boolean;
  /** Extra env for every node. */
  env?: Record<string, string>;
  /** CPU list for `taskset` (empty: no pinning). */
  cpus?: string;
}

export class Rig {
  readonly nodes: RigNode[] = [];
  readonly proxy = new RoundRobinProxy();
  readonly secret = randomBytes(32).toString('base64url');
  readonly arenaSeedKey = randomBytes(32).toString('hex');
  readonly #children: ChildProcess[] = [];
  readonly #options: RigOptions;
  readonly #dist: string;
  #counter = 0;
  redisUrl = '';
  databaseUrl: string | undefined;
  redis!: Redis;

  private constructor(options: RigOptions) {
    // Absolute: Postgres puts its socket under the data directory.
    this.#options = { ...options, dir: resolve(options.dir) };
    options = this.#options;
    mkdirSync(options.dir, { recursive: true });
    this.#dist = mkdtempSync(join(options.dir, 'web-'));
    writeFileSync(join(this.#dist, 'index.html'), readFileSync(WEB_INDEX));
    mkdirSync(join(this.#dist, 'assets'));
    writeFileSync(join(this.#dist, 'assets', 'app-rig.js'), 'console.log(1)');
  }

  static async start(options: RigOptions): Promise<Rig> {
    const rig = new Rig(options);
    try {
      await rig.#infrastructure();
      await rig.proxy.listen();
      for (let i = 0; i < (options.nodes ?? 3); i++) await rig.startNode();
      await rig.converged();
      return rig;
    } catch (error) {
      await rig.close();
      throw error;
    }
  }

  async #infrastructure(): Promise<void> {
    const options = this.#options;
    if (options.redisUrl) this.redisUrl = options.redisUrl;
    else {
      const port = await freePort();
      const dir = join(options.dir, 'redis');
      mkdirSync(dir, { recursive: true });
      this.#spawn(process.env.REDIS_SERVER ?? 'redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', dir]);
      this.redisUrl = `redis://127.0.0.1:${port}`;
      await until(() => tcpOpen(port), 10_000, 'redis');
    }
    this.redis = new Redis(this.redisUrl);
    await this.redis.ping();
    // A previous run's lease and lobbies must not leak into this one (the rig owns this Redis).
    await this.redis.flushdb();
    if (options.databaseUrl) this.databaseUrl = options.databaseUrl;
    else if (!options.memory) {
      const bin = options.pgBin ?? process.env.PG_BIN;
      if (!bin) throw new Error('Postgres: pass --database-url, --pg-bin (or PG_BIN), or --memory');
      const data = join(options.dir, 'pg');
      const port = await freePort();
      const init = spawn(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--no-sync'], { stdio: 'ignore' });
      const initialized = Promise.withResolvers<number | null>();
      init.once('exit', initialized.resolve);
      if (await initialized.promise !== 0) throw new Error('initdb failed');
      this.#spawn(join(bin, 'postgres'), ['-D', data, '-p', String(port), '-k', data, '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off']);
      this.databaseUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
      await until(() => tcpOpen(port), 20_000, 'postgres');
    }
  }

  #spawn(command: string, args: string[]): ChildProcess {
    const log = openSync(join(this.#options.dir, `${command.split('/').at(-1)}.log`), 'a');
    const child = spawn(command, args, { stdio: ['ignore', log, log] });
    this.#children.push(child);
    return child;
  }

  /** Start one more node (as Railway starts a replica) and add it to the balancer once it serves. */
  async startNode(env: Record<string, string> = {}): Promise<RigNode> {
    const name = `n${++this.#counter}`;
    const [port, clusterPort] = [await freePort(), await freePort()];
    const internal = `http://127.0.0.1:${clusterPort}`;
    const cpus = this.#options.cpus ?? '2,3';
    const [command, args] = cpus ? ['taskset', ['-c', cpus, 'nice', '-n', '10', process.execPath, SERVER_MAIN]] : [process.execPath, [SERVER_MAIN]];
    const child = spawn(command, args, {
      env: {
        ...process.env, ...NODE_ENV, PORT: String(port), PUBLIC_URL: this.proxy.base, WEB_DIST: this.#dist,
        REDIS_URL: this.redisUrl, CLUSTER_SECRET: this.secret, CLUSTER_PORT: String(clusterPort), CLUSTER_HOST: '127.0.0.1', CLUSTER_ADDRESS: internal,
        DATABASE_URL: this.databaseUrl ?? '', ...(this.databaseUrl ? { ARENA_SEED_KEY: this.arenaSeedKey } : {}),
        ...this.#options.env, ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exited = Promise.withResolvers<number | null>();
    child.once('exit', (code) => exited.resolve(code));
    await until(() => {
      if (child.exitCode !== null) throw new Error(`${name} exited: ${output}`);
      return /agent-command server on :\d+/.test(output);
    }, READY_MS, `${name} to listen`);
    const id = /cluster: node ([0-9a-f]{24}) at/.exec(output)?.[1];
    if (!id) throw new Error(output);
    const node: RigNode = { name, child, base: `http://127.0.0.1:${port}`, internal, id, output: () => output, exited: exited.promise };
    this.nodes.push(node);
    this.proxy.add(name, port);
    writeFileSync(join(this.#options.dir, `${name}.pid`), String(child.pid));
    return node;
  }

  /** Every live node sees every other live node (heartbeats), and a primary serves. */
  async converged(ms = READY_MS): Promise<RigNode> {
    const live = this.live();
    await until(async () => (await this.redis.smembers('ac:cluster:nodes')).filter((id) => live.some((node) => node.id === id)).length === live.length, ms, 'heartbeats');
    const primary = await until(async () => await this.primary(), ms, 'a primary');
    await until(async () => (await fetch(`${this.proxy.base}/api/maps`, { headers: { 'x-forwarded-for': freshIp() } })).status === 200, ms, 'the coordinator to serve');
    return primary;
  }

  live(): RigNode[] { return this.nodes.filter((node) => node.child.exitCode === null && node.child.signalCode === null); }

  async primary(): Promise<RigNode | undefined> {
    const id = await this.redis.get('ac:cluster:primary');
    return this.nodes.find((node) => node.id === id && node.child.exitCode === null && node.child.signalCode === null);
  }

  /** SIGKILL: a crash. The balancer keeps sending to it until its health check would fail. */
  async kill(node: RigNode): Promise<void> {
    node.child.kill('SIGKILL');
    await node.exited;
    await pause(LB_DETECTION_MS);
    this.proxy.remove(node.name);
  }

  /** A deploy's teardown: out of rotation first (Railway routes new traffic to the new deployment), then SIGTERM. */
  drain(node: RigNode): void {
    this.proxy.remove(node.name);
    node.child.kill('SIGTERM');
  }

  async close(): Promise<void> {
    for (const node of this.nodes) if (node.child.exitCode === null && node.child.signalCode === null) node.child.kill('SIGKILL');
    await Promise.all(this.nodes.map((node) => node.exited));
    await this.proxy.close().catch(() => {});
    this.redis?.disconnect();
    for (const child of this.#children) child.kill('SIGTERM');
    await Promise.all(this.#children.map((child) => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise((resolve) => child.once('exit', resolve))));
  }
}

// ------------------------------------------------------------------ clients

/** A lobby member: the lobby socket (through the balancer) and its HTTP credential. */
export class LobbyMember {
  readonly snapshots: LobbySnapshot[] = [];
  readonly base: string;
  readonly code: string;
  readonly authorization: string;
  readonly ip = freshIp();
  room: Room | undefined;
  #seq = 0;
  readonly #results = new Map<number, { ok: boolean; code?: string }>();
  #leaving = false;
  /** Re-admissions after the lobby moved to another primary (or its socket broke). */
  rejoins = 0;

  constructor(base: string, code: string, authorization: string) {
    this.base = base;
    this.code = code;
    this.authorization = authorization;
  }

  static async create(base: string, body: Record<string, unknown>, timings?: number[]): Promise<LobbyMember> {
    const ip = freshIp();
    const opened = await call<{ code: string; visitorToken: string }>(base, '/api/lobbies', { body, ip, ...(timings ? { timings } : {}) });
    return new LobbyMember(base, opened.code, `Visitor ${opened.visitorToken}`);
  }

  /** A second visitor joins (a fresh visitor credential comes from the directory admission). */
  static async join(base: string, code: string, extra: Record<string, unknown>, timings?: number[]): Promise<LobbyMember> {
    const directory = await call<{ visitorToken: string }>(base, '/api/lobbies/directory/connect', { body: {} });
    const member = new LobbyMember(base, code, `Visitor ${directory.visitorToken}`);
    await call(base, '/api/lobbies/join', { body: { code, ...extra }, authorization: member.authorization, ip: member.ip, ...(timings ? { timings } : {}) });
    return member;
  }

  route<T>(path: string, body: unknown = {}, timings?: number[]): Promise<T> {
    return call<T>(this.base, `/api/lobbies/${this.code}/${path}`, { body, authorization: this.authorization, ip: this.ip, ...(timings ? { timings } : {}) });
  }

  /** (Re)attach the pregame socket through a fresh admission. */
  async attach(timings?: number[]): Promise<void> {
    const grant = await this.route<{ roomId: string; token: string }>('connect', {}, timings);
    const room = await new SdkClient(this.base).joinById(grant.roomId, { token: grant.token });
    room.reconnection.enabled = false;
    room.onMessage('lobby:snapshot', (snapshot: LobbySnapshot) => this.snapshots.push(snapshot));
    room.onMessage('lobby:result', (result: { seq: number; ok: boolean; code?: string }) => this.#results.set(result.seq, result));
    room.onMessage('lobby:error', () => {});
    room.onMessage('lobby:list', () => {});
    this.room = room;
    // Like the web client: a lobby that moved to the next primary (or whose connection broke) is re-admitted at once.
    room.onLeave((code) => {
      if (this.#leaving || this.room !== room || (code !== LOBBY_MOVED_CLOSE && code !== 1006)) return;
      void (async () => {
        for (let attempt = 0; attempt < 10 && !this.#leaving && this.room === room; attempt++) {
          try { await this.attach(); this.rejoins++; return; } catch { await pause(1000); }
        }
      })();
    });
    await until(() => this.snapshots.length > 0, 10_000, 'a lobby snapshot');
  }

  async command(op: Record<string, unknown>): Promise<void> {
    const seq = ++this.#seq;
    const revision = this.snapshots.at(-1)!.revision;
    this.room!.send('lobby:command', { seq, revision, ...op });
    const result = await until(() => this.#results.get(seq), 10_000, `lobby ${String(op.op)}`);
    if (!result.ok) throw new Error(`lobby ${String(op.op)} refused: ${result.code}`);
  }

  phase(): string | undefined { return this.snapshots.at(-1)?.phase; }

  async leave(): Promise<void> {
    this.#leaving = true;
    await this.room?.leave(true).catch(() => {});
    await this.route('leave').catch(() => {});
  }
}

/** One seat connection to a match (view stream tracked), joined through the balancer. */
export class Seat {
  readonly ticks: number[] = [];
  readonly views = new Map<string, ViewState>();
  closedWith: number | undefined;
  room!: Room;
  gaps = 0;
  /** The match's after-action report arrived: it ended with its own outcome. */
  reported = false;

  static async open(base: string, roomId: string, token: string, view = true): Promise<Seat> {
    const seat = new Seat();
    seat.room = await new SdkClient(base).joinById(roomId, { token, ...(view ? {} : { view: false }) });
    seat.room.reconnection.enabled = false;
    seat.room.onLeave((code) => { seat.closedWith = code; });
    seat.room.onMessage('*', (_type, message) => {
      const received = message as ServerMsg;
      if (received.op === 'report') seat.reported = true;
      if (received.op !== 'view') return;
      const next = applyView(seat.views.get(received.team), received);
      if (!next) { seat.gaps++; return; }
      seat.views.set(received.team, next);
      const view = next.view as { tick?: unknown };
      if (typeof view.tick === 'number') seat.ticks.push(view.tick);
    });
    return seat;
  }

  get tick(): number { return this.ticks.at(-1) ?? 0; }
  get open(): boolean { return this.closedWith === undefined; }
}

interface Ticket { roomId: string; tickets: { role: string; token: string }[] }

/** A human's match: tickets from its lobby, every seat joined (view seat last), recoverable like the web client. */
export class HumanMatch {
  readonly member: LobbyMember;
  seats: Seat[] = [];
  roomId = '';
  /** Renewals answered (`/renew` through the balancer, like the web client's periodic renewal) and refused. */
  renewals = { ok: 0, failed: 0 };
  #renewal: NodeJS.Timeout | undefined;

  constructor(member: LobbyMember) { this.member = member; }

  /**
   * Tickets, every seat joined, and renewals started. `wait`: until the view shows a running tick (a match with other
   * humans runs only once they have all joined, so their joins come first).
   */
  async enter(timings?: { ticket?: number[]; join?: number[] }, wait = true): Promise<void> {
    const ticket = await this.member.route<Ticket>('ticket', {}, timings?.ticket);
    this.roomId = ticket.roomId;
    const started = performance.now();
    const seats: Seat[] = [];
    for (let i = ticket.tickets.length - 1; i >= 0; i--) seats.push(await Seat.open(this.member.base, ticket.roomId, ticket.tickets[i]!.token, i === 0));
    this.seats = seats;
    clearInterval(this.#renewal);
    this.#renewal = setInterval(() => {
      void this.member.route('renew').then(() => { this.renewals.ok++; }, () => { this.renewals.failed++; });
    }, SEAT_RENEWAL_MS);
    if (!wait) return;
    await until(() => this.view && this.view.tick > 0, 20_000, 'the first match view');
    timings?.join?.push(performance.now() - started);
  }

  get view(): Seat | undefined { return this.seats.at(-1); }
  get open(): boolean { return this.seats.length > 0 && this.seats.every((seat) => seat.open); }

  /** The web client's recovery: fresh tickets and new sockets; an unavailable server is retried for 20 s. */
  async recover(): Promise<number> {
    const started = performance.now();
    for (const seat of this.seats) void seat.room.leave(true).catch(() => {});
    const deadline = performance.now() + 20_000;
    for (;;) {
      try {
        await this.enter();
        return performance.now() - started;
      } catch (error) {
        if (performance.now() > deadline) throw error;
        await pause(1000);
      }
    }
  }

  async leave(): Promise<void> {
    clearInterval(this.#renewal);
    for (const seat of this.seats) await seat.room.leave(true).catch(() => {});
    await this.member.leave();
  }
}

/** A human vs bots lobby (Quick Play shape) that starts at once and hands its seats over. */
async function playMatch(base: string, rules: Record<string, unknown> = SHORT_MATCH, timings?: { create?: number[]; ticket?: number[]; join?: number[] }): Promise<HumanMatch> {
  const member = await LobbyMember.create(base, { ...DUEL, visibility: 'private', preset: 'play', autoStart: true, rules }, timings?.create);
  await member.attach();
  await until(() => member.phase() === 'started', 60_000, 'the lobby to start');
  const match = new HumanMatch(member);
  await match.enter(timings);
  return match;
}

/** Ticks keep advancing on every open view: the match runs. */
async function advancing(matches: readonly HumanMatch[], ms = 15_000): Promise<boolean> {
  const before = matches.map((match) => match.view?.tick ?? 0);
  await until(() => matches.every((match, i) => (match.view?.tick ?? 0) > before[i]!), ms, 'ticks to advance');
  return true;
}

// ------------------------------------------------------------------ scenarios

/** (a) Two humans create, join, ready and start one lobby with every request on a different node. */
export async function scenarioLobby(rig: Rig) {
  const base = rig.proxy.base;
  const timings = { create: [] as number[], join: [] as number[], connect: [] as number[], ticket: [] as number[], matchJoin: [] as number[] };
  const before = new Map(rig.proxy.http);
  const leader = await LobbyMember.create(base, { ...DUEL, visibility: 'public', preset: 'host', rules: SHORT_MATCH }, timings.create);
  await leader.attach(timings.connect);
  const guest = await LobbyMember.join(base, leader.code, { team: 'se' }, timings.join);
  await guest.attach(timings.connect);
  const listed = await call<{ lobbies: { code: string }[] }>(base, '/api/lobbies');
  await guest.command({ op: 'ready', ready: true });
  await until(() => leader.snapshots.at(-1)?.players.every((player) => player.ready || player.leader), 10_000, 'the guest to be ready');
  await leader.command({ op: 'start' });
  await until(() => leader.phase() === 'started' && guest.phase() === 'started', 60_000, 'the match to start');
  const matches = [new HumanMatch(leader), new HumanMatch(guest)];
  const joining = performance.now();
  for (const match of matches) await match.enter({ ticket: timings.ticket }, false);
  await until(() => matches.every((match) => (match.view?.tick ?? 0) > 0), 20_000, 'both humans to see the match run');
  timings.matchJoin.push(performance.now() - joining);
  await advancing(matches);
  const host = await rig.redis.hget('ac:cluster:rooms', matches[0]!.roomId);
  const spread = Object.fromEntries([...rig.proxy.http].map(([name, count]) => [name, count - (before.get(name) ?? 0)]));
  for (const match of matches) await match.leave();
  return {
    ok: matches[0]!.roomId === matches[1]!.roomId && listed.lobbies.some((lobby) => lobby.code === leader.code),
    listedInDirectory: listed.lobbies.some((lobby) => lobby.code === leader.code),
    sameMatch: matches[0]!.roomId === matches[1]!.roomId,
    hostNode: rig.nodes.find((node) => node.id === host)?.name ?? host,
    requestsPerNode: spread,
    latencyMs: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, summary(values)])),
  };
}

const CODE_POLICY = 'function think() { return []; }';

/**
 * (b) An MCP agent signs in with OAuth (DCR, PKCE, consent, token) and calls /mcp, every request through a different
 * node: it deploys a policy, readies for a lobby seat, plays the match, and a policy commander of the same profile
 * plays a second match.
 */
export async function scenarioAgent(rig: Rig) {
  const base = rig.proxy.base;
  const before = new Map(rig.proxy.mcp);
  const ip = freshIp();
  const profile = await call<{ id: string; secret: string }>(base, '/api/profile', { body: {}, ip });
  const owner = `Bearer ${profile.secret}`;
  const roster = await call<{ commanders: { id: string; name: string; token: string }[] }>(base, '/api/profile/commanders', {
    body: { name: 'Rig agent', kind: 'agent', roles: ['surface'], isolation: { independentSessions: false } }, authorization: owner, ip,
  });
  const agent = roster.commanders.find((commander) => commander.name === 'Rig agent')!;
  // OAuth through the balancer: registration, authorization, consent and token exchange each land on another node.
  const redirect = 'http://127.0.0.1:4545/callback';
  const client = await call<{ client_id: string }>(base, '/oauth/register', { body: { client_name: 'Rig harness', redirect_uris: [redirect] } });
  const verifier = randomBytes(32).toString('base64url');
  const authorize = await fetch(`${base}/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirect, resource: `${base}/mcp`,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  })}`, { redirect: 'manual', headers: { 'x-forwarded-for': ip } });
  const request = new URL(authorize.headers.get('location') ?? 'http://x/').searchParams.get('r');
  if (authorize.status !== 302 || !request) throw new Error(`authorize → ${authorize.status}`);
  const answer = await call<{ redirect: string }>(base, `/api/connect/${request}`, { body: { commander: agent.id, roles: ['surface'], approve: true }, authorization: owner, ip });
  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier, code: new URL(answer.redirect).searchParams.get('code')! }),
  });
  if (tokenResponse.status !== 200) throw new Error(`token → ${tokenResponse.status}`);
  const { access_token: accessToken } = await tokenResponse.json() as { access_token: string };
  const seat = await connectSeat({ url: `${base}/mcp`, token: accessToken });
  const timings: number[] = [];
  const tool = async (name: string, args: Record<string, unknown>) => {
    await pause(COMMANDER_CALL_GAP_MS);
    const started = performance.now();
    const result = await seat.call(name, args);
    timings.push(performance.now() - started);
    if (result.isError) throw new Error(`${name}: ${result.text}`);
    return result.structured as Record<string, unknown>;
  };
  try {
    const deployed = await tool('policy_deploy', { runtime: 'js', code: CODE_POLICY });
    // The owner seats the agent on nw surface (the other planes stay bots) and starts once it is ready.
    const lobby = await call<{ code: string }>(base, '/api/lobbies', { body: { ...DUEL, visibility: 'private', preset: 'play', rules: SHORT_MATCH }, authorization: owner, ip });
    const member = new LobbyMember(base, lobby.code, owner);
    await member.attach();
    await member.command({ op: 'assign', team: 'nw', roles: ['surface'], occupant: { kind: 'commander', ref: { id: agent.id, kind: 'agent' } } });
    await member.command({ op: 'assign', team: 'nw', roles: ['depths', 'sky', 'orbit'], occupant: { kind: 'bot', level: 'standard', options: {} } });
    const lobbyView = await tool('game_observe', { role: 'surface' });
    await tool('game_ready', { role: 'surface' });
    await until(() => member.snapshots.at(-1)?.seats.find((entry) => entry.team === 'nw' && entry.role === 'surface')?.ready === 'ready', 10_000, 'the agent seat to be ready');
    const waiting = tool('game_wait', { role: 'surface', seconds: 30 });
    await member.command({ op: 'start' });
    const entered = await waiting;
    const observed: number[] = [];
    let acted = 0;
    for (let i = 0; i < 5; i++) {
      const observation = (await tool('game_observe', { role: 'surface' })).observation;
      if (observation && typeof observation === 'object' && 'tick' in observation && typeof observation.tick === 'number') observed.push(observation.tick);
      const reply = await tool('game_act', { role: 'surface', intents: [{ kind: 'queue_add', item: 'tank' }] });
      if (Array.isArray(reply.acks)) acted += reply.acks.length;
      await pause(400);
    }
    const status = await tool('policy_status', { role: 'surface' });
    await member.leave();
    const spread = Object.fromEntries([...rig.proxy.mcp].map(([name, count]) => [name, count - (before.get(name) ?? 0)]));
    return {
      ok: deployed.ok === true && entered.phase === 'match' && observed.length > 1 && observed.at(-1)! > observed[0]! && acted > 0 && Object.values(spread).filter((n) => n > 0).length >= 2,
      deployedVersion: deployed.version,
      lobbyPhaseBeforeStart: lobbyView.phase,
      matchPhase: entered.phase,
      observedTicks: observed, intentsAcknowledged: acted,
      policy: status.policy ?? status,
      mcpPostsPerNode: spread,
      toolLatencyMs: summary(timings),
    };
  } finally {
    await seat.close().catch(() => {});
  }
}

/** First `observer` frame of the featured SSE stream at `url`; resolves its latency. */
async function featuredFrame(url: string, ip: string, ms = 60_000): Promise<{ status: number; firstFrameMs?: number }> {
  const started = performance.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    const response = await fetch(url, { headers: { 'x-forwarded-for': ip, accept: 'text/event-stream' }, signal: abort.signal });
    if (response.status !== 200 || !response.body) return { status: response.status };
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      if (/"frame":\{"sequence"/.test(buffer)) return { status: 200, firstFrameMs: performance.now() - started };
    }
    return { status: 200 };
  } catch {
    return { status: 0 };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** (c) Watch live through every node directly and through the balancer: one relay (the primary's), frames everywhere. */
export async function scenarioFeatured(rig: Rig) {
  await until(async () => (await call<{ ready: boolean }>(rig.proxy.base, '/api/featured')).ready, 90_000, 'the featured relay');
  const edges = [...rig.live().map((node) => ({ via: node.name, base: node.base })), { via: 'balancer', base: rig.proxy.base }];
  const results = await Promise.all(edges.map(async ({ via, base }) => ({ via, ...await featuredFrame(`${base}/api/featured/stream?team=all`, freshIp()) })));
  return { ok: results.every((result) => result.status === 200 && result.firstFrameMs !== undefined), streams: results.map(({ via, status, firstFrameMs }) => ({ via, status, firstFrameMs: firstFrameMs === undefined ? undefined : Math.round(firstFrameMs) })) };
}

/** Read the featured SSE stream at `url` until `done` accepts an event (or `ms` pass); returns every event read. */
async function featuredEvents(url: string, done: (event: string, data: Record<string, unknown>) => boolean, ms: number): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  try {
    const response = await fetch(url, { headers: { 'x-forwarded-for': freshIp(), accept: 'text/event-stream' }, signal: abort.signal });
    if (response.status !== 200 || !response.body) return events;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const [head, body] = buffer.slice(0, cut).split('\n');
        buffer = buffer.slice(cut + 2);
        const entry = { event: head!.slice('event: '.length), data: JSON.parse(body!.slice('data: '.length)) as Record<string, unknown> };
        events.push(entry);
        if (done(entry.event, entry.data)) return events;
      }
    }
    return events;
  } catch {
    return events;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/** The public observer delay (server `PUBLIC_OBSERVER_DELAY_MS`): a public game's first released frame comes this late. */
const PUBLIC_DELAY_MS = 180_000;
/** Long enough to outlast the public delay twice over; idle bots so nothing ends it early. */
const PUBLIC_MATCH = { spire: { timeCap: 600 } };

/**
 * (h) Watch live features a public game running on a node that is not the primary: the primary's relay finds it
 * through the lobbies it coordinates, follows its delayed streams over the hosting node's internal listener and cuts
 * over at the first released frame; viewers read it through the balancer. After a primary handover (drain), the
 * successor's relay picks the same game up again for reconnecting viewers.
 */
export async function scenarioFeaturedPublic(rig: Rig) {
  const base = rig.proxy.base;
  const primary = (await rig.primary())!;
  // Placement follows load (ties stay local to the primary): open public games until one runs on another node.
  const opened: HumanMatch[] = [];
  let game: HumanMatch | undefined;
  let hostedOn: string | null = null;
  for (let i = 0; i < 6 && !game; i++) {
    const member = await LobbyMember.create(base, { ...DUEL, visibility: 'public', preset: 'play', autoStart: true, botLevel: 'idle', rules: PUBLIC_MATCH });
    await member.attach();
    await until(() => member.phase() === 'started', 60_000, 'the public lobby to start');
    const match = new HumanMatch(member);
    await match.enter();
    hostedOn = await rig.redis.hget('ac:cluster:rooms', match.roomId);
    if (hostedOn && hostedOn !== primary.id) game = match;
    else opened.push(match);
  }
  for (const match of opened) await match.leave();
  if (!game) return { ok: false, reason: 'no public game landed off the primary' };
  const roomId = game.roomId;
  const startedAt = performance.now();
  try {
    // Announced through the balancer while its delayed stream warms up; the bot playlist stays on air meanwhile.
    await until(async () => (await call<{ upcoming?: { roomId: string } }>(base, '/api/featured')).upcoming?.roomId === roomId, 30_000, 'the public game to be announced');
    // The relay cuts over at the public game's first released frame, one public delay after it started.
    const live = (event: string, data: Record<string, unknown>) => event === 'observer' && data.state === 'ready';
    const cut = await featuredEvents(`${base}/api/featured/stream?team=all`, (event, data) => event === 'match' && data.roomId === roomId && data.public === true, PUBLIC_DELAY_MS + 90_000);
    const cutOverMs = performance.now() - startedAt;
    const viewing = await featuredEvents(`${base}/api/featured/stream?team=all`, live, 30_000);
    const frame = viewing.at(-1)?.data.frame as { releaseAt: number; recordedAt: number } | undefined;
    const announced = viewing.find((entry) => entry.event === 'match')?.data;
    // Hand the primary role on (a deploy's drain), with a fresh node in its place: viewers reconnect to the successor.
    rig.drain(primary);
    await rig.startNode();
    const successor = await rig.converged();
    const reconnecting = performance.now();
    const again = await until(async () => {
      const events = await featuredEvents(`${base}/api/featured/stream?team=all`, live, 30_000);
      return events.find((entry) => entry.event === 'match')?.data.roomId === roomId && events.at(-1)?.event === 'observer' ? events : undefined;
    }, 90_000, 'the successor to feature the public game');
    const pickupMs = performance.now() - reconnecting;
    const host = rig.nodes.find((node) => node.id === hostedOn)?.name;
    return {
      ok: cut.length > 0 && announced?.roomId === roomId && announced.public === true && announced.delayMs === PUBLIC_DELAY_MS &&
        frame !== undefined && frame.releaseAt - frame.recordedAt >= PUBLIC_DELAY_MS && successor.id !== primary.id && again.length > 0,
      hostedOn: host, primary: primary.name, successor: successor.name, label: announced?.label,
      cutOverMs: Math.round(cutOverMs), releaseDelayMs: frame ? frame.releaseAt - frame.recordedAt : undefined, pickupMs: Math.round(pickupMs),
    };
  } finally {
    await game.leave();
  }
}

/**
 * (d) kill -9 the primary mid-match: matches on the other nodes keep running and are reachable (a client whose
 * socket ran through the dead node recovers with fresh tickets), a new primary takes the lease, and the lobby
 * directory and the checkpointed lobbies come back.
 */
export async function scenarioPrimaryCrash(rig: Rig) {
  const base = rig.proxy.base;
  const primary = (await rig.primary())!;
  // Enough matches that some run on each node (placement follows load, ties local to the primary).
  const matches: HumanMatch[] = [];
  for (let i = 0; i < 6; i++) matches.push(await playMatch(base, { spire: { timeCap: 600 } }));
  const hosts = new Map<HumanMatch, string>();
  for (const match of matches) hosts.set(match, (await rig.redis.hget('ac:cluster:rooms', match.roomId))!);
  // A public lobby waiting for players, and a private one with its leader attached: both must survive.
  const waiting = await LobbyMember.create(base, { ...DUEL, visibility: 'public', preset: 'host', rules: SHORT_MATCH });
  await waiting.attach();
  await pause(1500);
  const killedAt = performance.now();
  await rig.kill(primary);
  const successor = await until(async () => { const next = await rig.primary(); return next && next !== primary ? next : undefined; }, 30_000, 'a new primary');
  const failoverMs = performance.now() - killedAt;
  const directory = await until(async () => {
    try { return (await call<{ lobbies: { code: string }[] }>(base, '/api/lobbies')).lobbies.some((lobby) => lobby.code === waiting.code) ? performance.now() - killedAt : undefined; }
    catch { return undefined; }
  }, 30_000, 'the directory to list the surviving lobby');
  const surviving = matches.filter((match) => hosts.get(match) !== primary.id);
  const lost = matches.filter((match) => hosts.get(match) === primary.id);
  // Every surviving match: still running; a dropped client (its socket ran through the dead node) recovers.
  const reconnects: number[] = [];
  for (const match of surviving) if (!match.open) reconnects.push(await match.recover());
  // Even a client that never dropped can always get fresh tickets from the new primary.
  const fresh = surviving.find((match) => match.open);
  if (fresh) reconnects.push(await fresh.recover());
  await advancing(surviving, 20_000);
  // The waiting lobby's leader reconnects its socket through a fresh admission.
  await waiting.attach();
  const restored = waiting.phase();
  for (const match of [...surviving, ...lost]) await match.leave().catch(() => {});
  await waiting.leave();
  await rig.startNode();
  await rig.converged();
  return {
    ok: surviving.length > 0 && restored === 'waiting',
    killed: primary.name, successor: successor.name,
    failoverMs: Math.round(failoverMs), directoryBackMs: Math.round(directory),
    matchesOnSurvivingNodes: surviving.length, lostOnSurvivingNodes: 0,
    matchesOnKilledNode: lost.length,
    reconnectMs: summary(reconnects), restoredLobbyPhase: restored,
  };
}

/**
 * (e) Rolling restart of every node, one at a time, under load: each step starts a replacement node, then drains an
 * old one (out of rotation, SIGTERM). New matches keep being created; every match must end with its own outcome,
 * and a pregame lobby created before the rollout is still there after it.
 */
export async function scenarioRolling(rig: Rig) {
  const base = rig.proxy.base;
  const waiting = await LobbyMember.create(base, { ...DUEL, visibility: 'public', preset: 'host', rules: SHORT_MATCH });
  await waiting.attach();
  const started: HumanMatch[] = [];
  const errors: string[] = [];
  const createMs: number[] = [];
  let load = true;
  const loader = (async () => {
    while (load) {
      try { started.push(await playMatch(base, SHORT_MATCH, { create: createMs })); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      await pause(2000);
    }
  })();
  const old = rig.live();
  const handovers: number[] = [];
  for (const node of old) {
    await rig.startNode();
    const wasPrimary = (await rig.primary()) === node;
    const at = performance.now();
    rig.drain(node);
    if (wasPrimary) {
      await until(async () => { const next = await rig.primary(); return next && next !== node; }, 30_000, 'the handover');
      handovers.push(performance.now() - at);
    }
    await until(async () => (await fetch(`${base}/api/maps`, { headers: { 'x-forwarded-for': freshIp() } })).status === 200, 30_000, 'the coordinator');
    await pause(5000);
  }
  load = false;
  await loader;
  // Every match plays out on whichever node it started (draining nodes finish theirs), then the old nodes exit.
  const outcomes = await Promise.all(started.map(async (match) => {
    try { await until(() => match.view?.reported || !match.open, 180_000, 'the match result'); }
    catch { return 'running'; }
    return match.view?.reported ? 'result' : `closed ${match.view?.closedWith}`;
  }));
  const exits = await Promise.all(old.map((node) => node.exited));
  await waiting.attach();
  const lobbyPhase = waiting.phase();
  await waiting.leave();
  for (const match of started) await match.leave().catch(() => {});
  const interrupted = outcomes.filter((outcome) => outcome !== 'result').length;
  return {
    ok: interrupted === 0 && errors.length === 0 && lobbyPhase === 'waiting' && exits.every((code) => code === 0),
    replacedNodes: old.map((node) => node.name), oldNodeExitCodes: exits,
    matchesStarted: started.length, interrupted, creationErrors: errors.slice(0, 10),
    handoverMs: summary(handovers), lobbyCreateMs: summary(createMs), pregameLobbyAfter: lobbyPhase, pregameRejoins: waiting.rejoins,
    renewals: started.reduce((sum, match) => ({ ok: sum.ok + match.renewals.ok, failed: sum.failed + match.renewals.failed }), { ok: 0, failed: 0 }),
  };
}

/** (f) A small load run with the scaling tool, through the balancer (players: one human seat per match). */
export async function scenarioLoad(rig: Rig, args: string[] = ['--players', '--levels', '3', '--duration', '30', '--ramp', '6', '--measurement-only', '--request-timeout', '60']) {
  const child = spawn(process.execPath, [LOADTEST_MAIN, '--url', rig.proxy.base, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  const events: Record<string, unknown>[] = output.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  const stage = events.find((event) => event.event === 'stage');
  return {
    ok: code === 0,
    exitCode: code,
    stage: stage && {
      slots: stage.slots, created: stage.created, failed: stage.failed, verdict: stage.verdict, latencyMs: stage.latencyMs,
      players: stage.players, observedSimulationHz: stage.observedSimulationHz, server: stage.server, errors: stage.errors,
    },
  };
}

/**
 * (g) Limits hold across nodes: MATCHES_PER_IP for one address whose requests land on every node; admission against
 * the whole cluster's capacity (each node's workers, the featured duel included: one four-army match of 2.4 units fits
 * a four-unit node, a second does not), so four-army matches fill every node once and the next waits in the one
 * shared queue, no worker overbooked; and FEATURED_VIEWERS_PER_IP.
 */
export async function scenarioLimits(rig: Rig) {
  const base = rig.proxy.base;
  const perIp = Number(NODE_ENV.MATCHES_PER_IP);
  const ip = freshIp();
  const statuses: number[] = [];
  const created: LobbyMember[] = [];
  for (let i = 0; i <= perIp; i++) {
    const response = await fetch(`${base}/api/lobbies`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ ...DUEL, visibility: 'private', preset: 'host' }) });
    statuses.push(response.status);
    if (response.status === 200) {
      const body: { code: string; visitorToken: string } = await response.json();
      created.push(new LobbyMember(base, body.code, `Visitor ${body.visitorToken}`));
    }
  }
  for (const member of created) await member.leave();
  // Admission: four-army matches until no node has room; the next one queues instead of overbooking.
  type Workers = { workers: { node: string; active: number; capacity: number }[] };
  const units = async () => (await call<Workers>(base, '/api/capacity')).workers.reduce((sum, worker) => sum + worker.active, 0);
  await until(async () => await units() <= 1, 120_000, 'earlier matches to end');
  const ceiling = rig.live().length + 1;
  const matches: HumanMatch[] = [];
  let queued: LobbyMember | undefined;
  for (let i = 0; i < ceiling && !queued; i++) {
    const member = await LobbyMember.create(base, { ...FFA, visibility: 'private', preset: 'play', autoStart: true, rules: { spire: { timeCap: 600 } } });
    await member.attach();
    const state = await until(() => member.phase() === 'started' ? 'started' : member.snapshots.some((snapshot) => snapshot.queuePosition !== undefined) ? 'queued' : undefined, 60_000, 'a start or a queue place');
    if (state === 'queued') { queued = member; break; }
    const match = new HumanMatch(member);
    await match.enter();
    matches.push(match);
  }
  const workers = (await call<Workers>(base, '/api/capacity')).workers;
  const position = queued?.snapshots.findLast((snapshot) => snapshot.queuePosition !== undefined)?.queuePosition;
  const hosts = await Promise.all(matches.map((match) => rig.redis.hget('ac:cluster:rooms', match.roomId)));
  const perNode = Object.fromEntries(rig.live().map((node) => [node.name, hosts.filter((host) => host === node.id).length]));
  const overbooked = workers.filter((worker) => worker.active > worker.capacity).length;
  await queued?.leave();
  for (const match of matches) await match.leave();
  // Featured viewers: one address, streams opened through different nodes.
  const viewerIp = freshIp();
  const limit = Number(NODE_ENV.FEATURED_VIEWERS_PER_IP);
  const aborts: AbortController[] = [];
  const viewerStatuses: number[] = [];
  for (let i = 0; i <= limit; i++) {
    const abort = new AbortController();
    aborts.push(abort);
    const response = await fetch(`${base}/api/featured/stream?team=all`, { headers: { 'x-forwarded-for': viewerIp }, signal: abort.signal });
    viewerStatuses.push(response.status);
  }
  for (const abort of aborts) abort.abort();
  return {
    ok: statuses.slice(0, perIp).every((status) => status === 200) && statuses[perIp] === 429 && matches.length === rig.live().length &&
      Object.values(perNode).every((count) => count === 1) && position === 1 && overbooked === 0 &&
      viewerStatuses.slice(0, limit).every((status) => status === 200) && viewerStatuses[limit] === 429,
    lobbyCreates: statuses, matchesPerIp: perIp,
    admission: {
      fourArmyMatchesAdmitted: matches.length, matchesPerNode: perNode, queuePosition: position, overbookedWorkers: overbooked,
      workerUnits: workers.map((worker) => `${worker.active}/${worker.capacity}`),
    },
    featuredViewers: viewerStatuses, featuredViewersPerIp: limit,
  };
}

export const SCENARIOS = { a: scenarioLobby, b: scenarioAgent, c: scenarioFeatured, d: scenarioPrimaryCrash, e: scenarioRolling, f: scenarioLoad, g: scenarioLimits, h: scenarioFeaturedPublic } as const;

// ------------------------------------------------------------------ CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: {
    // Limits first: they count worker units on a quiet cluster.
    nodes: { type: 'string', default: '3' }, scenarios: { type: 'string', default: 'g,a,b,c,f,d,e,h' }, out: { type: 'string' },
    'redis-url': { type: 'string' }, 'database-url': { type: 'string' }, 'pg-bin': { type: 'string' }, memory: { type: 'boolean', default: false },
  } });
  const dir = values.out ?? mkdtempSync(join(fileURLToPath(new URL('../../../tmp/', import.meta.url)), 'cluster-rig-'));
  const rig = await Rig.start({
    nodes: Number(values.nodes), dir, memory: values.memory,
    ...(values['redis-url'] ? { redisUrl: values['redis-url'] } : {}), ...(values['database-url'] ? { databaseUrl: values['database-url'] } : {}),
    ...(values['pg-bin'] ? { pgBin: values['pg-bin'] } : {}), ...(process.env.RIG_CPUS !== undefined ? { cpus: process.env.RIG_CPUS } : {}),
  });
  const report: Record<string, unknown> = { nodes: rig.nodes.map((node) => node.name), store: rig.databaseUrl ? 'postgres' : 'memory' };
  let failed = false;
  try {
    for (const key of values.scenarios!.split(',') as (keyof typeof SCENARIOS)[]) {
      const started = performance.now();
      try {
        const result = await SCENARIOS[key](rig);
        report[key] = { ...result, seconds: Math.round((performance.now() - started) / 100) / 10 };
        failed ||= !result.ok;
      } catch (error) {
        report[key] = { ok: false, error: error instanceof Error ? error.message : String(error) };
        failed = true;
      }
      console.error(`scenario ${key}: ${JSON.stringify(report[key])}`);
    }
  } finally {
    for (const node of rig.nodes) writeFileSync(join(dir, `${node.name}.log`), node.output());
    await rig.close();
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
}
