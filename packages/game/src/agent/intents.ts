/**
 * Intent application. Input is already schema-validated and role-checked by PlayerThree; this enforces the
 * game rules (ownership, plane, kind, visibility, cost) and answers with closed error codes. An intent is
 * applied atomically: any invalid unit rejects the whole intent.
 */
import type { IntentSource } from 'playerthree';
import { AIRCRAFT, CELL, INTENTS, MAX_MAP_SIZE, STATS, STRUCTURE_SPACING, footprintDistance, footprintOverlap, surfaceSiteLevel, TRANSITS, transitValue, UPGRADES, isUpgrade, isAircraft, isBuildableHardpoint, isHardpointKind, isIslandBuild, isLava, isNeutralKind, isOpenCell, isStructureKind, isUnitKind, type Capabilities, type GameError, type Kind, type Macro, type Plane, type UnitKind } from '../rules/contract.ts';
import { MOORING_CAPTURE_HEIGHT, PLANES, TICK_RATE } from '../rules/contract.ts';
import { searchDepths, type Barrier } from '../nav/nav.ts';
import { derelictLayer, OUTSIDE } from '../rules/derelict.ts';
import { DEPLOY_NONE, DEPLOY_PACKING, HOLE, MAX_SLOT_RINGS, SNAP_EPS } from '../sim/constants.ts';
import { adjacent4, cellCentreX, cellCentreY, cellFor, cellOf, cellOfEnt, clampPos, quantize } from '../util/grid.ts';
import { NEUTRAL, canonX, canonY, isArmy, rotVX, rotVY, rotX, rotY, type Army } from '../util/teams.ts';
import { bySeq, type Ent, type FleetMove, NONE } from '../sim/ent.ts';
import { type Sim } from '../sim/sim.ts';
import type { Infer, ObjS, Schema } from 'playerthree/schema';
import { spreadArrays } from './solar.ts';
import { dmath } from '../util/fdlibm.js';
import { norm } from '../util/math.ts';

/** One Agent Command intent (same shape as playerthree `IntentOf<manifest>`). */
export type AgentCommandIntent = {
  [K in keyof typeof INTENTS]: { kind: K } & Infer<ObjS<(typeof INTENTS)[K]['params']>>;
}[keyof typeof INTENTS];
/** The reserved team-signal intents: a signal board answers them (the PlayerThree host's, or AgentCommandGame's headless one), never the sim. */
export type SignalIntent = Extract<AgentCommandIntent, { kind: 'signal' | 'signal_update' }>;
/** Every intent the simulation applies. */
export type GameIntent = Exclude<AgentCommandIntent, SignalIntent>;

/** Team knowledge with unknown cells read as rock: what a digger may plan to dig through. */
const digView = new Uint8Array(MAX_MAP_SIZE * MAX_MAP_SIZE);
/** Bulkheads the validating team knows of (Sim.knownGate). */
const gateView = new Uint8Array(MAX_MAP_SIZE * MAX_MAP_SIZE);
/** Team knowledge of flowing magma: located solid pockets (also code magma in `known`) are never an escape route. */
const flowView = new Uint8Array(MAX_MAP_SIZE * MAX_MAP_SIZE);
const designateMask = new Uint8Array(MAX_MAP_SIZE * MAX_MAP_SIZE);

/** Planners use known structure footprints, observed hostile shields, remembered enemy gates and discovered lode pockets only. */
function knownBarrier(sim: Sim, team: Army): Barrier {
  return { gate: sim.knownGate(team, gateView), mask: sim.gateBit(team), keep: sim.knownKeep[team]!, solid: sim.depthNav[team]! };
}

/**
 * Can depths unit `e` reach cell `goal` (digging if `dig`: unknown cells count as rock) through what its team knows
 * of the depths? Validation reads team knowledge only, so a result never reveals unseen cells or bulkheads. Does not
 * touch the unit.
 */
function reachable(sim: Sim, e: Ent, goal: number, dig: boolean): boolean {
  const team = e.side, group = sim.armies[team]!.group;
  let cells = group.known;
  const start = cellOfEnt(e, sim.size);
  let flow: Uint8Array | null = null;
  if (isLava(cells[start]!) && isLava(sim.cells[start]!)) {
    for (let c = 0; c < sim.n; c++) flowView[c] = group.pocketKnown[c] ? CELL.rock : cells[c]!;
    flow = flowView;
  }
  if (dig) {
    for (let c = 0; c < cells.length; c++) digView[c] = cells[c] === CELL.unknown ? CELL.rock : cells[c]!;
    cells = digView;
  }
  return searchDepths(cells, start, (c) => c === goal, dig ? sim.costs.dig : sim.costs.walk, dig, Infinity, 0, null, knownBarrier(sim, team), sim.size, flow) !== null;
}

/** A known enemy bulkhead on cell `c` (one the team sees or remembers)? */
function knownEnemyBulkhead(sim: Sim, team: Army, c: number): boolean {
  return (sim.knownGate(team, gateView)[c]! & sim.gateBit(team)) !== 0;
}

export type ApplyResult = { ok: true } | { ok: false; code: GameError };

const OK: ApplyResult = { ok: true };
const fail = (code: GameError): ApplyResult => ({ ok: false, code });
/** Wire entity ids are `e_<n>`. */
const ENTITY_ID_PREFIX = 'e_';
const idNum = (id: string): number => Number(id.slice(ENTITY_ID_PREFIX.length));

/** Per intent kind, its entity id params (`e` ids in rules/intents.ts) and whether each is a list of them. */
const ENTITY_PARAMS: Record<string, [key: string, list: boolean][]> = {};
for (const [kind, def] of Object.entries(INTENTS)) {
  const params: [string, boolean][] = (ENTITY_PARAMS[kind] = []);
  for (const [key, param] of Object.entries(def.params as Record<string, Schema>)) {
    const node = param.t === 'opt' ? param.item as Schema : param;
    if (node.t === 'id' && node.prefix === 'e') params.push([key, false]);
    else if (node.t === 'list' && node.item.t === 'id' && node.item.prefix === 'e') params.push([key, true]);
  }
}

/**
 * `intent` as `army` issued it (entity ids are its own names, sim/aliases.ts) with sim ids in their place, as
 * applyIntent reads them. A name the army never gave becomes `e_0`, which names nothing (unknown_unit and the like,
 * exactly as a dead or hidden entity answers).
 */
export function simIntent<I extends AgentCommandIntent>(sim: Sim, army: Army, intent: I): I {
  const params = ENTITY_PARAMS[intent.kind]!;
  if (params.length === 0) return intent;
  const out: Record<string, unknown> = { ...intent };
  const target = (id: string): string => `${ENTITY_ID_PREFIX}${sim.aliasTarget(army, idNum(id))}`;
  for (const [key, list] of params) {
    const value = out[key];
    if (value !== undefined) out[key] = list ? (value as string[]).map(target) : target(value as string);
  }
  return out as I;
}

/**
 * Destinations for units ordered to one point: each unit its own slot sized by its radius (Sim.slotTargets), the
 * group's layout kept when it is compact, clear of the army's units already standing or headed there (a shared
 * destination resolves to distinct slots, whoever ordered first); a single unit goes to the point itself unless one of
 * those claims it, and then to the free slot round it on the side it comes from (it never has to cross the crowd).
 * Both on the position grid, as slotTargets snaps a group's goal: a decimal point and its mirror differ by float
 * error, which a unit steering at them turns into one-quantum velocity drift between mirrored twins.
 */
function spread(sim: Sim, team: Army, plane: Plane, us: Ent[], x: number, y: number): [number, number][] {
  if (us.length === 0) return [];
  const taken = sim.claimedDiscs(team, plane, x, y, slotReach(sim, us), us);
  if (us.length > 1) return sim.slotTargets(team, plane, us, x, y, taken);
  const e = us[0]!;
  const k = sim.armyFrame[team]!;
  const size = sim.size;
  const gx = clampPos(canonX(k, x, y, size), size);
  const gy = clampPos(canonY(k, x, y, size), size);
  // Measured in the army frame, as slotTargets does, so a rotated twin decides alike.
  const placed = taken.map((p) => ({ x: canonX(k, p.x, p.y, size), y: canonY(k, p.x, p.y, size), r: p.r }));
  if (!placed.some((p) => norm(p.x - gx, p.y - gy) < p.r + e.radius + sim.econ.slotGap - SNAP_EPS)) return [[clampPos(x, size), clampPos(y, size)]];
  const [sx, sy] = sim.ringSlot(team, plane, e.radius, gx, gy, canonX(k, e.x, e.y, size), canonY(k, e.x, e.y, size), placed) ?? [gx, gy];
  const qx = clampPos(sx, size);
  const qy = clampPos(sy, size);
  return [[rotX(k, qx, qy, size), rotY(k, qx, qy, size)]];
}

/** How far (tiles) from the goal `us`'s slots can land: the group's disc plus every slot ring of its largest body. */
function slotReach(sim: Sim, us: readonly Ent[]): number {
  let r = 0;
  for (const e of us) r = Math.max(r, e.radius);
  return (MAX_SLOT_RINGS + us.length) * (2 * r + sim.econ.slotGap);
}

