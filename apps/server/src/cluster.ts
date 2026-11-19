/**
 * Cluster mode (REDIS_URL): one primary, elected with a Redis lease, runs the coordinator (lobbies, admission, the
 * canonical host, the featured match), the single writer of every piece of coordination state; every node hosts
 * simulation workers and is an edge for any request. README “Cluster mode” has the state-placement table.
 *
 * A process is primary at most once: it builds its coordinator from the durable stores when it first takes the lease
 * (so it never serves a snapshot older than the previous primary's last write) and retires it for good when it hands
 * the lease on (drain) or loses it. Lobbies survive the change through fenced Redis checkpoints; their matches stay
 * where they run, reachable by room id on whichever node hosts them.
 *
 * Redis keys: `ac:cluster:primary` (lease), `ac:cluster:nodes` (registered node ids), `ac:cluster:node:<id>`
 * (heartbeat JSON with TTL), `ac:cluster:rooms` (hosted roomId -> node id), `ac:cluster:node:<id>:rooms` (that node's
 * index entries, for cleanup), `ac:cluster:token:<sha256>` (seat ticket -> roomId routing hint, TTL),
 * `ac:lobby:<code>` / `ac:visitor:<sha256>` (lobby checkpoints and visitor credentials, written only by the lease
 * holder, TTL). Channel `ac:cluster:events`: room state/release events and lease changes. Colyseus' RedisPresence /
 * RedisDriver keep their own keys.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Agent, createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { matchMaker } from '@colyseus/core';
import { RedisDriver } from '@colyseus/redis-driver';
import { RedisPresence } from '@colyseus/redis-presence';
import { Redis } from 'ioredis';
import { TOKEN_RE } from 'playerthree';
import type { SeatTicket } from 'playerthree/host';
import type { ObserverFrame, ObserverGrant } from 'playerthree/protocol';
import { observeMatch, type FeaturedPerspective } from './featured.ts';
import type { ArmyId, Outcome } from '@agent-command/game';
import type { MatchCloseReason } from '@agent-command/game/lobby';
import { addLoad, matchLoad } from './admission.ts';
import type { ClusterConfig, ServerConfig } from './config.ts';
import { clientIp, forwardedClient, HttpError, pipeUpgrade, readJson, sendJson, trustForwardedClient } from './http.ts';
import type { LobbyMatch, LobbyMatchSnapshot, LobbyMatchState } from './lobby-match.ts';
import type { SimulationLobbyRequest, SimulationPool, SimulationWorkerStats } from './simulation-pool.ts';
import { hasSimulationHeadroom, simulationLoadScore } from './simulation-metrics.ts';

const LEASE_KEY = 'ac:cluster:primary';
const NODES_KEY = 'ac:cluster:nodes';
const ROOMS_KEY = 'ac:cluster:rooms';
const EVENTS_CHANNEL = 'ac:cluster:events';
const nodeKey = (id: string) => `ac:cluster:node:${id}`;
const nodeRoomsKey = (id: string) => `ac:cluster:node:${id}:rooms`;
const tokenKey = (digest: string) => `ac:cluster:token:${digest}`;
const LOBBY_PREFIX = 'ac:lobby:';
const VISITOR_PREFIX = 'ac:visitor:';
const SECRET_HEADER = 'x-ac-cluster-secret';
/** Set on a 503 from a node that is not (or no longer) the primary: the forwarding edge retries with the next one. */
const RETRY_HEADER = 'x-ac-cluster-retry';
const TICK_MS = 1000;
/** Heartbeats and the lease outlive several missed ticks; a dead node's rooms are unrouted after this. */
const NODE_TTL_MS = 5000;
const LEASE_MS = 5000;
/** The primary stops acting as one this long before its lease could expire in Redis (clock-rate slack). */
const LEASE_MARGIN_MS = 1000;
/**
 * How long an edge holds a coordination request while no primary is known: a crashed primary's lease and heartbeat
 * expire (5 s each), a peer takes the lease at its next tick (1 s) and builds its coordinator from the stores.
 */
