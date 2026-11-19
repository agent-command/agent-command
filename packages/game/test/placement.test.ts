import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { CELL, STATS, STRUCTURE_SPACING, SURFACE, footprintDistance, footprintMinX, footprintMinY, footprintOverlap, DEFAULT_RULES, spirePositions, type ArmyId } from '../src/rules/contract.ts';
import { applyIntent } from '../src/agent/intents.ts';
import { slotArmyIds, slotOfArmyId } from '../src/util/teams.ts';
import { cellOfEnt } from '../src/util/grid.ts';
import type { Sim } from '../src/sim/sim.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

/** Sets or clears army `army`'s Surface vision bit at cell `c`. */
function setVis(sim: Sim, army: number, c: number, on: boolean): void {
  const bit = sim.armies[army]!.group.bit;
  sim.vis[1]![c] = on ? sim.vis[1]![c]! | bit : sim.vis[1]![c]! & ~bit;
}

/**
 * These cases exercise footprint, terrain, fog and spacing rules on open mid-map sites, so the Spire's build radius
 * covers the whole map here; the radius itself is covered in build-radius.test.ts.
 */
const WIDE = { surface: { buildRadiusSpire: 80 } };

/** Spire centres under the default rules (every match here uses them). */
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);

/** A clear visible site on plain ground; the apron is levelled too, since a site stands on one level. */
function clearSite(g: AgentCommandGame, team: ArmyId, x: number, y: number, w: number, h = w): void {
  for (let dy = -STRUCTURE_SPACING; dy < h + STRUCTURE_SPACING; dy++) for (let dx = -STRUCTURE_SPACING; dx < w + STRUCTURE_SPACING; dx++) {
    g.sim.terrain[(y + dy) * g.sim.size + x + dx] = SURFACE.ground;
  }
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
    const c = (y + dy) * g.sim.size + x + dx;
    g.sim.cells[c] = CELL.rock;
    g.sim.holes[c] = g.sim.block[c] = 0;
    setVis(g.sim, slotOfArmyId(team, 2), c, true);
  }
}

function place(g: AgentCommandGame, team: ArmyId, item: 'shaft' | 'turret' | 'headframe' | 'bulkhead', x: number, y: number) {
  return applyIntent(g.sim, slotOfArmyId(team, 2), item === 'bulkhead' ? 'depths' : 'surface', { kind: 'queue_add', item, x, y });
}

