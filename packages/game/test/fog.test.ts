/**
 * Property tests over random matches: fog never leaks unseen enemies, and everything that leaves the game
 * (observations, views, events, reports) validates against the manifest schemas.
 */
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import {
  CELL,
  DEFAULT_RULES,
  ECON,
  OBS_GRID,
  OPPONENTS,
  PLANES,
  STATS,
  SURFACE,
  isSurfaceHigh,
  surfaceFeature,
  TERRAIN_PRESETS,
  TRANSITS,
  isOpenCell,
  toTicks,
  eventSchema,
  observationSchema,
  reportSchema,
  viewSchema,
  type Entity,
  type Plane,
  type ArmyId,
  type View,
} from '../src/rules/contract.ts';
import { PLANE_INDEX, VISION_EVERY } from '../src/sim/constants.ts';
import { cellOf, cellOfEnt } from '../src/util/grid.ts';
import { type Ent, type Order } from '../src/sim/ent.ts';
import type { FxRec } from '../src/sim/state.ts';
import { type Sim } from '../src/sim/sim.ts';
import { Rng } from '../src/util/rng.ts';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { HOLE } from '../src/sim/constants.ts';
import { LODE_POCKET } from '../src/maps/world.ts';
import { entityOut } from '../src/agent/present.ts';
import { NEUTRAL, QUARTER_TURN, rotCell, slotOfArmyId } from '../src/util/teams.ts';
import { gridPosition } from '../src/util/math.ts';

/** Slack for cell-granular vision vs exact distances. */
const SLACK = 1.5;

/** What the oracle reads of a viewing body. */
type Viewer = Pick<Ent, 'dead' | 'side' | 'kind' | 'plane' | 'x' | 'y' | 'built' | 'cell' | 'frame'>;

/**
 * Independent oracle: could `team` possibly see a point on `plane`? Lenient by SLACK, but anything a leak would
 * expose (an enemy far from every own viewer) fails it. On the surface it models the terrain rules: units on high
 * ground see ECON.highVision further; high ground is seen only from high ground, from the sky or by a scan;
 * a unit in a forest also needs spotting (an own surface unit/structure close by, sky surface vision or a scan).
 * `cell` is the cell the point stands in: for an entity the rules' own (cellOfEnt), since a point exactly on a cell
 * border belongs to the cell its owner's frame resolves, not to whichever cell floor() picks. `viewers`: the bodies
 * whose sight counts (default the live world; Witnesses.stamp judges against the fog the sim stamped earlier).
 */
function inSight(sim: Sim, team: ArmyId, plane: Plane, x: number, y: number, unit = false, cell = cellOf(x, y, sim.size), viewers: readonly Viewer[] = sim.ents): boolean {
  const ground = plane === 'surface' ? sim.terrain[cell] : undefined;
  const high = ground !== undefined && isSurfaceHigh(ground);
  let seen = false;
  let spotted = !unit || ground === undefined || surfaceFeature(ground) !== SURFACE.forest;
  for (const v of viewers) {
    if (v.dead || v.side !== slotOfArmyId(team, 2) || v.kind === 'island' || v.kind === 'asteroid') continue;
    /** what `v` reveals on `plane`: range, whether it sees high ground, whether it spots forests */
    const eyes: { r: number; high: boolean; spot: boolean }[] = [];
    // A held forward post sees the Surface like high ground (over cliffs, onto plateaus) and spots like a unit there.
    if (v.kind === 'post') {
      if (plane === 'surface') eyes.push({ r: ECON.postVision, high: true, spot: false }, { r: ECON.forestSpot, high: false, spot: true });
    } else {
      const s = STATS[v.kind as keyof typeof STATS];
      const onHigh = v.plane === 'surface' && isSurfaceHigh(sim.terrain[cellOfEnt(v, sim.size)]!);
      if (v.plane === plane) eyes.push({ r: s.vision + (onHigh ? ECON.highVision : 0), high: plane !== 'surface' || onHigh, spot: false });
      if (plane === 'surface' && v.plane === 'surface') eyes.push({ r: ECON.forestSpot, high: false, spot: true });
      if (plane === 'sky' && (v.kind === 'flak' || v.kind === 'turret')) eyes.push({ r: s.vision, high: true, spot: false });
    }
    if (plane === 'surface' && v.kind === 'bomber') eyes.push({ r: 3, high: true, spot: true }, { r: 3, high: true, spot: false });
    if (plane === 'surface' && v.kind === 'relay' && v.built) eyes.push({ r: ECON.relaySurfaceVision, high: true, spot: true }, { r: ECON.relaySurfaceVision, high: true, spot: false });
    if (plane === 'depths' && (v.kind === 'shaft' || v.kind === 'headframe') && v.built) eyes.push({ r: 2, high: false, spot: false });
    for (const eye of eyes) {
      // Depths vision floods tunnels (4-connected steps) and shows the walls beside them (+2), positions are
      // anywhere inside their cells (+2).
      const reach = plane === 'depths' ? eye.r + 4 : eye.r + SLACK;
      const d = plane === 'depths' ? Math.abs(v.x - x) + Math.abs(v.y - y) : Math.hypot(v.x - x, v.y - y);
      if (d > reach) continue;
      if (eye.spot) spotted = true;
      else if (!high || eye.high) seen = true;
    }
  }
  // Orbital scans reveal every plane around their centre while active (and spot forests).
  for (const sc of sim.armies[slotOfArmyId(team, 2)]!.scans) {
    if (Math.hypot(sc.x - x, sc.y - y) > ECON.scanRadius + SLACK) continue;
    seen = true;
    spotted = true;
  }
  // A Warden flare lights the tunnel flood within flareRange of its cell for its side (Sim.flares is pruned at each
  // vision stamp, so every flare listed still lights the current stamp), walls beside it and positions in cells (+4).
  if (plane === 'depths') for (const f of sim.flares) {
    if (f.side !== slotOfArmyId(team, 2)) continue;
    if (Math.abs((f.c % sim.size) + 0.5 - x) + Math.abs(Math.floor(f.c / sim.size) + 0.5 - y) <= sim.econ.flareRange + 4) seen = true;
  }
  return seen && spotted;
}

/**
 * The Surface Spire segment senses a hostile Surface unit within its beam reach (range + the unit's body radius from
 * the footprint edge) past its sight disc, cliffs and forests, so a sieged tank never shells it unseen (DESIGN §2
 * Sieged tanks, §4.2 Siege).
 */
