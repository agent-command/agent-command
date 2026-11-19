/**
 * GitHub sign-in for anonymous profiles (DESIGN §Ladder, D2) and the private account clusters the rated queue keeps
 * apart. Game-owned identity (PlayerThree SPEC §20.3: the game authenticates owners), not the MCP harness OAuth.
 *
 * The browser starts sign-in with its profile (POST, same origin); the server answers the GitHub authorize URL with a
 * single-use `state` bound to an HttpOnly cookie and a PKCE S256 challenge. The callback checks state, cookie and
 * verifier, reads the GitHub user and links it to that profile. Account DTOs carry the login and eligibility only:
 * never the provider subject, IPs, devices or clusters.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import type { PostgresStorage } from 'playerthree/postgres';
import type { GithubConfig, ServerConfig } from './config.ts';
import { clientIp, HttpError, originAllowed, RateLimiter, sendJson } from './http.ts';

/** Cluster evidence is kept this long, then pruned. */
export const LINK_RETENTION_MS = 90 * 86_400_000;
/** Shared network prefixes only link accounts seen on them within this window. */
export const IP_LINK_MS = 30 * 86_400_000;
/** A started sign-in expires after this long. */
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1024;
const DEVICE_COOKIE = /(?:^|;\s*)(?:__Host-)?ac_device=([A-Za-z0-9_-]{32})(?:;|$)/;

export type LinkKind = 'ip' | 'device' | 'harness' | 'artifact';

export interface AccountRecord {
  profileId: string;
  subject: string;
  login: string;
  providerCreatedAt: number;
  linkedAt: number;
}

/** What the owner's own client sees. */
export interface AccountView {
  linked: boolean;
  login: string | null;
  /** Rated play allowed now (GitHub account old enough). */
  eligible: boolean;
  /** When a too-young account becomes eligible (ms since epoch), or null. */
  eligibleAt: number | null;
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The shared network of a client address: IPv4 /24, IPv6 /56 (IPv4-mapped IPv6 as IPv4). */
export function networkPrefix(ip: string): string | undefined {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const address = mapped ?? ip;
  if (isIPv4(address)) return `v4:${address.split('.').slice(0, 3).join('.')}`;
  if (!isIPv6(address)) return undefined;
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right].map((g) => g.padStart(4, '0'));
  // 56 bits: three full groups and the high byte of the fourth.
  return `v6:${groups.slice(0, 3).join(':')}:${groups[3]!.slice(0, 2)}`;
}

/** Union-find over profiles sharing any digest: connected components, each keyed by its smallest profile id. */
export function clusters(links: readonly { profileId: string; key: string }[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = x; node !== root;) { const next = parent.get(node)!; parent.set(node, root); node = next; }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const byKey = new Map<string, string>();
  for (const { profileId, key } of links) {
    if (!parent.has(profileId)) parent.set(profileId, profileId);
    const first = byKey.get(key);
    if (first === undefined) byKey.set(key, profileId);
    else union(first, profileId);
  }
  return new Map([...parent.keys()].map((id) => [id, find(id)]));
}

export class Accounts {
  readonly #db: PostgresStorage;
  readonly #minAgeMs: number;

  constructor(db: PostgresStorage, minAgeMs: number) {
    this.#db = db;
    this.#minAgeMs = minAgeMs;
  }

