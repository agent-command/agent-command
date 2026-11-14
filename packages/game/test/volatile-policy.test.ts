import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { Ctx } from '../src/bots/context.ts';
import { volatileAbort } from '../src/bots/orbit.ts';
import { fullObservation } from '../src/rules/observation-core.ts';
import { DEFAULT_RULES, TICK_RATE, unpackTerrain, type ArmyId, type Entity, type MatchData, type Observation } from '../src/rules/contract.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { STARTER_POLICIES } from './starter-policies.ts';

interface Fixture {
  obs: Observation;
  match: MatchData;
  enemy: ArmyId;
  /** the enemy Spire centre */
  enemyAt: { x: number; y: number };
  point(x: number, y: number): { x: number; y: number };
  unit(id: number, kind: Entity['kind'], x: number, y: number, extra?: Partial<Entity>): Entity;
  tow(x?: number, y?: number): { tug: Entity; rock: Entity };
}

function fixture(team: ArmyId): Fixture {
  // No derelict: these tows meet at the map centre, inside its chamber, where its walls would block the shots.
  const game = createGame({ seed: 91, options: { terrain: 'open', map: { params: { homeLodes: 0, contestedZones: [] } }, orbit: { derelictEnabled: false } } });
  const obs = game.observe({ team, role: 'orbit' }, 0);
  const match = game.matchData({ team, role: 'orbit' });
  obs.entities = []; obs.queue = []; obs.impacts = []; obs.oreCaches = []; obs.scorches = [];
  obs.holes = []; obs.tremors = []; obs.research.available = [];
  obs.res.alloy = obs.res.freeAlloy = 2000; obs.res.energy = obs.res.freeEnergy = 2000; obs.res.scanReadyAt = 1e9;
  const enemy = team === 'nw' ? 'se' : 'nw';
  const enemyAt = match.armies.find((a) => a.id === enemy)!.spireAt;
  const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: game.sim.size - x, y: game.sim.size - y };
  const unit = (id: number, kind: Entity['kind'], x: number, y: number, extra: Partial<Entity> = {}): Entity => ({
    id: `e_${id}`, kind, side: team, plane: 'orbit', ...point(x, y), hp: 300, maxHp: 300, state: 'idle', ...extra,
  });
  function tow(x = 15.5, y = 15.5) {
    const tug = unit(900, 'tug', x, y, { link: 'e_901', state: 'towing' });
    const rock = unit(901, 'asteroid', x, y, {
      side: 'neutral', state: 'towed', rockSize: 'medium', resourceType: 'metal', volatile: true, resourceRemaining: 150, fuseUntil: obs.tick + match.rules.orbit.volatileFuse * TICK_RATE,
    });
    obs.entities.push(tug, rock);
    return { tug, rock };
  }
  return { obs, match, enemy, enemyAt, point, unit, tow };
}

type Mode = 'bot' | 'policy';
function commander(mode: Mode, f: Fixture): (obs: Observation) => AgentCommandIntent[] {
  if (mode === 'bot') {
    const bot = createBot(f.obs.army, 'orbit', 'veteran');
    bot.init?.(f.match);
    return obs => bot.think(obs);
  }
  const think = runInNewContext(`${STARTER_POLICIES.orbit}\ninit(bootstrap);\nthink;`, { bootstrap: f.match, log() {} }) as (obs: Observation) => AgentCommandIntent[];
  return obs => structuredClone(think(obs));
}

