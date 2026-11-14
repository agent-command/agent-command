// Agent Command's built-in bot library: packages/game/src/bots/tuning.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * Built-in bot tuning: the difficulty tiers and the named numbers the plane bots play by. These are bot choices, not
 * match rules: distances in tiles, durations in ticks, alloy and energy in resource units. Match numbers always come
 * from the compiled rules a bot reads (Ctx.econ, Ctx.stats, MatchData.rules), never from here.
 */
import { BOT_DEFAULTS, } from '../rules/opponents.js';
import { toTicks } from '../rules/vocabulary.js';
import { Rng } from '../util/rng.js';



/** Beneficiary units owned or queued before buying research (every tier; tiers add their digger crew). A sapper owned or queued means sapper waves run, so Shaped Charges pay. */
const RESEARCH_MINIMUM = { bastion: 2, skiff: 3, interceptor: 2, sapper: 1 };
export const TIERS = {
  novice: {
    period: toTicks(4),
    aggressionShift: 0,
    rallySkew: 0,
    tieOrder: 0,
    queueDepth: 1,
    diggers: 5,
    defuse: false,
    tunnelAt: Infinity,
    sappers: 0,
    railAt: Infinity,
    backfill: false,
    faultAt: Infinity,
    breachFrom: Infinity,
    breachEvery: Infinity,
    breachGuard: false,
    mix: { trooper: 3, tank: 1 },
    armyCap: 16,
    holdCenterAt: Infinity,
    attackAt: 10,
    suddenDeathPush: false,
    turrets: 0,
    homeShaftAt: Infinity,
    midShaft: false,
    tremorResponse: false,
    raid: false,
    adaptive: false,
    interceptors: 3,
    screenFirst: false,
    bombers: 0,
    gunships: 0,
    gunPlatforms: 0,
    lancers: 0,
    relays: 0,
    recaptureEvery: toTicks(120),
    defendIslands: false,
    solar: 3,
    foldArrays: false,
    tugs: 0,
    strikeEvery: toTicks(90),
    scans: false,
    scanCentreAt: Infinity,
    scanCentreEvery: Infinity,
    core: false,
    coreEarly: false,
    coreBomb: false,
    coreTies: 3,
    coreTieRest: toTicks(200),
    headframes: 1,
    headframeAt: toTicks(90),
    lodeMiners: 1,
    steal: false,
    motherCrew: 0,
    richCrew: 0,
    bridgeWars: false,
    overMine: false,
    faultGuards: 0,
    bulkheads: 0,
    wardens: 0,
    wardenPushAt: Infinity,
    troopersDown: 0,
    repair: false,
    raidLodes: false,
    postGuards: 0,
    contestPosts: false,
    pointSquad: 0,
    pointAt: Infinity,
    pointCentre: false,
    pointDigIn: false,
    deploy: 'none',
    skyWeather: 'escape',
    lens: false,
    reserve: { depths: 0, surface: 60, sky: 250, orbit: 250 },
    // Novice buys no research.
    researchMinimum: { ...RESEARCH_MINIMUM, digger: Infinity },
    leaderPenalty: 0,
    signals: { answer: false, ask: false, units: 0, tasks: 0, reserve: 0 },
    breachers: 0,
    drillYardAt: Infinity,
    routeSearches: Infinity,
    routeReuse: 0,
    prepareAhead: false,
    gateWalks: Infinity,
  },
  standard: {
    period: toTicks(1.5),
    aggressionShift: 0,
    rallySkew: 0,
    tieOrder: 0,
    queueDepth: 2,
    diggers: 9,
    defuse: true,
    tunnelAt: Infinity,
    sappers: 2,
    railAt: toTicks(240),
    backfill: true,
    faultAt: toTicks(420),
    breachFrom: toTicks(300),
    breachEvery: toTicks(180),
    breachGuard: true,
    mix: { trooper: 3, tank: 2, flak: 1 },
    armyCap: 30,
    holdCenterAt: 10,
    attackAt: 14,
    suddenDeathPush: true,
    turrets: 1,
    homeShaftAt: toTicks(150),
    midShaft: true,
    tremorResponse: false,
    raid: true,
    adaptive: false,
    interceptors: 4,
    screenFirst: false,
    bombers: 2,
    gunships: 2,
    gunPlatforms: 0,
    lancers: 2,
    relays: 2,
    recaptureEvery: toTicks(30),
    defendIslands: true,
    solar: 7,
    foldArrays: true,
    tugs: 2,
    strikeEvery: 0,
    scans: true,
    scanCentreAt: toTicks(60),
    scanCentreEvery: toTicks(180),
    core: true,
    coreEarly: false,
    coreBomb: false,
    coreTies: 3,
    coreTieRest: toTicks(200),
    headframes: 3,
    headframeAt: toTicks(45),
    lodeMiners: 2,
    steal: false,
    motherCrew: 2,
    richCrew: 2,
    bridgeWars: true,
    overMine: false,
    faultGuards: 1,
    bulkheads: 1,
    wardens: 2,
    wardenPushAt: toTicks(240),
    troopersDown: 3,
    repair: true,
    raidLodes: true,
    postGuards: 2,
    contestPosts: false,
    pointSquad: 3,
    pointAt: toTicks(5),
    pointCentre: false,
    pointDigIn: false,
    deploy: 'basic',
    skyWeather: 'route',
    lens: false,
    reserve: { depths: 0, surface: 40, sky: 80, orbit: 100 },
    researchMinimum: { ...RESEARCH_MINIMUM, digger: 7 },
    leaderPenalty: 0,
    signals: { answer: true, ask: true, units: 4, tasks: 2, reserve: 1 },
    breachers: 2,
    drillYardAt: 12,
    routeSearches: Infinity,
    routeReuse: 0,
    prepareAhead: false,
    gateWalks: Infinity,
  },
  veteran: {
    period: toTicks(0.5),
    aggressionShift: 0,
    rallySkew: 0,
    tieOrder: 0,
    queueDepth: 2,
    diggers: 10,
    defuse: true,
    tunnelAt: toTicks(240),
    sappers: 3,
    railAt: toTicks(90),
    backfill: true,
    faultAt: toTicks(300),
    breachFrom: toTicks(360),
    breachEvery: toTicks(150),
    breachGuard: true,
    mix: { trooper: 3, tank: 2, flak: 1 },
    armyCap: 45,
    holdCenterAt: 14,
    attackAt: 18,
    suddenDeathPush: true,
    turrets: 1,
    homeShaftAt: toTicks(120),
    midShaft: true,
    tremorResponse: true,
    raid: true,
    adaptive: true,
    interceptors: 4,
    screenFirst: true,
    bombers: 2,
    gunships: 3,
    gunPlatforms: 2,
    lancers: 3,
    relays: 2,
    recaptureEvery: toTicks(10),
    defendIslands: true,
    solar: 8,
    foldArrays: true,
    tugs: 2,
    strikeEvery: 0,
    scans: true,
    scanCentreAt: toTicks(45),
    scanCentreEvery: toTicks(120),
    core: true,
    coreEarly: true,
    coreBomb: true,
    coreTies: 2,
    coreTieRest: toTicks(140),
    headframes: 3,
    headframeAt: toTicks(30),
    lodeMiners: 3,
    steal: true,
    motherCrew: 4,
    richCrew: 3,
    bridgeWars: true,
    overMine: true,
    faultGuards: 2,
    bulkheads: 2,
    wardens: 3,
    wardenPushAt: toTicks(180),
    troopersDown: 4,
    repair: true,
    raidLodes: true,
    postGuards: 2,
    contestPosts: true,
    pointSquad: 3,
    pointAt: toTicks(5),
    pointCentre: true,
    pointDigIn: true,
    deploy: 'sharp',
    skyWeather: 'cover',
    lens: true,
    reserve: { depths: 0, surface: 20, sky: 60, orbit: 80 },
    // Drill Bits early: the faster crew digs the tunnel toward the focus sooner.
    researchMinimum: { ...RESEARCH_MINIMUM, digger: 5 },
    // Half a map: enough to pass a leading neighbour over the other one, rarely enough to cross the map for a target.
    leaderPenalty: 0.5,
    signals: { answer: true, ask: true, units: 6, tasks: 3, reserve: 2 },
    breachers: 3,
    drillYardAt: 10,
    routeSearches: Infinity,
    routeReuse: 0,
    prepareAhead: false,
    gateWalks: Infinity,
  },
};

