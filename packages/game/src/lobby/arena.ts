/** Canonical, game-owned match identity shared by server and benchmark callers. */
import { createHash } from 'node:crypto';
import { canonicalJson, mergeMatchOptions, surfaceHash } from 'playerthree';
import type { MatchSpec } from 'playerthree/arena';
import { checkRules, COLOURS, isPlane, PLANES, resolveBotOptions, resolveRules, rulesOptions, type MatchOptions, type Opponent, type Rules } from '../rules/contract.ts';
import { isArmyId } from '../util/teams.ts';
import { MAPS, mapDescriptor } from '../maps/registry.ts';
import { publicMapDocument, resolveMapDocument } from '../maps/maps.ts';
import { manifest } from '../agent/manifest.ts';

export function arenaRulesHash(rules: Rules): string {
  return `sha256:${createHash('sha256').update(canonicalJson(rules)).digest('hex')}`;
}
/** Public identity of an arena map: a generated map's hidden layers come from each match's secret seed, never from here. */
export function arenaMapIdentity(mapId: string, seed: number, rules: Rules): string {
  const descriptor = mapDescriptor(mapId);
  if (!descriptor) throw new Error('Unsupported arena map');
  const generated = descriptor.tags.includes('generated');
  const selection: MatchOptions['map'] = generated ? { seed, params: rules.map } : { name: descriptor.id };
  const resolved = resolveMapDocument(seed, descriptor.terrain, rules.map, selection);
  const document = generated ? publicMapDocument(resolved) : resolved;
  return `sha256:${createHash('sha256').update(canonicalJson({ version: 1, document })).digest('hex')}`;
}
export const arenaLayouts = () => MAPS.flatMap(map => map.layouts.filter(layout => layout.supported).map(layout => ({ map: map.id, layout: layout.id, sides: layout.alliances.flatMap(alliance => alliance.slots) })));

export function resolveArenaMatch(spec: MatchSpec, defaults?: Record<string, unknown>): MatchSpec {
  if (spec.format !== 'playerthree.match' || spec.version !== 1 || spec.game !== manifest.id || spec.gameVersion !== manifest.version || spec.surfaceHash && spec.surfaceHash !== surfaceHash(manifest)) throw new Error('Arena game identity mismatch');
  if (!Number.isSafeInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff || !Number.isSafeInteger(spec.map.seed) || spec.map.seed < 0 || spec.map.seed > 0xffffffff) throw new Error('Invalid arena seed');
  const map = mapDescriptor(spec.map.id);
  const layout = map?.layouts.find(entry => entry.id === spec.map.layout && entry.supported);
  if (!map || !layout) throw new Error('Unsupported arena layout');
  const armies = layout.alliances.flatMap(alliance => alliance.slots);
  if (spec.sides.length !== armies.length) throw new Error('Unsupported arena layout');
  const teams = new Set<string>();
  const colours = new Set<string>();
  for (const side of spec.sides) {
    // Every army of the layout plays its own corner in its own colour (alliances of one colour ship with stage 3).
    if (!isArmyId(side.id) || side.spawnSlot !== side.id || !armies.includes(side.id) || teams.has(side.id) || !(COLOURS as readonly string[]).includes(side.alliance) || colours.has(side.alliance)) throw new Error('Invalid arena side assignment');
    teams.add(side.id);
    colours.add(side.alliance);
    if (side.seats.length !== PLANES.length || new Set(side.seats.map(entry => entry.role)).size !== PLANES.length || side.seats.some(entry => !isPlane(entry.role) || entry.occupant.kind === 'open' || entry.occupant.kind === 'human' || entry.occupant.kind === 'closed')) throw new Error('Invalid arena side assignment');
  }
  const checked = checkRules(mergeMatchOptions(manifest.matchOptions, defaults, { ...spec.options, terrain: map.terrain }));
  if (!checked.ok) throw new Error(checked.error);
  const resolved = resolveRules(checked.options);
  // A generated map is generated with the layout's slots.
  const rules: Rules = map.tags.includes('generated') ? { ...resolved, map: { ...resolved.map, slots: layout.sides } } : resolved;
  const selection: MatchOptions['map'] = map.tags.includes('generated') ? { seed: spec.map.seed, params: rules.map } : { name: map.id };
  const options: MatchOptions = { ...rulesOptions(rules), map: selection };
  const document = resolveMapDocument(spec.map.seed, map.terrain, rules.map, selection);
  const rulesHash = arenaRulesHash(rules);
  const identity = arenaMapIdentity(map.id, spec.map.seed, rules);
  if (spec.rulesHash && spec.rulesHash !== rulesHash || spec.map.identity && spec.map.identity !== identity) throw new Error('Arena frozen identity mismatch');
  const seats = spec.sides.flatMap(side => side.seats.filter(entry => entry.occupant.kind !== 'closed').map(entry => `${side.id}/${entry.role}`));
  if (new Set(spec.bindings.map(binding => `${binding.seat.team}/${binding.seat.role}`)).size !== seats.length || spec.bindings.length !== seats.length || spec.bindings.some(binding => !seats.includes(`${binding.seat.team}/${binding.seat.role}`))) throw new Error('Incomplete arena entrant bindings');
  const sides = spec.sides.map(side => ({ ...side, seats: side.seats.map(entry => entry.occupant.kind === 'bot'
    ? { ...entry, occupant: { ...entry.occupant, options: { ...resolveBotOptions(entry.occupant.level as Opponent, entry.occupant.options) } } }
    : entry) }));
  return { ...spec, sides, surfaceHash: surfaceHash(manifest), rulesHash, options: options as Record<string, unknown>, map: { ...spec.map, seed: document.seed, identity }, observerPolicy: { allowOmniscient: spec.observerPolicy.allowOmniscient, minDelayMs: spec.observerPolicy.minDelayMs }, rules: { ...spec.rules, ranked: false, coaching: 'off', practiceReasons: [...new Set([...spec.rules.practiceReasons, 'arena_benchmark'])] } };
}
