/**
 * Rated queue and matchmaker (DESIGN §Ladder, D1/D3). An entrant is one owner's lineup of pool-kind commanders
 * covering every plane exactly once. The matchmaker alone picks opponents (by rating, with a band that widens with
 * waiting), the map from the season pool, sides and a server seed; it never pairs one owner or one account cluster
 * with itself and prefers fresh pairs. Matches use standard rules, no owner human seats and no owner control, and open
 * through the lobby's allocation path (`LobbyContext.open`). Lobby rooms never reach this path.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { MatchSpec } from 'playerthree/arena';
import type { SeatAssignment } from 'playerthree/host';
import { surfaceHash } from 'playerthree';
import { definition, lobbySummary, PLANES, type ArmyId, type Plane } from '@agent-command/game';
import { lobbyMode, MAPS } from '@agent-command/game/lobby';
import { arenaMapIdentity } from '@agent-command/game/arena';
import type { RatedConfig, ServerConfig } from './config.ts';
import { HttpError } from './http.ts';
import { kindOf, POOLS, QUEUE_OF, shapeOf, type Pool, type RatedMatchRecord } from './ladder.ts';
import { matchSides, resolveLobbyMap, type LobbyContext, type LobbyMatch } from './lobby.ts';
import { featuredMatchup, PUBLIC_OBSERVER_DELAY_MS, type FeaturedSeat, type PublicGame } from './featured.ts';
import type { GameHost } from './room.ts';

/** Matchmaking rules: the rating band in ladder units (40 × μ) and how it widens per second of waiting. */
export const MATCHMAKING = { band: 100, bandPerSecond: 10, maxBand: 4000, tickMs: 1000, maxRatedCommandersPerPool: 3, maxClusterQueued: 2 } as const;

export interface QueueLineup { commanderId: string; roles: Plane[] }

interface QueueEntry {
  id: string;
  profile: string;
  cluster: string;
  pool: Pool;
  lineup: QueueLineup[];
  /** 40 × mean μ of the lineup's segments in the current season. */
  skill: number;
  joinedAt: number;
}

interface Found {
  id: string;
  pool: Pool;
  entrants: QueueEntry[];
  state: 'ready_check' | 'opening' | 'holding' | 'playing';
  deadline: number;
  record?: RatedMatchRecord;
  game?: LobbyMatch;
  /** Wall clock (ms) play began (`playing`): the featured relay shows the newest public game. */
  startedAt?: number;
  /** Lanes reserved for the live agents' ready check: `${owner}\n${commander}\n${role}`. */
  lanes: { owner: string; id: string; role: Plane; team: ArmyId }[];
}

export interface QueueStatus {
  queued: { pool: Pool; since: number; waiting: number } | null;
  match: { state: Found['state']; roomId: string | null; matchId: string | null } | null;
  lockedUntil: number | null;
}

export interface MatchmakerDeps {
  config: ServerConfig;
  rated: RatedConfig;
  host: GameHost;
  open: LobbyContext['open'];
  accepting(): boolean;
  eligible(profile: string): Promise<boolean>;
  cluster(profile: string): Promise<string>;
  noteIp(profile: string, ip: string): Promise<void>;
  /** 40 × mean μ of these commanders' segments in the pool (fresh: 40 × μ₀). */
  skill(pool: Pool, profile: string, commanderIds: readonly string[]): number;
  /** Distinct commanders this owner already has ratings for in the pool. */
  ratedCommanders(pool: Pool, profile: string): Promise<string[]>;
  /** Rated games between two clusters within the repeat window. */
  pairGames(a: string, b: string, now: number): Promise<number>;
  events: { add(subject: string, kind: 'join' | 'match' | 'dodge', at: number): Promise<void>; count(subject: string, kind: 'join' | 'match' | 'dodge', since: number): Promise<number>; last(subject: string, kind: 'join' | 'match' | 'dodge'): Promise<number | null> };
  season(now: number): Promise<{ id: string }>;
  opened(record: RatedMatchRecord): Promise<void>;
}