/** Units moving together travel at the slowest member's own speed (tiles/tick, terrain aside); 0 for a single unit. */
function groupSpeed(sim: Sim, us: Ent[]): number {
  if (us.length < 2) return 0;
  let v = Infinity;
  for (const e of us) v = Math.min(v, sim.baseSpeed(e));
  return v;
}

/** Resolve own, alive, built units under the seat's authority, optionally requiring kinds or a registry capability. */
function ownUnits(sim: Sim, team: Army, role: Plane, ids: string[], allowed?: readonly Kind[] | keyof Capabilities, focusFire = false, housing = false): Ent[] | GameError {
  const out: Ent[] = [];
  for (const id of ids) {
    const e = sim.alive(idNum(id));
    // A hidden enemy id answers exactly like a dead or never-issued one: the code must not reveal that it lives.
    if (!e || (e.side !== team && !sim.sees(team, e))) return 'unknown_unit';
    if (e.side !== team || (sim.isStructure(e) && !(focusFire && (e.kind === 'turret' || isHardpointKind(e.kind)) && sim.armed(e))) || isNeutralKind(e.kind)) return 'not_your_unit';
    if (e.plane !== role && !(role === e.transitKind?.from && e.transitUntil > 0)) return 'wrong_plane';
    if (allowed && (typeof allowed === 'string' ? !sim.capable(e, allowed) : !allowed.includes(e.kind))) return 'wrong_kind';
    if (!e.built) return 'blocked';
    if ((e.hangar && !housing) || e.transitKind?.stationary) return 'blocked';
    out.push(e);
  }
  return out;
}

