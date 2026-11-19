/** Whole-host workers expose explicit lobby capabilities, never a counterfeit PlayerThreeMatch. */
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { TOKEN_RE } from 'playerthree';
import { ARMIES, type ArmyId, type Outcome } from '@agent-command/game';
import { MAPS, type MatchCloseReason } from '@agent-command/game/lobby';
import { namedMap } from '@agent-command/game/maps';
import type { ServerConfig } from './config.ts';
import { clientIp, HttpError, pipeUpgrade } from './http.ts';
import type { SeatTicket } from 'playerthree/host';
import type { ObserverFrame, ObserverGrant } from 'playerthree/protocol';
import type { FeaturedPerspective } from './featured.ts';
import type { LobbyMatch, LobbyMatchSnapshot, LobbyMatchState } from './lobby-match.ts';
import type { SimulationCall, SimulationLobbyResponse, SimulationMessage, SimulationLobbyRequest, SimulationResult, SimulationSnapshot, SimulationStats } from './simulation-protocol.ts';
import { hasSimulationHeadroom, simulationLoadScore } from './simulation-metrics.ts';
import { addLoad, matchLoad } from './admission.ts';

export type { SimulationLobbyRequest, SimulationSeatAssignment, SimulationSnapshot, SimulationStats } from './simulation-protocol.ts';

export interface SimulationPoolOptions {
  workers: number;
  matchesPerWorker: number;
  /** Worker-loop rolling p95 tick delay above this holds admission; parent lag gating remains independent. */
  maxLagMs?: number;
  /** Worker-thread CPU ceiling, as a fraction of one core (default .75). */
  maxCpuFraction?: number;
  /** In-process benchmark injection only; never read from HTTP or environment variables. */
  warmupTicks?: number;
  seed?: number;
  onChange?(): void;
  onRelease?(durationMs: number): void;
  recordTick?(lagMs: number, durationMs: number): void;
}

/** Per-room events of this pool's worker rooms (cluster mode publishes them and indexes the tickets for routing). */
export interface SimulationRoomListener {
  state?(roomId: string, state: LobbyMatchSnapshot): void;
  released?(roomId: string, durationMs: number): void;
  /** A seat or observer ticket minted for the room (its SHA-256 hex digest). */
  token?(roomId: string, digest: string): void;
}

/** One worker as reported by `stats()` (and advertised to the cluster). */
export interface SimulationWorkerStats extends SimulationStats {
  healthy: boolean;
  capacity: number;
  active: number;
  devtools: string;
}