/** Season map pool: `RATED_MAPS`, else every supported layout of the authored maps for the shape. */
export function seasonMaps(rated: RatedConfig, shape: 'duel' | 'ffa'): { map: string; layout: string }[] {
  const pool = rated.maps ?? MAPS.filter((m) => m.tags.includes('authored')).flatMap((m) => m.layouts.filter((l) => l.supported).map((l) => ({ map: m.id, layout: l.id })));
  return pool.filter(({ map, layout }) => {
    const mode = lobbyMode(map, layout);
    return !!mode?.supported && (shape === 'duel' ? mode.id === '1v1' : mode.id === 'ffa' && mode.sides.length === 4);
  });
}

export class Matchmaker {
  readonly #deps: MatchmakerDeps;
  readonly #queue = new Map<Pool, QueueEntry[]>(POOLS.map((pool) => [pool, []]));
  readonly #found = new Map<string, Found>();
  readonly #timer: NodeJS.Timeout;
  #busy = false;

  constructor(deps: MatchmakerDeps) {
    this.#deps = deps;
    this.#timer = setInterval(() => void this.tick(), MATCHMAKING.tickMs);
    this.#timer.unref();
  }

  /** A queued or matched owner (one queue entry per account). */
  #entryOf(profile: string): QueueEntry | undefined {
    for (const list of this.#queue.values()) { const e = list.find((x) => x.profile === profile); if (e) return e; }
    return undefined;
  }
  #foundOf(profile: string): Found | undefined {
    return [...this.#found.values()].find((f) => f.entrants.some((e) => e.profile === profile));
  }