function spireSenses(sim: Sim, team: ArmyId, t: Ent): boolean {
  if (!t.unit || t.plane !== 'surface') return false;
  const f = STATS.spire.footprint!;
  for (const v of sim.ents) {
    if (v.dead || v.hp <= 0 || v.kind !== 'spire' || v.plane !== 'surface' || v.side !== slotOfArmyId(team, 2)) continue;
    const dx = Math.max(0, Math.abs(t.x - v.x) - f.w / 2);
    const dy = Math.max(0, Math.abs(t.y - v.y) - f.h / 2);
    if (Math.hypot(dx, dy) <= STATS.spire.range + t.radius + SLACK) return true;
  }
  return false;
}

function checkEntities(g: AgentCommandGame, team: ArmyId, entities: Entity[]): void {
  const sim = g.sim;
  const enemy = slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2);
  for (const e of entities) {
    const truth = sim.byId.get(sim.aliasTarget(slotOfArmyId(team, 2), Number(e.id.slice(2))));
    expect(truth, 'entity in output must exist').toBeDefined();
    const t = truth as Ent;
    // Agent positions are presented on the OBS_GRID binary grid, never on a cell edge (util/math gridPosition): a point
    // that rounds onto an edge moves one step back into the cell it lies in. So within one step, in the truth's cell.
    for (const [p, v] of [[e.x, t.x], [e.y, t.y]] as const) {
      expect(Math.abs(p - v)).toBeLessThanOrEqual(1 / OBS_GRID);
      if (v !== Math.floor(v)) expect(Math.floor(p), `${e.id} presented in another cell`).toBe(Math.floor(v));
    }
    expect(e.plane).toBe(t.plane);
    if (t.side === slotOfArmyId(team, 2) || t.kind === 'island') continue;
    // Forward posts are public with their holder (DESIGN §4.2); their capture is fogged like an island's: unseen and
    // not ours to capture, a post reads idle with no progress.
    if (t.kind === 'post') {
      if (t.capSide !== slotOfArmyId(team, 2) && !inSight(sim, team, 'surface', t.x, t.y)) {
        expect(e.state, `${team} reads hidden post ${e.id}'s capture`).toBe('idle');
        expect(e.progress).toBeUndefined();
      }
      continue;
    }
    if (t.kind === 'asteroid' && t.state === 'falling') continue;
    // A telegraphed transit advertises its column to observers of either endpoint, not globally.
    const transit = t.transitKind;
    const transitTelegraph = t.transitAt > sim.tick && transit !== undefined && transit.telegraph !== 'none' &&
      (inSight(sim, team, transit.from, t.x, t.y, t.unit, cellOfEnt(t, sim.size)) || inSight(sim, team, transit.to, t.x, t.y, t.unit, cellOfEnt(t, sim.size)));
    // Structure visibility is witnessed by an occupied cell, not necessarily by the stored centre. What stands in an
    // island's slot is public with its island (a storm may still hide it, which only hides more).
    let seen = (t.structure && t.plane === 'sky' && sim.byId.get(t.link)?.kind === 'island') || spireSenses(sim, team, t) || inSight(sim, team, t.plane, t.x, t.y, t.unit, cellOfEnt(t, sim.size));
    const footprint = t.structure ? STATS[t.kind as keyof typeof STATS].footprint : undefined;
    if (footprint) for (let y = Math.floor(t.y - footprint.h / 2); y < Math.ceil(t.y + footprint.h / 2); y++) {
      for (let x = Math.floor(t.x - footprint.w / 2); x < Math.ceil(t.x + footprint.w / 2); x++) seen ||= inSight(sim, team, t.plane, x + 0.5, y + 0.5, false);
    }
    expect(seen || transitTelegraph, `${team} sees ${t.kind} ${e.id} on ${t.plane} at ${t.x.toFixed(1)},${t.y.toFixed(1)}`).toBe(true);
    if (t.side === enemy) {
      expect(e.tx, 'enemy destinations are hidden').toBeUndefined();
      expect(e.ty).toBeUndefined();
      expect(e.work, 'enemy task targets are hidden').toBeUndefined();
      if (t.kind === 'spire') expect(e.carry, 'enemy production is hidden').toBeUndefined();
    }
  }
}

describe('transit visibility oracle', () => {
  it('accepts an advertised airdrop column from Surface sight without granting global Sky sight', () => {
    const g = createGame({ seed: 7, options: { terrain: 'open', sky: { stormRadius: 0, fogRadius: 0 } } });
    for (const e of g.sim.ents) if (e.unit) e.dead = true;
    const trooper = g.sim.add('trooper', slotOfArmyId('nw', 2), 'sky', 24, 24);
    const observer = g.sim.add('trooper', slotOfArmyId('se', 2), 'surface', 24, 25);
    g.sim.startTransit(trooper, TRANSITS.airdrop);
    g.sim['computeVision']();
    expect(inSight(g.sim, 'se', 'sky', trooper.x, trooper.y, true)).toBe(false);
    expect(inSight(g.sim, 'se', 'surface', trooper.x, trooper.y, true)).toBe(true);
    expect(g.sim.sees(slotOfArmyId('se', 2), trooper)).toBe(true);
    checkEntities(g, 'se', g.view('se').entities);
    trooper.transitKind = { ...TRANSITS.airdrop, telegraph: 'none' };
    expect(g.sim.sees(slotOfArmyId('se', 2), trooper)).toBe(false);
    trooper.transitKind = TRANSITS.airdrop;
    observer.dead = true;
    g.sim['computeVision']();
    expect(g.sim.sees(slotOfArmyId('se', 2), trooper)).toBe(false);
  });
});

