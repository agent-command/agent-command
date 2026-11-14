import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { CELL, DEFAULT_RULES, MAP_SIZES, PLANES, STATS, SURFACE, TERRAIN_PRESETS, isSurfaceHigh, surfaceFeature, packTerrain, spirePositions, toTicks, unpackTerrain, type ArmyId, type MatchData, type MatchOptions, type Observation, type Opponent, type Plane, type UnitKind } from '../src/rules/contract.ts';
import { createGame, type AgentCommandGame } from '../src/agent/adapter.ts';
import { createBot } from '../src/bots/bots.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { cellOf } from '../src/util/grid.ts';
import { sampleStorm, type NaturalStorm, type StormSample } from '../src/planes/weather.ts';
import { BOT_PERIOD, playBotMatch } from '../src/bots/play.ts';
import { orbitAsymmetry } from './mirror.ts';
import { STARTER_POLICIES, starterScript } from './starter-policies.ts';
import { Ctx, chooseFocus } from '../src/bots/context.ts';
import { BOMBER_SPARE_ENERGY, FLAK_DROP_RADIUS, TIERS } from '../src/bots/tuning.ts';
import { rotX, rotY } from '../src/util/teams.ts';

/** A duel's armies: army 0 on the NW slot, army 1 on the SE slot (its point mirror). */
const DUEL = ['nw', 'se'] as const;
/** The sim army index of a duel army. */
const armyOf = (id: ArmyId): number => DUEL.indexOf(id as (typeof DUEL)[number]);
/** The other army of a duel. */
const opponentOf = (id: ArmyId): ArmyId => (id === 'nw' ? 'se' : 'nw');

describe('FFA focus (four_corners)', () => {
  const FFA = ['nw', 'ne', 'se', 'sw'] as const;
  const game = () => createGame({ seed: 3, options: { map: { name: 'four_corners' } } });
  const ctx = (g: AgentCommandGame, army: ArmyId) => {
    const seat = { team: army, role: 'surface' } as const;
    const data = g.matchData(seat);
    return new Ctx(g.observe(seat, 0), data, unpackTerrain(data.terrain, data.rules.map.size));
  };

  it('picks the nearer neighbour clockwise for every army, then the lower last-known Spire HP, and veterans avoid the leader', () => {
    const g = game();
    FFA.forEach((army, i) => expect(chooseFocus(ctx(g, army), new Map(), 0)?.id, army).toBe(FFA[(i + 1) & 3]));
    const c = ctx(g, 'nw');
    expect(chooseFocus(c, new Map([['sw', { surface: 1 }]]), 0)?.id).toBe('sw');
    // The far corner is never chosen over a neighbour by HP alone: distance comes first.
    expect(chooseFocus(c, new Map([['se', { surface: 1 }]]), 0)?.id).toBe('ne');
    // A visible ne army makes ne the strongest: a veteran's leader penalty turns it to sw, the standard rule does not.
    const ne = g.sim.armyIndex('ne');
    const home = c.match.armies.find((a) => a.id === 'nw')!.spireAt;
    for (let i = 0; i < 4; i++) g.sim.add('tank', ne, 'surface', home.x + 6, home.y + 6 + i);
    g.sim.computeVision(); // nw sights (and so names) them
    const seen = ctx(g, 'nw');
    expect(chooseFocus(seen, new Map(), 0)?.id).toBe('ne');
    expect(chooseFocus(seen, new Map(), 0.5)?.id).toBe('sw');
  });

  it('re-focuses when the focus is eliminated, and every army attacks its own clockwise neighbour', () => {
    const g = game();
    const size = g.sim.size;
    const attackTarget = (army: ArmyId): { x: number; y: number } => {
      const seat = { team: army, role: 'surface' } as const;
      const bot = initializedBot(army, 'surface', 'standard', g.matchData(seat));
      for (let i = 0; i < 30; i++) g.sim.spawnUnit(g.sim.armyIndex(army), 'trooper', 'surface');
      g.setSeatInfo(seat, { controller: 'bot', mandate: { autonomy: 'autonomous', directive: { stance: 'attack' }, whenAbsent: 'bot' } });
      const move = bot.think(g.observe(seat, 0)).find((i) => i.kind === 'move' && i.mode === 'fight' && i.units.length > 1);
      if (move?.kind !== 'move') throw new Error(`${army}: expected an attack move`);
      return { x: move.x, y: move.y };
    };
    const spire = (id: ArmyId) => g.matchData({ team: id, role: 'surface' }).armies.find((a) => a.id === id)!.spireAt;
    const targets = FFA.map(attackTarget);
    // Exactly rotated orders: army k marches on army k+1's Spire, each through its own routing.
    targets.forEach((t, k) => {
      const n = spire(FFA[(k + 1) & 3]!);
      expect(Math.hypot(t.x - n.x, t.y - n.y), FFA[k]).toBeLessThan(4);
      expect(t, FFA[k]).toEqual({ x: rotX(k, targets[0]!.x, targets[0]!.y, size), y: rotY(k, targets[0]!.x, targets[0]!.y, size) });
    });
    g.sim.forfeit(g.sim.armyIndex('ne'));
    g.step();
    expect(g.observe({ team: 'nw', role: 'surface' }, 0).eliminated).toEqual(['ne']);
    const next = chooseFocus(ctx(g, 'nw'), new Map(), 0)!;
    expect(next.id).toBe('sw');
  });

  it('defends home against any hostile army, not just the focus, with rotated orders', () => {
    const g = game();
    const size = g.sim.size;
    const orders = FFA.map((army, k) => {
      const seat = { team: army, role: 'surface' } as const;
      const data = g.matchData(seat);
      const home = data.armies.find((a) => a.id === army)!.spireAt;
      // The counter-clockwise neighbour (not the focus) walks in, 7 tiles out along the army's own diagonal.
      const intruder = FFA[(k + 3) & 3]!;
      const at = { x: home.x + rotX(k, 7, 7, 0), y: home.y + rotY(k, 7, 7, 0) };
      g.sim.add('tank', g.sim.armyIndex(intruder), 'surface', at.x, at.y);
      g.sim.spawnUnit(g.sim.armyIndex(army), 'trooper', 'surface');
      return { army, data };
    }).map(({ army, data }) => {
      const out = initializedBot(army, 'surface', 'standard', data).think(g.observe({ team: army, role: 'surface' }, 0));
      const move = out.find((i) => i.kind === 'move' && i.mode === 'fight');
      if (move?.kind !== 'move') throw new Error(`${army}: expected a defence move`);
      return move;
    });
    orders.forEach((m, k) => expect({ x: m.x, y: m.y }, FFA[k]).toEqual({ x: rotX(k, orders[0]!.x, orders[0]!.y, size), y: rotY(k, orders[0]!.x, orders[0]!.y, size) }));
  });

  it.each(['standard', 'veteran'] as const)('%s Sky screens the rotated twin of simultaneous hostile impacts for every army', (level) => {
    const g = game();
    const size = g.sim.size;
    // Each army drops one rock on its opposite corner at the same tick; observations list them in world order.
    const impacts = FFA.map((army, j) => ({ id: `e_${9000 + j}`, x: rotX(j, size - 10, size - 10, size), y: rotY(j, size - 10, size - 10, size), tick: toTicks(10), side: army }));
    FFA.forEach((_, k) => g.sim.add('interceptor', k, 'sky', rotX(k, 14, 20, size), rotY(k, 14, 20, size)));
    g.sim.computeVision();
    // One interceptor per army: the first rock in the army's own order gets it, so that order must be frame-relative.
    const screened = FFA.map((army, k) => {
      const seat = { team: army, role: 'sky' } as const;
      const obs = g.observe(seat, 0);
      obs.impacts = impacts.map((i) => ({ ...i }));
      const attack = initializedBot(army, 'sky', level, g.matchData(seat)).think(obs).find((i) => i.kind === 'attack');
      if (attack?.kind !== 'attack') throw new Error(`${army}: expected an interception`);
      return (impacts.findIndex((i) => i.id === attack.target) - k + 4) & 3;
    });
    expect(screened).toEqual(screened.map(() => screened[0]));
  });
});

/** Spire centres for the default-rule matches below. */
const DEFAULT_SPIRES = spirePositions(DEFAULT_RULES.map.spireInset, DEFAULT_RULES.map.size);

function initializedBot(team: ArmyId, role: Plane, level: Opponent, matchData: MatchData) {
  const bot = createBot(team, role, level);
  bot.init?.(matchData);
  return bot;
}

describe('bot match bootstrap', () => {
  it.each(['depths', 'surface', 'sky', 'orbit'] as const)('%s requires initialization and accepts only dynamic observations', (role) => {
    const g = createGame({ seed: 3 });
    const seat = { team: 'nw', role } as const;
    const matchData = g.matchData(seat);
    expect(() => createBot('nw', role, 'standard').think(g.observe(seat, 0))).toThrow('match data initialization');
    const mismatch = g.observe(seat, 0);
    mismatch.rulesHash = (mismatch.rulesHash ^ 1) >>> 0;
    expect(() => initializedBot('nw', role, 'standard', matchData).think(mismatch)).toThrow('rules hash');
    const bot = initializedBot('nw', role, 'standard', matchData);
    bot.think(g.observe(seat, 0));
    g.sim.tick = toTicks(10);
    const next = g.observe(seat, 0);
    expect(next).not.toHaveProperty('match');
    expect(() => bot.think(next)).not.toThrow();
    expect(next).not.toHaveProperty('match');
    next.rulesHash = (next.rulesHash ^ 1) >>> 0;
    expect(() => bot.think(next)).toThrow('rules hash');
  });
});

