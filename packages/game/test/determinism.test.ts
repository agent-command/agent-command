// @module-tag timing — long replay and full-match mirror cases; serial timing set (pnpm test:timing).
import { describe, expect, it } from 'vitest';
import type { ApplyResult } from 'playerthree';
import type { AgentCommandManifest } from '../src/agent/manifest.ts';
import { CELL, DEFAULT_RULES, ECON, PLANES, TERRAIN_PRESETS, toTicks, type ArmyId, type Plane } from '../src/rules/contract.ts';
import { applyIntent } from '../src/agent/intents.ts';
import { generateMapDocument, namedMap } from '../src/maps/maps.ts';
import { AgentCommandGame, createGame } from '../src/agent/adapter.ts';
import type { AgentCommandIntent } from '../src/agent/intents.ts';
import { BOT_PERIOD, playBotMatch, type BotMatchOptions } from '../src/bots/play.ts';
import { createBot } from '../src/bots/bots.ts';
import { Ent, type Order } from '../src/sim/ent.ts';
import { HOLE } from '../src/sim/constants.ts';
import { Sim } from '../src/sim/sim.ts';
import { cellOf } from '../src/util/grid.ts';
import { FlowFields, LineOfSight } from '../src/nav/nav.ts';
import { Rng } from '../src/util/rng.ts';
import { orbitAsymmetry } from './mirror.ts';
import { NEUTRAL, rotCell } from '../src/util/teams.ts';

/** A duel's armies: army 0 on the NW slot, army 1 on the SE slot. */
const DUEL = ['nw', 'se'] as const;
const BLUE = 0, RED = 1;

it('clones live asteroid mining latches, resource and cargo through unload and resume', () => {
  const game = createGame({ seed: 31, options: { terrain: 'open', spire: { dmg: 0 }, orbit: { maxAsteroids: 0, derelictEnabled: false, stationPdDamage: 0 } } });
  const home = game.sim.armies[BLUE]!.spire.orbit;
  const tug = game.sim.add('tug', BLUE, 'orbit', home.x + 6, home.y + 1);
  const rock = game.sim.add('asteroid', NEUTRAL, 'orbit', tug.x + game.sim.econ.tugMineReach, tug.y);
  rock.resourceType = 'ice';
  rock.resourceRemaining = game.sim.rocks.medium.dockYield.ice.energy;
  rock.state = 'drifting';
  game.sim.computeVision();
  expect(game.apply({ team: 'nw', role: 'orbit' }, { kind: 'mine_asteroid', units: [game.entityId('nw', tug.id)], asteroid: game.entityId('nw', rock.id) })).toEqual({ ok: true });
  for (let i = 0; i < 490; i++) game.step();
  expect(tug.cargoEnergy).toBeCloseTo(49, 7);
  expect(rock.miningTug).toBe(tug.id);
  const copy = game.clone(), before = game.stateHash();
  const twinTug = copy.sim.alive(tug.id)!, twinRock = copy.sim.alive(rock.id)!;
  expect(twinTug).not.toBe(tug); expect(twinRock).not.toBe(rock);
  expect(twinTug.order).not.toBe(tug.order);
  const changes = [
    () => { twinTug.cargoAlloy++; },
    () => { twinTug.cargoEnergy++; },
    () => { twinTug.miningTarget = 0; },
    () => { twinRock.resourceRemaining--; },
    () => { twinRock.resourceType = 'metal'; },
    () => { twinRock.volatile = true; },
    () => { twinRock.miningTug = 0; },
    () => { if (twinTug.order.k === 'mine_asteroid') twinTug.order.returning = true; },
    () => { if (twinTug.order.k === 'mine_asteroid') twinTug.order.exhausted = true; },
    ...(['x', 'y', 'vx', 'vy', 'tick'] as const).map(key => () => { if (twinTug.order.k === 'mine_asteroid') twinTug.order.site![key]++; }),
  ];
  for (const change of changes) {
    change();
    expect(copy.stateHash()).not.toBe(before); expect(game.stateHash()).toBe(before);
    Object.assign(twinTug, { cargoAlloy: tug.cargoAlloy, cargoEnergy: tug.cargoEnergy, miningTarget: tug.miningTarget, order: structuredClone(tug.order) });
    Object.assign(twinRock, { resourceRemaining: rock.resourceRemaining, resourceType: rock.resourceType, volatile: rock.volatile, miningTug: rock.miningTug });
    expect(copy.stateHash()).toBe(before);
  }
  let unloaded = false, resumed = false;
  // The live starting arrays occupy the direct approach; include the normal crowd-avoidance detour.
  for (let i = 0; i < 700; i++) {
    game.step(); copy.step();
    expect(copy.stateHash()).toBe(game.stateHash());
    if (tug.cargoEnergy === 0) unloaded = true;
    if (unloaded && tug.miningTarget === rock.id && tug.cargoEnergy > 0) resumed = true;
  }
  expect(unloaded).toBe(true); expect(resumed).toBe(true);
});

