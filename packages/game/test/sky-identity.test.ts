/** Sky identity: the Gunship, island structure armour, storms blinding ground fire. */
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/agent/adapter.ts';
import { DAMAGE_VS, ISLAND_STRUCTURES } from '../src/rules/contract.ts';
import { slotOfArmyId } from '../src/util/teams.ts';
import type { Ent } from '../src/sim/ent.ts';
import type { Sim } from '../src/sim/sim.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);

/** No natural weather, no starting units: only what a case adds. */
function bare(options: object = {}) {
  const g = createGame({ seed: 7, options: { terrain: 'open', sky: { stormSets: 0, fogRadius: 0, jetWidth: 0 }, ...options } });
  for (const e of g.sim.ents) if (e.unit) e.dead = true;
  g.sim.armies[BLUE]!.alloy = g.sim.armies[RED]!.alloy = 5000;
  g.sim.armies[BLUE]!.energy = g.sim.armies[RED]!.energy = 5000;
  return g;
}
/** `kind` of `army` at (x, y) in the frame of `frame` (blue: as given; red: point-mirrored). */
function put(s: Sim, army: number, kind: Parameters<Sim['add']>[0], x: number, y: number, frame = army): Ent {
  const e = frame === BLUE ? s.add(kind, army, 'sky', x, y) : s.add(kind, army, 'sky', s.size - x, s.size - y);
  e.built = true;
  return e;
}

describe('Gunship', () => {
  it('is heavy air: flak and missiles ×1.25 (×1.5 vs air), everything else ×1', () => {
    expect(DAMAGE_VS.flak.heavy_air).toBe(1.25);
    expect(DAMAGE_VS.missile.heavy_air).toBe(1.25);
    expect(DAMAGE_VS.flak.air).toBe(1.5);
    expect(DAMAGE_VS.missile.air).toBe(1.5);
    for (const w of ['rifle', 'cannon', 'bomb', 'beam', 'turret', 'pick', 'point_defence', 'shotgun'] as const) expect(DAMAGE_VS[w].heavy_air).toBe(1);
    const g = bare();
    const gun = put(g.sim, BLUE, 'gunship', 20, 20);
    expect(g.sim.armorOf(gun)).toBe('heavy_air');
    expect(gun.maxHp).toBe(g.sim.stats.gunship.hp);
  });

  it('flak takes 19 shots for a gunship against 6 for an interceptor, which stays the weaker per cost', () => {
    const { flak, gunship, interceptor } = bare().sim.stats;
    const shots = (hp: number, armor: 'air' | 'heavy_air') => Math.ceil(hp / (flak.dmg * DAMAGE_VS.flak[armor]));
    expect(shots(gunship.hp, 'heavy_air')).toBe(19);
    expect(shots(interceptor.hp, 'air')).toBe(6);
    // HP per cost (alloy + 1.5 energy) under flak: 1.22 against 0.59, about 2.1×.
    const hold = (s: typeof gunship, armor: 'air' | 'heavy_air') => s.hp / DAMAGE_VS.flak[armor] / (s.alloy + 1.5 * s.energy);
    expect(hold(gunship, 'heavy_air') / hold(interceptor, 'air')).toBeCloseTo(2.057, 3);
  });

  it('is queued at the Sky segment and refused when gunshipEnabled is off', () => {
    const on = bare();
    expect(on.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'gunship' })).toEqual({ ok: true });
    const off = bare({ sky: { stormSets: 0, gunshipEnabled: false } });
    expect(off.apply({ team: 'nw', role: 'sky' }, { kind: 'queue_add', item: 'gunship' })).toMatchObject({ ok: false, code: 'blocked' });
  });

  // Missiles hit heavy_air ×1.25, so twice as many interceptors (540 against 420 cost-equivalent) do not fall to
  // the gunships; the invariant is the brawl itself: unit for unit, gunships win
  // where interceptors close (per cost at range interceptors out-trade them: the airValue tests).
  it('beats as many interceptors as it has gunships when they close to its range (mirrored)', () => {
    const g = bare();
    const s = g.sim;
    const fight = (army: number, foe: number) => {
      const guns = [put(s, army, 'gunship', 14, 14), put(s, army, 'gunship', 14, 15)];
      const pack = guns.map((_, i) => put(s, foe, 'interceptor', 15.5, 14 + i * 0.6, army));
      for (const e of [...guns, ...pack]) e.stance = 'hold';
      return { guns, pack };
    };
    const blue = fight(BLUE, RED);
    const red = fight(RED, BLUE);
    for (let t = 0; t < 20 * 60 && blue.pack.some((e) => !e.dead); t++) s.step();
    expect(blue.pack.every((e) => e.dead || e.hp <= 0)).toBe(true);
    expect(blue.guns.some((e) => !e.dead && e.hp > 0)).toBe(true);
    expect(blue.guns.map((e) => e.hp)).toEqual(red.guns.map((e) => e.hp));
  });

  it('dies to equal-cost flak, which it cannot shoot back (mirrored)', () => {
    const g = bare();
    const s = g.sim;
    const duel = (army: number, foe: number) => {
      const gun = put(s, army, 'gunship', 20, 20);
      gun.stance = 'hold';
      const flak = [0, 1].map((i) => {
        const f = army === BLUE ? s.add('flak', foe, 'surface', 20 + i, 22) : s.add('flak', foe, 'surface', s.size - 20 - i, s.size - 22);
        f.built = true;
        f.stance = 'hold';
        return f;
      });
      return { gun, flak };
    };
    const blue = duel(BLUE, RED);
    const red = duel(RED, BLUE);
    for (let t = 0; t < 20 * 60 && !blue.gun.dead; t++) s.step();
    expect(blue.gun.dead || blue.gun.hp <= 0).toBe(true);
    expect(red.gun.dead || red.gun.hp <= 0).toBe(true);
    expect(blue.flak.every((f) => f.hp === f.maxHp)).toBe(true);
  });
});

