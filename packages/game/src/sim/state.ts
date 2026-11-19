/** Per-army, per-vision-group and per-match state records the Sim object holds (DESIGN §15.2). */
import type {
  Fx,
  GameEvent,
  Kind,
  Plane,
  QueueItem,
  QueueReason,
  QueueStatus,
  SeatMandate,
  StatKind,
  UpgradeId,
  Weapon,
} from '../rules/contract.ts';
import type { Army, SideId } from '../util/teams.ts';
import { type EffectiveStats, Ent } from './ent.ts';
import type { AliasTable } from './aliases.ts';
import type { Controller, IntentSource } from 'playerthree';

/** A game event as the sim records it: `side` and `killer` are owner indices (agent/present.ts names them for the contract). */
export type SimEvent = Omit<GameEvent, 'side' | 'killer'> & { side?: SideId; killer?: SideId };
/** A falling payload's marker as the sim records it: `id` is the sim id (agent/present.ts names it per viewer). */
export type SimFall = Omit<NonNullable<Fx['fall']>, 'id'> & { id: number };
/** A render effect as the sim records it: `side` is an owner index, `src` and `fall.id` sim ids (agent/present.ts names them). */
export type SimFx = Omit<Fx, 'side' | 'src' | 'fall'> & { side?: SideId; src?: number; fall?: SimFall };

export type ModifierRows = Record<Plane, Record<StatKind, EffectiveStats>>;

/** One plane-owned intent lane entry; only its next eligible commitment holds shared-bank backing. */
export interface QueueEntry {
  /** per-army sequence number (`q_<id>`), so rotated armies number entries alike */
  id: number;
  item: QueueItem;
  /** producer plane: a unit's Spire segment, a structure's own plane */
  plane: Plane;
  /** shaft/turret/headframe: site (cell centre; a Headframe's lode outcrop); relay: the island's position when queued; bulkhead: its depths cell centre */
  x: number;
  y: number;
  /** relay: the island entity id (0: none) */
  island: number;
  /** Explicit forward producer; zero selects the plane’s Spire. */
  producer: number;
  pocket: number;
  /** bulkhead: the digger asked for (before it starts), then the digger building it (0: none) */
  digger: number;
  /** bulkhead: no builder is looked for before this tick (its last one could not reach the cell or finish) */
  retry: number;
  /** requesting seat and its controller when it asked */
  by: Plane;
  byCtl: Controller;
  /** Trusted origin, independent of the seat's currently assigned controller. */
  source: IntentSource;
  /** paid and in progress */
  started: boolean;
  /** Actual shared-bank backing, never additional currency. */
  heldAlloy: number;
  heldEnergy: number;
  /** Selected next commitment, and whether it uses the bounded recovery slice. */
  funding: boolean;
  recovery: boolean;
  /** First temporarily blocked tick; -1 while eligible. */
  blockedAt: number;
  /** units: production ticks left once started */
  left: number;
  /** structures: the construction site entity once started (0: none) */
  site: number;
  status: QueueStatus;
  reason: QueueReason | null;
}

export interface ArmyStats {
  alloyMined: number;
  energyDelivered: number;
  produced: number;
  unitsLost: number;
  kills: number;
  structuresLost: number;
  collapses: number;
  impacts: number;
  interceptions: number;
  islandTicks: number;
  spireDamageDealt: number;
  lodeAlloy: number;
  fortified: number;
  bulkheads: number;
  headframes: number;
  /** Deploy stances started (shield walls, dug in, siege, emplaced; rules/deploy.ts) */
  deploys: number;
  /** Warden flares thrown */
  flares: number;
  /** Troopers converted into Breachers at a Drill Yard */
  conversions: number;
  /** forward posts captured, ticks of forward posts held and of contested points held (each summed over posts) */
  postsCaptured: number;
  postTicks: number;
  pointTicks: number;
  /** Island catches and Storm Seeder storms started. */
  moorings: number;
  seeds: number;
  emplaced: number;
  /** derelict cores towed home and cashed in */
  coreCashed: number;
}

export interface SeatState {
  controller: Controller;
  mandate: SeatMandate;
}

