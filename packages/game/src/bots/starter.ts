/**
 * The starters (strategy skill `policies/<plane>.js`, the manifest's `starters`): each plane's built-in bot at its
 * sandbox tier (SANDBOX_TIERS), sized for the QuickJS policy sandbox, with the tier fields worth tuning as knobs. A
 * starter module exports `createPolicy(knobs)` (one seat, the policy ABI's instance) over `starterPolicy` and `knobs`
 * (`starterKnobs`: the JSON Schema PlayerThree validates a deploy's knobs against); deployed by reference
 * (`policy_deploy {from, knobs}`) or forked (copy it into your modules: change the knobs' defaults, wrap think,
 * subclass the bot).
 */
import type { BotOptions, Plane } from '../rules/contract.ts';
import { BOT_DEFAULTS } from '../rules/opponents.ts';
import { botPolicy, type BotPolicy, type PlaneBotClass } from './policy.ts';
import { botTier, SANDBOX_TIERS, type Tier } from './tuning.ts';

/** A tick knob at or above this (one more than the longest match: rules spire.timeCap ≤ 7200 s) means never (Infinity). */
const NEVER_TICKS = 144_001;
/** An army-size knob at or above this means never (Infinity). */
const NEVER_ARMY = 100;
/** Most alloy a reserve knob may hold back. */
const RESERVE_MAX = 2000;
/** Decision period bounds in ticks: the policy cadence (manifest hz 2: every 10 ticks) up to 10 s. */
const PERIOD_MIN = 10;
const PERIOD_MAX = 200;

/** How a knob maps onto the tier: a count, a tick time (top: never), an army size (top: never), a flag or a choice. */
type KnobKind = { kind: 'count'; max: number } | { kind: 'rate'; min: number; max: number } | { kind: 'ticks' } | { kind: 'army' } | { kind: 'flag' } | { kind: 'choice'; options: readonly string[] };
type TierKnob = KnobKind & { field: keyof Tier; text: string };

const count = (field: keyof Tier, max: number, text: string): TierKnob => ({ kind: 'count', max, field, text });
const ticks = (field: keyof Tier, text: string): TierKnob => ({ kind: 'ticks', field, text: `${text} In ticks (20 per second); ${NEVER_TICKS} or more: never.` });
const army = (field: keyof Tier, text: string): TierKnob => ({ kind: 'army', field, text: `${text} ${NEVER_ARMY}: never.` });
const flag = (field: keyof Tier, text: string): TierKnob => ({ kind: 'flag', field, text });

/** Knobs every starter has, before its plane's. */
const COMMON: readonly TierKnob[] = [
  { kind: 'count', max: PERIOD_MAX, field: 'period', text: `Ticks between decisions (${PERIOD_MIN}–${PERIOD_MAX}): shorter reacts faster and costs more of the sandbox budget per second.` },
];

