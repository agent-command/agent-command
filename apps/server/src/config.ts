/** Server configuration from environment variables. Every limit has a public-demo-safe default. */
import { fileURLToPath } from 'node:url';
import { availableParallelism, networkInterfaces } from 'node:os';
import type { MatchOptions } from '@agent-command/game';
import { parseResultsSigner, resultsPublicKey } from 'playerthree/results';
import type { ResultsKey, ResultsSigner } from 'playerthree/results';
import { loadHostRules } from './rules.ts';

export interface ServerConfig {
  /** `PORT` (default 2567). 0 picks a free port. */
  port: number;
  /** `HOST` (default 0.0.0.0). */
  host: string;
  /** `PUBLIC_URL`, e.g. https://agent-command.example. Adds its origin to the allowed origins; https enables HSTS. */
  publicUrl?: URL;
  /** `CORS_ORIGINS`: comma-separated extra origins allowed to call /api and /matchmake cross-origin. */
  corsOrigins: string[];
  /** `TRUST_PROXY=1`: take the client IP from the last `X-Forwarded-For` hop (set it only behind a proxy you run). */
  trustProxy: boolean;
  /** `MAX_MATCHES`: aggregate live cap (default main cap + worker caps). */
  maxMatches: number;
  /**
   * `DRAIN_MAX_SECONDS` (default 1200): bound the whole SIGTERM drain, including finished rooms' terminal grace.
   * Still-running matches then close for their players (`MATCH_CLOSE.update`) with interrupted/unknown results.
   */
  drainMaxMs: number;
  /** `DRAIN_LOG_INTERVAL_SECONDS` (default 30): log the remaining live match count during a drain. */
  drainLogIntervalMs: number;
  /** `MAX_QUEUE` (default 500): bounded FIFO waiting places, at most one per lobby/series admission identity. */
  maxQueue: number;
  /**
   * `ADMISSION_LAG_MS` (default 25): event-loop delay that pauses admission. On the main thread it is compared with the
   * `ADMISSION_LAG_PERCENTILE` (default 95) of a rolling `ADMISSION_LAG_WINDOW_SECONDS` (default 10) window, so one slow
   * tick never pauses admission but sustained lag does; workers use their own ten-second p95 against the same value.
   */
  admissionLagMs: number;
  admissionLagPercentile: number;
  admissionLagWindowSeconds: number;
  /**
   * `ADMISSION_MAIN_LAG_GATES_WORKERS=1`: main-thread lag also holds matches placed on simulation workers. Default off:
   * a worker match waits only on its worker's lag/CPU headroom and the pool's capacity.
   */
  admissionMainLagGatesWorkers: boolean;
  /** `FEATURED_MATCH=0` disables the reserved read-only live showcase. */
  featuredMatch: boolean;
  /**
   * `FEATURED_PLAYLIST` (default `on`): the featured match follows the seeded playlist (featured-playlist.ts: maps,
   * sizes, duels and FFAs, bot levels and rules showcases); `off` plays the fixed Standard duel on the host rules.
   */
  featuredPlaylist: boolean;
  /** `FEATURED_PLAYLIST_SEED` (0 to 2³²−1): pins the playlist; unset draws one at startup (logged either way). */
  featuredPlaylistSeed?: number;
  /** `FEATURED_MAX_VIEWERS` (default 500): total featured SSE readers, independent of match-room observers. */
  featuredMaxViewers: number;
  /** `FEATURED_VIEWERS_PER_IP` (default 8): concurrent featured streams per trusted client IP. */
  featuredViewersPerIp: number;
  /** `SIM_WORKERS` (default up to 7, leaving one core for HTTP/MCP). 0 runs all matches locally. */
  simWorkers: number;
  /** `MATCHES_PER_WORKER` (default 8): safety ceiling, not an asserted production capacity. */
  matchesPerWorker: number;
  /** `SIM_WORKER_CPU_PERCENT` (default 75): rolling worker CPU headroom, 100 = one core. */
  simWorkerCpuPercent: number;
  /** `MAIN_MAX_MATCHES` (default 8): profiled/agent matches hosted on the main thread. Railway measured ~0.065 core per match; main-loop lag admission still protects roster, MCP and HTTP responsiveness. */
  mainMaxMatches: number;
  /** `MATCHES_PER_IP` per `MATCH_RATE_WINDOW_S` (default 30 per 600 s): lobby creations per client IP, the only match creation path. An abuse guard only, so it allows normal restarts and shared office/campus IPs; the admission queue protects capacity. */
  matchesPerIp: number;
  matchRateWindowMs: number;
  /** `JOINS_PER_IP_PER_MIN` (default 120): matchmaking join requests. */
  joinsPerIpPerMin: number;
  /** `MAX_MATCH_MINUTES` (default 45): hard cap on a match's wall-clock life. */
  maxMatchMs: number;
  /** `ABANDON_GRACE_SECONDS` (default 60): reconnect grace after the last authorized player or live agent leaves. Spectators do not count. */
  abandonGraceMs: number;
  /** `END_GRACE_SECONDS` (default 120): keep a finished match around so players can read the report. */
  endGraceMs: number;
  /** `MAX_CLIENTS_PER_ROOM` (default 16): players, agents and spectators; observers have their own cap. */
  maxClientsPerRoom: number;
  /** `MAX_OBSERVERS_PER_ROOM` (default 500): read-only observers share one encoded frame stream (fan-out only). */
  maxObserversPerRoom: number;
  /** `SIM_SPEED` (default 1): game ticks per real tick. >1 fast-forwards matches (dev and smoke tests). */
  simSpeed: number;
  /** `WEB_DIST` (default apps/web/dist). Static files for the browser client. */
  webDist: string;
  /**
   * `PLAYERTHREE_DEVTOOLS=0` disables /playerthree/devtools, PlayerThree's operator console (default on). Without `OPERATOR_TOKEN` it
   * answers only direct localhost requests with a localhost Host (pnpm dev); through a proxy or from another machine it
   * refuses everything. With `NODE_ENV=production` it is mounted only when `OPERATOR_TOKEN` is set.
   */
  devtools: boolean;
  /**
   * `OPERATOR_TOKEN` (32–512 printable ASCII characters, e.g. `openssl rand -base64 32`): opens the operator console on
   * a deployment (store it as a secret, e.g. a Railway variable). Accepted only over HTTPS (or from loopback) as
   * `Authorization: Bearer`; the console page asks for it once per tab.
   */
  operatorToken?: string;
  /**
   * `DATABASE_URL` (postgres://…): keep profiles, commander rosters, OAuth connections, the published-policy pool and
   * the session history in Postgres (playerthree/postgres; migrations applied at startup). Wins over DATA_DIR and
   * HISTORY_DIR.
   */
  databaseUrl?: string;
  /**
   * Cluster mode (README “Cluster mode”): `REDIS_URL` (redis:// or rediss://) shares one Redis between server
   * processes. The node holding the Redis lease (the primary) is the single writer for lobbies, admission, the
   * canonical host and the featured match; every node hosts simulations and proxies traffic. Unset: one process.
   * With it: `CLUSTER_SECRET` (32–512 printable ASCII, authenticates node-to-node traffic), `CLUSTER_PORT` (the
   * internal listener, never the public port), `CLUSTER_HOST` (its bind address, default `::` for an IPv6
   * `CLUSTER_ADDRESS`, else 0.0.0.0) and `CLUSTER_ADDRESS` (how other nodes reach that listener, e.g.
   * `http://[fd12::1]:3568`; default: this host's first non-internal interface address and `CLUSTER_PORT`).
   */
  cluster?: ClusterConfig;
  /**
   * `DATA_DIR` (the no-database fallback, e.g. a mounted volume): persist profiles, commander rosters (policy
   * libraries), OAuth connections and the published-policy pool as files here. Unset: in memory.
   */
  dataDir?: string;
  /**
   * `ARENA_SEED_KEY` (32 random bytes as 64 hex characters, `openssl rand -hex 32`): private material that derives
   * hosted arena world seeds; keep it secret and stable across restarts. Required with `DATABASE_URL` unless `DATA_DIR`
   * holds the generated `arena-seed-key` file, and with `REDIS_URL`, where every node must derive the same worlds.
   */
  arenaSeedKey?: string;
  /**
   * `HISTORY_DIR`: keep the operator console's recent sessions (record + replay of every match the server released)
   * in this directory so they survive restarts. Unset (the production default): in memory only. `pnpm dev` sets
   * `<DATA_DIR>/history`.
   */
  historyDir?: string;
  /** Bounds of that history: `HISTORY_SESSIONS` (default 50), `HISTORY_HOURS` (default 24), `HISTORY_MB` of replays (default 64). */
  historySessions: number;
  historyMs: number;
  historyBytes: number;
  /** `BENCH_RESULTS_DIR`: bench output (`pnpm bench`) listed in the console's Bench section. `pnpm dev` sets `<repo>/bench-results`. */
  benchResultsDir?: string;
  /** `SAFETY_CARD`: the Safety Card (`playerthree audit … --out`) shown in the console's Safety section. `pnpm dev` sets `<repo>/SAFETY.md`. */
  safetyCard?: string;
  /** `MAX_PROFILES` (default 10000). */
  maxProfiles: number;
  /** `PROFILES_PER_IP` per hour (default 10): profile creation. */
  profilesPerIp: number;
  /** `PROFILE_CALLS_PER_MIN` (default 240): profile API calls per IP (roster polling included). */
  profileCallsPerMin: number;
  /** `OAUTH_CALLS_PER_MIN` (default 120): sign-in endpoint calls (/oauth/*, /.well-known/oauth-*) per IP. */
  oauthCallsPerMin: number;
  /** `OAUTH_REGISTRATIONS_PER_HOUR` (default 20): dynamic client registrations per IP. */
  oauthRegistrationsPerHour: number;
  /** `READY_SECONDS` (default 90): how long a ready check waits for preferred agents before the match starts anyway. */
  readySeconds: number;
  /** `LOBBY_RESERVATION_SECONDS` (default 30): unacknowledged slot/socket admission hold. */
  lobbyReservationMs: number;
  /** `LOBBY_RECOVERY_SECONDS` (default 45): disconnected pregame or live-human army recovery grace. */
  lobbyRecoveryMs: number;
  /** `LOBBY_COUNTDOWN_SECONDS` (default 3): ready lobby's visible start countdown. */
  lobbyCountdownMs: number;
  /** `INVITE_MINUTES` (default 15): lifetime of an unstarted lobby and its code. */
  inviteMs: number;
  /**
   * `AC_DEV_ADMIN_TOKEN` (16–256 chars of [A-Za-z0-9_-]): enables the dev-admin API `/dev/*` (match control, god view,
   * cheats) for loopback clients presenting it as a Bearer token. Unset (default): `/dev/*` does not exist. Local
   * development only; `pnpm dev` generates one. Refused with `NODE_ENV=production`.
   */
  devAdminToken?: string;
  /**
   * Host default match rules (DESIGN §2.1): `RULES_FILE` (path to a JSON file) or `RULES_JSON` (the JSON inline), any
   * subset of the game's match rules, validated at startup (out-of-bounds values stop the server with the field and
   * its bounds). Unset: the game's defaults. Every match and practice run merges its own rules over these.
   */
  rules?: MatchOptions;
  /**
   * GitHub sign-in (DESIGN §Ladder): `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` of a GitHub OAuth app whose callback
   * is `<PUBLIC_URL>/api/auth/github/callback`. Needs `DATABASE_URL` (accounts live there). `GITHUB_OAUTH_URL` /
   * `GITHUB_API_URL` replace the github.com endpoints (tests run a fake provider). Unset: no sign-in.
   */
  github?: GithubConfig;
  /**
   * Rated play (D9): only with `RATED=on` *and* `RESULTS_SIGNING_KEY`; otherwise every rated route is absent and
   * commander log entries are unofficial. See `RatedConfig`.
   */
  rated?: RatedConfig;
}

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** `https://github.com` (authorize and token endpoints live under `/login/oauth/`). */
  oauthUrl: string;
  /** `https://api.github.com` (`/user`). */
  apiUrl: string;
}