export const FAILOVER_WAIT_MS = 15_000;
/** How often a waiting edge re-checks for a primary between lease events. */
const PRIMARY_POLL_MS = 100;
const RPC_TIMEOUT_MS = 30_000;
const RPC_BODY_BYTES = 256 * 1024;
/** Coordination bodies up to this size are buffered at the edge so a failover can replay them (the MCP message cap). */
const REPLAY_BODY_BYTES = 1024 * 1024;
/** Main-process lobby matches have no worker events: their snapshots are compared and published this often. */
const CANONICAL_POLL_MS = 1000;
// A missing key (Redis restarted, or the lease lapsed with nobody taking it) is re-taken in place, so a Redis restart
// never demotes a working primary; a key held by another node is never touched.
const RENEW = `local v = redis.call('get', KEYS[1])
if v == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end
if v == false then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/** Checkpoint writes are fenced by the lease: a retired or stalled former primary can never overwrite its successor. */
const FENCED_SET = `if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('set', KEYS[2], ARGV[2], 'PX', ARGV[3])
return 1`;
const FENCED_DEL = `if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('del', KEYS[2])
return 1`;
const ROOM_PATH = /^\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)$/;
const JOIN_PATH = /^\/matchmake\/joinById\/([A-Za-z0-9_-]{1,64})$/;

/** One node's advertised state, rewritten every tick under a TTL. */
interface Heartbeat {
  id: string;
  address: string;
  draining: boolean;
  /** This node's pool can take a placement now (its own lag/CPU/slot rules). */
  canCreate: boolean;
  /** Least load score among its available workers; null when none is available. */
  score: number | null;
  /** Free worker capacity units (duel = 1, `matchLoad` per match) across healthy workers. */
  free: number;
  capacity: number;
  /** Capacity units in use (load-weighted, like `capacity`). */
  active: number;
  matchesPerWorker: number;
  workers: SimulationWorkerStats[];
}

interface Peer extends Heartbeat {
  /** Local receive time of this heartbeat's content, for counting placements it cannot include yet. */
  seenAt: number;
  /** The heartbeat as stored; unchanged content keeps its first `seenAt`. */
  raw: string;
}

type RoomMethod = 'start' | 'close' | 'mintHumanToken' | 'renewHumanToken' | 'mintObserverToken' | 'mintSpectatorToken' | 'assign' | 'revokeToken' | 'revokeSeat' | 'setHumanReady' | 'end' | 'forfeit' | 'outcome';
const ROOM_METHODS: readonly RoomMethod[] = ['start', 'close', 'mintHumanToken', 'renewHumanToken', 'mintObserverToken', 'mintSpectatorToken', 'assign', 'revokeToken', 'revokeSeat', 'setHumanReady', 'end', 'forfeit', 'outcome'];

/** Coordinator -> hosting node calls over `/_cluster/sim` on the internal listener. */
type ClusterCall =
  | { op: 'createLobby'; request: SimulationLobbyRequest; ownerKey?: string }
  | { op: 'room'; roomId: string; method: RoomMethod; args: unknown[] }
  /** A room hosted here, for a coordinator that adopts its lobby: its current state, load and play owner. */
  | { op: 'snapshot'; roomId: string }
  | { op: 'abandonOwner'; ownerKey: string };
/** Coordinator -> hosting node: one perspective's delayed observer frames of a room hosted there, as NDJSON. */
interface ObserveCall { roomId: string; team: FeaturedPerspective; grant: ObserverGrant }
interface RoomReply { roomId?: string; value?: unknown; version: number; state: LobbyMatchSnapshot; load?: number; owner?: string }

/** Hosting node -> coordinator events, versioned per room so a late event never overwrites a newer reply. */
type RoomEvent =
  | { node: string; kind: 'state'; roomId: string; version: number; state: LobbyMatchSnapshot }
  | { node: string; kind: 'released'; roomId: string; durationMs: number };
/** Lease changes, so edges stop forwarding to a primary that hands over and find its successor without waiting a tick. */
type LeaseEvent = { node: string; kind: 'lease'; holder: string | null; handover?: boolean };
type ClusterEvent = RoomEvent | LeaseEvent;

export interface ClusterHandlers {
  /** The public listener's request handler, for authenticated forwarded requests. */
  request(req: IncomingMessage, res: ServerResponse): void;
  /** The public listener's upgrade dispatch, for authenticated forwarded upgrades. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** This process took the lease for the first (and only) time: build the coordinator from the durable stores. */
  promote(): void;
  /** The lease was lost without a handover (Redis unreachable or a stall past the lease): stop coordinating now. */
  demoted(): void;
}

export interface ClusterPoolOptions {
  onRelease(durationMs: number): void;
  onChange(): void;
}

/** A lobby checkpoint store (the coordinator's): written only while this node holds the lease. */
export interface LobbyCheckpoints {
  save(code: string, record: string, ttlMs: number): Promise<boolean>;
  remove(code: string): Promise<boolean>;
  saveVisitor(digest: string, record: string, ttlMs: number): Promise<boolean>;
  removeVisitor(digest: string): Promise<boolean>;
  load(): Promise<{ lobbies: string[]; visitors: { digest: string; record: string }[] }>;
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function snapshotOf(game: LobbyMatch): LobbyMatchSnapshot {
  return { readiness: game.match.readiness(), cards: game.match.cards(), over: game.match.over };
}

function target(address: string): { host: string; port: number } {
  const url = new URL(address);
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) };
}

/**
 * Coordination traffic: everything the coordinator owns (its routes, and public pages built from its state: the
 * ladder, commander cards and the sitemap). Static files, `/healthz`, benchmark pages and requests for rooms or
 * tickets a node hosts itself stay local (the pool answers those before this check).
 */
export function coordination(path: string): boolean {
  return path.startsWith('/api/') || path.startsWith('/matchmake/') || path === '/mcp' || path.startsWith('/oauth') ||
    path.startsWith('/.well-known/') || path === '/playerthree' || path.startsWith('/playerthree/') || path === '/dev' || path.startsWith('/dev/') ||
    path.startsWith('/arena/share/') || path === '/leaderboard' || path === '/leaderboard/' || path.startsWith('/commanders/') || path === '/sitemap.xml';
}

/** Read a request body of known length up to `limit` bytes; undefined when it is larger (streamed instead). */
async function replayable(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.headers['transfer-encoding'] !== undefined) return undefined;
  const length = req.headers['content-length'] === undefined ? 0 : Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 0 || length > REPLAY_BODY_BYTES) return undefined;
  if (length === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * A coordinator store whose `writes` pass only while this node holds the lease. A write issued during a stall waits
 * for the outcome (renewed: written, in order; retired: dropped), so a retired coordinator never overwrites its
 * successor's newer records and a live one never loses a write. Reads pass through.
 */
export function fenced<T extends object>(cluster: Cluster, store: T, writes: readonly (keyof T & string)[]): T {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (!(writes as readonly PropertyKey[]).includes(key)) return value.bind(target);
      return async (...args: unknown[]) => {
        if (await cluster.writable()) return await (value as (...args: unknown[]) => unknown).apply(target, args);
        console.error(`cluster: dropped a ${String(key)} write from a retired coordinator`);
      };
    },
  });
}

export class Cluster {
  readonly nodeId = randomBytes(12).toString('hex');
  readonly #config: ServerConfig;
  readonly #cluster: ClusterConfig;
  readonly #secret: Buffer;
  readonly #redis: Redis;
  readonly #subscriber: Redis;
  readonly #agent = new Agent({ keepAlive: true });
  readonly #internal: Server;
  readonly #peers = new Map<string, Peer>();
  readonly #sockets = new Set<Duplex>();
  /** Edges waiting for a primary, woken by lease events. */
  readonly #waiters = new Set<() => void>();
  #presence: RedisPresence | undefined;
  #driver: RedisDriver | undefined;
  #pool: ClusterPool | undefined;
  #handlers: ClusterHandlers | undefined;
  #primaryId: string | null = null;
  /** A primary that announced its handover: edges stop forwarding to it until its successor is known. */
  #handoverOf: string | null = null;
  #holding = false;
  #leaseUntil = 0;
  /** This process held the lease once and gave it up: it never coordinates again (its coordinator is retired). */
  #retired = false;
  #handingOver = false;
  #draining = false;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
  #redisDown = false;
  /** At the last registry read no other node was live: nobody else can hold or take the lease without Redis. */
  #alone = true;

  constructor(config: ServerConfig) {
    if (!config.cluster) throw new Error('cluster mode requires REDIS_URL');
    this.#config = config;
    this.#cluster = config.cluster;
    this.#secret = createHash('sha256').update(config.cluster.secret).digest();
    // Fail fast while Redis is unreachable: the lease is judged on the local clock, never on queued commands.
    this.#redis = new Redis(config.cluster.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    this.#subscriber = this.#redis.duplicate();
    // Connection errors carry host/port only; never the URL (credentials).
    for (const client of [this.#redis, this.#subscriber]) client.on('error', (error: Error & { code?: string }) => this.#redisError(error));
    this.#internal = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 });
    this.#internal.keepAliveTimeout = 60_000;
    this.#internal.on('request', (req, res) => this.#internalRequest(req, res));
    this.#internal.on('upgrade', (req, socket, head) => this.#internalUpgrade(req, socket, head));
  }

  /**
   * True while this node holds an unexpired lease and is not handing it over; checked per request, so demotion takes
   * effect at once. A primary that was the only live node keeps the role while Redis is unreachable: no other node
   * can take the lease without Redis, and a single-replica deployment must not lose lobbies to a Redis restart. With
   * peers, the strict lease rule holds (never two primaries).
   */
  get primary(): boolean {
    return !this.#handingOver && this.#leaseValid();
  }

  #leaseValid(): boolean {
    if (!this.#holding) return false;
    return performance.now() < this.#leaseUntil || (this.#redisDown && this.#alone);
  }

  /** This process gave the lease up (handover or loss): its coordinator, if any, is retired for good. */
  get retired(): boolean {
    return this.#retired;
  }

  /**
   * Resolves true once this node holds a current lease, false once it is retired: a coordinator write that arrives
   * during a stall waits for the outcome instead of racing a successor (or being dropped while still primary). A
   * handover still holds the lease while it flushes, so its writes pass; the successor loads only after the release.
   */
  async writable(): Promise<boolean> {
    for (;;) {
      if (this.#retired) return false;
      if (this.#leaseValid()) return true;
      const waited = Promise.withResolvers<void>();
      setTimeout(waited.resolve, PRIMARY_POLL_MS).unref();
      await waited.promise;
    }
  }

  /** `matchMaker.setup` arguments: shared presence/driver; rooms are always created in the calling process. */
  colyseus(): [RedisPresence, RedisDriver, undefined, () => Promise<string>] {
    this.#presence ??= new RedisPresence(this.#cluster.redisUrl);
    this.#driver ??= new RedisDriver(this.#cluster.redisUrl);
    return [this.#presence, this.#driver, undefined, async () => matchMaker.processId];
  }

  /** The cluster-aware pool app.ts uses in place of its local SimulationPool. */
  pool(local: SimulationPool, options: ClusterPoolOptions): ClusterPool {
    if (this.#pool) throw new Error('cluster pool already created');
    this.#pool = new ClusterPool(this, local, this.#config, options);
    return this.#pool;
  }

  /** Bind the internal listener, register, and take the lease if it is free, before the public listener opens. */
  async start(handlers: ClusterHandlers): Promise<void> {
    this.#handlers = handlers;
    const listening = Promise.withResolvers<void>();
    this.#internal.once('error', listening.reject);
    this.#internal.listen(this.#cluster.port, this.#cluster.host, () => {
      this.#internal.off('error', listening.reject);
      listening.resolve();
    });
    await listening.promise;
    await this.#redis.connect();
    await this.#subscriber.connect();
    this.#subscriber.on('message', (channel: string, message: string) => {
      if (channel !== EVENTS_CHANNEL) return;
      let event: ClusterEvent;
      try { event = JSON.parse(message) as ClusterEvent; } catch { return; /* A malformed event is dropped. */ }
      if (event.kind === 'lease') this.#leaseEvent(event);
      else this.#pool?.event(event);
    });
    await this.#subscriber.subscribe(EVENTS_CHANNEL);
    await this.#tick();
    this.#timer = setInterval(() => this.#schedule(), TICK_MS);
    this.#timer.unref();
    const replica = process.env.RAILWAY_REPLICA_ID ? ` (replica ${process.env.RAILWAY_REPLICA_ID})` : '';
    console.log(`cluster: node ${this.nodeId} at ${this.#cluster.address}${replica}${this.#holding ? ' (primary)' : ''}`);
  }

  /** Stop taking placements and never take the lease again (a draining node is on its way out). */
  beginDrain(): void {
    this.#draining = true;
  }

  /**
   * Hand the primary role on: edges stop forwarding here at once (they hold coordination requests for the
   * successor), `retire` settles this node's coordinator (in-flight mutations, final lobby checkpoint, store flush)
   * while the lease still fences it, then the lease is released and announced so a peer takes it within a moment.
   * This node's running matches finish here, reachable by room id; their lobbies move to the successor.
   */
  async handover(retire: () => Promise<void>): Promise<void> {
    this.#draining = true;
    if (!this.#holding) {
      this.#retired = true;
      return;
    }
    this.#handingOver = true;
    this.publish({ node: this.nodeId, kind: 'lease', holder: this.nodeId, handover: true });
    try { await retire(); } catch (error) { console.error('cluster: coordinator retirement failed', error); }
    this.#holding = false;
    this.#retired = true;
    this.#handingOver = false;
    await this.#redis.eval(RELEASE, 1, LEASE_KEY, this.nodeId).catch(() => { /* Unreachable Redis: the lease expires. */ });
    this.publish({ node: this.nodeId, kind: 'lease', holder: null });
    console.log(`cluster: node ${this.nodeId} handed the primary role on`);
  }

  /** Deregister (heartbeat, node entry, index entries), release the lease, and close every cluster connection. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#ticking;
    // Never started (listen failed earlier): nothing is registered, so open no connection just to close it.
    if (this.#handlers) {
      try {
        const rooms = await this.#redis.smembers(nodeRoomsKey(this.nodeId));
        const multi = this.#redis.multi().del(nodeKey(this.nodeId)).srem(NODES_KEY, this.nodeId).del(nodeRoomsKey(this.nodeId));
        if (rooms.length) multi.hdel(ROOMS_KEY, ...rooms);
        await multi.exec();
        if (this.#holding) {
          await this.#redis.eval(RELEASE, 1, LEASE_KEY, this.nodeId);
          this.publish({ node: this.nodeId, kind: 'lease', holder: null });
        }
      } catch { /* Redis unreachable: the TTLs expire the heartbeat and lease; the next primary cleans the index. */ }
    }
    this.#holding = false;
    this.#retired = true;
    for (const wake of this.#waiters) wake();
    for (const socket of this.#sockets) socket.destroy();
    this.#presence?.shutdown();
    await this.#driver?.shutdown();
    this.#subscriber.disconnect();
    this.#redis.disconnect();
    this.#agent.destroy();
    const closed = Promise.withResolvers<void>();
    this.#internal.close(() => closed.resolve());
    this.#internal.closeAllConnections();
    await closed.promise;
  }

  /** Transport filter: only rooms of this process's matchMaker (or none named) upgrade here; the rest are proxied. */
  hostsUpgrade(req: IncomingMessage): boolean {
    const roomId = ROOM_PATH.exec(new URL(req.url ?? '/', 'http://localhost').pathname)?.[1];
    return roomId === undefined || matchMaker.getLocalRoomById(roomId) !== undefined;
  }

  /** Proxy a WebSocket upgrade for a room this process does not host: to its hosting node, else to the primary. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const roomId = ROOM_PATH.exec(new URL(req.url ?? '/', 'http://localhost').pathname)?.[1];
    void (async () => {
      // A forwarded upgrade that is not local either has nowhere better to go: never bounce it on.
      if (!roomId || forwardedClient(req) !== undefined) { socket.destroy(); return; }
      const node = await this.owner(roomId);
      // Unindexed rooms are the coordinator's own (pregame lobbies, the directory): wait out a failover for them.
      const address = node ? (node === this.nodeId ? undefined : this.#peers.get(node)?.address) : this.primary ? undefined : (await this.#awaitPrimary(performance.now() + FAILOVER_WAIT_MS))?.address;
      if (!address || socket.destroyed) { socket.destroy(); return; }
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
      pipeUpgrade(req, socket, head, target(address), { ...req.headers, 'x-forwarded-for': clientIp(req, this.#config), [SECRET_HEADER]: this.#cluster.secret });
    })().catch(() => socket.destroy());
  }

  /**
   * Coordination requests on a node that is not the primary go to the primary; returns true when answered. During a
   * failover or handover the edge holds the request (up to FAILOVER_WAIT_MS) and replays it to the successor.
   */
  async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (this.primary || !coordination(path)) return false;
    // Forwarded here because this node was primary a moment ago: the forwarding edge retries with the successor.
    if (forwardedClient(req) !== undefined) {
      sendJson(res, 503, { error: 'cluster_unavailable' }, { 'Retry-After': '1', [RETRY_HEADER]: '1' });
      return true;
    }
    const body = await replayable(req);
    const deadline = performance.now() + FAILOVER_WAIT_MS;
    let refused: string | undefined;
    for (;;) {
      const primary = await this.#awaitPrimary(deadline, refused);
      if (res.destroyed) return true;
      if (!primary) {
        sendJson(res, 503, { error: 'cluster_unavailable' }, { 'Retry-After': '1' });
        return true;
      }
      if (await this.#forwardOnce(primary.address, req, res, body) === 'done') return true;
      refused = primary.id;
    }
  }

  /** Stream a request to a specific node's internal listener and its response back (SSE included); one attempt. */
  forward(address: string, req: IncomingMessage, res: ServerResponse): void {
    void this.#forwardOnce(address, req, res, undefined);
  }

  /**
   * One forwarding attempt. With a buffered `body`, a refusal (connection failure before any response, or a 503 from
   * a node that is no longer primary) resolves 'retry' with nothing sent to the client; otherwise the response is
   * piped back and it resolves 'done'.
   */
  #forwardOnce(address: string, req: IncomingMessage, res: ServerResponse, body: Buffer | undefined): Promise<'done' | 'retry'> {
    const { host, port } = target(address);
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, 'x-forwarded-for': clientIp(req, this.#config), [SECRET_HEADER]: this.#cluster.secret };
    if (body) { headers['content-length'] = String(body.length); delete headers['transfer-encoding']; }
    const settled = Promise.withResolvers<'done' | 'retry'>();
    let answered = false;
    const upstream = httpRequest({ host, port, path: req.url, method: req.method, headers, agent: this.#agent }, (response) => {
      answered = true;
      if (body && response.statusCode === 503 && response.headers[RETRY_HEADER] === '1') {
        response.resume();
        settled.resolve('retry');
        return;
      }
      const { [RETRY_HEADER]: _retry, ...forwarded } = response.headers;
      res.writeHead(response.statusCode ?? 502, forwarded);
      response.pipe(res);
      response.on('error', () => res.destroy());
      settled.resolve('done');
    });
    upstream.on('error', () => {
      if (!answered && body && !res.headersSent && !res.destroyed) return settled.resolve('retry');
      if (res.headersSent) res.destroy();
      else sendJson(res, 502, { error: 'cluster_unavailable' });
      settled.resolve('done');
    });
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    if (body) upstream.end(body);
    else req.pipe(upstream);
    return settled.promise;
  }

  /**
   * Where a coordination request goes: the live primary (never one handing over or refusing), or this node's own
   * internal listener once it took the lease while the request waited. Waits up to `deadline`.
   */
  async #awaitPrimary(deadline: number, refused?: string): Promise<{ id: string; address: string } | undefined> {
    for (;;) {
      if (this.primary) return { id: this.nodeId, address: this.#cluster.address };
      const id = this.#primaryId;
      const peer = id && id !== this.nodeId && id !== this.#handoverOf && id !== refused ? this.#peers.get(id) : undefined;
      if (peer) return peer;
      const left = deadline - performance.now();
      if (left <= 0 || this.#closed) return undefined;
      const woken = Promise.withResolvers<void>();
      this.#waiters.add(woken.resolve);
      const timer = setTimeout(woken.resolve, Math.min(PRIMARY_POLL_MS, left));
      await woken.promise;
      clearTimeout(timer);
      this.#waiters.delete(woken.resolve);
      // A refusing node may still be named primary until its successor is announced: poll the lease meanwhile.
      if (refused !== undefined && this.#primaryId === refused) this.#primaryId = await this.#redis.get(LEASE_KEY).catch(() => this.#primaryId);
    }
  }

  /** Internal address of a live node, or undefined. */
  address(node: string): string | undefined {
    return this.#peers.get(node)?.address;
  }

  /** Live peer heartbeats, this node excluded. */
  peers(): Iterable<Peer> {
    return [...this.#peers.values()].filter((peer) => peer.id !== this.nodeId);
  }

  /** The live node hosting a room, if indexed. */
  async owner(roomId: string): Promise<string | undefined> {
    const node = await this.#redis.hget(ROOMS_KEY, roomId).catch(() => null);
    return node !== null && (node === this.nodeId || this.#peers.has(node)) ? node : undefined;
  }

  async index(roomId: string): Promise<void> {
    await this.#redis.multi().hset(ROOMS_KEY, roomId, this.nodeId).sadd(nodeRoomsKey(this.nodeId), roomId).exec();
  }

  unindex(roomId: string): void {
    void this.#redis.multi().hdel(ROOMS_KEY, roomId).srem(nodeRoomsKey(this.nodeId), roomId).exec().catch(() => {});
  }

  /** Route a seat ticket (by digest) to its room for `ttlMs`: a hint for edges, never an authorization. */
  indexToken(tokenDigest: string, roomId: string, ttlMs: number): void {
    void this.#redis.set(tokenKey(tokenDigest), roomId, 'PX', ttlMs).catch(() => {});
  }

  async tokenRoom(tokenDigest: string): Promise<string | undefined> {
    return await this.#redis.get(tokenKey(tokenDigest)).catch(() => null) ?? undefined;
  }

  /** The coordinator's lobby checkpoints, fenced by this node's lease. */
  checkpoints(): LobbyCheckpoints {
    const set = async (key: string, record: string, ttlMs: number) =>
      await this.#redis.eval(FENCED_SET, 2, LEASE_KEY, key, this.nodeId, record, String(Math.max(1, Math.ceil(ttlMs)))) === 1;
    const del = async (key: string) => await this.#redis.eval(FENCED_DEL, 2, LEASE_KEY, key, this.nodeId) === 1;
    const scan = async (prefix: string): Promise<{ key: string; value: string }[]> => {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await this.#redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      if (!keys.length) return [];
      const values = await this.#redis.mget(keys);
      return keys.flatMap((key, i) => values[i] ? [{ key, value: values[i]! }] : []);
    };
    return {
      save: (code, record, ttlMs) => set(`${LOBBY_PREFIX}${code}`, record, ttlMs),
      remove: (code) => del(`${LOBBY_PREFIX}${code}`),
      saveVisitor: (digestHex, record, ttlMs) => set(`${VISITOR_PREFIX}${digestHex}`, record, ttlMs),
      removeVisitor: (digestHex) => del(`${VISITOR_PREFIX}${digestHex}`),
      load: async () => ({
        lobbies: (await scan(LOBBY_PREFIX)).map(({ value }) => value),
        visitors: (await scan(VISITOR_PREFIX)).map(({ key, value }) => ({ digest: key.slice(VISITOR_PREFIX.length), record: value })),
      }),
    };
  }

  publish(event: ClusterEvent): void {
    void this.#redis.publish(EVENTS_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  async rpc(node: string, call: ClusterCall): Promise<RoomReply> {
    const address = this.address(node);
    if (!address) throw new HttpError(503, 'simulation_unavailable');
    let response: Response;
    try {
      response = await fetch(`${address}/_cluster/sim`, {
        method: 'POST', body: JSON.stringify(call), signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: this.#cluster.secret },
      });
    } catch {
      throw new HttpError(503, 'simulation_unavailable');
    }
    const body = await response.json().catch(() => ({})) as RoomReply & { error?: string };
    if (!response.ok) throw new HttpError(response.status, typeof body.error === 'string' ? body.error : 'simulation_unavailable');
    return body;
  }

  /**
   * Relay one perspective of a room another node hosts (the featured relay following a public game placed there):
   * `/_cluster/observe` on its internal listener streams the hosting node's released frames, one JSON line each.
   * Returns stop; a stream that fails (the node or room is gone) just ends, and the relay sees the game end.
   */
  observe(node: string | undefined, roomId: string, team: FeaturedPerspective, grant: ObserverGrant, listener: (frame: ObserverFrame) => void): () => void {
    let request: ClientRequest | undefined;
    let stopped = false;
    void (async () => {
      const host = node ?? await this.owner(roomId);
      const address = host ? this.address(host) : undefined;
      if (stopped || !address) return;
      const body = JSON.stringify({ roomId, team, grant } satisfies ObserveCall);
      request = httpRequest({
        ...target(address), path: '/_cluster/observe', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), [SECRET_HEADER]: this.#cluster.secret },
      }, (response) => {
        if (response.statusCode !== 200) { response.resume(); return; }
        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let cut: number;
          while ((cut = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 1);
            if (!stopped && line) listener(JSON.parse(line) as ObserverFrame);
          }
        });
        response.on('error', () => {});
      });
      request.on('error', () => {});
      request.end(body);
    })().catch(() => {});
    return () => { stopped = true; request?.destroy(); };
  }

  #authentic(req: IncomingMessage): boolean {
    const provided = req.headers[SECRET_HEADER];
    if (typeof provided !== 'string') return false;
    return timingSafeEqual(createHash('sha256').update(provided).digest(), this.#secret);
  }

  /** Marks an authenticated forwarded request with the edge's view of the client address, minus the secret. */
  #accept(req: IncomingMessage): void {
    delete req.headers[SECRET_HEADER];
    const xff = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((part) => part.trim()).filter(Boolean).pop();
    trustForwardedClient(req, ip ?? req.socket.remoteAddress ?? 'unknown');
  }

  #internalRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.#authentic(req)) {
      sendJson(res, 403, { error: 'forbidden' }, { Connection: 'close' });
      return;
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path.startsWith('/_cluster/')) {
      delete req.headers[SECRET_HEADER];
      void this.#rpc(req, res, path).catch((error: unknown) => {
        if (res.headersSent) return void res.destroy();
        sendJson(res, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.code : 'simulation_unavailable' });
      });
      return;
    }
    this.#accept(req);
    this.#handlers?.request(req, res);
  }

  #internalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.#authentic(req) || !this.#handlers) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    this.#accept(req);
    this.#handlers.upgrade(req, socket, head);
  }

  async #rpc(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== 'POST' || path !== '/_cluster/sim' && path !== '/_cluster/observe') return sendJson(res, 404, { error: 'not_found' });
    if (!this.#pool) throw new HttpError(503, 'simulation_unavailable');
    if (path === '/_cluster/observe') return this.#pool.serveObserve(await readJson(req, RPC_BODY_BYTES) as ObserveCall, res);
    const call = await readJson(req, RPC_BODY_BYTES) as ClusterCall;
    sendJson(res, 200, await this.#pool.serve(call) ?? {});
  }

  #redisError(error: Error & { code?: string }): void {
    if (this.#redisDown) return;
    this.#redisDown = true;
    console.error(`cluster: redis connection error (${error.code ?? 'error'}); primary role lapses with the lease`);
  }

  #leaseEvent(event: LeaseEvent): void {
    if (event.node === this.nodeId) return;
    if (event.handover) this.#handoverOf = event.node;
    else if (event.holder === null) {
      if (this.#primaryId === event.node) this.#primaryId = null;
      if (this.#handoverOf === event.node) this.#handoverOf = null;
      // The lease is free now: try to take it at once instead of at the next tick.
      this.#schedule();
    } else {
      this.#primaryId = event.holder;
      if (this.#handoverOf === event.holder) this.#handoverOf = null;
    }
    for (const wake of this.#waiters) wake();
  }

  #schedule(): void {
    this.#ticking ??= this.#tick().finally(() => { this.#ticking = undefined; });
  }

  /**
   * A node may take a free lease only once per process (a retired coordinator is never revived) and only while it
   * is not draining. It takes it only when the last known primary is gone or draining: after a Redis restart loses
   * the key, the live primary re-takes it in place (RENEW) instead of racing its peers for it.
   */
  #mayAcquire(): boolean {
    if (this.#retired || this.#draining) return false;
    if (this.#primaryId === null || this.#primaryId === this.nodeId) return true;
    const primary = this.#peers.get(this.#primaryId);
    return primary === undefined || primary.draining;
  }

  async #tick(): Promise<void> {
    if (this.#closed) return;
    const started = performance.now();
    let promoted = false;
    try {
      if (this.#holding) {
        const renewed = await this.#redis.eval(RENEW, 1, LEASE_KEY, this.nodeId, String(LEASE_MS));
        if (renewed === 1) this.#leaseUntil = started + LEASE_MS - LEASE_MARGIN_MS;
        else if (!this.#handingOver) {
          this.#holding = false;
          this.#retired = true;
          console.error(`cluster: node ${this.nodeId} lost the primary lease; retiring its coordinator`);
          this.#handlers?.demoted();
        }
      } else if (this.#mayAcquire() && await this.#redis.set(LEASE_KEY, this.nodeId, 'PX', LEASE_MS, 'NX') === 'OK') {
        this.#holding = true;
        this.#leaseUntil = started + LEASE_MS - LEASE_MARGIN_MS;
        promoted = true;
        console.log(`cluster: node ${this.nodeId} is primary`);
      }
      const beat = this.#pool?.heartbeat(this.nodeId, this.#cluster.address, this.#draining);
      if (beat) {
        const [, added] = await this.#redis.multi().set(nodeKey(this.nodeId), JSON.stringify(beat), 'PX', NODE_TTL_MS).sadd(NODES_KEY, this.nodeId).exec() ?? [];
        // A long stall let the primary clean this node up: put its live rooms back in the index.
        if (added?.[1] === 1 && this.#peers.size > 0) for (const roomId of this.#pool?.localRooms() ?? []) await this.index(roomId);
      }
      const [primaryId, ids] = await Promise.all([this.#redis.get(LEASE_KEY), this.#redis.smembers(NODES_KEY)]);
      const raws = ids.length ? await this.#redis.mget(ids.map(nodeKey)) : [];
      const now = Date.now();
      const dead: string[] = [];
      const live = new Set<string>();
      for (let i = 0; i < ids.length; i++) {
        const raw = raws[i];
        if (!raw) { dead.push(ids[i]!); continue; }
        const beat = JSON.parse(raw) as Heartbeat;
        live.add(beat.id);
        const previous = this.#peers.get(beat.id);
        this.#peers.set(beat.id, { ...beat, raw, seenAt: previous?.raw === raw ? previous.seenAt : now });
      }
      for (const id of this.#peers.keys()) if (!live.has(id)) this.#peers.delete(id);
      if (primaryId !== this.#primaryId && this.#handoverOf !== null && primaryId !== this.#handoverOf) this.#handoverOf = null;
      this.#primaryId = primaryId;
      this.#alone = ![...live].some((id) => id !== this.nodeId);
      this.#redisDown = false;
      if (this.primary) for (const id of dead) await this.#cleanup(id);
      const remote = this.#pool?.remoteRooms() ?? [];
      if (remote.length) this.#pool?.reconcile(remote, await this.#redis.hmget(ROOMS_KEY, ...remote));
    } catch (error) {
      this.#redisError(error as Error & { code?: string });
    }
    for (const wake of this.#waiters) wake();
    if (promoted) {
      // Announced after the registry read above, so the new coordinator adopts lobbies with a current view of the nodes.
      this.publish({ node: this.nodeId, kind: 'lease', holder: this.nodeId });
      this.#handlers?.promote();
    }
  }

  /** Primary only: a node whose heartbeat expired leaves the registry and the room index; its placements end. */
  async #cleanup(id: string): Promise<void> {
    const rooms = await this.#redis.smembers(nodeRoomsKey(id));
    const multi = this.#redis.multi().srem(NODES_KEY, id).del(nodeRoomsKey(id));
    if (rooms.length) multi.hdel(ROOMS_KEY, ...rooms);
    await multi.exec();
    this.#pool?.nodeGone(id);
    console.error(`cluster: node ${id} stopped heartbeating; removed ${rooms.length} room index entr${rooms.length === 1 ? 'y' : 'ies'}`);
  }
}

interface RemoteRoom {
  node: string;
  snapshot: LobbyMatchSnapshot;
  version: number;
  owner?: string;
  createdAt: number;
  /** Capacity units of the match (`matchLoad`). */
  load: number;
}

/** A lobby match hosted on this node: a worker room, or a main-process match of this node's coordinator. */
interface Served {
  game: LobbyMatch;
  version: number;
  load: number;
  owner?: string;
  /** Main-process matches publish their state by polling (`CANONICAL_POLL_MS`); the last published JSON. */
  canonical?: { published: string };
}

/**
 * The SimulationPool surface app.ts uses, placing each worker match on the node with the most headroom (this
 * node's pool or a peer's) under the same load-score and headroom rules. Featured showcases stay local.
 *
 * Every lobby match a node hosts (its worker rooms and its coordinator's main-process matches) is served by room id
 * over `/_cluster/sim` and indexed in Redis, and its state and release are published, so whichever node coordinates
 * its lobby (the placing primary, or its successor after a handover or crash) reaches it.
 *
 * `active` is expressed against THIS node's configured capacity, in capacity units (a duel is 1, a match of more
 * armies `matchLoad`), so the existing admission and openLobbyMatch gates (`active` compared to this node's
 * MAX_MATCHES and worker slots) admit exactly while the cluster has room: local active plus, for each placeable peer,
 * its active minus its capacity (free peer capacity counts negative).
 */
export class ClusterPool {
  readonly #cluster: Cluster;
  readonly #local: SimulationPool;
  readonly #config: ServerConfig;
  readonly #options: ClusterPoolOptions;
  /** Rooms this node coordinates on peers (placed there, or adopted with their lobby). */
  readonly #remote = new Map<string, RemoteRoom>();
  /** Capacity units of placements in flight, per peer. */
  readonly #pending = new Map<string, number>();
  readonly #served = new Map<string, Served>();
  readonly #poll: NodeJS.Timeout;
  /** Seat ticket routing hints outlive any room that could have minted them. */
  readonly #tokenTtlMs: number;
  #draining = false;

  constructor(cluster: Cluster, local: SimulationPool, config: ServerConfig, options: ClusterPoolOptions) {
    this.#cluster = cluster;
    this.#local = local;
    this.#config = config;
    this.#options = options;
    this.#tokenTtlMs = config.maxMatchMs + config.endGraceMs + config.inviteMs;
    local.onRoom({
      state: (roomId) => {
        const served = this.#served.get(roomId);
        if (served) this.#publishState(roomId, served);
      },
      released: (roomId, durationMs) => {
        this.#cluster.unindex(roomId);
        this.#served.delete(roomId);
        this.#cluster.publish({ node: this.#cluster.nodeId, kind: 'released', roomId, durationMs });
      },
      token: (roomId, tokenDigest) => this.#cluster.indexToken(tokenDigest, roomId, this.#tokenTtlMs),
    });
    this.#poll = setInterval(() => this.#pollCanonical(), CANONICAL_POLL_MS);
    this.#poll.unref();
  }

  start(): Promise<void> {
    return this.#local.start();
  }

  get active(): number {
    let total = this.#local.active;
    for (const peer of this.#cluster.peers()) {
      if (peer.draining) continue;
      total = addLoad(total, addLoad(addLoad(Math.max(peer.active, this.#placedOn(peer.id)), this.#pending.get(peer.id) ?? 0), -peer.capacity));
    }
    return Math.max(0, total);
  }

  /** Can a match of `load` capacity units (`matchLoad`) be placed on some node now? */
  canCreate(load = 1): boolean {
    if (this.#draining) return false;
    if (this.#local.canCreate(load)) return true;
    for (const peer of this.#cluster.peers()) if (this.#placeable(peer, load)) return true;
    return false;
  }

  async createLobby(request: SimulationLobbyRequest, ownerKey?: string): Promise<LobbyMatch> {
    if (this.#draining) throw new HttpError(503, 'simulation_capacity');
    const load = matchLoad(request.teams.length);
    // The featured broadcast relays observer frames from this node's own workers.
    const node = request.featured ? undefined : this.#choose(load);
    if (node === undefined) return await this.#hostLocally(request, ownerKey, load);
    this.#pending.set(node, addLoad(this.#pending.get(node) ?? 0, load));
    this.#options.onChange();
    try {
      const reply = await this.#cluster.rpc(node, { op: 'createLobby', request, ...(ownerKey === undefined ? {} : { ownerKey }) });
      const roomId = reply.roomId!;
      const room: RemoteRoom = { node, snapshot: reply.state, version: reply.version, createdAt: Date.now(), load, ...(ownerKey === undefined ? {} : { owner: ownerKey }) };
      this.#remote.set(roomId, room);
      return this.#proxy(roomId, room);
    } finally {
      const left = addLoad(this.#pending.get(node) ?? load, -load);
      if (left > 0) this.#pending.set(node, left); else this.#pending.delete(node);
      this.#options.onChange();
    }
  }

  /**
   * Serve one of this node's coordinator main-process lobby matches by room id: indexed, its state published, and its
   * tickets routed to it, so a successor coordinator can adopt its lobby while it finishes here.
   */
  async serveCanonical(game: LobbyMatch, load: number, ownerKey?: string): Promise<LobbyMatch> {
    await this.#cluster.index(game.roomId);
    const match = game.match;
    const roomId = game.roomId;
    const ticket = async (pending: SeatTicket | Promise<SeatTicket>): Promise<SeatTicket> => {
      const result = await pending;
      this.#cluster.indexToken(digest(result.token), roomId, this.#tokenTtlMs);
      return result;
    };
    const indexed: LobbyMatchState = {
      get over() { return match.over; },
      readiness: () => match.readiness(),
      cards: () => match.cards(),
      mintHumanToken: (...args) => ticket(match.mintHumanToken(...args)),
      mintObserverToken: (...args) => ticket(match.mintObserverToken(...args)),
      mintSpectatorToken: (...args) => ticket(match.mintSpectatorToken(...args)),
      renewHumanToken: (...args) => match.renewHumanToken(...args),
      assign: (...args) => match.assign(...args),
      revokeToken: (...args) => match.revokeToken(...args),
      revokeSeat: (...args) => match.revokeSeat(...args),
      setHumanReady: (...args) => match.setHumanReady(...args),
      end: (...args) => match.end(...args),
      forfeit: (...args) => match.forfeit(...args),
      outcome: (...args) => match.outcome(...args),
    };
    const served: LobbyMatch = { ...game, match: indexed, start: () => game.start(), close: () => game.close() };
    this.#served.set(roomId, { game: served, version: 0, load, ...(ownerKey === undefined ? {} : { owner: ownerKey }), canonical: { published: JSON.stringify(snapshotOf(served)) } });
    return served;
  }

  /**
   * The lobby match `roomId` for a coordinator restoring its lobby from a checkpoint: this node's own, or a proxy to
   * the live node hosting it. Undefined when the room is gone (its node died, or it was released).
   */
  async adopt(roomId: string): Promise<LobbyMatch | undefined> {
    const local = this.#served.get(roomId);
    if (local) return local.game;
    const known = this.#remote.get(roomId);
    if (known) return this.#proxy(roomId, known);
    const node = await this.#cluster.owner(roomId);
    if (!node || node === this.#cluster.nodeId) return undefined;
    let reply: RoomReply;
    try { reply = await this.#cluster.rpc(node, { op: 'snapshot', roomId }); }
    catch { return undefined; }
    // Already in the node's heartbeat: never counted as an unseen placement.
    const room: RemoteRoom = { node, snapshot: reply.state, version: reply.version, createdAt: 0, load: reply.load ?? 1, ...(reply.owner === undefined ? {} : { owner: reply.owner }) };
    this.#remote.set(roomId, room);
    return this.#proxy(roomId, room);
  }

  async abandonOwner(ownerKey: string): Promise<void> {
    await this.#local.abandonOwner(ownerKey);
    const nodes = new Set([...this.#remote.values()].filter((room) => room.owner === ownerKey).map((room) => room.node));
    for (const node of nodes) await this.#cluster.rpc(node, { op: 'abandonOwner', ownerKey });
  }

  /** Delayed observer frames of a worker room on this node, or of one on another node over the internal listener. */
  observe(roomId: string, team: FeaturedPerspective, grant: ObserverGrant, listener: (frame: ObserverFrame) => void): () => void {
    if (this.#local.hosts(roomId)) return this.#local.observe(roomId, team, grant, listener);
    return this.#cluster.observe(this.#remote.get(roomId)?.node, roomId, team, grant, listener);
  }

  /**
   * `/_cluster/observe` on the hosting node: one perspective of a room hosted here (a worker room, or a former
   * coordinator's main-process match it still serves), written as NDJSON until the coordinator hangs up.
   */
  serveObserve(call: ObserveCall, res: ServerResponse): void {
    if (typeof call?.roomId !== 'string' || typeof call.team !== 'string' || !call.grant || typeof call.grant !== 'object') throw new HttpError(400, 'bad_request');
    const write = (frame: ObserverFrame) => { res.write(`${JSON.stringify(frame)}\n`); };
    const local = this.#served.get(call.roomId)?.game.localMatch;
    if (!this.#local.hosts(call.roomId) && !local) throw new HttpError(404, 'room_not_found');
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    res.flushHeaders();
    const stop = this.#local.hosts(call.roomId) ? this.#local.observe(call.roomId, call.team, call.grant, write) : observeMatch(local!, call.grant, write);
    res.once('close', stop);
  }

  async remove(roomId: string): Promise<void> {
    const room = this.#remote.get(roomId);
    if (!room) return await this.#local.remove(roomId);
    await this.#cluster.rpc(room.node, { op: 'room', roomId, method: 'close', args: [] });
  }

  beginDrain(): void {
    this.#draining = true;
    this.#local.beginDrain();
    this.#cluster.beginDrain();
  }

  /** Every node's workers; this node's keep their devtools link. */
  stats(): (SimulationWorkerStats & { node: string })[] {
    const self = this.#cluster.nodeId;
    return [
      ...this.#local.stats().map((worker) => ({ ...worker, node: self })),
      ...[...this.#cluster.peers()].flatMap((peer) => peer.workers.map((worker) => ({ ...worker, node: peer.id, devtools: '' }))),
    ];
  }

  /**
   * Local worker routes first, then joinById for a room indexed on another node, and `/mcp` / `/playerthree/player`
   * bearer seat tickets of a room hosted elsewhere (the hosting node indexed the ticket when it minted it). A request
   * forwarded here is never forwarded again: the edge already chose this node.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (await this.#local.handle(req, res)) return true;
    if (forwardedClient(req) !== undefined) return false;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    let node: string | undefined;
    const join = JOIN_PATH.exec(path);
    if (join) {
      const roomId = join[1]!;
      if (matchMaker.getLocalRoomById(roomId)) return false;
      node = this.#remote.get(roomId)?.node ?? await this.#cluster.owner(roomId);
    } else if (path === '/mcp' || path === '/playerthree/player' || path.startsWith('/playerthree/player/')) {
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization?.trim() ?? '')?.[1];
      const roomId = token && TOKEN_RE.test(token) ? await this.#cluster.tokenRoom(digest(token)) : undefined;
      node = roomId ? await this.#cluster.owner(roomId) : undefined;
    }
    const address = node && node !== this.#cluster.nodeId ? this.#cluster.address(node) : undefined;
    if (!address) return false;
    this.#cluster.forward(address, req, res);
    return true;
  }

  ownsUpgrade(req: IncomingMessage): boolean {
    return this.#local.ownsUpgrade(req);
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#local.upgrade(req, socket, head);
  }

  close(reason?: MatchCloseReason): Promise<void> {
    this.#draining = true;
    clearInterval(this.#poll);
    return this.#local.close(reason);
  }

  /** This node's advertisement, built from the same per-worker rules its own pool applies. */
  heartbeat(id: string, address: string, draining: boolean): Heartbeat {
    const workers = this.#local.stats();
    let score: number | null = null;
    let free = 0;
    let capacity = 0;
    let active = 0;
    for (const worker of workers) {
      active = addLoad(active, worker.active);
      if (!worker.healthy) continue;
      capacity = addLoad(capacity, worker.capacity);
      free = addLoad(free, Math.max(0, addLoad(worker.capacity, -worker.active)));
      if (this.#available(worker)) {
        const load = simulationLoadScore(worker, worker.active, worker.capacity);
        if (score === null || load < score) score = load;
      }
    }
    return { id, address, draining: draining || this.#draining, canCreate: !draining && this.#local.canCreate(), score, free, capacity, active,
      matchesPerWorker: this.#config.matchesPerWorker, workers };
  }

  /** Every room this node indexes: its worker rooms and its served main-process matches. */
  localRooms(): string[] {
    return [...new Set([...this.#local.stats().flatMap((worker) => worker.rooms.map((room) => room.roomId)), ...this.#served.keys()])];
  }

  /** Nodes taking placements: this one (unless draining) and every non-draining peer. */
  liveNodes(): number {
    let nodes = this.#draining ? 0 : 1;
    for (const peer of this.#cluster.peers()) if (!peer.draining) nodes++;
    return Math.max(1, nodes);
  }

  remoteRooms(): string[] {
    return [...this.#remote.keys()];
  }

  /** Pub/sub is at-most-once: a placed room whose index entry is gone (released, or its node cleaned up) ends here too. */
  reconcile(roomIds: string[], owners: (string | null)[]): void {
    for (let i = 0; i < roomIds.length; i++) {
      const room = this.#remote.get(roomIds[i]!);
      if (room && owners[i] !== room.node) this.#release(roomIds[i]!, room, 0);
    }
  }

  /** `/_cluster/sim` on the hosting node: a coordinator's calls on lobby matches hosted here. */
  async serve(call: ClusterCall): Promise<RoomReply | undefined> {
    switch (call.op) {
      case 'createLobby': {
        if (this.#draining) throw new HttpError(503, 'simulation_capacity');
        const game = await this.#hostLocally(call.request, call.ownerKey, matchLoad(call.request.teams.length));
        return { roomId: game.roomId, version: 0, state: snapshotOf(game) };
      }
      case 'room': {
        const served = this.#served.get(call.roomId);
        if (!served || !ROOM_METHODS.includes(call.method) || !Array.isArray(call.args)) throw new HttpError(404, 'room_not_found');
        const { game } = served;
        let value: unknown;
        if (call.method === 'start') await game.start();
        else if (call.method === 'close') await game.close();
        else value = await (game.match[call.method] as (...args: unknown[]) => unknown).apply(game.match, call.args);
        return { ...(value === undefined ? {} : { value }), version: served.version, state: snapshotOf(game) };
      }
      case 'snapshot': {
        const served = this.#served.get(call.roomId);
        if (!served) throw new HttpError(404, 'room_not_found');
        return { version: served.version, state: snapshotOf(served.game), load: served.load, ...(served.owner === undefined ? {} : { owner: served.owner }) };
      }
      case 'abandonOwner':
        await this.#local.abandonOwner(call.ownerKey);
        return undefined;
    }
  }

  /** Events from hosting nodes about rooms this node coordinates there. */
  event(event: RoomEvent): void {
    const room = this.#remote.get(event.roomId);
    if (!room || room.node !== event.node) return;
    if (event.kind === 'state') this.#apply(room, event.version, event.state);
    else this.#release(event.roomId, room, event.durationMs);
  }

  /** The hosting node stopped heartbeating: its rooms are gone for this node too. */
  nodeGone(node: string): void {
    for (const [roomId, room] of this.#remote) if (room.node === node) this.#release(roomId, room, 0);
  }

  /** A worker match on this node's own pool, served by room id and indexed for routing. */
  async #hostLocally(request: SimulationLobbyRequest, ownerKey: string | undefined, load: number): Promise<LobbyMatch> {
    const game = await this.#local.createLobby(request, ownerKey);
    try { await this.#cluster.index(game.roomId); }
    catch {
      await game.close();
      throw new HttpError(503, 'cluster_unavailable');
    }
    this.#served.set(game.roomId, { game, version: 0, load, ...(ownerKey === undefined ? {} : { owner: ownerKey }) });
    return game;
  }

  #publishState(roomId: string, served: Served): void {
    served.version++;
    this.#cluster.publish({ node: this.#cluster.nodeId, kind: 'state', roomId, version: served.version, state: snapshotOf(served.game) });
  }

  /** Main-process matches: publish changed state, and release once the room is gone. */
  #pollCanonical(): void {
    for (const [roomId, served] of this.#served) {
      if (!served.canonical) continue;
      if (!matchMaker.getLocalRoomById(roomId)) {
        this.#served.delete(roomId);
        this.#cluster.unindex(roomId);
        this.#cluster.publish({ node: this.#cluster.nodeId, kind: 'released', roomId, durationMs: 0 });
        continue;
      }
      const published = JSON.stringify(snapshotOf(served.game));
      if (published === served.canonical.published) continue;
      served.canonical.published = published;
      this.#publishState(roomId, served);
    }
  }

  #apply(room: RemoteRoom, version: number, state: LobbyMatchSnapshot): void {
    if (version < room.version) return;
    room.version = version;
    Object.assign(room.snapshot, state);
  }

  #release(roomId: string, room: RemoteRoom, durationMs: number): void {
    this.#remote.delete(roomId);
    room.snapshot.over = true;
    room.snapshot.readiness.pending = false;
    this.#options.onRelease(durationMs);
    this.#options.onChange();
  }

  /** Same LobbyMatch shape as SimulationPool's worker proxy, one network hop further. */
  #proxy(roomId: string, room: RemoteRoom): LobbyMatch {
    const call = async (method: RoomMethod, args: unknown[] = []): Promise<unknown> => {
      const reply = await this.#cluster.rpc(room.node, { op: 'room', roomId, method, args });
      this.#apply(room, reply.version, reply.state);
      return reply.value;
    };
    const match: LobbyMatchState = {
      get over() { return room.snapshot.over; },
      readiness: () => room.snapshot.readiness,
      mintSpectatorToken: async (...args) => await call('mintSpectatorToken', args) as SeatTicket,
      assign: async (...args) => { await call('assign', args); },
      cards: () => room.snapshot.cards,
      mintHumanToken: async (...args) => await call('mintHumanToken', args) as SeatTicket,
      renewHumanToken: async (...args) => await call('renewHumanToken', args) as { expiresAt: number },
      mintObserverToken: async (...args) => await call('mintObserverToken', args) as SeatTicket,
      revokeToken: async (token) => { await call('revokeToken', [token]); },
      revokeSeat: async (...args) => { await call('revokeSeat', args); },
      setHumanReady: async (...args) => { await call('setHumanReady', args); },
      end: async (...args) => await call('end', args) as Awaited<ReturnType<LobbyMatchState['end']>>,
      // Forfeits and per-army outcomes (an eliminated human's observer gate) run on the hosting node like the rest.
      forfeit: async (...args) => { await call('forfeit', args); },
      outcome: async (...args) => await call('outcome', args) as Outcome,
    };
    let closing: Promise<void> | undefined;
    return {
      roomId, match,
      start: async () => { await call('start'); },
      // A room whose node already released it (or died) is closed.
      close: () => closing ??= call('close').then(() => {}, (error: unknown) => { if (this.#remote.has(roomId)) throw error; }),
    };
  }

  /** Capacity units this node placed on `node` (load-weighted, like the heartbeat's `active`). */
  #placedOn(node: string): number {
    let load = 0;
    for (const room of this.#remote.values()) if (room.node === node) load = addLoad(load, room.load);
    return load;
  }

  /** Capacity units placed on `peer` that its latest heartbeat cannot include yet (in flight, or created since it was read). */
  #unseen(peer: Peer): number {
    let load = this.#pending.get(peer.id) ?? 0;
    // A heartbeat is up to one tick old when read: count anything placed within a tick of its arrival as unseen.
    for (const room of this.#remote.values()) if (room.node === peer.id && room.createdAt > peer.seenAt - TICK_MS) load = addLoad(load, room.load);
    return load;
  }

  /** `peer` can take a match of `load` capacity units: free capacity beyond unseen placements, and one worker it fits. */
  #placeable(peer: Peer, load: number): boolean {
    return !peer.draining && peer.canCreate && peer.score !== null && addLoad(this.#unseen(peer), load) <= peer.free &&
      peer.workers.some((worker) => this.#available(worker, load));
  }

  #available(worker: SimulationWorkerStats, load = 1): boolean {
    return worker.healthy && addLoad(worker.active, load) <= worker.capacity &&
      hasSimulationHeadroom(worker, this.#config.admissionLagMs, this.#config.simWorkerCpuPercent / 100);
  }

  /** Least-loaded node for a worker match; undefined = this node (ties stay local). */
  #choose(load: number): string | undefined {
    let best: string | undefined;
    let bestScore = Infinity;
    if (this.#local.canCreate(load)) {
      for (const worker of this.#local.stats()) {
        if (this.#available(worker, load)) bestScore = Math.min(bestScore, simulationLoadScore(worker, worker.active, worker.capacity));
      }
    }
    const localScore = bestScore;
    for (const peer of this.#cluster.peers()) {
      if (!this.#placeable(peer, load)) continue;
      const score = peer.score! + this.#unseen(peer) / Math.max(1, peer.matchesPerWorker);
      if (score < bestScore) { best = peer.id; bestScore = score; }
    }
    if (bestScore === Infinity && localScore === Infinity) throw new HttpError(503, 'simulation_capacity');
    return best;
  }
}
