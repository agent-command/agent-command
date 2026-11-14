/** Balance report labels and declarative benchmark sets. Execution belongs to @playerthree/bench. */
import type { PolicyArtifact } from 'playerthree';
import { OPPONENTS, slotArmyIds, type ArmyId, type MatchOptions, type Opponent, type Plane, type TerrainPreset } from '@agent-command/game';
import { PROBES, probeSource } from './probes.ts';

/** One entrant: an army of built-in bots at `level` on every seat, except the seats a probe's policies drive. */
export interface EntrantSpec {
  level: Opponent;
  /** probe id: a registered probe (probes.ts), or the label of the inline `policies` */
  probe?: string;
  /** inline JS policy source per seat (exploit-hunt results); takes precedence over the probe registry */
  policies?: Partial<Record<Plane, string>>;
}

/** Map layouts a sweep plays (DESIGN §2.3): the two-army duel and the four-army free-for-all. */
export const LAYOUTS = ['duel', 'ffa'] as const;
export type Layout = (typeof LAYOUTS)[number];
/** Armies (= layout slots) per layout. */
export const LAYOUT_ARMIES: Readonly<Record<Layout, number>> = { duel: 2, ffa: 4 };

/** The army ids of a layout's slots, in slot order (`nw`, `se` for a duel; all four corners for FFA). */
export const layoutArmies = (layout: Layout): ArmyId[] => slotArmyIds(LAYOUT_ARMIES[layout]);

export interface RunSet {
  key: string;
  kind: 'mirror' | 'ladder' | 'probe';
  title: string;
  /** one entrant per army; `entrants[0]` is the one under test (mirror: any) */
  entrants: EntrantSpec[];
  layout: Layout;
  seeds: number[];
  /**
   * Entrant index per layout slot, one row per orientation. Cyclic rotations play every entrant on every slot once,
   * which cancels slot bias out of entrant comparisons; mirrors play one orientation.
   */
  permutations: number[][];
  options?: MatchOptions;
}

/** Bot levels that play mirrors (`idle` never acts). */
export const LEVELS: readonly Opponent[] = OPPONENTS.filter((o) => o !== 'idle');

/** Every cyclic rotation of `n` entrants over `n` slots: rotation r puts entrant 0 on slot r. */
export const rotations = (n: number): number[][] =>
  Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, slot) => (slot - r + n) % n));

/** Resolve registered probes and hunt policies into portable PlayerThree artifacts. */
export function entrantPolicies(entrant: EntrantSpec): Record<string, PolicyArtifact> {
  let sources = entrant.policies;
  if (!sources && entrant.probe) {
    const probe = PROBES.find((p) => p.id === entrant.probe);
    if (!probe) throw new Error(`unknown probe ${entrant.probe}`);
    sources = Object.fromEntries(Object.entries(probe.seats).map(([role, file]) => [role, probeSource(file)]));
  }
  return Object.fromEntries(Object.entries(sources ?? {}).map(([role, code]) => [role, { runtime: 'js' as const, code }]));
}

export interface PlanOptions {
  /** seeds per mirror and per ladder orientation */
  seeds: number;
  /** seeds per probe and orientation */
  probeSeeds: number;
  /** probe ids to run (default: every probe that plays the layout) */
  probes?: readonly string[];
  /** bot levels the probes play at (probe army's own bots and every opponent) */
  probeLevels: readonly Opponent[];
  /** bot levels that play mirrors (default every level but `idle`) */
  mirrorLevels?: readonly Opponent[];
  /** layout every run set plays (default `duel`); the tier ladder is a duel measurement and only runs there */
  layout?: Layout;
  /**
   * Terrain presets (match option `terrain`). Every run set is played on each; with more than one, keys get an
   * `@<preset>` suffix and titles a `(<preset>)`. Omit to play the game's default map.
   */
  terrains?: readonly TerrainPreset[];
  /** Map sizes (match rule `map.params.size`), tagged like terrains (`@s48`, `(S48)`) when there are several. */
  sizes?: readonly number[];
}

const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

const LADDER: readonly [Opponent, Opponent][] = [
  ['veteran', 'novice'],
  ['veteran', 'standard'],
  ['standard', 'novice'],
];

