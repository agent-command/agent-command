/**
 * The featured playlist (Watch live): a seeded, reproducible sequence of built-in-bot matches. Maps and starting
 * conditions stay exactly C2/C4 symmetric (AGENTS.md); the variety is everything else: map, size, layout (duel or
 * four-army free-for-all), each army's bot level per plane and its aggression, a curated rules showcase, and each
 * army's personality (bot option `personality`: its own style within bots/tuning.ts PERSONALITY_* bounds), so even
 * a mirror of one profile plays two different games instead of mirrored decisions to the time cap. Only this
 * playlist sets personalities: lobbies, practice, ranked play, ACBench and the starters play the exact tier bots.
 *
 * A balance gate admits only pairings whose estimated strengths (TIER_RATING, from docs/balance) stay within
 * MAX_RATING_GAP. An in-process record of results per pairing class down-weights classes that keep ending lopsided
 * or very short, so the estimate corrects itself on the live server. Pure apart from its seed: same seed, same
 * results recorded in the same order, same entries.
 */
import { BOT_DEFAULTS, MAX_ARMIES, PERSONALITY_SEED_MAX, personalityTraits, PLANES, resolveRulesPreset, rulesOptions, type ArmyId, type Colour, type MatchOptions, type Outcome, type Plane } from '@agent-command/game';
import { lobbyMode, MAPS } from '@agent-command/game/lobby';
import { resolveLobbyMap } from './lobby.ts';

export type FeaturedLevel = 'novice' | 'standard' | 'veteran';
const LEVELS: readonly FeaturedLevel[] = ['novice', 'standard', 'veteran'];
const LEVEL_LABEL: Readonly<Record<FeaturedLevel, string>> = { novice: 'Novice', standard: 'Standard', veteran: 'Veteran' };
const PLANE_LABEL: Readonly<Record<Plane, string>> = { depths: 'Depths', surface: 'Surface', sky: 'Sky', orbit: 'Orbit' };

// ------------------------------------------------------------------ balance estimate

/**
 * Estimated strength per bot tier, from the tier ladders in docs/balance: novice loses every match to standard and to
 * veteran in every sweep (baseline-pass2, phase-a, checkpoint-b1, combined-b2: 100%), while veteran vs standard swings
 * from 0% to 73% across builds (combined-b2 0%, balance-b2 25%, phase-a 54–73%): about even, veteran slightly ahead.
 */
export const TIER_RATING: Readonly<Record<FeaturedLevel, number>> = { novice: 0, standard: 1, veteran: 1.1 };
/** Each plane's share of an army's rating: the Surface segment's fall decides elimination under the default lossRule. */
export const PLANE_WEIGHT: Readonly<Record<Plane, number>> = { depths: 0.2, surface: 0.4, sky: 0.2, orbit: 0.2 };
/**
 * Rating per unit of aggression shift. No sweep measures aggression, so this is a small guess: a weaker army given more
 * aggression counts as partly compensated, and adaptation corrects the rest. A personality's economy reserve shift
 * counts through the same term with the opposite sign (alloy held back is caution).
 */
export const AGGRESSION_RATING = 0.25;
/**
 * Balance gate: the largest rating gap allowed between any two armies of a match. Veteran vs Standard (0.1) passes,
 * even with the stronger side aggressive; Standard vs Novice (1) never does, nor does a Standard army with a Novice
 * plane against a Veteran.
 */
export const MAX_RATING_GAP = 0.25;

// ------------------------------------------------------------------ draw weights

/** How often each tier is drawn for an army (novice rarely: its mirrors tend to run to the time cap). */
export const LEVEL_WEIGHT: Readonly<Record<FeaturedLevel, number>> = { novice: 0.12, standard: 0.44, veteran: 0.44 };
/** Aggression shifts on each seat's tier default (bot option `aggression`, clamped to [0, 1]) and their draw weights. */
export const AGGRESSION_CHOICES: readonly { shift: number; weight: number }[] = [{ shift: 0, weight: 0.6 }, { shift: 0.2, weight: 0.25 }, { shift: -0.2, weight: 0.15 }];
/** Share of armies drawn with one plane at another tier (a Veteran army with a Novice Orbit). */
export const MIXED_ARMY_SHARE = 0.25;
/**
 * Share of matches where every army plays the same drawn profile. Each army still has its own personality, so a
 * mirror is two styles of one profile, not one decision sequence played twice.
 */
