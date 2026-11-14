/**
 * Bot personality (BotOptions.personality, featured matches only): a seed that moves a tier within the PERSONALITY_*
 * bounds of bots/tuning.ts. Absent, the tier is exactly the options' tier; present, it is deterministic, bounded and
 * plays the same through the bot packages as in-process.
 */
import { createHash } from 'node:crypto';
import { type BotCommander } from 'playerthree';
import { seatBot, type SeatBot } from 'playerthree/host';
import { describe, expect, it } from 'vitest';
import { definition } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import type { AgentCommandManifest } from '../src/agent/manifest.ts';
import { playBotMatch, type BotMatchOptions } from '../src/bots/play.ts';
import { starterKnobs } from '../src/bots/starter.ts';
import {
  ARMY_MIN, botTier, PERSONALITY_AGGRESSION, PERSONALITY_ARMY, PERSONALITY_RALLY, PERSONALITY_RESERVE, PERSONALITY_TIMING, personalityTraits, RESERVE_SCALE,
  TIE_BITS, TIERS,
} from '../src/bots/tuning.ts';
import { BOT_DEFAULTS, BOT_KNOBS, PERSONALITY_SEED_MAX, PLANES, resolveBotOptions, type ArmyId, type Plane } from '../src/rules/contract.ts';
import { exactJson } from './bot-trace.ts';

const LEVELS = ['novice', 'standard', 'veteran'] as const;
const SEEDS = Array.from({ length: 200 }, (_, i) => 1 + ((i * 2654435761) >>> 0) % PERSONALITY_SEED_MAX);
const EPS = 1e-9;
/** A short match: enough decisions for every plane's bot to act on its tier. */
const TICKS = 400;

describe('bot personality', () => {
  it('is no option without a seed: the tier is exactly the options\' tier, and no public knob or starter knob names it', () => {
    for (const level of LEVELS) {
      const plain = botTier(level, null);
      expect(plain).toEqual(botTier(level, BOT_DEFAULTS[level]));
      expect(plain).toEqual({ ...TIERS[level], aggressionShift: 0, rallySkew: 0, tieOrder: 0 });
      expect(resolveBotOptions(level)).not.toHaveProperty('personality');
    }
    for (const plane of PLANES) {
      expect(starterKnobs(plane)).toHaveProperty(['properties', 'aggression']);
      expect(starterKnobs(plane)).not.toHaveProperty(['properties', 'personality']);
    }
  });

  it('validates as a positive 31-bit integer', () => {
    expect(resolveBotOptions('standard', { personality: 7 }).personality).toBe(7);
    expect(resolveBotOptions('standard', { personality: PERSONALITY_SEED_MAX }).personality).toBe(PERSONALITY_SEED_MAX);
    for (const personality of [0, -1, 1.5, PERSONALITY_SEED_MAX + 1, Number.NaN]) expect(() => resolveBotOptions('standard', { personality })).toThrow();
  });

  it('is deterministic and stays within its named bounds on every tier', () => {
    const tieOrders = new Set<number>();
    for (const seed of SEEDS) {
      expect(personalityTraits(seed)).toEqual(personalityTraits(seed));
      for (const level of LEVELS) {
        const base = TIERS[level];
        const tier = botTier(level, { personality: seed });
        expect(tier).toEqual(botTier(level, { personality: seed }));
        expect(Math.abs(tier.aggressionShift)).toBeLessThanOrEqual(PERSONALITY_AGGRESSION + EPS);
        const a = tier.aggressionShift;
        const scaled = (value: number, bound: number) => [Math.round(value * (1 - a) * (1 - bound)), Math.round(value * (1 - a) * (1 + bound))] as const;
        const [attackLow, attackHigh] = scaled(base.attackAt, PERSONALITY_ARMY);
        expect(tier.attackAt).toBeGreaterThanOrEqual(Math.max(ARMY_MIN, attackLow));
        expect(tier.attackAt).toBeLessThanOrEqual(Math.max(ARMY_MIN, attackHigh));
        for (const field of ['tunnelAt', 'faultAt', 'breachFrom', 'breachEvery', 'strikeEvery', 'recaptureEvery'] as const) {
          if (!Number.isFinite(base[field])) { expect(tier[field]).toBe(base[field]); continue; }
          const [low, high] = scaled(base[field], PERSONALITY_TIMING);
          expect(tier[field]).toBeGreaterThanOrEqual(low);
          expect(tier[field]).toBeLessThanOrEqual(high);
        }
        for (const plane of PLANES) expect(Math.abs(tier.reserve[plane] - base.reserve[plane])).toBeLessThanOrEqual(PERSONALITY_RESERVE * RESERVE_SCALE + EPS);
        expect(Math.abs(tier.rallySkew)).toBeLessThanOrEqual(PERSONALITY_RALLY);
        expect(tier.tieOrder).toBeGreaterThanOrEqual(1);
        expect(tier.tieOrder).toBeLessThan(2 ** TIE_BITS);
        tieOrders.add(tier.tieOrder);
      }
    }
    // Different seeds, different styles.
    expect(tieOrders.size).toBe(SEEDS.length);
    expect(new Set(SEEDS.map((seed) => botTier('veteran', { personality: seed }).attackAt)).size).toBeGreaterThan(1);
  });

  it('keeps the seat\'s aggression and reserve options inside the knobs\' [0, 1]', () => {
    for (const seed of SEEDS) {
      const high = botTier('veteran', { aggression: 1, economyReserve: 1, personality: seed });
      expect(high.aggressionShift).toBeLessThanOrEqual(1 - BOT_DEFAULTS.veteran.aggression + EPS);
      const low = botTier('novice', { aggression: 0, economyReserve: 0, personality: seed });
      expect(low.aggressionShift).toBeGreaterThanOrEqual(-BOT_DEFAULTS.novice.aggression - EPS);
      for (const plane of PLANES) expect(low.reserve[plane]).toBeGreaterThanOrEqual(0);
    }
  });

  it('plays the same decisions through the bot packages as in-process', { timeout: 120_000 }, () => {
    const seed = 5;
    const personality: Readonly<Record<'nw' | 'se', number>> = { nw: 11, se: 29 };
    const trace = (make: (team: ArmyId, role: Plane) => BotCommander<AgentCommandManifest>): string => {
      const seats: NonNullable<BotMatchOptions['seats']> = {};
      for (const team of ['nw', 'se'] as const) seats[team] = Object.fromEntries(PLANES.map((role) => [role, make(team, role)]));
      const hash = createHash('sha256');
      const { game } = playBotMatch({
        seed, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: TICKS, seats,
        onDecision: (g, seat, intents) => { hash.update(`${g.tick} ${seat.team}/${seat.role} ${exactJson(intents)}\n`); },
      });
      return hash.update(game.stateHash()).digest('hex');
    };
    const options = (team: ArmyId) => ({ personality: personality[team as 'nw' | 'se'] });
    const packaged = trace((team, role) => {
      const bot = seatBot(definition, { team, role }, 'veteran', options(team), seed);
      const seat: BotCommander<AgentCommandManifest> & Pick<SeatBot, 'dispose'> = {
        init: (d) => { bot.init?.(d); if (bot.packageHash === undefined) throw new Error(`${team}/${role}: no current package`); },
        think: (o) => bot.think(o) as AgentCommandIntent[],
        dispose: () => bot.dispose?.(),
      };
      return seat;
    });
    expect(packaged).toBe(trace((team, role) => definition.createBot({ team, role }, 'veteran', options(team))));
    expect(packaged).not.toBe(trace((team, role) => definition.createBot({ team, role }, 'veteran')));
  });
});