interface Pending {
  resolve(value: SimulationResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
interface Member {
  id: number;
  thread: Worker;
  port: number;
  failed: boolean;
  /** Capacity units (admission.ts `matchLoad`) of its rooms plus the creations in flight. */
  load: number;
  rooms: Set<string>;
  calls: Map<number, Pending>;
  stats: SimulationStats;
  ready: { promise: Promise<void>; resolve(): void; reject(error: Error): void };
}

export class SimulationPool {
  readonly #config: ServerConfig;
  readonly #options: SimulationPoolOptions;
  readonly #members: Member[] = [];
  readonly #rooms = new Map<string, Member>();
  readonly #tokens = new Map<string, string>();
  readonly #states = new Map<string, LobbyMatchSnapshot>();
  readonly #owners = new Map<string, string>();
  /** Capacity units of each live room, released with it. */
  readonly #loads = new Map<string, number>();
  /** One relayed observer stream per `roomId:team` (a single trusted parent consumer: the featured broadcast). */
  readonly #relays = new Map<string, (frame: ObserverFrame) => void>();
  readonly #sockets = new Map<Duplex, Socket>();
  readonly #roomListeners = new Set<SimulationRoomListener>();
  #sequence = 0;
  #started = false;
  #draining = false;
  #closed = false;

  constructor(config: ServerConfig, options: SimulationPoolOptions) {
    if (!Number.isInteger(options.workers) || options.workers < 0 || options.workers > 32) throw new Error('workers must be an integer in [0,32]');
    if (!Number.isInteger(options.matchesPerWorker) || options.matchesPerWorker < 1) throw new Error('matchesPerWorker must be positive');
    this.#config = config;
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('simulation pool already started');
    this.#started = true;
    try {
      const maps = MAPS.filter((map) => map.tags.includes('saved')).map((map) => namedMap(map.id)!);
      for (let id = 0; id < this.#options.workers; id++) {
        const config = {
          ...this.#config,
          host: '127.0.0.1', port: 0, trustProxy: true,
          maxMatches: this.#options.matchesPerWorker,
          publicUrl: this.#config.publicUrl?.href,
          // Workers have no profile/commander endpoints. Never share their file stores with the canonical host.
          dataDir: this.#config.dataDir ? join(this.#config.dataDir, 'simulation', String(id)) : undefined,
          historyDir: this.#config.historyDir ? join(this.#config.historyDir, 'simulation', String(id)) : undefined,
        };
        const thread = new Worker(new URL('./simulation-worker.ts', import.meta.url), {
          workerData: { worker: id, config, maps, warmupTicks: this.#options.warmupTicks, seed: this.#options.seed },
        });
        const member: Member = { id, thread, port: 0, failed: false, load: 0, rooms: new Set(), calls: new Map(),
          stats: { worker: id, sampledAt: 0, rooms: [], tickSamples: 0, p95LagMs: 0, windowSamples: 0,
            cpuFraction: 0, p99LagMs: 0, maxLagMs: 0, maxDurationMs: 0 }, ready: Promise.withResolvers<void>() };
        this.#members.push(member);
        thread.on('message', (message: SimulationMessage) => this.#message(member, message));
        thread.on('error', (error: unknown) => this.#fail(member, error instanceof Error ? error : new Error(String(error))));
        thread.on('exit', (code) => { if (!this.#closed) this.#fail(member, new Error(`simulation worker ${id} exited (${code})`)); });
      }
      await Promise.all(this.#members.map((member) => member.ready.promise));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Capacity units in use across workers (a four-army room counts ~2.4 duels). */
  get active(): number {
    return this.#members.reduce((sum, member) => addLoad(sum, member.load), 0);
  }

  canCreate(load = 1): boolean {
    return !this.#draining && !this.#closed && this.#members.some((member) => this.#available(member, load));
  }

  owns(roomId: string): boolean {
    return this.#rooms.has(roomId);
  }

  /** Subscribe to per-room state and release events; returns unsubscribe. */
  onRoom(listener: SimulationRoomListener): () => void {
    this.#roomListeners.add(listener);
    return () => { this.#roomListeners.delete(listener); };
  }

  /** `ownerKey` is the parent-authenticated play owner, kept here and never sent to the worker. */
  async createLobby(request: SimulationLobbyRequest, ownerKey?: string): Promise<LobbyMatch> {
    if (request.assignments.some((seat) => !['human', 'bot', 'none'].includes(seat.kind) || 'commander' in seat || 'policy' in seat)) throw new HttpError(400, 'unsupported_worker_assignment');
    if (this.#draining || this.#closed) throw new HttpError(503, 'simulation_capacity');
    const load = matchLoad(request.teams.length);
    let member: Member | undefined;
    let leastLoad = Infinity;
    for (const entry of this.#members) {
      if (!this.#available(entry, load)) continue;
      const score = simulationLoadScore(entry.stats, entry.load, this.#options.matchesPerWorker);
      if (score < leastLoad) { member = entry; leastLoad = score; }
    }
    if (!member) throw new HttpError(503, 'simulation_capacity');
    member.load = addLoad(member.load, load);
    this.#options.onChange?.();
    let created = false;
    try {
      const result = await this.#call(member, { op: 'createLobby', request }) as SimulationLobbyResponse;
      this.#rooms.set(result.roomId, member);
      this.#loads.set(result.roomId, load);
      member.rooms.add(result.roomId);
      this.#states.set(result.roomId, result.state);
      if (ownerKey !== undefined) this.#owners.set(result.roomId, ownerKey);
      created = true;
      return this.#proxy(result.roomId, member);
    } finally {
      if (!created) member.load = addLoad(member.load, -load);
      this.#options.onChange?.();
    }
  }

  /** Parent-authenticated ownership; the worker independently checks that no human or agent remains. */
  async abandonOwner(ownerKey: string): Promise<void> {
    for (const [roomId, owner] of this.#owners) {
      if (owner !== ownerKey) continue;
      const member = this.#rooms.get(roomId);
      if (member) await this.#call(member, { op: 'abandon', roomId });
    }
  }

  async snapshot(roomId: string): Promise<SimulationSnapshot> {
    const member = this.#rooms.get(roomId);
    if (!member) throw new HttpError(404, 'room_not_found');
    return await this.#call(member, { op: 'snapshot', roomId }) as SimulationSnapshot;
  }


  /** Delayed observer frames of one perspective (an army or `all`), relayed from the worker; returns stop. */
  observe(roomId: string, team: FeaturedPerspective, grant: ObserverGrant, listener: (frame: ObserverFrame) => void): () => void {
    const member = this.#rooms.get(roomId);
    if (!member) throw new HttpError(404, 'room_not_found');
    const key = `${roomId}:${team}`;
    this.#relays.set(key, listener);
    void this.#call(member, { op: 'observe', roomId, team, grant }).catch(() => {});
    return () => {
      if (this.#relays.get(key) !== listener) return;
      this.#relays.delete(key);
      if (!member.failed && !this.#closed) void this.#call(member, { op: 'unobserve', roomId, team }).catch(() => {});
    };
  }

  /** One of this pool's workers hosts `roomId`. */
  hosts(roomId: string): boolean {
    return this.#rooms.has(roomId);
  }

  async remove(roomId: string): Promise<void> {
    const member = this.#rooms.get(roomId);
    if (member) await this.#call(member, { op: 'remove', roomId });
  }

  #proxy(roomId: string, member: Member): LobbyMatch {
    const snapshot = this.#states.get(roomId);
    if (!snapshot) throw new HttpError(404, 'room_not_found');
    const call = (request: SimulationCall) => this.#call(member, request);
    const ticket = async (request: SimulationCall): Promise<SeatTicket> => {
      const result = await call(request) as SeatTicket;
      const tokenDigest = createHash('sha256').update(result.token).digest('hex');
      this.#tokens.set(tokenDigest, roomId);
      for (const listener of this.#roomListeners) listener.token?.(roomId, tokenDigest);
      return result;
    };
    const match: LobbyMatchState = {
      get over() { return snapshot.over; },
      readiness: () => snapshot.readiness,
      cards: () => snapshot.cards,
      mintHumanToken: (...args) => ticket({ op: 'mintHumanToken', roomId, args }),
      renewHumanToken: async (...args) => await call({ op: 'renewHumanToken', roomId, args }) as { expiresAt: number },
      mintObserverToken: (...args) => ticket({ op: 'mintObserverToken', roomId, args }),
      mintSpectatorToken: (...args) => ticket({ op: 'mintSpectatorToken', roomId, args }),
      assign: async (...args) => { await call({ op: 'assign', roomId, args }); },
      revokeToken: async (token) => {
        await call({ op: 'revokeToken', roomId, token });
        this.#tokens.delete(createHash('sha256').update(token).digest('hex'));
      },
      revokeSeat: async (...args) => { await call({ op: 'revokeSeat', roomId, args }); },
      setHumanReady: async (...args) => { await call({ op: 'setHumanReady', roomId, args }); },
      end: async (...args) => await call({ op: 'end', roomId, args }) as Record<string, Outcome>,
      forfeit: async (...args) => { await call({ op: 'forfeit', roomId, args }); },
      outcome: async (...args) => await call({ op: 'outcome', roomId, args }) as Outcome,
    };
    let closing: Promise<void> | undefined;
    return {
      roomId, match,
      start: async () => { await call({ op: 'start', roomId }); },
      close: () => closing ??= this.remove(roomId),
    };
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const member of this.#members) if (!member.failed) void this.#call(member, { op: 'drain' }).catch(() => {});
    this.#options.onChange?.();
  }

  stats(): SimulationWorkerStats[] {
    return this.#members.map((member) => ({ ...member.stats, healthy: !member.failed && member.port > 0,
      capacity: member.failed ? 0 : this.#options.matchesPerWorker, active: member.load,
      devtools: `/playerthree/devtools?simulationWorker=${member.id}` }));
  }

  /** Call before local route handlers. Body streams are never consumed speculatively. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const join = /^\/matchmake\/joinById\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    let member = join ? this.#rooms.get(join[1]!) : undefined;
    if (!member && (url.pathname === '/mcp' || url.pathname === '/playerthree/player' || url.pathname.startsWith('/playerthree/player/'))) {
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization?.trim() ?? '')?.[1];
      if (token && TOKEN_RE.test(token)) {
        const roomId = this.#tokens.get(createHash('sha256').update(token).digest('hex'));
        if (roomId) member = this.#rooms.get(roomId);
      }
    }
    if (url.pathname === '/playerthree/devtools' || url.pathname.startsWith('/playerthree/devtools/')) {
      const selection = url.searchParams.get('simulationWorker');
      if (selection === 'main') {
        res.setHeader('Set-Cookie', 'ac_simulation_worker=; Path=/playerthree/devtools; HttpOnly; SameSite=Strict; Max-Age=0');
        return false;
      }
      const cookie = /(?:^|;\s*)ac_simulation_worker=(\d+)(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
      const selected = selection ?? cookie;
      if (selected !== undefined && /^\d+$/.test(selected)) {
        member = this.#members[Number(selected)];
        if (selection !== null) res.setHeader('Set-Cookie', `ac_simulation_worker=${selected}; Path=/playerthree/devtools; HttpOnly; SameSite=Strict`);
      }
    }
    if (!member) return false;
    if (member.failed || member.port === 0) throw new HttpError(503, 'simulation_unavailable');
    this.#forward(member, req, res);
    return true;
  }

  ownsUpgrade(req: IncomingMessage): boolean {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const roomId = /^\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
    return roomId !== undefined && this.#rooms.has(roomId);
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const roomId = /^\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)?.[1];
    const member = roomId ? this.#rooms.get(roomId) : undefined;
    if (!member) return;
    if (member.failed || member.port === 0) { socket.destroy(); return; }
    const upstream = pipeUpgrade(req, socket, head, { host: '127.0.0.1', port: member.port }, { ...req.headers, 'x-forwarded-for': clientIp(req, this.#config) });
    this.#sockets.set(socket, upstream);
    socket.once('close', () => this.#sockets.delete(socket));
  }

  /** `reason`: what the players of matches still running are told (`MATCH_CLOSE`), restart unless a drain ran out. */
  async close(reason: MatchCloseReason = 'restart'): Promise<void> {
    if (this.#closed) return;
    this.#draining = true;
    await Promise.all(this.#members.filter((member) => !member.failed && member.port > 0).map(async (member) => {
      try { await this.#call(member, { op: 'close', reason }); } catch { /* Failure cleanup below terminates the host. */ }
    }));
    this.#closed = true;
    for (const [socket, upstream] of this.#sockets) { socket.destroy(); upstream.destroy(); }
    await Promise.all(this.#members.map(async (member) => {
      this.#fail(member, new Error('simulation pool closed'));
      await member.thread.terminate();
    }));
    this.#rooms.clear(); this.#tokens.clear(); this.#relays.clear(); this.#states.clear(); this.#owners.clear();
  }



  #forward(member: Member, req: IncomingMessage, res: ServerResponse): void {
    const consoleRequest = (req.url ?? '').startsWith('/playerthree/devtools');
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    // Preserve the SDK's local-console trust decision: a genuinely local request stays local, while every
    // original proxy header remains present. Non-loopback callers are always marked as proxied.
    const headers = consoleRequest && (peer === '::1' || /^127\.\d+\.\d+\.\d+$/.test(peer))
      ? req.headers : { ...req.headers, 'x-forwarded-for': clientIp(req, this.#config) };
    const upstream = httpRequest({ hostname: '127.0.0.1', port: member.port, path: req.url, method: req.method,
      headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"simulation_unavailable"}'); }
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  #available(member: Member, load: number): boolean {
    return !member.failed && member.port > 0 &&
      addLoad(member.load, load) <= this.#options.matchesPerWorker &&
      hasSimulationHeadroom(member.stats, this.#options.maxLagMs ?? Infinity, this.#options.maxCpuFraction ?? .75);
  }

  #call(member: Member, call: SimulationCall): Promise<SimulationResult> {
    if (member.failed) return Promise.reject(new Error('simulation_unavailable'));
    const id = ++this.#sequence;
    const pending = Promise.withResolvers<SimulationResult>();
    const timer = setTimeout(() => {
      this.#fail(member, new Error(`simulation worker ${member.id} timed out (${call.op})`));
      void member.thread.terminate();
    }, call.op === 'createLobby' && this.#options.warmupTicks ? 180_000 : 30_000);
    timer.unref();
    member.calls.set(id, { resolve: pending.resolve, reject: pending.reject, timer });
    try { member.thread.postMessage({ id, call }); }
    catch (error) { this.#fail(member, error instanceof Error ? error : new Error('simulation_unavailable')); }
    return pending.promise;
  }

  #message(member: Member, message: SimulationMessage): void {
    switch (message.kind) {
      case 'ready': member.port = message.port; member.ready.resolve(); this.#options.onChange?.(); break;
      case 'reply': {
        const pending = member.calls.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); member.calls.delete(message.id);
        if (message.error) pending.reject(new HttpError(message.error === 'bad_token' ? 401 : message.error === 'room_not_found' ? 404 : 503, message.error));
        else pending.resolve(message.value);
        break;
      }
      case 'released':
        this.#released(member, message.roomId, message.durationMs);
        this.#options.onRelease?.(message.durationMs);
        break;
      case 'state': {
        const snapshot = this.#states.get(message.roomId);
        if (snapshot) {
          Object.assign(snapshot, message.state);
          for (const listener of this.#roomListeners) listener.state?.(message.roomId, snapshot);
        }
        break;
      }
      case 'observer': this.#relays.get(`${message.roomId}:${message.team}`)?.(message.frame); break;
      case 'stats':
        member.stats = message.stats;
        for (let i = 0; i < message.lags.length; i++) this.#options.recordTick?.(message.lags[i]!, message.durations[i] ?? 0);
        this.#options.onChange?.();
        break;
    }
  }

  #released(member: Member, roomId: string, durationMs = 0): void {
    member.rooms.delete(roomId); this.#rooms.delete(roomId);
    const load = this.#loads.get(roomId);
    if (load !== undefined) { member.load = addLoad(member.load, -load); this.#loads.delete(roomId); }
    const snapshot = this.#states.get(roomId);
    if (snapshot) { snapshot.over = true; snapshot.readiness.pending = false; }
    this.#states.delete(roomId);
    this.#owners.delete(roomId);
    for (const [token, room] of this.#tokens) if (room === roomId) this.#tokens.delete(token);
    for (const team of [...ARMIES, 'all']) this.#relays.delete(`${roomId}:${team}`);
    this.#options.onChange?.();
    for (const listener of this.#roomListeners) listener.released?.(roomId, durationMs);
  }

  #fail(member: Member, error: Error): void {
    if (member.failed) return;
    member.failed = true;
    member.ready.reject(error);
    for (const pending of member.calls.values()) { clearTimeout(pending.timer); pending.reject(error); }
    member.calls.clear();
    for (const roomId of member.rooms) this.#released(member, roomId);
    this.#options.onChange?.();
  }
}
