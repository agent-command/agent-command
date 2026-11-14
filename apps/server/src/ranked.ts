/**
 * Rated play on the official host (DESIGN §Ladder): the commander-log verdict, the rated queue, the ladder's
 * incremental and nightly state, seasons, integrity flags, the 180-day replay keep-set, opt-in public cards, the
 * leaderboard and the published results keys. Without `RATED=on` + `RESULTS_SIGNING_KEY` (every self-hosted server)
 * only the verdict runs (entries stay unofficial and unrated) and every rated route answers 404.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalJson } from 'playerthree';
import { commanderPublicId, effectiveVerdict, compareLogEntries, type CommanderLogEntry, type CommanderLogVerdict, type CommanderLogVerdictRow, type StoredCommanderLogEntry } from 'playerthree/results';
import type { CommanderLogContext, SessionRecord } from 'playerthree/host';
import type { PostgresStorage } from 'playerthree/postgres';
import { definition, resolveRules } from '@agent-command/game';
import { arenaRulesHash } from '@agent-command/game/arena';
import type { Accounts } from './accounts.ts';
import type { ServerConfig } from './config.ts';
import { clientIp, HttpError, originAllowed, PAGE_CSP, readJson, sendJson } from './http.ts';
import { decayed, integritySignals, LADDER, ladderPoints, LadderState, nextSeason, POOL_OF_QUEUE, POOLS, provisional, ratingKey, seasonOfEntry, segmentId, shapeOf, verdictFor, type LadderRating, type Pool, type RatedMatchRecord, type RatingEvent, type Season } from './ladder.ts';
import { Matchmaker } from './matchmaker.ts';
import type { LobbyContext } from './lobby.ts';
import type { GameHost } from './room.ts';
import { createLadderRenderer } from './ladder-document.ts';
import type { CardMatch, CardRating, CommanderCard, LadderPage, LeaderboardRow } from '../../web/src/ladder/model.ts';
import { cardPath } from '../../web/src/ladder/model.ts';
import type { Gauntlet } from './gauntlet.ts';

const BODY_BYTES = 2048;
const RECENT = 20;
const NIGHTLY_MS = 24 * 3_600_000;
const VOID_POLL_MS = 60_000;
const DEFAULT_RULES_HASH = arenaRulesHash(resolveRules(undefined));
const RANKED_PAGE = /^\/(?:commanders\/[A-Za-z0-9_-]{4,64}(?:\/log\.json)?|leaderboard\/?)$/;

export interface RankedService {
  /** The commander-log verdict hook (every host, rated or not). */
  verdict(ctx: CommanderLogContext): Promise<CommanderLogVerdict>;
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** The owner's commander is held for or seated in a rated match: coaching and settings are refused (§5). */
  holds(owner: string, commanderId: string): boolean;
  /** Count one declared-metadata edit (each starts a segment); 429 past the daily limit. */
  metadataEdit(owner: string, commanderId: string): Promise<void>;
  /** Public card paths for the sitemap (opted-in cards only). */
  paths(): Promise<string[]>;
  readonly matchmaker: Matchmaker | undefined;
  /** Nightly: recompute from the log (voids applied), integrity flags, retention. Also run when verdict rows change. */
  nightly(now?: number): Promise<void>;
  recompute(): Promise<{ changed: boolean }>;
  /** The in-memory incremental ladder (tests compare it with a recompute). */
  ratings(): Map<string, LadderRating>;
  /** Commits of rated entries applied so far (tests wait on it). */
  settled(): Promise<void>;
  ready: Promise<void>;
  close(): Promise<void>;
}

export interface RankedOptions {
  config: ServerConfig;
  storage?: PostgresStorage;
  host: GameHost;
  accounts?: Accounts;
  open: LobbyContext['open'];
  accepting(): boolean;
  profileOf(req: IncomingMessage): string | undefined;
  gauntlet?: () => Gauntlet | undefined;
  /** ACBench publications whose policy artifact matches one of these hashes. */
  acbench?(hashes: readonly string[]): Promise<{ id: string; revision: number; path: string } | null>;
}

interface CardRow { publicId: string; owner: string; commanderId: string; public: boolean; discloseModel: boolean }

type Db = PostgresStorage;
const ms = (column: string) => `(extract(epoch FROM ${column}) * 1000)::bigint`;
const ts = (index: number) => `to_timestamp($${index}::double precision / 1000)`;

