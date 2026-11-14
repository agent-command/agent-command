/** Attacking an island targets its slot; island slot structures are public like their island. */
import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { cellOf } from '../src/util/grid.ts';
import { type Ent } from '../src/sim/ent.ts';
import { entityOut } from '../src/agent/present.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

type Duel = 'nw' | 'se';
const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

const enemy = (team: Duel): Duel => team === 'nw' ? 'se' : 'nw';

/** An island pair (one per team, point-mirrored) neither team sees from the air, everything else cleared. */
function arena(): { g: AgentCommandGame; held: Record<'nw' | 'se', Ent> } {
  const g = createGame({ seed: 9 });
  const s = g.sim;
  for (const e of s.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.step();
  const islands = s.ents.filter((e) => e.kind === 'island');
  const unseen = (isl: Ent) => !s.seesCell(BLUE, 'sky', cellOf(isl.x, isl.y, s.size)) && !s.seesCell(RED, 'sky', cellOf(isl.x, isl.y, s.size));
  for (const a of islands) {
    const b = islands.find((o) => o !== a && Math.abs(o.x + a.x - s.size) < 1e-9 && Math.abs(o.y + a.y - s.size) < 1e-9);
    if (b && unseen(a) && unseen(b)) return { g, held: { nw: a, se: b } };
  }
  throw new Error('no unseen mirrored island pair');
}
/** Army `team` holds `isl` with a built `kind` in its slot. */
function hold(g: AgentCommandGame, team: Duel, isl: Ent, kind: 'relay' | 'aerie' | 'stormcatcher' | null): Ent | undefined {
  g.sim.setSide(isl, slotOfArmyId(team, 2));
  if (!kind) return undefined;
  const st = g.sim.add(kind, slotOfArmyId(team, 2), 'sky', isl.x, isl.y);
  st.link = isl.id;
  isl.link = st.id;
  return st;
}
/** Air units of `team` at the mirrored spot near its Spire. */
function air(g: AgentCommandGame, team: Duel): { fighter: Ent; bomber: Ent } {
  const p = (x: number, y: number): [number, number] => team === 'nw' ? [x, y] : [g.sim.size - x, g.sim.size - y];
  return { fighter: g.sim.add('interceptor', slotOfArmyId(team, 2), 'sky', ...p(6, 6)), bomber: g.sim.add('bomber', slotOfArmyId(team, 2), 'sky', ...p(6.5, 6)) };
}

describe('attacking an island', () => {
  it('a held island\'s slot structure is public with it (fog does not hide it); its tooltip data lists it, mirrored', () => {
    const { g, held } = arena();
    const relays = { nw: hold(g, 'nw', held.nw, 'relay')!, se: hold(g, 'se', held.se, 'relay')! };
    g.step();
    for (const team of ['nw', 'se'] as const) {
      const theirs = held[enemy(team)];
      expect(g.sim.sees(slotOfArmyId(team, 2), relays[enemy(team)])).toBe(true);
      expect(entityOut(g.sim, theirs, team).link).toBe(g.entityId(team, relays[enemy(team)].id));
      expect(g.observe({ team, role: 'sky' }, 0).entities.some((e) => e.id === g.entityId(team, relays[enemy(team)].id))).toBe(true);
    }
  });

  it('resolves to the visible enemy structure: units that can hit it attack, the rest move under it, mirrored', () => {
    const { g, held } = arena();
    const relays = { nw: hold(g, 'nw', held.nw, 'relay')!, se: hold(g, 'se', held.se, 'relay')! };
    const units = { nw: air(g, 'nw'), se: air(g, 'se') };
    g.step();
    for (const team of ['nw', 'se'] as const) {
      const { fighter, bomber } = units[team];
      expect(g.apply({ team, role: 'sky' }, { kind: 'attack', units: [g.entityId(team, fighter.id), g.entityId(team, bomber.id)], target: g.entityId(team, held[enemy(team)].id) })).toEqual({ ok: true });
      expect(fighter.order).toMatchObject({ k: 'attack', target: relays[enemy(team)].id });
      expect(bomber.order.k).toBe('move');
    }
    const [b, r] = [units.nw.bomber.order, units.se.bomber.order] as const;
    if (b.k === 'move' && r.k === 'move') {
      expect(b.x + r.x).toBeCloseTo(g.sim.size, 9);
      expect(b.y + r.y).toBeCloseTo(g.sim.size, 9);
    }
  });

  for (const slot of [null, 'none-hostile'] as const) {
    it(`with nothing hostile on it (${slot === null ? 'empty enemy island' : 'own structure'}), capture-capable air units capture it, mirrored`, () => {
      const { g, held } = arena();
      for (const team of ['nw', 'se'] as const) hold(g, team, held[team], null);
      const units = { nw: air(g, 'nw'), se: air(g, 'se') };
      g.step();
      for (const team of ['nw', 'se'] as const) {
        const isl = slot === null ? held[enemy(team)] : held[team];
        if (slot !== null) hold(g, team, isl, 'stormcatcher');
        const { fighter, bomber } = units[team];
        expect(g.apply({ team, role: 'sky' }, { kind: 'attack', units: [g.entityId(team, fighter.id), g.entityId(team, bomber.id)], target: g.entityId(team, isl.id) })).toEqual({ ok: true });
        expect(fighter.order).toMatchObject({ k: 'capture', island: isl.id });
        expect(bomber.order).toMatchObject({ k: 'capture', island: isl.id });
      }
    });
  }

  it('Surface units sent at an island overhead move under it rather than failing', () => {
    const { g, held } = arena();
    for (const team of ['nw', 'se'] as const) hold(g, team, held[team], null);
    const tanks = { nw: g.sim.add('tank', BLUE, 'surface', 8, 8), se: g.sim.add('tank', RED, 'surface', g.sim.size - 8, g.sim.size - 8) };
    g.step();
    for (const team of ['nw', 'se'] as const) {
      expect(g.apply({ team, role: 'surface' }, { kind: 'attack', units: [g.entityId(team, tanks[team].id)], target: g.entityId(team, held[enemy(team)].id) })).toEqual({ ok: true });
      expect(tanks[team].order.k).toBe('move');
    }
  });
});
