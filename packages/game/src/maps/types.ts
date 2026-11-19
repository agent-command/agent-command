/**
 * Shared map vocabulary, a leaf: the generated world's data types, orbit regions and the reference scale. The
 * generator stages (world.ts, templates.ts, orbit.ts) and the map document format take them from here instead of
 * importing each other.
 */
import { MAP_SIZES, type PostKind, type TerrainPreset } from '../rules/vocabulary.ts';

/** Public weighted spawn rectangle (centre x/y) and preferred dimensionless approach vector. */
export interface OrbitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
  weight: number;
  spread: number;
}

/** A lode: discoverable outcrop cell `c`, rich (contested) or not, and the ore loads its pocket starts with. */
export interface Lode {
  c: number;
  rich: boolean;
  loads: number;
}

/**
 * A forward post (DESIGN §4.2 Outposts) at point (x, y) in tiles: a cell centre, or the map centre itself (the one point
 * every turn of the map fixes). A home post belongs to map slot `slot`; a contested point to nobody.
 */
export interface MapPost {
  x: number;
  y: number;
  kind: PostKind;
  slot?: number;
}

/**
 * Generator accounting per zone, in lode orbits (one lode per slot). A missed orbit stays missing, never migrates to
 * another zone. `prepared`/`cliffPrepared` count the public site orbits prepareLodeSites levelled (from the Surface
 * alone, whether or not a lode took them); `widened`/`fallback` count lodes placed beyond the zone's first radius and
 * beyond its preferred band.
 */
export interface LodeZoneSummary {
  zone: 'home' | 'flanks' | 'centre';
  requested: number;
  placed: number;
  widened: number;
  prepared: number;
  cliffPrepared: number;
  fallback: number;
  missing: number;
}

/** A public Surface cell prepareLodeSites levelled for a lode site. */
export interface LodeTerrainEdit {
  c: number;
  before: number;
  after: number;
}

export interface IslandOrbit {
  /** orbit radius around the map centre */
  r: number;
  /** angle at tick 0 */
  a0: number;
  /** radians per tick (sign = direction) */
  w: number;
  /** Public initial finite ore deposit; zero on ordinary islands. Never current cargo or remaining ore. */
  oreCapacity: number;
}

/** The static surface: SURFACE codes and the fault lines (ordered cells). Public. */
export interface Terrain {
  preset: TerrainPreset;
  terrain: Uint8Array;
  faults: number[][];
}

export interface World extends Terrain {
  size: number;
  /** actual depths cells (CELL codes, never `unknown`) */
  cells: Uint8Array;
  /** ore loads left per cell */
  ore: Uint8Array;
  /** who dug each tunnel: 0 nobody, else slot + 1 in generated worlds (the sim stores army + 1) */
  owner: Uint8Array;
  /** hidden magma pockets: pocket id per rock cell (0 none) */
  magma: Uint8Array;
  /** natural cavern cells slot 0 starts knowing; every other slot knows their rotation (the document's Cavern bitmask) */
  cavern: number[];
  islands: IslandOrbit[];
  orbitRegions: OrbitRegion[];
  /** lodes in rotated orbits: lode k·sides + r is lode k·sides turned r·4/sides quarter turns */
  lodes: Lode[];
  /**
   * forward posts, rotation-closed: every slot's home posts (slot order, then post order; slot s's post k is slot 0's
   * turned s · 4/sides quarter turns), then the contested points (each orbit's turns in order; the centre once). Empty
   * on an authored document that places none: the match fills them from its recipe (maps/posts.ts recipePosts).
   */
  posts: MapPost[];
  generation: { lodes: LodeZoneSummary[]; terrainEdits: LodeTerrainEdit[]; stages: { name: string; seed: number }[] };
}

/**
 * Side of the reference layout (tiles). Map-shaping lengths are authored on the smallest map ("S48 tiles") and scaled by
 * `size / REFERENCE_MAP_SIZE` on larger ones.
 */
export const REFERENCE_MAP_SIZE = MAP_SIZES[0];
