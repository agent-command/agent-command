/**
 * Community ladder core (DESIGN §Ladder): verdicts, TrueSkill application, segments, seasons, decay and provisional
 * status, as pure functions of the signed commander log plus the matchmaker's private match records. The service
 * (`ranked.ts`) applies matches incrementally at commit and recomputes nightly with these same functions, so both
 * paths produce identical ratings.
 */
import { createHash } from 'node:crypto';
import { rateMatch, type SkillRating } from 'playerthree/results';
import type { CommanderLogContext, CommanderLogEntry, CommanderLogVerdict } from 'playerthree/host';
import { PLANES, TICK_RATE, type ArmyId, type Colour } from '@agent-command/game';

/** Ladder adjudication rules (not gameplay): every number the ladder uses. */
export const LADDER = {
  mu: 25,
  sigma: 25 / 3,
  beta: 25 / 6,
  tau: 25 / 300,
  /** TrueSkill draw probability by shape. */
  drawProbability: { duel: 0.05, ffa: 0.01 },
  /** Ladder points = max(0, round(points × (μ − 3σ))); the uncertainty band is μ ± 2σ in the same units. */
  points: 40,
  provisional: { games: 10, clusters: 5, sigma: 3 },
  /** A new policy version keeps μ and inflates σ² by this σ. */
  policyBumpSigma: 2,
  /** Each full inactive week adds this σ in quadrature, capped at σ₀; μ never decays. */
  decayWeekSigma: 0.5,
  weekMs: 7 * 86_400_000,
  /** Inactive this long: rated, but not listed until it plays. */
  hiddenAfterMs: 60 * 86_400_000,
  /** A new season carries μ and resets σ to at least this. */
  seasonSigmaFloor: 5,
  /** Repeat pairs: the n-th rated game of two clusters within the window has weight 1 / (1 + damping·(n − 1)); past the cap, unrated. */
  repeat: { windowMs: 7 * 86_400_000, damping: 0.5, cap: 10 },
  /** A plane played more than this share by a fallback stays rated with a badge (D4). */
  fallbackHeavy: 0.25,
  /** Minimum rated length: 3 minutes of simulated time. */
  minTicks: 3 * 60 * TICK_RATE,
  /** Each side needs at least one accepted intent per this many ticks of its play (10 s). */
  activityTicks: 10 * TICK_RATE,
} as const;

export const POOLS = ['policy_1v1', 'policy_ffa', 'live_1v1', 'live_ffa'] as const;
export type Pool = (typeof POOLS)[number];
export const QUEUE_OF: Readonly<Record<Pool, string>> = { policy_1v1: 'rated_policy_1v1', policy_ffa: 'rated_policy_ffa', live_1v1: 'rated_live_1v1', live_ffa: 'rated_live_ffa' };
export const POOL_OF_QUEUE: Readonly<Record<string, Pool>> = Object.fromEntries(POOLS.map((pool) => [QUEUE_OF[pool], pool]));
export const kindOf = (pool: Pool): 'policy' | 'agent' => (pool.startsWith('policy') ? 'policy' : 'agent');
export const shapeOf = (pool: Pool): 'duel' | 'ffa' => (pool.endsWith('ffa') ? 'ffa' : 'duel');

/** The matchmaker's private record of a rated match: who sat where, their clusters and the repeat-pair count. */
export interface RatedMatchRecord {
  matchId: string;
  pool: Pool;
  season: string;
  createdAt: number;
  /** The rules hash the matchmaker froze for this map (standard rules only). */
  rulesHash: string;
  map: { map: string; layout: string };
  /** The map seed (authored maps: their own) and the armies in slot order with their colours. */
  mapSeed: number;
  armies: { id: ArmyId; alliance: Colour }[];
  sides: { team: string; owner: string; cluster: string; eligible: boolean; commanders: string[] }[];
  /** Max over cluster pairs of how many rated games they played within the repeat window, this one included. */
  repeat: number;
}

