import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { OBS_GRID, TICK_RATE, footprint, sunLit, toTicks, type MatchOptions, type ArmyId, type UnitKind } from '../src/rules/contract.ts';
import { entityOut } from '../src/agent/present.ts';
import type { Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);

/** Open Orbit (the derelict ruin, scaled to the map, fills the centre these routes cross; derelict.test.ts covers it). */
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 47, options: { terrain: 'open', ...options, orbit: { maxAsteroids: 0, derelictEnabled: false, ...options.orbit } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire') e.hp = 0;
  g.step();
  for (const e of g.sim.ents) e.cd = e.stationPdCd = toTicks(1000);
  g.sim.armies[BLUE]!.energy = g.sim.armies[RED]!.energy = 10000;
  g.sim.armies[BLUE]!.alloy = g.sim.armies[RED]!.alloy = 10000;
  return g;
}

function ship(g: AgentCommandGame, kind: UnitKind, team: ArmyId, x: number, y: number): Ent {
  const e = g.sim.add(kind, slotOfArmyId(team, 2), 'orbit', x, y);
  e.stance = 'hold';
  e.cd = toTicks(1000);
  e.combatAt = g.tick + toTicks(1000);
  return e;
}

function advance(g: AgentCommandGame, ticks: number): void {
  for (let i = 0; i < ticks; i++) g.step();
}

function target(g: AgentCommandGame, team: ArmyId, x: number, y: number): Ent {
  const e = ship(g, 'solar', team, x, y);
  e.hp = e.maxHp = 1000;
  return e;
}

function research(g: AgentCommandGame): void {
  for (const team of ['nw', 'se'] as const) {
    g.sim.armies[slotOfArmyId(team, 2)]!.research.add('aegis_projectors');
    g.sim.armies[slotOfArmyId(team, 2)]!.research.add('night_cloak');
  }
}

