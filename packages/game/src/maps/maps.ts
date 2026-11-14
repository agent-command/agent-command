/** Recipe/seed and authored selection converge on the same canonical map document. */
import type { MatchOptions } from '../rules/match-rules.ts';
import type { TerrainPreset } from '../rules/vocabulary.ts';
import { FNV_OFFSET, FNV_PRIME } from '../util/fnv.ts';
import { STAGE_SALT, generateTerrain, generateWorld, type MapRules } from './world.ts';
import { documentFromWorld, mapEntities, mapLayer, validateMapDocument, type MapDocument, type MapLayerName } from './document.ts';
import { mapDescriptor } from './registry.ts';
import { namedMap } from './named.ts';

export { MAPS, mapDescriptor } from './registry.ts';
export { registerNamedMap, namedMap } from './named.ts';
export { buildWorldFromDocument, expandMapDocument, validateMapDocument, importLdtk, exportLdtk, type MapDocument } from './document.ts';

/**
 * Public stages derive from the public map `seed`; the fogged layers (Depths, magma, ore, lodes) from `hiddenSeed`,
 * which a live server keeps secret per match (see generateWorld). Neither uses the event streams. `sides` (2 or 4) is
 * the slot count: a C2 (point-mirrored) or C4 (quarter-turn) document.
 */
export function generateMapDocument(seed: number, preset: TerrainPreset, map: MapRules, sides: 2 | 4, hiddenSeed: number): MapDocument {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Map seed must be an unsigned 32-bit integer');
  if (!Number.isSafeInteger(hiddenSeed) || hiddenSeed < 0) throw new Error('Hidden map seed must be a non-negative safe integer');
  const descriptor = mapDescriptor(preset)!;
  const terrain = generateTerrain(seed, preset, map, sides);
  const world = generateWorld(seed, terrain, map, sides, hiddenSeed);
  world.generation.stages = [
    { name: 'terrain', seed: (seed ^ STAGE_SALT.terrain) >>> 0 },
    ...world.generation.stages,
  ];
  return documentFromWorld(world, {
    id: descriptor.id, label: descriptor.label, identity: descriptor.identity,
    seed, size: map.size, sides, spireInset: map.spireInset, preset,
  });
}

/**
 * The document a match plays on. A generated map's public seed is `selection.seed` or, without one, the match seed
 * itself (which then is public: offline tools and tests); its hidden layers always come from the match seed, so a live
 * server keeps them secret by passing a secret match seed and an explicit public map seed.
 */
export function resolveMapDocument(matchSeed: number, preset: TerrainPreset, rules: MapRules, selection: MatchOptions['map']): MapDocument {
  if (selection?.name !== undefined) {
    const document = namedMap(selection.name);
    if (!document) throw new Error(`Unknown saved map: ${selection.name}`);
    return document;
  }
  if (selection?.document !== undefined) {
    const validation = validateMapDocument(selection.document);
    if (!validation.valid) throw new Error(`Invalid inline map: ${validation.errors.join('; ')}`);
    return structuredClone(selection.document) as MapDocument;
  }
  return generateMapDocument(selection?.seed ?? matchSeed, preset, rules, generatedSides(rules), matchSeed);
}

const generatedSides = (rules: MapRules): 2 | 4 => (rules.slots === 4 ? 4 : 2);

/** The slot count of the document `resolveMapDocument` would build for `selection`, without building it. */
export function resolveMapSides(rules: MapRules, selection: MatchOptions['map']): 2 | 4 {
  if (selection?.name !== undefined) {
    const document = namedMap(selection.name);
    if (!document) throw new Error(`Unknown saved map: ${selection.name}`);
    return document.sides;
  }
  return selection?.document !== undefined ? (selection.document as MapDocument).sides : generatedSides(rules);
}

/** What a generated map draws from its hidden seed (generateWorld): these layers, the lodes and these stage seeds. */
const HIDDEN_LAYERS: readonly MapLayerName[] = ['Depths', 'Ore', 'Magma', 'Cavern'];
const PUBLIC_STAGES: readonly string[] = ['terrain', 'faults', 'islands-orbit'];

/**
 * A generated map as its public seed alone determines it: hidden layers zeroed, lodes, their accounting and the hidden
 * stage seeds removed. Public hashes and identities hash this, so they never verify a guess at the hidden seed.
 */
export function publicMapDocument(document: MapDocument): MapDocument {
  const out = structuredClone(document);
  for (const name of HIDDEN_LAYERS) {
    const layer = mapLayer(out, name);
    layer.intGridRle = [layer.__cWid * layer.__cHei, 0];
  }
  const entities = mapEntities(out);
  entities.splice(0, entities.length, ...entities.filter((entity) => entity.__identifier !== 'Lode'));
  out.generation = { lodes: [], terrainEdits: [], stages: out.generation.stages.filter((stage) => PUBLIC_STAGES.includes(stage.name)) };
  return out;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

/** Stable uint32 FNV-1a over the canonical JSON's UTF-8 bytes: independent of key insertion order, sensitive to every authored field. */
export function hashMapDocument(document: MapDocument): number {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(canonicalJson(document))) hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  return hash;
}
