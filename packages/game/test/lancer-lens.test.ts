import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { toTicks, type ArmyId, type MatchOptions, type UnitKind } from '../src/rules/contract.ts';
import type { Ent } from '../src/sim/ent.ts';
import { slotOfArmyId } from '../src/util/teams.ts';

const BLUE = slotOfArmyId('nw', 2), RED = slotOfArmyId('se', 2);
const TEAMS = ['nw', 'se'] as const;
const foeOf = (team: ArmyId): ArmyId => team === 'nw' ? 'se' : 'nw';

/** Open terrain, no rocks or storms, only the Spires (silenced) and rich armies. */
function arena(options: MatchOptions = {}): AgentCommandGame {
  const g = createGame({ seed: 47, options: { terrain: 'open', ...options, orbit: { maxAsteroids: 0, ...options.orbit }, sky: { stormSets: 0, seederDuration: 0, ...options.sky } } });
  for (const e of g.sim.ents) if (e.kind !== 'spire') e.hp = 0;
  g.step();
  for (const e of g.sim.ents) e.cd = e.stationPdCd = toTicks(1000);
  for (const army of [BLUE, RED]) g.sim.armies[army]!.energy = g.sim.armies[army]!.alloy = 10000;
  return g;
}

/** A held, silent unit of `owner`; `x`/`y` are in nw's frame and mirror (point symmetry) when `frame` is se. */
function unit(g: AgentCommandGame, kind: UnitKind, owner: ArmyId, plane: 'orbit' | 'sky', x: number, y: number, frame: ArmyId = owner): Ent {
  const mx = frame === 'nw' ? x : g.sim.size - x, my = frame === 'nw' ? y : g.sim.size - y;
  const e = g.sim.add(kind, slotOfArmyId(owner, 2), plane, mx, my);
  e.stance = 'hold';
  e.cd = toTicks(1000);
  return e;
}

function advance(g: AgentCommandGame, ticks: number): void {
  for (let i = 0; i < ticks; i++) g.step();
}

/** Per team: its Lancer, an enemy interceptor inside Lens reach and an enemy bomber just outside it (both seen). */
function setup(g: AgentCommandGame) {
  const reach = g.sim.econ.lensReach;
  return TEAMS.map((team) => {
    const lancer = unit(g, 'lancer', team, 'orbit', 14, 14);
    lancer.cd = 0;
    const near = unit(g, 'interceptor', foeOf(team), 'sky', 14 + reach + g.sim.stats.interceptor.radius - 0.1, 14, team);
    const far = unit(g, 'bomber', foeOf(team), 'sky', 14, 14 + reach + g.sim.stats.bomber.radius + 0.2, team);
    return { team, lancer, near, far };
  });
}

