/** Reference benchmark specs use the same resolved game contract as hosted arena matches. */
import type { MatchSpec, SeriesSpec } from '@playerthree/bench';
import { manifest } from '../packages/game/src/agent/manifest.ts';
import { MAPS, mapDescriptor } from '../packages/game/src/maps/maps.ts';
import { COLOURS, resolveRules, type MatchOptions } from '../packages/game/src/rules/contract.ts';
import { resolveArenaMatch } from '../packages/game/src/lobby/arena.ts';
import { SURFACE_HASH } from './surface.ts';
import { eventDefinitions, metricDefinitions } from '../packages/game/src/metrics/metrics.ts';

type EntrantCard = SeriesSpec['entrants'][number];

interface SeriesOptions {
  track: SeriesSpec['track'];
  entrants: readonly EntrantCard[];
  seeds: readonly number[];
  ticks: number;
  concurrency?: number;
  options?: MatchOptions;
  /** map layout id (`duel`, `ffa`, …); default the map's first supported layout. Permutations cover its slots. */
  layout?: string;
  permutations: readonly (readonly string[])[];
  policyRoles?: Readonly<Record<string, readonly string[]>>;
  budgets?: SeriesSpec['budgets'];
  authoring?: SeriesSpec['authoring'];
  /** metric sample cadence in ticks (default 20: one sample per game second, the devtools time-series resolution) */
  sampleEveryTicks?: number;
  /** infrastructure retries per trial (default 0); the reference evaluator allows one so an interrupted match can resume */
  maxInfraRetries?: number;
}

export function seriesSpec(input: SeriesOptions): SeriesSpec {
  const options = input.options ?? {};
  const rules = resolveRules(options);
  // A named (authored or host-saved) selection keeps its map; otherwise the generated recipe of the resolved terrain.
  const map = options.map?.name ? mapDescriptor(options.map.name) : MAPS.find((entry) => entry.tags.includes('generated') && entry.terrain === rules.terrain);
  if (!map) throw new Error(`no benchmark map for ${options.map?.name ?? rules.terrain}`);
  const layout = map.layouts.find((entry) => entry.supported && (input.layout === undefined || entry.id === input.layout));
  if (!layout) throw new Error(`no supported benchmark layout${input.layout ? ` ${input.layout}` : ''} for ${map.id}`);
  const slots = map.slots.filter((slot) => layout.alliances.some((alliance) => alliance.slots.includes(slot.id)));
  if (input.permutations.some((permutation) => permutation.length !== slots.length)) throw new Error('entrant permutation must cover every map side');
  const entrantSeats = input.entrants.map((entrant) => ({ entrantId: entrant.id,
    seats: map.roles.map((role) => ({ role, occupant: input.policyRoles?.[entrant.id]?.includes(role)
      ? { kind: 'commander' as const, ref: { id: entrant.id, kind: input.track === 'live' ? 'agent' as const : 'policy' as const } }
      : { kind: 'bot' as const, level: entrant.botLevel ?? 'standard', options: entrant.botOptions ?? {} } })) }));
  const makeMatch = (seed: number): MatchSpec => resolveArenaMatch({
    format: 'playerthree.match', version: 1, game: manifest.id, gameVersion: manifest.version,
    surfaceHash: SURFACE_HASH, rulesHash: '', seed,
    map: { id: map.id, identity: '', seed: options.map?.seed ?? seed, layout: layout.id }, options,
    sides: slots.map((slot, index) => {
      const entrantId = input.permutations[0]![index]!;
      const blueprint = entrantSeats.find((entry) => entry.entrantId === entrantId);
      if (!blueprint) throw new Error(`unknown entrant ${entrantId}`);
      // The k-th alliance of the layout plays in COLOURS[k], the lobby's default colours.
      return { id: slot.id, spawnSlot: slot.id, alliance: COLOURS[layout.alliances.findIndex((alliance) => alliance.slots.includes(slot.id))]!,
        seats: blueprint.seats };
    }),
    bindings: slots.flatMap((slot, index) => map.roles.map((role) => ({ seat: { team: slot.id, role }, entrantId: input.permutations[0]![index]! }))),
    observerPolicy: { allowOmniscient: false, minDelayMs: 0 },
    rules: { ranked: false, coaching: 'off', practiceReasons: ['benchmark'] },
  });
  const resolved = input.seeds.map(makeMatch);
  if (!resolved[0]) throw new Error('benchmark needs at least one held-out seed');
  return {
    format: 'playerthree.series', version: 1, game: manifest.id, gameVersion: manifest.version, surfaceHash: SURFACE_HASH,
    track: input.track, entrants: input.entrants, entrantSeats, template: resolved[0],
    scenarios: resolved.map((match, index) => ({ id: `seed-${input.seeds[index]}`, seed: match.seed, map: match.map, options: match.options })),
    permutations: input.permutations.map((entrants, index) => ({ id: `orientation-${index + 1}`, sideEntrants: slots.map((slot, side) => ({ team: slot.id, entrantId: entrants[side]! })) })),
    repetitions: 1,
    execution: { concurrency: input.concurrency ?? 1, speed: 1000, clock: 'accelerated', maxTicks: input.ticks,
      maxWallMs: 30 * 60 * 1000, maxInfraRetries: input.maxInfraRetries ?? 0, state: 'reset_each_match' },
    ...(input.authoring ? { authoring: input.authoring } : {}),
    budgets: input.budgets ?? { maxTokens: null, maxCostUsd: null, maxTurns: null },
    // Elo rates two lineups only; FFA (and later team) layouts with more alliances use TrueSkill's standard parameters.
    rating: layout.alliances.length === 2 ? { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 }
      : { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 },
    telemetry: { sampleEveryTicks: input.sampleEveryTicks ?? 20, includeCommentary: false, metricDefinitions, eventDefinitions },
  };
}
