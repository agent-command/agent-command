/** Match rules (DESIGN §2.1): defaults reproduce the constants exactly, overrides change play and stay mirrored, bounds. */
import { describe, expect, it } from 'vitest';
import { validate, type ObjS } from 'playerthree/schema';
import {
  DEFAULT_RULES,
  ECON,
  SPIRE_HP,
  STATS,
  TICK_RATE,
  checkRules,
  compileRules,
  matchOptionsSchema,
  matchDataSchema,
  hashRules,
  observationSchema,
  resolveRules,
  rulesOptions,
  rulesSchema,
  toTicks,
  type MatchOptions,
  type Rules,
} from '../src/rules/contract.ts';
import { createGame } from '../src/agent/adapter.ts';
import { resolveRocks } from '../src/rules/payload.ts';
import { playBotMatch } from '../src/bots/play.ts';
import { sunSpeedOf } from '../src/rules/sun.ts';
import { orbitAsymmetry } from './mirror.ts';

function hashes(options: MatchOptions | undefined, ticks: number): string[] {
  const out: string[] = [];
  playBotMatch({ seed: 7, levels: { nw: 'veteran', se: 'standard' }, maxTicks: ticks, ...(options ? { options } : {}), onTick: (g) => g.tick % 100 === 0 && out.push(g.stateHash()) });
  return out;
}

