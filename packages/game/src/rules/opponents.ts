/**
 * Built-in bot opponents: difficulty tiers and their tunable knobs. Pure data: built-in bot packages bundle it (the
 * validated options and their schema are rules/bot-options.ts).
 */
export const OPPONENTS = ['idle', 'novice', 'standard', 'veteran'] as const;
export type Opponent = (typeof OPPONENTS)[number];
export const isOpponent = (v: string): v is Opponent => (OPPONENTS as readonly string[]).includes(v);

export const BOT_KNOBS = {
  aggression: { min: 0, max: 1, step: 0.05, label: 'Aggression', description: 'Higher values commit smaller armies earlier and shorten offensive delays.' },
  economyReserve: { min: 0, max: 1, step: 0.05, label: 'Economy reserve', description: 'Higher values retain more alloy before optional production and construction.' },
} as const;
/**
 * `personality`: a seed (1–PERSONALITY_SEED_MAX) that perturbs the tier within bots/tuning.ts PERSONALITY_* bounds
 * (botTier), so two armies at one level play different styles. Not a lobby knob: only the featured playlist (Watch
 * live) sets it; absent, the bot is exactly the tier's.
 */
export interface BotOptions { aggression: number; economyReserve: number; personality?: number }
/** Largest personality seed (a positive 31-bit integer). */
export const PERSONALITY_SEED_MAX = 0x7fffffff;
export const BOT_DEFAULTS: Readonly<Record<Opponent, Readonly<BotOptions>>> = {
  idle: { aggression: 0, economyReserve: 0 },
  novice: { aggression: 0.3, economyReserve: 0.7 },
  standard: { aggression: 0.5, economyReserve: 0.4 },
  veteran: { aggression: 0.7, economyReserve: 0.3 },
};
export function botDescriptor(level: Opponent) {
  if (!OPPONENTS.includes(level)) throw new Error('unknown bot level');
  return { level, knobs: level === 'idle' ? {} : BOT_KNOBS, defaults: BOT_DEFAULTS[level] };
}
