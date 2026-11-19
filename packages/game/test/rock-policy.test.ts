import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { CELL, SPIRE_CORNER, TERRAIN_CELLS_PER_WORD, TERRAIN_CODE_BITS, type ArmyId, type Entity, type MatchData, type Observation, type Plane } from '../src/rules/contract.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { DECIDING_STARTERS } from './starter-policies.ts';

type Mode = 'bot' | 'policy';
interface Fixture {
  obs: Observation;
  match: MatchData;
  point(x: number, y: number): { x: number; y: number };
  unit(id: number, kind: Entity['kind'], plane: Plane, x: number, y: number, extra?: Partial<Entity>): Entity;
}
/** Spire centre of army `id` in this duel. */
const spireAt = (match: MatchData, id: ArmyId): { x: number; y: number } => match.armies.find((a) => a.id === id)!.spireAt;
/** The other army of the duel. */
const foeOf = (team: ArmyId): ArmyId => (team === 'nw' ? 'se' : 'nw');
function fixture(role: Plane, team: ArmyId): Fixture {
  const game = createGame({ seed: 91, options: { terrain: 'open', map: { params: { homeLodes: 0, contestedZones: [] } } } });
  const obs = game.observe({ team, role }, 0);
  const match = game.matchData({ team, role });
  obs.entities = []; obs.queue = []; obs.impacts = []; obs.oreCaches = []; obs.scorches = [];
  obs.holes = []; obs.lodes = []; match.faults = []; obs.charges = []; obs.tremors = []; obs.cracks = [];
  obs.research.available = [];
  match.terrain.fill(0);
  obs.res.alloy = obs.res.freeAlloy = 2000; obs.res.energy = obs.res.freeEnergy = 2000;
  obs.res.scanReadyAt = 1e9;
  const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: game.sim.size - x, y: game.sim.size - y };
  const unit = (id: number, kind: Entity['kind'], plane: Plane, x: number, y: number, extra: Partial<Entity> = {}): Entity => ({
    id: `e_${id}`, kind, side: team, plane, ...point(x, y), hp: 300, maxHp: 300, state: 'idle', ...extra,
  });
  return { obs, match, point, unit };
}
function decide(mode: Mode, { obs, match }: Fixture): AgentCommandIntent[] {
  if (mode === 'bot') {
    const bot = createBot(obs.army, obs.role, 'veteran');
    bot.init?.(match);
    return bot.think(obs);
  }
  const think = runInNewContext(`${DECIDING_STARTERS[obs.role]}\ninit(bootstrap);\nthink;`, { bootstrap: match, log() {} }) as (o: Observation) => AgentCommandIntent[];
  return structuredClone(think(obs));
}
function cargo(f: Fixture, size: NonNullable<Entity['rockSize']>, resourceType?: Entity['resourceType'], volatile = false) {
  const tug = f.unit(900, 'tug', 'orbit', 10.5, 10.5, { link: 'e_901' });
  const value = size === 'pebble' ? f.match.rules.orbit.pebbleDockValue : size === 'large' ? f.match.rules.orbit.largeDockValue : f.match.rules.orbit.dockValue;
  const rock = f.unit(901, 'asteroid', 'orbit', 10.5, 10.5, {
    side: 'neutral', state: 'towed', rockSize: size, resourceType, volatile,
    resourceRemaining: resourceType === 'slag' ? 0 : resourceType === 'ice' ? value * f.match.rules.orbit.iceEnergyShare : value,
  });
  f.obs.entities.push(tug, rock);
  return { tug, rock };
}
const drops = (out: AgentCommandIntent[]) => out.filter(i => i.kind === 'deorbit');
const moves = (out: AgentCommandIntent[]) => out.filter(i => i.kind === 'move');

