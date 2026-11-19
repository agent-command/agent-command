/**
 * Fogged presentation: everything that leaves the sim for a team goes through here.
 * Rules: own entities always; islands, forward posts and falling asteroids are public; anything else only while the team
 * currently sees its cell on its plane. Depths cells are the team's persistent knowledge. Enemy orders
 * (destinations) are never exposed.
 */
import {
  CELL,
  HOLE_KINDS,
  footprintDistance,
  LODE_PRESSURE_MAX,
  sunHalfWidth,
  PLANES,
  KINDS,
  CROSS_PLANE_EVENTS,
  OBS_FIELD_PLANES,
  SUMMARY_COUNT_CAP,
  SUMMARY_SHAFT_CAP,
  SUMMARY_TRANSIT_CAP,
  QUEUE_LIST,
  TICK_RATE,
  isUpgrade,
  UPGRADES,
  resolveUpgrade,
  upgradeBeneficiaries,
  isIslandStructure,
  isIslandBuild,
  isNeutralKind,
  VISION_BITS_PER_WORD,
  buildRadiusData,
  isUnitKind,
  CARRY_CAP,
  CHARGE_CAP,
  FLARE_CAP,
  CRACK_CAP,
  GHOST_CAP,
  HP_CAP,
  IMPACT_CAP,
  OBS_ENTITY_CAP,
  OBS_EVENT_CAP,
  OBS_GRID,
  ORE_CACHE_CAP,
  REPORT_TIMELINE_CAP,
  SCHEDULE_CAP,
  SCORCH_CAP,
  TREMOR_CAP,
  VIEW_ENTITY_CAP,
  VIEW_EVENT_CAP,
  VIEW_FX_CAP,
  VIEW_GRID,
  WAYPOINT_CAP,
  type Entity,
  type Fx,
  type GameEvent,
  type FullObservation,
  type Observation,
  type GameObservation,
  type GameView,
  type ObserverView,
  type MatchData,
  type Outcome,
  type QueueEntryOut,
  type Plane,
  type Report,
  type Side,
  type ArmyId,
  type State,
  type View,
  isHardpointKind,
} from '../rules/contract.ts';
import { CACHE_DEPTHS, CACHE_SURFACE } from '../sim/vision.ts';
import { openWindow } from '../rules/derelict.ts';
import { DEPLOY_NONE, DEPLOY_PACKING, PLANE_INDEX } from '../sim/constants.ts';
import { cellCentreX, cellCentreY, cellOf, cellOfEnt } from '../util/grid.ts';
import { gridPosition, round2, sq } from '../util/math.ts';
import { QUARTER_TURN, type Army, canonCell, canonX, canonY, isArmy } from '../util/teams.ts';
import { type Ent, type Order } from '../sim/ent.ts';
import { type Sim } from '../sim/sim.ts';
import type { ArmyStats, SimEvent, SimFx } from '../sim/state.ts';
import { planeAlerts, type ChargeUnder, type Intrusion } from './alerts.ts';
import { publicStorm } from '../planes/weather.ts';
import { dmath } from '../util/fdlibm.js';

const VIEW_EVENT_WINDOW = 10 * TICK_RATE;
/** Depths states worked in place beside or on a cell: no travel heading, even with the last path step left. */
const DEPTHS_WORK_STATES: Partial<Record<State, true>> = { digging: true, mining: true, contested: true, fortifying: true, constructing: true, bridging: true, undermining: true, breaching: true };

/** The army a contract id names in this match (throws for an army that does not play it: a host bug). */
function armyOf(sim: Sim, id: ArmyId): Army {
  const a = sim.armyIndex(id);
  if (a < 0) throw new Error(`army ${id} does not play this match`);
  return a;
}

/**
 * A presented position: on grid `g` (steps per tile: OBS_GRID for agents, VIEW_GRID for clients and observers) and
 * never on a cell edge, so rotated twins are presented as exact rotations and floor to rotated cells
 * (util/math gridPosition). Positions inside the map stay inside it.
 */
const pos = (sim: Sim, v: number, g: number): number => gridPosition(Math.min(sim.size, Math.max(0, v)), g, sim.size);

/** Contract form of a sim event/effect: a copy (same key order) naming armies, positions on grid `g`. */
function named<T extends SimEvent | SimFx>(sim: Sim, r: T, g: number): Omit<T, 'side' | 'killer'> & { side?: Side; killer?: ArmyId } {
  const killer = (r as SimEvent).killer;
  const out = { ...r } as Omit<T, 'side' | 'killer'> & { side?: Side; killer?: ArmyId };
  if (r.side !== undefined) out.side = sim.sideId(r.side);
  if (killer !== undefined) out.killer = sim.sideId(killer) as ArmyId;
  const at = out as { x: number; y: number; tx?: number; ty?: number; fall?: { x: number; y: number } };
  at.x = pos(sim, at.x, g);
  at.y = pos(sim, at.y, g);
  if (at.tx !== undefined) at.tx = pos(sim, at.tx, g);
  if (at.ty !== undefined) at.ty = pos(sim, at.ty, g);
  if (at.fall) at.fall = { ...at.fall, x: pos(sim, at.fall.x, g), y: pos(sim, at.fall.y, g) };
  return out;
}

/**
 * Sim id `id` as `viewer` names it: its alias (sim/aliases.ts), undefined while it has none (it never saw the entity,
 * so the field naming it is left out); the observer (−1) uses sim ids.
 */
function idFor(sim: Sim, viewer: Army, id: number): string | undefined {
  if (viewer < 0) return `e_${id}`;
  const alias = sim.aliasOf(viewer, id);
  return alias === 0 ? undefined : `e_${alias}`;
}

/** Contract form of a sim effect for `viewer` (−1: the observer): `named`, with `src` and `fall` named as it names them (left out while unnamed). */
function namedFx(sim: Sim, f: SimFx, viewer: Army, g: number): Fx {
  const out = named(sim, f, g) as unknown as Fx;
  if (f.src !== undefined) {
    const src = idFor(sim, viewer, f.src);
    if (src) out.src = src;
    else delete out.src;
  }
  if (f.fall) {
    const fall = idFor(sim, viewer, f.fall.id);
    if (fall) out.fall!.id = fall;
    else delete out.fall;
  }
  return out;
}

/**
 * An entity as `viewer` sees it (contract id, or 'observer' for the omniscient observer), positions on grid `g`. Throws
 * for an entity the army has no name for (never saw it).
 */
export function entityOut(sim: Sim, e: Ent, viewer: ArmyId | 'observer', g = viewer === 'observer' ? VIEW_GRID : OBS_GRID): Entity {
  const v = viewer === 'observer' ? -1 : armyOf(sim, viewer);
  const id = idFor(sim, v, e.id);
  if (id === undefined) throw new Error(`army ${String(viewer)} has no name for entity ${e.id}`);
  return entityFor(sim, e, v, g, id);
}

