/**
 * The Depths as a cut-away section (docs/art/DIRECTIONS.md §6 phase 3): one smoothed heightfield of the team's
 * knowledge grid, its rock top drawn like the cut face of an engineering section (flat fill + diagonal section lines),
 * carved tunnels as negative space — strata walls, packed-earth floors with worn highway lanes — ore as teal veins and
 * ink-outlined crystals, green rich ore as emerald crystal clusters, the Mother Lode as a tall pulsing cluster of
 * rich-lode crystals, rails on sleepers, live lava (crust plates on a molten sea with glowing seams, heaving and
 * bubbling, its glow on the walls and a heat haze over it) that rises into a flooding cell and crusts over before it
 * cools, permanent lava lakes drawn as the same lava that never cools, lava bridges as timber decks spanning the lake
 * (the lava still burns below), located pockets as a sealed ring of hot cracks in the cut, and cream daylight shafts
 * under every surface hole.
 *
 * Heights (local): tunnel/rail floor 0, rock/ore/fortified/unknown 1.25 (unknown: a blank card with sparse section
 * lines), bedrock 1.45, flooded magma, lakes and the lava under a bridge −0.2. No sun bake underground (sun = 1, AO
 * only), so a dig, a scan or a flood rebuilds just a window of the field (`FieldBuilder`); everything else is instanced.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import {
  abs,
  attribute,
  color,
  dot,
  float,
  fract,
  instancedDynamicBufferAttribute,
  max,
  min,
  mix,
  mx_noise_float,
  mx_worley_noise_float,
  mx_worley_noise_vec2,
  normalView,
  normalWorld,
  normalize,
  positionLocal,
  positionView,
  positionWorld,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CELL, LODE_PRESSURE_MAX, MOTHER_LODE_MAX_CELLS, PLANE_Y, isLava, isOpenCell, type Rules, type View } from '@agent-command/game/contract';
import { FADE } from './fade.ts';
import { DEPTHS_ROCK_HEIGHT, hash2, spanYaw, wx, wz } from './common.ts';
import { HeightField, type FieldSpec } from './field.ts';
import { FieldBuilder } from './fieldjobs.ts';
import { cel, clock, edgeSection, finish, inkMaterial, lines, mapEdge, overlay, planeLines, seen, type F1, type V3 } from './materials.ts';
import { LODE_PAINT, RICH_ORE_PAINT, SHADOW } from './palette.ts';
import type { FogField } from './fog.ts';

const tmp = new Object3D();
/** Seconds a flooding cell takes to fill. */
const FILL_S = 0.8;
/** Seconds before cooling when the crust starts to form. */
const CRUST_S = 20;
/** Seconds after a cell fills in which its crust plates close over the molten lava. */
const FRESH_S = 6;
const FAR = 1e7;
/**
 * The Mother Lode's vent: the ring floods outward from each lode cell, after the eruption's flash (VENT_LAG_S), at
 * VENT_RUSH_S per tile from the lode cell's centre, so the pressure telegraph visibly ends in lava.
 */
const VENT_LAG_S = 0.35;
const VENT_RUSH_S = 0.75;
/** Glowing wall faces beside live lava (four per cell at most), capped like every pool. */
const RIM_CAP = 4096;
/** Height (local) the lava's glow climbs the tunnel walls. */
const RIM_H = 1.1;
/** Ore crystals per ore cell, and their cap. */
const CRYSTALS = 3;
/** Crystals per green rich-ore cell: a denser, larger cluster than ore, so it reads richer at any zoom. */
const RICH_CRYSTALS = 4;
/**
 * Crystals per Mother Lode cell (one tall core, a ring of shards), and their cap: a map holds at most
 * MOTHER_LODE_MAX_CELLS of them.
 */
const LODE_CRYSTALS = 5;
const LODE_CAP = MOTHER_LODE_MAX_CELLS * LODE_CRYSTALS;
/** Ring cells that crack as the Mother Lode heats: the 8 neighbours of every lode cell at most. */
const LODE_RING_CAP = MOTHER_LODE_MAX_CELLS * 8;
/** Mother Lode colours: its cool rich-lode paint, orange-hot at lodeWarn, white-hot at lodeCritical. */
const LODE_HOT = '#ff7a1a';
const LODE_WHITE = '#fff4dc';

/** The Mother Lode's heat for the renderer (0..1 each), from its public pressure. */
export interface LodeHeat {
  /** cool → orange over 0…lodeWarn */
  hot: number;
  /** orange → white-hot over lodeWarn…lodeCritical */
  white: number;
  /** glowing cracks on the ring cells: from lodeWarn, full at the vent */
  cracks: number;
}

/** `out` = the heat of `lode` (none while it cools, or without pressure in the match). */
export function lodeHeat(lode: View['motherLode'], rules: Pick<Rules['depths'], 'lodeWarn' | 'lodeCritical'> | undefined, out: LodeHeat): LodeHeat {
  out.hot = out.white = out.cracks = 0;
  if (!lode || !rules || lode.state === 'cooling') return out;
  const p = lode.pressure;
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  out.hot = clamp(p / Math.max(1e-6, rules.lodeWarn));
  out.white = p < rules.lodeWarn ? 0 : clamp((p - rules.lodeWarn) / Math.max(1e-6, rules.lodeCritical - rules.lodeWarn));
  out.cracks = p < rules.lodeWarn ? 0 : 0.35 + 0.65 * clamp((p - rules.lodeWarn) / Math.max(1e-6, LODE_PRESSURE_MAX - rules.lodeWarn));
  return out;
}

/** What the Depths layer draws from a view: the knowledge grid and what decorates it. */
export type DepthsInput = Pick<View, 'depths'> & Partial<Pick<View, 'holes' | 'fx' | 'schedule' | 'pockets' | 'motherLode'>>;

/**
 * Live lava or a sealed pocket: a known magma cell is a dormant pocket exactly when the team located it as one
 * (`view.pockets`, the sim's knowledge: a scan, never a flood); every other known magma cell is live lava, however far
 * it lies from where its flood broke out. Writes 1 into `out` for each dormant cell (0 elsewhere) and returns it.
 */