describe('default rules', () => {
  it('compile to exactly the default constants (ECON, STATS, SPIRE_HP, time cap, sun)', () => {
    expect(validate(rulesSchema, DEFAULT_RULES).ok).toBe(true);
    const tables = compileRules(DEFAULT_RULES);
    expect(tables.econ).toEqual(ECON);
    expect(tables.stats).toEqual(STATS);
    expect(tables.spireHp).toEqual(SPIRE_HP);
    expect(tables.timeCap).toBe(30 * 60 * TICK_RATE);
    expect(tables.sunSpeed).toBe(sunSpeedOf(ECON.sunPeriodTicks, 2));
    expect(resolveRules({})).toEqual(DEFAULT_RULES);
    expect(Object.isFrozen(DEFAULT_RULES.stats.tank)).toBe(true);
  });

  it('shifts replacement alloy into energy without changing build/combat stats or explicit overrides', () => {
    expect(STATS.skiff).toMatchObject({ alloy: 40, energy: 25, build: toTicks(4), hp: 65, dmg: 8 });
    expect(STATS.lancer).toMatchObject({ alloy: 120, energy: 115, build: toTicks(12), hp: 240, dmg: 28 });
    expect(STATS.interceptor).toMatchObject({ alloy: 55, energy: 55, build: toTicks(6), hp: 120, dmg: 12 });
    expect(STATS.digger).toMatchObject({ alloy: 50, energy: 0, build: toTicks(5) });
    expect(STATS.tank).toMatchObject({ alloy: 90, energy: 30, build: toTicks(9) });
    const stats = { skiff: { alloy: 45, energy: 20 }, lancer: { alloy: 140, energy: 100 }, interceptor: { alloy: 60, energy: 50 } };
    const tables = compileRules(resolveRules({ stats }));
    for (const kind of ['skiff', 'lancer', 'interceptor'] as const) expect(tables.stats[kind]).toMatchObject(stats[kind]);
  });

  it('preserves zero-vision artillery through rules, compiled stats and outbound match bootstrap', () => {
    const g = createGame({ seed: 7 });
    expect(DEFAULT_RULES.stats.island_mortar.vision).toBe(0);
    expect(validate(rulesSchema, DEFAULT_RULES).ok).toBe(true);
    expect(g.sim.stats.island_mortar.vision).toBe(0);
    expect(g.sim.stats.island_mortar.capabilities.spotterDown).toBe(false);
    const data = g.matchData({ team: 'nw', role: 'surface' });
    expect(data.rules.stats.island_mortar.vision).toBe(0);
    expect(validate(matchDataSchema, data).ok).toBe(true);
    for (const kind of ['island_mortar', 'trooper', 'mooring_tower'] as const) {
      expect(checkRules({ stats: { [kind]: { vision: 0 } } }).ok).toBe(true);
      expect(checkRules({ stats: { [kind]: { vision: -0.1 } } }).ok).toBe(false);
      expect(checkRules({ stats: { [kind]: { vision: 16.1 } } }).ok).toBe(false);
    }
  });

  it('compiles resource-specific mining yields and independent volatile drops for every size', () => {
    expect(DEFAULT_RULES.orbit).toMatchObject({ metalChance: 0.45, iceChance: 0.30, volatileChance: 0.1, iceEnergyShare: 0.8, tugMineRate: 2, tugHold: 50, tugMineReach: 3 });
    for (const rock of Object.values(resolveRocks(ECON))) {
      expect(rock.dockYield).toEqual({ metal: { alloy: rock.dock, energy: 0 }, ice: { alloy: 0, energy: rock.dock * 0.8 }, slag: { alloy: 0, energy: 0 } });
      expect(rock.mineHpPerUnit.metal * rock.dockYield.metal.alloy).toBeCloseTo(rock.hp);
      expect(rock.mineHpPerUnit.ice * rock.dockYield.ice.energy).toBeCloseTo(rock.hp);
      expect(rock.mineHpPerUnit.slag).toBe(0);
      expect(rock.drops.metal.oreValue).toBe(rock.dock * ECON.oreCacheMultiplier);
      expect(rock.drops.ice.oreValue).toBeUndefined();
      expect(rock.drops.slag.oreValue).toBeUndefined();
      for (const drop of Object.values(rock.volatileDrops)) {
        expect(drop.oreValue).toBeUndefined();
        expect(drop.impact.damage).toBe(rock.drops.slag.impact.damage * ECON.volatileDamageMultiplier);
        expect(drop.scorch).toBe(ECON.scorchTicks);
      }
    }
    const empty = resolveRocks({ ...ECON, dockValue: 0, iceEnergyShare: 0 });
    expect(empty.medium.mineHpPerUnit).toEqual({ metal: 0, ice: 0, slag: 0 });
    expect(empty.pebble.mineHpPerUnit.ice).toBe(0);
  });

  it('cover every ECON entry: a rule set with every scalar at its bound changes every entry', () => {
    const groups = ['economy', 'depths', 'surface', 'sky', 'orbit', 'queue', 'movement', 'combat', 'research', 'ascent', 'signals'] as const;
    const fields = matchOptionsSchema.fields as unknown as Record<string, { item: ObjS }>;
    const options: Record<string, Record<string, number | boolean>> = {};
    for (const g of groups) {
      options[g] = {};
      for (const [k, s] of Object.entries(fields[g]!.item.fields as Record<string, { item: { t: string; min: number; max: number } }>)) {
        const value = (DEFAULT_RULES[g] as Record<string, number | boolean>)[k]!;
        // On/off rules flip; numbers go to the bound they do not sit on.
        options[g]![k] = s.item.t === 'bool' ? !value : value === s.item.max ? s.item.min : s.item.max;
      }
    }
    // The Spire's ECON-backed scalars (impacts, sudden death, crowns, rebuild, threat alert) sit beside its hp and beam overrides.
    const spire = (fields.spire!.item.fields as Record<string, { item: { t: string; min: number; max: number } }>);
    options.spire = {};
    for (const k of ['impactMultiplier', 'suddenDeathAt', 'suddenDeathWarning', 'suddenDeathDamage', 'crownsSurface', 'crownsSide', 'crownsToLose',
      'rebuilds', 'rebuildAlloy', 'rebuildEnergy', 'rebuildTime', 'rebuildClearance', 'rebuildHp', 'threatHp', 'threatWindow'] as const) {
      const value = DEFAULT_RULES.spire[k];
      options.spire[k] = value === spire[k]!.item.max ? spire[k]!.item.min : spire[k]!.item.max;
    }
    const econ = compileRules(resolveRules(options as MatchOptions)).econ;
    for (const k of Object.keys(ECON) as (keyof typeof ECON)[]) expect(econ[k], k).not.toBe(ECON[k]);
  });

  it('spelled out in full play exactly like no options', () => {
    expect(hashes(rulesOptions(DEFAULT_RULES), 1500)).toEqual(hashes(undefined, 1500));
  }, 60_000);
});

