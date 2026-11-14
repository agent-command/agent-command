/**
 * The crowns loss rule (rules.spire.lossRule 'crowns', DESIGN §2): crown values, elimination by the Surface alone or
 * two side segments, the kill and the deciding plane, public crowns, segment rebuild, time-cap ranking, the fog-safe
 * segment_threatened alert and the bots' weakest crown. Every scenario runs for every army of a C2 duel and a C4
 * four-corner match, so the rule is the same in every frame.
 */
import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { Ctx, chooseFocus, type SpireMemory } from '../src/bots/context.ts';
import { CROWNS_SPIRE_HP, DEFAULT_RULES, SPIRE_HP, resolveRules, unpackTerrain, type ArmyId, type MatchOptions, type Plane } from '../src/rules/contract.ts';
import type { Sim } from '../src/sim/sim.ts';

const CROWNS: MatchOptions = { spire: { lossRule: 'crowns' } };
const LAYOUTS = {
  C2: (options: MatchOptions) => createGame({ seed: 7, options }),
  C4: (options: MatchOptions) => createGame({ seed: 7, options: { ...options, map: { name: 'four_corners' } } }),
} as const;

/** Every (layout, victim army index) pair, the attacker being the next army. */
function cases(options: MatchOptions): { name: string; g: AgentCommandGame; victim: number; by: number }[] {
  const out: { name: string; g: AgentCommandGame; victim: number; by: number }[] = [];
  for (const [layout, make] of Object.entries(LAYOUTS)) {
    const armies = make(options).sim.allArmies.length;
    for (let victim = 0; victim < armies; victim++) out.push({ name: `${layout} army ${victim}`, g: make(options), victim, by: (victim + 1) % armies });
  }
  return out;
}

/** Knock `army`'s `plane` segment down with a hit from `by` (removed at the next step). */
function down(sim: Sim, army: number, plane: Plane, by: number): void {
  const seg = sim.armies[army]!.spire[plane];
  sim.damage(seg, seg.hp + 1, by, true, 'test');
}

const idOf = (g: AgentCommandGame, army: number): ArmyId => g.sim.armyIds[army]!;
const observe = (g: AgentCommandGame, army: number, role: Plane = 'surface') => g.observe({ team: idOf(g, army), role }, 0);

describe('crowns rules', () => {
  it('defaults to the surface rule and gives side segments the Surface\'s HP in pairs under crowns', () => {
    expect(DEFAULT_RULES.spire.lossRule).toBe('surface');
    expect(DEFAULT_RULES.spire.hp).toEqual(SPIRE_HP);
    const crowns = resolveRules(CROWNS);
    expect(crowns.spire.hp).toEqual(CROWNS_SPIRE_HP);
    expect(crowns.spire.hp.sky + crowns.spire.hp.orbit).toBe(crowns.spire.hp.surface);
    // An explicit HP still wins over the crowns default.
    expect(resolveRules({ spire: { lossRule: 'crowns', hp: { sky: 1000 } } }).spire.hp.sky).toBe(1000);
  });
});

