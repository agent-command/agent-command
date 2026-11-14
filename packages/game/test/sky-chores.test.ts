/** Sky stance defaults: storm evade and auto-intercept as default stance behaviour, the bots' gunship comparison. */
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { airValue } from '../src/bots/sky.ts';
import { compileRules, DEFAULT_RULES, TICK_RATE, type StatKind } from '../src/rules/contract.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';
import type { Ent } from '../src/sim/ent.ts';
import type { Sim } from '../src/sim/sim.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);

/** No natural weather, no starting units: only what a case adds. */
function bare(sky: object = {}) {
  const g = createGame({ seed: 7, options: { terrain: 'open', sky: { stormSets: 0, fogRadius: 0, jetWidth: 0, ...sky } } });
  for (const e of g.sim.ents) if (e.unit) e.dead = true;
  g.sim.armies[BLUE]!.energy = g.sim.armies[RED]!.energy = 5000;
  return g;
}
/** `kind` of `army` on `plane` at (x, y) in blue's frame (red: the point mirror). */
function put(s: Sim, army: number, kind: Parameters<Sim['add']>[0], plane: Ent['plane'], x: number, y: number): Ent {
  const e = army === BLUE ? s.add(kind, army, plane, x, y) : s.add(kind, army, plane, s.size - x, s.size - y);
  e.built = true;
  return e;
}
const steps = (s: Sim, n: number) => { for (let i = 0; i < n; i++) s.step(); };
const harm = (s: Sim, e: Ent) => s.weather.harmAt(e.x, e.y, ~s.hostileMask[e.side]!, s.econ.seededOwnDamage);

describe('storm evade', () => {
  /**
   * Each army's aircraft idle 2 tiles from its own Seeder, near home and far from the other army; then the Seeder's
   * storm forms over them (own seeded storms still harm at seededOwnDamage). `prepare` runs before the storm.
   */
  function storm(sky: object = {}, prepare: (s: Sim, air: Ent[]) => void = () => {}) {
    const g = bare(sky);
    const s = g.sim;
    const sides = [BLUE, RED].map((army) => {
      const seeder = put(s, army, 'storm_seeder', 'sky', 12, 14);
      const air = [put(s, army, 'interceptor', 'sky', 14, 15), put(s, army, 'gunship', 'sky', 13, 12.5)];
      for (const e of air) e.cd = 1e6;
      return { seeder, air };
    });
    for (const side of sides) prepare(s, side.air);
    steps(s, 2);
    for (const side of sides) side.seeder.activeUntil = s.tick + s.econ.seederDuration;
    return { g, s, blue: sides[0]!, red: sides[1]! };
  }

  it('idle aircraft a storm reaches step out past its edge on their own, exactly mirrored', () => {
    const { s, blue, red } = storm();
    steps(s, 1);
    expect(blue.air.every((e) => harm(s, e) > 0)).toBe(true);
    steps(s, 10 * TICK_RATE);
    for (const e of blue.air) {
      expect(harm(s, e)).toBe(0);
      expect(Math.hypot(e.x - blue.seeder.x, e.y - blue.seeder.y)).toBeGreaterThan(s.econ.seederRadius);
      expect(e.order.k).toBe('none');
      expect(e.evading).toBe(false);
      expect(e.stormOk).toBe(false);
    }
    expect(red.air.map((e) => [s.size - e.x, s.size - e.y])).toEqual(blue.air.map((e) => [e.x, e.y]));
    expect(red.air.map((e) => e.hp)).toEqual(blue.air.map((e) => e.hp));
  });

  it('stays where its own order ended inside the storm, on hold, or with stormEvadeEnabled off (mirrored)', () => {
    const inside = (s: Sim, e: Ent) => Math.hypot(e.x - (e.side === BLUE ? 12 : s.size - 12), e.y - (e.side === BLUE ? 14 : s.size - 14)) < s.econ.seederRadius;
    const cases = {
      // Ordered in: a move that ends inside the formed storm.
      ordered: storm({}, () => {}),
      hold: storm({}, (_s, air) => { for (const e of air) e.stance = 'hold'; }),
      off: storm({ stormEvadeEnabled: false }),
    };
    const { s, blue, red, g } = cases.ordered;
    steps(s, 1);
    for (const [team, side, frame] of [['nw', blue, (x: number) => x], ['se', red, (x: number) => s.size - x]] as const) {
      expect(g.apply({ team, role: 'sky' }, { kind: 'move', units: side.air.map((e) => g.entityId(team, e.id)), x: frame(11), y: frame(15) })).toEqual({ ok: true });
    }
    steps(s, 10 * TICK_RATE);
    for (const e of [...blue.air, ...red.air]) {
      expect(e.order.k).toBe('none');
      expect(inside(s, e)).toBe(true);
      expect(e.stormOk).toBe(true);
    }
    expect(red.air.map((e) => [s.size - e.x, s.size - e.y])).toEqual(blue.air.map((e) => [e.x, e.y]));
    for (const kase of [cases.hold, cases.off]) {
      steps(kase.s, 10 * TICK_RATE);
      for (const e of [...kase.blue.air, ...kase.red.air]) {
        expect(e.order.k).toBe('none');
        expect(inside(kase.s, e)).toBe(true);
      }
      expect(kase.red.air.map((e) => [kase.s.size - e.x, kase.s.size - e.y])).toEqual(kase.blue.air.map((e) => [e.x, e.y]));
    }
  });
});