/** Apply one intent for `army` (the boundary converts a contract army id with `Sim.armyIndex`). */
export function applyIntent(sim: Sim, team: Army, role: Plane, intent: GameIntent, source: IntentSource = 'owner', ownerRoles?: readonly string[]): ApplyResult {
  if (sim.over) return fail('game_over');
  // An eliminated army has nothing left to command while the others play on.
  if (!sim.inPlay(team)) return fail('eliminated');
  // Protocol bounds cover L80; reject points outside this match before consulting any terrain or fog.
  if ('x' in intent && intent.x !== undefined && (intent.x < 0 || intent.x > sim.size)) return fail('invalid_target');
  if ('y' in intent && intent.y !== undefined && (intent.y < 0 || intent.y > sim.size)) return fail('invalid_target');
  switch (intent.kind) {
    case 'queue_add':
    case 'dig':
    case 'fortify':
    case 'undermine':
    case 'rail':
    case 'breach':
    case 'bridge':
      if ((intent.x !== undefined && intent.x >= sim.size) || (intent.y !== undefined && intent.y >= sim.size)) return fail('invalid_target');
      break;
    case 'designate':
      if (intent.rect && (Math.min(intent.rect.x0, intent.rect.x1, intent.rect.y0, intent.rect.y1) < 0
        || Math.max(intent.rect.x0, intent.rect.x1, intent.rect.y0, intent.rect.y1) >= sim.size)) return fail('invalid_target');
      if (intent.cells?.some((c) => c.x < 0 || c.y < 0 || c.x >= sim.size || c.y >= sim.size)) return fail('invalid_target');
      break;
  }
  const t = sim.armies[team]!;
  const known = t.group.known;
  // Orders and fleet geometry resolve in the army's frame (DESIGN §15.1).
  const frame = sim.armyFrame[team]!;
  switch (intent.kind) {
    case 'hangar': {
      const aerie = sim.alive(idNum(intent.target));
      if (!aerie || aerie.kind !== 'aerie' || aerie.side !== team) return fail('invalid_target');
      if (!aerie.built || !t.powered || aerie.hp <= 0) return fail('blocked');
      const us = ownUnits(sim, team, role, intent.units, AIRCRAFT);
      if (typeof us === 'string') return fail(us);
      let count = 0;
      for (const e of sim.ents) if (!e.dead && (e.hangar === aerie.id || (e.order.k === 'hangar' && e.order.target === aerie.id && !us.includes(e)))) count++;
      if (count + us.length > sim.econ.aerieCapacity) return fail('queue_full');
      for (const e of us) if (e.transitKind || norm(e.x - aerie.x, e.y - aerie.y) > sim.econ.aerieDockRadius) return fail('invalid_target');
      for (const e of us) {
        if (Math.abs(e.elevation - aerie.elevation) > MOORING_CAPTURE_HEIGHT) sim.order(e, { k: 'hangar', target: aerie.id });
        else sim.houseAircraft(e, aerie);
      }
      return OK;
    }
    case 'launch': {
      const us = ownUnits(sim, team, role, intent.units, AIRCRAFT, false, true);
      if (typeof us === 'string') return fail(us);
      for (const e of us) if (!e.hangar || e.state === 'launching') return fail('blocked');
      for (const e of us) { e.state = 'launching'; e.ready = sim.tick + sim.econ.aerieLaunchTicks; }
      return OK;
    }
    case 'moor': {
      if (!sim.econ.mooringEnabled) return fail('blocked');
      const tower = sim.alive(idNum(intent.tower));
      const isl = sim.alive(idNum(intent.island));
      if (!tower || tower.kind !== 'mooring_tower' || tower.side !== team || !tower.built
        || !isl || isl.kind !== 'island' || !sim.seesCell(team, 'sky', cellOf(isl.x, isl.y, sim.size))) return fail('invalid_target');
      if (tower.mooringTarget || isl.mooringPhase || sim.tick < isl.mooringReadyAt) return fail('cooldown');
      if (!sim.mooringRouteAvailable(tower, isl)) return fail('blocked');
      if (!sim.canSpend(team, 0, tower.mooringDebt + sim.econ.mooringUpkeep / TICK_RATE, role)) return fail('cannot_afford');
      if (tower.mooringDebt) {
        sim.spend(team, 0, tower.mooringDebt, role);
        tower.mooringDebt = 0;
      }
      tower.mooringTarget = isl.id;
      return OK;
    }
    case 'unmoor': {
      const tower = sim.alive(idNum(intent.tower));
      if (!tower || tower.kind !== 'mooring_tower' || tower.side !== team) return fail('invalid_target');
      const isl = sim.alive(tower.mooringTarget);
      if (isl?.mooringTower === tower.id) sim.releaseMooring(isl);
      tower.mooringTarget = 0;
      return OK;
    }
    case 'drop_ore': {
      if (role !== 'sky') return fail('wrong_plane');
      const island = sim.alive(idNum(intent.island));
      if (!island || island.kind !== 'island') return fail('invalid_target');
      if (island.side !== team) return fail('not_held');
      if (island.oreBuffer <= 0) return fail('invalid_target');
      sim.dropIslandOre(island);
      return OK;
    }
    case 'dismantle': {
      const structure = sim.alive(idNum(intent.structure));
      if (!structure || structure.hp <= 0 || (structure.side !== team && !sim.sees(team, structure))) return fail('invalid_target');
      if (structure.side !== team) return fail('not_your_unit');
      if (structure.plane !== role) return fail('wrong_plane');
      if (!isStructureKind(structure.kind) || structure.kind === 'spire') return fail('wrong_kind');
      if (!structure.built) return fail('blocked');
      // Use ordinary destruction, but never award a previous attacker this deliberate loss.
      structure.lastHitBy = NEUTRAL;
      structure.lastHitCause = 'dismantle';
      structure.lastHitPlane = undefined;
      structure.lastHitKind = undefined;
      sim.kill(structure);
      return OK;
    }
    case 'emplace': {
      if (!sim.econ.gunshipEmplaceEnabled || sim.econ.islandHardpoints < 1) return fail('blocked');
      const us = ownUnits(sim, team, role, [intent.unit], ['gunship']);
      if (typeof us === 'string') return fail(us);
      const gun = us[0]!;
      const isl = sim.alive(idNum(intent.island));
      if (!isl || isl.kind !== 'island') return fail('invalid_target');
      if (isl.side !== team) return fail('not_held');
      if ((isl.hardpoint && sim.alive(isl.hardpoint)) || isl.state === 'capturing'
        || t.queue.some((e) => isBuildableHardpoint(e.item) && e.island === isl.id)) return fail('occupied');
      if (norm(gun.x - isl.x, gun.y - isl.y) > sim.econ.captureRadius || Math.abs(gun.elevation - isl.elevation) > MOORING_CAPTURE_HEIGHT) return fail('invalid_target');
      if (t.structures >= sim.econ.structureCap) return fail('queue_full');
      sim.emplace(gun, isl);
      return OK;
    }
    case 'seed': {
      if (!sim.econ.seederEnabled) return fail('blocked');
      const seeder = sim.alive(idNum(intent.seeder));
      if (!seeder || seeder.kind !== 'storm_seeder' || seeder.side !== team) return fail('invalid_target');
      if (!seeder.built || seeder.hp <= 0 || !t.powered || sim.econ.seederDuration <= 0) return fail('blocked');
      if (seeder.activeUntil > sim.tick || seeder.ready > sim.tick) return fail('cooldown');
      if (!sim.spend(team, 0, sim.econ.seederCost, role)) return fail('cannot_afford');
      seeder.activeUntil = sim.tick + sim.econ.seederTelegraph + sim.econ.seederDuration;
      seeder.ready = sim.tick + sim.econ.seederCooldown;
      seeder.state = 'active';
      t.stats.seeds++;
      return OK;
    }
    case 'airdrop': {
      const aerie = sim.alive(idNum(intent.aerie));
      if (!aerie || aerie.kind !== 'aerie' || aerie.side !== team) return fail('invalid_target');
      if (!aerie.built || aerie.hp <= 0 || !t.powered || aerie.ready > sim.tick) return fail('blocked');
      const n = sim.econ.aerieDropCount;
      const cost = sim.stats.trooper;
      let pending = 0;
      for (const e of t.queue) if (e.started && isUnitKind(e.item)) pending++;
      const recoverySupply = Math.min(sim.econ.queueRecoverySupply, Math.max(0, sim.econ.queueRecoveryWorkers - sim.viableWorkers(team)));
      if (t.pop + pending + n > sim.econ.popCap - recoverySupply) return fail('queue_full');
      if (!sim.canSpend(team, cost.alloy * n, cost.energy * n, role)) return fail('cannot_afford');
      // Column landing is rejected on public blocked ground, without querying hidden surface occupants.
      if (sim.block[cellOf(aerie.x, aerie.y, sim.size)] || sim.holes[cellOf(aerie.x, aerie.y, sim.size)]) return fail('blocked');
      if (!sim.spend(team, cost.alloy * n, cost.energy * n, role)) return fail('cannot_afford');
      aerie.ready = sim.tick + sim.econ.aerieDropCooldown;
      for (let i = 0; i < n; i++) {
        const u = sim.add('trooper', team, 'sky', aerie.x, aerie.y);
        u.productionRole = role;
        u.elevation = aerie.elevation;
        t.pop++;
        t.stats.produced++;
        sim.emit([team], 'produced', 'sky', u.x, u.y, 'trooper', team, { owner: role });
        sim.startTransit(u, TRANSITS.airdrop);
      }
      return OK;
    }
    case 'research':
      return queueAdd(sim, team, role, { kind: 'queue_add', item: intent.upgrade, ifAffordable: intent.ifAffordable }, source);
    case 'ascend': {
      const us = ownUnits(sim, team, role, intent.units);
      if (typeof us === 'string') return fail(us);
      for (const e of us) {
        if (!sim.hasAbility(e, 'ascend')) return fail('wrong_kind');
        if (!sim.canTransit(e, TRANSITS.ascend)) return fail('cooldown');
      }
      if (!sim.canSpend(team, us.length * transitValue(TRANSITS.ascend.cost.alloy, sim.econ),
        us.length * transitValue(TRANSITS.ascend.cost.energy, sim.econ), role)) return fail('cannot_afford');
      for (const e of us) sim.startTransit(e, TRANSITS.ascend);
      return OK;
    }
    case 'sun_lance':
    case 'aegis': {
      const ability = intent.kind;
      const us = ownUnits(sim, team, role, intent.units, ability === 'sun_lance' ? ['lancer'] : ['bastion']);
      if (typeof us === 'string') return fail(us);
      const energy = ability === 'sun_lance' ? sim.econ.lanceEnergy : sim.econ.aegisEnergy;
      if (!sim.canSpend(team, 0, energy * us.length, role)) return fail('cannot_afford');
      for (const e of us) {
        if (!sim.hasAbility(e, ability)) return fail('blocked');
        if (e.abilityReady > sim.tick || e.lanceAt > sim.tick || e.aegisUntil > sim.tick) return fail('cooldown');
        if (intent.kind === 'sun_lance' ? !sim.canSunLance(e, intent.x, intent.y) : !sim.canAegis(e)) return fail('invalid_target');
      }
      for (const e of us) {
        if (intent.kind === 'sun_lance') sim.sunLance(e, intent.x, intent.y);
        else sim.activateAegis(e);
      }
      return OK;
    }
    // Orbit fleets use a shared travelling waypoint, not just a spread-out destination; without an explicit formation
    // its members hold their own size-scaled slots around the goal, keeping the fleet's layout when it is compact.
    case 'move': {
      const us = ownUnits(sim, team, role, intent.units);
      if (typeof us === 'string') return fail(us);
      const queued = intent.queue === true;
      if (intent.formation && us.some((e) => e.plane !== 'orbit')) return fail('wrong_plane');
      if (intent.escort && intent.formation !== 'escort') return fail('invalid_target');
      if (us.length > 1 && us.every((e) => e.plane === 'orbit')) {
        us.sort(bySeq);
        const shape = intent.formation;
        const anchor = intent.escort ? us.find((e) => e.id === idNum(intent.escort!)) : us[0];
        if (shape === 'escort' && !anchor) return fail('invalid_target');
        if (shape === 'escort' && anchor !== us[0]) {
          us.splice(us.indexOf(anchor!), 1);
          us.unshift(anchor!);
        }
        let cx = 0;
        let cy = 0;
        for (const e of us) {
          cx += canonX(frame, e.x, e.y, sim.size) / us.length;
          cy += canonY(frame, e.x, e.y, sim.size) / us.length;
        }
        if (shape === 'escort') {
          cx = canonX(frame, anchor!.x, anchor!.y, sim.size);
          cy = canonY(frame, anchor!.x, anchor!.y, sim.size);
        }
        const gx = canonX(frame, intent.x, intent.y, sim.size);
        const gy = canonY(frame, intent.x, intent.y, sim.size);
        const qx = clampPos(gx, sim.size);
        const qy = clampPos(gy, sim.size);
        const heading = dmath.atan2(gy - cy || 0, gx - cx || 0);
        const ux = dmath.cos(heading);
        const uy = dmath.sin(heading);
        // Neighbouring formation slots never put two hulls in contact, however large the ships.
        let biggest = 0;
        for (const e of us) biggest = Math.max(biggest, e.radius);
        const spacing = Math.max(sim.econ.formationSpacing, 2 * biggest + sim.econ.slotGap);
        const taken = sim.claimedDiscs(team, 'orbit', intent.x, intent.y, slotReach(sim, us), us);
        let offsets: [number, number][];
        if (shape) {
          offsets = us.map((_, i): [number, number] => {
            let forward = 0;
            let side = 0;
            if (shape === 'line') side = (i - (us.length - 1) / 2) * spacing;
            else if (shape === 'wedge') {
              const row = (i + 1) >> 1;
              forward = -row * spacing;
              side = row * spacing * (i % 2 ? 1 : -1);
            } else if (i > 0) {
              const count = us.length - 1;
              const radius = count > 2 ? spacing / (2 * dmath.sin(Math.PI / count)) : spacing;
              const angle = (i - 1) * Math.PI * 2 / count;
              forward = dmath.cos(angle) * radius;
              side = dmath.sin(angle) * radius;
            }
            return [ux * forward - uy * side, uy * forward + ux * side];
          });
          // Wedge reference is its centroid; escort reference is the protected ship; slots are relative to the goal.
          if (shape === 'wedge') {
            let ox = 0;
            let oy = 0;
            for (const p of offsets) { ox += p[0] / us.length; oy += p[1] / us.length; }
            for (const p of offsets) { p[0] -= ox; p[1] -= oy; }
          }
          // The shape's slots at the goal must be free too (off the derelict's walls, clear of ships already there):
          // a blocked one moves to the nearest free point, the rest keep the shape.
          offsets = sim.placeSlots(team, 'orbit', qx, qy, us.map((e, i) => ({ r: e.radius, px: qx + offsets[i]![0], py: qy + offsets[i]![1] })), taken)
            .map(([sx, sy]): [number, number] => [sx - qx, sy - qy]);
        } else {
          offsets = sim.slotTargets(team, 'orbit', us, intent.x, intent.y, taken).map(([sx, sy]): [number, number] => [
            // Relative to the goal on the position grid (as slotTargets uses it), so both teams' offsets are identical.
            canonX(frame, sx, sy, sim.size) - qx, canonY(frame, sx, sy, sim.size) - qy,
          ]);
        }
        const speed = groupSpeed(sim, us);
        const fleet: FleetMove = {
          members: us.map((e) => e.id), x: clampPos(rotX(frame, cx, cy, sim.size), sim.size), y: clampPos(rotY(frame, cx, cy, sim.size), sim.size),
          goalX: clampPos(intent.x, sim.size), goalY: clampPos(intent.y, sim.size), speed: 0, vx: 0, vy: 0, skirt: 0, updated: -1,
          started: false, anchor: shape === 'escort' ? anchor!.id : 0, side: team, finished: false,
        };
        us.forEach((e, i) => {
          const fx = clampPos(sim.size / 2 + offsets[i]![0], sim.size) - sim.size / 2;
          const fy = clampPos(sim.size / 2 + offsets[i]![1], sim.size) - sim.size / 2;
          const ox = rotVX(frame, fx, fy);
          const oy = rotVY(frame, fx, fy);
          sim.order(e, { k: 'move', x: clampPos(fleet.goalX + ox, sim.size), y: clampPos(fleet.goalY + oy, sim.size), fight: intent.mode === 'fight', speed, fleet, ox, oy }, queued);
        });
        return OK;
      }
      if (role === 'depths') {
        const goal = cellFor(frame, intent.x, intent.y, sim.size);
        for (const e of us) if (!queued && !reachable(sim, e, goal, false)) return fail('no_path');
        const x = cellCentreX(goal, sim.size);
        const y = cellCentreY(goal, sim.size);
        const spots = spread(sim, team, role, us, x, y);
        us.forEach((e, i) => {
          // A slot in a tunnel the unit cannot reach falls back to the goal cell itself.
          const slot = cellFor(frame, spots[i]![0], spots[i]![1], sim.size);
          const [sx, sy] = slot === goal || queued || reachable(sim, e, slot, false) ? spots[i]! : [x, y];
          sim.order(e, { k: 'move', x: sx, y: sy, fight: intent.mode === 'fight', speed: 0 }, queued);
        });
        return OK;
      }
      // A destination on ground the team knows is blocked (a hole, a cliff, water, a known footprint) snaps to the
      // nearest open cell it knows of, however deep in the hole, ties toward the first unit ordered.
      const dest = role === 'surface' ? sim.surfaceCellNear(intent.x, intent.y, Infinity, team, us[0]!.x, us[0]!.y, sim.surfaceNav[team]!) : { x: intent.x, y: intent.y };
      if (!dest) return fail('blocked');
      const spots = spread(sim, team, role, us, dest.x, dest.y);
      const speed = groupSpeed(sim, us);
      us.forEach((e, i) => {
        // A spot cut off from the unit (a pocket inside a ring of holes) becomes the nearest ground it can reach.
        const [x, y] = queued ? spots[i]! : sim.reachableNear(e, spots[i]![0], spots[i]![1]);
        sim.order(e, { k: 'move', x, y, fight: intent.mode === 'fight', speed }, queued);
      });
      return OK;
    }
    case 'patrol': {
      const us = ownUnits(sim, team, role, intent.units);
      if (typeof us === 'string') return fail(us);
      const goal = cellFor(frame, intent.x, intent.y, sim.size);
      if (role === 'depths') {
        // World-point orders on cell borders choose mirrored cells, unlike explicit integer dig-cell coordinates.
        for (const e of us) if (!reachable(sim, e, goal, false)) return fail('no_path');
      } else if (role === 'surface' && sim.block[cellFor(frame, intent.x, intent.y, sim.size)]) return fail('blocked');
      const spots = role === 'depths' ? us.map((): [number, number] => [cellCentreX(goal, sim.size), cellCentreY(goal, sim.size)]) : spread(sim, team, role, us, intent.x, intent.y);
      us.forEach((e, i) => {
        const [bx, by] = intent.queue === true ? spots[i]! : sim.reachableNear(e, spots[i]![0], spots[i]![1]);
        sim.order(e, { k: 'patrol', ax: e.x, ay: e.y, bx, by, toB: true }, intent.queue === true);
      });
      return OK;
    }
    case 'stance': {
      const us = ownUnits(sim, team, role, intent.units);
      if (typeof us === 'string') return fail(us);
      for (const e of us) {
        e.stance = intent.stance;
        e.anchored = false;
      }
      return OK;
    }
    case 'rally': {
      if (role === 'surface' && sim.block[cellFor(frame, intent.x, intent.y, sim.size)]) return fail('blocked');
      if (role === 'depths' && !isOpenCell(known[cellFor(frame, intent.x, intent.y, sim.size)]!)) return fail('blocked');
      t.rally[role] = { x: intent.x, y: intent.y };
      return OK;
    }
    case 'attack': {
      const target = sim.alive(idNum(intent.target));
      if (!target || !sim.sees(team, target)) return fail('not_visible');
      if (target.kind === 'island') return attackIsland(sim, team, role, intent, target);
      if (target.kind === 'post') return holdPost(sim, team, role, intent.units, target, intent.queue === true);
      const payload = sim.payloads[target.kind];
      const towing = payload && target.state === 'towed' ? sim.alive(target.link) : undefined;
      // Falling payloads: any not from the army's own side (neutral rocks included); towed ones: a hostile tug.
      const enemy = payload ? payload.interceptable && (target.state === 'falling' ? target.side === NEUTRAL || sim.hostile(team, target.side) : !!towing && sim.hostile(team, towing.side)) : sim.hostile(team, target.side);
      if (!enemy) return fail('invalid_target');
      const us = ownUnits(sim, team, role, intent.units, undefined, true);
      if (typeof us === 'string') return fail(us);
      for (const e of us) if (!sim.canHit(e, target.plane) || (!target.unit && sim.lensShot(e, target.plane)) || (payload && !sim.payloadTarget(target, team, sim.stats[e.kind as keyof typeof STATS]?.weapon, e.plane))) return fail('invalid_target');
      // Holes and cliffs can leave no spot to fire from (a Spire ringed by craters): reject rather than idle silently.
      // Units that can get there go; any cut off drop the order in the sim with a `target_unreachable` event.
      if (us.length > 0 && !us.some((e) => sim.canReachFiring(e, target))) return fail('no_path');
      for (const e of us) sim.order(e, { k: 'attack', target: target.id }, intent.queue === true);
      return OK;
    }
    case 'stop': {
      const us = ownUnits(sim, team, role, intent.units, undefined, true);
      if (typeof us === 'string') return fail(us);
      for (const e of us) sim.order(e, { k: 'none' });
      return OK;
    }
    case 'queue_add':
      return queueAdd(sim, team, role, intent, source);
    case 'queue_cancel': {
      const i = sim.queueIndexOf(team, idNum(intent.entry));
      if (i < 0) return fail('invalid_target');
      const entry = sim.armies[team]!.queue[i]!;
      if (entry.plane !== role || source !== 'owner' && (entry.by !== role || entry.source === 'owner' || source !== 'agent' && entry.source === 'agent')) return fail('invalid_target');
      sim.queueCancel(team, role, i, source);
      return OK;
    }
    case 'queue_move': {
      const i = sim.queueIndexOf(team, idNum(intent.entry));
      if (i < 0) return fail('invalid_target');
      const entry = sim.armies[team]!.queue[i]!;
      if (entry.plane !== role || source !== 'owner' && (entry.by !== role || entry.source === 'owner' || source !== 'agent' && entry.source === 'agent')) return fail('invalid_target');
      const index = source === 'owner' ? intent.index : automaticQueueIndex(sim, team, role, intent.index, i);
      sim.queueMove(team, role, i, index, source);
      return OK;
    }
    case 'queue_priority': {
      const i = sim.queueIndexOf(team, idNum(intent.entry));
      const entry = t.queue[i];
      if (source !== 'owner' || !entry || entry.plane !== role || entry.started) return fail('invalid_target');
      if (sim.queueBlock(team, entry)) return fail('blocked');
      sim.queuePriority(team, role, i, ownerRoles ?? [role]);
      return OK;
    }
    case 'macro':
      return applyMacro(sim, team, role, intent.action);
    case 'designate': {
      if ((intent.rect === undefined) === (intent.cells === undefined)) return fail('invalid_target');
      designateMask.fill(0, 0, sim.n);
      let size = 0;
      if (intent.rect) {
        const { x0, y0, x1, y1 } = intent.rect;
        size = (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1);
        if (size > sim.econ.designateCells) return fail('designation_limit');
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
          for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) designateMask[y * sim.size + x] = 1;
      } else {
        size = intent.cells!.length;
        if (!size) return fail('invalid_target');
        if (size > sim.econ.designateCells) return fail('designation_limit');
        for (const c of intent.cells!) designateMask[c.y * sim.size + c.x] = 1;
      }
      let count = 0;
      for (let c = 0; c < sim.n; c++) {
        const priority = designateMask[c] ? intent.priority : t.designations[c]!;
        if (priority && !isOpenCell(known[c]!) && known[c] !== CELL.bedrock && known[c] !== CELL.lode) count++;
      }
      if (count > sim.econ.designateMax) return fail('designation_limit');
      for (let c = 0; c < sim.n; c++) {
        const requested = designateMask[c] ? intent.priority : t.designations[c]!;
        const priority = isOpenCell(known[c]!) || known[c] === CELL.bedrock || known[c] === CELL.lode ? 0 : requested;
        sim.designateCell(t, c, priority);
      }
      return OK;
    }
    case 'dig': {
      const us = ownUnits(sim, team, role, intent.units, 'dig');
      if (typeof us === 'string') return fail(us);
      const c = intent.y * sim.size + intent.x;
      // Bedrock or Mother Lode the team knows of, and the map rim (always bedrock): never what it cannot know.
      if (known[c] === CELL.bedrock || known[c] === CELL.lode || intent.x === 0 || intent.y === 0 || intent.x === sim.size - 1 || intent.y === sim.size - 1) return fail('invalid_target');
      for (const e of us) if (!reachable(sim, e, c, true)) return fail('no_path');
      for (const e of us) sim.order(e, { k: 'dig', c }, intent.queue === true);
      return OK;
    }
    case 'mine': {
      const us = ownUnits(sim, team, role, intent.units, 'carry');
      if (typeof us === 'string') return fail(us);
      const near = intent.x !== undefined && intent.y !== undefined ? cellFor(frame, intent.x, intent.y, sim.size) : -1;
      for (const e of us) sim.order(e, { k: 'mine', ore: -1, exploring: false, near }, intent.queue === true);
      return OK;
    }
    case 'fortify': {
      const us = ownUnits(sim, team, role, intent.units, 'fortify');
      if (typeof us === 'string') return fail(us);
      const c = intent.y * sim.size + intent.x;
      // Team knowledge only (the order re-checks the real cell, and that it borders an own tunnel, once beside it).
      // Walls only (rock or fortified rock; tunnels are never filled), or an own bulkhead to repair and reinforce.
      const code = known[c]!;
      const ownGate = sim.bulkheadOn(c)?.side === team;
      if (!ownGate && code !== CELL.rock && code !== CELL.fortified) return fail('invalid_target');
      if (sim.holes[c]) return fail('invalid_target');
      const x = intent.x;
      const near = [x < sim.size - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + sim.size, c - sim.size].some(
        (n) => n >= 0 && n < sim.n && isOpenCell(known[n]!) && adjacent4(n, c, sim.size),
      );
      if (!near) return fail('not_adjacent');
      if (!sim.canSpend(team, sim.econ.fortifyCost * us.length, 0, role)) return fail('cannot_afford');
      for (const e of us) sim.order(e, { k: 'fortify', c, working: false }, intent.queue === true);
      return OK;
    }
    case 'deploy': {
      const us = ownUnits(sim, team, role, intent.units);
      if (typeof us === 'string') return fail(us);
      // All-or-nothing: every unit must have a stance on this plane, switched on by the match rules.
      for (const e of us) {
        const spec = sim.deploySpec(e);
        if (!spec || spec.plane !== e.plane) return fail('wrong_kind');
        if (spec.enabled && !sim.econ[spec.enabled]) return fail('blocked');
        if (intent.on && (e.deploy === DEPLOY_NONE || e.deploy === DEPLOY_PACKING) && !sim.deployClear(e)) return fail('blocked');
      }
      for (const e of us) {
        if (!intent.on) {
          sim.order(e, NONE);
          sim.pack(e);
          e.folded = true;
        } else if (e.deploy === DEPLOY_NONE || e.deploy === DEPLOY_PACKING) {
          e.folded = false;
          sim.startDeploy(e);
        }
      }
      return OK;
    }
    case 'flare': {
      const us = ownUnits(sim, team, role, [intent.unit], ['warden']);
      if (typeof us === 'string') return fail(us);
      const e = us[0]!;
      const c = cellFor(frame, intent.x, intent.y, sim.size);
      const err = sim.flareError(e, c);
      if (err) return fail(err);
      sim.throwFlare(e, c);
      return OK;
    }
    case 'undermine': {
      if (t.seats[role].mandate.limits?.collapses === false) return fail('mandate_limit');
      const us = ownUnits(sim, team, role, intent.units, ['sapper']);
      if (typeof us === 'string') return fail(us);
      const c = intent.y * sim.size + intent.x;
      if (!isOpenCell(known[c]!)) return fail('invalid_target');
      for (const e of us) if (!reachable(sim, e, c, false)) return fail('no_path');
      for (const e of us) sim.order(e, { k: 'undermine', c, at: 0 }, intent.queue === true);
      return OK;
    }
    case 'rail': {
      const us = ownUnits(sim, team, role, intent.units, 'build');
      if (typeof us === 'string') return fail(us);
      const c = intent.y * sim.size + intent.x;
      if (!isOpenCell(known[c]!)) return fail('invalid_target');
      for (const e of us) if (!reachable(sim, e, c, false)) return fail('no_path');
      if (!sim.canSpend(team, sim.econ.railCost, 0, role)) return fail('cannot_afford');
      for (const e of us) sim.order(e, { k: 'rail', c }, intent.queue === true);
      return OK;
    }
    case 'breach': {
      const us = ownUnits(sim, team, role, intent.units, ['trooper']);
      if (typeof us === 'string') return fail(us);
      const c = intent.y * sim.size + intent.x;
      if (!isOpenCell(known[c]!)) return fail('invalid_target');
      // The ground above must be open: no cliff, no hole, no structure the team knows of on it (one it cannot know of
      // stops the breach when it completes).
      if (sim.block[c]) return fail('blocked');
      if (sim.structureOver(c, team)) return fail('occupied');
      for (const e of us) if (!reachable(sim, e, c, false)) return fail('no_path');
      for (const e of us) sim.order(e, { k: 'breach', c, felt: false }, intent.queue === true);
      return OK;
    }
    case 'bridge': {
      const us = ownUnits(sim, team, role, intent.units, 'build');
      if (typeof us === 'string') return fail(us);
      const c = intent.y * sim.size + intent.x;
      // A known lava-lake cell (team knowledge decides the span; the sim re-checks the real cells) or a hole.
      const lake = known[c] === CELL.lake;
      if (!(lake ? sim.lavaBridgeable(c, known) : sim.backfillable(c))) return fail('invalid_target');
      if (!sim.canSpend(team, lake ? sim.econ.lavaBridgeCost : sim.econ.bridgeCost, 0, role) && !sim.bridgeWork.has(team * sim.n + c)) return fail('cannot_afford');
      for (const e of us) sim.order(e, { k: 'bridge', c, working: false }, intent.queue === true);
      return OK;
    }
    case 'transfer': {
      const transit = intent.to === 'depths' ? TRANSITS.descend : TRANSITS.emerge;
      const us = ownUnits(sim, team, role, intent.units, transit.kinds);
      if (typeof us === 'string') return fail(us);
      if (intent.to === role) return fail('invalid_target');
      // Own built Shafts only (Sim.shaftPortal): the Spire root, holes and enemy Shafts are no portals.
      let shafts: Ent[] = [];
      if (intent.x !== undefined && intent.y !== undefined) {
        const { x, y } = intent;
        const s = sim.ents.find((e) => e.kind === 'shaft' && e.side === team && e.built && !e.dead && footprintDistance('shaft', e.x, e.y, x, y) <= 0);
        if (!s) return fail('no_shaft');
        if (sim.shaftSealed(team, s)) return fail('shaft_sealed');
        shafts = [s];
      } else {
        let built = false;
        for (const e of sim.ents) {
          if (e.kind !== 'shaft' || e.side !== team || !e.built || e.dead) continue;
          built = true;
          if (!sim.shaftSealed(team, e)) shafts.push(e);
        }
        if (!shafts.length) return fail(built ? 'shaft_sealed' : 'no_shaft');
      }
      const at = new Int32Array(sim.n).fill(-1);
      shafts.forEach((s, i) => {
        const c = cellFor(frame, s.x, s.y, sim.size);
        if (at[c] === -1) at[c] = i;
      });
      const plan: [Ent, Ent][] = [];
      for (const e of us) {
        let best = shafts[0]!;
        if (role === 'depths') {
          const path = searchDepths(known, cellOfEnt(e, sim.size), (c) => at[c]! >= 0, sim.costs.walk, false, Infinity, frame, null, knownBarrier(sim, team), sim.size);
          if (!path) return fail('no_path');
          best = shafts[at[path.length ? path[path.length - 1]! : cellOfEnt(e, sim.size)]!]!;
        } else {
          let bd = Infinity;
          for (const s of shafts) {
            // On the shared position grid, so rotated units see exact ties (then the Shafts' entity order).
            const d = quantize(norm(s.x - e.x, s.y - e.y));
            if (d < bd) {
              bd = d;
              best = s;
            }
          }
        }
        plan.push([e, best]);
      }
      for (const [e, s] of plan) sim.order(e, { k: 'transfer', to: intent.to, shaft: s.id }, intent.queue === true);
      return OK;
    }
    case 'convert': {
      if (!sim.econ.breachersEnabled) return fail('blocked');
      const us = ownUnits(sim, team, role, intent.units, ['trooper']);
      if (typeof us === 'string') return fail(us);
      let yard: Ent | undefined;
      if (intent.yard !== undefined) {
        // Own yards only: a hidden or enemy id answers exactly like a dead one.
        const y = sim.alive(idNum(intent.yard));
        if (!y || y.side !== team || y.kind !== 'drill_yard') return fail('invalid_target');
        yard = y;
      } else {
        // Nearest to the group's earliest-made unit (rotation-exact), ties to the earlier yard.
        const lead = us.reduce((a, b) => (b.seq < a.seq ? b : a));
        let bd = Infinity;
        for (const y of sim.ents) {
          if (y.dead || y.side !== team || y.kind !== 'drill_yard' || !y.built || y.hp <= 0) continue;
          const d = quantize(norm(y.x - lead.x, y.y - lead.y));
          if (d < bd || (d === bd && yard && y.seq < yard.seq)) {
            bd = d;
            yard = y;
          }
        }
        if (!yard) return fail('invalid_target');
      }
      if (!yard.built || yard.hp <= 0) return fail('blocked');
      for (const e of us) sim.order(e, { k: 'convert', yard: yard.id, at: false }, intent.queue === true);
      return OK;
    }

    case 'capture': {
      const isl = sim.alive(idNum(intent.island));
      if (!isl || isl.kind !== 'island') return fail('invalid_target');
      const us = ownUnits(sim, team, role, intent.units, 'capture');
      if (typeof us === 'string') return fail(us);
      for (const e of us) if (e.plane !== 'sky' || e.transitUntil > 0) return fail('wrong_plane');
      for (const e of us) sim.order(e, { k: 'capture', island: isl.id }, intent.queue === true);
      return OK;
    }
    case 'mine_asteroid': {
      const us = ownUnits(sim, team, role, intent.units, ['tug']);
      if (typeof us === 'string') return fail(us);
      const a = sim.alive(idNum(intent.asteroid));
      if (!a || !sim.seesCell(team, a.plane, cellOfEnt(a, sim.size))) return fail('not_visible');
      if (a.kind !== 'asteroid' || a.plane !== 'orbit' || a.state !== 'drifting' || a.resourceType === 'slag' || a.resourceRemaining <= 0) return fail('invalid_target');
      const dock = t.spire.orbit;
      if (dock.dead || dock.hp <= 0 || !dock.built || dock.side !== team) return fail('segment_destroyed');
      for (const e of us) if (e.link) return fail('occupied');
      for (const e of us) sim.order(e, { k: 'mine_asteroid', asteroid: a.id, returning: false,
        site: { x: a.x, y: a.y, vx: a.vx, vy: a.vy, tick: sim.tick } }, intent.queue === true);
      return OK;
    }
    case 'grapple': {
      const us = ownUnits(sim, team, role, intent.units, 'tow');
      if (typeof us === 'string') return fail(us);
      const a = sim.alive(idNum(intent.asteroid));
      if (!a || !sim.sees(team, a)) return fail('not_visible');
      if (a.kind === 'core' ? a.state !== 'idle' : a.kind !== 'asteroid' || a.state !== 'drifting') return fail('invalid_target');
      for (const e of us) if (e.link) return fail('occupied');
      for (const e of us) sim.order(e, { k: 'grapple', asteroid: a.id }, intent.queue === true);
      return OK;
    }
    case 'deorbit': {
      if (t.seats[role].mandate.limits?.asteroidDrops === false) return fail('mandate_limit');
      const us = ownUnits(sim, team, role, intent.units, 'tow');
      if (typeof us === 'string') return fail(us);
      const towing = us.filter((e) => e.link);
      if (towing.length === 0) return fail('not_held');
      for (const e of towing) {
        const a = sim.alive(e.link)!;
        if (norm(a.x - intent.x, a.y - intent.y) > sim.econ.deorbitRange) return fail('invalid_target');
        // The core drops only from open space: out past the derelict hull.
        if (a.kind === 'core' && sim.derelict && derelictLayer(sim.derelict, norm(a.x - sim.derelict.x, a.y - sim.derelict.y)) !== OUTSIDE) return fail('invalid_target');
      }
      for (const e of towing) {
        sim.queueDeorbit(e, intent.x, intent.y);
        sim.order(e, { k: 'none' });
      }
      return OK;
    }
    case 'vent': {
      const us = ownUnits(sim, team, role, intent.units, 'tow');
      if (typeof us === 'string') return fail(us);
      for (const e of us) if (sim.alive(e.link)?.kind !== 'core') return fail('not_held');
      for (const e of us) sim.order(e, { k: 'vent', until: sim.tick + sim.econ.coreVentTicks });
      return OK;
    }
    case 'release': {
      const us = ownUnits(sim, team, role, intent.units, 'tow');
      if (typeof us === 'string') return fail(us);
      const held = us.filter((e) => sim.alive(e.link) || e.miningTarget || e.order.k === 'mine_asteroid');
      if (held.length === 0) return fail('not_held');
      for (const e of held) {
        if (e.link) sim.releaseTow(e);
        if (e.order.k === 'vent' || e.order.k === 'mine_asteroid' || e.miningTarget) sim.order(e, NONE);
      }
      return OK;
    }
    case 'scan': {
      if (!sim.segmentAlive(team, 'orbit')) return fail('segment_destroyed');
      if (sim.tick < t.scanReadyAt) return fail('cooldown');
      if (!sim.canSpend(team, 0, sim.econ.scanCost, role)) return fail('cannot_afford');
      sim.scan(team, intent.x, intent.y);
      return OK;
    }
  }
}