export function dormantCells(cells: ArrayLike<number>, pockets: readonly { x: number; y: number }[], size: number, out: Uint8Array): Uint8Array {
  out.fill(0);
  for (const p of pockets) {
    const c = p.y * size + p.x;
    if (cells[c] === CELL.magma) out[c] = 1;
  }
  return out;
}

const LEVEL = { magma: -0.2, floor: 0, rock: DEPTHS_ROCK_HEIGHT, bedrock: 1.45 } as const;
/** Field class bits (masks `m` = ore, rock, open, bedrock; `m2` = unknown, fortified). Bit 1 roughens (ROCK_BIT). */
const ORE = 1;
const ROCK = 2;
const OPEN = 4;
const BEDROCK = 8;
const UNKNOWN = 16;
const FORTIFIED = 32;
/**
 * Beyond the baked masks (CLASS_BITS): no shading of its own, it only keeps a rich cell's input apart from plain rock,
 * so a cell turning rich (or rich turning to rock) still rebuilds its window and re-places the crystals.
 */
const RICH = 64;

/** A quarter tile of blur keeps one-cell side passages open; no swell, so floors stay flat for units and rails. */
const SPEC: Omit<FieldSpec, 'size'> = { res: 4, blur: 0.28, sharp: 0.2, rough: 0.06, swell: 0, levels: Object.values(LEVEL), sun: false };
/** Local y the diorama cuts the map edge down to. */
const SKIRT = -0.7;

/** Lava under a cell (a burning flood, a permanent lake, or the lake below a bridge deck); a located pocket is sealed rock. */
const lavaUnder = (code: number, dormant: boolean): boolean => code === CELL.lake || code === CELL.bridge || (code === CELL.magma && !dormant);

/**
 * Field inputs for one knowledge cell (`dormant`: a sealed magma pocket, drawn in the rock). A lava bridge keeps its
 * lake's pit (the deck spans it, the lava burns below); green rich ore is plain rock in the field, its emerald
 * crystals carry it (no teal veins, so it never reads as ordinary ore).
 */
function cellInput(code: number, dormant: boolean, level: Float32Array, cls: Uint8Array, i: number): void {
  let lv: number = LEVEL.rock;
  let c = ROCK;
  if (code === CELL.unknown) c = UNKNOWN;
  else if (code === CELL.bedrock) {
    lv = LEVEL.bedrock;
    c = BEDROCK | ROCK;
  } else if (code === CELL.ore || code === CELL.lode) c = ORE | ROCK;
  else if (code === CELL.rich) c = RICH | ROCK;
  else if (code === CELL.fortified) c = FORTIFIED;
  else if (lavaUnder(code, dormant)) {
    lv = LEVEL.magma;
    c = OPEN;
  } else if (isOpenCell(code)) {
    lv = LEVEL.floor;
    c = OPEN;
  }
  level[i] = lv;
  cls[i] = c;
}

/**
 * A lava bridge deck spanning one cell along +x: two iron stringers under transverse timber planks as wide as the
 * `lava_bridge` model's railings stand apart, its top a hair under the tunnel floor so the highway lane over it stays
 * clear of it.
 */
function deckGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const z of [-0.4, 0.4]) parts.push(new BoxGeometry(1, 0.07, 0.09).translate(0, -0.06, z));
  for (let k = 0; k < 5; k++) parts.push(new BoxGeometry(0.17, 0.04, 0.96).translate(-0.4 + k * 0.2, -0.02, 0));
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  if (!g) throw new Error('deck geometry');
  return g;
}

/** Two steel rails on sleepers, spanning half a cell from the centre toward +x. */
function railGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const z of [-0.17, 0.17]) parts.push(new BoxGeometry(0.52, 0.05, 0.045).translate(0.25, 0.1, z));
  for (const x of [0.06, 0.31]) parts.push(new BoxGeometry(0.09, 0.04, 0.5).translate(x, 0.05, 0));
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  if (!g) throw new Error('rail geometry');
  return g;
}

/** The section-cut terrain material (lookdev `ink.depthsTerrain`, plus unknown / bedrock / fortified cuts). */
function sectionMaterial(size: number, fogField?: FogField): MeshBasicNodeMaterial {
  const m = attribute<'vec4'>('m', 'vec4');
  const m2 = attribute<'vec2'>('m2', 'vec2');
  const ao = attribute<'float'>('ao', 'float');
  const p = positionLocal;
  const pw = positionWorld;
  const n2 = mx_noise_float(p.mul(1.7)).mul(0.5).add(0.5);
  const wall = smoothstep(0.32, 0.55, float(1).sub(normalWorld.y));
  const cut = smoothstep(1.0, 1.15, p.y).mul(float(1).sub(wall));
  const ore = smoothstep(0.3, 0.6, m.x);
  const bedrock = smoothstep(0.4, 0.7, m.w);
  const unknown = smoothstep(0.35, 0.65, m2.x);
  const fort = smoothstep(0.4, 0.6, m2.y);
  // cut face: section lines over a flat fill; bedrock cross-hatched; fortified rock as riveted steel plates; unknown
  // rock is a blank card with sparse lines (never surveyed)
  const section = lines(pw.x.add(pw.z).mul(2.2) as F1, 0.1);
  const cross = lines(pw.x.sub(pw.z).mul(2.2) as F1, 0.08).mul(bedrock);
  const plates = smoothstep(0.0, 0.06, min(fract(pw.x.mul(2)), fract(pw.z.mul(2))));
  let cutCol = mix(mix(color('#5a4a52'), color('#3a3036'), bedrock), color('#1c1416'), max(section, cross).mul(0.35)) as V3;
  cutCol = mix(cutCol, mix(color('#2c4058'), color('#6f90ae'), plates), fort) as V3;
  cutCol = cutCol.mul(mix(float(1), float(1.25), ore)) as V3;
  const blank = mix(color('#2a221e'), color('#171110'), lines(pw.x.add(pw.z).mul(0.9) as F1, 0.06).mul(0.6));
  cutCol = mix(cutCol, blank, unknown) as V3;
  // walls: strata (bedrock darker, fortified steel), floors: packed earth
  const strata = smoothstep(0.45, 0.55, p.y.mul(3.5).add(n2.mul(0.7)).fract());
  let wallCol = mix(mix(color('#9a7f68'), color('#7d6655'), strata), mix(color('#6a5a5e'), color('#57494c'), strata), bedrock) as V3;
  wallCol = mix(wallCol, mix(color('#3a5a7a'), color('#5a7a9a'), plates), fort) as V3;
  wallCol = mix(wallCol, color('#3a3036'), unknown) as V3;
  const floor = mix(color('#c7a77a'), color('#d8bb8c'), n2);
  const veins = smoothstep(0.82, 0.9, mx_worley_noise_float(p.mul(2.3)).oneMinus());
  let base = mix(floor, wallCol, wall) as V3;
  base = mix(base, color('#5fc9b8'), ore.mul(veins).mul(wall.add(cut).min(1))) as V3;
  const lit = cel(base, SHADOW.depths, 1, ao);
  const shaded = mix(lit, cutCol, cut) as V3;
  // embers on the walls of flooded pits, a faint teal shine in ore veins
  const glow = color('#ff7a2a')
    .mul(smoothstep(-0.02, -0.18, p.y).mul(0.9))
    .add(color('#5fc9b8').mul(ore.mul(veins).mul(0.3))) as V3;
  const mat = new MeshBasicNodeMaterial({ side: DoubleSide });
  mat.colorNode = mix(finish(shaded, 'depths', { glow, fogField, tone: mix(lit, color('#4a3e46'), cut) as V3 }), edgeSection('depths', SKIRT), mapEdge());
  mat.opacityNode = FADE.depths.alpha;
  mat.alphaHash = true;
  mat.mrtNode = planeLines('depths');
  return mat;
}

