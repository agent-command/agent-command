/** Per-plane alerts: selection and priority per plane, and fog (they never show what the team's own data hides). */
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { CELL, DEFAULT_RULES, ECON, observationSchema, viewSchema, type NaturalStorm, type Observation, type Plane, type ArmyId, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { planeAlerts, type AlertSource } from '../src/agent/alerts.ts';
import { PLANE_INDEX, VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { armyBit, rotCell, rotX, rotY, slotOfArmyId } from '../src/util/teams.ts';

/** Cell index on the default-size maps every fixture here uses. */
const MAP = DEFAULT_RULES.map.size;
const cell = (x: number, y: number): number => y * MAP + x;
const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
const storm = (stage: NaturalStorm['stage'], start: number, x = 20, y = 20): NaturalStorm => ({
  id: start, x, y, radius: 3, maxRadius: 6, strength: 0.5, stage, originX: x, originY: y, dx: 0, dy: 0, turns: 0,
  start, grown: start + 100, breaking: start + 300, end: start + 400,
});
const source = (extra: Partial<AlertSource> = {}): AlertSource => ({
  army: 'nw', spire: [], schedule: [], weather: { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [] }, impacts: [], charges: [], cracks: [], tremors: [], entities: [], ...extra,
});
const of = (alerts: Observation['alerts'], plane: Plane) => alerts.filter((a) => a.plane === plane);

describe('plane alert selection', () => {
  it('groups planes in PLANES order and keeps at most three per plane', () => {
    const alerts = planeAlerts(source({
      schedule: [{ kind: 'asteroid_spawn', tick: 900 }],
      impacts: [400, 100, 300, 200].map((tick, i) => ({ x: 10 + i, y: 12, tick, side: 'se' as const, id: `e_${i}` })),
      weather: { storms: [], forecast: [storm('forecast', 500)], fog: [], seedWarnings: [], seeded: [] },
      tremors: [{ x: 3, y: 4 }],
    }));
    expect(alerts.map((a) => a.plane)).toEqual(['depths', 'surface', 'surface', 'surface', 'sky', 'orbit']);
    expect(of(alerts, 'surface').map((a) => a.tick)).toEqual([100, 200, 300]);
    expect(of(alerts, 'surface')[0]).toEqual({ plane: 'surface', kind: 'drop', tick: 100, x: 11, y: 12, side: 'se' });
    expect(of(alerts, 'orbit')).toEqual([{ plane: 'orbit', kind: 'rocks', tick: 900 }]);
  });

  it('follows the next storm from the forecast through its life stages', () => {
    const at = (storms: NaturalStorm[], forecast: NaturalStorm[]) => planeAlerts(source({ weather: { storms, forecast, fog: [], seedWarnings: [], seeded: [] } }));
    expect(at([], [storm('forecast', 500, 30, 14)])).toEqual([{ plane: 'sky', kind: 'storm_forming', tick: 500, x: 30, y: 14 }]);
    // A live storm formed before any forecast one, so it leads; its stage ends at the next stage's start.
    const live = at([storm('mature', 100)], [storm('forecast', 500)]);
    expect(live.map((a) => [a.kind, a.tick])).toEqual([['storm_peak', 400], ['storm_forming', 500]]);
    expect(at([storm('forming', 100)], [])[0]).toMatchObject({ kind: 'storm_growing', tick: 200 });
    expect(at([storm('breaking', 100)], [])[0]).toMatchObject({ kind: 'storm_breaking', tick: 500 });
  });

  it('puts depths threats first: wall digs, enemy charges, breaches, tremors, then magma', () => {
    const full = source({
      schedule: [{ kind: 'magma_cools', tick: 50, x: 9.5, y: 9.5 }],
      tremors: [{ x: 1, y: 1 }, { x: 2, y: 2, breach: true }, { x: 3, y: 3 }],
      charges: [{ x: 7, y: 7, tick: 300, side: 'se' }, { x: 8, y: 8, tick: 200, side: 'nw' }, { x: 6, y: 6, tick: 250, side: 'se' }],
      cracks: [{ x: 4, y: 4, stage: 2, enemy: true }, { x: 5, y: 5, stage: 4 }, { x: 5, y: 6, stage: 3, enemy: true }],
    });
    expect(of(planeAlerts(full), 'depths')).toEqual([
      { plane: 'depths', kind: 'wall_dig', x: 5.5, y: 6.5, stage: 3 },
      { plane: 'depths', kind: 'wall_dig', x: 4.5, y: 4.5, stage: 2 },
      { plane: 'depths', kind: 'charge', tick: 250, x: 6.5, y: 6.5 },
    ]);
    // Our own charge and our own cracks are never threats.
    const calmer = { ...full, cracks: [{ x: 5, y: 5, stage: 4 }], charges: full.charges.filter((c) => c.side === 'nw') };
    expect(of(planeAlerts(calmer), 'depths').map((a) => a.kind)).toEqual(['breach', 'tremor', 'magma']);
    expect(of(planeAlerts(calmer), 'depths')[1]).toEqual({ plane: 'depths', kind: 'tremor', x: 1.5, y: 1.5, count: 2 });
    expect(of(planeAlerts({ ...calmer, tremors: [] }), 'depths')).toEqual([{ plane: 'depths', kind: 'magma', tick: 50, x: 9.5, y: 9.5 }]);
    // Quiet: nothing pending, nothing listed.
    expect(of(planeAlerts(source()), 'depths')).toEqual([]);
  });

  it('leads the depths alerts with the Mother Lode fuse (its vent tick) when we can point at it; never without a known lode cell or a fuse', () => {
    const lode = { pressure: 90, rate: 2, state: 'critical', ventAt: 500, x: 24, y: 24 } as const;
    const busy = { cracks: [{ x: 4, y: 4, stage: 2, enemy: true }], charges: [{ x: 7, y: 7, tick: 300, side: 'se' as const }] };
    expect(of(planeAlerts(source({ ...busy, motherLode: lode })), 'depths').map((a) => a.kind)).toEqual(['lode_critical', 'wall_dig', 'charge']);
    expect(of(planeAlerts(source({ motherLode: lode })), 'depths')).toEqual([{ plane: 'depths', kind: 'lode_critical', tick: 500, x: 24, y: 24 }]);
    expect(of(planeAlerts(source({ motherLode: { pressure: 90, rate: 2, state: 'critical', ventAt: 500 } })), 'depths')).toEqual([]);
    expect(of(planeAlerts(source({ motherLode: { pressure: 70, rate: 2, state: 'warn', x: 24, y: 24 } })), 'depths')).toEqual([]);
  });
});

/** Spires and islands only, no magma; tests carve their own tunnels. */
function arena(seed: number): AgentCommandGame {
  const g = createGame({ seed, options: { terrain: 'open', map: { params: { homeLodes: 0, contestedZones: [] } } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.hp = 0;
  g.sim.magma.fill(0);
  steps(g, VISION_EVERY);
  return g;
}
function put(g: AgentCommandGame, team: ArmyId, kind: UnitKind, c: number): Ent {
  const e = g.sim.spawnUnit(slotOfArmyId(team, 2), kind, 'depths');
  e.x = (c % g.sim.size) + 0.5;
  e.y = Math.floor(c / g.sim.size) + 0.5;
  e.cell = c;
  return e;
}
/** Tunnel cells dug (owned) by `team`, walled in by rock and known to it. */
function tunnel(g: AgentCommandGame, team: ArmyId, cells: number[]): void {
  const s = g.sim;
  for (const c of cells) {
    s.cells[c] = CELL.tunnel;
    s.owner[c] = armyBit(slotOfArmyId(team, 2));
    s.armies[slotOfArmyId(team, 2)]!.group.known[c] = CELL.tunnel;
  }
}
const depthsAlerts = (g: AgentCommandGame, team: ArmyId) => {
  const obs = g.observe({ team, role: 'surface' }, 0);
  // The adapter's view: what the client receives, with the team's signal board the wire schema requires.
  const v = g.view(team);
  expect(validate(observationSchema, obs).ok).toBe(true);
  expect(validate(viewSchema, v).ok).toBe(true);
  // Agents and the client see the same alerts.
  expect(v.alerts).toEqual(obs.alerts);
  return of(obs.alerts, 'depths');
};

describe('plane alerts are fog-safe', () => {
  it('show enemy digging into our wall only once our team sees the crack, never our own digging', () => {
    const g = arena(9);
    const s = g.sim;
    const wall = cell(19, 20);
    tunnel(g, 'nw', [12, 13, 14, 15, 16, 17, 18].map((x) => cell(x, 20)));
    tunnel(g, 'se', [20, 21, 22].map((x) => cell(x, 20)));
    for (const c of [wall, cell(11, 20)]) s.cells[c] = CELL.rock;
    const digger = put(g, 'se', 'digger', cell(20, 20));
    expect(g.apply({ team: 'se', role: 'depths' }, { kind: 'dig', units: [g.entityId('se', digger.id)], x: 19, y: 20 })).toEqual({ ok: true });
    steps(g, ECON.digRock / 2);
    // Unseen: Blue has no Depths vision on the wall, so no crack and no alert.
    expect(s.work[wall]).toBeGreaterThan(0);
    expect(depthsAlerts(g, 'nw')).toEqual([]);
    // Red sees its own work but it is not a threat to Red.
    expect(depthsAlerts(g, 'se')).toEqual([]);
    // A Blue digger beside the wall sees the crack: enemy digging in.
    const guard = put(g, 'nw', 'digger', cell(17, 20));
    steps(g, VISION_EVERY);
    const [dig] = depthsAlerts(g, 'nw');
    expect(dig).toMatchObject({ plane: 'depths', kind: 'wall_dig', x: 19.5, y: 20.5 });
    expect(dig!.stage).toBeGreaterThanOrEqual(2);
    // Red gives up and Blue sees the wall repaired; then Blue cracks its own wall, without an alert.
    g.apply({ team: 'se', role: 'depths' }, { kind: 'stop', units: [g.entityId('se', digger.id)] });
    digger.hp = 0;
    s.work[wall] = 0;
    s.digBy[wall] = 0;
    steps(g, VISION_EVERY);
    expect(depthsAlerts(g, 'nw')).toEqual([]);
    guard.x = 12.5;
    guard.cell = cell(12, 20);
    steps(g, VISION_EVERY);
    expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'dig', units: [g.entityId('nw', guard.id)], x: 11, y: 20 })).toEqual({ ok: true });
    steps(g, ECON.digRock / 2 + VISION_EVERY);
    expect(g.observe({ team: 'nw', role: 'depths' }, 0).cracks).toContainEqual({ x: 11, y: 20, stage: expect.any(Number) });
    expect(depthsAlerts(g, 'nw')).toEqual([]);
  });

  it('never hint at a hidden sapper on its way to undermine, nor at its fogged charge before the public window', () => {
    const g = arena(6);
    const s = g.sim;
    const route = [30, 31, 32, 33, 34, 35, 36].map((x) => cell(x, 30));
    tunnel(g, 'se', route);
    const sapper = put(g, 'se', 'sapper', route[0]!);
    expect(g.apply({ team: 'se', role: 'depths' }, { kind: 'undermine', units: [g.entityId('se', sapper.id)], x: 36, y: 30 })).toEqual({ ok: true });
    steps(g, 2);
    expect(s.charges).toHaveLength(0);
    expect(s.vis[0]![sapper.cell]! & s.armies[0]!.group.bit).toBe(0);
    expect(depthsAlerts(g, 'nw')).toEqual([]);
    for (let t = 0; t < 400 && s.charges.length === 0; t++) g.step();
    expect(s.charges).toHaveLength(1);
    // Fogged: nothing for Blue until the charge's public last seconds, then the alert with its blast tick.
    expect(depthsAlerts(g, 'nw')).toEqual([]);
    steps(g, s.charges[0]!.at - ECON.chargePublicTicks + 1 - g.tick);
    expect(depthsAlerts(g, 'nw')).toEqual([{ plane: 'depths', kind: 'charge', tick: s.charges[0]!.at, x: 36.5, y: 30.5 }]);
    // The planting team's own charge is not an alert for it.
    expect(depthsAlerts(g, 'se')).toEqual([]);
  });

  it('raise surface charge_under only for a hostile charge the team knows of within collapse reach of its Surface units (twin worlds: an unknown charge raises nothing); mirrored', () => {
    const out = (['nw', 'se'] as const).map((team) => {
      const foe = team === 'nw' ? 'se' : 'nw';
      const k = team === 'nw' ? 0 : 2;
      const worlds = [false, true].map((charged) => {
        const g = arena(6);
        const s = g.sim;
        const c = rotCell(k, cell(30, 30), MAP);
        s.cells[c] = CELL.tunnel;
        const reach = s.econ.collapseRadius + s.econ.collapseStructureReach;
        // One trooper inside the collapse reach whose feel stamp (rules.depths.tremorRadius: every cell its circle
        // overlaps) misses the charge cell, so it never feels the charge below; one just outside the reach.
        const d = 1.75;
        expect(Math.hypot(d, d)).toBeLessThanOrEqual(reach);
        for (const [dx, dy] of [[d, d], [reach + 0.25, 0]] as const) {
          const u = s.spawnUnit(slotOfArmyId(team, 2), 'trooper', 'surface');
          u.x = rotX(k, 30.5 + dx, 30.5 + dy, MAP);
          u.y = rotY(k, 30.5 + dx, 30.5 + dy, MAP);
        }
        // No sapper stands below to be felt as a tremor: only the charge's own fog decides.
        if (charged) s.plantCharge(slotOfArmyId(foe, 2), c);
        steps(g, VISION_EVERY);
        // The team neither sees nor feels the charge cell: only the public window may tell it.
        const bit = s.armies[slotOfArmyId(team, 2)]!.group.bit;
        expect(s.feel[c]! & bit).toBe(0);
        expect(s.vis[PLANE_INDEX.depths]![c]! & bit).toBe(0);
        return g;
      });
      const surface = (g: AgentCommandGame, who: ArmyId) => of(g.observe({ team: who, role: 'surface' }, 0).alerts, 'surface');
      const hidden = worlds.map((g) => surface(g, team));
      const [, g] = worlds;
      const s = g!.sim;
      const at = s.charges[0]!.at;
      steps(g!, at - ECON.chargePublicTicks + 1 - g!.tick);
      const v = g!.view(team);
      return { hidden, known: surface(g!, team), view: of(v.alerts, 'surface'), planter: surface(g!, foe), at };
    });
    for (const o of out) {
      // Fogged: the charged world shows exactly what the uncharged twin shows.
      expect(o.hidden[1]).toEqual(o.hidden[0]);
      expect(o.hidden[0]!.some((a) => a.kind === 'charge_under')).toBe(false);
      expect(o.planter.some((a) => a.kind === 'charge_under')).toBe(false);
      expect(o.view).toEqual(o.known);
    }
    expect(out[0]!.known).toEqual([{ plane: 'surface', kind: 'charge_under', tick: out[0]!.at, x: 30.5, y: 30.5, count: 1 }]);
    expect(out[1]!.known).toEqual([{ plane: 'surface', kind: 'charge_under', tick: out[1]!.at, x: MAP - 30.5, y: MAP - 30.5, count: 1 }]);
  });

  it('raise charge_under for each of four rotated armies alike (C4)', () => {
    const g = createGame({ seed: 5, options: { map: { name: 'four_corners' }, spire: { dmg: 0 }, orbit: { maxAsteroids: 0 } } });
    const s = g.sim;
    for (const e of s.ents) if (e.kind !== 'spire' && e.kind !== 'island' && e.kind !== 'post') e.hp = 0;
    const size = s.size;
    const x = 14, y = 14;
    for (const a of s.allArmies) {
      const k = s.armyFrame[a]!;
      const c = rotCell(k, y * size + x, size);
      s.cells[c] = CELL.tunnel;
      const u = s.spawnUnit(a, 'trooper', 'surface');
      u.x = rotX(k, x + 0.5, y + 1.5, size);
      u.y = rotY(k, x + 0.5, y + 1.5, size);
      s.plantCharge(s.allArmies[(a + 1) % s.allArmies.length]!, c);
    }
    for (const ch of s.charges) ch.at = s.tick + ECON.chargePublicTicks;
    steps(g, VISION_EVERY);
    const seen = s.allArmies.map((a) => {
      const k = s.armyFrame[a]!;
      const found = of(g.observe({ team: s.sideId(a) as ArmyId, role: 'surface' }, 0).alerts, 'surface').filter((al) => al.kind === 'charge_under');
      return found.map((al) => ({ ...al, x: rotX((4 - k) % 4, al.x!, al.y!, size), y: rotY((4 - k) % 4, al.x!, al.y!, size) }));
    });
    expect(seen[0]).toEqual([{ plane: 'surface', kind: 'charge_under', tick: s.charges[0]!.at, x: x + 0.5, y: y + 0.5, count: 1 }]);
    for (let a = 1; a < 4; a++) expect(seen[a], `army ${a}`).toEqual(seen[0]);
  });
});
