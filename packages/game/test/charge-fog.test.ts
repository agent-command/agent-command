/**
 * Fogged charges (rules.depths.chargesFogged, chargePublicTime), mirrored for both duel armies: a planted charge is
 * known to the planter's team at once, to a hostile team only through its own Depths vision of the cell or a tremor it
 * feels there, and to everyone for its last chargePublicTime. Before that nothing about it reaches the hostile team:
 * not `charges`, the `schedule`, events, alerts, the view or its effects. A team that knows of it can defuse it.
 */
import { describe, expect, it } from 'vitest';
import { CELL, DEFAULT_RULES, ECON, type ArmyId, type MatchOptions, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const DUEL = ['nw', 'se'] as const;
type Team = (typeof DUEL)[number];
const MAP = DEFAULT_RULES.map.size;
const enemyOf = (team: Team): Team => (team === 'nw' ? 'se' : 'nw');
const armyOf = (team: ArmyId): number => slotOfArmyId(team, 2);
/** The cell at (x, y) as `victim` = nw lays it out; its C2 mirror when the victim is se. */
const tile = (victim: Team, x: number, y: number): number => (victim === 'nw' ? y * MAP + x : (MAP - 1 - y) * MAP + (MAP - 1 - x));
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/** Spires and islands only, no magma: the hostile pocket's tunnels are carved by each test. */
function arena(depths: MatchOptions['depths'] = {}): AgentCommandGame {
  const g = createGame({ seed: 6, options: { terrain: 'open', map: { params: { homeLodes: 0, contestedZones: [] } }, depths } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.sim.magma.fill(0);
  steps(g, VISION_EVERY);
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, c: number, plane: 'depths' | 'surface' = 'depths'): Ent {
  const e = g.sim.spawnUnit(armyOf(team), kind, plane);
  e.x = (c % MAP) + 0.5;
  e.y = Math.floor(c / MAP) + 0.5;
  e.cell = c;
  return e;
}
/** Tunnel cells dug by `team` and known to it. */
function tunnel(g: AgentCommandGame, team: ArmyId, cells: number[]): void {
  const s = g.sim;
  for (const c of cells) {
    s.cells[c] = CELL.tunnel;
    s.owner[c] = armyOf(team) + 1;
    s.armies[armyOf(team)]!.group.known[c] = CELL.tunnel;
  }
}
/** The planter's sapper walks its tunnel (30..36, 30 in the victim's layout) and plants at its end; the charge. */
function plant(g: AgentCommandGame, victim: Team) {
  const planter = enemyOf(victim);
  const route = [30, 31, 32, 33, 34, 35, 36].map((x) => tile(victim, x, 30));
  tunnel(g, planter, route);
  const sapper = put(g, planter, 'sapper', route[0]!);
  const at = route.at(-1)!;
  expect(g.apply({ team: planter, role: 'depths' }, { kind: 'undermine', units: [g.entityId(planter, sapper.id)], x: at % MAP, y: Math.floor(at / MAP) })).toEqual({ ok: true });
  for (let t = 0; t < 400 && g.sim.charges.length === 0; t++) g.step();
  expect(g.sim.charges).toHaveLength(1);
  return { planter, at, charge: g.sim.charges[0]!, since: g.tick };
}
/** Everything about charges `team` is told: its observation, view, events and effects. */
function told(g: AgentCommandGame, team: Team, since: number) {
  const obs = g.observe({ team, role: 'depths' }, since);
  const view = g.view(team);
  return {
    charges: obs.charges,
    viewCharges: view.charges,
    schedule: obs.schedule.filter((s) => s.kind === 'collapse'),
    alerts: obs.alerts.filter((a) => a.kind === 'charge'),
    events: g.events({ team, role: 'depths' }, since).filter((e) => e.kind.startsWith('charge_')).map((e) => e.kind),
    defuseFx: view.fx.some((f) => f.kind === 'defuse'),
  };
}
const nothing = { charges: [], viewCharges: [], schedule: [], alerts: [], events: [], defuseFx: false };

describe('fogged charges', () => {
  it.each(DUEL)('%s: a hostile charge stays hidden from every channel until its public last seconds, the planter knows it all along', (victim) => {
    const g = arena();
    const { planter, at, charge, since } = plant(g, victim);
    const publicAt = charge.at - ECON.chargePublicTicks;
    const x = at % MAP;
    const y = Math.floor(at / MAP);
    // The planter's team: its charge with the stack, the schedule entry and its own event.
    const own = told(g, planter, 0);
    expect(own.charges).toEqual([{ x, y, tick: charge.at, side: planter, stack: 1 }]);
    expect(own.schedule).toEqual([{ kind: 'collapse', tick: charge.at, x: x + 0.5, y: y + 0.5 }]);
    expect(own.events).toEqual(['charge_planted']);
    // The victim: nothing at all before the public window (checked every vision stamp).
    while (g.tick < publicAt - 1) {
      expect(told(g, victim, since)).toEqual(nothing);
      steps(g, VISION_EVERY);
    }
    steps(g, publicAt + 1 - g.tick);
    const seen = told(g, victim, since);
    expect(seen.charges).toEqual([{ x, y, tick: charge.at, side: planter }]);
    expect(seen.viewCharges).toEqual(seen.charges);
    expect(seen.schedule).toEqual([{ kind: 'collapse', tick: charge.at, x: x + 0.5, y: y + 0.5 }]);
    expect(seen.alerts).toEqual([{ plane: 'depths', kind: 'charge', tick: charge.at, x: x + 0.5, y: y + 0.5 }]);
    expect(seen.events).toEqual(['charge_spotted']);
    // Told once: the planter hears nothing more.
    expect(g.events({ team: planter, role: 'depths' }, since).filter((e) => e.kind === 'charge_spotted')).toEqual([]);
  });

  it.each(DUEL)('%s: our own Depths vision finds a hidden charge, and a unit that knows it defuses it (told only to the teams that knew)', (victim) => {
    const g = arena();
    const { planter, at, charge, since } = plant(g, victim);
    expect(told(g, victim, since)).toEqual(nothing);
    // A digger of the victim's walks into the planter's tunnel, next to the charge: it sees the cell.
    const beside = tile(victim, 35, 30);
    const digger = put(g, victim, 'digger', beside);
    steps(g, VISION_EVERY);
    expect(g.tick).toBeLessThan(charge.at - ECON.chargePublicTicks);
    const seen = told(g, victim, since);
    expect(seen.charges).toEqual([{ x: at % MAP, y: Math.floor(at / MAP), tick: charge.at, side: planter }]);
    expect(seen.events).toEqual(['charge_spotted']);
    // Standing within defuseReach for defuseTime disarms it: both teams hear, nothing blows.
    steps(g, ECON.defuseTicks + 1);
    expect(g.sim.charges).toEqual([]);
    expect(digger.hp).toBeGreaterThan(0);
    for (const team of [victim, planter]) {
      const kinds = g.events({ team, role: 'depths' }, since).filter((e) => e.kind === 'charge_defused');
      expect(kinds).toHaveLength(1);
      expect(kinds[0]).toMatchObject({ side: planter, killer: victim });
    }
    steps(g, ECON.undermineTicks);
    expect(g.sim.holeCount).toBe(0);
  });

  it.each(DUEL)('%s: a tremor our surface presence feels over the cell reveals a hidden charge', (victim) => {
    const g = arena();
    const { planter, at, charge, since } = plant(g, victim);
    // The sapper went home (dead): only the charge is under there, sensed by a trooper standing above it.
    for (const e of g.sim.ents) if (e.kind === 'sapper') e.hp = 0;
    expect(told(g, victim, since)).toEqual(nothing);
    put(g, victim, 'trooper', at, 'surface');
    steps(g, VISION_EVERY);
    expect(g.tick).toBeLessThan(charge.at - ECON.chargePublicTicks);
    const seen = told(g, victim, since);
    expect(seen.charges).toEqual([{ x: at % MAP, y: Math.floor(at / MAP), tick: charge.at, side: planter }]);
    expect(seen.alerts).toHaveLength(1);
    expect(seen.events).toEqual(['charge_spotted']);
  });

  it.each(DUEL)('%s: with chargesFogged off every charge is public from the moment it is planted', (victim) => {
    const g = arena({ chargesFogged: false });
    const { planter, at, charge } = plant(g, victim);
    // Told in the very tick it was planted.
    const seen = told(g, victim, 0);
    expect(seen.charges).toEqual([{ x: at % MAP, y: Math.floor(at / MAP), tick: charge.at, side: planter }]);
    expect(seen.events).toEqual(['charge_spotted']);
  });
});
