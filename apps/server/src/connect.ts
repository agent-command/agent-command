/**
 * Named commander connections: OAuth consent selects one owner-private roster ID and compatible roles.
 * JSON bodies are strict, size-capped and rate-limited; owner routes require the roster bearer credential:
 *   GET    /api/connect/<requestId>              public pending sign-in (no owner data)
 *   POST   /api/connect/<requestId>              { commander, roles, approve, pairingCode? | pairingToken? } → { redirect }
 *   POST   /api/connect/<requestId>/pair         { code } → { commanders, pairingToken, expiresAt }
 *   POST   /api/profile/pairing                  owner-authenticated {} → { code, expiresAt }
 *   GET    /api/profile/connections              [{ id, commander, client, roles, active, lastSeen, createdAt, authorizedAt }]
 *   PATCH  /api/profile/connections/<id>         { roles } → the updated list
 *   DELETE /api/profile/connections/<id>         revoke → the updated list
 * Grants are scoped to a named commander, never transferred between commanders sharing a role.
 * Pairing is request-only consent, not profile access or permission to create or mutate roster entries.
 * Authorization server endpoints (/.well-known/oauth-*, /oauth/*) are rate-limited per IP here as well.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectionInfo, ConsentRequestInfo, PairingResult } from '@playerthree/connect';
import { PlayerThreeError } from 'playerthree/host';
import type { AuthorizationServer, ConnectionStatus } from 'playerthree/mcp';
import { PLANES, type Plane } from '@agent-command/game';
import { connectionClient } from './clients.ts';
import type { ServerConfig } from './config.ts';
import { clientIp, HttpError, originAllowed, RateLimiter, readJson, sendJson } from './http.ts';
import type { RosterApi } from './roster.ts';
import type { GameHost } from './room.ts';

const BODY_BYTES = 1024;
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LENGTH = 6;
const PAIR_MINTS = 5;
const PAIR_MINT_WINDOW_MS = 10 * 60_000;
const PAIR_TRIES_PER_IP_PER_MIN = 10;
const PAIR_TRIES_PER_REQUEST = 5;
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export interface ConnectApi {
  /** Answers `/api/connect/*` and `/api/profile/connections*`; false for other paths. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  /** Rate-limits and serves the authorization server's paths; false for other paths. */
  handleOAuth(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  close(): void;
}

function strictRoles(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_request');
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'bad_request');
  if (!Array.isArray(o.roles) || !o.roles.every((r) => PLANES.includes(r as Plane))) throw new HttpError(400, 'bad_request');
  return o;
}