describe('crowns elimination', () => {
  for (const { name, g, victim, by } of cases(CROWNS)) {
    it(`${name}: one side segment is a public crown, the second side segment eliminates`, () => {
      const sim = g.sim;
      down(sim, victim, 'sky', by);
      g.step();
      expect(sim.inPlay(victim)).toBe(true);
      for (const a of sim.allArmies) {
        const obs = observe(g, a);
        expect(obs.crowns?.find((r) => r.army === idOf(g, victim))).toEqual({ army: idOf(g, victim), lost: 1, fallen: ['sky'] });
        expect(obs.events.filter((e) => e.kind === 'crown_lost')).toMatchObject([{ side: idOf(g, victim), plane: 'sky', killer: idOf(g, by) }]);
      }
      down(sim, victim, 'orbit', by);
      g.step();
      expect(sim.inPlay(victim)).toBe(false);
      expect(sim.eliminatedBy[victim]).toBe(by);
      const fell = observe(g, by).events.filter((e) => e.kind === 'army_eliminated');
      expect(fell).toMatchObject([{ side: idOf(g, victim), killer: idOf(g, by), plane: 'orbit' }]);
      // The crowns row is frozen as it fell, though its remains were removed.
      expect(observe(g, by).crowns?.find((r) => r.army === idOf(g, victim))).toEqual({ army: idOf(g, victim), lost: 2, fallen: ['sky', 'orbit'] });
    });
  }

  for (const { name, g, victim, by } of cases(CROWNS)) {
    it(`${name}: the Surface alone eliminates`, () => {
      down(g.sim, victim, 'surface', by);
      g.step();
      expect(g.sim.inPlay(victim)).toBe(false);
      expect(g.sim.eliminatedBy[victim]).toBe(by);
      expect(observe(g, by).events.find((e) => e.kind === 'army_eliminated')?.plane).toBe('surface');
    });
  }

  for (const { name, g, victim, by } of cases({})) {
    it(`${name}: under the surface rule side segments never eliminate and crowns stay private`, () => {
      down(g.sim, victim, 'sky', by);
      down(g.sim, victim, 'orbit', by);
      g.step();
      expect(g.sim.inPlay(victim)).toBe(true);
      const obs = observe(g, by);
      expect(obs.crowns).toBeUndefined();
      expect(obs.events.some((e) => e.kind === 'crown_lost')).toBe(false);
      down(g.sim, victim, 'surface', by);
      g.step();
      expect(g.sim.inPlay(victim)).toBe(false);
      expect(g.sim.eliminatedBy[victim]).toBe(by);
    });
  }
});

describe('segment rebuild', () => {
  for (const { name, g, victim, by } of cases(CROWNS)) {
    it(`${name}: a rebuild returns the segment at rebuildHp and its crown, once per match`, () => {
      const sim = g.sim;
      const seat = { team: idOf(g, victim), role: 'sky' } as const;
      down(sim, victim, 'sky', by);
      g.step();
      // Clear the sky around the Spire of every hostile unit, so nothing blocks the rebuild (enemy_near).
      for (const e of sim.ents) if (e.plane === 'sky' && e.unit && e.side !== victim) e.dead = true;
      sim.cleanup();
      sim.armies[victim]!.alloy = sim.econ.rebuildAlloy;
      sim.armies[victim]!.energy = sim.econ.rebuildEnergy;
      // A standing segment cannot be rebuilt, asked by its own seat; another seat may not ask at all.
      expect(g.apply({ ...seat, role: 'surface' }, { kind: 'queue_add', item: 'rebuild', plane: 'surface' })).toMatchObject({ ok: false, code: 'segment_standing' });
      expect(g.apply(seat, { kind: 'queue_add', item: 'rebuild', plane: 'surface' })).toMatchObject({ ok: false, code: 'wrong_plane' });
      expect(g.apply(seat, { kind: 'queue_add', item: 'rebuild' })).toMatchObject({ ok: true });
      expect(g.apply(seat, { kind: 'queue_add', item: 'rebuild' })).toMatchObject({ ok: false, code: 'rebuild_used' });
      for (let i = 0; i <= sim.econ.rebuildTicks + 1; i++) g.step();
      const seg = sim.armies[victim]!.spire.sky;
      expect(seg.hp).toBe(Math.ceil(seg.maxHp * sim.econ.rebuildHp));
      expect(sim.crownsLost(victim)).toBe(0);
      expect(observe(g, victim).res.rebuilds).toBe(0);
      expect(observe(g, by).events.some((e) => e.kind === 'segment_rebuilt' && e.side === idOf(g, victim))).toBe(true);
      // The crown is back: one more side segment is not enough.
      down(sim, victim, 'orbit', by);
      g.step();
      expect(sim.inPlay(victim)).toBe(true);
      down(sim, victim, 'depths', by);
      g.step();
      expect(sim.inPlay(victim)).toBe(false);
    });
  }
});