describe('Sun lance', () => {
  it('is free on Lancers, validates light, lifecycle state, energy and coordinates before charging', () => {
    const g = arena();
    const e = ship(g, 'lancer', 'nw', 12, 12);
    const wrong = ship(g, 'bastion', 'nw', 15, 12);
    expect(g.sim.sunLance(wrong, 26, 12)).toBe(false);
    expect(g.sim.sunLance(e, e.x, e.y)).toBe(false);
    expect(g.sim.sunLance(e, NaN, 12)).toBe(false);
    expect(g.sim.sunLance(e, g.sim.size + 1, 12)).toBe(false);
    g.sim.armies[BLUE]!.energy = g.sim.econ.lanceEnergy - 1;
    expect(g.sim.sunLance(e, 26, 12)).toBe(false);
    g.sim.armies[BLUE]!.energy = 100;
    e.x = 30; e.y = 10;
    expect(sunLit(e.x, e.y, g.sim.sunAngle, g.sim.size, g.sim.sunWedges)).toBe(false);
    expect(g.sim.sunLance(e, 40, 10)).toBe(false);
    e.x = e.y = 12;
    e.built = false;
    expect(g.sim.sunLance(e, 26, 12)).toBe(false);
    e.built = true;
    expect(g.sim.sunLance(e, 26, 12)).toBe(true);
    expect(g.sim.armies[BLUE]!.energy).toBe(100 - g.sim.econ.lanceEnergy);
    expect(e.lanceAt).toBe(g.tick + toTicks(2));
    expect(e.abilityReady).toBe(g.tick + toTicks(25));
    expect(e.shield).toBe(e.maxShield);
    expect(g.sim.sunLance(e, 26, 12)).toBe(false);
    const own = entityOut(g.sim, e, 'nw');
    g.sim.giveAlias(RED, e.id); // presented as Red would see it, once it has a name for it
    const enemy = entityOut(g.sim, e, 'se');
    expect(own.abilityReady).toBe(e.abilityReady);
    expect(enemy.abilityReady).toBeUndefined();
    // The lance point sits on cell edges: presented one grid step toward the map centre (never on an edge).
    expect(enemy.lance).toEqual({ x: 26 - 1 / OBS_GRID, y: 12 + 1 / OBS_GRID, at: e.lanceAt });
  });

  it('telegraphs for the full charge, travels at configured speed, pierces in contact order once and expires at range', () => {
    const g = arena();
    const e = ship(g, 'lancer', 'nw', 12, 12);
    // Reverse insertion order must not choose the first victim.
    const third = target(g, 'se', 25, 12);
    const second = target(g, 'se', 21, 12);
    const first = target(g, 'se', 17, 12);
    const outside = target(g, 'se', 28, 12);
    const friendly = target(g, 'nw', 19, 12);
    const offLine = target(g, 'se', 23, 14);
    const sky = g.sim.add('relay', RED, 'sky', 20, 12);
    const skyHp = sky.hp;
    expect(g.sim.sunLance(e, 26, 12)).toBe(true);
    advance(g, g.sim.econ.lanceCharge - 1);
    expect(first.hp).toBe(1000);
    expect(e.shield).toBe(e.maxShield);
    g.step();
    expect(e.lanceAt).toBe(0);
    expect(e.shield).toBe(0);
    expect(e.combatAt).toBe(g.tick);
    expect(g.sim.lances).toHaveLength(1);
    expect(g.sim.lances[0]!.distance).toBe(g.sim.econ.lanceSpeed / TICK_RATE);
    expect(first.hp).toBe(1000);
    expect(g.sim.fx.find(({ fx }) => fx.kind === 'lance')?.fx).toMatchObject({ tx: 26, ty: 12, arrive: g.tick + Math.ceil(14 * TICK_RATE / 12) });
    advance(g, Math.ceil(14 * TICK_RATE / 12));
    expect(first.hp).toBe(880);
    expect(second.hp).toBe(940);
    expect(third.hp).toBe(940);
    expect(outside.hp).toBe(1000);
    expect(friendly.hp).toBe(1000);
    expect(offLine.hp).toBe(1000);
    expect(sky.hp).toBe(skyHp);
    expect(g.sim.lances).toHaveLength(0);
  });

  it('rechecks sunlight at firing and consumes the original energy/cooldown without draining shields on a cancelled shot', () => {
    const g = arena();
    const e = ship(g, 'lancer', 'nw', 12, 12);
    expect(g.sim.sunLance(e, 26, 12)).toBe(true);
    const cooldown = e.abilityReady;
    e.x = 30; e.y = 10;
    advance(g, g.sim.econ.lanceCharge);
    expect(e.lanceAt).toBe(0);
    expect(e.shield).toBe(e.maxShield);
    expect(g.sim.lances).toHaveLength(0);
    expect(e.abilityReady).toBe(cooldown);
    expect(g.sim.fx.some(({ fx }) => fx.kind === 'lance')).toBe(false);
  });

  it('allows a victim to dodge after launch rather than resolving the aim line instantly', () => {
    const g = arena();
    const e = ship(g, 'lancer', 'nw', 12, 12);
    const victim = target(g, 'se', 22, 12);
    expect(g.sim.sunLance(e, 26, 12)).toBe(true);
    advance(g, g.sim.econ.lanceCharge);
    expect(victim.hp).toBe(1000);
    victim.y = 15;
    advance(g, toTicks(2));
    expect(victim.hp).toBe(1000);
  });

  it('hits hostile structures at the structure multiplier and uses host damage, speed, range, width and timings', () => {
    const g = arena({ orbit: { maxAsteroids: 0, lanceEnergy: 7, lanceCharge: 0.1, lanceCooldown: 0.5, lanceSpeed: 4, lanceRange: 8, lanceWidth: 0.5, lanceDamage: 37, lancePierceDamage: 11, lanceStructureMultiplier: 0.25 } });
    const e = ship(g, 'lancer', 'nw', 12, 12);
    const structure = g.sim.add('spire', RED, 'orbit', 18, 12);
    structure.cd = structure.stationPdCd = toTicks(1000);
    const hull = structure.hp;
    const behind = target(g, 'se', 19.5, 12.6);
    expect(g.sim.sunLance(e, 26, 12)).toBe(true);
    expect(e.lanceAt).toBe(g.tick + 2);
    expect(e.abilityReady).toBe(g.tick + 10);
    advance(g, 2 + toTicks(2));
    // The segment takes the first hit at the structure share; the ship behind it the full pierce damage.
    expect(structure.hp).toBe(hull - 37 * 0.25);
    expect(behind.hp).toBe(989);
    expect(g.sim.lances).toHaveLength(0);
  });

  it('hides an unseen charge and launch trajectory, revealing only locally visible piercing contacts', () => {
    const g = arena();
    const shooter = ship(g, 'lancer', 'nw', 12, 12);
    const victim = target(g, 'se', 24, 12);
    advance(g, 2);
    expect(g.sim.sees(RED, shooter)).toBe(false);
    expect(g.sim.sees(BLUE, victim)).toBe(false);
    expect(g.sim.sunLance(shooter, 26, 12)).toBe(true);
    expect(g.view('se').entities.some((e) => e.id === `e_${g.sim.aliasOf(RED, shooter.id)}`)).toBe(false);
    advance(g, g.sim.econ.lanceCharge);
    expect(g.view('se').fx.some((f) => f.kind === 'lance' || f.src === `e_${g.sim.aliasOf(RED, shooter.id)}`)).toBe(false);
    for (let i = 0; i < toTicks(2) && victim.hp === 1000; i++) g.step();
    expect(victim.hp).toBe(880);
    const hit = g.view('se').fx.find((f) => f.kind === 'lance_hit');
    expect(hit).toBeDefined();
    expect(hit?.src).toBeUndefined();
    expect(hit?.tx).toBeUndefined();
    expect(hit?.ty).toBeUndefined();
    expect(g.view('se').fx.some((f) => f.kind === 'lance')).toBe(false);
    expect(g.view('nw').fx.some((f) => f.kind === 'lance_hit')).toBe(false);
  });
});