export const MIRROR_SHARE = 0.15;
/** Target share of four-army free-for-alls (between 1 in 4 and 1 in 3). */
export const FFA_SHARE = 0.29;
/**
 * An FFA comes once the owed share reaches a threshold drawn from [MIN, MIN + SPAN): irregular, never back to back.
 * The owed share starts anywhere in [0, SPAN), so a playlist may open on either layout.
 */
export const FFA_THRESHOLD_MIN = 0.5;
export const FFA_THRESHOLD_SPAN = 1;
/** Owed FFA share carried while capacity forces duels, so a busy spell is not repaid with an FFA run. */
export const FFA_DEBT_MAX = 1.5;
/** Generated map sizes by layout: FFAs lean larger (four armies need the room). */
export const SIZE_WEIGHT: Readonly<Record<'duel' | 'ffa', Readonly<Record<number, number>>>> = {
  duel: { 48: 0.5, 64: 0.35, 80: 0.15 },
  ffa: { 48: 0.2, 64: 0.5, 80: 0.3 },
};

/** A curated rules overlay: an existing preset (RULE_PRESETS id), map-feature or Sky overrides, or Standard. */
export interface Showcase {
  id: string;
  /** Shown in the matchup label; empty for Standard. */
  label: string;
  weight: number;
  preset?: string;
  rules?: MatchOptions;
  /** Map generation parameters: authored maps carry their own layers, so these only apply to generated recipes. */
  generatedOnly?: boolean;
}
/** Standard most of the time; occasional showcases of lava, rich ore, storms and the existing rule presets. */
export const SHOWCASES: readonly Showcase[] = [
  { id: 'standard', label: '', weight: 0.55 },
  { id: 'lava-fields', label: 'Lava fields', weight: 0.08, generatedOnly: true, rules: { map: { params: { lavaLakes: { lakes: 3 } } } } },
  { id: 'rich-veins', label: 'Rich veins', weight: 0.07, generatedOnly: true, rules: { map: { params: { richOre: { clusters: 3, loads: 12 } } } } },
  { id: 'bare-rock', label: 'No lava', weight: 0.04, generatedOnly: true, rules: { map: { params: { lavaLakes: { enabled: false }, richOre: { enabled: false } } } } },
  { id: 'storm-front', label: 'Storm front', weight: 0.07, rules: { sky: { stormMinRadius: 8, stormRadius: 11 } } },
  { id: 'calm-skies', label: 'Calm skies', weight: 0.04, preset: 'calm-skies' },
  { id: 'fast', label: 'Fast', weight: 0.06, preset: 'fast' },
  { id: 'crowns', label: 'Crowns', weight: 0.05, preset: 'crowns' },
  { id: 'rich-economy', label: 'Rich economy', weight: 0.04, preset: 'rich-economy' },
];

// ------------------------------------------------------------------ interest and variety

/** Candidates drawn per pick; the pick is weighted by interest, novelty and adaptation. */
export const CANDIDATES = 12;
/** Pairing draws per candidate before it falls back to a Standard mirror (which always passes the gate). */
export const GATE_ATTEMPTS = 32;
/** An identical configuration (map, layout, size, showcase, pairing) never repeats within this many entries. */
export const RECENT_WINDOW = 6;
/** The same map within this many entries weighs REPEAT_MAP_WEIGHT. */
export const RECENT_MAP_WINDOW = 2;
export const REPEAT_MAP_WEIGHT = 0.2;
/** The same pairing class within this many entries weighs REPEAT_PAIRING_WEIGHT. */
export const RECENT_PAIRING_WINDOW = 2;
export const REPEAT_PAIRING_WEIGHT = 0.3;
/** The previous entry's (non-Standard) showcase again weighs this. */
export const REPEAT_SHOWCASE_WEIGHT = 0.2;
/** Every Surface a Novice: novice mirrors run to the 30-minute cap in most sweeps, a slow watch. */
export const NOVICE_SURFACE_INTEREST = 0.35;

// ------------------------------------------------------------------ adaptation