/** Rating segment (D1, §6): commander × pool × declared metadata. Changing the declaration starts a new segment. */
export function segmentId(commanderId: string, pool: Pool | 'gauntlet', declared: CommanderLogContext['declared']): string {
  return `s_${createHash('sha256').update(JSON.stringify([commanderId, pool, declared.provider ?? null, declared.model ?? null, declared.scaffoldVersion ?? null])).digest('hex').slice(0, 32)}`;
}

export const ladderPoints = (rating: SkillRating): number => Math.max(0, Math.round(LADDER.points * (rating.mu - 3 * rating.sigma)));
export const repeatWeight = (n: number): number => 1 / (1 + LADDER.repeat.damping * (Math.max(1, n) - 1));

const UNRATED_WITH = (reasons: string[], pool: Pool | null = null, segment: string | null = null, badges: string[] = []): CommanderLogVerdict =>
  ({ rated: false, pool, segmentId: segment, weight: 0, badges, reasons: [...new Set(reasons)].sort() });

/**
 * Per-entry verdict (§7.1): a rated queue, the matchmaker's record, the official host, standard rules, pool-kind
 * commanders only, distinct owners and clusters, no assistance, a rated disposition, length and activity. Cross-side
 * consequences (an assisted or inactive opponent, an early forfeit) are applied with all of a match's entries
 * (`applyMatch`); `inactive_side` and `too_short` forfeits stay rated here so that application sees them.
 */
export function verdictFor(ctx: CommanderLogContext, record: RatedMatchRecord | undefined, official: boolean): CommanderLogVerdict {
  const e = ctx.entry;
  const reasons: string[] = [];
  if (!official || !e.host.official) reasons.push('unofficial_host');
  // The gauntlet is logged but never rated (D8); only rated queues reach the ladder.
  if (e.queue === 'gauntlet') return UNRATED_WITH(reasons);
  const pool = e.queue ? POOL_OF_QUEUE[e.queue] : undefined;
  if (!pool || !record || record.matchId !== e.matchId || record.pool !== pool) return UNRATED_WITH([...reasons, 'lobby_match']);
  const segment = segmentId(ctx.commanderId, pool, ctx.declared);
  const badges = e.fallbackShare > LADDER.fallbackHeavy ? ['fallback_heavy'] : [];
  if (e.customRules || e.rulesHash !== record.rulesHash) reasons.push('custom_rules');
  if (e.mode === 'custom_alliances') reasons.push('custom_alliances');
  const own = record.sides.find((side) => side.team === e.team);
  if (!own || own.owner !== ctx.ownerRef || !own.commanders.includes(ctx.commanderId)) return UNRATED_WITH([...reasons, 'lobby_match'], pool, segment, badges);
  const others = record.sides.filter((side) => side.team !== e.team);
  if (e.selfPlay || others.some((side) => side.owner === own.owner)) reasons.push('same_owner');
  if (others.some((side) => side.cluster === own.cluster)) reasons.push('same_cluster');
  if (!own.eligible) reasons.push('provisional_account');
  if (e.assist !== 'none') reasons.push('assisted');
  if (e.disposition === 'interrupted') reasons.push('interrupted');
  if (e.disposition === 'aborted') reasons.push('aborted');
  const kind = kindOf(pool);
  const seats = [...e.lineup, ...e.opponents.flatMap((o) => o.seats)];
  if (seats.some((seat) => seat.kind === 'human')) reasons.push('human_seat');
  if (seats.some((seat) => seat.kind === 'bot')) reasons.push('bot_opponent');
  if (seats.some((seat) => seat.kind !== 'human' && seat.kind !== 'bot' && seat.kind !== kind)) reasons.push('mixed_kind');
  if (e.lineup.some((seat) => !seat.sameOwner) || e.planesControlled < 1 || e.lineup.length !== PLANES.length) reasons.push('mixed_kind');
  if (record.repeat > LADDER.repeat.cap) reasons.push('repeat_pair');
  // Below the minimum length: void unless someone left early (then the leaver loses and nobody else moves); only
  // all of a match's entries tell which, so the flag stays on a rated verdict and `LadderState.apply` decides.
  const flags: string[] = [];
  const accepted = Object.values(e.acceptedIntents).reduce((n, v) => n + v, 0);
  if (e.outcome !== 'unknown' && accepted < Math.floor(e.ticks / LADDER.activityTicks)) flags.push('inactive_side');
  if (e.outcome !== 'unknown' && e.ticks < LADDER.minTicks) flags.push('too_short');
  if (reasons.length) return UNRATED_WITH([...reasons, ...flags], pool, segment, badges);
  return { rated: true, pool, segmentId: segment, weight: repeatWeight(record.repeat), badges, reasons: [...new Set(flags)].sort() };
}