describe('units exactly on a cell corner', () => {
  // Seed 85398 (canyons): an se tank parked at (33, 33), the corner of a forest cell and its own frame's ground cell
  // (32, 32). The rules put it in the ground cell (cover, speed and sight alike); the oracle used floor()'s forest cell.
  for (const team of (['nw', 'se'] as const)) {
    it(`${team}: the enemy's own frame decides its cell for forest cover, in the sim and the oracle alike`, () => {
      for (const ownForest of [false, true]) {
        const g = createGame({ seed: 7, options: { terrain: 'open', sky: { stormRadius: 0, fogRadius: 0 } } });
        const s = g.sim;
        for (const e of s.ents) if (e.unit) e.dead = true;
        const foe = team === 'nw' ? 'se' : 'nw';
        const corner = team === 'nw' ? 33 : s.size - 33;
        const tank = s.add('tank', slotOfArmyId(foe, 2), 'surface', corner, corner);
        tank.stance = 'hold';
        const own = cellOfEnt(tank, s.size);
        for (let y = corner - 8; y < corner + 8; y++) for (let x = corner - 8; x < corner + 8; x++) s.terrain[y * s.size + x] = SURFACE.ground;
        for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
          const c = (corner + dy) * s.size + corner + dx;
          s.terrain[c] = (c === own) === ownForest ? SURFACE.forest : SURFACE.ground;
        }
        // In sight (vision 6) but beyond forest spotting (ECON.forestSpot).
        s.add('trooper', slotOfArmyId(team, 2), 'surface', corner + (team === 'nw' ? -5 : 5), corner).stance = 'hold';
        s.computeVision();
        expect(s.sees(slotOfArmyId(team, 2), tank), `own cell forest ${ownForest}`).toBe(!ownForest);
        expect(inSight(s, team, 'surface', tank.x, tank.y, true, cellOfEnt(tank, s.size))).toBe(!ownForest);
        checkEntities(g, team, g.view(team).entities);
      }
    });
  }
});

describe('others see a Depths worker face its visible work cell', () => {
  const games: [string, () => AgentCommandGame][] = [
    ['C2', () => createGame({ seed: 3 })],
    ['C4', () => new AgentCommandGame(5, { map: { name: 'four_corners' } })],
  ];
  for (const [layout, make] of games) it(`${layout}: enemy and observer heading points at the worked cell only while seen; owner unchanged`, () => {
    const g = make();
    const s = g.sim, size = s.size, depths = s.vis[PLANE_INDEX.depths]!;
    for (const id of s.armyIds) {
      const a = s.armyIndex(id);
      const k = s.armyFrame[a]!;
      const at = rotCell(k, cellOf(10, 8, size), size), ore = rotCell(k, cellOf(11, 8, size), size);
      const e = s.spawnUnit(a, 'digger', 'depths');
      e.x = (at % size) + 0.5;
      e.y = Math.floor(at / size) + 0.5;
      e.cell = at;
      e.path = null;
      e.state = 'mining';
      e.order = { k: 'mine', ore, near: -1, exploring: false };
      const facing = Math.round(k * QUARTER_TURN * 100) / 100;
      expect(entityOut(s, e, 'observer').heading, id).toBe(facing);
      expect(entityOut(s, e, id).heading, id).toBeUndefined();
      expect(entityOut(s, e, id).work, id).toEqual({ x: (ore % size) + 0.5, y: Math.floor(ore / size) + 0.5 });
      for (const other of s.armyIds) {
        if (other === id) continue;
        // As if `other` had seen the digger before: only a named entity is presented (sim/aliases.ts).
        s.giveAlias(s.armyIndex(other), e.id);
        const bit = s.armies[s.armyIndex(other)]!.group.bit;
        const saved = depths[ore]!;
        depths[ore] = saved | bit;
        expect(entityOut(s, e, other).heading, `${other} sees ${id}`).toBe(facing);
        expect(entityOut(s, e, other).work).toBeUndefined();
        depths[ore] = saved & ~bit;
        expect(entityOut(s, e, other).heading, `${other} blind to ${id}`).toBeUndefined();
        depths[ore] = saved;
      }
      e.hp = 0;
    }
  });
});

describe('own-only current work targets', () => {
  for (const team of (['nw', 'se'] as const)) {
    const enemy = team === 'nw' ? 'se' : 'nw';
    it(`${team} exposes the worked cell rather than the route's final destination`, () => {
      const g = createGame({ seed: 3 });
      const e = g.sim.spawnUnit(slotOfArmyId(team, 2), 'digger', 'depths');
      const size = g.sim.size;
      const near = team === 'nw' ? cellOf(10, 8, size) : cellOf(37, 39, size);
      const far = team === 'nw' ? cellOf(20, 8, size) : cellOf(27, 39, size);
      e.path = [near, far];
      e.pathI = 0;
      const tasks: { state: Ent['state']; order: Order; cell: number }[] = [
        { state: 'digging', order: { k: 'dig', c: far }, cell: near },
        { state: 'mining', order: { k: 'mine', ore: near, near: -1, exploring: false }, cell: near },
        { state: 'fortifying', order: { k: 'fortify', c: near, working: true }, cell: near },
        { state: 'laying', order: { k: 'rail', c: far }, cell: cellOfEnt(e, size) },
        { state: 'bridging', order: { k: 'bridge', c: near, working: true }, cell: near },
        { state: 'constructing', order: { k: 'bulkhead', c: near, working: true, entry: 1 }, cell: near },
        { state: 'undermining', order: { k: 'undermine', c: near, at: 100 }, cell: near },
      ];
      for (const task of tasks) {
        e.state = task.state;
        e.order = task.order;
        expect(entityOut(g.sim, e, team).work, task.state).toEqual({ x: task.cell % size + 0.5, y: Math.floor(task.cell / size) + 0.5 });
        // As if the enemy had seen it once (only a named entity is presented, sim/aliases.ts): the work stays hidden.
        g.sim.giveAlias(slotOfArmyId(enemy, 2), e.id);
        expect(entityOut(g.sim, e, enemy).work, task.state).toBeUndefined();
        // Working in place with the last path step left is not travel: no stale route bearing overrides the work point.
        if (task.state !== 'laying') expect(entityOut(g.sim, e, team).heading, task.state).toBeUndefined();
      }
      e.state = 'digging';
      e.order = { k: 'mine', ore: -1, near: -1, exploring: false, auto: true };
      e.designation = far;
      expect(entityOut(g.sim, e, team).work).toEqual({ x: near % size + 0.5, y: Math.floor(near / size) + 0.5 });
      e.state = 'hauling';
      expect(entityOut(g.sim, e, team).work).toBeUndefined();
    });

    it(`${team} diggers at the Mother Lode expose the lode cell as work, with no travel heading`, () => {
      const g = createGame({ seed: 3, options: { terrain: 'open' } });
      const s = g.sim;
      for (const u of s.ents) if (u.kind !== 'spire' && u.kind !== 'island') u.hp = 0;
      for (let i = 0; i < VISION_EVERY; i++) g.step();
      const nw = team === 'nw';
      const lode = nw ? s.motherCells[0]! : s.n - 1 - s.motherCells[0]!;
      const from = nw ? lode - 3 * s.size - 2 : lode + 3 * s.size + 2;
      const e = s.spawnUnit(slotOfArmyId(team, 2), 'digger', 'depths');
      e.x = (from % s.size) + 0.5;
      e.y = Math.floor(from / s.size) + 0.5;
      e.cell = from;
      g.apply({ team, role: 'depths' }, { kind: 'mine', units: [g.entityId(team, e.id)], x: (lode % s.size) + 0.5, y: Math.floor(lode / s.size) + 0.5 });
      for (let i = 0; i < toTicks(3) && e.state !== 'mining'; i++) g.step();
      expect(e.state).toBe('mining');
      const out = entityOut(s, e, team);
      expect(out.work).toEqual({ x: (lode % s.size) + 0.5, y: Math.floor(lode / s.size) + 0.5 });
      expect(out.heading).toBeUndefined();
      s.giveAlias(slotOfArmyId(enemy, 2), e.id);
      expect(entityOut(s, e, enemy).work).toBeUndefined();
    });

    it(`${team} exposes only visible task entities, never an unseen engagement target`, () => {
      const g = createGame({ seed: 3 });
      const unit = g.sim.spawnUnit(slotOfArmyId(team, 2), 'tug', 'orbit');
      const rock = g.sim.add('asteroid', NEUTRAL, 'orbit', 24, 24);
      g.sim.scan(slotOfArmyId(team, 2), 24, 24);
      unit.state = 'grappling';
      unit.order = { k: 'grapple', asteroid: rock.id };
      expect(entityOut(g.sim, unit, team).work).toEqual({ x: 24, y: 24 });
      unit.state = 'towing';
      unit.link = rock.id;
      unit.order = { k: 'none' };
      expect(entityOut(g.sim, unit, team).work).toEqual({ x: 24, y: 24 });
      const island = g.sim.ents.find((e) => e.kind === 'island')!;
      unit.state = 'capturing';
      unit.order = { k: 'capture', island: island.id };
      expect(entityOut(g.sim, unit, team).work).toEqual({ x: gridPosition(island.x, OBS_GRID, g.sim.size), y: gridPosition(island.y, OBS_GRID, g.sim.size) });
      const target = g.sim.add('solar', slotOfArmyId(enemy, 2), 'orbit', 24, 24);
      unit.state = 'attacking';
      unit.engage = target.id;
      expect(entityOut(g.sim, unit, team).work).toEqual({ x: 24, y: 24 });
      const own = g.sim.armies[slotOfArmyId(team, 2)]!;
      own.scans.length = 0;
      const orbit = g.sim.vis[PLANE_INDEX.orbit]!;
      for (let c = 0; c < orbit.length; c++) orbit[c]! &= ~own.group.bit;
      expect(entityOut(g.sim, unit, team).work).toBeUndefined();
      g.sim.giveAlias(slotOfArmyId(enemy, 2), unit.id);
      expect(entityOut(g.sim, unit, enemy).work).toBeUndefined();
    });
  }
});

