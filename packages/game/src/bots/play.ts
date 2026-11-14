/**
 * Headless bot matches in-process (tests, balance sweeps, dev tools): the PlayerThree host's bot cadence and ordering
 * without the host. Every deciding seat observes the start-of-tick world before any intent of that tick lands. Bot
 * seats are seated exactly as the host seats them (`seatBot`: the tier's package through the trusted runner, its
 * `createBot` fallback otherwise), and each round runs under one hang guard (`eachBot`).
 */
import type { ApplyResult, BotCommander, Outcome } from 'playerthree';
import { eachBot, seatBot, type SeatBot } from 'playerthree/host';
import { createGame, definition, type AgentCommandGame, type AgentCommandSeat } from '../agent/adapter.ts';
import { PLANES, type ArmyId, type MatchArmy, type MatchOptions, type Opponent, type Plane } from '../rules/contract.ts';
import type { AgentCommandIntent } from '../agent/intents.ts';
import type { AgentCommandManifest } from '../agent/manifest.ts';

/** Ticks between two bot decisions: max(1, round(tickRate / policy hz)), as PlayerThreeHost schedules them. */
export const BOT_PERIOD = Math.max(1, Math.round(definition.manifest.tickRate / (definition.manifest.control.policy?.hz ?? definition.manifest.tickRate)));

export interface BotMatchOptions {
  seed: number;
  /** the match's armies (default: every slot of the resolved map, the k-th coloured COLOURS[k]) */
  armies?: readonly MatchArmy[];
  /** built-in bot level per army of the match (every seat not listed in `seats`) */
  levels: Partial<Record<ArmyId, Opponent>>;
  /** match options = match rules (terrain preset, map and its slots, economy, …); omitted fields use the defaults */
  options?: MatchOptions;
  /** stop once this tick is reached even if the match is still running (default: play to the end; the sim stops at the rules' time cap) */
  maxTicks?: number;
  /** seats played by these commanders instead of the army's built-in bots (synchronous `think`) */
  seats?: Partial<Record<ArmyId, Partial<Record<Plane, BotCommander<AgentCommandManifest>>>>>;
  /** every applied intent with its result (rejection metrics), in apply order */
  onIntent?: (game: AgentCommandGame, seat: AgentCommandSeat, intent: AgentCommandIntent, result: ApplyResult<AgentCommandManifest>) => void;
  /** every think answer (empty ones too) of every seat, in seat order each round, before any is applied */
  onDecision?: (game: AgentCommandGame, seat: AgentCommandSeat, intents: readonly AgentCommandIntent[]) => void;
  /** after every step (per-tick metrics) */
  onTick?: (game: AgentCommandGame) => void;
}

export interface BotMatchResult {
  game: AgentCommandGame;
  /** per army of the match; `running` only for armies still in play when `maxTicks` stopped the match first */
  outcome: Partial<Record<ArmyId, Outcome>>;
  /** per army whose placement is final (1 = winner; tied armies share a rank): every army once the match is over */
  rank: Partial<Record<ArmyId, number>>;
  ticks: number;
}

/** Play one match with bots on every seat: observe all, decide all, then apply all, every BOT_PERIOD ticks. */
export function playBotMatch(opts: BotMatchOptions): BotMatchResult {
  const game = createGame({ seed: opts.seed, options: opts.options ?? {}, ...(opts.armies ? { armies: opts.armies } : {}) });
  const maxTicks = opts.maxTicks ?? Infinity;
  const armies = game.sim.armyIds;
  const seats = armies.flatMap((team) =>
    PLANES.map((role) => {
      const seat: AgentCommandSeat = { team, role };
      const level = opts.levels[team];
      const bot: SeatBot | undefined = opts.seats?.[team]?.[role] ?? (level ? seatBot(definition, seat, level, undefined, opts.seed) : undefined);
      if (!bot) throw new Error(`no bot level for army ${team}`);
      bot.init?.(game.matchData(seat));
      return { seat, bot, since: 0 };
    }),
  );
  const decided: AgentCommandIntent[][] = seats.map(() => []);
  const decide = (i: number): void => {
    const s = seats[i]!;
    const obs = game.observe(s.seat, s.since);
    s.since = game.tick;
    decided[i] = s.bot.think(obs) as AgentCommandIntent[];
  };
  while (game.sim.result === null && game.tick < maxTicks) {
    if (game.tick % BOT_PERIOD === 0) {
      eachBot(seats, decide);
      if (opts.onDecision) for (let i = 0; i < seats.length; i++) opts.onDecision(game, seats[i]!.seat, decided[i]!);
      // One simultaneous round: no seat's intent effect (an asteroid drop) is seen by another seat's same-round intent.
      game.sim.round(() => seats.forEach((s, i) => {
        for (const intent of decided[i]!) {
          const result = game.apply(s.seat, intent, { source: 'bot' });
          opts.onIntent?.(game, s.seat, intent, result);
        }
      }));
    }
    game.step();
    opts.onTick?.(game);
  }
  for (const s of seats) s.bot.dispose?.();
  const outcome: Partial<Record<ArmyId, Outcome>> = {};
  const rank: Partial<Record<ArmyId, number>> = {};
  armies.forEach((army, i) => {
    outcome[army] = game.outcome(army);
    const place = game.sim.placeOf(i);
    if (place !== null) rank[army] = place;
  });
  return { game, outcome, rank, ticks: game.tick };
}
