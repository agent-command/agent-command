/**
 * Deterministic staged world generation. Each stage owns a seeded random stream; maps are exactly symmetric under the
 * rotation group of their slots about the match-sized centre (two slots: the point mirror; four slots: quarter turns).
 * Every feature is drawn once in slot 0's canonical sector and written with all its rotations (DESIGN §15.4).
 */
import { STATS, STRUCTURE_SPACING, surfaceSiteLevel } from '../rules/stats.ts';
import { CELL, SURFACE, isLava, isSurfaceBlocked, isSurfaceHigh, isSurfaceWet, surfaceFeature, withSurfaceElevation, withSurfaceFeature } from '../rules/terrain.ts';
import { toTicks, type TerrainPreset } from '../rules/vocabulary.ts';
import { Rng } from '../util/rng.ts';
import { isTemplatePreset, slotSpires, templateTerrain } from './templates.ts';
import { generateOrbitRegions } from './orbit.ts';
import { crowdsPost, flankAnchor, recipePosts } from './posts.ts';
import type { MapRules } from '../rules/match-rules.ts';
import { REFERENCE_MAP_SIZE, type IslandOrbit, type Lode, type LodeTerrainEdit, type LodeZoneSummary, type MapPost, type OrbitRegion, type Terrain, type World } from './types.ts';
import { FNV_PRIME } from '../util/fnv.ts';
import { GEOM_EPS, norm, sq } from '../util/math.ts';
import { rotCell, rotX, rotY, sectorOf } from '../util/teams.ts';
import { dmath } from '../util/fdlibm.js';

// `/world` keeps exporting these for its consumers; their homes are rules/match-rules.ts and maps/types.ts.
export type { IslandOrbit, Lode, LodeTerrainEdit, LodeZoneSummary, MapRules, OrbitRegion, Terrain, World };

/** A lode's footprint below: the outcrop cell, its pocket (the 8 cells around it) and the bedrock seal ring around those. */
export const LODE_POCKET = (STATS.headframe.footprint.w - 1) / 2;
export const LODE_SEAL = LODE_POCKET + 1;
/** Surface outcrop shares the Headframe footprint; reserve the same clear spacing ring as placement. */
export const LODE_APRON = STRUCTURE_SPACING;
/** Pocket cells around a lode's outcrop cell (8 for the 3×3 Headframe); its ore loads are shared among them. */
const LODE_POCKET_CELLS = sq(2 * LODE_POCKET + 1) - 1;

// ---------------------------------------------------------------- generator constants
// Every number that shapes the map (sizes, counts, radii, clearances, margins, lengths, island rings, ore falloff) is a
// map rule (`map.*`, documented in rules/match-rules.ts). What stays here only steers the generator: stage salts, retry
// budgets, step sizes, the fixed orientation of preset features, and the wander, jitter and chances that randomise
// their shapes. Angles are radians (or units of π where named so), chances are in [0, 1). Every value feeds the seeded
// streams: changing one changes the generated maps.

/**
 * Random stream salts per stage (names as in World.generation.stages). Public stages (terrain, faults, islands) xor
 * into the public map seed; hidden stages (depths, magma, ore, features = lodes) into the secret hidden seed, so the
 * published map seed never reproduces fogged layers. Public stages never read a hidden layer.
 */
export const STAGE_SALT = {
  terrain: 0x5eed7e44,
  depths: 0x44455054,
  magma: 0x4d41474d,
  ore: 0x4f524553,
  faults: 0x4641554c,
  features: 0x46454154,
  islands: 0x534b594f,
  lava: 0x4c415641,
} as const;

/** Terrain feature spots: draws before falling back to the map centre. */
const SPOT_TRIES = 50;
/** Plateau ramps are painted every RAMP_STEP tiles, starting one step inside the plateau. */
const RAMP_STEP = 0.5;
/**
 * The centre ford stream's walk: heading jitter at the start and per step (full width), the most its heading deviates
 * from the anti-diagonal and its step length (tiles).
 */
const STREAM_WALK = { startJitter: 0.6, wander: 0.5, maxDeviation: 0.6, step: 0.7 } as const;
/** Ridge walls run across the base-to-base line (angle in units of π), with this heading jitter (full width). */
const RIDGE_WALL = { angle: 0.75, jitter: 0.9 } as const;
/**
 * Fault walks: per-step heading wander (full width), base angle across the base diagonal (units of π), heading jitter
 * of the central line and of the other sets' lines; placement tries per requested set, budgeted for at least
 * minTriesPairs sets.
 */
const FAULT_WALK = { wander: 0.5, angle: 0.75, centralJitter: 0.8, jitter: 1.2, triesPerPair: 100, minTriesPairs: 2 } as const;
/**
 * Free-form cavern walk: seeded extra steps before each side chamber (whole steps below chamberJitter), chance each
 * chamber neighbour is carved, steps of wandering before it heads straight for the centre and the per-step chance of
 * heading there anyway.
 */
const CAVERN_WALK = { chamberJitter: 4, chamberFill: 0.7, wanderSteps: 120, toward: 0.72 } as const;
/** Magma placement tries per requested pocket, budgeted for at least minTriesPockets pockets; chance each further cell joins. */
const MAGMA_GROWTH = { triesPerPocket: 20, minTriesPockets: 3, grow: 0.6 } as const;
/**
 * Ore vein walks: chance a step also ores a neighbour; seeded start spread (whole tiles below the value, per axis) of
 * the centre vein (further up-left) and of its satellites (down-right).
 */
const VEIN_WALK = { branch: 0.35, centreJitter: 3, satelliteJitter: 8 } as const;
/** Lode search radius growth per widening step (tiles). */
const LODE_WIDEN_STEP = 2;

type Point = { readonly x: number; readonly y: number };

const inside = (x: number, y: number, size: number): boolean => x >= 1 && y >= 1 && x <= size - 2 && y <= size - 2;
/** Distance from cell (x, y)'s centre to the nearest Spire. */
function spireDist(spires: readonly Point[], x: number, y: number): number {
  let d = Infinity;
  for (const s of spires) d = Math.min(d, norm(x + 0.5 - s.x, y + 0.5 - s.y));
  return d;
}
/** Slot 0's cell of the 2×2 centre chamber; the other chamber cells are its rotations. Template routes and caverns end here. */
const centreChamberCell = (size: number): number => (size / 2 - 1) * size + size / 2 - 1;
/**
 * The flank lode sites route templates reserve: cells within Chebyshev `radius` of the flank anchor's cell or one of
 * its rotations (always false without a flanks zone).
 */
function flankSites(map: MapRules, sides: 2 | 4, radius: number): (x: number, y: number) => boolean {
  const MAP = map.size;
  const anchor = flankAnchor(MAP, sides);
  const anchorCell = Math.floor(anchor.y) * MAP + Math.floor(anchor.x);
  const cells = Array.from({ length: sides }, (_, r) => rotCell((r * 4) / sides, anchorCell, MAP));
  const flanks = map.contestedZones.some((zone) => zone.kind === 'flanks');
  return (x, y) => flanks && cells.some((f) => Math.max(Math.abs(x - (f % MAP)), Math.abs(y - Math.floor(f / MAP))) <= radius);
}

/**
 * Surface terrain for a seed, preset, map rules and slot count (2 or 4: the rotation group). Uses its own random stream,
 * so a client can preview a preset without learning anything about the depths (ore, magma) of a match with the same seed.
 */
