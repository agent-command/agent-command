/**
 * Spire launch fixes: impacts × rules.spire.impactMultiplier on the Surface segment only, asteroid pacing as a match
 * rule, sieged tanks capped at the segment beam's reach against Spire segments (bots and the example policy siege
 * inside it), and sudden death. Sim scenarios run for both armies of a duel (C2 point mirror) and, where they are per
 * army, for the four armies of a C4 map.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import { createBot } from '../src/bots/bots.ts';
import { DEFAULT_RULES, ECON, PLANES, STATS, SURFACE, toTicks, type ArmyId, type MatchData, type MatchOptions, type Observation, type Opponent } from '../src/rules/contract.ts';
import { DEPLOY_UP, VISION_EVERY } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';

const DUEL = ['nw', 'se'] as const;
const FOUR = ['nw', 'ne', 'se', 'sw'] as const;
const foeOf = (team: ArmyId): ArmyId => (team === 'nw' ? 'se' : 'nw');
const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const segments = (g: AgentCommandGame, team: ArmyId) => g.sim.armies[slotOfArmyId(team, g.sim.sides)]!.spire;

describe('launch defaults', () => {
  it('ships the rock pacing, the impact multiplier, the siege cap, the tank cost and sudden death', () => {
    expect([ECON.asteroidSpawnTicks, ECON.maxAsteroids]).toEqual([toTicks(30), 5]);
    expect([DEFAULT_RULES.orbit.asteroidSpawnPeriod, DEFAULT_RULES.orbit.maxAsteroids]).toEqual([30, 5]);
    expect(DEFAULT_RULES.spire).toMatchObject({ impactMultiplier: 0.5, suddenDeathAt: 22 * 60, suddenDeathWarning: 60, suddenDeathDamage: 1.5 });
    // The cap is measured like the beam: at or below spire.range the beam reaches every tank that reaches the Spire.
    expect(DEFAULT_RULES.surface.siegeSpireRange).toBe(7);
    expect(DEFAULT_RULES.surface.siegeSpireRange).toBeLessThanOrEqual(DEFAULT_RULES.spire.range);
    expect([STATS.tank.alloy, STATS.tank.energy]).toEqual([90, 30]);
  });
});

describe('impacts on the Spire', () => {
  const game = (spire: MatchOptions['spire'] = {}) => createGame({ seed: 31, options: { terrain: 'open', map: { params: { motherLode: { enabled: false } } }, spire: { dmg: 0, ...spire }, orbit: { maxAsteroids: 0 } } });
  /** A medium rubble rock dropped by `by` on `team`'s Spire centre; returns what each target lost. */
  function strike(g: AgentCommandGame, team: ArmyId): { surface: number; sky: number; tank: number; interceptor: number } {
    const s = g.sim;
    const by = slotOfArmyId(foeOf(team), 2);
    const seg = segments(g, team);
    const at = { x: seg.surface.x, y: seg.surface.y };
    const tank = s.spawnUnit(slotOfArmyId(team, 2), 'tank', 'surface');
    const air = s.spawnUnit(slotOfArmyId(team, 2), 'interceptor', 'sky');
    tank.x = at.x + (team === 'nw' ? 2 : -2); tank.y = at.y;
    air.x = at.x; air.y = at.y;
    tank.hp = tank.maxHp = air.hp = air.maxHp = 1e6;
    air.shield = air.maxShield = 0;
    const before = [seg.surface.hp, seg.sky.hp];
    const a = s.add('asteroid', NEUTRAL, 'orbit', at.x, at.y);
    a.rockSize = 'medium'; a.resourceType = 'slag'; a.hp = a.maxHp = s.rocks.medium.hp; a.state = 'drifting';
    a.resourceRemaining = s.rocks.medium.dockYield.slag.alloy + s.rocks.medium.dockYield.slag.energy;
    expect(s.dropPayload(a, by, at.x, at.y)).toBe(true);
    s.tick = a.impactTick - 1;
    g.step();
    expect(a.dead).toBe(true);
    return { surface: before[0]! - seg.surface.hp, sky: before[1]! - seg.sky.hp, tank: 1e6 - tank.hp, interceptor: 1e6 - air.hp };
  }

  it('hits only the Surface segment at ×impactMultiplier, the blast in full, the same for both armies', () => {
    const lost = DUEL.map((team) => strike(game(), team));
    expect(lost[0]).toEqual({ surface: ECON.impactDamage * 0.5, sky: 0, tank: ECON.impactDamage, interceptor: ECON.impactDamage });
    expect(lost[1]).toEqual(lost[0]);
  });

  it('follows the rule (×1 restores full impacts, still on one segment)', () => {
    for (const team of DUEL) expect(strike(game({ impactMultiplier: 1 }), team)).toMatchObject({ surface: ECON.impactDamage, sky: 0 });
  });
});