/** A class is judged only after this many results (and its win share after this many decisive ones). */
export const ADAPT_MIN_SAMPLES = 4;
/** Results kept per class: the latest only, so a class recovers once balance changes. */
export const ADAPT_HISTORY = 12;
/** Lopsided: the favoured profile's win share departs from its fair share by more than this (duel: outside 30–70%). */
export const WIN_SHARE_TOLERANCE = 0.2;
export const LOPSIDED_WEIGHT = 0.15;
/** A match decided sooner than this (open to end, wall clock at speed 1) is very short. */
export const SHORT_GAME_MS = 6 * 60_000;
/** A class with at least this share of very short matches weighs SHORT_WEIGHT. */
export const SHORT_SHARE_LIMIT = 0.5;
export const SHORT_WEIGHT = 0.3;

// ------------------------------------------------------------------ types

export interface PlaylistArmy {
  id: ArmyId;
  colour: Colour;
  /** Bot tier per plane seat. */
  planes: Readonly<Record<Plane, FeaturedLevel>>;
  /** Added to each seat's tier-default aggression. */
  aggressionShift: number;
  /** Bot option `personality` of every seat: this army's style (drawn per army, so mirrors diverge). */
  personality: number;
  rating: number;
  /** Profile identity (levels and aggression), shared by armies drawn alike whatever their personality. */
  profile: string;
  label: string;
}

export interface PlaylistEntry {
  /** 1-based position in this playlist. */
  n: number;
  mapId: string;
  layoutId: string;
  size: number;
  mapSeed: number;
  showcase: string;
  armies: readonly PlaylistArmy[];
  /** Adaptation class: layout kind and the armies' profiles, independent of map and slot. */
  pairing: string;
  /** No-repeat identity of the whole configuration. */
  key: string;
  /** Honest matchup line for viewers ("Veteran (aggressive) vs Standard · Canyons 64 · Lava fields"). */
  label: string;
}

export interface PlaylistResult {
  outcomes: Readonly<Record<string, Outcome>>;
  durationMs: number;
}

interface Venue { mapId: string; label: string; layoutId: string; generated: boolean; sizes: readonly number[]; mapSeed?: number; sides: readonly { id: ArmyId; alliance: Colour }[] }
interface Profile { planes: Record<Plane, FeaturedLevel>; aggressionShift: number }
interface DrawnArmy extends Profile { personality: number }
interface ClassResult { decisive: boolean; favouredWon: boolean; fair: number | undefined; short: boolean }

/** Every exact-fairness duel and FFA layout in the public catalogue (generated recipes in both). */
function venues(): Venue[] {
  return MAPS.flatMap((map) => map.layouts.flatMap((layout) => {
    if (!layout.supported || layout.fairness !== 'exact' || (layout.mode !== '1v1' && layout.mode !== 'ffa')) return [];
    const mode = lobbyMode(map.id, layout.id);
    if (!mode) return [];
    return [{
      mapId: map.id, label: map.label, layoutId: layout.id, generated: map.tags.includes('generated'), sizes: map.sizes,
      ...(map.mapSeed === undefined ? {} : { mapSeed: map.mapSeed }),
      sides: mode.sides.map((side) => ({ id: side.id, alliance: side.alliance as Colour })),
    }];
  }));
}

/** Seeded mulberry32 (as the sim's Rng): reproducible from the playlist seed alone. */
function mulberry(seed: number): () => number {
  // Mix the seed so nearby seeds diverge from the first draw.
  let state = (seed ^ 0x9e3779b9) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x85ebca6b) >>> 0;
  state = Math.imul(state ^ (state >>> 13), 0xc2b2ae35) >>> 0;
  state = (state ^ (state >>> 16)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T>(random: () => number, items: readonly T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= weight(item);
    if (roll < 0) return item;
  }
  return items.at(-1)!;
}

/** An army's estimated strength: its tiers by plane weight, its aggression shift and its personality's style shift. */
export function armyRating(army: Profile & { personality?: number }): number {
  const style = personalityTraits(army.personality);
  return PLANES.reduce((sum, plane) => sum + PLANE_WEIGHT[plane] * TIER_RATING[army.planes[plane]], 0)
    + AGGRESSION_RATING * (army.aggressionShift + style.aggression - style.economyReserve);
}

/** The balance gate over estimated ratings (a small epsilon absorbs float sums). */
export function withinGate(ratings: readonly number[]): boolean {
  return Math.max(...ratings) - Math.min(...ratings) <= MAX_RATING_GAP + 1e-9;
}