/** One rating row: (pool, season, segment). */
export interface LadderRating {
  pool: Pool;
  season: string;
  segmentId: string;
  publicId: string;
  mu: number;
  sigma: number;
  games: number;
  lastPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  /** FFA placements: count per rank (index 0 = first). */
  placements: number[];
  /** Distinct opponent clusters (private; only their count is shown). */
  opponents: string[];
  /** The policy artifacts of the last rated match (sorted, joined): a change inflates σ. */
  artifacts: string;
}

export interface RatingEvent {
  matchId: string;
  segmentId: string;
  pool: Pool;
  season: string;
  at: number;
  before: SkillRating;
  after: SkillRating;
  weight: number;
}

/** σ after `now − lastPlayed` of inactivity: σ² grows by `decayWeekSigma²` per full week, capped at σ₀. */
export function decayed(rating: Pick<LadderRating, 'sigma' | 'lastPlayed'>, now: number): number {
  const weeks = Math.max(0, Math.floor((now - rating.lastPlayed) / LADDER.weekMs));
  return Math.min(LADDER.sigma, Math.sqrt(rating.sigma ** 2 + weeks * LADDER.decayWeekSigma ** 2));
}

export const provisional = (rating: LadderRating, now: number): boolean =>
  rating.games < LADDER.provisional.games || rating.opponents.length < LADDER.provisional.clusters || decayed(rating, now) >= LADDER.provisional.sigma;

export const ratingKey = (pool: string, season: string, segment: string): string => `${pool}\0${season}\0${segment}`;

/**
 * Deterministic ladder state: apply rated matches in (endedAt, matchId) order. `previousSeason` gives a segment's
 * carried rating when it first plays in a new season (μ kept, σ reset to at least the floor).
 */
export class LadderState {
  readonly ratings = new Map<string, LadderRating>();
  readonly events: RatingEvent[] = [];
  readonly #previousSeason: (pool: Pool, season: string, segment: string) => LadderRating | undefined;

  constructor(previousSeason: (pool: Pool, season: string, segment: string) => LadderRating | undefined = () => undefined) {
    this.#previousSeason = previousSeason;
  }

