/** Magma burns what it touches: the crater-ore share of ore caches, and a burned digger's load. Mirrored for both armies. */
import { describe, expect, it } from 'vitest';
import { CELL, type ArmyId, type MatchOptions, type Plane, type UnitKind } from '../src/rules/contract.ts';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import type { OreCache } from '../src/sim/state.ts';
import { cellCentreX, cellCentreY } from '../src/util/grid.ts';
import { NEUTRAL, slotOfArmyId, type Army } from '../src/util/teams.ts';

const TEAMS = ['nw', 'se'] as const satisfies readonly ArmyId[];
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/** Only the Spires and islands left; open terrain. */
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 3, options: { terrain: 'open', ...options } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  steps(g, VISION_EVERY);
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, c: number, plane: Plane = 'depths'): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, plane);
  e.x = cellCentreX(c, g.sim.size);
  e.y = cellCentreY(c, g.sim.size);
  e.cell = c;
  e.stance = 'hold';
  return e;
}

/** Blue's layout (canonical frame) and its point mirror for red: a pocket cell, then an east-running dead-end corridor. */
const POCKET = { x: 10, y: 14 };
const LENGTH = 10;
/** Corridor index of the cache (the last cell the flood reaches: magmaCells 6 → indices 0–5) and of the watcher. */
const CACHE_AT = 5;
const WATCH_AT = 8;

interface Side { team: ArmyId; army: Army; pocket: number; corridor: number[]; cache: OreCache }

function layout(g: AgentCommandGame): Side[] {
  const s = g.sim;
  expect(s.econ.magmaCells).toBe(CACHE_AT + 1);
  const blue = Array.from({ length: LENGTH + 1 }, (_, i) => POCKET.y * s.size + POCKET.x + i);
  return TEAMS.map((team, k) => {
    const cells = k === 0 ? blue : blue.map((c) => s.n - 1 - c);
    const [pocket, ...corridor] = cells as [number, ...number[]];
    // Plain rock round the whole run, so the flood follows the corridor only.
    for (const c of cells) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const n = c + dy * s.size + dx;
      s.cells[n] = CELL.rock;
      s.magma[n] = 0;
    }
    for (const c of corridor) s.cells[c] = CELL.tunnel;
    for (const grp of s.groups) for (const c of corridor) grp.known[c] = CELL.tunnel;
    s.magma[pocket] = 200 + k;
    const at = corridor[CACHE_AT]!;
    const cache: OreCache = {
      id: 9000 + k, x: cellCentreX(at, s.size), y: cellCentreY(at, s.size), alloy: 100,
      belowX: cellCentreX(at, s.size), belowY: cellCentreY(at, s.size), belowAlloy: 50,
      side: slotOfArmyId(team, 2), surfaceHolder: NEUTRAL, surfaceTicks: 0, depthsHolder: NEUTRAL, depthsTicks: 0, placed: true,
    };
    s.oreCaches.push(cache);
    return { team, army: slotOfArmyId(team, 2), pocket, corridor, cache };
  });
}

/** Each army watches its own corridor from beyond the flood's reach, then both pockets break on the same tick. */
function flood(g: AgentCommandGame, sides: Side[]): void {
  const s = g.sim;
  for (const side of sides) put(g, side.team, 'warden', side.corridor[WATCH_AT]!);
  s.depthsVersion++;
  steps(g, VISION_EVERY);
  for (const side of sides) s.breakPocket(side.pocket, side.army);
  // The flood front reaches the cache cell on its (CACHE_AT + 1)th step.
  for (let t = 0; t < (CACHE_AT + 1) * s.magmaStep && sides.some((side) => s.cells[side.corridor[CACHE_AT]!] !== CELL.magma); t++) g.step();
}

describe('magma burns ore caches', () => {
  it('burns the crater-ore share on the tick the lava reaches it, in mirror symmetry, told only to who sees it', () => {
    const g = arena();
    const s = g.sim;
    const sides = layout(g);
    const since = g.tick;
    flood(g, sides);
    for (const side of sides) {
      expect(s.cells[side.corridor[CACHE_AT]!]).toBe(CELL.magma);
      // Out of the lava's reach: the Surface share stays.
      expect(side.cache.belowAlloy).toBe(0);
      expect(side.cache.alloy).toBe(100);
    }
    const [blue, red] = sides as [Side, Side];
    expect(blue.cache.belowX + red.cache.belowX).toBe(s.size);
    expect(blue.cache.belowY + red.cache.belowY).toBe(s.size);
    const ticks = sides.map((side) => {
      const at = { x: side.cache.belowX, y: side.cache.belowY };
      const burned = g.events({ team: side.team, role: 'depths' }, since).filter((e) => e.kind === 'cache_burned');
      expect(burned).toEqual([expect.objectContaining({ plane: 'depths', ...at })]);
      const fx = g.view(side.team).fx.filter((f) => f.kind === 'cache_burned');
      expect(fx).toEqual([expect.objectContaining({ plane: 'depths', ...at, tick: burned[0]!.tick })]);
      // The observation drops the burned share.
      const seen = g.observe({ team: side.team, role: 'depths' }, since).oreCaches.find((c) => c.id === side.cache.id);
      expect(seen?.below).toBeUndefined();
      return burned[0]!.tick;
    });
    expect(ticks[0]).toBe(ticks[1]);
    // Neither army saw the other's corridor, so neither learns of that burn.
    expect(s.seesCell(blue.army, 'depths', s.n - 1 - blue.corridor[CACHE_AT]!)).toBe(false);
    expect(s.seesCell(red.army, 'depths', s.n - 1 - red.corridor[CACHE_AT]!)).toBe(false);
  });

  it('rule off: the crater-ore share survives the flood and nothing is reported', () => {
    const g = arena({ depths: { magmaDestroysCaches: false } });
    const sides = layout(g);
    const since = g.tick;
    flood(g, sides);
    for (const side of sides) {
      expect(g.sim.cells[side.corridor[CACHE_AT]!]).toBe(CELL.magma);
      expect(side.cache.belowAlloy).toBe(50);
      expect(g.events({ team: side.team, role: 'depths' }, since).some((e) => e.kind === 'cache_burned')).toBe(false);
      expect(g.view(side.team).fx.some((f) => f.kind === 'cache_burned')).toBe(false);
    }
  });

  it('a digger the lava kills loses its load: nothing delivered, no cache left behind', () => {
    const g = arena();
    const s = g.sim;
    const sides = layout(g);
    const diggers = sides.map((side) => {
      const d = put(g, side.team, 'digger', side.corridor[0]!);
      d.carry = s.econ.oreLoad;
      d.hp = 1;
      return d;
    });
    const mined = sides.map((side) => s.armies[side.army]!.stats.alloyMined);
    const caches = s.oreCaches.length;
    flood(g, sides);
    steps(g, s.magmaStep);
    sides.forEach((side, k) => {
      expect(diggers[k]!.dead || diggers[k]!.hp <= 0).toBe(true);
      expect(diggers[k]!.lastHitCause).toBe('flood');
      expect(s.armies[side.army]!.stats.alloyMined).toBe(mined[k]);
    });
    expect(s.oreCaches.length).toBe(caches);
  });
});
