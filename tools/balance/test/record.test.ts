/** The recorder against a real sim: every death recorded once and mostly attributed, shared events not doubled. */
import { describe, expect, it } from 'vitest';
import { AgentCommandGame, CELL, NEUTRAL, createMetrics, measurementsFromMetrics, playBotMatch, Recorder, toTicks, type UnitKind } from '@agent-command/game';
import { layoutArmies } from '../src/spec.ts';

describe('recorder', () => {
  for (const layout of ['duel', 'ffa'] as const) {
    it(`records a veteran ${layout} faithfully`, () => {
      const armies = layoutArmies(layout);
      let rec: Recorder | undefined;
      const { game } = playBotMatch({
        seed: 7,
        levels: Object.fromEntries(armies.map((army) => [army, 'veteran'])),
        options: layout === 'ffa' ? { map: { params: { slots: 4 } } } : {},
        maxTicks: toTicks(4 * 60),
        onTick: (g) => (rec ??= new Recorder(g)).collect(),
      });
      const trace = rec!.trace();
      const count = (k: string): number => trace.events.filter((e) => e.k === k).length;
      const stats = armies.map((army) => game.sim.armies[game.sim.armyIndex(army)]!.stats);

      expect(trace.armies).toEqual(armies);
      expect(trace.samples.map((s) => s.minute)).toEqual([1, 3]);
      for (const army of armies) expect(trace.samples[0]!.units[army]!.depths).toBeGreaterThan(0);
      // every death exactly once
      expect(count('kill')).toBe(stats.reduce((a, s) => a + s.unitsLost + s.structuresLost, 0));
      // events sent to several armies are one event
      expect(count('impact')).toBe(stats.reduce((a, s) => a + s.impacts, 0));
      expect(count('produced')).toBe(stats.reduce((a, s) => a + s.produced, 0));
      expect(count('deliver')).toBeGreaterThan(0);
      expect(count('grapple')).toBeGreaterThan(0);
      for (const [index, army] of armies.entries()) {
        const lodes = trace.lodes!.sides[army]!;
        expect(lodes.lodeAlloy).toBe(stats[index]!.lodeAlloy);
        expect(lodes.headframesBuilt).toBe(stats[index]!.headframes);
        expect(lodes.earnedAlloy).toBeGreaterThan(0);
        expect(lodes.lodeAlloy).toBeLessThanOrEqual(lodes.earnedAlloy);
      }
      const kills = trace.events.filter((e) => e.k === 'kill');
      // Attribution includes hostile actions and named environmental causes, not just visible shots.
      expect(kills.filter((e) => e.by && e.by !== 'unknown').length / kills.length).toBeGreaterThan(0.9);
      expect(kills.filter((e) => e.by === 'unknown')).toHaveLength(0);
      for (const k of kills) if (k.killer) expect(k.killer).not.toBe(k.side);
    });
  }

  it('records final damage provenance rather than nearby effects', () => {
    const game = new AgentCommandGame(7);
    const rec = new Recorder(game);
    const metrics = createMetrics(game);
    for (const [cause, by] of [['storm', NEUTRAL], ['capture', NEUTRAL], ['flood', 1], ['impact', 1], ['beam', 1]] as const) {
      const victim = game.sim.add('trooper', 0, 'surface', 8, 8);
      game.sim.damage(victim, victim.hp, by, true, cause);
    }
    game.sim.fxAdd('collapse', 'surface', 8, 8, 0, true, { side: 0 });
    game.step();
    rec.collect();
    metrics.collect();
    const kills = rec.trace().events.filter((e) => e.k === 'kill');
    expect(kills.map((e) => [e.by, e.killer])).toEqual([
      ['storm', undefined], ['capture', undefined], ['flood', 'se'], ['impact', 'se'], ['beam', 'se'],
    ]);
    expect(measurementsFromMetrics(metrics.finish()).environmental).toEqual({ storm: 1, capture: 1 });
  });

  it('measures Spire HP lost per segment by plane of origin and cause, without overkill', () => {
    const game = new AgentCommandGame(7);
    const rec = new Recorder(game);
    const metrics = createMetrics(game);
    const [nw, se] = [game.sim.armies[0]!.spire, game.sim.armies[1]!.spire];
    game.sim.damage(se.surface, 300, 0, true, 'impact', 'orbit', 'asteroid');
    game.sim.damage(se.surface, 50, 0, false, 'tank', 'surface');
    game.sim.damage(se.surface, 70, 0, true, 'core_drop', 'orbit');
    game.sim.damage(nw.orbit, 20, NEUTRAL, false, 'storm');
    nw.depths.hp = 10;
    game.sim.damage(nw.depths, 400, 1, true, 'collapse', 'depths', 'sapper');
    const trace = rec.trace();
    expect(trace.spireDamage.se!.surface).toEqual({ from: { depths: 0, surface: 50, sky: 0, orbit: 370, none: 0 }, by: { impact: 300, tank: 50, core_drop: 70 } });
    expect(trace.spireDamage.nw!.orbit).toEqual({ from: { depths: 0, surface: 0, sky: 0, orbit: 0, none: 20 }, by: { storm: 20 } });
    expect(trace.spireDamage.nw!.depths).toEqual({ from: { depths: 10, surface: 0, sky: 0, orbit: 0, none: 0 }, by: { collapse: 10 } });
    expect(trace.spireDamage.se!.sky.by).toEqual({});
    expect(measurementsFromMetrics(metrics.finish()).spireDamage).toEqual(trace.spireDamage);
  });

  it('splits sapper outcomes: planted, defused, dud, hit, and undermine intents with chasm attempts', () => {
    const game = new AgentCommandGame(7);
    const { sim } = game;
    for (const e of sim.ents) if (e.unit) e.hp = 0;
    game.step();
    const rec = new Recorder(game);
    const metrics = createMetrics(game);
    const cell = (x: number, y: number): number => y * sim.size + x;
    const spire = sim.armies[1]!.spire.surface;
    // nw: one charge beside se's Spire footprint (a hit), one on open ground far from any structure (a dud).
    const hitAt = cell(Math.floor(spire.x) - 3, Math.floor(spire.y));
    let dudAt = cell(sim.size / 2, sim.size / 2);
    while (sim.faultOf[dudAt]! >= 0) dudAt++;
    sim.plantCharge(0, hitAt);
    sim.plantCharge(0, dudAt);
    // se: a charge beside a nw digger, which defuses it.
    const defuseAt = cell(10, sim.size - 10);
    sim.add('digger', 0, 'depths', (defuseAt % sim.size) + 0.5, Math.floor(defuseAt / sim.size) + 0.5);
    sim.plantCharge(1, defuseAt);
    const before = spire.hp;
    for (let t = 0; t <= sim.econ.undermineTicks; t++) {
      game.step();
      rec.collect();
    }
    expect(rec.trace().sappers.nw).toMatchObject({ planted: 2, hit: 1, dud: 1, defused: 0, damage: before - spire.hp });
    expect(rec.trace().sappers.se).toMatchObject({ planted: 1, defused: 1, hit: 0, dud: 0 });

    // Undermine intents: a fault cell the sapper stands on (accepted chasm attempt), a fault cell in rock (no tunnel),
    // and a sapper the seat does not own (rejected otherwise; se is handed a sighting of it so it can name it).
    const faults = [...sim.faultOf.keys()].filter((c) => sim.faultOf[c]! >= 0 && !sim.holes[c]);
    const rock = faults.find((c) => sim.cells[c] === CELL.rock)!;
    const open = faults.find((c) => c !== rock)!;
    sim.cells[open] = CELL.tunnel;
    sim.armies[0]!.group.known[open] = CELL.tunnel;
    const sapper = sim.add('sapper', 0, 'depths', (open % sim.size) + 0.5, Math.floor(open / sim.size) + 0.5);
    const id = game.entityId('nw', sapper.id);
    const at = (c: number) => ({ x: c % sim.size, y: Math.floor(c / sim.size) });
    expect(game.apply({ team: 'nw', role: 'depths' }, { kind: 'undermine', units: [id], ...at(open) }).ok).toBe(true);
    expect(game.apply({ team: 'nw', role: 'depths' }, { kind: 'undermine', units: [id], ...at(rock) })).toMatchObject({ ok: false, code: 'invalid_target' });
    sim.giveAlias(1, sapper.id);
    expect(game.apply({ team: 'se', role: 'depths' }, { kind: 'undermine', units: [game.entityId('se', sapper.id)], ...at(open) }).ok).toBe(false);
    expect(rec.trace().sappers.nw).toMatchObject({ ordered: 1, noTunnel: 1, rejected: 0, chasmOrdered: 1, chasmRejected: 1 });
    expect(rec.trace().sappers.se).toMatchObject({ ordered: 0, noTunnel: 0, rejected: 1, chasmRejected: 1 });
    expect(measurementsFromMetrics(metrics.finish()).sappers).toEqual(rec.trace().sappers);
  });

  it('credits every registry payload impact to its owner', () => {
    const game = new AgentCommandGame(7);
    const rec = new Recorder(game);
    for (const [kind, drop] of Object.entries(game.sim.payloads)) {
      const victim = game.sim.add('trooper', 1, 'surface', 24, 24);
      victim.hp = 1;
      const payload = game.sim.add(kind as UnitKind, NEUTRAL, drop.from, 24, 24);
      expect(game.sim.dropPayload(payload, 0, 24, 24)).toBe(true);
      payload.impactTick = game.tick + 1;
      game.step();
      rec.collect();
    }
    const kills = rec.trace().events.filter((e) => e.k === 'kill' && e.subject === 'trooper');
    expect(kills).toHaveLength(Object.keys(game.sim.payloads).length);
    for (const kill of kills) expect(kill).toMatchObject({ by: 'impact', killer: 'nw', side: 'se' });
  });
});