export class DepthsLayer {
  readonly size: number;
  private readonly count: number;
  private readonly crystalCap: number;
  readonly group = new Group();
  private readonly builder: FieldBuilder;
  private readonly strips: InstancedMesh;
  private readonly rails: InstancedMesh;
  private readonly sleepers: InstancedMesh;
  private readonly crystals: InstancedMesh;
  private readonly richCrystals: InstancedMesh;
  private readonly lodes: InstancedMesh;
  /** Timber decks on known lava-bridge cells (the `lava_bridge` model adds its owner's trim on top). */
  private readonly decks: InstancedMesh;
  /** Cracks glowing on the Mother Lode's ring cells as it heats. */
  private readonly lodeRing: InstancedMesh;
  /** The Mother Lode's heat (`lodeHeat`), set each update. */
  private readonly heat = { hot: uniform(0), white: uniform(0), cracks: uniform(0) };
  private readonly heatNow: LodeHeat = { hot: 0, white: 0, cracks: 0 };
  /**
   * Live lava: one subdivided sheet per cell (it heaves and bubbles), its haze above (sharing the sheet's matrices
   * and data), the glowing wall faces beside it, and the sealed discs of located pockets. Per instance data (lava and
   * walls): x = flood start, y = cooling time (client clock s), z = 1 for public lava (the Mother Lode's ring: painted
   * even where the team has no vision), w = a per-cell phase.
   */
  private readonly lava: InstancedMesh;
  private readonly lavaT: InstancedBufferAttribute;
  private readonly haze: InstancedMesh;
  private readonly rims: InstancedMesh;
  private readonly rimT: InstancedBufferAttribute;
  private readonly pocketDiscs: InstancedMesh;
  private readonly shafts: InstancedMesh;
  private readonly born: Float32Array;
  /** Knowledge grid of the last update, and whether one arrived yet (the first one is a full worker build). */
  private readonly cells: Uint8Array;
  private readonly dormant: Uint8Array;
  private readonly pocketsAt: Uint8Array;
  /**
   * Live lava cells in instance order (`lavaCount` of them) and whether each is public: embers rise from them
   * (Telegraphs), and nothing else reads them.
   */
  readonly lavaCells: Int32Array;
  readonly lavaPublic: Uint8Array;
  lavaCount = 0;
  /** The Mother Lode eruptions (`lode_vent` fx) of the view being read: x, y, tick per eruption. */
  private readonly vents = new Float64Array(MOTHER_LODE_MAX_CELLS * 3);
  private built = false;
  private extraKey = '';
  private lastFx = -1;

  ready(): Promise<void> { return this.builder.ready(); }