describe('overrides', () => {
  const custom: MatchOptions = {
    terrain: 'open',
    map: { params: { islandRings: 2, magmaPockets: 0, faultSets: 1, centralFault: 0, cavernChambers: 4 } },
    economy: { startAlloy: 900, oreLoad: 15 },
    depths: { digRockTime: 0.5, digOreTime: 1 },
    stats: { trooper: { alloy: 30, build: 2 }, tank: { hp: 400 } },
    spire: { hp: { surface: 9000 }, timeCap: 600 },
    orbit: { asteroidSpawnPeriod: 3 },
  };

  it('reach the world, the sim, observations and snapshot views', () => {
    const g = createGame({ seed: 5, options: custom });
    const s = g.sim;
    expect(s.armies[0]!.alloy).toBe(900);
    expect(s.econ.digRock).toBe(toTicks(0.5));
    expect(s.stats.trooper.build).toBe(toTicks(2));
    expect(s.armies[1]!.spire.surface.maxHp).toBe(9000);
    expect(s.ents.filter((e) => e.kind === 'island')).toHaveLength(4);
    expect(s.faults).toHaveLength(2);
    expect([...s.magma].every((v) => v === 0)).toBe(true);
    for (let c = 0; c < s.cells.length; c++) expect(s.cells[c]).toBe(s.cells[s.cells.length - 1 - c]);
    const seat = { team: 'se', role: 'depths' } as const;
    const obs = g.observe(seat, 0);
    const data = g.matchData(seat);
    expect(validate(observationSchema, obs).ok).toBe(true);
    expect(data.rules.economy.startAlloy).toBe(900);
    expect(data.rules.economy.startEnergy).toBe(DEFAULT_RULES.economy.startEnergy);
    expect(data.rules.stats.trooper).toEqual({ ...DEFAULT_RULES.stats.trooper, alloy: 30, build: 2 });
    expect(toTicks(data.rules.spire.timeCap)).toBe(toTicks(600));
    expect(g.view('nw', { snapshot: true }).match).toEqual(data);
    // Built-in bots and intents charge the match's prices.
    expect(g.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: true });
    g.step();
    expect(s.armies[0]!.alloy).toBeLessThanOrEqual(900 - 30 + 1);
    expect(s.armies[0]!.alloy).toBeGreaterThan(900 - 40);
  });

  it('change how a match plays, deterministically and exactly mirrored', () => {
    const custom7 = hashes(custom, 1500);
    expect(custom7).not.toEqual(hashes({ terrain: 'open' }, 1500));
    expect(hashes(custom, 1500)).toEqual(custom7);
    let first: string | undefined;
    const { game } = playBotMatch({ seed: 7, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: toTicks(120), options: custom, onTick: (g) => (first ??= orbitAsymmetry(g.sim)) });
    expect(first).toBeUndefined();
    expect(game.sim.stats.tank.hp).toBe(400);
  }, 60_000);

  it('end the match at the rules time cap', () => {
    const { ticks } = playBotMatch({ seed: 3, levels: { nw: 'idle', se: 'idle' }, options: { spire: { timeCap: 60 } } });
    expect(ticks).toBe(toTicks(60));
  });
});

