/**
 * The Agent Command manifest: everything agents may see and do. Static, trusted developer text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { defineManifest, t, type SkillDef } from 'playerthree';
import {
  DEFAULT_RULES,
  ECON,
  ERRORS,
  INTENTS,
  INTENTS_PER_CALL,
  OPPONENTS,
  PLANES,
  SIGNALS,
  SIGNAL_LIMITS_MAX,
  SPIRE_HP,
  STATS,
  ARMIES,
  OBS_GRID,
  TICK_RATE,
  directiveSchema,
  limitsSchema,
  matchOptionsSchema,
  matchDataSchema,
  toTicks,
  eventSchema,
  observationSchema,
  reportSchema,
  viewSchema,
  observerSchema,
  type Plane,
} from '../rules/contract.ts';
import { TOPICS } from './docs/index.ts';
import { s } from './docs/shared.ts';
import { lobbySummarySchema } from './lobby-summary.ts';

const SKILL_DIR = new URL('../../skills/agent-command-strategy/', import.meta.url);

/** Every file under the strategy skill directory, keyed by its `/`-separated path (sorted: stable surface hash). */
function skillFiles(dir: URL, prefix = ''): [string, string][] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((d) => d.isDirectory()
      ? skillFiles(new URL(`${d.name}/`, dir), `${prefix}${d.name}/`)
      : [[`${prefix}${d.name}`, readFileSync(new URL(d.name, dir), 'utf8')] as [string, string]]);
}

export const STRATEGY_SKILL: SkillDef = {
  name: 'agent-command-strategy',
  description:
    'How to win Agent Command: plane-by-plane strategy, cross-plane combos, what to automate with policies, and a starter policy for every plane (the built-in bot, tunable).',
  files: Object.fromEntries(skillFiles(SKILL_DIR)),
};

/**
 * Each plane's starter (skill `policies/<plane>.js`, bots/starter.ts): the built-in bot at its sandbox tier with knobs,
 * marked in the manifest's `starters` so `policy_deploy {from, knobs}` and practice_run deploy it by reference.
 */
export const STARTERS: Readonly<Record<Plane, string>> = {
  depths: `${STRATEGY_SKILL.name}/policies/depths.js`,
  surface: `${STRATEGY_SKILL.name}/policies/surface.js`,
  sky: `${STRATEGY_SKILL.name}/policies/sky.js`,
  orbit: `${STRATEGY_SKILL.name}/policies/orbit.js`,
};
const STARTER_SUMMARY: Readonly<Record<Plane, string>> = {
  depths: 'Built-in Depths bot, sandbox tier: digging, lodes, rich ore and lava, Wardens, bulkheads, sapper strikes.',
  surface: 'Built-in Surface bot, sandbox tier: army, posts and points, Headframes, Shafts, turrets, breaches, deploy stances.',
  sky: 'Built-in Sky bot, veteran tier: interceptor screen, islands and Relays, bombers, gunships, weather routing.',
  orbit: 'Built-in Orbit bot, sandbox tier: solar arrays, tugs and rocks, fleet counters, scans, the derelict core.',
};

