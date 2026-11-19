// Agent Command's built-in bot library: packages/game/src/rules/econ.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
/**
 * The default flat scalar rule table (ECON, durations in ticks) and its compiled type `Econ`.
 */
import { toTicks } from './vocabulary.js';

/**
 * Default scalar rules, flat, durations in ticks: what `compileRules` produces for the default rules. A match runs on
 * its own table (`compileRules(rules).econ`); clients and docs may read these defaults.
 */
export const ECON = {
  ascentEnergy: 25,
  ascentClimb: toTicks(2),
  ascentDuration: toTicks(20),
  ascentCooldown: toTicks(45),
  ascentThrustersAlloy: 150,
  ascentThrustersEnergy: 100,
  ascentThrustersTime: toTicks(30),
  aegisProjectorsAlloy: 100,
  aegisProjectorsEnergy: 100,
  aegisProjectorsTime: toTicks(25),
  nightCloakAlloy: 125,
  nightCloakEnergy: 100,
  nightCloakTime: toTicks(30),
  /** Depths research: on/off toggles (off: never offered), then cost and duration */
  drillBitsEnabled: true,
  drillBitsAlloy: 100,
  drillBitsEnergy: 60,
  drillBitsTime: toTicks(25),
  shapedChargesEnabled: true,
  shapedChargesAlloy: 120,
  shapedChargesEnergy: 80,
  shapedChargesTime: toTicks(30),
  lancerLensAlloy: 100,
  lancerLensEnergy: 100,
  lancerLensTime: toTicks(25),
  lanceEnergy: 50,
  lanceCooldown: toTicks(25),
  lanceCharge: toTicks(2),
  lanceSpeed: 12,
  lanceRange: 14,
  lanceDamage: 120,
  lancePierceDamage: 60,
  lanceWidth: 0.2,
  /** Sun lance damage multiplier against structures (ships take full damage) */
  lanceStructureMultiplier: 0.5,
  /** tiles: Lancer Lens reach, horizontal, to the Sky target's edge */
  lensReach: 1.5,
  /** Lancer Lens beam damage as a multiple of the Lancer's beam damage */
  lensDamageMultiplier: 0.5,
  /** Lancer Lens research exists in this match */
  lancerLensEnabled: true,
  aegisEnergy: 40,
  aegisCooldown: toTicks(30),
  aegisRadius: 2.5,
  aegisDuration: toTicks(6),
  aegisShieldMultiplier: 1.5,
  cloakBreakTime: toTicks(4),
  cloakDetectRadius: 1.5,
  segmentLossRefund: 1,
  shieldCap: 0.6,
  startAlloy: 400,
  startEnergy: 250,
  /** units each team starts with, spawned at that kind's Spire segment */
  startDiggers: 4,
  startTroopers: 5,
  startTanks: 1,
  startInterceptors: 2,
  startSolars: 2,
  startTugs: 1,
  /** ore loads a digger carries before hauling (each load is oreLoad alloy) */
  diggerLoads: 4,
  /** alloy/s trickle from the Spire */
  spireAlloyRate: 2,
  /** alloy per ore load delivered */
  oreLoad: 10,
  /** energy/s delivered with no relays (6: five sheltered home arrays fill it; past that, Relays and forward fields) */
  baseEnergyCap: 6,
  /** extra energy/s delivered per relay */
  relayEnergyCap: 4,
  /** Rootless production and local energy fallbacks (DESIGN §5.1). */
  minimumEnergyCap: 1,
  shaftDiggerMultiplier: 1.5,
  /** energy/s per tap while the own Orbit segment lives: a top-up, not a replacement for healthy solar (DESIGN §5.1) */
  geothermalHealthyRate: 0.15,
  /** energy/s per tap once the own Orbit segment is destroyed */
  geothermalRate: 0.5,
  /** energy the solar bank holds: surplus above the delivery cap charges it, a gap below the cap draws it down */
  solarBankMax: 300,
  /** fraction of the solar surplus above the delivery cap that reaches the bank (1: a full day's surplus is kept) */
  solarBankRate: 1,
  geothermalSurgeMultiplier: 4,
  /** energy/s each built turret draws; while a team cannot pay it, its turrets are offline (state idle, no fire) */
  turretUpkeep: 0.25,
  aerieUpkeep: 0.5,
  /** gunships can be produced */
  gunshipEnabled: true,
  /** island structures use the `island` armor (else `structure`) */
  islandArmorEnabled: true,
  /** flak and turrets target and splash island structures (Relay, Aerie, Storm Seeder, Stormcatcher) */
  groundHitsIslandStructures: false,
  /** powered hangars repair housed aircraft */
  aerieRepairEnabled: true,
  /** HP per second each housed aircraft regains in its hangar */
  aerieRepair: 4,
  /** Gunships can `emplace` onto a held island as a Gun Platform */
  gunshipEmplaceEnabled: true,
  /** attach slots per island (0 or 1; HARDPOINT_KINDS lists what may attach) */
  islandHardpoints: 1,
  /** extra weapon range (tiles) of a Gun Platform over the Gunship's */
  emplaceRangeBonus: 1,
  /** Minimum Island Mortar warning/flight duration, including shots directly below its island. */
  mortarFlightTicks: toTicks(2),
  /** Provisional supplemental island economy, not a replacement for Depths mining. */
  extractorRate: 0.5,
  extractorUpkeep: 1,
  extractorBuffer: 40,
  /** Surface Mooring Towers: conservative, unvalidated balance defaults. */
  mooringEnabled: true,
  mooringRange: 10,
  mooringUpkeep: 3,
  mooringGraceTicks: toTicks(3),
  mooringTravelTicks: toTicks(3),
  mooringCooldown: toTicks(20),
  /** Storm Seeders can be built and `seed` */
  seederEnabled: true,
  /**
   * energy/s per Storm Seeder while its storm blows (an idle Seeder costs nothing). 0: one Stormcatcher inside the
   * seeded storm earns stormcatcherRate × seederDuration = 45 energy for the 40-energy seed.
   */
  seederUpkeep: 0,
  stormcatcherRate: 1.5,
  /** energy per `seed` activation */
  seederCost: 40,
  /** public warning between `seed` and the storm forming (the telegraph is in weather.seedWarnings) */
  seederTelegraph: toTicks(3),
  seederDuration: toTicks(30),
  /** from activation */
  seederCooldown: toTicks(75),
  /** 7 > islandClearance 6: a seeded storm can reach a Stormcatcher on a neighbouring island */
  seederRadius: 7,
  /** storm damage multiplier for aircraft inside a storm seeded by their own alliance */
  seededOwnDamage: 0.5,
  aerieCapacity: 4,
  aerieLaunchTicks: toTicks(2),
  aerieDockRadius: 3,
  aerieLossHealth: 0.5,
  aerieDropCooldown: toTicks(30),
  aerieDropCount: 3,
  aerieDropTravel: toTicks(2),
  /**
   * extra tiles of a MOBILE tank's (cannon) range against structures other than Spire segments: tanks out-range turrets,
   * while the edge-measured segment beam out-reaches tanks. A sieged tank uses siegeRangeStructures/Units instead.
   */
  siegeRange: 2,
  /**
   * Surface deploy stances (DESIGN §4.2 Deploy states; rules/deploy.ts). Trooper dug in: whether it is offered, ticks
   * to dig in and to climb out, damage taken fully dug in from rifle, cannon and turret hits only, extra vision tiles.
   */
  digInEnabled: true,
  digInTicks: toTicks(2),
  digOutTicks: toTicks(1),
  dugInDamageTaken: 0.6,
  dugInVision: 1,
  /**
   * Tank siege: ticks to set up and to pack; sieged cannon reach in tiles against structures and against units.
   * Absolute (replacing tank.range and the mobile siegeRange), measured to the target's edge like every weapon, high
   * ground still adds; targets nearer than siegeMinRange (to their edge) are out of reach. Sieged tanks fire over
   * cliffs at targets their team sees. Against Spire segments the reach is siegeSpireRange instead, measured like the
   * segment beam (footprint edge to the tank's body edge) and absolute (high ground does not add): at or below
   * spire.range, every segment beam answers every tank that can shell it.
   */
  siegeEnabled: true,
  siegeDeployTicks: toTicks(3),
  siegePackTicks: toTicks(3),
  siegeRangeStructures: 9,
  siegeRangeUnits: 7.5,
  siegeSpireRange: 7,
  siegeMinRange: 2,
  /** Flak emplaced: ticks to emplace and to pack; absolute range against the Sky; cooldown multiplier */
  emplaceEnabled: true,
  emplaceTicks: toTicks(2),
  unemplaceTicks: toTicks(2),
  emplacedFlakRange: 9,
  emplacedFlakCooldown: 0.75,
  /** Flak against falling payloads only: damage multiplier and extra range (added on top of the emplaced range) */
  flakPayloadMultiplier: 2,
  flakPayloadRange: 2,
  /** degrees: a fixed mount fires only when the target lies within this cone around the body heading */
  fixedMountArc: 10,
  /**
   * Solar arrays: energy/s per anchored array = solarRate × light × ramp × distance × shade. Arrays anchor where they
   * stop (solarDeployTicks; packing solarPackTicks to move) and only an anchored array produces.
   * light: 1 in a lit wedge, solarNight at night. ramp: solarRampStart → 1 over solarRampTime anchored (moving resets
   * it; a hit of ≥ solarRampHit HP takes solarRampHitLoss of its progress). distance: 1 within solarFullRange tiles of
   * the own Orbit segment's footprint edge, linear to solarFarFactor at solarFarRange and flat beyond. shade: −
   * solarShadePer per other own array within solarShadeRadius, never below solarShadeFloor.
   */
  solarRate: 2,
  solarDeployTicks: toTicks(3),
  solarPackTicks: toTicks(1),
  solarNight: 0.4,
  solarRampStart: 0.5,
  solarRampTime: toTicks(40),
  solarRampHit: 10,
  solarRampHitLoss: 0.5,
  solarFullRange: 10,
  solarFarRange: 20,
  solarFarFactor: 0.4,
  solarShadeRadius: 4,
  solarShadePer: 0.25,
  solarShadeFloor: 0.4,
  /** HP/s a packed (folded or moving) array repairs once arrayRepairDelay passes without a hit: 100 HP from 40 % in 30 s */
  arrayRepair: 2,
  arrayRepairDelay: toTicks(8),
  /** ticks to dig */
  digRock: toTicks(2),
  digOre: toTicks(3),
  digFortified: toTicks(20),
  /** Drill Bits: dig-time multiplier for cells (rock, ore, fortified) opened by a researched army's diggers; mining loads and breaking bulkheads are unchanged */
  drillBitsDig: 0.75,
  /**
   * Mother Lode mining: the time of one load as a multiple of digOre; alloy per load (oreLoad's 10 by default); diggers
   * mining one cell at once (crew slots); loads per cell (0: endless) and loads/s each cell regains up to that reserve
   */
  motherLodeDig: 2,
  /** off: only a `mine` order pointed at a Mother Lode cell mines it; generic mining (`mine` without one, auto_mine) leaves it alone */
  motherLodeAutoMine: false,
  motherLodeAlloyPerLoad: 10,
  motherLodeCrewPerCell: 1,
  motherLodeLoads: 0,
  motherLodeRegen: 0,
  /**
   * Mother Lode pressure (0–100, one shared value): each load adds lodePressurePerLoad, it bleeds lodePressureBleed/s.
   * Measured on the default S48 map (seed 7, no rails): a digger hauling from the lode mines ~0.092 loads/s (four
   * loads in 24 s at the cell, then the walk home and back), so 9 × 0.092 ≈ 0.83 < 0.85: one digger never vents.
   * Glow at lodeWarn. At lodeCritical it is committed: the bleed stops and the pressure climbs to 100 over
   * lodeFuseTicks whatever anyone does, then it vents: lodeVentBlast damage to every Depths unit within the ring plus
   * lodeVentBlastReach tiles (120: a digger, sapper or trooper dies, a Warden keeps 40 of 160 HP), and a magma flood
   * over its ring plus lodeVentBase cells and lodeVentPerLoad per load of the last lodeVentWindowTicks (at most
   * lodeVentMax); then it cools (unminable) for lodeVentCooldownTicks.
   */
  lodePressureEnabled: true,
  lodePressurePerLoad: 9,
  lodePressureBleed: 0.85,
  lodeWarn: 60,
  lodeCritical: 85,
  lodeFuseTicks: toTicks(8),
  lodeVentBlast: 120,
  lodeVentBlastReach: 1,
  lodeVentBase: 8,
  lodeVentPerLoad: 1,
  lodeVentWindowTicks: toTicks(60),
  lodeVentMax: 40,
  lodeVentCooldownTicks: toTicks(90),
  /** Shared dig plans: per-intent cells, per-team tags, and workers reserved per frontier cell. */
  designateCells: 256,
  designateMax: 512,
  designateWorkers: 2,
  /** fortify is time only (free by default): rock walls of own tunnels harden, never tunnel cells */
  fortifyCost: 0,
  fortifyTicks: toTicks(4),
  /** extra dig time each reinforce (fortifying an already fortified cell) adds, and how many reinforces a cell takes */
  reinforceTicks: toTicks(10),
  fortifyLevels: 2,
  /** ticks one digger needs to break a bulkhead at its base HP (digging deals stats.bulkhead.hp / this per tick) */
  bulkheadDigTicks: toTicks(20),
  /** fortify levels a completed bulkhead gives each rock wall cell beside it (its flanks); 0: none */
  bulkheadFlankFortify: 1,
  /** HP each fortify on an own bulkhead adds (it is also repaired to full), up to bulkheadMaxHp */
  bulkheadReinforce: 200,
  bulkheadMaxHp: 1000,
  /** Warden: fortify rate (× a digger's), whether the shield wall is offered, shield wall deploy/undeploy times, damage taken walled, and the cover own units within wallCoverReach tiles of a walled Warden get */
  wardenFortifySpeed: 2,
  wallEnabled: true,
  wallDeployTicks: toTicks(2),
  wallUndeployTicks: toTicks(1),
  wallDamageTaken: 0.4,
  wallCoverReach: 1.5,
  wallCoverDamageTaken: 0.8,
  /**
   * extra weapon range (tiles) own units in a walled Warden's cover get (braced fire over the shield). A trooper one cell
   * behind the wall must reach an attacker standing at rifle reach (4 + 0.35) from the Warden: 1 + 4.35 ≤ 4 + bonus +
   * 0.35 needs ≥ 1; 1.5 leaves margin for bodies spread inside their cells.
   */
  wallCoverRange: 1.5,
  /** Warden flare: lands within flareRange tiles, lights the tunnels within flareRange (tunnel flood, never through rock) for flareRevealTicks */
  flareRange: 5,
  flareRevealTicks: toTicks(6),
  flareCooldown: toTicks(20),
  /** alloy/s each built Headframe trickles while its lode pocket has ore left */
  headframeRate: 0.5,
  /** ticks a sapper charge needs before collapse */
  undermineTicks: toTicks(10),
  /** Shaped Charges: the fuse of a researched army's new charges, and how far its charges split a fault each way */
  shapedUndermineTicks: toTicks(7),
  shapedChasmReach: 6,
  collapseRadius: 1.5,
  collapseDamage: 400,
  /** surface structures within collapseRadius + this (tiles) of a collapse take collapse damage */
  collapseStructureReach: 1,
  /** sapper charges: a sapper within this many cells (Chebyshev) of its team's pending charge joins it; enemy depths units within defuseReach cells (per axis) defuse one; a charge destroys bulkheads within chargeBulkheadReach tiles (per axis) */
  chargeStackReach: 1,
  defuseReach: 1,
  chargeBulkheadReach: 1,
  /** sappers on one charge (the planter included) count up to chargeStackMax; each beyond the first adds chargeStackDamage × collapseDamage (default ×2 at three) */
  chargeStackDamage: 0.5,
  chargeStackMax: 3,
  /** a detonating charge strips every fortification level from rock within chargeStripReach tiles and deals chargeUnitDamage to Depths units there */
  chargeStripReach: 1.5,
  chargeUnitDamage: 60,
  /** breakout: troopers climb out this far (tiles, per axis) toward their team's map-centre side of the breach */
  breakoutOffset: 0.8,
  /** a queued bulkhead whose digger could not reach or close its cell waits this long before another digger takes it */
  bulkheadRetry: toTicks(5),
  /** depths vision (cells of tunnel flood) a built Shaft or Headframe gives around its own cell */
  shaftDepthsVision: 2,
  /** `mine`: ignore known ore within mineKeepOut tiles of the enemy Spire, mine ore within mineNear tiles of a given point first, explore with this search budget (ticks of digging/walking cost) when no ore is known */
  mineKeepOut: 9,
  mineNear: 3,
  mineExploreBudget: toTicks(150),
  /** max distance (tiles) between a towed asteroid and its deorbit target; checkRules keeps it beyond the Orbit segment beam's reach to a tug on every bearing (range + SPIRE_CORNER + tug radius) */
  deorbitRange: 10,
  /** ticks from deorbit to impact (public warning) */
  impactTicks: toTicks(8),
  impactRadius: 3,
  impactCraterRadius: 1.5,
  impactDamage: 600,
  asteroidHp: 300,
  /** tow speed multiplier */
  towSpeed: 0.5,
  /** tug latch distance (tiles) to an asteroid */
  grappleReach: 1.5,
  /** asteroid body radius (tiles, every size and resource type) */
  asteroidRadius: 0.8,
  /** asteroid pairs spawn when tick % asteroidSpawnTicks equals this (modulo the period) */
  asteroidSpawnOffset: toTicks(5),
  /** Orbit segment service and independent short-range point defence. */
  dockRadius: 3,
  orbitDockHull: 3,
  orbitDockShield: 8,
  stationPdRange: 3.5,
  stationPdDamage: 6,
  stationPdCooldown: toTicks(0.2),
  dockValue: 150,
  pebbleHp: 60,
  pebbleTowSpeed: 0.9,
  pebbleDockValue: 30,
  pebbleImpactDamage: 120,
  pebbleImpactRadius: 1.5,
  pebbleImpactTicks: toTicks(4),
  pebbleCraterRadius: 0,
  largeHp: 800,
  largeTowSpeed: 0.3,
  largeDockValue: 400,
  largeImpactDamage: 1500,
  largeImpactRadius: 4.5,
  largeImpactTicks: toTicks(12),
  largeCraterRadius: 2.5,
  pebbleChance: 0.65,
  largeChance: 0.1,
  metalChance: 0.45,
  iceChance: 0.30,
  volatileChance: 0.1,
  /** Ice yields energy only, as this fraction of its size's base dock value. */
  iceEnergyShare: 0.8,
  /** Resource units extracted per second; alloy and energy share one hold. */
  tugMineRate: 2,
  tugHold: 50,
  /** Centre-to-centre harvesting stand-off; never changes the whole-rock grapple reach. */
  tugMineReach: 3,
  asteroidDrift: 0.3,
  asteroidEdge: 2,
  oreCacheMultiplier: 2,
  oreCacheRadius: 2,
  oreCacheLoad: 30,
  oreCacheTicks: toTicks(3),
  oreCacheDepthShare: 0.25,
  volatileDamageMultiplier: 1.5,
  volatileRadiusMultiplier: 1.5,
  volatileFuseTicks: toTicks(45),
  volatileTowHpFraction: 0.5,
  volatileOrbitDamage: 300,
  volatileOrbitRadius: 3.5,
  scorchTicks: toTicks(10),
  scorchDps: 8,
  /**
   * Derelict ruin at the map centre (DESIGN §4.4; distances in S48 tiles). A static hull band with derelictBreaches
   * axis breaches, an inner ring with derelictGates gates on a public open → turn → closed → turn cycle (the ring
   * seals outside the open window), radiation inside the chamber. Scaled by size / 48, or less where the Spires stand
   * closer (`derelictScale`): hull plus derelictLane always fit inside every Spire's Orbit beam reach and deorbit
   * stand-off. Hull outer diameter 27/48 = 0.5625 of the map at the default inset, bound by S48's stand-off.
   * derelictBlocksVision: its walls block sight where they block fire, so the ruin hides an ambush (DESIGN §7).
   */
  derelictEnabled: true,
  derelictBlocksVision: true,
  derelictHullInner: 11.8,
  derelictHullOuter: 13.5,
  derelictBreaches: 4,
  derelictBreachWidth: 5.8,
  derelictRingInner: 7.2,
  derelictRingOuter: 8.4,
  derelictGates: 4,
  derelictGateWidth: 5.8,
  /** open Orbit kept between the hull and every Spire's reach: three formation slots (3 × formationSpacing) */
  derelictLane: 4.8,
  derelictOpen: toTicks(40),
  derelictTurn: toTicks(2),
  derelictClosed: toTicks(24),
  derelictRadiation: 2.5,
  /**
   * Derelict core: a bonus raid, not the economy. Heat is its clock: out past the hull it heats at coreTransitHeat
   * (heat/s on S48, × (48 / size)^coreTransitScale so the tow fits the map); vents buy time at a rising floor; the
   * ruin cools it. Towed within dockRadius of its tug's own Orbit segment it is cashed in once (coreRewardAlloy and
   * coreRewardEnergy, the energy straight to stock past the delivery cap) and regrows after coreRegrowTime.
   * Default outside-hull clock: 100 / 133.3 / 166.7 s on S48 / M64 / L80. At 0.8 tiles/s the nearest cardinal
   * breach-to-dock return takes about 24 / 35 / 46 s; the remainder covers turns, detours and interception.
   */
  coreEnabled: true,
  coreTowSpeed: 0.4,
  coreTransitHeat: 1,
  coreTransitScale: 1,
  coreRewardAlloy: 200,
  coreRewardEnergy: 200,
  coreCoolRate: 5,
  coreVentTicks: toTicks(8),
  /** heat a vent leaves: vents so far × this (each vent buys less time) */
  coreVentFloor: 25,
  coreVentDamage: 40,
  coreVentRadius: 3,
  coreHp: 500,
  coreMeltdownDamage: 400,
  coreMeltdownRadius: 4,
  coreDropTicks: toTicks(10),
  coreDropDamage: 300,
  /** extra drop damage for a cool core: × (1 − heat / 100) */
  coreDropCoolBonus: 600,
  coreDropRadius: 3.5,
  coreDropCrater: 2,
  coreIrradiateTicks: toTicks(15),
  coreIrradiateDps: 6,
  coreRegrowTime: toTicks(150),
  /** ticks for the two lit wedges to sweep half a turn: one full day/night cycle at every point */
  sunPeriodTicks: toTicks(120),
  nightVision: 0.7,
  nightSignature: 0.65,
  formationSpacing: 1.6,
  formationSlack: 1.5,
  /** default rally points: tiles past the Spire footprint edge toward the map centre, per plane */
  depthsRally: 1,
  surfaceRally: 6,
  skyRally: 4,
  orbitRally: 4,
  /** off the Depths: slots keep a unit's body this many tiles clear of its own Spire segment (rallies: of their producer) */
  rallyClearance: 1.5,
  /** clearance (tiles) between unit bodies in rally and group-move destination slots */
  slotGap: 0.15,
  captureRadius: 3,
  /** an empty, neutral or under-construction island */
  captureTicks: toTicks(5),
  /** an island carrying a built structure hostile to the capturer; the capture drains it at maxHp / this per tick */
  captureStructureTicks: toTicks(12),
  /** air units holding an island settle this far (tiles) inside the capture radius */
  captureSlack: 0.8,
  islandRadius: 2.5,
  /** vision radius (tiles) on the plane below: Relays, and spotter units (bombers) */
  relaySurfaceVision: 8,
  spotterDownVision: 3,
  /** `intercept`: hover this fraction of weapon range from the falling rock */
  interceptHover: 0.7,
  /**
   * Idle aircraft (not on `hold`) step out of a storm that damages them, unless their own order ended inside it; the
   * escape point is stormEvadeMargin tiles past the storm's edge.
   */
  stormEvadeEnabled: true,
  stormEvadeMargin: 1,
  /**
   * Idle interceptors (not on `hold`) engage a falling hostile rock whose impact would hit an own Surface structure
   * (Spire included) and lands within autoInterceptRadius tiles of the interceptor's post.
   */
  autoInterceptEnabled: true,
  autoInterceptRadius: 8,
  stormSets: 2,
  stormMinRadius: 6,
  stormRadius: 8,
  stormForecastMin: toTicks(20),
  stormForecastMax: toTicks(30),
  stormGrow: toTicks(15),
  stormLifetimeMin: toTicks(60),
  stormLifetimeMax: toTicks(120),
  stormBreak: toTicks(15),
  stormCalmMin: toTicks(8),
  stormCalmMax: toTicks(16),
  stormDrift: 0.08,
  stormSiteMinRadius: 9,
  stormSiteMaxRadius: 18,
  stormSiteLaneBias: 0.7,
  stormSpeed: 0.6,
  stormDps: 4,
  fogRadius: 6,
  fogPathRadius: 9,
  fogPeriod: toTicks(240),
  fogVision: 0.5,
  jetWidth: 3,
  jetOffset: 12,
  jetWith: 1.8,
  jetAgainst: 0.6,
  /** asteroid pacing, the same for every seat (humans, agents, bots): most drifting rocks at once, time between orbits */
  maxAsteroids: 5,
  asteroidSpawnTicks: toTicks(30),
  /**
   * Spire segments take impact damage (asteroid and core drops) × this; everything else in the blast takes it in full.
   * Impacts still ignore shields. An impact lands on the Surface, so only the Surface segment is ever hit.
   */
  spireImpactMultiplier: 0.5,
  /**
   * Sudden death (DESIGN §2): from this tick (0: never) every Spire segment takes ×suddenDeathDamage from everything
   * but rock-borne damage (asteroid and core impacts, volatile detonations), and Orbit segments stop repairing docked
   * ships. Announced suddenDeathWarningTicks before (public schedule entry and alert).
   */
  suddenDeathTicks: toTicks(22 * 60),
  suddenDeathWarningTicks: toTicks(60),
  suddenDeathDamage: 1.5,
  /**
   * Crowns (rules.spire.lossRule 'crowns', DESIGN §2): crowns a fallen Surface segment costs, crowns any other fallen
   * segment costs, and crowns lost that eliminate the army. The Surface alone, or any two side segments, ends it.
   */
  crownsSurface: 2,
  crownsSide: 1,
  crownsToLose: 2,
  /**
   * Segment rebuild (queue item `rebuild`, DESIGN §5.1): per army per match (0: off), its cost, its build time, the
   * clearance (tiles from the segment's footprint edge) no seen enemy unit on that plane may stand inside while it
   * builds, and the fraction of full HP the segment returns with. A rebuilt segment returns its crown.
   */
  rebuildsPerMatch: 1,
  rebuildAlloy: 400,
  rebuildEnergy: 200,
  rebuildTicks: toTicks(90),
  rebuildClearance: 6,
  rebuildHp: 0.4,
  /**
   * Alert `segment_threatened`: an own segment that took hostile damage within threatWindowTicks, or stands below
   * threatHp of its full HP.
   */
  threatHp: 0.25,
  threatWindowTicks: toTicks(5),
  /** orbital scan: energy cost, cooldown, reveal radius (all planes) and duration */
  scanCost: 50,
  scanCooldownTicks: toTicks(20),
  scanRadius: 6,
  scanTicks: toTicks(5),
  /** ticks an enemy depths unit must stay within 1 cell of a charge to defuse it */
  defuseTicks: toTicks(2),
  /** tiles: enemy depths units this close beneath your surface units/structures show up as tremors */
  tremorRadius: 2,
  /** charges are fogged: a hostile team knows a planted charge only through its own Depths vision of the cell or a
   *  tremor it feels there (tremorRadius under its surface presence), and every team for the last chargePublicTicks */
  chargesFogged: true,
  chargePublicTicks: toTicks(5),
  /** tiles: hostile Depths units seen in or beside own tunnels this close to an own Depths structure, Shaft, Headframe
   *  or the Spire raise the `intruder` alert and event */
  intruderRadius: 6,
  /** Spire trickle multiplier once the depths root segment is destroyed */
  rootlessTrickle: 0.5,
  /** depths movement multipliers: tunnels are highways, rails faster still (either team may use any rail) */
  tunnelSpeed: 1.5,
  railSpeed: 2.5,
  /** depths steering: path cells looked ahead for a straight sight line, the carrot distance (tiles) at which the next waypoint is sighted, and the heading turn rate (rad/s) */
  depthsLookCells: 8,
  depthsCarrot: 0.5,
  depthsTurnRate: 3 * Math.PI,
  /** alloy and ticks a digger needs to lay rail on one tunnel cell */
  railCost: 5,
  railTicks: toTicks(1),
  /** ticks troopers need to dig up from a tunnel cell to the surface (a `breach` hole) */
  breachTicks: toTicks(6),
  /** a charge under a fault cell opens the fault this many cells each way along it (chasm) */
  chasmReach: 4,
  /** alloy and ticks a digger needs to backfill (`bridge`) one hole cell, and the hole kinds it may fill (bit i: HOLE_KINDS[i]; 15 = all, 0 = off) */
  bridgeCost: 30,
  bridgeTicks: toTicks(8),
  backfillKinds: 15,
  /** magma flood from a breached pocket: cells flooded beyond the pocket, over this many ticks, damage per second, cooling time */
  magmaCells: 6,
  magmaSpreadTicks: toTicks(5),
  magmaDps: 12,
  magmaCoolTicks: toTicks(60),
  /** magma reaching a depths cell burns the crater-ore share of any ore cache there */
  magmaDestroysCaches: true,
  /**
   * lava bridges over permanent lava-lake cells (`bridge` on a lake cell): alloy and ticks per cell, the most bridge
   * cells a span may run from dry ground, and the tiles (per axis) a detonating charge reaches to destroy bridges
   */
  lavaBridgeCost: 40,
  lavaBridgeTicks: toTicks(10),
  lavaBridgeSpan: 3,
  chargeBridgeReach: 1,
  /** green rich ore: alloy per load mined and ticks per load (digging a rich cell open also takes this) */
  richLoad: 25,
  digRich: toTicks(5),
  /** surface movement multipliers (cliff: impassable) */
  forestSpeed: 0.7,
  fordSpeed: 0.5,
  /** units and structures standing on high ground: + range and + vision (tiles); they see and shoot over cliffs, and low ground never sees high ground */
  highRange: 1,
  highVision: 2,
  /** surface units in a forest are hidden unless an enemy surface unit/structure is this close (tiles), or Sky vision or a scan covers them */
  forestSpot: 2,
  /** fraction of max HP a surface unit that can climb back out (TRANSITS.descend kinds) loses when it falls into the depths */
  fallDamage: 0.25,
  /**
   * fraction of max HP any other surface unit (vehicles: tanks, flak) loses when it falls into the depths: it can
   * neither climb out nor hit Depths units, so by default the fall wrecks it and frees its population slot
   */
  vehicleFallDamage: 1,
  /**
   * Drill Yard and Breacher (DESIGN §4.2 Drill Yard and Breacher): whether the Drill Yard can be built (and so
   * Troopers converted), most Drill Yards (sites included) per team, the Breacher flamer's multiplier against a fully
   * dug-in Trooper (replaces its ×light multiplier and ignores the dug-in reduction), and its splash cone: full width
   * in degrees around the shooter→target bearing. Conversion cost and time are the `breacher` stats row (alloy,
   * energy, build).
   */
  breachersEnabled: true,
  drillYardMax: 1,
  breacherDugInMultiplier: 2,
  breacherConeArc: 60,
  /**
   * Surface build radius (tiles from the source's footprint centre to the placed structure's footprint centre): own
   * live, completed Spire, Shafts and Headframes project it; turrets project none. No Surface structure may stand
   * with its centre within enemySpireNoBuild tiles of the enemy Spire footprint edge.
   */
  buildRadiusSpire: 12,
  buildRadiusShaft: 7,
  buildRadiusHeadframe: 7,
  enemySpireNoBuild: 8,
  /**
   * Forward posts (DESIGN §4.2 Outposts): Surface hold zones from the map document (or, where it places none, the map
   * recipe: rules.map postCount, postDistanceMin/Max, postSpread, postClearance, contestedPosts). Home posts (one set
   * per army) start held by their army when homePostsOwned; contested points (the centre, the flanks) start neutral.
   * Any Surface unit within postCaptureRadius holds one; a single alliance holding it uncontested for postCaptureTicks
   * (contested points: contestedCaptureTicks) takes it. A held post gives its owner postVision (over cliffs and onto
   * high ground), projects postBuildRadius (contested points: contestedPostBuildRadius) and heals the owner's
   * alliance's wounded Surface units within postHealRadius from a pool of postHealPool HP/s split evenly among them, at
   * most postHealRate HP/s each. Each second an army holds a contested point scores postScore points: the last
   * time-cap tiebreak. No income, never damaged.
   */
  postsEnabled: true,
  homePostsOwned: true,
  postCaptureRadius: 2.5,
  postCaptureTicks: toTicks(5),
  contestedCaptureTicks: toTicks(8),
  postVision: 7,
  postBuildRadius: 7,
  contestedPostBuildRadius: 0,
  postHealRadius: 4,
  postHealRate: 3,
  postHealPool: 12,
  postScore: 1,
  /** army build queue: most entries per army, most entries in one output-plane lane */
  queueTeamMax: 24,
  queueSeatMax: 8,
  /** Fair allocation: one guaranteed admission per plane, bounded worker recovery and finite grid buffer. */
  queueLaneSlots: 1,
  queueRecoveryFraction: 0.2,
  queueRecoveryWorkers: 2,
  queueUpkeepSeconds: 1,
  queueBlockedGrace: toTicks(5),
  queueRecoverySupply: 2,
  /** share of an entry's cost refunded when it is cancelled after it started (before it starts: always all of it) */
  queueRefund: 0.5,
  /** production caps: units alive per team, structures (sites included) per team */
  popCap: 160,
  structureCap: 30,
  /** structure sites start at siteStartHp of max HP and gain buildHpGain of it over their build time */
  siteStartHp: 0.1,
  buildHpGain: 0.9,
  /** ticks a unit without its own Orbit acceleration needs to reach full speed from rest (it brakes twice as hard) */
  moveRamp: toTicks(0.25),
  /** `transfer`: open-ground search radius beyond a Shaft body, and the arrival distances at a Shaft (beyond both radii) and off the Surface */
  transferEdge: 1,
  transferPadReach: 0.25,
  transferReachOther: 1.0,
  /** emerging from the depths: a unit lands this far (tiles, per axis) toward its team's map-centre side of the portal */
  emergeOffset: 0.8,
  /** combat: splash multiplier off the aimed target, direct-hit radius of non-homing shots, firing-distance floor, fight-move contact reach, bomb release distance on a plain move, defensive return-to-post distance */
  splashFactor: 0.5,
  directHit: 0.25,
  minFiringRange: 0.5,
  moveFrontContact: 1,
  bombRelease: 0.5,
  returnToPost: 1.5,
  /**
   * team signals (typed teammate requests): on/off, new signals per second per seat and their burst, open signals per
   * seat, how long an open signal waits for an answer and how long a closed one stays visible. Each at most
   * SIGNAL_LIMITS_MAX (rules/signals.ts), which sizes the observation lists.
   */
  signalsEnabled: true,
  signalRate: 0.5,
  signalBurst: 4,
  signalMaxOpen: 3,
  signalTtlTicks: toTicks(45),
  signalKeepTicks: toTicks(8),
};
