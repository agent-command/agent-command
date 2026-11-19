/** The four-army agent contract (DESIGN §15): FFA bootstrap and views, fog, elimination, forfeit, match creation, lobby registry and weather. */
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { AgentCommandGame, definition } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { ARMIES, COLOURS, PLANES, TICK_RATE, checkRules, observationSchema, toTicks, viewSchema, type ArmyId, type MatchOptions, type UnitKind } from '../src/rules/contract.ts';
import { MAPS } from '../src/maps/registry.ts';
import { sampleStorm, type StormSample } from '@agent-command/game/weather';
import type { Sim } from '../src/sim/sim.ts';
import { dmath } from '../src/util/fdlibm.js';

const KIB = 1024;
const ffa = (seed = 5, options: MatchOptions = {}): AgentCommandGame => new AgentCommandGame(seed, { ...options, map: { name: 'four_corners' } });
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
/** Knock `id`'s Surface segment down with a hit from `by` (an army index, or neutral by default); the next step resolves it. */
const fell = (g: AgentCommandGame, id: ArmyId, by?: ArmyId): void => {
  const seg = g.sim.armies[g.sim.armyIndex(id)]!.spire.surface;
  g.sim.damage(seg, seg.hp + 1, by === undefined ? -1 : g.sim.armyIndex(by), true, 'test');
};
/** (x, y) turned `turns` quarter turns about the centre of a `size` map ((x, y) → (size − y, x) per turn), in closed form. */
const turn = (turns: number, x: number, y: number, size: number): [number, number] => {
  const k = turns & 3;
  return k === 0 ? [x, y] : k === 1 ? [size - y, x] : k === 2 ? [size - x, size - y] : [y, size - x];
};

describe('four-corners FFA bootstrap and views', () => {
  it('lists four armies with frames 0..3 and distinct colours on a C4 map; every view and observation validates', () => {
    const g = ffa();
    const data = g.matchData({ team: 'nw', role: 'surface' });
    expect(data.armies.map((a) => [a.id, a.slot, a.frame])).toEqual([['nw', 0, 0], ['ne', 1, 1], ['se', 2, 2], ['sw', 3, 3]]);
    expect(new Set(data.armies.map((a) => a.colour)).size).toBe(4);
    expect(data.armies.map((a) => a.colour)).toEqual([...COLOURS]);
    expect(data.symmetry).toBe('C4');
    expect(data.sun.wedges).toBe(4);
    expect(g.sim.armyIds).toEqual(ARMIES);
    steps(g, 40);
    for (const army of ARMIES) {
      const v = g.view(army, { snapshot: true });
      expect(v.army).toBe(army);
      expect(validate(viewSchema, v).ok, army).toBe(true);
      for (const role of PLANES) {
        const obs = g.observe({ team: army, role }, 0);
        expect(obs.army).toBe(army);
        expect(obs.eliminated).toEqual([]);
        expect(obs.rank).toBeUndefined();
        expect(validate(observationSchema, obs).ok, `${army} ${role}`).toBe(true);
      }
    }
  });

  it('keeps the bootstrap and every observation within 128 KiB on a crowded L80 FFA', () => {
    const g = new AgentCommandGame(11, { map: { seed: 11, params: { size: 80, slots: 4 } } });
    expect(g.sim.armyIds).toEqual(ARMIES);
    const kinds: [UnitKind, 'depths' | 'surface' | 'sky' | 'orbit'][] = [['digger', 'depths'], ['trooper', 'surface'], ['tank', 'surface'], ['interceptor', 'sky'], ['bomber', 'sky'], ['solar', 'orbit'], ['skiff', 'orbit']];
    for (let a = 0; a < 4; a++) for (let i = 0; i < 140; i++) g.sim.spawnUnit(a, kinds[i % kinds.length]![0], kinds[i % kinds.length]![1]);
    steps(g, 300);
    const data = g.matchData({ team: 'nw', role: 'surface' });
    expect(data.symmetry).toBe('C4');
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(128 * KIB);
    for (const army of ARMIES) for (const role of PLANES) {
      // Every plane in full (detail 'all', the bound) and the seat's default scope (its own plane).
      for (const obs of [g.observe({ team: army, role }, 0), g.observe({ team: army, role }, 0, [role])]) {
        expect(validate(observationSchema, obs).ok, `${army} ${role}`).toBe(true);
        expect(JSON.stringify(obs).length, `${army} ${role}`).toBeLessThanOrEqual(128 * KIB);
      }
    }
  });
});

