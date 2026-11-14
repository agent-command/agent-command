// @module-tag timing — every call runs under the sandbox's per-call time budget; serial timing set (pnpm test:timing).
/**
 * The example Depths policy gates only real route cuts, for both teams, and plans them inside its CPU budget even on a
 * first call over a fully open cavern (every cell of the walk has a bypass, so no candidate may cost a cavern walk).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loadPolicy, type PolicyInstance } from 'playerthree/policy';
import { CELL, toTicks, type ArmyId, type MatchData, type Observation } from '../src/rules/contract.ts';
import { createGame } from '../src/agent/adapter.ts';
import { manifest } from '../src/agent/manifest.ts';
import { DECIDE_FIRST, starterScript } from './starter-policies.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';

const limits = manifest.control.policy;
/**
 * The Depths starter deciding on its first call (prepare and decide in the one call, the dearer case) with the
 * veteran's two bulkheads (knob bulkheads; its standard tier keeps one), so that cross-sections are planned too, under
 * its own gate-walk bound.
 */
const DEPTHS_STARTER = await starterScript('depths', { ...DECIDE_FIRST, bulkheads: 2 });
const instances: PolicyInstance[] = [];
afterAll(() => {
  for (const i of instances) i.dispose();
});

async function think(matchData: MatchData, obs: Observation): Promise<AgentCommandIntent[]> {
  const loaded = await loadPolicy('js', DEPTHS_STARTER, limits, { seed: 1, matchData });
  if (!loaded.ok) throw new Error(`depths policy failed to load: ${loaded.error.code}`);
  instances.push(loaded.instance);
  const r = await loaded.instance.call(obs);
  if (!r.ok) throw new Error(`depths policy failed after ${r.cpuMs ?? '?'} ms CPU (budget ${limits.msPerCall} ms CPU): ${r.error.code}`);
  return r.value.intents as AgentCommandIntent[];
}

/** A duel's armies: army 0 on the NW slot, army 1 on the SE slot (its point mirror). */
const DUEL = ['nw', 'se'] as const;

/** Queued bulkheads in the NW army's frame (the SE army's are mirrored back), in queue order. */
function gates(intents: AgentCommandIntent[], team: ArmyId, size: number): { x: number; y: number }[] {
  return intents.flatMap((i) => i.kind === 'queue_add' && i.item === 'bulkhead' && i.x !== undefined && i.y !== undefined
    ? [team === 'nw' ? { x: i.x, y: i.y } : { x: size - 1 - i.x, y: size - 1 - i.y }] : []);
}

describe('depths policy bulkhead route cuts', () => {
  it('plans the first call over a fully open cavern within its CPU budget, gating nothing', async () => {
    for (const [army, team] of DUEL.entries()) {
      const g = createGame({ seed: 3 });
      const seat = { team, role: 'depths' } as const;
      const matchData = g.matchData(seat);
      for (let i = 0; i < 3; i++) g.sim.spawnUnit(army, 'sapper', 'depths');
      const obs = g.observe(seat, 0);
      obs.tick = toTicks(240);
      obs.depths!.fill(CELL.tunnel);
      obs.mandate.limits = { collapses: false };
      expect(gates(await think(matchData, obs), team, g.sim.size)).toEqual([]);
    }
  });

  it('gates only a cut of the walk to the cavern centre, mirrored for both teams', async () => {
    // Root apron (10, 8) beside the inset-8 Spire; candidates lie 8–12 tiles from the Spire centre (8.5, 8.5).
    type Layout = { tunnels: [number, number][]; blockers?: { kind: 'geothermal' | 'bulkhead'; side: 'own' | 'enemy'; x: number; y: number }[] };
    const corridor = (y0: number, y1: number, x0: number, x1: number): [number, number][] => {
      const cells: [number, number][] = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push([x, y]);
      return cells;
    };
    // Rows 8 and 12 joined down column 10; row 8 is a dead end, so every row-12 cell cuts the walk to (24, 12).
    const deadEnd = [...corridor(8, 8, 10, 24), ...corridor(9, 12, 10, 10), ...corridor(12, 12, 11, 24)];
    const cases: [string, Layout, { x: number; y: number }[]][] = [
      ['a 1-wide choke: the cut cell nearest the centre', { tunnels: deadEnd }, [{ x: 19, y: 12 }]],
      // Column 24 closes the loop: every walk cell has a bypass that its own 3×3 ring cannot show.
      ['a 1-wide loop: no cut', { tunnels: [...deadEnd, ...corridor(9, 11, 24, 24)] }, []],
      // Row 13 doubles row 12: no single cut, so the whole 2-cell cross-section nearest the centre.
      ['a 2-wide passage: its cross-section', { tunnels: [...deadEnd, ...corridor(13, 13, 10, 24), ...corridor(12, 13, 10, 10)] },
        [{ x: 19, y: 12 }, { x: 19, y: 13 }]],
      // A tap on the dead end blocks plans there, and our own bulkhead stands in the cavern: the cut is unchanged.
      ['blockers off the walk', {
        tunnels: deadEnd,
        blockers: [{ kind: 'geothermal', side: 'enemy', x: 13, y: 8 }, { kind: 'bulkhead', side: 'own', x: 15, y: 8 }],
      }, [{ x: 19, y: 12 }]],
    ];
    for (const [name, layout, expected] of cases) for (const team of DUEL) {
      const g = createGame({ seed: 3, options: { map: { params: { spireInset: 8 } } } });
      const size = g.sim.size;
      const mirror = (x: number, y: number): number => team === 'nw' ? y * size + x : size * size - 1 - (y * size + x);
      const obs = g.observe({ team, role: 'depths' }, 0);
      const matchData = g.matchData({ team, role: 'depths' });
      obs.res.alloy = obs.res.freeAlloy = 1000;
      matchData.faults = [];
      obs.lodes = [];
      obs.holes = [];
      obs.cracks = [];
      obs.depths!.fill(CELL.bedrock);
      for (const [x, y] of layout.tunnels) obs.depths![mirror(x, y)] = CELL.tunnel;
      const spire = obs.entities.find((e) => e.kind === 'spire')!;
      for (const b of layout.blockers ?? []) {
        const c = mirror(b.x, b.y);
        obs.entities.push({
          ...spire, id: `${b.side}-${b.kind}`, kind: b.kind, plane: 'depths',
          side: b.side === 'own' ? team : team === 'nw' ? 'se' : 'nw', x: c % size + 0.5, y: Math.floor(c / size) + 0.5,
        });
      }
      const intents = await think(matchData, obs);
      expect(gates(intents, team, size), `${name} (${team})`).toEqual(expected);
    }
  });
});