/** Everything one army owns (resources, queue, research, dig plan, nav caches, events); fog lives in its VisionGroup. */
export interface ArmyState {
  army: Army;
  /** armyBit(army): this army's bit in per-cell army masks */
  bit: number;
  /** the vision group (alliance) whose fog this army sees through */
  group: VisionGroup;
  alloy: number;
  energy: number;
  /** Observation-only totals: income A/E, spend A/E, refund A/E; then the same six per seat. */
  accounting: Float64Array;
  /** alloy income per tick, ring of the last 10 s */
  income: Float64Array;
  tickIncome: number;
  surfaceIncome: Float64Array;
  tickSurfaceIncome: number;
  geothermal: number;
  solar: number;
  cap: number;
  delivered: number;
  /** Stored solar surplus (energy, 0..solarBankMax); authoritative and hashed. */
  energyBank: number;
  /** energy/s the bank released through the delivery cap this tick (part of `delivered`, Orbit's income row) */
  bankDischarge: number;
  /** energy/s the army's built turrets draw, and whether it was paid this tick (unpaid: turrets offline) */
  upkeep: number;
  /** Local Sky energy bypasses delivery capacity; exposed separately from Orbit generation. */
  stormcatcher: number;
  skyUpkeep: number;
  powered: boolean;
  pop: number;
  structures: number;
  designations: Uint8Array;
  /** Maintained on tag edits so every seat's observation need not repack the entire grid. */
  designationWords: { normal: number[]; urgent: number[] };
  designationCount: number;
  designationDirty: boolean;
  designationRevision: number;
  designationKnown: Uint8Array;
  designationGate: Uint8Array;
  designationReserved: Uint8Array;
  designationDistance: Float64Array;
  designationOwner: Int32Array;
  designationNext: Int32Array;
  designationVia: Int32Array;
  /** cells that accept ore deliveries */
  drop: Uint8Array;
  /** cost field toward known ore, rebuilt at most once per tick (see oreFieldTick) */
  oreField: Float64Array;
  oreFieldTick: number;
  /** ore cells miners may target (known ore away from hostile Spires) */
  oreGoal: Uint8Array;
  /** Plane lanes stored together; relative order matters only within each output plane. */
  queue: QueueEntry[];
  queueSeq: number;
  /** what this army calls each entity it knows (sim/aliases.ts): every fogged output's entity ids */
  aliases: AliasTable;
  research: Set<UpgradeId>;
  spire: Record<Plane, Ent>;
  stats: ArmyStats;
  events: SimEvent[];
  timeline: SimEvent[];
  seats: Record<Plane, SeatState>;
  spireEventAt: Record<Plane, number>;
  /** tick each segment last took hostile damage (alert segment_threatened; own knowledge) */
  spireHitAt: Record<Plane, number>;
  /** tick each segment last fell (the decisive fall names the killer); kept after a rebuild */
  spireFellAt: Record<Plane, number>;
  /** segment rebuilds completed this match (rules.spire.rebuilds); hashed */
  rebuilds: number;
  /** tick of this army's last `irradiated` event (throttled like the Spire alarm) */
  radiationEventAt: number;
  spawnI: number;
  /** tick the orbital scan is ready again */
  scanReadyAt: number;
  /** active scans: centre and last tick */
  scans: { x: number; y: number; until: number }[];
  /** last vision tick hostile Depths units intruded near home (`intruder`; -1: never): a new episode re-alerts after INTRUDER_REALERT */
  intruderAt: number;
  /** rally point per Spire segment */
  rally: Record<Plane, { x: number; y: number }>;
}

/**
 * Fog state of one vision group: every army of an alliance stamps and reads it, so allies share vision by
 * construction (DESIGN §15.5). Current visibility, tremor presence and forest spotting are the Sim's per-plane
 * bit-planes (`vis`, `feel`, `spot`), one bit per group.
 */
export interface VisionGroup {
  /** index into Sim.groups; its bit in the vision bit-planes is 1 << id */
  id: number;
  bit: number;
  /** member armies, in army order */
  armies: Army[];
  /** depths knowledge: last seen CELL code per cell (0 unknown) */
  known: Uint8Array;
  /** Tick each `known` cell last changed: the depths seat's observation sends only cells changed since its `since`. */
  knownAt: Int32Array;
  /** Located sealed pocket identity per cell (0 unknown/spent), remembered until an observed breach. */
  pocketKnown: Uint8Array;
  /** crack stage last seen or known per depths cell (see refreshCracks) */
  cracks: Uint8Array;
  /** 1 where the last-seen crack holds hostile dig damage on a wall of the group's own tunnels (see refreshCracks) */
  wallDig: Uint8Array;
  /** hostile bulkheads the group sees or remembers, as gate bits (its planners route around them; see knownGate) */
  gateKnown: Uint8Array;
  /** hostile structures last seen: id → ghost */
  memory: Map<number, Ghost>;
  /** hostile sappers seen in the depths: id → tick last alerted */
  sapperSeen: Map<number, number>;
  /** upgrades whose effects the group has observed, per army (index: army) */
  seenResearch: Set<UpgradeId>[];
}

export interface Ghost {
  kind: Kind;
  side: SideId;
  plane: Plane;
  x: number;
  y: number;
  /** Last-seen Sky height, never updated while the structure is hidden. */
  elevation?: number;
  seen: number;
}