describe('map-sized bot and policy tactics', () => {
  const decide = (mode: 'bot' | 'policy', obs: Observation, data: MatchData): AgentCommandIntent[] => {
    if (mode === 'bot') return initializedBot(obs.army, obs.role, 'veteran', data).think(obs);
    const policy = runInNewContext(`${STARTER_POLICIES[obs.role]}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
    policy.init(data);
    return structuredClone(policy.think(obs));
  };

  it.each(['bot', 'policy'] as const)('%s keeps dimensions isolated across interleaved matches', (mode) => {
    const fixtures = ([80, 64, 48] as const).map((size) => {
      const game = createGame({ seed: 91, options: { terrain: 'open', map: { params: { size, homeLodes: 0, contestedZones: [] } } } });
      const seat = { team: 'se', role: 'surface' } as const;
      const data = game.matchData(seat);
      const obs = game.observe(seat, 0);
      data.terrain.fill(0);
      obs.holes = []; obs.lodes = []; obs.queue = []; obs.tremors = []; obs.oreCaches = [];
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
      const commander = mode === 'bot' ? createBot('se', 'surface', 'standard')
        : runInNewContext(`${STARTER_POLICIES.surface}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
      commander.init?.(data);
      return { size, obs, commander };
    });
    // The last initialized match is 48, but neither larger match may inherit its bounds or mirror centre.
    for (const { size, obs, commander } of fixtures) {
      // The starter is the standard bot: the same forward rally.
      expect(commander.think(obs)).toContainEqual({ kind: 'rally', x: size - 15, y: size - 15 });
    }
  });

  for (const size of MAP_SIZES) for (const preset of TERRAIN_PRESETS) {
    it(`${size} ${preset}: every seat uses only its public bootstrap and emits bounded targets`, () => {
      const game = createGame({ seed: 91, options: { terrain: preset, map: { params: { size } } } });
      for (const team of DUEL) {
        for (let i = 0; i < 12; i++) game.sim.spawnUnit(armyOf(team), 'trooper', 'surface');
        game.sim.spawnUnit(armyOf(team), 'tank', 'surface');
        game.sim.spawnUnit(armyOf(team), 'skiff', 'orbit');
        game.sim.spawnUnit(armyOf(team), 'bomber', 'sky');
      }
      game.sim.tick = toTicks(360);
      for (const team of DUEL) for (const role of PLANES) {
        const seat = { team, role };
        const data = game.matchData(seat);
        const obs = game.observe(seat, 0);
        expect(data.rules.map.size).toBe(size);
        expect(data).not.toHaveProperty('document');
        expect(data).not.toHaveProperty('mapDocument');
        expect(data).not.toHaveProperty('depths');
        if (role === 'depths') expect(obs.depths).toHaveLength(size * size);
        for (const mode of ['bot', 'policy'] as const) {
          const intents = decide(mode, obs, data);
          for (const intent of intents) {
            if ('x' in intent && intent.x !== undefined) {
              expect(Number.isFinite(intent.x), `${mode} ${role} ${intent.kind}`).toBe(true);
              expect(intent.x).toBeGreaterThanOrEqual(0);
              expect(intent.x).toBeLessThan(size);
            }
            if ('y' in intent && intent.y !== undefined) {
              expect(Number.isFinite(intent.y)).toBe(true);
              expect(intent.y).toBeGreaterThanOrEqual(0);
              expect(intent.y).toBeLessThan(size);
            }
            if (intent.kind === 'designate' && intent.cells) for (const cell of intent.cells) {
              expect(Number.isInteger(cell.x) && Number.isInteger(cell.y)).toBe(true);
              expect(cell.x).toBeGreaterThanOrEqual(0);
              expect(cell.y).toBeGreaterThanOrEqual(0);
              expect(cell.x).toBeLessThan(size);
              expect(cell.y).toBeLessThan(size);
            }
          }
        }
      }
    });
  }

  for (const size of MAP_SIZES) for (const mode of ['bot', 'policy'] as const) {
    it(`${mode} ${size}: resolves unreachable goals on its own land with exact mirrored ties`, () => {
      const game = createGame({ seed: 91, options: { terrain: 'open', map: { params: { size, homeLodes: 0, contestedZones: [] } } } });
      const terrain = new Uint8Array(size * size);
      // Two mirrored coastlines isolate each home. Attractive high ground lies across impassable water.
      for (let y = 0; y < size; y++) {
        terrain[y * size + 9] = SURFACE.water;
        terrain[y * size + size - 10] = SURFACE.water;
      }
      for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) {
        terrain[y * size + x] = SURFACE.high;
        terrain[(size - 1 - y) * size + size - 1 - x] = SURFACE.high;
      }
      const moves: { x: number; y: number }[][] = [];
      for (const team of DUEL) {
        const seat = { team, role: 'surface' } as const;
        const data = game.matchData(seat);
        const obs = game.observe(seat, 0);
        const troop = obs.entities.find((e) => e.side === team && e.kind === 'trooper')!;
        obs.entities = [{ ...troop, x: team === 'nw' ? 8.5 : size - 8.5, y: team === 'nw' ? 8.5 : size - 8.5 }];
        obs.holes = []; obs.lodes = []; obs.queue = []; obs.tremors = [];
        obs.oreCaches = []; obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
        data.terrain = packTerrain(terrain);
        const out = decide(mode, obs, data).filter((i) => i.kind === 'move' || i.kind === 'rally');
        expect(out.length).toBeGreaterThan(0);
        moves.push(out.map((i) => {
          const x = team === 'nw' ? i.x : size - i.x;
          const y = team === 'nw' ? i.y : size - i.y;
          expect(x).toBeLessThan(9);
          expect(terrain[Math.floor(i.y) * size + Math.floor(i.x)]).not.toBe(SURFACE.water);
          return { x, y };
        }));
      }
      expect(moves[1]).toEqual(moves[0]);
    });
  }
});

// Full bot matches with 300 s wall timeouts: the serial timing set (pnpm test:timing).
describe('built-in bots, full matches', { tags: ['timing'] }, () => {
  it('veteran beats novice in at least 8 of 10 seeds (both sides), and every match ends', () => {
    let wins = 0;
    const lengths: number[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const veteranBlue = seed % 2 === 1;
      const r = playBotMatch({ seed, levels: veteranBlue ? { nw: 'veteran', se: 'novice' } : { nw: 'novice', se: 'veteran' } });
      expect(r.outcome.nw).not.toBe('running');
      expect(r.ticks).toBeLessThanOrEqual(toTicks(DEFAULT_RULES.spire.timeCap));
      if (r.outcome[veteranBlue ? 'nw' : 'se'] === 'win') wins++;
      lengths.push(r.ticks);
    }
    console.log(`veteran vs novice: ${wins}/10 wins, match lengths (ticks): ${lengths.join(', ')}`);
    expect(wins).toBeGreaterThanOrEqual(8);
    // Harness wall time, not a game threshold: one seed (9) plays to the 30-min cap, and the ten matches have
    // taken up to ~330 s under vitest on a loaded machine (~75 s standalone); 2× that worst case.
  }, 660_000);

  it('idle opponents and evenly matched bots still end (time cap or Spire)', () => {
    for (const [seed, nw, se] of [
      [3, 'idle', 'idle'],
      [4, 'standard', 'standard'],
      [5, 'veteran', 'veteran'],
      [6, 'veteran', 'idle'],
    ] as const) {
      const r = playBotMatch({ seed, levels: { nw, se } });
      expect(r.outcome.nw).not.toBe('running');
      expect(r.ticks).toBeLessThanOrEqual(toTicks(DEFAULT_RULES.spire.timeCap));
      if (nw === 'veteran' && se === 'idle') expect(r.outcome.nw).toBe('win');
    }
  }, 300_000);

  it('surface armies hold high ground and forests; standard and veteran raid with breaches and meet enemy breaches', () => {
    for (const level of ['standard', 'veteran'] as const satisfies readonly Opponent[]) {
      let army = 0;
      let vantage = 0;
      const breaches = { nw: 0, se: 0 };
      let met = 0;
      // Summed over three seeds per tier, each capped at 15 min: the behaviours show up across maps (a single map
      // may have no breach site in reach).
      for (const seed of [1, 4, 5]) playBotMatch({
        seed,
        levels: { nw: level, se: level },
        options: { terrain: 'open' },
        maxTicks: toTicks(15 * 60),
        onTick: (g) => {
          const s = g.sim;
          for (const e of s.ents) {
            if (e.dead || e.plane !== 'surface' || (e.kind !== 'trooper' && e.kind !== 'tank' && e.kind !== 'flak')) continue;
            army++;
            const ground = s.terrain[cellOf(e.x, e.y, s.size)];
            if (isSurfaceHigh(ground!) || surfaceFeature(ground!) === SURFACE.forest) vantage++;
          }
          for (const team of ['nw', 'se'] as const) {
            const army = armyOf(team);
            for (const ev of s.armies[army]!.events) {
              if (ev.tick !== g.tick) continue;
              if (ev.kind === 'breach_opened' && ev.side === army) breaches[team]++;
              // The defender's army is waiting at the breach when the raiders climb out (veteran: counted below).
              if (ev.kind === 'breach_opened' && ev.side !== army && s.ents.some((d) => !d.dead && d.side === army && d.plane === 'surface' && d.unit && Math.hypot(d.x - ev.x, d.y - ev.y) < 6)) met++;
            }
          }
        },
      });
      expect(vantage / army, level).toBeGreaterThan(0.15);
      expect(breaches.nw + breaches.se, level).toBeGreaterThan(0);
      // The standard tier answers a breach only while not attacking (its army often is when raiders come), so whether
      // its army stands at a breach in these three matches is chance; its guard itself is checked directly below.
      if (level === 'veteran') expect(met, level).toBeGreaterThan(0);
    }
  }, 300_000);

  it('discovers and completes a rich flank Headframe in actual bot play', () => {
    const completed = new Set<string>();
    for (const seed of [1, 4, 21]) {
      playBotMatch({
        seed,
        levels: { nw: 'veteran', se: 'novice' },
        maxTicks: toTicks(15 * 60),
        onTick: (g) => {
          if (completed.size) return;
          for (const e of g.sim.ents) {
            if (e.dead || !e.built || e.side !== armyOf('nw') || e.kind !== 'headframe') continue;
            const size = g.sim.size;
            const lode = g.sim.lodes.find((l) => l.rich && cellOf(e.x, e.y, size) === l.c);
            if (!lode) continue;
            const x = lode.c % size;
            const y = Math.floor(lode.c / size);
            expect(Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)).toBeGreaterThan(12);
            expect(g.observe({ team: 'nw', role: 'surface' }, g.tick).lodes.some((l) => l.x === x && l.y === y && l.open)).toBe(true);
            completed.add(`${seed}:${e.id}`);
          }
        },
      });
      if (completed.size) break;
    }
    expect(completed.size).toBeGreaterThan(0);
  }, 300_000);

  it('asteroid strikes release from outside the enemy Orbit segment beam (both sides)', () => {
    const releases = { nw: 0, se: 0 };
    let closest = Infinity;
    for (const seed of [2, 7]) playBotMatch({
      seed,
      levels: { nw: 'veteran', se: 'veteran' },
      maxTicks: toTicks(15 * 60),
      onIntent: (g, seat, intent, result) => {
        if (intent.kind !== 'deorbit' || !result.ok) return;
        const seg = g.sim.armies[armyOf(opponentOf(seat.team))]!.spire.orbit;
        for (const id of intent.units) {
          const tug = g.sim.alive(g.sim.aliasTarget(armyOf(seat.team), Number(id.slice(2))))!;
          closest = Math.min(closest, Math.hypot(tug.x - seg.x, tug.y - seg.y) - g.sim.reach(seg, tug));
          releases[seat.team as 'nw' | 'se']++;
        }
      },
    });
    console.log(`strike releases: nw ${releases.nw}, se ${releases.se}; closest to the beam ${closest.toFixed(2)} tiles`);
    expect(releases.nw).toBeGreaterThan(0);
    expect(releases.se).toBeGreaterThan(0);
    expect(closest).toBeGreaterThan(0);
  }, 300_000);
});