/**
 * The official host's rated configuration. `RESULTS_SIGNING_KEY`: an Ed25519 PKCS#8 private key (PEM, or one line of
 * base64/base64url DER: `openssl genpkey -algorithm ed25519 -outform DER | base64 -w0`), a deployment secret.
 * `RESULTS_KEY_SINCE` (ISO date, default the epoch): when the current key became valid. `RESULTS_RETIRED_KEYS`: JSON
 * array of earlier published keys `{keyId, publicKey, from, until, revokedAt?}` kept for verification after rotation.
 */
export interface RatedConfig {
  signer: ResultsSigner;
  /** The published verification keys (`/.well-known/agent-command/results-keys.json`). */
  keys: ResultsKey[];
  /** `RATED_QUEUE_JOIN_SECONDS` (default 10): one queue join per account per this many seconds. */
  queueJoinMs: number;
  /** `RATED_MATCHES_PER_DAY` (default 60): rated matches per account per day. */
  matchesPerDay: number;
  /** `RATED_METADATA_EDITS_PER_DAY` (default 3): declared-metadata edits per commander per day (each starts a segment). */
  metadataEditsPerDay: number;
  /** `RATED_READY_SECONDS` (default 60): a found live match waits this long for every agent to mark ready. */
  readyMs: number;
  /** `RATED_DODGES` (default 3) dodges within `RATED_DODGE_HOURS` (default 24) lock the queue for `RATED_DODGE_LOCK_MINUTES` (default 30). */
  dodges: { count: number; windowMs: number; lockMs: number };
  /** `RATED_MIN_ACCOUNT_DAYS` (default 30): GitHub account age for rated play (D2). */
  minAccountAgeMs: number;
  /** `RATED_REPLAY_DAYS` (default 180): rated replays kept outside history pruning (D10). */
  replayMs: number;
  /** `RATED_MAPS` (`map:layout,…`): the season map pool; default every supported authored-map 1v1 and FFA layout. */
  maps?: { map: string; layout: string }[];
}

