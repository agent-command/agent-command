/**
 * Surface wave 1, the Drill Yard and the Breacher (DESIGN §4.2): the yard (build, one per team), `convert` (cost, time,
 * one at a time, yard loss), fog of the conversion, the flamer (×light, ×2 vs dug-in replacing it with no reduction,
 * forward cone splash) and portals. Every sim scenario runs for both armies on point-mirrored layouts and the two
 * results must match.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CELL, DAMAGE_VS, DEFAULT_RULES, type MatchData, type Observation, ECON, STATS, STRUCTURE_SPACING, SURFACE, TRANSITS, toTicks, type ArmyId, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { applyIntent, type AgentCommandIntent } from '../src/agent/intents.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import { createBot } from '../src/bots/bots.ts';
import { entityOut } from '../src/agent/present.ts';
import { DEPLOY_UP, VISION_EVERY } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { cellFor } from '../src/util/grid.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const TEAMS = ['nw', 'se'] as const;
const id = (e: Ent): string => `e_${e.id}`;
const army = (team: ArmyId): number => slotOfArmyId(team, 2);
const foeOf = (team: ArmyId): ArmyId => (team === 'nw' ? 'se' : 'nw');
const act = (g: AgentCommandGame, team: ArmyId, intent: Parameters<typeof applyIntent>[3]) => applyIntent(g.sim, army(team), 'surface', intent);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
/** Step until `done` (or `limit` ticks); the ticks it took. */
function until(g: AgentCommandGame, done: () => boolean, limit = toTicks(60)): number {
  for (let t = 1; t <= limit; t++) {
    g.step();
    if (done()) return t;
  }
  return Infinity;
}

/** Spires (and islands) only, level open ground, plenty of funds. */
function arena(seed = 9): AgentCommandGame {
  // No Spire trickle: resource checks see only what conversions spend.
  const g = createGame({ seed, options: { terrain: 'open', economy: { spireAlloyRate: 0 } } });
  g.sim.terrain.fill(SURFACE.ground);
  g.sim.surfaceCost.fill(1);
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  for (const t of g.sim.armies) {
    t.alloy = 1000;
    t.energy = 1000;
  }
  steps(g, VISION_EVERY);
  return g;
}
/** Blue's point (x, y), or red's point mirror. */
const at = (g: AgentCommandGame, team: ArmyId, x: number, y: number): { x: number; y: number } =>
  team === 'nw' ? { x, y } : { x: g.sim.size - x, y: g.sim.size - y };
/** A `kind` of `owner` (default `team`) at blue point (x, y) when `team` is blue, else at its mirror. */
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, x: number, y: number, owner: ArmyId = team): Ent {
  const e = g.sim.spawnUnit(army(owner), kind, STATS[kind].plane);
  const p = at(g, team, x, y);
  e.x = p.x;
  e.y = p.y;
  e.order = { k: 'none' };
  return e;
}
/** A completed own Drill Yard centred at blue (x, y) (red: its mirror). */
function yard(g: AgentCommandGame, team: ArmyId, x = 12, y = 9): Ent {
  const p = at(g, team, x, y);
  const e = g.sim.add('drill_yard', army(team), 'surface', p.x, p.y);
  e.state = 'idle';
  return e;
}
/** Run `scenario` for both teams; the mirrored results must be identical. */
function mirrored<T>(scenario: (team: ArmyId) => T): T {
  const blue = scenario('nw');
  expect(scenario('se')).toEqual(blue);
  return blue;
}

describe('Breacher and Drill Yard rows', () => {
  it('carry the design numbers, the flamer row and trooper portals', () => {
    const b = STATS.breacher;
    expect([b.hp, b.armor, b.speed, b.range, b.dmg, b.cooldown, b.weapon, b.alloy, b.energy, b.build]).toEqual([120, 'light', 2.5, 1.8, 22, toTicks(1), 'flamer', 40, 20, toTicks(6)]);
    expect(b.targets).toEqual(['surface', 'depths']);
    const y = STATS.drill_yard;
    expect([y.hp, y.alloy, y.energy, y.build, y.footprint]).toEqual([500, 120, 40, toTicks(10), { w: 2, h: 2 }]);
    expect(DAMAGE_VS.flamer.light).toBe(1.5);
    expect(DAMAGE_VS.flamer.structure).toBeGreaterThanOrEqual(1);
    expect(TRANSITS.descend.kinds).toContain('breacher');
    expect(TRANSITS.emerge.kinds).toContain('breacher');
    expect(DEFAULT_RULES.surface).toMatchObject({ breachersEnabled: true, drillYardMax: 1, breacherDugInMultiplier: 2, breacherConeArc: 60 });
    expect(ECON.drillYardMax).toBe(1);
  });
});

