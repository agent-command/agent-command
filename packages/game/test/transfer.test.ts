/**
 * Own built Shafts are the only Surface↔Depths portals: troopers walk to one and step through it (down onto its
 * landing, up beside it). A Shaft whose landing has no open tunnel beside it is sealed until one reaches it. The
 * Spire root, holes of every kind and enemy Shafts are no portals; a new hole still drops the units standing on it.
 * Every scenario runs for both duel armies (point mirrors).
 */
import { describe, expect, it } from 'vitest';
import { CELL, STATS, toTicks, DEFAULT_RULES, spirePositions, type HoleKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { HOLE, VISION_EVERY } from '../src/sim/constants.ts';
import { cellOfEnt } from '../src/util/grid.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';
import { type Ent } from '../src/sim/ent.ts';

/** Spire centres under the default rules (every match here uses them). */
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);
const TEAMS = ['nw', 'se'] as const;
type Team = (typeof TEAMS)[number];

const id = (g: AgentCommandGame, team: Team, e: Ent): string => g.entityId(team, e.id);
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
/** The C2 mirror of a nw-side coordinate for `team`. */
const at = (team: Team, v: number, size: number): number => (team === 'nw' ? v : size - v);

/** Seed 3: a built Shaft of `team` at the mirror of (14.5, 14.5), whose landing (cell 14,14) opens in solid rock. */
function shaftInRock(team: Team): { g: AgentCommandGame; army: number; shaft: Ent; landing: number } {
  const g = createGame({ seed: 3 });
  const s = g.sim;
  const army = slotOfArmyId(team, 2);
  const shaft = s.build(army, 'shaft', at(team, 14.5, s.size), at(team, 14.5, s.size), 'surface');
  // Past the next vision pass: the Shaft's own Depths vision shows its new landing to the team.
  steps(g, STATS.shaft.build + 1 + VISION_EVERY);
  expect(shaft.built).toBe(true);
  const landing = cellOfEnt(shaft, s.size);
  expect(s.armies[army]!.group.known[landing]).toBe(CELL.tunnel);
  return { g, army, shaft, landing };
}

/** Dig the cell beside the landing on the map-centre side (x + 1 for nw, its mirror for se) and let the team know it. */
function connect(g: AgentCommandGame, team: Team, army: number, landing: number): void {
  const s = g.sim;
  const c = landing + (team === 'nw' ? 1 : -1);
  s.cells[c] = CELL.tunnel;
  s.armies[army]!.group.known[c] = CELL.tunnel;
}