export interface ClusterConfig {
  redisUrl: string;
  secret: string;
  port: number;
  host: string;
  /** Origin of this node's internal listener as seen by the other nodes (`http://host:port`). */
  address: string;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return n;
}

function onOff(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'on' && raw !== 'off') throw new Error(`${key} must be on or off`);
  return raw === 'on';
}

/**
 * This host's address for node-to-node traffic: a private IPv6 ULA (fc00::/7, e.g. Railway's private network) first,
 * else the first other non-internal, non-link-local address.
 */
function interfaceAddress(): string | undefined {
  const entries = Object.values(networkInterfaces()).flatMap((list) => list ?? []).filter((entry) => !entry.internal && !entry.address.startsWith('fe80:'));
  const entry = entries.find((candidate) => candidate.family === 'IPv6' && /^f[cd]/i.test(candidate.address)) ?? entries[0];
  if (!entry) return undefined;
  return entry.family === 'IPv6' ? `[${entry.address}]` : entry.address;
}

function loadCluster(env: NodeJS.ProcessEnv, publicPort: number): ClusterConfig | undefined {
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    if (env.CLUSTER_SECRET || env.CLUSTER_PORT || env.CLUSTER_HOST || env.CLUSTER_ADDRESS) throw new Error('CLUSTER_* settings require REDIS_URL');
    return undefined;
  }
  if (!/^rediss?:\/\/\S+$/.test(redisUrl)) throw new Error('REDIS_URL must be a redis:// or rediss:// connection string');
  const secret = env.CLUSTER_SECRET;
  if (!secret || !/^[\x21-\x7e]{32,512}$/.test(secret)) throw new Error('CLUSTER_SECRET (required with REDIS_URL) must be 32–512 printable ASCII characters without spaces (openssl rand -base64 32)');
  if (!env.CLUSTER_PORT) throw new Error('CLUSTER_PORT is required with REDIS_URL');
  const port = int(env, 'CLUSTER_PORT', 0, 1, 65535);
  if (port === publicPort) throw new Error('CLUSTER_PORT must differ from PORT: the internal listener is never the public one');
  let address: URL;
  if (env.CLUSTER_ADDRESS) {
    address = new URL(env.CLUSTER_ADDRESS);
    if (address.protocol !== 'http:' || address.pathname !== '/' || address.search || address.hash || address.username || address.password) throw new Error('CLUSTER_ADDRESS must be an http://host:port origin');
  } else {
    const host = interfaceAddress();
    if (!host) throw new Error('CLUSTER_ADDRESS is required: no non-internal network interface found');
    address = new URL(`http://${host}:${port}`);
  }
  const host = env.CLUSTER_HOST || (address.hostname.startsWith('[') ? '::' : '0.0.0.0');
  return { redisUrl, secret, port, host, address: address.origin };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const publicUrl = env.PUBLIC_URL ? new URL(env.PUBLIC_URL) : undefined;
  if (publicUrl && publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') throw new Error('PUBLIC_URL must be http(s)');
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin);
  const production = env.NODE_ENV === 'production';
  const rated = loadRated(env, {
    publicUrl, databaseUrl: env.DATABASE_URL, devAdmin: !!env.AC_DEV_ADMIN_TOKEN, simSpeed: env.SIM_SPEED ?? '1',
    localDevtools: env.PLAYERTHREE_DEVTOOLS !== '0' && !env.OPERATOR_TOKEN && !production, hostRules: !!(env.RULES_FILE || env.RULES_JSON),
  });
  const github = env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_SECRET ? loadGithub(env) : undefined;
  if (rated && !github) throw new Error('RATED=on needs GitHub sign-in: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET');
  if (github && !env.DATABASE_URL) throw new Error('GITHUB_CLIENT_ID needs DATABASE_URL: accounts are stored in Postgres');
  const adminToken = env.AC_DEV_ADMIN_TOKEN;
  if (adminToken && production) throw new Error('AC_DEV_ADMIN_TOKEN (the dev-admin API) is development only: unset it with NODE_ENV=production');
  if (adminToken && !/^[A-Za-z0-9_-]{16,256}$/.test(adminToken)) throw new Error('AC_DEV_ADMIN_TOKEN must be 16–256 characters of [A-Za-z0-9_-]');
  const operatorToken = env.OPERATOR_TOKEN;
  if (operatorToken && !/^[\x21-\x7e]{32,512}$/.test(operatorToken)) throw new Error('OPERATOR_TOKEN must be 32–512 printable ASCII characters without spaces (openssl rand -base64 32)');
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL must be a postgres:// connection string');
  const rules = loadHostRules(env);
  const arenaSeedKey = env.ARENA_SEED_KEY || undefined;
  if (arenaSeedKey !== undefined && !/^[a-f0-9]{64}$/i.test(arenaSeedKey)) throw new Error('ARENA_SEED_KEY must be 32 bytes encoded as 64 hexadecimal characters (openssl rand -hex 32)');
  const simWorkers = int(env, 'SIM_WORKERS', Math.min(7, Math.max(0, availableParallelism() - 1)), 0, 32);
  const matchesPerWorker = int(env, 'MATCHES_PER_WORKER', 8, 1, 10_000);
  const mainMaxMatches = int(env, 'MAIN_MAX_MATCHES', 8, 1, 10_000);
  const port = int(env, 'PORT', 2567, 0, 65535);
  const cluster = loadCluster(env, port);
  // Durable arena series exist with any store; their hidden worlds need one stable seed key shared by every node.
  if (!arenaSeedKey && (databaseUrl || env.DATA_DIR) && (!env.DATA_DIR || cluster)) throw new Error(`ARENA_SEED_KEY is required with ${cluster ? 'REDIS_URL (every node must derive the same arena worlds)' : 'DATABASE_URL and no DATA_DIR'}: set 64 hexadecimal characters (openssl rand -hex 32) and keep it stable`);
  return {
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    corsOrigins,
    trustProxy: env.TRUST_PROXY === '1',

    drainMaxMs: int(env, 'DRAIN_MAX_SECONDS', 1200, 1, 86_400) * 1000,
    drainLogIntervalMs: int(env, 'DRAIN_LOG_INTERVAL_SECONDS', 30, 1, 86_400) * 1000,
    simWorkers,
    matchesPerWorker,
    simWorkerCpuPercent: int(env, 'SIM_WORKER_CPU_PERCENT', 75, 1, 100),
    mainMaxMatches,
    maxMatches: int(env, 'MAX_MATCHES', mainMaxMatches + simWorkers * matchesPerWorker, 1, 10_000),
    maxQueue: int(env, 'MAX_QUEUE', 500, 1, 10_000),
    admissionLagMs: int(env, 'ADMISSION_LAG_MS', 25, 15, 1000),
    admissionLagPercentile: int(env, 'ADMISSION_LAG_PERCENTILE', 95, 50, 100),
    admissionLagWindowSeconds: int(env, 'ADMISSION_LAG_WINDOW_SECONDS', 10, 1, 60),
    admissionMainLagGatesWorkers: env.ADMISSION_MAIN_LAG_GATES_WORKERS === '1',
    featuredMatch: env.FEATURED_MATCH !== '0',
    featuredPlaylist: onOff(env, 'FEATURED_PLAYLIST', true),
    ...(env.FEATURED_PLAYLIST_SEED ? { featuredPlaylistSeed: int(env, 'FEATURED_PLAYLIST_SEED', 0, 0, 0xffffffff) } : {}),
    featuredMaxViewers: int(env, 'FEATURED_MAX_VIEWERS', 500, 1, 100_000),
    featuredViewersPerIp: int(env, 'FEATURED_VIEWERS_PER_IP', 8, 1, 10_000),
    matchesPerIp: int(env, 'MATCHES_PER_IP', 30, 1, 10_000),
    matchRateWindowMs: int(env, 'MATCH_RATE_WINDOW_S', 600, 1, 86_400) * 1000,
    joinsPerIpPerMin: int(env, 'JOINS_PER_IP_PER_MIN', 120, 1, 100_000),
    maxMatchMs: int(env, 'MAX_MATCH_MINUTES', 45, 1, 24 * 60) * 60_000,
    abandonGraceMs: int(env, 'ABANDON_GRACE_SECONDS', 60, 1, 86_400) * 1000,
    endGraceMs: int(env, 'END_GRACE_SECONDS', 120, 0, 86_400) * 1000,
    maxClientsPerRoom: int(env, 'MAX_CLIENTS_PER_ROOM', 16, 2, 1000),
    maxObserversPerRoom: int(env, 'MAX_OBSERVERS_PER_ROOM', 500, 0, 10_000),
    simSpeed: int(env, 'SIM_SPEED', 1, 1, 1000),
    webDist: env.WEB_DIST || fileURLToPath(new URL('../../web/dist', import.meta.url)),
    devtools: env.PLAYERTHREE_DEVTOOLS !== '0' && (!production || operatorToken !== undefined),
    ...(operatorToken ? { operatorToken } : {}),
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(cluster ? { cluster } : {}),
    ...(env.DATA_DIR ? { dataDir: env.DATA_DIR } : {}),
    ...(arenaSeedKey ? { arenaSeedKey } : {}),
    ...(env.HISTORY_DIR ? { historyDir: env.HISTORY_DIR } : {}),
    historySessions: int(env, 'HISTORY_SESSIONS', 50, 0, 10_000),
    historyMs: int(env, 'HISTORY_HOURS', 24, 1, 24 * 365) * 3_600_000,
    historyBytes: int(env, 'HISTORY_MB', 64, 1, 100_000) * 1024 * 1024,
    ...(env.BENCH_RESULTS_DIR ? { benchResultsDir: env.BENCH_RESULTS_DIR } : {}),
    ...(env.SAFETY_CARD ? { safetyCard: env.SAFETY_CARD } : {}),
    maxProfiles: int(env, 'MAX_PROFILES', 10_000, 1, 10_000_000),
    profilesPerIp: int(env, 'PROFILES_PER_IP', 10, 1, 100_000),
    profileCallsPerMin: int(env, 'PROFILE_CALLS_PER_MIN', 240, 1, 100_000),
    oauthCallsPerMin: int(env, 'OAUTH_CALLS_PER_MIN', 120, 1, 100_000),
    oauthRegistrationsPerHour: int(env, 'OAUTH_REGISTRATIONS_PER_HOUR', 20, 1, 100_000),
    readySeconds: int(env, 'READY_SECONDS', 90, 5, 600),
    lobbyReservationMs: int(env, 'LOBBY_RESERVATION_SECONDS', 30, 5, 120) * 1000,
    lobbyRecoveryMs: int(env, 'LOBBY_RECOVERY_SECONDS', 45, 5, 120) * 1000,
    lobbyCountdownMs: int(env, 'LOBBY_COUNTDOWN_SECONDS', 3, 1, 10) * 1000,
    inviteMs: int(env, 'INVITE_MINUTES', 15, 1, 24 * 60) * 60_000,
    ...(adminToken ? { devAdminToken: adminToken } : {}),
    ...(rules ? { rules } : {}),
    ...(github ? { github } : {}),
    ...(rated ? { rated } : {}),
  };
}