describe('island structure armour', () => {
  it('every island structure is island-armoured: turret ×0.25, flak ×0.35, missile ×0.75', () => {
    expect(DAMAGE_VS.turret.island).toBe(0.25);
    expect(DAMAGE_VS.flak.island).toBe(0.35);
    expect(DAMAGE_VS.missile.island).toBe(0.75);
    const g = bare();
    for (const kind of ISLAND_STRUCTURES) expect(g.sim.armorOf(put(g.sim, BLUE, kind, 10, 10))).toBe('island');
    const off = bare({ sky: { stormSets: 0, islandArmorEnabled: false } });
    for (const kind of ISLAND_STRUCTURES) expect(off.sim.armorOf(put(off.sim, BLUE, kind, 10, 10))).toBe('structure');
  });
});

describe('ground fire and island structures (sky.groundHitsIslandStructures)', () => {
  /** Under `army`'s Relay, Gun Platform and Interceptor (on hold): a hostile turret and two flak, in `army`'s frame. */
  const range = (s: Sim, army: number, foe: number) => {
    const relay = put(s, army, 'relay', 10, 10);
    const platform = put(s, army, 'gun_platform', 10, 16);
    const air = put(s, army, 'interceptor', 16, 10);
    const beside = put(s, army, 'relay', 16.6, 10);
    for (const e of [platform, air]) e.stance = 'hold';
    const ground = ([['turret', 10, 12], ['flak', 11, 11], ['flak', 12, 14]] as const).map(([kind, x, y]) => {
      const f = army === BLUE ? s.add(kind, foe, 'surface', x, y) : s.add(kind, foe, 'surface', s.size - x, s.size - y);
      f.built = true;
      f.stance = 'hold';
      return f;
    });
    return { relay, platform, air, beside, ground };
  };

  it('off (default): turrets and flak never target or splash island structures, but hit Gun Platforms and aircraft (mirrored)', () => {
    const s = bare().sim;
    expect(s.econ.groundHitsIslandStructures).toBe(false);
    const blue = range(s, BLUE, RED);
    const red = range(s, RED, BLUE);
    for (const side of [blue, red]) for (const g of side.ground) {
      expect(s.isTarget(g, side.relay)).toBe(false);
      expect(s.isTarget(g, side.beside)).toBe(false);
      expect(s.isTarget(g, side.platform)).toBe(true);
      expect(s.isTarget(g, side.air)).toBe(true);
    }
    for (let t = 0; t < 20 * 20; t++) s.step();
    for (const side of [blue, red]) {
      expect(side.relay.hp).toBe(side.relay.maxHp);
      // Flak bursts on the Interceptor beside it: the splash skips the Relay too.
      expect(side.beside.hp).toBe(side.beside.maxHp);
      expect(side.platform.hp).toBeLessThan(side.platform.maxHp);
      expect(side.air.dead || side.air.hp < side.air.maxHp).toBe(true);
    }
    expect([blue.platform.hp, blue.air.hp]).toEqual([red.platform.hp, red.air.hp]);
  });

  it('on: they target and splash island structures again at the island armour (mirrored)', () => {
    const s = bare({ sky: { stormSets: 0, fogRadius: 0, jetWidth: 0, groundHitsIslandStructures: true } }).sim;
    const blue = range(s, BLUE, RED);
    const red = range(s, RED, BLUE);
    for (const side of [blue, red]) for (const g of side.ground) expect(s.isTarget(g, side.relay)).toBe(true);
    for (let t = 0; t < 20 * 20; t++) s.step();
    for (const side of [blue, red]) {
      expect(side.relay.hp).toBeLessThan(side.relay.maxHp);
      expect(side.beside.hp).toBeLessThan(side.beside.maxHp);
    }
    expect([blue.relay.hp, blue.beside.hp]).toEqual([red.relay.hp, red.beside.hp]);
  });
});

describe('storms and fire from below', () => {
  it('a storm hides Sky targets from turrets and flak unless scanned; Spire beams ignore it', () => {
    const g = bare();
    const s = g.sim;
    const target = put(s, RED, 'interceptor', 20, 20);
    const turret = s.add('turret', BLUE, 'surface', 20, 22);
    turret.built = true;
    const flak = s.add('flak', BLUE, 'surface', 21, 21);
    expect(s.lineOfFire(turret, target)).toBe(true);
    expect(s.lineOfFire(flak, target)).toBe(true);
    s.weather.seed(0, target.x, target.y, 3, s.tick + 100, RED);
    s.weather.finishSeeds(1, 0);
    s.weather.refreshMask();
    expect(s.lineOfFire(turret, target)).toBe(false);
    expect(s.lineOfFire(flak, target)).toBe(false);
    expect(s.lineOfFire(s.armies[BLUE]!.spire.sky, target)).toBe(true);
  });
});