describe('development-only authoritative order targets', () => {
  it('reports current and queued attack ids without adding them to player entities', () => {
    const g = createGame({ seed: 3 });
    const unit = g.sim.add('bomber', slotOfArmyId('nw', 2), 'sky', 24, 24);
    const first = g.sim.add('tank', slotOfArmyId('se', 2), 'surface', 24, 24);
    const second = g.sim.add('tank', slotOfArmyId('se', 2), 'surface', 25, 24);
    unit.order = { k: 'attack', target: first.id };
    unit.queue = [{ k: 'attack', target: second.id }, { k: 'move', x: 26, y: 24, fight: false, speed: 0 }];
    const debug = g.debugView({ plane: 'sky', detail: 'entities' });
    const entities = debug.entities as Record<string, unknown>[];
    expect(entities.find((e) => e.id === `e_${unit.id}`)).toMatchObject({
      order: 'attack',
      target: `e_${first.id}`,
      queue: [{ order: 'attack', target: `e_${second.id}` }, { order: 'move' }],
    });
    expect(g.debugView({ plane: 'surface', detail: 'entities' }).entities).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: `e_${unit.id}` })]));
    expect(g.debugView({ detail: 'summary' })).not.toHaveProperty('entities');
    for (const team of (['nw', 'se'] as const)) {
      // se never saw the bomber; name it as if it had, so its presentation is checked too.
      g.sim.giveAlias(slotOfArmyId(team, 2), unit.id);
      const entity = entityOut(g.sim, unit, team);
      expect(entity).not.toHaveProperty('target');
      expect(entity).not.toHaveProperty('order');
      expect(entity.queue).toBe(team === 'nw' ? 2 : undefined);
    }
  });
});

function checkDepths(g: AgentCommandGame, team: ArmyId, depths: number[]): void {
  // Knowledge is never better than reality for cells the team can currently see.
  const bit = g.sim.armies[slotOfArmyId(team, 2)]!.group.bit;
  const vis = g.sim.vis[0]!;
  for (let c = 0; c < g.sim.size * g.sim.size; c++) {
    // (A hidden magma pocket a scan located shows as magma until it breaks.)
    if (vis[c]! & bit && !(depths[c] === CELL.magma && g.sim.magma[c])) expect(depths[c]).toBe(g.sim.cells[c]);
  }
}

const PUBLIC_FX = new Set(['collapse', 'impact', 'intercept', 'deorbit', 'breach', 'defuse', 'chasm', 'breakout', 'bridge']);

/**
 * Oracle verdicts taken when an effect with an event-time audience (FxRec.viewers: mining, detonations, burns) happened.
 * The sim freezes who saw it then, so it stays shown to a team whose witness has since died or moved off, and sight
 * gained later never reveals it. An event mid-step reads the fog stamped at the last vision tick (VISION_EVERY), so a
 * witness counts if it saw the spot then or sees it now. Filled every tick by `witness`.
 */
interface Witnesses {
  /** the teams the oracle lets see each live effect with an event-time audience */
  verdicts: Map<FxRec['fx'], Set<ArmyId>>;
  /** the viewing bodies at the last vision tick */
  stamp: Viewer[];
}

