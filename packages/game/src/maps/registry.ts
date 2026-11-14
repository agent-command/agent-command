/** Public map catalogue and its descriptor types. Descriptors contain no generated underground data. */
import crossfire from '../../maps/crossfire.json' with { type: 'json' };
import twinFords from '../../maps/twin_fords.json' with { type: 'json' };
import crown from '../../maps/crown.json' with { type: 'json' };
import fourCorners from '../../maps/four_corners.json' with { type: 'json' };
import { SPIRE_INSET_MAX, SPIRE_INSET_MIN } from '../rules/terrain.ts';
import { MAP_SIZES, PLANES, type ArmyId, type Plane, type TerrainPreset } from '../rules/vocabulary.ts';
import { armyIdOfSlot } from '../util/teams.ts';
import { MAP_ID_PATTERN, MAP_IDENTITY_MAX, MAP_LABEL_MAX, type MapDocument, type MapLayout } from './document.ts';

/** A map corner an army can play (its id is the army id). */
export interface LobbySpawnSlot {
  id: ArmyId;
  label: string;
  corner: 'northwest' | 'northeast' | 'southeast' | 'southwest';
}
/**
 * One way to play a map. `sides`: the slots of the map it plays on (generated recipes play a C2 duel on two slots and
 * FFA on four); `alliances`: the armies taking part, grouped (each army picks its colour in the lobby: in stage 2
 * every army its own).
 */
export interface LobbyLayoutDescriptor {
  id: string;
  label: string;
  mode: '1v1' | '2v2' | 'ffa';
  supported: boolean;
  sides: 2 | 4;
  alliances: readonly { id: string; slots: readonly ArmyId[] }[];
  fairness: 'exact' | 'unverified';
}
export interface LobbyMapDescriptor {
  id: string;
  label: string;
  terrain: TerrainPreset;
  identity: string;
  size: number;
  mapSeed?: number;
  spireInset?: number;
  sizes: readonly number[];
  /** the most slots any of its layouts plays on */
  sides: 2 | 4;
  tags: readonly string[];
  /** every corner a layout of this map can use */
  slots: readonly LobbySpawnSlot[];
  roles: readonly Plane[];
  layouts: readonly LobbyLayoutDescriptor[];
}

/** Most layouts a public descriptor may list. */
const LAYOUTS_MAX = 8;
/** Side counts a map can have: point-symmetric duels and quarter-turn four-side maps. */
const SIDE_COUNTS: readonly number[] = [2, 4];

const CORNERS: readonly LobbySpawnSlot[] = [
  { id: 'nw', label: 'Northwest', corner: 'northwest' },
  { id: 'ne', label: 'Northeast', corner: 'northeast' },
  { id: 'se', label: 'Southeast', corner: 'southeast' },
  { id: 'sw', label: 'Southwest', corner: 'southwest' },
];
/** The corners of a `sides`-slot map, in slot order. */
const slotsOf = (sides: number): LobbySpawnSlot[] => Array.from({ length: sides }, (_, slot) => CORNERS.find((c) => c.id === armyIdOfSlot(slot, sides))!);

const LAYOUT_LABEL: Readonly<Record<MapLayout['fairness'], string>> = { rotational: 'Free-for-all', duel: '1v1', adjacent: 'Adjacent pairs', opposite: 'Opposite pairs' };

/** The public descriptor of a map document layout (two-slot `rotational` is the classic 1v1). */
function layoutDescriptor(layout: MapLayout, sides: 2 | 4): LobbyLayoutDescriptor {
  const singles = layout.teams.every((team) => team.length === 1);
  const duel = sides === 2 || layout.fairness === 'duel';
  return {
    id: layout.id, label: duel ? '1v1' : LAYOUT_LABEL[layout.fairness], mode: duel ? '1v1' : singles ? 'ffa' : '2v2',
    supported: layout.supported, sides, fairness: layout.fairness === 'rotational' || layout.fairness === 'duel' ? 'exact' : 'unverified',
    alliances: layout.teams.map((team) => {
      const slots = team.map((slot) => armyIdOfSlot(slot, sides));
      return { id: slots.join('_'), slots };
    }),
  };
}

/** A map document's public descriptor: the document is the single source of its slots and layouts. */
function documentDescriptor(document: MapDocument, tags: readonly string[]): LobbyMapDescriptor {
  return {
    id: document.id, label: document.label, identity: document.identity, terrain: document.preset,
    size: document.size, mapSeed: document.seed, spireInset: document.spireInset, sizes: [document.size], sides: document.sides, tags,
    slots: slotsOf(document.sides), roles: PLANES,
    layouts: document.layouts.map((layout) => layoutDescriptor(layout, document.sides)),
  };
}

