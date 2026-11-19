import { describe, expect, it } from 'vitest';
import { validate } from 'playerthree/schema';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { TICK_RATE, observationSchema, toTicks, type MatchOptions, type RockSize, type ArmyId } from '../src/rules/contract.ts';
import { VISION_EVERY } from '../src/sim/constants.ts';
import { type Ent } from '../src/sim/ent.ts';
import { NEUTRAL, slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

const id = (g: AgentCommandGame, team: ArmyId, e: Ent): string => g.entityId(team, e.id);
const steps = (g: AgentCommandGame, n: number): void => { for (let i = 0; i < n; i++) g.step(); };
// No derelict: tows here run in open space round the centre, where its chamber would irradiate the bystanders.
const game = (orbit: MatchOptions['orbit'] = {}) => createGame({ seed: 41, options: { terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0, stationPdDamage: 0, dockHull: 0, dockShield: 0, derelictEnabled: false, ...orbit } } });
function prepareTow(g: AgentCommandGame, side: ArmyId = 'nw', size: RockSize = 'medium', x = 20, y = 20): { tug: Ent; rock: Ent } {
  const tug = g.sim.add('tug', slotOfArmyId(side, 2), 'orbit', x, y);
  const rock = g.sim.add('asteroid', NEUTRAL, 'orbit', x, y);
  rock.rockSize = size; rock.resourceType = 'metal'; rock.volatile = true; rock.state = 'drifting';
  rock.resourceRemaining = g.sim.rocks[size].dockYield.metal.alloy;
  rock.hp = rock.maxHp = g.sim.rocks[size].hp;
  g.sim.computeVision();
  expect(g.apply({ team: side, role: 'orbit' }, { kind: 'grapple', units: [id(g, side, tug)], asteroid: id(g, side, rock) })).toEqual({ ok: true });
  return { tug, rock };
}
function tow(g: AgentCommandGame, side: ArmyId = 'nw', size: RockSize = 'medium', x = 20, y = 20): { tug: Ent; rock: Ent } {
  const { tug, rock } = prepareTow(g, side, size, x, y);
  g.step();
  expect(rock.state).toBe('towed'); expect(tug.link).toBe(rock.id);
  g.sim.scan(slotOfArmyId(side, 2), rock.x, rock.y);
  return { tug, rock };
}