function witness(g: AgentCommandGame, seen: Witnesses): void {
  const sim = g.sim;
  const live = new Set<FxRec['fx']>();
  for (const r of sim.fx) {
    live.add(r.fx);
    if (r.viewers === undefined || seen.verdicts.has(r.fx)) continue;
    const teams = new Set<ArmyId>();
    for (const team of (['nw', 'se'] as const)) {
      const { plane, x, y } = r.fx;
      if (inSight(sim, team, plane, x, y, true) || inSight(sim, team, plane, x, y, true, cellOf(x, y, sim.size), seen.stamp)) teams.add(team);
    }
    seen.verdicts.set(r.fx, teams);
  }
  for (const fx of seen.verdicts.keys()) if (!live.has(fx)) seen.verdicts.delete(fx);
  if (g.tick % VISION_EVERY === 0) {
    seen.stamp = sim.ents.filter((e) => !e.dead).map(({ dead, side, kind, plane, x, y, built, cell, frame }) => ({ dead, side, kind, plane, x, y, built, cell, frame }));
  }
}

/** Did the oracle see presented effect `f` happen (same tick, kind and plane; position within one OBS_GRID step)? */
function witnessed(seen: Witnesses, team: ArmyId, f: View['fx'][number]): boolean {
  for (const [w, teams] of seen.verdicts) {
    if (teams.has(team) && w.tick === f.tick && w.kind === f.kind && w.plane === f.plane && Math.abs(w.x - f.x) <= 1 / OBS_GRID && Math.abs(w.y - f.y) <= 1 / OBS_GRID) return true;
  }
  return false;
}

/** fx, ghosts, tremors and vision bits must not leak positions the team cannot see. */
function checkExtras(g: AgentCommandGame, team: ArmyId, view: View, seen: Witnesses): void {
  const sim = g.sim;
  const army = slotOfArmyId(team, 2);
  const bit = sim.armies[army]!.group.bit;
  for (const f of view.fx) {
    if (PUBLIC_FX.has(f.kind) || f.side === undefined || f.side === team) continue;
    // Anything an enemy does inside a forest (a shot, a death) needs spotting like a unit standing there.
    expect(inSight(sim, team, f.plane, f.x, f.y, true) || witnessed(seen, team, f), `${team} fx ${f.kind} at ${f.x},${f.y} on ${f.plane}`).toBe(true);
    if (f.src) expect(f.subject).toBeDefined();
  }
  for (const m of view.memory) {
    expect(m.side).not.toBe(team);
    const e = sim.alive(sim.aliasTarget(army, Number(m.id.slice(2))));
    if (e) expect(sim.sees(army, e)).toBe(false);
  }
  const feelR = ECON.tremorRadius + SLACK;
  for (const tr of view.tremors) {
    const under = sim.ents.some((e) => !e.dead && e.plane === 'depths' && e.side !== army && cellOfEnt(e, sim.size) === tr.y * sim.size + tr.x);
    expect(under).toBe(true);
    const above = sim.ents.some((e) => !e.dead && e.side === army && e.plane === 'surface' && Math.hypot(e.x - tr.x - 0.5, e.y - tr.y - 0.5) <= feelR);
    // Breaches in progress are also felt where the team has surface vision.
    expect(above || (tr.breach === true && (sim.vis[PLANE_INDEX.surface]![tr.y * sim.size + tr.x]! & bit) !== 0)).toBe(true);
  }
  const vis = sim.vis;
  PLANES.forEach((plane, p) => {
    const bits = view.vision[plane];
    for (let c = 0; c < sim.size * sim.size; c += 5) expect(((bits[(c / 30) | 0]! >>> c % 30) & 1) === 1).toBe((vis[p]![c]! & bit) !== 0);
  });
}

function checkAll(g: AgentCommandGame, since: Record<'nw' | 'se', number>, seen: Witnesses): void {
  for (const team of (['nw', 'se'] as const)) {
    const view = g.view(team);
    const vr = validate(viewSchema, view);
    expect(vr.ok ? true : vr).toBe(true);
    checkEntities(g, team, view.entities);
    checkDepths(g, team, view.depths);
    checkExtras(g, team, view, seen);
    for (const role of PLANES) {
      // Game code (bots) reads every plane in full: the whole Depths grid for every role.
      const obs = g.observe({ team, role }, since[team]);
      const r = validate(observationSchema, obs);
      expect(r.ok ? true : r).toBe(true);
      expect(obs.depths).toBeDefined();
      checkEntities(g, team, obs.entities);
      // A seat's own scope (what agents get by default): its plane in full, Depths knowledge only for the Depths seat.
      const scoped = g.observe({ team, role }, since[team], [role]);
      const sr = validate(observationSchema, scoped);
      expect(sr.ok ? true : sr).toBe(true);
      expect(scoped.depths !== undefined || scoped.depthsChanges !== undefined).toBe(role === 'depths');
      expect(scoped.entities.every((e) => e.plane === role)).toBe(true);
      checkEntities(g, team, scoped.entities);
      for (const ev of g.events({ team, role }, since[team])) {
        const er = validate(eventSchema, ev);
        expect(er.ok ? true : er).toBe(true);
      }
    }
    const rep = validate(reportSchema, g.report(team));
    expect(rep.ok ? true : rep).toBe(true);
    since[team] = g.tick;
  }
}