/** Only the Spires left, on level open ground. */
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 5, options: { terrain: 'open', ...options } });
  g.sim.terrain.fill(SURFACE.ground);
  g.sim.surfaceCost.fill(1);
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.step();
  return g;
}
/** Where a body stands `d` tiles from the footprint edge of `spire`, toward the map centre (on an axis or a diagonal). */
function besideSpire(g: AgentCommandGame, spire: Ent, d: number, diagonal: boolean): [number, number] {
  const half = STATS.spire.footprint.w / 2;
  const ux = Math.sign(g.sim.size / 2 - spire.x);
  const uy = Math.sign(g.sim.size / 2 - spire.y);
  return diagonal ? [spire.x + ux * (half + d * Math.SQRT1_2), spire.y + uy * (half + d * Math.SQRT1_2)] : [spire.x + ux * (half + d), spire.y];
}
function siegeTank(g: AgentCommandGame, team: ArmyId, x: number, y: number): Ent {
  const tank = g.sim.spawnUnit(slotOfArmyId(team, 2), 'tank', 'surface');
  [tank.x, tank.y] = [x, y];
  tank.stance = 'hold';
  tank.hp = tank.maxHp = 1e6;
  expect(g.apply({ team, role: 'surface' }, { kind: 'deploy', units: [id(g, team, tank)], on: true })).toEqual({ ok: true });
  steps(g, ECON.siegeDeployTicks + 1);
  expect(tank.deploy).toBe(DEPLOY_UP);
  return tank;
}

describe.each(DUEL)('sieged tanks against the Spire (%s)', (team) => {
  const reach = ECON.siegeSpireRange + STATS.tank.radius;

  it('reach a segment exactly as far as its beam reaches them, on the axis and the diagonal, high ground not adding', () => {
    for (const diagonal of [false, true]) {
      const g = arena();
      const s = g.sim;
      const spire = segments(g, foeOf(team)).surface;
      const tank = siegeTank(g, team, ...besideSpire(g, spire, reach - 0.3, diagonal));
      for (const [d, inside] of [[reach - 0.01, true], [reach + 0.01, false]] as const) {
        [tank.x, tank.y] = besideSpire(g, spire, d, diagonal);
        expect(s.inRange(tank, spire)).toBe(inside);
        expect(s.inRange(spire, tank)).toBe(inside);
      }
      // A plateau under the tank adds nothing against the Spire (it still does against other structures).
      s.terrain[Math.floor(tank.y) * s.size + Math.floor(tank.x)] = SURFACE.high;
      expect(s.onHigh(tank)).toBe(true);
      expect(s.inRange(tank, spire)).toBe(false);
    }
  });

  it('are answered by a lone Spire past its sight disc (the diagonal), and the trade is mirrored', () => {
    const lost: number[][] = [];
    for (const t of DUEL) {
      const g = arena();
      const spire = segments(g, foeOf(t)).surface;
      const tank = siegeTank(g, t, ...besideSpire(g, spire, reach - 0.2, true));
      const hp = spire.hp;
      steps(g, toTicks(6));
      lost.push([1e6 - tank.hp, hp - spire.hp]);
    }
    expect(lost[0]![0]).toBeGreaterThan(0);
    expect(lost[0]![1]).toBeGreaterThan(0);
    expect(lost[1]).toEqual(lost[0]);
  });
});

describe('bots and the example policy siege the Spire only inside the cap', () => {
  const think = (mode: Opponent | 'policy', obs: Observation, data: MatchData): AgentCommandIntent[] => {
    if (mode !== 'policy') {
      const bot = createBot(obs.army, 'surface', mode);
      bot.init?.(data);
      return bot.think(obs);
    }
    const policy = runInNewContext(`${STARTER_POLICIES.surface}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
    policy.init(data);
    return structuredClone(policy.think(obs));
  };
  for (const mode of ['standard', 'veteran', 'policy'] as const) {
    it(`${mode}: a tank 8 tiles off the Spire's edge (inside siegeRangeStructures) holds; 6.5 tiles off it sieges, mirrored`, () => {
      for (const team of DUEL) {
        const wants = DUEL.map((_, k) => {
          const g = arena();
          const spire = segments(g, foeOf(team)).surface;
          const tank = g.sim.spawnUnit(slotOfArmyId(team, 2), 'tank', 'surface');
          tank.hp = tank.maxHp = 1e6;
          [tank.x, tank.y] = besideSpire(g, spire, k === 0 ? 8 : 6.5, false);
          g.apply({ team, role: 'surface' }, { kind: 'stop', units: [id(g, team, tank)] });
          steps(g, VISION_EVERY + 1);
          const seat = { team, role: 'surface' } as const;
          const obs = g.observe(seat, 0);
          expect(obs.entities.some((e) => e.id === id(g, team, spire))).toBe(true);
          return think(mode, obs, g.matchData(seat)).some((i) => i.kind === 'deploy' && i.on && i.units.includes(id(g, team, tank)));
        });
        expect(wants).toEqual([false, true]);
      }
    });
  }
});