export function generateTerrain(seed: number, preset: TerrainPreset, map: MapRules, sides: 2 | 4): Terrain {
  const MAP = map.size;
  const N = MAP * MAP;
  const scale = MAP / REFERENCE_MAP_SIZE;
  const step = 4 / sides;
  const inner = (x: number, y: number): boolean => inside(x, y, MAP);
  const rng = new Rng((seed ^ STAGE_SALT.terrain) >>> 0);
  const spires = slotSpires(map, sides);
  const terrain = new Uint8Array(N);
  /** Paint cell (x, y) and its rotations. */
  const put = (x: number, y: number, v: number): void => {
    if (!inner(x, y)) return;
    for (let r = 0; r < sides; r++) terrain[rotCell(r * step, y * MAP + x, MAP)] = v;
  };
  const disc = (cx: number, cy: number, r: number, v: number, only?: number): void => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (!inner(x, y) || norm(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
        const before = terrain[y * MAP + x]!;
        if (only !== undefined && surfaceFeature(before) !== only) continue;
        // Decorations do not choose elevation; hills retain existing forest cover.
        // Never raise only part of a wet body when another plateau overlaps it.
        if (v === SURFACE.high && isSurfaceWet(before)) continue;
        const code = v === SURFACE.forest ? withSurfaceFeature(before, v)
          : v === SURFACE.high && before !== SURFACE.cliff ? withSurfaceElevation(before, true) : v;
        put(x, y, code);
      }
    }
  };
  /** A random point away from every Spire (anywhere is fine: put() writes the rotations). */
  const spot = (minSpire: number, margin = map.featureMargin): { x: number; y: number } => {
    for (let i = 0; i < SPOT_TRIES; i++) {
      const x = margin + rng.next() * (MAP - 2 * margin);
      const y = margin + rng.next() * (MAP - 2 * margin);
      if (spireDist(spires, Math.floor(x), Math.floor(y)) >= minSpire) return { x, y };
    }
    return { x: MAP / 2, y: MAP / 2 };
  };
  /** A straight wall of cliff cells from (x, y) along angle `a`, `len` cells, leaving `gaps` single-cell gaps. */
  const wall = (x0: number, y0: number, a: number, len: number, gaps: number, thick: number): void => {
    len = Math.round(len * scale);
    const gapAt = new Set<number>();
    for (let g = 0; g < gaps; g++) gapAt.add(1 + rng.int(Math.max(1, len - 2)));
    for (let i = 0; i < len; i++) {
      if (gapAt.has(i) || gapAt.has(i - 1)) continue; // gaps are two cells wide
      const x = x0 + dmath.cos(a) * i;
      const y = y0 + dmath.sin(a) * i;
      for (let k = 0; k < thick; k++) put(Math.floor(x - dmath.sin(a) * k), Math.floor(y + dmath.cos(a) * k), SURFACE.cliff);
    }
  };
  /** A plateau: high ground inside a cliff rim with a few ramps (gaps). */
  const plateau = (cx: number, cy: number, r: number, ramps: number): void => {
    r *= scale;
    disc(cx, cy, r + map.plateau.rim * scale, SURFACE.cliff);
    disc(cx, cy, r, SURFACE.high);
    for (let k = 0; k < ramps; k++) {
      const a = rng.next() * Math.PI * 2;
      for (let d = r - RAMP_STEP; d <= r + map.plateau.rampReach * scale; d += RAMP_STEP) put(Math.floor(cx + dmath.cos(a) * d), Math.floor(cy + dmath.sin(a) * d), SURFACE.high);
    }
  };
  /**
   * A sinuous stream of fords out of the centre, written with its rotations: on two-slot maps roughly along the
   * anti-diagonal, across the line between the bases; on four-slot maps along the axes, a cross between neighbours.
   */
  const stream = (): void => {
    const axis = sides === 2 ? -Math.PI / 4 : 0;
    let x = MAP / 2 + 0.5;
    let y = MAP / 2 - 0.5;
    let a = axis + (rng.next() - 0.5) * STREAM_WALK.startJitter;
    const high = isSurfaceHigh(terrain[Math.floor(y) * MAP + Math.floor(x)]!);
    for (let i = 0; i < map.stream.steps * scale && inner(Math.floor(x), Math.floor(y)); i++) {
      const cx = Math.floor(x), cy = Math.floor(y), c = cy * MAP + cx;
      // A stream is a level body, not a sheet climbing the plateau or a waterfall.
      if (terrain[c] === SURFACE.cliff || isSurfaceHigh(terrain[c]!) !== high) break;
      if ([c - 1, c + 1, c - MAP, c + MAP].some(n => n >= 0 && n < N && isSurfaceWet(terrain[n]!) && isSurfaceHigh(terrain[n]!) !== high)) break;
      if (spireDist(spires, cx, cy) > map.spireClearing + map.stream.clearance) put(cx, cy, withSurfaceFeature(terrain[c]!, SURFACE.ford));
      a += (rng.next() - 0.5) * STREAM_WALK.wander;
      a = Math.min(axis + STREAM_WALK.maxDeviation, Math.max(axis - STREAM_WALK.maxDeviation, a));
      x += dmath.cos(a) * STREAM_WALK.step;
      y += dmath.sin(a) * STREAM_WALK.step;
    }
  };

  if (isTemplatePreset(preset)) {
    terrain.set(templateTerrain(seed, preset, map, sides));
    // Route templates keep their lode sites: no water in the home lode band, and a level site at each flank anchor
    // (a Headframe there is contested whichever lanes the template draws around it). The anchor site is levelled
    // onto a plateau it touches, never carved down to ground.
    const site = LODE_POCKET + LODE_APRON;
    for (let c = 0; c < N; c++) if (surfaceFeature(terrain[c]!) === SURFACE.water && spireDist(spires, c % MAP, Math.floor(c / MAP)) <= map.homeLodeMaxRadius + site) terrain[c] = SURFACE.ground;
    if (map.contestedZones.some((zone) => zone.kind === 'flanks')) {
      const anchor = flankAnchor(MAP, sides);
      const ax = Math.floor(anchor.x), ay = Math.floor(anchor.y);
      let level: number = SURFACE.ground;
      for (let dy = -site; dy <= site; dy++) for (let dx = -site; dx <= site; dx++) if (isSurfaceHigh(terrain[(ay + dy) * MAP + ax + dx]!)) level = SURFACE.high;
      for (let dy = -site; dy <= site; dy++) for (let dx = -site; dx <= site; dx++) put(ax + dx, ay + dy, level);
    }
  } else if (preset === 'open') {
    const open = map.open;
    for (let i = 0; i < open.forests; i++) {
      const p = spot(open.forestClear);
      disc(p.x, p.y, (open.forestRadius + rng.next() * open.forestSpan) * scale, SURFACE.forest);
    }
    for (let i = 0; i < open.hills; i++) {
      const p = spot(open.hillClear, open.hillMargin);
      disc(p.x, p.y, (open.hillRadius + rng.next() * open.hillSpan) * scale, SURFACE.high);
    }
    stream();
  } else if (preset === 'ridges') {
    const ridges = map.ridges;
    for (let i = 0; i < ridges.walls; i++) {
      const p = spot(ridges.wallClear);
      // Ridges run across the line between the bases, so they shape the lanes instead of lining them.
      const a = Math.PI * RIDGE_WALL.angle + (rng.next() - 0.5) * RIDGE_WALL.jitter;
      wall(p.x, p.y, a, ridges.wallLength + rng.int(ridges.wallLengthSpan), ridges.wallGaps, ridges.wallThickness);
    }
    for (let i = 0; i < ridges.plateaus; i++) {
      const p = spot(ridges.plateauClear, ridges.plateauMargin);
      plateau(p.x, p.y, ridges.plateauRadius + rng.next() * ridges.plateauSpan, ridges.ramps + rng.int(ridges.rampsSpan));
    }
    for (let i = 0; i < ridges.forests; i++) {
      const p = spot(ridges.forestClear);
      disc(p.x, p.y, (ridges.forestRadius + rng.next() * ridges.forestSpan) * scale, SURFACE.forest, SURFACE.ground);
    }
  } else {
    // Canyons: two long walls parallel to the base-to-base diagonal split the map into three lanes, with mesas
    // (high ground behind cliffs) on the diagonal between the centre and the Spire-free corners (four slots: on the
    // diagonals between the centre and every Spire) and a fordable stream across the middle lane.
    const canyons = map.canyons;
    const off = (canyons.wallOffset + rng.next() * canyons.wallOffsetSpan) * scale;
    for (const s of [1, -1]) {
      const x0 = (canyons.wallStart + rng.next() * canyons.wallStartSpan) * scale + (s * off) / Math.SQRT2;
      const y0 = (canyons.wallStart + rng.next() * canyons.wallStartSpan) * scale - (s * off) / Math.SQRT2;
      wall(x0, y0, Math.PI / 4, canyons.wallLength + rng.int(canyons.wallLengthSpan), canyons.wallGaps, canyons.wallThickness);
    }
    const m = (canyons.mesa + rng.next() * canyons.mesaSpan) * scale;
    plateau(m, MAP - m, canyons.mesaRadius + rng.next() * canyons.mesaRadiusSpan, canyons.mesaRamps);
    stream();
    for (let i = 0; i < canyons.forests; i++) {
      const p = spot(canyons.forestClear);
      disc(p.x, p.y, (canyons.forestRadius + rng.next() * canyons.forestSpan) * scale, SURFACE.forest, SURFACE.ground);
    }
  }

  // Bases stay clear and the walkable surface stays one region; faults are a later world stage.
  for (let c = 0; c < N; c++) if (spireDist(spires, c % MAP, Math.floor(c / MAP)) <= map.spireClearing) terrain[c] = SURFACE.ground;
  // Four slots: the flank sites sit on the sector seams, where every slot's shortest route runs; the route (and the
  // cavern following it) keeps out of them so the flank lodes keep their sites.
  if (isTemplatePreset(preset)) openTemplateRoute(terrain, spires[0]!, sides, sides === 4 ? flankSites(map, sides, LODE_SEAL) : () => false);
  sealPockets(terrain, spires[0]!);
  return { preset, terrain, faults: [] };
}

/** The walkable region reached from slot 0's Spire `home`; used by terrain sealing and feature-stage validation. */
function surfaceReachable(terrain: Uint8Array, home: Point): Uint8Array {
  const N = terrain.length;
  const MAP = Math.sqrt(N);
  const seen = new Uint8Array(N);
  const start = Math.floor(home.y) * MAP + Math.floor(home.x);
  const queue = [start];
  seen[start] = 1;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    const x = c % MAP;
    for (const n of [x < MAP - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + MAP, c - MAP]) {
      if (n < 0 || n >= N || seen[n] || terrain[n] === SURFACE.cliff || surfaceFeature(terrain[n]!) === SURFACE.water) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return seen;
}

function sealPockets(terrain: Uint8Array, home: Point): void {
  const N = terrain.length;
  const seen = surfaceReachable(terrain, home);
  for (let c = 0; c < N; c++) if (!seen[c] && terrain[c] !== SURFACE.cliff && surfaceFeature(terrain[c]!) !== SURFACE.water) terrain[c] = SURFACE.cliff;
}

/**
 * Route templates promise a walkable route from each Spire through the 2×2 centre chamber to every other Spire, off
 * the map border (the cavern follows it underground, and the Depths border is bedrock). Template geometry can break
 * that promise at extreme rules or seeds (diagonal fords or ramps narrower than a cell step, lakes over the centre, a
 * lake lattice that misses itself at the sector seam), so the chamber and a cheapest route to it outside the `avoid`
 * cells are opened with their rotations: blocked cells on it become the templates' own crossings (water → ford, cliff
 * → high ground). A recipe whose route already exists is unchanged.
 */
function openTemplateRoute(terrain: Uint8Array, home: Point, sides: 2 | 4, avoid: (x: number, y: number) => boolean): void {
  const N = terrain.length;
  const MAP = Math.sqrt(N);
  const open = (c: number): void => {
    const code = surfaceFeature(terrain[c]!) === SURFACE.water ? withSurfaceFeature(terrain[c]!, SURFACE.ford) : terrain[c] === SURFACE.cliff ? SURFACE.high : terrain[c]!;
    for (let r = 0; r < sides; r++) terrain[rotCell((r * 4) / sides, c, MAP)] = code;
  };
  const goal = centreChamberCell(MAP);
  // Every chamber cell is a rotation of `goal` or of `goal + 1` (two slots: the other two cells are each other's
  // mirror), so opening both orbits joins every slot's route.
  open(goal);
  open(goal + 1);
  // 0-1 breadth-first search: entering a blocked cell costs 1, so the route opens as few cells as possible. `layer`
  // holds the cells first reached at the current cost (appended as zero-cost steps extend it), `next` those one more.
  const start = Math.floor(home.y) * MAP + Math.floor(home.x);
  const cost = new Int32Array(N).fill(N);
  const previous = new Int32Array(N).fill(-1);
  const settled = new Uint8Array(N);
  cost[start] = 0;
  let layer = [start];
  for (let k = 0; !settled[goal]; k++) {
    const next: number[] = [];
    for (let i = 0; i < layer.length; i++) {
      const c = layer[i]!;
      if (settled[c]) continue;
      settled[c] = 1;
      const x = c % MAP, y = Math.floor(c / MAP);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        const n = ny * MAP + nx;
        if (!inside(nx, ny, MAP) || settled[n] || avoid(nx, ny)) continue;
        const step = isSurfaceBlocked(terrain[n]!) ? 1 : 0;
        if (cost[n]! <= k + step) continue;
        cost[n] = k + step;
        previous[n] = c;
        (step ? next : layer).push(n);
      }
    }
    layer = next;
  }
  for (let c = goal; c !== start; c = previous[c]!) open(c);
}

/**
 * Fault lines over open ground, `map.faultSets` symmetric sets at most (one line per slot sector): with chance
 * `map.centralFault` one set is a fault through the centre that is its own rotation (two slots: one self-mirrored
 * line; four slots: a centre cross of two lines) (default: 3–4 lines on two slots). Cells in order.
 */
