import { describe, expect, it } from 'vitest';
import { validate, t } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { INTENTS, type MatchOptions } from '../src/rules/contract.ts';
import { DEPLOY_UP } from '../src/sim/constants.ts';
import type { Ent } from '../src/sim/ent.ts';
import { canonX, canonY, rotX, rotY } from '../src/util/teams.ts';

const intent = { kind: 'macro', action: 'spread_arrays' } as const;
function game(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 7, options: { ...options, terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0, stationPdDamage: 0, derelictEnabled: false, solarNight: 1, ...options.orbit } } });
  for (const e of g.sim.ents) if (e.unit && e.plane === 'orbit') e.hp = 0;
  g.step();
  return g;
}
function array(g: AgentCommandGame, army: number, dx: number, dy: number): Ent {
  const home = g.sim.armies[army]!.spire.orbit;
  const frame = g.sim.armyFrame[army]!;
  const x = canonX(frame, home.x, home.y, g.sim.size) + dx;
  const y = canonY(frame, home.x, home.y, g.sim.size) + dy;
  return g.sim.add('solar', army, 'orbit', rotX(frame, x, y, g.sim.size), rotY(frame, x, y, g.sim.size));
}
function spread(g: AgentCommandGame, army = 0): void {
  expect(g.apply({ team: g.sim.armyIds[army]!, role: 'orbit' }, intent)).toEqual({ ok: true });
}
function legal(g: AgentCommandGame, e: Ent): void {
  const p = e.order.k === 'move' ? e.order : e;
  const frame = g.sim.armyFrame[e.side]!;
  expect(g.sim.slotOpen(e.side, 'orbit', canonX(frame, p.x, p.y, g.sim.size), canonY(frame, p.x, p.y, g.sim.size), e.radius)).toBe(true);
  if (g.sim.derelict) expect(Math.hypot(p.x - g.sim.derelict.x, p.y - g.sim.derelict.y)).toBeGreaterThanOrEqual(g.sim.derelict.hullOuter + 2);
}