/**
 * The sandbox tier of each plane: a built-in tier (`level`) with its work bounded (`tier`, fields replaced) so that one
 * seat's think fits the QuickJS policy sandbox's per-call budget (manifest msPerCall) with room to spare. The starters
 * (skill `policies/<plane>.js`, bots/starter.ts) play it by default; the same bot code, only bounded.
 */
export const SANDBOX_TIERS = {
  depths: { level: 'standard', tier: { routeSearches: 0.5, routeReuse: toTicks(6), prepareAhead: true, gateWalks: 8 } },
  surface: { level: 'standard', tier: {} },
  sky: { level: 'veteran', tier: {} },
  orbit: { level: 'standard', tier: {} },
};

// ------------------------------------------------------------------ every seat

/** Beneficiary units a tier's researchMinimum asks for when it does not list the kind (also the Skiff fleet size). */
export const RESEARCH_MINIMUM_DEFAULT = 2;
/** Alloy of tier reserve per unit of economyReserve shift from the difficulty's default (botTier scales Tier.reserve). */
export const RESERVE_SCALE = 300;
/** Fewest units the aggression option may scale the attack and hold-centre armies down to. */
export const ARMY_MIN = 2;

// ------------------------------------------------------------------ personality (BotOptions.personality)

/** Most a personality moves a seat's aggression option (the result clamped to the knob's [0, 1]). */
export const PERSONALITY_AGGRESSION = 0.1;
/** Most a personality moves a seat's economy reserve option (the result clamped to [0, 1]). */
export const PERSONALITY_RESERVE = 0.1;
/** Most share a personality scales the attack and the hold-centre army size by (each its own draw). */
export const PERSONALITY_ARMY = 0.15;
/** Most share a personality scales each offensive timing by (each its own draw). */
export const PERSONALITY_TIMING = 0.15;
/** Most tiles a personality leans the forward rally point toward one flank of the army's frame (Tier.rallySkew). */
export const PERSONALITY_RALLY = 3;
/** Bits of a tie order (Tier.tieOrder): one per tie site candidate index. */
export const TIE_BITS = 32;
/** Each tie site's offset into the tie order, so an army's preferences at different sites are independent bits. */
export const TIE_SITE = { mix: 0, point: 16 };

const NO_PERSONALITY = Object.freeze({
  aggression: 0, economyReserve: 0, attackAt: 0, holdCenterAt: 0, tunnelAt: 0, faultAt: 0, breachFrom: 0, breachEvery: 0,
  strikeEvery: 0, recaptureEvery: 0, rallySkew: 0, tieOrder: 0,
});

/**
 * The traits of personality `seed` (undefined: none): one mulberry32 stream drawn in field order, so the same seed is
 * the same style on every plane of an army, in every process. Shifts are relative (army sizes and timings scale by
 * 1 + trait) and frame-relative (rally lean, tie order), so a personality favours no side of a symmetric map.
 */
export function personalityTraits(seed) {
  if (seed === undefined) return NO_PERSONALITY;
  const rng = new Rng(seed);
  const draw = (bound) => rng.range(-bound, bound);
  return {
    aggression: draw(PERSONALITY_AGGRESSION), economyReserve: draw(PERSONALITY_RESERVE),
    attackAt: draw(PERSONALITY_ARMY), holdCenterAt: draw(PERSONALITY_ARMY),
    tunnelAt: draw(PERSONALITY_TIMING), faultAt: draw(PERSONALITY_TIMING), breachFrom: draw(PERSONALITY_TIMING),
    breachEvery: draw(PERSONALITY_TIMING), strikeEvery: draw(PERSONALITY_TIMING), recaptureEvery: draw(PERSONALITY_TIMING),
    rallySkew: draw(PERSONALITY_RALLY),
    // Never 0: 0 is the default bot's declaration and frame order. Any non-zero order of TIE_BITS (32) bits.
    tieOrder: rng.int(0xffffffff) + 1,
  };
}