export function createConnectApi(ctx: {
  config: ServerConfig; host: GameHost; roster: RosterApi; auth: () => AuthorizationServer | undefined;
  /** An owner approved a harness: its client id and redirect host are account-cluster evidence (DESIGN §Ladder). */
  onConsent?(owner: string, clientId: string, redirectHost: string): void;
}): ConnectApi {
  const { config, host, roster } = ctx;
  const callLimiter = new RateLimiter(config.profileCallsPerMin, 60_000);
  const oauthLimiter = new RateLimiter(config.oauthCallsPerMin, 60_000);
  const registerLimiter = new RateLimiter(config.oauthRegistrationsPerHour, 3_600_000);
  const pairMintLimiter = new RateLimiter(PAIR_MINTS, PAIR_MINT_WINDOW_MS);
  const pairMintIpLimiter = new RateLimiter(PAIR_MINTS, PAIR_MINT_WINDOW_MS);
  const pairTryLimiter = new RateLimiter(PAIR_TRIES_PER_IP_PER_MIN, 60_000);
  const pairOwnerLimiter = new RateLimiter(PAIR_TRIES_PER_REQUEST, PAIR_TTL_MS);
  /** Only hashes are retained; minting again replaces the owner's outstanding code. */
  const codes = new Map<string, { owner: string; digest: Buffer; expiresAt: number }>();
  const codeOf = new Map<string, string>();
  /** A pairing capability authorizes exactly one pending consent request, never general profile access. */
  const bound = new Map<string, { owner?: string; tokenDigest?: Buffer; expiresAt?: number; tries: number }>();
  const sweep = (auth: AuthorizationServer): void => {
    const now = Date.now();
    for (const [d, c] of codes) {
      if (c.expiresAt <= now) {
        codes.delete(d);
        if (codeOf.get(c.owner) === d) codeOf.delete(c.owner);
      }
    }
    for (const id of bound.keys()) if (!auth.consentRequest(id)) bound.delete(id);
  };

  const pair = (auth: AuthorizationServer, id: string, raw: string, ip: string): { owner: string; pairingToken: string; expiresAt: number } => {
    const retry = pairTryLimiter.take(ip);
    if (retry > 0) throw new HttpError(429, 'rate_limited');
    const request = auth.consentRequest(id);
    const state = bound.get(id) ?? { tries: 0 };
    if (!request || state.tries >= PAIR_TRIES_PER_REQUEST) throw new HttpError(404, 'unknown_request');
    if (state.owner) throw new HttpError(400, 'bad_code');
    const hashed = digest(raw.trim().toUpperCase());
    const key = hashed.toString('hex');
    const code = codes.get(key);
    const matches = timingSafeEqual(hashed, code?.digest ?? Buffer.alloc(32));
    if (!matches || !code || code.expiresAt <= Date.now()) {
      state.tries++;
      bound.set(id, state);
      throw new HttpError(400, 'bad_code');
    }
    if (pairOwnerLimiter.take(code.owner) > 0) throw new HttpError(429, 'rate_limited');
    codes.delete(key);
    codeOf.delete(code.owner);
    const pairingToken = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(code.expiresAt, request.expiresAt);
    bound.set(id, { owner: code.owner, tokenDigest: digest(pairingToken), expiresAt, tries: state.tries });
    return { owner: code.owner, pairingToken, expiresAt };
  };

  const info = (c: ConnectionStatus): ConnectionInfo => ({
    id: c.id,
    commander: c.commander,
    client: connectionClient(c.client),
    roles: c.roles,
    active: c.active,
    lastSeen: c.lastSeenAt,
    createdAt: c.createdAt,
    authorizedAt: c.authorizedAt,
  });


  const as = (): AuthorizationServer => {
    const auth = ctx.auth();
    if (!auth) throw new HttpError(503, 'starting');
    return auth;
  };

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const consent = /^\/api\/connect\/([A-Za-z0-9_-]{1,64})(\/pair)?$/.exec(path);
    const conns = /^\/api\/profile\/connections(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(path);
    const pairing = path === '/api/profile/pairing';
    if (!consent && !conns && !pairing) return false;
    if (!originAllowed(req, config)) throw new HttpError(403, 'forbidden_origin');
    const ip = clientIp(req, config);
    const retry = callLimiter.take(ip);
    if (retry > 0) {
      sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retry) });
      return true;
    }
    const auth = as();
    sweep(auth);

    if (consent) {
      const id = consent[1]!;
      // The consent page may open in a browser without the owner's profile: reading the request needs no profile
      // (it carries no owner data), and a pairing code from the owner's own browser binds it to them.
      if (consent[2]) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
          return true;
        }
        // Rate limiting and single-use exchange are shared with direct code approval below.
        const body = await readJson(req, BODY_BYTES);
        if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== 'code')) throw new HttpError(400, 'bad_request');
        const raw = (body as { code?: unknown }).code;
        if (typeof raw !== 'string') throw new HttpError(400, 'bad_request');
        const paired = pair(auth, id, raw, ip);
        host.commanders.ensure(paired.owner);
        const holders = new Map(auth.connections(paired.owner).map((connection) => [connection.commander, connection]));
        const commanders = host.commanders.roster(paired.owner).map((commander) => {
          const held = holders.get(commander.id);
          const client = held ? connectionClient(held.client) : undefined;
          const metadata = commander.metadata;
          return {
            id: commander.id, name: commander.name, kind: commander.kind, roles: commander.roles,
            isolation: { independentSessions: commander.isolation.independentSessions },
            ...(metadata ? { metadata: {
              ...(metadata.provider !== undefined ? { provider: metadata.provider } : {}),
              ...(metadata.model !== undefined ? { model: metadata.model } : {}),
              ...(metadata.scaffoldVersion !== undefined ? { scaffoldVersion: metadata.scaffoldVersion } : {}),
            } } : {}),
            scopes: commander.scopes, mandate: commander.mandate,
            holder: client ? { name: client.name, kind: client.kind } : null,
          };
        });
        const result: PairingResult = { commanders, pairingToken: paired.pairingToken, expiresAt: paired.expiresAt };
        sendJson(res, 200, result);
        return true;
      }
      if (req.method === 'GET') {
        const r = auth.consentRequest(id);
        if (!r) throw new HttpError(404, 'unknown_request');
        const body: ConsentRequestInfo & { expiresAt: number } = {
          client: connectionClient(r.client),
          roles: r.roles,
          redirect: { host: r.redirect.host, loopback: r.redirect.loopback },
          expiresAt: r.expiresAt,
        };
        sendJson(res, 200, body);
        return true;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
        return true;
      }
      const body = strictRoles(await readJson(req, BODY_BYTES), ['commander', 'roles', 'approve', 'pairingCode', 'pairingToken']);
      if (typeof body.commander !== 'string' || body.commander.length > 128 ||
          typeof body.approve !== 'boolean' || new Set(body.roles as string[]).size !== (body.roles as string[]).length ||
          (body.approve && (!body.commander || (body.roles as string[]).length === 0))) throw new HttpError(400, 'bad_request');
      if (!auth.consentRequest(id)) throw new HttpError(404, 'unknown_request');
      const profile = roster.profileOf(req);
      const hasCode = body.pairingCode !== undefined;
      const hasToken = body.pairingToken !== undefined;
      if ((hasCode && (typeof body.pairingCode !== 'string' || hasToken)) ||
          (hasToken && typeof body.pairingToken !== 'string') || (profile && (hasCode || hasToken))) throw new HttpError(400, 'bad_request');
      let owner: string | undefined;
      if (hasCode) {
        owner = pair(auth, id, body.pairingCode as string, ip).owner;
      } else if (hasToken) {
        if (pairTryLimiter.take(ip) > 0) throw new HttpError(429, 'rate_limited');
        const binding = bound.get(id);
        const matches = timingSafeEqual(digest(body.pairingToken as string), binding?.tokenDigest ?? Buffer.alloc(32));
        if (!matches || !binding?.owner || !binding.expiresAt || binding.expiresAt <= Date.now()) throw new HttpError(400, 'bad_code');
        if (pairOwnerLimiter.take(binding.owner) > 0) throw new HttpError(429, 'rate_limited');
        owner = binding.owner;
      } else {
        const binding = bound.get(id);
        if (binding?.owner) throw new HttpError(403, 'bound_to_other');
        owner = profile;
      }
      if (!owner) throw new HttpError(401, 'bad_profile');
      host.commanders.ensure(owner);
      const pendingRequest = auth.consentRequest(id);
      let out: { redirect: string };
      try {
        out = auth.resolveConsent(id, { owner, commander: body.commander, roles: body.roles as Plane[], approve: body.approve });
      } catch (e) {
        if (e instanceof PlayerThreeError) throw new HttpError(400, 'invalid');
        throw e;
      }
      bound.delete(id);
      if (body.approve && pendingRequest) ctx.onConsent?.(owner, pendingRequest.client.id, pendingRequest.redirect.host);
      sendJson(res, 200, out);
      return true;
    }

    const owner = roster.profileOf(req);
    if (!owner) throw new HttpError(401, 'bad_profile');
    host.commanders.ensure(owner);
    const list = () => auth.connections(owner).map(info);

    if (pairing) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
        return true;
      }
      const body = await readJson(req, BODY_BYTES);
      if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).length > 0) throw new HttpError(400, 'bad_request');
      const wait = pairMintLimiter.take(owner) || pairMintIpLimiter.take(ip);
      if (wait > 0) {
        sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(wait) });
        return true;
      }
      // One live code per owner: minting again replaces it.
      const previous = codeOf.get(owner);
      if (previous) codes.delete(previous);
      let code: string;
      do {
        // Rejection sampling keeps codes uniform if the alphabet changes.
        code = '';
        while (code.length < PAIR_CODE_LENGTH) {
          for (const b of randomBytes(PAIR_CODE_LENGTH)) {
            if (b < Math.floor(256 / PAIR_ALPHABET.length) * PAIR_ALPHABET.length) code += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
            if (code.length === PAIR_CODE_LENGTH) break;
          }
        }
      } while (codes.has(digest(code).toString('hex')));
      const expiresAt = Date.now() + PAIR_TTL_MS;
      const hashed = digest(code);
      codes.set(hashed.toString('hex'), { owner, digest: hashed, expiresAt });
      codeOf.set(owner, hashed.toString('hex'));
      sendJson(res, 200, { code, expiresAt });
      return true;
    }

    const id = conns![1];
    if (id === undefined) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return true;
      }
      sendJson(res, 200, list());
      return true;
    }
    try {
      if (req.method === 'PATCH') {
        const body = strictRoles(await readJson(req, BODY_BYTES), ['roles']);
        auth.updateConnection(owner, id, { roles: body.roles as Plane[] });
      } else if (req.method === 'DELETE') {
        auth.revokeConnection(owner, id);
      } else {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'PATCH, DELETE' });
        return true;
      }
    } catch (e) {
      if (e instanceof PlayerThreeError) throw new HttpError(404, 'unknown_connection');
      throw e;
    }
    sendJson(res, 200, list());
    return true;
  }

  async function handleOAuth(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const auth = ctx.auth();
    if (!auth?.handles(path)) return false;
    const ip = clientIp(req, config);
    const retry = oauthLimiter.take(ip) || (path === '/oauth/register' && req.method === 'POST' ? registerLimiter.take(ip) : 0);
    if (retry > 0) {
      sendJson(res, 429, { error: 'temporarily_unavailable' }, { 'Retry-After': String(retry) });
      return true;
    }
    return auth.handle(req, res);
  }

  return {
    handle,
    handleOAuth,
    close() {
      callLimiter.close();
      oauthLimiter.close();
      registerLimiter.close();
      pairMintLimiter.close();
      pairMintIpLimiter.close();
      pairTryLimiter.close();
      pairOwnerLimiter.close();
      codes.clear();
      codeOf.clear();
      bound.clear();
    },
  };
}