function generateFaults(rng: Rng, terrain: Uint8Array, map: MapRules, sides: 2 | 4, spires: readonly Point[], reserved: (x: number, y: number) => boolean): number[][] {
  const MAP = map.size;
  const N = MAP * MAP;
  const step = 4 / sides;
  const taken = new Uint8Array(N);
  const faults: number[][] = [];
  const fault = map.fault;
  /** Is cell `c` or one of its rotations marked in `cells`? */
  const orbitIn = (cells: Uint8Array, c: number): boolean => {
    for (let r = 0; r < sides; r++) if (cells[rotCell(r * step, c, MAP)]) return true;
    return false;
  };
  const ok = (c: number): boolean => {
    const x = c % MAP;
    const y = Math.floor(c / MAP);
    return (
      x >= fault.edge && y >= fault.edge && x <= MAP - 1 - fault.edge && y <= MAP - 1 - fault.edge && terrain[c] !== SURFACE.cliff && surfaceFeature(terrain[c]!) !== SURFACE.water && !orbitIn(taken, c) && spireDist(spires, x, y) >= Math.max(fault.clearance, map.homeLodeMaxRadius + LODE_SEAL) && !reserved(x, y)
    );
  };
  /** 8-connected walk along a wandering heading; stops early at the edge, a cliff, near a Spire or on its own orbit. */
  const walk = (x0: number, y0: number, a0: number, len: number): number[] => {
    const cells: number[] = [];
    const avoid = new Uint8Array(N);
    let x = x0;
    let y = y0;
    let a = a0;
    for (let i = 0; i < len; i++) {
      const c = Math.floor(y) * MAP + Math.floor(x);
      if (!ok(c) || orbitIn(avoid, c)) break;
      if (cells[cells.length - 1] !== c) cells.push(c);
      avoid[c] = 1;
      a += (rng.next() - 0.5) * FAULT_WALK.wander;
      x += dmath.cos(a);
      y += dmath.sin(a);
    }
    return cells;
  };
  const claim = (cells: number[]): void => {
    for (const c of cells) taken[c] = 1;
  };
  const central = rng.next() < map.centralFault && map.faultSets > 0;
  let sets = 0;
  if (central) {
    const a = Math.PI * FAULT_WALK.angle + (rng.next() - 0.5) * FAULT_WALK.centralJitter;
    const half = walk(MAP / 2 + 0.5, MAP / 2 + 0.5, a, fault.centralHalf);
    const line = [...half.map((c) => rotCell(2, c, MAP)).reverse(), ...half];
    if (line.length >= fault.centralMin) {
      // Two slots: the line is its own mirror. Four slots: its quarter turn crosses it at the centre.
      const cross = sides === 2 ? [line] : [line, line.map((c) => rotCell(1, c, MAP))];
      for (const path of cross) claim(path);
      faults.push(...cross);
      sets++;
    }
  }
  const wanted = map.faultSets - sets;
  for (let p = 0, tries = 0; p < wanted && tries < FAULT_WALK.triesPerPair * Math.max(FAULT_WALK.minTriesPairs, wanted); tries++) {
    const x = fault.margin + rng.next() * (MAP - 2 * fault.margin);
    const y = fault.margin + rng.next() * (MAP - 2 * fault.margin);
    const a = Math.PI * FAULT_WALK.angle + (rng.next() - 0.5) * FAULT_WALK.jitter + (rng.next() < 0.5 ? 0 : Math.PI);
    const line = walk(x, y, a, fault.length + rng.int(fault.lengthSpan));
    if (line.length < fault.minLength) continue;
    for (let r = 0; r < sides; r++) {
      const twin = r === 0 ? line : line.map((c) => rotCell(r * step, c, MAP));
      claim(twin);
      faults.push(twin);
    }
    p++;
  }
  return faults;
}

/**
 * The Mother Lode's cells (map.motherLode) in orbit order: each canonical seed, then its rotations. Whole orbits only,
 * up to `cells` rounded down to a multiple of `sides`. centre: the centre 2×2 (two slots: (h−1, h−1)'s pair first,
 * then (h, h−1)'s; four slots: (h−1, h−1)'s quarter turns). ring: `orbits × sides` cells evenly spaced on a circle of
 * `radius` (S48 tiles, scaled) about the centre, half a spacing off slot 0's Spire bearing and so off every Spire's. An
 * orbit is skipped when it repeats a cell, or a cell or its ring (Chebyshev ringWidth) leaves the inner map or touches
 * `pocket` (the Spire pockets). Rules and slots alone decide it: never a hidden layer.
 */
function motherLodeOrbits(map: MapRules, sides: 2 | 4, pocket: Uint8Array): number[] {
  const rules = map.motherLode;
  const MAP = map.size;
  const h = MAP / 2;
  const turn = 4 / sides;
  const wanted = rules.enabled ? Math.floor(rules.cells / sides) * sides : 0;
  const seeds: number[] = [];
  if (rules.placement === 'centre') {
    seeds.push((h - 1) * MAP + h - 1);
    if (sides === 2) seeds.push((h - 1) * MAP + h);
  } else if (wanted > 0) {
    const radius = (rules.radius * MAP) / REFERENCE_MAP_SIZE;
    const home = slotSpires(map, sides)[0]!;
    const bearing = dmath.atan2(home.y - h, home.x - h);
    for (let k = 0; k < wanted / sides; k++) {
      const a = bearing + ((k + 0.5) * 2 * Math.PI) / wanted;
      seeds.push(Math.floor(h + radius * dmath.sin(a)) * MAP + Math.floor(h + radius * dmath.cos(a)));
    }
  }
  const w = rules.ringWidth;
  const out: number[] = [];
  for (const seed of seeds) {
    if (out.length >= wanted) break;
    const orbit = Array.from({ length: sides }, (_, r) => rotCell(r * turn, seed, MAP));
    if (new Set(orbit).size !== sides || orbit.some((c) => out.includes(c))) continue;
    const fits = orbit.every((c) => {
      const x = c % MAP;
      const y = Math.floor(c / MAP);
      if (x - w < 1 || y - w < 1 || x + w > MAP - 2 || y + w > MAP - 2) return false;
      for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) if (pocket[(y + dy) * MAP + x + dx]) return false;
      return true;
    });
    if (fits) out.push(...orbit);
  }
  return out;
}

/**
 * Green rich ore (map.richOre) in orbit order: each canonical cell, then its rotations. Cluster k aims at a bearing
 * from the map centre `bearing` degrees off slot 0's Spire bearing (alternating sides, wider each pair), `radius` S48
 * tiles out (scaled); its cells are a centre then its canonical +x, +y, −x, −y neighbours. A cell fits inside slot 0's
 * sector and the inner map when its reservation touches no Spire pocket, no `reserved` cell (the Mother Lode's
 * reservation, the public lode sites' seals and the flank sites) and no earlier cluster's cell; the cluster takes the
 * centre nearest its aim (squared cell distance, ties by lower cell) where every cell fits, or is skipped when none
 * does. Rules, slots and public layers alone decide it: never a hidden layer.
 */
function richOreOrbits(map: MapRules, sides: 2 | 4, pocket: Uint8Array, reserved: (x: number, y: number) => boolean): number[] {
  const rules = map.richOre;
  const MAP = map.size, N = MAP * MAP, h = MAP / 2, turn = 4 / sides;
  const home = slotSpires(map, sides)[0]!;
  const radius = (rules.radius * MAP) / REFERENCE_MAP_SIZE;
  const reach = map.lavaLakes.enabled ? map.lavaLakes.moatWidth + 2 : 1;
  const offsets = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]] as const;
  const count = Math.min(rules.cells, offsets.length);
  // 1: the cell fits; 0: it does not, or an earlier cluster took it.
  const fit = new Uint8Array(N);
  for (let y = 1 + reach; y <= MAP - 2 - reach; y++) for (let x = 1 + reach; x <= MAP - 2 - reach; x++) {
    if (sectorOf(x + 0.5, y + 0.5, MAP, sides) !== 0) continue;
    let blocked = false;
    for (let dy = -reach; dy <= reach && !blocked; dy++) for (let dx = -reach; dx <= reach; dx++) if (pocket[(y + dy) * MAP + x + dx] || reserved(x + dx, y + dy)) { blocked = true; break; }
    if (!blocked) fit[y * MAP + x] = 1;
  }
  const out: number[] = [];
  for (let k = 0; k < rules.clusters; k++) {
    const spread = (rules.bearing * (1 + Math.floor(k / 2)) * Math.PI) / 180;
    const a = dmath.atan2(home.y - h, home.x - h) + (k % 2 === 0 ? spread : -spread);
    const cx = Math.floor(h + radius * dmath.cos(a)), cy = Math.floor(h + radius * dmath.sin(a));
    let best = -1, bestDistance = Infinity;
    for (let c = 0; c < N; c++) {
      const x = c % MAP, y = Math.floor(c / MAP), d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d >= bestDistance) continue;
      let fits = true;
      for (let i = 0; i < count && fits; i++) {
        const ox = x + offsets[i]![0], oy = y + offsets[i]![1];
        fits = ox >= 0 && oy >= 0 && ox < MAP && oy < MAP && fit[oy * MAP + ox] === 1;
      }
      if (fits) { best = c; bestDistance = d; }
    }
    if (best < 0) continue;
    for (let i = 0; i < count; i++) {
      const c = best + offsets[i]![1] * MAP + offsets[i]![0];
      fit[c] = 0;
      for (let r = 0; r < sides; r++) out.push(rotCell(r * turn, c, MAP));
    }
  }
  return out;
}

/** Lava-lake placement tries per requested lake, budgeted for at least minTries. */
const LAKE_TRIES = { perLake: 30, minTries: 30 } as const;

/**
 * Permanent lava lakes (map.lavaLakes), drawn in slot 0's sector and written with all their rotations: a moat round
 * every green rich-ore cluster one rock tile out from its cells; a channel across each cavern arm at channelDistance
 * from the Spire, with a dry detour carved round its end when it cut the arm (a short bridge beats the long way round);
 * and `lakes` seeded lakes with an ore island in the middle. `keep`: cells no lava may take (Spire pockets, the Mother
 * Lode and lode reservations); `richKeep`: the rich clusters' reservation, which only their moats enter. Lava that takes
 * a hidden magma cell drains the rest of its pocket to plain rock (every pocket stays one connected piece or goes), and
 * a taken cell leaves the cavern knowledge with all its rotations (slot 0's cavern may run past its own sector).
 */