describe('Drill Yard construction', () => {
  it('is built from the queue like other Surface structures, at most one per team', () => {
    mirrored((team) => {
      const g = arena();
      const s = g.sim;
      // A clear, visible 2×2 site (plus its spacing ring) at blue min anchor (10, 8).
      const a = team === 'nw' ? { x: 10, y: 8 } : { x: s.size - 12, y: s.size - 10 };
      for (let cy = a.y - STRUCTURE_SPACING; cy < a.y + 2 + STRUCTURE_SPACING; cy++) {
        for (let cx = a.x - STRUCTURE_SPACING; cx < a.x + 2 + STRUCTURE_SPACING; cx++) {
          const c = cy * s.size + cx;
          s.holes[c] = s.block[c] = 0;
          s.vis[1]![c]! |= s.armies[army(team)]!.group.bit;
        }
      }
      const first = act(g, team, { kind: 'queue_add', item: 'drill_yard', ...a });
      // A second is refused while the first is still only queued, and after it stands.
      const queued = act(g, team, { kind: 'queue_add', item: 'drill_yard', x: a.x, y: a.y + 5 });
      const alloy = s.armies[army(team)]!.alloy;
      const ticks = until(g, () => s.ents.some((e) => e.kind === 'drill_yard' && e.side === army(team) && e.built));
      const paid = alloy - s.armies[army(team)]!.alloy;
      const again = act(g, team, { kind: 'queue_add', item: 'drill_yard', x: a.x, y: a.y + 5 });
      return { first, queued, again, ticks: ticks >= STATS.drill_yard.build && ticks <= STATS.drill_yard.build + 2, paid };
    });
  });

  it('cannot be queued when breachersEnabled is off', () => {
    const g = createGame({ seed: 9, options: { terrain: 'open', surface: { breachersEnabled: false } } });
    expect(g.sim.econ.breachersEnabled).toBe(false);
    expect(act(g, 'nw', { kind: 'queue_add', item: 'drill_yard', x: 10, y: 8 })).toEqual({ ok: false, code: 'blocked' });
  });
});

describe.each(TEAMS)('conversion (%s)', (team) => {
  const foe = foeOf(team);

  it('walks in, pays once per Breacher, takes the build time, one at a time, and keeps the HP fraction', () => {
    const g = arena();
    const s = g.sim;
    const y = yard(g, team);
    const a = put(g, team, 'trooper', 12, 13);
    const b = put(g, team, 'trooper', 13, 13);
    a.hp = 50;
    const t = s.armies[army(team)]!;
    expect(act(g, team, { kind: 'convert', units: [id(a), id(b)], to: 'breacher' })).toEqual({ ok: true });
    const alloy0 = t.alloy;
    const energy0 = t.energy;
    // The first Trooper in: one conversion paid, the other waits in line.
    until(g, () => y.link !== 0);
    expect(alloy0 - t.alloy).toBe(STATS.breacher.alloy);
    expect(energy0 - t.energy).toBe(STATS.breacher.energy);
    const first = s.alive(y.link)!;
    expect(first.state).toBe('converting');
    expect(first.hangar).toBe(y.id);
    expect(y.state).toBe('active');
    const took = until(g, () => s.ents.some((e) => e.kind === 'breacher' && e.side === army(team)));
    // The tick it goes in is the first of the build time's ticks of work.
    expect(took).toBe(STATS.breacher.build - 1);
    expect(first.dead).toBe(true);
    const out = s.ents.filter((e) => !e.dead && e.kind === 'breacher' && e.side === army(team));
    expect(out).toHaveLength(1);
    // HP fraction kept: the earlier serial went in first (a: half HP).
    expect(first).toBe(a);
    expect(out[0]!.hp).toBe(out[0]!.maxHp / 2);
    // Then the second, paid only now.
    until(g, () => y.link !== 0);
    expect(alloy0 - t.alloy).toBe(2 * STATS.breacher.alloy);
    until(g, () => s.ents.filter((e) => !e.dead && e.kind === 'breacher' && e.side === army(team)).length === 2);
    expect(t.stats.conversions).toBe(2);
    expect(t.pop).toBe(2);
    expect(y.state).toBe('idle');
    expect(s.ents.some((e) => !e.dead && e.kind === 'trooper' && e.side === army(team))).toBe(false);
  });

  it('hides the Trooper inside and the conversion from enemies who see the yard', () => {
    const g = arena();
    const s = g.sim;
    const y = yard(g, team);
    const a = put(g, team, 'trooper', 12, 12);
    const spy = put(g, team, 'trooper', 16, 9, foe);
    spy.stance = 'hold';
    spy.hp = 1e6;
    spy.maxHp = 1e6;
    expect(act(g, team, { kind: 'convert', units: [id(a)], to: 'breacher' })).toEqual({ ok: true });
    until(g, () => y.link !== 0);
    steps(g, VISION_EVERY);
    expect(s.sees(army(foe), y)).toBe(true);
    expect(s.sees(army(foe), a)).toBe(false);
    const theirs = entityOut(s, y, foe);
    expect(theirs.state).toBe('active');
    expect(theirs.progress).toBeUndefined();
    expect(theirs.link).toBeUndefined();
    const ours = entityOut(s, y, team);
    expect(ours.progress).toBeGreaterThan(0);
    expect(ours.link).toBe(g.entityId(team, a.id));
    expect(entityOut(s, a, team).hangar).toBe(g.entityId(team, y.id));
  });

  it('stops when the yard dies: the Trooper steps out a Trooper and the payment is lost', () => {
    const g = arena();
    const s = g.sim;
    const y = yard(g, team);
    const a = put(g, team, 'trooper', 12, 12);
    const b = put(g, team, 'trooper', 13, 12);
    expect(act(g, team, { kind: 'convert', units: [id(a), id(b)], to: 'breacher' })).toEqual({ ok: true });
    until(g, () => y.link !== 0);
    const t = s.armies[army(team)]!;
    const alloy = t.alloy;
    steps(g, toTicks(2));
    y.hp = 0;
    steps(g, 2);
    expect(a.dead).toBe(false);
    expect(a.kind).toBe('trooper');
    expect(a.hangar).toBe(0);
    expect(a.order.k).toBe('none');
    expect(b.order.k).toBe('none');
    expect(t.alloy).toBe(alloy);
    steps(g, STATS.breacher.build);
    expect(s.ents.some((e) => e.kind === 'breacher')).toBe(false);
    expect(t.stats.conversions).toBe(0);
  });
});

