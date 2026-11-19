import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { STARTER_POLICIES } from './starter-policies.ts';
import { createBot } from '../src/bots/bots.ts';
import {
  checkRules, compileRules, derelictGeometry, derelictPeriod, ECON, gatesOpen, MAP_SIZES, observationSchema, passWidth, resolveRules, ringTurning, SPIRE_CORNER, SPIRE_INSET_MAX,
  SPIRE_INSET_MIN, sunLit, TICK_RATE, toTicks, WALL_CLEAR, wallBlocks, wallHit, widestOrbitShip, type MatchData, type MatchOptions, type Observation,
} from '../src/rules/contract.ts';
import { type Ent } from '../src/sim/ent.ts';
import { canonX, canonY, rotX, rotY } from '../src/util/teams.ts';
import { route } from '../src/planes/derelict.ts';

const BLUE = 0, RED = 1;
const steps = (g: AgentCommandGame, n: number): void => { for (let i = 0; i < n; i++) g.step(); };
const quiet = (orbit: MatchOptions['orbit'] = {}): MatchOptions => ({ terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0, stationPdDamage: 0, ...orbit } });
const game = (orbit: MatchOptions['orbit'] = {}) => createGame({ seed: 7, options: quiet(orbit) });
const core = (g: AgentCommandGame): Ent => g.sim.derelictCore()!;