function lavaLakes(map: MapRules, rng: Rng, ground: Pick<World, 'cells' | 'ore' | 'magma'>, sides: 2 | 4, at: {
  spires: readonly Point[]; cavern: Set<number>; richCells: readonly number[]; richKeep: Uint8Array; keep: (x: number, y: number) => boolean;
}): void {
  const { cells, ore, magma } = ground;
  const rules = map.lavaLakes, MAP = map.size, N = MAP * MAP, turn = 4 / sides, scale = MAP / REFERENCE_MAP_SIZE;
  const home = at.spires[0]!;
  const canonical = (x: number, y: number): boolean => inside(x, y, MAP) && sectorOf(x + 0.5, y + 0.5, MAP, sides) === 0;
  /** Magma pockets lava took a cell of: drained once all lava is drawn. */
  const drained = new Set<number>();
  const lava = (x: number, y: number): void => {
    for (let r = 0; r < sides; r++) {
      const c = rotCell(r * turn, y * MAP + x, MAP);
      if (magma[c]) drained.add(magma[c]!);
      cells[c] = CELL.lake;
      ore[c] = 0;
      magma[c] = 0;
      at.cavern.delete(c);
    }
  };
  // Moats: every cell 2..1 + moatWidth tiles (Chebyshev) from the nearest rich cell of slot 0's sector.
  const rich = at.richCells.filter((c) => canonical(c % MAP, Math.floor(c / MAP)));
  if (rules.moatWidth > 0) {
    const reach = rules.moatWidth + 1;
    const moat = new Set<number>();
    for (const c of rich) for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const x = c % MAP + dx, y = Math.floor(c / MAP) + dy;
      if (!canonical(x, y) || at.keep(x, y) || cells[y * MAP + x] === CELL.rich) continue;
      let near = Infinity;
      for (const r of rich) near = Math.min(near, Math.max(Math.abs(r % MAP - x), Math.abs(Math.floor(r / MAP) - y)));
      if (near >= 2 && near <= reach) moat.add(y * MAP + x);
    }
    for (const c of [...moat].sort((a, b) => a - b)) lava(c % MAP, Math.floor(c / MAP));
  }
  // Channels across the cavern arm, perpendicular to the Spire→centre line.
  const arm = [...at.cavern].filter((c) => canonical(c % MAP, Math.floor(c / MAP)) && !at.keep(c % MAP, Math.floor(c / MAP)) && !at.richKeep[c]);
  if (rules.channels > 0 && arm.length) {
    const want = rules.channelDistance * scale;
    let cross = arm[0]!;
    const off = (c: number): number => Math.abs(norm(c % MAP + 0.5 - home.x, Math.floor(c / MAP) + 0.5 - home.y) - want);
    for (const c of arm) if (off(c) < off(cross) || (off(c) === off(cross) && c < cross)) cross = c;
    const len = norm(MAP / 2 - home.x, MAP / 2 - home.y);
    const dx = (MAP / 2 - home.x) / len, dy = (MAP / 2 - home.y) / len;
    const ox = cross % MAP + 0.5, oy = Math.floor(cross / MAP) + 0.5, half = (rules.channelLength * scale) / 2, w = rules.channelWidth;
    const channel = new Set<number>();
    for (let s = -half; s <= half + GEOM_EPS; s += 0.5) for (let k = 0; k < w; k++) {
      const along = k - (w - 1) / 2;
      const x = Math.floor(ox - dy * s + dx * along), y = Math.floor(oy + dx * s + dy * along);
      if (canonical(x, y) && !at.keep(x, y) && !at.richKeep[y * MAP + x]) channel.add(y * MAP + x);
    }
    for (const c of [...channel].sort((a, b) => a - b)) lava(c % MAP, Math.floor(c / MAP));
  }
  // Seeded lakes with an ore island in the middle, away from the Spires, caverns, pockets and reservations.
  const radius = rules.lakeRadius, reach = Math.ceil(radius);
  const mapCentre = (c: number): number => norm(c % MAP + 0.5 - MAP / 2, Math.floor(c / MAP) + 0.5 - MAP / 2);
  for (let k = 0, tries = 0; k < rules.lakes && tries < Math.max(LAKE_TRIES.minTries, LAKE_TRIES.perLake * rules.lakes); tries++) {
    const cx = rules.margin + rng.int(MAP - 2 * rules.margin), cy = rules.margin + rng.int(MAP - 2 * rules.margin);
    if (at.spires.some((p) => norm(cx + 0.5 - p.x, cy + 0.5 - p.y) <= map.homeLodeMaxRadius + LODE_SEAL + radius)) continue;
    const disc: number[] = [];
    let fits = true;
    for (let dy = -reach; dy <= reach && fits; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const x = cx + dx, y = cy + dy, c = y * MAP + x;
      if (norm(dx, dy) > radius) continue;
      if (!canonical(x, y) || at.keep(x, y) || at.richKeep[c] || magma[c] || (cells[c] !== CELL.rock && cells[c] !== CELL.ore && cells[c] !== CELL.bedrock)) { fits = false; break; }
      disc.push(c);
    }
    if (!fits) continue;
    for (const c of disc) {
      const x = c % MAP, y = Math.floor(c / MAP);
      if (norm(x - cx, y - cy) > rules.islandRadius) lava(x, y);
      else for (let r = 0; r < sides; r++) {
        const t = rotCell(r * turn, c, MAP);
        cells[t] = CELL.ore;
        ore[t] = map.oreRim + Math.round((map.oreCentre - map.oreRim) * Math.max(0, 1 - mapCentre(c) / (map.oreFalloff * scale)));
      }
    }
    k++;
  }
  if (drained.size) for (let c = 0; c < N; c++) if (drained.has(magma[c]!)) magma[c] = 0;
  // The dry way round: the route from the home pocket to the centre chamber in slot 0's sector that crosses the fewest
  // lava cells, then digs the fewest rock cells (open cells free; a lava step costs N, more than any all-rock route), is
  // carved as tunnel with its rotations, so a bridge is a shortcut, never the only way. Nothing is carved while the arm
  // still connects; lava is crossed (and turned to tunnel) only where lakes, moats and channels together wall the
  // chamber off inside the sector. A carved route joins the cavern, so every home still starts knowing a way to the
  // centre (round the gap the lava left in its knowledge).
  const passable = (c: number): boolean => {
    const v = cells[c]!;
    return canonical(c % MAP, Math.floor(c / MAP)) && v !== CELL.bedrock && v !== CELL.lode && v !== CELL.rich && !magma[c];
  };
  const chamber = (c: number): boolean => (cells[c] === CELL.tunnel || cells[c] === CELL.rail) && mapCentre(c) <= map.cavern.centreRadius + map.motherLode.ringWidth + 1;
  // Uniform-cost search on a binary min-heap of keys cost·N + cell (exact integers; ties pop the lower cell). A cell is
  // pushed once per improvement, by a finalised neighbour: four pushes per cell at most.
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N), heap = new Float64Array(4 * N + 1);
  let heapSize = 0;
  const push = (key: number): void => {
    let i = heapSize++;
    while (i > 0 && heap[(i - 1) >> 1]! > key) { heap[i] = heap[(i - 1) >> 1]!; i = (i - 1) >> 1; }
    heap[i] = key;
  };
  const start = Math.floor(home.y) * MAP + Math.floor(home.x);
  dist[start] = 0;
  push(start);
  let end = -1;
  while (heapSize > 0) {
    const top = heap[0]!, last = heap[--heapSize]!;
    for (let i = 0; ;) {
      let k = 2 * i + 1;
      if (k + 1 < heapSize && heap[k + 1]! < heap[k]!) k++;
      if (k >= heapSize || heap[k]! >= last) { heap[i] = last; break; }
      heap[i] = heap[k]!;
      i = k;
    }
    const c = top % N, x = c % MAP;
    if (done[c]) continue;
    done[c] = 1;
    if (chamber(c)) { end = c; break; }
    for (const n of [x < MAP - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + MAP, c - MAP]) {
      if (n < 0 || n >= N || done[n] || !passable(n)) continue;
      const v = cells[n]!;
      const d = dist[c]! + (v === CELL.tunnel || v === CELL.rail ? 0 : isLava(v) ? N : 1);
      if (d >= dist[n]!) continue;
      dist[n] = d;
      prev[n] = c;
      push(d * N + n);
    }
  }
  if (end < 0 || dist[end] === 0) return;
  for (let c = end; c !== start; c = prev[c]!) {
    at.cavern.add(c);
    if (cells[c] === CELL.tunnel || cells[c] === CELL.rail) continue;
    for (let r = 0; r < sides; r++) {
      const t = rotCell(r * turn, c, MAP);
      cells[t] = CELL.tunnel;
      ore[t] = 0;
    }
  }
}

/**
 * `seed` (public) shapes what every player is told: faults and island orbits (terrain comes in already generated),
 * and the lode sites levelled from those public layers; the rules alone place the Mother Lode and its tunnel ring.
 * `hiddenSeed` (secret per match on a live server) shapes the fogged layers around them: Depths cells and caverns,
 * magma, ore and which sites hold lodes. Hidden stages may read public layers, never the reverse, and never edit the
 * Surface.
 */