describe.each(TEAMS)('flamer (%s)', (team) => {
  const foe = foeOf(team);

  /** The breacher at blue (20, 24) attacking a hold-stance foe Trooper 1.5 tiles east; HP lost by each body on the first hit. */
  function burn(dugIn: boolean): { target: number; behind: number; beside: number } {
    const g = arena();
    const b = put(g, team, 'breacher', 20, 24);
    const target = put(g, team, 'trooper', 21.5, 24, foe);
    const behind = put(g, team, 'trooper', 22.3, 24, foe);
    const beside = put(g, team, 'trooper', 21.5, 24.9, foe);
    for (const e of [target, behind, beside]) {
      e.stance = 'hold';
      // Unarmed for the measurement: nothing shoots the Breacher, whose first flame is the only damage.
      e.cd = 1e6;
    }
    if (dugIn) target.deploy = DEPLOY_UP;
    steps(g, VISION_EVERY);
    expect(act(g, team, { kind: 'attack', units: [id(b)], target: id(target) })).toEqual({ ok: true });
    until(g, () => target.hp < target.maxHp);
    return { target: target.maxHp - target.hp, behind: behind.maxHp - behind.hp, beside: beside.maxHp - beside.hp };
  }

  it('deals ×1.5 vs light, and its cone splashes only in front of it', () => {
    const r = burn(false);
    expect(r.target).toBeCloseTo(STATS.breacher.dmg * 1.5, 9);
    expect(r.behind).toBeCloseTo(STATS.breacher.dmg * ECON.splashFactor * 1.5, 9);
    expect(r.beside).toBe(0);
  });

  it('deals exactly ×2 vs a dug-in Trooper (no ×1.5, no dug-in reduction)', () => {
    const r = burn(true);
    expect(r.target).toBeCloseTo(STATS.breacher.dmg * ECON.breacherDugInMultiplier, 9);
  });

  it('uses portals like a Trooper (down and up an own built Shaft)', () => {
    const g = arena();
    const s = g.sim;
    const p = at(g, team, 12, 9);
    const shaft = s.add('shaft', army(team), 'surface', p.x, p.y);
    // The tunnel a completed Shaft opens below itself, plus the cell beside it toward the map centre (an unsealed
    // landing), both known to its army.
    const c = cellFor(s.armyFrame[army(team)]!, shaft.x, shaft.y, s.size);
    for (const cell of [c, c + (team === 'nw' ? 1 : -1)]) {
      s.cells[cell] = CELL.tunnel;
      s.owner[cell] = army(team) + 1;
      s.armies[army(team)]!.group.known[cell] = CELL.tunnel;
    }
    s.depthsVersion++;
    const b = put(g, team, 'breacher', 12, 12);
    steps(g, VISION_EVERY);
    expect(act(g, team, { kind: 'transfer', units: [id(b)], to: 'depths', x: shaft.x, y: shaft.y })).toEqual({ ok: true });
    expect(until(g, () => b.plane === 'depths', toTicks(10))).toBeLessThan(Infinity);
    expect(applyIntent(s, army(team), 'depths', { kind: 'transfer', units: [id(b)], to: 'surface', x: shaft.x, y: shaft.y })).toEqual({ ok: true });
    expect(until(g, () => b.plane === 'surface', toTicks(10))).toBeLessThan(Infinity);
  });
});