describe('fog twin worlds with four armies', () => {
  it("se's hidden state shapes no other army's observations, views, group state or intent results", () => {
    const real = ffa(9);
    steps(real, 20);
    const twin = real.clone();
    const se = twin.sim.armyIndex('se');
    const t = twin.sim.armies[se]!;
    t.alloy += 1000;
    t.energy += 500;
    // Its units shuffle around its own base, and more stand there, all far from every other army's eyes.
    const home = t.spire.surface;
    for (const e of twin.sim.ents) if (e.side === se && e.unit && e.plane === 'surface') e.x = Math.min(e.x + 1, twin.sim.size - 1);
    const extra = [twin.sim.add('tank', se, 'surface', home.x - 3, home.y - 3), twin.sim.add('interceptor', se, 'sky', home.x - 4, home.y), twin.sim.add('digger', se, 'depths', home.x, home.y)];
    for (const army of ['nw', 'ne', 'sw'] as const) {
      const a = real.sim.armyIndex(army);
      for (const e of extra) expect(twin.sim.sees(a, e), `${army} sees e_${e.id}`).toBe(false);
      expect(twin.view(army, { snapshot: true })).toEqual(real.view(army, { snapshot: true }));
      for (const role of PLANES) expect(twin.observe({ team: army, role }, 0), `${army} ${role}`).toEqual(real.observe({ team: army, role }, 0));
      expect(twin.sim.armies[a]!.group.known).toEqual(real.sim.armies[a]!.group.known);
      expect([...twin.sim.armies[a]!.group.memory.entries()]).toEqual([...real.sim.armies[a]!.group.memory.entries()]);
      const own = (kind: UnitKind) => real.sim.ents.filter((e) => !e.dead && e.side === a && e.kind === kind).map((e) => real.entityId(army, e.id));
      // The army has no name for the unseen extras: probe the names it would give next, and their raw sim ids.
      const guesses = extra.flatMap((e, i) => [`e_${real.sim.armies[a]!.aliases.count + 1 + i}`, `e_${e.id}`]);
      const x = Math.floor(home.x), y = Math.floor(home.y);
      const probes: [typeof PLANES[number], AgentCommandIntent][] = [
        ['surface', { kind: 'move', units: own('trooper'), x: home.x - 3, y: home.y - 3 }],
        ['surface', { kind: 'queue_add', item: 'turret', x: x - 3, y: y - 3 }],
        ['surface', { kind: 'queue_add', item: 'headframe', x: x - 3, y: y - 3 }],
        ['depths', { kind: 'move', units: own('digger'), x: home.x, y: home.y }],
        ['depths', { kind: 'dig', units: own('digger'), x, y }],
        ...guesses.map((target) => ['surface', { kind: 'attack', units: own('trooper'), target }] as [typeof PLANES[number], AgentCommandIntent]),
      ];
      for (const [role, intent] of probes) {
        if ('units' in intent && intent.units.length === 0) continue;
        expect(twin.clone().apply({ team: army, role }, intent), `${army} ${role} ${JSON.stringify(intent)}`).toEqual(real.clone().apply({ team: army, role }, intent));
      }
    }
  });
});