  constructor(size: number, fogField?: FogField) {
    this.size = size;
    this.count = size * size;
    this.crystalCap = Math.ceil(1536 * this.count / (48 * 48));
    this.born = new Float32Array(this.count).fill(-FAR);
    this.cells = new Uint8Array(this.count);
    this.dormant = new Uint8Array(this.count);
    this.pocketsAt = new Uint8Array(this.count);
    this.lavaCells = new Int32Array(this.count);
    this.lavaPublic = new Uint8Array(this.count);
    const y = PLANE_Y.depths;
    const field = new HeightField({ ...SPEC, size });
    this.builder = new FieldBuilder(field, SKIRT, () => this.placeCrystals());
    const terrain = new Mesh(this.builder.mesh.geometry, sectionMaterial(size, fogField));
    terrain.position.y = y;
    terrain.frustumCulled = false;
    this.group.add(terrain);
    const p = positionWorld;

    // Highways: every tunnel connection is a worn lane (units run ×1.5), with ink dashes running along it.
    const lane = overlay(new MeshBasicNodeMaterial());
    const across = abs(uv().y.sub(0.5)).mul(2);
    const dash = smoothstep(0.45, 0.55, fract(p.x.add(p.z).mul(0.5).sub(time.mul(0.7))));
    lane.colorNode = mix(color('#a8875e'), color('#6a4a2e'), dash);
    lane.opacityNode = float(1).sub(smoothstep(0.2, 1, across)).mul(0.55).mul(FADE.depths.alpha).mul(FADE.depths.focus).mul(seen('depths', fogField).mul(0.6).add(0.4));
    this.strips = this.instanced(new PlaneGeometry(1, 0.22).rotateX(-Math.PI / 2), lane, this.count * 2);

    // Rails: steel on timber sleepers.
    this.rails = this.instanced(railGeometry(), inkMaterial('depths', color('#b8c0c8') as unknown as V3, { fogField }), this.count * 4);
    this.sleepers = this.instanced(new BoxGeometry(0.62, 0.035, 0.12).translate(0, 0.03, 0), inkMaterial('depths', color('#5a3f2a') as unknown as V3, { fogField }), this.count);

    // Ore: tall teal crystals standing in the cut, ink-outlined.
    this.crystals = this.instanced(
      new OctahedronGeometry(0.22, 0).scale(0.6, 1.6, 0.6),
      inkMaterial('depths', color('#7fe8d6') as unknown as V3, { fogField, glow: color('#5fc9b8').mul(0.45) as unknown as V3 }),
      this.crystalCap,
    );
    this.crystals.name = 'ore-crystals';
    // Green rich ore: a denser cluster of larger emerald crystals with a stronger glow (richer loads), never teal.
    this.richCrystals = this.instanced(
      new OctahedronGeometry(0.24, 0).scale(0.62, 1.75, 0.62),
      inkMaterial('depths', color(RICH_ORE_PAINT.crystal) as unknown as V3, { fogField, glow: color(RICH_ORE_PAINT.glow).mul(0.7) as unknown as V3 }),
      this.crystalCap,
    );
    this.richCrystals.name = 'rich-ore-crystals';
    // Lava bridges: weathered timber over iron, so a crossing reads as walkable floor above the burning lake.
    this.decks = this.instanced(deckGeometry(), inkMaterial('depths', color('#7a5636') as unknown as V3, { fogField }), this.count);
    this.decks.name = 'lava-bridge-decks';

    // Mother Lode: a taller, larger cluster in the rich-lode paint with a slow glowing pulse, never mistaken for ore. As
    // pressure builds it heats: orange-hot by lodeWarn, white-hot by lodeCritical, its pulse deeper and brighter.
    const pulse = sin(time.mul(1.4)).mul(this.heat.hot.mul(0.2).add(0.25)).add(0.75);
    const lodeCol = mix(mix(color(LODE_PAINT.rich), color(LODE_HOT), this.heat.hot), color(LODE_WHITE), this.heat.white) as V3;
    this.lodes = this.instanced(
      new OctahedronGeometry(0.3, 0).scale(0.6, 1.9, 0.6),
      inkMaterial('depths', lodeCol, { fogField, glow: lodeCol.mul(pulse.mul(this.heat.hot.mul(1.2).add(this.heat.white.mul(0.8)).add(0.8))) as unknown as V3 }),
      LODE_CAP,
    );
    // Hairline cracks in the ring floor glow from lodeWarn and flicker brighter toward the vent.
    const ringMat = overlay(new MeshBasicNodeMaterial());
    ringMat.blending = AdditiveBlending;
    const crackLines = float(1).sub(smoothstep(0.0, 0.07, abs(mx_noise_float(p.mul(2.6)))));
    const flicker = sin(time.mul(7).add(p.x.mul(3)).add(p.z.mul(2))).mul(0.2).add(0.8);
    ringMat.colorNode = mix(color(LODE_HOT), color(LODE_WHITE), this.heat.white);
    ringMat.opacityNode = crackLines.mul(flicker).mul(this.heat.cracks).mul(FADE.depths.alpha);
    this.lodeRing = this.instanced(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), ringMat, LODE_RING_CAP);