describe('convert validation', () => {
  it('takes Troopers only, needs an own built yard', () => {
    const g = arena();
    const tank = put(g, 'nw', 'tank', 12, 12);
    const trooper = put(g, 'nw', 'trooper', 13, 12);
    expect(act(g, 'nw', { kind: 'convert', units: [id(trooper)], to: 'breacher' })).toEqual({ ok: false, code: 'invalid_target' });
    const y = yard(g, 'nw');
    const theirs = yard(g, 'se');
    expect(act(g, 'nw', { kind: 'convert', units: [id(tank)], to: 'breacher' })).toEqual({ ok: false, code: 'wrong_kind' });
    expect(act(g, 'nw', { kind: 'convert', units: [id(trooper)], to: 'breacher', yard: id(theirs) })).toEqual({ ok: false, code: 'invalid_target' });
    y.built = false;
    expect(act(g, 'nw', { kind: 'convert', units: [id(trooper)], to: 'breacher', yard: id(y) })).toEqual({ ok: false, code: 'blocked' });
  });
});

/** One Surface decision of a built-in bot tier or the example policy, from `team`'s fogged observation now. */
function decide(mode: 'standard' | 'veteran' | 'policy', g: AgentCommandGame, team: ArmyId): AgentCommandIntent[] {
  const data: MatchData = g.matchData({ team, role: 'surface' });
  const obs: Observation = g.observe({ team, role: 'surface' }, 0);
  if (mode === 'policy') {
    return structuredClone((runInNewContext(`${STARTER_POLICIES.surface}\ninit(bootstrap);\nthink;`, { bootstrap: data, log() {} }) as (o: Observation) => AgentCommandIntent[])(obs));
  }
  const bot = createBot(team, 'surface', mode);
  bot.init?.(data);
  return bot.think(obs);
}

for (const mode of ['standard', 'veteran', 'policy'] as const) describe(`Drill Yard play: ${mode}`, () => {
  /** Sixteen of `team`'s troopers by the yard spot (posts and scouts may take a few) and one dug-in foe Trooper in their sight. */
  function scene(team: ArmyId): { g: AgentCommandGame; foe: Ent } {
    const g = arena();
    for (let i = 0; i < 10; i++) put(g, team, 'trooper', 6 + i, 12);
    for (let i = 0; i < 6; i++) put(g, team, 'trooper', 6 + i, 10);
    const foe = put(g, team, 'trooper', 11, 16, foeOf(team));
    foe.stance = 'hold';
    steps(g, VISION_EVERY);
    foe.deploy = DEPLOY_UP;
    foe.state = 'dug_in';
    return { g, foe };
  }

  it('builds a Drill Yard on seeing a dug-in Trooper, converts troopers there, and burns the foxhole with Breachers', () => {
    mirrored((team) => {
      const { g, foe } = scene(team);
      const build = decide(mode, g, team).find((i) => i.kind === 'queue_add' && i.item === 'drill_yard');
      expect(build).toBeDefined();
      const site = build as Extract<AgentCommandIntent, { kind: 'queue_add' }>;
      expect(act(g, team, site)).toEqual({ ok: true });
      // The yard stands: a trooper is sent in.
      const y = yard(g, team, 4, 14);
      const convert = decide(mode, g, team).find((i) => i.kind === 'convert');
      expect(convert).toMatchObject({ to: 'breacher', yard: g.entityId(team, y.id) });
      // A Breacher by the foxhole goes for it.
      const b = put(g, team, 'breacher', 11, 14);
      steps(g, VISION_EVERY);
      foe.deploy = DEPLOY_UP;
      foe.state = 'dug_in';
      expect(decide(mode, g, team)).toContainEqual(expect.objectContaining({ kind: 'attack', units: expect.arrayContaining([g.entityId(team, b.id)]), target: g.entityId(team, foe.id) }));
      return { site: team === 'nw' ? [site.x, site.y] : [g.sim.size - 2 - site.x!, g.sim.size - 2 - site.y!] };
    });
  });

  it('leaves the Drill Yard alone when breachersEnabled is off', () => {
    const g = createGame({ seed: 9, options: { terrain: 'open', surface: { breachersEnabled: false } } });
    for (let i = 0; i < 6; i++) put(g, 'nw', 'trooper', 8 + i, 12);
    const foe = put(g, 'nw', 'trooper', 11, 16, 'se');
    steps(g, VISION_EVERY);
    foe.deploy = DEPLOY_UP;
    foe.state = 'dug_in';
    expect(decide(mode, g, 'nw').some((i) => (i.kind === 'queue_add' && i.item === 'drill_yard') || i.kind === 'convert')).toBe(false);
  });
});