describe('whole-cell structure placement', () => {
  it('keeps entity centres while mirroring minimum anchors by the full width', () => {
    const g = createGame({ seed: 9, options: WIDE });
    for (const team of (['nw', 'se'] as const)) {
      const x = team === 'nw' ? 19 : g.sim.size - STATS.shaft.footprint.w - 19;
      const y = team === 'nw' ? 17 : g.sim.size - STATS.shaft.footprint.h - 17;
      clearSite(g, team, x, y, 2);
      expect(place(g, team, 'shaft', x, y)).toEqual({ ok: true });
      const q = g.sim.armies[slotOfArmyId(team, 2)]!.queue[0]!;
      expect(q.x).toBe(x + 1);
      expect(q.y).toBe(y + 1);
      expect(footprintMinX(q.item as 'shaft', q.x)).toBe(x);
      expect(footprintMinY(q.item as 'shaft', q.y)).toBe(y);
    }
    expect(g.sim.armies[BLUE]!.queue[0]!.x + g.sim.armies[RED]!.queue[0]!.x).toBe(g.sim.size);
    expect(g.sim.armies[BLUE]!.queue[0]!.y + g.sim.armies[RED]!.queue[0]!.y).toBe(g.sim.size);
  });

  it('requires integer anchors and bounds the entire footprint', () => {
    const g = createGame({ seed: 9, options: WIDE });
    expect(place(g, 'nw', 'shaft', 20.5, 20)).toEqual({ ok: false, code: 'invalid_target' });
    expect(place(g, 'nw', 'shaft', g.sim.size - 1, 20)).toEqual({ ok: false, code: 'blocked' });
    expect(place(g, 'nw', 'shaft', 20, g.sim.size - 1)).toEqual({ ok: false, code: 'blocked' });
    expect(g.sim.armies[BLUE]!.queue).toHaveLength(0);
  });

  it('finishes the visibility pass before inspecting hidden cells anywhere in the footprint', () => {
    const g = createGame({ seed: 9, options: WIDE });
    clearSite(g, 'nw', 20, 20, 2);
    const first = 20 * g.sim.size + 20;
    const last = 21 * g.sim.size + 21;
    setVis(g.sim, BLUE, last, false);
    g.sim.block[first] = 1;
    g.sim.cells[last] = CELL.bedrock;
    expect(place(g, 'nw', 'shaft', 20, 20)).toEqual({ ok: false, code: 'not_visible' });
    g.sim.block[first] = 0;
    expect(place(g, 'nw', 'shaft', 20, 20)).toEqual({ ok: false, code: 'not_visible' });
  });

  it('rejects holes, unbuildable terrain and known bedrock under any shaft cell', () => {
    const g = createGame({ seed: 9, options: WIDE });
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const c = (20 + dy) * g.sim.size + 20 + dx;
      for (const terrain of [SURFACE.cliff, SURFACE.forest, SURFACE.ford, SURFACE.fault]) {
        clearSite(g, 'nw', 20, 20, 2);
        g.sim.terrain[c] = terrain;
        expect(place(g, 'nw', 'shaft', 20, 20)).toEqual({ ok: false, code: 'blocked' });
      }
      clearSite(g, 'nw', 20, 20, 2);
      g.sim.holes[c] = 1;
      expect(place(g, 'nw', 'shaft', 20, 20)).toEqual({ ok: false, code: 'blocked' });
      clearSite(g, 'nw', 20, 20, 2);
      g.sim.cells[c] = CELL.bedrock;
      g.sim.armies[BLUE]!.group.known[c] = CELL.bedrock;
      expect(place(g, 'nw', 'shaft', 20, 20)).toEqual({ ok: false, code: 'blocked' });
      g.sim.armies[BLUE]!.group.known[c] = CELL.unknown;
    }
  });

  it('judges Shaft bedrock on army knowledge only: hidden bedrock changes no result, reason or portal knowledge', () => {
    for (const team of slotArmyIds(2)) {
      const army = slotOfArmyId(team, 2);
      const x = team === 'nw' ? 20 : DEFAULT_RULES.map.size - STATS.shaft.footprint.w - 20;
      // Twin worlds that differ only in hidden Depths terrain under the site.
      const worlds = [false, true].map((hidden) => {
        const g = createGame({ seed: 9, options: WIDE });
        clearSite(g, team, x, x, 2);
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const c = (x + dy) * g.sim.size + x + dx;
          g.sim.armies[army]!.group.known[c] = CELL.unknown;
          if (hidden) g.sim.cells[c] = CELL.bedrock;
        }
        g.sim.armies[army]!.alloy = 10_000;
        return g;
      });
      const results = worlds.map((g) => place(g, team, 'shaft', x, x));
      expect(results[1]).toEqual(results[0]);
      expect(results[0]).toEqual({ ok: true });
      const reasons = worlds.map((g) => g.sim.armies[army]!.queue.map((q) => g.sim.queueBlock(army, q)));
      expect(reasons[1]).toEqual(reasons[0]);
      expect(reasons[0]).toEqual([null]);
      // Completed over hidden bedrock: the Shaft stands, its cell below stays bedrock (now seen) and it is sealed (no portal).
      for (const g of worlds) for (let i = 0; i < STATS.shaft.build + 40; i++) g.step();
      const portals = worlds.map((g) => {
        const shaft = g.sim.ents.find((e) => e.kind === 'shaft' && e.side === army && e.built && !e.dead)!;
        expect(shaft).toBeDefined();
        const below = cellOfEnt(shaft, g.sim.size);
        return { portal: g.sim.shaftPortal(army, shaft), cell: g.sim.cells[below], known: g.sim.armies[army]!.group.known[below] };
      });
      expect(portals[0]).toMatchObject({ cell: CELL.tunnel, known: CELL.tunnel });
      expect(portals[1]).toEqual({ portal: false, cell: CELL.bedrock, known: CELL.bedrock });
    }
  });

  it('reserves queued rectangles and their one-cell ring, not only their centres', () => {
    const g = createGame({ seed: 9, options: WIDE });
    clearSite(g, 'nw', 19, 19, 8);
    expect(place(g, 'nw', 'shaft', 20, 20)).toEqual({ ok: true });
    expect(place(g, 'nw', 'turret', 21, 21)).toEqual({ ok: false, code: 'occupied' });
    expect(place(g, 'nw', 'turret', 22, 22)).toEqual({ ok: false, code: 'occupied' });
    expect(place(g, 'nw', 'turret', 23, 20)).toEqual({ ok: true });
  });

  it('does not reveal a hidden enemy footprint outside the visible placement cells', () => {
    const g = createGame({ seed: 9, options: WIDE });
    clearSite(g, 'nw', 20, 20, 1);
    const enemy = g.sim.add('shaft', RED, 'surface', 22, 21);
    for (let c = 0; c < g.sim.n; c++) setVis(g.sim, BLUE, c, false);
    setVis(g.sim, BLUE, 20 * g.sim.size + 20, true);
    expect(place(g, 'nw', 'turret', 20, 20)).toEqual({ ok: true });
    g.sim.armies[BLUE]!.queue.length = 0;
    g.sim.armies[BLUE]!.group.memory.set(enemy.id, { kind: enemy.kind, side: enemy.side, plane: enemy.plane, x: enemy.x, y: enemy.y, seen: g.sim.tick });
    expect(place(g, 'nw', 'turret', 20, 20)).toEqual({ ok: false, code: 'occupied' });
  });

  it('snaps every discovered lode pocket cell to the same complete Headframe', () => {
    const g = createGame({ seed: 9, options: WIDE });
    const lode = g.sim.lodes[0]!;
    const x = lode.c % g.sim.size;
    const y = Math.floor(lode.c / g.sim.size);
    clearSite(g, 'nw', x - 1, y - 1, 3);
    lode.known |= g.sim.armies[BLUE]!.group.bit;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      expect(place(g, 'nw', 'headframe', x + dx, y + dy)).toEqual({ ok: true });
      const q = g.sim.armies[BLUE]!.queue.pop()!;
      expect([q.x, q.y]).toEqual([x + 0.5, y + 0.5]);
      expect([footprintMinX('headframe', q.x), footprintMinY('headframe', q.y)]).toEqual([x - 1, y - 1]);
    }
    setVis(g.sim, BLUE, (y + 1) * g.sim.size + x + 1, false);
    expect(place(g, 'nw', 'headframe', x, y)).toEqual({ ok: false, code: 'not_visible' });
    lode.known &= ~g.sim.armies[BLUE]!.group.bit;
    expect(place(g, 'nw', 'headframe', x, y)).toEqual({ ok: false, code: 'no_lode' });
    expect(place(g, 'nw', 'headframe', 0, 0)).toEqual({ ok: false, code: 'no_lode' });
  });

  it('protects every known lode pocket cell from other Surface structures', () => {
    const g = createGame({ seed: 9, options: WIDE });
    const lode = g.sim.lodes[0]!;
    const x = lode.c % g.sim.size;
    const y = Math.floor(lode.c / g.sim.size);
    clearSite(g, 'nw', x - 1, y - 1, 3);
    lode.known |= g.sim.armies[BLUE]!.group.bit;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      expect(place(g, 'nw', 'turret', x + dx, y + dy)).toEqual({ ok: false, code: 'blocked' });
    }
  });

  it('cannot place a bulkhead inside any cell of the Depths root', () => {
    const g = createGame({ seed: 9, options: WIDE });
    const p = DEFAULT_SPIRES.nw;
    for (let y = p.y - 1.5; y < p.y + 1.5; y++) for (let x = p.x - 1.5; x < p.x + 1.5; x++) {
      const c = y * g.sim.size + x;
      g.sim.armies[BLUE]!.group.known[c] = CELL.tunnel;
      expect(place(g, 'nw', 'bulkhead', x, y)).toEqual({ ok: false, code: 'occupied' });
    }
  });
});

