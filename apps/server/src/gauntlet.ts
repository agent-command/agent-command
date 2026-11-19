/**
 * The policy-only gauntlet (DESIGN §Ladder, D8): a frozen policy commander version against the season's fixed
 * built-in bots (novice, standard, veteran) on K season maps, through the PlayerThree series service at fast-forward
 * (track `gauntlet`). Each level plays 3 seeds × 2 mirrored sides; its score is (wins + 0.5 draws) / games with the
 * series' seed-block bootstrap interval. The tier is the highest level scoring ≥ 0.5 with a lower bound ≥ 0.3. One run
 * per segment and policy version per 24 h; every run is kept. Results are logged (`queue: gauntlet`), never rated.
 */
import { randomUUID } from 'node:crypto';
import type { EntrantCard, MatchSpec, ResultsSummary, SeriesSpec } from 'playerthree/arena';
import type { PostgresStorage } from 'playerthree/postgres';
import { surfaceHash } from 'playerthree';
import { commanderPublicId } from 'playerthree/results';
import { botVersion, DEFAULT_TIME_CAP_TICKS, definition, PLANES, resolveBotOptions, type Opponent } from '@agent-command/game';
import { MAPS } from '@agent-command/game/lobby';
import { resolveArenaMatch } from '@agent-command/game/arena';
import type { RatedConfig } from './config.ts';
import { HttpError } from './http.ts';
import { segmentId } from './ladder.ts';
import type { GameHost } from './room.ts';
import { seasonMaps } from './matchmaker.ts';
import type { CommanderCard } from '../../web/src/ladder/model.ts';

export const GAUNTLET = {
  levels: ['novice', 'standard', 'veteran'] as const satisfies readonly Opponent[],
  seeds: 3,
  maps: 3,
  passScore: 0.5,
  passLower: 0.3,
  rerunMs: 24 * 3_600_000,
  speed: 20,
  pollMs: 2000,
} as const;

export interface GauntletSeries {
  create(owner: string, spec: SeriesSpec): Promise<{ id: string }>;
  start(owner: string, id: string): Promise<void>;
  results(owner: string, id: string): Promise<ResultsSummary>;
}

export interface Gauntlet {
  start(owner: string, commanderId: string, season: string): Promise<{ runId: string }>;
  /** The best completed run of the commander's latest policy version, for its card. */
  best(publicId: string): Promise<CommanderCard['gauntlet'] | null>;
  /** Series ids the gauntlet created (their matches log `queue: gauntlet`). */
  owns(seriesId: string): boolean;
  close(): void;
}

type Level = (typeof GAUNTLET.levels)[number];
interface RunResult { levels: { level: Level; seriesId: string; games: number; score: number | null; interval: [number, number] | null; state: string }[]; tier: Level | null; done: boolean }