describe('Lancer Lens', () => {
  it('beams Sky units only after research and only within lensReach, at the damage multiplier, mirrored for both teams', () => {
    const g = arena();
    const sides = setup(g);
    advance(g, toTicks(3));
    for (const { lancer, near, far } of sides) {
      expect(g.sim.canHit(lancer, 'sky')).toBe(false);
      expect(near.hp).toBe(near.maxHp);
      expect(far.hp).toBe(far.maxHp);
    }
    for (const army of [BLUE, RED]) g.sim.completeResearch(army, 'lancer_lens');
    for (let i = 0; i < toTicks(5) && sides.some(({ near }) => near.hp === near.maxHp); i++) g.step();
    const hit = g.sim.stats.lancer.dmg * g.sim.econ.lensDamageMultiplier;
    expect(hit).toBe(14);
    for (const { lancer, near, far } of sides) {
      expect(g.sim.canHit(lancer, 'sky')).toBe(true);
      expect(near.maxHp - near.hp).toBeGreaterThan(0);
      expect((near.maxHp - near.hp) % hit).toBe(0);
      // Damage cause stays the Lancer's beam.
      expect(near.lastHitCause).toBe('lancer');
      expect(near.lastHitPlane).toBe('orbit');
      expect(far.hp).toBe(far.maxHp);
    }
    // Exact C2 symmetry: both teams' Lenses landed the same shots on the same ticks.
    expect(sides[0]!.near.hp).toBe(sides[1]!.near.hp);
  });

  it('sees the Sky column it can hit only once researched', () => {
    const g = arena();
    const sides = setup(g);
    advance(g, toTicks(1));
    for (const { team, near, far } of sides) {
      expect(g.sim.sees(slotOfArmyId(team, 2), near)).toBe(false);
      expect(g.sim.sees(slotOfArmyId(team, 2), far)).toBe(false);
    }
    for (const army of [BLUE, RED]) g.sim.completeResearch(army, 'lancer_lens');
    advance(g, toTicks(0.5));
    for (const { team, near, far } of sides) {
      expect(g.sim.sees(slotOfArmyId(team, 2), near)).toBe(true);
      expect(g.sim.sees(slotOfArmyId(team, 2), far)).toBe(true);
    }
  });

  it('targets Sky units only: never Sky structures or falling payloads, and attack intents agree', () => {
    const g = arena();
    const { lancer, near } = setup(g)[0]!;
    const relay = g.sim.add('relay', RED, 'sky', 14.5, 14);
    g.sim.scan(BLUE, 14, 14);
    advance(g, 1);
    const orbit = { team: 'nw', role: 'orbit' } as const;
    const id = (e: Ent): string => g.entityId('nw', e.id);
    expect(g.apply(orbit, { kind: 'attack', units: [id(lancer)], target: id(near) })).toMatchObject({ ok: false, code: 'invalid_target' });
    g.sim.completeResearch(BLUE, 'lancer_lens');
    expect(g.sim.isTarget(lancer, near)).toBe(true);
    expect(g.sim.isTarget(lancer, relay)).toBe(false);
    expect(g.apply(orbit, { kind: 'attack', units: [id(lancer)], target: id(relay) })).toMatchObject({ ok: false, code: 'invalid_target' });
    expect(g.apply(orbit, { kind: 'attack', units: [id(lancer)], target: id(near) })).toMatchObject({ ok: true });
  });

  it('reveals the research to an enemy that sees a Lens shot, not before', () => {
    const g = arena();
    const { lancer, near } = setup(g)[0]!;
    g.sim.completeResearch(BLUE, 'lancer_lens');
    lancer.cd = toTicks(1000);
    g.sim.scan(RED, 14, 14);
    advance(g, 2);
    const seen = g.sim.armies[RED]!.group.seenResearch[BLUE]!;
    expect(seen.has('lancer_lens')).toBe(false);
    lancer.cd = 0;
    for (let i = 0; i < toTicks(5) && near.hp === near.maxHp; i++) g.step();
    expect(near.hp).toBeLessThan(near.maxHp);
    expect(seen.has('lancer_lens')).toBe(true);
  });

  it('is researched at the Orbit segment through the queue, and a match can switch it off', () => {
    const g = arena({ research: { lancerLensTime: 0.1 } });
    const orbit = { team: 'nw', role: 'orbit' } as const;
    expect(g.sim.researchAvailable(BLUE)).toContain('lancer_lens');
    expect(g.apply(orbit, { kind: 'research', upgrade: 'lancer_lens' })).toMatchObject({ ok: true });
    advance(g, toTicks(1));
    expect(g.sim.armies[BLUE]!.research.has('lancer_lens')).toBe(true);
    const off = arena({ orbit: { lancerLensEnabled: false } });
    expect(off.sim.researchAvailable(BLUE)).not.toContain('lancer_lens');
    expect(off.apply(orbit, { kind: 'research', upgrade: 'lancer_lens' })).toMatchObject({ ok: false });
  });
});

describe('Sun lance vs structures', () => {
  it('deals lanceStructureMultiplier of its first-hit damage to a structure, full to ships, mirrored for both teams', () => {
    const g = arena();
    const shots = TEAMS.map((team) => {
      const lancer = unit(g, 'lancer', team, 'orbit', 12, 12);
      // A hostile structure on the bolt's path (mirrored for se), then a hostile ship behind it.
      const sx = team === 'nw' ? 18 : g.sim.size - 18, sy = team === 'nw' ? 12 : g.sim.size - 12;
      const structure = g.sim.add('spire', slotOfArmyId(foeOf(team), 2), 'orbit', sx, sy);
      structure.cd = structure.stationPdCd = toTicks(1000);
      const ship = unit(g, 'solar', foeOf(team), 'orbit', 21, 12.2, team);
      ship.hp = ship.maxHp = 1000;
      return { lancer, structure, ship, hull: structure.hp, aim: team === 'nw' ? [26, 12] : [g.sim.size - 26, g.sim.size - 12] };
    });
    for (const { lancer, aim } of shots) expect(g.sim.sunLance(lancer, aim[0]!, aim[1]!)).toBe(true);
    advance(g, g.sim.econ.lanceCharge + toTicks(2));
    const { lanceDamage, lancePierceDamage, lanceStructureMultiplier } = g.sim.econ;
    expect(lanceStructureMultiplier).toBe(0.5);
    for (const { structure, ship, hull } of shots) {
      expect(structure.hp).toBe(hull - lanceDamage * lanceStructureMultiplier);
      expect(ship.hp).toBe(1000 - lancePierceDamage);
    }
  });
});
