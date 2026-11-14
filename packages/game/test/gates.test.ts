/**
 * Bulkheads only where they cut the enemy's walk: the built-in Depths bots (standard keeps one, veteran two) and the
 * example Depths policy gate a 1-wide choke on the route, seal a wider passage with its whole cross-section within
 * their budget, or place nothing; never a lone gate beside an open bypass. Every layout runs for both mirrored teams.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { intentSchema, validate } from 'playerthree';
import { createGame } from '../src/agent/adapter.ts';
import { CELL, DEFAULT_RULES, isOpenCell, type MatchData, type Observation, type Opponent, type ArmyId } from '../src/rules/contract.ts';
import { createBot } from '../src/bots/bots.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { manifest } from '../src/agent/manifest.ts';
import { DECIDE_FIRST, starterScript } from './starter-policies.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const wire = intentSchema(manifest);
type Brain = 'standard' | 'veteran' | 'policy';
/**
 * The Depths starter deciding on its first call, with the veteran's two bulkheads (knob bulkheads; its standard tier
 * keeps one) so that it seals cross-sections too, under its own gate-walk bound.
 */
const DEPTHS_STARTER = await starterScript('depths', { ...DECIDE_FIRST, bulkheads: 2 });

/**
 * Blue's layout (red: its point mirror): the Spire root (7..9, inset 8) in its tunnel apron ring (6..10), a 2-wide
 * corridor east from the apron (rows 8–9, x 11–12), then the `open` cells. Three diggers wait on the apron (10, 8).
 */
