/** Owner-authenticated named commander connections. Commander identity is never a plane or army assignment. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PlayerThreeError, type ChatEntry, type CommanderSettingsPatch, type CommanderStatus } from 'playerthree/host';
import { canonicalJson, surfaceHash } from 'playerthree';
import { checkRules, OPPONENTS, PLANES, type Opponent, type Plane } from '@agent-command/game';
import type { ServerConfig } from './config.ts';
import { clientIp, HttpError, originAllowed, RateLimiter, readJson, sendJson } from './http.ts';
import { IMPORT_BODY_BYTES, importRejection, packageFileName, sendPackage } from './policy-packages.ts';
import type { Profiles } from './profiles.ts';
import type { GameHost, MatchRegistry } from './room.ts';

const BODY_BYTES = 2048;
/** Owner messages: up to 500 chars (4 bytes each in the worst case) plus the envelope. */
const TELL_BYTES = 4096;
/** Practice bodies carry canonical match rules, which may include a bounded 128 KiB inline map document. */
const PRACTICE_BODY_BYTES = 144 * 1024;
/** Default practice length: 5 game minutes. */
const DEFAULT_PRACTICE_TICKS = 3000;

export interface RosterCommander extends Omit<CommanderStatus, 'seated'> {
  token: string;
  seated: { match: string; roomId: string; team: string; roles: string[] } | null;
  practicing: boolean;
}

export interface RosterResponse {
  id: string;
  /** This host's agent-facing surface: a library version built against another one is stale until redeployed. */
  surfaceHash: string;
  commanders: RosterCommander[];
  /** Recent owner ↔ commander chat (memory only), oldest first. Agent text: render as plain text. */
  chat: ChatEntry[];
}

function strictObject(body: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad_request');
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, 'bad_request');
  for (const k of required) if (o[k] === undefined) throw new HttpError(400, 'bad_request');
  return o;
}

/** Maps the host's closed errors onto HTTP. */
function playerThreeStatus(e: unknown): never {
  if (e instanceof PlayerThreeError) {
    if (e.code === 'busy') throw new HttpError(409, 'busy');
    if (e.code === 'rate_limited') throw new HttpError(429, 'rate_limited');
    if (e.code === 'invalid') throw new HttpError(400, 'bad_request');
    throw new HttpError(400, e.code);
  }
  throw e;
}

export interface RosterApi {
  /** Resolves the profile behind an `Authorization: Bearer <secret>` header, or undefined if absent. 401 if wrong. */
  profileOf(req: IncomingMessage): string | undefined;
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  close(): void;
}