for (const mode of ['bot', 'policy'] as const) describe(`${mode}: volatile tow tactics`, () => {
  for (const team of ['nw', 'se'] as const) {
    it(`${team}: acquires only a size-speed-adjusted enemy release reachable strictly before the configured fuse`, () => {
      for (const [size, towKey] of [['pebble', 'pebbleTowSpeed'], ['medium', 'towSpeed'], ['large', 'largeTowSpeed']] as const) {
        for (const reachable of [false, true]) {
          const f = fixture(team);
          f.match.rules.orbit[towKey] = 0.4;
          f.match.rules.stats.tug.speed = 3;
          const tug = f.unit(900, 'tug', 20.5, 20.5);
          const rock = f.unit(901, 'asteroid', 25.5, 25.5, { side: 'neutral', state: 'drifting', rockSize: size, resourceType: 'metal', volatile: true, resourceRemaining: 150 });
          const target = f.enemyAt;
          const travel = Math.max(0, Math.hypot(rock.x - target.x, rock.y - target.y) - f.match.rules.orbit.deorbitRange) / (3 * 0.4);
          f.match.rules.orbit.volatileFuse = travel + (reachable ? 0.5 : 0);
          f.obs.entities.push(tug, rock);
          const out = commander(mode, f)(f.obs);
          expect(out.some(i => i.kind === 'grapple' && i.asteroid === rock.id)).toBe(reachable);
        }
      }
    });

    it(`${team}: refuses volatile under a no-drops mandate but still mines metal`, () => {
      const f = fixture(team);
      f.obs.mandate.limits = { asteroidDrops: false };
      f.obs.entities.push(f.unit(900, 'tug', 34.5, 34.5));
      f.obs.entities.push(f.unit(901, 'asteroid', 35.5, 35.5, { side: 'neutral', state: 'drifting', rockSize: 'pebble', resourceType: 'metal', volatile: true, resourceRemaining: 30 }));
      const think = commander(mode, f);
      expect(think(f.obs).some(i => i.kind === 'grapple')).toBe(false);
      f.obs.tick += 100;
      f.obs.entities.push(f.unit(902, 'asteroid', 36.5, 35.5, { side: 'neutral', state: 'drifting', rockSize: 'pebble', resourceType: 'metal', volatile: false, resourceRemaining: 30 }));
      expect(think(f.obs)).toContainEqual({ kind: 'mine_asteroid', units: ['e_900'], asteroid: 'e_902' });
    });

    it(`${team}: invalidates an existing volatile claim when the owner forbids drops`, () => {
      const f = fixture(team);
      f.obs.entities.push(f.unit(900, 'tug', 34.5, 34.5));
      f.obs.entities.push(f.unit(901, 'asteroid', 35.5, 35.5, { side: 'neutral', state: 'drifting', rockSize: 'pebble', resourceType: 'metal', volatile: true, resourceRemaining: 30 }));
      const think = commander(mode, f);
      expect(think(f.obs)).toContainEqual({ kind: 'grapple', units: ['e_900'], asteroid: 'e_901' });
      f.obs.tick += 100;
      f.obs.entities[0]!.state = 'grappling';
      f.obs.mandate.limits = { asteroidDrops: false };
      f.obs.entities.push(f.unit(902, 'asteroid', 36.5, 35.5, { side: 'neutral', state: 'drifting', resourceType: 'metal', volatile: false, resourceRemaining: 150 }));
      expect(think(f.obs)).toContainEqual({ kind: 'mine_asteroid', units: ['e_900'], asteroid: 'e_902' });
    });

    it(`${team}: stops an in-flight volatile grapple when its visible destination is no longer feasible`, () => {
      const f = fixture(team);
      const tug = f.unit(900, 'tug', 34.5, 34.5);
      const rock = f.unit(901, 'asteroid', 35.5, 35.5, { side: 'neutral', state: 'drifting', rockSize: 'large', resourceType: 'metal', volatile: true, resourceRemaining: 400 });
      f.obs.entities.push(tug, rock);
      const think = commander(mode, f);
      expect(think(f.obs)).toContainEqual({ kind: 'grapple', units: [tug.id], asteroid: rock.id });
      tug.state = 'grappling';
      Object.assign(rock, f.point(0.5, 0.5));
      f.obs.tick += 100;
      expect(think(f.obs)).toContainEqual({ kind: 'stop', units: [tug.id] });
    });

    it(`${team}: does not infer unseen resource type, volatility or fuse from a public marker`, () => {
      const f = fixture(team);
      f.match.rules.orbit.volatileFuse = 1;
      f.obs.mandate.limits = { asteroidDrops: false };
      f.obs.entities.push(f.unit(900, 'tug', 10.5, 10.5));
      f.obs.entities.push(f.unit(901, 'asteroid', 11.5, 11.5, { side: 'neutral', state: 'drifting', rockSize: 'large' }));
      expect(commander(mode, f)(f.obs).some(i => i.kind === 'grapple' || i.kind === 'mine_asteroid')).toBe(false);
    });

    it(`${team}: continues a feasible visible tow but aborts an insufficient fuse clear of own Surface and Orbit assets`, () => {
      for (const enough of [true, false]) {
        const f = fixture(team);
        const { rock } = f.tow();
        rock.fuseUntil = f.obs.tick + (enough ? 100 : 1) * TICK_RATE;
        const surface = f.unit(902, 'tank', 20.5, 20.5, { plane: 'surface' });
        const orbit = f.unit(903, 'solar', 23.5, 23.5);
        f.obs.entities.push(surface, orbit);
        const out = commander(mode, f)(f.obs);
        const drop = out.find(i => i.kind === 'deorbit');
        if (enough) {
          expect(drop).toBeUndefined();
          expect(out.some(i => i.kind === 'move' && i.units.includes('e_900'))).toBe(true);
        } else {
          expect(drop).toBeDefined();
          if (drop?.kind !== 'deorbit') throw new Error('Expected an emergency deorbit');
          expect(Math.hypot(drop.x - rock.x, drop.y - rock.y)).toBeLessThanOrEqual(f.match.rules.orbit.deorbitRange);
          expect(Math.hypot(drop.x - surface.x, drop.y - surface.y)).toBeGreaterThan(f.match.rules.orbit.impactRadius * f.match.rules.orbit.volatileRadiusMultiplier + 0.6);
          expect(Math.hypot(drop.x - orbit.x, drop.y - orbit.y)).toBeGreaterThan(f.match.rules.orbit.volatileOrbitRadius);
        }
      }
    });

    it(`${team}: aborts a likely interception with a useful reachable enemy Surface drop`, () => {
      const f = fixture(team);
      f.tow();
      f.obs.entities.push(f.unit(902, 'lancer', 20.5, 15.5, { side: f.enemy }));
      const victim = f.unit(903, 'turret', 21.5, 20.5, { side: f.enemy, plane: 'surface' });
      f.obs.entities.push(victim);
      expect(commander(mode, f)(f.obs)).toContainEqual({ kind: 'deorbit', units: ['e_900'], x: victim.x, y: victim.y });
    });

    it(`${team}: releases an in-range useful strike immediately despite an almost expired fuse`, () => {
      const f = fixture(team);
      const { tug, rock } = f.tow(39.5, 39.5);
      rock.fuseUntil = f.obs.tick + 1;
      const target = f.enemyAt;
      expect(commander(mode, f)(f.obs)).toContainEqual({ kind: 'deorbit', units: [tug.id], ...target });
    });

    for (const kind of ['lancer', 'bastion', 'skiff'] as const) {
      it(`${team}: ${kind} focuses an armed enemy tow before the hostile tug when the blast is safe`, () => {
        const f = fixture(team);
        // Bastion reaches the rock's edge from outside the default blast; Skiff needs a smaller configured blast.
        if (kind === 'skiff') f.match.rules.orbit.volatileOrbitRadius = 0.5;
        const distance = kind === 'lancer' ? 5 : kind === 'bastion' ? 3.75 : 1.5;
        f.obs.entities.push(f.unit(910, kind, 24.5 - distance, 24.5, { state: 'attacking' }));
        f.obs.entities.push(f.unit(911, 'tug', 24.5, 24.5, { side: f.enemy, link: 'e_912', state: 'towing' }));
        f.obs.entities.push(f.unit(912, 'asteroid', 24.5, 24.5, {
          side: 'neutral', state: 'towed', resourceType: 'metal', volatile: true, resourceRemaining: 150, fuseUntil: f.obs.tick + 100,
        }));
        expect(commander(mode, f)(f.obs)).toContainEqual({ kind: 'attack', units: ['e_910'], target: 'e_912' });
      });
    }

    for (const guard of ['volatility', 'fuse', 'friendly', 'structure', 'tug'] as const) {
      it(`${team}: never focuses a volatile tow without the ${guard} safety/visibility guard`, () => {
        const f = fixture(team);
        f.obs.entities.push(f.unit(910, 'lancer', 19.5, 24.5));
        const tug = f.unit(911, 'tug', 24.5, 24.5, { side: f.enemy, link: 'e_912' });
        const rock = f.unit(912, 'asteroid', 24.5, 24.5, { side: 'neutral', state: 'towed', resourceType: 'metal', volatile: true, resourceRemaining: 150, fuseUntil: 100 });
        if (guard === 'volatility') delete rock.volatile;
        if (guard === 'fuse') delete rock.fuseUntil;
        if (guard === 'tug') delete tug.link;
        if (guard === 'friendly') f.obs.entities.push(f.unit(913, 'solar', 25.5, 24.5));
        if (guard === 'structure') f.obs.entities.push(f.unit(913, 'spire', 28.1, 28.1));
        f.obs.entities.push(tug, rock);
        expect(commander(mode, f)(f.obs).some(i => i.kind === 'attack' && i.target === rock.id)).toBe(false);
      });
    }
  }

  it('chooses exactly point-symmetric emergency disposal cells', () => {
    const drops = (['nw', 'se'] as const).map(team => {
      const f = fixture(team);
      const { rock } = f.tow();
      rock.fuseUntil = 1;
      f.obs.entities.push(f.unit(902, 'tank', 20.5, 20.5, { plane: 'surface' }));
      const drop = commander(mode, f)(f.obs).find(i => i.kind === 'deorbit');
      if (drop?.kind !== 'deorbit') throw new Error('Expected mirrored emergency disposal');
      return { x: drop.x, y: drop.y };
    });
    expect(drops[1]).toEqual({ x: DEFAULT_RULES.map.size - drops[0]!.x, y: DEFAULT_RULES.map.size - drops[0]!.y });
  });
});