  #prior(pool: Pool, season: string, segment: string, publicId: string): LadderRating {
    const existing = this.ratings.get(ratingKey(pool, season, segment));
    if (existing) return existing;
    const carried = this.#previousSeason(pool, season, segment);
    return {
      pool, season, segmentId: segment, publicId,
      mu: carried?.mu ?? LADDER.mu, sigma: carried ? Math.max(carried.sigma, LADDER.seasonSigmaFloor) : LADDER.sigma,
      games: 0, lastPlayed: carried?.lastPlayed ?? 0, wins: 0, losses: 0, draws: 0, placements: [], opponents: [], artifacts: carried?.artifacts ?? '',
    };
  }

  /**
   * Apply one match: its entries with their effective verdicts, its season and the sides' clusters. Cross-side rules
   * (§7.2, §7.5): an assisted (void) side makes the rest keep improvements only; an inactive side is rated a loss and
   * the others are not moved; a forfeit below the minimum length is the leaver's loss and moves nobody else.
   */
  apply(entries: readonly { entry: CommanderLogEntry; verdict: CommanderLogVerdict }[], season: string, clusters: ReadonlyMap<string, string>): void {
    const rated = entries.filter((e) => e.verdict.rated && e.verdict.pool && e.verdict.segmentId);
    if (rated.length === 0) return;
    const pool = rated[0]!.verdict.pool as Pool;
    const sides = new Map<string, typeof rated>();
    for (const e of rated) sides.set(e.entry.team, [...sides.get(e.entry.team) ?? [], e]);
    const voidTeams = new Set(entries.filter((e) => !e.verdict.rated && e.verdict.reasons.includes('assisted')).map((e) => e.entry.team));
    if (sides.size + voidTeams.size < 2) return;
    const at = rated[0]!.entry.endedAt;
    const short = rated.some((m) => m.verdict.reasons.includes('too_short'));
    const leavers = new Set(rated.filter((m) => m.entry.disposition === 'forfeit' || m.entry.disposition === 'abandoned').map((m) => m.entry.team));
    // Too short without an early leaver: void for everyone (§7.5).
    if (short && leavers.size === 0) return;
    const earlyLeaver = short;
    const inactive = new Set([...sides].filter(([, members]) => members.some((m) => m.verdict.reasons.includes('inactive_side'))).map(([team]) => team));
    const worst = 1 + Math.max(...entries.map((e) => e.entry.rank ?? 1));
    // Every side that took part, void ones included, is a TrueSkill team: a void side shapes the update, never moves.
    const teams = [...new Set(entries.map((e) => e.entry.team))];
    const ratings = new Map<string, SkillRating>();
    const lineups = teams.flatMap((team) => {
      const members = sides.get(team) ?? entries.filter((e) => e.entry.team === team && e.verdict.segmentId && e.verdict.pool === pool);
      if (members.length === 0) return [];
      for (const m of members) {
        const prior = this.#prior(pool, season, m.verdict.segmentId!, m.entry.commander);
        ratings.set(m.verdict.segmentId!, { mu: prior.mu, sigma: decayedFor(prior, at, m.entry) });
      }
      const rank = inactive.has(team) ? worst : members[0]!.entry.rank ?? worst;
      return [{ team, ids: members.map((m) => m.verdict.segmentId!), rank, weights: members.map((m) => Math.min(1, Math.max(1e-4, m.entry.planeShare))) }];
    });
    if (lineups.length < 2) return;
    const env = { mu: LADDER.mu, sigma: LADDER.sigma, beta: LADDER.beta, tau: LADDER.tau, drawProbability: LADDER.drawProbability[shapeOf(pool)] };
    for (const [team, members] of sides) {
      const sideWeight = Math.min(...members.map((m) => m.verdict.weight)) * ((inactive.size > 0 && !inactive.has(team)) || (earlyLeaver && !leavers.has(team)) ? 0 : 1);
      const updated = rateMatch(env, lineups.map(({ ids, rank, weights }) => ({ ids, rank, weights })), ratings, sideWeight);
      for (const m of members) {
        const id = m.verdict.segmentId!;
        const before = ratings.get(id)!;
        let after = updated.get(id)!;
        if (voidTeams.size > 0 && after.mu < before.mu) after = before;
        const prior = this.#prior(pool, season, id, m.entry.commander);
        const rank = inactive.has(team) ? worst : m.entry.rank ?? worst;
        const outcome = inactive.has(team) ? 'loss' : m.entry.outcome;
        const opponents = [...new Set([...prior.opponents, ...teams.filter((t) => t !== team).map((t) => clusters.get(t) ?? t)])].sort();
        this.ratings.set(ratingKey(pool, season, id), {
          ...prior, publicId: m.entry.commander, mu: after.mu, sigma: after.sigma, games: prior.games + 1, lastPlayed: at,
          wins: prior.wins + (shapeOf(pool) === 'duel' && outcome === 'win' ? 1 : 0),
          losses: prior.losses + (shapeOf(pool) === 'duel' && outcome === 'loss' ? 1 : 0),
          draws: prior.draws + (shapeOf(pool) === 'duel' && outcome === 'draw' ? 1 : 0),
          placements: shapeOf(pool) === 'ffa' ? placed(prior.placements, rank) : prior.placements,
          opponents, artifacts: artifactsOf(m.entry),
        });
        this.events.push({ matchId: m.entry.matchId, segmentId: id, pool, season, at, before, after, weight: sideWeight });
      }
    }
  }
}