/** Core rules every seat needs every turn; everything else is an on-demand topic (docs/). */
const DOC = `Agent Command: ${TICK_RATE}-tick/s RTS; 2–4 armies; stacked depths, surface, sky, orbit planes share x/y tiles, y down. Your army is a Spire corner (nw/ne/se/sw); other colours are hostile.

AUTHORITY. One plane per seat; credentials may command several. Read game_briefing.commands for authority, not the role enum. Pass role when several are commanded. Your plane is detailed; others are planes summaries. game_observe {role,detail:['sky']} or detail:'all' expands sight data, never control.

RULES. Doc numbers are defaults. Fetch game_briefing {topic:'match-data'} each match; cache rules, terrain, armies/frames and public paths. Refetch on rulesHash change. Rules use seconds; observation deadlines use ticks.

COORDINATES. size=rules.map.size; c=y*size+x; cells 0..size-1; centres x+0.5,y+0.5. Positions use 1/${OBS_GRID} tiles, never cell edges. Rotate NW plans by frame quarter turns: points (x,y)→(size-y,x), cells→(size-1-y,x). Structure anchors: maps/structures topics.

SPIRE. Four segments produce/fire independently (default HP ${SPIRE_HP.depths}/${SPIRE_HP.surface}/${SPIRE_HP.sky}/${SPIRE_HP.orbit}). Surface loss eliminates by default; 'crowns' uses rules.spire weights/threshold. Elimination removes units/control; last colour wins, all get rank. Fallen segments stop production; rebuilds are limited. Sudden death boosts Spire damage except rocks. Time-cap tiebreak: fewest crowns lost, most Spire HP, most contested-point seconds. Topic spire.

FOG. Own entities are known; enemies need current team sight. Public paths/warnings reveal no hidden occupants/reserves. Depths retains last-seen cells (0 unknown); enemy destinations are hidden. Topic vision.

QUEUE. One shared bank, four output-plane lanes: each lane's next eligible entry holds bank funds and pays on start. Every caller, owner included, queues, cancels and moves only its own role's plane; agents never touch owner entries, policies/bots only automatic ones. Spend res.freeAlloy/freeEnergy plus your lane's own holds. Ask teammates via signals. Topic queue.

ACTING. Atomic intents succeed or return closed errors; inspect acknowledgements. Units must be on your role's plane.

LOBBY. Brief each role; game_ready {role} for each prepared, seated role, never bulk-ready. Then game_wait {seconds:60,role} per commanded role; unseated roles just wait. ready:true in lobby means others/host pending (startsWhen). Match entry returns its first observation. Rebrief on reassignment; role optional only with one role.

PLAY. Observe (since:lastTick), act, wait per role until match end. Handle top-level owner messages before extracting observation. Follow mandate/scopes; use macros, standing orders and game_sequence. Deploy/practice policies without stopping monitoring.

START. Policy seats deploy their plane's starter first, one call: policy_deploy {from} (topic starters), then improve it. Then the role doc's READ FIRST topic; fetch other topics and agent-command-strategy files when a decision needs them; follow next pages.`;