describe('volatile tow instability', () => {
  it.each(['pebble', 'medium', 'large'] as const)('%s arms a size-specific lower hull and configured fuse on grapple', size => {
    const g = game({ volatileFuse: 7, volatileTowHpFraction: 0.25 });
    const { rock } = tow(g, 'nw', size);
    expect(rock.fuseUntil).toBe(g.tick + toTicks(7));
    expect(rock.maxHp).toBe(Math.round(g.sim.rocks[size].hp * 0.25));
    expect(rock.hp).toBe(rock.maxHp);
    const seen = g.view('nw').entities.find(e => e.id === id(g, 'nw', rock))!;
    expect(seen.fuseUntil).toBe(rock.fuseUntil);
    expect(validate(observationSchema, g.observe({ team: 'nw', role: 'orbit' }, 0)).ok).toBe(true);
  });

  it('detonates exactly at expiry, hits both teams and structures, respects shields and stays in Orbit', () => {
    const g = game({ volatileFuse: 2, volatileOrbitDamage: 80, volatileOrbitRadius: 3 });
    const { tug, rock } = tow(g);
    const ally = g.sim.add('solar', BLUE, 'orbit', rock.x + 2, rock.y);
    const enemy = g.sim.add('solar', RED, 'orbit', rock.x - 2, rock.y);
    const structure = g.sim.add('shaft', RED, 'orbit', rock.x + 2, rock.y + 2);
    const shielded = g.sim.add('bastion', BLUE, 'orbit', rock.x, rock.y + 2);
    const surface = g.sim.add('flak', RED, 'surface', rock.x, rock.y);
    const sky = g.sim.add('interceptor', RED, 'sky', rock.x, rock.y);
    const far = g.sim.add('solar', RED, 'orbit', rock.x + 7, rock.y);
    shielded.stance = 'hold'; shielded.cd = 1e9;
    const before = [tug.hp, ally.hp, enemy.hp, structure.hp, shielded.hp, shielded.shield, surface.hp, sky.hp, far.hp];
    g.sim.tick = rock.fuseUntil - 2; g.step();
    expect(rock.dead).toBe(false);
    g.step();
    expect(rock.dead).toBe(true); expect(tug.link).toBe(0);
    expect([tug.hp, ally.hp, enemy.hp, structure.hp]).toEqual(before.slice(0, 4).map(hp => hp - 80));
    expect(shielded.hp).toBe(before[4]); expect(shielded.shield).toBe(before[5]! - 80);
    expect([surface.hp, sky.hp, far.hp]).toEqual(before.slice(6));
    expect(g.sim.holeCount).toBe(0); expect(g.sim.oreCaches).toHaveLength(0); expect(g.sim.scorches).toHaveLength(0);
    expect(g.view('nw').fx.filter(f => f.kind === 'volatile_detonation')).toHaveLength(1);
    expect(g.events({ team: 'nw', role: 'orbit' }, 0).filter(e => e.kind === 'volatile_detonation')).toHaveLength(1);
    g.step(); expect(g.sim.fx.filter(r => r.fx.kind === 'volatile_detonation')).toHaveLength(1);
  });

  it('keeps all storage-order victims in the same death cleanup when a towed rock is destroyed', () => {
    const g = game({ volatileOrbitDamage: 1000 });
    const earlier = g.sim.add('solar', RED, 'orbit', 20, 21);
    const { tug, rock } = tow(g);
    const later = g.sim.add('solar', BLUE, 'orbit', 20, 19);
    g.sim.damage(rock, rock.hp, RED);
    g.step();
    for (const e of [earlier, tug, rock, later]) expect(g.sim.byId.has(e.id)).toBe(false);
    expect(tug.link).toBe(0);
    expect(g.sim.armies[BLUE]!.stats.unitsLost).toBeGreaterThanOrEqual(2);
  });

  it.each(['lancer', 'bastion', 'skiff'] as const)('%s can explicitly shoot and detonate an enemy tow', kind => {
    const g = game({ volatileTowHpFraction: 0.01 });
    const { tug, rock } = tow(g);
    const defender = g.sim.add(kind, RED, 'orbit', rock.x + 2, rock.y);
    defender.stance = 'hold';
    g.sim.scan(RED, rock.x, rock.y);
    expect(g.apply({ team: 'se', role: 'orbit' }, { kind: 'attack', units: [id(g, 'se', defender)], target: id(g, 'se', rock) })).toEqual({ ok: true });
    steps(g, toTicks(3));
    expect(rock.dead).toBe(true);
    expect(g.sim.byId.has(tug.id)).toBe(false);
    expect(g.events({ team: 'se', role: 'orbit' }, 0).some(e => e.kind === 'volatile_detonation')).toBe(true);
    expect(g.sim.armies[RED]!.stats.interceptions).toBe(0); // It never became a falling payload.
  });

  it('does not authorize friendly or ordinary drifting rock attacks', () => {
    const g = game(); const { rock } = tow(g);
    const ally = g.sim.add('lancer', BLUE, 'orbit', 20, 22);
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'attack', units: [id(g, 'nw', ally)], target: id(g, 'nw', rock) })).toEqual({ ok: false, code: 'invalid_target' });
    const ordinary = g.sim.add('asteroid', NEUTRAL, 'orbit', 21, 20); ordinary.state = 'drifting';
    g.sim.computeVision();
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'attack', units: [id(g, 'nw', ally)], target: id(g, 'nw', ordinary) })).toEqual({ ok: false, code: 'invalid_target' });
  });

  it('a timely drop disarms, preserves hull fraction, and keeps the usual volatile Surface blast', () => {
    const g = game(); const { tug, rock } = tow(g);
    g.sim.damage(rock, 30, RED); // 120/150 hull while towing.
    expect(g.sim.dropPayload(rock, BLUE, 24, 24)).toBe(true);
    tug.link = rock.link = 0;
    expect(rock.fuseUntil).toBe(0); expect(rock.maxHp).toBe(300); expect(rock.hp).toBe(240);
    const target = g.sim.add('shaft', RED, 'surface', 24, 24); target.hp = target.maxHp = 2000;
    g.sim.tick = rock.impactTick - 1; g.step();
    expect(target.hp).toBe(2000 - 900 * 0.8);
    expect(g.sim.scorches).toHaveLength(1); expect(g.sim.oreCaches).toHaveLength(0);
    expect(g.sim.fx.some(r => r.fx.kind === 'volatile_detonation')).toBe(false);
  });

  it('docks before expiry for ordinary salvage without a volatile premium', () => {
    const g = game(); const { tug, rock } = tow(g);
    const home = g.sim.spireAt[BLUE]!; tug.x = home.x; tug.y = home.y;
    const mined = g.sim.armies[BLUE]!.stats.alloyMined;
    g.step();
    expect(rock.dead).toBe(true); expect(rock.fuseUntil).toBe(0);
    expect(g.sim.armies[BLUE]!.stats.alloyMined - mined).toBe(150);
    expect(g.sim.fx.some(r => r.fx.kind === 'volatile_detonation')).toBe(false);
  });

  it('releases and disarms when the tug dies without healing the rock', () => {
    const g = game(); const { tug, rock } = tow(g);
    g.sim.damage(rock, 30, RED); tug.hp = 0;
    g.step();
    expect(rock.state).toBe('drifting'); expect(rock.fuseUntil).toBe(0);
    expect(rock.maxHp).toBe(300); expect(rock.hp).toBe(240); expect(rock.link).toBe(0);
  });
});

