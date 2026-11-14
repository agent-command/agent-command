/**
 * A built-in plane bot as a PlayerThree policy instance (spec §11 *Trusted runner*, POLICY_ABI). A bot package's entry
 * (bots/build.ts `botEntry`) is `createPolicy(options) = botPolicy(<Plane>Bot, { plane, level }, options)`; a starter
 * fork (skill `policies/<plane>.js`) imports the same modules from the strategy skill and changes knobs, wraps `think`
 * or subclasses the bot. The bot reads only matchData (init) and the observation (think); everything else it imports
 * is pure rules data and geometry.
 */
import type { AgentCommandIntent } from '../agent/intents.ts';
import type { ArmyId, BotOptions, MatchData, Observation, Opponent, Plane } from '../rules/contract.ts';
import { prepareMatch, type PlaneBot } from './plane-bot.ts';
import { botTier, type Tier } from './tuning.ts';

/** A playing difficulty. */
export type BotLevel = Exclude<Opponent, 'idle'>;

/** What a bot package bakes in: every level of a plane runs the same code, only this differs. */
export interface BotPolicyConfig {
  plane: Plane;
  level: BotLevel;
  /** Fork knobs: Tier fields replaced after the level and the seat's bot options resolve. */
  tier?: Partial<Tier>;
}

export type PlaneBotClass = new (army: ArmyId, tier: Tier) => PlaneBot;

/** One seat's bot policy: `init` and `think` as the policy ABI calls them. */
export interface BotPolicy {
  init(data: MatchData | null): void;
  think(obs: Observation): AgentCommandIntent[];
  /** The seat's bot once the first observation named its army (forks read its memory). */
  readonly bot: PlaneBot | undefined;
}

/**
 * One seat of `Bot` at `config.level` with the seat's bot options (`null`: the level's defaults), exactly the bot
 * `createBot` makes for that seat. matchData names no seat, so the bot is made on the first observation (`obs.army`);
 * init already derives what matchData alone gives (prepareMatch), inside the load's budget rather than a think's.
 */
export function botPolicy(Bot: PlaneBotClass, config: BotPolicyConfig, options: Readonly<Partial<BotOptions>> | null = null): BotPolicy {
  const tier: Tier = { ...botTier(config.level, options), ...config.tier };
  let match: MatchData | null = null;
  let bot: PlaneBot | undefined;
  return {
    get bot() { return bot; },
    init(data) {
      match = data;
      bot = undefined;
      if (data) prepareMatch(data);
    },
    think(obs) {
      if (obs.role !== config.plane) throw new Error(`${config.plane} bot policy deployed on a ${obs.role} seat`);
      if (!bot) {
        if (!match) throw new Error('Bot requires match data initialization before think');
        bot = new Bot(obs.army, tier);
        bot.init(match);
      }
      return bot.think(obs);
    },
  };
}