describe('elimination contract', () => {
  it('announces each fall to every army, ranks the fallen and refuses their intents while the match goes on', () => {
    const g = ffa(5);
    steps(g, 5);
    fell(g, 'ne', 'nw');
    g.step();
    const fallen = g.tick;
    expect(g.sim.over).toBe(false);
    for (const army of ARMIES) {
      for (const role of PLANES) {
        const obs = g.observe({ team: army, role }, fallen - 1);
        expect(obs.eliminated).toEqual(['ne']);
        const ev = obs.events.filter((e) => e.kind === 'army_eliminated');
        expect(ev, `${army} ${role}`).toHaveLength(1);
        expect(ev[0]).toMatchObject({ side: 'ne', killer: 'nw', plane: 'surface', tick: fallen });
      }
    }
    const ne = g.observe({ team: 'ne', role: 'surface' }, 0);
    expect(ne.outcome).toBe('loss');
    expect(ne.rank).toBe(4);
    expect(g.rank('ne')).toBe(4);
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).rank).toBeUndefined();
    for (const role of PLANES) expect(g.apply({ team: 'ne', role }, { kind: 'rally', x: 10, y: 10 })).toEqual({ ok: false, code: 'eliminated' });
    steps(g, 20);
    expect(g.sim.over).toBe(false);

    // A neutral fall has no killer.
    fell(g, 'sw');
    g.step();
    const sw = g.observe({ team: 'nw', role: 'sky' }, g.tick - 1).events.filter((e) => e.kind === 'army_eliminated');
    expect(sw).toHaveLength(1);
    expect(sw[0]!.side).toBe('sw');
    expect(sw[0]!.killer).toBeUndefined();
    expect(g.observe({ team: 'se', role: 'depths' }, 0).eliminated).toEqual(['ne', 'sw']);
    expect(g.sim.over).toBe(false);

    fell(g, 'nw', 'se');
    g.step();
    expect(g.sim.over).toBe(true);
    expect(ARMIES.map((id) => g.outcome(id))).toEqual(['loss', 'loss', 'win', 'loss']);
    expect(ARMIES.map((id) => g.rank(id))).toEqual([2, 4, 1, 3]);
    for (const id of ARMIES) {
      const obs = g.observe({ team: id, role: 'orbit' }, 0);
      expect(obs.rank).toBe(g.rank(id));
      expect(validate(observationSchema, obs).ok).toBe(true);
    }
    const report = g.report('se');
    expect(report.outcome).toBe('win');
    expect(report.rank).toBe(1);
    expect(report.armies.map((a) => [a.army, a.colour, a.rank])).toEqual([['nw', 'blue', 2], ['ne', 'red', 4], ['se', 'green', 1], ['sw', 'violet', 3]]);
  });
});

describe('forfeit', () => {
  it('eliminates the army at the end of the next tick, ranked below armies falling on that tick', () => {
    const g = ffa(5);
    steps(g, 3);
    g.forfeit('ne');
    fell(g, 'sw');
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).eliminated).toEqual([]);
    g.step();
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).eliminated.sort()).toEqual(['ne', 'sw']);
    expect(g.sim.over).toBe(false);
    expect(g.rank('ne')).toBe(4);
    expect(g.rank('sw')).toBe(3);
    expect(g.apply({ team: 'ne', role: 'surface' }, { kind: 'rally', x: 10, y: 10 })).toEqual({ ok: false, code: 'eliminated' });
  });

  it('in a two-army match the other army wins at once', () => {
    const g = new AgentCommandGame(3);
    steps(g, 3);
    g.forfeit('se');
    g.step();
    expect(g.sim.over).toBe(true);
    expect([g.outcome('nw'), g.outcome('se')]).toEqual(['win', 'loss']);
    expect([g.rank('nw'), g.rank('se')]).toEqual([1, 2]);
  });
});

describe('definition.create armies and colour alliances', () => {
  const options = { map: { name: 'four_corners' } };
  const create = (teams: ArmyId[], alliances?: Record<string, ArmyId[]>, opts: MatchOptions = options) =>
    definition.create({ seed: 1, options: opts, teams, ...(alliances ? { alliances } : {}) }) as AgentCommandGame;

  it('plays two to four armies on four_corners: FFA and the C4 duel', () => {
    for (const teams of [['nw', 'ne', 'se', 'sw'], ['nw', 'ne', 'sw'], ['nw', 'se']] as ArmyId[][]) {
      const g = create(teams);
      const data = g.matchData({ team: teams[0]!, role: 'surface' });
      expect(data.armies.map((a) => a.id)).toEqual(teams);
      expect(data.armies.map((a) => a.colour)).toEqual(COLOURS.slice(0, teams.length));
      expect(data.symmetry).toBe('C4');
    }
    const duel = create(['se', 'nw']).matchData({ team: 'nw', role: 'surface' });
    expect(duel.armies.map((a) => [a.id, a.slot, a.frame])).toEqual([['nw', 0, 0], ['se', 2, 2]]);
  });

  it('colours armies by their colour-keyed alliances', () => {
    const g = create(['nw', 'ne', 'se', 'sw'], { violet: ['nw'], green: ['ne'], red: ['se'], blue: ['sw'] });
    expect(g.matchData({ team: 'nw', role: 'surface' }).armies.map((a) => [a.id, a.colour])).toEqual([['nw', 'violet'], ['ne', 'green'], ['se', 'red'], ['sw', 'blue']]);
    expect(g.report('nw').armies.map((a) => a.colour)).toEqual(['violet', 'green', 'red', 'blue']);
  });

  it('rejects duplicate colours, non-colour alliance ids, multi-member alliances and corners that are no map slot', () => {
    expect(() => create(['nw', 'se'], { red: ['nw'] })).toThrow(/colour/);
    expect(() => create(['nw', 'se'], { blue: ['nw'], blue2: ['se'] })).toThrow(/unsupported alliance/);
    expect(() => create(['nw', 'se'], { nw: ['nw'], se: ['se'] })).toThrow(/unsupported alliance/);
    expect(() => create(['nw', 'se'], { blue: ['nw', 'se'] })).toThrow(/unsupported alliances/);
    expect(() => create(['nw', 'ne'], undefined, {})).toThrow(/ne/);
  });
});

