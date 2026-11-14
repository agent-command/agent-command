/**
 * Depths launch fixes, mirrored for both duel armies: the standard Depths bot stacks sappers under a seen hostile
 * Headframe its tunnels reach and the collapse brings it down; a teammate's `collapse` signal is acked, undermined and
 * reported done; the `intruder` alert reads only the team's own vision and own tunnels.
 */
import { describe, expect, it } from 'vitest';
import { CELL, DEFAULT_RULES, toTicks, type ArmyId, type Observation, type Plane, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { createBot } from '../src/bots/bots.ts';
import { BOT_PERIOD } from '../src/bots/play.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const DUEL = ['nw', 'se'] as const;
type Team = (typeof DUEL)[number];
const MAP = DEFAULT_RULES.map.size;
const enemyOf = (team: Team): Team => (team === 'nw' ? 'se' : 'nw');
const armyOf = (team: ArmyId): number => slotOfArmyId(team, 2);
/** The cell at (x, y) as nw lays it out; its C2 mirror for se. */
const tile = (team: Team, x: number, y: number): number => (team === 'nw' ? y * MAP + x : (MAP - 1 - y) * MAP + (MAP - 1 - x));
const centre = (c: number) => ({ x: (c % MAP) + 0.5, y: Math.floor(c / MAP) + 0.5 });
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

function arena(): AgentCommandGame {
  const g = createGame({ seed: 6, options: { terrain: 'open', map: { params: { homeLodes: 0, contestedZones: [] } } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.sim.magma.fill(0);
  steps(g, VISION_EVERY);
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, c: number, plane: 'depths' | 'surface' = 'depths'): Ent {
  const e = g.sim.spawnUnit(armyOf(team), kind, plane);
  Object.assign(e, centre(c));
  e.cell = c;
  return e;
}
function tunnel(g: AgentCommandGame, team: ArmyId, cells: number[]): void {
  for (const c of cells) {
    g.sim.cells[c] = CELL.tunnel;
    g.sim.owner[c] = armyOf(team) + 1;
    g.sim.armies[armyOf(team)]!.group.known[c] = CELL.tunnel;
  }
}
/** Drive the team's standard Depths bot until `until` holds or `ticks` pass; every intent it sent. */
function drive(g: AgentCommandGame, team: Team, ticks: number, until: () => boolean): AgentCommandIntent[] {
  const seat = { team, role: 'depths' as Plane };
  const bot = createBot(team, 'depths', 'standard');
  bot.init?.(g.matchData(seat));
  const sent: AgentCommandIntent[] = [];
  let since = 0;
  for (const end = g.tick + ticks; g.tick < end && !until();) {
    if (g.tick % BOT_PERIOD === 0) {
      for (const intent of bot.think(g.observe(seat, since))) {
        g.apply(seat, intent, { source: 'bot' });
        sent.push(intent);
      }
      since = g.tick;
    }
    g.step();
  }
  return sent;
}
/** Our tunnel (18..22, 20 as nw lays it out) with a digger and two idle sappers in it. */
function crew(g: AgentCommandGame, team: Team): { cells: number[]; sappers: Ent[] } {
  const cells = [18, 19, 20, 21, 22].map((x) => tile(team, x, 20));
  tunnel(g, team, cells);
  put(g, team, 'digger', cells[0]!);
  return { cells, sappers: [put(g, team, 'sapper', cells[0]!), put(g, team, 'sapper', cells[1]!)] };
}

describe('strikes from below', () => {
  it.each(DUEL)('%s: the standard Depths bot stacks two sappers under a seen hostile Headframe its tunnels reach and fells it', (team) => {
    const g = arena();
    const s = g.sim;
    crew(g, team);
    const frame = s.add('headframe', armyOf(enemyOf(team)), 'surface', centre(tile(team, 20, 20)).x, centre(tile(team, 20, 20)).y);
    // A trooper of ours keeps it in sight from the surface.
    put(g, team, 'trooper', tile(team, 20, 16), 'surface');
    steps(g, VISION_EVERY);
    let stack = 0;
    const sent = drive(g, team, toTicks(30), () => {
      for (const ch of s.charges) stack = Math.max(stack, ch.stack);
      return frame.dead || frame.hp <= 0;
    });
    const wave = sent.find((i) => i.kind === 'undermine');
    expect(wave?.kind === 'undermine' && wave.units.length).toBe(2);
    expect(stack).toBe(2);
    expect(frame.hp).toBeLessThanOrEqual(0);
    expect(g.events({ team, role: 'depths' }, 0).some((e) => e.kind === 'collapse')).toBe(true);
  });

  it.each(DUEL)('%s: a Surface collapse signal is acked, sappers stack under its tile and it is reported done', (team) => {
    const g = arena();
    const { cells } = crew(g, team);
    const target = cells[3]!;
    expect(g.apply({ team, role: 'surface' }, { kind: 'signal', signal: { kind: 'request_support', to: 'depths', need: 'collapse', count: 2, x: target % MAP, y: Math.floor(target / MAP) } } as AgentCommandIntent)).toEqual({ ok: true });
    const board = () => g.signals.team(team) as Observation['signals']['inbox'];
    const sent = drive(g, team, toTicks(20), () => board()[0]?.state === 'completed');
    expect(sent).toContainEqual({ kind: 'signal_update', id: 'sg_1', update: 'ack' });
    const under = sent.find((i) => i.kind === 'undermine');
    expect(under?.kind === 'undermine' && under.units.length).toBe(2);
    expect(board()[0]).toMatchObject({ state: 'completed', by: 'depths' });
    expect(g.sim.charges[0]?.stack).toBe(2);
  });
});

describe('intruder alert', () => {
  it.each(DUEL)('%s: only hostile Depths units we see in our tunnels near our structures raise it, never what our vision misses', (team) => {
    const g = arena();
    const s = g.sim;
    const enemy = enemyOf(team);
    const ours = [30, 31, 32, 33, 34, 35, 36].map((x) => tile(team, x, 30));
    // Our Shaft over the tunnel's start (its Depths sight reaches only the first cells).
    s.add('shaft', armyOf(team), 'surface', centre(ours[0]!).x, centre(ours[0]!).y);
    tunnel(g, team, ours);
    const alerts = (who: Team) => g.observe({ team: who, role: 'surface' }, 0).alerts.filter((a) => a.kind === 'intruder');
    const events = (who: Team) => g.events({ team: who, role: 'depths' }, 0).filter((e) => e.kind === 'intruder');
    // An enemy digger in our tunnel, a few tiles from our Shaft, beyond its short Depths sight: no alert, no event.
    put(g, enemy, 'digger', ours[5]!);
    steps(g, VISION_EVERY);
    expect(alerts(team)).toEqual([]);
    expect(events(team)).toEqual([]);
    // Our digger sees it: the alert with its count and spot, one event.
    put(g, team, 'digger', ours[3]!);
    put(g, enemy, 'trooper', ours[6]!);
    steps(g, VISION_EVERY);
    expect(alerts(team)).toEqual([{ plane: 'depths', kind: 'intruder', ...centre(ours[5]!), count: 2 }]);
    expect(events(team)).toEqual([expect.objectContaining({ kind: 'intruder', ...centre(ours[5]!), count: 2 })]);
    expect(g.view(team).alerts.filter((a) => a.kind === 'intruder')).toEqual(alerts(team));
    // The intruders' own team is not warned of anything.
    expect(alerts(enemy)).toEqual([]);
    steps(g, VISION_EVERY);
    expect(events(team)).toHaveLength(1);
  });
});
