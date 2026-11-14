/**
 * Per-army income handicap (rules.handicap.income, DESIGN §2.1): a public, bounded rule that scales every income credit
 * of one army exactly, leaves the default match unchanged and keeps equal handicaps an exact mirror (the quick lane's
 * handicapped duel covers the bot mirror).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import {
  ARMIES, checkRules, DEFAULT_RULES, HANDICAP_INCOME_MAX, HANDICAP_INCOME_MIN, NO_HANDICAP, RULE_FIELDS, TICK_RATE, resolveRules, type MatchOptions,
} from '../src/rules/contract.ts';
import { ACCOUNT_INCOME } from '../src/sim/constants.ts';
import { cellCentreX, cellCentreY } from '../src/util/grid.ts';
import { NEUTRAL } from '../src/util/teams.ts';

const BLUE = 0, RED = 1;
/** Distinct per army, so a credit scaled by the wrong army's multiplier shows. */
const NW = 1.3, SE = 1.15;
const QUIET: MatchOptions = { terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0, stationPdDamage: 0, derelictRadiation: 0 } };
type Credit = [army: number, alloy: number, energy: number, role: string | undefined];

/** A quiet match whose every income ledger entry is recorded (the ledger is observational: recording changes nothing). */
function recorded(handicap?: MatchOptions['handicap']): { g: AgentCommandGame; credits: Credit[] } {
  const g = createGame({ seed: 7, options: { ...QUIET, ...(handicap ? { handicap } : {}) } });
  const credits: Credit[] = [];
  const account = g.sim.account;
  g.sim.account = function (army, offset, alloy, energy, role) {
    if (offset === ACCOUNT_INCOME) credits.push([army, alloy, energy, role]);
    account.call(this, army, offset, alloy, energy, role);
  };
  return { g, credits };
}

/** Every income source, set up identically for both armies' twins of a match (fresh units, no spending). */
const SOURCES: Record<string, { setup(g: AgentCommandGame): void; ticks(g: AgentCommandGame): number; credit(g: AgentCommandGame): Credit }> = {
  'Spire trickle': { setup() {}, ticks: () => 3, credit: (g) => [BLUE, g.sim.econ.spireAlloyRate / TICK_RATE, 0, undefined] },
  'energy delivery (geothermal tap)': {
    setup(g) { for (const army of [BLUE, RED]) g.sim.add('geothermal', army, 'depths', 4.5, 4.5).built = true; },
    ticks: () => 3, credit: (g) => [BLUE, 0, g.sim.econ.geothermalHealthyRate / TICK_RATE, undefined],
  },
  'digger delivery (ore and lode cargo)': {
    setup(g) {
      const s = g.sim;
      const drop = s.armies[BLUE]!.drop.indexOf(1);
      const d = s.add('digger', BLUE, 'depths', cellCentreX(drop, s.size), cellCentreY(drop, s.size));
      d.carry = 20; d.lodeCarry = 10;
      expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'mine', units: [g.entityId('nw', d.id)] })).toEqual({ ok: true });
    },
    ticks: () => 3, credit: () => [BLUE, 20, 0, 'depths'],
  },
  'Headframe lode trickle': {
    setup(g) {
      const s = g.sim, lode = s.lodes.find((l) => l.left > 0)!;
      s.add('headframe', BLUE, 'surface', cellCentreX(lode.c, s.size), cellCentreY(lode.c, s.size)).built = true;
    },
    ticks: () => 3, credit: (g) => [BLUE, g.sim.econ.headframeRate / TICK_RATE, 0, undefined],
  },
  'tug cargo unload': {
    setup(g) {
      const seg = g.sim.armies[BLUE]!.spire.orbit;
      const tug = g.sim.add('tug', BLUE, 'orbit', seg.x + 1, seg.y);
      tug.cargoAlloy = 5; tug.cargoEnergy = 3;
    },
    ticks: () => 2, credit: () => [BLUE, 5, 3, 'orbit'],
  },
  'towed asteroid docked': {
    setup(g) {
      const s = g.sim, seg = s.armies[BLUE]!.spire.orbit;
      const tug = s.add('tug', BLUE, 'orbit', seg.x + 1, seg.y);
      const rock = s.add('asteroid', NEUTRAL, 'orbit', seg.x + 1, seg.y);
      rock.resourceType = 'ice'; rock.resourceRemaining = 7;
      rock.state = 'towed'; rock.link = tug.id; tug.link = rock.id;
    },
    ticks: () => 2, credit: () => [BLUE, 0, 7, 'orbit'],
  },
  'ore cache collected': {
    setup(g) {
      const s = g.sim, spire = s.spireAt[BLUE]!;
      const cache = s.createOreCache(s.nextId++, BLUE, spire.x + 4.5, spire.y + 4.5, s.econ.oreCacheLoad);
      s.add('trooper', BLUE, 'surface', cache.x, cache.y).stance = 'hold';
    },
    ticks: (g) => g.sim.econ.oreCacheTicks + 2, credit: (g) => [BLUE, g.sim.econ.oreCacheLoad, 0, 'surface'],
  },
  'derelict core cashed': {
    setup(g) {
      const s = g.sim, seg = s.armies[BLUE]!.spire.orbit, core = s.derelictCore()!;
      const tug = s.add('tug', BLUE, 'orbit', seg.x + 2, seg.y);
      tug.link = core.id; core.link = tug.id; core.state = 'towed';
    },
    ticks: () => 2, credit: (g) => [BLUE, g.sim.econ.coreRewardAlloy, g.sim.econ.coreRewardEnergy, 'orbit'],
  },
};