function loadGithub(env: NodeJS.ProcessEnv): GithubConfig {
  const clientId = env.GITHUB_CLIENT_ID ?? '';
  const clientSecret = env.GITHUB_CLIENT_SECRET ?? '';
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(clientId) || !/^[\x21-\x7e]{16,256}$/.test(clientSecret)) throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must both be set (a GitHub OAuth app)');
  const url = (key: string, fallback: string): string => {
    const raw = env[key] || fallback;
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) throw new Error(`${key} must be https (or a loopback http test provider)`);
    return parsed.origin;
  };
  return { clientId, clientSecret, oauthUrl: url('GITHUB_OAUTH_URL', 'https://github.com'), apiUrl: url('GITHUB_API_URL', 'https://api.github.com') };
}

/**
 * `RATED=on` (D9) needs the official setup: `RESULTS_SIGNING_KEY`, `DATABASE_URL` (ratings are computed only from the
 * official database) and an https `PUBLIC_URL` (the signed origin). It refuses every dev surface that could make or
 * alter results: the dev-admin API (cheats, god view, sweeps), local unauthenticated devtools and fast-forward.
 */
function loadRated(env: NodeJS.ProcessEnv, ctx: { publicUrl: URL | undefined; databaseUrl: string | undefined; devAdmin: boolean; simSpeed: string; localDevtools: boolean; hostRules: boolean }): RatedConfig | undefined {
  if (env.RATED === undefined || env.RATED === '' || env.RATED === 'off') return undefined;
  if (env.RATED !== 'on') throw new Error('RATED must be on or off');
  if (!env.RESULTS_SIGNING_KEY) throw new Error('RATED=on needs RESULTS_SIGNING_KEY (an Ed25519 private key)');
  if (!ctx.databaseUrl) throw new Error('RATED=on needs DATABASE_URL');
  if (ctx.publicUrl?.protocol !== 'https:') throw new Error('RATED=on needs an https PUBLIC_URL');
  if (ctx.devAdmin) throw new Error('RATED=on refuses AC_DEV_ADMIN_TOKEN (dev-admin cheats, god view and sweeps)');
  if (ctx.localDevtools) throw new Error('RATED=on refuses unauthenticated devtools: set OPERATOR_TOKEN or PLAYERTHREE_DEVTOOLS=0');
  if (ctx.simSpeed !== '1') throw new Error('RATED=on refuses SIM_SPEED other than 1');
  if (ctx.hostRules) throw new Error('RATED=on plays standard rules only: unset RULES_FILE and RULES_JSON');
  let signer: ResultsSigner;
  try { signer = parseResultsSigner(env.RESULTS_SIGNING_KEY); } catch { throw new Error('RESULTS_SIGNING_KEY must be an Ed25519 PKCS#8 private key (PEM or base64 DER)'); }
  const since = env.RESULTS_KEY_SINCE ? Date.parse(env.RESULTS_KEY_SINCE) : 0;
  if (!Number.isFinite(since)) throw new Error('RESULTS_KEY_SINCE must be an ISO date');
  let retired: ResultsKey[] = [];
  if (env.RESULTS_RETIRED_KEYS) {
    const parsed: unknown = JSON.parse(env.RESULTS_RETIRED_KEYS);
    if (!Array.isArray(parsed) || parsed.some((k) => !k || typeof k.keyId !== 'string' || typeof k.publicKey !== 'string' || typeof k.from !== 'number' || !(k.until === null || typeof k.until === 'number'))) throw new Error('RESULTS_RETIRED_KEYS must be a JSON array of {keyId, publicKey, from, until, revokedAt?}');
    retired = parsed as ResultsKey[];
  }
  const maps = env.RATED_MAPS ? env.RATED_MAPS.split(',').map((item) => {
    const [map, layout] = item.trim().split(':');
    if (!map || !layout) throw new Error('RATED_MAPS must be a comma-separated list of map:layout');
    return { map, layout };
  }) : undefined;
  return {
    signer, keys: [resultsPublicKey(signer, since), ...retired.filter((k) => k.keyId !== signer.keyId)],
    queueJoinMs: int(env, 'RATED_QUEUE_JOIN_SECONDS', 10, 1, 3600) * 1000,
    matchesPerDay: int(env, 'RATED_MATCHES_PER_DAY', 60, 1, 10_000),
    metadataEditsPerDay: int(env, 'RATED_METADATA_EDITS_PER_DAY', 3, 0, 100),
    readyMs: int(env, 'RATED_READY_SECONDS', 60, 5, 600) * 1000,
    dodges: { count: int(env, 'RATED_DODGES', 3, 1, 100), windowMs: int(env, 'RATED_DODGE_HOURS', 24, 1, 24 * 30) * 3_600_000, lockMs: int(env, 'RATED_DODGE_LOCK_MINUTES', 30, 1, 24 * 60) * 60_000 },
    minAccountAgeMs: int(env, 'RATED_MIN_ACCOUNT_DAYS', 30, 0, 3650) * 86_400_000,
    replayMs: int(env, 'RATED_REPLAY_DAYS', 180, 1, 3650) * 86_400_000,
    ...(maps ? { maps } : {}),
  };
}