  async get(profileId: string): Promise<AccountRecord | undefined> {
    const [row] = await this.#db.query<{ subject: string; login: string; created: string; linked: string }>(
      'SELECT subject, login, (extract(epoch FROM provider_created_at) * 1000)::bigint AS created, (extract(epoch FROM linked_at) * 1000)::bigint AS linked FROM ac_accounts WHERE profile_id = $1', [profileId]);
    return row ? { profileId, subject: row.subject, login: row.login, providerCreatedAt: Number(row.created), linkedAt: Number(row.linked) } : undefined;
  }

  /** Link (or re-link) a GitHub account to a profile. One GitHub account belongs to one profile. */
  async link(profileId: string, user: { subject: string; login: string; createdAt: number }, now = Date.now()): Promise<void> {
    const [owner] = await this.#db.query<{ profile_id: string }>("SELECT profile_id FROM ac_accounts WHERE provider = 'github' AND subject = $1", [user.subject]);
    if (owner && owner.profile_id !== profileId) throw new HttpError(409, 'account_linked_elsewhere');
    await this.#db.query(
      `INSERT INTO ac_accounts (profile_id, provider, subject, login, provider_created_at, linked_at) VALUES ($1, 'github', $2, $3, to_timestamp($4::double precision / 1000), to_timestamp($5::double precision / 1000))
       ON CONFLICT (profile_id) DO UPDATE SET subject = EXCLUDED.subject, login = EXCLUDED.login, provider_created_at = EXCLUDED.provider_created_at, linked_at = EXCLUDED.linked_at`,
      [profileId, user.subject, user.login, user.createdAt, now]);
  }

  async view(profileId: string, now = Date.now()): Promise<AccountView> {
    const account = await this.get(profileId);
    if (!account) return { linked: false, login: null, eligible: false, eligibleAt: null };
    const eligibleAt = account.providerCreatedAt + this.#minAgeMs;
    return { linked: true, login: account.login, eligible: eligibleAt <= now, eligibleAt: eligibleAt <= now ? null : eligibleAt };
  }

  /** Rated eligibility (D2): a linked GitHub account at least the configured age. */
  async eligible(profileId: string, now = Date.now()): Promise<boolean> {
    return (await this.view(profileId, now)).eligible;
  }

  /** Record one piece of cluster evidence (stored as a digest, refreshed on every sighting). */
  async note(profileId: string, kind: LinkKind, value: string, now = Date.now()): Promise<void> {
    await this.#db.query(
      `INSERT INTO ac_account_links (profile_id, kind, digest, seen_at) VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000))
       ON CONFLICT (profile_id, kind, digest) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
      [profileId, kind, digest(`${kind}\0${value}`), now]);
  }

  /** The client's network prefix, if it has one. */
  async noteIp(profileId: string, ip: string, now = Date.now()): Promise<void> {
    const prefix = networkPrefix(ip);
    if (prefix) await this.note(profileId, 'ip', prefix, now);
  }

  /**
   * Cluster id per profile: profiles sharing a GitHub account cannot exist (one link per subject), so clusters join
   * profiles sharing a network prefix seen within 30 days, a device, an OAuth harness or a policy artifact.
   */
  async clusters(now = Date.now()): Promise<Map<string, string>> {
    const rows = await this.#db.query<{ profile_id: string; kind: string; digest: string }>(
      "SELECT profile_id, kind, digest FROM ac_account_links WHERE seen_at > to_timestamp($1::double precision / 1000) AND (kind <> 'ip' OR seen_at > to_timestamp($2::double precision / 1000))",
      [now - LINK_RETENTION_MS, now - IP_LINK_MS]);
    return clusters(rows.map((r) => ({ profileId: r.profile_id, key: `${r.kind}:${r.digest}` })));
  }

  async clusterOf(profileId: string, now = Date.now()): Promise<string> {
    return (await this.clusters(now)).get(profileId) ?? profileId;
  }

  async prune(now = Date.now()): Promise<void> {
    await this.#db.query('DELETE FROM ac_account_links WHERE seen_at <= to_timestamp($1::double precision / 1000)', [now - LINK_RETENTION_MS]);
  }
}

export interface GithubSignIn {
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  close(): void;
}

/** GitHub OAuth web flow (state + PKCE S256 + an HttpOnly state cookie), and the owner's account DTO. */
export function createGithubSignIn(ctx: { config: ServerConfig; github: GithubConfig; accounts: Accounts; profileOf(req: IncomingMessage): string | undefined }): GithubSignIn {
  const { config, github, accounts } = ctx;
  const pending = new Map<string, { profile: string; verifier: string; expiresAt: number }>();
  const limiter = new RateLimiter(config.oauthCallsPerMin, 60_000);
  const secure = config.publicUrl?.protocol === 'https:';
  const origin = config.publicUrl?.origin;
  const stateCookie = secure ? '__Host-ac_oauth' : 'ac_oauth';
  const deviceCookie = secure ? '__Host-ac_device' : 'ac_device';
  const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const redirectUri = (req: IncomingMessage) => `${origin ?? `http://${req.headers.host}`}/api/auth/github/callback`;
  const sweep = () => { const now = Date.now(); for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key); };

  return {
    async handle(req, res, path) {
      if (path !== '/api/account' && !path.startsWith('/api/auth/github/')) return false;
      const ip = clientIp(req, config);
      const retry = limiter.take(ip);
      if (retry > 0) { sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retry) }); return true; }
      if (path === '/api/account') {
        if (!originAllowed(req, config)) throw new HttpError(403, 'forbidden_origin');
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' }); return true; }
        const profile = ctx.profileOf(req);
        if (!profile) throw new HttpError(401, 'bad_profile');
        sendJson(res, 200, { ...(await accounts.view(profile)), provider: 'github' }, { 'Cache-Control': 'no-store' });
        return true;
      }
      if (path === '/api/auth/github/start') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' }); return true; }
        if (!originAllowed(req, config) || !req.headers.origin) throw new HttpError(403, 'forbidden_origin');
        const profile = ctx.profileOf(req);
        if (!profile) throw new HttpError(401, 'bad_profile');
        sweep();
        if (pending.size >= MAX_PENDING) throw new HttpError(429, 'capacity');
        const state = randomBytes(32).toString('base64url');
        const verifier = randomBytes(48).toString('base64url');
        pending.set(digest(state), { profile, verifier, expiresAt: Date.now() + STATE_TTL_MS });
        const url = new URL('/login/oauth/authorize', github.oauthUrl);
        url.searchParams.set('client_id', github.clientId);
        url.searchParams.set('redirect_uri', redirectUri(req));
        url.searchParams.set('state', state);
        url.searchParams.set('scope', 'read:user');
        url.searchParams.set('allow_signup', 'false');
        url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
        url.searchParams.set('code_challenge_method', 'S256');
        sendJson(res, 200, { url: url.href }, { 'Set-Cookie': cookie(stateCookie, digest(state), STATE_TTL_MS / 1000), 'Cache-Control': 'no-store' });
        return true;
      }
      if (path === '/api/auth/github/callback') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' }); return true; }
        const url = new URL(req.url ?? path, 'http://callback.invalid');
        const state = url.searchParams.get('state') ?? '';
        const code = url.searchParams.get('code') ?? '';
        const key = digest(state);
        const entry = pending.get(key);
        pending.delete(key);
        const bound = new RegExp(`(?:^|;\\s*)${stateCookie}=([a-f0-9]{64})(?:;|$)`).exec(req.headers.cookie ?? '')?.[1];
        if (!entry || entry.expiresAt <= Date.now() || !bound || !timingSafeEqual(Buffer.from(bound), Buffer.from(key)) || !/^[A-Za-z0-9_-]{1,256}$/.test(code)) throw new HttpError(400, 'bad_state');
        const token: unknown = await fetch(new URL('/login/oauth/access_token', github.oauthUrl), {
          method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, code, redirect_uri: redirectUri(req), code_verifier: entry.verifier }),
          signal: AbortSignal.timeout(10_000),
        }).then((r) => r.ok ? r.json() : null).catch(() => null);
        const accessToken = token && typeof token === 'object' && 'access_token' in token && typeof token.access_token === 'string' ? token.access_token : undefined;
        if (!accessToken) throw new HttpError(502, 'github_unavailable');
        const user: unknown = await fetch(new URL('/user', github.apiUrl), {
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'user-agent': 'agent-command' },
          signal: AbortSignal.timeout(10_000),
        }).then((r) => r.ok ? r.json() : null).catch(() => null);
        const fields = new Map<string, unknown>(user && typeof user === 'object' ? Object.entries(user) : []);
        const id = fields.get('id'), login = fields.get('login'), created = fields.get('created_at');
        const createdAt = typeof created === 'string' ? Date.parse(created) : NaN;
        if (!Number.isSafeInteger(id) || typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login) || !Number.isFinite(createdAt)) throw new HttpError(502, 'github_unavailable');
        await accounts.link(entry.profile, { subject: String(id), login, createdAt });
        const device = DEVICE_COOKIE.exec(req.headers.cookie ?? '')?.[1] ?? randomBytes(24).toString('base64url');
        await accounts.note(entry.profile, 'device', device);
        await accounts.noteIp(entry.profile, ip);
        res.writeHead(303, {
          Location: '/?account=linked', 'Cache-Control': 'no-store',
          'Set-Cookie': [cookie(stateCookie, '', 0), cookie(deviceCookie, device, 400 * 86_400)],
        }).end();
        return true;
      }
      return false;
    },
    close() { limiter.close(); pending.clear(); },
  };
}