describe('shared rectangle geometry', () => {
  it('uses edge distances and preserves continuous drifting relay centres', () => {
    expect(footprintDistance('headframe', 10.5, 10.5, 12, 12)).toBe(0);
    expect(footprintDistance('headframe', 10.5, 10.5, 13, 13)).toBeCloseTo(Math.SQRT2);
    expect(footprintDistance('trooper', 10, 10, 13, 14)).toBe(5);
    expect(footprintMinX('relay', 10.25)).toBe(9.75);
    expect(footprintDistance('relay', 10.25, 10.75, 11.25, 10.75)).toBe(0.5);
    expect(footprintOverlap('shaft', 10, 10, 'turret', 11.5, 10)).toBe(false);
    expect(footprintOverlap('shaft', 10, 10, 'turret', 11.5, 10, STRUCTURE_SPACING)).toBe(true);
    expect(footprintOverlap('shaft', 10, 10, 'turret', 12.5, 10, STRUCTURE_SPACING)).toBe(false);
  });
});

describe('queued footprint funding', () => {
  it('rechecks a non-anchor cell before funding a Shaft', () => {
    const g = createGame({ seed: 9, options: WIDE });
    clearSite(g, 'nw', 20, 20, 2);
    expect(place(g, 'nw', 'shaft', 20, 20)).toEqual({ ok: true });
    g.sim.block[21 * g.sim.size + 21] = 1;
    g.step();
    expect(g.sim.armies[BLUE]!.queue[0]).toMatchObject({ item: 'shaft', status: 'blocked', reason: 'blocked', started: false });
  });
});
