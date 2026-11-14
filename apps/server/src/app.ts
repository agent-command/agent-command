/** HTTP, exact-seat room admission and one lobby allocator shared by play and arena execution. */
import { randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createAuthContext, defineRoom, matchMaker, registerRoomDefinitions, ServerError } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { PlayerThreeError, MAX_MESSAGE_BYTES, TOKEN_RE, type Controller } from 'playerthree';
import { createPlayerThreeHost, type CreateMatchOptions, type SeatAssignment } from 'playerthree/host';
import { createAuthorizationServer, createMcpRequestHandler, type AuthorizationServer, type McpRequestHandler } from 'playerthree/mcp';
import { createDevtoolsHandler, createPlayerApiHandler, type DevtoolsHandler } from 'playerthree/devtools';
import type { PostgresStorage } from 'playerthree/postgres';
import { definition, PLANES, COLOURS, MAX_ARMIES, slotArmyIds, resolveRules, rulesOptions, type ArmyId, type MatchArmy, type MatchOptions, type Opponent, type Outcome, type Plane } from '@agent-command/game';
import { MAPS, MATCH_CLOSE, type MatchCloseReason } from '@agent-command/game/lobby';
import type { ServerConfig } from './config.ts';
import { clientIp, cors, HttpError, originAllowed, RateLimiter, readJson, redirectToCanonical, securityHeaders, sendJson, serveStatic } from './http.ts';
import { jsonProfileStore, postgresProfileStore, Profiles } from './profiles.ts';
import { createAgentCommandRoom, MatchRegistry, ROOM_NAME, type GameHost, type GameMatch, type MatchMode } from './room.ts';
import { createConnectApi } from './connect.ts';
import { createRosterApi } from './roster.ts';
import { createBotPackagesApi } from './policy-packages.ts';
import { createDevAdmin, type DevAdmin } from './dev-admin.ts';
import { Admission, AdmissionError, addLoad, matchLoad, type AdmissionResult } from './admission.ts';
import { TickMetrics } from './metrics.ts';
import { createLobbyRoom, DIRECTORY_ROOM, LOBBY_ROOM, LobbyService, matchSides, type LobbyMatch, type LobbyOpenOptions } from './lobby.ts';
import { SimulationPool } from './simulation-pool.ts';
import { Cluster, coordination, FAILOVER_WAIT_MS, fenced } from './cluster.ts';
import { builtInBotsOnly, createFeatured, FEATURED_DELAY_MS, featuredGrant, observeMatch, type FeaturedRelay } from './featured.ts';
import { FeaturedPlaylist, featuredBotSeats, featuredRules } from './featured-playlist.ts';
import { createArenaService } from './arena.ts';
import { matchSeeding } from './rules.ts';
import { createPublicPages } from './seo.ts';
import { createBenchmarks } from './benchmarks.ts';
import { createModelCatalogRoute } from './model-catalog.ts';
import { Accounts, createGithubSignIn } from './accounts.ts';
import { createRankedService, type RankedService } from './ranked.ts';
import { createGauntlet, type Gauntlet } from './gauntlet.ts';
import { arenaSeedSource } from './arena-seeds.ts';


