import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { ECON, STATS, TICK_RATE, observationSchema, toTicks, type MatchOptions } from '../src/rules/contract.ts';
import { DEPLOY_NONE, DEPLOY_UP } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';

const BLUE = 0, RED = 1;

/** A two-army game with nothing in Orbit but what a test adds (the starting arrays and tugs go). */
function game(orbit: MatchOptions['orbit'] = {}): AgentCommandGame {
  const g = createGame({ seed: 7, options: { terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0, stationPdDamage: 0, derelictEnabled: false, ...orbit } } });
  for (const e of g.sim.ents) if (e.plane === 'orbit' && e.unit) e.hp = 0;
  g.step();
  return g;
}

/** An array of `army` at canonical (NW-frame) offset (dx, dy) from its own Orbit segment; mirrored for RED (C2). */
function array(g: AgentCommandGame, army: number, dx: number, dy: number): Ent {
  const seg = g.sim.armies[army]!.spire.orbit;
  const k = army === BLUE ? 1 : -1;
  return g.sim.add('solar', army, 'orbit', seg.x + k * dx, seg.y + k * dy);
}

const steps = (g: AgentCommandGame, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};

/** Stand still at day, every factor but the one under test at 1: the night, ramp, distance and shade tests below. */
const lit = (g: AgentCommandGame, e: Ent): boolean => g.sim.lit(e.x, e.y);