/**
 * Attacking an island prioritizes its visible hostile hardpoint, then its main slot. Every selected unit that can
 * hit it attacks (the rest move under it). Nothing hostile on it: capture-capable Sky units capture it, the rest move onto it.
 */
function attackIsland(sim: Sim, team: Army, role: Plane, intent: Extract<AgentCommandIntent, { kind: 'attack' }>, isl: Ent): ApplyResult {
  const us = ownUnits(sim, team, role, intent.units, undefined, true);
  if (typeof us === 'string') return fail(us);
  const mount = sim.alive(isl.hardpoint);
  const slot = mount && sim.hostile(team, mount.side) && sim.sees(team, mount) ? mount : sim.alive(isl.link);
  const queue = intent.queue === true ? { queue: true } : {};
  const ids = (list: Ent[]): string[] => list.map((e) => `e_${e.id}`);
  let first: Ent[];
  let lead: AgentCommandIntent;
  if (slot && sim.hostile(team, slot.side) && sim.sees(team, slot)) {
    first = us.filter((e) => sim.canHit(e, slot.plane));
    lead = { kind: 'attack', units: ids(first), target: `e_${slot.id}`, ...queue };
  } else {
    first = us.filter((e) => e.plane === 'sky' && e.transitUntil <= 0 && sim.capable(e, 'capture'));
    lead = { kind: 'capture', units: ids(first), island: `e_${isl.id}`, ...queue };
  }
  const rest = us.filter((e) => !first.includes(e) && sim.stat(e).speed > 0);
  if (!first.length && !rest.length) return fail('invalid_target');
  if (first.length) {
    const r = applyIntent(sim, team, role, lead);
    if (!r.ok) return r;
  }
  return rest.length ? applyIntent(sim, team, role, { kind: 'move', units: ids(rest), x: clampPos(isl.x, sim.size), y: clampPos(isl.y, sim.size), mode: 'move', ...queue }) : OK;
}