describe('Aegis', () => {
  it('compiles host Aegis energy, cooldown, radius, duration and shield multiplier', () => {
    const g = arena({ orbit: { aegisEnergy: 9, aegisCooldown: 2, aegisRadius: 1, aegisDuration: 0.25, aegisShieldMultiplier: 2 } }); research(g);
    const e = ship(g, 'bastion', 'nw', 12, 12);
    const ally = ship(g, 'lancer', 'nw', 14, 12);
    e.shield = 30;
    const energy = g.sim.armies[BLUE]!.energy;
    expect(g.sim.activateAegis(e)).toBe(true);
    expect(g.sim.armies[BLUE]!.energy).toBe(energy - 9);
    expect(e.abilityReady).toBe(g.tick + toTicks(2));
    expect(e.aegisUntil).toBe(g.tick + toTicks(0.25));
    expect(e.aegisPool).toBe(60);
    g.sim.damage(ally, 5, RED);
    expect(e.aegisPool).toBe(60);
    ally.x = 13;
    g.sim.damage(ally, 5, RED);
    expect(e.aegisPool).toBe(55);
  });

  it('requires research, energy, current shield and a ready Bastion', () => {
    const g = arena();
    const e = ship(g, 'bastion', 'nw', 12, 12);
    expect(g.sim.activateAegis(e)).toBe(false);
    research(g);
    const wrong = ship(g, 'lancer', 'nw', 14, 12);
    expect(g.sim.activateAegis(wrong)).toBe(false);
    e.shield = 0;
    expect(g.sim.activateAegis(e)).toBe(false);
    e.shield = 40;
    g.sim.armies[BLUE]!.energy = g.sim.econ.aegisEnergy - 1;
    expect(g.sim.activateAegis(e)).toBe(false);
    g.sim.armies[BLUE]!.energy = 100;
    e.vx = 0.1; e.vy = 0.2;
    expect(g.sim.activateAegis(e)).toBe(true);
    expect(g.sim.armies[BLUE]!.energy).toBe(60);
    expect(e.aegisPool).toBe(60);
    expect(e.shield).toBe(40);
    expect(e.vx).toBe(0); expect(e.vy).toBe(0);
    expect(e.abilityReady).toBe(g.tick + toTicks(30));
    expect(g.sim.activateAegis(e)).toBe(false);
    g.sim.giveAlias(RED, e.id); // presented as Red would see it, once it has a name for it
    expect(entityOut(g.sim, e, 'se').aegis).toEqual({ until: e.aegisUntil, pool: 60 });
  });

  it('shares one pool across covered allies and itself, then spills into personal shields and hull', () => {
    const g = arena(); research(g);
    const projector = ship(g, 'bastion', 'nw', 12, 12);
    projector.shield = 100;
    const ally = ship(g, 'lancer', 'nw', 14, 12);
    expect(g.sim.activateAegis(projector)).toBe(true);
    g.sim.damage(ally, 50, RED);
    expect(projector.aegisPool).toBe(100);
    expect(ally.shield).toBe(ally.maxShield);
    g.sim.damage(projector, 40, RED);
    expect(projector.aegisPool).toBe(60);
    expect(projector.shield).toBe(100);
    g.sim.damage(ally, 60 + ally.shield + 10, RED);
    expect(projector.aegisPool).toBe(0);
    expect(projector.aegisUntil).toBe(0);
    expect(ally.shield).toBe(0);
    expect(ally.hp).toBe(ally.maxHp - 10);
  });

  it('covers only nearby allied Orbit ships, follows live positions, and does not intercept shield-bypassing damage', () => {
    const g = arena(); research(g);
    const e = ship(g, 'bastion', 'nw', 12, 12);
    const ally = ship(g, 'lancer', 'nw', 14.5, 12);
    const outside = ship(g, 'lancer', 'nw', 16, 12);
    const enemy = ship(g, 'lancer', 'se', 12, 14);
    const structure = g.sim.add('spire', BLUE, 'orbit', 12, 13);
    const sky = g.sim.add('interceptor', BLUE, 'sky', 12, 12);
    expect(g.sim.activateAegis(e)).toBe(true);
    const pool = e.aegisPool;
    g.sim.damage(ally, 10, RED);
    expect(e.aegisPool).toBe(pool - 10);
    ally.x = 16;
    for (const victim of [ally, outside, enemy, structure, sky]) g.sim.damage(victim, 5, RED);
    expect(e.aegisPool).toBe(pool - 10);
    g.sim.damage(e, 7, RED, true);
    expect(e.aegisPool).toBe(pool - 10);
    expect(e.hp).toBe(e.maxHp - 7);
  });

  it('roots against steering, momentum and contact separation, then resumes its order on timeout', () => {
    const g = arena({ orbit: { maxAsteroids: 0, aegisDuration: 0.5 } }); research(g);
    const e = ship(g, 'bastion', 'nw', 12, 12);
    g.sim.order(e, { k: 'move', x: 20, y: 12, fight: false, speed: 0 });
    e.vx = 0.7;
    expect(g.sim.activateAegis(e)).toBe(true);
    const blocker = ship(g, 'tug', 'nw', 12.1, 12);
    advance(g, toTicks(0.5) - 1);
    expect(e.x).toBe(12); expect(e.y).toBe(12);
    expect(e.vx).toBe(0); expect(e.vy).toBe(0);
    expect(e.order).toMatchObject({ k: 'move', x: 20, y: 12 });
    // Rooting has resisted the overlapping body; clear it before testing order resumption,
    // so collision avoidance is not mistaken for failure to resume forward movement.
    blocker.x = 16; blocker.y = 16;
    g.step();
    expect(e.aegisUntil).toBe(0); expect(e.aegisPool).toBe(0);
    advance(g, toTicks(1));
    expect(e.x).toBeGreaterThan(12);
  });

  it('ends protection on projector death and lets a travelling lance exhaust its shared pool', () => {
    const g = arena(); research(g);
    const shooter = ship(g, 'lancer', 'se', 24, 36);
    const e = ship(g, 'bastion', 'nw', 24, 26);
    const ally = ship(g, 'lancer', 'nw', 24, 25);
    e.shield = 40;
    expect(g.sim.activateAegis(e)).toBe(true);
    expect(g.sim.sunLance(shooter, 24, 22)).toBe(true);
    advance(g, g.sim.econ.lanceCharge + toTicks(1));
    expect(e.aegisPool).toBe(0);
    expect(e.aegisUntil).toBe(0);
    expect(ally.shield).toBeLessThan(ally.maxShield);
    const other = ship(g, 'bastion', 'nw', 30, 30);
    const protectedShip = ship(g, 'lancer', 'nw', 32, 30);
    expect(g.sim.activateAegis(other)).toBe(true);
    g.sim.damage(other, other.hp, RED, true);
    g.sim.damage(protectedShip, 10, RED);
    expect(protectedShip.shield).toBe(protectedShip.maxShield - 10);
  });
});