describe('auto-intercept', () => {
  /**
   * Each army: an idle interceptor posted at (16, 16) and a turret at `turret`; the other army drops a medium rock
   * from (40, 40) in Orbit onto `land` (blue's frame; red's is the point mirror). No spawned rocks, no Spire beams.
   */
  function drop(land: [number, number], turret: [number, number], sky: object = {}, stance: Ent['stance'] = 'aggressive') {
    const g = createGame({ seed: 7, options: { terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0 }, sky: { stormSets: 0, fogRadius: 0, jetWidth: 0, ...sky } } });
    const s = g.sim;
    for (const e of s.ents) if (e.unit) e.dead = true;
    const sides = [[BLUE, RED], [RED, BLUE]].map(([army, foe]) => {
      put(s, army!, 'turret', 'surface', ...turret);
      const e = put(s, army!, 'interceptor', 'sky', 16, 16);
      e.stance = stance;
      e.cd = 1e6;
      const far = army === BLUE ? 40 : s.size - 40;
      const rock = s.add('asteroid', NEUTRAL, 'orbit', far, far);
      rock.state = 'drifting';
      return { e, rock, army: army!, foe: foe! };
    });
    steps(s, 2);
    for (const { rock, army, foe } of sides) {
      expect(s.dropPayload(rock, foe, army === BLUE ? land[0] : s.size - land[0], army === BLUE ? land[1] : s.size - land[1])).toBe(true);
    }
    const posts = sides.map(({ e }) => [e.x, e.y]);
    steps(s, 2 * TICK_RATE);
    return { s, blue: sides[0]!, red: sides[1]!, posts };
  }

  it('an idle interceptor engages a rock falling on its structures within the radius of its post, mirrored', () => {
    const { s, blue, red, posts } = drop([14, 14], [14, 14]);
    expect(blue.e.state).toBe('attacking');
    expect(Math.hypot(blue.e.x - blue.rock.x, blue.e.y - blue.rock.y)).toBeLessThan(Math.hypot(posts[0]![0]! - blue.rock.x, posts[0]![1]! - blue.rock.y));
    expect(blue.e.order.k).toBe('none');
    expect([s.size - red.e.x, s.size - red.e.y]).toEqual([blue.e.x, blue.e.y]);
    expect(red.e.state).toBe(blue.e.state);
  });

  it('stays posted for a rock beyond the radius, one that hits nothing of ours, on hold or when switched off (mirrored)', () => {
    const far = DEFAULT_RULES.sky.autoInterceptRadius + 4;
    for (const { s, blue, red, posts } of [
      drop([16 + far, 16], [16 + far, 16]),
      drop([20, 14], [12, 12]),
      drop([14, 14], [14, 14], {}, 'hold'),
      drop([14, 14], [14, 14], { autoInterceptEnabled: false }),
    ]) {
      expect(blue.e.state).not.toBe('attacking');
      expect([blue.e.x, blue.e.y]).toEqual(posts[0]);
      expect([s.size - red.e.x, s.size - red.e.y]).toEqual([blue.e.x, blue.e.y]);
    }
  });
});

describe('the bots\' gunship comparison (airValue)', () => {
  const { stats } = compileRules(DEFAULT_RULES);
  const value = (kind: 'gunship' | 'interceptor', threats: StatKind[], targets: StatKind[] = []) => airValue(stats, kind, threats, targets);

  it('under flak and turrets a gunship outlasts interceptors per cost: the escort the old 3-flak rule refused', () => {
    const flak: StatKind[] = ['flak', 'flak', 'flak'];
    expect(value('gunship', flak)).toBeGreaterThan(value('interceptor', flak));
    expect(value('gunship', flak) / value('interceptor', flak)).toBeCloseTo((320 / 1.25 / 210) / (120 / 1.5 / 137.5), 6);
    expect(value('gunship', ['turret'])).toBeGreaterThan(value('interceptor', ['turret']));
  });

  it('air-to-air, interceptors out-trade gunships per cost at the default stats (Lanchester)', () => {
    const swarm: StatKind[] = ['interceptor', 'interceptor', 'interceptor', 'interceptor'];
    expect(value('interceptor', swarm, swarm)).toBeGreaterThan(value('gunship', swarm, swarm));
    // 80 HP × 30 dps / 137.5² against 256 × 20 / 210² (per-second figures; the ratio is unit-free).
    expect(value('interceptor', swarm, swarm) / value('gunship', swarm, swarm)).toBeCloseTo((80 * 30 / 137.5 ** 2) / (256 * 20 / 210 ** 2), 6);
  });
});