/** Generated recipes: a C2 duel, or a C4 free-for-all (launched with `map.params.slots: 4`). */
const recipeLayouts: readonly LobbyLayoutDescriptor[] = [
  layoutDescriptor({ id: 'duel', teams: [[0], [1]], supported: true, fairness: 'rotational' }, 2),
  layoutDescriptor({ id: 'ffa', teams: [[0], [1], [2], [3]], supported: true, fairness: 'rotational' }, 4),
];
const recipes = [
  { id: 'open', label: 'Open', identity: 'Rolling ground, woodland and long sightlines.', tags: ['generated', 'open', 'mobile'] },
  { id: 'ridges', label: 'Ridges', identity: 'Broken ridgelines and ramped plateaus divide the approaches.', tags: ['generated', 'high-ground', 'flanks'] },
  { id: 'canyons', label: 'Canyons', identity: 'Parallel canyon walls make three long attack lanes.', tags: ['generated', 'lanes', 'chokes'] },
  { id: 'chokepoint', label: 'Chokepoint', identity: 'A short central pass competes with a long exposed flank.', tags: ['generated', 'chokes', 'flanks'] },
  { id: 'archipelago', label: 'Archipelago', identity: 'Lake basins and shallow fords create many short interlocking lanes.', tags: ['generated', 'water', 'lanes'] },
  { id: 'fortress', label: 'Fortress', identity: 'A central high-ground citadel is reached through explicit ramps.', tags: ['generated', 'high-ground', 'ramps'] },
  { id: 'rivers', label: 'Rivers', identity: 'A river barrier makes control of separate ford crossings decisive.', tags: ['generated', 'water', 'crossings'] },
  { id: 'highlands', label: 'Highlands', identity: 'Elevated parallel ridges have frequent connecting ramps.', tags: ['generated', 'high-ground', 'lanes'] },
] as const satisfies readonly { id: TerrainPreset; label: string; identity: string; tags: readonly string[] }[];
/** Built-in authored maps (validated and registered by maps/named.ts) with their catalogue tags. */
const builtIns: readonly [unknown, readonly string[]][] = [
  [crossfire, ['classic', 'authored']],
  [twinFords, ['classic', 'authored']],
  [crown, ['classic', 'authored']],
  [fourCorners, ['authored', 'four-side']],
];

export const MAPS: readonly LobbyMapDescriptor[] = [
  // Generated recipes come in every size and default to the smallest.
  ...recipes.map((recipe) => ({
    ...recipe, terrain: recipe.id, size: MAP_SIZES[0], sizes: [...MAP_SIZES], sides: 4,
    slots: CORNERS, layouts: recipeLayouts, roles: PLANES,
  } satisfies LobbyMapDescriptor)),
  ...builtIns.map(([document, tags]) => documentDescriptor(document as MapDocument, tags)),
];
export const mapDescriptor = (id: string): LobbyMapDescriptor | undefined => MAPS.find((map) => map.id === id);

/** Host-loaded documents join the same public catalogue as built-in maps. */
export function registerSavedMapDescriptor(document: MapDocument): void {
  const existing = mapDescriptor(document.id);
  if (existing) {
    if (existing.tags.includes('generated')) throw new Error('Saved map id conflicts with a generated recipe');
    return;
  }
  registerMapDescriptor(documentDescriptor(document, ['authored', 'saved']));
}

/** Hydrate public, bounded descriptor metadata; never accepts world layers. */
export function registerMapDescriptor(descriptor: LobbyMapDescriptor): void {
  if (mapDescriptor(descriptor.id)) return;
  const sizes: readonly number[] = MAP_SIZES;
  if (!MAP_ID_PATTERN.test(descriptor.id) || !descriptor.label || descriptor.label.length > MAP_LABEL_MAX || descriptor.identity.length > MAP_IDENTITY_MAX ||
    !sizes.includes(descriptor.size) || !descriptor.sizes.length || descriptor.sizes.some(size => !sizes.includes(size)) ||
    !SIDE_COUNTS.includes(descriptor.sides) || descriptor.slots.length !== descriptor.sides || descriptor.layouts.length > LAYOUTS_MAX ||
    descriptor.layouts.some(layout => !SIDE_COUNTS.includes(layout.sides) || layout.sides > descriptor.sides) ||
    (descriptor.spireInset !== undefined && (!Number.isInteger(descriptor.spireInset) || descriptor.spireInset < SPIRE_INSET_MIN || descriptor.spireInset > SPIRE_INSET_MAX)) ||
    (descriptor.mapSeed !== undefined && (!Number.isInteger(descriptor.mapSeed) || descriptor.mapSeed < 0 || descriptor.mapSeed > 0xffffffff))) throw new Error('Invalid public map descriptor');
  (MAPS as LobbyMapDescriptor[]).push(descriptor);
}