/**
 * Does tie order `tieOrder` prefer the candidate at `index` (declaration or frame order, 1 on) at tie site `site` over
 * the first equally ranked one before it? Never with tie order 0 (the default bot): the first stays.
 */
export function tieWins(tieOrder, site, index) {
  return ((tieOrder >>> ((site + index) % TIE_BITS)) & 1) === 1;
}

/**
 * A difficulty's tier with a seat's bot options (aggression, economy reserve; validated, any omitted field the
 * difficulty's default) applied: shifts from the defaults scale the army sizes, the offensive timings and the reserves.
 * A personality (featured matches) moves both options within its bounds, scales each army size and offensive timing
 * a little more, and sets the rally lean and the tie order; without one every trait is 0 and the tier is exactly the
 * options' (x + 0 and x × 1 are exact).
 */
export function botTier(level, options) {
  const base = TIERS[level];
  const defaults = BOT_DEFAULTS[level];
  const traits = personalityTraits(options?.personality);
  const aggression = Math.min(1, Math.max(0, (options?.aggression ?? defaults.aggression) + traits.aggression)) - defaults.aggression;
  const reserve = Math.min(1, Math.max(0, (options?.economyReserve ?? defaults.economyReserve) + traits.economyReserve)) - defaults.economyReserve;
  const offensiveTime = (ticks, trait) => Number.isFinite(ticks) ? Math.max(0, Math.round(ticks * (1 - aggression) * (1 + trait))) : ticks;
  return {
    ...base,
    aggressionShift: aggression,
    rallySkew: traits.rallySkew,
    tieOrder: traits.tieOrder,
    attackAt: Math.max(ARMY_MIN, Math.round(base.attackAt * (1 - aggression) * (1 + traits.attackAt))),
    holdCenterAt: Number.isFinite(base.holdCenterAt) ? Math.max(ARMY_MIN, Math.round(base.holdCenterAt * (1 - aggression) * (1 + traits.holdCenterAt))) : base.holdCenterAt,
    tunnelAt: offensiveTime(base.tunnelAt, traits.tunnelAt), faultAt: offensiveTime(base.faultAt, traits.faultAt),
    breachFrom: offensiveTime(base.breachFrom, traits.breachFrom), breachEvery: offensiveTime(base.breachEvery, traits.breachEvery),
    strikeEvery: offensiveTime(base.strikeEvery, traits.strikeEvery),
    recaptureEvery: offensiveTime(base.recaptureEvery, traits.recaptureEvery),
    reserve: {
      depths: Math.max(0, base.reserve.depths + reserve * RESERVE_SCALE),
      surface: Math.max(0, base.reserve.surface + reserve * RESERVE_SCALE),
      sky: Math.max(0, base.reserve.sky + reserve * RESERVE_SCALE),
      orbit: Math.max(0, base.reserve.orbit + reserve * RESERVE_SCALE),
    },
  };
}
/** Permanently blocked reasons (own entries only). `producer` is conditional: tidyQueue retains living unpowered producers, cancels missing/dead ones. */
export const GIVE_UP = { occupied: true, blocked: true, not_held: true, segment_destroyed: true };
/** At most one defence reorder per seat this often. */
export const DEFENCE_REORDER = toTicks(10);
/** Alloy kept spare beyond a project's own cost: rail, bulkheads, and turrets beyond the surface reserve. */
export const SPARE_ALLOY = 40;
/** Tiles around our Spire that count as home: charges, chasms, holes, intruders and threats within it are ours to answer. */
export const HOME_RADIUS = 14;
/**
 * Hostile Surface fighters on our side of the map (nearer our Spire than theirs) worth more than this many times our whole
 * Surface force (alloy + energy) outmatch it: squads come back and the army stands at the Spire.
 */
export const OUTMATCHED = 1;
/**
 * Tiles around a Spire that count as its base: enemy turrets within theirs form its ring, tremors beyond ours are
 * their economy at work, troopers within ours answer tremors under it.
 */
export const BASE_RADIUS = 12;
/**
 * Tiles from a Spire, along both axes of its army's frame toward the map centre, of its forward rally point (ours) or
 * main lane (the focus's).
 */
export const FRONT_OFFSET = 11.5;
/** Tiles inside a unit's sight radius a spot must lie to count as seen (build sites, remembered structures). */
export const VISION_MARGIN = 1.5;
/** Tiles within which two observed points are the same spot (a destroyed structure, a unit at its post, an island). */
export const AT_POINT = 0.5;
/** A structure or queued site within this many tiles of a lode outcrop's centre stands on it. */
export const LODE_SITE_REACH = 1;
/** Enemy fighters within this many tiles of one of our diggers are attacking our miners. */
export const MINER_GUARD_RADIUS = 6;
/** Fewest troopers that go down as a squad (breach, raid) or dig up together to breach. */
export const SQUAD_MIN = 3;

// ------------------------------------------------------------------ crowns (rules.spire.lossRule 'crowns')

/** The Orbit fleet sieges the focus's Orbit segment at this fraction of its usual margin while it is the weakest crown. */
export const CROWN_SIEGE_PUSH = 0.6;
/** A Depths squad takes the focus's root from a known tunnel cell within this many tiles of the root's footprint edge. */
export const ROOT_APPROACH = 1.5;

// ------------------------------------------------------------------ enemy memory and threats