export interface GameServer {
  readonly http: Server;
  /** The coordinator's host (always without cluster mode; in cluster mode only on the node that became primary). */
  readonly host: GameHost;
  /** Rated play: verdicts, queue, ladder and cards (routes absent without RATED=on). Coordinator-owned like `host`. */
  readonly ranked: RankedService;
  /** Cluster mode: resolves if this process loses the primary lease without a handover (its coordinator retired). */
  readonly demoted: Promise<void>;
  /** Resolves with the bound port. */
  listen(): Promise<number>;
  /** Refuse new matches, wait for live outcomes (bounded by DRAIN_MAX_SECONDS), then close and flush history. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Private benchmark injection: never populated by the production entrypoint or a public request. */
export interface GameServerOptions {
  warmupTicks?: number;
  seed?: number;
}

/**
 * Every store-backed service (lobbies, the canonical host and its OAuth/MCP surfaces, profiles, rosters, arena,
 * ranked, featured): one per process. Without cluster mode it is built with the server. In cluster mode it is built
 * when this process first becomes primary, from the stores as the previous primary left them, and retired for good
 * when the lease goes: its live main-process matches finish here, everything else is the successor's.
 */
interface Coordinator {
  readonly host: GameHost;
  readonly ranked: RankedService;
  readonly featured: FeaturedRelay | undefined;
  readonly retired: boolean;
  /** Its routes; false when the path is not its own (static files and public pages follow). */
  route(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<boolean>;
  /** A retired coordinator still answers for its own live matches: their joins and seat-ticket requests. */
  serveRetired(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  /** Load the stores, open OAuth/MCP for `port`, and (cluster mode) restore the checkpointed lobbies. */
  start(port: number): Promise<void>;
  /** Single process drain: lobbies that never started close; the featured relay stops. */
  beginDrain(): void;
  retire(handover: boolean): Promise<void>;
  /** Shutdown, after the pool closed: lobbies, arena, ranked and sign-in (a retired coordinator closed them already). */
  closeServices(): Promise<void>;
  /** Shutdown, after the transports closed: the agent surfaces and the host, flushing its records. */
  closeHost(): Promise<void>;
}


const MATCHMAKE_BODY_BYTES = 4096;
/** Concurrent player-console streams per client IP: a few tabs per player, with headroom for a shared address. */
const PLAYER_STREAMS_PER_IP = 8;
const DEFAULT_OPPONENT: Opponent = 'standard';
/** A handing-over primary waits this long for coordination requests that change state to finish before it retires. */
const HANDOVER_SETTLE_MS = 5000;

/** Initial seat controllers for a team. Human teams start on the surface; the other planes are bots until reassigned. */
function seatControllers(human: boolean): Record<Plane, Controller> {
  const out = {} as Record<Plane, Controller>;
  for (const plane of PLANES) out[plane] = human && plane === 'surface' ? 'human' : 'bot';
  return out;
}



/** What openMatch needs beyond the mode: who seats the armies, the ready check, and the world. */
interface OpenMatch {
  mode: MatchMode;
  opponent: Opponent;
  seed?: number;
  /** Match rule overrides (validated); the host's defaults fill the rest. */
  rules?: MatchOptions;
  /** The match's armies in slot order with their colours (default: a duel, nw blue vs se red). */
  armies?: readonly MatchArmy[];
  /** Reserved read-only showcase; never a player-created room option. */
  featured?: boolean;
  /** Exact-seat bot levels and options (the featured playlist); unset, `opponent` levels the bot armies. */
  botSeats?: CreateMatchOptions<typeof definition.manifest>['botSeats'];
}
/** The default two-slot duel: nw blue, se red. */
const DUEL: readonly MatchArmy[] = slotArmyIds(2).map((id, k) => ({ id, colour: COLOURS[k]! }));


/**
 * `storage` (DATABASE_URL, opened by main.ts, closed by its owner after `close()`): Postgres for profiles, rosters,
 * OAuth connections, the policy pool and the session history. Without it, files under `config.dataDir` (and
 * `config.historyDir`), else memory.
 */
export function createGameServer(config: ServerConfig, storage?: PostgresStorage, options: GameServerOptions = {}): GameServer {
  const manifest = definition.manifest;
  const benchmarks = createBenchmarks(config, storage);
  const modelCatalog = createModelCatalogRoute();
  const publicPages = createPublicPages(config, async () => [...await benchmarks.paths(), ...await (coord ? coord.ranked.paths() : [])]);
  const policyBytes: number = manifest.control.policy?.maxArtifactBytes ?? 0;
  // Policy uploads are the largest legitimate message: wasm travels as base64 (4/3) plus envelope.
  const maxMessageBytes = Math.min(MAX_MESSAGE_BYTES, Math.max(64 * 1024, Math.ceil((policyBytes * 4) / 3) + 16 * 1024));

  let draining = false;
  let opening = 0;
  let closePromise: Promise<void> | undefined;
  let drainPromise: Promise<void> | undefined;
  let drainDone: (() => void) | undefined;
  let drainCap: NodeJS.Timeout | undefined;
  let drainLog: NodeJS.Timeout | undefined;

  function assertAcceptingMatches(): void {
    if (draining) throw new HttpError(503, 'server_updating', 'Server updating, try again in a moment');
  }

  /** This process's live main-process matches (its coordinator's, retired or not). */
  function liveMatches(): GameMatch[] {
    return coord ? coord.host.matches().filter((match) => !match.over) : [];
  }

  /** Close undecided rooms without inventing a result; worker rooms close through the pool. */
  function closeRoomsWithoutResult(reason: MatchCloseReason): Promise<unknown> {
    return Promise.all([...registry.rooms()].filter(([, live]) => !live.match.over).map(([, live]) => live.closeWithoutResult?.(reason)));
  }

  function checkDrain(): void {
    // A decided room still owns terminal HTTP/WebSocket deliveries during its existing end grace.
    // Do not dispose those leases merely because the simulation outcome is no longer running.
    if (draining && opening === 0 && liveMatches().length === 0 && registry.size === 0 && simulations.active === 0) drainDone?.();
  }

  // Terminal transports finish during the room's existing grace; release callbacks recheck the drain.
  function scheduleDrainCheck(): void {
    if (draining) queueMicrotask(checkDrain);
  }
  const registry = new MatchRegistry();
  const ticks = new TickMetrics();
  const simulations = new SimulationPool(config, {
    workers: config.simWorkers,
    matchesPerWorker: config.matchesPerWorker,
    maxLagMs: config.admissionLagMs,
    maxCpuFraction: config.simWorkerCpuPercent / 100,
    warmupTicks: options.warmupTicks,
    seed: options.seed,
    recordTick: (lag, duration) => ticks.record(lag, duration),
    onRelease: (duration) => { admission.released(duration); scheduleDrainCheck(); },
    onChange: scheduleDrainCheck,
  });
  // Cluster mode (REDIS_URL): the same pool surface, placing worker matches across every node's workers.
  const cluster = config.cluster ? new Cluster(config) : undefined;
  const clusterPool = cluster?.pool(simulations, { onRelease: (duration) => { admission.released(duration); scheduleDrainCheck(); }, onChange: scheduleDrainCheck });
  const pool = clusterPool ?? simulations;
  const reserved = () => config.featuredMatch && coord?.featured && !coord.featured.stats().activeRoomId ? 1 : 0;
  /** Capacity units held on the canonical host: rooms (and creations) or SDK sessions, whichever is larger. */
  const localLoad = () => Math.max(registry.load, coord ? coord.host.matches().reduce((load, match) => addLoad(load, matchLoad(match.teams.length)), 0) : 0);
  const admission = new Admission({
    maxMatches: config.maxMatches,
    maxQueue: config.maxQueue,
    lagThresholdMs: config.admissionLagMs,
    lagPercentile: config.admissionLagPercentile,
    lagWindowSeconds: config.admissionLagWindowSeconds,
    mainLagGatesWorkers: config.admissionMainLagGatesWorkers,
    active: () => addLoad(addLoad(localLoad(), pool.active), reserved()),
    accepting: () => !draining,
    estimatedMatchMs: 10 * 60_000,
  });
  // Omniscient grants are only ever pulled by the relay itself, which serves them at this delay only while every seat is a
  // built-in bot (a public game's relay uses that game's own public delay instead).
  const featuredPolicy = { allowOmniscient: true, minDelayMs: FEATURED_DELAY_MS, public: false };
  const game = manifest.id;
  const joinLimiter = new RateLimiter(config.joinsPerIpPerMin, 60_000);
  const playerLimiter = new RateLimiter(config.profileCallsPerMin, 60_000);
  /** Open player-console SSE streams per client IP (each one costs work on every trace event until it closes). */
  const playerStreams = new Map<string, number>();
  /** Coordination requests that change state, in flight on this node's coordinator (a handover lets them finish). */
  let mutations = 0;

  const http = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 });
  const transport = new WebSocketTransport({
    noServer: true, maxPayload: maxMessageBytes, pingInterval: 5000, pingMaxRetries: 3, perMessageDeflate: false,
    beforeUpgrade: (request) => {
      const origin = request.headers.get('origin') ?? undefined;
      const host = request.headers.get('host') ?? new URL(request.url).host;
      if (!originAllowed({ headers: { origin, host } }, config)) return new Response(null, { status: 403 });
    },
  });
  // Cluster mode: only this process's own matchMaker rooms upgrade here; other nodes' rooms are proxied to them.
  const localUpgrade = (req: IncomingMessage) => !pool.ownsUpgrade(req) && (cluster?.hostsUpgrade(req) ?? true);
  transport.attachToServer(http, { filter: localUpgrade });
  http.on('upgrade', (req, socket, head) => {
    if (localUpgrade(req)) return;
    if (!originAllowed(req, config)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (pool.ownsUpgrade(req)) pool.upgrade(req, socket, head);
    else cluster?.upgrade(req, socket, head);
  });

  let coord: Coordinator | undefined;
  /** The coordinator serves (cluster mode: this node became primary and restored its lobbies). */
  const serving = Promise.withResolvers<void>();
  void serving.promise.catch(() => {});
  const listening = Promise.withResolvers<number>();
  const demoted = Promise.withResolvers<void>();

  function createCoordinator(): Coordinator {
    const fence = cluster;
    let retired = false;
    let started: Promise<void> | undefined;
    // The playlist is seeded (logged with every entry and result); FEATURED_PLAYLIST=off plays the fixed Standard duel.
    const playlist = config.featuredMatch && config.featuredPlaylist
      ? new FeaturedPlaylist({ seed: config.featuredPlaylistSeed ?? randomInt(2 ** 32), log: (line) => console.log(line) })
      : undefined;
    /** Armies the next featured match may field: an FFA only while its larger capacity share is free (canStart). */
    let featuredMaxArmies = DUEL.length;
    /** The next featured match: its armies and colours, unseeded rules, bot seats and matchup label. */
    function featuredSetup() {
      const entry = playlist?.next({ maxArmies: featuredMaxArmies });
      if (!entry) {
        return {
          entry, armies: DUEL, rules: rulesOptions(resolveRules(config.rules)), label: '',
          botSeats: DUEL.flatMap(({ id }) => PLANES.map((role) => ({ team: id, role, level: DEFAULT_OPPONENT as string, options: {} as Record<string, number> }))),
        };
      }
      return { entry, armies: entry.armies.map(({ id, colour }) => ({ id, colour })), rules: featuredRules(entry, config.rules), label: entry.label, botSeats: featuredBotSeats(entry) };
    }
    const featuredFits = (load: number) => addLoad(addLoad(localLoad(), pool.active), load) <= config.maxMatches &&
      (config.simWorkers > 0 ? pool.canCreate(load) : localCapacity(load));
    const featured = config.featuredMatch ? createFeatured({
      open: async () => {
        const setup = featuredSetup();
        const armies = setup.armies.map((army) => army.id);
        const seats = setup.botSeats.map(({ team, role, level }) => ({ team, role, kind: 'bot' as const, level }));
        const openedAt = Date.now();
        // The relay asks until the match is over, then never again: its result teaches the playlist once.
        const finished = async (over: boolean, outcome: (team: ArmyId) => Outcome | Promise<Outcome>) => {
          if (over && setup.entry) {
            try {
              const outcomes = Object.fromEntries(await Promise.all(armies.map(async (team) => [team, await outcome(team)] as const)));
              playlist!.record(setup.entry, { outcomes, durationMs: Date.now() - openedAt });
            } catch (error) { console.log(`featured playlist #${setup.entry.n}: result unavailable (${String(error)})`); }
          }
          return over;
        };
        if (config.simWorkers > 0) {
          const seeding = matchSeeding(options.seed, setup.rules, undefined);
          const allocation = await pool.createLobby({
            identity: 'featured', seed: seeding.seed, speed: 1, featured: true, ...matchSides(setup.armies.map((army) => ({ id: army.id, alliance: army.colour }))),
            rules: seeding.rules,
            observerPolicy: featuredPolicy,
            assignments: armies.flatMap((team) => PLANES.map((role) => ({ team, role, owner: 'featured', kind: 'bot' as const }))),
            botSeats: setup.botSeats,
          });
          await allocation.start();
          const { roomId } = allocation;
          return {
            roomId, public: false, armies, seats, label: setup.label, delayMs: FEATURED_DELAY_MS,
            // The worker re-checks every omniscient frame against the live seats (featuredFrames).
            omniscient: allocation.match.readiness().seats.every((seat) => seat.kind === 'bot'),
            observe: (perspective, frame) => pool.observe(roomId, perspective, featuredGrant(perspective, armies, FEATURED_DELAY_MS), frame),
            ended: () => finished(allocation.match.over, (team) => allocation.match.outcome(team)),
            close: async () => { await pool.remove(roomId); },
          };
        }
        const { match, roomId } = await openMatch({ mode: 'agents', opponent: DEFAULT_OPPONENT, featured: true, armies: setup.armies, rules: setup.rules, botSeats: setup.botSeats });
        return {
          roomId, public: false, armies, seats, label: setup.label, delayMs: FEATURED_DELAY_MS, omniscient: builtInBotsOnly(match.seats()),
          observe: (perspective, frame) => observeMatch(match, featuredGrant(perspective, armies, FEATURED_DELAY_MS), frame),
          ended: () => finished(match.over, (team) => match.outcome(team)),
          close: async () => { await matchMaker.getLocalRoomById(roomId)?.disconnect(); },
        };
      },
      canStart: () => {
        if (!admission.healthy || admission.lagHolds(config.simWorkers === 0) || !featuredFits(1)) return false;
        featuredMaxArmies = playlist && featuredFits(matchLoad(MAX_ARMIES)) ? MAX_ARMIES : DUEL.length;
        return true;
      },
      // Public lobbies left on Watch live and rated matches, wherever they run: the coordinator holds both.
      publicGames: () => [...lobbies.featuredGames(), ...(ranked.matchmaker?.featuredGames() ?? [])],
      openPublic: (game) => ({
        roomId: game.roomId, public: true, armies: game.armies, seats: game.seats, label: game.label, omniscient: game.omniscient, delayMs: game.delayMs,
        // Every stream at the game's own public delay: the match itself refuses any grant below its policy.
        observe: (perspective, frame) => {
          const grant = featuredGrant(perspective, game.armies, game.delayMs);
          if (game.game.localMatch) return observeMatch(game.game.localMatch, grant, frame);
          try { return pool.observe(game.roomId, perspective, grant, frame); }
          catch { return () => {}; /* Released meanwhile: the relay sees it end. */ }
        },
        ended: () => game.game.match.over,
        // The game is its players': the relay only stops following it.
        close: async () => {},
        played: game.played,
      }),
      viewer: (req) => lobbies.viewer(req),
      maxMatchMs: config.maxMatchMs,
      viewerLimits: { total: config.featuredMaxViewers, perIp: config.featuredViewersPerIp, ip: (req) => clientIp(req, config) },
    }) : undefined;
    const dev: DevAdmin | undefined = config.devAdminToken
      ? createDevAdmin({ token: config.devAdminToken, registry, open: (o) => openMatch(o) })
      : undefined;
    // Cluster mode: owner-document writes pass only while this node holds the lease (a write issued during a stall
    // waits for the outcome), so a retired coordinator never overwrites its successor's newer records. History rows
    // are this host's own sessions and stay writable; deleting (pruning) them is the coordinator's.
    const commanderStore = storage && (fence ? fenced(fence, storage.commanders(game), ['saveKey', 'saveOwner', 'deleteOwner', 'saveArtifact', 'deleteArtifact']) : storage.commanders(game));
    const poolStore = storage && (fence ? fenced(fence, storage.pool(game), ['saveEntry', 'deleteEntry', 'saveArtifact']) : storage.pool(game));
    const logStore = storage && (fence ? fenced(fence, storage.commanderLog(game), ['append', 'appendVerdict', 'redact']) : storage.commanderLog(game));
    const historyStore = storage && (fence ? fenced(fence, storage.history(game), ['delete']) : storage.history(game));
    const connectionStore = storage && (fence ? fenced(fence, storage.connections(game), ['saveConnection', 'deleteConnection', 'saveClient', 'deleteClient']) : storage.connections(game));
    const host: GameHost = createPlayerThreeHost({
      definition: dev?.definition ?? definition,
      // Lobby probes/practice use the advertised duel, not every corner in the manifest.
      teams: ['nw', 'se'],
      maxMatches: Math.min(config.maxMatches, config.mainMaxMatches),
      ...(commanderStore && poolStore
        ? { commanderStore, poolStore }
        : config.dataDir
          ? { dataDir: config.dataDir, poolDir: join(config.dataDir, 'pool') }
          : {}),
      // Host default match rules (RULES_FILE / RULES_JSON): every match and practice run merges its own rules over them.
      ...(config.rules ? { matchOptions: config.rules } : {}),
      // Commander match log (PlayerThree SPEC §20.10.1): official (signed) only with RATED=on and RESULTS_SIGNING_KEY.
      commanderLog: {
        ...(logStore ? { store: logStore } : {}),
        ...(config.publicUrl ? { origin: config.publicUrl.origin } : {}),
        ...(config.rated ? { signer: config.rated.signer } : {}),
        verdict: (context) => ranked.verdict(context),
      },
      // Released matches stay in the operator console's Recent sessions (Postgres, HISTORY_DIR, else in memory).
      history: {
        maxSessions: config.historySessions,
        maxAgeMs: config.historyMs,
        maxBytes: config.historyBytes,
        ...(historyStore ? { store: historyStore } : config.historyDir ? { dir: config.historyDir } : {}),
      },
    });
    const profiles = new Profiles(storage ? postgresProfileStore(storage) : config.dataDir ? jsonProfileStore(config.dataDir) : undefined);
    const roster = createRosterApi({ config, host, profiles, registry, rated: { holds: (owner, id) => ranked.holds(owner, id), metadataEdit: (owner, id) => ranked.metadataEdit(owner, id) } });
    const bots = createBotPackagesApi({ config, host });
    // Player API behind the in-game agent console (@playerthree/console): a profile secret reads that profile's roster.
    const player = createPlayerApiHandler(host, {
      path: '/playerthree/player',
      owner: (req) => {
        const m = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(req.headers.authorization?.trim() ?? '');
        return m ? profiles.authenticate(m[1]!) : undefined;
      },
    });
    // Created in start(): the issuer is PUBLIC_URL, or this server's own origin once its port is known.
    let auth: AuthorizationServer | undefined;
    let mcp: McpRequestHandler | undefined;
    const accounts = config.github && storage ? new Accounts(storage, config.rated?.minAccountAgeMs ?? 30 * 86_400_000) : undefined;
    const github = accounts && config.github ? createGithubSignIn({ config, github: config.github, accounts, profileOf: (req) => roster.profileOf(req) }) : undefined;
    const connect = createConnectApi({ config, host, roster, auth: () => auth, ...(accounts ? { onConsent: (owner: string, client: string, redirectHost: string) => void accounts.note(owner, 'harness', `${client}\n${redirectHost}`).catch(() => {}) } : {}) });
    // Created in start() with the authorization server, so the console can list and revoke sign-in connections.
    let devtools: DevtoolsHandler | undefined;
    const lobbies = new LobbyService({
      config, host, profileOf: roster.profileOf, accepting: () => !draining, open: openLobbyMatch, playOwner, releaseAbandoned,
      ...(cluster && clusterPool ? {
        cluster: { checkpoints: cluster.checkpoints(), adopt: (roomId: string) => clusterPool.adopt(roomId) },
        maxLobbies: () => config.maxMatches * clusterPool.liveNodes(),
      } : {}),
    });
    const arena = createArenaService({ config, host, storage, profileOf: roster.profileOf, open: openLobbyMatch, lobbies, logQueue: (seriesId) => gauntlet?.owns(seriesId) ? 'gauntlet' : null });
    const gauntlet: Gauntlet | undefined = config.rated && storage && arena.series
      ? createGauntlet({ db: storage, host, rated: config.rated, series: arena.series, seedFor: arenaSeedSource(config.dataDir, config.arenaSeedKey) }) : undefined;
    const ranked: RankedService = createRankedService({ config, storage, host, accounts, open: openLobbyMatch, accepting: () => !draining, profileOf: (req) => roster.profileOf(req), gauntlet: () => gauntlet, acbench: (hashes) => benchmarks.acbench(hashes) });

    registerRoomDefinitions({
      [ROOM_NAME]: defineRoom(createAgentCommandRoom({
        config, registry, host, maxMessageBytes, tickRate: manifest.tickRate,
        isDraining: () => draining,
        recordTick: (lag, duration) => ticks.record(lag, duration),
        onReleased: (_roomId, duration) => { admission.released(duration); scheduleDrainCheck(); },
      })),
      [LOBBY_ROOM]: defineRoom(createLobbyRoom(lobbies)),
      [DIRECTORY_ROOM]: defineRoom(createLobbyRoom(lobbies, true)),
    });

    /** Operator/featured creation is not a public match setup API. */
    async function openMatch({ mode, opponent, seed, rules, armies = DUEL, featured = false, botSeats }: OpenMatch) {
      assertAcceptingMatches();
      const controllers: Record<string, Partial<Record<Plane, Controller>>> = {};
      const botLevel: Record<string, Opponent> = {};
      // The first army is yours (except agents); pvp seats a human on every army, otherwise the others are bots.
      for (const [index, { id }] of armies.entries()) {
        controllers[id] = seatControllers(index === 0 ? mode !== 'agents' : mode === 'pvp');
        botLevel[id] = index > 0 && mode !== 'pvp' ? opponent : DEFAULT_OPPONENT;
      }
      // A single room scheduler owns every production tick, including telemetry and nonoverlapping bot steps.
      const roomDriven = true;
      const opts: CreateMatchOptions<typeof definition.manifest> = {
        ...matchSides(armies.map((army) => ({ id: army.id, alliance: army.colour }))), controllers, botLevel, realtime: !roomDriven,
        // Private operator roots explicitly own each army's roles; distinct owners never span opposing armies.
        assignments: armies.flatMap(({ id }) => PLANES.map((role) => ({
          team: id, role, owner: `operator:${id}`, kind: controllers[id]![role]!, ownerControl: !featured,
        }))),
        ...(botSeats ? { botSeats } : {}),
      };
      // The featured showcase is watched only through its delayed relay (fogged armies, and All while all-bot).
      if (featured) opts.observerPolicy = featuredPolicy;
      const seeding = matchSeeding(seed ?? options.seed, rules ?? {}, config.rules);
      opts.seed = seeding.seed;
      opts.options = seeding.rules;
      let match;
      try {
        match = host.createMatch(opts);
        dev?.adopt(match);
      } catch (error) {
        if (!(error instanceof PlayerThreeError && error.code === 'busy')) throw error;
        throw new HttpError(409, 'busy');
      }
      if (options.warmupTicks) {
        try {
          await match.step(options.warmupTicks);
          if (match.over) throw new HttpError(409, 'warmup_ended');
        } catch (error) {
          match.dispose();
          throw error;
        }
      }
      const ticket = registry.ticket({ match, mode, createdAt: Date.now(), ...(featured ? { featured: true } : {}), ...(roomDriven ? { speed: featured ? 1 : config.simSpeed } : {}) });
      match.onEnd(scheduleDrainCheck);
      opening++;
      try {
        return { match, roomId: (await matchMaker.createRoom(ROOM_NAME, { ticket })).roomId };
      } catch {
        registry.drop(ticket);
        match.dispose();
        throw new HttpError(500, 'internal');
      } finally {
        opening--;
        scheduleDrainCheck();
      }
    }

    async function openLobbyMatch(
      identity: string,
      assignments: SeatAssignment[],
      rules: MatchOptions,
      queued: (state?: { position: number; estimatedWaitMs: number }) => void,
      current: () => boolean,
      settings: Partial<LobbyOpenOptions> & Pick<LobbyOpenOptions, 'teams' | 'alliances'>,
    ): Promise<LobbyMatch> {
      const workerAssignments = assignments.flatMap((seat) =>
        seat.kind === 'human' || seat.kind === 'bot' || seat.kind === 'none'
          ? [{ team: seat.team, role: seat.role, owner: seat.owner, kind: seat.kind, ...(seat.ownerControl === undefined ? {} : { ownerControl: seat.ownerControl }) }] : []);
      const remote = config.simWorkers > 0 && !identity.startsWith('arena:') && workerAssignments.length === assignments.length;
      // A match takes capacity by its army count: four armies wait for room for ~2.4 duels.
      const load = matchLoad(settings.teams.length);
      const allocate = async (): Promise<LobbyMatch> => {
        assertAcceptingMatches();
        if (!current()) throw new HttpError(409, 'not_open');
        opening++;
        let match: GameMatch | undefined;
        let creation: string | undefined;
        try {
          const seeding = matchSeeding(options.seed ?? settings.secretSeed, rules, config.rules);
          if (remote) {
            const game = await pool.createLobby({
              identity, assignments: workerAssignments, rules: seeding.rules, seed: seeding.seed, speed: settings.speed ?? 1,
              teams: settings.teams, alliances: settings.alliances,
              observerPolicy: settings.observerPolicy ?? { allowOmniscient: false, minDelayMs: 0, public: false },
              botSeats: settings.botSeats ?? [],
            }, settings.ownerKey);
            if (draining || !current()) { await game.close(); assertAcceptingMatches(); throw new HttpError(409, 'not_open'); }
            return game;
          }
          const controllers: Record<string, Partial<Record<Plane, Controller>>> = {};
          for (const seat of assignments) (controllers[seat.team] ??= {})[seat.role as Plane] = seat.kind;
          match = host.createMatch({
            assignments, controllers, botSeats: settings.botSeats, realtime: false, seed: seeding.seed,
            teams: settings.teams, alliances: settings.alliances,
            readySeconds: config.readySeconds, options: seeding.rules, observerPolicy: settings.observerPolicy,
            metricSampleEveryTicks: settings.metricSampleEveryTicks, ...(settings.lobby === undefined ? {} : { lobby: settings.lobby }),
            ...(settings.log === undefined ? {} : { log: settings.log }),
          });
          dev?.adopt(match);
          // Benchmark-only warmup (as on workers) uses this same exact allocation; production preparation stays at tick 0.
          if (options.warmupTicks) {
            match.skipReadyCheck();
            await match.step(options.warmupTicks);
            if (match.over) throw new HttpError(409, 'warmup_ended');
          } else match.holdStart();
          match.onEnd(scheduleDrainCheck);
          const live = {
            match, mode: 'pvp' as const, createdAt: Date.now(), speed: 0, preparing: true, ownerKey: settings.ownerKey,
            observerDelayMs: settings.observerPolicy?.minDelayMs ?? 0,
            maxLifeMs: settings.maxWallMs === undefined ? undefined : settings.maxWallMs + config.endGraceMs + (settings.observerPolicy?.minDelayMs ?? 0),
            idleExempt: identity.startsWith('arena:') || assignments.every((seat) => seat.kind !== 'human'),
          };
          creation = registry.ticket(live);
          const roomId = (await matchMaker.createRoom(ROOM_NAME, { ticket: creation })).roomId;
          let closing: Promise<void> | undefined;
          const allocated = match;
          const local: LobbyMatch = {
            match: allocated,
            localMatch: allocated,
            roomId,
            start() { allocated.skipReadyCheck(); live.preparing = false; live.speed = settings.speed ?? 1; },
            close() {
              return closing ??= (async () => {
                const room = matchMaker.getLocalRoomById(roomId);
                // Undecided, its players see the room closed without a result rather than try to rejoin it.
                try { await room?.disconnect(allocated.over ? undefined : MATCH_CLOSE.closed); }
                finally { allocated.dispose(); }
              })();
            },
          };
          // Cluster mode: served by room id, so a successor coordinator can adopt its lobby while it finishes here.
          const game = clusterPool && !identity.startsWith('arena:') ? await clusterPool.serveCanonical(local, load, settings.ownerKey) : local;
          if (draining || !current()) {
            await game.close();
            assertAcceptingMatches();
            throw new HttpError(409, 'not_open');
          }
          return game;
        } catch (error) {
          if (creation) registry.drop(creation);
          match?.dispose();
          throw error;
        } finally { opening--; scheduleDrainCheck(); }
      };
      let result: AdmissionResult<LobbyMatch>;
      try {
        result = await admission.submit(`lobby:${identity}`, allocate,
          () => remote
            ? pool.canCreate(load) && addLoad(addLoad(pool.active, reserved()), load) <= config.simWorkers * config.matchesPerWorker
            // A named commander still seated in a previous game waits in the queue instead of failing busy.
            : localCapacity(load) && assignments.every(({ owner, commander }) => !commander || !host.commanders.has(owner) ||
              !host.commanders.roster(owner).find((entry) => entry.id === commander.id)?.seated), load, !remote);
        while (result.state === 'queued') {
          if (!current() && admission.cancel(result.queue)) throw new HttpError(409, 'not_open');
          queued({ position: result.position, estimatedWaitMs: result.estimatedWaitMs });
          const delay = Promise.withResolvers<void>();
          setTimeout(delay.resolve, result.pollAfterMs);
          await delay.promise;
          result = admission.poll<LobbyMatch>(result.queue);
        }
      } catch (error) {
        if (error instanceof AdmissionError) throw new HttpError(503, error.code, error.code === 'server_updating' ? 'Server updating, try again in a moment' : undefined);
        throw error;
      }
      if (draining || !current()) {
        await result.result.close();
        assertAcceptingMatches();
        throw new HttpError(409, 'not_open');
      }
      queued();
      return result.result;
    }

    /** Count SDK-owned sessions too: practices and held matches can occupy the canonical host without a room. */
    function localCapacity(load = 1): boolean {
      return addLoad(addLoad(localLoad(), config.simWorkers === 0 ? reserved() : 0), load) <=
        Math.min(config.mainMaxMatches, config.maxMatches);
    }

    const securePlayCookie = config.publicUrl?.protocol === 'https:';
    const playCookieName = securePlayCookie ? '__Host-ac_play' : 'ac_play';
    const playCookie = new RegExp(`(?:^|;\\s*)${playCookieName}=([A-Za-z0-9_-]{32})(?:;|$)`);

    /**
     * Stable play owner for restart reclamation. Lobby visitor identities are minted per lobby, so anonymous browsers
     * get an opaque host-only HttpOnly cookie instead; an IP address is never an ownership credential.
     */
    function playOwner(req: IncomingMessage, res: ServerResponse, profile: string | undefined): string {
      if (profile !== undefined) return `profile:${profile}`;
      const existing = playCookie.exec(req.headers.cookie ?? '')?.[1];
      const session = existing ?? randomBytes(24).toString('base64url');
      if (!existing) res.setHeader('Set-Cookie', `${playCookieName}=${session}; Path=/; HttpOnly; SameSite=Strict${securePlayCookie ? '; Secure' : ''}`);
      return `visitor:${session}`;
    }

    /** Reclaim only unoccupied previous games; another human/agent, on either team, keeps the old match alive. */
    async function releaseAbandoned(ownerKey: string, profile: string | undefined): Promise<void> {
      // Shared lobbies have multiple owners; commander placement proves this profile's ownership there too.
      const commanders = profile !== undefined && host.commanders.has(profile) ? host.commanders.roster(profile) : undefined;
      for (const [, live] of registry.rooms()) {
        if (live.ownerKey === ownerKey || commanders?.some((commander) => commander.seated?.match === live.match.id)) {
          await live.abandonIfUnattended?.();
        }
      }
      await pool.abandonOwner(ownerKey);
    }

    /** Seat reservation for `client.joinById(roomId, { token })`. The token is checked against the room's match first. */
    async function joinById(req: IncomingMessage, res: ServerResponse, roomId: string) {
      const retry = joinLimiter.take(clientIp(req, config));
      if (retry > 0) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retry) });
      const options = await readJson(req, MATCHMAKE_BODY_BYTES);
      const token = typeof options === 'object' && options !== null && 'token' in options ? options.token : undefined;
      const watch = typeof options === 'object' && options !== null && 'watch' in options ? options.watch : undefined;
      const view = typeof options === 'object' && options !== null && 'view' in options ? options.view : undefined;
      const live = registry.get(roomId);
      const lobbyAdmission = lobbies.admits(roomId, token);
      if (!live && !lobbyAdmission) {
        assertAcceptingMatches();
        return sendJson(res, 404, { error: 'room_not_found' });
      }
      if (!lobbyAdmission) {
        const auth = typeof token === 'string' && TOKEN_RE.test(token) ? host.authenticate(token) : undefined;
        if (!auth || auth.match.id !== live?.match.id) return sendJson(res, 401, { error: 'bad_token' });
      }
      try {
        // Only the fields the room reads travel on; the binding re-validates both.
        const reservation = await matchMaker.joinById(roomId, { token, watch, view }, createAuthContext({
          headers: req.headers as Record<string, string | undefined>,
          remoteAddress: clientIp(req, config),
        }));
        sendJson(res, 200, reservation);
      } catch (e) {
        sendJson(res, e instanceof ServerError ? 400 : 500, { error: 'join_failed' });
      }
    }

