/**
 * Entity ids in fogged outputs (sim/aliases.ts). Sim ids come from one global sequence, so a raw id would tell a team
 * how many entities every army made: a gap between two of its own ids, or the number on an enemy unit it sees. Twin
 * worlds that differ only in what an enemy made out of the team's sight must tell the team the same thing, ids
 * included. Turned for both armies of a duel; mirrored armies of a four-army map name rotated twins alike.
 */
import { describe, expect, it } from 'vitest';
import { PLANES, type ArmyId, type Kind } from '../src/rules/contract.ts';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { canonX, canonY, isArmy, rotX, rotY, slotArmyIds, slotOfArmyId } from '../src/util/teams.ts';

const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/** Only the Spires, islands and posts left. */
function arena(): AgentCommandGame {
  const g = createGame({ seed: 9, options: { terrain: 'open' } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island' && e.kind !== 'post') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}

/** Every output `team` receives, as one comparable string. */
function told(g: AgentCommandGame, team: ArmyId): string {
  return JSON.stringify([g.view(team, { snapshot: true }), g.matchData({ team, role: 'surface' }), ...PLANES.map((role) => g.observe({ team, role }, 0))]);
}

/** `d` tiles from army `a`'s Spire toward the map centre (the point mirror of the other army's). */
function near(g: AgentCommandGame, a: number, d: number): { x: number; y: number } {
  const home = g.sim.spireAt[a]!, toward = home.x < g.sim.size / 2 ? 1 : -1;
  return { x: home.x + toward * d, y: home.y + toward * d };
}

describe('entity ids reveal no unseen production (twin worlds)', () => {
  for (const team of slotArmyIds(2)) {
    const army = slotOfArmyId(team, 2);
    const foe = 1 - army;

    it(`${team}: an enemy unit in sight has the same id whatever the enemy made out of sight before it`, () => {
      const g = arena();
      const twin = g.clone();
      // Unseen production in one world only: a squad beside the enemy's own Spire, far outside the team's sight.
      const at = near(twin, foe, 3);
      const squad = Array.from({ length: 5 }, (_, i) => twin.sim.add('trooper', foe, 'surface', at.x + i * 0.5, at.y));
      // Then, in both worlds, an enemy tank right in front of the team's Spire.
      const front = near(g, army, 6);
      const tanks = [g, twin].map((w) => w.sim.add('tank', foe, 'surface', front.x, front.y));
      // Not vacuous: the sim numbers the two tanks apart.
      expect(tanks[1]!.id).toBe(tanks[0]!.id + squad.length);
      steps(g, VISION_EVERY);
      steps(twin, VISION_EVERY);
      expect(g.sim.sees(army, tanks[0]!)).toBe(true);
      for (const e of squad) expect(twin.sim.sees(army, e)).toBe(false);
      expect(told(twin, team)).toBe(told(g, team));
      expect(twin.entityId(team, tanks[1]!.id)).toBe(g.entityId(team, tanks[0]!.id));
      // The team's own next unit shows no gap either.
      const own = [g, twin].map((w) => w.sim.add('trooper', army, 'surface', near(w, army, 4).x, near(w, army, 4).y));
      expect(own[1]!.id).toBe(own[0]!.id + squad.length);
      expect(twin.entityId(team, own[1]!.id)).toBe(g.entityId(team, own[0]!.id));
      steps(g, VISION_EVERY);
      steps(twin, VISION_EVERY);
      expect(told(twin, team)).toBe(told(g, team));
    });

    it(`${team}: a name it never gave names nothing`, () => {
      const g = arena();
      const unit = g.sim.add('trooper', army, 'surface', near(g, army, 4).x, near(g, army, 4).y);
      const hidden = g.sim.add('tank', foe, 'surface', near(g, foe, 4).x, near(g, foe, 4).y);
      steps(g, VISION_EVERY);
      const id = g.entityId(team, unit.id);
      // The next unused name answers like a dead or hidden entity, and the hidden tank has no name at all.
      expect(g.apply({ team, role: 'surface' }, { kind: 'move', units: [`e_${g.sim.armies[army]!.aliases.count + 1}`], x: near(g, army, 5).x, y: near(g, army, 5).y })).toEqual({ ok: false, code: 'unknown_unit' });
      expect(() => g.entityId(team, hidden.id)).toThrow();
      expect(g.apply({ team, role: 'surface' }, { kind: 'move', units: [id], x: near(g, army, 5).x, y: near(g, army, 5).y })).toEqual({ ok: true });
    });
  }
});

describe('mirrored armies name rotated twins alike', () => {
  const maps: [string, () => AgentCommandGame][] = [
    ['two armies on a C2 duel map', () => createGame({ seed: 5, options: { terrain: 'open' } })],
    ['four armies on a C4 map', () => new AgentCommandGame(5, { map: { name: 'four_corners' } })],
  ];
  for (const [name, make] of maps) {
    it(`${name}, each meeting the others at the centre`, () => {
      const g = make();
      const s = g.sim;
      const size = s.size;
      // One squad per army in the canonical frame, turned into each army's frame: every army sees all of them.
      const squad: [Kind, number, number][] = [['tank', size / 2 - 3, size / 2 - 2], ['trooper', size / 2 - 2, size / 2 - 4], ['trooper', size / 2 - 4, size / 2 - 1]];
      for (const a of s.allArmies) for (const [kind, x, y] of squad) s.add(kind, a, 'surface', rotX(s.armyFrame[a]!, x, y, size), rotY(s.armyFrame[a]!, x, y, size));
      steps(g, VISION_EVERY);
      // Islands and posts are public map objects every army names in the document's spawn order (sim/aliases.ts), as
      // a home preview does, so no rotation applies to them. Everything else an army names takes its own frame's order.
      const named = (a: number): string[] => {
        const out: string[] = [];
        const t = s.armies[a]!.aliases;
        const k = s.armyFrame[a]!;
        for (let alias = 1; alias <= t.count; alias++) {
          const e = s.byId.get(t.sim[alias]!);
          if (!e || e.kind === 'island' || e.kind === 'post') continue;
          out.push(`${alias} ${e.kind} ${isArmy(e.side) ? s.rel(a, e.side) : 'neutral'} ${canonX(k, e.x, e.y, size)},${canonY(k, e.x, e.y, size)}`);
        }
        return out;
      };
      const first = named(0);
      // Every other army's squad is named (rows of other owners: relative order 1 and up).
      expect(first.filter((row) => !['0', 'neutral'].includes(row.split(' ')[2]!)).length).toBeGreaterThanOrEqual(squad.length * (s.allArmies.length - 1));
      for (const a of s.allArmies) expect(named(a)).toEqual(first);
      // And their observations list the squads in rotated order under the same names.
      const listed = (team: ArmyId): string[] => g.observe({ team, role: 'surface' }, 0).entities
        .filter((e) => e.kind === 'tank' || e.kind === 'trooper').map((e) => `${e.id} ${e.kind}`);
      for (const team of s.armyIds) expect(listed(team)).toEqual(listed(s.armyIds[0]!));
    });
  }
});

describe('observers and spectators', () => {
  it('the omniscient observer keeps sim ids; a team perspective uses that team\'s names', () => {
    const g = arena();
    const tank = g.sim.add('tank', 1, 'surface', near(g, 0, 6).x, near(g, 0, 6).y);
    const hidden = g.sim.add('trooper', 1, 'surface', near(g, 1, 3).x, near(g, 1, 3).y);
    steps(g, VISION_EVERY);
    const world = g.observerView().world.entities.map((e) => e.id);
    expect(world).toContain(`e_${tank.id}`);
    expect(world).toContain(`e_${hidden.id}`);
    // nw's name for the tank differs from the sim id (the hidden trooper took a sim id, never a nw name).
    const nwTank = g.entityId('nw', tank.id);
    expect(g.view('nw').entities.find((e) => e.id === nwTank)?.kind).toBe('tank');
    expect(g.view('se').entities.find((e) => e.id === g.entityId('se', tank.id))?.kind).toBe('tank');
    expect(() => g.entityId('nw', hidden.id)).toThrow();
  });

  it('a replay of the same intents names everything alike (aliases are match history)', () => {
    const g = arena();
    const unit = g.sim.add('trooper', 0, 'surface', near(g, 0, 4).x, near(g, 0, 4).y);
    const replay = g.clone();
    const move = { kind: 'move' as const, units: [g.entityId('nw', unit.id)], x: near(g, 0, 8).x, y: near(g, 0, 8).y };
    for (const w of [g, replay]) {
      expect(w.apply({ team: 'nw', role: 'surface' }, move)).toEqual({ ok: true });
      w.sim.add('tank', 1, 'surface', near(w, 0, 9).x, near(w, 0, 9).y);
      steps(w, VISION_EVERY * 3);
    }
    expect(replay.stateHash()).toBe(g.stateHash());
    for (const team of g.sim.armyIds) expect(told(replay, team)).toBe(told(g, team));
  });
});