/** The level most of the army's planes play (three of four when one plane is mixed). */
function baseLevel(profile: Profile): FeaturedLevel {
  return LEVELS.reduce((best, level) => PLANES.filter((plane) => profile.planes[plane] === level).length > PLANES.filter((plane) => profile.planes[plane] === best).length ? level : best, profile.planes.surface);
}

function profileKey(profile: Profile): string {
  const base = baseLevel(profile);
  const odd = PLANES.filter((plane) => profile.planes[plane] !== base).map((plane) => `${plane}:${profile.planes[plane]}`);
  return `${base}${odd.length ? `[${odd.join(',')}]` : ''}${profile.aggressionShift ? `${profile.aggressionShift > 0 ? '+' : ''}${profile.aggressionShift}` : ''}`;
}

function profileLabel(profile: Profile): string {
  const base = baseLevel(profile);
  const notes = [
    ...(profile.aggressionShift > 0 ? ['aggressive'] : profile.aggressionShift < 0 ? ['cautious'] : []),
    ...PLANES.filter((plane) => profile.planes[plane] !== base).map((plane) => `${LEVEL_LABEL[profile.planes[plane]]} ${PLANE_LABEL[plane]}`),
  ];
  return `${LEVEL_LABEL[base]}${notes.length ? ` (${notes.join(' · ')})` : ''}`;
}

function matchupLabel(armies: readonly PlaylistArmy[]): string {
  const ffa = armies.length > 2;
  if (armies.every((army) => army.profile === armies[0]!.profile)) {
    // Honest about what differs: the profile is shared, the personalities are not.
    const styles = new Set(armies.map((army) => army.personality)).size === armies.length ? ' · different styles' : '';
    return ffa ? `FFA: ${armies[0]!.label} ×${armies.length}${styles}` : `${armies[0]!.label} mirror${styles}`;
  }
  return ffa ? `FFA: ${armies.map((army) => army.label).join(', ')}` : armies.map((army) => army.label).join(' vs ');
}

/** The favoured profile (highest rating; ties by key) and its armies, or undefined for a mirror. */
function favoured(armies: readonly PlaylistArmy[]): readonly PlaylistArmy[] | undefined {
  if (armies.every((army) => army.profile === armies[0]!.profile)) return undefined;
  const top = armies.toSorted((a, b) => b.rating - a.rating || (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0))[0]!;
  return armies.filter((army) => army.profile === top.profile);
}

export interface FeaturedPlaylistOptions {
  seed: number;
  /** One line per entry, result and adaptation change (the server passes console.log). */
  log?: (line: string) => void;
}

export class FeaturedPlaylist {
  readonly seed: number;
  readonly #random: () => number;
  readonly #venues = venues();
  readonly #log: (line: string) => void;
  readonly #history: PlaylistEntry[] = [];
  readonly #classes = new Map<string, ClassResult[]>();
  #ffaDebt: number;
  #ffaThreshold: number;

  constructor({ seed, log = () => {} }: FeaturedPlaylistOptions) {
    this.seed = seed >>> 0;
    this.#random = mulberry(this.seed);
    this.#log = log;
    this.#ffaDebt = this.#random() * FFA_THRESHOLD_SPAN;
    this.#ffaThreshold = FFA_THRESHOLD_MIN + this.#random() * FFA_THRESHOLD_SPAN;
    this.#log(`featured playlist: seed ${this.seed}`);
  }