/** `viewer` −1 is the observer: no army (it owns nothing; every fog test below is skipped for it). `id`: its name for `e`. */
function entityFor(sim: Sim, e: Ent, viewer: Army, g: number, id: string): Entity {
  const out: Entity = {
    id,
    kind: e.kind,
    side: sim.sideId(e.side),
    plane: e.plane,
    x: pos(sim, e.x, g),
    y: pos(sim, e.y, g),
    hp: Math.max(0, Math.min(HP_CAP, Math.ceil(e.hp))),
    maxHp: Math.max(1, Math.min(HP_CAP, e.maxHp)),
    state: e.state,
  };
  if (e.plane === 'orbit' && e.maxShield > 0) {
    out.shield = round2(Math.max(0, e.shield));
    out.maxShield = e.maxShield;
  }
  if (e.kind === 'asteroid') {
    out.rockSize = e.rockSize;
    if (viewer < 0 || sim.seesCell(viewer, e.plane, cellOfEnt(e, sim.size))) {
      out.resourceType = e.resourceType;
      out.volatile = e.volatile;
      out.resourceRemaining = round2(Math.max(0, e.resourceRemaining));
      if (e.fuseUntil > 0 && e.state === 'towed') out.fuseUntil = e.fuseUntil;
    }
  }
  if (e.kind === 'core' && (viewer < 0 || sim.sees(viewer, e))) {
    out.vents = e.vents;
    out.heat = round2(Math.min(100, Math.max(0, e.heat)));
    out.heatRate = round2(e.heatRate);
  }
  if (e.kind === 'solar') {
    // The ramp shows to anyone who sees the array (its glow); the energy it makes only to its owner.
    out.ramp = round2(e.ramp);
    if (viewer < 0 || e.side === viewer) out.output = round2(e.output);
  }
  const own = e.side === viewer;
  if (e.kind === 'tug') {
    out.cargoAlloy = round2(Math.max(0, e.cargoAlloy));
    out.cargoEnergy = round2(Math.max(0, e.cargoEnergy));
    if ((viewer < 0 || own) && e.order.k === 'mine_asteroid') out.miningAssigned = true;
    const target = e.miningTarget ? sim.alive(e.miningTarget) : undefined;
    const targetId = target && (viewer < 0 || (own && sim.seesCell(viewer, target.plane, cellOfEnt(target, sim.size)))) ? idFor(sim, viewer, target.id) : undefined;
    if (targetId) out.miningTarget = targetId;
  }
  if (!isNeutralKind(e.kind)) {
    const mount = sim.stats[e.kind].mount;
    // Orbit heading follows turn-limited inertia, or turns onto a fixed/forward mount's target, as a travelling depths unit's turns; mounts still expose independently aimed bearings elsewhere.
    // A depths worker stops one step short of a path ending in its work cell (ore, Mother Lode, wall, hole): working
    // there it is not travelling, so its own client turns it toward `work` instead of its last step's bearing.
    const travelling = e.plane === 'depths' && e.unit && e.path !== null && e.pathI < e.path.length && !DEPTHS_WORK_STATES[e.state];
    if (e.plane === 'orbit' || travelling || mount?.kind === 'turret' || (mount?.kind === 'forward' && e.state === 'moving') || (mount && e.faceTarget)) {
      out.heading = round2(e.heading + e.frame * QUARTER_TURN);
    } else if (e.plane === 'depths' && e.unit && !own && DEPTHS_WORK_STATES[e.state]) {
      // Others get no private `work` point: a worker visibly faces the cell it works, only while that cell is seen.
      const cell = depthsWorkCell(sim, e);
      if (cell >= 0 && (viewer < 0 || sim.seesCell(viewer, 'depths', cell))) {
        const k = e.frame, s = sim.size, cx = cellCentreX(cell, s), cy = cellCentreY(cell, s);
        const dx = canonX(k, cx, cy, s) - canonX(k, e.x, e.y, s), dy = canonY(k, cx, cy, s) - canonY(k, e.x, e.y, s);
        if (dx !== 0 || dy !== 0) out.heading = round2(dmath.atan2(dy, dx) + k * QUARTER_TURN);
      }
    }
    if (mount?.kind === 'turret') out.aim = round2(e.aim + e.frame * QUARTER_TURN);
  }
  if (e.transitKind) {
    out.transit = { to: e.transitKind.to, at: e.transitAt, until: e.transitUntil };
    // While climbing, the return plane is already the entity's current plane; avoid repeating it in capped views.
    if (e.transitKind.return && e.transitKind.return !== e.plane) out.transit.return = e.transitKind.return;
  }
  if (own && e.transitReady > sim.tick) out.transitReady = e.transitReady;
  if (own && e.abilityReady > sim.tick) out.abilityReady = e.abilityReady;
  if (own && e.kind === 'warden' && (e.deploy === DEPLOY_NONE || e.deploy === DEPLOY_PACKING) && !sim.deployClear(e)) out.deployBlocked = true;
  if (e.lanceAt > sim.tick) out.lance = { x: pos(sim, e.lanceX, g), y: pos(sim, e.lanceY, g), at: e.lanceAt };
  if (e.aegisUntil > sim.tick && e.aegisPool > 0) out.aegis = { until: e.aegisUntil, pool: round2(e.aegisPool) };
  if (e.cloaked) out.cloaked = true;
  if (own && e.cloakReady > sim.tick) out.cloakReady = e.cloakReady;
  const hangar = (own || viewer < 0) && e.hangar ? idFor(sim, viewer, e.hangar) : undefined;
  if (hangar) out.hangar = hangar;
  if (own && e.ready > sim.tick) out.ready = e.ready;
  // From the owner's own terrain knowledge (Sim.shaftSealed), so it reveals nothing hidden.
  if ((own || viewer < 0) && e.kind === 'shaft' && e.built && sim.shaftSealed(e.side as Army, e)) out.sealed = true;
  if (e.activeUntil > sim.tick) out.activeUntil = e.activeUntil;
  if (e.plane === 'sky' && e.elevation !== 0) out.elevation = e.elevation;
  if (e.kind === 'mooring_tower' && (own || viewer < 0) && isArmy(e.side)) out.mooringPowered = sim.armies[e.side]!.powered;
  if (e.kind === 'ore_extractor' && (own || viewer < 0) && isArmy(e.side)) out.extractorPowered = sim.armies[e.side]!.powered;
  if (e.kind === 'island') {
    if (e.oreCapacity > 0) {
      out.oreCapacity = e.oreCapacity;
      if (own || viewer < 0 || sim.seesCell(viewer, 'sky', cellOf(e.x, e.y, sim.size))) out.oreRemaining = round2(e.oreRemaining);
      if (own || viewer < 0) out.oreBuffer = round2(e.oreBuffer);
    }
    if (e.mooringPhase) out.mooringState = e.mooringPhase === 1 ? 'lowering' : e.mooringPhase === 2 ? 'held' : 'raising';
    if (e.mooringReadyAt > sim.tick) out.mooringReadyAt = e.mooringReadyAt;
    const tower = sim.alive(e.mooringTower);
    const towerId = tower && (viewer < 0 || (sim.sees(viewer, tower) && sim.seesCell(viewer, 'sky', cellOf(e.x, e.y, sim.size)))) ? idFor(sim, viewer, tower.id) : undefined;
    if (towerId) out.mooringTower = towerId;
  } else if (e.kind === 'mooring_tower' && e.mooringTarget) {
    const island = sim.alive(e.mooringTarget);
    const seen = island && (viewer < 0 || sim.seesCell(viewer, 'sky', cellOf(island.x, island.y, sim.size)));
    if (own || viewer < 0) {
      out.mooringGrace = e.mooringGrace;
      const islandId = seen ? idFor(sim, viewer, e.mooringTarget) : undefined;
      if (islandId) out.mooringTarget = islandId;
      if (seen) out.mooringState = island.mooringTower === e.id ? island.mooringPhase === 1 ? 'lowering' : 'held' : 'waiting';
    } else if (seen && island.mooringTower === e.id) out.mooringState = island.mooringPhase === 1 ? 'lowering' : 'held';
  }
  // A built Drill Yard's conversion (Trooper inside, progress, line length) is the owner's: others see it working (state).
  const yardPrivate = e.kind === 'drill_yard' && e.built && !own && viewer >= 0;
  if (e.carry > 0 && (own || e.kind !== 'spire') && !yardPrivate) out.carry = Math.min(CARRY_CAP, e.carry);
  // Islands and forward posts are public (holder included), and so is what stands in an island's slot (unless a storm
  // hides it); who is contesting one is only known up close. The holder and the army whose capture it is follow its
  // progress from anywhere; that hostile alliances are fighting over it (`contested`) is known to the holder and to
  // whoever sees it.
  const zonePlane = e.kind === 'island' ? 'sky' : e.kind === 'post' ? 'surface' : undefined;
  const islandSeen = viewer < 0 || zonePlane === undefined || sim.seesCell(viewer, zonePlane, cellOf(e.x, e.y, sim.size));
  const islandHidden = !islandSeen && e.side !== viewer && e.capSide !== viewer;
  if (islandHidden || (!islandSeen && e.side !== viewer && e.state === 'contested')) out.state = e.kind === 'post' ? 'idle' : 'drifting';
  const slot = e.kind === 'island' && islandHidden ? sim.alive(e.link) : undefined;
  const link = e.link && !yardPrivate && (!islandHidden || (slot && sim.sees(viewer, slot))) ? idFor(sim, viewer, e.link) : undefined;
  if (link) out.link = link;
  if (e.progress >= 0 && !islandHidden && !yardPrivate) out.progress = Math.min(1, round2(e.progress));
  if (sim.payloads[e.kind] && e.state === 'falling') {
    out.tx = pos(sim, e.ix, g);
    out.ty = pos(sim, e.iy, g);
  } else if (own) {
    const dest = destination(sim, e.order, viewer, g);
    if (dest) {
      out.tx = dest.x;
      out.ty = dest.y;
    }
    const work = workTarget(sim, e, viewer, g);
    if (work) out.work = work;
    // Aggressive is the wire default; omitting it keeps capped observations below the ABI size limit.
    if (e.stance !== 'aggressive' && sim.armed(e) && e.kind !== 'spire' && e.kind !== 'turret') out.stance = e.stance;
    if (e.queue.length) out.queue = e.queue.length;
    const wp: { x: number; y: number }[] = [];
    if (e.order.k === 'patrol') wp.push({ x: pos(sim, e.order.ax, g), y: pos(sim, e.order.ay, g) }, { x: pos(sim, e.order.bx, g), y: pos(sim, e.order.by, g) });
    for (const q of e.queue) {
      const d = destination(sim, q, viewer, g);
      if (d) wp.push(d);
    }
    if (wp.length) out.wp = wp.slice(0, WAYPOINT_CAP);
  }
  return out;
}

/** The Depths cell a unit currently works in place (wall, ore, fortified/bridged/bulkhead/undermined cell), or -1. */
function depthsWorkCell(sim: Sim, e: Ent): number {
  const order = e.order;
  let cell = -1;
  switch (e.state) {
    case 'digging':
      // digAt is reset after simultaneous digging; the current path step retains the worked wall.
      cell = e.path?.[e.pathI] ?? e.designation;
      break;
    case 'mining':
    // A digger waiting beside a Mother Lode cell another army mines.
    case 'contested':
      if (order.k === 'mine') cell = order.ore;
      break;
    case 'fortifying':
      if (order.k === 'fortify') cell = order.c;
      break;
    case 'laying':
      if (order.k === 'rail') cell = cellOfEnt(e, sim.size);
      break;
    case 'bridging':
      if (order.k === 'bridge') cell = order.c;
      break;
    case 'constructing':
      if (order.k === 'bulkhead') cell = order.c;
      break;
    case 'undermining':
      if (order.k === 'undermine') cell = order.c;
      break;
  }
  return cell >= 0 && cell < sim.n ? cell : -1;
}