/** S48, M64, L80: the size letter the lobby uses. */
const sizeLabel = (size: number): string => `${size <= 48 ? 'S' : size <= 64 ? 'M' : 'L'}${size}`;

/** Match options for a layout, terrain and size; undefined when everything is the game's default. */
function matchOptions(layout: Layout, terrain: TerrainPreset | undefined, size: number | undefined): MatchOptions | undefined {
  const slots = LAYOUT_ARMIES[layout];
  // Generated maps default to two slots; FFA needs the C4 recipe (DESIGN §15.4 `map.params.slots`).
  const params = { ...(slots !== 2 ? { slots } : {}), ...(size !== undefined ? { size } : {}) };
  const options: MatchOptions = { ...(terrain !== undefined ? { terrain } : {}), ...(Object.keys(params).length ? { map: { params } } : {}) };
  return Object.keys(options).length ? options : undefined;
}

/**
 * The standard sweep of one layout: mirrors per bot level (slot bias, pacing, plane activity), in a duel the tier
 * ladder in both orientations (veteran ≥ standard ≥ novice), and every strategy probe against bots of its own level
 * in every rotation. Seeds start at 1001 so they never coincide with unit-test seeds.
 */
export function standardPlan(o: PlanOptions): RunSet[] {
  const layout = o.layout ?? 'duel';
  const armies = LAYOUT_ARMIES[layout];
  const seeds = range(1001, o.seeds);
  const probeSeeds = range(2001, o.probeSeeds);
  const probes = o.probes ?? PROBES.filter((p) => p.layouts.includes(layout)).map((p) => p.id);
  for (const id of probes) {
    const probe = PROBES.find((p) => p.id === id);
    if (!probe) throw new Error(`unknown probe ${id} (known: ${PROBES.map((p) => p.id).join(', ')})`);
    if (!probe.layouts.includes(layout)) throw new Error(`probe ${id} does not play the ${layout} layout (${probe.layouts.join(', ')})`);
  }
  const terrains = o.terrains ?? [];
  const sizes = o.sizes ?? [];
  const prefix = layout === 'duel' ? { key: '', title: '' } : { key: `${layout}-`, title: `${layout.toUpperCase()} ` };
  const sets: RunSet[] = [];
  for (const terrain of terrains.length ? terrains : [undefined]) {
    for (const size of sizes.length ? sizes : [undefined]) {
      const tags = [
        ...(terrain !== undefined && terrains.length > 1 ? [{ key: terrain, title: terrain }] : []),
        ...(size !== undefined && sizes.length > 1 ? [{ key: sizeLabel(size).toLowerCase(), title: sizeLabel(size) }] : []),
      ];
      const tag = tags.length ? { key: `@${tags.map((t) => t.key).join('@')}`, title: ` (${tags.map((t) => t.title).join(', ')})` } : { key: '', title: '' };
      const options = matchOptions(layout, terrain, size);
      const add = (set: Omit<RunSet, 'options' | 'layout'>): void => void sets.push({
        ...set, key: prefix.key + set.key + tag.key, title: prefix.title + set.title + tag.title, layout, ...(options ? { options } : {}),
      });
      const field = (level: Opponent): EntrantSpec[] => Array.from({ length: armies }, () => ({ level }));
      // `seeds: 0` runs probes only (re-checking one strategy without the reference sets).
      if (o.seeds > 0) {
        for (const level of o.mirrorLevels ?? LEVELS) {
          add({ key: `mirror-${level}`, kind: 'mirror', title: `${level} mirror`, entrants: field(level), seeds, permutations: [rotations(armies)[0]!] });
        }
        if (layout === 'duel') {
          for (const [a, b] of LADDER) {
            add({ key: `${a}-vs-${b}`, kind: 'ladder', title: `${a} vs ${b}`, entrants: [{ level: a }, { level: b }], seeds, permutations: rotations(armies) });
          }
        }
      }
      for (const id of probes) {
        for (const level of o.probeLevels) {
          add({ key: `probe-${id}-${level}`, kind: 'probe', title: `${id} vs ${level}`, entrants: [{ level, probe: id }, ...field(level).slice(1)], seeds: probeSeeds, permutations: rotations(armies) });
        }
      }
    }
  }
  return sets;
}

/** Matches a run set plays. */
export const setMatches = (set: RunSet): number => set.seeds.length * set.permutations.length;
