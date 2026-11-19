/**
 * Twin worlds for the build queue: a queued site an unseen enemy structure occupies must tell the team nothing until
 * the team can see it. Both worlds are identical except that hidden structure; every observation (queue reasons,
 * events, entities) must match while the site stays out of the team's sight. Turned for both armies of a duel.
 */
import { describe, expect, it } from 'vitest';
import { CELL, PLANES, STRUCTURE_SPACING, SURFACE, type ArmyId } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { PLANE_INDEX, VISION_EVERY } from '../src/sim/constants.ts';
import { slotArmyIds, slotOfArmyId } from '../src/util/teams.ts';

const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/** Only the Spires and islands left. */
function arena(seed = 9): AgentCommandGame {
  const g = createGame({ seed, options: { terrain: 'open' } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}

/** nw's cell (x, y), or se's point-mirror cell. */
const cell = (g: AgentCommandGame, team: ArmyId, x: number, y: number): { x: number; y: number } =>
  team === 'nw' ? { x, y } : { x: g.sim.size - 1 - x, y: g.sim.size - 1 - y };

/** Every output `team` receives, as one comparable string. */
function told(g: AgentCommandGame, team: ArmyId): string {
  return JSON.stringify([g.view(team), ...PLANES.map((role) => g.observe({ team, role }, 0))]);
}

describe('queued sites over unseen enemy structures (twin worlds)', () => {
  for (const team of slotArmyIds(2)) {
    const army = slotOfArmyId(team, 2);
    const enemy = slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2);

    it(`${team}: a Surface site out of sight waits the same whether or not an enemy structure stands on it`, () => {
      const g = arena();
      const s = g.sim;
      const t = s.armies[army]!;
      // A Shaft projects build radius 7 but sees only 4: a site 6 tiles east is buildable, then out of sight.
      const src = cell(g, team, 14, 14);
      s.add('shaft', army, 'surface', src.x + (team === 'nw' ? 0 : 1), src.y + (team === 'nw' ? 0 : 1));
      const a = cell(g, team, 20, 14);
      for (let y = a.y - STRUCTURE_SPACING; y <= a.y + STRUCTURE_SPACING; y++) {
        for (let x = a.x - STRUCTURE_SPACING; x <= a.x + STRUCTURE_SPACING; x++) {
          const c = y * s.size + x;
          s.terrain[c] = SURFACE.ground;
          s.holes[c] = s.block[c] = 0;
          s.vis[PLANE_INDEX.surface]![c]! |= t.group.bit;
        }
      }
      t.alloy = t.energy = 0;
      expect(g.apply({ team, role: 'surface' }, { kind: 'queue_add', item: 'turret', x: a.x, y: a.y })).toEqual({ ok: true });
      t.alloy = s.stats.turret.alloy / 2;
      s.allocateQueue(army);
      const backing = t.queue[0]!.heldAlloy;
      expect(backing).toBe(s.stats.turret.alloy / 2);
      // The sight the placement used lapses (no own body sees the site any more).
      s.computeVision();
      s.allocateQueue(army);
      const blockedAt = s.tick;
      expect(t.queue[0]).toMatchObject({ status: 'blocked', reason: 'site_unseen', heldAlloy: backing });
      expect(g.apply({ team, role: 'orbit' }, { kind: 'queue_add', item: 'solar' })).toEqual({ ok: true });
      const twin = g.clone();
      // An enemy Shaft over the site (unarmed: a turret's shots at the team would legitimately show), never seen by it.
      twin.sim.add('shaft', enemy, 'surface', a.x + 1, a.y + 1);
      for (const w of [g, twin]) w.sim.armies[army]!.alloy = w.sim.armies[army]!.energy = 1000;
      for (let k = 0; k < Math.ceil(s.econ.queueBlockedGrace / VISION_EVERY) + 2; k++) {
        steps(g, VISION_EVERY);
        steps(twin, VISION_EVERY);
        expect(told(twin, team), `tick ${g.tick}`).toBe(told(g, team));
        expect(s.vis[PLANE_INDEX.surface]![a.y * s.size + a.x]! & t.group.bit).toBe(0);
        // Unseen occupancy neither releases backing early nor receives any new funds during the grace window.
        const expected = s.tick - blockedAt >= s.econ.queueBlockedGrace ? 0 : backing;
        expect(t.queue[0]!.heldAlloy).toBe(expected);
        expect(twin.sim.armies[army]!.queue[0]!.heldAlloy).toBe(expected);
      }
      expect(t.queue[0]).toMatchObject({ item: 'turret', status: 'blocked', reason: 'site_unseen', heldAlloy: 0, heldEnergy: 0 });
      // Once a trooper looks, the empty site starts and the taken one is plainly occupied (now it is seen).
      for (const w of [g, twin]) w.sim.add('trooper', army, 'surface', a.x + 0.5, a.y - 1.5).stance = 'hold';
      steps(g, VISION_EVERY * 2);
      steps(twin, VISION_EVERY * 2);
      expect(t.queue[0]).toMatchObject({ item: 'turret', started: true });
      expect(twin.sim.armies[army]!.queue[0]).toMatchObject({ item: 'turret', status: 'blocked', reason: 'occupied', heldAlloy: 0, heldEnergy: 0 });
    });

    it(`${team}: a bulkhead's digger heads out the same whether or not an unseen enemy gate holds the cell`, () => {
      const g = arena(5);
      const s = g.sim;
      const t = s.armies[army]!;
      // A long known corridor: the digger starts far beyond its sight of the target cell.
      const row = Array.from({ length: 22 }, (_, i) => cell(g, team, 8 + i, 20));
      for (const p of row) {
        const c = p.y * s.size + p.x;
        s.cells[c] = CELL.tunnel;
        s.magma[c] = 0;
        for (const a of s.armies) a.group.known[c] = CELL.tunnel;
      }
      const start = row[0]!;
      const digger = s.add('digger', army, 'depths', start.x + 0.5, start.y + 0.5);
      digger.cell = start.y * s.size + start.x;
      const target = row.at(-1)!;
      steps(g, VISION_EVERY);
      expect(g.apply({ team, role: 'depths' }, { kind: 'queue_add', item: 'bulkhead', x: target.x, y: target.y, digger: g.entityId(team, digger.id) })).toEqual({ ok: true });
      const twin = g.clone();
      twin.sim.placeBulkhead(enemy, target.y * s.size + target.x);
      const c = target.y * s.size + target.x;
      let compared = 0;
      for (let k = 0; k < 400; k++) {
        g.step();
        twin.step();
        if ((s.vis[PLANE_INDEX.depths]![c]! & t.group.bit) !== 0 || (twin.sim.vis[PLANE_INDEX.depths]![c]! & twin.sim.armies[army]!.group.bit) !== 0) break;
        expect(told(twin, team), `tick ${g.tick}`).toBe(told(g, team));
        compared++;
      }
      expect(compared).toBeGreaterThan(VISION_EVERY * 10);
      // The digger sees the gate before it gets there: the entry waits plainly occupied; the real one builds.
      steps(g, 400);
      steps(twin, 400);
      expect(g.sim.bulkheadOn(c)?.side).toBe(army);
      expect(twin.sim.bulkheadOn(c)?.side).toBe(enemy);
      expect(twin.sim.armies[army]!.queue[0]).toMatchObject({ item: 'bulkhead', status: 'blocked', reason: 'occupied' });
    });
  }
});
