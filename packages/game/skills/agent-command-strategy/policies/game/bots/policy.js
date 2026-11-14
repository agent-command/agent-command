// Agent Command's built-in bot library: packages/game/src/bots/policy.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * A built-in plane bot as a PlayerThree policy instance (spec §11 *Trusted runner*, POLICY_ABI). A bot package's entry
 * (bots/build.ts `botEntry`) is `createPolicy(options) = botPolicy(<Plane>Bot, { plane, level }, options)`; a starter
 * fork (skill `policies/<plane>.js`) imports the same modules from the strategy skill and changes knobs, wraps `think`
 * or subclasses the bot. The bot reads only matchData (init) and the observation (think); everything else it imports
 * is pure rules data and geometry.
 */
import { prepareMatch, } from './plane-bot.js';
import { botTier, } from './tuning.js';





/**
 * One seat of `Bot` at `config.level` with the seat's bot options (`null`: the level's defaults), exactly the bot
 * `createBot` makes for that seat. matchData names no seat, so the bot is made on the first observation (`obs.army`);
 * init already derives what matchData alone gives (prepareMatch), inside the load's budget rather than a think's.
 */
export function botPolicy(Bot, config, options = null) {
  const tier = { ...botTier(config.level, options), ...config.tier };
  let match = null;
  let bot;
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