  /** The next match. `maxArmies` 2 forces a duel (an FFA does not fit capacity now); its FFA share stays owed. */
  next({ maxArmies = MAX_ARMIES }: { maxArmies?: number } = {}): PlaylistEntry {
    this.#ffaDebt = Math.min(FFA_DEBT_MAX, this.#ffaDebt + FFA_SHARE);
    const previous = this.#history.at(-1);
    const ffa = maxArmies >= MAX_ARMIES && (previous?.armies.length ?? 0) < MAX_ARMIES && this.#ffaDebt >= this.#ffaThreshold;
    if (ffa) {
      this.#ffaDebt -= 1;
      this.#ffaThreshold = FFA_THRESHOLD_MIN + this.#random() * FFA_THRESHOLD_SPAN;
    }
    const candidates = Array.from({ length: CANDIDATES }, () => this.#candidate(ffa));
    const scores = candidates.map((candidate) => this.#score(candidate));
    const total = scores.reduce((sum, score) => sum + score, 0);
    const recent = new Set(this.#history.slice(-RECENT_WINDOW).map((entry) => entry.key));
    const chosen = total > 0
      ? weighted(this.#random, candidates.map((candidate, index) => ({ candidate, score: scores[index]! })), (item) => item.score).candidate
      // Every candidate repeats a recent configuration (practically never): any that differs from the last one.
      : candidates.find((candidate) => !recent.has(candidate.key)) ?? candidates.find((candidate) => candidate.key !== previous?.key) ?? candidates[0]!;
    const entry = { ...chosen, n: this.#history.length + 1 };
    this.#history.push(entry);
    this.#log(`featured playlist #${entry.n}: ${entry.label} [${entry.mapId}/${entry.layoutId} ${entry.size} map seed ${entry.mapSeed}, ${entry.showcase}, ${entry.armies.map((army) => `${army.id}=${army.profile}~${army.personality}`).join(' ')}]`);
    return entry;
  }

  /** A finished match's result, by army outcome and wall-clock length (speed 1). */
  record(entry: PlaylistEntry, result: PlaylistResult): void {
    const winners = entry.armies.filter((army) => result.outcomes[army.id] === 'win');
    const favourites = favoured(entry.armies);
    const results = this.#classes.get(entry.pairing) ?? [];
    const before = this.weight(entry.pairing);
    results.push({
      decisive: winners.length > 0,
      favouredWon: !!favourites && winners.some((army) => favourites.includes(army)),
      fair: favourites ? favourites.length / entry.armies.length : undefined,
      short: result.durationMs < SHORT_GAME_MS,
    });
    if (results.length > ADAPT_HISTORY) results.splice(0, results.length - ADAPT_HISTORY);
    this.#classes.set(entry.pairing, results);
    const after = this.weight(entry.pairing);
    this.#log(`featured playlist #${entry.n} result: ${winners.length ? winners.map((army) => army.id).join(', ') : 'draw'} in ${Math.round(result.durationMs / 1000)} s (${entry.pairing}: weight ${after})`);
    if (after !== before) this.#log(`featured playlist: ${entry.pairing} weight ${before} → ${after}`);
  }

  /** Adaptation multiplier of a pairing class: 1 until its results show it lopsided or very short. */
  weight(pairing: string): number {
    const results = this.#classes.get(pairing) ?? [];
    if (results.length < ADAPT_MIN_SAMPLES) return 1;
    let weight = 1;
    const decisive = results.filter((result) => result.decisive);
    const fair = results[0]!.fair;
    if (fair !== undefined && decisive.length >= ADAPT_MIN_SAMPLES) {
      const share = decisive.filter((result) => result.favouredWon).length / decisive.length;
      if (Math.abs(share - fair) > WIN_SHARE_TOLERANCE) weight *= LOPSIDED_WEIGHT;
    }
    if (results.filter((result) => result.short).length / results.length >= SHORT_SHARE_LIMIT) weight *= SHORT_WEIGHT;
    return weight;
  }

  #candidate(ffa: boolean): Omit<PlaylistEntry, 'n'> {
    const random = this.#random;
    const kind = ffa ? 'ffa' : 'duel';
    const venue = weighted(random, this.#venues.filter((entry) => (entry.sides.length > 2) === ffa), () => 1);
    const size = venue.sizes.length === 1 ? venue.sizes[0]! : weighted(random, venue.sizes, (value) => SIZE_WEIGHT[kind][value] ?? 0);
    const showcase = weighted(random, SHOWCASES.filter((entry) => venue.generated || !entry.generatedOnly), (entry) => entry.weight);
    const mapSeed = venue.mapSeed ?? Math.floor(random() * 2 ** 32);
    const drawn = this.#pairing(venue.sides.length);
    const armies = venue.sides.map((side, index): PlaylistArmy => {
      const army = drawn[index]!;
      return {
        id: side.id, colour: side.alliance, planes: army.planes, aggressionShift: army.aggressionShift, personality: army.personality,
        rating: armyRating(army), profile: profileKey(army), label: profileLabel(army),
      };
    });
    const pairing = `${kind}:${armies.map((army) => army.profile).sort().join(' | ')}`;
    const label = [matchupLabel(armies), venue.generated ? `${venue.label} ${size}` : venue.label, showcase.label].filter(Boolean).join(' · ');
    return { mapId: venue.mapId, layoutId: venue.layoutId, size, mapSeed, showcase: showcase.id, armies, pairing, key: `${venue.mapId}/${venue.layoutId}/${size}/${showcase.id}/${pairing}`, label };
  }

  /** Profiles and personalities for `count` armies that pass the balance gate (personalities count in the ratings). */
  #pairing(count: number): DrawnArmy[] {
    for (let attempt = 0; attempt < GATE_ATTEMPTS; attempt++) {
      const mirror = this.#random() < MIRROR_SHARE;
      const first = this.#profile();
      const armies = Array.from({ length: count }, (_, index): DrawnArmy => ({ ...(mirror || index === 0 ? first : this.#profile()), personality: this.#personality() }));
      if (withinGate(armies.map(armyRating))) return armies;
    }
    // A Standard mirror passes whatever its personalities: their style shifts are far inside MAX_RATING_GAP.
    const standard: Profile = { planes: { depths: 'standard', surface: 'standard', sky: 'standard', orbit: 'standard' }, aggressionShift: 0 };
    return Array.from({ length: count }, () => ({ ...standard, personality: this.#personality() }));
  }

  #personality(): number {
    return 1 + Math.floor(this.#random() * PERSONALITY_SEED_MAX);
  }

  #profile(): Profile {
    const random = this.#random;
    const level = weighted(random, LEVELS, (entry) => LEVEL_WEIGHT[entry]);
    const planes: Record<Plane, FeaturedLevel> = { depths: level, surface: level, sky: level, orbit: level };
    if (random() < MIXED_ARMY_SHARE) planes[PLANES[Math.floor(random() * PLANES.length)]!] = weighted(random, LEVELS.filter((entry) => entry !== level), (entry) => LEVEL_WEIGHT[entry]);
    return { planes, aggressionShift: weighted(random, AGGRESSION_CHOICES, (choice) => choice.weight).shift };
  }

  #score(candidate: Omit<PlaylistEntry, 'n'>): number {
    const history = this.#history;
    if (history.slice(-RECENT_WINDOW).some((entry) => entry.key === candidate.key)) return 0;
    let score = this.weight(candidate.pairing);
    if (candidate.armies.every((army) => army.planes.surface === 'novice')) score *= NOVICE_SURFACE_INTEREST;
    if (history.slice(-RECENT_MAP_WINDOW).some((entry) => entry.mapId === candidate.mapId)) score *= REPEAT_MAP_WEIGHT;
    if (history.slice(-RECENT_PAIRING_WINDOW).some((entry) => entry.pairing === candidate.pairing)) score *= REPEAT_PAIRING_WEIGHT;
    const last = history.at(-1);
    if (last && last.showcase !== 'standard' && last.showcase === candidate.showcase) score *= REPEAT_SHOWCASE_WEIGHT;
    return score;
  }
}

/** The entry's match rules: its map, size and layout over the host defaults, then its showcase. */
export function featuredRules(entry: PlaylistEntry, hostRules: MatchOptions | undefined): MatchOptions {
  const showcase = SHOWCASES.find((item) => item.id === entry.showcase)!;
  return resolveLobbyMap(entry.mapId, entry.layoutId, entry.mapSeed, entry.size, hostRules,
    showcase.preset ? rulesOptions(resolveRulesPreset(showcase.preset)) : undefined, showcase.rules).options;
}

/**
 * One built-in bot per seat at the entry's tier, its aggression shifted from that tier's default, with its army's
 * personality. The only caller that sets the `personality` bot option.
 */
export function featuredBotSeats(entry: PlaylistEntry): { team: ArmyId; role: Plane; level: FeaturedLevel; options: Record<string, number> }[] {
  return entry.armies.flatMap((army) => PLANES.map((role) => {
    const level = army.planes[role];
    const options: Record<string, number> = { personality: army.personality };
    // Rounded to whole percent: 0.7 + 0.2 is the knob value 0.9, not 0.8999….
    if (army.aggressionShift) options.aggression = Math.round(Math.min(1, Math.max(0, BOT_DEFAULTS[level].aggression + army.aggressionShift)) * 100) / 100;
    return { team: army.id, role, level, options };
  }));
}