describe('surface breach guard', () => {

  it.each(['standard', 'veteran', 'policy'] as const)('%s meets a breach tremor near home with its army close by, mirrored', (mode) => {
    const orders = (['nw', 'se'] as const).map((team) => {
      const g = createGame({ seed: 3, options: { terrain: 'open' } });
      const seat = { team, role: 'surface' as const };
      const data = g.matchData(seat);
      const obs = g.observe(seat, 0);
      obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
      const size = g.sim.size;
      // Hostile troopers digging up 7 tiles out from our Spire (a public breach tremor in our sight).
      const tile = team === 'nw' ? { x: 8, y: 9 } : { x: size - 1 - 8, y: size - 1 - 9 };
      obs.tremors = [{ ...tile, breach: true }];
      let out: AgentCommandIntent[];
      if (mode === 'policy') {
        const policy = runInNewContext(`${STARTER_POLICIES.surface}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
        policy.init(data);
        out = structuredClone(policy.think(obs));
      } else out = initializedBot(team, 'surface', mode, data).think(obs);
      const meet = out.find((i) => i.kind === 'move' && i.x === tile.x + 0.5 && i.y === tile.y + 0.5);
      expect(meet, team).toMatchObject({ kind: 'move', mode: 'fight' });
      if (meet?.kind !== 'move') throw new Error('expected a move');
      return meet.units.length;
    });
    expect(orders[0]).toBeGreaterThan(0);
    expect(orders[1]).toBe(orders[0]);
  });
});

describe('surface army funding', () => {
  it.each(['standard', 'veteran'] as const)('%s queues missing armor instead of spending every trickle on infantry', (level) => {
    for (const team of ['nw', 'se'] as const) {
      const g = createGame({ seed: 3 });
      for (let i = 0; i < 6; i++) g.sim.spawnUnit(armyOf(team), 'trooper', 'surface');
      for (let i = 0; i < 4; i++) g.sim.spawnUnit(armyOf(team), 'interceptor', 'sky');
      const seat = { team, role: 'surface' as const };
      const matchData = g.matchData(seat);
      const obs = g.observe(seat, 0);
      obs.entities = obs.entities.filter((e) => e.side !== team || e.kind !== 'tank' && e.kind !== 'flak');
      obs.res.alloy = obs.res.freeAlloy = 0;
      obs.res.energy = obs.res.freeEnergy = 0;
      expect(initializedBot(team, 'surface', level, matchData).think(obs)).toContainEqual({ kind: 'queue_add', item: 'tank' });
      expect(g.apply(seat, { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: true });
      obs.queue = g.observe(seat, 0).queue;
      expect(initializedBot(team, 'surface', level, matchData).think(obs).some((i) => i.kind === 'queue_add')).toBe(false);
    }
  });

  it('veteran stops reserving energy for an interceptor screen after losing the Sky producer', () => {
    for (const team of ['nw', 'se'] as const) {
      const g = createGame({ seed: 3 });
      for (let i = 0; i < 6; i++) g.sim.spawnUnit(armyOf(team), 'trooper', 'surface');
      const seat = { team, role: 'surface' as const };
      const matchData = g.matchData(seat);
      // An empty lane commits its next unit whatever it costs (PlaneBot.produce): the screen is held back only from
      // buffered units, so one entry already waits in the Surface lane.
      expect(g.apply(seat, { kind: 'queue_add', item: 'trooper' })).toEqual({ ok: true });
      const obs = g.observe(seat, 0);
      obs.entities = obs.entities.filter((e) => e.side !== team || e.kind !== 'tank' && e.kind !== 'flak' && e.kind !== 'interceptor');
      obs.res.alloy = obs.res.freeAlloy = 10_000;
      // Energy for a tank, not for a tank and an interceptor.
      obs.res.energy = obs.res.freeEnergy = STATS.tank.energy;
      expect(initializedBot(team, 'surface', 'veteran', matchData).think(obs).some((i) => i.kind === 'queue_add' && i.item === 'tank')).toBe(false);
      obs.spire.find((s) => s.plane === 'sky')!.hp = 0;
      expect(initializedBot(team, 'surface', 'veteran', matchData).think(obs)).toContainEqual({ kind: 'queue_add', item: 'tank', ifAffordable: true });
    }
  });

  it.each(['standard', 'veteran', 'policy'] as const)('%s commits a due Headframe on a seen home lode to the queue before it can pay, one at a time, mirrored', (mode) => {
    const think = (obs: Observation, data: MatchData): AgentCommandIntent[] => {
      if (mode !== 'policy') return initializedBot(obs.army, 'surface', mode, data).think(obs);
      const policy = runInNewContext(`${STARTER_POLICIES.surface}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
      policy.init(data);
      return structuredClone(policy.think(obs));
    };
    const sites = (['nw', 'se'] as const).map((team) => {
      const g = createGame({ seed: 7, options: { terrain: 'ridges' } });
      // Past every tier's headframeAt (and the policy's), with a trooper beside each home lode so its outcrop is seen.
      g.sim.tick = toTicks(120);
      const seat = { team, role: 'surface' as const };
      const data = g.matchData(seat);
      for (const l of g.observe(seat, 0).lodes) g.sim.add('trooper', armyOf(team), 'surface', l.x + 0.5, l.y + 0.5).stance = 'hold';
      g.sim.computeVision();
      const obs = g.observe(seat, 0);
      obs.res.alloy = obs.res.freeAlloy = 0;
      const out = think(obs, data).filter((i) => i.kind === 'queue_add' && i.item === 'headframe');
      expect(out, team).toHaveLength(1);
      // One waiting Headframe holds the queue (unfunded, alloy still 0): no second one while it waits.
      const [frame] = out;
      if (frame?.kind !== 'queue_add') throw new Error('expected a Headframe');
      expect(g.apply(seat, frame, { source: mode === 'policy' ? 'policy' : 'bot' })).toEqual({ ok: true });
      obs.queue = g.observe(seat, 0).queue;
      expect(obs.queue.filter((q) => q.item === 'headframe')).toHaveLength(1);
      expect(think(obs, data).some((i) => i.kind === 'queue_add' && i.item === 'headframe')).toBe(false);
      return frame;
    });
    expect(sites[1]).toEqual({ ...sites[0], x: DEFAULT_RULES.map.size - 1 - sites[0]!.x!, y: DEFAULT_RULES.map.size - 1 - sites[0]!.y! });
  });
});

describe('surface flak against telegraphed drops', () => {
  /** `mode`'s answer; a policy plays `script` (default: the Surface starter with default knobs). */
  const decide = (mode: Opponent | 'policy', obs: Observation, data: MatchData, script = STARTER_POLICIES.surface): AgentCommandIntent[] => {
    if (mode !== 'policy') return initializedBot(obs.army, 'surface', mode, data).think(obs);
    const policy = runInNewContext(`${script}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
    policy.init(data);
    return structuredClone(policy.think(obs));
  };
  /** A surface seat with exactly `army` own fighters (plus a Sky screen, so veteran funding is not held for it), no money. */
  const seat = (team: ArmyId, army: Partial<Record<'trooper' | 'tank' | 'flak', number>>, surface: MatchOptions['surface'] = {}) => {
    const g = createGame({ seed: 3, options: { terrain: 'open', surface } });
    const spawned = new Set<string>();
    for (const [kind, n] of Object.entries(army)) for (let i = 0; i < n; i++) spawned.add(g.entityId(team, g.sim.spawnUnit(armyOf(team), kind as UnitKind, 'surface').id));
    for (let i = 0; i < 4; i++) g.sim.spawnUnit(armyOf(team), 'interceptor', 'sky');
    const s = { team, role: 'surface' as const };
    const data = g.matchData(s);
    const obs = g.observe(s, 0);
    obs.entities = obs.entities.filter((e) => e.side !== team || e.plane !== 'surface' || !['trooper', 'tank', 'flak'].includes(e.kind) || spawned.has(e.id));
    obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 0;
    const spire = data.armies.find((a) => a.id === team)!.spireAt;
    // `d` tiles from our Spire toward the map centre (both armies' own frame).
    const near = (id: number, d: number) => ({ id: `e_${id}`, side: opponentOf(team), x: spire.x + (team === 'nw' ? d : -d), y: spire.y + (team === 'nw' ? d : -d), tick: obs.tick + toTicks(8) });
    return { obs, data, near, flak: [...spawned].filter((id) => obs.entities.find((e) => e.id === id)?.kind === 'flak') };
  };

  for (const mode of ['standard', 'veteran', 'policy'] as const) {
    it(`${mode} stations idle flak under a hostile drop on its Spire, mirrored, and ignores drops away from its structures`, () => {
      for (const team of DUEL) {
        // Flak that can emplace in reach of the marker digs in where it stands instead (next case): emplacement off here.
        const { obs, data, near, flak } = seat(team, { trooper: 2, flak: 1 }, { emplaceEnabled: false });
        const marker = near(9999, 3);
        obs.impacts = [marker];
        expect(decide(mode, obs, data)).toContainEqual({ kind: 'move', units: flak, x: marker.x, y: marker.y, mode: 'fight' });
        const away = near(9998, FLAK_DROP_RADIUS + 12);
        obs.impacts = [away];
        expect(decide(mode, obs, data).some((i) => i.kind === 'move' && i.x === away.x && i.y === away.y)).toBe(false);
      }
    });

    it(`${mode} emplaces idle home flak already in reach of a hostile drop on its Spire instead of walking under it, mirrored`, () => {
      for (const team of DUEL) {
        const { obs, data, near, flak } = seat(team, { trooper: 2, flak: 1 });
        obs.impacts = [near(9999, 3)];
        const out = decide(mode, obs, data);
        expect(out).toContainEqual({ kind: 'deploy', units: flak, on: true });
        expect(out.some((i) => i.kind === 'move' && i.units.some((u) => flak.includes(u)))).toBe(false);
      }
    });
  }

  it.each(['veteran', 'policy'] as const)('%s counts drops near its structures as air threats in the counter-mix', async (mode) => {
    // The counter-mix is the tier's `adaptive` field: veteran's, and a starter's deployed with knob adaptive.
    const script = await starterScript('surface', { adaptive: true });
    for (const team of DUEL) {
      const { obs, data, near } = seat(team, { trooper: 4, tank: 4, flak: 1 });
      const produced = (): string | undefined => decide(mode, obs, data, script).flatMap((i) => (i.kind === 'queue_add' ? [i.item] : []))[0];
      expect(produced()).not.toBe('flak');
      obs.impacts = [near(9997, 2), near(9996, 4), near(9995, 6)];
      expect(produced()).toBe('flak');
    }
  });
});

describe('depths bot shared dig routes', () => {
  const size = DEFAULT_RULES.map.size;
  const cell = (x: number, y = 8) => y * size + x;
  const mirror = (n: number) => size * size - 1 - n;
  const point = (n: number) => ({ x: n % size, y: Math.floor(n / size) });
  const tagged = (out: AgentCommandIntent[]) => out.flatMap((i) => i.kind === 'designate' && i.priority > 0 ? i.cells ?? [] : []);

  /** One fogged corridor beside inset-8 roots, with no rail, lode or combat jobs competing for it. */
  const fixture = (team: ArmyId) => {
    const g = createGame({ seed: 91, options: { terrain: 'open', map: { params: { spireInset: 8, homeLodes: 0, contestedZones: [] } } } });
    const m = (n: number) => team === 'nw' ? n : mirror(n);
    const seat = { team, role: 'depths' as const };
    g.sim.cells.fill(CELL.bedrock);
    g.sim.magma.fill(0);
    g.sim.ore.fill(0);
    g.sim.lodeAt.fill(-1);
    const known = g.sim.armies[armyOf(team)]!.group.known;
    known.fill(CELL.bedrock);
    for (let x = 10; x <= 14; x++) {
      g.sim.cells[m(cell(x))] = x === 10 ? CELL.tunnel : CELL.rock;
      known[m(cell(x))] = x === 10 ? CELL.tunnel : CELL.unknown;
    }
    const workers = g.sim.ents.filter((e) => e.side === armyOf(team) && e.kind === 'digger');
    for (const e of workers) {
      const root = point(m(cell(10)));
      e.x = root.x + 0.5;
      e.y = root.y + 0.5;
      e.cell = m(cell(10));
    }
    const matchData = g.matchData(seat);
    matchData.faults = [{ cells: [point(m(cell(14)))] }];
    const observe = () => {
      const obs = g.observe(seat, 0);
      obs.entities = obs.entities.filter((e) => e.side === team && (e.kind === 'digger' || e.kind === 'spire'));
      obs.lodes = [];
      obs.holes = [];
      obs.charges = [];
      obs.cracks = [];
      obs.queue = [];
      obs.res.alloy = obs.res.freeAlloy = 500;
      return obs;
    };
    return { g, seat, m, known, workers, observe, matchData };
  };

  for (const level of ['standard', 'veteran'] as const) {
    it(`${level} publishes the entire mirrored fault approach instead of direct dig orders`, () => {
      const routes: number[][] = [];
      for (const team of ['nw', 'se'] as const) {
        const f = fixture(team);
        const out = initializedBot(team, 'depths', level, f.matchData).think(f.observe());
        expect(out.some((i) => i.kind === 'dig'), team).toBe(false);
        const route = tagged(out).map((p) => f.m(cell(p.x, p.y))).sort((a, b) => a - b);
        expect(route, team).toEqual([11, 12, 13].map((x) => cell(x)));
        for (const intent of out.filter((i) => i.kind === 'designate')) expect(f.g.apply(f.seat, intent)).toEqual({ ok: true });
        expect(f.g.sim.armies[armyOf(team)]!.designationCount).toBe(3);
        for (const intent of out.filter((i) => i.kind === 'macro' && i.action === 'auto_mine')) expect(f.g.apply(f.seat, intent)).toEqual({ ok: true });
        f.g.step();
        expect(f.workers.some((e) => e.designation === f.m(cell(11))), team).toBe(true);
        expect(f.workers.some((e) => e.order.k === 'dig'), team).toBe(false);
        routes.push(route);
      }
      expect(routes[0]).toEqual(routes[1]);
    });

    it.each(['nw', 'se'] as const)(`${level} tags the ore approach without excavating the vein for %s`, (team) => {
      const f = fixture(team);
      const ore = f.m(cell(14));
      f.g.sim.cells[ore] = CELL.ore;
      f.g.sim.ore[ore] = 30;
      f.known[ore] = CELL.ore;
      const obs = f.observe();
      f.matchData.faults = [];
      const out = initializedBot(team, 'depths', level, f.matchData).think(obs);
      const route = tagged(out).map((p) => f.m(cell(p.x, p.y))).sort((a, b) => a - b);
      expect(route).toEqual([11, 12, 13].map((x) => cell(x)));
      expect(out.some((i) => i.kind === 'dig')).toBe(false);
      for (const i of out.filter((i) => i.kind === 'designate')) expect(f.g.apply(f.seat, i)).toEqual({ ok: true });
      expect(f.g.sim.armies[armyOf(team)]!.designations[ore]).toBe(0);
      expect(f.g.sim.ore[ore]).toBe(30);
    });

    it.each(['nw', 'se'] as const)(`${level} plans from fog, not hidden terrain, for %s`, (team) => {
      const a = fixture(team);
      const b = fixture(team);
      // The inaccessible hidden wall may only affect planning after a worker reveals it.
      b.g.sim.cells[b.m(cell(12))] = CELL.bedrock;
      const before = a.observe();
      const after = b.observe();
      expect(before).toEqual(after);
      expect(a.matchData).toEqual(b.matchData);
      const first = initializedBot(team, 'depths', level, a.matchData).think(before);
      expect(tagged(first)).not.toHaveLength(0);
      expect(first).toEqual(initializedBot(team, 'depths', level, b.matchData).think(after));
    });

    it.each(['nw', 'se'] as const)(`${level} preserves teammates' normal and urgent tags when its goal disappears for %s`, (team) => {
      const f = fixture(team);
      for (const [x, priority] of [[11, 1], [12, 2]] as const) {
        expect(f.g.apply({ team, role: 'surface' }, { kind: 'designate', cells: [point(f.m(cell(x)))], priority })).toEqual({ ok: true });
      }
      const bot = initializedBot(team, 'depths', level, f.matchData);
      const first = bot.think(f.observe());
      expect(tagged(first).length).toBeGreaterThan(0);
      for (const i of first.filter((i) => i.kind === 'designate')) expect(f.g.apply(f.seat, i)).toEqual({ ok: true });
      expect(f.g.sim.armies[armyOf(team)]!.designations[f.m(cell(11))]).toBe(1);
      expect(f.g.sim.armies[armyOf(team)]!.designations[f.m(cell(12))]).toBe(2);
      expect(f.g.sim.armies[armyOf(team)]!.designations[f.m(cell(13))]).toBe(1);
      f.known[f.m(cell(14))] = CELL.fortified;
      const next = f.observe();
      next.tick = toTicks(10);
      for (const i of bot.think(next).filter((i) => i.kind === 'designate')) expect(f.g.apply(f.seat, i)).toEqual({ ok: true });
      expect(f.g.sim.armies[armyOf(team)]!.designations[f.m(cell(11))]).toBe(1);
      expect(f.g.sim.armies[armyOf(team)]!.designations[f.m(cell(12))]).toBe(2);
      expect(f.g.sim.armies[armyOf(team)]!.designations[f.m(cell(13))]).toBe(0);
    });

    it.each(['nw', 'se'] as const)(`${level} preserves urgent teammate adoption of a former bot tag for %s`, (team) => {
      const f = fixture(team);
      const bot = initializedBot(team, 'depths', level, f.matchData);
      for (const i of bot.think(f.observe()).filter((i) => i.kind === 'designate')) expect(f.g.apply(f.seat, i)).toEqual({ ok: true });
      const adopted = f.m(cell(13));
      expect(f.g.sim.armies[armyOf(team)]!.designations[adopted]).toBe(1);
      expect(f.g.apply({ team, role: 'surface' }, { kind: 'designate', cells: [point(adopted)], priority: 2 })).toEqual({ ok: true });
      f.known[f.m(cell(14))] = CELL.fortified;
      const next = f.observe();
      next.tick = toTicks(10);
      for (const i of bot.think(next).filter((i) => i.kind === 'designate')) expect(f.g.apply(f.seat, i)).toEqual({ ok: true });
      expect(f.g.sim.armies[armyOf(team)]!.designations[adopted]).toBe(2);
    });

    it.each(['nw', 'se'] as const)(`${level} keeps automatic miners mining when no tag is reachable for %s`, (team) => {
      const f = fixture(team);
      const ore = f.m(cell(10, 9));
      f.g.sim.cells[ore] = CELL.ore;
      f.g.sim.ore[ore] = 30;
      f.known[ore] = CELL.ore;
      const unreachable = f.m(cell(20, 20));
      f.g.sim.cells[unreachable] = CELL.rock;
      f.known[unreachable] = CELL.rock;
      expect(f.g.apply({ team, role: 'surface' }, { kind: 'designate', cells: [point(unreachable)], priority: 2 })).toEqual({ ok: true });
      const obs = f.observe();
      f.matchData.faults = [];
      const out = initializedBot(team, 'depths', level, f.matchData).think(obs);
      const mining = out.filter((i) => i.kind === 'macro' && i.action === 'auto_mine');
      expect(mining).toHaveLength(1);
      for (const i of mining) expect(f.g.apply(f.seat, i)).toEqual({ ok: true });
      for (let tick = 0; tick < toTicks(30); tick++) f.g.step();
      expect(f.g.sim.armies[armyOf(team)]!.stats.alloyMined).toBeGreaterThan(0);
      expect(f.workers.every((e) => e.designation < 0)).toBe(true);
      expect(f.g.sim.armies[armyOf(team)]!.designations[unreachable]).toBe(2);
    });
  }
});

describe('depths troopers', () => {
  /**
   * Blue's depths bot with three idle troopers at the root and one red digger at (x, y), seen through a scan. Hunts
   * send only troopers our known tunnels link to the target, so the digger stands in a tunnel: rock there is dug open.
   */
  const decide = (x: number, y: number): AgentCommandIntent[] => {
    const g = createGame({ seed: 3 });
    const squad = [0, 1, 2].map(() => g.entityId('nw', g.sim.spawnUnit(armyOf('nw'), 'trooper', 'depths').id));
    const at = cellOf(x, y, g.sim.size);
    if (g.sim.cells[at] === CELL.rock) g.sim.cells[at] = CELL.tunnel;
    g.sim.add('digger', armyOf('se'), 'depths', x, y);
    g.sim.scan(armyOf('nw'), x, y);
    const matchData = g.matchData({ team: 'nw', role: 'depths' });
    return initializedBot('nw', 'depths', 'veteran', matchData)
      .think(g.observe({ team: 'nw', role: 'depths' }, 0))
      .filter((i) => 'units' in i && i.units.some((u) => squad.includes(u)));
  };

  it('a squad sent down to breach does not chase an enemy digger across the map', () => {
    // In the open ring round the Mother Lode at the centre (its lode cells are solid).
    expect(decide(DEFAULT_RULES.map.size / 2 - 1.5, DEFAULT_RULES.map.size / 2 - 1.5).filter((i) => i.kind === 'move')).toEqual([]);
  });

  it('troopers down here hunt intruders near home', () => {
    expect(decide(DEFAULT_SPIRES.nw.x + 2.5, DEFAULT_SPIRES.nw.y + 0.5).map((i) => i.kind)).toEqual(['move']);
  });
});

describe('Sky and Orbit research counterplay', () => {
  /**
   * Blue's Surface army past the opening: tier.armyFirst tanks at home, so a veteran seat no longer holds every other
   * plane back for it (PlaneBot.armyFirst) and these mid-game states decide as they would in play.
   */
  const fieldArmy = (g: AgentCommandGame) => {
    for (let i = 0; i < TIERS.veteran.armyFirst; i++) g.sim.spawnUnit(armyOf('nw'), 'tank', 'surface');
  };
  const sky = (interceptors = 4, bombers = 0, army = false) => {
    const g = createGame({ seed: 3 });
    if (army) fieldArmy(g);
    for (let i = 0; i < interceptors; i++) g.sim.spawnUnit(armyOf('nw'), 'interceptor', 'sky');
    for (let i = 0; i < bombers; i++) g.sim.spawnUnit(armyOf('nw'), 'bomber', 'sky');
    const obs = g.observe({ team: 'nw', role: 'sky' }, 0);
    let air = 0;
    let bombs = 0;
    obs.entities = obs.entities.filter((e) => e.side !== 'nw' || (e.kind !== 'interceptor' || air++ < interceptors) && (e.kind !== 'bomber' || bombs++ < bombers));
    obs.entities.filter((e) => e.kind === 'island').slice(0, 2).forEach((e) => { e.side = 'nw'; });
    obs.res.alloy = obs.res.freeAlloy = 1000;
    obs.res.energy = obs.res.freeEnergy = 1000;
    obs.research = { available: ['ascent_thrusters'], inProgress: [], completed: [], seen: [] };
    return { obs, matchData: g.matchData({ team: 'nw', role: 'sky' }) };
  };

  for (const level of ['standard', 'veteran'] as const) {
    it(`${level} builds bombers only after establishing Sky control`, () => {
      const { obs, matchData } = sky(6, 0, true);
      obs.research = { available: [], inProgress: [], completed: ['ascent_thrusters'], seen: [] };
      expect(initializedBot('nw', 'sky', level, matchData).think(obs)).toContainEqual({ kind: 'queue_add', item: 'bomber' });
      obs.entities.filter((e) => e.kind === 'island').forEach((e) => { e.side = 'neutral'; });
      expect(initializedBot('nw', 'sky', level, matchData).think(obs)).not.toContainEqual({ kind: 'queue_add', item: 'bomber' });
    });

    it(`${level} buys research from free backing after reserving only its current unit plan`, () => {
      const { obs, matchData } = sky(4, 0, true);
      const research = { kind: 'research', upgrade: 'ascent_thrusters', ifAffordable: true };
      expect(initializedBot('nw', 'sky', level, matchData).think(obs)).toContainEqual(research);
      obs.res.alloy = obs.res.freeAlloy = matchData.rules.research.ascentThrustersAlloy - 1;
      expect(initializedBot('nw', 'sky', level, matchData).think(obs)).not.toContainEqual(research);
      obs.res.alloy = obs.res.freeAlloy = 1000;
      const waiting = createGame({ seed: 3 });
      waiting.apply({ team: 'nw', role: 'surface' }, { kind: 'queue_add', item: 'tank' });
      obs.queue = waiting.observe({ team: 'nw', role: 'sky' }, 0).queue;
      obs.queue[0]!.alloy = obs.res.alloy;
      expect(initializedBot('nw', 'sky', level, matchData).think(obs)).toContainEqual(research);
      obs.queue[0]!.heldAlloy = obs.res.alloy;
      obs.res.heldAlloy = obs.res.alloy;
      obs.res.freeAlloy = 0;
      expect(initializedBot('nw', 'sky', level, matchData).think(obs)).not.toContainEqual(research);
      obs.queue = [];
      obs.research.available = [];
      obs.research.inProgress = ['ascent_thrusters'];
      expect(initializedBot('nw', 'sky', level, matchData).think(obs)).not.toContainEqual(research);
    });

    it(`${level} ascends only surplus ready interceptors without overwriting their orders`, () => {
      const { obs, matchData } = sky(6);
      obs.research.available = [];
      obs.research.completed = ['ascent_thrusters'];
      const out = initializedBot('nw', 'sky', level, matchData).think(obs);
      const raid = out.find((i) => i.kind === 'ascend');
      expect(raid?.kind).toBe('ascend');
      if (raid?.kind !== 'ascend') return;
      // One of the two former surplus planes now covers the planned island investment.
      expect(raid.units).toHaveLength(1);
      expect(out.filter((i) => i.kind === 'capture').every((i) => i.kind === 'capture' && i.units.every((id) => !raid.units.includes(id)))).toBe(true);
      obs.entities.filter((e) => e.side === 'nw' && e.kind === 'interceptor').forEach((e) => { e.transitReady = obs.tick + 100; });
      expect(initializedBot('nw', 'sky', level, matchData).think(obs).some((i) => i.kind === 'ascend')).toBe(false);
    });

    it(`${level} fills the escort gap and attacks visible Orbit enemies`, () => {
      const g = createGame({ seed: 3 });
      fieldArmy(g);
      const lancer = g.sim.spawnUnit(armyOf('nw'), 'lancer', 'orbit');
      const target = g.sim.add('solar', armyOf('se'), 'orbit', lancer.x + 2, lancer.y);
      g.sim.scan(armyOf('nw'), target.x, target.y);
      const obs = g.observe({ team: 'nw', role: 'orbit' }, 0);
      const matchData = g.matchData({ team: 'nw', role: 'orbit' });
      obs.res.alloy = obs.res.freeAlloy = 1000;
      obs.res.energy = obs.res.freeEnergy = 1000;
      const out = initializedBot('nw', 'orbit', level, matchData).think(obs);
      expect(out).toContainEqual({ kind: 'queue_add', item: 'bastion' });
      expect(out).toContainEqual({ kind: 'attack', units: [g.entityId('nw', lancer.id)], target: g.entityId('nw', target.id) });
    });

    it(`${level} gathers a fleet rather than sending a lone Lancer into the segment beam`, () => {
      const g = createGame({ seed: 3 });
      const spire = g.sim.armies[armyOf('se')]!.spire.orbit;
      g.sim.add('lancer', armyOf('nw'), 'orbit', spire.x - 10, spire.y);
      g.sim.scan(armyOf('nw'), spire.x, spire.y);
      const matchData = g.matchData({ team: 'nw', role: 'orbit' });
      const observe = () => {
        const obs = g.observe({ team: 'nw', role: 'orbit' }, 0);
        obs.entities = obs.entities.filter((e) => e.side === 'nw' || e.kind === 'spire');
        return obs;
      };
      const lone = observe();
      const target = g.entityId('nw', spire.id);
      expect(initializedBot('nw', 'orbit', level, matchData).think(lone).some((i) => i.kind === 'attack' && i.target === target)).toBe(false);
      for (let i = 0; i < 5; i++) g.sim.add('lancer', armyOf('nw'), 'orbit', spire.x - 10, spire.y);
      expect(initializedBot('nw', 'orbit', level, matchData).think(observe()).some((i) => i.kind === 'attack' && i.target === target)).toBe(true);
    });
  }

  for (const mode of ['standard', 'veteran', 'policy'] as const) {
    it(`${mode} opens bombers on an exact anti-air tie, and with spare energy over held islands`, () => {
      // Seven: the screen plus raid interceptors once Ascent is researched.
      const { obs, matchData } = sky(7);
      obs.research = { available: [], inProgress: [], completed: ['ascent_thrusters'], seen: [] };
      const decide = (): AgentCommandIntent[] => {
        if (mode !== 'policy') return initializedBot('nw', 'sky', mode, matchData).think(obs);
        const policy = runInNewContext(`${STARTER_POLICIES.sky}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
        policy.init(matchData);
        return structuredClone(policy.think(obs));
      };
      const bomber = expect.objectContaining({ kind: 'queue_add', item: 'bomber' });
      const hostile = (n: number) => obs.entities.filter((e) => e.side === 'nw' && e.kind === 'interceptor').slice(0, n).map((e, i) => ({ ...e, id: `e_${9000 + obs.entities.length + i}`, side: 'se' as const }));
      // An exact mirror: as many enemy interceptors in sight as ours, and no spare energy.
      obs.res.energy = obs.res.freeEnergy = BOMBER_SPARE_ENERGY;
      obs.entities.push(...hostile(7));
      expect(decide()).toContainEqual(bomber);
      // They lead by one: no Sky control, so only spare energy over held islands buys the pair.
      obs.entities.push(...hostile(1));
      expect(decide()).not.toContainEqual(bomber);
      obs.res.energy = obs.res.freeEnergy = BOMBER_SPARE_ENERGY + 1;
      expect(decide()).toContainEqual(bomber);
      obs.entities.filter((e) => e.kind === 'island').forEach((e) => { e.side = 'neutral'; });
      expect(decide()).not.toContainEqual(bomber);
    });
  }

  it('Sky commands its ascended raiders while bombers attack surface structures', () => {
    const g = createGame({ seed: 3 });
    const bomber = g.sim.spawnUnit(armyOf('nw'), 'bomber', 'sky');
    const turret = g.sim.add('turret', armyOf('se'), 'surface', bomber.x + 2, bomber.y);
    const raider = g.sim.spawnUnit(armyOf('nw'), 'interceptor', 'orbit');
    const solar = g.sim.add('solar', armyOf('se'), 'orbit', raider.x + 2, raider.y);
    g.sim.scan(armyOf('nw'), raider.x, raider.y);
    const obs = g.observe({ team: 'nw', role: 'sky' }, 0);
    const matchData = g.matchData({ team: 'nw', role: 'sky' });
    obs.entities.find((e) => e.id === g.entityId('nw', raider.id))!.transit = { to: 'orbit', at: 0, until: obs.tick + toTicks(20), return: 'sky' };
    const out = initializedBot('nw', 'sky', 'standard', matchData).think(obs);
    expect(out).toContainEqual({ kind: 'attack', units: [g.entityId('nw', raider.id)], target: g.entityId('nw', solar.id) });
    expect(out).toContainEqual({ kind: 'attack', units: [g.entityId('nw', bomber.id)], target: g.entityId('nw', turret.id) });
  });
});

describe('Sky bots and public weather', () => {
  /** Public descriptors sampled at observation time, with an explicit, deterministic lifecycle. */
  const storm = (tick: number, overrides: Partial<NaturalStorm> = {}): NaturalStorm => {
    const cell: NaturalStorm = {
      id: 0, x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast',
      originX: 20, originY: 20, dx: 0, dy: 0, turns: 0, maxRadius: 4,
      start: 0, grown: 1, breaking: toTicks(120), end: toTicks(140),
      ...overrides,
    };
    sampleStorm(cell, tick, cell, 0, DEFAULT_RULES.map.size);
    return cell;
  };

  /** A bare mirrored Sky: Spires only, nothing to capture or hunt, no money. */
  const bare = (tick = 0) => {
    const g = createGame({ seed: 3, options: { sky: { stormSets: 1 } } });
    for (const e of g.sim.ents) if (e.kind !== 'spire') e.dead = true;
    for (const t of g.sim.armies) t.alloy = t.energy = 0;
    g.sim.tick = tick;
    return g;
  };

  const weatherObservation = (team: ArmyId) => {
    const g = bare();
    const seat = { team, role: 'sky' } as const;
    return { obs: g.observe(seat, 0), matchData: g.matchData(seat) };
  };

  const weatherDecision = (mode: 'bot' | 'policy', obs: Observation, matchData: MatchData): AgentCommandIntent[] => {
    if (mode === 'bot') return initializedBot(obs.army, 'sky', 'veteran', matchData).think(obs);
    const policy = runInNewContext(`${STARTER_POLICIES.sky}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
    policy.init(matchData);
    return structuredClone(policy.think(obs));
  };

  for (const mode of ['bot', 'policy'] as const) {
    it(`${mode}: leaves idle, holding and patrolling air in seeded storms, with exactly mirrored escape ties`, () => {
      for (const state of ['idle', 'capturing', 'moving', 'attacking'] as const) {
        const orders = (['nw', 'se'] as const).map((team) => {
          const { obs, matchData } = weatherObservation(team);
          const size = matchData.rules.map.size;
          const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
          matchData.jets = [];
          obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [{ ...point(20, 20), radius: 4, until: toTicks(30) }] };
          obs.entities = [
            { id: 'e_900', kind: 'interceptor', side: team, plane: 'sky', ...point(20, 20), hp: 120, maxHp: 120, state,
              ...(state === 'capturing' ? { work: point(20, 20) } : {}),
              ...(state === 'moving' ? { wp: [point(19, 20), point(21, 20)] } : {}) },
            { id: 'e_901', kind: 'island', side: team, plane: 'sky', ...point(20, 20), hp: 1, maxHp: 1, state: 'drifting' },
          ];
          const moves = weatherDecision(mode, obs, matchData).filter((i) => i.kind === 'move');
          expect(moves).toHaveLength(1);
          const move = moves[0]!;
          expect(move.units).toEqual(['e_900']);
          expect(Math.hypot(move.x - point(20, 20).x, move.y - point(20, 20).y)).toBeGreaterThan(4);
          return move;
        });
        expect(orders[1]).toEqual({ ...orders[0], x: DEFAULT_RULES.map.size - orders[0]!.x, y: DEFAULT_RULES.map.size - orders[0]!.y });
      }
    });

    it(`${mode}: retains a structure strike and contested island defence inside a storm`, () => {
      for (const task of ['strike', 'defend'] as const) {
        const { obs, matchData } = weatherObservation('nw');
        matchData.jets = [];
        obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [{ x: 20, y: 20, radius: 4, until: toTicks(30) }] };
        obs.entities = [
          { id: 'e_900', kind: task === 'strike' ? 'bomber' : 'interceptor', side: 'nw', plane: 'sky', x: 20, y: 20, hp: 120, maxHp: 120,
            state: task === 'strike' ? 'attacking' : 'capturing', work: { x: 20, y: 20 } },
          { id: 'e_901', kind: task === 'strike' ? 'turret' : 'interceptor', side: 'se', plane: task === 'strike' ? 'surface' : 'sky',
            x: 20, y: 20, hp: 120, maxHp: 120, state: 'idle' },
          ...(task === 'defend' ? [{ id: 'e_902', kind: 'island', side: 'nw', plane: 'sky', x: 20, y: 20, hp: 1, maxHp: 1, state: 'drifting' } as const] : []),
        ];
        expect(weatherDecision(mode, obs, matchData).filter((i) => i.kind === 'move' && !i.queue)).toEqual([]);
      }
    });

    it(`${mode}: holds an own island an enemy is capturing or contesting before the next sweep, mirrored`, () => {
      for (const state of ['capturing', 'contested', 'drifting'] as const) {
        const captures = (['nw', 'se'] as const).map((team) => {
          const { obs, matchData } = weatherObservation(team);
          const size = matchData.rules.map.size;
          const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
          matchData.jets = [];
          obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [] };
          obs.entities = [
            { id: 'e_900', kind: 'interceptor', side: team, plane: 'sky', ...point(14, 14), hp: 120, maxHp: 120, state: 'idle' },
            // Ours, under capture (the island_contested alert), and a neutral island nearer home for the sweep.
            { id: 'e_901', kind: 'island', side: team, plane: 'sky', ...point(30, 30), hp: 1, maxHp: 1, state, ...(state === 'drifting' ? {} : { progress: 0.4 }) },
            { id: 'e_902', kind: 'island', side: 'neutral', plane: 'sky', ...point(12, 12), hp: 1, maxHp: 1, state: 'drifting' },
          ];
          return weatherDecision(mode, obs, matchData).filter((i) => i.kind === 'capture');
        });
        expect(captures[1]).toEqual(captures[0]);
        expect(captures[0]).toEqual([{ kind: 'capture', units: ['e_900'], island: state === 'drifting' ? 'e_902' : 'e_901' }]);
      }
    });

    it(`${mode}: Surface moors a useful owned island only with range, an idle tower and sustained upkeep, mirrored`, () => {
      for (const kase of ['ready', 'cooling', 'off', 'poor', 'low-reserve', 'raising', 'busy', 'hidden-busy', 'hidden-unpaid', 'far', 'hostile', 'unpowered', 'constructing'] as const) {
        const orders = (['nw', 'se'] as const).map((team) => {
          const { obs, matchData } = weatherObservation(team);
          obs.role = 'surface';
          const size = matchData.rules.map.size;
          const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
          const c = size / 2, r = 10;
          if (kase === 'off') matchData.rules.surface.mooringEnabled = false;
          obs.res.energy = obs.res.freeEnergy = kase === 'low-reserve' ? 1 : 500;
          obs.res.energyRate = kase === 'poor' ? 3 : 20;
          obs.res.upkeep = 0;
          obs.entities = [
            { id: 'e_903', kind: 'stormcatcher', side: team, plane: 'sky', ...point(c - r, c), hp: 200, maxHp: 200, state: 'idle', link: 'e_904' },
            { id: 'e_904', kind: 'island', side: kase === 'hostile' ? (team === 'nw' ? 'se' : 'nw') : team, plane: 'sky', ...point(c - r, c), hp: 1, maxHp: 1, state: 'drifting', link: 'e_903',
              ...(kase === 'cooling' ? { mooringReadyAt: obs.tick + 1 } : {}),
              ...(kase === 'raising' ? { mooringState: 'raising' as const } : {}) },
            { id: 'e_905', kind: 'mooring_tower', side: team, plane: 'surface', ...point(kase === 'far' ? c + r : c - r, c), hp: 400, maxHp: 400, state: kase === 'constructing' ? 'constructing' : 'idle', mooringPowered: kase !== 'unpowered',
              ...(kase === 'busy' ? { mooringTarget: 'e_906' } : {}),
              ...(kase === 'hidden-busy' ? { mooringGrace: 60 } : {}),
              ...(kase === 'hidden-unpaid' ? { mooringGrace: 0 } : {}) },
          ];
          if (mode === 'bot') return initializedBot(team, 'surface', 'veteran', matchData).think(obs).filter((i) => i.kind === 'moor');
          const policy = runInNewContext(`${STARTER_POLICIES.surface}\n({init, think});`, { log() {} }) as { init(data: MatchData): void; think(obs: Observation): AgentCommandIntent[] };
          policy.init(matchData);
          return structuredClone(policy.think(obs)).filter((i: AgentCommandIntent) => i.kind === 'moor');
        });
        expect(orders[1]).toEqual(orders[0]);
        expect(orders[0]).toEqual(kase === 'ready' ? [{ kind: 'moor', tower: 'e_905', island: 'e_904' }] : []);
      }
    });

    it(`${mode}: seeds a storm over hostile aircraft once ready, never while cooling, quiet or toggled off, mirrored`, () => {
      for (const kase of ['raid', 'cooling', 'quiet', 'off'] as const) {
        const seeds = (['nw', 'se'] as const).map((team) => {
          const { obs, matchData } = weatherObservation(team);
          const size = matchData.rules.map.size;
          const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
          const foe = team === 'nw' ? 'se' : 'nw';
          matchData.jets = [];
          if (kase === 'off') matchData.rules.sky.seederEnabled = false;
          obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [] };
          obs.res.energy = obs.res.freeEnergy = 500;
          obs.entities = [
            { id: 'e_906', kind: 'storm_seeder', side: team, plane: 'sky', ...point(20, 20), hp: 200, maxHp: 200, state: 'idle', link: 'e_907',
              ...(kase === 'cooling' ? { ready: obs.tick + 1 } : {}) },
            { id: 'e_907', kind: 'island', side: team, plane: 'sky', ...point(20, 20), hp: 1, maxHp: 1, state: 'drifting', link: 'e_906' },
            ...(kase === 'quiet' ? [] : [
              { id: 'e_910', kind: 'interceptor', side: foe, plane: 'sky', ...point(22, 20), hp: 120, maxHp: 120, state: 'idle' } as const,
              { id: 'e_911', kind: 'interceptor', side: foe, plane: 'sky', ...point(20, 23), hp: 120, maxHp: 120, state: 'idle' } as const,
            ]),
          ];
          return weatherDecision(mode, obs, matchData).filter((i) => i.kind === 'seed');
        });
        expect(seeds[1]).toEqual(seeds[0]);
        expect(seeds[0]).toEqual(kase === 'raid' ? [{ kind: 'seed', seeder: 'e_906' }] : []);
      }
    });

    it(`${mode}: buys gunships by cost against the visible threats: bomber escorts (flak or not), brawlers only when they out-trade interceptors, mirrored`, () => {
      // escort: Sky control, both bombers out, three hostile flak in sight (the old rule refused gunships at 3 flak);
      // swarm: four hostile interceptors, no bombers: interceptors out-trade gunships per cost at the default stats;
      // tough: the same swarm against 640-HP gunships, which do out-trade them; off: gunshipEnabled false.
      for (const kase of ['escort', 'swarm', 'tough', 'off'] as const) {
        const gunships = (['nw', 'se'] as const).map((team) => {
          const { obs, matchData } = weatherObservation(team);
          const size = matchData.rules.map.size;
          const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
          const foe = team === 'nw' ? 'se' : 'nw';
          matchData.jets = [];
          if (kase === 'off') matchData.rules.sky.gunshipEnabled = false;
          if (kase === 'tough') matchData.rules.stats.gunship.hp = 640;
          obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [] };
          obs.res.alloy = obs.res.freeAlloy = obs.res.energy = obs.res.freeEnergy = 2000;
          // A full screen of our own (both the bot's and the policy's), so the next aircraft is the mix's choice.
          const screen = [0, 1, 2, 3, 4].map((k) => ({ id: `e_90${k}`, kind: 'interceptor', side: team, plane: 'sky', ...point(14 + k, 14), hp: 120, maxHp: 120, state: 'idle' }) as const);
          const wing = kase === 'swarm' || kase === 'tough' ? [] : [
            ...[0, 1].map((k) => ({ id: `e_93${k}`, kind: 'island', side: team, plane: 'sky', ...point(20 + 6 * k, 20), hp: 1, maxHp: 1, state: 'drifting' }) as const),
            ...[0, 1].map((k) => ({ id: `e_94${k}`, kind: 'bomber', side: team, plane: 'sky', ...point(12 + k, 12), hp: 200, maxHp: 200, state: 'moving' }) as const),
          ];
          const swarm = [0, 1, 2, 3].slice(0, kase === 'swarm' || kase === 'tough' ? 4 : 0)
            .map((k) => ({ id: `e_91${k}`, kind: 'interceptor', side: foe, plane: 'sky', ...point(40 + k, 40), hp: 120, maxHp: 120, state: 'idle' }) as const);
          const flak = [0, 1, 2].slice(0, kase === 'escort' || kase === 'off' ? 3 : 0)
            .map((k) => ({ id: `e_92${k}`, kind: 'flak', side: foe, plane: 'surface', ...point(50 + k, 50), hp: 150, maxHp: 150, state: 'idle' }) as const);
          obs.entities = [...screen, ...wing, ...swarm, ...flak];
          return weatherDecision(mode, obs, matchData).flatMap((i) => i.kind === 'queue_add' && i.item === 'gunship' ? [{ kind: i.kind, item: i.item }] : []);
        });
        expect(gunships[1]).toEqual(gunships[0]);
        expect(gunships[0]).toEqual(kase === 'escort' || kase === 'tough' ? [{ kind: 'queue_add', item: 'gunship' }] : []);
      }
    });

    it(`${mode}: flies a gunship escort with its bombers (fight-move onto their centre), mirrored`, () => {
      const orders = (['nw', 'se'] as const).map((team) => {
        const { obs, matchData } = weatherObservation(team);
        const size = matchData.rules.map.size;
        const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
        matchData.jets = [];
        obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [] };
        obs.entities = [
          ...[0, 1].map((k) => ({ id: `e_94${k}`, kind: 'bomber', side: team, plane: 'sky', ...point(30 + 2 * k, 30), hp: 200, maxHp: 200, state: 'moving' }) as const),
          { id: 'e_950', kind: 'gunship', side: team, plane: 'sky', ...point(12, 12), hp: 320, maxHp: 320, state: 'idle' } as const,
        ];
        return { out: weatherDecision(mode, obs, matchData).filter((i) => i.kind === 'move' && i.units.includes('e_950')), at: point(31, 30) };
      });
      for (const { out, at } of orders) expect(out).toEqual([{ kind: 'move', units: ['e_950'], ...at, mode: 'fight' }]);
    });

    it(`${mode}: emplaces a gunship on a threatened held Relay island's empty hardpoint, not when quiet, off or occupied, mirrored`, () => {
      for (const kase of ['threat', 'approach', 'contested', 'quiet', 'off', 'none', 'occupied'] as const) {
        const orders = (['nw', 'se'] as const).map((team) => {
          const { obs, matchData } = weatherObservation(team);
          const size = matchData.rules.map.size;
          const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
          const foe = team === 'nw' ? 'se' : 'nw';
          matchData.jets = [];
          if (kase === 'off') matchData.rules.sky.gunshipEmplaceEnabled = false;
          if (kase === 'none') matchData.rules.sky.islandHardpoints = 0;
          obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [] };
          // Our gunship already holds the island (capturing there, so within captureRadius) unless it must fly there.
          const there = kase !== 'approach';
          obs.entities = [
            { id: 'e_900', kind: 'gunship', side: team, plane: 'sky', ...point(there ? 20 : 12, there ? 20 : 12), hp: 320, maxHp: 320,
              state: there ? 'capturing' : 'idle', ...(there ? { work: point(20, 20) } : {}) },
            { id: 'e_901', kind: 'island', side: team, plane: 'sky', ...point(20, 20), hp: 1, maxHp: 1, link: 'e_902',
              state: kase === 'contested' ? 'contested' : 'drifting', ...(kase === 'contested' ? { progress: 0.4 } : {}) },
            { id: 'e_902', kind: 'relay', side: team, plane: 'sky', ...point(20, 20), hp: 250, maxHp: 250, state: 'idle', link: 'e_901' },
            ...(kase === 'quiet' || kase === 'contested' ? [] : [
              { id: 'e_910', kind: 'interceptor', side: foe, plane: 'sky', ...point(26, 20), hp: 120, maxHp: 120, state: 'idle' } as const,
            ]),
          ];
          obs.islands = [{ id: 'e_901', cx: size / 2, cy: size / 2, r: 6, phase: 0, speed: 0,
            ...(kase === 'occupied' ? { hardpoint: { kind: 'gun_platform' as const, side: team } } : {}) }];
          const pick = (out: AgentCommandIntent[]) => out.filter((i) => i.kind === 'emplace' || (i.kind === 'capture' && i.island === 'e_901'));
          // Standard bots never emplace (tier gunPlatforms 0); they may still hold a contested island.
          if (mode === 'bot') expect(initializedBot(obs.army, 'sky', 'standard', structuredClone(matchData)).think(structuredClone(obs)).filter((i) => i.kind === 'emplace')).toEqual([]);
          return pick(weatherDecision(mode, obs, matchData));
        });
        expect(orders[1]).toEqual(orders[0]);
        expect(orders[0], kase).toEqual(kase === 'threat' || kase === 'contested' ? [{ kind: 'emplace', unit: 'e_900', island: 'e_901' }]
          : [{ kind: 'capture', units: ['e_900'], island: 'e_901' }]);
      }
    });

    it(`${mode}: shoots down a hostile Gun Platform before capturing its island (emplace counterplay), mirrored`, () => {
      const orders = (['nw', 'se'] as const).map((team) => {
        const { obs, matchData } = weatherObservation(team);
        const size = matchData.rules.map.size;
        const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
        const foe = team === 'nw' ? 'se' : 'nw';
        matchData.jets = [];
        obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [] };
        obs.entities = [
          { id: 'e_900', kind: 'interceptor', side: team, plane: 'sky', ...point(14, 14), hp: 120, maxHp: 120, state: 'idle' },
          { id: 'e_905', kind: 'island', side: foe, plane: 'sky', ...point(20, 20), hp: 1, maxHp: 1, state: 'drifting', link: 'e_906' },
          { id: 'e_906', kind: 'relay', side: foe, plane: 'sky', ...point(20, 20), hp: 250, maxHp: 250, state: 'idle', link: 'e_905' },
          { id: 'e_907', kind: 'gun_platform', side: foe, plane: 'sky', ...point(20, 20), hp: 320, maxHp: 320, state: 'idle', link: 'e_905' },
        ];
        obs.islands = [{ id: 'e_905', cx: size / 2, cy: size / 2, r: 6, phase: 0, speed: 0, hardpoint: { kind: 'gun_platform', side: foe } }];
        return weatherDecision(mode, obs, matchData).filter((i) => i.kind === 'attack' || i.kind === 'capture');
      });
      expect(orders[1]).toEqual(orders[0]);
      expect(orders[0]).toEqual([
        { kind: 'attack', units: ['e_900'], target: 'e_907' },
        { kind: 'capture', units: ['e_900'], island: 'e_905', queue: true },
      ]);
    });

    it(`${mode}: hangars a badly damaged gunship at a powered Aerie and keeps housed aircraft until repaired`, () => {
      for (const repair of [true, false]) {
        const { obs, matchData } = weatherObservation('nw');
        matchData.jets = [];
        matchData.rules.sky.aerieRepairEnabled = repair;
        obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [] };
        obs.entities = [
          { id: 'e_905', kind: 'aerie', side: 'nw', plane: 'sky', x: 20, y: 20, hp: 300, maxHp: 300, state: 'active', link: 'e_906' },
          { id: 'e_906', kind: 'island', side: 'nw', plane: 'sky', x: 20, y: 20, hp: 1, maxHp: 1, state: 'drifting', link: 'e_905' },
          { id: 'e_900', kind: 'gunship', side: 'nw', plane: 'sky', x: 21, y: 20, hp: 100, maxHp: 320, state: 'idle' },
          { id: 'e_901', kind: 'gunship', side: 'nw', plane: 'sky', x: 20, y: 20, hp: 300, maxHp: 320, state: 'hangared', hangar: 'e_905' },
        ];
        const out = weatherDecision(mode, obs, matchData);
        expect(out.filter((i) => i.kind === 'hangar')).toEqual(repair ? [{ kind: 'hangar', target: 'e_905', units: ['e_900'] }] : []);
        expect(out.filter((i) => i.kind === 'launch')).toEqual(repair ? [] : [{ kind: 'launch', units: ['e_901'] }]);
      }
    });

    it(`${mode}: preserves asteroid interception and hangars while unrelated bombers escape`, () => {
      const { obs, matchData } = weatherObservation('nw');
      matchData.jets = [];
      obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [{ x: 20, y: 20, radius: 4, until: toTicks(30) }] };
      obs.impacts = [{ id: 'e_903', x: 30, y: 30, tick: toTicks(10), side: 'se' }];
      obs.entities = [
        { id: 'e_900', kind: 'interceptor', side: 'nw', plane: 'sky', x: 20, y: 20, hp: 120, maxHp: 120, state: 'idle' },
        { id: 'e_901', kind: 'bomber', side: 'nw', plane: 'sky', x: 20, y: 20, hp: 200, maxHp: 200, state: 'idle' },
        { id: 'e_902', kind: 'bomber', side: 'nw', plane: 'sky', x: 20, y: 20, hp: 200, maxHp: 200, state: 'hangared', hangar: 'e_904' },
      ];
      const out = weatherDecision(mode, obs, matchData);
      expect(out).toContainEqual({ kind: 'attack', units: ['e_900'], target: 'e_903' });
      expect(out.some(i => i.kind === 'macro' && i.action === 'intercept')).toBe(false);
      const escapes = out.filter((i): i is Extract<AgentCommandIntent, { kind: 'move' }> => i.kind === 'move' && !i.queue);
      expect(escapes).toHaveLength(1);
      expect(escapes[0]).toMatchObject({ kind: 'move', units: ['e_901'] });
    });

    it(`${mode}: storm detours are exactly reflected for either seat`, () => {
      const moves = (['nw', 'se'] as const).map((team) => {
        const { obs, matchData } = weatherObservation(team);
        const size = matchData.rules.map.size;
        const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
        matchData.jets = [];
        obs.weather = { storms: [], forecast: [], fog: [], seedWarnings: [], seeded: [{ ...point(20, 20), radius: 4, until: toTicks(30) }] };
        obs.entities = [
          { id: 'e_900', kind: 'bomber', side: team, plane: 'sky', ...point(20, 10), hp: 120, maxHp: 120, state: 'idle' },
          { id: 'e_901', kind: 'turret', side: team === 'nw' ? 'se' : 'nw', plane: 'surface', ...point(20, 30), hp: 120, maxHp: 120, state: 'idle' },
        ];
        const out = weatherDecision(mode, obs, matchData);
        expect(out).toContainEqual({ kind: 'attack', units: ['e_900'], target: 'e_901', queue: true });
        return out.filter((i): i is Extract<typeof i, { kind: 'move' }> => i.kind === 'move');
      });
      const [blue, red] = moves as [(typeof moves)[0], (typeof moves)[0]];
      expect(blue.length).toBeGreaterThan(0);
      expect(red).toEqual(blue.map((m) => ({ ...m, x: DEFAULT_RULES.map.size - m.x, y: DEFAULT_RULES.map.size - m.y })));
    });
  }

  it('built-in bots escape a forming forecast on the lead, not before it can harm them, with mirrored orders', () => {
    const orders = (['nw', 'se'] as const).map((team) => {
      const { obs, matchData } = weatherObservation(team);
      const size = matchData.rules.map.size;
      const point = team === 'nw' ? { x: 20, y: 20 } : { x: size - 20, y: size - 20 };
      const cloud = storm(obs.tick, { turns: team === 'se' ? 2 : 0, start: toTicks(2), grown: toTicks(6) });
      matchData.jets = [];
      obs.weather = { storms: [], forecast: [cloud], fog: [], seedWarnings: [], seeded: [] };
      obs.entities = [
        { id: 'e_900', kind: 'interceptor', side: team, plane: 'sky', ...point, hp: 120, maxHp: 120, state: 'idle' },
      ];
      expect(cloud.radius).toBe(0);
      expect(cloud.strength).toBe(0);
      expect(initializedBot(team, 'sky', 'novice', matchData).think(obs).filter((i) => i.kind === 'move')).toEqual([]);
      const moves = initializedBot(team, 'sky', 'standard', matchData).think(obs).filter((i) => i.kind === 'move');
      expect(moves).toHaveLength(1);
      const move = moves[0]!;
      const soon: StormSample = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' };
      sampleStorm(cloud, obs.tick + toTicks(4), soon, 0, size);
      expect(soon.stage).toBe('forming');
      expect(Math.hypot(move.x - soon.x, move.y - soon.y)).toBeGreaterThan(soon.radius);
      obs.weather.forecast = [storm(obs.tick, { turns: team === 'se' ? 2 : 0, start: toTicks(20), grown: toTicks(24) })];
      expect(initializedBot(team, 'sky', 'standard', matchData).think(obs).filter((i) => i.kind === 'move')).toEqual([]);
      return moves;
    });
    expect(orders[1]).toEqual(orders[0]!.map((move) => ({ ...move, x: DEFAULT_RULES.map.size - move.x, y: DEFAULT_RULES.map.size - move.y })));
  });

  it('built-in routing samples forecast arrival and releases expired or shrinking hazards, mirror-exact despite descriptor order', () => {
    for (const phase of ['forming', 'distant', 'expired', 'shrinking'] as const) {
      const orders = (['nw', 'se'] as const).map((team) => {
        const { obs, matchData } = weatherObservation(team);
        const size = matchData.rules.map.size;
        const point = (x: number, y: number) => team === 'nw' ? { x, y } : { x: size - x, y: size - y };
        const turns = team === 'se' ? 2 : 0;
        const cloud = storm(obs.tick, {
          turns,
          ...(phase === 'forming' ? { start: toTicks(1), grown: toTicks(6) }
            : phase === 'distant' ? { start: toTicks(30), grown: toTicks(36) }
              : { start: -toTicks(20), grown: -toTicks(19), breaking: -toTicks(5), end: toTicks(phase === 'expired' ? 2 : 5) }),
        });
        const other = storm(obs.tick, { id: 2, turns, originX: 40, originY: 40, start: toTicks(1), grown: toTicks(6) });
        const cells = team === 'nw' ? [cloud, other] : [other, cloud];
        matchData.jets = [];
        obs.weather = {
          storms: cells.filter((cell) => cell.start <= obs.tick),
          forecast: cells.filter((cell) => cell.start > obs.tick),
          fog: [], seedWarnings: [], seeded: [],
        };
        const x = phase === 'shrinking' ? 22.5 : 20;
        obs.entities = [
          { id: 'e_900', kind: 'bomber', side: team, plane: 'sky', ...point(x, 10), hp: 200, maxHp: 200, state: 'idle' },
          { id: 'e_901', kind: 'turret', side: team === 'nw' ? 'se' : 'nw', plane: 'surface', ...point(x, 30), hp: 120, maxHp: 120, state: 'idle' },
        ];
        const out = initializedBot(team, 'sky', 'standard', matchData).think(obs);
        if (phase === 'forming') {
          expect(cloud.radius).toBe(0);
          const arrival: StormSample = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' };
          sampleStorm(cloud, Math.round(10 / 3 * 20), arrival, 0, size);
          expect(arrival.stage).toBe('forming');
          expect(arrival.radius).toBeGreaterThan(0);
          expect(out).toContainEqual({ kind: 'attack', units: ['e_900'], target: 'e_901', queue: true });
          expect(out.some((i) => i.kind === 'move')).toBe(true);
        } else {
          expect(out).toContainEqual({ kind: 'attack', units: ['e_900'], target: 'e_901' });
          expect(out.filter((i) => i.kind === 'move')).toEqual([]);
        }
        return out;
      });
      expect(orders[1], phase).toEqual(orders[0]!.map((intent) => intent.kind === 'move'
        ? { ...intent, x: DEFAULT_RULES.map.size - intent.x, y: DEFAULT_RULES.map.size - intent.y } : intent));
    }
  });

  /**
   * An explicitly mature natural pair sweeps over three idle blue interceptors (and their red twins).
   * Holding still (`hold`: no storm evade) costs all 360 HP per team; storm evade alone and each bot tier must escape
   * promptly without breaking symmetry.
   */
  it('idle air leaves a passing storm within seconds, mirror-exact, at every level', () => {
    const spots = [[24, 37], [25, 36.5], [23, 37.5]] as const;
    const pass = (level: Opponent | undefined, hold = false) => {
      const g = bare(300);
      // One announced pair at the match's natural drift speed, positioned to sweep all three spots in 60s.
      // Reuse its pooled descriptors so normal weather updates drive the public lifecycle.
      for (const cell of g.sim.weather.data.forecast) Object.assign(cell, storm(g.tick, {
        id: cell.id, turns: cell.turns, originX: 24, originY: 27, dy: g.sim.econ.stormDrift / 20, maxRadius: 8,
      }));
      g.sim.weather.update(g.tick);
      const air = { nw: spots.map(([x, y]) => g.sim.add('interceptor', armyOf('nw'), 'sky', x, y)), se: spots.map(([x, y]) => g.sim.add('interceptor', armyOf('se'), 'sky', g.sim.size - x, g.sim.size - y)) };
      if (hold) for (const e of [...air.nw, ...air.se]) e.stance = 'hold';
      g.step();
      const bots = level ? (['nw', 'se'] as const).map((team) => ({ team, bot: initializedBot(team, 'sky', level, g.matchData({ team, role: 'sky' })) })) : [];
      let longest = 0;
      const stint = new Map<number, number>();
      while (g.tick < 300 + toTicks(60)) {
        if (g.tick % BOT_PERIOD === 0) {
          const decided = bots.map((b) => {
            const obs = g.observe({ team: b.team, role: 'sky' }, 0);
            return b.bot.think(obs);
          });
          bots.forEach((b, i) => { for (const intent of decided[i]!) g.apply({ team: b.team, role: 'sky' }, intent); });
        }
        g.step();
        const broken = orbitAsymmetry(g.sim);
        if (broken) throw new Error(broken);
        for (const e of air.nw) {
          const n = !e.dead && g.sim.stormAt(e.x, e.y) ? (stint.get(e.id) ?? 0) + 1 : 0;
          stint.set(e.id, n);
          longest = Math.max(longest, n);
        }
      }
      const lost = (team: 'nw' | 'se') => air[team].reduce((sum, e) => sum + e.maxHp - Math.max(0, e.hp), 0);
      return { blue: lost('nw'), red: lost('se'), longest: longest / 20 };
    };
    const still = pass(undefined, true);
    expect(still.blue).toBe(360);
    console.log(`storm hold baseline: blue=${still.blue}, red=${still.red} HP lost, longest=${still.longest}s`);
    // Storm evade alone (no bot): idle air steps out on its own.
    const evade = pass(undefined);
    expect(evade.red).toBe(evade.blue);
    expect(evade.blue).toBeLessThan(still.blue / 4);
    for (const level of ['novice', 'standard', 'veteran'] as const) {
      const r = pass(level);
      console.log(`storm escape ${level}: blue=${r.blue}, red=${r.red} HP lost, longest=${r.longest}s; mirror-exact every tick`);
      expect(r.red, level).toBe(r.blue);
      expect(r.blue, level).toBeLessThan(level === 'novice' ? still.blue / 4 : still.blue / 20);
      expect(r.longest, level).toBeLessThanOrEqual(level === 'novice' ? 5 : 1);
    }
  });

  /** One blue bomber and red surface targets (the first is the strike target: no red Spire to prefer), all in view. */
  const strike = (bomber: { x: number; y: number }, targets: { kind: 'turret' | 'flak'; x: number; y: number }[]) => {
    const g = bare();
    for (const e of g.sim.ents) if (e.side === armyOf('se')) e.dead = true;
    const unit = g.sim.add('bomber', armyOf('nw'), 'sky', bomber.x, bomber.y);
    const placed = targets.map((t) => g.sim.add(t.kind, armyOf('se'), 'surface', t.x, t.y));
    // Scans are paid (bare() leaves no energy): exactly their cost, so the decision still sees none.
    g.sim.armies[armyOf('nw')]!.energy = g.sim.econ.scanCost * placed.length;
    for (const t of placed) g.sim.scan(armyOf('nw'), t.x, t.y);
    return { obs: g.observe({ team: 'nw', role: 'sky' }, 0), matchData: g.matchData({ team: 'nw', role: 'sky' }), bomber: g.entityId('nw', unit.id), target: g.entityId('nw', placed[0]!.id) };
  };

  it('route tiers detour around a storm on the way and ride a jet lane running their way', () => {
    // An explicitly mature cell at (37, 24), radius 8: the straight north-to-south flight crosses it.
    const across = strike({ x: 37, y: 13 }, [{ kind: 'turret', x: 37, y: 35 }]);
    across.obs.weather.storms = [storm(across.obs.tick, { originX: 37, originY: 24, maxRadius: 8, grown: 0 })];
    across.obs.weather.forecast = [];
    const out = initializedBot('nw', 'sky', 'standard', across.matchData).think(across.obs);
    const at = out.findIndex((i) => i.kind === 'attack');
    expect(out[at]).toEqual({ kind: 'attack', units: [across.bomber], target: across.target, queue: true });
    const detour = out[at - 1]!;
    expect(detour.kind).toBe('move');
    if (detour.kind === 'move') expect(Math.abs(detour.x - 37)).toBeGreaterThan(8);
    // The northern lane (y 12) blows east: a long eastward strike rides it (the bomber off cell edges, where a
    // presented position would move one grid step toward the centre).
    const east = strike({ x: 6.5, y: 12.5 }, [{ kind: 'turret', x: 42, y: 14 }]);
    east.obs.weather.storms = [];
    east.obs.weather.forecast = [];
    expect(initializedBot('nw', 'sky', 'standard', east.matchData).think(east.obs)).toEqual(expect.arrayContaining([
      { kind: 'move', units: [east.bomber], x: 42.5, y: 12 },
      { kind: 'attack', units: [east.bomber], target: east.target, queue: true },
    ]));
  });

  it('veteran hides a strike on a flak-covered target in a nearby storm; standard flies straight', () => {
    const covered = () => {
      const flight = strike({ x: 20, y: 30 }, [{ kind: 'turret', x: 34, y: 40 }, { kind: 'flak', x: 33, y: 41 }]);
      flight.obs.weather.storms = [storm(flight.obs.tick, { originX: 31, originY: 47, grown: 0 })];
      flight.obs.weather.forecast = [];
      return flight;
    };
    const { obs, matchData, bomber, target } = covered();
    const out = initializedBot('nw', 'sky', 'veteran', matchData).think(obs);
    const at = out.findIndex((i) => i.kind === 'attack');
    expect(out[at]).toEqual({ kind: 'attack', units: [bomber], target, queue: true });
    const stage = out[at - 1]!;
    expect(stage.kind).toBe('move');
    // Inside the public lifecycle's storm by the time the bomber (3 tiles/s from (20, 30)) arrives.
    if (stage.kind === 'move') {
      const tick = obs.tick + Math.hypot(stage.x - 20, stage.y - 30) / 3 * 20;
      const sampled: StormSample = { x: 0, y: 0, radius: 0, strength: 0, stage: 'forecast' };
      expect([...obs.weather.storms, ...obs.weather.forecast].some((cell) => {
        sampleStorm(cell, tick, sampled, 0, matchData.rules.map.size);
        return sampled.radius > 0 && Math.hypot(stage.x - sampled.x, stage.y - sampled.y) <= sampled.radius;
      })).toBe(true);
    }
    const plain = covered();
    expect(initializedBot('nw', 'sky', 'standard', plain.matchData).think(plain.obs)).toContainEqual({ kind: 'attack', units: [plain.bomber], target: plain.target });
  });
});