/** Enemy turrets near their Spire that make it a static defence to siege rather than walk into. */
export const SIEGE_TURRETS = 3;
/** Enemy diggers seen lately plus tremors away from home that make their depths economy worth a raid (PlaneBot.greed). */
export const GREED = 6;
/** Ticks an enemy digger sighting counts toward greed (PlaneBot.greed) and stays a raid target. */
export const DIGGER_MEMORY = toTicks(60);
/** An enemy digger sighting is dropped once one of our depths units stands within this many tiles of it and sees nothing. */
export const DIGGER_CHECK_REACH = 2;
/** In the depths a remembered structure counts as looked at only from this many tiles (rock hides the rest). */
export const DEPTHS_LOOK_REACH = 1.5;
/** A raid goes in while we see fewer enemy fighters (troopers, sappers) in the depths than this. */
export const RAID_ODDS = 3;
/** An asteroid barrage: every this many enemy strikes within STRIKE_WINDOW add two interceptors to the screen. */
export const STRIKES_PER_PAIR = 6;
/** Ticks an enemy asteroid strike counts toward a barrage. */
export const STRIKE_WINDOW = toTicks(120);
/** Tanks a siege needs before they move up to shell the ring. */
export const SIEGE_TANKS = 3;
/** Surface route regions avoid ground within an enemy's weapon range plus this many tiles. */
export const THREAT_MARGIN = 2;
/** Surface route regions avoid this many tiles beyond a burning scorch's radius. */
export const SCORCH_MARGIN = 0.5;

// ------------------------------------------------------------------ orbit fleet combat (every seat's Orbit units)

/** Our hull × damage must beat the enemy's by this factor before a fleet engages (tier defaults reject even trades). */
export const ORBIT_TRADE_MARGIN = 1.35;
/** Fleet hull² × efficiency over the enemy segment's damage × HP needed to siege it; also sizes the Lancer fleet. */
export const ORBIT_SIEGE_MARGIN = 2.7;

// ------------------------------------------------------------------ depths

/** Enemy charges near home defused at once, and depths units standing on each. */
export const DEFUSE_CHARGES = 2;
export const DEFUSE_SQUAD = 2;
/** An intruder alert with no trooper below asks the Surface for this many troopers more than the intruders counted. */
export const INTRUDER_MARGIN = 1;
/** One digger collects below-ground ore caches per this many diggers (at least one). */
export const DIGGERS_PER_CACHE_HAND = 4;
/** A below-ground cache is unsafe while an enemy depths unit is within its weapon range plus this many tiles. */
export const DEPTHS_CACHE_MARGIN = 3;
/** Farthest a digger is sent to collect a below-ground cache, in tiles. */
export const DEPTHS_CACHE_REACH = 16;
/**
 * Diggers kept on the economy (cache hands count) however many maintenance jobs (rail, backfill, fault guard, wall
 * repair) want workers. A hand stays one until it is lost or committed elsewhere: re-picking them every decision handed
 * a released job straight back to the worker it was taken from.
 */
export const ECONOMY_HANDS = 2;
/**
 * Cells of clearance a committed safe worker walk may lose against the band it was planned with before it is planned
 * again: an observed weapon envelope shifting by a cell re-sent the walk each decision, turning the worker round.
 */
export const WALK_HOLD_SLACK = 1;
/**
 * Cells ahead of a worker walking to its ore that must still hold for it to keep that ore: danger observed farther
 * along (at the ore, or cutting the way there) is judged again as the worker nears it, not at once. Dropped at once, a
 * rival digger or envelope settling over a distant ore sent the worker round to another ore, and back again.
 */
export const ORE_HOLD_REACH = 8;
/**
 * The route to new ore (once connected ore runs out) stays published until connected ore a worker can serve has stood
 * this long: dropped and published again as that flickered, its tags pulled default workers to the frontier and back.
 */
export const EXPAND_SETTLE = toTicks(20);
/**
 * Our dig tags stay published this long after the last decision whose plan wanted them: a route re-planned each decision
 * flickers with observed danger, servable ore and reach, and each tag withdrawn and published again sent its
 * designation workers away and back.
 */
export const TAG_SETTLE = toTicks(3);
/**
 * A bridger that reached its lake unpaid (another lane's hold took the funds on the way) waits there this long for them
 * before it is let go: released at once, it walked off to mine and the next bridger walked the whole way back.
 */
export const BRIDGE_FUNDS_WAIT = toTicks(20);
/**
 * A bridger not bridging this long after it was sent lost its order on the way (another job took it): it is let go.
 * Kept, it held the one bridge slot and no other bridge toward the rich ore was planned for minutes.
 */
export const BRIDGE_JOB_MAX = toTicks(45);
/**
 * After one of our lava bridges falls (a charge, fire), no bridge is planned for this long: rebuilt at once under the
 * hostile that cut it, it fell again with its alloy. Then the crossing is planned afresh (rebuilt, or the way round).
 */
export const BRIDGE_REBUILD_CALM = toTicks(45);
/** Fewest diggers before bridges toward green rich ore are paid for: the home economy first, then the far ore. */
export const RICH_BRIDGE_DIGGERS = 6;
/** Our depths walks start this many cells along +x (canonical frame) from our Spire's cell: the open root pocket beside it. */
export const ROOT_POCKET_DX = 2;
/** The rail runs to the cell this many tiles short of the map midpoint on our side (canonical frame: up-left of it). */
export const RAIL_GOAL_OFFSET = 1;
/** Ticks between checks on the rail layer. */
export const RAIL_CHECK_EVERY = toTicks(10);
/** Alloy kept spare beyond a backfill's cost. */
export const BACKFILL_SPARE = 30;
/** Diggers kept on home ore before any joins the Mother Lode crew. */
export const MOTHER_LODE_HOME = 5;
/**
 * A contested Mother Lode cell (as near a hostile Spire as ours) counts for a stealing crew only once no hostile Depths
 * unit has been seen near it for this long. Taken whenever the hostile crew was out of sight and given up whenever it
 * came back into sight, it kept both crews' diggers walking toward the lode and away again.
 */
export const LODE_CONTEST_CALM = toTicks(30);
/**
 * A digger a crew (lode pocket, rich ore, Mother Lode) let go because its way there turned unsafe joins no crew again
 * for this long. Recruited again the moment it stood clear, it walked straight back toward the danger.
 */