/** The tier fields each plane's starter exposes (bots/tuning.ts Tier documents each). */
const PLANE_KNOBS: Readonly<Record<Plane, readonly TierKnob[]>> = {
  depths: [
    count('diggers', 20, 'Diggers kept.'),
    count('sappers', 8, 'Sappers per strike wave (0: no strikes).'),
    count('wardens', 8, 'Wardens kept on the cavern choke.'),
    count('bulkheads', 6, 'Bulkheads cutting the routes toward home.'),
    count('faultGuards', 4, 'Fault cells near home kept fortified.'),
    count('lodeMiners', 8, 'Diggers on opened lode pockets.'),
    count('motherCrew', 8, 'Diggers on the Mother Lode.'),
    count('richCrew', 8, 'Diggers on green rich ore (bridging lava to it).'),
    count('troopersDown', 12, 'Troopers asked of the Surface for the Warden push.'),
    flag('defuse', 'Defuse hostile charges near home.'),
    flag('backfill', 'Backfill hostile holes near home.'),
    flag('repair', 'Fortify cracking walls near home.'),
    flag('bridgeWars', 'Guard own lava bridges and cut hostile ones.'),
    flag('steal', 'Also mine contested lodes and Mother Lode cells.'),
    ticks('railAt', 'When rail starts along the cavern.'),
    ticks('tunnelAt', "When the tunnel toward the focus's Spire starts."),
    ticks('faultAt', 'When a fault is opened on the enemy half.'),
    ticks('wardenPushAt', 'When the Warden push readies.'),
    { kind: 'rate', min: 0.25, max: 16, field: 'routeSearches', text: 'Fresh dig-route and lava-crossing searches per decision (0.25–16; 0.5: one every other decision): the main cost of a Depths think.' },
    flag('prepareAhead', 'Build the worker-route fields on the call before each decision (half a second older), not in it. A fresh instance\'s first call then only prepares and returns no intents; its first decision is the next call.'),
    count('routeReuse', 1200, 'Ticks a planner keeps its last route while it still holds before searching again (0: every decision).'),
    count('gateWalks', 64, 'Whole-map walks per decision for bulkhead cut planning; once spent it keeps the best cut found so far and resumes with the next goal at the next decision.'),
  ],
  surface: [
    count('armyCap', 80, 'Most army units.'),
    army('attackAt', "Army size that attacks the focus's Spire."),
    army('holdCenterAt', 'Army size that takes and holds the centre.'),
    count('turrets', 6, 'Turrets at home.'),
    count('headframes', 6, 'Headframes kept on lodes.'),
    ticks('headframeAt', 'When Headframes start.'),
    ticks('homeShaftAt', 'When the home Shaft goes up.'),
    flag('midShaft', 'A second Shaft by the centre once it is held.'),
    ticks('breachFrom', 'When trooper squads start going down to breach.'),
    ticks('breachEvery', 'Between two breach squads.'),
    flag('breachGuard', 'Meet enemy breaches near home with the army.'),
    flag('tremorResponse', 'Send troopers down against tremors under the base.'),
    flag('raid', 'Raid an exposed enemy depths economy.'),
    flag('adaptive', "Counter the enemy's composition and attack on value advantage."),
    count('postGuards', 6, 'Troopers detached to each own forward post.'),
    count('pointSquad', 8, 'Troopers holding the nearest contested point (0: none).'),
    count('breachers', 6, 'Breachers kept (0: no Drill Yard).'),
    { kind: 'choice', options: ['none', 'basic', 'sharp'], field: 'deploy', text: 'Deploy stances: none, basic (siege on structures, dig in at holds, flak at home) or sharp (also before contact).' },
  ],
  sky: [
    count('interceptors', 12, 'Interceptors in the screen.'),
    count('bombers', 8, 'Bombers.'),
    count('gunships', 8, 'Most gunships (escorts and brawlers).'),
    count('gunPlatforms', 4, 'Most Gun Platforms on threatened islands.'),
    count('relays', 4, 'Most Relays (0: no island investment).'),
    ticks('recaptureEvery', 'Between offensive island recapture sweeps.'),
    flag('defendIslands', 'Keep local escorts on invested islands.'),
    flag('screenFirst', 'Energy goes to the interceptor screen first while it is short.'),
    { kind: 'choice', options: ['escape', 'route', 'cover'], field: 'skyWeather', text: 'Weather craft: escape storms, route around them and ride jet lanes, or also hide bomber approaches in storms.' },
  ],
  orbit: [
    count('solar', 12, 'Most solar arrays.'),
    count('tugs', 6, 'Tugs.'),
    count('lancers', 8, 'Lancer fleet floor (0: no warships).'),
    flag('foldArrays', 'Fold hurt arrays to heal.'),
    ticks('strikeEvery', 'Least time between two asteroid strikes.'),
    flag('scans', 'Orbital scans of tremors under the base and strike targets.'),
    ticks('scanCentreAt', 'First scan over the centre.'),
    flag('core', 'Work the derelict core.'),
    flag('coreEarly', 'Time the core tug to the gate opening.'),
    flag('coreBomb', 'Drop a spent towed core on the focus.'),
    flag('lens', 'Research Lancer Lens once enemy aircraft are seen under the Lancers.'),
  ],
};

/** The plane's knobs: the common ones, its tier fields, then its reserve and the two bot options. */
function knobsOf(plane: Plane): readonly TierKnob[] {
  return [...COMMON, ...PLANE_KNOBS[plane]];
}

