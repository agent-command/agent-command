/** Public map selection shared by lobby, bot play, practice, and reproducible links. No credentials are serialized. */
import { DEFAULT_TERRAIN, MAP_SIZES, type MatchOptions, type TerrainPreset } from '@agent-command/game/contract';
import { MAPS, registerMapDescriptor, type LobbyMapDescriptor } from '@agent-command/game/lobby';
import { MAP_CHOICE_KEY, firstVisitChoice } from './poster.ts';

export interface PublicMapChoice { mapId: string; mapSeed: number; size: number }
const generated = (id: string): boolean => MAPS.find((map) => map.id === id)?.tags.includes('generated') === true;
/** A map Create Game can host: it has a playable layout (a duel, or a four-army layout of a four-slot map). */
export const playableMap = (map: LobbyMapDescriptor): boolean => map.layouts.some((layout) => layout.supported);
/** A map that plays a two-slot duel from its match options alone (commander practice runs that C2 duel). */
export const duelMap = (map: LobbyMapDescriptor): boolean => map.layouts.some((layout) => layout.supported && layout.sides === 2);

export function parseMapChoice(search: string): PublicMapChoice | undefined {
  const query = new URLSearchParams(search);
  const mapId = query.get('map');
  const seed = query.get('mapSeed');
  const size = query.get('size');
  if (!mapId || !/^[a-z][a-z0-9_]{0,95}$/.test(mapId) || seed === null || size === null || !/^\d+$/.test(seed) || !/^\d+$/.test(size)) return undefined;
  const map = MAPS.find((entry) => entry.id === mapId);
  const mapSeed = Number(seed), side = Number(size);
  if (!Number.isSafeInteger(mapSeed) || mapSeed < 0 || mapSeed > 0xffffffff || !(MAP_SIZES as readonly number[]).includes(side)) return undefined;
  if (map && (!playableMap(map) || !map.sizes.includes(side) || !generated(mapId) && mapSeed !== map.mapSeed)) return undefined;
  return { mapId, mapSeed, size: side };
}

export function mapChoiceUrl(choice: PublicMapChoice): string {
  const url = new URL(location.pathname, location.origin);
  url.search = new URLSearchParams({ map: choice.mapId, mapSeed: String(choice.mapSeed), size: String(choice.size) }).toString();
  return url.href;
}

export class TerrainChoice {
  private value: PublicMapChoice;
  private readonly listeners = new Set<(terrain: TerrainPreset) => void>();
  readonly ready: Promise<void>;

  constructor() {
    let stored: PublicMapChoice | undefined;
    try { stored = parseMapChoice(localStorage.getItem(MAP_CHOICE_KEY) ?? ''); } catch { /* storage unavailable */ }
    // A first visit opens on a map with a baked backdrop still (poster.ts), so the menu has a backdrop at once.
    this.value = parseMapChoice(location.search) ?? stored ?? parseMapChoice(firstVisitChoice() ?? '')
      ?? { mapId: DEFAULT_TERRAIN, mapSeed: crypto.getRandomValues(new Uint32Array(1))[0]!, size: 48 };
    this.ready = this.loadCatalogue();
  }

  private async loadCatalogue(): Promise<void> {
    const bundled = MAPS.some((map) => map.id === this.value.mapId && playableMap(map));
    let response: Response;
    try { response = await fetch('/api/maps'); }
    catch (error) {
      if (!bundled) throw error;
      return;
    }
    if (!response.ok) {
      if (!bundled) throw new Error('Map catalogue unavailable');
      return;
    }
    const body = await response.json() as { maps?: LobbyMapDescriptor[] };
    if (!Array.isArray(body.maps)) throw new Error('Invalid map catalogue');
    for (const descriptor of body.maps) registerMapDescriptor(descriptor);
    const selected = MAPS.find((map) => map.id === this.value.mapId && playableMap(map));
    if (!selected) throw new Error('Unknown map');
    if (!selected.tags.includes('generated') && (this.value.mapSeed !== selected.mapSeed || this.value.size !== selected.size)) throw new Error('Map link does not match the saved map');
    this.changed();
  }

  get(): TerrainPreset { return MAPS.find((map) => map.id === this.value.mapId)!.terrain; }
  getMap(): PublicMapChoice { return { ...this.value }; }
  options(): MatchOptions {
    return { terrain: this.get(), map: generated(this.value.mapId)
      ? { seed: this.value.mapSeed, params: { size: this.value.size } }
      : { name: this.value.mapId } };
  }

  /** Setters ignore unchanged values, so mirroring every lobby snapshot never re-notifies listeners. */
  set(mapId: string): void {
    const map = MAPS.find((entry) => entry.id === mapId && playableMap(entry));
    if (!map || mapId === this.value.mapId) return;
    this.value = { mapId, mapSeed: generated(mapId) ? this.value.mapSeed : map.mapSeed!, size: map.sizes.includes(this.value.size) ? this.value.size : map.size };
    this.changed();
  }
  setSeed(mapSeed: number): void {
    if (mapSeed === this.value.mapSeed || !generated(this.value.mapId) || !Number.isInteger(mapSeed) || mapSeed < 0 || mapSeed > 0xffffffff) return;
    this.value = { ...this.value, mapSeed };
    this.changed();
  }
  setSize(size: number): void {
    const map = MAPS.find((entry) => entry.id === this.value.mapId)!;
    if (size === this.value.size || !(MAP_SIZES as readonly number[]).includes(size) || !map.sizes.includes(size)) return;
    this.value = { ...this.value, size };
    this.changed();
  }
  private changed(): void {
    const query = new URLSearchParams({ map: this.value.mapId, mapSeed: String(this.value.mapSeed), size: String(this.value.size) });
    try { localStorage.setItem(MAP_CHOICE_KEY, query.toString()); } catch { /* storage unavailable */ }
    for (const listener of this.listeners) listener(this.get());
  }
  onChange(fn: (terrain: TerrainPreset) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
