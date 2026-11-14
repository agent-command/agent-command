/**
 * Match rules on the server (DESIGN §2.1): host defaults from RULES_FILE / RULES_JSON (validated at startup, merged
 * under every match by the PlayerThree host) and per-match overrides from create-match requests. Errors name the field
 * and its bounds (`rules.depths.digRockTime: must be a number from 0.05 to 120`) and never echo the input.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { registerNamedMap } from '@agent-command/game/maps';
import { checkRules, type MatchOptions } from '@agent-command/game';
import { HttpError } from './http.ts';

/** Host default rules from the environment: `RULES_FILE` (path to a JSON file) or `RULES_JSON` (inline), not both. */
export function loadHostRules(env: NodeJS.ProcessEnv): MatchOptions | undefined {
  if (env.MAPS_DIR) {
    for (const file of readdirSync(env.MAPS_DIR).filter((entry) => entry.endsWith('.json')).sort()) {
      const name = basename(file, '.json');
      if (!/^[a-z][a-z0-9_]{0,95}$/.test(name)) throw new Error('MAPS_DIR: map filenames must be lowercase identifiers ending in .json');
      let document: unknown;
      try { document = JSON.parse(readFileSync(join(env.MAPS_DIR, file), 'utf8')); }
      catch { throw new Error(`MAPS_DIR: ${name} is not readable JSON`); }
      try { registerNamedMap(name, document); }
      catch { throw new Error(`MAPS_DIR: ${name} is not a valid map document`); }
    }
  }
  const file = env.RULES_FILE;
  const inline = env.RULES_JSON;
  if (file && inline) throw new Error('set RULES_FILE or RULES_JSON, not both');
  if (!file && !inline) return undefined;
  const source = file ? `RULES_FILE ${file}` : 'RULES_JSON';
  let raw: unknown;
  try {
    raw = JSON.parse(file ? readFileSync(file, 'utf8') : inline!);
  } catch (e) {
    throw new Error(`${source}: not readable JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const checked = checkRules(raw);
  if (!checked.ok) throw new Error(`${source}: ${checked.error}`);
  return checked.options;
}

/** Validate one canonical matchOptions object. Host defaults apply when it is omitted. */
export function requestRules(rules: unknown): MatchOptions | undefined {
  if (rules === undefined) return undefined;
  const checked = checkRules(rules);
  if (!checked.ok) throw new HttpError(400, 'bad_rules', checked.error);
  return checked.options;
}

/**
 * The seed and rules a match is created with. A given seed (operator or private benchmark injection) is known anyway,
 * so the map may derive from it as before. Otherwise the match gets a fresh secret seed (53 bits): a generated map's
 * hidden layers and every event stream derive from it, so it leaves the server only with the released replay. A match
 * that would generate its map from that seed (the game publishes a generated map's seed) also gets a random public
 * map seed; a supplied map selector replaces the host's (`hostRules`) whole, so the host's generation params carry over.
 */
export function matchSeeding(seed: number | undefined, rules: MatchOptions, hostRules: MatchOptions | undefined): { seed: number; rules: MatchOptions } {
  if (seed !== undefined) return { seed, rules };
  const secret = Number(randomBytes(8).readBigUInt64BE() >> 11n);
  const map = rules.map ?? hostRules?.map;
  if (map?.name !== undefined || map?.document !== undefined || map?.seed !== undefined) return { seed: secret, rules };
  return { seed: secret, rules: { ...rules, map: { ...map, seed: randomInt(2 ** 32) } } };
}