export function createRankedService(opts: RankedOptions): RankedService {
  const { config, host } = opts;
  const rated = config.rated;
  const db: Db | undefined = rated ? opts.storage : undefined;
  if (rated && !opts.storage) throw new Error('RATED=on needs DATABASE_URL');
  const game = definition.manifest.id;
  const log = host.commanderLog;
  const records = new Map<string, RatedMatchRecord>();
  const pending = new Map<string, StoredCommanderLogEntry[]>();
  let seasons: Season[] = [];
  let state = new LadderState();
  let applying: Promise<void> = Promise.resolve();
  let verdictRows = -1;
  let closed = false;
  const renderer = rated ? createLadderRenderer(config.webDist) : undefined;
  const origin = config.publicUrl?.origin ?? 'https://agentcommand.gg';

  async function record(matchId: string): Promise<RatedMatchRecord | undefined> {
    const cached = records.get(matchId);
    if (cached || !db) return cached;
    const [row] = await db.query<{ record: RatedMatchRecord }>('SELECT record FROM ac_rated_matches WHERE match_id = $1', [matchId]);
    if (row) records.set(matchId, row.record);
    return row?.record;
  }

  const previous = (pool: Pool, season: string, segment: string): LadderRating | undefined => {
    const ordered = [...seasons].sort((a, b) => a.startsAt - b.startsAt);
    const index = ordered.findIndex((s) => s.id === season);
    return index > 0 ? state.ratings.get(ratingKey(pool, ordered[index - 1]!.id, segment)) : undefined;
  };

  async function verdictRowsFor(): Promise<CommanderLogVerdictRow[]> { return log.verdicts(); }

  /** Apply one complete rated match to a ladder state. */
  async function applyTo(target: LadderState, group: readonly StoredCommanderLogEntry[], rows: readonly CommanderLogVerdictRow[]): Promise<RatingEvent[]> {
    const first = group[0]!.entry;
    const season = seasonOfEntry(seasons, first);
    if (!season) return [];
    const rec = await record(first.matchId);
    const clusters = new Map((rec?.sides ?? []).map((s) => [s.team, s.cluster]));
    const before = target.events.length;
    target.apply(group.map((r) => ({ entry: r.entry, verdict: effectiveVerdict(r.entry, rows) })), season.id, clusters);
    return target.events.slice(before);
  }

  async function persist(changed: readonly RatingEvent[]): Promise<void> {
    if (!db) return;
    for (const ev of changed) {
      const r = state.ratings.get(ratingKey(ev.pool, ev.season, ev.segmentId))!;
      await db.query(
        `INSERT INTO ac_ratings (pool, season, segment_id, public_id, mu, sigma, games, opponents_distinct, last_played, record) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${ts(9)}, $10::jsonb)
         ON CONFLICT (pool, season, segment_id) DO UPDATE SET public_id = EXCLUDED.public_id, mu = EXCLUDED.mu, sigma = EXCLUDED.sigma, games = EXCLUDED.games, opponents_distinct = EXCLUDED.opponents_distinct, last_played = EXCLUDED.last_played, record = EXCLUDED.record`,
        [r.pool, r.season, r.segmentId, r.publicId, r.mu, r.sigma, r.games, r.opponents.length, r.lastPlayed, JSON.stringify({ wins: r.wins, losses: r.losses, draws: r.draws, placements: r.placements, opponents: r.opponents, artifacts: r.artifacts })]);
      await db.query(`INSERT INTO ac_rating_events (match_id, segment_id, pool, season, at, before, after, weight) VALUES ($1, $2, $3, $4, ${ts(5)}, $6::jsonb, $7::jsonb, $8) ON CONFLICT (match_id, segment_id) DO NOTHING`,
        [ev.matchId, ev.segmentId, ev.pool, ev.season, ev.at, JSON.stringify(ev.before), JSON.stringify(ev.after), ev.weight]);
    }
  }

  /** Incremental update at commit: once every commander of a rated match has its entry, apply the match. */
  function appended(row: StoredCommanderLogEntry): void {
    if (!rated || !row.entry.queue || !POOL_OF_QUEUE[row.entry.queue]) return;
    applying = applying.then(async () => {
      const rec = await record(row.entry.matchId);
      if (!rec) return;
      const list = [...pending.get(rec.matchId) ?? [], row];
      const expected = new Set(rec.sides.flatMap((s) => s.commanders)).size;
      if (list.length < expected) { pending.set(rec.matchId, list); return; }
      pending.delete(rec.matchId);
      list.sort((a, b) => compareLogEntries(a.entry, b.entry));
      await persist(await applyTo(state, list, await verdictRowsFor()));
    }).catch((error: unknown) => console.error('ladder: incremental update failed', error instanceof Error ? error.message : error));
  }

  async function recompute(): Promise<{ changed: boolean }> {
    await applying;
    const rows = await verdictRowsFor();
    verdictRows = rows.length;
    const all = (await log.all()).filter((r) => r.entry.queue && POOL_OF_QUEUE[r.entry.queue]);
    const fresh = new LadderState((pool, season, segment) => {
      const ordered = [...seasons].sort((a, b) => a.startsAt - b.startsAt);
      const index = ordered.findIndex((s) => s.id === season);
      return index > 0 ? fresh.ratings.get(ratingKey(pool, ordered[index - 1]!.id, segment)) : undefined;
    });
    const byMatch = new Map<string, StoredCommanderLogEntry[]>();
    for (const r of all) byMatch.set(r.entry.matchId, [...byMatch.get(r.entry.matchId) ?? [], r]);
    for (const group of [...byMatch.values()].sort((a, b) => compareLogEntries(a[0]!.entry, b[0]!.entry))) await applyTo(fresh, group, rows);
    const changed = canonicalJson([...fresh.ratings.entries()].sort()) !== canonicalJson([...state.ratings.entries()].sort());
    state = fresh;
    if (db) {
      await db.query('DELETE FROM ac_rating_events');
      await db.query('DELETE FROM ac_ratings');
      await persist(fresh.events);
    }
    return { changed };
  }

  async function ensureSeason(now: number): Promise<Season> {
    const { current, closed: done } = nextSeason(seasons, now, definition.manifest.version, DEFAULT_RULES_HASH);
    if (done && db) {
      const standings = POOLS.map((pool) => ({ pool, rows: board(pool, done.id, done.endsAt).map(({ publicId, points, games }) => ({ publicId, points, games })) }));
      const digest = createHash('sha256').update(canonicalJson({ season: done.id, standings })).digest('hex');
      done.frozenAt = now;
      done.digest = digest;
      await db.query(`UPDATE ac_seasons SET ends_at = ${ts(2)}, frozen_at = ${ts(3)}, digest = $4, standings = $5::jsonb WHERE id = $1 AND frozen_at IS NULL`, [done.id, done.endsAt, now, digest, JSON.stringify(standings)]);
      seasons = seasons.map((s) => s.id === done.id ? done : s);
    }
    if (!seasons.some((s) => s.id === current.id)) {
      seasons.push(current);
      await db?.query(`INSERT INTO ac_seasons (id, starts_at, ends_at, game_version, rules_hash) VALUES ($1, ${ts(2)}, ${ts(3)}, $4, $5) ON CONFLICT (id) DO NOTHING`, [current.id, current.startsAt, current.endsAt, current.gameVersion, current.rulesHash]);
    }
    return current;
  }

  // ------------------------------------------------------------------ cards

  async function cards(): Promise<CardRow[]> {
    if (!db) return [];
    return (await db.query<{ public_id: string; owner: string; commander_id: string; public: boolean; disclose_model: boolean }>('SELECT public_id, owner, commander_id, public, disclose_model FROM ac_commander_cards'))
      .map((r) => ({ publicId: r.public_id, owner: r.owner, commanderId: r.commander_id, public: r.public, discloseModel: r.disclose_model }));
  }
  const nameOf = (row: CardRow): string | undefined => host.commanders.has(row.owner) ? host.commanders.roster(row.owner).find((c) => c.id === row.commanderId)?.name : undefined;

  /** The listed rows of a pool and season: opted in, not provisional, active within 60 days; one row per commander. */
  function board(pool: string, season: string, now: number, publicCards?: Map<string, CardRow>): LeaderboardRow[] {
    const best = new Map<string, LadderRating>();
    for (const r of state.ratings.values()) {
      if (r.pool !== pool || r.season !== season || provisional(r, now) || now - r.lastPlayed > LADDER.hiddenAfterMs) continue;
      if (publicCards && !publicCards.get(r.publicId)?.public) continue;
      const current = best.get(r.publicId);
      if (!current || r.lastPlayed > current.lastPlayed) best.set(r.publicId, r);
    }
    return [...best.values()].map((r): LeaderboardRow => {
      const sigma = decayed(r, now);
      const card = publicCards?.get(r.publicId);
      const commander = card && host.commanders.has(card.owner) ? host.commanders.roster(card.owner).find((c) => c.id === card.commanderId) : undefined;
      const placements = r.placements.reduce((n, v) => n + v, 0);
      return { publicId: r.publicId, name: commander?.name ?? r.publicId, kind: commander?.kind ?? 'policy', points: ladderPoints({ mu: r.mu, sigma }),
        band: [Math.round(LADDER.points * (r.mu - 2 * sigma)), Math.round(LADDER.points * (r.mu + 2 * sigma))], games: r.games,
        record: shapeOf(r.pool) === 'duel' ? { wins: r.wins, losses: r.losses, draws: r.draws } : null,
        meanRank: placements ? r.placements.reduce((n, v, i) => n + v * (i + 1), 0) / placements : null };
    }).sort((a, b) => b.points - a.points || (a.publicId < b.publicId ? -1 : 1));
  }

  async function cardOf(row: CardRow, now: number): Promise<CommanderCard | null> {
    const status = host.commanders.has(row.owner) ? host.commanders.roster(row.owner).find((c) => c.id === row.commanderId) : undefined;
    if (!status || !row.public) return null;
    const entries = await log.entries(row.commanderId);
    const rows = await verdictRowsFor();
    const publicCards = new Map((await cards()).map((c) => [c.publicId, c]));
    const segments = new Map<string, LadderRating[]>();
    for (const r of state.ratings.values()) if (r.publicId === row.publicId) segments.set(r.segmentId, [...segments.get(r.segmentId) ?? [], r]);
    const current = POOLS.map((pool) => segmentId(row.commanderId, pool, status.metadata ?? {}));
    const events = state.events.filter((ev) => segments.has(ev.segmentId));
    const ratings: CardRating[] = [...state.ratings.values()].filter((r) => r.publicId === row.publicId && current.includes(r.segmentId)).map((r) => {
      const sigma = decayed(r, now);
      const listed = board(r.pool, r.season, now, publicCards);
      const index = listed.findIndex((x) => x.publicId === row.publicId);
      const placements = r.placements.reduce((n, v) => n + v, 0);
      return {
        pool: r.pool, season: r.season, points: ladderPoints({ mu: r.mu, sigma }),
        band: [Math.round(LADDER.points * (r.mu - 2 * sigma)), Math.round(LADDER.points * (r.mu + 2 * sigma))],
        rank: index >= 0 ? index + 1 : null, percentile: index >= 0 ? Math.round(100 * (listed.length - index) / listed.length) : null,
        provisional: provisional(r, now), games: r.games,
        record: shapeOf(r.pool) === 'duel' ? { wins: r.wins, losses: r.losses, draws: r.draws } : null,
        placements: shapeOf(r.pool) === 'ffa' ? [...r.placements] : null,
        meanRank: placements ? r.placements.reduce((n, v, i) => n + v * (i + 1), 0) / placements : null,
        history: events.filter((ev) => ev.segmentId === r.segmentId && ev.pool === r.pool && ev.season === r.season).map((ev) => ({
          at: ev.at, points: ladderPoints(ev.after), low: Math.round(LADDER.points * (ev.after.mu - 2 * ev.after.sigma)), high: Math.round(LADDER.points * (ev.after.mu + 2 * ev.after.sigma)) })),
      };
    });
    const archived = [...segments].filter(([id]) => !current.includes(id)).map(([, list]) => {
      const last = list.sort((a, b) => b.lastPlayed - a.lastPlayed)[0]!;
      const first = events.filter((ev) => ev.segmentId === last.segmentId).at(0)?.at ?? last.lastPlayed;
      return { since: first, until: last.lastPlayed, points: ladderPoints(last), pool: last.pool };
    });
    const withVerdict = entries.map((r) => ({ ...r, verdict: effectiveVerdict(r.entry, rows) }));
    const ratedEntries = withVerdict.filter((r) => r.verdict.rated).sort((a, b) => b.entry.endedAt - a.entry.endedAt);
    const replays = db ? new Set((await db.query<{ match_id: string }>(`SELECT match_id FROM ac_rated_replays WHERE expires_at > ${ts(1)}`, [now])).map((r) => r.match_id)) : new Set<string>();
    const pointsNow = (publicId: string, pool: string): number | null => {
      const list = [...state.ratings.values()].filter((r) => r.publicId === publicId && r.pool === pool).sort((a, b) => b.lastPlayed - a.lastPlayed);
      return list[0] ? ladderPoints({ mu: list[0].mu, sigma: decayed(list[0], now) }) : null;
    };
    const recent: CardMatch[] = ratedEntries.slice(0, RECENT).map(({ entry: e, verdict: v }) => {
      const ev = state.events.find((x) => x.matchId === e.matchId && x.segmentId === v.segmentId);
      return {
        matchId: e.matchId, at: e.endedAt, pool: v.pool ?? '', map: e.map?.id ?? null,
        opponents: e.opponents.map((o) => {
          const id = o.seats.find((s) => s.commander)?.commander ?? null;
          const card = id ? publicCards.get(id) : undefined;
          const name = card?.public ? nameOf(card) ?? null : null;
          return { name, href: name && id ? cardPath(id) : null, points: id ? pointsNow(id, v.pool ?? '') : null };
        }),
        outcome: e.outcome, rank: e.rank, seconds: Math.round(e.simSeconds), delta: ev ? ladderPoints(ev.after) - ladderPoints(ev.before) : null,
        fallbackHeavy: v.badges.includes('fallback_heavy'), policies: e.policies.map((p) => ({ version: p.version, hash: p.artifactHash.slice(0, 12) })),
        replay: replays.has(e.matchId) ? `/api/ladder/replays/${encodeURIComponent(e.matchId)}` : null,
      };
    });
    const artifacts = new Map<string, Set<number>>();
    for (const { entry } of withVerdict) for (const p of entry.policies) artifacts.set(p.artifactHash, (artifacts.get(p.artifactHash) ?? new Set()).add(p.version));
    const latest = withVerdict.at(-1);
    const sealed = row.discloseModel ? entries.at(-1)?.sealed : undefined;
    const usage = row.discloseModel ? entries.reduce<{ decisions: number; inputTokens: number | null; outputTokens: number | null; coverage: string } | null>((sum, r) => {
      const u = r.sealed?.usage;
      if (!u) return sum;
      const add = (a: number | null | undefined, b: number | null) => a == null ? b : b === null ? a : a + b;
      return { decisions: (sum?.decisions ?? 0) + u.decisions, inputTokens: add(sum?.inputTokens, u.inputTokens), outputTokens: add(sum?.outputTokens, u.outputTokens), coverage: sum && sum.coverage !== u.coverage ? 'partial' : u.coverage };
    }, null) : null;
    const gauntlet = await opts.gauntlet?.()?.best(row.publicId);
    return {
      publicId: row.publicId, name: status.name, kind: status.kind, planes: [...status.roles],
      segmentSince: events.filter((ev) => current.includes(ev.segmentId)).at(0)?.at ?? null, archivedSegments: archived,
      ratings, gauntlet: gauntlet ?? null,
      unrated: {
        lobby: withVerdict.filter((r) => r.entry.queue === null).length,
        custom: withVerdict.filter((r) => r.verdict.reasons.includes('custom_rules')).length,
        bots: withVerdict.filter((r) => r.entry.queue !== 'gauntlet' && r.entry.opponents.some((o) => o.seats.some((s) => s.kind === 'bot'))).length,
      },
      recent, fallbackHeavy: ratedEntries.filter((r) => r.verdict.badges.includes('fallback_heavy')).length,
      verified: {
        executionKind: latest?.entry.executionKind ?? null,
        artifacts: [...artifacts].map(([hash, versions]) => ({ hash: hash.slice(0, 12), versions: [...versions].sort((a, b) => a - b) })),
        harness: latest?.entry.harness?.verified ? latest.entry.harness.label : null,
        acbench: await opts.acbench?.([...artifacts.keys()]) ?? null,
      },
      declared: sealed ? { ...sealed.declared } : null,
      selfReported: usage,
      host: { origin: latest?.entry.host.origin ?? origin, keyId: latest?.entry.host.keyId ?? rated?.signer.keyId ?? null },
    };
  }

  // ------------------------------------------------------------------ matchmaker

  const matchmaker = rated && db && opts.accounts ? new Matchmaker({
    config, rated, host, open: opts.open, accepting: opts.accepting,
    eligible: (profile) => opts.accounts!.eligible(profile),
    cluster: (profile) => opts.accounts!.clusterOf(profile),
    noteIp: (profile, ip) => opts.accounts!.noteIp(profile, ip),
    skill: (pool, _profile, ids) => {
      const mus = ids.map((id) => {
        const list = [...state.ratings.values()].filter((r) => r.pool === pool && r.publicId === commanderPublicId(game, id)).sort((a, b) => b.lastPlayed - a.lastPlayed);
        return list[0]?.mu ?? LADDER.mu;
      });
      return LADDER.points * mus.reduce((n, mu) => n + mu, 0) / Math.max(1, mus.length);
    },
    ratedCommanders: async (pool, profile) => [...new Set((await db.query<{ record: RatedMatchRecord }>('SELECT record FROM ac_rated_matches WHERE pool = $1', [pool]))
      .flatMap((r) => r.record.sides.filter((s) => s.owner === profile).flatMap((s) => s.commanders)))],
    pairGames: async (a, b, now) => (await db.query<{ record: RatedMatchRecord }>(`SELECT record FROM ac_rated_matches WHERE created_at > ${ts(1)}`, [now - LADDER.repeat.windowMs]))
      .filter((r) => r.record.sides.some((s) => s.cluster === a) && r.record.sides.some((s) => s.cluster === b)).length,
    events: {
      add: async (subject, kind, at) => { await db.query(`INSERT INTO ac_rated_events (subject, kind, at) VALUES ($1, $2, ${ts(3)})`, [subject, kind, at]); },
      count: async (subject, kind, since) => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ac_rated_events WHERE subject = $1 AND kind = $2 AND at > ${ts(3)}`, [subject, kind, since]))[0]?.n ?? 0),
      last: async (subject, kind) => { const [r] = await db.query<{ at: string | null }>(`SELECT ${ms('max(at)')} AS at FROM ac_rated_events WHERE subject = $1 AND kind = $2`, [subject, kind]); return r?.at == null ? null : Number(r.at); },
    },
    season: (now) => ensureSeason(now),
    opened: async (rec) => {
      records.set(rec.matchId, rec);
      await db.query(`INSERT INTO ac_rated_matches (match_id, pool, created_at, record) VALUES ($1, $2, ${ts(3)}, $4::jsonb)`, [rec.matchId, rec.pool, rec.createdAt, JSON.stringify(rec)]);
    },
  }) : undefined;

  // ------------------------------------------------------------------ retention, integrity

  async function nightly(now = Date.now()): Promise<void> {
    if (!rated || !db) return;
    await recompute();
    await ensureSeason(now);
    const since = now - LADDER.repeat.windowMs;
    const recentEntries = (await log.all()).filter((r) => r.entry.queue && POOL_OF_QUEUE[r.entry.queue] && r.entry.endedAt > since).map((r) => r.entry);
    const joins = (await db.query<{ subject: string; at: string }>(`SELECT subject, ${ms('at')} AS at FROM ac_rated_events WHERE kind = 'join' AND at > ${ts(1)}`, [since])).map((r) => ({ subject: r.subject, at: Number(r.at) }));
    for (const flag of integritySignals(recentEntries, state.events.filter((ev) => ev.at > since), joins)) {
      const id = createHash('sha256').update(canonicalJson([flag.kind, flag.subject])).digest('hex').slice(0, 32);
      await db.query(`INSERT INTO ac_integrity_flags (id, kind, subject, detail, created_at) VALUES ($1, $2, $3::jsonb, $4::jsonb, ${ts(5)}) ON CONFLICT (id) DO NOTHING`, [id, flag.kind, JSON.stringify(flag.subject), JSON.stringify(flag.detail), now]);
    }
    await db.query(`DELETE FROM ac_rated_replays WHERE expires_at <= ${ts(1)}`, [now]);
    await opts.accounts?.prune(now);
  }

  const unsubscribe = log.onAppend(appended);
  const unrecord = host.history.onRecord((session: SessionRecord) => {
    if (!db || !records.has(session.id)) return;
    void host.history.replay(session.id).then(async (replay) => {
      if (!replay) return;
      await db.query(`INSERT INTO ac_rated_replays (match_id, session, expires_at, replay) VALUES ($1, $2, ${ts(3)}, $4::json) ON CONFLICT (match_id) DO NOTHING`, [session.id, session.id, Date.now() + rated!.replayMs, JSON.stringify(replay)]);
    }).catch(() => console.error('ladder: replay keep failed'));
  });
  const timers: NodeJS.Timeout[] = [];
  const ready = (async () => {
    if (!rated || !db) return;
    seasons = (await db.query<{ id: string; starts: string; ends: string; game_version: string; rules_hash: string; frozen: string | null; digest: string | null }>(
      `SELECT id, ${ms('starts_at')} AS starts, ${ms('ends_at')} AS ends, game_version, rules_hash, ${ms('frozen_at')} AS frozen, digest FROM ac_seasons`)).map((r) => ({
      id: r.id, startsAt: Number(r.starts), endsAt: Number(r.ends), gameVersion: r.game_version, rulesHash: r.rules_hash, frozenAt: r.frozen === null ? null : Number(r.frozen), digest: r.digest }));
    state = new LadderState(previous);
    await recompute();
    timers.push(setInterval(() => void nightly().catch((e: unknown) => console.error('ladder: nightly job failed', e instanceof Error ? e.message : e)), NIGHTLY_MS));
    // Operator voids (verdict rows from the CLI) are applied by a recompute within a minute.
    timers.push(setInterval(() => void verdictRowsFor().then((rows) => rows.length !== verdictRows ? recompute() : undefined).catch(() => {}), VOID_POLL_MS));
    for (const t of timers) t.unref();
  })();
  ready.catch(() => console.error('ladder: failed to start'));

  // ------------------------------------------------------------------ routes

  async function page(res: ServerResponse, req: IncomingMessage, status: number, value: LadderPage): Promise<true> {
    const body = await renderer!(value);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.setHeader('Cache-Control', 'no-store');
    if (status === 200) res.removeHeader('X-Robots-Tag');
    res.writeHead(status).end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const ranked = path === '/api/queue' || path.startsWith('/api/ladder/') || path === '/.well-known/agent-command/results-keys.json' || RANKED_PAGE.test(path);
    if (!ranked) return false;
    if (!rated || !db) { sendJson(res, 404, { error: 'not_found' }); return true; }
    await ready;
    if (path === '/.well-known/agent-command/results-keys.json') {
      sendJson(res, 200, { format: 'agent-command.results-keys', version: 1, origin, keys: rated.keys }, { 'Cache-Control': 'public, max-age=300' });
      return true;
    }
    const now = Date.now();
    if (path === '/api/queue') {
      if (!originAllowed(req, config)) throw new HttpError(403, 'forbidden_origin');
      const profile = opts.profileOf(req);
      if (!profile) throw new HttpError(401, 'bad_profile');
      if (!matchmaker) throw new HttpError(503, 'queue_unavailable');
      if (req.method === 'GET') { sendJson(res, 200, await matchmaker.status(profile)); return true; }
      if (req.method === 'DELETE') { matchmaker.leave(profile); sendJson(res, 200, await matchmaker.status(profile)); return true; }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, DELETE' }); return true; }
      sendJson(res, 200, await matchmaker.join(profile, await readJson(req, BODY_BYTES), clientIp(req, config)));
      return true;
    }
    if (path === '/api/ladder/cards') {
      if (!originAllowed(req, config)) throw new HttpError(403, 'forbidden_origin');
      const profile = opts.profileOf(req);
      if (!profile) throw new HttpError(401, 'bad_profile');
      host.commanders.ensure(profile);
      const roster = host.commanders.roster(profile);
      if (req.method === 'POST') {
        const body = await readJson(req, BODY_BYTES);
        if (!body || typeof body !== 'object' || Object.keys(body).some((k) => !['commanderId', 'public', 'discloseModel'].includes(k))) throw new HttpError(400, 'bad_request');
        const { commanderId, public: open, discloseModel } = body as Record<string, unknown>;
        if (typeof commanderId !== 'string' || !roster.some((c) => c.id === commanderId) || typeof open !== 'boolean' || typeof discloseModel !== 'boolean') throw new HttpError(400, 'bad_request');
        await db.query(`INSERT INTO ac_commander_cards (public_id, owner, commander_id, public, disclose_model, updated_at) VALUES ($1, $2, $3, $4, $5, ${ts(6)})
          ON CONFLICT (public_id) DO UPDATE SET public = EXCLUDED.public, disclose_model = EXCLUDED.disclose_model, updated_at = EXCLUDED.updated_at`,
          [commanderPublicId(game, commanderId), profile, commanderId, open, open && discloseModel, now]);
      } else if (req.method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' }); return true; }
      const own = new Map((await cards()).filter((c) => c.owner === profile).map((c) => [c.commanderId, c]));
      sendJson(res, 200, { cards: roster.map((c) => {
        const publicId = commanderPublicId(game, c.id);
        const card = own.get(c.id);
        const current = POOLS.map((pool) => segmentId(c.id, pool, c.metadata ?? {}));
        const best = [...state.ratings.values()].filter((r) => current.includes(r.segmentId)).sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
        const sigma = best ? decayed(best, now) : 0;
        return { commanderId: c.id, publicId, public: card?.public ?? false, discloseModel: card?.discloseModel ?? false, href: cardPath(publicId),
          chip: best ? { pool: best.pool, points: ladderPoints({ mu: best.mu, sigma }), band: [Math.round(LADDER.points * (best.mu - 2 * sigma)), Math.round(LADDER.points * (best.mu + 2 * sigma))], provisional: provisional(best, now) } : null };
      }) }, { 'Cache-Control': 'no-store' });
      return true;
    }
    if (path === '/api/ladder/gauntlet') {
      if (!originAllowed(req, config)) throw new HttpError(403, 'forbidden_origin');
      const profile = opts.profileOf(req);
      if (!profile) throw new HttpError(401, 'bad_profile');
      const gauntlet = opts.gauntlet?.();
      if (!gauntlet) throw new HttpError(503, 'gauntlet_unavailable');
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' }); return true; }
      const body = await readJson(req, BODY_BYTES);
      if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'commanderId') || typeof (body as { commanderId?: unknown }).commanderId !== 'string') throw new HttpError(400, 'bad_request');
      sendJson(res, 201, await gauntlet.start(profile, (body as { commanderId: string }).commanderId, (await ensureSeason(now)).id));
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); return true; }
    const replay = /^\/api\/ladder\/replays\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (replay) {
      const [row] = await db.query<{ replay: unknown }>(`SELECT replay FROM ac_rated_replays WHERE match_id = $1 AND expires_at > ${ts(2)}`, [replay[1], now]);
      if (!row) throw new HttpError(404, 'not_found');
      sendJson(res, 200, row.replay, { 'Cache-Control': 'public, max-age=3600' });
      return true;
    }
    const publicCards = new Map((await cards()).map((c) => [c.publicId, c]));
    if (path === '/leaderboard' || path === '/leaderboard/' || path === '/api/ladder/leaderboard') {
      const pool = url.searchParams.get('pool') ?? 'policy_1v1';
      const current = (await ensureSeason(now)).id;
      const season = url.searchParams.get('season') ?? current;
      if (!POOLS.includes(pool as Pool) || !seasons.some((s) => s.id === season)) {
        if (path.startsWith('/api/')) throw new HttpError(400, 'bad_request');
        return page(res, req, 404, { kind: 'unavailable', title: 'Leaderboard unavailable', canonical: `${origin}/leaderboard`, card: null, leaderboard: null });
      }
      const frozen = seasons.find((s) => s.id === season && s.frozenAt !== null);
      const rows = board(pool, season, frozen ? frozen.endsAt : now, publicCards);
      const leaderboard = { pool, season, pools: [...POOLS], seasons: [...seasons].sort((a, b) => b.startsAt - a.startsAt).map((s) => s.id), rows };
      if (path.startsWith('/api/')) { sendJson(res, 200, leaderboard); return true; }
      return page(res, req, 200, { kind: 'leaderboard', title: 'Leaderboard', canonical: `${origin}/leaderboard?pool=${pool}&season=${season}`, card: null, leaderboard });
    }
    const card = /^\/commanders\/([A-Za-z0-9_-]{4,64})(\/log\.json)?$/.exec(path);
    if (card) {
      const row = publicCards.get(card[1]!);
      const view = row ? await cardOf(row, now) : null;
      if (!view) return page(res, req, 404, { kind: 'unavailable', title: 'Commander unavailable', canonical: `${origin}${path}`, card: null, leaderboard: null });
      if (card[2]) {
        // Public projection: the signed entries as written (no sealed parts) and their signed verdict rows.
        const entries: CommanderLogEntry[] = (await log.entries(row!.commanderId)).map((r) => r.entry);
        const ids = new Set(entries.map((e) => e.entryId));
        sendJson(res, 200, { format: 'agent-command.commander-log', version: 1, commander: row!.publicId, keys: rated.keys, entries, verdicts: (await verdictRowsFor()).filter((v) => ids.has(v.entryId)) },
          { 'Content-Disposition': `attachment; filename="${row!.publicId}-log.json"` });
        return true;
      }
      return page(res, req, 200, { kind: 'card', title: view.name, canonical: `${origin}${cardPath(view.publicId)}`, card: view, leaderboard: null });
    }
    return false;
  }

  return {
    async verdict(ctx) {
      const rec = ctx.entry.queue && POOL_OF_QUEUE[ctx.entry.queue] ? await record(ctx.entry.matchId) : undefined;
      return verdictFor(ctx, rec, !!rated);
    },
    handle: async (req, res, url) => {
      try { return await handle(req, res, url); }
      catch (error) {
        if (error instanceof HttpError && (error.code === 'dodge_locked')) { sendJson(res, error.status, { error: error.code, lockedUntil: Number(error.detail) }); return true; }
        throw error;
      }
    },
    holds: (owner, commanderId) => matchmaker?.holds(owner, commanderId) ?? false,
    async metadataEdit(owner, commanderId) {
      if (!rated || !db) return;
      const subject = `${owner}/${commanderId}`;
      const now = Date.now();
      const [row] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ac_rated_events WHERE subject = $1 AND kind = 'metadata' AND at > ${ts(2)}`, [subject, now - 86_400_000]);
      if (Number(row?.n ?? 0) >= rated.metadataEditsPerDay) throw new HttpError(429, 'metadata_limit');
      await db.query(`INSERT INTO ac_rated_events (subject, kind, at) VALUES ($1, 'metadata', ${ts(2)})`, [subject, now]);
    },
    async paths() {
      if (!rated || !db) return [];
      return ['/leaderboard', ...(await cards()).filter((c) => c.public).map((c) => cardPath(c.publicId))];
    },
    matchmaker,
    nightly,
    recompute,
    ratings: () => state.ratings,
    settled: () => applying,
    ready,
    async close() {
      if (closed) return;
      closed = true;
      for (const t of timers) clearInterval(t);
      unsubscribe();
      unrecord();
      matchmaker?.close();
      await applying;
    },
  };
}