for (const mode of ['bot', 'policy'] as const) describe(`${mode} rock decisions`, () => {
  for (const team of ['nw', 'se'] as const) {
    it(`${team}: docks metal pebbles and unknown resource types only at its own live Orbit segment`, () => {
      for (const resourceType of ['metal', undefined] as const) {
        const f = fixture('orbit', team);
        cargo(f, 'pebble', resourceType);
        expect(moves(decide(mode, f))).toContainEqual({ kind: 'move', units: ['e_900'], ...spireAt(f.match, team) });
        f.obs.spire.find(s => s.plane === 'orbit')!.hp = 0;
        expect(moves(decide(mode, f)).some(i => i.units.includes('e_900') && i.x === spireAt(f.match, team).x && i.y === spireAt(f.match, team).y)).toBe(false);
      }
    });

    it(`${team}: drops nonvolatile metal cargo onto accessible controlled ground, away from its collector`, () => {
      const f = fixture('orbit', team);
      cargo(f, 'medium', 'metal');
      const collector = f.unit(902, 'trooper', 'surface', 10.5, 10.5);
      f.obs.entities.push(collector);
      const order = drops(decide(mode, f))[0];
      expect(order).toBeDefined();
      expect(order!.units).toEqual(['e_900']);
      const own = spireAt(f.match, team), enemy = spireAt(f.match, foeOf(team));
      expect(Math.hypot(order!.x - own.x, order!.y - own.y)).toBeLessThan(Math.hypot(order!.x - enemy.x, order!.y - enemy.y));
      expect(Math.hypot(order!.x - collector.x, order!.y - collector.y)).toBeGreaterThanOrEqual(f.match.rules.orbit.impactRadius + 3);
      f.match.rules.orbit.oreCacheMultiplier = 1;
      expect(drops(decide(mode, f))).toEqual([]);
    });

    it(`${team}: prioritises volatile enemy drops but honours the asteroid-drop house rule`, () => {
      const f = fixture('orbit', team);
      const { tug, rock } = cargo(f, 'large', 'metal', true);
      const enemy = spireAt(f.match, foeOf(team)), own = spireAt(f.match, team);
      const stand = (f.match.rules.spire.range + SPIRE_CORNER + 0.5 + f.match.rules.orbit.deorbitRange) / 2;
      const distance = Math.hypot(own.x - enemy.x, own.y - enemy.y);
      for (const e of [tug, rock]) {
        e.x = enemy.x + (own.x - enemy.x) / distance * stand;
        e.y = enemy.y + (own.y - enemy.y) / distance * stand;
      }
      expect(drops(decide(mode, f))).toContainEqual({ kind: 'deorbit', units: ['e_900'], ...enemy });
      f.obs.mandate.limits = { asteroidDrops: false };
      expect(drops(decide(mode, f))).toEqual([]);
      expect(moves(decide(mode, f))).toContainEqual({ kind: 'move', units: ['e_900'], ...own });
    });

    it(`${team}: uses slag for strikes regardless of alloy stock instead of docking worthless cargo`, () => {
      const f = fixture('orbit', team);
      cargo(f, 'large', 'slag');
      for (const alloy of [0, 400]) {
        f.obs.res.alloy = f.obs.res.freeAlloy = alloy;
        expect(moves(decide(mode, f)).some(i => i.units.includes('e_900') && i.x === spireAt(f.match, team).x && i.y === spireAt(f.match, team).y)).toBe(false);
      }
    });

    it(`${team}: races a visible uncontested cache with one unit, preserving the main army`, () => {
      const f = fixture('surface', team);
      for (let n = 0; n < 6; n++) f.obs.entities.push(f.unit(910 + n, 'trooper', 'surface', 10.5 + n / 10, 10.5));
      const cache = { id: 1, ...f.point(15.5, 10.5), alloy: 150, radius: 2 };
      f.obs.oreCaches = [cache];
      const orders = moves(decide(mode, f));
      const collectors = orders.filter(i => i.x === cache.x && i.y === cache.y).flatMap(i => i.units);
      expect(collectors).toHaveLength(1);
      expect(orders.filter(i => i.x !== cache.x || i.y !== cache.y).every(i => i.units.every(id => !collectors.includes(id)))).toBe(true);
      f.obs.entities.push(f.unit(930, 'tank', 'surface', 16.5, 10.5, { side: foeOf(team) }));
      expect(moves(decide(mode, f)).some(i => i.x === cache.x && i.y === cache.y)).toBe(false);
      f.obs.entities.pop();
      f.obs.scorches = [{ ...cache, radius: 4, until: 200 }];
      expect(moves(decide(mode, f)).some(i => i.x === cache.x && i.y === cache.y)).toBe(false);
      f.obs.scorches = []; f.obs.oreCaches = [];
      expect(moves(decide(mode, f)).some(i => i.x === cache.x && i.y === cache.y)).toBe(false);
    });

    it(`${team}: refuses a cache separated from its collectors by an unbroken cliff`, () => {
      const f = fixture('surface', team);
      for (let n = 0; n < 6; n++) f.obs.entities.push(f.unit(910 + n, 'trooper', 'surface', 10.5 + n / 10, 10.5));
      const x = Math.floor(f.point(12.5, 10.5).x);
      const size = f.match.rules.map.size;
      for (let y = 0; y < size; y++) {
        const c = y * size + x;
        f.match.terrain[Math.floor(c / TERRAIN_CELLS_PER_WORD)]! |= 1 << (TERRAIN_CODE_BITS * (c % TERRAIN_CELLS_PER_WORD));
      }
      const cache = { id: 1, ...f.point(15.5, 10.5), alloy: 150, radius: 2 };
      f.obs.oreCaches = [cache];
      expect(moves(decide(mode, f)).some((i) => i.x === cache.x && i.y === cache.y)).toBe(false);
    });

    it(`${team}: moves a free digger to the visible underground share without issuing mine for that digger`, () => {
      const f = fixture('depths', team);
      f.obs.depths!.fill(CELL.tunnel);
      for (let n = 0; n < 4; n++) f.obs.entities.push(f.unit(940 + n, 'digger', 'depths', 10.5 + n / 10, 10.5));
      const below = { ...f.point(12.5, 10.5), alloy: 75 };
      f.obs.oreCaches = [{ id: 1, ...below, alloy: 0, radius: 2, below }];
      const out = decide(mode, f);
      const order = moves(out).find(i => i.x === below.x && i.y === below.y);
      expect(order?.units).toHaveLength(1);
      expect(out.some(i => i.kind === 'mine' && i.units.some(id => order!.units.includes(id)))).toBe(false);
      below.alloy = 0;
      expect(moves(decide(mode, f)).some(i => i.x === below.x && i.y === below.y)).toBe(false);
    });

    it(`${team}: chooses the nearest digger in the cache's own connected cavern`, () => {
      const f = fixture('depths', team);
      f.obs.depths!.fill(CELL.rock);
      const open = (x: number, y: number): void => {
        const p = f.point(x + 0.5, y + 0.5);
        f.obs.depths![Math.floor(p.y) * f.match.rules.map.size + Math.floor(p.x)] = CELL.tunnel;
      };
      open(10, 10);
      for (let x = 12; x <= 15; x++) open(x, 10);
      open(15, 11); open(15, 12);
      const nearer = f.unit(950, 'digger', 'depths', 10.5, 10.5);
      const connected = f.unit(951, 'digger', 'depths', 15.5, 12.5);
      f.obs.entities.push(nearer, connected);
      const below = { ...f.point(12.5, 10.5), alloy: 75 };
      f.obs.oreCaches = [{ id: 1, ...below, alloy: 0, radius: 2, below }];
      const orders = moves(decide(mode, f)).filter(i => i.x === below.x && i.y === below.y);
      expect(orders).toContainEqual({ kind: 'move', units: [connected.id], x: below.x, y: below.y });
      expect(orders.some(i => i.units.includes(nearer.id))).toBe(false);
      connected.carry = 10;
      expect(moves(decide(mode, f)).some(i => i.x === below.x && i.y === below.y)).toBe(false);
      delete connected.carry;
      f.obs.entities.push(f.unit(952, 'bulkhead', 'depths', 13.5, 10.5, { side: foeOf(team) }));
      expect(moves(decide(mode, f)).some(i => i.x === below.x && i.y === below.y)).toBe(false);
    });
  }
});