export const CREW_REJOIN = toTicks(30);
/** Cells beyond the Mother Lode's blast (ringWidth + rules.depths.lodeVentBlastReach) a unit still runs from while the fuse burns. */
export const LODE_FLEE_MARGIN = 1;
/** Fewest diggers before the tunnel toward the enemy Spire is designated. */
export const TUNNEL_DIGGERS = 5;
/** Undermine durations between two sapper waves. */
export const SAPPER_WAVE_GAP = 2;
/** A squad breaches up BREACH_MIN–BREACH_MAX tiles from the enemy Spire: just outside its beam, inside their base. */
export const BREACH_MIN = 7.5;
export const BREACH_MAX = 11;
/** A breach cell keeps this many tiles from enemy structures (it comes up on open ground). */
export const BREACH_CLEARANCE = 1.5;
/** Ticks idle troopers below wait for a breach site before going back up. */
export const IDLE_RETURN = toTicks(20);
/** Tiles from the focus's Spire centre, along both axes of its frame toward the map centre, of the tunnel cell a charge collapses it from. */
export const CHARGE_OFFSET = 1.6;
/** Ore this close to a hostile Spire is not ours to expose. */
export const ENEMY_ORE_KEEP_OUT = 10;
/** A tunnel target is bridged toward only when the bridged route costs at least this many bridges/digs less than the dry way round. */
export const LAKE_BRIDGE_SAVING = 4;
/** Tiles within which an armed hostile makes bridgeWars tiers wall a Warden beside an own lava bridge. */
export const BRIDGE_GUARD_REACH = 6;
/** Warden posts: the cavern-route choke this many tiles from home (nearest 1-wide cell in the band, else the band's first route cell). */
export const WARDEN_POST_MIN = 6;
export const WARDEN_POST_MAX = 11;
/** Ticks between Warden post re-plans. */
export const WARDEN_POST_EVERY = toTicks(10);
/** A Warden this close (tiles) to its goal is there (it walls, fortifies or flares instead of walking). */
export const WARDEN_AT = 1;
/** Enemy depths units within this many tiles of a Warden make it raise its shield wall. */
export const WARDEN_ALERT = 6;
/** A walled Warden with no enemy within WARDEN_ALERT for this long lowers its wall. */
export const WARDEN_CALM = toTicks(6);
/** Flares land on route cells at least this far ahead (tiles): nearer ones the Warden already sees. */
export const WARDEN_FLARE_MIN = 3;
/** Troopers pushing with Wardens stand this many route cells behind the lead Warden (out of enemy Warden range, inside cover). */
export const TROOPER_BEHIND = 1;
/** Wardens that advance without troopers once the push is ready (raiding remembered enemy diggers, else contesting the centre chamber); the rest hold the post. */
export const WARDEN_RAID_PAIR = 2;
/** Tiles from our Spire within which the depths seat guards faults and repairs cracking walls. */
export const HOME_WORKS = 16;
/** Band of tiles from our Spire where bulkheads cut the cavern route toward the centre. */
export const CAVERN_GATE_MIN = 7;
export const CAVERN_GATE_MAX = 12;
/** Tiles from a hole near home within which bulkheads cut the routes from it. */
export const MOUTH_GATE_REACH = 3;
/** Ticks before a bulkhead site is asked for again. */
export const GATE_RETRY = toTicks(30);
/** Walls repaired at once, and the crack stage from which a wall near home is repaired. */
export const REPAIRS_MAX = 2;
export const REPAIR_STAGE = 2;
/** A repair job is dropped after REPAIR_TIMEOUT ticks, or after REPAIR_IDLE ticks with its digger idle. */
export const REPAIR_TIMEOUT = toTicks(20);
export const REPAIR_IDLE = toTicks(2);
/** A cracked wall whose repair fortify was refused when its digger got there is not sent again for this long. */
export const REPAIR_RETRY = toTicks(30);
/** Our digger working within this many tiles of a cracked wall is the one cracking it (no repair). */
export const WALL_WORK_REACH = 1.6;
/** Fault cells left free at each end of a fault, so the chasm opens fully both ways. */
export const FAULT_END_ROOM = 4;
/** Band of tiles from the enemy Spire for the fault cell we open. */
export const FAULT_MIN = 9;
export const FAULT_MAX = 15;

// ------------------------------------------------------------------ surface

/** Ticks troopers sent down stay out of army orders on their way to the portal. */
export const DOWN_MEMORY = toTicks(30);
/** Ticks a lode scout stays out of army orders. */
export const SCOUT_MEMORY = toTicks(20);
/** The army holds the centre this many tiles short of the map midpoint on our side (canonical frame: up-left of it). */
export const HOLD_CENTRE_OFFSET = 1.5;
/** Per-decision decay of the remembered enemy surface army value. */
export const ENEMY_VALUE_DECAY = 0.995;
/** Adaptive counter-mix: every kind's weight starts at COUNTER_BASE; the counter to the enemy's heavier arm gets COUNTER_BONUS more. */
export const COUNTER_BASE = 2;
export const COUNTER_BONUS = 2;
/** Enemy aircraft in sight above which the counter-mix weighs flak FLAK_VS_AIR instead of FLAK_BASE. */
export const AIR_THREAT = 2;
export const FLAK_BASE = 1;
export const FLAK_VS_AIR = 2;
/** Tiles from an own Surface structure within which a telegraphed hostile impact counts as an air threat (flak demand). */
export const FLAK_DROP_RADIUS = 12;
/** Army weights against a turret ring: tanks out-range turrets. */
export const SIEGE_MIX = { trooper: 2, tank: 4, flak: 1 };
/**
 * Deploy stances (Tier.deploy). A tank sieges when a visible hostile structure (or, 'sharp' while holding, a ground
 * unit) lies within siege reach less SIEGE_REACH_SLACK tiles, and packs when a hostile ground unit comes within
 * siegeMinRange + SIEGE_THREAT_MARGIN of it (inside its blind spot) or nothing has been in reach for DEPLOY_CALM.
 */