describe('income handicap rule', () => {
  it('defaults to no handicap for every corner and is a closed, public, bounded rule', () => {
    for (const army of ARMIES) expect(DEFAULT_RULES.handicap.income[army]).toBe(NO_HANDICAP);
    expect(checkRules({ handicap: { income: { se: HANDICAP_INCOME_MIN } } }).ok).toBe(true);
    expect(checkRules({ handicap: { income: { se: HANDICAP_INCOME_MAX } } }).ok).toBe(true);
    expect(checkRules({ handicap: { income: { se: HANDICAP_INCOME_MAX + 0.01 } } })).toEqual({ ok: false, error: `rules.handicap.income.se: must be a number from ${HANDICAP_INCOME_MIN} to ${HANDICAP_INCOME_MAX}` });
    expect(checkRules({ handicap: { income: { nw: HANDICAP_INCOME_MIN - 0.01 } } }).ok).toBe(false);
    expect(checkRules({ handicap: { income: { centre: 1 } } }).ok).toBe(false);
    expect(RULE_FIELDS.find((field) => field.path.join('.') === 'handicap.income.se')).toMatchObject({ group: 'economy', label: 'SE income', unit: '×', min: HANDICAP_INCOME_MIN, max: HANDICAP_INCOME_MAX });
    // Both armies read every army's handicap in their match data.
    const g = createGame({ seed: 7, options: { handicap: { income: { se: SE } } } });
    for (const team of ['nw', 'se'] as const) expect(g.matchData({ team, role: 'surface' }).rules.handicap.income).toEqual({ nw: 1, ne: 1, se: SE, sw: 1 });
    expect(resolveRules({ handicap: { income: { se: SE } } }).handicap.income).toEqual({ nw: 1, ne: 1, se: SE, sw: 1 });
  });

  it('leaves the default match unchanged: explicit 1 everywhere plays the same states as no handicap', () => {
    const plain = createGame({ seed: 3, options: { terrain: 'ridges' } });
    const ones = createGame({ seed: 3, options: { terrain: 'ridges', handicap: { income: { nw: 1, ne: 1, se: 1, sw: 1 } } } });
    expect(ones.sim.rulesHash).toBe(plain.sim.rulesHash);
    for (let tick = 0; tick < 30 * TICK_RATE; tick++) {
      plain.step(); ones.step();
      if (tick % 100 === 0) expect(ones.stateHash()).toBe(plain.stateHash());
    }
    expect(ones.stateHash()).toBe(plain.stateHash());
  });

  it('has no income credit outside earn: every other stock increase is a ledgered refund', () => {
    const dirs = ['sim', 'planes'].map((dir) => new URL(`../src/${dir}/`, import.meta.url));
    const sites: string[] = [];
    for (const dir of dirs) for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const lines = readFileSync(new URL(file, dir), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const income = line.includes('ACCOUNT_INCOME') && !/^import|^\s+ACCOUNT_INCOME,$|export (const|type)/.test(line);
        const unledgered = /\.(alloy|energy) \+= /.test(line) && !lines.slice(i, i + 4).some((next) => next.includes('ACCOUNT_REFUND'));
        if (income || unledgered) sites.push(`${file}: ${line.trim()}`);
      });
    }
    // The stock increases and the income ledger entry of `earn` itself.
    expect(sites).toEqual([
      'economy.ts: t.alloy += alloy * k;',
      'economy.ts: t.energy += energy * k;',
      'economy.ts: this.account(army, ACCOUNT_INCOME, alloy * k, energy * k, role);',
    ]);
  });

  for (const [name, source] of Object.entries(SOURCES)) {
    it(`scales ${name} exactly by each army's own multiplier`, () => {
      const plain = recorded();
      const handicapped = recorded({ income: { nw: NW, se: SE } });
      for (const run of [plain, handicapped]) {
        source.setup(run.g);
        for (let tick = 0, ticks = source.ticks(run.g); tick < ticks; tick++) run.g.step();
      }
      // The source fired, and every credit of the handicapped twin is the plain credit times its army's multiplier.
      expect(plain.credits).toContainEqual(source.credit(plain.g));
      const scale = [NW, SE];
      expect(handicapped.credits).toEqual(plain.credits.map(([army, alloy, energy, role]) => [army, alloy * scale[army]!, energy * scale[army]!, role]));
      const stock = (g: AgentCommandGame) => g.sim.armies.map((t) => [t.alloy, t.energy]);
      const [blue] = stock(handicapped.g), [plainBlue] = stock(plain.g);
      expect(blue![0]! - DEFAULT_RULES.economy.startAlloy).toBeCloseTo((plainBlue![0]! - DEFAULT_RULES.economy.startAlloy) * NW, 9);
    });
  }
});