interface Recorded {
  tick: number;
  team: ArmyId;
  role: Plane;
  intent: AgentCommandIntent;
  /** A bot's answer: playBotMatch applied it with source 'bot' inside its tick's decision round (`Sim.round`). */
  bot: boolean;
}

/** Bots plus a stream of random (often invalid) intents; records every intent applied, its source and round, by tick. */
function play(seed: number, ticks: number): { hashes: string[]; log: Recorded[] } {
  const log: Recorded[] = [];
  const hashes: string[] = [];
  let r = seed;
  const rand = (n: number): number => {
    r = (Math.imul(r, 1103515245) + 12345) >>> 0;
    return (r >>> 8) % n;
  };
  playBotMatch({
    seed,
    levels: { nw: 'veteran', se: 'standard' },
    maxTicks: ticks,
    onIntent: (g, seat, intent) => log.push({ tick: g.tick, team: seat.team, role: seat.role, intent, bot: true }),
    onTick: (g) => {
      if (g.tick % 100 === 0) hashes.push(g.stateHash());
      if (g.tick % BOT_PERIOD !== 0) return;
      // Random noise before the bots decide: real unit ids (as the acting army names them), random targets.
      const team = DUEL[rand(2)]!;
      const army = g.sim.armyIndex(team);
      const ids = g.sim.ents.filter((e) => g.sim.aliasOf(army, e.id) !== 0).map((e) => g.entityId(team, e.id));
      const role = PLANES[rand(4)]!;
      const intent: AgentCommandIntent =
        rand(2) === 0
          ? { kind: 'move', units: [ids[rand(ids.length)]!], x: rand(48), y: rand(48) }
          : { kind: 'attack', units: [ids[rand(ids.length)]!], target: ids[rand(ids.length)]! };
      log.push({ tick: g.tick, team, role, intent, bot: false });
      g.apply({ team, role }, intent);
    },
  });
  return { hashes, log };
}