describe('fog and outbound schemas (property test over random matches × terrain presets)', () => {
  const rng = new Rng(61102);
  const tiers = OPPONENTS.filter((o) => o !== 'idle');
  const cases = Array.from({ length: 6 }, (_, i) => ({
    seed: 1000 + rng.int(100000),
    terrain: TERRAIN_PRESETS[i % TERRAIN_PRESETS.length]!,
    nw: tiers[rng.int(tiers.length)]!,
    se: tiers[(i + rng.int(tiers.length)) % tiers.length]!,
    every: VISION_EVERY * (31 + rng.int(40)), // check on vision ticks (fog refreshes every VISION_EVERY ticks)
  }));

  // Full bot matches: the serial timing set (pnpm test:timing).
  for (const c of cases) {
    it(`seed ${c.seed} (${c.terrain}): ${c.nw} vs ${c.se}`, { tags: ['timing'], timeout: 120_000 }, () => {
      const since: Record<'nw' | 'se', number> = { nw: 0, se: 0 };
      const seen: Witnesses = { verdicts: new Map(), stamp: [] };
      let checks = 0;
      const onCheck = (g: AgentCommandGame): void => {
        witness(g, seen);
        if (g.tick % c.every !== 0) return;
        checkAll(g, since, seen);
        checks++;
      };
      const { game, ticks } = playBotMatch({ seed: c.seed, levels: { nw: c.nw, se: c.se }, maxTicks: toTicks(600), onTick: onCheck, options: { terrain: c.terrain } });
      checkAll(game, since, seen);
      expect(checks).toBeGreaterThan(ticks / c.every - 2);
    });
  }

  it('at the start each team knows only its own pocket, its half of the caverns and the shared centre, and sees no enemy', () => {
    const { game } = playBotMatch({ seed: 42, levels: { nw: 'idle', se: 'idle' }, maxTicks: 1 });
    for (const team of (['nw', 'se'] as const)) {
      const view = game.view(team);
      const home = team === 'nw' ? { x: 8, y: 8 } : { x: 40, y: 40 };
      const foe = team === 'nw' ? { x: 40, y: 40 } : { x: 8, y: 8 };
      const size = game.sim.size;
      const dist = (p: { x: number; y: number }, c: number): number => Math.hypot((c % size) + 0.5 - p.x, Math.floor(c / size) + 0.5 - p.y);
      // Green rich ore is public (map.richOre.knownAtStart): every army knows every slot's from the start.
      view.depths.forEach((v, c) => {
        if (v !== 0 && v !== CELL.rich) expect(dist(home, c)).toBeLessThanOrEqual(dist(foe, c) + 6);
      });
      expect(view.depths[(size / 2) * size + size / 2]).not.toBe(0);
      // Islands and forward posts are public.
      expect(view.entities.filter((e) => e.side !== team && e.kind !== 'island' && e.kind !== 'post')).toEqual([]);
    }
  });
});

/**
 * Twin worlds: what a team cannot know is changed in a copy of the match (enemy tunnels it never saw filled with rock,
 * enemy structures it neither sees nor remembers removed, magma floods it never saw gone). Its observations (schedule
 * included) and the result code of every intent it sends must then be the same in both worlds.
 */