describe('solar arrays: anchored, ramped, local, shaded (C2 mirror)', () => {
  it('anchor where they stop, produce only anchored, pack to move, and fold with deploy off', () => {
    for (const army of [BLUE, RED]) {
      const g = game();
      const team = army === BLUE ? 'nw' : 'se';
      const a = array(g, army, 4, 4);
      g.step();
      expect(a.state).toBe('unfurling');
      expect(a.output).toBe(0);
      steps(g, ECON.solarDeployTicks);
      expect(a.state).toBe('unfurled');
      expect(a.deploy).toBe(DEPLOY_UP);
      expect(a.output).toBeGreaterThan(0);
      // A move packs it first (furling), then it flies and anchors again where it stops.
      const unit = g.entityId(team, a.id);
      expect(g.apply({ team, role: 'orbit' }, { kind: 'move', units: [unit], x: a.x + (army === BLUE ? 2 : -2), y: a.y })).toEqual({ ok: true });
      g.step();
      expect(a.state).toBe('furling');
      expect(a.output).toBe(0);
      expect(a.ramp).toBe(0);
      steps(g, ECON.solarPackTicks + toTicks(6) + ECON.solarDeployTicks);
      expect(a.state).toBe('unfurled');
      // Folded with deploy off it stays packed while idle; deploy on unfurls it again.
      expect(g.apply({ team, role: 'orbit' }, { kind: 'deploy', units: [unit], on: false })).toEqual({ ok: true });
      steps(g, ECON.solarPackTicks + toTicks(10));
      expect(a.deploy).toBe(DEPLOY_NONE);
      expect(a.output).toBe(0);
      expect(g.apply({ team, role: 'orbit' }, { kind: 'deploy', units: [unit], on: true })).toEqual({ ok: true });
      steps(g, ECON.solarDeployTicks + 1);
      expect(a.state).toBe('unfurled');
    }
  });

  it('ramps from solarRampStart to full over solarRampTime; a hit of at least solarRampHit halves its progress', () => {
    const outputs: number[][] = [];
    for (const army of [BLUE, RED]) {
      const g = game({ solarNight: 1 });
      const a = array(g, army, 4, 4);
      steps(g, ECON.solarDeployTicks + 1);
      const seen: number[] = [a.output];
      // Just anchored: the ramp's start share of the full rate.
      expect(a.output).toBeCloseTo(ECON.solarRate * (ECON.solarRampStart + (1 - ECON.solarRampStart) * a.ramp), 9);
      expect(a.ramp).toBeLessThan(0.01);
      steps(g, ECON.solarRampTime / 2);
      expect(a.ramp).toBeCloseTo(0.5, 1);
      seen.push(a.output);
      // A hit below the threshold leaves the ramp; one at it takes solarRampHitLoss of the progress.
      const before = a.ramp;
      g.sim.damage(a, ECON.solarRampHit - 1, army === BLUE ? RED : BLUE);
      expect(a.ramp).toBe(before);
      g.sim.damage(a, ECON.solarRampHit, army === BLUE ? RED : BLUE);
      expect(a.ramp).toBeCloseTo(before * (1 - ECON.solarRampHitLoss), 12);
      steps(g, ECON.solarRampTime);
      expect(a.ramp).toBe(1);
      expect(a.output).toBeCloseTo(ECON.solarRate, 9);
      seen.push(a.output);
      outputs.push(seen);
    }
    expect(outputs[0]).toEqual(outputs[1]);
  });

  it('earn solarNight in the dark, full within solarFullRange of the segment edge, falling to solarFarFactor at solarFarRange', () => {
    const results: number[][] = [];
    for (const army of [BLUE, RED]) {
      const g = game({ solarRampStart: 1 });
      // Footprint half-width 1.5: canonical x offsets give these distances from the segment's edge on its row.
      const near = array(g, army, 1.5 + ECON.solarFullRange - 1, 0);
      const mid = array(g, army, 1.5 + (ECON.solarFullRange + ECON.solarFarRange) / 2, 0);
      const far = array(g, army, 1.5 + ECON.solarFarRange + 2, 0);
      steps(g, ECON.solarDeployTicks + 1);
      const light = (e: Ent): number => (lit(g, e) ? 1 : ECON.solarNight);
      expect(near.output).toBeCloseTo(ECON.solarRate * light(near), 9);
      expect(mid.output).toBeCloseTo(ECON.solarRate * light(mid) * (1 + ECON.solarFarFactor) / 2, 9);
      expect(far.output).toBeCloseTo(ECON.solarRate * light(far) * ECON.solarFarFactor, 9);
      // Light alone: the same array by day and by night.
      const day: number[] = [];
      for (let t = 0; t < ECON.sunPeriodTicks; t += toTicks(5)) {
        g.step();
        day.push(near.output / ECON.solarRate);
        steps(g, toTicks(5) - 1);
      }
      expect(day.some((v) => Math.abs(v - 1) < 1e-9)).toBe(true);
      expect(day.some((v) => Math.abs(v - ECON.solarNight) < 1e-9)).toBe(true);
      results.push(day);
    }
    expect(results[0]).toEqual(results[1]);
  });

  it('shade: each other own array within solarShadeRadius costs solarShadePer, floored at solarShadeFloor; enemies do not shade', () => {
    for (const army of [BLUE, RED]) {
      const g = game({ solarRampStart: 1, solarNight: 1 });
      // All within solarFullRange of the segment's edge, each group more than solarShadeRadius from the others.
      const lone = array(g, army, 8, 0);
      const pair = [array(g, army, 0, 8), array(g, army, 0, 6)];
      const crowd = [0, 1, 2, 3, 4].map((i) => array(g, army, 5 + 0.8 * i, 5));
      // An enemy array beside the lone one shades nothing.
      g.sim.add('solar', army === BLUE ? RED : BLUE, 'orbit', lone.x + 1, lone.y);
      steps(g, ECON.solarDeployTicks + 1);
      expect(lone.output).toBeCloseTo(ECON.solarRate, 9);
      for (const a of pair) expect(a.output).toBeCloseTo(ECON.solarRate * (1 - ECON.solarShadePer), 9);
      for (const a of crowd) expect(a.output).toBeCloseTo(ECON.solarRate * Math.max(ECON.solarShadeFloor, 1 - ECON.solarShadePer * 4), 9);
      const team = army === BLUE ? 'nw' : 'se', foe = army === BLUE ? 'se' : 'nw';
      const obs = g.observe({ team, role: 'orbit' }, 0);
      expect(obs.entities.find((e) => e.id === g.entityId(team, lone.id))).toMatchObject({ ramp: expect.any(Number), output: ECON.solarRate });
      expect(validate(observationSchema, obs).ok).toBe(true);
      // The enemy sees the array and its ramp, never its output (it has a name for the array only once it saw it).
      const alias = g.sim.aliasOf(army === BLUE ? RED : BLUE, lone.id);
      const theirs = alias === 0 ? undefined : g.observe({ team: foe, role: 'orbit' }, 0).entities.find((e) => e.id === `e_${alias}`);
      if (theirs) expect(theirs.output).toBeUndefined();
    }
  });

  it('a capped day banks the whole surplus (rate 1, max 300); the bank fills the cap at night', () => {
    expect(ECON.baseEnergyCap).toBe(6);
    expect(ECON.solarBankRate).toBe(1);
    expect(ECON.solarBankMax).toBe(300);
    for (const army of [BLUE, RED]) {
      const g = game({ solarRampStart: 1, solarShadePer: 0 });
      const t = g.sim.armies[army]!;
      const arrays = [0, 1, 2, 3, 4].map((i) => array(g, army, 3 + i, 3));
      steps(g, ECON.solarDeployTicks + 1);
      // Wait for daylight on the field: five arrays make 10/s against a cap of 6, banking 4/s.
      while (!arrays.every((a) => lit(g, a))) g.step();
      g.step();
      const bank = t.energyBank;
      g.step();
      expect(t.solar).toBeCloseTo(5 * ECON.solarRate, 9);
      expect(t.delivered).toBeCloseTo(ECON.baseEnergyCap, 9);
      expect(t.energyBank - bank).toBeCloseTo((5 * ECON.solarRate - ECON.baseEnergyCap) * ECON.solarBankRate / TICK_RATE, 9);
      // At night the five make 4/s and the bank tops delivery back up to the cap.
      while (arrays.some((a) => lit(g, a))) g.step();
      g.step();
      expect(t.solar).toBeCloseTo(5 * ECON.solarRate * ECON.solarNight, 9);
      expect(t.delivered).toBeCloseTo(t.energyBank > 0 ? ECON.baseEnergyCap : t.solar, 9);
    }
  });
});