describe('determinism', () => {
  it('same seed + same intents → identical state hashes', () => {
    const a = play(77, 2500);
    const b = play(77, 2500);
    expect(a.hashes.length).toBeGreaterThan(10);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.log).toEqual(a.log);
  });

  it('replaying the recorded intents without bots reproduces the match exactly', () => {
    const { hashes, log } = play(5, 2000);
    const g = createGame({ seed: 5 });
    const replayed: string[] = [];
    let i = 0;
    while (g.tick < 2000 && g.sim.result === null) {
      // The tick's random owner intents land first, then the bots' round, applied as playBotMatch did.
      while (i < log.length && log[i]!.tick === g.tick && !log[i]!.bot) {
        const r = log[i++]!;
        g.apply({ team: r.team, role: r.role }, r.intent);
      }
      g.sim.round(() => {
        while (i < log.length && log[i]!.tick === g.tick) {
          const r = log[i++]!;
          g.apply({ team: r.team, role: r.role }, r.intent, { source: 'bot' });
        }
      });
      g.step();
      if (g.tick % 100 === 0) replayed.push(g.stateHash());
    }
    expect(replayed).toEqual(hashes);
  });

  it('different seeds generate different worlds', () => {
    const a = createGame({ seed: 1 }).stateHash();
    const b = createGame({ seed: 2 }).stateHash();
    expect(a).not.toBe(b);
  });

  it('every world is invariant under its document\'s rotation group (C2 matches, C4 presets × sizes × seeds, four_corners)', () => {
    const sims = [1, 99, 12345].map((seed) => createGame({ seed }).sim);
    for (const preset of TERRAIN_PRESETS) for (const size of [48, 64, 80]) for (const seed of [3, 41]) sims.push(new Sim(seed, {}, generateMapDocument(seed, preset, { ...DEFAULT_RULES.map, size }, 4, seed)));
    sims.push(new Sim(5, {}, namedMap('four_corners')!));
    for (const s of sims) {
      let first: string | undefined;
      for (let r = s.slotStep; r < 4 && !first; r += s.slotStep) {
        for (let c = 0; c < s.n && !first; c++) {
          const t = rotCell(r, c, s.size);
          // Tunnel owners turn with their slot (army + 1; every slot is claimed here).
          const owner = s.owner[c] ? (s.owner[c]! - 1 + r / s.slotStep) % s.sides + 1 : 0;
          if (s.cells[t] !== s.cells[c] || s.terrain[t] !== s.terrain[c] || s.ore[t] !== s.ore[c] || (s.magma[t] === 0) !== (s.magma[c] === 0) || s.owner[t] !== owner) {
            first = `${s.mapDocument.id} ${s.mapDocument.preset} S${s.size} turn ${r} cell ${c}`;
          }
        }
      }
      expect(first).toBeUndefined();
    }
  });

  it('four-army matches replay to the same state hashes, and a clone continues identically', () => {
    const play = (): string[] => {
      const s = new Sim(9, {}, namedMap('four_corners')!);
      const hashes: string[] = [];
      for (let t = 0; t < 600; t++) {
        if (t === 1) s.round(() => { for (const a of s.allArmies) applyIntent(s, a, 'depths', { kind: 'macro', action: 'auto_mine' }); });
        s.step();
        if (t % 50 === 0) hashes.push(s.hash());
      }
      return hashes;
    };
    const a = play();
    expect(play()).toEqual(a);
    const s = new Sim(9, {}, namedMap('four_corners')!);
    for (let t = 0; t < 100; t++) s.step();
    const copy = s.clone();
    for (let t = 0; t < 100; t++) { s.step(); copy.step(); }
    expect(copy.hash()).toBe(s.hash());
  });
  it('Depths world-point orders on grid borders resolve to mirrored cell centres', () => {
    const g = createGame({ seed: 7, options: { stats: { digger: { build: 0.1 } } } });
    const s = g.sim;
    s.cells.fill(CELL.tunnel);
    for (const army of [BLUE, RED]) s.armies[army]!.group.known.fill(CELL.tunnel);
    const blue = s.spawnUnit(BLUE, 'trooper', 'depths');
    const red = s.spawnUnit(RED, 'trooper', 'depths');
    blue.x = 22.5; blue.y = 18.5;
    red.x = s.size - blue.x; red.y = s.size - blue.y;
    for (const kind of ['move', 'patrol'] as const) {
      expect(g.apply({ team: 'nw', role: 'depths' }, { kind, units: [g.entityId('nw', blue.id)], x: 23, y: 18.5 }).ok).toBe(true);
      expect(g.apply({ team: 'se', role: 'depths' }, { kind, units: [g.entityId('se', red.id)], x: 25, y: 29.5 }).ok).toBe(true);
      if (blue.order.k === 'move' && red.order.k === 'move') {
        expect(blue.order.x + red.order.x).toBe(s.size);
        expect(blue.order.y + red.order.y).toBe(s.size);
      } else if (blue.order.k === 'patrol' && red.order.k === 'patrol') {
        expect(blue.order.bx + red.order.bx).toBe(s.size);
        expect(blue.order.by + red.order.by).toBe(s.size);
      } else throw new Error('expected matching point orders');
    }
    expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'rally', x: 23, y: 18.5 }).ok).toBe(true);
    expect(g.apply({ team: 'se', role: 'depths' }, { kind: 'rally', x: 25, y: 29.5 }).ok).toBe(true);
    for (const team of DUEL) expect(g.apply({ team, role: 'depths' }, { kind: 'queue_add', item: 'digger' }).ok).toBe(true);
    g.step(); g.step();
    const b = s.ents.findLast((e) => e.side === BLUE && e.kind === 'digger')!;
    const r = s.ents.findLast((e) => e.side === RED && e.kind === 'digger')!;
    if (b.order.k !== 'move' || r.order.k !== 'move') throw new Error('expected rally orders');
    expect(b.order.x + r.order.x).toBe(s.size);
    expect(b.order.y + r.order.y).toBe(s.size);
    expect(g.apply({ team: 'nw', role: 'depths' }, { kind: 'mine', units: [g.entityId('nw', b.id)], x: 23, y: 18.5 }).ok).toBe(true);
    expect(g.apply({ team: 'se', role: 'depths' }, { kind: 'mine', units: [g.entityId('se', r.id)], x: 25, y: 29.5 }).ok).toBe(true);
    const bo = b.order as Order, ro = r.order as Order;
    if (bo.k !== 'mine' || ro.k !== 'mine') throw new Error('expected mining orders');
    expect(bo.near + ro.near).toBe(s.size * s.size - 1);
  });
});