/** σ entering a match: decay since the last game, then the policy-version bump when the artifact set changed. */
function decayedFor(prior: LadderRating, at: number, entry: CommanderLogEntry): number {
  const sigma = prior.games === 0 && prior.lastPlayed === 0 ? prior.sigma : decayed(prior, at);
  const artifacts = artifactsOf(entry);
  return prior.artifacts && artifacts && artifacts !== prior.artifacts ? Math.min(LADDER.sigma, Math.sqrt(sigma ** 2 + LADDER.policyBumpSigma ** 2)) : sigma;
}

const artifactsOf = (entry: CommanderLogEntry): string => [...new Set(entry.policies.map((p) => p.artifactHash))].sort().join(',');

function placed(placements: readonly number[], rank: number): number[] {
  const out = [...placements];
  while (out.length < rank) out.push(0);
  out[rank - 1] = (out[rank - 1] ?? 0) + 1;
  return out;
}

/** Quarter id and bounds (UTC) of an instant. */
export function quarterOf(at: number): { id: string; start: number; end: number } {
  const d = new Date(at);
  const q = Math.floor(d.getUTCMonth() / 3);
  return { id: `${d.getUTCFullYear()}Q${q + 1}`, start: Date.UTC(d.getUTCFullYear(), q * 3, 1), end: Date.UTC(d.getUTCFullYear(), q * 3 + 3, 1) };
}

export interface Season {
  id: string;
  startsAt: number;
  endsAt: number;
  gameVersion: string;
  rulesHash: string;
  frozenAt: number | null;
  digest: string | null;
}

/**
 * The season for a match starting `at` on build (gameVersion, rulesHash): the open season when it still covers both,
 * else a new one (D6): quarterly, or from now when a new build is deployed mid-quarter (`<quarter>.<n>`). Returns the
 * new season and the one it closes, if any.
 */
export function nextSeason(seasons: readonly Season[], at: number, gameVersion: string, rulesHash: string): { current: Season; closed?: Season } {
  const latest = [...seasons].sort((a, b) => a.startsAt - b.startsAt).at(-1);
  if (latest && at >= latest.startsAt && at < latest.endsAt && latest.gameVersion === gameVersion && latest.rulesHash === rulesHash) return { current: latest };
  const quarter = quarterOf(at);
  const sameQuarter = seasons.filter((s) => s.id === quarter.id || s.id.startsWith(`${quarter.id}.`)).length;
  const current: Season = { id: sameQuarter ? `${quarter.id}.${sameQuarter + 1}` : quarter.id, startsAt: latest && latest.endsAt > at ? at : Math.max(quarter.start, latest?.endsAt ?? quarter.start), endsAt: quarter.end, gameVersion, rulesHash, frozenAt: null, digest: null };
  return latest && latest.frozenAt === null ? { current, closed: { ...latest, endsAt: Math.min(latest.endsAt, current.startsAt) } } : { current };
}

/** The season a match belongs to: the one covering its start on its build. */
export function seasonOfEntry(seasons: readonly Season[], entry: Pick<CommanderLogEntry, 'startedAt' | 'gameVersion'>): Season | undefined {
  return seasons.find((s) => entry.startedAt >= s.startsAt && entry.startedAt < s.endsAt && s.gameVersion === entry.gameVersion);
}

/**
 * Nightly integrity signals (§7.3) over rated entries: each returns flags for maintainer review, never a verdict.
 */
export interface IntegrityFlag {
  kind: 'early_forfeit' | 'idle_loser' | 'idle_policy' | 'shared_artifact' | 'pair_imbalance' | 'rating_velocity' | 'switch_before_loss' | 'queue_correlation';
  subject: Record<string, string | number>;
  detail: Record<string, string | number>;
}

/** Two-sided exact binomial tail probability of `k` of `n` at p = 1/2. */
export function binomialTail(k: number, n: number): number {
  let tail = 0;
  const extreme = Math.max(k, n - k);
  for (let i = extreme; i <= n; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1);
    tail += c / 2 ** n;
  }
  return Math.min(1, 2 * tail);
}