const ROLE_DOCS: Record<Plane, string> = {
  depths: `DEPTHS (Dungeon Keeper). You run the team's alloy and the war underground. \`depths\` (then \`depthsChanges\`: keep the grid) is your row-major size×size cell knowledge (topic depths/digging). Vision is short and tunnel-only: ask Orbit for a scan.
Units (\`queue_add\` at your root; diggers also at an own Shaft, at a surcharge, once the root falls): digger (dig, mine, fortify, bulkhead, geothermal, rail, bridge; weak melee), sapper (undermine), warden (shotgun; shield wall, flare, fast fortify). Troopers down here are yours. Tunnels never collapse; only bulkheads and Warden walls block one.
- Economy: \`mine\` (or \`macro auto_mine\`) hauls to the root, a Shaft or a Headframe; crew opened lodes; \`rail\` the cavern early; \`dig\` and \`designate\` dig plans. With map lava lakes and green ore: \`bridge\` lake cells toward green ore (richer loads) and shortcuts; guard your bridges, cut theirs.
- Queue: Depths-only production/mutation, including Shaft diggers. Keep a real replacement request below rules.queue.recoveryWorkers; the sim funds verified recovery. Spend res.freeAlloy/freeEnergy.
- Defence: free, walls-only \`fortify\` (rock beside your tunnels; repairs \`cracks\`), bulkheads on chokes, a Warden's shield wall (\`deploy\` {units, on: true}) at a 1-wide choke facing the enemy, \`flare\` unseen corners. Own/allied traffic passes through a deployed shield without lowering it; enemies stay blocked. Answer \`intruder\`, breach, sapper and charge events and alerts.
- Combo: troopers (range ${STATS.trooper.range}) shoot over a walled Warden from its cover; enemy Wardens (range ${STATS.warden.range}) can't reach them. Signal \`troops\` at the wall: the Surface sends them down an own Shaft. Alone you hold; with troopers you push.
- Attack: sappers hit what stays put (Headframes and Shafts need 2 stacked, turrets 1), not armies (charges hidden from enemies until their vision, tremors or the last ${s(ECON.chargePublicTicks)}; ${s(ECON.undermineTicks)} fuse); stack up to ${ECON.chargeStackMax} per charge. Teammates signal \`collapse\` at a tile. Troopers \`breach\` up near hostile Shafts and turrets.
- Defuse: keep any one Depths unit within ${ECON.defuseReach} cell of an enemy charge you know of for ${s(ECON.defuseTicks)} in a row.
READ FIRST: depths/digging. Later: depths/bulkheads, depths/wardens, collapses, lodes, queue, designations, geothermal, cross-plane.`,
  surface: `SURFACE (classic RTS). Your segment is the big prize: under rules.spire.lossRule \`surface\` it is the army's life, under \`crowns\` worth ${DEFAULT_RULES.spire.crownsSurface} crowns; destroy hostile Surface segments and protect yours. Units: trooper (rifle; fights in the depths after \`transfer\`), tank (cannon, splash; mobile +${ECON.siegeRange} vs non-Spire structures), flak (anti-air, anti-asteroid), breacher (flamer: \`convert\` troopers at your Drill Yard). Build on visible cells with \`queue_add\` {item: 'shaft' | 'turret' | 'headframe' | 'drill_yard', x, y} (x,y = footprint minimum corner): Shafts (ore drop-off, trooper portal), turrets (Surface and Sky; ${ECON.turretUpkeep} energy/s upkeep each), Headframes (open lodes).
- Army: \`move\` (plain) vs \`mode: 'fight'\` attack-move, \`attack\`, \`stance\`, \`patrol\`, \`queue\`, \`rally\`; macros \`defend_spire\`, \`attack_nearest\`, \`recapture\`.
- \`deploy\` {units, on}: troopers dig in, tanks siege (${ECON.siegeRangeStructures} vs structures, ${ECON.siegeSpireRange} vs Spires, ${ECON.siegeRangeUnits} vs units), flak emplaces. Home posts start yours; race 3 troopers to the centre point (\`matchData.posts\` kind contested; ${s(ECON.contestedCaptureTicks)}). Topic surface/front.
- Ground: hold high ground (+${ECON.highRange} range, +${ECON.highVision} vision, unseen from low ground) and forests; cliffs block, forests and fords slow, holes are impassable.
- Cross-plane: \`transfer\` troopers down only through own built Shafts (one beside home early); answer \`tremors\` (\`breach: true\` = enemy troopers digging up); race \`oreCaches\` with a detachment; dodge impact markers and \`scorches\`.
- Building: one level (apron included), inside your build radius, outside every hostile Spire's no-build zone; Headframes on home lodes early.
- Mooring: \`queue_add\` {item:'mooring_tower',x,y} builds a ${STATS.mooring_tower.footprint.w}×${STATS.mooring_tower.footprint.h} Surface tower (${STATS.mooring_tower.alloy} alloy, ${STATS.mooring_tower.energy} energy, ${s(STATS.mooring_tower.build)}, ${STATS.mooring_tower.hp} HP). \`moor\` {tower,island} / \`unmoor\` {tower}: any observed island ownership, unchanged; one per tower. Range ${ECON.mooringRange}, vertical lowering at the same x/y over ${s(ECON.mooringTravelTicks)} so drifting islands pass overhead, ${ECON.mooringUpkeep} energy/s upkeep, nonrenewable ${s(ECON.mooringGraceTicks)} unpaid grace. Budget sustained upkeep; topic surface/mooring.
- Signals: answer \`troops\`, \`flak\`; sieging, ask \`scan\`, \`bombers\`.
- Queue: only your output role, even as owner; Surface Shafts do not grant digger production. Preserve expensive commitments; spend res.freeAlloy/freeEnergy, not bank totals.
Forward Relays spot bases; impacts and collapses soften them.
READ FIRST: surface/army. Later: surface/front, surface/building, build-radius, lodes, combat, queue, structures, terrain, cross-plane, rocks.`,
  sky: `SKY (drifting islands). Islands drift on fixed public rings around the map centre, one per map slot per ring. Units: interceptor (missiles vs air and falling rocks; out-ranges gunships), bomber (splash-bombs the Surface below; spots), gunship (${STATS.gunship.hp} HP Sky-only brawler, range ${STATS.gunship.range}, fires on the move: beats closing interceptors, outlasts them under flak; escorts bombers).
- \`capture\` {units, island}: ${s(ECON.captureTicks)} uncontested within ${ECON.captureRadius} tiles; ${s(ECON.captureStructureTicks)} while it drains a built enemy structure. Hostile aircraft on it freeze it (\`contested\`, alert \`island_contested\`); hold yours with \`capture\`. ONE main build slot per held island: \`queue_add\` {item: 'relay' | 'aerie' | 'stormcatcher' | 'storm_seeder', island}; all but the Relay need your live Sky segment. Mix delivery, storm income, shelter and control.
- Abilities: \`seed\` {seeder} (telegraphed storm), Surface \`moor\` {tower, island} / \`unmoor\` {tower} (built Mooring Tower; any island, ownership unchanged; topic surface/mooring), \`emplace\` {unit, island} (Gunship becomes a Gun Platform on a held island's hardpoint; blocks captures).
- Secondary hardpoint (never the main slot), one of: Gun Platform, Island Mortar, Ore Extractor; topics sky/hardpoints, sky/ore. Armed hostile hardpoints block capture. Screen first, then one guarded useful island.
- Ore: \`queue_add\` {item:'ore_extractor',island}; powered finite extraction fills island cargo; \`drop_ore\` {island} releases it as an ordinary Surface cache anyone can collect. Capacity public; remaining ore: owner or current Sky sight; buffer: owner only; omitted = unknown. Guard, fund upkeep; drop only over observed-safe friendly pickup.
- \`macro intercept\` (enemy asteroids), \`recapture\`, \`attack_nearest\`. Idle interceptors auto-intercept rocks falling on your base.
- Storms slow and hurt air but hide it from flak, turrets and Orbit unless scanned; idle air leaves storms (\`hold\` stays); ride jets your way.
- Own the Sky, then bomb visible Surface structures (detail ['surface'] lists them); bombers spot hills and forests.
- Ascent Thrusters research: \`ascend\` surplus interceptors to raid Orbit.
- Powered Aeries repair hangared aircraft (upkeep: topic resources).
Sky segment lost: stop saving energy for a screen.
- Signals: answer \`air_cover\` (for Orbit: ascend), \`bombers\`; ask \`flak\` under threatened islands.
READ FIRST: sky/islands. Later: weather, sky/aerie, cross-plane, resources, queue, ascent, rocks, research.`,
  orbit: `ORBIT (energy, mining, scans, combat). Solar arrays anchor to earn energy; tugs mine/tow; Skiffs are cheap fast short-range raiders, Bastions rapid point-defence escorts, Lancers long-range beam frigates. Researched Sky interceptors ascend for short raids.
- Energy = arrays × light (night ${ECON.solarNight}) × ramp (${ECON.solarRampStart} → 1 in ${s(ECON.solarRampTime)}) × distance (full within ${ECON.solarFullRange}, ${ECON.solarFarFactor} at ${ECON.solarFarRange}) × shade (−${ECON.solarShadePer} per own array within ${ECON.solarShadeRadius}). Five home berths fill the base cap; expand with Sky Relays and escorted forward fields. Fold (\`deploy\` off) hurt arrays to heal.
- \`macro spread_arrays\`: unshaded home-first berths; preserves productive arrays and existing destinations (orbit/economy).
- \`macro auto_mine\`: idle uncommitted tugs harvest visible reachable nonvolatile metal/ice, unload and reacquire after depletion. No rocks: idle search; preserve \`miningAssigned\` even then. Move/stop/release cancels; queued work takes over after unloading. Manual/core/tow work is untouched.
- \`mine_asteroid\` {units,asteroid,queue?}: metal/ice harvesting, cargo trips and fog-safe return to last-observed drift. \`miningAssigned\` stays true through the loop. Ice bypasses the cap. \`grapple\` + \`move\`: tow whole rocks to dock remaining value or \`deorbit\` within ${ECON.deorbitRange}. Slag has no yield; volatility arms a tow fuse. Public markers show size only (rocks).
- Central derelict: gated walls, chamber radiation, melting core. Tow it home for ${ECON.coreRewardAlloy} alloy + ${ECON.coreRewardEnergy} energy once. \`macro harvest_core\`, \`macro haul_core\` (home), \`vent\`, \`release\`, or drop it (orbit/derelict).
- \`scan\` {x,y}: radius ${ECON.scanRadius}, all planes, ${s(ECON.scanTicks)}; ${ECON.scanCost} energy, ${s(ECON.scanCooldownTicks)} cooldown. Support teammates.
- Counter scouted enemies: Bastions beat Skiffs, Lancers beat Bastions, Skiffs beat Lancers. Ships carry momentum; shields work only in Orbit. Lancers get free \`sun_lance\`; research adds \`aegis\`, Night Cloak and Sky-beaming Lancer Lens.
- Avoid hostile segment beams and point defence until your gathered fleet can win.
- Signals: answer \`scan\` and \`escort\` first; under raid, ask Sky for \`air_cover\`.
- Queue: Orbit-local commitments, no cross-plane priority. Use res.freeAlloy/freeEnergy for optional production and abilities; a held expensive head is not a global ETA promise.
READ FIRST: orbit/economy. Later: orbit/fleet, rocks, orbit/abilities, resources, queue, orbit/derelict, research, weather, cross-plane.`,
};

