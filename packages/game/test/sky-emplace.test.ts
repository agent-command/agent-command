/** Island hardpoints and the emplaced Gunship (Gun Platform); the Gunship's free turret. */
import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { slotOfArmyId, type ArmyId } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';

const BLUE = slotOfArmyId('nw', 2);
const RED = slotOfArmyId('se', 2);
const id = (g: AgentCommandGame, team: ArmyId, e: Ent) => g.entityId(team, e.id);

/** Inner-ring mirrored island pair, blue holds `mine`, red holds `theirs`; no starting units, no weather. */
function arena(sky: object = {}) {
  const g = createGame({ seed: 5, options: { terrain: 'open', sky: { stormSets: 0, fogRadius: 0, jetWidth: 0, ...sky } } });
  const s = g.sim;
  for (const e of s.ents) if (e.unit) e.dead = true;
  g.step();
  const islands = s.ents.filter((e) => e.kind === 'island');
  const inner = Math.min(...islands.map((i) => i.orbitR));
  const [mine, theirs] = islands.filter((i) => i.orbitR === inner).sort((a, b) => a.id - b.id) as [Ent, Ent];
  s.setSide(mine, BLUE);
  s.setSide(theirs, RED);
  for (const a of [BLUE, RED]) { s.armies[a]!.energy = 5000; s.armies[a]!.alloy = 5000; }
  return { g, s, mine, theirs };
}
function gunship(g: AgentCommandGame, army: number, isl: Ent): Ent {
  const u = g.sim.spawnUnit(army, 'gunship', 'sky');
  u.x = isl.x;
  u.y = isl.y;
  return u;
}
const own = (team: ArmyId, s: AgentCommandGame['sim'], a: Ent, b: Ent) => team === 'nw' ? a : b;

