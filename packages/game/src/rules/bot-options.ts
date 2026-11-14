/**
 * Built-in bot options: the schema a seat's bot options are validated against (GameDefinition.botOptions) and their
 * resolution over a difficulty's defaults.
 */
import { t, validate } from 'playerthree/schema';
import { BOT_DEFAULTS, OPPONENTS, PERSONALITY_SEED_MAX, type BotOptions, type Opponent } from './opponents.ts';

export const botOptionsSchema = t.obj({
  aggression: t.opt(t.num(0, 1)), economyReserve: t.opt(t.num(0, 1)), personality: t.opt(t.int(1, PERSONALITY_SEED_MAX)),
});
/** Strict unknown-key rejection, finite normalized values, and frozen tier defaults. */
export function resolveBotOptions(level: Opponent, raw: unknown = {}): Readonly<BotOptions> {
  if (!OPPONENTS.includes(level)) throw new Error('unknown bot level');
  const checked = validate(botOptionsSchema, raw);
  if (!checked.ok) throw new Error('invalid bot options');
  return Object.freeze({ ...BOT_DEFAULTS[level], ...checked.value });
}
