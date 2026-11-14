/**
 * Intent schemas: every verb a seat may issue, its parameters, plane roles and agent-facing docs.
 */
import { t } from 'playerthree/schema';
import { SIGNAL_SCHEMAS } from './signals.ts';
import { ECON } from './econ.ts';
import { DAMAGE_VS, STATS } from './stats.ts';
import { cellXY, eid, xy } from './schema-fields.ts';
import { CONVERTED_UNITS, MAX_MAP_SIZE, MOVE_MODES, ORBIT_FORMATIONS, PLANES, PORTAL_PLANES, QUEUE_ITEMS, QUEUE_LIST, TICK_RATE, UNIT_STANCES, UNITS_PER_INTENT, UPGRADE_IDS } from './vocabulary.ts';

const units = t.list(eid, UNITS_PER_INTENT, 'your unit ids');

/** Intent params (PlayerThree adds the `kind` tag). */
export const MACROS = [
  'auto_mine', // depths: idle diggers mine and haul; orbit: idle tugs mine, unload and reacquire visible ore/ice
  'guard_root', // depths: combat units return to the Spire root
  'defend_spire', // surface: army returns to Spire
  'attack_nearest', // surface/sky: army attacks nearest visible enemy
  'recapture', // sky: air units go to nearest island not held by you; surface: combat units take the nearest forward post your alliance does not hold
  'intercept', // sky: interceptors chase falling asteroids
  'harvest_core', // orbit: a free tug grapples the derelict core (or heads into the ruin to find it); a tug towing it brings it back to the chamber to cool
  'haul_core', // orbit: the tug towing the derelict core tows it home to your Orbit segment, where it is cashed in
  'spread_arrays', // orbit: keep productive solar berths, move crowded arrays to separated home-first berths
] as const;
export type Macro = (typeof MACROS)[number];