describe('array repair', () => {
  it('docking repairs every own Orbit unit at the segment, shieldless ones too (C2 mirror)', () => {
    for (const army of [BLUE, RED]) {
      const g = game();
      const seg = g.sim.armies[army]!.spire.orbit;
      const tug = g.sim.add('tug', army, 'orbit', seg.x + (army === BLUE ? 2 : -2), seg.y);
      tug.stance = 'hold';
      tug.hp = 50;
      g.step();
      expect(tug.maxShield).toBe(0);
      steps(g, TICK_RATE);
      expect(tug.hp).toBeCloseTo(50 + (ECON.orbitDockHull * (TICK_RATE + 1)) / TICK_RATE, 6);
    }
  });

  it('a packed array repairs arrayRepair HP/s after arrayRepairDelay out of combat; an anchored one does not (C2 mirror)', () => {
    const hulls: number[][] = [];
    for (const army of [BLUE, RED]) {
      const g = game();
      const team = army === BLUE ? 'nw' : 'se';
      const folded = array(g, army, 10, 10);
      const anchored = array(g, army, 2, 10);
      steps(g, ECON.solarDeployTicks + 1);
      for (const a of [folded, anchored]) g.sim.damage(a, 60, army === BLUE ? RED : BLUE);
      expect(g.apply({ team, role: 'orbit' }, { kind: 'deploy', units: [g.entityId(team, folded.id)], on: false })).toEqual({ ok: true });
      steps(g, ECON.arrayRepairDelay - 1);
      expect(folded.hp).toBe(STATS.solar.hp - 60);
      steps(g, toTicks(10) + 1);
      expect(folded.hp).toBeCloseTo(STATS.solar.hp - 60 + ECON.arrayRepair * 10, 0);
      expect(anchored.hp).toBe(STATS.solar.hp - 60);
      // 40 → 100 HP in 30 s of repair, after the 8 s delay.
      steps(g, toTicks(30));
      expect(folded.hp).toBe(STATS.solar.hp);
      hulls.push([folded.hp, anchored.hp]);
    }
    expect(hulls[0]).toEqual(hulls[1]);
  });
});
