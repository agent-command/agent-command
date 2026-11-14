/** Translate the lobby's frozen lineup and explicit drawer choices into the shared series contract. */
import type { EntrantCard, SeriesSpec } from 'playerthree/arena';
import { resolveArenaMatch } from '@agent-command/game/arena';
import { botVersion, DEFAULT_TIME_CAP_TICKS, isOpponent } from '@agent-command/game';
import { object } from './arena-input.ts';
import { HttpError } from './http.ts';
import type { LobbyService } from './lobby.ts';
import type { GameHost } from './room.ts';

/** Elo rates exactly two lineups; FFA series rate with TrueSkill (the bench/series.ts parameters). */
const MULTIPLAYER_RATING = { algorithm: 'trueskill', version: 1, mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 25 / 300, drawProbability: 0.1 } as const;
/**
 * Side → entrant orders of a series: the frozen lineup only, its rotation group (`true`: entrant k + i on side i, so
 * every entrant plays every slot once; a duel's swap) or every order (`'full'`, N! — 24 for four armies).
 */
function sideOrders(sides: number, swaps: boolean | 'full'): { id: string; order: number[] }[] {
  const orders: number[][] = [];
  if (swaps === 'full') {
    const extend = (prefix: number[]): void => {
      if (prefix.length === sides) { orders.push(prefix); return; }
      for (let entrant = 0; entrant < sides; entrant++) if (!prefix.includes(entrant)) extend([...prefix, entrant]);
    };
    extend([]);
  } else for (let k = 0; k < (swaps ? sides : 1); k++) orders.push(Array.from({ length: sides }, (_, side) => (side + k) % sides));
  return orders.map((order, index) => ({ order, id: index === 0 ? 'original' : sides === 2 ? 'swapped' : swaps === 'full' ? `order-${order.join('')}` : `rotation-${index}` }));
}
export function lobbySeriesSpec(lobbies: LobbyService, owner: string, code: string, value: unknown, host: GameHost): SeriesSpec {
  const body = object(value, ['revision', 'seeds', 'maps', 'sideSwaps', 'speed', 'concurrency', 'maxTicks', 'maxWallMs', 'retries', 'retryOn', 'abortOn', 'schedule', 'resetAgentState'], ['revision', 'seeds', 'maps', 'sideSwaps', 'speed', 'concurrency', 'maxTicks', 'retries', 'retryOn', 'abortOn', 'schedule', 'resetAgentState']);
  if (!Number.isSafeInteger(body.revision) || !Array.isArray(body.seeds) || !body.seeds.length || body.seeds.length > 100 || !body.seeds.every(seed => Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff) || new Set(body.seeds).size !== body.seeds.length || !Array.isArray(body.maps) || !body.maps.length || body.maps.length > 20 || !body.maps.every(map => typeof map === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(map)) || new Set(body.maps).size !== body.maps.length) throw new HttpError(400, 'bad_schedule');
  const maxWallMs = body.maxWallMs ?? 3600000;
  if (typeof body.sideSwaps !== 'boolean' && body.sideSwaps !== 'full' || !Number.isInteger(body.speed) || (body.speed as number) < 1 || (body.speed as number) > 20 || !Number.isInteger(body.concurrency) || (body.concurrency as number) < 1 || (body.concurrency as number) > 2 || !Number.isInteger(body.maxTicks) || (body.maxTicks as number) < 1 || (body.maxTicks as number) > DEFAULT_TIME_CAP_TICKS || !Number.isInteger(maxWallMs) || (maxWallMs as number) < 1 || (maxWallMs as number) > 3600000 || ![0, 1].includes(body.retries as number) || JSON.stringify(body.retryOn) !== '["infrastructure"]' || !Array.isArray(body.abortOn) || body.abortOn.length > 1 || body.abortOn.some(reason => reason !== 'infrastructure') || body.schedule !== 'paired' || body.resetAgentState !== true) throw new HttpError(400, 'bad_schedule');
  const frozen = lobbies.frozenSpec(owner, code, body.revision as number);
  const entrants: EntrantCard[] = frozen.sides.map((side, index) => {
    const occupants = side.seats.map(seat => seat.occupant);
    const kind = occupants.some(o => o.kind === 'commander' && o.ref.kind === 'agent') ? 'agent' : occupants.some(o => o.kind === 'commander') ? 'policy' : 'bot';
    const bot = occupants.find(o => o.kind === 'bot');
    const commanderIds = [...new Set(occupants.flatMap(occupant => occupant.kind === 'commander' ? [occupant.ref.id] : []))];
    const commanders = commanderIds.map(id => {
      const commander = host.commanders.roster(owner).find(entry => entry.id === id);
      if (!commander) throw new HttpError(403, 'commander_unavailable');
      return commander;
    });
    const metadata = commanders.length === 1 ? commanders[0]!.metadata : undefined;
    const label = commanders.length ? commanders.map(commander => commander.name).join(' + ').slice(0, 96) : `${bot?.kind === 'bot' ? bot.level : side.id} bots`;
    const version = bot?.kind === 'bot' && isOpponent(bot.level) ? botVersion(host.definition.manifest, bot.level) : undefined;
    return { id: `entrant-${index}`, label, kind, aiPlayer: true, ...(metadata ? { ...metadata, selfReported: true as const } : {}), ...(bot?.kind === 'bot' && occupants.every(o => o.kind === 'bot' || o.kind === 'closed') ? { botLevel: bot.level, botOptions: bot.options, ...(version ? { botVersion: version } : {}) } : {}), stateResetSource: kind === 'agent' ? 'declared' : 'not_applicable' };
  });
  const bindings = frozen.sides.flatMap((side, index) => side.seats.filter(seat => seat.occupant.kind !== 'closed').map(seat => ({ seat: { team: side.id, role: seat.role }, entrantId: entrants[index]!.id })));
  const template = resolveArenaMatch({ ...frozen, rulesHash: '', map: { ...frozen.map, identity: '' }, bindings });
  const permutations = sideOrders(frozen.sides.length, body.sideSwaps as boolean | 'full').map(({ id, order }) => ({
    id, sideEntrants: frozen.sides.map((side, index) => ({ team: side.id, entrantId: entrants[order[index]!]!.id })),
  }));
  const scenarios = (body.maps as string[]).flatMap(mapId => (body.seeds as number[]).map(seed => {
    const match = resolveArenaMatch({ ...template, seed, rulesHash: '', map: { ...template.map, id: mapId, seed, identity: '' } });
    return { id: `${mapId}:${seed}`, seed, map: match.map, options: match.options };
  }));
  if (scenarios.length * permutations.length > 200) throw new HttpError(400, 'series_match_limit');
  const track = entrants.some(e => e.kind === 'agent') ? 'live' : entrants.some(e => e.kind === 'policy') ? 'policy' : 'bots';
  if (track === 'live' && (body.speed !== 1 || body.concurrency !== 1)) throw new HttpError(400, 'live_lane_capacity');
  return { format: 'playerthree.series', version: 1, game: frozen.game, gameVersion: frozen.gameVersion, surfaceHash: frozen.surfaceHash,
    track, entrants, template, scenarios, permutations, repetitions: 1,
    execution: { concurrency: body.concurrency as number, speed: body.speed as number, clock: body.speed === 1 ? 'realtime' : 'accelerated', maxTicks: body.maxTicks as number, maxWallMs: maxWallMs as number, maxInfraRetries: body.retries as number, state: 'reset_each_match', abortOn: body.abortOn as 'infrastructure'[] },
    budgets: { maxTokens: null, maxCostUsd: null, maxTurns: null }, rating: entrants.length === 2 ? { algorithm: 'elo', version: 1, initial: 1500, k: 32, scale: 400 } : MULTIPLAYER_RATING, telemetry: { sampleEveryTicks: 20, includeCommentary: false, commentaryConsents: [] } };
}