/** Current task point, never an enemy's hidden destination or an unseen attack target. */
function workTarget(sim: Sim, e: Ent, team: Army, g: number): { x: number; y: number } | undefined {
  const order = e.order;
  const cell = depthsWorkCell(sim, e);
  if (cell >= 0) return { x: cellCentreX(cell, sim.size), y: cellCentreY(cell, sim.size) };
  let target = 0;
  switch (e.state) {
    case 'mining':
    case 'contested':
      if (order.k === 'mine_asteroid') target = order.asteroid;
      break;
    case 'grappling':
      if (order.k === 'grapple' || order.k === 'mine_asteroid') target = order.asteroid;
      break;
    case 'towing':
      target = e.link;
      break;
    case 'capturing':
      if (order.k === 'capture') target = order.island;
      break;
    case 'attacking':
      target = e.engage || (order.k === 'attack' ? order.target : 0);
      break;
  }
  const entity = target ? sim.alive(target) : undefined;
  if (entity && order.k === 'mine_asteroid' && !sim.seesCell(team, entity.plane, cellOfEnt(entity, sim.size))) return undefined;
  return entity && sim.sees(team, entity) ? { x: pos(sim, entity.x, g), y: pos(sim, entity.y, g) } : undefined;
}

/** Where an own order is heading (for tx/ty and waypoint lines). Attack targets only while visible. */
function destination(sim: Sim, o: Order, team: Army, g: number): { x: number; y: number } | undefined {
  switch (o.k) {
    case 'move':
      return { x: pos(sim, o.x, g), y: pos(sim, o.y, g) };
    case 'patrol':
      return o.toB ? { x: pos(sim, o.bx, g), y: pos(sim, o.by, g) } : { x: pos(sim, o.ax, g), y: pos(sim, o.ay, g) };
    case 'transfer': {
      // Own Shaft: always known to its owner.
      const s = sim.alive(o.shaft);
      return s ? { x: pos(sim, s.x, g), y: pos(sim, s.y, g) } : undefined;
    }
    case 'dig':
    case 'fortify':
    case 'bulkhead':
    case 'undermine':
      return { x: cellCentreX(o.c, sim.size), y: cellCentreY(o.c, sim.size) };
    case 'hangar':
    case 'attack': {
      const t = sim.alive(o.target);
      return t && sim.sees(team, t) ? { x: pos(sim, t.x, g), y: pos(sim, t.y, g) } : undefined;
    }
    case 'mine_asteroid': {
      const target = o.returning ? sim.armies[team]!.spire.orbit : sim.alive(o.asteroid);
      if (target && !target.dead && target.hp > 0 && (o.returning || sim.seesCell(team, target.plane, cellOfEnt(target, sim.size)))) {
        return { x: pos(sim, target.x, g), y: pos(sim, target.y, g) };
      }
      return !o.returning && o.asteroid !== 0 && o.site && !o.exhausted
        ? { x: pos(sim, sim.miningDestination(o, 'x'), g), y: pos(sim, sim.miningDestination(o, 'y'), g) } : undefined;
    }
    case 'convert': {
      const yard = sim.alive(o.yard);
      return yard ? { x: pos(sim, yard.x, g), y: pos(sim, yard.y, g) } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Planted charges `team` knows of (Charge.known: own and allied ones, hostile ones its group saw or felt, any in its
 * public window; null: every charge); how many sappers stack on one only its own side knows.
 */
function charges(sim: Sim, team: Army | null, cap = CHARGE_CAP): FullObservation['charges'] {
  const out: FullObservation['charges'] = [];
  const bit = team === null ? -1 : sim.armies[team]!.group.bit;
  for (const ch of sim.charges) {
    if (out.length >= cap) break;
    if ((ch.known & bit) === 0) continue;
    out.push({
      x: ch.c % sim.size, y: Math.floor(ch.c / sim.size), tick: ch.at, side: sim.sideId(ch.side),
      ...(team === null || !sim.hostile(team, ch.side) ? { stack: ch.stack } : {}),
    });
  }
  return out;
}

/** The army's intruder alert source (Sim.intruders: hostile Depths units it sees in its own tunnels near home), or null. */
function intrusion(sim: Sim, team: Army): Intrusion | null {
  const at = { x: 0, y: 0 };
  const count = sim.intruders(team, at);
  return count > 0 ? { x: at.x, y: at.y, count } : null;
}

/**
 * The Surface `charge_under` alert source: hostile charges the team knows of (`known`, its fogged `charges`), soonest
 * first, whose collapse reaches its own Surface units or structures (within collapseRadius + collapseStructureReach of
 * the charge cell centre; structures by footprint). Own entities and known charges only, so it never reveals a charge.
 */
function chargeUnder(sim: Sim, team: Army, known: FullObservation['charges']): ChargeUnder[] {
  const out: ChargeUnder[] = [];
  const own = sim.sideId(team);
  const reach = sim.econ.collapseRadius + sim.econ.collapseStructureReach;
  for (const ch of known) {
    if (ch.side === own) continue;
    const x = ch.x + 0.5;
    const y = ch.y + 0.5;
    let count = 0;
    for (const e of sim.ents) {
      if (e.dead || e.hp <= 0 || e.side !== team || e.plane !== 'surface' || (!e.unit && !e.structure)) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      if (e.structure ? footprintDistance(e.kind, e.x, e.y, x, y) <= reach : dx * dx + dy * dy <= reach * reach) count++;
    }
    if (count > 0) out.push({ x, y, tick: ch.tick, count });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

/** Flares `team` knows of: own and allied ones, and any whose landing cell its group sees now (null: every flare). */
function flares(sim: Sim, team: Army | null): FullObservation['flares'] {
  const out: FullObservation['flares'] = [];
  const bit = team === null ? 0 : sim.armies[team]!.group.bit;
  const dv = sim.vis[PLANE_INDEX.depths]!;
  for (const f of sim.flares) {
    if (f.until < sim.tick || out.length >= FLARE_CAP) continue;
    if (team !== null && sim.hostile(team, f.side) && (dv[f.c]! & bit) === 0) continue;
    out.push({ x: f.c % sim.size, y: Math.floor(f.c / sim.size), until: f.until, side: sim.sideId(f.side) });
  }
  return out;
}

/**
 * Enemy depths units right under the team's surface presence (cell precision only), and enemy troopers digging a
 * breach where the team has surface presence or vision (`breach: true`). Cells in the team's own frame order: the
 * sim's creation order (and which of two units in a cell came first) would date unseen enemy production.
 */
function tremors(sim: Sim, team: Army): FullObservation['tremors'] {
  const bit = sim.armies[team]!.group.bit;
  const surface = sim.vis[PLANE_INDEX.surface]!;
  const breaching = new Map<number, boolean>();
  for (const e of sim.ents) {
    if (e.dead || e.plane !== 'depths' || !sim.hostile(team, e.side) || sim.isStructure(e)) continue;
    const c = cellOfEnt(e, sim.size);
    const felt = (sim.feel[c]! & bit) !== 0;
    const breach = e.state === 'breaching' && (felt || (surface[c]! & bit) !== 0);
    if (felt || breach) breaching.set(c, breach || breaching.get(c) === true);
  }
  const frame = sim.armyFrame[team]!;
  const cells = [...breaching.keys()].sort((a, b) => canonCell(frame, a, sim.size) - canonCell(frame, b, sim.size));
  if (cells.length > TREMOR_CAP) cells.length = TREMOR_CAP;
  return cells.map((c) => (breaching.get(c) ? { x: c % sim.size, y: Math.floor(c / sim.size), breach: true } : { x: c % sim.size, y: Math.floor(c / sim.size) }));
}

function rally(sim: Sim, team: Army, g: number): Observation['rally'] {
  const out: Observation['rally'] = [];
  for (const plane of PLANES) {
    const r = sim.armies[team]!.rally[plane];
    if (r) out.push({ plane, x: pos(sim, r.x, g), y: pos(sim, r.y, g) });
  }
  return out;
}

/** Raw cell sight (structures use it even in forests), shared by client and agent presentations. */
function visionPlane(sim: Sim, team: Army, plane: Plane): number[] {
  const bit = sim.armies[team]!.group.bit, v = sim.vis[PLANE_INDEX[plane]]!;
  const words = new Array<number>(Math.ceil(sim.n / VISION_BITS_PER_WORD)).fill(0);
  for (let c = 0; c < sim.n; c++) if (v[c]! & bit) words[(c / VISION_BITS_PER_WORD) | 0]! |= 1 << c % VISION_BITS_PER_WORD;
  return words;
}

/** Bitset per plane: bit i of word w = cell w*VISION_BITS_PER_WORD+i. */
function vision(sim: Sim, team: Army): View['vision'] {
  return { depths: visionPlane(sim, team, 'depths'), surface: visionPlane(sim, team, 'surface'), sky: visionPlane(sim, team, 'sky'), orbit: visionPlane(sim, team, 'orbit') };
}

function designations(sim: Sim, team: Army): View['designations'] {
  const words = sim.armies[team]!.designationWords;
  // Observations are caller-owned; do not expose the sim's mutable packed buffers.
  return { normal: words.normal.slice(), urgent: words.urgent.slice() };
}

/** Enemy structures last seen and not visible now, latest first (then in the team's own naming order). */
function memory(sim: Sim, team: Army, g: number): View['memory'] {
  const out: View['memory'] = [];
  for (const [id, ghost] of sim.armies[team]!.group.memory) {
    const e = sim.alive(id);
    if (e && sim.sees(team, e)) continue;
    // Seen, so named; the alias rather than the map's insertion (sim id) order settles a tie.
    const alias = sim.aliasOf(team, id);
    if (alias === 0) continue;
    out.push({ id: `e_${alias}`, kind: ghost.kind, side: sim.sideId(ghost.side), plane: ghost.plane, x: pos(sim, ghost.x, g), y: pos(sim, ghost.y, g), seen: ghost.seen, ...(ghost.elevation === undefined ? {} : { elevation: ghost.elevation }) });
  }
  out.sort((a, b) => b.seen - a.seen || Number(a.id.slice(2)) - Number(b.id.slice(2)));
  return out.slice(0, GHOST_CAP);
}

/**
 * Effects of the last few ticks the team may see: public ones, its own, and others whose position it sees now
 * (forest concealment included). A shot from an unseen shooter at something the team sees is shown as an incoming
 * hit at the target only.
 */
function fx(sim: Sim, team: Army, g: number): Fx[] {
  const bit = sim.armies[team]!.group.bit;
  const out: Fx[] = [];
  for (const r of sim.fx) {
    const f = r.fx;
    const targetVisible = f.tp !== undefined && f.tx !== undefined && f.ty !== undefined
      && (r.tside === team || r.tpub || sim.seesCell(team, f.tp, cellOf(f.tx, f.ty, sim.size)));
    const sourceVisible = r.viewers !== undefined ? !!(r.viewers & bit)
      : r.pub || r.owner === team || sim.seesCell(team, f.plane, cellOf(f.x, f.y, sim.size));
    if (sourceVisible) {
      const shown = namedFx(sim, f, team, g);
      if (r.sourceViewers !== undefined && !(r.sourceViewers & bit)) delete shown.sourceElevation;
      if (!targetVisible || (r.targetViewers !== undefined && !(r.targetViewers & bit))) delete shown.targetElevation;
      out.push(shown);
      continue;
    }
    if (r.viewers !== undefined || f.kind !== 'shot' || f.tp === undefined || f.tx === undefined || f.ty === undefined) continue;
    if (targetVisible) {
      const hit: Fx = { tick: f.tick, kind: 'shot', plane: f.tp, x: pos(sim, f.tx, g), y: pos(sim, f.ty, g) };
      if (f.w) hit.w = f.w;
      if (f.arrive !== undefined) hit.arrive = f.arrive;
      if (f.subject === 'island_mortar') hit.subject = f.subject;
      if (f.targetElevation !== undefined && (r.targetViewers === undefined || (r.targetViewers & bit))) hit.sourceElevation = f.targetElevation;
      out.push(hit);
    }
  }
  return out.length > VIEW_FX_CAP ? out.slice(out.length - VIEW_FX_CAP) : out;
}

/**
 * Entities `team` can currently see, own seat plane first (so truncation never drops them), in the team's naming order
 * (its own creation and first-sight order: the sim's creation order would date unseen production). `planes`: only
 * entities on these planes (null: every plane).
 */
function visibleEntities(sim: Sim, team: Army, first: Plane | null, cap: number, g: number, planes: readonly Plane[] | null = null): Entity[] {
  const primary: Entity[] = [];
  const rest: Entity[] = [];
  const names = sim.armies[team]!.aliases;
  for (let alias = 1; alias <= names.count; alias++) {
    const e = sim.alive(names.sim[alias]!);
    if (!e || (planes !== null && !planes.includes(e.plane)) || !sim.sees(team, e)) continue;
    (first && e.plane === first ? primary : rest).push(entityFor(sim, e, team, g, `e_${alias}`));
  }
  const all = primary.concat(rest);
  return all.length > cap ? all.slice(0, cap) : all;
}

/**
 * What the plane alerts read when some planes are only summarised: the islands `team` sees (island_contested), its own
 * posts (post_contested) and its own Orbit ships (radiation). Own entities and seen islands only, so fog-safe.
 */
function alertEntities(sim: Sim, team: Army, g: number): Entity[] {
  const out: Entity[] = [];
  for (const e of sim.ents) {
    if (e.dead) continue;
    if (e.kind === 'island' ? sim.sees(team, e) : e.side === team && (e.kind === 'post' || (e.plane === 'orbit' && e.kind !== 'spire'))) {
      const id = idFor(sim, team, e.id);
      if (id) out.push(entityFor(sim, e, team, g, id));
    }
  }
  return out;
}

/**
 * Compact summaries of the planes outside `detail` (contract PLANE_SUMMARY), from the same fogged knowledge as the full
 * fields: entities `team` sees now counted by kind, its own units leaving the plane, its Shafts (Surface) and every
 * island's current position (Sky; the holder only while seen). `omitted`: events left out per plane (PLANE_INDEX).
 */
function planeSummaries(sim: Sim, team: Army, detail: readonly Plane[], omitted: readonly number[], g: number): Observation['planes'] {
  const out: Observation['planes'] = [];
  for (const plane of PLANES) {
    if (detail.includes(plane)) continue;
    // Per kind (KINDS order, so the rows never depend on entity order): own, hostile, neutral.
    const tally = new Array<number>(KINDS.length * 3).fill(0);
    const transit: Observation['planes'][number]['transit'] = [];
    const shafts: NonNullable<Observation['planes'][number]['shafts']> = [];
    for (const e of sim.ents) {
      if (e.dead || e.plane !== plane || !sim.sees(team, e)) continue;
      const own = e.side === team;
      tally[KINDS.indexOf(e.kind) * 3 + (own ? 0 : sim.hostile(team, e.side) ? 1 : 2)]!++;
      const id = own ? idFor(sim, team, e.id) : undefined;
      if (!id) continue;
      if (e.transitKind && e.transitKind.to !== plane && transit.length < SUMMARY_TRANSIT_CAP) {
        transit.push({ id, kind: e.kind, to: e.transitKind.to, at: e.transitAt });
      }
      if (e.kind === 'shaft' && shafts.length < SUMMARY_SHAFT_CAP) {
        const shaft: (typeof shafts)[number] = {
          id, x: pos(sim, e.x, g), y: pos(sim, e.y, g),
          hp: Math.max(0, Math.min(HP_CAP, Math.ceil(e.hp))), maxHp: Math.max(1, Math.min(HP_CAP, e.maxHp)), state: e.state,
        };
        if (e.built && sim.shaftSealed(team, e)) shaft.sealed = true;
        shafts.push(shaft);
      }
    }
    const counts: Observation['planes'][number]['counts'] = [];
    for (let k = 0; k < KINDS.length; k++) {
      const own = Math.min(tally[k * 3]!, SUMMARY_COUNT_CAP);
      const hostile = Math.min(tally[k * 3 + 1]!, SUMMARY_COUNT_CAP);
      const neutral = Math.min(tally[k * 3 + 2]!, SUMMARY_COUNT_CAP);
      if (own + hostile + neutral === 0) continue;
      counts.push({ kind: KINDS[k]!, ...(own ? { own } : {}), ...(hostile ? { hostile } : {}), ...(neutral ? { neutral } : {}) });
    }
    const summary: Observation['planes'][number] = { plane, counts, events: Math.min(omitted[PLANE_INDEX[plane]]!, SUMMARY_COUNT_CAP), transit };
    if (plane === 'surface') summary.shafts = shafts;
    if (plane === 'sky') {
      // Island positions are public (their paths are); who holds one only while the army sees it or holds it itself.
      // Islands are named for every army from the start (sim/aliases.ts openAliases).
      summary.islands = sim.ents.filter((e) => !e.dead && e.kind === 'island').map((e) => {
        const seen = e.side === team || sim.seesCell(team, 'sky', cellOf(e.x, e.y, sim.size));
        const id = `e_${sim.aliasOf(team, e.id)}`;
        return seen ? { id, x: pos(sim, e.x, g), y: pos(sim, e.y, g), side: sim.sideId(e.side) } : { id, x: pos(sim, e.x, g), y: pos(sim, e.y, g) };
      });
    }
    out.push(summary);
  }
  return out;
}

/**
 * The army's events with tick > since, oldest first, within the window a full observation lists (its last
 * OBS_EVENT_CAP events after `since`): every event on a plane in `detail` and the CROSS_PLANE_EVENTS of the others.
 * Scoping filters that window, never widens it back in time. `omitted[PLANE_INDEX[plane]]` counts those left out.
 */
function scopedEvents(sim: Sim, team: Army, since: number, detail: readonly Plane[], omitted: number[], g: number): GameEvent[] {
  const evs = sim.armies[team]!.events;
  const kept: SimEvent[] = [];
  for (let i = evs.length - 1, seen = 0; i >= 0 && evs[i]!.tick > since && seen < OBS_EVENT_CAP; i--, seen++) {
    const ev = evs[i]!;
    if (detail.includes(ev.plane) || CROSS_PLANE_EVENTS.includes(ev.kind)) kept.push(ev);
    else omitted[PLANE_INDEX[ev.plane]]!++;
  }
  const out: GameEvent[] = [];
  for (let i = kept.length - 1; i >= 0; i--) out.push(named(sim, kept[i]!, g));
  return out;
}

function resources(sim: Sim, team: Army): Observation['res'] {
  const t = sim.armies[team]!;
  const surface = sim.surfaceAlloyRate(team);
  const alloy = sim.alloyRate(team);
  let heldAlloy = 0, heldEnergy = 0, recoveryAlloy = 0, recoveryEnergy = 0;
  for (const e of t.queue) {
    if (e.started) continue;
    heldAlloy += e.heldAlloy;
    heldEnergy += e.heldEnergy;
    if (e.recovery) { recoveryAlloy += e.heldAlloy; recoveryEnergy += e.heldEnergy; }
  }
  const freeAlloy = sim.available(team, 'alloy'), freeEnergy = sim.available(team, 'energy');
  // Delivered energy is credited times the army's income multiplier (rules.handicap.income), like energyRate.
  const k = sim.incomeMultiplier[team]!;
  return {
    alloy: Math.max(0, t.alloy),
    energy: Math.max(0, t.energy),
    freeAlloy, freeEnergy, heldAlloy, heldEnergy, recoveryAlloy, recoveryEnergy,
    upkeepHeld: Math.max(0, t.energy - heldEnergy - freeEnergy),
    alloyRate: round2(Math.max(0, alloy)),
    energyRate: round2(t.delivered),
    solarRate: round2(t.solar),
    energyCap: round2(t.cap),
    energyBank: Math.floor(t.energyBank),
    upkeep: round2(t.upkeep),
    income: {
      depths: { alloy: round2(Math.max(0, alloy - surface)), energy: round2(t.geothermal * k), upkeep: 0 },
      surface: { alloy: round2(surface), energy: 0, upkeep: round2(t.upkeep - t.skyUpkeep) },
      sky: { alloy: 0, energy: round2(t.stormcatcher * k), upkeep: round2(t.skyUpkeep) },
      orbit: { alloy: 0, energy: round2((Math.min(t.solar, t.cap) + t.bankDischarge) * k), upkeep: 0 },
    },
    scanReadyAt: t.scanReadyAt,
    rebuilds: Math.max(0, sim.econ.rebuildsPerMatch - t.rebuilds),
  };
}

function pockets(sim: Sim, team: Army): FullObservation['pockets'] {
  const out: FullObservation['pockets'] = [];
  const known = sim.armies[team]!.group.pocketKnown;
  for (let c = 0; c < known.length; c++) if (known[c]) out.push({ x: c % sim.size, y: Math.floor(c / sim.size), id: known[c]! });
  return out;
}

/** The army's own segments; `threatened` from its own knowledge (hostile hits on its segments, their HP). */
function spire(sim: Sim, team: Army): Observation['spire'] {
  const t = sim.armies[team]!;
  return PLANES.map((plane) => {
    const s = t.spire[plane];
    const hp = Math.max(0, Math.ceil(s.hp));
    const threatened = hp > 0 && (sim.tick - t.spireHitAt[plane] < sim.econ.threatWindowTicks || s.hp < s.maxHp * sim.econ.threatHp);
    return { plane, hp, maxHp: s.maxHp, ...(threatened ? { threatened } : {}) };
  });
}

/**
 * Public crowns (lossRule crowns only): every army's crowns lost and segments down, live while it plays and as it
 * fell once eliminated (its remains are removed then).
 */
function crowns(sim: Sim): { crowns?: NonNullable<Observation['crowns']> } {
  if (sim.rules.spire.lossRule !== 'crowns') return {};
  return {
    crowns: sim.allArmies.map((a) => {
      const fallen = PLANES.filter((plane) => (sim.inPlay(a) ? !sim.segmentAlive(a, plane) : (sim.eliminatedFallen[a]! >> PLANE_INDEX[plane]) & 1));
      let lost = 0;
      for (const plane of fallen) lost += sim.crownValue(plane);
      return { army: sim.armyIds[a]!, lost, fallen };
    }),
  };
}

/** Public backing is authoritative; only paid, progressing work has a production ETA. Entities named as `viewer` names them. */
function queue(sim: Sim, team: Army, g: number, viewer: Army = team): Observation['queue'] {
  const t = sim.armies[team]!;
  return t.queue.slice(0, QUEUE_LIST).map((e) => {
    const s = sim.queueStats(e.item, e.producer);
    const out: QueueEntryOut = {
      id: `q_${e.id}`,
      item: e.item,
      plane: e.plane,
      by: e.by,
      byCtl: e.byCtl,
      alloy: s.alloy,
      energy: s.energy,
      heldAlloy: e.heldAlloy,
      heldEnergy: e.heldEnergy,
      recovery: e.recovery,
      paid: e.started,
      next: e.funding && !e.recovery && !e.started,
      status: e.status,
      progress: 0,
    };
    if (e.source === 'policy' || e.source === 'bot' || e.source === 'fallback') out.automatic = true;
    if (e.reason) out.reason = e.reason;
    const producer = e.producer ? idFor(sim, viewer, e.producer) : undefined;
    if (producer) out.producer = producer;
    if (isIslandBuild(e.item)) {
      const island = idFor(sim, viewer, e.island);
      if (island) out.island = island;
    } else if (!isUnitKind(e.item) && !isUpgrade(e.item) && e.item !== 'rebuild') {
      out.x = pos(sim, e.x, g);
      out.y = pos(sim, e.y, g);
    }
    const digger = (e.item === 'bulkhead' || e.item === 'geothermal') && e.digger ? idFor(sim, viewer, e.digger) : undefined;
    if (digger) out.digger = digger;
    let eta = Infinity;
    if ((e.item === 'bulkhead' || e.item === 'geothermal') && e.started) {
      // Its digger walks there first (no estimate), then works the gate.
      const d = sim.alive(e.digger);
      const work = d && d.order.k === 'bulkhead' && d.order.working ? d.workT : -1;
      if (work >= 0) {
        out.progress = Math.min(1, Math.max(0, round2(work / s.build)));
        eta = s.build - work;
      }
    } else if (e.started) {
      const site = isUnitKind(e.item) || isUpgrade(e.item) || e.item === 'rebuild' ? undefined : sim.alive(e.site);
      const p = site ? Math.max(0, site.progress) : 1 - e.left / s.build;
      out.progress = Math.min(1, Math.max(0, round2(p)));
      const siteId = site ? idFor(sim, viewer, site.id) : undefined;
      if (siteId) out.site = siteId;
      eta = site ? Math.ceil((1 - Math.max(0, site.progress)) * s.build) : e.left;
    }
    if (e.status !== 'blocked' && Number.isFinite(eta)) out.eta = Math.min(1e7, Math.ceil(eta));
    return out;
  });
}

function holes(sim: Sim): FullObservation['holes'] {
  const out: FullObservation['holes'] = [];
  for (let c = 0; c < sim.n; c++) {
    const h = sim.holes[c]!;
    if (h) out.push({ x: c % sim.size, y: Math.floor(c / sim.size), kind: HOLE_KINDS[h - 1]! });
  }
  return out;
}

/** Falling payloads (public: every army has named them, sim/aliases.ts), named as `viewer` (−1: the observer) names them. */
function impacts(sim: Sim, viewer: Army, g: number, cap = IMPACT_CAP): Observation['impacts'] {
  const out: Observation['impacts'] = [];
  for (const a of sim.ents) {
    if (!sim.payloads[a.kind] || a.state !== 'falling' || a.dead) continue;
    const id = idFor(sim, viewer, a.id);
    if (!id) continue;
    const fall = sim.payloadFall(a);
    out.push({ ...fall, id, x: pos(sim, fall.x, g), y: pos(sim, fall.y, g), side: sim.sideId(a.side) });
  }
  return out.length > cap ? out.slice(0, cap) : out;
}

function sun(sim: Sim): Observation['sun'] {
  return { angle: sim.sunAngle };
}

/**
 * Snapshot public geometry, never source identities or mutable simulation storage. Weather positions stay exact (not
 * on the position grid): they follow published paths agents evaluate bit for bit, and the sim keeps rotated banks
 * and storms exact rotations of each other.
 */
function weather(sim: Sim): FullObservation['weather'] {
  const data = sim.weather.data;
  return {
    // publicStorm drops the sim-internal rotation (same keys, same order as the contract storm).
    storms: data.storms.map(publicStorm),
    forecast: data.forecast.map(publicStorm),
    fog: data.fog.map((c) => ({ x: c.x, y: c.y, radius: c.radius })),
    seeded: data.seeded.map((c) => ({ ...c })),
    seedWarnings: data.seedWarnings.map((c) => ({ ...c })),
  };
}

/** Exact island paths are public; an occupied hardpoint is disclosed only with sight of its structure. */
function islands(sim: Sim, viewer: Army | null): FullObservation['islands'] {
  const out: FullObservation['islands'] = [];
  for (const e of sim.ents) {
    if (e.kind !== 'island') continue;
    // Islands are named for every army from the start (sim/aliases.ts openAliases).
    const path: FullObservation['islands'][number] = { id: idFor(sim, viewer ?? -1, e.id)!, cx: sim.size / 2, cy: sim.size / 2, r: e.orbitR, phase: e.orbitA0 - e.orbitW * e.orbitDelay, speed: e.orbitW * TICK_RATE };
    if (e.oreCapacity > 0) path.oreCapacity = e.oreCapacity;
    if (e.mooringPhase) path.pausedAt = sim.tick;
    const mount = e.hardpoint ? sim.alive(e.hardpoint) : undefined;
    if (mount && isHardpointKind(mount.kind) && (viewer === null || sim.sees(viewer, mount))) path.hardpoint = { kind: mount.kind, side: sim.sideId(mount.side) };
    out.push(path);
  }
  return out;
}

/**
 * Public timed events: the next asteroid spawn, unless the rules leave no room (asteroids spawn in orbits of one rock
 * per map slot, so a spawn can only ever be scheduled when the cap admits a whole orbit); the derelict's next two open
 * windows and a pending core regrowth; sudden death during its countdown.
 */
function publicSchedule(sim: Sim): Observation['schedule'] {
  const out: Observation['schedule'] = sim.econ.maxAsteroids >= sim.sides ? [{ kind: 'asteroid_spawn', tick: sim.nextAsteroidSpawn() }] : [];
  const doom = sim.econ.suddenDeathTicks;
  if (doom > 0 && sim.tick < doom && sim.tick >= doom - sim.econ.suddenDeathWarningTicks) out.push({ kind: 'sudden_death', tick: doom });
  const g = sim.derelict;
  if (g) {
    for (let k = 0; k < 2; k++) {
      const at = openWindow(g, sim.tick, k);
      out.push({ kind: 'derelict_open', tick: at, until: at + g.open, x: g.x, y: g.y });
    }
    if (sim.coreRegrowAt >= 0) out.push({ kind: 'core_regrows', tick: sim.coreRegrowAt, x: g.x, y: g.y });
  }
  return out;
}

/** The derelict core's public lift while it is out of the ruin, as an optional `coreLifted` field. */
function coreLifted(sim: Sim, g: number): { coreLifted?: NonNullable<Observation['coreLifted']> } {
  const l = sim.coreLift;
  return l.at < 0 ? {} : { coreLifted: { tick: l.at, x: pos(sim, l.x, g), y: pos(sim, l.y, g), side: sim.sideId(l.side) } };
}

/**
 * The Mother Lode's public pressure as an optional `motherLode` field (none without a lode or with pressure off). x/y:
 * the lode cell `team` knows nearest its Spire (squared distance, exact on half tiles; ties by its own frame's
 * row-major order), so the point never reveals a cell the team does not know; `null` (observers) knows them all.
 */
function motherLode(sim: Sim, team: Army | null): { motherLode?: NonNullable<Observation['motherLode']> } {
  if (!sim.lodePressureOn()) return {};
  const p = sim.lodePressure;
  const e = sim.econ;
  const cooling = sim.lodeCooling();
  const out: NonNullable<Observation['motherLode']> = {
    pressure: Math.min(LODE_PRESSURE_MAX, round2(p)),
    rate: Math.max(-1000, Math.min(100_000, round2(sim.lodePressureRate()))),
    state: cooling ? 'cooling' : sim.lodeVentAt > 0 ? 'critical' : p >= e.lodeWarn ? 'warn' : 'calm',
  };
  if (sim.lodeVentAt > 0) out.ventAt = sim.lodeVentAt;
  if (cooling) out.until = sim.lodeCoolUntil;
  const known = team === null ? null : sim.armies[team]!.group.known;
  const home = team === null ? undefined : sim.spireAt[team]!;
  const frame = team === null ? 0 : sim.armyFrame[team]!;
  let at = -1;
  let atD = 0;
  for (const c of sim.motherCells) {
    if (known && known[c] !== CELL.lode) continue;
    const d = home ? sq(cellCentreX(c, sim.size) - home.x) + sq(cellCentreY(c, sim.size) - home.y) : 0;
    if (at < 0 || d < atD || (d === atD && canonCell(frame, c, sim.size) < canonCell(frame, at, sim.size))) {
      at = c;
      atD = d;
    }
  }
  if (at >= 0) {
    out.x = cellCentreX(at, sim.size);
    out.y = cellCentreY(at, sim.size);
  }
  return { motherLode: out };
}

/** The Mother Lode's public vent while its fuse burns (schedule `lode_vent`; x/y as `motherLode`, when known). */
function lodeVent(lode: Observation['motherLode']): Observation['schedule'] {
  if (lode?.ventAt === undefined) return [];
  return [{ kind: 'lode_vent', tick: lode.ventAt, ...(lode.x === undefined || lode.y === undefined ? {} : { x: lode.x, y: lode.y }) }];
}

/** Upcoming timed world events the team may know about, soonest first. */
function schedule(sim: Sim, team: Army): Observation['schedule'] {
  const out = publicSchedule(sim);
  out.push(...lodeVent(motherLode(sim, team).motherLode));
  for (const f of sim.floods) {
    const c = f.knownAt[sim.armies[team]!.group.id]!;
    if (c >= 0) out.push({ kind: 'magma_cools', tick: f.coolAt, x: cellCentreX(c, sim.size), y: cellCentreY(c, sim.size) });
  }
  // Charges the team knows of (own, allied, seen, felt or public), at their cell centres.
  const bit = sim.armies[team]!.group.bit;
  for (const ch of sim.charges) if ((ch.known & bit) !== 0) out.push({ kind: 'collapse', tick: ch.at, x: cellCentreX(ch.c, sim.size), y: cellCentreY(ch.c, sim.size) });
  return out.sort((a, b) => a.tick - b.tick).slice(0, SCHEDULE_CAP);
}

function faults(sim: Sim): MatchData['faults'] {
  return sim.faults.map((f) => ({ cells: f.map((c) => ({ x: c % sim.size, y: Math.floor(c / sim.size) })) }));
}

/** Only discovered outcrops, with the seal state last seen by this team. */
function lodes(sim: Sim, team: Army): FullObservation['lodes'] {
  const bit = sim.armies[team]!.group.bit;
  return sim.lodes.filter((l) => (l.known & bit) !== 0).map((l) => ({ x: l.c % sim.size, y: Math.floor(l.c / sim.size), rich: l.rich, loads: l.loads, open: (l.seenOpen & bit) !== 0 }));
}

/** The army's crack knowledge (its group's cracks, wall digs from its group's wallDig), in cell order. */
function cracks(sim: Sim, team: Army): FullObservation['cracks'] {
  const t = sim.armies[team]!.group;
  const out: FullObservation['cracks'] = [];
  for (let c = 0; c < sim.n && out.length < CRACK_CAP; c++) {
    const stage = t.cracks[c]!;
    if (stage) out.push(t.wallDig[c] ? { x: c % sim.size, y: Math.floor(c / sim.size), stage, enemy: true } : { x: c % sim.size, y: Math.floor(c / sim.size), stage });
  }
  return out;
}

/** The army's events with tick > since, oldest first, at most `cap` (the most recent ones). */
export function eventsSince(sim: Sim, army: ArmyId, since: number, cap = Infinity): GameEvent[] {
  return armyEventsSince(sim, armyOf(sim, army), since, cap, OBS_GRID);
}

function armyEventsSince(sim: Sim, team: Army, since: number, cap: number, g: number): GameEvent[] {
  const evs = sim.armies[team]!.events;
  let i = Math.max(0, evs.length - cap);
  let j = evs.length;
  while (j > 0 && evs[j - 1]!.tick > since) j--;
  i = Math.max(i, j);
  const out: GameEvent[] = [];
  for (; i < evs.length; i++) out.push(named(sim, evs[i]!, g));
  return out;
}

export function outcomeOf(sim: Sim, army: ArmyId): Outcome {
  return armyOutcome(sim, armyOf(sim, army));
}

/** Final placement of `army` once its outcome is final, else null (Sim.placeOf). */
export function rankOf(sim: Sim, army: ArmyId): number | null {
  return sim.placeOf(armyOf(sim, army));
}

/** An army out of play with no ally left in play has already lost (final); otherwise running until the end. */
function armyOutcome(sim: Sim, team: Army): Outcome {
  return sim.result ? sim.result.outcome[team]! : sim.placeOf(team) === null ? 'running' : 'loss';
}

/** The army's placement once final (absent before). */
function placement(sim: Sim, a: Army): { rank?: number } {
  const rank = sim.placeOf(a);
  return rank === null ? {} : { rank };
}

/** Public elimination state, and the army's placement once final. */
function status(sim: Sim, a: Army): { eliminated: ArmyId[]; rank?: number; crowns?: NonNullable<Observation['crowns']> } {
  const eliminated: ArmyId[] = [];
  for (const b of sim.allArmies) if (!sim.inPlay(b)) eliminated.push(sim.armyIds[b]!);
  return { eliminated, ...placement(sim, a), ...crowns(sim) };
}

function research(sim: Sim, team: Army): Observation['research'] {
  const t = sim.armies[team]!;
  return {
    available: sim.researchAvailable(team),
    inProgress: t.queue.map((entry) => entry.item).filter(isUpgrade),
    completed: [...t.research],
    // Per hostile army, what this army's group has seen of its research.
    seen: sim.allArmies.filter((b) => sim.hostile(team, b) && t.group.seenResearch[b]!.size > 0)
      .map((b) => ({ army: sim.armyIds[b]!, upgrades: [...t.group.seenResearch[b]!] })),
  };
}

/** Ore caches `team` sees, in its naming order (sim/aliases.ts: creation order would date unseen extractor drops). */
function oreCaches(sim: Sim, team: Army, g: number): FullObservation['oreCaches'] {
  const out: FullObservation['oreCaches'] = [];
  for (const cache of sim.oreCaches) {
    const sight = sim.cacheSight(team, cache);
    const id = sight === 0 ? 0 : sim.aliasOf(team, cache.id);
    if (id === 0) continue;
    const surface = (sight & CACHE_SURFACE) !== 0;
    const entry: FullObservation['oreCaches'][number] = {
      id, x: pos(sim, surface ? cache.x : cache.belowX, g), y: pos(sim, surface ? cache.y : cache.belowY, g),
      alloy: surface ? cache.alloy : 0, radius: sim.econ.oreCacheRadius,
    };
    if (sight & CACHE_DEPTHS) entry.below = { x: pos(sim, cache.belowX, g), y: pos(sim, cache.belowY, g), alloy: cache.belowAlloy };
    out.push(entry);
  }
  out.sort((a, b) => a.id - b.id);
  return out.slice(0, ORE_CACHE_CAP);
}

function scorches(sim: Sim, team: Army, g: number): FullObservation['scorches'] {
  return sim.scorches.filter((scorch) => sim.seesCell(team, 'surface', cellOf(scorch.x, scorch.y, sim.size)))
    .slice(0, SCORCH_CAP).map(({ x, y, radius, until }) => ({ x: pos(sim, x, g), y: pos(sim, y, g), radius, until }));
}

/**
 * Public static match data, copied at the boundary so consumers cannot mutate the simulation. Posts named as `viewer`
 * names them (−1: the observer; every army names them alike, sim/aliases.ts openAliases).
 */
export function matchData(sim: Sim, viewer: Army): MatchData {
  return {
    rules: structuredClone(sim.rules),
    rulesHash: sim.rulesHash,
    upgrades: Object.values(UPGRADES).map((upgrade) => {
      const cost = resolveUpgrade(sim.rules, upgrade.id);
      return { id: upgrade.id, at: upgrade.at, alloy: cost.alloy, energy: cost.energy, units: upgradeBeneficiaries(upgrade.id) };
    }),
    mapId: sim.mapDocument.id,
    mapSeed: sim.mapDocument.seed,
    mapHash: sim.mapHash,
    preset: sim.preset,
    terrain: sim.terrainWords.slice(),
    faults: faults(sim),
    armies: sim.allArmies.map((a) => ({
      id: sim.armyIds[a]!, slot: sim.armySlot[a]!, frame: sim.armyFrame[a]!, colour: sim.armyColour[a]!, spireAt: { ...sim.spireAt[a]! },
    })),
    // Spawn order: home posts in army order, then the contested points.
    posts: sim.posts.map((p, i) => {
      const home = sim.postHome[i]!;
      const id = idFor(sim, viewer, p.id)!;
      return home < 0 ? { id, x: p.x, y: p.y, kind: 'contested' as const } : { id, x: p.x, y: p.y, kind: 'home' as const, home: sim.armyIds[home]! };
    }),
    symmetry: sim.mapDocument.symmetry,
    buildRadius: buildRadiusData(sim.econ),
    sun: { speed: sim.sunSpeed, half: sunHalfWidth(sim.sunWedges), wedges: sim.sunWedges },
    orbitRegions: sim.orbitRegions.map(region => ({ ...region })),
    jets: sim.weather.data.jets.map((lane) => ({ ...lane })),
    ...(sim.derelict ? { derelict: { ...sim.derelict } } : {}),
    fogPaths: sim.weather.data.fog.map((cell) => ({ ...cell.path })),
  };
}

/**
 * A seat's observation (contract observationSchema, minus the host's `signals`): planes in `detail` (manifest order)
 * in full, the others as summaries. Built-in bots and other game code pass every plane.
 */
export function observe(sim: Sim, army: ArmyId, role: Plane, since: number, detail: readonly Plane[]): GameObservation {
  return observeArmy(sim, armyOf(sim, army), role, since, detail);
}

function observeArmy(sim: Sim, a: Army, role: Plane, since: number, detail: readonly Plane[]): GameObservation {
  const t = sim.armies[a]!;
  const mandate = t.seats[role].mandate;
  const shows = (field: keyof typeof OBS_FIELD_PLANES): boolean => OBS_FIELD_PLANES[field].some((p) => detail.includes(p));
  // Alerts read the army's knowledge on every plane, summarised ones included, so their sources are built in full.
  const entities = visibleEntities(sim, a, role, OBS_ENTITY_CAP, OBS_GRID, detail);
  const weatherNow = weather(sim);
  const chargesNow = charges(sim, a);
  const cracksNow = cracks(sim, a);
  const tremorsNow = tremors(sim, a);
  const omitted = [0, 0, 0, 0];
  const events = scopedEvents(sim, a, since, detail, omitted, OBS_GRID);
  const obs: GameObservation = {
    tick: sim.tick,
    role,
    army: sim.armyIds[a]!,
    ...status(sim, a),
    outcome: armyOutcome(sim, a),
    mandate: { ...mandate, directive: { ...mandate.directive }, ...(mandate.limits === undefined ? {} : { limits: { ...mandate.limits } }) },
    rulesHash: sim.rulesHash,
    detail: [...detail],
    planes: planeSummaries(sim, a, detail, omitted, OBS_GRID),
    res: resources(sim, a),
    sun: sun(sim),
    ...(shows('islands') ? { islands: islands(sim, a) } : {}),
    ...(shows('weather') ? { weather: weatherNow } : {}),
    schedule: schedule(sim, a),
    ...coreLifted(sim, OBS_GRID),
    ...motherLode(sim, a),
    spire: spire(sim, a),
    queue: queue(sim, a, OBS_GRID),
    research: research(sim, a),
    entities,
    ...(shows('holes') ? { holes: holes(sim) } : {}),
    impacts: impacts(sim, a, OBS_GRID),
    ...(shows('oreCaches') ? { oreCaches: oreCaches(sim, a, OBS_GRID) } : {}),
    ...(shows('scorches') ? { scorches: scorches(sim, a, OBS_GRID) } : {}),
    ...(shows('surfaceVision') ? { surfaceVision: visionPlane(sim, a, 'surface') } : {}),
    events,
    ...(shows('charges') ? { charges: chargesNow } : {}),
    ...(shows('flares') ? { flares: flares(sim, a) } : {}),
    ...(shows('lodes') ? { lodes: lodes(sim, a) } : {}),
    ...(shows('pockets') ? { pockets: pockets(sim, a) } : {}),
    ...(shows('cracks') ? { cracks: cracksNow } : {}),
    ...(shows('tremors') ? { tremors: tremorsNow } : {}),
    alerts: [],
    rally: rally(sim, a, OBS_GRID),
    ...(shows('designations') ? { designations: designations(sim, a) } : {}),
  };
  obs.alerts = planeAlerts({
    army: obs.army, spire: obs.spire, schedule: obs.schedule, weather: weatherNow, impacts: obs.impacts, charges: chargesNow, cracks: cracksNow,
    tremors: tremorsNow, entities: PLANES.every((plane) => detail.includes(plane)) ? entities : alertEntities(sim, a, OBS_GRID),
    ...(obs.coreLifted ? { coreLifted: obs.coreLifted } : {}), ...(obs.motherLode ? { motherLode: obs.motherLode } : {}),
  }, sim.econ.derelictRadiation > 0 ? sim.derelict : null, intrusion(sim, a), chargeUnder(sim, a, chargesNow));
  if (shows('depths')) {
    // The grid is the depths seat's largest field and changes slowly: the whole of it on a first observation or with
    // every plane (game code, an explicit "all"), else only the cells changed since the consumer's last tick.
    if (since <= 0 || PLANES.every((plane) => detail.includes(plane))) obs.depths = Array.from(t.group.known);
    else {
      const changes: number[] = [];
      const known = t.group.known;
      const at = t.group.knownAt;
      // `>=`: a change made while stepping from `since` carries that tick; resending a value is harmless.
      for (let c = 0; c < known.length; c++) if (at[c]! >= since) changes.push(c, known[c]!);
      obs.depthsChanges = changes;
    }
  }
  return obs;
}

/** An army's view. Include the public match bootstrap in the first broadcast or a connection snapshot. */
export function view(sim: Sim, army: ArmyId, withMatch = true): GameView {
  const a = armyOf(sim, army);
  const t = sim.armies[a]!;
  const out: GameView = {
    tick: sim.tick,
    army,
    ...status(sim, a),
    outcome: armyOutcome(sim, a),
    rulesHash: sim.rulesHash,
    res: resources(sim, a),
    sun: sun(sim),
    islands: islands(sim, a),
    weather: weather(sim),
    schedule: schedule(sim, a),
    ...coreLifted(sim, VIEW_GRID),
    ...motherLode(sim, a),
    seats: PLANES.map((role) => {
      const { controller, mandate } = t.seats[role];
      return { role, controller, mandate: { ...mandate, directive: { ...mandate.directive }, ...(mandate.limits === undefined ? {} : { limits: { ...mandate.limits } }) } };
    }),
    spire: spire(sim, a),
    queue: queue(sim, a, VIEW_GRID),
    research: research(sim, a),
    entities: visibleEntities(sim, a, null, VIEW_ENTITY_CAP, VIEW_GRID),
    holes: holes(sim),
    impacts: impacts(sim, a, VIEW_GRID),
    oreCaches: oreCaches(sim, a, VIEW_GRID),
    scorches: scorches(sim, a, VIEW_GRID),
    events: armyEventsSince(sim, a, sim.tick - VIEW_EVENT_WINDOW, VIEW_EVENT_CAP, VIEW_GRID),
    depths: Array.from(t.group.known),
    fx: fx(sim, a, VIEW_GRID),
    vision: vision(sim, a),
    memory: memory(sim, a, VIEW_GRID),
    charges: charges(sim, a),
    flares: flares(sim, a),
    lodes: lodes(sim, a),
    pockets: pockets(sim, a),
    cracks: cracks(sim, a),
    tremors: tremors(sim, a),
    alerts: [],
    rally: rally(sim, a, VIEW_GRID),
    designations: designations(sim, a),
  };
  out.alerts = planeAlerts(out, sim.econ.derelictRadiation > 0 ? sim.derelict : null, intrusion(sim, a), chargeUnder(sim, a, out.charges));
  if (withMatch) out.match = matchData(sim, a);
  return out;
}

/** Current replacement cost, by current plane; production and structures remain distinct. */
export function forces(sim: Sim, a: Army): ObserverView['sides'][number]['forces'] {
  const rows = PLANES.map((plane) => ({ plane, units: 0, alloy: 0, energy: 0, structures: 0, structureAlloy: 0, structureEnergy: 0 }));
  for (const e of sim.ents) {
    if (e.dead || !e.built || e.side !== a || isNeutralKind(e.kind)) continue;
    const row = rows[PLANE_INDEX[e.plane]]!;
    if (e.unit) {
      row.units++;
      row.alloy += e.replacementAlloy;
      row.energy += e.replacementEnergy;
    } else if (e.structure) {
      row.structures++;
      row.structureAlloy += e.replacementAlloy;
      row.structureEnergy += e.replacementEnergy;
    }
  }
  return rows;
}

/** Explicit allowlist, not debugView or a union of fog. Never changes simulation visibility. */
export function observerView(sim: Sim): ObserverView {
  const visible = new Array<number>(Math.ceil(sim.n / VISION_BITS_PER_WORD)).fill((1 << VISION_BITS_PER_WORD) - 1);
  const remainder = sim.n % VISION_BITS_PER_WORD;
  if (remainder) visible[visible.length - 1] = (1 << remainder) - 1;
  // Each army's own event window and current sight: observers time-line every army and preview any army's fog
  // without a second stream. The omniscient projection already shows everything any army can know.
  const sides = sim.allArmies.map((a) => ({
    army: sim.armyIds[a]!, res: resources(sim, a), spire: spire(sim, a), queue: queue(sim, a, VIEW_GRID, -1),
    research: research(sim, a), forces: forces(sim, a), ...placement(sim, a),
    events: armyEventsSince(sim, a, sim.tick - VIEW_EVENT_WINDOW, VIEW_EVENT_CAP, VIEW_GRID), vision: vision(sim, a),
  }));
  // The world row is a View, which belongs to an army: it carries the first army's own fields (use `sides` per army).
  const first = sides[0]!;
  const terrain = {
    ore: Array.from(sim.ore), magma: Array.from(sim.magma), ownership: Array.from(sim.owner),
    cracks: Array.from(sim.cells, (_, c) => sim.crackAt(c)),
  };
  const fullPockets: FullObservation['pockets'] = [];
  const fullCracks: FullObservation['cracks'] = [];
  for (let c = 0; c < sim.n; c++) {
    if (terrain.magma[c]) fullPockets.push({ x: c % sim.size, y: Math.floor(c / sim.size), id: terrain.magma[c]! });
    if (terrain.cracks[c]) fullCracks.push({ x: c % sim.size, y: Math.floor(c / sim.size), stage: terrain.cracks[c]! });
  }
  const world: ObserverView['world'] = {
    tick: sim.tick, army: first.army, ...status(sim, 0), outcome: armyOutcome(sim, 0), rulesHash: sim.rulesHash,
    match: matchData(sim, -1), res: first.res, sun: sun(sim), islands: islands(sim, null), weather: weather(sim),
    schedule: [...publicSchedule(sim), ...lodeVent(motherLode(sim, null).motherLode)], ...coreLifted(sim, VIEW_GRID), ...motherLode(sim, null),
    seats: [], spire: first.spire, queue: first.queue, research: first.research,
    entities: sim.ents.filter((e) => !e.dead).map((e) => entityFor(sim, e, -1, VIEW_GRID, `e_${e.id}`)),
    holes: holes(sim), impacts: impacts(sim, -1, VIEW_GRID, Infinity),
    oreCaches: sim.oreCaches.map((cache) => ({
      id: cache.id, x: pos(sim, cache.x, VIEW_GRID), y: pos(sim, cache.y, VIEW_GRID), alloy: cache.placed ? cache.alloy : 0, radius: sim.econ.oreCacheRadius,
      ...(cache.belowAlloy > 0 ? { below: { x: pos(sim, cache.belowX, VIEW_GRID), y: pos(sim, cache.belowY, VIEW_GRID), alloy: cache.belowAlloy } } : {}),
    })),
    scorches: sim.scorches.map(({ x, y, radius, until }) => ({ x: pos(sim, x, VIEW_GRID), y: pos(sim, y, VIEW_GRID), radius, until })),
    // Team signals reach observers through the team perspectives (host-delayed views), not the omniscient world row.
    signals: [],
    events: [], depths: Array.from(sim.cells), fx: sim.fx.map(({ fx }) => namedFx(sim, fx, -1, VIEW_GRID)),
    vision: { depths: visible.slice(), surface: visible.slice(), sky: visible.slice(), orbit: visible.slice() },
    memory: [], charges: charges(sim, null, Infinity), flares: flares(sim, null),
    lodes: sim.lodes.map((l) => ({ x: l.c % sim.size, y: Math.floor(l.c / sim.size), rich: l.rich, loads: l.loads, open: l.open })),
    pockets: fullPockets, cracks: fullCracks, tremors: [], alerts: [], rally: [], designations: { normal: [], urgent: [] },
  };
  return {
    perspective: 'all', world, sides,
    terrain,
  };
}

function stats(s: ArmyStats): Report['armies'][number]['stats'] {
  const i = (v: number): number => Math.max(0, Math.floor(v));
  return {
    alloyMined: i(s.alloyMined),
    energyDelivered: i(s.energyDelivered),
    produced: i(s.produced),
    unitsLost: i(s.unitsLost),
    kills: i(s.kills),
    structuresLost: i(s.structuresLost),
    collapses: i(s.collapses),
    impacts: i(s.impacts),
    interceptions: i(s.interceptions),
    islandTicks: i(s.islandTicks),
    spireDamageDealt: i(s.spireDamageDealt),
    lodeAlloy: i(s.lodeAlloy),
    fortified: i(s.fortified),
    bulkheads: i(s.bulkheads),
    headframes: i(s.headframes),
    deploys: i(s.deploys),
    flares: i(s.flares),
    conversions: i(s.conversions),
    postsCaptured: i(s.postsCaptured),
    postTicks: i(s.postTicks),
    pointTicks: i(s.pointTicks),
    moorings: i(s.moorings),
    seeds: i(s.seeds),
    emplaced: i(s.emplaced),
    coreCashed: i(s.coreCashed),
  };
}

export function report(sim: Sim, army: ArmyId): Report {
  const us = armyOf(sim, army);
  const rank = sim.placeOf(us);
  return {
    outcome: armyOutcome(sim, us),
    ...(rank === null ? {} : { rank }),
    ticks: sim.tick,
    armies: sim.allArmies.map((a) => {
      const place = sim.placeOf(a);
      return {
        army: sim.armyIds[a]!, colour: sim.armyColour[a]!, ...(place === null ? {} : { rank: place }),
        stats: stats(sim.armies[a]!.stats), spire: spire(sim, a),
      };
    }),
    timeline: sim.armies[us]!.timeline.slice(-REPORT_TIMELINE_CAP).map((ev) => named(sim, ev, OBS_GRID)),
  };
}
