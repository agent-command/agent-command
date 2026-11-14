// Agent Command's built-in bot library: packages/game/src/sim/ent.ts, types stripped (pnpm bots:build). Read it, import it,
// or fork a module by copying it into your own policy modules (skill policies.md, "The built-in bots' source").
import { NEUTRAL, } from '../util/teams.js';
import { GOAL_NONE } from './constants.js';


export const NEUTRAL_STATS = { hp: 1, speed: 0, dmg: 0, range: 0, cooldown: 0, vision: 0, damage_taken: 1 };

const NO_CAPABILITIES = { spotterDown: false, capture: false, tow: false, carry: false, dig: false, build: false, fortify: false, lens: false };


/** Every order kind, in hash-code order (`sim/hash.ts` mixes index + 1): append new kinds, never reorder. */
export const ORDER_KINDS = [
  'none', 'move', 'patrol', 'attack', 'dig', 'mine', 'fortify', 'bulkhead', 'undermine', 'rail', 'breach',
  'bridge', 'transfer', 'capture', 'grapple', 'intercept', 'convert', 'vent', 'mine_asteroid', 'hangar',
];


export const NONE = { k: 'none' };

export class Ent {
  id = 0;
  kind = 'digger';
  /** owner: army index or NEUTRAL; change it only through Sim.setSide (keeps `frame` in step) */
  side = NEUTRAL;
  /** the owner's frame (quarter turns; 0 for neutral): the frame its cells and tie-breaks resolve in */
  frame = 0;
  plane = 'surface';
  x = 0;
  y = 0;
  hp = 1;
  maxHp = 1;
  shield = 0;
  maxShield = 0;
  combatAt = -1;
  stationPdCd = 0;
  abilityReady = 0;
  lanceAt = 0;
  lanceX = 0;
  lanceY = 0;
  aegisUntil = 0;
  aegisPool = 0;
  cloakReady = 0;
  cloaked = false;
  /** Deploy stance phase (DEPLOY_*; rules/deploy.ts) and the tick its current transition completes */
  deploy = 0;
  deployAt = 0;
  /** Derived registry references; shared by kind/team/plane, never allocated per entity. */
  statRow = NEUTRAL_STATS;
  statPlane = 'surface';
  capabilities = NO_CAPABILITIES;
  mount;
  /** Derived exact-point weather membership; refreshed after movement or any weather mutation. */
  stormVersion = -1;
  stormX = 0;
  stormY = 0;
  stormMask = 0;
  state = 'idle';
  /** digger: alloy carried; spire: queued units */
  carry = 0;
  /** digger: the part of `carry` that came from lode pockets */
  lodeCarry = 0;
  /** digger: the solid cell it dug this tick (-1 none) */
  digAt = -1;
  /** Automatic tag reservation; never replaces the explicit order. */
  designation = -1;
  /** The sole untagged wall this assignment may dig to bridge a diagonal corner. */
  designationConnector = -1;
  designationChecked = -1;
  designationCell = -1;
  /** tug↔asteroid, relay→island, island→relay; 0 = none */
  link = 0;
  /** island → the entity on its hardpoint (the attach slot beside the build slot, HARDPOINT_KINDS); 0 = none */
  hardpoint = 0;
  /** Finite island deposit and extracted cargo survive every attachment and ownership change. */
  oreCapacity = 0;
  oreRemaining = 0;
  oreBuffer = 0;
  /** Aerie housing this air unit; remains authoritative through launch preparation. */
  hangar = 0;
  ready = 0;
  activeUntil = 0;
  /** Whole ticks stopped on the circular route; release resumes the delayed phase, never catches up. */
  orbitDelay = 0;
  /** Tower target and island holder are separate from ownership and build-slot links. */
  mooringTarget = 0;
  mooringTower = 0;
  /** Island: 0 drifting, 1 lowering, 2 held, 3 raising (may wait fully lowered for a safe gap). */
  mooringPhase = 0;
  /** Tower's nonrenewable unpaid grace and energy arrears. */
  mooringGrace = 0;
  mooringDebt = 0;
  mooringReadyAt = 0;
  mooringAt = 0;
  mooringRiseAt = -1;
  /** Sky-only vertical offset in world tiles; no plane, weather, sight or weapon-range change. */
  elevation = 0;
  /** Aircraft's operating island, retained while idle at its deck, cleared on departure. */
  skyIsland = 0;
  /** Geothermal pocket identity and cooling deadline (-1: still sealed). */
  pocket = 0;
  coolAt = -1;
  progress = -1;
  cd = 0;
  /** Generic deadlines in ticks; their hash slots deliberately retain the original timing order. */
  transitAt = 0;
  transitUntil = 0;
  transitReady = 0;
  transitKind;
  transitX = 0;
  transitY = 0;
  order = NONE;
  built = true;
  dead = false;
  lastHitBy = NEUTRAL;
  /** Authoritative final damage source, retained for native recording (not sent in fogged views). */
  lastHitCause = 'unknown';
  lastHitPlane;
  lastHitKind;
  /** Public valuation provenance, independent of later plane transfers or producer destruction. */
  replacementAlloy = 0;
  replacementEnergy = 0;
  productionRole;
  /** ticks of work on the current job (fortify, bulkhead, breach, mining a load); digging damage belongs to the cell */
  workT = 0;
  /** body radius (tiles) */
  radius = 0.5;
  /** kind flags, fixed at creation */
  unit = false;
  structure = false;
  /** index in Sim.ents as of the last spatial index build */
  slot = -1;
  /** depths: the tunnel cell the unit occupies (kept while it walks to the next cell centre; -1 = derive from x/y) */
  cell = -1;
  /** per-owner creation serial: rotated twins of the armies share it (rotation-exact tie-breaks) */
  seq = 0;
  stance = 'aggressive';
  /** orders after the current one (`queue: true`) */
  queue = [];
  /** enemy currently engaged by fight logic (0 = none) */
  engage = 0;
  /** Passing-fire target only; unlike engage, never affects navigation or formation speed. */
  aimTarget = 0;
  /** Target a fixed or forward mount is bringing its body to bear on (Orbit ships turn toward it, not their velocity). */
  faceTarget = 0;
  /** standing in range and firing (range hysteresis); ticks it has stood there without a line of fire */
  firing = false;
  blind = 0;
  /** where the unit stood when it started chasing (leash centre) */
  ax = 0;
  ay = 0;
  anchored = false;
  /**
   * Storm evade (rules.sky.stormEvadeEnabled): `stormOk`, an aircraft whose own order ended inside a damaging storm
   * (ordered in) stays there until it is clear of every damaging storm; `evading`, its current move is the sim's own
   * step out of a storm (ending it inside one does not count as ordered in).
   */
  stormOk = false;
  evading = false;
  /** damage already in flight toward this entity (overkill prevention) */
  pending = 0;
  /** this combat phase's row in the Sim's shot rows (SimCombat.reserve); -1 outside combat or not shot this tick */
  pendingRow = -1;
  // navigation
  path = null;
  pathI = 0;
  /** Smoothed depths waypoint: index into `path` it steers to in a straight line, valid for that path and `depthsVersion`. */
  smoothPath = null;
  smoothI = 0;
  smoothVer = -1;
  /** the waypoint was re-sighted from inside the carrot distance */
  smoothNear = false;
  /** The depths path planned from flowing magma (identity, like smoothPath): only it may step on through magma. */
  escapePath = null;
  navGoal = GOAL_NONE;
  navVer = -1;
  navDirect = false;
  /** surface: tick of the last waypoint plan, and the waypoint being steered at */
  navAt = -1;
  wx = 0;
  wy = 0;
  /** arrival watchdog (`Sim.stalled`): point steered at, best distance to it since tick progAt, last tick checked */
  progX = 0;
  progY = 0;
  progD = 0;
  progAt = 0;
  progLast = -1;
  // islands
  orbitR = 0;
  orbitA0 = 0;
  orbitW = 0;
  capSide = NEUTRAL;
  rockSize = 'medium';
  resourceType = 'metal';
  volatile = false;
  /** Remaining recoverable alloy (metal) or energy (ice); independent of cargo already extracted. */
  resourceRemaining = 0;
  /** Exclusive stationary harvesting latch, separate from the whole-rock tow link. */
  miningTug = 0;
  miningTarget = 0;
  cargoAlloy = 0;
  cargoEnergy = 0;
  /** Instability is armed only while a volatile rock is attached to a tug. */
  fuseUntil = 0;
  capT = 0;
  /** Derelict core: vents so far (each leaves vents × coreVentFloor heat), and heat 0..100 (meltdown at 100). */
  vents = 0;
  heat = 0;
  /** Derelict core: heat/s last tick (negative: cooling in the chamber). */
  heatRate = 0;
  /** Solar array: exposure ramp progress 0..1 (anchored time over solarRampTime) and energy/s last tick. */
  ramp = 0;
  output = 0;
  /** An auto-deploy unit (solar array) held packed by `deploy` off until its next real order. */
  folded = false;
  /** velocity, tiles/tick: drifting asteroids; units on the open planes (surface, sky, orbit) */
  vx = 0;
  vy = 0;
  /** Orbit velocity at the start of this tick: pursuit leads it, so the update order never shows a mover's new velocity. */
  tvx = 0;
  tvy = 0;
  /** Bearings in the owner's canonical frame, so rotated traversals use identical arithmetic. */
  heading = Math.PI / 4;
  aim = Math.PI / 4;
  /** Dimensionless ORCA bend / wanted speed, smoothed over ticks: avx along the wanted heading, avy to its left. */
  avx = 0;
  avy = 0;
  /** ticks avoidance has left the unit (nearly) no way toward its goal, and ticks left of going around instead */
  stuck = 0;
  bypass = 0;
  /** ticks left of shoving through own idle units (boxed in against them); `shoved`: the last escape tried was that */
  shove = 0;
  shoved = false;
  /** going round a ruin wall's circle: the side (±1 counter-/clockwise, 0 not), kept with hysteresis (`derelictRoute`) */
  skirt = 0;
  /** sliding along a ruin wall face, between its enter and exit margins (`derelictSkim`) */
  skim = false;
  fx = 0;
  fy = 0;
  ix = 0;
  iy = 0;
  impactTick = 0;
}

/** Orders entities by per-owner creation serial: rotated twins of the armies sort alike (rotation-exact ties). */
export const bySeq = (a, b) => a.seq - b.seq;