describe('immutable match bootstrap', () => {
  const seat = { team: 'nw', role: 'depths' } as const;

  it('keeps tick payloads dynamic and provides public match data on demand', () => {
    const g = createGame({ seed: 7 });
    const obs = g.observe(seat, 0);
    expect(validate(observationSchema, obs).ok).toBe(true);
    for (const key of ['rules', 'terrain', 'faults', 'preset', 'spireAt', 'match']) expect(obs).not.toHaveProperty(key);
    expect(obs.sun).toEqual({ angle: g.sim.sunAngle });
    expect(obs.weather).not.toHaveProperty('jets');
    for (const fog of obs.weather.fog) expect(fog).not.toHaveProperty('path');
    expect(obs.schedule.every((entry) => entry.kind !== ('time_cap' as string))).toBe(true);
    const data = g.matchData(seat);
    expect(validate(matchDataSchema, data).ok).toBe(true);
    expect(validate(observationSchema, { ...obs, match: data }).ok).toBe(false);
    expect(validate(observationSchema, { ...obs, rules: data.rules }).ok).toBe(false);
    expect(data.rulesHash).toBe(obs.rulesHash);
    for (const key of ['seed', 'params', 'name', 'document']) expect(data.rules.map).not.toHaveProperty(key);
    expect(data.rules).not.toHaveProperty('eventSeed');
    expect(data.rules.map.size).toBe(g.sim.size);
    expect(data).not.toHaveProperty('depths');
    expect(data).not.toHaveProperty('lodes');
    expect(data).not.toHaveProperty('entities');
    expect(g.matchData({ team: 'se', role: 'surface' })).toEqual(data);
  });

  it('does not let any bootstrap recipient mutate the authoritative state or another recipient', () => {
    const g = createGame({ seed: 7 });
    const before = g.stateHash();
    const data = g.matchData(seat);
    const expected = structuredClone(data);
    data.rules.economy.startAlloy++;
    data.terrain[0] = 0;
    data.armies[0]!.spireAt.x++;
    if (data.faults[0]?.cells[0]) data.faults[0].cells[0].x++;
    if (data.jets[0]) data.jets[0].width++;
    if (data.fogPaths[0]) data.fogPaths[0].cx++;
    expect(g.stateHash()).toBe(before);
    expect(g.matchData(seat)).toEqual(expected);
  });

  it('uses a stable short rules identity independent of seed, time, options ordering and observation history', () => {
    const a = createGame({ seed: 7, options: { economy: { startAlloy: 900, oreLoad: 15 } } });
    const b = createGame({ seed: 8, options: { economy: { oreLoad: 15, startAlloy: 900 } } });
    const hash = a.observe(seat, 0).rulesHash;
    expect(hash).toBe(b.observe(seat, 0).rulesHash);
    expect(hash).toBe(hashRules(a.sim.rules));
    expect(hash).not.toBe(createGame({ seed: 7 }).observe(seat, 0).rulesHash);
    a.view('nw');
    a.matchData(seat);
    a.step();
    expect(a.observe(seat, 0).rulesHash).toBe(hash);
    expect(a.clone().observe(seat, 0).rulesHash).toBe(hash);
  });

  it('bootstraps first broadcasts and reconnect snapshots without consuming each other or another team', () => {
    const g = createGame({ seed: 7 });
    expect(g.view('nw', { snapshot: true }).match).toBeDefined();
    expect(g.view('nw').match).toBeDefined();
    expect(g.view('nw').match).toBeUndefined();
    expect(g.view('se').match).toBeDefined();
    expect(g.view('nw', { snapshot: true }).match).toBeDefined();
    expect(g.view('nw').match).toBeUndefined();
    expect(g.clone().view('nw').match).toBeUndefined();
  });
});

