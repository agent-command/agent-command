/**
 * Field Journal palette (docs/art/DIRECTIONS.md §1): every plane is a different paper with one shared ink language.
 * Team and threat colours are game constants (`common.ts`) and never pass through these.
 */
import { Color } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { PLANES, type Plane } from '@agent-command/game/contract';
import { clamp } from './common.ts';

/** Paper tone of each plane (the ground the page is drawn on). */
export const PAPER: Record<Plane, string> = { depths: '#2b241f', surface: '#efe6d0', sky: '#e4ecef', orbit: '#1e2245' };
/** Ink of solid shapes drawn on each plane (dark ink; the line pass uses `LINE`). */
export const INK: Record<Plane, string> = { depths: '#0c0806', surface: '#2b2019', sky: '#22304a', orbit: '#07081a' };
/** Line colour of the ink pass when the plane is viewed: sepia on light papers, chalk on dark ones. */
export const LINE: Record<Plane, string> = { depths: '#e9dcc4', surface: '#2b2019', sky: '#22304a', orbit: '#e9dcc4' };
/** Line strength when the plane is viewed (chalk on dark paper is drawn lighter). */
export const LINE_K: Record<Plane, number> = { depths: 0.55, surface: 0.88, sky: 0.85, orbit: 0.55 };
/** Hue-shifted shadow multiplier (never black). */
export const SHADOW: Record<Plane, string> = { depths: '#6a5a8a', surface: '#8a86b8', sky: '#9fb0d6', orbit: '#6a5c9e' };
/** Graphite of the unpainted (fogged) drawing. */
export const PENCIL: Record<Plane, string> = { depths: '#cbb9a3', surface: '#5a5048', sky: '#5d6878', orbit: '#b9bfe6' };
/** Construction pencil ghosted planes are sketched in, on the viewed plane's paper. */
export const GHOST_PENCIL: Record<Plane, string> = { depths: '#8a7a9a', surface: '#6f8fbf', sky: '#6f8fbf', orbit: '#7f8fd0' };
/** Dark papers draw graphite as chalk (light strokes on dark). */
export const DARK: Record<Plane, boolean> = { depths: true, surface: false, sky: false, orbit: true };
/** Background gradient (top, bottom) of the page per viewed plane. */
export const BG: Record<Plane, [string, string]> = {
  depths: ['#2f2722', '#1b1512'],
  surface: ['#f3ead6', '#e2d6bb'],
  sky: ['#eef4f6', '#d6e2e8'],
  orbit: ['#262a55', '#10122a'],
};

/**
 * Unit paint (DIRECTIONS.md §1 "Unit model kit"): one body colour per plane, two neutrals, and the glow pigments of
 * functional parts. A model uses at most three paint values plus its team accent and one glow pigment.
 */
export const UNIT_PAINT = {
  /** structure foundations: a pale poured slab under the model, edged by the team trim */
  concrete: '#b7b0a3',
  body: { depths: '#b98f45', surface: '#6c735b', sky: '#c8d0da', orbit: '#e3d6b5' } satisfies Record<Plane, string>,
  /** light neutral: housings, drills, dishes */
  steel: '#a9b0b8',
  /** dark neutral: barrels, tracks, engines */
  iron: '#3d4149',
  sensor: '#7fd6ff',
  engine: '#ffb347',
  ore: '#5fc9b8',
  fuse: '#ff6a3d',
  /** photovoltaic glass: a deep cool blue the solar shader lifts with sky reflection and highlight streaks */
  cell: '#2e4380',
  /** deploy stances: foxhole sandbags and emplacement pads */
  sandbag: '#a8996d',
} as const;

/** Mineral pigments: teal ore versus orchid-rich crystals; neither borrows team, threat or magma paint. */
export const LODE_PAINT = { ordinary: UNIT_PAINT.ore, rich: '#cf50d6' } as const;
/** Green rich ore (map.richOre): emerald crystals, apart from the teal ore, the orchid Mother Lode and the lime army green. */
export const RICH_ORE_PAINT = { crystal: '#2fc466', glow: '#1c9a4c' } as const;
/**
 * Stored and dropped ore (landing heaps, asteroid-drop caches): loose teal rubble, ore lumps and pale crystal tips.
 * Mineral pigments only, never iron, body or team paint, so a heap can't be mistaken for a digger and its hopper.
 */
export const ORE_HEAP_PAINT = { rubble: '#3f8a80', lump: UNIT_PAINT.ore, crystal: '#a8f0e2' } as const;
/**
 * Planted sapper charges (`charges.ts`): a bundle of dynamite in brick-red paper with pale wadded ends, a dark cord
 * fuse and its spark in the sapper's fuse orange. The tying band carries the planter's army colour.
 */
export const CHARGE_PAINT = { stick: '#b8382a', end: '#e6d3a8', cord: '#3a2a1e', pip: '#f3e6c8', spark: UNIT_PAINT.fuse } as const;

const C = (r: Record<Plane, string>): Record<Plane, Color> =>
  Object.fromEntries(PLANES.map((p) => [p, new Color(r[p])])) as Record<Plane, Color>;
export const PAPER_C = C(PAPER);
const LINE_C = C(LINE);
const INK_C = C(INK);
const GHOST_C = C(GHOST_PENCIL);
const BG_TOP = C(Object.fromEntries(PLANES.map((p) => [p, BG[p][0]])) as Record<Plane, string>);
const BG_BOTTOM = C(Object.fromEntries(PLANES.map((p) => [p, BG[p][1]])) as Record<Plane, string>);

/** The viewed page, interpolated through dives (`setViewLevel`). */
export const VIEW = {
  paper: uniform(new Color(PAPER.surface)),
  ghostPencil: uniform(new Color(GHOST_PENCIL.surface)),
  line: uniform(new Color(LINE.surface)),
  lineK: uniform(LINE_K.surface),
  /** dark ink a chalk line turns to over lit pixels, and how dark the viewed paper is (1 dark, 0 light) */
  ink: uniform(new Color(INK.surface)),
  dark: uniform(DARK.surface ? 1 : 0),
  bgTop: uniform(new Color(BG.surface[0])),
  bgBottom: uniform(new Color(BG.surface[1])),
};

/** `level` = continuous camera plane index (0 depths … 3 orbit). */
export function setViewLevel(level: number): void {
  const i = clamp(Math.floor(level), 0, 3);
  const j = clamp(i + 1, 0, 3);
  const k = clamp(level - i, 0, 1);
  const a = PLANES[i]!;
  const b = PLANES[j]!;
  VIEW.paper.value.copy(PAPER_C[a]).lerp(PAPER_C[b], k);
  VIEW.ghostPencil.value.copy(GHOST_C[a]).lerp(GHOST_C[b], k);
  VIEW.line.value.copy(LINE_C[a]).lerp(LINE_C[b], k);
  VIEW.lineK.value = LINE_K[a] + (LINE_K[b] - LINE_K[a]) * k;
  VIEW.ink.value.copy(INK_C[a]).lerp(INK_C[b], k);
  VIEW.dark.value = (DARK[a] ? 1 : 0) + ((DARK[b] ? 1 : 0) - (DARK[a] ? 1 : 0)) * k;
  VIEW.bgTop.value.copy(BG_TOP[a]).lerp(BG_TOP[b], k);
  VIEW.bgBottom.value.copy(BG_BOTTOM[a]).lerp(BG_BOTTOM[b], k);
}