  /** Whether this owner's commander sits in, or is held for, a rated match (coaching and settings are off there). */
  holds(owner: string, commanderId: string): boolean {
    return [...this.#found.values()].some((f) => f.entrants.some((e) => e.profile === owner && e.lineup.some((l) => l.commanderId === commanderId)));
  }

  isRatedMatch(matchId: string): boolean {
    return [...this.#found.values()].some((f) => f.record?.matchId === matchId);
  }

  /**
   * Rated matches in play, for Watch live: per-army views only (`allowOmniscient: false`) at the public observer
   * delay. Seats show each commander's public seat card, never its owner or name.
   */
  featuredGames(): PublicGame[] {
    const games: PublicGame[] = [];
    for (const found of this.#found.values()) {
      const { game, record, startedAt } = found;
      if (found.state !== 'playing' || !game || !record || startedAt === undefined || game.match.over) continue;
      const cards = game.match.cards();
      const armies = record.armies.map((army) => army.id);
      const seats: FeaturedSeat[] = armies.flatMap((team) => PLANES.map((role): FeaturedSeat => {
        const card = cards.find((entry) => entry.seat.team === team && entry.seat.role === role);
        return { team, role, kind: card?.kind ?? kindOf(record.pool), name: card?.harness?.label ?? 'AI Player' };
      }));
      games.push({
        roomId: game.roomId, startedAt, delayMs: PUBLIC_OBSERVER_DELAY_MS, omniscient: false, armies, seats, game,
        label: `Ranked · ${featuredMatchup(armies, seats)} · ${lobbyMode(record.map.map, record.map.layout)?.label ?? record.map.map}`,
        played: (owner) => {
          const sides = record.sides.filter((side) => side.owner === owner).map((side) => side.team as ArmyId);
          return sides.length ? sides : undefined;
        },
      });
    }
    return games;
  }

  async #lockedUntil(profile: string, now: number): Promise<number | null> {
    const { count, windowMs, lockMs } = this.#deps.rated.dodges;
    if (await this.#deps.events.count(profile, 'dodge', now - windowMs) < count) return null;
    const last = await this.#deps.events.last(profile, 'dodge');
    return last !== null && last + lockMs > now ? last + lockMs : null;
  }

  async status(profile: string): Promise<QueueStatus> {
    const entry = this.#entryOf(profile);
    const found = this.#foundOf(profile);
    return {
      queued: entry ? { pool: entry.pool, since: entry.joinedAt, waiting: this.#queue.get(entry.pool)!.length } : null,
      match: found ? { state: found.state, roomId: found.game?.roomId ?? null, matchId: found.record?.matchId ?? null } : null,
      lockedUntil: await this.#lockedUntil(profile, Date.now()),
    };
  }

  /** Validate an owner's lineup for a pool (§5): one owner, every plane once, the pool's kind, compatible roles. */
  #lineup(profile: string, pool: Pool, raw: unknown): QueueLineup[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > PLANES.length) throw new HttpError(400, 'bad_lineup');
    const roster = this.#deps.host.commanders.has(profile) ? this.#deps.host.commanders.roster(profile) : [];
    const kind = kindOf(pool);
    const covered = new Set<string>();
    const ids = new Set<string>();
    const lineup = raw.map((item): QueueLineup => {
      if (!item || typeof item !== 'object' || Object.keys(item).some((k) => k !== 'commanderId' && k !== 'roles')) throw new HttpError(400, 'bad_lineup');
      const { commanderId, roles } = item as Record<string, unknown>;
      if (typeof commanderId !== 'string' || !Array.isArray(roles) || roles.length < 1 || ids.has(commanderId)) throw new HttpError(400, 'bad_lineup');
      ids.add(commanderId);
      const commander = roster.find((c) => c.id === commanderId);
      if (!commander) throw new HttpError(403, 'not_owner');
      if (commander.kind !== kind) throw new HttpError(400, 'mixed_kind');
      for (const role of roles) {
        if (typeof role !== 'string' || !(PLANES as readonly string[]).includes(role) || !commander.roles.includes(role)) throw new HttpError(400, 'incompatible_role');
        if (covered.has(role)) throw new HttpError(400, 'planes_overlap');
        covered.add(role);
        if (kind === 'policy' && commander.policy.activeByRole[role] == null) throw new HttpError(400, 'no_policy');
      }
      if (commander.seated) throw new HttpError(409, 'busy');
      return { commanderId, roles: roles as Plane[] };
    });
    if (covered.size !== PLANES.length) throw new HttpError(400, 'planes_incomplete');
    return lineup;
  }

  async join(profile: string, body: unknown, ip: string): Promise<QueueStatus> {
    if (!this.#deps.accepting()) throw new HttpError(503, 'server_updating');
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'pool' && k !== 'lineup')) throw new HttpError(400, 'bad_request');
    const { pool, lineup: rawLineup } = body as Record<string, unknown>;
    if (!POOLS.includes(pool as Pool)) throw new HttpError(400, 'bad_pool');
    const now = Date.now();
    if (!await this.#deps.eligible(profile)) throw new HttpError(403, 'account_required');
    const locked = await this.#lockedUntil(profile, now);
    if (locked !== null) throw new HttpError(429, 'dodge_locked', String(locked));
    const lastJoin = await this.#deps.events.last(profile, 'join');
    if (lastJoin !== null && now - lastJoin < this.#deps.rated.queueJoinMs) throw new HttpError(429, 'rate_limited');
    if (await this.#deps.events.count(profile, 'match', now - 86_400_000) >= this.#deps.rated.matchesPerDay) throw new HttpError(429, 'daily_limit');
    if (this.#entryOf(profile) || this.#foundOf(profile)) throw new HttpError(409, 'already_queued');
    const lineup = this.#lineup(profile, pool as Pool, rawLineup);
    const known = new Set(await this.#deps.ratedCommanders(pool as Pool, profile));
    for (const l of lineup) known.add(l.commanderId);
    if (known.size > MATCHMAKING.maxRatedCommandersPerPool) throw new HttpError(409, 'commander_limit');
    await this.#deps.noteIp(profile, ip);
    const cluster = await this.#deps.cluster(profile);
    const queue = this.#queue.get(pool as Pool)!;
    if (queue.filter((e) => e.cluster === cluster).length >= MATCHMAKING.maxClusterQueued) throw new HttpError(409, 'cluster_busy');
    await this.#deps.events.add(profile, 'join', now);
    queue.push({ id: randomUUID(), profile, cluster, pool: pool as Pool, lineup, skill: this.#deps.skill(pool as Pool, profile, lineup.map((l) => l.commanderId)), joinedAt: now });
    return this.status(profile);
  }

  leave(profile: string): void {
    for (const list of this.#queue.values()) {
      const i = list.findIndex((e) => e.profile === profile);
      if (i >= 0) list.splice(i, 1);
    }
  }

  /** Pair the queues, run ready checks, open and start found matches. Serialized: one pass at a time. */
  async tick(now = Date.now()): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (const pool of POOLS) for (const group of await this.#pair(pool, now)) await this.#found_(pool, group, now);
      for (const found of [...this.#found.values()]) await this.#advance(found, Date.now());
    } catch (error) {
      console.error('matchmaker: pass failed', error instanceof Error ? error.message : error);
    } finally {
      this.#busy = false;
    }
  }

  async #pair(pool: Pool, now: number): Promise<QueueEntry[][]> {
    const queue = this.#queue.get(pool)!;
    const size = shapeOf(pool) === 'duel' ? 2 : 4;
    const band = (e: QueueEntry) => Math.min(MATCHMAKING.maxBand, MATCHMAKING.band + MATCHMAKING.bandPerSecond * (now - e.joinedAt) / 1000);
    const groups: QueueEntry[][] = [];
    const taken = new Set<string>();
    for (const first of [...queue].sort((a, b) => a.joinedAt - b.joinedAt)) {
      if (taken.has(first.id)) continue;
      const group = [first];
      // Fresh pairs first, then the closest ratings.
      const candidates: { e: QueueEntry; games: number; gap: number }[] = [];
      for (const e of queue) {
        if (e === first || taken.has(e.id) || e.profile === first.profile || e.cluster === first.cluster) continue;
        const gap = Math.abs(e.skill - first.skill);
        if (gap > Math.max(band(first), band(e))) continue;
        candidates.push({ e, games: await this.#deps.pairGames(first.cluster, e.cluster, now), gap });
      }
      candidates.sort((a, b) => a.games - b.games || a.gap - b.gap);
      for (const { e } of candidates) {
        if (group.length === size) break;
        if (group.some((g) => g.profile === e.profile || g.cluster === e.cluster)) continue;
        group.push(e);
      }
      if (group.length < size) continue;
      for (const g of group) taken.add(g.id);
      groups.push(group);
    }
    if (taken.size) this.#queue.set(pool, queue.filter((e) => !taken.has(e.id)));
    return groups;
  }

  /** A found match: live pools hold a ready check on the reserved lanes first; policy pools open at once. */
  async #found_(pool: Pool, entrants: QueueEntry[], now: number): Promise<void> {
    const maps = seasonMaps(this.#deps.rated, shapeOf(pool));
    if (!maps.length) throw new Error(`no season map for ${pool}`);
    const pick = maps[randomInt(maps.length)]!;
    const mode = lobbyMode(pick.map, pick.layout)!;
    // Sides at random: entrant k takes a shuffled army.
    const armies: ArmyId[] = mode.sides.map((s) => s.id);
    for (let i = armies.length - 1; i > 0; i--) { const j = randomInt(i + 1); [armies[i], armies[j]] = [armies[j]!, armies[i]!]; }
    const found: Found = { id: randomUUID(), pool, entrants, state: 'ready_check', deadline: now + this.#deps.rated.readyMs, lanes: [] };
    entrants.forEach((entrant, k) => {
      for (const l of entrant.lineup) for (const role of l.roles) found.lanes.push({ owner: entrant.profile, id: l.commanderId, role, team: armies[k]! });
    });
    const record = await this.#record(found, pick, mode.sides.filter((s) => armies.slice(0, entrants.length).includes(s.id)).map((s) => ({ id: s.id, alliance: s.alliance })), now);
    found.record = record;
    this.#found.set(found.id, found);
    for (const entrant of entrants) await this.#deps.events.add(entrant.profile, 'match', now);
    if (kindOf(pool) === 'agent') {
      const start = { kind: 'ready' as const, at: found.deadline };
      for (const lane of found.lanes) {
        try { this.#deps.host.commanders.reserve(lane.owner, lane.id, lane.role, { team: lane.team, match: this.#summary(record), start }); }
        catch { /* A removed commander fails the ready check. */ }
      }
    } else found.state = 'opening';
  }

  #summary(record: RatedMatchRecord): unknown {
    const rules = resolveLobbyMap(record.map.map, record.map.layout, record.mapSeed, this.#size(record)).rules;
    return lobbySummary({ mapId: record.map.map, layoutId: record.map.layout, size: this.#size(record), sides: record.armies, rules });
  }
  #size(record: RatedMatchRecord): number { return MAPS.find((m) => m.id === record.map.map)!.size; }

  async #record(found: Found, pick: { map: string; layout: string }, armies: RatedMatchRecord['armies'], now: number): Promise<RatedMatchRecord> {
    const map = MAPS.find((m) => m.id === pick.map)!;
    const mapSeed = map.mapSeed ?? randomInt(2 ** 32);
    const resolved = resolveLobbyMap(pick.map, pick.layout, mapSeed, map.size);
    const season = await this.#deps.season(now);
    const sides = await Promise.all(found.entrants.map(async (entrant, k) => ({
      team: armies[k]!.id, owner: entrant.profile, cluster: entrant.cluster, eligible: await this.#deps.eligible(entrant.profile), commanders: entrant.lineup.map((l) => l.commanderId),
    })));
    let repeat = 1;
    for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) repeat = Math.max(repeat, 1 + await this.#deps.pairGames(sides[i]!.cluster, sides[j]!.cluster, now));
    return { matchId: '', pool: found.pool, season: season.id, createdAt: now, rulesHash: resolved.rulesHash, map: pick, mapSeed, armies, sides, repeat };
  }

  /** The frozen ranked spec of a found match: standard rules, no coaching, the matchmaker's seed and sides. */
  rankedSpec(record: RatedMatchRecord): MatchSpec {
    const mapSeed = record.mapSeed;
    const resolved = resolveLobbyMap(record.map.map, record.map.layout, mapSeed, this.#size(record));
    return {
      format: 'playerthree.match', version: 1, game: definition.manifest.id, gameVersion: definition.manifest.version, surfaceHash: surfaceHash(definition.manifest),
      rulesHash: resolved.rulesHash, seed: mapSeed,
      map: { id: record.map.map, identity: arenaMapIdentity(record.map.map, mapSeed, resolved.rules), seed: mapSeed, layout: record.map.layout },
      options: { ...resolved.options },
      sides: record.armies.map((army) => {
        const side = record.sides.find((s) => s.team === army.id)!;
        return { id: army.id, spawnSlot: army.id, alliance: army.alliance, seats: PLANES.map((role) => {
          const id = this.#foundByRecord(record)?.entrants.find((e) => e.profile === side.owner)?.lineup.find((l) => l.roles.includes(role))?.commanderId ?? '';
          return { role, occupant: { kind: 'commander' as const, ref: { id, kind: kindOf(record.pool) } } };
        }) };
      }),
      bindings: record.sides.flatMap((side, index) => PLANES.map((role) => ({ seat: { team: side.team, role }, entrantId: `entrant-${index}` }))),
      observerPolicy: { allowOmniscient: false, minDelayMs: PUBLIC_OBSERVER_DELAY_MS },
      rules: { ranked: true, coaching: 'off', practiceReasons: [] },
    };
  }
  #foundByRecord(record: RatedMatchRecord): Found | undefined { return [...this.#found.values()].find((f) => f.record === record); }

  async #advance(found: Found, now: number): Promise<void> {
    const host = this.#deps.host;
    if (found.state === 'ready_check') {
      const ready = (lane: Found['lanes'][number]) => host.commanders.has(lane.owner) && !!host.commanders.roster(lane.owner).find((c) => c.id === lane.id)?.reservations.some((r) => r.team === lane.team && r.role === lane.role && r.ready);
      if (found.lanes.every(ready)) { found.state = 'opening'; }
      else if (now >= found.deadline) {
        // Not ready in time: a dodge for each entrant that left a lane unready; the others go back to the queue.
        this.#release(found);
        this.#found.delete(found.id);
        for (const entrant of found.entrants) {
          if (found.lanes.some((lane) => lane.owner === entrant.profile && !ready(lane))) await this.#deps.events.add(entrant.profile, 'dodge', now);
          else this.#queue.get(found.pool)!.push({ ...entrant, id: randomUUID() });
        }
        return;
      } else return;
    }
    if (found.state === 'opening') {
      found.state = 'holding';
      found.deadline = now + this.#deps.rated.readyMs;
      try { found.game = await this.#open(found); }
      catch (error) {
        console.error('matchmaker: open failed', error instanceof Error ? error.message : error);
        this.#release(found);
        this.#found.delete(found.id);
        return;
      }
      return;
    }
    const game = found.game!;
    if (found.state === 'holding') {
      const seats = game.match.readiness().seats;
      if (seats.every((s) => s.state === 'ready') || now >= found.deadline) {
        found.state = 'playing';
        found.startedAt = now;
        this.#release(found);
        await game.start();
        // A no-show after the match was created is an abandon: that army is out (a loss).
        for (const team of new Set(seats.filter((s) => s.state === 'absent' || s.state === 'policy_failed' || s.state === 'stale_policy').map((s) => s.team))) await game.match.forfeit(team as never, { abandoned: true });
      }
      return;
    }
    if (game.match.over) this.#found.delete(found.id);
  }

  #release(found: Found): void {
    for (const lane of found.lanes) {
      try { this.#deps.host.commanders.reserve(lane.owner, lane.id, lane.role, null); } catch { /* Gone: nothing reserved. */ }
    }
  }

  async #open(found: Found): Promise<LobbyMatch> {
    const record = found.record!;
    const spec = this.rankedSpec(record);
    // Exact commander seats, no owner human control: coaching is off by construction.
    const assignments: SeatAssignment[] = spec.sides.flatMap((side) => side.seats.flatMap((seat) => {
      const owner = record.sides.find((s) => s.team === side.id)!.owner;
      if (seat.occupant.kind !== 'commander') return [];
      const ref = seat.occupant.ref;
      const commander = this.#deps.host.commanders.roster(owner).find((c) => c.id === ref.id);
      const version = ref.kind === 'policy' ? commander?.policy.activeByRole[seat.role] ?? undefined : undefined;
      return [{ team: side.id, role: seat.role, owner, kind: ref.kind, commander: { id: ref.id }, ...(version != null ? { policy: { version } } : {}) }];
    }));
    const sides = record.armies;
    const game = await this.#deps.open(`rated:${found.id}`, assignments, spec.options as never, () => {}, () => this.#found.has(found.id), {
      identity: `rated:${found.id}`, speed: 1, ...matchSides(sides), lobby: this.#summary(record),
      observerPolicy: { allowOmniscient: false, minDelayMs: PUBLIC_OBSERVER_DELAY_MS, public: false }, botSeats: [],
      log: { mode: shapeOf(record.pool) === 'duel' ? (sides.length === 2 && MAPS.find((m) => m.id === record.map.map)!.sides === 4 ? 'duel_c4' : 'duel_1v1') : 'ffa', queue: QUEUE_OF[record.pool], rulesHash: spec.rulesHash, customRules: false,
        map: { id: spec.map.id, identity: spec.map.identity, seed: spec.map.seed, size: this.#size(record), layout: spec.map.layout } },
    });
    if (!game.localMatch) { await game.close(); throw new Error('rated matches need the canonical host'); }
    record.matchId = game.localMatch.id;
    await this.#deps.opened(record);
    return game;
  }

  close(): void {
    clearInterval(this.#timer);
    for (const found of this.#found.values()) this.#release(found);
    this.#found.clear();
    for (const list of this.#queue.values()) list.length = 0;
  }
}