describe('lobby registry and four-slot rules', () => {
  it('four_corners layouts come from its document; generated recipes offer a C2 duel and a C4 FFA', () => {
    const four = MAPS.find((m) => m.id === 'four_corners')!;
    expect(four.layouts.map((l) => [l.id, l.supported])).toEqual([['ffa', true], ['duel', true], ['adjacent', false], ['opposite', false]]);
    expect(four.layouts.find((l) => l.id === 'ffa')!.alliances.map((a) => a.id)).toEqual(['nw', 'ne', 'se', 'sw']);
    expect(four.layouts.find((l) => l.id === 'duel')!.alliances.map((a) => a.id)).toEqual(['nw', 'se']);
    for (const map of MAPS.filter((m) => m.tags.includes('generated'))) {
      expect(map.layouts.map((l) => [l.id, l.sides])).toEqual([['duel', 2], ['ffa', 4]]);
    }
  });

  it('checkRules accepts four-slot maps and rejects three slots; a generated four-slot map is C4', () => {
    expect(checkRules({ map: { name: 'four_corners' } }).ok).toBe(true);
    expect(checkRules({ map: { params: { slots: 4 } } }).ok).toBe(true);
    expect(checkRules({ map: { params: { slots: 3 as 4 } } }).ok).toBe(false);
    const g = new AgentCommandGame(4, { map: { params: { slots: 4 } } });
    const data = g.matchData({ team: 'nw', role: 'surface' });
    expect(data.symmetry).toBe('C4');
    expect(data.armies.map((a) => a.id)).toEqual(ARMIES);
    expect(data.sun.wedges).toBe(4);
  });
});

describe('public weather paths with turns', () => {
  const quick: MatchOptions['sky'] = {
    stormSets: 2, stormForecastMin: 1, stormForecastMax: 1, stormGrow: 2,
    stormLifetimeMin: 3, stormLifetimeMax: 5, stormBreak: 2, stormCalmMin: 1, stormCalmMax: 2,
  };
  const check = (g: AgentCommandGame, sides: number): void => {
    const s: Sim = g.sim;
    const data = g.matchData({ team: 'nw', role: 'sky' });
    expect(data.fogPaths.map((p) => p.turns)).toEqual(Array.from({ length: sides }, (_, r) => r * 4 / sides));
    const out: StormSample = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' };
    let storms = 0;
    for (let i = 0; i < toTicks(40); i++) {
      g.step();
      const T = g.tick;
      const fog = g.observe({ team: 'nw', role: 'sky' }, T).weather.fog;
      data.fogPaths.forEach((p, k) => {
        // Bit-exact in the sim's evaluation order: phase + T / TICK_RATE · speed (speed · T / TICK_RATE rounds differently),
        // through the sim's deterministic trigonometry (the engine's Math.cos/sin may differ in the last bit).
        const angle = p.phase + T / TICK_RATE * p.speed;
        const [x, y] = turn(p.turns, p.cx + dmath.cos(angle) * p.radius, p.cy + dmath.sin(angle) * p.radius, s.size);
        expect([x, y]).toEqual([s.weather.data.fog[k]!.x, s.weather.data.fog[k]!.y]);
        expect([fog[k]!.x, fog[k]!.y]).toEqual([x, y]);
      });
      for (const c of s.weather.data.storms) {
        storms++;
        sampleStorm(c, T, out, 0, s.size);
        expect([out.x, out.y]).toEqual([c.x, c.y]);
        const age = Math.max(0, Math.min(c.end, T) - c.start);
        expect(turn(c.turns, c.originX + c.dx * age, c.originY + c.dy * age, s.size)).toEqual([c.x, c.y]);
      }
    }
    expect(storms).toBeGreaterThan(0);
  };

  it('evaluates exactly to the sim banks and storms on a C4 match', () => check(ffa(21, { sky: quick }), 4));
  it('evaluates exactly to the sim banks and storms on a C2 match', () => check(new AgentCommandGame(21, { sky: quick }), 2));
});