export function createGauntlet(ctx: { db: PostgresStorage; host: GameHost; rated: RatedConfig; series: GauntletSeries; seedFor(seriesId: string, block: string): Promise<number> }): Gauntlet {
  const { db, host, series } = ctx;
  const owned = new Set<string>();
  const running = new Map<string, { owner: string; result: RunResult; spec: (level: Level) => Promise<SeriesSpec> }>();
  const timer = setInterval(() => void poll(), GAUNTLET.pollMs);
  timer.unref();

  async function suiteSpec(owner: string, commanderId: string, season: string, level: Level): Promise<SeriesSpec> {
    const commander = host.commanders.roster(owner).find((c) => c.id === commanderId)!;
    const maps = seasonMaps(ctx.rated, 'duel').filter(({ map }) => MAPS.find((m) => m.id === map)?.sides === 2).slice(0, GAUNTLET.maps);
    if (!maps.length) throw new HttpError(503, 'gauntlet_unavailable');
    const base: MatchSpec = {
      format: 'playerthree.match', version: 1, game: definition.manifest.id, gameVersion: definition.manifest.version, surfaceHash: surfaceHash(definition.manifest),
      rulesHash: '', seed: 0, map: { id: maps[0]!.map, identity: '', seed: MAPS.find((m) => m.id === maps[0]!.map)!.mapSeed ?? 0, layout: maps[0]!.layout }, options: {},
      sides: [
        { id: 'nw', spawnSlot: 'nw', alliance: 'blue', seats: PLANES.map((role) => ({ role, occupant: { kind: 'commander' as const, ref: { id: commanderId, kind: 'policy' as const, version: commander.policy.activeByRole[role]! } } })) },
        { id: 'se', spawnSlot: 'se', alliance: 'red', seats: PLANES.map((role) => ({ role, occupant: { kind: 'bot' as const, level, options: { ...resolveBotOptions(level) } } })) },
      ],
      bindings: [...PLANES.map((role) => ({ seat: { team: 'nw', role }, entrantId: 'entrant-0' })), ...PLANES.map((role) => ({ seat: { team: 'se', role }, entrantId: 'entrant-1' }))],
      observerPolicy: { allowOmniscient: false, minDelayMs: 0 }, rules: { ranked: false, coaching: 'off', practiceReasons: ['gauntlet'] },
    };
    const template = resolveArenaMatch(base);
    // A season suite: the same private seeds (arenaSeedSource) for every run of the season and level.
    const scenarios = await Promise.all(Array.from({ length: GAUNTLET.seeds }, async (_, i) => {
      const pick = maps[i % maps.length]!;
      const seed = (await ctx.seedFor(`gauntlet:${season}`, `${level}:${i}`)) % 0x1_0000_0000;
      const match = resolveArenaMatch({ ...template, seed, rulesHash: '', map: { ...template.map, id: pick.map, layout: pick.layout, seed, identity: '' } });
      return { id: `${pick.map}:${i}`, seed, map: match.map, options: match.options };
    }));
    const version = botVersion(definition.manifest, level);
    const entrants: EntrantCard[] = [
      { id: 'entrant-0', label: commander.name.slice(0, 96), kind: 'policy', aiPlayer: true, stateResetSource: 'not_applicable' },
      { id: 'entrant-1', label: `${level} bots`, kind: 'bot', aiPlayer: true, botLevel: level, botOptions: { ...resolveBotOptions(level) }, ...(version ? { botVersion: version } : {}), stateResetSource: 'not_applicable' },
    ];
    return {
      format: 'playerthree.series', version: 1, game: template.game, gameVersion: template.gameVersion, surfaceHash: template.surfaceHash,
      track: 'gauntlet', entrants, template, scenarios,
      permutations: [{ id: 'original', sideEntrants: [{ team: 'nw', entrantId: 'entrant-0' }, { team: 'se', entrantId: 'entrant-1' }] }, { id: 'swapped', sideEntrants: [{ team: 'nw', entrantId: 'entrant-1' }, { team: 'se', entrantId: 'entrant-0' }] }],
      repetitions: 1,
      execution: { concurrency: 1, speed: GAUNTLET.speed, clock: 'accelerated', maxTicks: DEFAULT_TIME_CAP_TICKS, maxWallMs: 3_600_000, maxInfraRetries: 1, state: 'reset_each_match' },
      budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating: { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 },
      telemetry: { sampleEveryTicks: 20, includeCommentary: false, commentaryConsents: [] },
    };
  }

  /** Level score and interval from the series' standings (the seed-block bootstrap over scenario blocks). */
  function levelOf(level: Level, seriesId: string, summary: ResultsSummary): RunResult['levels'][number] {
    const row = summary.tables.standings.find((s) => s.entrantId === 'entrant-0');
    const interval = row?.confidence.scoreRate;
    return { level, seriesId, games: row?.games ?? 0, score: row?.scoreRate ?? null, interval: interval ? [interval[0], interval[1]] : null, state: summary.state };
  }

  const tierOf = (levels: RunResult['levels']): Level | null =>
    [...levels].reverse().find((l) => l.state === 'completed' && l.score !== null && l.score >= GAUNTLET.passScore && l.interval !== null && l.interval[0] >= GAUNTLET.passLower)?.level ?? null;

  async function poll(): Promise<void> {
    for (const [runId, run] of running) {
      try {
        const current = run.result.levels.at(-1)!;
        const summary = await series.results(run.owner, current.seriesId);
        run.result.levels[run.result.levels.length - 1] = levelOf(current.level, current.seriesId, summary);
        if (!['completed', 'aborted', 'failed'].includes(summary.state)) continue;
        const next = GAUNTLET.levels[run.result.levels.length];
        if (next && summary.state === 'completed') {
          const created = await series.create(run.owner, await run.spec(next));
          owned.add(created.id);
          run.result.levels.push({ level: next, seriesId: created.id, games: 0, score: null, interval: null, state: 'queued' });
          await series.start(run.owner, created.id);
        } else {
          run.result.done = true;
          run.result.tier = tierOf(run.result.levels);
          running.delete(runId);
        }
        await db.query('UPDATE ac_gauntlet_runs SET result = $2::jsonb, series_id = $3 WHERE id = $1', [runId, JSON.stringify(run.result), run.result.levels.map((l) => l.seriesId).join(',')]);
      } catch (error) {
        console.error('gauntlet: poll failed', error instanceof Error ? error.message : error);
      }
    }
  }

  return {
    async start(owner, commanderId, season) {
      const commander = host.commanders.has(owner) ? host.commanders.roster(owner).find((c) => c.id === commanderId) : undefined;
      if (!commander) throw new HttpError(403, 'not_owner');
      // Policy-only (D8): live agents cannot enter.
      if (commander.kind !== 'policy') throw new HttpError(403, 'policy_only');
      if (PLANES.some((role) => !commander.roles.includes(role) || commander.policy.activeByRole[role] == null)) throw new HttpError(400, 'planes_incomplete');
      const artifact = [...new Set(PLANES.map((role) => commander.policy.versions.find((v) => v.version === commander.policy.activeByRole[role] && v.role === role)!.artifactHash))].sort().join(',');
      const segment = segmentId(commanderId, 'gauntlet', commander.metadata ?? {});
      const now = Date.now();
      const [recent] = await db.query<{ n: string }>('SELECT count(*) AS n FROM ac_gauntlet_runs WHERE segment_id = $1 AND artifact = $2 AND created_at > to_timestamp($3::double precision / 1000)', [segment, artifact, now - GAUNTLET.rerunMs]);
      if (Number(recent?.n ?? 0) > 0) throw new HttpError(429, 'gauntlet_limit');
      if (commander.seated || [...running.values()].some((r) => r.owner === owner)) throw new HttpError(409, 'busy');
      const spec = (level: Level) => suiteSpec(owner, commanderId, season, level);
      const created = await series.create(owner, await spec(GAUNTLET.levels[0]));
      owned.add(created.id);
      const runId = randomUUID();
      const result: RunResult = { levels: [{ level: GAUNTLET.levels[0], seriesId: created.id, games: 0, score: null, interval: null, state: 'queued' }], tier: null, done: false };
      await db.query('INSERT INTO ac_gauntlet_runs (id, public_id, segment_id, artifact, season, series_id, created_at, result) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000), $8::jsonb)',
        [runId, commanderPublicId(definition.manifest.id, commanderId), segment, artifact, season, created.id, now, JSON.stringify(result)]);
      running.set(runId, { owner, result, spec });
      await series.start(owner, created.id);
      return { runId };
    },
    async best(publicId) {
      const rows = await db.query<{ artifact: string; at: string; result: RunResult }>("SELECT artifact, (extract(epoch FROM created_at) * 1000)::bigint AS at, result FROM ac_gauntlet_runs WHERE public_id = $1 AND result->>'done' = 'true' ORDER BY created_at DESC", [publicId]);
      const latest = rows[0]?.artifact;
      const rank = (r: RunResult) => r.tier ? GAUNTLET.levels.indexOf(r.tier) + 1 : 0;
      const best = rows.filter((r) => r.artifact === latest).sort((a, b) => rank(b.result) - rank(a.result))[0];
      if (!best) return null;
      return { tier: best.result.tier, artifact: best.artifact.split(',').map((h) => h.slice(0, 12)).join(','), at: Number(best.at),
        levels: best.result.levels.filter((l) => l.score !== null).map((l) => ({ level: l.level, games: l.games, score: l.score!, interval: l.interval })) };
    },
    owns: (seriesId) => owned.has(seriesId),
    close() { clearInterval(timer); running.clear(); },
  };
}