export const manifest = defineManifest({
  id: 'agent-command',
  version: '0.1.0',
  title: 'Agent Command',
  doc: DOC,
  roleDocs: ROLE_DOCS,
  topics: TOPICS,
  tickRate: TICK_RATE,
  teams: t.enum(ARMIES),
  roles: t.enum(PLANES),
  intents: INTENTS,
  observation: observationSchema,
  // Sections are the planes: each seat sees its own plane in full by default.
  observationScope: { sections: t.enum(PLANES), defaults: { depths: ['depths'], surface: ['surface'], sky: ['sky'], orbit: ['orbit'] } },
  matchData: matchDataSchema,
  lobby: lobbySummarySchema,
  view: viewSchema,
  observer: observerSchema,
  directive: directiveSchema,
  limits: limitsSchema,
  matchOptions: matchOptionsSchema,
  errors: t.enum(ERRORS),
  opponents: t.enum(OPPONENTS),
  report: reportSchema,
  event: eventSchema,
  starters: Object.fromEntries(PLANES.map((role) => [STARTERS[role], { summary: STARTER_SUMMARY[role], roles: [role] }])),
  skills: [STRATEGY_SKILL],
  signals: SIGNALS,
  control: {
    intents: { perSecond: 4, burst: 12 },
    // 20 Hz: a 60-second build order/timed push, with 100 ms spacing rather than per-tick micro.
    sequence: { maxSteps: 16, maxTicksAhead: 1200, minSpacingTicks: 2 },
    policy: {
      runtimes: ['js', 'wasm'],
      hz: 2,
      msPerCall: 25,
      memoryBytes: 32 * 1024 * 1024,
      maxArtifactBytes: 512 * 1024,
      maxIntentsPerCall: INTENTS_PER_CALL,
      maxLogLines: 200,
      maxLogLineBytes: 200,
    },
    stream: { maxHz: TICK_RATE, intentsPerTick: 8 },
    signals: SIGNAL_LIMITS_MAX,
    practice: { maxTicks: toTicks(20 * 60), concurrent: 2 },
    pool: { maxPublishedPerPrincipal: 5 },
    chat: {
      maxTellChars: 500,
      maxSayChars: 280,
      ping: t.obj(
        { plane: t.enum(PLANES, 'plane the owner pointed at'), x: t.num(0, 80, 'tile x'), y: t.num(0, 80, 'tile y') },
        'A map point the owner attached',
      ),
    },
  },
});

export type AgentCommandManifest = typeof manifest;