const ALL = PLANES;
const queue = t.opt(t.bool('Append to the units\' order queue (max 8) instead of replacing their orders.'));
export const INTENTS = {
  ...SIGNAL_SCHEMAS.intents,
  move: {
    roles: ALL,
    params: { units, ...xy, mode: t.opt(t.enum(MOVE_MODES, 'move (default): keep travelling; turret/forward mounts may fire without stopping, fixed mounts do not. fight: engage enemies ahead or in same-plane body contact, defend all directions on arrival.')), formation: t.opt(t.enum(ORBIT_FORMATIONS, 'Multi-ship Orbit order: wedge, line, or escort around a selected ship; omitted, the fleet takes size-scaled slots like other planes.')), escort: t.opt(eid), queue },
    doc: 'Move units (must be on your seat plane) to a point. Groups travel at the slowest ship speed. Several units each get their own destination slot around the point, sized by their body (rules.movement.slotGap between bodies) on ground they can stand on, clear of your units already standing at or headed to that point; a compact group keeps its layout, others fill rings outward. Orbit fleets assemble and keep those slots, or a wedge, line or escort formation when one is given; escort names an own Orbit ship in the selection. A single unit goes to the point itself unless your units already claim it. Slots stay rules.movement.rallyClearance clear of your Spire. A point cut off by holes sends each unit to the nearest reachable ground.',
  },
  attack: { roles: ALL, params: { units, target: eid, queue }, doc: 'Attack a visible enemy entity. Units must be able to hit its plane; they close in to the nearest spot they can fire from (around holes and cliffs) and stop at weapon range. no_path if none of them can reach such a spot; units cut off later drop the order (target_unreachable event). Completed own turrets and armed island hardpoints also accept focus fire from their owning plane seat, without moving: Island Mortars are Sky-controlled and hit only visible Surface enemies within their horizontal range. Structures cannot take move, patrol or stance orders; Spire beams cannot be manually focused. Targeting an island prioritizes its visible hostile armed hardpoint, then its main slot structure, attacked by units that can hit it (the rest move under it); with nothing hostile there, capture-capable Sky units capture the island and the rest move onto it. Targeting a forward post (any holder, own included; surface seat) fight-moves your Surface units onto it, each to its own slot around it, to capture or hold it.' },
  stop: { roles: ALL, params: { units }, doc: 'Stop, clear queued orders and idle (idle units still defend themselves per their stance). Completed own turrets and armed island hardpoints accept stop from their owning plane seat to clear focus fire and return to normal stationary auto-targeting.' },
  patrol: { roles: ALL, params: { units, ...xy, queue }, doc: 'Fight-move back and forth between the units\' current position and a point (several units: each its own slot around the point, as move).' },
  stance: {
    roles: ALL,
    params: { units, stance: t.enum(UNIT_STANCES) },
    doc: 'aggressive: chase enemies up to 8 tiles; defensive: chase up to 3 tiles then return; hold: never move, only shoot what is in range. Idle Sky aircraft not on hold also step out of storms that reach them (rules.sky.stormEvadeEnabled) and idle interceptors not on hold auto-intercept rocks falling on your structures near them (autoInterceptEnabled).',
  },
  rally: { roles: ALL, params: { ...xy }, doc: 'Rally point for units produced at your Spire segment on this plane (they fight-move there; workers just move). Each segment starts with a default rally rules.movement.<plane>Rally tiles past the Spire footprint toward the map centre. New units leave the producer on the side facing the rally and line up in size-scaled slots behind it, earlier arrivals in front.' },
  queue_add: {
    roles: ALL,
    params: {
      item: t.enum(
        QUEUE_ITEMS,
        "A unit (Spire, or explicit producer: Aerie for air, Shaft for rootless diggers), or a structure: shaft/turret/mooring_tower/headframe/drill_yard (x, y are the integer minimum corner of its whole-cell footprint; every cell must be visible, clear buildable ground with no hole and a one-cell gap from other structures; a Headframe snaps any known 3×3 lode pocket cell to that pocket, else no_lode), relay/aerie/storm_seeder/stormcatcher (one held island main slot), island_mortar/ore_extractor (Sky construction on an own island's independent secondary slot, mutually exclusive with gun_platform and each other; main slot untouched; extractor requires remaining island ore), bulkhead (known depths tunnel cell, not rail, next to a tunnel) or geothermal (known rock beside a located sealed pocket); a digger builds bulkheads and taps. rebuild: raise a fallen Spire segment (`plane`) again (rules.spire.rebuilds per match, rebuildAlloy + rebuildEnergy, rebuildTime; it waits and pauses with reason enemy_near while an enemy unit you see is within rebuildClearance of it; it returns at rebuildHp of full HP, and with its crown).",
      ),
      count: t.opt(t.int(1, 5, 'Units only: add this many entries (default 1).')),
      x: t.opt(t.int(0, MAX_MAP_SIZE - 1, 'Structure footprint minimum cell x; Headframe also accepts any known lode pocket cell.')),
      y: t.opt(t.int(0, MAX_MAP_SIZE - 1, 'Structure footprint minimum cell y; Headframe also accepts any known lode pocket cell.')),
      island: t.opt(t.id('e', 'Island structure: the held island')),
      producer: t.opt(t.id('e', 'Forward producer: powered Aerie for air; built Shaft for diggers only while the Depths root is down, at shaftDiggerMultiplier cost.')),
      digger: t.opt(t.id('e', 'bulkhead/geothermal: optional own digger hint (must reach the cell). Used if idle or mining when funded; otherwise the nearest idle or mining own digger builds it.')),
      plane: t.opt(t.enum(PLANES, 'rebuild only: the fallen segment (default: your role\'s plane). Errors: segment_standing, rebuild_used (spent, or one already queued).')),
      index: t.opt(t.int(0, QUEUE_LIST - 1, 'Insert at this shared-list position; only relative order within your output plane affects funding. Default: bottom of your lane.')),
      ifAffordable: t.opt(t.bool('Conditional admission: reject with cannot_afford unless unearmarked bank resources cover the entire request after finite upkeep protection. No payment on admission; omit to save for a durable commitment.')),
    },
    doc: 'Add to your output-plane lane in the shared army queue. Every caller, including a human owner, must use the authenticated output role (wrong_plane otherwise); a Shaft producing diggers uses Depths. One next eligible commitment per plane saves real shared-bank alloy and energy; equal normal shares reuse idle capacity. Verified requested worker recovery uses rules.queue.recoveryFraction while normal demand exists. Busy producers may save; paid work builds concurrently. No global head-of-line funding or completion-time guarantee. Limits: rules.queue.teamMax total, seatMax per output plane, laneSlots reserved admission per plane. Agents/bots cannot move ahead of explicit orders within their lane.',
  },
  queue_cancel: {
    roles: ALL,
    params: { entry: t.id('q', 'queue entry id') },
    doc: 'Cancel an entry on your authenticated output plane. A human may cancel that lane; an agent cannot cancel human-protected work, and automatic policies/bots cannot cancel explicit agent work either. Unauthorized: invalid_target. Unpaid cancellation releases backing without a refund; paid cancellation returns rules.queue.refundStarted and removes any site. Other lanes and owners remain protected.',
  },
  queue_move: {
    roles: ALL,
    params: { entry: t.id('q', 'queue entry id'), index: t.int(0, QUEUE_LIST - 1, 'Shared-list position; changes only your lane order, not other lanes funding shares.') },
    doc: 'Reorder an entry on your authenticated output plane. Humans may adopt their lane work; agents cannot alter human commitments; automatic sources cannot alter explicit agent commitments. Automatic moves stay behind explicit commitments in this lane. Paid work is not refunded or accelerated by moving it. Reordering is not an army-wide priority override.',
  },
  queue_priority: {
    roles: ALL,
    params: { entry: t.id('q', 'unpaid eligible entry on your authenticated output plane') },
    doc: 'Explicit human-only one-shot funding override. Put this entry first in its lane and reassign available backing from lanes currently owned by the same authenticated person, up to its actual cost. The host derives that scope; no client owner-role claims or opaque IDs. This deliberately delays those owned commitments and may override their normal/recovery shares for this funding action. Other owners backing and finite upkeep protection cannot be consumed. No ongoing priority, extra currency, cancellation or forced completion; bots/agents/policies are refused.',
  },
  macro: { roles: ALL, params: { action: t.enum(MACROS) }, doc: 'High-level behaviour; see role docs for plane applicability. auto_mine: Depths idle diggers mine/haul and yield to designations; Orbit idle uncommitted owned tugs mine visible reachable nonvolatile metal/ice, unload, resume and reacquire after depletion. Requires a live Orbit segment; no rock means idle search. Existing orders, queued work and tows are untouched. Move/stop/release cancels retaining cargo; queued explicit work takes over after unloading. Orbit spread_arrays spreads solar arrays to legal unshaded home-first berths; preserves productive deployments and stable destinations. Bounded heuristic; unimproved arrays stay put. No arrays succeeds; unavailable home is invalid_target.' },
  designate: {
    roles: ALL,
    params: {
      rect: t.opt(t.obj({ x0: t.int(0, MAX_MAP_SIZE - 1), y0: t.int(0, MAX_MAP_SIZE - 1), x1: t.int(0, MAX_MAP_SIZE - 1), y1: t.int(0, MAX_MAP_SIZE - 1) })),
      cells: t.opt(t.list(t.obj(cellXY), MAX_MAP_SIZE * MAX_MAP_SIZE)),
      priority: t.int(0, 2, '0 removes tags; 1 normal; 2 urgent.'),
    },
    doc: 'Tag a shared Depths dig plan from any seat. Supply exactly one inclusive rectangle (either corner order) or nonempty cell list. Limits: rules.depths.designateCells per intent and designateMax tags per team; designation_limit rejects atomically. Unexplored cells are allowed; known open/bedrock tags cancel without revealing hidden terrain. Idle/auto_mine diggers work reachable frontiers, urgent then nearest, up to designateWorkers per cell. Explicit unit orders override.',
  },
  dig: {
    roles: ['depths'],
    params: { units, ...cellXY, queue },
    doc: 'Diggers tunnel toward a cell (through rock/ore; fortified is slow). Damage stays in the rock: several diggers stack on one cell, and a digger that leaves keeps its progress there. An enemy bulkhead on the way is dug through like rock (it loses HP).',
  },
  mine: {
    roles: ['depths'],
    params: { units, x: t.opt(t.num(0, MAX_MAP_SIZE, 'optional: prefer known ore within 3 tiles of this point (tile x), e.g. an opened lode pocket')), y: t.opt(t.num(0, MAX_MAP_SIZE, 'tile y (with x)')), queue },
    doc: 'Diggers mine the nearest known ore and haul it to the Spire root, a Shaft or a Headframe, repeatedly. With x, y they mine known ore near that point first. Mother Lode cells count as ore while a crew place there is not all taken by your alliance and you do not see them out of loads.',
  },
  fortify: {
    roles: ['depths'],
    params: { units, ...cellXY, queue },
    doc: `A digger or Warden hardens a rock cell that borders one of your own tunnels (rock walls only: never a tunnel cell, never remote rock). Free by default (rules.depths.fortifyCost), time only: ${ECON.fortifyTicks / TICK_RATE} s for a digger, ×${ECON.wardenFortifySpeed} faster for a Warden. Fortifying also repairs: a damaged cell loses its cracks; an already fortified cell is reinforced (more dig time, up to a cap). Fortifying an own bulkhead repairs it to full and adds HP (up to a cap). Fortified cells stop chasms spreading along a fault. A sapper charge strips fortification near it.`,
  },
  deploy: {
    roles: ['surface', 'depths'],
    params: { units, on: t.bool('true: deploy where they stand; false: pack up and stand idle.') },
    doc: 'Deploy stances, one per kind (match-rule toggles; `blocked` when off): trooper dug in, tank siege, flak emplaced (topic surface/front), Warden shield wall (topic depths/wardens). Deploying and packing take time and never fire; deployed units cannot move. Any order but `attack` or `stop` packs them first. State and progress are public to anyone who sees the unit.',
  },
  flare: {
    roles: ['depths'],
    params: { unit: eid, ...xy },
    doc: `A Warden throws a flare onto a known open Depths cell within ${ECON.flareRange} tiles: for ${ECON.flareRevealTicks / TICK_RATE} s your team sees the tunnels within ${ECON.flareRange} tiles of it along open tunnel (and their rock walls), never through rock. Free; ${ECON.flareCooldown / TICK_RATE} s cooldown per Warden. Anyone who sees the flare's cell sees the flare.`,
  },
  undermine: {
    roles: ['depths'],
    params: { units, ...cellXY, queue },
    doc: `Sapper goes to a tunnel cell and plants a charge (fogged by default: enemies see it only through their Depths vision of the cell or a tremor they feel there, and everyone for its last ${ECON.chargePublicTicks / TICK_RATE} s, rules.depths.chargesFogged/chargePublicTime). After ${ECON.undermineTicks / TICK_RATE} s the surface above collapses unless an enemy depths unit stands next to it for ${ECON.defuseTicks / TICK_RATE} s (defused). More sappers arriving within ${ECON.chargeStackReach} cell of a pending own charge join it: each adds ×${ECON.chargeStackDamage} of the collapse damage, up to ${ECON.chargeStackMax} sappers (one fuse, one defuse). On detonation it also strips all fortification from rock within ${ECON.chargeStripReach} tiles and deals ${ECON.chargeUnitDamage} damage to Depths units there. Under a fault cell the charge opens a chasm along the fault instead. Rejected with mandate_limit when mandate.limits.collapses is false.`,
  },
  rail: {
    roles: ['depths'],
    params: { units, ...cellXY, queue },
    doc: `Diggers walk the tunnels to a cell and lay rail on every tunnel cell on the way (${ECON.railCost} alloy, ${ECON.railTicks / TICK_RATE} s per cell; diggers on one cell share the job). Rails are ×${ECON.railSpeed} speed for every depths unit, of either team.`,
  },
  breach: {
    roles: ['depths'],
    params: { units, ...cellXY, queue },
    doc: `Troopers go to a tunnel cell and dig up to the surface (${ECON.breachTicks / TICK_RATE} s; the enemy feels tremors if they have presence or vision there). Opens a breach hole; the troopers climb out beside it (one way: holes are no portals, going back down needs an own Shaft). A structure standing there stops it.`,
  },
  bridge: {
    roles: ['depths'],
    params: { units, ...cellXY, queue },
    doc: `Diggers backfill a hole cell (kinds: rules.depths.backfillKinds; ${ECON.bridgeCost} alloy once per cell, ${ECON.bridgeTicks / TICK_RATE} s, working from a tunnel next to the cell under it; more diggers join free and finish sooner): the surface there is walkable again. On a known lava-lake cell (depths code 11) beside dry ground, or at the end of a straight run of fewer than rules.depths.lavaBridgeSpan bridges from it, they build a lava bridge instead (${ECON.lavaBridgeCost} alloy, ${ECON.lavaBridgeTicks / TICK_RATE} s): a walkable deck every army crosses until it is destroyed.`,
  },
  transfer: {
    roles: ['depths', 'surface'],
    params: {
      units, to: t.enum(PORTAL_PLANES),
      x: t.opt(t.num(0, MAX_MAP_SIZE, 'optional: go through the own built Shaft whose footprint holds this point (tile x). Omitted: each trooper uses its nearest.')),
      y: t.opt(t.num(0, MAX_MAP_SIZE, 'tile y (with x)')),
      queue,
    },
    doc: 'Troopers and Breachers switch between Surface and Depths through your own built Shafts only (the Spire root, holes and enemy Shafts are no portals). Each uses its nearest usable Shaft, or with x, y the Shaft there. no_shaft: no own built Shaft there (or none at all); shaft_sealed: that Shaft\'s Depths landing is bedrock or has no open tunnel beside it (dig to it first).',
  },
  convert: {
    roles: ['surface'],
    params: {
      units,
      to: t.enum(CONVERTED_UNITS, 'what they become'),
      yard: t.opt(t.id('e', 'optional: your built Drill Yard. Omitted: the nearest one to the group.')),
      queue,
    },
    doc: `Surface Troopers walk to your built Drill Yard and line up at its door; the yard takes them in one at a time (earliest-made first) and each comes out a Breacher after ${STATS.breacher.build / TICK_RATE} s for ${STATS.breacher.alloy} alloy + ${STATS.breacher.energy} energy (rules: stats.breacher alloy/energy/build; paid when it goes in, waiting while you cannot pay). Inside it is hidden and safe but cannot act; it keeps its HP fraction, stance and queued orders. If the yard is destroyed the Trooper inside steps out a Trooper (the payment is lost) and the line disperses. Breacher: close-range flamer (×${DAMAGE_VS.flamer.light} vs light, ×${ECON.breacherDugInMultiplier} vs dug-in Troopers ignoring their reduction, forward cone splash), uses portals like Troopers. Rejected (blocked) when rules.surface.breachersEnabled is false.`,
  },

  capture: { roles: ['sky'], params: { units, island: t.id('e'), queue }, doc: 'Air units follow and hold an island. Uncontested hold for 5 s captures it.' },
  hangar: { roles: ['sky'], params: { units, target: eid }, doc: 'House nearby air units in an own powered Aerie. Aircraft at a different elevation first approach and descend to its deck, remaining visible and vulnerable until they actually dock. Once housed they cannot fight, see or capture, and repair while the Aerie is powered; the hangar has finite capacity.' },
  launch: { roles: ['sky'], params: { units }, doc: 'Prepare hangared air units for launch; they remain protected and inactive until the launch deadline.' },
  airdrop: { roles: ['sky'], params: { aerie: eid }, doc: 'A powered Aerie drops a squad of troopers through the shared Sky-to-Surface transit. Pays normal trooper costs at once, outside the build queue (never waits for funds), and respects population and cooldown.' },
  moor: { roles: ['surface'], params: { tower: eid, island: eid }, doc: 'Select a visible island of any owner for an own completed Mooring Tower. When in range, lowers it vertically at the same x/y so drifting islands can pass overhead; one island per tower, no army cap. Pays continuous energy while lowering and holding. Ownership, slots, production, plane, weather and fog are unchanged. Lowering, held, raising and recently released islands cannot be caught.' },
  unmoor: { roles: ['surface'], params: { tower: eid }, doc: 'Cancel an own tower target or release its island. The island rises vertically into a safe gap on its original delayed circular route; no teleport or handoff. Only the tower owner controls release.' },
  drop_ore: { roles: ['sky'], params: { island: eid }, doc: 'Release the entire extracted buffer of an island your army owns into an ordinary Surface ore cache below, using normal nearest-legal cache placement and collection. Anyone can collect; there is no direct alloy credit, crater or damage. Cargo remains droppable after extractor loss, including without power. Empty buffers fail invalid_target; another owner fails not_held.' },
  dismantle: { roles: PLANES, params: { structure: eid }, doc: 'Destroy one own completed static structure on your commanded plane, without refund, through ordinary destruction. Excludes Spire segments, neutral/capturable objectives, islands and mobile units (including Solar Arrays). Frees its footprint/island slot; island reserves and undropped cargo survive. A Mooring Tower releases its island; a Seeder stops. Aerie occupants evacuate at rules.sky.aerieLossHealth of remaining HP; Drill Yard trainees leave as Troopers but paid conversion is lost. Forward production stays blocked at the lost producer until queue_cancel (normal cancellation refund). Incomplete sites fail blocked: use queue_cancel instead. Foreign owners fail not_your_unit, other planes wrong_plane, protected kinds wrong_kind, absent/hidden targets invalid_target.' },
  emplace: { roles: ['sky'], params: { unit: eid, island: eid }, doc: 'A Gunship within captureRadius and at the same elevation as an island your army holds lands on its empty gunner hardpoint and permanently becomes a Gun Platform (keeps its HP fraction; +rules.sky.emplaceRangeBonus range; no longer an aircraft, immune to storms, cannot move). Capture or move near a lowered island to descend before emplacing. The hardpoint cannot already hold or reserve an Island Mortar or Ore Extractor. One attachment per hardpoint (rules.sky.islandHardpoints); while it lives, hostile captures of that island cannot progress. Needs rules.sky.gunshipEmplaceEnabled.' },
  seed: { roles: ['sky'], params: { seeder: eid }, doc: 'Activate an own built Storm Seeder: after a public telegraph (weather.seedWarnings) a seeded storm blows around it for rules.sky.seederDuration. Costs energy per activation plus rules.sky.seederUpkeep while the storm blows, then cools down. Your own alliance takes reduced storm damage inside it.' },
  grapple: { roles: ['orbit'], params: { units, asteroid: t.id('e'), queue }, doc: 'Tug flies to a drifting asteroid, or the resting derelict core (`kind` core), latches on and tows it.' },
  mine_asteroid: { roles: ['orbit'], params: { units, asteroid: t.id('e'), queue }, doc: 'Tug approaches a visible resource asteroid and mines while latched. Metal yields alloy, ice energy; slag cannot be mined. Requires your live Orbit segment. A full hold or exhausted rock sends cargo home to unload without the delivery cap, then resumes the original viable rock. Move/cancel detaches but retains cargo; moving home unloads it.' },
  deorbit: { roles: ['orbit'], params: { units, ...xy }, doc: 'Release a towed rock (or the derelict core, once past the hull) toward a Surface point. Public warning by size: pebble 4 s, medium 8 s, large 12 s, core rules.orbit.coreDropTime. Rejected with mandate_limit when mandate.limits.asteroidDrops is false.' },
  vent: { roles: ['orbit'], params: { units }, doc: 'Tugs towing the derelict core hold still for rules.orbit.coreVentTime: its heat drops to its vents so far × coreVentFloor (each vent buys less time), and a pulse hits every Orbit unit near it (allies too). Moving restarts it.' },
  release: { roles: ['orbit'], params: { units }, doc: 'Tugs stop mining (retaining cargo) or let go of whatever they tow, where they are: a rock drifts on (a volatile one disarms), the derelict core stays put (heating out past the hull, cooling in the chamber). The tug is free at once.' },
  research: { roles: PLANES, params: { upgrade: t.enum(UPGRADE_IDS), ifAffordable: t.opt(t.bool('Only admit if the current funding-eligible queue and this upgrade are affordable; otherwise cannot_afford.')) }, doc: 'Queue an upgrade at this seat’s Spire segment. One research slot per segment, independent of unit production; waits for funds.' },
  ascend: { roles: ['sky'], params: { units }, doc: 'Ascent Thrusters: spend energy per interceptor to climb into Orbit temporarily, then fall back to Sky. Requires completed research and ready cooldown.' },
  sun_lance: { roles: ['orbit'], params: { units, ...xy }, doc: 'Sunlit Lancers charge a visible aim line, then fire a travelling piercing plasma bolt toward x/y. Firing drains their own shields. Free base ability; costs energy and has a cooldown (rules.orbit).' },
  aegis: { roles: ['orbit'], params: { units }, doc: 'Researched Aegis Projectors: Bastions stop and cover nearby allied Orbit ships with a shared shield pool based on their current shields. Ends on pool break or timeout; rooted while active (rules.orbit).' },
  scan: {
    roles: ['orbit'],
    params: { ...xy },
    doc: 'Orbital scan: reveal radius 6 around a point on ALL four planes for 5 s (depths cells become known). Costs 50 energy, 20 s cooldown, needs your orbit Spire segment.',
  },
} as const;

export type IntentKind = keyof typeof INTENTS;