    async function route(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<boolean> {
      if (featured?.handle(req, res, path)) return true;
      // Rated routes, cards, leaderboard and the results keys (404 unless RATED=on).
      if (await ranked.handle(req, res, url)) return true;
      if (path === '/mcp') { await (mcp ? mcp(req, res) : sendJson(res, 503, { error: 'starting' })); return true; }
      if (await connect.handleOAuth(req, res, path)) return true;
      if (path === '/playerthree/devtools' || path.startsWith('/playerthree/devtools/')) {
        if (devtools && await devtools.handle(req, res)) return true;
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      if (path === '/playerthree/player' || path.startsWith('/playerthree/player/')) {
        if (await player.handle(req, res)) return true;
      }
      // Dev-admin (AC_DEV_ADMIN_TOKEN only): fail closed, never falls through to the SPA fallback.
      if (path === '/dev' || path.startsWith('/dev/')) {
        await (dev ? dev.handle(req, res, path) : sendJson(res, 404, { error: 'not_found' }));
        return true;
      }
      if (path.startsWith('/arena/share/')) { if (await arena.handle(req, res, path)) return true; }
      if (!path.startsWith('/api/') && !path.startsWith('/matchmake/')) return false;
      if (cors(req, res, config)) return true;
      if (await modelCatalog(req, res, url)) return true;
      if (await benchmarks.handle(req, res, url)) return true;
      if (await github?.handle(req, res, path)) return true;
      if (await lobbies.handle(req, res, path)) return true;
      if (await arena.handle(req, res, path)) return true;
      if (path === '/api/maps') {
        if (req.method !== 'GET') sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        else sendJson(res, 200, { maps: MAPS });
        return true;
      }
      if (path === '/api/capacity') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
          return true;
        }
        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();
        sendJson(res, 200, {
          active: addLoad(localLoad(), pool.active), maxMatches: config.maxMatches, queued: admission.queued, accepting: admission.accepting(config.simWorkers === 0),
          eventLoop: admission.eventLoop, ticks: ticks.snapshot(),
          process: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, uptimeSeconds: process.uptime() },
          // Load only: worker room ids (private matches included) are not public.
          workers: pool.stats().map(({ rooms: _rooms, ...worker }) => worker),
          mainMaxMatches: config.mainMaxMatches, featured: featured?.stats(),
        });
        return true;
      }
      if (await connect.handle(req, res, path)) return true;
      if (await roster.handle(req, res, path)) return true;
      if (bots.handle(req, res, path)) return true;
      const join = /^\/matchmake\/joinById\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (join && req.method === 'POST') { await joinById(req, res, join[1]!); return true; }
      if (draining && path.startsWith('/matchmake/')) assertAcceptingMatches();
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }

    /** Close what coordinates; the host and its live matches stay (they finish here). */
    async function retire(handover: boolean): Promise<void> {
      if (retired) return;
      retired = true;
      await started?.catch(() => {});
      if (handover) {
        const until = performance.now() + HANDOVER_SETTLE_MS;
        while (mutations > 0 && performance.now() < until) {
          const settled = Promise.withResolvers<void>();
          setTimeout(settled.resolve, 50);
          await settled.promise;
        }
      }
      // Viewers' streams end here; their browsers reconnect, to the successor.
      await featured?.close();
      await lobbies.retire();
      // Releases its series leases: the successor's runner resumes them.
      await arena.close();
      gauntlet?.close();
      await ranked.close();
      github?.close();
      auth?.close();
      // Every accepted write reaches the store before the lease goes; the fence drops any later one.
      await Promise.all([host.commanders.flush(), host.history.flush(), profiles.flush()]);
      console.log('coordinator retired: live main-process matches finish here; lobbies, OAuth and agents are the successor\'s');
    }

    return {
      host, ranked, featured,
      get retired() { return retired; },
      route,
      async serveRetired(req, res, path) {
        const join = /^\/matchmake\/joinById\/([A-Za-z0-9_-]{1,64})$/.exec(path);
        if (join && req.method === 'POST' && registry.get(join[1]!)) {
          await joinById(req, res, join[1]!);
          return true;
        }
        if (path !== '/mcp' && path !== '/playerthree/player' && !path.startsWith('/playerthree/player/')) return false;
        const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization?.trim() ?? '')?.[1];
        const seat = token && TOKEN_RE.test(token) ? host.authenticate(token) : undefined;
        if (!seat || seat.match.over) return false;
        if (path === '/mcp') { await (mcp ? mcp(req, res) : sendJson(res, 503, { error: 'starting' })); return true; }
        return await player.handle(req, res);
      },
      start(port) {
        started ??= (async () => {
          await Promise.all([host.ready, profiles.ready]);
          const issuer = config.publicUrl?.origin ?? `http://${config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host}:${port}`;
          const issuerUrl = new URL(issuer);
          // Local development (a loopback http issuer, e.g. the Vite dev server): this server's own loopback origins are
          // the same MCP endpoint, so harnesses configured with either URL sign in. Production: PUBLIC_URL only.
          const loopbackIssuer = issuerUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname);
          auth = createAuthorizationServer(host, {
            issuer,
            ...(loopbackIssuer ? { aliases: [`http://localhost:${port}`, `http://127.0.0.1:${port}`].filter((o) => o !== issuer) } : {}),
            mcpPath: '/mcp',
            consentUrl: (requestId) => `/connect?r=${encodeURIComponent(requestId)}`,
            ...(connectionStore ? { store: connectionStore } : config.dataDir ? { dataDir: config.dataDir } : {}),
            // Development only: harness metadata documents served from localhost.
            allowLoopbackClients: loopbackIssuer,
            onError: (e) => console.error('oauth:', e),
          });
          await auth.ready;
          mcp = createMcpRequestHandler(host, { auth });
          // Operator console: local mode (direct localhost only, no credential) unless OPERATOR_TOKEN is set.
          if (config.devtools) {
            devtools = createDevtoolsHandler(host, {
              path: '/playerthree/devtools',
              oauth: auth,
              ...(config.operatorToken ? { operatorToken: config.operatorToken } : {}),
              ...(config.benchResultsDir ? { benchResultsDir: config.benchResultsDir } : {}),
              ...(config.safetyCard ? { safetyCard: config.safetyCard } : {}),
            });
          }
          // Cluster mode: the previous primary's lobbies, their matches adopted where they run.
          await lobbies.restore();
        })();
        return started;
      },
      beginDrain() {
        lobbies.beginDrain();
        void featured?.close().then(scheduleDrainCheck, () => {
          console.error('featured shutdown failed during drain');
          scheduleDrainCheck();
        });
      },
      retire,
      async closeServices() {
        if (retired) return;
        await lobbies.close();
        await arena.close();
        gauntlet?.close();
        await ranked.close();
        github?.close();
      },
      async closeHost() {
        await mcp?.close();
        auth?.close();
        connect.close();
        devtools?.close();
        player.close();
        roster.close();
        bots.close();
        host.dispose();
        // Disposing released the live matches into the history: finish writing them before the process exits.
        await Promise.all([host.history.flush(), host.commanders.flush(), profiles.flush()]);
      },
    };
  }

  /**
   * Player console mount, local or forwarded to a worker: a per-IP request budget and a cap on concurrent streams.
   * Seat capabilities are cheap to obtain (Quick Play), so authentication alone does not bound this work.
   * Returns false once it has answered.
   */
  function admitPlayer(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const ip = clientIp(req, config);
    const retry = playerLimiter.take(ip);
    if (retry > 0) { sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retry) }); return false; }
    if (path !== '/playerthree/player/stream') return true;
    const open = playerStreams.get(ip) ?? 0;
    if (open >= PLAYER_STREAMS_PER_IP) { sendJson(res, 429, { error: 'stream_capacity' }); return false; }
    playerStreams.set(ip, open + 1);
    res.once('close', () => {
      const left = (playerStreams.get(ip) ?? 1) - 1;
      if (left > 0) playerStreams.set(ip, left);
      else playerStreams.delete(ip);
    });
    return true;
  }

  /** The serving coordinator, waiting out a promotion in progress (cluster mode) up to the failover bound. */
  async function serveCoordinator(): Promise<Coordinator | undefined> {
    const timer = Promise.withResolvers<void>();
    const timeout = setTimeout(timer.resolve, FAILOVER_WAIT_MS);
    try { await Promise.race([serving.promise, timer.promise]); } catch { /* A failed start answers 503 below. */ }
    finally { clearTimeout(timeout); }
    return coord && !coord.retired && (!cluster || cluster.primary) ? coord : undefined;
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    securityHeaders(res, config);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    // API errors and private capabilities are never search results. Public HTML opts in explicitly below.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

    // Edge checks for routes the pool may forward to a worker (worker rooms, their seat tokens) before it does.
    if (path.startsWith('/matchmake/') && !originAllowed(req, config)) throw new HttpError(403, 'forbidden_origin');
    if ((path === '/playerthree/player' || path.startsWith('/playerthree/player/')) && !admitPlayer(req, res, path)) return;
    if (await pool.handle(req, res)) return;
    // Cluster mode: a retired coordinator still answers for its own live matches.
    if (coord?.retired && await coord.serveRetired(req, res, path)) return;
    // Cluster mode: a node that is not the primary forwards coordination traffic to it.
    if (await cluster?.route(req, res, path)) return;
    if (path === '/healthz') {
      // Health does not read publication storage or optional catalogue providers.
      // Matches in duel capacity units (a four-army match counts ~2.4), the unit of `maxMatches`.
      return sendJson(res, draining ? 503 : 200, { ok: !draining, draining, matches: addLoad(localLoad(), pool.active), maxMatches: config.maxMatches });
    }
    if (coordination(path)) {
      const serving = await serveCoordinator();
      if (!serving) return sendJson(res, 503, { error: 'cluster_unavailable' }, { 'Retry-After': '1' });
      if (cluster && req.method !== 'GET' && req.method !== 'HEAD') {
        mutations++;
        res.once('close', () => { mutations--; });
      }
      if (await serving.route(req, res, url, path)) return;
    }
    if (redirectToCanonical(req, res, url, config)) return;
    if (await benchmarks.handle(req, res, url)) return;
    if (await publicPages(req, res, url)) return;
    if (await serveStatic(req, res, path, config.webDist)) return;
    sendJson(res, 404, { error: 'not_found' });
  }

  http.on('request', (req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (e instanceof AdmissionError) sendJson(res, e.code === 'queue_expired' ? 410 : e.code === 'already_queued' ? 409 : 503, { error: e.code }, { 'Retry-After': '5' });
      else if (e instanceof HttpError) sendJson(res, e.status, { error: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) });
      else { console.error(`${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname} failed`, e); sendJson(res, 500, { error: 'internal' }); }
    });
  });

  /** Cluster mode: this process just took the lease (once per process): build the coordinator from the stores. */
  function promote(): void {
    void (async () => {
      const port = await listening.promise;
      // Demoted before it could even start: this process never coordinates.
      if (cluster!.retired) return;
      coord = createCoordinator();
      await coord.start(port);
      if (cluster!.retired) return await coord.retire(false);
      coord.featured?.start();
      serving.resolve();
      console.log(`cluster: coordinator serving on node ${cluster!.nodeId}`);
    })().catch((error: unknown) => {
      console.error('cluster: coordinator failed to start', error);
      serving.reject(error);
    });
  }

  // Without cluster mode the coordinator exists from the start (tests read `host` before listening).
  if (!cluster) coord = createCoordinator();

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    draining = true;
    clearTimeout(drainCap);
    clearInterval(drainLog);
    drainDone?.();
    closePromise = (async () => {
      admission.close();
      // Players of live matches hear "server restarted" first: nothing later may reach them as a result.
      await closeRoomsWithoutResult('restart');
      await coord?.featured?.close();
      await pool.close('restart');
      await coord?.closeServices();
      // Persist already-recorded terminal receipts before tearing down the remaining client transports.
      await coord?.host.commanders.flush();
      await matchMaker.gracefullyShutdown().catch(() => {});
      transport.shutdown();
      await cluster?.close();
      await coord?.closeHost();
      joinLimiter.close();
      playerLimiter.close();
      const done = Promise.withResolvers<void>();
      http.close(() => done.resolve());
      http.closeAllConnections();
      await done.promise;
    })();
    return closePromise;
  }

  return {
    http,
    get host() {
      if (!coord) throw new Error('this node is not the cluster primary: it has no coordinator');
      return coord.host;
    },
    get ranked() {
      if (!coord) throw new Error('this node is not the cluster primary: it has no coordinator');
      return coord.ranked;
    },
    demoted: demoted.promise,
    drain() {
      if (closePromise) return closePromise;
      if (drainPromise) return drainPromise;
      draining = true;
      pool.beginDrain();
      // Cluster mode: lobbies, OAuth and agents move to the successor; this node's live matches finish here.
      if (cluster) void cluster.handover(async () => { await coord?.retire(true); }).then(scheduleDrainCheck);
      else coord?.beginDrain();
      const done = Promise.withResolvers<void>();
      drainDone = done.resolve;
      drainPromise = done.promise.then(close);
      const progress = () => console.log(`draining: ${liveMatches().length + simulations.active} live match(es) remaining`);
      progress();
      drainLog = setInterval(progress, config.drainLogIntervalMs);
      drainCap = setTimeout(() => void (async () => {
        for (const match of liveMatches()) console.log(`drain cap: interrupting match ${match.id} (server update; outcome unknown)`);
        await closeRoomsWithoutResult('update');
        for (const match of liveMatches()) match.dispose();
        await pool.close('update');
        // The cap bounds terminal grace too: decided rooms retain their outcomes, then normal close flushes them.
        // Waiting for their ordinary release here could outlive both the cap and the process cleanup deadline.
        done.resolve();
      })(), config.drainMaxMs);
      checkDrain();
      return drainPromise;
    },
    async listen() {
      await Promise.all([coord?.host.ready, pool.start()]);
      await (cluster ? matchMaker.setup(...cluster.colyseus()) : matchMaker.setup());
      await matchMaker.accept();
      // Forwarded requests and upgrades re-enter this process's own public handlers.
      await cluster?.start({
        request: (req, res) => http.emit('request', req, res),
        upgrade: (req, socket, head) => http.emit('upgrade', req, socket, head),
        promote,
        demoted: () => {
          void coord?.retire(false).finally(() => demoted.resolve());
          if (!coord) demoted.resolve();
        },
      });
      const opened = Promise.withResolvers<void>();
      http.once('error', opened.reject);
      http.listen(config.port, config.host, () => {
        http.off('error', opened.reject);
        opened.resolve();
      });
      await opened.promise;
      const port = (http.address() as AddressInfo).port;
      listening.resolve(port);
      if (coord && !cluster) await coord.start(port);
      // Pressure sampling starts once the bootstrap is done (cluster mode: before any promotion).
      admission.start();
      if (coord && !cluster) {
        coord.featured?.start();
        serving.resolve();
      }
      return port;
    },
    close,
  };
}