/** `attack` on a forward post: own Surface units fight-move onto it (each to its own slot around it) and hold it. */
function holdPost(sim: Sim, team: Army, role: Plane, ids: string[], post: Ent, queue: boolean): ApplyResult {
  if (role !== 'surface') return fail('wrong_plane');
  const us = ownUnits(sim, team, role, ids);
  if (typeof us === 'string') return fail(us);
  const movers = us.filter((e) => e.plane === 'surface' && sim.stat(e).speed > 0);
  if (!movers.length) return fail('invalid_target');
  holdPostWith(sim, team, movers, post, queue);
  return OK;
}

function holdPostWith(sim: Sim, team: Army, us: Ent[], post: Ent, queue: boolean): void {
  const spots = spread(sim, team, 'surface', us, post.x, post.y);
  us.forEach((e, i) => sim.order(e, { k: 'move', x: spots[i]![0], y: spots[i]![1], fight: true, speed: 0 }, queue));
}

/**
 * `queue_add`: validate against what the team knows and the queue limits, then atomically check conditional
 * affordability and append. Ordinary entries still reserve future funding without needing today's resources.
 */
function queueAdd(sim: Sim, team: Army, role: Plane, intent: Extract<AgentCommandIntent, { kind: 'queue_add' }>, source: IntentSource): ApplyResult {
  const t = sim.armies[team]!;
  const known = t.group.known;
  const item = intent.item;
  // Production belongs to the output plane, even when its producer stands on another plane.
  if ((item === 'rebuild' ? intent.plane ?? role : sim.queueStats(item).plane) !== role) return fail('wrong_plane');
  const count = intent.count ?? 1;
  if (count > 1 && !isUnitKind(item)) return fail('invalid_target');
  let mine = 0, reserved = 0;
  for (const e of t.queue) if (e.plane === role) mine++;
  for (const plane of PLANES) {
    if (plane === role) continue;
    let entries = 0;
    for (const e of t.queue) if (e.plane === plane) entries++;
    reserved += Math.max(0, sim.econ.queueLaneSlots - entries);
  }
  if (t.queue.length + count > sim.econ.queueTeamMax - reserved || mine + count > sim.econ.queueSeatMax) return fail('queue_full');
  if (intent.producer !== undefined && item !== 'digger' && !isAircraft(item)) return fail('invalid_target');
  if (intent.plane !== undefined && item !== 'rebuild') return fail('invalid_target');
  if (item === 'rebuild') {
    // One rebuild in the queue at a time, and only while the army has rebuilds left (rules.spire.rebuilds).
    const plane = intent.plane ?? role;
    if (t.rebuilds >= sim.econ.rebuildsPerMatch || t.queue.some((e) => e.item === 'rebuild')) return fail('rebuild_used');
    if (sim.segmentAlive(team, plane)) return fail('segment_standing');
    return enqueue(sim, team, role, intent, { plane }, source);
  }
  if (isUpgrade(item)) {
    if (role !== UPGRADES[item].at) return fail('wrong_plane');
    if (!sim.segmentAlive(team, role)) return fail('segment_destroyed');
    if (!sim.researchEligible(team, item)) return fail('blocked');
    return enqueue(sim, team, role, intent, {}, source);
  }
  if (!sim.canBuild(team, item)) return fail('blocked');
  if (isUnitKind(item)) {
    const producer = intent.producer === undefined ? 0 : idNum(intent.producer);
    if (producer) {
      if (!sim.validProducer(team, producer, item)) return fail('invalid_target');
    } else if (!sim.segmentAlive(team, sim.stats[item].plane)) return fail('segment_destroyed');
    if (t.pop >= sim.econ.popCap) return fail('queue_full');
    return enqueue(sim, team, role, intent, { producer }, source);
  }
  // Structures not standing yet: unstarted entries, and bulkheads whose digger is still at work.
  let pending = 0;
  for (const e of t.queue) if (!isUnitKind(e.item) && !isUpgrade(e.item) && e.item !== 'rebuild' && (!e.started || e.item === 'bulkhead' || e.item === 'geothermal')) pending++;
  if (isIslandBuild(item)) {
    if (isBuildableHardpoint(item) && role !== 'sky') return fail('wrong_plane');
    if (isBuildableHardpoint(item) && sim.econ.islandHardpoints < 1) return fail('blocked');
    if (intent.island === undefined) return fail('invalid_target');
    const isl = sim.alive(idNum(intent.island));
    if (!isl || isl.kind !== 'island') return fail('invalid_target');
    if (isl.side !== team) return fail('not_held');
    if (item === 'ore_extractor' && isl.oreRemaining <= 0) return fail('invalid_target');
    const hardpoint = isBuildableHardpoint(item);
    const slot = hardpoint ? isl.hardpoint : isl.link;
    if ((slot && sim.alive(slot)) || (hardpoint && isl.state === 'capturing')
      || t.queue.some((e) => isIslandBuild(e.item) && isBuildableHardpoint(e.item) === hardpoint && e.island === isl.id)) return fail('occupied');
    if (item !== 'relay' && !sim.segmentAlive(team, 'sky')) return fail('segment_destroyed');
    if (t.structures + pending >= sim.econ.structureCap) return fail('queue_full');
    return enqueue(sim, team, role, intent, { x: isl.x, y: isl.y, island: isl.id }, source);
  }
  if (intent.x === undefined || intent.y === undefined) return fail('invalid_target');
  if (!Number.isInteger(intent.x) || !Number.isInteger(intent.y) || intent.x < 0 || intent.y < 0 || intent.x >= sim.size || intent.y >= sim.size) return fail('invalid_target');
  let c = intent.y * sim.size + intent.x;
  if (item === 'bulkhead' || item === 'geothermal') {
    if (item === 'geothermal') {
      // Known rock beside a located sealed pocket, clear of every depths footprint the team knows.
      if (!sim.tapSite(team, c)) return fail('invalid_target');
    } else {
      // A plain tunnel cell the team knows (not rail, no hole above, no bulkhead it knows of or has queued), next to one
      // it can stand on. The digger hint must be an own digger that can reach it; without one the queue picks the builder.
      if (known[c] !== CELL.tunnel || sim.holes[c]) return fail('invalid_target');
      const own = sim.bulkheadOn(c);
      if ((own && own.side === team) || knownEnemyBulkhead(sim, team, c)) return fail('occupied');
      for (const e of sim.ents) {
        if (!e.dead && e.structure && e.plane === 'depths' && (e.side === team || e.kind === 'spire' || sim.sees(team, e))
          && footprintOverlap('bulkhead', intent.x + 0.5, intent.y + 0.5, e.kind, e.x, e.y)) return fail('occupied');
      }
      for (const e of t.group.memory.values()) {
        if (e.plane === 'depths' && footprintOverlap('bulkhead', intent.x + 0.5, intent.y + 0.5, e.kind, e.x, e.y)) return fail('occupied');
      }
      if (t.queue.some((e) => e.item === 'bulkhead' && cellOf(e.x, e.y, sim.size) === c)) return fail('occupied');
    }
    const x = intent.x;
    const near = [x < sim.size - 1 ? c + 1 : -1, x > 0 ? c - 1 : -1, c + sim.size, c - sim.size].some((n) => n >= 0 && n < sim.n && isOpenCell(known[n]!) && adjacent4(n, c, sim.size));
    if (!near) return fail('not_adjacent');
    let digger = 0;
    if (intent.digger !== undefined) {
      const us = ownUnits(sim, team, 'depths', [intent.digger], 'build');
      if (typeof us === 'string') return fail(us);
      if (!reachable(sim, us[0]!, c, true)) return fail('no_path');
      digger = us[0]!.id;
    }
    if (t.structures + pending >= sim.econ.structureCap) return fail('queue_full');
    return enqueue(sim, team, role, intent, { x: intent.x + 0.5, y: intent.y + 0.5, digger }, source);
  }
  if (!sim.segmentAlive(team, 'surface')) return fail('segment_destroyed');
  if (item === 'drill_yard') {
    let yards = sim.drillYards(team);
    for (const e of t.queue) if (e.item === 'drill_yard' && !e.started) yards++;
    if (yards >= sim.econ.drillYardMax) return fail('queue_full');
  }
  let minX = intent.x;
  let minY = intent.y;
  const size = STATS[item].footprint;
  // Unknown lodes and empty ground have identical Headframe failures. Resolve only discovered pockets.
  if (item === 'headframe') {
    const lode = sim.lodes.find((l) => (l.known & t.group.bit) !== 0 && Math.abs(l.c % sim.size - minX) <= 1 && Math.abs(Math.floor(l.c / sim.size) - minY) <= 1);
    if (!lode) return fail('no_lode');
    minX = lode.c % sim.size - (size.w - 1) / 2;
    minY = Math.floor(lode.c / sim.size) - (size.h - 1) / 2;
  }
  if (minX < 0 || minY < 0 || minX + size.w > sim.size || minY + size.h > sim.size) return fail('blocked');
  const x = minX + size.w / 2;
  const y = minY + size.h / 2;
  // The build rule reads only own structures and public Spire positions, so it is judged before any fogged state.
  const radius = sim.buildSiteError(team, item, x, y);
  if (radius) return fail(radius);
  // Finish the visibility pass before consulting any hidden terrain, hole or occupancy state.
  for (let dy = 0; dy < size.h; dy++) for (let dx = 0; dx < size.w; dx++) {
    if (!(sim.vis[1]![(minY + dy) * sim.size + minX + dx]! & t.group.bit)) return fail('not_visible');
  }
  // One level: the footprint and its apron are all ground or all high, never straddling a cliff edge or ramp.
  if (surfaceSiteLevel(sim.terrain, sim.size, minX, minY, size.w, size.h) < 0) return fail('blocked');
  for (let dy = 0; dy < size.h; dy++) for (let dx = 0; dx < size.w; dx++) {
    c = (minY + dy) * sim.size + minX + dx;
    if (sim.block[c] || sim.holes[c]) return fail('blocked');
    // Bedrock the team knows of only: an error must never reveal hidden Depths terrain.
    if (item === 'shaft' && t.group.known[c] === CELL.bedrock) return fail('blocked');
    if (item !== 'headframe' && ((sim.lodes[sim.lodeAt[c]!]?.known ?? 0) & t.group.bit) !== 0) return fail('blocked');
  }
  if (sim.siteTaken(x, y, team, item)) return fail('occupied');
  for (const e of t.queue) {
    if (!e.started && e.plane === 'surface' && !isUnitKind(e.item) && !isUpgrade(e.item) && e.item !== 'rebuild'
      && footprintOverlap(item, x, y, e.item, e.x, e.y, STRUCTURE_SPACING)) return fail('occupied');
  }
  if (t.structures + pending >= sim.econ.structureCap) return fail('queue_full');
  return enqueue(sim, team, role, intent, { x, y }, source);
}

