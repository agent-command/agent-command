/** Immutable, validated authored maps. Hosts may add files from their saved-map directory. */
import crossfire from '../../maps/crossfire.json' with { type: 'json' };
import twinFords from '../../maps/twin_fords.json' with { type: 'json' };
import crown from '../../maps/crown.json' with { type: 'json' };
import fourCorners from '../../maps/four_corners.json' with { type: 'json' };
import { MAP_ID_PATTERN, validateMapDocument, type MapDocument } from './document.ts';
import { registerSavedMapDescriptor } from './registry.ts';

const saved = new Map<string, MapDocument>();
let initialized = false;

function freezeDocument(value: object): void {
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freezeDocument(child);
  Object.freeze(value);
}

export function registerNamedMap(name: string, raw: unknown): void {
  if (!MAP_ID_PATTERN.test(name)) throw new Error('Invalid saved map name');
  const validation = validateMapDocument(raw);
  if (!validation.valid) throw new Error(`Invalid saved map ${name}: ${validation.errors.join('; ')}`);
  const document = raw as MapDocument;
  if (document.id !== name) throw new Error('Saved map name must match its public document id');
  if (saved.has(name)) throw new Error(`Duplicate saved map name: ${name}`);
  const copy = structuredClone(document);
  freezeDocument(copy);
  registerSavedMapDescriptor(copy);
  saved.set(name, copy);
}

/** Lazy initialization keeps document schema imports independent of contract initialization order. */
export function namedMap(name: string): MapDocument | undefined {
  if (!initialized) {
    initialized = true;
    for (const document of [crossfire, twinFords, crown, fourCorners]) registerNamedMap(document.id, document);
  }
  return saved.get(name);
}