export function integritySignals(entries: readonly CommanderLogEntry[], events: readonly RatingEvent[], joins: readonly { subject: string; at: number }[] = []): IntegrityFlag[] {
  const flags: IntegrityFlag[] = [];
  const byMatch = new Map<string, CommanderLogEntry[]>();
  for (const e of entries) byMatch.set(e.matchId, [...byMatch.get(e.matchId) ?? [], e]);
  const pairs = new Map<string, { a: string; b: string; aWins: number; games: number }>();
  for (const [matchId, list] of byMatch) {
    for (const e of list) {
      const accepted = Object.values(e.acceptedIntents).reduce((n, v) => n + v, 0);
      if ((e.disposition === 'forfeit' || e.disposition === 'abandoned') && e.ticks < LADDER.minTicks) flags.push({ kind: 'early_forfeit', subject: { matchId, commander: e.commander }, detail: { ticks: e.ticks } });
      if (e.outcome === 'loss' && accepted < Math.max(1, Math.floor(e.ticks / (LADDER.activityTicks * 6)))) flags.push({ kind: 'idle_loser', subject: { matchId, commander: e.commander }, detail: { accepted, ticks: e.ticks } });
      if (e.kind === 'policy' && accepted === 0 && e.ticks > 0) flags.push({ kind: 'idle_policy', subject: { matchId, commander: e.commander }, detail: { ticks: e.ticks } });
    }
    const teams = [...new Set(list.map((e) => e.team))];
    const artifacts = new Map<string, string>();
    for (const e of list) for (const p of e.policies) {
      const team = artifacts.get(p.artifactHash);
      if (team !== undefined && team !== e.team) flags.push({ kind: 'shared_artifact', subject: { matchId, artifact: p.artifactHash.slice(0, 12) }, detail: { teams: teams.length } });
      artifacts.set(p.artifactHash, e.team);
    }
    if (teams.length === 2) {
      const [x, y] = [...teams].sort();
      const a = list.find((e) => e.team === x)!, b = list.find((e) => e.team === y)!;
      const key = [a.commander, b.commander].sort().join('|');
      const pair = pairs.get(key) ?? { a: [a.commander, b.commander].sort()[0]!, b: [a.commander, b.commander].sort()[1]!, aWins: 0, games: 0 };
      const first = a.commander === pair.a ? a : b;
      pair.games++;
      if (first.outcome === 'win') pair.aWins++;
      pairs.set(key, pair);
    }
    for (const e of list) {
      const switched = e.policySwitches.length > 1 && e.outcome === 'loss' && e.policySwitches.at(-1)!.tick > e.ticks * 0.9;
      if (switched) flags.push({ kind: 'switch_before_loss', subject: { matchId, commander: e.commander }, detail: { switches: e.policySwitches.length } });
    }
  }
  for (const pair of pairs.values()) {
    if (pair.games >= 6 && binomialTail(pair.aWins, pair.games) < 0.01) flags.push({ kind: 'pair_imbalance', subject: { a: pair.a, b: pair.b }, detail: { games: pair.games, aWins: pair.aWins } });
  }
  const bySegment = new Map<string, RatingEvent[]>();
  for (const ev of events) bySegment.set(ev.segmentId, [...bySegment.get(ev.segmentId) ?? [], ev]);
  for (const [segment, list] of bySegment) {
    const gain = list.reduce((n, ev) => n + (ev.after.mu - ev.before.mu), 0);
    const opponents = new Set(list.map((ev) => ev.matchId)).size;
    if (list.length >= 5 && gain > 3 * LADDER.beta && opponents <= 2) flags.push({ kind: 'rating_velocity', subject: { segment }, detail: { games: list.length, gain: Math.round(gain * 100) / 100 } });
  }
  // Accounts joining the queue within a second of each other again and again.
  const sorted = [...joins].sort((a, b) => a.at - b.at);
  const together = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j]!.at - sorted[i]!.at <= 1000; j++) {
    if (sorted[i]!.subject === sorted[j]!.subject) continue;
    const key = [sorted[i]!.subject, sorted[j]!.subject].sort().join('|');
    together.set(key, (together.get(key) ?? 0) + 1);
  }
  for (const [key, count] of together) if (count >= 5) {
    const [a, b] = key.split('|');
    flags.push({ kind: 'queue_correlation', subject: { a: a!, b: b! }, detail: { joins: count } });
  }
  return flags;
}