describe('isolated checkpoints', () => {
  /** Check every owned object, including private caches/scratch, and preserve aliases within the copy. */
  function expectIsolatedGraph(source: unknown, copy: unknown, seen = new Map<object, object>()): void {
    if (source === null || typeof source !== 'object') {
      expect(copy).toBe(source);
      return;
    }
    expect(copy).not.toBe(source);
    expect(copy).not.toBeNull();
    expect(typeof copy).toBe('object');
    const target = copy as object;
    if (seen.has(source)) {
      expect(target).toBe(seen.get(source));
      return;
    }
    seen.set(source, target);
    expect(Object.getPrototypeOf(target)).toBe(Object.getPrototypeOf(source));
    if (source instanceof ArrayBuffer) {
      expect(new Uint8Array(target as ArrayBuffer)).toEqual(new Uint8Array(source));
    } else if (ArrayBuffer.isView(source)) {
      const view = target as ArrayBufferView;
      expect(view.byteOffset).toBe(source.byteOffset);
      expect(view.byteLength).toBe(source.byteLength);
      expectIsolatedGraph(source.buffer, view.buffer, seen);
    } else if (source instanceof Map) {
      const entries = [...(target as Map<unknown, unknown>)];
      expect(entries.length).toBe(source.size);
      let i = 0;
      for (const [key, value] of source) {
        expectIsolatedGraph(key, entries[i]![0], seen);
        expectIsolatedGraph(value, entries[i++]![1], seen);
      }
    } else {
      expect(Object.keys(target)).toEqual(Object.keys(source));
      for (const key of Object.keys(source)) {
        expectIsolatedGraph((source as Record<string, unknown>)[key], (target as Record<string, unknown>)[key], seen);
      }
    }
  }

  it('replays every subsequent tick and sampled perspectives from nontrivial bot checkpoints', () => {
    const checkpoints: AgentCommandGame[] = [];
    const pending: { seat: { team: ArmyId; role: Plane }; intent: AgentCommandIntent; result: ApplyResult<AgentCommandManifest> }[] = [];
    // Bots still supply the evolving battle, but scripted milestones must not depend on their strategy.
    const milestones = [
      (sim: Sim) => sim.lodes.some((lode) => lode.open) && sim.armies[BLUE]!.designationCount > 0
        && sim.armies[BLUE]!.queue.length > 0 && sim.armies[BLUE]!.queueSeq > sim.armies[BLUE]!.queue.length + 1,
      (sim: Sim) => sim.armies[BLUE]!.research.has('ascent_thrusters'),
      (sim: Sim) => sim.ents.some((entity) => entity.transitAt > 0),
    ];
    const restoredAt: number[] = [];
    const checkpointTicks = [1200, 2200, 2400];
    const seats: NonNullable<BotMatchOptions['seats']> = {};
    for (const team of DUEL) {
      const surface = createBot(team, 'surface', 'veteran');
      const sky = createBot(team, 'sky', 'veteran');
      seats[team] = {
        surface: { init: (data) => surface.init?.(data), think: (obs) => surface.think(obs).filter((i) => i.kind !== 'queue_add' || i.item !== 'headframe') },
        sky: { init: (data) => sky.init?.(data), think: (obs) => sky.think(obs).filter((i) => i.kind !== 'research' && i.kind !== 'ascend') },
      };
    }
    const script = (game: AgentCommandGame): void => {
      for (const [army, team] of DUEL.entries()) {
        const sim = game.sim;
        const state = sim.armies[army]!;
        const act = (role: Plane, intent: AgentCommandIntent): void => {
          expect(game.apply({ team, role }, intent), `script ${team}/${role} at ${game.tick}`).toEqual({ ok: true });
        };
        if (game.tick === 800) {
          state.alloy = state.energy = 10000;
          const home = state.spire.surface;
          const size = sim.size;
          const lode = [...sim.lodes].sort((a, b) =>
            Math.hypot(a.c % size + 0.5 - home.x, Math.floor(a.c / size) + 0.5 - home.y)
            - Math.hypot(b.c % size + 0.5 - home.x, Math.floor(b.c / size) + 0.5 - home.y))[0]!;
          sim.scan(army, lode.c % size + 0.5, Math.floor(lode.c / size) + 0.5);
          act('surface', { kind: 'queue_add', item: 'headframe', x: lode.c % size, y: Math.floor(lode.c / size), index: 0 });
        }
        if (game.tick === 1200) {
          const cells: { x: number; y: number }[] = [];
          const size = sim.size;
          for (let i = 0; i < size * size && cells.length < 16; i++) {
            const cell = team === 'nw' ? i : size * size - 1 - i;
            if (state.group.known[cell] === CELL.rock) cells.push({ x: cell % size, y: Math.floor(cell / size) });
          }
          expect(cells.length).toBeGreaterThan(0);
          act('depths', { kind: 'designate', cells, priority: 2 });
          act('depths', { kind: 'queue_add', item: 'digger', count: 2, index: 0 });
        }
        if (game.tick === 1600) {
          state.alloy = state.energy = 10000;
          act('sky', { kind: 'research', upgrade: 'ascent_thrusters' });
        }
        if (game.tick === 2400) {
          state.energy = 10000;
          const interceptor = sim.spawnUnit(army, 'interceptor', 'sky');
          act('sky', { kind: 'ascend', units: [game.entityId(team, interceptor.id)] });
        }
      }
    };
    // One live reference supplies both intents and expected state. Hashes and RNG are checked on
    // every subsequent tick; expensive full projections cover every team/seat every 100 ticks,
    // at restoration and the following tick, and at the end. Each checkpoint runs all the way
    // to tick 4000, including later queue churn, research, lode openings and ascents.
    const expectProjections = (game: AgentCommandGame): void => {
      const referenceDebug = game.debugView();
      const since = Math.max(0, game.tick - BOT_PERIOD);
      const reference = DUEL.map((team) => ({
        view: game.view(team, { snapshot: true }),
        seats: PLANES.map((role) => ({
          observation: game.observe({ team, role }, since),
          events: game.events({ team, role }, since),
        })),
      }));
      for (const checkpoint of checkpoints) {
        expect(checkpoint.debugView()).toEqual(referenceDebug);
        for (const [teamIndex, team] of DUEL.entries()) {
          const expected = reference[teamIndex]!;
          expect(checkpoint.view(team, { snapshot: true })).toEqual(expected.view);
          for (const [roleIndex, role] of PLANES.entries()) {
            const seat = { team, role };
            expect(checkpoint.observe(seat, since)).toEqual(expected.seats[roleIndex]!.observation);
            expect(checkpoint.events(seat, since)).toEqual(expected.seats[roleIndex]!.events);
          }
        }
      }
    };
    const { game } = playBotMatch({
      seed: 7, options: { terrain: 'ridges' }, levels: { nw: 'veteran', se: 'veteran' }, seats, maxTicks: 4000,
      onIntent: (_game, seat, intent, result) => {
        if (checkpoints.length > 0) pending.push({ seat, intent: structuredClone(intent), result });
      },
      onTick: (game) => {
        if (checkpoints.length > 0) {
          const hash = game.stateHash();
          for (const checkpoint of checkpoints) {
            // Match playBotMatch's simultaneous decision boundary: deferred payload events
            // must flush after the whole round, not between individual replayed intents.
            checkpoint.sim.round(() => {
              for (const { seat, intent, result } of pending)
                expect(checkpoint.apply(seat, structuredClone(intent), { source: 'bot' })).toEqual(result);
            });
            checkpoint.step();
            expect(checkpoint.tick).toBe(game.tick);
            expect(checkpoint.stateHash()).toBe(hash);
            expect(checkpoint.sim.rng.state).toBe(game.sim.rng.state);
          }
          if (game.tick % 100 === 0 || restoredAt.includes(game.tick - 1)) expectProjections(game);
        }
        pending.length = 0;
        if ([800, 1200, 1600, 2400].includes(game.tick)) {
          script(game);
          for (const checkpoint of checkpoints) script(checkpoint);
        }
        if (game.tick !== checkpointTicks[checkpoints.length]) return;
        expect(milestones[checkpoints.length]!(game.sim), `scripted milestone at ${game.tick}`).toBe(true);
        const checkpoint = game.clone();
        if (checkpoints.length === 1) expectIsolatedGraph(game.sim, checkpoint.sim);
        // Repeated checkpointing must also retain all prototypes and RNG state.
        checkpoints.push(checkpoints.length === 2 ? checkpoint.clone() : checkpoint);
        restoredAt.push(game.tick);
        expectProjections(game);
      },
    });
    expect(restoredAt, 'opened lodes/designations/queue churn, research, then ascent').toHaveLength(milestones.length);
    expect(game.tick).toBe(4000);
    expect(game.tick - restoredAt[2]!, 'at least 100 subsequent ticks after the final restoration').toBeGreaterThanOrEqual(100);
    expectProjections(game);
    for (const checkpoint of checkpoints) {
      for (const team of DUEL) expect(checkpoint.report(team)).toEqual(game.report(team));
    }
  }, 120_000);

  it('isolates mutations, cache buffers, RNG, dead Spire references and terrain broadcast flags', () => {
    const { game } = playBotMatch({ seed: 11, options: { terrain: 'canyons' }, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: 1000 });
    // A destroyed Spire remains in team state even after removal from the live entity indexes.
    const dead = game.sim.armies[BLUE]!.spire.surface;
    dead.dead = true;
    game.sim.ents = game.sim.ents.filter((e) => e !== dead);
    game.sim.byId.delete(dead.id);
    game.view('nw');
    game.view('se', { snapshot: true });
    const copy = game.clone();
    expect(copy).toBeInstanceOf(AgentCommandGame);
    expect(copy.sim).toBeInstanceOf(Sim);
    expect(copy.sim.rng).toBeInstanceOf(Rng);
    for (const army of [BLUE, RED]) expect(copy.sim.flows[army]).toBeInstanceOf(FlowFields);
    expect(copy.sim.los).toBeInstanceOf(LineOfSight);
    expect(copy.sim.armies[BLUE]!.spire.surface).toBeInstanceOf(Ent);
    expectIsolatedGraph(game.sim, copy.sim);
    expect(copy.manifest).toBe(game.manifest);
    expect(copy.view('nw')).toEqual(game.view('nw'));
    const redFirst = copy.view('se');
    copy.view('se');
    expect(game.view('se')).toEqual(redFirst);

    const untouched = structuredClone(game.sim);
    const goal = cellOf(24, 24, game.sim.size);
    const field = copy.sim.flows[BLUE]!.get(goal, copy.sim.armyFrame[BLUE]!, copy.sim.holesVersion, copy.tick);
    const liveField = game.sim.flows[BLUE]!.get(goal, copy.sim.armyFrame[BLUE]!, game.sim.holesVersion, game.tick);
    expect(field).not.toBe(liveField);
    expect(field).toEqual(liveField);
    // Capture after warming the live cache: every subsequent write is confined to the copy.
    const warmed = structuredClone(game.sim);
    field.fill(123);
    copy.sim.surfaceNav[BLUE]!.fill(1);
    copy.sim.surfaceCost.fill(17);
    // A fresh version must use the copy's blocked map, not the source's buffers.
    const blocked = copy.sim.flows[BLUE]!.get(goal, copy.sim.armyFrame[BLUE]!, ++copy.sim.holesVersion, copy.tick);
    expect(blocked[goal]).toBe(0);
    expect(blocked[goal - 1]).toBe(Infinity);
    copy.sim.rng.next();
    copy.sim.cells.fill(CELL.rock);
    copy.sim.armies[BLUE]!.group.known.fill(0);
    copy.sim.armies[BLUE]!.group.memory.clear();
    copy.sim.armies[BLUE]!.spire.surface.hp = 0;
    copy.sim.armies[BLUE]!.seats.depths.mandate.directive.stance = 'attack';
    copy.sim.ents[0]!.queue.push({ k: 'move', x: 1, y: 1, fight: false, speed: 0 });
    copy.sim.add('trooper', BLUE, 'surface', 10, 10);
    expect(structuredClone(game.sim)).toEqual(warmed);
    expect(game.sim.rng.state).toBe(untouched.rng.state);
    expect(game.sim.armies[BLUE]!.spire.surface.hp).toBe(untouched.armies[BLUE]!.spire.surface.hp);
    const forkState = structuredClone(copy.sim);
    game.step();
    expect(structuredClone(copy.sim)).toEqual(forkState);
  }, 30_000);
});

