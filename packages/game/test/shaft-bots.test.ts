/**
 * Own Shafts are the only Surface↔Depths portals, so the built-in bots keep them working: the Surface bot builds a
 * Shaft beside home and sends its squads down through it, and the Depths bot tunnels to a sealed own Shaft. Short
 * scripted scenarios, one seat's bot driving, mirrored for both duel armies.
 */
import { describe, expect, it } from 'vitest';
import { CELL, STATS, toTicks, type ArmyId, type Plane } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { cellOfEnt } from '../src/util/grid.ts';
import { slotOfArmyId } from '../src/util/teams.ts';
import type { Ent } from '../src/sim/ent.ts';

const TEAMS = ['nw', 'se'] as const;

/** Drive one seat's bot every BOT_PERIOD ticks for at most `ticks`, until `each` (after every step) says done; the accepted intent kinds. */
function drive(g: AgentCommandGame, team: ArmyId, role: Plane, level: 'standard' | 'veteran', ticks: number, each: () => boolean): string[] {
  const seat = { team, role };
  const bot = createBot(team, role, level);
  bot.init?.(g.matchData(seat));
  const accepted: string[] = [];
  let since = g.tick;
  for (let i = 0; i < ticks; i++) {
    if (g.tick % BOT_PERIOD === 0) {
      const obs = g.observe(seat, since);
      since = g.tick;
      for (const intent of bot.think(obs)) if (g.apply(seat, intent, { source: 'bot' }).ok) accepted.push(intent.kind);
    }
    g.step();
    if (each()) break;
  }
  return accepted;
}

describe.each(TEAMS)('built-in bots keep Shaft portals (%s)', (team) => {
  it('the Surface bot builds a home Shaft and sends a squad down through it', () => {
    const g = createGame({ seed: 3 });
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    // Past the home-Shaft and breach-raid times of the veteran tier, with funds and a squad at home.
    s.tick = toTicks(360);
    s.armies[army]!.alloy = 5000;
    s.armies[army]!.energy = 5000;
    for (let i = 0; i < 6; i++) s.spawnUnit(army, 'trooper', 'surface');
    let shaft: Ent | undefined;
    const accepted = drive(g, team, 'surface', 'veteran', toTicks(40), () => {
      shaft ??= s.ents.find((e) => e.kind === 'shaft' && e.side === army && !e.dead);
      // Script the Depths seat's dig: open the cell beside the finished Shaft's landing.
      if (shaft?.built && s.shaftSealed(army, shaft)) {
        const c = cellOfEnt(shaft, s.size) + (team === 'nw' ? 1 : -1);
        s.cells[c] = CELL.tunnel;
        s.armies[army]!.group.known[c] = CELL.tunnel;
      }
      return s.ents.some((e) => e.kind === 'trooper' && e.side === army && e.plane === 'depths');
    });
    expect(shaft?.built).toBe(true);
    // Beside home: within a few tiles of the Spire.
    const home = s.spireAt[army]!;
    expect(Math.hypot(shaft!.x - home.x, shaft!.y - home.y)).toBeLessThan(10);
    expect(accepted).toContain('transfer');
    expect(s.ents.some((e) => e.kind === 'trooper' && e.side === army && e.plane === 'depths')).toBe(true);
  });

  it('the Depths bot tunnels to a sealed own Shaft until it is a portal', () => {
    const g = createGame({ seed: 3 });
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    // Its landing (cell 14,14 on the nw side, the mirror for se) opens alone in rock: sealed.
    const at = (v: number): number => (team === 'nw' ? v : s.size - v);
    const shaft = s.build(army, 'shaft', at(14.5), at(14.5), 'surface');
    for (let i = 0; i <= STATS.shaft.build + VISION_EVERY; i++) g.step();
    expect(shaft.built).toBe(true);
    expect(s.shaftSealed(army, shaft)).toBe(true);
    const accepted = drive(g, team, 'depths', 'standard', toTicks(60), () => !s.shaftSealed(army, shaft));
    expect(accepted).toContain('designate');
    expect(s.shaftSealed(army, shaft)).toBe(false);
  });
});