export const SIEGE_REACH_SLACK = 0.5;
export const SIEGE_THREAT_MARGIN = 1.5;
export const DEPLOY_CALM = toTicks(8);
/**
 * Idle holding troopers dig in when a hostile ground unit is within DIG_ALERT tiles ('sharp': DIG_ALERT_SHARP, before
 * contact). Never without a foe in sight: troopers dug in at the rally would never reach their hold posts.
 */
export const DIG_ALERT = 10;
export const DIG_ALERT_SHARP = 14;
/**
 * Flak within FLAK_DROP_RADIUS of our Spire or a Headframe emplaces under a hostile drop marker there or a hostile
 * aircraft within its emplaced range plus FLAK_ALERT_MARGIN.
 */
export const FLAK_ALERT_MARGIN = 3;
/** Ticks after our surface Spire segment is hit during which our next fighter or turret jumps the queue. */
export const UNDER_ATTACK_WINDOW = toTicks(5);
/** Tick from which turrets are built, and placements tried per wanted turret (a rejected site is not retried). */
export const TURRETS_FROM = toTicks(30);
export const TURRET_TRIES = 3;
/** Turret anchors in tiles from our Spire (canonical frame), tried in turn. */
export const TURRET_SPOTS = [[9, 7], [7, 9], [10, 10]];
/** Tiles around a turret anchor searched for a buildable site. */
export const TURRET_SPOT_RADIUS = 3;
/** Sites tried for the mid Shaft, which aims this many tiles short of the map midpoint on our side. */
export const MID_SHAFT_TRIES = 3;
export const MID_SHAFT_OFFSET = 2.5;
/** The home Shaft aims this many tiles from our Spire centre toward the map centre (over the home cavern), searching this far round it. */
export const HOME_SHAFT_OFFSET = 4;
export const HOME_SHAFT_RADIUS = 4;
/** Enemy surface units within this many tiles contest a lode site. */
export const CONTEST_RADIUS = 8;
/** HOLD_MIN fighters within HOLD_RADIUS tiles hold a contested lode site or a sweep point. */
export const HOLD_RADIUS = 5;
export const HOLD_MIN = 3;
/** Ticks before a Headframe is tried on the same outcrop again. */
export const LODE_RETRY = toTicks(20);
/** The flank lode zones lie around the points 1/FLANK_INSET of the map in from two edges, at the Spire-free corners. */
export const FLANK_INSET = 6;
/** The lode sweep visits each zone anchor and four rim points at this fraction of the zone's radius. */
export const ZONE_SWEEP = 0.7;
/** Surface units under a known hostile charge (alert charge_under) step this many tiles past its collapse reach. */
export const CHARGE_CLEAR = 1;
/** Tremors within TREMOR_ALARM or charges within CHARGE_ALARM tiles of our Spire send TREMOR_SQUAD troopers down. */
export const TREMOR_ALARM = 7;
export const CHARGE_ALARM = 6;
export const TREMOR_SQUAD = 3;
/** Ticks between two squads sent down against tremors. */
export const TREMOR_REPEAT = toTicks(30);
/** Troopers in a raid or breach squad, nearest home first. */
export const SQUAD_MAX = 5;
/** Ticks between two raid or guard squads. */
export const RAID_REPEAT = toTicks(45);
/** Enemy breaches within BREACH_ALARM tiles of our Spire are met by our units within BREACH_RESPONSE tiles of it. */
export const BREACH_ALARM = 18;
export const BREACH_RESPONSE = 22;
/** Ticks between two army orders. */
export const ORDER_EVERY = toTicks(3);
/** Units detached to surface caches: one per ARMY_PER_COLLECTOR, at most COLLECTORS_MAX. */
export const COLLECTORS_MAX = 2;
export const ARMY_PER_COLLECTOR = 3;
/** A surface cache is unsafe while an enemy is within its weapon range plus the cache radius plus this many tiles. */
export const SURFACE_CACHE_MARGIN = 2;
/** Fraction of full HP a cache collector needs. */
export const COLLECTOR_HP = 0.6;
/** Farthest a unit is detached to a surface cache, in tiles. */
export const SURFACE_CACHE_REACH = 18;
/** A collector's spot lies within the cache radius less this many tiles of its centre (at least this far). */
export const CACHE_SPOT_INSET = 0.5;
/** A collector within this fraction of the cache radius from its centre is collecting already. */
export const CACHE_CLOSE = 0.7;
/** Every ESCALATE_EVERY ticks the attack threshold drops by ESCALATE_STEP units, down to 1/ESCALATE_FLOOR of the tier's. */
export const ESCALATE_EVERY = toTicks(120);
export const ESCALATE_STEP = 2;
export const ESCALATE_FLOOR = 3;
/** An attack stance divides the attack threshold by this. */
export const ATTACK_STANCE_DIVISOR = 2;
/** Adaptive: an army of AHEAD_ARMY units worth AHEAD_RATIO × the enemy's value (at least AHEAD_FLOOR) attacks early. */
export const AHEAD_ARMY = 10;
export const AHEAD_RATIO = 1.5;
export const AHEAD_FLOOR = 400;
/** An attack falls back below this fraction of the attack threshold; the centre is given up below ABANDON_SHARE of the hold threshold. */
export const RETREAT_SHARE = 0.4;
export const ABANDON_SHARE = 0.5;
/** The gunners attack the Spire directly while fewer than SPIRE_GUARDS_MAX enemies stand within SPIRE_GUARD_RADIUS tiles of the army. */
export const SPIRE_GUARD_RADIUS = 8;
export const SPIRE_GUARDS_MAX = 3;
/** Tiles units without a vantage post may stray from the centre or the front they hold. */
export const HOLD_SLACK_CENTRE = 4;
export const HOLD_SLACK_FRONT = 5;
/** Tiles searched for vantage posts around a held point; widened to VANTAGE_WIDE when too few. */
export const VANTAGE_RADIUS = 5;
export const VANTAGE_WIDE = 10;
/** Floor for a siege direction's length (a target on our Spire), in tiles. */
export const DIRECTION_EPS = 1e-6;
/** Tiles around a siege position searched for walkable ground. */
export const SIEGE_SPOT_RADIUS = 3;
/** Without enough tanks the army waits this many tiles beyond turret range; else the rest stands SIEGE_REAR tiles behind the tanks. */
export const SIEGE_WAIT_MARGIN = 4;
export const SIEGE_REAR = 2;
/** Forward posts: troopers farther than POST_REACH tiles from a post are not detached to it. */
export const POST_REACH = 24;
/** Surface units below POST_HEAL_SHARE of max HP with no enemy within POST_SAFE_RADIUS tiles fall back to heal at the nearest post we hold. */
export const POST_HEAL_SHARE = 0.5;
export const POST_SAFE_RADIUS = 8;
/**
 * Contested point squad members take seats round their point: free open cells within this many tiles of it, joined to
 * the side of it they walk to (cliffs cut the slots the simulation spreads round a point), inside the capture radius
 * first.
 */