describe('spread_arrays macro', () => {
  it('accepts the canonical schema and improves a clump through actual movement and deployment', () => {
    expect(validate(t.obj(INTENTS.macro.params), { action: 'spread_arrays' }).ok).toBe(true);
    const g = game();
    const arrays = [0, 1, 2, 3, 4].map(i => array(g, 0, 5 + i * 0.75, 5));
    const home = g.sim.armies[0]!.spire.orbit;
    for (const e of arrays) { e.deploy = DEPLOY_UP; e.ramp = 1; }
    const before = arrays.reduce((sum, e) => sum + g.sim.solarOutput(e, home), 0);
    spread(g);
    const orders = arrays.map(e => e.order);
    for (const e of arrays) legal(g, e);
    spread(g);
    for (const [i, e] of arrays.entries()) expect(e.order).toBe(orders[i]);
    for (let i = 0; i < 1800; i++) g.step();
    const after = arrays.reduce((sum, e) => sum + e.output, 0);
    expect(after).toBeGreaterThan(before);
    for (const e of arrays) {
      expect(e.order.k).toBe('none');
      expect(e.deploy).toBe(DEPLOY_UP);
      expect(g.sim.solarShade(0, e.x, e.y, e.id)).toBe(1);
      expect(g.sim.solarDistance(e.x, e.y, home)).toBe(1);
      legal(g, e);
    }
    const settled = arrays.map(e => ({ order: e.order, ramp: e.ramp, x: e.x, y: e.y }));
    spread(g);
    for (const [i, e] of arrays.entries()) {
      expect(e.order).toBe(settled[i]!.order);
      expect(e.ramp).toBe(settled[i]!.ramp);
      expect([e.x, e.y]).toEqual([settled[i]!.x, settled[i]!.y]);
    }
    console.log(`spread_arrays actual sim: ${before.toFixed(6)} -> ${after.toFixed(6)} energy/s; five arrays, full ramp, solarNight=1`);
  });

  it('preserves a productive deployment, other owners, other planes and tow orders', () => {
    const g = game();
    const healthy = array(g, 0, 0, 8);
    healthy.deploy = DEPLOY_UP; healthy.ramp = 0.8;
    const crowd = [array(g, 0, 5, 5), array(g, 0, 6, 5)];
    const enemy = array(g, 1, 4, 4);
    const otherPlane = g.sim.add('solar', 0, 'sky', 16, 16);
    const tug = g.sim.add('tug', 0, 'orbit', 18, 12);
    const rock = g.sim.add('asteroid', 4, 'orbit', 19, 12);
    tug.link = rock.id; rock.link = tug.id;
    g.sim.order(tug, { k: 'move', x: 10, y: 10, fight: false, speed: 0 });
    const untouched = [healthy, enemy, otherPlane, tug];
    const orders = untouched.map(e => e.order);
    spread(g);
    for (const [i, e] of untouched.entries()) expect(e.order).toBe(orders[i]);
    expect(healthy.ramp).toBe(0.8);
    expect(healthy.deploy).toBe(DEPLOY_UP);
    expect(tug.link).toBe(rock.id);
    expect(rock.link).toBe(tug.id);
    expect(crowd.some(e => e.order.k === 'move')).toBe(true);
  });

  it('rotates legal goals exactly on a larger four-army map with a custom shade radius and ruin', () => {
    const g = game({ map: { seed: 7, params: { size: 64, slots: 4 } }, orbit: { solarShadeRadius: 6, derelictEnabled: true } });
    const plans: { x: number; y: number }[][] = [];
    for (const army of g.sim.allArmies) {
      const arrays = [array(g, army, 3, 3), array(g, army, 4, 3), array(g, army, 5, 3)];
      spread(g, army);
      const frame = g.sim.armyFrame[army]!;
      const goals = arrays.map(e => {
        legal(g, e);
        const p = e.order.k === 'move' ? e.order : e;
        return { x: canonX(frame, p.x, p.y, g.sim.size), y: canonY(frame, p.x, p.y, g.sim.size) };
      });
      for (const [i, a] of goals.entries()) for (const b of goals.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(6);
      const orders = arrays.map(e => e.order);
      spread(g, army);
      for (const [i, e] of arrays.entries()) expect(e.order).toBe(orders[i]);
      plans.push(goals);
    }
    for (const plan of plans.slice(1)) expect(plan).toEqual(plans[0]);
  });

  it('keeps an overfull field deterministic without illegal fallback goals', () => {
    const options = { map: { seed: 7, params: { size: 48 } }, orbit: { solarShadeRadius: 16, derelictEnabled: true } };
    const plans: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      const g = game(options);
      const arrays = Array.from({ length: 30 }, (_, i) => array(g, 0, 4 + i % 5, 4 + Math.floor(i / 5)));
      spread(g);
      expect(arrays.some(e => e.order.k === 'none')).toBe(true);
      for (const e of arrays) if (e.order.k === 'move') legal(g, e);
      plans.push(arrays.map(e => e.order));
      const orders = arrays.map(e => e.order);
      spread(g);
      for (const [i, e] of arrays.entries()) expect(e.order).toBe(orders[i]);
    }
    expect(plans[1]).toEqual(plans[0]);
  });

  it('avoids known occupied berths without reading unseen enemy positions', () => {
    const baseline = game();
    const initial = [array(baseline, 0, 5, 5), array(baseline, 0, 6, 5)];
    spread(baseline);
    const target = initial.find(e => e.order.k === 'move')!.order;
    if (target.k !== 'move') throw new Error('expected an improving berth');
    const g = game();
    const arrays = [array(g, 0, 5, 5), array(g, 0, 6, 5)];
    const blocker = g.sim.add('skiff', 0, 'orbit', target.x, target.y);
    g.sim.order(blocker, { k: 'attack', target: g.sim.armies[1]!.spire.orbit.id });
    const order = blocker.order;
    spread(g);
    expect(blocker.order).toBe(order);
    for (const e of arrays) if (e.order.k === 'move') {
      expect(Math.hypot(e.order.x - blocker.x, e.order.y - blocker.y)).toBeGreaterThanOrEqual(e.radius + blocker.radius + g.sim.econ.slotGap);
    }
    const hidden = game();
    const twins = [array(hidden, 0, 5, 5), array(hidden, 0, 6, 5)];
    const foe = array(hidden, 1, 4, 4);
    expect(hidden.sim.sees(0, foe)).toBe(false);
    // Even a hidden ship's move reservation at our berth is private.
    hidden.sim.order(foe, { k: 'move', x: target.x, y: target.y, fight: false, speed: 0 });
    spread(hidden);
    expect(twins.map(e => e.order)).toEqual(initial.map(e => e.order));
  });

  it('handles empty, wrong-plane and unavailable home without changing orders', () => {
    const g = game();
    spread(g);
    expect(g.apply({ team: 'nw', role: 'surface' }, intent)).toEqual({ ok: false, code: 'wrong_plane' });
    const e = array(g, 0, 4, 4);
    const order = e.order;
    g.sim.armies[0]!.spire.orbit.hp = 0;
    expect(g.apply({ team: 'nw', role: 'orbit' }, intent)).toEqual({ ok: false, code: 'invalid_target' });
    expect(e.order).toBe(order);
  });
});