/** The tier a starter plays before knobs: the sandbox tier over its level at the level's default bot options. */
function sandboxTier(plane: Plane, options: Readonly<Partial<BotOptions>> | null): Tier {
  const { level, tier } = SANDBOX_TIERS[plane];
  return { ...botTier(level, options), ...tier };
}

/** A tier value as its knob shows it (Infinity: the knob's never). */
function knobValue(k: TierKnob, value: Tier[keyof Tier]): number | boolean | string {
  if (k.kind === 'ticks') return value === Infinity ? NEVER_TICKS : (value as number);
  if (k.kind === 'army') return value === Infinity ? NEVER_ARMY : (value as number);
  return value as number | boolean | string;
}

/**
 * `plane`'s knobs as a JSON Schema (PlayerThree's starter knob rules: every property bounded or enumerated, with its
 * sandbox-tier default). Plain JSON, the same every call.
 */
export function starterKnobs(plane: Plane): Record<string, unknown> {
  const tier = sandboxTier(plane, null);
  const level = SANDBOX_TIERS[plane].level;
  const properties: Record<string, unknown> = {};
  for (const k of knobsOf(plane)) {
    const value = knobValue(k, tier[k.field]);
    const base = { description: k.text, default: value };
    properties[k.field] = k.kind === 'flag' ? { type: 'boolean', ...base }
      : k.kind === 'choice' ? { type: 'string', enum: [...k.options], ...base }
      : k.kind === 'rate' ? { type: 'number', minimum: k.min, maximum: k.max, ...base }
      : { type: 'integer', minimum: k.field === 'period' ? PERIOD_MIN : k.kind === 'army' ? 1 : 0, maximum: k.kind === 'ticks' ? NEVER_TICKS : k.kind === 'army' ? NEVER_ARMY : k.max, ...base };
  }
  properties.reserve = { type: 'integer', minimum: 0, maximum: RESERVE_MAX, description: `Alloy this seat keeps before optional production and building.`, default: tier.reserve[plane] };
  properties.aggression = { type: 'number', minimum: 0, maximum: 1, description: 'Lobby bot option: higher commits smaller armies earlier and shortens offensive delays (scales the army sizes and offensive times above unless set).', default: BOT_DEFAULTS[level].aggression };
  properties.economyReserve = { type: 'number', minimum: 0, maximum: 1, description: 'Lobby bot option: higher keeps more alloy back (scales every reserve unless reserve is set).', default: BOT_DEFAULTS[level].economyReserve };
  return { type: 'object', additionalProperties: false, description: `The ${plane} bot's ${level} tier, bounded for the policy sandbox (bots/tuning.ts SANDBOX_TIERS). Every knob is optional.`, properties };
}

/** Starter knobs as a deploy passes them (validated against starterKnobs; null: none). */
export type StarterKnobs = Readonly<Record<string, number | boolean | string>> | null;

/**
 * One seat of `Bot` (a plane bot class, or a fork's subclass) at `plane`'s sandbox tier with `knobs` applied: the bot
 * options first (they rescale the tier), then every tier knob set. `createPolicy(knobs)` of a starter module.
 */
export function starterPolicy(Bot: PlaneBotClass, plane: Plane, knobs: StarterKnobs): BotPolicy {
  const options: Partial<BotOptions> = {};
  if (typeof knobs?.aggression === 'number') options.aggression = knobs.aggression;
  if (typeof knobs?.economyReserve === 'number') options.economyReserve = knobs.economyReserve;
  const tier: Record<string, unknown> = { ...sandboxTier(plane, options) };
  for (const k of knobsOf(plane)) {
    const value = knobs?.[k.field];
    if (value === undefined) continue;
    tier[k.field] = (k.kind === 'ticks' && value as number >= NEVER_TICKS) || (k.kind === 'army' && value as number >= NEVER_ARMY) ? Infinity : value;
  }
  if (typeof knobs?.reserve === 'number') tier.reserve = { ...(tier.reserve as Tier['reserve']), [plane]: knobs.reserve };
  const { level } = SANDBOX_TIERS[plane];
  return botPolicy(Bot, { plane, level, tier: tier as unknown as Tier }, null);
}