/**
 * Automatic reordering never crosses paid work, explicit orders, rebuilds or, while workers are short, a replacement
 * digger in its own lane; unrelated lanes never fence it.
 */
function automaticQueueIndex(sim: Sim, team: Army, role: Plane, requested: number, moving = -1): number {
  const recovering = role === 'depths' && sim.viableWorkers(team) < sim.econ.queueRecoveryWorkers;
  let index = 0, fence = 0;
  for (let i = 0; i < sim.armies[team]!.queue.length; i++) {
    if (i === moving) continue;
    const e = sim.armies[team]!.queue[i]!;
    if (e.plane === role && (e.started || e.source === 'owner' || e.source === 'agent' || e.item === 'rebuild' || recovering && e.item === 'digger')) fence = index + 1;
    index++;
  }
  return Math.max(requested, fence);
}

function enqueue(sim: Sim, team: Army, role: Plane, intent: Extract<AgentCommandIntent, { kind: 'queue_add' }>,
  site: Parameters<Sim['queueAdd']>[3], source: IntentSource): ApplyResult {
  const count = intent.count ?? 1;
  if (intent.ifAffordable && !sim.queueAffordable(team, role, intent.item, site.producer ?? 0, count)) return fail('cannot_afford');
  const index = intent.index === undefined ? undefined : source === 'owner'
    ? intent.index : automaticQueueIndex(sim, team, role, intent.index);
  for (let i = 0; i < count; i++) sim.queueAdd(team, role, intent.item, site, index === undefined ? undefined : index + i, source);
  return OK;
}

