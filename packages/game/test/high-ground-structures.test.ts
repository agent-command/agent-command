/**
 * Structures and lodes on high ground (DESIGN §4.2): a Surface site's footprint plus apron stand on one level, all
 * ground or all one plateau; structures up there get the high-ground range and vision; plateau lodes take a working
 * Headframe and are mined like any other. Every case runs mirrored for both teams.
 */
import { describe, expect, it } from 'vitest';
import { CELL, ECON, STATS, STRUCTURE_SPACING, SURFACE, toTicks, type Plane, type ArmyId } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { applyIntent, type AgentCommandIntent } from '../src/agent/intents.ts';
import { LODE_SEAL } from '../src/maps/world.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const act = (g: AgentCommandGame, team: ArmyId, role: Plane, intent: AgentCommandIntent) => g.apply({ team, role }, intent);

/**
 * Only the Spires and islands left, no magma: tests lay out their own sites and tunnels. The Spire's build radius
 * covers the whole map: these cases are about levels, not reach (build-radius.test.ts).
 */
function arena(seed: number, terrain: 'open' | 'highlands'): AgentCommandGame {
  const g = createGame({ seed, options: { terrain, surface: { buildRadiusSpire: 80 } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.sim.magma.fill(0);
  steps(g, VISION_EVERY);
  return g;
}

/** Blue's min anchor (x, y) for a `w`×`h` footprint, or red's mirrored anchor. */
const anchor = (g: AgentCommandGame, team: ArmyId, x: number, y: number, w: number, h: number): { x: number; y: number } =>
  team === 'nw' ? { x, y } : { x: g.sim.size - w - x, y: g.sim.size - h - y };

/** A clear, visible site: footprint and apron at `level`, plain rock below, no holes or blockers. */
function levelSite(g: AgentCommandGame, team: ArmyId, x: number, y: number, w: number, h: number, level: number): void {
  const s = g.sim;
  for (let cy = y - STRUCTURE_SPACING; cy < y + h + STRUCTURE_SPACING; cy++) {
    for (let cx = x - STRUCTURE_SPACING; cx < x + w + STRUCTURE_SPACING; cx++) {
      const c = cy * s.size + cx;
      s.terrain[c] = level;
      s.cells[c] = CELL.rock;
      s.holes[c] = s.block[c] = 0;
      s.vis[1]![c]! |= s.armies[slotOfArmyId(team, 2)]!.group.bit;
    }
  }
}

describe('structures on one level', () => {
  for (const item of ['turret', 'shaft'] as const) {
    it(`${item}: valid on an all-high site, invalid when its footprint or apron straddles a level`, () => {
      const g = arena(9, 'open');
      const s = g.sim;
      const f = STATS[item].footprint;
      const results: Record<'nw' | 'se', unknown[]> = { nw: [], se: [] };
      for (const team of (['nw', 'se'] as const)) {
        const { x, y } = anchor(g, team, 20, 20, f.w, f.h);
        const place = () => {
          const r = applyIntent(s, slotOfArmyId(team, 2), 'surface', { kind: 'queue_add', item, x, y });
          s.armies[slotOfArmyId(team, 2)]!.queue.length = 0;
          return r;
        };
        const out = results[team];
        levelSite(g, team, x, y, f.w, f.h, SURFACE.high);
        out.push(place());
        // Every footprint cell and every apron cell must share the plateau's level.
        for (let cy = y - STRUCTURE_SPACING; cy < y + f.h + STRUCTURE_SPACING; cy++) {
          for (let cx = x - STRUCTURE_SPACING; cx < x + f.w + STRUCTURE_SPACING; cx++) {
            for (const other of [SURFACE.ground, SURFACE.cliff, SURFACE.forest, SURFACE.ford, SURFACE.fault, SURFACE.water]) {
              levelSite(g, team, x, y, f.w, f.h, SURFACE.high);
              s.terrain[cy * s.size + cx] = other;
              out.push(place());
            }
          }
        }
        // The same site straddles nothing once it is all low ground; a single raised apron cell breaks it again.
        levelSite(g, team, x, y, f.w, f.h, SURFACE.ground);
        out.push(place());
        s.terrain[(y - STRUCTURE_SPACING) * s.size + x - STRUCTURE_SPACING] = SURFACE.high;
        out.push(place());
      }
      const ring = (f.w + 2 * STRUCTURE_SPACING) * (f.h + 2 * STRUCTURE_SPACING);
      expect(results.nw).toEqual([
        { ok: true },
        ...Array.from({ length: ring * 6 }, () => ({ ok: false, code: 'blocked' })),
        { ok: true },
        { ok: false, code: 'blocked' },
      ]);
      expect(results.se).toEqual(results.nw);
    });
  }

  it('a turret on a plateau gets the high-ground range and vision, mirrored', () => {
    const g = arena(9, 'open');
    const s = g.sim;
    const r = STATS.turret.vision;
    const turrets: Record<'nw' | 'se', Ent> = {} as Record<'nw' | 'se', Ent>;
    for (const team of (['nw', 'se'] as const)) {
      const { x, y } = anchor(g, team, 20, 20, 1, 1);
      // Flat open ground out to the far vision edge, the turret's site raised.
      const dir = team === 'nw' ? 1 : -1;
      for (let k = -1; k <= r + ECON.highVision + 1; k++) for (const dy of [-1, 0, 1]) s.terrain[(y + dy) * s.size + x + dir * k] = SURFACE.ground;
      levelSite(g, team, x, y, 1, 1, SURFACE.high);
      turrets[team] = s.add('turret', slotOfArmyId(team, 2), 'surface', x + 0.5, y + 0.5);
      turrets[team].built = true;
      const bit = s.armies[slotOfArmyId(team, 2)]!.group.bit, vis = s.vis[1]!;
      for (let c = 0; c < vis.length; c++) vis[c]! &= ~bit;
    }
    steps(g, VISION_EVERY);
    for (const team of (['nw', 'se'] as const)) {
      const t = turrets[team];
      const { x, y } = anchor(g, team, 20, 20, 1, 1);
      const dir = team === 'nw' ? 1 : -1;
      expect(s.onHigh(t)).toBe(true);
      const target = s.add('tank', slotOfArmyId(team === 'nw' ? 'se' : 'nw', 2), 'surface', t.x + dir * 3, t.y);
      expect(s.reach(t, target)).toBeCloseTo(STATS.turret.range + ECON.highRange + target.radius, 9);
      target.hp = 0;
      // A low cell beyond plain vision but inside the raised vision is seen.
      expect(s.vis[1]![y * s.size + x + dir * (r + 1)]! & s.armies[slotOfArmyId(team, 2)]!.group.bit).not.toBe(0);
    }
  });
});

describe('plateau lodes', () => {
  it('a high-ground lode takes a working Headframe and its pocket is mined, mirrored', () => {
    const g = arena(1, 'highlands');
    const s = g.sim;
    // Highlands lodes sit on plateau tops: their outcrop and apron are all high ground.
    const home = s.lodes.findIndex((l, i) => i % 2 === 0 && !l.rich && s.terrain[l.c] === SURFACE.high);
    expect(home).toBeGreaterThanOrEqual(0);
    const lodes = { nw: s.lodes[home]!, se: s.lodes[home + 1]! };
    expect(lodes.se.c).toBe(s.size * s.size - 1 - lodes.nw.c);
    const frames: Partial<Record<'nw' | 'se', Ent>> = {};
    const diggers: Partial<Record<'nw' | 'se', Ent>> = {};
    for (const team of (['nw', 'se'] as const)) {
      const l = lodes[team];
      const lx = l.c % s.size;
      const ly = Math.floor(l.c / s.size);
      const dir = team === 'nw' ? 1 : -1;
      for (let dy = -LODE_SEAL; dy <= LODE_SEAL; dy++) for (let dx = -LODE_SEAL; dx <= LODE_SEAL; dx++) {
        expect(s.terrain[(ly + dy) * s.size + lx + dx]).toBe(SURFACE.high);
      }
      s.armies[slotOfArmyId(team, 2)]!.alloy = 10_000;
      l.known |= s.armies[slotOfArmyId(team, 2)]!.group.bit;
      // Only eyes on the plateau see its top: a trooper on the apron.
      const eye = s.spawnUnit(slotOfArmyId(team, 2), 'trooper', 'surface');
      eye.x = lx - dir * LODE_SEAL + 0.5;
      eye.y = ly + 0.5;
      // A corridor to the seal, for a digger to work the pocket once the Headframe opens it.
      for (let k = LODE_SEAL + 1; k <= LODE_SEAL + 4; k++) {
        const c = ly * s.size + lx + dir * k;
        s.cells[c] = CELL.tunnel;
        s.armies[slotOfArmyId(team, 2)]!.group.known[c] = CELL.tunnel;
        for (const n of [c - s.size, c + s.size]) if (s.cells[n] !== CELL.bedrock) s.cells[n] = CELL.rock;
      }
      const digger = s.spawnUnit(slotOfArmyId(team, 2), 'digger', 'depths');
      digger.cell = ly * s.size + lx + dir * (LODE_SEAL + 1);
      digger.x = (digger.cell % s.size) + 0.5;
      digger.y = ly + 0.5;
      diggers[team] = digger;
    }
    steps(g, VISION_EVERY);
    for (const team of (['nw', 'se'] as const)) {
      const l = lodes[team];
      expect(act(g, team, 'surface', { kind: 'queue_add', item: 'headframe', x: l.c % s.size, y: Math.floor(l.c / s.size) })).toEqual({ ok: true });
    }
    g.step();
    for (const team of (['nw', 'se'] as const)) {
      frames[team] = s.ents.find((e) => e.kind === 'headframe' && e.side === slotOfArmyId(team, 2))!;
      expect([frames[team]!.x, frames[team]!.y]).toEqual([(lodes[team].c % s.size) + 0.5, Math.floor(lodes[team].c / s.size) + 0.5]);
    }
    steps(g, STATS.headframe.build + VISION_EVERY);
    for (const team of (['nw', 'se'] as const)) {
      const frame = frames[team]!;
      expect(frame.built).toBe(true);
      expect(s.onHigh(frame)).toBe(true);
      expect(lodes[team].open).toBe(true);
      expect(s.armies[slotOfArmyId(team, 2)]!.drop[lodes[team].c]).toBe(1);
      const l = lodes[team];
      expect(act(g, team, 'depths', { kind: 'mine', units: [g.entityId(team, diggers[team]!.id)], x: (l.c % s.size) + 0.5, y: Math.floor(l.c / s.size) + 0.5 })).toEqual({ ok: true });
    }
    const mined0 = { nw: s.armies[BLUE]!.stats.alloyMined, se: s.armies[RED]!.stats.alloyMined };
    const left0 = lodes.nw.left;
    for (let t = 0; t < toTicks(90) && (['nw', 'se'] as const).some((team) => s.armies[slotOfArmyId(team, 2)]!.stats.alloyMined <= mined0[team]); t++) g.step();
    for (const team of (['nw', 'se'] as const)) {
      expect(s.armies[slotOfArmyId(team, 2)]!.stats.alloyMined).toBeGreaterThan(mined0[team]);
      expect(lodes[team].left).toBeLessThan(left0);
    }
    expect(s.armies[RED]!.stats.alloyMined).toBe(s.armies[BLUE]!.stats.alloyMined);
    expect(lodes.se.left).toBe(lodes.nw.left);
    expect(diggers.se!.x).toBeCloseTo(s.size - diggers.nw!.x, 9);
    expect(diggers.se!.y).toBeCloseTo(s.size - diggers.nw!.y, 9);
  });
});