describe('nothing hidden shapes what a team is told (twin worlds)', () => {
  const hide = (g: AgentCommandGame, team: ArmyId): void => {
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    const t = s.armies[army]!.group;
    for (let c = 0; c < s.size * s.size; c++) if (t.known[c] === CELL.unknown && isOpenCell(s.cells[c]!) && !s.holes[c]) s.cells[c] = CELL.rock;
    // Neither undiscovered outcrop positions nor unseen seal changes may escape through a view or an intent.
    for (let c = 0; c < s.size * s.size; c++) if (t.known[c] === CELL.unknown) s.work[c] = 0;
    for (const l of s.lodes) {
      if ((s.vis[1]![l.c]! & t.bit) === 0) l.open = !l.open;
      if ((l.known & t.bit) === 0) {
        for (const c of s.lodeCells(l.c, LODE_POCKET)) s.lodeAt[c] = -1;
        l.c = (l.c + 17) % (s.size * s.size);
        l.loads += 1;
        l.rich = !l.rich;
      }
    }
    for (const e of s.ents) if (e.side !== army && e.structure && e.kind !== 'spire' && !s.sees(army, e) && !t.memory.has(e.id)) e.dead = true;
    s.floods = s.floods.filter((f) => f.knownAt[t.id]! >= 0);
  };

  const sameOutput = (a: AgentCommandGame, b: AgentCommandGame, team: ArmyId): void => {
    expect(JSON.stringify(b.view(team)), `${team} view`).toBe(JSON.stringify(a.view(team)));
    for (const role of PLANES) expect(JSON.stringify(b.observe({ team, role }, 0)), `${team} ${role} observation`).toBe(JSON.stringify(a.observe({ team, role }, 0)));
    expect(b.sim.armies[slotOfArmyId(team, 2)]!.group.pocketKnown).toEqual(a.sim.armies[slotOfArmyId(team, 2)]!.group.pocketKnown);
    expect(b.sim.armies[slotOfArmyId(team, 2)]!.group.gateKnown).toEqual(a.sim.armies[slotOfArmyId(team, 2)]!.group.gateKnown);
  };

  for (const team of (['nw', 'se'] as const)) {
    const army = slotOfArmyId(team, 2);
    const enemy = slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2);
    /** `team`'s vision group in `g` (its fog: known cells, cracks, memory). */
    const fog = (g: AgentCommandGame) => g.sim.armies[army]!.group;
    const sees = (g: AgentCommandGame, plane: number, c: number): boolean => (g.sim.vis[plane]![c]! & fog(g).bit) !== 0;
    const c = 24 * DEFAULT_RULES.map.size + 24;
    const fixture = (): AgentCommandGame => {
      const g = createGame({ seed: 42 });
      // A previously surveyed, now hidden patch, well away from either base.
      for (let y = 19; y <= 29; y++) for (let x = 19; x <= 29; x++) {
        const n = y * g.sim.size + x;
        g.sim.cells[n] = CELL.rock;
        g.sim.magma[n] = 0;
        fog(g).known[n] = CELL.rock;
      }
      g.sim['computeVision']();
      expect(sees(g, 0, c)).toBe(false);
      return g;
    };

    for (const activity of ['cracks', 'digging', 'fortify', 'rail', 'magma', 'bulkhead', 'collapse'] as const) {
      it(`${team}: hidden ${activity} preserves last-seen Depths in both outputs`, () => {
        const a = fixture();
        const b = fixture();
        for (const g of [a, b]) {
          fog(g).cracks[c] = 1;
          g.sim.work[c] = g.sim.econ.digRock / 4;
          if (activity === 'rail' || activity === 'bulkhead') {
            g.sim.cells[c] = CELL.tunnel;
            fog(g).known[c] = CELL.tunnel;
            fog(g).cracks[c] = 0;
          }
          if (activity === 'magma') {
            g.sim.magma[c] = 99;
            fog(g).pocketKnown[c] = 1;
            fog(g).known[c] = CELL.magma;
          }
          if (activity === 'bulkhead') {
            const gate = g.sim.placeBulkhead(enemy, c);
            fog(g).memory.set(gate.id, { kind: gate.kind, side: enemy, plane: 'depths', x: gate.x, y: gate.y, seen: 0 });
          }
        }
        if (activity === 'cracks') b.sim.work[c] = b.sim.econ.digRock * .75;
        if (activity === 'digging') b.sim.cells[c] = CELL.tunnel;
        if (activity === 'fortify') {
          b.sim.cells[c] = CELL.fortified;
          b.sim.work[c] = 0;
        }
        if (activity === 'rail') b.sim.cells[c] = CELL.rail;
        if (activity === 'magma') b.sim['breakPocket'](c, enemy);
        if (activity === 'bulkhead') b.sim['kill'](b.sim.bulkheadOn(c)!);
        if (activity === 'collapse') {
          // Both see the same public hole; only the hidden flood beyond it differs.
          for (const g of [a, b]) g.sim.openCells([c + 3], HOLE.sinkhole, enemy);
          b.sim.cells[c] = CELL.magma;
          b.sim.work[c] = 0;
        }
        for (const g of [a, b]) g.sim['computeVision']();
        sameOutput(a, b, team);
      });
    }

    it(`${team}: fogged damage and terrain refresh only when vision returns`, () => {
      const g = fixture();
      const t = fog(g);
      const own = g.sim.armies[army]!;
      t.cracks[c] = 1;
      g.sim.work[c] = g.sim.econ.digRock * .75;
      g.sim['computeVision']();
      expect(t.cracks[c]).toBe(1);
      g.sim.scan(army, 24.5, 24.5);
      expect(t.cracks[c]).toBe(3);
      own.scans.length = 0;
      g.sim['computeVision']();
      g.sim.cells[c] = CELL.tunnel;
      g.sim.work[c] = 0;
      g.sim['computeVision']();
      expect(t.known[c]).toBe(CELL.rock);
      expect(t.cracks[c]).toBe(3);
      g.sim.scan(army, 24.5, 24.5);
      expect(t.known[c]).toBe(CELL.tunnel);
      expect(t.cracks[c]).toBe(0);
    });

    it(`${team}: public holes reveal only their footprint, not a pocket's hidden extent or cooling`, () => {
      const a = fixture();
      const b = fixture();
      for (const g of [a, b]) {
        g.sim.magma[c] = g.sim.magma[c + 1] = 99;
        fog(g).pocketKnown[c + 1] = 1;
        fog(g).known[c + 1] = CELL.magma;
        g.sim.openCells([c], HOLE.sinkhole, enemy);
        expect(fog(g).known[c]).toBe(CELL.magma);
        expect(fog(g).pocketKnown[c + 1]).toBe(1);
        g.sim['computeVision']();
      }
      // The public breakout is identical, but an unseen tunnel carries one flood further.
      b.sim.cells[c + 1] = CELL.tunnel;
      for (const g of [a, b]) {
        g.sim.tick = g.sim.floods[0]!.nextAt;
        g.sim['updateFloods']();
        g.sim['computeVision']();
      }
      sameOutput(a, b, team);
      for (const g of [a, b]) {
        g.sim.tick = g.sim.floods[0]!.coolAt;
        g.sim['updateFloods']();
        g.sim['computeVision']();
        expect(fog(g).known[c + 1]).toBe(CELL.magma);
      }
      sameOutput(a, b, team);
      b.sim.scan(army, 25.5, 24.5);
      expect(fog(b).pocketKnown[c + 1]).toBe(0);
      expect(fog(b).known[c + 1]).toBe(CELL.tunnel);
    });

    it(`${team}: unseen bulkhead construction stays hidden and destroyed memories clear on resighting`, () => {
      const a = fixture();
      const b = fixture();
      for (const g of [a, b]) g.sim.cells[c] = CELL.tunnel;
      const gate = b.sim.placeBulkhead(enemy, c);
      for (const g of [a, b]) g.sim['computeVision']();
      sameOutput(a, b, team);
      b.sim.scan(army, 24.5, 24.5);
      expect(fog(b).memory.has(gate.id)).toBe(true);
      b.sim.armies[army]!.scans.length = 0;
      b.sim['computeVision']();
      b.sim['kill'](gate);
      b.sim['computeVision']();
      expect(fog(b).gateKnown[c]).not.toBe(0);
      expect(b.view(team).memory.some((g) => g.id === b.entityId(team, gate.id))).toBe(true);
      b.sim.scan(army, 24.5, 24.5);
      expect(fog(b).gateKnown[c]).toBe(0);
      expect(b.view(team).memory.some((g) => g.id === b.entityId(team, gate.id))).toBe(false);
    });

    it(`${team}: a flood first seen downstream does not disclose its hidden origin`, () => {
      const a = fixture();
      const b = fixture();
      for (const [g, origin] of [[a, c + 3], [b, c + 4]] as const) {
        g.sim.magma[origin] = 99;
        g.sim['breakPocket'](origin, enemy);
        g.sim.cells[c] = CELL.magma;
        g.sim.floods[0]!.cells.push(c);
        g.sim.add('digger', army, 'depths', 24.5, 24.5);
        g.sim['computeVision']();
        expect(sees(g, 0, origin)).toBe(false);
      }
      sameOutput(a, b, team);
    });

    for (const kind of ['rail', 'undermine', 'breach'] as const) {
      it(`${team}: ${kind} validation cannot probe a remembered tunnel changed unseen`, () => {
        const a = fixture();
        const b = fixture();
        const unit = kind === 'rail' ? 'digger' : kind === 'undermine' ? 'sapper' : 'trooper';
        for (const g of [a, b]) {
          // A remembered corridor to the destination, no current vision there.
          const home = g.sim.armies[army]!.spire.depths;
          const hx = Math.floor(home.x);
          const hy = Math.floor(home.y);
          for (let x = Math.min(hx, 24); x <= Math.max(hx, 24); x++) fog(g).known[hy * g.sim.size + x] = CELL.tunnel;
          for (let y = Math.min(hy, 24); y <= Math.max(hy, 24); y++) fog(g).known[y * g.sim.size + 24] = CELL.tunnel;
          g.sim.cells[c] = CELL.tunnel;
          g.sim.add(unit, army, 'depths', home.x, home.y);
          g.sim.block[c] = 0;
        }
        b.sim.cells[c] = CELL.fortified;
        const id = a.entityId(team, a.sim.ents.at(-1)!.id);
        const intent = { kind, units: [id], x: 24, y: 24 };
        expect(b.apply({ team, role: 'depths' }, intent)).toEqual(a.apply({ team, role: 'depths' }, intent));
        sameOutput(a, b, team);
      });
    }
  }

  /**
   * Cell-targeted probes from the depths and surface seats with the first own unit of the kind each verb needs (no
   * scans: a scan reveals the truth, which legitimately differs between the twins).
   */
  const probes = (g: AgentCommandGame, team: ArmyId, cells: number[]): [Plane, AgentCommandIntent][] => {
    const first = (kind: Entity['kind'], plane: Plane): string[] => {
      const e = g.sim.ents.find((u) => !u.dead && u.side === slotOfArmyId(team, 2) && u.kind === kind && u.plane === plane);
      return e ? [g.entityId(team, e.id)] : [];
    };
    const digger = first('digger', 'depths');
    const out: [Plane, AgentCommandIntent][] = [];
    for (const c of cells) {
      const x = c % g.sim.size;
      const y = Math.floor(c / g.sim.size);
      out.push(
        ['depths', { kind: 'move', units: digger, x: x + 0.5, y: y + 0.5 }],
        ['depths', { kind: 'dig', units: digger, x, y }],
        ['depths', { kind: 'rail', units: digger, x, y }],
        ['depths', { kind: 'fortify', units: digger, x, y }],
        ['depths', { kind: 'bridge', units: digger, x, y }],
        ['depths', { kind: 'queue_add', item: 'bulkhead', x, y, ...(digger.length ? { digger: digger[0]! } : {}) }],
        ['depths', { kind: 'mine', units: digger, x: x + 0.5, y: y + 0.5 }],
        ['surface', { kind: 'queue_add', item: 'headframe', x, y }],
        ['depths', { kind: 'breach', units: first('trooper', 'depths'), x, y }],
        ['depths', { kind: 'undermine', units: first('sapper', 'depths'), x, y }],
        ['depths', { kind: 'rally', x: x + 0.5, y: y + 0.5 }],
        ['surface', { kind: 'queue_add', item: 'turret', x, y }],
        ['surface', { kind: 'queue_add', item: 'shaft', x, y }],
        ['surface', { kind: 'move', units: first('trooper', 'surface'), x: x + 0.5, y: y + 0.5 }],
        ['surface', { kind: 'rally', x: x + 0.5, y: y + 0.5 }],
      );
    }
    return out.filter(([, i]) => !('units' in i) || i.units.length > 0);
  };

  for (const [seed, terrain, level, minutes] of [
    [31, 'ridges', 'veteran', 7],
    [77, 'canyons', 'standard', 9],
    [123, 'open', 'veteran', 11],
  ] as const) {
    // Four bot matches up to 11 minutes each: the serial timing set (pnpm test:timing).
    it(`seed ${seed} (${terrain}, ${level}) at ${minutes} min`, { tags: ['timing'], timeout: 120_000 }, () => {
      const at = { seed, levels: { nw: level, se: level }, options: { terrain }, maxTicks: toTicks(minutes * 60) };
      const rng = new Rng(seed);
      for (const team of (['nw', 'se'] as const)) {
        const real = playBotMatch(at).game;
        const twin = playBotMatch(at).game;
        expect(twin.stateHash()).toBe(real.stateHash());
        hide(twin, team);
        expect(JSON.stringify(twin.view(team))).toBe(JSON.stringify(real.view(team)));
        for (const role of PLANES) {
          const a = real.observe({ team, role }, 0);
          const b = twin.observe({ team, role }, 0);
          expect(b.schedule, `${team} ${role} schedule`).toEqual(a.schedule);
          expect(b, `${team} ${role} observation`).toEqual(a);
        }
        expect(twin.view(team, { snapshot: true })).toEqual(real.view(team, { snapshot: true }));
        const cells = [...real.sim.lodes.flatMap((l) => real.sim.lodeCells(l.c, LODE_POCKET)), ...Array.from({ length: 160 }, () => rng.int(real.sim.size * real.sim.size))];
        for (const [role, intent] of probes(real, team, cells)) {
          const r = real.apply({ team, role }, intent);
          expect(twin.apply({ team, role }, intent), `${team} ${role} ${JSON.stringify(intent)}`).toEqual(r);
        }
      }
    });
  }

  it('an undiscovered lode is indistinguishable from no lode, including adjacent Headframe probes', () => {
    for (const terrain of TERRAIN_PRESETS) {
      const real = createGame({ seed: 17, options: { terrain } });
      const twin = real.clone();
      const lode = real.sim.lodes.find((l) => l.rich)!;
      expect(lode.known & real.sim.armies[0]!.group.bit).toBe(0);
      hide(twin, 'nw');
      for (const role of PLANES) expect(twin.observe({ team: 'nw', role }, 0)).toEqual(real.observe({ team: 'nw', role }, 0));
      expect(twin.view('nw', { snapshot: true })).toEqual(real.view('nw', { snapshot: true }));
      for (const c of real.sim.lodeCells(lode.c, LODE_POCKET)) {
        const intent = { kind: 'queue_add' as const, item: 'headframe' as const, x: c % real.sim.size, y: Math.floor(c / real.sim.size) };
        expect(real.apply({ team: 'nw', role: 'surface' }, intent)).toEqual({ ok: false, code: 'no_lode' });
        expect(twin.apply({ team: 'nw', role: 'surface' }, intent)).toEqual({ ok: false, code: 'no_lode' });
      }
    }
  });

  it('discovers outcrops through vision, remembers them, and only refreshes their seal state while seen', () => {
    const g = createGame({ seed: 5, options: { terrain: 'open' } });
    const s = g.sim;
    const lode = s.lodes.find((l) => l.rich)!;
    const x = (lode.c % s.size) + 0.5;
    const y = Math.floor(lode.c / s.size) + 0.5;
    const listed = () => g.view('nw').lodes.find((l) => l.x === Math.floor(x) && l.y === Math.floor(y));
    expect(listed()).toBeUndefined();
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'headframe', x: Math.floor(x), y: Math.floor(y) })).toEqual({ ok: false, code: 'no_lode' });
    s.scan(0, x, y);
    expect(listed()?.open).toBe(false);
    s.armies[0]!.scans.length = 0;
    for (let i = 0; i < VISION_EVERY; i++) g.step();
    expect(s.vis[1]![lode.c]! & s.armies[0]!.group.bit).toBe(0);
    lode.open = true;
    for (let i = 0; i < VISION_EVERY; i++) g.step();
    expect(listed()?.open).toBe(false);
    const scout = s.spawnUnit(0, 'trooper', 'surface');
    scout.x = x;
    scout.y = y;
    for (let i = 0; i < VISION_EVERY; i++) g.step();
    expect(listed()?.open).toBe(true);
    expect(g.view('se').lodes.some((l) => l.x === Math.floor(x) && l.y === Math.floor(y))).toBe(false);
  });
});
