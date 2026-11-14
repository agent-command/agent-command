/**
 * The built-in bot packages `pnpm bots:build` writes (bots/build.ts): one `playerthree.policy/1` package per plane ×
 * level, which `definition.botPackages` hands to PlayerThree, so every bot seat (opponents, allies, practice, featured
 * matches, fallback) plays through the trusted runner. Read and validated once per process, on first use.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { surfaceHash, validatePolicyPackage, type PolicyPackage } from 'playerthree';
import type { AgentCommandManifest } from '../agent/manifest.ts';
import type { Opponent } from '../rules/opponents.ts';
import { PLANES, type Plane } from '../rules/vocabulary.ts';
import type { BotLevel } from './policy.ts';

/** The levels a package plays (`idle` is no bot: createBot's idle commander). */
export const BOT_LEVELS: readonly BotLevel[] = ['novice', 'standard', 'veteran'];
/** Directory of the built packages (gitignored build output). */
export const BOT_PACKAGES_DIR = new URL('../../dist/bots/', import.meta.url);
/** Module path of every package's entry (its `source`, spec §11 modules). */
export const BOT_PACKAGE_ENTRY = 'bot.js';
/** The packages' licence: the game's own. */
export const BOT_PACKAGE_LICENSE = 'AGPL-3.0-only';
export const BOT_PACKAGE_AUTHOR = 'Agent Command';
/**
 * Fixed export time: a package is content-addressed (its `hash`), so an unchanged build of the same bots and surface
 * keeps its hash.
 */
export const BOT_PACKAGE_CREATED_AT = '2000-01-01T00:00:00.000Z';

export const botPackageFile = (plane: Plane, level: BotLevel): URL => new URL(`${plane}-${level}.policy.json`, BOT_PACKAGES_DIR);

let loaded: ReadonlyMap<string, PolicyPackage> | undefined;

/**
 * Every built package that validates against `manifest`, by `<level>/<plane>`. A missing package (not built) is
 * absent: PlayerThree then seats `createBot`, as it does for a package made against another surface.
 */
export function botPackages(manifest: AgentCommandManifest): ReadonlyMap<string, PolicyPackage> {
  if (loaded) return loaded;
  const out = new Map<string, PolicyPackage>();
  for (const plane of PLANES) {
    for (const level of BOT_LEVELS) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(botPackageFile(plane, level), 'utf8'));
      } catch {
        continue;
      }
      const pkg = validatePolicyPackage(raw, manifest.control.policy, manifest);
      if (!pkg || pkg.roles.length !== 1 || pkg.roles[0] !== plane) throw new Error(`invalid bot package ${botPackageFile(plane, level).pathname}: rebuild with pnpm bots:build`);
      out.set(`${level}/${plane}`, pkg);
    }
  }
  loaded = out;
  return out;
}

const versions = new Map<Opponent, string | undefined>();

/**
 * The exact built-in bot at `level`, for entrant cards, ACBench and benchmark references: `sha256:` of its plane
 * packages' hashes (`<plane>:<hash>` lines in PLANES order, the hashes GET /api/bots lists). Undefined when a plane has
 * no package for the current surface (PlayerThree seats `createBot` there, which no package names); `idle` is the
 * no-op commander.
 */
export function botVersion(manifest: AgentCommandManifest, level: Opponent): string | undefined {
  if (level === 'idle') return 'idle';
  if (versions.has(level)) return versions.get(level);
  const surface = surfaceHash(manifest);
  const lines: string[] = [];
  for (const plane of PLANES) {
    const pkg = botPackages(manifest).get(`${level}/${plane}`);
    if (pkg?.surfaceHash !== surface) {
      versions.set(level, undefined);
      return undefined;
    }
    lines.push(`${plane}:${pkg.hash}`);
  }
  const version = `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
  versions.set(level, version);
  return version;
}