describe('volatile fog, mirror and determinism', () => {
  it('reveals fuse only in local vision, not to an unseen defender', () => {
    const g = game(); const { rock } = tow(g);
    expect(g.view('se').entities.some(e => g.sim.aliasTarget(RED, Number(e.id.slice(2))) === rock.id)).toBe(false);
    g.sim.scan(RED, rock.x, rock.y);
    expect(g.view('se').entities.find(e => e.id === id(g, 'se', rock))!.fuseUntil).toBe(rock.fuseUntil);
    g.sim.armies[RED]!.scans.length = 0; steps(g, VISION_EVERY);
    expect(g.view('se').entities.some(e => e.id === id(g, 'se', rock))).toBe(false);
    g.sim.deorbit(g.sim.alive(rock.link)!, rock, 24, 24);
    const falling = g.view('se').entities.find(e => e.id === id(g, 'se', rock))!;
    expect(falling.fuseUntil).toBeUndefined(); expect(falling.resourceType).toBeUndefined(); expect(falling.volatile).toBeUndefined();
  });

  it('records detonation audiences at event time, never disclosing it when vision arrives later', () => {
    const g = game({ volatileOrbitDamage: 1000 }); const { rock } = tow(g);
    const x = rock.x, y = rock.y;
    g.sim.tick = rock.fuseUntil - 1; g.step();
    expect(g.events({ team: 'se', role: 'orbit' }, 0).some(e => e.kind === 'volatile_detonation')).toBe(false);
    expect(g.view('se').fx.some(f => f.kind === 'volatile_detonation')).toBe(false);
    g.sim.scan(RED, x, y);
    expect(g.view('se').fx.some(f => f.kind === 'volatile_detonation')).toBe(false);
    // The destroyed tow's owner saw the burst even though its sight source was destroyed by it.
    expect(g.view('nw').fx.some(f => f.kind === 'volatile_detonation')).toBe(true);
  });

  it('mirrors fuse deadlines, hull and blast damage exactly', () => {
    const g = game();
    const left = prepareTow(g, 'nw', 'medium', 16, 20);
    const right = prepareTow(g, 'se', 'medium', g.sim.size - 16, g.sim.size - 20);
    g.step();
    expect(left.rock.fuseUntil).toBe(right.rock.fuseUntil);
    expect(left.rock.hp).toBe(right.rock.hp);
    const a = g.sim.add('solar', BLUE, 'orbit', 16, 22);
    const b = g.sim.add('solar', RED, 'orbit', g.sim.size - 16, g.sim.size - 22);
    g.sim.tick = left.rock.fuseUntil - 1; g.step();
    expect(left.rock.dead).toBe(right.rock.dead); expect(left.tug.hp).toBe(right.tug.hp); expect(a.hp).toBe(b.hp);
    const bursts = g.sim.fx.filter(r => r.fx.kind === 'volatile_detonation');
    expect(bursts).toHaveLength(2);
    expect(bursts[0]!.fx.x + bursts[1]!.fx.x).toBe(g.sim.size); expect(bursts[0]!.fx.y + bursts[1]!.fx.y).toBe(g.sim.size);
  });

  it('hashes fuse changes and replays isolated checkpoints deterministically through detonation', () => {
    const g = game({ volatileFuse: 2 }); const { rock } = tow(g);
    const twin = g.clone(); const before = g.stateHash();
    twin.sim.alive(rock.id)!.fuseUntil++;
    expect(twin.stateHash()).not.toBe(before); expect(g.stateHash()).toBe(before);
    twin.sim.alive(rock.id)!.fuseUntil--;
    for (let i = 0; i < 3 * TICK_RATE; i++) { g.step(); twin.step(); expect(twin.stateHash()).toBe(g.stateHash()); }
    expect(g.sim.byId.has(rock.id)).toBe(false);
  });
});