export function createRosterApi(ctx: {
  config: ServerConfig; host: GameHost; profiles: Profiles; registry: MatchRegistry;
  /**
   * Rated play (DESIGN §Ladder): a commander held for or seated in a rated match takes no owner messages, settings or
   * policy changes (coaching is off there), and declared-metadata edits are rate-limited (each starts a segment).
   */
  rated?: { holds(owner: string, commanderId: string): boolean; metadataEdit(owner: string, commanderId: string): Promise<void> };
}): RosterApi {
  const { config, host, profiles, registry } = ctx;
  const surface = surfaceHash(host.definition.manifest);
  const rated = (owner: string, commanderId: string): void => {
    if (ctx.rated?.holds(owner, commanderId)) throw new HttpError(409, 'rated_match');
  };
  const createLimiter = new RateLimiter(config.profilesPerIp, 3_600_000);
  const callLimiter = new RateLimiter(config.profileCallsPerMin, 60_000);
  const practicing = new Set<string>();

  const profileOf = (req: IncomingMessage): string | undefined => {
    const header = req.headers.authorization;
    if (header === undefined) return undefined;
    const m = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header.trim());
    const id = m ? profiles.authenticate(m[1]) : undefined;
    if (!id) throw new HttpError(401, 'bad_profile');
    return id;
  };

  const roster = (id: string): RosterResponse => ({
    id,
    surfaceHash: surface,
    commanders: host.commanders.roster(id).map((c) => {
      const roomId = c.seated ? registry.roomOf(c.seated.match) : undefined;
      return {
        ...c,
        token: host.commanders.token(id, c.id),
        seated: c.seated && roomId ? { match: c.seated.match, roomId, team: c.seated.team, roles: [...c.seated.roles] } : null,
        practicing: practicing.has(`${id}/${c.id}`),
      };
    }),
    chat: host.commanders.chat(id),
  });

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== '/api/profile' && !path.startsWith('/api/profile/')) return false;
    if (!originAllowed(req, config)) throw new HttpError(403, 'forbidden_origin');
    const reply = (status: number, body: unknown, headers?: Record<string, string>): true => {
      sendJson(res, status, body, headers);
      return true;
    };
    const ip = clientIp(req, config);
    const retry = callLimiter.take(ip);
    if (retry > 0) return reply(429, { error: 'rate_limited' }, { 'Retry-After': String(retry) });

    if (path === '/api/profile' && req.method === 'POST') {
      strictObject(await readJson(req, BODY_BYTES), []);
      if (profiles.size >= config.maxProfiles) return reply(429, { error: 'capacity' });
      const wait = createLimiter.take(ip);
      if (wait > 0) return reply(429, { error: 'rate_limited' }, { 'Retry-After': String(wait) });
      const created = profiles.create();
      host.commanders.ensure(created.id);
      return reply(200, created);
    }

    const id = profileOf(req);
    if (!id) throw new HttpError(401, 'bad_profile');
    host.commanders.ensure(id);

    if (path === '/api/profile') {
      if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
      return reply(200, roster(id));
    }

    if (path === '/api/profile/commanders' && req.method === 'POST') {
      const body = strictObject(await readJson(req, BODY_BYTES), ['name', 'kind', 'roles', 'isolation', 'metadata'], ['name', 'kind', 'roles']);
      if (typeof body.name !== 'string' || body.kind !== 'agent' && body.kind !== 'policy' ||
        !Array.isArray(body.roles) || !body.roles.length || !body.roles.every((role) => PLANES.includes(role as Plane))) throw new HttpError(400, 'bad_request');
      const isolation = body.isolation === undefined ? { independentSessions: false } : strictObject(body.isolation, ['independentSessions'], ['independentSessions']);
      if (typeof isolation.independentSessions !== 'boolean') throw new HttpError(400, 'bad_request');
      const metadata = body.metadata === undefined ? undefined : strictObject(body.metadata, ['provider', 'model', 'scaffoldVersion']);
      if (metadata && Object.values(metadata).some((value) => typeof value !== 'string' || value.length > 80)) throw new HttpError(400, 'bad_request');
      try { host.commanders.create(id, { name: body.name, kind: body.kind, roles: body.roles as Plane[], isolation: { independentSessions: isolation.independentSessions }, ...(metadata ? { metadata: metadata as { provider?: string; model?: string; scaffoldVersion?: string } } : {}) }); }
      catch (error) { playerThreeStatus(error); }
      return reply(201, roster(id));
    }

    if (path === '/api/profile/tell') {
      if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      const body = strictObject(await readJson(req, TELL_BYTES), ['commanderIds', 'text', 'ping'], ['commanderIds', 'text']);
      const owned = new Set(host.commanders.roster(id).map((commander) => commander.id));
      if (body.commanderIds !== 'all' && !(Array.isArray(body.commanderIds) && body.commanderIds.length > 0 && body.commanderIds.every((commanderId) => typeof commanderId === 'string' && owned.has(commanderId)))) throw new HttpError(400, 'bad_request');
      if (typeof body.text !== 'string') throw new HttpError(400, 'bad_request');
      for (const commanderId of body.commanderIds === 'all' ? owned : body.commanderIds as string[]) rated(id, commanderId);
      try {
        host.commanders.tell(id, body.commanderIds as string[] | 'all', body.text, body.ping);
      } catch (e) {
        playerThreeStatus(e);
      }
      return reply(200, roster(id));
    }

    const m = /^\/api\/profile\/commanders\/([A-Za-z0-9_-]{1,128})(?:\/(rotate|practice|rollback|import)|\/(approvals)\/([A-Za-z0-9_-]{1,128})|\/versions\/([1-9]\d{0,9})\/(package))?$/.exec(path);
    const commanderId = m?.[1];
    if (!m || !commanderId || !host.commanders.roster(id).some((commander) => commander.id === commanderId)) return reply(404, { error: 'not_found' });
    const action = m[2] ?? m[3] ?? m[6];
    if (req.method !== 'GET' && action !== 'rotate') rated(id, commanderId);

    if (action === undefined) {
      if (req.method === 'DELETE') {
        try { await host.commanders.delete(id, commanderId); } catch (error) { playerThreeStatus(error); }
        return reply(200, roster(id));
      }
      if (req.method !== 'PATCH') return reply(405, { error: 'method_not_allowed' }, { Allow: 'PATCH, DELETE' });
      const body = strictObject(await readJson(req, BODY_BYTES), ['name', 'kind', 'roles', 'isolation', 'metadata', 'scopes', 'mandate', 'botLevel']);
      if (body.botLevel !== undefined && !OPPONENTS.includes(body.botLevel as Opponent)) throw new HttpError(400, 'bad_request');
      const { name, kind, roles, isolation, metadata, ...settings } = body;
      try {
        if (name !== undefined || kind !== undefined || roles !== undefined || isolation !== undefined || metadata !== undefined) {
          if (name !== undefined && typeof name !== 'string' || kind !== undefined && kind !== 'agent' && kind !== 'policy' ||
            roles !== undefined && (!Array.isArray(roles) || !roles.length || !roles.every((role) => PLANES.includes(role as Plane)))) throw new HttpError(400, 'bad_request');
          const current = host.commanders.roster(id).find((commander) => commander.id === commanderId)!;
          const nextIsolation = isolation === undefined ? current.isolation : strictObject(isolation, ['independentSessions'], ['independentSessions']);
          if (typeof nextIsolation.independentSessions !== 'boolean') throw new HttpError(400, 'bad_request');
          const nextMetadata = metadata === undefined ? current.metadata : strictObject(metadata, ['provider', 'model', 'scaffoldVersion']);
          if (nextMetadata && Object.values(nextMetadata).some((value) => typeof value !== 'string' || value.length > 80)) throw new HttpError(400, 'bad_request');
          if (JSON.stringify(nextMetadata ?? {}) !== JSON.stringify(current.metadata ?? {})) await ctx.rated?.metadataEdit(id, commanderId);
          host.commanders.rename(id, commanderId, { name: name === undefined ? current.name : name as string, kind: kind === undefined ? current.kind : kind as 'agent' | 'policy', roles: roles === undefined ? current.roles : roles as Plane[], isolation: { independentSessions: nextIsolation.independentSessions }, ...(nextMetadata ? { metadata: nextMetadata as { provider?: string; model?: string; scaffoldVersion?: string } } : {}) });
        }
        host.commanders.update(id, commanderId, settings as CommanderSettingsPatch);
      } catch (e) {
        playerThreeStatus(e);
      }
      return reply(200, roster(id));
    }
    if (action === 'package') {
      if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      const commander = host.commanders.roster(id).find((entry) => entry.id === commanderId)!;
      const version = Number(m[5]);
      const entry = commander.policy.versions.find((v) => v.version === version);
      // A version without a recorded plane cannot be packaged (P3 refuses it): the owner redeploys it per plane.
      if (!entry || entry.role === null) return reply(404, { error: 'not_found' });
      let text: string;
      try {
        text = canonicalJson(await host.commanders.exportPolicy(id, commanderId, version, { role: entry.role }));
      } catch (e) {
        playerThreeStatus(e);
      }
      sendPackage(res, text, packageFileName(commander.name, entry.role, version));
      return true;
    }

    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (action === 'approvals') {
      const body = strictObject(await readJson(req, BODY_BYTES), ['approve'], ['approve']);
      if (typeof body.approve !== 'boolean') throw new HttpError(400, 'bad_request');
      try {
        await host.commanders.resolveApproval(id, commanderId, m[4]!, body.approve);
      } catch (e) {
        playerThreeStatus(e);
      }
      return reply(200, roster(id));
    }
    if (action === 'rotate') {
      strictObject(await readJson(req, BODY_BYTES), []);
      host.commanders.rotate(id, commanderId);
      return reply(200, roster(id));
    }
    if (action === 'practice') {
      const body = strictObject(await readJson(req, PRACTICE_BODY_BYTES), ['opponent', 'ticks', 'rules', 'role'], ['opponent', 'role']);
      if (!OPPONENTS.includes(body.opponent as Opponent)) throw new HttpError(400, 'bad_request');
      const checked = checkRules(body.rules ?? {});
      if (!checked.ok) throw new HttpError(400, 'bad_rules', checked.error);
      const ticks = body.ticks ?? DEFAULT_PRACTICE_TICKS;
      const maxTicks = host.definition.manifest.control.practice?.maxTicks ?? 0;
      if (typeof ticks !== 'number' || !Number.isSafeInteger(ticks) || ticks < 1 || ticks > maxTicks) throw new HttpError(400, 'bad_request');
      const key = `${id}/${commanderId}`;
      if (practicing.has(key)) throw new HttpError(409, 'busy');
      const status = host.commanders.roster(id).find((c) => c.id === commanderId);
      if (typeof body.role !== 'string' || !status?.roles.includes(body.role)) throw new HttpError(400, 'incompatible_role');
      if (status?.policy.activeByRole[body.role] == null) throw new HttpError(409, 'no_policy');
      practicing.add(key);
      // Runs in the background; the result lands in the roster's `lastPractice`.
      host.commanders
        .practice(id, commanderId, { role: body.role, opponent: body.opponent as Opponent, ticks, options: checked.options })
        .catch(() => {})
        .finally(() => practicing.delete(key));
      return reply(202, roster(id));
    }
    if (action === 'import') {
      const body = strictObject(await readJson(req, IMPORT_BODY_BYTES), ['role', 'package'], ['role', 'package']);
      const commander = host.commanders.roster(id).find((entry) => entry.id === commanderId)!;
      if (typeof body.role !== 'string' || !commander.roles.includes(body.role)) throw new HttpError(400, 'bad_request');
      const rejection = importRejection(body.package, host, body.role as Plane);
      if (rejection) throw new HttpError(400, rejection);
      let result;
      try {
        result = await host.commanders.importPolicy(id, commanderId, body.package, { role: body.role });
      } catch (e) {
        // The package itself passed every check above: what is left is its source not rebuilding to its script here.
        if (e instanceof PlayerThreeError && e.code === 'invalid') throw new HttpError(400, 'rebuild_failed');
        playerThreeStatus(e);
      }
      return reply(200, { result: { version: result.version, stale: result.stale }, roster: roster(id) });
    }
    const body = strictObject(await readJson(req, BODY_BYTES), ['role', 'version'], ['role', 'version']);
    const commander = host.commanders.roster(id).find((entry) => entry.id === commanderId)!;
    if (typeof body.role !== 'string' || !commander.roles.includes(body.role) || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new HttpError(400, 'bad_request');
    let result;
    try {
      result = await host.commanders.rollback(id, commanderId, body.role, body.version);
    } catch (e) {
      playerThreeStatus(e);
    }
    return reply(200, { result: result.ok ? { ok: true, version: result.version } : 'approval' in result ? result : { ok: false, error: result.error.code }, roster: roster(id) });
  }

  return {
    profileOf,
    handle,
    close() {
      createLimiter.close();
      callLimiter.close();
    },
  };
}