describe('emplace', () => {
  it('converts a Gunship into a Gun Platform on the island hardpoint, keeping its HP fraction (mirrored)', () => {
    const { g, s, mine, theirs } = arena();
    const plats: Ent[] = [];
    for (const team of ['nw', 'se'] as const) {
      const isl = own(team, s, mine, theirs);
      const gun = gunship(g, slotOfArmyId(team, 2), isl);
      gun.hp = gun.maxHp / 2;
      const pop = s.armies[gun.side]!.pop;
      expect(g.apply({ team, role: 'sky' }, { kind: 'emplace', unit: id(g, team, gun), island: id(g, team, isl) })).toEqual({ ok: true });
      expect(gun.dead).toBe(true);
      expect(s.armies[gun.side]!.pop).toBe(pop - 1);
      const p = s.alive(isl.hardpoint)!;
      expect(p.kind).toBe('gun_platform');
      expect(p.hp).toBe(p.maxHp / 2);
      expect(g.apply({ team, role: 'sky' }, { kind: 'emplace', unit: id(g, team, gunship(g, slotOfArmyId(team, 2), isl)), island: id(g, team, isl) })).toMatchObject({ ok: false, code: 'occupied' });
      plats.push(p);
    }
    for (let i = 0; i < 40; i++) g.step();
    expect([plats[0]!.x, plats[0]!.y]).toEqual([mine.x, mine.y]);
    expect(plats[1]!.x).toBe(s.size - plats[0]!.x);
    const path = g.observe({ team: 'se', role: 'sky' }, 0).islands.find((p) => p.id === id(g, 'se', mine))!;
    expect(path.hardpoint).toEqual({ kind: 'gun_platform', side: 'nw' });
  });

  it('refuses enemy islands, distant gunships and the off toggle', () => {
    const { g, s, mine, theirs } = arena();
    const gun = gunship(g, BLUE, mine);
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'emplace', unit: id(g, 'nw', gun), island: id(g, 'nw', theirs) })).toMatchObject({ ok: false });
    gun.x = mine.x + s.econ.captureRadius + 1;
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'emplace', unit: id(g, 'nw', gun), island: id(g, 'nw', mine) })).toMatchObject({ ok: false, code: 'invalid_target' });
    const off = arena({ gunshipEmplaceEnabled: false });
    expect(off.g.apply({ team: 'nw', role: 'sky' }, { kind: 'emplace', unit: id(off.g, 'nw', gunship(off.g, BLUE, off.mine)), island: id(off.g, 'nw', off.mine) })).toMatchObject({ ok: false, code: 'blocked' });
    const none = arena({ islandHardpoints: 0 });
    expect(none.g.apply({ team: 'nw', role: 'sky' }, { kind: 'emplace', unit: id(none.g, 'nw', gunship(none.g, BLUE, none.mine)), island: id(none.g, 'nw', none.mine) })).toMatchObject({ ok: false, code: 'blocked' });
  });

  it('blocks a hostile capture while it lives; the island falls once it is destroyed (mirrored)', () => {
    const { g, s, mine, theirs } = arena();
    for (const team of ['nw', 'se'] as const) {
      const isl = own(team, s, mine, theirs);
      expect(g.apply({ team, role: 'sky' }, { kind: 'emplace', unit: id(g, team, gunship(g, slotOfArmyId(team, 2), isl)), island: id(g, team, isl) })).toEqual({ ok: true });
    }
    // Deep-hulled hostile interceptors sit on each island (they and the platform trade fire; the platform is kept alive).
    const raiders: Ent[] = [];
    for (const [army, isl] of [[RED, mine], [BLUE, theirs]] as const) {
      const u = g.sim.spawnUnit(army, 'interceptor', 'sky');
      u.x = isl.x; u.y = isl.y; u.hp = 1e6; u.cd = 1e9;
      raiders.push(u);
    }
    const plats = [s.alive(mine.hardpoint)!, s.alive(theirs.hardpoint)!];
    for (let t = 0; t < s.econ.captureTicks * 2; t++) {
      for (const p of plats) p.hp = p.maxHp;
      g.step();
      for (const u of raiders) { u.x = u === raiders[0] ? mine.x : theirs.x; u.y = u === raiders[0] ? mine.y : theirs.y; }
    }
    expect(mine.side).toBe(BLUE);
    expect(mine.state).toBe('contested');
    expect(theirs.state).toBe('contested');
    for (const p of plats) s.damage(p, p.hp + 1, p.side === BLUE ? RED : BLUE);
    for (let t = 0; t < s.econ.captureTicks + 2; t++) {
      g.step();
      for (const u of raiders) { u.x = u === raiders[0] ? mine.x : theirs.x; u.y = u === raiders[0] ? mine.y : theirs.y; }
    }
    expect(mine.side).toBe(RED);
    expect(theirs.side).toBe(BLUE);
  });

  it('is a structure: storms do not hurt it, it never moves off its island, flak hits it at full damage', () => {
    const { g, s, mine } = arena();
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'emplace', unit: id(g, 'nw', gunship(g, BLUE, mine)), island: id(g, 'nw', mine) })).toEqual({ ok: true });
    const p = s.alive(mine.hardpoint)!;
    expect(p.structure).toBe(true);
    expect(s.armorOf(p)).toBe('heavy_air');
    s.weather.seed(0, mine.x, mine.y, 4, s.tick + 1000, RED);
    s.weather.finishSeeds(1, 0);
    const hp = p.hp;
    s.step();
    expect(p.hp).toBe(hp);
  });

  it('out-ranges the Gunship by emplaceRangeBonus', () => {
    const { g, s, mine } = arena();
    const gun = gunship(g, BLUE, mine);
    expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'emplace', unit: id(g, 'nw', gun), island: id(g, 'nw', mine) })).toEqual({ ok: true });
    const p = s.alive(mine.hardpoint)!;
    const foe = g.sim.spawnUnit(RED, 'interceptor', 'sky');
    foe.x = p.x + 1;
    foe.y = p.y;
    const fresh = gunship(g, BLUE, mine);
    expect(s.reach(p, foe) - s.reach(fresh, foe)).toBeCloseTo(s.econ.emplaceRangeBonus, 9);
  });

  for (const team of ['nw', 'se'] as const) for (const distance of [4, 4.6]) {
    it(`automatically acquires only inside the emplace bonus band (${team}, ${distance} tiles)`, () => {
      const { g, s, mine, theirs } = arena();
      const isl = own(team, s, mine, theirs), army = slotOfArmyId(team, 2);
      const gun = gunship(g, army, isl);
      expect(g.apply({ team, role: 'sky' }, { kind: 'emplace', unit: id(g, team, gun), island: id(g, team, isl) })).toEqual({ ok: true });
      const p = s.alive(isl.hardpoint)!;
      const foe = s.spawnUnit(army === BLUE ? RED : BLUE, 'interceptor', 'sky');
      foe.stance = 'hold'; foe.cd = 1e9;
      const sign = team === 'nw' ? 1 : -1;
      foe.x = isl.x + sign * distance; foe.y = isl.y;
      const hp = foe.hp;
      expect(s.stat(p).range).toBe(3);
      expect(s.econ.emplaceRangeBonus).toBe(1);
      expect(s.stat(foe).range).toBe(5);
      expect(s.reach(p, foe)).toBeCloseTo(4 + foe.radius, 9);
      expect(s.rangeBonus(p, foe)).toBe(1);
      expect(s.maxRangeBonus(p)).toBe(1);
      // No attack order: this must exercise the structure's automatic acquisition, not just reach().
      // Keep the target outside base range as the island drifts; holding prevents either unit closing the gap.
      let acquired = false;
      for (let tick = 0; tick < 60; tick++) {
        foe.x = isl.x + sign * distance; foe.y = isl.y;
        g.step();
        acquired ||= s.acquire(p, s.stat(p).range, false)?.id === foe.id;
        expect(Math.hypot(foe.x - p.x, foe.y - p.y)).toBeGreaterThan(s.stat(p).range + foe.radius);
      }
      expect(acquired).toBe(distance === 4);
      if (distance === 4) expect(foe.hp).toBeLessThan(hp);
      else expect(foe.hp).toBe(hp);
    });
  }
});

describe('Gunship turret', () => {
  it('fires behind itself while flying away; an interceptor (forward mount) cannot', () => {
    const { g, s } = arena();
    const fire = (kind: 'gunship' | 'interceptor') => {
      const u = s.spawnUnit(BLUE, kind, 'sky');
      u.x = 20; u.y = 24; u.hp = 1e6;
      const t = s.spawnUnit(RED, 'gunship', 'sky');
      t.x = 18; t.y = 24; t.hp = 1e6; t.cd = 1e9;
      expect(g.apply({ team: 'nw', role: 'sky' }, { kind: 'move', units: [id(g, 'nw', u)], x: 40, y: 24 })).toEqual({ ok: true });
      for (let i = 0; i < 6; i++) { g.step(); t.x = u.x - 2; t.y = u.y; }
      const hp = t.hp;
      for (let i = 0; i < 20; i++) { g.step(); t.x = u.x - 2; t.y = u.y; }
      const fired = t.hp < hp;
      u.dead = true; t.dead = true;
      return fired;
    };
    expect(fire('gunship')).toBe(true);
    expect(fire('interceptor')).toBe(false);
  });
});