describe.each(TEAMS)('own Shafts are the only portals (%s)', (team) => {
  it('a Shaft completed in rock is sealed until a tunnel reaches its landing; then troopers go down and climb up there', () => {
    const { g, army, shaft, landing } = shaftInRock(team);
    const s = g.sim;
    expect(s.cells[landing]).toBe(CELL.tunnel);
    expect(s.shaftSealed(army, shaft)).toBe(true);
    const sealedOut = g.observe({ team, role: 'surface' }, 0).entities.find((e) => e.id === id(g, team, shaft));
    expect(sealedOut?.sealed).toBe(true);
    const trooper = s.add('trooper', army, 'surface', at(team, 18, s.size), at(team, 18, s.size));
    expect(g.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g, team, trooper)], to: 'depths' })).toEqual({ ok: false, code: 'shaft_sealed' });
    expect(g.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g, team, trooper)], to: 'depths', x: shaft.x, y: shaft.y })).toEqual({ ok: false, code: 'shaft_sealed' });

    connect(g, team, army, landing);
    expect(s.shaftSealed(army, shaft)).toBe(false);
    expect(g.observe({ team, role: 'surface' }, 0).entities.find((e) => e.id === id(g, team, shaft))).not.toHaveProperty('sealed');
    expect(g.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g, team, trooper)], to: 'depths' })).toEqual({ ok: true });
    steps(g, toTicks(4));
    expect(trooper.plane).toBe('depths');
    // Arrivals below land on the Shaft's landing (cells in the team frame, so both mirrors agree).
    expect(cellOfEnt(trooper, s.size)).toBe(landing);
    expect(g.apply({ team, role: 'depths' }, { kind: 'transfer', units: [id(g, team, trooper)], to: 'surface' })).toEqual({ ok: true });
    steps(g, toTicks(4));
    expect(trooper.plane).toBe('surface');
  });

  it('the Spire root is no portal, on either plane', () => {
    const g = createGame({ seed: 3 });
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    const p = DEFAULT_SPIRES[team];
    const m = team === 'nw' ? 1 : -1;
    const up = s.add('trooper', army, 'surface', p.x + m * 3, p.y + m * 3);
    const down = s.add('trooper', army, 'depths', p.x, p.y + m * 2);
    expect(g.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g, team, up)], to: 'depths' })).toEqual({ ok: false, code: 'no_shaft' });
    expect(g.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g, team, up)], to: 'depths', x: p.x, y: p.y })).toEqual({ ok: false, code: 'no_shaft' });
    expect(g.apply({ team, role: 'depths' }, { kind: 'transfer', units: [id(g, team, down)], to: 'surface', x: p.x, y: p.y })).toEqual({ ok: false, code: 'no_shaft' });
    // Still none with a usable Shaft elsewhere: the point names the Spire.
    const { g: g2, army: a2, shaft, landing } = shaftInRock(team);
    connect(g2, team, a2, landing);
    const near = g2.sim.add('trooper', a2, 'surface', p.x + m * 3, p.y + m * 3);
    expect(g2.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g2, team, near)], to: 'depths', x: p.x, y: p.y })).toEqual({ ok: false, code: 'no_shaft' });
    expect(g2.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g2, team, near)], to: 'depths', x: shaft.x, y: shaft.y })).toEqual({ ok: true });
  });

  it('an enemy Shaft is no portal', () => {
    const g = createGame({ seed: 3 });
    const s = g.sim;
    const enemy: Team = team === 'nw' ? 'se' : 'nw';
    const theirs = s.build(slotOfArmyId(enemy, 2), 'shaft', at(team, 30.5, s.size), at(team, 30.5, s.size), 'surface');
    steps(g, STATS.shaft.build + 1);
    const below = cellOfEnt(theirs, s.size);
    for (const c of [below, below + 1, below - 1]) s.cells[c] = CELL.tunnel;
    const up = s.add('trooper', slotOfArmyId(team, 2), 'surface', at(team, 28, s.size), at(team, 28, s.size));
    expect(g.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g, team, up)], to: 'depths', x: theirs.x, y: theirs.y })).toEqual({ ok: false, code: 'no_shaft' });
  });

  it.each(['crater', 'sinkhole', 'chasm', 'breach'] as const)('a %s is no portal; opening it still drops the units on it, with fall damage', (kind: HoleKind) => {
    const g = createGame({ seed: 3 });
    const s = g.sim;
    const army = slotOfArmyId(team, 2);
    // Cell (20, 16) on the nw side: rock below, open ground above (its mirror for se).
    const x = at(team, 20.5, s.size), y = at(team, 16.5, s.size);
    const c = cellOfEnt({ cell: -1, frame: s.armyFrame[army]!, x, y }, s.size);
    expect(s.cells[c]).not.toBe(CELL.bedrock);
    const victim = s.add('trooper', army, 'surface', x, y);
    s.openCells([c], HOLE[kind], NEUTRAL);
    expect(victim.plane).toBe('depths');
    expect(victim.hp).toBe(victim.maxHp - Math.ceil(victim.maxHp * s.econ.fallDamage));
    // Neither way through it: up from below, nor down from beside it.
    expect(g.apply({ team, role: 'depths' }, { kind: 'transfer', units: [id(g, team, victim)], to: 'surface', x, y })).toEqual({ ok: false, code: 'no_shaft' });
    expect(g.apply({ team, role: 'depths' }, { kind: 'transfer', units: [id(g, team, victim)], to: 'surface' })).toEqual({ ok: false, code: 'no_shaft' });
    const beside = s.add('trooper', army, 'surface', x + (team === 'nw' ? 2 : -2), y);
    expect(g.apply({ team, role: 'surface' }, { kind: 'transfer', units: [id(g, team, beside)], to: 'depths', x, y })).toEqual({ ok: false, code: 'no_shaft' });
  });
});