export function generateWorld(seed: number, terrain: Terrain, map: MapRules, sides: 2 | 4, hiddenSeed: number): World {
  const MAP = map.size;
  const N = MAP * MAP;
  const inner = (x: number, y: number): boolean => inside(x, y, MAP);
  const stageSeed = seed;
  const scale = MAP / REFERENCE_MAP_SIZE;
  const area = scale * scale;
  const turn = 4 / sides;
  let rng = new Rng(hiddenSeed ^ STAGE_SALT.depths);
  const cells = new Uint8Array(N).fill(CELL.rock);
  const owner = new Uint8Array(N);
  /** Write Depths cell (x, y) and its rotations. */
  const set = (x: number, y: number, v: number): void => {
    if (!inner(x, y)) return;
    for (let r = 0; r < sides; r++) cells[rotCell(r * turn, y * MAP + x, MAP)] = v;
  };
  for (let i = 0; i < MAP; i++) {
    cells[i] = CELL.bedrock;
    cells[(MAP - 1) * MAP + i] = CELL.bedrock;
    cells[i * MAP] = CELL.bedrock;
    cells[i * MAP + MAP - 1] = CELL.bedrock;
  }
  const spires = slotSpires(map, sides);
  const home = spires[0]!;
  const template = terrain.preset !== undefined && isTemplatePreset(terrain.preset);
  // Templates reserve the flank anchors' lode sites (cleared on the surface by generateTerrain) in the Depths too.
  const reserved = flankSites(map, sides, LODE_SEAL);
  const flankSite = (x: number, y: number): boolean => template && reserved(x, y);
  // Faults are public: drawn from the public seed before any hidden stage, around public reservations only. Lodes
  // then keep off them (the Headframe site rule rejects fault cells), so a fault never reveals where a lode is.
  const faults = generateFaults(new Rng(stageSeed ^ STAGE_SALT.faults), terrain.terrain, map, sides, spires, flankSite);
  for (const path of faults) for (const c of path) terrain.terrain[c] = withSurfaceFeature(terrain.terrain[c]!, SURFACE.fault);

  // The Depths the public map already implies, which prepared lode sites keep their seals off: the Spire pockets
  // (slot s's are owned by s + 1), a route template's whole cavern (it follows the public surface route) and the
  // free-form cavern's start, straight down the diagonal across the home lode band, with every cell beside it (its
  // side chambers may open those).
  const dug = new Uint8Array(N);
  // Tunnel pocket includes the complete root and a connected one-cell loading apron around its solid footprint.
  const pocket = new Uint8Array(N);
  for (let slot = 0; slot < sides; slot++) {
    const p = spires[slot]!;
    for (let y = 0; y < MAP; y++) {
      for (let x = 0; x < MAP; x++) {
        if (norm(x + 0.5 - p.x, y + 0.5 - p.y) <= map.spirePocketRadius ||
          (Math.abs(x + 0.5 - p.x) < STATS.spire.footprint.w / 2 + STRUCTURE_SPACING &&
            Math.abs(y + 0.5 - p.y) < STATS.spire.footprint.h / 2 + STRUCTURE_SPACING)) {
          pocket[y * MAP + x] = slot + 1;
          dug[y * MAP + x] = 1;
        }
      }
    }
  }
  // The Mother Lode is public (map.motherLode, no random draw): reserved here, before any hidden stage, which all keep
  // off it, so the published seed and rules reproduce it exactly. `mother`: 1 a lode cell (solid, never dug), 2 its
  // open tunnel ring (owned by nobody); `motherKeep` adds a one-cell margin outcrops and magma pockets never enter, so
  // no pocket borders the ring (a breach there would flood it; lode cells are solid, so floods never reach them).
  const mother = new Uint8Array(N);
  const motherKeep = new Uint8Array(N);
  const ringWidth = map.motherLode.ringWidth;
  const motherCells = motherLodeOrbits(map, sides, pocket);
  for (const c of motherCells) {
    const x = c % MAP, y = Math.floor(c / MAP);
    for (let dy = -ringWidth - 1; dy <= ringWidth + 1; dy++) for (let dx = -ringWidth - 1; dx <= ringWidth + 1; dx++) {
      const n = (y + dy) * MAP + x + dx;
      motherKeep[n] = 1;
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= ringWidth && !mother[n]) mother[n] = 2;
    }
  }
  for (const c of motherCells) mother[c] = 1;
  for (let c = 0; c < N; c++) if (mother[c]) {
    cells[c] = mother[c] === 1 ? CELL.lode : CELL.tunnel;
    dug[c] = 1;
  }
  // Four slots: template caverns stay out of the flank sites (see openTemplateRoute).
  const avoid = sides === 4 ? flankSite : (): boolean => false;
  /** Can the cavern open cell (x, y) (route templates: never under a cliff or water)? */
  const carvable = (x: number, y: number): boolean => inner(x, y) && !avoid(x, y) && mother[y * MAP + x] !== 1 && cells[y * MAP + x] !== CELL.rich &&
    !(template && (terrain.terrain[y * MAP + x] === SURFACE.cliff || surfaceFeature(terrain.terrain[y * MAP + x]!) === SURFACE.water));
  /** A route template's cavern cells in carving order (canonical: each is carved with its rotations). */
  const templateCavern: number[] = [];
  if (map.caverns && template) {
    // Follow the surface route generateTerrain guarantees, then carry its bottlenecks underground.
    const dig = (x: number, y: number): void => {
      if (carvable(x, y)) templateCavern.push(y * MAP + x);
    };
    const start = Math.floor(home.y) * MAP + Math.floor(home.x);
    const goal = centreChamberCell(MAP);
    const previous = new Int32Array(N).fill(-1);
    const queue = [start];
    previous[start] = start;
    for (let i = 0; i < queue.length && previous[goal]! < 0; i++) {
      const c = queue[i]!;
      for (const n of [c % MAP > 1 ? c - 1 : -1, c % MAP < MAP - 2 ? c + 1 : -1, c - MAP, c + MAP]) {
        if (n < MAP || n >= N - MAP || previous[n]! >= 0 || terrain.terrain[n] === SURFACE.cliff || surfaceFeature(terrain.terrain[n]!) === SURFACE.water || avoid(n % MAP, Math.floor(n / MAP))) continue;
        previous[n] = c;
        queue.push(n);
      }
    }
    if (previous[goal]! < 0) throw new Error('Template terrain lacks its route to the central chamber');
    const route: number[] = [];
    for (let c = goal; ; c = previous[c]!) {
      route.push(c);
      if (c === start) break;
    }
    const chambers = Math.round(map.cavernChambers * scale);
    const interval = Math.max(1, Math.ceil(route.length / (chambers + 1)));
    for (let i = 0; i < route.length; i++) {
      const c = route[i]!, x = c % MAP, y = Math.floor(c / MAP);
      dig(x, y);
      if (chambers && i > 0 && i % interval === 0 && i / interval <= chambers && spireDist(spires, x, y) > map.homeLodeMaxRadius + LODE_SEAL) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) dig(x + dx, y + dy);
      }
    }
    for (let y = MAP / 2 - 1; y <= MAP / 2; y++) for (let x = MAP / 2 - 1; x <= MAP / 2; x++) dig(x, y);
    for (const c of templateCavern) for (let r = 0; r < sides; r++) dug[rotCell(r * turn, c, MAP)] = 1;
  }
  /** Free-form caverns run straight down the diagonal (no random draw) while within this of the home Spire. */
  const nearHome = (x: number, y: number): boolean => norm(x + 0.5 - home.x, y + 0.5 - home.y) <= map.homeLodeMaxRadius + LODE_SEAL;
  /** The free-form cavern's diagonal step from (x, y) toward the centre cell (goal, goal): along x unless x leads. */
  const diagonalX = (x: number, y: number, goal: number): boolean => x !== goal && (y === goal || x <= y);
  if (map.caverns && !template) {
    const goal = MAP / 2 - 1;
    for (let x = Math.floor(home.x) + 1, y = Math.floor(home.y) + 1; ;) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inner(x + dx, y + dy)) for (let r = 0; r < sides; r++) dug[rotCell(r * turn, (y + dy) * MAP + x + dx, MAP)] = 1;
      if ((x === goal && y === goal) || !nearHome(x, y)) break;
      if (diagonalX(x, y, goal)) x += Math.sign(goal - x);
      else y += Math.sign(goal - y);
    }
  }
  // Lode sites are public: the Surface is levelled for them from public layers alone, so it is final before any hidden
  // stage reads it, and the secret lode placement only chooses among sites that fit.
  const sites = prepareLodeSites(map, terrain.terrain, dug, sides);
  const kept = new Uint8Array(N);
  const reserveReach = Math.max(LODE_SEAL, LODE_POCKET + LODE_APRON);
  for (const site of sites.sites) for (let dy = -reserveReach; dy <= reserveReach; dy++) for (let dx = -reserveReach; dx <= reserveReach; dx++) for (let r = 0; r < sides; r++) kept[rotCell(r * turn, site + dy * MAP + dx, MAP)] = 1;
  // Reserve public prepared pockets before choosing flags: no post can consume the zone's guaranteed capacity.
  // Secret placement then keeps every actual outcrop/apron off those public posts, including fallback sites.
  const posts = recipePosts(terrain.terrain, MAP, sides, home, map, kept);
  // Green rich ore is public too (map.richOre, no random draw): placed from the rules and the public layers after the
  // lode sites, keeping off their reservations (`kept`), the flank sites and the Mother Lode's, so it never costs the
  // lode economy a site. `richKeep` reserves its cells, their one-tile rock apron and (with lava lakes) the moat beyond
  // it from every later stage. With map.richOre off nothing here touches the generation.
  const richCells = map.richOre.enabled ? richOreOrbits(map, sides, pocket, (x, y) => motherKeep[y * MAP + x] === 1 || kept[y * MAP + x] === 1 || flankSite(x, y)) : [];
  const richKeep = new Uint8Array(N);
  const moat = map.lavaLakes.enabled ? map.lavaLakes.moatWidth : 0;
  for (const c of richCells) {
    const x = c % MAP, y = Math.floor(c / MAP), reach = moat + 2;
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      if (!inside(x + dx, y + dy, MAP)) continue;
      richKeep[(y + dy) * MAP + x + dx] = 1;
    }
  }
  for (const c of richCells) cells[c] = CELL.rich;

  // Four slots: every feature has `sides` copies, twice the two-slot density, so random outcrops, magma, veins and
  // faults would crowd lode sites out. There the lodes are placed right after the caverns and Spire pockets, and the
  // later stages keep off their footprints and aprons (`lodeSite`). Two slots keep the original stage order. Random
  // outcrops and magma also keep off every public site's seal (`kept`), so the sites prepared for a zone stay open.
  const early = sides === 4;
  const lodeSite = new Uint8Array(N);
  const claimed = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP && y < MAP && (lodeSite[y * MAP + x] === 1 || kept[y * MAP + x] === 1 || motherKeep[y * MAP + x] === 1 || richKeep[y * MAP + x] === 1);
  const magma = new Uint8Array(N);
  const ore = new Uint8Array(N);
  for (const c of richCells) ore[c] = map.richOre.loads;

  // A few bedrock outcrops: tunnels must route around them. `reach` covers the largest radius a draw can give. Drawn
  // after the caverns on four slots, they keep off its tunnels and the lode sites.
  const outcrops = (): void => {
    const bedrock = map.bedrock;
    const reach = Math.floor(bedrock.radius + bedrock.radiusSpan);
    for (let b = 0; b < Math.round(map.bedrockOutcrops * area); b++) {
      const cx = bedrock.margin + rng.int(MAP - 2 * bedrock.margin);
      const cy = bedrock.margin + rng.int(MAP / 2 - bedrock.margin);
      const r = bedrock.radius + rng.next() * bedrock.radiusSpan;
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const x = cx + dx, y = cy + dy;
        if (claimed(x, y) || (early && cells[y * MAP + x] === CELL.tunnel)) continue;
        if (dx * dx + dy * dy <= r * r && spireDist(spires, x, y) > map.homeLodeMaxRadius + LODE_SEAL && !flankSite(x, y)) set(x, y, CELL.bedrock);
      }
    }
  };
  if (!early) outcrops();

  // Route topology is shared across planes; water basins and cliffs have solid foundations (lode sites were levelled
  // above, so none stands on them), except under the Mother Lode's reservation.
  if (template) for (let c = 0; c < N; c++) if (!mother[c] && cells[c] !== CELL.rich && (terrain.terrain[c] === SURFACE.cliff || surfaceFeature(terrain.terrain[c]!) === SURFACE.water)) cells[c] = CELL.bedrock;

  // Natural caverns: a winding tunnel from each base pocket to a chamber at the centre, with side chambers.
  const cavern = new Set<number>();
  const carve = (x: number, y: number): void => {
    if (!carvable(x, y)) return;
    set(x, y, CELL.tunnel);
    cavern.add(y * MAP + x);
  };
  if (map.caverns && template) {
    for (const c of templateCavern) carve(c % MAP, Math.floor(c / MAP));
  } else if (map.caverns) {
    // From a pocket cell (the pocket is dug below) to the centre; after CAVERN_WALK.wanderSteps steps it heads straight there. Across the
    // home lode band it runs straight down the diagonal, so a Spire near the corner keeps both flanks for its lodes.
    let x = Math.floor(home.x) + 1;
    let y = Math.floor(home.y) + 1;
    const goal = MAP / 2 - 1;
    const cavernRules = map.cavern;
    const chambers = new Set(Array.from({ length: Math.round(map.cavernChambers * scale) }, (_, k) => cavernRules.chamberFirst + cavernRules.chamberSpacing * k + rng.int(CAVERN_WALK.chamberJitter)));
    for (let step = 0; x !== goal || y !== goal; step++) {
      carve(x, y);
      if (chambers.has(step)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (rng.next() < CAVERN_WALK.chamberFill) carve(x + dx, y + dy);
      if (nearHome(x, y)) {
        if (diagonalX(x, y, goal)) x += Math.sign(goal - x);
        else y += Math.sign(goal - y);
        continue;
      }
      const toward = step >= CAVERN_WALK.wanderSteps || rng.next() < CAVERN_WALK.toward;
      if (toward) {
        if (x !== goal && (y === goal || rng.next() < 0.5)) x += Math.sign(goal - x);
        else y += Math.sign(goal - y);
      } else if (rng.next() < 0.5) x = Math.min(MAP - 1 - cavernRules.edge, Math.max(cavernRules.edge, x + (rng.next() < 0.5 ? 1 : -1)));
      else y = Math.min(MAP - 1 - cavernRules.edge, Math.max(cavernRules.edge, y + (rng.next() < 0.5 ? 1 : -1)));
    }
    // The centre chamber: every cell whose centre lies within centreRadius of the map centre (row/column range first).
    const r = cavernRules.centreRadius;
    const lo = MAP / 2 + Math.ceil(-r - 0.5), hi = MAP / 2 + Math.floor(r - 0.5);
    for (let yy = lo; yy <= hi; yy++) for (let xx = lo; xx <= hi; xx++) if (norm(xx + 0.5 - MAP / 2, yy + 0.5 - MAP / 2) <= r) carve(xx, yy);
  }

  for (let c = 0; c < N; c++) if (pocket[c]) {
    cells[c] = CELL.tunnel;
    owner[c] = pocket[c]!;
  }

  let placement: LodePlacement | undefined;
  if (early) {
    placement = placeLodes(map, new Rng(hiddenSeed ^ STAGE_SALT.features), { cells, ore, magma, terrain: terrain.terrain }, sides, sites, posts);
    // Each lode's sealed footprint (Depths) and outcrop apron (Surface).
    const reach = Math.max(LODE_SEAL, LODE_POCKET + LODE_APRON);
    for (const lode of placement.lodes) for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) lodeSite[lode.c + dy * MAP + dx] = 1;
    outcrops();
  }

  rng = new Rng(hiddenSeed ^ STAGE_SALT.magma);
  // Hidden magma pockets in the rock between the bases, in orbits: pocket set k's rotation r is pocket sides·k + r + 1.
  /** Is a rotation r ≥ 1 of cell `c` in `cells` (or `c` itself, if the rotation fixes it)? */
  const twinIn = (cells: readonly number[], c: number): boolean => {
    for (let r = 1; r < sides; r++) if (cells.includes(rotCell(r * turn, c, MAP))) return true;
    return false;
  };
  for (let k = 0, tries = 0; k < Math.round(map.magmaPockets * area) && tries < MAGMA_GROWTH.triesPerPocket * Math.max(MAGMA_GROWTH.minTriesPockets, map.magmaPockets * area); tries++) {
    const x = map.magma.margin + rng.int(MAP - 2 * map.magma.margin);
    const y = map.magma.margin + rng.int(MAP - 2 * map.magma.margin);
    const c = y * MAP + x;
    if (spireDist(spires, x, y) <= map.homeLodeMaxRadius + LODE_SEAL || flankSite(x, y) || claimed(x, y) || cells[c] !== CELL.rock || magma[c] || twinIn([c], c)) continue;
    const pocket = [c];
    for (const n of [c + 1, c + MAP, c - 1]) if (pocket.length < map.magma.cells && spireDist(spires, n % MAP, Math.floor(n / MAP)) > map.homeLodeMaxRadius + LODE_SEAL && !flankSite(n % MAP, Math.floor(n / MAP)) && !claimed(n % MAP, Math.floor(n / MAP)) && cells[n] === CELL.rock && !magma[n] && rng.next() < MAGMA_GROWTH.grow) pocket.push(n);
    if (pocket.some((p) => twinIn(pocket, p))) continue;
    for (const p of pocket) for (let r = 0; r < sides; r++) magma[rotCell(r * turn, p, MAP)] = sides * k + r + 1;
    k++;
  }
  // Ore can decorate solid rock, never overwrite a route, bedrock, hidden magma or a lode site.
  const putOre = (x: number, y: number): void => {
    const c = y * MAP + x;
    if (inner(x, y) && (cells[c] === CELL.rock || cells[c] === CELL.ore) && !magma[c] && !lodeSite[c]) set(x, y, CELL.ore);
  };
  const veins = map.vein;
  const vein = (sx: number, sy: number, len: number): void => {
    let x = sx;
    let y = sy;
    for (let i = 0; i < len; i++) {
      putOre(x, y);
      if (rng.next() < VEIN_WALK.branch) putOre(x + (rng.next() < 0.5 ? 1 : 0), y + (rng.next() < 0.5 ? 0 : 1));
      const d = rng.int(4);
      x = Math.min(MAP - 1 - veins.edge, Math.max(veins.edge, x + (d === 0 ? 1 : d === 1 ? -1 : 0)));
      y = Math.min(MAP - 1 - veins.edge, Math.max(veins.edge, y + (d === 2 ? 1 : d === 3 ? -1 : 0)));
    }
  };
  rng = new Rng(hiddenSeed ^ STAGE_SALT.ore);
  // Home veins a short dig from each Spire, so the first diggers have work.
  for (let v = 0; v < map.homeVeins; v++) {
    const a = rng.next() * Math.PI * 2;
    const d = veins.homeDistance + rng.next() * veins.homeDistanceSpan;
    // An offset that would leave the map on an axis turns back toward the interior (Spires near a corner).
    const x = Math.round(home.x + dmath.cos(a) * d);
    const y = Math.round(home.y + dmath.sin(a) * d);
    vein(inner(x, 1) ? x : Math.round(home.x - dmath.cos(a) * d), inner(1, y) ? y : Math.round(home.y - dmath.sin(a) * d), veins.homeLength + rng.int(veins.homeLengthSpan));
  }
  // Contested veins elsewhere (written with their rotations, so each exists once per slot).
  for (let v = 0; v < Math.round(map.contestedVeins * area); v++) {
    const x = veins.contestedMargin + rng.int(MAP - 2 * veins.contestedMargin);
    const y = veins.contestedMargin + rng.int(MAP - 2 * veins.contestedMargin);
    if (spireDist(spires, x, y) <= veins.contestedClear) continue;
    vein(x, y, veins.contestedLength + rng.int(veins.contestedLengthSpan));
  }
  // The centre is the richest: a big vein plus satellites close to it.
  vein(MAP / 2 - veins.centreOffset - rng.int(VEIN_WALK.centreJitter), MAP / 2 - veins.centreOffset - rng.int(VEIN_WALK.centreJitter), veins.centreLength);
  for (let v = 0; v < veins.satellites; v++) vein(MAP / 2 - veins.satelliteOffset + rng.int(VEIN_WALK.satelliteJitter), MAP / 2 - veins.satelliteOffset + rng.int(VEIN_WALK.satelliteJitter), veins.satelliteLength + rng.int(veins.satelliteLengthSpan));

  // Ore loads per cell rise from oreRim at the bases to oreCentre at the map centre, linearly over oreFalloff S48 tiles
  // (the richest veins are the contested ones). Veins are finite: about 9.5–13k alloy per map under the default rules,
  // a third of it in the contested centre. Lode pockets keep their own loads.
  for (let i = 0; i < N; i++) {
    if (cells[i] !== CELL.ore || lodeSite[i]) continue;
    const d = norm((i % MAP) + 0.5 - MAP / 2, Math.floor(i / MAP) + 0.5 - MAP / 2);
    ore[i] = map.oreRim + Math.round((map.oreCentre - map.oreRim) * Math.max(0, 1 - d / (map.oreFalloff * scale)));
  }

  placement ??= placeLodes(map, new Rng(hiddenSeed ^ STAGE_SALT.features), { cells, ore, magma, terrain: terrain.terrain }, sides, sites, posts);
  if (map.lavaLakes.enabled) {
    lavaLakes(map, new Rng(hiddenSeed ^ STAGE_SALT.lava), { cells, ore, magma }, sides, {
      spires, cavern, richCells, richKeep,
      keep: (x, y) => pocket[y * MAP + x] !== 0 || motherKeep[y * MAP + x] === 1 || kept[y * MAP + x] === 1 || lodeSite[y * MAP + x] === 1 || flankSite(x, y)
        || placement.lodes.some((l) => Math.max(Math.abs(l.c % MAP - x), Math.abs(Math.floor(l.c / MAP) - y)) <= LODE_SEAL + 1),
    });
  }
  // Overlapping outcrops, foundations and lode seals can wall off rock no tunnel could reach: seal it as bedrock.
  // Lode pockets stay: their seal is deliberate and a surface Headframe opens them.
  const reached = new Uint8Array(N);
  for (const lode of placement.lodes) for (let dy = 1 - LODE_SEAL; dy < LODE_SEAL; dy++) for (let dx = 1 - LODE_SEAL; dx < LODE_SEAL; dx++) reached[lode.c + dy * MAP + dx] = 1;
  const queue = new Int32Array(N);
  let end = 0;
  for (const spire of spires) {
    const start = Math.floor(spire.y) * MAP + Math.floor(spire.x);
    if (cells[start] !== CELL.bedrock && !reached[start]) { reached[start] = 1; queue[end++] = start; }
  }
  for (let at = 0; at < end; at++) {
    const c = queue[at]!, x = c % MAP;
    for (const next of [x > 0 ? c - 1 : -1, x < MAP - 1 ? c + 1 : -1, c - MAP, c + MAP]) {
      if (next < 0 || next >= N || reached[next] || cells[next] === CELL.bedrock) continue;
      reached[next] = 1; queue[end++] = next;
    }
  }
  for (let c = 0; c < N; c++) if (!reached[c] && cells[c] !== CELL.bedrock) { cells[c] = CELL.bedrock; ore[c] = 0; magma[c] = 0; cavern.delete(c); }
  let islandSeed = stageSeed ^ STAGE_SALT.islands;
  for (const letter of terrain.preset) islandSeed = Math.imul(islandSeed ^ letter.charCodeAt(0), FNV_PRIME);
  rng = new Rng(islandSeed);
  const islands: IslandOrbit[] = [];
  // One orbit of `sides` islands per ring (evenly spaced, same speed: they never meet); larger maps get more rings,
  // never more islands on a ring. Rings follow the preset's S48 layout (map.islandRingLayout, or the route template's
  // own radii), continued outward at the layout's last spacing and stretched with the map; every ring is then pushed
  // out to at least islandClearance beyond the previous one (and the innermost ring's neighbouring islands that far
  // apart along their chord), so islands on different rings can never touch whatever their phases. Rings that would
  // leave the map are dropped.
  const rings = map.islandRingLayout;
  const last = rings.length - 1;
  const spacing = last > 0 ? rings[last]!.radius - rings[last - 1]!.radius : rings[0]!.radius;
  const presetRadius = (k: number): number => {
    if (k > last) return presetRadius(last) + (k - last) * spacing;
    return terrain.preset === 'chokepoint' ? map.template.plateauRadius + k * map.template.flankWidth :
      terrain.preset === 'archipelago' ? map.template.lakeSpacing / 2 + k * map.template.lakeRadius :
      terrain.preset === 'fortress' && k === 0 ? map.template.plateauRadius :
      terrain.preset === 'rivers' ? map.template.passWidth + (k + 1) * map.template.fordSpacing / 2 : rings[k]!.radius;
  };
  const clearance = map.islandClearance;
  // An island's centre stays half a clearance inside the map edge.
  const outer = MAP / 2 - clearance / 2;
  const ringCount = Math.min(map.islandMaxRings, Math.round(map.islandRings * scale));
  // Stretch the ring layout with the map, but never so far that the outermost ring leaves it.
  const stretch = ringCount ? Math.min(scale, outer / presetRadius(ringCount - 1)) : scale;
  // The innermost ring's neighbouring islands stand 2r·sin(π/sides) apart (two slots: 2r).
  let previous = clearance / (2 * dmath.sin(Math.PI / sides)) - clearance;
  for (let k = 0; k < ringCount; k++) {
    const r = Math.max(presetRadius(k) * stretch, previous + clearance);
    // (outer itself is reachable: `stretch` may place the last ring exactly on it, up to rounding)
    if (r > outer + GEOM_EPS) break;
    previous = r;
    // Linear speed of the S48 ring of this index; outer rings keep the outermost ring's linear speed.
    const base = rings[Math.min(k, last)]!;
    const period = toTicks(base.period) * Math.max(1, r / (base.radius * stretch));
    const dir = k % 2 === 0 ? 1 : -1;
    // Template islands start on the diagonals: chokepoint over the base lanes, rivers over the river on two slots (on
    // four slots its rivers lie on the axes, the sector seams, where a canonical island cannot stand).
    const a0 = template && terrain.preset === 'chokepoint' ? Math.PI / 4 : template && terrain.preset === 'rivers' ? -Math.PI / 4 : rng.next() * Math.PI * 2;
    const w = (dir * Math.PI * 2) / period;
    for (let i = 0; i < sides; i++) islands.push({ r, a0: a0 + (i * Math.PI * 2) / sides, w, oreCapacity: 0 });
  }
  // Mark only complete rings that actually fit, outermost first, without changing geometry or drawing random values.
  const oreStart = Math.max(0, islands.length - map.islandOreRings * sides);
  for (let i = oreStart; i < islands.length; i++) islands[i]!.oreCapacity = map.islandOreAmount;
  // Slot 0's caverns: cells nearer its Spire than any other's, give or take sharedSkew (the centre chamber is shared
  // knowledge). Every other slot knows the rotation (documentFromWorld).
  const known = [...cavern].filter((c) => {
    const x = (c % MAP) + 0.5;
    const y = Math.floor(c / MAP) + 0.5;
    let other = Infinity;
    for (let s = 1; s < sides; s++) other = Math.min(other, norm(x - spires[s]!.x, y - spires[s]!.y));
    return norm(x - home.x, y - home.y) <= other + map.cavern.sharedSkew;
  });
  return { size: MAP, preset: terrain.preset, cells, ore, owner, magma, cavern: known, islands, orbitRegions: generateOrbitRegions(terrain.preset, map, sides), lodes: placement.lodes, posts, generation: { lodes: placement.summary, terrainEdits: sites.terrainEdits, stages: [
    { name: 'depths', seed: (hiddenSeed ^ STAGE_SALT.depths) >>> 0 },
    { name: 'magma', seed: (hiddenSeed ^ STAGE_SALT.magma) >>> 0 },
    { name: 'ore', seed: (hiddenSeed ^ STAGE_SALT.ore) >>> 0 },
    { name: 'faults', seed: (stageSeed ^ STAGE_SALT.faults) >>> 0 },
    { name: 'features', seed: (hiddenSeed ^ STAGE_SALT.features) >>> 0 },
    { name: 'islands-orbit', seed: islandSeed >>> 0 },
    ...(map.lavaLakes.enabled ? [{ name: 'lava', seed: (hiddenSeed ^ STAGE_SALT.lava) >>> 0 }] : []),
  ] }, terrain: terrain.terrain, faults };
}