function fixture(team: ArmyId, brain: Brain, open: [number, number][], holes: [number, number][] = []) {
  const game = createGame({ seed: 91, options: { map: { params: { spireInset: 8, homeLodes: 0, contestedZones: [] } } } });
  const size = game.sim.size;
  const seat = { team, role: 'depths' } as const;
  const cell = (x: number, y: number): number => (team === 'nw' ? y * size + x : (size - 1 - y) * size + (size - 1 - x));
  for (let i = 0; i < 3; i++) game.sim.spawnUnit(slotOfArmyId(team, 2), 'digger', 'depths');
  const snapshot = game.observe(seat, 0);
  const matchData = game.matchData(seat);
  matchData.faults = [];
  const obs: Observation = { ...snapshot, depths: snapshot.depths! };
  obs.depths!.fill(CELL.bedrock);
  for (let y = 6; y <= 10; y++) for (let x = 6; x <= 10; x++) if (x < 7 || x > 9 || y < 7 || y > 9) obs.depths![cell(x, y)] = CELL.tunnel;
  for (const [x, y] of rect(11, 8, 12, 9)) obs.depths![cell(x, y)] = CELL.tunnel;
  for (const [x, y] of open) obs.depths![cell(x, y)] = CELL.tunnel;
  obs.holes = holes.map(([x, y]) => ({ x: cell(x, y) % size, y: Math.floor(cell(x, y) / size), kind: 'crater' as const }));
  obs.lodes = []; obs.cracks = []; obs.charges = []; obs.queue = []; obs.oreCaches = [];
  obs.res.alloy = obs.res.freeAlloy = 1000;
  const apron = cell(10, 8);
  for (const e of obs.entities) if (e.side === team && e.kind === 'digger') { e.x = apron % size + 0.5; e.y = Math.floor(apron / size) + 0.5; }
  game.sim.cells.set(obs.depths!);
  game.sim.armies[slotOfArmyId(team, 2)]!.group.known.set(obs.depths!);
  let think: () => AgentCommandIntent[];
  if (brain === 'policy') {
    const policy = runInNewContext(`${DEPTHS_STARTER}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
    policy.init(matchData);
    think = () => structuredClone(policy.think(obs));
  } else {
    const bot = createBot(team, 'depths', brain as Opponent);
    bot.init?.(matchData);
    think = () => bot.think(obs) as AgentCommandIntent[];
  }
  const gates = (): number[] => {
    const intents = think();
    for (const intent of intents) {
      const result = validate(wire, intent);
      expect(result.ok ? true : result).toBe(true);
    }
    const sites: number[] = [];
    for (const intent of intents) {
      if (intent.kind !== 'queue_add' || intent.item !== 'bulkhead') continue;
      sites.push(intent.y! * size + intent.x!);
      // Every site is a legal gate for this team.
      expect(game.apply(seat, intent)).toEqual({ ok: true });
    }
    // In queue order: mirrored teams queue mirrored cells in the same order (it decides funding and builders).
    return sites;
  };
  /** Can the enemy still walk from `from` to the root apron with bulkheads on `gates`? */
  const walks = (from: number, gates: readonly number[]): boolean => {
    const seen = new Set<number>([from, ...gates]);
    if (gates.includes(from)) return false;
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      if (at === apron) return true;
      const x = at % size;
      for (const n of [x < size - 1 ? at + 1 : -1, x > 0 ? at - 1 : -1, at + size, at - size]) {
        if (n < 0 || n >= size * size || seen.has(n) || !isOpenCell(obs.depths![n]!)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return false;
  };
  return { cell, gates, walks };
}

const mirror = (cells: readonly number[]): number[] => cells.map((c) => DEFAULT_RULES.map.size ** 2 - 1 - c);
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => {
  const out: [number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
};

describe('bulkheads go where they cut the enemy route', () => {
  // A 2-wide passage: east along rows 8–9 to x = 16, then south down columns 15–16 to y = 20. Its corner cells have
  // only two open neighbours each, yet a gate on one is walked around.
  const twoWide = [...rect(13, 8, 16, 9), ...rect(15, 10, 16, 20)];
  // The same bend 3 wide (rows 8–10, columns 15–17): wider than any bulkhead budget.
  const threeWide = [...rect(13, 8, 17, 10), ...rect(15, 11, 17, 20)];
  // A straight 2-wide passage pinched at x = 17 to its row-8 cell: (16..18, 8) each cut it; the one nearest the centre
  // is (18, 8).
  const pinched = rect(13, 8, 22, 9).filter(([x, y]) => !(x === 17 && y === 9));

  for (const brain of ['standard', 'veteran', 'policy'] as const) {
    const seen: Record<string, Partial<Record<'nw' | 'se', number[]>>> = {};
    for (const team of ['nw', 'se'] as const) {
      it(`${brain} ${team}: a 1-wide choke on the route gets exactly one bulkhead`, () => {
        const f = fixture(team, brain, pinched);
        const sites = f.gates();
        expect(sites).toEqual([f.cell(18, 8)]);
        expect(f.walks(f.cell(22, 9), sites)).toBe(false);
        (seen.pinched ??= {})[team] = sites;
      });

      it(`${brain} ${team}: a 2-wide passage gets no lone bulkhead${brain === 'standard' ? '' : ', only its whole cross-section'}`, () => {
        const f = fixture(team, brain, twoWide);
        const sites = f.gates();
        const far = f.cell(16, 20);
        expect(f.walks(far, [])).toBe(true);
        if (brain === 'standard') expect(sites).toEqual([]);
        else {
          expect(sites).toHaveLength(2);
          expect(f.walks(far, sites)).toBe(false);
          for (const s of sites) expect(f.walks(far, sites.filter((o) => o !== s))).toBe(true);
        }
        (seen.twoWide ??= {})[team] = sites;
      });

      it(`${brain} ${team}: a passage wider than the budget gets no bulkhead at all`, () => {
        const f = fixture(team, brain, threeWide);
        expect(f.gates()).toEqual([]);
      });
    }
    it(`${brain}: blue and red choose mirrored sites`, () => {
      for (const layout of Object.values(seen)) expect(mirror(layout.se ?? [])).toEqual(layout.nw ?? []);
    });
  }

  for (const team of ['nw', 'se'] as const) {
    // A crater over a straight 2-wide passage: troopers dropping in walk to the root around a gate on either lane.
    const passage = rect(13, 8, 20, 9);
    it(`standard ${team}: no lone bulkhead beside a hole opening into a 2-wide passage`, () => {
      const f = fixture(team, 'standard', passage, [[16, 8]]);
      expect(f.gates()).toEqual([]);
    });

    it(`standard ${team}: a hole whose way home pinches to one cell gets the cut nearest the hole`, () => {
      // (13..15, 8) each cut the way home once (14, 9) is rock; (15, 8) is beside the hole.
      const f = fixture(team, 'standard', passage.filter(([x, y]) => !(x === 14 && y === 9)), [[16, 8]]);
      const sites = f.gates();
      expect(sites).toEqual([f.cell(15, 8)]);
      expect(f.walks(f.cell(16, 8), sites)).toBe(false);
    });
  }
});