function units(sim: Sim, team: Army, plane: Plane, allowed?: readonly UnitKind[] | keyof Capabilities): Ent[] {
  return sim.ents.filter((e) => !e.dead && !e.hangar && !e.transitKind?.stationary && e.unit && e.side === team && e.plane === plane && e.built && e.transitUntil === 0 && (!allowed || (typeof allowed === 'string' ? sim.capable(e, allowed) : (allowed as readonly Kind[]).includes(e.kind))));
}

const COMBAT_SURFACE: readonly UnitKind[] = ['trooper', 'tank', 'flak', 'breacher'];

function applyMacro(sim: Sim, team: Army, role: Plane, action: Macro): ApplyResult {
  const home = sim.spireAt[team]!;
  switch (action) {
    case 'auto_mine': {
      if (role === 'depths') {
        for (const e of units(sim, team, 'depths', 'carry')) if (e.order.k === 'none') sim.order(e, { k: 'mine', ore: -1, exploring: false, near: -1, auto: true });
      } else if (role === 'orbit') {
        if (!sim.segmentAlive(team, 'orbit')) return fail('segment_destroyed');
        for (const e of units(sim, team, 'orbit', ['tug'])) {
          if (e.order.k !== 'none' || e.queue.length || e.link || e.miningTarget) continue;
          sim.order(e, { k: 'mine_asteroid', asteroid: 0, returning: e.cargoAlloy + e.cargoEnergy > 0, auto: true });
        }
      } else return fail('wrong_plane');
      return OK;
    }
    case 'guard_root': {
      if (role !== 'depths') return fail('wrong_plane');
      const goal = cellOfEnt(sim.armies[team]!.spire.depths, sim.size);
      const gx = cellCentreX(goal, sim.size);
      const gy = cellCentreY(goal, sim.size);
      // Each defender its own slot on the root's loading apron, not one pile on the solid root.
      const guards = units(sim, team, 'depths', ['trooper', 'tank', 'flak']).filter((e) => reachable(sim, e, goal, false));
      const spots = spread(sim, team, 'depths', guards, gx, gy);
      guards.forEach((e, i) => {
        const slot = cellFor(sim.armyFrame[team]!, spots[i]![0], spots[i]![1], sim.size);
        const [x, y] = slot === goal || reachable(sim, e, slot, false) ? spots[i]! : [gx, gy];
        sim.order(e, { k: 'move', x, y, fight: true, speed: 0 });
      });
      return OK;
    }
    case 'defend_spire': {
      if (role !== 'surface') return fail('wrong_plane');
      // Size-scaled slots ring the Spire footprint, each reachable from its unit.
      const army = units(sim, team, 'surface', COMBAT_SURFACE);
      const spots = spread(sim, team, 'surface', army, home.x, home.y);
      army.forEach((e, i) => {
        const [x, y] = sim.reachableNear(e, spots[i]![0], spots[i]![1]);
        sim.order(e, { k: 'move', x, y, fight: true, speed: 0 });
      });
      return OK;
    }
    case 'attack_nearest': {
      if (role !== 'surface' && role !== 'sky') return fail('wrong_plane');
      const army = units(sim, team, role, role === 'surface' ? COMBAT_SURFACE : undefined).filter((e) => sim.armed(e));
      for (const e of army) {
        let best: Ent | undefined;
        let bd = Infinity;
        for (const t of sim.ents) {
          if (t.dead || !sim.hostile(team, t.side) || isNeutralKind(t.kind)) continue;
          if (!sim.canHit(e, t.plane) || !sim.sees(team, t)) continue;
          const d = norm(t.x - e.x, t.y - e.y);
          if (d < bd) {
            bd = d;
            best = t;
          }
        }
        if (best) sim.order(e, { k: 'attack', target: best.id });
      }
      return OK;
    }
    case 'recapture': {
      if (role === 'surface') {
        // Each combat unit heads for the nearest forward post its alliance does not hold; each post's group spreads
        // around it (posts are public, so this reads nothing hidden).
        const posts = sim.posts.filter((p) => !isArmy(p.side) || sim.hostile(team, p.side));
        if (posts.length === 0) return OK;
        const groups = posts.map((): Ent[] => []);
        for (const e of units(sim, team, 'surface', COMBAT_SURFACE)) {
          let best = 0;
          let bd = Infinity;
          posts.forEach((p, i) => {
            const d = norm(p.x - e.x, p.y - e.y);
            if (d < bd) {
              bd = d;
              best = i;
            }
          });
          groups[best]!.push(e);
        }
        groups.forEach((group, i) => {
          if (group.length) holdPostWith(sim, team, group, posts[i]!, false);
        });
        return OK;
      }
      if (role !== 'sky') return fail('wrong_plane');
      const air = units(sim, team, 'sky', 'capture');
      const islands = sim.ents.filter((i) => i.kind === 'island' && i.side !== team);
      if (islands.length === 0) return OK;
      for (const e of air) {
        let best = islands[0]!;
        let bd = Infinity;
        for (const i of islands) {
          const d = norm(i.x - e.x, i.y - e.y);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        sim.order(e, { k: 'capture', island: best.id });
      }
      return OK;
    }
    case 'intercept': {
      if (role !== 'sky') return fail('wrong_plane');
      for (const e of units(sim, team, 'sky', ['interceptor'])) sim.order(e, { k: 'intercept' });
      return OK;
    }
    case 'harvest_core': {
      if (role !== 'orbit') return fail('wrong_plane');
      const g = sim.derelict;
      if (!g) return fail('invalid_target');
      const tugs = units(sim, team, 'orbit', 'tow');
      const core = sim.derelictCore();
      const holder = core && tugs.find((e) => e.link === core.id);
      // Back into the chamber to cool, out of reach of fire from outside (held at a sealed gate's mouth); its field goes off.
      if (holder) {
        sim.order(holder, { k: 'move', x: g.x, y: g.y, fight: false, speed: 0 });
        return OK;
      }
      const free = tugs.filter((e) => !e.link);
      if (!free.length) return fail('wrong_kind');
      const seen = !!core && sim.sees(team, core);
      if (seen && core.state !== 'idle') return fail('invalid_target');
      // The ruin's walls hide the core from outside but along an open gate's line: without sight of it the tug heads for the ruin centre to look.
      const at = seen ? core : g;
      let tug = free[0]!;
      for (const e of free) if (norm(e.x - at.x, e.y - at.y) < norm(tug.x - at.x, tug.y - at.y)) tug = e;
      sim.order(tug, seen ? { k: 'grapple', asteroid: core.id } : { k: 'move', x: g.x, y: g.y, fight: false, speed: 0 });
      return OK;
    }
    case 'spread_arrays': {
      if (role !== 'orbit') return fail('wrong_plane');
      const arrays = units(sim, team, 'orbit', ['solar']).filter(e => e.hp > 0);
      if (!arrays.length) return OK;
      const home = sim.armies[team]!.spire.orbit;
      if (home.dead || home.hp <= 0 || !home.built) return fail('invalid_target');
      spreadArrays(sim, team, arrays);
      return OK;
    }
    case 'haul_core': {
      if (role !== 'orbit') return fail('wrong_plane');
      const g = sim.derelict;
      const core = sim.derelictCore();
      const holder = g && core && units(sim, team, 'orbit', 'tow').find((e) => e.link === core.id);
      if (!g || !holder) return fail('not_held');
      // Home to the own Orbit segment: within dockRadius the core is cashed in. Venting and dropping stay explicit.
      const dock = sim.armies[team]!.spire.orbit;
      sim.order(holder, { k: 'move', x: dock.x, y: dock.y, fight: false, speed: 0 });
      return OK;
    }
  }
}