describe('derelict ruin', () => {
  it('validates its geometry rules and can be switched off', () => {
    expect(checkRules({ orbit: { derelictRingOuter: 6.9 } }).ok).toBe(false);
    expect(checkRules({ orbit: { derelictHullInner: 8 } }).ok).toBe(false);
    expect(checkRules({ orbit: { derelictBreaches: 6 } }).ok).toBe(false);
    expect(checkRules({ orbit: { derelictGateWidth: 6.5 } }).ok).toBe(false);
    expect(checkRules({ orbit: { coreCollectRadius: 1.2 } }).ok).toBe(false);
    const off = createGame({ seed: 7, options: { orbit: { derelictEnabled: false } } });
    expect(off.sim.derelict).toBeNull();
    expect(off.sim.ents.some((e) => e.kind === 'core')).toBe(false);
    expect(off.matchData({ team: 'nw', role: 'orbit' }).derelict).toBeUndefined();
  });

  it('walls and gates are invariant under every quarter turn at every phase', () => {
    const g = game().sim.derelict!;
    for (let tick = 0; tick < derelictPeriod(g); tick += 7) {
      const open = gatesOpen(g, tick);
      for (let i = 0; i < 400; i++) {
        // Points across the whole ruin, out past the hull.
        const span = 2 * (g.hullOuter + 1);
        const x = (((i * 37) % 97) / 97 - 0.5) * span, y = (((i * 53) % 89) / 89 - 0.5) * span;
        const hit = wallHit(g, open, x, y, 0.5);
        expect(wallHit(g, open, -y, x, 0.5)).toBe(hit);
        expect(wallHit(g, open, -x, -y, 0.5)).toBe(hit);
        expect(wallBlocks(g, open, x, y, -x * 0.3, y * 0.9)).toBe(wallBlocks(g, open, -y, x, -y * 0.9, -x * 0.3));
      }
    }
    expect(gatesOpen(g, 0)).toBe(true);
    expect(ringTurning(g, g.open)).toBe(true);
    expect(gatesOpen(g, g.open + g.turn)).toBe(false);
  });

  it('ships route in through an open gate, hold at a sealed one, and the turning ring pushes without damage', () => {
    const g = game({ derelictRadiation: 0 });
    const s = g.sim;
    const ship = s.add('bastion', BLUE, 'orbit', 24 - s.derelict!.hullOuter - 0.5, 24);
    ship.stance = 'hold';
    s.order(ship, { k: 'move', x: 24, y: 24, fight: false, speed: 0 });
    steps(g, toTicks(10));
    expect(Math.hypot(ship.x - 24, ship.y - 24)).toBeLessThan(s.derelict!.ringInner);
    // Sealed: a ship outside waits at the gate mouth until the next window.
    s.tick = s.derelict!.open + s.derelict!.turn;
    const late = s.add('skiff', BLUE, 'orbit', 24, 24 - s.derelict!.hullOuter - 0.5);
    s.order(late, { k: 'move', x: 24, y: 24, fight: false, speed: 0 });
    steps(g, toTicks(15));
    expect(Math.hypot(late.x - 24, late.y - 24)).toBeGreaterThan(s.derelict!.ringOuter);
    expect(late.order.k).toBe('move');
    // Push: a ship standing in a gate when the ring turns ends up off the ring, unharmed.
    const s2 = game({ derelictRadiation: 0 }).sim;
    const stuck = s2.add('lancer', BLUE, 'orbit', 24 + (s2.derelict!.ringInner + s2.derelict!.ringOuter) / 2, 24);
    const hp = stuck.hp;
    s2.tick = s2.derelict!.open;
    s2.step();
    const r = Math.hypot(stuck.x - 24, stuck.y - 24);
    expect(r < s2.derelict!.ringInner - stuck.radius + 1e-6 || r > s2.derelict!.ringOuter + stuck.radius - 1e-6).toBe(true);
    expect(stuck.hp).toBe(hp);
  });

  it('irradiates the chamber through shields, hides it from outside sight, and blocks Orbit fire through ring and hull', () => {
    const g = game();
    const s = g.sim;
    const d = s.derelict!;
    // On the diagonal (between breaches and, open or sealed, off the gates): just inside the ring, in the corridor
    // within sight of it, and out past the hull.
    const at = (r: number): number => 24 - r * Math.SQRT1_2;
    const inside = s.add('lancer', RED, 'orbit', at(d.ringInner - 1), at(d.ringInner - 1));
    inside.stance = 'hold';
    const shield = inside.shield;
    steps(g, 20);
    expect(inside.shield).toBeLessThan(shield);
    expect(inside.hp).toBe(inside.maxHp);
    const watcher = s.add('lancer', BLUE, 'orbit', at((d.ringOuter + d.hullInner) / 2), at((d.ringOuter + d.hullInner) / 2));
    watcher.stance = 'hold';
    const outsider = s.add('lancer', RED, 'orbit', at(d.hullOuter + 1), at(d.hullOuter + 1));
    outsider.stance = 'hold';
    steps(g, 10);
    expect(Math.hypot(watcher.x - inside.x, watcher.y - inside.y)).toBeLessThan(s.stats.lancer.vision);
    expect(g.view('nw').entities.some((e) => e.id === `e_${s.aliasOf(BLUE, inside.id)}`)).toBe(false);
    s.scan(BLUE, 24, 24);
    expect(g.view('nw').entities.find((e) => e.id === g.entityId('nw', core(g).id))?.heat).toBe(0);
    expect(s.lineOfFire(watcher, inside)).toBe(false);
    expect(s.lineOfFire(watcher, outsider)).toBe(false);
  });

  it('pays nothing while held, cashes in once at the towing army\'s own segment and regrows (C2 mirror)', () => {
    for (const [army, team, other] of [[BLUE, 'nw', 'se'], [RED, 'se', 'nw']] as const) {
      const g = game({ derelictRadiation: 0 });
      const s = g.sim;
      const c = core(g);
      const t = s.armies[army]!;
      const seg = t.spire.orbit;
      // Towed out past the hull: no income from holding it.
      const tug = s.add('tug', army, 'orbit', 24, 24 + (army === BLUE ? -1 : 1) * (s.derelict!.hullOuter + 2));
      tug.link = c.id; c.link = tug.id; c.state = 'towed';
      const held = { alloy: t.alloy, energy: t.energy };
      g.step();
      expect(t.stats.coreCashed).toBe(0);
      expect(t.energy - held.energy).toBeLessThan(1);
      // Home at its own segment (within dockRadius): cashed in once, spent, regrowing.
      tug.x = seg.x + (army === BLUE ? 2 : -2); tug.y = seg.y;
      const before = { alloy: t.alloy, energy: t.energy };
      g.step();
      expect(t.stats.coreCashed).toBe(1);
      expect(t.alloy - before.alloy).toBeGreaterThanOrEqual(ECON.coreRewardAlloy);
      expect(t.alloy - before.alloy).toBeLessThan(ECON.coreRewardAlloy + 1);
      expect(t.energy - before.energy).toBeGreaterThanOrEqual(ECON.coreRewardEnergy);
      expect(t.energy - before.energy).toBeLessThan(ECON.coreRewardEnergy + 1);
      expect(s.derelictCore()).toBeUndefined();
      expect(tug.link).toBe(0);
      const regrows = s.coreRegrowAt;
      expect(regrows - s.tick).toBeGreaterThanOrEqual(ECON.coreRegrowTime - 1);
      expect(regrows - s.tick).toBeLessThanOrEqual(ECON.coreRegrowTime);
      for (const seat of [team, other] as const) {
        const obs = g.observe({ team: seat, role: 'orbit' }, 0);
        expect(obs.events.filter((e) => e.kind === 'core_cashed')).toMatchObject([{ side: team }]);
        expect(obs.schedule.find((e) => e.kind === 'core_regrows')?.tick).toBe(regrows);
        expect(validate(observationSchema, obs).ok).toBe(true);
      }
      while (!s.derelictCore()) g.step();
      expect(s.tick - regrows).toBeLessThanOrEqual(1);
      expect(core(g).state).toBe('idle');
      expect(s.armies[1 - army]!.stats.coreCashed).toBe(0);
    }
  });

  it('alerts and logs radiation only to the army whose ships burn in the chamber (C2 mirror)', () => {
    for (const [army, team, other] of [[BLUE, 'nw', 'se'], [RED, 'se', 'nw']] as const) {
      const g = game();
      const s = g.sim;
      const at = army === BLUE ? 23.5 : 24.5;
      s.add('lancer', army, 'orbit', at, at);
      // Another army's ship just outside the hull sees nothing of it.
      s.add('skiff', 1 - army, 'orbit', 48 - at, 48 - at - s.derelict!.hullOuter - 2);
      g.step();
      const mine = g.observe({ team, role: 'orbit' }, 0);
      const theirs = g.observe({ team: other, role: 'orbit' }, 0);
      expect(mine.alerts.find((a) => a.kind === 'radiation')).toMatchObject({ plane: 'orbit', x: 24, y: 24, count: 1 });
      expect(mine.events.some((e) => e.kind === 'irradiated')).toBe(true);
      expect(theirs.alerts.some((a) => a.kind === 'radiation')).toBe(false);
      expect(theirs.events.some((e) => e.kind === 'irradiated')).toBe(false);
      expect(validate(observationSchema, mine).ok).toBe(true);
      // Throttled: one event per alarm interval while it keeps burning.
      for (let i = 0; i < 20; i++) g.step();
      expect(g.observe({ team, role: 'orbit' }, 0).events.filter((e) => e.kind === 'irradiated').length).toBe(1);
    }
  });

  it('heats on its own clock past the hull, whatever arrays stand by it, slower on larger maps (C2 mirror)', () => {
    for (const [army, sign] of [[BLUE, -1], [RED, 1]] as const) {
      const rate = (arrays: number, size?: number): number => {
        const g = size ? new AgentCommandGame(7, { ...quiet({ derelictRadiation: 0 }), map: { params: { size } } }) : game({ derelictRadiation: 0 });
        const s = g.sim;
        const d = s.derelict!;
        const c = core(g);
        c.x = d.x; c.y = d.y + sign * (d.hullOuter + 2);
        for (let i = 0; i < arrays; i++) s.add('solar', army, 'orbit', c.x + Math.cos(i) * 1.5, c.y + Math.sin(i) * 1.5);
        s.step();
        return c.heatRate;
      };
      expect(rate(0)).toBeCloseTo(ECON.coreTransitHeat, 9);
      expect(rate(6)).toBeCloseTo(ECON.coreTransitHeat, 9);
      expect(rate(0, 80)).toBeCloseTo(ECON.coreTransitHeat * 48 / 80, 9);
    }
    expect(game({ coreEnabled: false }).sim.derelictCore()).toBeUndefined();
    expect(game({ coreEnabled: false }).sim.derelict).not.toBeNull();
  });

  it('haul_core tows the held core home to the own Orbit segment (C2 mirror)', () => {
    for (const [army, team] of [[BLUE, 'nw'], [RED, 'se']] as const) {
      const g = game({ derelictRadiation: 0 });
      const s = g.sim;
      const c = core(g);
      expect(g.apply({ team, role: 'orbit' }, { kind: 'macro', action: 'haul_core' })).toMatchObject({ ok: false });
      const tug = s.add('tug', army, 'orbit', 24, 24 + (army === BLUE ? -1 : 1) * (s.derelict!.hullOuter + 1));
      tug.link = c.id; c.link = tug.id; c.state = 'towed';
      expect(g.apply({ team, role: 'orbit' }, { kind: 'macro', action: 'haul_core' }).ok).toBe(true);
      expect(tug.order).toMatchObject({ k: 'move', x: s.armies[army]!.spire.orbit.x, y: s.armies[army]!.spire.orbit.y });
    }
  });

  it('meltdown consumes the core, frees the tug and regrows an untowed core at the centre (C2 mirror)', () => {
    for (const [army, team, sign] of [[BLUE, 'nw', -1], [RED, 'se', 1]] as const) {
      const g = game({ derelictRadiation: 0, coreTransitHeat: 20, coreRegrowTime: 3, coreMeltdownDamage: 50 });
      const s = g.sim;
      const tug = s.add('tug', army, 'orbit', 24, 24);
      s.order(tug, { k: 'grapple', asteroid: core(g).id });
      g.step();
      expect(core(g).state).toBe('towed');
      s.order(tug, { k: 'move', x: 24, y: 24 + sign * (s.derelict!.hullOuter + 1), fight: false, speed: 0 });
      // At tow speed the chamber may outlast the first open window: the tug then waits a cycle at the gate.
      for (let i = 0; i < 2 * derelictPeriod(s.derelict!) && s.coreLift.at < 0; i++) g.step();
      expect(s.coreLift.at).toBeGreaterThan(0);
      const other = g.observe({ team: team === 'nw' ? 'se' : 'nw', role: 'orbit' }, 0);
      expect(other.coreLifted?.side).toBe(team);
      expect(other.alerts.some((a) => a.kind === 'core_lifted')).toBe(true);
      expect(validate(observationSchema, other).ok).toBe(true);
      const hp = tug.hp;
      const id = core(g).id;
      for (let i = 0; i < toTicks(6) && s.derelictCore(); i++) g.step();
      expect(s.derelictCore()).toBeUndefined();
      expect(s.byId.has(id)).toBe(false);
      expect(tug.link).toBe(0);
      expect(tug.hp).toBe(hp - 50);
      expect(g.events({ team, role: 'orbit' }, 0).some((e) => e.kind === 'core_meltdown')).toBe(true);
      expect(g.observe({ team, role: 'orbit' }, 0).schedule.some((e) => e.kind === 'core_regrows')).toBe(true);
      for (let i = 0; i < toTicks(2.5); i++) { g.step(); expect(s.derelictCore()).toBeUndefined(); }
      steps(g, toTicks(0.5) + 1);
      const fresh = s.derelictCore()!;
      expect([fresh.id === id, fresh.x, fresh.y, fresh.state, fresh.link, fresh.heat, fresh.vents]).toEqual([false, 24, 24, 'idle', 0, 0, 0]);
    }
  });

  it.each(MAP_SIZES)('retrieves a fresh core on S%i through the first open window with return margin', size => {
    const g = createGame({ seed: 7, options: { ...quiet(), map: { params: { size } } } });
    const s = g.sim, d = s.derelict!, c = core(g);
    const tug = s.add('tug', BLUE, 'orbit', d.x - d.hullOuter - 0.8, d.y);
    s.order(tug, { k: 'grapple', asteroid: c.id });
    for (let i = 0; i < d.open && !tug.link; i++) g.step();
    expect(tug.link).toBe(c.id);
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'macro', action: 'haul_core' }).ok).toBe(true);
    let leftChamberAt = 0;
    for (let i = 0; i < toTicks(120) && !c.dead && !tug.dead; i++) {
      g.step();
      if (!leftChamberAt && Math.hypot(tug.x - d.x, tug.y - d.y) > d.ringOuter + tug.radius) leftChamberAt = s.tick;
    }
    expect(leftChamberAt).toBeGreaterThan(0);
    expect(leftChamberAt).toBeLessThan(d.open);
    expect(s.armies[BLUE]!.stats.coreCashed).toBe(1);
    expect(tug.dead).toBe(false);
    expect(tug.link).toBe(0);
    expect(c.vents).toBe(0);
    expect(c.heat).toBeLessThan(60);
    expect(s.byId.has(c.id)).toBe(false);
    expect(100 / (s.econ.coreTransitHeat * 48 / size)).toBeCloseTo(100 * size / 48);
  });

  it.each([false, true])('consumes a destroyed tow exactly once, including a simultaneously dead carrier (%s)', carrierDies => {
    const g = game({ derelictRadiation: 0, coreMeltdownDamage: 50 });
    const s = g.sim, c = core(g);
    const tug = s.add('tug', BLUE, 'orbit', 24, 8);
    c.x = tug.x; c.y = tug.y;
    tug.link = c.id; c.link = tug.id; c.state = 'towed'; tug.state = 'towing';
    s.order(tug, { k: 'vent', until: s.tick + toTicks(8) });
    s.computeVision();
    if (carrierDies) s.damage(tug, tug.hp, RED);
    s.damage(c, c.hp, RED);
    g.step();
    const regrows = s.coreRegrowAt;
    expect(c.dead).toBe(true);
    expect([c.link, tug.link, s.coreId]).toEqual([0, 0, 0]);
    expect(tug.order.k).not.toBe('vent');
    expect(s.byId.has(c.id)).toBe(false);
    expect(g.view('nw').entities.some(e => e.id === g.entityId('nw', c.id))).toBe(false);
    expect(s.fx.filter(r => r.fx.kind === 'volatile_detonation' && r.fx.subject === 'core')).toHaveLength(1);
    if (!carrierDies) expect(tug.hp).toBe(tug.maxHp - 50);
    const bank = s.armies[BLUE]!.alloy;
    s.tick++;
    s.removeCore(c); s.coreMeltdown(c); s.cashCore(c, tug);
    expect(s.coreRegrowAt).toBe(regrows);
    expect(s.armies[BLUE]!.alloy).toBe(bank);
    expect(s.fx.filter(r => r.fx.kind === 'volatile_detonation' && r.fx.subject === 'core')).toHaveLength(1);
  });

  it('releases a live core when its carrier dies, but never cashes a dead carrier at the dock', () => {
    const g = game({ derelictRadiation: 0 });
    const s = g.sim, c = core(g), seg = s.armies[BLUE]!.spire.orbit;
    const tug = s.add('tug', BLUE, 'orbit', seg.x, seg.y);
    tug.link = c.id; c.link = tug.id; c.state = 'towed';
    s.damage(tug, tug.hp, RED);
    g.step();
    expect(s.armies[BLUE]!.stats.coreCashed).toBe(0);
    expect([c.dead, c.state, c.link, tug.link]).toEqual([false, 'idle', 0, 0]);
    expect(s.coreRegrowAt).toBe(-1);
  });

  it('intercepts a dropped core once and leaves no linked or falling payload', () => {
    const g = game({ derelictRadiation: 0 });
    const s = g.sim, c = core(g);
    const tug = s.add('tug', BLUE, 'orbit', 24, 8);
    c.x = tug.x; c.y = tug.y; tug.link = c.id; c.link = tug.id; c.state = 'towed'; tug.state = 'towing';
    s.deorbit(tug, c, 24, 8);
    expect([tug.link, c.link, tug.state, c.state]).toEqual([0, 0, 'idle', 'falling']);
    s.damage(c, c.hp, RED);
    g.step();
    expect(s.derelictCore()).toBeUndefined();
    expect(s.byId.has(c.id)).toBe(false);
    expect(s.armies[RED]!.stats.interceptions).toBe(1);
    expect(g.view('nw').impacts).toEqual([]);
    expect(s.fx.filter(r => r.fx.kind === 'intercept' && r.fx.subject === 'core')).toHaveLength(1);
  });

  it('vents to a rising floor only while still, releases on command, and drops on the Surface as a bomb', () => {
    const g = game({ derelictRadiation: 0, coreVentTime: 1, coreVentDamage: 10 });
    const s = g.sim;
    const c = core(g);
    const out = 24 - s.derelict!.hullOuter - 1.5;
    const tug = s.add('tug', BLUE, 'orbit', 24, out);
    c.x = 24; c.y = out; c.heat = 90;
    tug.link = c.id; c.link = tug.id; c.state = 'towed';
    for (const vents of [1, 2]) {
      expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'vent', units: [g.entityId('nw', tug.id)] }).ok).toBe(true);
      steps(g, toTicks(1) + 2);
      expect(c.vents).toBe(vents);
      expect(c.heat).toBeGreaterThanOrEqual(vents * s.econ.coreVentFloor);
      expect(c.heat).toBeLessThan(vents * s.econ.coreVentFloor + 1);
      expect([c.dead, c.state, tug.link, c.link]).toEqual([false, 'towed', c.id, tug.id]);
      expect(s.fx.some(r => r.fx.kind === 'core_vent')).toBe(true);
      expect(s.fx.some(r => r.fx.kind === 'volatile_detonation' && r.fx.subject === 'core')).toBe(false);
    }
    expect(tug.hp).toBe(tug.maxHp - 20);
    // Release: the tug is free at once, the core rests where it is (and keeps heating out here).
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'release', units: [g.entityId('nw', tug.id)] }).ok).toBe(true);
    expect([tug.link, c.link, c.state]).toEqual([0, 0, 'idle']);
    const heat = c.heat;
    g.step();
    expect(c.heat).toBeGreaterThan(heat);
    expect([c.x, c.y]).toEqual([24, out]);
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'release', units: [g.entityId('nw', tug.id)] }).ok).toBe(false);
    s.order(tug, { k: 'grapple', asteroid: c.id });
    g.step();
    expect(c.state).toBe('towed');
    // Inside the blast, outside the crater (a crater would drop it into the Depths).
    const target = s.add('trooper', RED, 'surface', 24, 20.75);
    target.hp = target.maxHp = 5000;
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'deorbit', units: [g.entityId('nw', tug.id)], x: 24, y: 18 }).ok).toBe(true);
    const dropHeat = c.heat;
    steps(g, s.econ.coreDropTicks);
    // The blast (a cooler core hits harder), plus at most the first tick of irradiated ground.
    const extra = 5000 - target.hp - (s.econ.coreDropDamage + s.econ.coreDropCoolBonus * (1 - dropHeat / 100));
    expect(extra).toBeGreaterThanOrEqual(0);
    expect(extra).toBeLessThan(s.econ.coreIrradiateDps / 20 + 1e-9);
    const hp = target.hp;
    g.step();
    expect(target.hp).toBeCloseTo(hp - s.econ.coreIrradiateDps / 20, 9);
    expect(target.lastHitCause).toBe('radiation');
    expect(s.scorches).toHaveLength(1);
    expect(s.coreRegrowAt).toBeGreaterThan(s.tick);
  });

  it('a sealing ring pushes a towing tug and its core to the same side', () => {
    const g = game({ derelictRadiation: 0 });
    const s = g.sim;
    const d = s.derelict!;
    const c = core(g);
    const tug = s.add('tug', BLUE, 'orbit', 24 + (d.ringInner + d.ringOuter) / 2 + 0.1, 24);
    c.x = tug.x; c.y = tug.y;
    tug.link = c.id; c.link = tug.id; c.state = 'towed';
    tug.stance = 'hold';
    s.tick = d.open;
    s.step();
    expect([c.x, c.y]).toEqual([tug.x, tug.y]);
    expect(Math.hypot(tug.x - 24, tug.y - 24)).toBeGreaterThan(d.ringOuter);
  });

  it('stays exactly symmetric for C2 and C4 fleets crossing the ruin', () => {
    for (const slots of [2, 4] as const) {
      const g = new AgentCommandGame(5, { ...quiet(), map: { params: { slots } } });
      const s = g.sim;
      const units = s.allArmies.map((a) => {
        const k = s.armyFrame[a]!;
        return (['lancer', 'skiff', 'bastion', 'tug'] as const).map((kind, i) => s.add(kind, a, 'orbit', rotX(k, 10 + i, 12, s.size), rotY(k, 10 + i, 12, s.size)));
      });
      const legs: [number, number][] = [[18, 26], [28, 22], [24, 24], [12, 14]];
      for (let t = 0; t < 2400; t++) {
        if (t % 600 === 0) {
          const [lx, ly] = legs[t / 600]!;
          for (const a of s.allArmies) { const k = s.armyFrame[a]!; for (const e of units[a]!) s.order(e, { k: 'move', x: rotX(k, lx, ly, s.size), y: rotY(k, lx, ly, s.size), fight: true, speed: 0 }); }
        }
        g.step();
        for (let i = 0; i < 4; i++) for (const a of s.allArmies) {
          const ref = units[0]![i]!, e = units[a]![i]!, k = s.armyFrame[a]!;
          expect([e.dead, canonX(k, e.x, e.y, s.size), canonY(k, e.x, e.y, s.size), e.hp]).toEqual([ref.dead, ref.x, ref.y, ref.hp]);
        }
      }
    }
  });

  it('a fleet split round the sealed ring leaves by the breaches instead of freezing at the gates (C2, C4 mirror)', () => {
    for (const slots of [2, 4] as const) {
      const g = new AgentCommandGame(5, { ...quiet(), map: { params: { slots } } });
      const s = g.sim;
      const d = s.derelict!;
      s.tick = d.open + d.turn;
      // Each army's pair in the corridor at its south and north gate mouths (the fleet's centroid lies in the chamber),
      // ordered home as one fleet while the ring is sealed.
      const units = s.allArmies.map((a) => {
        const k = s.armyFrame[a]!;
        const pair = [[d.x, d.y + 9.2], [d.x + 0.19, d.y - 10.19]].map(([x, y]) => s.add('lancer', a, 'orbit', rotX(k, x!, y!, s.size), rotY(k, x!, y!, s.size)));
        const team = s.armyIds[a]!;
        expect(g.apply({ team, role: 'orbit' }, { kind: 'move', units: pair.map((e) => g.entityId(team, e.id)), x: rotX(k, 4, 4, s.size), y: rotY(k, 4, 4, s.size), formation: 'line' }).ok).toBe(true);
        return pair;
      });
      for (let t = 0; t < toTicks(20); t++) {
        expect(gatesOpen(d, s.tick)).toBe(false);
        g.step();
        for (let i = 0; i < 2; i++) for (const a of s.allArmies) {
          const ref = units[0]![i]!, e = units[a]![i]!, k = s.armyFrame[a]!;
          expect([canonX(k, e.x, e.y, s.size), canonY(k, e.x, e.y, s.size)]).toEqual([ref.x, ref.y]);
        }
      }
      for (const e of units.flat()) expect(Math.hypot(e.x - d.x, e.y - d.y)).toBeGreaterThan(d.hullOuter);
    }
  });

  it('a fight-move whose route turns away from its goal engages an enemy blocking the route (C2, C4 mirror)', () => {
    for (const slots of [2, 4] as const) {
      const g = new AgentCommandGame(5, { ...quiet({ derelictRadiation: 0 }), map: { params: { slots } } });
      const s = g.sim;
      const d = s.derelict!;
      // In the corridor at 40°, bound outside the hull at 70°: the route runs back to the east breach (away from the
      // goal), and a hostile Bastion sits on it, behind the goal's bearing but ahead on the route.
      const mid = (d.ringOuter + d.hullInner) / 2, out = d.hullOuter + 3, rad = Math.PI / 180;
      const sx = d.x + mid * Math.cos(40 * rad), sy = d.y + mid * Math.sin(40 * rad);
      const gx = d.x + out * Math.cos(70 * rad), gy = d.y + out * Math.sin(70 * rad);
      expect(s.derelictRoute(sx, sy, s.stats.lancer.radius, gx, gy)).toBe(true);
      const [rx, ry] = [route.x - sx, route.y - sy];
      const ahead = 4 / Math.hypot(rx, ry);
      const [bx, by] = [sx + rx * ahead, sy + ry * ahead];
      expect((bx - sx) * (gx - sx) + (by - sy) * (gy - sy)).toBeLessThan(0);
      const n = s.allArmies.length;
      const pairs = s.allArmies.map((a) => {
        const k = s.armyFrame[a]!;
        const lancer = s.add('lancer', a, 'orbit', rotX(k, sx, sy, s.size), rotY(k, sx, sy, s.size));
        const blocker = s.add('bastion', s.allArmies[(a + 1) % n]!, 'orbit', rotX(k, bx, by, s.size), rotY(k, bx, by, s.size));
        blocker.stance = 'hold';
        s.order(lancer, { k: 'move', x: rotX(k, gx, gy, s.size), y: rotY(k, gx, gy, s.size), fight: true, speed: 0 });
        return { lancer, blocker };
      });
      const contact = s.stats.lancer.radius + s.stats.bastion.radius + s.econ.moveFrontContact;
      let engaged = -1;
      for (let t = 0; t < toTicks(5) && engaged < 0; t++) {
        g.step();
        for (const { lancer, blocker } of pairs) {
          const a = lancer.side, k = s.armyFrame[a]!, ref = pairs[0]!.lancer;
          expect([canonX(k, lancer.x, lancer.y, s.size), canonY(k, lancer.x, lancer.y, s.size), lancer.engage !== 0]).toEqual([ref.x, ref.y, ref.engage !== 0]);
          expect(lancer.engage === 0 || lancer.engage === blocker.id).toBe(true);
        }
        if (pairs[0]!.lancer.engage !== 0) engaged = t;
      }
      expect(engaged).toBeGreaterThanOrEqual(0);
      // Engaged from range, not only once it bumped into the Bastion.
      for (const { lancer, blocker } of pairs) expect(Math.hypot(lancer.x - blocker.x, lancer.y - blocker.y)).toBeGreaterThan(contact);
    }
  });

  it('is the largest ruin that fits: 0.5625 of every map at the default inset, shrinking where the Spires stand closer', () => {
    for (const size of MAP_SIZES) for (const slots of [2, 4] as const) for (let spireInset = SPIRE_INSET_MIN; spireInset <= SPIRE_INSET_MAX; spireInset++) {
      const options: MatchOptions = { map: { params: { size, slots, spireInset } } };
      expect(checkRules(options).ok).toBe(true);
      const t = compileRules(resolveRules(options));
      const g = derelictGeometry(t.econ, t.stats, t.spires, size);
      const k = g.hullOuter / t.econ.derelictHullOuter;
      const beam = t.stats.spire.range + SPIRE_CORNER;
      const stand = (beam + t.stats.tug.radius + t.econ.deorbitRange) / 2 + t.stats.tug.radius;
      const ship = widestOrbitShip(t.stats);
      for (const spire of Object.values(t.spires)) {
        const d = Math.hypot(spire.x - size / 2, spire.y - size / 2);
        // A fleet lane between the hull and every Spire's beam reach to the widest ship and its deorbit stand-off.
        expect(g.hullOuter + t.econ.derelictLane * k).toBeLessThanOrEqual(d - Math.max(beam + ship, stand) + 1e-9);
        if (size === MAP_SIZES[0] && spireInset === SPIRE_INSET_MIN) {
          // The binding case: S48 at the default inset ends within half a tile of the stand-off.
          expect(d - stand - g.hullOuter - t.econ.derelictLane * k).toBeLessThan(0.5);
        }
      }
      expect(Math.min(g.breachWidth, g.gateWidth)).toBeGreaterThanOrEqual(passWidth(ship));
      expect(k).toBeLessThanOrEqual(size / MAP_SIZES[0]);
      if (spireInset === SPIRE_INSET_MIN) expect((2 * g.hullOuter) / size).toBeCloseTo(0.5625, 12);
    }
  });

  it('rejects a ruin the Spires leave too little room for', () => {
    const close = (size: number, slots: 2 | 4 = 2): MatchOptions['map'] => ({ params: { size, slots, spireInset: SPIRE_INSET_MAX } });
    for (const slots of [2, 4] as const) {
      expect(checkRules({ map: close(48, slots), orbit: { derelictLane: 12 } })).toMatchObject({ ok: false, error: expect.stringMatching(/^rules\.orbit\.derelictGateWidth: .*spireInset 12 on S48/) });
      expect(checkRules({ map: close(48, slots), orbit: { derelictLane: 12, derelictEnabled: false } }).ok).toBe(true);
      expect(checkRules({ map: close(64, slots), orbit: { derelictLane: 12 } }).ok).toBe(true);
    }
    // At the default inset a wider lane only shrinks the ruin.
    expect(checkRules({ orbit: { derelictLane: 12 } }).ok).toBe(true);
  });

  it('drifting asteroids spawn outside the hull and glance off it, exactly symmetric (C2, C4)', () => {
    for (const slots of [2, 4] as const) {
      const g = new AgentCommandGame(3, { terrain: 'open', map: { params: { slots } } });
      const s = g.sim;
      const d = s.derelict!;
      const turn = 4 / slots;
      const velocity = new Map<number, [number, number]>();
      let closest = Infinity;
      let glances = 0;
      for (let t = 0; t < toTicks(300); t++) {
        g.step();
        const rocks = s.ents.filter((a) => a.kind === 'asteroid' && !a.dead && a.state === 'drifting');
        for (const a of rocks) {
          closest = Math.min(closest, Math.hypot(a.x - d.x, a.y - d.y) - d.hullOuter - a.radius);
          const before = velocity.get(a.id);
          const edge = s.econ.asteroidEdge + Math.abs(a.vx) + Math.abs(a.vy);
          const atEdge = Math.min(a.x, a.y, s.size - a.x, s.size - a.y) < edge;
          if (before && (before[0] !== a.vx || before[1] !== a.vy) && !atEdge) glances++;
          velocity.set(a.id, [a.vx, a.vy]);
          expect(rocks.some((b) => Math.abs(rotX(turn, a.x, a.y, s.size) - b.x) < 1e-9 && Math.abs(rotY(turn, a.x, a.y, s.size) - b.y) < 1e-9)).toBe(true);
        }
      }
      expect(closest).toBeGreaterThanOrEqual(-1e-9);
      expect(glances).toBeGreaterThan(0);
    }
  });

  it('the bot and the example policy berth arrays round their own Spire, where they anchor and earn (C2, C4)', () => {
    for (const [size, slots] of [[48, 2], [48, 4], [80, 2]] as const) {
      const g = new AgentCommandGame(5, { map: { params: { size, slots } } });
      const s = g.sim;
      for (const e of s.ents) if (e.unit && e.kind !== 'solar') e.hp = 0;
      // A third array fresh off the Spire's rally slot: the two starting arrays may already sit on berths (rally slots
      // and berths are both rings round the Spire, and float rounding decides which slot a spawn takes), so this one
      // gives the bot and the policy berthing to do.
      for (const army of s.allArmies) s.spawnUnit(army, 'solar', 'orbit');
      g.step();
      const moves = new Map<string, AgentCommandIntent[]>();
      for (const team of s.armyIds) {
        const seat = { team, role: 'orbit' } as const;
        const data: MatchData = g.matchData(seat);
        const bot = createBot(team, 'orbit', 'standard');
        bot.init?.(data);
        const ordered = bot.think(g.observe(seat, 0)).filter((i) => i.kind === 'move');
        const policy = runInNewContext(`${STARTER_POLICIES.orbit}\ninit(bootstrap);\nthink;`, { bootstrap: data, log() {} }) as (obs: Observation) => AgentCommandIntent[];
        const chosen = structuredClone(policy(g.observe(seat, 0))).filter((i) => i.kind === 'move');
        // Same berths for the bot and the policy: a move for each starting array not already at its berth.
        expect(chosen.map((i) => i.kind === 'move' && [i.x, i.y])).toEqual(ordered.map((i) => i.kind === 'move' && [i.x, i.y]));
        expect(ordered.length).toBeGreaterThan(0);
        moves.set(team, ordered);
        for (const i of ordered) expect(g.apply(seat, i, { source: 'bot' })).toEqual({ ok: true });
      }
      for (let t = 0; t < toTicks(20); t++) g.step();
      const arrays = s.ents.filter((e) => e.kind === 'solar' && !e.dead);
      for (const a of arrays) {
        expect(a.state, `S${size} C${slots}`).toBe('unfurled');
        expect(a.output).toBeGreaterThan(0);
        // Home berths: full distance output, unshaded.
        expect(s.solarDistance(a.x, a.y, s.armies[a.side]!.spire.orbit)).toBe(1);
        expect(s.solarShade(a.side, a.x, a.y, a.id)).toBe(1);
      }
      const ref = arrays.filter((a) => a.side === s.allArmies[0]).map((a) => [a.x, a.y]);
      for (const army of s.allArmies) {
        const k = s.armyFrame[army]!;
        expect(arrays.filter((a) => a.side === army).map((a) => [canonX(k, a.x, a.y, s.size), canonY(k, a.x, a.y, s.size)])).toEqual(ref);
      }
    }
  });
});