describe('simultaneous decisions', () => {

  for (const terrain of TERRAIN_PRESETS) {
    it(`a ${terrain} mirror match stays exactly mirrored (positions, HP) for 150 s`, () => {
      let first: string | undefined;
      playBotMatch({ seed: 7, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: toTicks(150), onTick: (g) => (first ??= orbitAsymmetry(g.sim)), options: { terrain } });
      expect(first).toBeUndefined();
    });
  }

  for (const [seed, terrain] of [[11, 'canyons'], [7, 'ridges']] as const) {
    it(`seed ${seed} ${terrain} stays mirrored through late group moves and crater impacts`, () => {
      let first: string | undefined;
      playBotMatch({
        seed, options: { terrain }, levels: { nw: 'veteran', se: 'veteran' }, maxTicks: process.env.AC_EXTENDED_MIRRORS ? undefined : 4000,
        onTick: (g) => { first ??= orbitAsymmetry(g.sim); },
      });
      expect(first).toBeUndefined();
    });
  }
});

describe('surface destination symmetry', () => {
  function arena(blockX: number, blockY: number) {
    const g = createGame({ seed: 1 });
    const s = g.sim;
    for (const e of s.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.dead = true;
    s.block.fill(0);
    s.surfaceCost.fill(1);
    const c = cellOf(blockX, blockY, g.sim.size);
    for (const at of [c, g.sim.size * g.sim.size - 1 - c]) {
      s.block[at] = 1;
      s.holes[at] = HOLE.crater;
    }
    s.holeCount = 2;
    s.holesVersion++;
    const blue = [12, 12.5, 13].map((x) => s.add('tank', BLUE, 'surface', x, 12.5));
    const red = blue.map((e) => s.add('tank', RED, 'surface', g.sim.size - e.x, g.sim.size - e.y));
    return { g, blue, red };
  }

  for (const fixture of [
    { name: 'equidistant hole rims', block: [16.5, 12.5], goal: [16.5, 12.5] },
    { name: 'a hole corner on integer coordinates', block: [17.5, 13.5], goal: [17, 13] },
    { name: 'a formation offset landing on a blocked cell boundary', block: [17.5, 12.5], goal: [16.5, 12.5] },
  ] as const) {
    it(`group moves keep mirrored destinations and trajectories at ${fixture.name}`, () => {
      const { g, blue, red } = arena(fixture.block[0], fixture.block[1]);
      for (const [team, units] of [['nw', blue], ['se', red]] as const) {
        expect(g.apply({ team, role: 'surface' }, {
          kind: 'move', units: units.map((e) => g.entityId(team, e.id)), mode: 'move',
          x: team === 'nw' ? fixture.goal[0] : g.sim.size - fixture.goal[0],
          y: team === 'nw' ? fixture.goal[1] : g.sim.size - fixture.goal[1],
        })).toEqual({ ok: true });
      }
      // Each tank its own slot, on open ground and clear of the others by its size.
      for (const [i, e] of blue.entries()) {
        const o = e.order;
        if (o.k !== 'move') throw new Error('expected move orders');
        expect(g.sim.block[cellOf(o.x, o.y, g.sim.size)]).toBe(0);
        for (const f of blue.slice(i + 1)) {
          if (f.order.k === 'move') expect(Math.hypot(f.order.x - o.x, f.order.y - o.y)).toBeGreaterThanOrEqual(e.radius + f.radius + g.sim.econ.slotGap - 1e-6);
        }
      }
      for (let i = 0; i < blue.length; i++) {
        const b = blue[i]!.order;
        const r = red[i]!.order;
        expect(b.k).toBe('move');
        expect(r.k).toBe('move');
        if (b.k !== 'move' || r.k !== 'move') throw new Error('expected move orders');
        expect(r.x).toBeCloseTo(g.sim.size - b.x, 12);
        expect(r.y).toBeCloseTo(g.sim.size - b.y, 12);
      }
      let gap = 0;
      for (let tick = 0; tick < 120; tick++) {
        g.step();
        for (let i = 0; i < blue.length; i++) {
          gap = Math.max(gap, Math.abs(blue[i]!.x + red[i]!.x - g.sim.size), Math.abs(blue[i]!.y + red[i]!.y - g.sim.size));
        }
      }
      expect(gap).toBeLessThan(1e-6);
      expect(blue[1]!.x).toBeGreaterThan(13);
    });
  }

  it('patrol formations use the same mirrored slots as moves', () => {
    const { g, blue, red } = arena(17.5, 12.5);
    // The same group ordered to move instead, in an exact copy of the match.
    const twin = g.clone();
    for (const [team, units] of [['nw', blue], ['se', red]] as const) {
      const order = { units: units.map((e) => g.entityId(team, e.id)), x: team === 'nw' ? 16.5 : g.sim.size - 16.5, y: team === 'nw' ? 12.5 : g.sim.size - 12.5 };
      expect(g.apply({ team, role: 'surface' }, { kind: 'patrol', ...order })).toEqual({ ok: true });
      expect(twin.apply({ team, role: 'surface' }, { kind: 'move', ...order })).toEqual({ ok: true });
    }
    for (const [i, e] of [...blue, ...red].entries()) {
      const moved = twin.sim.ents.find((t) => t.id === e.id)!.order;
      if (e.order.k !== 'patrol' || moved.k !== 'move') throw new Error(`unit ${i}: expected patrol and move orders`);
      expect([e.order.bx, e.order.by]).toEqual([moved.x, moved.y]);
    }
    blue.forEach((b, i) => {
      const r = red[i]!.order;
      if (b.order.k !== 'patrol' || r.k !== 'patrol') throw new Error('expected patrol orders');
      expect(r.bx).toBeCloseTo(g.sim.size - b.order.bx, 12);
      expect(r.by).toBeCloseTo(g.sim.size - b.order.by, 12);
    });
  });

  for (const kind of ['patrol', 'rally'] as const) {
    it(`${kind} validates integer destinations in the team's navigation frame`, () => {
      const { g, blue, red } = arena(16.5, 12.5);
      for (const [team, units] of [['nw', blue], ['se', red]] as const) {
        const x = team === 'nw' ? 17 : g.sim.size - 17;
        const y = team === 'nw' ? 13 : g.sim.size - 13;
        expect(g.apply({ team, role: 'surface' }, kind === 'patrol'
          ? { kind, units: units.map((e) => g.entityId(team, e.id)), x, y }
          : { kind, x, y })).toEqual({ ok: true });
      }
    });
  }
});

describe('mirrored movement inputs', () => {
  it('stacked opposing units separate in mirrored directions regardless of insertion order', () => {
    const g = createGame({ seed: 11 });
    const s = g.sim;
    for (const e of s.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.dead = true;
    // Blue is inserted first at both piles, but the lower per-team serial belongs to opposite teams.
    const blue = s.add('digger', BLUE, 'depths', 10.5, 12.5);
    const blueVisitor = s.add('digger', BLUE, 'depths', g.sim.size - 10.5, g.sim.size - 12.5);
    const red = s.add('digger', RED, 'depths', g.sim.size - 10.5, g.sim.size - 12.5);
    const redVisitor = s.add('digger', RED, 'depths', 10.5, 12.5);
    for (const e of [blue, blueVisitor, red, redVisitor]) {
      e.cell = cellOf(e.x, e.y, g.sim.size);
      s.cells[e.cell] = CELL.tunnel;
      e.stance = 'hold';
    }
    g.step();
    expect(Math.hypot(blue.x - redVisitor.x, blue.y - redVisitor.y)).toBeGreaterThan(0);
    for (const [b, r] of [[blue, red], [blueVisitor, redVisitor]] as const) {
      expect(r.x).toBe(g.sim.size - b.x);
      expect(r.y).toBe(g.sim.size - b.y);
    }
  });

  it('tangent Spire avoidance keeps orbital positions and velocities exactly mirrored', () => {
    const g = createGame({ seed: 7, options: { terrain: 'ridges' } });
    for (const e of g.sim.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.dead = true;
    // A solar stopped just inside its Spire's radius: the 0.05 overlap equals its maximum speed,
    // making the ORCA constraint tangent to the speed circle and sensitive to non-mirrored position precision.
    const blue = g.sim.add('solar', BLUE, 'orbit', 6.608057455744139, 9.504990349965912);
    const red = g.sim.add('solar', RED, 'orbit', 41.39194254425586, 38.495009650034085);
    for (const [team, unit] of [['nw', blue], ['se', red]] as const) {
      expect(g.apply({ team, role: 'orbit' }, {
        kind: 'move', units: [g.entityId(team, unit.id)], x: team === 'nw' ? 6 : g.sim.size - 6, y: g.sim.size / 2, mode: 'move',
      })).toEqual({ ok: true });
    }
    for (let tick = 0; tick < 120; tick++) {
      g.step();
      expect(red.x).toBe(g.sim.size - blue.x);
      expect(red.y).toBe(g.sim.size - blue.y);
      expect(red.vx + blue.vx).toBe(0);
      expect(red.vy + blue.vy).toBe(0);
    }
    expect(blue.y).toBeGreaterThan(10);
  });

  it('exhausting ore does not change a later miner’s terrain snapshot or separation responsibility', () => {
    const g = createGame({ seed: 7 });
    const s = g.sim;
    for (const e of s.ents) if (e.kind !== 'spire' && e.kind !== 'island') e.dead = true;
    const ore = cellOf(11.5, 12.5, g.sim.size);
    const mirrorOre = g.sim.size * g.sim.size - 1 - ore;
    const blue = s.add('digger', BLUE, 'depths', 10.5, 12.5);
    const blueVisitor = s.add('digger', BLUE, 'depths', g.sim.size - 10.5, g.sim.size - 12.5);
    const red = s.add('digger', RED, 'depths', g.sim.size - 10.5, g.sim.size - 12.5);
    const redVisitor = s.add('digger', RED, 'depths', 10.5, 12.5);
    for (const c of [ore, mirrorOre]) {
      s.cells[c] = CELL.ore;
      s.ore[c] = 1;
      for (const army of [BLUE, RED]) s.armies[army]!.group.known[c] = CELL.ore;
    }
    for (const [e, c, completing] of [[blue, ore, true], [blueVisitor, mirrorOre, false], [red, mirrorOre, true], [redVisitor, ore, false]] as const) {
      e.cell = cellOf(e.x, e.y, g.sim.size);
      s.cells[e.cell] = CELL.tunnel;
      e.order = { k: 'mine', ore: c, exploring: false, near: -1 };
      e.path = [c];
      e.pathI = 0;
      e.navGoal = -4;
      e.workT = completing ? ECON.digOre - 1 : 0;
    }
    g.step();
    expect(s.cells[ore]).toBe(CELL.tunnel);
    expect(s.cells[mirrorOre]).toBe(CELL.tunnel);
    expect(blue.carry).toBe(ECON.oreLoad);
    expect(red.carry).toBe(ECON.oreLoad);
    expect(blueVisitor.workT).toBe(1);
    expect(redVisitor.workT).toBe(1);
    expect(blueVisitor.path).toEqual([mirrorOre]);
    expect(redVisitor.path).toEqual([ore]);
    expect(red.x).toBe(g.sim.size - blue.x);
    expect(red.y).toBe(g.sim.size - blue.y);
  });
});