export interface Charge {
  side: Army;
  c: number;
  at: number;
  /** consecutive ticks a hostile depths unit has stood within 1 cell */
  defuse: number;
  /** sappers on it, the planter included (stacked damage counts up to rules.depths.chargeStackMax) */
  stack: number;
  /** fault cells a chasm from this charge opens each way (chasmReach, or shapedChasmReach with Shaped Charges) */
  reach: number;
  /**
   * Vision-group bits that know of it (rules.depths.chargesFogged): the planter's group from the start, others once
   * they see or feel its cell, every group from at − chargePublicTicks. Knowledge is kept: a charge never moves.
   */
  known: number;
}

/** A Warden flare: lights the tunnel flood within rules.depths.flareRange of cell `c` for `side` until tick `until`. */
export interface Flare {
  side: Army;
  c: number;
  until: number;
}

/** A discoverable outcrop over a sealed ore pocket; position and seal memory are per vision group. */
export interface LodeState {
  c: number;
  rich: boolean;
  loads: number;
  /** ore loads left in the pocket */
  left: number;
  open: boolean;
  /** Group bits: has the group ever seen the Surface outcrop? */
  known: number;
  /** Group bits: was the outcrop open when the group last saw it? */
  seenOpen: number;
}

/** A magma flood (a breached pocket, or the Mother Lode venting): spreads through connected tunnels, burns, then cools to open tunnel. */
export interface Flood {
  /** army whose digging (or collapse/impact) broke the pocket, or NEUTRAL (and always for a vent) */
  side: SideId;
  /** breakout cell (a vent: the first Mother Lode cell) */
  origin: number;
  /** cells flooded so far, in order */
  cells: number[];
  /** most cells it floods (a pocket: the breakout cell + magmaCells) */
  limit: number;
  /**
   * A Mother Lode vent: it spreads breadth-first in frame 0 and floods each step's cell with its rotations (one rotation
   * orbit per step), so a symmetric flood stays symmetric. A pocket flood spreads one cell a step in its origin's frame.
   */
  orbit: boolean;
  /** tick of the next spread step (while cells remain to flood) */
  nextAt: number;
  /** tick it cools to open tunnel */
  coolAt: number;
  /** First cell each vision group located (own action, public hole or vision); -1 until then. Never expose the hidden origin. */
  knownAt: Int32Array;
}

/** A render effect plus what the fog filter needs to decide who may see it. */
export interface FxRec {
  fx: SimFx;
  /** Native-only death attribution; deliberately outside the public render-effect schema. */
  cause?: string;
  killer?: Army;
  attackerPlane?: Plane;
  attackerKind?: Kind;
  alloyValue?: number;
  energyValue?: number;
  /** visible to everyone (collapses, impacts, …) */
  pub: boolean;
  /** army that caused/owns it (its group always sees it), or NEUTRAL */
  owner: SideId;
  /** shots: the target's side, and whether the target is public (falling asteroid) */
  tside?: SideId;
  tpub?: boolean;
  /** Optional event-time audience (vision group bits); do not reveal an old detonation when vision arrives later. */
  viewers?: number;
  /** Event-time groups that saw the exact source/target entity, not another body at the same x/y. */
  sourceViewers?: number;
  targetViewers?: number;
}

/** A shell/bomb/missile in flight. Not an entity: it cannot be targeted, it only lands. */
export interface Projectile {
  by: Army;
  source: string;
  sourcePlane: Plane;
  /** Authoritative endpoint heights when fired (tile offsets); planar damage rules do not use height. */
  sourceElevation: number;
  targetElevation: number;
  w: Weapon;
  /** damage before the armor multiplier */
  dmg: number;
  splash: number;
  plane: Plane;
  /** aim point (target position when fired) */
  x: number;
  y: number;
  target: number;
  homing: boolean;
  arrive: number;
  /** damage reserved on the target (released on landing) */
  reserved: number;
}

/** Travelling piercing bolt; geometry stays in the firing army's canonical frame. */
export interface Lance {
  by: Army;
  x: number;
  y: number;
  dx: number;
  dy: number;
  distance: number;
  hit: Set<number>;
}

/** A body disc (centre and radius, tiles) that a slot must keep clear of. */
export interface Disc { x: number; y: number; r: number }

export interface OreCache {
  id: number;
  x: number;
  y: number;
  alloy: number;
  belowX: number;
  belowY: number;
  belowAlloy: number;
  side: SideId;
  surfaceHolder: SideId;
  surfaceTicks: number;
  depthsHolder: SideId;
  depthsTicks: number;
  placed: boolean;
}

export interface Scorch {
  x: number;
  y: number;
  radius: number;
  until: number;
  by: Army;
  /** damage per second to Surface units inside, and the cause it records (volatile scorch, irradiated core ground) */
  dps: number;
  cause: 'scorch' | 'radiation';
}
