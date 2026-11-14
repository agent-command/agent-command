/**
 * `playerthree.policy/1` packages over HTTP (P3 SPEC §13.1): owner export/import of commander library versions, and the
 * built-in bots' registered first-party packages (`GameDefinition.botPackages`), public to read and download.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalJson, POLICY_PACKAGE_FORMAT, POLICY_PACKAGE_MAX_BYTES, policyPackageHash, surfaceHash, validatePolicyPackage, type PolicyPackage } from 'playerthree';
import { policyArtifactHash } from 'playerthree/host';
import { OPPONENTS, PLANES, type Opponent, type Plane } from '@agent-command/game';
import type { ServerConfig } from './config.ts';
import { clientIp, originAllowed, RateLimiter, sendJson } from './http.ts';
import type { GameHost } from './room.ts';

/** Import body: one package at its format's limit plus the `{role, package}` envelope. */
export const IMPORT_BODY_BYTES = POLICY_PACKAGE_MAX_BYTES + 1024;

/**
 * Why the host would refuse a package, in the order a person can act on it. P3 answers every refusal with one closed
 * `invalid` (no echo of package content to agents); the owner who uploaded the file gets the reason here.
 */
export type ImportRejection = 'not_a_package' | 'wrong_game' | 'tampered' | 'wrong_plane';

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first reason `raw` cannot be imported into `role`, or undefined when P3's own validation accepts it. */
export function importRejection(raw: unknown, host: GameHost, role: Plane): ImportRejection | undefined {
  const manifest = host.definition.manifest;
  const limits = manifest.control.policy;
  if (!limits || !isPlain(raw) || raw.format !== POLICY_PACKAGE_FORMAT) return 'not_a_package';
  if (!isPlain(raw.game) || raw.game.id !== manifest.id) return 'wrong_game';
  try {
    const { hash, ...unhashed } = raw;
    if (typeof hash !== 'string' || policyPackageHash(unhashed as Omit<PolicyPackage, 'hash'>) !== hash) return 'tampered';
    if ((raw.runtime === 'js' || raw.runtime === 'wasm') && typeof raw.script === 'string' && policyArtifactHash({ runtime: raw.runtime, code: raw.script }) !== raw.scriptHash) return 'tampered';
  } catch {
    // A value canonical JSON cannot walk (absurd nesting) is no package.
    return 'not_a_package';
  }
  if (!Array.isArray(raw.roles) || !raw.roles.includes(role)) return 'wrong_plane';
  return validatePolicyPackage(raw, limits, manifest) ? undefined : 'not_a_package';
}

/** `<commander>-<role>-v<N>.policy.json`, the commander name reduced to a portable file-name slug. */
export function packageFileName(commanderName: string, role: string, version: number): string {
  const slug = commanderName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'commander';
  return `${slug}-${role}-v${version}.policy.json`;
}

/** One package as a JSON file download (canonical JSON: the exact bytes its `hash` covers). */
export function sendPackage(res: ServerResponse, text: string, fileName: string): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="${fileName}"`,
  });
  res.end(text);
}

/** A built-in bot's package as the bots list shows it. */
export interface BotPackageInfo {
  level: Opponent;
  role: Plane;
  hash: string;
  /** UTF-8 bytes of the canonical package. */
  bytes: number;
  runtime: string;
  license: string;
  author: string | null;
  /** Built against this host's surface: otherwise the host plays the bot natively (P3 falls back to `createBot`). */
  current: boolean;
}

/** Bot packages per IP per minute: list, source and download share one budget. */
const BOT_CALLS_PER_MIN = 60;

export interface BotPackagesApi {
  handle(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  close(): void;
}

export function createBotPackagesApi(ctx: { config: ServerConfig; host: GameHost }): BotPackagesApi {
  const { config, host } = ctx;
  const surface = surfaceHash(host.definition.manifest);
  const limiter = new RateLimiter(BOT_CALLS_PER_MIN, 60_000);
  /** Canonical text per registered package: computed once, packages are immutable operator code. */
  const texts = new WeakMap<PolicyPackage, string>();
  const textOf = (pkg: PolicyPackage): string => {
    let text = texts.get(pkg);
    if (text === undefined) texts.set(pkg, text = canonicalJson(pkg));
    return text;
  };

  function list(): BotPackageInfo[] {
    const bots: BotPackageInfo[] = [];
    for (const level of OPPONENTS) for (const role of PLANES) {
      const pkg = host.definition.botPackages?.(level, role);
      if (pkg) bots.push({ level, role, hash: pkg.hash, bytes: Buffer.byteLength(textOf(pkg)), runtime: pkg.runtime, license: pkg.license, author: pkg.author, current: pkg.surfaceHash === surface });
    }
    return bots;
  }

  /**
   * Readable source: each module under a path header, a starter reference (`from`, its knobs and the starter module
   * as the strategy skill serves it), or the composed script when the package carries no source.
   */
  function sourceText(pkg: PolicyPackage): string {
    const src = pkg.source;
    if (src === null) return pkg.script;
    if ('from' in src) {
      const slash = src.from.indexOf('/');
      const skill = host.definition.manifest.skills?.find((s) => s.name === src.from.slice(0, slash));
      const module = skill?.files[src.from.slice(slash + 1)];
      return `// Starter ${src.from} (deployed by reference), knobs ${JSON.stringify(src.knobs ?? null)}\n\n${module ?? pkg.script}`;
    }
    const includes = src.include?.length ? `// Includes (served by game_skill): ${src.include.join(', ')}\n\n` : '';
    if ('code' in src) return includes + src.code;
    return includes + Object.entries(src.modules).map(([path, code]) => `// ── ${path}${path === src.entry ? ' (entry)' : ''} ──\n${code}`).join('\n\n');
  }

  function handle(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (path !== '/api/bots' && !path.startsWith('/api/bots/')) return false;
    if (!originAllowed(req, config)) { sendJson(res, 403, { error: 'forbidden_origin' }); return true; }
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' }); return true; }
    const retry = limiter.take(clientIp(req, config));
    if (retry > 0) { sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(retry) }); return true; }
    if (path === '/api/bots') { sendJson(res, 200, { bots: list() }); return true; }
    const m = /^\/api\/bots\/([a-z]{1,16})\/([a-z]{1,16})\/(package|source)$/.exec(path);
    const level = m?.[1] as Opponent | undefined, role = m?.[2] as Plane | undefined;
    const pkg = level && role && OPPONENTS.includes(level) && PLANES.includes(role) ? host.definition.botPackages?.(level, role) : undefined;
    if (!m || !pkg) { sendJson(res, 404, { error: 'not_found' }); return true; }
    if (m[3] === 'package') { sendPackage(res, textOf(pkg), `agent-command-${level}-${role}.policy.json`); return true; }
    const text = sourceText(pkg);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
    return true;
  }

  return { handle, close: () => limiter.close() };
}