/** A recipe lode zone in slot 0's canonical sector; sites chosen there are written with all their rotations. */
interface LodeZone {
  kind: LodeZoneSummary['zone'];
  /** Requested orbits. */
  count: number;
  loads: number;
  minRadius: number;
  /** Outer bound of the preferred band. */
  maxRadius: number;
  /** Last-resort outer bound: home sites widen to homeLodeFallbackRadius; contested bounds never expand. */
  limit: number;
  maxSkew: number;
  /**
   * The zone anchors bordering the canonical sector: slot 0's Spire, its flank anchors (four slots: the top flank and
   * its rotation onto the left edge, each half inside the quadrant) or the centre.
   */
  anchors: readonly Point[];
}

/**
 * Lode site geometry from the rules and slot count alone, shared by public site preparation and secret placement.
 * Sites are canonical cells (y < MAP / 2, x < width): the top half on two slots, the top-left quadrant on four.
 */
function lodeSiteGeometry(map: MapRules, sides: 2 | 4) {
  const MAP = map.size;
  const scale = MAP / REFERENCE_MAP_SIZE;
  const turn = 4 / sides;
  const spires = slotSpires(map, sides);
  const flank = flankAnchor(MAP, sides);
  const zones: LodeZone[] = [
    { kind: 'home', count: map.homeLodes, loads: map.homeLodeLoads, minRadius: map.homeLodeMinRadius, maxRadius: map.homeLodeMaxRadius, limit: Math.max(map.homeLodeMaxRadius, map.homeLodeFallbackRadius), maxSkew: Infinity, anchors: [spires[0]!] },
    ...map.contestedZones.map((zone): LodeZone => ({
      kind: zone.kind, count: Math.round(zone.sets * scale * scale), loads: zone.loads, minRadius: zone.minRadius * scale, maxRadius: zone.maxRadius * scale, limit: zone.maxRadius * scale, maxSkew: zone.maxSkew * scale,
      anchors: zone.kind === 'centre' ? [{ x: MAP / 2, y: MAP / 2 }] : sides === 2 ? [flank] : [flank, { x: rotX(3, flank.x, flank.y, MAP), y: rotY(3, flank.x, flank.y, MAP) }],
    })),
  ];
  /** |d1 − d2| for the distances d1 ≤ d2 from point (px, py) to its two nearest Spires. */
  const skew = (px: number, py: number): number => {
    let d1 = Infinity, d2 = Infinity;
    for (const s of spires) {
      const d = norm(px - s.x, py - s.y);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    return d2 - d1;
  };
  /** Distance from point (px, py) to the nearest anchor of `zone`. */
  const anchorDist = (zone: LodeZone, px: number, py: number): number => {
    let d = Infinity;
    for (const a of zone.anchors) d = Math.min(d, norm(px - a.x, py - a.y));
    return d;
  };
  return {
    zones,
    /** Width of the canonical sector searched for sites (its height is MAP / 2). */
    width: sides === 2 ? MAP : MAP / 2,
    anchorDist,
    /** Is cell (x, y)'s centre in `zone`'s band out to `radius`, inside its skew bound? */
    inZone: (zone: LodeZone, x: number, y: number, radius: number): boolean => {
      const r = anchorDist(zone, x + 0.5, y + 0.5);
      return r >= zone.minRadius && r <= radius && (zone.kind === 'home' || skew(x + 0.5, y + 0.5) <= zone.maxSkew);
    },
    /**
     * Does a site at (x, y) keep its seal inside the border, off its own rotations (lodes near the centre) and at
     * least lodeSpacing from each of them?
     */
    ownOrbitClear: (x: number, y: number): boolean => {
      if (x - LODE_SEAL < 1 || y - LODE_SEAL < 1 || x + LODE_SEAL > MAP - 2 || y + LODE_SEAL > MAP - 2) return false;
      for (let r = 1; r < sides; r++) {
        const t = rotCell(r * turn, y * MAP + x, MAP);
        const dx = x - (t % MAP), dy = y - Math.floor(t / MAP);
        if (Math.abs(dx) <= 2 * LODE_SEAL && Math.abs(dy) <= 2 * LODE_SEAL) return false;
        if (norm(dx, dy) < map.lodeSpacing) return false;
      }
      return true;
    },
    /** Is cell `c` closer than lodeSpacing to site `p` or one of its rotations? */
    crowds: (p: number, c: number): boolean => {
      for (let r = 0; r < sides; r++) {
        const t = rotCell(r * turn, p, MAP);
        if (norm(t % MAP - c % MAP, Math.floor(t / MAP) - Math.floor(c / MAP)) < map.lodeSpacing) return true;
      }
      return false;
    },
  };
}

/**
 * prepareLodeSites' result: the public Surface edits (rotations included), the site orbits each zone got levelled and
 * the public sites kept for the zones (canonical cells, every zone's count plus spares at most).
 */
export interface LodeSites { terrainEdits: LodeTerrainEdit[]; zones: { prepared: number; cliffPrepared: number }[]; sites: number[] }

/**
 * Public lode site preparation from the Surface, the rules and `dug` (cells the public map already implies are tunnels
 * below: Spire pockets and known cavern stretches) alone, so the public map never depends on the secret seed that
 * places the lodes (placeLodes only chooses among sites that already fit). Per zone, in recipe order, it keeps a set
 * of sites whose seals miss `dug`, each at least lodeSpacing from the others, their rotations and earlier zones' sets:
 * first the sites that fit as generated, in canonical order. While the set holds fewer than the zone's count plus
 * map.lodeSpares inside the preferred band, the least-changed site clear of the set (ties by canonical cell) is
 * levelled with its rotations: raised onto a plateau it touches (ground/forest/ford → high), otherwise levelled to
 * ground (forest/ford → ground). Home sites may also level cliffs; a contested zone levels cliffs only as a last
 * resort, when its band holds fewer sites than its count without (then again up to count plus spares). Never water,
 * faults or holes, never a plateau carved down, nothing inside a Spire clearing; a site whose levelling cuts off
 * walkable Surface is skipped. A home band that cannot hold the zone's count widens by LODE_WIDEN_STEP toward
 * homeLodeFallbackRadius (without spares); contested bounds never expand. The secret placement then takes some or
 * none of the levelled sites.
 */
export function prepareLodeSites(map: MapRules, terrain: Uint8Array, dug: Uint8Array, sides: 2 | 4): LodeSites {
  const MAP = map.size;
  const turn = 4 / sides;
  const geometry = lodeSiteGeometry(map, sides);
  const { width, inZone, ownOrbitClear, crowds } = geometry;
  const spires = slotSpires(map, sides);
  const reach = LODE_POCKET + LODE_APRON;
  const terrainEdits: LodeTerrainEdit[] = [];
  const zones = geometry.zones.map(() => ({ prepared: 0, cliffPrepared: 0 }));
  /** Every zone's site set so far (canonical cells); a new site keeps lodeSpacing from each and its rotations. */
  const sites: number[] = [];
  /** The level a site is prepared to: the plateau when any footprint/apron cell is high ground, plain ground otherwise. */
  const prepLevel = (x: number, y: number): number => {
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) if (isSurfaceHigh(terrain[(y + dy) * MAP + x + dx]!)) return SURFACE.high;
    return SURFACE.ground;
  };
  /**
   * Cells preparing site (x, y) converts (0: it fits as generated, the Headframe rule), or -1 if it may not be
   * prepared or its seal would cover a known tunnel.
   */
  const cost = (x: number, y: number, allowCliffs: boolean): number => {
    if (!ownOrbitClear(x, y)) return -1;
    for (let dy = -LODE_SEAL; dy <= LODE_SEAL; dy++) for (let dx = -LODE_SEAL; dx <= LODE_SEAL; dx++) if (dug[(y + dy) * MAP + x + dx]) return -1;
    const level = prepLevel(x, y);
    let changed = 0;
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const value = terrain[(y + dy) * MAP + x + dx]!;
      if (value === level) continue;
      if (value !== SURFACE.ground && surfaceFeature(value) !== SURFACE.forest && surfaceFeature(value) !== SURFACE.ford && !(allowCliffs && value === SURFACE.cliff)) return -1;
      if (spireDist(spires, x + dx, y + dy) <= map.spireClearing) return -1;
      changed++;
    }
    return changed;
  };
  /** Level `site` and its rotations for zone `z`, unless that cuts off walkable Surface. */
  const level = (z: number, site: number): boolean => {
    const to = prepLevel(site % MAP, Math.floor(site / MAP));
    const changed: LodeTerrainEdit[] = [];
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      for (let r = 0; r < sides; r++) {
        const n = rotCell(r * turn, site + dy * MAP + dx, MAP);
        if (terrain[n] === to) continue;
        changed.push({ c: n, before: terrain[n]!, after: to });
        terrain[n] = to;
      }
    }
    if (!changed.length) return true;
    const reachable = surfaceReachable(terrain, spires[0]!);
    if (terrain.some((value, c) => value !== SURFACE.cliff && surfaceFeature(value) !== SURFACE.water && !reachable[c])) {
      for (const edit of changed) terrain[edit.c] = edit.before;
      return false;
    }
    terrainEdits.push(...changed);
    zones[z]!.prepared++;
    if (changed.some((edit) => edit.before === SURFACE.cliff)) zones[z]!.cliffPrepared++;
    return true;
  };
  /**
   * Can `remaining` more sites of `pool` (from index `start` on) join `chosen`, every site clear of the others and their
   * rotations? On success `chosen` holds them.
   */
  const extend = (pool: readonly number[], chosen: number[], remaining: number, start = 0): boolean => {
    if (remaining === 0) return true;
    for (let i = start; i <= pool.length - remaining; i++) {
      const c = pool[i]!;
      if (chosen.some((p) => crowds(p, c))) continue;
      chosen.push(c);
      if (extend(pool, chosen, remaining - 1, i + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  geometry.zones.forEach((zone, z) => {
    if (zone.count === 0) return;
    const home = zone.kind === 'home';
    const spare = zone.count + map.lodeSpares;
    /**
     * The zone's sites out to `radius`, clear of the kept ones, that fit as generated (`fit`) or may be prepared
     * (levelling cliffs too if `allowCliffs`).
     */
    const pool = (radius: number, fit: boolean, allowCliffs: boolean): { c: number; score: number }[] => {
      const out: { c: number; score: number }[] = [];
      for (let y = 0; y < MAP / 2; y++) for (let x = 0; x < width; x++) {
        if (!inZone(zone, x, y, radius) || sites.some((p) => crowds(p, y * MAP + x))) continue;
        const score = cost(x, y, allowCliffs);
        if (fit ? score === 0 : score >= 0) out.push({ c: y * MAP + x, score });
      }
      return out;
    };
    // The most band sites that fit as generated, up to the zone's count plus spares (the first such set in canonical order).
    const natural = pool(zone.maxRadius, true, home).map((site) => site.c);
    let own = 0;
    for (let size = spare; size > 0 && !own; size--) {
      const chosen: number[] = [];
      if (extend(natural, chosen, size)) { sites.push(...chosen); own = size; }
    }
    /** Prepare sites until the zone holds `inBand` in its band (only its count beyond it). */
    const prepare = (allowCliffs: boolean, inBand: number): void => {
      for (let radius = zone.maxRadius; ; radius = Math.min(zone.limit, radius + LODE_WIDEN_STEP)) {
        const wanted = radius === zone.maxRadius ? inBand : zone.count;
        while (own < wanted) {
          // Least changed first (sites that fit as generated beyond the band, score 0, lead), ties by canonical cell;
          // first a site that leaves room to reach `wanted`, else the zone's count, else any. A failed connectivity
          // check tries the next.
          const candidates = pool(radius, false, allowCliffs).sort((a, b) => a.score - b.score || a.c - b.c).map((site) => site.c);
          const failed = new Set<number>();
          let site = -1;
          for (const need of [wanted - own - 1, zone.count - own - 1, 0]) {
            if (need < 0) continue;
            for (const c of candidates) {
              if (failed.has(c) || !extend(candidates, [c], need)) continue;
              if (level(z, c)) { site = c; break; }
              failed.add(c);
            }
            if (site >= 0) break;
          }
          if (site < 0) break;
          sites.push(site);
          own++;
        }
        if (own >= zone.count || radius === zone.limit) break;
      }
    };
    prepare(home, spare);
    // Home sites may always level cliffs. A contested band does only as a last resort, when fault lines and cliffs leave
    // it fewer sites than its count otherwise (a canyon flank crossed by faults); it then keeps spares like any band.
    if (!home && own < zone.count) prepare(true, spare);
  });
  return { terrainEdits, zones, sites };
}

/** placeLodes' result: every lode (orbits in rotation order) and per-zone accounting. */
export interface LodePlacement { lodes: Lode[]; summary: LodeZoneSummary[] }

/**
 * Secret lode placement in orbits of the slots' rotation group: each zone site is drawn from the layer's random stream
 * in slot 0's canonical sector and carved with all its rotations. Only sites that fit the public Surface as it stands
 * (the Headframe rule; prepareLodeSites levelled any extra sites beforehand) over sealable rock qualify, so placement
 * never edits the Surface. Zone counts are counts of these orbits. Placement reserves room for the whole zone, starts
 * at its inner radius + LODE_WIDEN_STEP and widens by that step to its band's edge, then (home) to the fallback
 * radius; a zone without room reports missing orbits. `sites` is the public preparation's accounting. Each pick
 * prefers map.postClearance from every public post; outcrop/apron overlap is always forbidden, even when widening
 * to a zone's fallback radius. Post positions depend only on public prepared sites, never the secret lodes.
 */
export function placeLodes(map: MapRules, rng: Rng, ground: Pick<World, 'cells' | 'ore' | 'magma' | 'terrain'>, sides: 2 | 4, sites: LodeSites, posts: readonly MapPost[]): LodePlacement {
  const MAP = map.size;
  const turn = 4 / sides;
  const geometry = lodeSiteGeometry(map, sides);
  const { width, inZone, ownOrbitClear, crowds, anchorDist } = geometry;
  const { cells, ore, magma, terrain } = ground;
  const lodes: Lode[] = [];
  const summary: LodeZoneSummary[] = [];
  /**
   * Does a lode fit at (x, y) now: clear of its own orbit and every placed lode, its outcrop and apron on one level
   * (ground or a plateau top) and its seal footprint plain rock or ore without magma, rotations included?
   */
  const fits = (x: number, y: number): boolean => {
    if (!ownOrbitClear(x, y) || crowdsPost(y * MAP + x, LODE_POCKET + LODE_APRON, posts, MAP, 0)) return false;
    for (const l of lodes) if (norm((l.c % MAP) - x, Math.floor(l.c / MAP) - y) < map.lodeSpacing) return false;
    if (surfaceSiteLevel(terrain, MAP, x - LODE_POCKET, y - LODE_POCKET, 2 * LODE_POCKET + 1, 2 * LODE_POCKET + 1) < 0) return false;
    for (let dy = -LODE_SEAL; dy <= LODE_SEAL; dy++) {
      for (let dx = -LODE_SEAL; dx <= LODE_SEAL; dx++) {
        const c = (y + dy) * MAP + x + dx;
        if ((cells[c] !== CELL.rock && cells[c] !== CELL.ore) || magma[c]) return false;
        for (let r = 1; r < sides; r++) if (magma[rotCell(r * turn, c, MAP)]) return false;
      }
    }
    return true;
  };
  const carve = (x: number, y: number, rich: boolean, loads: number): void => {
    const c = y * MAP + x;
    for (let r = 0; r < sides; r++) lodes.push({ c: rotCell(r * turn, c, MAP), rich, loads });
    let k = 0;
    for (let dy = -LODE_SEAL; dy <= LODE_SEAL; dy++) {
      for (let dx = -LODE_SEAL; dx <= LODE_SEAL; dx++) {
        const n = (y + dy) * MAP + x + dx;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        // The pocket cells share the loads (the first `loads % LODE_POCKET_CELLS` hold one more), the same in rotated order.
        const v = ring === LODE_SEAL ? CELL.bedrock : ring === 0 ? CELL.rock : CELL.ore;
        const load = v === CELL.ore ? Math.floor(loads / LODE_POCKET_CELLS) + (k++ < loads % LODE_POCKET_CELLS ? 1 : 0) : 0;
        for (let r = 0; r < sides; r++) {
          const m = rotCell(r * turn, n, MAP);
          cells[m] = v;
          ore[m] = load;
        }
      }
    }
  };
  geometry.zones.forEach((zone, z) => {
    const report: LodeZoneSummary = { zone: zone.kind, requested: zone.count, placed: 0, widened: 0, prepared: sites.zones[z]!.prepared, cliffPrepared: sites.zones[z]!.cliffPrepared, fallback: 0, missing: 0 };
    summary.push(report);
    const firstRadius = Math.min(zone.maxRadius, zone.minRadius + LODE_WIDEN_STEP);
    // Reserve room for the whole zone before committing a greedy first site (especially the two home orbits): in its
    // band, or out to its last-resort bound when the band cannot hold it.
    const possible: number[] = [];
    const reserve = (radius: number): void => {
      possible.length = 0;
      for (let y = 0; y < MAP / 2; y++) for (let x = 0; x < width; x++) if (inZone(zone, x, y, radius) && fits(x, y)) possible.push(y * MAP + x);
    };
    reserve(zone.maxRadius);
    const canComplete = (chosen: number[], remaining: number, start = 0): boolean => {
      if (remaining === 0) return true;
      for (let i = start; i <= possible.length - remaining; i++) {
        const c = possible[i]!;
        if (!fits(c % MAP, Math.floor(c / MAP)) || chosen.some((p) => crowds(p, c))) continue;
        chosen.push(c);
        const complete = canComplete(chosen, remaining - 1, i + 1);
        chosen.pop();
        if (complete) return true;
      }
      return false;
    };
    let requireComplete = canComplete([], zone.count);
    if (!requireComplete && zone.limit > zone.maxRadius) {
      reserve(zone.limit);
      requireComplete = canComplete([], zone.count);
    }
    /** Is site `c`'s outcrop or apron within `clearance` tiles of a forward post (0: covering one)? */
    const nearPost = (c: number, clearance: number): boolean => crowdsPost(c, LODE_POCKET + LODE_APRON, posts, MAP, clearance);
    // Prefer clearance inside the band, then non-overlap; the final tier also searches the fallback radius.
    // fits() never permits a post inside the footprint/apron.
    const tiers = posts.length ? [map.postClearance, 0, -1] : [-1];
    for (let pair = 0; pair < zone.count; pair++) {
      let at = -1;
      let radius = firstRadius;
      for (const clearance of tiers) {
        radius = firstRadius;
        const bound = clearance >= 0 ? zone.maxRadius : zone.limit;
        for (;;) {
          const candidates: number[] = [];
          for (let y = 0; y < MAP / 2; y++) {
            for (let x = 0; x < width; x++) {
              if (inZone(zone, x, y, radius) && fits(x, y) && !(clearance >= 0 && nearPost(y * MAP + x, clearance)) && (!requireComplete || canComplete([y * MAP + x], zone.count - pair - 1))) candidates.push(y * MAP + x);
            }
          }
          if (candidates.length) {
            at = candidates[rng.int(candidates.length)]!;
            break;
          }
          if (radius >= bound) break;
          radius = Math.min(radius < zone.maxRadius ? zone.maxRadius : zone.limit, radius + LODE_WIDEN_STEP);
        }
        if (at >= 0) break;
      }
      if (at < 0) {
        report.missing++;
      } else {
        carve(at % MAP, Math.floor(at / MAP), zone.kind !== 'home', zone.loads);
        report.placed++;
        if (radius > firstRadius) report.widened++;
        if (anchorDist(zone, at % MAP + 0.5, Math.floor(at / MAP) + 0.5) > zone.maxRadius) report.fallback++;
      }
    }
  });
  return { lodes, summary };
}