    // Live lava (toon): dark basalt crust plates drifting slowly on a molten sea, cracks glowing along their seams with
    // white-hot cores, molten pools where the plates thin. The sheet rises into a flooding cell, heaves and bubbles
    // while hot, and crusts over (the seams close) before it cools back to open tunnel. Lava in the Mother Lode's ring
    // is public: painted even where the team has no vision (every army that knows the lode knows its vent and cooling).
    this.lavaT = new InstancedBufferAttribute(new Float32Array(this.count * 4), 4);
    this.lavaT.setUsage(DynamicDrawUsage);
    const lt = instancedDynamicBufferAttribute<'vec4'>(this.lavaT, 'vec4');
    const fill = smoothstep(lt.x, lt.x.add(FILL_S), clock);
    const hot = float(1).sub(smoothstep(lt.y.sub(CRUST_S), lt.y, clock));
    const swirl = mx_noise_float(vec3(p.x.mul(0.3), time.mul(0.06), p.z.mul(0.3))).mul(0.8);
    const plates = mx_worley_noise_vec2(vec2(p.x.mul(1.35).add(time.mul(0.05)).add(swirl), p.z.mul(1.35).sub(time.mul(0.035)).sub(swirl)));
    const seam = plates.y.sub(plates.x); // 0 along the seam between two plates
    // Fresh lava is molten all over; its crust plates close over it in the first FRESH_S seconds.
    const fresh = float(1).sub(smoothstep(lt.x.add(FILL_S), lt.x.add(FILL_S + FRESH_S), clock));
    const poolAt = mix(float(0.56), float(0.12), fresh);
    const pool = smoothstep(poolAt, poolAt.add(0.14), mx_noise_float(vec3(p.x.mul(0.55).sub(time.mul(0.09)), time.mul(0.04), p.z.mul(0.55))).mul(0.5).add(0.5)).mul(hot);
    // heat 0 (crust) … 1 (white-hot): the seams narrow and dim as the crust thickens toward cooling
    const heat = max(float(1).sub(smoothstep(0, mix(float(0.035), float(0.1), hot), seam)), pool.mul(0.85)).mul(hot.mul(0.85).add(0.15));
    const band = (lo: number): F1 => smoothstep(lo - 0.02, lo + 0.02, heat) as F1;
    const basalt = mix(color('#2c150e'), color('#170b07'), smoothstep(0.08, 0.3, seam)) as V3;
    const lavaCol = mix(mix(mix(basalt, color('#c8341a'), band(0.18)), color('#ff7a1e'), band(0.5)), color('#ffd98a'), band(0.82)) as V3;
    const front = smoothstep(0.0, 0.5, fill).mul(smoothstep(1, 0.5, fill));
    const lavaGlow = lavaCol.mul(heat.mul(heat).mul(0.75)).mul(fill).add(color('#fff0b0').mul(front)) as V3;
    const shade = cel(lavaCol, SHADOW.depths);
    const lavaMat = new MeshBasicNodeMaterial();
    lavaMat.colorNode = mix(finish(shade, 'depths', { glow: lavaGlow, fogField, tone: shade }), finish(shade, 'depths', { glow: lavaGlow, fog: false, tone: shade }), lt.z);
    lavaMat.opacityNode = FADE.depths.alpha;
    lavaMat.alphaHash = true;
    lavaMat.mrtNode = planeLines('depths');
    // The sheet rises from below the pit floor while it fills; while hot it swells and bubbles inside the cell (its
    // edges stay level, so neighbouring cells meet).
    const lp = positionLocal;
    const inner = float(1).sub(smoothstep(0.22, 0.5, max(abs(lp.x), abs(lp.z))));
    const swell = sin(time.mul(1.3).add(lt.w.mul(6.283))).mul(0.5).add(0.5).mul(0.03);
    const bubble = smoothstep(0.55, 0.95, mx_noise_float(vec3(lp.x.mul(3.2).add(lt.w.mul(17)), time.mul(0.7), lp.z.mul(3.2).sub(lt.w.mul(11))))).mul(0.07);
    lavaMat.positionNode = lp.add(vec3(0, swell.add(bubble).mul(inner).mul(hot).mul(fill).sub(float(1).sub(fill).mul(0.26)), 0));
    this.lava = this.instanced(new PlaneGeometry(1, 1, 6, 6).rotateX(-Math.PI / 2), lavaMat, this.count);
    // Visible only where the team sees now (the pencil drawing elsewhere), unless public.
    const shown = mix(seen('depths', fogField), float(1), lt.z);
    // Heat haze: a faint orange shimmer standing over hot lava (it shares the sheet's matrices and data).
    const hazeMat = overlay(new MeshBasicNodeMaterial());
    hazeMat.blending = AdditiveBlending;
    const shimmer = smoothstep(0.1, 0.9, mx_noise_float(vec3(p.x.mul(1.7), p.z.mul(1.7).sub(time.mul(0.9)), time.mul(0.5))).mul(0.5).add(0.5));
    hazeMat.colorNode = color('#ff9a4a');
    hazeMat.opacityNode = shimmer.mul(0.07).mul(inner.mul(0.6).add(0.4)).mul(hot).mul(fill).mul(shown).mul(FADE.depths.alpha);
    hazeMat.positionNode = lp.add(vec3(0, float(0.42).add(sin(time.mul(2.1).add(lt.w.mul(9))).mul(0.04)), 0));
    this.haze = this.instanced(new PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2), hazeMat, 1);
    this.haze.instanceMatrix = this.lava.instanceMatrix;
    // The lava's glow on the tunnel walls beside it: a hot band at the foot fading up the face, flickering.
    this.rimT = new InstancedBufferAttribute(new Float32Array(RIM_CAP * 4), 4);
    this.rimT.setUsage(DynamicDrawUsage);
    const rt = instancedDynamicBufferAttribute<'vec4'>(this.rimT, 'vec4');
    const rimFill = smoothstep(rt.x, rt.x.add(FILL_S), clock);
    const rimHot = float(1).sub(smoothstep(rt.y.sub(CRUST_S), rt.y, clock).mul(0.85));
    const up = uv().y; // 0 at the lava, 1 at the top
    const lick = mx_noise_float(vec3(p.x.add(p.z).mul(2.4), up.mul(2).sub(time.mul(1.1)), rt.w.mul(5))).mul(0.5).add(0.5);
    const rimMat = overlay(new MeshBasicNodeMaterial());
    rimMat.blending = AdditiveBlending;
    rimMat.side = DoubleSide;
    rimMat.colorNode = mix(color('#e8461a'), color('#ffa040'), float(1).sub(up).pow(3));
    rimMat.opacityNode = float(1).sub(smoothstep(0, mix(float(0.5), float(0.95), lick), up)).mul(0.38).mul(rimFill).mul(rimHot).mul(mix(seen('depths', fogField), float(1), rt.z)).mul(FADE.depths.alpha);
    this.rims = this.instanced(new PlaneGeometry(1, RIM_H).translate(0, RIM_H / 2, 0), rimMat, RIM_CAP);
    // Located sealed pockets: a dark disc on the rock cut with a slow heartbeat of heat in a ring of hairline cracks.
    const r = uv().sub(0.5).length().mul(2); // 0 centre, 1 edge midpoints
    const beat = sin(time.mul(1.6)).mul(0.5).add(0.5).pow(2);
    const cracks = float(1).sub(smoothstep(0.0, 0.08, abs(mx_noise_float(p.mul(2.2)))));
    const sealed = color('#ff6a1a').mul(cracks.mul(smoothstep(0.45, 0.7, r)).mul(beat.mul(1.2).add(0.3)));
    const inkRing = float(1).sub(smoothstep(0.03, 0.07, abs(r.sub(0.8)))); // an ink circle round the pocket
    const disc = mix(mix(color('#2a1c18'), color('#3a3036'), smoothstep(0.5, 0.8, r)), color('#0c0806'), inkRing) as V3;
    this.pocketDiscs = this.instanced(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), inkMaterial('depths', disc, { fogField, glow: sealed as V3, alpha: float(1).sub(smoothstep(0.86, 0.94, r)) as F1 }), this.count);

    // Daylight shafts down every surface hole (sinkholes, craters, chasms, breaches: hazards, not portals): a faint
    // cream haze, not a solid beam. Still additive, so it reads as light, but low enough that the many shafts of a wide
    // crater stack gently. The rim feathers with the view angle (a column's edge is seen side-on), the foot eases in
    // from the floor and the upper half dissolves, so no hard silhouette or cut-off top shows at any zoom.
    const beam = overlay(new MeshBasicNodeMaterial());
    beam.blending = AdditiveBlending;
    const v = uv().y; // 0 bottom, 1 top
    const facing = abs(dot(normalView, normalize(positionView.negate())));
    const side = smoothstep(0.05, 0.8, facing);
    const along = smoothstep(0, 0.2, v).mul(float(1).sub(smoothstep(0.3, 1, v)));
    beam.colorNode = color('#f2e3c0');
    beam.opacityNode = along.mul(side).mul(0.11).mul(sin(time.mul(1.3).add(p.x)).mul(0.08).add(0.92)).mul(FADE.depths.alpha);
    this.shafts = this.instanced(new CylinderGeometry(0.42, 0.55, 1, 16, 1, true).translate(0, 0.5, 0), beam, this.count);
  }

  private instanced(geo: BufferGeometry, mat: Material, cap: number): InstancedMesh {
    const m = new InstancedMesh(geo, mat, cap);
    m.count = 0;
    m.frustumCulled = false;
    this.group.add(m);
    return m;
  }

  /**
   * One view of the team's Depths (`v`): the knowledge grid, holes, effects, schedule, located pockets and the Mother
   * Lode's public pressure. `at(tick)` maps a server tick to the client clock (seconds, `clock` uniform) so magma fills
   * when it floods (outward from each lode cell when the Mother Lode vents: its `lode_vent` effects) and crusts over
   * before its scheduled cooling; the match `rules` heat the lode and place its public ring.
   */
  update(v: DepthsInput, at?: (tick: number) => number, rules?: Rules): void {
    const { depths: cells, holes = [], fx = [], schedule = [], pockets = [], motherLode } = v;
    const heat = lodeHeat(motherLode, rules?.depths, this.heatNow);
    this.heat.hot.value = heat.hot;
    this.heat.white.value = heat.white;
    this.heat.cracks.value = heat.cracks;
    const ring = rules?.map.motherLode.ringWidth ?? 0;
    let vents = 0;
    for (const f of fx) {
      if (f.kind !== 'lode_vent' || f.tick <= this.lastFx || vents >= MOTHER_LODE_MAX_CELLS) continue;
      this.vents[vents * 3] = f.x;
      this.vents[vents * 3 + 1] = f.y;
      this.vents[vents * 3 + 2] = f.tick;
      vents++;
    }
    let floods = false;
    for (const f of fx) {
      if (f.kind !== 'magma' || f.tick <= this.lastFx || !at) continue;
      const x = Math.floor(f.x);
      const z = Math.floor(f.y);
      // A ring cell of an eruption on the same tick floods after the flash, outward from its nearest lode cell.
      let d = Infinity;
      for (let k = 0; k < vents; k++) {
        const vx = this.vents[k * 3]!;
        const vy = this.vents[k * 3 + 1]!;
        if (this.vents[k * 3 + 2] !== f.tick || Math.max(Math.abs(Math.floor(vx) - x), Math.abs(Math.floor(vy) - z)) > ring) continue;
        d = Math.min(d, Math.hypot(vx - (x + 0.5), vy - (z + 0.5)));
      }
      this.born[z * this.size + x] = at(f.tick) + (d < Infinity ? VENT_LAG_S + d * VENT_RUSH_S : 0);
      floods = true;
    }
    for (const f of fx) if (f.tick > this.lastFx) this.lastFx = f.tick;
    let cellsChanged = !this.built;
    for (let i = 0; i < this.count; i++) {
      const c = cells[i] ?? CELL.unknown;
      if (c === this.cells[i]) continue;
      this.cells[i] = c;
      cellsChanged = true;
    }
    let extra = '';
    for (const h of holes) extra += `${h.x},${h.y};`;
    for (const s of schedule) if (s.kind === 'magma_cools') extra += `m${s.tick},${s.x},${s.y};`;
    for (const p of pockets) extra += `p${p.x},${p.y};`;
    if (!cellsChanged && extra === this.extraKey && !floods) return;
    this.extraKey = extra;
    const y = PLANE_Y.depths;
    dormantCells(this.cells, pockets, this.size, this.pocketsAt);
    const dormantChanged = this.buildMagma(schedule, at, y, ring);
    if (cellsChanged || dormantChanged) {
      const b = this.builder;
      for (let i = 0; i < this.count; i++) cellInput(this.cells[i]!, this.dormant[i] === 1, b.level, b.cls, i);
      if (this.built) b.patch();
      else b.full();
      this.built = true;
      if (cellsChanged) {
        this.buildTracks(y);
        this.buildLodeRing(y);
      }
    }
    // light shafts
    let ns = 0;
    tmp.rotation.set(0, 0, 0);
    for (const h of holes) {
      tmp.position.set(wx(h.x + 0.5, this.size), y, wz(h.y + 0.5, this.size));
      tmp.scale.set(h.kind === 'chasm' ? 1.15 : 1, 9 + hash2(h.x, h.y) * 3, h.kind === 'chasm' ? 1.15 : 1);
      tmp.updateMatrix();
      this.shafts.setMatrixAt(ns++, tmp.matrix);
    }
    this.shafts.count = ns;
    this.shafts.instanceMatrix.needsUpdate = true;
  }

  /** Highway lanes between open cells, rail track with sleepers on rail cells, and timber decks on lava-bridge cells. */
  private buildTracks(y: number): void {
    const cells = this.cells;
    let nl = 0;
    let nr = 0;
    let nsl = 0;
    let nd = 0;
    tmp.scale.set(1, 1, 1);
    for (let i = 0; i < this.count; i++) {
      const c = cells[i]!;
      if (!isOpenCell(c)) continue;
      const x = i % this.size;
      const z = (i / this.size) | 0;
      const cx = wx(x + 0.5, this.size);
      const cz = wz(z + 0.5, this.size);
      tmp.rotation.set(0, 0, 0);
      // highway lanes to the +x / +y neighbours (rails draw their own track instead)
      const right = x + 1 < this.size ? cells[i + 1]! : CELL.unknown;
      const down = z + 1 < this.size ? cells[i + this.size]! : CELL.unknown;
      if (isOpenCell(right) && !(c === CELL.rail && right === CELL.rail)) {
        tmp.position.set(cx + 0.5, y + 0.02, cz);
        tmp.updateMatrix();
        this.strips.setMatrixAt(nl++, tmp.matrix);
      }
      if (isOpenCell(down) && !(c === CELL.rail && down === CELL.rail)) {
        tmp.position.set(cx, y + 0.02, cz + 0.5);
        tmp.rotation.set(0, Math.PI / 2, 0);
        tmp.updateMatrix();
        this.strips.setMatrixAt(nl++, tmp.matrix);
        tmp.rotation.set(0, 0, 0);
      }
      if (c === CELL.bridge) {
        // the entity renderer turns the model by −yaw too, so the planks sit square under its trim
        tmp.position.set(cx, y + LEVEL.floor, cz);
        tmp.rotation.set(0, -spanYaw(cells, x, z, this.size), 0);
        tmp.updateMatrix();
        this.decks.setMatrixAt(nd++, tmp.matrix);
        continue;
      }
      if (c !== CELL.rail) continue;
      // track: a half segment toward every railed neighbour; a lone rail cell gets a straight piece
      let links = 0;
      for (let d = 0; d < 4; d++) {
        const dx = d === 0 ? 1 : d === 1 ? -1 : 0;
        const dz = d === 2 ? 1 : d === 3 ? -1 : 0;
        const xx = x + dx;
        const zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= this.size || zz >= this.size || cells[zz * this.size + xx] !== CELL.rail) continue;
        tmp.position.set(cx, y, cz);
        tmp.rotation.set(0, d === 0 ? 0 : d === 1 ? Math.PI : d === 2 ? -Math.PI / 2 : Math.PI / 2, 0);
        tmp.updateMatrix();
        this.rails.setMatrixAt(nr++, tmp.matrix);
        links++;
      }
      if (!links)
        for (let k = 0; k < 2; k++) {
          tmp.position.set(cx, y, cz);
          tmp.rotation.set(0, k * Math.PI, 0);
          tmp.updateMatrix();
          this.rails.setMatrixAt(nr++, tmp.matrix);
        }
      tmp.position.set(cx, y, cz);
      tmp.rotation.set(0, hash2(x, z) < 0.5 ? 0 : Math.PI / 2, 0);
      tmp.updateMatrix();
      this.sleepers.setMatrixAt(nsl++, tmp.matrix);
    }
    this.strips.count = nl;
    this.rails.count = nr;
    this.sleepers.count = nsl;
    this.decks.count = nd;
    this.strips.instanceMatrix.needsUpdate = true;
    this.rails.instanceMatrix.needsUpdate = true;
    this.sleepers.instanceMatrix.needsUpdate = true;
    this.decks.instanceMatrix.needsUpdate = true;
  }

  /** Crack decals on the known open cells beside a known Mother Lode cell (its ring), just above the tunnel floor. */
  private buildLodeRing(y: number): void {
    let n = 0;
    tmp.rotation.set(0, 0, 0);
    tmp.scale.set(1, 1, 1);
    for (let i = 0; i < this.count && n < LODE_RING_CAP; i++) {
      if (!isOpenCell(this.cells[i]!)) continue;
      const x = i % this.size;
      const z = (i / this.size) | 0;
      let beside = false;
      for (let dz = -1; dz <= 1 && !beside; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx >= 0 && nz >= 0 && nx < this.size && nz < this.size && this.cells[nz * this.size + nx] === CELL.lode) beside = true;
      }
      if (!beside) continue;
      tmp.position.set(wx(x + 0.5, this.size), y + LEVEL.floor + 0.03, wz(z + 0.5, this.size));
      tmp.updateMatrix();
      this.lodeRing.setMatrixAt(n++, tmp.matrix);
    }
    this.lodeRing.count = n;
    this.lodeRing.instanceMatrix.needsUpdate = true;
  }

  /** Crystals on known ore, green rich-ore and Mother Lode cells, standing in the cut (after every field change: they follow its height). */
  private placeCrystals(): void {
    const f = this.builder.field;
    const y = PLANE_Y.depths;
    let n = 0;
    let nr = 0;
    let nl = 0;
    for (let i = 0; i < this.count; i++) {
      const code = this.cells[i];
      if (code !== CELL.ore && code !== CELL.rich && code !== CELL.lode) continue;
      const x = i % this.size;
      const z = (i / this.size) | 0;
      if (code === CELL.lode) {
        if (nl + LODE_CRYSTALS > LODE_CAP) continue;
        for (let k = 0; k < LODE_CRYSTALS; k++) {
          // k = 0: the upright core at the cell centre; the rest lean outward round it
          const a = (k / (LODE_CRYSTALS - 1) + hash2(x, z) * 0.25) * Math.PI * 2;
          const r = k ? 0.26 : 0;
          const tx = x + 0.5 + Math.cos(a) * r;
          const tz = z + 0.5 + Math.sin(a) * r;
          const s = k ? 0.75 + hash2(x + k, z) * 0.3 : 1.25;
          tmp.position.set(wx(tx, this.size), y + f.heightAt(tx, tz) + 0.05, wz(tz, this.size));
          tmp.rotation.set(Math.sin(a) * (k ? 0.45 : 0), hash2(z + k, x) * 6.28, -Math.cos(a) * (k ? 0.45 : 0));
          tmp.scale.set(s, s, s);
          tmp.updateMatrix();
          this.lodes.setMatrixAt(nl++, tmp.matrix);
        }
        continue;
      }
      const rich = code === CELL.rich;
      const per = rich ? RICH_CRYSTALS : CRYSTALS;
      if ((rich ? nr : n) + per > this.crystalCap) continue;
      // rich clusters spread wider and stand taller than ore, so the richer cell reads at a glance
      const spread = rich ? 0.68 : 0.6, grow = rich ? 1.2 : 1;
      for (let k = 0; k < per; k++) {
        const tx = x + 0.5 + (hash2(x * 3 + k, z) - 0.5) * spread;
        const tz = z + 0.5 + (hash2(x, z * 3 + k) - 0.5) * spread;
        const s = (0.8 + hash2(k, x + z) * 0.5) * grow;
        tmp.position.set(wx(tx, this.size), y + f.heightAt(tx, tz) + 0.05, wz(tz, this.size));
        tmp.rotation.set((hash2(z, k) - 0.5) * 0.5, hash2(x + k, z) * 6.28, (hash2(k, x) - 0.5) * 0.5);
        tmp.scale.set(s, s * (0.8 + hash2(z, x + k) * 0.5), s);
        tmp.updateMatrix();
        if (rich) this.richCrystals.setMatrixAt(nr++, tmp.matrix);
        else this.crystals.setMatrixAt(n++, tmp.matrix);
      }
    }
    this.crystals.count = n;
    this.crystals.instanceMatrix.needsUpdate = true;
    this.richCrystals.count = nr;
    this.richCrystals.instanceMatrix.needsUpdate = true;
    this.lodes.count = nl;
    this.lodes.instanceMatrix.needsUpdate = true;
  }

  /**
   * Magma, lake and bridge cells (after `dormantCells` filled `pocketsAt`): located pockets become sealed discs on the
   * rock cut; every other magma cell is live lava, its fill time from its `magma` fx, its cooling time from the nearest
   * `magma_cools` origin (crust timing only), public within `ring` cells of a known lode cell, with a glowing face on
   * each wall beside it. A lava lake (and the lake under a bridge deck) is the same lava that never cools; it refills
   * from its `magma` fx when a bridge falls. Returns whether any cell's dormancy changed (it moves the cell between the
   * rock cut and the flooded pit).
   */
  private buildMagma(schedule: View['schedule'], at: ((tick: number) => number) | undefined, y: number, ring: number): boolean {
    const size = this.size;
    const cells = this.cells;
    const lt = this.lavaT.array as Float32Array;
    const rt = this.rimT.array as Float32Array;
    let nl = 0;
    let nr = 0;
    let np = 0;
    let changed = false;
    tmp.scale.set(1, 1, 1);
    for (let i = 0; i < this.count; i++) {
      if (this.pocketsAt[i] !== this.dormant[i]) changed = true;
      this.dormant[i] = this.pocketsAt[i]!;
      const code = cells[i]!;
      if (code !== CELL.magma && code !== CELL.lake && code !== CELL.bridge) {
        this.born[i] = -FAR;
        continue;
      }
      const x = i % size;
      const z = (i / size) | 0;
      tmp.rotation.set(0, 0, 0);
      if (this.dormant[i]) {
        tmp.position.set(wx(x + 0.5, size), y + LEVEL.rock + 0.03, wz(z + 0.5, size));
        tmp.updateMatrix();
        this.pocketDiscs.setMatrixAt(np++, tmp.matrix);
        continue;
      }
      // a lake is permanent: no cooling to crust toward, and never part of the Mother Lode's public vent lava
      const flood = code === CELL.magma;
      let cool = FAR;
      let best = Infinity;
      if (flood) for (const s of schedule) {
        if (s.kind !== 'magma_cools' || s.x === undefined || s.y === undefined || !at) continue;
        const d = Math.hypot(s.x - (x + 0.5), s.y - (z + 0.5));
        if (d < best) {
          best = d;
          cool = at(s.tick);
        }
      }
      let pub = 0;
      if (flood) for (let dz = -ring; dz <= ring && !pub; dz++) for (let dx = -ring; dx <= ring; dx++) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx >= 0 && nz >= 0 && nx < size && nz < size && cells[nz * size + nx] === CELL.lode) pub = 1;
      }
      const seed = hash2(x, z);
      tmp.position.set(wx(x + 0.5, size), y - 0.04, wz(z + 0.5, size));
      tmp.updateMatrix();
      this.lava.setMatrixAt(nl, tmp.matrix);
      lt[nl * 4] = this.born[i]!;
      lt[nl * 4 + 1] = cool;
      lt[nl * 4 + 2] = pub;
      lt[nl * 4 + 3] = seed;
      this.lavaCells[nl] = i;
      this.lavaPublic[nl] = pub;
      nl++;
      // a glowing face on each wall beside it (+x, -x, +y, -y), standing a little inside the cell, clear of the
      // smoothed rock's slope
      for (let k = 0; k < 4 && nr < RIM_CAP; k++) {
        const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
        const dz = k === 2 ? 1 : k === 3 ? -1 : 0;
        const nx = x + dx;
        const nz = z + dz;
        const n = nx < 0 || nz < 0 || nx >= size || nz >= size ? CELL.bedrock : cells[nz * size + nx]!;
        if (isLava(n) || isOpenCell(n)) continue;
        tmp.position.set(wx(x + 0.5 + dx * 0.32, size), y + LEVEL.magma, wz(z + 0.5 + dz * 0.32, size));
        tmp.rotation.set(0, dx === 0 ? 0 : Math.PI / 2, 0);
        tmp.updateMatrix();
        this.rims.setMatrixAt(nr, tmp.matrix);
        rt[nr * 4] = this.born[i]!;
        rt[nr * 4 + 1] = cool;
        rt[nr * 4 + 2] = pub;
        rt[nr * 4 + 3] = hash2(nx * 3 + k, nz);
        nr++;
      }
    }
    this.lava.count = nl;
    this.haze.count = nl;
    this.lavaCount = nl;
    this.lava.instanceMatrix.needsUpdate = true;
    this.lavaT.needsUpdate = true;
    this.rims.count = nr;
    this.rims.instanceMatrix.needsUpdate = true;
    this.rimT.needsUpdate = true;
    this.pocketDiscs.count = np;
    this.pocketDiscs.instanceMatrix.needsUpdate = true;
    return changed;
  }

  /** Forget flood timings and the knowledge grid (new match / lobby). */
  reset(): void {
    this.born.fill(-FAR);
    this.dormant.fill(0);
    this.pocketsAt.fill(0);
    this.lavaCount = 0;
    this.lastFx = -1;
    this.extraKey = '';
    this.cells.fill(CELL.unknown);
    this.built = false;
  }
}