describe('sudden death', () => {
  const at = toTicks(DEFAULT_RULES.spire.suddenDeathAt);
  const warn = toTicks(DEFAULT_RULES.spire.suddenDeathWarning);
  const c4 = () => createGame({ seed: 5, options: { terrain: 'open', map: { seed: 5, params: { slots: 4 } } } });
  const c2 = () => createGame({ seed: 5, options: { terrain: 'open' } });

  for (const [name, make, teams] of [['C2', c2, DUEL], ['C4', c4, FOUR]] as const) {
    it(`${name}: a public countdown (schedule and an alert leading every plane) for suddenDeathWarning, then the event, for every army`, () => {
      const g = make();
      const s = g.sim;
      const entry = { kind: 'sudden_death', tick: at };
      const check = (tick: number, counting: boolean) => {
        s.tick = tick;
        for (const team of teams) {
          const o = g.observe({ team, role: 'surface' }, 0);
          expect(o.schedule.some((x) => x.kind === 'sudden_death')).toBe(counting);
          if (counting) expect(o.schedule).toContainEqual(entry);
          const alerts = o.alerts.filter((a) => a.kind === 'sudden_death');
          expect(alerts).toEqual(counting ? PLANES.map((plane) => ({ plane, kind: 'sudden_death', tick: at })) : []);
          // It leads each plane's alerts.
          for (const plane of counting ? PLANES : []) expect(o.alerts.find((a) => a.plane === plane)?.kind).toBe('sudden_death');
        }
        expect(s.suddenDeath()).toBe(tick >= at);
      };
      check(at - warn - 1, false);
      check(at - warn, true);
      check(at - 1, true);
      g.step();
      expect(s.tick).toBe(at);
      check(at, false);
      for (const team of teams) {
        expect(g.observe({ team, role: 'orbit' }, 0).events.filter((e) => e.kind === 'sudden_death').map((e) => e.tick)).toEqual([at]);
      }
    });

    it(`${name}: every segment then takes ×suddenDeathDamage, except rock-borne damage, the same for every army`, () => {
      const g = make();
      const s = g.sim;
      const taken = (tick: number): number[][] => teams.map((team) => {
        s.tick = tick;
        const slot = slotOfArmyId(team, s.sides);
        const foe = (slot + 1) % s.sides;
        return [...PLANES.map((plane) => {
          const seg = s.armies[slot]!.spire[plane];
          const hp = seg.hp;
          s.damage(seg, 100, foe, false, 'tank', plane, 'tank');
          return hp - seg.hp;
        }), ...(['impact', 'core_drop', 'volatile_detonation'] as const).map((cause) => {
          const seg = s.armies[slot]!.spire.surface;
          const hp = seg.hp;
          s.damage(seg, 100, foe, true, cause, 'orbit', 'asteroid');
          return hp - seg.hp;
        })];
      });
      const before = taken(at - 1);
      expect(before).toEqual(teams.map(() => [100, 100, 100, 100, 100, 100, 100]));
      expect(taken(at)).toEqual(teams.map(() => [150, 150, 150, 150, 100, 100, 100]));
    });
  }

  it('stops Orbit dock repairs, mirrored', () => {
    for (const team of DUEL) {
      const g = c2();
      const s = g.sim;
      const seg = segments(g, team).orbit;
      const ship = s.spawnUnit(slotOfArmyId(team, 2), 'lancer', 'orbit');
      [ship.x, ship.y] = [seg.x, seg.y];
      ship.hp = 100;
      s.tick = at - 2;
      g.step();
      const repaired = ship.hp;
      expect(repaired).toBeGreaterThan(100);
      g.step();
      expect(s.tick).toBe(at);
      expect(ship.hp).toBe(repaired);
    }
  });

  it('never happens with suddenDeathAt 0', () => {
    const g = createGame({ seed: 5, options: { terrain: 'open', spire: { suddenDeathAt: 0 } } });
    const s = g.sim;
    s.tick = at - 1;
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).schedule.some((x) => x.kind === 'sudden_death')).toBe(false);
    g.step();
    expect(s.suddenDeath()).toBe(false);
    const seg = segments(g, 'nw').surface;
    const hp = seg.hp;
    s.damage(seg, 100, slotOfArmyId('se', 2), false, 'tank', 'surface', 'tank');
    expect(hp - seg.hp).toBe(100);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).events.some((e) => e.kind === 'sudden_death')).toBe(false);
  });
});