describe('time-cap ranking', () => {
  for (const { name, g, victim, by } of cases({ ...CROWNS, spire: { lossRule: 'crowns', timeCap: 60 } })) {
    it(`${name}: under crowns fewer crowns lost beats more Spire HP`, () => {
      const sim = g.sim;
      down(sim, victim, 'sky', by);
      g.step();
      // Every other army keeps all its crowns but much less total HP than the victim.
      for (const a of sim.allArmies) if (a !== victim) sim.armies[a]!.spire.surface.hp = 100;
      sim.tick = sim.timeCap - 1;
      g.step();
      expect(sim.result?.outcome[victim]).toBe('loss');
      expect(sim.result?.rank[victim]).toBe(sim.allArmies.length);
    });
  }

  for (const { name, g, victim, by } of cases({ spire: { timeCap: 60 } })) {
    it(`${name}: under the surface rule more total Spire HP still decides`, () => {
      const sim = g.sim;
      down(sim, victim, 'sky', by);
      g.step();
      for (const a of sim.allArmies) if (a !== victim) sim.armies[a]!.spire.surface.hp = 100;
      sim.tick = sim.timeCap - 1;
      g.step();
      expect(sim.result?.outcome[victim]).toBe('win');
      expect(sim.result?.rank[victim]).toBe(1);
    });
  }
});

describe('segment_threatened alert', () => {
  for (const { name, g, victim, by } of cases(CROWNS)) {
    it(`${name}: only the owner learns its segment is threatened (hit, or below threatHp)`, () => {
      const sim = g.sim;
      const seg = sim.armies[victim]!.spire.orbit;
      sim.damage(seg, 1, by, true, 'test');
      g.step();
      const threatened = (army: number) => observe(g, army).alerts.filter((a) => a.kind === 'segment_threatened');
      expect(threatened(victim)).toEqual([{ plane: 'orbit', kind: 'segment_threatened' }]);
      expect(observe(g, victim).spire.find((s) => s.plane === 'orbit')?.threatened).toBe(true);
      for (const a of sim.allArmies) if (a !== victim) expect(threatened(a)).toEqual([]);
      // The hit ages out; a low segment stays threatened.
      for (let i = 0; i < sim.econ.threatWindowTicks; i++) g.step();
      expect(threatened(victim)).toEqual([]);
      seg.hp = Math.floor(seg.maxHp * sim.econ.threatHp) - 1;
      expect(threatened(victim)).toEqual([{ plane: 'orbit', kind: 'segment_threatened' }]);
    });
  }
});

describe('bot crown targeting', () => {
  const ctx = (g: AgentCommandGame, army: number) => {
    const seat = { team: idOf(g, army), role: 'surface' } as const;
    const data = g.matchData(seat);
    return new Ctx(g.observe(seat, 0), data, unpackTerrain(data.terrain, data.rules.map.size));
  };
  const crown = (g: AgentCommandGame, army: number, seen: SpireMemory): Plane | undefined => {
    const c = ctx(g, army);
    c.focusOn(chooseFocus(c, seen, 0)!, seen);
    return c.crown;
  };

  for (const { name, g, victim } of cases(CROWNS)) {
    it(`${name}: the weakest crown by known HP per crown, plane order on ties, never a fallen one`, () => {
      // Equal cost per crown everywhere: the first plane.
      expect(crown(g, victim, new Map())).toBe('depths');
      const focus = ctx(g, victim);
      const foe = chooseFocus(focus, new Map(), 0)!;
      expect(crown(g, victim, new Map([[foe.id, { sky: 1000 }]]))).toBe('sky');
      // The Surface counts per crown: 4000 HP over two crowns beats a 3500-HP side segment.
      expect(crown(g, victim, new Map([[foe.id, { surface: 4000 }]]))).toBe('surface');
      down(g.sim, g.sim.armyIndex(foe.id), 'depths', victim);
      g.step();
      expect(crown(g, victim, new Map())).toBe('surface');
    });
  }

  it('aims at no crown under the surface rule', () => {
    const g = LAYOUTS.C2({});
    expect(crown(g, 0, new Map())).toBeUndefined();
  });
});