// The starter's Orbit planning is the built-in bot's (bots/orbit.ts volatileAbort), checked here directly.
describe('volatile planning decision equivalence', () => {
  it('keeps the exhaustive emergency-drop minimum and mirrored tie order', () => {
    for (const team of ['nw', 'se'] as const) for (const at of [[10.5, 15.5], [24, 24], [38.5, 31.5], [7.5, 7.5]] as const) {
      const f = fixture(team);
      const { rock } = f.tow(at[0], at[1]);
      f.obs.entities.push(f.unit(930, 'tank', at[0] + 2, at[1] + 2, { plane: 'surface' }));
      f.obs.entities.push(f.unit(931, 'solar', at[0] + 3, at[1] - 2));
      const c = new Ctx(fullObservation(f.obs), f.match, unpackTerrain(f.match.terrain, f.match.rules.map.size));
      const target = f.enemyAt, r = f.match.rules.orbit;
      const safe = (p: { x: number; y: number }): boolean => !f.obs.entities.some(e => {
        if (e.side !== team || (e.plane !== 'surface' && e.plane !== 'orbit')) return false;
        const width = ({ spire: 3, headframe: 3, shaft: 2, turret: 1, bulkhead: 1, geothermal: 1 } as Record<string, number>)[e.kind] ?? 0;
        const structure = ['spire', 'headframe', 'shaft', 'turret'].includes(e.kind);
        const clearance = e.plane === 'surface' && !structure ? ({ tank: 0.6, flak: 0.5, trooper: 0.35 } as Record<string, number>)[e.kind] || 0.7 : 0;
        return Math.hypot(Math.max(0, Math.abs(e.x - p.x) - width / 2), Math.max(0, Math.abs(e.y - p.y) - width / 2))
          <= (e.plane === 'surface' ? r.impactRadius * r.volatileRadiusMultiplier : r.volatileOrbitRadius) + clearance;
      });
      const usable = (p: { x: number; y: number }): boolean => Math.hypot(p.x - rock.x, p.y - rock.y) <= r.deorbitRange && safe(p);
      let expected: { x: number; y: number } | null = usable(target) ? target : null;
      if (!expected) expected = f.obs.entities.find(e => e.side === f.enemy && e.plane === 'surface' && usable(e)) ?? null;
      if (!expected) {
        let distance = Infinity;
        const size = f.match.rules.map.size;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          const p = f.point(x + 0.5, y + 0.5);
          const d = Math.hypot(p.x - target.x, p.y - target.y);
          if (usable(p) && d < distance) { expected = p; distance = d; }
        }
      }
      expect(volatileAbort(c, rock, target) ?? null).toEqual(expected);
    }
  });
});