export const POINT_SEAT_REACH = 4;
/** Drill Yard site: canonical offset from our Spire centre (behind the turret spots), searched within DRILL_YARD_SPOT_RADIUS tiles. */
export const DRILL_YARD_SPOT = [6, 6];
export const DRILL_YARD_SPOT_RADIUS = 4;
/** Troopers left in the army when converting: never convert below this many. */
export const CONVERT_KEEP_TROOPERS = 4;
/** A trooper sent to convert stays out of army orders this long (walk plus line plus conversion). */
export const CONVERT_MEMORY = toTicks(30);
/** Breachers go for dug-in troopers and turrets within this many tiles of the army; farther ones are left to the army plan. */
export const BREACHER_HUNT = 10;

// ------------------------------------------------------------------ sky

/** Storm drift the Sky planners forecast ahead: about the time an escape at storm speed takes. */
export const STORM_LEAD = toTicks(4);
/** Escape points also stay clear of where storms will be this many STORM_LEADs ahead. */
export const LATER_LEADS = 3;
/** Tiles kept between an escape or detour point and a forecast storm edge. */
export const STORM_MARGIN = 1;
/** Escape bearings tried around a storm: straight out from its forecast centre first, then turned up to 90°. */
export const ESCAPE_TURNS = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2, -Math.PI / 2];
/** A jet-lane route must take at most this fraction of the straight flight's time. */
export const JET_GAIN = 0.8;
/** Jet-lane waypoints within this many tiles of the flight's start or end are skipped. */
export const WAYPOINT_MIN = 1;
/** Squared tiles below which a flight passes a storm's dead centre. */
export const DEAD_CENTRE_EPS = 1e-12;
/** Detour points tried per side of a storm, each 1/DETOUR_STEPS of its margin radius wider. */
export const DETOUR_STEPS = 4;
/** Enemy flak this close to a bomber target makes a storm-hidden approach worth its damage (veteran). */
export const FLAK_COVER = 8;
/** Farthest a covering storm's edge may sit from the target. */
export const COVER_REACH = 6;
/** A covering stage point sits this many tiles inside the storm edge. */
export const COVER_DEPTH = 1;
/** A covered approach may fly at most COVER_DETOUR_RATIO × the direct flight plus COVER_DETOUR_SLACK tiles. */
export const COVER_DETOUR_RATIO = 1.5;
export const COVER_DETOUR_SLACK = 4;
/** At most this many extra interceptor pairs for an asteroid barrage. */
export const SCREEN_PAIRS_MAX = 2;
/** Islands held for sky control (scaled down by aggression). */
export const CONTROL_ISLANDS = 2;
/** Energy above which a seat holding CONTROL_ISLANDS islands buys SPARE_BOMBERS bombers without sky control (the mirror tie-break). */
export const BOMBER_SPARE_ENERGY = 200;
export const SPARE_BOMBERS = 2;
/** Interceptors beyond the screen kept for Orbit raids once ascent is researched, and the most that ascend at once. */
export const RAID_INTERCEPTORS = 2;
/** Interceptors leave their island only for one nearer home than this fraction of its distance. */
export const ISLAND_SWITCH = 0.7;
/** Tiles beyond the capture radius within which enemies at our island make staying in a storm worth it. */
export const ISLAND_GUARD_MARGIN = 2;
/** Keep island assignments through brief claim changes; refresh displaced/replacement defenders independently. */
export const ISLAND_DEFENCE_HOLD = toTicks(8);
/** Minimum local capture-capable escort retained for an island investment. */
export const ISLAND_DEFENDERS = 1;
/** Interceptors per falling payload when its hull is outside current entity vision. */
export const IMPACT_SCREEN = 2;
/** Energy kept beyond rules.sky.seederCost before a Storm Seeder is switched on. */
export const SEED_SPARE_ENERGY = 20;
/** Hostile aircraft within seederRadius of our Seeder that make seeding a storm on them worth it. */
export const SEED_RAIDERS = 2;
/** Visible hostile Sky interceptors from which gunships may join the mix as brawlers (if they out-trade interceptors per cost). */
export const GUNSHIP_TRIGGER = 3;
/** One brawler gunship per this many visible hostile Sky interceptors (up to the tier's gunships). */
export const INTERCEPTORS_PER_GUNSHIP = 2;
/** Alloy worth of one energy in the bots' unit cost comparisons (the gameplay plan's cost-equivalent weighting). */
export const ENERGY_WORTH = 1.5;
/** An escorting gunship more than this many tiles from its bombers' centre is sent after them again. */
export const ESCORT_REACH = 3;
/** Tiles beyond captureRadius within which a visible hostile capture-capable aircraft threatens our island (a Gun Platform there stalls the capture). */
export const EMPLACE_THREAT = 6;
/** Own aircraft below this fraction of their HP fly home to repair in an Aerie hangar (aerieRepairEnabled). */
export const REPAIR_BELOW = 0.5;
/** A capture this far done is finished even inside a storm. */
export const CAPTURE_COMMITTED = 0.5;
/** Tiles within which an attack's work point is a static enemy or our island. */
export const ON_TARGET = 1.5;

// ------------------------------------------------------------------ orbit

