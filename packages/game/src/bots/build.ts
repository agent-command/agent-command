/**
 * `pnpm bots:build`: the built-in bots as PlayerThree policy packages (spec §11 *Bot packages*, §13.1).
 *
 * 1. Writes the bot library (bots/library.ts) into the strategy skill under `policies/game/`: the bots' own modules,
 *    types stripped, which agents read, import and fork.
 * 2. Bundles one package per plane × level with PlayerThree's `buildPolicy` from the source `{ modules: { 'bot.js':
 *    botEntry(plane, level) }, entry: 'bot.js' }`, whose entry imports the library from the skill: exactly the build
 *    `policy_deploy` and `policy_import` run, so a package rebuilds byte for byte from its own source and imports into
 *    any library unchanged. Levels differ only in the baked `level`.
 * 3. Writes each package (canonical JSON) to `dist/bots/<plane>-<level>.policy.json`, where bots/packages.ts reads
 *    them for `definition.botPackages`.
 *
 * Run after any change to the bots, the modules they import or the agent surface (the packages record its
 * `surfaceHash`; a stale package is never played: PlayerThree falls back to `createBot`).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { canonicalJson, createPolicyPackage, servedSkills, surfaceHash, validatePolicyPackage, type PolicyPackage, type SkillDef } from 'playerthree';
import { policyArtifactHash } from 'playerthree/host';
import { buildPolicy } from 'playerthree/policy';
import { definition } from '../agent/adapter.ts';
import { PLANES, type Plane } from '../rules/vocabulary.ts';
import { BOT_LIBRARY_DIR, botLibrary } from './library.ts';
import { BOT_LEVELS, BOT_PACKAGE_AUTHOR, BOT_PACKAGE_CREATED_AT, BOT_PACKAGE_ENTRY, BOT_PACKAGE_LICENSE, BOT_PACKAGES_DIR, botPackageFile } from './packages.ts';
import type { BotLevel } from './policy.ts';

const SKILL_DIR = new URL('../../skills/agent-command-strategy/', import.meta.url);
const SKILL_NAME = 'agent-command-strategy';
/** Each plane's bot class, as its library module exports it. */
const BOT_CLASS: Readonly<Record<Plane, string>> = { depths: 'DepthsBot', surface: 'SurfaceBot', sky: 'SkyBot', orbit: 'OrbitBot' };

/** The entry module of a plane × level package: the real bot at that level, with the ABI's globals over one seat. */
export function botEntry(plane: Plane, level: BotLevel): string {
  const lib = `./${SKILL_NAME}/${BOT_LIBRARY_DIR}`;
  return `// Agent Command's built-in ${plane} bot at ${level}: the bot library served in the ${SKILL_NAME} skill (${BOT_LIBRARY_DIR}/),
// unchanged. createPolicy(options) is one seat (the trusted runner's ABI); think/init/detail run one seat in the sandbox.
import { botPolicy } from '${lib}/bots/policy.js';
import { ${BOT_CLASS[plane]} } from '${lib}/bots/${plane}.js';

export function createPolicy(options) {
  return botPolicy(${BOT_CLASS[plane]}, { plane: '${plane}', level: '${level}' }, options);
}
const seat = createPolicy(null);
export const detail = 'all';
export function init(matchData) { seat.init(matchData); }
export function think(obs) { return seat.think(obs); }
`;
}

async function bundle(entry: string, skills: readonly SkillDef[]): Promise<string> {
  const built = await buildPolicy({ entry: BOT_PACKAGE_ENTRY, load: (path) => (path === BOT_PACKAGE_ENTRY ? entry : undefined), skills });
  if (!built.ok) throw new Error(`bot package build failed: ${built.message} (${built.location.file}:${built.location.line})`);
  return built.code;
}
const library = botLibrary();
const libraryDir = new URL(`${BOT_LIBRARY_DIR}/`, SKILL_DIR);
rmSync(libraryDir, { recursive: true, force: true });
for (const [path, text] of library.files) {
  const file = new URL(path, SKILL_DIR);
  mkdirSync(new URL('./', file), { recursive: true });
  writeFileSync(file, text);
}
console.log(`bot library: ${library.files.size} modules → skills/${SKILL_NAME}/${BOT_LIBRARY_DIR}/`);

// The surface as the next process reads it: the strategy skill (read from disk at import) with this library
// (canonical JSON: key order is irrelevant).
const withLibrary = (files: ReadonlyMap<string, string>) => (s: SkillDef): SkillDef => s.name !== SKILL_NAME ? s : {
  ...s,
  files: { ...Object.fromEntries(Object.entries(s.files).filter(([path]) => !path.startsWith(`${BOT_LIBRARY_DIR}/`))), ...Object.fromEntries(files) },
};
const manifest = { ...definition.manifest, skills: definition.manifest.skills.map(withLibrary(library.files)) };
const limits = manifest.control.policy;
const skills = servedSkills(manifest);
const plainSkills = skills.map(withLibrary(library.plain));
const surface = surfaceHash(manifest);

mkdirSync(BOT_PACKAGES_DIR, { recursive: true });
for (const name of readdirSync(BOT_PACKAGES_DIR)) rmSync(new URL(name, BOT_PACKAGES_DIR));
for (const plane of PLANES) {
  for (const level of BOT_LEVELS) {
    const entry = botEntry(plane, level);
    const script = await bundle(entry, skills);
    // The served library is Node's stripped text with its type holes closed: it must bundle to the same script.
    if (level === BOT_LEVELS[0] && script !== await bundle(entry, plainSkills)) throw new Error(`${plane}: the readable library bundles differently from Node's stripped text`);
    const bytes = Buffer.byteLength(script, 'utf8');
    if (bytes > limits.maxArtifactBytes) throw new Error(`${plane} ${level}: script is ${bytes} bytes, over maxArtifactBytes ${limits.maxArtifactBytes}`);
    const pkg: PolicyPackage = createPolicyPackage({
      game: { id: manifest.id, version: manifest.version },
      surfaceHash: surface,
      roles: [plane],
      runtime: 'js',
      detail: 'all',
      source: { modules: { [BOT_PACKAGE_ENTRY]: entry }, entry: BOT_PACKAGE_ENTRY },
      script,
      scriptHash: policyArtifactHash({ runtime: 'js', code: script }),
      lineage: { parent: null, version: 1 },
      license: BOT_PACKAGE_LICENSE,
      author: BOT_PACKAGE_AUTHOR,
      createdAt: BOT_PACKAGE_CREATED_AT,
    });
    if (!validatePolicyPackage(pkg, limits, manifest)) throw new Error(`${plane} ${level}: the package does not validate`);
    writeFileSync(botPackageFile(plane, level), canonicalJson(pkg));
    console.log(`${plane.padEnd(7)} ${level.padEnd(8)} ${String(bytes).padStart(7)} B  ${pkg.hash}`);
  }
}
console.log(`surfaceHash ${surface}`);