describe('bounds', () => {
  it('bounds the resource mix without coupling independent volatility', () => {
    expect(checkRules({ orbit: { metalChance: 0.7, iceChance: 0.4 } })).toEqual({ ok: false, error: 'rules.orbit.iceChance: metalChance + iceChance must be ≤ 1' });
    expect(checkRules({ orbit: { metalChance: 0.8 } }).ok).toBe(false);
    expect(checkRules({ orbit: { metalChance: 0.7, iceChance: 0.3, volatileChance: 1 } }).ok).toBe(true);
    expect(checkRules({ orbit: { metalChance: 0, iceChance: 0, volatileChance: 1 } }).ok).toBe(true);
    expect(checkRules({ orbit: { volatileChance: 1.1 } }).ok).toBe(false);
    expect(checkRules({ orbit: { oreChanceRim: 0 } }).ok).toBe(false);
    expect(checkRules({ orbit: { oreChanceCentre: 0 } }).ok).toBe(false);
    expect(checkRules({ orbit: { tugMineRate: 0 } }).ok).toBe(false);
    expect(checkRules({ orbit: { tugHold: 0 } }).ok).toBe(false);
    expect(checkRules({ orbit: { tugMineReach: 0 } }).ok).toBe(false);
    expect(checkRules({ orbit: { tugMineReach: 9 } }).ok).toBe(false);
  });

  it('rejects ambiguous selectors, unknown names and any public event seed', () => {
    for (const map of [
      { name: 'crossfire', seed: 1 },
      { name: 'crossfire', params: { size: 48 } },
      { document: {}, seed: 1 },
      { name: 'not-a-registered-map' },
    ]) expect(checkRules({ map }).ok).toBe(false);
    // Events derive from the secret match seed; there is no rule to make them public.
    expect(checkRules({ eventSeed: 1 }).ok).toBe(false);
  });

  it('reject out-of-bounds, mistyped and unknown rules with the field and its bounds', () => {
    expect(checkRules({ depths: { digRockTime: 0 } })).toEqual({ ok: false, error: 'rules.depths.digRockTime: must be a number from 0.05 to 120' });
    expect(checkRules({ economy: { startAlloy: 1.5 } })).toEqual({ ok: false, error: 'rules.economy.startAlloy: must be an integer from 0 to 100000' });
    expect(checkRules({ map: { params: { islandRings: 9 } } })).toEqual({ ok: false, error: 'rules.map.params.islandRings: must be an integer from 0 to 8' });
    expect(checkRules({ terrain: 'moon' })).toEqual({ ok: false, error: 'rules.terrain: must be one of open, ridges, canyons, chokepoint, archipelago, fortress, rivers, highlands' });
    expect(checkRules({ map: { params: { caverns: 'yes' } } })).toEqual({ ok: false, error: 'rules.map.params.caverns: must be true or false' });
    expect(checkRules({ stats: { sapper: { dmg: 5 } } })).toMatchObject({ ok: false, error: expect.stringMatching(/^rules\.stats\.sapper: unknown field \(allowed: hp, alloy, energy, build, vision, speed\)$/) });
    expect(checkRules('fast')).toEqual({ ok: false, error: 'rules: must be an object' });
    expect(checkRules({ spire: { timeCap: 59 } }).ok).toBe(false);
    expect(checkRules({ spire: { hp: { surface: 1 } }, orbit: { scanRadius: 16 } }).ok).toBe(true);
    expect(() => createGame({ seed: 1, options: { economy: { oreLoad: 0 } } as MatchOptions })).toThrow('invalid match rules: rules.economy.oreLoad: must be an integer from 1 to 100');
  });

  it('keep the deorbit range beyond the Spire beam reach to a tug on its diagonal, naming both fields', () => {
    const error = 'rules.orbit.deorbitRange: must be > rules.spire.range + Spire half-diagonal 2.12 + tug radius 0.5 (10.62), so tugs can release outside the Orbit segment beam';
    expect(checkRules({ spire: { range: 8 } })).toEqual({ ok: false, error });
    // Past the axis reach (7 + 1.5 + 0.5) is not enough: the beam reaches from the footprint edge, 9.62 on the diagonal.
    expect(checkRules({ orbit: { deorbitRange: 9.5 } })).toMatchObject({ ok: false, error: expect.stringMatching(/rules\.orbit\.deorbitRange.*rules\.spire\.range/) });
    expect(checkRules({ orbit: { deorbitRange: 9.7 } }).ok).toBe(true);
    expect(checkRules({ spire: { range: 8 }, orbit: { deorbitRange: 10.7 } }).ok).toBe(true);
    expect(checkRules({ spire: { range: 12 }, orbit: { deorbitRange: 14.5 } }).ok).toBe(false);
  });

  it('every default sits inside its bounds', () => {
    const options = rulesOptions(DEFAULT_RULES);
    expect(checkRules(options)).toEqual({ ok: true, options });
  });
});