/** Strike release slots sit this many tug radii apart along the stand-off circle: two bodies and one of clearance. */
export const SLOT_RADII = 3;
/** Solar arrays wanted beyond the energy cap over an array's day-and-night mean output. */
export const SOLAR_EXTRA = 1;
/** An array within this many tiles of its berth is there (it anchors where it stops). */
export const BERTH_AT = 0.75;
/** Fold an array below this share of its hull while no armed enemy is within FOLD_SAFE tiles; unfurl it again above FOLD_HEALED. */
export const FOLD_HP = 0.5;
export const FOLD_HEALED = 0.95;
export const FOLD_SAFE = 10;
/** Skiff raids gather this many tiles (canonical) along the focus's map edge from its Spire: past its beam and home
 * berths, by its forward fields, clear of the derelict ruin. */
export const RAID_ALONG = 12;
/** Skiffs needed before they raid forward fields instead of holding the ruin post. */
export const RAID_SKIFFS = 3;
/** Further arrays wanted while the solar bank has room: their surplus above the cap is stored, not wasted. */
export const SOLAR_BANK_EXTRA = 1;
/** Energy from which no more solar arrays are bought. */
export const ENERGY_ENOUGH = 500;
/** Tick from which tugs are bought: early enough that Orbit has a job in the first minute. */
export const TUGS_FROM = toTicks(20);
/** Enemy aircraft seen at once within beam range of an own Lancer that make a Lens-tier bot research Lancer Lens. */
export const LENS_AIRCRAFT = 3;
/** One Bastion escort per this many solar arrays and tugs. */
export const ESCORTED_PER_BASTION = 3;
/** Counters wanted per enemy unit seen: Skiffs per Lancer, Bastions per Skiff, Lancers per Bastion. */
export const SKIFFS_PER_LANCER = 2;
export const BASTIONS_PER_SKIFF = 2;
export const LANCERS_PER_BASTION = 2;
/** Against a Lancer-heavy fleet: one aegis Bastion per LANCERS_PER_AEGIS enemy Lancers, at least AEGIS_SCREEN_MIN. */
export const LANCERS_PER_AEGIS = 2;
export const AEGIS_SCREEN_MIN = 2;
/** Tugs approach a strike target from this many tiles along both axes of the focus's frame toward the map centre. */
export const APPROACH_OFFSET = 2.5;
/** Surface units above this fraction of full HP can collect an ore-rich landing. */
export const LANDING_HAND_HP = 0.5;
/** Tiles around a collector searched for an ore-rich landing spot. */
export const LANDING_RADIUS = 12;
/** Tiles kept between a landing's impact and our surface units, earlier impacts and this decision's drops. */
export const LANDING_CLEARANCE = 3;
/** Tremors within this many tiles of our Spire are scanned first. */
export const SCAN_TREMOR_RADIUS = 10;
/** Claim value multiplier of a volatile asteroid (a strike) while drops are allowed. */
export const VOLATILE_BONUS = 2;
/** Floor on tow speed in the claim score, in tiles/s (a zero tow rule). */
export const TOW_SPEED_FLOOR = 0.01;
/** Idle tugs circle TUG_LOOP_RADIUS tiles around this offset from the map centre (canonical frame), once per TUG_LOOP_PERIOD ticks. */
export const TUG_LOOP_CENTRE = { x: -4, y: 2 };
export const TUG_LOOP_RADIUS = 5;
export const TUG_LOOP_PERIOD = toTicks(60);
/** Enemy attackers on an ally that make it focused (worth an aegis). */
export const FOCUS_ATTACKERS = 2;
/** Enemy ships a sun lance must pierce to be worth its energy. */
export const LANCE_HITS_MIN = 2;
/** Derelict core: a towed core this hot (0..100, meltdown at 100) is vented or dropped. */
export const CORE_VENT_HEAT = 80;
/** A towed core heads home to be cashed in while its heat on arrival (at the tow's speed and heating) stays below this. */
export const CORE_HOME_HEAT = 90;
/** New core grapples need at least this many tugs in all, miners included: one keeps working the rocks. */
export const CORE_TUGS_MIN = 2;
/** The ruin post (core tug staging, idle fleet gather) lies this many tiles beyond the hull's outer edge, between two breaches. */
export const CORE_POST_MARGIN = 1.5;
/** Early core tugs (tier coreEarly) aim to reach the gate mouth this many ticks before the gates open. */
export const CORE_LEAD = toTicks(3);
/** A ship stays in the chamber for another sealed span only with this multiple of the radiation it would take. */
export const RADIATION_MARGIN = 1.25;
/** Armed hostile ships within this many tiles beyond the hull keep a held core inside (hauling out runs into them). */
export const CORE_THREAT_REACH = 6;
/** An armed hostile ship within its weapon range plus this many tiles of the core tug threatens a tow outside. */
export const CORE_THREAT_MARGIN = 2;
/** Idle tugs keep this many tiles beyond the hull's outer edge on their waiting loop. */
export const RUIN_CLEARANCE = 1;

// ------------------------------------------------------------------ team signals (bots/signals.ts)

/** Ticks after one of our requests closes before the same need is asked again. */
export const SIGNAL_REASK = toTicks(20);
/** Units within this many tiles of a request's tile have arrived. */
export const SIGNAL_ARRIVE = 2.5;
/** Ticks units that delivered a request (troops to a tile, flak, air cover, escort) hold its tile before rejoining. */
export const SIGNAL_HOLD = toTicks(20);
/** A surface structure within this many tiles of a bombers request's tile is its target. */
export const SIGNAL_TARGET_REACH = 2;
/** Depths: a tremor with a hostile depths unit in sight within this many tiles is no unknown enemy (no scan asked). */
export const SIGNAL_SEEN_REACH = 3;
/** Orbit: armed hostile ships within this many tiles of our arrays or tugs are a raid (air cover asked). */
export const SIGNAL_RAID_RADIUS = 8;
/** Sky: this many hostile aircraft, or a hostile drop, within SIGNAL_ISLAND_REACH tiles of a held island ask flak under it. */
export const SIGNAL_AIR_HEAVY = 3;
export const SIGNAL_ISLAND_REACH = 6;