describe('Night cloak and fog', () => {
  it('uses custom cloak detection and break-delay rules, and repeated damage restarts the deadline', () => {
    const g = arena({ orbit: { cloakDetectRadius: 2, cloakBreakTime: 0.5 } }); research(g);
    const e = ship(g, 'skiff', 'se', 30, 10);
    const detector = ship(g, 'tug', 'nw', 32, 10);
    g.step();
    expect(e.cloaked).toBe(true);
    expect(g.sim.sees(BLUE, e)).toBe(true);
    detector.x += 0.01;
    expect(g.sim.sees(BLUE, e)).toBe(false);
    g.sim.damage(e, 1, BLUE);
    advance(g, 5);
    g.sim.damage(e, 1, BLUE);
    expect(e.cloakReady).toBe(g.tick + 10);
    advance(g, 9);
    expect(e.cloaked).toBe(false);
    g.step();
    expect(e.cloaked).toBe(true);
  });

  it('unlocks both researched abilities through the real Orbit research queue, never before completion', () => {
    const g = arena({ research: { aegisProjectorsTime: 0.1, nightCloakTime: 0.1 } });
    const bastion = ship(g, 'bastion', 'nw', 12, 12);
    const skiff = ship(g, 'skiff', 'nw', 30, 10);
    expect(g.sim.activateAegis(bastion)).toBe(false);
    for (const upgrade of ['aegis_projectors', 'night_cloak'] as const) {
      expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'research', upgrade })).toEqual({ ok: true });
      g.step();
      expect(g.sim.armies[BLUE]!.research.has(upgrade)).toBe(false);
      expect(g.sim.hasAbility(upgrade === 'aegis_projectors' ? bastion : skiff, upgrade === 'aegis_projectors' ? 'aegis' : 'night_cloak')).toBe(false);
      g.step();
      expect(g.sim.armies[BLUE]!.research.has(upgrade)).toBe(true);
    }
    expect(g.sim.activateAegis(bastion)).toBe(true);
    expect(skiff.cloaked).toBe(true);
  });

  it('is automatic only after research, only on Skiffs, and only in darkness', () => {
    const g = arena();
    const e = ship(g, 'skiff', 'se', 30, 10);
    g.step(); expect(e.cloaked).toBe(false);
    research(g);
    const lit = ship(g, 'skiff', 'se', 12, 12);
    const wrong = ship(g, 'lancer', 'se', 32, 10);
    g.step();
    expect(e.cloaked).toBe(true);
    expect(lit.cloaked).toBe(false);
    expect(wrong.cloaked).toBe(false);
    expect(entityOut(g.sim, e, 'se').cloaked).toBe(true);
  });

  it.each(['damage', 'fire', 'light'] as const)('breaks on %s and waits the full four-second delay', (cause) => {
    const g = arena(); research(g);
    const e = ship(g, 'skiff', 'se', 30, 10);
    g.step(); expect(e.cloaked).toBe(true);
    if (cause === 'damage') g.sim.damage(e, 1, BLUE);
    else if (cause === 'light') {
      e.x = e.y = 12; g.step(); e.x = 30; e.y = 10;
    } else {
      const victim = target(g, 'nw', 31, 10);
      e.cd = 0;
      e.heading = Math.PI; // red's canonical frame: its forward arc faces the victim at +x
      g.sim.scan(RED, victim.x, victim.y);
      g.step();
      expect(victim.hp).toBeLessThan(victim.maxHp);
      e.cd = toTicks(1000);
    }
    expect(e.cloaked).toBe(false);
    expect(e.cloakReady).toBe(g.tick + toTicks(4));
    expect(entityOut(g.sim, e, 'se').cloakReady).toBe(e.cloakReady);
    g.sim.giveAlias(BLUE, e.id); // presented as Blue would see it, once it has a name for it
    expect(entityOut(g.sim, e, 'nw').cloakReady).toBeUndefined();
    advance(g, toTicks(4) - 1);
    expect(e.cloaked).toBe(false);
    g.step(); expect(e.cloaked).toBe(true);
  });

  it('does not reveal a cloak merely because its cell is visible; observations and targeted attacks agree', () => {
    // Changing hidden authoritative state must not alter the observer's output.
    const g = arena(); research(g);
    const enemy = ship(g, 'skiff', 'se', 30, 10);
    const observer = ship(g, 'lancer', 'nw', 33, 10);
    const twin = g.clone();
    twin.sim.byId.get(enemy.id)!.hp--;
    advance(g, 2); advance(twin, 2);
    expect(g.view('nw')).toEqual(twin.view('nw'));
    advance(g, 2);
    expect(g.sim.seesCell(BLUE, 'orbit', 10 * g.sim.size + 30)).toBe(true);
    expect(g.sim.sees(BLUE, enemy)).toBe(false);
    expect(g.sim.acquire(observer, 6, false)).toBeUndefined();
    expect(g.view('nw').entities.some((e) => e.id === `e_${g.sim.aliasOf(BLUE, enemy.id)}`)).toBe(false);
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'attack', units: [g.entityId('nw', observer.id)], target: `e_${g.sim.aliasOf(BLUE, enemy.id)}` }).ok).toBe(false);
    observer.x = enemy.x + g.sim.econ.cloakDetectRadius;
    expect(g.sim.sees(BLUE, enemy)).toBe(true);
    g.sim.computeVision();
    expect(g.view('nw').entities.find((e) => e.id === g.entityId('nw', enemy.id))?.cloaked).toBe(true);
    expect(g.apply({ team: 'nw', role: 'orbit' }, { kind: 'attack', units: [g.entityId('nw', observer.id)], target: g.entityId('nw', enemy.id) })).toEqual({ ok: true });
  });

  it('detects through scan only for its active duration without breaking cloak', () => {
    const g = arena(); research(g);
    const e = ship(g, 'skiff', 'se', 30, 10);
    g.step();
    expect(g.sim.sees(BLUE, e)).toBe(false);
    g.sim.scan(BLUE, e.x, e.y);
    expect(g.sim.sees(BLUE, e)).toBe(true);
    expect(e.cloaked).toBe(true);
    advance(g, g.sim.econ.scanTicks + 1);
    expect(e.cloaked).toBe(true);
    expect(g.sim.sees(BLUE, e)).toBe(false);
  });

  it('uses the Bastion PD radius, not ordinary proximity, and ignores dead, unfinished and other-plane detectors', () => {
    const g = arena(); research(g);
    const e = ship(g, 'skiff', 'se', 30, 10);
    const detector = ship(g, 'bastion', 'nw', 33, 10);
    g.step();
    expect(g.sim.sees(BLUE, e)).toBe(true);
    detector.x = e.x + g.sim.stat(detector).range + 0.01;
    expect(g.sim.sees(BLUE, e)).toBe(false);
    detector.x = 33; detector.built = false;
    expect(g.sim.sees(BLUE, e)).toBe(false);
    detector.built = true; detector.plane = 'sky';
    expect(g.sim.sees(BLUE, e)).toBe(false);
    detector.plane = 'orbit'; detector.hp = 0;
    expect(g.sim.sees(BLUE, e)).toBe(false);
  });

  it('uses the live Orbit segment beam reach (from its footprint edge) even when cell vision is shorter', () => {
    const g = arena({ spire: { vision: 3 } }); research(g);
    const home = g.sim.armies[BLUE]!.spire.orbit;
    const e = ship(g, 'skiff', 'se', 37, 10);
    // The beam reaches range + the target's radius beyond the 3×3 footprint edge: stand just inside it.
    const reach = footprint('spire')!.w / 2 + g.sim.stat(home).range + e.radius;
    home.x = e.x - reach + 0.005; home.y = 10;
    g.step();
    expect(e.cloaked).toBe(true);
    expect(g.sim.sees(BLUE, e)).toBe(true);
    expect(g.sim.lineOfFire(home, e)).toBe(true);
    expect(g.sim.acquire(home, g.sim.stat(home).range, true)).toBe(e);
    e.x += 0.01;
    expect(g.sim.sees(BLUE, e)).toBe(false);
    e.x -= 0.01; home.hp = 0;
    expect(g.sim.sees(BLUE, e)).toBe(false);
    home.hp = home.maxHp;
    home.cd = 0;
    g.step();
    expect(e.cloaked).toBe(false);
    expect(e.combatAt).toBe(g.tick);
    expect(g.sim.fx.some(({ fx }) => fx.kind === 'shot' && fx.src === home.id && fx.w === 'beam')).toBe(true);
  });
});

describe('Orbit ability replay and symmetry', () => {
  it.each(['abilityReady', 'lanceAt', 'lanceX', 'lanceY', 'aegisUntil', 'aegisPool', 'cloakReady'] as const)('hashes and clones %s', (field) => {
    const g = arena();
    const e = ship(g, 'lancer', 'nw', 12, 12);
    const copy = g.clone();
    const hash = g.stateHash();
    expect(copy.stateHash()).toBe(hash);
    e[field]++;
    expect(g.stateHash()).not.toBe(hash);
    expect(copy.stateHash()).toBe(hash);
  });

  it('hashes cloak state and every travelling bolt field including already-hit victims', () => {
    const g = arena(); research(g);
    const e = ship(g, 'skiff', 'nw', 30, 10);
    const before = g.stateHash(); e.cloaked = true;
    expect(g.stateHash()).not.toBe(before);
    const shooter = ship(g, 'lancer', 'nw', 12, 12);
    expect(g.sim.sunLance(shooter, 26, 12)).toBe(true);
    advance(g, g.sim.econ.lanceCharge);
    const launched = g.clone();
    expect(launched.stateHash()).toBe(g.stateHash());
    for (const field of ['x', 'y', 'dx', 'dy', 'distance'] as const) {
      const twin = launched.clone();
      twin.sim.lances[0]![field] += 0.125;
      expect(twin.stateHash()).not.toBe(launched.stateHash());
    }
    const twin = launched.clone(); twin.sim.lances[0]!.hit.add(shooter.id);
    expect(twin.stateHash()).not.toBe(launched.stateHash());
    const opposite = launched.clone(); opposite.sim.lances[0]!.by = RED;
    expect(opposite.stateHash()).not.toBe(launched.stateHash());
  });

  it('keeps exact point symmetry and deterministic continuation through charging, piercing, Aegis and cloak breaks', () => {
    const g = arena(); research(g);
    const blue: Ent[] = [];
    const red: Ent[] = [];
    for (const [kind, x, y] of [['lancer', 12, 12], ['bastion', 32, 32], ['lancer', 30.5, 30.5], ['skiff', 30, 10]] as const) {
      blue.push(ship(g, kind, 'nw', x, y));
      red.push(ship(g, kind, 'se', g.sim.size - x, g.sim.size - y));
    }
    for (const fleet of [blue, red]) {
      const sign = fleet[0]!.side === BLUE ? 1 : -1;
      expect(g.sim.sunLance(fleet[0]!, fleet[0]!.x + sign * 14, fleet[0]!.y + sign * 14)).toBe(true);
      expect(g.sim.activateAegis(fleet[1]!)).toBe(true);
    }
    const copy = g.clone();
    for (let tick = 0; tick < toTicks(8); tick++) {
      g.step(); copy.step();
      expect(g.stateHash()).toBe(copy.stateHash());
      for (let i = 0; i < blue.length; i++) {
        const a = blue[i]!; const b = red[i]!;
        expect(a.x + b.x).toBe(g.sim.size); expect(a.y + b.y).toBe(g.sim.size);
        expect(a.hp).toBe(b.hp); expect(a.shield).toBe(b.shield);
        expect(a.lanceAt).toBe(b.lanceAt); expect(a.aegisPool).toBe(b.aegisPool);
        expect(a.cloaked).toBe(b.cloaked); expect(a.cloakReady).toBe(b.cloakReady);
      }
    }
  });
});
